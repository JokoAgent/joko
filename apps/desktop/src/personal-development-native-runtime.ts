import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createReadStream, readFileSync, readlinkSync } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWritePrivateFile, ensurePrivateDirectory, readPrivateFile } from "./secure-files.js";

export interface PersonalNativeRuntime {
  readonly id: "original" | "personal"; readonly generation: string;
  readonly runtimeDirectory: string; readonly executable: string; readonly runtimeDigest: string;
  readonly compatibilityIdentity: string; readonly version: string; readonly development: boolean;
  readonly appPath?: string;
}
export interface PersonalNativeLaunch {
  readonly format: 1; readonly ticketId: string; readonly profileDirectory: string;
  readonly target: PersonalNativeRuntime; readonly previous: PersonalNativeRuntime; readonly original: PersonalNativeRuntime;
  readonly parentPid: number; readonly parentBirth: string; readonly helperExecutable: string; readonly helperAppPath?: string;
  readonly parentServicePid?: number; readonly parentServiceBirth?: string;
  readonly state: "prepared" | "waiting" | "starting" | "ready" | "failed" | "unknown";
  readonly helperPid?: number; readonly helperBirth?: string; readonly childPid?: number; readonly childBirth?: string;
  readonly servicePid?: number; readonly serviceBirth?: string;
  readonly outcome?: "ready" | "failed";
}
export const PERSONAL_PROFILE_FLAG = "--joko-personal-profile=";
export const PERSONAL_LAUNCH_FLAG = "--joko-personal-launch=";
export const PERSONAL_HELPER_FLAG = "--joko-personal-helper=";
export const PERSONAL_TEST_FLAG = "--joko-personal-test=";
export const NATIVE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const digest = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
export const nativeProfileIdentity = (profile: string): string => digest(`joko-personal-profile-v1\0${resolve(profile)}`);
export const launchPath = (profile: string, id: string): string => {
  if (!NATIVE_UUID.test(id)) throw new Error("Invalid native launch identity.");
  return join(profile, "personal-development-native", "launches", `${id}.json`);
};
export async function writeNativeRecord(path: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(dirname(path)); await atomicWritePrivateFile(path, Buffer.from(JSON.stringify(value), "utf8"));
}
export async function readNativeRecord<T>(path: string): Promise<T | undefined> {
  const bytes = await readPrivateFile(path); if (!bytes) return undefined;
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")) as T; } finally { bytes.fill(0); }
}
export async function readNativeLaunch(profile: string, id: string): Promise<PersonalNativeLaunch> {
  if (!isAbsolute(profile) || await realpath(profile) !== profile) throw new Error("Native profile identity is invalid.");
  const record = await readNativeRecord<PersonalNativeLaunch>(launchPath(profile, id));
  if (!record || record.format !== 1 || record.ticketId !== id || record.profileDirectory !== profile
    || !Number.isSafeInteger(record.parentPid) || !record.parentBirth || !["prepared", "waiting", "starting", "ready", "failed", "unknown"].includes(record.state)) throw new Error("Native launch record is invalid.");
  return record;
}

/** Birth proof from OS-owned facts; no process command line or environment is retained. */
export function personalNativeBirth(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid native process identity.");
  try {
    if (process.platform === "linux") {
      const a = readFileSync(`/proc/${pid}/stat`, "utf8"), executable = readlinkSync(`/proc/${pid}/exe`), b = readFileSync(`/proc/${pid}/stat`, "utf8");
      const parse = (value: string) => value.slice(value.lastIndexOf(")") + 2).split(" ")[19];
      if (!parse(a) || parse(a) !== parse(b)) throw new Error("Native process birth changed.");
      return digest(`${pid}\0${parse(a)}\0${executable}\0${readFileSync("/proc/sys/kernel/random/boot_id", "utf8")}`);
    }
    const output = process.platform === "win32" ? execFileSync(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -eq $p) { exit 3 }; [Console]::Out.Write($p.CreationDate.ToUniversalTime().ToString('O')+'|'+$p.ExecutablePath)`],
      { encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 })
      : execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="],
        { encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: "C", TZ: "UTC0" } });
    if (!output.trim()) return undefined; return digest(`${process.platform}\0${pid}\0${output.trim()}`);
  } catch (error) {
    const record = error as NodeJS.ErrnoException & { status?: number };
    if (record.code === "ENOENT" || record.code === "ESRCH" || record.status === 3 || (process.platform === "darwin" && record.status === 1)) return undefined;
    throw error;
  }
}

export async function personalRuntimeDigest(root: string): Promise<string> {
  const canonical = await realpath(root); const hash = createHash("sha256"); let count = 0;
  const inside = (path: string) => { const rel = relative(canonical, path); return rel === "" || !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel); };
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      if (++count > 300_000) throw new Error("Native runtime exceeds its entry limit.");
      const path = join(directory, name), info = await lstat(path), rel = relative(root, path).split(sep).join("/");
      if (info.isSymbolicLink()) { const target = await readlink(path); if (!inside(await realpath(path))) throw new Error("Native runtime escaped its root."); hash.update(`L\0${rel}\0${target}\0`); }
      else if (info.isDirectory()) { hash.update(`D\0${rel}\0`); await visit(path); }
      else if (info.isFile()) {
        const bytes = createHash("sha256"); for await (const chunk of createReadStream(path)) bytes.update(chunk);
        hash.update(`F\0${rel}\0${info.mode & 0o111}\0${bytes.digest("hex")}\0`);
      } else throw new Error("Native runtime contains an unsupported entry.");
    }
  };
  await visit(root); return hash.digest("hex");
}
export async function verifyPersonalNativeRuntime(runtime: PersonalNativeRuntime): Promise<void> {
  if (!isAbsolute(runtime.runtimeDirectory) || !isAbsolute(runtime.executable) || (await lstat(runtime.executable)).isSymbolicLink()
    || !(await lstat(runtime.executable)).isFile() || await personalRuntimeDigest(runtime.runtimeDirectory) !== runtime.runtimeDigest) throw new Error("Native runtime identity changed.");
}
export async function describeOriginalPersonalRuntime(input: { readonly executable: string; readonly appPath: string;
  readonly development: boolean; readonly version: string; readonly schemaPath: string }): Promise<PersonalNativeRuntime> {
  const executable = await realpath(input.executable);
  const runtimeDirectory = process.platform === "darwin" && !input.development ? resolve(dirname(executable), "..", "..") : dirname(executable);
  const schemaDigest = digest(await readFile(input.schemaPath));
  return { id: "original", generation: "", executable, runtimeDirectory, runtimeDigest: await personalRuntimeDigest(runtimeDirectory),
    compatibilityIdentity: digest(`joko-personal-runtime-v1\0${schemaDigest}`), version: input.version, development: input.development,
    ...(input.development ? { appPath: input.appPath } : {}) };
}
export function personalNativeEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "TZ", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]);
  return Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && allowed.has(name.toUpperCase())));
}
export function spawnPersonalNative(runtime: PersonalNativeRuntime, flags: readonly string[], pipes = false): ChildProcess {
  return spawn(runtime.executable, [...(runtime.development && runtime.appPath ? [runtime.appPath] : []), ...flags],
    { cwd: runtime.runtimeDirectory, env: personalNativeEnvironment(), windowsHide: true, detached: true,
      stdio: pipes ? ["ignore", "ignore", "ignore", "pipe", "pipe"] : "ignore" });
}
export async function awaitNativeCondition(test: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await test()) return true; await new Promise(resolve => setTimeout(resolve, 100)); }
  return false;
}
export async function initializePersonalNativeRoot(profile: string): Promise<string> {
  const root = join(profile, "personal-development-native"); await mkdir(root, { recursive: true, mode: 0o700 }); return root;
}
export const newPersonalNativeIdentity = () => randomUUID();
