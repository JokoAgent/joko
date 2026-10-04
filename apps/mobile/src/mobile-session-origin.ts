import { SessionDerivationKind, SessionState, type Session, type SessionDerivationOrigin } from "@joko/contracts";
import { mobileNativeIntentIdentityMaximumCharacters } from "./mobile-native-intent";

export interface MobileSessionOrigin {
  readonly kind: "fork" | "clone" | "derived";
  readonly originKey: string;
  readonly source?: { readonly sessionId: string; readonly messageId?: string; readonly eventId?: string };
  readonly canOpen: boolean;
}

export interface MobileSessionOriginControls extends MobileSessionOrigin {
  readonly authorityKey?: string;
}

/** Lineage is immutable display data. Only current service availability grants a navigation candidate. */
export function projectMobileSessionOrigin(session: Session, sessions: readonly Session[]): MobileSessionOrigin | undefined {
  const origin = session.derivationOrigin;
  if (!origin) return undefined;
  const kind = origin.kind === SessionDerivationKind.FORK ? "fork" : origin.kind === SessionDerivationKind.CLONE ? "clone" : "derived";
  const base = { kind, originKey: mobileSessionOriginKey(origin) } as const;
  const message = origin.sourceMessageId !== undefined;
  const event = origin.sourceEventId !== undefined;
  if (kind === "derived" || !validIdentity(origin.sourceSessionId) || origin.sourceSessionId === session.sessionId
    || message !== event || message && (!validIdentity(origin.sourceMessageId!) || !validIdentity(origin.sourceEventId!))) {
    return { ...base, canOpen: false };
  }
  const source = { sessionId: origin.sourceSessionId,
    ...(message ? { messageId: origin.sourceMessageId!, eventId: origin.sourceEventId! } : {}) };
  const matches = sessions.filter((candidate) => candidate.sessionId === source.sessionId);
  return { ...base, source, canOpen: origin.sourceSessionAvailable && (!message || origin.sourceMessageAvailable)
    && matches.length === 1 && mobileSessionOriginSourceAvailable(matches[0]!) };
}

export function mobileSessionOriginKey(origin: SessionDerivationOrigin | undefined): string {
  return origin ? JSON.stringify([origin.kind, origin.sourceSessionId, origin.sourceMessageId ?? null, origin.sourceEventId ?? null]) : "";
}

export function mobileSessionOriginSourceAvailable(session: Session): boolean {
  return !session.archived && session.state !== SessionState.UNSPECIFIED && session.state !== SessionState.ARCHIVED
    && session.state !== SessionState.CLOSING && session.state !== SessionState.CLOSED;
}

/** Normal progress revisions do not change the Session which owns an origin navigation. */
export function mobileSessionOriginSessionKey(session: Session | undefined): string {
  return session ? JSON.stringify([session.sessionId, session.backendId, session.targetId, session.nativeBinding?.backendId ?? "",
    session.nativeBinding?.opaqueReference ?? "", session.nativeBinding?.runtimeGeneration?.toString() ?? "",
    session.worktree?.leaseId ?? "", session.worktree?.workspaceId ?? "", session.worktree?.state ?? 0]) : "";
}

function validIdentity(value: string): boolean {
  return value.length > 0 && value.length <= mobileNativeIntentIdentityMaximumCharacters && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
