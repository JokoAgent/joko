import { createHash } from "node:crypto";
import { lstat, open, opendir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const DEFAULT_MAXIMUM_ENTRIES = 1_000;
const DEFAULT_SESSION_TITLE = "Claude Code Session";
const MAXIMUM_DEPTH = 4;
const MAXIMUM_SUMMARY_BYTES = 384 * 1_024;
const MAXIMUM_SOURCE_DIGEST_BYTES = 64 * 1_024;
const MAXIMUM_SUMMARY_LINES = 400;
const MAXIMUM_SUMMARY_CACHE_ENTRIES = 8_192;
const MAXIMUM_PROFILE_STATE_BYTES = 4 * 1_024 * 1_024;
const FILE_STAT_CONCURRENCY = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDE_CONTEXT_OPEN = "<ide_opened_file>";
const IDE_CONTEXT_CLOSE = "</ide_opened_file>";

export interface ClaudeSessionCatalogSummary {
  readonly nativeSessionId: string;
  readonly title?: string;
  readonly workingDirectory?: string;
  readonly projectDirectory?: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
  /** Adapter-private source fence. It is never projected into public contracts. */
  readonly source: ClaudeCatalogSource;
}

/** Bounded file identity retained only by the Adapter that performed the scan. */
export interface ClaudeCatalogSource {
  readonly path: string;
  readonly size: bigint;
  readonly modifiedAtNanoseconds: bigint;
  readonly device: bigint;
  readonly inode: bigint;
  readonly headDigest: string;
  readonly fingerprint: string;
}

export interface ClaudeSessionCatalogScanResult {
  readonly summaries: readonly ClaudeSessionCatalogSummary[];
  readonly rejectedCount: number;
}

export interface ClaudeSessionCatalogScanOptions {
  readonly configDirectory?: string;
  readonly maximumEntries?: number;
}

interface CatalogFile {
  readonly path: string;
  readonly modifiedAt: number;
  readonly size: bigint;
  readonly modifiedAtNanoseconds: bigint;
  readonly device: bigint;
  readonly inode: bigint;
  readonly projectStorageName?: string;
}

interface RawSessionSummary {
  readonly nativeSessionId: string;
  readonly title?: string;
  readonly workingDirectory?: string;
  readonly createdAt?: number;
}

type SummaryOutcome =
  | { readonly kind: "accepted"; readonly summary: RawSessionSummary; readonly headDigest: string }
  | { readonly kind: "rejected"; readonly headDigest: string }
  | { readonly kind: "error" };

interface CachedSummary {
  readonly size: bigint;
  readonly modifiedAtNanoseconds: bigint;
  readonly device: bigint;
  readonly inode: bigint;
  readonly outcome: SummaryOutcome;
}

const summaryCache = new Map<string, CachedSummary>();

/** Read a Claude Code profile catalog without starting the CLI or opening a task. */
export async function scanClaudeSessionCatalog(
  options: ClaudeSessionCatalogScanOptions = {}
): Promise<ClaudeSessionCatalogScanResult> {
  const maximumEntries = positiveBound(options.maximumEntries, DEFAULT_MAXIMUM_ENTRIES);
  const configDirectory = configuredDirectory(options.configDirectory);
  if (configDirectory === undefined) return { summaries: [], rejectedCount: 0 };
  const projectsRoot = join(configDirectory, "projects");
  if (!(await directoryExists(projectsRoot))) return { summaries: [], rejectedCount: 0 };

  const [files, projectRoots] = await Promise.all([
    collectCatalogFiles(projectsRoot),
    readProjectRootMap(configDirectory)
  ]);
  const summaries: ClaudeSessionCatalogSummary[] = [];
  const seen = new Set<string>();
  let rejectedCount = 0;
  for (const file of files) {
    const outcome = await readSessionSummary(file);
    if (outcome.kind === "rejected") {
      rejectedCount += 1;
      continue;
    }
    if (outcome.kind === "error") continue;
    const nativeSessionId = outcome.summary.nativeSessionId.toLocaleLowerCase("en-US");
    if (seen.has(nativeSessionId)) continue;
    seen.add(nativeSessionId);
    const fallbackRoot = file.projectStorageName === undefined
      ? undefined
      : projectRoots.get(file.projectStorageName.toLocaleLowerCase("en-US"));
    const workingDirectory = normalizeWorkingDirectory(outcome.summary.workingDirectory)
      ?? fallbackRoot
      ?? normalizeWorkingDirectory(homedir());
    const projectDirectory = projectDirectoryFor(workingDirectory);
    const createdAt = Math.min(outcome.summary.createdAt ?? file.modifiedAt, file.modifiedAt);
    const source = catalogSource(file, nativeSessionId, outcome.headDigest);
    summaries.push({
      nativeSessionId,
      ...(outcome.summary.title === undefined ? {} : { title: outcome.summary.title }),
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
      ...(projectDirectory === undefined ? {} : { projectDirectory }),
      createdAt,
      modifiedAt: file.modifiedAt,
      source
    });
    if (summaries.length >= maximumEntries) break;
  }
  summaries.sort((left, right) => right.modifiedAt - left.modifiedAt
    || left.nativeSessionId.localeCompare(right.nativeSessionId));
  return { summaries, rejectedCount };
}

function configuredDirectory(value: string | undefined): string | undefined {
  const configured = value?.trim() || join(homedir(), ".claude");
  return isAbsolute(configured) ? resolve(configured) : undefined;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function collectCatalogFiles(root: string): Promise<readonly CatalogFile[]> {
  const pending: Array<{
    readonly path: string;
    readonly depth: number;
    readonly projectStorageName?: string;
  }> = [{ path: root, depth: 0 }];
  const paths: Array<{ readonly path: string; readonly projectStorageName?: string }> = [];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) break;
    let directory;
    try {
      directory = await opendir(current.path);
    } catch {
      continue;
    }
    try {
      for await (const entry of directory) {
        const path = join(current.path, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.toLocaleLowerCase("en-US") === "subagents") continue;
          if (current.depth >= MAXIMUM_DEPTH) continue;
          pending.push({
            path,
            depth: current.depth + 1,
            projectStorageName: current.projectStorageName ?? entry.name
          });
          continue;
        }
        if (entry.isFile() && entry.name.toLocaleLowerCase("en-US").endsWith(".jsonl")) {
          paths.push({
            path,
            ...(current.projectStorageName === undefined
              ? {}
              : { projectStorageName: current.projectStorageName })
          });
        }
      }
    } catch {
      // A directory disappearing during a read is not a rejected native task.
    }
  }

  const files: CatalogFile[] = [];
  for (let offset = 0; offset < paths.length; offset += FILE_STAT_CONCURRENCY) {
    const chunk = paths.slice(offset, offset + FILE_STAT_CONCURRENCY);
    const stats = await Promise.all(chunk.map(async (candidate): Promise<CatalogFile | undefined> => {
      try {
        const info = await lstat(candidate.path, { bigint: true });
        const modifiedAt = Number(info.mtimeNs / 1_000_000n);
        if (!info.isFile()
          || info.size < 0n
          || info.mtimeNs < 0n
          || !Number.isSafeInteger(modifiedAt)
          || modifiedAt < 0) return undefined;
        return {
          path: candidate.path,
          modifiedAt,
          size: info.size,
          modifiedAtNanoseconds: info.mtimeNs,
          device: info.dev,
          inode: info.ino,
          ...(candidate.projectStorageName === undefined
            ? {}
            : { projectStorageName: candidate.projectStorageName })
        };
      } catch {
        return undefined;
      }
    }));
    files.push(...stats.filter((file): file is CatalogFile => file !== undefined));
  }
  files.sort((left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path));
  return files;
}

async function readSessionSummary(file: CatalogFile): Promise<SummaryOutcome> {
  const cached = summaryCache.get(file.path);
  if (cached !== undefined
    && cached.size === file.size
    && cached.modifiedAtNanoseconds === file.modifiedAtNanoseconds
    && cached.device === file.device
    && cached.inode === file.inode) {
    const prefix = await readStableHead(file.path, file, MAXIMUM_SOURCE_DIGEST_BYTES);
    if (prefix === undefined) return { kind: "error" };
    const headDigest = createHash("sha256").update(prefix).digest("hex");
    if (cached.outcome.kind !== "error" && cached.outcome.headDigest === headDigest) {
      return cached.outcome;
    }
  }
  const outcome = await readSessionSummaryHead(file);
  if (outcome.kind !== "error") {
    if (summaryCache.size >= MAXIMUM_SUMMARY_CACHE_ENTRIES) summaryCache.clear();
    summaryCache.set(file.path, {
      size: file.size,
      modifiedAtNanoseconds: file.modifiedAtNanoseconds,
      device: file.device,
      inode: file.inode,
      outcome
    });
  }
  return outcome;
}

async function readSessionSummaryHead(file: CatalogFile): Promise<SummaryOutcome> {
  const head = await readStableHead(file.path, file, MAXIMUM_SUMMARY_BYTES);
  if (head === undefined) return { kind: "error" };
  const headDigest = createHash("sha256")
    .update(head.subarray(0, MAXIMUM_SOURCE_DIGEST_BYTES))
    .digest("hex");
  const lines = head.toString("utf8").split(/\r\n|\n|\r/u);
  let nativeSessionId = basename(file.path, ".jsonl");
  let workingDirectory: string | undefined;
  let title: string | undefined;
  let createdAt: number | undefined;
  let lineCount = 0;
  let sawTopLevelEvent = false;
  let removedIdeContextWithoutTitle = false;
  let hitLineLimitBeforeTitle = false;
  try {
    for (const line of lines) {
      lineCount += 1;
      const record = jsonRecord(line);
      if (lineCount > MAXIMUM_SUMMARY_LINES
        && !removedIdeContextWithoutTitle
        && !isIdeOnlyUserRecord(record)) {
        hitLineLimitBeforeTitle = true;
        break;
      }
      if (record === undefined || record["isSidechain"] === true) continue;
      const recordTimestamp = timestampValue(record["timestamp"] ?? record["created_at"] ?? record["createdAt"]);
      if (recordTimestamp !== undefined) createdAt = Math.min(createdAt ?? recordTimestamp, recordTimestamp);
      workingDirectory = nonemptyString(record["cwd"]) ?? workingDirectory;
      const type = nonemptyString(record["type"]);
      if (type !== "user" && type !== "assistant") continue;
      if (hasInternalParent(record)) return { kind: "rejected", headDigest };
      sawTopLevelEvent = true;
      nativeSessionId = nonemptyString(record["sessionId"])
        ?? nonemptyString(record["session_id"])
        ?? nativeSessionId;
      if (type === "assistant") continue;
      if (title !== undefined) continue;
      const message = objectRecord(record["message"]);
      const extracted = extractUserText(message?.["content"]);
      const text = extracted.text.trim();
      if (text.length === 0 && extracted.removedIdeContext) {
        removedIdeContextWithoutTitle = true;
        continue;
      }
      if (text.length === 0) continue;
      if (isInternalChannel(text)) return { kind: "rejected", headDigest };
      title = taskTitle(text);
      break;
    }
  } catch {
    return { kind: "error" };
  }
  if (hitLineLimitBeforeTitle || !sawTopLevelEvent || !UUID_PATTERN.test(nativeSessionId)) {
    return { kind: "rejected", headDigest };
  }
  return {
    kind: "accepted",
    headDigest,
    summary: {
      nativeSessionId,
      title: title ?? DEFAULT_SESSION_TITLE,
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(workingDirectory === undefined ? {} : { workingDirectory })
    }
  };
}

/** Validate one scanned source without walking its profile directory again. */
export async function claudeCatalogSourceIsCurrent(source: ClaudeCatalogSource): Promise<boolean> {
  const head = await readStableHead(source.path, source, MAXIMUM_SOURCE_DIGEST_BYTES);
  return head !== undefined
    && createHash("sha256").update(head).digest("hex") === source.headDigest;
}

async function readStableHead(
  path: string,
  expected: Pick<ClaudeCatalogSource, "size" | "modifiedAtNanoseconds" | "device" | "inode">,
  maximumBytes: number
): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
    const before = await handle.stat({ bigint: true });
    if (!catalogIdentityMatches(expected, before)) return undefined;
    const length = Number(before.size < BigInt(maximumBytes)
      ? before.size
      : BigInt(maximumBytes));
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = await handle.read(buffer, offset, length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!catalogIdentityMatches(expected, after)) return undefined;
    const current = await lstat(path, { bigint: true });
    if (!catalogIdentityMatches(expected, current)) return undefined;
    return buffer.subarray(0, offset);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function catalogIdentityMatches(
  expected: Pick<ClaudeCatalogSource, "size" | "modifiedAtNanoseconds" | "device" | "inode">,
  current: {
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly dev: bigint;
    readonly ino: bigint;
    isFile(): boolean;
  }
): boolean {
  return current.isFile()
    && current.size === expected.size
    && current.mtimeNs === expected.modifiedAtNanoseconds
    && current.dev === expected.device
    && current.ino === expected.inode;
}

function catalogSource(file: CatalogFile, nativeSessionId: string, headDigest: string): ClaudeCatalogSource {
  const fingerprint = createHash("sha256").update(JSON.stringify({
    version: 1,
    nativeSessionId,
    path: sourcePathIdentity(file.path),
    size: file.size.toString(10),
    modifiedAtNanoseconds: file.modifiedAtNanoseconds.toString(10),
    device: file.device.toString(10),
    inode: file.inode.toString(10),
    headDigest
  })).digest("hex");
  return {
    path: file.path,
    size: file.size,
    modifiedAtNanoseconds: file.modifiedAtNanoseconds,
    device: file.device,
    inode: file.inode,
    headDigest,
    fingerprint
  };
}

function sourcePathIdentity(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

async function readProjectRootMap(configDirectory: string): Promise<ReadonlyMap<string, string>> {
  const roots = new Map<string, string>();
  const statePath = join(dirname(configDirectory), ".claude.json");
  try {
    const info = await stat(statePath);
    if (info.isFile() && info.size <= MAXIMUM_PROFILE_STATE_BYTES) {
      const parsed = objectRecord(JSON.parse(await readFile(statePath, "utf8")) as unknown);
      const projects = objectRecord(parsed?.["projects"]);
      for (const value of Object.keys(projects ?? {})) {
        const normalized = normalizeWorkingDirectory(value);
        if (normalized !== undefined) roots.set(projectStorageName(normalized), normalized);
      }
    }
  } catch {
    // The home fallback is independent from optional profile metadata.
  }
  const home = normalizeWorkingDirectory(homedir());
  if (home !== undefined) roots.set(projectStorageName(home), home);
  return roots;
}

function projectStorageName(path: string): string {
  return path.replace(/[\\/:]/g, "-").toLocaleLowerCase("en-US");
}

function jsonRecord(line: string): Record<string, unknown> | undefined {
  if (line.trim().length === 0) return undefined;
  try {
    return objectRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonemptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hasInternalParent(record: Readonly<Record<string, unknown>>): boolean {
  return [
    record["parent_tool_use_id"],
    record["parentToolUseId"],
    record["parent_agent_id"],
    record["parentAgentId"],
    record["agent_id"],
    record["agentId"]
  ].some((value) => nonemptyString(value) !== undefined);
}

function extractUserText(content: unknown): { readonly text: string; readonly removedIdeContext: boolean } {
  const values: string[] = [];
  if (typeof content === "string") values.push(content);
  else if (Array.isArray(content)) {
    for (const value of content) {
      const block = objectRecord(value);
      if (block === undefined || block["type"] === "tool_result") continue;
      if ((block["type"] === "text" || block["type"] === "input_text")
        && typeof block["text"] === "string") values.push(block["text"]);
    }
  }
  let removedIdeContext = false;
  const stripped = values.map((value) => {
    const next = stripIdeContext(value);
    removedIdeContext ||= next !== value;
    return next;
  }).join("\n\n");
  const synthetic = isSyntheticUserText(stripped);
  return {
    text: synthetic ? "" : stripped,
    removedIdeContext
  };
}

function isIdeOnlyUserRecord(record: Readonly<Record<string, unknown>> | undefined): boolean {
  if (record === undefined || record["isSidechain"] === true || record["type"] !== "user") return false;
  const message = objectRecord(record["message"]);
  const extracted = extractUserText(message?.["content"]);
  return extracted.removedIdeContext && extracted.text.trim().length === 0;
}

function stripIdeContext(value: string): string {
  let cursor = 0;
  let result = "";
  while (cursor < value.length) {
    const open = value.indexOf(IDE_CONTEXT_OPEN, cursor);
    if (open < 0) return result + value.slice(cursor);
    const contentStart = open + IDE_CONTEXT_OPEN.length;
    const close = value.indexOf(IDE_CONTEXT_CLOSE, contentStart);
    if (close < 0) return result + value.slice(cursor);
    result += `${value.slice(cursor, open)}\n`;
    cursor = close + IDE_CONTEXT_CLOSE.length;
  }
  return result;
}

function isSyntheticUserText(value: string): boolean {
  const text = value.trimStart();
  return text.startsWith("<local-command-caveat>")
    || text.startsWith("<command-name>")
    || text.startsWith("<local-command-stdout>")
    || text.startsWith("<local-command-stderr>")
    || text.startsWith("<task-notification>");
}

function isInternalChannel(value: string): boolean {
  const openingTag = value.trimStart().match(/^<channel\b[^>]*>/i)?.[0];
  if (openingTag === undefined) return false;
  for (const match of openingTag.matchAll(/\bsource\s*=\s*(["'])([^"']+)\1/gi)) {
    const source = match[2]?.trim().toLocaleLowerCase("en-US");
    if (source === "review-session-channel" || source === "local-review") return true;
  }
  return false;
}

function taskTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 120);
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

function positiveBound(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_MAXIMUM_ENTRIES) {
    throw new TypeError("maximumEntries must be a positive safe integer no greater than 1000.");
  }
  return value;
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value >= 1_000_000_000_000 ? value : value * 1_000));
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return timestampValue(numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}
