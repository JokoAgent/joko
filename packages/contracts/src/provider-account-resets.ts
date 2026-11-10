import type { ProviderAccountResetOffer, ProviderAccountResetResult, ProviderAccountResetState } from "./gen/joko/v1/model_pb.js";

export interface ProviderAccountResetApi {
  readonly ownerKey: string;
  read(backendId: string, providerId: string, signal: AbortSignal): Promise<ProviderAccountResetState>;
  consume(state: ProviderAccountResetState, offer: ProviderAccountResetOffer, signal: AbortSignal): Promise<ProviderAccountResetResult>;
  save(state: ProviderAccountResetState, settings: ProviderAccountResetSettingsValue | null, signal: AbortSignal): Promise<void>;
}

/** Stable across UI retries, unmounts and reconnects; the offer is service-owned. */
export function providerAccountResetOperationId(offerId: string, connectionId: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(offerId)) throw new TypeError("The original reset offer is invalid.");
  if (!connectionId || connectionId.length > 128 || /[\0\r\n]/u.test(connectionId)) throw new TypeError("The original reset connection is invalid.");
  return `manual-provider-account-reset:${connectionId}:${offerId}`;
}

export interface ProviderAccountResetSettingsValue {
  readonly enabled: boolean;
  readonly lowQuota: boolean;
  readonly minimumDays: number;
  readonly expiring: boolean;
  readonly expiryMinutes: number;
}

export const DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS: Readonly<ProviderAccountResetSettingsValue> = Object.freeze({
  enabled: false, lowQuota: true, minimumDays: 3, expiring: true, expiryMinutes: 60
});

export function parseProviderAccountResetSettings(value: unknown): ProviderAccountResetSettingsValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Account reset settings are invalid.");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["enabled", "lowQuota", "minimumDays", "expiring", "expiryMinutes"].includes(key))
    || typeof row["enabled"] !== "boolean" || typeof row["lowQuota"] !== "boolean" || typeof row["expiring"] !== "boolean"
    || typeof row["minimumDays"] !== "number" || !Number.isInteger(row["minimumDays"]) || row["minimumDays"] < 0 || row["minimumDays"] > 365
    || typeof row["expiryMinutes"] !== "number" || ![30, 60, 360, 1440].includes(row["expiryMinutes"])
    || row["enabled"] && !row["lowQuota"] && !row["expiring"]) throw new TypeError("Account reset settings are invalid.");
  return { enabled: row["enabled"], lowQuota: row["lowQuota"], minimumDays: row["minimumDays"], expiring: row["expiring"], expiryMinutes: row["expiryMinutes"] };
}
