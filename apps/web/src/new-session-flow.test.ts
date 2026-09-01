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
  it("creates only when invoked, reveals the durable task, then sends its first input", async () => {
    const order: string[] = [];
    const api = {
      createSession: vi.fn(async () => { order.push("create"); return "session-1"; }),
      send: vi.fn(async () => { order.push("send"); })
    };
    const onCreated = vi.fn((sessionId: string) => {
      order.push(`navigate:${sessionId}`);
    });

    expect(api.createSession).not.toHaveBeenCalled();
    await expect(createSessionFromFirstInput(api, session, input, onCreated)).resolves.toBe("session-1");

    expect(order).toEqual(["create", "navigate:session-1", "send"]);
    expect(api.send).toHaveBeenCalledWith("session-1", input);
  });

  it("still reveals the created task before a first-input failure escapes", async () => {
    const order: string[] = [];
    const api = {
      createSession: vi.fn(async () => { order.push("create"); return "session-2"; }),
      send: vi.fn(async () => { order.push("send"); throw new Error("dispatch failed"); })
    };

    await expect(createSessionFromFirstInput(api, session, input, (sessionId) => {
      order.push(`navigate:${sessionId}`);
    })).rejects.toThrow("dispatch failed");
    expect(order).toEqual(["create", "navigate:session-2", "send"]);
  });

  it("does not navigate or send when session creation itself fails", async () => {
    const api = {
      createSession: vi.fn(async () => { throw new Error("create failed"); }),
      send: vi.fn(async () => undefined)
    };
    const onCreated = vi.fn();

    await expect(createSessionFromFirstInput(api, session, input, onCreated)).rejects.toThrow("create failed");
    expect(onCreated).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
  });

  it("creates and refreshes a durable managed-dialogue target before Session creation", async () => {
    const order: string[] = [];
    const api = {
      createTarget: vi.fn(async () => { order.push("target"); return "target-dialogue"; }),
      refresh: vi.fn(async () => { order.push("refresh"); }),
      createSession: vi.fn(async (draft: NewSessionDraft) => { order.push(`session:${draft.targetId}`); throw new Error("session failed"); }),
      send: vi.fn(async () => { order.push("send"); })
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
