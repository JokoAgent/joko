import { describe, expect, it } from "vitest";

import {
  SessionWindowRegistry,
  sessionWindowOwnerMayRequest
} from "../src/session-window-owner.js";

describe("task application-window owner", () => {
  it("registers independent native instances of the same task without an artificial count limit", () => {
    const registry = new SessionWindowRegistry<ReturnType<typeof nativeWindow>, object>();
    const owner = { profileId: "profile-a", sessionId: "task-one" };
    const windows = Array.from({ length: 33 }, (_, index) => nativeWindow(index + 1));
    const records = windows.map(window => registry.register(window, owner));
    expect([...registry.values()]).toEqual(windows); expect(records.map(record => record.draftSlot)).toEqual(windows.map((_, index) => index));
    expect(records.every(record => Object.isFrozen(record.owner))).toBe(true);
    expect(registry.ownerForContents(windows[0]!.webContents)).toEqual(owner);
    expect(registry.contextForContents(windows[1]!.webContents)).toEqual({ ...owner, draftSlot: 1 });
    expect(registry.register(windows[1]!, owner)).toBe(records[1]);
    registry.retire(windows[0]!);
    expect(registry.has(1)).toBe(false); expect(registry.hasContents(windows[0]!.webContents)).toBe(false);
    expect(registry.contextForContents(windows[1]!.webContents)?.draftSlot).toBe(1);
    expect(registry.register(nativeWindow(34), owner).draftSlot).toBe(0);
    registry.clear(); expect([...registry.values()]).toEqual([]); expect(registry.hasContents(windows[1]!.webContents)).toBe(false);
  });

  it("allows a primary owner to select a profile but fences child windows to their bound profile", () => {
    const requested = { profileId: "profile-a", sessionId: "task-two" } as const;
    expect(sessionWindowOwnerMayRequest(undefined, requested)).toBe(true);
    expect(sessionWindowOwnerMayRequest({ profileId: "profile-a", sessionId: "task-one" }, requested)).toBe(true);
    expect(sessionWindowOwnerMayRequest({ profileId: "profile-b", sessionId: "task-one" }, requested)).toBe(false);
  });

  it("rejects malformed owner components before creating a private key", () => {
    const registry = new SessionWindowRegistry<ReturnType<typeof nativeWindow>, object>();
    expect(() => registry.register(nativeWindow(1), { profileId: " profile", sessionId: "task" }))
      .toThrow("Task window owner is invalid.");
    expect(sessionWindowOwnerMayRequest(undefined, { profileId: "profile", sessionId: "" })).toBe(false);
  });

  it("keeps slots separate by profile and task and ignores a late retired instance with a reused native ID", () => {
    const registry = new SessionWindowRegistry<ReturnType<typeof nativeWindow>, object>(), first = nativeWindow(1), sibling = nativeWindow(2);
    const owner = { profileId: "profile-a", sessionId: "task-one" };
    registry.register(first, owner); registry.register(sibling, owner);
    expect(registry.register(nativeWindow(3), { profileId: "profile-b", sessionId: owner.sessionId }).draftSlot).toBe(0);
    expect(registry.register(nativeWindow(4), { profileId: owner.profileId, sessionId: "task-two" }).draftSlot).toBe(0);
    const replacement = nativeWindow(1); expect(registry.register(replacement, owner).draftSlot).toBe(0);
    registry.retire(first);
    expect(registry.get(1)).toBe(replacement); expect(registry.ownerForContents(first.webContents)).toBeUndefined();
    expect(registry.contextForContents(replacement.webContents)).toEqual({ ...owner, draftSlot: 0 });
    expect(registry.contextForContents(sibling.webContents)).toEqual({ ...owner, draftSlot: 1 });
    expect(() => registry.register(replacement, { ...owner, sessionId: "other" })).toThrow("cannot change");
  });

  it("retires captured native contents after destroyed getters become unavailable without touching a sibling", () => {
    const registry = new SessionWindowRegistry<ReturnType<typeof nativeWindow>, object>(), contents = {}, sibling = nativeWindow(2);
    let destroyed = false;
    const window = { id: 1, get webContents() { if (destroyed) throw new Error("Destroyed native window"); return contents; }, isDestroyed: () => destroyed };
    const owner = { profileId: "profile", sessionId: "task" };
    registry.register(window, owner); registry.register(sibling, owner); destroyed = true;
    expect(() => registry.retire(window)).not.toThrow(); expect(registry.has(1)).toBe(false); expect(registry.hasContents(contents)).toBe(false);
    expect(registry.contextForContents(sibling.webContents)).toEqual({ ...owner, draftSlot: 1 });
  });
});

function nativeWindow(id: number) { return { id, webContents: {}, isDestroyed: () => false }; }
