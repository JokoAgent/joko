import os from "node:os";
import { createNodeSimulatorCommandRunner, type SimulatorCommandRunner } from "./environment.js";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const MEMORY_PRESSURE = "/usr/bin/memory_pressure";

export interface SimulatorMemorySnapshot {
  readonly source: "macos-memory-pressure" | "node-os";
  readonly freePercentage: number | null;
  readonly freeBytes: number;
  readonly totalBytes: number;
}

export class SimulatorResourceError extends Error {
  constructor(readonly code: "INVALID_ARGUMENT" | "MEMORY_PRESSURE" | "RESOURCE_LIMIT_REACHED"
    | "RESOURCE_STATE_UNKNOWN" | "MUTATION_CANCELLED", message: string) { super(message); }
}

export interface SimulatorResourceAdmission {
  readonly allowed: boolean;
  readonly reasonCode: "ADMITTED" | "MEMORY_PRESSURE" | "RESOURCE_LIMIT_REACHED";
  readonly runningCount: number;
  readonly softLimit: number;
  readonly hardLimit: number;
}

/** The same thresholds drive mutation admission and the read-only doctor projection. */
export function assessSimulatorResourceAdmission(input: {
  readonly runningCount: number;
  readonly softLimit?: number;
  readonly hardLimit?: number;
  readonly memory: SimulatorMemorySnapshot;
}): SimulatorResourceAdmission {
  const softLimit = input.softLimit ?? 2;
  const hardLimit = input.hardLimit ?? 4;
  if (!Number.isSafeInteger(input.runningCount) || input.runningCount < 0
    || !Number.isSafeInteger(softLimit) || !Number.isSafeInteger(hardLimit)
    || softLimit < 1 || hardLimit < softLimit || hardLimit > 4) {
    throw new SimulatorResourceError("INVALID_ARGUMENT", "Simulator resource state is invalid.");
  }
  const base = { runningCount: input.runningCount, softLimit, hardLimit };
  if (input.runningCount >= hardLimit) return { ...base, allowed: false, reasonCode: "RESOURCE_LIMIT_REACHED" };
  const memory = input.memory;
  if (memory.freePercentage !== null && Number.isFinite(memory.freePercentage)
    && memory.freePercentage >= 0 && memory.freePercentage <= 100) {
    const required = input.runningCount >= softLimit ? 20 : 10;
    if (memory.freePercentage >= required) return { ...base, allowed: true, reasonCode: "ADMITTED" };
  } else {
    const required = input.runningCount === 0 ? 512 * MIB
      : input.runningCount < softLimit ? 1.5 * GIB : 2.5 * GIB;
    if (Number.isSafeInteger(memory.freeBytes) && memory.freeBytes >= required) {
      return { ...base, allowed: true, reasonCode: "ADMITTED" };
    }
  }
  return { ...base, allowed: false, reasonCode: "MEMORY_PRESSURE" };
}

export function parseSimulatorMemoryFreePercentage(output: string): number | null {
  const match = /System-wide memory free percentage:\s*([0-9]+(?:\.[0-9]+)?)%/iu.exec(output);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

/** A bounded host probe; malformed or unavailable pressure output uses the conservative byte fallback. */
export async function collectSimulatorMemorySnapshot(options: {
  readonly platform?: NodeJS.Platform;
  readonly runner?: SimulatorCommandRunner;
  readonly freeBytes?: () => number;
  readonly totalBytes?: () => number;
  readonly signal?: AbortSignal;
} = {}): Promise<SimulatorMemorySnapshot> {
  const fallback = (): SimulatorMemorySnapshot => ({ source: "node-os", freePercentage: null,
    freeBytes: (options.freeBytes ?? os.freemem)(), totalBytes: (options.totalBytes ?? os.totalmem)() });
  if (options.signal?.aborted) throw new SimulatorResourceError("MUTATION_CANCELLED", "Simulator admission was cancelled.");
  if ((options.platform ?? process.platform) !== "darwin") return fallback();
  let result;
  try {
    result = await (options.runner ?? createNodeSimulatorCommandRunner()).run(MEMORY_PRESSURE, ["-Q"],
      { signal: options.signal, timeoutMs: 5_000 });
  } catch {
    if (options.signal?.aborted) throw new SimulatorResourceError("MUTATION_CANCELLED", "Simulator admission was cancelled.");
    return fallback();
  }
  if (options.signal?.aborted) throw new SimulatorResourceError("MUTATION_CANCELLED", "Simulator admission was cancelled.");
  if (result.failed || result.timedOut || result.aborted || result.outputTruncated || result.exitCode !== 0) return fallback();
  const freePercentage = parseSimulatorMemoryFreePercentage(`${result.stdout}\n${result.stderr}`);
  if (freePercentage === null) return fallback();
  return { ...fallback(), source: "macos-memory-pressure", freePercentage };
}

/** Serializes all starts and stops; actual owned device observations reset occupancy before admission. */
export class SimulatorResourceScheduler {
  readonly #softLimit: number;
  readonly #hardLimit: number;
  readonly #memoryProbe: (signal?: AbortSignal) => Promise<SimulatorMemorySnapshot>;
  readonly #running = new Set<string>();
  #tail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly softLimit?: number;
    readonly hardLimit?: number;
    readonly memoryProbe?: (signal?: AbortSignal) => Promise<SimulatorMemorySnapshot>;
  } = {}) {
    this.#softLimit = options.softLimit ?? 2;
    this.#hardLimit = options.hardLimit ?? 4;
    this.#memoryProbe = options.memoryProbe ?? (signal => collectSimulatorMemorySnapshot({ signal }));
    if (!Number.isSafeInteger(this.#softLimit) || !Number.isSafeInteger(this.#hardLimit)
      || this.#softLimit < 1 || this.#hardLimit < this.#softLimit || this.#hardLimit > 4) {
      throw new SimulatorResourceError("INVALID_ARGUMENT", "Simulator limits must satisfy 0 < soft <= hard <= 4.");
    }
  }

  snapshot(): { readonly runningCount: number; readonly softLimit: number; readonly hardLimit: number } {
    return { runningCount: this.#running.size, softLimit: this.#softLimit, hardLimit: this.#hardLimit };
  }

  runStart<T>(instanceId: string, observeRunning: (signal?: AbortSignal) => Promise<readonly string[]>,
    task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.#serialize(async () => {
      this.#requireInstanceId(instanceId);
      this.#requireActive(signal);
      await this.#reconcile(observeRunning, signal);
      this.#requireActive(signal);
      if (!this.#running.has(instanceId)) await this.#assertAdmission(signal);
      this.#requireActive(signal);
      this.#running.add(instanceId);
      try { return await task(); }
      catch (error) {
        try { await this.#reconcile(observeRunning); } catch { /* Unknown occupancy remains reserved. */ }
        throw error;
      }
    });
  }

  runStop<T>(instanceId: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.#serialize(async () => {
      this.#requireInstanceId(instanceId);
      this.#requireActive(signal);
      const value = await task();
      this.#running.delete(instanceId);
      return value;
    });
  }

  async #assertAdmission(signal?: AbortSignal): Promise<void> {
    if (this.#running.size >= this.#hardLimit) {
      throw new SimulatorResourceError("RESOURCE_LIMIT_REACHED", "This Mac is running the maximum number of Joko simulators.");
    }
    let memory: SimulatorMemorySnapshot;
    try { memory = await this.#memoryProbe(signal); }
    catch (error) {
      if (signal?.aborted) throw new SimulatorResourceError("MUTATION_CANCELLED", "Simulator admission was cancelled.");
      if (error instanceof SimulatorResourceError) throw error;
      throw new SimulatorResourceError("RESOURCE_STATE_UNKNOWN", "Simulator memory state could not be read.");
    }
    this.#requireActive(signal);
    const admission = assessSimulatorResourceAdmission({ runningCount: this.#running.size,
      softLimit: this.#softLimit, hardLimit: this.#hardLimit, memory });
    if (admission.allowed) return;
    throw new SimulatorResourceError("MEMORY_PRESSURE", "System memory pressure is too high for another Simulator.");
  }

  async #reconcile(observeRunning: (signal?: AbortSignal) => Promise<readonly string[]>, signal?: AbortSignal): Promise<void> {
    let observed: readonly string[];
    try { observed = await observeRunning(signal); }
    catch {
      if (signal?.aborted) throw new SimulatorResourceError("MUTATION_CANCELLED", "Simulator admission was cancelled.");
      throw new SimulatorResourceError("RESOURCE_STATE_UNKNOWN", "Running Simulator state could not be confirmed.");
    }
    if (!Array.isArray(observed) || observed.length > 128 || observed.some(id => typeof id !== "string" || id.length < 1 || id.length > 128)
      || new Set(observed).size !== observed.length) {
      throw new SimulatorResourceError("RESOURCE_STATE_UNKNOWN", "Running Simulator state was invalid.");
    }
    this.#running.clear();
    for (const id of observed) this.#running.add(id);
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.#tail = previous.catch(() => undefined).then(() => gate);
    return previous.catch(() => undefined).then(task).finally(release);
  }

  #requireInstanceId(instanceId: string): void {
    if (typeof instanceId !== "string" || instanceId.length < 1 || instanceId.length > 128
      || instanceId.trim() !== instanceId) {
      throw new SimulatorResourceError("INVALID_ARGUMENT", "Simulator instance identity is invalid.");
    }
  }

  #requireActive(signal?: AbortSignal): void {
    if (signal?.aborted) throw new SimulatorResourceError("MUTATION_CANCELLED", "Simulator admission was cancelled.");
  }
}
