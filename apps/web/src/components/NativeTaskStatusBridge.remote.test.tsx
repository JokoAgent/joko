// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { remoteEntryToken } from "@joko/contracts";
import type { AppController } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type SessionView, type PartnerProfileView } from "../model.js";
import type { AppRoute } from "../controller.js";
import { NativeTaskStatusBridge } from "./NativeTaskStatusBridge.js";

let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); Reflect.deleteProperty(window, "jokoDesktop"); vi.restoreAllMocks(); });
const profile = { id: "original-profile", serverId: "original-node", deviceId: "device", origin: "https://original.example", name: "Original computer" };
const session = (phase: SessionView["state"]): SessionView => ({ id: "original-session", backendId: "backend", targetId: "target", name: "Task", state: phase, generation: 2n,
  pinned: false, archived: false, fastMode: false, planMode: false, permissionMode: "ask", updatedAt: 1,
  taskActivity: { runId: "run", completedReplySummary: "", completionNotification: "none", silent: false } });
const partner = { id: "original-partner", displayName: "Companion", avatar: "leaf", canonicalSessionId: "original-session", lifecycle: "active",
  activity: { unreadReplyCount: 0 } } as PartnerProfileView;

async function mount(enabled = true, companion = true) {
  let action!: (action: JokoDesktopNativeTaskStatusAction) => void;
  const publish = vi.fn(async (_value: JokoDesktopNativeTaskStatusSnapshot) => undefined), acknowledge = vi.fn(async () => undefined), notify = vi.fn(async () => undefined);
  const open = vi.fn(async () => undefined), resolveInteraction = vi.fn(async () => undefined);
  let state = { ready: true, connectionState: "disconnected", profiles: [profile], machineCaches: [], snapshot: emptySnapshot(), route: { kind: "session" } as AppRoute,
    effectiveLocale: "en", preferences: DEFAULT_UI_PREFERENCES,
    nativeTaskStatusLiveSources: [{ profile, epoch: 1, snapshot: { ...emptySnapshot(), generation: 3n, sessions: [session("running")] }, partners: companion ? [partner] : [] }] };
  const controller = { get state() { return state; }, openMachineSession: open, resolveInteraction, navigate: vi.fn() } as unknown as AppController;
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: { capabilities: ["native.taskStatus", "notifications.session"], notify,
    nativeTaskStatus: { publish, acknowledgeFocus: acknowledge, getSettings: async () => ({ enabled }), onSettingsChanged: () => () => undefined,
      setVisibleSessions: async () => undefined, onAction: (listener: typeof action) => { action = listener; return () => undefined; } } } });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  const render = async () => act(async () => { root!.render(<NativeTaskStatusBridge controller={controller} ownsProjection visibleSessionIds={[]} />); });
  await render();
  return { publish, acknowledge, notify, open, resolveInteraction, action: (value: JokoDesktopNativeTaskStatusAction) => action(value),
    entry: () => publish.mock.calls.at(-1)![0].sessions[0]!,
    update: async (phase: SessionView["state"], epoch = 1, route = state.route) => {
      state = { ...state, route, nativeTaskStatusLiveSources: [{ ...state.nativeTaskStatusLiveSources[0]!, epoch,
        snapshot: { ...state.nativeTaskStatusLiveSources[0]!.snapshot, sessions: [session(phase)] } }] }; await render();
    } };
}

it("routes an unchanged companion click through its original profile and canonical task, acknowledging only after route commit", async () => {
  const view = await mount(); await view.update("error");
  const entry = view.entry(), token = remoteEntryToken(entry);
  await act(async () => {
    view.action({ kind: "permission", sessionId: entry.sessionId, interactionId: "remote-permission", generation: "2", decision: "allow" });
    view.action({ kind: "focus", sessionId: entry.sessionId }); view.action({ kind: "focus", sessionId: entry.sessionId, entryToken: "stale" });
  });
  expect(view.resolveInteraction).not.toHaveBeenCalled(); expect(view.open).not.toHaveBeenCalled();
  await act(async () => view.action({ kind: "focus", sessionId: entry.sessionId, entryToken: token }));
  expect(view.open).toHaveBeenCalledWith(profile.id, "original-session", { partnerId: "original-partner" }); expect(view.acknowledge).not.toHaveBeenCalled();
  await view.update("error", 1, { kind: "session", profileId: profile.id, sessionId: "original-session", partnerId: "original-partner" });
  expect(view.acknowledge).toHaveBeenCalledExactlyOnceWith(entry.sessionId, token);
});

it("rejects an old source epoch and never clears attention after a canceled route", async () => {
  const view = await mount(); await view.update("error"); const old = view.entry();
  await view.update("error", 2);
  await act(async () => view.action({ kind: "focus", sessionId: old.sessionId, entryToken: remoteEntryToken(old) }));
  expect(view.open).not.toHaveBeenCalled();
  const current = view.entry(); await act(async () => view.action({ kind: "focus", sessionId: current.sessionId, entryToken: remoteEntryToken(current) }));
  await view.update("error", 2, { kind: "settings", section: "general" } as AppRoute);
  expect(view.acknowledge).not.toHaveBeenCalled();
});

it.each([true, false])("uses background system notifications for real edges only when native floating status is disabled (%s)", async enabled => {
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const view = await mount(enabled, false);
  await view.update("error"); await view.update("error");
  expect(view.notify).toHaveBeenCalledTimes(enabled ? 0 : 1);
  if (!enabled) expect(view.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Task · Original computer", navigation: { kind: "nativeTask", sessionId: view.entry().sessionId, entryToken: remoteEntryToken(view.entry()) } }));
  await view.update("running", 2); vi.mocked(document.hasFocus).mockReturnValue(true); await view.update("error", 2);
  expect(view.notify).toHaveBeenCalledTimes(enabled ? 0 : 1);
});
