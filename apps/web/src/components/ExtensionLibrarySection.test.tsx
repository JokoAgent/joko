// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import type { ExtensionCatalogEntryView, ExtensionLibraryOverviewView } from "../model.js";
import { ExtensionLibrarySection } from "./ExtensionLibrarySection.js";

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

describe("ExtensionLibrarySection", () => {
  it("shows verified usage and requires location validation plus a visible cloud warning before relocation", async () => {
    const extension = libraryExtension("a", "Canvas");
    const validate = vi.fn(async () => ({
      libraryRoot: `D:\\OneDrive\\Libraries\\${extension.id}`,
      warnings: ["cloud_sync_location"],
      diskFreeBytes: 40n * 1024n * 1024n * 1024n
    }));
    const relocate = vi.fn(async () => ({
      changed: true,
      migrationId: "library_migration_1",
      location: { kind: "custom" as const, path: `D:\\OneDrive\\Libraries\\${extension.id}`, generation: 2n },
      files: 3,
      bytes: 1536n,
      warnings: ["cloud_sync_location"],
      graceId: "library_grace_1"
    }));
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: {
        capabilities: ["extension.libraryLocationPicker"],
        extensionLibraries: { pickLocation: vi.fn(async () => ({ cancelled: false, path: "D:\\OneDrive\\Libraries" })) }
      }
    });
    const { container } = await render(extension, {
      getExtensionLibraryOverview: vi.fn(async () => overview(extension, { location: { kind: "default", path: `D:\\Joko\\${extension.id}`, generation: 1n } })),
      listExtensionLibraryTrash: vi.fn(async () => []),
      listExtensionLibraryGrace: vi.fn(async () => []),
      validateExtensionLibraryLocation: validate,
      relocateExtensionLibrary: relocate
    });

    expect(container.textContent).toContain("1.5 KiB");
    expect(container.textContent).toContain("3 files");
    await act(async () => button(container, "Move Library").click());
    await act(async () => button(document.body, "Browse").click());
    await settle();
    const input = document.body.querySelector<HTMLInputElement>('.extension-library-dialog input');
    if (input === null) throw new Error("Location input was not rendered.");
    expect(input.value).toBe("D:\\OneDrive\\Libraries");
    expect(button(document.body, "Confirm move").disabled).toBe(true);

    await act(async () => button(document.body, "Check location").click());
    await settle();
    expect(validate).toHaveBeenCalledWith(extension.id, 7n, "D:\\OneDrive\\Libraries", expect.any(AbortSignal));
    expect(document.body.textContent).toContain("Cloud-synced location");
    expect(document.body.textContent).toContain(`D:\\OneDrive\\Libraries\\${extension.id}`);
    await act(async () => button(document.body, "Confirm move").click());
    await settle();
    expect(relocate).toHaveBeenCalledWith(extension.id, 7n, { kind: "custom", candidate: "D:\\OneDrive\\Libraries" }, expect.any(AbortSignal));
  });

  it("makes detach non-destructive and gates Library deletion on the exact extension name", async () => {
    const extension = libraryExtension("b", "Sketchbook");
    const unbind = vi.fn(async () => ({ detachedPath: "E:\\Sketches" }));
    const trash = vi.fn(async () => ({
      id: "trash-1", extensionId: extension.id, name: extension.name,
      deletedAt: Date.UTC(2026, 8, 14), expiresAt: Date.UTC(2026, 9, 14), files: 9, bytes: 4096n
    }));
    const getOverview = vi.fn()
      .mockResolvedValueOnce(overview(extension, {
        state: "unavailable",
        unavailableReason: "diskMissing",
        location: { kind: "custom", path: "E:\\Sketches", generation: 4n },
        files: 9,
        bytes: 4096n
      }))
      .mockResolvedValue(overview(extension, {
        location: { kind: "custom", path: "E:\\Sketches", generation: 5n }, files: 9, bytes: 4096n
      }));
    const { container } = await render(extension, {
      getExtensionLibraryOverview: getOverview,
      listExtensionLibraryTrash: vi.fn(async () => []),
      listExtensionLibraryGrace: vi.fn(async () => []),
      unbindExtensionLibrary: unbind,
      trashExtensionLibrary: trash
    });

    expect(container.textContent).toContain("bound disk or folder is missing");
    await act(async () => button(container, "Detach binding").click());
    expect(document.body.textContent).toContain("No files will be moved or deleted");
    await act(async () => button(requiredDialog(), "Detach binding").click());
    await settle();
    expect(unbind).toHaveBeenCalledWith(extension.id, extension.revision, expect.any(AbortSignal));

    await act(async () => button(container, "Delete Library").click());
    expect(document.body.textContent).toContain("9 files, 4.0 KiB");
    const deleteDialog = requiredDialog();
    const name = deleteDialog.querySelector<HTMLInputElement>('.extension-library-dialog input');
    if (name === null) throw new Error("Confirmation input was not rendered.");
    await act(async () => setValue(name, "wrong"));
    expect(button(deleteDialog, "Delete Library").disabled).toBe(true);
    await act(async () => setValue(name, extension.name));
    await act(async () => button(deleteDialog, "Delete Library").click());
    await settle();
    expect(trash).toHaveBeenCalledWith(extension.id, extension.revision, extension.name, expect.any(AbortSignal));
  });

  it("isolates late state from a previously selected extension and keeps source-owned recovery visible", async () => {
    const first = libraryExtension("c", "First");
    const second = { ...libraryExtension("d", "Second"), owner: {
      kind: "source" as const,
      sourceId: `extension_source_${"d".repeat(32)}`,
      sourceRevision: 1n,
      entryId: `extension_source_entry_${"d".repeat(32)}`,
      contentRevision: `sha256:${"d".repeat(64)}`
    }, installed: false, enabled: false, installState: "available" as const };
    const pending = deferred<ExtensionLibraryOverviewView>();
    const getOverview = vi.fn(() => pending.promise);
    const listTrash = vi.fn(async (extensionId?: string) => extensionId === second.id ? [{
      id: "trash-second", extensionId: second.id, name: second.name,
      deletedAt: Date.UTC(2026, 8, 1), expiresAt: Date.UTC(2026, 9, 1), files: 2, bytes: 32n
    }] : []);
    const controller = createController({
      getExtensionLibraryOverview: getOverview,
      listExtensionLibraryTrash: listTrash,
      listExtensionLibraryGrace: vi.fn(async () => [])
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(view(controller, first)));
    await act(async () => root.render(view(controller, second)));
    await settle();
    expect(container.textContent).toContain("Library access is paused");
    expect(container.textContent).toContain("Recently deleted");
    expect(container.textContent).toContain("Second");
    expect(getOverview).toHaveBeenCalledTimes(1);

    pending.resolve(overview(first, { location: { kind: "custom", path: "Z:\\late", generation: 1n } }));
    await settle();
    expect(container.textContent).not.toContain("Z:\\late");
    expect(container.textContent).toContain("Second");
  });

  it("restores a recoverable copy to the Joko-managed default only after exact-name confirmation", async () => {
    const extension = libraryExtension("e", "Archive");
    const entry = {
      id: "trash-archive",
      extensionId: extension.id,
      name: extension.name,
      deletedAt: Date.UTC(2026, 8, 1),
      expiresAt: Date.UTC(2026, 9, 1),
      files: 4,
      bytes: 2048n
    };
    const restore = vi.fn(async () => ({
      extensionId: extension.id,
      location: { kind: "default" as const, path: `D:\\Joko\\${extension.id}`, generation: 3n }
    }));
    const { container } = await render(extension, {
      getExtensionLibraryOverview: vi.fn(async () => overview(extension)),
      listExtensionLibraryTrash: vi.fn(async () => [entry]),
      listExtensionLibraryGrace: vi.fn(async () => []),
      restoreExtensionLibraryTrash: restore
    });

    await act(async () => button(container, "Restore").click());
    const dialog = requiredDialog();
    expect(dialog.textContent).toContain("Existing data is never overwritten");
    const defaultChoice = [...dialog.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("Joko-managed default location"))
      ?.querySelector<HTMLInputElement>('input[type="radio"]');
    if (defaultChoice === undefined || defaultChoice === null) throw new Error("Default restore location was not rendered.");
    await act(async () => defaultChoice.click());
    const name = dialog.querySelector<HTMLInputElement>('.extension-library-dialog > label input');
    if (name === null) throw new Error("Restore confirmation input was not rendered.");
    await act(async () => setValue(name, extension.name));
    await act(async () => button(dialog, "Restore").click());
    await settle();

    expect(restore).toHaveBeenCalledWith(entry.id, extension.name, { kind: "default" }, expect.any(AbortSignal));
  });

  it("confirms relocation rollback and permanently deletes only the exact named recovery copy", async () => {
    const extension = libraryExtension("f", "Workbench");
    const trash = {
      id: "trash-workbench",
      extensionId: extension.id,
      name: extension.name,
      deletedAt: Date.UTC(2026, 8, 1),
      expiresAt: Date.UTC(2026, 9, 1),
      files: 2,
      bytes: 128n
    };
    const grace = {
      id: "grace-workbench",
      extensionId: extension.id,
      name: extension.name,
      createdAt: Date.UTC(2026, 8, 2),
      expiresAt: Date.UTC(2026, 8, 16),
      files: 3,
      bytes: 256n
    };
    const rollback = vi.fn(async () => ({
      location: { kind: "default" as const, path: `D:\\Joko\\${extension.id}`, generation: 4n },
      graceId: "grace-current"
    }));
    const purge = vi.fn(async () => true);
    const { container } = await render(extension, {
      getExtensionLibraryOverview: vi.fn(async () => overview(extension, {
        location: { kind: "custom", path: `E:\\Libraries\\${extension.id}`, generation: 3n },
        trashCount: 1,
        graceCount: 1
      })),
      listExtensionLibraryTrash: vi.fn(async () => [trash]),
      listExtensionLibraryGrace: vi.fn(async () => [grace]),
      rollbackExtensionLibrary: rollback,
      purgeExtensionLibraryTrash: purge
    });

    await act(async () => button(container, "Roll back").click());
    expect(requiredDialog().textContent).toContain("current location becomes a new 14-day recovery copy");
    await act(async () => button(requiredDialog(), "Roll back").click());
    await settle();
    expect(rollback).toHaveBeenCalledWith(extension.id, extension.revision, grace.id, expect.any(AbortSignal));

    await act(async () => button(container, "Delete now").click());
    const dialog = requiredDialog();
    const confirmation = dialog.querySelector<HTMLInputElement>("input");
    if (confirmation === null) throw new Error("Purge confirmation input was not rendered.");
    await act(async () => setValue(confirmation, "wrong"));
    expect(button(dialog, "Delete now").disabled).toBe(true);
    await act(async () => setValue(confirmation, extension.name));
    await act(async () => button(dialog, "Delete now").click());
    await settle();
    expect(purge).toHaveBeenCalledWith(trash.id, extension.name, expect.any(AbortSignal));
  });
});

async function render(extension: ExtensionCatalogEntryView, overrides: Partial<AppController>): Promise<{ readonly container: HTMLDivElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const controller = createController(overrides);
  await act(async () => root.render(view(controller, extension)));
  await settle();
  return { container };
}

function view(controller: AppController, extension: ExtensionCatalogEntryView) {
  return <ExtensionLibrarySection controller={controller} extension={extension} locale="en" disabled={false} t={(key, values) => translate("en", key, values)} />;
}

function createController(overrides: Partial<AppController>): AppController {
  return { state: { preferences: { navigationOpen: true } }, ...overrides } as unknown as AppController;
}

function libraryExtension(seed: string, name: string): ExtensionCatalogEntryView {
  return {
    id: `extension_${seed.repeat(32)}`,
    revision: 7n,
    owner: { kind: "resource", resourceId: `resource-${seed}`, discoveredRevision: `sha256:${seed.repeat(64)}`, resourceRevision: 4n },
    source: "local",
    installed: true,
    installState: "installed",
    name,
    version: "1.0.0",
    description: "Private extension data",
    enabled: true,
    sidebarSupported: false,
    sidebarVisible: false,
    tools: [], permissions: [], commands: [],
    setup: { state: "ready", revision: 2n, fields: [] },
    useSupported: false,
    library: { schemaVersion: 1 }
  };
}

function overview(extension: ExtensionCatalogEntryView, overrides: Partial<ExtensionLibraryOverviewView> = {}): ExtensionLibraryOverviewView {
  return {
    extensionId: extension.id,
    name: extension.name,
    state: "ready",
    files: 3,
    bytes: 1536n,
    diskFreeBytes: 40n * 1024n * 1024n * 1024n,
    softLimitBytes: 8n * 1024n * 1024n * 1024n,
    softLimitExceeded: false,
    orphaned: false,
    trashCount: 0,
    graceCount: 0,
    ...overrides
  };
}

function button(container: ParentNode, text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Button not found: ${text}`);
  return match;
}

function requiredDialog(): HTMLElement {
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
  if (dialog === null) throw new Error("Dialog was not rendered.");
  return dialog;
}

function setValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
