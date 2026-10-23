import type { ProviderAccountUsageSnapshot, ProviderAccountUsageWindow } from "@joko/core";
import type { ProviderGroupMember } from "@joko/store";

export interface ProviderGroupQuota {
  readonly limited: boolean; readonly resetAt?: number; readonly usagePercent?: number;
  readonly weeklyResetAt?: number; readonly fiveHourResetAt?: number;
}
export const PROVIDER_GROUP_QUOTA_MAX_AGE_MS = 10 * 60_000;
/** Core windows are Unix milliseconds. Unknown and expired windows do not
 * become zero-percent windows, and exhaustion is checked before balancing. */
export function providerGroupQuota(snapshot: ProviderAccountUsageSnapshot | undefined, providerId: string, modelId: string, now: number): ProviderGroupQuota {
  if (!snapshot || snapshot.providerId !== providerId || !Number.isFinite(snapshot.observedAt) || snapshot.observedAt <= 0
    || now - snapshot.observedAt > PROVIDER_GROUP_QUOTA_MAX_AGE_MS || snapshot.observedAt - now > 60_000) return { limited: false };
  const current = (window: ProviderAccountUsageWindow | undefined): ProviderAccountUsageWindow | undefined => window && Number.isFinite(window.usedPercent) && window.usedPercent >= 0
    && (window.resetAt === undefined || Number.isFinite(window.resetAt) && window.resetAt > now) ? { ...window, usedPercent: Math.min(window.usedPercent, 100) } : undefined;
  const all = [snapshot.primaryWindow, snapshot.secondaryWindow];
  const five = current(all.find(window => window?.windowMinutes !== undefined && window.windowMinutes <= 300)
    ?? (snapshot.primaryWindow?.windowMinutes === undefined ? snapshot.primaryWindow : undefined));
  const weekly = current(all.find(window => window?.windowMinutes !== undefined && window.windowMinutes >= 7 * 24 * 60)
    ?? (snapshot.secondaryWindow?.windowMinutes === undefined ? snapshot.secondaryWindow : undefined));
  // Model IDs come from the selected member catalog. A logical/display match is
  // supplied by the directory; unrelated family windows must not deny a model.
  const family = subscriptionModelFamily(modelId);
  const scopedRaw = snapshot.modelWindows?.find(window => window.modelId === modelId)
    ?? (family ? snapshot.modelWindows?.find(window => (subscriptionModelFamily(window.modelId) ?? (window.displayName.trim().toLowerCase().includes(family) ? family : undefined)) === family) : undefined);
  const scoped = current(scopedRaw?.window);
  const windows = [five, weekly, scoped].filter((window): window is ProviderAccountUsageWindow => window !== undefined);
  const exhausted = windows.filter(window => window.usedPercent >= 100);
  const resetAt = exhausted.flatMap(window => window.resetAt === undefined ? [] : [window.resetAt]);
  const limited = exhausted.length > 0 || snapshot.limitReached === true;
  return { limited, ...(resetAt.length ? { resetAt: Math.max(...resetAt) } : {}),
    ...(five && weekly && (!scopedRaw || scoped) ? { usagePercent: Math.max(five.usedPercent, weekly.usedPercent, scoped?.usedPercent ?? 0) } : {}),
    ...(weekly?.resetAt !== undefined && weekly.usedPercent < 100 ? { weeklyResetAt: weekly.resetAt } : {}),
    ...(five?.resetAt !== undefined && five.usedPercent < 100 ? { fiveHourResetAt: five.resetAt } : {}) };
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
