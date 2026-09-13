import { describe, expect, it } from "vitest";

import type { MachineCacheView } from "../model.js";
import {
  projectFederatedSidebarSearchGroups,
  projectRemoteMachineSearchOptions,
  projectRemoteMachineSearchResults,
  remoteCachedStatus
} from "./Sidebar.js";
import type { ConversationSearchResult } from "./conversation-search.js";

const now = Date.UTC(2026, 7, 25, 10, 0, 0);
const caches: readonly MachineCacheView[] = [
  {
    profileId: "east",
    serverId: "server-east",
    name: "East workstation",
    origin: "https://east.example.test",
    updatedAt: now,
    sessions: [
      { id: "shared", name: "Release checklist", state: "idle", targetName: "Launch", pinned: false, archived: false, lastActivityAt: now - 1_000 },
      { id: "archived", name: "Prior release", state: "closed", pinned: false, archived: true, lastActivityAt: now - 2_000 }
    ]
  },
  {
    profileId: "west",
    serverId: "server-west",
    name: "West workstation",
    origin: "https://west.example.test",
    updatedAt: now,
    sessions: [
      { id: "shared", name: "Release checklist", state: "running", targetName: "Launch", pinned: true, archived: false, lastActivityAt: now - 3_000 },
      { id: "old", name: "Archived audit", state: "idle", pinned: false, archived: false, lastActivityAt: now - (8 * 24 * 60 * 60 * 1_000) }
    ]
  }
];

describe("remote machine sidebar search", () => {
  it("keeps duplicate task ids distinct by their machine identity", () => {
    const options = projectRemoteMachineSearchOptions(caches, { east: "offline", west: "online" }, "release", filters(), now);

    expect(options.map((option) => option.key)).toEqual(["remote:east:shared", "remote:west:shared"]);
    expect(options.map((option) => option.presence)).toEqual(["offline", "online"]);
  });

  it("searches machine and workspace labels while honoring status and activity filters", () => {
    expect(projectRemoteMachineSearchOptions(caches, {}, "East", filters({ status: "archived" }), now)
      .map((option) => option.session.id)).toEqual(["archived"]);
    expect(projectRemoteMachineSearchOptions(caches, {}, "audit", filters({ lastActivity: "7d" }), now)).toEqual([]);
    expect(projectRemoteMachineSearchOptions(caches, {}, "Launch", filters(), now)
      .map((option) => option.profileId)).toEqual(["east", "west"]);
  });

  it("fails closed when a filter cannot be evaluated from the bounded cache projection", () => {
    expect(projectRemoteMachineSearchOptions(caches, {}, "release", filters({ backendFilterActive: true }), now)).toEqual([]);
    expect(projectRemoteMachineSearchOptions(caches, {}, "release", filters({ projectFilterActive: true }), now)).toEqual([]);
  });

  it("adds live content matches with profile-qualified identities and never treats offline content as cached", () => {
    const options = projectRemoteMachineSearchOptions(caches, { east: "online", west: "offline" }, "deployment", filters({
      messageMatches: [
        liveMatch("east", "server-east", "shared", "east-event", "Deployment ready"),
        liveMatch("west", "server-west", "shared", "west-event", "Deployment blocked")
      ]
    }), now);

    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({ kind: "remoteSession", profileId: "east", hits: [{ snippet: "Deployment ready" }] });
    expect(options[1]).toMatchObject({
      kind: "remoteMessage",
      key: "remote-message:east:shared:east-event",
      profileId: "east",
      source: "live",
      reachable: true,
      match: { snippet: "Deployment ready" }
    });
  });

  it("groups live hits by profile and task, shows three by default, and expands without merging equal ids on another machine", () => {
    const messageMatches = [
      ...Array.from({ length: 5 }, (_, index) => liveMatch("east", "server-east", "shared", `east-${index}`, `Needle east ${index}`)),
      liveMatch("west", "server-west", "shared", "west-0", "Needle west")
    ];
    const collapsed = projectRemoteMachineSearchOptions(caches, { east: "online", west: "online" }, "needle", filters({ messageMatches }), now);
    expect(collapsed.filter((option) => option.kind === "remoteSession")).toHaveLength(2);
    expect(collapsed.filter((option) => option.kind === "remoteMessage" && option.profileId === "east")).toHaveLength(3);
    expect(collapsed).toContainEqual(expect.objectContaining({ kind: "remoteExpand", profileId: "east", hiddenHitCount: 2 }));

    const expanded = projectRemoteMachineSearchOptions(
      caches,
      { east: "online", west: "online" },
      "needle",
      filters({ messageMatches }),
      now,
      new Set(["east\u0000shared"])
    );
    expect(expanded.filter((option) => option.kind === "remoteMessage" && option.profileId === "east")).toHaveLength(5);
    expect(expanded.some((option) => option.kind === "remoteExpand" && option.profileId === "east")).toBe(false);
  });

  it("surfaces a trusted live task before its machine cache refresh arrives", () => {
    const results = projectRemoteMachineSearchResults([], { east: "online" }, "needle", filters({
      profiles: [{ id: "east", deviceId: "device-test", serverId: "server-east", name: "East workstation", origin: "https://east.example.test"  }],
      messageMatches: [liveMatch("east", "server-east", "brand-new", "new-event", "Needle from a new task")]
    }), now);

    expect(results).toEqual([expect.objectContaining({
      profileId: "east",
      machineName: "East workstation",
      source: "live",
      session: expect.objectContaining({ id: "brand-new", name: "brand-new" }),
      hits: [expect.objectContaining({ eventId: "new-event" })]
    })]);
  });

  it("applies filters before one global 24-task cap across local and remote profiles", () => {
    const local = Array.from({ length: 16 }, (_, index) => localResult(`local-${index}`, now - index));
    const remoteCaches: readonly MachineCacheView[] = [{
      profileId: "east",
      serverId: "server-east",
      name: "East",
      origin: "https://east.example.test",
      updatedAt: now,
      sessions: Array.from({ length: 16 }, (_, index) => ({
        id: `remote-${index}`,
        name: `Needle remote ${index}`,
        state: "idle" as const,
        pinned: false,
        archived: index === 15,
        lastActivityAt: now - 100 - index
      }))
    }];
    const activeRemote = projectRemoteMachineSearchResults(remoteCaches, { east: "online" }, "needle", filters(), now);
    const groups = projectFederatedSidebarSearchGroups("local", local, activeRemote, "activityDesc", 24);
    expect(groups).toHaveLength(24);
    expect(new Set(groups.map((group) => group.key)).size).toBe(24);
    expect(groups.some((group) => group.key === "east\u0000remote-15")).toBe(false);

    const archivedRemote = projectRemoteMachineSearchResults(remoteCaches, { east: "online" }, "needle", filters({ status: "archived" }), now);
    expect(archivedRemote.map((result) => result.session.id)).toEqual(["remote-15"]);
  });

  it("marks offline title matches as explicit cache results and hides revoked shards", () => {
    expect(projectRemoteMachineSearchOptions(caches, { east: "offline", west: "accessDenied" }, "release", filters(), now))
      .toEqual([expect.objectContaining({ profileId: "east", source: "cache", reachable: false })]);
  });

  it("projects remote interaction and unread attention into the same rail status vocabulary", () => {
    const base = caches[0]!.sessions[0]!;
    expect(remoteCachedStatus({ ...base, interactionKind: "permission" })).toBe("awaiting");
    expect(remoteCachedStatus({ ...base, attentionKind: "error", attentionUnread: true })).toBe("error");
    expect(remoteCachedStatus({ ...base, attentionKind: "done", attentionUnread: true })).toBe("done");
    expect(remoteCachedStatus({ ...base, state: "running" })).toBe("running");
    expect(remoteCachedStatus(base)).toBeUndefined();
  });
});

function filters(overrides: Partial<Parameters<typeof projectRemoteMachineSearchOptions>[3]> = {}): Parameters<typeof projectRemoteMachineSearchOptions>[3] {
  return {
    status: "active",
    lastActivity: "all",
    backendFilterActive: false,
    projectFilterActive: false,
    sort: "relevance",
    ...overrides
  };
}

function liveMatch(profileId: string, serverId: string, sessionId: string, eventId: string, snippet: string) {
  return {
    profileId,
    serverId,
    source: "live" as const,
    reachable: true as const,
    match: {
      sessionId,
      eventId,
      timelineItemId: `timeline-${eventId}`,
      role: "assistant" as const,
      kind: "textMessage" as const,
      snippet,
      createdAt: now - 500,
      score: 10
    }
  };
}

function localResult(id: string, updatedAt: number): ConversationSearchResult {
  return {
    session: {
      id,
      backendId: "backend",
      targetId: "target",
      name: `Needle ${id}`,
      state: "idle",
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      pinned: false,
      archived: false,
      generation: 0n,
      updatedAt
    },
    titleMatch: { score: 1, nameRanges: [{ start: 0, end: 6 }], targetRanges: [] },
    hits: [],
    score: 1
  };
}
