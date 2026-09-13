import type { MessageKey } from "../i18n.js";
import type {
  ErrorView,
  SubagentChildRunView,
  SubagentTranscriptEntryView,
  SubagentTranscriptPageView
} from "../model.js";
import type { Translator } from "./types.js";
import { mergeSubagentTranscript } from "./subagent-conversation.js";

export interface CompleteSubagentTranscriptPage extends SubagentTranscriptPageView {
  readonly nextPageToken?: undefined;
}

/** Matches the durable reference reader's eager-page safety fence. */
export const MAXIMUM_COMPLETE_SUBAGENT_TRANSCRIPT_PAGES = 100;

/**
 * Reads a complete transcript range. Passing a tail token reads every page
 * appended after it; omitting it reads the record from the beginning.
 */
export async function collectAllSubagentTranscript(
  loadPage: (pageToken: string) => Promise<SubagentTranscriptPageView>,
  startPageToken = ""
): Promise<CompleteSubagentTranscriptPage> {
  const seen = new Set<string>();
  let pageToken = startPageToken;
  let entries: readonly SubagentTranscriptEntryView[] = [];
  let tailPageToken: string | undefined;
  let totalSize = 0;
  for (let pageIndex = 0; pageIndex < MAXIMUM_COMPLETE_SUBAGENT_TRANSCRIPT_PAGES; pageIndex += 1) {
    if (seen.has(pageToken)) throw new Error("Delegated transcript pagination returned a cyclic token.");
    seen.add(pageToken);
    const page = await loadPage(pageToken);
    entries = mergeSubagentTranscript(entries, page.entries);
    totalSize = page.totalSize;
    tailPageToken = page.tailPageToken;
    if (page.nextPageToken === undefined) {
      return {
        entries,
        ...(tailPageToken === undefined ? {} : { tailPageToken }),
        totalSize
      };
    }
    pageToken = page.nextPageToken;
  }
  throw new Error("Delegated transcript pagination exceeded its safe page limit.");
}

/** Returns only the latest visible generation of each child lineage. */
export function currentSubagentChildren(
  children: readonly SubagentChildRunView[]
): readonly SubagentChildRunView[] {
  if (children.length < 2) return children;
  const historicalIds = new Set<string>();
  for (const child of children) {
    if (child.parentChildId !== undefined) historicalIds.add(child.parentChildId);
    for (const alias of child.identityAliases) if (alias !== child.id) historicalIds.add(alias);
  }
  const current = children.filter((child) => !historicalIds.has(child.id));
  return current.length === 0 ? children : current;
}

/**
 * Resolves a clicked generation to its current descendant. If the selected
 * generation disappeared, a sole current child is the only safe fallback;
 * parallel lineages fall back to the overview.
 */
export function resolveCurrentSubagentChild(
  children: readonly SubagentChildRunView[],
  selectedIdentity: string
): SubagentChildRunView | undefined {
  const current = currentSubagentChildren(children);
  if (selectedIdentity !== "") {
    const direct = current.find((child) => child.id === selectedIdentity);
    if (direct !== undefined) return direct;
    const matches = current.filter((child) => subagentChildIdentitySet(child, children).has(selectedIdentity));
    if (matches.length > 0) {
      return [...matches].sort((left, right) => right.startedAt - left.startedAt || right.id.localeCompare(left.id))[0];
    }
  }
  return current.length === 1 ? current[0] : undefined;
}

/** All durable identities belonging to one logical child, oldest to newest. */
export function subagentChildIdentitySet(
  child: SubagentChildRunView,
  children: readonly SubagentChildRunView[]
): ReadonlySet<string> {
  const identities = new Set<string>();
  const visitedChildren = new Set<string>();
  const byIdentity = new Map<string, SubagentChildRunView>();
  for (const candidate of children) {
    byIdentity.set(candidate.id, candidate);
    for (const alias of candidate.identityAliases) if (!byIdentity.has(alias)) byIdentity.set(alias, candidate);
  }
  const pending: Array<SubagentChildRunView | string> = [child];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === undefined) continue;
    if (typeof value === "string") {
      if (identities.has(value)) continue;
      identities.add(value);
      const parent = byIdentity.get(value);
      if (parent !== undefined) pending.push(parent);
      continue;
    }
    if (visitedChildren.has(value.id)) continue;
    visitedChildren.add(value.id);
    identities.add(value.id);
    for (const alias of value.identityAliases) identities.add(alias);
    if (value.parentChildId !== undefined) pending.push(value.parentChildId);
  }
  return identities;
}

export function filterSubagentTranscript(
  transcript: readonly SubagentTranscriptEntryView[],
  child: SubagentChildRunView | undefined,
  children: readonly SubagentChildRunView[]
): readonly SubagentTranscriptEntryView[] {
  if (child === undefined) return transcript;
  const identities = subagentChildIdentitySet(child, children);
  return transcript.filter((entry) => entry.childId === undefined || identities.has(entry.childId));
}

export interface SubagentReplyProjection {
  readonly showDurableResult: boolean;
  readonly hasReply: boolean;
  readonly recordTruncated: boolean;
}

export function projectSubagentReply(
  transcript: readonly SubagentTranscriptEntryView[],
  currentChildIds: ReadonlySet<string>,
  durableResult: string | undefined,
  tailComplete: boolean
): SubagentReplyProjection {
  const normalizedResult = normalizedText(durableResult);
  let hasCurrentReply = false;
  let hasMatchingCurrentReply = false;
  let recordTruncated = false;
  for (const entry of transcript) {
    const belongsToCurrent = entry.childId === undefined || currentChildIds.has(entry.childId);
    if (!belongsToCurrent) continue;
    if (entry.role === "subagent") {
      hasCurrentReply = true;
      if (normalizedResult !== undefined && normalizedText(entry.content) === normalizedResult) {
        hasMatchingCurrentReply = true;
      }
    }
    if (entry.role === "system" && entry.systemEvent?.kind === "transcript-truncated") {
      recordTruncated = true;
    }
  }
  const complete = tailComplete && !recordTruncated;
  const showDurableResult = normalizedResult !== undefined && (!hasMatchingCurrentReply || !complete);
  return { showDurableResult, hasReply: hasCurrentReply || showDurableResult, recordTruncated };
}

export type SubagentErrorKind =
  | "providerNotConnected"
  | "credentialInvalid"
  | "modelInvalid"
  | "rateLimited"
  | "serviceUnavailable"
  | "requestInvalid"
  | "permissionDenied"
  | "timedOut"
  | "unknown";

export function classifySubagentError(error: ErrorView): SubagentErrorKind {
  const value = `${error.code}\n${error.phase}\n${error.message}`.toLowerCase();
  if (/invalid model|model[^\n]{0,80}(?:not found|unknown|unsupported|unavailable)|unknown[^\n]{0,40}model/u.test(value)) return "modelInvalid";
  if (/\b401\b|unauthori[sz]ed|invalid api[- ]?key|invalid[^\n]{0,40}token|token[^\n]{0,40}(?:expired|revoked)|credential[^\n]{0,40}(?:expired|invalid|revoked)/u.test(value)) return "credentialInvalid";
  if (/provider[^\n]{0,60}(?:not connected|not configured|unavailable)|(?:missing|no)[^\n]{0,40}(?:credential|api[- ]?key|token)|authentication required|sign[- ]?in required/u.test(value)) return "providerNotConnected";
  if (/\b429\b|rate[- ]?limit|too many requests/u.test(value)) return "rateLimited";
  if (/\b(?:500|502|503|504)\b|service unavailable|bad gateway|gateway timeout|temporarily unavailable/u.test(value)) return "serviceUnavailable";
  if (/permission denied|forbidden|\b403\b|not allowed/u.test(value)) return "permissionDenied";
  if (/timed? ?out|deadline exceeded|timeout/u.test(value)) return "timedOut";
  if (/\b400\b|bad request|invalid request/u.test(value)) return "requestInvalid";
  return "unknown";
}

const SYSTEM_EVENT_KEYS: Readonly<Record<string, MessageKey>> = {
  "stop-requested": "subagents.systemEvent.stopRequested",
  "control-requested": "subagents.systemEvent.controlRequested",
  "transcript-truncated": "subagents.systemEvent.transcriptTruncated",
  "turn-ended": "subagents.systemEvent.turnEnded",
  "command-refused": "subagents.systemEvent.commandRefused",
  "generation-unreadable": "subagents.systemEvent.generationUnreadable"
};

/** Known synthesized rows localize; runtime and future rows stay verbatim. */
export function localizeSubagentSystemEntry(
  entry: SubagentTranscriptEntryView,
  t: Translator
): string {
  const kind = entry.systemEvent?.kind;
  const key = kind === undefined ? undefined : SYSTEM_EVENT_KEYS[kind];
  if (key === undefined) return entry.content;
  const values: Record<string, string> = {};
  for (const parameter of entry.systemEvent?.params ?? []) values[parameter.key] = parameter.value;
  return t(key, values);
}

function normalizedText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\r\n/gu, "\n").trim();
  return normalized === undefined || normalized === "" ? undefined : normalized;
}
