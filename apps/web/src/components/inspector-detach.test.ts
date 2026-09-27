import { describe, expect, it, vi } from "vitest";
import {
  activateDetachedInspectorWindow,
  INSPECTOR_DETACH_CAPABILITY,
  INSPECTOR_WINDOW_FEATURES,
  INSPECTOR_WINDOW_FRAME_NAME,
  INSPECTOR_WINDOW_URL,
  inspectorDetachAvailable,
  openDetachedInspectorWindow
} from "./inspector-detach.js";

function desktop(capabilities: readonly string[]): JokoDesktopApi {
  return {
    capabilities,
    inspectorWindow: { activate: async () => true, onClosed: () => () => undefined }
  } as unknown as JokoDesktopApi;
}

describe("detached Inspector renderer contract", () => {
  it("is unavailable on Web and requires the exact Desktop shell capability", () => {
    expect(inspectorDetachAvailable(undefined)).toBe(false);
    expect(inspectorDetachAvailable(desktop([]))).toBe(false);
    expect(inspectorDetachAvailable(desktop([INSPECTOR_DETACH_CAPABILITY]))).toBe(true);
  });

  it("opens only the reserved child target and fixed-size feature request", () => {
    const child = {} as Window;
    const open = vi.fn(() => child);
    expect(openDetachedInspectorWindow(open)).toBe(child);
    expect(open).toHaveBeenCalledWith(
      INSPECTOR_WINDOW_URL,
      INSPECTOR_WINDOW_FRAME_NAME,
      INSPECTOR_WINDOW_FEATURES
    );
  });

  it("activates only through the advertised current-v1 Desktop bridge", async () => {
    const available = desktop([INSPECTOR_DETACH_CAPABILITY]);
    const activate = vi.spyOn(available.inspectorWindow, "activate");
    await expect(activateDetachedInspectorWindow(available)).resolves.toBe(true);
    expect(activate).toHaveBeenCalledOnce();
    await expect(activateDetachedInspectorWindow(undefined)).resolves.toBe(false);
    await expect(activateDetachedInspectorWindow(desktop([]))).resolves.toBe(false);
  });
});
