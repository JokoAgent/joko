// @vitest-environment jsdom

import { Code, ConnectError } from "@connectrpc/connect";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import type {
  ExtensionCatalogEntryView,
  ExtensionLibraryOverviewView,
  ExtensionLibrarySessionView,
  ExtensionMainViewSurfaceView
} from "../model.js";
import {
  EXTENSION_LIBRARY_BRIDGE_REQUEST,
  EXTENSION_LIBRARY_BRIDGE_RESPONSE
} from "../extension-library-bridge.js";
import { ExtensionMainViewPage, sameExtensionMainViewSurface } from "./ExtensionMainViewPage.js";

const EXTENSION_A = "extension_0123456789abcdef0123456789abcdef";
const EXTENSION_B = "extension_11111111111111111111111111111111";
const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "jokoDesktop");
  vi.restoreAllMocks();
});

describe("Extension main view", () => {
  it("opens an exact surface in a script-only sandbox, reloads, and fails closed when revoked", async () => {
    const extension = readyExtension(EXTENSION_A, "Review");
    const surface = mainViewSurface(extension);
    const closeExtensionMainView = vi.fn(async () => true);
    const getExtensionMainViewSurface = vi.fn(async () => surface);
    const controller = controllerFor({
      getExtension: vi.fn(async () => catalog(extension)),
      openExtensionMainView: vi.fn(async () => surface),
      getExtensionMainViewSurface,
      closeExtensionMainView
    });
    const rendered = await renderMainView(controller, EXTENSION_A);

    const iframe = required(rendered.container.querySelector<HTMLIFrameElement>("iframe"));
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.src).toBe(`https://orchestrator.example${surface.endpoint}`);
    expect(iframe.hasAttribute("allow")).toBe(false);
    await act(async () => iframe.dispatchEvent(new Event("load")));
    expect(rendered.container.textContent).not.toContain("extensions.mainView.loadingContent");

    await act(async () => buttonWithLabel(rendered.container, "extensions.mainView.reload").click());
    await settle();
    expect(getExtensionMainViewSurface).toHaveBeenCalledWith(surface.id);
    expect(rendered.container.querySelector("iframe")).not.toBe(iframe);

    getExtensionMainViewSurface.mockRejectedValueOnce(new Error("revoked"));
    await act(async () => buttonWithLabel(rendered.container, "extensions.mainView.reload").click());
    await settle();
    expect(rendered.container.textContent).toContain("extensions.mainView.revoked");
    expect(rendered.container.querySelector("iframe")).toBeNull();
    expect(closeExtensionMainView).toHaveBeenCalledWith(surface.id);
  });

  it("closes a surface returned after its route request became stale", async () => {
    const extensionA = readyExtension(EXTENSION_A, "Review");
    const extensionB = readyExtension(EXTENSION_B, "Build");
    const surfaceA = mainViewSurface(extensionA);
    const surfaceB = mainViewSurface(extensionB);
    const pendingA = deferred<ExtensionMainViewSurfaceView>();
    const closeExtensionMainView = vi.fn(async () => true);
    const controller = controllerFor({
      getExtension: vi.fn(async (extensionId: string) => catalog(extensionId === EXTENSION_A ? extensionA : extensionB)),
      openExtensionMainView: vi.fn(async (extensionId: string) => extensionId === EXTENSION_A ? pendingA.promise : surfaceB),
      getExtensionMainViewSurface: vi.fn(async () => surfaceB),
      closeExtensionMainView
    });
    const rendered = await renderMainView(controller, EXTENSION_A);
    await rendered.rerender(EXTENSION_B);
    pendingA.resolve(surfaceA);
    await settle();

    expect(required(rendered.container.querySelector<HTMLIFrameElement>("iframe")).src)
      .toBe(`https://orchestrator.example${surfaceB.endpoint}`);
    expect(closeExtensionMainView).toHaveBeenCalledWith(surfaceA.id);
    expect(sameExtensionMainViewSurface(surfaceA, surfaceB)).toBe(false);
  });

  it("mediates a declared Library through one generation-fenced session without leaking its host path", async () => {
    const extension = { ...readyExtension(EXTENSION_A, "Review"), library: { schemaVersion: 1 as const } };
    const surface = mainViewSurface(extension);
    const opening = deferred<ExtensionLibrarySessionView>();
    const openExtensionLibrary = vi.fn(async () => opening.promise);
    const callExtensionLibrary = vi.fn(async (_sessionId: string, call: unknown) => ({
      kind: "read" as const,
      path: (call as { path: string }).path,
      content: new Uint8Array([4, 5]),
      sha256: "b".repeat(64)
    }));
    const closeExtensionLibrary = vi.fn(async () => true);
    const controller = controllerFor({
      getExtension: vi.fn(async () => catalog(extension)),
      openExtensionMainView: vi.fn(async () => surface),
      getExtensionMainViewSurface: vi.fn(async () => surface),
      closeExtensionMainView: vi.fn(async () => true),
      getExtensionLibraryOverview: vi.fn(async (): Promise<ExtensionLibraryOverviewView> => ({
        extensionId: extension.id,
        name: extension.name,
        state: "ready",
        location: { kind: "custom", path: "D:\\private\\library", generation: 3n },
        files: 1,
        bytes: 2n,
        diskFreeBytes: 9n,
        softLimitBytes: 8_589_934_592n,
        softLimitExceeded: false,
        orphaned: false,
        trashCount: 0,
        graceCount: 0
      })),
      openExtensionLibrary,
      callExtensionLibrary,
      closeExtensionLibrary
    });
    const rendered = await renderMainView(controller, EXTENSION_A);
    const frame = required(rendered.container.querySelector<HTMLIFrameElement>("iframe"));
    const target = required(frame.contentWindow);
    const postMessage = vi.spyOn(target, "postMessage").mockImplementation(() => undefined);

    dispatchBridge(frame, "status-1", { kind: "status" });
    dispatchBridge(frame, "read-1", { kind: "read", path: "notes/a.txt" });
    dispatchBridge(frame, "read-2", { kind: "read", path: "notes/b.txt" });
    dispatchBridge(frame, "ignored-origin", { kind: "open" }, "https://extension.invalid");
    window.dispatchEvent(new MessageEvent("message", {
      data: bridgeRequest("ignored-source", { kind: "open" }),
      origin: "null",
      source: window
    }));
    await settle();
    expect(openExtensionLibrary).toHaveBeenCalledTimes(1);
    expect(callExtensionLibrary).not.toHaveBeenCalled();

    const statusResponse = postedResponse(postMessage, "status-1");
    expect(statusResponse).toMatchObject({
      type: EXTENSION_LIBRARY_BRIDGE_RESPONSE,
      ok: true,
      result: { state: "ready", location: "custom", files: 1, bytes: 2n }
    });
    expect((statusResponse.result as Record<string, unknown>)["path"]).toBeUndefined();
    expect(postMessage.mock.calls.some(([value]) => (value as { id?: string }).id === "ignored-origin")).toBe(false);
    expect(postMessage.mock.calls.some(([value]) => (value as { id?: string }).id === "ignored-source")).toBe(false);

    opening.resolve(librarySession(extension.id));
    await settle();
    expect(callExtensionLibrary).toHaveBeenCalledTimes(2);
    expect(postedResponse(postMessage, "read-1")).toMatchObject({ ok: true, result: { kind: "read", path: "notes/a.txt" } });
    expect(postedResponse(postMessage, "read-2")).toMatchObject({ ok: true, result: { kind: "read", path: "notes/b.txt" } });

    dispatchBridge(frame, "open-1", { kind: "open" });
    await settle();
    expect(postedResponse(postMessage, "open-1")).toMatchObject({
      ok: true,
      result: { extensionId: extension.id, bindingGeneration: 3n }
    });
    expect((postedResponse(postMessage, "open-1").result as Record<string, unknown>)["id"]).toBeUndefined();
  });

  it("retires the Library session and suppresses a late frame response on reload", async () => {
    const extension = { ...readyExtension(EXTENSION_A, "Review"), library: { schemaVersion: 1 as const } };
    const surface = mainViewSurface(extension);
    const late = deferred<{ readonly kind: "stat"; readonly entry: never }>();
    const closeExtensionLibrary = vi.fn(async () => true);
    const controller = controllerFor({
      getExtension: vi.fn(async () => catalog(extension)),
      openExtensionMainView: vi.fn(async () => surface),
      getExtensionMainViewSurface: vi.fn(async () => surface),
      closeExtensionMainView: vi.fn(async () => true),
      openExtensionLibrary: vi.fn(async () => librarySession(extension.id)),
      callExtensionLibrary: vi.fn(async () => late.promise),
      closeExtensionLibrary
    });
    const rendered = await renderMainView(controller, EXTENSION_A);
    const frame = required(rendered.container.querySelector<HTMLIFrameElement>("iframe"));
    const postMessage = vi.spyOn(required(frame.contentWindow), "postMessage").mockImplementation(() => undefined);
    dispatchBridge(frame, "late-1", { kind: "stat", path: "art/output.png" });
    await settle();

    await act(async () => buttonWithLabel(rendered.container, "extensions.mainView.reload").click());
    await settle();
    expect(closeExtensionLibrary).toHaveBeenCalledWith("library_session_0123456789abcdef0123456789abcdef");
    late.resolve({ kind: "stat", entry: undefined as never });
    await settle();
    expect(postMessage.mock.calls.some(([value]) => (value as { id?: string }).id === "late-1")).toBe(false);
  });

  it("returns stable Library failure categories without exposing the service error text", async () => {
    const extension = { ...readyExtension(EXTENSION_A, "Review"), library: { schemaVersion: 1 as const } };
    const surface = mainViewSurface(extension);
    const controller = controllerFor({
      getExtension: vi.fn(async () => catalog(extension)),
      openExtensionMainView: vi.fn(async () => surface),
      getExtensionMainViewSurface: vi.fn(async () => surface),
      closeExtensionMainView: vi.fn(async () => true),
      openExtensionLibrary: vi.fn(async () => librarySession(extension.id)),
      closeExtensionLibrary: vi.fn(async () => true),
      callExtensionLibrary: vi.fn(async () => {
        throw new ConnectError("D:\\private\\library capacity details", Code.ResourceExhausted);
      })
    });
    const rendered = await renderMainView(controller, EXTENSION_A);
    const frame = required(rendered.container.querySelector<HTMLIFrameElement>("iframe"));
    const postMessage = vi.spyOn(required(frame.contentWindow), "postMessage").mockImplementation(() => undefined);

    dispatchBridge(frame, "limited-1", { kind: "read", path: "notes/a.txt" });
    await settle();

    expect(postedResponse(postMessage, "limited-1")).toMatchObject({
      ok: false,
      error: {
        code: "LIMIT_EXCEEDED",
        message: "Extension Library request exceeded a storage or result limit."
      }
    });
    expect(JSON.stringify(postedResponse(postMessage, "limited-1"))).not.toContain("private");
  });

  it("keeps reveal, save, and PNG clipboard gestures in the trusted parent and returns no host path", async () => {
    const reveal = vi.fn(async () => true);
    const beginSave = vi.fn(async () => ({ cancelled: false as const, ticketId: `extension_library_save_${"c".repeat(32)}` }));
    const commitSave = vi.fn(async () => 21);
    const cancelSave = vi.fn(async () => undefined);
    const clipboardWrite = vi.fn(async () => 4);
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: {
        capabilities: ["extension.libraryGestures"],
        extensionLibraries: { reveal, beginSave, commitSave, cancelSave, clipboardWrite, pickLocation: vi.fn() }
      }
    });
    const extension = { ...readyExtension(EXTENSION_A, "Review"), library: { schemaVersion: 1 as const } };
    const surface = mainViewSurface(extension);
    const callExtensionLibrary = vi.fn(async (_sessionId: string, call: { kind: string; path?: string }) => ({
      kind: "stat" as const,
      entry: { path: call.path!, kind: "file" as const, bytes: 21n, modifiedAt: 1_800_000_000_000 }
    }));
    const controller = controllerFor({
      getExtension: vi.fn(async () => catalog(extension)),
      openExtensionMainView: vi.fn(async () => surface),
      getExtensionMainViewSurface: vi.fn(async () => surface),
      closeExtensionMainView: vi.fn(async () => true),
      openExtensionLibrary: vi.fn(async () => librarySession(extension.id)),
      closeExtensionLibrary: vi.fn(async () => true),
      callExtensionLibrary,
      getExtensionLibraryOverview: vi.fn(async (): Promise<ExtensionLibraryOverviewView> => ({
        extensionId: extension.id,
        name: extension.name,
        state: "ready",
        location: { kind: "custom", path: "D:\\private\\library", generation: 3n },
        files: 1,
        bytes: 21n,
        softLimitBytes: 8_589_934_592n,
        softLimitExceeded: false,
        orphaned: false,
        trashCount: 0,
        graceCount: 0
      }))
    });
    const rendered = await renderMainView(controller, EXTENSION_A);
    const frame = required(rendered.container.querySelector<HTMLIFrameElement>("iframe"));
    const postMessage = vi.spyOn(required(frame.contentWindow), "postMessage").mockImplementation(() => undefined);

    dispatchBridge(frame, "capabilities-native", { kind: "capabilities" });
    dispatchBridge(frame, "reveal-native", { kind: "reveal", path: "exports/art.png" });
    dispatchBridge(frame, "save-native", { kind: "saveAs", path: "exports/art.png", name: "drawing.png" });
    dispatchBridge(frame, "clipboard-native", { kind: "clipboardWrite", content: new Uint8Array([1, 2, 3, 4]) });
    await settle();
    await settle();

    expect(postedResponse(postMessage, "capabilities-native")).toMatchObject({
      ok: true,
      result: { operations: expect.arrayContaining(["reveal", "saveAs", "clipboardWrite"]) }
    });
    expect(reveal).toHaveBeenCalledWith({
      extensionId: extension.id,
      root: "D:\\private\\library",
      path: "exports/art.png"
    });
    expect(beginSave).toHaveBeenCalledWith({ extensionId: extension.id, name: "drawing.png" });
    expect(commitSave).toHaveBeenCalledWith(expect.objectContaining({
      extensionId: extension.id,
      root: "D:\\private\\library",
      path: "exports/art.png"
    }));
    expect(clipboardWrite).toHaveBeenCalledWith({ extensionId: extension.id, bytes: new Uint8Array([1, 2, 3, 4]) });
    expect(cancelSave).not.toHaveBeenCalled();
    expect(postedResponse(postMessage, "reveal-native")).toMatchObject({ ok: true, result: { path: "exports/art.png" } });
    expect(postedResponse(postMessage, "save-native")).toMatchObject({
      ok: true, result: { cancelled: false, path: "exports/art.png", bytes: 21 }
    });
    expect(postedResponse(postMessage, "clipboard-native")).toMatchObject({ ok: true, result: { bytes: 4 } });
    for (const id of ["reveal-native", "save-native", "clipboard-native"]) {
      expect(JSON.stringify(postedResponse(postMessage, id))).not.toContain("private");
    }
  });
});

function controllerFor(methods: Partial<AppController>): AppController {
  return {
    state: { activeProfile: { origin: "https://orchestrator.example/" } },
    navigate: vi.fn(),
    ...methods
  } as unknown as AppController;
}

async function renderMainView(controller: AppController, extensionId: string): Promise<{
  readonly container: HTMLDivElement;
  readonly rerender: (nextExtensionId: string) => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = async (nextExtensionId: string): Promise<void> => {
    await act(async () => root.render(<ExtensionMainViewPage
      controller={controller}
      extensionId={nextExtensionId}
      t={(key) => key}
      navigationOpen
      onOpenNavigation={() => undefined}
      onOpenIndependent={() => undefined}
    />));
    await settle();
  };
  await render(extensionId);
  return { container, rerender: render };
}

function readyExtension(id: string, name: string): ExtensionCatalogEntryView {
  return {
    id,
    revision: 7n,
    owner: { kind: "resource", resourceId: `resource-${id}`, discoveredRevision: `sha256:${id}`, resourceRevision: 4n },
    source: "local",
    installed: true,
    installState: "installed",
    name,
    description: `${name} surface`,
    enabled: true,
    mainView: { title: name, icon: "layout" },
    sidebarSupported: true,
    sidebarVisible: true,
    tools: [],
    permissions: [],
    commands: [],
    setup: { state: "ready", attemptId: `attempt-${id}`, revision: 2n, fields: [] },
    useSupported: false
  };
}

function mainViewSurface(extension: ExtensionCatalogEntryView): ExtensionMainViewSurfaceView {
  if (extension.owner.kind !== "resource") throw new Error("Expected a Resource-owned Extension.");
  const suffix = extension.id.slice("extension_".length);
  return {
    id: `extension_surface_${suffix}`,
    extensionId: extension.id,
    owner: extension.owner,
    backendId: "backend-1",
    backendRevision: 3n,
    backendGeneration: 5,
    endpoint: `/v1/extensions/main-views/extension_surface_${suffix}/${"a".repeat(64)}/index.html`,
    title: extension.name,
    icon: "layout",
    expiresAt: Date.UTC(2026, 8, 14, 2)
  };
}

function catalog(extension: ExtensionCatalogEntryView) {
  return { revision: 11n, extensions: [extension], recoveredFromCorruption: false };
}

function librarySession(extensionId: string): ExtensionLibrarySessionView {
  return {
    id: "library_session_0123456789abcdef0123456789abcdef",
    extensionId,
    expiresAt: Date.UTC(2026, 8, 14, 3),
    bindingGeneration: 3n,
    limits: {
      maximumReadBytes: 16_777_216n,
      maximumWriteBytes: 16_777_216n,
      maximumStreamBytes: 8_589_934_592n,
      maximumPathCharacters: 512,
      maximumPathSegments: 32,
      maximumListPageSize: 500,
      maximumFiles: 50_000,
      softLimitBytes: 8_589_934_592n,
      diskReserveBytes: 1_073_741_824n
    }
  };
}

function bridgeRequest(id: string, operation: unknown) {
  return { type: EXTENSION_LIBRARY_BRIDGE_REQUEST, version: 1, id, operation };
}

function dispatchBridge(frame: HTMLIFrameElement, id: string, operation: unknown, origin = "null"): void {
  window.dispatchEvent(new MessageEvent("message", {
    data: bridgeRequest(id, operation),
    origin,
    source: required(frame.contentWindow)
  }));
}

function postedResponse(
  postMessage: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } },
  id: string
): Record<string, unknown> {
  const value = postMessage.mock.calls.map((call) => call[0])
    .find((message: unknown) => (message as { id?: string }).id === id);
  return required(value) as Record<string, unknown>;
}

function buttonWithLabel(container: ParentNode, label: string): HTMLButtonElement {
  return required(container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`));
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected rendered value.");
  return value;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
