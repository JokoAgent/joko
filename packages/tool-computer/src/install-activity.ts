import { spawn } from "node:child_process";
import { promises as fileSystem } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import type { ComputerProcessActivitySample } from "./process-runner.js";

export interface ComputerInstallAsset {
  readonly name: string;
  readonly size: number;
}

interface ProcessActivityRow {
  readonly pid: number;
  readonly parentPid?: number;
  readonly processGroup?: number;
  readonly cpuTime: string;
  readonly command: string;
}

export interface ComputerInstallActivitySamplerOptions {
  readonly platform?: NodeJS.Platform;
  readonly assets?: readonly ComputerInstallAsset[];
  readonly searchRoots?: readonly string[];
  readonly readProcesses?: (
    rootPid: number,
    signal: AbortSignal
  ) => Promise<readonly ProcessActivityRow[]>;
}

export class ComputerInstallActivitySampler {
  readonly #platform: NodeJS.Platform;
  readonly #assets: ReadonlyMap<string, number>;
  readonly #searchRoots: readonly string[];
  readonly #readProcesses: (
    rootPid: number,
    signal: AbortSignal
  ) => Promise<readonly ProcessActivityRow[]>;
  #sawDownload = false;

  constructor(options: ComputerInstallActivitySamplerOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#assets = new Map((options.assets ?? []).map((asset) => [asset.name, asset.size]));
    this.#searchRoots = [...new Set(options.searchRoots ?? [tmpdir(), join(homedir(), ".cua-driver")])];
    this.#readProcesses = options.readProcesses ?? ((rootPid, signal) =>
      readInstallProcesses(rootPid, this.#platform, signal));
  }

  async sample(rootPid: number, signal: AbortSignal): Promise<ComputerProcessActivitySample | undefined> {
    const rows = await this.#readProcesses(rootPid, signal);
    signal.throwIfAborted();
    const commandPaths = rows
      .map((row) => extractInstallDownloadPath(row.command))
      .filter((value): value is string => value !== undefined);
    const scannedPaths = await findDownloadCandidates(this.#searchRoots, new Set(this.#assets.keys()), signal);
    const paths = [...new Set([...commandPaths, ...scannedPaths])];
    const files: Array<{ readonly path: string; readonly bytes: number; readonly total: number | null }> = [];
    for (const path of paths.slice(0, 64)) {
      signal.throwIfAborted();
      try {
        const stat = await fileSystem.stat(path);
        if (!stat.isFile()) continue;
        files.push({ path, bytes: stat.size, total: this.#assets.get(basename(path)) ?? null });
      } catch {
        // Temporary downloads may disappear between process inspection and stat.
      }
    }
    const best = files.sort((left, right) => right.bytes - left.bytes)[0];
    const downloadingCommand = rows.some((row) => /(?:\bcurl\b|invoke-webrequest|start-bitstransfer|downloadfile)/iu.test(row.command));
    const installingCommand = rows.some((row) => /(?:expand-archive|\btar\b|\bunzip\b|install-item|move-item|copy-item|\bmv\b|\bcp\b)/iu.test(row.command));
    if (best !== undefined || downloadingCommand) this.#sawDownload = true;
    const phase = best !== undefined || downloadingCommand
      ? "downloading" as const
      : this.#sawDownload || installingCommand
        ? "installing" as const
        : undefined;
    const fingerprint = [
      ...rows.map((row) => `${row.pid}:${row.cpuTime}:${row.command.slice(0, 4_096)}`).sort(),
      ...files.map((file) => `${file.path}:${file.bytes}`).sort()
    ].join("|");
    if (fingerprint === "" && phase === undefined) return undefined;
    return {
      fingerprint,
      ...(phase === undefined ? {} : { phase }),
      ...(phase !== "downloading"
        ? {}
        : {
            downloadedBytes: best?.bytes ?? null,
            totalBytes: best?.total ?? null
          })
    };
  }
}

export function extractInstallDownloadPath(command: string): string | undefined {
  const patterns = [
    /(?:^|\s)-o\s+("[^"]+"|'[^']+'|\S+)/iu,
    /(?:^|\s)-o("[^"]+"|'[^']+'|[^\s"']\S*)/iu,
    /(?:^|\s)--output(?:=|\s+)("[^"]+"|'[^']+'|\S+)/iu,
    /(?:^|\s)-OutFile(?:\s+|:)("[^"]+"|'[^']+'|\S+)/iu
  ];
  for (const pattern of patterns) {
    const raw = pattern.exec(command)?.[1];
    if (raw === undefined) continue;
    const value = raw.replace(/^["']|["']$/gu, "");
    if (value !== "" && value.length <= 32_768 && !value.includes("\0") && isAbsolute(value)) return value;
  }
  return undefined;
}

export async function clearStaleComputerInstallLock(
  lockDirectory: string,
  holderAlive: (processId: number) => boolean = isProcessAlive
): Promise<boolean> {
  const target = resolve(lockDirectory);
  const infoPath = join(target, "info");
  try {
    const before = await fileSystem.lstat(target);
    if (!before.isDirectory() || before.isSymbolicLink()) return false;
    const infoStat = await fileSystem.lstat(infoPath);
    if (!infoStat.isFile() || infoStat.isSymbolicLink() || infoStat.size > 4_096) return false;
    const info = await fileSystem.readFile(infoPath, "utf8");
    const processId = Number(/^pid=(\d+)\s*$/mu.exec(info)?.[1]);
    if (!Number.isSafeInteger(processId) || processId <= 0 || holderAlive(processId)) return false;
    const after = await fileSystem.lstat(target);
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) return false;
    const confirmed = await fileSystem.readFile(infoPath, "utf8");
    if (confirmed !== info) return false;
    await fileSystem.rm(target, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readInstallProcesses(
  rootPid: number,
  platform: NodeJS.Platform,
  signal: AbortSignal
): Promise<readonly ProcessActivityRow[]> {
  if (platform === "win32") {
    const script = [
      "$ErrorActionPreference='Stop'",
      "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,CommandLine | ConvertTo-Json -Compress"
    ].join("; ");
    const output = await captureCommand("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script
    ], 5_000, signal);
    return windowsProcessTree(output, rootPid);
  }
  const output = await captureCommand("ps", [
    "-ax",
    "-o",
    "pgid=,pid=,ppid=,time=,command="
  ], 3_000, signal);
  return posixProcessTree(output, rootPid);
}

function posixProcessTree(output: string, rootPid: number): readonly ProcessActivityRow[] {
  const rows: ProcessActivityRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined) continue;
    const processGroup = Number(match[1]);
    const pid = Number(match[2]);
    const parentPid = Number(match[3]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    rows.push({
      pid,
      parentPid,
      processGroup,
      cpuTime: match[4],
      command: match[5] ?? ""
    });
  }
  const descendants = descendantProcessIds(rows, rootPid);
  return rows.filter((row) => row.processGroup === rootPid || descendants.has(row.pid));
}

function windowsProcessTree(output: string, rootPid: number): readonly ProcessActivityRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return [];
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const rows: ProcessActivityRow[] = [];
  for (const value of values) {
    if (!isRecord(value)) continue;
    const pid = Number(value["ProcessId"]);
    const parentPid = Number(value["ParentProcessId"]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    rows.push({
      pid,
      ...(Number.isSafeInteger(parentPid) && parentPid > 0 ? { parentPid } : {}),
      cpuTime: `${String(value["KernelModeTime"] ?? "0")}:${String(value["UserModeTime"] ?? "0")}`,
      command: typeof value["CommandLine"] === "string" ? value["CommandLine"] : ""
    });
  }
  const descendants = descendantProcessIds(rows, rootPid);
  return rows.filter((row) => descendants.has(row.pid));
}

function descendantProcessIds(rows: readonly ProcessActivityRow[], rootPid: number): ReadonlySet<number> {
  const result = new Set<number>([rootPid]);
  let changed = true;
  while (changed && result.size <= 4_096) {
    changed = false;
    for (const row of rows) {
      if (row.parentPid !== undefined && result.has(row.parentPid) && !result.has(row.pid)) {
        result.add(row.pid);
        changed = true;
      }
    }
  }
  return result;
}

async function findDownloadCandidates(
  roots: readonly string[],
  expectedNames: ReadonlySet<string>,
  signal: AbortSignal
): Promise<readonly string[]> {
  if (expectedNames.size === 0) return [];
  const matches: string[] = [];
  let entries = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4 || entries >= 5_000 || matches.length >= 64) return;
    let handle: Awaited<ReturnType<typeof fileSystem.opendir>>;
    try {
      handle = await fileSystem.opendir(directory);
    } catch {
      return;
    }
    for await (const entry of handle) {
      signal.throwIfAborted();
      entries += 1;
      if (entries > 5_000) break;
      const path = join(directory, entry.name);
      if (entry.isFile() && expectedNames.has(entry.name)) matches.push(path);
      else if (entry.isDirectory()) await visit(path, depth + 1);
      if (matches.length >= 64) break;
    }
  };
  for (const root of roots) await visit(root, 0);
  return matches;
}

function captureCommand(
  command: string,
  arguments_: readonly string[],
  timeoutMs: number,
  signal: AbortSignal
): Promise<string> {
  if (signal.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
  return new Promise((resolveCapture, rejectCapture) => {
    const child = spawn(command, [...arguments_], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
      windowsHide: true
    });
    let output = "";
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const stop = (): void => {
      try { child.kill(); } catch { /* already closed */ }
    };
    const onAbort = (): void => finish(() => {
      stop();
      rejectCapture(new DOMException("Cancelled", "AbortError"));
    });
    const timer = setTimeout(() => finish(() => {
      stop();
      resolveCapture("");
    }), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", () => finish(() => resolveCapture("")));
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (Buffer.byteLength(output, "utf8") < 2 * 1024 * 1024) output += chunk.toString();
    });
    child.once("close", (exitCode) => finish(() => resolveCapture(exitCode === 0 ? output : "")));
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
