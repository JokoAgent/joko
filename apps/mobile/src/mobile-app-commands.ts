import {
  CapabilitySupport,
  InteractionState,
  QueueItemState,
  RunState,
  SessionState,
  TargetState,
  capabilityNames,
  type BackendDescriptor,
  type Session,
  type Snapshot
} from "@joko/contracts";
import {
  normalizeMobileComposerDraft,
  type MobileComposerDraft
} from "./mobile-composer-document";
import type { MobileRuntimeCommandCandidate } from "./mobile-runtime-commands";

export type MobileAppCommandKind = "help" | "jumpSession" | "userShell" | "sessionReset" | "review";

export interface MobileAppCommandPolicy {
  readonly help: true;
  readonly jumpSession: true;
  readonly userShell: boolean;
  readonly sessionReset: boolean;
  readonly review: boolean;
}

export interface MobileAppCommandControls {
  readonly authorityKey: string;
  readonly surfaceOwnerKey: string;
  readonly session: Session;
  readonly backendId: string;
  readonly targetId: string;
  readonly runtimeGeneration: string;
  readonly jumpSessionIds: readonly string[];
  readonly policy: MobileAppCommandPolicy;
}

export interface MobileAppCommandCandidate {
  readonly commandId: `builtin:${"help" | "jump-session" | "cmd" | "clear" | "review"}`;
  readonly name: "help" | "jump-session" | "cmd" | "clear" | "review";
  readonly description: string;
  readonly appCommand: MobileAppCommandKind;
}

export type MobileCommandPaletteCandidate = MobileRuntimeCommandCandidate | MobileAppCommandCandidate;

export type MobileAppCommandInvocation =
  | { readonly kind: "help" }
  | { readonly kind: "jumpSession"; readonly sessionId: string }
  | { readonly kind: "userShell"; readonly command: string }
  | { readonly kind: "sessionReset" }
  | { readonly kind: "review"; readonly focus: string };

export type MobileRemoteAppCommandInvocation = Exclude<
  MobileAppCommandInvocation,
  { readonly kind: "help" } | { readonly kind: "jumpSession" }
>;

export interface MobileCommandPaletteResults {
  readonly items: readonly MobileCommandPaletteCandidate[];
  readonly truncated: boolean;
}

const maximumVisibleResults = 20;
const maximumReviewFocusCharacters = 4_000;
const reservedAppCommandNames = ["help", "jump-session", "cmd", "clear", "review"] as const;
const blockedSessionStates = new Set([
  SessionState.CREATING,
  SessionState.RUNNING,
  SessionState.WAITING,
  SessionState.RECOVERING,
  SessionState.CLOSING,
  SessionState.CLOSED
]);
const activeRunStates = new Set([
  RunState.ACCEPTED,
  RunState.QUEUED,
  RunState.DISPATCHING,
  RunState.DISPATCH_UNKNOWN,
  RunState.RUNNING,
  RunState.WAITING,
  RunState.RETRYING
]);
const activeQueueStates = new Set([
  QueueItemState.ACCEPTED,
  QueueItemState.DISPATCHING,
  QueueItemState.BACKEND_ACCEPTED,
  QueueItemState.DISPATCH_UNKNOWN
]);

export function createMobileAppCommandControls(
  authorityKey: string | undefined,
  owner: Snapshot | undefined,
  detail: Snapshot | undefined,
  selectedId: string | undefined
): MobileAppCommandControls | undefined {
  if (!authorityKey || !owner || !detail || !validIdentity(selectedId, 1_024)
    || owner.generation !== detail.generation) return undefined;
  const ownerSession = unique(owner.sessions, (item) => item.sessionId === selectedId);
  const detailSession = unique(detail.sessions, (item) => item.sessionId === selectedId);
  if (!ownerSession || !detailSession || ownerSession.backendId !== detailSession.backendId
    || ownerSession.targetId !== detailSession.targetId
    || entityKey(ownerSession.version) !== entityKey(detailSession.version)
    || detailSession.state === SessionState.UNSPECIFIED) return undefined;
  const generation = detailSession.nativeBinding?.runtimeGeneration;
  if (!generation || generation < 1n || ownerSession.nativeBinding?.runtimeGeneration !== generation
    || detailSession.version?.generation !== generation) return undefined;

  const ownerBackend = unique(owner.backends, (item) => item.backendId === detailSession.backendId);
  const detailBackend = unique(detail.backends, (item) => item.backendId === detailSession.backendId);
  const ownerTarget = unique(owner.targets, (item) => item.targetId === detailSession.targetId);
  const detailTarget = unique(detail.targets, (item) => item.targetId === detailSession.targetId);
  if (!ownerBackend || !detailBackend || !ownerTarget || !detailTarget
    || ownerTarget.backendId !== detailSession.backendId || detailTarget.backendId !== detailSession.backendId
    || ownerTarget.state !== TargetState.ACTIVE || detailTarget.state !== TargetState.ACTIVE
    || entityKey(ownerTarget.version) !== entityKey(detailTarget.version)
    || backendKey(ownerBackend) !== backendKey(detailBackend)) return undefined;

  const sessionIds = new Set<string>();
  for (const session of owner.sessions) {
    if (!validIdentity(session.sessionId, 1_024) || sessionIds.has(session.sessionId)) return undefined;
    sessionIds.add(session.sessionId);
  }
  const reviewReadOnly = detail.reviewRuns.some((run) => run.reviewerSessionId === detailSession.sessionId);
  const activeWork = detail.runs.some((run) => run.sessionId === detailSession.sessionId && activeRunStates.has(run.state))
    || detail.queueItems.some((item) => item.sessionId === detailSession.sessionId && activeQueueStates.has(item.state))
    || detail.interactions.some((interaction) => interaction.sessionId === detailSession.sessionId
      && interaction.state === InteractionState.PENDING);
  const remoteAllowed = !blockedSessionStates.has(detailSession.state) && !reviewReadOnly && !activeWork;
  const policy = {
    help: true as const,
    jumpSession: true as const,
    userShell: remoteAllowed && supportedOnce(ownerBackend, capabilityNames.runtimeUserShell),
    sessionReset: remoteAllowed && supportedOnce(ownerBackend, capabilityNames.sessionReset),
    review: remoteAllowed && supportedOnce(ownerBackend, capabilityNames.reviewIsolated)
  };
  return {
    authorityKey,
    surfaceOwnerKey: [
      authorityKey,
      "app-commands",
      Number(policy.userShell),
      Number(policy.sessionReset),
      Number(policy.review)
    ].join("\u001f"),
    session: detailSession,
    backendId: detailSession.backendId,
    targetId: detailSession.targetId,
    runtimeGeneration: generation.toString(10),
    jumpSessionIds: owner.sessions
      .filter((session) => session.state !== SessionState.CLOSED)
      .map((session) => session.sessionId),
    policy
  };
}

export function mobileAppCommandCandidates(
  controls: MobileAppCommandControls
): readonly MobileAppCommandCandidate[] {
  return [
    { commandId: "builtin:help", name: "help", appCommand: "help",
      description: "Show every available command and skill" },
    { commandId: "builtin:jump-session", name: "jump-session", appCommand: "jumpSession",
      description: "Open an exact task by ID" },
    ...(controls.policy.userShell ? [{ commandId: "builtin:cmd" as const, name: "cmd" as const,
      appCommand: "userShell" as const, description: "Run a workspace shell command" }] : []),
    ...(controls.policy.sessionReset ? [{ commandId: "builtin:clear" as const, name: "clear" as const,
      appCommand: "sessionReset" as const, description: "Clear task context" }] : []),
    ...(controls.policy.review ? [{ commandId: "builtin:review" as const, name: "review" as const,
      appCommand: "review" as const, description: "Review current work in an independent read-only task" }] : [])
  ];
}

export function mergeMobileCommandPaletteCandidates(
  controls: MobileAppCommandControls,
  runtimeCommands: readonly MobileRuntimeCommandCandidate[] = []
): readonly MobileCommandPaletteCandidate[] {
  const app = mobileAppCommandCandidates(controls);
  const names = new Set<string>(reservedAppCommandNames);
  return [
    ...app,
    ...runtimeCommands.filter((candidate) => {
      const name = candidate.name.toLowerCase();
      if (names.has(name)) return false;
      names.add(name);
      return true;
    })
  ];
}

/** Detect an app-owned command token even when its syntax or capability is currently invalid. */
export function mobileAppCommandIntent(draft: MobileComposerDraft): MobileAppCommandKind | undefined {
  const token = normalizeMobileComposerDraft(draft).text.trimStart().match(/^\/([^\s]*)/u)?.[1]?.toLowerCase();
  if (token === "help") return "help";
  if (token === "jump-session") return "jumpSession";
  if (token === "cmd") return "userShell";
  if (token === "clear") return "sessionReset";
  if (token === "review") return "review";
  return undefined;
}

export function filterMobileCommandPaletteCandidates(
  candidates: readonly MobileCommandPaletteCandidate[],
  query: string,
  limit = maximumVisibleResults
): MobileCommandPaletteResults {
  const maximum = Math.max(0, Math.min(maximumVisibleResults, Number.isSafeInteger(limit) ? limit : 0));
  const needle = query.toLowerCase();
  const matches = candidates.filter((candidate) => candidate.name.toLowerCase().startsWith(needle)
    || candidate.description.toLowerCase().includes(needle)).sort((left, right) =>
      Number(right.name.toLowerCase().startsWith(needle)) - Number(left.name.toLowerCase().startsWith(needle)));
  return { items: matches.slice(0, maximum), truncated: matches.length > maximum };
}

export function isMobileAppCommandCandidate(
  candidate: MobileCommandPaletteCandidate
): candidate is MobileAppCommandCandidate {
  return "appCommand" in candidate;
}

export function isMobileRemoteAppCommandInvocation(
  invocation: MobileAppCommandInvocation
): invocation is MobileRemoteAppCommandInvocation {
  return invocation.kind === "userShell" || invocation.kind === "sessionReset" || invocation.kind === "review";
}

export function assertMobileAppCommandCandidate(
  controls: MobileAppCommandControls | undefined,
  value: MobileAppCommandCandidate
): MobileAppCommandCandidate {
  if (!controls) throw new Error("The task command owner changed. Type the slash command again.");
  const matches = mobileAppCommandCandidates(controls).filter((candidate) =>
    candidate.commandId === value.commandId && candidate.name === value.name
    && candidate.appCommand === value.appCommand && candidate.description === value.description);
  if (matches.length !== 1) throw new Error("The selected app command is no longer available.");
  return matches[0]!;
}

/** Recognize only a complete, capability-applicable app invocation. */
export function parseMobileAppCommand(
  draft: MobileComposerDraft,
  controls: MobileAppCommandControls | undefined
): MobileAppCommandInvocation | undefined {
  if (!controls) return undefined;
  const text = normalizeMobileComposerDraft(draft).text;
  if (controls.policy.help && /^\/help\s*$/iu.test(text)) return { kind: "help" };
  if (controls.policy.jumpSession) {
    const jump = text.match(/^\/jump-session(?:\s+([^\s]+))?\s*$/iu);
    if (jump) return { kind: "jumpSession", sessionId: (jump[1] ?? "").trim() };
  }
  if (controls.policy.userShell) {
    const shell = text.match(/^\/cmd(?:\s+([\s\S]*?))?\s*$/iu);
    if (shell) return { kind: "userShell", command: (shell[1] ?? "").trim() };
  }
  if (controls.policy.review) {
    const review = text.match(/^\/review(?:\s+([\s\S]*?))?\s*$/iu);
    if (review) return { kind: "review", focus: (review[1] ?? "").trim() };
  }
  if (controls.policy.sessionReset && /^\s*\/clear\s*$/u.test(text)) return { kind: "sessionReset" };
  return undefined;
}

export function assertMobileAppCommandInvocation(
  controls: MobileAppCommandControls | undefined,
  draft: MobileComposerDraft,
  expected: MobileAppCommandInvocation
): MobileAppCommandInvocation {
  const exact = normalizeMobileComposerDraft(draft);
  if (exact.mentions.length > 0 || exact.atoms.length > 0) {
    throw new Error("App commands cannot contain references or structured message items.");
  }
  const parsed = parseMobileAppCommand(exact, controls);
  if (!parsed || !sameInvocation(parsed, expected)) {
    throw new Error("The app command or its task authority changed. Review the retained draft before trying again.");
  }
  if ((parsed.kind === "jumpSession" || parsed.kind === "userShell") && exact.attachments.length > 0) {
    throw new Error(parsed.kind === "jumpSession"
      ? "Remove attachments before opening another task."
      : "Remove attachments before running a shell command.");
  }
  if (parsed.kind === "jumpSession") {
    if (!parsed.sessionId) throw new Error("Usage: /jump-session <task ID>");
    if (!controls?.jumpSessionIds.includes(parsed.sessionId)) {
      throw new Error("The requested task does not exist or is unavailable.");
    }
  }
  if (parsed.kind === "userShell" && !parsed.command) {
    throw new Error("Usage: /cmd <workspace shell command>");
  }
  if (parsed.kind === "review" && [...parsed.focus].length > maximumReviewFocusCharacters) {
    throw new Error(`Review focus must not exceed ${maximumReviewFocusCharacters} characters.`);
  }
  return parsed;
}

function sameInvocation(left: MobileAppCommandInvocation, right: MobileAppCommandInvocation): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "jumpSession" && right.kind === "jumpSession") return left.sessionId === right.sessionId;
  if (left.kind === "userShell" && right.kind === "userShell") return left.command === right.command;
  if (left.kind === "review" && right.kind === "review") return left.focus === right.focus;
  return true;
}

function supportedOnce(backend: BackendDescriptor, name: string): boolean {
  const matches = backend.capabilities?.capabilities.filter((capability) => capability.name === name) ?? [];
  return matches.length === 1 && matches[0]!.support === CapabilitySupport.SUPPORTED;
}

function unique<T>(values: readonly T[], matches: (value: T) => boolean): T | undefined {
  const selected = values.filter(matches);
  return selected.length === 1 ? selected[0] : undefined;
}

function validIdentity(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim()
    && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
}

function backendKey(backend: BackendDescriptor): string {
  return [
    backend.backendId,
    backend.version,
    entityKey(backend.entityVersion),
    backend.capabilities?.schemaVersion ?? "",
    backend.capabilities?.revision?.value.toString(10) ?? "",
    backend.capabilities?.revision?.etag ?? ""
  ].join("\u001e");
}

function entityKey(version: {
  readonly generation: bigint;
  readonly revision?: { readonly value: bigint; readonly etag: string };
} | undefined): string {
  return [
    version?.generation.toString(10) ?? "",
    version?.revision?.value.toString(10) ?? "",
    version?.revision?.etag ?? ""
  ].join("\u001e");
}

export const mobileAppCommandTesting = {
  maximumReviewFocusCharacters,
  maximumVisibleResults
};
