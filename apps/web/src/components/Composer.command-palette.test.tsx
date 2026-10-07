// @vitest-environment jsdom
import type { JSONContent } from "@tiptap/core";
import { act, forwardRef, useImperativeHandle, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { remapComposerInlineMentionReplacement } from "../composer-mention-ranges.js";
import { appendQuoteToComposerDocument, composerDocumentPlainText, composerDocumentQuotes, plainTextToComposerDocument } from "../composer-quote-document.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { GAMEPAD_SKILL_EVENT } from "../gamepad-client.js";
import { emptySnapshot, type BackendView, type ComposerDraft, type ComposerInlineMentionRange, type RuntimeCommandView, type SessionView } from "../model.js";
import { replaceComposerDocumentTextRange } from "./composer-inline-mention.js";
import { Composer } from "./Composer.js";
import { WORKSPACE_ENTRY_DRAG_MIME, encodeWorkspaceEntryDragPayload } from "./workspace-tree-state.js";

const editorHarness = vi.hoisted(() => ({
  caret: 0,
  restoredCaret: undefined as number | undefined,
  routeDropActions: [] as Array<Record<string, unknown>>
}));

vi.mock("./composer-inline-mention.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./composer-inline-mention.js")>();
  return {
    ...actual,
    composerCaretTextOffset: (root: HTMLElement | null) => root?.ownerDocument.activeElement?.getAttribute("data-mock-composer-editor") === "true"
      ? editorHarness.caret
      : undefined,
    setComposerCaretTextOffset: (root: HTMLElement | null, _selection: Selection | null, offset: number) => {
      editorHarness.caret = offset;
      editorHarness.restoredCaret = offset;
      const editor = root?.ownerDocument.querySelector<HTMLTextAreaElement>('[data-mock-composer-editor="true"]') ?? null;
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
      insertRouteReference: () => false,
      routeReferenceDrop: (action: Record<string, unknown>) => {
        editorHarness.routeDropActions.push(action);
        return true;
      }
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
const baseTarget = {
  id: baseSession.targetId,
  revision: 1n,
  backendId: baseSession.backendId,
  name: "Target one",
  workspaceId: "workspace-one",
  workspaceName: "Workspace",
  trusted: true,
  pinned: false,
  archived: false
};
const commands: readonly RuntimeCommandView[] = [{
  id: "deploy",
  name: "deploy",
  description: "Deploy an exact build",
  source: "skill",
  resourceId: "resource-skill",
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
  editorHarness.routeDropActions.splice(0);
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  rafCallbacks.splice(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("inserts a bound skill only from the current task runtime catalog without sending", async () => {
  const view = await mount(draft("Please "));
  const target = document.querySelector<HTMLElement>("[data-gamepad-skill]");
  expect(target).not.toBeNull();
  const binding = { kind: "skill", serverId: "server-one", resourceId: "resource-skill", name: "Review" };
  await act(async () => { target!.dispatchEvent(new CustomEvent(GAMEPAD_SKILL_EVENT, { detail: binding })); await Promise.resolve(); });
  await vi.waitFor(() => expect(view.editor().value).toBe("Please /deploy"));
  expect(view.api.listCommands).toHaveBeenCalledExactlyOnceWith("task-one");
  expect(view.api.send).not.toHaveBeenCalled();

  vi.mocked(view.api.listCommands).mockResolvedValueOnce([]);
  await act(async () => { target!.dispatchEvent(new CustomEvent(GAMEPAD_SKILL_EVENT, { detail: binding })); await Promise.resolve(); });
  await vi.waitFor(() => expect(document.querySelector("[role='alert']")?.textContent).toContain("settings.gamepad.skillInputUnavailable"));
  expect(view.editor().value).toBe("Please /deploy");
});

it("starts application-owned learning from the current task or free text without sending a user message", async () => {
  const fromTask = await mount(draft("/learn"));
  await act(async () => fromTask.send().click());
  await settleActions(fromTask.actions);

  expect(fromTask.api.listCommands).toHaveBeenCalledExactlyOnceWith(baseSession.id, expect.any(AbortSignal));
  expect(fromTask.api.startSkillLearning).toHaveBeenCalledExactlyOnceWith({
    requestId: expect.any(String),
    targetId: baseSession.targetId,
    sourceSessionId: baseSession.id,
    instruction: ""
  }, expect.any(AbortSignal));
  expect(fromTask.api.send).not.toHaveBeenCalled();
  expect(fromTask.api.navigate).toHaveBeenCalledWith({ kind: "session", sessionId: "distillation-task" });
  expect(fromTask.editor().value).toBe("");
  expect(fromTask.drafts.get(baseSession.id)?.text).toBe("");

  const fromText = await mount(draft("/learn  turn this checklist into a skill "));
  await act(async () => fromText.send().click());
  await settleActions(fromText.actions);
  expect(fromText.api.startSkillLearning).toHaveBeenCalledExactlyOnceWith({
    requestId: expect.any(String),
    targetId: baseSession.targetId,
    instruction: "turn this checklist into a skill"
  }, expect.any(AbortSignal));
  expect(fromText.api.send).not.toHaveBeenCalled();
});

it("refreshes command ownership at dispatch and sends a loaded runtime /learn exactly once", async () => {
  const view = await mount(draft("/learn runtime evidence"));
  const runtimeLearn: RuntimeCommandView = {
    id: "runtime-learn",
    name: "learn",
    description: "Runtime learning skill",
    source: "skill",
    resourceId: "runtime-learn-resource",
    loaded: true
  };
  vi.mocked(view.api.listCommands).mockResolvedValueOnce([...commands, runtimeLearn]);

  await act(async () => view.send().click());
  await settleActions(view.actions);

  expect(view.api.listCommands).toHaveBeenCalledExactlyOnceWith(baseSession.id, expect.any(AbortSignal));
  expect(view.api.startSkillLearning).not.toHaveBeenCalled();
  expect(view.api.send).toHaveBeenCalledTimes(1);
  expect(view.api.send).toHaveBeenCalledWith(baseSession.id, expect.objectContaining({
    text: "/learn runtime evidence"
  }), { expectedGeneration: baseSession.generation });

  const pinned = await mount(draft("/learn pinned runtime"));
  let finishCommands!: (value: readonly RuntimeCommandView[]) => void;
  vi.mocked(pinned.api.listCommands).mockImplementationOnce(() => new Promise((resolve) => { finishCommands = resolve; }));
  await act(async () => pinned.send().click());
  await vi.waitFor(() => expect(finishCommands).toBeTypeOf("function"));
  const replacementSend = vi.fn(async () => undefined);
  const replacementController = { ...pinned.api, send: replacementSend } as unknown as AppController;
  await pinned.render(baseSession, replacementController);
  await act(async () => finishCommands([...commands, runtimeLearn]));
  await settleActions(pinned.actions);
  expect(pinned.api.send).toHaveBeenCalledTimes(1);
  expect(replacementSend).not.toHaveBeenCalled();
  expect(pinned.api.startSkillLearning).not.toHaveBeenCalled();
});

it("clears only the accepted /learn invocation and preserves edits made while learning starts", async () => {
  const view = await mount(draft("/learn original evidence"));
  let finishLearning!: () => void;
  vi.mocked(view.api.startSkillLearning).mockImplementationOnce((input: { readonly sourceSessionId?: string }) => new Promise((resolve) => {
    finishLearning = () => resolve({
      id: "delayed-learning-run",
      revision: 1n,
      state: "distilling",
      sourceKind: input.sourceSessionId === undefined ? "text" : "session",
      backendId: baseSession.backendId,
      targetId: baseSession.targetId,
      ...(input.sourceSessionId === undefined ? {} : { sourceSessionId: input.sourceSessionId }),
      distillationSessionId: "delayed-distillation-task",
      summary: "Learning",
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2
    });
  }));
  await act(async () => view.send().click());
  await vi.waitFor(() => expect(finishLearning).toBeTypeOf("function"));
  await input(view.editor(), "A newer unrelated draft", 23);
  await act(async () => finishLearning());
  await settleActions(view.actions);
  expect(view.editor().value).toBe("A newer unrelated draft");
  expect(view.drafts.get(baseSession.id)?.text).toBe("A newer unrelated draft");
  expect(view.api.navigate).toHaveBeenCalledWith({ kind: "session", sessionId: "delayed-distillation-task" });
  expect(view.api.send).not.toHaveBeenCalled();
});

it("keeps /learn drafts on hub, structured-input, busy, and owner-retirement failures", async () => {
  const catalogFailure = await mount(draft("/learn keep catalog failure"));
  vi.mocked(catalogFailure.api.listCommands).mockRejectedValueOnce(new Error("Command catalog unavailable"));
  await act(async () => catalogFailure.send().click());
  await settleActions(catalogFailure.actions);
  expect(catalogFailure.editor().value).toBe("/learn keep catalog failure");
  expect(catalogFailure.api.startSkillLearning).not.toHaveBeenCalled();
  expect(catalogFailure.actionErrors).toEqual([expect.objectContaining({ message: "Command catalog unavailable" })]);

  const hub = await mount(draft("/learn hub:shared-skill"));
  await act(async () => hub.send().click());
  await settleActions(hub.actions);
  expect(hub.api.startSkillLearning).not.toHaveBeenCalled();
  expect(hub.api.send).not.toHaveBeenCalled();
  expect(hub.editor().value).toBe("/learn hub:shared-skill");
  expect(hub.actionErrors).toEqual([expect.objectContaining({ message: expect.stringContaining("Skill hub") })]);

  const attachment = { id: "evidence-file", file: new File(["evidence"], "evidence.txt", { type: "text/plain" }), kind: "file" as const };
  const structured = await mount({ ...draft("/learn"), attachments: [attachment] });
  await act(async () => structured.send().click());
  await settleActions(structured.actions);
  expect(structured.api.startSkillLearning).not.toHaveBeenCalled();
  expect(structured.editor().value).toBe("/learn");
  expect(structured.drafts.get(baseSession.id)?.attachments).toEqual([attachment]);

  const mention = { id: "notes", kind: "workspace" as const, reference: "notes.md", label: "notes", token: "@notes", workspaceId: "workspace-one" };
  const mentioned = await mount({
    ...draft("/learn @notes"),
    mentions: [mention],
    inlineMentionRanges: [{ mentionId: mention.id, from: 7, to: 13 }]
  });
  await act(async () => mentioned.send().click());
  await settleActions(mentioned.actions);
  expect(mentioned.api.startSkillLearning).not.toHaveBeenCalled();
  expect(mentioned.editor().value).toBe("/learn @notes");
  expect(mentioned.drafts.get(baseSession.id)?.mentions).toEqual([mention]);

  const busy = await mount(draft("/learn keep this"));
  vi.mocked(busy.api.startSkillLearning).mockRejectedValueOnce(new Error("Learning is busy"));
  await act(async () => busy.send().click());
  await settleActions(busy.actions);
  expect(busy.editor().value).toBe("/learn keep this");
  expect(busy.actionErrors).toEqual([expect.objectContaining({ message: "Learning is busy" })]);

  const failedRun = await mount(draft("/learn keep failed evidence"));
  vi.mocked(failedRun.api.startSkillLearning).mockResolvedValueOnce({
    id: "failed-learning-run",
    revision: 2n,
    state: "failed",
    sourceKind: "text",
    backendId: baseSession.backendId,
    targetId: baseSession.targetId,
    distillationSessionId: "orphaned-distillation-task",
    summary: "Failed learning",
    error: "Learning could not start",
    createdAt: 1,
    updatedAt: 2,
    expiresAt: 3
  });
  await act(async () => failedRun.send().click());
  await settleActions(failedRun.actions);
  expect(failedRun.editor().value).toBe("/learn keep failed evidence");
  expect(failedRun.api.navigate).not.toHaveBeenCalled();
  expect(failedRun.actionErrors).toEqual([expect.objectContaining({ message: "Learning could not start" })]);

  const retired = await mount(draft("/learn"));
  let finishCommands!: (value: readonly RuntimeCommandView[]) => void;
  vi.mocked(retired.api.listCommands).mockImplementationOnce(() => new Promise((resolve) => { finishCommands = resolve; }));
  await act(async () => retired.send().click());
  await vi.waitFor(() => expect(finishCommands).toBeTypeOf("function"));
  await retired.render({ ...baseSession, id: "task-two", generation: 2n });
  await act(async () => finishCommands(commands));
  await settleActions(retired.actions);
  expect(retired.api.startSkillLearning).not.toHaveBeenCalled();
  expect(retired.api.send).not.toHaveBeenCalled();
  await retired.render(baseSession);
  await vi.waitFor(() => expect(retired.editor().value).toBe("/learn"));

  const aborted = await mount(draft("/learn abort with owner"));
  let catalogSignal: AbortSignal | undefined;
  vi.mocked(aborted.api.listCommands).mockImplementationOnce((_sessionId, signal) => new Promise((_resolve, reject) => {
    catalogSignal = signal;
    signal?.addEventListener("abort", () => reject(new DOMException("Retired", "AbortError")), { once: true });
  }));
  await act(async () => aborted.send().click());
  await vi.waitFor(() => expect(catalogSignal).toBeInstanceOf(AbortSignal));
  await aborted.render({ ...baseSession, id: "task-three", generation: 3n });
  await settleActions(aborted.actions);
  expect(catalogSignal?.aborted).toBe(true);
  expect(aborted.actionErrors).toEqual([]);

  const lateFailure = await mount(draft("/learn retire before failed result"));
  let finishFailedLearning!: () => void;
  vi.mocked(lateFailure.api.startSkillLearning).mockImplementationOnce(() => new Promise((resolve) => {
    finishFailedLearning = () => resolve({
      id: "retired-failed-learning-run",
      revision: 1n,
      state: "failed",
      sourceKind: "text",
      backendId: baseSession.backendId,
      targetId: baseSession.targetId,
      distillationSessionId: "retired-orphaned-task",
      summary: "Retired failure",
      error: "This old failure must stay hidden",
      createdAt: 1,
      updatedAt: 2,
      expiresAt: 3
    });
  }));
  await act(async () => lateFailure.send().click());
  await vi.waitFor(() => expect(finishFailedLearning).toBeTypeOf("function"));
  await lateFailure.render({ ...baseSession, id: "task-four", generation: 4n });
  await act(async () => finishFailedLearning());
  await settleActions(lateFailure.actions);
  expect(lateFailure.actionErrors).toEqual([]);
  expect(lateFailure.api.navigate).not.toHaveBeenCalled();
});

it("discards a skill catalog response after the composer changes task", async () => {
  const view = await mount(draft("First"));
  let finish!: (commands: readonly RuntimeCommandView[]) => void;
  vi.mocked(view.api.listCommands).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const target = document.querySelector<HTMLElement>("[data-gamepad-skill]")!;
  await act(async () => target.dispatchEvent(new CustomEvent(GAMEPAD_SKILL_EVENT, {
    detail: { kind: "skill", serverId: "server-one", resourceId: "resource-skill", name: "Review" }
  })));
  await view.render({ ...baseSession, id: "task-two", generation: 2n });
  await act(async () => { finish(commands); await Promise.resolve(); });
  expect(view.editor().value).toBe("second task");
  expect(view.api.send).not.toHaveBeenCalled();
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
  expect(optionLabels(typedPalette()!)).toEqual(["/help", "/learn", "/jump-session", "/cmd", "/clear", "/review", "/deploy"]);
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
  expect(editor.value).toBe("/learn");
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

it("advertises /learn only for the connected writable task's exact Skill-capable Target", async () => {
  const view = await mount(draft("/"));
  const editor = view.editor();
  editor.focus();
  editorHarness.caret = 1;
  await act(async () => document.dispatchEvent(new Event("selectionchange")));
  expect(optionLabels(required(typedPalette()))).toContain("/learn");

  const withoutTarget = {
    ...view.api,
    state: { ...view.api.state, snapshot: { ...view.api.state.snapshot, targets: [] } }
  } as unknown as AppController;
  await view.render(baseSession, withoutTarget);
  expect(optionLabels(required(typedPalette()))).not.toContain("/learn");

  const withoutSkill = {
    ...view.backend,
    capabilities: new Map([...view.backend.capabilities].filter(([name]) => name !== "runtime.resources"))
  };
  await view.render(baseSession, view.api, withoutSkill);
  expect(optionLabels(required(typedPalette()))).not.toContain("/learn");

  await view.render(baseSession, view.api, { ...view.backend, health: "unavailable" });
  expect(optionLabels(required(typedPalette()))).not.toContain("/learn");

  await view.render({ ...baseSession, archived: true }, view.api, view.backend);
  expect(optionLabels(required(typedPalette()))).not.toContain("/learn");

  const disconnected = {
    ...view.api,
    state: { ...view.api.state, connectionState: "disconnected" as const }
  } as unknown as AppController;
  await view.render(baseSession, disconnected, view.backend);
  expect(optionLabels(required(typedPalette()))).not.toContain("/learn");
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

it("keeps selection ownership, command navigation, focus, and caret restoration in a mounted owner document", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const ownerDocument = required(frame.contentDocument);
  const ownerWindow = required(frame.contentWindow);
  installAnimationFrameRuntime(ownerWindow);
  const ownerTimer = vi.spyOn(ownerWindow, "setTimeout").mockImplementation(() => 1);
  const view = await mount(draft("/"), ownerDocument);
  const editor = view.editor();
  editorHarness.caret = 0;
  await act(async () => {
    editor.focus();
    editor.setSelectionRange(0, 0);
    await Promise.resolve();
  });
  expect(typedPalette(ownerDocument)).toBeNull();
  expect(ownerDocument).not.toBe(document);
  editorHarness.caret = 1;

  await act(async () => ownerDocument.dispatchEvent(new (ownerWindow as Window & typeof globalThis).Event("selectionchange")));
  expect(ownerDocument.activeElement).toBe(editor);
  expect(document.activeElement).not.toBe(editor);
  expect(optionLabels(required(typedPalette(ownerDocument)))).toEqual(["/help", "/learn", "/jump-session", "/cmd", "/clear", "/review", "/deploy"]);
  expect(ownerTimer).toHaveBeenCalledWith(expect.any(Function), 420);

  expect(await press(editor, "End")).toBe(true);
  expect(selectedOption(ownerDocument)?.textContent).toContain("/deploy");
  expect(await press(editor, "Enter")).toBe(true);
  await flushAnimationFrames();
  expect(editor.value).toBe("/deploy");
  expect(editorHarness.restoredCaret).toBe(editor.value.length);
  expect(ownerDocument.activeElement).toBe(editor);
  expect(typedPalette(ownerDocument)).toBeNull();
});

it("owns private drag position and cancellation in the mounted document without falling through to OS files", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const ownerDocument = required(frame.contentDocument);
  const ownerWindow = required(frame.contentWindow);
  installAnimationFrameRuntime(ownerWindow);
  const view = await mount(draft("anchor"), ownerDocument);
  const composer = required(ownerDocument.querySelector<HTMLElement>(".composer"));
  editorHarness.routeDropActions.splice(0);

  const payload = encodeWorkspaceEntryDragPayload({
    version: 1,
    workspaceId: "workspace-one",
    kind: "file",
    path: "src/main.ts",
    name: "main.ts"
  });
  let readable = false;
  const privateTransfer = dragTransfer({
    types: [WORKSPACE_ENTRY_DRAG_MIME],
    getData: (type) => readable && type === WORKSPACE_ENTRY_DRAG_MIME ? payload : ""
  });
  await dispatchDrag(composer, "dragenter", privateTransfer, 31, 47);
  await dispatchDrag(composer, "dragover", privateTransfer, 37, 53);
  expect(composer.querySelector(".composer__drop")).toBeNull();
  expect(editorHarness.routeDropActions.filter((action) => action["kind"] === "move").at(-1)).toEqual({ kind: "move", clientX: 37, clientY: 53 });

  readable = true;
  await dispatchDrag(composer, "drop", privateTransfer, 41, 59);
  const commits = editorHarness.routeDropActions.filter((action) => action["kind"] === "commit");
  expect(commits).toHaveLength(1);
  expect(commits[0]).toMatchObject({
    kind: "commit",
    clientX: 41,
    clientY: 59,
    insertion: { source: "workspace", attrs: { reference: "src/main.ts" } }
  });

  const file = new File(["ordinary"], "ordinary.txt", { type: "text/plain" });
  editorHarness.routeDropActions.splice(0);
  const malformed = dragTransfer({
    types: [WORKSPACE_ENTRY_DRAG_MIME, "Files"],
    files: [file],
    getData: (type) => type === WORKSPACE_ENTRY_DRAG_MIME ? "{bad" : ""
  });
  await dispatchDrag(composer, "drop", malformed, 1, 2);
  expect(editorHarness.routeDropActions.some((action) => action["kind"] === "commit")).toBe(false);
  expect(ownerDocument.querySelector(".attachment-list")).toBeNull();

  const ordinary = dragTransfer({ types: ["Files"], files: [file] });
  await dispatchDrag(composer, "drop", ordinary, 3, 4);
  await vi.waitFor(() => expect(ownerDocument.querySelector(".attachment-list")?.textContent).toContain("ordinary.txt"));

  editorHarness.routeDropActions.splice(0);
  readable = false;
  await dispatchDrag(composer, "dragenter", privateTransfer, 5, 6);
  await act(async () => ownerDocument.dispatchEvent(new (ownerWindow as Window & typeof globalThis).Event("dragend", { bubbles: true })));
  expect(editorHarness.routeDropActions.at(-1)).toEqual({ kind: "cancel" });
});

it("flushes a structured draft on task change and waits for it before quick return hydration", async () => {
  const source: ComposerDraft = {
    ...draft("Read @notes"),
    mentions: [{ id: "mention-one", kind: "workspace", reference: "notes.md", label: "notes", token: "@notes", workspaceId: "workspace-one" }],
    inlineMentionRanges: [{ mentionId: "mention-one", from: 5, to: 11 }],
    attachments: [{ id: "attachment-one", file: new File(["notes"], "notes.txt", { type: "text/plain" }), kind: "file" }]
  };
  const view = await mount(source);
  let finishSave!: () => void;
  vi.mocked(view.api.saveDraft).mockImplementationOnce((sessionId, draftValue) => new Promise<void>((resolve) => {
    finishSave = () => { view.drafts.set(sessionId, draftValue); resolve(); };
  }));
  await input(view.editor(), "Read @notes now", 15);
  await view.render({ ...baseSession, id: "task-two", name: "Task two", generation: 2n });
  await vi.waitFor(() => expect(finishSave).toBeTypeOf("function"));
  expect(view.editor().value).toBe("second task");
  const returningController = {
    ...view.api,
    saveDraft: (sessionId: string, draftValue: ComposerDraft) => view.api.saveDraft(sessionId, draftValue)
  };
  await view.render(baseSession, returningController);
  expect(view.editor().value).not.toBe("Read @notes now");
  await act(async () => { finishSave(); await Promise.resolve(); });
  await vi.waitFor(() => expect(view.editor().value).toBe("Read @notes now"));
  const persisted = view.drafts.get(baseSession.id);
  expect(persisted).toMatchObject({
    text: "Read @notes now",
    mentions: source.mentions,
    inlineMentionRanges: source.inlineMentionRanges,
    attachments: source.attachments,
    deliveryMode: source.deliveryMode
  });
  expect(persisted?.editorDocument).toEqual(plainTextToComposerDocument("Read @notes now"));
  expect(view.drafts.get("task-two")?.text).toBe("second task");

  await input(view.editor(), "Read @notes now!", 16);
  await view.hide();
  await view.render(baseSession);
  await vi.waitFor(() => expect(view.editor().value).toBe("Read @notes now!"));

  await input(view.editor(), "Read @notes now!!", 17);
  await act(async () => view.add().focus());
  await vi.waitFor(() => expect(view.drafts.get(baseSession.id)?.text).toBe("Read @notes now!!"));
  await input(view.editor(), "Read @notes now!!!", 18);
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  await vi.waitFor(() => expect(view.drafts.get(baseSession.id)?.text).toBe("Read @notes now!!!"));
});

it("recovers a failed outgoing save and keeps an earlier save before send clear", async () => {
  const view = await mount(draft("Start"));
  let failSave!: () => void;
  vi.mocked(view.api.saveDraft).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
    failSave = () => reject(new Error("Draft storage unavailable"));
  }));
  await input(view.editor(), "Unsent work", 11);
  await view.render({ ...baseSession, id: "task-two", name: "Task two", generation: 2n });
  await vi.waitFor(() => expect(failSave).toBeTypeOf("function"));
  await view.render(baseSession);
  await act(async () => { failSave(); await Promise.resolve(); });
  await vi.waitFor(() => expect(view.editor().value).toBe("Unsent work"));
  expect(document.querySelector("[role='alert']")?.textContent).toContain("Draft storage unavailable");
  await act(async () => view.add().focus());
  await vi.waitFor(() => expect(view.drafts.get(baseSession.id)?.text).toBe("Unsent work"));

  let finishSave!: () => void;
  vi.mocked(view.api.saveDraft).mockImplementationOnce((sessionId, draftValue) => new Promise<void>((resolve) => {
    finishSave = () => { view.drafts.set(sessionId, draftValue); resolve(); };
  }));
  await input(view.editor(), "Ready to send", 13);
  await act(async () => view.add().focus());
  await vi.waitFor(() => expect(finishSave).toBeTypeOf("function"));
  await act(async () => view.send().click());
  await act(async () => { finishSave(); await Promise.resolve(); });
  await vi.waitFor(() => expect(view.drafts.get(baseSession.id)?.text).toBe(""));
  expect(view.api.send).toHaveBeenCalledWith(baseSession.id, expect.objectContaining({ text: "Ready to send" }), { expectedGeneration: baseSession.generation });
  await view.render({ ...baseSession, id: "task-two", name: "Task two", generation: 2n });
  await view.render(baseSession);
  expect(view.editor().value).toBe("");
});

it("does not clear a newly returned task draft when an earlier reset completes", async () => {
  const view = await mount(draft("/clear"));
  let finishReset!: () => void;
  vi.mocked(view.api.resetSession).mockImplementationOnce(() => new Promise<void>((resolve) => { finishReset = resolve; }));
  await act(async () => view.send().click());
  await vi.waitFor(() => expect(finishReset).toBeTypeOf("function"));
  await view.render({ ...baseSession, id: "task-two", name: "Task two", generation: 2n });
  await view.render(baseSession);
  await vi.waitFor(() => expect(view.editor().value).toBe("/clear"));
  await input(view.editor(), "New task draft", 14);
  await act(async () => { finishReset(); await Promise.resolve(); });
  await act(async () => view.add().focus());
  await vi.waitFor(() => expect(view.drafts.get(baseSession.id)?.text).toBe("New task draft"));
  expect(view.editor().value).toBe("New task draft");
  expect(vi.mocked(view.api.saveDraft).mock.calls.at(-1)?.[1].text).toBe("New task draft");
});

it("does not clear a new mounted owner after the old reset completes", async () => {
  const view = await mount(draft("/clear"));
  let finishReset!: () => void;
  vi.mocked(view.api.resetSession).mockImplementationOnce(() => new Promise<void>((resolve) => { finishReset = resolve; }));
  await act(async () => view.send().click());
  await vi.waitFor(() => expect(finishReset).toBeTypeOf("function"));
  await view.hide();
  await view.render(baseSession);
  await vi.waitFor(() => expect(view.editor().value).toBe("/clear"));
  await input(view.editor(), "Fresh draft", 11);
  await act(async () => { finishReset(); await Promise.resolve(); });
  await act(async () => view.add().focus());
  await vi.waitFor(() => expect(view.drafts.get(baseSession.id)?.text).toBe("Fresh draft"));
  expect(view.editor().value).toBe("Fresh draft");
});

async function mount(initialDraft: ComposerDraft, ownerDocument: Document = document) {
  const drafts = new Map<string, ComposerDraft>([
    [baseSession.id, initialDraft],
    ["task-two", draft("second task")]
  ]);
  const api = {
    state: { connectionState: "connected", activeProfile: { serverId: "server-one", id: "profile-one" }, snapshot: { ...emptySnapshot(), targets: [baseTarget] }, preferences: DEFAULT_UI_PREFERENCES },
    readDraft: vi.fn(async (sessionId: string) => drafts.get(sessionId)),
    readDraftSnapshot: vi.fn(async (sessionId: string) => ({ revision: 1, draft: drafts.get(sessionId) })),
    saveDraft: vi.fn(async (sessionId: string, draftValue: ComposerDraft) => { drafts.set(sessionId, draftValue); }),
    send: vi.fn(async () => undefined),
    startSkillLearning: vi.fn(async (input: { readonly sourceSessionId?: string }) => ({
      id: "learning-run",
      revision: 1n,
      state: "distilling" as const,
      sourceKind: input.sourceSessionId === undefined ? "text" as const : "session" as const,
      backendId: baseSession.backendId,
      targetId: baseSession.targetId,
      ...(input.sourceSessionId === undefined ? {} : { sourceSessionId: input.sourceSessionId }),
      distillationSessionId: "distillation-task",
      summary: "Learning",
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2
    })),
    navigate: vi.fn(() => undefined),
    resetSession: vi.fn(async () => undefined),
    getVoiceInputCapabilities: vi.fn(async () => ({})),
    listCommands: vi.fn(async () => commands),
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
      ["input.file", { name: "input.file", supported: true, options: [], maximumItems: 5 }],
      ["runtime.user_shell", { name: "runtime.user_shell", supported: true, options: [] }],
      ["session.reset", { name: "session.reset", supported: true, options: [] }],
      ["review.isolated", { name: "review.isolated", supported: true, options: [] }],
      ["runtime.resources", { name: "runtime.resources", supported: true, options: ["skill"] }]
    ])
  };
  const workspace = { id: "workspace-one", targetId: baseSession.targetId, name: "Workspace", kind: "userProject" as const, serverPath: "/workspace", trusted: true, dirty: false, entries: [] };
  const host = ownerDocument.body.appendChild(ownerDocument.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  const actions: Promise<unknown>[] = [];
  const actionErrors: unknown[] = [];
  let activeController = api;
  const render = async (session: SessionView, nextController: AppController = activeController, nextBackend: BackendView = backend) => {
    activeController = nextController;
    await act(async () => root.render(<Composer
      controller={activeController}
      session={session}
      backend={nextBackend}
      autoFocus={false}
      queue={[]}
      workspace={workspace}
      extraDirectories={[]}
      resources={[{
        sessionId: session.id,
        id: "resource-skill",
        name: "Review",
        kind: "skill",
        discoveredRevision: "skill-revision",
        resourceVersion: "1",
        runtimeGeneration: 1
      }]}
      commands={commands}
      messageHistory={[]}
      t={(key) => key}
      runAction={(_key, action) => { actions.push(action().catch((error: unknown) => { actionErrors.push(error); })); }}
      onLocalSend={() => undefined}
    />));
  };
  await render(baseSession);
  return {
    api,
    backend,
    drafts,
    actions,
    actionErrors,
    render,
    hide: async () => { await act(async () => root.render(null)); },
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
    const prototype = Object.getPrototypeOf(element) as object;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.setSelectionRange(caret, caret);
    editorHarness.caret = caret;
    const ownerWindow = required(element.ownerDocument.defaultView) as Window & typeof globalThis;
    element.dispatchEvent(new ownerWindow.InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", isComposing }));
  });
}

async function press(element: HTMLElement, key: string): Promise<boolean> {
  const ownerWindow = required(element.ownerDocument.defaultView) as Window & typeof globalThis;
  const event = new ownerWindow.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key });
  await act(async () => element.dispatchEvent(event));
  return event.defaultPrevented;
}

async function flushAnimationFrames(): Promise<void> {
  await act(async () => {
    for (const callback of rafCallbacks.splice(0)) callback(0);
  });
}

async function settleActions(actions: readonly Promise<unknown>[]): Promise<void> {
  let index = 0;
  while (index < actions.length) {
    const action = actions[index];
    index += 1;
    await act(async () => { await action; });
  }
}

function typedPalette(ownerDocument: Document = document): HTMLElement | null {
  return ownerDocument.body.querySelector<HTMLElement>('[data-composer-typed-command-palette="true"]');
}

function selectedOption(ownerDocument: Document = document): HTMLElement | null {
  return typedPalette(ownerDocument)?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ?? null;
}

function installAnimationFrameRuntime(ownerWindow: Window): void {
  Object.defineProperties(ownerWindow, {
    requestAnimationFrame: {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      }
    },
    cancelAnimationFrame: { configurable: true, value: () => undefined }
  });
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

interface TestDragTransfer {
  readonly types: readonly string[];
  readonly files: readonly File[];
  dropEffect: string;
  getData(type: string): string;
}

function dragTransfer(options: {
  readonly types: readonly string[];
  readonly files?: readonly File[];
  readonly getData?: (type: string) => string;
}): TestDragTransfer {
  return {
    types: options.types,
    files: options.files ?? [],
    dropEffect: "none",
    getData: options.getData ?? (() => "")
  };
}

async function dispatchDrag(element: HTMLElement, type: string, transfer: TestDragTransfer, clientX: number, clientY: number): Promise<void> {
  const ownerWindow = required(element.ownerDocument.defaultView) as Window & typeof globalThis;
  const event = new ownerWindow.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: transfer },
    clientX: { value: clientX },
    clientY: { value: clientY },
    relatedTarget: { value: null }
  });
  await act(async () => element.dispatchEvent(event));
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected test value");
  return value;
}
