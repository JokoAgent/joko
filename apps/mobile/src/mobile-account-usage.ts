import { AuthenticationState, CapabilitySupport, capabilityNames, type ProviderAccountUsageSnapshot,
  type ProviderAccountUsageWindow, type ProviderDescriptor } from "@joko/contracts";

export interface MobileProviderUsageTransport {
  readonly ownerKey: string;
  readonly providers: readonly ProviderDescriptor[];
  readonly read: (backendId: string, providerId: string, signal: AbortSignal) => Promise<ProviderAccountUsageSnapshot | undefined>;
}

export interface MobileAccountUsageWindow {
  readonly id: string;
  readonly label?: string;
  readonly minutes?: number;
  readonly remainingPercent: number;
  readonly resetAt?: number;
  readonly model: boolean;
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
export function mobileAccountUsageWindows(snapshot: ProviderAccountUsageSnapshot | undefined, modelId: string | undefined, now: number): readonly MobileAccountUsageWindow[] {
  if (!snapshot) return [];
  const rows: MobileAccountUsageWindow[] = [];
  const add = (id: string, window: ProviderAccountUsageWindow | undefined, label?: string, model = false): void => {
    if (!window || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) return;
    const resetAt = mobileUsageTimestamp(window.resetAt);
    if (window.resetAt !== undefined && resetAt === undefined || resetAt !== undefined && resetAt <= now) return;
    rows.push({ id, remainingPercent: 100 - window.usedPercent, model,
      ...(label?.trim() ? { label: label.slice(0, 512) } : {}),
      ...(window.windowMinutes !== undefined && Number.isSafeInteger(window.windowMinutes) && window.windowMinutes > 0
        ? { minutes: window.windowMinutes } : {}), ...(resetAt === undefined ? {} : { resetAt }) });
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
  if (modelId && snapshot.modelWindows.length <= 256) {
    for (const [index, entry] of snapshot.modelWindows.entries()) {
      if (entry.modelId !== modelId) continue;
      add(`model:${index}`, entry.window, entry.displayName, true);
    }
  }
  return rows;
}

export function mobileAccountUsageStale(snapshot: ProviderAccountUsageSnapshot, now: number): boolean {
  const observedAt = mobileUsageTimestamp(snapshot.observedAt);
  return observedAt === undefined || observedAt > now + 60_000 || now - observedAt > 5 * 60_000;
}
