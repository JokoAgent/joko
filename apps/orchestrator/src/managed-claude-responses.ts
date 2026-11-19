import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { AnthropicMessageCollector, ResponsesToClaudeStream, type AnthropicSseEvent } from "./managed-claude-responses-stream.js";
import { readManagedProviderResponse } from "./managed-provider-response.js";

type Fields = Record<string, unknown>;

function record(value: unknown): Fields | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Fields : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function unsupported(): Error {
  return new Error("The Claude request contains content that cannot be sent to the configured Responses Provider.");
}

function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (!Array.isArray(value)) return JSON.stringify(value);
  return value.map(part => {
    const block = record(part);
    if (block?.type === "text" && typeof block.text === "string") return block.text;
    if (block?.type === "image") return "[The tool returned an image that this route cannot include in its tool result.]";
    return JSON.stringify(part);
  }).join("\n");
}

function unwrapReasoning(block: Fields, signaturePrefix: string): Fields | undefined {
  const signature = block.type === "thinking" ? block.signature : block.data;
  if (typeof signature !== "string" || !signature.startsWith(signaturePrefix)) return undefined;
  const stored = signature.slice(signaturePrefix.length);
  const end = stored.startsWith("#id=") ? stored.indexOf("#", 4) : -1;
  const encrypted = end > 4 ? stored.slice(end + 1) : stored;
  if (encrypted.length === 0) return undefined;
  return {
    type: "reasoning",
    ...(end > 4 ? { id: stored.slice(4, end) } : {}),
    summary: nonEmpty(block.thinking) ? [{ type: "summary_text", text: block.thinking }] : [],
    encrypted_content: encrypted
  };
}

function messageItems(raw: unknown, signaturePrefix: string, supportsImages: boolean): Fields[] {
  const message = record(raw);
  if (message === undefined || (message.role !== "user" && message.role !== "assistant" && message.role !== "system")) throw unsupported();
  const role = message.role === "system" ? "developer" : message.role;
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof message.content === "string") {
    return message.content.length === 0 ? [] : [{ type: "message", role, content: [{ type: textType, text: message.content }] }];
  }
  if (!Array.isArray(message.content)) throw unsupported();
  const items: Fields[] = [];
  let pending: Fields[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    items.push({ type: "message", role, content: pending });
    pending = [];
  };
  for (const value of message.content) {
    const block = record(value);
    if (block === undefined) throw unsupported();
    switch (block.type) {
      case "text":
        if (typeof block.text !== "string") throw unsupported();
        pending.push({ type: textType, text: block.text });
        break;
      case "image": {
        const source = record(block.source);
        if (!supportsImages || role !== "user" || source === undefined) throw unsupported();
        const imageUrl = source.type === "url" && nonEmpty(source.url) ? source.url
          : source.type === "base64" && nonEmpty(source.media_type) && nonEmpty(source.data)
            ? `data:${source.media_type};base64,${source.data}` : undefined;
        if (imageUrl === undefined) throw unsupported();
        pending.push({ type: "input_image", image_url: imageUrl });
        break;
      }
      case "tool_use":
        if (!nonEmpty(block.id) || !nonEmpty(block.name)) throw unsupported();
        flush();
        items.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
        break;
      case "tool_result":
        if (!nonEmpty(block.tool_use_id)) throw unsupported();
        flush();
        items.push({ type: "function_call_output", call_id: block.tool_use_id, output: toolResultText(block.content) });
        break;
      case "thinking":
      case "redacted_thinking": {
        const reasoning = unwrapReasoning(block, signaturePrefix);
        if (reasoning !== undefined) { flush(); items.push(reasoning); }
        break;
      }
      default:
        throw unsupported();
    }
  }
  flush();
  return items;
}

function systemInstructions(value: unknown): string | undefined {
  if (value === undefined || typeof value === "string") return value;
  if (!Array.isArray(value)) throw unsupported();
  return value.map(part => {
    const block = record(part);
    if (block?.type !== "text" || typeof block.text !== "string") throw unsupported();
    return block.text;
  }).filter(Boolean).join("\n\n");
}

export function prepareClaudeResponsesRequest(raw: Fields, options: {
  readonly model: string;
  readonly signaturePrefix: string;
  readonly supportsImages: boolean;
  readonly maxOutputTokens?: number;
}): Fields {
  const { messages, tools, thinking, stream, max_tokens: maxTokens } = raw;
  if (!Array.isArray(messages) || tools !== undefined && !Array.isArray(tools)
    || stream !== undefined && typeof stream !== "boolean" || typeof maxTokens !== "number"
    || !Number.isSafeInteger(maxTokens) || maxTokens < 1) throw unsupported();
  const input = messages.flatMap(message => messageItems(message, options.signaturePrefix, options.supportsImages));
  const instructions = systemInstructions(raw.system);
  const functions = (tools ?? []).map(value => {
    const tool = record(value);
    if (tool === undefined || !nonEmpty(tool.name)) throw unsupported();
    return { type: "function", name: tool.name, ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      parameters: record(tool.input_schema) ?? { type: "object", properties: {} }, strict: false };
  });
  const choice = record(raw.tool_choice);
  let toolChoice: unknown;
  switch (choice?.type) {
    case undefined: break;
    case "none": case "auto": toolChoice = choice.type; break;
    case "any": toolChoice = "required"; break;
    case "tool":
      if (!functions.some(tool => tool.name === choice.name)) throw unsupported();
      toolChoice = { type: "function", name: choice.name };
      break;
    default: throw unsupported();
  }
  const nativeThinking = record(thinking);
  let reasoning: Fields | undefined;
  if (nativeThinking?.type === "adaptive" || nativeThinking?.type === "enabled") {
    const budget = nativeThinking.budget_tokens;
    const effort = record(raw.output_config)?.effort;
    let selectedEffort = "medium";
    if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh") selectedEffort = effort;
    else if (typeof budget === "number" && budget > 0 && budget <= 4_096) selectedEffort = "low";
    else if (typeof budget === "number" && budget > 16_384) selectedEffort = "high";
    reasoning = { effort: selectedEffort, summary: "auto" };
  }
  return {
    model: options.model, input, store: false, stream: true,
    max_output_tokens: Math.min(maxTokens, options.maxOutputTokens ?? maxTokens),
    ...(instructions ? { instructions } : {}),
    ...(functions.length > 0 ? { tools: functions, parallel_tool_calls: choice?.disable_parallel_tool_use !== true,
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }) } : {}),
    ...(reasoning === undefined ? {} : { reasoning, include: ["reasoning.encrypted_content"] })
  };
}

export function estimateClaudeInputTokens(raw: Fields): number | undefined {
  if (!Array.isArray(raw.messages)) return undefined;
  // The Responses endpoint has no Claude token-count route. Use the same local estimate for repeated SDK probes.
  const serialized = JSON.stringify({ system: raw.system, tools: raw.tools, messages: raw.messages }, (_key, value: unknown) => {
    const block = record(value);
    return block?.type === "image" ? "image".repeat(800) : value;
  });
  return Math.max(1, Math.ceil(serialized.length / 4));
}

export async function writeClaudeResponse(input: {
  readonly upstream: Response;
  readonly response: ServerResponse;
  readonly model: string;
  readonly signaturePrefix: string;
  readonly streaming: boolean;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}): Promise<void> {
  const { upstream, response, signal } = input;
  if (upstream.body === null) throw new Error("The Responses Provider returned no body.");
  const assertCurrent = () => { signal.throwIfAborted(); input.assertCurrent(); };
  const sse = upstream.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
  const translator = new ResponsesToClaudeStream(input.model, input.signaturePrefix);
  const collector = input.streaming ? undefined : new AnthropicMessageCollector();
  const emit = async (events: readonly AnthropicSseEvent[]) => {
    for (const { event, data } of events) {
      assertCurrent();
      if (collector !== undefined) { collector.push({ event, data }); continue; }
      if (!response.headersSent) response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
      if (!response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) await once(response, "drain", { signal });
    }
  };
  for await (const payload of readManagedProviderResponse({ body: upstream.body, sse, assertCurrent })) {
    if (sse && payload.trim() === "[DONE]") break;
    const event: unknown = JSON.parse(payload);
    await emit(sse ? translator.push(event) : translator.pushJson(event));
  }
  await emit(translator.finish());
  assertCurrent();
  if (collector !== undefined) {
    const result = collector.finish();
    response.writeHead(result.ok ? 200 : 502, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(result.ok ? result.message : { type: "error", error: result.error }));
  } else response.end();
}
