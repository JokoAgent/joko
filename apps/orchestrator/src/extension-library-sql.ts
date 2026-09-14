import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { toNamespacedPath } from "node:path";
import { backup, constants as sqliteConstants, DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { Worker, type WorkerOptions } from "node:worker_threads";

import {
  ExtensionLibraryError,
  type ExtensionLibraryFailureCode,
  type ExtensionLibraryVault
} from "./extension-library-vault.js";

export interface ExtensionLibrarySqlLimits {
  readonly maximumRows: number;
  readonly maximumResultBytes: number;
  readonly maximumParameters: number;
  readonly maximumBatchStatements: number;
  readonly maximumSqlCharacters: number;
}

export const EXTENSION_LIBRARY_SQL_LIMITS: ExtensionLibrarySqlLimits = Object.freeze({
  maximumRows: 2_000,
  maximumResultBytes: 16 * 1024 * 1024,
  maximumParameters: 256,
  maximumBatchStatements: 100,
  maximumSqlCharacters: 128 * 1024
});

export type ExtensionLibrarySqlValue = null | number | bigint | string | Uint8Array;
export type ExtensionLibrarySqlRow = Readonly<Record<string, ExtensionLibrarySqlValue>>;

export interface ExtensionLibrarySqlResult {
  readonly rows: readonly ExtensionLibrarySqlRow[];
  readonly changes: bigint;
  readonly lastInsertRowid?: bigint;
}

export interface ExtensionLibrarySqlMigration {
  readonly version: number;
  readonly statements: readonly string[];
}

export interface ExtensionLibrarySqlHandle {
  readonly handleId: string;
  readonly path: string;
  readonly readonly: boolean;
  readonly userVersion: number;
}

interface AuthorizerGate {
  internal: boolean;
}

interface OpenDatabase {
  readonly handleId: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly readonly: boolean;
  readonly gate: AuthorizerGate;
  identity: BigIntStats;
  database: DatabaseSync;
}

interface ValidatedSql {
  readonly sql: string;
  readonly keyword: string;
  readonly mutates: boolean;
}

export type ExtensionLibrarySqlWorkerRequest =
  | { readonly id: number; readonly operation: "open"; readonly input: { readonly path: string; readonly create?: boolean; readonly readonly?: boolean } }
  | { readonly id: number; readonly operation: "close" | "check" | "userVersion"; readonly handleId: string }
  | { readonly id: number; readonly operation: "closeAll" }
  | { readonly id: number; readonly operation: "execute"; readonly handleId: string; readonly sql: string; readonly parameters: readonly ExtensionLibrarySqlValue[] }
  | { readonly id: number; readonly operation: "batch"; readonly handleId: string; readonly statements: readonly { readonly sql: string; readonly parameters?: readonly ExtensionLibrarySqlValue[] }[] }
  | { readonly id: number; readonly operation: "migrate"; readonly handleId: string; readonly migrations: readonly ExtensionLibrarySqlMigration[] }
  | { readonly id: number; readonly operation: "backup"; readonly handleId: string; readonly targetPath: string };

export type ExtensionLibrarySqlWorkerReply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: { readonly code: ExtensionLibraryFailureCode; readonly message: string } };

export interface ExtensionLibrarySqlWorkerStartup {
  readonly root: string;
  readonly extensionId: string;
  readonly limits: ExtensionLibrarySqlLimits;
  readonly authorityState: SharedArrayBuffer;
}

interface PendingWorkerCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: ExtensionLibraryError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const ALLOWED_FIRST_KEYWORDS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP", "WITH", "REPLACE"]);
const MUTATING_KEYWORDS = new Set(["INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP", "REPLACE"]);
const FORBIDDEN_KEYWORDS = new Set([
  "ATTACH",
  "DETACH",
  "PRAGMA",
  "VACUUM",
  "BEGIN",
  "COMMIT",
  "END",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "TRIGGER",
  "VIRTUAL"
]);
const FORBIDDEN_FUNCTIONS = new Set(["load_extension", "readfile", "writefile", "fts3_tokenizer"]);
const ALLOWED_AUTHORIZER_ACTIONS = new Set([
  sqliteConstants.SQLITE_ALTER_TABLE,
  sqliteConstants.SQLITE_CREATE_INDEX,
  sqliteConstants.SQLITE_CREATE_TABLE,
  sqliteConstants.SQLITE_CREATE_VIEW,
  sqliteConstants.SQLITE_DELETE,
  sqliteConstants.SQLITE_DROP_INDEX,
  sqliteConstants.SQLITE_DROP_TABLE,
  sqliteConstants.SQLITE_DROP_VIEW,
  sqliteConstants.SQLITE_FUNCTION,
  sqliteConstants.SQLITE_INSERT,
  sqliteConstants.SQLITE_READ,
  sqliteConstants.SQLITE_RECURSIVE,
  sqliteConstants.SQLITE_SELECT,
  sqliteConstants.SQLITE_UPDATE
]);
const FAILURE_CODES = new Set<ExtensionLibraryFailureCode>([
  "UNAVAILABLE", "READ_ONLY", "DISK_FULL", "PATH_INVALID", "NOT_FOUND", "ALREADY_EXISTS", "TOO_LARGE",
  "FILE_LIMIT", "SQL_REJECTED", "SQL_FAILED", "RESULT_LIMIT", "CONFLICT", "CORRUPT", "INTERNAL"
]);

export class ExtensionLibrarySqlService {
  readonly #vault: ExtensionLibraryVault;
  readonly #limits: ExtensionLibrarySqlLimits;
  readonly #workerFactory: (url: URL, options: WorkerOptions) => Worker;
  readonly #requestTimeoutMilliseconds: number;
  readonly #authorityState: SharedArrayBuffer;
  readonly #pending = new Map<number, PendingWorkerCall>();
  readonly #handles = new Map<string, { readonly readonly: boolean }>();
  #worker?: Worker;
  #retiring?: Promise<void>;
  #nextRequestId = 1;
  #disposed = false;

  constructor(vault: ExtensionLibraryVault, options: {
    readonly limits?: Partial<ExtensionLibrarySqlLimits>;
    readonly requestTimeoutMilliseconds?: number;
    readonly workerFactory?: (url: URL, options: WorkerOptions) => Worker;
    readonly authorityState?: SharedArrayBuffer;
  } = {}) {
    this.#vault = vault;
    this.#limits = Object.freeze({ ...EXTENSION_LIBRARY_SQL_LIMITS, ...options.limits });
    this.#requestTimeoutMilliseconds = options.requestTimeoutMilliseconds ?? 30_000;
    if (!Number.isSafeInteger(this.#requestTimeoutMilliseconds) || this.#requestTimeoutMilliseconds < 1_000) {
      throw new TypeError("Extension Library SQL worker timeout is invalid.");
    }
    if (options.authorityState !== undefined && options.authorityState.byteLength !== Int32Array.BYTES_PER_ELEMENT) {
      throw new TypeError("Extension Library SQL authority state is invalid.");
    }
    this.#authorityState = options.authorityState ?? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    this.#workerFactory = options.workerFactory ?? ((url, workerOptions) => new Worker(url, workerOptions));
  }

  get limits(): ExtensionLibrarySqlLimits {
    return this.#limits;
  }

  revoke(): void {
    Atomics.store(new Int32Array(this.#authorityState), 0, 1);
    const worker = this.#worker;
    if (worker !== undefined) {
      this.#retireWorker(worker, new ExtensionLibraryError("UNAVAILABLE", "Extension Library session authority was revoked."));
    }
  }

  async open(input: {
    readonly path: string;
    readonly create?: boolean;
    readonly readonly?: boolean;
  }): Promise<ExtensionLibrarySqlHandle> {
    if (input.readonly === true && input.create === true) {
      throw new ExtensionLibraryError("CONFLICT", "A read-only Library database cannot be created.");
    }
    if (input.readonly !== true) await this.#vault.assertMutationAuthority("sqlite");
    await this.#vault.resolveDatabasePath(input.path, { write: input.readonly !== true, create: input.create === true });
    const result = await this.#call<ExtensionLibrarySqlHandle>({
      id: this.#requestId(),
      operation: "open",
      input
    });
    this.#handles.set(result.handleId, { readonly: result.readonly });
    if (!result.readonly) await this.#vault.reconcileUsage();
    return result;
  }

  async close(handleId: string): Promise<void> {
    const known = this.#handles.get(handleId);
    await this.#call<void>({ id: this.#requestId(), operation: "close", handleId });
    this.#handles.delete(handleId);
    if (known?.readonly === false) await this.#vault.reconcileUsage();
  }

  async closeAll(): Promise<void> {
    if (this.#disposed) {
      await this.#awaitRetirement();
      return;
    }
    const worker = this.#worker;
    let failure: unknown;
    if (worker !== undefined && this.#pending.size === 0) {
      try {
        await this.#call<void>({ id: this.#requestId(), operation: "closeAll" });
      } catch (error) {
        failure = error;
      }
    }
    this.#disposed = true;
    this.#handles.clear();
    if (this.#worker === worker) this.#worker = undefined;
    if (worker !== undefined) {
      worker.unref();
      const retiring = worker.terminate().then(() => undefined, () => undefined);
      this.#retiring = retiring;
      void retiring.finally(() => {
        if (this.#retiring === retiring) this.#retiring = undefined;
      });
    }
    await this.#awaitRetirement();
    this.#rejectPending(new ExtensionLibraryError("UNAVAILABLE", "Library SQL worker was closed."));
    await this.#vault.reconcileUsage().catch((error) => { failure ??= error; });
    if (failure !== undefined) throw sqlFailure(failure);
  }

  async execute(
    handleId: string,
    sql: string,
    parameters: readonly ExtensionLibrarySqlValue[] = []
  ): Promise<ExtensionLibrarySqlResult> {
    const validated = validateSql(sql, this.#limits);
    validateParameters(parameters, this.#limits);
    if (validated.mutates) {
      await this.#vault.assertWritable();
      await this.#vault.assertMutationAuthority("sqlite");
    }
    const result = await this.#call<ExtensionLibrarySqlResult>({
      id: this.#requestId(), operation: "execute", handleId, sql, parameters
    });
    if (validated.mutates) await this.#vault.reconcileUsage();
    return result;
  }

  async batch(
    handleId: string,
    statements: readonly { readonly sql: string; readonly parameters?: readonly ExtensionLibrarySqlValue[] }[]
  ): Promise<readonly ExtensionLibrarySqlResult[]> {
    validateStatementBatch(statements, this.#limits);
    const mutates = statements.some((statement) => validateSql(statement.sql, this.#limits).mutates);
    if (mutates) {
      await this.#vault.assertWritable();
      await this.#vault.assertMutationAuthority("sqlite");
    }
    const result = await this.#call<readonly ExtensionLibrarySqlResult[]>({
      id: this.#requestId(), operation: "batch", handleId, statements
    });
    if (mutates) await this.#vault.reconcileUsage();
    return result;
  }

  async migrate(handleId: string, migrations: readonly ExtensionLibrarySqlMigration[]): Promise<number> {
    validateMigrationShape(migrations, this.#limits);
    await this.#vault.assertWritable();
    await this.#vault.assertMutationAuthority("sqlite");
    const result = await this.#call<number>({ id: this.#requestId(), operation: "migrate", handleId, migrations });
    await this.#vault.reconcileUsage();
    return result;
  }

  async backup(handleId: string, targetPath: string): Promise<{ readonly path: string; readonly userVersion: number }> {
    await this.#vault.assertWritable();
    await this.#vault.assertMutationAuthority("sqlite");
    await this.#vault.resolveDatabasePath(targetPath, { write: true, create: true });
    const result = await this.#call<{ readonly path: string; readonly userVersion: number }>({
      id: this.#requestId(), operation: "backup", handleId, targetPath
    });
    await this.#vault.reconcileUsage();
    return result;
  }

  check(handleId: string): Promise<{ readonly ok: true }> {
    return this.#call({ id: this.#requestId(), operation: "check", handleId });
  }

  userVersion(handleId: string): Promise<number> {
    return this.#call({ id: this.#requestId(), operation: "userVersion", handleId });
  }

  #requestId(): number {
    if (this.#nextRequestId >= Number.MAX_SAFE_INTEGER) this.#nextRequestId = 1;
    return this.#nextRequestId++;
  }

  async #call<T>(request: ExtensionLibrarySqlWorkerRequest): Promise<T> {
    if (this.#disposed) return Promise.reject(new ExtensionLibraryError("UNAVAILABLE", "Library SQL worker is closed."));
    let worker: Worker;
    try {
      worker = this.#ensureWorker();
    } catch (error) {
      return Promise.reject(sqlFailure(error));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(request.id)) return;
        const failure = new ExtensionLibraryError("UNAVAILABLE", "Library SQL worker exceeded its execution deadline.");
        this.#retireWorker(worker, failure);
        reject(failure);
      }, this.#requestTimeoutMilliseconds);
      this.#pending.set(request.id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });
      try {
        worker.postMessage(request);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(request.id);
        const failure = sqlFailure(error);
        this.#retireWorker(worker, failure);
        reject(failure);
      }
    });
  }

  #ensureWorker(): Worker {
    if (this.#worker !== undefined) return this.#worker;
    const sourceRuntime = import.meta.url.endsWith(".ts");
    const url = new URL(sourceRuntime ? "./extension-library-sql-worker.ts" : "./extension-library-sql-worker.js", import.meta.url);
    const worker = this.#workerFactory(url, {
      workerData: {
        root: this.#vault.root,
        extensionId: this.#vault.extensionId,
        limits: this.#limits,
        authorityState: this.#authorityState
      } satisfies ExtensionLibrarySqlWorkerStartup,
      execArgv: sourceRuntime ? ["--import", "tsx"] : [],
      resourceLimits: { maxOldGenerationSizeMb: 256 }
    });
    this.#worker = worker;
    worker.on("message", (value: unknown) => this.#receive(worker, value));
    worker.on("error", () => this.#retireWorker(worker, new ExtensionLibraryError("UNAVAILABLE", "Library SQL worker failed.")));
    worker.on("exit", (code) => {
      if (this.#worker !== worker) return;
      this.#retireWorker(worker, new ExtensionLibraryError(
        "UNAVAILABLE",
        code === 0 ? "Library SQL worker exited." : "Library SQL worker exited unexpectedly."
      ));
    });
    return worker;
  }

  #receive(worker: Worker, value: unknown): void {
    if (this.#worker !== worker || !validWorkerReply(value)) {
      this.#retireWorker(worker, new ExtensionLibraryError("UNAVAILABLE", "Library SQL worker returned an invalid response."));
      return;
    }
    const pending = this.#pending.get(value.id);
    if (pending === undefined) return;
    this.#pending.delete(value.id);
    clearTimeout(pending.timer);
    if (value.ok) pending.resolve(value.value);
    else pending.reject(new ExtensionLibraryError(value.error.code, value.error.message));
  }

  #retireWorker(worker: Worker, failure: ExtensionLibraryError): void {
    if (this.#worker !== worker) return;
    this.#disposed = true;
    this.#worker = undefined;
    this.#handles.clear();
    this.#rejectPending(failure);
    worker.unref();
    const retiring = worker.terminate().then(() => undefined, () => undefined);
    this.#retiring = retiring;
    void retiring.finally(() => {
      if (this.#retiring === retiring) this.#retiring = undefined;
    });
  }

  async #awaitRetirement(): Promise<void> {
    const retiring = this.#retiring;
    if (retiring === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        retiring,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1_000);
          timer.unref?.();
        })
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #rejectPending(failure: ExtensionLibraryError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.#pending.clear();
  }
}

/** SQLite connection owner used only inside the dedicated Library worker. */
export class ExtensionLibrarySqlCore {
  readonly #vault: ExtensionLibraryVault;
  readonly #limits: ExtensionLibrarySqlLimits;
  readonly #handles = new Map<string, OpenDatabase>();

  constructor(vault: ExtensionLibraryVault, options: { readonly limits?: Partial<ExtensionLibrarySqlLimits> } = {}) {
    this.#vault = vault;
    this.#limits = Object.freeze({ ...EXTENSION_LIBRARY_SQL_LIMITS, ...options.limits });
  }

  get limits(): ExtensionLibrarySqlLimits {
    return this.#limits;
  }

  async open(input: {
    readonly path: string;
    readonly create?: boolean;
    readonly readonly?: boolean;
  }): Promise<ExtensionLibrarySqlHandle> {
    const readonly = input.readonly === true;
    if (readonly && input.create === true) {
      throw new ExtensionLibraryError("CONFLICT", "A read-only Library database cannot be created.");
    }
    if (!readonly) await this.#vault.assertMutationAuthority("sqlite");
    const absolutePath = await this.#vault.resolveDatabasePath(input.path, {
      write: !readonly,
      create: input.create === true,
      prepare: !readonly
    });
    const gate: AuthorizerGate = { internal: false };
    let database: DatabaseSync | undefined;
    let reserved: BigIntStats | undefined;
    let registeredHandleId: string | undefined;
    try {
      let expected: BigIntStats | undefined;
      try {
        expected = await databaseIdentity(absolutePath);
      } catch (error) {
        if (!missing(error) || input.create !== true) throw error;
        let handle: FileHandle | undefined;
        try {
          handle = await open(
            absolutePath,
            constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
            0o600
          );
          await handle.sync();
          reserved = await handle.stat({ bigint: true });
        } catch (reserveError) {
          if (alreadyExists(reserveError)) {
            throw new ExtensionLibraryError("CONFLICT", "Library database appeared while it was created.", { cause: reserveError });
          }
          throw reserveError;
        } finally {
          await handle?.close().catch(() => undefined);
        }
        expected = reserved;
      }
      await assertDatabaseIdentity(absolutePath, expected);
      database = this.#createDatabase(absolutePath, readonly, gate);
      const identity = await databaseIdentity(absolutePath);
      if (!sameDatabaseObject(expected, identity)) {
        throw new ExtensionLibraryError("CONFLICT", "Library database changed while it was opened.");
      }
      if (!readonly) await this.#vault.assertMutationAuthority("sqlite");
      const handleId = randomUUID();
      const entry: OpenDatabase = {
        handleId,
        relativePath: input.path,
        absolutePath,
        readonly,
        gate,
        identity,
        database
      };
      this.#handles.set(handleId, entry);
      registeredHandleId = handleId;
      if (!readonly) await this.#vault.reconcileUsage();
      return {
        handleId,
        path: input.path,
        readonly,
        userVersion: this.#readUserVersion(entry)
      };
    } catch (error) {
      if (registeredHandleId !== undefined) this.#handles.delete(registeredHandleId);
      database?.close();
      if (reserved !== undefined) await unlink(absolutePath).catch(() => undefined);
      throw sqlFailure(error);
    }
  }

  async close(handleId: string): Promise<void> {
    const entry = this.#handle(handleId);
    let identityFailure: unknown;
    try {
      await this.#assertDatabaseCurrent(entry, false);
    } catch (error) {
      identityFailure = error;
    }
    this.#handles.delete(handleId);
    entry.database.close();
    if (!entry.readonly) await this.#vault.reconcileUsage();
    if (identityFailure !== undefined) throw identityFailure;
  }

  async closeAll(): Promise<void> {
    const entries = [...this.#handles.values()];
    this.#handles.clear();
    let failure: unknown;
    for (const entry of entries) {
      try {
        entry.database.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (entries.some((entry) => !entry.readonly)) await this.#vault.reconcileUsage();
    if (failure !== undefined) throw sqlFailure(failure);
  }

  async execute(
    handleId: string,
    sql: string,
    parameters: readonly ExtensionLibrarySqlValue[] = []
  ): Promise<ExtensionLibrarySqlResult> {
    const entry = this.#handle(handleId);
    const validated = validateSql(sql, this.#limits);
    const bound = validateParameters(parameters, this.#limits);
    this.#assertMutationAllowed(entry, validated);
    await this.#assertDatabaseCurrent(entry, validated.mutates);
    if (!validated.mutates) {
      const result = this.#executePrepared(entry, validated.sql, bound);
      await this.#assertDatabaseCurrent(entry, false);
      return result;
    }
    await this.#vault.assertWritable();
    this.#begin(entry, true);
    try {
      const result = this.#executePrepared(entry, validated.sql, bound);
      await this.#vault.assertMutationAuthority("sqlite");
      this.#commit(entry);
      await this.#assertDatabaseCurrent(entry, false);
      await this.#vault.reconcileUsage();
      return result;
    } catch (error) {
      this.#rollback(entry);
      throw sqlFailure(error);
    }
  }

  async batch(
    handleId: string,
    statements: readonly { readonly sql: string; readonly parameters?: readonly ExtensionLibrarySqlValue[] }[]
  ): Promise<readonly ExtensionLibrarySqlResult[]> {
    const entry = this.#handle(handleId);
    if (statements.length === 0 || statements.length > this.#limits.maximumBatchStatements) {
      throw new ExtensionLibraryError("TOO_LARGE", "Library SQL batch size is outside the supported boundary.");
    }
    const validated = statements.map((statement) => ({
      statement: validateSql(statement.sql, this.#limits),
      parameters: validateParameters(statement.parameters ?? [], this.#limits)
    }));
    const mutates = validated.some((item) => item.statement.mutates);
    for (const item of validated) this.#assertMutationAllowed(entry, item.statement);
    await this.#assertDatabaseCurrent(entry, mutates);
    if (mutates) await this.#vault.assertWritable();
    this.#begin(entry, mutates);
    try {
      const results = validated.map((item) => this.#executePrepared(entry, item.statement.sql, item.parameters));
      if (mutates) await this.#vault.assertMutationAuthority("sqlite");
      this.#commit(entry);
      await this.#assertDatabaseCurrent(entry, false);
      if (mutates) await this.#vault.reconcileUsage();
      return results;
    } catch (error) {
      this.#rollback(entry);
      throw sqlFailure(error);
    }
  }

  async migrate(handleId: string, migrations: readonly ExtensionLibrarySqlMigration[]): Promise<number> {
    const entry = this.#handle(handleId);
    if (entry.readonly) throw new ExtensionLibraryError("READ_ONLY", "Library database handle is read-only.");
    if (!Array.isArray(migrations) || migrations.length === 0 || migrations.length > this.#limits.maximumBatchStatements) {
      throw new ExtensionLibraryError("TOO_LARGE", "Library database migration count is outside the supported boundary.");
    }
    if ([...this.#handles.values()].some((candidate) => candidate.handleId !== handleId && candidate.absolutePath === entry.absolutePath)) {
      throw new ExtensionLibraryError("CONFLICT", "Library database migration requires an exclusive handle.");
    }
    await this.#assertDatabaseCurrent(entry, true);
    const current = this.#readUserVersion(entry);
    let previousVersion: number | undefined;
    let statementCount = 0;
    for (const migration of migrations) {
      if (!Number.isSafeInteger(migration.version) || migration.version < 1 || !Array.isArray(migration.statements)
        || migration.statements.length === 0 || previousVersion !== undefined && migration.version !== previousVersion + 1) {
        throw new ExtensionLibraryError("CONFLICT", "Library database migrations must be non-empty and contiguous.");
      }
      statementCount += migration.statements.length;
      if (statementCount > this.#limits.maximumBatchStatements) {
        throw new ExtensionLibraryError("TOO_LARGE", "Library database migration statement count exceeded the supported boundary.");
      }
      for (const sql of migration.statements) {
        const statement = validateSql(sql, this.#limits);
        if (!statement.mutates) throw new ExtensionLibraryError("SQL_REJECTED", "Library database migrations may only contain mutations.");
      }
      previousVersion = migration.version;
    }
    const pending = migrations.filter((migration) => migration.version > current);
    let expected = current + 1;
    for (const migration of pending) {
      if (migration.version !== expected) {
        throw new ExtensionLibraryError("CONFLICT", "Library database migrations must be non-empty and contiguous.");
      }
      expected += 1;
    }
    if (pending.length === 0) return current;
    await this.#vault.assertWritable();
    const backupPath = await this.#vault.allocateTemporaryPath(".sqlite-backup");
    await backup(entry.database, sqliteFilesystemPath(backupPath), { rate: 4_096 }).catch((error) => {
      throw sqlFailure(error);
    });
    try {
      await this.#assertDatabaseCurrent(entry, true);
      this.#begin(entry, true);
      try {
        for (const migration of pending) {
          for (const sql of migration.statements) this.#executePrepared(entry, sql, []);
          this.#internal(entry, () => entry.database.exec(`PRAGMA user_version = ${migration.version}`));
        }
        this.#assertQuickCheck(entry);
        await this.#vault.assertMutationAuthority("sqlite");
        this.#commit(entry);
        await this.#assertDatabaseCurrent(entry, false);
      } catch (error) {
        this.#rollback(entry);
        throw error;
      }
      await this.#vault.reconcileUsage();
      return pending.at(-1)!.version;
    } catch (error) {
      try {
        await this.#assertDatabaseCurrent(entry, true);
        entry.database.close();
        const source = new DatabaseSync(sqliteFilesystemPath(backupPath), { readOnly: true, allowExtension: false, readBigInts: true });
        try {
          await backup(source, sqliteFilesystemPath(entry.absolutePath), { rate: 4_096 });
        } finally {
          source.close();
        }
        entry.database = this.#createDatabase(entry.absolutePath, false, entry.gate);
        entry.identity = await databaseIdentity(entry.absolutePath);
        await this.#assertDatabaseCurrent(entry, false);
        await this.#vault.reconcileUsage();
      } catch (restoreError) {
        throw new ExtensionLibraryError("INTERNAL", "Library database migration and protected rollback both failed.", {
          cause: new AggregateError([error, restoreError])
        });
      }
      throw sqlFailure(error);
    } finally {
      await unlink(backupPath).catch(() => undefined);
    }
  }

  async backup(handleId: string, targetPath: string): Promise<{ readonly path: string; readonly userVersion: number }> {
    const entry = this.#handle(handleId);
    await this.#assertDatabaseCurrent(entry, false);
    const source = await lstat(entry.absolutePath, { bigint: true });
    if (!source.isFile() || source.isSymbolicLink()) {
      throw new ExtensionLibraryError("CONFLICT", "Library database identity changed before backup.");
    }
    if (source.size > BigInt(this.#vault.limits.maximumStreamBytes)) {
      throw new ExtensionLibraryError("TOO_LARGE", "Library database backup exceeds the 8 GiB boundary.");
    }
    await this.#vault.assertWritable(Number(source.size));
    const target = await this.#vault.resolveDatabasePath(targetPath, { write: true, create: true });
    if (target === entry.absolutePath) throw new ExtensionLibraryError("CONFLICT", "Library database cannot back up over itself.");
    try {
      await lstat(target);
      throw new ExtensionLibraryError("ALREADY_EXISTS", "Library database backup target already exists.");
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const temporary = await this.#vault.allocateTemporaryPath(".sqlite-backup");
    try {
      await backup(entry.database, sqliteFilesystemPath(temporary), { rate: 4_096 });
      await this.#assertDatabaseCurrent(entry, false);
      const verification = new DatabaseSync(sqliteFilesystemPath(temporary), { readOnly: true, allowExtension: false, readBigInts: true });
      let userVersion: number;
      try {
        const gate: AuthorizerGate = { internal: false };
        this.#configureDatabase(verification, true, gate);
        const verificationEntry: OpenDatabase = {
          handleId: "verification",
          relativePath: targetPath,
          absolutePath: temporary,
          readonly: true,
          gate,
          identity: await databaseIdentity(temporary),
          database: verification
        };
        this.#assertQuickCheck(verificationEntry);
        userVersion = this.#readUserVersion(verificationEntry);
      } finally {
        verification.close();
      }
      await this.#vault.commitSqliteBackup(temporary, targetPath);
      return { path: targetPath, userVersion };
    } catch (error) {
      throw sqlFailure(error);
    } finally {
      await this.#vault.discardTemporaryPath(temporary, ".sqlite-backup").catch(() => undefined);
    }
  }

  async check(handleId: string): Promise<{ readonly ok: true }> {
    const entry = this.#handle(handleId);
    await this.#assertDatabaseCurrent(entry, false);
    this.#assertQuickCheck(entry);
    await this.#assertDatabaseCurrent(entry, false);
    return { ok: true };
  }

  async userVersion(handleId: string): Promise<number> {
    const entry = this.#handle(handleId);
    await this.#assertDatabaseCurrent(entry, false);
    const version = this.#readUserVersion(entry);
    await this.#assertDatabaseCurrent(entry, false);
    return version;
  }

  #createDatabase(path: string, readonly: boolean, gate: AuthorizerGate): DatabaseSync {
    const database = new DatabaseSync(sqliteFilesystemPath(path), {
      readOnly: readonly,
      allowExtension: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      timeout: 5_000,
      readBigInts: true,
      defensive: true
    });
    try {
      this.#configureDatabase(database, readonly, gate);
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  #configureDatabase(database: DatabaseSync, readonly: boolean, gate: AuthorizerGate): void {
    database.enableLoadExtension(false);
    database.exec("PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000;");
    if (readonly) database.exec("PRAGMA query_only = ON;");
    else database.exec("PRAGMA journal_mode = WAL;");
    database.setAuthorizer((actionCode, arg1, arg2, dbName) => {
      if (gate.internal) return sqliteConstants.SQLITE_OK;
      if (dbName !== null && dbName !== "main") return sqliteConstants.SQLITE_DENY;
      if (actionCode === sqliteConstants.SQLITE_FUNCTION && FORBIDDEN_FUNCTIONS.has((arg2 ?? arg1 ?? "").toLowerCase())) {
        return sqliteConstants.SQLITE_DENY;
      }
      return ALLOWED_AUTHORIZER_ACTIONS.has(actionCode) ? sqliteConstants.SQLITE_OK : sqliteConstants.SQLITE_DENY;
    });
  }

  #handle(handleId: string): OpenDatabase {
    const entry = this.#handles.get(handleId);
    if (entry === undefined) throw new ExtensionLibraryError("NOT_FOUND", "Library database handle is not available.");
    return entry;
  }

  #assertMutationAllowed(entry: OpenDatabase, statement: ValidatedSql): void {
    if (statement.mutates && entry.readonly) throw new ExtensionLibraryError("READ_ONLY", "Library database handle is read-only.");
  }

  async #assertDatabaseCurrent(entry: OpenDatabase, write: boolean): Promise<void> {
    const resolved = await this.#vault.resolveDatabasePath(entry.relativePath, { write });
    if (resolved !== entry.absolutePath) {
      throw new ExtensionLibraryError("CONFLICT", "Library database path authority changed.");
    }
    const current = await databaseIdentity(resolved);
    if (!sameDatabaseObject(entry.identity, current)) {
      throw new ExtensionLibraryError("CONFLICT", "Library database was replaced while its handle was open.");
    }
  }

  #executePrepared(entry: OpenDatabase, sql: string, parameters: readonly SQLInputValue[]): ExtensionLibrarySqlResult {
    try {
      const statement = entry.database.prepare(sql);
      statement.setReadBigInts(true);
      if (statement.columns().length === 0) {
        const result = statement.run(...parameters);
        return {
          rows: [],
          changes: BigInt(result.changes),
          lastInsertRowid: BigInt(result.lastInsertRowid)
        };
      }
      const rows: ExtensionLibrarySqlRow[] = [];
      let bytes = 0;
      for (const raw of statement.iterate(...parameters)) {
        if (rows.length >= this.#limits.maximumRows) {
          throw new ExtensionLibraryError("RESULT_LIMIT", "Library SQL result exceeded the row limit.");
        }
        const row = normalizeRow(raw);
        bytes += rowBytes(row);
        if (bytes > this.#limits.maximumResultBytes) {
          throw new ExtensionLibraryError("RESULT_LIMIT", "Library SQL result exceeded the byte limit.");
        }
        rows.push(row);
      }
      return { rows, changes: 0n };
    } catch (error) {
      throw sqlFailure(error);
    }
  }

  #readUserVersion(entry: OpenDatabase): number {
    return this.#internal(entry, () => {
      const row = entry.database.prepare("PRAGMA user_version").get() as Record<string, SQLOutputValue> | undefined;
      const value = row?.user_version;
      const version = typeof value === "bigint" ? Number(value) : value;
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
        throw new ExtensionLibraryError("CORRUPT", "Library database user version is invalid.");
      }
      return version;
    });
  }

  #assertQuickCheck(entry: OpenDatabase): void {
    this.#internal(entry, () => {
      const rows = entry.database.prepare("PRAGMA quick_check").all() as Record<string, SQLOutputValue>[];
      if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
        throw new ExtensionLibraryError("CORRUPT", "Library database integrity check failed.");
      }
    });
  }

  #begin(entry: OpenDatabase, write: boolean): void {
    this.#internal(entry, () => entry.database.exec(write ? "BEGIN IMMEDIATE" : "BEGIN"));
  }

  #commit(entry: OpenDatabase): void {
    this.#internal(entry, () => entry.database.exec("COMMIT"));
  }

  #rollback(entry: OpenDatabase): void {
    if (!entry.database.isTransaction) return;
    try {
      this.#internal(entry, () => entry.database.exec("ROLLBACK"));
    } catch {
      // The original SQL failure remains authoritative.
    }
  }

  #internal<T>(entry: OpenDatabase, action: () => T): T {
    entry.gate.internal = true;
    try {
      return action();
    } finally {
      entry.gate.internal = false;
    }
  }
}

export function validateExtensionLibrarySql(sql: string): { readonly keyword: string; readonly mutates: boolean } {
  const result = validateSql(sql, EXTENSION_LIBRARY_SQL_LIMITS);
  return { keyword: result.keyword, mutates: result.mutates };
}

function validateStatementBatch(
  statements: readonly { readonly sql: string; readonly parameters?: readonly ExtensionLibrarySqlValue[] }[],
  limits: ExtensionLibrarySqlLimits
): void {
  if (!Array.isArray(statements) || statements.length === 0 || statements.length > limits.maximumBatchStatements) {
    throw new ExtensionLibraryError("TOO_LARGE", "Library SQL batch size is outside the supported boundary.");
  }
  for (const statement of statements) {
    if (statement === null || typeof statement !== "object" || Array.isArray(statement)) {
      throw new ExtensionLibraryError("SQL_REJECTED", "Library SQL batch statement is invalid.");
    }
    validateSql(statement.sql, limits);
    validateParameters(statement.parameters ?? [], limits);
  }
}

function validateMigrationShape(
  migrations: readonly ExtensionLibrarySqlMigration[],
  limits: ExtensionLibrarySqlLimits
): void {
  if (!Array.isArray(migrations) || migrations.length === 0 || migrations.length > limits.maximumBatchStatements) {
    throw new ExtensionLibraryError("TOO_LARGE", "Library database migration count is outside the supported boundary.");
  }
  let previousVersion: number | undefined;
  let statementCount = 0;
  for (const migration of migrations) {
    if (migration === null || typeof migration !== "object" || Array.isArray(migration)
      || !Number.isSafeInteger(migration.version) || migration.version < 1 || !Array.isArray(migration.statements)
      || migration.statements.length === 0 || previousVersion !== undefined && migration.version !== previousVersion + 1) {
      throw new ExtensionLibraryError("CONFLICT", "Library database migrations must be non-empty and contiguous.");
    }
    statementCount += migration.statements.length;
    if (statementCount > limits.maximumBatchStatements) {
      throw new ExtensionLibraryError("TOO_LARGE", "Library database migration statement count exceeded the supported boundary.");
    }
    for (const sql of migration.statements) {
      const statement = validateSql(sql, limits);
      if (!statement.mutates) throw new ExtensionLibraryError("SQL_REJECTED", "Library database migrations may only contain mutations.");
    }
    previousVersion = migration.version;
  }
}

function validateSql(sql: string, limits: ExtensionLibrarySqlLimits): ValidatedSql {
  if (typeof sql !== "string" || sql.length === 0 || sql.length > limits.maximumSqlCharacters || sql.includes("\0")) {
    throw new ExtensionLibraryError("SQL_REJECTED", "Library SQL text is outside the supported boundary.");
  }
  const tokens: string[] = [];
  let index = 0;
  let terminated = false;
  const rejectTrailing = (): never => {
    throw new ExtensionLibraryError("SQL_REJECTED", "Library SQL accepts exactly one statement.");
  };
  while (index < sql.length) {
    const character = sql[index]!;
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index += 1;
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) throw new ExtensionLibraryError("SQL_REJECTED", "Library SQL contains an unterminated comment.");
      index = end + 2;
      continue;
    }
    if (terminated) rejectTrailing();
    if (character === ";") {
      terminated = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) throw new ExtensionLibraryError("SQL_REJECTED", "Library SQL contains an unterminated quoted value.");
      continue;
    }
    if (character === "[") {
      const end = sql.indexOf("]", index + 1);
      if (end < 0) throw new ExtensionLibraryError("SQL_REJECTED", "Library SQL contains an unterminated identifier.");
      index = end + 1;
      continue;
    }
    if (/[A-Za-z_]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_$]/u.test(sql[index]!)) index += 1;
      tokens.push(sql.slice(start, index).toUpperCase());
      continue;
    }
    index += 1;
  }
  const keyword = tokens[0];
  if (keyword === undefined || !ALLOWED_FIRST_KEYWORDS.has(keyword)) {
    throw new ExtensionLibraryError("SQL_REJECTED", "Library SQL statement type is not allowed.");
  }
  const forbidden = tokens.find((token) => FORBIDDEN_KEYWORDS.has(token));
  if (forbidden !== undefined) throw new ExtensionLibraryError("SQL_REJECTED", `Library SQL keyword ${forbidden} is not allowed.`);
  const mutates = keyword === "WITH"
    ? tokens.some((token) => MUTATING_KEYWORDS.has(token))
    : MUTATING_KEYWORDS.has(keyword);
  return { sql, keyword, mutates };
}

function validateParameters(
  parameters: readonly ExtensionLibrarySqlValue[],
  limits: ExtensionLibrarySqlLimits
): readonly SQLInputValue[] {
  if (!Array.isArray(parameters) || parameters.length > limits.maximumParameters) {
    throw new ExtensionLibraryError("TOO_LARGE", "Library SQL parameter count exceeded the supported boundary.");
  }
  let bytes = 0;
  return parameters.map((value) => {
    if (value === null) return null;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new ExtensionLibraryError("SQL_REJECTED", "Library SQL numeric parameters must be finite.");
      bytes += 8;
      assertParameterBytes(bytes, limits);
      return value;
    }
    if (typeof value === "bigint") {
      if (value < -9_223_372_036_854_775_808n || value > 9_223_372_036_854_775_807n) {
        throw new ExtensionLibraryError("SQL_REJECTED", "Library SQL integer parameters must fit SQLite int64.");
      }
      bytes += Buffer.byteLength(value.toString(10));
      assertParameterBytes(bytes, limits);
      return value;
    }
    if (typeof value === "string") {
      bytes += Buffer.byteLength(value);
      assertParameterBytes(bytes, limits);
      return value;
    }
    if (value instanceof Uint8Array) {
      bytes += value.byteLength;
      assertParameterBytes(bytes, limits);
      return Buffer.from(value);
    }
    throw new ExtensionLibraryError("SQL_REJECTED", "Library SQL parameter type is not supported.");
  });
}

function assertParameterBytes(bytes: number, limits: ExtensionLibrarySqlLimits): void {
  if (!Number.isSafeInteger(bytes) || bytes > limits.maximumResultBytes) {
    throw new ExtensionLibraryError("TOO_LARGE", "Library SQL parameters exceeded the byte limit.");
  }
}

function normalizeRow(row: Record<string, SQLOutputValue>): ExtensionLibrarySqlRow {
  const result: Record<string, ExtensionLibrarySqlValue> = Object.create(null) as Record<string, ExtensionLibrarySqlValue>;
  for (const [key, value] of Object.entries(row)) {
    result[key] = value instanceof Uint8Array ? Uint8Array.from(value) : value;
  }
  return Object.freeze(result);
}

function rowBytes(row: ExtensionLibrarySqlRow): number {
  let bytes = 2;
  for (const [key, value] of Object.entries(row)) {
    bytes += Buffer.byteLength(key) + 4;
    if (value === null) bytes += 1;
    else if (typeof value === "number") bytes += 8;
    else if (typeof value === "bigint") bytes += Buffer.byteLength(value.toString(10));
    else if (typeof value === "string") bytes += Buffer.byteLength(value);
    else bytes += value.byteLength;
  }
  return bytes;
}

function sqlFailure(error: unknown): ExtensionLibraryError {
  if (error instanceof ExtensionLibraryError) return error;
  const message = error instanceof Error ? error.message : "Unknown SQLite failure.";
  if (/not authorized|authorization denied|SQLITE_AUTH/iu.test(message)) {
    return new ExtensionLibraryError("SQL_REJECTED", "Library SQL operation is not allowed.", { cause: error });
  }
  if (/database or disk is full|SQLITE_FULL|ENOSPC/iu.test(message)) {
    return new ExtensionLibraryError("DISK_FULL", "Library database disk space is exhausted.", { cause: error });
  }
  if (/readonly|read-only|SQLITE_READONLY/iu.test(message)) {
    return new ExtensionLibraryError("READ_ONLY", "Library database is read-only.", { cause: error });
  }
  return new ExtensionLibraryError("SQL_FAILED", "Library SQL execution failed.", { cause: error });
}

/** SQLite's Windows VFS still requires the extended namespace beyond MAX_PATH. */
function sqliteFilesystemPath(path: string): string {
  return toNamespacedPath(path);
}

async function databaseIdentity(path: string): Promise<BigIntStats> {
  const value = await lstat(path, { bigint: true });
  if (!value.isFile() || value.isSymbolicLink()) {
    throw new ExtensionLibraryError("CONFLICT", "Library database is not a regular file.");
  }
  return value;
}

async function assertDatabaseIdentity(path: string, expected: BigIntStats | undefined): Promise<void> {
  if (expected === undefined) {
    throw new ExtensionLibraryError("CONFLICT", "Library database identity could not be established.");
  }
  const current = await databaseIdentity(path);
  if (!sameDatabaseObject(expected, current)) {
    throw new ExtensionLibraryError("CONFLICT", "Library database changed before it was opened.");
  }
}

function sameDatabaseObject(left: BigIntStats, right: BigIntStats): boolean {
  if (!left.isFile() || !right.isFile() || left.dev !== right.dev) return false;
  if (left.ino !== 0n && right.ino !== 0n) return left.ino === right.ino;
  return left.ino === 0n && right.ino === 0n && left.birthtimeNs !== 0n && left.birthtimeNs === right.birthtimeNs;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function alreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function validWorkerReply(value: unknown): value is ExtensionLibrarySqlWorkerReply {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate["id"]) || (candidate["id"] as number) < 1 || typeof candidate["ok"] !== "boolean") return false;
  if (candidate["ok"] === true) return Object.keys(candidate).every((key) => ["id", "ok", "value"].includes(key)) && "value" in candidate;
  const error = candidate["error"];
  return Object.keys(candidate).every((key) => ["id", "ok", "error"].includes(key))
    && error !== null && typeof error === "object" && !Array.isArray(error)
    && Object.keys(error).every((key) => ["code", "message"].includes(key))
    && typeof (error as Record<string, unknown>)["code"] === "string"
    && FAILURE_CODES.has((error as Record<string, unknown>)["code"] as ExtensionLibraryFailureCode)
    && typeof (error as Record<string, unknown>)["message"] === "string"
    && Buffer.byteLength((error as Record<string, unknown>)["message"] as string) <= 4_096;
}
