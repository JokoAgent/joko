import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { promisify } from "node:util";

import type { ManagedSubagentRunnerProcessInspection } from "./durable-subagent-runs.js";

const execFileAsync = promisify(execFile);

export interface ManagedSubagentRunnerProcessInspectorOptions {
  readonly platform?: NodeJS.Platform;
  readonly windowsSystemRoot?: string;
  readonly windowsPowerShellExecutable?: string;
  readonly windowsQueryExecutor?: (
    executable: string,
    arguments_: readonly string[]
  ) => Promise<{ readonly stdout: string }>;
}

export function createManagedSubagentRunnerProcessInspector(
  options: ManagedSubagentRunnerProcessInspectorOptions = {}
): (pid: number) => Promise<ManagedSubagentRunnerProcessInspection | undefined> {
  const platform = options.platform ?? process.platform;
  return (pid) => inspectManagedSubagentRunnerProcess(pid, platform, options);
}

export async function inspectManagedSubagentRunnerProcess(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  options: ManagedSubagentRunnerProcessInspectorOptions = {}
): Promise<ManagedSubagentRunnerProcessInspection | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    if (platform === "linux") return await inspectLinuxRunner(pid);
    if (platform === "win32") return await inspectWindowsRunner(pid, options);
    // A portable `ps` row cannot prove an exact argv vector or executable
    // identity. Unsupported hosts deliberately fail closed.
    return undefined;
  } catch {
    return undefined;
  }
}

async function inspectLinuxRunner(pid: number): Promise<ManagedSubagentRunnerProcessInspection | undefined> {
  const [commandLine, stat, executableLink, bootId] = await Promise.all([
    readFile(`/proc/${pid}/cmdline`),
    readFile(`/proc/${pid}/stat`, "utf8"),
    readlink(`/proc/${pid}/exe`),
    readFile("/proc/sys/kernel/random/boot_id", "utf8")
  ]);
  const argv = commandLine.toString("utf8").split("\0");
  if (argv.at(-1) === "") argv.pop();
  if (argv.length === 0 || argv.some((value) => value.includes("\0"))) return undefined;
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const suffix = stat.slice(close + 2).trim().split(/\s+/u);
  const startTime = suffix[19];
  if (startTime === undefined || !/^\d+$/u.test(startTime)) return undefined;
  const executablePath = await realpath(`/proc/${pid}/exe`).catch(() => executableLink);
  return {
    executablePath,
    argv,
    processIdentity: digest(`${bootId.trim()}\0${pid}\0${startTime}\0${executablePath}`)
  };
}

async function inspectWindowsRunner(
  pid: number,
  options: ManagedSubagentRunnerProcessInspectorOptions
): Promise<ManagedSubagentRunnerProcessInspection | undefined> {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"`,
    "if ($null -eq $p) { exit 3 }",
    "$created = if ($null -eq $p.CreationDate) { \"\" } else { $p.CreationDate.ToUniversalTime().Ticks }",
    "[pscustomobject]@{ ExecutablePath = [string]$p.ExecutablePath; CommandLine = [string]$p.CommandLine; CreationDate = [string]$created } | ConvertTo-Json -Compress"
  ].join("\n");
  const powerShellExecutable = await resolveTrustedWindowsPowerShellExecutable(options);
  if (powerShellExecutable === undefined) return undefined;
  const arguments_ = [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script
  ] as const;
  const { stdout } = options.windowsQueryExecutor === undefined
    ? await execFileAsync(powerShellExecutable, [...arguments_], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 256 * 1024
      })
    : await options.windowsQueryExecutor(powerShellExecutable, arguments_);
  const value: unknown = JSON.parse(stdout);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const inspectedExecutable = record["ExecutablePath"];
  const commandLine = record["CommandLine"];
  const creationDate = record["CreationDate"];
  if (typeof inspectedExecutable !== "string" || inspectedExecutable === "" || typeof commandLine !== "string" || commandLine === ""
      || typeof creationDate !== "string" || !/^\d+$/u.test(creationDate)) return undefined;
  const executablePath = await realpath(inspectedExecutable);
  const argv = parseWindowsCommandLine(commandLine);
  if (argv.length === 0) return undefined;
  return {
    executablePath,
    argv,
    processIdentity: digest(`${pid}\0${creationDate}\0${executablePath}`)
  };
}

export async function resolveTrustedWindowsPowerShellExecutable(
  options: ManagedSubagentRunnerProcessInspectorOptions = {}
): Promise<string | undefined> {
  const systemRoot = options.windowsSystemRoot ?? process.env["SystemRoot"];
  const candidate = options.windowsPowerShellExecutable
    ?? (typeof systemRoot === "string" && systemRoot !== ""
      ? join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : undefined);
  if (candidate === undefined || !isAbsolute(candidate)) return undefined;
  try {
    const [information, canonical] = await Promise.all([lstat(candidate), realpath(candidate)]);
    if (!information.isFile() || information.isSymbolicLink()) return undefined;
    if (normalize(canonical).toLowerCase() !== normalize(candidate).toLowerCase()) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

function parseWindowsCommandLine(commandLine: string): string[] {
  const argv: string[] = [];
  let offset = 0;
  while (offset < commandLine.length) {
    while (offset < commandLine.length && /\s/u.test(commandLine[offset]!)) offset += 1;
    if (offset >= commandLine.length) break;
    let value = "";
    let quoted = false;
    while (offset < commandLine.length) {
      let slashes = 0;
      while (commandLine[offset] === "\\") {
        slashes += 1;
        offset += 1;
      }
      if (commandLine[offset] === '"') {
        value += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) {
          value += '"';
          offset += 1;
          continue;
        }
        if (quoted && commandLine[offset + 1] === '"') {
          value += '"';
          offset += 2;
          continue;
        }
        quoted = !quoted;
        offset += 1;
        continue;
      }
      value += "\\".repeat(slashes);
      if (offset >= commandLine.length || (!quoted && /\s/u.test(commandLine[offset]!))) break;
      value += commandLine[offset]!;
      offset += 1;
    }
    if (quoted) return [];
    argv.push(value);
    while (offset < commandLine.length && /\s/u.test(commandLine[offset]!)) offset += 1;
  }
  return argv;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
