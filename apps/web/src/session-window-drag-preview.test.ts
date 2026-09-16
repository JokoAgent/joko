// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelSessionWindowDragPreview,
  cancelSessionWindowDragPreviewForSession,
  SESSION_WINDOW_DRAG_PREVIEW_TIMEOUT_MS,
  startSessionWindowDragPreview
} from "./session-window-drag-preview.js";

afterEach(() => {
  cancelSessionWindowDragPreview();
  Reflect.deleteProperty(window, "jokoDesktop");
  document.body.replaceChildren();
  document.documentElement.removeAttribute("style");
  vi.useRealTimers();
});

describe("task window drag preview lifecycle", () => {
  it("times out a renderer gesture and clears its transparent drag image", async () => {
    vi.useFakeTimers();
    installTokens();
    const bridge = installBridge();
    const row = document.body.appendChild(document.createElement("li"));
    const setDragImage = vi.fn();

    expect(startSessionWindowDragPreview({
      dataTransfer: { setDragImage } as unknown as DataTransfer,
      row,
      profileId: "profile-one",
      sessionId: "task-one",
      label: "Task one",
      hint: "Open in new window",
      ownerWindow: window
    })).toBe(true);
    await Promise.resolve();
    const gestureId = bridge.beginDragPreview.mock.calls[0]?.[0]?.gestureId;
    expect(setDragImage).toHaveBeenCalledOnce();
    expect(document.querySelector("canvas")).not.toBeNull();

    vi.advanceTimersByTime(SESSION_WINDOW_DRAG_PREVIEW_TIMEOUT_MS);
    await Promise.resolve();
    expect(bridge.endDragPreview).toHaveBeenCalledWith(gestureId);
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("cancels only the matching source task and rejects unresolved visual tokens", () => {
    installTokens();
    const bridge = installBridge();
    const row = document.body.appendChild(document.createElement("li"));
    const transfer = { setDragImage: vi.fn() } as unknown as DataTransfer;
    expect(startSessionWindowDragPreview({
      dataTransfer: transfer,
      row,
      profileId: "profile-one",
      sessionId: "task-one",
      label: "Task one",
      hint: "Open in new window",
      ownerWindow: window
    })).toBe(true);
    cancelSessionWindowDragPreviewForSession("task-two");
    expect(bridge.endDragPreview).not.toHaveBeenCalled();
    cancelSessionWindowDragPreviewForSession("task-one");
    expect(bridge.endDragPreview).toHaveBeenCalledOnce();

    document.documentElement.style.removeProperty("--accent");
    expect(startSessionWindowDragPreview({
      dataTransfer: transfer,
      row,
      profileId: "profile-one",
      sessionId: "task-two",
      label: "Task two",
      hint: "Open in new window",
      ownerWindow: window
    })).toBe(false);
    expect(bridge.beginDragPreview).toHaveBeenCalledOnce();
  });

  it("finishes a non-macOS drag exactly once on the renderer mouse-release fallback", async () => {
    installTokens();
    const bridge = installBridge("win32");
    const row = document.body.appendChild(document.createElement("li"));
    expect(startSessionWindowDragPreview({
      dataTransfer: { setDragImage: vi.fn() } as unknown as DataTransfer,
      row,
      profileId: "profile-one",
      sessionId: "task-one",
      label: "Task one",
      hint: "Open in new window",
      ownerWindow: window
    })).toBe(true);
    await Promise.resolve();
    const gestureId = bridge.beginDragPreview.mock.calls[0]?.[0]?.gestureId;

    window.dispatchEvent(new MouseEvent("pointerup"));
    window.dispatchEvent(new MouseEvent("mouseup"));
    window.dispatchEvent(new Event("dragend"));
    await Promise.resolve();

    expect(bridge.openIfDroppedOutside).toHaveBeenCalledExactlyOnceWith(gestureId);
    expect(bridge.endDragPreview).not.toHaveBeenCalled();
    expect(row.classList.contains("is-session-dragging")).toBe(false);
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("leaves mouse release to the macOS native path and consumes renderer dragend once", async () => {
    installTokens();
    const bridge = installBridge("darwin");
    const row = document.body.appendChild(document.createElement("li"));
    expect(startSessionWindowDragPreview({
      dataTransfer: { setDragImage: vi.fn() } as unknown as DataTransfer,
      row,
      profileId: "profile-one",
      sessionId: "task-one",
      label: "Task one",
      hint: "Open in new window",
      ownerWindow: window
    })).toBe(true);
    await Promise.resolve();
    const gestureId = bridge.beginDragPreview.mock.calls[0]?.[0]?.gestureId;

    window.dispatchEvent(new MouseEvent("pointerup"));
    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(bridge.openIfDroppedOutside).not.toHaveBeenCalled();
    expect(document.querySelector("canvas")).not.toBeNull();

    window.dispatchEvent(new Event("dragend"));
    window.dispatchEvent(new Event("dragend"));
    await Promise.resolve();
    expect(bridge.openIfDroppedOutside).toHaveBeenCalledExactlyOnceWith(gestureId);
  });
});

function installBridge(platform: NodeJS.Platform = "win32"): {
  beginDragPreview: ReturnType<typeof vi.fn>;
  endDragPreview: ReturnType<typeof vi.fn>;
  openIfDroppedOutside: ReturnType<typeof vi.fn>;
} {
  const bridge = {
    beginDragPreview: vi.fn().mockResolvedValue(true),
    endDragPreview: vi.fn().mockResolvedValue(true),
    openIfDroppedOutside: vi.fn().mockResolvedValue({ opened: false })
  };
  Object.defineProperty(window, "jokoDesktop", {
    configurable: true,
    value: { platform, capabilities: ["session.windows"], sessionWindows: bridge }
  });
  return bridge;
}

function installTokens(): void {
  const style = document.documentElement.style;
  style.setProperty("--surface-raised", "#ffffff");
  style.setProperty("--line", "#d8d8d8");
  style.setProperty("--text", "#0d0d0d");
  style.setProperty("--text-soft", "#5f5f5f");
  style.setProperty("--accent", "#ff9800");
}
