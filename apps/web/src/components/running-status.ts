import type { BackgroundTaskActivityView, TimelineItemView } from "../model.js";

export interface ActiveRunUsageSummary {
  readonly totalTokens: number;
  readonly outputTokens: number;
  readonly generationDurationMs: number;
  readonly generationReliable: boolean;
}

export type RunningUsageMeta =
  | { readonly kind: "rate"; readonly rate: string }
  | { readonly kind: "tokens" }
  | { readonly kind: "none" };

export function activeRunUsageSummary(items: readonly TimelineItemView[], runId: string | undefined): ActiveRunUsageSummary {
  if (runId === undefined) return emptyActiveRunUsage();
  let totalTokens = 0;
  let outputTokens = 0;
  let generationDurationMs = 0;
  let hasOutput = false;
  let generationReliable = true;
  for (const item of items) {
    if (item.kind !== "assistant" || item.runId !== runId || item.usage === undefined) continue;
    totalTokens += safeUsageNumber(item.usage.totalTokens);
    const output = safeUsageNumber(item.usage.outputTokens);
    outputTokens += output;
    if (output <= 0) continue;
    hasOutput = true;
    const timed = item.usage as typeof item.usage & {
      readonly generationDurationMs?: number;
      readonly generationReliable?: boolean;
    };
    if (timed.generationReliable !== true
      || !Number.isFinite(timed.generationDurationMs)
      || (timed.generationDurationMs ?? 0) <= 0) {
      generationReliable = false;
      continue;
    }
    generationDurationMs += timed.generationDurationMs ?? 0;
  }
  return {
    totalTokens,
    outputTokens,
    generationDurationMs,
    generationReliable: hasOutput && generationReliable && generationDurationMs > 0
  };
}

export function resolveRunningUsageMeta(usage: ActiveRunUsageSummary): RunningUsageMeta {
  if (usage.generationReliable && usage.outputTokens > 0 && usage.generationDurationMs > 0) {
    const rate = usage.outputTokens * 1_000 / usage.generationDurationMs;
    if (Number.isFinite(rate) && rate > 0) return {
      kind: "rate",
      rate: rate < 0.1 ? "<0.1" : rate >= 100 ? rate.toFixed(0) : rate.toFixed(1).replace(/\.0$/u, "")
    };
  }
  return usage.totalTokens > 0 ? { kind: "tokens" } : { kind: "none" };
}

export function activeBackgroundTaskIds(
  tasks: readonly BackgroundTaskActivityView[],
  sessionId: string,
  foregroundRunning: boolean
): readonly string[] {
  if (foregroundRunning) return [];
  return tasks
    .filter((task) => task.sessionId === sessionId && ["queued", "running", "waiting"].includes(task.state))
    .map((task) => task.id);
}

export function latestRunningActivityLabel(items: readonly TimelineItemView[], runId: string | undefined): string | undefined {
  if (runId === undefined) return undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined || (item.runId !== undefined && item.runId !== runId)) continue;
    if (item.kind === "status" && item.streaming === true) return nonEmpty(item.title) ?? nonEmpty(item.text);
    if (item.kind === "tool" && ["requested", "waiting", "running"].includes(item.tool?.state ?? "")) {
      return nonEmpty(item.title) ?? nonEmpty(item.tool?.name);
    }
    if (item.kind === "thinking" && item.streaming === true) return nonEmpty(item.title);
  }
  return undefined;
}

export function formatRunningElapsed(elapsedSeconds: number): string {
  const normalized = Math.max(0, Math.floor(Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0));
  const minutes = Math.floor(normalized / 60);
  const seconds = normalized % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function emptyActiveRunUsage(): ActiveRunUsageSummary {
  return { totalTokens: 0, outputTokens: 0, generationDurationMs: 0, generationReliable: false };
}

function safeUsageNumber(value: number): number {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
