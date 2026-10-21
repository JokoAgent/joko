// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppController, type AppController } from "./controller.js";
import { createOrchestratorGateway, probeOrchestratorOrigin, type OrchestratorGateway } from "./gateway.js";
import { DEFAULT_UI_PREFERENCES, LocalState } from "./local-state.js";
import { emptySnapshot, type AppSnapshot, type ConnectionProfile, type PartnerProfileView } from "./model.js";
import { partnerSourceKey } from "./partner-sources.js";

vi.mock("./gateway.js", async importOriginal => ({ ...await importOriginal<typeof import("./gateway.js")>(), createOrchestratorGateway: vi.fn(), probeOrchestratorOrigin: vi.fn() }));
let root: Root | undefined;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  localStorage.clear(); window.history.replaceState(null, "", "#/partners"); });
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const first: ConnectionProfile = { id: "connection-a", serverId: "node-a", deviceId: "device-a", origin: "https://a.example", name: "A" };
const second: ConnectionProfile = { id: "connection-b", serverId: "node-b", deviceId: "device-b", origin: "https://b.example", name: "B" };

it("adopts the original node, revalidates its Partner and commits an explicit Partner task route through the real hash handoff", async () => {
  const view = await mount();
  await act(async () => { await view.app()!.openSourcePartner!(partnerSourceKey(second), "same-partner", "session"); await settle(); });
  await vi.waitFor(() => expect(view.app()!.state.route).toMatchObject({ kind: "session", profileId: second.id, partnerId: "same-partner", sessionId: "session-node-b" }));
  expect(window.location.hash).toContain("partner=same-partner"); expect(view.app()!.state.activeProfile?.id).toBe(second.id);
  expect(view.reads.filter(value => value === "active:node-b")).toHaveLength(1);
});
it("rejects a canonical relationship that changes after node adoption without routing to the ordinary task", async () => {
  const view = await mount(true);
  await act(async () => { await expect(view.app()!.openSourcePartner!(partnerSourceKey(second), "same-partner", "session")).rejects.toThrow("canonical task or home changed"); });
  expect(view.app()!.state.route.kind).toBe("partners"); expect(window.location.hash).toBe("#/partners");
});
it.each(["pending", "error"] as const)("adopts an original %s Partner without a canonical task and opens only its initialization card", async state => {
  const view = await mount(false, state);
  await act(async () => { await view.app()!.openSourcePartner!(partnerSourceKey(second), "same-partner", "preparation"); await settle(); });
  await vi.waitFor(() => expect(view.app()!.state.route).toEqual({ kind: "partners", profileId: second.id, partnerId: "same-partner", preparation: true }));
  expect(window.location.hash).toContain("prepare=1"); expect(view.app()!.state.activeProfile?.id).toBe(second.id);
  expect(view.reads).toEqual(["source:node-b", "active:node-b"]); expect(view.linkReads).not.toHaveBeenCalled();
});
it("rejects a preparing profile whose original home changes after node adoption", async () => {
  const view = await mount(true, "error");
  await act(async () => { await expect(view.app()!.openSourcePartner!(partnerSourceKey(second), "same-partner", "preparation")).rejects.toThrow("relationship changed while connecting"); });
  expect(view.app()!.state.route.kind).toBe("partners"); expect(window.location.hash).toBe("#/partners");
});

async function mount(drift = false, initializationState?: "pending" | "error") {
  const reads: string[] = [];
  const linkReads = vi.fn();
  vi.mocked(probeOrchestratorOrigin).mockImplementation(async origin => ({ serverId: origin === first.origin ? first.serverId : second.serverId, displayName: "Node", version: "1", apiVersion: "1", pairingEnabled: true }));
  vi.spyOn(LocalState, "open").mockResolvedValue({ listProfiles: async () => [first, second], listMachineCaches: async () => [], readPreferences: async () => DEFAULT_UI_PREFERENCES,
    readAuthKey: async () => "private", saveProfile: async () => undefined, saveMachineCache: async () => undefined,
    mutatePreferences: async (update: (value: typeof DEFAULT_UI_PREFERENCES) => typeof DEFAULT_UI_PREFERENCES) => update(DEFAULT_UI_PREFERENCES)
  } as unknown as LocalState);
  vi.mocked(createOrchestratorGateway).mockImplementation((owner, _key, callbacks) => {
    const active = callbacks.onExtensionUiEffect !== undefined, value = owner!;
    const preparing = value.id === second.id && initializationState !== undefined;
    const snapshot = preparing ? { ...ownerSnapshot(value), sessions: [] } : ownerSnapshot(value);
    const currentProfile = (): PartnerProfileView => preparing ? { ...partner(value), initializationState, invitationStage: initializationState === "error" ? "failed" : "session", canonicalSessionId: undefined } : partner(value);
    return { connect: async () => { callbacks.onSnapshot?.(snapshot); callbacks.onState?.("connected"); }, disconnect: () => undefined,
      taskSharingApi: () => undefined,
      refresh: async () => callbacks.onSnapshot?.(snapshot), listPartners: async () => ({ partners: [currentProfile()], directory: { revision: 1n, templates: [], avatarPresets: ["orbit"], activeCount: 1, archivedCount: 0, errorCount: 0, updatedAt: 1 } }),
      getPartner: async () => { reads.push((active ? "active:" : "source:") + value.serverId); return { ...currentProfile(), ...(drift && active && value.id === second.id ? preparing ? { homeTargetId: "changed-home" } : { canonicalSessionId: "changed" } : {}) }; },
      listPartnerSessions: async () => { linkReads(); return [{ partnerId: "same-partner", sessionId: "session-" + value.serverId, role: "canonical", profileVersion: 1n, available: true, readOnly: false, archived: false, deleted: false, displayName: "Task", createdAt: 1 }]; }
    } as unknown as OrchestratorGateway;
  });
  let app: AppController | undefined; function Probe() { app = useAppController(); return null; }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root!.render(<Probe />); await settle(); });
  await vi.waitFor(() => expect(app?.state.ready).toBe(true));
  await act(async () => { await app!.connect(first); await settle(); });
  await vi.waitFor(() => expect(app?.state.connectionState).toBe("connected"));
  return { app: () => app, reads, linkReads };
}
function partner(owner: ConnectionProfile): PartnerProfileView { return { id: "same-partner", revision: 1n, profileVersion: 1n, displayName: "Partner", description: "", avatar: "orbit", identitySource: "private identity", templateId: "general", lifecycle: "active", initializationState: "ready", invitationStage: "ready", homeTargetId: "home-" + owner.serverId, canonicalSessionId: "session-" + owner.serverId,
  capabilities: { permissionMode: "ask", planMode: false, modelChain: [] }, usesDirectoryDefaults: true, createdAt: 1, updatedAt: 1,
  activity: { partnerId: "same-partner", unreadReplyCount: 0, artifactCount: 0, activeDelegationCount: 0, readThroughCursor: 0n, readUpdatedAt: 1 } }; }
function ownerSnapshot(owner: ConnectionProfile): AppSnapshot { return { ...emptySnapshot(), generation: 1n,
  remoteConnections: [{ id: owner.id, deviceId: owner.deviceId, name: owner.name, state: "connected" }],
  devices: [{ id: owner.deviceId, name: "Device", defaultDisplayName: "Device", revision: 1n, kind: "web", platform: "web", appVersion: "1", revoked: false, remoteControlEnabled: false, presence: "online" }],
  backends: [{ id: "backend", name: "Backend", version: "1", health: "healthy", capabilities: new Map() }],
  targets: [{ id: "home-" + owner.serverId, revision: 1n, backendId: "backend", name: "Home", workspaceId: "workspace", workspaceName: "Home", trusted: true, archived: false, pinned: false }],
  sessions: [{ id: "session-" + owner.serverId, targetId: "home-" + owner.serverId, backendId: "backend", name: "Task", state: "idle", pinned: false, archived: false, generation: 1n, fastMode: false, planMode: false, permissionMode: "ask", updatedAt: 1 }] }; }
async function settle() { for (let index = 0; index < 16; index += 1) await Promise.resolve(); }
