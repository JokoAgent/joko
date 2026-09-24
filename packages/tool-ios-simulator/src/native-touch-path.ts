import type { WdaViewport } from "./wda-loopback-client.js";

const MAX_SAMPLES = 4_096;
const MAX_DURATION_MS = 60_000;
const TOUCH_EDGES = ["none", "left", "top", "bottom", "right"] as const;

export type SimulatorTouchPhase = "down" | "move" | "up" | "cancel";
export type SimulatorTouchEdge = typeof TOUCH_EDGES[number];
export interface SimulatorTouchSample {
  readonly phase: SimulatorTouchPhase;
  readonly x: number;
  readonly y: number;
  readonly dtMs?: number;
}
export interface SimulatorNormalizedTouchSample {
  readonly phase: SimulatorTouchPhase;
  readonly x: number;
  readonly y: number;
  readonly dtMs: number;
  readonly edge: SimulatorTouchEdge;
}

export class SimulatorNativeTouchError extends Error {
  constructor(readonly code: "INVALID_ARGUMENT", message: string) { super(message); }
}

function invalid(message: string): never {
  throw new SimulatorNativeTouchError("INVALID_ARGUMENT", message);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function viewportSize(viewport: WdaViewport): void {
  if (!Number.isFinite(viewport.width) || viewport.width <= 0 || viewport.width > 1_000_000 ||
      !Number.isFinite(viewport.height) || viewport.height <= 0 || viewport.height > 1_000_000) {
    invalid("Simulator viewport is invalid for native touch input.");
  }
}

/** Validate device-coordinate samples before converting them to native normalized coordinates. */
export function normalizeSimulatorTouchPath(value: unknown, viewport: WdaViewport,
  edge: SimulatorTouchEdge = "none"): readonly SimulatorNormalizedTouchSample[] {
  viewportSize(viewport);
  if (!TOUCH_EDGES.includes(edge)) invalid("Simulator touch edge is invalid.");
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_SAMPLES) {
    invalid("Simulator touch path must contain between 2 and 4096 samples.");
  }
  let durationMs = 0;
  return value.map((sample: unknown, index: number): SimulatorNormalizedTouchSample => {
    if (!record(sample) || Object.keys(sample).some(key =>
      key !== "phase" && key !== "x" && key !== "y" && key !== "dtMs")) {
      invalid("Simulator touch sample is invalid.");
    }
    const phase = sample["phase"];
    const expected = index === 0 ? "down" : index === value.length - 1 ? "up-or-cancel" : "move";
    if (expected === "up-or-cancel" ? phase !== "up" && phase !== "cancel" : phase !== expected) {
      invalid("Simulator touch phases must start down, continue move and end up or cancel.");
    }
    const x = sample["x"];
    const y = sample["y"];
    if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > viewport.width ||
        typeof y !== "number" || !Number.isFinite(y) || y < 0 || y > viewport.height) {
      invalid("Simulator touch coordinates must be inside the current viewport.");
    }
    const dtMs = sample["dtMs"] ?? (index === 0 ? 0 : 16);
    if (!Number.isSafeInteger(dtMs) || Number(dtMs) < 0 || Number(dtMs) > MAX_DURATION_MS ||
        index === 0 && dtMs !== 0 || phase === "move" && Number(dtMs) < 4) {
      invalid("Simulator touch sample timing is invalid.");
    }
    durationMs += Number(dtMs);
    if (durationMs > MAX_DURATION_MS) invalid("Simulator touch path exceeds its duration limit.");
    return { phase: phase as SimulatorTouchPhase, x: x / viewport.width,
      y: y / viewport.height, dtMs: Number(dtMs), edge };
  });
}

export function normalizeSimulatorTouchPair(first: unknown, second: unknown,
  viewport: WdaViewport): { readonly first: readonly SimulatorNormalizedTouchSample[];
    readonly second: readonly SimulatorNormalizedTouchSample[] } {
  const normalizedFirst = normalizeSimulatorTouchPath(first, viewport);
  const normalizedSecond = normalizeSimulatorTouchPath(second, viewport);
  if (normalizedFirst.length !== normalizedSecond.length || normalizedFirst.some((sample, index) =>
    sample.phase !== normalizedSecond[index]?.phase || sample.dtMs !== normalizedSecond[index]?.dtMs)) {
    invalid("Simulator multi-touch paths must have matching phases and timing.");
  }
  return { first: normalizedFirst, second: normalizedSecond };
}
