import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_MAXIMUM_ENTRIES = 1_000;
const DEFAULT_MAXIMUM_TOTAL_ENTRIES = 10_000;
const MAXIMUM_METADATA_BYTES = 2 * 1_024 * 1_024;
const MAXIMUM_PROFILE_STATE_BYTES = 4 * 1_024 * 1_024;
const MAXIMUM_PROJECTLESS_IDS = 50_000;
const MAXIMUM_ROLLOUT_DEPTH = 6;
const SQLITE_BUSY_TIMEOUT_MS = 3_000;
const PROFILE_STATE_FILE = ".codex-global-state.json";
const SESSION_INDEX_FILE = "session_index.jsonl";
const DEFAULT_TASK_TITLE = "Codex Session";

export interface CodexSessionCatalogSummary {
  readonly nativeSessionId: string;
  readonly title?: string;
  readonly workingDirectory?: string;
  readonly projectDirectory?: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
  readonly archived: boolean;
  readonly placement: "project" | "dialogue";
  /** Adapter-private provenance. It is never projected into public contracts. */
  readonly source: CodexCatalogSource;
  /** Every canonical profile in which this native identity was observed. */
  readonly observedProfileKeys: readonly string[];
}

export interface CodexSessionCatalogScanResult {
  readonly summaries: readonly CodexSessionCatalogSummary[];
  readonly rejectedCount: number;
}

export interface CodexSessionCatalogScanOptions {
  readonly profileDirectories?: readonly string[];
  readonly activeProfileDirectory?: string;
  /** Per-profile candidate bound. */
  readonly maximumEntries?: number;
  /** Merged cross-profile candidate bound. */
  readonly maximumTotalEntries?: number;
}

export interface CodexCatalogFileFence {
  readonly relativePath: string;
  readonly size: number;
  readonly modifiedAt: number;
  readonly device: number;
  readonly inode: number;
}

export interface CodexCatalogSource {
  readonly profileDirectory: string;
  readonly profileKey: string;
  readonly databaseFile?: string;
  readonly databaseRowFingerprint?: string;
  readonly rollout?: CodexCatalogFileFence;
  readonly fingerprint: string;
}

interface CatalogProfile {
  readonly directory: string;
  readonly key: string;
  readonly active: boolean;
}

interface RawSummary {
  readonly nativeSessionId: string;
  readonly title?: string;
  readonly workingDirectory?: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
  readonly archived: boolean;
  readonly source: CodexCatalogSource;
}

interface RolloutFile {
  readonly path: string;
  readonly modifiedAt: number;
  readonly size: number;
  readonly device: number;
  readonly inode: number;
  readonly archived: boolean;
}

interface SessionIndexEntry {
  readonly title: string;
  readonly modifiedAt?: number;
}

interface SourceScan {
  readonly summaries: readonly RawSummary[];
  readonly rejectedCount: number;
  readonly observedIds: ReadonlySet<string>;
  readonly archivedIds: ReadonlySet<string>;
}

type RolloutSummaryOutcome =
  | { readonly kind: "accepted"; readonly summary: RawSummary }
  | { readonly kind: "rejected"; readonly nativeSessionId: string }
  | { readonly kind: "error" };

type SqliteValue = bigint | number | string | Uint8Array | null;
type SqliteRow = Readonly<Record<string, SqliteValue>>;

/** Read a local Codex profile without starting its runtime or replaying task history. */
export async function scanCodexSessionCatalog(
  options: CodexSessionCatalogScanOptions = {}
): Promise<CodexSessionCatalogScanResult> {
  const maximumEntries = positiveBound(options.maximumEntries, DEFAULT_MAXIMUM_ENTRIES);
  const maximumTotalEntries = positiveTotalBound(options.maximumTotalEntries, DEFAULT_MAXIMUM_TOTAL_ENTRIES);
  const profiles = await configuredProfiles(options.profileDirectories, options.activeProfileDirectory);
  if (profiles.length === 0) return { summaries: [], rejectedCount: 0 };
  const activeProfileKey = profiles.find((profile) => profile.active)?.key;
  const scans = await Promise.all(profiles.map((profile) =>
    scanProfileCatalog(profile, maximumEntries)));
  const merged = new Map<string, CodexSessionCatalogSummary>();
  let rejectedCount = 0;
  for (const scan of scans) {
    rejectedCount += scan.rejectedCount;
    for (const candidate of scan.summaries) {
      const current = merged.get(candidate.nativeSessionId);
      merged.set(candidate.nativeSessionId, current === undefined
        ? candidate
        : mergeCatalogSummary(current, candidate, activeProfileKey));
    }
  }
  const summaries = [...merged.values()];
  summaries.sort((left, right) => right.modifiedAt - left.modifiedAt
    || left.nativeSessionId.localeCompare(right.nativeSessionId));
  return { summaries: summaries.slice(0, maximumTotalEntries), rejectedCount };
}

async function scanProfileCatalog(
  profile: CatalogProfile,
  maximumEntries: number
): Promise<CodexSessionCatalogScanResult> {
  const [projectlessIds, stateScan, sessionIndex] = await Promise.all([
    readProjectlessThreadIds(profile.directory),
    scanStateDatabase(profile, maximumEntries),
    readSessionIndex(profile.directory)
  ]);
  const rolloutScan = await scanRollouts(
    profile,
    maximumEntries,
    stateScan.observedIds,
    sessionIndex
  );
  const merged = new Map<string, RawSummary>();
  for (const candidate of [...stateScan.summaries, ...rolloutScan.summaries]) {
    const withArchiveState = rolloutScan.archivedIds.has(candidate.nativeSessionId)
      ? { ...candidate, archived: true }
      : candidate;
    const current = merged.get(candidate.nativeSessionId);
    merged.set(candidate.nativeSessionId, current === undefined
      ? withArchiveState
      : mergeSummary(current, withArchiveState));
  }

  const summaries = [...merged.values()].map((candidate): CodexSessionCatalogSummary => {
    const placement = projectlessIds.has(candidate.nativeSessionId) ? "dialogue" : "project";
    const projectDirectory = placement === "project"
      ? projectDirectoryFor(candidate.workingDirectory)
      : undefined;
    return {
      nativeSessionId: candidate.nativeSessionId,
      ...(candidate.title === undefined ? {} : { title: candidate.title }),
      ...(candidate.workingDirectory === undefined ? {} : { workingDirectory: candidate.workingDirectory }),
      ...(projectDirectory === undefined ? {} : { projectDirectory }),
      createdAt: Math.min(candidate.createdAt, candidate.modifiedAt),
      modifiedAt: candidate.modifiedAt,
      archived: candidate.archived,
      placement,
      source: candidate.source,
      observedProfileKeys: [profile.key]
    };
  });
  summaries.sort((left, right) => right.modifiedAt - left.modifiedAt
    || left.nativeSessionId.localeCompare(right.nativeSessionId));
  return {
    summaries,
    rejectedCount: stateScan.rejectedCount + rolloutScan.rejectedCount
  };
}

async function configuredProfiles(
  values: readonly string[] | undefined,
  activeProfileDirectory: string | undefined
): Promise<readonly CatalogProfile[]> {
  const candidates = values === undefined
    ? defaultProfileCandidates(activeProfileDirectory)
    : [activeProfileDirectory, ...values].filter((value): value is string => value !== undefined);
  const profiles = new Map<string, CatalogProfile>();
  const activeResolved = activeProfileDirectory === undefined || !isAbsolute(activeProfileDirectory)
    ? undefined
    : resolve(activeProfileDirectory);
  for (const value of candidates) {
    const configured = value.trim();
    if (!isAbsolute(configured)) continue;
    const resolved = resolve(configured);
    if (isPrivateRuntimeProfile(resolved) && resolved !== activeResolved) continue;
    const canonical = await realpath(resolved).catch(() => undefined);
    if (canonical === undefined || !(await hasCatalogArtifacts(canonical))) continue;
    const pathIdentity = servicePathIdentity(canonical);
    const active = activeResolved !== undefined && servicePathIdentity(resolved) === servicePathIdentity(activeResolved);
    const existing = profiles.get(pathIdentity);
    if (existing === undefined) {
      profiles.set(pathIdentity, {
        directory: canonical,
        key: codexProfileKey(canonical),
        active
      });
    } else if (active && !existing.active) {
      profiles.set(pathIdentity, { ...existing, active: true });
    }
  }
  return [...profiles.values()];
}

function defaultProfileCandidates(activeProfileDirectory: string | undefined): readonly string[] {
  const home = homedir();
  const candidates = new Set<string>();
  const add = (value: string | undefined): void => {
    if (value !== undefined && value.trim() !== "") candidates.add(resolve(value));
  };
  add(activeProfileDirectory);
  add(process.env["CODEX_HOME"]);
  add(join(home, ".codex"));
  if (platform() === "darwin") {
    const applicationSupport = join(home, "Library", "Application Support", "Codex");
    add(join(applicationSupport, "codex-home"));
    add(applicationSupport);
  } else if (platform() === "win32") {
    const roaming = process.env["APPDATA"] ?? join(home, "AppData", "Roaming");
    add(join(roaming, "Codex", "codex-home"));
    add(join(roaming, "Codex"));
  } else {
    add(join(process.env["XDG_CONFIG_HOME"] ?? join(home, ".config"), "codex"));
  }
  return [...candidates];
}

async function hasCatalogArtifacts(directory: string): Promise<boolean> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.some((entry) => (
      entry.isFile() && (/^state_\d+\.sqlite$/iu.test(entry.name) || entry.name === SESSION_INDEX_FILE)
    ) || (
      entry.isDirectory() && (entry.name === "sessions" || entry.name === "archived_sessions")
    ));
  } catch {
    return false;
  }
}

function isPrivateRuntimeProfile(value: string): boolean {
  const segments = value.replace(/\\/g, "/").toLocaleLowerCase("en-US").split("/");
  return segments.includes("backend-runtime") || segments.includes("runtime-profiles");
}

async function scanStateDatabase(profile: CatalogProfile, maximumEntries: number): Promise<SourceScan> {
  const databasePath = await newestStateDatabase(profile.directory);
  if (databasePath === undefined) return emptySourceScan();
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    database.exec("PRAGMA query_only = ON");
    const columns = database.prepare("PRAGMA table_info(threads)").all()
      .map((row) => objectRecord(row)?.["name"])
      .filter((value): value is string => typeof value === "string");
    if (!columns.includes("id")) return emptySourceScan();
    const ordering = [
      ...(columns.includes("updated_at_ms") ? [quoteIdentifier("updated_at_ms")] : []),
      ...(columns.includes("updated_at") ? [`${quoteIdentifier("updated_at")} * 1000`] : []),
      ...(columns.includes("created_at_ms") ? [quoteIdentifier("created_at_ms")] : []),
      ...(columns.includes("created_at") ? [`${quoteIdentifier("created_at")} * 1000`] : [])
    ];
    const orderingExpression = ordering.length === 0
      ? undefined
      : ordering.length === 1
        ? ordering[0]
        : `COALESCE(${ordering.join(", ")})`;
    const sql = `SELECT * FROM "threads"${
      orderingExpression === undefined ? "" : ` ORDER BY ${orderingExpression} DESC`
    }`;
    const summaries: RawSummary[] = [];
    const seen = new Set<string>();
    const observedIds = new Set<string>();
    const archivedIds = new Set<string>();
    const rejectedIds = new Set<string>();
    for (const value of database.prepare(sql).iterate()) {
      const row = objectRecord(value) as SqliteRow | undefined;
      if (row === undefined) continue;
      const observedId = boundedString(row["id"], 512);
      if (observedId !== undefined) {
        observedIds.add(observedId);
        if (booleanValue(row["archived"])) archivedIds.add(observedId);
      }
      const result = await stateRowSummary(profile, databasePath, row);
      if (result === "rejected") {
        if (observedId !== undefined) rejectedIds.add(observedId);
        continue;
      }
      if (result === undefined || seen.has(result.nativeSessionId)) continue;
      seen.add(result.nativeSessionId);
      if (summaries.length < maximumEntries) summaries.push(result);
    }
    return { summaries, rejectedCount: rejectedIds.size, observedIds, archivedIds };
  } catch {
    return emptySourceScan();
  } finally {
    database?.close();
  }
}

async function newestStateDatabase(profileDirectory: string): Promise<string | undefined> {
  try {
    const entries = await readdir(profileDirectory, { withFileTypes: true });
    let selected: { readonly path: string; readonly version: number } | undefined;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = /^state_(\d+)\.sqlite$/i.exec(entry.name);
      if (match?.[1] === undefined) continue;
      const version = Number(match[1]);
      if (!Number.isSafeInteger(version) || version < 0) continue;
      if (selected === undefined || version > selected.version) {
        selected = { path: join(profileDirectory, entry.name), version };
      }
    }
    return selected?.path;
  } catch {
    return undefined;
  }
}

async function stateRowSummary(
  profile: CatalogProfile,
  databasePath: string,
  row: SqliteRow
): Promise<RawSummary | "rejected" | undefined> {
  const nativeSessionId = boundedString(row["id"], 512);
  if (nativeSessionId === undefined) return undefined;
  if (threadSourceIsRejected(row["thread_source"])
    || containsInternalSource(row["source"])
    || containsInternalSource(row["originator"])) {
    return "rejected";
  }
  const title = stateTaskTitle(row);
  const workingDirectory = normalizeWorkingDirectory(boundedString(row["cwd"], 32_768))
    ?? normalizeWorkingDirectory(homedir());
  const baseModifiedAt = timestampFromRow(row);
  const archived = booleanValue(row["archived"]);
  const archivedAt = timestampValue(row["archived_at"], 0);
  const modifiedAt = archived ? Math.max(baseModifiedAt, archivedAt) : baseModifiedAt;
  const createdAt = Math.min(createdTimestampFromRow(row, modifiedAt), modifiedAt);
  const rollout = await catalogFileFence(
    profile.directory,
    boundedString(row["rollout_path"], 32_768)
  );
  const source = catalogSource({
    profile,
    databaseFile: relative(profile.directory, databasePath),
    databaseRowFingerprint: sqliteRowFingerprint(row),
    ...(rollout === undefined ? {} : { rollout })
  });
  return {
    nativeSessionId,
    title,
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    createdAt,
    modifiedAt,
    archived,
    source
  };
}

async function scanRollouts(
  profile: CatalogProfile,
  maximumEntries: number,
  observedStateIds: ReadonlySet<string>,
  sessionIndex: ReadonlyMap<string, SessionIndexEntry>
): Promise<SourceScan> {
  const archivedIds = new Set<string>();
  const files = (await Promise.all([
    collectRolloutFiles(join(profile.directory, "sessions"), false, observedStateIds, archivedIds),
    collectRolloutFiles(join(profile.directory, "archived_sessions"), true, observedStateIds, archivedIds)
  ])).flat();
  files.sort((left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path));
  const summaries: RawSummary[] = [];
  const seen = new Set<string>();
  const rejectedIds = new Set<string>();
  for (const file of files) {
    const outcome = await readRolloutSummary(profile, file, sessionIndex);
    if (outcome.kind === "rejected") {
      rejectedIds.add(outcome.nativeSessionId);
      continue;
    }
    if (outcome.kind === "error" || seen.has(outcome.summary.nativeSessionId)) continue;
    seen.add(outcome.summary.nativeSessionId);
    summaries.push(outcome.summary);
    if (summaries.length >= maximumEntries) break;
  }
  return { summaries, rejectedCount: rejectedIds.size, observedIds: new Set(), archivedIds };
}

async function collectRolloutFiles(
  root: string,
  archived: boolean,
  observedStateIds: ReadonlySet<string>,
  archivedIds: Set<string>
): Promise<readonly RolloutFile[]> {
  const pending: Array<{ readonly path: string; readonly depth: number }> = [{ path: root, depth: 0 }];
  const paths: string[] = [];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) break;
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < MAXIMUM_ROLLOUT_DEPTH) pending.push({ path, depth: current.depth + 1 });
      } else if (entry.isFile() && entry.name.toLocaleLowerCase("en-US").endsWith(".jsonl")) {
        const knownNativeSessionId = nativeIdFromRolloutName(entry.name);
        if (knownNativeSessionId !== undefined && observedStateIds.has(knownNativeSessionId)) {
          if (archived) archivedIds.add(knownNativeSessionId);
          continue;
        }
        paths.push(path);
      }
    }
  }
  const files = await Promise.all(paths.map(async (path): Promise<RolloutFile | undefined> => {
    try {
      const info = await stat(path);
      if (!info.isFile() || !Number.isFinite(info.mtimeMs)) return undefined;
      return {
        path,
        modifiedAt: Math.max(0, Math.trunc(info.mtimeMs)),
        size: info.size,
        device: info.dev,
        inode: info.ino,
        archived
      };
    } catch {
      return undefined;
    }
  }));
  return files.filter((file): file is RolloutFile => file !== undefined);
}

function nativeIdFromRolloutName(value: string): string | undefined {
  return /([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i
    .exec(value)?.[1]?.toLocaleLowerCase("en-US");
}

function emptySourceScan(): SourceScan {
  return {
    summaries: [],
    rejectedCount: 0,
    observedIds: new Set(),
    archivedIds: new Set()
  };
}

async function readRolloutSummary(
  profile: CatalogProfile,
  file: RolloutFile,
  sessionIndex: ReadonlyMap<string, SessionIndexEntry>
): Promise<RolloutSummaryOutcome> {
  const line = await readFirstLine(file.path);
  if (line === undefined) return { kind: "error" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "error" };
  }
  const record = objectRecord(parsed);
  const payload = objectRecord(record?.["payload"]);
  if (record === undefined || payload === undefined || record["type"] !== "session_meta") {
    return { kind: "error" };
  }
  const nativeSessionId = boundedString(payload["id"], 512);
  if (nativeSessionId === undefined) return { kind: "error" };
  if (threadSourceIsRejected(payload["thread_source"])
    || containsInternalSource(payload["source"])
    || containsInternalSource(payload["originator"])) {
    return { kind: "rejected", nativeSessionId };
  }
  const indexed = sessionIndex.get(nativeSessionId);
  const title = indexed?.title ?? DEFAULT_TASK_TITLE;
  const workingDirectory = normalizeWorkingDirectory(boundedString(payload["cwd"], 32_768))
    ?? normalizeWorkingDirectory(homedir());
  const modifiedAt = indexed?.modifiedAt ?? file.modifiedAt;
  const createdAt = Math.min(parsedTimestampValue(payload["timestamp"]) ?? modifiedAt, modifiedAt);
  const rollout = fileFenceFromStat(profile.directory, file.path, file);
  if (rollout === undefined) return { kind: "error" };
  const source = catalogSource({ profile, rollout });
  return {
    kind: "accepted",
    summary: {
      nativeSessionId,
      title,
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
      createdAt,
      modifiedAt,
      archived: file.archived,
      source
    }
  };
}

async function readSessionIndex(profileDirectory: string): Promise<ReadonlyMap<string, SessionIndexEntry>> {
  const entries = new Map<string, SessionIndexEntry>();
  const stream = createReadStream(join(profileDirectory, SESSION_INDEX_FILE), { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = objectRecord(parsed);
      const nativeSessionId = boundedString(record?.["id"], 512);
      if (nativeSessionId === undefined) continue;
      const title = firstBoundedString(record ?? {}, ["thread_name", "title"], 512)
        ?? DEFAULT_TASK_TITLE;
      const modifiedAt = timestampValue(record?.["updated_at"], -1);
      entries.set(nativeSessionId, {
        title,
        ...(modifiedAt < 0 ? {} : { modifiedAt })
      });
    }
  } catch {
    return new Map();
  } finally {
    lines.close();
    stream.destroy();
  }
  return entries;
}

async function readFirstLine(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0) return undefined;
    const length = Math.min(info.size, MAXIMUM_METADATA_BYTES);
    const bytes = Buffer.allocUnsafe(length);
    const read = await handle.read(bytes, 0, length, 0);
    const newline = bytes.subarray(0, read.bytesRead).indexOf(0x0a);
    if (newline < 0 && info.size > MAXIMUM_METADATA_BYTES) return undefined;
    return bytes.subarray(0, newline < 0 ? read.bytesRead : newline).toString("utf8").trim();
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readProjectlessThreadIds(profileDirectory: string): Promise<ReadonlySet<string>> {
  try {
    const path = join(profileDirectory, PROFILE_STATE_FILE);
    const info = await stat(path);
    if (!info.isFile() || info.size > MAXIMUM_PROFILE_STATE_BYTES) return new Set();
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const record = objectRecord(parsed);
    const values = record?.["projectless-thread-ids"];
    if (!Array.isArray(values) || values.length > MAXIMUM_PROJECTLESS_IDS) return new Set();
    return new Set(values.flatMap((value) => {
      const id = boundedString(value, 512);
      return id === undefined ? [] : [id];
    }));
  } catch {
    return new Set();
  }
}

function mergeSummary(left: RawSummary, right: RawSummary): RawSummary {
  const newest = right.modifiedAt > left.modifiedAt ? right : left;
  const older = newest === right ? left : right;
  const title = newest.title ?? older.title;
  const workingDirectory = newest.workingDirectory ?? older.workingDirectory;
  return {
    nativeSessionId: newest.nativeSessionId,
    ...(title === undefined ? {} : { title }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    createdAt: Math.min(left.createdAt, right.createdAt, newest.modifiedAt),
    modifiedAt: newest.modifiedAt,
    archived: left.archived || right.archived,
    source: newest.source
  };
}

function mergeCatalogSummary(
  left: CodexSessionCatalogSummary,
  right: CodexSessionCatalogSummary,
  activeProfileKey: string | undefined
): CodexSessionCatalogSummary {
  const active = activeProfileKey === undefined
    ? undefined
    : left.source.profileKey === activeProfileKey
      ? left
      : right.source.profileKey === activeProfileKey
        ? right
        : undefined;
  const newest = active ?? (right.modifiedAt > left.modifiedAt ? right : left);
  const older = newest === right ? left : right;
  const title = active === undefined ? newest.title ?? older.title : active.title;
  const workingDirectory = active === undefined
    ? newest.workingDirectory ?? older.workingDirectory
    : active.workingDirectory;
  const placement = newest.placement;
  const projectDirectory = placement === "project"
    ? projectDirectoryFor(workingDirectory) ?? newest.projectDirectory ?? older.projectDirectory
    : undefined;
  return {
    nativeSessionId: newest.nativeSessionId,
    ...(title === undefined ? {} : { title }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    ...(projectDirectory === undefined ? {} : { projectDirectory }),
    createdAt: active === undefined
      ? Math.min(left.createdAt, right.createdAt, newest.modifiedAt)
      : Math.min(active.createdAt, active.modifiedAt),
    modifiedAt: newest.modifiedAt,
    archived: left.archived || right.archived,
    placement,
    source: newest.source,
    observedProfileKeys: [...new Set([
      ...left.observedProfileKeys,
      ...right.observedProfileKeys
    ])]
  };
}

function containsInternalSource(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return containsInternalSource(JSON.parse(trimmed));
      } catch {
        return sourceTokenIsInternal(trimmed);
      }
    }
    return sourceTokenIsInternal(trimmed);
  }
  if (Array.isArray(value)) return value.some(containsInternalSource);
  const record = objectRecord(value);
  return record !== undefined && Object.entries(record)
    .some(([key, nested]) => sourceTokenIsInternal(key) || containsInternalSource(nested));
}

function sourceTokenIsInternal(value: string): boolean {
  const token = value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
  return token === "exec" || token === "codexexec" || token === "subagent"
    || token === "agentcreatedthread";
}

function threadSourceIsRejected(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const source = value.trim().toLocaleLowerCase("en-US");
  return source.length > 0 && source !== "user";
}

function timestampFromRow(row: SqliteRow): number {
  return parsedTimestampValue(row["updated_at_ms"], true)
    ?? parsedTimestampValue(row["updated_at"])
    ?? parsedTimestampValue(row["created_at_ms"], true)
    ?? parsedTimestampValue(row["created_at"])
    ?? Date.now();
}

function createdTimestampFromRow(row: SqliteRow, fallback: number): number {
  return parsedTimestampValue(row["created_at_ms"], true)
    ?? parsedTimestampValue(row["created_at"])
    ?? fallback;
}

function stateTaskTitle(row: Readonly<Record<string, unknown>>): string {
  for (const key of ["title", "preview"] as const) {
    const value = boundedString(row[key], 512);
    if (value !== undefined) return value;
  }
  if (typeof row["first_user_message"] === "string") {
    const firstLine = row["first_user_message"].split(/\r?\n/u)[0]?.trim();
    if (firstLine !== undefined && firstLine.length > 0 && firstLine.length <= 512) return firstLine;
  }
  return DEFAULT_TASK_TITLE;
}

function timestampValue(value: unknown, fallback: number, milliseconds = false): number {
  return parsedTimestampValue(value, milliseconds) ?? fallback;
}

function parsedTimestampValue(value: unknown, milliseconds = false): number | undefined {
  if (typeof value === "bigint") {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric)) return undefined;
    return Math.max(0, Math.trunc(milliseconds || numeric >= 1_000_000_000_000 ? numeric : numeric * 1_000));
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(milliseconds || value >= 1_000_000_000_000 ? value : value * 1_000));
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return parsedTimestampValue(numeric, milliseconds);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
  }
  return undefined;
}

function normalizeWorkingDirectory(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let normalized = value.trim();
  if (/^\\\\\?\\UNC\\/i.test(normalized)) normalized = `//${normalized.slice(8)}`;
  else if (/^\\\\\?\\/.test(normalized)) normalized = normalized.slice(4);
  normalized = normalized.replace(/\\/g, "/");
  const network = normalized.startsWith("//");
  normalized = normalized.replace(/\/{2,}/g, "/");
  if (network) normalized = `/${normalized}`;
  if (!/^(?:[a-z]:\/|\/)/i.test(normalized)) return undefined;
  while (normalized.length > 1 && normalized.endsWith("/") && !/^[a-z]:\/$/i.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function projectDirectoryFor(workingDirectory: string | undefined): string | undefined {
  if (workingDirectory === undefined) return undefined;
  const segments = workingDirectory.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]?.toLocaleLowerCase("en-US");
    if (segment === ".worktrees" && segments[index + 1] !== undefined) {
      return segments.slice(0, index).join("/") || "/";
    }
    if (segment === ".claude"
      && segments[index + 1]?.toLocaleLowerCase("en-US") === "worktrees"
      && segments[index + 2] !== undefined) {
      return segments.slice(0, index).join("/") || "/";
    }
  }
  return workingDirectory;
}

export function codexProfileKey(directory: string): string {
  return createHash("sha256").update(servicePathIdentity(resolve(directory))).digest("hex");
}

async function catalogFileFence(
  profileDirectory: string,
  configuredPath: string | undefined
): Promise<CodexCatalogFileFence | undefined> {
  if (configuredPath === undefined) return undefined;
  const candidate = isAbsolute(configuredPath)
    ? resolve(configuredPath)
    : resolve(profileDirectory, configuredPath);
  const canonical = await realpath(candidate).catch(() => undefined);
  if (canonical === undefined || !pathInside(profileDirectory, canonical)) return undefined;
  const info = await stat(canonical).catch(() => undefined);
  if (info?.isFile() !== true || !Number.isFinite(info.mtimeMs) || !Number.isSafeInteger(info.size)) {
    return undefined;
  }
  return fileFenceFromStat(profileDirectory, canonical, {
    size: info.size,
    modifiedAt: Math.max(0, Math.trunc(info.mtimeMs)),
    device: info.dev,
    inode: info.ino
  });
}

function fileFenceFromStat(
  profileDirectory: string,
  file: string,
  info: Pick<RolloutFile, "size" | "modifiedAt" | "device" | "inode">
): CodexCatalogFileFence | undefined {
  const relativePath = relative(profileDirectory, file);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) return undefined;
  return {
    relativePath,
    size: info.size,
    modifiedAt: info.modifiedAt,
    device: info.device,
    inode: info.inode
  };
}

function catalogSource(input: {
  readonly profile: CatalogProfile;
  readonly databaseFile?: string;
  readonly databaseRowFingerprint?: string;
  readonly rollout?: CodexCatalogFileFence;
}): CodexCatalogSource {
  const stable = {
    profileKey: input.profile.key,
    databaseFile: input.databaseFile,
    databaseRowFingerprint: input.databaseRowFingerprint,
    rollout: input.rollout
  };
  return {
    profileDirectory: input.profile.directory,
    profileKey: input.profile.key,
    ...(input.databaseFile === undefined ? {} : { databaseFile: input.databaseFile }),
    ...(input.databaseRowFingerprint === undefined
      ? {}
      : { databaseRowFingerprint: input.databaseRowFingerprint }),
    ...(input.rollout === undefined ? {} : { rollout: input.rollout }),
    fingerprint: createHash("sha256").update(JSON.stringify(stable)).digest("hex")
  };
}

function sqliteRowFingerprint(row: SqliteRow): string {
  const stable = Object.keys(row).sort().map((key) => {
    const value = row[key];
    if (typeof value === "bigint") return [key, `bigint:${value.toString(10)}`];
    if (value instanceof Uint8Array) return [key, `bytes:${Buffer.from(value).toString("base64")}`];
    return [key, value];
  });
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function pathInside(parent: string, child: string): boolean {
  const nested = relative(parent, child);
  return nested !== "" && !nested.startsWith("..") && !isAbsolute(nested);
}

function servicePathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function firstBoundedString(
  row: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  maximumLength: number
): string | undefined {
  for (const key of keys) {
    const value = boundedString(row[key], maximumLength);
    if (value !== undefined) return value;
  }
  return undefined;
}

function boundedString(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximumLength && !/[\u0000-\u001f]/.test(trimmed)
    ? trimmed
    : undefined;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === 1n || value === "1" || value === "true";
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveBound(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_MAXIMUM_ENTRIES) {
    throw new TypeError("maximumEntries must be a positive safe integer no greater than 1000.");
  }
  return value;
}

function positiveTotalBound(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_MAXIMUM_TOTAL_ENTRIES) {
    throw new TypeError("maximumTotalEntries must be a positive safe integer no greater than 10000.");
  }
  return value;
}
