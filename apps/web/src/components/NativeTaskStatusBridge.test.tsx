// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type Locale } from "../model.js";
import { NativeTaskStatusBridge } from "./NativeTaskStatusBridge.js";

let root: Root | undefined;

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "jokoDesktop");
});

it("publishes only the concrete effective locale, including the unmount tombstone", async () => {
  const publish = vi.fn(async () => undefined);
  Object.defineProperty(window, "jokoDesktop", {
    configurable: true,
    value: {
      capabilities: ["native.taskStatus"],
      nativeTaskStatus: {
        publish,
        setVisibleSessions: vi.fn(async () => undefined),
        onAction: vi.fn(() => vi.fn())
      }
    } as unknown as JokoDesktopApi
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(<NativeTaskStatusBridge
      controller={controller("zh-CN")}
      ownsProjection
      visibleSessionIds={[]}
    />);
  });
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ locale: "zh-CN" }));
  expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ locale: "system" }));

  await act(async () => {
    root?.render(<NativeTaskStatusBridge
      controller={controller("en-XA")}
      ownsProjection
      visibleSessionIds={[]}
    />);
  });
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ locale: "en-XA" }));

  await act(async () => root?.unmount());
  root = undefined;
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
    ownerId: "renderer-unmounted",
    locale: "en-XA"
  }));
});

function controller(effectiveLocale: Locale): AppController {
  return {
    state: {
      ready: true,
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
      preferences: DEFAULT_UI_PREFERENCES,
      systemLocale: "zh-CN",
      effectiveLocale,
      extensionNotifications: []
    },
    navigate: vi.fn()
  } as unknown as AppController;
}
