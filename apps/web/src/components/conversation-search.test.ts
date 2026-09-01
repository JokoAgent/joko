import { describe, expect, it } from "vitest";
import type { SessionMessageSearchMatchView, SessionView, TargetView } from "../model.js";
import {
  conversationSearchHighlightRanges,
  flattenConversationSearchOptions,
  moveConversationSearchSelection,
  projectConversationSearchResults,
  resolveConversationSearchActivation
} from "./conversation-search.js";

const targets: readonly TargetView[] = [target("alpha", "Alpha"), target("beta", "Beta")];
const sessions: readonly SessionView[] = [
  session("one", "Queue cleanup", "alpha", 20),
  session("two", "Release notes", "alpha", 30),
  session("three", "Unrelated", "beta", 10)
];

describe("conversation search projection", () => {
  it("groups durable hits under their task, de-duplicates events, and keeps three ranked positions", () => {
    const results = projectConversationSearchResults(sessions, targets, [
      hit("two", "event-low", "queue later", 1, 10),
      hit("two", "event-high", "queue first", 4, 20),
      hit("two", "event-high", "duplicate", 99, 30),
      hit("two", "event-third", "queue third", 3, 15),
      hit("two", "event-fourth", "queue fourth", 2, 12)
    ], "queue", { kind: "owner" }, "relevance");

    expect(results.map((result) => result.session.id)).toEqual(["one", "two"]);
    expect(results[1]?.hits.map((value) => value.eventId)).toEqual(["event-high", "event-third", "event-fourth", "event-low"]);
    expect(flattenConversationSearchOptions(results).map((option) => option.key)).toEqual([
      "session:one",
      "session:two",
      "message:two:event-high",
      "message:two:event-third",
      "message:two:event-fourth",
      "expand:two"
    ]);
    expect(flattenConversationSearchOptions(results, new Set(["two"])).map((option) => option.key)).toContain("message:two:event-low");
  });

  it("honors exact session and target scopes for both title and message results", () => {
    const matches = [hit("one", "event-one", "queue", 1, 10), hit("three", "event-three", "queue", 2, 10)];
    expect(projectConversationSearchResults(sessions, targets, matches, "queue", { kind: "session", sessionId: "three" }, "relevance").map((result) => result.session.id)).toEqual(["three"]);
    expect(projectConversationSearchResults(sessions, targets, matches, "queue", { kind: "target", targetId: "alpha" }, "relevance").map((result) => result.session.id)).toEqual(["one"]);
  });

  it("treats project names as filter metadata instead of title matches", () => {
    expect(projectConversationSearchResults(
      sessions,
      targets,
      [],
      "Alpha",
      { kind: "owner" },
      "relevance"
    )).toEqual([]);
  });

  it("opens the best message from a parent result row and the task only for title-only results", () => {
    const withHit = projectConversationSearchResults(
      sessions,
      targets,
      [hit("two", "event-best", "queue content", 5, 10)],
      "queue",
      { kind: "owner" },
      "relevance"
    ).find((result) => result.session.id === "two")!;
    expect(resolveConversationSearchActivation({ key: "session:two", kind: "session", result: withHit })).toEqual({
      kind: "message",
      hit: withHit.hits[0]
    });

    const titleOnly = projectConversationSearchResults(
      sessions,
      targets,
      [],
      "Release",
      { kind: "owner" },
      "relevance"
    )[0]!;
    expect(resolveConversationSearchActivation({ key: "session:two", kind: "session", result: titleOnly })).toEqual({
      kind: "session",
      session: titleOnly.session
    });
  });

  it("sorts by activity without changing the result set", () => {
    const matches = [hit("two", "event-two", "queue", 9, 10), hit("three", "event-three", "queue", 10, 10)];
    expect(projectConversationSearchResults(sessions, targets, matches, "queue", { kind: "owner" }, "activityDesc").map((result) => result.session.id)).toEqual(["two", "one", "three"]);
    expect(projectConversationSearchResults(sessions, targets, matches, "queue", { kind: "owner" }, "activityAsc").map((result) => result.session.id)).toEqual(["three", "one", "two"]);
  });

  it("caps the shared result projection at 24 conversations", () => {
    const manySessions = Array.from({ length: 30 }, (_, index) => session(
      `session-${index}`,
      `Needle ${index}`,
      "alpha",
      index
    ));
    expect(projectConversationSearchResults(
      manySessions,
      targets,
      [],
      "needle",
      { kind: "owner" },
      "relevance"
    )).toHaveLength(24);
  });

  it("filters active and archived tasks independently while defaulting to all", () => {
    const candidates = [
      session("active", "Needle active", "alpha", 100),
      session("archived", "Needle archived", "alpha", 200, { archived: true })
    ];

    expect(projectConversationSearchResults(
      candidates,
      targets,
      [],
      "needle",
      { kind: "owner" },
      "activityDesc"
    ).map((result) => result.session.id)).toEqual(["archived", "active"]);
    expect(projectConversationSearchResults(
      candidates,
      targets,
      [],
      "needle",
      { kind: "owner" },
      "relevance",
      24,
      { status: "active" },
      1_000
    ).map((result) => result.session.id)).toEqual(["active"]);
    expect(projectConversationSearchResults(
      candidates,
      targets,
      [],
      "needle",
      { kind: "owner" },
      "relevance",
      24,
      { status: "archived" },
      1_000
    ).map((result) => result.session.id)).toEqual(["archived"]);
  });

  it("filters by one dynamically discovered backend without naming backend kinds", () => {
    const candidates = [
      session("first", "Needle", "alpha", 100, { backendId: "backend-a" }),
      session("second", "Needle", "alpha", 200, { backendId: "backend-b" })
    ];

    expect(projectConversationSearchResults(
      candidates,
      targets,
      [],
      "needle",
      { kind: "owner" },
      "relevance",
      24,
      { backendId: "backend-a" },
      1_000
    ).map((result) => result.session.id)).toEqual(["first"]);
    expect(projectConversationSearchResults(
      candidates,
      targets,
      [],
      "needle",
      { kind: "owner" },
      "relevance",
      24,
      { backendId: "all" },
      1_000
    ).map((result) => result.session.id)).toEqual(["second", "first"]);
  });

  it("includes the exact last-activity boundary and excludes the preceding millisecond", () => {
    const nowMs = 40 * 24 * 60 * 60 * 1_000;
    const cutoff = nowMs - 3 * 24 * 60 * 60 * 1_000;
    const candidates = [
      session("boundary", "Needle", "alpha", cutoff),
      session("too-old", "Needle", "alpha", cutoff - 1),
      session("recent", "Needle", "alpha", cutoff + 1)
    ];

    expect(projectConversationSearchResults(
      candidates,
      targets,
      [],
      "needle",
      { kind: "owner" },
      "activityAsc",
      24,
      { lastActivity: "3d" },
      nowMs
    ).map((result) => result.session.id)).toEqual(["boundary", "recent"]);
  });

  it("supports multi-target selection and intersects it with the existing scope", () => {
    const candidates = [
      session("alpha-task", "Needle", "alpha", 100),
      session("beta-task", "Needle", "beta", 200),
      session("gamma-task", "Needle", "gamma", 300)
    ];
    const allTargets = [...targets, target("gamma", "Gamma")];
    const filters = { targetIds: ["alpha", "beta"] } as const;

    expect(projectConversationSearchResults(
      candidates,
      allTargets,
      [],
      "needle",
      { kind: "owner" },
      "activityDesc",
      24,
      filters,
      1_000
    ).map((result) => result.session.id)).toEqual(["beta-task", "alpha-task"]);
    expect(projectConversationSearchResults(
      candidates,
      allTargets,
      [],
      "needle",
      { kind: "target", targetId: "beta" },
      "relevance",
      24,
      filters,
      1_000
    ).map((result) => result.session.id)).toEqual(["beta-task"]);
    expect(projectConversationSearchResults(
      candidates,
      allTargets,
      [],
      "needle",
      { kind: "target", targetId: "gamma" },
      "relevance",
      24,
      filters,
      1_000
    )).toEqual([]);
  });

  it("intersects every filter dimension", () => {
    const nowMs = 10 * 24 * 60 * 60 * 1_000;
    const recent = nowMs - 24 * 60 * 60 * 1_000;
    const candidates = [
      session("match", "Needle", "beta", recent, { archived: true, backendId: "backend-b" }),
      session("active", "Needle", "beta", recent, { backendId: "backend-b" }),
      session("backend", "Needle", "beta", recent, { archived: true, backendId: "backend-a" }),
      session("old", "Needle", "beta", recent - 2 * 24 * 60 * 60 * 1_000 - 1, { archived: true, backendId: "backend-b" }),
      session("target", "Needle", "alpha", recent, { archived: true, backendId: "backend-b" })
    ];

    expect(projectConversationSearchResults(
      candidates,
      targets,
      [],
      "needle",
      { kind: "owner" },
      "relevance",
      24,
      {
        status: "archived",
        backendId: "backend-b",
        lastActivity: "3d",
        targetIds: ["beta"]
      },
      nowMs
    ).map((result) => result.session.id)).toEqual(["match"]);
  });

  it("applies filters before the 24-conversation result cap", () => {
    const excluded = Array.from({ length: 30 }, (_, index) => session(
      `excluded-${index}`,
      "Needle",
      "alpha",
      1_000 + index
    ));
    const included = [
      session("included-one", "Needle", "beta", 2),
      session("included-two", "Needle", "beta", 1)
    ];

    expect(projectConversationSearchResults(
      [...excluded, ...included],
      targets,
      [],
      "needle",
      { kind: "owner" },
      "activityDesc",
      24,
      { targetIds: ["beta"] },
      2_000
    ).map((result) => result.session.id)).toEqual(["included-one", "included-two"]);
  });

  it("does not mutate inputs and resolves complete sort ties by session id", () => {
    const tiedSessions = Object.freeze([
      Object.freeze(session("second", "Needle", "alpha", 100)),
      Object.freeze(session("first", "Needle", "alpha", 100))
    ]);
    const frozenTargets = Object.freeze(targets.map((value) => Object.freeze(value)));
    const frozenMatches = Object.freeze([
      Object.freeze(hit("first", "later", "needle", 1, 20)),
      Object.freeze(hit("first", "earlier", "needle", 2, 10))
    ]);
    const sessionOrderBefore = tiedSessions.map((value) => value.id);
    const matchOrderBefore = frozenMatches.map((value) => value.eventId);

    const results = projectConversationSearchResults(
      tiedSessions,
      frozenTargets,
      frozenMatches,
      "needle",
      { kind: "owner" },
      "activityDesc",
      24,
      { status: "all", backendId: "all", lastActivity: "all", targetIds: "all" },
      1_000
    );

    expect(results.map((result) => result.session.id)).toEqual(["first", "second"]);
    expect(results[0]?.hits.map((value) => value.eventId)).toEqual(["earlier", "later"]);
    expect(tiedSessions.map((value) => value.id)).toEqual(sessionOrderBefore);
    expect(frozenMatches.map((value) => value.eventId)).toEqual(matchOrderBefore);
  });

});

describe("conversation search keyboard and scope semantics", () => {
  it("wraps Arrow navigation and resolves Home/End positions", () => {
    expect(moveConversationSearchSelection(-1, 3, "next")).toBe(0);
    expect(moveConversationSearchSelection(-1, 3, "previous")).toBe(2);
    expect(moveConversationSearchSelection(2, 3, "next")).toBe(0);
    expect(moveConversationSearchSelection(0, 3, "previous")).toBe(2);
    expect(moveConversationSearchSelection(1, 3, "first")).toBe(0);
    expect(moveConversationSearchSelection(1, 3, "last")).toBe(2);
    expect(moveConversationSearchSelection(0, 0, "next")).toBe(-1);
  });

  it("highlights every non-overlapping Unicode keyword token", () => {
    expect(conversationSearchHighlightRanges("Fix queue then RELEASE queue", "release queue")).toEqual([
      { start: 4, end: 9 },
      { start: 15, end: 22 },
      { start: 23, end: 28 }
    ]);
    expect(conversationSearchHighlightRanges("release", "release lease")).toEqual([{ start: 0, end: 7 }]);
  });
});

function target(id: string, name: string): TargetView {
  return {
    id,
    backendId: "backend",
    name,
    workspaceId: `workspace-${id}`,
    workspaceName: name,
    trusted: true,
    pinned: false,
    archived: false,
  };
}

function session(
  id: string,
  name: string,
  targetId: string,
  updatedAt: number,
  overrides: Partial<SessionView> = {}
): SessionView {
  return {
    id,
    backendId: "backend",
    targetId,
    name,
    state: "idle",
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    pinned: false,
    archived: false,
    updatedAt,
    ...overrides,
    generation: overrides.generation ?? 0n
  };
}

function hit(sessionId: string, eventId: string, snippet: string, score: number, createdAt: number): SessionMessageSearchMatchView {
  return { sessionId, eventId, timelineItemId: `item-${eventId}`, role: "assistant", kind: "textMessage", snippet, score, createdAt };
}
