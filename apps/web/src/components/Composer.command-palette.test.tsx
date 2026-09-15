// @vitest-environment jsdom
import type { JSONContent } from "@tiptap/core";
import { act, forwardRef, useImperativeHandle, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { remapComposerInlineMentionReplacement } from "../composer-mention-ranges.js";
import { appendQuoteToComposerDocument, composerDocumentPlainText, composerDocumentQuotes, plainTextToComposerDocument } from "../composer-quote-document.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type BackendView, type ComposerDraft, type ComposerInlineMentionRange, type RuntimeCommandView, type SessionView } from "../model.js";
import { replaceComposerDocumentTextRange } from "./composer-inline-mention.js";
import { Composer } from "./Composer.js";

const editorHarness = vi.hoisted(() => ({ caret: 0, restoredCaret: undefined as number | undefined }));

vi.mock("./composer-inline-mention.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./composer-inline-mention.js")>();
  return {
    ...actual,
    composerCaretTextOffset: () => document.activeElement?.getAttribute("data-mock-composer-editor") === "true"
      ? editorHarness.caret
      : undefined,
    setComposerCaretTextOffset: (_root: HTMLElement | null, _selection: Selection | null, offset: number) => {
      editorHarness.caret = offset;
      editorHarness.restoredCaret = offset;
      const editor = document.querySelector<HTMLTextAreaElement>('[data-mock-composer-editor="true"]');
      editor?.setSelectionRange(Math.min(offset, editor.value.length), Math.min(offset, editor.value.length));
      return editor !== null;
    }
  };
});

vi.mock("./ComposerRichTextEditor.js", () => ({
  ComposerRichTextEditor: forwardRef(function MockComposerRichTextEditor(props: {
    readonly document: JSONContent;
    readonly onDocumentChange: (
      document: JSONContent,
      isComposing: boolean,
      mapRanges: (ranges: readonly ComposerInlineMentionRange[]) => readonly ComposerInlineMentionRange[]
    ) => void;
    readonly onKeyDown: (event: KeyboardEvent, document: JSONContent) => boolean;
  }, forwardedRef) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(forwardedRef, () => ({
      focus: (position?: "start" | "end") => {
        const editor = textareaRef.current;
        if (editor === null) return;
        editor.focus();
        if (position !== undefined) {
          const offset = position === "start" ? 0 : editor.value.length;
          editorHarness.caret = offset;
          editorHarness.restoredCaret = offset;
          editor.setSelectionRange(offset, offset);
        }
      },
      focusFromBlankSurface: () => textareaRef.current?.focus(),
      editPastedText: () => false,
      insertRouteReference: () => false
    }), []);
    return <textarea
      ref={textareaRef}
      data-mock-composer-editor="true"
      className="composer-rich-editor__content"
      aria-label="Draft"
      value={composerDocumentPlainText(props.document)}
      onInput={(event) => {
        const nextText = event.currentTarget.value;
        const previousText = composerDocumentPlainText(props.document);
        const splice = singleTextSplice(previousText, nextText);
        editorHarness.caret = event.currentTarget.selectionStart ?? nextText.length;
        const nextDocument = replaceComposerDocumentTextRange(
          props.document,
          splice.from,
          splice.to,
          splice.replacement
        ) ?? plainTextToComposerDocument(nextText);
        props.onDocumentChange(
          nextDocument,
          (event.nativeEvent as InputEvent).isComposing,
          (ranges) => remapComposerInlineMentionReplacement(
            ranges,
            splice.from,
            splice.to,
            splice.replacement.length
          )
        );
      }}
      onKeyDown={(event) => {
        if (props.onKeyDown(event.nativeEvent, props.document)) event.preventDefault();
      }}
    />;
  })
}));

const roots: Root[] = [];
const rafCallbacks: FrameRequestCallback[] = [];
const baseSession: SessionView = {
  id: "task-one",
  backendId: "backend-one",
  targetId: "target-one",
  name: "Task one",
  state: "idle",
  pinned: false,
  archived: false,
  generation: 1n,
  fastMode: false,
  permissionMode: "ask",
  planMode: false,
  updatedAt: 0
};
const commands: readonly RuntimeCommandView[] = [{
  id: "deploy",
  name: "deploy",
  description: "Deploy an exact build",
  source: "skill",
  loaded: true
}];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    rafCallbacks.push(callback);
    return rafCallbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  editorHarness.caret = 0;
  editorHarness.restoredCaret = undefined;
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  rafCallbacks.splice(0);
  vi.unstubAllGlobals();
});

it("replaces the complete slash run at a moved caret while preserving quote structure and mention authority", async () => {
  const quote = { id: "quote-one", kind: "message" as const, text: "quoted evidence", sessionId: baseSession.id, messageId: "message-one", role: "assistant" as const };
  const sourceText = "Ask @notes /helpOops";
  const mention = { id: "notes", kind: "workspace" as const, reference: "notes.md", label: "notes", token: "@notes", workspaceId: "workspace-one" };
  const sourceDocument = appendQuoteToComposerDocument(plainTextToComposerDocument(sourceText), quote);
  const view = await mount({
    text: sourceText,
    editorDocument: sourceDocument,
    attachments: [],
    mentions: [mention],
    inlineMentionRanges: [{ mentionId: mention.id, from: 4, to: 10 }],
    deliveryMode: "prompt"
  });

  const editor = view.editor();
  editor.focus();
  editorHarness.caret = 16; // Ask @notes /help|Oops
  await act(async () => document.dispatchEvent(new Event("selectionchange")));

  const palette = typedPalette();
  expect(palette).not.toBeNull();
  expect(document.activeElement).toBe(editor);
  expect(optionLabels(palette!)).toEqual(["/help"]);

  expect(await press(editor, "Enter")).toBe(true);
  await flushAnimationFrames();
  expect(editor.value).toBe("Ask @notes /help");
  expect(editor.value).not.toContain("Oops");
  expect(editorHarness.restoredCaret).toBe(editor.value.length);
  expect(document.activeElement).toBe(editor);
  expect(typedPalette()).toBeNull();

  await act(async () => view.send().click());
  await act(async () => Promise.all(view.actions));
  expect(view.api.send).toHaveBeenCalledTimes(1);
  const sent = vi.mocked(view.api.send).mock.calls[0]?.[1];
  expect(sent).toEqual(expect.objectContaining({
    text: "Ask @notes /help",
    mentions: [mention],
    inlineMentionRanges: [{ mentionId: mention.id, from: 4, to: 10 }]
  }));
  expect(composerDocumentQuotes(sent?.editorDocument ?? {}).map((item) => item.id)).toEqual([quote.id]);
});

it("keeps keyboard ownership in the editor and leaves add-menu command search independent", async () => {
  const view = await mount(draft("/"));
  const editor = view.editor();
  editor.focus();
  editorHarness.caret = 1;
  await act(async () => document.dispatchEvent(new Event("selectionchange")));

  expect(document.activeElement).toBe(editor);
  expect(optionLabels(typedPalette()!)).toEqual(["/help", "/jump-session", "/cmd", "/clear", "/review", "/deploy"]);
  await input(editor, "/bui", 4);
  expect(document.activeElement).toBe(editor);
  expect(optionLabels(typedPalette()!)).toEqual(["/deploy"]);
  await input(editor, "/", 1);
  expect(await press(editor, "End")).toBe(true);
  expect(selectedOption()?.textContent).toContain("/deploy");
  expect(await press(editor, "Home")).toBe(true);
  expect(selectedOption()?.textContent).toContain("/help");
  expect(await press(editor, "ArrowUp")).toBe(true);
  expect(selectedOption()?.textContent).toContain("/deploy");
  expect(await press(editor, "ArrowDown")).toBe(true);
  expect(selectedOption()?.textContent).toContain("/help");
  expect(await press(editor, "Enter")).toBe(true);
  await flushAnimationFrames();
  expect(editor.value).toBe("/help");
  expect(document.activeElement).toBe(editor);

  await input(editor, "/", 1);
  expect(await press(editor, "ArrowDown")).toBe(true);
  expect(await press(editor, "Tab")).toBe(true);
  await flushAnimationFrames();
  expect(editor.value).toBe("/jump-session");
  expect(document.activeElement).toBe(editor);

  await input(editor, "/nothing-matches", 16);
  expect(optionLabels(typedPalette()!)).toEqual([]);
  expect(await press(editor, "Enter")).toBe(true);
  expect(editor.value).toBe("/nothing-matches");
  expect(view.api.send).not.toHaveBeenCalled();

  await input(editor, "/", 1);
  expect(await press(editor, "Escape")).toBe(true);
  await flushAnimationFrames();
  expect(typedPalette()).toBeNull();
  expect(document.activeElement).toBe(editor);
  await act(async () => document.dispatchEvent(new Event("selectionchange")));
  expect(typedPalette()).toBeNull();

  await act(async () => view.add().click());
  const commandAction = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent?.includes("composer.commands"));
  expect(commandAction).toBeDefined();
  await act(async () => commandAction!.click());
  const search = document.body.querySelector<HTMLInputElement>('input[aria-label="common.filter composer.commands"]');
  expect(search).not.toBeNull();
  await input(search!, "build", 5);
  const addPalette = search!.closest(".composer-palette");
  expect(optionLabels(addPalette!)).toEqual(["/deploy"]);
  expect(typedPalette()).toBeNull();
});

it("never opens the typed command palette for IME composition or shell mode and retires it with its task owner", async () => {
  const view = await mount(draft(""));
  const editor = view.editor();
  await input(editor, "/re", 3, true);
  expect(typedPalette()).toBeNull();

  await input(editor, "/re", 3, false);
  expect(typedPalette()).not.toBeNull();
  await act(async () => view.shell().click());
  await flushAnimationFrames();
  expect(typedPalette()).toBeNull();
  await input(editor, "/rev", 4, false);
  expect(typedPalette()).toBeNull();

  const nextSession = { ...baseSession, id: "task-two", name: "Task two", generation: 2n };
  await view.render(nextSession);
  expect(typedPalette()).toBeNull();
  expect(view.editor().value).toBe("second task");
});

async function mount(initialDraft: ComposerDraft) {
  const drafts = new Map<string, ComposerDraft>([
    [baseSession.id, initialDraft],
    ["task-two", draft("second task")]
  ]);
  const api = {
    state: { connectionState: "connected", snapshot: emptySnapshot(), preferences: DEFAULT_UI_PREFERENCES },
    readDraft: vi.fn(async (sessionId: string) => drafts.get(sessionId)),
    readDraftSnapshot: vi.fn(async (sessionId: string) => ({ revision: 1, draft: drafts.get(sessionId) })),
    saveDraft: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    getVoiceInputCapabilities: vi.fn(async () => ({})),
    listWorkspaceFiles: vi.fn(async () => ({ paths: ["notes.md"], truncated: false, revision: "1" }))
  } as unknown as AppController;
  const backend: BackendView = {
    id: baseSession.backendId,
    name: "Backend one",
    version: "1",
    health: "healthy",
    authenticationState: "notRequired",
    capabilities: new Map([
      ["input.text", { name: "input.text", supported: true, options: [] }],
      ["input.mention", { name: "input.mention", supported: true, options: ["workspace_file"] }],
      ["runtime.user_shell", { name: "runtime.user_shell", supported: true, options: [] }],
      ["session.reset", { name: "session.reset", supported: true, options: [] }],
      ["review.isolated", { name: "review.isolated", supported: true, options: [] }]
    ])
  };
  const workspace = { id: "workspace-one", targetId: baseSession.targetId, name: "Workspace", kind: "userProject" as const, serverPath: "/workspace", trusted: true, dirty: false, entries: [] };
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  const actions: Promise<unknown>[] = [];
  const render = async (session: SessionView) => {
    await act(async () => root.render(<Composer
      controller={api}
      session={session}
      backend={backend}
      autoFocus={false}
      queue={[]}
      workspace={workspace}
      extraDirectories={[]}
      resources={[]}
      commands={commands}
      messageHistory={[]}
      t={(key) => key}
      runAction={(_key, action) => { actions.push(action().catch(() => undefined)); }}
      onLocalSend={() => undefined}
    />));
  };
  await render(baseSession);
  return {
    api,
    actions,
    render,
    editor: () => host.querySelector<HTMLTextAreaElement>('[data-mock-composer-editor="true"]')!,
    send: () => host.querySelector<HTMLButtonElement>(".send-button")!,
    add: () => host.querySelector<HTMLButtonElement>('button[aria-label="common.add"]')!,
    shell: () => host.querySelector<HTMLButtonElement>('button[aria-label="composer.shellEnter"]')!
  };
}

function draft(text: string): ComposerDraft {
  return { text, editorDocument: plainTextToComposerDocument(text), attachments: [], mentions: [], inlineMentionRanges: [], deliveryMode: "prompt" };
}

async function input(element: HTMLTextAreaElement | HTMLInputElement, value: string, caret: number, isComposing = false): Promise<void> {
  await act(async () => {
    element.focus();
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.setSelectionRange(caret, caret);
    editorHarness.caret = caret;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", isComposing }));
  });
}

async function press(element: HTMLElement, key: string): Promise<boolean> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key });
  await act(async () => element.dispatchEvent(event));
  return event.defaultPrevented;
}

async function flushAnimationFrames(): Promise<void> {
  await act(async () => {
    for (const callback of rafCallbacks.splice(0)) callback(0);
  });
}

function typedPalette(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-composer-typed-command-palette="true"]');
}

function selectedOption(): HTMLElement | null {
  return typedPalette()?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ?? null;
}

function optionLabels(root: Element): readonly string[] {
  return [...root.querySelectorAll<HTMLElement>('[role="option"] span')].map((item) => item.textContent ?? "");
}

function singleTextSplice(previous: string, next: string): { readonly from: number; readonly to: number; readonly replacement: string } {
  let from = 0;
  while (from < previous.length && from < next.length && previous[from] === next[from]) from += 1;
  let suffix = 0;
  while (
    suffix < previous.length - from
    && suffix < next.length - from
    && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]
  ) suffix += 1;
  return {
    from,
    to: previous.length - suffix,
    replacement: next.slice(from, next.length - suffix)
  };
}
