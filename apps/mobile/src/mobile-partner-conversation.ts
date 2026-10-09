import { MessageRole, type Event } from "@joko/contracts";
import type { MobilePartnerActivity, MobilePartnerDirectoryProfile } from "./mobile-partner-directory";

export interface MobilePartnerVisibleReply {
  readonly eventId: string;
  readonly messageId: string;
  readonly cursor: bigint;
}

export interface MobilePartnerConversationTransport {
  readonly ownerKey: string;
  readonly sessionId: string;
  resolve(signal: AbortSignal): Promise<MobilePartnerDirectoryProfile | undefined>;
  acknowledge(partner: MobilePartnerDirectoryProfile, reply: MobilePartnerVisibleReply,
    signal: AbortSignal, stillVisible: () => boolean): Promise<MobilePartnerActivity>;
}

/** Viewability supplies only message IDs; the completed public Event owns the read cursor. */
export function mobilePartnerVisibleReply(events: readonly Event[], sessionId: string, generation: bigint,
  visibleMessageIds: ReadonlySet<string>): MobilePartnerVisibleReply | undefined {
  let latest: MobilePartnerVisibleReply | undefined;
  for (const event of events) {
    const payload = event.payload?.kind;
    const cursor = event.cursor;
    if (payload?.case !== "messageCompleted" || payload.value.role !== MessageRole.ASSISTANT
      || payload.value.partnerPrivateOrigin !== undefined || event.identity?.sessionId !== sessionId
      || cursor?.generation !== generation || cursor.sequence < 1n
      || !visibleMessageIds.has(payload.value.messageId)) continue;
    if (latest === undefined || cursor.sequence > latest.cursor) {
      latest = { eventId: event.eventId, messageId: payload.value.messageId, cursor: cursor.sequence };
    }
  }
  return latest;
}
