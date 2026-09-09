import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export class PrivateFileCreationError extends Error {
  constructor(readonly code: "exists" | "aborted" | "failed" | "outcome_unknown") {
    super(`SSH private file creation: ${code}.`);
    this.name = "PrivateFileCreationError";
  }
}

// CreateNew receives the protected security descriptor atomically. Only the
// empty file's volume/file identity leaves this process; it never sees a key.
const CREATE_WINDOWS_FILE = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles; public static class JokoKeyFile { [StructLayout(LayoutKind.Sequential)] public struct Info { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation; public System.Runtime.InteropServices.ComTypes.FILETIME Access; public System.Runtime.InteropServices.ComTypes.FILETIME Write; public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links; public uint IndexHigh; public uint IndexLow; } [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info); }'",
  "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$acl = New-Object System.Security.AccessControl.FileSecurity",
  "$acl.SetOwner($identity)",
  "$acl.SetAccessRuleProtection($true, $false)",
  "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')",
  "$acl.AddAccessRule($rule)",
  "$file = $null",
  "$created = $false",
  "try {",
  "$file = [System.IO.FileStream]::new($env:JOKO_SSH_KEY_FILE, [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.IO.FileShare]::ReadWrite, 4096, [System.IO.FileOptions]::None, $acl)",
  "$created = $true",
  "$info = New-Object JokoKeyFile+Info",
  "if (-not [JokoKeyFile]::GetFileInformationByHandle($file.SafeFileHandle, [ref]$info)) { throw 'Cannot inspect the created SSH file.' }",
  "if ($info.Links -ne 1 -or $file.Length -ne 0 -or ($info.Attributes -band 1040) -ne 0) { throw 'Created SSH file identity changed.' }",
  "$fileId = ([UInt64]$info.IndexHigh -shl 32) -bor [UInt64]$info.IndexLow",
  "[Console]::Out.WriteLine(('created:' + $info.Volume.ToString([System.Globalization.CultureInfo]::InvariantCulture) + ':' + $fileId.ToString([System.Globalization.CultureInfo]::InvariantCulture)))",
  "} catch {",
  "$failure = $_.Exception",
  "while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }",
  "if (-not $created -and $failure -is [System.IO.IOException] -and (($failure.HResult -band 65535) -eq 80 -or ($failure.HResult -band 65535) -eq 183)) { [Console]::Out.WriteLine('exists'); exit 17 }",
  "exit 18",
  "} finally { if ($null -ne $file) { $file.Dispose() } }"
].join("; ");

/** Exclusively creates an owner-only empty file before obtaining a write handle. */
export async function createPrivateFile(path: string, signal: AbortSignal): Promise<FileHandle> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new PrivateFileCreationError("failed");
  if (signal.aborted) throw new PrivateFileCreationError("aborted");
  if (process.platform !== "win32") {
    let handle: FileHandle;
    try { handle = await open(path, "wx+", 0o600); }
    catch (error) { throw new PrivateFileCreationError(isExists(error) ? "exists" : "failed"); }
    if (signal.aborted) { await handle.close().catch(() => undefined); throw new PrivateFileCreationError("outcome_unknown"); }
    return handle;
  }
  const identity = await createWindowsFile(path, signal);
  let handle: FileHandle | undefined;
  try {
    signal.throwIfAborted();
    handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    const [held, current] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })]);
    if (!held.isFile() || !current.isFile() || current.isSymbolicLink() || held.size !== 0n || current.size !== 0n
      || held.nlink !== 1n || current.nlink !== 1n || held.dev !== identity.dev || held.ino !== identity.ino
      || held.dev !== current.dev || held.ino !== current.ino) throw new PrivateFileCreationError("outcome_unknown");
    signal.throwIfAborted();
    return handle;
  } catch {
    await handle?.close().catch(() => undefined);
    throw new PrivateFileCreationError("outcome_unknown");
  }
}

async function createWindowsFile(path: string, signal: AbortSignal): Promise<{ dev: bigint; ino: bigint }> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !isAbsolute(systemRoot) || resolve(systemRoot) !== systemRoot) throw new PrivateFileCreationError("failed");
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (signal.aborted) throw new PrivateFileCreationError("aborted");
  return new Promise((accept, reject) => {
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", CREATE_WINDOWS_FILE], {
      windowsHide: true, shell: false, stdio: ["ignore", "pipe", "ignore"],
      env: { SystemRoot: systemRoot, WINDIR: systemRoot,
        ...(process.env.TEMP === undefined ? {} : { TEMP: process.env.TEMP }),
        ...(process.env.TMP === undefined ? {} : { TMP: process.env.TMP }), JOKO_SSH_KEY_FILE: path }
    });
    let settled = false;
    let output = "";
    let stopping = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result?: { dev: bigint; ino: bigint }, failure?: PrivateFileCreationError): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); if (killTimer !== undefined) clearTimeout(killTimer);
      signal.removeEventListener("abort", cancel); output = "";
      if (result !== undefined) accept(result); else reject(failure ?? new PrivateFileCreationError("outcome_unknown"));
    };
    const cancel = (): void => {
      if (settled || stopping) return;
      stopping = true;
      try { child.kill("SIGKILL"); } catch { /* An admitted creation cannot be inferred absent. */ }
      killTimer = setTimeout(() => { child.stdout.destroy(); child.unref(); finish(); }, 1000);
    };
    const timer = setTimeout(cancel, 10_000);
    signal.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (data: Buffer) => {
      if (settled || stopping) return;
      if (output.length + data.length > 128) { cancel(); return; }
      output += data.toString("ascii");
    });
    child.once("error", () => finish(undefined, new PrivateFileCreationError(child.pid === undefined ? "failed" : "outcome_unknown")));
    child.once("close", code => {
      if (signal.aborted || stopping) { finish(); return; }
      if (code === 17 && output.trim() === "exists") { finish(undefined, new PrivateFileCreationError("exists")); return; }
      const identity = /^created:([0-9]{1,10}):([0-9]{1,20})\r?\n$/u.exec(output);
      if (code !== 0 || identity === null) { finish(); return; }
      const dev = BigInt(identity[1]!); const ino = BigInt(identity[2]!);
      if (dev > 0xffff_ffffn || ino > 0xffff_ffff_ffff_ffffn) { finish(); return; }
      finish({ dev, ino });
    });
    if (signal.aborted) cancel();
  });
}

function isExists(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "EEXIST"; }
