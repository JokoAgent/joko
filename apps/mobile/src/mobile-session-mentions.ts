import {
  CapabilitySupport,
  SessionState,
  capabilityNames,
  type BackendDescriptor,
  type Session,
  type Snapshot
} from "@joko/contracts";
import { normalizeMobileComposerDraft, type MobileComposerDraft } from "./mobile-composer-document";

export interface MobileSessionMentionCandidate {
  readonly sessionId: string;
  readonly displayText: string;
  readonly state: SessionState;
}

export interface MobileSessionMentionControls {
  readonly authorityKey: string;
  readonly surfaceOwnerKey: string;
  readonly sessionId?: string;
  readonly candidates: readonly MobileSessionMentionCandidate[];
}

export function createMobileSessionMentionControls(
  authorityKey: string | undefined,
  owner: Snapshot | undefined,
  session: Session | undefined,
  backend: BackendDescriptor | undefined
): MobileSessionMentionControls | undefined {
  if (!authorityKey || !owner || !session || !backend || !backendSupportsSessionMentions(backend)) return undefined;
  const candidates = sessionMentionCandidates(owner, session.sessionId);
  const surfaceOwnerKey = [
    authorityKey,
    "session-mentions",
    backend.version,
    backend.capabilities?.revision?.value.toString(10) ?? "",
    ...candidates.map((candidate) => [
      candidate.sessionId,
      candidate.displayText,
      candidate.state.toString(10),
      owner.sessions.find((item) => item.sessionId === candidate.sessionId)?.version?.generation.toString(10) ?? "",
      owner.sessions.find((item) => item.sessionId === candidate.sessionId)?.version?.revision?.value.toString(10) ?? ""
    ].join("\u001e"))
  ].join("\u001f");
  return {
    authorityKey,
    surfaceOwnerKey,
    sessionId: session.sessionId,
    candidates
  };
}

export function createMobileNewTaskSessionMentionControls(
  authorityKey: string | undefined,
  owner: Snapshot | undefined,
  backend: BackendDescriptor | undefined
): MobileSessionMentionControls | undefined {
  if (!authorityKey || !owner || !backend || !backendSupportsSessionMentions(backend)) return undefined;
  const candidates = sessionMentionCandidates(owner);
  return {
    authorityKey,
    surfaceOwnerKey: sessionMentionSurfaceOwnerKey(authorityKey, owner, backend, candidates, "new-task-session-mentions"),
    candidates
  };
}

export function filterMobileSessionMentionCandidates(
  candidates: readonly MobileSessionMentionCandidate[],
  query: string
): readonly MobileSessionMentionCandidate[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return candidates;
  return candidates.filter((candidate) => candidate.displayText.toLocaleLowerCase().includes(normalized)
    || candidate.sessionId.toLocaleLowerCase().includes(normalized));
}

export function assertMobileSessionMentionDraft(
  controls: MobileSessionMentionControls | undefined,
  draft: MobileComposerDraft
): MobileComposerDraft {
  const exact = normalizeMobileComposerDraft(draft);
  const mentions = exact.mentions.filter((mention) => mention.kind === "session");
  if (mentions.length === 0) return exact;
  if (!controls) throw new Error("This Backend no longer supports task references. The draft was retained.");
  const candidates = new Set(controls.candidates.map((candidate) => candidate.sessionId));
  const retired = mentions.find((mention) => !candidates.has(mention.sessionId));
  if (retired) throw new Error("A referenced task is no longer available. Remove or replace that reference before sending.");
  return exact;
}

export function assertMobileSessionMentionCandidate(
  controls: MobileSessionMentionControls | undefined,
  candidate: MobileSessionMentionCandidate
): MobileSessionMentionCandidate {
  const matches = controls?.candidates.filter((current) => current.sessionId === candidate.sessionId) ?? [];
  const current = matches.length === 1 ? matches[0] : undefined;
  if (!current || current.displayText !== candidate.displayText || current.state !== candidate.state) {
    throw new Error("The referenced task changed. Reopen the reference list and try again.");
  }
  return current;
}

export function backendSupportsSessionMentions(backend: BackendDescriptor | undefined): boolean {
  const capabilities = backend?.capabilities?.capabilities.filter((capability) => capability.name === capabilityNames.inputMention) ?? [];
  if (capabilities.length !== 1) return false;
  const capability = capabilities[0]!;
  const options = capability.options?.kind.case === "input"
    ? capability.options.kind.value.mediaTypes
    : [];
  return capability.support === CapabilitySupport.SUPPORTED
    && options.includes("session")
    && new Set(options).size === options.length;
}

function sessionMentionCandidates(owner: Snapshot, currentSessionId?: string): MobileSessionMentionCandidate[] {
  const groups = new Map<string, Session[]>();
  for (const candidate of owner.sessions) {
    if (!validSessionId(candidate.sessionId) || candidate.sessionId === currentSessionId || candidate.state === SessionState.CLOSED) continue;
    const entries = groups.get(candidate.sessionId) ?? [];
    entries.push(candidate);
    groups.set(candidate.sessionId, entries);
  }
  return [...groups.entries()].flatMap(([sessionId, entries]) => entries.length !== 1 ? [] : [{
    sessionId,
    displayText: safeDisplayText(entries[0]!),
    state: entries[0]!.state
  }]).sort((left, right) => left.displayText.localeCompare(right.displayText, "en")
    || left.sessionId.localeCompare(right.sessionId, "en"));
}

function sessionMentionSurfaceOwnerKey(
  authorityKey: string,
  owner: Snapshot,
  backend: BackendDescriptor,
  candidates: readonly MobileSessionMentionCandidate[],
  kind = "session-mentions"
): string {
  return [
    authorityKey,
    kind,
    backend.version,
    backend.capabilities?.revision?.value.toString(10) ?? "",
    ...candidates.map((candidate) => [
      candidate.sessionId,
      candidate.displayText,
      candidate.state.toString(10),
      owner.sessions.find((item) => item.sessionId === candidate.sessionId)?.version?.generation.toString(10) ?? "",
      owner.sessions.find((item) => item.sessionId === candidate.sessionId)?.version?.revision?.value.toString(10) ?? ""
    ].join("\u001e"))
  ].join("\u001f");
}

function validSessionId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeDisplayText(session: Session): string {
  const display = session.displayName.trim();
  return display && display.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(display)
    ? display
    : session.sessionId;
}
