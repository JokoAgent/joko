import { describe, expect, it, vi } from "vitest";

import {
  WorkspaceDocumentController,
  canonicalWorkspaceDocumentPath,
  workspaceDocumentKey,
  type WorkspaceDirtyDocument,
  type WorkspaceLeaveChoice
} from "./workspace-document-controller.js";

function fixture(overrides: Partial<WorkspaceDirtyDocument> = {}): WorkspaceDirtyDocument & { dirty: boolean } {
  const document: WorkspaceDirtyDocument & { dirty: boolean } = {
    identity: { sessionId: "session", workspaceId: "workspace", path: "src/a.ts" },
    dirty: true,
    isDirty: () => document.dirty,
    save: async () => {
      document.dirty = false;
      return true;
    },
    discard: () => { document.dirty = false; },
    ...overrides
  };
  return document;
}

describe("WorkspaceDocumentController", () => {
  it("allows a clean leave without prompting", async () => {
    const controller = new WorkspaceDocumentController();
    controller.register(fixture({ isDirty: () => false }));
    const prompt = vi.fn<() => Promise<WorkspaceLeaveChoice>>();

    await expect(controller.requestLeave({ reason: "route-change", prompt })).resolves.toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    expect(controller.shouldPreventUnload()).toBe(false);
  });

  it("supports save, discard, and cancel through one serialized guard", async () => {
    const controller = new WorkspaceDocumentController();
    const saved = fixture();
    const discarded = fixture({
      identity: { sessionId: "session", workspaceId: "workspace", path: "src/b.ts" }
    });
    controller.register(saved);
    controller.register(discarded);
    const choices: WorkspaceLeaveChoice[] = ["save", "discard"];

    await expect(controller.requestLeave({
      reason: "close-files",
      prompt: async () => choices.shift() ?? "cancel"
    })).resolves.toBe(true);
    expect(saved.dirty).toBe(false);
    expect(discarded.dirty).toBe(false);

    saved.dirty = true;
    const focus = vi.fn();
    controller.register(fixture({
      identity: saved.identity,
      focus,
      isDirty: () => true
    }));
    await expect(controller.requestLeave({ reason: "route-change", prompt: async () => "cancel" })).resolves.toBe(false);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("blocks navigation when save fails or newer typing remains dirty", async () => {
    const controller = new WorkspaceDocumentController();
    const focus = vi.fn();
    controller.register(fixture({ save: async () => false, focus }));
    await expect(controller.requestLeave({ reason: "switch-file", prompt: async () => "save" })).resolves.toBe(false);
    expect(focus).toHaveBeenCalledOnce();

    const second = new WorkspaceDocumentController();
    second.register(fixture({ save: async () => true, isDirty: () => true, focus }));
    await expect(second.requestLeave({ reason: "switch-session", prompt: async () => "save" })).resolves.toBe(false);
    expect(focus).toHaveBeenCalledTimes(2);
  });

  it.each(["save", "discard"] as const)("retires an active leave before a late %s choice can mutate the document", async (choice) => {
    const controller = new WorkspaceDocumentController();
    const save = vi.fn(async () => true);
    const discard = vi.fn();
    const focus = vi.fn();
    const document = fixture({ save, discard, focus });
    controller.register(document);
    const selected = deferred<WorkspaceLeaveChoice>();
    const prompt = vi.fn(() => selected.promise);
    const owner = new AbortController();

    const leave = controller.requestLeave({ reason: "route-change", prompt, signal: owner.signal });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    owner.abort();

    await expect(leave).resolves.toBe(false);
    selected.resolve(choice);
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(document.dirty).toBe(true);
  });

  it("retires an aborted queued leave without ever presenting its prompt", async () => {
    const controller = new WorkspaceDocumentController();
    controller.register(fixture());
    const activeChoice = deferred<WorkspaceLeaveChoice>();
    const activePrompt = vi.fn(() => activeChoice.promise);
    const activeLeave = controller.requestLeave({ reason: "route-change", prompt: activePrompt });
    await vi.waitFor(() => expect(activePrompt).toHaveBeenCalledOnce());

    const queuedOwner = new AbortController();
    const queuedPrompt = vi.fn<() => Promise<WorkspaceLeaveChoice>>();
    const queuedLeave = controller.requestLeave({
      reason: "switch-session",
      prompt: queuedPrompt,
      signal: queuedOwner.signal
    });
    queuedOwner.abort();
    await expect(queuedLeave).resolves.toBe(false);

    activeChoice.resolve("cancel");
    await expect(activeLeave).resolves.toBe(false);
    await Promise.resolve();
    expect(queuedPrompt).not.toHaveBeenCalled();
  });

  it("scopes dirty checks and protects a replacement from stale cleanup", async () => {
    const controller = new WorkspaceDocumentController();
    const first = controller.register(fixture());
    const replacement = fixture({
      identity: { sessionId: "other", workspaceId: "workspace", path: "src/a.ts" }
    });
    controller.register(replacement);
    const sameKeyReplacement = fixture({ isDirty: () => false });
    controller.register(sameKeyReplacement);
    first.unregister();

    expect(controller.dirtyDocuments((identity) => identity.sessionId === "session")).toEqual([]);
    expect(controller.dirtyDocuments((identity) => identity.sessionId === "other")).toEqual([replacement.identity]);
    await expect(controller.requestLeave({
      reason: "switch-session",
      matches: (identity) => identity.sessionId === "session",
      prompt: async () => "cancel"
    })).resolves.toBe(true);
  });

  it("fails closed on invalid identities and normalizes path separators", () => {
    expect(canonicalWorkspaceDocumentPath("src\\a.ts")).toBe("src/a.ts");
    expect(workspaceDocumentKey({ sessionId: "s", workspaceId: "w", path: "src/a.ts" })).toBe('["s","w","src/a.ts"]');
    for (const path of ["../a.ts", "/a.ts", "C:\\a.ts", "src//a.ts", "src/./a.ts", "src/\u202ea.ts"]) {
      expect(() => canonicalWorkspaceDocumentPath(path)).toThrow();
    }
  });
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
