// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { ListConnectionEntriesResponseSchema } from "@joko/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { useAppController, type AppController } from "./controller.js";
import { createOrchestratorGateway, discoverOrchestratorNodesAt, GatewayError, probeOrchestratorOrigin,
  type GatewayCallbacks, type OrchestratorGateway } from "./gateway.js";
import { DEFAULT_UI_PREFERENCES, LocalState } from "./local-state.js";
import { EndpointTrustError } from "@joko/connection-transport/trust";
import { connectionEntryOwnerKey, readConnectionEntryDirectory, resolvePreparedConnection, verifyConnectionEntry,
  type SavedConnectionEntries } from "@joko/connection-transport/entries";
import { emptySnapshot, type ConnectionProfile } from "./model.js";

vi.mock("./gateway.js", async original => ({ ...await original<typeof import("./gateway.js")>(),
  createOrchestratorGateway: vi.fn(), probeOrchestratorOrigin: vi.fn(), discoverOrchestratorNodesAt: vi.fn(async () => []) }));
vi.mock("@joko/connection-transport/entries", async original => {
  const entries = await original<typeof import("@joko/connection-transport/entries")>();
  return { ...entries, readConnectionEntryDirectory: vi.fn(entries.readConnectionEntryDirectory),
    resolvePreparedConnection: vi.fn(entries.resolvePreparedConnection), verifyConnectionEntry: vi.fn(entries.verifyConnectionEntry) };
});
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it("keeps the prepared backup when a preferred entrance probe finishes after return was disabled", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  localStorage.clear(); window.history.replaceState(null, "", "#/settings");
  const endpointPublicKey = `ed25519:${"6".repeat(64)}`;
  const preferred = { id: "preferred", name: "Preferred", origin: "https://preferred-entry.example", provider: "direct",
    kind: "https" as const, published: true, prepared: true };
  const backup = { ...preferred, id: "backup", name: "Backup", origin: "https://backup-entry.example" };
  const profile: ConnectionProfile = { id: "node-profile", serverId: "node", deviceId: "device", endpointPublicKey,
    origin: backup.origin, entryId: backup.id, name: "Node" };
  const owner = { profileId: profile.id, serverId: profile.serverId, deviceId: profile.deviceId, endpointPublicKey };
  let saved: SavedConnectionEntries = { version: 1, owner: connectionEntryOwnerKey(owner), revision: "initial", entries: [preferred, backup],
    preferredId: preferred.id, backupIds: [backup.id], returnToPreferred: true };
  const directory = vi.mocked(readConnectionEntryDirectory).mockResolvedValue(create(ListConnectionEntriesResponseSchema, {
    serverId: owner.serverId, endpointPublicKey, revision: "current", entries: [preferred, backup].map(entry => ({
      entryId: entry.id, origin: entry.origin, displayName: entry.name, provider: entry.provider, transportKind: entry.kind
    }))
  }));
  const resolve = vi.mocked(resolvePreparedConnection).mockImplementation(async (_owner, entries, readAuthKey, _supported, _signal, id) => {
    const entry = entries.entries.find(candidate => candidate.id === (id ?? backup.id));
    const authKey = await readAuthKey();
    if (!entry || !authKey) throw new Error("The selected entrance or credential was unavailable.");
    return { entry, authKey, saved: entries, failures: [] };
  });
  let finishProbe!: () => void;
  const verify = vi.mocked(verifyConnectionEntry).mockResolvedValue(undefined)
    .mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
    .mockImplementationOnce(() => new Promise<void>(resolve => { finishProbe = resolve; }));
  vi.spyOn(LocalState, "open").mockResolvedValue({ listProfiles: async () => [profile], listMachineCaches: async () => [],
    readPreferences: async () => DEFAULT_UI_PREFERENCES, readAuthKey: async () => "credential", saveProfile: async () => undefined,
    saveMachineCache: async () => undefined, readConnectionEntries: async () => saved,
    writeConnectionEntries: async (_profile: ConnectionProfile, next: SavedConnectionEntries) => { saved = next; },
    withConnectionEntryLock: async <T,>(_id: string, action: () => Promise<T>) => action()
  } as unknown as LocalState);
  vi.mocked(probeOrchestratorOrigin).mockResolvedValue({ serverId: owner.serverId, displayName: "Node", version: "1", apiVersion: "1", pairingEnabled: false });
  vi.mocked(createOrchestratorGateway).mockImplementation((_profile, _key, callbacks) => ({
    connect: async () => { callbacks.onSnapshot?.(emptySnapshot()); callbacks.onState?.("connected"); }, disconnect: () => undefined,
    taskSharingApi: () => undefined, inputHandoffApi: () => undefined, providerSharingApi: () => undefined,
    partnerNetworkApi: () => undefined, partnerIdentityApi: () => undefined, providerGroupSettingsApi: () => undefined,
    listPartners: async () => ({ partners: [] })
  } as unknown as OrchestratorGateway));
  try {
    let app!: AppController; function Probe() { app = useAppController(); return null; }
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<Probe />));
    expect(app.state.ready).toBe(true);
    await act(async () => app.connect(profile));
    expect(app.state.activeProfile?.entryId).toBe(backup.id);
    await act(async () => vi.advanceTimersByTimeAsync(90_000));
    expect(verify).toHaveBeenCalledTimes(3);
    await act(async () => app.setConnectionEntryPolicy!(profile.id, [backup.id], false));
    expect(saved.returnToPreferred).toBe(false);
    await act(async () => finishProbe());
    expect(app.state).toMatchObject({ connectionState: "connected", activeProfile: { entryId: backup.id } });
    expect(resolve).toHaveBeenCalledOnce();

    await act(async () => app.connect(profile, { entryId: preferred.id }));
    expect(app.state.activeProfile?.entryId).toBe(preferred.id);
    expect(saved.returnToPreferred).toBe(false);
  } finally { directory.mockRestore(); resolve.mockRestore(); verify.mockRestore(); }
});

it("keeps connection failures through fresh projections, restores on acceptance, and ignores a retired owner's callbacks", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  localStorage.clear(); window.history.replaceState(null, "", "#/settings");
  const profiles: ConnectionProfile[] = ["first", "second"].map(id => ({ id, serverId: `node-${id}`, deviceId: `device-${id}`,
    name: id, origin: `https://${id}.example` }));
  vi.mocked(discoverOrchestratorNodesAt).mockResolvedValue([]);
  vi.mocked(probeOrchestratorOrigin).mockImplementation(async origin => ({ serverId: profiles.find(profile => profile.origin === origin)!.serverId,
    displayName: "Node", version: "1", apiVersion: "1", pairingEnabled: false }));
  const deleteAuthKey = vi.fn(async () => undefined);
  vi.spyOn(LocalState, "open").mockResolvedValue({ listProfiles: async () => profiles, listMachineCaches: async () => [], deleteAuthKey,
    readPreferences: async () => ({ ...DEFAULT_UI_PREFERENCES, machineSelection: ["unselected-profile"] }),
    readAuthKey: async () => "credential", saveProfile: async () => undefined, saveMachineCache: async () => undefined,
    loadEndpointTransport: LocalState.prototype.loadEndpointTransport
  } as unknown as LocalState);
  const active = new Map<string, GatewayCallbacks>();
  vi.mocked(createOrchestratorGateway).mockImplementation((profile, _key, callbacks) => {
    if (callbacks.onExtensionUiEffect) active.set(profile!.id, callbacks);
    return { connect: async () => { callbacks.onSnapshot?.(emptySnapshot()); callbacks.onState?.("connected"); },
      disconnect: () => undefined, taskSharingApi: () => undefined, inputHandoffApi: () => undefined,
      providerSharingApi: () => undefined, partnerNetworkApi: () => undefined, partnerIdentityApi: () => undefined,
      providerGroupSettingsApi: () => undefined, listPartners: async () => ({ partners: [] }) } as unknown as OrchestratorGateway;
  });
  let app!: AppController; function Probe() { app = useAppController(); return null; }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Probe />));
  await vi.waitFor(() => expect(app.state.ready).toBe(true));
  await act(async () => app.connect(profiles[0]!));
  const first = active.get(profiles[0]!.id)!;
  await act(async () => {
    first.onError?.(new GatewayError("Event upstream offline", { offline: true }));
    first.onState?.("offline", "Retrying event connection");
    first.onSnapshot?.({ ...emptySnapshot(), revision: 2n });
  });
  expect(app.state).toMatchObject({ connectionState: "offline", error: "Event upstream offline",
    statusMessage: "Retrying event connection", snapshot: { revision: 2n } });
  await act(async () => first.onState?.("connected"));
  expect(app.state.connectionState).toBe("connected"); expect(app.state.error).toBeUndefined(); expect(app.state.statusMessage).toBeUndefined();

  await act(async () => app.connect(profiles[1]!));
  const second = active.get(profiles[1]!.id)!;
  await act(async () => {
    second.onError?.(new GatewayError("Current owner offline", { offline: true }));
    second.onState?.("offline");
    second.onSnapshot?.({ ...emptySnapshot(), revision: 3n });
    first.onState?.("connected"); first.onSnapshot?.({ ...emptySnapshot(), revision: 99n });
  });
  expect(app.state).toMatchObject({ activeProfile: { id: profiles[1]!.id }, connectionState: "offline",
    error: "Current owner offline", snapshot: { revision: 3n } });
  await act(async () => second.onState?.("connected"));
  expect(app.state.connectionState).toBe("connected"); expect(app.state.error).toBeUndefined();
  await act(async () => second.onAuthenticationInvalidated?.(new GatewayError("Verify the node public key.", { cause: new EndpointTrustError() })));
  expect(app.state.connectionState).toBe("disconnected");
  expect(app.state.activeProfile).toBeUndefined();
  expect(app.state.profiles).toHaveLength(2);
  expect(deleteAuthKey).not.toHaveBeenCalled();
});
