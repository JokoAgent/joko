// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppWithController } from "./App.js";
import type { AppController, ControllerState } from "./controller.js";
import { DEFAULT_UI_PREFERENCES } from "./local-state.js";
import { emptySnapshot } from "./model.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeBroadcastChannel {
  static readonly instances: FakeBroadcastChannel[] = [];

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly postMessage = vi.fn();
  readonly close = vi.fn();

  constructor(readonly name: string) {
    FakeBroadcastChannel.instances.push(this);
  }
}

function createController() {
  const state: ControllerState = {
    ready: false,
    connectionState: "disconnected",
    profiles: [],
    machineCaches: [],
    machinePresenceByProfile: {},
    discoveredNodes: [],
    discoveryState: "idle",
    managedOrchestratorStatus: undefined,
    automaticConnectionAvailable: false,
    snapshot: emptySnapshot(),
    route: { kind: "session" },
    navigationRevision: 0,
    preferences: DEFAULT_UI_PREFERENCES,
    systemLocale: "en",
    effectiveLocale: "en",
    extensionNotifications: []
  };
  const synchronizeLayoutReset = vi.fn();
  const resetLayoutPreferences = vi.fn(async () => undefined);
  return {
    controller: {
      state,
      synchronizeLayoutReset,
      resetLayoutPreferences,
      navigate: vi.fn(),
      setNavigationOpen: vi.fn(async () => undefined),
      changeWindowZoom: vi.fn(async () => 1)
    } as unknown as AppController,
    resetLayoutPreferences,
    synchronizeLayoutReset
  };
}

function createMountedRoot(): { readonly container: HTMLDivElement; readonly root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  return { container, root: createRoot(container) };
}

describe("layout reset broadcast", () => {
  beforeEach(() => {
    FakeBroadcastChannel.instances.length = 0;
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    Reflect.deleteProperty(window, "jokoDesktop");
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "jokoDesktop");
    vi.unstubAllGlobals();
  });

  it("synchronizes an ordinary Web receiver without persisting or echoing and retires retained callbacks", async () => {
    const first = createController();
    const replacement = createController();
    const { container, root } = createMountedRoot();

    await act(async () => { root.render(createElement(AppWithController, { controller: first.controller })); });
    const channel = FakeBroadcastChannel.instances.find((candidate) => candidate.name === "joko:client-layout-reset:v1");
    expect(channel).toBeDefined();
    const retainedCallback = channel?.onmessage;

    await act(async () => { root.render(createElement(AppWithController, { controller: replacement.controller })); });
    act(() => channel?.onmessage?.(new MessageEvent("message", { data: { kind: "client-layout-reset", extra: true } })));
    expect(replacement.synchronizeLayoutReset).not.toHaveBeenCalled();

    act(() => channel?.onmessage?.(new MessageEvent("message", { data: { kind: "client-layout-reset" } })));

    expect(first.synchronizeLayoutReset).not.toHaveBeenCalled();
    expect(replacement.synchronizeLayoutReset).toHaveBeenCalledOnce();
    expect(first.resetLayoutPreferences).not.toHaveBeenCalled();
    expect(replacement.resetLayoutPreferences).not.toHaveBeenCalled();
    expect(channel?.postMessage).not.toHaveBeenCalled();

    await act(async () => { root.unmount(); });
    retainedCallback?.(new MessageEvent("message", { data: { kind: "client-layout-reset" } }));
    expect(replacement.synchronizeLayoutReset).toHaveBeenCalledOnce();
    expect(channel?.close).toHaveBeenCalledOnce();
    container.remove();
  });

  it("keeps the Desktop receiver on native layout IPC without also subscribing to the client channel", async () => {
    let listener: (() => void) | undefined;
    const unsubscribe = vi.fn();
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: {
        platform: "win32",
        capabilities: ["layout.reset"],
        layout: {
          reset: vi.fn(async () => undefined),
          onReset: vi.fn((next: () => void) => {
            listener = next;
            return unsubscribe;
          })
        },
        applicationMenu: {
          configure: vi.fn(async () => undefined),
          onCommand: vi.fn(() => vi.fn())
        }
      } as unknown as JokoDesktopApi
    });
    const { controller, resetLayoutPreferences, synchronizeLayoutReset } = createController();
    const { container, root } = createMountedRoot();

    await act(async () => { root.render(createElement(AppWithController, { controller })); });
    const retainedListener = listener;
    act(() => listener?.());

    expect(synchronizeLayoutReset).toHaveBeenCalledOnce();
    expect(resetLayoutPreferences).not.toHaveBeenCalled();
    expect(FakeBroadcastChannel.instances.some((candidate) => candidate.name === "joko:client-layout-reset:v1")).toBe(false);

    await act(async () => { root.unmount(); });
    retainedListener?.();
    expect(synchronizeLayoutReset).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    container.remove();
  });
});
