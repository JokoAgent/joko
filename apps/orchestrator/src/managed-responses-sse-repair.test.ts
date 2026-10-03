import { describe, expect, it } from "vitest";
import {
  createManagedResponsesSseRepair,
  type ManagedResponsesSseRepair
} from "./managed-responses-sse-repair.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

describe("managed Responses SSE repair", () => {
  it("gates only on the managed Responses protocol and exact SSE media type", () => {
    expect(createManagedResponsesSseRepair({
      protocol: "openai-responses",
      contentType: " Text/Event-Stream ; charset=utf-8"
    })).toBeDefined();
    expect(createManagedResponsesSseRepair({
      protocol: "anthropic-messages",
      contentType: "text/event-stream"
    })).toBeUndefined();
    expect(createManagedResponsesSseRepair({
      protocol: "openai-responses",
      contentType: "text/event-streaming"
    })).toBeUndefined();
    expect(createManagedResponsesSseRepair({
      protocol: "openai-responses",
      contentType: "application/json"
    })).toBeUndefined();
  });

  it("repairs only required null arrays in item and full-response events", () => {
    const source = [
      frame({
        type: "response.output_item.added",
        item: { id: "reasoning", type: "reasoning", summary: null, content: null, retained: true }
      }, "\n\n", ["event: response.output_item.added", "id: one"]),
      frame({
        type: "response.output_item.done",
        item: { id: "message", type: "message", content: null, status: "completed" }
      }, "\r\n\r\n"),
      frame({
        type: "response.completed",
        response: { id: "response", output: [
          { type: "reasoning", summary: null, content: null },
          { type: "message", content: null },
          { type: "function_call", arguments: null },
          { type: "future_item", content: null }
        ] }
      }, "\n\r\n")
    ].join("");

    const result = run(source);
    const events = parseEvents(result);
    expect(result).toContain("event: response.output_item.added");
    expect(result).toContain("id: one");
    expect(events[0]).toMatchObject({
      item: { type: "reasoning", summary: [], content: null, retained: true }
    });
    expect(events[1]).toMatchObject({ item: { type: "message", content: [] } });
    expect(events[2]).toMatchObject({ response: { output: [
      { type: "reasoning", summary: [], content: null },
      { type: "message", content: [] },
      { type: "function_call", arguments: null },
      { type: "future_item", content: null }
    ] } });
  });

  it("keeps optional fields, function calls, deltas, unknown and malformed frames byte-identical", () => {
    const source = [
      frame({ type: "response.output_item.added", item: { type: "reasoning", content: null } }),
      frame({ type: "response.output_item.done", item: { type: "function_call", content: null, summary: null } }),
      frame({
        type: "response.output_text.delta",
        delta: "keep",
        response: { output: [{ type: "message", content: null }] }
      }),
      frame({ type: "future.output_item.added", item: { type: "message", content: null } }),
      "event: malformed\r\ndata: {not-json}\r\n\r\n",
      "data: [DONE]\n\n",
      ": comment\ndata: ordinary text\n\n"
    ].join("");
    const repair = enabledRepair();
    const bytes = textEncoder.encode(source);
    const chunks = [bytes.subarray(0, 13), bytes.subarray(13, 79), bytes.subarray(79)];
    const output = chunks.flatMap((chunk) => repair.write(chunk));
    output.push(...repair.finish());

    expect(concatenateOutput(output)).toEqual(bytes);
  });

  it("keeps invalid UTF-8 frames byte-identical across chunks", () => {
    const prefix = textEncoder.encode("data: ");
    const suffix = textEncoder.encode("\r\n\r\ndata: [DONE]\n\n");
    const source = new Uint8Array(prefix.byteLength + 2 + suffix.byteLength);
    source.set(prefix);
    source.set([0xff, 0xfe], prefix.byteLength);
    source.set(suffix, prefix.byteLength + 2);
    const repair = enabledRepair();
    const output = [
      ...repair.write(source.subarray(0, prefix.byteLength + 1)),
      ...repair.write(source.subarray(prefix.byteLength + 1)),
      ...repair.finish()
    ];

    expect(concatenateOutput(output)).toEqual(source);
  });

  it("handles split UTF-8, LF/CRLF/mixed boundaries and an unterminated final frame", () => {
    const first = frame({
      type: "response.output_item.added",
      item: { type: "reasoning", summary: null, label: "理由😀" }
    }, "\r\n\r\n");
    const second = frame({
      type: "response.output_item.done",
      item: { type: "message", content: null, label: "完成" }
    }, "\r\n\n");
    const final = frame({
      type: "response.completed",
      response: { output: [{ type: "message", content: null, label: "末帧" }] }
    }, "");
    const bytes = textEncoder.encode(first + second + final);
    const repair = enabledRepair();
    const output: Uint8Array[] = [];
    for (const byte of bytes) output.push(...repair.write(Uint8Array.of(byte)));
    output.push(...repair.finish());

    const result = textDecoder.decode(concatenateOutput(output));
    expect(result).toContain("理由😀");
    expect(result).toContain("完成");
    expect(result).toContain("末帧");
    expect(parseEvents(result).map((event) => event.type)).toEqual([
      "response.output_item.added",
      "response.output_item.done",
      "response.completed"
    ]);
    expect(parseEvents(result)[0]).toMatchObject({ item: { summary: [] } });
    expect(parseEvents(result)[1]).toMatchObject({ item: { content: [] } });
    expect(parseEvents(result)[2]).toMatchObject({ response: { output: [{ content: [] }] } });
  });

  it("passes an oversized frame through unchanged and resumes repairing after its boundary", () => {
    const large = `data: ${JSON.stringify({
      type: "response.output_item.added",
      item: { type: "reasoning", summary: null },
      padding: "x".repeat(16 * 1024 * 1024)
    })}`;
    const following = frame({
      type: "response.output_item.done",
      item: { type: "message", content: null }
    }, "\n\n");
    const repair = enabledRepair();
    const output = [...repair.write(textEncoder.encode(large))];
    output.push(...repair.write(textEncoder.encode(`\r\n\n${following}`)));
    output.push(...repair.finish());
    const result = textDecoder.decode(concatenateOutput(output));

    expect(result.startsWith(`${large}\r\n\n`)).toBe(true);
    expect(parseEvents(result.slice(large.length + 3))[0]).toMatchObject({
      item: { type: "message", content: [] }
    });
  });
});

function enabledRepair(): ManagedResponsesSseRepair {
  return createManagedResponsesSseRepair({
    protocol: "openai-responses",
    contentType: "text/event-stream"
  })!;
}

function frame(value: unknown, delimiter = "\n\n", fields: readonly string[] = []): string {
  return [...fields, `data: ${JSON.stringify(value)}`].join(delimiter.startsWith("\r\n") ? "\r\n" : "\n")
    + delimiter;
}

function run(source: string): string {
  const repair = enabledRepair();
  const output = [...repair.write(textEncoder.encode(source)), ...repair.finish()];
  return textDecoder.decode(concatenateOutput(output));
}

function concatenateOutput(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseEvents(source: string): JsonEvent[] {
  return source.split(/(?:\r?\n){2}|\n\r\n|\r\n\n/gu).flatMap((raw) => {
    const data = raw.split(/\r?\n/gu)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return [];
    try {
      return [JSON.parse(data) as JsonEvent];
    } catch {
      return [];
    }
  });
}

interface JsonEvent {
  readonly type?: string;
  readonly [key: string]: unknown;
}
