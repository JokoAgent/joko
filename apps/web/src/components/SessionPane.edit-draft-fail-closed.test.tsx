// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController, ControllerState } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type BackendView, type SessionView, type TimelineItemView } from "../model.js";
import { SessionPane } from "./SessionPane.js";
import type { Translator } from "./types.js";

vi.mock("./Composer.js", () => ({ Composer: () => null }));
vi.mock("./Timeline.js", async () => {
  const React = await import("react");
  const { UserMessageEditBox } = await import("./UserMessageEditBox.js");
  return {
    Timeline: (props: {
      readonly items: readonly TimelineItemView[];
      readonly onMoveEditedMessageToComposer?: (item: TimelineItemView, text: string) => Promise<void>;
      readonly t: Translator;
    }) => {
      const item = props.items.at(-1);
      if (item === undefined || props.onMoveEditedMessageToComposer === undefined) return null;
      return React.createElement(UserMessageEditBox, {
        initialText: item.text ?? "",
        t: props.t,
        onCancel: () => undefined,
        onMoveToComposer: (text: string) => props.onMoveEditedMessageToComposer!(item, text)
      });
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
    expect(navigateSessionBranch).toHaveBeenCalledWith(sourceSession.id, "entry-parent");
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
  return { state, ...methods } as unknown as AppController;
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
    createdAt: 1_000
  };
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Required element was not rendered.");
  return value;
}
