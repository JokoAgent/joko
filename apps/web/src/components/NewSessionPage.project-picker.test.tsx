// @vitest-environment jsdom
import { act, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { composerDocumentPlainText } from "../composer-quote-document.js";
import type { AppController, ControllerState } from "../controller.js";
import { emptySnapshot, type AppSnapshot, type NewSessionLocalDraft } from "../model.js";
import { NewSessionPage, type NewSessionProjectPickerRequest } from "./NewSessionPage.js";

vi.mock("./ComposerRichTextEditor.js", () => ({
  ComposerRichTextEditor: forwardRef(function Editor(props: { readonly document: Parameters<typeof composerDocumentPlainText>[0] }, ref) {
    useImperativeHandle(ref, () => ({ focus: vi.fn(), focusFromBlankSurface: vi.fn(), routeReferenceDrop: vi.fn(), insertRouteReference: vi.fn(), insertText: vi.fn(), editPastedText: vi.fn() }));
    return <div data-testid="draft-editor">{composerDocumentPlainText(props.document)}</div>;
  })
}));
vi.mock("./ModelPicker.js", () => ({ ModelPicker: () => null }));
vi.mock("./HomeUsageDashboard.js", () => ({ HomeUsageDashboard: () => null }));
vi.mock("./ComposerPastedTextDialog.js", () => ({ ComposerPastedTextDialog: () => null }));

const roots: Root[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  window.localStorage.clear();
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "jokoDesktop");
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("opens the current new-task picker once and preserves the draft when an existing project is chosen", async () => {
  const view = await mount();
  await view.render(request(1));
  expect(view.consumed).toHaveBeenCalledExactlyOnceWith(1);
  expect(document.querySelector("[role='listbox']")?.textContent).toContain("newTask.addProject");
  expect(document.querySelector("[role='listbox']")?.textContent).not.toContain("newTask.browseLocalProject");
  await act(async () => option("Second project").click());
  expect(selectionValue(view.host)).toBe("target:second");
  expect(view.host.textContent).toContain("Keep this draft");
  await view.render(request(1));
  expect(view.consumed).toHaveBeenCalledTimes(1);
  expect(document.querySelector("[role='listbox']")).toBeNull();
  await view.render(request(2, { profileId: "foreign" }));
  expect(view.consumed).toHaveBeenLastCalledWith(2);
  expect(document.querySelector("[role='listbox']")).toBeNull();
});

it("creates a project in the same draft, retains failed input for retry, and discards a late result after owner change", async () => {
  const view = await mount();
  await view.render(request(1));
  await act(async () => option("newTask.addProject").click());
  const form = required(document.querySelector<HTMLFormElement>("[role='dialog'] form"));
  await change(required(form.querySelector<HTMLInputElement>('input[maxlength="120"]')), "New project");
  await change(required(form.querySelector<HTMLInputElement>("#project-editor-path")), "/service/new-project");
  view.createTarget.mockRejectedValueOnce(new Error("Cannot create project"));
  await act(async () => { form.requestSubmit(); await Promise.resolve(); });
  expect(document.querySelector("[role='alert']")?.textContent).toContain("Cannot create project");
  expect(required(form.querySelector<HTMLInputElement>("#project-editor-path")).value).toBe("/service/new-project");
  expect(view.host.textContent).toContain("Keep this draft");

  view.createTarget.mockResolvedValueOnce("created");
  await act(async () => { form.requestSubmit(); await Promise.resolve(); });
  expect(view.createTarget).toHaveBeenLastCalledWith(expect.objectContaining({ name: "New project", serverPath: "/service/new-project" }));
  expect(document.querySelector("[role='dialog']")).toBeNull();
  expect(selectionValue(view.host)).toBe("target:created");
  expect(view.host.textContent).toContain("Keep this draft");

  await view.render(request(2));
  await act(async () => option("newTask.addProject").click());
  await change(required(document.querySelector<HTMLInputElement>("#project-editor-path")), "/service/late");
  await change(required(document.querySelector<HTMLInputElement>('[role="dialog"] input[maxlength="120"]')), "Late project");
  let resolveLate!: (value: string) => void;
  view.createTarget.mockReturnValueOnce(new Promise<string>((resolve) => { resolveLate = resolve; }));
  await act(async () => { required(document.querySelector<HTMLFormElement>("[role='dialog'] form")).requestSubmit(); });
  await view.changeProfile("foreign");
  await act(async () => { resolveLate("late"); await Promise.resolve(); });
  expect(selectionValue(view.host)).not.toBe("target:late");
});

it("reopens project choices after a cancelled local directory picker and prefills the selected folder without losing the draft", async () => {
  const pickDirectory = vi.fn()
    .mockResolvedValueOnce({ cancelled: true })
    .mockResolvedValueOnce({ cancelled: false, path: "C:\\work\\chosen" });
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: {
    capabilities: ["projects.directoryPicker"], projects: { pickDirectory }
  } });
  const view = await mount(true);
  await view.render(request(1));
  await act(async () => { option("newTask.browseLocalProject").click(); await Promise.resolve(); });
  expect(pickDirectory).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(document.querySelector("[role='listbox']")?.textContent).toContain("newTask.browseLocalProject"));
  await act(async () => { option("newTask.browseLocalProject").click(); await Promise.resolve(); });
  expect(document.querySelector<HTMLInputElement>("#project-editor-path")?.value).toBe("C:\\work\\chosen");
  expect(document.querySelector<HTMLInputElement>('[role="dialog"] input[maxlength="120"]')?.value).toBe("chosen");
  expect(view.host.textContent).toContain("Keep this draft");
});

it("does not carry a late native directory result into another service owner", async () => {
  let resolvePick!: (result: { readonly cancelled: false; readonly path: string }) => void;
  const pickDirectory = vi.fn(() => new Promise((resolve) => { resolvePick = resolve; }));
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: {
    capabilities: ["projects.directoryPicker"], projects: { pickDirectory }
  } });
  const view = await mount(true);
  await view.render(request(1));
  await act(async () => option("newTask.browseLocalProject").click());
  expect(pickDirectory).toHaveBeenCalledOnce();
  await view.changeProfile("foreign");
  await act(async () => { resolvePick({ cancelled: false, path: "C:\\wrong-owner" }); await Promise.resolve(); });
  expect(document.querySelector("[role='dialog']")).toBeNull();
  expect(view.host.textContent).toContain("Keep this draft");
});

function request(requestId: number, patch: Partial<NewSessionProjectPickerRequest> = {}): NewSessionProjectPickerRequest {
  return { requestId, ownerDocument: document, profileId: "profile", serverId: "server",
    connectionGeneration: 7n, sourceNavigationRevision: 0, ...patch };
}

async function mount(local = false) {
  const snapshot = projectSnapshot();
  const profile = { id: "profile", deviceId: "device", serverId: "server", name: "Service", origin: "http://service",
    ...(local ? { managedLocal: true } : {}) };
  let state = {
    connectionState: "connected", route: { kind: "newSession" }, navigationRevision: 1,
    activeProfile: profile,
    ...(local ? { managedOrchestratorStatus: { state: "ready", connection: {
      profileId: profile.id, deviceId: profile.deviceId, serverId: profile.serverId, name: profile.name, origin: profile.origin
    } } } : {}),
    snapshot, preferences: { locale: "en", composerSendShortcut: "enter", newSessionWorktreeEnabled: false }
  } as unknown as ControllerState;
  const createTarget = vi.fn<(_draft: unknown) => Promise<string>>();
  const controller = {
    get state() { return state; },
    readNewSessionDraft: vi.fn(async () => savedDraft()),
    saveNewSessionDraft: vi.fn(async () => undefined),
    readPendingExtensionUse: vi.fn(async () => undefined),
    prepareTargetWorkspace: vi.fn(async () => undefined),
    probeTargetWorktree: vi.fn(async (targetId: string) => ({ targetId, eligibility: "unavailable", canRefreshRemote: false })),
    listTargetWorktreeSources: vi.fn(async () => []),
    setNewSessionWorktreeEnabled: vi.fn(async () => undefined),
    createTarget
  } as unknown as AppController;
  const consumed = vi.fn();
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host); roots.push(root);
  const render = (picker?: NewSessionProjectPickerRequest) => act(async () => {
    root.render(<NewSessionPage controller={controller} snapshot={state.snapshot} projectPickerRequest={picker}
      onProjectPickerRequestConsumed={consumed} navigationOpen t={(key) => key}
      onOpenNavigation={() => undefined} onClose={() => undefined} onSubmit={async () => undefined} />);
    await Promise.resolve();
  });
  await render();
  return { host, consumed, createTarget, render, changeProfile: async (id: string) => {
    state = { ...state, activeProfile: { ...state.activeProfile!, id } };
    await render();
  } };
}

function projectSnapshot(): AppSnapshot {
  return { ...emptySnapshot(), generation: 7n,
    backends: [{ id: "backend", name: "Backend", version: "1", instanceGeneration: 1,
      health: "healthy", capabilities: new Map([["input.text", { name: "input.text", supported: true, options: [] }]]) }],
    targets: ["first", "second"].map((id) => ({ id, backendId: "backend", name: id === "first" ? "First project" : "Second project",
      workspaceId: `workspace-${id}`, workspaceName: id, revision: 1n, trusted: true, pinned: false, archived: false })),
    workspaces: ["first", "second"].map((id) => ({ id: `workspace-${id}`, targetId: id, name: id,
      kind: "userProject" as const, serverPath: `/service/${id}`, trusted: true, dirty: false, revision: id, entries: [] })) };
}

function savedDraft(): NewSessionLocalDraft {
  return { selection: { kind: "target", targetId: "first" }, nativeStart: { kind: "fresh" },
    providerId: "", modelId: "", fastMode: false, permissionMode: "ask", planMode: false,
    text: "Keep this draft", editorDocument: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Keep this draft" }] }] },
    mentions: [], inlineMentionRanges: [], attachments: [] };
}

function option(label: string): HTMLElement {
  return required([...document.querySelectorAll<HTMLElement>("[role='option']")].find((candidate) => candidate.textContent?.includes(label)));
}

function selectionValue(host: HTMLElement): string {
  return required(host.querySelector<HTMLSelectElement>(".new-task-context__control--target select")).value;
}

async function change(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing project picker element.");
  return value;
}
