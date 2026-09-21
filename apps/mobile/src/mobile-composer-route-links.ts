import { canonicalWorkspacePath } from "./workspace-files";

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
    }
  | {
      readonly kind: "route-reference";
      readonly routeKind: "path";
      readonly workspaceId: string;
      readonly relativePath: string;
      readonly directory: boolean;
      readonly serialized: string;
      readonly displayText: string;
    };

export interface MobileComposerWorkspacePathCandidate {
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly comparisonKey: string;
}

export interface MobileComposerWorkspacePathResolution {
  readonly candidateRelativePath: string;
  readonly relativePath: string;
  readonly directory: boolean;
}

export interface MobileComposerRoutePasteOptions {
  readonly workspacePath?: {
    readonly workspaceId: string;
    readonly serverPathDisplay: string;
    readonly resolutions: readonly MobileComposerWorkspacePathResolution[];
  };
}

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

export type MobileComposerSeededRouteReference =
  | (MobileComposerParsedRouteReference & {
      readonly serialized: string;
      readonly displayText: string;
      readonly pending: boolean;
    })
  | {
      readonly routeKind: "path";
      readonly workspaceId: string;
      readonly relativePath: string;
      readonly directory: boolean;
      readonly serialized: string;
      readonly displayText: string;
      readonly pending: false;
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
const pathCandidate = /(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>|\u2000-\u206f\u3000-\u303f\ufe30-\ufe4f\uff00-\uffef]+/gu;
const sensitiveQueryKey = /(?:auth|credential|password|secret|token|api[-_]?key|code)/iu;
const controls = /[\u0000-\u001f\u007f]/u;

export function segmentMobileComposerRoutePaste(
  text: string,
  options: MobileComposerRoutePasteOptions = {}
): readonly MobileComposerRoutePasteSegment[] | null {
  if (typeof text !== "string") return null;
  const linked = segmentMobileComposerRouteLinks(text);
  let segments: readonly MobileComposerRoutePasteSegment[] = linked ?? [{ kind: "text", text }];
  let transformed = linked !== null;
  const workspace = options.workspacePath;
  if (workspace !== undefined) {
    const root = parseWorkspaceRoot(workspace.serverPathDisplay);
    if (root !== undefined) {
      const resolutions = workspacePathResolutionMap(root, workspace.resolutions);
      const expanded: MobileComposerRoutePasteSegment[] = [];
      for (const segment of segments) {
        if (segment.kind !== "text") {
          expanded.push(segment);
          continue;
        }
        const resolved = segmentResolvedWorkspacePaths(segment.text, root, workspace.workspaceId, resolutions);
        if (resolved === null) expanded.push(segment);
        else {
          transformed = true;
          expanded.push(...resolved);
        }
      }
      segments = expanded;
    }
  }
  return transformed ? segments : null;
}

export function findMobileComposerWorkspacePathCandidates(
  text: string,
  serverPathDisplay: string
): readonly MobileComposerWorkspacePathCandidate[] {
  if (typeof text !== "string") return [];
  const root = parseWorkspaceRoot(serverPathDisplay);
  if (root === undefined) return [];
  const linked = segmentMobileComposerRouteLinks(text) ?? [{ kind: "text" as const, text }];
  return linked.flatMap((segment) => segment.kind === "text"
    ? workspacePathCandidates(segment.text, root).map(({ sourcePath, relativePath }) => ({
        sourcePath,
        relativePath,
        comparisonKey: workspacePathComparisonKey(relativePath, root.windows)
      }))
    : []);
}

export function trimMobileComposerWorkspacePathCandidate(raw: string): string {
  let value = raw;
  for (;;) {
    const next = value
      .replace(trailingLinkPunctuation, "")
      .replace(/[)\]}]+$/u, "")
      .replace(/(?::\d+){1,2}$/u, "")
      .replace(/[\\/]+$/u, "");
    if (next === value) return value;
    value = next;
  }
}

export function mobileComposerWorkspacePathComparisonKey(
  relativePath: string,
  serverPathDisplay: string
): string | undefined {
  const root = parseWorkspaceRoot(serverPathDisplay);
  if (root === undefined) return undefined;
  let canonical: string;
  try { canonical = canonicalWorkspacePath(relativePath); }
  catch { return undefined; }
  return workspacePathComparisonKey(canonical, root.windows);
}

export function mobileComposerWorkspacePathRootSupported(serverPathDisplay: string): boolean {
  return parseWorkspaceRoot(serverPathDisplay) !== undefined;
}

function segmentMobileComposerRouteLinks(text: string): readonly MobileComposerRoutePasteSegment[] | null {
  if (!text.includes("#/tasks/") && !text.includes("#/projects/")) return null;
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

interface ParsedWorkspaceRoot {
  readonly normalized: string;
  readonly sourceLength: number;
  readonly windows: boolean;
}

interface ParsedWorkspacePathCandidate {
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly start: number;
  readonly end: number;
}

function parseWorkspaceRoot(value: string): ParsedWorkspaceRoot | undefined {
  if (typeof value !== "string" || value.length === 0
    || value.length > mobileComposerRouteHrefMaximumCharacters || controls.test(value)) return undefined;
  const exact = value.replace(/[\\/]+$/u, "");
  if (/^[A-Za-z]:[\\/]/u.test(value)) {
    const source = exact.replace(/\\/gu, "/");
    const normalized = foldWindowsWorkspacePath(source);
    return normalized === "" ? undefined : { normalized, sourceLength: source.length, windows: true };
  }
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;
  const normalized = exact === "" ? "/" : exact;
  return { normalized, sourceLength: normalized.length, windows: false };
}

function workspacePathCandidates(text: string, root: ParsedWorkspaceRoot): readonly ParsedWorkspacePathCandidate[] {
  const result: ParsedWorkspacePathCandidate[] = [];
  pathCandidate.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pathCandidate.exec(text)) !== null) {
    const sourcePath = trimMobileComposerWorkspacePathCandidate(match[0]);
    if (sourcePath === "") continue;
    const relativePath = relativeWorkspacePath(sourcePath, root);
    if (relativePath === undefined) continue;
    result.push({
      sourcePath,
      relativePath,
      start: match.index,
      end: match.index + sourcePath.length
    });
    pathCandidate.lastIndex = match.index + sourcePath.length;
  }
  return result;
}

function relativeWorkspacePath(value: string, root: ParsedWorkspaceRoot): string | undefined {
  const normalized = root.windows ? foldWindowsWorkspacePath(value.replace(/\\/gu, "/")) : value;
  const boundary = root.normalized === "/" ? "/" : `${root.normalized}/`;
  if (!normalized.startsWith(boundary)) return undefined;
  const original = value.replace(/\\/gu, "/");
  const offset = root.normalized === "/" ? 1 : root.sourceLength + 1;
  const relative = original.slice(offset);
  try { return canonicalWorkspacePath(relative); }
  catch { return undefined; }
}

function workspacePathComparisonKey(relativePath: string, windows: boolean): string {
  return windows ? foldWindowsWorkspacePath(relativePath) : relativePath;
}

function foldWindowsWorkspacePath(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function workspacePathResolutionMap(
  root: ParsedWorkspaceRoot,
  values: readonly MobileComposerWorkspacePathResolution[]
): ReadonlyMap<string, MobileComposerWorkspacePathResolution> {
  const result = new Map<string, MobileComposerWorkspacePathResolution>();
  for (const value of values) {
    let candidate: string;
    let relative: string;
    try {
      candidate = canonicalWorkspacePath(value.candidateRelativePath);
      relative = canonicalWorkspacePath(value.relativePath);
    } catch { continue; }
    const key = workspacePathComparisonKey(candidate, root.windows);
    if (workspacePathComparisonKey(relative, root.windows) !== key || result.has(key)) continue;
    result.set(key, { candidateRelativePath: candidate, relativePath: relative, directory: value.directory });
  }
  return result;
}

function segmentResolvedWorkspacePaths(
  text: string,
  root: ParsedWorkspaceRoot,
  workspaceId: string,
  resolutions: ReadonlyMap<string, MobileComposerWorkspacePathResolution>
): readonly MobileComposerRoutePasteSegment[] | null {
  const result: MobileComposerRoutePasteSegment[] = [];
  let cursor = 0;
  let transformed = false;
  for (const candidate of workspacePathCandidates(text, root)) {
    const resolution = resolutions.get(workspacePathComparisonKey(candidate.relativePath, root.windows));
    if (resolution === undefined) continue;
    if (candidate.start > cursor) result.push({ kind: "text", text: text.slice(cursor, candidate.start) });
    result.push({
      kind: "route-reference",
      routeKind: "path",
      workspaceId,
      relativePath: resolution.relativePath,
      directory: resolution.directory,
      serialized: `@${resolution.relativePath}`,
      displayText: resolution.relativePath
    });
    transformed = true;
    cursor = candidate.end;
  }
  if (!transformed) return null;
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
  if (segment.routeKind === "path") {
    const workspaceId = boundedIdentity(segment.workspaceId);
    let relativePath: string;
    try { relativePath = canonicalWorkspacePath(segment.relativePath); }
    catch { throw new Error("The pasted Workspace path changed while it was being inserted."); }
    if (workspaceId === undefined || relativePath !== segment.relativePath
      || segment.serialized !== `@${relativePath}` || segment.displayText !== relativePath
      || typeof segment.directory !== "boolean") {
      throw new Error("The pasted Workspace path changed while it was being inserted.");
    }
    return {
      routeKind: "path",
      workspaceId,
      relativePath,
      directory: segment.directory,
      serialized: segment.serialized,
      displayText: segment.displayText,
      pending: false
    };
  }
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
