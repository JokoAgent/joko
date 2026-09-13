import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NativeSessionCatalogEntry } from "@joko/core";
import { adapterError } from "./errors.js";
import type { CodexCatalogFileFence, CodexCatalogSource } from "./session-catalog.js";

const SQLITE_BUSY_TIMEOUT_MS = 3_000;
const MAXIMUM_PROFILE_STATE_BYTES = 4 * 1_024 * 1_024;
const PROFILE_STATE_FILE = ".codex-global-state.json";
const PROJECTLESS_IDS_FIELD = "projectless-thread-ids";

type SqliteValue = bigint | number | string | Uint8Array | null;
type SqliteRow = Readonly<Record<string, SqliteValue>>;

interface TableColumn {
  readonly name: string;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
}

export interface CodexCatalogMaterializationInput {
  readonly activeProfileDirectory: string;
  readonly source: CodexCatalogSource;
  readonly entry: NativeSessionCatalogEntry;
}

export async function validateCodexCatalogSource(
  source: CodexCatalogSource,
  nativeSessionId: string
): Promise<void> {
  const sourceProfile = await canonicalDirectory(source.profileDirectory);
  const row = await readAndValidateSource(source, nativeSessionId);
  if (source.rollout !== undefined) {
    await resolveFencedRollout(sourceProfile, source.rollout);
  } else if (row === undefined) {
    throw materializationUnavailable("The source task has no stable identity fence.");
  }
}

/**
 * Publish one external native task into the active profile without overwriting
 * an existing native identity. Every partial step has an idempotent recovery
 * path; conflicts and source changes fail closed.
 */
export async function materializeCodexCatalogSession(
  input: CodexCatalogMaterializationInput
): Promise<void> {
  const activeProfile = await canonicalDirectory(input.activeProfileDirectory);
  const sourceProfile = await canonicalDirectory(input.source.profileDirectory);
  const sourceState = await readAndValidateSource(input.source, input.entry.nativeSessionId ?? "");
  if (samePath(activeProfile, sourceProfile)) {
    if (input.source.rollout !== undefined) {
      await resolveFencedRollout(sourceProfile, input.source.rollout);
    } else if (sourceState === undefined) {
      throw materializationUnavailable("The source task has no stable identity fence.");
    }
    return;
  }
  const rollout = input.source.rollout;
  if (rollout === undefined) throw materializationUnavailable("The source task has no stable rollout file.");
  const sourceRollout = await resolveFencedRollout(sourceProfile, rollout);
  const targetRollout = materializedRolloutPath(
    activeProfile,
    input.source.profileKey,
    input.source.fingerprint,
    input.entry.nativeSessionId ?? "",
    input.entry.archived
  );
  const activeDatabasePath = await newestStateDatabase(activeProfile);
  if (activeDatabasePath === undefined) {
    throw materializationUnavailable("The active Codex profile has no state database.");
  }
  assertActiveIdentityAvailable(activeDatabasePath, input.entry.nativeSessionId ?? "", targetRollout);
  const published = await publishRollout(activeProfile, sourceRollout, targetRollout, rollout);
  let databaseCommitted = false;
  try {
    // Re-read the exact row and file fence after copying. An unrelated database
    // update is harmless, while a changed task row or rollout is rejected.
    await readAndValidateSource(input.source, input.entry.nativeSessionId ?? "");
    await assertRolloutFence(sourceRollout, rollout);
    if (await fileDigest(sourceRollout) !== published.digest) throw sourceChanged();

    publishThreadRow({
      databasePath: activeDatabasePath,
      targetRollout,
      sourceRow: sourceState,
      entry: input.entry
    });
    databaseCommitted = true;
    await updateProjectlessPlacement(
      activeProfile,
      input.entry.nativeSessionId ?? "",
      input.entry.placement === "dialogue"
    );
  } catch (error) {
    if (published.created && !databaseCommitted) {
      await removeUncommittedRollout(
        activeDatabasePath,
        input.entry.nativeSessionId ?? "",
        targetRollout,
        published.digest
      );
    }
    throw error;
  }
}

function assertActiveIdentityAvailable(
  databasePath: string,
  nativeSessionId: string,
  targetRollout: string
): void {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    database.exec("PRAGMA query_only = ON");
    const row = database.prepare('SELECT "rollout_path" FROM "threads" WHERE "id" = ? LIMIT 1')
      .get(nativeSessionId) as Readonly<Record<string, unknown>> | undefined;
    if (row === undefined) return;
    const rolloutPath = typeof row["rollout_path"] === "string" ? resolve(row["rollout_path"]) : undefined;
    if (rolloutPath === undefined || !samePath(rolloutPath, targetRollout)) throw targetConflict();
  } catch (error) {
    if (isMaterializationError(error)) throw error;
    throw materializationUnavailable("The active Codex identity could not be checked safely.");
  } finally {
    database?.close();
  }
}

async function readAndValidateSource(
  source: CodexCatalogSource,
  nativeSessionId: string
): Promise<SqliteRow | undefined> {
  if (nativeSessionId.length === 0) throw materializationUnavailable("The source task identity is missing.");
  if (source.databaseFile === undefined || source.databaseRowFingerprint === undefined) return undefined;
  const databasePath = resolve(source.profileDirectory, source.databaseFile);
  if (!pathInside(source.profileDirectory, databasePath)
    || basename(databasePath) !== source.databaseFile
    || !/^state_\d+\.sqlite$/iu.test(source.databaseFile)) {
    throw materializationUnavailable("The source state database identity is invalid.");
  }
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    database.exec("PRAGMA query_only = ON");
    const row = database.prepare('SELECT * FROM "threads" WHERE "id" = ? LIMIT 1')
      .get(nativeSessionId) as SqliteRow | undefined;
    if (row === undefined || sqliteRowFingerprint(row) !== source.databaseRowFingerprint) {
      throw sourceChanged();
    }
    return row;
  } catch (error) {
    if (isMaterializationError(error)) throw error;
    throw materializationUnavailable("The source task row could not be verified.");
  } finally {
    database?.close();
  }
}

async function resolveFencedRollout(
  sourceProfile: string,
  fence: CodexCatalogFileFence
): Promise<string> {
  const configured = resolve(sourceProfile, fence.relativePath);
  if (!pathInside(sourceProfile, configured)) throw materializationUnavailable("The source rollout path is invalid.");
  const canonical = await realpath(configured).catch(() => undefined);
  if (canonical === undefined || !pathInside(sourceProfile, canonical)) {
    throw materializationUnavailable("The source rollout is unavailable.");
  }
  await assertRolloutFence(canonical, fence);
  return canonical;
}

async function assertRolloutFence(file: string, fence: CodexCatalogFileFence): Promise<void> {
  const info = await stat(file).catch(() => undefined);
  if (info?.isFile() !== true
    || info.size !== fence.size
    || Math.trunc(info.mtimeMs) !== fence.modifiedAt
    || (fence.device !== 0 && info.dev !== fence.device)
    || (fence.inode !== 0 && info.ino !== fence.inode)) {
    throw sourceChanged();
  }
}

async function publishRollout(
  activeProfile: string,
  source: string,
  target: string,
  fence: CodexCatalogFileFence
): Promise<{ readonly digest: string; readonly created: boolean }> {
  await assertSecureTargetPath(activeProfile, target);
  const sourceDigest = await fileDigest(source);
  const existing = await lstat(target).catch(() => undefined);
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isFile() || await fileDigest(target) !== sourceDigest) {
      throw targetConflict();
    }
    return { digest: sourceDigest, created: false };
  }
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertRolloutFence(source, fence);
    if (await fileDigest(temporary) !== sourceDigest) throw sourceChanged();
    let created = true;
    try {
      await link(temporary, target);
    } catch (error) {
      if (!nodeErrorCode(error, "EEXIST")) throw error;
      const targetInfo = await lstat(target).catch(() => undefined);
      if (targetInfo?.isSymbolicLink() !== false
        || !targetInfo.isFile()
        || await fileDigest(target).catch(() => "") !== sourceDigest) throw targetConflict();
      created = false;
    }
    await unlink(temporary).catch(() => undefined);
    return { digest: sourceDigest, created };
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (isMaterializationError(error)) throw error;
    throw materializationUnavailable("The source rollout could not be published atomically.");
  }
}

async function assertSecureTargetPath(activeProfile: string, target: string): Promise<void> {
  const parent = dirname(target);
  const nested = relative(activeProfile, parent);
  if (nested === "" || nested.startsWith("..") || isAbsolute(nested)) throw targetConflict();
  let cursor = activeProfile;
  for (const segment of nested.split(/[\\/]+/u).filter((value) => value !== "")) {
    cursor = join(cursor, segment);
    let info = await lstat(cursor).catch(() => undefined);
    if (info === undefined) {
      try {
        await mkdir(cursor);
      } catch (error) {
        if (!nodeErrorCode(error, "EEXIST")) throw targetConflict();
      }
      info = await lstat(cursor).catch(() => undefined);
    }
    if (info?.isSymbolicLink() === true || info?.isDirectory() !== true) throw targetConflict();
  }
  const canonicalParent = await realpath(parent).catch(() => undefined);
  if (canonicalParent === undefined || !pathInside(activeProfile, canonicalParent)) throw targetConflict();
  const targetInfo = await lstat(target).catch(() => undefined);
  if (targetInfo?.isSymbolicLink() === true || (targetInfo !== undefined && !targetInfo.isFile())) {
    throw targetConflict();
  }
}

async function removeUncommittedRollout(
  databasePath: string,
  nativeSessionId: string,
  target: string,
  expectedDigest: string
): Promise<void> {
  if (activeRowUsesRollout(databasePath, nativeSessionId, target)) return;
  const info = await lstat(target).catch(() => undefined);
  if (info?.isSymbolicLink() !== false || !info.isFile()) return;
  if (await fileDigest(target).catch(() => "") !== expectedDigest) return;
  await unlink(target).catch(() => undefined);
}

function activeRowUsesRollout(databasePath: string, nativeSessionId: string, target: string): boolean {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA query_only = ON");
    const row = database.prepare('SELECT "rollout_path" FROM "threads" WHERE "id" = ? LIMIT 1')
      .get(nativeSessionId) as Readonly<Record<string, unknown>> | undefined;
    return typeof row?.["rollout_path"] === "string" && samePath(row["rollout_path"], target);
  } catch {
    // An uncertain database state must retain the rollout for recovery.
    return true;
  } finally {
    database?.close();
  }
}

function publishThreadRow(input: {
  readonly databasePath: string;
  readonly targetRollout: string;
  readonly sourceRow: SqliteRow | undefined;
  readonly entry: NativeSessionCatalogEntry;
}): void {
  const nativeSessionId = input.entry.nativeSessionId ?? "";
  let database: DatabaseSync | undefined;
  let transaction = false;
  try {
    database = new DatabaseSync(input.databasePath);
    database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    database.exec("BEGIN IMMEDIATE");
    transaction = true;
    const existing = database.prepare('SELECT "rollout_path" FROM "threads" WHERE "id" = ? LIMIT 1')
      .get(nativeSessionId) as Readonly<Record<string, unknown>> | undefined;
    if (existing !== undefined) {
      const rolloutPath = typeof existing["rollout_path"] === "string"
        ? resolve(existing["rollout_path"])
        : undefined;
      if (rolloutPath === undefined || !samePath(rolloutPath, input.targetRollout)) throw targetConflict();
      database.exec("COMMIT");
      transaction = false;
      return;
    }
    const columns = readTableColumns(database);
    const values = materializedRowValues(columns, input);
    const names = [...values.keys()];
    if (names.length === 0) throw materializationUnavailable("The active state schema is unsupported.");
    database.prepare(`INSERT INTO "threads" (${names.map(quoteIdentifier).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
      .run(...names.map((name) => values.get(name) ?? null));
    database.exec("COMMIT");
    transaction = false;
  } catch (error) {
    if (transaction) database?.exec("ROLLBACK");
    if (isMaterializationError(error)) throw error;
    throw materializationUnavailable("The active Codex state row could not be committed.");
  } finally {
    database?.close();
  }
}

function readTableColumns(database: DatabaseSync): readonly TableColumn[] {
  const rows = database.prepare('PRAGMA table_info("threads")').all();
  const columns: TableColumn[] = [];
  for (const row of rows) {
    const record = objectRecord(row);
    const name = typeof record?.["name"] === "string" ? record["name"] : undefined;
    if (name === undefined) continue;
    columns.push({
      name,
      notNull: record?.["notnull"] === 1 || record?.["notnull"] === 1n,
      hasDefault: record?.["dflt_value"] !== null && record?.["dflt_value"] !== undefined
    });
  }
  if (!columns.some((column) => column.name === "id")
    || !columns.some((column) => column.name === "rollout_path")) {
    throw materializationUnavailable("The active Codex state schema is unsupported.");
  }
  return columns;
}

function materializedRowValues(
  columns: readonly TableColumn[],
  input: {
    readonly targetRollout: string;
    readonly sourceRow: SqliteRow | undefined;
    readonly entry: NativeSessionCatalogEntry;
  }
): Map<string, SqliteValue> {
  const entry = input.entry;
  const nativeSessionId = entry.nativeSessionId ?? "";
  const createdSeconds = Math.floor(entry.createdAt / 1_000);
  const modifiedSeconds = Math.floor(entry.modifiedAt / 1_000);
  const synthesized = new Map<string, SqliteValue>([
    ["id", nativeSessionId],
    ["rollout_path", input.targetRollout],
    ["created_at", createdSeconds],
    ["updated_at", modifiedSeconds],
    ["created_at_ms", entry.createdAt],
    ["updated_at_ms", entry.modifiedAt],
    ["recency_at", modifiedSeconds],
    ["recency_at_ms", entry.modifiedAt],
    ["source", "cli"],
    ["thread_source", "user"],
    ["model_provider", "openai"],
    ["cwd", entry.workingDirectory ?? process.cwd()],
    ["title", entry.title ?? "Codex Session"],
    ["preview", entry.title ?? "Codex Session"],
    ["sandbox_policy", '{"type":"disabled"}'],
    ["approval_mode", "on-request"],
    ["tokens_used", 0],
    ["has_user_event", 1],
    ["archived", entry.archived ? 1 : 0],
    ["archived_at", entry.archived ? modifiedSeconds : null],
    ["cli_version", ""],
    ["first_user_message", ""],
    ["memory_mode", "enabled"],
    ["history_mode", "legacy"],
    ["is_pinned", 0]
  ]);
  const overrides = new Set(["id", "rollout_path", "archived", "archived_at"]);
  const values = new Map<string, SqliteValue>();
  for (const column of columns) {
    if (overrides.has(column.name)) {
      const value = synthesized.get(column.name);
      if (value !== undefined || column.name === "archived_at") values.set(column.name, value ?? null);
      continue;
    }
    const sourceValue = input.sourceRow?.[column.name];
    if (sourceValue !== undefined) {
      values.set(column.name, sourceValue);
      continue;
    }
    const synthesizedValue = synthesized.get(column.name);
    if (synthesizedValue !== undefined) {
      values.set(column.name, synthesizedValue);
      continue;
    }
    if (column.notNull && !column.hasDefault) {
      throw materializationUnavailable(`The active Codex state requires unsupported field ${column.name}.`);
    }
  }
  return values;
}

async function updateProjectlessPlacement(
  activeProfile: string,
  nativeSessionId: string,
  projectless: boolean
): Promise<void> {
  const file = join(activeProfile, PROFILE_STATE_FILE);
  const before = await readStateSnapshot(file);
  const record = before.record;
  const existing = record[PROJECTLESS_IDS_FIELD];
  const ids = new Set(Array.isArray(existing)
    ? existing.filter((value): value is string => typeof value === "string")
    : []);
  const changed = projectless ? !ids.has(nativeSessionId) : ids.has(nativeSessionId);
  if (!changed) return;
  if (projectless) ids.add(nativeSessionId);
  else ids.delete(nativeSessionId);
  const next = Buffer.from(JSON.stringify({ ...record, [PROJECTLESS_IDS_FIELD]: [...ids] }), "utf8");
  if (next.byteLength > MAXIMUM_PROFILE_STATE_BYTES) {
    throw materializationUnavailable("The active Codex profile state is too large to update safely.");
  }
  const temporary = join(activeProfile, `.${PROFILE_STATE_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, next, { flag: "wx" });
    const current = await fileIdentity(file);
    if (!sameFileIdentity(before.identity, current)) throw targetConflict();
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (isMaterializationError(error)) throw error;
    throw materializationUnavailable("The active Codex placement state could not be published atomically.");
  }
}

async function readStateSnapshot(file: string): Promise<{
  readonly record: Record<string, unknown>;
  readonly identity: FileIdentity | undefined;
}> {
  const identity = await fileIdentity(file);
  if (identity === undefined) return { record: {}, identity: undefined };
  if (identity.size > MAXIMUM_PROFILE_STATE_BYTES) {
    throw materializationUnavailable("The active Codex profile state is too large to read safely.");
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    const record = objectRecord(parsed);
    if (record === undefined) throw new Error("invalid profile state");
    return { record, identity };
  } catch {
    throw materializationUnavailable("The active Codex placement state is invalid.");
  }
}

interface FileIdentity {
  readonly size: number;
  readonly modifiedAt: number;
  readonly device: number;
  readonly inode: number;
}

async function fileIdentity(file: string): Promise<FileIdentity | undefined> {
  const info = await lstat(file).catch(() => undefined);
  if (info === undefined) return undefined;
  if (info.isSymbolicLink() || !info.isFile()) throw targetConflict();
  return {
    size: info.size,
    modifiedAt: Math.trunc(info.mtimeMs),
    device: info.dev,
    inode: info.ino
  };
}

function sameFileIdentity(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.size === right.size
    && left.modifiedAt === right.modifiedAt
    && left.device === right.device
    && left.inode === right.inode;
}

async function newestStateDatabase(profileDirectory: string): Promise<string | undefined> {
  try {
    const entries = await readdir(profileDirectory, { withFileTypes: true });
    let selected: { readonly path: string; readonly version: number } | undefined;
    for (const entry of entries) {
      const match = entry.isFile() ? /^state_(\d+)\.sqlite$/iu.exec(entry.name) : undefined;
      const version = match?.[1] === undefined ? undefined : Number(match[1]);
      if (version === undefined || !Number.isSafeInteger(version) || version < 0) continue;
      if (selected === undefined || version > selected.version) {
        selected = { path: join(profileDirectory, entry.name), version };
      }
    }
    return selected?.path;
  } catch {
    return undefined;
  }
}

async function canonicalDirectory(value: string): Promise<string> {
  if (!isAbsolute(value)) throw materializationUnavailable("A Codex profile path is invalid.");
  const canonical = await realpath(value).catch(() => undefined);
  if (canonical === undefined || (await stat(canonical).catch(() => undefined))?.isDirectory() !== true) {
    throw materializationUnavailable("A Codex profile directory is unavailable.");
  }
  return canonical;
}

function materializedRolloutPath(
  activeProfile: string,
  sourceProfileKey: string,
  sourceFingerprint: string,
  nativeSessionId: string,
  archived: boolean
): string {
  const identity = createHash("sha256")
    .update(`${nativeSessionId}\0${sourceFingerprint}`)
    .digest("hex");
  return join(
    activeProfile,
    archived ? "archived_sessions" : "sessions",
    "catalog-imports",
    sourceProfileKey.slice(0, 24),
    `${identity}.jsonl`
  );
}

async function fileDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(file);
  try {
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch {
    throw materializationUnavailable("A Codex rollout could not be verified.");
  } finally {
    stream.destroy();
  }
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

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pathInside(parent: string, child: string): boolean {
  const nested = relative(parent, child);
  return nested !== "" && !nested.startsWith("..") && !isAbsolute(nested);
}

function samePath(left: string, right: string): boolean {
  const leftIdentity = resolve(left);
  const rightIdentity = resolve(right);
  return process.platform === "win32"
    ? leftIdentity.toLocaleLowerCase("en-US") === rightIdentity.toLocaleLowerCase("en-US")
    : leftIdentity === rightIdentity;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function nodeErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && (error as { readonly code?: unknown }).code === code;
}

function isMaterializationError(error: unknown): boolean {
  return error !== null && typeof error === "object"
    && "publicError" in error
    && objectRecord((error as { readonly publicError?: unknown }).publicError)?.["code"] !== undefined;
}

function sourceChanged() {
  return adapterError({
    code: "CODEX_CATALOG_SOURCE_CHANGED",
    message: "The selected Codex task changed after the catalog scan.",
    phase: "provision",
    retryable: true,
    recovery: "Scan local tasks again and retry the import."
  });
}

function targetConflict() {
  return adapterError({
    code: "CODEX_CATALOG_TARGET_CONFLICT",
    message: "The active Codex profile already contains a conflicting native task identity.",
    phase: "provision",
    recovery: "Keep the existing native task or remove the conflict outside Joko before retrying."
  });
}

function materializationUnavailable(message: string) {
  return adapterError({
    code: "CODEX_CATALOG_MATERIALIZATION_UNAVAILABLE",
    message,
    phase: "provision",
    retryable: true,
    recovery: "Restore both Codex profiles, scan local tasks again, and retry the import."
  });
}
