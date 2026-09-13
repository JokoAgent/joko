import { describe, expect, it } from "vitest";

import { routeFromHash, sessionRouteHash } from "./controller.js";
import {
  machineCacheFromSnapshot,
  normalizeMachineCache,
  normalizeMachineSelection,
  selectedReachableRemoteProfileIds,
  selectedMachineProfileIds,
  selectedRemoteMachineCaches,
  toggleMachineProfile
} from "./machine-federation.js";
import { emptySnapshot, type AppSnapshot, type ConnectionProfile, type MachineCacheView } from "./model.js";
import { sessionTaskLink } from "./session-window-navigation.js";

const profiles: readonly ConnectionProfile[] = [
  connection("local", "Local", "http://127.0.0.1:4319"),
  connection("remote-a", "Alpha", "https://alpha.example.test"),
  connection("remote-b", "Beta", "https://beta.example.test")
];

describe("machine federation selection", () => {
  it("normalizes invalid input to the default all-machines scope and bounds explicit identities", () => {
    expect(normalizeMachineSelection(undefined)).toBe("all");
    expect(normalizeMachineSelection([])).toBe("all");
    expect(normalizeMachineSelection(["remote-a", "remote-a", "bad\nidentity", "x".repeat(257), 42])).toEqual(["remote-a"]);

    const oversized = Array.from({ length: 80 }, (_, index) => `machine-${index}`);
    const normalized = normalizeMachineSelection(oversized);
    expect(normalized).not.toBe("all");
    expect(normalized).toHaveLength(64);
    expect(normalized).toEqual(oversized.slice(0, 64));
  });

  it("treats all as the default scope and toggles explicit membership in stable profile order", () => {
    expect(selectedMachineProfileIds("all", profiles)).toEqual(["local", "remote-a", "remote-b"]);
    expect(selectedMachineProfileIds(["missing", "remote-b", "local"], profiles)).toEqual(["remote-b", "local"]);

    expect(toggleMachineProfile("all", "remote-a", profiles)).toEqual(["remote-a"]);
    expect(toggleMachineProfile(["remote-b"], "local", profiles)).toEqual(["local", "remote-b"]);
    expect(toggleMachineProfile(["local", "remote-a"], "remote-b", profiles)).toBe("all");
    expect(toggleMachineProfile(["remote-b"], "remote-b", profiles)).toBe("all");
  });

  it("selects only authenticated live remote profiles for content operations", () => {
    expect(selectedReachableRemoteProfileIds(
      "all",
      profiles,
      "local",
      { local: "current", "remote-a": "online", "remote-b": "offline" },
      new Set(["remote-a", "remote-b"])
    )).toEqual(["remote-a"]);
    expect(selectedReachableRemoteProfileIds(
      ["remote-a", "remote-b"],
      profiles,
      "local",
      { "remote-a": "accessDenied", "remote-b": "identityMismatch" },
      new Set(["remote-a", "remote-b"])
    )).toEqual([]);
    expect(selectedReachableRemoteProfileIds(
      ["remote-a"],
      profiles,
      "local",
      { "remote-a": "online" },
      new Set()
    )).toEqual([]);
  });
});

describe("machine federation cache", () => {
  it("creates a content-light, newest-first cache with stable ties and a 500-task bound", () => {
    const sessions = Array.from({ length: 505 }, (_, index) => session(`task-${String(index).padStart(3, "0")}`, index));
    sessions.push(session("tie-z", 1_000), session("tie-a", 1_000));
    const snapshot: AppSnapshot = {
      ...emptySnapshot(),
      server: { name: "Authoritative node", version: "1", health: "healthy" },
      targets: [{ id: "target-1", name: "Workspace A" } as AppSnapshot["targets"][number]],
      sessions: sessions.map((candidate) => candidate.id === "tie-a" ? {
        ...candidate,
        attention: {
          kind: "awaiting",
          unread: true,
          subjectCursor: { opaqueToken: "subject", sequence: 1n, generation: 1n },
          attentionCursor: { opaqueToken: "attention", sequence: 2n, generation: 1n },
          readThroughCursor: { opaqueToken: "read", sequence: 0n, generation: 1n },
          updatedAt: 2
        }
      } : candidate),
      interactions: [{
        id: "interaction-1",
        sessionId: "tie-a",
        generation: 1n,
        kind: "permission",
        title: "Permission",
        message: "",
        options: [],
        fields: [],
        planSteps: [],
        createdAt: 2
      }]
    };

    const cache = machineCacheFromSnapshot(
      { ...profiles[1]!, name: `  ${"n".repeat(600)}  ` },
      snapshot,
      42
    );

    expect(cache.updatedAt).toBe(42);
    expect(cache.name).toHaveLength(512);
    expect(cache.sessions).toHaveLength(500);
    expect(cache.sessions.slice(0, 2).map((candidate) => candidate.id)).toEqual(["tie-a", "tie-z"]);
    expect(cache.sessions.at(-1)?.id).toBe("task-007");
    expect(cache.sessions[0]).toMatchObject({ targetName: "Workspace A", pinned: false, archived: false });
    expect(cache.sessions.find((candidate) => candidate.id === "tie-a")).toMatchObject({
      attentionKind: "awaiting",
      attentionUnread: true,
      interactionKind: "permission"
    });
  });

  it("accepts only complete current cache records", () => {
    const rawSessions = Array.from({ length: 500 }, (_, index) => ({
        id: `cached-${index}`,
        name: `Task ${index}`,
        state: "closed",
        pinned: false,
        archived: index % 2 === 0,
        lastActivityAt: index
      } as const));

    const cache = normalizeMachineCache({
      profileId: "remote-a",
      serverId: "server-a",
      name: "Remote A",
      origin: "https://alpha.example.test",
      updatedAt: 123,
      sessions: rawSessions
    });

    expect(cache).toBeDefined();
    expect(cache?.name).toBe("Remote A");
    expect(cache?.sessions).toHaveLength(500);
    expect(normalizeMachineCache({ ...cache, name: " Remote A " })).toBeUndefined();
    expect(normalizeMachineCache({ ...cache, sessions: [...rawSessions, rawSessions[0]] })).toBeUndefined();
    expect(normalizeMachineCache({ ...cache, sessions: [{ ...rawSessions[0], state: "unknown" }] })).toBeUndefined();
    expect(normalizeMachineCache({ ...cache, sessions: [{ ...rawSessions[0], lastActivityAt: undefined }] })).toBeUndefined();
    expect(normalizeMachineCache({ profileId: "bad\nid", origin: "https://example.test", updatedAt: 0, sessions: [] })).toBeUndefined();
  });

  it("sorts selected remote shards stably while retaining an offline cache", () => {
    const caches: readonly MachineCacheView[] = [
      cache("remote-b", "alpha"),
      cache("local", "Local"),
      cache("remote-a", "Alpha")
    ];

    expect(selectedRemoteMachineCaches(caches, "local", "all", profiles).map((candidate) => candidate.profileId))
      .toEqual(["remote-a", "remote-b"]);
    expect(selectedRemoteMachineCaches(caches, "local", ["remote-b"], profiles).map((candidate) => candidate.profileId))
      .toEqual(["remote-b"]);
  });
});

describe("machine-aware task routes", () => {
  it("keeps the selected machine on the task home route across refresh", () => {
    const route = { kind: "session" as const, profileId: "remote-a" };
    const hash = sessionRouteHash(route);

    expect(hash).toBe("#/tasks/?profile=remote-a");
    expect(routeFromHash(hash)).toEqual(route);
  });

  it("round-trips the profile and task tuple through the hash and a sanitized task link", () => {
    const route = {
      kind: "session" as const,
      profileId: "machine east/1",
      sessionId: "task /?#% 1"
    };
    const hash = sessionRouteHash(route);
    expect(routeFromHash(hash)).toEqual(route);

    const link = sessionTaskLink(
      { href: "https://user:password@example.test/app/index.html?credential=secret#/settings" },
      route.sessionId,
      route.profileId
    );
    const parsed = new URL(link);
    expect(parsed.username).toBe("");
    expect(parsed.password).toBe("");
    expect(parsed.search).toBe("");
    expect(parsed.pathname).toBe("/app/index.html");
    expect(routeFromHash(parsed.hash)).toEqual(route);
  });
});

function connection(id: string, name: string, origin: string): ConnectionProfile {
  return { id, deviceId: `device-${id}`, name, origin, serverId: `server-${id}` };
}

function session(id: string, updatedAt: number): AppSnapshot["sessions"][number] {
  return {
    id,
    backendId: "backend-1",
    targetId: "target-1",
    name: `Task ${id}`,
    state: "idle",
    pinned: false,
    archived: false,
    generation: 1n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt
  };
}

function cache(profileId: string, name: string): MachineCacheView {
  return {
    profileId,
    serverId: `server-${profileId}`,
    name,
    origin: `https://${profileId}.example.test`,
    updatedAt: 1,
    sessions: []
  };
}
