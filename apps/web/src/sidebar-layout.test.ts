import { describe, expect, it } from "vitest";

import type { SessionView, TargetView } from "./model.js";
import {
  DEFAULT_SIDEBAR_OWNER_LAYOUT,
  advanceSidebarViewedPriority,
  createSidebarDoneAttentionVisibilityState,
  createSidebarViewedPriorityState,
  filterSidebarSessions,
  holdSidebarViewedPriorityRank,
  manualSidebarOrderAfterVisibleReorder,
  normalizeManualSidebarOrder,
  normalizeSidebarOwnerLayouts,
  normalizeSidebarDisplayPreferences,
  normalizeSidebarSessionInfoFields,
  promoteNewPinnedSidebarIds,
  reconcileSidebarDoneAttentionVisibility,
  retrySessionAttentionAcknowledgement,
  SessionAttentionAcknowledgementRetryTracker,
  sessionAttentionAcknowledgementRetryDelayMs,
  sidebarGroupIndicatorState,
  sidebarSessionIndicatorState,
  sidebarSessionNaturalPriority,
  sidebarOwnerLayoutFor,
  sortSidebarSessions,
  sortSidebarTargets,
  toggleSidebarProjectFilter,
  toggleSidebarSessionInfoField,
  visibleSidebarAttention,
  viewerAttentionCursor,
  viewerAttentionCursorWhenHistoryReady,
  withSidebarOwnerLayout
} from "./sidebar-layout.js";

describe("owner-scoped sidebar layout", () => {
  it("keeps each Orchestrator owner's custom order and collapsed projects isolated", () => {
    const first = withSidebarOwnerLayout({}, "owner-a", {
      manualProjectOrder: ["target-b", "target-a"],
      collapsedProjectIds: ["target-b"],
      collapsedDialogue: true
    });
    const both = withSidebarOwnerLayout(first, "owner-b", { manualPinnedOrder: ["session-a"] });

    expect(sidebarOwnerLayoutFor(both, "owner-a")).toMatchObject({
      manualProjectOrder: ["target-b", "target-a"],
      collapsedProjectIds: ["target-b"],
      collapsedDialogue: true
    });
    expect(sidebarOwnerLayoutFor(both, "owner-b")).toEqual({
      ...DEFAULT_SIDEBAR_OWNER_LAYOUT,
      manualPinnedOrder: ["session-a"]
    });
    expect(sidebarOwnerLayoutFor(both, "missing")).toBe(DEFAULT_SIDEBAR_OWNER_LAYOUT);
  });

  it("rejects malformed persisted values and bounds opaque identity arrays", () => {
    const restored = normalizeSidebarOwnerLayouts({
      owner: {
        manualProjectOrder: ["target-a", "target-a", "", "bad\nidentity", "target-b"],
        manualPinnedOrder: null,
        collapsedProjectIds: ["target-b"]
      },
      "bad\nowner": { groupBy: "flat" }
    });

    expect(restored).toEqual({
      owner: {
        ...DEFAULT_SIDEBAR_OWNER_LAYOUT,
        manualProjectOrder: ["target-a", "target-b"],
        collapsedProjectIds: ["target-b"]
      }
    });
  });

  it("keeps display choices global", () => {
    expect(normalizeSidebarDisplayPreferences({
      status: "all",
      backendId: "backend-a",
      lastActivity: "7d",
      groupBy: "flat",
      groupDialogue: false,
      groupDevice: false,
      sortBy: "priority",
      projectOrder: "custom",
      mainViewMode: "text",
      pinnedViewMode: "card",
      sessionInfoFields: ["cost", "time", "cost", "pr", "worktree", "unknown"]
    })).toEqual({
      status: "all",
      backendId: "backend-a",
      lastActivity: "7d",
      groupBy: "flat",
      groupDialogue: false,
      groupDevice: false,
      sortBy: "priority",
      projectOrder: "custom",
      mainViewMode: "text",
      pinnedViewMode: "card",
      sessionInfoFields: ["cost", "time", "pr", "worktree"]
    });
  });

  it("defaults display density safely and keeps explicit empty or user-ordered session information", () => {
    expect(normalizeSidebarDisplayPreferences({ mainViewMode: "tiles", pinnedViewMode: "tiles" })).toMatchObject({
      mainViewMode: "list",
      pinnedViewMode: "text",
      sessionInfoFields: ["time"]
    });
    expect(normalizeSidebarSessionInfoFields([])).toEqual([]);
    expect(normalizeSidebarSessionInfoFields(["tokens", "cost", "tokens", null, "pr", "worktree"]))
      .toEqual(["tokens", "cost", "pr", "worktree"]);

    const withoutTime = toggleSidebarSessionInfoField(["time", "tokens"], "time");
    expect(withoutTime).toEqual(["tokens"]);
    expect(toggleSidebarSessionInfoField(withoutTime, "time")).toEqual(["tokens", "time"]);
  });

  it("filters only the main list and keeps project selection non-empty", () => {
    const now = Date.parse("2026-08-27T00:00:00.000Z");
    const project = { ...session("project", "idle", now - 1_000), backendId: "backend-a", projectId: "target-a" };
    const old = { ...session("old", "idle", now - 8 * 86_400_000), backendId: "backend-a", projectId: "target-a" };
    const dialogue = { ...session("dialogue", "idle", now - 1_000), backendId: "backend-a" };
    const other = { ...session("other", "idle", now - 1_000), backendId: "backend-b", projectId: "target-a" };
    expect(filterSidebarSessions([project, old, dialogue, other], {
      backendId: "backend-a",
      lastActivity: "7d",
      projectFilter: ["target-a"]
    }, now).map((candidate) => candidate.id)).toEqual(["project"]);
    expect(toggleSidebarProjectFilter("all", "target-a")).toEqual(["target-a"]);
    expect(toggleSidebarProjectFilter(["target-a"], "target-a")).toBe("all");
  });
});

describe("filtered manual sidebar ordering", () => {
  it("reconciles removals and appends new projects in discovery order", () => {
    expect(normalizeManualSidebarOrder(
      ["removed", "target-c", "target-a", "target-c"],
      ["target-a", "target-b", "target-c", "target-d"]
    )).toEqual(["target-c", "target-a", "target-b", "target-d"]);
  });

  it("reorders only visible slots so archive/search-hidden projects restore exactly", () => {
    expect(manualSidebarOrderAfterVisibleReorder(
      ["active-a", "archived-a", "active-b", "archived-b"],
      ["active-a", "archived-a", "active-b", "archived-b"],
      ["active-b", "active-a"]
    )).toEqual(["active-b", "archived-a", "active-a", "archived-b"]);

    expect(manualSidebarOrderAfterVisibleReorder(
      ["active-b", "archived-a", "active-a", "archived-b"],
      ["active-a", "archived-a", "active-b", "archived-b"],
      ["archived-b", "archived-a"]
    )).toEqual(["active-b", "archived-b", "active-a", "archived-a"]);
  });

  it("promotes a re-pinned task and keeps every other pinned rank stable", () => {
    expect(promoteNewPinnedSidebarIds(
      ["pin-a", "pin-b", "pin-c"],
      ["pin-a", "pin-b", "pin-c"],
      ["pin-c"]
    )).toEqual(["pin-c", "pin-a", "pin-b"]);
  });
});

describe("sidebar task sorting", () => {
  it("uses typed unread awaiting/error, unread done, running, then rest without state guesses", () => {
    const sessions = [
      session("idle-new", "idle", 40),
      session("running", "running", 10),
      { ...session("awaiting", "waiting", 5), attention: attention("awaiting", true, 21n) },
      { ...session("error", "error", 6), attention: attention("error", true, 22n) },
      {
        ...session("done-unread", "idle", 2),
        attention: attention("done", true, 20n)
      },
      session("idle-old", "idle", 20),
      session("raw-waiting-read", "waiting", 30),
      session("raw-error-read", "error", 25)
    ];

    expect(sortSidebarSessions(sessions, "recency").map((item) => item.id)).toEqual([
      "idle-new", "raw-waiting-read", "raw-error-read", "idle-old", "running", "error", "awaiting", "done-unread"
    ]);
    expect(sortSidebarSessions(sessions, "priority").map((item) => item.id)).toEqual([
      "error", "awaiting", "done-unread", "running", "idle-new", "raw-waiting-read", "raw-error-read", "idle-old"
    ]);
    expect(sidebarSessionNaturalPriority(session("waiting", "waiting", 1))).toBe(3);
    expect(sidebarSessionNaturalPriority(session("error", "error", 1))).toBe(3);
  });

  it("orders project rows by activity/priority until custom order takes authority", () => {
    const targets = [target("a"), target("b"), target("c")];
    const sessions = [
      { ...session("a-new", "idle", 50), targetId: "a", projectId: "a" },
      { ...session("b-waiting", "waiting", 10), targetId: "b", projectId: "b", attention: attention("awaiting", true, 30n) },
      { ...session("c-running", "running", 40), targetId: "c", projectId: "c" }
    ];

    expect(sortSidebarTargets(targets, sessions, "recency", "activity", []).map((item) => item.id)).toEqual(["a", "c", "b"]);
    expect(sortSidebarTargets(targets, sessions, "priority", "activity", []).map((item) => item.id)).toEqual(["b", "c", "a"]);
    expect(sortSidebarTargets(targets, sessions, "priority", "custom", ["c", "a", "b"]).map((item) => item.id)).toEqual(["c", "a", "b"]);
  });

  it("holds a clicked unread completion until leave, then places it at the top of rest", () => {
    const state = createSidebarViewedPriorityState();
    const unreadDone = { ...session("done", "idle", 10), attention: attention("done", true, 40n) };
    const readDone = { ...unreadDone, attention: attention("done", false, 40n) };
    const other = session("other", "idle", 900);

    // Click capture happens before navigation/acknowledgement.
    holdSidebarViewedPriorityRank(state, unreadDone);
    advanceSidebarViewedPriority(state, readDone, 500);
    expect(state.heldPriorityRanks.get(readDone.id)).toBe(1);
    expect(sortSidebarSessions([other, readDone], "priority", {
      viewedSessionId: readDone.id,
      heldPriorityRanks: state.heldPriorityRanks,
      recentlyViewedAtMs: state.recentlyViewedAtMs
    }).map((item) => item.id)).toEqual(["done", "other"]);

    const leaveAt = 1_000;
    advanceSidebarViewedPriority(state, other, leaveAt);
    expect(state.heldPriorityRanks.has(readDone.id)).toBe(false);
    expect(state.recentlyViewedAtMs.get(readDone.id)).toBe(leaveAt);
    expect(sortSidebarSessions([other, readDone], "priority", {
      heldPriorityRanks: state.heldPriorityRanks,
      recentlyViewedAtMs: state.recentlyViewedAtMs,
      viewedSessionId: other.id
    }).map((item) => item.id)).toEqual(["done", "other"]);
  });

  it("captures unread rank for direct routes before applying active suppression", () => {
    const state = createSidebarViewedPriorityState();
    const done = { ...session("direct-done", "idle", 10), attention: attention("done", true, 41n) };
    advanceSidebarViewedPriority(state, done, 100);
    expect(state.heldPriorityRanks.get(done.id)).toBe(1);

    const activeDoneAgain = { ...done, attention: attention("done", true, 42n) };
    advanceSidebarViewedPriority(state, activeDoneAgain, 200);
    expect(state.heldPriorityRanks.get(done.id)).toBe(1);
  });

  it("does not capture a hidden done rank on click or direct route before the 500ms reveal", () => {
    const done = { ...session("hidden-done", "idle", 10), attention: attention("done", true, 43n) };
    const visibility = createSidebarDoneAttentionVisibilityState();
    const hidden = reconcileSidebarDoneAttentionVisibility(visibility, [done], 1_000);
    const context = { visibleDoneAttentionKeys: hidden.visibleAttentionKeys };

    const clicked = createSidebarViewedPriorityState();
    holdSidebarViewedPriorityRank(clicked, done, context);
    expect(clicked.heldPriorityRanks.get(done.id)).toBe(3);

    const direct = createSidebarViewedPriorityState();
    advanceSidebarViewedPriority(direct, done, 1_100, context);
    expect(direct.heldPriorityRanks.get(done.id)).toBe(3);
    advanceSidebarViewedPriority(direct, session("other", "idle", 20), 1_200, context);
    expect(direct.recentlyViewedAtMs.has(done.id)).toBe(false);
  });

  it("does not reorder rest tasks merely because they were browsed", () => {
    const state = createSidebarViewedPriorityState();
    const older = session("older", "idle", 10);
    const newer = session("newer", "idle", 20);
    advanceSidebarViewedPriority(state, older, 100);
    advanceSidebarViewedPriority(state, newer, 200);
    expect(state.recentlyViewedAtMs.has(older.id)).toBe(false);
    expect(sortSidebarSessions([older, newer], "priority", {
      heldPriorityRanks: state.heldPriorityRanks,
      recentlyViewedAtMs: state.recentlyViewedAtMs,
      viewedSessionId: newer.id
    }).map((item) => item.id)).toEqual(["newer", "older"]);
  });

  it("suppresses active normal attention synchronously while preserving error and click-held rank", () => {
    const done = { ...session("done", "idle", 10), attention: attention("done", true, 50n) };
    const awaiting = { ...session("awaiting", "waiting", 20), attention: attention("awaiting", true, 51n) };
    const error = { ...session("error", "error", 30), attention: attention("error", true, 52n) };
    expect(sidebarSessionNaturalPriority(done, { viewedSessionId: done.id })).toBe(3);
    expect(sidebarSessionNaturalPriority(awaiting, { viewedSessionId: awaiting.id })).toBe(3);
    expect(sidebarSessionNaturalPriority(error, { viewedSessionId: error.id })).toBe(0);
    expect(viewerAttentionCursor(done)).toEqual(done.attention?.attentionCursor);
    expect(viewerAttentionCursor(awaiting)).toEqual(awaiting.attention?.attentionCursor);
    expect(viewerAttentionCursor(error)).toBeUndefined();

    const state = createSidebarViewedPriorityState();
    holdSidebarViewedPriorityRank(state, done);
    advanceSidebarViewedPriority(state, done, 100);
    expect(state.heldPriorityRanks.get(done.id)).toBe(1);
  });

  it("acknowledges only after exact history initialization and bounds transient retries", () => {
    const done = { ...session("done", "idle", 10), attention: attention("done", true, 50n) };
    const ready = {
      sessionId: done.id,
      generation: 7n,
      initialized: true,
      loading: false
    };
    expect(viewerAttentionCursorWhenHistoryReady(done, 7n, ready)).toEqual(done.attention?.attentionCursor);
    expect(viewerAttentionCursorWhenHistoryReady(done, 8n, ready)).toBeUndefined();
    expect(viewerAttentionCursorWhenHistoryReady(done, 7n, { ...ready, sessionId: "other" })).toBeUndefined();
    expect(viewerAttentionCursorWhenHistoryReady(done, 7n, { ...ready, initialized: false })).toBeUndefined();
    expect(viewerAttentionCursorWhenHistoryReady(done, 7n, { ...ready, loading: true })).toBeUndefined();
    expect(viewerAttentionCursorWhenHistoryReady(done, 7n, { ...ready, error: "failed" })).toBeUndefined();

    expect(retrySessionAttentionAcknowledgement(new Error("transport reset"))).toBe(true);
    expect(retrySessionAttentionAcknowledgement({ code: "revision_conflict" })).toBe(false);
    expect(retrySessionAttentionAcknowledgement({ code: "generation_mismatch" })).toBe(false);
    expect(sessionAttentionAcknowledgementRetryDelayMs(1)).toBe(250);
    expect(sessionAttentionAcknowledgementRetryDelayMs(2)).toBe(500);
    expect(sessionAttentionAcknowledgementRetryDelayMs(99)).toBe(4_000);

    const retry = new SessionAttentionAcknowledgementRetryTracker();
    retry.activate("session\u0000cursor-50");
    expect(retry.begin("session\u0000cursor-50")).toBe(true);
    expect(retry.begin("session\u0000cursor-50")).toBe(false);
    expect(retry.failed("session\u0000cursor-50", new Error("transport reset"))).toBe(250);
    expect(retry.begin("session\u0000cursor-50")).toBe(false);
    expect(retry.release("session\u0000cursor-50")).toBe(true);
    expect(retry.begin("session\u0000cursor-50")).toBe(true);
    retry.succeeded("session\u0000cursor-50");
    expect(retry.begin("session\u0000cursor-50")).toBe(false);

    retry.activate("session\u0000cursor-51");
    expect(retry.begin("session\u0000cursor-51")).toBe(true);
    expect(retry.failed("session\u0000cursor-51", { code: "revision_conflict" })).toBeUndefined();
    expect(retry.begin("session\u0000cursor-51")).toBe(false);
    retry.activate(undefined);
    expect(retry.release("session\u0000cursor-51")).toBe(false);
  });

  it("shares the 500ms done visibility gate across priority and indicators", () => {
    const done = { ...session("done", "idle", 10), attention: { ...attention("done", true, 60n), updatedAt: -9_999_999_999 } };
    const running = session("running", "running", 20);
    const awaiting = { ...session("awaiting", "waiting", 30), attention: attention("awaiting", true, 61n) };
    const error = { ...session("error", "error", 40), attention: attention("error", true, 62n) };
    const state = createSidebarDoneAttentionVisibilityState();
    const first = reconcileSidebarDoneAttentionVisibility(state, [done, awaiting, error], 10_000);
    const before = reconcileSidebarDoneAttentionVisibility(state, [done, awaiting, error], 10_499);
    const after = reconcileSidebarDoneAttentionVisibility(state, [done, awaiting, error], 10_500);

    expect(first.nextRevealDelayMs).toBe(500);
    expect(before.nextRevealDelayMs).toBe(1);
    expect(visibleSidebarAttention(done, { visibleDoneAttentionKeys: before.visibleAttentionKeys })).toBeUndefined();
    expect(sidebarSessionNaturalPriority(done, { visibleDoneAttentionKeys: before.visibleAttentionKeys })).toBe(3);
    expect(after.nextRevealDelayMs).toBeUndefined();
    expect(visibleSidebarAttention(done, { visibleDoneAttentionKeys: after.visibleAttentionKeys })).toEqual(done.attention);
    expect(sidebarSessionNaturalPriority(done, { visibleDoneAttentionKeys: after.visibleAttentionKeys })).toBe(1);
    expect(sidebarSessionNaturalPriority(awaiting, { visibleDoneAttentionKeys: first.visibleAttentionKeys })).toBe(0);
    expect(sidebarSessionNaturalPriority(error, { visibleDoneAttentionKeys: first.visibleAttentionKeys })).toBe(0);

    // A running projection arriving before the deadline carries a cleared
    // attention row, so there is no delayed completion left to reveal.
    const runningWithStaleDone = { ...done, state: "running" as const };
    const cancelled = reconcileSidebarDoneAttentionVisibility(state, [runningWithStaleDone], 10_250);
    expect(cancelled.nextRevealDelayMs).toBeUndefined();
    expect(state.observations.size).toBe(0);

    // runChanged(waiting) is published before its authoritative awaiting
    // attention event. It must cancel an already revealed completion so the
    // intermediate snapshot cannot flash or sort as done.
    const revealedState = createSidebarDoneAttentionVisibilityState();
    reconcileSidebarDoneAttentionVisibility(revealedState, [done], 20_000);
    const revealed = reconcileSidebarDoneAttentionVisibility(revealedState, [done], 20_500);
    expect(revealed.visibleAttentionKeys.size).toBe(1);
    const waitingWithStaleDone = { ...done, state: "waiting" as const };
    const waitingFrame = reconcileSidebarDoneAttentionVisibility(revealedState, [waitingWithStaleDone], 20_501);
    expect(waitingFrame.visibleAttentionKeys.size).toBe(0);
    expect(sidebarSessionIndicatorState(waitingWithStaleDone, { visibleDoneAttentionKeys: waitingFrame.visibleAttentionKeys })).toBeUndefined();
    const awaitingAfterWaiting = { ...waitingWithStaleDone, attention: attention("awaiting", true, 63n) };
    expect(sidebarSessionIndicatorState(awaitingAfterWaiting, { visibleDoneAttentionKeys: waitingFrame.visibleAttentionKeys })).toBe("awaiting");

    // Right-slot priority is independent from list priority: running outranks
    // done, while error still outranks awaiting for a collapsed project.
    expect(sidebarSessionIndicatorState(runningWithStaleDone, { visibleDoneAttentionKeys: after.visibleAttentionKeys })).toBe("running");
    expect(sidebarGroupIndicatorState([done, running], { visibleDoneAttentionKeys: after.visibleAttentionKeys })).toBe("running");
    expect(sidebarGroupIndicatorState([done], { visibleDoneAttentionKeys: before.visibleAttentionKeys })).toBeUndefined();
    expect(sidebarGroupIndicatorState([done], { visibleDoneAttentionKeys: after.visibleAttentionKeys })).toBe("done");
    expect(sidebarGroupIndicatorState([awaiting, error], { visibleDoneAttentionKeys: first.visibleAttentionKeys })).toBe("error");

    // Remote timestamps cannot bypass or stretch the local monotonic window;
    // a new exact cursor restarts it and is revealed exactly once.
    const sameSubjectNewFence = {
      ...done,
      attention: { ...done.attention!, attentionCursor: { opaqueToken: "cursor-fence", sequence: 69n, generation: 0n } }
    };
    const stableSubjectState = createSidebarDoneAttentionVisibilityState();
    reconcileSidebarDoneAttentionVisibility(stableSubjectState, [done], 30_000);
    reconcileSidebarDoneAttentionVisibility(stableSubjectState, [done], 30_500);
    const stableFence = reconcileSidebarDoneAttentionVisibility(stableSubjectState, [sameSubjectNewFence], 30_501);
    expect(stableFence.nextRevealDelayMs).toBeUndefined();
    expect(visibleSidebarAttention(sameSubjectNewFence, { visibleDoneAttentionKeys: stableFence.visibleAttentionKeys })).toEqual(sameSubjectNewFence.attention);

    const newerDone = {
      ...done,
      attention: {
        ...done.attention!,
        subjectCursor: { opaqueToken: "cursor-new", sequence: 70n, generation: 0n },
        attentionCursor: { opaqueToken: "cursor-new", sequence: 70n, generation: 0n }
      }
    };
    const restarted = reconcileSidebarDoneAttentionVisibility(stableSubjectState, [newerDone], 50_000);
    expect(restarted.nextRevealDelayMs).toBe(500);
    expect(reconcileSidebarDoneAttentionVisibility(stableSubjectState, [newerDone], 50_500).visibleAttentionKeys.size).toBe(1);
    expect(reconcileSidebarDoneAttentionVisibility(stableSubjectState, [newerDone], 500_000).nextRevealDelayMs).toBeUndefined();
  });
});

function session(id: string, state: SessionView["state"], updatedAt: number): SessionView {
  return {
    id,
    backendId: "pi",
    targetId: "target",
    name: id,
    state,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    pinned: false,
    archived: false,
    generation: 0n,
    updatedAt
  };
}

function attention(
  kind: NonNullable<SessionView["attention"]>["kind"],
  unread: boolean,
  sequence: bigint
): NonNullable<SessionView["attention"]> {
  return {
    kind,
    unread,
    subjectCursor: { opaqueToken: `cursor-${sequence}`, sequence, generation: 0n },
    attentionCursor: { opaqueToken: `cursor-${sequence}`, sequence, generation: 0n },
    readThroughCursor: {
      opaqueToken: unread ? "cursor-0" : `cursor-${sequence}`,
      sequence: unread ? 0n : sequence,
      generation: 0n
    },
    updatedAt: Number(sequence)
  };
}

function target(id: string): TargetView {
  return {
    id,
    backendId: "pi",
    name: id,
    workspaceId: `workspace-${id}`,
    workspaceName: id,
    trusted: true,
    pinned: false,
    archived: false
  };
}
