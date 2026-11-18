import { CapabilitySupport, SessionAttentionKind, type EventCursor, type Session, type Snapshot } from "@joko/contracts";

export interface MobileSessionAttention {
  readonly kind: SessionAttentionKind.DONE | SessionAttentionKind.AWAITING | SessionAttentionKind.ERROR;
  readonly cursor: EventCursor;
}

export function mobileSessionAttention(owner: Snapshot | undefined, session: Session | undefined): MobileSessionAttention | undefined {
  if (!owner || !session || session.archived || session.hidden || session.provisionalDraftId
    || session.automationOrigin || session.derivationOrigin?.sideChat) return undefined;
  const attention = session.attention;
  const cursor = attention?.attentionCursor;
  if (!attention?.unread || !cursor?.opaqueToken || cursor.sequence <= 0n
    || (attention.kind !== SessionAttentionKind.DONE && attention.kind !== SessionAttentionKind.AWAITING
      && attention.kind !== SessionAttentionKind.ERROR)) return undefined;
  if (!owner.backends.find(backend => backend.backendId === session.backendId)?.capabilities?.capabilities
    .some(capability => capability.name === "session.attention" && capability.support === CapabilitySupport.SUPPORTED)) return undefined;
  return { kind: attention.kind, cursor };
}

export function mobileAttentionKey(attention: MobileSessionAttention): string {
  return JSON.stringify([attention.kind, attention.cursor.generation.toString(), attention.cursor.sequence.toString(), attention.cursor.opaqueToken]);
}

export function mobileViewedSessionAttention(owner: Snapshot | undefined, detail: Snapshot | undefined,
  sessionId: string): MobileSessionAttention | undefined {
  if (!owner || !detail || detail.generation !== owner.generation || detail.server?.serverId !== owner.server?.serverId
    || detail.scope?.kind.case !== "session" || detail.scope.kind.value.sessionId !== sessionId) return undefined;
  const attention = mobileSessionAttention(owner, owner.sessions.find(session => session.sessionId === sessionId));
  if (!attention || attention.kind === SessionAttentionKind.ERROR) return undefined;
  const detailAttention = mobileSessionAttention(owner, detail.sessions.find(session => session.sessionId === sessionId));
  const baseline = detail.resumeCursor;
  // The attention cursor retains the generation of the durable source event.
  // Snapshot resume cursors instead describe the current service stream.
  return detailAttention && mobileAttentionKey(detailAttention) === mobileAttentionKey(attention) && baseline?.opaqueToken
    && baseline.generation === owner.generation && baseline.sequence >= attention.cursor.sequence ? attention : undefined;
}
