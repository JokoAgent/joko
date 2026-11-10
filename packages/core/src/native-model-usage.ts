import type { NativeModelUsage, UsageSnapshot } from "./types.js";

const counters = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const;
const fields = new Set<string>(["modelId", ...counters, "cost", "tokensComplete", "costComplete"]);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A bounded partition of native totals. Missing portions keep an unknown model;
 * they can never be assigned to the user's selected model by inference. */
export function parseNativeModelUsage(value: unknown, total: UsageSnapshot): readonly NativeModelUsage[] | undefined {
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const seen = new Set<string>(), sums = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
  const result: NativeModelUsage[] = []; let costMicros = 0;
  for (const row of value) {
    if (!record(row) || Object.keys(row).some(key => !fields.has(key)) || typeof row["modelId"] !== "string"
      || !row["modelId"] || row["modelId"].length > 512 || /[\u0000-\u0020\u007f]/u.test(row["modelId"]) || seen.has(row["modelId"])
      || counters.some(key => !integer(row[key])) || typeof row["cost"] !== "number" || !Number.isFinite(row["cost"]) || row["cost"] < 0
      || typeof row["tokensComplete"] !== "boolean" || typeof row["costComplete"] !== "boolean") return undefined;
    const item = row as unknown as NativeModelUsage;
    if (item.totalTokens !== item.inputTokens + item.outputTokens) return undefined;
    for (const key of counters) { sums[key] += item[key]; if (!integer(sums[key]) || sums[key] > total[key]) return undefined; }
    costMicros += Math.round(item.cost * 1_000_000);
    if (!integer(costMicros) || costMicros > Math.round(total.cost * 1_000_000)) return undefined;
    seen.add(item.modelId);
    result.push({ modelId: item.modelId, inputTokens: item.inputTokens, outputTokens: item.outputTokens, cacheReadTokens: item.cacheReadTokens,
      cacheWriteTokens: item.cacheWriteTokens, totalTokens: item.totalTokens, cost: item.cost, tokensComplete: item.tokensComplete, costComplete: item.costComplete });
  }
  return result;
}
