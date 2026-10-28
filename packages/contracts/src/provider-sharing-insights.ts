import { create, toBinary } from "@bufbuild/protobuf";
import { ProviderSharingInsightsSchema, type ProviderSharingInsights } from "./gen/joko/v1/provider_sharing_pb.js";
import type { ProviderAccountUsageSnapshot, ProviderAccountUsageWindow } from "./gen/joko/v1/model_pb.js";
import type { Timestamp } from "@bufbuild/protobuf/wkt";

export const PROVIDER_SHARING_INSIGHTS_MAX_BYTES = 512 * 1024;
const MAX_COUNT = BigInt(Number.MAX_SAFE_INTEGER);
const timestamp = (value: Timestamp | undefined) => value === undefined || value.nanos >= 0 && value.nanos < 1_000_000_000
  && Number.isFinite(Number(value.seconds) * 1000 + value.nanos / 1_000_000)
  && Math.abs(Number(value.seconds) * 1000 + value.nanos / 1_000_000) <= 8.64e15;
const window = (value: ProviderAccountUsageWindow | undefined) => value === undefined || Number.isFinite(value.usedPercent)
  && value.usedPercent >= 0 && value.usedPercent <= 100 && timestamp(value.resetAt)
  && (value.windowMinutes === undefined || value.windowMinutes > 0);
const day = (value: string) => /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
function account(value: ProviderAccountUsageSnapshot): boolean {
  return value.providerId.length <= 512 && value.observedAt !== undefined && timestamp(value.observedAt)
    && window(value.primaryWindow) && window(value.secondaryWindow) && value.buckets.length <= 32 && value.modelWindows.length <= 32
    && (!value.planType || value.planType.length <= 128)
    && (!value.credits || timestamp(value.credits.observedAt) && (value.credits.balance?.length ?? 0) <= 128)
    && value.buckets.every(bucket => bucket.id.length <= 128 && (bucket.displayName?.length ?? 0) <= 128
      && window(bucket.primaryWindow) && window(bucket.secondaryWindow)
      && (!bucket.credits || timestamp(bucket.credits.observedAt) && (bucket.credits.balance?.length ?? 0) <= 128))
    && value.modelWindows.every(scoped => scoped.displayName.length <= 128 && (scoped.modelId?.length ?? 0) <= 512 && window(scoped.window))
    && (!value.extraUsage || [value.extraUsage.usedPercent, value.extraUsage.usedCredits, value.extraUsage.monthlyLimit].every(number => number === undefined || Number.isFinite(number) && number >= 0)
      && (value.extraUsage.usedPercent === undefined || value.extraUsage.usedPercent <= 100))
    && (!value.resetCredits || timestamp(value.resetCredits.earliestExpiryAt));
}

/** Reject malformed peers, and discard data for capabilities that were revoked. */
export function projectProviderSharingInsights(input: ProviderSharingInsights): ProviderSharingInsights {
  const value = create(ProviderSharingInsightsSchema, input);
  if (!value.visibility) throw new Error("Provider sharing visibility is missing.");
  if (!value.visibility.quota) { value.accounts = []; value.quotaPartial = false; value.quotaStatus = "disabled"; }
  if (!value.visibility.usage) { value.days = []; value.usagePartial = false; value.coverageStart = ""; value.usageStatus = "disabled"; }
  if (!["disabled", "ready", "unavailable", "offline", "unsupported"].includes(value.quotaStatus)
    || !["disabled", "not_requested", "ready", "unavailable", "offline"].includes(value.usageStatus)
    || value.visibility.quota && value.quotaStatus === "disabled" || value.visibility.usage && value.usageStatus === "disabled"
    || value.accounts.length > 512 || value.days.length > 5000) throw new Error("Provider sharing insights are invalid.");
  if (value.quotaStatus !== "ready") value.accounts = [];
  else if (!value.accounts.length || value.accounts.some(row => !["ready", "unavailable", "offline", "unsupported", "unlimited"].includes(row.state)
    || row.state === "ready" && (!row.usage || !account(row.usage)) || row.state !== "ready" && row.usage)) throw new Error("Provider sharing quota is invalid.");
  if (value.usageStatus !== "ready") { value.days = []; value.coverageStart = ""; }
  else if (value.coverageStart && !day(value.coverageStart) || value.days.some(row => !day(row.day) || !row.modelId || row.modelId.length > 512
    || /[\0\r\n]/u.test(row.modelId) || ![row.turns, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens, row.costMicros].every(count => count >= 0n && count <= MAX_COUNT)
    || row.currencyCode !== "" && !/^[A-Z]{3}$/u.test(row.currencyCode))) throw new Error("Provider sharing usage is invalid.");
  if (toBinary(ProviderSharingInsightsSchema, value).byteLength > PROVIDER_SHARING_INSIGHTS_MAX_BYTES) throw new Error("Provider sharing insights exceed their display budget.");
  return value;
}
