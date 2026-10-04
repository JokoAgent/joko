// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addSessionSplit, clearSessionSplitLayoutForTests, readSessionSplitLayout, writeSessionSplitLayout } from "./session-split-layout.js";
import {
  CLIENT_LAYOUT_RESET_EVENT,
  INSPECTOR_RATIO_STORAGE_KEY,
  layoutResetPersistsSessionSplit,
  publishClientLayoutResetOccurrence,
  resetClientLayout,
  subscribeClientLayoutResetOccurrence
} from "./client-layout-reset.js";
import {
  addModelFavorite,
  readModelPickerLayout,
  readModelPickerOwnerPreferences,
  resetModelPickerPreferencesForTests,
  setModelConfiguration,
  setModelPickerLayout,
  setModelVisible,
  useModelPickerLayout
} from "./model-picker-preferences.js";
import { WORKSPACE_CHAT_RAIL_COLLAPSED_STORAGE_KEY } from "./workspace-chat-rail.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("client layout reset", () => {
  beforeEach(() => {
    localStorage.clear();
    clearSessionSplitLayoutForTests();
    resetModelPickerPreferencesForTests();
  });

  afterEach(() => vi.unstubAllGlobals());

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

  it("resets model-picker memory through its preference owner without clearing owner preferences", async () => {
    setModelVisible("owner-a", "backend-a", "provider-a", "model-a", false);
    setModelConfiguration("owner-a", "backend-a", "provider-a", "model-a", { effort: "high", fast: true });
    addModelFavorite("owner-a", {
      backendId: "backend-a",
      providerId: "provider-a",
      modelId: "model-a",
      effort: "high",
      fast: true
    });
    const ownerPreferences = readModelPickerOwnerPreferences("owner-a");
    const observed: string[] = [];
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    function LayoutProbe(): null {
      const layout = useModelPickerLayout();
      useEffect(() => { observed.push(layout); }, [layout]);
      return null;
    }

    await act(async () => { root.render(createElement(LayoutProbe)); });
    act(() => { setModelPickerLayout("badge"); });
    expect(observed.at(-1)).toBe("badge");

    act(() => { resetClientLayout(); });

    expect(readModelPickerLayout()).toBe("original");
    expect(observed.at(-1)).toBe("original");
    expect(readModelPickerOwnerPreferences("owner-a")).toEqual(ownerPreferences);

    await act(async () => { root.unmount(); });
    host.remove();
  });

  it("broadcasts the exact content-free v1 occurrence and ignores malformed messages", async () => {
    const channels = new Set<TestChannel>();
    const sent: Array<{ readonly name: string; readonly value: unknown }> = [];
    class TestChannel {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      constructor(readonly name: string) { channels.add(this); }
      postMessage(value: unknown): void {
        sent.push({ name: this.name, value });
        for (const peer of channels) if (peer !== this && peer.name === this.name) {
          queueMicrotask(() => peer.onmessage?.({ data: value } as MessageEvent<unknown>));
        }
      }
      close(): void { channels.delete(this); }
    }
    vi.stubGlobal("BroadcastChannel", TestChannel);
    const reset = vi.fn();
    const unsubscribe = subscribeClientLayoutResetOccurrence(reset);

    publishClientLayoutResetOccurrence();
    await Promise.resolve();
    expect(reset).toHaveBeenCalledOnce();
    expect(sent).toEqual([{
      name: "joko:client-layout-reset:v1",
      value: { kind: "client-layout-reset" }
    }]);

    const sender = new TestChannel("joko:client-layout-reset:v1");
    sender.postMessage({ kind: "client-layout-reset", extra: true });
    sender.postMessage({ kind: "other" });
    sender.postMessage("client-layout-reset");
    sender.postMessage(["client-layout-reset"]);
    await Promise.resolve();
    expect(reset).toHaveBeenCalledOnce();
    unsubscribe();
    sender.close();
  });

  it("fences retained callbacks after idempotent cleanup even when close fails", () => {
    const retained: Array<(event: MessageEvent<unknown>) => void> = [];
    class TestChannel {
      private handler: ((event: MessageEvent<unknown>) => void) | null = null;
      set onmessage(value: ((event: MessageEvent<unknown>) => void) | null) {
        this.handler = value;
        if (value !== null) retained.push(value);
      }
      get onmessage(): ((event: MessageEvent<unknown>) => void) | null { return this.handler; }
      postMessage(): void {}
      close(): void { throw new Error("close failed"); }
    }
    vi.stubGlobal("BroadcastChannel", TestChannel);
    const reset = vi.fn();
    const unsubscribe = subscribeClientLayoutResetOccurrence(reset);

    expect(() => unsubscribe()).not.toThrow();
    expect(() => unsubscribe()).not.toThrow();
    retained[0]?.({ data: { kind: "client-layout-reset" } } as MessageEvent<unknown>);

    expect(reset).not.toHaveBeenCalled();
  });

  it("keeps local reset usable when BroadcastChannel is unavailable or publication fails", () => {
    localStorage.setItem(INSPECTOR_RATIO_STORAGE_KEY, "0.8");
    vi.stubGlobal("BroadcastChannel", undefined);

    expect(() => publishClientLayoutResetOccurrence()).not.toThrow();
    expect(() => subscribeClientLayoutResetOccurrence(vi.fn())()).not.toThrow();
    expect(() => resetClientLayout()).not.toThrow();
    expect(localStorage.getItem(INSPECTOR_RATIO_STORAGE_KEY)).toBeNull();

    class FailingChannel {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      postMessage(): void { throw new Error("post failed"); }
      close(): void { throw new Error("close failed"); }
    }
    vi.stubGlobal("BroadcastChannel", FailingChannel);
    expect(() => publishClientLayoutResetOccurrence()).not.toThrow();
  });
});
