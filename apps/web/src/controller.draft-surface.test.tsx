// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useAppController, type AppController } from "./controller.js";
import { createOrchestratorGateway, probeOrchestratorOrigin, type OrchestratorGateway } from "./gateway.js";
import { DEFAULT_UI_PREFERENCES, LocalState } from "./local-state.js";
import { emptySnapshot, type ComposerDraft, type ConnectionProfile } from "./model.js";

vi.mock("./gateway.js", async original => ({ ...await original<typeof import("./gateway.js")>(),
  createOrchestratorGateway: vi.fn(), probeOrchestratorOrigin: vi.fn(), discoverOrchestratorNodesAt: vi.fn(async () => []) }));
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined;
  document.body.replaceChildren(); window.history.replaceState(null, "", "/"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const PROFILE: ConnectionProfile = { id: "profile", serverId: "server", deviceId: "device", name: "Local", origin: "http://127.0.0.1:4318" };
const DRAFT: ComposerDraft = { text: "Own draft", attachments: [], mentions: [], deliveryMode: "prompt" };

async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  window.history.replaceState(null, "", "/?sessionWindow=1&bootSession=session#/tasks/session");
  const readDraft = vi.fn(async (): Promise<ComposerDraft | undefined> => undefined), saveDraft = vi.fn(async () => undefined);
  const readDraftSnapshot = vi.fn(async () => ({ revision: 0 })), saveDraftIfRevision = vi.fn(async () => 1);
  vi.spyOn(LocalState, "open").mockResolvedValue({ readDraft, saveDraft, readDraftSnapshot, saveDraftIfRevision,
    listProfiles: async () => [], listMachineCaches: async () => [], readPreferences: async () => DEFAULT_UI_PREFERENCES,
    readAuthKey: async () => "credential", saveProfile: async () => undefined, saveMachineCache: async () => undefined,
    mutatePreferences: async (run: (value: typeof DEFAULT_UI_PREFERENCES) => unknown) => run(DEFAULT_UI_PREFERENCES)
  } as unknown as LocalState);
  vi.mocked(probeOrchestratorOrigin).mockResolvedValue({ serverId: PROFILE.serverId, displayName: "Local", version: "1", apiVersion: "1", pairingEnabled: false });
  vi.mocked(createOrchestratorGateway).mockImplementation((_profile, _key, callbacks) => ({
    connect: async () => { callbacks.onState?.("connected"); callbacks.onSnapshot?.({ ...emptySnapshot(), revision: 1n }); },
    disconnect: () => undefined
  }) as OrchestratorGateway);
  let current!: AppController;
  function Probe() { current = useAppController(); return null; }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Probe />)); await act(async () => current.connect(PROFILE));
  const getOwner = vi.fn(async () => ({ profileId: PROFILE.id, sessionId: "session", draftSlot: 1 }));
  vi.stubGlobal("jokoDesktop", { sessionWindows: { getOwner }, window: { setZoomFactor: async () => undefined }, discovery: { scan: async () => [] }, capabilities: [] });
  return { current: () => current, getOwner, readDraft, saveDraft, readDraftSnapshot, saveDraftIfRevision };
}

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
