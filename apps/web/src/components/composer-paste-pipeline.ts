export const COMPOSER_LONG_PASTE_LINE_THRESHOLD = 24;
export const COMPOSER_LONG_PASTE_CHARACTER_THRESHOLD = 4_000;
export const COMPOSER_LONG_PASTE_ATTRIBUTE_LIMIT = 2_000_000;
export const COMPOSER_PASTED_TEXT_NODE_TYPE = "composerPastedText";
export const COMPOSER_ROUTE_REFERENCE_NODE_TYPE = "composerRouteReference";

export type ComposerPasteSegment =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "session";
      readonly href: string;
      readonly label: string | null;
      readonly sessionId: string;
      readonly messageId?: string;
      readonly eventId?: string;
    }
  | {
      readonly kind: "project";
      readonly href: string;
      readonly label: string | null;
      readonly projectId: string;
    }
  | { readonly kind: "path"; readonly path: string };

export type ComposerRouteReference =
  | {
      readonly kind: "session";
      readonly sessionId: string;
      readonly messageId?: string;
      readonly eventId?: string;
    }
  | { readonly kind: "project"; readonly projectId: string };

export interface SegmentComposerPasteOptions {
  readonly workingDirectory?: string | null;
}

const TRAILING_LINK_PUNCTUATION = /[.,;:!?]+$/u;
const ROUTE_LINK = /(?:(?:joko:\/\/app[^\s"'<>]*?|https?:\/\/[^\s"'<>]*?)#\/(?:tasks|projects)\/[^\s"'<>]+|#\/(?:tasks|projects)\/[^\s"'<>]+)/giu;
const PATH_CANDIDATE = /(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>|\u2000-\u206f\u3000-\u303f\ufe30-\ufe4f\uff00-\uffef]+/gu;

export function isComposerLongPaste(text: string): boolean {
  if (text.length > COMPOSER_LONG_PASTE_ATTRIBUTE_LIMIT) return false;
  if (text.length >= COMPOSER_LONG_PASTE_CHARACTER_THRESHOLD) return true;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 && ++lines >= COMPOSER_LONG_PASTE_LINE_THRESHOLD) return true;
  }
  return false;
}

export function countComposerPasteLines(text: string): number {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

/** Keep atom payloads in the editor's HTML representation on copy/paste round trips. */
export function htmlCarriesComposerAtomMarkup(html: string): boolean {
  return /data-(?:composer-(?:quote|pasted-text|mention|quick-start)|mention-chip|pasted-text-chip)/u.test(html);
}

export function segmentComposerPaste(
  text: string,
  options: SegmentComposerPasteOptions = {}
): readonly ComposerPasteSegment[] | null {
  const linked = segmentRouteLinks(text);
  let segments: readonly ComposerPasteSegment[] = linked ?? [{ kind: "text", text }];
  let transformed = linked !== null;
  const workingDirectory = options.workingDirectory?.trim().replace(/[\\/]+$/u, "") ?? "";
  if (workingDirectory !== "" && textMayContainWorkingDirectory(text, workingDirectory)) {
    const expanded: ComposerPasteSegment[] = [];
    for (const segment of segments) {
      if (segment.kind !== "text") {
        expanded.push(segment);
        continue;
      }
      const paths = segmentPathCandidates(segment.text, workingDirectory);
      if (paths === null) expanded.push(segment);
      else {
        transformed = true;
        expanded.push(...paths);
      }
    }
    segments = expanded;
  }
  return transformed ? segments : null;
}

export function parseComposerRouteReference(href: string): ComposerRouteReference | undefined {
  const hashAt = href.indexOf("#");
  const hash = hashAt >= 0 ? href.slice(hashAt) : href.startsWith("#") ? href : "";
  const match = /^#\/(tasks|projects)\/([^/?#]+)(?:\?([^#]*))?$/u.exec(hash);
  if (match === null) return undefined;
  const identity = safeDecodeIdentity(match[2] ?? "");
  if (identity === undefined) return undefined;
  if (match[1] === "projects") return { kind: "project", projectId: identity };
  const query = new URLSearchParams(match[3] ?? "");
  const messageId = boundedQueryIdentity(query.get("message"));
  const eventId = boundedQueryIdentity(query.get("event"));
  return {
    kind: "session",
    sessionId: identity,
    ...(messageId === undefined ? {} : { messageId }),
    ...(eventId === undefined ? {} : { eventId })
  };
}

export function trimComposerPathCandidate(raw: string): string {
  let value = raw;
  for (;;) {
    const next = value
      .replace(TRAILING_LINK_PUNCTUATION, "")
      .replace(/[)\]}]+$/u, "")
      .replace(/(?::\d+){1,2}$/u, "")
      .replace(/[\\/]+$/u, "");
    if (next === value) return value;
    value = next;
  }
}

export function composerPathRelativeToWorkingDirectory(candidate: string, workingDirectory: string): string {
  const base = workingDirectory.replace(/[\\/]+$/u, "");
  return candidate.slice(base.length + 1).replace(/\\/gu, "/");
}

export function sanitizeComposerReferenceLabel(value: string): string {
  return value
    .replace(/\\([\[\]])/gu, "$1")
    .replace(/[\[\]]/gu, " ")
    .replace(/@/gu, "＠")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
}

export function serializeComposerRouteReference(segment: Extract<ComposerPasteSegment, { readonly kind: "session" | "project" }>): string {
  const label = segment.label === null ? "" : sanitizeComposerReferenceLabel(segment.label);
  return label === "" ? segment.href : `[${label}](${segment.href})`;
}

interface LinkCandidate {
  readonly start: number;
  readonly end: number;
  readonly segment: Extract<ComposerPasteSegment, { readonly kind: "session" | "project" }>;
}

function segmentRouteLinks(text: string): readonly ComposerPasteSegment[] | null {
  if (!text.includes("#/tasks/") && !text.includes("#/projects/")) return null;
  const candidates: LinkCandidate[] = [];
  ROUTE_LINK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ROUTE_LINK.exec(text)) !== null) {
    let href = trimBareRouteHref(match[0]);
    const reference = parseComposerRouteReference(href);
    if (reference === undefined) continue;
    const markdown = markdownEnvelope(text, match.index, match.index + href.length);
    const start = markdown?.start ?? match.index;
    const end = markdown?.end ?? match.index + href.length;
    if (markdown !== undefined) href = text.slice(match.index, match.index + href.length);
    candidates.push({
      start,
      end,
      segment: reference.kind === "session"
        ? {
            kind: "session",
            href,
            label: markdown?.label ?? null,
            sessionId: reference.sessionId,
            ...(reference.messageId === undefined ? {} : { messageId: reference.messageId }),
            ...(reference.eventId === undefined ? {} : { eventId: reference.eventId })
          }
        : { kind: "project", href, label: markdown?.label ?? null, projectId: reference.projectId }
    });
    ROUTE_LINK.lastIndex = match.index + href.length;
  }
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => left.start - right.start || right.end - left.end);
  const result: ComposerPasteSegment[] = [];
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.start < cursor) continue;
    if (candidate.start > cursor) result.push({ kind: "text", text: text.slice(cursor, candidate.start) });
    result.push(candidate.segment);
    cursor = candidate.end;
  }
  if (cursor < text.length) result.push({ kind: "text", text: text.slice(cursor) });
  return result;
}

function trimBareRouteHref(raw: string): string {
  let value = raw;
  for (;;) {
    const next = value.replace(TRAILING_LINK_PUNCTUATION, "").replace(/[)\]}]+$/u, "");
    if (next === value) return value;
    value = next;
  }
}

function markdownEnvelope(text: string, hrefStart: number, hrefEnd: number): { readonly start: number; readonly end: number; readonly label: string | null } | undefined {
  if (hrefStart < 2 || text.slice(hrefStart - 2, hrefStart) !== "](") return undefined;
  if (text[hrefEnd] !== ")") return undefined;
  const open = findMarkdownLabelStart(text, hrefStart - 2);
  if (open < 0) return undefined;
  const raw = text.slice(open + 1, hrefStart - 2).trim();
  const label = unescapeMarkdownBrackets(raw);
  return { start: open, end: hrefEnd + 1, label: label !== "" && label !== text.slice(hrefStart, hrefEnd) ? label : null };
}

function findMarkdownLabelStart(text: string, closeBracket: number): number {
  let depth = 0;
  for (let index = closeBracket - 1; index >= 0; index -= 1) {
    const character = text[index];
    if ((character === "[" || character === "]") && isEscaped(text, index)) continue;
    if (character === "]") depth += 1;
    else if (character === "[") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

function unescapeMarkdownBrackets(value: string): string {
  return value.replace(/\\([\[\]])/gu, "$1").trim();
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function segmentPathCandidates(text: string, workingDirectory: string): readonly ComposerPasteSegment[] | null {
  PATH_CANDIDATE.lastIndex = 0;
  const result: ComposerPasteSegment[] = [];
  let cursor = 0;
  let transformed = false;
  let match: RegExpExecArray | null;
  while ((match = PATH_CANDIDATE.exec(text)) !== null) {
    const path = trimComposerPathCandidate(match[0]);
    if (path === "" || !pathWithinWorkingDirectory(path, workingDirectory)) continue;
    if (match.index > cursor) result.push({ kind: "text", text: text.slice(cursor, match.index) });
    result.push({ kind: "path", path });
    transformed = true;
    cursor = match.index + path.length;
    PATH_CANDIDATE.lastIndex = cursor;
  }
  if (!transformed) return null;
  if (cursor < text.length) result.push({ kind: "text", text: text.slice(cursor) });
  return result;
}

function textMayContainWorkingDirectory(text: string, workingDirectory: string): boolean {
  if (/^[A-Za-z]:[\\/]/u.test(workingDirectory)) {
    return normalizeWindowsPath(text).includes(normalizeWindowsPath(workingDirectory));
  }
  return text.includes(workingDirectory);
}

function pathWithinWorkingDirectory(candidate: string, workingDirectory: string): boolean {
  const windows = /^[A-Za-z]:[\\/]/u.test(workingDirectory);
  const value = windows ? normalizeWindowsPath(candidate) : candidate;
  const base = (windows ? normalizeWindowsPath(workingDirectory) : workingDirectory).replace(/[\\/]+$/u, "");
  if (!value.startsWith(base)) return false;
  const separator = value[base.length];
  return separator === "/" || separator === "\\";
}

function normalizeWindowsPath(value: string): string {
  return value.toLocaleLowerCase().replace(/\\/gu, "/");
}

function safeDecodeIdentity(value: string): string | undefined {
  try {
    return boundedIdentity(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

function boundedQueryIdentity(value: string | null): string | undefined {
  return value === null ? undefined : boundedIdentity(value);
}

function boundedIdentity(value: string): string | undefined {
  return value !== "" && value.length <= 1_024 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
}
