import type { EventPayload, RunUsageSummary } from "@joko/core";
import { StoreError } from "./errors.js";

export const runUsageSettingKey = (runId: string): string => `run.usage:${runId}`;
const integers = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "costMicros"] as const;
const fields = new Set<string>([...integers, "currencyCode", "estimated", "tokensComplete", "costComplete", "completionEventId", "messageId"]);

export function parseRunUsageSummary(value: unknown): RunUsageSummary {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!record || record["version"] !== 1 || Object.keys(record).some(key => key !== "version" && !fields.has(key))) {
    throw new StoreError("The current Run usage summary is invalid.");
  }
  const { version: _version, ...summary } = record;
  return parseRunUsageFields(summary);
}

export function parseRunUsageFields(value: unknown): RunUsageSummary {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!record || Object.keys(record).some(key => !fields.has(key))
    || integers.some(key => !Number.isSafeInteger(record[key]) || (record[key] as number) < 0)
    || typeof record["estimated"] !== "boolean" || typeof record["tokensComplete"] !== "boolean" || typeof record["costComplete"] !== "boolean"
    || record["currencyCode"] !== undefined && (typeof record["currencyCode"] !== "string" || !/^[A-Z]{3}$/u.test(record["currencyCode"]))
    || [record["completionEventId"], record["messageId"]].some(id => id !== undefined && (typeof id !== "string" || !id.trim() || id.length > 512 || /[\u0000-\u001f\u007f]/u.test(id)))
    || (record["completionEventId"] === undefined) !== (record["messageId"] === undefined)
    || record["currencyCode"] === undefined && (record["costMicros"] !== 0 || record["costComplete"] !== false)) {
    throw new StoreError("The current Run usage summary is invalid.");
  }
  return record as unknown as RunUsageSummary;
}

export function parseCurrentRunUsageEventPayload(payload: EventPayload): EventPayload {
  if (payload.type === "run_state" && payload.usage !== undefined) {
    return { ...payload, usage: parseRunUsageFields(payload.usage) };
  }
  if (payload.type === "message_complete" && payload.turnUsage !== undefined) {
    const summary = parseRunUsageFields(payload.turnUsage);
    if (payload.role !== "assistant" || summary.completionEventId === undefined) {
      throw new StoreError("A message Run usage summary requires an exact assistant completion.");
    }
    return { ...payload, turnUsage: summary };
  }
  return payload;
}
