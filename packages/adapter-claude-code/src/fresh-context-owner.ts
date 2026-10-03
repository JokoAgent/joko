import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NativeSessionBinding } from "@joko/core";

const SCHEMA_VERSION = 1;
const SCHEMA_BASELINE = "joko-claude-fresh-context-owner-v1";
const STORE_DIRECTORY = "claude-fresh-context-owner-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OPAQUE_AUTHORITY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export type ClaudeFreshContextOwnerErrorCode =
  | "INVALID_AUTHORITY" | "INVALID_ACCESS" | "NOT_FOUND" | "CONFLICT"
  | "CORRUPT" | "STORAGE_UNAVAILABLE" | "COMMIT_UNKNOWN";

/** Paths, native messages and underlying storage errors never enter this failure. */
export class ClaudeFreshContextOwnerError extends Error {
  readonly code: ClaudeFreshContextOwnerErrorCode;
  readonly stateMayHaveChanged: boolean;

  constructor(code: ClaudeFreshContextOwnerErrorCode, stateMayHaveChanged = false) {
    super(`Claude fresh context operation failed (${code.toLowerCase()}).`);
    this.name = "ClaudeFreshContextOwnerError";
    this.code = code;
    this.stateMayHaveChanged = stateMayHaveChanged;
  }
}

export interface ClaudeFreshContextBindingLookup {
  readonly sessionId: string;
  readonly binding: NativeSessionBinding;
  readonly targetId: string;
  readonly workspaceAuthority: string;
  readonly workspaceRoot: string;
}

export interface ClaudeFreshContextIdentity extends ClaudeFreshContextBindingLookup {
  readonly operationId: string;
  readonly sourceSessionId: string;
  readonly sourceBinding: NativeSessionBinding;
}

export interface ClaudeFreshContextSnapshot extends ClaudeFreshContextIdentity {
  readonly backendGeneration: number;
  readonly lifecycle: "reserved" | "adopted" | "cleaned";
  readonly dispatch: "never_dispatched" | "dispatching";
  readonly sourceRetired: boolean;
  readonly revision: number;
}

export interface ClaudeFreshContextSource {
  readonly sourceSessionId: string;
  readonly sourceBinding: NativeSessionBinding;
}

interface Row extends ClaudeFreshContextSnapshot {}

/** Content-free Joko authority. It never implements or writes the SDK SessionStore. */
export class ClaudeFreshContextOwner {
  private readonly rootDirectory: string;
  private readonly namespace: string;
  private readonly generation: number;

  constructor(input: { readonly rootDirectory: string; readonly namespace: string; readonly generation: number }) {
    if (!boundedString(input.rootDirectory, 32_768) || !isAbsolute(input.rootDirectory)
      || !boundedString(input.namespace, 128) || !NAMESPACE.test(input.namespace)
      || !validGeneration(input.generation)) throw failure("INVALID_AUTHORITY");
    this.rootDirectory = resolve(input.rootDirectory).normalize("NFC");
    this.namespace = input.namespace;
    this.generation = input.generation;
  }

  reserve(identity: ClaudeFreshContextIdentity): ClaudeFreshContextSnapshot {
    validateIdentity(identity);
    if (identity.binding.generation !== identity.sourceBinding.generation + 1) throw failure("INVALID_ACCESS");
    return this.withDatabase((database) => transaction(database, () => {
      const existing = findOperation(database, identity.operationId);
      if (existing !== undefined) {
        assertIdentity(existing, identity);
        this.assertWriter(existing);
        return snapshot(existing);
      }
      const collision = database.prepare(`
        SELECT operation_id FROM contexts WHERE binding_opaque_ref = ? OR binding_native_session_id = ?
      `).get(identity.binding.opaqueRef, identity.binding.nativeSessionId!);
      if (collision !== undefined) throw failure("CONFLICT");
      database.prepare(`
        INSERT INTO contexts (
          operation_id, source_session_id, source_opaque_ref, source_native_session_id, source_generation,
          session_id, binding_opaque_ref, binding_native_session_id, binding_generation,
          target_id, workspace_authority, workspace_root, backend_generation,
          lifecycle, dispatch, source_retired, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 'never_dispatched', 0, 1)
      `).run(
        identity.operationId, identity.sourceSessionId, identity.sourceBinding.opaqueRef,
        identity.sourceBinding.nativeSessionId!, identity.sourceBinding.generation,
        identity.sessionId, identity.binding.opaqueRef, identity.binding.nativeSessionId!, identity.binding.generation,
        identity.targetId, identity.workspaceAuthority, identity.workspaceRoot, this.generation
      );
      return snapshot(requireOperation(database, identity.operationId));
    }));
  }

  /** A trusted Host binding may have advanced its Session generation without changing identity. */
  getForBinding(input: ClaudeFreshContextBindingLookup): ClaudeFreshContextSnapshot | undefined {
    validateLookup(input);
    return this.withDatabase((database) => {
      const row = findBinding(database, input);
      if (row === undefined) return undefined;
      assertLookup(row, input, true);
      if (row.backendGeneration > this.generation) throw failure("CONFLICT");
      return snapshot(row);
    });
  }

  /** Read an exact operation receipt, including a reservation whose callback never completed. */
  getForOperation(operationId: string): ClaudeFreshContextSnapshot | undefined {
    if (!boundedString(operationId, 256)) throw failure("INVALID_ACCESS");
    return this.withDatabase((database) => {
      const row = findOperation(database, operationId);
      if (row === undefined) return undefined;
      if (row.backendGeneration > this.generation) throw failure("CONFLICT");
      return snapshot(row);
    });
  }

  /** Rebind only after the prior process and all of its Queries have fully retired. */
  claim(input: ClaudeFreshContextBindingLookup, proof: { readonly retirementConfirmed: true }): ClaudeFreshContextSnapshot {
    validateLookup(input);
    requireRetirement(proof);
    return this.withDatabase((database) => transaction(database, () => {
      const row = findBinding(database, input);
      if (row === undefined) throw failure("NOT_FOUND");
      assertLookup(row, input, true);
      if (row.lifecycle !== "adopted" || !row.sourceRetired || row.backendGeneration > this.generation) {
        throw failure("CONFLICT");
      }
      if (row.backendGeneration === this.generation && row.binding.generation === input.binding.generation) {
        return snapshot(row);
      }
      requireSingleChange(database.prepare(`
        UPDATE contexts SET backend_generation = ?, binding_generation = ?, revision = revision + 1
        WHERE operation_id = ? AND backend_generation = ? AND binding_generation = ? AND revision = ?
          AND lifecycle = 'adopted' AND source_retired = 1
      `).run(this.generation, input.binding.generation, row.operationId,
        row.backendGeneration, row.binding.generation, row.revision).changes);
      return snapshot(requireOperation(database, row.operationId));
    }));
  }

  /** Recover an exact Host receipt; binding generations are not inferred from source generations. */
  recover(identity: ClaudeFreshContextIdentity, proof: { readonly retirementConfirmed: true }): ClaudeFreshContextSnapshot {
    validateIdentity(identity);
    requireRetirement(proof);
    return this.withDatabase((database) => transaction(database, () => {
      const row = requireOperation(database, identity.operationId);
      assertIdentity(row, identity);
      if (row.backendGeneration > this.generation) throw failure("CONFLICT");
      if (row.backendGeneration < this.generation) {
        requireSingleChange(database.prepare(`
          UPDATE contexts SET backend_generation = ?, source_retired = 1, revision = revision + 1
          WHERE operation_id = ? AND backend_generation = ? AND revision = ?
        `).run(this.generation, row.operationId, row.backendGeneration, row.revision).changes);
      }
      return snapshot(requireOperation(database, row.operationId));
    }));
  }

  hasPendingSource(input: ClaudeFreshContextSource): boolean {
    validateSource(input);
    return this.withDatabase((database) => sourceRows(database, input).some((row) => {
      if (row.backendGeneration > this.generation) throw failure("CONFLICT");
      return row.lifecycle === "reserved" && !row.sourceRetired;
    }));
  }

  /** Called only after the caller has awaited complete retirement of this exact source Query. */
  markSourceRetired(input: ClaudeFreshContextSource): void {
    validateSource(input);
    this.withDatabase((database) => transaction(database, () => {
      for (const row of sourceRows(database, input)) {
        if (row.backendGeneration > this.generation) throw failure("CONFLICT");
        if (row.lifecycle !== "reserved" || row.sourceRetired) continue;
        requireSingleChange(database.prepare(`
          UPDATE contexts SET source_retired = 1, revision = revision + 1
          WHERE operation_id = ? AND backend_generation = ? AND revision = ? AND lifecycle = 'reserved'
        `).run(row.operationId, row.backendGeneration, row.revision).changes);
      }
    }));
  }

  adopt(identity: ClaudeFreshContextIdentity, proof: { readonly retirementConfirmed: true }): ClaudeFreshContextSnapshot {
    validateIdentity(identity);
    requireRetirement(proof);
    return this.withDatabase((database) => transaction(database, () => {
      const row = this.requireCurrent(database, identity);
      if (row.lifecycle === "adopted") return snapshot(row);
      if (row.lifecycle !== "reserved" || row.dispatch !== "never_dispatched") throw failure("CONFLICT");
      requireSingleChange(database.prepare(`
        UPDATE contexts SET lifecycle = 'adopted', source_retired = 1, revision = revision + 1
        WHERE operation_id = ? AND backend_generation = ? AND revision = ? AND lifecycle = 'reserved'
          AND dispatch = 'never_dispatched'
      `).run(row.operationId, this.generation, row.revision).changes);
      return snapshot(requireOperation(database, row.operationId));
    }));
  }

  /** Adopted records remain durable; cleanup can only discard an unused reservation. */
  cleanup(identity: ClaudeFreshContextIdentity, proof: { readonly retirementConfirmed: true }): ClaudeFreshContextSnapshot {
    validateIdentity(identity);
    requireRetirement(proof);
    return this.withDatabase((database) => transaction(database, () => {
      const row = requireOperation(database, identity.operationId);
      assertIdentity(row, identity);
      if (row.backendGeneration > this.generation) throw failure("CONFLICT");
      if (row.lifecycle !== "reserved") return snapshot(row);
      if (row.dispatch !== "never_dispatched") throw failure("CONFLICT");
      requireSingleChange(database.prepare(`
        UPDATE contexts SET lifecycle = 'cleaned', backend_generation = ?, revision = revision + 1
        WHERE operation_id = ? AND backend_generation = ? AND revision = ? AND lifecycle = 'reserved'
          AND dispatch = 'never_dispatched'
      `).run(this.generation, row.operationId, row.backendGeneration, row.revision).changes);
      return snapshot(requireOperation(database, row.operationId));
    }));
  }

  /** Caller has retired the Query and publicly proved this adopted child has no native metadata or history. */
  deleteEmptyBinding(input: ClaudeFreshContextBindingLookup, proof: { readonly retirementConfirmed: true }): ClaudeFreshContextSnapshot {
    validateLookup(input);
    requireRetirement(proof);
    return this.withDatabase((database) => transaction(database, () => {
      const row = findBinding(database, input);
      if (row === undefined) throw failure("NOT_FOUND");
      assertLookup(row, input, true);
      if (row.backendGeneration > this.generation || row.lifecycle === "reserved" || row.dispatch !== "never_dispatched") {
        throw failure("CONFLICT");
      }
      if (row.lifecycle === "cleaned" && row.backendGeneration === this.generation
        && row.binding.generation === input.binding.generation) return snapshot(row);
      requireSingleChange(database.prepare(`
        UPDATE contexts SET lifecycle = 'cleaned', backend_generation = ?, binding_generation = ?, revision = revision + 1
        WHERE operation_id = ? AND backend_generation = ? AND binding_generation = ? AND revision = ?
          AND lifecycle IN ('adopted', 'cleaned') AND dispatch = 'never_dispatched'
      `).run(this.generation, input.binding.generation, row.operationId,
        row.backendGeneration, row.binding.generation, row.revision).changes);
      return snapshot(requireOperation(database, row.operationId));
    }));
  }

  /** Must complete synchronously before the SDK iterator receives its first input. */
  markDispatching(claim: ClaudeFreshContextSnapshot): ClaudeFreshContextSnapshot {
    validateIdentity(claim);
    if (claim.backendGeneration !== this.generation || !validGeneration(claim.revision)) throw failure("INVALID_ACCESS");
    return this.withDatabase((database) => transaction(database, () => {
      const row = this.requireCurrent(database, claim);
      if (row.lifecycle !== "adopted" || !row.sourceRetired) throw failure("CONFLICT");
      if (row.dispatch === "dispatching") return snapshot(row);
      if (row.revision !== claim.revision) throw failure("CONFLICT");
      requireSingleChange(database.prepare(`
        UPDATE contexts SET dispatch = 'dispatching', revision = revision + 1
        WHERE operation_id = ? AND backend_generation = ? AND revision = ? AND lifecycle = 'adopted'
          AND dispatch = 'never_dispatched' AND source_retired = 1
      `).run(row.operationId, this.generation, row.revision).changes);
      return snapshot(requireOperation(database, row.operationId));
    }));
  }

  private requireCurrent(database: DatabaseSync, identity: ClaudeFreshContextIdentity): Row {
    const row = requireOperation(database, identity.operationId);
    assertIdentity(row, identity);
    this.assertWriter(row);
    return row;
  }

  private assertWriter(row: Row): void {
    if (row.backendGeneration !== this.generation) throw failure("CONFLICT");
  }

  private withDatabase<T>(callback: (database: DatabaseSync) => T): T {
    let database: DatabaseSync | undefined;
    try {
      const directory = join(this.rootDirectory, STORE_DIRECTORY);
      ensureDirectory(directory);
      const digest = hash(this.namespace);
      const databasePath = join(directory, `${digest}.sqlite`);
      const markerPath = join(directory, `${digest}.initialized`);
      const marker = `${SCHEMA_BASELINE}\n${digest}\n`;
      verifyFiles(databasePath, markerPath);
      const databaseExists = existsSync(databasePath);
      const markerExists = existsSync(markerPath);
      if (markerExists) verifyMarker(markerPath, marker);
      if (markerExists && !databaseExists) throw failure("CORRUPT");
      database = new DatabaseSync(databasePath, {
        allowExtension: false, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false
      });
      database.enableLoadExtension(false);
      database.exec(`
        PRAGMA trusted_schema = OFF;
        PRAGMA busy_timeout = 5000;
        PRAGMA synchronous = FULL;
      `);
      initializeSchema(database, this.namespace, !databaseExists && !markerExists);
      database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 256;");
      const journal = database.prepare("PRAGMA journal_mode").get() as Record<string, unknown> | undefined;
      if (journal?.["journal_mode"] !== "wal") throw failure("STORAGE_UNAVAILABLE");
      verifyFiles(databasePath, markerPath);
      if (!markerExists) {
        try { writeFileSync(markerPath, marker, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true }); }
        catch { /* A concurrent creator may have published the same immutable marker. */ }
        verifyFiles(databasePath, markerPath);
        verifyMarker(markerPath, marker);
      }
      try { chmodSync(databasePath, 0o600); }
      catch { /* On Windows the service-owned directory's ACL remains authoritative. */ }
      return callback(database);
    } catch (error) {
      if (error instanceof ClaudeFreshContextOwnerError) throw error;
      throw failure("STORAGE_UNAVAILABLE");
    } finally {
      try { database?.close(); }
      catch { /* A completed synchronous transaction already established its durable result. */ }
    }
  }
}

function initializeSchema(database: DatabaseSync, namespace: string, mayInitialize: boolean): void {
  const objects = database.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
  if (objects.length === 0) {
    if (!mayInitialize) throw failure("CORRUPT");
    transaction(database, () => {
      if (database.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get() !== undefined) return;
      database.exec(`
        CREATE TABLE owner_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL,
          baseline TEXT NOT NULL, namespace TEXT NOT NULL, schema_digest TEXT NOT NULL
        ) STRICT;
        CREATE TABLE contexts (
          operation_id TEXT PRIMARY KEY, source_session_id TEXT NOT NULL, source_opaque_ref TEXT NOT NULL,
          source_native_session_id TEXT NOT NULL, source_generation INTEGER NOT NULL CHECK (source_generation >= 1),
          session_id TEXT NOT NULL, binding_opaque_ref TEXT NOT NULL UNIQUE, binding_native_session_id TEXT NOT NULL UNIQUE,
          binding_generation INTEGER NOT NULL CHECK (binding_generation > source_generation), target_id TEXT NOT NULL,
          workspace_authority TEXT NOT NULL, workspace_root TEXT NOT NULL,
          backend_generation INTEGER NOT NULL CHECK (backend_generation >= 1),
          lifecycle TEXT NOT NULL CHECK (lifecycle IN ('reserved', 'adopted', 'cleaned')),
          dispatch TEXT NOT NULL CHECK (dispatch IN ('never_dispatched', 'dispatching')),
          source_retired INTEGER NOT NULL CHECK (source_retired IN (0, 1)), revision INTEGER NOT NULL CHECK (revision >= 1),
          CHECK (binding_native_session_id <> source_native_session_id),
          CHECK (binding_opaque_ref <> source_opaque_ref),
          CHECK (dispatch = 'never_dispatched' OR (lifecycle = 'adopted' AND source_retired = 1)),
          CHECK (lifecycle <> 'adopted' OR source_retired = 1)
        ) STRICT;
        CREATE INDEX contexts_source ON contexts (source_session_id, source_opaque_ref, source_native_session_id, source_generation);
        PRAGMA user_version = 1;
      `);
      database.prepare("INSERT INTO owner_meta VALUES (1, ?, ?, ?, ?)").run(
        SCHEMA_VERSION, SCHEMA_BASELINE, namespace, schemaDigest(database)
      );
    });
  }
  const quick = database.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
  const version = database.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  const meta = database.prepare("SELECT * FROM owner_meta WHERE singleton = 1").get() as Record<string, unknown> | undefined;
  if (quick?.["quick_check"] !== "ok" || integer(version?.["user_version"]) !== SCHEMA_VERSION
    || integer(meta?.["schema_version"]) !== SCHEMA_VERSION || meta?.["baseline"] !== SCHEMA_BASELINE
    || meta["namespace"] !== namespace || meta["schema_digest"] !== schemaDigest(database)) throw failure("CORRUPT");
}

function schemaDigest(database: DatabaseSync): string {
  return hash(JSON.stringify(database.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
  `).all()));
}

function ensureDirectory(path: string): void {
  const parents: string[] = [];
  let cursor = resolve(path);
  while (cursor !== parse(cursor).root) {
    parents.push(cursor);
    cursor = dirname(cursor);
  }
  parents.push(cursor);
  for (const parent of parents.reverse()) {
    if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
    const info = lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(realpathSync(parent), parent)) {
      throw failure("INVALID_AUTHORITY");
    }
  }
}

function verifyFiles(databasePath: string, markerPath: string): void {
  for (const path of [databasePath, markerPath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`]) {
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !samePath(realpathSync(path), path)) {
        throw failure("INVALID_AUTHORITY");
      }
    } catch (error) {
      if (error instanceof ClaudeFreshContextOwnerError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw failure("STORAGE_UNAVAILABLE");
    }
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left).normalize("NFC");
  const normalizedRight = resolve(right).normalize("NFC");
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function verifyMarker(path: string, expected: string): void {
  if (lstatSync(path).size !== Buffer.byteLength(expected, "utf8") || readFileSync(path, "utf8") !== expected) {
    throw failure("CORRUPT");
  }
}

function transaction<T>(database: DatabaseSync, callback: () => T): T {
  let commitAttempted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    const result = callback();
    commitAttempted = true;
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK"); }
    catch { /* The fixed failure preserves an uncertain commit without its upstream details. */ }
    if (error instanceof ClaudeFreshContextOwnerError) throw error;
    throw failure(commitAttempted ? "COMMIT_UNKNOWN" : "STORAGE_UNAVAILABLE", commitAttempted);
  }
}

function findOperation(database: DatabaseSync, operationId: string): Row | undefined {
  const row = database.prepare("SELECT * FROM contexts WHERE operation_id = ?").get(operationId);
  return row === undefined ? undefined : decode(row);
}

function requireOperation(database: DatabaseSync, operationId: string): Row {
  const row = findOperation(database, operationId);
  if (row === undefined) throw failure("NOT_FOUND");
  return row;
}

function findBinding(database: DatabaseSync, input: ClaudeFreshContextBindingLookup): Row | undefined {
  const row = database.prepare(`
    SELECT * FROM contexts WHERE binding_opaque_ref = ? OR binding_native_session_id = ?
  `).get(input.binding.opaqueRef, input.binding.nativeSessionId!);
  return row === undefined ? undefined : decode(row);
}

function sourceRows(database: DatabaseSync, input: ClaudeFreshContextSource): Row[] {
  return database.prepare(`
    SELECT * FROM contexts WHERE source_session_id = ? AND source_opaque_ref = ?
      AND source_native_session_id = ? AND source_generation = ?
  `).all(input.sourceSessionId, input.sourceBinding.opaqueRef,
    input.sourceBinding.nativeSessionId!, input.sourceBinding.generation).map(decode);
}

function decode(row: Record<string, unknown>): Row {
  const lifecycle = row["lifecycle"];
  const dispatch = row["dispatch"];
  const retired = integer(row["source_retired"]);
  if ((lifecycle !== "reserved" && lifecycle !== "adopted" && lifecycle !== "cleaned")
    || (dispatch !== "never_dispatched" && dispatch !== "dispatching") || (retired !== 0 && retired !== 1)) {
    throw failure("CORRUPT");
  }
  const result: Row = {
    operationId: string(row["operation_id"]), sourceSessionId: string(row["source_session_id"]),
    sourceBinding: { opaqueRef: string(row["source_opaque_ref"]), nativeSessionId: string(row["source_native_session_id"]),
      generation: integer(row["source_generation"]) },
    sessionId: string(row["session_id"]),
    binding: { opaqueRef: string(row["binding_opaque_ref"]), nativeSessionId: string(row["binding_native_session_id"]),
      generation: integer(row["binding_generation"]) },
    targetId: string(row["target_id"]), workspaceAuthority: string(row["workspace_authority"]),
    workspaceRoot: string(row["workspace_root"]), backendGeneration: integer(row["backend_generation"]),
    lifecycle, dispatch, sourceRetired: retired === 1, revision: integer(row["revision"])
  };
  try { validateIdentity(result); }
  catch { throw failure("CORRUPT"); }
  if (!validGeneration(result.backendGeneration) || !validGeneration(result.revision)
    || (result.lifecycle === "adopted" && !result.sourceRetired)
    || (result.dispatch === "dispatching" && result.lifecycle !== "adopted")) throw failure("CORRUPT");
  return result;
}

function snapshot(row: Row): ClaudeFreshContextSnapshot {
  return Object.freeze({ ...row, sourceBinding: Object.freeze({ ...row.sourceBinding }), binding: Object.freeze({ ...row.binding }) });
}

function assertIdentity(row: Row, identity: ClaudeFreshContextIdentity): void {
  assertLookup(row, identity, false);
  if (row.operationId !== identity.operationId || row.sourceSessionId !== identity.sourceSessionId
    || !sameBinding(row.sourceBinding, identity.sourceBinding)) throw failure("INVALID_ACCESS");
}

function assertLookup(row: Row, input: ClaudeFreshContextBindingLookup, allowHostGeneration: boolean): void {
  if (row.sessionId !== input.sessionId || row.targetId !== input.targetId
    || row.workspaceAuthority !== input.workspaceAuthority || row.workspaceRoot !== input.workspaceRoot
    || row.binding.opaqueRef !== input.binding.opaqueRef || row.binding.nativeSessionId !== input.binding.nativeSessionId
    || (allowHostGeneration ? input.binding.generation < row.binding.generation : input.binding.generation !== row.binding.generation)) {
    throw failure("INVALID_ACCESS");
  }
}

function sameBinding(left: NativeSessionBinding, right: NativeSessionBinding): boolean {
  return left.opaqueRef === right.opaqueRef && left.nativeSessionId === right.nativeSessionId && left.generation === right.generation;
}

function validateIdentity(identity: ClaudeFreshContextIdentity): void {
  validateLookup(identity);
  validateSource(identity);
  if (!boundedString(identity.operationId, 256)
    || identity.binding.generation <= identity.sourceBinding.generation
    || identity.binding.opaqueRef === identity.sourceBinding.opaqueRef
    || identity.binding.nativeSessionId === identity.sourceBinding.nativeSessionId) throw failure("INVALID_ACCESS");
}

function validateLookup(input: ClaudeFreshContextBindingLookup): void {
  if (input === null || typeof input !== "object" || !opaqueAuthority(input.sessionId)
    || !opaqueAuthority(input.targetId) || !opaqueAuthority(input.workspaceAuthority)
    || !boundedString(input.workspaceRoot, 32_768) || !isAbsolute(input.workspaceRoot)
    || input.workspaceRoot.includes("\0")) throw failure("INVALID_ACCESS");
  validateBinding(input.binding);
}

function validateSource(input: ClaudeFreshContextSource): void {
  if (input === null || typeof input !== "object" || !opaqueAuthority(input.sourceSessionId)) throw failure("INVALID_ACCESS");
  validateBinding(input.sourceBinding);
}

function validateBinding(binding: NativeSessionBinding): void {
  if (binding === null || typeof binding !== "object" || !boundedString(binding.opaqueRef, 1_024)
    || !OPAQUE_AUTHORITY.test(binding.opaqueRef) || !boundedString(binding.nativeSessionId, 256)
    || !UUID.test(binding.nativeSessionId) || !validGeneration(binding.generation)) throw failure("INVALID_ACCESS");
}

function requireRetirement(proof: { readonly retirementConfirmed: true }): void {
  if (proof?.retirementConfirmed !== true) throw failure("INVALID_ACCESS");
}

function boundedString(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function opaqueAuthority(value: unknown): value is string {
  return boundedString(value, 256) && OPAQUE_AUTHORITY.test(value);
}

function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function integer(value: unknown): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result)) throw failure("CORRUPT");
  return result;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw failure("CORRUPT");
  return value;
}

function requireSingleChange(changes: number | bigint): void {
  if (integer(changes) !== 1) throw failure("CONFLICT");
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function failure(code: ClaudeFreshContextOwnerErrorCode, stateMayHaveChanged = false): ClaudeFreshContextOwnerError {
  return new ClaudeFreshContextOwnerError(code, stateMayHaveChanged);
}
