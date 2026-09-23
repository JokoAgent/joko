import { describe, expect, it, vi } from "vitest";
import { toggleApplicationWindowFullscreen } from "../src/window-fullscreen.js";

function windowWithSender(sender: object) {
  let fullscreen = false;
  let destroyed = false;
  return {
    webContents: sender,
    isDestroyed: () => destroyed,
    isFullScreen: () => fullscreen,
    setFullScreen: vi.fn((value: boolean) => { fullscreen = value; }),
    retire: () => { destroyed = true; }
  };
}

describe("application fullscreen window ownership", () => {
  it("toggles only the exact current main or task window", () => {
    const mainSender = {};
    const taskSender = {};
    const main = windowWithSender(mainSender);
    const task = windowWithSender(taskSender);
    expect(toggleApplicationWindowFullscreen(mainSender, main, main, task)).toBe(true);
    expect(toggleApplicationWindowFullscreen(mainSender, main, main, task)).toBe(false);
    expect(main.setFullScreen.mock.calls).toEqual([[true], [false]]);
    expect(toggleApplicationWindowFullscreen(taskSender, task, main, task)).toBe(true);
    expect(task.setFullScreen).toHaveBeenCalledExactlyOnceWith(true);
    expect(() => toggleApplicationWindowFullscreen(taskSender, main, main, task)).toThrow("current application window");
    task.retire();
    expect(() => toggleApplicationWindowFullscreen(taskSender, task, main, task)).toThrow("current application window");
    expect(() => toggleApplicationWindowFullscreen(taskSender, task, main, undefined)).toThrow("current application window");
  });
});
