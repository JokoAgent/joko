// @vitest-environment jsdom

import type { JSONContent } from "@tiptap/core";
import { act, forwardRef, useImperativeHandle, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { composerDocumentPlainText, plainTextToComposerDocument } from "../composer-quote-document.js";
import type { AppController } from "../controller.js";
import {
  emptySnapshot,
  type AppSnapshot,
  type ComposerDraft,
  type ComposerInlineMentionRange,
  type NewSessionLocalDraft
} from "../model.js";
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
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
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

describe("NewSessionPage directory mentions", () => {
  it("drills workspace directories and submits only an explicitly referenced directory in a directory-only profile", async () => {
    const listWorkspaceFiles = vi.fn(async () => ({ paths: ["must-not-be-read.ts"], truncated: false, revision: "files" }));
    const onSubmit = vi.fn(async (_session: DelayedNewSessionDraft, _input: ComposerDraft) => undefined);
    const { container } = await renderPage(onSubmit, listWorkspaceFiles);

    await edit("@", 1);
    expect(optionLabels()).toEqual(["docs/", "nested/", "src/"]);
    expect(document.body.textContent).not.toContain("README.md");
    expect(document.body.textContent).not.toContain("src-secret.ts");
    expect(document.body.textContent).not.toContain("Hidden resource");
    expect(document.body.textContent).not.toContain("Prior task");
    expect(document.body.textContent).not.toContain("Unsent artifact");
    expect(listWorkspaceFiles).not.toHaveBeenCalled();

    await key("ArrowUp");
    expect(optionButton("src/").getAttribute("aria-selected")).toBe("true");
    await key("Enter");
    expect(editorElement?.textContent).toBe("@src/");
    expect(optionLabels()).toEqual(["nested/"]);
    expect(document.body.textContent).not.toContain("src-secret.ts");

    await act(async () => referenceDirectoryButton().click());
    expect(editorElement?.textContent).toBe("@src/nested/");
    expect(document.querySelector('[aria-label="composer.mention"]')).toBeNull();

    await act(async () => sendButton(container).click());
    const token = "@src/nested/";
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      text: token,
      mentions: [{
        id: "workspace-directory:workspace-1:src/nested",
        kind: "workspace",
        reference: "src/nested",
        label: "nested",
        token,
        directory: true,
        workspaceId: "workspace-1"
      }],
      inlineMentionRanges: [{
        mentionId: "workspace-directory:workspace-1:src/nested",
        from: 0,
        to: token.length
      }]
    }), expect.anything());
  });
});

async function renderPage(
  onSubmit: (session: DelayedNewSessionDraft, input: ComposerDraft) => Promise<void>,
  listWorkspaceFiles: () => Promise<{ readonly paths: readonly string[]; readonly truncated: boolean; readonly revision: string }>
): Promise<{ readonly container: HTMLDivElement }> {
  const snapshotValue = snapshot();
  const controller = {
    state: {
      connectionState: "connected",
      snapshot: snapshotValue,
      preferences: { locale: "en", composerSendShortcut: "enter", newSessionWorktreeEnabled: false }
    },
    readNewSessionDraft: vi.fn(async () => draft()),
    saveNewSessionDraft: vi.fn(async () => undefined),
    prepareTargetWorkspace: vi.fn(async () => undefined),
    probeTargetWorktree: vi.fn(async (targetId: string) => ({ targetId, eligibility: "unavailable", canRefreshRemote: false })),
    listTargetWorktreeSources: vi.fn(async () => []),
    listWorkspaceFiles: vi.fn(listWorkspaceFiles),
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
  return { container };
}

async function edit(text: string, caret: number): Promise<void> {
  const element = required(editorElement);
  element.textContent = text;
  setCaret(element, caret);
  await act(async () => {
    required(editorProps).onDocumentChange(plainTextToComposerDocument(text), false, (ranges) => ranges);
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

function optionLabels(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[aria-label="composer.mention"] [role="option"]')]
    .map((option) => option.querySelector("span")?.textContent ?? "");
}

function optionButton(label: string): HTMLButtonElement {
  return required([...document.querySelectorAll<HTMLButtonElement>('[aria-label="composer.mention"] [role="option"]')]
    .find((option) => option.querySelector("span")?.textContent === label));
}

function referenceDirectoryButton(): HTMLButtonElement {
  return required([...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "composer.referenceDirectory"));
}

function sendButton(container: ParentNode): HTMLButtonElement {
  return required(container.querySelector<HTMLButtonElement>("button.send-button"));
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
        ["input.mention", { name: "input.mention", supported: true, options: ["workspace_directory"] }],
        ["permission.modes", { name: "permission.modes", supported: true, options: ["ask"] }]
      ])
    }],
    targets: [{
      id: "target-1", backendId: "backend-1", name: "Project", workspaceId: "workspace-1",
      revision: 1n, workspaceName: "Workspace", trusted: true, pinned: false, archived: false
    }],
    workspaces: [{
      id: "workspace-1", targetId: "target-1", name: "Workspace", kind: "userProject",
      serverPath: "/workspace", trusted: true, dirty: false, revision: "workspace-1",
      entries: [
        { path: "README.md", name: "README.md", kind: "file", generated: false },
        {
          path: "src", name: "src", kind: "directory", generated: false,
          children: [
            { path: "src/src-secret.ts", name: "src-secret.ts", kind: "file", generated: false },
            {
              path: "src/nested", name: "nested", kind: "directory", generated: false,
              children: [{ path: "src/nested/private.ts", name: "private.ts", kind: "file", generated: false }]
            }
          ]
        },
        { path: "docs", name: "docs", kind: "directory", generated: false, children: [] }
      ]
    }],
    sessions: [{
      id: "history", backendId: "backend-1", targetId: "target-1", name: "Prior task", state: "idle",
      pinned: false, archived: false, generation: 1n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 1
    }],
    resources: [{
      id: "resource", backendId: "backend-1", targetId: "target-1", name: "Hidden resource", kind: "skill",
      scope: "project", state: "loaded", enabled: true, source: "fixture", discoveredRevision: "resource-1",
      compatibilityDetails: [], runtimeRequirements: [], warnings: [], disabledLifecycleScripts: [], canToggle: true,
      requiresExtensionApproval: false, postMutationNotice: false
    }]
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
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  await Promise.resolve();
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected test value");
  return value;
}
