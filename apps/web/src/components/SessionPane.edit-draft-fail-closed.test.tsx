// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController, ControllerState } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type BackendView, type SessionView, type TimelineItemView } from "../model.js";
import { SessionPane } from "./SessionPane.js";
import type { Translator } from "./types.js";

vi.mock("./Composer.js", async () => {
  const React = await import("react");
  return { Composer: (props: { readonly draftReplacement?: { readonly text: string }; readonly onDraftMutation?: () => void }) => React.createElement(React.Fragment, null,
    React.createElement("button", { type: "button", onClick: props.onDraftMutation }, "Unsaved composer input"),
    props.draftReplacement === undefined ? null : React.createElement("output", { "data-testid": "edit-replacement" }, props.draftReplacement.text)) };
});
vi.mock("./Timeline.js", async () => {
  const React = await import("react");
  const { UserMessageEditBox } = await import("./UserMessageEditBox.js");
  return {
    Timeline: (props: {
      readonly items: readonly TimelineItemView[];
      readonly onMoveEditedMessageToComposer?: (item: TimelineItemView, text: string) => Promise<void>;
      readonly onPreviewMessageRewind?: (item: TimelineItemView) => void;
      readonly t: Translator;
    }) => {
      const item = props.items.at(-1);
      if (item === undefined || props.onMoveEditedMessageToComposer === undefined) return null;
      return React.createElement(React.Fragment, null,
      React.createElement("button", { type: "button", onClick: () => props.onPreviewMessageRewind?.(item) }, "Preview rewind"),
      React.createElement(UserMessageEditBox, {
        initialText: item.text ?? "",
        t: props.t,
        onCancel: () => undefined,
        onMoveToComposer: (text: string) => props.onMoveEditedMessageToComposer!(item, text)
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
});

describe("SessionPane edited-message draft transaction", () => {
  it.each([false, true])("keeps the first-turn rewind confirmation bound to its document lifetime: pagehide=%s", async (hide) => {
    const sourceSession = session();
    const originalBackend = backend();
    const sourceBackend: BackendView = { ...originalBackend, capabilities: new Map([...originalBackend.capabilities, ["session.rewind_to_start", { name: "session.rewind_to_start", supported: true, options: [] }]]) };
    const sourceMessage = { ...message(), nativeParentEntryId: undefined, nativeRewindBefore: { kind: "session_start" as const } };
    const navigateSessionBranch = vi.fn(async () => undefined);
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, { readDraft: vi.fn(async () => undefined), saveDraft: vi.fn(async () => undefined), navigateSessionBranch });
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    await act(async () => required([...container.querySelectorAll("button")].find((button) => button.textContent === "Preview rewind") ?? null).click());
    if (hide) {
      await act(async () => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pageshow")); });
      expect(document.querySelector('[data-message-rewind-preview="true"]')).toBeNull();
      expect(navigateSessionBranch).not.toHaveBeenCalled();
    } else {
      await act(async () => required([...document.querySelectorAll("button")].find((button) => button.textContent === "timeline.rewindDialogueOnly") ?? null).click());
      expect(navigateSessionBranch).toHaveBeenCalledExactlyOnceWith(sourceSession.id, { kind: "session_start" }, { expectedGeneration: sourceSession.generation });
    }
  });

  it.each(["persisted", "local"] as const)("does not replace a newer %s composer draft while native navigation is waiting", async (boundary) => {
    const sourceSession = session();
    const sourceBackend = backend();
    const sourceMessage = message();
    let finish!: () => void;
    const navigateSessionBranch = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, { readDraft: vi.fn(async () => durableDraft()), saveDraft: vi.fn(async () => undefined), navigateSessionBranch });
    controller.readDraftSnapshot = vi.fn<AppController["readDraftSnapshot"]>()
      .mockResolvedValueOnce({ revision: 1, draft: durableDraft() })
      .mockResolvedValueOnce({ revision: boundary === "persisted" ? 3 : 2, draft: { ...durableDraft(), text: "Later user draft" } });
    controller.saveDraftIfRevision = vi.fn(async () => 2);
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    await act(async () => editSubmit(container).click());
    await vi.waitFor(() => expect(navigateSessionBranch).toHaveBeenCalledOnce());
    if (boundary === "local") await act(async () => required([...container.querySelectorAll("button")].find((button) => button.textContent === "Unsaved composer input") ?? null).click());
    await act(async () => finish());
    await vi.waitFor(() => expect(controller.readDraftSnapshot).toHaveBeenCalledTimes(boundary === "persisted" ? 2 : 1));
    expect(controller.saveDraftIfRevision).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="edit-replacement"]')).toBeNull();
  });

  it("does not navigate after a concurrent draft write and rolls back only its own successful draft revision", async () => {
    const sourceSession = session();
    const sourceBackend = backend();
    const sourceMessage = message();
    const methods = { readDraft: vi.fn(async () => durableDraft()), saveDraft: vi.fn(async () => undefined), navigateSessionBranch: vi.fn(async () => { throw new Error("navigation failed"); }) };
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, methods);
    const compareAndSet = vi.fn<AppController["saveDraftIfRevision"]>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(undefined);
    controller.saveDraftIfRevision = compareAndSet;
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    await act(async () => editSubmit(container).click());
    expect(methods.navigateSessionBranch).not.toHaveBeenCalled();
    await act(async () => editSubmit(container).click());
    expect(methods.navigateSessionBranch).toHaveBeenCalledOnce();
    expect(compareAndSet.mock.calls.map((call) => call[2])).toEqual([1, 1, 2]);
    expect(methods.saveDraft).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alert]")?.textContent).not.toContain("timeline.editDraftRestoreFailed");
  });

  it("moves the first user message to the composer with an explicit generation-bound start rewind", async () => {
    const sourceSession = session();
    const originalBackend = backend();
    const sourceBackend: BackendView = { ...originalBackend, capabilities: new Map([...originalBackend.capabilities, ["session.rewind_to_start", { name: "session.rewind_to_start", supported: true, options: [] }]]) };
    const sourceMessage = { ...message(), nativeParentEntryId: undefined, nativeRewindBefore: { kind: "session_start" as const } };
    const readDraft = vi.fn(async () => durableDraft());
    const saveDraft = vi.fn(async () => undefined);
    const navigateSessionBranch = vi.fn(async () => undefined);
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, { readDraft, saveDraft, navigateSessionBranch });
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    await act(async () => editSubmit(container).click());
    await vi.waitFor(() => expect(navigateSessionBranch).toHaveBeenCalledExactlyOnceWith(sourceSession.id, { kind: "session_start" }, { expectedGeneration: sourceSession.generation }));
    expect(saveDraft).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(container.querySelector('[data-testid="edit-replacement"]')?.textContent).toBe(sourceMessage.text));
  });

  it.each(["generation", "gateway", "navigation ABA", "pagehide"] as const)("retires an edit while its draft read is pending across a %s replacement", async (boundary) => {
    const sourceSession = session();
    const sourceBackend = backend();
    const sourceMessage = message();
    let finish!: (value: ReturnType<typeof durableDraft>) => void;
    const readDraft = vi.fn(() => new Promise<ReturnType<typeof durableDraft>>((resolve) => { finish = resolve; }));
    const saveDraft = vi.fn(async () => undefined);
    const navigateSessionBranch = vi.fn(async () => undefined);
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, { readDraft, saveDraft, navigateSessionBranch });
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    await act(async () => editSubmit(container).click());
    await vi.waitFor(() => expect(readDraft).toHaveBeenCalledOnce());
    if (boundary === "generation") (sourceSession as { generation: bigint }).generation += 1n;
    else if (boundary === "gateway") controller.navigateSessionBranch = vi.fn(async () => undefined);
    else if (boundary === "navigation ABA") (controller.state as { navigationRevision: number }).navigationRevision = 2;
    else { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pageshow")); }
    await act(async () => finish(durableDraft()));
    await vi.waitFor(() => expect(container.querySelector("[role=alert]")?.textContent).toContain("timeline.editStale"));
    expect(saveDraft).not.toHaveBeenCalled();
    expect(navigateSessionBranch).not.toHaveBeenCalled();
  });

  it("keeps the editor and durable draft untouched when the previous draft cannot be read", async () => {
    const sourceSession = session();
    const sourceBackend = backend();
    const sourceMessage = message();
    const readDraft = vi.fn(async () => { throw new Error("Could not read the current draft."); });
    const saveDraft = vi.fn();
    const navigateSessionBranch = vi.fn();
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, {
      readDraft,
      saveDraft,
      navigateSessionBranch
    });
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    const textarea = required(container.querySelector<HTMLTextAreaElement>(".message-user-edit textarea"));
    const submit = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "timeline.editMoveToComposer");
    if (submit === undefined) throw new Error("Edit submit button was not rendered.");

    await act(async () => submit.click());
    await act(async () => vi.waitFor(() => expect(container.querySelector("[role=alert]")?.textContent)
      .toContain("Could not read the current draft.")));

    expect(readDraft).toHaveBeenCalledWith(sourceSession.id);
    expect(saveDraft).not.toHaveBeenCalled();
    expect(navigateSessionBranch).not.toHaveBeenCalled();
    expect(textarea.value).toBe(sourceMessage.text);
    expect(textarea.disabled).toBe(false);
  });

  it("keeps the editor open and reports a recovery failure when the task becomes stale and rollback cannot be saved", async () => {
    const sourceSession = session();
    const sourceBackend = backend();
    const sourceMessage = message();
    const previousDraft = durableDraft();
    const readDraft = vi.fn(async () => previousDraft);
    const saveDraft = vi.fn()
      .mockImplementationOnce(async () => { Reflect.set(sourceSession, "state", "running"); })
      .mockRejectedValueOnce(new Error("rollback failed"));
    const navigateSessionBranch = vi.fn();
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, {
      readDraft,
      saveDraft,
      navigateSessionBranch
    });
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    const textarea = required(container.querySelector<HTMLTextAreaElement>(".message-user-edit textarea"));
    const submit = editSubmit(container);

    await act(async () => submit.click());
    await act(async () => vi.waitFor(() => expect(container.querySelector("[role=alert]")?.textContent)
      .toContain("timeline.editDraftRestoreFailed")));

    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(saveDraft).toHaveBeenLastCalledWith(sourceSession.id, previousDraft);
    expect(navigateSessionBranch).not.toHaveBeenCalled();
    expect(textarea.value).toBe(sourceMessage.text);
    expect(textarea.disabled).toBe(false);
  });

  it("keeps the editor open and reports a recovery failure when navigation and rollback both fail", async () => {
    const sourceSession = session();
    const sourceBackend = backend();
    const sourceMessage = message();
    const previousDraft = durableDraft();
    const readDraft = vi.fn(async () => previousDraft);
    const saveDraft = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("rollback failed"));
    const navigateSessionBranch = vi.fn().mockRejectedValueOnce(new Error("navigation failed"));
    const controller = controllerFor(sourceSession, sourceBackend, sourceMessage, {
      readDraft,
      saveDraft,
      navigateSessionBranch
    });
    const container = mountPane(controller, sourceSession, sourceBackend, sourceMessage);
    const textarea = required(container.querySelector<HTMLTextAreaElement>(".message-user-edit textarea"));
    const submit = editSubmit(container);

    await act(async () => submit.click());
    await act(async () => vi.waitFor(() => expect(container.querySelector("[role=alert]")?.textContent)
      .toContain("timeline.editDraftRestoreFailed")));

    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(saveDraft).toHaveBeenLastCalledWith(sourceSession.id, previousDraft);
    expect(navigateSessionBranch).toHaveBeenCalledWith(sourceSession.id, { kind: "native_entry", entryId: "entry-parent" }, { expectedGeneration: sourceSession.generation });
    expect(textarea.value).toBe(sourceMessage.text);
    expect(textarea.disabled).toBe(false);
  });
});

function editSubmit(container: HTMLDivElement): HTMLButtonElement {
  const submit = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "timeline.editMoveToComposer");
  if (submit === undefined) throw new Error("Edit submit button was not rendered.");
  return submit;
}

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
  sourceMessage: TimelineItemView
): HTMLDivElement {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<SessionPane
    controller={controller}
    session={sourceSession}
    backend={sourceBackend}
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
    runAction={(_key, action) => { void action(); }}
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
): AppController {
  const snapshot = {
    ...emptySnapshot(),
    revision: 1n,
    sessions: [sourceSession],
    backends: [sourceBackend],
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
    extensionNotifications: []
  };
  let revision = 1;
  return {
    state, ...methods,
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
    sequence: 1n,
    kind: "user",
    text: "Keep this edit in place",
    nativeParentEntryId: "entry-parent",
    nativeRewindBefore: { kind: "native_entry", entryId: "entry-parent" },
    createdAt: 1_000
  };
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Required element was not rendered.");
  return value;
}
