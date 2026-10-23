import type { Event } from "@joko/contracts";
import type { MobileOfflineCache } from "./mobile-offline-cache";
import { mobilePartnerRosterSourceKey, type MobilePartnerRosterDisplay, type MobilePartnerRosterSource } from "./mobile-partner-roster";

export interface MobilePartnerOfflineConversation {
  readonly sourceKey: string;
  readonly partnerId: string;
  readonly displayName: string;
  readonly sessionId: string;
  readonly savedAt: number;
  readonly events: readonly Event[];
}

/** A cache hint opens only already saved content from the exact connection, never a live task. */
export async function readMobilePartnerOfflineConversation(cache: Pick<MobileOfflineCache, "load">,
  source: MobilePartnerRosterSource, row: MobilePartnerRosterDisplay, current: () => boolean,
  signal: AbortSignal): Promise<MobilePartnerOfflineConversation> {
  const requireCurrent = (): void => {
    signal.throwIfAborted();
    if (!current() || mobilePartnerRosterSourceKey(source.profile) !== source.key) throw new Error("The saved Partner source changed.");
  };
  requireCurrent();
  const hint = row.conversation;
  if (!hint) throw new Error("This Partner has no saved conversation. Reconnect to open it.");
  const cached = await cache.load(source.profile, hint.sessionId);
  requireCurrent();
  const detail = cached?.detail;
  if (!cached || !detail || detail.sessions.length !== 1 || detail.sessions[0]?.sessionId !== hint.sessionId
    || detail.sessions[0].targetId !== hint.targetId || detail.server?.serverId !== source.profile.serverId
    || detail.scope?.kind.case !== "session" || detail.scope.kind.value.sessionId !== hint.sessionId) {
    throw new Error("This Partner has no saved conversation on this device. Reconnect to load it.");
  }
  return { sourceKey: source.key, partnerId: row.partnerId, displayName: row.displayName,
    sessionId: hint.sessionId, savedAt: cached.detailCachedAt ?? cached.cachedAt, events: detail.timeline };
}
