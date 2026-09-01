// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyExtensionUiEffect,
  clearTransientExtensionUiState,
  extensionOsNotificationTitle,
  rememberExtensionUiEffect,
  type ControllerState
} from "./controller.js";
import { DEFAULT_UI_PREFERENCES, type LocalState } from "./local-state.js";
import { emptySnapshot, type ComposerDraft } from "./model.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.title = "Joko";
});

describe("extension UI controller effects", () => {
  it("retains severity in renderer state and sends only the public body to the OS notification", () => {
    vi.useFakeTimers();
    const created: Array<{ readonly title: string; readonly options?: NotificationOptions }> = [];
    class NotificationProbe {
      static readonly permission = "granted";
      constructor(title: string, options?: NotificationOptions) {
        created.push({ title, options });
      }
    }
    vi.stubGlobal("Notification", NotificationProbe);
    let state = controllerState();
    let generationCurrent = true;

    applyExtensionUiEffect({
      eventId: "warning-event",
      sessionId: "session-a",
      kind: "notification",
      notificationKind: "warning",
      text: "[redacted notification]"
    }, undefined, (update) => { state = update(state); }, {
      isCurrent: () => generationCurrent
    });

    expect(state.extensionNotifications).toEqual([{
      eventId: "warning-event",
      sessionId: "session-a",
      kind: "warning",
      text: "[redacted notification]"
    }]);
    expect(created).toEqual([{
      title: "Joko · Warning",
      options: { body: "[redacted notification]", tag: "warning-event" }
    }]);
    expect(extensionOsNotificationTitle("error")).toBe("Joko · Error");
    expect(extensionOsNotificationTitle("unknown")).toBe("Joko");

    generationCurrent = false;
    vi.advanceTimersByTime(10_000);
    expect(state.extensionNotifications).toHaveLength(1);
    state = clearTransientExtensionUiState(state);
    expect(state.extensionNotifications).toEqual([]);
  });

  it("deduplicates replayed event ids while keeping profile scopes independent", () => {
    const seen = new Map<string, true>();
    expect(rememberExtensionUiEffect(seen, "profile-a\u0000event-a")).toBe(true);
    expect(rememberExtensionUiEffect(seen, "profile-a\u0000event-a")).toBe(false);
    expect(rememberExtensionUiEffect(seen, "profile-b\u0000event-a")).toBe(true);
  });

  it("reports a bounded visible error and never saves an empty envelope when draft reading fails", async () => {
    const saveDraft = vi.fn();
    const local = {
      readDraft: vi.fn(async () => { throw new Error("IndexedDB read failed"); }),
      saveDraft
    } as unknown as LocalState;
    let state = controllerState();

    applyExtensionUiEffect({
      eventId: "editor-read-failure",
      sessionId: "session-a",
      kind: "editorText",
      text: "visible editor text"
    }, local, (update) => { state = update(state); }, {
      isCurrent: () => true,
      isLatestEditorEffect: () => true
    });
    await vi.waitFor(() => expect(state.extensionNotifications).toHaveLength(1));

    expect(saveDraft).not.toHaveBeenCalled();
    expect(state.editorTextUpdate?.text).toBe("visible editor text");
    expect(state.extensionNotifications[0]).toEqual({
      eventId: "editor-read-failure:editor-draft-persistence-error",
      sessionId: "session-a",
      kind: "error",
      text: "The editor text was updated but could not be saved. Copy it before leaving this task."
    });
    expect(state.extensionNotifications[0]?.eventId.length).toBeLessThanOrEqual(512);
  });

  it("preserves the complete draft envelope and reports a visible error when persistence fails", async () => {
    const attachment = { id: "file-one", kind: "file" as const, file: new File(["bytes"], "notes.txt") };
    const draft: ComposerDraft = {
      text: "old text",
      attachments: [attachment],
      mentions: [{ id: "mention-one", kind: "resource", reference: "resource-one", label: "Resource", token: "@Resource" }],
      deliveryMode: "followUp",
      extraDirectoryIds: ["extra-one"]
    };
    const saveDraft = vi.fn(async () => { throw new Error("IndexedDB write failed"); });
    const local = {
      readDraft: vi.fn(async () => draft),
      saveDraft
    } as unknown as LocalState;
    let state = controllerState();

    applyExtensionUiEffect({
      eventId: "x".repeat(600),
      sessionId: "session-a",
      kind: "editorText",
      text: "replacement text"
    }, local, (update) => { state = update(state); }, {
      isCurrent: () => true,
      isLatestEditorEffect: () => true
    });
    await vi.waitFor(() => expect(state.extensionNotifications).toHaveLength(1));

    expect(saveDraft).toHaveBeenCalledWith("session-a", {
      ...draft,
      text: "replacement text"
    });
    expect(state.extensionNotifications[0]).toMatchObject({
      sessionId: "session-a",
      kind: "error",
      text: "The editor text was updated but could not be saved. Copy it before leaving this task."
    });
    expect(state.extensionNotifications[0]?.eventId.length).toBe(512);
  });

  it("fences title and late draft persistence by source session and generation", async () => {
    let rejectDraft: ((error: Error) => void) | undefined;
    const saveDraft = vi.fn(async () => undefined);
    const local = {
      readDraft: vi.fn(() => new Promise<ComposerDraft | undefined>((_resolve, reject) => { rejectDraft = reject; })),
      saveDraft
    } as unknown as LocalState;
    let state = controllerState();
    let generationCurrent = true;
    let latestEditorEffect = true;
    const update = (next: (current: ControllerState) => ControllerState): void => { state = next(state); };

    document.title = "Current task · Joko";
    applyExtensionUiEffect({
      eventId: "old-title",
      sessionId: "session-a",
      kind: "title",
      text: "Old task"
    }, undefined, update, { activeSessionId: "session-b" });
    expect(document.title).toBe("Current task · Joko");

    applyExtensionUiEffect({
      eventId: "editor-a",
      sessionId: "session-a",
      kind: "editorText",
      text: "new draft"
    }, local, update, {
      isCurrent: () => generationCurrent,
      isLatestEditorEffect: () => latestEditorEffect
    });
    expect(state.editorTextUpdate).toEqual({
      eventId: "editor-a",
      sessionId: "session-a",
      text: "new draft"
    });

    latestEditorEffect = false;
    generationCurrent = false;
    rejectDraft?.(new Error("stale profile draft failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(saveDraft).not.toHaveBeenCalled();
    expect(state.extensionNotifications).toEqual([]);

    state = clearTransientExtensionUiState(state);
    expect(state.editorTextUpdate).toBeUndefined();
  });
});

function controllerState(): ControllerState {
  return {
    ready: true,
    connectionState: "connected",
    profiles: [],
    machineCaches: [],
    machinePresenceByProfile: {},
    discoveredNodes: [],
    discoveryState: "idle",
    managedOrchestratorStatus: undefined,
    automaticConnectionAvailable: true,
    snapshot: emptySnapshot(),
    route: { kind: "session", sessionId: "session-a" },
    preferences: DEFAULT_UI_PREFERENCES,
    extensionNotifications: []
  };
}
