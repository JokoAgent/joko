// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { useAppController, type AppController } from "./controller.js";
import { createOrchestratorGateway, probeOrchestratorOrigin, type GatewayCallbacks, type OrchestratorGateway } from "./gateway.js";
import { DEFAULT_UI_PREFERENCES, LocalState } from "./local-state.js";
import { remoteMachineProfileKey } from "./machine-federation.js";
import { emptySnapshot, type AppSnapshot, type ConnectionProfile, type SessionMessageSearchMatchView, type SessionMessageSearchResultView } from "./model.js";

vi.mock("./gateway.js", async (original) => ({
  ...await original<typeof import("./gateway.js")>(),
  createOrchestratorGateway: vi.fn(),
  probeOrchestratorOrigin: vi.fn()
}));

let root: Root | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps failures distinct from empty pages and drops outcomes from retired remote streams", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  localStorage.clear();
  window.history.replaceState(null, "", "#/settings");
  const profiles: readonly ConnectionProfile[] = ["east", "west"].map((id) => ({
    id, name: id, serverId: `node-${id}`, deviceId: `device-${id}`, origin: `https://${id}.example.test`
  }));
  vi.mocked(probeOrchestratorOrigin).mockImplementation(async (origin) => ({
    serverId: profiles.find((profile) => profile.origin === origin)!.serverId,
    displayName: "Node", version: "1", apiVersion: "1", pairingEnabled: false
  }));
  vi.spyOn(LocalState, "open").mockResolvedValue({
    listProfiles: async () => profiles,
    listMachineCaches: async () => [],
    readPreferences: async () => DEFAULT_UI_PREFERENCES,
    loadEndpointTransport: LocalState.prototype.loadEndpointTransport,
    readAuthKey: async () => "fixture-auth",
    saveMachineCache: async () => undefined
  } as unknown as LocalState);
  const snapshot = { ...emptySnapshot(), generation: 1n };
  const emptyPage = { matches: [], totalSize: 0, revision: 1n, vectorUsed: false, poolCapped: false };
  const eastSearch = vi.fn<OrchestratorGateway["searchAllSessionMessages"]>().mockResolvedValue(emptyPage);
  const westSearch = vi.fn<OrchestratorGateway["searchAllSessionMessages"]>().mockResolvedValue(emptyPage);
  const bindings = new Map<string, GatewayCallbacks>();
  vi.mocked(createOrchestratorGateway).mockImplementation((profile, _key, callbacks) => {
    if (callbacks.onLiveSnapshot) bindings.set(profile!.id, callbacks);
    return {
      connect: async () => {
        callbacks.onSnapshot?.(snapshot);
        callbacks.onState?.("connected");
        callbacks.onLiveSnapshot?.(snapshot);
      },
      disconnect: () => callbacks.onLiveSnapshot?.(undefined),
      searchAllSessionMessages: profile?.id === "east" ? eastSearch : westSearch
    } as unknown as OrchestratorGateway;
  });

  let app!: AppController;
  function Probe() {
    app = useAppController();
    return null;
  }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Probe />));
  await vi.waitFor(() => {
    expect(app.state.machinePresenceByProfile).toMatchObject({ east: "online", west: "online" });
    expect(app.state.nativeTaskStatusLiveSources).toHaveLength(2);
  });

  eastSearch.mockRejectedValueOnce(new Error("search cursor expired"));
  const outcomes = await app.searchRemoteSessionMessages(" needle ", { semanticMode: "hybrid" });
  expect(outcomes).toMatchObject([
    { profileId: "east", serverId: "node-east", status: "failed" },
    { profileId: "west", serverId: "node-west", status: "succeeded", matches: [] }
  ]);
  expect(eastSearch).toHaveBeenCalledWith("needle", expect.objectContaining({ semanticMode: "hybrid", scope: { kind: "owner" } }));
  const oldEast = outcomes.find((outcome) => outcome.profileId === "east")!;
  expect(oldEast.isCurrent()).toBe(true);

  let finishWest!: (page: SessionMessageSearchResultView) => void;
  westSearch.mockReturnValueOnce(new Promise((resolve) => { finishWest = resolve; }));
  const pending = app.searchRemoteSessionMessages("needle", { semanticMode: "keyword" });
  await Promise.resolve();
  const eastBinding = bindings.get("east")!;
  await act(async () => {
    eastBinding.onLiveSnapshot?.(undefined);
    eastBinding.onLiveSnapshot?.(snapshot);
  });
  expect(app.state.machinePresenceByProfile.east).toBe("online");
  expect(oldEast.isCurrent()).toBe(false);
  finishWest(emptyPage);
  expect(await pending).toMatchObject([{ profileId: "west", status: "succeeded", matches: [] }]);

  const current = await app.searchRemoteSessionMessages("needle", { semanticMode: "keyword" });
  expect(current.find((outcome) => outcome.profileId === "east")?.epoch).toBeGreaterThan(oldEast.epoch);

  const abort = new AbortController();
  westSearch.mockReturnValueOnce(new Promise((resolve) => { finishWest = resolve; }));
  const cancelled = app.searchRemoteSessionMessages("needle", { signal: abort.signal });
  const reason = new DOMException("Superseded search", "AbortError");
  const rejection = expect(cancelled).rejects.toBe(reason);
  abort.abort(reason);
  finishWest(emptyPage);
  await rejection;
  expect(westSearch).toHaveBeenLastCalledWith("needle", expect.objectContaining({ signal: abort.signal }));

  const projectId = "navigation-project";
  const projectTarget = { id: projectId, backendId: "backend", name: "Navigation project", workspaceId: "workspace",
    revision: 1n, workspaceName: "Navigation project", trusted: true, pinned: false, archived: false };
  const task = { id: "moved-in", backendId: "backend", targetId: "execution-target", projectId,
    name: "Moved in", state: "idle" as const, permissionMode: "ask" as const, planMode: false, fastMode: false,
    pinned: false, archived: false, generation: 1n, updatedAt: 1 };
  const projectSnapshot: AppSnapshot = { ...snapshot, targets: [projectTarget],
    workspaces: [{ id: "workspace", targetId: projectId, name: "Navigation project", kind: "userProject",
      serverPath: "/project", trusted: true, dirty: false, entries: [] }],
    sessions: [task, { ...task, id: "moved-out", targetId: projectId, projectId: undefined }] };
  await act(async () => {
    eastBinding.onLiveSnapshot?.(projectSnapshot);
    bindings.get("west")!.onLiveSnapshot?.(projectSnapshot);
  });
  const member: SessionMessageSearchMatchView = { sessionId: task.id, eventId: "event-a", timelineItemId: "item-a",
    role: "assistant", kind: "textMessage", snippet: "needle", score: 1, createdAt: 1 };
  const result = { ...emptyPage, matches: [member, { ...member, sessionId: "moved-out", eventId: "event-b" }] };
  const projects = [{ profileKey: remoteMachineProfileKey(profiles[0]!), projectId }];
  const westCalls = westSearch.mock.calls.length;
  eastSearch.mockResolvedValueOnce(result);
  const scoped = await app.searchRemoteSessionMessages("needle", { projects });
  expect(scoped).toMatchObject([{ profileId: "east", status: "succeeded", matches: [member] }]);
  expect(eastSearch).toHaveBeenLastCalledWith("needle", expect.objectContaining({ filters: { sessionIds: [task.id] } }));
  expect(westSearch).toHaveBeenCalledTimes(westCalls);

  const eastCalls = eastSearch.mock.calls.length;
  const retiredKey = remoteMachineProfileKey({ ...profiles[0]!, origin: "https://replaced.example.test" });
  expect(await app.searchRemoteSessionMessages("needle", { projects: [{ profileKey: retiredKey, projectId }] })).toEqual([]);
  expect(eastSearch).toHaveBeenCalledTimes(eastCalls);
  let releaseEast!: (page: SessionMessageSearchResultView) => void;
  eastSearch.mockReturnValueOnce(new Promise(resolve => { releaseEast = resolve; }));
  const moving = app.searchRemoteSessionMessages("needle", { projects });
  await act(async () => eastBinding.onLiveSnapshot?.({ ...projectSnapshot, sessions: [{ ...task, projectId: undefined }] }));
  releaseEast(result);
  expect(await moving).toMatchObject([{ profileId: "east", status: "succeeded", matches: [] }]);
});
