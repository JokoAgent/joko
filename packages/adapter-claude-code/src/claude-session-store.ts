import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

const STORE_SCHEMA_VERSION = 1;
const STORE_SCHEMA_BASELINE = "joko-claude-session-store-v1";
const STORE_DIRECTORY = "claude-session-store-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OPAQUE_AUTHORITY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export const CLAUDE_SESSION_STORE_LIMITS = Object.freeze({
  maximumAuthorityBytes: 256,
  maximumNamespaceBytes: 128,
  maximumProjectKeyBytes: 1_024,
  maximumSubpathBytes: 1_024,
  maximumTypeBytes: 256,
  maximumUuidBytes: 256,
  maximumTimestampBytes: 256,
  maximumEntryBytes: 4 * 1024 * 1024,
  maximumBatchBytes: 16 * 1024 * 1024,
  maximumBatchEntries: 512,
  maximumSessionBytes: 256 * 1024 * 1024,
  maximumSessionEntries: 250_000,
  maximumSessionSubkeys: 2_048,
  maximumJsonDepth: 64,
  maximumJsonNodesPerEntry: 200_000,
  maximumJsonNodesPerBatch: 1_000_000
});

export type ClaudeSessionStoreErrorCode =
  | "INVALID_AUTHORITY"
  | "INVALID_ACCESS"
  | "INVALID_KEY"
  | "INVALID_ENTRY"
  | "LIMIT_EXCEEDED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "OPERATION_NOT_READY"
  | "CORRUPT"
  | "STORAGE_UNAVAILABLE"
  | "COMMIT_UNKNOWN"
  | "RESERVATION_REQUIRED"
  | "RESERVATION_FAILED";

/** Fixed-message failure: paths, SDK keys, transcript bodies and upstream errors never enter it. */
export class ClaudeSessionStoreError extends Error {
  readonly code: ClaudeSessionStoreErrorCode;
  readonly stateMayHaveChanged: boolean;

  constructor(
    code: ClaudeSessionStoreErrorCode,
    stateMayHaveChanged = false
  ) {
    super(`Claude SessionStore operation failed (${code.toLowerCase()}).`);
    this.name = "ClaudeSessionStoreError";
    this.code = code;
    this.stateMayHaveChanged = stateMayHaveChanged;
  }
}

export interface ClaudeSessionStoreAuthority {
  readonly schemaVersion: 1;
  /** Stable service-owned data root. It is deliberately independent of a Backend generation. */
  readonly rootDirectory: string;
  /** Stable Joko owner namespace; never an SDK project key. */
  readonly namespace: string;
  /** Exact writer generation. Sessions survive it, but writes do not cross it without a CAS rebind. */
  readonly generation: number;
}

export interface ClaudeSessionStoreSessionAccess {
  readonly kind: "session";
  readonly generation: number;
  readonly workspaceAuthority: string;
  readonly sessionId: string;
}

export interface ClaudeSessionStoreWorkspaceAccess {
  readonly kind: "workspace";
  readonly generation: number;
  readonly workspaceAuthority: string;
}

export interface ClaudeSessionStoreOperationSource {
  readonly kind: "import" | "durable";
  readonly workspaceAuthority: string;
  readonly sessionId: string;
}

export interface ClaudeSessionStoreOperationAccess {
  readonly kind: "operation";
  readonly operationId: string;
  readonly generation: number;
  readonly source: ClaudeSessionStoreOperationSource;
  readonly target: {
    readonly workspaceAuthority: string;
  };
}

export type ClaudeSessionStoreAccess =
  | ClaudeSessionStoreSessionAccess
  | ClaudeSessionStoreWorkspaceAccess
  | ClaudeSessionStoreOperationAccess;

export interface ClaudeSessionStoreChildReservation {
  readonly operationId: string;
  readonly generation: number;
  readonly targetWorkspaceAuthority: string;
  readonly sessionId: string;
}

export interface ClaudeSessionStoreHooks {
  /** Must durably register this exact child before resolving. Repeated calls carry the same identity. */
  readonly onChildReserved?: (reservation: ClaudeSessionStoreChildReservation) => Promise<void>;
}

export type ClaudeSessionStoreOperationState =
  | "importing"
  | "ready"
  | "aliased"
  | "child_pending"
  | "child_reserved"
  | "adopted"
  | "cleaned";

export interface ClaudeSessionStoreOperationSnapshot {
  readonly operationId: string;
  readonly generation: number;
  readonly sourceKind: "import" | "durable";
  readonly sourceWorkspaceAuthority: string;
  readonly targetWorkspaceAuthority: string;
  readonly sourceSessionId: string;
  readonly state: ClaudeSessionStoreOperationState;
  readonly sourceProjectKeyCaptured: boolean;
  readonly targetProjectKeyCaptured: boolean;
  readonly sourceEntryCount: number;
  readonly sourceBytes: number;
  readonly childSessionId?: string;
  readonly childReservationConfirmed: boolean;
  readonly revision: number;
}

interface OperationRow {
  operationId: string;
  generation: number;
  sourceKind: "import" | "durable";
  sourceWorkspaceAuthority: string;
  targetWorkspaceAuthority: string;
  sourceSessionId: string;
  sourceProjectKey: string | null;
  targetProjectKey: string | null;
  state: ClaudeSessionStoreOperationState;
  childSessionId: string | null;
  reservationState: "pending" | "confirmed" | null;
  reservationBatchDigest: string | null;
  sourceEntryCount: number;
  sourceBytes: number;
  revision: number;
}

interface SessionRow {
  workspaceAuthority: string;
  projectKey: string;
  sessionId: string;
  writerGeneration: number;
  lifecycle: "reserved" | "adopted";
  ownerOperationId: string | null;
  reservationState: "pending" | "confirmed" | null;
  revision: number;
  mtime: number;
  entryCount: number;
  byteCount: number;
  subkeyCount: number;
  nextOrdinal: number;
}

interface PreparedEntry {
  readonly value: SessionStoreEntry;
  readonly json: string;
  readonly bytes: number;
  readonly digest: string;
  readonly uuid: string | null;
  readonly nodes: number;
}

interface EntryRow {
  ordinal: unknown;
  uuid: unknown;
  entry_json: unknown;
  entry_bytes: unknown;
  entry_digest: unknown;
}

export function createClaudeSessionStoreAuthority(input: {
  readonly rootDirectory: string;
  readonly namespace: string;
  readonly generation: number;
}): ClaudeSessionStoreAuthority {
  if (!isAbsolute(input.rootDirectory)
    || !validBoundedString(input.namespace, CLAUDE_SESSION_STORE_LIMITS.maximumNamespaceBytes)
    || !NAMESPACE.test(input.namespace)
    || !validGeneration(input.generation)) {
    throw failure("INVALID_AUTHORITY");
  }
  return Object.freeze({
    schemaVersion: 1,
    rootDirectory: resolve(input.rootDirectory).normalize("NFC"),
    namespace: input.namespace.normalize("NFC"),
    generation: input.generation
  });
}

export function createClaudeSessionStoreSessionAccess(input: {
  readonly generation: number;
  readonly workspaceAuthority: string;
  readonly sessionId: string;
}): ClaudeSessionStoreSessionAccess {
  validateGenerationAndSessionAccess(input);
  return Object.freeze({
    kind: "session",
    generation: input.generation,
    workspaceAuthority: input.workspaceAuthority,
    sessionId: input.sessionId
  });
}

export function createClaudeSessionStoreWorkspaceAccess(input: {
  readonly generation: number;
  readonly workspaceAuthority: string;
}): ClaudeSessionStoreWorkspaceAccess {
  if (!validGeneration(input.generation) || !validOpaqueAuthority(input.workspaceAuthority)) {
    throw failure("INVALID_ACCESS");
  }
  return Object.freeze({
    kind: "workspace",
    generation: input.generation,
    workspaceAuthority: input.workspaceAuthority
  });
}

export function prepareClaudeSessionStoreImport(
  authority: ClaudeSessionStoreAuthority,
  input: {
    readonly operationId: string;
    readonly sourceWorkspaceAuthority: string;
    readonly sourceSessionId: string;
    readonly targetWorkspaceAuthority: string;
  }
): ClaudeSessionStoreOperationAccess {
  return prepareOperation(authority, {
    operationId: input.operationId,
    source: {
      kind: "import",
      workspaceAuthority: input.sourceWorkspaceAuthority,
      sessionId: input.sourceSessionId
    },
    target: { workspaceAuthority: input.targetWorkspaceAuthority }
  });
}

/** Prepare a second derivation from a previously adopted, store-backed child. */
export function prepareClaudeSessionStoreDerivation(
  authority: ClaudeSessionStoreAuthority,
  input: {
    readonly operationId: string;
    readonly sourceWorkspaceAuthority: string;
    readonly sourceSessionId: string;
    readonly targetWorkspaceAuthority: string;
  }
): ClaudeSessionStoreOperationAccess {
  return prepareOperation(authority, {
    operationId: input.operationId,
    source: {
      kind: "durable",
      workspaceAuthority: input.sourceWorkspaceAuthority,
      sessionId: input.sourceSessionId
    },
    target: { workspaceAuthority: input.targetWorkspaceAuthority }
  });
}

export function sealClaudeSessionStoreImport(
  authority: ClaudeSessionStoreAuthority,
  access: ClaudeSessionStoreOperationAccess
): void {
  const normalized = normalizeAuthority(authority);
  validateOperationAccess(normalized, access);
  withDatabase(normalized, (database) => transaction(database, () => {
    const operation = requireOperation(database, access);
    if (operation.sourceKind !== "import") throw failure("CONFLICT");
    if (operation.state !== "importing") {
      if (["ready", "aliased", "child_pending", "child_reserved", "adopted", "cleaned"].includes(operation.state)) return;
      throw failure("CONFLICT");
    }
    if (operation.sourceProjectKey === null || operation.sourceEntryCount < 1) {
      throw failure("OPERATION_NOT_READY");
    }
    const result = database.prepare(`
      UPDATE operations
      SET state = 'ready', revision = revision + 1, updated_at = ?
      WHERE operation_id = ? AND generation = ? AND revision = ? AND state = 'importing'
    `).run(now(), access.operationId, access.generation, operation.revision);
    requireSingleChange(result.changes);
  }));
}

export function readClaudeSessionStoreOperation(
  authority: ClaudeSessionStoreAuthority,
  access: ClaudeSessionStoreOperationAccess
): ClaudeSessionStoreOperationSnapshot {
  const normalized = normalizeAuthority(authority);
  validateOperationAccess(normalized, access);
  return withDatabase(normalized, (database) => readTransaction(
    database,
    () => operationSnapshot(requireOperation(database, access))
  ));
}

export function discardClaudeSessionStoreImport(
  authority: ClaudeSessionStoreAuthority,
  access: ClaudeSessionStoreOperationAccess
): void {
  const normalized = normalizeAuthority(authority);
  validateOperationAccess(normalized, access);
  withDatabase(normalized, (database) => transaction(database, () => {
    const operation = requireOperation(database, access);
    if (operation.sourceKind !== "import" || operation.childSessionId !== null
      || !["importing", "ready", "aliased"].includes(operation.state)) {
      throw failure("CONFLICT");
    }
    const result = database.prepare(
      "DELETE FROM operations WHERE operation_id = ? AND generation = ? AND revision = ?"
    ).run(access.operationId, access.generation, operation.revision);
    requireSingleChange(result.changes);
  }));
}

/** Store-side lifecycle fence. Product adoption remains the Host's separate durable transaction. */
export function adoptClaudeSessionStoreChild(
  authority: ClaudeSessionStoreAuthority,
  access: ClaudeSessionStoreOperationAccess,
  childSessionId: string
): ClaudeSessionStoreSessionAccess {
  const normalized = normalizeAuthority(authority);
  validateOperationAccess(normalized, access);
  validateSessionId(childSessionId, "INVALID_ACCESS");
  withDatabase(normalized, (database) => transaction(database, () => {
    const operation = requireOperation(database, access);
    if (operation.childSessionId !== childSessionId || operation.reservationState !== "confirmed"
      || !["child_reserved", "adopted"].includes(operation.state)) {
      throw failure("CONFLICT");
    }
    const session = requireSession(database, access.target.workspaceAuthority, childSessionId);
    assertSessionGeneration(session, access.generation);
    if (operation.state === "adopted") {
      if (session.lifecycle !== "adopted" || session.ownerOperationId !== null || session.reservationState !== null) {
        throw failure("CORRUPT");
      }
      assertSessionIntegrity(database, session);
      return;
    }
    if (session.lifecycle !== "reserved" || session.ownerOperationId !== access.operationId
      || session.reservationState !== "confirmed") {
      throw failure("CORRUPT");
    }
    const childEntries = loadSessionEntries(database, session, undefined);
    if (childEntries === null || session.subkeyCount !== 0 || operation.reservationBatchDigest === null
      || entryBatchDigest(childEntries.map((entry) => prepareEntry(entry, "CORRUPT")))
        !== operation.reservationBatchDigest) {
      throw failure("CORRUPT");
    }
    const sessionChanged = database.prepare(`
      UPDATE sessions
      SET lifecycle = 'adopted', owner_operation_id = NULL, reservation_state = NULL,
          revision = revision + 1
      WHERE workspace_authority = ? AND session_id = ? AND writer_generation = ?
        AND revision = ? AND lifecycle = 'reserved'
    `).run(access.target.workspaceAuthority, childSessionId, access.generation, session.revision);
    requireSingleChange(sessionChanged.changes);
    const operationChanged = database.prepare(`
      UPDATE operations SET state = 'adopted', revision = revision + 1, updated_at = ?
      WHERE operation_id = ? AND generation = ? AND revision = ? AND state = 'child_reserved'
    `).run(now(), access.operationId, access.generation, operation.revision);
    requireSingleChange(operationChanged.changes);
    database.prepare("DELETE FROM operation_source_entries WHERE operation_id = ?").run(access.operationId);
  }));
  return createClaudeSessionStoreSessionAccess({
    generation: normalized.generation,
    workspaceAuthority: access.target.workspaceAuthority,
    sessionId: childSessionId
  });
}

/** Explicit CAS handoff after an adopted Session has moved to a replacement Backend generation. */
export function rebindClaudeSessionStoreGeneration(
  authority: ClaudeSessionStoreAuthority,
  input: {
    readonly workspaceAuthority: string;
    readonly sessionId: string;
    readonly expectedGeneration: number;
  }
): ClaudeSessionStoreSessionAccess {
  const normalized = normalizeAuthority(authority);
  validateGenerationAndSessionAccess({
    generation: input.expectedGeneration,
    workspaceAuthority: input.workspaceAuthority,
    sessionId: input.sessionId
  });
  if (normalized.generation < input.expectedGeneration) throw failure("CONFLICT");
  withDatabase(normalized, (database) => transaction(database, () => {
    const session = requireSession(database, input.workspaceAuthority, input.sessionId);
    if (session.lifecycle !== "adopted" || session.writerGeneration !== input.expectedGeneration) {
      throw failure("CONFLICT");
    }
    if (input.expectedGeneration === normalized.generation) return;
    const result = database.prepare(`
      UPDATE sessions
      SET writer_generation = ?, revision = revision + 1
      WHERE workspace_authority = ? AND session_id = ? AND writer_generation = ?
        AND revision = ? AND lifecycle = 'adopted'
    `).run(normalized.generation, input.workspaceAuthority, input.sessionId, input.expectedGeneration, session.revision);
    requireSingleChange(result.changes);
  }));
  return createClaudeSessionStoreSessionAccess({
    generation: normalized.generation,
    workspaceAuthority: input.workspaceAuthority,
    sessionId: input.sessionId
  });
}

/** Production file-backed implementation of the public alpha SDK SessionStore contract. */
export class ClaudeDurableSessionStore implements SessionStore {
  readonly #authority: ClaudeSessionStoreAuthority;
  readonly #access: ClaudeSessionStoreAccess;
  readonly #hooks: ClaudeSessionStoreHooks;
  #database: DatabaseSync | undefined;

  constructor(
    authority: ClaudeSessionStoreAuthority,
    access: ClaudeSessionStoreAccess,
    hooks: ClaudeSessionStoreHooks = {}
  ) {
    this.#authority = normalizeAuthority(authority);
    this.#access = normalizeAccess(this.#authority, access);
    this.#hooks = Object.freeze({
      ...(typeof hooks.onChildReserved === "function" ? { onChildReserved: hooks.onChildReserved } : {})
    });
    this.#database = openDatabase(this.#authority);
  }

  close(): void {
    const database = this.#database;
    this.#database = undefined;
    if (database !== undefined) {
      try { database.close(); }
      catch { /* A fixed failure is preferable at the operation boundary; close has no durable effect. */ }
    }
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const normalizedKey = validateKey(key);
    const prepared = prepareEntries(entries);
    const database = this.#requireDatabase();
    let pendingReservation: ClaudeSessionStoreChildReservation | undefined;
    try {
      pendingReservation = transaction(database, () => this.#appendInTransaction(database, normalizedKey, prepared));
    } catch (error) {
      throw sanitizeMutationFailure(error);
    }
    if (pendingReservation === undefined) return;
    const callback = this.#hooks.onChildReserved;
    if (callback === undefined) throw failure("RESERVATION_REQUIRED", true);
    try {
      await callback(pendingReservation);
    } catch {
      throw failure("RESERVATION_FAILED", true);
    }
    try {
      transaction(database, () => confirmReservation(database, this.#access, pendingReservation));
    } catch {
      // The child batch and the caller's durable registration both completed.
      // Losing only this local confirmation can never be reported as pre-effect.
      throw failure("COMMIT_UNKNOWN", true);
    }
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const normalizedKey = validateKey(key);
    const database = this.#requireDatabase();
    try {
      const read = () => {
        const route = this.#resolveReadRoute(database, normalizedKey, true);
        if (route === null) return null;
        if (route.kind === "staging") return loadOperationEntries(database, route.operation);
        return loadSessionEntries(database, route.session, normalizedKey.subpath);
      };
      return this.#access.kind === "operation"
        ? transaction(database, read)
        : readTransaction(database, read);
    } catch (error) {
      throw sanitizeReadFailure(error);
    }
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    validateProjectKey(projectKey);
    const database = this.#requireDatabase();
    try {
      return readTransaction(database, () => {
        if (this.#access.kind === "operation") {
          const operation = requireOperation(database, this.#access);
          if (operation.state === "adopted") throw failure("CONFLICT");
          if (operation.targetProjectKey !== projectKey || operation.childSessionId === null) return [];
          const session = requireSession(database, this.#access.target.workspaceAuthority, operation.childSessionId);
          assertOperationChildSession(session, operation, this.#access);
          assertSessionCounts(database, session);
          return session.lifecycle === "adopted" || session.lifecycle === "reserved"
            ? [{ sessionId: session.sessionId, mtime: session.mtime }]
            : [];
        }
        const rows = database.prepare(`
          SELECT *
          FROM sessions
          WHERE workspace_authority = ? AND project_key = ?
          ORDER BY mtime DESC, session_id ASC
        `).all(this.#access.workspaceAuthority, projectKey) as Array<Record<string, unknown>>;
        const result: Array<{ sessionId: string; mtime: number }> = [];
        for (const row of rows) {
          const session = decodeSessionRow(row);
          if (this.#access.kind === "session" && session.sessionId !== this.#access.sessionId) continue;
          if (session.writerGeneration !== this.#access.generation || session.lifecycle !== "adopted") {
            throw failure("CONFLICT");
          }
          assertSessionCounts(database, session);
          result.push({ sessionId: session.sessionId, mtime: session.mtime });
        }
        return result;
      });
    } catch (error) {
      throw sanitizeReadFailure(error);
    }
  }

  async delete(key: SessionKey): Promise<void> {
    const normalizedKey = validateKey(key);
    if (normalizedKey.subpath !== undefined) throw failure("INVALID_KEY");
    const database = this.#requireDatabase();
    try {
      transaction(database, () => this.#deleteInTransaction(database, normalizedKey));
    } catch (error) {
      throw sanitizeMutationFailure(error);
    }
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const normalizedKey = validateKey(key);
    const database = this.#requireDatabase();
    try {
      return readTransaction(database, () => {
        const route = this.#resolveReadRoute(database, normalizedKey, false);
        if (route === null || route.kind === "staging") return [];
        assertSessionCounts(database, route.session);
        const rows = database.prepare(`
          SELECT DISTINCT subpath FROM session_entries
          WHERE workspace_authority = ? AND session_id = ? AND subpath <> ''
          ORDER BY subpath ASC
        `).all(route.session.workspaceAuthority, route.session.sessionId) as Array<Record<string, unknown>>;
        const subkeys = rows.map((row) => requiredString(row["subpath"]));
        if (subkeys.length !== route.session.subkeyCount
          || subkeys.length > CLAUDE_SESSION_STORE_LIMITS.maximumSessionSubkeys) {
          throw failure("CORRUPT");
        }
        for (const subkey of subkeys) validateStoredSubpath(subkey);
        return subkeys;
      });
    } catch (error) {
      throw sanitizeReadFailure(error);
    }
  }

  #requireDatabase(): DatabaseSync {
    if (this.#database === undefined) throw failure("STORAGE_UNAVAILABLE");
    return this.#database;
  }

  #appendInTransaction(
    database: DatabaseSync,
    key: SessionKey,
    entries: readonly PreparedEntry[]
  ): ClaudeSessionStoreChildReservation | undefined {
    if (this.#access.kind === "operation") {
      const operation = requireOperation(database, this.#access);
      if (operation.state === "importing") {
        appendImportEntries(database, operation, this.#access, key, entries);
        return undefined;
      }
      if (operation.childSessionId === null) {
        if (operation.state !== "aliased" || operation.targetProjectKey !== key.projectKey
          || key.sessionId === operation.sourceSessionId || key.subpath !== undefined || entries.length < 1) {
          throw failure("INVALID_KEY");
        }
        createReservedChild(database, operation, this.#access, key, entries);
      } else {
        if (operation.targetProjectKey !== key.projectKey || operation.childSessionId !== key.sessionId
          || !["child_pending", "child_reserved"].includes(operation.state)) {
          throw failure("INVALID_KEY");
        }
        const session = requireSession(database, this.#access.target.workspaceAuthority, key.sessionId);
        assertOperationChildSession(session, operation, this.#access);
        assertSessionIntegrity(database, session);
        if (operation.state === "child_pending" || operation.state === "child_reserved") {
          if (key.subpath !== undefined || operation.reservationBatchDigest === null
            || operation.reservationBatchDigest !== entryBatchDigest(entries)) {
            throw failure("CONFLICT", operation.state === "child_pending");
          }
          // A rejected append is retried by the SDK. The first transaction is
          // already durable: pending retries repeat only the callback, while a
          // confirmed exact replay is a no-op. UUID-less entries stay singular.
        }
      }
      const refreshed = requireOperation(database, this.#access);
      if (refreshed.childSessionId !== null && refreshed.reservationState === "pending") {
        return Object.freeze({
          operationId: refreshed.operationId,
          generation: refreshed.generation,
          targetWorkspaceAuthority: refreshed.targetWorkspaceAuthority,
          sessionId: refreshed.childSessionId
        });
      }
      return undefined;
    }
    if (key.sessionId !== (this.#access.kind === "session" ? this.#access.sessionId : key.sessionId)) {
      throw failure("INVALID_KEY");
    }
    const session = findSession(database, this.#access.workspaceAuthority, key.sessionId);
    if (session === null) throw failure("NOT_FOUND");
    if (session.projectKey !== key.projectKey || session.lifecycle !== "adopted") throw failure("INVALID_KEY");
    assertSessionGeneration(session, this.#access.generation);
    assertSessionIntegrity(database, session);
    appendSessionEntries(database, session, key.subpath, entries, false);
    return undefined;
  }

  #resolveReadRoute(
    database: DatabaseSync,
    key: SessionKey,
    captureTarget: boolean
  ): { kind: "staging"; operation: OperationRow } | { kind: "session"; session: SessionRow } | null {
    if (this.#access.kind === "operation") {
      let operation = requireOperation(database, this.#access);
      if (operation.state === "adopted") throw failure("CONFLICT");
      if (operation.state === "importing") throw failure("OPERATION_NOT_READY");
      if (key.sessionId === operation.sourceSessionId) {
        if (key.subpath !== undefined) throw failure("INVALID_KEY");
        if (operation.state === "cleaned") throw failure("NOT_FOUND");
        if (operation.targetProjectKey === null) {
          if (!captureTarget) throw failure("OPERATION_NOT_READY");
          const current = requireOperation(database, this.#access);
          if (current.targetProjectKey !== null) {
            if (current.targetProjectKey !== key.projectKey) throw failure("INVALID_KEY");
          } else {
            if (current.state !== "ready") throw failure("CONFLICT");
            const changed = database.prepare(`
              UPDATE operations
              SET target_project_key = ?, state = 'aliased', revision = revision + 1, updated_at = ?
              WHERE operation_id = ? AND generation = ? AND revision = ? AND state = 'ready'
                AND target_project_key IS NULL
            `).run(key.projectKey, now(), current.operationId, current.generation, current.revision);
            requireSingleChange(changed.changes);
          }
          operation = requireOperation(database, this.#access);
        }
        if (operation.targetProjectKey !== key.projectKey) throw failure("INVALID_KEY");
        if (operation.sourceKind === "import") return { kind: "staging", operation };
        const session = requireSession(database, operation.sourceWorkspaceAuthority, operation.sourceSessionId);
        if (session.lifecycle !== "adopted") throw failure("CONFLICT");
        assertSessionGeneration(session, operation.generation);
        return { kind: "session", session };
      }
      if (operation.childSessionId !== key.sessionId || operation.targetProjectKey !== key.projectKey) {
        throw failure("INVALID_KEY");
      }
      const session = findSession(database, operation.targetWorkspaceAuthority, key.sessionId);
      if (session === null) return null;
      assertOperationChildSession(session, operation, this.#access);
      return { kind: "session", session };
    }
    if (this.#access.kind === "session" && key.sessionId !== this.#access.sessionId) {
      throw failure("INVALID_KEY");
    }
    const session = findSession(database, this.#access.workspaceAuthority, key.sessionId);
    if (session === null) return null;
    if (session.projectKey !== key.projectKey || session.lifecycle !== "adopted") throw failure("INVALID_KEY");
    assertSessionGeneration(session, this.#access.generation);
    return { kind: "session", session };
  }

  #deleteInTransaction(database: DatabaseSync, key: SessionKey): void {
    if (this.#access.kind === "operation") {
      const operation = requireOperation(database, this.#access);
      if (operation.childSessionId !== key.sessionId || operation.targetProjectKey !== key.projectKey
        || !["child_pending", "child_reserved"].includes(operation.state)) {
        throw failure("INVALID_KEY");
      }
      const session = requireSession(database, operation.targetWorkspaceAuthority, key.sessionId);
      assertOperationChildSession(session, operation, this.#access);
      const removed = database.prepare(`
        DELETE FROM sessions
        WHERE workspace_authority = ? AND session_id = ? AND writer_generation = ? AND revision = ?
      `).run(session.workspaceAuthority, session.sessionId, session.writerGeneration, session.revision);
      requireSingleChange(removed.changes);
      const changed = database.prepare(`
        UPDATE operations SET state = 'cleaned', revision = revision + 1, updated_at = ?
        WHERE operation_id = ? AND generation = ? AND revision = ?
      `).run(now(), operation.operationId, operation.generation, operation.revision);
      requireSingleChange(changed.changes);
      database.prepare("DELETE FROM operation_source_entries WHERE operation_id = ?").run(operation.operationId);
      return;
    }
    if (this.#access.kind === "session" && key.sessionId !== this.#access.sessionId) {
      throw failure("INVALID_KEY");
    }
    const session = findSession(database, this.#access.workspaceAuthority, key.sessionId);
    if (session === null) return;
    if (session.projectKey !== key.projectKey || session.lifecycle !== "adopted") throw failure("INVALID_KEY");
    assertSessionGeneration(session, this.#access.generation);
    const removed = database.prepare(`
      DELETE FROM sessions
      WHERE workspace_authority = ? AND session_id = ? AND writer_generation = ? AND revision = ?
    `).run(session.workspaceAuthority, session.sessionId, session.writerGeneration, session.revision);
    requireSingleChange(removed.changes);
  }
}

export function createClaudeDurableSessionStore(
  authority: ClaudeSessionStoreAuthority,
  access: ClaudeSessionStoreAccess,
  hooks: ClaudeSessionStoreHooks = {}
): ClaudeDurableSessionStore {
  return new ClaudeDurableSessionStore(authority, access, hooks);
}

function prepareOperation(
  authority: ClaudeSessionStoreAuthority,
  input: {
    readonly operationId: string;
    readonly source: ClaudeSessionStoreOperationSource;
    readonly target: { readonly workspaceAuthority: string };
  }
): ClaudeSessionStoreOperationAccess {
  const normalized = normalizeAuthority(authority);
  const access: ClaudeSessionStoreOperationAccess = Object.freeze({
    kind: "operation",
    operationId: input.operationId,
    generation: normalized.generation,
    source: Object.freeze({ ...input.source }),
    target: Object.freeze({ ...input.target })
  });
  validateOperationAccess(normalized, access);
  withDatabase(normalized, (database) => transaction(database, () => {
    const existing = findOperation(database, access.operationId);
    if (existing !== null) {
      requireOperation(database, access);
      return;
    }
    if (access.source.kind === "durable") {
      const source = requireSession(database, access.source.workspaceAuthority, access.source.sessionId);
      if (source.lifecycle !== "adopted") throw failure("CONFLICT");
      assertSessionGeneration(source, access.generation);
      assertSessionCounts(database, source);
    }
    const created = now();
    database.prepare(`
      INSERT INTO operations (
        operation_id, generation, source_kind, source_workspace_authority,
        target_workspace_authority, source_session_id, source_project_key,
        target_project_key, state, child_session_id, reservation_state, reservation_batch_digest,
        source_entry_count, source_bytes, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, 0, 0, 1, ?, ?)
    `).run(
      access.operationId,
      access.generation,
      access.source.kind,
      access.source.workspaceAuthority,
      access.target.workspaceAuthority,
      access.source.sessionId,
      access.source.kind === "import" ? "importing" : "ready",
      created,
      created
    );
  }));
  return access;
}

function appendImportEntries(
  database: DatabaseSync,
  operation: OperationRow,
  access: ClaudeSessionStoreOperationAccess,
  key: SessionKey,
  entries: readonly PreparedEntry[]
): void {
  if (operation.sourceKind !== "import" || operation.state !== "importing"
    || key.sessionId !== operation.sourceSessionId || key.subpath !== undefined) {
    throw failure("INVALID_KEY");
  }
  if (operation.sourceProjectKey !== null && operation.sourceProjectKey !== key.projectKey) {
    throw failure("INVALID_KEY");
  }
  const pending = deduplicateOperationEntries(database, operation.operationId, entries);
  const additionalBytes = sumBytes(pending);
  assertSessionBudget(operation.sourceEntryCount, operation.sourceBytes, 0, pending.length, additionalBytes, 0);
  let ordinal = operation.sourceEntryCount;
  const insert = database.prepare(`
    INSERT INTO operation_source_entries (
      operation_id, ordinal, uuid, entry_json, entry_bytes, entry_digest
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const entry of pending) {
    insert.run(access.operationId, ordinal++, entry.uuid, entry.json, entry.bytes, entry.digest);
  }
  const result = database.prepare(`
    UPDATE operations
    SET source_project_key = COALESCE(source_project_key, ?),
        source_entry_count = source_entry_count + ?, source_bytes = source_bytes + ?,
        revision = revision + 1, updated_at = ?
    WHERE operation_id = ? AND generation = ? AND revision = ? AND state = 'importing'
      AND (source_project_key IS NULL OR source_project_key = ?)
  `).run(
    key.projectKey,
    pending.length,
    additionalBytes,
    now(),
    access.operationId,
    access.generation,
    operation.revision,
    key.projectKey
  );
  requireSingleChange(result.changes);
}

function createReservedChild(
  database: DatabaseSync,
  operation: OperationRow,
  access: ClaudeSessionStoreOperationAccess,
  key: SessionKey,
  entries: readonly PreparedEntry[]
): void {
  assertSessionBudget(0, 0, 0, entries.length, sumBytes(entries), 0);
  const mtime = now();
  database.prepare(`
    INSERT INTO sessions (
      workspace_authority, project_key, session_id, writer_generation, lifecycle,
      owner_operation_id, reservation_state, revision, mtime, entry_count,
      byte_count, subkey_count, next_ordinal
    ) VALUES (?, ?, ?, ?, 'reserved', ?, 'pending', 1, ?, 0, 0, 0, 0)
  `).run(
    access.target.workspaceAuthority,
    key.projectKey,
    key.sessionId,
    access.generation,
    access.operationId,
    mtime
  );
  const session = requireSession(database, access.target.workspaceAuthority, key.sessionId);
  appendSessionEntries(database, session, undefined, entries, true);
  const result = database.prepare(`
    UPDATE operations
    SET child_session_id = ?, reservation_state = 'pending', reservation_batch_digest = ?,
        state = 'child_pending',
        revision = revision + 1, updated_at = ?
    WHERE operation_id = ? AND generation = ? AND revision = ? AND state = 'aliased'
      AND child_session_id IS NULL
  `).run(
    key.sessionId,
    entryBatchDigest(entries),
    now(),
    access.operationId,
    access.generation,
    operation.revision
  );
  requireSingleChange(result.changes);
}

function appendSessionEntries(
  database: DatabaseSync,
  session: SessionRow,
  subpath: string | undefined,
  entries: readonly PreparedEntry[],
  allowReserved: boolean
): void {
  assertSessionGeneration(session, session.writerGeneration);
  if (session.lifecycle !== "adopted" && !(allowReserved && session.lifecycle === "reserved")) {
    throw failure("CONFLICT");
  }
  const normalizedSubpath = subpath ?? "";
  const pending = deduplicateSessionEntries(database, session, normalizedSubpath, entries);
  if (pending.length === 0) return;
  const isNewSubkey = normalizedSubpath !== "" && database.prepare(`
    SELECT 1 AS present FROM session_entries
    WHERE workspace_authority = ? AND session_id = ? AND subpath = ? LIMIT 1
  `).get(session.workspaceAuthority, session.sessionId, normalizedSubpath) === undefined;
  const additionalBytes = sumBytes(pending);
  assertSessionBudget(
    session.entryCount,
    session.byteCount,
    session.subkeyCount,
    pending.length,
    additionalBytes,
    isNewSubkey ? 1 : 0
  );
  let ordinal = session.nextOrdinal;
  const insert = database.prepare(`
    INSERT INTO session_entries (
      workspace_authority, session_id, subpath, ordinal, uuid,
      entry_json, entry_bytes, entry_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const entry of pending) {
    insert.run(
      session.workspaceAuthority,
      session.sessionId,
      normalizedSubpath,
      ordinal++,
      entry.uuid,
      entry.json,
      entry.bytes,
      entry.digest
    );
  }
  const nextMtime = Math.max(now(), session.mtime + 1);
  const result = database.prepare(`
    UPDATE sessions
    SET revision = revision + 1, mtime = ?, entry_count = entry_count + ?,
        byte_count = byte_count + ?, subkey_count = subkey_count + ?, next_ordinal = ?
    WHERE workspace_authority = ? AND session_id = ? AND writer_generation = ? AND revision = ?
  `).run(
    nextMtime,
    pending.length,
    additionalBytes,
    isNewSubkey ? 1 : 0,
    ordinal,
    session.workspaceAuthority,
    session.sessionId,
    session.writerGeneration,
    session.revision
  );
  requireSingleChange(result.changes);
}

function deduplicateOperationEntries(
  database: DatabaseSync,
  operationId: string,
  entries: readonly PreparedEntry[]
): PreparedEntry[] {
  const pending: PreparedEntry[] = [];
  const batchUuids = new Map<string, PreparedEntry>();
  const lookup = database.prepare(`
    SELECT entry_json, entry_digest FROM operation_source_entries
    WHERE operation_id = ? AND uuid = ?
  `);
  for (const entry of entries) {
    if (entry.uuid === null) {
      pending.push(entry);
      continue;
    }
    const withinBatch = batchUuids.get(entry.uuid);
    if (withinBatch !== undefined) {
      if (withinBatch.digest !== entry.digest || withinBatch.json !== entry.json) throw failure("CONFLICT");
      continue;
    }
    batchUuids.set(entry.uuid, entry);
    const existing = lookup.get(operationId, entry.uuid) as Record<string, unknown> | undefined;
    if (existing === undefined) {
      pending.push(entry);
      continue;
    }
    if (existing["entry_digest"] !== entry.digest || existing["entry_json"] !== entry.json) {
      throw failure("CONFLICT");
    }
  }
  return pending;
}

function deduplicateSessionEntries(
  database: DatabaseSync,
  session: SessionRow,
  subpath: string,
  entries: readonly PreparedEntry[]
): PreparedEntry[] {
  const pending: PreparedEntry[] = [];
  const batchUuids = new Map<string, PreparedEntry>();
  const lookup = database.prepare(`
    SELECT entry_json, entry_digest FROM session_entries
    WHERE workspace_authority = ? AND session_id = ? AND subpath = ? AND uuid = ?
  `);
  for (const entry of entries) {
    if (entry.uuid === null) {
      pending.push(entry);
      continue;
    }
    const withinBatch = batchUuids.get(entry.uuid);
    if (withinBatch !== undefined) {
      if (withinBatch.digest !== entry.digest || withinBatch.json !== entry.json) throw failure("CONFLICT");
      continue;
    }
    batchUuids.set(entry.uuid, entry);
    const existing = lookup.get(session.workspaceAuthority, session.sessionId, subpath, entry.uuid) as
      Record<string, unknown> | undefined;
    if (existing === undefined) {
      pending.push(entry);
      continue;
    }
    if (existing["entry_digest"] !== entry.digest || existing["entry_json"] !== entry.json) {
      throw failure("CONFLICT");
    }
  }
  return pending;
}

function confirmReservation(
  database: DatabaseSync,
  access: ClaudeSessionStoreAccess,
  reservation: ClaudeSessionStoreChildReservation
): void {
  if (access.kind !== "operation" || access.operationId !== reservation.operationId
    || access.generation !== reservation.generation
    || access.target.workspaceAuthority !== reservation.targetWorkspaceAuthority) {
    throw failure("INVALID_ACCESS", true);
  }
  const operation = requireOperation(database, access);
  if (operation.childSessionId !== reservation.sessionId) throw failure("CONFLICT", true);
  if (operation.reservationState === "confirmed") return;
  if (operation.state !== "child_pending" || operation.reservationState !== "pending") {
    throw failure("CONFLICT", true);
  }
  const session = requireSession(database, reservation.targetWorkspaceAuthority, reservation.sessionId);
  assertOperationChildSession(session, operation, access);
  const sessionChanged = database.prepare(`
    UPDATE sessions SET reservation_state = 'confirmed', revision = revision + 1
    WHERE workspace_authority = ? AND session_id = ? AND writer_generation = ?
      AND revision = ? AND lifecycle = 'reserved' AND reservation_state = 'pending'
  `).run(session.workspaceAuthority, session.sessionId, session.writerGeneration, session.revision);
  requireSingleChange(sessionChanged.changes);
  const operationChanged = database.prepare(`
    UPDATE operations
    SET reservation_state = 'confirmed', state = 'child_reserved',
        revision = revision + 1, updated_at = ?
    WHERE operation_id = ? AND generation = ? AND revision = ?
      AND state = 'child_pending' AND reservation_state = 'pending'
  `).run(now(), operation.operationId, operation.generation, operation.revision);
  requireSingleChange(operationChanged.changes);
}

function loadOperationEntries(database: DatabaseSync, operation: OperationRow): SessionStoreEntry[] {
  if (operation.sourceKind !== "import" || operation.state === "importing") throw failure("OPERATION_NOT_READY");
  if (operation.sourceEntryCount > CLAUDE_SESSION_STORE_LIMITS.maximumSessionEntries
    || operation.sourceBytes > CLAUDE_SESSION_STORE_LIMITS.maximumSessionBytes) {
    throw failure("CORRUPT");
  }
  const rows = database.prepare(`
    SELECT ordinal, uuid, entry_json, entry_bytes, entry_digest
    FROM operation_source_entries WHERE operation_id = ? ORDER BY ordinal ASC
  `).all(operation.operationId) as unknown as EntryRow[];
  if (rows.length !== operation.sourceEntryCount) throw failure("CORRUPT");
  return decodeEntryRows(rows, operation.sourceBytes);
}

function loadSessionEntries(
  database: DatabaseSync,
  session: SessionRow,
  subpath: string | undefined
): SessionStoreEntry[] | null {
  assertSessionCounts(database, session);
  const rows = database.prepare(`
    SELECT ordinal, uuid, entry_json, entry_bytes, entry_digest
    FROM session_entries
    WHERE workspace_authority = ? AND session_id = ? AND subpath = ?
    ORDER BY ordinal ASC
  `).all(session.workspaceAuthority, session.sessionId, subpath ?? "") as unknown as EntryRow[];
  if (rows.length === 0) return null;
  return decodeEntryRows(rows);
}

function decodeEntryRows(rows: readonly EntryRow[], expectedBytes?: number): SessionStoreEntry[] {
  let bytes = 0;
  let previousOrdinal = -1;
  const result: SessionStoreEntry[] = [];
  for (const row of rows) {
    const ordinal = sqlInteger(row.ordinal);
    const json = requiredString(row.entry_json);
    const storedBytes = sqlInteger(row.entry_bytes);
    const digest = requiredString(row.entry_digest);
    if (ordinal <= previousOrdinal || Buffer.byteLength(json, "utf8") !== storedBytes
      || hashText(json) !== digest) {
      throw failure("CORRUPT");
    }
    previousOrdinal = ordinal;
    bytes += storedBytes;
    let value: unknown;
    try { value = JSON.parse(json); }
    catch { throw failure("CORRUPT"); }
    const prepared = prepareEntry(value, "CORRUPT");
    if (prepared.json !== json || prepared.bytes !== storedBytes || prepared.digest !== digest
      || (row.uuid === null ? prepared.uuid !== null : row.uuid !== prepared.uuid)) {
      throw failure("CORRUPT");
    }
    result.push(prepared.value);
  }
  if (expectedBytes !== undefined && bytes !== expectedBytes) throw failure("CORRUPT");
  return result;
}

function assertSessionCounts(database: DatabaseSync, session: SessionRow): void {
  if (session.entryCount < 0 || session.entryCount > CLAUDE_SESSION_STORE_LIMITS.maximumSessionEntries
    || session.byteCount < 0 || session.byteCount > CLAUDE_SESSION_STORE_LIMITS.maximumSessionBytes
    || session.subkeyCount < 0 || session.subkeyCount > CLAUDE_SESSION_STORE_LIMITS.maximumSessionSubkeys
    || session.nextOrdinal < session.entryCount) {
    throw failure("CORRUPT");
  }
  const row = database.prepare(`
    SELECT COUNT(*) AS entry_count, COALESCE(SUM(entry_bytes), 0) AS byte_count,
      COUNT(DISTINCT CASE WHEN subpath <> '' THEN subpath END) AS subkey_count,
      COALESCE(MAX(ordinal) + 1, 0) AS next_ordinal
    FROM session_entries WHERE workspace_authority = ? AND session_id = ?
  `).get(session.workspaceAuthority, session.sessionId) as Record<string, unknown> | undefined;
  if (row === undefined
    || sqlInteger(row["entry_count"]) !== session.entryCount
    || sqlInteger(row["byte_count"]) !== session.byteCount
    || sqlInteger(row["subkey_count"]) !== session.subkeyCount
    || sqlInteger(row["next_ordinal"]) !== session.nextOrdinal) {
    throw failure("CORRUPT");
  }
}

function assertSessionIntegrity(database: DatabaseSync, session: SessionRow): void {
  assertSessionCounts(database, session);
  const rows = database.prepare(`
    SELECT ordinal, uuid, entry_json, entry_bytes, entry_digest, subpath
    FROM session_entries
    WHERE workspace_authority = ? AND session_id = ?
    ORDER BY ordinal ASC
  `).all(session.workspaceAuthority, session.sessionId) as unknown as Array<EntryRow & { readonly subpath: unknown }>;
  if (rows.length !== session.entryCount) throw failure("CORRUPT");
  for (const row of rows) {
    const subpath = requiredString(row.subpath);
    if (subpath !== "") validateStoredSubpath(subpath);
  }
  decodeEntryRows(rows, session.byteCount);
}

function assertSessionBudget(
  entryCount: number,
  byteCount: number,
  subkeyCount: number,
  additionalEntries: number,
  additionalBytes: number,
  additionalSubkeys: number
): void {
  if (entryCount + additionalEntries > CLAUDE_SESSION_STORE_LIMITS.maximumSessionEntries
    || byteCount + additionalBytes > CLAUDE_SESSION_STORE_LIMITS.maximumSessionBytes
    || subkeyCount + additionalSubkeys > CLAUDE_SESSION_STORE_LIMITS.maximumSessionSubkeys) {
    throw failure("LIMIT_EXCEEDED");
  }
}

function prepareEntries(entries: SessionStoreEntry[]): PreparedEntry[] {
  if (!Array.isArray(entries)) throw failure("INVALID_ENTRY");
  if (entries.length > CLAUDE_SESSION_STORE_LIMITS.maximumBatchEntries) throw failure("LIMIT_EXCEEDED");
  const prepared: PreparedEntry[] = [];
  let bytes = 0;
  let nodes = 0;
  for (const entry of entries) {
    const item = prepareEntry(entry, "INVALID_ENTRY");
    prepared.push(item);
    bytes += item.bytes;
    nodes += item.nodes;
    if (bytes > CLAUDE_SESSION_STORE_LIMITS.maximumBatchBytes
      || nodes > CLAUDE_SESSION_STORE_LIMITS.maximumJsonNodesPerBatch) {
      throw failure("LIMIT_EXCEEDED");
    }
  }
  return prepared;
}

function prepareEntry(value: unknown, invalidCode: "INVALID_ENTRY" | "CORRUPT"): PreparedEntry {
  const budget = { nodes: 0 };
  validateJsonValue(value, 1, budget, invalidCode);
  if (!isPlainObject(value)) throw failure(invalidCode);
  const entry = value as Record<string, unknown>;
  if (!Object.hasOwn(entry, "type")
    || !validBoundedString(entry["type"], CLAUDE_SESSION_STORE_LIMITS.maximumTypeBytes)) {
    throw failure(invalidCode);
  }
  if (Object.hasOwn(entry, "uuid") && entry["uuid"] !== undefined
    && !validBoundedString(entry["uuid"], CLAUDE_SESSION_STORE_LIMITS.maximumUuidBytes)) {
    throw failure(invalidCode);
  }
  if (Object.hasOwn(entry, "timestamp") && entry["timestamp"] !== undefined
    && !validBoundedString(entry["timestamp"], CLAUDE_SESSION_STORE_LIMITS.maximumTimestampBytes)) {
    throw failure(invalidCode);
  }
  const json = canonicalJson(value);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > CLAUDE_SESSION_STORE_LIMITS.maximumEntryBytes) {
    throw failure(invalidCode === "CORRUPT" ? "CORRUPT" : "LIMIT_EXCEEDED");
  }
  let cloned: unknown;
  try { cloned = JSON.parse(json); }
  catch { throw failure(invalidCode); }
  return {
    value: cloned as SessionStoreEntry,
    json,
    bytes,
    digest: hashText(json),
    uuid: Object.hasOwn(entry, "uuid") && typeof entry["uuid"] === "string" ? entry["uuid"] : null,
    nodes: budget.nodes
  };
}

function validateJsonValue(
  value: unknown,
  depth: number,
  budget: { nodes: number },
  invalidCode: "INVALID_ENTRY" | "CORRUPT",
  seen = new Set<object>()
): void {
  budget.nodes += 1;
  if (depth > CLAUDE_SESSION_STORE_LIMITS.maximumJsonDepth
    || budget.nodes > CLAUDE_SESSION_STORE_LIMITS.maximumJsonNodesPerEntry) {
    throw failure(invalidCode === "CORRUPT" ? "CORRUPT" : "LIMIT_EXCEEDED");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw failure(invalidCode);
    return;
  }
  if (typeof value !== "object") throw failure(invalidCode);
  if (seen.has(value)) throw failure(invalidCode);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors).filter((key) => key !== "length");
      if (keys.some((key) => typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)
        || Number(key) >= value.length) || keys.length !== value.length) {
        throw failure(invalidCode);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw failure(invalidCode);
        validateJsonValue(descriptor.value, depth + 1, budget, invalidCode, seen);
      }
      return;
    }
    if (!isPlainObject(value)) throw failure(invalidCode);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw failure(invalidCode);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw failure(invalidCode);
      validateJsonValue(descriptor.value, depth + 1, budget, invalidCode, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateKey(key: SessionKey | { projectKey: string; sessionId: string }): SessionKey {
  if (!isPlainObject(key)) throw failure("INVALID_KEY");
  validateProjectKey(key.projectKey);
  validateSessionId(key.sessionId, "INVALID_KEY");
  const subpath = "subpath" in key ? key.subpath : undefined;
  if (subpath !== undefined) validateSubpath(subpath);
  return Object.freeze({ projectKey: key.projectKey, sessionId: key.sessionId, ...(subpath === undefined ? {} : { subpath }) });
}

function validateProjectKey(projectKey: unknown): asserts projectKey is string {
  if (!isValidProjectKey(projectKey)) {
    throw failure("INVALID_KEY");
  }
}

function validateSubpath(subpath: unknown): asserts subpath is string {
  if (!isValidSubpath(subpath)) {
    throw failure("INVALID_KEY");
  }
}

function validateStoredProjectKey(projectKey: unknown): asserts projectKey is string {
  if (!isValidProjectKey(projectKey)) throw failure("CORRUPT");
}

function validateStoredSubpath(subpath: unknown): asserts subpath is string {
  if (!isValidSubpath(subpath)) throw failure("CORRUPT");
}

function isValidProjectKey(projectKey: unknown): projectKey is string {
  return validBoundedString(projectKey, CLAUDE_SESSION_STORE_LIMITS.maximumProjectKeyBytes)
    && !/[\u0000-\u001f\u007f]/u.test(projectKey);
}

function isValidSubpath(subpath: unknown): subpath is string {
  return validBoundedString(subpath, CLAUDE_SESSION_STORE_LIMITS.maximumSubpathBytes)
    && !/[\u0000-\u001f\u007f]/u.test(subpath);
}

function validateSessionId(value: unknown, code: "INVALID_ACCESS" | "INVALID_KEY"): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) throw failure(code);
}

function validateGenerationAndSessionAccess(input: {
  readonly generation: number;
  readonly workspaceAuthority: string;
  readonly sessionId: string;
}): void {
  if (!validGeneration(input.generation) || !validOpaqueAuthority(input.workspaceAuthority)) {
    throw failure("INVALID_ACCESS");
  }
  validateSessionId(input.sessionId, "INVALID_ACCESS");
}

function normalizeAuthority(authority: ClaudeSessionStoreAuthority): ClaudeSessionStoreAuthority {
  if (!isPlainObject(authority) || authority.schemaVersion !== 1) throw failure("INVALID_AUTHORITY");
  const normalized = createClaudeSessionStoreAuthority(authority);
  if (normalized.rootDirectory !== authority.rootDirectory.normalize("NFC")
    || normalized.namespace !== authority.namespace.normalize("NFC")) {
    throw failure("INVALID_AUTHORITY");
  }
  return normalized;
}

function normalizeAccess(authority: ClaudeSessionStoreAuthority, access: ClaudeSessionStoreAccess): ClaudeSessionStoreAccess {
  if (!isPlainObject(access) || access.generation !== authority.generation) throw failure("INVALID_ACCESS");
  if (access.kind === "operation") {
    validateOperationAccess(authority, access);
    return Object.freeze({
      kind: "operation",
      operationId: access.operationId,
      generation: access.generation,
      source: Object.freeze({
        kind: access.source.kind,
        workspaceAuthority: access.source.workspaceAuthority,
        sessionId: access.source.sessionId
      }),
      target: Object.freeze({ workspaceAuthority: access.target.workspaceAuthority })
    });
  }
  if (access.kind === "session") {
    validateGenerationAndSessionAccess(access);
    return Object.freeze({
      kind: "session",
      generation: access.generation,
      workspaceAuthority: access.workspaceAuthority,
      sessionId: access.sessionId
    });
  }
  if (access.kind === "workspace") {
    if (!validGeneration(access.generation) || !validOpaqueAuthority(access.workspaceAuthority)) {
      throw failure("INVALID_ACCESS");
    }
    return Object.freeze({
      kind: "workspace",
      generation: access.generation,
      workspaceAuthority: access.workspaceAuthority
    });
  }
  throw failure("INVALID_ACCESS");
}

function validateOperationAccess(authority: ClaudeSessionStoreAuthority, access: ClaudeSessionStoreOperationAccess): void {
  if (!isPlainObject(access) || access.kind !== "operation" || access.generation !== authority.generation
    || !UUID.test(access.operationId) || !isPlainObject(access.source) || !isPlainObject(access.target)
    || !["import", "durable"].includes(access.source.kind)
    || !validOpaqueAuthority(access.source.workspaceAuthority)
    || !validOpaqueAuthority(access.target.workspaceAuthority)) {
    throw failure("INVALID_ACCESS");
  }
  validateSessionId(access.source.sessionId, "INVALID_ACCESS");
}

function validOpaqueAuthority(value: unknown): value is string {
  return validBoundedString(value, CLAUDE_SESSION_STORE_LIMITS.maximumAuthorityBytes)
    && OPAQUE_AUTHORITY.test(value);
}

function validBoundedString(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function withDatabase<T>(authority: ClaudeSessionStoreAuthority, callback: (database: DatabaseSync) => T): T {
  const database = openDatabase(authority);
  try { return callback(database); }
  catch (error) { throw sanitizeReadFailure(error); }
  finally {
    try { database.close(); }
    catch { /* The operation already reached its durable boundary. */ }
  }
}

function openDatabase(authority: ClaudeSessionStoreAuthority): DatabaseSync {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return openDatabaseOnce(authority);
    } catch (error) {
      if (error instanceof ClaudeSessionStoreError && error.code === "CORRUPT") throw error;
      if (attempt === 7) throw failure("STORAGE_UNAVAILABLE");
      // Fresh namespace creation can briefly contend before WAL exists. The
      // retry is bounded and carries no transcript/key/error material.
      const delayMs = 10 * (attempt + 1) + (process.pid % 17);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  throw failure("STORAGE_UNAVAILABLE");
}

function openDatabaseOnce(authority: ClaudeSessionStoreAuthority): DatabaseSync {
  const directory = join(authority.rootDirectory, STORE_DIRECTORY);
  const namespaceDigest = hashText(authority.namespace);
  const databasePath = join(directory, `${namespaceDigest}.sqlite`);
  const markerPath = join(directory, `${namespaceDigest}.initialized`);
  const markerContents = `${STORE_SCHEMA_BASELINE}\n${namespaceDigest}\n`;
  let database: DatabaseSync | undefined;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const markerExists = existsSync(markerPath);
    const databaseExists = existsSync(databasePath);
    if (markerExists && !databaseExists) {
      verifyInitializationMarker(markerPath, markerContents);
      throw failure("CORRUPT");
    }
    const mayInitialize = !databaseExists && !markerExists;
    database = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      timeout: 5_000,
      readBigInts: true,
      defensive: true
    });
    database.enableLoadExtension(false);
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = FULL;
    `);
    initializeOrVerifySchema(database, authority.namespace, mayInitialize);
    database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 256;");
    const journal = database.prepare("PRAGMA journal_mode").get() as Record<string, unknown> | undefined;
    if (String(journal?.["journal_mode"] ?? "").toLowerCase() !== "wal") {
      throw failure("STORAGE_UNAVAILABLE");
    }
    publishOrVerifyInitializationMarker(markerPath, markerContents);
    try { chmodSync(databasePath, 0o600); }
    catch { /* Windows ACLs remain authoritative; schema/open verification already succeeded. */ }
    return database;
  } catch (error) {
    try { database?.close(); }
    catch { /* Preserve the fixed outer failure. */ }
    if (error instanceof ClaudeSessionStoreError) throw error;
    throw failure("STORAGE_UNAVAILABLE");
  }
}

function publishOrVerifyInitializationMarker(path: string, expected: string): void {
  if (!existsSync(path)) {
    try {
      writeFileSync(path, expected, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
    } catch {
      // A concurrent first owner may have published the same immutable marker.
    }
  }
  verifyInitializationMarker(path, expected);
}

function verifyInitializationMarker(path: string, expected: string): void {
  try {
    if (statSync(path).size !== Buffer.byteLength(expected, "utf8")
      || readFileSync(path, "utf8") !== expected) {
      throw failure("CORRUPT");
    }
  } catch (error) {
    if (error instanceof ClaudeSessionStoreError) throw error;
    throw failure("CORRUPT");
  }
}

function initializeOrVerifySchema(database: DatabaseSync, namespace: string, mayInitialize: boolean): void {
  const objects = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger', 'view')
  `).all() as Array<Record<string, unknown>>;
  const hasMeta = objects.some((row) => row["name"] === "store_meta");
  if (!hasMeta) {
    transaction(database, () => {
      const currentObjects = database.prepare(`
        SELECT name FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger', 'view')
      `).all() as Array<Record<string, unknown>>;
      if (currentObjects.some((row) => row["name"] === "store_meta")) return;
      if (currentObjects.length > 0) throw failure("CORRUPT");
      // A file that existed before this connection but contains no v1 marker
      // is missing/corrupt state, not an invitation to silently rebuild it.
      // A simultaneous first creator retries until the connection that saw
      // the absent path publishes the schema.
      if (!mayInitialize) throw failure("STORAGE_UNAVAILABLE");
      database.exec(`
        CREATE TABLE store_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          schema_version INTEGER NOT NULL,
          baseline TEXT NOT NULL,
          namespace TEXT NOT NULL,
          schema_digest TEXT NOT NULL
        ) STRICT;
        CREATE TABLE operations (
          operation_id TEXT PRIMARY KEY,
          generation INTEGER NOT NULL CHECK (generation >= 1),
          source_kind TEXT NOT NULL CHECK (source_kind IN ('import', 'durable')),
          source_workspace_authority TEXT NOT NULL,
          target_workspace_authority TEXT NOT NULL,
          source_session_id TEXT NOT NULL,
          source_project_key TEXT,
          target_project_key TEXT,
          state TEXT NOT NULL CHECK (state IN (
            'importing', 'ready', 'aliased', 'child_pending', 'child_reserved', 'adopted', 'cleaned'
          )),
          child_session_id TEXT,
          reservation_state TEXT CHECK (reservation_state IN ('pending', 'confirmed')),
          reservation_batch_digest TEXT,
          source_entry_count INTEGER NOT NULL CHECK (source_entry_count >= 0),
          source_bytes INTEGER NOT NULL CHECK (source_bytes >= 0),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK ((source_kind = 'import') OR (source_project_key IS NULL AND source_entry_count = 0 AND source_bytes = 0)),
          CHECK (state <> 'importing' OR (source_kind = 'import' AND target_project_key IS NULL AND child_session_id IS NULL)),
          CHECK (state <> 'ready' OR (target_project_key IS NULL AND child_session_id IS NULL)),
          CHECK (state <> 'aliased' OR (target_project_key IS NOT NULL AND child_session_id IS NULL)),
          CHECK (state NOT IN ('child_pending', 'child_reserved', 'adopted', 'cleaned') OR
            (target_project_key IS NOT NULL AND child_session_id IS NOT NULL)),
          CHECK (child_session_id IS NOT NULL OR reservation_state IS NULL),
          CHECK ((child_session_id IS NULL) = (reservation_batch_digest IS NULL)),
          CHECK (state <> 'child_pending' OR reservation_state = 'pending'),
          CHECK (state NOT IN ('child_reserved', 'adopted') OR reservation_state = 'confirmed')
        ) STRICT;
        CREATE TABLE operation_source_entries (
          operation_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          uuid TEXT,
          entry_json TEXT NOT NULL,
          entry_bytes INTEGER NOT NULL CHECK (entry_bytes > 0),
          entry_digest TEXT NOT NULL,
          PRIMARY KEY (operation_id, ordinal),
          FOREIGN KEY (operation_id) REFERENCES operations(operation_id) ON DELETE CASCADE
        ) STRICT;
        CREATE UNIQUE INDEX operation_source_uuid
          ON operation_source_entries(operation_id, uuid) WHERE uuid IS NOT NULL;
        CREATE TABLE sessions (
          workspace_authority TEXT NOT NULL,
          project_key TEXT NOT NULL,
          session_id TEXT NOT NULL,
          writer_generation INTEGER NOT NULL CHECK (writer_generation >= 1),
          lifecycle TEXT NOT NULL CHECK (lifecycle IN ('reserved', 'adopted')),
          owner_operation_id TEXT,
          reservation_state TEXT CHECK (reservation_state IN ('pending', 'confirmed')),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          mtime INTEGER NOT NULL CHECK (mtime >= 0),
          entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
          byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
          subkey_count INTEGER NOT NULL CHECK (subkey_count >= 0),
          next_ordinal INTEGER NOT NULL CHECK (next_ordinal >= 0),
          PRIMARY KEY (workspace_authority, session_id),
          CHECK ((lifecycle = 'reserved') = (owner_operation_id IS NOT NULL)),
          CHECK ((owner_operation_id IS NULL) = (reservation_state IS NULL))
        ) STRICT;
        CREATE TABLE session_entries (
          workspace_authority TEXT NOT NULL,
          session_id TEXT NOT NULL,
          subpath TEXT NOT NULL,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          uuid TEXT,
          entry_json TEXT NOT NULL,
          entry_bytes INTEGER NOT NULL CHECK (entry_bytes > 0),
          entry_digest TEXT NOT NULL,
          PRIMARY KEY (workspace_authority, session_id, ordinal),
          FOREIGN KEY (workspace_authority, session_id)
            REFERENCES sessions(workspace_authority, session_id) ON DELETE CASCADE
        ) STRICT;
        CREATE UNIQUE INDEX session_entry_uuid
          ON session_entries(workspace_authority, session_id, subpath, uuid) WHERE uuid IS NOT NULL;
        CREATE INDEX session_entry_subpath
          ON session_entries(workspace_authority, session_id, subpath, ordinal);
        PRAGMA user_version = 1;
      `);
      const digest = schemaCatalogDigest(database);
      database.prepare(`
        INSERT INTO store_meta (singleton, schema_version, baseline, namespace, schema_digest)
        VALUES (1, ?, ?, ?, ?)
      `).run(STORE_SCHEMA_VERSION, STORE_SCHEMA_BASELINE, namespace, digest);
    });
  }
  const quick = database.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
  if (quick === undefined || quick["quick_check"] !== "ok") throw failure("CORRUPT");
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) throw failure("CORRUPT");
  const meta = database.prepare(`
    SELECT schema_version, baseline, namespace, schema_digest FROM store_meta WHERE singleton = 1
  `).get() as Record<string, unknown> | undefined;
  const version = database.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  if (meta === undefined
    || sqlInteger(meta["schema_version"]) !== STORE_SCHEMA_VERSION
    || meta["baseline"] !== STORE_SCHEMA_BASELINE
    || meta["namespace"] !== namespace
    || meta["schema_digest"] !== schemaCatalogDigest(database)
    || version === undefined
    || sqlInteger(version["user_version"]) !== STORE_SCHEMA_VERSION) {
    throw failure("CORRUPT");
  }
}

function schemaCatalogDigest(database: DatabaseSync): string {
  const rows = database.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger', 'view')
    ORDER BY type, name
  `).all() as Array<Record<string, unknown>>;
  return hashText(JSON.stringify(rows.map((row) => [row["type"], row["name"], row["tbl_name"], row["sql"]])));
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
    catch { /* A failed COMMIT can leave the result unknown; the fixed error below preserves that fact. */ }
    if (error instanceof ClaudeSessionStoreError) throw error;
    throw failure(commitAttempted ? "COMMIT_UNKNOWN" : "STORAGE_UNAVAILABLE", commitAttempted);
  }
}

function readTransaction<T>(database: DatabaseSync, callback: () => T): T {
  try {
    database.exec("BEGIN");
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK"); }
    catch { /* A read-side close or storage failure never implies a transcript mutation. */ }
    if (error instanceof ClaudeSessionStoreError) throw error;
    throw failure("STORAGE_UNAVAILABLE");
  }
}

function findOperation(database: DatabaseSync, operationId: string): OperationRow | null {
  const row = database.prepare("SELECT * FROM operations WHERE operation_id = ?").get(operationId) as
    Record<string, unknown> | undefined;
  return row === undefined ? null : decodeOperationRow(row);
}

function requireOperation(database: DatabaseSync, access: ClaudeSessionStoreOperationAccess): OperationRow {
  const operation = findOperation(database, access.operationId);
  if (operation === null) throw failure("NOT_FOUND");
  assertOperationAccess(operation, access);
  const source = database.prepare(`
    SELECT COUNT(*) AS entry_count, COALESCE(SUM(entry_bytes), 0) AS byte_count,
      COALESCE(MAX(ordinal) + 1, 0) AS next_ordinal
    FROM operation_source_entries WHERE operation_id = ?
  `).get(operation.operationId) as Record<string, unknown> | undefined;
  if (source === undefined) throw failure("CORRUPT");
  const expectedEntryCount = operation.sourceKind === "import"
    && !["adopted", "cleaned"].includes(operation.state)
    ? operation.sourceEntryCount
    : 0;
  const expectedBytes = operation.sourceKind === "import"
    && !["adopted", "cleaned"].includes(operation.state)
    ? operation.sourceBytes
    : 0;
  if (sqlInteger(source["entry_count"]) !== expectedEntryCount
    || sqlInteger(source["byte_count"]) !== expectedBytes
    || sqlInteger(source["next_ordinal"]) !== expectedEntryCount) {
    throw failure("CORRUPT");
  }
  return operation;
}

function assertOperationAccess(operation: OperationRow, access: ClaudeSessionStoreOperationAccess): void {
  if (operation.generation !== access.generation || operation.sourceKind !== access.source.kind
    || operation.sourceWorkspaceAuthority !== access.source.workspaceAuthority
    || operation.targetWorkspaceAuthority !== access.target.workspaceAuthority
    || operation.sourceSessionId !== access.source.sessionId) {
    throw failure("INVALID_ACCESS");
  }
}

function decodeOperationRow(row: Record<string, unknown>): OperationRow {
  const sourceKind = requiredString(row["source_kind"]);
  const state = requiredString(row["state"]);
  const reservation = nullableString(row["reservation_state"]);
  if (!isSourceKind(sourceKind) || !isOperationState(state)
    || (reservation !== null && reservation !== "pending" && reservation !== "confirmed")) {
    throw failure("CORRUPT");
  }
  const operation: OperationRow = {
    operationId: requiredString(row["operation_id"]),
    generation: sqlInteger(row["generation"]),
    sourceKind,
    sourceWorkspaceAuthority: requiredString(row["source_workspace_authority"]),
    targetWorkspaceAuthority: requiredString(row["target_workspace_authority"]),
    sourceSessionId: requiredString(row["source_session_id"]),
    sourceProjectKey: nullableString(row["source_project_key"]),
    targetProjectKey: nullableString(row["target_project_key"]),
    state,
    childSessionId: nullableString(row["child_session_id"]),
    reservationState: reservation,
    reservationBatchDigest: nullableString(row["reservation_batch_digest"]),
    sourceEntryCount: sqlInteger(row["source_entry_count"]),
    sourceBytes: sqlInteger(row["source_bytes"]),
    revision: sqlInteger(row["revision"])
  };
  if (!UUID.test(operation.operationId) || !UUID.test(operation.sourceSessionId)
    || !validGeneration(operation.generation)
    || !validOpaqueAuthority(operation.sourceWorkspaceAuthority)
    || !validOpaqueAuthority(operation.targetWorkspaceAuthority)
    || (operation.childSessionId !== null && !UUID.test(operation.childSessionId))
    || (operation.reservationBatchDigest !== null && !/^[0-9a-f]{64}$/u.test(operation.reservationBatchDigest))
    || ((operation.childSessionId === null) !== (operation.reservationBatchDigest === null))
    || operation.sourceEntryCount < 0
    || operation.sourceEntryCount > CLAUDE_SESSION_STORE_LIMITS.maximumSessionEntries
    || operation.sourceBytes < 0
    || operation.sourceBytes > CLAUDE_SESSION_STORE_LIMITS.maximumSessionBytes
    || operation.revision < 1) {
    throw failure("CORRUPT");
  }
  if (operation.sourceProjectKey !== null) validateStoredProjectKey(operation.sourceProjectKey);
  if (operation.targetProjectKey !== null) validateStoredProjectKey(operation.targetProjectKey);
  const hasChild = operation.childSessionId !== null;
  const hasTarget = operation.targetProjectKey !== null;
  const validSource = operation.sourceKind === "durable"
    ? operation.sourceProjectKey === null && operation.sourceEntryCount === 0 && operation.sourceBytes === 0
    : operation.state === "importing"
      ? (operation.sourceProjectKey === null
          ? operation.sourceEntryCount === 0 && operation.sourceBytes === 0
          : (operation.sourceEntryCount === 0) === (operation.sourceBytes === 0))
      : operation.sourceProjectKey !== null && operation.sourceEntryCount > 0 && operation.sourceBytes > 0;
  const validState = operation.state === "importing"
    ? operation.sourceKind === "import" && !hasTarget && !hasChild && operation.reservationState === null
    : operation.state === "ready"
      ? !hasTarget && !hasChild && operation.reservationState === null
      : operation.state === "aliased"
        ? hasTarget && !hasChild && operation.reservationState === null
        : operation.state === "child_pending"
          ? hasTarget && hasChild && operation.reservationState === "pending"
          : operation.state === "cleaned"
            ? hasTarget && hasChild && operation.reservationState !== null
            : ["child_reserved", "adopted"].includes(operation.state)
              && hasTarget && hasChild && operation.reservationState === "confirmed";
  if (!validSource || !validState) throw failure("CORRUPT");
  return operation;
}

function findSession(database: DatabaseSync, workspaceAuthority: string, sessionId: string): SessionRow | null {
  const row = database.prepare(`
    SELECT * FROM sessions WHERE workspace_authority = ? AND session_id = ?
  `).get(workspaceAuthority, sessionId) as Record<string, unknown> | undefined;
  return row === undefined ? null : decodeSessionRow(row);
}

function requireSession(database: DatabaseSync, workspaceAuthority: string, sessionId: string): SessionRow {
  const session = findSession(database, workspaceAuthority, sessionId);
  if (session === null) throw failure("NOT_FOUND");
  return session;
}

function decodeSessionRow(row: Record<string, unknown>): SessionRow {
  const lifecycle = requiredString(row["lifecycle"]);
  const reservation = nullableString(row["reservation_state"]);
  if ((lifecycle !== "reserved" && lifecycle !== "adopted")
    || (reservation !== null && reservation !== "pending" && reservation !== "confirmed")) {
    throw failure("CORRUPT");
  }
  const session: SessionRow = {
    workspaceAuthority: requiredString(row["workspace_authority"]),
    projectKey: requiredString(row["project_key"]),
    sessionId: requiredString(row["session_id"]),
    writerGeneration: sqlInteger(row["writer_generation"]),
    lifecycle,
    ownerOperationId: nullableString(row["owner_operation_id"]),
    reservationState: reservation,
    revision: sqlInteger(row["revision"]),
    mtime: sqlInteger(row["mtime"]),
    entryCount: sqlInteger(row["entry_count"]),
    byteCount: sqlInteger(row["byte_count"]),
    subkeyCount: sqlInteger(row["subkey_count"]),
    nextOrdinal: sqlInteger(row["next_ordinal"])
  };
  if (!validOpaqueAuthority(session.workspaceAuthority) || !UUID.test(session.sessionId)
    || !validGeneration(session.writerGeneration) || session.revision < 1 || session.mtime < 0
    || session.entryCount < 0 || session.entryCount > CLAUDE_SESSION_STORE_LIMITS.maximumSessionEntries
    || session.byteCount < 0 || session.byteCount > CLAUDE_SESSION_STORE_LIMITS.maximumSessionBytes
    || session.subkeyCount < 0 || session.subkeyCount > CLAUDE_SESSION_STORE_LIMITS.maximumSessionSubkeys
    || session.nextOrdinal !== session.entryCount
    || (session.ownerOperationId !== null && !UUID.test(session.ownerOperationId))
    || (session.lifecycle === "reserved") !== (session.ownerOperationId !== null)
    || (session.ownerOperationId === null) !== (session.reservationState === null)) {
    throw failure("CORRUPT");
  }
  validateStoredProjectKey(session.projectKey);
  return session;
}

function assertSessionGeneration(session: SessionRow, generation: number): void {
  if (session.writerGeneration !== generation) throw failure("CONFLICT");
}

function assertOperationChildSession(
  session: SessionRow,
  operation: OperationRow,
  access: ClaudeSessionStoreOperationAccess
): void {
  assertSessionGeneration(session, access.generation);
  const provenanceMatches = operation.state === "adopted"
    ? session.lifecycle === "adopted" && session.ownerOperationId === null && session.reservationState === null
    : session.ownerOperationId === operation.operationId;
  if (session.projectKey !== operation.targetProjectKey || session.sessionId !== operation.childSessionId
    || !provenanceMatches || session.workspaceAuthority !== operation.targetWorkspaceAuthority) {
    throw failure("CORRUPT");
  }
}

function operationSnapshot(operation: OperationRow): ClaudeSessionStoreOperationSnapshot {
  return Object.freeze({
    operationId: operation.operationId,
    generation: operation.generation,
    sourceKind: operation.sourceKind,
    sourceWorkspaceAuthority: operation.sourceWorkspaceAuthority,
    targetWorkspaceAuthority: operation.targetWorkspaceAuthority,
    sourceSessionId: operation.sourceSessionId,
    state: operation.state,
    sourceProjectKeyCaptured: operation.sourceProjectKey !== null,
    targetProjectKeyCaptured: operation.targetProjectKey !== null,
    sourceEntryCount: operation.sourceEntryCount,
    sourceBytes: operation.sourceBytes,
    ...(operation.childSessionId === null ? {} : { childSessionId: operation.childSessionId }),
    childReservationConfirmed: operation.reservationState === "confirmed",
    revision: operation.revision
  });
}

function isSourceKind(value: string): value is "import" | "durable" {
  return value === "import" || value === "durable";
}

function isOperationState(value: string): value is ClaudeSessionStoreOperationState {
  return ["importing", "ready", "aliased", "child_pending", "child_reserved", "adopted", "cleaned"].includes(value);
}

function sqlInteger(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) throw failure("CORRUPT");
  return number;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw failure("CORRUPT");
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return requiredString(value);
}

function requireSingleChange(value: number | bigint): void {
  if (sqlInteger(value) !== 1) throw failure("CONFLICT");
}

function sumBytes(entries: readonly PreparedEntry[]): number {
  return entries.reduce((total, entry) => total + entry.bytes, 0);
}

function entryBatchDigest(entries: readonly PreparedEntry[]): string {
  return hashText(JSON.stringify(entries.map((entry) => entry.json)));
}

function now(): number {
  return Date.now();
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function failure(code: ClaudeSessionStoreErrorCode, stateMayHaveChanged = false): ClaudeSessionStoreError {
  return new ClaudeSessionStoreError(code, stateMayHaveChanged);
}

function sanitizeReadFailure(error: unknown): ClaudeSessionStoreError {
  return error instanceof ClaudeSessionStoreError ? error : failure("STORAGE_UNAVAILABLE");
}

function sanitizeMutationFailure(error: unknown): ClaudeSessionStoreError {
  return error instanceof ClaudeSessionStoreError ? error : failure("COMMIT_UNKNOWN", true);
}
