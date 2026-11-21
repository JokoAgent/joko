import { create } from "@bufbuild/protobuf";
import { ProviderAccountUsageSnapshotSchema, ProviderDescriptorSchema, SessionSchema, SessionState, SnapshotSchema, UsageHistorySchema } from "@joko/contracts";
import { afterEach, expect, it, vi } from "vitest";
import type { MobileState, SavedMobileConnection } from "./mobile-client";
import { homeSurfaceActivity, homeSurfaceOwner, readHomeSurfaceUsage, type HomeSurfaceUsageSource } from "./mobile-home-surfaces";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));
afterEach(() => vi.useRealTimers());

const paired: SavedMobileConnection = {
  profileId: "personal-connection", serverId: "paired-node", deviceId: "trusted-phone", connectionId: "paired-connection",
  origin: "https://paired.test", displayName: "Paired computer", automatic: true, credentialState: "available", pendingOperations: []
};

const state = (overrides: Partial<MobileState> = {}): MobileState => ({
  status: "connected", activeProfileId: paired.profileId, saved: [paired], ...overrides
} as MobileState);

it("retains the same cold WidgetKit owner during reconnect and clears revoked or missing credentials", () => {
  const owner = homeSurfaceOwner(state());
  expect(owner).toMatch(/^[a-f0-9]{64}$/u);
  expect(homeSurfaceOwner(state({ status: "connecting" }))).toBe(owner);
  expect(homeSurfaceOwner(state({ status: "connecting", activeProfileId: undefined, automaticProfileId: paired.profileId }))).toBe(owner);
  expect(homeSurfaceOwner(state({ status: "unpaired", activeProfileId: undefined, automaticProfileId: paired.profileId }))).toBeUndefined();
  expect(homeSurfaceOwner(state({ status: "offline" }))).toBe(owner);
  expect(homeSurfaceOwner(state({ status: "revoked" }))).toBeUndefined();
  expect(homeSurfaceOwner(state({ saved: [{ ...paired, credentialState: "missing" }] }))).toBeUndefined();
  expect(homeSurfaceOwner(state({ saved: [{ ...paired, deviceId: "another-device" }] }))).not.toBe(owner);
});

it("links the pending live activity to its exact owner and skips hidden, side chat or detached tasks", () => {
  const live = { nativeBinding: { runtimeGeneration: 1n, runtimeAttached: true } };
  const history = create(SnapshotSchema, { server: { serverId: paired.serverId }, sessions: [
    create(SessionSchema, { sessionId: "running", state: SessionState.RUNNING, ...live }),
    create(SessionSchema, { sessionId: "approval", displayName: "Approve files", state: SessionState.WAITING, ...live }),
    create(SessionSchema, { sessionId: "hidden", hidden: true, state: SessionState.WAITING, ...live }),
    create(SessionSchema, { sessionId: "side", derivationOrigin: { sideChat: true }, state: SessionState.WAITING, ...live }),
    create(SessionSchema, { sessionId: "detached", state: SessionState.WAITING })
  ] });
  expect(homeSurfaceActivity(state({ owner: history }), "en", 10)).toEqual({
    title: "Approve files", phase: "waiting", locale: "en", expiresAt: 240_010,
    link: "joko://task/approval?profile=personal-connection&server=paired-node"
  });
  expect(homeSurfaceActivity(state({ owner: history, status: "offline" }), "en", 10)).toBeUndefined();
  expect(homeSurfaceActivity(state({ owner: { ...history, server: { ...history.server!, serverId: "another-node" } } }), "en", 10)).toBeUndefined();
});

it("projects fresh account quota and the current UTC ledger day without estimating unknown cost", async () => {
  const now = new Date("2026-11-21T13:00:00.000Z");
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const fresh = create(ProviderDescriptorSchema, { providerId: "quota", displayName: "Quota account" });
  const stale = create(ProviderDescriptorSchema, { providerId: "stale", displayName: "Stale account" });
  const signal = new AbortController();
  const history = create(UsageHistorySchema, { days: [
    { day: "2026-11-20", usage: { totalTokens: 500n } },
    { day: "2026-11-21", usage: { totalTokens: 321n, costMicros: 2_500n }, costComplete: false }
  ] });
  const source: HomeSurfaceUsageSource = {
    key: "owning-connection", catalog: "providers", providers: [fresh, stale],
    readUsage: async () => history,
    readQuota: async provider => create(ProviderAccountUsageSnapshotSchema, {
      providerId: provider.providerId, observedAt: { seconds: BigInt(now.getTime() / 1_000 - (provider === stale ? 1_000 : 0)) },
      primaryWindow: { usedPercent: 25, windowMinutes: 60 },
      secondaryWindow: { usedPercent: 5, windowMinutes: 10, resetAt: { seconds: BigInt(now.getTime() / 1_000 - 10) } }
    })
  };
  expect(await readHomeSurfaceUsage(source, "a".repeat(64), "en", signal.signal)).toEqual({
    owner: "a".repeat(64), locale: "en", expiresAt: now.getTime() + 900_000,
    usage: { day: "2026-11-21", totalTokens: "321" },
    quotas: [{ title: "Quota account · 1h", remaining: 75, resetsAt: undefined }]
  });
  signal.abort();
  await expect(readHomeSurfaceUsage(source, "a".repeat(64), "en", signal.signal)).rejects.toMatchObject({ name: "AbortError" });
});
