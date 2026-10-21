/** Public media never carries a node credential or user-supplied authentication. */
export function richMediaNetworkUrl(source: string): string | undefined {
  if (source.length > 4096 || /[\u0000-\u0020\u007f]/u.test(source)) return undefined;
  try {
    const url = new URL(source);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

/** Convert only files inside the current Workspace; the host still authorizes the read. */
export function richMediaWorkspacePath(source: string, workdir: string): string | undefined {
  if (!source || source.length > 4096 || /[\u0000-\u001f\u007f]/u.test(source)) return undefined;
  let value = source;
  if (/^file:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== "localhost" || url.username || url.password || url.search || url.hash) return undefined;
      value = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:[\\/])/u, "$1");
    } catch { return undefined; }
  } else {
    if (/^[a-z][\w+.-]*:/iu.test(value) && !/^[A-Za-z]:[\\/]/u.test(value)) return undefined;
    try { value = decodeURIComponent(value); } catch { return undefined; }
  }
  const windows = /^[A-Za-z]:[\\/]/u.test(workdir);
  const normalize = (path: string) => windows ? path.replace(/\\/gu, "/") : path;
  const base = normalize(workdir).replace(/\/+$/u, "");
  value = normalize(value);
  if (/^\/|^[A-Za-z]:\//u.test(value)) {
    const folded = windows ? value.toLowerCase() : value;
    const root = windows ? base.toLowerCase() : base;
    if (!folded.startsWith(root + "/")) return undefined;
    value = value.slice(base.length + 1);
  }
  const segments: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!segments.length) return undefined; segments.pop(); }
    else if (/[\u0000-\u001f\u007f]/u.test(part) || windows && /[:\\]/u.test(part)) return undefined;
    else segments.push(part);
  }
  return segments.length ? segments.join("/") : undefined;
}
