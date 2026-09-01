import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";

import { redactSecrets } from "@joko/core";
import { safeComputerEnvironment } from "@joko/tool-computer";

const OUTPUT_CAP_BYTES = 8 * 1024;
const FORCE_SETTLE_MS = 1_000;
const NODE_ALIAS = /^joko-node\s+/u;

export interface SchedulePreRunHookPayload {
  readonly event: "schedule-pre-run";
  readonly scheduleId: string;
  readonly scheduleName: string;
  readonly runId: string;
  readonly firedAt: number;
  readonly workingDir?: string;
  readonly lastFinishedAt?: number;
}

export interface SchedulePreRunHookInput {
  readonly command: string;
  /** Missing, non-finite, or non-positive means no timeout. */
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly stdinPayload: SchedulePreRunHookPayload;
  readonly now?: () => number;
}

export type SchedulePreRunHookStatus = "passed" | "skipped" | "failed" | "timed_out" | "aborted";
export type SchedulePreRunHookDecision = "run" | "skip" | "block";

export interface SchedulePreRunHookResult {
  readonly status: SchedulePreRunHookStatus;
  readonly decision: SchedulePreRunHookDecision;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly spawnError?: string;
  readonly error?: string;
}

export function resolveSchedulePreRunHookTimeout(timeoutMs: number | undefined): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  return Math.floor(timeoutMs);
}

/** Resolve a stable runtime alias without persisting the installation-specific executable path. */
export function resolveScheduleHookCommand(command: string): {
  readonly command: string;
  readonly environment: Readonly<Record<string, string>>;
} {
  const trimmed = command.trim();
  if (!NODE_ALIAS.test(trimmed)) return { command, environment: {} };
  return {
    command: `"${process.execPath}" ${trimmed.replace(NODE_ALIAS, "")}`,
    environment: process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }
  };
}

/**
 * Execute the language-neutral gate protocol. Process failures always become
 * a block result; only an exit code of zero can allow the scheduled run.
 */
export async function executeSchedulePreRunHook(
  input: SchedulePreRunHookInput
): Promise<SchedulePreRunHookResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  if (input.signal?.aborted === true) return abortedResult(0);
  const command = boundedCommand(input.command);
  const timeoutMs = resolveSchedulePreRunHookTimeout(input.timeoutMs);
  const stdin = JSON.stringify(input.stdinPayload);
  const resolved = resolveScheduleHookCommand(command);

  return new Promise<SchedulePreRunHookResult>((resolve) => {
    const stdout = new BoundedText(OUTPUT_CAP_BYTES);
    const stderr = new BoundedText(OUTPUT_CAP_BYTES);
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const finish = (exitCode: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      input.signal?.removeEventListener("abort", onAbort);
      const status: SchedulePreRunHookStatus = aborted
        ? "aborted"
        : timedOut
          ? "timed_out"
          : spawnError !== undefined
            ? "failed"
            : exitCode === 0
              ? "passed"
              : exitCode === 2
                ? "skipped"
                : "failed";
      const normalizedSpawnError = spawnError === undefined
        ? undefined
        : redactSecrets(spawnError).slice(0, 2_048);
      const error = normalizedSpawnError ?? (
        timedOut
          ? `Pre-run hook timed out after ${timeoutMs ?? 0}ms.`
          : !aborted && exitCode === null
            ? "Pre-run hook exited without a valid result."
            : undefined
      );
      resolve({
        status,
        decision: status === "passed" ? "run" : status === "skipped" ? "skip" : "block",
        exitCode,
        durationMs: Math.max(0, now() - startedAt),
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
        aborted,
        ...(normalizedSpawnError === undefined ? {} : { spawnError: normalizedSpawnError }),
        ...(error === undefined ? {} : { error })
      });
    };

    const terminate = (): void => {
      stopProcessTree(child, () => {
        if (settled) return;
        forceTimer = setTimeout(() => finish(null), FORCE_SETTLE_MS);
        forceTimer.unref?.();
      });
    };
    const onAbort = (): void => {
      aborted = true;
      terminate();
    };

    try {
      child = spawn(resolved.command, {
        shell: true,
        cwd: input.cwd?.trim() || homedir(),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: {
          ...safeComputerEnvironment(process.env),
          ...resolved.environment
        }
      });
    } catch (error) {
      finish(null, error instanceof Error ? error.message : "Pre-run hook could not start.");
      return;
    }

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      timer.unref?.();
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted === true) onAbort();
    child.stdout?.on("data", (chunk: Buffer | string) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk));
    child.once("error", (error) => finish(null, error.message));
    child.once("close", (exitCode) => finish(exitCode));
    child.stdin?.on("error", () => undefined);
    try {
      child.stdin?.end(stdin);
    } catch {
      // A gate that exits immediately may close stdin before the payload write.
    }
  });
}

export function schedulePreRunSkipSummary(result: SchedulePreRunHookResult): string {
  const prefix = `Pre-run hook exit ${result.exitCode ?? "?"} — ${result.durationMs}ms`;
  const line = result.stdout.trim().split(/\r?\n/u, 1)[0] ?? "";
  if (line === "") return prefix;
  return `${prefix} — ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`;
}

export function schedulePreRunFailureSummary(result: SchedulePreRunHookResult): string {
  if (result.status === "timed_out") return result.error ?? "Pre-run hook timed out.";
  if (result.error !== undefined) return `Pre-run hook failed: ${result.error}`;
  return `Pre-run hook failed with exit code ${result.exitCode ?? "unknown"}.`;
}

/** Strip command output before the result crosses a durable persistence boundary. */
export function durableSchedulePreRunHookResult(
  result: SchedulePreRunHookResult
): Omit<SchedulePreRunHookResult, "stdout" | "stderr" | "spawnError"> & {
  readonly stdoutSummary?: string;
  readonly stderrSummary?: string;
} {
  const stdoutSummary = singleLine(redactHookOutput(result.stdout), 512);
  const stderrSummary = singleLine(redactHookOutput(result.stderr), 512);
  return {
    status: result.status,
    decision: result.decision,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    timedOut: result.timedOut,
    aborted: result.aborted,
    ...(result.error === undefined ? {} : { error: redactHookOutput(result.error).slice(0, 2_048) }),
    ...(stdoutSummary === "" ? {} : { stdoutSummary }),
    ...(stderrSummary === "" ? {} : { stderrSummary })
  };
}

function boundedCommand(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 32_768 || value.includes("\0")) {
    throw new TypeError("Pre-run hook command is invalid.");
  }
  return value;
}

function abortedResult(durationMs: number): SchedulePreRunHookResult {
  return {
    status: "aborted",
    decision: "block",
    exitCode: null,
    durationMs,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: true
  };
}

function stopProcessTree(child: ChildProcess | undefined, complete: () => void): void {
  const pid = child?.pid;
  const stopDirect = (): void => {
    try {
      child?.kill("SIGKILL");
    } catch {
      // A concurrently exiting process needs no further action.
    }
  };
  if (pid === undefined) {
    stopDirect();
    complete();
    return;
  }
  if (process.platform === "win32") {
    let killer: ChildProcess;
    try {
      killer = spawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore"
      });
    } catch {
      stopDirect();
      complete();
      return;
    }
    killer.once("error", () => {
      stopDirect();
      complete();
    });
    killer.once("close", (code) => {
      if (code !== 0) stopDirect();
      complete();
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    stopDirect();
  }
  complete();
}

function singleLine(value: string, maximum: number): string {
  const line = value.replace(/[\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim();
  return line.length <= maximum ? line : `${line.slice(0, maximum - 1)}…`;
}

function redactHookOutput(value: string): string {
  return redactSecrets(value).replace(
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|cookie|credentials?)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
    "$1=[REDACTED]"
  );
}

class BoundedText {
  readonly #maximumBytes: number;
  readonly #chunks: Buffer[] = [];
  #byteLength = 0;
  truncated = false;

  constructor(maximumBytes: number) {
    this.#maximumBytes = maximumBytes;
  }

  append(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    const remaining = this.#maximumBytes - this.#byteLength;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.byteLength <= remaining) {
      this.#chunks.push(chunk);
      this.#byteLength += chunk.byteLength;
      return;
    }
    this.#chunks.push(chunk.subarray(0, remaining));
    this.#byteLength += remaining;
    this.truncated = true;
  }

  text(): string {
    return Buffer.concat(this.#chunks, this.#byteLength).toString("utf8");
  }
}
