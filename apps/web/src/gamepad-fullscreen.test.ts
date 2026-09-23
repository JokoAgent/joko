// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { toggleGamepadFullscreen } from "./gamepad-fullscreen.js";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  document.body.className = "";
  delete document.body.dataset.appShortcutRecording;
  Reflect.deleteProperty(document, "fullscreenElement");
  Reflect.deleteProperty(document, "exitFullscreen");
  Reflect.deleteProperty(document.documentElement, "requestFullscreen");
});

describe("gamepad fullscreen owner", () => {
  it("uses the current Desktop bridge or the browser fullscreen state", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const native = vi.fn(async () => true);
    await toggleGamepadFullscreen(document, { window: { toggleFullscreen: native } }, "Unavailable");
    expect(native).toHaveBeenCalledOnce();
    const request = vi.fn(async () => undefined);
    const exit = vi.fn(async () => undefined);
    Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: request });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
    await toggleGamepadFullscreen(document, undefined, "Unavailable");
    expect(request).toHaveBeenCalledOnce();
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: document.documentElement });
    await toggleGamepadFullscreen(document, undefined, "Unavailable");
    expect(exit).toHaveBeenCalledOnce();
  });

  it("retires hidden or modal input and reports unavailable or rejected platform actions", async () => {
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const native = vi.fn(async () => true);
    document.body.classList.add("modal-open");
    await toggleGamepadFullscreen(document, { window: { toggleFullscreen: native } }, "Unavailable");
    document.body.classList.remove("modal-open");
    focused.mockReturnValue(false);
    await toggleGamepadFullscreen(document, { window: { toggleFullscreen: native } }, "Unavailable");
    expect(native).not.toHaveBeenCalled();
    focused.mockReturnValue(true);
    await expect(toggleGamepadFullscreen(document, { window: {} }, "Unavailable")).rejects.toThrow("Unavailable");
    const request = vi.fn(async () => { throw new Error("Browser denied fullscreen"); });
    Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: request });
    await expect(toggleGamepadFullscreen(document, undefined, "Unavailable")).rejects.toThrow("Browser denied fullscreen");
  });
});
