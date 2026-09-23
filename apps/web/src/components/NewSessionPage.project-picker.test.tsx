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
  expect(picker()?.textContent).toContain("newTask.addProject");
  expect(picker()?.textContent).not.toContain("newTask.browseLocalProject");
  await act(async () => option("Second project").click());
  expect(selectionValue(view.host)).toBe("target:second");
  expect(view.host.textContent).toContain("Keep this draft");
  await view.render(request(1));
  expect(view.consumed).toHaveBeenCalledTimes(1);
  expect(picker()).toBeNull();
  await view.render(request(2, { profileId: "foreign" }));
  expect(view.consumed).toHaveBeenLastCalledWith(2);
  expect(picker()).toBeNull();
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
  expect(document.querySelector("[role='dialog'] form")).toBeNull();
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

it("uses a ready Host from another project, reuses its existing project, and explicitly confirms a missing directory", async () => {
  const view = await mount();
  const host = { targetId: "first", id: "build-box", hostname: "build.example", port: 22, user: "maker",
    source: "manual" as const, authentication: "systemAgent" as const,
    trust: { algorithm: "ssh-ed25519", sha256Fingerprint: "sha256:test", pinnedAt: 1 },
    status: { state: "ready" as const, changedAt: 1 }, revision: 3n };
  view.listRemoteHosts.mockImplementation(async (targetId: string) => targetId === "first" ? [host] : []);
  view.changeSnapshotSilently((snapshot) => ({ ...snapshot, targets: snapshot.targets.map((target) => target.id === "second"
    ? { ...target, remoteWorkspace: { hostTargetId: "first", hostId: "build-box", workspaceRoot: "/srv/existing" } }
    : target) }));
  await view.render(request(1));
  await act(async () => option("newTask.addRemoteProject").click());
  await vi.waitFor(() => expect(document.querySelector("[role='dialog']")?.textContent).toContain("Second project"));
  expect(document.activeElement).toBe(document.querySelector(".modal-layer [data-select-control='true']"));
  await act(async () => required([...document.querySelectorAll<HTMLButtonElement>(".modal-layer button")]
    .find((button) => button.textContent?.includes("Second project"))).click());
  expect(selectionValue(view.host)).toBe("target:first");
  await act(async () => required(document.querySelector<HTMLFormElement>(".modal-layer form")).requestSubmit());
  expect(selectionValue(view.host)).toBe("target:second");
  expect(document.querySelector(".modal-layer .modal")).toBeNull();

  view.inspectRemoteHostDirectory.mockResolvedValue({ targetId: "first", hostId: "build-box",
    targetRevision: 1n, hostRevision: 3n, exists: false, path: "/srv/new" });
  view.createRemoteTarget.mockResolvedValue("remote-created");
  await view.render(request(2));
  await act(async () => option("newTask.addRemoteProject").click());
  await vi.waitFor(() => expect(document.querySelector(".modal-layer .modal")?.textContent).toContain("remoteProject.browse"));
  await act(async () => required([...document.querySelectorAll<HTMLButtonElement>(".modal-layer button")]
    .find((button) => button.textContent === "remoteProject.browse")).click());
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>("#remote-project-path")).not.toBeNull());
  await change(required(document.querySelector<HTMLInputElement>("#remote-project-path")), "/srv/new");
  await act(async () => { required(document.querySelector<HTMLFormElement>("[role='dialog'] form")).requestSubmit(); await Promise.resolve(); });
  expect(view.inspectRemoteHostDirectory).toHaveBeenCalledWith("first", "build-box", 1n, 3n, "/srv/new", expect.any(AbortSignal));
  expect(document.querySelector(".modal-layer .modal")?.textContent).toContain("remoteProject.missingBody");
  expect(view.createRemoteTarget).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(document.querySelector("[data-remote-project-missing-cancel]"));
  await act(async () => required(document.querySelector<HTMLButtonElement>("[data-remote-project-missing-cancel]")).click());
  expect(document.activeElement).toBe(document.querySelector("#remote-project-path"));
  await act(async () => { required(document.querySelector<HTMLFormElement>("[role='dialog'] form")).requestSubmit(); await Promise.resolve(); });
  await act(async () => required([...document.querySelectorAll<HTMLButtonElement>(".modal-layer button")]
    .find((button) => button.textContent?.includes("remoteProject.createDirectory"))).click());
  expect(view.createRemoteTarget).toHaveBeenCalledWith({ backendId: "backend", name: "new",
    hostTargetId: "first", hostId: "build-box", expectedHostTargetRevision: 1n,
    expectedHostRevision: 3n, workspacePath: "/srv/new", createIfMissing: true });
  expect(selectionValue(view.host)).toBe("target:remote-created");
  expect(view.host.textContent).toContain("Keep this draft");
  expect(document.activeElement).toBe(view.host.querySelector(".new-task-project-picker__trigger"));
});

it("keeps a ready Host available when its source project is archived", async () => {
  const view = await mount();
  view.listRemoteHosts.mockImplementation(async (targetId: string) => targetId === "first" ? [{
    targetId, id: "archived-source", hostname: "archive.example", port: 22, user: "maker",
    source: "manual", authentication: "systemAgent",
    trust: { algorithm: "ssh-ed25519", sha256Fingerprint: "sha256:test", pinnedAt: 1 },
    status: { state: "ready", changedAt: 1 }, revision: 3n
  }] : []);
  view.changeSnapshotSilently((snapshot) => ({ ...snapshot, targets: snapshot.targets.map((target) =>
    target.id === "first" ? { ...target, archived: true } : target) }));
  await view.render(request(1));
  await act(async () => option("newTask.addRemoteProject").click());
  await vi.waitFor(() => expect(document.querySelector(".modal-layer .modal")?.textContent).toContain("archived-source"));
  expect(view.listRemoteHosts).toHaveBeenCalledWith("first", expect.any(AbortSignal));
});

it("discards remote directory inspection after the service owner changes", async () => {
  const view = await mount();
  view.listRemoteHosts.mockImplementation(async (targetId: string) => targetId === "first" ? [{
    targetId, id: "build-box", hostname: "build.example", port: 22, user: "maker",
    source: "manual", authentication: "systemAgent",
    trust: { algorithm: "ssh-ed25519", sha256Fingerprint: "sha256:test", pinnedAt: 1 },
    status: { state: "ready", changedAt: 1 }, revision: 3n
  }] : []);
  let resolveInspection!: (value: unknown) => void;
  view.inspectRemoteHostDirectory.mockReturnValue(new Promise((resolve) => { resolveInspection = resolve; }));
  await view.render(request(1));
  await act(async () => option("newTask.addRemoteProject").click());
  await vi.waitFor(() => expect(document.querySelector(".modal-layer .modal")?.textContent).toContain("remoteProject.browse"));
  await act(async () => required([...document.querySelectorAll<HTMLButtonElement>(".modal-layer button")]
    .find((button) => button.textContent === "remoteProject.browse")).click());
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>("#remote-project-path")).not.toBeNull());
  await change(required(document.querySelector<HTMLInputElement>("#remote-project-path")), "/srv/late");
  await act(async () => { required(document.querySelector<HTMLFormElement>("[role='dialog'] form")).requestSubmit(); });
  await view.changeProfile("foreign");
  await act(async () => { resolveInspection({ targetId: "first", hostId: "build-box", targetRevision: 1n,
    hostRevision: 3n, exists: true, path: "/srv/late" }); await Promise.resolve(); });
  expect(view.createRemoteTarget).not.toHaveBeenCalled();
  expect(document.querySelector(".modal-layer .modal")).toBeNull();
});

it("opens SSH home lazily, selects a child on one click, and enters it on double click", async () => {
  const view = await mount();
  view.listRemoteHosts.mockImplementation(async (targetId: string) => targetId === "first" ? [{
    targetId, id: "build-box", hostname: "build.example", port: 22, user: "maker",
    source: "manual", authentication: "systemAgent",
    trust: { algorithm: "ssh-ed25519", sha256Fingerprint: "sha256:test", pinnedAt: 1 },
    status: { state: "ready", changedAt: 1 }, revision: 3n
  }] : []);
  view.listRemoteHostDirectories.mockImplementation(async (targetId: string, hostId: string,
    targetRevision: bigint, hostRevision: bigint, path: string) => ({
    targetId, hostId, targetRevision, hostRevision,
    path: path === "" ? "/home/maker" : path,
    parentPath: path === "/home/maker/repo" ? "/home/maker" : "/home",
    directories: path === "" ? [{ name: "repo", path: "/home/maker/repo" }] : [], truncated: false
  }));
  await view.render(request(1));
  await act(async () => option("newTask.addRemoteProject").click());
  await vi.waitFor(() => expect(document.querySelector(".modal-layer .modal")?.textContent).toContain("remoteProject.noExistingProjects"));
  await act(async () => required([...document.querySelectorAll<HTMLButtonElement>(".modal-layer button")]
    .find((button) => button.textContent === "remoteProject.browse")).click());
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>("#remote-project-path")?.value).toBe("/home/maker"));
  expect(view.listRemoteHostDirectories).toHaveBeenCalledWith("first", "build-box", 1n, 3n, "", expect.any(AbortSignal));
  const repo = required([...document.querySelectorAll<HTMLButtonElement>(".project-editor__browser-list button")]
    .find((button) => button.textContent === "repo"));
  await act(async () => repo.click());
  expect(document.querySelector<HTMLInputElement>("#remote-project-path")?.value).toBe("/home/maker/repo");
  expect(view.listRemoteHostDirectories).toHaveBeenCalledTimes(1);
  await act(async () => repo.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await vi.waitFor(() => expect(view.listRemoteHostDirectories).toHaveBeenCalledTimes(2));
  expect(view.listRemoteHostDirectories).toHaveBeenLastCalledWith("first", "build-box", 1n, 3n,
    "/home/maker/repo", expect.any(AbortSignal));
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
  await vi.waitFor(() => expect(picker()?.textContent).toContain("newTask.browseLocalProject"));
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
  expect(document.querySelector("[role='dialog'] form")).toBeNull();
  expect(view.host.textContent).toContain("Keep this draft");
});

it("shows durable recent projects first, rechecks their Target identity, and removes history without deleting a project", async () => {
  const view = await mount();
  const recent = { targetId: "second", workspaceId: "workspace-second", name: "Second project", serverPath: "/service/second", lastUsedAt: 4 };
  view.readRecentProjects.mockResolvedValue([recent]);
  await view.render(request(1));
  await vi.waitFor(() => expect(picker()?.textContent).toContain("newTask.recentProjects"));
  expect(picker()?.querySelector("section")?.textContent).toContain("Second project");
  await act(async () => option("Second project").click());
  expect(selectionValue(view.host)).toBe("target:second");
  expect(view.host.textContent).toContain("Keep this draft");

  await view.render(request(2));
  await vi.waitFor(() => expect(picker()?.textContent).toContain("newTask.recentProjects"));
  view.removeRecentProject.mockRejectedValueOnce(new Error("Local storage unavailable"));
  await act(async () => required(picker()?.querySelector<HTMLButtonElement>(".new-task-project-picker__remove")).click());
  await vi.waitFor(() => expect(picker()?.querySelector("[role='alert']")?.textContent).toContain("Local storage unavailable"));
  expect(picker()?.textContent).toContain("newTask.recentProjects");
  await act(async () => required(picker()?.querySelector<HTMLButtonElement>(".new-task-project-picker__remove")).click());
  expect(view.removeRecentProject).toHaveBeenCalledTimes(2);
  expect(view.removeRecentProject).toHaveBeenLastCalledWith(recent);
  await vi.waitFor(() => expect(picker()?.textContent).not.toContain("newTask.recentProjects"));
  expect(picker()?.textContent).toContain("Second project");
  expect(view.host.textContent).toContain("Keep this draft");
});

it("keeps current projects selectable when recent-history storage cannot be read", async () => {
  const view = await mount();
  view.readRecentProjects.mockRejectedValueOnce(new Error("Local storage unavailable"));
  await view.render(request(1));
  await vi.waitFor(() => expect(picker()?.querySelector("[role='alert']")?.textContent).toContain("Local storage unavailable"));
  await act(async () => option("Second project").click());
  expect(selectionValue(view.host)).toBe("target:second");
  expect(view.host.textContent).toContain("Keep this draft");
});

it("does not select a rebound recent path or reveal an old owner's late history", async () => {
  const view = await mount();
  const recent = { targetId: "second", workspaceId: "workspace-second", name: "Second project", serverPath: "/service/second", lastUsedAt: 4 };
  view.readRecentProjects.mockResolvedValueOnce([recent]);
  await view.render(request(1));
  await vi.waitFor(() => expect(picker()?.textContent).toContain("newTask.recentProjects"));
  view.changeSnapshotSilently((snapshot) => ({ ...snapshot, workspaces: snapshot.workspaces.map((workspace) =>
    workspace.id === "workspace-second" ? { ...workspace, serverPath: "/service/rebound" } : workspace) }));
  await act(async () => option("Second project").click());
  expect(selectionValue(view.host)).toBe("target:first");
  expect(picker()?.querySelector("[role='alert']")?.textContent).toContain("newTask.projectUnavailable");
  await view.render(request(1));
  await vi.waitFor(() => expect(picker()?.querySelector<HTMLButtonElement>(".new-task-project-picker__recent [data-project-picker-choice]")?.disabled).toBe(true));
  expect(selectionValue(view.host)).toBe("target:first");

  let resolveLate!: (value: typeof recent[]) => void;
  view.readRecentProjects.mockReturnValueOnce(new Promise((resolve) => { resolveLate = resolve; }));
  await act(async () => required(view.host.querySelector<HTMLButtonElement>(".new-task-project-picker__trigger")).click());
  await act(async () => required(view.host.querySelector<HTMLButtonElement>(".new-task-project-picker__trigger")).click());
  await view.changeProfile("foreign");
  await act(async () => { resolveLate([recent]); await Promise.resolve(); });
  expect(picker()).toBeNull();
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
  const createRemoteTarget = vi.fn<(_draft: unknown) => Promise<string>>();
  const listRemoteHosts = vi.fn(async (_targetId: string) => [] as readonly unknown[]);
  const listRemoteHostDirectories = vi.fn<AppController["listRemoteHostDirectories"]>(async () => {
    throw new Error("No SSH directory fixture configured.");
  });
  const inspectRemoteHostDirectory = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  const readRecentProjects = vi.fn(async () => [] as readonly { targetId: string; workspaceId: string; name: string; serverPath: string; lastUsedAt: number }[]);
  const removeRecentProject = vi.fn(async () => [] as readonly { targetId: string; workspaceId: string; name: string; serverPath: string; lastUsedAt: number }[]);
  const controller = {
    get state() { return state; },
    readNewSessionDraft: vi.fn(async () => savedDraft()),
    saveNewSessionDraft: vi.fn(async () => undefined),
    readPendingExtensionUse: vi.fn(async () => undefined),
    prepareTargetWorkspace: vi.fn(async () => undefined),
    probeTargetWorktree: vi.fn(async (targetId: string) => ({ targetId, eligibility: "unavailable", canRefreshRemote: false })),
    listTargetWorktreeSources: vi.fn(async () => []),
    setNewSessionWorktreeEnabled: vi.fn(async () => undefined),
    createTarget, createRemoteTarget, listRemoteHosts, inspectRemoteHostDirectory,
    getRemoteHostCapabilities: vi.fn(async () => ({ management: true, catalog: true,
      commandExecution: true, processStreaming: true, fileTransfer: true, tcpForwarding: true,
      interactiveTerminal: true, backendRuntimeSetup: true })),
    listRemoteHostDirectories, readRecentProjects, removeRecentProject
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
  return { host, consumed, createTarget, createRemoteTarget, listRemoteHosts, listRemoteHostDirectories, inspectRemoteHostDirectory,
    readRecentProjects, removeRecentProject, render,
    changeSnapshotSilently: (update: (value: AppSnapshot) => AppSnapshot) => {
      state = { ...state, snapshot: update(state.snapshot) };
    },
    changeProfile: async (id: string) => {
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
  return required([...required(picker()).querySelectorAll<HTMLElement>("[data-project-picker-choice]")].find((candidate) => candidate.textContent?.includes(label)));
}

function picker(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-new-task-project-picker][data-state='open']");
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
