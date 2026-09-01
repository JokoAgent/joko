import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PiManagedProcessTermination = "not_running" | "terminated" | "identity_mismatch" | "unconfirmed";

export interface PiManagedProcessRoot {
  readonly pid: number;
  readonly expectedIdentity: string;
}

export interface PiManagedProcessUsage {
  readonly pid: number;
  readonly cpuPercent: number;
  readonly memoryKb: number;
  readonly processCount: number;
}

/** Internal process-table row. Paths and command lines never leave the Adapter. */
export interface PiProcessTableRow {
  readonly pid: number;
  readonly ppid: number;
  readonly state: string | null;
  readonly commandLower: string;
  readonly memoryKb: number;
  readonly cpuPercent: number | null;
  readonly cpuTimeMs: number | null;
  readonly startIdentity: string | null;
}

export interface PiProcessTableSnapshot {
  readonly rows: readonly PiProcessTableRow[];
  readonly childrenByParent: ReadonlyMap<number, readonly number[]>;
}

/**
 * Captures an OS process birth identity, samples only registered roots, and
 * terminates only the exact process instance named by the caller's fence.
 */
export interface PiManagedProcessSupervisor {
  capture(pid: number): Promise<string | undefined>;
  /** Synchronous birth proof for custom spawners before a child handle escapes. */
  captureSync(pid: number): string | undefined;
  inspect?(roots: readonly PiManagedProcessRoot[]): Promise<readonly PiManagedProcessUsage[]>;
  terminate(pid: number, expectedIdentity: string, timeoutMs: number): Promise<PiManagedProcessTermination>;
}

export interface PiManagedProcessSupervisorOptions {
  readonly platform?: NodeJS.Platform;
  readonly captureIdentity?: (pid: number) => Promise<string | undefined>;
  readonly captureIdentitySync?: (pid: number) => string | undefined;
  readonly scan?: () => Promise<PiProcessTableSnapshot>;
  readonly scanSync?: () => PiProcessTableSnapshot;
  readonly signal?: (pid: number, signal: NodeJS.Signals) => void;
  readonly killWindowsTree?: (pid: number, timeoutMs: number) => boolean;
  readonly now?: () => number;
  readonly scanIntervalMs?: number;
}

export function createDefaultPiManagedProcessSupervisor(
  options: PiManagedProcessSupervisorOptions = {}
): PiManagedProcessSupervisor {
  const platform = options.platform ?? process.platform;
  const capture = options.captureIdentity ?? ((pid) => captureProcessIdentity(pid, platform));
  const captureSync = options.captureIdentitySync ?? ((pid) => captureProcessIdentitySync(pid, platform));
  const scan = options.scan ?? (() => scanProcessTable(platform));
  const scanSync = options.scanSync ?? (() => scanProcessTableSync(platform));
  const signal = options.signal ?? ((pid, processSignal) => process.kill(pid, processSignal));
  const killWindowsTree = options.killWindowsTree ?? ((pid, timeoutMs) => {
    try {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: Math.max(1_000, timeoutMs),
        stdio: "ignore"
      });
      return true;
    } catch {
      return false;
    }
  });
  const now = options.now ?? Date.now;
  const scanIntervalMs = options.scanIntervalMs ?? 5_000;
  if (!Number.isFinite(scanIntervalMs) || scanIntervalMs < 0) {
    throw new Error("Process scan interval must be a finite non-negative number.");
  }
  const previousCpuTimes = new Map<number, {
    readonly at: number;
    readonly cpuTimeMs: number;
    readonly startIdentity: string | null;
  }>();
  const computedCpuPercent = new Map<number, number>();
  let cachedSnapshot: PiProcessTableSnapshot | undefined;
  let cachedAt = Number.NEGATIVE_INFINITY;
  let scanInFlight: Promise<PiProcessTableSnapshot> | undefined;

  const refreshSnapshot = async (): Promise<PiProcessTableSnapshot> => {
    if (cachedSnapshot !== undefined && now() - cachedAt < scanIntervalMs) return cachedSnapshot;
    scanInFlight ??= scan().then((snapshot) => {
      const capturedAt = now();
      const alive = new Set<number>();
      for (const row of snapshot.rows) {
        alive.add(row.pid);
        if (row.cpuPercent !== null) {
          computedCpuPercent.set(row.pid, safeMetric(row.cpuPercent));
          continue;
        }
        if (row.cpuTimeMs === null) {
          computedCpuPercent.delete(row.pid);
          continue;
        }
        const previous = previousCpuTimes.get(row.pid);
        const percent = previous !== undefined
          && previous.startIdentity === row.startIdentity
          && capturedAt > previous.at
          && row.cpuTimeMs >= previous.cpuTimeMs
          ? ((row.cpuTimeMs - previous.cpuTimeMs) / (capturedAt - previous.at)) * 100
          : 0;
        computedCpuPercent.set(row.pid, safeMetric(percent));
        previousCpuTimes.set(row.pid, {
          at: capturedAt,
          cpuTimeMs: row.cpuTimeMs,
          startIdentity: row.startIdentity
        });
      }
      for (const pid of computedCpuPercent.keys()) {
        if (!alive.has(pid)) computedCpuPercent.delete(pid);
      }
      for (const pid of previousCpuTimes.keys()) {
        if (!alive.has(pid)) previousCpuTimes.delete(pid);
      }
      cachedSnapshot = snapshot;
      cachedAt = capturedAt;
      return snapshot;
    }).finally(() => {
      scanInFlight = undefined;
    });
    return scanInFlight;
  };

  return {
    capture,
    captureSync,
    async inspect(roots) {
      if (roots.length === 0) return [];
      const snapshot = await refreshSnapshot();
      const rowByPid = new Map(snapshot.rows.map((row) => [row.pid, row] as const));

      const result: PiManagedProcessUsage[] = [];
      for (const root of roots) {
        const currentIdentity = await capture(root.pid).catch(() => undefined);
        if (currentIdentity === undefined || currentIdentity !== root.expectedIdentity) continue;
        if (!rowByPid.has(root.pid)) continue;
        let cpuPercent = 0;
        let memoryKb = 0;
        let processCount = 0;
        for (const pid of collectDescendants(root.pid, snapshot.childrenByParent)) {
          const row = rowByPid.get(pid);
          if (row === undefined) continue;
          cpuPercent += computedCpuPercent.get(pid) ?? 0;
          memoryKb += safeMetric(row.memoryKb);
          if (!isOperatingSystemHelper(row.commandLower)) processCount += 1;
        }
        result.push({
          pid: root.pid,
          cpuPercent: safeMetric(cpuPercent),
          memoryKb: Math.round(safeMetric(memoryKb)),
          processCount
        });
      }
      return result;
    },
    async terminate(pid, expectedIdentity, timeoutMs) {
      if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
        return "identity_mismatch";
      }
      let current: string | undefined;
      try {
        current = captureSync(pid);
      } catch {
        return "unconfirmed";
      }
      if (current === undefined) return "not_running";
      if (current !== expectedIdentity) return "identity_mismatch";

      if (platform === "win32") {
        // The synchronous identity check and tree termination run in one JS
        // turn. The owning Node child handle cannot be reaped in between.
        if (captureSync(pid) !== expectedIdentity) return "identity_mismatch";
        if (!killWindowsTree(pid, timeoutMs)) {
          const afterFailure = await capture(pid).catch(() => undefined);
          if (afterFailure === undefined) return "terminated";
          return afterFailure === expectedIdentity ? "unconfirmed" : "identity_mismatch";
        }
      } else {
        let outcome: PiManagedProcessTermination;
        try {
          outcome = terminateFrozenPosixTree({
            rootPid: pid,
            expectedIdentity,
            captureIdentitySync: captureSync,
            scan: scanSync,
            signal
          });
        } catch {
          const afterFailure = await capture(pid).catch(() => undefined);
          if (afterFailure === undefined) return "terminated";
          return afterFailure === expectedIdentity ? "unconfirmed" : "identity_mismatch";
        }
        if (outcome !== "terminated") return outcome;
      }

      return await waitForIdentityToDisappear(pid, expectedIdentity, timeoutMs, capture)
        ? "terminated"
        : "unconfirmed";
    }
  };
}

interface FrozenPosixOptions {
  readonly rootPid: number;
  readonly expectedIdentity: string;
  readonly captureIdentitySync: (pid: number) => string | undefined;
  readonly scan: () => PiProcessTableSnapshot;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
}

interface FrozenIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly startIdentity: string;
  readonly root: boolean;
}

/** Freeze parent-to-child, then kill child-to-parent without a PID-reuse gap. */
export function terminateFrozenPosixTree(options: FrozenPosixOptions): PiManagedProcessTermination {
  const first = options.scan();
  const firstRoot = first.rows.find((row) => row.pid === options.rootPid);
  if (firstRoot === undefined || firstRoot.startIdentity === null) return "not_running";
  if (options.captureIdentitySync(options.rootPid) !== options.expectedIdentity) return "identity_mismatch";

  const stopped: number[] = [];
  const resumeOnFailure: number[] = [];
  const seen = new Set<number>([options.rootPid]);
  let completed = false;
  try {
    try {
      options.signal(options.rootPid, "SIGSTOP");
    } catch (error) {
      if (isMissingProcessError(error)) return "not_running";
      throw error;
    }
    stopped.push(options.rootPid);
    if (!isStoppedOrZombie(firstRoot.state)) resumeOnFailure.push(options.rootPid);

    let frontier: FrozenIdentity[] = [{
      pid: options.rootPid,
      ppid: firstRoot.ppid,
      startIdentity: firstRoot.startIdentity,
      root: true
    }];
    while (frontier.length > 0) {
      const currentIdentity = options.captureIdentitySync(options.rootPid);
      if (currentIdentity === undefined) return "not_running";
      if (currentIdentity !== options.expectedIdentity) {
        // The PID now identifies another process. Never signal it again.
        const rootIndex = resumeOnFailure.indexOf(options.rootPid);
        if (rootIndex >= 0) resumeOnFailure.splice(rootIndex, 1);
        return "identity_mismatch";
      }
      const snapshot = options.scan();
      const rowsByPid = new Map(snapshot.rows.map((row) => [row.pid, row] as const));
      const next: FrozenIdentity[] = [];
      for (const expected of frontier) {
        const row = rowsByPid.get(expected.pid);
        if (
          row === undefined
          || row.startIdentity !== expected.startIdentity
          || (!expected.root && row.ppid !== expected.ppid)
        ) throw new Error("A frozen process changed identity before confirmation.");
        if (!isStoppedOrZombie(row.state)) throw new Error("A process did not enter the stopped state.");
      }
      for (const parent of frontier) {
        for (const childPid of snapshot.childrenByParent.get(parent.pid) ?? []) {
          if (seen.has(childPid)) continue;
          const child = rowsByPid.get(childPid);
          if (child === undefined || child.ppid !== parent.pid || child.startIdentity === null) {
            throw new Error("A child process could not be identity-fenced.");
          }
          try {
            options.signal(childPid, "SIGSTOP");
          } catch (error) {
            if (isMissingProcessError(error)) {
              throw new Error("A child exited before its descendants could be frozen.");
            }
            throw error;
          }
          seen.add(childPid);
          stopped.push(childPid);
          if (!isStoppedOrZombie(child.state)) resumeOnFailure.push(childPid);
          next.push({
            pid: childPid,
            ppid: parent.pid,
            startIdentity: child.startIdentity,
            root: false
          });
          if (seen.size > 16_384) throw new Error("The process tree exceeded the safety limit.");
        }
      }
      frontier = next;
    }

    for (let index = stopped.length - 1; index >= 0; index -= 1) {
      try {
        options.signal(stopped[index]!, "SIGKILL");
      } catch (error) {
        if (!isMissingProcessError(error)) throw error;
      }
    }
    completed = true;
    return "terminated";
  } finally {
    if (!completed) {
      const failures: unknown[] = [];
      for (let index = resumeOnFailure.length - 1; index >= 0; index -= 1) {
        try {
          options.signal(resumeOnFailure[index]!, "SIGCONT");
        } catch (error) {
          if (!isMissingProcessError(error)) failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "Failed to recover frozen processes.");
    }
  }
}

export function parsePosixProcessTable(output: string): PiProcessTableSnapshot {
  const rows: PiProcessTableRow[] = [];
  const pattern = /^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u;
  for (const raw of output.split(/\r?\n/u)) {
    const match = raw.trim().match(pattern);
    if (match === null) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const ppid = Number.parseInt(match[2]!, 10);
    const cpuPercent = Number.parseFloat(match[4]!);
    const memoryKb = Number.parseInt(match[5]!, 10);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    rows.push({
      pid,
      ppid,
      state: match[3]!,
      commandLower: match[7]!.toLowerCase(),
      memoryKb: safeMetric(memoryKb),
      cpuPercent: safeMetric(cpuPercent),
      cpuTimeMs: null,
      startIdentity: match[6]!.replace(/\s+/gu, " ")
    });
  }
  return snapshotOf(rows);
}

export function parseWindowsProcessTable(output: string): PiProcessTableSnapshot {
  const rows: PiProcessTableRow[] = [];
  for (const raw of output.split(/\r?\n/u)) {
    const fields = raw.trim().split("|");
    if (fields.length < 6) continue;
    const pid = Number.parseInt(fields[0] ?? "", 10);
    const ppid = Number.parseInt(fields[1] ?? "", 10);
    const workingSetBytes = Number.parseInt(fields[2] ?? "", 10);
    const cpuTime100ns = Number.parseInt(fields[3] ?? "", 10);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    rows.push({
      pid,
      ppid,
      state: null,
      commandLower: fields.slice(5).join("|").toLowerCase(),
      memoryKb: Number.isFinite(workingSetBytes) ? Math.round(workingSetBytes / 1024) : 0,
      cpuPercent: null,
      cpuTimeMs: Number.isFinite(cpuTime100ns) ? cpuTime100ns / 10_000 : null,
      startIdentity: fields[4]?.trim() || null
    });
  }
  return snapshotOf(rows);
}

function snapshotOf(rows: readonly PiProcessTableRow[]): PiProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid);
    if (children === undefined) childrenByParent.set(row.ppid, [row.pid]);
    else children.push(row.pid);
  }
  return { rows, childrenByParent };
}

function collectDescendants(
  rootPid: number,
  childrenByParent: ReadonlyMap<number, readonly number[]>
): readonly number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  const pending = [rootPid];
  while (pending.length > 0 && seen.size <= 16_384) {
    const pid = pending.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    result.push(pid);
    for (const child of childrenByParent.get(pid) ?? []) pending.push(child);
  }
  return result;
}

const POSIX_PS_ARGS = ["-Aww", "-o", "pid=,ppid=,stat=,%cpu=,rss=,lstart=,command="] as const;
const WINDOWS_SCAN_SCRIPT = [
  "Get-CimInstance Win32_Process |",
  "ForEach-Object {",
  "  $cmd = ([string]$_.CommandLine) -replace \"`r|`n\", \" \"",
  "  $created = if ($null -eq $_.CreationDate) { \"\" } else { $_.CreationDate.ToUniversalTime().Ticks }",
  "  Write-Output (\"{0}|{1}|{2}|{3}|{4}|{5}\" -f $_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, ($_.UserModeTime + $_.KernelModeTime), $created, $cmd)",
  "}"
].join("\n");

async function scanProcessTable(platform: NodeJS.Platform): Promise<PiProcessTableSnapshot> {
  if (platform === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCAN_SCRIPT
    ], { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    return parseWindowsProcessTable(stdout);
  }
  const { stdout } = await execFileAsync("ps", [...POSIX_PS_ARGS], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC0" }
  });
  return parsePosixProcessTable(stdout);
}

function scanProcessTableSync(platform: NodeJS.Platform): PiProcessTableSnapshot {
  if (platform === "win32") {
    const stdout = execFileSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCAN_SCRIPT
    ], { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    return parseWindowsProcessTable(stdout);
  }
  const stdout = execFileSync("ps", [...POSIX_PS_ARGS], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC0" }
  });
  return parsePosixProcessTable(stdout);
}

async function captureProcessIdentity(pid: number, platform: NodeJS.Platform): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    if (platform === "linux") {
      const [stat, executable, bootId] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readlink(`/proc/${pid}/exe`),
        readFile("/proc/sys/kernel/random/boot_id", "utf8")
      ]);
      return linuxIdentity(stat, executable, bootId);
    }
    return capturePortableIdentity(pid, platform);
  } catch (error) {
    return identityFailure(error);
  }
}

function captureProcessIdentitySync(pid: number, platform: NodeJS.Platform): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    if (platform === "linux") {
      return linuxIdentity(
        readFileSync(`/proc/${pid}/stat`, "utf8"),
        readlinkSync(`/proc/${pid}/exe`),
        readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
      );
    }
    return capturePortableIdentitySync(pid, platform);
  } catch (error) {
    return identityFailure(error);
  }
}

function linuxIdentity(stat: string, executable: string, bootId: string): string | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const suffix = stat.slice(close + 2).trim().split(/\s+/u);
  const startTime = suffix[19];
  if (startTime === undefined || !/^\d+$/u.test(startTime)) return undefined;
  return digestIdentity(`${bootId.trim()}\0${startTime}\0${executable}`);
}

async function capturePortableIdentity(pid: number, platform: NodeJS.Platform): Promise<string | undefined> {
  if (platform === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", portableWindowsIdentityArgs(pid), {
      encoding: "utf8", windowsHide: true, timeout: 5_000
    });
    return stdout.trim() === "" ? undefined : digestIdentity(stdout.trim());
  }
  const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
    encoding: "utf8", windowsHide: true, timeout: 5_000
  });
  return stdout.trim() === "" ? undefined : digestIdentity(stdout.trim());
}

function capturePortableIdentitySync(pid: number, platform: NodeJS.Platform): string | undefined {
  const stdout = platform === "win32"
    ? execFileSync("powershell.exe", portableWindowsIdentityArgs(pid), {
        encoding: "utf8", windowsHide: true, timeout: 5_000
      })
    : execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
        encoding: "utf8", windowsHide: true, timeout: 5_000
      });
  return stdout.trim() === "" ? undefined : digestIdentity(stdout.trim());
}

function portableWindowsIdentityArgs(pid: number): readonly string[] {
  const script = [
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "if ($null -eq $p) { exit 3 }",
    "[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks.ToString() + '|' + $p.Path)"
  ].join("; ");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
}

function identityFailure(error: unknown): undefined {
  if (isMissingProcessError(error)) return undefined;
  const exitCode = (error as { code?: unknown }).code;
  if (exitCode === 1 || exitCode === 3) return undefined;
  throw error;
}

async function waitForIdentityToDisappear(
  pid: number,
  expectedIdentity: string,
  timeoutMs: number,
  capture: (pid: number) => Promise<string | undefined>
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    const identity = await capture(pid);
    if (identity === undefined || identity !== expectedIdentity) return true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 25);
      timer.unref?.();
    });
  } while (Date.now() < deadline);
  return false;
}

function digestIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeMetric(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isOperatingSystemHelper(commandLower: string): boolean {
  return /(?:^|[\\/])conhost\.exe(?:\s|$)/iu.test(commandLower);
}

function isStoppedOrZombie(state: string | null): boolean {
  return state !== null && /^[TZ]/u.test(state);
}

function isMissingProcessError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ESRCH";
}
