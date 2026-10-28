// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useAppController, type AppController } from "./controller.js";
import { createOrchestratorGateway, probeOrchestratorOrigin, type OrchestratorGateway } from "./gateway.js";
import { DEFAULT_UI_PREFERENCES, LocalState } from "./local-state.js";
import { emptySnapshot, type ComposerDraft, type ConnectionProfile, type SessionView } from "./model.js";

vi.mock("./gateway.js", async original => ({ ...await original<typeof import("./gateway.js")>(),
  createOrchestratorGateway: vi.fn(), probeOrchestratorOrigin: vi.fn(), discoverOrchestratorNodesAt: vi.fn(async () => []) }));
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined;
  document.body.replaceChildren(); window.history.replaceState(null, "", "/"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const PROFILE: ConnectionProfile = { id: "profile", serverId: "server", deviceId: "device", name: "Local", origin: "http://127.0.0.1:4318" };
const DRAFT: ComposerDraft = { text: "Own draft", attachments: [], mentions: [], deliveryMode: "prompt" };

async function mount(sessions: readonly SessionView[] = []) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  window.history.replaceState(null, "", "/?sessionWindow=1&bootSession=session#/tasks/session");
  const readDraft = vi.fn(async (): Promise<ComposerDraft | undefined> => undefined), saveDraft = vi.fn(async () => undefined);
  const readDraftSnapshot = vi.fn(async () => ({ revision: 0 })), saveDraftIfRevision = vi.fn(async () => 1);
  vi.spyOn(LocalState, "open").mockResolvedValue({ readDraft, saveDraft, readDraftSnapshot, saveDraftIfRevision,
    listProfiles: async () => [], listMachineCaches: async () => [], readPreferences: async () => DEFAULT_UI_PREFERENCES,
    readAuthKey: async () => "credential", saveProfile: async () => undefined, saveMachineCache: async () => undefined,
    loadEndpointTransport: LocalState.prototype.loadEndpointTransport,
    mutatePreferences: async (run: (value: typeof DEFAULT_UI_PREFERENCES) => unknown) => run(DEFAULT_UI_PREFERENCES)
  } as unknown as LocalState);
  vi.mocked(probeOrchestratorOrigin).mockResolvedValue({ serverId: PROFILE.serverId, displayName: "Local", version: "1", apiVersion: "1", pairingEnabled: false });
  let project!: (sessions: readonly SessionView[]) => void;
  vi.mocked(createOrchestratorGateway).mockImplementation((_profile, _key, callbacks) => {
    const publish = (values: readonly SessionView[]) => callbacks.onSnapshot?.({ ...emptySnapshot(), revision: 1n, sessions: values });
    if (callbacks.onError !== undefined) project = publish;
    return {
    connect: async () => { callbacks.onState?.("connected"); publish(sessions); },
    disconnect: () => undefined, taskSharingApi: () => undefined,
    inputHandoffApi: () => undefined, providerSharingApi: () => undefined, partnerNetworkApi: () => undefined, partnerIdentityApi: () => undefined, providerGroupSettingsApi: () => undefined
  } as unknown as OrchestratorGateway; });
  let current!: AppController;
  function Probe() { current = useAppController(); return null; }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Probe />)); await act(async () => current.connect(PROFILE));
  const getOwner = vi.fn(async () => ({ profileId: PROFILE.id, sessionId: "session", draftSlot: 1 }));
  vi.stubGlobal("jokoDesktop", { sessionWindows: { getOwner }, window: { setZoomFactor: async () => undefined }, discovery: { scan: async () => [] }, capabilities: [] });
  return { current: () => current, getOwner, readDraft, saveDraft, readDraftSnapshot, saveDraftIfRevision, project };
}

it("uses a proven Side Chat child's own draft key with its boot source's stable native slot", async () => {
  const child: SessionView = { id: "child", backendId: "native", targetId: "target", name: "Side Chat", state: "idle", generation: 1n,
    pinned: false, archived: false, updatedAt: 1, permissionMode: "ask", fastMode: false, planMode: false,
    derivationOrigin: { kind: "fork", sideChat: true, sourceSessionId: "session", sourceSessionAvailable: true, sourceMessageAvailable: true } };
  const view = await mount([child]);
  await view.current().readDraft("child"); await view.current().saveDraft("child", DRAFT);
  await view.current().readDraftSnapshot("child"); await view.current().saveDraftIfRevision("child", DRAFT, 0);
  expect(view.readDraft).toHaveBeenCalledWith("server", "profile", "child", "task-window:1");
  expect(view.saveDraft).toHaveBeenCalledWith("server", "profile", "child", DRAFT, "task-window:1");
  expect(view.saveDraftIfRevision).toHaveBeenCalledWith("server", "profile", "child", DRAFT, 0, "task-window:1");
  await act(async () => view.project([{ ...child, derivationOrigin: { ...child.derivationOrigin!, sideChat: false } }]));
  expect(view.current().state.snapshot.sessions[0]?.derivationOrigin?.sideChat).toBe(false);
  await expect(view.current().saveDraft("child", DRAFT)).rejects.toThrow("owner is invalid");
  await expect(view.current().saveDraft("unknown-child", DRAFT)).rejects.toThrow("owner is invalid");
  expect(view.saveDraft).toHaveBeenCalledOnce();
});

it("rejects a child lineage change during native owner lookup before writing its draft", async () => {
  const child: SessionView = { id: "child", backendId: "native", targetId: "target", name: "Side Chat", state: "idle", generation: 1n,
    pinned: false, archived: false, updatedAt: 1, permissionMode: "ask", fastMode: false, planMode: false,
    derivationOrigin: { kind: "fork", sideChat: true, sourceSessionId: "session", sourceSessionAvailable: true, sourceMessageAvailable: true } };
  const view = await mount([child]); let finish!: (value: { profileId: string; sessionId: string; draftSlot: number }) => void;
  view.getOwner.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const saving = view.current().saveDraft("child", DRAFT), rejected = expect(saving).rejects.toThrow("no longer current");
  expect(view.getOwner).toHaveBeenCalledOnce();
  await act(async () => view.project([{ ...child, derivationOrigin: { ...child.derivationOrigin!, sourceSessionId: "foreign" } }]));
  expect(view.current().state.snapshot.sessions[0]?.derivationOrigin?.sourceSessionId).toBe("foreign");
  finish({ profileId: "profile", sessionId: "session", draftSlot: 1 }); await rejected;
  expect(view.saveDraft).not.toHaveBeenCalled();
});

it("routes every persisted draft and CAS operation through the exact native task slot", async () => {
  const view = await mount();
  await view.current().readDraft("session"); await view.current().saveDraft("session", DRAFT);
  await view.current().readDraftSnapshot("session"); await view.current().saveDraftIfRevision("session", DRAFT, 0);
  expect(view.getOwner).toHaveBeenCalledTimes(4);
  expect(view.readDraft).toHaveBeenCalledWith("server", "profile", "session", "task-window:1");
  expect(view.saveDraft).toHaveBeenCalledWith("server", "profile", "session", DRAFT, "task-window:1");
  expect(view.readDraftSnapshot).toHaveBeenCalledWith("server", "profile", "session", "task-window:1");
  expect(view.saveDraftIfRevision).toHaveBeenCalledWith("server", "profile", "session", DRAFT, 0, "task-window:1");
});

it.each(["connection", "pagehide"] as const)("rejects a late native context after %s retirement before touching IndexedDB", async retirement => {
  const view = await mount(); let finish!: (value: { profileId: string; sessionId: string; draftSlot: number }) => void;
  view.getOwner.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const saving = view.current().saveDraft("session", DRAFT), rejected = expect(saving).rejects.toThrow("no longer current");
  if (retirement === "connection") await act(async () => view.current().disconnect()); else window.dispatchEvent(new Event("pagehide"));
  finish({ profileId: PROFILE.id, sessionId: "session", draftSlot: 1 }); await rejected;
  expect(view.saveDraft).not.toHaveBeenCalled();
});

it.each(["read", "write"] as const)("rejects a late local %s result after its connection retires without changing the captured surface", async kind => {
  const view = await mount(); let finish!: () => void;
  if (kind === "read") view.readDraft.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(DRAFT); }));
  else view.saveDraft.mockImplementationOnce(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined); }));
  const operation = kind === "read" ? view.current().readDraft("session") : view.current().saveDraft("session", DRAFT);
  const rejected = expect(operation).rejects.toThrow("no longer current");
  await vi.waitFor(() => expect(kind === "read" ? view.readDraft : view.saveDraft).toHaveBeenCalledOnce());
  await act(async () => view.current().disconnect()); finish(); await rejected;
  expect((kind === "read" ? view.readDraft : view.saveDraft).mock.calls[0]?.at(-1)).toBe("task-window:1");
});

it("does not cache a rejected native lookup or use a mismatched context as an application draft", async () => {
  const view = await mount(); view.getOwner.mockRejectedValueOnce(new Error("Native lookup failed"));
  await expect(view.current().saveDraft("session", DRAFT)).rejects.toThrow("Native lookup failed");
  view.getOwner.mockResolvedValueOnce({ profileId: "different-profile", sessionId: "session", draftSlot: 0 });
  await expect(view.current().saveDraft("session", DRAFT)).rejects.toThrow("owner is invalid");
  await expect(view.current().saveDraft("session", DRAFT)).resolves.toBeUndefined();
  expect(view.saveDraft).toHaveBeenCalledExactlyOnceWith("server", "profile", "session", DRAFT, "task-window:1");
});
