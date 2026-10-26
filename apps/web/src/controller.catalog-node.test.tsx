// @vitest-environment jsdom
import { act, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppController, type AppController } from "./controller.js";
import { createOrchestratorGateway, probeOrchestratorOrigin, type OrchestratorGateway } from "./gateway.js";
import { DEFAULT_UI_PREFERENCES, LocalState } from "./local-state.js";
import { emptySnapshot, type AppSnapshot, type ConnectionProfile, type ModelPriceOverrideView, type ModelView } from "./model.js";
import { registerCatalogNavigationLeave } from "./catalog-navigation-leave.js";
import { ModelPriceOverrideDialog } from "./components/ModelPriceOverrideDialog.js";
import { translate } from "./i18n.js";
import { WorkspaceFileEditorPane, type WorkspaceFileEditorLabels } from "./components/WorkspaceFileEditorPane.js";
import { workspaceDocumentController, type WorkspaceLeaveChoice } from "./workspace-document-controller.js";
import { registerWorkspaceDocumentLeaveGate } from "./workspace-document-lifecycle.js";
import { registerPartnerNavigationLeave } from "./partner-navigation-leave.js";

vi.mock("./components/WorkspaceTextEditor.js", async () => {
  const { forwardRef } = await import("react");
  return { WorkspaceTextEditor: forwardRef(function Editor({ value, onChange }: { value: string; onChange: (value: string) => void }, ref) {
    return <textarea ref={ref as Ref<HTMLTextAreaElement>} value={value} onChange={event => onChange(event.target.value)} />;
  }) };
});

vi.mock("./gateway.js", async original => ({ ...await original<typeof import("./gateway.js")>(),
  createOrchestratorGateway: vi.fn(), probeOrchestratorOrigin: vi.fn() }));
let root: Root | undefined;
const a = profile("a"), b = profile("b"), c = profile("c");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  localStorage.clear(); window.history.replaceState(null, "", "#/tools?tab=extensions");
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined;
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(["connect", "disconnect", "forget", "save-failed"])("preserves the mounted file draft when %s cannot leave", async action => {
  const view = await mount(true, false, true), generation = view.app()!.state.connectionGeneration;
  await editDocument("Unsaved text");
  view.saveDocument.mockRejectedValueOnce(new Error("File changed"));
  const prompt = vi.fn(async (): Promise<WorkspaceLeaveChoice> => action === "save-failed" ? "save" : "cancel");
  const unregister = registerWorkspaceDocumentLeaveGate(request => workspaceDocumentController.requestLeave({ ...request, prompt }));
  try {
    await act(async () => {
      if (action === "disconnect") await view.app()!.disconnect();
      else if (action === "forget") await view.app()!.forgetProfile(a.id);
      else await view.app()!.connect(b);
    });
    expect(view.app()!.state.activeProfile?.id).toBe(a.id); expect(view.app()!.state.connectionGeneration).toBe(generation);
    expect(view.retiredProfiles).toEqual([]); expect(view.deleteProfile).not.toHaveBeenCalled();
    expect(document.querySelector("textarea")!.value).toBe("Unsaved text"); expect(workspaceDocumentController.shouldPreventUnload()).toBe(true);
    expect(prompt).toHaveBeenCalledOnce();
  } finally { unregister(); }
});
it.each(["save", "discard"] as const)("finishes %s before replacing the mounted editor's connection", async choice => {
  const view = await mount(true, false, true); await editDocument("Unsaved text");
  view.saveDocument.mockImplementationOnce(async () => {
    expect(view.app()!.state.activeProfile?.id).toBe(a.id); expect(view.retiredProfiles).toEqual([]); return { revision: "r2" };
  });
  const unregister = registerWorkspaceDocumentLeaveGate(request => workspaceDocumentController.requestLeave({ ...request, prompt: async () => choice }));
  try {
    await act(async () => view.app()!.connect(b));
    expect(view.app()!.state.activeProfile?.id).toBe(b.id); expect(view.retiredProfiles).toEqual([a.id]);
    expect(view.saveDocument).toHaveBeenCalledTimes(choice === "save" ? 1 : 0);
    expect(workspaceDocumentController.shouldPreventUnload()).toBe(false);
  } finally { unregister(); }
});
it("does not replace the current connection when the Partner editor declines leaving", async () => {
  const view = await mount(), unregister = registerPartnerNavigationLeave(async () => false);
  try { await act(async () => view.app()!.disconnect()); expect(view.app()!.state.activeProfile?.id).toBe(a.id); expect(view.retiredProfiles).toEqual([]); }
  finally { unregister(); }
});
it("adopts a verified catalog node and keeps identical plugin, resource and market IDs on that node", async () => {
  const view = await mount();
  const old = view.app()!;
  await act(async () => { expect(await old.openMachineCatalog(b.id, "skills")).toBe(true); });
  await vi.waitFor(() => expect(view.app()!.state.route).toEqual({ kind: "tools", tab: "skills", profileId: b.id }));
  expect(view.app()!.state.activeProfile?.serverId).toBe(b.serverId);
  await view.app()!.setResourceEnabled("same-resource", true);
  await view.app()!.setExtensionEnabled("same-extension", false, 1n);
  await view.app()!.listSkillMarketSources();
  expect(view.actions).toEqual(["node-b:resource:same-resource", "node-b:extension:same-extension", "node-b:market"]);
  for (const call of [() => old.setResourceEnabled("same-resource", true),
    () => old.setExtensionEnabled("same-extension", false, 1n),
    () => old.listExtensionProjects(), () => old.getExtensionProjectState("original-project"),
    () => old.resolveExtensionProject("/original/project"), () => old.listExtensionProjectDirectories("/original/project"),
    () => old.closeSkillMarketInstallPlan("original-plan"), () => old.closeExtensionMainView("original-view"),
    () => old.closeExtensionLibrary("original-library")]) {
    // Mounted views retire their original leases with .catch during unmount.
    // A stale public Promise operation must reject without a synchronous throw.
    await expect(call()).rejects.toThrow("catalog node connection is no longer current");
  }
  for (const call of [() => old.extensionTaskApi?.(), () => old.extensionOAuthApi()]) {
    expect(call).toThrow("catalog node connection is no longer current");
  }
  expect(view.actions).toHaveLength(3);
});

it("preserves the current catalog when the other node is offline and rejects an identity change before bearer access", async () => {
  const view = await mount();
  view.probe.mockImplementation(async origin => { if (origin === b.origin) throw new Error("offline"); return identity(a); });
  const before = view.auth.mock.calls.filter(([owner]) => owner.id === b.id).length;
  await act(async () => { await expect(view.app()!.openMachineCatalog(b.id, "extensions")).rejects.toThrow("offline"); });
  expect(view.app()!.state.activeProfile?.id).toBe(a.id);
  view.probe.mockImplementation(async origin => identity(origin === b.origin ? c : a));
  await act(async () => { await expect(view.app()!.openMachineCatalog(b.id, "extensions")).rejects.toThrow("different Joko node"); });
  expect(view.auth.mock.calls.filter(([owner]) => owner.id === b.id)).toHaveLength(before);
  expect(view.app()!.state.activeProfile?.id).toBe(a.id);
});

it("discards a late catalog probe after navigation and lets the latest explicit node selection win", async () => {
  const view = await mount();
  const release = deferred(); view.hold(b.id, release.promise);
  let opening!: Promise<boolean>;
  await act(async () => { opening = view.app()!.openMachineCatalog(b.id, "extensions"); await settle(); });
  await act(async () => { view.app()!.navigate({ kind: "settings" }, { replace: true }); release.resolve(); expect(await opening).toBe(false); });
  expect(view.app()!.state.activeProfile?.id).toBe(a.id);
  expect(view.activeConnections).not.toContain(b.id);
  const next = deferred(); view.hold(b.id, next.promise);
  await act(async () => { view.app()!.navigate({ kind: "tools", tab: "skills" }, { replace: true }); opening = view.app()!.openMachineCatalog(b.id, "skills"); await settle(); });
  await act(async () => { expect(await view.app()!.openMachineCatalog(c.id, "skills")).toBe(true); next.resolve(); expect(await opening).toBe(false); });
  expect(view.app()!.state.activeProfile?.id).toBe(c.id);
  expect(view.activeConnections).not.toContain(b.id);
});

it("does not probe or switch when the mounted skill editor declines discarding its draft", async () => {
  const view = await mount();
  const close = registerCatalogNavigationLeave(async () => false);
  const count = view.probe.mock.calls.length;
  try { await act(async () => { expect(await view.app()!.openMachineCatalog(b.id, "skills")).toBe(false); }); }
  finally { close(); }
  expect(view.probe.mock.calls).toHaveLength(count);
  expect(view.app()!.state.activeProfile?.id).toBe(a.id);
});

it("keeps a cold plugin deep link on its saved node and retires old catalog calls after reconnecting that same node", async () => {
  window.history.replaceState(null, "", `#/tools?extension=extension_${"a".repeat(32)}&profile=${b.id}`);
  const view = await mount(false);
  await vi.waitFor(() => expect(view.app()!.state.connectionState).toBe("connected"));
  expect(view.app()!.state.activeProfile?.id).toBe(b.id);
  expect(view.app()!.state.route).toMatchObject({ kind: "tools", profileId: b.id, extensionId: `extension_${"a".repeat(32)}` });
  const old = view.app()!;
  await act(async () => { await old.connect(b); });
  await expect(old.setExtensionEnabled("same-extension", true, 1n)).rejects.toThrow("no longer current");
  expect(view.actions).toEqual([]);
});

it("opens an independent plugin window on its explicit node and rejects a replaced node identity at cold start", async () => {
  const extensionId = `extension_${"a".repeat(32)}`;
  window.history.replaceState(null, "", `#/extensions/${extensionId}?profile=${b.id}&server=${b.serverId}`);
  const view = await mount(false);
  await vi.waitFor(() => expect(view.app()!.state.connectionState).toBe("connected"));
  expect(view.app()!.state.activeProfile?.id).toBe(b.id);
  expect(view.app()!.state.route).toEqual({ kind: "extensionMainView", extensionId, profileId: b.id, serverId: b.serverId });
  await act(async () => root!.unmount()); root = undefined;
  window.history.replaceState(null, "", `#/extensions/${extensionId}?profile=${b.id}&server=replaced-node`);
  const replaced = await mount(false);
  expect(replaced.app()!.state.activeProfile).toBeUndefined();
  expect(replaced.activeConnections).toEqual([]);
});

it("keeps a dirty price draft and settles its mutation across background snapshots on the same connection", async () => {
  const view = await mount(true, true), first = view.app()!;
  const input = document.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "17");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => view.emit());
  expect(view.app()).not.toBe(first);
  expect(view.app()!.getModelPriceOverride).toBe(first.getModelPriceOverride);
  expect(document.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe("17");
  let finish!: (value: ModelPriceOverrideView) => void;
  view.savePrice.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => document.querySelector<HTMLFormElement>(".model-price-dialog__form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(input.disabled).toBe(true);
  await act(async () => { view.emit(); finish(price()); });
  expect(view.closePrice).toHaveBeenCalledOnce();
  expect(document.querySelector<HTMLInputElement>('input[type="number"]')!.disabled).toBe(false);
  expect(view.getPrice).toHaveBeenCalledOnce();
  await act(async () => view.app()!.connect(a));
  await expect(first.getModelPriceOverride("backend", "provider", "model")).rejects.toThrow("no longer current");
  await expect(first.setModelPriceOverride("backend", "provider", "model", price().effective)).rejects.toThrow("no longer current");
  await expect(first.resetModelPriceOverride("backend", "provider", "model")).rejects.toThrow("no longer current");
  expect(view.savePrice).toHaveBeenCalledOnce();
});

async function mount(connectFirst = true, showPrice = false, showEditor = false) {
  const actions: string[] = [], activeConnections: string[] = [], retiredProfiles: string[] = [];
  const saveDocument = vi.fn(async () => ({ revision: "r2" })), deleteProfile = vi.fn(async () => undefined);
  const getPrice = vi.fn(async () => price()), savePrice = vi.fn(async () => price()), closePrice = vi.fn();
  let emit = () => {};
  const held = new Map<string, Promise<void>>();
  const probe = vi.mocked(probeOrchestratorOrigin).mockImplementation(async origin => identity([a, b, c].find(value => value.origin === origin)!));
  const auth = vi.fn(async (_owner: ConnectionProfile) => "private-test-bearer");
  vi.spyOn(LocalState, "open").mockResolvedValue({ listProfiles: async () => [a, b, c], listMachineCaches: async () => [],
    readPreferences: async () => DEFAULT_UI_PREFERENCES, readAuthKey: auth, saveProfile: async () => undefined, deleteProfile,
    loadEndpointTransport: LocalState.prototype.loadEndpointTransport,
    saveMachineCache: async () => undefined, deleteMachineCache: async () => undefined,
    mutatePreferences: async (update: (value: typeof DEFAULT_UI_PREFERENCES) => typeof DEFAULT_UI_PREFERENCES) => update(DEFAULT_UI_PREFERENCES)
  } as unknown as LocalState);
  vi.mocked(createOrchestratorGateway).mockImplementation((owner, _key, callbacks) => {
    const value = owner!, active = callbacks.onExtensionUiEffect !== undefined;
    if (active) emit = () => callbacks.onSnapshot?.({ ...snapshot(value), models: [{ ...priceModel }] });
    return { connect: async () => {
      if (!active && callbacks.onSnapshot) await held.get(value.id);
      if (active) activeConnections.push(value.id);
      callbacks.onSnapshot?.(snapshot(value)); callbacks.onState?.("connected");
    }, disconnect: () => { if (active) retiredProfiles.push(value.id); }, taskSharingApi: () => undefined,
    inputHandoffApi: () => undefined, providerSharingApi: () => undefined, partnerNetworkApi: () => undefined, partnerIdentityApi: () => undefined, providerGroupSettingsApi: () => undefined,
    refresh: async () => callbacks.onSnapshot?.(snapshot(value)),
    getModelPriceOverride: getPrice, setModelPriceOverride: savePrice, resetModelPriceOverride: getPrice,
    listPartners: async () => ({ partners: [], directory: { revision: 1n, templates: [], avatarPresets: [], activeCount: 0, archivedCount: 0, errorCount: 0, updatedAt: 1 } }),
    setResourceEnabled: async (id: string) => { actions.push(`${value.serverId}:resource:${id}`); },
    setExtensionEnabled: async (id: string) => { actions.push(`${value.serverId}:extension:${id}`); },
    listSkillMarketSources: async () => { actions.push(`${value.serverId}:market`); return { revision: 1n, sources: [] }; }
    } as unknown as OrchestratorGateway;
  });
  let app: AppController | undefined; function Probe() { app = useAppController();
    if (showEditor && app.state.activeProfile?.id === a.id) return <WorkspaceFileEditorPane file={{ path: "note.txt", text: "Disk", revision: "r1" }} labels={editorLabels}
      documentGuard={{ controller: workspaceDocumentController, sessionId: "session-a", workspaceId: "workspace-a" }} onSave={saveDocument} />;
    return showPrice && app.state.connectionState === "connected"
    ? <ModelPriceOverrideDialog controller={app} model={{ ...priceModel }} t={(key, values) => translate("en", key, values)} onClose={closePrice} /> : null; }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root!.render(<Probe />); await settle(); });
  await vi.waitFor(() => expect(app?.state.ready).toBe(true));
  if (connectFirst) await act(async () => { await app!.connect(a); await settle(); });
  return { app: () => app, actions, probe, auth, activeConnections, retiredProfiles, saveDocument, deleteProfile, hold: (id: string, promise: Promise<void>) => held.set(id, promise), emit: () => emit(), getPrice, savePrice, closePrice };
}
const priceModel: ModelView = { backendId: "backend", providerId: "provider", providerName: "Provider", modelId: "model", name: "Model", available: true,
  supportsImages: false, inputModalities: ["text"], outputModalities: ["text"], supportsFast: false, efforts: [], currencyCode: "USD",
  contextWindow: 64_000, maximumOutputTokens: 8_192, inputCostMicrosPerMillion: 1_000_000, outputCostMicrosPerMillion: 2_000_000 };
function price(): ModelPriceOverrideView { return { backendId: priceModel.backendId, providerId: priceModel.providerId, modelId: priceModel.modelId,
  allowedCurrencies: ["USD"], referenceAvailable: true, reference: { currency: "USD", inputPerMillion: 1, outputPerMillion: 2 }, effective: { currency: "USD", inputPerMillion: 1, outputPerMillion: 2 } }; }
function profile(id: string): ConnectionProfile { return { id: `connection-${id}`, serverId: `node-${id}`, deviceId: `device-${id}`, origin: `https://${id}.example`, name: id.toUpperCase() }; }
function identity(owner: ConnectionProfile) { return { serverId: owner.serverId, displayName: owner.name, version: "1", apiVersion: "1", pairingEnabled: true }; }
function snapshot(owner: ConnectionProfile): AppSnapshot { return { ...emptySnapshot(), generation: 1n,
  remoteConnections: [{ id: owner.id, deviceId: owner.deviceId, name: owner.name, state: "connected" }],
  devices: [{ id: owner.deviceId, name: owner.name, defaultDisplayName: owner.name, revision: 1n, kind: "web", platform: "web", appVersion: "1", revoked: false, remoteControlEnabled: false, presence: "online" }] }; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
async function editDocument(text: string) {
  const editor = document.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, text);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const editorLabels: WorkspaceFileEditorLabels = { editor: "Editor", unsaved: "Unsaved", saving: "Saving", save: "Save", saveFailed: "Save failed", externalChange: "External change",
  reloadDisk: "Reload", keepEditing: "Keep editing", overwriteDisk: "Overwrite", insertTable: "Insert table", addRowAbove: "Add row above", addRowBelow: "Add row below", deleteRow: "Delete row",
  addColumnLeft: "Add column left", addColumnRight: "Add column right", deleteColumn: "Delete column", deleteTable: "Delete table", mermaidZoom: "Zoom", mermaidCopy: "Copy",
  mermaidCopied: "Copied", mermaidCopyFailed: "Copy failed", mermaidEditSource: "Edit source", mermaidRenderFailed: "Render failed" };
