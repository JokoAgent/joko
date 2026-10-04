import { describe, expect, it, vi } from "vitest";
import { MobileScreenshotSelectionController, readMobileScreenshotVisibleMessages, subscribeMobileScreenshots,
  type MobileScreenshotMeasurable, type MobileScreenshotSelectionScope } from "./mobile-screenshot-selection";

vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
const measurable = (y: number, height: number): MobileScreenshotMeasurable => ({
  measureInWindow: (callback) => callback(0, y, 390, height)
});

describe("screenshot message selection", () => {
  it("selects measured message intersections of at least ten percent in screen order", async () => {
    const controller = new AbortController();
    const visible = await readMobileScreenshotVisibleMessages(measurable(100, 400), new Map([
      ["bottom", measurable(450, 500)], ["top", measurable(80, 100)],
      ["almost-hidden", measurable(495, 100)], ["offscreen", measurable(600, 100)]
    ]), controller.signal);
    expect(visible).toEqual(["top", "bottom"]);
    let late!: (x: number, y: number, width: number, height: number) => void;
    const reading = readMobileScreenshotVisibleMessages({ measureInWindow: (callback) => { late = callback; } }, new Map(), controller.signal);
    controller.abort(); await expect(reading).resolves.toEqual([]);
    late(0, 100, 390, 400);
  });

  it("debounces capture, ignores overlays and retires a selection after owner or foreground drift", async () => {
    let scope: MobileScreenshotSelectionScope = { owner: "task", foreground: true, blocked: false, selectionActive: false };
    let time = 100; let finish!: (ids: readonly string[]) => void;
    const read = vi.fn(() => new Promise<readonly string[]>((resolve) => { finish = resolve; }));
    const enter = vi.fn();
    const controller = new MobileScreenshotSelectionController(() => scope, read, enter, () => time);
    controller.capture(); controller.capture(); expect(read).toHaveBeenCalledTimes(1);
    finish(["b", "a", "b"]); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(enter).toHaveBeenCalledWith("task", ["b", "a"]);
    time += 500; controller.capture(); expect(read).toHaveBeenCalledTimes(1);
    time += 1_200; scope = { ...scope, blocked: true }; controller.capture(); expect(read).toHaveBeenCalledTimes(1);
    scope = { ...scope, blocked: false }; controller.capture(); expect(read).toHaveBeenCalledTimes(2);
    scope = { ...scope, owner: "another-task" }; finish(["a"]); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(enter).toHaveBeenCalledTimes(1);
    time += 1_200; controller.capture(); controller.retire(); finish(["a"]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(enter).toHaveBeenCalledTimes(1);
    controller.dispose(); time += 1_200; controller.capture(); expect(read).toHaveBeenCalledTimes(3);
  });

  it("validates the native event and discards callbacks queued after listener removal", () => {
    let callback!: (value: unknown) => void;
    const remove = vi.fn(); const listener = vi.fn();
    const stop = subscribeMobileScreenshots(listener, { addListener: (_event, sink) => { callback = sink; return { remove }; } });
    callback({ capturedAt: 100 }); callback({ capturedAt: 200, content: "unexpected" }); callback({ capturedAt: NaN });
    expect(listener).toHaveBeenCalledTimes(1);
    stop(); callback({ capturedAt: 300 }); expect(listener).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledTimes(1);
  });
});
