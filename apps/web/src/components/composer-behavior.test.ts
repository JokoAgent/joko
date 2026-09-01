import { describe, expect, it, vi } from "vitest";
import type { BackendView, QueueItemView } from "../model.js";
import { ComposerOperationGuard, composerQueueWindow, getComposerSendShortcutLabel, hasPendingComposerQueueItems, pauseQueueThenAbort, pauseQueueThenAbortRetry, resolveComposerAttachmentPolicy, resolveComposerEnterIntent, resolveComposerEscapeIntent, resolveComposerHistoryKey, resolveComposerPaletteKey, resolveQueueReorderShortcut, resolveTypedComposerPalette, resolveUserShellDraft, type ComposerEnterEvent } from "./composer-behavior.js";

const ENTER: ComposerEnterEvent = {
  key: "Enter",
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  repeat: false,
  isComposing: false
};

describe("composer Enter semantics", () => {
  it("queues on Enter and steers a running turn only with the platform modifier", () => {
    expect(resolveComposerEnterIntent(ENTER, "enter", { turnRunning: false, platform: "Win32" })).toBe("queue");
    expect(resolveComposerEnterIntent(ENTER, "enter", { turnRunning: true, platform: "Win32" })).toBe("queue");
    expect(resolveComposerEnterIntent({ ...ENTER, ctrlKey: true }, "enter", { turnRunning: true, platform: "Win32" })).toBe("steer");
    expect(resolveComposerEnterIntent({ ...ENTER, metaKey: true }, "enter", { turnRunning: true, platform: "MacIntel" })).toBe("steer");
    expect(resolveComposerEnterIntent({ ...ENTER, ctrlKey: true }, "enter", { turnRunning: false, platform: "Win32" })).toBe("queue");
  });

  it("keeps plain Enter native in modifier-enter mode", () => {
    expect(resolveComposerEnterIntent(ENTER, "modifier-enter", { turnRunning: true, platform: "Win32" })).toBe("native");
    expect(resolveComposerEnterIntent({ ...ENTER, ctrlKey: true }, "modifier-enter", { turnRunning: true, platform: "Win32" })).toBe("queue");
    expect(resolveComposerEnterIntent({ ...ENTER, metaKey: true }, "modifier-enter", { turnRunning: true, platform: "Win32" })).toBe("native");
    expect(resolveComposerEnterIntent({ ...ENTER, metaKey: true }, "modifier-enter", { turnRunning: true, platform: "MacIntel" })).toBe("queue");
    expect(getComposerSendShortcutLabel("modifier-enter", "MacIntel")).toBe("⌘+Enter");
    expect(getComposerSendShortcutLabel("modifier-enter", "Win32")).toBe("Ctrl+Enter");
  });

  it("does not send for IME, Shift/Alt newline, or repeated shortcuts", () => {
    expect(resolveComposerEnterIntent({ ...ENTER, isComposing: true }, "enter", { turnRunning: true })).toBe("native");
    expect(resolveComposerEnterIntent({ ...ENTER, shiftKey: true }, "enter", { turnRunning: true })).toBeNull();
    expect(resolveComposerEnterIntent({ ...ENTER, altKey: true }, "enter", { turnRunning: true })).toBeNull();
    expect(resolveComposerEnterIntent({ ...ENTER, repeat: true }, "enter", { turnRunning: true })).toBe("ignore");
    expect(resolveComposerEnterIntent({ ...ENTER, repeat: true }, "modifier-enter", { turnRunning: true })).toBe("native");
    expect(resolveComposerEnterIntent({ ...ENTER, repeat: true, ctrlKey: true }, "modifier-enter", { turnRunning: true })).toBe("ignore");
  });
});

describe("pending queue reorder shortcuts", () => {
  it("maps arrows and Home/End to durable reorder placements", () => {
    expect(resolveQueueReorderShortcut("ArrowUp", 2, 4)).toEqual({ placement: "before", anchorIndex: 1 });
    expect(resolveQueueReorderShortcut("ArrowDown", 1, 4)).toEqual({ placement: "after", anchorIndex: 2 });
    expect(resolveQueueReorderShortcut("Home", 2, 4)).toEqual({ placement: "first" });
    expect(resolveQueueReorderShortcut("End", 1, 4)).toEqual({ placement: "last" });
  });

  it("does not reorder past an edge or for unrelated keys", () => {
    expect(resolveQueueReorderShortcut("ArrowUp", 0, 4)).toBeNull();
    expect(resolveQueueReorderShortcut("ArrowDown", 3, 4)).toBeNull();
    expect(resolveQueueReorderShortcut("Home", 0, 4)).toBeNull();
    expect(resolveQueueReorderShortcut("End", 3, 4)).toBeNull();
    expect(resolveQueueReorderShortcut("Enter", 1, 4)).toBeNull();
  });
});

describe("composer session ownership", () => {
  it("invalidates async owners across session switches and protects newer edits", () => {
    const guard = new ComposerOperationGuard();
    guard.activate("session-a");
    const firstA = guard.capture("session-a");
    expect(guard.beginSubmission("session-a", "send")).toBe(true);
    expect(guard.beginSubmission("session-a", "bash")).toBe(false);

    guard.activate("session-b");
    expect(guard.ownsActivation(firstA)).toBe(false);
    expect(guard.draftUnchanged(firstA)).toBe(true);
    expect(guard.beginSubmission("session-b", "bash")).toBe(true);

    guard.activate("session-a");
    const secondA = guard.capture("session-a");
    expect(guard.ownsActivation(firstA)).toBe(false);
    expect(guard.ownsActivation(secondA)).toBe(true);
    guard.markDraftEdited("session-a");
    expect(guard.draftUnchanged(secondA)).toBe(false);

    guard.finishSubmission("session-a", "send");
    expect(guard.beginSubmission("session-a", "bash")).toBe(true);
  });

  it("drops deferred draft reads and send completions after ownership moves", async () => {
    const guard = new ComposerOperationGuard();
    guard.activate("session-a");
    const deferredReadOwner = guard.capture("session-a");
    const deferredSendOwner = guard.capture("session-a");
    const commits: string[] = [];
    let finishRead: (() => void) | undefined;
    let finishSend: (() => void) | undefined;
    const read = new Promise<void>((resolve) => { finishRead = resolve; }).then(() => {
      if (guard.ownsActivation(deferredReadOwner) && guard.draftUnchanged(deferredReadOwner)) commits.push("read-a");
    });
    const send = new Promise<void>((resolve) => { finishSend = resolve; }).then(() => {
      if (guard.ownsActivation(deferredSendOwner) && guard.draftUnchanged(deferredSendOwner)) commits.push("clear-a");
    });

    guard.activate("session-b");
    guard.markDraftEdited("session-b");
    finishRead?.();
    finishSend?.();
    await Promise.all([read, send]);
    expect(commits).toEqual([]);
  });

  it("consumes an accepted Review draft across an A -> B -> A route round trip", () => {
    const guard = new ComposerOperationGuard();
    guard.activate("session-a");
    const reviewOwner = guard.capture("session-a");

    guard.activate("session-b");
    guard.activate("session-a");
    const returnedHydrationOwner = guard.capture("session-a");

    expect(guard.ownsActivation(reviewOwner)).toBe(false);
    expect(guard.activeSessionId).toBe("session-a");
    expect(guard.consumeUnchangedDraft(reviewOwner)).toBe(true);
    expect(guard.draftUnchanged(returnedHydrationOwner)).toBe(false);
    expect(guard.consumeUnchangedDraft(reviewOwner)).toBe(false);
  });

  it("retains a changed Review draft instead of consuming a newer edit", () => {
    const guard = new ComposerOperationGuard();
    guard.activate("session-a");
    const reviewOwner = guard.capture("session-a");
    guard.markDraftEdited("session-a");

    expect(guard.consumeUnchangedDraft(reviewOwner)).toBe(false);
  });
});

describe("composer Stop semantics", () => {
  it("gives Escape to queue disclosure before run, Shell, and Shell-mode cancellation", () => {
    const escape = { key: "Escape", repeat: false, isComposing: false, paletteTarget: false };
    expect(resolveComposerEscapeIntent(escape, { queueExpanded: true, canStopRun: true, shellRunning: true, shellMode: true })).toBe("collapseQueue");
    expect(resolveComposerEscapeIntent(escape, { queueExpanded: false, canStopRun: true, shellRunning: true, shellMode: true })).toBe("stopRun");
    expect(resolveComposerEscapeIntent(escape, { queueExpanded: false, canStopRun: false, shellRunning: true, shellMode: true })).toBe("stopShell");
    expect(resolveComposerEscapeIntent(escape, { queueExpanded: false, canStopRun: false, shellRunning: false, shellMode: true })).toBe("exitShell");
  });

  it("does not consume palette, IME, repeated, or unrelated keys", () => {
    const context = { queueExpanded: true, canStopRun: true, shellRunning: true, shellMode: true };
    expect(resolveComposerEscapeIntent({ key: "Enter", repeat: false, isComposing: false, paletteTarget: false }, context)).toBeNull();
    expect(resolveComposerEscapeIntent({ key: "Escape", repeat: true, isComposing: false, paletteTarget: false }, context)).toBeNull();
    expect(resolveComposerEscapeIntent({ key: "Escape", repeat: false, isComposing: true, paletteTarget: false }, context)).toBeNull();
    expect(resolveComposerEscapeIntent({ key: "Escape", repeat: false, isComposing: false, paletteTarget: true }, context)).toBeNull();
  });

  it("pauses only for future or dispatch-uncertain items, not the active backend-accepted run", () => {
    for (const state of ["accepted", "queued", "dispatching", "dispatchUnknown"] as const) {
      expect(hasPendingComposerQueueItems([queueItem(state)], "session-a")).toBe(true);
    }
    for (const state of ["acceptedByBackend", "completed", "cancelled", "failed"] as const) {
      expect(hasPendingComposerQueueItems([queueItem(state)], "session-a")).toBe(false);
    }
    expect(hasPendingComposerQueueItems([queueItem("queued", "session-b")], "session-a")).toBe(false);
  });

  it("durably pauses a pending queue before aborting the active run", async () => {
    const calls: string[] = [];
    const controller = {
      pauseQueue: vi.fn(async (sessionId: string) => { calls.push(`pause:${sessionId}`); }),
      abort: vi.fn(async (runId: string) => { calls.push(`abort:${runId}`); })
    };
    await pauseQueueThenAbort(controller, "session-a", "run-a", true, false);
    expect(calls).toEqual(["pause:session-a", "abort:run-a"]);
  });

  it("does not issue a duplicate pause when the queue is already paused", async () => {
    const controller = { pauseQueue: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
    await pauseQueueThenAbort(controller, "session-a", "run-a", true, true);
    expect(controller.pauseQueue).not.toHaveBeenCalled();
    expect(controller.abort).toHaveBeenCalledWith("run-a");
  });

  it("aborts directly when the session has no pending queue items", async () => {
    const calls: string[] = [];
    const controller = {
      pauseQueue: vi.fn(async (sessionId: string) => { calls.push(`pause:${sessionId}`); }),
      abort: vi.fn(async (runId: string) => { calls.push(`abort:${runId}`); })
    };
    await pauseQueueThenAbort(controller, "session-a", "run-a", false, false);
    expect(calls).toEqual(["abort:run-a"]);
  });

  it("uses Pi's native retry cancellation after fencing future queued work", async () => {
    const calls: string[] = [];
    const controller = {
      pauseQueue: vi.fn(async (sessionId: string) => { calls.push(`pause:${sessionId}`); }),
      abortRetry: vi.fn(async (runId: string) => { calls.push(`abort-retry:${runId}`); })
    };
    await pauseQueueThenAbortRetry(controller, "session-a", "run-a", true, false);
    expect(calls).toEqual(["pause:session-a", "abort-retry:run-a"]);
  });
});

describe("composer queue disclosure", () => {
  it("shows three of seven by default and every FIFO item when expanded", () => {
    const items = Array.from({ length: 7 }, (_, index) => ({ id: `queue-${index + 1}` }));
    expect(composerQueueWindow(items, false)).toEqual({ items: items.slice(0, 3), collapsible: true, hiddenCount: 4 });
    expect(composerQueueWindow(items, true)).toEqual({ items, collapsible: true, hiddenCount: 0 });
    expect(composerQueueWindow(items.slice(0, 4), false)).toEqual({ items: items.slice(0, 4), collapsible: false, hiddenCount: 0 });
  });
});

describe("composer palette keyboard semantics", () => {
  it("opens only for a literal first-character trigger outside bash and IME composition", () => {
    expect(resolveTypedComposerPalette("/", false, false)).toBe("commands");
    expect(resolveTypedComposerPalette("@", false, false)).toBe("mention");
    expect(resolveTypedComposerPalette(" /", false, false)).toBeNull();
    expect(resolveTypedComposerPalette("/help", false, false)).toBeNull();
    expect(resolveTypedComposerPalette("/", true, false)).toBeNull();
    expect(resolveTypedComposerPalette("@", false, true)).toBeNull();
  });

  it("wraps accessible selection and submits with Enter or Tab", () => {
    expect(resolveComposerPaletteKey("ArrowDown", 2, 3)).toEqual({ kind: "move", index: 0 });
    expect(resolveComposerPaletteKey("ArrowUp", 0, 3)).toEqual({ kind: "move", index: 2 });
    expect(resolveComposerPaletteKey("Home", 2, 3)).toEqual({ kind: "move", index: 0 });
    expect(resolveComposerPaletteKey("End", 0, 3)).toEqual({ kind: "move", index: 2 });
    expect(resolveComposerPaletteKey("Enter", 1, 3)).toEqual({ kind: "select", index: 1 });
    expect(resolveComposerPaletteKey("Tab", 1, 3)).toEqual({ kind: "select", index: 1 });
    expect(resolveComposerPaletteKey("Escape", 0, 0)).toEqual({ kind: "close" });
    expect(resolveComposerPaletteKey("Enter", 0, 0)).toBeNull();
  });
});

describe("Pi user-shell prefix semantics", () => {
  it("treats one bang as Shell syntax and two bangs as exclude-from-context syntax", () => {
    expect(resolveUserShellDraft("echo ordinary", false, false)).toBeNull();
    expect(resolveUserShellDraft("  ! echo stays a prompt", false, false)).toBeNull();
    expect(resolveUserShellDraft("! echo included  ", false, false)).toEqual({
      command: "echo included",
      excludeFromContext: false,
      prefix: "include"
    });
    expect(resolveUserShellDraft("!! echo excluded  ", false, false)).toEqual({
      command: "echo excluded",
      excludeFromContext: true,
      prefix: "exclude"
    });
    expect(resolveUserShellDraft("!!echo compact", false, false)).toEqual({
      command: "echo compact",
      excludeFromContext: true,
      prefix: "exclude"
    });
  });

  it("retains graphical Shell controls without leaking a typed prefix into the command", () => {
    expect(resolveUserShellDraft(" echo toggled ", true, true)).toEqual({
      command: "echo toggled",
      excludeFromContext: true,
      prefix: "none"
    });
    expect(resolveUserShellDraft("!echo checked", true, true)).toEqual({
      command: "echo checked",
      excludeFromContext: true,
      prefix: "include"
    });
    expect(resolveUserShellDraft("!!!literal-bang", false, false)).toEqual({
      command: "!literal-bang",
      excludeFromContext: true,
      prefix: "exclude"
    });
  });
});

describe("composer attachment capability policy", () => {
  it("rejects images for a text-only model while retaining backend file input", () => {
    expect(resolveComposerAttachmentPolicy(attachmentBackend(true), false)).toEqual({
      images: false,
      files: true,
      maximumItems: 5,
      maximumBytes: 500
    });
  });

  it("fails closed when the current model image support is unknown", () => {
    expect(resolveComposerAttachmentPolicy(attachmentBackend(true), undefined)).toEqual({
      images: false,
      files: true,
      maximumItems: 5,
      maximumBytes: 500
    });
  });

  it("allows vision input only when both the model and backend support images", () => {
    expect(resolveComposerAttachmentPolicy(attachmentBackend(true), true)).toEqual({
      images: true,
      files: true,
      maximumItems: 2,
      maximumBytes: 200
    });
    expect(resolveComposerAttachmentPolicy(attachmentBackend(false), true).images).toBe(false);
  });

  it("does not invent an item-count limit when the backend declares none", () => {
    const backend = {
      ...attachmentBackend(true),
      capabilities: new Map([
        ["input.image", { name: "input.image", supported: true, options: [] }],
        ["input.file", { name: "input.file", supported: true, options: [] }]
      ])
    } satisfies BackendView;
    expect(resolveComposerAttachmentPolicy(backend, true)).toEqual({ images: true, files: true });
  });
});

describe("composer durable message history", () => {
  it("walks newest-to-oldest from an empty draft and returns to the saved draft", () => {
    expect(resolveComposerHistoryKey("ArrowUp", "", -1, 3, false)).toEqual({ index: 0 });
    expect(resolveComposerHistoryKey("ArrowUp", "newest", 0, 3, true)).toEqual({ index: 1 });
    expect(resolveComposerHistoryKey("ArrowDown", "older", 1, 3, true)).toEqual({ index: 0 });
    expect(resolveComposerHistoryKey("ArrowDown", "newest", 0, 3, true)).toEqual({ index: -1 });
  });

  it("does not hijack arrows for a nonempty draft or a modified history entry", () => {
    expect(resolveComposerHistoryKey("ArrowUp", "draft", -1, 3, false)).toBeNull();
    expect(resolveComposerHistoryKey("ArrowDown", "", -1, 3, false)).toBeNull();
    expect(resolveComposerHistoryKey("ArrowUp", "edited", 0, 3, false)).toBeNull();
  });
});

function attachmentBackend(images: boolean): BackendView {
  return {
    id: "backend",
    name: "Backend",
    version: "1",
    health: "healthy",
    capabilities: new Map([
      ["input.image", { name: "input.image", supported: images, options: [], maximumItems: 2, maximumBytes: 200 }],
      ["input.file", { name: "input.file", supported: true, options: [], maximumItems: 5, maximumBytes: 500 }]
    ])
  };
}

function queueItem(state: QueueItemView["state"], sessionId = "session-a"): QueueItemView {
  return {
    id: `${sessionId}:${state}`,
    sessionId,
    revision: 1n,
    generation: 1n,
    source: "user",
    mode: "followUp",
    text: "queued",
    state,
    editLocked: false,
    ordinal: 1,
    createdAt: 1
  };
}
