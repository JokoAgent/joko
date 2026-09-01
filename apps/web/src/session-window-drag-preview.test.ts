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
      sessionId: "task-two",
      label: "Task two",
      hint: "Open in new window",
      ownerWindow: window
    })).toBe(false);
    expect(bridge.beginDragPreview).toHaveBeenCalledOnce();
  });
});

function installBridge(): {
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
    value: { capabilities: ["session.windows"], sessionWindows: bridge }
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
