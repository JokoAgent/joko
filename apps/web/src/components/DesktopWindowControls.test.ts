import { describe, expect, it, vi } from "vitest";
import {
  requestDesktopWindowClose,
  shouldRenderDesktopWindowControls
} from "./DesktopWindowControls.js";

describe("desktop window controls", () => {
  it("uses native traffic lights on macOS and renderer controls elsewhere", () => {
    expect(shouldRenderDesktopWindowControls(undefined)).toBe(false);
    expect(shouldRenderDesktopWindowControls("darwin")).toBe(false);
    expect(shouldRenderDesktopWindowControls("win32")).toBe(true);
    expect(shouldRenderDesktopWindowControls("linux")).toBe(true);
  });

  it("requests one shell close", async () => {
    const close = vi.fn(async () => undefined);
    requestDesktopWindowClose({ window: { close } } as unknown as JokoDesktopApi);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("does not lock the title bar when close IPC rejects", async () => {
    const close = vi.fn(async () => Promise.reject(new Error("tray unavailable")));
    requestDesktopWindowClose({ window: { close } } as unknown as JokoDesktopApi);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

});
