import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { redactSecrets, type NativeSessionPreview } from "@joko/core";
import { readNativeTranscriptWindow } from "@joko/runtime-governance";
import { resolveCodexCatalogPreviewPath, validateCodexCatalogSource } from "./session-materialization.js";
import type { CodexCatalogSource } from "./session-catalog.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

type RolloutMessage = NativeSessionPreview["messages"][number];
const MAX_ROLLOUT_BYTES = 128 * 1024;

export async function readCodexCatalogRolloutMessages(
  source: CodexCatalogSource,
  threadId: string,
  workspaceRoot: string
): Promise<readonly RolloutMessage[] | undefined> {
  const fence = source.rollout;
  if (fence === undefined || fence.size > MAX_ROLLOUT_BYTES) return undefined;
  const path = await resolveCodexCatalogPreviewPath(source, threadId);
  const window = await readNativeTranscriptWindow(path);
  if (!window.whole || window.identity.size !== BigInt(fence.size)
    || window.identity.modifiedAtNanoseconds / 1_000_000n !== BigInt(fence.modifiedAt)
    || (fence.device !== 0 && window.identity.device !== BigInt(fence.device))
    || (fence.inode !== 0 && window.identity.inode !== BigInt(fence.inode))) return undefined;

  const records = window.head.map((line): unknown => JSON.parse(line));
  const first = records[0];
  if (!isJsonObject(first) || first["type"] !== "session_meta" || !isJsonObject(first["payload"])) return undefined;
  const metadata = first["payload"];
  const cwd = metadata["cwd"];
  if (metadata["id"] !== threadId || typeof cwd !== "string" || !isAbsolute(cwd)
    || relative(workspaceRoot, await realpath(cwd)) !== "" || metadata["history_base"] != null) return undefined;
  const mode = metadata["history_mode"];
  if (mode !== undefined && mode !== "legacy" && mode !== "paginated") return undefined;
  const messages = settledRolloutMessages(records.slice(1), threadId, mode === "paginated");
  await validateCodexCatalogSource(source, threadId);
  return messages;
}

function settledRolloutMessages(records: readonly unknown[], threadId: string, paginated: boolean): readonly RolloutMessage[] | undefined {
  const messages: RolloutMessage[] = [];
  const turnIds = new Set<string>();
  let turn: { readonly id: string; readonly entries: Map<string, RolloutMessage> } | undefined;
  for (const record of records) {
    if (!isJsonObject(record) || record["type"] === "compacted") return undefined;
    if (record["type"] !== "event_msg") continue;
    const event = record["payload"];
    if (!isJsonObject(event)) return undefined;
    const type = event["type"];
    if (type === "thread_rolled_back" || type === "turn_aborted") return undefined;
    if (type === "task_started" || type === "turn_started") {
      const id = event["turn_id"];
      if (turn !== undefined || typeof id !== "string" || id === "" || turnIds.has(id)) return undefined;
      turnIds.add(id);
      turn = { id, entries: new Map() };
      continue;
    }
    if (type === "task_complete" || type === "turn_complete") {
      if (turn === undefined || event["turn_id"] !== turn.id || event["error"] != null) return undefined;
      const entries = [...turn.entries.values()];
      if (entries[0]?.role !== "user" || entries.at(-1)?.role !== "assistant") return undefined;
      messages.push(...entries);
      turn = undefined;
      continue;
    }

    const item = paginated && type === "item_completed" && isJsonObject(event["item"]) ? event["item"] : undefined;
    const role = paginated
      ? item?.["type"] === "UserMessage" ? "user" : item?.["type"] === "AgentMessage" ? "assistant" : undefined
      : type === "user_message" ? "user" : type === "agent_message" ? "assistant" : undefined;
    if (role === undefined) continue;
    if (turn === undefined || item !== undefined && (event["turn_id"] !== turn.id || event["thread_id"] !== threadId)) return undefined;
    const id = item === undefined ? String(turn.entries.size) : item["id"];
    const text = item === undefined ? legacyText(event, role) : itemText(item, role);
    const at = typeof record["timestamp"] === "string" ? Date.parse(record["timestamp"]) : NaN;
    if (typeof id !== "string" || id === "" || text === undefined || text.trim() === "" || !Number.isSafeInteger(at) || at < 0) return undefined;
    turn.entries.set(id, { at, role, text: redactSecrets(text) });
  }
  return turn === undefined && messages.length > 0 ? messages : undefined;
}

function legacyText(event: JsonObject, role: RolloutMessage["role"]): string | undefined {
  if (role === "user" && [event["images"], event["local_images"], event["text_elements"]].some(value => Array.isArray(value) && value.length > 0)) {
    return undefined;
  }
  if (event["moderation"] != null || event["delivery"] != null || event["questions"] != null) return undefined;
  return typeof event["message"] === "string" ? event["message"] : undefined;
}

function itemText(item: JsonObject, role: RolloutMessage["role"]): string | undefined {
  if (!Array.isArray(item["content"]) || item["moderation"] != null || item["delivery"] != null || item["questions"] != null) return undefined;
  const parts: string[] = [];
  for (const part of item["content"]) {
    if (!isJsonObject(part) || part["type"] !== (role === "user" ? "text" : "Text") || typeof part["text"] !== "string"
      || (Array.isArray(part["text_elements"]) && part["text_elements"].length > 0)) return undefined;
    parts.push(part["text"]);
  }
  return parts.join("\n");
}
