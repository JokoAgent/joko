import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContentTracing } from "electron";

const captureLimitMs = 60_000;
const events = new Set(["RunTask", "FunctionCall", "EventDispatch", "EvaluateScript", "Paint", "Layout",
  "UpdateLayoutTree", "TimerFire", "FireAnimationFrame", "MajorGC", "MinorGC", "V8.Execute"]);

export type PerformanceRecordingPhase = "idle" | "recording" | "busy" | "ready";
export type PerformanceRecordingCommand = "state" | "start" | "stop" | "reveal" | "retire";
type Source = {
  readonly id: string;
  readonly owner: string;
  readonly pid: number;
  readonly main: boolean;
  isCurrent(): boolean;
  destroyed(): boolean;
};
type Capture = { source: Source; startedAt: number; started: Promise<void>; startedOk: boolean;
  watchdog?: ReturnType<typeof setInterval>; stopping?: Promise<void>; discarded: boolean };

export class DesktopPerformanceRecording {
  #capture?: Capture;
  #report?: { source: Source; file: string };

  constructor(private readonly tracing: Pick<ContentTracing, "startRecording" | "stopRecording">,
    private readonly temporaryDirectory: () => string, private readonly reportDirectory: () => string,
    private readonly revealFile: (file: string) => void) {}

  state(source: Source): PerformanceRecordingPhase {
    if (this.#capture) return this.#owns(this.#capture.source, source) && this.#capture.startedOk && !this.#capture.stopping ? "recording" : "busy";
    return this.#readableReport(source) ? "ready" : "idle";
  }

  async start(source: Source): Promise<void> {
    if (this.#capture || !source.isCurrent() || !Number.isSafeInteger(source.pid) || source.pid <= 0) throw new Error("Performance recording is unavailable.");
    const capture: Capture = { source, startedAt: Date.now(), started: Promise.resolve(), startedOk: false, discarded: false };
    this.#capture = capture;
    capture.started = Promise.resolve().then(() => this.tracing.startRecording({
      recording_mode: "record-until-full", trace_buffer_size_in_kb: 8 * 1024,
      enable_argument_filter: true, included_process_ids: [source.pid],
      included_categories: ["devtools.timeline", "v8", "latencyInfo", "toplevel"]
    }));
    capture.watchdog = setInterval(() => {
      if (!source.isCurrent()) void this.#stop(capture, false).catch(() => undefined);
      else if (Date.now() - capture.startedAt >= captureLimitMs) void this.#stop(capture, true).catch(() => undefined);
    }, 300);
    capture.watchdog.unref();
    try {
      await capture.started;
      capture.startedOk = true;
      if (!source.isCurrent()) await this.#stop(capture, false);
    } catch (error) {
      clearInterval(capture.watchdog);
      if (this.#capture === capture) this.#capture = undefined;
      throw error;
    }
  }

  async stop(source: Source): Promise<void> {
    const capture = this.#capture;
    if (!capture || !this.#owns(capture.source, source) || !source.isCurrent()) throw new Error("Use the window that started the recording.");
    await this.#stop(capture, true);
  }

  retire(source: Source): void {
    if (this.#capture && this.#owns(this.#capture.source, source)) void this.#stop(this.#capture, false).catch(() => undefined);
  }

  reveal(source: Source): void {
    const report = this.#readableReport(source);
    if (!report) throw new Error("There is no performance report for this window.");
    this.revealFile(report.file);
  }

  #owns(owner: Source, source: Source): boolean { return owner.id === source.id && owner.owner === source.owner; }

  #readableReport(source: Source) {
    const report = this.#report;
    return report && source.isCurrent() && (this.#owns(report.source, source)
      || source.main && report.source.destroyed() && report.source.owner === source.owner) ? report : undefined;
  }

  #stop(capture: Capture, keep: boolean): Promise<void> {
    if (!keep) capture.discarded = true;
    capture.stopping ??= this.#finalize(capture);
    return capture.stopping;
  }

  async #finalize(capture: Capture): Promise<void> {
    clearInterval(capture.watchdog);
    const stoppedAt = Date.now();
    let directory: string | undefined;
    let temporaryTrace: string | undefined;
    let raw: string | undefined;
    try {
      await capture.started;
      try {
        directory = await mkdtemp(join(this.temporaryDirectory(), "joko-performance-"));
        temporaryTrace = join(directory, "trace.json");
      } finally {
        raw = await this.tracing.stopRecording(temporaryTrace);
      }
      if (capture.discarded || !capture.source.isCurrent()) return;
      const stat = raw && await lstat(raw);
      if (!raw || !stat || !stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("Performance trace is unavailable or exceeds its size limit.");
      const summary = summarizePerformanceRecording(JSON.parse(await readFile(raw, "utf8")), capture.source.pid);
      if (capture.discarded || !capture.source.isCurrent()) return;
      const root = this.reportDirectory();
      await mkdir(root, { recursive: true, mode: 0o700 });
      const file = join(root, `performance-${randomUUID()}.json`);
      await writeFile(file, JSON.stringify({ format: 1, startedAt: capture.startedAt, stoppedAt, durationMs: stoppedAt - capture.startedAt,
        rendererEvents: summary }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      if (capture.discarded || !capture.source.isCurrent()) await rm(file, { force: true });
      else this.#report = { source: capture.source, file };
    } finally {
      try {
        if (raw) await rm(raw, { force: true });
        if (temporaryTrace && temporaryTrace !== raw) await rm(temporaryTrace, { force: true });
        if (directory) await rmdir(directory).catch(() => undefined);
      } finally { if (this.#capture === capture) this.#capture = undefined; }
    }
  }
}

export function summarizePerformanceRecording(trace: unknown, rendererPid: number) {
  const rows = Array.isArray(trace) ? trace : (trace as { traceEvents?: unknown } | null)?.traceEvents;
  if (!Array.isArray(rows)) throw new Error("Invalid performance trace.");
  const metrics = new Map<string, { count: number; totalMs: number; maximumMs: number }>();
  for (const value of rows) {
    const event = value as { name?: string; pid?: number; ph?: string; dur?: number } | null;
    if (!event || event.pid !== rendererPid || event.ph !== "X" || event.name === undefined || !events.has(event.name)
      || typeof event.dur !== "number" || !Number.isFinite(event.dur) || event.dur < 0) continue;
    const duration = event.dur / 1_000;
    const metric = metrics.get(event.name) ?? { count: 0, totalMs: 0, maximumMs: 0 };
    metric.count++;
    metric.totalMs += duration;
    metric.maximumMs = Math.max(metric.maximumMs, duration);
    metrics.set(event.name, metric);
  }
  return Object.fromEntries([...metrics].sort(([left], [right]) => left.localeCompare(right)));
}
