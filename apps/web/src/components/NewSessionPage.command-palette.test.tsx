// @vitest-environment jsdom

import type { JSONContent } from "@tiptap/core";
import { act, forwardRef, useImperativeHandle, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { composerDocumentPlainText, plainTextToComposerDocument } from "../composer-quote-document.js";
import type { AppController } from "../controller.js";
import { emptySnapshot, type AppSnapshot, type ComposerDraft, type ComposerInlineMentionRange, type NewSessionLocalDraft } from "../model.js";
import type { DelayedNewSessionDraft } from "../new-session-flow.js";
import { NewSessionPage } from "./NewSessionPage.js";

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

vi.mock("./ComposerRichTextEditor.js", () => ({
  ComposerRichTextEditor: forwardRef(function Editor(props: MockEditorProps, ref) {
    const elementRef = useRef<HTMLDivElement>(null);
    editorProps = props;
    useImperativeHandle(ref, () => ({
      focus: () => elementRef.current?.focus(),
      focusFromBlankSurface: () => elementRef.current?.focus(),
      insertRouteReference: vi.fn(),
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
});

async function renderPage(onSubmit: (session: DelayedNewSessionDraft, input: ComposerDraft) => Promise<void>): Promise<void> {
  const snapshotValue = snapshot();
  const controller = {
    state: {
      connectionState: "connected",
      snapshot: snapshotValue,
      preferences: { locale: "en", composerSendShortcut: "enter", newSessionWorktreeEnabled: false }
    },
    readNewSessionDraft: vi.fn(async () => draft()),
    saveNewSessionDraft: vi.fn(async () => undefined),
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

function snapshot(): AppSnapshot {
  const initial = emptySnapshot();
  return {
    ...initial,
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
        ["permission.modes", { name: "permission.modes", supported: true, options: ["ask"] }]
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

function draft(): NewSessionLocalDraft {
  return {
    selection: { kind: "target", targetId: "target-1" },
    nativeStart: { kind: "fresh" },
    providerId: "",
    modelId: "",
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

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected test value");
  return value;
}
