import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";
import type { PortableNativeSession } from "@joko/core";
import { isJsonObject, type JsonObject } from "./protocol.js";

const CODEX_PORTABLE_ROLLOUT_FORMAT = "codex-native-portable-session-v1";
const MAXIMUM_ROLLOUT_BYTES = 96 * 1024 * 1024;
const MAXIMUM_PORTABLE_BYTES = 130 * 1024 * 1024;
const MAXIMUM_METADATA_BYTES = 1024 * 1024;
const MAXIMUM_ROLLOUTS = 64;
const MAXIMUM_DIRECTORY_ENTRIES = 200_000;
const NATIVE_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const NATIVE_ID = new RegExp(`^${NATIVE_UUID}$`, "u");
const ROLLOUT_NAME = new RegExp(
  `^rollout-(\\d{4})-(\\d{2})-(\\d{2})T\\d{2}-\\d{2}-\\d{2}-(${NATIVE_UUID})(?:_(${NATIVE_UUID}))?\\.jsonl(\\.zst)?$`, "u"
);
const decompress = promisify(zstdDecompress);

interface HistoryBase {
  readonly rolloutId: string;
  readonly endOrdinal: number;
  readonly endOffset: number;
}

interface RolloutName {
  readonly name: string;
  readonly date: readonly [string, string, string];
  readonly threadId: string;
  readonly rolloutId: string;
  readonly compressed: boolean;
}

interface RolloutMetadata {
  readonly header: JsonObject;
  readonly payload: JsonObject;
  readonly firstNewline: number;
  readonly mode: "legacy" | "paginated";
  readonly historyBase?: HistoryBase;
}

export interface PortableRollout {
  readonly file: RolloutName;
  readonly bytes: Buffer;
  readonly metadata: RolloutMetadata;
}

export interface CodexPortableRollout extends PortableNativeSession {
  readonly sourceNativeSessionIds: readonly string[];
}

export interface StagedCodexPortableRollout {
  readonly threadId: string;
  readonly path: string;
  readonly rollback: () => Promise<void>;
}

/** Copy the active rollout plus only the immutable ancestor prefixes it can read. */
export async function readCodexPortableRollout(
  home: string, rootPath: string, threadId: string, assertCurrent: () => void
): Promise<CodexPortableRollout> {
  const canonicalHome = await realpath(home);
  const rollouts: PortableRollout[] = [];
  const seen = new Set<string>();
  let total = 0;
  let path = rootPath;
  let id: string | undefined;
  let cutoff: HistoryBase | undefined;
  let paths: ReadonlyMap<string, string> | undefined;
  for (;;) {
    assertCurrent();
    const file = parseRolloutName(basename(path));
    if (file === undefined || (id === undefined ? file.threadId !== threadId : file.rolloutId !== id)
      || seen.has(file.rolloutId) || rollouts.length >= MAXIMUM_ROLLOUTS) {
      throw new Error("The native Codex rollout lineage is invalid.");
    }
    seen.add(file.rolloutId);
    const bytes = await readRolloutBytes(canonicalHome, path, file, cutoff?.endOffset, MAXIMUM_ROLLOUT_BYTES - total);
    const metadata = parseRolloutMetadata(bytes, file.threadId);
    if (cutoff !== undefined && (bytes.byteLength !== cutoff.endOffset || metadata.mode !== "paginated")) {
      throw new Error("The native Codex rollout prefix does not match its history reference.");
    }
    rollouts.push({ file: { ...file, compressed: false }, bytes, metadata });
    total += bytes.byteLength;
    cutoff = metadata.historyBase;
    if (cutoff === undefined) break;
    paths ??= await indexRolloutPaths(canonicalHome, assertCurrent);
    id = cutoff.rolloutId;
    const next = paths.get(id);
    if (next === undefined) throw new Error("The native Codex rollout is missing a referenced history prefix.");
    path = next;
  }
  assertCurrent();
  const entries = [JSON.stringify({ format: 1, backend: "codex", threadId })];
  for (const rollout of rollouts) {
    entries.push(JSON.stringify({ name: rollout.file.name, sha256: digest(rollout.bytes), bytes: rollout.bytes.toString("base64") }));
  }
  const bytes = Buffer.from(`${entries.join("\n")}\n`, "utf8");
  if (bytes.byteLength > MAXIMUM_PORTABLE_BYTES) throw new Error("The portable Codex rollout exceeds its size limit.");
  return { bytes, sha256: digest(bytes), nativeSessionId: threadId,
    sourceNativeSessionIds: [...new Set(rollouts.map(rollout => rollout.file.threadId))] };
}

export function parseCodexPortableRollout(input: Uint8Array): readonly [PortableRollout, ...PortableRollout[]] {
  if (input.byteLength < 2 || input.byteLength > MAXIMUM_PORTABLE_BYTES) throw invalidPackage();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  const records = text.split("\n");
  const header: unknown = JSON.parse(records.shift() ?? "null");
  if (!isJsonObject(header) || Object.keys(header).sort().join(",") !== "backend,format,threadId" || header["backend"] !== "codex"
    || header["format"] !== 1 || typeof header["threadId"] !== "string" || !NATIVE_ID.test(header["threadId"])
    || records.pop() !== "" || records.length < 1 || records.length > MAXIMUM_ROLLOUTS) throw invalidPackage();
  const seen = new Set<string>();
  const rollouts: PortableRollout[] = [];
  let total = 0;
  let cutoff: HistoryBase | undefined;
  for (const record of records) {
    const value: unknown = JSON.parse(record);
    if (!isJsonObject(value) || Object.keys(value).sort().join(",") !== "bytes,name,sha256" || typeof value["name"] !== "string"
      || typeof value["bytes"] !== "string" || typeof value["sha256"] !== "string") throw invalidPackage();
    const file = parseRolloutName(value["name"]);
    const bytes = Buffer.from(value["bytes"], "base64");
    if (file === undefined || file.compressed || seen.has(file.rolloutId) || digest(bytes) !== value["sha256"]
      || bytes.toString("base64") !== value["bytes"] || bytes.byteLength > MAXIMUM_ROLLOUT_BYTES - total
      || (rollouts.length === 0 ? file.threadId !== header["threadId"]
        : cutoff === undefined || file.rolloutId !== cutoff.rolloutId || bytes.byteLength !== cutoff.endOffset)) throw invalidPackage();
    const metadata = parseRolloutMetadata(bytes, file.threadId);
    if (cutoff !== undefined && metadata.mode !== "paginated") throw invalidPackage();
    rollouts.push({ file, bytes, metadata });
    seen.add(file.rolloutId);
    total += bytes.byteLength;
    cutoff = metadata.historyBase;
  }
  if (cutoff !== undefined) throw invalidPackage();
  const [root, ...ancestors] = rollouts;
  if (root === undefined) throw invalidPackage();
  return [root, ...ancestors];
}

/** Materialize the selected active path as one independent native rollout. */
export async function stageCodexPortableRollout(input: {
  readonly home: string;
  readonly workspace: string;
  readonly bytes: Uint8Array;
  readonly operationIdentity?: string;
  readonly assertCurrent: () => void;
}): Promise<StagedCodexPortableRollout> {
  input.assertCurrent();
  const rollouts = parseCodexPortableRollout(input.bytes);
  const home = await realpath(input.home);
  const { metadata, file } = rollouts[0];
  const threadId = transferredId(input.operationIdentity ?? randomUUID(), digest(input.bytes), file.threadId);
  const payload: JsonObject = { ...metadata.payload, id: threadId, session_id: threadId, cwd: input.workspace };
  if (payload["runtime_workspace_roots"] !== undefined) payload["runtime_workspace_roots"] = [input.workspace];
  for (const field of ["history_base", "forked_from_id", "forked_from_ordinal_exclusive", "creator_user_id", "creator_account_id",
    "agent_path", "selected_capability_roots", "dynamic_tools", "parent_thread_id", "attached_to_thread_id"]) delete payload[field];
  // Start at the oldest metadata ordinal. The leaf ordinal would make the native index skip
  // every inherited item before it. The items keep their original ordinals and identities.
  const ancestorFirst = [...rollouts].reverse();
  const header = Buffer.from(JSON.stringify({ ...ancestorFirst[0]!.metadata.header, timestamp: metadata.header["timestamp"], payload }) + "\n", "utf8");
  const records = ancestorFirst.map(rollout => rollout.bytes.subarray(rollout.metadata.firstNewline + 1));
  const bytes = Buffer.concat([header, ...records]);
  if (bytes.byteLength > MAXIMUM_ROLLOUT_BYTES) throw invalidPackage();
  const name = `${file.name.slice(0, file.name.indexOf(file.threadId))}${threadId}.jsonl`;
  const parent = await ensureCanonicalDirectories(home, ["sessions", ...file.date]);
  const path = join(parent, name);
  const identity = await publishPortableRollout(home, path, bytes, input.assertCurrent);
  const rollback = async (): Promise<void> => {
    if (identity === undefined) return;
    const current = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (current !== undefined && sameFile(identity, current) && await realpath(path) === path) await unlink(path);
  };
  try {
    input.assertCurrent();
    return { threadId, path, rollback };
  } catch (error) {
    try { await rollback(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "The receiving Codex rollout could not be rolled back."); }
    throw error;
  }
}

function parseRolloutName(name: string): RolloutName | undefined {
  const match = ROLLOUT_NAME.exec(name);
  if (match === null) return undefined;
  const [, year, month, day, threadId, rolloutId = threadId, compressed] = match;
  return { name: compressed === undefined ? name : name.slice(0, -4), date: [year!, month!, day!],
    threadId: threadId!, rolloutId: rolloutId!, compressed: compressed !== undefined };
}

function parseRolloutMetadata(bytes: Buffer, threadId: string): RolloutMetadata {
  const firstNewline = bytes.indexOf(10);
  if (firstNewline < 1 || firstNewline > MAXIMUM_METADATA_BYTES || bytes.at(-1) !== 10) throw invalidPackage();
  const header: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, firstNewline)));
  if (!isJsonObject(header) || header["type"] !== "session_meta" || !isJsonObject(header["payload"])) throw invalidPackage();
  const payload = header["payload"];
  const mode = payload["history_mode"] ?? "legacy";
  if (payload["id"] !== threadId || (mode !== "legacy" && mode !== "paginated")) throw invalidPackage();
  const base = payload["history_base"];
  if (base === undefined || base === null) return { header, payload, mode, firstNewline };
  if (mode !== "paginated" || !isJsonObject(base) || Object.keys(base).sort().join(",") !== "end_byte_offset,end_ordinal_exclusive,thread_id"
    || typeof base["thread_id"] !== "string" || !NATIVE_ID.test(base["thread_id"])
    || !positiveInteger(base["end_byte_offset"]) || !positiveInteger(base["end_ordinal_exclusive"])) throw invalidPackage();
  return { header, payload, mode, firstNewline, historyBase: {
    rolloutId: base["thread_id"], endOffset: base["end_byte_offset"], endOrdinal: base["end_ordinal_exclusive"]
  } };
}

async function readRolloutBytes(home: string, path: string, file: RolloutName, end: number | undefined, available: number): Promise<Buffer> {
  if (!isAbsolute(path)) throw invalidPackage();
  const canonical = await realpath(path);
  const logical = relative(home, canonical), [root, ...rest] = logical.split(sep);
  if (canonical !== resolve(path) || isAbsolute(logical) || (root !== "sessions" && root !== "archived_sessions") || rest.length < 1) {
    throw new Error("The native Codex rollout escaped its owned profile.");
  }
  const pathInfo = await lstat(canonical);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1) throw invalidPackage();
  const fileHandle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await fileHandle.stat();
    if (!sameFile(pathInfo, before) || !before.isFile() || before.size < 1) throw invalidPackage();
    const count = file.compressed ? before.size : end ?? before.size;
    if (count > before.size || count > available || (end !== undefined && end > available)) throw invalidPackage();
    const bytes = Buffer.allocUnsafe(count);
    let read = 0;
    while (read < count) {
      const { bytesRead } = await fileHandle.read(bytes, read, count - read, read);
      if (bytesRead < 1) throw invalidPackage();
      read += bytesRead;
    }
    if (!sameFile(before, await fileHandle.stat()) || !sameFile(before, await lstat(canonical))) {
      throw new Error("The native Codex rollout changed during export.");
    }
    if (!file.compressed) return bytes;
    const decoded = await decompress(bytes, { maxOutputLength: available });
    if (end !== undefined && end > decoded.byteLength) throw invalidPackage();
    return decoded.subarray(0, end);
  } finally {
    await fileHandle.close();
  }
}

async function indexRolloutPaths(home: string, assertCurrent: () => void): Promise<ReadonlyMap<string, string>> {
  const paths = new Map<string, string>(), ambiguous = new Set<string>();
  const pending = [join(home, "sessions"), join(home, "archived_sessions")].map(path => ({ path, depth: 0 }));
  let count = 0;
  while (pending.length > 0) {
    const { path, depth } = pending.pop()!;
    assertCurrent();
    const info = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!info?.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) continue;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++count > MAXIMUM_DIRECTORY_ENTRIES) throw new Error("The native Codex rollout search exceeded its directory limit.");
      const candidate = join(path, entry.name);
      if (entry.isDirectory() && depth < 4) pending.push({ path: candidate, depth: depth + 1 });
      if (!entry.isFile()) continue;
      const file = parseRolloutName(entry.name);
      if (file === undefined || ambiguous.has(file.rolloutId)) continue;
      const previous = paths.get(file.rolloutId);
      // Native compaction can briefly retain both representations of one rollout.
      if (previous === undefined || previous === `${candidate}.zst`) paths.set(file.rolloutId, candidate);
      else if (candidate !== `${previous}.zst`) { paths.delete(file.rolloutId); ambiguous.add(file.rolloutId); }
    }
  }
  return paths;
}

async function ensureCanonicalDirectories(home: string, parts: readonly string[]): Promise<string> {
  let parent = home;
  for (const part of parts) {
    const directory = join(parent, part);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw invalidPackage();
    parent = directory;
  }
  return parent;
}

async function publishPortableRollout(home: string, path: string, bytes: Buffer, assertCurrent: () => void): Promise<Stats | undefined> {
  const parent = dirname(path);
  if (await realpath(parent) !== parent) throw invalidPackage();
  const temporary = join(parent, `.${randomUUID()}.portable-rollout.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    if (await realpath(parent) !== parent) throw invalidPackage();
    assertCurrent();
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readRolloutBytes(home, path, parseRolloutName(basename(path))!, undefined, bytes.byteLength);
      if (!existing.equals(bytes)) throw new Error("The receiving Codex rollout identity is already in use.");
      return undefined;
    }
    // The link installs the entire checked file atomically. Its temporary name
    // is released before recording the final single-link identity for rollback.
    await unlink(temporary);
    return await lstat(path);
  } finally {
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}

function transferredId(operation: string, chain: string, source: string): string {
  const bytes = createHash("sha256").update(JSON.stringify([CODEX_PORTABLE_ROLLOUT_FORMAT, operation, chain, source])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && right.isFile() && !right.isSymbolicLink();
}

function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

function invalidPackage(): Error { return new Error("The portable Codex rollout is invalid or exceeds its bounds."); }
