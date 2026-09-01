import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import type { NativeSessionBinding } from "@joko/core";
import { asPiError, piError, redactedDiagnostic } from "./errors.js";
import { MAX_SAFE_PI_JSONL_RECORD_BYTES, StrictJsonLineDecoder } from "./jsonl.js";
import { isRecord } from "./protocol.js";

export interface PiNativeSessionInfo {
  readonly path: string;
  readonly id?: string;
  readonly cwd?: string;
  readonly name?: string;
  readonly parentSession?: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
  readonly messageCount: number;
  readonly firstMessage?: string;
  readonly state: "ready" | "error";
  readonly error?: string;
}

export interface PiExternalSessionSource {
  /** Adapter-opaque reference. It intentionally contains no source path. */
  readonly reference: string;
  /** Canonical, read-only discovery root. Never exposed through product contracts. */
  readonly root: string;
  /** Canonical source file. It is revalidated before any bytes are copied. */
  readonly path: string;
  readonly workspaceRoot: string;
  readonly identity: {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
  };
}

export interface PiExternalNativeSessionInfo extends PiNativeSessionInfo {
  readonly source: PiExternalSessionSource;
}

export interface PiPortableNativeSession {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly nativeSessionId: string;
}

export interface PiPortableSessionImportOptions {
  readonly workspaceRoot: string;
  readonly generation: number;
  readonly nativeSessionId?: string;
  readonly maximumBytes?: number;
}

export interface PiDetachedForkMaterialization {
  readonly binding: NativeSessionBinding;
  readonly parentSession: string;
  readonly entries: readonly unknown[];
}

const DEFAULT_PORTABLE_SESSION_LIMIT_BYTES = 512 * 1024 * 1024;

export class PiSessionStore {
  readonly root: string;
  readonly sessionsRoot: string;
  readonly trashRoot: string;

  constructor(sessionRoot: string) {
    if (!isAbsolute(sessionRoot) || resolve(sessionRoot) !== sessionRoot) {
      throw piError("PI_INVALID_SESSION_ROOT", "Pi Session Root must be a normalized absolute path", "session");
    }
    this.root = sessionRoot;
    this.sessionsRoot = resolve(this.root, "sessions");
    this.trashRoot = resolve(this.root, "trash", "sessions");
  }

  async initialize(): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true });
      const rootInfo = await lstat(this.root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(await realpath(this.root), this.root)) {
        throw piError("PI_SESSION_ROOT_UNSAFE", "Pi Session Root must be a canonical regular directory", "session");
      }
      await Promise.all([mkdir(this.sessionsRoot, { recursive: true }), mkdir(this.trashRoot, { recursive: true })]);
      for (const path of [this.sessionsRoot, this.trashRoot]) {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw piError("PI_SESSION_DIRECTORY_UNSAFE", "Managed Pi session storage contains a symlink or non-directory", "session");
        }
        const canonical = await realpath(path);
        assertContained(await realpath(this.root), canonical);
        if (!samePath(canonical, path)) {
          throw piError("PI_SESSION_DIRECTORY_ALIAS_DENIED", "Managed Pi session storage contains a path alias or parent junction", "session");
        }
      }
    } catch (error) {
      throw asPiError(error, {
        code: "PI_SESSION_STORE_INIT_FAILED",
        phase: "session",
        retryable: true,
        recovery: "Ensure the service account can create the managed Pi session and trash directories."
      });
    }
  }

  async list(workspaceRoot?: string): Promise<readonly PiNativeSessionInfo[]> {
    try {
      await this.initialize();
      const files = await collectSessionFiles(this.sessionsRoot);
      const canonicalWorkspace = workspaceRoot ? await realpath(resolve(workspaceRoot)) : undefined;
      const values: PiNativeSessionInfo[] = [];
      for (const path of files) {
        const parsed = await inspectSessionFile(path);
        if (canonicalWorkspace && parsed.cwd) {
          const canonicalCwd = await realpath(resolve(parsed.cwd)).catch(() => undefined);
          if (!canonicalCwd || !samePath(canonicalCwd, canonicalWorkspace)) continue;
        } else if (canonicalWorkspace) {
          continue;
        }
        values.push(parsed);
      }
      values.sort((left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path));
      return values;
    } catch (error) {
      throw asPiError(error, {
        code: "PI_SESSION_LIST_FAILED",
        phase: "session",
        retryable: true,
        recovery: "Retry after the managed session directory is stable and accessible."
      });
    }
  }

  async binding(path: string, generation: number): Promise<NativeSessionBinding> {
    try {
      const safePath = await this.assertManagedSession(path);
      const info = await inspectSessionFile(safePath);
      if (info.state === "error" || !info.id) {
        throw piError("PI_SESSION_INVALID", `Cannot bind invalid Pi session '${safePath}'`, "session", {
          recovery: "Restore or repair the native JSONL session before resuming it."
        });
      }
      return { opaqueRef: safePath, nativeSessionId: info.id, generation };
    } catch (error) {
      throw asPiError(error, {
        code: "PI_SESSION_BIND_FAILED",
        phase: "session",
        recovery: "Select a valid managed native JSONL session and retry."
      });
    }
  }

  /**
   * Discover upstream Pi JSONL without adopting or mutating its storage root.
   * Only histories whose persisted cwd resolves to the authorized workspace are
   * projected; the returned product reference is opaque and path-free.
   */
  async listExternal(
    roots: readonly string[],
    workspaceRoot: string
  ): Promise<readonly PiExternalNativeSessionInfo[]> {
    const canonicalWorkspace = await canonicalWorkspaceRoot(workspaceRoot);
    const values: PiExternalNativeSessionInfo[] = [];
    const seenRoots = new Set<string>();
    for (const configuredRoot of roots) {
      const root = await canonicalExternalSessionRoot(configuredRoot);
      if (root === undefined) continue;
      const rootKey = pathKey(root);
      if (seenRoots.has(rootKey)) continue;
      seenRoots.add(rootKey);
      if (pathsOverlap(root, this.sessionsRoot)) {
        throw piError(
          "PI_EXTERNAL_SESSION_ROOT_OVERLAP",
          "External Pi history discovery must not overlap managed Session storage",
          "session",
          { recovery: "Choose a separate read-only upstream Pi sessions directory." }
        );
      }
      const files = await collectSessionFiles(root);
      for (const path of files) {
        const before = await lstat(path);
        if (!before.isFile() || before.isSymbolicLink()) continue;
        const parsed = await inspectSessionFile(path);
        const after = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (
          after === undefined || !after.isFile() || after.isSymbolicLink() ||
          !sameExternalFileSnapshot(before, after)
        ) {
          throw piError(
            "PI_EXTERNAL_SESSION_DISCOVERY_RACE",
            "An upstream Pi history changed while it was being inspected",
            "session",
            { retryable: true, recovery: "Retry after the upstream Pi turn has finished writing." }
          );
        }
        if (parsed.cwd === undefined) continue;
        const candidateWorkspace = await realpath(resolve(parsed.cwd)).catch(() => undefined);
        if (candidateWorkspace === undefined || !samePath(candidateWorkspace, canonicalWorkspace)) continue;
        const source: PiExternalSessionSource = {
          reference: externalSessionReference(root, path, before),
          root,
          path,
          workspaceRoot: canonicalWorkspace,
          identity: externalFileIdentity(before)
        };
        values.push({ ...parsed, source });
      }
    }
    values.sort((left, right) => right.modifiedAt - left.modifiedAt || left.source.reference.localeCompare(right.source.reference));
    return values;
  }

  /**
   * Revalidate and copy one previously discovered upstream history into the
   * managed store. The source is opened read-only and never becomes a runtime
   * binding; portable import rewrites the header to a new managed identity.
   */
  async importExternalSession(
    source: PiExternalSessionSource,
    options: PiPortableSessionImportOptions
  ): Promise<NativeSessionBinding> {
    const limit = portableSessionLimit(options.maximumBytes);
    const canonicalWorkspace = await canonicalWorkspaceRoot(options.workspaceRoot);
    if (!samePath(source.workspaceRoot, canonicalWorkspace)) {
      throw piError(
        "PI_EXTERNAL_SESSION_WORKSPACE_MISMATCH",
        "The upstream Pi history does not belong to the selected workspace",
        "session",
        { recovery: "Rescan and select the history from its matching Target." }
      );
    }
    const root = await canonicalExternalSessionRoot(source.root);
    if (root === undefined || !samePath(root, source.root) || pathsOverlap(root, this.sessionsRoot)) {
      throw piError(
        "PI_EXTERNAL_SESSION_SOURCE_UNAVAILABLE",
        "The upstream Pi history root is no longer available for import",
        "session",
        { retryable: true, recovery: "Restore the same upstream Pi history root and rescan." }
      );
    }
    if (!isAbsolute(source.path) || resolve(source.path) !== source.path) {
      throw piError("PI_EXTERNAL_SESSION_PATH_DENIED", "The upstream Pi history reference is invalid", "session");
    }
    assertContained(root, source.path);
    const pathInfo = await lstat(source.path).catch((error) => {
      throw piError(
        "PI_EXTERNAL_SESSION_SOURCE_UNAVAILABLE",
        "The upstream Pi history is no longer available for import",
        "session",
        { retryable: true, recovery: "Restore the same upstream Pi history file and rescan.", cause: error }
      );
    });
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
      throw piError("PI_EXTERNAL_SESSION_PATH_DENIED", "The upstream Pi history must be a regular non-symlink file", "session");
    }
    const canonicalPath = await realpath(source.path).catch((error) => {
      throw piError("PI_EXTERNAL_SESSION_PATH_DENIED", "The upstream Pi history path cannot be resolved safely", "session", { cause: error });
    });
    assertContained(root, canonicalPath);
    if (!samePath(canonicalPath, source.path) || !sameExternalIdentity(source.identity, pathInfo)) {
      throw externalSessionChanged();
    }
    if (pathInfo.size > limit) {
      throw piError("PI_EXTERNAL_SESSION_TOO_LARGE", "The upstream Pi history exceeds the import size limit", "session");
    }
    const expectedReference = externalSessionReference(root, canonicalPath, pathInfo);
    if (expectedReference !== source.reference) throw externalSessionChanged();

    const handle = await open(canonicalPath, "r").catch((error) => {
      throw piError(
        "PI_EXTERNAL_SESSION_OPEN_FAILED",
        "The upstream Pi history could not be opened for read-only import",
        "session",
        { retryable: true, recovery: "Close conflicting filesystem operations and rescan.", cause: error }
      );
    });
    let bytes: Buffer;
    try {
      const before = await handle.stat();
      if (!before.isFile() || !sameExternalIdentity(source.identity, before) || before.size > limit) {
        throw externalSessionChanged();
      }
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (!sameExternalFileSnapshot(before, after) || !sameExternalIdentity(source.identity, after)) {
        throw externalSessionChanged();
      }
    } finally {
      await handle.close();
    }
    return this.importPortableSession(bytes, {
      workspaceRoot: canonicalWorkspace,
      generation: options.generation,
      maximumBytes: limit
    });
  }

  async exportPortableSession(
    path: string,
    maximumBytes = DEFAULT_PORTABLE_SESSION_LIMIT_BYTES
  ): Promise<PiPortableNativeSession> {
    const limit = portableSessionLimit(maximumBytes);
    const safePath = await this.assertManagedSession(path);
    const handle = await open(safePath, "r").catch((error) => {
      throw asPiError(error, {
        code: "PI_SESSION_EXPORT_OPEN_FAILED",
        phase: "session",
        retryable: true,
        recovery: "Retry after the native Session file is stable and readable."
      });
    });
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.isSymbolicLink() || before.size > limit) {
        if (before.size > limit) {
          throw piError("PI_SESSION_EXPORT_TOO_LARGE", "Native Session exceeds the portable package limit", "session");
        }
        throw piError("PI_SESSION_EXPORT_UNSAFE", "Native Session export requires a regular non-symlink file", "session");
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (!sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw piError("PI_SESSION_EXPORT_RACE", "Native Session changed while it was being exported", "session", {
          retryable: true,
          recovery: "Retry after the active turn and native Session write settle."
        });
      }
      const inspected = inspectPortableSessionBytes(bytes, limit);
      return {
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        nativeSessionId: inspected.nativeSessionId
      };
    } finally {
      await handle.close();
    }
  }

  async importPortableSession(
    source: Uint8Array,
    options: PiPortableSessionImportOptions
  ): Promise<NativeSessionBinding> {
    const limit = portableSessionLimit(options.maximumBytes);
    if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
      throw piError("PI_SESSION_IMPORT_GENERATION_INVALID", "Portable Session generation is invalid", "session");
    }
    const canonicalWorkspace = await canonicalWorkspaceRoot(options.workspaceRoot);
    const desiredId = options.nativeSessionId ?? randomUUID();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(desiredId)) {
      throw piError("PI_SESSION_IMPORT_ID_INVALID", "Portable native Session ID is invalid", "session");
    }
    const normalized = rewritePortableSessionBytes(source, canonicalWorkspace, desiredId, limit);
    await this.initialize();
    const sharedRoot = join(this.sessionsRoot, "shared");
    await mkdir(sharedRoot, { recursive: true });
    const directoryInfo = await lstat(sharedRoot);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw piError("PI_SESSION_IMPORT_DIRECTORY_UNSAFE", "Portable Session import directory is unsafe", "session");
    }
    const canonicalSharedRoot = await realpath(sharedRoot);
    assertContained(await realpath(this.sessionsRoot), canonicalSharedRoot);
    if (!samePath(canonicalSharedRoot, sharedRoot)) {
      throw piError("PI_SESSION_IMPORT_DIRECTORY_ALIAS_DENIED", "Portable Session import directory is aliased", "session");
    }
    const digest = createHash("sha256").update(normalized).digest("hex");
    const target = join(canonicalSharedRoot, `${digest.slice(0, 24)}-${randomUUID()}.jsonl`);
    try {
      await writeFile(target, normalized, { flag: "wx", mode: 0o600 });
      const binding = await this.binding(target, options.generation);
      if (binding.nativeSessionId !== desiredId) {
        throw piError("PI_SESSION_IMPORT_ID_MISMATCH", "Portable native Session identity could not be materialized", "session");
      }
      return binding;
    } catch (error) {
      await unlink(target).catch(() => undefined);
      throw asPiError(error, {
        code: "PI_SESSION_IMPORT_WRITE_FAILED",
        phase: "session",
        retryable: true,
        recovery: "Retry after the managed Session storage becomes writable."
      });
    }
  }

  async materializeDetachedFork(input: PiDetachedForkMaterialization): Promise<NativeSessionBinding> {
    if (input.binding.nativeSessionId === undefined) {
      throw piError("PI_FORK_MATERIALIZATION_ID_MISSING", "Detached fork has no native Session identity", "session");
    }
    const nativeSessionId = input.binding.nativeSessionId;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nativeSessionId)) {
      throw piError("PI_FORK_MATERIALIZATION_ID_INVALID", "Detached fork native Session identity is invalid", "session");
    }
    const [target, parentSession] = await Promise.all([
      this.assertManagedSessionReference(input.binding.opaqueRef, { requireExists: false }),
      this.assertManagedSession(input.parentSession)
    ]);
    const parentInfo = await inspectSessionFile(parentSession);
    if (parentInfo.state !== "ready" || typeof parentInfo.cwd !== "string" || parentInfo.cwd.trim() === "" || parentInfo.cwd.includes("\0")) {
      throw piError("PI_FORK_MATERIALIZATION_SOURCE_INVALID", "Detached fork source has no valid native workspace", "session");
    }
    const existing = await lstat(target).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (existing) return this.#confirmMaterializedFork(target, nativeSessionId, input.binding.generation);

    if (input.entries.length > 1_000_000) {
      throw piError("PI_FORK_MATERIALIZATION_RECORD_LIMIT", "Detached fork contains too many native records", "session");
    }
    const timestamp = new Date().toISOString();
    const records: Record<string, unknown>[] = [{
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: nativeSessionId,
      timestamp,
      cwd: parentInfo.cwd,
      parentSession
    }];
    for (const value of input.entries) {
      if (
        !isRecord(value)
        || value.type === "session"
        || typeof value.type !== "string"
        || typeof value.id !== "string"
        || (value.parentId !== null && typeof value.parentId !== "string")
      ) {
        throw piError("PI_FORK_MATERIALIZATION_RECORD_INVALID", "Detached fork contains an invalid native record", "session");
      }
      records.push(value);
    }
    const lines: string[] = [];
    let outputBytes = 0;
    for (const record of records) {
      const line = JSON.stringify(record);
      const recordBytes = Buffer.byteLength(line, "utf8");
      if (recordBytes > MAX_SAFE_PI_JSONL_RECORD_BYTES) {
        throw piError("PI_FORK_MATERIALIZATION_RECORD_TOO_LARGE", "Detached fork contains an oversized native record", "session");
      }
      outputBytes += recordBytes + 1;
      if (!Number.isSafeInteger(outputBytes) || outputBytes > DEFAULT_PORTABLE_SESSION_LIMIT_BYTES) {
        throw piError("PI_FORK_MATERIALIZATION_TOO_LARGE", "Detached fork exceeds the native Session size limit", "session");
      }
      lines.push(line);
    }
    let created = false;
    try {
      await writeFile(target, Buffer.from(`${lines.join("\n")}\n`, "utf8"), { flag: "wx", mode: 0o600 });
      created = true;
      return await this.#confirmMaterializedFork(target, nativeSessionId, input.binding.generation);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return this.#confirmMaterializedFork(target, nativeSessionId, input.binding.generation);
      }
      if (created) await unlink(target).catch(() => undefined);
      throw asPiError(error, {
        code: "PI_FORK_MATERIALIZATION_FAILED",
        phase: "session",
        retryable: true,
        recovery: "Keep the source Session attached and retry detached fork materialization."
      });
    }
  }

  async #confirmMaterializedFork(path: string, nativeSessionId: string, generation: number): Promise<NativeSessionBinding> {
    const binding = await this.binding(path, generation);
    if (binding.nativeSessionId !== nativeSessionId) {
      throw piError("PI_FORK_MATERIALIZATION_ID_MISMATCH", "Detached fork path belongs to another native Session", "session", {
        recovery: "Reconcile the detached native Session list before retrying the fork."
      });
    }
    return binding;
  }

  async moveToTrash(path: string, recoveryKey?: string): Promise<string> {
    if (recoveryKey !== undefined && !/^[a-f0-9]{64}$/u.test(recoveryKey)) {
      throw piError("PI_SESSION_TRASH_KEY_INVALID", "Native session trash recovery key is invalid", "session");
    }
    const safePath = recoveryKey === undefined
      ? await this.assertManagedSession(path)
      : await this.assertManagedSessionReference(path, { requireExists: false });
    await mkdir(this.trashRoot, { recursive: true }).catch((error) => {
      throw asPiError(error, {
        code: "PI_SESSION_TRASH_UNAVAILABLE",
        phase: "session",
        retryable: true,
        recovery: "Ensure the service account can write the managed Pi trash directory."
      });
    });
    const trashInfo = await lstat(this.trashRoot);
    if (!trashInfo.isDirectory() || trashInfo.isSymbolicLink()
        || !samePath(await realpath(this.trashRoot), this.trashRoot)) {
      throw piError("PI_SESSION_TRASH_UNSAFE", "Managed Pi trash storage is not a canonical directory", "session");
    }
    const target = join(
      this.trashRoot,
      recoveryKey === undefined
        ? `${Date.now()}-${randomUUID()}-${basename(safePath)}`
        : `${recoveryKey}-${basename(safePath)}`
    );
    if (recoveryKey !== undefined) {
      const [sourceInfo, targetInfo] = await Promise.all([
        lstat(safePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        }),
        lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        })
      ]);
      if (targetInfo !== undefined) {
        if (!targetInfo.isFile() || targetInfo.isSymbolicLink()
            || !samePath(await realpath(target), target)) {
          throw piError("PI_SESSION_TRASH_RECOVERY_UNSAFE", "Recovered native session trash entry is unsafe", "session");
        }
        if (sourceInfo === undefined) return target;
        throw piError("PI_SESSION_TRASH_RECOVERY_CONFLICT", "Both the native session and its recovered trash entry exist", "session", {
          stateMayHaveChanged: true,
          recovery: "Inspect the exact managed Session and trash entry before retrying deletion."
        });
      }
      if (sourceInfo === undefined) {
        throw piError("PI_SESSION_NOT_FOUND", `Native Pi session '${safePath}' and its recovered trash entry do not exist`, "session", {
          stateMayHaveChanged: true,
          recovery: "Restore the exact native Session or reconcile the recorded remote deletion before retrying."
        });
      }
      await this.assertManagedSession(safePath);
    }
    try {
      await rename(safePath, target);
      return target;
    } catch (error) {
      throw piError("PI_SESSION_DELETE_FAILED", `Failed to move native session '${safePath}' to managed trash`, "session", {
        recovery: "Stop all runtimes using the session and retry; the JSONL file was not intentionally unlinked.",
        cause: error
      });
    }
  }

  async assertManagedSession(path: string): Promise<string> {
    return this.assertManagedSessionReference(path, { requireExists: true });
  }

  async assertManagedSessionReference(path: string, options: { readonly requireExists: boolean }): Promise<string> {
    if (!isAbsolute(path) || extname(path).toLowerCase() !== ".jsonl") {
      throw piError("PI_SESSION_PATH_DENIED", "Native session reference is not an absolute JSONL path", "session");
    }
    const resolved = resolve(path);
    assertContained(this.sessionsRoot, resolved);
    const info = await lstat(resolved).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && !options.requireExists) return undefined;
      throw piError("PI_SESSION_NOT_FOUND", `Native Pi session '${resolved}' does not exist`, "session", {
        recovery: "Select another session or restore the missing native JSONL file.",
        cause: error
      });
    });
    if (!info) {
      const canonicalRoot = await managedRealpath(this.sessionsRoot);
      const canonicalParent = await managedRealpath(dirname(resolved));
      assertContained(canonicalRoot, canonicalParent);
      return resolved;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw piError("PI_SESSION_PATH_DENIED", "Native session reference must be a regular non-symlink file", "session");
    }
    const canonical = await managedRealpath(resolved);
    assertContained(await managedRealpath(this.sessionsRoot), canonical);
    return canonical;
  }
}

async function collectSessionFiles(root: string): Promise<string[]> {
  const canonicalRoot = await realpath(root);
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw piError("PI_SESSION_DIRECTORY_UNSAFE", "Managed Pi session tree contains a symlink or non-directory", "session");
    }
    const canonicalDirectory = await realpath(directory);
    assertContained(canonicalRoot, canonicalDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const localFiles: string[] = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info || info.isSymbolicLink()) continue;
      const canonical = await realpath(path);
      assertContained(canonicalRoot, canonical);
      if (info.isDirectory() && entry.isDirectory()) {
        await visit(path);
      } else if (info.isFile() && entry.isFile() && extname(entry.name).toLowerCase() === ".jsonl") {
        localFiles.push(canonical);
      }
    }
    const after = await lstat(directory);
    if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after) || after.mtimeMs !== before.mtimeMs) {
      throw piError("PI_SESSION_DIRECTORY_RACE", "Managed Pi session tree changed while it was being listed", "session", {
        retryable: true,
        recovery: "Retry the native session listing after session creation or deletion settles."
      });
    }
    result.push(...localFiles);
  };
  await visit(canonicalRoot);
  return result;
}

async function inspectSessionFile(path: string): Promise<PiNativeSessionInfo> {
  const fileStat = await stat(path);
  let id: string | undefined;
  let cwd: string | undefined;
  let name: string | undefined;
  let parentSession: string | undefined;
  let messageCount = 0;
  let firstMessage: string | undefined;
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
      const decoder = new StrictJsonLineDecoder({
        // A native message line may contain Pi's inline base64 image. Bound it
        // by both the stable file snapshot and V8's parseable string ceiling.
        maxRecordBytes: Math.min(Math.max(1, fileStat.size), MAX_SAFE_PI_JSONL_RECORD_BYTES),
        onValue(value) {
          if (!isRecord(value) || typeof value.type !== "string") return;
          if (value.type === "session") {
            if (typeof value.id === "string") id = value.id;
            if (typeof value.cwd === "string") cwd = value.cwd;
            if (typeof value.parentSession === "string") parentSession = value.parentSession;
            return;
          }
          if (value.type === "session_info" && typeof value.name === "string") name = value.name;
          if (value.type !== "message" || !isRecord(value.message)) return;
          messageCount += 1;
          if (firstMessage !== undefined || value.message.role !== "user") return;
          firstMessage = extractMessageText(value.message).slice(0, 500) || undefined;
        }
      });
      stream.on("data", (chunk: Buffer | string) => {
        try {
          decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        } catch (error) {
          stream.destroy(error instanceof Error ? error : new Error("Invalid session JSONL"));
        }
      });
      stream.once("error", rejectPromise);
      stream.once("end", () => {
        try {
          decoder.end();
          resolvePromise();
        } catch (error) {
          rejectPromise(error);
        }
      });
    });
    if (!id) throw piError("PI_SESSION_HEADER_MISSING", "Session JSONL does not contain a valid header", "session");
    return {
      path,
      id,
      cwd,
      name,
      parentSession,
      createdAt: fileStat.birthtimeMs || fileStat.ctimeMs,
      modifiedAt: fileStat.mtimeMs,
      messageCount,
      firstMessage,
      state: "ready"
    };
  } catch (error) {
    return {
      path,
      createdAt: fileStat.birthtimeMs || fileStat.ctimeMs,
      modifiedAt: fileStat.mtimeMs,
      messageCount,
      state: "error",
      error: redactedDiagnostic(error)
    };
  }
}

function extractMessageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("\n");
}

function inspectPortableSessionBytes(
  bytes: Uint8Array,
  maximumBytes: number
): { readonly nativeSessionId: string } {
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw piError("PI_SESSION_PORTABLE_SIZE_INVALID", "Portable native Session size is invalid", "session");
  }
  let nativeSessionId: string | undefined;
  let records = 0;
  const decoder = new StrictJsonLineDecoder({
    maxRecordBytes: Math.min(bytes.byteLength, maximumBytes, MAX_SAFE_PI_JSONL_RECORD_BYTES),
    onValue(value) {
      records += 1;
      if (records > 1_000_000) {
        throw piError("PI_SESSION_PORTABLE_RECORD_LIMIT", "Portable native Session contains too many records", "session");
      }
      if (records !== 1 || !isRecord(value) || value.type !== "session" || typeof value.id !== "string") {
        if (records === 1) {
          throw piError("PI_SESSION_PORTABLE_HEADER_INVALID", "Portable native Session has no valid leading header", "session");
        }
        return;
      }
      if (value.id.length === 0 || value.id.length > 128 || value.id.includes("\0")) {
        throw piError("PI_SESSION_PORTABLE_ID_INVALID", "Portable native Session identity is invalid", "session");
      }
      nativeSessionId = value.id;
    }
  });
  try {
    decoder.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    decoder.end();
  } catch (error) {
    throw piError("PI_SESSION_PORTABLE_JSONL_INVALID", "Portable native Session JSONL is invalid", "session", {
      recovery: "Choose a complete native Session export with strict JSONL framing.",
      cause: error
    });
  }
  if (!nativeSessionId) {
    throw piError("PI_SESSION_PORTABLE_HEADER_INVALID", "Portable native Session has no valid leading header", "session");
  }
  return { nativeSessionId };
}

function rewritePortableSessionBytes(
  source: Uint8Array,
  workspaceRoot: string,
  nativeSessionId: string,
  maximumBytes: number
): Buffer {
  inspectPortableSessionBytes(source, maximumBytes);
  const lines: string[] = [];
  let recordIndex = 0;
  let outputBytes = 0;
  const decoder = new StrictJsonLineDecoder({
    maxRecordBytes: Math.min(source.byteLength, maximumBytes, MAX_SAFE_PI_JSONL_RECORD_BYTES),
    onValue(value) {
      recordIndex += 1;
      if (!isRecord(value)) {
        throw piError("PI_SESSION_PORTABLE_RECORD_INVALID", "Portable native Session contains a non-object record", "session");
      }
      let next: Record<string, unknown> = value;
      if (recordIndex === 1) {
        next = { ...value, id: nativeSessionId, cwd: workspaceRoot };
        delete next.parentSession;
      } else if (value.type === "session") {
        throw piError("PI_SESSION_PORTABLE_HEADER_DUPLICATED", "Portable native Session contains a duplicate header", "session");
      }
      const line = JSON.stringify(next);
      outputBytes += Buffer.byteLength(line, "utf8") + 1;
      if (!Number.isSafeInteger(outputBytes) || outputBytes > maximumBytes) {
        throw piError("PI_SESSION_PORTABLE_SIZE_INVALID", "Rewritten portable native Session exceeds the size limit", "session");
      }
      lines.push(line);
    }
  });
  try {
    decoder.push(Buffer.from(source.buffer, source.byteOffset, source.byteLength));
    decoder.end();
  } catch (error) {
    throw piError("PI_SESSION_PORTABLE_REWRITE_FAILED", "Portable native Session could not be safely rewritten", "session", {
      recovery: "Choose a complete native Session export and a canonical destination workspace.",
      cause: error
    });
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

async function canonicalWorkspaceRoot(workspaceRoot: string): Promise<string> {
  if (!isAbsolute(workspaceRoot) || resolve(workspaceRoot) !== workspaceRoot) {
    throw piError("PI_SESSION_IMPORT_WORKSPACE_INVALID", "Portable Session workspace must be a normalized absolute path", "session");
  }
  try {
    const info = await lstat(workspaceRoot);
    const canonical = await realpath(workspaceRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(canonical, workspaceRoot)) {
      throw piError("PI_SESSION_IMPORT_WORKSPACE_UNSAFE", "Portable Session workspace must be a canonical regular directory", "session");
    }
    return canonical;
  } catch (error) {
    throw asPiError(error, {
      code: "PI_SESSION_IMPORT_WORKSPACE_UNAVAILABLE",
      phase: "session",
      recovery: "Select an existing canonical workspace on the service node."
    });
  }
}

function portableSessionLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_PORTABLE_SESSION_LIMIT_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_PORTABLE_SESSION_LIMIT_BYTES) {
    throw piError("PI_SESSION_PORTABLE_LIMIT_INVALID", "Portable Session byte limit is invalid", "session");
  }
  return limit;
}

function assertContained(root: string, candidate: string): void {
  const suffix = relative(resolve(root), resolve(candidate));
  if (suffix !== "" && (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))) {
    throw piError("PI_SESSION_PATH_ESCAPE", "Native session path escapes the managed session root", "session");
  }
}

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && (left.ino === 0 || right.ino === 0 || left.ino === right.ino);
}

function externalFileIdentity(value: {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}): PiExternalSessionSource["identity"] {
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs
  };
}

function sameExternalIdentity(
  expected: PiExternalSessionSource["identity"],
  actual: { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number }
): boolean {
  return sameIdentity(expected, actual) &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs &&
    expected.ctimeMs === actual.ctimeMs;
}

function sameExternalFileSnapshot(
  left: { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number },
  right: { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number }
): boolean {
  return sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function externalSessionReference(
  root: string,
  path: string,
  identity: { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number }
): string {
  const digest = createHash("sha256")
    .update("joko-pi-external-session-v1\0")
    .update(root)
    .update("\0")
    .update(path)
    .update("\0")
    .update(JSON.stringify(externalFileIdentity(identity)))
    .digest("hex");
  return `pi-external-session:${digest}`;
}

async function canonicalExternalSessionRoot(path: string): Promise<string | undefined> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw piError("PI_EXTERNAL_SESSION_ROOT_INVALID", "External Pi history root must be a normalized absolute path", "session");
  }
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw piError(
      "PI_EXTERNAL_SESSION_ROOT_UNAVAILABLE",
      "External Pi history root could not be inspected",
      "session",
      { retryable: true, cause: error }
    );
  });
  if (info === undefined) return undefined;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw piError("PI_EXTERNAL_SESSION_ROOT_UNSAFE", "External Pi history root must be a regular non-symlink directory", "session");
  }
  const canonical = await realpath(path).catch((error) => {
    throw piError("PI_EXTERNAL_SESSION_ROOT_UNSAFE", "External Pi history root cannot be resolved safely", "session", { cause: error });
  });
  if (!samePath(canonical, path)) {
    throw piError("PI_EXTERNAL_SESSION_ROOT_UNSAFE", "External Pi history root must be canonical and unaliased", "session");
  }
  return canonical;
}

function pathsOverlap(left: string, right: string): boolean {
  return pathIsContained(left, right) || pathIsContained(right, left);
}

function pathIsContained(root: string, candidate: string): boolean {
  const suffix = relative(resolve(root), resolve(candidate));
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function externalSessionChanged(): ReturnType<typeof piError> {
  return piError(
    "PI_EXTERNAL_SESSION_CHANGED",
    "The upstream Pi history changed after discovery",
    "session",
    { retryable: true, recovery: "Rescan and select the latest stable history snapshot." }
  );
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32" ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}

async function managedRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw asPiError(error, {
      code: "PI_SESSION_PATH_RESOLUTION_FAILED",
      phase: "session",
      retryable: true,
      recovery: "Restore the managed session path and retry with its canonical location."
    });
  }
}
