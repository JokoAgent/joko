import { ToolCallState, type ToolCall } from "@joko/contracts";

import type { PartnerPrivateSentView } from "./model.js";

const PRIVATE_TOOLS = new Set([
  "mcp__joko_partners__send_private_message",
  "mcp__joko_28e1bfbb33986d6789e0c720__send_private_message"
]);
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MESSAGE_ID = /^partner-private-message:[a-f0-9]{64}$/u;

/** A locator from the built-in tool result. The thread RPC owns the message itself. */
export function partnerPrivateSentReceipt(call: ToolCall, sessionId: string): PartnerPrivateSentView | undefined {
  const result = call.result;
  if (!PRIVATE_TOOLS.has(call.toolId) || call.toolProviderId !== "" || call.sessionId !== sessionId
    || call.state !== ToolCallState.SUCCEEDED || result === undefined || result.truncated
    || result.completeOutput !== undefined || result.parts.length !== 1) return undefined;
  const content = result.parts[0]?.content;
  if (content?.case !== "text" || content.value.length > 4_096) return undefined;

  let receipt: Record<string, unknown> | undefined;
  try { receipt = record(JSON.parse(content.value)); } catch { return undefined; }
  if (receipt === undefined || Object.keys(receipt).sort().join(",")
    !== "conversation_ended,delivery_status,message_id,remaining_messages,target_partner,thread_id") return undefined;
  const target = record(receipt?.["target_partner"]);
  const messageId = receipt?.["message_id"];
  const threadId = receipt?.["thread_id"];
  const recipientPartnerId = target?.["id"];
  const recipientDisplayName = target?.["display_name"];
  const remaining = receipt?.["remaining_messages"];
  if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId)
    || typeof threadId !== "string" || !ENTITY_ID.test(threadId)
    || typeof recipientPartnerId !== "string" || !ENTITY_ID.test(recipientPartnerId)
    || typeof recipientDisplayName !== "string" || !recipientDisplayName.trim() || recipientDisplayName.length > 200
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(recipientDisplayName)
    || receipt["delivery_status"] !== "delivered" || typeof receipt["conversation_ended"] !== "boolean"
    || typeof remaining !== "number" || !Number.isInteger(remaining) || remaining < 0 || remaining > 12) return undefined;
  return { messageId, threadId, recipientPartnerId, recipientDisplayName: recipientDisplayName.replace(/\s+/gu, " ").trim() };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
