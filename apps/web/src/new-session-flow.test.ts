import { describe, expect, it, vi } from "vitest";
import type { ComposerDraft, NewSessionDraft } from "./model.js";
import { createDelayedSessionFromFirstInput, createSessionFromFirstInput } from "./new-session-flow.js";

const session: NewSessionDraft = {
  targetId: "target-1",
  name: "New task",
  nativeStart: { kind: "fresh" },
  providerId: "provider-1",
  modelId: "model-1",
  effort: "high",
  fastMode: true,
  permissionMode: "ask",
  planMode: false
};

const input: ComposerDraft = {
  text: "Inspect the repository",
  attachments: [],
  mentions: [],
  deliveryMode: "prompt"
};

describe("lazy new-session dispatch", () => {
  it("carries only the prepared Target revision into project task creation", async () => {
    const api = {
      createTarget: vi.fn(async () => "unused"),
      refresh: vi.fn(async () => undefined),
      createSession: vi.fn(async () => ({ sessionId: "session-project", generation: 2n })),
      send: vi.fn(async () => undefined),
      restoreFirstInputDraft: vi.fn(async () => undefined)
    };
    await createDelayedSessionFromFirstInput(api, {
      ...session,
      selection: { kind: "target", targetId: session.targetId },
      expectedTargetRevision: 7n
    }, input, vi.fn());
    expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({
      targetId: session.targetId,
      expectedTargetRevision: 7n
    }));

    await expect(createDelayedSessionFromFirstInput(api, {
      ...session,
      selection: { kind: "target", targetId: session.targetId }
    }, input, vi.fn())).rejects.toThrow("prepared Target revision");
    expect(api.createTarget).not.toHaveBeenCalled();
  });

  it("creates only when invoked, reveals the durable task, then sends its first input", async () => {
    const order: string[] = [];
    const api = {
      createSession: vi.fn(async () => { order.push("create"); return { sessionId: "session-1", generation: 7n }; }),
      send: vi.fn(async () => { order.push("send"); }),
      restoreFirstInputDraft: vi.fn(async () => { order.push("restore"); })
    };
    const onCreated = vi.fn((sessionId: string) => {
      order.push(`navigate:${sessionId}`);
    });

    expect(api.createSession).not.toHaveBeenCalled();
    await expect(createSessionFromFirstInput(api, session, input, onCreated)).resolves.toBe("session-1");

    expect(order).toEqual(["create", "navigate:session-1", "send"]);
    expect(api.restoreFirstInputDraft).not.toHaveBeenCalled();
    expect(api.send).toHaveBeenCalledWith("session-1", input, { expectedGeneration: 7n });
  });

  it("still reveals the created task before a first-input failure escapes", async () => {
    const order: string[] = [];
    const api = {
      createSession: vi.fn(async () => { order.push("create"); return { sessionId: "session-2", generation: 8n }; }),
      send: vi.fn(async () => { order.push("send"); throw new Error("dispatch failed"); }),
      restoreFirstInputDraft: vi.fn(async () => { order.push("restore"); })
    };

    await expect(createSessionFromFirstInput(api, session, input, (sessionId) => {
      order.push(`navigate:${sessionId}`);
    })).rejects.toThrow("dispatch failed");
    expect(order).toEqual(["create", "navigate:session-2", "send", "restore"]);
    expect(api.restoreFirstInputDraft).toHaveBeenCalledExactlyOnceWith("session-2", input);
  });

  it("reports both failures when rejected first input cannot be restored", async () => {
    const dispatchFailure = new Error("dispatch failed");
    const recoveryFailure = new Error("recovery failed");
    const api = {
      createSession: vi.fn(async () => ({ sessionId: "session-restore-failed", generation: 9n })),
      send: vi.fn(async () => { throw dispatchFailure; }),
      restoreFirstInputDraft: vi.fn(async () => { throw recoveryFailure; })
    };

    const result = createSessionFromFirstInput(api, session, input, vi.fn());
    await expect(result).rejects.toThrow("The first input was not accepted and could not be restored to the created task draft.");
    await expect(result).rejects.toMatchObject({ errors: [dispatchFailure, recoveryFailure] });
  });

  it("does not navigate or send when session creation itself fails", async () => {
    const api = {
      createSession: vi.fn(async () => { throw new Error("create failed"); }),
      send: vi.fn(async () => undefined),
      restoreFirstInputDraft: vi.fn(async () => undefined)
    };
    const onCreated = vi.fn();

    await expect(createSessionFromFirstInput(api, session, input, onCreated)).rejects.toThrow("create failed");
    expect(onCreated).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    expect(api.restoreFirstInputDraft).not.toHaveBeenCalled();
  });

  it("preserves accepted first input even if revealing the created task fails", async () => {
    const api = {
      createSession: vi.fn(async () => ({ sessionId: "created", generation: 3n })),
      send: vi.fn(async () => undefined),
      restoreFirstInputDraft: vi.fn(async () => undefined)
    };
    await expect(createSessionFromFirstInput(api, session, input, () => {
      throw new Error("Navigation failed");
    })).rejects.toThrow("Navigation failed");
    expect(api.send).toHaveBeenCalledExactlyOnceWith("created", input, { expectedGeneration: 3n });
  });

  it("creates and refreshes a durable managed-dialogue target before Session creation", async () => {
    const order: string[] = [];
    const api = {
      createTarget: vi.fn(async () => { order.push("target"); return "target-dialogue"; }),
      refresh: vi.fn(async () => { order.push("refresh"); }),
      createSession: vi.fn(async (draft: NewSessionDraft) => { order.push(`session:${draft.targetId}`); throw new Error("session failed"); }),
      send: vi.fn(async () => { order.push("send"); }),
      restoreFirstInputDraft: vi.fn(async () => { order.push("restore"); })
    };
    const targetVisible = vi.fn((targetId: string) => {
      order.push(`visible:${targetId}`);
    });

    await expect(createDelayedSessionFromFirstInput(api, {
      ...session,
      selection: { kind: "dialogue", backendId: "backend-1" }
    }, input, vi.fn(), targetVisible)).rejects.toThrow("session failed");

    expect(api.createTarget).toHaveBeenCalledWith({
      backendId: "backend-1",
      name: "New task",
      workspaceKind: "managedDialogue",
      serverPath: "",
      createIfMissing: true
    });
    expect(order).toEqual(["target", "refresh", "visible:target-dialogue", "session:target-dialogue"]);
    expect(api.send).not.toHaveBeenCalled();
  });
});
