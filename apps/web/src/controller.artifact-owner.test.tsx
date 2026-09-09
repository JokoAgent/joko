// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

import { useAppController, type AppController } from "./controller.js";
import { createOrchestratorGateway, probeOrchestratorOrigin, type OrchestratorGateway } from "./gateway.js";
import { DEFAULT_UI_PREFERENCES, LocalState } from "./local-state.js";
import { emptySnapshot, type AppSnapshot, type SessionView, type TimelineItemView, type ConnectionProfile } from "./model.js";
import { registerWorkspaceHtmlPreviewSurface } from "./workspace-html-auto-reload.js";
import { persistentWebSecretEncryptionAvailable } from "./web-crypto.js";

vi.mock("./gateway.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./gateway.js")>(),
  createOrchestratorGateway: vi.fn(),
  probeOrchestratorOrigin: vi.fn(),
  discoverOrchestratorNodesAt: vi.fn(async () => [])
}));
vi.mock("./web-crypto.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./web-crypto.js")>(),
  persistentWebSecretEncryptionAvailable: vi.fn(async () => false)
}));

let root: Root | undefined;
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps resource and auxiliary operations bound to the controller snapshot's gateway", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const fetch = vi.fn(async () => { throw new Error("Unexpected network request"); });
  vi.stubGlobal("fetch", fetch);
  vi.mocked(persistentWebSecretEncryptionAvailable).mockResolvedValue(false);
  const readDraft = vi.fn(async () => undefined);
  const saveDraft = vi.fn(async () => undefined);
  const readDraftSnapshot = vi.fn(async () => ({ revision: 0 }));
  const saveDraftIfRevision = vi.fn(async () => 1);
  const newDraftMethods = ["readNewSessionDraft", "saveNewSessionDraft", "clearNewSessionDraft"] as const;
  const newDraftCalls = Object.fromEntries(newDraftMethods.map((method) => [method, vi.fn(async () => undefined)])) as Record<typeof newDraftMethods[number], ReturnType<typeof vi.fn>>;
  const workspaceMethods = ["listWorkspaceChangeSets", "previewWorkspaceRewind", "executeWorkspaceRewind"] as const;
  const workspaceCalls = new Map<string, Record<typeof workspaceMethods[number], ReturnType<typeof vi.fn>>>();
  vi.spyOn(LocalState, "open").mockResolvedValue({
    readDraft, saveDraft, readDraftSnapshot, saveDraftIfRevision, ...newDraftCalls,
    listProfiles: async () => [], listMachineCaches: async () => [],
    readPreferences: async () => ({ ...DEFAULT_UI_PREFERENCES, machineSelection: ["unselected-profile"] }),
    readAuthKey: async () => "test-key", saveProfile: async () => undefined,
    saveMachineCache: async () => undefined,
    savePreferences: async () => undefined
  } as unknown as LocalState);
  const first = profile("first");
  const second = profile("second");
  vi.mocked(probeOrchestratorOrigin).mockImplementation(async (origin) => ({ serverId: origin === first.origin ? first.serverId : second.serverId, displayName: "Test", version: "1", apiVersion: "1", pairingEnabled: false }));
  let finishFirst!: () => void;
  const pendingFirst = new Promise<void>((resolve) => { finishFirst = resolve; });
  const inputCalls = new Map<string, Record<"send" | "createSession" | "createTarget" | "refresh", ReturnType<typeof vi.fn>>>();
  const browserCalls = new Map<string, ReturnType<typeof vi.fn>>();
  const htmlCalls = new Map<string, ReturnType<typeof vi.fn>>();
  const reloadCalls = new Map<string, ReturnType<typeof vi.fn>>();
  const gateways = new Map<string, { readonly read: ReturnType<typeof vi.fn>; readonly get: ReturnType<typeof vi.fn>; readonly release: ReturnType<typeof vi.fn>; readonly save: ReturnType<typeof vi.fn>; readonly predict: ReturnType<typeof vi.fn>; readonly download: ReturnType<typeof vi.fn>; readonly navigate: ReturnType<typeof vi.fn>; readonly live: Set<string> }>();
  const voiceCalls = new Map<string, Record<string, ReturnType<typeof vi.fn>>>();
  const loginMethods = ["beginProviderLogin", "getProviderLoginFlow", "submitProviderLoginInput", "cancelProviderLogin"] as const;
  const loginCalls = new Map<string, Record<typeof loginMethods[number], ReturnType<typeof vi.fn>>>();
  const sshMethods = ["listSshKeys", "generateSshKey", "addSshKeyToAgent", "readSshPublicKey", "getSshKeyInstallCommand"] as const;
  const sshCalls = new Map<string, Record<typeof sshMethods[number], ReturnType<typeof vi.fn>>>();
  const remoteMethods = ["getRemoteHostCapabilities", "listRemoteHosts", "refreshRemoteHostCatalog", "createRemoteHost", "updateRemoteHost", "deleteRemoteHost", "connectRemoteHost", "disconnectRemoteHost", "testRemoteHostConnection", "clearRemoteHostTrust", "saveCredential", "saveProvider", "updateTarget"] as const;
  const remoteCalls = new Map<string, Record<typeof remoteMethods[number], ReturnType<typeof vi.fn>>>();
  const voiceMethods = ["getVoiceInputCapabilities", "startVoiceInput", "appendVoiceAudio", "stopVoiceInput", "cancelVoiceInput", "getVoiceInputSession"] as const;
  const publishSnapshot = new Map<string, (snapshot?: AppSnapshot) => void>();
  vi.mocked(createOrchestratorGateway).mockImplementation((owner, _key, callbacks) => {
    let disposed = false;
    const live = new Set<string>();
    const read = vi.fn(async (_workspaceId: string, path: string) => {
      if (disposed) throw new Error("Workspace owner disconnected");
      return { path, blobId: `${owner!.id}/shared` };
    });
    const get = vi.fn(async (blobId: string) => {
      if (disposed) throw new Error("Artifact owner disconnected");
      if (owner!.id === first.id) await pendingFirst;
      if (!disposed) live.add(blobId);
      return `blob:${owner!.id}/${blobId}`;
    });
    const release = vi.fn((blobId: string) => { live.delete(blobId); });
    const download = vi.fn(async () => {
      if (disposed) throw new Error("Download owner disconnected");
      if (owner!.id === first.id) await pendingFirst;
      if (disposed) throw new Error("Download owner disconnected");
      return "saved" as const;
    });
    const save = vi.fn(async () => {
      if (disposed) throw new Error("Auxiliary owner disconnected");
    });
    const predict = vi.fn(async () => {
      if (disposed) throw new Error("Prediction owner disconnected");
      return `Prediction from ${owner!.id}`;
    });
    const navigate = vi.fn(async () => { if (disposed) throw new Error("Navigation owner disconnected"); });
    const workspaceOperations = Object.fromEntries(workspaceMethods.map((method) => [method, vi.fn(async () => { if (disposed) throw new Error("Workspace owner disconnected"); })])) as Record<typeof workspaceMethods[number], ReturnType<typeof vi.fn>>;
    workspaceCalls.set(owner!.id, workspaceOperations);
    const inputOperations = {
      send: vi.fn(async () => { if (disposed) throw new Error("Input owner disconnected"); }),
      createSession: vi.fn(async () => { if (disposed) throw new Error("Input owner disconnected"); return { sessionId: "created", generation: 1n }; }),
      createTarget: vi.fn(async () => { if (disposed) throw new Error("Input owner disconnected"); return "target"; }),
      refresh: vi.fn(async () => { if (disposed) throw new Error("Input owner disconnected"); })
    };
    inputCalls.set(owner!.id, inputOperations);
    const voiceOperations = Object.fromEntries(voiceMethods.map(method => [method, vi.fn(async () => { if (disposed) throw new Error("Voice owner disconnected"); })]));
    voiceCalls.set(owner!.id, voiceOperations);
    const loginOperations = Object.fromEntries(loginMethods.map((method) => [method, vi.fn(async () => ({
      id: "shared-flow", providerId: "provider", method: "deviceCode", state: "pending", updatedAt: 1
    }))])) as Record<typeof loginMethods[number], ReturnType<typeof vi.fn>>;
    loginCalls.set(owner!.id, loginOperations);
    const sshOperations = Object.fromEntries(sshMethods.map((method) => [method, vi.fn(async () => undefined)])) as Record<typeof sshMethods[number], ReturnType<typeof vi.fn>>;
    sshCalls.set(owner!.id, sshOperations);
    const remoteOperations = Object.fromEntries(remoteMethods.map(method => [method, vi.fn(async () => { if (disposed) throw new Error("Remote workspace owner disconnected"); })])) as Record<typeof remoteMethods[number], ReturnType<typeof vi.fn>>;
    remoteCalls.set(owner!.id, remoteOperations);
    let browserSnapshot: AppSnapshot = { ...emptySnapshot(), revision: 1n, browsers: [{ id: "browser", name: "Browser", state: "ready" as const, generation: 1n, pages: [] }] };
    const openBrowserPage = vi.fn(async () => { if (disposed) throw new Error("Browser owner disconnected"); await pendingFirst; return "opened-page"; });
    browserCalls.set(owner!.id, openBrowserPage);
    const readWorkspaceHtmlSnapshot = vi.fn(async () => {
      if (owner!.id === first.id) await pendingFirst;
      return { file: { workspaceId: "workspace", relativePath: "index.html", expectedRevision: "html-revision" }, html: "<p>Private preview</p>" };
    });
    htmlCalls.set(owner!.id, readWorkspaceHtmlSnapshot);
    const performBrowserTakeoverAction = vi.fn(async () => "capture");
    reloadCalls.set(owner!.id, performBrowserTakeoverAction);
    publishSnapshot.set(owner!.id, (snapshot) => { browserSnapshot = snapshot ?? browserSnapshot; callbacks.onSnapshot?.(browserSnapshot); });
    gateways.set(owner!.id, { read, get, release, save, predict, download, navigate, live });
    return {
      connect: async () => { callbacks.onState?.("connected"); callbacks.onSnapshot?.(browserSnapshot); },
      disconnect: () => { disposed = true; live.clear(); },
      ...inputOperations, ...workspaceOperations, ...voiceOperations, ...remoteOperations, ...loginOperations, ...sshOperations,
      watchRemoteHosts: async function* () { if (disposed) throw new Error("Remote workspace owner disconnected"); yield []; },
      readWorkspaceFile: read, readWorkspaceHtmlSnapshot, performBrowserTakeoverAction, getArtifactUrl: get, releaseArtifactUrl: release,
      navigateSessionBranch: navigate, copyArtifactFile: download, downloadArtifact: download, exportSession: download, exportPortableSession: download,
      updateAuxiliaryTextSettings: save, predictNextPrompt: predict, openBrowserPage
    } as unknown as OrchestratorGateway;
  });
  let current!: AppController;
  function Probe() { current = useAppController(); return null; }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Probe />));
  expect(current.state.ready).toBe(true);
  await act(async () => current.connect(first));
  const firstController = current;
  await act(async () => publishSnapshot.get(first.id)!());
  expect(current).not.toBe(firstController);
  expect(current.readWorkspaceFile).toBe(firstController.readWorkspaceFile);
  expect(current.getArtifactUrl).toBe(firstController.getArtifactUrl);
  expect(current.releaseArtifactUrl).toBe(firstController.releaseArtifactUrl);
  expect(current.updateAuxiliaryTextSettings).toBe(firstController.updateAuxiliaryTextSettings);
  expect(current.predictNextPrompt).toBe(firstController.predictNextPrompt);
  expect(current.downloadArtifact).toBe(firstController.downloadArtifact);
  expect(current.exportSession).toBe(firstController.exportSession);
  expect(current.exportPortableSession).toBe(firstController.exportPortableSession);
  expect(current.copyArtifactFile).toBe(firstController.copyArtifactFile);
  expect(current.openHttpLink).toBe(firstController.openHttpLink);
  expect(current.navigateSessionBranch).toBe(firstController.navigateSessionBranch);
  expect(current.readDraft).toBe(firstController.readDraft);
  expect(current.saveDraft).toBe(firstController.saveDraft);
  for (const method of ["readDraftSnapshot", "saveDraftIfRevision", ...newDraftMethods, ...workspaceMethods] as const) expect(current[method]).toBe(firstController[method]);
  for (const method of ["send", "createSession", "createTarget", "refresh"] as const) {
    expect(current[method]).toBe(firstController[method]);
  }
  for (const method of voiceMethods) expect(current[method]).toBe(firstController[method]);
  for (const method of loginMethods) expect(current[method]).toBe(firstController[method]);
  for (const method of sshMethods) expect(current[method]).toBe(firstController[method]);
  for (const method of [...remoteMethods, "watchRemoteHosts"] as const) expect(current[method]).toBe(firstController[method]);
  const downloadContext = { ownerDocument: document, signal: new AbortController().signal };
  const frame = document.body.appendChild(document.createElement("iframe"));
  const sourceOpen = vi.spyOn(frame.contentWindow!, "open").mockReturnValue(null);
  const otherOpen = vi.spyOn(window, "open").mockReturnValue(null);
  await firstController.openHttpLink("https://example.test/owned", { forceExternal: true, action: { ownerDocument: frame.contentDocument!, signal: new AbortController().signal } });
  expect(sourceOpen).toHaveBeenCalledExactlyOnceWith("https://example.test/owned", "_blank", "noopener,noreferrer");
  expect(otherOpen).not.toHaveBeenCalled();
  const oldBrowser = expect(firstController.openHttpLink("https://example.test/page", { forceSidebar: true, sessionId: "shared-session", action: downloadContext })).rejects.toThrow("source is no longer current");
  const oldHtml = expect(firstController.openWorkspaceHtml("shared-session", "workspace", "index.html", { action: downloadContext })).rejects.toThrow("source is no longer current");
  const oldDownload = expect(firstController.downloadArtifact("shared", "same.txt", downloadContext)).rejects.toThrow("Download owner disconnected");
  const oldAcquisition = firstController.getArtifactUrl("shared").then((url) => { firstController.releaseArtifactUrl("shared"); return url; });
  await act(async () => current.connect(second));
  const secondController = current;
  const sshSignal = new AbortController().signal;
  await expect(firstController.listSshKeys(sshSignal)).rejects.toThrow("connection is no longer current");
  await expect(firstController.generateSshKey({ name: "", comment: "", passphrase: "fixture-only-secret" }, sshSignal)).rejects.toThrow("connection is no longer current");
  await expect(firstController.addSshKeyToAgent("key", "SHA256:observed", "fixture-only-secret", sshSignal)).rejects.toThrow("connection is no longer current");
  await expect(firstController.readSshPublicKey("key", "SHA256:observed", sshSignal)).rejects.toThrow("connection is no longer current");
  await expect(firstController.getSshKeyInstallCommand({ keyId: "key", expectedFingerprint: "SHA256:observed", destination: { kind: "savedHost", targetId: "project", hostId: "host", expectedRevision: 1n }, shell: "posix" }, sshSignal)).rejects.toThrow("connection is no longer current");
  for (const method of sshMethods) {
    expect(secondController[method]).not.toBe(firstController[method]);
    expect(sshCalls.get(first.id)![method]).not.toHaveBeenCalled();
    expect(sshCalls.get(second.id)![method]).not.toHaveBeenCalled();
  }
  await secondController.listSshKeys(sshSignal);
  expect(sshCalls.get(second.id)!.listSshKeys).toHaveBeenCalledExactlyOnceWith(sshSignal);
  const loginFlow = { id: "shared-flow", providerId: "provider", method: "deviceCode" as const, state: "pending" as const, updatedAt: 1 };
  await expect(firstController.beginProviderLogin("backend", "provider", "deviceCode")).rejects.toThrow("authorization source is no longer current");
  await expect(firstController.getProviderLoginFlow(loginFlow.id)).rejects.toThrow("authorization source is no longer current");
  await expect(firstController.submitProviderLoginInput(loginFlow, "test verification input")).rejects.toThrow("authorization source is no longer current");
  await expect(firstController.cancelProviderLogin(loginFlow.id)).rejects.toThrow("authorization source is no longer current");
  for (const method of loginMethods) {
    expect(secondController[method]).not.toBe(firstController[method]);
    expect(loginCalls.get(first.id)![method]).not.toHaveBeenCalled();
    expect(loginCalls.get(second.id)![method]).not.toHaveBeenCalled();
  }
  await secondController.beginProviderLogin("backend", "provider", "deviceCode");
  await secondController.getProviderLoginFlow(loginFlow.id);
  await secondController.submitProviderLoginInput(loginFlow, "test verification input");
  await secondController.cancelProviderLogin(loginFlow.id);
  expect(loginCalls.get(second.id)!.beginProviderLogin).toHaveBeenCalledExactlyOnceWith("backend", "provider", "deviceCode");
  expect(loginCalls.get(second.id)!.getProviderLoginFlow).toHaveBeenCalledExactlyOnceWith(loginFlow.id);
  expect(loginCalls.get(second.id)!.submitProviderLoginInput).toHaveBeenCalledExactlyOnceWith(loginFlow, "test verification input");
  expect(loginCalls.get(second.id)!.cancelProviderLogin).toHaveBeenCalledExactlyOnceWith(loginFlow.id);
  await expect(firstController.openHttpLink("https://example.test/stale", { forceExternal: true })).rejects.toThrow("source is no longer current");
  expect(otherOpen).not.toHaveBeenCalled();
  expect(browserCalls.get(first.id)).toHaveBeenCalledExactlyOnceWith("browser", "shared-session", "https://example.test/page");
  expect(browserCalls.get(second.id)).not.toHaveBeenCalled();
  const credential = { id: "ssh-key", name: "Key", kind: "sshPrivateKey" as const, providerId: "", secret: "fixture-secret" };
  await expect(firstController.saveProvider({} as Parameters<AppController["saveProvider"]>[0])).rejects.toThrow("Provider configuration connection is no longer current");
  expect(remoteCalls.get(first.id)!.saveProvider).not.toHaveBeenCalled();
  expect(remoteCalls.get(second.id)!.saveProvider).not.toHaveBeenCalled();
  await expect(firstController.saveCredential(credential, new AbortController().signal)).rejects.toThrow("Remote workspace owner disconnected");
  await expect(firstController.updateTarget("same-target", { workspaceLocation: { kind: "serviceNode" } }, 7n)).rejects.toThrow("Remote workspace owner disconnected");
  const oldCatalog = firstController.watchRemoteHosts("same-target")[Symbol.asyncIterator]();
  await expect(oldCatalog.next()).rejects.toThrow("Remote workspace owner disconnected");
  expect(remoteCalls.get(second.id)!.saveCredential).not.toHaveBeenCalled();
  expect(remoteCalls.get(second.id)!.updateTarget).not.toHaveBeenCalled();
  expect(current.navigateSessionBranch).not.toBe(firstController.navigateSessionBranch);
  expect(current.readDraft).not.toBe(firstController.readDraft);
  expect(current.saveDraft).not.toBe(firstController.saveDraft);
  await expect(firstController.navigateSessionBranch("shared-session", { kind: "session_start" }, { expectedGeneration: 1n })).rejects.toThrow("Navigation owner disconnected");
  expect(gateways.get(second.id)!.navigate).not.toHaveBeenCalled();
  await expect(firstController.copyArtifactFile("shared", "same.txt", 1, downloadContext)).rejects.toThrow("Download owner disconnected");
  const capturedDraft = { text: "Captured", attachments: [], mentions: [], deliveryMode: "prompt" as const };
  await firstController.readDraft("shared-session");
  await firstController.saveDraft("shared-session", capturedDraft);
  expect(readDraft).toHaveBeenLastCalledWith(first.serverId, "shared-session");
  expect(saveDraft).toHaveBeenLastCalledWith(first.serverId, "shared-session", capturedDraft);
  await secondController.saveDraft("shared-session", capturedDraft);
  expect(saveDraft).toHaveBeenLastCalledWith(second.serverId, "shared-session", capturedDraft);
  await firstController.readDraftSnapshot("shared-session");
  await firstController.saveDraftIfRevision("shared-session", capturedDraft, 0);
  expect(readDraftSnapshot).toHaveBeenLastCalledWith(first.serverId, "shared-session");
  expect(saveDraftIfRevision).toHaveBeenLastCalledWith(first.serverId, "shared-session", capturedDraft, 0);
  await firstController.readNewSessionDraft();
  const newTaskDraft = { selection: { kind: "dialogue" as const, backendId: "backend" }, nativeStart: { kind: "fresh" as const }, providerId: "provider", modelId: "model", fastMode: false, permissionMode: "ask" as const, planMode: false, text: "New task", editorDocument: { type: "doc", content: [] }, mentions: [], attachments: [] };
  await firstController.saveNewSessionDraft(newTaskDraft);
  await firstController.clearNewSessionDraft();
  expect(newDraftCalls.readNewSessionDraft).toHaveBeenLastCalledWith(`${first.serverId}\u0000${first.id}`);
  expect(newDraftCalls.clearNewSessionDraft).toHaveBeenLastCalledWith(`${first.serverId}\u0000${first.id}`);
  expect(newDraftCalls.saveNewSessionDraft).toHaveBeenLastCalledWith(`${first.serverId}\u0000${first.id}`, newTaskDraft);
  for (const method of workspaceMethods) {
    const call = firstController[method] as (...args: any[]) => Promise<unknown>;
    await expect(call("workspace", "preview", "change", false)).rejects.toThrow("Workspace owner disconnected");
    expect(workspaceCalls.get(second.id)![method]).not.toHaveBeenCalled();
  }
  for (const method of ["send", "createSession", "createTarget", "refresh"] as const) {
    expect(secondController[method]).not.toBe(firstController[method]);
  }
  for (const method of voiceMethods) expect(secondController[method]).not.toBe(firstController[method]);
  await expect(firstController.getVoiceInputCapabilities()).rejects.toThrow("Voice owner disconnected");
  await expect(firstController.startVoiceInput("request", "audio/webm", undefined, { dictionaryTerms: [] })).rejects.toThrow("Voice owner disconnected");
  await expect(firstController.appendVoiceAudio("shared", 1n, new Uint8Array([1]), 10, false)).rejects.toThrow("Voice owner disconnected");
  await expect(firstController.stopVoiceInput("shared", 1n)).rejects.toThrow("Voice owner disconnected");
  await expect(firstController.cancelVoiceInput("shared")).rejects.toThrow("Voice owner disconnected");
  await expect(firstController.getVoiceInputSession("shared")).rejects.toThrow("Voice owner disconnected");
  for (const call of Object.values(voiceCalls.get(second.id)!)) expect(call).not.toHaveBeenCalled();
  const inputDraft = { text: "Task input", attachments: [], mentions: [], deliveryMode: "prompt" as const };
  const taskDraft = { targetId: "target", name: "Task", nativeStart: { kind: "fresh" as const }, providerId: "", modelId: "", fastMode: false, permissionMode: "ask" as const, planMode: false };
  const targetDraft = { backendId: "backend", name: "Project", workspaceKind: "userProject" as const, serverPath: "project", createIfMissing: false };
  await expect(firstController.send("shared-session", inputDraft, { expectedGeneration: 1n })).rejects.toThrow("Input owner disconnected");
  await expect(firstController.createSession(taskDraft)).rejects.toThrow("Input owner disconnected");
  await expect(firstController.createTarget(targetDraft)).rejects.toThrow("Input owner disconnected");
  await expect(firstController.refresh()).rejects.toThrow("Input owner disconnected");
  for (const call of Object.values(inputCalls.get(second.id)!)) expect(call).not.toHaveBeenCalled();
  await secondController.send("shared-session", inputDraft, { expectedGeneration: 1n });
  expect(inputCalls.get(second.id)!.send).toHaveBeenCalledExactlyOnceWith("shared-session", inputDraft, { expectedGeneration: 1n });
  expect(secondController.readWorkspaceFile).not.toBe(firstController.readWorkspaceFile);
  expect(secondController.getArtifactUrl).not.toBe(firstController.getArtifactUrl);
  expect(secondController.releaseArtifactUrl).not.toBe(firstController.releaseArtifactUrl);
  expect(secondController.updateAuxiliaryTextSettings).not.toBe(firstController.updateAuxiliaryTextSettings);
  expect(secondController.predictNextPrompt).not.toBe(firstController.predictNextPrompt);
  expect(secondController.downloadArtifact).not.toBe(firstController.downloadArtifact);
  expect(secondController.exportSession).not.toBe(firstController.exportSession);
  expect(secondController.exportPortableSession).not.toBe(firstController.exportPortableSession);
  await expect(secondController.downloadArtifact("shared", "same.txt", downloadContext)).resolves.toBe("saved");
  await expect(firstController.downloadArtifact("shared", "late.txt", downloadContext)).rejects.toThrow("Download owner disconnected");
  await expect(firstController.exportSession("shared-session", downloadContext)).rejects.toThrow("Download owner disconnected");
  await expect(firstController.exportPortableSession("shared-session", { excludeMedia: false }, downloadContext)).rejects.toThrow("Download owner disconnected");
  expect(gateways.get(second.id)!.download).toHaveBeenCalledExactlyOnceWith("shared", "same.txt", downloadContext);
  await secondController.updateAuxiliaryTextSettings([], 2n);
  const predictionSignal = new AbortController().signal;
  await expect(secondController.predictNextPrompt("shared-session", 100, 2n, predictionSignal))
    .resolves.toBe("Prediction from second");
  await expect(firstController.updateAuxiliaryTextSettings([], 1n)).rejects.toThrow("Auxiliary owner disconnected");
  await expect(firstController.predictNextPrompt("shared-session", 100, 1n, predictionSignal))
    .rejects.toThrow("Prediction owner disconnected");
  expect(gateways.get(second.id)!.save).toHaveBeenCalledExactlyOnceWith([], 2n);
  expect(gateways.get(second.id)!.predict).toHaveBeenCalledExactlyOnceWith("shared-session", 100, 2n, predictionSignal);
  const cancelledCaller = new AbortController();
  cancelledCaller.abort();
  await expect(secondController.predictNextPrompt("shared-session", 100, 2n, cancelledCaller.signal))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(gateways.get(second.id)!.predict).toHaveBeenCalledTimes(1);
  await expect(secondController.readWorkspaceFile("workspace", "shared.png")).resolves.toMatchObject({ blobId: "second/shared" });
  await expect(firstController.readWorkspaceFile("workspace", "late.png")).rejects.toThrow("Workspace owner disconnected");
  expect(gateways.get(second.id)!.read).toHaveBeenCalledTimes(1);
  await expect(secondController.getArtifactUrl("shared")).resolves.toBe("blob:second/shared");
  expect(gateways.get(second.id)!.live.has("shared")).toBe(true);
  await expect(firstController.getArtifactUrl("late")).rejects.toThrow("Artifact owner disconnected");
  expect(gateways.get(second.id)!.get).toHaveBeenCalledTimes(1);
  await act(async () => finishFirst());
  await oldBrowser;
  await oldHtml;
  expect(htmlCalls.get(first.id)).toHaveBeenCalledOnce();
  expect(htmlCalls.get(second.id)).not.toHaveBeenCalled();
  expect(current.state.browserInspectorFocusRequest).toBeUndefined();
  await oldDownload;
  expect(gateways.get(second.id)!.download).toHaveBeenCalledTimes(1);
  await expect(oldAcquisition).resolves.toBe("blob:first/shared");
  expect(gateways.get(first.id)!.release).toHaveBeenCalledWith("shared");
  expect(gateways.get(second.id)!.release).not.toHaveBeenCalled();
  expect(gateways.get(second.id)!.live.has("shared")).toBe(true);
  secondController.releaseArtifactUrl("shared");
  expect(gateways.get(second.id)!.live.size).toBe(0);
  const retiredLoginCalls = loginCalls.get(second.id)!;
  await act(async () => current.setLinkOpenPreference("local", "external"));
  await expect(current.openWorkspaceHtml("shared-session", "workspace", "index.html")).rejects.toThrow("isolated sidebar Browser");
  expect(htmlCalls.get(second.id)).not.toHaveBeenCalled();
  const htmlSession = { id: "shared-session", targetId: "target", generation: 1n, state: "idle", archived: false } as SessionView;
  let htmlState: AppSnapshot = { ...current.state.snapshot, sessions: [htmlSession], browsers: [{ id: "browser", name: "Browser", state: "ready", generation: 1n,
    takeover: { id: "takeover", pageId: "opened-page", connectionId: "connection", state: "active", generation: 1n },
    pages: [{ id: "opened-page", sessionId: "shared-session", title: "HTML", url: "https://preview.preview.joko.invalid/index.html", state: "ready", canGoBack: false, canGoForward: false, recoverable: false, lastKnownGeneration: 1n }] }] };
  await act(async () => publishSnapshot.get(second.id)!(htmlState));
  await act(async () => current.openWorkspaceHtml("shared-session", "workspace", "index.html", { forceSidebar: true }));
  expect(browserCalls.get(second.id)).toHaveBeenCalledExactlyOnceWith("browser", "shared-session", "", "", { workspaceId: "workspace", relativePath: "index.html", expectedRevision: "html-revision" });
  expect(current.state.preferences.localLinkOpenPreference).toBe("external");
  expect(current.state.browserInspectorFocusRequest).toMatchObject({ sessionId: "shared-session", pageId: "opened-page" });
  const previewSurface = document.createElement("div"); document.body.append(previewSurface);
  const releasePreview = registerWorkspaceHtmlPreviewSurface("browser", "opened-page", previewSurface);
  const publishHtml = async (runId?: string, changed = false) => {
    const items = changed ? [{ runId: "html-run", workspaceDiff: { changeSetId: "change", workspaceId: "workspace", files: [{ path: "index.html", status: "modified" }] } }] as unknown as TimelineItemView[] : [];
    htmlState = { ...htmlState, sessions: [{ ...htmlSession, ...(runId === undefined ? {} : { activeRunId: runId }) }], timelineBySession: new Map([[htmlSession.id, items]]) };
    await act(async () => publishSnapshot.get(second.id)!(htmlState));
  };
  await publishHtml("html-run"); await publishHtml();
  expect(reloadCalls.get(second.id)).not.toHaveBeenCalled();
  await publishHtml(undefined, true);
  expect(reloadCalls.get(second.id)).toHaveBeenCalledExactlyOnceWith("browser", "opened-page", { kind: "navigationCommand", command: "reload" });
  await publishHtml(undefined, true);
  expect(reloadCalls.get(second.id)).toHaveBeenCalledOnce();
  previewSurface.hidden = true;
  await publishHtml("html-run"); await publishHtml(undefined, true);
  expect(reloadCalls.get(second.id)).toHaveBeenCalledOnce();
  previewSurface.hidden = false;
  await publishHtml("html-run");
  await act(async () => current.disconnect());
  await expect(secondController.cancelProviderLogin(loginFlow.id)).rejects.toThrow("authorization source is no longer current");
  await expect(current.cancelProviderLogin(loginFlow.id)).rejects.toThrow("authorization source is no longer current");
  expect(retiredLoginCalls.cancelProviderLogin).toHaveBeenCalledOnce();
  await act(async () => current.connect(second));
  await publishHtml(undefined, true);
  expect(reloadCalls.get(second.id)).not.toHaveBeenCalled();
  releasePreview(); previewSurface.remove();
  expect(current.beginProviderLogin).not.toBe(secondController.beginProviderLogin);
  await expect(secondController.getProviderLoginFlow(loginFlow.id)).rejects.toThrow("authorization source is no longer current");
  expect(loginCalls.get(second.id)!.getProviderLoginFlow).not.toHaveBeenCalled();
  expect(retiredLoginCalls.getProviderLoginFlow).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

function profile(id: string): ConnectionProfile { return { id, deviceId: `device-${id}`, name: id, origin: `https://${id}.example`, serverId: `server-${id}` }; }
