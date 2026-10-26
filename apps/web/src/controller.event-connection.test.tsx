// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useAppController, type AppController } from "./controller.js";
import { createOrchestratorGateway, discoverOrchestratorNodesAt, GatewayError, probeOrchestratorOrigin,
  type GatewayCallbacks, type OrchestratorGateway } from "./gateway.js";
import { DEFAULT_UI_PREFERENCES, LocalState } from "./local-state.js";
import { EndpointTrustError } from "@joko/connection-transport/trust";
import { emptySnapshot, type ConnectionProfile } from "./model.js";

vi.mock("./gateway.js", async original => ({ ...await original<typeof import("./gateway.js")>(),
  createOrchestratorGateway: vi.fn(), probeOrchestratorOrigin: vi.fn(), discoverOrchestratorNodesAt: vi.fn(async () => []) }));
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
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
