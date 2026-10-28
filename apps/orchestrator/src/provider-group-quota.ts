import type { ProviderAccountUsageSnapshot, ProviderAccountUsageWindow } from "@joko/core";
import type { ProviderGroupMember } from "@joko/store";

export interface ProviderGroupQuota {
  readonly limited: boolean; readonly resetAt?: number; readonly usagePercent?: number;
  readonly weeklyResetAt?: number; readonly fiveHourResetAt?: number;
  readonly urgency?: number; readonly fiveHourTight?: boolean;
  readonly pacingWindow?: { readonly usedPercent: number; readonly windowMs: number; readonly resetAt?: number };
}
export const PROVIDER_GROUP_QUOTA_MAX_AGE_MS = 10 * 60_000;
export const PROVIDER_GROUP_REBALANCE_MIN_GAIN = 15;
/** Core windows are Unix milliseconds. Unknown and expired windows do not
 * become zero-percent windows, and exhaustion is checked before balancing. */
export function providerGroupQuota(snapshot: ProviderAccountUsageSnapshot | undefined, providerId: string, modelId: string, now: number): ProviderGroupQuota {
  if (!snapshot || snapshot.providerId !== providerId || !Number.isFinite(snapshot.observedAt) || snapshot.observedAt <= 0
    || now - snapshot.observedAt > PROVIDER_GROUP_QUOTA_MAX_AGE_MS || snapshot.observedAt - now > 60_000) return { limited: false };
  const current = (window: ProviderAccountUsageWindow | undefined): ProviderAccountUsageWindow | undefined => window && Number.isFinite(window.usedPercent) && window.usedPercent >= 0
    && (window.resetAt === undefined || Number.isFinite(window.resetAt) && window.resetAt > now) ? { ...window, usedPercent: Math.min(window.usedPercent, 100) } : undefined;
  const exactBucket = snapshot.buckets?.find(bucket => bucket.id === modelId);
  // A model-specific native bucket must not be replaced by another model's
  // apparently fresh quota. Unmapped buckets remain unknown for scheduling.
  if (snapshot.buckets?.length && !exactBucket) return { limited: false };
  const selected = exactBucket ?? snapshot;
  const all = [selected.primaryWindow, selected.secondaryWindow];
  const fiveRaw = all.find(window => window?.windowMinutes !== undefined && window.windowMinutes > 0 && window.windowMinutes <= 300);
  const five = current(fiveRaw);
  const long = all.filter((window): window is ProviderAccountUsageWindow => window !== undefined && window.windowMinutes !== undefined && Number.isFinite(window.windowMinutes) && window.windowMinutes > 300);
  const weekly = current(long[0]);
  // Model IDs come from the selected member catalog. A logical/display match is
  // supplied by the directory; unrelated family windows must not deny a model.
  const family = subscriptionModelFamily(modelId);
  const scopedRaw = snapshot.modelWindows?.find(window => window.modelId === modelId)
    ?? (family ? snapshot.modelWindows?.find(window => (subscriptionModelFamily(window.modelId) ?? (window.displayName.trim().toLowerCase().includes(family) ? family : undefined)) === family) : undefined);
  const scoped = current(scopedRaw?.window);
  const windows = [...all.map(current), scoped].filter((window): window is ProviderAccountUsageWindow => window !== undefined);
  const exhausted = windows.filter(window => window.usedPercent >= 100);
  const resetAt = exhausted.flatMap(window => window.resetAt === undefined ? [] : [window.resetAt]);
  const rawWindows = [...all, scopedRaw?.window].filter((window): window is ProviderAccountUsageWindow => window !== undefined);
  const allReset = rawWindows.length > 0 && rawWindows.every(window => window.resetAt !== undefined && Number.isFinite(window.resetAt) && window.resetAt <= now);
  const limited = exhausted.length > 0 || selected.limitReached === true && !allReset;
  const pacedRaw = long.length ? [...long, ...(scopedRaw ? [scopedRaw.window] : [])] : all.filter((window): window is ProviderAccountUsageWindow => window !== undefined);
  const paced = pacedRaw.map(window => {
    const observed = current(window), minutes = window.windowMinutes ?? (window === scopedRaw?.window && family ? 7 * 24 * 60 : undefined);
    if (!observed || minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return undefined;
    const pacingWindow = { usedPercent: observed.usedPercent, windowMs: minutes * 60_000, ...(observed.resetAt === undefined ? {} : { resetAt: observed.resetAt }) };
    const urgency = quotaUrgency(pacingWindow, now);
    return urgency === undefined ? undefined : { pacingWindow, urgency };
  });
  const pace = paced.length && paced.every(value => value !== undefined)
    ? paced.reduce((slowest, candidate) => candidate!.urgency < slowest!.urgency ? candidate : slowest) : undefined;
  return { limited, ...(resetAt.length ? { resetAt: Math.max(...resetAt) } : {}),
    ...(pace ? { usagePercent: pace.pacingWindow.usedPercent, urgency: pace.urgency, pacingWindow: pace.pacingWindow } : {}),
    fiveHourTight: five !== undefined && five.usedPercent >= 85 && (five.resetAt === undefined || five.resetAt - now > 60 * 60_000),
    ...(weekly?.resetAt !== undefined && weekly.usedPercent < 100 ? { weeklyResetAt: weekly.resetAt } : {}),
    ...(five?.resetAt !== undefined && five.usedPercent < 100 ? { fiveHourResetAt: five.resetAt } : {}) };
}
export function quotaTimeLeftPercent(window: NonNullable<ProviderGroupQuota["pacingWindow"]>, now: number): number | undefined {
  if (!Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100 || !Number.isFinite(window.windowMs) || window.windowMs <= 0) return undefined;
  if (window.resetAt === undefined) return window.usedPercent === 0 ? 100 : undefined;
  const remaining = window.resetAt - now;
  return Number.isFinite(remaining) && remaining > 0 ? Math.min(100, remaining / window.windowMs * 100) : undefined;
}
export function quotaUrgency(window: NonNullable<ProviderGroupQuota["pacingWindow"]>, now: number): number | undefined {
  const time = quotaTimeLeftPercent(window, now); return time === undefined ? undefined : (100 - window.usedPercent) / time;
}
export function providerGroupRebalanceTarget(current: ProviderGroupQuota, candidates: readonly { readonly key: string; readonly quota: ProviderGroupQuota }[], now: number): string | undefined {
  const from = current.pacingWindow === undefined ? undefined : quotaUrgency(current.pacingWindow, now);
  if (from === undefined || current.limited) return undefined;
  let best: { readonly key: string; readonly urgency: number; readonly time: number } | undefined;
  for (const candidate of candidates) {
    if (candidate.quota.limited || candidate.quota.fiveHourTight || !candidate.quota.pacingWindow) continue;
    const urgency = quotaUrgency(candidate.quota.pacingWindow, now), time = quotaTimeLeftPercent(candidate.quota.pacingWindow, now);
    if (urgency !== undefined && time !== undefined && (!best || urgency > best.urgency)) best = { key: candidate.key, urgency, time };
  }
  return best && best.urgency > from && (best.urgency - from) * best.time >= PROVIDER_GROUP_REBALANCE_MIN_GAIN ? best.key : undefined;
}
function subscriptionModelFamily(value: string | undefined): string | undefined {
  const model = (value ?? "").trim().toLowerCase().replace(/\[[^\]]*\]$/u, "");
  return ["fable", "mythos", "opus", "sonnet", "haiku"].find(family => model.includes(family));
}
export interface ProviderGroupQuotaReaderOptions {
  readonly readLocal: (member: ProviderGroupMember, signal: AbortSignal) => Promise<ProviderAccountUsageSnapshot | undefined>;
  readonly readRemote: (member: ProviderGroupMember, signal: AbortSignal) => Promise<ProviderAccountUsageSnapshot | undefined>;
  readonly now?: () => number;
}
/** Remote reads have one bounded wait and one shared in-flight request. A
 * received share never exposes another person's private subscription usage. */
export class ProviderGroupQuotaReader {
  readonly #cache = new Map<string, { at: number; value: ProviderAccountUsageSnapshot | undefined }>();
  readonly #pending = new Map<string, Promise<ProviderAccountUsageSnapshot | undefined>>();
  constructor(readonly options: ProviderGroupQuotaReaderOptions) {}
  async read(member: ProviderGroupMember, modelId: string, signal: AbortSignal, fresh = false): Promise<ProviderGroupQuota> {
    const now = this.options.now?.() ?? Date.now(); signal.throwIfAborted();
    if (member.kind === "share") return { limited: false };
    const key = JSON.stringify([member.backendId, member.providerId]);
    const cached = this.#cache.get(key);
    if (!fresh && member.kind !== "local" && cached && now - cached.at < 15_000) return providerGroupQuota(cached.value, member.providerId, modelId, now);
    let pending = this.#pending.get(key);
    if (!pending) {
      const timeout = AbortSignal.timeout(1_500);
      pending = Promise.race([
        (member.kind === "local" ? this.options.readLocal : this.options.readRemote)(member, timeout),
        new Promise<undefined>(resolve => timeout.addEventListener("abort", () => resolve(undefined), { once: true }))
      ]).catch(() => undefined).then(value => {
        this.#cache.delete(key); this.#cache.set(key, { at: this.options.now?.() ?? Date.now(), value });
        while (this.#cache.size > 512) this.#cache.delete(this.#cache.keys().next().value!); return value;
      }).finally(() => { if (this.#pending.get(key) === pending) this.#pending.delete(key); });
      this.#pending.set(key, pending);
    }
    const snapshot = await pending; signal.throwIfAborted(); return providerGroupQuota(snapshot, member.providerId, modelId, this.options.now?.() ?? Date.now());
  }
  clear(): void { this.#cache.clear(); }
}
