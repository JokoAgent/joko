import { create } from "@bufbuild/protobuf";
import { AuthenticationState, CapabilitySupport, EntityVersionSchema, ProviderAccountUsageSnapshotSchema, ProviderDescriptorSchema, capabilityNames } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { mobileAccountUsageStale, mobileAccountUsageWindows, mobileProviderUsageIdentity, mobileProviderUsageSupported, mobileUsageTimestamp } from "./mobile-account-usage";

const now = 1_800_000_000_000;
const timestamp = (millis: number) => ({ seconds: BigInt(Math.floor(millis / 1000)), nanos: millis % 1000 * 1_000_000 });

describe("Mobile account usage", () => {
  it("keeps overall and exact model limits including exhausted buckets and hides expired or invalid windows", () => {
    const snapshot = create(ProviderAccountUsageSnapshotSchema, { providerId: "provider", observedAt: timestamp(now),
      primaryWindow: { usedPercent: 80, windowMinutes: 300, resetAt: timestamp(now + 1000) },
      secondaryWindow: { usedPercent: 5, resetAt: timestamp(now) },
      buckets: [
        { id: "other-limit", displayName: "Other limit", secondaryWindow: { usedPercent: 100 } },
        { id: "invalid", primaryWindow: { usedPercent: -1 } },
        { id: "duplicate", primaryWindow: { usedPercent: 10 } }, { id: "duplicate", primaryWindow: { usedPercent: 20 } }
      ], modelWindows: [
        { modelId: "model-a", displayName: "Exact model", window: { usedPercent: 30 } },
        { modelId: "model-a-variant", displayName: "Other model", window: { usedPercent: 90 } },
        { displayName: "model-a", window: { usedPercent: 99 } }
      ] });
    expect(mobileAccountUsageWindows(snapshot, "model-a", now)).toEqual([
      { id: "primary", minutes: 300, remainingPercent: 20, resetAt: now + 1000, model: false },
      { id: "bucket:other-limit:secondary", label: "Other limit", remainingPercent: 0, model: false },
      { id: "model:0", label: "Exact model", remainingPercent: 70, model: true }
    ]);
    expect(mobileAccountUsageWindows(snapshot, "model-a", now + 1000).some(row => row.id === "primary")).toBe(false);
    expect(mobileAccountUsageWindows(snapshot, undefined, now).some(row => row.model)).toBe(false);
    expect(mobileAccountUsageStale(snapshot, now)).toBe(false);
    expect(mobileAccountUsageStale(snapshot, now + 5 * 60_000 + 1)).toBe(true);
    expect(mobileAccountUsageStale(create(ProviderAccountUsageSnapshotSchema), now)).toBe(true);
  });

  it("accepts the formal zero Provider generation while fencing quota by auth and revision", () => {
    const provider = create(ProviderDescriptorSchema, { backendId: "backend", providerId: "provider", authenticationState: AuthenticationState.AUTHENTICATED,
      version: { generation: 0n, revision: { value: 3n } }, capabilities: { schemaVersion: "joko.provider.v1", capabilities: [
        { name: capabilityNames.providerAccountUsage, support: CapabilitySupport.SUPPORTED }
      ] } });
    expect(mobileProviderUsageSupported(provider)).toBe(true);
    expect(mobileProviderUsageSupported({ ...provider, authenticationState: AuthenticationState.SIGNED_OUT })).toBe(false);
    expect(mobileProviderUsageSupported({ ...provider, version: undefined })).toBe(false);
    expect(mobileProviderUsageSupported({ ...provider, capabilities: undefined })).toBe(false);
    expect(mobileProviderUsageIdentity(provider)).not.toBe(mobileProviderUsageIdentity(create(ProviderDescriptorSchema, { ...provider,
      version: create(EntityVersionSchema, { generation: 0n, revision: { value: 4n } }) })));
    expect(mobileUsageTimestamp({ seconds: -1n, nanos: 0 })).toBeUndefined();
    expect(mobileUsageTimestamp({ seconds: 8_640_000_000_000n, nanos: 999_000_000 })).toBeUndefined();
  });
});
