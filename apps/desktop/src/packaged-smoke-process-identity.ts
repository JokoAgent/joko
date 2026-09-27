import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const MAXIMUM_PROCESS_ID = 0xffff_ffff;
const MAXIMUM_IDENTITY_INPUT_BYTES = 64 * 1024;

/**
 * Smoke-only OS birth proof for the detached managed Orchestrator. The value
 * deliberately contains no command line, environment, credential or path.
 */
export function capturePackagedSmokeProcessBirthIdentitySync(
  pid: number,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > MAXIMUM_PROCESS_ID) {
    throw new TypeError("Packaged smoke process ID is invalid.");
  }
  if (platform === "linux") {
    try {
      const firstStat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const executable = readlinkSync(`/proc/${pid}/exe`);
      const secondStat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
      return deriveLinuxPackagedSmokeProcessBirthIdentity(pid, firstStat, secondStat, executable, bootId);
    } catch (error) {
      if (missingLinuxProcess(error)) return undefined;
      throw error;
    }
  }
  if (platform === "win32") {
    try {
      const stdout = execFileSync(trustedWindowsPowerShell(), windowsIdentityArguments(pid), {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: MAXIMUM_IDENTITY_INPUT_BYTES
      });
      return derivePortablePackagedSmokeProcessBirthIdentity(pid, platform, stdout);
    } catch (error) {
      if (missingPortableProcess(error, new Set([3]))) return undefined;
      throw error;
    }
  }
  if (platform === "darwin") {
    try {
      const stdout = execFileSync(trustedMacProcessStatus(), ["-p", String(pid), "-o", "lstart=", "-o", "comm="], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: MAXIMUM_IDENTITY_INPUT_BYTES,
        env: { ...process.env, LC_ALL: "C", TZ: "UTC0" }
      });
      return derivePortablePackagedSmokeProcessBirthIdentity(pid, platform, stdout);
    } catch (error) {
      if (missingPortableProcess(error, new Set([1]))) return undefined;
      throw error;
    }
  }
  throw new Error(`Packaged smoke process birth identity is unsupported on ${platform}.`);
}

export function deriveLinuxPackagedSmokeProcessBirthIdentity(
  pid: number,
  firstStat: string,
  secondStat: string,
  executable: string,
  bootId: string
): string | undefined {
  const firstStart = linuxStartTicks(firstStat);
  const secondStart = linuxStartTicks(secondStat);
  const normalizedBootId = bootId.trim();
  if (firstStart === undefined || secondStart === undefined || firstStart !== secondStart ||
    normalizedBootId === "" || normalizedBootId.length > 128 || /[\0\r\n]/u.test(normalizedBootId) ||
    executable === "" || Buffer.byteLength(executable, "utf8") > MAXIMUM_IDENTITY_INPUT_BYTES ||
    /[\0\r\n]/u.test(executable)) return undefined;
  return digestIdentity(["joko-packaged-smoke-process-v1", "linux", String(pid), normalizedBootId, firstStart, executable]);
}

export function derivePortablePackagedSmokeProcessBirthIdentity(
  pid: number,
  platform: "win32" | "darwin",
  output: string
): string | undefined {
  const normalized = output.trim();
  if (normalized === "" || Buffer.byteLength(normalized, "utf8") > MAXIMUM_IDENTITY_INPUT_BYTES ||
    /[\0\r\n]/u.test(normalized)) return undefined;
  return digestIdentity(["joko-packaged-smoke-process-v1", platform, String(pid), normalized]);
}

function linuxStartTicks(stat: string): string | undefined {
  if (Buffer.byteLength(stat, "utf8") > 16 * 1024) return undefined;
  const close = stat.lastIndexOf(")");
  if (close < 1) return undefined;
  const fields = stat.slice(close + 1).trim().split(/\s+/u);
  const startTicks = fields[19];
  return startTicks !== undefined && /^[0-9]+$/u.test(startTicks) ? startTicks : undefined;
}

function trustedWindowsPowerShell(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (typeof systemRoot !== "string" || !isAbsolute(systemRoot)) {
    throw new Error("Packaged smoke cannot locate the trusted Windows PowerShell runtime.");
  }
  const candidate = resolve(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  const info = lstatSync(candidate);
  const canonical = realpathSync.native(candidate);
  if (!info.isFile() || info.isSymbolicLink() || canonical.toLowerCase() !== candidate.toLowerCase()) {
    throw new Error("Packaged smoke Windows PowerShell runtime is not canonical.");
  }
  return canonical;
}

function trustedMacProcessStatus(): string {
  const candidate = "/bin/ps";
  const info = lstatSync(candidate);
  const canonical = realpathSync.native(candidate);
  if (!info.isFile() || info.isSymbolicLink() || canonical !== candidate) {
    throw new Error("Packaged smoke macOS process-status runtime is not canonical.");
  }
  return canonical;
}

function windowsIdentityArguments(pid: number): readonly string[] {
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    "if ($null -eq $p) { exit 3 }",
    '$created = if ($null -eq $p.CreationDate) { "" } else { $p.CreationDate.ToUniversalTime().Ticks.ToString() }',
    '$path = [string]$p.ExecutablePath',
    'if ($created -notmatch "^[0-9]+$" -or [string]::IsNullOrWhiteSpace($path)) { exit 4 }',
    '[Console]::Out.Write($created + "|" + $path)'
  ].join("; ");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
}

function missingLinuxProcess(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ESRCH";
}

function missingPortableProcess(error: unknown, statuses: ReadonlySet<number>): boolean {
  const value = error as { readonly status?: unknown } | undefined;
  return typeof value?.status === "number" && statuses.has(value.status);
}

function digestIdentity(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
