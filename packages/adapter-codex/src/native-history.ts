import { createHash } from "node:crypto";
import type {
  AdapterEventMetadata,
  EventPayload,
  MessageBlock,
  NativeHistoryProjectedEvent,
  NativeHistoryProjection
} from "@joko/core";
import {
  isJsonObject,
  ProtocolShapeError,
  type JsonValue,
  type NativeThread,
  type NativeThreadItem,
  type NativeTurn
} from "./protocol.js";
import { safeIdentifier, safeJson, safePath, safeText, toolIdentity } from "./translator.js";

export interface CodexNativeHistoryProjectionOptions {
  readonly maximumEvents: number;
}

interface ItemProjection {
  readonly kind: string;
  readonly contentIndex: number;
  readonly payload: EventPayload;
  readonly fields?: Readonly<Record<string, string | number | boolean>>;
}

export function projectCodexNativeHistory(
  thread: NativeThread,
  options: CodexNativeHistoryProjectionOptions
): NativeHistoryProjection {
  if (!Number.isSafeInteger(options.maximumEvents) || options.maximumEvents < 1) {
    throw new TypeError("Codex native history event bounds must be positive integers.");
  }
  const events: NativeHistoryProjectedEvent[] = [];
  const activeLineage: { entryId: string; parentEntryId?: string }[] = [];
  const seenEntries = new Set<string>();
  let parentEntryId: string | undefined;

  for (const turn of thread.turns) {
    assertHistoryIdentity(turn.id);
    if (turn.items.length === 0) {
      appendLineage(turn.id);
      appendEvents(turn.id, parentEntryId, turn, "turn", [turnStatusProjection(turn)]);
      parentEntryId = turn.id;
      continue;
    }
    for (const [index, item] of turn.items.entries()) {
      assertHistoryIdentity(item.id);
      appendLineage(item.id);
      const projections = [...projectItem(item, turn)];
      if (index === turn.items.length - 1) projections.push(turnStatusProjection(turn));
      appendEvents(item.id, parentEntryId, turn, item.type, projections);
      parentEntryId = item.id;
    }
  }

  return {
    events,
    ...(parentEntryId === undefined ? {} : { activeEntryId: parentEntryId }),
    activeLineage,
    activeEntryMetadata: activeEntryMetadata(parentEntryId)
  };

  function appendLineage(entryId: string): void {
    if (seenEntries.has(entryId)) {
      throw new ProtocolShapeError("native history contains duplicate entry identities");
    }
    seenEntries.add(entryId);
    activeLineage.push({
      entryId,
      ...(parentEntryId === undefined ? {} : { parentEntryId })
    });
  }

  function appendEvents(
    entryId: string,
    parentId: string | undefined,
    turn: NativeTurn,
    itemType: string,
    projections: readonly ItemProjection[]
  ): void {
    if (events.length + projections.length > options.maximumEvents) {
      throw new ProtocolShapeError("native history projection exceeds its event bound");
    }
    for (const projection of projections) {
      const fields: Record<string, string | number | boolean> = {
        nativeHydration: true,
        entryId,
        nativeEntryType: historyIdentifier(itemType),
        turnId: turn.id,
        turnStatus: turn.status,
        ...projection.fields
      };
      if (parentId !== undefined) fields["parentEntryId"] = parentId;
      events.push({
        nativeEntryId: entryId,
        ...(parentId === undefined ? {} : { nativeParentEntryId: parentId }),
        projectionKind: projection.kind,
        contentIndex: projection.contentIndex,
        payload: projection.payload,
        metadata: { namespace: "codex.native_history", fields }
      });
    }
  }
}

function projectItem(item: NativeThreadItem, turn: NativeTurn): readonly ItemProjection[] {
  switch (item.type) {
    case "userMessage": {
      const blocks = userMessageBlocks(item);
      return [{
        kind: "message_user",
        contentIndex: 0,
        payload: { type: "message_complete", role: "user", blocks },
        fields: { nativeDispatchFingerprint: nativeUserFingerprint(item) }
      }];
    }
    case "agentMessage":
      return [assistantProjection(item, turn, "message_assistant")];
    case "plan":
      return [assistantProjection(item, turn, "message_plan")];
    case "reasoning":
      return reasoningProjections(item);
    case "functionCallOutput":
      return [functionCallOutputProjection(item)];
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
      return toolProjections(item);
    case "webSearch":
      return standaloneToolProjections(item, "web_search", safeTextValue(item["query"], "Web search"), webSearchOutput(item));
    case "imageView":
      return standaloneToolProjections(item, "image_view", safePathValue(item["path"], "Image"), "Image inspected.");
    case "sleep":
      return standaloneToolProjections(item, "sleep", durationText(item["durationMs"]), "Wait completed.");
    case "imageGeneration":
      return standaloneToolProjections(
        item,
        "image_generation",
        safeTextValue(item["revisedPrompt"], "Image generation"),
        imageGenerationOutput(item),
        item["failure"] !== null && item["failure"] !== undefined
      );
    case "contextCompaction":
      return [{
        kind: "compaction",
        contentIndex: 0,
        payload: {
          type: "compaction",
          reason: "native",
          compactionId: item.id,
          state: turn.status === "inProgress" ? "started" : turn.status === "completed" ? "completed" : "failed",
          ...(turn.status === "failed"
            ? {
                error: {
                  code: "CODEX_NATIVE_COMPACTION_FAILED",
                  message: "Codex native compaction failed.",
                  phase: "stream",
                  retryable: true,
                  stateMayHaveChanged: true,
                  recovery: "Resume the native thread and inspect its current context state."
                }
              }
            : {})
        }
      }];
    case "enteredReviewMode":
      return [statusProjection("native_review_entered", "Codex entered review mode.")];
    case "exitedReviewMode":
      return [statusProjection("native_review_exited", "Codex exited review mode.")];
    case "hookPrompt":
      return [statusProjection("native_hook_prompt", "Codex applied a native hook prompt.")];
    case "subAgentActivity":
      return [statusProjection("native_subagent_activity", "Codex recorded delegated agent activity.")];
    default: {
      const label = safeIdentifier(safeText(item.type, 128));
      return [statusProjection(
        "native_item_unsupported",
        `Codex history contains an unsupported ${label} item.`
      )];
    }
  }
}

function assistantProjection(item: NativeThreadItem, turn: NativeTurn, kind: string): ItemProjection {
  const text = safeTextValue(item["text"], "[Codex assistant message unavailable]", 1024 * 1024);
  const outcome = terminalOutcome(turn.status);
  return {
    kind,
    contentIndex: 0,
    payload: { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text }] },
    ...(outcome === undefined ? {} : { fields: { nativeTerminalOutcome: outcome } })
  };
}

function reasoningProjections(item: NativeThreadItem): readonly ItemProjection[] {
  const values = [
    ...stringArray(item["summary"]).map((value) => ({ kind: "reasoning_summary", value })),
    ...stringArray(item["content"]).map((value) => ({ kind: "reasoning_content", value }))
  ];
  if (values.length === 0) {
    return [statusProjection("native_reasoning_unavailable", "Codex reasoning content was unavailable.", "reasoning_status")];
  }
  return values.map((part, contentIndex) => ({
    kind: part.kind,
    contentIndex,
    payload: {
      type: "thinking_delta",
      blockId: `reasoning:${item.id}`,
      delta: safeText(part.value, 1024 * 1024),
      contentIndex
    }
  }));
}

function toolProjections(item: NativeThreadItem): readonly ItemProjection[] {
  const identity = toolIdentity(item) ?? fallbackToolIdentity(item);
  const status = typeof item["status"] === "string" ? item["status"] : "failed";
  const projections: ItemProjection[] = [{
    kind: "tool_start",
    contentIndex: 0,
    payload: { type: "tool_start", callId: item.id, name: identity.name, input: identity.input }
  }];
  if (status === "inProgress") return projections;
  projections.push({
    kind: "tool_result",
    contentIndex: 0,
    payload: {
      type: "tool_result",
      callId: item.id,
      name: identity.name,
      output: toolOutput(item, status),
      isError: toolFailed(item, status)
    }
  });
  return projections;
}

function standaloneToolProjections(
  item: NativeThreadItem,
  name: string,
  input: string,
  output: string,
  isError = false
): readonly ItemProjection[] {
  return [
    {
      kind: "tool_start",
      contentIndex: 0,
      payload: { type: "tool_start", callId: item.id, name, input }
    },
    {
      kind: "tool_result",
      contentIndex: 0,
      payload: { type: "tool_result", callId: item.id, name, output, isError }
    }
  ];
}

function functionCallOutputProjection(item: NativeThreadItem): ItemProjection {
  const namespace = typeof item["namespace"] === "string" ? `${historyIdentifier(item["namespace"])}/` : "";
  const name = `${namespace}${typeof item["name"] === "string" ? historyIdentifier(item["name"]) : "function"}`;
  return {
    kind: "tool_result",
    contentIndex: 0,
    payload: {
      type: "tool_result",
      callId: item.id,
      name,
      output: safeStructuredOutput(item["output"]),
      isError: false
    }
  };
}

function fallbackToolIdentity(item: NativeThreadItem): { readonly name: string; readonly input: string } {
  if (item.type === "fileChange") return { name: "file_change", input: fileChangeSummary(item) };
  if (item.type === "collabAgentToolCall") {
    const tool = typeof item["tool"] === "string" ? historyIdentifier(item["tool"]) : "collaboration";
    return { name: `collaboration/${tool}`, input: safeTextValue(item["prompt"], "Agent collaboration", 8_192) };
  }
  return { name: historyIdentifier(item.type), input: "Codex native tool call" };
}

function toolOutput(item: NativeThreadItem, status: string): string {
  switch (item.type) {
    case "commandExecution":
      return safeTextValue(item["aggregatedOutput"], `Command ${historyIdentifier(status)}.`, 256 * 1024);
    case "fileChange":
      return fileChangeSummary(item);
    case "mcpToolCall": {
      const error = isJsonObject(item["error"]) && typeof item["error"]["message"] === "string"
        ? safeText(item["error"]["message"], 256 * 1024)
        : undefined;
      return error ?? safeMcpResult(item["result"]) ?? `MCP tool ${historyIdentifier(status)}.`;
    }
    case "dynamicToolCall":
      return safeStructuredOutput(item["contentItems"]);
    case "collabAgentToolCall":
      return `Collaboration ${historyIdentifier(status)}.`;
    default:
      return `Tool ${historyIdentifier(status)}.`;
  }
}

function toolFailed(item: NativeThreadItem, status: string): boolean {
  if (status === "failed" || status === "declined" || status === "interrupted") return true;
  if (item.type === "mcpToolCall") return item["error"] !== null && item["error"] !== undefined;
  if (item.type === "dynamicToolCall") return item["success"] === false;
  return false;
}

function fileChangeSummary(item: NativeThreadItem): string {
  const changes = Array.isArray(item["changes"]) ? item["changes"] : [];
  const lines = changes.flatMap((change) => {
    if (!isJsonObject(change) || typeof change["path"] !== "string") return [];
    const kind = typeof change["kind"] === "string" ? historyIdentifier(change["kind"]) : "changed";
    return [`${kind}: ${safePath(change["path"])}`];
  });
  return safeText(lines.join("\n") || "Workspace file change", 256 * 1024);
}

function safeMcpResult(value: JsonValue | undefined): string | undefined {
  if (!isJsonObject(value)) return value === undefined || value === null ? undefined : safeStructuredOutput(value);
  const parts: string[] = [];
  if (Array.isArray(value["content"])) parts.push(safeStructuredOutput(value["content"]));
  if (value["structuredContent"] !== undefined && value["structuredContent"] !== null) {
    parts.push(safeJson(value["structuredContent"], 256 * 1024));
  }
  const output = parts.filter((part) => part.length > 0).join("\n");
  return output.length === 0 ? undefined : safeText(output, 256 * 1024);
}

function safeStructuredOutput(value: JsonValue | undefined): string {
  if (typeof value === "string") return safeText(value, 256 * 1024);
  if (Array.isArray(value)) {
    const parts = value.flatMap((part) => {
      if (typeof part === "string") return [safeText(part, 256 * 1024)];
      if (!isJsonObject(part)) return [];
      if (typeof part["text"] === "string") return [safeText(part["text"], 256 * 1024)];
      const type = typeof part["type"] === "string" ? part["type"] : "structured";
      if (/image/i.test(type)) return ["[image output]"];
      if (/audio/i.test(type)) return ["[audio output]"];
      return [safeJson(part, 32 * 1024)];
    });
    return safeText(parts.join("\n") || "[structured output unavailable]", 256 * 1024);
  }
  return value === undefined ? "" : safeJson(value, 256 * 1024);
}

function userMessageBlocks(item: NativeThreadItem): readonly MessageBlock[] {
  if (!Array.isArray(item["content"])) {
    return [{ kind: "text", text: "[Codex user input unavailable]" }];
  }
  const blocks: MessageBlock[] = [];
  for (const content of item["content"]) {
    if (!isJsonObject(content)) continue;
    switch (content["type"]) {
      case "text":
        if (typeof content["text"] === "string") {
          blocks.push({ kind: "text", text: safeText(content["text"], 1024 * 1024) });
        }
        break;
      case "image":
      case "localImage":
        blocks.push({ kind: "text", text: "[Image input]" });
        break;
      case "audio":
      case "localAudio":
        blocks.push({ kind: "text", text: "[Audio input]" });
        break;
      case "skill":
        blocks.push({ kind: "text", text: `[Skill: ${safeTextValue(content["name"], "unnamed", 256)}]` });
        break;
      case "mention":
        blocks.push({ kind: "text", text: `[Mention: ${safeTextValue(content["name"], "unnamed", 256)}]` });
        break;
      default:
        blocks.push({ kind: "text", text: "[Unsupported Codex input]" });
    }
  }
  return blocks.length === 0 ? [{ kind: "text", text: "[Codex user input unavailable]" }] : blocks;
}

function nativeUserFingerprint(item: NativeThreadItem): string {
  return createHash("sha256").update(JSON.stringify({ role: "user", content: item["content"] ?? [] })).digest("hex");
}

function turnStatusProjection(turn: NativeTurn): ItemProjection {
  const details = turn.status === "completed"
    ? ["native_turn_completed", "Codex completed this turn."]
    : turn.status === "interrupted"
      ? ["native_turn_interrupted", "Codex interrupted this turn."]
      : turn.status === "failed"
        ? ["native_turn_failed", "Codex failed this turn."]
        : ["native_turn_in_progress", "Codex was still running this turn when history was read."];
  return statusProjection(details[0]!, details[1]!, "turn_status");
}

function statusProjection(key: string, text: string, kind = "item_status"): ItemProjection {
  return { kind, contentIndex: 0, payload: { type: "status", key, text } };
}

function terminalOutcome(status: NativeTurn["status"]): "completed" | "aborted" | "failed" | undefined {
  if (status === "completed") return "completed";
  if (status === "interrupted") return "aborted";
  if (status === "failed") return "failed";
  return undefined;
}

function activeEntryMetadata(activeEntryId: string | undefined): AdapterEventMetadata {
  return {
    namespace: "codex.native_history",
    fields: {
      nativeHydration: true,
      activeLeaf: true,
      ...(activeEntryId === undefined ? {} : { leafId: activeEntryId })
    }
  };
}

function assertHistoryIdentity(value: string): void {
  if (value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ProtocolShapeError("native history contains an invalid entry identity");
  }
  if (safeText(value, 512) !== value) throw new ProtocolShapeError("native history contains a sensitive entry identity");
}

function historyIdentifier(value: string): string {
  return safeIdentifier(safeText(value, 128));
}

function stringArray(value: JsonValue | undefined): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function safeTextValue(value: JsonValue | undefined, fallback: string, limit = 8_192): string {
  return typeof value === "string" && value.length > 0 ? safeText(value, limit) : fallback;
}

function safePathValue(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? safePath(value) : fallback;
}

function durationText(value: JsonValue | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? `${Math.trunc(value)} ms`
    : "Wait";
}

function webSearchOutput(item: NativeThreadItem): string {
  return item["results"] === null || item["results"] === undefined
    ? "Web search completed."
    : safeJson(item["results"], 256 * 1024);
}

function imageGenerationOutput(item: NativeThreadItem): string {
  const status = typeof item["status"] === "string" ? historyIdentifier(item["status"]) : "completed";
  return `Image generation ${status}.`;
}
