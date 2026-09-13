// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import {
  emptySnapshot,
  type BackendView,
  type ExtensionCatalogEntryView,
  type ExtensionCatalogView,
  type ExtensionPackagePreviewView,
  type ExtensionSourceCatalogView,
  type ResourceView
} from "../model.js";
import { ToolsPage } from "./ToolsPage.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Extension catalog interactions", () => {
  it("carries an exact ready command into the delayed-create draft", async () => {
    const extension = readyExtension();
    const view = catalog(extension);
    const savePendingExtensionUse = vi.fn(async () => undefined);
    const navigate = vi.fn();
    const listExtensions = vi.fn(async () => view);
    const getExtension = vi.fn(async () => view);
    const { container } = await renderExtensions({
      extension,
      controller: {
        listExtensions,
        getExtension,
        savePendingExtensionUse,
        navigate
      }
    });

    expect(listExtensions).toHaveBeenCalledWith(expect.objectContaining({ installed: true, sessionId: "runtime-session" }));
    expect(getExtension).toHaveBeenCalledWith(extension.id, "runtime-session", expect.any(AbortSignal));
    await act(async () => buttonWithText(container, "Use").click());
    await settle();

    expect(savePendingExtensionUse).toHaveBeenCalledWith({
      extensionId: extension.id,
      extensionRevision: "7",
      commandName: "review",
      runtimeSessionId: "runtime-session",
      displayName: extension.name,
      owner: {
        kind: "resource",
        resourceId: "resource-1",
        discoveredRevision: "sha256:owner",
        resourceRevision: "4"
      }
    });
    expect(navigate).toHaveBeenCalledWith({ kind: "newSession", targetId: "target-1" });
  });

  it("gates Use on setup and sends secret fields only through the credential operation", async () => {
    let extension: ExtensionCatalogEntryView = {
      ...readyExtension(),
      revision: 7n,
      useSupported: false,
      setup: {
        state: "required" as const,
        revision: 0n,
        fields: [{
          id: "api-token",
          label: "API token",
          description: "Token used by the provider",
          kind: "secret" as const,
          required: true,
          configured: false,
          options: []
        }]
      }
    };
    const beginExtensionSetup = vi.fn(async () => {
      extension = {
        ...extension,
        revision: 8n,
        setup: { ...extension.setup, state: "inProgress", attemptId: "attempt-1", revision: 1n }
      };
    });
    const saveExtensionSetupCredential = vi.fn(async () => undefined);
    const submitExtensionSetupInteraction = vi.fn(async () => undefined);
    const savePendingExtensionUse = vi.fn(async () => undefined);
    const navigate = vi.fn();
    const { container } = await renderExtensions({
      extension,
      controller: {
        listExtensions: async () => catalog(extension),
        getExtension: async () => catalog(extension),
        beginExtensionSetup,
        saveExtensionSetupCredential,
        submitExtensionSetupInteraction,
        savePendingExtensionUse,
        navigate
      }
    });

    await act(async () => buttonWithText(container, "Configure to use").click());
    expect(savePendingExtensionUse).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => buttonWithText(document.body, "Begin setup").click());
    await settle();
    expect(beginExtensionSetup).toHaveBeenCalledWith(extension.id, 7n);

    const secret = document.body.querySelector<HTMLInputElement>('input[type="password"]');
    if (secret === null) throw new Error("Secret setup input was not rendered.");
    await act(async () => setNativeValue(secret, "private-token"));
    await act(async () => buttonWithText(document.body, "Save").click());
    await settle();

    expect(saveExtensionSetupCredential).toHaveBeenCalledWith(
      extension.id,
      "attempt-1",
      "api-token",
      "apiKey",
      "private-token",
      8n
    );
    expect(secret.value).toBe("");
    expect(submitExtensionSetupInteraction).not.toHaveBeenCalled();
  });

  it("keeps source-owned entries read-only and revision-fences source lifecycle actions", async () => {
    const extension: ExtensionCatalogEntryView = {
      ...readyExtension(),
      owner: {
        kind: "source",
        sourceId: "extension_source_0123456789abcdef0123456789abcdef",
        sourceRevision: 3n,
        entryId: "extension_source_entry_0123456789abcdef0123456789abcdef",
        contentRevision: `sha256:${"a".repeat(64)}`
      },
      source: "market",
      installed: false,
      installState: "available",
      enabled: false,
      sidebarSupported: false,
      sidebarVisible: false,
      commands: [],
      setup: { state: "notRequired", revision: 0n, fields: [] },
      useSupported: false
    };
    const sourceCatalog: ExtensionSourceCatalogView = {
      revision: 12n,
      recoveredFromCorruption: false,
      sources: [{
        id: "extension_source_0123456789abcdef0123456789abcdef",
        revision: 3n,
        kind: "local",
        location: { kind: "local", path: "D:\\trusted\\extensions" },
        name: "trusted-tools",
        displayName: "Trusted tools",
        state: "ready",
        contentRevision: `sha256:${"a".repeat(64)}`,
        discoveredExtensionCount: 1,
        declaredEntryCount: 1,
        skippedEntryCount: 0,
        unreadableEntryCount: 0,
        addedAt: Date.UTC(2026, 8, 13)
      }]
    };
    const listExtensionSources = vi.fn(async () => sourceCatalog);
    const getExtensionSourceGitPreflight = vi.fn(async () => ({ available: true, version: "2.51.0", minimumVersion: "2.25.0" }));
    const addExtensionSource = vi.fn(async () => undefined);
    const refreshExtensionSource = vi.fn(async () => undefined);
    const removeExtensionSource = vi.fn(async () => undefined);
    const setExtensionEnabled = vi.fn(async () => undefined);
    const { container } = await renderExtensions({
      extension,
      controller: {
        listExtensions: async () => catalog(extension),
        getExtension: async () => catalog(extension),
        listExtensionSources,
        getExtensionSourceGitPreflight,
        addExtensionSource,
        refreshExtensionSource,
        removeExtensionSource,
        setExtensionEnabled
      }
    });

    expect(container.textContent).toContain("Available from a source");
    expect(container.textContent).toContain("Source catalog");
    expect(container.querySelector('.extension-detail__settings input[type="checkbox"]')).toBeNull();
    expect(setExtensionEnabled).not.toHaveBeenCalled();

    await act(async () => buttonWithText(container, "Manage sources").click());
    await settle();
    expect(listExtensionSources).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(getExtensionSourceGitPreflight).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(document.body.textContent).toContain("Trusted tools");

    await act(async () => buttonWithText(document.body, "Add source").click());
    const path = document.body.querySelector<HTMLInputElement>(".extension-source-editor input");
    if (path === null) throw new Error("Local source path input was not rendered.");
    await act(async () => setNativeValue(path, "D:\\more\\extensions"));
    await act(async () => buttonWithText(document.body, "Discover source").click());
    await settle();
    expect(addExtensionSource).toHaveBeenCalledWith({ kind: "local", path: "D:\\more\\extensions" }, 12n);

    await act(async () => buttonWithText(document.body, "Refresh").click());
    await settle();
    expect(refreshExtensionSource).toHaveBeenCalledWith(sourceCatalog.sources[0]?.id, 3n);

    await act(async () => buttonWithText(document.body, "Remove").click());
    const removeButtons = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .filter((button) => button.textContent?.trim() === "Remove");
    await act(async () => removeButtons.at(-1)?.click());
    await settle();
    expect(removeExtensionSource).toHaveBeenCalledWith(sourceCatalog.sources[0]?.id, 3n);
  });

  it("previews exact package facts before installing and reports the completed result", async () => {
    const source = sourceExtension();
    let current = source;
    const preview = packagePreview(source, "install", "resource-catalog");
    const getExtensionPackagePreview = vi.fn(async () => preview);
    const adoptExtensionPackage = vi.fn(async () => {
      current = {
        ...source,
        revision: 8n,
        owner: { kind: "resource", resourceId: "resource-catalog", discoveredRevision: `sha256:${"b".repeat(64)}`, resourceRevision: 1n },
        installed: true,
        installState: "installed",
        version: "2.0.0"
      };
    });
    const { container } = await renderExtensions({
      extension: source,
      controller: {
        listExtensions: async () => catalog(current),
        getExtension: async () => {
          if (current.owner.kind === "resource") throw new Error("detail refresh failed after commit");
          return catalog(current);
        },
        getExtensionPackagePreview,
        adoptExtensionPackage
      }
    });

    await act(async () => buttonWithText(container, "Install").click());
    await settle();
    const dialog = requiredDialog();
    expect(getExtensionPackagePreview).toHaveBeenCalledWith(source.id, 7n, "backend-1", expect.any(AbortSignal));
    expect(dialog.textContent).toContain("@sample/review");
    expect(dialog.textContent).toContain("2.0.0");
    expect(dialog.textContent).toContain("Lifecycle scripts were disabled");
    expect(dialog.textContent).toContain("postinstall");
    expect(dialog.textContent).toContain("@earendil-works/pi-coding-agent");

    await act(async () => buttonWithText(dialog, "Install").click());
    await settleMany();
    expect(adoptExtensionPackage).toHaveBeenCalledWith(preview, false);
    expect(dialog.textContent).toContain("The package operation completed");
  });

  it("requires explicit confirmation for a package source replacement", async () => {
    const extension: ExtensionCatalogEntryView = {
      ...readyExtension(),
      installState: "updateAvailable",
      update: { source: sourceOwner("b"), availableVersion: "2.0.0", sourceReplacement: true }
    };
    const preview: ExtensionPackagePreviewView = {
      ...packagePreview(extension, "replace", "resource-replacement"),
      currentResource: { resourceId: "resource-1", resourceRevision: 4n, name: "Review tools", sourceDisplay: "Original source" },
      sourceReplacement: true,
      preservesEnabled: true,
      installedVersion: "1.0.0"
    };
    const adoptExtensionPackage = vi.fn(async () => undefined);
    const { container } = await renderExtensions({
      extension,
      controller: {
        listExtensions: async () => catalog(extension),
        getExtension: async () => catalog(extension),
        getExtensionPackagePreview: vi.fn(async () => preview),
        adoptExtensionPackage
      }
    });

    await act(async () => buttonWithText(container, "Replace").click());
    await settle();
    const dialog = requiredDialog();
    const confirm = buttonWithText(dialog, "Replace");
    expect(confirm.disabled).toBe(true);
    expect(dialog.textContent).toContain("Original source");
    const checkbox = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (checkbox === null) throw new Error("Replacement confirmation was not rendered.");
    await act(async () => checkbox.click());
    expect(confirm.disabled).toBe(false);
    await act(async () => confirm.click());
    await settleMany();
    expect(adoptExtensionPackage).toHaveBeenCalledWith(preview, true);
  });

  it("revision-fences whole-package uninstall and keeps its result visible", async () => {
    const extension = readyExtension();
    const removeExtensionPackage = vi.fn(async () => undefined);
    const { container } = await renderExtensions({
      extension,
      controller: {
        listExtensions: async () => catalog(extension),
        getExtension: async () => catalog(extension),
        removeExtensionPackage
      }
    });

    await act(async () => buttonWithText(container, "Uninstall").click());
    const dialog = requiredDialog();
    expect(dialog.textContent).toContain("entire managed Resource package");
    await act(async () => buttonWithText(dialog, "Uninstall").click());
    await settleMany();
    expect(removeExtensionPackage).toHaveBeenCalledWith(extension.id, 7n);
    expect(dialog.textContent).toContain("Resource package was uninstalled");
  });

  it("deduplicates batch updates by Resource, skips source changes, and continues after a failure", async () => {
    const first = updateExtension("01", "resource-1", false);
    const duplicate = updateExtension("02", "resource-1", false);
    const second = updateExtension("03", "resource-2", false);
    const replacement = updateExtension("04", "resource-3", true);
    const extensions = [first, duplicate, second, replacement];
    const listExtensions = vi.fn(async () => ({ revision: 21n, extensions, recoveredFromCorruption: false }));
    const getExtensionPackagePreview = vi.fn(async (extensionId: string) => {
      const extension = extensions.find((candidate) => candidate.id === extensionId);
      if (extension === undefined || extension.owner.kind !== "resource") throw new Error("missing fixture");
      return packagePreview(extension, "update", extension.owner.resourceId);
    });
    const adoptExtensionPackage = vi.fn(async (preview: ExtensionPackagePreviewView) => {
      if (preview.resourceId === "resource-1") throw new Error("first package failed");
    });
    const { container } = await renderExtensions({
      extension: first,
      extensions,
      resources: [managedResource("resource-1"), managedResource("resource-2"), managedResource("resource-3")],
      controller: {
        listExtensions,
        getExtension: async () => ({ revision: 21n, extensions: [first], recoveredFromCorruption: false }),
        getExtensionPackagePreview,
        adoptExtensionPackage
      }
    });

    await act(async () => buttonWithText(container, "Update all").click());
    await settle();
    const dialog = requiredDialog();
    expect(dialog.querySelectorAll(".extension-package-batch__row")).toHaveLength(3);
    await act(async () => buttonWithText(dialog, "Update packages").click());
    await settleMany();

    expect(getExtensionPackagePreview).toHaveBeenCalledTimes(2);
    expect(adoptExtensionPackage).toHaveBeenCalledTimes(2);
    expect(adoptExtensionPackage.mock.calls.map(([preview]) => preview.resourceId)).toEqual(["resource-1", "resource-2"]);
    expect(dialog.textContent).toContain("first package failed");
    expect(dialog.textContent).toContain("Source changes require individual review");
    expect(dialog.textContent).toContain("1 updated, 1 failed, 1 skipped");
  });
});

async function renderExtensions(input: {
  readonly extension: ExtensionCatalogEntryView;
  readonly extensions?: readonly ExtensionCatalogEntryView[];
  readonly resources?: readonly ResourceView[];
  readonly backends?: readonly BackendView[];
  readonly controller: Partial<AppController>;
}): Promise<{ readonly container: HTMLDivElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const snapshot = {
    ...emptySnapshot(),
    extensionCatalogRevision: 11n,
    extensions: input.extensions ?? [input.extension],
    backends: input.backends ?? [packageBackend("backend-1")],
    resources: input.resources ?? [{
      id: "resource-1",
      backendId: "backend-1",
      targetId: "target-1",
      name: "Review tools",
      kind: "extension" as const,
      scope: "project" as const,
      state: "loaded" as const,
      enabled: true,
      source: "local",
      discoveredRevision: "sha256:owner",
      compatibilityDetails: [],
      runtimeRequirements: [],
      warnings: [],
      disabledLifecycleScripts: [],
      canToggle: true,
      requiresExtensionApproval: false,
      postMutationNotice: false
    }]
  };
  const controller = {
    state: { preferences: { navigationOpen: true } },
    ...input.controller
  } as unknown as AppController;
  await act(async () => root.render(<ToolsPage
    controller={controller}
    snapshot={snapshot}
    runtimeSessionId="runtime-session"
    selectedExtensionId={input.extension.id}
    locale="en"
    t={(key, values) => translate("en", key, values)}
    runAction={(_key, action) => { void action(); }}
    onSelectExtension={() => undefined}
    onOpenNavigation={() => undefined}
  />));
  await settle();
  return { container };
}

function packageBackend(id: string): BackendView {
  return {
    id,
    name: id === "backend-1" ? "Pi" : id,
    version: "0.84.4",
    health: "healthy",
    installationState: "installed",
    capabilities: new Map([["runtime.resources", {
      name: "runtime.resources",
      supported: true,
      options: ["package", "extension"],
      maximumItems: 1_000
    }]])
  };
}

function managedResource(id: string, backendId = "backend-1", version = "1.0.0"): ResourceView {
  return {
    id,
    backendId,
    name: id,
    version,
    kind: "package",
    scope: "managed",
    state: "loaded",
    enabled: true,
    source: "Review catalog",
    discoveredRevision: `sha256:${id}`,
    compatibilityDetails: [],
    runtimeRequirements: [],
    warnings: [],
    disabledLifecycleScripts: [],
    canToggle: true,
    requiresExtensionApproval: false,
    postMutationNotice: false
  };
}

function readyExtension(): ExtensionCatalogEntryView {
  return {
    id: "extension_0123456789abcdef0123456789abcdef",
    revision: 7n,
    owner: {
      kind: "resource",
      resourceId: "resource-1",
      discoveredRevision: "sha256:owner",
      resourceRevision: 4n
    },
    source: "local",
    installed: true,
    installState: "installed",
    name: "Review tools",
    version: "1.0.0",
    author: "Joko",
    description: "Review a change",
    enabled: true,
    sidebarSupported: true,
    sidebarVisible: true,
    tools: [],
    permissions: [],
    commands: [{ name: "review", description: "Review a change", sessionId: "runtime-session" }],
    setup: { state: "ready", attemptId: "ready-attempt", revision: 2n, fields: [] },
    useSupported: true
  };
}

function sourceOwner(seed = "a"): Extract<ExtensionCatalogEntryView["owner"], { readonly kind: "source" }> {
  return {
    kind: "source",
    sourceId: `extension_source_${seed.repeat(32)}`,
    sourceRevision: 3n,
    entryId: `extension_source_entry_${seed.repeat(32)}`,
    contentRevision: `sha256:${seed.repeat(64)}`
  };
}

function sourceExtension(): ExtensionCatalogEntryView {
  return {
    ...readyExtension(),
    owner: sourceOwner(),
    source: "market",
    installed: false,
    installState: "available",
    version: "2.0.0",
    enabled: false,
    sidebarSupported: false,
    sidebarVisible: false,
    commands: [],
    setup: { state: "notRequired", revision: 0n, fields: [] },
    useSupported: false
  };
}

function updateExtension(seed: string, resourceId: string, sourceReplacement: boolean): ExtensionCatalogEntryView {
  return {
    ...readyExtension(),
    id: `extension_${seed.padStart(32, "0")}`,
    owner: { kind: "resource", resourceId, discoveredRevision: `sha256:${resourceId}`, resourceRevision: 4n },
    name: `Package ${resourceId}`,
    installState: "updateAvailable",
    update: { source: sourceOwner(sourceReplacement ? "c" : "a"), availableVersion: "2.0.0", sourceReplacement }
  };
}

function packagePreview(
  extension: ExtensionCatalogEntryView,
  action: ExtensionPackagePreviewView["action"],
  resourceId: string
): ExtensionPackagePreviewView {
  const currentResource = extension.owner.kind !== "resource" || action === "install"
    ? undefined
    : {
        resourceId: extension.owner.resourceId,
        resourceRevision: extension.owner.resourceRevision,
        name: extension.name,
        sourceDisplay: "Review catalog"
      };
  return {
    extensionId: extension.id,
    extensionRevision: extension.revision,
    action,
    resourceId,
    backendId: "backend-1",
    packageName: "@sample/review",
    ...(currentResource === undefined ? {} : { currentResource, installedVersion: extension.version }),
    availableVersion: "2.0.0",
    sourceReplacement: action === "replace",
    preservesEnabled: action !== "install" && extension.enabled,
    compatibilityDetails: [{
      kind: "extension",
      name: "review",
      compatibility: "supported",
      issues: [],
      detectedApis: ["notify"],
      adaptedApis: ["notify"],
      unsupportedApis: []
    }],
    runtimeRequirements: [{
      packageName: "@earendil-works/pi-coding-agent",
      range: "^0.84.0",
      currentVersion: "0.84.4",
      status: "compatible"
    }],
    warnings: ["lifecycleScriptsDisabled"],
    disabledLifecycleScripts: ["postinstall"],
    canToggle: true
  };
}

function catalog(extension: ExtensionCatalogEntryView): ExtensionCatalogView {
  return { revision: 11n, extensions: [extension], recoveredFromCorruption: false };
}

function buttonWithText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (button === undefined) throw new Error(`Expected button ${text}.`);
  return button;
}

function requiredDialog(): HTMLElement {
  const dialogs = [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')];
  const dialog = dialogs.at(-1);
  if (dialog === undefined) throw new Error("Expected an open dialog.");
  return dialog;
}

function setNativeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("Native input setter is unavailable.");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

async function settleMany(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await settle();
}
