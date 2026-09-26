import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import { join, resolve } from "node:path";

export type KeyPermissionFailure = "unsafe_permissions" | "key_changed" | "io_failed" | "aborted";
export class KeyPermissionError extends Error {
  constructor(readonly code: KeyPermissionFailure) { super(`ssh_key.${code}`); this.name = "KeyPermissionError"; }
}

export interface PrivateKeyPermissionLease {
  verifyFinal(): Promise<void>;
  close(): Promise<void>;
}

/** A held private-file descriptor, not a pathname observation, owns this admission. */
export async function inspectPrivateKeyPermissions(directory: string, name: string, handle: FileHandle, signal: AbortSignal): Promise<PrivateKeyPermissionLease> {
  if (signal.aborted) throw new KeyPermissionError("aborted");
  if (process.platform === "win32") {
    const probe = await WindowsPermissionProbe.open(directory, join(directory, name), signal);
    try {
      await assertWindowsIdentity(directory, join(directory, name), handle, probe.identities);
      return { verifyFinal: async () => {
        await assertWindowsIdentity(directory, join(directory, name), handle, probe.identities);
        await probe.verifyFinal();
        await assertWindowsIdentity(directory, join(directory, name), handle, probe.identities);
      }, close: () => probe.close() };
    } catch (error) { await probe.close(); throw error; }
  }
  const uid = process.geteuid?.();
  if (uid === undefined) throw new KeyPermissionError("io_failed");
  const before = await handle.stat({ bigint: true });
  if (before.uid !== BigInt(uid) || (before.mode & 0o077n) !== 0n) throw new KeyPermissionError("unsafe_permissions");
  return {
    verifyFinal: async () => {
      const after = await handle.stat({ bigint: true });
      if (after.dev !== before.dev || after.ino !== before.ino || after.ctimeNs !== before.ctimeNs || after.mode !== before.mode || after.uid !== before.uid) {
        throw new KeyPermissionError("key_changed");
      }
      if (after.uid !== BigInt(uid) || (after.mode & 0o077n) !== 0n) throw new KeyPermissionError("unsafe_permissions");
    },
    close: async () => undefined
  };
}

/** Existing directories may be readable by others, but cannot be writable by them. */
export async function inspectKeyDirectoryPermissions(directory: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new KeyPermissionError("aborted");
  if (process.platform === "win32") {
    const probe = await WindowsPermissionProbe.open(directory, undefined, signal);
    try { await assertWindowsIdentity(directory, undefined, undefined, probe.identities); await probe.verifyFinal(); }
    finally { await probe.close(); }
    return;
  }
  const uid = process.geteuid?.();
  if (uid === undefined) throw new KeyPermissionError("io_failed");
  const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const held = await handle.stat({ bigint: true });
    const current = await lstat(directory, { bigint: true });
    if (!held.isDirectory() || !current.isDirectory() || current.isSymbolicLink() || held.dev !== current.dev || held.ino !== current.ino) throw new KeyPermissionError("key_changed");
    if (held.uid !== BigInt(uid) || (held.mode & 0o022n) !== 0n) throw new KeyPermissionError("unsafe_permissions");
    const after = await handle.stat({ bigint: true });
    if (after.dev !== held.dev || after.ino !== held.ino || after.ctimeNs !== held.ctimeNs || after.mode !== held.mode || after.uid !== held.uid) throw new KeyPermissionError("key_changed");
  } finally { await handle.close(); }
}

interface WindowsIdentities { readonly rootDev: bigint; readonly rootIno: bigint; readonly fileDev?: bigint; readonly fileIno?: bigint }

async function assertWindowsIdentity(directory: string, file: string | undefined, handle: FileHandle | undefined, identity: WindowsIdentities): Promise<void> {
  const root = await lstat(directory, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink() || !samePath(await realpath(directory), directory)
    || root.dev !== identity.rootDev || root.ino !== identity.rootIno) throw new KeyPermissionError("key_changed");
  if (file === undefined) return;
  const [held, current, canonical] = await Promise.all([handle!.stat({ bigint: true }), lstat(file, { bigint: true }), realpath(file)]);
  if (!held.isFile() || !current.isFile() || current.isSymbolicLink() || !samePath(canonical, file)
    || held.nlink !== 1n || current.nlink !== 1n || held.dev !== identity.fileDev || held.ino !== identity.fileIno
    || current.dev !== held.dev || current.ino !== held.ino) throw new KeyPermissionError("key_changed");
}

function samePath(a: string, b: string): boolean { return resolve(a).toLowerCase() === resolve(b).toLowerCase(); }

// Only owner/DACL and volume/file identity leave this fixed helper. It never
// reads private bytes, and retains both handles until Node completes its read.
const WINDOWS_PERMISSION_CHECK = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class JokoKeyPermissions {
  [StructLayout(LayoutKind.Sequential)] public struct Info {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
    public System.Runtime.InteropServices.ComTypes.FILETIME Access;
    public System.Runtime.InteropServices.ComTypes.FILETIME Write;
    public uint Volume;
    public uint SizeHigh;
    public uint SizeLow;
    public uint Links;
    public uint IndexHigh;
    public uint IndexLow;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern uint GetSecurityInfo(SafeFileHandle handle, uint objectType, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr LocalFree(IntPtr memory);
  static readonly SecurityIdentifier User = WindowsIdentity.GetCurrent().User;
  static readonly SecurityIdentifier System = new SecurityIdentifier("S-1-5-18");
  static readonly SecurityIdentifier Administrators = new SecurityIdentifier("S-1-5-32-544");
  const int DirectoryWrite = 0x10000000 | 0x40000000 | 0x00080000 | 0x00040000 | 0x00010000 | 0x00000100 | 0x00000040 | 0x00000010 | 0x00000004 | 0x00000002;
  const int PrivateMetadata = 0x00100000 | 0x00020000 | 0x00000080;
  public static SafeFileHandle Open(string path, bool directory) {
    var handle = CreateFileW(path, 0x00020080, directory ? 3u : 1u, IntPtr.Zero, 3u, directory ? 0x02200000u : 0x00200000u, IntPtr.Zero);
    if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
    return handle;
  }
  public static Info Identity(SafeFileHandle handle, bool directory) {
    Info info;
    if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if ((info.Attributes & 0x400u) != 0 || ((info.Attributes & 0x10u) != 0) != directory || (!directory && info.Links != 1u)) throw new InvalidOperationException();
    return info;
  }
  public static byte[] Descriptor(SafeFileHandle handle) {
    IntPtr owner, group, dacl, sacl, descriptor;
    var status = GetSecurityInfo(handle, 1u, 5u, out owner, out group, out dacl, out sacl, out descriptor);
    if (status != 0u) throw new Win32Exception((int)status);
    try {
      var length = GetSecurityDescriptorLength(descriptor);
      if (length < 20u || length > 65536u) throw new InvalidOperationException();
      var bytes = new byte[(int)length];
      Marshal.Copy(descriptor, bytes, 0, bytes.Length);
      return bytes;
    } finally { LocalFree(descriptor); }
  }
  public static bool Safe(byte[] descriptor, bool directory) {
    var parsed = new RawSecurityDescriptor(descriptor, 0);
    if (parsed.Owner == null || parsed.DiscretionaryAcl == null) return false;
    var owner = parsed.Owner;
    if (directory ? !(owner.Equals(User) || owner.Equals(System) || owner.Equals(Administrators)) : !owner.Equals(User)) return false;
    foreach (GenericAce ace in parsed.DiscretionaryAcl) {
      if ((ace.AceFlags & AceFlags.InheritOnly) != 0) continue;
      var qualified = ace as QualifiedAce;
      if (qualified == null) return false;
      if (qualified.AceQualifier != AceQualifier.AccessAllowed) continue;
      var known = ace as KnownAce;
      if (known == null || known.SecurityIdentifier == null) return false;
      var sid = known.SecurityIdentifier;
      if (sid.Equals(User) || sid.Equals(System) || sid.Equals(Administrators)) continue;
      if (directory ? (known.AccessMask & DirectoryWrite) != 0 : (known.AccessMask & ~PrivateMetadata) != 0) return false;
    }
    return true;
  }
  public static bool Same(byte[] first, byte[] second) { return StructuralComparisons.StructuralEqualityComparer.Equals(first, second); }
  public static bool Same(Info first, Info second) { return first.Volume == second.Volume && first.IndexHigh == second.IndexHigh && first.IndexLow == second.IndexLow; }
  public static string Id(Info info) { return info.Volume.ToString() + ":" + (((ulong)info.IndexHigh << 32) | info.IndexLow).ToString(); }
}
'@
$root = $null
$file = $null
try {
  $root = [JokoKeyPermissions]::Open($env:JOKO_SSH_ROOT, $true)
  $rootInfo = [JokoKeyPermissions]::Identity($root, $true)
  $rootAcl = [JokoKeyPermissions]::Descriptor($root)
  if (-not [JokoKeyPermissions]::Safe($rootAcl, $true)) { [Console]::Out.WriteLine('unsafe'); exit 0 }
  if ($env:JOKO_SSH_FILE) {
    $file = [JokoKeyPermissions]::Open($env:JOKO_SSH_FILE, $false)
    $fileInfo = [JokoKeyPermissions]::Identity($file, $false)
    $fileAcl = [JokoKeyPermissions]::Descriptor($file)
    if (-not [JokoKeyPermissions]::Safe($fileAcl, $false)) { [Console]::Out.WriteLine('unsafe'); exit 0 }
    [Console]::Out.WriteLine('verified:' + [JokoKeyPermissions]::Id($rootInfo) + ':' + [JokoKeyPermissions]::Id($fileInfo))
  } else {
    [Console]::Out.WriteLine('verified:' + [JokoKeyPermissions]::Id($rootInfo))
  }
  [Console]::Out.Flush()
  if ([Console]::In.ReadLine() -ne 'finish') { exit 0 }
  $rootNext = [JokoKeyPermissions]::Identity($root, $true)
  $rootAclNext = [JokoKeyPermissions]::Descriptor($root)
  if (-not [JokoKeyPermissions]::Safe($rootAclNext, $true)) { [Console]::Out.WriteLine('unsafe'); exit 0 }
  if (-not [JokoKeyPermissions]::Same($rootInfo, $rootNext) -or -not [JokoKeyPermissions]::Same($rootAcl, $rootAclNext)) { [Console]::Out.WriteLine('changed'); exit 0 }
  if ($file) {
    $fileNext = [JokoKeyPermissions]::Identity($file, $false)
    $fileAclNext = [JokoKeyPermissions]::Descriptor($file)
    if (-not [JokoKeyPermissions]::Safe($fileAclNext, $false)) { [Console]::Out.WriteLine('unsafe'); exit 0 }
    if (-not [JokoKeyPermissions]::Same($fileInfo, $fileNext) -or -not [JokoKeyPermissions]::Same($fileAcl, $fileAclNext)) { [Console]::Out.WriteLine('changed'); exit 0 }
  }
  [Console]::Out.WriteLine('stable')
} catch {
  [Console]::Out.WriteLine('unverified')
} finally {
  if ($file) { $file.Dispose() }
  if ($root) { $root.Dispose() }
}
`;

class WindowsPermissionProbe {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #lines: Interface;
  readonly #iterator: AsyncIterator<string>;
  readonly #signal: AbortSignal;
  readonly #abort: () => void;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly identities: WindowsIdentities;
  #closed = false;
  #failed: KeyPermissionError | undefined;
  private constructor(child: ChildProcessWithoutNullStreams, signal: AbortSignal, identities: WindowsIdentities) {
    this.#child = child; this.#signal = signal; this.identities = identities;
    this.#lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#iterator = this.#lines[Symbol.asyncIterator]();
    this.#abort = () => { this.#failed = new KeyPermissionError("aborted"); child.kill("SIGKILL"); };
    this.#timer = setTimeout(() => { this.#failed = new KeyPermissionError("io_failed"); child.kill("SIGKILL"); }, 10_000);
    this.#timer.unref();
    signal.addEventListener("abort", this.#abort, { once: true });
    child.once("error", () => { this.#failed = new KeyPermissionError("io_failed"); });
  }
  static async open(directory: string, file: string | undefined, signal: AbortSignal): Promise<WindowsPermissionProbe> {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!systemRoot || resolve(systemRoot) !== systemRoot || signal.aborted) throw new KeyPermissionError(signal.aborted ? "aborted" : "io_failed");
    const child = spawn(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PERMISSION_CHECK], {
        windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
        env: { SystemRoot: systemRoot, WINDIR: systemRoot, JOKO_SSH_ROOT: directory,
          ...(file === undefined ? {} : { JOKO_SSH_FILE: file }),
          ...(process.env.TEMP === undefined ? {} : { TEMP: process.env.TEMP }),
          ...(process.env.TMP === undefined ? {} : { TMP: process.env.TMP }) }
      });
    // The helper emits only a small fixed protocol; its diagnostic stderr is discarded.
    child.stderr.resume();
    const probe = new WindowsPermissionProbe(child, signal, {} as WindowsIdentities);
    try {
      const line = await probe.#next();
      if (line === "unsafe") throw new KeyPermissionError("unsafe_permissions");
      const match = file === undefined ? /^verified:([0-9]+):([0-9]+)$/u.exec(line)
        : /^verified:([0-9]+):([0-9]+):([0-9]+):([0-9]+)$/u.exec(line);
      if (!match) throw new KeyPermissionError("io_failed");
      (probe as { identities: WindowsIdentities }).identities = { rootDev: BigInt(match[1]!), rootIno: BigInt(match[2]!),
        ...(file === undefined ? {} : { fileDev: BigInt(match[3]!), fileIno: BigInt(match[4]!) }) };
      return probe;
    } catch (error) { await probe.close(); throw error; }
  }
  async verifyFinal(): Promise<void> {
    if (this.#closed) throw new KeyPermissionError("io_failed");
    if (this.#signal.aborted) throw new KeyPermissionError("aborted");
    this.#child.stdin.write("finish\n");
    const line = await this.#next();
    if (line === "unsafe") throw new KeyPermissionError("unsafe_permissions");
    if (line === "changed") throw new KeyPermissionError("key_changed");
    if (line !== "stable") throw new KeyPermissionError("io_failed");
    await this.close();
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer); this.#signal.removeEventListener("abort", this.#abort);
    this.#child.stdin.end();
    this.#lines.close();
    if (this.#child.exitCode === null) this.#child.kill("SIGKILL");
  }
  async #next(): Promise<string> {
    const result = await this.#iterator.next();
    if (this.#failed) throw this.#failed;
    if (result.done || result.value.length > 160) throw new KeyPermissionError("io_failed");
    return result.value;
  }
}
