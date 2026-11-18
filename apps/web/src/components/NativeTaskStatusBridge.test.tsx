// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type ConnectionProfile, type Locale, type SessionView } from "../model.js";
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
        getSettings: vi.fn(async () => ({ enabled: true })),
        onSettingsChanged: vi.fn(() => vi.fn()),
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

it("keeps an observed archived completion retired after restore and publishes a fresh turn", async () => {
  const publish = vi.fn<JokoDesktopApi["nativeTaskStatus"]["publish"]>(async () => undefined);
  Object.defineProperty(window, "jokoDesktop", {
    configurable: true,
    value: { capabilities: ["native.taskStatus"], nativeTaskStatus: {
      getSettings: vi.fn(async () => ({ enabled: true })), onSettingsChanged: vi.fn(() => vi.fn()), publish,
      setVisibleSessions: vi.fn(async () => undefined), onAction: vi.fn(() => vi.fn())
    } } as unknown as JokoDesktopApi
  });
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  const profile: ConnectionProfile = { id: "profile", serverId: "node", deviceId: "desktop", name: "Local", origin: "https://node.example" };
  const original: SessionView = { id: "task", backendId: "backend", targetId: "target", name: "Original task",
    state: "idle", generation: 2n, archived: false, pinned: false, fastMode: false, permissionMode: "ask", planMode: false,
    updatedAt: 10, attention: { kind: "done", unread: true, updatedAt: 10, subjectCursor: { opaqueToken: "4", generation: 2n, sequence: 4n },
      attentionCursor: { opaqueToken: "5", generation: 2n, sequence: 5n }, readThroughCursor: { opaqueToken: "0", generation: 2n, sequence: 0n } } };
  const show = async (session: SessionView, source = profile) => {
    const base = controller("en");
    const connected: AppController = { ...base, state: { ...base.state, connectionState: "connected", activeProfile: source,
      profiles: [source], connectionGeneration: 1, snapshot: { ...emptySnapshot(), generation: 3n, sessions: [session] } } };
    await act(async () => root?.render(<NativeTaskStatusBridge controller={connected} ownsProjection visibleSessionIds={[]} />));
    return publish.mock.lastCall?.[0].sessions;
  };
  expect(await show(original)).toMatchObject([{ title: "Original task", phase: "completed" }]);
  expect(await show({ ...original, archived: true, updatedAt: 11 })).toEqual([]);
  expect(await show({ ...original, updatedAt: 11 })).toEqual([]);
  expect(original.attention?.unread).toBe(true);
  expect(await show({ ...original, state: "running", updatedAt: 12 })).toMatchObject([{ phase: "running" }]);
  expect(await show({ ...original, updatedAt: 20, attention: { ...original.attention!, updatedAt: 20,
    subjectCursor: { opaqueToken: "8", generation: 2n, sequence: 8n }, attentionCursor: { opaqueToken: "9", generation: 2n, sequence: 9n } } }))
    .toMatchObject([{ phase: "completed", completionIdentity: '["8","2","9","2"]' }]);
  expect(await show(original, { ...profile, id: "second", serverId: "second-node" })).toMatchObject([{ phase: "completed" }]);
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
