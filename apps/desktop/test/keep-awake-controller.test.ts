import { describe, expect, it, vi } from "vitest";

import {
  createDesktopKeepAwakeController,
  type DesktopPowerSaveBlocker
} from "../src/keep-awake-controller.js";

function fixture() {
  let nextId = 1;
  const started = new Set<number>();
  const blocker: DesktopPowerSaveBlocker = {
    start: vi.fn((_type) => {
      const id = nextId++;
      started.add(id);
      return id;
    }),
    stop: vi.fn((id) => { started.delete(id); }),
    isStarted: vi.fn((id) => started.has(id))
  };
  return { blocker, controller: createDesktopKeepAwakeController(blocker), started };
}

describe("Desktop keep-awake controller", () => {
  it("starts one prevent-app-suspension blocker and applies repeated state idempotently", () => {
    const { blocker, controller, started } = fixture();
    controller.apply(true);
    controller.apply(true);
    expect(blocker.start).toHaveBeenCalledOnce();
    expect(blocker.start).toHaveBeenCalledWith("prevent-app-suspension");
    expect(started).toEqual(new Set([1]));
    expect(controller.isActive()).toBe(true);

    controller.apply(false);
    controller.apply(false);
    expect(blocker.stop).toHaveBeenCalledOnce();
    expect(blocker.stop).toHaveBeenCalledWith(1);
    expect(controller.isActive()).toBe(false);
  });

  it("reacquires a blocker that the native host stopped and releases it on quit", () => {
    const { blocker, controller, started } = fixture();
    controller.apply(true);
    started.clear();
    controller.apply(true);
    expect(blocker.start).toHaveBeenCalledTimes(2);
    expect(started).toEqual(new Set([2]));

    controller.release();
    controller.release();
    expect(blocker.stop).toHaveBeenCalledOnce();
    expect(blocker.stop).toHaveBeenCalledWith(2);
    expect(started.size).toBe(0);
  });

  it("rejects an invalid native blocker identifier without retaining it", () => {
    const blocker: DesktopPowerSaveBlocker = {
      start: vi.fn(() => -1),
      stop: vi.fn(),
      isStarted: vi.fn(() => false)
    };
    const controller = createDesktopKeepAwakeController(blocker);
    expect(() => controller.apply(true)).toThrow("invalid identifier");
    expect(controller.isActive()).toBe(false);
    controller.release();
    expect(blocker.stop).not.toHaveBeenCalled();
  });
});
