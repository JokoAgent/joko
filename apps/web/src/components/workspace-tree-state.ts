export const WORKSPACE_ENTRY_DRAG_MIME = "application/x-joko-workspace-entry+json";
export const WORKSPACE_EXPANDED_STORAGE_KEY = "joko.workspaceFiles.expanded.v1";
export const WORKSPACE_FILTER_RESULT_LIMIT = 200;

const MAXIMUM_WORKSPACES = 100;
const MAXIMUM_EXPANDED_PATHS = 200;
const MAXIMUM_PATH_BYTES = 4_096;
const MAXIMUM_BASENAME_BYTES = 255;

export interface WorkspaceFilesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WorkspaceFilesEntryView {
  readonly path: string;
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly size?: number;
  readonly modifiedAt?: number;
  readonly revision?: string;
  readonly status?: string;
  readonly generated?: boolean;
}

export interface WorkspaceDirectoryView {
  readonly status: "idle" | "loading" | "loaded" | "error";
  readonly entries: readonly WorkspaceFilesEntryView[];
  readonly error?: string;
}

export interface WorkspaceVisibleTreeRow {
  readonly entry: WorkspaceFilesEntryView;
  readonly depth: number;
  readonly parentPath: string;
}

export interface WorkspaceFilesTextRange {
  readonly startByte: number;
  readonly endByte: number;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface WorkspaceFilesSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly preview: string;
  readonly submatches: readonly WorkspaceFilesSearchSubmatch[];
  readonly range: WorkspaceFilesTextRange;
  readonly revision: string;
  /** Continuation token used to obtain the page containing this match. */
  readonly pageToken?: string;
}

export interface WorkspaceFilesSearchSubmatch {
  readonly startByte: number;
  readonly endByte: number;
}

export interface WorkspaceFilesSearchGroup {
  readonly path: string;
  readonly matches: readonly WorkspaceFilesSearchMatch[];
}

export interface WorkspaceEntryDragPayload {
  readonly version: 1;
  readonly workspaceId: string;
  readonly kind: "file" | "directory";
  readonly path: string;
  readonly name: string;
}

export interface WorkspaceTreeKeyboardAction {
  readonly focusPath?: string;
  readonly togglePath?: string;
  readonly selectPath?: string;
}

interface PersistedExpandedWorkspace {
  readonly workspaceId: string;
  readonly paths: readonly string[];
}

interface PersistedExpandedBag {
  readonly version: 1;
  readonly workspaces: readonly PersistedExpandedWorkspace[];
}

export function canonicalWorkspaceRelativePath(value: string, allowRoot = false): string {
  if (typeof value !== "string" || value === "") {
    if (allowRoot && value === "") return "";
    throw new TypeError("Workspace path must be a non-empty canonical relative path.");
  }
  if (
    utf8Length(value) > MAXIMUM_PATH_BYTES
    || value.startsWith("/")
    || /^[a-z]:/iu.test(value)
    || value.includes("\\")
    || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) {
    throw new TypeError("Workspace path must be a canonical relative path.");
  }
  const parts = value.split("/");
  if (parts.some((part) => (
    part === ""
    || part === "."
    || part === ".."
    || part.endsWith(".")
    || part.endsWith(" ")
    || /[:*?"<>|]/u.test(part)
  ))) {
    throw new TypeError("Workspace path must be a canonical relative path.");
  }
  return value;
}

export function canonicalWorkspaceBasename(value: string): string {
  const name = canonicalWorkspaceRelativePath(value);
  if (name.includes("/") || utf8Length(name) > MAXIMUM_BASENAME_BYTES) {
    throw new TypeError("Workspace entry name must be one canonical path segment.");
  }
  return name;
}

export function workspacePathParent(path: string): string {
  const canonical = canonicalWorkspaceRelativePath(path);
  const slash = canonical.lastIndexOf("/");
  return slash < 0 ? "" : canonical.slice(0, slash);
}

export function workspacePathBasename(path: string): string {
  const canonical = canonicalWorkspaceRelativePath(path);
  return canonical.slice(canonical.lastIndexOf("/") + 1);
}

export function joinWorkspacePath(parentPath: string, name: string): string {
  const parent = canonicalWorkspaceRelativePath(parentPath, true);
  const basename = canonicalWorkspaceBasename(name);
  return parent === "" ? basename : `${parent}/${basename}`;
}

export function workspacePathAncestors(path: string): readonly string[] {
  const canonical = canonicalWorkspaceRelativePath(path);
  const parts = canonical.split("/");
  const ancestors: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    ancestors.push(parts.slice(0, index).join("/"));
  }
  return ancestors;
}

export function normalizeWorkspaceDirectoryEntries(
  parentPath: string,
  values: readonly WorkspaceFilesEntryView[]
): readonly WorkspaceFilesEntryView[] {
  const parent = canonicalWorkspaceRelativePath(parentPath, true);
  if (!Array.isArray(values)) throw new TypeError("Workspace directory response must be an array.");
  const seen = new Set<string>();
  const entries = values.map((value) => {
    if (typeof value !== "object" || value === null) throw new TypeError("Workspace directory entry is invalid.");
    const path = canonicalWorkspaceRelativePath(value.path);
    const name = canonicalWorkspaceBasename(value.name);
    if (workspacePathParent(path) !== parent || workspacePathBasename(path) !== name) {
      throw new TypeError("Workspace directory entry is outside its requested parent.");
    }
    if (value.kind !== "file" && value.kind !== "directory") throw new TypeError("Workspace directory entry kind is invalid.");
    if (seen.has(path)) throw new TypeError("Workspace directory response contains duplicate paths.");
    seen.add(path);
    if (value.size !== undefined && (!Number.isSafeInteger(value.size) || value.size < 0)) {
      throw new TypeError("Workspace directory entry size is invalid.");
    }
    if (value.modifiedAt !== undefined && !Number.isFinite(value.modifiedAt)) {
      throw new TypeError("Workspace directory entry modifiedAt is invalid.");
    }
    const revision = optionalBoundedText(value.revision, 1_024, "revision");
    const status = optionalBoundedText(value.status, 128, "status");
    return {
      path,
      name,
      kind: value.kind,
      ...(value.size === undefined ? {} : { size: value.size }),
      ...(value.modifiedAt === undefined ? {} : { modifiedAt: value.modifiedAt }),
      ...(revision === undefined ? {} : { revision }),
      ...(status === undefined ? {} : { status }),
      ...(value.generated === undefined ? {} : { generated: value.generated === true })
    } satisfies WorkspaceFilesEntryView;
  });
  return entries.sort(compareWorkspaceEntries);
}

export function flattenWorkspaceTree(
  directories: ReadonlyMap<string, WorkspaceDirectoryView>,
  expanded: ReadonlySet<string>
): readonly WorkspaceVisibleTreeRow[] {
  const rows: WorkspaceVisibleTreeRow[] = [];
  const visit = (parentPath: string, depth: number): void => {
    const directory = directories.get(parentPath);
    if (directory === undefined) return;
    for (const entry of directory.entries) {
      rows.push({ entry, depth, parentPath });
      if (entry.kind === "directory" && expanded.has(entry.path)) visit(entry.path, depth + 1);
    }
  };
  visit("", 0);
  return rows;
}

export function resolveWorkspaceTreeKeyboardAction(
  rows: readonly WorkspaceVisibleTreeRow[],
  currentPath: string | undefined,
  key: string,
  expanded: ReadonlySet<string>
): WorkspaceTreeKeyboardAction | undefined {
  if (rows.length === 0) return undefined;
  const currentIndex = Math.max(0, rows.findIndex((row) => row.entry.path === currentPath));
  const current = rows[currentIndex] ?? rows[0];
  if (current === undefined) return undefined;
  if (key === "ArrowDown") return { focusPath: rows[Math.min(rows.length - 1, currentIndex + 1)]?.entry.path };
  if (key === "ArrowUp") return { focusPath: rows[Math.max(0, currentIndex - 1)]?.entry.path };
  if (key === "Home") return { focusPath: rows[0]?.entry.path };
  if (key === "End") return { focusPath: rows.at(-1)?.entry.path };
  if (key === "ArrowRight" && current.entry.kind === "directory") {
    if (!expanded.has(current.entry.path)) return { togglePath: current.entry.path, focusPath: current.entry.path };
    const child = rows[currentIndex + 1];
    return child !== undefined && child.depth > current.depth ? { focusPath: child.entry.path } : undefined;
  }
  if (key === "ArrowLeft") {
    if (current.entry.kind === "directory" && expanded.has(current.entry.path)) {
      return { togglePath: current.entry.path, focusPath: current.entry.path };
    }
    return current.parentPath === "" ? undefined : { focusPath: current.parentPath };
  }
  if (key === "Enter" || key === " ") {
    return current.entry.kind === "directory"
      ? { togglePath: current.entry.path, focusPath: current.entry.path }
      : { selectPath: current.entry.path, focusPath: current.entry.path };
  }
  return undefined;
}

export function normalizeWorkspaceFileIndex(paths: readonly string[]): readonly string[] {
  if (!Array.isArray(paths)) throw new TypeError("Workspace file index must be an array.");
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of paths) {
    const path = canonicalWorkspaceRelativePath(value);
    if (seen.has(path)) continue;
    seen.add(path);
    normalized.push(path);
  }
  return normalized;
}

export function filterWorkspaceFiles(
  query: string,
  paths: readonly string[],
  limit = WORKSPACE_FILTER_RESULT_LIMIT
): readonly string[] {
  const normalizedLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : WORKSPACE_FILTER_RESULT_LIMIT;
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [];
  const basenameMatches: string[] = [];
  const pathMatches: string[] = [];
  for (const path of paths) {
    const canonical = canonicalWorkspaceRelativePath(path);
    const lower = canonical.toLocaleLowerCase();
    if (!lower.includes(needle)) continue;
    const basename = lower.slice(lower.lastIndexOf("/") + 1);
    (basename.includes(needle) ? basenameMatches : pathMatches).push(canonical);
    if (basenameMatches.length + pathMatches.length >= normalizedLimit) break;
  }
  return [...basenameMatches, ...pathMatches];
}

export function groupWorkspaceSearchMatches(
  matches: readonly WorkspaceFilesSearchMatch[]
): readonly WorkspaceFilesSearchGroup[] {
  const grouped = new Map<string, WorkspaceFilesSearchMatch[]>();
  for (const match of matches) {
    const path = canonicalWorkspaceRelativePath(match.path);
    const values = grouped.get(path) ?? [];
    values.push(match);
    grouped.set(path, values);
  }
  return [...grouped].map(([path, values]) => ({ path, matches: values }));
}

export function workspaceSearchMatchIdentity(match: WorkspaceFilesSearchMatch): string {
  return `${match.path}\0${match.line}\0${match.range.startByte}\0${match.range.endByte}\0${workspaceSearchSubmatchIdentity(match.submatches)}\0${match.revision}`;
}

function workspaceSearchSubmatchIdentity(values: readonly WorkspaceFilesSearchSubmatch[]): string {
  return values.map(({ startByte, endByte }) => `${startByte}:${endByte}`).join(",");
}

export function createWorkspaceEntryDragPayload(
  workspaceId: string,
  entry: WorkspaceFilesEntryView
): WorkspaceEntryDragPayload {
  const safeWorkspaceId = canonicalWorkspaceId(workspaceId);
  const path = canonicalWorkspaceRelativePath(entry.path);
  const name = canonicalWorkspaceBasename(entry.name);
  if (workspacePathBasename(path) !== name) throw new TypeError("Workspace drag entry name does not match its path.");
  if (entry.kind !== "file" && entry.kind !== "directory") throw new TypeError("Workspace drag entry kind is invalid.");
  return { version: 1, workspaceId: safeWorkspaceId, kind: entry.kind, path, name };
}

export function encodeWorkspaceEntryDragPayload(payload: WorkspaceEntryDragPayload): string {
  return JSON.stringify(createWorkspaceEntryDragPayload(payload.workspaceId, {
    path: payload.path,
    name: payload.name,
    kind: payload.kind
  }));
}

/** Decode only the bounded, canonical payload emitted by the workspace tree. */
export function decodeWorkspaceEntryDragPayload(raw: string): WorkspaceEntryDragPayload | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAXIMUM_PATH_BYTES * 2) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Partial<WorkspaceEntryDragPayload>;
    if (
      record.version !== 1
      || typeof record.workspaceId !== "string"
      || (record.kind !== "file" && record.kind !== "directory")
      || typeof record.path !== "string"
      || typeof record.name !== "string"
    ) return undefined;
    return createWorkspaceEntryDragPayload(record.workspaceId, {
      kind: record.kind,
      path: record.path,
      name: record.name
    });
  } catch {
    return undefined;
  }
}

export function loadWorkspaceExpandedPaths(
  workspaceId: string,
  storage: WorkspaceFilesStorage | undefined
): ReadonlySet<string> {
  const safeWorkspaceId = canonicalWorkspaceId(workspaceId);
  const bag = loadExpandedBag(storage);
  const record = bag.workspaces.find((workspace) => workspace.workspaceId === safeWorkspaceId);
  if (record === undefined) return new Set();
  return new Set(record.paths);
}

export function saveWorkspaceExpandedPaths(
  workspaceId: string,
  expanded: ReadonlySet<string>,
  storage: WorkspaceFilesStorage | undefined
): void {
  if (storage === undefined) return;
  const safeWorkspaceId = canonicalWorkspaceId(workspaceId);
  const paths = [...expanded]
    .filter((path) => path !== "")
    .map((path) => canonicalWorkspaceRelativePath(path))
    .slice(0, MAXIMUM_EXPANDED_PATHS);
  const bag = loadExpandedBag(storage);
  const workspaces = bag.workspaces.filter((workspace) => workspace.workspaceId !== safeWorkspaceId);
  if (paths.length > 0) workspaces.push({ workspaceId: safeWorkspaceId, paths });
  const bounded = workspaces.slice(-MAXIMUM_WORKSPACES);
  try {
    storage.setItem(WORKSPACE_EXPANDED_STORAGE_KEY, JSON.stringify({ version: 1, workspaces: bounded } satisfies PersistedExpandedBag));
  } catch {
    // Browser storage can be disabled or full; in-memory expansion still works.
  }
}

export function rewriteWorkspacePathPrefix(
  paths: ReadonlySet<string>,
  oldPath: string,
  newPath: string
): ReadonlySet<string> {
  const oldCanonical = canonicalWorkspaceRelativePath(oldPath);
  const newCanonical = canonicalWorkspaceRelativePath(newPath);
  const rewritten = new Set<string>();
  for (const path of paths) {
    const canonical = canonicalWorkspaceRelativePath(path);
    if (canonical === oldCanonical) rewritten.add(newCanonical);
    else if (canonical.startsWith(`${oldCanonical}/`)) rewritten.add(`${newCanonical}/${canonical.slice(oldCanonical.length + 1)}`);
    else rewritten.add(canonical);
  }
  return rewritten;
}

export function removeWorkspacePathPrefix(paths: ReadonlySet<string>, prefix: string): ReadonlySet<string> {
  const canonicalPrefix = canonicalWorkspaceRelativePath(prefix);
  return new Set([...paths].filter((path) => path !== canonicalPrefix && !path.startsWith(`${canonicalPrefix}/`)));
}

function loadExpandedBag(storage: WorkspaceFilesStorage | undefined): PersistedExpandedBag {
  if (storage === undefined) return { version: 1, workspaces: [] };
  try {
    const raw = storage.getItem(WORKSPACE_EXPANDED_STORAGE_KEY);
    if (raw === null) return { version: 1, workspaces: [] };
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(",") !== "version,workspaces"
      || !("version" in parsed)
      || parsed.version !== 1
      || !("workspaces" in parsed)
      || !Array.isArray(parsed.workspaces)
      || parsed.workspaces.length > MAXIMUM_WORKSPACES
    ) {
      return { version: 1, workspaces: [] };
    }
    const workspaces: PersistedExpandedWorkspace[] = [];
    const seenWorkspaceIds = new Set<string>();
    for (const value of parsed.workspaces) {
      if (
        typeof value !== "object"
        || value === null
        || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== "paths,workspaceId"
        || !("workspaceId" in value)
        || !("paths" in value)
        || !Array.isArray(value.paths)
        || value.paths.length > MAXIMUM_EXPANDED_PATHS
      ) return { version: 1, workspaces: [] };
      try {
        const workspaceId = canonicalWorkspaceId(value.workspaceId);
        if (workspaceId !== value.workspaceId || seenWorkspaceIds.has(workspaceId)) return { version: 1, workspaces: [] };
        const paths: string[] = [];
        const seenPaths = new Set<string>();
        for (const path of value.paths as unknown[]) {
          if (typeof path !== "string" || path === "") return { version: 1, workspaces: [] };
          const canonical = canonicalWorkspaceRelativePath(path);
          if (canonical !== path || seenPaths.has(canonical)) return { version: 1, workspaces: [] };
          paths.push(canonical);
          seenPaths.add(canonical);
        }
        seenWorkspaceIds.add(workspaceId);
        workspaces.push({ workspaceId, paths });
      } catch {
        return { version: 1, workspaces: [] };
      }
    }
    return { version: 1, workspaces };
  } catch {
    return { version: 1, workspaces: [] };
  }
}

function canonicalWorkspaceId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || utf8Length(value) > 512
    || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) {
    throw new TypeError("Workspace id is invalid.");
  }
  return value;
}

function compareWorkspaceEntries(left: WorkspaceFilesEntryView, right: WorkspaceFilesEntryView): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  return left.name.toLocaleLowerCase().localeCompare(right.name.toLocaleLowerCase())
    || left.name.localeCompare(right.name);
}

function optionalBoundedText(value: string | undefined, maximumBytes: number, label: string): string | undefined {
  return value === undefined ? undefined : boundedText(value, maximumBytes, label);
}

function boundedText(value: unknown, maximumBytes: number, label: string): string {
  if (typeof value !== "string" || utf8Length(value) > maximumBytes || /[\0\x7f]/u.test(value)) {
    throw new TypeError(`Workspace ${label} is invalid.`);
  }
  return value;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
