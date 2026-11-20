import { createHash } from "node:crypto";
import { NATIVE_HISTORY_LEGACY_REWIND_ANCHORS_FIELD, NATIVE_HISTORY_USER_IMAGES_FIELD } from "@joko/core";
import type {
  AdapterContext,
  AdapterEventMetadata,
  BlobRef,
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
import { mcpToolCallErrorMessage, mcpToolCallFailed, safeIdentifier, safeJson, safePath, safeText, toolIdentity } from "./translator.js";
import { CODEX_FILE_CHANGE_FALLBACK, projectCodexFileChanges } from "./file-change.js";
import { codexRejectedTurnKind, isRejectedTurnRetryClientId, nextRejectedTurnRetryClientId } from "./rejected-turn-retry.js";
import {
  extractAliveYieldCellsFromCodexItem,
  extractSettledYieldCellIdsFromCodexItem,
  extractYieldedExecCellsFromCodexItem,
  isYieldContinuationClientId
} from "./yielded-exec-cell.js";

export interface CodexNativeHistoryProjectionOptions {
  readonly maximumEvents: number;
  readonly legacyDialogueRewind?: boolean;
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
  const intermediateYieldTurnIds = intermediateYieldTurns(thread);
  let parentEntryId: string | undefined;

  for (const [turnIndex, turn] of thread.turns.entries()) {
    assertHistoryIdentity(turn.id);
    const previousInput = turn.items[0];
    const nextInput = thread.turns[turnIndex + 1]?.items[0];
    const retried = turn.status === "failed" && codexRejectedTurnKind(turn.error) !== undefined
      && turn.items.every(item => item.type === "userMessage") && previousInput?.type === "userMessage" && nextInput?.type === "userMessage"
      && nextRejectedTurnRetryClientId(previousInput["clientId"], nextInput["clientId"]);
    const intermediate = intermediateYieldTurnIds.has(turn.id) || retried;
    if (turn.items.length === 0) {
      appendLineage(turn.id);
      appendEvents(
        turn.id,
        parentEntryId,
        turn,
        "turn",
        intermediate ? [] : [turnStatusProjection(turn)]
      );
      parentEntryId = turn.id;
      continue;
    }
    for (const [index, item] of turn.items.entries()) {
      assertHistoryIdentity(item.id);
      appendLineage(item.id);
      const projections = [...projectItem(item, turn, !intermediate)];
      if (index === turn.items.length - 1 && !intermediate) {
        projections.push(turnStatusProjection(turn));
      }
      appendEvents(item.id, parentEntryId, turn, item.type, projections);
      parentEntryId = item.id;
    }
  }

  return {
    events,
    ...(parentEntryId === undefined ? {} : { activeEntryId: parentEntryId }),
    ...(thread.historyMode !== "paginated" ? {} : { activeNavigationTarget: parentEntryId === undefined
      ? { kind: "session_start" as const } : { kind: "native_entry" as const, entryId: parentEntryId } }),
    activeLineage,
    activeEntryMetadata: activeEntryMetadata(thread, parentEntryId, options.legacyDialogueRewind === true)
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
        ...(thread.historyMode !== "paginated" || itemType !== "userMessage" || turn.items[0]?.id !== entryId ? {} : {
          nativeRewindBefore: turn === thread.turns[0]
            ? { kind: "session_start" as const }
            : { kind: "native_entry" as const, entryId: parentId! }
        }),
        projectionKind: projection.kind,
        contentIndex: projection.contentIndex,
        payload: projection.payload,
        metadata: { namespace: "codex.native_history", fields },
        observedMetadataFields: ["turnStatus"]
      });
    }
  }
}

/** Restore only inline bytes from the same complete, bound App Server read. */
export async function materializeCodexHistoryImages(thread: NativeThread, projection: NativeHistoryProjection,
  context: Pick<AdapterContext, "target" | "runtimePolicy" | "persistentReadOnly" | "artifactCapacityBytes" | "materializeNativeHistoryImage">,
  assertCurrent: () => void): Promise<NativeHistoryProjection> {
  const materialize = context.materializeNativeHistoryImage;
  if (thread.historyMode !== "paginated" || thread.ephemeral === true || context.target.remoteWorkspace !== undefined
    || context.runtimePolicy !== undefined || context.persistentReadOnly !== undefined || materialize === undefined) return projection;
  const references: [string, number, BlobRef][] = [];
  for (const turn of thread.turns) {
    if (turn.status !== "completed") continue;
    for (const item of turn.items) {
      if (item.type !== "userMessage" || isYieldContinuationClientId(item["clientId"])) continue;
      const sources: [number, string][] = [];
      userMessageBlocks(item, (blockIndex, url) => {
        if (typeof url === "string" && url.startsWith(INLINE_PNG_PREFIX)) sources.push([blockIndex, url]);
      });
      if (sources.length === 0) continue;
      const inputFingerprint = nativeUserFingerprint(item);
      for (const [blockIndex, url] of sources) {
        const png = inlineCodexPng(url, context.artifactCapacityBytes);
        if (png === undefined) continue;
        assertCurrent();
        const blob = await materialize({ nativeEntryId: item.id, inputFingerprint, blockIndex, png, assertCurrent });
        assertCurrent();
        if (blob !== undefined) references.push([item.id, blockIndex, blob]);
      }
    }
  }
  if (references.length === 0 || projection.activeEntryMetadata === undefined) return projection;
  return { ...projection, activeEntryMetadata: { ...projection.activeEntryMetadata,
    fields: { ...projection.activeEntryMetadata.fields, [NATIVE_HISTORY_USER_IMAGES_FIELD]: JSON.stringify(references) }
  } };
}

const INLINE_PNG_PREFIX = "data:image/png;base64,";

function inlineCodexPng(url: string, maximumBytes: number): Buffer | undefined {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) return undefined;
  const encoded = url.slice(INLINE_PNG_PREFIX.length);
  if (encoded.length > Math.ceil(maximumBytes / 3) * 4) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 33 || bytes.length > maximumBytes || bytes.toString("base64") !== encoded
    || bytes.readBigUInt64BE(0) !== 0x89504e470d0a1a0an || bytes.readUInt32BE(8) !== 13
    || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(16) === 0 || bytes.readUInt32BE(20) === 0) return undefined;
  return bytes;
}

function projectItem(
  item: NativeThreadItem,
  turn: NativeTurn,
  terminalOutcomeAllowed: boolean
): readonly ItemProjection[] {
  switch (item.type) {
    case "userMessage": {
      if (isYieldContinuationClientId(item["clientId"]) || isRejectedTurnRetryClientId(item["clientId"])) return [];
      const blocks = userMessageBlocks(item);
      return [{
        kind: "message_user",
        contentIndex: 0,
        payload: { type: "message_complete", role: "user", blocks },
        fields: { nativeDispatchFingerprint: nativeUserFingerprint(item) }
      }];
    }
    case "agentMessage":
      return [assistantProjection(item, turn, "message_assistant", terminalOutcomeAllowed)];
    case "plan":
      return [assistantProjection(item, turn, "message_plan", terminalOutcomeAllowed)];
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

function assistantProjection(
  item: NativeThreadItem,
  turn: NativeTurn,
  kind: string,
  terminalOutcomeAllowed: boolean
): ItemProjection {
  const text = safeTextValue(item["text"], "[Codex assistant message unavailable]", 1024 * 1024);
  const outcome = terminalOutcomeAllowed ? terminalOutcome(turn.status) : undefined;
  return {
    kind,
    contentIndex: 0,
    payload: { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text }] },
    ...(outcome === undefined ? {} : { fields: { nativeTerminalOutcome: outcome } })
  };
}

function intermediateYieldTurns(thread: NativeThread): ReadonlySet<string> {
  const result = new Set<string>();
  const outstanding = new Map<string, { readonly cellId: string; readonly command?: string }>();
  for (const turn of thread.turns) {
    const hasPublicUserBoundary = turn.items.some((item) =>
      item.type === "userMessage" && !isYieldContinuationClientId(item["clientId"]));
    if (hasPublicUserBoundary && outstanding.size > 0) outstanding.clear();
    for (const item of turn.items) {
      for (const cell of [
        ...extractYieldedExecCellsFromCodexItem(item),
        ...extractAliveYieldCellsFromCodexItem(item)
      ]) outstanding.set(cell.cellId, cell);
      for (const cellId of extractSettledYieldCellIdsFromCodexItem(item)) outstanding.delete(cellId);
    }
    if (turn.status === "completed" && outstanding.size > 0) result.add(turn.id);
    if (turn.status === "failed" || turn.status === "interrupted") outstanding.clear();
  }
  return result;
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
  if (item.type === "fileChange") return toolIdentity(item) ?? { name: "file_change", input: fileChangeSummary(item) };
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
    case "mcpToolCall":
      return mcpToolCallErrorMessage(item) ?? safeMcpResult(item["result"]) ?? `MCP tool ${historyIdentifier(status)}.`;
    case "dynamicToolCall":
      return safeStructuredOutput(item["contentItems"]);
    case "collabAgentToolCall":
      return `Collaboration ${historyIdentifier(status)}.`;
    default:
      return `Tool ${historyIdentifier(status)}.`;
  }
}

function toolFailed(item: NativeThreadItem, status: string): boolean {
  if (item.type === "mcpToolCall") return mcpToolCallFailed(item, status);
  if (status === "failed" || status === "declined" || status === "interrupted") return true;
  if (item.type === "dynamicToolCall") return item["success"] === false;
  return false;
}

function fileChangeSummary(item: NativeThreadItem): string {
  const projected = projectCodexFileChanges(item["changes"], safeText);
  if (projected !== undefined) return projected.summary;
  return CODEX_FILE_CHANGE_FALLBACK;
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

function userMessageBlocks(item: NativeThreadItem, observeInlineImage?: (blockIndex: number, url: unknown) => void): readonly MessageBlock[] {
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
        observeInlineImage?.(blocks.length, content["url"]);
        blocks.push({ kind: "text", text: "[Image input]" });
        break;
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
  const content = item["content"] ?? [];
  if (!Array.isArray(content)) throw new ProtocolShapeError("native user input content must be an array");
  return codexNativeDispatchFingerprint(content);
}

/** The pinned native schema materializes these defaults when persisting input.
 * Object property order is not part of a native message's identity. */
export function codexNativeDispatchFingerprint(content: readonly JsonValue[]): string {
  const normalized = content.map(item => {
    if (!isJsonObject(item)) return item;
    if (item["type"] === "text") return { ...item, text_elements: item["text_elements"] === undefined ? [] : item["text_elements"] };
    if (item["type"] === "image" || item["type"] === "localImage") return { ...item, detail: item["detail"] === undefined ? null : item["detail"] };
    return item;
  });
  return createHash("sha256").update(JSON.stringify(canonicalNativeValue({ role: "user", content: normalized }))).digest("hex");
}
function canonicalNativeValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalNativeValue);
  if (isJsonObject(value)) return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => [key, canonicalNativeValue(entry)]));
  return value;
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

export function codexLegacyRewindAnchor(thread: NativeThread, nextTurnIndex: number): string | undefined {
  if (thread.historyMode !== "legacy" || thread.ephemeral === true || thread.status?.["type"] !== "idle" || nextTurnIndex < 1) return undefined;
  const previous = thread.turns[nextTurnIndex - 1];
  const next = thread.turns[nextTurnIndex];
  if (!previous || !next || !ordinaryCompletedTextTurn(previous) || !ordinaryCompletedTextTurn(next)) return undefined;
  // Legacy materialization labels turns synthesized from old rollouts with
  // rollout offsets. App Server requires a persisted TurnStarted anchor.
  if (/^rollout-\d+$/u.test(previous.id)) return undefined;
  return previous.items.at(-1)?.id;
}

function ordinaryCompletedTextTurn(turn: NativeTurn): boolean {
  const user = turn.items[0];
  return turn.status === "completed" && user?.type === "userMessage" && !isYieldContinuationClientId(user["clientId"])
    && turn.items.slice(1).every((item) => item.type !== "userMessage")
    && Array.isArray(user["content"]) && user["content"].length > 0
    && user["content"].every((input) => isJsonObject(input) && input["type"] === "text" && typeof input["text"] === "string");
}

function activeEntryMetadata(thread: NativeThread, activeEntryId: string | undefined, allowLegacyRewind: boolean): AdapterEventMetadata {
  const legacyAnchors = allowLegacyRewind && thread.historyMode === "legacy" ? thread.turns.flatMap((turn, index) => {
    const anchor = codexLegacyRewindAnchor(thread, index);
    return anchor === undefined ? [] : [[turn.items[0]!.id, anchor]];
  }) : [];
  return {
    namespace: "codex.native_history",
    fields: {
      nativeHydration: true,
      activeLeaf: true,
      ...(activeEntryId === undefined ? {} : { leafId: activeEntryId }),
      ...(legacyAnchors.length === 0 ? {} : { [NATIVE_HISTORY_LEGACY_REWIND_ANCHORS_FIELD]: JSON.stringify(legacyAnchors) })
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
