import { describe, expect, it } from "vitest";
import type { InteractionQuestionAnswer } from "@joko/core";
import type { JsonValue } from "./protocol.js";
import { CodexEventTranslator, createTranslatorState, interactionFromServerRequest } from "./translator.js";

describe("Codex interaction translation", () => {
  it("separates cumulative uncached usage from the latest request pricing and context", () => {
    const translator = new CodexEventTranslator();
    const state = createTranslatorState();
    const last = { inputTokens: 272_000, outputTokens: 1_000, cachedInputTokens: 100_000, cacheWriteInputTokens: 2_000, totalTokens: 273_000 };
    const first = translator.translate("thread/tokenUsage/updated", {
      threadId: "thread-one", turnId: "turn-one",
      tokenUsage: { total: last, last, modelContextWindow: 872_000 }
    }, state);
    expect(first).toEqual([{ type: "usage", usage: {
      inputTokens: 170_000, outputTokens: 1_000, cacheReadTokens: 100_000, cacheWriteTokens: 2_000,
      totalTokens: 273_000, contextTokens: 273_000, contextWindow: 872_000,
      pricingContext: { inputTokens: 272_000 }, cost: 0
    } }]);
    state.observedFastMode = true;
    const second = translator.translate("thread/tokenUsage/updated", {
      threadId: "thread-one", turnId: "turn-two",
      tokenUsage: {
        total: { inputTokens: 544_000, outputTokens: 2_000, cachedInputTokens: 200_000, cacheWriteInputTokens: 4_000, totalTokens: 546_000 },
        last, modelContextWindow: 872_000
      }
    }, state);
    expect(second).toEqual([{ type: "usage", usage: {
      inputTokens: 340_000, outputTokens: 2_000, cacheReadTokens: 200_000, cacheWriteTokens: 4_000,
      totalTokens: 546_000, contextTokens: 273_000, contextWindow: 872_000,
      pricingContext: { inputTokens: 272_000, fastMode: true }, cost: 0
    } }]);
    expect(state.usage).toEqual(second[0]?.type === "usage" ? second[0].usage : undefined);
  });

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

  it("keeps the complete file-change identity and diff from start through completion", () => {
    const translator = new CodexEventTranslator();
    const state = createTranslatorState();
    const item: JsonValue = {
      id: "change-one",
      type: "fileChange",
      status: "completed",
      changes: [
        { path: "src/old.ts", kind: { type: "update", move_path: "src/new.ts" }, diff: "-old\n+new" },
        { path: "src/added.ts", kind: { type: "add" }, diff: "+added" }
      ]
    };
    const started = translator.translate("item/started", { threadId: "thread-one", turnId: "turn-one", item }, state);
    const completed = translator.translate("item/completed", { threadId: "thread-one", turnId: "turn-one", item }, state);

    expect(started).toEqual([expect.objectContaining({
      type: "tool_start",
      callId: "change-one",
      name: "file_change",
      input: JSON.stringify({ changes: [
        { path: "src/old.ts", kind: { type: "update", movePath: "src/new.ts" }, diff: "-old\n+new" },
        { path: "src/added.ts", kind: { type: "add" }, diff: "+added" }
      ] })
    })]);
    expect(completed).toEqual([expect.objectContaining({
      type: "tool_result",
      callId: "change-one",
      output: "move: src/old.ts -> src/new.ts\nadd: src/added.ts",
      isError: false
    })]);
  });

  it("creates a complete file-change call from Codex v2's completion-only notification", () => {
    const translator = new CodexEventTranslator();
    const item: JsonValue = {
      id: "change-completed",
      type: "fileChange",
      status: "completed",
      changes: [
        { path: "src/old.ts", kind: { type: "update", move_path: "src/new.ts" }, diff: "-old\n+new" },
        { path: "src/added.ts", kind: { type: "add" }, diff: "+added" }
      ]
    };

    expect(translator.translate("item/completed", {
      threadId: "thread-one",
      turnId: "turn-one",
      item
    }, createTranslatorState())).toEqual([
      {
        type: "tool_start",
        callId: "change-completed",
        name: "file_change",
        input: JSON.stringify({ changes: [
          { path: "src/old.ts", kind: { type: "update", movePath: "src/new.ts" }, diff: "-old\n+new" },
          { path: "src/added.ts", kind: { type: "add" }, diff: "+added" }
        ] })
      },
      {
        type: "tool_result",
        callId: "change-completed",
        name: "file_change",
        output: "move: src/old.ts -> src/new.ts\nadd: src/added.ts",
        isError: false
      }
    ]);
  });

  it("fails the whole structured file-change payload closed and treats native decline as an error", () => {
    const item: JsonValue = {
      id: "change-declined",
      type: "fileChange",
      status: "declined",
      changes: [
        { path: "src/valid.ts", kind: { type: "update" }, diff: "+valid" },
        { path: "", kind: { type: "update" }, diff: "+invalid" }
      ]
    };

    expect(new CodexEventTranslator().translate("item/completed", {
      threadId: "thread-one",
      turnId: "turn-one",
      item
    }, createTranslatorState())).toEqual([
      expect.objectContaining({
        type: "tool_start",
        name: "file_change",
        input: "Workspace file change (structured payload unavailable)."
      }),
      expect.objectContaining({
        type: "tool_result",
        output: "Workspace file change (structured payload unavailable).",
        isError: true
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
      choices: ["allow_once", "deny_once"]
    });
    expect(command?.toResponse({ kind: "selected", value: "allow_once" })).toEqual({ decision: "accept" });
    expect(command?.toResponse({ kind: "selected", value: "deny_once" })).toEqual({ decision: "cancel" });
    expect(command?.toResponse({ kind: "selected", value: "allow_for_session" })).toEqual({ decision: "cancel" });

    const file = interactionFromServerRequest(2, "item/fileChange/requestApproval", {
      threadId: "thread-one",
      turnId: "turn-one",
      itemId: "file-one",
      reason: "Update a source file"
    }, "D:\\workspace");
    expect(file?.payload).toMatchObject({ kind: "permission", toolName: "file_change", choices: ["allow_once", "deny_once"] });
    expect(file?.toResponse({ kind: "selected", value: "allow_once" })).toEqual({ decision: "accept" });
    expect(file?.toResponse({ kind: "selected", value: "allow_for_session" })).toEqual({ decision: "decline" });
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
      choices: ["allow_once", "deny_once"]
    });
    expect(interaction?.toResponse({ kind: "selected", value: "allow_once" })).toEqual({ decision: "accept" });
    expect(interaction?.toResponse({ kind: "selected", value: "allow_for_session" })).toEqual({ decision: "decline" });
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
    expect(interaction?.payload).toMatchObject({ kind: "permission", toolName: "permissions", choices: ["allow_once", "deny_once"] });
    expect(interaction?.toResponse({ kind: "selected", value: "allow_once" })).toEqual({
      permissions: requested,
      scope: "turn"
    });
    expect(interaction?.toResponse({ kind: "selected", value: "allow_for_session" })).toEqual({
      permissions: {},
      scope: "turn"
    });
    expect(interaction?.toResponse({ kind: "selected", value: "deny_once" })).toEqual({
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
      answers: {
        name: { kind: "text", value: "Joko" },
        mode: { kind: "single", selection: { kind: "choice", choiceId: "safe" } }
      }
    })).toEqual({
      answers: {
        name: { answers: ["Joko"] },
        mode: { answers: ["safe"] }
      }
    });
  });

  it("keeps explicit Other text distinct when it equals a generated choice ID", () => {
    const interaction = interactionFromServerRequest(41, "item/tool/requestUserInput", {
      threadId: "thread-one",
      turnId: "turn-one",
      itemId: "question-other-collision",
      questions: [{
        id: "mode",
        question: "Mode?",
        isOther: true,
        options: [{ label: "Safe route", description: "Use safe mode" }]
      }]
    }, "D:\\workspace");
    expect(interaction?.payload.kind).toBe("question");
    const field = interaction?.payload.kind === "question" ? interaction.payload.fields[0] : undefined;
    expect(field).toMatchObject({ kind: "single", allowOther: true });
    const choiceId = field?.kind === "single" ? field.choices[0]?.id : undefined;
    expect(choiceId).toBeTruthy();

    expect(interaction?.toResponse({
      kind: "question",
      answers: { mode: { kind: "single", selection: { kind: "choice", choiceId: choiceId! } } }
    })).toEqual({ answers: { mode: { answers: ["Safe route"] } } });
    expect(interaction?.toResponse({
      kind: "question",
      answers: { mode: { kind: "single", selection: { kind: "other", text: choiceId! } } }
    })).toEqual({ answers: { mode: { answers: [choiceId] } } });
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
        name: { kind: "text", value: `password=very-private ${oversized}` },
        mode: { kind: "single", selection: { kind: "choice", choiceId: "fast" } },
        third: { kind: "text", value: oversized },
        ignored: { kind: "text", value: "not-returned" },
        unknown: { kind: "text", value: "not-returned" }
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
      answers: Object.assign(Object.create(null) as Record<string, InteractionQuestionAnswer>, {
        __proto__: { kind: "text", value: "safe" }
      })
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
