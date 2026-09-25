import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { createWdaBuildPlan, createWdaOwnerFingerprint, type WdaBuildPlanOptions, type WdaCommandPlan } from "./wda-build-plan.js";

const MAX_LOG_BYTES = 256 * 1024;
const SIGNAL_STEPS = [
  { signal: "SIGINT", waitMs: 5_000 },
  { signal: "SIGTERM", waitMs: 1_000 },
  { signal: "SIGKILL", waitMs: 500 }
] as const;

export type WdaProcessErrorCode = "UNSUPPORTED_PLATFORM" | "INVALID_CONFIGURATION" | "CANCELLED" |
  "BUILD_TIMEOUT" | "BUILD_FAILED" | "START_FAILED" | "STOP_FAILED";

export class WdaProcessError extends Error {
  constructor(readonly code: WdaProcessErrorCode, message: string) { super(message); }
}

export interface WdaProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnFailed: boolean;
}

export interface WdaProcessGroupControl {
  signal(pid: number, signal: NodeJS.Signals): void;
  isAlive(pid: number): boolean;
}

export interface WdaProcessClock { now(): number; sleep(ms: number): Promise<void> }

export interface WdaProcessExecutorOptions extends Omit<WdaBuildPlanOptions, "ownerFingerprint"> {
  readonly cacheRoot: string;
  readonly instanceId: string;
  readonly platform?: NodeJS.Platform;
  readonly buildTimeoutMs?: number;
  readonly spawnProcess?: (plan: WdaCommandPlan) => ChildProcess;
  readonly group?: WdaProcessGroupControl;
  readonly clock?: WdaProcessClock;
}

function nodeGroupControl(): WdaProcessGroupControl {
  return {
    signal(pid, signal) {
      try { process.kill(-pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    },
    isAlive(pid) {
      try { process.kill(-pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    }
  };
}

function spawnNodeWdaProcess(plan: WdaCommandPlan): ChildProcess {
  return spawn(plan.command, [...plan.args], { cwd: plan.cwd, env: { ...plan.env },
    shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

export class WdaManagedChild {
  readonly pid: number;
  readonly exited: Promise<WdaProcessExit>;
  readonly #group: WdaProcessGroupControl;
  readonly #clock: WdaProcessClock;
  #stopPromise: Promise<void> | undefined;
  #log = Buffer.alloc(0);
  #settled = false;

  constructor(child: ChildProcess, group: WdaProcessGroupControl, clock: WdaProcessClock, signal?: AbortSignal) {
    this.pid = child.pid ?? 0;
    this.#group = group;
    this.#clock = clock;
    let resolveExit!: (value: WdaProcessExit) => void;
    this.exited = new Promise<WdaProcessExit>(resolve => { resolveExit = resolve; });
    const settle = (value: WdaProcessExit): void => {
      if (this.#settled) return;
      this.#settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolveExit(value);
    };
    const onAbort = (): void => { void this.stop().catch(() => undefined); };
    const append = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.#log = Buffer.concat([this.#log, bytes]).subarray(-MAX_LOG_BYTES);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", () => settle({ code: null, signal: null, spawnFailed: true }));
    child.once("close", (code, exitSignal) => settle({ code, signal: exitSignal, spawnFailed: false }));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  }

  get bufferedLogBytes(): number { return this.#log.length; }
  get isExited(): boolean { return this.#settled; }

  async stop(): Promise<void> {
    this.#stopPromise ??= this.#stopGroup();
    const operation = this.#stopPromise;
    try { await operation; }
    catch (error) {
      if (this.#stopPromise === operation) this.#stopPromise = undefined;
      throw error;
    }
  }

  async #stopGroup(): Promise<void> {
    if (this.pid <= 0) return;
    for (const step of SIGNAL_STEPS) {
      if (!this.#group.isAlive(this.pid)) return;
      try { this.#group.signal(this.pid, step.signal); }
      catch { throw new WdaProcessError("STOP_FAILED", "Owned driver process could not be stopped."); }
      const deadline = this.#clock.now() + step.waitMs;
      while (this.#group.isAlive(this.pid) && this.#clock.now() < deadline) {
        await this.#clock.sleep(Math.min(25, deadline - this.#clock.now()));
      }
    }
    if (this.#group.isAlive(this.pid)) throw new WdaProcessError("STOP_FAILED", "Owned driver process did not exit.");
  }
}

/** Build and launch execution boundary. Durable admission and recovery belong to the caller. */
export class WdaProcessExecutor {
  readonly #platform: NodeJS.Platform;
  readonly #buildTimeoutMs: number;
  readonly #spawnProcess: (plan: WdaCommandPlan) => ChildProcess;
  readonly #group: WdaProcessGroupControl;
  readonly #clock: WdaProcessClock;
  readonly #plan: ReturnType<typeof createWdaBuildPlan>;
  #pendingBuild: WdaManagedChild | undefined;

  constructor(options: WdaProcessExecutorOptions) {
    this.#platform = options.platform ?? process.platform;
    this.#buildTimeoutMs = options.buildTimeoutMs ?? 10 * 60_000;
    if (!Number.isSafeInteger(this.#buildTimeoutMs) || this.#buildTimeoutMs < 1 || this.#buildTimeoutMs > 20 * 60_000) {
      throw new WdaProcessError("INVALID_CONFIGURATION", "Driver build timeout is invalid.");
    }
    let ownerFingerprint: string;
    try { ownerFingerprint = createWdaOwnerFingerprint(options); }
    catch { throw new WdaProcessError("INVALID_CONFIGURATION", "Driver owner identity is invalid."); }
    try { this.#plan = createWdaBuildPlan({ ...options, ownerFingerprint }); }
    catch { throw new WdaProcessError("INVALID_CONFIGURATION", "Driver build plan is invalid."); }
    this.#spawnProcess = options.spawnProcess ?? spawnNodeWdaProcess;
    this.#group = options.group ?? nodeGroupControl();
    this.#clock = options.clock ?? { now: () => performance.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
  }

  #start(plan: WdaCommandPlan, signal?: AbortSignal): WdaManagedChild {
    if (this.#platform !== "darwin") throw new WdaProcessError("UNSUPPORTED_PLATFORM", "Driver requires local macOS.");
    if (signal?.aborted) throw new WdaProcessError("CANCELLED", "Driver operation was cancelled.");
    let child: ChildProcess;
    try { child = this.#spawnProcess(plan); }
    catch { throw new WdaProcessError("START_FAILED", "Driver process could not be started."); }
    const managed = new WdaManagedChild(child, this.#group, this.#clock, signal);
    if (managed.pid <= 0) throw new WdaProcessError("START_FAILED", "Driver process did not obtain an identity.");
    return managed;
  }

  /** Build is one owned child process; failures and cancellation retire its entire group. */
  async build(signal?: AbortSignal): Promise<void> {
    const child = this.#start(this.#plan.build, signal);
    this.#pendingBuild = child;
    let timeout!: ReturnType<typeof setTimeout>;
    let onAbort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new WdaProcessError("CANCELLED", "Driver build was cancelled."));
      signal?.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => reject(new WdaProcessError("BUILD_TIMEOUT", "Driver build timed out.")), this.#buildTimeoutMs);
      if (signal?.aborted) onAbort();
    });
    try {
      const result = await Promise.race([child.exited, interrupted]);
      if (signal?.aborted) throw new WdaProcessError("CANCELLED", "Driver build was cancelled.");
      if (result.spawnFailed || result.code !== 0) throw new WdaProcessError("BUILD_FAILED", "Driver build failed.");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      await child.stop();
      if (this.#pendingBuild === child) this.#pendingBuild = undefined;
    }
  }

  async retryPendingBuildCleanup(): Promise<void> {
    const child = this.#pendingBuild;
    if (!child) return;
    await child.stop();
    if (this.#pendingBuild === child) this.#pendingBuild = undefined;
  }

  /** The caller observes health and owns stop; no new Session is created here. */
  launch(signal?: AbortSignal): WdaManagedChild { return this.#start(this.#plan.launch, signal); }
}
