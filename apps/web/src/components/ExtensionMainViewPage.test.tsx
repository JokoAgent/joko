// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import type { ExtensionCatalogEntryView, ExtensionMainViewSurfaceView } from "../model.js";
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
