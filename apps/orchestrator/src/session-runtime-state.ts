import type { UsageSnapshot } from "@joko/core";

export const SESSION_RUNTIME_STATE_SETTING_KEY = "runtime.backend.materialized_state";

export interface MaterializedSessionRuntimeState {
  readonly usage?: UsageSnapshot;
  readonly activeNativeEntryId?: string;
  readonly updatedAt: number;
}

export function materializedSessionRuntimeState(value: unknown): MaterializedSessionRuntimeState | undefined {
  if (!isRecord(value)) return undefined;
  const updatedAt = finite(value["updatedAt"]);
  if (updatedAt === undefined) return undefined;
  const activeNativeEntryId = boundedText(value["activeNativeEntryId"], 512);
  const usage = usageSnapshot(value["usage"]);
  return {
    ...(usage === undefined ? {} : { usage }),
    ...(activeNativeEntryId === undefined ? {} : { activeNativeEntryId }),
    updatedAt
  };
}

export function mergeMaterializedSessionRuntimeState(
  current: unknown,
  patch: {
    readonly usage?: UsageSnapshot;
    readonly activeNativeEntryId?: string | null;
  },
  updatedAt = Date.now()
): MaterializedSessionRuntimeState {
  const previous = materializedSessionRuntimeState(current);
  const activeNativeEntryId = patch.activeNativeEntryId === null
    ? undefined
    : patch.activeNativeEntryId ?? previous?.activeNativeEntryId;
  const usage = patch.usage ?? previous?.usage;
  return {
    ...(usage === undefined ? {} : { usage }),
    ...(activeNativeEntryId === undefined ? {} : { activeNativeEntryId }),
    updatedAt
  };
}

function usageSnapshot(value: unknown): UsageSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = nonnegativeInteger(value["inputTokens"]);
  const outputTokens = nonnegativeInteger(value["outputTokens"]);
  const cacheReadTokens = nonnegativeInteger(value["cacheReadTokens"]);
  const cacheWriteTokens = nonnegativeInteger(value["cacheWriteTokens"]);
  const totalTokens = nonnegativeInteger(value["totalTokens"]);
  const cost = nonnegativeNumber(value["cost"]);
  if (
    inputTokens === undefined || outputTokens === undefined || cacheReadTokens === undefined ||
    cacheWriteTokens === undefined || totalTokens === undefined || cost === undefined
  ) return undefined;
  const contextTokens = optionalNonnegative(value["contextTokens"]);
  const contextWindow = optionalNonnegative(value["contextWindow"]);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    cost
  };
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalNonnegative(value: unknown): number | undefined {
  return value === undefined ? undefined : nonnegativeInteger(value);
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= maximum ? text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
