import {
  redactSecrets,
  type AdapterEventMetadata,
  type EventPayload,
  type MessageBlock,
  type NativeHistoryProjection,
  type PiEventMetadata,
  type ToolResultContentPart
} from "@joko/core";
import { createHash } from "node:crypto";
import { projectMessageGenerationTiming, projectMessageUsage } from "./message-usage.js";

/** Raw Pi JSONL is private to this package. */
export interface PiNativeHistoryEntry {
  readonly id: string;
  readonly parentId?: string;
  readonly type: string;
  readonly timestamp?: number;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface PiNativeSessionHistory {
  readonly entries: readonly PiNativeHistoryEntry[];
  readonly leafId?: string;
}

/** Translate Pi's native taxonomy before it crosses the Adapter boundary. */
export function projectPiNativeHistory(
  nativeSessionId: string | undefined,
  history: PiNativeSessionHistory
): NativeHistoryProjection {
  const entries = activeHistoryEntries(history.entries, history.leafId);
  let lastEmittedAt: number | undefined;
  const events = entries.flatMap((entry) => {
    const fields: Record<string, string | number | boolean> = {
      nativeHydration: true,
      entryId: entry.id,
      nativeEntryType: entry.type
    };
    if (entry.parentId !== undefined) fields["parentEntryId"] = entry.parentId;
    return projectEntries(entry).map((projection, order) => {
      if (projection.payload.type === "message_complete" && projection.payload.role === "user") {
        const message = record(entry.data["message"]);
        if (message !== undefined) {
          fields["nativeDispatchFingerprint"] = nativeDispatchFingerprintForUserMessage(message);
        }
      }
      if (projection.payload.type === "message_complete" && projection.payload.role === "assistant") {
        const message = record(entry.data["message"]);
        const stopReason = safeText(message?.["stopReason"]);
        if (stopReason === "stop") fields["nativeTerminalOutcome"] = "completed";
        else if (stopReason === "aborted") fields["nativeTerminalOutcome"] = "aborted";
        else if (stopReason === "error") fields["nativeTerminalOutcome"] = "failed";
      }
      const emittedAt = entry.timestamp === undefined
        ? undefined
        : Math.max(entry.timestamp + order, (lastEmittedAt ?? Number.NEGATIVE_INFINITY) + 1);
      if (emittedAt !== undefined) lastEmittedAt = emittedAt;
      return {
        nativeEntryId: entry.id,
        ...(entry.parentId === undefined ? {} : { nativeParentEntryId: entry.parentId }),
        projectionKind: projection.kind,
        contentIndex: projection.contentIndex,
        ...(emittedAt === undefined ? {} : { emittedAt }),
        payload: nativeProjectionPayload(projection.payload, projection.contentIndex),
        metadata: {
          namespace: "pi.native_history",
          fields,
          pi: nativeHistoryPiMetadata(entry, projection.payload, projection.contentIndex)
        }
      };
    });
  });
  return {
    events,
    ...(history.leafId === undefined ? {} : { activeEntryId: history.leafId }),
    activeLineage: entries.map((entry) => ({
      entryId: entry.id,
      ...(entry.parentId === undefined ? {} : { parentEntryId: entry.parentId })
    })),
    activeEntryMetadata: activePiEntryMetadata(nativeSessionId, history.leafId)
  };
}

export function nativeDispatchFingerprintForUserMessage(message: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify({
    role: "user",
    content: message["content"]
  })).digest("hex");
}

function nativeProjectionPayload(payload: EventPayload, contentIndex: number): EventPayload {
  if (payload.type === "text_delta" || payload.type === "thinking_delta") {
    return { ...payload, contentIndex };
  }
  return payload;
}

function activeHistoryEntries(
  entries: readonly PiNativeHistoryEntry[],
  leafId: string | undefined
): readonly PiNativeHistoryEntry[] {
  const byId = new Map<string, PiNativeHistoryEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new Error(`Native history contains duplicate entry ID '${entry.id}'.`);
    byId.set(entry.id, entry);
  }
  if (leafId === undefined) return entries;
  const leaf = byId.get(leafId);
  if (leaf === undefined) throw new Error(`Native history active leaf '${leafId}' was not returned by Pi.`);

  const reversed: PiNativeHistoryEntry[] = [];
  const seen = new Set<string>();
  let current: PiNativeHistoryEntry | undefined = leaf;
  while (current !== undefined) {
    if (seen.has(current.id)) throw new Error(`Native history contains a parent cycle at entry '${current.id}'.`);
    seen.add(current.id);
    reversed.push(current);
    current = current.parentId === undefined ? undefined : byId.get(current.parentId);
  }
  return reversed.reverse();
}

function activePiEntryMetadata(
  nativeSessionId: string | undefined,
  activeEntryId: string | undefined
): AdapterEventMetadata {
  const fields: Record<string, string | number | boolean> = {
    nativeHydration: true,
    activeLeaf: true
  };
  if (activeEntryId !== undefined) fields["leafId"] = activeEntryId;
  return {
    namespace: "pi.native_history",
    fields,
    pi: {
      rpcEventType: "session_identity_update",
      ...(activeEntryId === undefined ? {} : { leafId: activeEntryId }),
      payload: {
        case: "sessionIdentityUpdate",
        value: {
          previousNativeSessionId: "",
          nativeSessionId: nativeSessionId ?? "",
          nativeSessionName: "",
          nativeSessionFileDisplay: "",
          activeLeafId: activeEntryId ?? "",
          change: "branch_navigated"
        }
      }
    }
  };
}

function nativeHistoryPiMetadata(
  entry: PiNativeHistoryEntry,
  payload: EventPayload,
  contentIndex: number
): PiEventMetadata {
  const common = {
    entryId: entry.id,
    ...(entry.parentId === undefined ? {} : { parentEntryId: entry.parentId })
  };
  const message = entry.type === "message" ? record(entry.data["message"]) : undefined;
  if (message?.["role"] === "bashExecution") {
    return {
      ...common,
      rpcEventType: payload.type === "tool_start" ? "bash_execution_start" : "bash_execution_end",
      nativeToolName: "user_shell",
      payload: {
        case: "bashUpdate",
        value: {
          nativeBashId: nativeBashCallId(entry.id),
          commandDisplay: safeText(message["command"]) ?? "",
          stdoutDelta: "",
          stderrDelta: "",
          completed: payload.type === "tool_result",
          exitCode: safeExitCode(message["exitCode"]),
          excludedFromContext: message["excludeFromContext"] === true
        }
      }
    };
  }
  if (entry.type === "message" && (payload.type === "text_delta" || payload.type === "thinking_delta")) {
    return {
      ...common,
      rpcEventType: "message_update",
      contentIndex,
      payload: {
        case: "messageLifecycle",
        value: {
          kind: "message_update",
          nativeMessageId: entry.id,
          nativeEntryId: entry.id,
          parentEntryId: entry.parentId ?? "",
          role: "assistant",
          contentIndex
        }
      }
    };
  }
  if (entry.type === "message" && payload.type === "tool_start") {
    return {
      ...common,
      rpcEventType: "tool_execution_start",
      contentIndex,
      nativeToolName: payload.name,
      payload: {
        case: "toolLifecycle",
        value: {
          nativeToolCallId: payload.callId,
          toolName: payload.name,
          builtInKind: builtInToolKind(payload.name),
          phase: "start",
          contentIndex
        }
      }
    };
  }
  switch (entry.type) {
    case "message":
    case "custom_message": {
      const role = payload.type === "message_complete"
        ? payload.role
        : payload.type === "tool_result"
          ? "toolResult"
          : "unknown";
      return {
        ...common,
        rpcEventType: "message_end",
        contentIndex,
        payload: {
          case: "messageLifecycle",
          value: {
            kind: "message_end",
            nativeMessageId: entry.id,
            nativeEntryId: entry.id,
            parentEntryId: entry.parentId ?? "",
            role,
            contentIndex
          }
        }
      };
    }
    case "compaction":
    case "branch_summary":
      return {
        ...common,
        rpcEventType: "compaction_update",
        payload: {
          case: "compactionUpdate",
          value: {
            compactionId: entry.id,
            // Pi's persisted CompactionEntry does not retain whether the live
            // trigger was manual, threshold, or overflow.
            trigger: entry.type === "branch_summary" ? "branch" : "unknown",
            reason: entry.type === "branch_summary" ? "native_branch_summary" : "native_history",
            state: "completed",
            boundaryEntryId: entry.type === "compaction"
              ? safeText(entry.data["firstKeptEntryId"]) ?? ""
              : safeText(entry.data["fromId"]) ?? "",
            tokensBefore: entry.type === "compaction" ? safeUnsigned(entry.data["tokensBefore"]) : 0,
            tokensAfter: 0,
            summaryPreview: payload.type === "compaction" ? payload.summary ?? "" : ""
          }
        }
      };
    case "model_change": {
      const providerId = safeText(entry.data["provider"]) ?? "";
      const modelId = safeText(entry.data["modelId"]) ?? "";
      return {
        ...common,
        rpcEventType: "model_update",
        payload: {
          case: "modelUpdate",
          value: {
            ...(providerId === "" && modelId === "" ? {} : { model: { providerId, modelId } }),
            thinkingLevel: "",
            scopedModel: false,
            contextWindowTokens: 0
          }
        }
      };
    }
    case "thinking_level_change":
      return {
        ...common,
        rpcEventType: "model_update",
        payload: {
          case: "modelUpdate",
          value: {
            thinkingLevel: safeText(entry.data["thinkingLevel"]) ?? "",
            scopedModel: false,
            contextWindowTokens: 0
          }
        }
      };
    default: {
      const nativeEventType = redactSecrets(`native_history.${safeText(entry.type) ?? "unknown"}`).slice(0, 128);
      return {
        ...common,
        rpcEventType: nativeEventType,
        payload: {
          case: "diagnostic",
          value: { command: "unknown", nativeEventType }
        }
      };
    }
  }
}

interface PiNativeEntryProjection {
  readonly kind: string;
  readonly contentIndex: number;
  readonly payload: EventPayload;
}

function projectEntries(entry: PiNativeHistoryEntry): readonly PiNativeEntryProjection[] {
  // Pi's CustomMessageEntry.display flag is the authoritative visibility
  // boundary for graphical history just as it is for the native TUI. Treat a
  // missing value conservatively: malformed extension state must not
  // become a user-authored Timeline message on reconnect.
  if (entry.type === "custom_message" && entry.data["display"] !== true) return [];

  const message = entry.type === "message" ? record(entry.data["message"]) : undefined;
  if (message?.["role"] === "assistant") return projectAssistantEntry(entry, message);
  if (message?.["role"] !== "bashExecution") return [projectEntry(entry)];

  const callId = nativeBashCallId(entry.id);
  const command = safeText(message["command"]) ?? "";
  const output = safeText(message["output"]) ?? "";
  const exitCode = typeof message["exitCode"] === "number" && Number.isSafeInteger(message["exitCode"])
    ? message["exitCode"]
    : undefined;
  const cancelled = message["cancelled"] === true;
  const truncated = message["truncated"] === true;
  const artifact = blobRef(message["fullOutputArtifact"]);
  const completion = [
    output,
    ...(cancelled ? ["[command cancelled]"] : exitCode !== undefined && exitCode !== 0 ? [`[command exited with code ${exitCode}]`] : []),
    ...(artifact === undefined
      ? truncated ? ["[full output artifact unavailable]"] : []
      : ["[full output stored as artifact]"])
  ].filter((part) => part !== "").join("\n");
  return [
    {
      kind: "bash_start",
      contentIndex: 0,
      payload: { type: "tool_start", callId, name: "Shell", input: command }
    },
    {
      kind: "bash_result",
      contentIndex: 1,
      payload: {
        type: "tool_result",
        callId,
        name: "Shell",
        output: completion,
        isError: cancelled || (exitCode !== undefined && exitCode !== 0),
        ...(artifact === undefined ? {} : { artifact })
      }
    }
  ];
}

function projectAssistantEntry(
  entry: PiNativeHistoryEntry,
  message: Readonly<Record<string, unknown>>
): readonly PiNativeEntryProjection[] {
  const blocks = messageBlocks(message["content"], entry.id);
  const usage = projectMessageUsage(message["usage"]);
  const generationTiming = usage === undefined
    ? undefined
    : projectMessageGenerationTiming(message["duration"]);
  const projections: PiNativeEntryProjection[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block?.kind === "text" && block.text !== "") {
      projections.push({
        kind: "message_assistant_text",
        contentIndex: index,
        payload: { type: "text_delta", blockId: entry.id, delta: block.text }
      });
    } else if (block?.kind === "thinking" && !block.redacted && block.text !== "") {
      projections.push({
        kind: "message_assistant_thinking",
        contentIndex: index,
        payload: { type: "thinking_delta", blockId: entry.id, delta: block.text }
      });
    } else if (block?.kind === "tool_call") {
      projections.push({
        kind: "message_assistant_tool_call",
        contentIndex: index,
        payload: { type: "tool_start", callId: block.callId, name: block.name, input: block.input }
      });
    }
  }
  projections.push({
    kind: "message_assistant",
    contentIndex: blocks.length,
    payload: {
      type: "message_complete",
      role: "assistant",
      blocks,
      ...(usage === undefined ? {} : { usage, ...generationTiming })
    }
  });
  return projections;
}

function projectEntry(entry: PiNativeHistoryEntry): PiNativeEntryProjection {
  switch (entry.type) {
    case "message":
      return projectMessageEntry(entry);
    case "custom_message":
      return {
        kind: "custom_message",
        contentIndex: 0,
        payload: {
          type: "message_complete",
          role: "user",
          blocks: messageBlocks(entry.data["content"], entry.id)
        }
      };
    case "compaction":
      return {
        kind: "compaction",
        contentIndex: 0,
        payload: {
          type: "compaction",
          reason: "native_history",
          summary: safeText(entry.data["summary"]),
          compactionId: entry.id,
          state: "completed",
          boundaryEntryId: safeText(entry.data["firstKeptEntryId"]),
          tokensBefore: safeUnsigned(entry.data["tokensBefore"])
        }
      };
    case "branch_summary":
      return {
        kind: "branch_summary",
        contentIndex: 0,
        payload: {
          type: "compaction",
          reason: "native_branch_summary",
          summary: safeText(entry.data["summary"]),
          compactionId: entry.id,
          state: "completed",
          boundaryEntryId: safeText(entry.data["fromId"]),
          automatic: false
        }
      };
    case "model_change": {
      const provider = safeText(entry.data["provider"]);
      const model = safeText(entry.data["modelId"]);
      return {
        kind: "model_change",
        contentIndex: 0,
        payload: { type: "status", key: "pi.history.model", text: [provider, model].filter(Boolean).join("/") || undefined }
      };
    }
    case "thinking_level_change":
      return {
        kind: "thinking_level_change",
        contentIndex: 0,
        payload: { type: "status", key: "pi.history.thinking_level", text: safeText(entry.data["thinkingLevel"]) }
      };
    case "active_tools_change": {
      const names = Array.isArray(entry.data["activeToolNames"])
        ? entry.data["activeToolNames"].filter((value): value is string => typeof value === "string").map(safeText).filter(Boolean)
        : [];
      return {
        kind: "active_tools_change",
        contentIndex: 0,
        payload: { type: "status", key: "pi.history.active_tools", text: names.join(", ") || undefined }
      };
    }
    case "custom":
      return {
        kind: "custom",
        contentIndex: 0,
        payload: {
          type: "status",
          key: `pi.history.custom.${statusKey(entry.data["customType"])}`,
          text: "Native custom entry preserved"
        }
      };
    default:
      return {
        kind: "unknown",
        contentIndex: 0,
        payload: {
          type: "status",
          key: `pi.history.unknown.${statusKey(entry.type)}`,
          text: `Native Pi entry '${safeText(entry.type)}' preserved`
        }
      };
  }
}

function projectMessageEntry(entry: PiNativeHistoryEntry): PiNativeEntryProjection {
  const message = record(entry.data["message"]) ?? {};
  const role = message["role"];
  if (role === "user" || role === "assistant") {
    const usage = role === "assistant" ? projectMessageUsage(message["usage"]) : undefined;
    const generationTiming = usage === undefined
      ? undefined
      : projectMessageGenerationTiming(message["duration"]);
    return {
      kind: `message_${role}`,
      contentIndex: 0,
      payload: {
        type: "message_complete",
        role,
        blocks: messageBlocks(message["content"], entry.id),
        ...(usage === undefined ? {} : { usage, ...generationTiming })
      }
    };
  }
  if (role === "toolResult") {
    const toolName = safeText(message["toolName"]);
    if (toolName === undefined) throw new Error("Native tool-result history is missing its display name.");
    const parts = toolResultParts(message["content"]);
    const artifact = blobRef(message["fullOutputArtifact"]);
    const output = parts.filter((part) => part.kind === "text").map((part) => part.text).join("\n");
    const completionMarker = artifact !== undefined
      ? "[full output stored as artifact]"
      : message["fullOutputUnavailable"] === true
        ? "[full output artifact unavailable]"
        : "";
    return {
      kind: "tool_result",
      contentIndex: 0,
      payload: {
        type: "tool_result",
        callId: safeText(message["toolCallId"]) ?? `native-${entry.id}`,
        name: toolName,
        output: `${output}${output === "" || completionMarker === "" ? "" : "\n"}${completionMarker}`,
        parts,
        isError: message["isError"] === true,
        ...(artifact === undefined ? {} : { artifact })
      }
    };
  }
  return {
    kind: "message_unknown",
    contentIndex: 0,
    payload: {
      type: "status",
      key: `pi.history.message.${statusKey(role)}`,
      text: "Native message entry with an unsupported role preserved"
    }
  };
}

function messageBlocks(content: unknown, entryId: string): readonly MessageBlock[] {
  if (typeof content === "string") return [{ kind: "text", text: boundedText(content) }];
  if (!Array.isArray(content)) return [];
  const blocks: MessageBlock[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const item = record(content[index]);
    if (item === undefined) continue;
    if (item["type"] === "text" && typeof item["text"] === "string") {
      blocks.push({ kind: "text", text: boundedText(item["text"]) });
    } else if (item["type"] === "thinking" && typeof item["thinking"] === "string") {
      blocks.push({ kind: "thinking", text: boundedText(item["thinking"]), redacted: item["redacted"] === true });
    } else if (item["type"] === "toolCall") {
      const name = safeText(item["name"]) ?? "unknown";
      blocks.push({
        kind: "tool_call",
        callId: safeText(item["id"]) ?? `native-${entryId}-${index}`,
        name,
        input: isPrivateVisionToolName(name)
          ? "[vision image path and focus withheld]"
          : safeJson(item["arguments"])
      });
    } else if (item["type"] === "image") {
      const blob = blobRef(item["blob"]);
      if (blob !== undefined) {
        const alt = safeText(item["alt"]);
        blocks.push({ kind: "image", blob, ...(alt === undefined ? {} : { alt }) });
      }
    }
  }
  return blocks;
}

function toolResultParts(value: unknown): readonly ToolResultContentPart[] {
  if (typeof value === "string") return [{ kind: "text", text: boundedText(value) }];
  if (!Array.isArray(value)) return [];
  const parts: ToolResultContentPart[] = [];
  for (const valuePart of value) {
    const candidate = record(valuePart);
    if (candidate?.["type"] === "text" && typeof candidate["text"] === "string") {
      parts.push({ kind: "text", text: boundedText(candidate["text"]) });
    } else if (candidate?.["type"] === "image") {
      const blob = blobRef(candidate["blob"]);
      if (blob !== undefined) {
        const alt = safeText(candidate["alt"]);
        parts.push({ kind: "image", blob, ...(alt === undefined ? {} : { alt }) });
      }
    }
  }
  return parts;
}

function safeJson(value: unknown): string {
  try {
    return boundedText(JSON.stringify(value ?? {}));
  } catch {
    return "[unserializable native tool input]";
  }
}

function isPrivateVisionToolName(toolName: string): boolean {
  return toolName === "vision" || toolName === "vision-locate" ||
    toolName === "mcp__joko-vision-bridge__vision" ||
    toolName === "mcp__joko-vision-bridge__vision-locate";
}

function safeText(value: unknown): string | undefined {
  return typeof value === "string" ? boundedText(value) : undefined;
}

function safeUnsigned(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeExitCode(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function nativeBashCallId(entryId: string): string {
  return `native-bash-${entryId}`;
}

function builtInToolKind(toolName: string): "unknown" | "read" | "write" | "edit" | "bash" | "custom" | "mcp_bridge" {
  const normalized = toolName.toLocaleLowerCase();
  if (normalized === "read" || normalized === "write" || normalized === "edit" || normalized === "bash") return normalized;
  if (normalized.includes("mcp")) return "mcp_bridge";
  return normalized === "" || normalized === "unknown" ? "unknown" : "custom";
}

function boundedText(value: string): string {
  return redactSecrets(value);
}

function statusKey(value: unknown): string {
  const normalized = typeof value === "string" ? value : "unknown";
  return normalized.toLocaleLowerCase().replace(/[^a-z0-9_.-]+/gu, "_").slice(0, 128) || "unknown";
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function blobRef(value: unknown): import("@joko/core").BlobRef | undefined {
  const candidate = record(value);
  if (
    candidate === undefined ||
    typeof candidate["id"] !== "string" || candidate["id"] === "" ||
    typeof candidate["sha256"] !== "string" || candidate["sha256"] === "" ||
    typeof candidate["byteLength"] !== "number" || !Number.isSafeInteger(candidate["byteLength"]) || candidate["byteLength"] < 0 ||
    typeof candidate["mimeType"] !== "string" || candidate["mimeType"] === "" ||
    (candidate["fileName"] !== undefined && typeof candidate["fileName"] !== "string")
  ) return undefined;
  return {
    id: candidate["id"],
    sha256: candidate["sha256"],
    byteLength: candidate["byteLength"],
    mimeType: candidate["mimeType"],
    ...(candidate["fileName"] === undefined ? {} : { fileName: candidate["fileName"] as string })
  };
}
