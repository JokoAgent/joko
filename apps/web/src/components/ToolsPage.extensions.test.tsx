// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot, type ExtensionCatalogEntryView, type ExtensionCatalogView, type ExtensionSourceCatalogView } from "../model.js";
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
});

async function renderExtensions(input: {
  readonly extension: ExtensionCatalogEntryView;
  readonly controller: Partial<AppController>;
}): Promise<{ readonly container: HTMLDivElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const snapshot = {
    ...emptySnapshot(),
    extensionCatalogRevision: 11n,
    extensions: [input.extension],
    resources: [{
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

function catalog(extension: ExtensionCatalogEntryView): ExtensionCatalogView {
  return { revision: 11n, extensions: [extension], recoveredFromCorruption: false };
}

function buttonWithText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (button === undefined) throw new Error(`Expected button ${text}.`);
  return button;
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
