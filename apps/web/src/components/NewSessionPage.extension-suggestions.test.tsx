// @vitest-environment jsdom
import { act, forwardRef, StrictMode, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { composerDocumentPlainText, plainTextToComposerDocument } from "../composer-quote-document.js";
import type { AppController, ControllerState } from "../controller.js";
import { emptySnapshot, type AppSnapshot, type ComposerDraft, type ExtensionCatalogEntryView, type NewSessionLocalDraft, type PendingExtensionSuggestionView } from "../model.js";
import { buildHomeTaskCatalog, type HomeTaskSuggestion } from "../extension-home-suggestions.js";
import { newSessionSuggestionContext } from "../new-session-suggestion-context.js";
import { serializeExtensionSuggestionOwner } from "../extension-suggestion-handoff.js";
import { NewSessionPage } from "./NewSessionPage.js";
import type { DelayedNewSessionDraft, NewSessionSubmissionOwner } from "../new-session-flow.js";

vi.mock("./ComposerRichTextEditor.js", () => ({
  ComposerRichTextEditor: forwardRef(function Editor(props: { readonly document: Parameters<typeof composerDocumentPlainText>[0] }, ref) {
    useImperativeHandle(ref, () => ({ focus: vi.fn(), focusFromBlankSurface: vi.fn(), routeReferenceDrop: vi.fn(), insertRouteReference: vi.fn(), editPastedText: vi.fn() }));
    return <div data-testid="draft-editor">{composerDocumentPlainText(props.document)}</div>;
  })
}));
vi.mock("./ModelPicker.js", () => ({ ModelPicker: () => null }));
vi.mock("./HomeUsageDashboard.js", () => ({ HomeUsageDashboard: () => null }));
vi.mock("./ComposerPastedTextDialog.js", () => ({ ComposerPastedTextDialog: () => null }));
vi.mock("./HomeSuggestionList.js", () => ({ HomeSuggestionList: (props: {
  readonly extensionEntries: readonly ExtensionCatalogEntryView[]; readonly disabled: boolean;
  readonly onExtensionSelect: (item: HomeTaskSuggestion) => void;
}) => <>{buildHomeTaskCatalog(props.extensionEntries, "en", (key) => key).filter((item) => item.extensionId !== undefined).map((item) =>
  <button key={item.id} disabled={props.disabled} onClick={() => props.onExtensionSelect(item)}>{item.label}</button>)}</> }));

const roots: Root[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("URL", class extends URL { static override createObjectURL(): string { return "blob:preview"; } static override revokeObjectURL(): void {} });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("revalidates an installed commandless recommendation and submits through the existing owner exactly once", async () => {
  const view = await mount();
  await act(async () => { button("Sort my documents").click(); button("Sort my documents").click(); });
  expect(view.getExtension).toHaveBeenCalledOnce();
  expect(view.onSubmit).toHaveBeenCalledOnce();
  const input = view.onSubmit.mock.calls[0]![1];
  expect(input.text).toContain("Sort the project documents.");
  expect(input.text).toContain(view.extension.id);
  expect(input.mentions).toEqual([]);
  expect(input.inlineMentionRanges).toEqual([]);
  expect(view.onSubmit.mock.calls[0]![0]).toMatchObject({ selection: { kind: "target", targetId: "project" }, expectedTargetRevision: 3n, permissionMode: "ask" });
  expect(view.recordExtensionSuggestionUse).toHaveBeenCalledExactlyOnceWith(view.extension.id);
  expect(view.navigate).not.toHaveBeenCalled();
});

it.each([true, false])("binds an authored command to the actual first runtime rather than requiring an old task; advertised=%s", async (advertised) => {
  const view = await mount({ command: true, missingNewCommand: !advertised });
  await act(async () => button("Sort my documents").click());
  expect(view.onSubmit).toHaveBeenCalledOnce();
  expect(view.getExtension).toHaveBeenCalledTimes(2);
  expect(view.getExtension.mock.calls[1]?.slice(0, 2)).toEqual([view.extension.id, "created-runtime"]);
  expect(view.onSubmit.mock.calls[0]![1].text).toBe("/sort-docs Sort the project documents.");
  if (advertised) expect(view.recordExtensionSuggestionUse).toHaveBeenCalledExactlyOnceWith(view.extension.id);
  else {
    expect(view.recordExtensionSuggestionUse).not.toHaveBeenCalled();
    expect(editor()).toBe("/sort-docs Sort the project documents.");
    await view.render();
    expect(view.getExtension).toHaveBeenCalledTimes(2);
  }
});

it("freezes the full draft before taking an unavailable recommendation to the exact Extension", async () => {
  const view = await mount({ unavailable: true, richDraft: true });
  await act(async () => button("Sort my documents").click());
  expect(view.onSubmit).not.toHaveBeenCalled();
  expect(view.savePendingExtensionSuggestion).toHaveBeenCalledOnce();
  const pending = view.savePendingExtensionSuggestion.mock.calls[0]![0];
  expect(pending).toMatchObject({ phase: "setup", extensionId: view.extension.id, extensionRevision: "7", backendId: "backend", targetId: "project" });
  expect(pending.draft).toMatchObject({ text: "Keep my original draft", selection: { kind: "target", targetId: "project" }, permissionMode: "ask", worktree: { enabled: false } });
  expect(pending.draft.attachments[0]?.file.name).toBe("notes.txt");
  expect(pending.draft.browserComments).toMatchObject([{ id: "annotation", comment: "Keep annotation", screenshot: { id: "screenshot", kind: "image" } }]);
  expect(pending.draft.browserComments?.[0]?.screenshot.file.name).toBe("page.png");
  expect(pending.draft.extraDirectoryIds).toEqual(["extra"]);
  expect(view.saveNewSessionDraft.mock.invocationCallOrder[0]).toBeLessThan(view.savePendingExtensionSuggestion.mock.invocationCallOrder[0]!);
  expect(view.navigate).toHaveBeenCalledExactlyOnceWith({ kind: "tools", extensionId: view.extension.id, recommendationNonce: pending.nonce });
  expect(view.recordExtensionSuggestionUse).not.toHaveBeenCalled();
});

it("does not apply a changed descriptor or a late result from another Target revision", async () => {
  const view = await mount();
  view.getExtension.mockResolvedValueOnce({ revision: 8n, extensions: [{ ...view.extension, recommendations: [{ id: "sort", label: "Sort my documents", prompt: "Changed" }] }], recoveredFromCorruption: false });
  await act(async () => button("Sort my documents").click());
  expect(view.onSubmit).not.toHaveBeenCalled();
  expect(editor()).toBe("Keep my original draft");
  let resolve!: (value: Awaited<ReturnType<AppController["getExtension"]>>) => void;
  view.getExtension.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  await act(async () => button("Sort my documents").click());
  await view.changeTargetRevision();
  await act(async () => resolve({ revision: 7n, extensions: [view.extension], recoveredFromCorruption: false }));
  expect(view.onSubmit).not.toHaveBeenCalled();
  expect(view.savePendingExtensionSuggestion).not.toHaveBeenCalled();
  expect(editor()).toBe("Keep my original draft");
});

it("atomically consumes a ready return under StrictMode and never repeats it after send failure", async () => {
  const view = await mount({ pending: true, sendFailure: true, strict: true });
  expect(view.consumePendingExtensionSuggestion).toHaveBeenCalledOnce();
  expect(view.onSubmit).toHaveBeenCalledOnce();
  expect(editor()).toContain("Sort the project documents.");
  expect(view.recordExtensionSuggestionUse).not.toHaveBeenCalled();
  await view.render();
  expect(view.onSubmit).toHaveBeenCalledOnce();
  expect(view.consumePendingExtensionSuggestion).toHaveBeenCalledOnce();
});

it("keeps a transient return failure retryable and rejects deterministic owner drift without following it", async () => {
  const view = await mount({ pending: true, readFailure: true });
  expect(view.onSubmit).not.toHaveBeenCalled();
  expect(view.consumePendingExtensionSuggestion).not.toHaveBeenCalled();
  await act(async () => button("common.retry").click());
  expect(view.onSubmit).toHaveBeenCalledOnce();
  expect(view.consumePendingExtensionSuggestion).toHaveBeenCalledOnce();
  const drift = await mount({ pending: true, drift: true });
  expect(drift.onSubmit).not.toHaveBeenCalled();
  expect(drift.consumePendingExtensionSuggestion).not.toHaveBeenCalled();
  expect(drift.compareAndSetPendingExtensionSuggestion).toHaveBeenCalledOnce();
  expect(drift.host.textContent).toContain("extensions.recommendationExpired");
});

async function mount(options: { unavailable?: boolean; pending?: boolean; sendFailure?: boolean; readFailure?: boolean; drift?: boolean; strict?: boolean; richDraft?: boolean; command?: boolean; missingNewCommand?: boolean } = {}) {
  let snapshot: AppSnapshot = { ...emptySnapshot(), generation: 2n,
    backends: [{ id: "backend", name: "Backend", version: "1", health: "healthy", instanceGeneration: 1,
      capabilities: new Map([["input.text", { name: "input.text", supported: true, options: [] }], ["permission.modes", { name: "permission.modes", supported: true, options: ["ask"] }],
        ["workspace.extra_dirs", { name: "workspace.extra_dirs", supported: true, options: [] }]]) }],
    targets: [{ id: "project", revision: 3n, backendId: "backend", name: "Project", workspaceId: "workspace", workspaceName: "Project", trusted: true, pinned: false, archived: false }],
    resources: [{ id: "extension-resource", backendId: "backend", name: "Document organizer", kind: "package", scope: "global", state: "installed", enabled: true,
      source: "local", discoveredRevision: "sha256:content", compatibilityDetails: [], runtimeRequirements: [], warnings: [], disabledLifecycleScripts: [], canToggle: true, requiresExtensionApproval: false, postMutationNotice: false }],
    extraDirectories: [{ id: "extra", workspaceId: "workspace", serverPath: "/extra", access: "readOnly", trusted: true }],
    workspaces: [{ id: "workspace", targetId: "project", name: "Project", kind: "userProject", serverPath: "/project", trusted: true, dirty: false, revision: "1", entries: [] }]
  };
  const extension: ExtensionCatalogEntryView = { id: "extension_0123456789abcdef0123456789abcdef", revision: 7n,
    owner: { kind: "resource", resourceId: "extension-resource", discoveredRevision: "sha256:content", resourceRevision: 4n },
    source: "local", installed: true, installState: "installed", enabled: !options.unavailable,
    name: "Document organizer", description: "Organize documents", sidebarSupported: false, sidebarVisible: false,
    tools: [], permissions: [], commands: [], setup: { state: "notRequired", revision: 0n, fields: [] }, useSupported: false,
    recommendations: [{ id: "sort", label: "Sort my documents", prompt: "Sort the project documents.", ...(options.command ? { command: "sort-docs" } : {}) }]
  };
  const draft: NewSessionLocalDraft = { selection: { kind: "target", targetId: "project" }, nativeStart: { kind: "fresh" }, providerId: "", modelId: "",
    fastMode: false, permissionMode: "ask", planMode: false, text: "Keep my original draft", editorDocument: plainTextToComposerDocument("Keep my original draft"), mentions: [], inlineMentionRanges: [],
    attachments: options.richDraft ? [{ id: "notes", kind: "file", file: new File(["notes"], "notes.txt", { type: "text/plain" }) }] : [],
    browserComments: options.richDraft ? [{ id: "annotation", markerNumber: 1, pageUrl: "https://example.com", comment: "Keep annotation",
      target: { kind: "element", point: { x: 1, y: 2 }, viewport: { width: 400, height: 800 } },
      screenshot: { id: "screenshot", kind: "image", file: new File(["pixels"], "page.png", { type: "image/png" }) } }] : [],
    extraDirectoryIds: options.richDraft ? ["extra"] : [], worktree: { enabled: false, refreshRemote: false } };
  const nonce = "11111111-1111-4111-8111-111111111111";
  const state = { activeProfile: { id: "profile", serverId: "server", deviceId: "device", name: "Node", origin: "http://node" }, snapshot,
    connectionState: "connected", route: { kind: "newSession", ...(options.pending ? { recommendationNonce: nonce } : {}) }, effectiveLocale: "en",
    preferences: { locale: "en", composerSendShortcut: "enter", newSessionWorktreeEnabled: false } } as unknown as ControllerState;
  const getExtension = vi.fn<AppController["getExtension"]>(async (_id, sessionId) => ({ revision: 7n,
    extensions: [options.drift ? { ...extension, revision: 8n } : sessionId === "created-runtime" && !options.missingNewCommand
      ? { ...extension, useSupported: true, commands: [{ name: "sort-docs", description: "Sort docs", sessionId }] } : extension], recoveredFromCorruption: false }));
  if (options.readFailure) getExtension.mockRejectedValueOnce(new Error("Temporary catalog failure"));
  const saveNewSessionDraft = vi.fn(async (_draft: NewSessionLocalDraft) => undefined);
  const savePendingExtensionSuggestion = vi.fn(async (_pending: PendingExtensionSuggestionView) => undefined);
  const compareAndSetPendingExtensionSuggestion = vi.fn(async (_expected: PendingExtensionSuggestionView) => true);
  const navigate = vi.fn(); const recordExtensionSuggestionUse = vi.fn(async (_id: string) => undefined);
  let stored: PendingExtensionSuggestionView | undefined;
  const consumePendingExtensionSuggestion = vi.fn(async (_nonce: string, _key: string) => { const value = stored; stored = undefined; return value; });
  const controller = { state, readNewSessionDraft: vi.fn(async () => draft), saveNewSessionDraft,
    readPendingExtensionUse: vi.fn(async () => undefined),
    listExtensions: vi.fn(async () => ({ revision: 7n, extensions: [extension], recoveredFromCorruption: false })), getExtension,
    readRecentExtensionSuggestions: vi.fn(async () => []), recordExtensionSuggestionUse, savePendingExtensionSuggestion,
    readPendingExtensionSuggestion: vi.fn(async () => stored), compareAndSetPendingExtensionSuggestion, consumePendingExtensionSuggestion,
    prepareTargetWorkspace: vi.fn(async () => undefined), navigate,
    probeTargetWorktree: vi.fn(async (targetId: string) => ({ targetId, eligibility: "unavailable", canRefreshRemote: false })),
    listTargetWorktreeSources: vi.fn(async () => []), setNewSessionWorktreeEnabled: vi.fn(async () => undefined)
  } as unknown as AppController;
  if (options.pending) stored = { nonce, phase: "ready", extensionId: extension.id, extensionRevision: "7", owner: serializeExtensionSuggestionOwner(extension.owner),
    recommendation: extension.recommendations![0]!, selectedLabel: "Sort my documents", selectedPrompt: "Sort the project documents.",
    contextKey: newSessionSuggestionContext(controller, snapshot, draft.selection)!, backendId: "backend", targetId: "project", draft };
  const onSubmit = vi.fn(async (_session: DelayedNewSessionDraft, _input: ComposerDraft, owner: NewSessionSubmissionOwner) => {
    if (options.sendFailure) throw new Error("Send failed");
    await owner.beforeFirstInput?.("created-runtime");
    owner.onFirstInputAccepted?.();
  });
  const host = document.body.appendChild(document.createElement("div")); const root = createRoot(host); roots.push(root);
  const render = async (): Promise<void> => { await act(async () => { const page = <NewSessionPage controller={controller} snapshot={snapshot} recommendationNonce={options.pending ? nonce : undefined}
    navigationOpen t={(key) => key} onOpenNavigation={vi.fn()} onClose={vi.fn()} onSubmit={onSubmit} />;
    root.render(options.strict ? <StrictMode>{page}</StrictMode> : page); await Promise.resolve(); }); };
  await render();
  return { host, extension, getExtension, onSubmit, saveNewSessionDraft, savePendingExtensionSuggestion, compareAndSetPendingExtensionSuggestion,
    consumePendingExtensionSuggestion, recordExtensionSuggestionUse, navigate, render,
    changeTargetRevision: async () => { snapshot = { ...snapshot, targets: snapshot.targets.map((target) => ({ ...target, revision: target.revision + 1n })) };
      (state as { snapshot: AppSnapshot }).snapshot = snapshot; await render(); } };
}
function button(label: string): HTMLButtonElement { const value = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label); if (value === undefined) throw new Error(`Missing button ${label}`); return value; }
function editor(): string { return document.querySelector("[data-testid='draft-editor']")?.textContent ?? ""; }
