// @vitest-environment jsdom

import { StrictMode } from "react";
import { act } from "react";
import type { JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { plainTextToComposerDocument } from "../composer-quote-document.js";
import type { AppController, ControllerState } from "../controller.js";
import { serializeExtensionSuggestionOwner } from "../extension-suggestion-handoff.js";
import { emptySnapshot, type AppSnapshot, type ExtensionCatalogEntryView, type PendingExtensionSuggestionView } from "../model.js";
import { newSessionSuggestionContext } from "../new-session-suggestion-context.js";
import {
  extensionSuggestionContinuationStage,
  extensionSuggestionNewSessionRoute,
  useExtensionSuggestionContinuation
} from "./use-extension-suggestion-continuation.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Extension suggestion continuation", () => {
  it("classifies only an exact Extension that belongs to the original backend and target", () => {
    const { extension, pending, snapshot } = fixture();
    expect(extensionSuggestionContinuationStage(pending, extension, snapshot)).toBe("enable");
    expect(extensionSuggestionContinuationStage(pending, {
      ...extension,
      owner: { ...extension.owner, discoveredRevision: "sha256:foreign" }
    } as ExtensionCatalogEntryView, snapshot)).toBeUndefined();
    expect(extensionSuggestionContinuationStage(pending, extension, {
      ...snapshot,
      resources: snapshot.resources.map((resource) => ({ ...resource, backendId: "foreign-backend" }))
    })).toBeUndefined();

    const needsSetup: ExtensionCatalogEntryView = {
      ...extension,
      enabled: true,
      setup: { state: "required", revision: 0n, fields: [] }
    };
    expect(extensionSuggestionContinuationStage(pending, needsSetup, snapshot)).toBe("setup");
    const ready = { ...extension, enabled: true };
    expect(extensionSuggestionContinuationStage({ ...pending, phase: "ready" }, ready, snapshot)).toBe("ready");

    const source = sourceExtension(extension);
    const sourcePending = { ...pending, owner: serializeExtensionSuggestionOwner(source.owner), extensionRevision: source.revision.toString(10) };
    expect(extensionSuggestionContinuationStage(sourcePending, source, { ...snapshot, resources: [] })).toBe("install");
  });

  it("keeps a transient read failure retryable without clearing the handoff", async () => {
    const setup = fixture();
    const readPendingExtensionSuggestion = vi.fn<AppController["readPendingExtensionSuggestion"]>()
      .mockRejectedValueOnce(new Error("Temporary local read failure"))
      .mockResolvedValue(setup.pending);
    const compareAndSetPendingExtensionSuggestion = vi.fn(async () => true);
    const controller = continuationController(setup, {
      readPendingExtensionSuggestion,
      compareAndSetPendingExtensionSuggestion
    });
    let latest: ReturnType<typeof useExtensionSuggestionContinuation> | undefined;
    await renderHarness(controller, setup.snapshot, setup.pending, (value) => { latest = value; });

    expect(latest?.state.stage).toBe("error");
    expect(latest?.state.error).toBe("Temporary local read failure");
    expect(compareAndSetPendingExtensionSuggestion).not.toHaveBeenCalled();
    await act(async () => { latest?.retry(); await settle(); });
    expect(latest?.state.stage).toBe("enable");
    expect(readPendingExtensionSuggestion).toHaveBeenCalledTimes(2);
    expect(compareAndSetPendingExtensionSuggestion).not.toHaveBeenCalled();
  });

  it("advances only with explicit mutation proof and preserves the ready slot for one-shot return", async () => {
    const setup = fixture();
    let stored: PendingExtensionSuggestionView | undefined = setup.pending;
    const compareAndSetPendingExtensionSuggestion = vi.fn(async (expected: PendingExtensionSuggestionView, next?: PendingExtensionSuggestionView) => {
      if (stored !== expected) return false;
      stored = next;
      return true;
    });
    const navigate = vi.fn();
    const controller = continuationController(setup, { compareAndSetPendingExtensionSuggestion, navigate });
    let latest: ReturnType<typeof useExtensionSuggestionContinuation> | undefined;
    const root = await renderHarness(controller, setup.snapshot, setup.pending, (value) => { latest = value; });
    const enabled: ExtensionCatalogEntryView = { ...setup.extension, revision: 8n, enabled: true };

    await act(async () => {
      await latest?.advanceAfterMutation(
        setup.pending,
        { kind: "catalogMutation", previous: setup.extension },
        async () => enabled
      );
      await settle();
    });
    expect(latest?.state.stage).toBe("ready");
    expect(stored).toEqual(expect.objectContaining({ phase: "ready", extensionRevision: "8" }));
    latest?.continueToNewTask();
    expect(navigate).toHaveBeenCalledWith({
      kind: "newSession",
      targetId: "target-1",
      recommendationNonce: setup.pending.nonce
    });
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    await settle();
    expect(compareAndSetPendingExtensionSuggestion).toHaveBeenCalledTimes(1);
  });

  it("does not clear during StrictMode replay, but clears the exact slot when Tools really unmounts", async () => {
    const setup = fixture();
    const compareAndSetPendingExtensionSuggestion = vi.fn(async () => true);
    const controller = continuationController(setup, { compareAndSetPendingExtensionSuggestion });
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(<StrictMode><Harness controller={controller} snapshot={setup.snapshot} pending={setup.pending} onValue={() => undefined} /></StrictMode>);
      await settle();
    });
    expect(compareAndSetPendingExtensionSuggestion).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    await settle();
    expect(compareAndSetPendingExtensionSuggestion).toHaveBeenCalledTimes(1);
    expect(compareAndSetPendingExtensionSuggestion).toHaveBeenCalledWith(setup.pending);
  });

  it("drops a delayed catalog result after Tools leaves instead of advancing through the new owner", async () => {
    const setup = fixture();
    const compareAndSetPendingExtensionSuggestion = vi.fn(async () => true);
    const controller = continuationController(setup, { compareAndSetPendingExtensionSuggestion });
    let latest: ReturnType<typeof useExtensionSuggestionContinuation> | undefined;
    const root = await renderHarness(controller, setup.snapshot, setup.pending, (value) => { latest = value; });
    let resolveLoad: ((extension: ExtensionCatalogEntryView) => void) | undefined;
    const load = new Promise<ExtensionCatalogEntryView>((resolve) => { resolveLoad = resolve; });
    const operation = latest?.advanceAfterMutation(
      setup.pending,
      { kind: "catalogMutation", previous: setup.extension },
      async () => load
    );

    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    await settle();
    resolveLoad?.({ ...setup.extension, revision: 8n, enabled: true });
    await operation;
    await settle();

    expect(compareAndSetPendingExtensionSuggestion).toHaveBeenCalledTimes(1);
    expect(compareAndSetPendingExtensionSuggestion).toHaveBeenCalledWith(setup.pending);
  });

  it("CAS-clears cancellation before returning to the frozen task draft", async () => {
    const setup = fixture();
    const compareAndSetPendingExtensionSuggestion = vi.fn(async () => true);
    const navigate = vi.fn();
    const controller = continuationController(setup, { compareAndSetPendingExtensionSuggestion, navigate });
    let latest: ReturnType<typeof useExtensionSuggestionContinuation> | undefined;
    await renderHarness(controller, setup.snapshot, setup.pending, (value) => { latest = value; });

    await act(async () => { latest?.cancel(); await settle(); });
    expect(compareAndSetPendingExtensionSuggestion).toHaveBeenCalledWith(setup.pending);
    expect(navigate).toHaveBeenCalledWith({ kind: "newSession", targetId: "target-1" });
  });

  it("returns cancellation to the frozen dialogue selection without a continuation nonce", () => {
    const { pending } = fixture();
    expect(extensionSuggestionNewSessionRoute({
      ...pending,
      draft: { ...pending.draft, selection: { kind: "dialogue", backendId: "dialogue-backend" } }
    })).toEqual({ kind: "newSession", dialogueBackendId: "dialogue-backend" });
  });
});

function Harness({ controller, snapshot, pending, onValue }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly pending: PendingExtensionSuggestionView;
  readonly onValue: (value: ReturnType<typeof useExtensionSuggestionContinuation>) => void;
}): JSX.Element {
  const value = useExtensionSuggestionContinuation({
    controller,
    snapshot,
    nonce: pending.nonce,
    selectedId: pending.extensionId
  });
  onValue(value);
  return <output data-stage={value.state.stage}>{value.state.error}</output>;
}

async function renderHarness(
  controller: AppController,
  snapshot: AppSnapshot,
  pending: PendingExtensionSuggestionView,
  onValue: (value: ReturnType<typeof useExtensionSuggestionContinuation>) => void
): Promise<Root> {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<Harness controller={controller} snapshot={snapshot} pending={pending} onValue={onValue} />);
    await settle();
  });
  return root;
}

function fixture(): {
  readonly extension: ExtensionCatalogEntryView;
  readonly pending: PendingExtensionSuggestionView;
  readonly snapshot: AppSnapshot;
  readonly state: ControllerState;
} {
  const recommendation = { id: "review-mail", label: "Review mail", prompt: "Review the inbox." } as const;
  const extension: ExtensionCatalogEntryView = {
    id: "extension_0123456789abcdef0123456789abcdef",
    revision: 7n,
    owner: { kind: "resource", resourceId: "resource-1", discoveredRevision: "sha256:resource", resourceRevision: 4n },
    source: "local",
    installed: true,
    installState: "installed",
    name: "Mail tools",
    description: "Review messages",
    enabled: false,
    sidebarSupported: false,
    sidebarVisible: false,
    tools: [],
    permissions: [],
    commands: [],
    recommendations: [recommendation],
    setup: { state: "notRequired", revision: 0n, fields: [] },
    useSupported: false
  };
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    generation: 7n,
    backends: [{
      id: "backend-1",
      name: "Backend",
      version: "1.0.0",
      instanceGeneration: 2,
      health: "healthy",
      installationState: "installed",
      capabilities: new Map([["input.text", { name: "input.text", supported: true, options: [] }]])
    }],
    targets: [{
      id: "target-1",
      revision: 3n,
      backendId: "backend-1",
      name: "Project",
      workspaceId: "workspace-1",
      workspaceName: "Project",
      trusted: true,
      pinned: false,
      archived: false
    }],
    resources: [{
      id: "resource-1",
      backendId: "backend-1",
      targetId: "target-1",
      name: "Mail tools",
      kind: "extension",
      scope: "project",
      state: "loaded",
      enabled: true,
      source: "local",
      discoveredRevision: "sha256:resource",
      compatibilityDetails: [],
      runtimeRequirements: [],
      warnings: [],
      disabledLifecycleScripts: [],
      canToggle: true,
      requiresExtensionApproval: false,
      postMutationNotice: false
    }]
  };
  const state = {
    activeProfile: { id: "profile", serverId: "server", deviceId: "device", name: "Node", origin: "http://node" },
    connectionState: "connected",
    connectionGeneration: 4,
    snapshot,
    route: { kind: "tools" },
    preferences: { navigationOpen: true }
  } as unknown as ControllerState;
  const draft = {
    selection: { kind: "target", targetId: "target-1" } as const,
    nativeStart: { kind: "fresh" } as const,
    providerId: "provider",
    modelId: "model",
    fastMode: false,
    permissionMode: "ask" as const,
    planMode: false,
    text: "Original draft",
    editorDocument: plainTextToComposerDocument("Original draft"),
    mentions: [],
    attachments: []
  };
  const contextController = { state } as AppController;
  const pending: PendingExtensionSuggestionView = {
    nonce: "01234567-89ab-4cde-8fab-0123456789ab",
    phase: "setup",
    extensionId: extension.id,
    extensionRevision: extension.revision.toString(10),
    owner: serializeExtensionSuggestionOwner(extension.owner),
    recommendation,
    selectedLabel: recommendation.label,
    selectedPrompt: recommendation.prompt,
    contextKey: newSessionSuggestionContext(contextController, snapshot, draft.selection)!,
    draft,
    backendId: "backend-1",
    targetId: "target-1"
  };
  return { extension, pending, snapshot, state };
}

function sourceExtension(base: ExtensionCatalogEntryView): ExtensionCatalogEntryView {
  return {
    ...base,
    revision: 4n,
    owner: {
      kind: "source",
      sourceId: "extension_source_0123456789abcdef0123456789abcdef",
      sourceRevision: 3n,
      entryId: "extension_source_entry_0123456789abcdef0123456789abcdef",
      contentRevision: `sha256:${"a".repeat(64)}`
    },
    installed: false,
    installState: "available",
    enabled: false
  };
}

function continuationController(
  setup: ReturnType<typeof fixture>,
  overrides: Partial<AppController> = {}
): AppController {
  return {
    state: setup.state,
    readPendingExtensionSuggestion: vi.fn(async () => setup.pending),
    compareAndSetPendingExtensionSuggestion: vi.fn(async () => true),
    getExtension: vi.fn(async () => ({ revision: setup.extension.revision, extensions: [setup.extension], recoveredFromCorruption: false })),
    navigate: vi.fn(),
    ...overrides
  } as unknown as AppController;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}
