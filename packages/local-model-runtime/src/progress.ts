import type { ModelPullProgress, OllamaPullEvent, PullPhase } from "./types.js";

interface PullLayer {
  readonly completed: number;
  readonly total: number;
}

const SPEED_WINDOW_MS = 3_000;
const RESUME_SPIKE_BYTES = 64 * 1024 * 1024;

export function pullPhase(status: string): PullPhase {
  const value = status.toLowerCase();
  if (value.includes("success")) return "success";
  if (value.includes("manifest")) return "manifest";
  if (value.includes("verif")) return "verifying";
  if (value.includes("writ")) return "writing";
  if (value.includes("download") || value.includes("pulling")) return "downloading";
  return "starting";
}

export function createTransferSpeedTracker(now: () => number = Date.now) {
  const completedByLayer = new Map<string, number>();
  const samples: Array<{ readonly at: number; readonly transferred: number }> = [];
  let transferred = 0;
  return {
    update(layers: ReadonlyMap<string, PullLayer>): number | undefined {
      const at = now();
      for (const [digest, layer] of layers) {
        const prior = completedByLayer.get(digest) ?? 0;
        if (layer.completed <= prior) continue;
        const delta = layer.completed - prior;
        completedByLayer.set(digest, layer.completed);
        if (delta < RESUME_SPIKE_BYTES) transferred += delta;
      }
      samples.push({ at, transferred });
      const cutoff = at - SPEED_WINDOW_MS;
      while (samples.length > 1 && samples[1]!.at <= cutoff) samples.shift();
      const first = samples[0];
      if (first === undefined || at - first.at < 400 || transferred <= first.transferred) return undefined;
      return (transferred - first.transferred) / ((at - first.at) / 1000);
    }
  };
}

export function applyPullEvent(
  name: string,
  layers: Map<string, PullLayer>,
  event: OllamaPullEvent,
  speed = createTransferSpeedTracker()
): ModelPullProgress {
  const digest = event.digest?.trim();
  if (digest !== undefined && (event.completed !== undefined || event.total !== undefined)) {
    const prior = layers.get(digest) ?? { completed: 0, total: 0 };
    layers.set(digest, {
      completed: event.completed ?? prior.completed,
      total: event.total ?? prior.total
    });
  }
  let completed = 0;
  let total = 0;
  for (const layer of layers.values()) {
    completed += layer.completed;
    total += layer.total;
  }
  const rawStatus = event.status?.trim() || "starting";
  const phase = pullPhase(rawStatus);
  const bytesPerSecond = speed.update(layers);
  return {
    name,
    phase,
    status: phase,
    ...(completed > 0 ? { completedBytes: completed } : {}),
    ...(total > 0 ? { totalBytes: total, percent: Math.min(100, Math.round(completed / total * 100)) } : {}),
    ...(bytesPerSecond === undefined ? {} : { bytesPerSecond }),
    done: false
  };
}
