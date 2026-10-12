import { InteractionState, RunState, SessionAttentionKind, SessionState, type Snapshot } from "@joko/contracts";
import { firstIdentityLine, type MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import { parseMobileMarkdownInlines } from "./mobile-markdown";

/** Read-only presentation; this observation never authorizes navigation or effects. */
export interface MobilePartnerDirectoryObservation {
  readonly ownerKey: string;
  readonly online: boolean;
  readonly snapshot: Snapshot;
}

export type MobilePartnerActivityState = "ready" | "working" | "waiting" | "recovering" | "compacting" | "attention" | "unknown" | "offline";

export function mobilePartnerActivityState(partner: MobilePartnerDirectoryProfile,
  observation: MobilePartnerDirectoryObservation | undefined): MobilePartnerActivityState {
  if (!observation?.online) return "offline";
  const matches = observation.snapshot.sessions.filter((session) => session.sessionId === partner.canonicalSessionId);
  const session = matches.length === 1 ? matches[0] : undefined;
  if (!session || session.targetId !== partner.homeTargetId
    || session.backendId !== partner.capabilities.modelChain[0]?.backendId || session.archived
    || session.version?.generation === undefined || session.version.generation < 1n) return "unknown";
  const runs = observation.snapshot.runs.filter((run) => run.sessionId === session.sessionId
    && run.targetId === session.targetId && run.backendId === session.backendId
    && run.version?.generation === session.version!.generation);
  if (session.state === SessionState.ERROR || session.state === SessionState.IDLE && session.attention?.unread
    && session.attention.kind === SessionAttentionKind.ERROR
    && session.attention.subjectCursor?.generation === session.version!.generation) return "attention";
  if (session.state === SessionState.RECOVERING || runs.some((run) =>
    run.state === RunState.DISPATCH_UNKNOWN || run.state === RunState.RETRYING)) return "recovering";
  if (session.state === SessionState.WAITING || observation.snapshot.interactions.some((interaction) =>
    interaction.sessionId === session.sessionId && interaction.targetId === session.targetId
    && interaction.backendId === session.backendId && interaction.generation === session.version!.generation
    && interaction.state === InteractionState.PENDING)) return "waiting";
  if (session.contextState?.compacting) return "compacting";
  if (session.state === SessionState.RUNNING || runs.some((run) =>
    run.state === RunState.RUNNING || run.state === RunState.DISPATCHING)) return "working";
  return session.state === SessionState.IDLE || session.state === SessionState.DETACHED ? "ready" : "unknown";
}

export function mobilePartnerDirectoryPreview(partner: MobilePartnerDirectoryProfile): string {
  const preview = parseMobileMarkdownInlines(partner.activity.latestReplyPreview ?? "")
    .map((inline) => inline.type === "image" ? inline.alt : inline.text).join("")
    .replace(/\s+/gu, " ").trim();
  return preview || firstIdentityLine(partner.identitySource).replace(/\s+/gu, " ").trim();
}
