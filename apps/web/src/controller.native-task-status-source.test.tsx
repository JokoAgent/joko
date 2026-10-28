// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useAppController, type AppController } from "./controller.js";
import { createOrchestratorGateway, probeOrchestratorOrigin, type GatewayCallbacks, type OrchestratorGateway } from "./gateway.js";
import { LocalState, DEFAULT_UI_PREFERENCES } from "./local-state.js";
import { emptySnapshot, type ConnectionProfile, type SessionView } from "./model.js";
import { nativeTaskStatusProfileKey } from "./native-task-status-projection.js";

vi.mock("./gateway.js", async original => ({ ...await original<typeof import("./gateway.js")>(), createOrchestratorGateway: vi.fn(), probeOrchestratorOrigin: vi.fn() }));
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); Reflect.deleteProperty(window, "jokoDesktop"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const first: ConnectionProfile = { id: "first", serverId: "node-first", deviceId: "device-first", origin: "https://first.example", name: "First" };
const second: ConnectionProfile = { id: "second", serverId: "node-second", deviceId: "device-second", origin: "https://second.example", name: "Second" };

it("keeps live activity independent from task scope, offline caches and optimistic connection state, and retires removed profile callbacks", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  localStorage.clear(); window.history.replaceState(null, "", "#/settings");
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: { capabilities: ["native.taskStatus"], window: {} } });
  vi.mocked(probeOrchestratorOrigin).mockImplementation(async origin => ({ serverId: origin === first.origin ? first.serverId : second.serverId, displayName: "Node", version: "1", apiVersion: "1", pairingEnabled: false }));
  const preferences = { ...DEFAULT_UI_PREFERENCES, machineSelection: [first.id] };
  vi.spyOn(LocalState, "open").mockResolvedValue({ listProfiles: async () => [first, second], listMachineCaches: async () => [], readPreferences: async () => preferences,
    readAuthKey: async () => "fixture-auth", saveMachineCache: async () => undefined, deleteProfile: async () => undefined,
    withConnectionEntryLock: async <T,>(_profileId: string, action: () => Promise<T>): Promise<T> => action(),
    loadEndpointTransport: LocalState.prototype.loadEndpointTransport,
    mutatePreferences: async (update: (value: typeof preferences) => typeof preferences) => update(preferences)
  } as unknown as LocalState);
  const bindings = new Map<string, GatewayCallbacks>();
  const cursor = { opaqueToken: "completion-cursor", sequence: 12n, generation: 1n };
  const session: SessionView = { id: "completed", backendId: "backend", targetId: "target", name: "Completed task", state: "idle",
    pinned: false, archived: false, generation: 1n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 1,
    attention: { kind: "done", unread: true, subjectCursor: cursor, attentionCursor: cursor, readThroughCursor: { ...cursor, sequence: 0n }, updatedAt: 1 } };
  const snapshot = { ...emptySnapshot(), generation: 1n, sessions: [session] };
  const remoteArchive = vi.fn(async () => undefined), remoteRead = vi.fn(async () => undefined), foreignArchive = vi.fn(async () => undefined);
  vi.mocked(createOrchestratorGateway).mockImplementation((profile, _key, callbacks) => {
    if (callbacks.onLiveSnapshot) bindings.set(profile!.id, callbacks);
    return { connect: async () => { callbacks.onSnapshot?.(snapshot); callbacks.onState?.("connected"); },
      disconnect: () => callbacks.onLiveSnapshot?.(undefined), listPartners: async () => ({ partners: [] }),
      archiveSession: profile?.id === second.id && callbacks.onLiveSnapshot ? remoteArchive : foreignArchive,
      acknowledgeSessionAttention: profile?.id === second.id && callbacks.onLiveSnapshot ? remoteRead : vi.fn(),
      getSessionWorktreeRemovalPreview: async () => ({ sessionId: session.id, archiveConfirmation: "bound-schedules", activeBoundScheduleCount: 0, activeBoundScheduleNames: [], shared: false, worktree: undefined })
    } as unknown as OrchestratorGateway;
  });
  let app: AppController | undefined; function Probe() { app = useAppController(); return null; }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root!.render(<Probe />); });
  await vi.waitFor(() => expect(bindings.size).toBe(2));
  expect(app!.state.machineCaches.some(cache => cache.profileId === first.id)).toBe(true);
  expect(app!.state.nativeTaskStatusLiveSources ?? []).toEqual([]);
  const original = bindings.get(second.id)!;
  await act(async () => original.onLiveSnapshot?.(snapshot));
  const firstEpoch = app!.state.nativeTaskStatusLiveSources![0]!.epoch;
  expect(app!.state.nativeTaskStatusLiveSources![0]!.profile.id).toBe(second.id);
  const route = { profileId: second.id, serverId: second.serverId, profileKey: nativeTaskStatusProfileKey(second), epoch: firstEpoch,
    sessionId: session.id, generation: session.generation, sourceGeneration: snapshot.generation };
  const completion = app!.nativeTaskStatusCompletionSource!(route)!;
  expect(completion?.isCurrent()).toBe(true);
  await completion.markRead(); expect(remoteRead).toHaveBeenCalledExactlyOnceWith(session.id, cursor);
  await completion.archive("bound-schedules"); expect(remoteArchive).toHaveBeenCalledExactlyOnceWith(session.id, true, "bound-schedules");
  expect(foreignArchive).not.toHaveBeenCalled();
  expect(app!.nativeTaskStatusCompletionSource!({ ...route, profileKey: nativeTaskStatusProfileKey({ ...second, origin: "https://foreign.example" }) })).toBeUndefined();
  await act(async () => { original.onLiveSnapshot?.(undefined); original.onSnapshot?.(snapshot); original.onState?.("connected"); });
  expect(completion.isCurrent()).toBe(false);
  await expect(completion.archive("bound-schedules")).rejects.toThrow(/owner changed/u);
  expect(app!.state.nativeTaskStatusLiveSources).toEqual([]); expect(app!.state.machineCaches.some(cache => cache.profileId === second.id)).toBe(true);
  await act(async () => original.onLiveSnapshot?.(snapshot));
  expect(app!.state.nativeTaskStatusLiveSources![0]!.epoch).toBeGreaterThan(firstEpoch);
  expect(app!.nativeTaskStatusCompletionSource!(route)).toBeUndefined();
  await act(async () => app!.forgetProfile(second.id));
  await act(async () => original.onLiveSnapshot?.(snapshot));
  expect(app!.state.nativeTaskStatusLiveSources).toEqual([]);
});
