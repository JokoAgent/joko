import { describe, expect, it, vi } from "vitest";
import { MobileTaskHomeNavigation, type MobileHomeNavigationIntent,
  type MobileTaskHomeNavigationScope } from "./mobile-task-home-navigation";

function pending() {
  let finish!: () => void;
  const promise = new Promise<void>((resolve) => { finish = resolve; });
  return { promise, finish };
}
function fixture() {
  let scope: MobileTaskHomeNavigationScope | undefined = { sourceKey: "node-a/profile/connection/device/origin", sessionId: "a", runtimeKey: "backend/target/1" };
  const prepare = vi.fn(async (_current: () => boolean) => {});
  const execute = vi.fn(async (_intent: MobileHomeNavigationIntent, _current: () => boolean) => {});
  const close = vi.fn(); const failed = vi.fn();
  const navigator = new MobileTaskHomeNavigation({ readScope: () => scope, prepare, execute, close, failed });
  return { navigator, prepare, execute, close, failed, read: () => scope,
    change: (next: MobileTaskHomeNavigationScope | undefined) => { scope = next; navigator.observeScope(); } };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe("captured task Home navigation", () => {
  it("delivers the first modal intent only after its real close and original draft preparation", async () => {
    const f = fixture(), flush = pending();
    f.prepare.mockImplementation(async () => { await flush.promise; });
    f.navigator.request({ kind: "session", sessionId: "b" }, true);
    f.navigator.request({ kind: "new-task" }, true);
    expect(f.close).toHaveBeenCalledOnce(); expect(f.prepare).not.toHaveBeenCalled();
    f.navigator.closed(); await settle();
    expect(f.prepare).toHaveBeenCalledOnce(); expect(f.execute).not.toHaveBeenCalled();
    flush.finish(); await settle();
    expect(f.execute).toHaveBeenCalledWith({ kind: "session", sessionId: "b" }, expect.any(Function));
    expect(f.navigator.busy).toBe(false);
  });

  it("closes the current item without saving or selecting and locks pure-close double taps until unmount", async () => {
    const f = fixture();
    f.navigator.request({ kind: "session", sessionId: "a" }, true);
    f.navigator.request({ kind: "new-task" }, true);
    f.navigator.closed(); await settle();
    expect(f.close).toHaveBeenCalledOnce(); expect(f.prepare).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
    f.navigator.request({ kind: "new-task" }, false); await settle();
    expect(f.execute).toHaveBeenCalledWith({ kind: "new-task" }, expect.any(Function));
  });

  it("captures a global menu action before closing and rejects a same-ID task on another source", async () => {
    const f = fixture();
    const delivery = f.navigator.defer({ kind: "search" });
    f.change({ ...f.read()!, sourceKey: "node-b/profile/connection/device/origin" });
    delivery!(); await settle();
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
    expect(f.navigator.busy).toBe(false);
    f.navigator.request({ kind: "search" }, false); await settle();
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it("retires a late flush on background even when the original scope returns and releases a vanished modal lock", async () => {
    const f = fixture(), flush = pending(), original = f.read();
    f.prepare.mockImplementationOnce(async () => { await flush.promise; });
    f.navigator.request({ kind: "session", sessionId: "b" }, true); f.navigator.closed();
    await settle(); f.change(undefined); f.change(original);
    flush.finish(); await settle(); expect(f.execute).not.toHaveBeenCalled();
    f.navigator.close(); expect(f.navigator.busy).toBe(true);
    f.navigator.retire(); expect(f.navigator.busy).toBe(false);
    f.navigator.request({ kind: "home" }, false); await settle();
    expect(f.execute).toHaveBeenCalledWith({ kind: "home" }, expect.any(Function));
  });

  it("allows the owned target selection to change binding while rejecting an unrelated switch during preparation", async () => {
    const f = fixture();
    f.execute.mockImplementationOnce(async (intent, current) => {
      if (intent.kind !== "session") throw new Error("Expected a task intent");
      f.change({ ...f.read()!, sessionId: intent.sessionId, runtimeKey: "other-backend/other-target/9" });
      expect(current()).toBe(true);
    });
    f.navigator.request({ kind: "session", sessionId: "b" }, false); await settle();
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled();
    const flush = pending(); f.prepare.mockImplementationOnce(async () => { await flush.promise; });
    f.navigator.request({ kind: "session", sessionId: "c" }, false); await settle();
    f.change({ ...f.read()!, sessionId: "external" }); flush.finish(); await settle();
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it("preserves the current task after a flush failure and permits only an explicit retry", async () => {
    const f = fixture(), failure = new Error("Draft storage unavailable");
    f.prepare.mockRejectedValueOnce(failure);
    f.navigator.request({ kind: "new-task" }, false); await settle();
    expect(f.execute).not.toHaveBeenCalled(); expect(f.failed).toHaveBeenCalledWith(failure);
    expect(f.read()?.sessionId).toBe("a"); expect(f.navigator.busy).toBe(false);
    f.navigator.request({ kind: "new-task" }, false); await settle();
    expect(f.execute).toHaveBeenCalledOnce();
  });
});
