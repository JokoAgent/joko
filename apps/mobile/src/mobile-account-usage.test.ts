import { create } from "@bufbuild/protobuf";
import { AuthenticationState, CapabilitySupport, EntityVersionSchema, ProviderAccountUsageSnapshotSchema, ProviderDescriptorSchema, capabilityNames } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { mobileAccountUsageStale, mobileAccountUsageWindows, mobileCodexWeeklyUsageWindow, mobileProviderUsageIdentity, mobileProviderUsageSupported, mobileUsageTimestamp } from "./mobile-account-usage";

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

  it("uses the exact or longest matching Codex quota bucket before the generic weekly bucket", () => {
    const snapshot = create(ProviderAccountUsageSnapshotSchema, { providerId: "account", buckets: [
      { id: "__default__", secondaryWindow: { usedPercent: 30, windowMinutes: 10_080 } },
      { id: "codex", displayName: "Codex", secondaryWindow: { usedPercent: 20, windowMinutes: 10_080 } },
      { id: "gpt-codex", displayName: "GPT-5.3-Codex", primaryWindow: { usedPercent: 70, windowMinutes: 10_080 } },
      { id: "gpt-codex-spark", displayName: "GPT 5.3 Codex Spark", primaryWindow: { usedPercent: 99, windowMinutes: 300 },
        secondaryWindow: { usedPercent: 90, windowMinutes: 10_080, resetAt: timestamp(now + 60_000) } },
      { id: "other", secondaryWindow: { usedPercent: 99, windowMinutes: 10_080 } }
    ] });
    for (const modelId of ["gpt-5.3-codex-spark", "openai/gpt-5.3-codex-spark-2026"]) {
      expect(mobileCodexWeeklyUsageWindow(snapshot, modelId, now)).toMatchObject({ remainingPercent: 10, resetAt: now + 60_000 });
    }
    expect(mobileCodexWeeklyUsageWindow(snapshot, "gpt-5.3-codex", now)).toMatchObject({ remainingPercent: 30 });
    expect(mobileCodexWeeklyUsageWindow(snapshot, "another-codex-model", now)).toMatchObject({ remainingPercent: 80 });
    expect(mobileCodexWeeklyUsageWindow({ ...snapshot, buckets: [snapshot.buckets[0]!] }, "model", now)).toMatchObject({ remainingPercent: 70 });
    expect(mobileCodexWeeklyUsageWindow(snapshot, "gpt-5.3-codex-spark", now + 60_000)).toBeUndefined();
  });

  it("uses a top-level Codex weekly window only in the absence of bucket facts", () => {
    const snapshot = create(ProviderAccountUsageSnapshotSchema, { providerId: "account",
      primaryWindow: { usedPercent: 4, windowMinutes: 300 }, secondaryWindow: { usedPercent: 100, windowMinutes: 10_080 } });
    expect(mobileCodexWeeklyUsageWindow(snapshot, "model", now)).toMatchObject({ remainingPercent: 0 });
    expect(mobileCodexWeeklyUsageWindow({ ...snapshot, secondaryWindow: undefined }, "model", now)).toBeUndefined();
    const buckets = create(ProviderAccountUsageSnapshotSchema, { buckets: [
      { id: "unnamed-model", secondaryWindow: { usedPercent: 99, windowMinutes: 10_080 } },
      { id: "other", displayName: "Another model", secondaryWindow: { usedPercent: 98, windowMinutes: 10_080 } }
    ] }).buckets;
    expect(mobileCodexWeeklyUsageWindow({ ...snapshot, buckets }, "model", now)).toBeUndefined();
    expect(mobileCodexWeeklyUsageWindow({ ...snapshot, buckets: [buckets[0]!, { ...buckets[1]!, id: "unnamed-model", displayName: "model" }] },
      "model", now)).toBeUndefined();
  });

  it("drops a retired matching Codex bucket and uses the reported generic weekly limit", () => {
    const snapshot = create(ProviderAccountUsageSnapshotSchema, { buckets: [
      { id: "codex", secondaryWindow: { usedPercent: 20, windowMinutes: 10_080 } },
      { id: "old", displayName: "Model", secondaryWindow: { usedPercent: 90, windowMinutes: 10_080, resetAt: timestamp(now - 86_401_000) } }
    ] });
    expect(mobileCodexWeeklyUsageWindow(snapshot, "model", now)).toMatchObject({ remainingPercent: 80 });
  });

  it("selects an active weekly family window only for the admitted Claude task summary", () => {
    const snapshot = create(ProviderAccountUsageSnapshotSchema, { providerId: "account",
      primaryWindow: { usedPercent: 20, windowMinutes: 300 }, secondaryWindow: { usedPercent: 40, windowMinutes: 10_080 },
      modelWindows: [
        { modelId: "claude-sonnet-4", displayName: "Opus label on another family", window: { usedPercent: 93, windowMinutes: 10_080 } },
        { displayName: "Opus expired", window: { usedPercent: 97, windowMinutes: 10_080, resetAt: timestamp(now) } },
        { displayName: "Opus short window", window: { usedPercent: 98, windowMinutes: 300 } },
        { displayName: "Claude Opus 4", window: { usedPercent: 100, windowMinutes: 10_080, resetAt: timestamp(now + 1000) } },
        { displayName: "Fable", window: { usedPercent: 90, windowMinutes: 10_080 } },
        { modelId: "claude-opus-4-exact", displayName: "Exact Opus", window: { usedPercent: 30, windowMinutes: 10_080 } }
      ] });
    const model = "claude-opus-4[1m]";
    expect(mobileAccountUsageWindows(snapshot, model, now).map(row => row.remainingPercent)).toEqual([80, 60]);
    expect(mobileAccountUsageWindows(snapshot, model, now, "claude-family").map(row => row.remainingPercent)).toEqual([80, 60, 0]);
    expect(mobileAccountUsageWindows(snapshot, "claude-opus-4-exact", now, "claude-family").at(-1)).toMatchObject({ label: "Exact Opus", remainingPercent: 70 });
    expect(mobileAccountUsageWindows(snapshot, "claude-fable-5[opus]", now, "claude-family").at(-1)).toMatchObject({ label: "Fable", remainingPercent: 10 });
    const withoutExact = { ...snapshot, modelWindows: snapshot.modelWindows.slice(0, -1) };
    expect(mobileAccountUsageWindows(withoutExact, model, now + 1000, "claude-family").map(row => row.remainingPercent)).toEqual([80, 60]);
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
