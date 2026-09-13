export interface WorkspaceFilesLocation {
  readonly sessionId: string;
  readonly file?: string;
  readonly search?: string;
  readonly line?: number;
}

/** Document-mode route carried by Joko's shared hash router. */
export function workspaceFilesHash(location: WorkspaceFilesLocation): string {
  const query = new URLSearchParams();
  if (location.file !== undefined && location.file !== "") query.set("file", location.file);
  if (location.search !== undefined && location.search !== "") query.set("search", location.search);
  if (location.line !== undefined && Number.isSafeInteger(location.line) && location.line > 0) {
    query.set("line", String(location.line));
  }
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  return `#/files/${encodeURIComponent(location.sessionId)}${suffix}`;
}

export function parseWorkspaceFilesHash(hash: string): WorkspaceFilesLocation | undefined {
  const normalized = hash.replace(/^#\/?/u, "");
  const queryIndex = normalized.indexOf("?");
  const path = queryIndex < 0 ? normalized : normalized.slice(0, queryIndex);
  const parts = path.split("/").filter(Boolean).map(decodeHashPart);
  if (parts[0] !== "files" || parts[1] === undefined || parts[1] === "") return undefined;
  const query = new URLSearchParams(queryIndex < 0 ? "" : normalized.slice(queryIndex + 1));
  const file = nonEmpty(query.get("file"));
  const search = nonEmpty(query.get("search"));
  const line = parsePositiveLine(query.get("line"));
  return {
    sessionId: parts[1],
    ...(file === undefined ? {} : { file }),
    ...(search === undefined ? {} : { search }),
    ...(line === undefined ? {} : { line })
  };
}

function parsePositiveLine(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function nonEmpty(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

function decodeHashPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

