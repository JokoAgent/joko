import { create, toJson } from "@bufbuild/protobuf";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { EventSchema, MessageRole, SessionService, type Event } from "@joko/contracts";
import { expect, it } from "vitest";
import { exportStandaloneTimeline } from "./standalone-task.js";

function reply(runId: string, text: string): Event {
  return create(EventSchema, { eventId: text, identity: { runId, sessionId: "session" },
    payload: { kind: { case: "messageCompleted", value: { role: MessageRole.ASSISTANT,
      blocks: [{ content: { case: "text", value: text } }] } } } });
}

async function exportTimeline(events: Event[], runIds: string[]) {
  let pages = 0;
  const client = createClient(SessionService, createRouterTransport(router => router.service(SessionService, {
    listSessionTimeline(request) {
      pages++;
      expect(request.sessionId).toBe("session");
      const end = Number(request.beforeCursor?.sequence ?? events.length);
      const start = Math.max(0, end - request.limit);
      return { events: events.slice(start, end), nextBeforeCursor: start ? { sequence: BigInt(start) } : undefined };
    }
  })));
  const outcomes = runIds.map(runId => ({ runId, state: "completed" }));
  const output = await exportStandaloneTimeline(outcomes,
    beforeCursor => client.listSessionTimeline({ sessionId: "session", limit: 64, beforeCursor }), JSON.stringify);
  return { ...output, pages };
}

it.each([2048, 2049])("exports both final answers with %i events in the standalone session", async count => {
  const events = Array.from({ length: count }, (_, i) => create(EventSchema, {
    eventId: String(i), identity: { sessionId: "session", runId: "second" },
    payload: { kind: { case: "textDelta", value: { delta: "." } } }
  }));
  events[0] = reply("first", "First answer");
  events[1] = reply("second", "Before the tool");
  events[count - 1] = reply("second", "Final answer");
  const output = await exportTimeline(events, ["first", "second"]);
  expect(output.turns.map(turn => turn.text)).toEqual(["First answer", "Final answer"]);
  expect(output.traceTruncated).toBe(count > 2048);
  expect(output.trace.trimEnd().split("\n").map(line => JSON.parse(line).eventId)).toEqual(
    count === 2048 ? ["First answer", "Before the tool", "Final answer"] : ["Before the tool", "Final answer"]);
  expect(output.pages).toBe(Math.ceil(count / 64));
});

it("keeps a final answer outside the trace line and total byte budgets", async () => {
  const answer = "界".repeat(11_000);
  const first = reply("first", answer);
  first.eventId = "oversized";
  const text = "界".repeat(10_000);
  const following = Array.from({ length: 300 }, (_, i) => {
    const event = reply("second", text);
    event.eventId = `trace-${String(i).padStart(3, "0")}`;
    return event;
  });
  const lineBytes = (event: Event) => Buffer.byteLength(JSON.stringify(toJson(EventSchema, event))) + 1;
  const bytes = lineBytes(following[0]!);
  expect(lineBytes(first)).toBeGreaterThan(32_768);
  expect(bytes).toBeLessThanOrEqual(32_768);
  const count = Math.floor(8 * 1024 * 1024 / bytes);
  expect(count).toBeLessThan(following.length);
  const output = await exportTimeline([first, ...following], ["first", "second"]);
  expect(output.turns.map(turn => turn.text)).toEqual([answer, text]);
  expect(output.traceTruncated).toBe(true);
  expect(Buffer.byteLength(output.trace)).toBe(count * bytes);
  expect(output.trace.trimEnd().split("\n").map(line => JSON.parse(line).eventId)).toEqual(
    following.slice(0, count).map(event => event.eventId));
});

it("keeps the complete reply when an emoji crosses the former 60,000-unit cutoff", async () => {
  const answer = "x".repeat(59_999) + "😀END";
  const output = await exportTimeline([reply("long", answer)], ["long"]);
  expect(output.turns).toEqual([{ runId: "long", state: "completed", text: answer }]);
  expect(output.trace).toBe("");
  expect(output.traceTruncated).toBe(true);
});
