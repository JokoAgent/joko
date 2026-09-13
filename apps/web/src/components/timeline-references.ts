import { parseComposerRouteReference } from "./composer-paste-pipeline.js";
import { canonicalWorkspaceRelativePath } from "./workspace-tree-state.js";
import { workspaceFilesHash } from "../workspace-files-navigation.js";
import { scanChatUrls } from "../chat-url-boundary.js";
import type { TimelineInputMentionRangeView, TimelineInputMentionView } from "../model.js";

export type TimelineReferenceTarget =
  | { readonly kind: "external"; readonly href: string }
  | { readonly kind: "session"; readonly href: string; readonly sessionId: string; readonly messageId?: string; readonly eventId?: string }
  | { readonly kind: "project"; readonly href: string; readonly projectId: string }
  | { readonly kind: "workspace"; readonly href: string; readonly path: string; readonly directory: boolean; readonly line?: number; readonly column?: number };

export type SentMessageReferenceSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reference"; readonly text: string; readonly target: TimelineReferenceTarget; readonly mention: boolean };

const SENT_REFERENCE_PATTERN = /\[([^\]\n]{1,240})\]\(([^)\s]{1,2048})\)|(?:joko:\/\/app[^\s"'<>]*?#\/(?:tasks|projects)\/[^\s"'<>]+|#\/(?:tasks|projects)\/[^\s"'<>]+|https?:\/\/)/giu;
const TRAILING_REFERENCE_PUNCTUATION = /[.,;:!?]+$/u;

export function resolveTimelineReference(rawValue: string, sessionId: string): TimelineReferenceTarget | undefined {
  const value = rawValue.trim();
  const external = safeExternalUrl(value);
  if (external !== undefined) return { kind: "external", href: external };

  const route = parseComposerRouteReference(value);
  if (route !== undefined) {
    const hashAt = value.indexOf("#");
    const href = hashAt < 0 ? value : value.slice(hashAt);
    return route.kind === "session"
      ? {
          kind: "session",
          href,
          sessionId: route.sessionId,
          ...(route.messageId === undefined ? {} : { messageId: route.messageId }),
          ...(route.eventId === undefined ? {} : { eventId: route.eventId })
        }
      : { kind: "project", href, projectId: route.projectId };
  }

  const local = normalizeWorkspaceReference(value);
  if (local === undefined) return undefined;
  return {
    kind: "workspace",
    href: workspaceFilesHash({
      sessionId,
      file: local.path,
      ...(local.line === undefined ? {} : { line: local.line })
    }),
    ...local
  };
}

export function parseSentMessageReferences(text: string, sessionId: string): readonly SentMessageReferenceSegment[] {
  const result: SentMessageReferenceSegment[] = [];
  SENT_REFERENCE_PATTERN.lastIndex = 0;
  let cursor = 0;
  const bareUrls = new Map(scanChatUrls(text).map((match) => [match.start, match]));
  let match: RegExpExecArray | null;
  while ((match = SENT_REFERENCE_PATTERN.exec(text)) !== null) {
    const markdownHref = match[2];
    let consumedText = match[0];
    let rawTarget = markdownHref ?? match[0];
    if (markdownHref !== undefined) {
      const destination = authoredDestination(text, match.index + match[0].indexOf("](") + 2);
      if (destination === undefined) continue;
      rawTarget = destination.value;
      consumedText = text.slice(match.index, destination.end);
      SENT_REFERENCE_PATTERN.lastIndex = destination.end;
    } else if (/^https?:\/\//iu.test(rawTarget)) {
      const url = bareUrls.get(match.index);
      if (url === undefined) continue;
      rawTarget = url.url;
      consumedText = rawTarget;
      SENT_REFERENCE_PATTERN.lastIndex = url.end;
    } else if (markdownHref === undefined) {
      const trimmed = trimReferencePunctuation(rawTarget);
      consumedText = consumedText.slice(0, consumedText.length - (rawTarget.length - trimmed.length));
      rawTarget = trimmed;
      SENT_REFERENCE_PATTERN.lastIndex = match.index + consumedText.length;
    }
    const target = resolveTimelineReference(rawTarget, sessionId);
    if (target === undefined) continue;
    if (match.index > cursor) result.push({ kind: "text", text: text.slice(cursor, match.index) });
    result.push({
      kind: "reference",
      text: markdownHref === undefined ? consumedText : match[1] ?? markdownHref,
      target,
      mention: false
    });
    cursor = match.index + consumedText.length;
  }
  if (cursor < text.length) result.push({ kind: "text", text: text.slice(cursor) });
  return result.length === 0 ? [{ kind: "text", text }] : result;
}

/** A receipt supplies positions explicitly; spelling never establishes identity. */
export function validSentInputMentionRanges(
  text: string,
  mentions: readonly TimelineInputMentionView[],
  ranges: readonly TimelineInputMentionRangeView[]
): readonly TimelineInputMentionRangeView[] | undefined {
  let end = 0;
  for (const range of ranges) {
    if (![range.start, range.end, range.mentionIndex].every(Number.isSafeInteger)
      || range.start < end || range.end <= range.start || range.end > text.length
      || range.mentionIndex < 0 || range.mentionIndex >= mentions.length
      || splitsSurrogate(text, range.start) || splitsSurrogate(text, range.end)) return undefined;
    end = range.end;
  }
  return ranges;
}

export type SentInputMentionSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "mention"; readonly text: string; readonly mention: TimelineInputMentionView; readonly mentionIndex: number };

export function sentInputMentionSegments(
  text: string,
  mentions: readonly TimelineInputMentionView[],
  ranges: readonly TimelineInputMentionRangeView[]
): readonly SentInputMentionSegment[] {
  const result: SentInputMentionSegment[] = [];
  let cursor = 0;
  const validRanges = validSentInputMentionRanges(text, mentions, ranges);
  if (validRanges === undefined) return [{ kind: "text", text }];
  for (const range of validRanges) {
    if (range.start > cursor) result.push({ kind: "text", text: text.slice(cursor, range.start) });
    result.push({ kind: "mention", text: text.slice(range.start, range.end), mention: mentions[range.mentionIndex]!, mentionIndex: range.mentionIndex });
    cursor = range.end;
  }
  if (cursor < text.length) result.push({ kind: "text", text: text.slice(cursor) });
  return result;
}

export function resolveSentWorkspaceMention(
  mention: Extract<TimelineInputMentionView, { readonly kind: "workspace" }>,
  sessionId: string,
  workspaceId: string | undefined
): TimelineReferenceTarget | undefined {
  if (workspaceId === undefined || mention.workspaceId !== workspaceId) return undefined;
  try {
    const path = canonicalWorkspaceRelativePath(mention.relativePath);
    if (path !== mention.relativePath) return undefined;
    const lineRange = mention.lineRange;
    if (lineRange !== undefined && (mention.directory || !Number.isSafeInteger(lineRange.startLine)
      || !Number.isSafeInteger(lineRange.endLine) || lineRange.startLine < 1 || lineRange.endLine < lineRange.startLine)) return undefined;
    const line = lineRange?.startLine;
    return { kind: "workspace", path, directory: mention.directory,
      href: workspaceFilesHash({ sessionId, file: path, ...(line === undefined ? {} : { line }) }),
      ...(line === undefined ? {} : { line }) };
  } catch { return undefined; }
}

export function resolveSentSessionMention(
  mention: Extract<TimelineInputMentionView, { readonly kind: "session" }>,
  currentSessionId: string
): TimelineReferenceTarget | undefined {
  const sessionId = mention.sessionId;
  if (sessionId === currentSessionId || sessionId.length === 0 || sessionId.length > 1_024
    || sessionId !== sessionId.trim() || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(sessionId)) return undefined;
  return { kind: "session", href: `#/tasks/${encodeURIComponent(sessionId)}`, sessionId };
}

function splitsSurrogate(text: string, offset: number): boolean {
  return offset > 0 && offset < text.length && /[\uD800-\uDBFF]/u.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(text[offset]!);
}

function authoredDestination(text: string, start: number): { readonly value: string; readonly end: number } | undefined {
  let depth = 1;
  for (let index = start; index < text.length && index - start <= 2048; index += 1) {
    const character = text[index];
    if (character === undefined || /\s/u.test(character)) return undefined;
    if (character === "\\") { index += 1; continue; }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return { value: text.slice(start, index).replace(/\\([!-/:-@[-`{-~])/gu, "$1"), end: index + 1 };
    }
  }
  return undefined;
}

export function safeExternalUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function normalizeWorkspaceReference(value: string): { readonly path: string; readonly directory: boolean; readonly line?: number; readonly column?: number } | undefined {
  if (value === "" || value.startsWith("#")) return undefined;
  if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(value) && !/^[^/\\:]+\.[A-Za-z\d_-]+:[1-9]\d*(?::[1-9]\d*)?$/u.test(value)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  const anchor = /#L([1-9]\d*)$/u.exec(decoded);
  if (anchor !== null) decoded = decoded.slice(0, anchor.index);
  const lineSuffix = anchor === null ? /:([1-9]\d*)(?::([1-9]\d*))?$/u.exec(decoded) : null;
  if (lineSuffix !== null) decoded = decoded.slice(0, lineSuffix.index);
  const directory = /\/$/u.test(decoded);
  const candidate = decoded.replace(/^\.\//u, "").replace(/\/$/u, "");
  try {
    const path = canonicalWorkspaceRelativePath(candidate);
    const rawLine = anchor?.[1] ?? lineSuffix?.[1];
    const line = rawLine === undefined ? undefined : Number(rawLine);
    const column = lineSuffix?.[2] === undefined ? undefined : Number(lineSuffix[2]);
    if ((line !== undefined && !Number.isSafeInteger(line)) || (column !== undefined && !Number.isSafeInteger(column))) return undefined;
    return {
      path,
      directory,
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column })
    };
  } catch {
    return undefined;
  }
}

function trimReferencePunctuation(value: string): string {
  let result = value;
  for (;;) {
    const next = result.replace(TRAILING_REFERENCE_PUNCTUATION, "").replace(/[\]}]+$/u, "");
    if (next === result) return result;
    result = next;
  }
}
