import { AuthenticationState, CapabilitySupport, ModelSourceKind, capabilityNames, type ProviderAccountUsageSnapshot,
  type ProviderAccountUsageBucket, type ProviderAccountUsageWindow, type ProviderDescriptor } from "@joko/contracts";

export interface MobileProviderUsageTransport {
  readonly ownerKey: string;
  readonly providers: readonly ProviderDescriptor[];
  readonly read: (backendId: string, providerId: string, signal: AbortSignal) => Promise<ProviderAccountUsageSnapshot | undefined>;
  readonly resets?: import("@joko/contracts").ProviderAccountResetApi;
}

export interface MobileAccountUsageWindow {
  readonly id: string;
  readonly label?: string;
  readonly minutes?: number;
  readonly remainingPercent: number;
  readonly resetAt?: number;
  readonly model: boolean;
}

const CODEX_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const CODEX_BUCKET_RETIREMENT_MS = 24 * 60 * 60_000;

export function mobileAccountResetControls(transport: MobileProviderUsageTransport | undefined, backendId: string, providerId: string, sourceKind: ModelSourceKind | undefined) {
  const api = transport?.resets;
  if (!api || !transport || sourceKind !== ModelSourceKind.LOCAL) return undefined;
  return transport.providers.some(provider => provider.backendId === backendId && provider.providerId === providerId
    && provider.capabilities?.capabilities.some(capability => capability.name === "provider.account_resets" && capability.support === CapabilitySupport.SUPPORTED)) ? { api, backendId, providerId } : undefined;
}

export function mobileUsageProviderKey(provider: Pick<ProviderDescriptor, "backendId" | "providerId">): string {
  return JSON.stringify([provider.backendId, provider.providerId]);
}

export function mobileProviderUsageSupported(provider: ProviderDescriptor): boolean {
  const capabilities = provider.capabilities?.capabilities.filter(item => item.name === capabilityNames.providerAccountUsage) ?? [];
  return !!provider.backendId && !!provider.providerId && capabilities.length === 1
    && capabilities[0]!.support === CapabilitySupport.SUPPORTED
    && provider.version !== undefined && provider.version.generation >= 0n && (provider.version.revision?.value ?? 0n) > 0n
    && (provider.authenticationState === AuthenticationState.AUTHENTICATED || provider.authenticationState === AuthenticationState.NOT_REQUIRED);
}

export function mobileProviderUsageIdentity(provider: ProviderDescriptor): string {
  return JSON.stringify([provider.backendId, provider.providerId, provider.authenticationState, provider.endpointDisplay,
    provider.version?.generation.toString(), provider.version?.revision?.value.toString(),
    mobileUsageTimestamp(provider.credentialExpiresAt)]);
}

export function mobileUsageTimestamp(value: { readonly seconds: bigint; readonly nanos: number } | undefined): number | undefined {
  if (!value || typeof value.seconds !== "bigint" || value.seconds < 0n || value.seconds > 8_640_000_000_000n
    || !Number.isInteger(value.nanos) || value.nanos < 0 || value.nanos >= 1_000_000_000) return undefined;
  const result = Number(value.seconds * 1000n) + Math.floor(value.nanos / 1_000_000);
  return Number.isSafeInteger(result) && result <= 8_640_000_000_000_000 ? result : undefined;
}

/** Overall limits and exact model windows remain separate facts from task tokens. */
export function mobileAccountUsageWindows(snapshot: ProviderAccountUsageSnapshot | undefined, modelId: string | undefined, now: number,
  modelScope?: "claude-family"): readonly MobileAccountUsageWindow[] {
  if (!snapshot) return [];
  const rows: MobileAccountUsageWindow[] = [];
  const add = (id: string, window: ProviderAccountUsageWindow | undefined, label?: string): void => {
    const row = mobileAccountUsageWindow(id, window, now, label);
    if (row) rows.push(row);
  };
  add("primary", snapshot.primaryWindow);
  add("secondary", snapshot.secondaryWindow);
  if (snapshot.buckets.length <= 256) {
    const ids = snapshot.buckets.map(bucket => bucket.id);
    for (const bucket of snapshot.buckets) {
      if (!bucket.id || ids.filter(id => id === bucket.id).length !== 1) continue;
      add(`bucket:${bucket.id}:primary`, bucket.primaryWindow, bucket.displayName ?? bucket.id);
      add(`bucket:${bucket.id}:secondary`, bucket.secondaryWindow, bucket.displayName ?? bucket.id);
    }
  }
  if (!modelId) return rows;
  const exact = mobileExactModelUsageWindows(snapshot, modelId, now);
  if (exact.length > 0 || modelScope !== "claude-family") return [...rows, ...exact];
  const scoped = mobileClaudeFamilyUsageWindow(snapshot, modelId, now);
  return scoped ? [...rows, scoped] : rows;
}

export function mobileExactModelUsageWindows(snapshot: ProviderAccountUsageSnapshot, modelId: string, now: number): readonly MobileAccountUsageWindow[] {
  if (!modelId || snapshot.modelWindows.length > 256) return [];
  return snapshot.modelWindows.flatMap((entry, index) => {
    if (entry.modelId !== modelId) return [];
    const row = mobileAccountUsageWindow(`model:${index}`, entry.window, now, entry.displayName, true);
    return row ? [row] : [];
  });
}

function mobileClaudeModelFamily(modelId: string | undefined): string | undefined {
  const model = (modelId ?? "").trim().toLowerCase().replace(/\[[^\[\]]*\]$/u, "");
  return ["fable", "mythos", "opus", "sonnet", "haiku"].find(family => model.includes(family));
}

function mobileClaudeFamilyUsageWindow(snapshot: ProviderAccountUsageSnapshot, modelId: string, now: number): MobileAccountUsageWindow | undefined {
  const family = mobileClaudeModelFamily(modelId);
  if (!family || snapshot.modelWindows.length > 256) return undefined;
  for (const [index, entry] of snapshot.modelWindows.entries()) {
    const namedFamily = mobileClaudeModelFamily(entry.modelId);
    const belongs = namedFamily ? namedFamily === family : entry.displayName.trim().toLowerCase().includes(family);
    if (!belongs || entry.window?.windowMinutes !== 10_080) continue;
    const row = mobileAccountUsageWindow(`model:${index}`, entry.window, now, entry.displayName, true);
    if (row) return row;
  }
  return undefined;
}

export function mobileCodexWeeklyUsageWindow(snapshot: ProviderAccountUsageSnapshot, modelId: string, now: number): MobileAccountUsageWindow | undefined {
  // The single-window view can mirror the first model bucket when no generic bucket exists.
  const selected = snapshot.buckets.length === 0 ? snapshot : mobileCodexModelBucket(snapshot.buckets, modelId, now);
  const window = [selected?.primaryWindow, selected?.secondaryWindow].find(row => row?.windowMinutes === CODEX_WEEKLY_WINDOW_MINUTES);
  const weekly = mobileAccountUsageWindow("codex-weekly", window, now);
  return weekly ? { ...weekly, remainingPercent: Math.round(weekly.remainingPercent) } : undefined;
}

function mobileCodexModelBucket(buckets: readonly ProviderAccountUsageBucket[], modelId: string, now: number): ProviderAccountUsageBucket | undefined {
  if (buckets.length > 256) return undefined;
  const token = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/gu, "");
  const model = token(modelId);
  const ids = buckets.map(bucket => bucket.id);
  const active = buckets.filter(bucket => {
    if (!bucket.id || ids.indexOf(bucket.id) !== ids.lastIndexOf(bucket.id)) return false;
    const windows = [bucket.primaryWindow, bucket.secondaryWindow].filter(window => window !== undefined);
    return windows.length === 0 || !windows.every(window => {
      const reset = mobileUsageTimestamp(window.resetAt);
      return reset !== undefined && reset > 0 && reset + CODEX_BUCKET_RETIREMENT_MS < now;
    });
  });
  let match: ProviderAccountUsageBucket | undefined;
  let length = 0;
  for (const bucket of active) {
    if (bucket.id === "codex" || bucket.id === "__default__") continue;
    const name = token(bucket.displayName ?? "");
    if (name && name === model) return bucket;
    if (name.length > length && model.includes(name)) {
      match = bucket;
      length = name.length;
    }
  }
  return match ?? active.find(bucket => bucket.id === "codex") ?? active.find(bucket => bucket.id === "__default__");
}

function mobileAccountUsageWindow(id: string, window: ProviderAccountUsageWindow | undefined, now: number, label?: string, model = false): MobileAccountUsageWindow | undefined {
  if (!window || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) return undefined;
  const resetAt = mobileUsageTimestamp(window.resetAt);
  if (window.resetAt !== undefined && resetAt === undefined || resetAt !== undefined && resetAt <= now) return undefined;
  return { id, remainingPercent: 100 - window.usedPercent, model,
    ...(label?.trim() ? { label: label.slice(0, 512) } : {}),
    ...(window.windowMinutes !== undefined && Number.isSafeInteger(window.windowMinutes) && window.windowMinutes > 0
      ? { minutes: window.windowMinutes } : {}), ...(resetAt === undefined ? {} : { resetAt }) };
}

export function mobileAccountUsageStale(snapshot: ProviderAccountUsageSnapshot, now: number): boolean {
  const observedAt = mobileUsageTimestamp(snapshot.observedAt);
  return observedAt === undefined || observedAt > now + 60_000 || now - observedAt > 5 * 60_000;
}
