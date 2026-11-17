import { create } from "@bufbuild/protobuf";
import { EventIdentitySchema, EventSchema, MessageRole, type Event } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { mobileThinkingViews } from "./mobile-thinking-projection";

function event(sequence: number, kind: string, value: unknown, scope: Partial<Pick<NonNullable<Event["identity"]>, "backendId" | "targetId" | "sessionId" | "runId" | "attemptId" | "generation">> = {}): Event {
  return create(EventSchema, { eventId: `event-${sequence}-${JSON.stringify(scope, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry)}`, identity: create(EventIdentitySchema, {
    backendId: "pi", targetId: "target", sessionId: "session", runId: "run", attemptId: "attempt", generation: 3n, ...scope }),
    cursor: { sequence: BigInt(sequence), generation: 12n }, occurredAt: { seconds: BigInt(sequence) },
    payload: { kind: { case: kind, value } as any } });
}

const delta = (sequence: number, index: number, text: string, hidden = false, scope = {}) =>
  event(sequence, "thinkingDelta", { messageId: "message", contentIndex: index, delta: text, hidden }, scope);
const completed = (sequence: number, blocks: unknown[], scope = {}) =>
  event(sequence, "messageCompleted", { messageId: "message", role: MessageRole.ASSISTANT, blocks }, scope);
const thinking = (text: string, redacted = false) => ({ content: { case: "thinking", value: { text, redacted } } });

describe("mobile thinking public projection", () => {
  it("seals a Pi phase before the assistant message, preserves its stable card, and adopts only the exact live source", () => {
    const first = delta(1, 0, "Draft thinking");
    const terminal = event(2, "thinkingDelta", { messageId: "message", contentIndex: 0, delta: "", final: true, finalText: "Final thinking", durationMs: 2_500n });
    const before = mobileThinkingViews([first], true)[0]!;
    expect(mobileThinkingViews([first, terminal, delta(3, 0, " late")], true)).toMatchObject([
      { text: "Final thinking", completed: true, streaming: false, durationMs: 2_500 }
    ]);
    const final = event(4, "messageCompleted", { messageId: "completion-event", role: MessageRole.ASSISTANT, blocks: [
      { content: { case: "thinking", value: { text: "Final thinking", redacted: false, streamBlockId: "message", durationMs: 2_500n } } },
      { content: { case: "text", value: "Answer" } }
    ] });
    const encoded = JSON.stringify([first, terminal, final], (_key, value) => typeof value === "bigint" ? value.toString() : value);
    const rows = mobileThinkingViews([first, terminal, final, delta(5, 0, " late")], true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: before.key, messageId: "completion-event", text: "Final thinking", completed: true, streaming: false, durationMs: 2_500 });
    expect(JSON.stringify([first, terminal, final], (_key, value) => typeof value === "bigint" ? value.toString() : value)).toBe(encoded);
    const invalid = event(2, "thinkingDelta", { messageId: "message", contentIndex: 0, delta: "", final: true });
    expect(mobileThinkingViews([first, invalid], true)[0]).toMatchObject({ text: "Draft thinking", completed: false, streaming: true });
    const other = delta(3, 2, "Other thinking");
    expect(mobileThinkingViews([first, terminal, other, delta(4, 2, " continues")], true).find(row => row.contentIndex === 2))
      .toMatchObject({ text: "Other thinking continues", streaming: true, completed: false });
    const hidden = event(2, "thinkingDelta", { messageId: "message", contentIndex: 0, delta: "", final: true, hidden: true, finalText: "PRIVATE" });
    expect(mobileThinkingViews([first, hidden, final], true)).toMatchObject([{ redacted: true, text: "", streaming: false }]);
    const nextService = event(4, "messageCompleted", { messageId: "new-service-completion", role: MessageRole.ASSISTANT,
      blocks: [{ content: { case: "thinking", value: { text: "Other service", streamBlockId: "message" } } }] });
    nextService.cursor!.generation = 13n;
    expect(mobileThinkingViews([first, nextService], true)).toHaveLength(2);
  });

  it.each([{ backendId: "codex" }, { targetId: "other" }, { sessionId: "other" }, { runId: "other" },
    { attemptId: "other" }, { attemptId: "" }, { backendId: "" }, { targetId: "" }, { generation: 4n }])("does not adopt a thinking source from another owner: %o", scope => {
    const first = delta(1, 0, "Original owner");
    const final = event(2, "messageCompleted", { messageId: "other-completion", role: MessageRole.ASSISTANT,
      blocks: [{ content: { case: "thinking", value: { text: "Other owner", streamBlockId: "message" } } }] }, scope);
    const rows = mobileThinkingViews([first, final], true);
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.text === "Original owner")).toMatchObject({ streaming: true, completed: false });
  });

  it("reconciles every final ordered thinking block and seals late deltas without mutating wire events", () => {
    const first = delta(1, 0, "draft ");
    const second = delta(2, 0, "reasoning");
    const other = delta(3, 2, "another draft");
    const live = mobileThinkingViews([other, second, first, second], true);
    expect(live.map((row) => row.text)).toEqual(["draft reasoning", "another draft"]);
    expect(live[0]).toMatchObject({ streaming: true, completed: false, startedAtMs: 1_000, lastActivityAtMs: 2_000 });
    const final = completed(4, [thinking("final reasoning"), { content: { case: "text", value: "Answer" } }, thinking("second final")]);
    const rows = mobileThinkingViews([first, second, other, final, delta(5, 0, " late")], true);
    expect(rows.map((row) => [row.contentIndex, row.text])).toEqual([[0, "final reasoning"], [2, "second final"]]);
    expect(rows.map((row) => row.key)).toEqual(live.map((row) => row.key));
    expect(rows.every((row) => row.completed && !row.streaming)).toBe(true);
    expect(final.payload?.kind.case === "messageCompleted" && final.payload.kind.value.blocks).toHaveLength(3);
    expect(rows[0]).not.toHaveProperty("durationMs");
    expect(mobileThinkingViews([first, completed(4, [{ content: { case: "text", value: "Only answer" } }])])).toEqual([]);
  });

  it("restores final-only content, drops empty placeholders, and never exposes hidden or redacted text", () => {
    const restored = mobileThinkingViews([completed(1, [thinking(""), thinking("private", true), thinking("Full\nreasoning")])], true);
    expect(restored.map((row) => [row.contentIndex, row.text, row.redacted])).toEqual([[1, "", true], [2, "Full\nreasoning", false]]);
    expect(restored.every((row) => row.completed && !row.streaming && row.startedAtMs === undefined)).toBe(true);
    const hidden = mobileThinkingViews([delta(1, 0, "before"), delta(2, 0, "secret", true), delta(3, 0, "after")], true);
    expect(hidden).toMatchObject([{ redacted: true, text: "", streaming: false }]);
    expect(mobileThinkingViews([delta(1, 0, "")], true)).toEqual([]);
  });

  it("isolates Session, native generation, Run and Attempt and restricts streaming to the real active tail", () => {
    const scopes = [{}, { sessionId: "other" }, { generation: 4n }, { runId: "other-run" }, { attemptId: "other-attempt" }];
    const input = scopes.map((scope, index) => delta(index + 1, 0, `body-${index}`, false, scope));
    expect(new Set(mobileThinkingViews(input, true).map((row) => row.key)).size).toBe(scopes.length);
    const terminal = event(6, "runDone", { runId: "run" }, { attemptId: "" });
    const stopped = mobileThinkingViews([...input, terminal, delta(7, 0, "late")], true);
    expect(stopped.find((row) => row.text === "body-0")?.streaming).toBe(false);
    expect(stopped.find((row) => row.text === "body-3")?.streaming).toBe(true);
    const nextUser = event(8, "messageStarted", { messageId: "next-user", role: MessageRole.USER }, { runId: "next-run" });
    expect(mobileThinkingViews([...input, nextUser], true).find((row) => row.text === "body-0")?.streaming).toBe(false);
    expect(mobileThinkingViews(input, false).every((row) => !row.streaming)).toBe(true);
  });
});
