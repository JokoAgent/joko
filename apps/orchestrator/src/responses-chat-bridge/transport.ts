import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { readManagedProviderResponse } from "../managed-provider-response.js";
import { ChatSseTranslator } from "./translate-response.js";
import { translateResponsesRequestWithContext, type TranslatedResponsesChatRequest } from "./translate-request.js";
import { UnsupportedResponsesFeatureError, type ChatBridgeCapabilities, type ResponsesRequest } from "./types.js";

const DIRECT_FIELDS: ChatBridgeCapabilities["passthroughFields"] = [
  "temperature", "top_p", "frequency_penalty", "presence_penalty", "stop", "seed", "user",
  "metadata", "service_tier", "response_format", "logit_bias"
];

export function prepareChatCompletion(
  body: Record<string, unknown>,
  options: {
    readonly modelId: string;
    readonly endpoint: URL;
    readonly supportsImages: boolean;
    readonly codexHistory?: boolean;
  }
): TranslatedResponsesChatRequest {
  if (body["model"] !== options.modelId || body["previous_response_id"] != null
    || body["conversation"] != null || body["background"] === true
    || (body["tools"] !== undefined && !Array.isArray(body["tools"]))) {
    throw new UnsupportedResponsesFeatureError("request");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(options.endpoint.hostname);
  const official = options.codexHistory === true && options.endpoint.protocol === "https:";
  const deepSeek = official && options.endpoint.hostname === "api.deepseek.com" && /^deepseek/iu.test(options.modelId);
  const gemini = official && options.endpoint.hostname === "generativelanguage.googleapis.com"
    && /^\/v1(?:beta)?\/openai\/chat\/completions\/?$/u.test(options.endpoint.pathname) && /^gemini-/iu.test(options.modelId);
  return translateResponsesRequestWithContext(body as unknown as ResponsesRequest, {
    capabilities: {
      developerRole: "system",
      maxTokensField: "max_tokens",
      streamUsage: true,
      passthroughFields: DIRECT_FIELDS,
      ...(deepSeek ? { reasoningHistoryField: "reasoning_content", toolCallReasoningPlaceholder: true, forceAutoToolChoice: true } : {}),
      ...(gemini ? { reasoningField: "reasoning_effort", googleThoughtSignaturePlaceholder: true } : {}),
      ...(options.supportsImages ? { imageInput: "image_url" as const } : {}),
      ...(loopback ? { systemMessagePolicy: "coalesce-leading" as const } : {})
    }
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

interface ChatResponseSource {
  readonly prepared: TranslatedResponsesChatRequest;
  readonly upstream: Response;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}

export async function* responsesEventsFromChat(input: ChatResponseSource): AsyncGenerator<Readonly<Record<string, unknown>>> {
  const { upstream, prepared, signal } = input;
  if (upstream.body === null) throw new Error("The Chat response body is unavailable.");
  const assertCurrent = () => { signal.throwIfAborted(); input.assertCurrent(); };
  const sse = upstream.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
  const translator = new ChatSseTranslator(prepared.request.model, {
    toolContext: prepared.toolContext,
    toolChoice: prepared.request.tool_choice
  });
  let sawChoice = false;
  let emitted = false;
  function* emit(events: readonly unknown[]) {
    for (const raw of events) {
      assertCurrent();
      const event = record(raw);
      if (event === undefined || typeof event["type"] !== "string") continue;
      emitted = true;
      yield event;
    }
  }
  try {
    for await (const payload of readManagedProviderResponse({ body: upstream.body, sse, assertCurrent })) {
      if (payload.trim() === "[DONE]" && sse) {
        translator.markTerminal();
        break;
      }
      const event = record(JSON.parse(payload));
      if (event === undefined || event["error"] != null) throw new Error("The Chat provider returned an error.");
      const choices = event["choices"];
      if (Array.isArray(choices) && choices.length > 0) {
        const choice = record(choices[0]);
        const finish = choice?.["finish_reason"];
        if (choices.length !== 1 || choice === undefined || (finish != null && (
          typeof finish !== "string" || !["stop", "length", "content_filter", "tool_calls", "function_call"].includes(finish)
        )) || (record(choice["delta"]) === undefined && record(choice["message"]) === undefined && finish == null)) {
          throw new Error("The Chat provider returned an invalid choice.");
        }
        sawChoice = true;
      }
      yield* emit(translator.push(event));
    }
    if (!sawChoice) throw new Error("The Chat response contained no choices.");
    yield* emit(translator.finish(sse));
  } catch {
    assertCurrent();
    if (!sse && !(prepared.request.stream && emitted)) throw new Error("The Chat response could not be translated.");
    yield* emit(translator.fail("The Chat provider did not complete its response."));
  }
}

export async function writeResponsesFromChat(input: ChatResponseSource & { readonly response: ServerResponse }): Promise<void> {
  const { response, prepared, signal } = input;
  const streaming = prepared.request.stream;
  let sequenceNumber = 0;
  let terminal: Readonly<Record<string, unknown>> | undefined;
  for await (const event of responsesEventsFromChat(input)) {
    if (event["type"] === "response.completed" || event["type"] === "response.incomplete" || event["type"] === "response.failed") terminal = record(event["response"]);
    if (!streaming) continue;
    if (!response.headersSent) response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
    const packet = JSON.stringify({ ...event, sequence_number: sequenceNumber++ });
    if (!response.write(`event: ${event["type"]}\ndata: ${packet}\n\n`)) await once(response, "drain", { signal });
  }
  signal.throwIfAborted();
  input.assertCurrent();
  if (streaming) {
    response.end();
    return;
  }
  if (terminal === undefined) throw new Error("The Chat provider did not produce a terminal response.");
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(terminal));
}
