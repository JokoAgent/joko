// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppWithController } from "./App.js";
import type { AppController, ControllerState } from "./controller.js";
import { DEFAULT_UI_PREFERENCES } from "./local-state.js";
import { emptySnapshot } from "./model.js";

vi.mock("./components/Sidebar.js", () => ({ Sidebar: () => null }));
vi.mock("./components/NewSessionPage.js", () => ({ NewSessionPage: () => null }));
vi.mock("./components/ConnectionScreen.js", () => ({ ConnectionScreen: () => <div>Choose a node</div> }));
let root: Root | undefined;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

it("drops a File selected on A before reconnecting the same App instance to B", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  const original = controller("a"), replacement = controller("b");
  await act(async () => root!.render(<AppWithController controller={original} />));
  const file = new File(["private task history"], "private.jshare", { type: "application/vnd.joko.session" });
  await drop(file);
  expect(original.inspectPortableSessionImport).toHaveBeenCalledExactlyOnceWith(file);

  await act(async () => root!.render(<AppWithController controller={{ ...original, state: {
    ...original.state, connectionState: "disconnected", activeProfile: undefined, snapshot: emptySnapshot()
  } }} />));
  expect(container.textContent).toContain("Choose a node");
  await act(async () => root!.render(<AppWithController controller={replacement} />));
  expect(replacement.inspectPortableSessionImport).not.toHaveBeenCalled();
  expect(original.cancelPortableSessionImport).toHaveBeenCalledWith("draft-a");
  expect(container.querySelector(".portable-session-dialog--import")).toBeNull();

  const fresh = new File(["explicit B history"], "new.jshare", { type: "application/vnd.joko.session" });
  await drop(fresh);
  expect(replacement.inspectPortableSessionImport).toHaveBeenCalledExactlyOnceWith(fresh);
});

async function drop(file: File): Promise<void> {
  await act(async () => {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files: [file], items: [{ kind: "file", type: file.type }] } });
    window.dispatchEvent(event);
  });
}

function controller(id: string): AppController {
  const snapshot = { ...emptySnapshot(), generation: 1n, revision: 1n,
    backends: [{ id: "backend", name: "Backend", version: "1", health: "healthy" as const,
      capabilities: new Map([["session.portable_transfer", { name: "session.portable_transfer", supported: true, options: [] }]]) }],
    targets: [{ id: "target", backendId: "backend", name: "Project", workspaceId: "workspace", revision: 1n,
      workspaceName: "Project", trusted: true, pinned: false, archived: false }],
    workspaces: [{ id: "workspace", targetId: "target", name: "Project", kind: "userProject" as const,
      serverPath: "/project", trusted: true, dirty: false, entries: [] }] };
  const state: ControllerState = {
    ready: true, connectionState: "connected", connectionGeneration: id === "a" ? 1 : 2,
    activeProfile: { id, serverId: `server-${id}`, deviceId: `device-${id}`, name: id, origin: `https://${id}.example` },
    profiles: [], machineCaches: [], machinePresenceByProfile: {}, discoveredNodes: [], discoveryState: "idle",
    managedOrchestratorStatus: undefined, automaticConnectionAvailable: true, snapshot, route: { kind: "newSession" },
    navigationRevision: 0, preferences: DEFAULT_UI_PREFERENCES, systemLocale: "en", effectiveLocale: "en", extensionNotifications: []
  };
  return { state, navigate: vi.fn(), setNavigationOpen: vi.fn(), setNavigationLayout: vi.fn(), changeWindowZoom: vi.fn(),
    getTaskHistoryMaintenanceSupport: vi.fn(async () => ({ supported: false })),
    inspectPortableSessionImport: vi.fn(async () => ({ draftId: `draft-${id}`, expiresAt: Date.now() + 60_000,
      encrypted: true, passwordRequired: true })),
    cancelPortableSessionImport: vi.fn(async () => undefined), unlockPortableSessionImport: vi.fn(),
    commitPortableSessionImport: vi.fn(), retryPortableSessionActivation: vi.fn(), exportPortableSession: vi.fn()
  } as unknown as AppController;
}
