import { createHash } from "node:crypto";
import { redactSecrets } from "@joko/core";
import { NotFoundError, type MessagingConnectionRecord, type MessagingDeliveryRecord, type OperationalStore } from "@joko/store";

const DELAY_MS = 30 * 60_000;
const PREPARATION_SCOPE = "wechat-delayed-reply";
const RECEIPT_KEY = "wechat-delayed-reply-receipts";
const QUESTION_KEY = "wechat-original-question";

export interface WeChatDelayedReply {
  readonly sourceRequestId: string;
  readonly receivedAt: number;
  readonly question: string;
}

export function rememberWeChatQuestion(store: OperationalStore, requestId: string, text: string): void {
  const question = questionExcerpt(text);
  if (question) store.setSetting("service", requestId, QUESTION_KEY, question);
}

export function delayedWeChatReply(
  store: OperationalStore, connection: MessagingConnectionRecord, delivery: MessagingDeliveryRecord, now: number
): WeChatDelayedReply | undefined {
  if (connection.channel !== "wechat" || delivery.kind !== "text" && delivery.kind !== "file" || now - delivery.createdAt < DELAY_MS) return undefined;
  const regularRun = /^run:(.+):answer$/u.exec(delivery.dedupeKey)?.[1];
  const payload = delivery.payload;
  const origin = record(payload) && record(payload["partnerDeliveryOrigin"]) ? payload["partnerDeliveryOrigin"] : undefined;
  const queueItemId = delivery.dedupeKey.startsWith("partner-send:") && typeof origin?.["queueItemId"] === "string" ? origin["queueItemId"] : undefined;
  const queue = queueItemId === undefined ? undefined : readQueue(store, queueItemId);
  const runId = regularRun ?? queue?.runId;
  if (runId === undefined) return undefined;
  const source = store.findMessagingInboundRequestByRunId(runId);
  if (!source || source.connectionId !== connection.id || source.channelGeneration !== connection.generation
    || source.conversationId !== delivery.conversationId || queueItemId !== undefined && source.queueItemId !== queueItemId) return undefined;
  const original = source.queueItemId === undefined || source.protectedContent ? undefined
    : queue ?? readQueue(store, source.queueItemId);
  const question = original?.runId !== runId || original.operationId !== source.operationId ? ""
    : store.findSetting<string>("service", source.id, QUESTION_KEY)?.value
      ?? questionExcerpt(original.body.messagingOrigin?.userText ?? "");
  return { sourceRequestId: source.id, receivedAt: source.occurredAt > 0 ? source.occurredAt : source.receivedAt, question };
}

export function weChatDelayedNotice(
  delivery: MessagingDeliveryRecord, source: WeChatDelayedReply, contextToken: string, now: number
): { readonly id: string; readonly text: string } {
  const id = createHash("sha256").update(JSON.stringify([
    "wechat-delayed-reply", delivery.connectionId, delivery.channelGeneration, delivery.conversationId, source.sourceRequestId,
    delivery.dedupeKey, delivery.createdAt, contextToken, Math.floor(now / DELAY_MS)
  ])).digest("hex").slice(0, 32);
  const date = new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset" });
  const notice = `Delayed reply to your message from ${date.format(source.receivedAt)}. The reply was ready at ${date.format(delivery.createdAt)}.`;
  return { id, text: source.question ? `${notice}\nYour message was “${source.question}”` : notice };
}

export function beginWeChatNoticePreparation(store: OperationalStore, delivery: MessagingDeliveryRecord, claimToken: string): void {
  store.setSetting("service", PREPARATION_SCOPE, delivery.id, claimToken);
}

export function finishWeChatNoticePreparation(store: OperationalStore, deliveryId: string): void {
  store.deleteSetting("service", PREPARATION_SCOPE, deliveryId);
}

export function recoverWeChatNoticePreparations(store: OperationalStore, now: number): void {
  store.transaction(() => {
    for (const setting of store.listSettings("service", PREPARATION_SCOPE)) {
      const delivery = store.findMessagingDelivery(setting.key);
      if (typeof setting.value === "string" && delivery?.status === "dispatching" && delivery.claimToken === setting.value) {
        const failed = store.settleMessagingDelivery({ deliveryId: delivery.id, expectedRevision: delivery.revision, claimToken: setting.value,
          status: "failed", errorCode: "wechat_notice_interrupted", settledAt: now });
        const connection = store.findMessagingConnection(delivery.connectionId);
        if (connection?.enabled && connection.channel === "wechat" && connection.generation === failed.channelGeneration) {
          store.retryMessagingDelivery({ deliveryId: delivery.id, expectedRevision: failed.revision, expectedChannelGeneration: connection.generation,
            availableAt: now });
        }
      }
      finishWeChatNoticePreparation(store, setting.key);
    }
  });
}

export function hasWeChatNoticeReceipt(store: OperationalStore, conversationId: string, id: string): boolean {
  return noticeReceipts(store, conversationId).includes(id);
}

export function saveWeChatNoticeReceipt(store: OperationalStore, conversationId: string, id: string): void {
  store.setSetting("service", conversationId, RECEIPT_KEY, [...noticeReceipts(store, conversationId).filter(receipt => receipt !== id), id].slice(-128));
}

function noticeReceipts(store: OperationalStore, conversationId: string): readonly string[] {
  return store.findSetting<readonly string[]>("service", conversationId, RECEIPT_KEY)?.value ?? [];
}

function readQueue(store: OperationalStore, id: string) {
  try { return store.getQueueItem(id); } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}

function questionExcerpt(text: string): string {
  return Array.from(redactSecrets(text).replace(/\s+/gu, " ").trim()).slice(0, 120).join("");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
