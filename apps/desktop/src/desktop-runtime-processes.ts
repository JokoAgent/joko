import {
  RUNTIME_PROCESS_MONITOR_MAX_DESKTOP_PROCESSES,
  type DesktopRuntimeProcessMetric,
  type DesktopRuntimeProcessRole,
  type DesktopRuntimeProcessSample
} from "./runtime-process-monitor.js";

export const DESKTOP_RUNTIME_PROCESS_SAMPLE_CACHE_MS = 1_000;

/** The exact app.getAppMetrics() fields consumed by the diagnostics owner. */
export interface ElectronRuntimeProcessMetric {
  readonly pid: number;
  readonly type: string;
  readonly serviceName?: string;
  readonly name?: string;
  readonly cpu?: { readonly percentCPUUsage?: number };
  readonly memory?: { readonly workingSetSize?: number };
}

export interface DesktopRuntimeProcessSamplerOptions {
  readonly getMetrics: () => readonly ElectronRuntimeProcessMetric[];
  readonly describeRenderer: (pid: number) => string | null;
  readonly now?: () => number;
  readonly cacheMs?: number;
}

/**
 * Main-owned sampler. Caching makes simultaneous embedded/standalone reads share
 * one Electron CPU observation instead of shortening each other's sample window.
 */
export class DesktopRuntimeProcessSampler {
  readonly #getMetrics: DesktopRuntimeProcessSamplerOptions["getMetrics"];
  readonly #describeRenderer: DesktopRuntimeProcessSamplerOptions["describeRenderer"];
  readonly #now: NonNullable<DesktopRuntimeProcessSamplerOptions["now"]>;
  readonly #cacheMs: number;
  #cached: DesktopRuntimeProcessSample | undefined;

  constructor(options: DesktopRuntimeProcessSamplerOptions) {
    this.#getMetrics = options.getMetrics;
    this.#describeRenderer = options.describeRenderer;
    this.#now = options.now ?? Date.now;
    this.#cacheMs = options.cacheMs ?? DESKTOP_RUNTIME_PROCESS_SAMPLE_CACHE_MS;
    if (!Number.isSafeInteger(this.#cacheMs) || this.#cacheMs < 0) {
      throw new TypeError("Desktop runtime process sample cache duration is invalid.");
    }
  }

  sample(): DesktopRuntimeProcessSample {
    const capturedAt = this.#now();
    if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) {
      throw new Error("Desktop runtime process sample time is invalid.");
    }
    const cached = this.#cached;
    if (cached !== undefined && capturedAt >= cached.capturedAt && capturedAt - cached.capturedAt < this.#cacheMs) {
      return cached;
    }
    const sample = projectDesktopRuntimeProcessSample(this.#getMetrics(), capturedAt, this.#describeRenderer);
    this.#cached = sample;
    return sample;
  }
}

export function projectDesktopRuntimeProcessSample(
  metrics: readonly ElectronRuntimeProcessMetric[],
  capturedAt: number,
  describeRenderer: (pid: number) => string | null
): DesktopRuntimeProcessSample {
  if (!Number.isSafeInteger(capturedAt) || capturedAt < 0 || !Array.isArray(metrics) ||
    metrics.length > RUNTIME_PROCESS_MONITOR_MAX_DESKTOP_PROCESSES) {
    throw new TypeError("Desktop runtime process metrics are invalid.");
  }
  const pids = new Set<number>();
  const processes = metrics.map((metric): DesktopRuntimeProcessMetric => {
    if (!Number.isSafeInteger(metric.pid) || metric.pid <= 0 || pids.has(metric.pid)) {
      throw new TypeError("Desktop runtime process identity is invalid.");
    }
    pids.add(metric.pid);
    const role = desktopRuntimeProcessRole(metric.type);
    const label = role === "renderer"
      ? normalizedDisplayLabel(describeRenderer(metric.pid))
      : role === "utility"
        ? normalizedDisplayLabel(metric.serviceName ?? metric.name ?? null)
        : null;
    return Object.freeze({
      role,
      pid: metric.pid,
      label,
      cpuPercent: finiteNonNegative(metric.cpu?.percentCPUUsage),
      memoryKb: safeMemoryKb(metric.memory?.workingSetSize),
      processCount: 1
    });
  });
  return Object.freeze({ version: 1, capturedAt, processes: Object.freeze(processes) });
}

function desktopRuntimeProcessRole(type: string): DesktopRuntimeProcessRole {
  if (type === "Browser") return "main";
  if (type === "Tab") return "renderer";
  if (type === "GPU") return "gpu";
  return "utility";
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function safeMemoryKb(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value));
}

function normalizedDisplayLabel(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, 512).trim();
  return normalized === "" ? null : normalized;
}
