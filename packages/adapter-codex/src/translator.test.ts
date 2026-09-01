import { describe, expect, it } from "vitest";
import type { JsonValue } from "./protocol.js";
import { CodexEventTranslator, createTranslatorState, interactionFromServerRequest } from "./translator.js";

describe("Codex interaction translation", () => {
  it("preserves every completed native assistant item as a distinct message boundary", () => {
    const translator = new CodexEventTranslator();
    const state = createTranslatorState();
    const first = translator.translate("item/completed", {
      threadId: "thread-one",
      turnId: "turn-one",
      item: { id: "assistant-one", type: "agentMessage", text: "First answer." }
    }, state);
    const second = translator.translate("item/completed", {
      threadId: "thread-one",
      turnId: "turn-one",
      item: { id: "assistant-two", type: "agentMessage", text: "Second answer." }
    }, state);

    expect([...first, ...second]).toEqual([
      expect.objectContaining({
        type: "message_complete",
        role: "assistant",
        blocks: [{ kind: "text", text: "First answer." }],
        nativeHistory: { identity: { entryId: "assistant-one" } }
      }),
      expect.objectContaining({
        type: "message_complete",
        role: "assistant",
        blocks: [{ kind: "text", text: "Second answer." }],
        nativeHistory: { identity: { entryId: "assistant-two" } }
      })
    ]);
  });

  it("projects terminal interaction activity without persisting terminal input", () => {
    const translator = new CodexEventTranslator();
    const state = createTranslatorState();
    state.itemNames.set("command-one", "command");
    const events = translator.translate("item/commandExecution/terminalInteraction", {
      threadId: "thread-one",
      turnId: "turn-one",
      itemId: "command-one",
      processId: "process-one",
      stdin: "private terminal input"
    }, state);
    expect(events).toEqual([expect.objectContaining({
      type: "tool_update",
      callId: "command-one",
      output: "[interactive terminal input delivered]"
    })]);
    expect(JSON.stringify(events)).not.toContain("private terminal input");
  });

  it("maps command and file approvals to stable native decisions", () => {
    const command = interactionFromServerRequest(1, "item/commandExecution/requestApproval", {
      threadId: "thread-one",
      turnId: "turn-one",
      itemId: "command-one",
      command: "pnpm test"
    }, "D:\\workspace");
    expect(command?.payload).toMatchObject({
      kind: "permission",
      toolName: "command",
      choices: ["approve_once"]
    });
    expect(command?.toResponse({ kind: "selected", value: "approve_once" })).toEqual({ decision: "accept" });
    expect(command?.toResponse({ kind: "selected", value: "approve_session" })).toEqual({ decision: "cancel" });

    const file = interactionFromServerRequest(2, "item/fileChange/requestApproval", {
      threadId: "thread-one",
      turnId: "turn-one",
      itemId: "file-one",
      reason: "Update a source file"
    }, "D:\\workspace");
    expect(file?.payload).toMatchObject({ kind: "permission", toolName: "file_change" });
    expect(file?.toResponse({ kind: "cancelled" })).toEqual({ decision: "cancel" });
  });

  it("narrows command choices and responses to available native decisions", () => {
    const interaction = interactionFromServerRequest(11, "item/commandExecution/requestApproval", {
      threadId: "thread-one",
      turnId: "turn-one",
      itemId: "command-one",
      command: "pnpm test",
      availableDecisions: ["accept", "decline"]
    }, "D:\\workspace");
    expect(interaction?.payload).toMatchObject({
      kind: "permission",
      choices: ["approve_once", "decline"]
    });
    expect(interaction?.toResponse({ kind: "selected", value: "approve_once" })).toEqual({ decision: "accept" });
    expect(interaction?.toResponse({ kind: "selected", value: "approve_session" })).toEqual({ decision: "decline" });
    expect(interaction?.toResponse({ kind: "cancelled" })).toEqual({ decision: "decline" });

    expect(interactionFromServerRequest(12, "item/commandExecution/requestApproval", {
      threadId: "thread-one",
      turnId: "turn-one",
      itemId: "command-two",
      availableDecisions: ["futureDecision"]
    }, "D:\\workspace")).toBeUndefined();
  });

  it("returns only the requested permission object with an explicit scope", () => {
    const requested = {
      network: { enabled: true },
      fileSystem: { read: ["D:\\workspace\\docs"], write: ["D:\\workspace\\src"] }
    };
    const interaction = interactionFromServerRequest(3, "item/permissions/requestApproval", {
      threadId: "thread-one",
      turnId: "turn-one",
      itemId: "permission-one",
      permissions: requested
    }, "D:\\workspace");
    expect(interaction?.payload).toMatchObject({ kind: "permission", toolName: "permissions" });
    expect(interaction?.toResponse({ kind: "selected", value: "approve_session" })).toEqual({
      permissions: requested,
      scope: "session"
    });
    expect(interaction?.toResponse({ kind: "selected", value: "decline" })).toEqual({
      permissions: {},
      scope: "turn"
    });
  });

  it("preserves typed user answers in the native answer envelope", () => {
    const interaction = interactionFromServerRequest(4, "item/tool/requestUserInput", {
      threadId: "thread-one",
      turnId: "turn-one",
      itemId: "question-one",
      questions: [
        { id: "name", question: "Name?" },
        {
          id: "mode",
          question: "Mode?",
          options: [
            { label: "safe", description: "Use safe mode" },
            { label: "fast", description: "Use fast mode" }
          ]
        }
      ]
    }, "D:\\workspace");
    expect(interaction?.payload).toMatchObject({
      kind: "question",
      fields: [
        { id: "name", kind: "text" },
        { id: "mode", kind: "single" }
      ]
    });
    expect(interaction?.toResponse({
      kind: "question",
      answers: { name: "Joko", mode: ["safe"] }
    })).toEqual({
      answers: {
        name: { answers: ["Joko"] },
        mode: { answers: ["safe"] }
      }
    });
  });

  it("rejects oversized question schemas and bounds projected answers", () => {
    const questions: JsonValue[] = [
      { id: "name", header: "Identity", question: "Name?" },
      {
        id: "mode",
        question: "Mode?",
        options: [{ label: "safe", description: "Use safe mode" }]
      },
      { id: "third", question: "Third?" },
      { id: "ignored", question: "Must not become durable" }
    ];
    const oversizedRequest = {
      threadId: "thread-one",
      turnId: "turn-one",
      itemId: "question-bounded",
      questions
    };
    expect(interactionFromServerRequest(
      14,
      "item/tool/requestUserInput",
      oversizedRequest,
      "D:\\workspace"
    )).toBeUndefined();
    const interaction = interactionFromServerRequest(14, "item/tool/requestUserInput", {
      ...oversizedRequest,
      questions: oversizedRequest.questions.slice(0, 3)
    }, "D:\\workspace");
    expect(interaction?.payload).toMatchObject({
      kind: "question",
      fields: [
        { id: "name", kind: "text" },
        { id: "mode", kind: "single" },
        { id: "third", kind: "text" }
      ]
    });
    const oversized = "x".repeat(3_000);
    const response = interaction?.toResponse({
      kind: "question",
      answers: {
        name: `password=very-private ${oversized}`,
        mode: ["fast"],
        third: oversized,
        ignored: "not-returned",
        unknown: "not-returned"
      }
    });
    expect(response).toMatchObject({
      answers: {
        name: { answers: [expect.stringContaining("password=[REDACTED]")] },
        mode: { answers: [] },
        third: { answers: [expect.any(String)] }
      }
    });
    expect(JSON.stringify(response)).not.toContain("very-private");
    expect(JSON.stringify(response)).not.toContain("not-returned");
    expect((response as { answers: { third: { answers: string[] } } }).answers.third.answers[0]).toHaveLength(2_000);
  });

  it("fails closed for duplicate or malformed question identities", () => {
    expect(interactionFromServerRequest(15, "item/tool/requestUserInput", {
      threadId: "thread-one",
      turnId: "turn-one",
      itemId: "duplicate-question",
      questions: [
        { id: "same", question: "One?" },
        { id: "same", question: "Two?" }
      ]
    }, "D:\\workspace")).toBeUndefined();
    expect(interactionFromServerRequest(16, "item/tool/requestUserInput", {
      threadId: "thread-one",
      turnId: "turn-one",
      itemId: "malformed-question",
      questions: [{ id: "question", question: "" }]
    }, "D:\\workspace")).toBeUndefined();
  });

  it("returns native question ids without prototype mutation", () => {
    const interaction = interactionFromServerRequest(17, "item/tool/requestUserInput", {
      threadId: "thread-one",
      turnId: "turn-one",
      itemId: "question-hostile-id",
      questions: [{ id: "__proto__", question: "Value?" }]
    }, "D:\\workspace");
    const response = interaction?.toResponse({
      kind: "question",
      answers: Object.assign(Object.create(null) as Record<string, string>, { __proto__: "safe" })
    }) as { answers: Record<string, { answers: string[] }> };
    expect(Object.getPrototypeOf(response.answers)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(response.answers, "__proto__")).toBe(true);
  });

  it("does not create an Interaction for secret native user input", () => {
    const interaction = interactionFromServerRequest(5, "item/tool/requestUserInput", {
      threadId: "thread-one",
      turnId: "turn-one",
      itemId: "question-secret",
      questions: [
        { id: "secret", question: "Token?", isSecret: true },
        { id: "name", question: "Name?" }
      ]
    }, "D:\\workspace");
    expect(interaction).toBeUndefined();
    expect(interactionFromServerRequest(18, "item/tool/requestUserInput", {
      threadId: "thread-one",
      turnId: "turn-one",
      itemId: "question-malformed-secret",
      questions: [{ id: "secret", question: "Token?", isSecret: "true" }]
    }, "D:\\workspace")).toBeUndefined();
  });

  it("fails closed for network approvals until their target can be projected exactly", () => {
    expect(interactionFromServerRequest(19, "item/commandExecution/requestApproval", {
      threadId: "thread-one",
      turnId: "turn-one",
      itemId: "network-approval",
      networkApprovalContext: { host: "example.com", protocol: "https" },
      availableDecisions: ["accept", "acceptForSession", "cancel"]
    }, "D:\\workspace")).toBeUndefined();
  });

  it("redacts credential-shaped progress diagnostics before event publication", () => {
    const translator = new CodexEventTranslator();
    const events = translator.translate("item/mcpToolCall/progress", {
      threadId: "thread-one",
      turnId: "turn-one",
      itemId: "tool-one",
      message: [
        "Authorization: Basic c2VjcmV0OnZhbHVl",
        "password=very-private",
        "ghp_abcdefghijklmnopqrstuvwxyz123456",
        `AWS_SECRET_ACCESS_KEY=${"a".repeat(40)}`,
        "postgres://alice:s3cr3t@example.test/db",
        "STRIPE_SECRET_KEY=sk_live_abcdefghijklmnop"
      ].join(" ")
    }, createTranslatorState());
    const output = JSON.stringify(events);
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("c2VjcmV0OnZhbHVl");
    expect(output).not.toContain("very-private");
    expect(output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(output).not.toContain("a".repeat(40));
    expect(output).not.toContain("alice:s3cr3t");
    expect(output).not.toContain("sk_live_abcdefghijklmnop");
  });

  it("bounds retained tool identities for incomplete native items", () => {
    const translator = new CodexEventTranslator();
    const state = createTranslatorState();
    for (let index = 0; index < 2_050; index += 1) {
      translator.translate("item/started", {
        threadId: "thread-one",
        turnId: "turn-one",
        item: { id: `command-${index}`, type: "commandExecution", command: "echo safe" }
      }, state);
    }
    expect(state.itemNames.size).toBe(2_048);
    expect(state.itemNames.has("command-0")).toBe(false);
    expect(state.itemNames.get("command-2049")).toBe("command");
  });
});
