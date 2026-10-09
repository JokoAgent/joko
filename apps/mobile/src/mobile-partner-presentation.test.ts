import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { EventSchema, MessageRole, PartnerPrivateMessageOriginSchema, type Event } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { timelineRows, type TimelineRow } from "./timeline";
import { mobileWorkItems } from "./mobile-work-projection";
import { formatMobilePartnerTime, mobilePartnerConversationRows, mobilePartnerTimeGroups, mobilePublicConversationInputs } from "./mobile-partner-presentation";
import { producedImageEvent } from "./test/timeline-media";

function row(id: string, patch: Partial<TimelineRow> = {}): TimelineRow {
  return { id, eventId: `event-${id}`, sequence: 1n, kind: "assistant", label: "Assistant", text: id, completed: true,
    ownerScope: "owner", runScope: "run", startedAtMs: 1_000, lastActivityAtMs: 2_000, ...patch };
}
function event(id: string, sequence: bigint, kind: NonNullable<MessageInitShape<typeof EventSchema>["payload"]>["kind"], runId = "run"): Event {
  return create(EventSchema, { eventId: id, identity: { sessionId: "session", runId, generation: 1n },
    cursor: { sequence, generation: 1n }, occurredAt: { seconds: sequence }, payload: { kind } });
}
const complete = (id: string, sequence: bigint, runId = "run") => event(`event-${id}`, sequence,
  { case: "messageCompleted", value: { messageId: id, role: MessageRole.ASSISTANT,
    blocks: [{ content: { case: "text", value: id } }] } }, runId);

describe("mobile canonical Partner presentation", () => {
  it("uses durable Run done, not a message segment, to reveal every contiguous sealed reply", () => {
    const segments = [complete("one", 1n), complete("two", 2n)];
    expect(mobilePartnerConversationRows(mobileWorkItems(timelineRows(segments, true), true), true, "ada")).toEqual([]);
    const done = event("done", 3n, { case: "runDone", value: { runId: "run" } });
    const rows = timelineRows([...segments, done]); const original = structuredClone(rows);
    const projected = mobilePartnerConversationRows(mobileWorkItems(rows, false), false, "ada");
    expect(projected.map((item) => item.id)).toEqual(["one", "two"]);
    expect(projected[1]).toMatchObject({ runOutcome: "completed", completionCursor: 2n, eventId: "event-two" });
    expect(rows).toEqual(original);
    const mixed = event("mixed", 4n, { case: "messageCompleted", value: { messageId: "mixed", role: MessageRole.ASSISTANT,
      blocks: [{ content: { case: "thinking", value: { text: "private reasoning" } } },
        { content: { case: "text", value: "Delivered answer" } }] } });
    const answer = mobilePartnerConversationRows(timelineRows([mixed, event("seal", 5n, { case: "runDone", value: { runId: "run" } })]), false, "ada")[0]!;
    expect(answer.messageParts?.map((part) => part.kind)).toEqual(["text"]);
    expect(answer.text).toBe("Delivered answer");
  });

  it("does not seal another run, owner or history window and falls back only after work stops", () => {
    const items = [row("older", { runScope: "prior", sequence: 1n }), row("sealed", {
      sequence: 2n, runOutcome: "completed" })];
    expect(mobilePartnerConversationRows(items, true, "ada").map((item) => item.id)).toEqual(["sealed"]);
    const later = row("later", { ownerScope: "other", sequence: 3n, startedAtMs: 2_000_000 });
    expect(mobilePartnerConversationRows([items[0]!, later], true, "ada").map((item) => item.id)).toEqual(["older"]);
    expect(mobilePartnerConversationRows([row("first"), row("last", { sequence: 2n })], false, "ada")
      .map((item) => item.id)).toEqual(["last"]);
    const gap = row("gap", { startedAtMs: 2_000_000, lastActivityAtMs: 2_000_001, runOutcome: "completed" });
    expect(mobilePartnerConversationRows([row("before"), gap], true, "ada").map((item) => item.id)).toEqual(["before", "gap"]);
  });

  it("keeps rendered Markdown and canonical produced media without resurrecting its preamble", () => {
    const source = event("media-event", 3n, { case: "messageCompleted", value: { messageId: "media", role: MessageRole.ASSISTANT,
      blocks: [{ content: { case: "image", value: { widthPixels: 20, heightPixels: 20, blob: {
        blobId: "output-image", fileName: "output.png", mediaType: "image/png", byteSize: 256n, sha256Hex: "a".repeat(64)
      } } } }] } }); const produced = producedImageEvent(source);
    const imageRows = timelineRows([produced]);
    expect(imageRows[0]?.images).toHaveLength(1);
    const projected = mobilePartnerConversationRows([row("preamble", { ownerScope: imageRows[0]!.ownerScope,
      runScope: imageRows[0]!.runScope }), ...imageRows], false, "ada");
    expect(projected.map((item) => item.id)).toEqual(imageRows.map((item) => item.id));
    expect(projected[0]?.images).toEqual(imageRows[0]?.images);
    expect(mobilePartnerConversationRows([row("text"), row("image", { text: "![output](https://node.example/output.png)", sequence: 2n })], true, "ada")
      .map((item) => item.id)).toEqual(["image"]);
    expect(mobilePartnerConversationRows([row("code", { text: "`![not an image](https://node.example/x.png)`" })], true, "ada")).toEqual([]);
  });

  it("hides Host internal input and raw private prompts while keeping the exact read-only receipt and private reply", () => {
    const origin = { messageId: "private-1", threadId: "thread-1", senderPartnerId: "bea", recipientPartnerId: "ada", senderDisplayName: "Bea" };
    const privateEvents = [event("private-input", 1n, { case: "messageStarted", value: {
      messageId: "private", role: MessageRole.USER, userInputAccepted: true, partnerPrivateOrigin: origin,
      userInput: { parts: [{ content: { case: "text", value: "private raw body" } }] }
    } }), complete("reply", 2n), event("done", 3n, { case: "runDone", value: { runId: "run" } })];
    const projected = mobilePartnerConversationRows(timelineRows(privateEvents), false, "ada");
    expect(mobilePublicConversationInputs(timelineRows(privateEvents))[0]).toMatchObject({ kind: "activity", text: "",
      partnerPrivatePreview: { threadId: "thread-1", targetPartnerId: "bea" } });
    expect(projected[0]).toMatchObject({ kind: "activity", text: "", partnerPrivatePreview: {
      threadId: "thread-1", targetPartnerId: "bea", targetName: "Bea" } });
    expect(JSON.stringify(projected.map(({ text }) => text))).not.toContain("private raw body");
    expect(mobilePartnerConversationRows(timelineRows(privateEvents), false, "other").some((item) => item.id === "private")).toBe(false);
    const internal = event("internal", 4n, { case: "messageStarted", value: { messageId: "internal", role: MessageRole.USER,
      automaticContinuation: true, userInputAccepted: true, userInput: { parts: [{ content: { case: "text", value: "internal prompt" } }] } } });
    expect(mobilePartnerConversationRows(timelineRows([internal]), false, "ada")).toEqual([]);
    expect(mobilePublicConversationInputs(timelineRows([internal]))).toEqual([]);
    const internalCompleted = event("internal-complete", 5n, { case: "messageCompleted", value: { messageId: "internal",
      role: MessageRole.USER, blocks: [{ content: { case: "text", value: "internal prompt" } }] } });
    expect(mobilePublicConversationInputs(timelineRows([internal, internalCompleted]))).toEqual([]);
    const privateReply = complete("private-reply", 5n);
    if (privateReply.payload?.kind.case === "messageCompleted") {
      privateReply.payload.kind.value.partnerPrivateOrigin = create(PartnerPrivateMessageOriginSchema, origin);
    }
    expect(mobilePartnerConversationRows(timelineRows([privateReply]), false, "ada")[0]?.partnerPrivateOrigin?.threadId).toBe("thread-1");
  });

  it("keeps stopped/error and owned task deliveries while hiding plan and technical work", () => {
    const stopped = event("stopped", 2n, { case: "runAborted", value: { runId: "run" } });
    const failed = event("error", 3n, { case: "terminalError", value: { error: { message: "Try again" } } });
    const projected = mobilePartnerConversationRows(timelineRows([complete("unfinished", 1n), stopped, failed]), false, "ada");
    expect(projected.some((item) => item.runStopped)).toBe(true);
    expect(projected.some((item) => item.kind === "error" && item.text === "Try again")).toBe(true);
    expect(projected.find((item) => item.id === "unfinished")?.runOutcome).toBe("failed");
    const technical = row("technical", { kind: "tool", text: "technical arguments" });
    const owned = { ...technical, id: "handover", partnerDelivery: true };
    const result = mobilePartnerConversationRows([technical, owned, row("status", { kind: "status" })], false, "ada");
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ id: "handover", kind: "activity", text: "" });
  });

  it("groups only visible conversation messages at five-minute boundaries and formats local dates", () => {
    const rows = [row("user", { kind: "user", startedAtMs: 1_000 }), row("reply", { startedAtMs: 299_999 }),
      row("technical", { kind: "status", startedAtMs: 300_001 }), row("next", { startedAtMs: 301_000 })];
    expect([...mobilePartnerTimeGroups(rows)]).toEqual([["user", 1_000], ["next", 301_000]]);
    const now = new Date(2026, 9, 10, 12).getTime();
    expect(formatMobilePartnerTime(now, "en", now)).toMatch(/12/);
    expect(formatMobilePartnerTime(new Date(2025, 9, 9, 12).getTime(), "en", now)).toMatch(/2025/);
  });
});
