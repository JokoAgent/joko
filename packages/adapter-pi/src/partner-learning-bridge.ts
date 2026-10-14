import type { PartnerLearningTurnHandle } from "@joko/core";

export const PARTNER_LEARNING_REQUEST_PREFIX = "joko:tool-turn/v1/";
export const PARTNER_LEARNING_REPLY_STATUS_KEY = "joko-reply-identity/v1";

/** Capture occurs synchronously in the transport callback, before the event
 * chain can switch to a follow-up's context or perform the bridge fetch. */
export function capturePartnerLearningExtensionRequest(
  event: Readonly<Record<string, unknown>>,
  turn: PartnerLearningTurnHandle | undefined,
  tools: readonly { readonly serverId: string; readonly name: string }[]
): { readonly id: string; readonly value: string } | { readonly id: string; readonly cancelled: true } | undefined {
  if (event["method"] !== "input" || typeof event["title"] !== "string"
    || !event["title"].startsWith(PARTNER_LEARNING_REQUEST_PREFIX)) return undefined;
  const id = typeof event["id"] === "string" ? event["id"] : "";
  if (id === "" || event["title"].length > 8_192) return { id, cancelled: true };
  try {
    const encoded = event["title"].slice(PARTNER_LEARNING_REQUEST_PREFIX.length);
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) return { id, cancelled: true };
    const request: unknown = JSON.parse(bytes.toString("utf8"));
    if (request === null || typeof request !== "object" || Array.isArray(request)) return { id, cancelled: true };
    const value = request as Record<string, unknown>;
    const requestId = value["requestId"], serverId = value["serverId"], toolName = value["toolName"];
    if (Object.keys(value).length !== 3 || typeof requestId !== "string" || requestId.length < 1 || requestId.length > 1_024
      || /[\u0000-\u001f\u007f]/u.test(requestId) || typeof serverId !== "string" || typeof toolName !== "string"
      || !tools.some((tool) => tool.serverId === serverId && tool.name === toolName)) return { id, cancelled: true };
    const authority = turn?.captureToolRequest({ requestId, serverId, toolName });
    return { id, value: authority?.proof ?? "untracked" };
  } catch { return { id, cancelled: true }; }
}

export function consumePartnerLearningNativeReply(
  event: Readonly<Record<string, unknown>>,
  turn: PartnerLearningTurnHandle | undefined
): boolean {
  if (event["method"] !== "setStatus" || event["statusKey"] !== PARTNER_LEARNING_REPLY_STATUS_KEY) return false;
  if (typeof event["statusText"] !== "string" || event["statusText"].length > 8_192) return true;
  try {
    const value: unknown = JSON.parse(event["statusText"]);
    if (value !== null && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === 1 && "entryId" in value && typeof value.entryId === "string") {
      turn?.observeNativeReply(value.entryId);
    }
  } catch { /* A missing exact persistence identity cannot authorize a reply. */ }
  return true;
}
