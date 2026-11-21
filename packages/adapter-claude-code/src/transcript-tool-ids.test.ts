import { expect, it } from "vitest";
import { repairClaudeTranscriptText } from "./transcript-tool-ids.js";

interface TestBlock { readonly id: string; readonly tool_use_id: string; readonly input: { readonly literal: string } }
interface TestRow {
  readonly message: { readonly content: readonly TestBlock[] };
  readonly event: { readonly content_block: TestBlock };
  readonly tool_use_id: string;
  readonly preceding_tool_use_ids: readonly string[];
}
const call = (id: string, tool: string) => ({ type: "tool_use", id, name: tool, input: { literal: "Read_38" } });
const result = (tool_use_id: string, content: string) => ({ type: "tool_result", tool_use_id, content });
const message = (uuid: string, role: "user" | "assistant", content: object[], other?: object) => ({
  type: role, uuid, message: { role, content }, ...other
});

it("matches concurrent and retried call results to their exact historical exchanges", () => {
  const input = [
    message("a", "assistant", [call("Read_38", "orphan")], { parent_tool_use_id: "toolu_a" }),
    message("b", "assistant", [call("Read_38", "retry"), call("Read_38", "parallel")], { parent_tool_use_id: "toolu_a" }),
    message("c", "assistant", [call("Read_38", "concurrent")], { parent_tool_use_id: "toolu_b" }),
    message("d", "user", [result("Read_38", "parallel first result"), result("Read_38", "parallel second result")], { parent_tool_use_id: "toolu_a" }),
    message("e", "user", [result("Read_38", "concurrent result")], { sourceToolAssistantUUID: "c" }),
    { type: "tool_use_summary", preceding_tool_use_ids: ["Read_38"] }
  ];
  const text = input.map(row => JSON.stringify(row)).join("\n");
  const output = repairClaudeTranscriptText(text);
  const [orphan, retry, concurrent, parallelResults, concurrentResult, summary] = output.split("\n").map(line => JSON.parse(line) as TestRow);
  const first = retry!.message.content[0]!.id, second = retry!.message.content[1]!.id, other = concurrent!.message.content[0]!.id;
  expect(new Set([first, second, other, orphan!.message.content[0]!.id]).size).toBe(4);
  expect(parallelResults!.message.content.map(block => block.tool_use_id)).toEqual([first, second]);
  expect(concurrentResult!.message.content[0]!.tool_use_id).toBe(other);
  expect(summary!.preceding_tool_use_ids).toEqual([other]);
  expect(retry!.message.content[0]!.input.literal).toBe("Read_38");
  expect(repairClaudeTranscriptText(output)).toBe(output);
});

it("links repeated task records and a preceding stream announcement without touching unaffected raw rows", () => {
  const untouched = ' { "type": "user", "message": { "role": "user", "content": "unchanged" } } ';
  const tail = '{"type":"assistant","message":';
  const text = [
    untouched,
    JSON.stringify({ type: "stream_event", event: { type: "content_block_start", content_block: call("Agent_1", "Agent") } }),
    JSON.stringify(message("assistant", "assistant", [call("Agent_1", "Agent"), call("Agent_1", "Agent")])),
    JSON.stringify({ type: "task_started", task_id: "one", uuid: "u1", tool_use_id: "Agent_1" }),
    JSON.stringify({ type: "task_started", task_id: "two", uuid: "u2", tool_use_id: "Agent_1" }),
    JSON.stringify({ type: "task_progress", task_id: "one", uuid: "u3", tool_use_id: "Agent_1" }),
    JSON.stringify({ type: "tool_use_summary", preceding_tool_use_ids: ["Agent_1", "Agent_1"] }),
    tail
  ].join("\r\n");
  const output = repairClaudeTranscriptText(text).split("\r\n");
  expect(output[0]).toBe(untouched);
  expect(output.at(-1)).toBe(tail);
  const [stream, assistant, one, two, update, summary] = output.slice(1, -1).map(line => JSON.parse(line) as TestRow);
  const first = assistant!.message.content[0]!.id, second = assistant!.message.content[1]!.id;
  expect(stream!.event.content_block.id).toBe(first);
  expect(one!.tool_use_id).toBe(first);
  expect(two!.tool_use_id).toBe(second);
  expect(update!.tool_use_id).toBe(first);
  expect(summary!.preceding_tool_use_ids).toEqual([first, second]);
  const malformed = [output[1], 'malformed middle row', ...output.slice(2, -1)].join("\n").replaceAll(first, "Agent_7");
  expect(repairClaudeTranscriptText(malformed)).toBe(malformed);
});
