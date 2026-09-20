export const mobileComposerRouteHrefMaximumCharacters = 4_096;
export const mobileComposerRouteDisplayMaximumCharacters = 240;
export const mobileComposerMessageReferenceTextMaximumCharacters = 12_000;

export type MobileComposerRoutePasteSegment =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "route-reference";
      readonly routeKind: "session";
      readonly href: string;
      readonly label: string | null;
      readonly sessionId: string;
      readonly messageId?: string;
      readonly eventId?: string;
    }
  | {
      readonly kind: "route-reference";
      readonly routeKind: "project";
      readonly href: string;
      readonly label: string | null;
      readonly projectId: string;
    };

export type MobileComposerParsedRouteReference =
  | {
      readonly routeKind: "session";
      readonly href: string;
      readonly sessionId: string;
      readonly messageId?: string;
      readonly eventId?: string;
    }
  | {
      readonly routeKind: "project";
      readonly href: string;
      readonly projectId: string;
    };

export type MobileComposerSeededRouteReference = MobileComposerParsedRouteReference & {
  readonly serialized: string;
  readonly displayText: string;
  readonly pending: boolean;
};

export type MobileComposerRouteResolutionTarget =
  | { readonly kind: "session"; readonly href: string; readonly sessionId: string }
  | {
      readonly kind: "message";
      readonly href: string;
      readonly sessionId: string;
      readonly messageId?: string;
      readonly eventId?: string;
    }
  | { readonly kind: "project"; readonly href: string; readonly projectId: string };

const trailingLinkPunctuation = /[.,;:!?]+$/u;
const routeLink = /(?:(?:joko:\/\/app[^\s"'<>]*?|https?:\/\/[^\s"'<>]*?)#\/(?:tasks|projects)\/[^\s"'<>]+|#\/(?:tasks|projects)\/[^\s"'<>]+)/giu;
const sensitiveQueryKey = /(?:auth|credential|password|secret|token|api[-_]?key|code)/iu;
const controls = /[\u0000-\u001f\u007f]/u;

export function segmentMobileComposerRoutePaste(text: string): readonly MobileComposerRoutePasteSegment[] | null {
  if (typeof text !== "string" || (!text.includes("#/tasks/") && !text.includes("#/projects/"))) return null;
  const candidates: Array<{
    readonly start: number;
    readonly end: number;
    readonly segment: Extract<MobileComposerRoutePasteSegment, { readonly kind: "route-reference" }>;
  }> = [];
  routeLink.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = routeLink.exec(text)) !== null) {
    const rawHref = trimBareRouteHref(match[0]);
    const reference = parseMobileComposerRouteHref(rawHref);
    if (reference === undefined) continue;
    const rawEnd = match.index + rawHref.length;
    const markdown = markdownEnvelope(text, match.index, rawEnd);
    const segment: Extract<MobileComposerRoutePasteSegment, { readonly kind: "route-reference" }> = reference.routeKind === "session"
      ? {
          kind: "route-reference",
          routeKind: "session",
          href: reference.href,
          label: markdown?.label ?? null,
          sessionId: reference.sessionId,
          ...(reference.messageId === undefined ? {} : { messageId: reference.messageId }),
          ...(reference.eventId === undefined ? {} : { eventId: reference.eventId })
        }
      : {
          kind: "route-reference",
          routeKind: "project",
          href: reference.href,
          label: markdown?.label ?? null,
          projectId: reference.projectId
        };
    candidates.push({
      start: markdown?.start ?? match.index,
      end: markdown?.end ?? rawEnd,
      segment
    });
    routeLink.lastIndex = rawEnd;
  }
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => left.start - right.start || right.end - left.end);
  const result: MobileComposerRoutePasteSegment[] = [];
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

export function parseMobileComposerRouteHref(value: string): MobileComposerParsedRouteReference | undefined {
  if (typeof value !== "string" || value.length === 0
    || value.length > mobileComposerRouteHrefMaximumCharacters || controls.test(value)) return undefined;
  let base = "";
  let hash = value;
  if (!value.startsWith("#")) {
    let url: URL;
    try { url = new URL(value); }
    catch { return undefined; }
    if (url.protocol !== "https:" && url.protocol !== "http:"
      && !(url.protocol === "joko:" && url.hostname.toLocaleLowerCase() === "app")) return undefined;
    hash = url.hash;
    url.username = "";
    url.password = "";
    const safeBaseQuery = safeQuery(url.searchParams);
    if (safeBaseQuery === undefined) return undefined;
    url.search = safeBaseQuery === "" ? "" : `?${safeBaseQuery}`;
    url.hash = "";
    base = url.toString().replace(/\(/gu, "%28").replace(/\)/gu, "%29");
  }
  const match = /^#\/(tasks|projects)\/([^/?#]+)(?:\?([^#]*))?$/u.exec(hash);
  if (match === null) return undefined;
  const identity = safeDecodeIdentity(match[2] ?? "");
  if (identity === undefined) return undefined;
  const query = new URLSearchParams(match[3] ?? "");
  if (match[1] === "projects" && (query.has("message") || query.has("event"))) return undefined;
  const messageValues = query.getAll("message");
  const eventValues = query.getAll("event");
  if (messageValues.length > 1 || eventValues.length > 1) return undefined;
  const messageId = queryIdentity(messageValues);
  const eventId = queryIdentity(eventValues);
  if (messageValues.length === 1 && messageId === undefined
    || eventValues.length === 1 && eventId === undefined) return undefined;
  const safeRouteQuery = safeQuery(query);
  if (safeRouteQuery === undefined) return undefined;
  const routeKind = match[1] === "projects" ? "project" : "session";
  const route = `#/${routeKind === "project" ? "projects" : "tasks"}/${encodeRouteIdentity(identity)}${safeRouteQuery === "" ? "" : `?${safeRouteQuery}`}`;
  const href = `${base}${route}`;
  if (href.length > mobileComposerRouteHrefMaximumCharacters) return undefined;
  if (routeKind === "project") return { routeKind, href, projectId: identity };
  return {
    routeKind,
    href,
    sessionId: identity,
    ...(messageId === undefined ? {} : { messageId }),
    ...(eventId === undefined ? {} : { eventId })
  };
}

export function seedMobileComposerRouteReference(
  segment: Extract<MobileComposerRoutePasteSegment, { readonly kind: "route-reference" }>
): MobileComposerSeededRouteReference {
  const parsed = parseMobileComposerRouteHref(segment.href);
  if (parsed === undefined || parsed.href !== segment.href || parsed.routeKind !== segment.routeKind
    || (parsed.routeKind === "session" && segment.routeKind === "session"
      ? parsed.sessionId !== segment.sessionId || parsed.messageId !== segment.messageId
        || parsed.eventId !== segment.eventId
      : parsed.routeKind === "project" && segment.routeKind === "project"
        ? parsed.projectId !== segment.projectId
        : true)) {
    throw new Error("The pasted Joko link changed while it was being inserted.");
  }
  const explicit = segment.label === null ? "" : sanitizeMobileComposerReferenceLabel(segment.label);
  if (parsed.routeKind === "project") {
    const displayText = explicit || shortMobileComposerReferenceId(parsed.projectId);
    return {
      ...parsed,
      displayText,
      serialized: explicit === "" ? parsed.href : `[${displayText}](${parsed.href})`,
      pending: explicit === ""
    };
  }
  const anchor = parsed.messageId ?? parsed.eventId;
  if (anchor !== undefined) {
    return {
      ...parsed,
      displayText: shortMobileComposerReferenceId(anchor),
      serialized: parsed.href,
      pending: true
    };
  }
  const displayText = explicit || shortMobileComposerReferenceId(parsed.sessionId);
  return {
    ...parsed,
    displayText,
    serialized: explicit === "" ? parsed.href : `[${displayText}](${parsed.href})`,
    pending: explicit === ""
  };
}

export function mobileComposerRouteResolutionTarget(
  reference: MobileComposerParsedRouteReference
): MobileComposerRouteResolutionTarget {
  if (reference.routeKind === "project") {
    return { kind: "project", href: reference.href, projectId: reference.projectId };
  }
  return reference.messageId === undefined && reference.eventId === undefined
    ? { kind: "session", href: reference.href, sessionId: reference.sessionId }
    : {
        kind: "message",
        href: reference.href,
        sessionId: reference.sessionId,
        ...(reference.messageId === undefined ? {} : { messageId: reference.messageId }),
        ...(reference.eventId === undefined ? {} : { eventId: reference.eventId })
      };
}

export function sanitizeMobileComposerReferenceLabel(value: string): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\\([\[\]])/gu, "$1")
    .replace(/[\[\]]/gu, " ")
    .replace(/@/gu, "＠")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, mobileComposerRouteDisplayMaximumCharacters);
}

export function summarizeMobileComposerMessageReference(value: string): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= mobileComposerRouteDisplayMaximumCharacters) return collapsed;
  return `${collapsed.slice(0, mobileComposerRouteDisplayMaximumCharacters - 1)}…`;
}

export function boundMobileComposerMessageReference(value: string): string {
  return value.trim().slice(0, mobileComposerMessageReferenceTextMaximumCharacters);
}

export function shortMobileComposerReferenceId(value: string): string {
  return value.length <= 13 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function safeQuery(input: URLSearchParams): string | undefined {
  const output = new URLSearchParams();
  for (const [key, value] of input.entries()) {
    if (controls.test(key) || controls.test(value)) return undefined;
    if (!sensitiveQueryKey.test(key)) output.append(key, value);
  }
  return output.toString();
}

function queryIdentity(values: readonly string[]): string | undefined {
  return values.length === 0 ? undefined : boundedIdentity(values[0] ?? "");
}

function safeDecodeIdentity(value: string): string | undefined {
  try { return boundedIdentity(decodeURIComponent(value)); }
  catch { return undefined; }
}

function boundedIdentity(value: string): string | undefined {
  return value !== "" && value.length <= 1_024 && value.trim() === value && !controls.test(value)
    ? value
    : undefined;
}

function encodeRouteIdentity(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function trimBareRouteHref(raw: string): string {
  let value = raw;
  for (;;) {
    const next = value.replace(trailingLinkPunctuation, "").replace(/[)\]}]+$/u, "");
    if (next === value) return value;
    value = next;
  }
}

function markdownEnvelope(
  text: string,
  hrefStart: number,
  hrefEnd: number
): { readonly start: number; readonly end: number; readonly label: string | null } | undefined {
  if (hrefStart < 2 || text.slice(hrefStart - 2, hrefStart) !== "](" || text[hrefEnd] !== ")") return undefined;
  const open = findMarkdownLabelStart(text, hrefStart - 2);
  if (open < 0) return undefined;
  const raw = text.slice(open + 1, hrefStart - 2).trim();
  const label = raw.replace(/\\([\[\]])/gu, "$1").trim();
  return {
    start: open,
    end: hrefEnd + 1,
    label: label !== "" && label !== text.slice(hrefStart, hrefEnd) ? label : null
  };
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

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}
