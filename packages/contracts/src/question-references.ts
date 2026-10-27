export interface QuestionReferencePart {
  readonly text: string;
  readonly href?: string;
}

const FILE_REFERENCE = /^[^?#\n]+\.[A-Za-z0-9]{1,10}(?::[1-9]\d*(?:-[1-9]\d*)?(?::[1-9]\d*)?)?$/u;
const OTHER_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

function isReference(href: string): boolean {
  if (/[<>\u0000-\u001f\u007f]/u.test(href) || href.length > 4_096) return false;
  if (/^https?:\/\//iu.test(href)) {
    try { const url = new URL(href); return !url.username && !url.password; } catch { return false; }
  }
  const drivePath = /^[A-Za-z]:[\\/]/u.test(href);
  const path = href.replace(/:[1-9]\d*(?:-[1-9]\d*)?(?::[1-9]\d*)?$/u, "");
  if (OTHER_SCHEME.test(path) && !drivePath && !href.startsWith("file://")) return false;
  if (/^~[\\/]/u.test(href)) return false;
  return !/[?#\r\n]/u.test(href) && (path.startsWith("/") || drivePath || path.startsWith("file://") || FILE_REFERENCE.test(href));
}

/** Questions remain plain text. A candidate never grants access to its file;
 * clients must use the original task's authorized reference resolver. */
export function splitQuestionReferences(text: string, clipUrl: (url: string, prefix: string) => string = clipQuestionUrl): readonly QuestionReferencePart[] {
  const parts: { text: string; href?: string }[] = [];
  const append = (part: QuestionReferencePart): void => {
    const previous = parts.at(-1);
    if (!part.href && previous && !previous.href) previous.text += part.text;
    else if (part.text) parts.push({ ...part });
  };
  const token = new RegExp([
    /\[([^\]\n]+)\]\((?:<([^>\n]+)>|([^\s()]+(?:\([^\n()]*\)[^\s()]*)?))\)/u.source,
    /`([^`\n]+)`/u.source,
    /https?:\/\/[^\s<>`]+/u.source,
    /(?<![^\s(（【「"'，、;；])[^\s，。！？；：（）【】「」、()"'<>\[\]`]+/u.source
  ].join("|"), "giu");
  let from = 0;
  let unquotedAbsolutePath = false;
  for (const match of text.matchAll(token)) {
    const index = match.index;
    const continuesAbsolutePath: boolean = unquotedAbsolutePath && /^[ \t]+$/u.test(text.slice(from, index));
    unquotedAbsolutePath = false;
    append({ text: text.slice(from, index) });
    const raw = match[0];
    if (match[1] !== undefined) {
      const href = (match[2] ?? match[3]!).trim();
      append(isReference(href) ? { text: match[1], href } : { text: raw });
    } else if (match[4] !== undefined) {
      append(isReference(match[4]) ? { text: match[4], href: match[4] } : { text: raw });
    } else if (/^https?:\/\//iu.test(raw)) {
      const href = clipUrl(raw, text.slice(0, index));
      append(isReference(href) ? { text: href, href } : { text: href });
      append({ text: raw.slice(href.length) });
    } else {
      let end = raw.length;
      while (end > 0 && ".,;!?".includes(raw[end - 1]!)) end--;
      const href = raw.slice(0, end);
      const absolute = href.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(href);
      const hasExtension = FILE_REFERENCE.test(href);
      const spacedPrefix = raw === href && absolute && !hasExtension
        && /^[ \t]+(?![A-Za-z]:[\\/]|\/|file:\/\/)[^\s]*[\\/]/u.test(text.slice(index + raw.length));
      unquotedAbsolutePath = (continuesAbsolutePath || spacedPrefix) && !hasExtension;
      append(isReference(href) && !continuesAbsolutePath && !spacedPrefix ? { text: href, href } : { text: href });
      append({ text: raw.slice(href.length) });
    }
    from = index + raw.length;
  }
  append({ text: text.slice(from) });
  return parts;
}

function clipQuestionUrl(raw: string): string {
  let end = raw.length;
  while (end > 0 && ".,;!?，。！？；：、）】」".includes(raw[end - 1]!)) end--;
  const value = raw.slice(0, end);
  const opens = [...value].filter(char => char === "(").length;
  let closes = [...value].filter(char => char === ")").length;
  while (closes > opens && raw[end - 1] === ")") { end--; closes--; }
  return raw.slice(0, end);
}

/** A lexical hint scoped to the current Workspace. Actual existence, canonical
 * paths and read authority are checked by the ordinary Workspace open flow. */
export function questionWorkspaceReference(raw: string, workspaceRoot?: string): string | undefined {
  if (!isReference(raw) || /^https?:\/\//iu.test(raw)) return undefined;
  const suffix = /:([1-9]\d*)(?:-([1-9]\d*))?(?::([1-9]\d*))?$/u.exec(raw);
  if (suffix && (!Number.isSafeInteger(Number(suffix[1])) || suffix[2] && (!Number.isSafeInteger(Number(suffix[2])) || Number(suffix[2]) < Number(suffix[1]))
    || suffix[3] && !Number.isSafeInteger(Number(suffix[3])))) return undefined;
  let path = suffix ? raw.slice(0, suffix.index) : raw;
  if (path.startsWith("file://")) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost" || url.username || url.password || url.search || url.hash) return undefined;
      path = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:[\\/]/u.test(path)) path = path.slice(1);
    } catch { return undefined; }
  } else {
    try { path = decodeURIComponent(path); } catch { return undefined; }
  }
  const windows = /^[A-Za-z]:[\\/]/u.test(path) || /^[A-Za-z]:[\\/]/u.test(workspaceRoot ?? "");
  if (windows) path = path.replace(/\\/gu, "/");
  if (path.startsWith("/") || /^[A-Za-z]:\//u.test(path)) {
    if (!workspaceRoot) return undefined;
    const root = (windows ? workspaceRoot.replace(/\\/gu, "/") : workspaceRoot).replace(/\/$/u, "");
    const prefix = `${root}/`;
    if (!(windows ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix))) return undefined;
    path = path.slice(prefix.length);
  }
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") { if (!segments.length) return undefined; segments.pop(); }
    else { if (/[\\:\u0000-\u001f\u007f]/u.test(segment)) return undefined; segments.push(segment); }
  }
  if (!segments.length) return undefined;
  return segments.map(encodeURIComponent).join("/") + (suffix ? `:${suffix[1]}${suffix[3] ? `:${suffix[3]}` : ""}` : "");
}
