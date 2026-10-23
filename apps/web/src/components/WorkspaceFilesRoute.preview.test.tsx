// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type BackendView, type SessionView, type TargetView, type WorkspaceFilePreviewView, type WorkspaceView } from "../model.js";
import { WorkspaceFilesRoute, type WorkspaceFilesRouteProps } from "./WorkspaceFilesRoute.js";
import type { WorkspaceFileBodyProps } from "./WorkspaceFileBody.js";

vi.mock("./WorkspaceFileBody.js", () => ({ WorkspaceFileBody: (props: WorkspaceFileBodyProps) => <div data-testid="preview" data-writable={String(props.canWrite)}>
  {props.error ?? props.preview?.text ?? (props.loading ? "loading" : "empty")}
</div> }));
vi.mock("./WorkspaceFilesSidebar.js", () => ({ WorkspaceFilesSidebar: () => <div /> }));

const roots: Root[] = [];
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("Files route immediate text and background verification", () => {
  it("shows warm text without a loading frame and keeps it read-only until the fresh result arrives", async () => {
    const read = deferred<WorkspaceFilePreviewView>(), controller = owner(1, () => read.promise, preview("cached"));
    const { host } = await render(controller);
    expect(host.querySelector('[data-testid="preview"]')?.textContent).toBe("cached");
    expect(host.querySelector('[data-testid="preview"]')?.getAttribute("data-writable")).toBe("false");
    await act(async () => read.resolve(preview("fresh")));
    expect(host.querySelector('[data-testid="preview"]')?.textContent).toBe("fresh");
    expect(host.querySelector('[data-testid="preview"]')?.getAttribute("data-writable")).toBe("true");
  });

  it("retains a labelled read-only copy after a connection failure", async () => {
    const read = deferred<WorkspaceFilePreviewView>(), { host } = await render(owner(1, () => read.promise, preview("cached")));
    await act(async () => read.reject(new ConnectError("offline", Code.Unavailable)));
    expect(host.querySelector('[data-testid="preview"]')?.textContent).toBe("cached");
    expect(host.querySelector('[data-testid="preview"]')?.getAttribute("data-writable")).toBe("false");
    expect(host.textContent).toContain("workspace.cachedPreviewUnavailable");
  });

  it("does not present cached text as a successful preview after permission is denied", async () => {
    const read = deferred<WorkspaceFilePreviewView>(), { host } = await render(owner(1, () => read.promise, preview("cached secret")));
    await act(async () => read.reject(new ConnectError("denied", Code.PermissionDenied)));
    expect(host.querySelector('[data-testid="preview"]')?.textContent).not.toContain("cached secret");
    expect(host.textContent).not.toContain("workspace.cachedPreviewUnavailable");
  });

  it("retires both the old visible text and its late read on a connection occurrence change", async () => {
    const oldRead = deferred<WorkspaceFilePreviewView>(), newRead = deferred<WorkspaceFilePreviewView>();
    const { host, root } = await render(owner(1, () => oldRead.promise, preview("old source")));
    await act(async () => root.render(view(owner(2, () => newRead.promise))));
    expect(host.querySelector('[data-testid="preview"]')?.textContent).toBe("loading");
    await act(async () => oldRead.resolve(preview("late old source")));
    expect(host.querySelector('[data-testid="preview"]')?.textContent).toBe("loading");
    await act(async () => newRead.resolve(preview("new source")));
    expect(host.querySelector('[data-testid="preview"]')?.textContent).toBe("new source");
  });
});

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function preview(text: string): WorkspaceFilePreviewView { return { path: "src/a.ts", name: "a.ts", kind: "text", text, revision: `revision-${text}`, truncated: false }; }
function owner(generation: number, read: () => Promise<WorkspaceFilePreviewView>, cached?: WorkspaceFilePreviewView): AppController {
  return { state: { ready: true, connectionState: "connected", connectionGeneration: generation, profiles: [], machineCaches: [], machinePresenceByProfile: {},
    discoveredNodes: [], discoveryState: "idle", managedOrchestratorStatus: undefined, automaticConnectionAvailable: false,
    snapshot: emptySnapshot(), route: { kind: "files", sessionId: "preview-task", file: "src/a.ts" }, preferences: DEFAULT_UI_PREFERENCES, extensionNotifications: [] },
    readWorkspaceFile: vi.fn(read), peekWorkspaceFile: vi.fn(() => cached), navigate: vi.fn(), probeRuntimeActivity: vi.fn(async () => false) } as unknown as AppController;
}
const session: SessionView = { id: "preview-task", backendId: "backend", targetId: "target", name: "Preview", state: "idle", pinned: false, archived: false,
  generation: 1n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 1 };
const target: TargetView = { id: "target", revision: 1n, backendId: "backend", name: "Project", workspaceId: "preview-workspace", workspaceName: "Project", trusted: true, pinned: false, archived: false };
const backend: BackendView = { id: "backend", name: "Backend", version: "1", health: "healthy", capabilities: new Map([["workspace.files.write", { name: "workspace.files.write", supported: true, options: [] }]]) };
const workspace: WorkspaceView = { id: "preview-workspace", targetId: "target", name: "Project", kind: "userProject", serverPath: "C:/project", trusted: true, dirty: false, entries: [] };
const navigation = { open: true, mode: "expanded", width: 320, onCloseDrawer: vi.fn(), onHide: vi.fn(), onCollapse: vi.fn(), onExpand: vi.fn(), onResizePointerDown: vi.fn(),
  onResizePointerMove: vi.fn(), onResizePointerUp: vi.fn(), onResizePointerCancel: vi.fn(), onResizeKeyDown: vi.fn(), onResetWidth: vi.fn(), onDisconnect: vi.fn() } as WorkspaceFilesRouteProps["navigation"];
function view(controller: AppController) { return <WorkspaceFilesRoute controller={controller} route={{ kind: "files", sessionId: session.id, file: "src/a.ts" }}
  session={session} target={target} backend={backend} workspace={workspace} sessions={[session]} chatPane={null} t={key => key} onError={vi.fn()} onArchiveSession={vi.fn()} navigation={navigation} />; }
async function render(controller: AppController) { const host = document.body.appendChild(document.createElement("div")), root = createRoot(host); roots.push(root); await act(async () => root.render(view(controller))); return { host, root }; }
