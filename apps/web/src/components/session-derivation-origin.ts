import type { AppRoute } from "../controller.js";
import type { SessionView } from "../model.js";

type SessionRoute = Extract<AppRoute, { readonly kind: "session" }>;
type DerivationOrigin = NonNullable<SessionView["derivationOrigin"]>;

/**
 * Resolves the only route a derivation marker may expose. The service-owned
 * availability facts remain authoritative, while the current Snapshot must
 * also contain the exact active source so a stale renderer cannot fabricate a
 * destination from the durable lineage identity alone.
 */
export function sessionDerivationOriginRoute(
  origin: DerivationOrigin | undefined,
  sessions: readonly SessionView[]
): SessionRoute | undefined {
  if (origin === undefined || !origin.sourceSessionAvailable) return undefined;
  const source = sessions.find((candidate) => candidate.id === origin.sourceSessionId);
  if (source === undefined || source.archived || source.state === "closed") return undefined;

  const hasMessageId = origin.sourceMessageId !== undefined;
  const hasEventId = origin.sourceEventId !== undefined;
  if (hasMessageId !== hasEventId) return undefined;
  if (hasMessageId && !origin.sourceMessageAvailable) return undefined;

  return {
    kind: "session",
    sessionId: origin.sourceSessionId,
    ...(hasMessageId && hasEventId
      ? {
          messageId: origin.sourceMessageId,
          messageEventId: origin.sourceEventId
        }
      : {})
  };
}
