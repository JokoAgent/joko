// @vitest-environment jsdom

import type { JSONContent } from "@tiptap/core";
import { act, forwardRef, useImperativeHandle, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { composerDocumentPlainText, plainTextToComposerDocument } from "../composer-quote-document.js";
import type { AppController } from "../controller.js";
import { dispatchGamepadOwnedAction } from "../gamepad-actions.js";
import {
  emptySnapshot,
  type AppSnapshot,
  type ComposerDraft,
  type ComposerInlineMentionRange,
  type ExtensionCatalogEntryView,
  type ModelView,
  type NewSessionLocalDraft,
  type PendingExtensionUseView
} from "../model.js";
import type { DelayedNewSessionDraft } from "../new-session-flow.js";
import { NewSessionPage } from "./NewSessionPage.js";
import { SESSION_LINK_DRAG_MIME } from "./composer-internal-drop.js";

interface MockEditorProps {
  readonly document: JSONContent;
  readonly onDocumentChange: (
    document: JSONContent,
    isComposing: boolean,
    mapRanges: (ranges: readonly ComposerInlineMentionRange[]) => readonly ComposerInlineMentionRange[]
  ) => void;
  readonly onKeyDown: (event: KeyboardEvent, document: JSONContent) => boolean;
}

let editorProps: MockEditorProps | undefined;
let editorElement: HTMLDivElement | null = null;
const newSessionEditorHarness = vi.hoisted(() => ({ routeDropActions: [] as Array<Record<string, unknown>> }));

vi.mock("./ComposerRichTextEditor.js", () => ({
  ComposerRichTextEditor: forwardRef(function Editor(props: MockEditorProps, ref) {
    const elementRef = useRef<HTMLDivElement>(null);
    editorProps = props;
    useImperativeHandle(ref, () => ({
      focus: () => elementRef.current?.focus(),
      focusFromBlankSurface: () => elementRef.current?.focus(),
      insertRouteReference: vi.fn(),
      routeReferenceDrop: vi.fn((action: Record<string, unknown>) => {
        newSessionEditorHarness.routeDropActions.push(action);
        return true;
      }),
      editPastedText: vi.fn()
    }));
    return <div
      ref={(element) => { elementRef.current = element; editorElement = element; }}
      className="composer-rich-editor__content"
      aria-label="Draft"
      contentEditable
      suppressContentEditableWarning
      tabIndex={0}
      onKeyDown={(event) => { props.onKeyDown(event.nativeEvent, props.document); }}
    >{composerDocumentPlainText(props.document)}</div>;
  })
}));
vi.mock("./ModelPicker.js", () => ({ ModelPicker: () => null }));
vi.mock("./HomeUsageDashboard.js", () => ({ HomeUsageDashboard: () => null }));
vi.mock("./ComposerPastedTextDialog.js", () => ({ ComposerPastedTextDialog: () => null }));

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  window.localStorage.clear();
  editorProps = undefined;
  editorElement = null;
  newSessionEditorHarness.routeDropActions.splice(0);
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("NewSessionPage typed slash commands", () => {
  it("hydrates and retires an exact one-shot Extension Use handoff", async () => {
    const pending: PendingExtensionUseView = {
      extensionId: "extension_0123456789abcdef0123456789abcdef",
      extensionRevision: "7",
      commandName: "open-nav",
      runtimeSessionId: "runtime-session",
      displayName: "Workspace navigator",
      owner: {
        kind: "resource",
        resourceId: "resource-extension-a",
        discoveredRevision: "sha256:resource-generation-a",
        resourceRevision: "4"
      }
    };
    const getExtension = vi.fn(async (_extensionId: string, _sessionId?: string, _signal?: AbortSignal) => ({
      revision: 9n,
      extensions: [extension()],
      recoveredFromCorruption: false
    }));
    const clearPendingExtensionUse = vi.fn(async () => undefined);

    await renderPage(vi.fn(async () => undefined), { pending, getExtension, clearPendingExtensionUse });
    await act(async () => vi.waitFor(() => expect(editorElement?.textContent).toBe("/open-nav")));

    expect(getExtension).toHaveBeenCalledOnce();
    expect(getExtension.mock.calls[0]?.slice(0, 2)).toEqual([pending.extensionId, pending.runtimeSessionId]);
    expect(getExtension.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    expect(clearPendingExtensionUse).toHaveBeenCalledOnce();
  });

  it("keeps the editor focused, filters a live query, and does not open during IME composition", async () => {
    const onSubmit = vi.fn(async (_session: DelayedNewSessionDraft, _input: ComposerDraft) => undefined);
    await renderPage(onSubmit);

    await edit("/rev", 4, true);
    expect(document.querySelector('[aria-label="composer.commands"]')).toBeNull();

    await edit("/rev", 4, false);
    expect(editorElement).toBe(document.activeElement);
    expect(document.querySelector('[aria-label="composer.commands"] input')).toBeNull();
    expect(commandOptions().map((option) => option.textContent)).toEqual([expect.stringContaining("/review")]);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("replaces the complete slash run after the caret moves into its middle", async () => {
    const onSubmit = vi.fn(async (_session: DelayedNewSessionDraft, _input: ComposerDraft) => undefined);
    await renderPage(onSubmit);

    await edit("/review", 7, false);
    await moveCaret(3);
    expect(commandOptions()).toHaveLength(2);
    const replacement = commandOptions().find((option) => option.textContent?.includes("/replace"));
    await act(async () => required(replacement).click());

    expect(editorElement?.textContent).toBe("/replace");
    expect(editorElement?.textContent).not.toContain("view");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("owns arrow and Enter navigation in the editor instead of submitting the raw slash run", async () => {
    const onSubmit = vi.fn(async (_session: DelayedNewSessionDraft, _input: ComposerDraft) => undefined);
    await renderPage(onSubmit);

    await edit("/", 1, false);
    await moveCaret(1);
    expect(commandOptions()).toHaveLength(2);
    await key("ArrowDown");
    expect(commandOptions()[1]?.getAttribute("aria-selected")).toBe("true");
    await key("Enter");

    expect(editorElement?.textContent).toBe("/replace");
    expect(document.querySelector('[aria-label="composer.commands"]')).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();

    await edit("/zzz", 4, false);
    await moveCaret(4);
    expect(commandOptions()).toHaveLength(0);
    await key("Enter");
    expect(editorElement?.textContent).toBe("/zzz");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("retires a typed command palette with its owner Document", async () => {
    const onSubmit = vi.fn(async (_session: DelayedNewSessionDraft, _input: ComposerDraft) => undefined);
    await renderPage(onSubmit);
    await edit("/rev", 4, false);
    await moveCaret(4);
    expect(commandOptions()).toHaveLength(1);

    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(document.querySelector('[aria-label="composer.commands"]')).toBeNull();
    expect(editorElement?.textContent).toBe("/rev");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("routes separate photo and file actions through the live new-task composer and retires a late chooser result", async () => {
    const onSubmit = vi.fn(async (_session: DelayedNewSessionDraft, _input: ComposerDraft) => undefined);
    await renderPage(onSubmit, { attachmentActions: true });
    const file = required(document.querySelector<HTMLInputElement>(".new-task-composer input[type='file']"));
    const pick = vi.spyOn(file, "click").mockImplementation(() => undefined);

    await act(async () => {
      expect(dispatchGamepadOwnedAction(document, "add-photos")).toBe(true);
      expect(dispatchGamepadOwnedAction(document, "add-files")).toBe(true);
    });
    expect(pick).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();

    await act(async () => { dispatchGamepadOwnedAction(document, "add-files"); });
    Object.defineProperty(file, "files", { configurable: true, value: [new File(["late"], "late.txt", { type: "text/plain" })] });
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      file.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });
    expect(document.body.textContent).not.toContain("late.txt");
    expect(editorElement?.textContent).toBe("");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("routes a private task drag through the positional editor contract", async () => {
    await renderPage(vi.fn(async () => undefined));
    const composer = required(document.querySelector<HTMLElement>(".new-task-composer"));
    newSessionEditorHarness.routeDropActions.splice(0);
    const href = "https://joko.test/app#/tasks/task-2";
    let readable = false;
    const transfer = {
      types: [SESSION_LINK_DRAG_MIME],
      files: [] as readonly File[],
      dropEffect: "none",
      getData: (type: string) => readable && type === SESSION_LINK_DRAG_MIME ? href : ""
    };

    await dispatchDrag(composer, "dragenter", transfer, 18, 24);
    await dispatchDrag(composer, "dragover", transfer, 21, 27);
    expect(composer.querySelector(".composer__drop")).toBeNull();
    expect(newSessionEditorHarness.routeDropActions.filter((action) => action["kind"] === "move").at(-1)).toEqual({
      kind: "move",
      clientX: 21,
      clientY: 27
    });

    readable = true;
    await dispatchDrag(composer, "drop", transfer, 25, 31);
    expect(newSessionEditorHarness.routeDropActions.filter((action) => action["kind"] === "commit")).toEqual([
      expect.objectContaining({
        kind: "commit",
        clientX: 25,
        clientY: 31,
        insertion: expect.objectContaining({ source: "session", attrs: expect.objectContaining({ reference: "task-2" }) })
      })
    ]);
  });
});

async function renderPage(
  onSubmit: (session: DelayedNewSessionDraft, input: ComposerDraft) => Promise<void>,
  options: {
    readonly pending?: PendingExtensionUseView;
    readonly getExtension?: AppController["getExtension"];
    readonly clearPendingExtensionUse?: AppController["clearPendingExtensionUse"];
    readonly attachmentActions?: boolean;
  } = {}
): Promise<void> {
  const snapshotValue = snapshot(options.attachmentActions === true);
  const controller = {
    state: {
      connectionState: "connected",
      snapshot: snapshotValue,
      preferences: { locale: "en", composerSendShortcut: "enter", newSessionWorktreeEnabled: false }
    },
    readNewSessionDraft: vi.fn(async () => draft(options.attachmentActions === true)),
    saveNewSessionDraft: vi.fn(async () => undefined),
    readPendingExtensionUse: vi.fn(async () => options.pending),
    getExtension: options.getExtension ?? vi.fn(async () => ({ revision: 0n, extensions: [], recoveredFromCorruption: false })),
    clearPendingExtensionUse: options.clearPendingExtensionUse ?? vi.fn(async () => undefined),
    prepareTargetWorkspace: vi.fn(async () => undefined),
    probeTargetWorktree: vi.fn(async (targetId: string) => ({ targetId, eligibility: "unavailable", canRefreshRemote: false })),
    listTargetWorktreeSources: vi.fn(async () => []),
    setNewSessionWorktreeEnabled: vi.fn(async () => undefined)
  } as unknown as AppController;
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<NewSessionPage
      controller={controller}
      snapshot={snapshotValue}
      navigationOpen
      t={(key) => key}
      onOpenNavigation={vi.fn()}
      onClose={vi.fn()}
      onSubmit={onSubmit}
    />);
    await flush();
  });
  required(editorElement).focus();
}

function extension(): ExtensionCatalogEntryView {
  return {
    id: "extension_0123456789abcdef0123456789abcdef",
    revision: 7n,
    owner: {
      kind: "resource",
      resourceId: "resource-extension-a",
      discoveredRevision: "sha256:resource-generation-a",
      resourceRevision: 4n
    },
    source: "local",
    installed: true,
    installState: "installed",
    name: "Workspace navigator",
    description: "Navigate this workspace",
    enabled: true,
    sidebarSupported: true,
    sidebarVisible: false,
    tools: [],
    permissions: [],
    commands: [{ name: "open-nav", description: "Open navigation", sessionId: "runtime-session" }],
    setup: { state: "notRequired", revision: 0n, fields: [] },
    useSupported: true
  };
}

async function edit(text: string, caret: number, composing: boolean): Promise<void> {
  const element = required(editorElement);
  element.textContent = text;
  setCaret(element, caret);
  await act(async () => {
    required(editorProps).onDocumentChange(plainTextToComposerDocument(text), composing, (ranges) => ranges);
    await flush();
  });
}

async function moveCaret(caret: number): Promise<void> {
  setCaret(required(editorElement), caret);
  await act(async () => {
    document.dispatchEvent(new Event("selectionchange"));
    await flush();
  });
}

async function key(value: string): Promise<void> {
  await act(async () => {
    required(editorElement).dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
    await flush();
  });
}

function setCaret(element: HTMLElement, offset: number): void {
  element.focus();
  const text = element.firstChild ?? element.appendChild(document.createTextNode(""));
  const range = document.createRange();
  range.setStart(text, Math.min(offset, text.textContent?.length ?? 0));
  range.collapse(true);
  const selection = element.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function commandOptions(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[aria-label="composer.commands"] [role="option"]')];
}

const visionModel: ModelView = {
  backendId: "backend-1",
  providerId: "provider-1",
  providerName: "Provider",
  modelId: "vision-1",
  name: "Vision",
  available: true,
  supportsImages: true,
  supportsFast: false,
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
  efforts: [],
  contextWindow: 8_192,
  maximumOutputTokens: 2_048,
  inputCostMicrosPerMillion: 0,
  outputCostMicrosPerMillion: 0,
  currencyCode: "USD"
};

function snapshot(attachmentActions = false): AppSnapshot {
  const initial = emptySnapshot();
  return {
    ...initial,
    models: attachmentActions ? [visionModel] : [],
    backends: [{
      id: "backend-1",
      name: "Backend",
      version: "1",
      instanceGeneration: 1,
      health: "healthy",
      authenticationState: "notRequired",
      capabilities: new Map([
        ["input.text", { name: "input.text", supported: true, options: [] }],
        ["runtime.commands", { name: "runtime.commands", supported: true, options: [] }],
        ["permission.modes", { name: "permission.modes", supported: true, options: ["ask"] }],
        ...(attachmentActions ? [
          ["model.switch", { name: "model.switch", supported: true, options: [] }],
          ["input.image", { name: "input.image", supported: true, options: [] }],
          ["input.file", { name: "input.file", supported: true, options: [] }]
        ] as const : [])
      ])
    }],
    targets: [{
      id: "target-1", backendId: "backend-1", name: "Project", workspaceId: "workspace-1",
      revision: 1n, workspaceName: "Workspace", trusted: true, pinned: false, archived: false
    }],
    workspaces: [{
      id: "workspace-1", targetId: "target-1", name: "Workspace", kind: "userProject",
      serverPath: "/workspace", trusted: true, dirty: false, revision: "workspace-1", entries: []
    }],
    commands: [
      { id: "review", name: "review", description: "Review changes", source: "backend", loaded: true },
      { id: "replace", name: "replace", description: "Replace a run", source: "backend", loaded: true }
    ]
  };
}

function draft(attachmentActions = false): NewSessionLocalDraft {
  return {
    selection: { kind: "target", targetId: "target-1" },
    nativeStart: { kind: "fresh" },
    providerId: attachmentActions ? visionModel.providerId : "",
    modelId: attachmentActions ? visionModel.modelId : "",
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    text: "",
    editorDocument: plainTextToComposerDocument(""),
    mentions: [],
    inlineMentionRanges: [],
    attachments: []
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function dispatchDrag(
  element: HTMLElement,
  type: string,
  transfer: { readonly types: readonly string[]; readonly files: readonly File[]; dropEffect: string; getData(type: string): string },
  clientX: number,
  clientY: number
): Promise<void> {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: transfer },
    clientX: { value: clientX },
    clientY: { value: clientY },
    relatedTarget: { value: null }
  });
  await act(async () => {
    element.dispatchEvent(event);
    await flush();
  });
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected test value");
  return value;
}
