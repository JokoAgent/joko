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
