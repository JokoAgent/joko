// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { addSessionSplit, clearSessionSplitLayoutForTests, readSessionSplitLayout, writeSessionSplitLayout } from "./session-split-layout.js";
import { CLIENT_LAYOUT_RESET_EVENT, INSPECTOR_RATIO_STORAGE_KEY, layoutResetPersistsSessionSplit, resetClientLayout } from "./client-layout-reset.js";
import { WORKSPACE_CHAT_RAIL_COLLAPSED_STORAGE_KEY } from "./workspace-chat-rail.js";

describe("client layout reset", () => {
  beforeEach(() => {
    localStorage.clear();
    clearSessionSplitLayoutForTests();
  });

  it("clears only geometry keys and the current owner split", () => {
    writeSessionSplitLayout("owner-a", addSessionSplit({}, "b", "a", "right"));
    writeSessionSplitLayout("owner-b", addSessionSplit({}, "d", "c", "right"));
    localStorage.setItem(INSPECTOR_RATIO_STORAGE_KEY, "0.8");
    localStorage.setItem(WORKSPACE_CHAT_RAIL_COLLAPSED_STORAGE_KEY, "true");
    localStorage.setItem("unrelated-theme", "dark");
    const event = vi.fn();
    window.addEventListener(CLIENT_LAYOUT_RESET_EVENT, event);
    resetClientLayout("owner-a");
    expect(readSessionSplitLayout("owner-a")).toEqual({});
    expect(readSessionSplitLayout("owner-b").root).toBeDefined();
    expect(localStorage.getItem(INSPECTOR_RATIO_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(WORKSPACE_CHAT_RAIL_COLLAPSED_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem("unrelated-theme")).toBe("dark");
    expect(event).toHaveBeenCalledOnce();
  });

  it("still resets window-local geometry while disconnected", () => {
    localStorage.setItem(INSPECTOR_RATIO_STORAGE_KEY, "0.8");
    const event = vi.fn();
    window.addEventListener(CLIENT_LAYOUT_RESET_EVENT, event);

    expect(() => resetClientLayout(undefined)).not.toThrow();

    expect(localStorage.getItem(INSPECTOR_RATIO_STORAGE_KEY)).toBeNull();
    expect(event).toHaveBeenCalledOnce();
  });

  it("lets a session window defer the durable split clear to the main receiver", () => {
    const layout = addSessionSplit({}, "b", "a", "right");
    writeSessionSplitLayout("owner-a", layout);

    expect(layoutResetPersistsSessionSplit("?sessionWindow=1")).toBe(false);
    resetClientLayout("owner-a", false);
    clearSessionSplitLayoutForTests();
    expect(readSessionSplitLayout("owner-a").root).toBeDefined();

    expect(layoutResetPersistsSessionSplit("")).toBe(true);
    resetClientLayout("owner-a", true);
    clearSessionSplitLayoutForTests();
    expect(readSessionSplitLayout("owner-a")).toEqual({});
  });
});
