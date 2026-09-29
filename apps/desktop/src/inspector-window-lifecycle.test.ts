import { describe, expect, it, vi } from "vitest";
import { InspectorWindowLifecycle } from "./inspector-window-lifecycle.js";

function fixture() {
  let current = true;
  let ownerDestroyed = false;
  let ownerFocused = true;
  let ownerVisible = true;
  let ownerMinimized = false;
  let childDestroyed = false;
  let childFocused = true;
  let childMinimized = false;
  const owner = {
    isDestroyed: () => ownerDestroyed,
    isFocused: () => ownerFocused,
    isVisible: () => ownerVisible,
    isMinimized: () => ownerMinimized
  };
  const child = {
    isDestroyed: () => childDestroyed,
    isFocused: () => childFocused,
    isMinimized: () => childMinimized,
    restore: vi.fn(() => { childMinimized = false; }),
    hide: vi.fn(),
    show: vi.fn(),
    showInactive: vi.fn(),
    moveTop: vi.fn(),
    focus: vi.fn()
  };
  const retire = vi.fn();
  const lifecycle = new InspectorWindowLifecycle({
    owner,
    child,
    isCurrent: () => current,
    retire
  });
  return {
    owner,
    child,
    lifecycle,
    retire,
    setCurrent: (value: boolean) => { current = value; },
    setOwnerDestroyed: (value: boolean) => { ownerDestroyed = value; },
    setOwnerFocused: (value: boolean) => { ownerFocused = value; },
    setOwnerVisible: (value: boolean) => { ownerVisible = value; },
    setOwnerMinimized: (value: boolean) => { ownerMinimized = value; },
    setChildDestroyed: (value: boolean) => { childDestroyed = value; },
    setChildFocused: (value: boolean) => { childFocused = value; },
    setChildMinimized: (value: boolean) => { childMinimized = value; }
  };
}

describe("detached Inspector owner lifecycle", () => {
  it("hides for owner hide/minimize and restores inactive only after the exact child is ready", () => {
    const value = fixture();
    value.lifecycle.ownerHidden(value.owner);
    expect(value.child.hide).toHaveBeenCalledOnce();
    value.lifecycle.ownerShown(value.owner);
    expect(value.child.showInactive).not.toHaveBeenCalled();
    expect(value.lifecycle.canReveal(value.child)).toBe(false);

    expect(value.lifecycle.markReady(value.child)).toBe(true);
    value.setOwnerMinimized(true);
    value.lifecycle.ownerShown(value.owner);
    expect(value.child.showInactive).not.toHaveBeenCalled();
    value.setOwnerMinimized(false);
    value.lifecycle.ownerShown(value.owner);
    expect(value.child.showInactive).toHaveBeenCalledOnce();
  });

  it("retires on exact owner reload/crash but ignores stale owner and child events", () => {
    const value = fixture();
    const otherOwner = { ...value.owner };
    const otherChild = { ...value.child };
    value.lifecycle.ownerRetired(otherOwner);
    expect(value.retire).not.toHaveBeenCalled();
    expect(value.lifecycle.markReady(otherChild)).toBe(false);

    value.lifecycle.ownerRetired(value.owner);
    expect(value.retire).toHaveBeenCalledExactlyOnceWith(value.owner, value.child);
    value.setCurrent(false);
    value.lifecycle.ownerHidden(value.owner);
    value.lifecycle.ownerShown(value.owner);
    value.lifecycle.ownerRetired(value.owner);
    expect(value.child.hide).not.toHaveBeenCalled();
    expect(value.child.showInactive).not.toHaveBeenCalled();
    expect(value.retire).toHaveBeenCalledOnce();
  });

  it("returns focus only for a focused user close into a visible, non-minimized owner", () => {
    const value = fixture();
    expect(value.lifecycle.markReady(value.child)).toBe(true);
    expect(value.lifecycle.canReveal(value.child)).toBe(true);
    expect(value.lifecycle.markUserClosing(value.child)).toBe(true);
    expect(value.lifecycle.closeDecision(value.child)).toEqual({ notifyOwner: true, returnFocus: true, reason: "user" });
    value.setOwnerVisible(false);
    expect(value.lifecycle.canReveal(value.child)).toBe(false);
    expect(value.lifecycle.closeDecision(value.child)).toEqual({ notifyOwner: true, returnFocus: false, reason: "user" });
    value.setOwnerVisible(true);
    value.setOwnerDestroyed(true);
    expect(value.lifecycle.closeDecision(value.child)).toEqual({ notifyOwner: true, returnFocus: false, reason: "user" });

    const unfocused = fixture();
    expect(unfocused.lifecycle.markReady(unfocused.child)).toBe(true);
    unfocused.setChildFocused(false);
    expect(unfocused.lifecycle.markUserClosing(unfocused.child)).toBe(true);
    expect(unfocused.lifecycle.closeDecision(unfocused.child)).toEqual({ notifyOwner: true, returnFocus: false, reason: "user" });
  });

  it("activates only the ready exact child from its focused visible owner", () => {
    const value = fixture();
    expect(value.lifecycle.activate(value.owner, value.child)).toBe(false);
    expect(value.lifecycle.markReady(value.child)).toBe(true);
    value.setChildMinimized(true);
    expect(value.lifecycle.activate(value.owner, value.child)).toBe(true);
    expect(value.child.restore).toHaveBeenCalledOnce();
    expect(value.child.show).toHaveBeenCalledOnce();
    expect(value.child.moveTop).toHaveBeenCalledOnce();
    expect(value.child.focus).toHaveBeenCalledOnce();

    const background = fixture();
    expect(background.lifecycle.markReady(background.child)).toBe(true);
    background.setOwnerFocused(false);
    expect(background.lifecycle.activate(background.owner, background.child)).toBe(false);
    expect(background.child.show).not.toHaveBeenCalled();
    expect(background.child.focus).not.toHaveBeenCalled();

    const stale = fixture();
    expect(stale.lifecycle.markReady(stale.child)).toBe(true);
    stale.setCurrent(false);
    expect(stale.lifecycle.activate(stale.owner, stale.child)).toBe(false);
    expect(stale.child.focus).not.toHaveBeenCalled();

    const closing = fixture();
    expect(closing.lifecycle.markReady(closing.child)).toBe(true);
    expect(closing.lifecycle.markPassiveClosing(closing.child)).toBe(true);
    expect(closing.lifecycle.activate(closing.owner, closing.child)).toBe(false);
    expect(closing.child.focus).not.toHaveBeenCalled();
  });

  it("reattaches without returning focus after child failure and stays silent for passive retirement", () => {
    const failed = fixture();
    expect(failed.lifecycle.markReady(failed.child)).toBe(true);
    expect(failed.lifecycle.markChildFailed(failed.child)).toBe(true);
    expect(failed.lifecycle.markUserClosing(failed.child)).toBe(false);
    failed.setChildDestroyed(true);
    expect(failed.lifecycle.closeDecision(failed.child)).toEqual({ notifyOwner: true, returnFocus: false, reason: "child-failure" });

    const passive = fixture();
    expect(passive.lifecycle.markPassiveClosing(passive.child)).toBe(true);
    expect(passive.lifecycle.markUserClosing(passive.child)).toBe(false);
    passive.setChildDestroyed(true);
    expect(passive.lifecycle.closeDecision(passive.child)).toEqual({ notifyOwner: false, returnFocus: false });
  });
});
