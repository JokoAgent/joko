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
import type { NewSessionSubmissionOwner } from "../new-session-flow.js";
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

interface RenderedNewSessionPage {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly render: (snapshot: AppSnapshot) => Promise<void>;
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
  it("advertises /learn only for a Skill-capable selected Target", async () => {
    const onSubmit = vi.fn(async (_session: DelayedNewSessionDraft, _input: ComposerDraft, _owner: NewSessionSubmissionOwner) => undefined);
    await renderPage(onSubmit);
    await edit("/lea", 4, false);
    expect(commandOptions()).toHaveLength(0);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    { text: "/learn", instruction: "", evidence: "createdSession" },
    { text: "/learn Preserve the release checklist", instruction: "Preserve the release checklist", evidence: "freeText" }
  ] as const)("submits a typed local learning disposition without flattening $evidence evidence", async ({ text, instruction, evidence }) => {
    const onSubmit = vi.fn(async (_session: DelayedNewSessionDraft, _input: ComposerDraft, _owner: NewSessionSubmissionOwner) => undefined);
    await renderPage(onSubmit, { skillCapable: true });
    await edit(text, text.length, false);
    if (text === "/learn") await key("Escape");
    await key("Enter");

    expect(onSubmit).toHaveBeenCalledOnce();
    const [created, input, owner] = onSubmit.mock.calls[0]!;
    expect(created.selection).toEqual({ kind: "target", targetId: "target-1" });
    expect(input).toMatchObject({ text, attachments: [], browserComments: [], mentions: [] });
    expect(owner.firstInputDisposition).toEqual({
      kind: "learn",
      requestId: expect.any(String),
      backendId: "backend-1",
      instruction,
      evidence,
      application: { kind: "eligible" }
    });
  });

  it("lets a loaded runtime Skill /learn command win ordinary first-input send", async () => {
    const onSubmit = vi.fn(async (_session: DelayedNewSessionDraft, _input: ComposerDraft, _owner: NewSessionSubmissionOwner) => undefined);
    await renderPage(onSubmit, {
      skillCapable: true,
      commands: [{
        id: "runtime-learn", name: "learn", description: "Runtime learning", source: "skill", loaded: true
      }]
    });
    await edit("/learn runtime-owned", 20, false);
    await key("Enter");

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]![1].text).toBe("/learn runtime-owned");
    expect(onSubmit.mock.calls[0]![2].firstInputDisposition).toMatchObject({
      kind: "learn",
      instruction: "runtime-owned",
      application: { kind: "eligible" }
    });
  });

  it.each([
    { text: "/goal", action: "open", expectedText: undefined },
    { text: "/goal Ship the complete release", action: "set", expectedText: "Ship the complete release" },
    { text: "/goal clear", action: "clear", expectedText: undefined }
  ] as const)("submits the Home $action objective command for fresh-runtime ownership reconciliation", async ({ text, action, expectedText }) => {
    const onSubmit = vi.fn(async (_session: DelayedNewSessionDraft, _input: ComposerDraft, _owner: NewSessionSubmissionOwner) => undefined);
    await renderPage(onSubmit);
    await edit(text, text.length, false);
    if (text === "/goal") await key("Escape");
    await key("Enter");

    expect(onSubmit).toHaveBeenCalledOnce();
    const [, input, owner] = onSubmit.mock.calls[0]!;
    expect(input.text).toBe(text);
    expect(owner.firstInputDisposition).toMatchObject({
      kind: "objective",
      source: "slash",
      action,
      ...(expectedText === undefined ? {} : { text: expectedText, limits: { noProgressTurnLimit: 3 } })
    });
  });

  it("offers /goal for managed dialogue creation", async () => {
    const onSubmit = vi.fn(async (_session: DelayedNewSessionDraft, _input: ComposerDraft, _owner: NewSessionSubmissionOwner) => undefined);
    await renderPage(onSubmit, { dialogue: true });
    await edit("/goal Keep the dialogue moving", 30, false);
    await key("Enter");

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]![0].selection).toEqual({ kind: "dialogue", backendId: "backend-1" });
    expect(onSubmit.mock.calls[0]![2].firstInputDisposition).toMatchObject({
      kind: "objective",
      source: "slash",
      action: "set",
      text: "Keep the dialogue moving"
    });
  });

  it("opens New objective from Add with a trimmed prefill and keeps the composer on failure", async () => {
    const onSubmit = vi.fn(async (_session: DelayedNewSessionDraft, _input: ComposerDraft, _owner: NewSessionSubmissionOwner) => { throw new Error("Objective set failed"); });
    await renderPage(onSubmit, { attachmentActions: true });
    await edit("  Preserve this draft  ", 23, false);
    await attachFile("context.txt");

    await openNewObjectiveDialog();
    let textarea = required(document.querySelector<HTMLTextAreaElement>(".objective-dialog textarea"));
    expect(textarea.value).toBe("Preserve this draft");
    await clickButton("common.cancel");
    expect(document.querySelector(".objective-dialog")).toBeNull();
    expect(editorElement?.textContent).toBe("Preserve this draft");
    expect(document.body.textContent).toContain("context.txt");

    await openNewObjectiveDialog();
    textarea = required(document.querySelector<HTMLTextAreaElement>(".objective-dialog textarea"));
    await changeValue(textarea, "Finish from the explicit dialog");
    await clickButton("objective.start");
    await act(async () => vi.waitFor(() => expect(document.querySelector(".objective-dialog [role='alert']")?.textContent).toContain("Objective set failed")));

    expect(document.querySelector(".objective-dialog")).not.toBeNull();
    expect(editorElement?.textContent).toBe("Preserve this draft");
    expect(document.body.textContent).toContain("context.txt");
    expect(onSubmit).toHaveBeenCalledOnce();
    const [, input, owner] = onSubmit.mock.calls[0]!;
    expect(input).toMatchObject({ text: "/goal Finish from the explicit dialog", attachments: [expect.objectContaining({ file: expect.objectContaining({ name: "context.txt" }) })] });
    expect(owner.firstInputDisposition).toMatchObject({
      kind: "objective",
      source: "dialog",
      action: "set",
      text: "Finish from the explicit dialog",
      limits: { noProgressTurnLimit: 3 }
    });
  });

  it("lets the explicit Add action bypass a loaded /goal Skill, accepts an empty composer, and clears accepted draft media", async () => {
    const runtimeGoal = { id: "goal-skill", name: "goal", description: "Runtime objective", source: "skill" as const, loaded: true, resourceId: "skill-goal" };
    const onSubmit = vi.fn(async (_session: DelayedNewSessionDraft, _input: ComposerDraft, owner: NewSessionSubmissionOwner) => {
      expect(owner.firstInputDisposition).toMatchObject({ kind: "objective", source: "dialog", action: "set", text: "Finish autonomously" });
      owner.onFirstInputAccepted?.({ kind: "sent", sessionId: "session-1" });
    });
    await renderPage(onSubmit, { attachmentActions: true, commands: [runtimeGoal] });
    await attachFile("evidence.txt");
    await openNewObjectiveDialog();
    const textarea = required(document.querySelector<HTMLTextAreaElement>(".objective-dialog textarea"));
    expect(textarea.value).toBe("");
    await changeValue(textarea, "Finish autonomously");
    await clickButton("objective.start");
    await act(async () => vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce()));

    expect(editorElement?.textContent).toBe("");
    expect(document.body.textContent).not.toContain("evidence.txt");
    expect(document.querySelector(".objective-dialog")).toBeNull();
  });

  it("keeps an explicit Objective submission alive across createSession's unrelated snapshot refresh", async () => {
    let view!: Awaited<ReturnType<typeof renderPage>>;
    const onSubmit = vi.fn(async (_session: DelayedNewSessionDraft, _input: ComposerDraft, owner: NewSessionSubmissionOwner) => {
      await view.render({
        ...view.snapshot,
        revision: view.snapshot.revision + 1n,
        sessions: [...view.snapshot.sessions, {
          id: "session-1",
          backendId: "backend-1",
          targetId: "target-1",
          name: "New task",
          state: "idle",
          pinned: false,
          archived: false,
          generation: 1n,
          fastMode: false,
          permissionMode: "ask",
          planMode: false,
          updatedAt: 1
        }]
      });
      expect(owner.signal.aborted).toBe(false);
      expect(owner.isCurrent()).toBe(true);
      owner.onFirstInputAccepted?.({
        kind: "objectiveSet",
        requestId: "dialog-objective",
        sessionId: "session-1",
        sessionGeneration: 1n,
        objective: {
          sessionId: "session-1",
          text: "Finish after refresh",
          status: "active",
          noProgressTurnLimit: 3,
          turnsUsed: 0,
          tokensUsed: 0,
          noProgressTurns: 0,
          ownerGeneration: 1n,
          sessionGeneration: 1n,
          startedAt: 1,
          revision: 1n
        }
      });
    });
    view = await renderPage(onSubmit);
    await openNewObjectiveDialog();
    await changeValue(required(document.querySelector<HTMLTextAreaElement>(".objective-dialog textarea")), "Finish after refresh");
    await clickButton("objective.start");

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(document.querySelector(".objective-dialog")).toBeNull());
    expect(editorElement?.textContent).toBe("");
  });

  it("retires an in-flight explicit Objective when text input capability is revoked", async () => {
    let owner!: NewSessionSubmissionOwner;
    const onSubmit = vi.fn(async (_session: DelayedNewSessionDraft, _input: ComposerDraft, currentOwner: NewSessionSubmissionOwner) => {
      owner = currentOwner;
      await new Promise<void>((_resolve, reject) => currentOwner.signal.addEventListener("abort", () => reject(new DOMException("Retired", "AbortError")), { once: true }));
    });
    const view = await renderPage(onSubmit);
    await openNewObjectiveDialog();
    await changeValue(required(document.querySelector<HTMLTextAreaElement>(".objective-dialog textarea")), "Must stop on capability drift");
    await clickButton("objective.start");
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());

    const currentBackend = required(view.snapshot.backends[0]);
    const capabilities = new Map(currentBackend.capabilities);
    capabilities.set("input.text", { name: "input.text", supported: false, options: [] });
    await act(async () => view.render({
      ...view.snapshot,
      revision: view.snapshot.revision + 1n,
      backends: [{ ...currentBackend, capabilities }]
    }));

    await vi.waitFor(() => expect(owner.signal.aborted).toBe(true));
    expect(document.querySelector(".objective-dialog")).toBeNull();
  });

  it("retires the Add objective dialog with the initiating Document epoch", async () => {
    const onSubmit = vi.fn(async () => undefined);
    await renderPage(onSubmit);
    await openNewObjectiveDialog();
    expect(document.querySelector(".objective-dialog")).not.toBeNull();

    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(document.querySelector(".objective-dialog")).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    { text: "/learn hub:catalog-skill", message: "Catalog Skill identifiers", structured: false },
    { text: "/learn preserve this", message: "accepts text only", structured: true }
  ] as const)("marks out-of-scope or structured learning input for post-create runtime reconciliation", async ({ text, structured }) => {
    const onSubmit = vi.fn(async (_session: DelayedNewSessionDraft, _input: ComposerDraft, _owner: NewSessionSubmissionOwner) => undefined);
    await renderPage(onSubmit, { skillCapable: true });
    if (structured === true) {
      const element = required(editorElement);
      element.textContent = text;
      setCaret(element, text.length);
      await act(async () => {
        required(editorProps).onDocumentChange({
          type: "doc",
          content: [{
            type: "paragraph",
            content: [{ type: "composerPastedText", attrs: { text, display: "Pasted text" } }]
          }]
        }, false, (ranges) => ranges);
        await flush();
      });
    } else await edit(text, text.length, false);
    await key("Enter");

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(editorElement?.textContent).toBe(text);
    expect(onSubmit.mock.calls[0]![2].firstInputDisposition).toMatchObject({
      kind: "learn",
      application: { kind: "rejected", reason: structured ? "structured" : "hub" }
    });
  });

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
    expect(commandOptions()).toHaveLength(3);
    await key("ArrowDown");
    await key("ArrowDown");
    expect(commandOptions()[2]?.getAttribute("aria-selected")).toBe("true");
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
  onSubmit: (session: DelayedNewSessionDraft, input: ComposerDraft, owner: NewSessionSubmissionOwner) => Promise<void>,
  options: {
    readonly pending?: PendingExtensionUseView;
    readonly getExtension?: AppController["getExtension"];
    readonly clearPendingExtensionUse?: AppController["clearPendingExtensionUse"];
    readonly attachmentActions?: boolean;
    readonly skillCapable?: boolean;
    readonly commands?: AppSnapshot["commands"];
    readonly dialogue?: boolean;
  } = {}
): Promise<RenderedNewSessionPage> {
  const snapshotValue = snapshot(options.attachmentActions === true, options.skillCapable === true, options.commands);
  const controllerValue = {
    state: {
      connectionState: "connected",
      connectionGeneration: 1,
      activeProfile: { id: "profile-one", serverId: "server-one", deviceId: "device-one", name: "Local", origin: "https://localhost" },
      route: { kind: "newSession" as const },
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
  };
  const controller = controllerValue as unknown as AppController;
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  const renderNode = (nextSnapshot: AppSnapshot): void => {
    controllerValue.state.snapshot = nextSnapshot;
    root.render(<NewSessionPage
      controller={controller}
      snapshot={nextSnapshot}
      initialDialogueBackendId={options.dialogue === true ? "backend-1" : undefined}
      navigationOpen
      t={(key) => key}
      onOpenNavigation={vi.fn()}
      onClose={vi.fn()}
      onSubmit={onSubmit}
    />);
  };
  const render = async (nextSnapshot: AppSnapshot): Promise<void> => {
    renderNode(nextSnapshot);
    await flush();
  };
  await act(async () => {
    renderNode(snapshotValue);
    await flush();
  });
  await vi.waitFor(() => {
    expect(editorElement).not.toBeNull();
  });
  required(editorElement).focus();
  return { controller, snapshot: snapshotValue, render };
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

async function attachFile(name: string): Promise<void> {
  const input = required(document.querySelector<HTMLInputElement>(".new-task-composer input[type='file']"));
  await act(async () => {
    dispatchGamepadOwnedAction(document, "add-files");
    await flush();
  });
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["evidence"], name, { type: "text/plain" })]
  });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
}

async function openNewObjectiveDialog(): Promise<void> {
  await act(async () => {
    required(document.querySelector<HTMLButtonElement>(".composer-add-menu__trigger")).click();
    await flush();
  });
  const action = [...document.querySelectorAll<HTMLButtonElement>(".composer-add-menu__action")]
    .find((button) => button.textContent?.includes("objective.newAction"));
  await act(async () => {
    required(action).click();
    await flush();
  });
}

async function changeValue(element: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
}

async function clickButton(text: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === text);
  await act(async () => {
    required(button).click();
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

function snapshot(
  attachmentActions = false,
  skillCapable = false,
  commands?: AppSnapshot["commands"]
): AppSnapshot {
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
        ...(skillCapable ? [
          ["runtime.resources", { name: "runtime.resources", supported: true, options: ["skill"] }]
        ] as const : []),
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
    commands: commands ?? [
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
