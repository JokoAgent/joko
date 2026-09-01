import { parseComposerRouteReference } from "./composer-paste-pipeline.js";
import { canonicalWorkspaceRelativePath } from "./workspace-tree-state.js";
import { workspaceFilesHash } from "../workspace-files-navigation.js";

export type TimelineReferenceTarget =
  | { readonly kind: "external"; readonly href: string }
  | { readonly kind: "session"; readonly href: string; readonly sessionId: string; readonly messageId?: string; readonly eventId?: string }
  | { readonly kind: "project"; readonly href: string; readonly projectId: string }
  | { readonly kind: "workspace"; readonly href: string; readonly path: string; readonly directory: boolean; readonly line?: number };

export type SentMessageReferenceSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reference"; readonly text: string; readonly target: TimelineReferenceTarget; readonly mention: boolean };

const SENT_REFERENCE_PATTERN = /\[([^\]\n]{1,240})\]\(([^)\s]{1,2048})\)|(?:joko:\/\/app[^\s"'<>]*?#\/(?:tasks|projects)\/[^\s"'<>]+|#\/(?:tasks|projects)\/[^\s"'<>]+|https?:\/\/[^\s"'<>]+)|@"((?:\\.|[^"\n]){1,1024})"|@([^\s"'<>]+)/giu;
const TRAILING_REFERENCE_PUNCTUATION = /[.,;:!?]+$/u;

export function resolveTimelineReference(rawValue: string, sessionId: string): TimelineReferenceTarget | undefined {
  const value = trimReferencePunctuation(rawValue.trim());
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
  let match: RegExpExecArray | null;
  while ((match = SENT_REFERENCE_PATTERN.exec(text)) !== null) {
    const markdownHref = match[2];
    const quotedMention = match[3];
    const bareMention = match[4];
    const mention = quotedMention !== undefined || bareMention !== undefined;
    const rawTarget = markdownHref ?? quotedMention?.replace(/\\"/gu, '"') ?? bareMention ?? match[0];
    if (mention && !looksLikeWorkspaceMention(rawTarget)) continue;
    const target = resolveTimelineReference(rawTarget, sessionId);
    if (target === undefined || (mention && target.kind !== "workspace")) continue;
    if (match.index > cursor) result.push({ kind: "text", text: text.slice(cursor, match.index) });
    result.push({
      kind: "reference",
      text: markdownHref === undefined ? match[0] : match[1] ?? markdownHref,
      target,
      mention
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) result.push({ kind: "text", text: text.slice(cursor) });
  return result.length === 0 ? [{ kind: "text", text }] : result;
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

function normalizeWorkspaceReference(value: string): { readonly path: string; readonly directory: boolean; readonly line?: number } | undefined {
  if (value === "" || value.startsWith("#") || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(value)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  const anchor = /#L([1-9]\d*)$/u.exec(decoded);
  if (anchor !== null) decoded = decoded.slice(0, anchor.index);
  const lineSuffix = anchor === null ? /:([1-9]\d*)$/u.exec(decoded) : null;
  if (lineSuffix !== null && /\.[^/.:]+:\d+$/u.test(decoded)) decoded = decoded.slice(0, lineSuffix.index);
  const directory = /\/$/u.test(decoded);
  const candidate = decoded.replace(/^\.\//u, "").replace(/\/$/u, "");
  try {
    const path = canonicalWorkspaceRelativePath(candidate);
    const rawLine = anchor?.[1] ?? lineSuffix?.[1];
    const line = rawLine === undefined ? undefined : Number(rawLine);
    return {
      path,
      directory,
      ...(line === undefined || !Number.isSafeInteger(line) ? {} : { line })
    };
  } catch {
    return undefined;
  }
}

function looksLikeWorkspaceMention(value: string): boolean {
  const normalized = value.replace(/\\"/gu, '"');
  return normalized.includes("/") || /\.[A-Za-z\d_-]{1,16}(?::\d+)?$/u.test(normalized);
}

function trimReferencePunctuation(value: string): string {
  let result = value;
  for (;;) {
    const next = result.replace(TRAILING_REFERENCE_PUNCTUATION, "").replace(/[\]}]+$/u, "");
    if (next === result) return result;
    result = next;
  }
}
