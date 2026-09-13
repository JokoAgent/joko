import { existsSync, promises as fileSystem } from "node:fs";
import path, { win32 } from "node:path";

import type {
  ComputerCommandRunner,
  ComputerHostPlatform
} from "./process-runner.js";

interface ProcessSnapshotEntry {
  readonly pid: number;
  readonly parent_pid?: number;
  readonly name?: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly executable?: string;
}

interface ProcessSnapshot {
  readonly available: boolean;
  readonly processes: ReadonlyMap<number, ProcessSnapshotEntry>;
}

export interface ComputerProcessSnapshotReaderOptions {
  readonly platform: ComputerHostPlatform;
  readonly runner: ComputerCommandRunner;
  readonly pathExists?: (candidate: string) => boolean;
  readonly now?: () => number;
}

export class ComputerProcessSnapshotReader {
  readonly #platform: ComputerHostPlatform;
  readonly #runner: ComputerCommandRunner;
  readonly #pathExists: (candidate: string) => boolean;
  readonly #now: () => number;
  #cache: { readonly expiresAt: number; readonly snapshot: ProcessSnapshot } | undefined;

  constructor(options: ComputerProcessSnapshotReaderOptions) {
    this.#platform = options.platform;
    this.#runner = options.runner;
    this.#pathExists = options.pathExists ?? existsSync;
    this.#now = options.now ?? Date.now;
  }

  async enrichAndFilter(
    payload: Readonly<Record<string, unknown>>,
    arguments_: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<Readonly<Record<string, unknown>>> {
    const directWindows = Array.isArray(payload["windows"]) ? payload["windows"] : undefined;
    const data = isRecord(payload["data"]) ? payload["data"] : undefined;
    const nestedWindows = Array.isArray(data?.["windows"]) ? data["windows"] : undefined;
    const rawWindows = directWindows ?? nestedWindows;
    if (rawWindows === undefined) return payload;
    const windows = rawWindows.filter(isRecord);
    const needsSnapshot = windows.some((window) => validPid(window["pid"]) !== undefined);
    const snapshot = needsSnapshot
      ? await this.#snapshot(hasProcessFilter(arguments_), signal)
      : { available: true, processes: new Map<number, ProcessSnapshotEntry>() };
    const workspaceCache = new Map<string, string | undefined>();
    const enriched = await Promise.all(windows.map(async (window) => {
      const pid = validPid(window["pid"]);
      let processInfo = pid === undefined ? undefined : snapshot.processes.get(pid);
      if (processInfo !== undefined && this.#platform === "linux" && processInfo.cwd === undefined) {
        try {
          processInfo = { ...processInfo, cwd: await fileSystem.readlink(`/proc/${processInfo.pid}/cwd`) };
        } catch {
          // Processes can exit or deny inspection between the snapshot and enrichment.
        }
      }
      const processPayload = processInfo === undefined
        ? pid === undefined ? undefined : { pid }
        : {
            pid: processInfo.pid,
            ...(processInfo.parent_pid === undefined ? {} : { parent_pid: processInfo.parent_pid }),
            ...(processInfo.name === undefined ? {} : { name: processInfo.name }),
            ...(processInfo.command === undefined ? {} : { command: redactProcessCommand(processInfo.command) }),
            ...(processInfo.cwd === undefined ? {} : { cwd: processInfo.cwd }),
            ...(processInfo.executable === undefined ? {} : { executable: processInfo.executable })
          };
      return {
        ...window,
        ...(processPayload === undefined ? {} : { process: processPayload }),
        ...(processInfo === undefined ? {} : { identity: this.#identity(window, processInfo, workspaceCache) })
      };
    }));
    const filtered = enriched.filter((window) => this.#matches(window, arguments_));
    const replacement = {
      ...(directWindows === undefined ? { ...data, windows: filtered } : undefined)
    };
    if (directWindows !== undefined) {
      return {
        ...payload,
        ...(!snapshot.available && hasProcessFilter(arguments_) ? { enrichment: "unavailable" } : {}),
        windows: filtered
      };
    }
    return {
      ...payload,
      ...(!snapshot.available && hasProcessFilter(arguments_) ? { enrichment: "unavailable" } : {}),
      data: replacement
    };
  }

  async #snapshot(forceFresh: boolean, signal?: AbortSignal): Promise<ProcessSnapshot> {
    if (!forceFresh && this.#cache !== undefined && this.#cache.expiresAt > this.#now()) {
      return this.#cache.snapshot;
    }
    const snapshot = await this.#read(signal);
    if (snapshot.available) this.#cache = { expiresAt: this.#now() + 2_000, snapshot };
    return snapshot;
  }

  async #read(signal?: AbortSignal): Promise<ProcessSnapshot> {
    if (this.#platform === "unsupported") return { available: false, processes: new Map() };
    try {
      const result = this.#platform === "win32"
        ? await this.#runner.run({
            command: "powershell.exe",
            arguments: [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress"
            ],
            timeoutMs: 4_000,
            signal,
            maximumStdoutBytes: 2 * 1024 * 1024,
            maximumStderrBytes: 16 * 1024
          })
        : await this.#runner.run({
            command: "ps",
            arguments: ["-eo", "pid=,ppid=,command="],
            timeoutMs: 1_500,
            signal,
            maximumStdoutBytes: 2 * 1024 * 1024,
            maximumStderrBytes: 16 * 1024
          });
      if (result.exitCode !== 0 || result.stdoutTruncated) return { available: false, processes: new Map() };
      const entries = this.#platform === "win32"
        ? parseWindowsProcesses(result.stdout)
        : parsePosixProcesses(result.stdout, this.#platform);
      return { available: true, processes: new Map(entries.map((entry) => [entry.pid, entry])) };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      return { available: false, processes: new Map() };
    }
  }

  #identity(
    window: Readonly<Record<string, unknown>>,
    processInfo: ProcessSnapshotEntry,
    workspaceCache: Map<string, string | undefined>
  ): Readonly<Record<string, unknown>> {
    const haystack = [window["app_name"], window["title"], processInfo.name, processInfo.command, processInfo.executable]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase();
    let kind = "unknown";
    let confidence = 0;
    const labels: string[] = [];
    if (/\b(electron|electron-forge)\b/u.test(haystack)) {
      kind = "electron-dev";
      confidence = 0.75;
      labels.push("electron");
    } else if (/\b(pnpm|npm|yarn|node|tsx|vite)\b/u.test(haystack)) {
      kind = "node-dev";
      confidence = 0.65;
      labels.push("node");
    } else if (/\b(chrome|chromium|safari|firefox|edge|msedge)\b/u.test(haystack)) {
      kind = "browser";
      confidence = 0.7;
      labels.push("browser");
    } else if (/\b(terminal|iterm|powershell|cmd\.exe|windows terminal|wt\.exe)\b/u.test(haystack)) {
      kind = "terminal";
      confidence = 0.7;
      labels.push("terminal");
    }
    const candidates = [
      processInfo.cwd,
      ...commandPaths(processInfo.command, this.#platform),
      processInfo.executable
    ].filter((value): value is string => typeof value === "string" && value.trim() !== "");
    let workspaceRoot: string | undefined;
    for (const candidate of candidates) {
      workspaceRoot = findWorkspaceRoot(candidate, this.#platform, workspaceCache, this.#pathExists);
      if (workspaceRoot !== undefined) break;
    }
    if (workspaceRoot !== undefined) labels.push("workspace");
    return {
      kind,
      confidence,
      labels,
      ...(workspaceRoot === undefined ? {} : { workspace_root: workspaceRoot })
    };
  }

  #matches(
    window: Readonly<Record<string, unknown>>,
    arguments_: Readonly<Record<string, unknown>>
  ): boolean {
    const processInfo = isRecord(window["process"]) ? window["process"] : undefined;
    const identity = isRecord(window["identity"]) ? window["identity"] : undefined;
    const query = normalizedFilter(arguments_["query"]);
    if (query !== undefined && !JSON.stringify(window).toLowerCase().includes(query)) return false;
    const processName = normalizedFilter(arguments_["process_name"]);
    if (processName !== undefined) {
      const candidates = [
        window["process_name"],
        window["app_name"],
        processInfo?.["name"],
        processInfo?.["command"],
        processInfo?.["executable"]
      ]
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase());
      if (!candidates.some((value) => value.includes(processName))) return false;
    }
    const workspaceRoot = typeof arguments_["workspace_root"] === "string"
      ? arguments_["workspace_root"].trim()
      : "";
    if (workspaceRoot !== "") {
      const candidates = [
        window["workspace_root"],
        window["cwd"],
        window["executable_path"],
        processInfo?.["cwd"],
        processInfo?.["executable"],
        identity?.["workspace_root"]
      ]
        .filter((value): value is string => typeof value === "string");
      const command = typeof processInfo?.["command"] === "string" ? processInfo["command"] : undefined;
      if (
        !candidates.some((candidate) => sameOrChildPath(candidate, workspaceRoot, this.#platform))
        && !commandContainsPath(command, workspaceRoot, this.#platform)
      ) return false;
    }
    return true;
  }
}

function parsePosixProcesses(output: string, platform: ComputerHostPlatform): readonly ProcessSnapshotEntry[] {
  const entries: ProcessSnapshotEntry[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)\s*$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const command = match[3]?.trim();
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const executable = executableFromCommand(command, platform);
    entries.push({
      pid,
      ...(Number.isSafeInteger(parentPid) && parentPid > 0 ? { parent_pid: parentPid } : {}),
      ...(executable === undefined ? {} : { name: pathApi(platform).basename(executable), executable }),
      ...(command === undefined ? {} : { command })
    });
  }
  return entries;
}

function parseWindowsProcesses(output: string): readonly ProcessSnapshotEntry[] {
  let parsed: unknown;
  try { parsed = JSON.parse(output.trim()); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const entries: ProcessSnapshotEntry[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const pid = Number(row["ProcessId"]);
    const parentPid = Number(row["ParentProcessId"]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    entries.push({
      pid,
      ...(Number.isSafeInteger(parentPid) && parentPid > 0 ? { parent_pid: parentPid } : {}),
      ...(typeof row["Name"] === "string" ? { name: row["Name"] } : {}),
      ...(typeof row["CommandLine"] === "string" ? { command: row["CommandLine"] } : {}),
      ...(typeof row["ExecutablePath"] === "string" ? { executable: row["ExecutablePath"] } : {})
    });
  }
  return entries;
}

function executableFromCommand(command: string | undefined, platform: ComputerHostPlatform): string | undefined {
  const value = command?.trim();
  if (value === undefined || value === "") return undefined;
  if (value.startsWith('"')) return value.slice(1).split('"')[0] || undefined;
  if (platform === "darwin") {
    const app = /^(\/.+?\.app\/Contents\/MacOS\/[^\s]+(?: [^\s]+)*?)(?:\s+\/|\s+-|$)/u.exec(value)?.[1];
    if (app !== undefined) return app;
  }
  return value.split(/\s+/u)[0];
}

function commandPaths(command: string | undefined, platform: ComputerHostPlatform): readonly string[] {
  if (command === undefined) return [];
  return platform === "win32"
    ? command.match(/[A-Za-z]:\\[^\s"]+/gu) ?? []
    : command.match(/\/[^\s"']+/gu) ?? [];
}

function findWorkspaceRoot(
  candidate: string,
  platform: ComputerHostPlatform,
  cache: Map<string, string | undefined>,
  pathExists: (candidate: string) => boolean
): string | undefined {
  const api = pathApi(platform);
  const normalized = api.resolve(candidate);
  if (cache.has(normalized)) return cache.get(normalized);
  let current = api.extname(normalized) !== "" ? api.dirname(normalized) : normalized;
  const fallbacks: string[] = [];
  for (let depth = 0; depth < 8; depth += 1) {
    if (pathExists(api.join(current, ".git")) || pathExists(api.join(current, "pnpm-workspace.yaml"))) {
      cache.set(normalized, current);
      return current;
    }
    if (pathExists(api.join(current, "package.json")) && !current.split(api.sep).includes("node_modules")) {
      fallbacks.push(current);
    }
    const parent = api.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const fallback = fallbacks.at(-1);
  cache.set(normalized, fallback);
  return fallback;
}

function sameOrChildPath(candidate: string, parent: string, platform: ComputerHostPlatform): boolean {
  const api = pathApi(platform);
  const normalizedCandidate = comparePath(api.resolve(candidate), platform);
  const normalizedParent = comparePath(api.resolve(parent), platform);
  if (normalizedCandidate === normalizedParent) return true;
  const child = api.relative(normalizedParent, normalizedCandidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${api.sep}`) && !api.isAbsolute(child);
}

function commandContainsPath(command: string | undefined, parent: string, platform: ComputerHostPlatform): boolean {
  if (command === undefined) return false;
  const normalizedCommand = comparePath(command, platform).replaceAll("\\", "/");
  const normalizedParent = comparePath(pathApi(platform).resolve(parent), platform).replaceAll("\\", "/");
  return normalizedCommand.includes(normalizedParent);
}

function redactProcessCommand(command: string): string {
  const redacted = command
    .replace(/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[credentials]@")
    .replace(/\b([A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|API_KEY)[A-Za-z_]*)=([^\s]+)/giu, "$1=[redacted]")
    .replace(/((?:--?|\/)(?:token|secret|password|passwd|credential|authorization|api[-_]?key)(?:=|\s+))([^\s]+)/giu, "$1[redacted]")
    .replace(/\bBearer\s+[^\s]+/giu, "Bearer [redacted]");
  return redacted.length <= 16 * 1024 ? redacted : `${redacted.slice(0, 16 * 1024 - 1)}…`;
}

function hasProcessFilter(arguments_: Readonly<Record<string, unknown>>): boolean {
  return normalizedFilter(arguments_["workspace_root"]) !== undefined
    || normalizedFilter(arguments_["process_name"]) !== undefined;
}

function normalizedFilter(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : undefined;
}

function validPid(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function pathApi(platform: ComputerHostPlatform): typeof path.posix {
  return platform === "win32" ? win32 : path.posix;
}

function comparePath(value: string, platform: ComputerHostPlatform): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
