// @vitest-environment jsdom

import { act, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController, ControllerState } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type BackendView, type SessionView, type TargetView, type TimelineItemView, type WorkspaceView } from "../model.js";
import type { PrepareRewindDraft } from "./Composer.js";
import { SessionPane } from "./SessionPane.js";
import type { TimelineMessageEdit } from "./Timeline.js";
import type { RunAction, Translator } from "./types.js";

const prepareRewindDraft = vi.hoisted(() => vi.fn<PrepareRewindDraft>());

vi.mock("./Composer.js", async () => {
  const React = await import("react");
  return { Composer: (props: { readonly onDraftMutation?: () => void;
    readonly rewindDraftRef?: RefObject<PrepareRewindDraft | null> }) => {
    React.useImperativeHandle(props.rewindDraftRef, () => prepareRewindDraft);
    return React.createElement("button", { type: "button", onClick: props.onDraftMutation }, "Unsaved composer input");
  } };
});
vi.mock("./Timeline.js", async () => {
  const React = await import("react");
  const { UserMessageEditBox } = await import("./UserMessageEditBox.js");
  return {
    Timeline: (props: {
      readonly items: readonly TimelineItemView[];
      readonly messageEdit?: TimelineMessageEdit;
      readonly onPreviewMessageRewind?: (item: TimelineItemView) => void;
      readonly rewindToStartSupported?: boolean;
      readonly t: Translator;
    }) => {
      const item = props.items.at(-1);
      const edit = props.messageEdit;
      if (item === undefined || edit === undefined) return null;
      return React.createElement(React.Fragment, null,
      React.createElement("output", { "data-testid": "start-rewind-supported" }, String(props.rewindToStartSupported)),
      React.createElement("output", { "data-testid": "editable-message" }, edit.messageId ?? ""),
      React.createElement("button", { type: "button", onClick: () => props.onPreviewMessageRewind?.(item) }, "Preview rewind"),
      React.createElement(UserMessageEditBox, {
        initialText: item.text ?? "",
        t: props.t,
        onCancel: () => undefined,
        blockedReason: edit.blockedReason,
        onSubmit: (text: string) => edit.submit(item, text)
      }));
    }
  };
});

const roots: Root[] = [];
const t: Translator = (key) => key;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  prepareRewindDraft.mockReset();
});

describe("SessionPane dialogue rewind draft recovery", () => {
  it("restores the source text after the current dialogue rewind completes", async () => {
    const sourceSession = session(), sourceBackend = backend(), sourceMessage = completedMessage();
    let finish!: () => void;
    const navigateSessionBranch = vi.fn<AppController["navigateSessionBranch"]>(async (_sessionId, _target, options) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      options.onSameGenerationConfirmed?.();
    });
    const restore = vi.fn(async () => undefined);
    prepareRewindDraft.mockResolvedValueOnce(restore);
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, { readDraft: vi.fn(), saveDraft: vi.fn(), navigateSessionBranch });
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    await clickButton(container, "Preview rewind");
    await clickButton(document, "timeline.rewindDialogueOnly");
    expect(navigateSessionBranch).toHaveBeenCalledExactlyOnceWith(sourceSession.id, { kind: "native_entry", entryId: "entry-parent" },
      { expectedGeneration: sourceSession.generation, sourceMessage: { messageId: sourceMessage.id, eventId: sourceMessage.sourceEventId },
        onSameGenerationConfirmed: expect.any(Function) });
    expect(restore).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(restore).toHaveBeenCalledExactlyOnceWith(sourceMessage.text);
    expect(document.querySelector('[data-message-rewind-preview="true"]')).toBeNull();
  });

  it.each(["Rewind rejected", "Native result unknown"])("keeps the composer untouched when the original operation reports %s", async (reason) => {
    const sourceSession = session(), sourceBackend = backend(), sourceMessage = completedMessage();
    const navigateSessionBranch = vi.fn(async () => { throw new Error(reason); });
    const restore = vi.fn(async () => undefined);
    prepareRewindDraft.mockResolvedValueOnce(restore);
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, { readDraft: vi.fn(), saveDraft: vi.fn(), navigateSessionBranch });
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    await clickButton(container, "Preview rewind");
    await clickButton(document, "timeline.rewindDialogueOnly");
    expect(document.querySelector(".message-rewind-preview [role=alert]")?.textContent).toBe(reason);
    expect(restore).not.toHaveBeenCalled();
  });

  it("does not apply an old rewind result after leaving and returning to the task", async () => {
    const sourceSession = session(), sourceBackend = backend(), sourceMessage = completedMessage();
    let finish!: () => void;
    const navigateSessionBranch = vi.fn<AppController["navigateSessionBranch"]>(async (_sessionId, _target, options) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      options.onSameGenerationConfirmed?.();
    });
    const restore = vi.fn(async () => undefined);
    prepareRewindDraft.mockResolvedValueOnce(restore);
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, { readDraft: vi.fn(), saveDraft: vi.fn(), navigateSessionBranch });
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    await clickButton(container, "Preview rewind");
    await clickButton(document, "timeline.rewindDialogueOnly");
    expect(navigateSessionBranch).toHaveBeenCalledOnce();
    Reflect.set(controller.state, "navigationRevision", 3);
    await act(async () => finish());
    expect(restore).not.toHaveBeenCalled();
  });

  it("closes a successful dialogue rewind whose current binding cannot be confirmed", async () => {
    const sourceSession = session(), sourceBackend = backend(), sourceMessage = completedMessage();
    const navigateSessionBranch = vi.fn(async () => undefined);
    const restore = vi.fn(async () => undefined);
    prepareRewindDraft.mockResolvedValueOnce(restore);
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, { readDraft: vi.fn(), saveDraft: vi.fn(), navigateSessionBranch });
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    await clickButton(container, "Preview rewind");
    await clickButton(document, "timeline.rewindDialogueOnly");
    expect(navigateSessionBranch).toHaveBeenCalledOnce();
    expect(restore).not.toHaveBeenCalled();
    expect(document.querySelector('[data-message-rewind-preview="true"]')).toBeNull();
  });

  it("rejects a different durable event from the selected message row", async () => {
    const sourceSession = session(), sourceBackend = backend(), sourceMessage = completedMessage();
    const navigateSessionBranch = vi.fn(async () => undefined);
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, { readDraft: vi.fn(), saveDraft: vi.fn(), navigateSessionBranch });
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    await clickButton(container, "Preview rewind");
    Reflect.set(controller.state.snapshot, "timelineBySession", new Map([[sourceSession.id,
      [{ ...sourceMessage, sourceEventId: "replaced", completionCursor: 3n, text: "Different input" }]]]));
    await clickButton(document, "timeline.rewindDialogueOnly");
    expect(navigateSessionBranch).not.toHaveBeenCalled();
    expect(document.querySelector(".message-rewind-preview [role=alert]")?.textContent).toContain("timeline.rewindStale");
    expect(prepareRewindDraft).not.toHaveBeenCalled();
  });

  it("rewinds the loaded historical row when the owner snapshot has no transcript", async () => {
    const sourceSession = session(), sourceBackend = backend(), sourceMessage = completedMessage();
    const restore = vi.fn(async () => undefined); prepareRewindDraft.mockResolvedValueOnce(restore);
    const navigateSessionBranch = vi.fn<AppController["navigateSessionBranch"]>(async (_id, _target, options) => options.onSameGenerationConfirmed?.());
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, { readDraft: vi.fn(), saveDraft: vi.fn(), navigateSessionBranch });
    Reflect.set(controller.state.snapshot, "timelineBySession", new Map());
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    await clickButton(container, "Preview rewind"); await clickButton(document, "timeline.rewindDialogueOnly");
    expect(navigateSessionBranch).toHaveBeenCalledExactlyOnceWith(sourceSession.id, sourceMessage.nativeRewindBefore,
      { expectedGeneration: sourceSession.generation, sourceMessage: { messageId: sourceMessage.id, eventId: sourceMessage.sourceEventId },
        onSameGenerationConfirmed: expect.any(Function) });
    expect(restore).toHaveBeenCalledWith(sourceMessage.text);
  });

  it("finishes the dialogue rewind when the draft cannot be prepared and reports that separately", async () => {
    const sourceSession = session(), sourceBackend = backend(), sourceMessage = completedMessage();
    const navigateSessionBranch = vi.fn(async () => undefined);
    prepareRewindDraft.mockRejectedValueOnce(new Error("Draft storage unavailable"));
    const errors: unknown[] = [];
    const runAction: RunAction = (_key, action) => { void action().catch((error: unknown) => { errors.push(error); }); };
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, { readDraft: vi.fn(), saveDraft: vi.fn(), navigateSessionBranch });
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage, { runAction });
    await clickButton(container, "Preview rewind");
    await clickButton(document, "timeline.rewindDialogueOnly");
    expect(navigateSessionBranch).toHaveBeenCalledOnce();
    expect(errors).toEqual([expect.objectContaining({ message: "timeline.rewindDraftRestoreFailed" })]);
    expect(document.querySelector('[data-message-rewind-preview="true"]')).toBeNull();
  });

  it("keeps file-only restore independent of dialogue and the composer", async () => {
    const sourceSession = session(), sourceMessage = completedMessage();
    const originalBackend = backend();
    const sourceBackend = { ...originalBackend, capabilities: new Map([...originalBackend.capabilities,
      ["workspace.rewind", { name: "workspace.rewind", supported: true, options: [] }]]) };
    const workspace: WorkspaceView = { id: "workspace-one", targetId: sourceSession.targetId, name: "Project", kind: "userProject",
      serverPath: "/workspace", trusted: true, dirty: true, entries: [] };
    const navigateSessionBranch = vi.fn(async () => undefined);
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, { readDraft: vi.fn(), saveDraft: vi.fn(), navigateSessionBranch });
    controller.listWorkspaceChangeSets = vi.fn<AppController["listWorkspaceChangeSets"]>(async () => [{ id: "change", runId: sourceMessage.runId!, turnId: "turn", changeCount: 1,
      completeBaseline: true, gaps: [], capturedAt: 1 }]);
    controller.previewWorkspaceRewind = vi.fn<AppController["previewWorkspaceRewind"]>(async () => ({ id: "preview", changeSetId: "change", safety: "safe",
      inversePaths: ["notes.md"], gaps: [], conflicts: [], dialogueOnlyAvailable: true }));
    const execute = vi.fn<AppController["executeWorkspaceRewind"]>(async () => undefined);
    controller.executeWorkspaceRewind = execute;
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage, { workspace });
    await clickButton(container, "Preview rewind");
    await clickButton(document, "timeline.rewindFilesOnly");
    expect(execute).toHaveBeenCalledExactlyOnceWith(workspace.id, "preview", "change", false);
    expect(navigateSessionBranch).not.toHaveBeenCalled();
    expect(prepareRewindDraft).not.toHaveBeenCalled();
  });
});

describe("SessionPane edited-message submission", () => {
  it.each([false, true])("renders first-turn edit and rewind from the current Target scope: remote=%s", (remote) => {
    const sourceSession = session(), sourceBackend = startBackend(), sourceMessage = startMessage();
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, {
      readDraft: vi.fn(async () => durableDraft()), saveDraft: vi.fn(), navigateSessionBranch: vi.fn()
    });
    if (remote) Reflect.set(controller.state.snapshot.targets[0]!, "remoteWorkspace", remoteWorkspace());
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    expect(container.querySelector('[data-testid="start-rewind-supported"]')?.textContent).toBe(String(!remote));
    expect(container.querySelector('[data-testid="editable-message"]')?.textContent).toBe(remote ? "" : sourceMessage.id);
  });

  it.each(["preview", "draft read", "before dispatch"] as const)("rejects a first-turn Target becoming remote during %s", async (boundary) => {
    const sourceSession = session(), sourceBackend = startBackend(), sourceMessage = startMessage();
    let finishRead!: (value: ReturnType<typeof durableDraft>) => void;
    const readDraft = vi.fn(() => boundary === "draft read"
      ? new Promise<ReturnType<typeof durableDraft>>(resolve => { finishRead = resolve; })
      : Promise.resolve(durableDraft()));
    const dispatch = vi.fn();
    const saveDraft = vi.fn();
    const navigateSessionBranch = vi.fn();
    const send = vi.fn<AppController["send"]>(async (_id, _draft, admission) => {
      Reflect.set(controller.state.snapshot.targets[0]!, "remoteWorkspace", remoteWorkspace());
      admission.messageEdit?.assertCurrent();
      dispatch();
    });
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, { readDraft, saveDraft, navigateSessionBranch, send });
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    if (boundary === "preview") {
      await clickButton(container, "Preview rewind");
      Reflect.set(controller.state.snapshot.targets[0]!, "remoteWorkspace", remoteWorkspace());
      await clickButton(document, "timeline.rewindDialogueOnly");
      expect(document.querySelector("[role=alert]")?.textContent).toContain("timeline.rewindStale");
    } else {
      await clickButton(container, "timeline.editSend");
      if (boundary === "draft read") {
        await vi.waitFor(() => expect(readDraft).toHaveBeenCalledOnce());
        Reflect.set(controller.state.snapshot.targets[0]!, "remoteWorkspace", remoteWorkspace());
        await act(async () => finishRead(durableDraft()));
      }
      expect(container.querySelector("[role=alert]")?.textContent).toContain("timeline.editStale");
    }
    expect(navigateSessionBranch).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps the first-turn rewind confirmation bound to its document lifetime: pagehide=%s", async (hide) => {
    const sourceSession = session(), sourceBackend = startBackend(), sourceMessage = startMessage();
    const navigateSessionBranch = vi.fn(async () => undefined);
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, {
      readDraft: vi.fn(async () => undefined), saveDraft: vi.fn(), navigateSessionBranch
    });
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    await clickButton(container, "Preview rewind");
    if (hide) {
      await act(async () => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pageshow")); });
      expect(document.querySelector('[data-message-rewind-preview="true"]')).toBeNull();
      expect(navigateSessionBranch).not.toHaveBeenCalled();
    } else {
      await clickButton(document, "timeline.rewindDialogueOnly");
      expect(navigateSessionBranch).toHaveBeenCalledExactlyOnceWith(sourceSession.id, { kind: "session_start" },
        { expectedGeneration: sourceSession.generation, sourceMessage: { messageId: sourceMessage.id, eventId: sourceMessage.sourceEventId } });
    }
  });

  it.each([false, true])("sends the reloaded last message with its exact rewind boundary: first turn=%s", async (first) => {
    const sourceSession = session(), sourceBackend = first ? startBackend() : backend(), sourceMessage = first ? startMessage() : message();
    const saveDraft = vi.fn(), navigateSessionBranch = vi.fn();
    const send = vi.fn<AppController["send"]>(async (_id, _draft, admission) => { admission.messageEdit?.assertCurrent(); });
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, { readDraft: vi.fn(async () => durableDraft()), saveDraft, navigateSessionBranch, send });
    Reflect.set(controller.state.snapshot, "timelineBySession", new Map());
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    await clickButton(container, "timeline.editSend");
    expect(send).toHaveBeenCalledExactlyOnceWith(sourceSession.id, expect.objectContaining({ text: sourceMessage.text, deliveryMode: "prompt" }),
      { expectedGeneration: sourceSession.generation, messageEdit: {
        sourceMessageId: sourceMessage.id, sourceEventId: sourceMessage.sourceEventId, target: sourceMessage.nativeRewindBefore,
        operationId: expect.any(String), assertCurrent: expect.any(Function)
      } });
    expect(saveDraft).not.toHaveBeenCalled();
    expect(navigateSessionBranch).not.toHaveBeenCalled();
    expect(controller.messageEditDrafts.finish).toHaveBeenCalledExactlyOnceWith(sourceSession.id, expect.any(String), false);
  });

  it.each(["generation", "gateway", "navigation ABA", "pagehide", "new live input", "replaced live event", "local draft"] as const)(
    "retires an edit while its draft read is pending across a %s change", async (boundary) => {
      const sourceSession = session(), sourceBackend = backend(), sourceMessage = message();
      let finish!: (value: ReturnType<typeof durableDraft>) => void;
      const readDraft = vi.fn(() => new Promise<ReturnType<typeof durableDraft>>(resolve => { finish = resolve; }));
      const send = vi.fn(), saveDraft = vi.fn(), navigateSessionBranch = vi.fn();
      const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, { readDraft, saveDraft, navigateSessionBranch, send });
      Reflect.set(controller.state.snapshot, "timelineBySession", new Map());
      const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
      await clickButton(container, "timeline.editSend");
      await vi.waitFor(() => expect(readDraft).toHaveBeenCalledOnce());
      if (boundary === "generation") Reflect.set(sourceSession, "generation", 2n);
      else if (boundary === "gateway") controller.send = vi.fn();
      else if (boundary === "navigation ABA") Reflect.set(controller.state, "navigationRevision", 2);
      else if (boundary === "new live input") Reflect.set(controller.state.snapshot, "timelineBySession", new Map([[sourceSession.id,
        [{ ...message(), id: "new-user", sourceEventId: "new-user-event", sequence: 5n, completionCursor: 5n }]]]));
      else if (boundary === "replaced live event") Reflect.set(controller.state.snapshot, "timelineBySession", new Map([[sourceSession.id,
        [{ ...sourceMessage, sourceEventId: "replaced-user-event", completionCursor: 5n }]]]));
      else if (boundary === "local draft") await clickButton(container, "Unsaved composer input");
      else { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pageshow")); }
      await act(async () => finish(durableDraft()));
      expect(container.querySelector("[role=alert]")?.textContent).toContain("timeline.editStale");
      expect(saveDraft).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(navigateSessionBranch).not.toHaveBeenCalled();
    }
  );

  it.each(["draft unavailable", "send rejected"] as const)("keeps the inline editor and existing draft on %s", async (failure) => {
    const sourceSession = session(), sourceBackend = backend(), sourceMessage = message();
    const readDraft = vi.fn(async () => { if (failure === "draft unavailable") throw new Error(failure); return durableDraft(); });
    const send = vi.fn(async () => { throw new Error(failure); });
    const saveDraft = vi.fn(), navigateSessionBranch = vi.fn();
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, { readDraft, saveDraft, navigateSessionBranch, send });
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    await clickButton(container, "timeline.editSend");
    expect(container.querySelector("[role=alert]")?.textContent).toContain(failure);
    expect(send).toHaveBeenCalledTimes(failure === "draft unavailable" ? 0 : 1);
    expect(saveDraft).not.toHaveBeenCalled();
    expect(navigateSessionBranch).not.toHaveBeenCalled();
    const textarea = required(container.querySelector<HTMLTextAreaElement>(".message-user-edit textarea"));
    expect(textarea.value).toBe(sourceMessage.text);
    expect(textarea.disabled).toBe(false);
  });

  it("does not send after the original draft revision is superseded", async () => {
    const sourceSession = session(), sourceBackend = backend(), sourceMessage = message();
    const send = vi.fn();
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, {
      readDraft: vi.fn(async () => durableDraft()), saveDraft: vi.fn(), navigateSessionBranch: vi.fn(), send,
      messageEditDrafts: { read: vi.fn(async () => undefined), stage: vi.fn(async () => false), finish: vi.fn() }
    });
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    await clickButton(container, "timeline.editSend");
    expect(controller.messageEditDrafts.stage).toHaveBeenCalledExactlyOnceWith(sourceSession.id,
      expect.objectContaining({ sourceEventId: sourceMessage.sourceEventId, expectedGeneration: sourceSession.generation }), 1);
    expect(send).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("timeline.editStale");
  });

  it.each([false, true])(
    "requests recovery for its own saved edit after a terminal partial failure: failed storage=%s", async (failedStorage) => {
      const sourceSession = session(), sourceBackend = backend(), sourceMessage = message();
      let reject!: (error: Error) => void;
      const send = vi.fn(() => new Promise<void>((_resolve, onError) => { reject = onError; }));
      const finish = vi.fn(async () => { if (failedStorage) throw new Error("Storage error"); });
      const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, {
        readDraft: vi.fn(async () => undefined), saveDraft: vi.fn(), navigateSessionBranch: vi.fn(), send,
        messageEditDrafts: { read: vi.fn(async () => undefined), stage: vi.fn(async () => true), finish }
      });
      const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
      await clickButton(container, "timeline.editSend");
      await act(async () => reject(Object.assign(new Error("Native history synchronization failed"), { code: "NATIVE_NAVIGATION_SYNC_UNKNOWN" })));
      expect(finish).toHaveBeenCalledExactlyOnceWith(sourceSession.id, expect.any(String), true);
      expect(container.querySelector("[role=alert]")?.textContent).toContain(failedStorage
        ? "timeline.editDraftRestoreFailed" : "Native history synchronization failed");
    }
  );

  it("checks the original operation after an uncertain edit without admitting another input", async () => {
    const sourceSession = session(), sourceBackend = backend(), sourceMessage = message();
    const send = vi.fn<AppController["send"]>(async () => {
      throw Object.assign(new Error("Lost acknowledgement"), { code: "MESSAGE_EDIT_RESULT_UNKNOWN" });
    });
    const confirmMessageEdit = vi.fn(async () => true);
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, {
      readDraft: vi.fn(async () => undefined), saveDraft: vi.fn(), navigateSessionBranch: vi.fn(), send, confirmMessageEdit
    });
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    await clickButton(container, "timeline.editSend");
    const control = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "timeline.editSend");
    expect(control?.disabled).toBe(true);
    await clickButton(container, "timeline.checkEditResult");
    const [id, , admission] = send.mock.calls[0]!;
    expect(confirmMessageEdit).toHaveBeenCalledExactlyOnceWith(id, admission.expectedGeneration,
      expect.objectContaining({ operationId: admission.messageEdit?.operationId, sourceEventId: sourceMessage.sourceEventId }));
    expect(send).toHaveBeenCalledOnce();
    expect(controller.saveDraft).not.toHaveBeenCalled();
    expect(controller.messageEditDrafts.stage).toHaveBeenCalledExactlyOnceWith(id,
      expect.objectContaining({ operationId: admission.messageEdit?.operationId }), 1);
    expect(controller.messageEditDrafts.finish).toHaveBeenCalledExactlyOnceWith(id, admission.messageEdit?.operationId, false);
  });
});

function durableDraft() {
  return {
    text: "Existing composer draft",
    attachments: [],
    mentions: [],
    extraDirectoryIds: ["directory-one"],
    deliveryMode: "prompt" as const
  };
}

function mountPane(
  controller: AppController,
  sourceSession: SessionView,
  sourceBackend: BackendView,
  sourceMessage: TimelineItemView,
  options: { readonly workspace?: WorkspaceView; readonly runAction?: RunAction } = {}
): HTMLDivElement {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<SessionPane
    controller={controller}
    session={sourceSession}
    backend={sourceBackend}
    workspace={options.workspace}
    models={[]}
    timeline={[sourceMessage]}
    timelineHasEarlier={false}
    timelineHistoryLoading={false}
    onLoadEarlierTimeline={async () => undefined}
    extensionWidgets={[]}
    extensionStatuses={[]}
    queue={[]}
    extraDirectories={[]}
    resources={[]}
    commandRefreshSignal={[]}
    remainingInteractions={0}
    navigationOpen
    inspectorOpen
    t={t}
    runAction={options.runAction ?? ((_key, action) => { void action(); })}
    onOpenNavigation={() => undefined}
    onOpenInspector={() => undefined}
    onRename={() => undefined}
    onArchive={() => undefined}
    onDelete={() => undefined}
  />));
  return container;
}

function controllerFor(
  sourceSession: SessionView,
  sourceBackend: BackendView,
  sourceMessage: TimelineItemView,
  methods: Pick<AppController, "readDraft" | "saveDraft" | "navigateSessionBranch">
    & Partial<Pick<AppController, "send" | "confirmMessageEdit" | "messageEditDrafts">>
): AppController {
  const snapshot = {
    ...emptySnapshot(),
    revision: 1n,
    sessions: [sourceSession],
    backends: [sourceBackend],
    targets: [target()],
    timelineBySession: new Map([[sourceSession.id, [sourceMessage]]])
  };
  const state: ControllerState = {
    ready: true,
    connectionState: "connected",
    profiles: [],
    machineCaches: [],
    machinePresenceByProfile: {},
    discoveredNodes: [],
    discoveryState: "idle",
    managedOrchestratorStatus: undefined,
    automaticConnectionAvailable: false,
    snapshot,
    route: { kind: "session", sessionId: sourceSession.id },
    preferences: DEFAULT_UI_PREFERENCES,
    systemLocale: "en",
    effectiveLocale: "en",
    extensionNotifications: []
  };
  let revision = 1;
  return {
    messageEditDrafts: { read: vi.fn(async () => undefined), stage: vi.fn(async () => true), finish: vi.fn(async () => undefined) },
    state, ...methods,
    listPartners: async () => ({ partners: [] }),
    getPortableReplacementCleanup: async () => undefined,
    readDraftSnapshot: async (sessionId: string) => ({ revision, draft: await methods.readDraft(sessionId) }),
    saveDraftIfRevision: async (sessionId: string, draft: Parameters<AppController["saveDraft"]>[1], expectedRevision: number) => {
      if (expectedRevision !== revision) return undefined;
      await methods.saveDraft(sessionId, draft);
      return ++revision;
    }
  } as unknown as AppController;
}

function backend(): BackendView {
  return {
    id: "backend-one",
    name: "Backend",
    version: "1",
    health: "healthy",
    capabilities: new Map([["session.rewind", { name: "session.rewind", supported: true, options: [] }]])
  };
}

function startBackend(): BackendView {
  const original = backend();
  return { ...original, capabilities: new Map([...original.capabilities, ["session.rewind_to_start", { name: "session.rewind_to_start", supported: true, options: ["service_node_only"] }]]) };
}

function startMessage(): TimelineItemView {
  return { ...message(), nativeParentEntryId: undefined, nativeRewindBefore: { kind: "session_start" } };
}

function target(): TargetView {
  return { id: "target-one", revision: 1n, backendId: "backend-one", name: "Project", workspaceId: "workspace-one", workspaceName: "Workspace", trusted: true, pinned: false, archived: false };
}

function remoteWorkspace(): NonNullable<TargetView["remoteWorkspace"]> {
  return { kind: "ssh", hostTargetId: "host-target", hostId: "host", workspaceRoot: "/workspace" };
}

function session(): SessionView {
  return {
    id: "session-one",
    backendId: "backend-one",
    targetId: "target-one",
    name: "Task",
    state: "idle",
    pinned: false,
    archived: false,
    generation: 1n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: 1_000
  };
}

function message(): TimelineItemView {
  return {
    id: "user-one",
    sourceEventId: "source-user-event",
    completionCursor: 1n,
    sequence: 1n,
    kind: "user",
    text: "Keep this edit in place",
    nativeParentEntryId: "entry-parent",
    nativeRewindBefore: { kind: "native_entry", entryId: "entry-parent" },
    createdAt: 1_000
  };
}

function completedMessage(): TimelineItemView {
  return { ...message(), sourceEventId: "complete", completionCursor: 2n, runId: "run" };
}

async function clickButton(container: ParentNode, label: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label);
  if (button === undefined) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Required element was not rendered.");
  return value;
}
