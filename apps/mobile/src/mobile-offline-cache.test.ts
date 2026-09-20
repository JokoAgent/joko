import { create } from "@bufbuild/protobuf";
import {
  ConnectionSchema,
  ConnectionState,
  DeviceKind,
  DeviceSchema,
  OperationSchema,
  OwnerSnapshotScopeSchema,
  SessionAutomationOriginSchema,
  SessionSchema,
  SessionSnapshotScopeSchema,
  SnapshotSchema,
  SnapshotScopeSchema,
  type Snapshot
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import type { MobileConnectionProfile } from "./connection-storage";
import {
  MobileOfflineCache,
  mobileOfflineAgeLabel,
  type MobileOfflineCacheStorage
} from "./mobile-offline-cache";
import type { NodeIdentity } from "./network";

const profile: MobileConnectionProfile = {
  profileId: "profile-one",
  origin: "https://joko.example.test",
  serverId: "server-one",
  connectionId: "connection-one",
  deviceId: "device-one",
  displayName: "Phone"
};

const node: NodeIdentity = {
  serverId: profile.serverId,
  displayName: "Joko node",
  version: "1.0.0",
  apiVersion: "joko.v1",
  health: 1,
  pairingEnabled: true
};

function owner(sessions = [session("session-one")], generation = 0n): Snapshot {
  return create(SnapshotSchema, {
    snapshotId: `owner-${generation}`,
    scope: create(SnapshotScopeSchema, { kind: { case: "owner", value: create(OwnerSnapshotScopeSchema, {}) } }),
    generation,
    server: { ...node },
    connections: [create(ConnectionSchema, {
      connectionId: profile.connectionId,
      connectionProfileId: profile.profileId,
      deviceId: profile.deviceId,
      displayName: profile.displayName,
      state: ConnectionState.CONNECTED
    })],
    devices: [create(DeviceSchema, {
      deviceId: profile.deviceId,
      displayName: profile.displayName,
      kind: DeviceKind.MOBILE,
      platform: "ios",
      connectionIds: [profile.connectionId]
    })],
    sessions,
    operations: [create(OperationSchema, {
      operationId: "receipt-secret",
      requestSha256Hex: "credential-ticket-secret"
    })]
  });
}

function session(sessionId: string, automated = false, generation = 7n) {
  return create(SessionSchema, {
    sessionId,
    backendId: "backend-one",
    targetId: "target-one",
    displayName: sessionId,
    nativeBinding: { runtimeGeneration: generation },
    ...(automated ? {
      automationOrigin: create(SessionAutomationOriginSchema, {
        scheduleId: "schedule-one",
        scheduleName: "Morning",
        runId: "run-one"
      })
    } : {})
  });
}

function detail(sessionId = "session-one", generation = 7n, text = "saved message"): Snapshot {
  return create(SnapshotSchema, {
    snapshotId: `detail-${sessionId}-${generation}`,
    scope: create(SnapshotScopeSchema, {
      kind: { case: "session", value: create(SessionSnapshotScopeSchema, { sessionId, recentTimelineItems: 120 }) }
    }),
    generation,
    server: { ...node },
    sessions: [create(SessionSchema, { ...session(sessionId, false, generation), taskSummary: text })],
    operations: [create(OperationSchema, {
      operationId: "detail-receipt-secret",
      requestSha256Hex: "detail-credential-ticket-secret"
    })]
  });
}

function memoryStorage() {
  const values = new Map<string, string>();
  let blockDetail = false;
  let failDetailRead = false;
  let reachedDetail: (() => void) | undefined;
  let releaseDetail: (() => void) | undefined;
  const detailReached = new Promise<void>((resolve) => { reachedDetail = resolve; });
  const detailReleased = new Promise<void>((resolve) => { releaseDetail = resolve; });
  const storage: MobileOfflineCacheStorage = {
    async getItem(key) {
      if (failDetailRead && key.includes(".detail.")) {
        failDetailRead = false;
        throw new Error("storage temporarily unavailable");
      }
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      if (blockDetail && key.includes(".detail.")) {
        blockDetail = false;
        reachedDetail?.();
        await detailReleased;
      }
      values.set(key, value);
    },
    async removeItem(key) { values.delete(key); },
    async getAllKeys() { return [...values.keys()]; },
    async multiRemove(keys) { for (const key of keys) values.delete(key); }
  };
  return {
    storage,
    values,
    blockNextDetailWrite() { blockDetail = true; },
    failNextDetailRead() { failDetailRead = true; },
    detailReached,
    releaseDetail() { releaseDetail?.(); }
  };
}

function cacheFixture() {
  const memory = memoryStorage();
  let currentTime = 1_000;
  let sequence = 0;
  const cache = new MobileOfflineCache(memory.storage, () => currentTime, () => `write-${++sequence}`);
  return { memory, cache, tick(value = 1) { currentTime += value; } };
}

describe("current-v1 mobile offline content cache", () => {
  it("round-trips one exact authenticated owner and regular task without credential material", async () => {
    const fixture = cacheFixture();
    await fixture.cache.save(profile, node, owner(), detail());

    const restored = await fixture.cache.load(profile, "session-one");
    expect(restored).toMatchObject({ cachedAt: 1_000, detailCachedAt: 1_000 });
    expect(restored?.owner.snapshotId).toBe("owner-0");
    expect(restored?.detail?.sessions[0]?.taskSummary).toBe("saved message");
    expect(restored?.owner.operations).toEqual([]);
    expect(restored?.detail?.operations).toEqual([]);
    const durable = [...fixture.memory.values.values()].join("\n");
    expect(durable).not.toContain("authKey");
    expect(durable).not.toContain("credential-secret");
    expect(durable).not.toContain("ticket");
  });

  it("does not retain Automation task detail and removes a prior regular copy", async () => {
    const fixture = cacheFixture();
    await fixture.cache.save(profile, node, owner(), detail());
    fixture.tick();
    const automatedOwner = owner([session("session-one", true)]);
    await fixture.cache.save(profile, node, automatedOwner, detail());

    const restored = await fixture.cache.load(profile, "session-one");
    expect(restored?.owner.sessions[0]?.automationOrigin?.scheduleId).toBe("schedule-one");
    expect(restored?.detail).toBeUndefined();
    expect([...fixture.memory.values.keys()].filter((key) => key.includes(".detail."))).toHaveLength(0);
  });

  it("rejects unsupported and cross-authority manifests and retires generation-drifted task detail", async () => {
    const fixture = cacheFixture();
    const manifestKey = "joko.mobile.offline-cache.v1.profile-one.manifest";
    fixture.memory.values.set(manifestKey, JSON.stringify({ version: 0, snapshot: {} }));
    await expect(fixture.cache.load(profile, "session-one")).rejects.toThrow(/current-v1|unsupported shape/u);
    expect(fixture.memory.values.size).toBe(0);

    await fixture.cache.save(profile, node, owner(), detail());
    const manifest = JSON.parse(fixture.memory.values.get(manifestKey)!);
    manifest.identity.connectionId = "connection-other";
    fixture.memory.values.set(manifestKey, JSON.stringify(manifest));
    await expect(fixture.cache.load(profile, "session-one")).rejects.toThrow(/different saved/u);
    expect(fixture.memory.values.size).toBe(0);

    await fixture.cache.save(profile, node, owner(), detail());
    const currentManifest = JSON.parse(fixture.memory.values.get(manifestKey)!);
    const currentDetailKey = currentManifest.details[0].key as string;
    const currentDetail = JSON.parse(fixture.memory.values.get(currentDetailKey)!);
    currentDetail.sessionGeneration = "8";
    const driftedRaw = JSON.stringify(currentDetail);
    fixture.memory.values.set(currentDetailKey, driftedRaw);
    currentManifest.details[0].size = driftedRaw.length;
    fixture.memory.values.set(manifestKey, JSON.stringify(currentManifest));
    const restored = await fixture.cache.load(profile, "session-one");
    expect(restored?.detail).toBeUndefined();
    expect(restored?.warning).toMatch(/damaged/u);
  });

  it("retires a task copy when the owner reports a new native runtime generation", async () => {
    const fixture = cacheFixture();
    await fixture.cache.save(profile, node, owner(), detail());
    fixture.tick();
    await fixture.cache.save(profile, node, owner([session("session-one", false, 8n)]));

    const restored = await fixture.cache.load(profile, "session-one");
    expect(restored?.owner.sessions[0]?.nativeBinding?.runtimeGeneration).toBe(8n);
    expect(restored?.detail).toBeUndefined();
    expect([...fixture.memory.values.keys()].filter((key) => key.includes(".detail."))).toHaveLength(0);
  });

  it("keeps the owner view while removing one damaged task record", async () => {
    const fixture = cacheFixture();
    await fixture.cache.save(profile, node, owner(), detail());
    const detailKey = [...fixture.memory.values.keys()].find((key) => key.includes(".detail."))!;
    fixture.memory.values.set(detailKey, "{damaged");

    const restored = await fixture.cache.load(profile, "session-one");
    expect(restored?.owner.snapshotId).toBe("owner-0");
    expect(restored?.detail).toBeUndefined();
    expect(restored?.warning).toMatch(/damaged/u);
    expect(fixture.memory.values.has(detailKey)).toBe(false);
  });

  it("does not delete valid content after a transient storage read failure", async () => {
    const fixture = cacheFixture();
    await fixture.cache.save(profile, node, owner(), detail());
    const before = new Map(fixture.memory.values);
    fixture.memory.failNextDetailRead();

    const transient = await fixture.cache.load(profile, "session-one");
    expect(transient).toMatchObject({
      owner: { snapshotId: "owner-0" },
      warning: expect.stringMatching(/could not read/u)
    });
    expect(transient?.detail).toBeUndefined();
    expect(fixture.memory.values).toEqual(before);
    await expect(fixture.cache.load(profile, "session-one")).resolves.toMatchObject({
      detail: { snapshotId: "detail-session-one-7" }
    });
  });

  it("bounds regular task details to the sixteen most recently used records even within one clock tick", async () => {
    const fixture = cacheFixture();
    const sessions = Array.from({ length: 17 }, (_, index) => session(`session-${index + 1}`));
    for (let index = 0; index < sessions.length; index += 1) {
      await fixture.cache.save(profile, node, owner(sessions), detail(`session-${index + 1}`));
    }

    expect((await fixture.cache.load(profile, "session-1"))?.detail).toBeUndefined();
    expect((await fixture.cache.load(profile, "session-17"))?.detail?.sessions[0]?.sessionId).toBe("session-17");
    expect([...fixture.memory.values.keys()].filter((key) => key.includes(".detail."))).toHaveLength(16);
  });

  it("keeps a recently opened task ahead of an equally-timestamped LRU eviction", async () => {
    const fixture = cacheFixture();
    const sessions = Array.from({ length: 17 }, (_, index) => session(`session-${index + 1}`));
    for (let index = 0; index < 16; index += 1) {
      await fixture.cache.save(profile, node, owner(sessions), detail(`session-${index + 1}`));
    }
    await expect(fixture.cache.load(profile, "session-1")).resolves.toMatchObject({
      detail: { snapshotId: "detail-session-1-7" }
    });
    await fixture.cache.save(profile, node, owner(sessions), detail("session-17"));

    expect((await fixture.cache.load(profile, "session-1"))?.detail?.sessions[0]?.sessionId).toBe("session-1");
    expect((await fixture.cache.load(profile, "session-2"))?.detail).toBeUndefined();
    expect((await fixture.cache.load(profile, "session-17"))?.detail?.sessions[0]?.sessionId).toBe("session-17");
  });

  it("serializes clear behind an in-flight write so stale bytes cannot resurrect", async () => {
    const fixture = cacheFixture();
    fixture.memory.blockNextDetailWrite();
    const saving = fixture.cache.save(profile, node, owner(), detail());
    await fixture.memory.detailReached;
    const clearing = fixture.cache.clear(profile.profileId);
    fixture.memory.releaseDetail();
    await Promise.all([saving, clearing]);

    expect([...fixture.memory.values.keys()].filter((key) => key.startsWith("joko.mobile.offline-cache.v1.profile-one.")))
      .toEqual([]);
  });

  it("honors a durable retirement tombstone after process loss", async () => {
    const fixture = cacheFixture();
    await fixture.cache.save(profile, node, owner(), detail());
    fixture.memory.values.set("joko.mobile.offline-cache.v1.profile-one.retired", "1");

    await expect(fixture.cache.load(profile, "session-one")).resolves.toBeUndefined();
    expect([...fixture.memory.values.keys()].filter((key) => key.startsWith("joko.mobile.offline-cache.v1.profile-one.")))
      .toEqual([]);
  });

  it("formats a bounded, non-authoritative saved-content age", () => {
    expect(mobileOfflineAgeLabel(10_000, 10_500)).toBe("Saved offline just now");
    expect(mobileOfflineAgeLabel(10_000, 130_000)).toBe("Saved offline 2 min ago");
    expect(mobileOfflineAgeLabel(10_000, 7_210_000)).toBe("Saved offline 2 hr ago");
    expect(mobileOfflineAgeLabel(10_000, 172_810_000)).toBe("Saved offline 2 days ago");
    expect(mobileOfflineAgeLabel(Number.NaN, 10_000)).toBe("Saved offline");
  });
});
