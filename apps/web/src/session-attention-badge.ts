import type { SessionView } from "./model.js";

export const MAXIMUM_SESSION_ATTENTION_BADGE_KEYS = 512;

export interface SessionAttentionBadgeKey {
  readonly ownerId: string;
  readonly sessionId: string;
}

export interface SessionAttentionBadgeDelta {
  readonly next: ReadonlyMap<string, SessionAttentionBadgeKey>;
  readonly marks: readonly SessionAttentionBadgeKey[];
  readonly clears: readonly SessionAttentionBadgeKey[];
}

export function reconcileSessionAttentionBadgeProjection(
  previous: ReadonlyMap<string, SessionAttentionBadgeKey>,
  ownerId: string | undefined,
  sessions: readonly SessionView[]
): SessionAttentionBadgeDelta {
  const desired = new Map<string, SessionAttentionBadgeKey>();
  if (ownerId !== undefined) {
    for (const session of sessions) {
      if (session.attention?.unread !== true) continue;
      const key = Object.freeze({ ownerId, sessionId: session.id });
      desired.set(attentionBadgeKeyToken(key), key);
      if (desired.size >= MAXIMUM_SESSION_ATTENTION_BADGE_KEYS) break;
    }
  }

  const clears = [...previous]
    .filter(([token]) => !desired.has(token))
    .map(([, key]) => key);
  const marks = [...desired]
    .filter(([token]) => !previous.has(token))
    .map(([, key]) => key);
  return { next: desired, marks, clears };
}

function attentionBadgeKeyToken(key: SessionAttentionBadgeKey): string {
  return JSON.stringify([key.ownerId, key.sessionId]);
}
