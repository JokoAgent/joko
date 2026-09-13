import { describe, expect, it } from "vitest";
import type { SessionAttentionView, SessionView, TimelineHistoryCursorView } from "./model.js";
import { SessionNotificationTracker, shouldDispatchSessionNotifications } from "./session-notifications.js";

function cursor(sequence: bigint): TimelineHistoryCursorView {
  return { opaqueToken: `cursor-${sequence}`, sequence, generation: 3n };
}

function attention(kind: SessionAttentionView["kind"], sequence: bigint, unread = true): SessionAttentionView {
  return {
    kind,
    unread,
    subjectCursor: cursor(sequence - 1n),
    attentionCursor: cursor(sequence),
    readThroughCursor: cursor(sequence - 1n),
    updatedAt: Number(sequence)
  };
}

function session(id: string, value?: SessionAttentionView): SessionView {
  return {
    id,
    backendId: "backend",
    targetId: "target",
    name: `Task ${id}`,
    state: "idle",
    pinned: false,
    archived: false,
    generation: 3n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    ...(value === undefined ? {} : { attention: value }),
    updatedAt: 1
  };
}

describe("session notification tracker", () => {
  it("dispatches only through an enabled Desktop host while the window is unfocused", () => {
    expect(shouldDispatchSessionNotifications({ enabled: true, desktopAvailable: true, windowFocused: false })).toBe(true);
    expect(shouldDispatchSessionNotifications({ enabled: false, desktopAvailable: true, windowFocused: false })).toBe(false);
    expect(shouldDispatchSessionNotifications({ enabled: true, desktopAvailable: false, windowFocused: false })).toBe(false);
    expect(shouldDispatchSessionNotifications({ enabled: true, desktopAvailable: true, windowFocused: true })).toBe(false);
  });

  it("seeds each owner without replaying durable unread attention", () => {
    const tracker = new SessionNotificationTracker();
    expect(tracker.observe("owner-a", [session("old", attention("done", 10n))])).toEqual([]);
    expect(tracker.observe("owner-b", [session("other-old", attention("error", 11n))])).toEqual([]);
  });

  it("emits each new durable attention edge once", () => {
    const tracker = new SessionNotificationTracker();
    expect(tracker.observe("owner", [session("one")])).toEqual([]);

    const done = session("one", attention("done", 20n));
    expect(tracker.observe("owner", [done])).toEqual([
      { sessionId: "one", title: "Task one", kind: "done" }
    ]);
    expect(tracker.observe("owner", [done])).toEqual([]);

    const awaiting = session("one", attention("awaiting", 21n));
    expect(tracker.observe("owner", [awaiting])).toEqual([
      { sessionId: "one", title: "Task one", kind: "awaiting" }
    ]);
  });

  it("consumes read edges and does not replay them when marked unread again", () => {
    const tracker = new SessionNotificationTracker();
    tracker.observe("owner", [session("one")]);
    tracker.observe("owner", [session("one", attention("error", 30n, false))]);
    expect(tracker.observe("owner", [session("one", attention("error", 30n, true))])).toEqual([]);
  });

  it("notifies for a newly-created task after the initial snapshot and prunes deleted identities", () => {
    const tracker = new SessionNotificationTracker();
    tracker.observe("owner", []);
    expect(tracker.observe("owner", [session("new", attention("done", 40n))])).toHaveLength(1);
    tracker.observe("owner", []);
    expect(tracker.observe("owner", [session("new", attention("done", 40n))])).toHaveLength(1);
  });
});
