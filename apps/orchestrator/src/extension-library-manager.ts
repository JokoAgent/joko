import { createHash, randomUUID, type Hash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import type { ExtensionLibraryDescriptor } from "./extension-surface-manifest.js";
import {
  ExtensionLibrarySqlService,
  type ExtensionLibrarySqlHandle,
  type ExtensionLibrarySqlMigration,
  type ExtensionLibrarySqlResult,
  type ExtensionLibrarySqlValue
} from "./extension-library-sql.js";
import {
  assertExtensionLibraryRootIdentity,
  captureExtensionLibraryRootIdentity,
  copyExtensionLibrary,
  moveOrCopyExtensionLibrary,
  removeExtensionLibraryRoot,
  type ExtensionLibraryRootIdentity,
  type ExtensionLibraryTransferResult
} from "./extension-library-transfer.js";
import {
  EXTENSION_LIBRARY_LIMITS,
  ExtensionLibraryError,
  ExtensionLibraryVault,
  filesystemFreeBytes,
  type ExtensionLibraryEntry,
  type ExtensionLibraryReadResult,
  type ExtensionLibraryStatus,
  type ExtensionLibraryVaultOptions,
  type ExtensionLibraryWriteResult
} from "./extension-library-vault.js";

export interface ExtensionLibraryAuthority {
  readonly extensionId: string;
  readonly extensionRevision: bigint;
  readonly resourceId: string;
  readonly resourceRevision: bigint;
  readonly discoveredRevision: string;
  readonly backendId: string;
  readonly backendRevision: bigint;
  readonly backendGeneration: number;
  readonly name: string;
  readonly library: ExtensionLibraryDescriptor & { readonly extensionEntry: string };
}

export interface ExtensionLibraryManagerOptions {
  readonly rootDirectory: string;
  readonly managedRoots?: readonly string[];
  readonly now?: () => number;
  readonly freeBytes?: (root: string) => Promise<number | undefined>;
  readonly sessionTtlMilliseconds?: number;
  readonly maximumSessions?: number;
  readonly renameDirectory?: (from: string, to: string) => Promise<void>;
  readonly copyLibrary?: typeof copyExtensionLibrary;
}

export interface ExtensionLibrarySessionDescriptor {
  readonly sessionId: string;
  readonly extensionId: string;
  readonly expiresAt: number;
  readonly bindingGeneration: bigint;
  readonly capabilities: {
    readonly schemaVersion: 1;
    readonly maximumReadBytes: number;
    readonly maximumWriteBytes: number;
    readonly maximumStreamBytes: number;
    readonly maximumPathCharacters: number;
    readonly maximumPathSegments: number;
    readonly maximumListPageSize: number;
    readonly maximumFiles: number;
  };
}

export interface ExtensionLibraryAuthorityChangeLease {
  release(options?: {
    readonly orphaned?: readonly { readonly extensionId: string; readonly name: string }[];
  }): Promise<void>;
}

export type ExtensionLibraryLocationKind = "default" | "custom";

export interface ExtensionLibraryOverview {
  readonly extensionId: string;
  readonly name: string;
  readonly state: ExtensionLibraryStatus["state"];
  readonly reason?: ExtensionLibraryStatus["reason"] | "disk_missing" | "binding_moved" | "state_corrupt";
  readonly location?: {
    readonly kind: ExtensionLibraryLocationKind;
    readonly path: string;
    readonly generation: bigint;
  };
  readonly usage: { readonly files: number; readonly bytes: number };
  readonly diskFreeBytes?: number;
  readonly softLimitBytes: number;
  readonly softLimitExceeded: boolean;
  readonly orphaned: boolean;
  readonly trashCount: number;
  readonly graceCount: number;
  readonly operation?: { readonly id: string; readonly phase: StoredMigration["phase"] };
}

export interface ExtensionLibraryLocationValidation {
  readonly libraryRoot: string;
  readonly warnings: readonly string[];
  readonly diskFreeBytes?: number;
}

export interface ExtensionLibraryRelocationResult {
  readonly changed: boolean;
  readonly migrationId?: string;
  readonly location: { readonly kind: ExtensionLibraryLocationKind; readonly path: string; readonly generation: bigint };
  readonly files: number;
  readonly bytes: number;
  readonly warnings: readonly string[];
  readonly graceId?: string;
}

export interface ExtensionLibraryTrashEntry {
  readonly trashId: string;
  readonly extensionId: string;
  readonly name: string;
  readonly deletedAt: number;
  readonly expiresAt: number;
  readonly files: number;
  readonly bytes: number;
}

export interface ExtensionLibraryGraceEntry {
  readonly graceId: string;
  readonly extensionId: string;
  readonly name: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly files: number;
  readonly bytes: number;
}

interface StoredBinding {
  readonly extensionId: string;
  readonly name: string;
  readonly kind: ExtensionLibraryLocationKind;
  readonly root: string;
  readonly generation: string;
  readonly identity: ExtensionLibraryRootIdentity;
  readonly updatedAt: number;
}

interface StoredGeneration {
  readonly extensionId: string;
  readonly generation: string;
}

interface StoredTrash {
  readonly trashId: string;
  readonly extensionId: string;
  readonly name: string;
  readonly deletedAt: number;
  readonly expiresAt: number;
  readonly root: string;
  readonly identity: ExtensionLibraryRootIdentity;
  readonly source: StoredBinding;
  readonly files: number;
  readonly bytes: number;
}

interface StoredGrace {
  readonly graceId: string;
  readonly extensionId: string;
  readonly name: string;
  readonly phase: "ready" | "purging";
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly root: string;
  readonly originalRoot: string;
  readonly identity: ExtensionLibraryRootIdentity;
  readonly source: StoredBinding;
  readonly files: number;
  readonly bytes: number;
}

interface StoredMigration {
  readonly migrationId: string;
  readonly graceId: string;
  readonly extensionId: string;
  readonly name: string;
  readonly phase: "precheck" | "copying" | "verifying" | "switching";
  readonly source: StoredBinding;
  readonly targetKind: ExtensionLibraryLocationKind;
  readonly targetRoot: string;
  readonly stagingRoot: string;
  readonly startedAt: number;
  readonly warnings: readonly string[];
  readonly files: number;
  readonly bytes: number;
}

interface StoredRollback {
  readonly rollbackId: string;
  readonly extensionId: string;
  readonly name: string;
  readonly current: StoredBinding;
  readonly selectedGrace: StoredGrace;
  readonly nextGraceId: string;
  readonly nextGraceRoot: string;
  readonly bindingGeneration: string;
  readonly startedAt: number;
  readonly files: number;
  readonly bytes: number;
}

interface StoredManagerState {
  readonly format: 1;
  readonly revision: string;
  readonly generations: readonly StoredGeneration[];
  readonly bindings: readonly StoredBinding[];
  readonly trash: readonly StoredTrash[];
  readonly grace: readonly StoredGrace[];
  readonly migrations: readonly StoredMigration[];
  readonly rollbacks: readonly StoredRollback[];
}

interface MovingTrashManifest {
  readonly format: 1;
  readonly phase: "moving";
  readonly trashId: string;
  readonly source: StoredBinding;
  readonly targetRoot: string;
  readonly deletedAt: number;
  readonly expiresAt: number;
  readonly files: number;
  readonly bytes: number;
}

interface ReadyTrashManifest {
  readonly format: 1;
  readonly phase: "ready";
  readonly record: StoredTrash;
}

interface RestoringTrashManifest {
  readonly format: 1;
  readonly phase: "restoring";
  readonly record: StoredTrash;
  readonly destinationKind: ExtensionLibraryLocationKind;
  readonly targetRoot: string;
  readonly stagingRoot: string;
  readonly bindingGeneration: string;
  readonly updatedAt: number;
}

interface PurgingTrashManifest {
  readonly format: 1;
  readonly phase: "purging";
  readonly record: StoredTrash;
}

type TrashManifest = MovingTrashManifest | ReadyTrashManifest | RestoringTrashManifest | PurgingTrashManifest;

interface ActiveSession {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly authority: ExtensionLibraryAuthority;
  readonly authorityKey: string;
  readonly binding: StoredBinding;
  readonly assertAuthorityCurrent: () => void | Promise<void>;
  readonly authorityState: SharedArrayBuffer;
  readonly vault: ExtensionLibraryVault;
  readonly sql: ExtensionLibrarySqlService;
  readonly expiresAt: number;
}

interface ActiveStream {
  readonly streamId: string;
  readonly sessionId: string;
  readonly path: string;
  readonly temporaryPath: string;
  readonly totalBytes: number;
  readonly expectedSha256?: string;
  readonly ifNotExists: boolean;
  readonly hash: Hash;
  handle?: FileHandle;
  receivedBytes: number;
  nextSequence: number;
  expiresAt: number;
}

const EXTENSION_ID = /^extension_[a-f0-9]{32}$/u;
const SESSION_ID = /^library_session_[a-f0-9]{32}$/u;
const STREAM_ID = /^library_stream_[a-f0-9]{32}$/u;
const TRASH_ID = /^library_trash_[a-f0-9]{32}$/u;
const GRACE_ID = /^library_grace_[a-f0-9]{32}$/u;
const MIGRATION_ID = /^library_migration_[a-f0-9]{32}$/u;
const ROLLBACK_ID = /^library_rollback_[a-f0-9]{32}$/u;
const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const REVISION = /^(?:0|[1-9][0-9]*)$/u;
const HASH = /^[a-f0-9]{64}$/u;
const DEFAULT_SESSION_TTL = 10 * 60_000;
const DEFAULT_MAXIMUM_SESSIONS = 32;
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60_000;
const GRACE_RETENTION_MS = 14 * 24 * 60 * 60_000;
const LOCATION_MINIMUM_FREE_BYTES = 256 * 1024 * 1024;
const CLOUD_MARKERS = ["mobile documents", "dropbox", "onedrive", "icloud", "google drive", "googledrive"];
const CONTROL_FILE = "library-state.json";
const PREVIOUS_CONTROL_FILE = "library-state.previous.json";
const TRASH_MANIFEST_FILE = "trash.json";
const MANAGER_RECORD_MAXIMUM_BYTES = 64 * 1024 * 1024;

export class ExtensionLibraryManager {
  readonly #rootDirectory: string;
  readonly #dataDirectory: string;
  readonly #trashDirectory: string;
  readonly #managedRoots: readonly string[];
  readonly #now: () => number;
  readonly #freeBytes: (root: string) => Promise<number | undefined>;
  readonly #sessionTtlMilliseconds: number;
  readonly #maximumSessions: number;
  readonly #renameDirectory: (from: string, to: string) => Promise<void>;
  readonly #copyLibrary: typeof copyExtensionLibrary;
  readonly #sessions = new Map<string, ActiveSession>();
  readonly #streams = new Map<string, ActiveStream>();
  #state: StoredManagerState = emptyState();
  #stateUnavailable = false;
  #initialized = false;
  #closed = false;
  #tail: Promise<void> = Promise.resolve();
  readonly #activeRelocations = new Set<Promise<ExtensionLibraryRelocationResult>>();
  #expirationTimer?: NodeJS.Timeout;

  constructor(options: ExtensionLibraryManagerOptions) {
    if (!isAbsolute(options.rootDirectory) || resolve(options.rootDirectory) !== options.rootDirectory) {
      throw new TypeError("Extension Library manager root must be a normalized absolute path.");
    }
    this.#rootDirectory = options.rootDirectory;
    this.#dataDirectory = join(options.rootDirectory, "data");
    this.#trashDirectory = join(options.rootDirectory, "trash");
    this.#managedRoots = Object.freeze([options.rootDirectory, ...(options.managedRoots ?? [])].map((root) => resolve(root)));
    this.#now = options.now ?? Date.now;
    this.#freeBytes = options.freeBytes ?? filesystemFreeBytes;
    this.#sessionTtlMilliseconds = positiveInteger(options.sessionTtlMilliseconds ?? DEFAULT_SESSION_TTL, "Library session TTL");
    this.#maximumSessions = positiveInteger(options.maximumSessions ?? DEFAULT_MAXIMUM_SESSIONS, "Library session limit");
    this.#renameDirectory = options.renameDirectory ?? rename;
    this.#copyLibrary = options.copyLibrary ?? copyExtensionLibrary;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 });
    await assertCanonicalDirectory(this.#rootDirectory);
    await Promise.all([
      mkdir(this.#dataDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.#trashDirectory, { recursive: true, mode: 0o700 })
    ]);
    try {
      this.#state = validateState(JSON.parse((await readManagerRecord(this.#controlPath())).toString("utf8")));
    } catch (error) {
      if (missing(error) && await this.#isFreshRoot()) {
        this.#state = emptyState();
        await this.#persistState();
      } else {
        this.#stateUnavailable = true;
      }
    }
    if (!this.#stateUnavailable) {
      try {
        this.#assertStateTopology();
        await this.#recoverTrashManifests();
        await this.#recoverMigrations();
        await this.#recoverRollbacks();
        await this.#recoverGracePurges();
        await this.#recoverDefaultBindings();
      } catch {
        this.#stateUnavailable = true;
      }
    }
    this.#expirationTimer = setInterval(() => { void this.#expire(); }, Math.min(this.#sessionTtlMilliseconds, 30_000));
    this.#expirationTimer.unref?.();
    this.#initialized = true;
  }

  async repairState(): Promise<{ readonly recoveredFromPrevious: boolean; readonly bindings: number; readonly trash: number }> {
    this.#assertInitialized();
    return this.#mutate(async () => {
      if (!this.#stateUnavailable) throw new ExtensionLibraryError("CONFLICT", "Extension Library state is not awaiting repair.");
      await this.#preserveUnavailableControl();
      let recoveredFromPrevious = true;
      try {
        this.#state = validateState(JSON.parse((await readManagerRecord(this.#previousControlPath())).toString("utf8")));
      } catch {
        recoveredFromPrevious = false;
        this.#state = await this.#reconstructState();
      }
      this.#stateUnavailable = false;
      try {
        this.#assertStateTopology();
        await this.#recoverTrashManifests();
        await this.#recoverMigrations();
        await this.#recoverRollbacks();
        await this.#recoverGracePurges();
        await this.#recoverDefaultBindings();
        await this.#persistState();
      } catch (error) {
        this.#stateUnavailable = true;
        throw error;
      }
      return {
        recoveredFromPrevious,
        bindings: this.#state.bindings.length,
        trash: this.#state.trash.length
      };
    });
  }

  async overview(input: {
    readonly authority: ExtensionLibraryAuthority;
    readonly assertAuthorityCurrent: () => void | Promise<void>;
  }): Promise<ExtensionLibraryOverview> {
    this.#assertReady();
    validateAuthority(input.authority);
    return this.#mutate(async () => {
      await input.assertAuthorityCurrent();
      if (this.#stateUnavailable) return unavailableOverview(input.authority, this.#state, "state_corrupt");
      const binding = this.#binding(input.authority.extensionId);
      if (binding === undefined) {
        return {
          extensionId: input.authority.extensionId,
          name: input.authority.name,
          state: "ready",
          usage: { files: 0, bytes: 0 },
          softLimitBytes: EXTENSION_LIBRARY_LIMITS.softLimitBytes,
          softLimitExceeded: false,
          orphaned: false,
          trashCount: this.#state.trash.filter((entry) => entry.extensionId === input.authority.extensionId).length,
          graceCount: this.#state.grace.filter((entry) => entry.extensionId === input.authority.extensionId).length
        };
      }
      const resolution = await this.#resolveBinding(binding);
      if (!resolution.ok) return unavailableOverview(input.authority, this.#state, resolution.reason, binding);
      const vault = this.#createVault(binding.root, binding.extensionId);
      if (this.#hasOperation(binding.extensionId)) vault.setReadonly(true);
      const status = await vault.open();
      return overviewFromStatus(input.authority, binding, status, this.#state);
    });
  }

  async openSession(input: {
    readonly authority: ExtensionLibraryAuthority;
    readonly connectionId: string;
    readonly assertAuthorityCurrent: () => void | Promise<void>;
  }): Promise<ExtensionLibrarySessionDescriptor> {
    this.#assertReady();
    validateAuthority(input.authority);
    if (!CONNECTION_ID.test(input.connectionId)) throw new ExtensionLibraryError("PATH_INVALID", "Library connection identity is invalid.");
    return this.#mutate(async () => {
      this.#assertStateAvailable();
      await this.#expireInternal();
      if (this.#sessions.size >= this.#maximumSessions) throw new ExtensionLibraryError("TOO_LARGE", "Extension Library session limit reached.");
      await input.assertAuthorityCurrent();
      const binding = await this.#ensureBinding(input.authority);
      const resolution = await this.#resolveBinding(binding);
      if (!resolution.ok) throw unavailableBinding(resolution.reason);
      const authorityState = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const assertMutationAuthority = async (): Promise<void> => {
        if (Atomics.load(new Int32Array(authorityState), 0) !== 0) {
          throw new ExtensionLibraryError("UNAVAILABLE", "Extension Library session authority was revoked.");
        }
        try {
          await input.assertAuthorityCurrent();
        } catch (error) {
          Atomics.store(new Int32Array(authorityState), 0, 1);
          throw new ExtensionLibraryError("UNAVAILABLE", "Extension Library session authority was revoked.", { cause: error });
        }
        if (Atomics.load(new Int32Array(authorityState), 0) !== 0) {
          throw new ExtensionLibraryError("UNAVAILABLE", "Extension Library session authority was revoked.");
        }
      };
      const vault = this.#createVault(binding.root, binding.extensionId, assertMutationAuthority);
      const status = await vault.open();
      if (status.state === "unavailable") throw new ExtensionLibraryError("CORRUPT", "Extension Library metadata is unavailable.");
      const migrating = this.#hasOperation(input.authority.extensionId);
      if (migrating) vault.setReadonly(true);
      else await vault.clearOrphaned();
      const sessionId = `library_session_${randomUUID().replaceAll("-", "")}`;
      const expiresAt = this.#now() + this.#sessionTtlMilliseconds;
      this.#sessions.set(sessionId, {
        sessionId,
        connectionId: input.connectionId,
        authority: copyAuthority(input.authority),
        authorityKey: authorityKey(input.authority),
        binding,
        assertAuthorityCurrent: input.assertAuthorityCurrent,
        authorityState,
        vault,
        sql: new ExtensionLibrarySqlService(vault, { authorityState }),
        expiresAt
      });
      return {
        sessionId,
        extensionId: input.authority.extensionId,
        expiresAt,
        bindingGeneration: BigInt(binding.generation),
        capabilities: {
          schemaVersion: 1,
          maximumReadBytes: EXTENSION_LIBRARY_LIMITS.maximumReadBytes,
          maximumWriteBytes: EXTENSION_LIBRARY_LIMITS.maximumWriteBytes,
          maximumStreamBytes: EXTENSION_LIBRARY_LIMITS.maximumStreamBytes,
          maximumPathCharacters: EXTENSION_LIBRARY_LIMITS.maximumPathCharacters,
          maximumPathSegments: EXTENSION_LIBRARY_LIMITS.maximumPathSegments,
          maximumListPageSize: EXTENSION_LIBRARY_LIMITS.maximumListPageSize,
          maximumFiles: EXTENSION_LIBRARY_LIMITS.maximumFiles
        }
      };
    });
  }

  async closeSession(sessionId: string, connectionId: string): Promise<boolean> {
    this.#assertReady();
    const active = this.#sessions.get(sessionId);
    if (active?.connectionId === connectionId) this.#signalSessionRevoked(active);
    return this.#mutate(async () => {
      const session = this.#sessions.get(sessionId);
      if (session === undefined || session.connectionId !== connectionId) return false;
      await this.#destroySession(session);
      return true;
    });
  }

  async closeConnection(connectionId: string): Promise<void> {
    this.#assertReady();
    for (const session of this.#sessions.values()) {
      if (session.connectionId === connectionId) this.#signalSessionRevoked(session);
    }
    await this.#mutate(async () => {
      for (const session of [...this.#sessions.values()]) {
        if (session.connectionId === connectionId) await this.#destroySession(session);
      }
    });
  }

  signalAuthorityChanges(extensionIds: readonly string[]): void {
    this.#assertReady();
    if (!Array.isArray(extensionIds) || extensionIds.some((extensionId) => !EXTENSION_ID.test(extensionId))) {
      throw new ExtensionLibraryError("PATH_INVALID", "Extension Library authority change identities are invalid.");
    }
    const unique = [...new Set(extensionIds)];
    for (const extensionId of unique) this.#signalExtensionRevoked(extensionId);
    void this.#mutate(async () => {
      for (const extensionId of unique) await this.#revokeSessionsInternal(extensionId);
    }).catch(() => undefined);
  }

  async revokeExtension(extensionId: string, orphanedName?: string): Promise<void> {
    this.#assertReady();
    if (!EXTENSION_ID.test(extensionId)) throw new ExtensionLibraryError("PATH_INVALID", "Extension Library identity is invalid.");
    this.#signalExtensionRevoked(extensionId);
    await this.#mutate(async () => {
      await this.#revokeSessionsInternal(extensionId);
      await this.#markOrphanedInternal(extensionId, orphanedName);
    });
  }

  async acquireAuthorityChange(extensionId: string): Promise<ExtensionLibraryAuthorityChangeLease> {
    return this.acquireAuthorityChanges([extensionId]);
  }

  async acquireAuthorityChanges(extensionIds: readonly string[]): Promise<ExtensionLibraryAuthorityChangeLease> {
    this.#assertReady();
    if (!Array.isArray(extensionIds) || extensionIds.length === 0 || extensionIds.length > 10_000
      || extensionIds.some((extensionId) => !EXTENSION_ID.test(extensionId))
      || new Set(extensionIds).size !== extensionIds.length) {
      throw new ExtensionLibraryError("PATH_INVALID", "Extension Library authority change identities are invalid.");
    }
    const ownedExtensionIds = new Set(extensionIds);
    for (const extensionId of extensionIds) this.#signalExtensionRevoked(extensionId);
    let acquiredResolve!: () => void;
    let acquiredReject!: (error: unknown) => void;
    let releaseResolve!: () => void;
    let releaseOptions: { readonly orphaned?: readonly { readonly extensionId: string; readonly name: string }[] } | undefined;
    const acquired = new Promise<void>((resolve, reject) => {
      acquiredResolve = resolve;
      acquiredReject = reject;
    });
    const released = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const held = this.#mutate(async () => {
      try {
        for (const extensionId of extensionIds) await this.#revokeSessionsInternal(extensionId);
        acquiredResolve();
        await released;
        const orphaned = releaseOptions?.orphaned ?? [];
        if (orphaned.length > extensionIds.length || orphaned.some((entry) => !ownedExtensionIds.has(entry.extensionId))) {
          throw new ExtensionLibraryError("PATH_INVALID", "Extension Library orphan identities are invalid.");
        }
        for (const entry of orphaned) await this.#markOrphanedInternal(entry.extensionId, entry.name);
      } catch (error) {
        acquiredReject(error);
        throw error;
      }
    });
    void held.catch(() => undefined);
    await acquired;
    let releasePromise: Promise<void> | undefined;
    return {
      release: (options = {}) => {
        if (releasePromise !== undefined) return releasePromise;
        releaseOptions = options;
        releaseResolve();
        releasePromise = held;
        return releasePromise;
      }
    };
  }

  async read(sessionId: string, connectionId: string, input: { readonly path: string; readonly offset?: number; readonly length?: number }): Promise<ExtensionLibraryReadResult> {
    return this.#withSession(sessionId, connectionId, false, (session) => session.vault.read(input));
  }

  async write(sessionId: string, connectionId: string, input: { readonly path: string; readonly bytes: Uint8Array; readonly ifNotExists?: boolean }): Promise<ExtensionLibraryWriteResult> {
    return this.#withSession(sessionId, connectionId, true, (session) => session.vault.write(input));
  }

  async stat(sessionId: string, connectionId: string, path: string): Promise<ExtensionLibraryEntry> {
    return this.#withSession(sessionId, connectionId, false, (session) => session.vault.stat(path));
  }

  async list(sessionId: string, connectionId: string, input: { readonly path?: string; readonly recursive?: boolean; readonly limit?: number; readonly cursor?: string }): Promise<{ readonly entries: readonly ExtensionLibraryEntry[]; readonly nextCursor?: string }> {
    return this.#withSession(sessionId, connectionId, false, (session) => session.vault.list(input));
  }

  async mkdir(sessionId: string, connectionId: string, path: string): Promise<{ readonly path: string; readonly existed: boolean }> {
    return this.#withSession(sessionId, connectionId, true, (session) => session.vault.mkdir(path));
  }

  async delete(sessionId: string, connectionId: string, path: string, recursive = false): Promise<{ readonly path: string; readonly existed: boolean }> {
    return this.#withSession(sessionId, connectionId, true, (session) => session.vault.delete(path, recursive));
  }

  async rename(sessionId: string, connectionId: string, input: { readonly from: string; readonly to: string; readonly overwrite?: boolean }): Promise<{ readonly from: string; readonly to: string }> {
    return this.#withSession(sessionId, connectionId, true, (session) => session.vault.rename(input));
  }

  async writeBegin(sessionId: string, connectionId: string, input: {
    readonly path: string;
    readonly totalBytes: number;
    readonly sha256?: string;
    readonly ifNotExists?: boolean;
  }): Promise<{ readonly streamId: string; readonly nextSequence: number; readonly expiresAt: number }> {
    return this.#withSession(sessionId, connectionId, true, async (session) => {
      if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 0 || input.totalBytes > session.vault.limits.maximumStreamBytes
        || input.sha256 !== undefined && !HASH.test(input.sha256)) {
        throw new ExtensionLibraryError("TOO_LARGE", "Library stream declaration is outside the supported boundary.");
      }
      if (this.#streams.size >= this.#maximumSessions * 4) {
        throw new ExtensionLibraryError("TOO_LARGE", "Extension Library stream limit reached.");
      }
      await session.vault.assertWritable(Math.min(input.totalBytes, session.vault.limits.maximumWriteBytes));
      const temporaryPath = await session.vault.allocateTemporaryPath(".stream");
      const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      const streamId = `library_stream_${randomUUID().replaceAll("-", "")}`;
      const expiresAt = this.#now() + session.vault.limits.streamIdleMilliseconds;
      this.#streams.set(streamId, {
        streamId,
        sessionId,
        path: input.path,
        temporaryPath,
        totalBytes: input.totalBytes,
        ...(input.sha256 === undefined ? {} : { expectedSha256: input.sha256 }),
        ifNotExists: input.ifNotExists === true,
        hash: createHash("sha256"),
        handle,
        receivedBytes: 0,
        nextSequence: 0,
        expiresAt
      });
      return { streamId, nextSequence: 0, expiresAt };
    });
  }

  async writeChunk(sessionId: string, connectionId: string, input: {
    readonly streamId: string;
    readonly sequence: number;
    readonly bytes: Uint8Array;
  }): Promise<{ readonly receivedBytes: number; readonly nextSequence: number; readonly expiresAt: number }> {
    return this.#withSession(sessionId, connectionId, true, async (session) => {
      const stream = this.#stream(sessionId, input.streamId);
      if (!Number.isSafeInteger(input.sequence) || input.sequence !== stream.nextSequence
        || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0 || input.bytes.byteLength > session.vault.limits.maximumWriteBytes
        || stream.receivedBytes + input.bytes.byteLength > stream.totalBytes) {
        throw new ExtensionLibraryError("CONFLICT", "Library stream chunk sequence or length is invalid.");
      }
      await session.vault.assertWritable(input.bytes.byteLength);
      const bytes = Buffer.from(input.bytes);
      const result = await stream.handle!.write(bytes, 0, bytes.byteLength, stream.receivedBytes);
      if (result.bytesWritten !== bytes.byteLength) throw new ExtensionLibraryError("DISK_FULL", "Library stream write was incomplete.");
      stream.hash.update(bytes);
      stream.receivedBytes += bytes.byteLength;
      stream.nextSequence += 1;
      stream.expiresAt = this.#now() + session.vault.limits.streamIdleMilliseconds;
      return { receivedBytes: stream.receivedBytes, nextSequence: stream.nextSequence, expiresAt: stream.expiresAt };
    });
  }

  async writeCommit(sessionId: string, connectionId: string, streamId: string): Promise<ExtensionLibraryWriteResult> {
    return this.#withSession(sessionId, connectionId, true, async (session) => {
      const stream = this.#stream(sessionId, streamId);
      if (stream.receivedBytes !== stream.totalBytes) throw new ExtensionLibraryError("CONFLICT", "Library stream is incomplete.");
      await stream.handle!.sync();
      await stream.handle!.close();
      stream.handle = undefined;
      const digest = stream.hash.digest("hex");
      if (stream.expectedSha256 !== undefined && digest !== stream.expectedSha256) {
        await this.#discardStream(session, stream);
        throw new ExtensionLibraryError("CORRUPT", "Library stream hash did not match its declaration.");
      }
      try {
        const result = await session.vault.commitStagedWrite({
          temporaryPath: stream.temporaryPath,
          path: stream.path,
          bytes: stream.receivedBytes,
          sha256: digest,
          ifNotExists: stream.ifNotExists
        });
        this.#streams.delete(stream.streamId);
        return result;
      } catch (error) {
        await this.#discardStream(session, stream);
        throw error;
      }
    });
  }

  async writeAbort(sessionId: string, connectionId: string, streamId: string): Promise<boolean> {
    return this.#withSession(sessionId, connectionId, false, async (session) => {
      const stream = this.#streams.get(streamId);
      if (stream === undefined || stream.sessionId !== sessionId) return false;
      await this.#discardStream(session, stream);
      return true;
    });
  }

  async databaseOpen(sessionId: string, connectionId: string, input: { readonly path: string; readonly create?: boolean; readonly readonly?: boolean }): Promise<ExtensionLibrarySqlHandle> {
    return this.#withSession(sessionId, connectionId, input.readonly !== true, (session) => session.sql.open(input));
  }

  async databaseExecute(sessionId: string, connectionId: string, handleId: string, sql: string, parameters: readonly ExtensionLibrarySqlValue[] = []): Promise<ExtensionLibrarySqlResult> {
    return this.#withSession(sessionId, connectionId, false, (session) => session.sql.execute(handleId, sql, parameters));
  }

  async databaseBatch(sessionId: string, connectionId: string, handleId: string, statements: readonly { readonly sql: string; readonly parameters?: readonly ExtensionLibrarySqlValue[] }[]): Promise<readonly ExtensionLibrarySqlResult[]> {
    return this.#withSession(sessionId, connectionId, false, (session) => session.sql.batch(handleId, statements));
  }

  async databaseMigrate(sessionId: string, connectionId: string, handleId: string, migrations: readonly ExtensionLibrarySqlMigration[]): Promise<number> {
    return this.#withSession(sessionId, connectionId, true, (session) => session.sql.migrate(handleId, migrations));
  }

  async databaseBackup(sessionId: string, connectionId: string, handleId: string, targetPath: string): Promise<{ readonly path: string; readonly userVersion: number }> {
    return this.#withSession(sessionId, connectionId, true, (session) => session.sql.backup(handleId, targetPath));
  }

  async databaseCheck(sessionId: string, connectionId: string, handleId: string): Promise<{ readonly ok: true }> {
    return this.#withSession(sessionId, connectionId, false, (session) => session.sql.check(handleId));
  }

  async databaseClose(sessionId: string, connectionId: string, handleId: string): Promise<void> {
    await this.#withSession(sessionId, connectionId, false, (session) => session.sql.close(handleId));
  }

  async validateLocation(input: {
    readonly authority: ExtensionLibraryAuthority;
    readonly candidate: string;
    readonly assertAuthorityCurrent: () => void | Promise<void>;
  }): Promise<ExtensionLibraryLocationValidation> {
    this.#assertReady();
    validateAuthority(input.authority);
    return this.#mutate(async () => {
      this.#assertStateAvailable();
      await input.assertAuthorityCurrent();
      return this.#validateCandidate(input.candidate, input.authority.extensionId, false);
    });
  }

  relocate(input: {
    readonly authority: ExtensionLibraryAuthority;
    readonly destination: { readonly kind: "default" } | { readonly kind: "custom"; readonly candidate: string };
    readonly assertAuthorityCurrent: () => void | Promise<void>;
  }): Promise<ExtensionLibraryRelocationResult> {
    this.#assertReady();
    validateAuthority(input.authority);
    const tracked = this.#relocate(input).finally(() => this.#activeRelocations.delete(tracked));
    this.#activeRelocations.add(tracked);
    return tracked;
  }

  async #relocate(input: {
    readonly authority: ExtensionLibraryAuthority;
    readonly destination: { readonly kind: "default" } | { readonly kind: "custom"; readonly candidate: string };
    readonly assertAuthorityCurrent: () => void | Promise<void>;
  }): Promise<ExtensionLibraryRelocationResult> {
    const prepared = await this.#mutate(async () => {
      this.#assertStateAvailable();
      await input.assertAuthorityCurrent();
      this.#assertNoOperation(input.authority.extensionId);
      const source = await this.#ensureBinding(input.authority);
      const sourceResolution = await this.#resolveBinding(source);
      if (!sourceResolution.ok) throw unavailableBinding(sourceResolution.reason);
      const validation = input.destination.kind === "default"
        ? await this.#validateCandidate(this.#dataDirectory, input.authority.extensionId, true)
        : await this.#validateCandidate(input.destination.candidate, input.authority.extensionId, false);
      const targetKind = input.destination.kind;
      const targetRoot = validation.libraryRoot;
      if (targetRoot === source.root) {
        const currentVault = this.#createVault(source.root, source.extensionId);
        await currentVault.open({ create: false });
        const current = await currentVault.snapshot();
        return {
          kind: "complete" as const,
          result: {
            changed: false,
            location: { kind: source.kind, path: source.root, generation: BigInt(source.generation) },
            files: current.files,
            bytes: current.bytes,
            warnings: validation.warnings
          }
        };
      }
      if (await exists(targetRoot)) throw new ExtensionLibraryError("ALREADY_EXISTS", "Extension Library destination already exists.");
      const sourceVault = this.#createVault(source.root, source.extensionId);
      const sourceStatus = await sourceVault.open({ create: false });
      if (sourceStatus.state === "unavailable") throw new ExtensionLibraryError("CORRUPT", "Extension Library source metadata is unavailable.");
      this.#setExtensionSessionsReadonly(source.extensionId, true);
      sourceVault.setReadonly(true);
      try {
        const snapshot = await sourceVault.snapshot();
        const free = await this.#freeBytes(dirname(targetRoot)).catch(() => undefined);
        const required = Math.ceil(snapshot.bytes * 1.2) + LOCATION_MINIMUM_FREE_BYTES;
        if (free !== undefined && free < required) throw new ExtensionLibraryError("DISK_FULL", "Extension Library destination lacks migration headroom.");
        const migrationId = `library_migration_${randomUUID().replaceAll("-", "")}`;
        const graceId = `library_grace_${randomUUID().replaceAll("-", "")}`;
        const stagingRoot = join(dirname(targetRoot), `.joko-library-migrate-${source.extensionId}-${migrationId.slice(-32)}`);
        if (await exists(stagingRoot)) throw new ExtensionLibraryError("ALREADY_EXISTS", "Extension Library migration staging target already exists.");
        let migration: StoredMigration = {
          migrationId,
          graceId,
          extensionId: source.extensionId,
          name: boundedName(input.authority.name),
          phase: "precheck",
          source,
          targetKind,
          targetRoot,
          stagingRoot,
          startedAt: this.#now(),
          warnings: validation.warnings,
          files: snapshot.files,
          bytes: snapshot.bytes
        };
        this.#state = reviseState(this.#state, { migrations: [...this.#state.migrations, migration] });
        await this.#persistState();
        migration = await this.#advanceMigration(migration, "copying");
        return { kind: "prepared" as const, migration, sourceVault, snapshot, validation };
      } catch (error) {
        this.#setExtensionSessionsReadonly(source.extensionId, false);
        throw error;
      }
    });
    if (prepared.kind === "complete") return prepared.result;

    let migration = prepared.migration;
    try {
      const transferred = await this.#copyLibrary({
        source: prepared.sourceVault,
        targetRoot: migration.stagingRoot,
        extensionId: migration.extensionId,
        now: this.#now,
        freeBytes: this.#freeBytes
      });
      if (transferred.result.files !== prepared.snapshot.files) {
        throw new ExtensionLibraryError("CORRUPT", "Extension Library migration file count changed.");
      }
      migration = await this.#mutate(async () => {
        await input.assertAuthorityCurrent();
        this.#assertMigrationCurrent(migration, "copying");
        return this.#advanceMigration(migration, "verifying");
      });
      await transferred.vault.snapshot();
      return await this.#mutate(async () => {
        await input.assertAuthorityCurrent();
        this.#assertMigrationCurrent(migration, "verifying");
        const currentBinding = this.#binding(migration.extensionId);
        if (currentBinding === undefined || !sameBinding(currentBinding, migration.source)) {
          throw new ExtensionLibraryError("CONFLICT", "Extension Library binding changed during migration.");
        }
        migration = await this.#advanceMigration(migration, "switching");
        await this.#revokeSessionsInternal(migration.extensionId);
        const stableSourceSnapshot = await prepared.sourceVault.snapshot();
        migration = { ...migration, files: stableSourceSnapshot.files, bytes: stableSourceSnapshot.bytes };
        this.#state = reviseState(this.#state, {
          migrations: this.#state.migrations.map((entry) => entry.migrationId === migration.migrationId ? migration : entry)
        });
        await this.#persistState();
        await this.#renameDirectory(migration.stagingRoot, migration.targetRoot);
        const targetIdentity = await captureExtensionLibraryRootIdentity(migration.targetRoot);
        const targetVault = this.#createVault(migration.targetRoot, migration.extensionId);
        const targetStatus = await targetVault.open({ create: false });
        if (targetStatus.state === "unavailable") throw new ExtensionLibraryError("CORRUPT", "Extension Library migration target became unavailable.");
        const targetSnapshot = await targetVault.snapshot();
        const desiredGraceRoot = graceRootFor(migration, migration.graceId);
        let actualGraceRoot = migration.source.root;
        let graceIdentity = migration.source.identity;
        try {
          await this.#renameDirectory(migration.source.root, desiredGraceRoot);
          actualGraceRoot = desiredGraceRoot;
          graceIdentity = await captureExtensionLibraryRootIdentity(desiredGraceRoot);
        } catch {
          await assertExtensionLibraryRootIdentity(migration.source.root, migration.source.identity);
        }
        const nextBinding: StoredBinding = {
          extensionId: migration.extensionId,
          name: boundedName(input.authority.name),
          kind: migration.targetKind,
          root: migration.targetRoot,
          generation: this.#nextGeneration(migration.extensionId),
          identity: targetIdentity,
          updatedAt: this.#now()
        };
        const graceCreatedAt = this.#now();
        const grace: StoredGrace = {
          graceId: migration.graceId,
          extensionId: migration.extensionId,
          name: migration.source.name,
          phase: "ready",
          createdAt: graceCreatedAt,
          expiresAt: graceCreatedAt + GRACE_RETENTION_MS,
          root: actualGraceRoot,
          originalRoot: migration.source.root,
          identity: graceIdentity,
          source: migration.source,
          files: stableSourceSnapshot.files,
          bytes: stableSourceSnapshot.bytes
        };
        this.#state = reviseState(this.#state, {
          generations: replaceGeneration(this.#state.generations, nextBinding.extensionId, nextBinding.generation),
          bindings: replaceBinding(this.#state.bindings, nextBinding),
          grace: [...this.#state.grace, grace],
          migrations: this.#state.migrations.filter((entry) => entry.migrationId !== migration.migrationId)
        });
        await this.#persistState();
        return {
          changed: true,
          migrationId: migration.migrationId,
          location: { kind: nextBinding.kind, path: nextBinding.root, generation: BigInt(nextBinding.generation) },
          files: targetSnapshot.files,
          bytes: targetSnapshot.bytes,
          warnings: prepared.validation.warnings,
          graceId: migration.graceId
        };
      });
    } catch (error) {
      const recoverable = await this.#mutate(async () => {
        const current = this.#state.migrations.find((entry) => entry.migrationId === migration.migrationId);
        return current !== undefined && current.phase !== "switching" ? current : undefined;
      });
      if (recoverable !== undefined) {
        try {
          await this.#removeStaging(recoverable);
        } catch (cleanupError) {
          throw new ExtensionLibraryError(
            "UNAVAILABLE",
            "Extension Library retained an uncommitted migration target because cleanup could not be verified.",
            { cause: cleanupError }
          );
        }
        await this.#mutate(async () => {
          const current = this.#state.migrations.find((entry) => entry.migrationId === recoverable.migrationId);
          if (current !== undefined && current.phase !== "switching") {
            const previousState = this.#state;
            this.#state = reviseState(this.#state, {
              migrations: this.#state.migrations.filter((entry) => entry.migrationId !== recoverable.migrationId)
            });
            try {
              await this.#persistState();
            } catch (persistError) {
              this.#state = previousState;
              this.#stateUnavailable = true;
              throw persistError;
            }
            this.#setExtensionSessionsReadonly(recoverable.extensionId, false);
          }
        });
      }
      throw error;
    }
  }

  async rebind(input: {
    readonly authority: ExtensionLibraryAuthority;
    readonly candidate: string;
    readonly assertAuthorityCurrent: () => void | Promise<void>;
  }): Promise<{ readonly location: { readonly kind: "custom"; readonly path: string; readonly generation: bigint }; readonly warnings: readonly string[] }> {
    this.#assertReady();
    validateAuthority(input.authority);
    return this.#mutate(async () => {
      this.#assertStateAvailable();
      await input.assertAuthorityCurrent();
      this.#assertNoOperation(input.authority.extensionId);
      const validation = await this.#validateCandidate(input.candidate, input.authority.extensionId, false);
      if (!(await exists(validation.libraryRoot))) throw new ExtensionLibraryError("NOT_FOUND", "Extension Library recovery location does not contain a Library.");
      const vault = this.#createVault(validation.libraryRoot, input.authority.extensionId);
      const status = await vault.open({ create: false });
      if (status.state === "unavailable") throw new ExtensionLibraryError("CORRUPT", "Extension Library recovery metadata is invalid.");
      await this.#revokeSessionsInternal(input.authority.extensionId);
      const binding: StoredBinding = {
        extensionId: input.authority.extensionId,
        name: boundedName(input.authority.name),
        kind: "custom",
        root: validation.libraryRoot,
        generation: this.#nextGeneration(input.authority.extensionId),
        identity: await captureExtensionLibraryRootIdentity(validation.libraryRoot),
        updatedAt: this.#now()
      };
      this.#state = reviseState(this.#state, {
        generations: replaceGeneration(this.#state.generations, binding.extensionId, binding.generation),
        bindings: replaceBinding(this.#state.bindings, binding)
      });
      await this.#persistState();
      await vault.clearOrphaned();
      return { location: { kind: "custom", path: binding.root, generation: BigInt(binding.generation) }, warnings: validation.warnings };
    });
  }

  async unbind(input: {
    readonly authority: ExtensionLibraryAuthority;
    readonly assertAuthorityCurrent: () => void | Promise<void>;
  }): Promise<{ readonly detachedPath: string }> {
    this.#assertReady();
    validateAuthority(input.authority);
    return this.#mutate(async () => {
      this.#assertStateAvailable();
      await input.assertAuthorityCurrent();
      this.#assertNoOperation(input.authority.extensionId);
      const previous = this.#binding(input.authority.extensionId);
      if (previous === undefined) throw new ExtensionLibraryError("CONFLICT", "Extension Library does not have an active binding.");
      await this.#revokeSessionsInternal(input.authority.extensionId);
      const generation = this.#nextGeneration(input.authority.extensionId);
      this.#state = reviseState(this.#state, {
        generations: replaceGeneration(this.#state.generations, input.authority.extensionId, generation),
        bindings: this.#state.bindings.filter((binding) => binding.extensionId !== input.authority.extensionId)
      });
      await this.#persistState();
      return { detachedPath: previous.root };
    });
  }

  async repairMetadata(input: {
    readonly authority: ExtensionLibraryAuthority;
    readonly assertAuthorityCurrent: () => void | Promise<void>;
  }): Promise<ExtensionLibraryOverview> {
    this.#assertReady();
    validateAuthority(input.authority);
    return this.#mutate(async () => {
      this.#assertStateAvailable();
      await input.assertAuthorityCurrent();
      this.#assertNoOperation(input.authority.extensionId);
      const binding = await this.#ensureBinding(input.authority);
      const resolution = await this.#resolveBinding(binding);
      if (!resolution.ok) throw unavailableBinding(resolution.reason);
      await this.#revokeSessionsInternal(input.authority.extensionId);
      const vault = this.#createVault(binding.root, binding.extensionId);
      await vault.open({ create: false });
      const status = await vault.repairMetadata();
      return overviewFromStatus(input.authority, binding, status, this.#state);
    });
  }

  async trashLibrary(input: {
    readonly authority: ExtensionLibraryAuthority;
    readonly confirmation: string;
    readonly assertAuthorityCurrent: () => void | Promise<void>;
  }): Promise<ExtensionLibraryTrashEntry> {
    this.#assertReady();
    validateAuthority(input.authority);
    return this.#mutate(async () => {
      this.#assertStateAvailable();
      if (input.confirmation !== input.authority.name) throw new ExtensionLibraryError("CONFLICT", "Extension Library deletion confirmation did not match.");
      await input.assertAuthorityCurrent();
      this.#assertNoOperation(input.authority.extensionId);
      const source = this.#binding(input.authority.extensionId);
      if (source === undefined) throw new ExtensionLibraryError("NOT_FOUND", "Extension Library has no active data to delete.");
      const resolution = await this.#resolveBinding(source);
      if (!resolution.ok) throw unavailableBinding(resolution.reason);
      await this.#revokeSessionsInternal(source.extensionId);
      const vault = this.#createVault(source.root, source.extensionId);
      const status = await vault.open({ create: false });
      if (status.state === "unavailable") throw new ExtensionLibraryError("CORRUPT", "Extension Library metadata is unavailable.");
      vault.setReadonly(true);
      const snapshot = await vault.snapshot();
      const trashId = `library_trash_${randomUUID().replaceAll("-", "")}`;
      const container = this.#trashContainer(trashId);
      const targetRoot = join(container, "library");
      const deletedAt = this.#now();
      await mkdir(container, { recursive: false, mode: 0o700 });
      const moving: MovingTrashManifest = {
        format: 1,
        phase: "moving",
        trashId,
        source,
        targetRoot,
        deletedAt,
        expiresAt: deletedAt + TRASH_RETENTION_MS,
        files: snapshot.files,
        bytes: snapshot.bytes
      };
      await atomicJson(join(container, TRASH_MANIFEST_FILE), moving);
      try {
        await moveOrCopyExtensionLibrary({
          source: vault,
          targetRoot,
          extensionId: source.extensionId,
          sourceIdentity: source.identity,
          rename: this.#renameDirectory,
          now: this.#now,
          freeBytes: this.#freeBytes
        });
        const record: StoredTrash = {
          trashId,
          extensionId: source.extensionId,
          name: boundedName(input.authority.name),
          deletedAt,
          expiresAt: deletedAt + TRASH_RETENTION_MS,
          root: targetRoot,
          identity: await captureExtensionLibraryRootIdentity(targetRoot),
          source,
          files: snapshot.files,
          bytes: snapshot.bytes
        };
        await atomicJson(join(container, TRASH_MANIFEST_FILE), { format: 1, phase: "ready", record } satisfies ReadyTrashManifest);
        this.#state = reviseState(this.#state, {
          bindings: this.#state.bindings.filter((binding) => binding.extensionId !== source.extensionId),
          trash: [...this.#state.trash, record]
        });
        await this.#persistState();
        return publicTrash(record);
      } catch (error) {
        if (await exists(source.root)) await this.#removeTrashContainer(container).catch(() => undefined);
        throw error;
      }
    });
  }

  listTrash(extensionId?: string): readonly ExtensionLibraryTrashEntry[] {
    this.#assertReady();
    this.#assertStateAvailable();
    if (extensionId !== undefined && !EXTENSION_ID.test(extensionId)) throw new ExtensionLibraryError("PATH_INVALID", "Extension Library identity is invalid.");
    return this.#state.trash
      .filter((entry) => extensionId === undefined || entry.extensionId === extensionId)
      .map(publicTrash)
      .sort((left, right) => right.deletedAt - left.deletedAt || left.trashId.localeCompare(right.trashId));
  }

  async restoreTrash(input: {
    readonly trashId: string;
    readonly confirmation: string;
    readonly destination?: { readonly kind: "default" } | { readonly kind: "custom"; readonly candidate: string };
  }): Promise<{ readonly extensionId: string; readonly location: { readonly kind: ExtensionLibraryLocationKind; readonly path: string; readonly generation: bigint } }> {
    this.#assertReady();
    return this.#mutate(async () => {
      this.#assertStateAvailable();
      const record = this.#trash(input.trashId);
      if (input.confirmation !== record.name) throw new ExtensionLibraryError("CONFLICT", "Extension Library restore confirmation did not match.");
      this.#assertNoOperation(record.extensionId);
      if (this.#binding(record.extensionId) !== undefined) throw new ExtensionLibraryError("CONFLICT", "Extension Library already has active data.");
      await assertExtensionLibraryRootIdentity(record.root, record.identity);
      const destination: { readonly kind: "default" } | { readonly kind: "custom"; readonly candidate: string } = input.destination
        ?? (record.source.kind === "default"
          ? { kind: "default" }
          : { kind: "custom", candidate: dirname(record.source.root) });
      const validation = destination.kind === "default"
        ? await this.#validateCandidate(this.#dataDirectory, record.extensionId, true)
        : await this.#validateCandidate(destination.candidate, record.extensionId, false);
      if (await exists(validation.libraryRoot)) throw new ExtensionLibraryError("ALREADY_EXISTS", "Extension Library restore destination already exists.");
      const stagingRoot = restoreStagingRoot(validation.libraryRoot, record.trashId);
      if (await exists(stagingRoot)) throw new ExtensionLibraryError("ALREADY_EXISTS", "Extension Library restore staging destination already exists.");
      const vault = this.#createVault(record.root, record.extensionId);
      const status = await vault.open({ create: false });
      if (status.state === "unavailable") throw new ExtensionLibraryError("CORRUPT", "Trashed Extension Library metadata is unavailable.");
      const manifest: RestoringTrashManifest = {
        format: 1,
        phase: "restoring",
        record,
        destinationKind: destination.kind,
        targetRoot: validation.libraryRoot,
        stagingRoot,
        bindingGeneration: this.#nextGeneration(record.extensionId),
        updatedAt: this.#now()
      };
      await atomicJson(join(this.#trashContainer(record.trashId), TRASH_MANIFEST_FILE), manifest);
      let transferError: unknown;
      try {
        await moveOrCopyExtensionLibrary({
          source: vault,
          targetRoot: stagingRoot,
          extensionId: record.extensionId,
          sourceIdentity: record.identity,
          rename: this.#renameDirectory,
          now: this.#now,
          freeBytes: this.#freeBytes
        });
        await rename(stagingRoot, validation.libraryRoot);
      } catch (error) {
        transferError = error;
      }
      const binding = await this.#finishTrashRestore(manifest);
      if (binding === undefined) throw transferError ?? new ExtensionLibraryError("INTERNAL", "Extension Library restore did not complete.");
      return {
        extensionId: record.extensionId,
        location: { kind: binding.kind, path: binding.root, generation: BigInt(binding.generation) }
      };
    });
  }

  async purgeTrash(input: { readonly trashId: string; readonly confirmation: string }): Promise<boolean> {
    this.#assertReady();
    return this.#mutate(async () => {
      this.#assertStateAvailable();
      const record = this.#trash(input.trashId);
      if (input.confirmation !== record.name) throw new ExtensionLibraryError("CONFLICT", "Extension Library purge confirmation did not match.");
      await this.#purgeTrashRecord(record);
      return true;
    });
  }

  async purgeExpired(): Promise<{ readonly trash: number; readonly grace: number }> {
    this.#assertReady();
    return this.#mutate(async () => {
      this.#assertStateAvailable();
      const now = this.#now();
      let trash = 0;
      let grace = 0;
      for (const record of [...this.#state.trash]) {
        if (record.expiresAt > now) continue;
        await this.#purgeTrashRecord(record);
        trash += 1;
      }
      for (const record of [...this.#state.grace]) {
        if (record.expiresAt > now) continue;
        if (this.#binding(record.extensionId)?.root === record.root) continue;
        await this.#purgeGraceRecord(record);
        grace += 1;
      }
      return { trash, grace };
    });
  }

  listGrace(extensionId?: string): readonly ExtensionLibraryGraceEntry[] {
    this.#assertReady();
    this.#assertStateAvailable();
    if (extensionId !== undefined && !EXTENSION_ID.test(extensionId)) throw new ExtensionLibraryError("PATH_INVALID", "Extension Library identity is invalid.");
    return this.#state.grace
      .filter((entry) => extensionId === undefined || entry.extensionId === extensionId)
      .map(publicGrace)
      .sort((left, right) => right.createdAt - left.createdAt || left.graceId.localeCompare(right.graceId));
  }

  async rollbackRelocation(input: {
    readonly authority: ExtensionLibraryAuthority;
    readonly graceId: string;
    readonly assertAuthorityCurrent: () => void | Promise<void>;
  }): Promise<{ readonly location: { readonly kind: ExtensionLibraryLocationKind; readonly path: string; readonly generation: bigint }; readonly graceId: string }> {
    this.#assertReady();
    validateAuthority(input.authority);
    return this.#mutate(async () => {
      this.#assertStateAvailable();
      await input.assertAuthorityCurrent();
      this.#assertNoOperation(input.authority.extensionId);
      const grace = this.#grace(input.graceId);
      if (grace.extensionId !== input.authority.extensionId || grace.expiresAt <= this.#now()) {
        throw new ExtensionLibraryError("NOT_FOUND", "Extension Library grace copy is not available.");
      }
      const current = this.#binding(grace.extensionId);
      if (current === undefined) throw new ExtensionLibraryError("NOT_FOUND", "Extension Library binding is not available.");
      const currentResolution = await this.#resolveBinding(current);
      if (!currentResolution.ok) throw unavailableBinding(currentResolution.reason);
      await assertExtensionLibraryRootIdentity(grace.root, grace.identity);
      await this.#revokeSessionsInternal(grace.extensionId);
      const currentVault = this.#createVault(current.root, current.extensionId);
      const currentStatus = await currentVault.open({ create: false });
      if (currentStatus.state === "unavailable") throw new ExtensionLibraryError("CORRUPT", "Current Extension Library metadata is unavailable.");
      const currentSnapshot = await currentVault.snapshot();
      const graceVault = this.#createVault(grace.root, grace.extensionId);
      const graceStatus = await graceVault.open({ create: false });
      if (graceStatus.state === "unavailable") throw new ExtensionLibraryError("CORRUPT", "Extension Library grace metadata is unavailable.");
      const graceSnapshot = await graceVault.snapshot();
      if (graceSnapshot.files !== grace.files || graceSnapshot.bytes !== grace.bytes) {
        throw new ExtensionLibraryError("CORRUPT", "Extension Library grace copy changed before rollback.");
      }
      const rollbackId = `library_rollback_${randomUUID().replaceAll("-", "")}`;
      const nextGraceId = `library_grace_${randomUUID().replaceAll("-", "")}`;
      const rollbackAt = this.#now();
      const nextGraceRoot = `${current.root}.joko-grace-${rollbackAt}-${nextGraceId.slice(-32)}`;
      if (await exists(nextGraceRoot)) throw new ExtensionLibraryError("ALREADY_EXISTS", "Extension Library rollback grace target already exists.");
      const rollback: StoredRollback = {
        rollbackId,
        extensionId: current.extensionId,
        name: boundedName(input.authority.name),
        current,
        selectedGrace: grace,
        nextGraceId,
        nextGraceRoot,
        bindingGeneration: this.#nextGeneration(current.extensionId),
        startedAt: rollbackAt,
        files: currentSnapshot.files,
        bytes: currentSnapshot.bytes
      };
      this.#state = reviseState(this.#state, { rollbacks: [...this.#state.rollbacks, rollback] });
      await this.#persistState();
      const completed = await this.#finishRollback(rollback);
      return {
        location: {
          kind: completed.binding.kind,
          path: completed.binding.root,
          generation: BigInt(completed.binding.generation)
        },
        graceId: completed.grace.graceId
      };
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#expirationTimer !== undefined) clearInterval(this.#expirationTimer);
    await Promise.allSettled([...this.#activeRelocations]);
    await this.#mutate(async () => {
      for (const session of [...this.#sessions.values()]) await this.#destroySession(session);
    });
  }

  async #withSession<T>(
    sessionId: string,
    connectionId: string,
    write: boolean,
    action: (session: ActiveSession) => Promise<T> | T
  ): Promise<T> {
    this.#assertReady();
    return this.#mutate(async () => {
      const session = await this.#requireSession(sessionId, connectionId);
      if (write) await session.vault.assertWritable();
      return action(session);
    });
  }

  async #requireSession(sessionId: string, connectionId: string): Promise<ActiveSession> {
    if (!SESSION_ID.test(sessionId) || !CONNECTION_ID.test(connectionId)) {
      throw new ExtensionLibraryError("NOT_FOUND", "Extension Library session is not available.");
    }
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.connectionId !== connectionId) {
      throw new ExtensionLibraryError("NOT_FOUND", "Extension Library session is not available.");
    }
    if (Atomics.load(new Int32Array(session.authorityState), 0) !== 0) {
      await this.#destroySession(session);
      throw new ExtensionLibraryError("UNAVAILABLE", "Extension Library session authority was revoked.");
    }
    if (session.expiresAt <= this.#now()) {
      await this.#destroySession(session);
      throw new ExtensionLibraryError("UNAVAILABLE", "Extension Library session expired.");
    }
    try {
      await session.assertAuthorityCurrent();
      if (authorityKey(session.authority) !== session.authorityKey) throw new Error("authority changed");
      const current = this.#binding(session.authority.extensionId);
      if (current === undefined || current.generation !== session.binding.generation || current.root !== session.binding.root) {
        throw new Error("binding changed");
      }
      await assertExtensionLibraryRootIdentity(current.root, current.identity);
    } catch (error) {
      await this.#destroySession(session);
      throw new ExtensionLibraryError("UNAVAILABLE", "Extension Library session authority was revoked.", { cause: error });
    }
    return session;
  }

  #stream(sessionId: string, streamId: string): ActiveStream {
    if (!STREAM_ID.test(streamId)) throw new ExtensionLibraryError("NOT_FOUND", "Library stream is not available.");
    const stream = this.#streams.get(streamId);
    if (stream === undefined || stream.sessionId !== sessionId || stream.expiresAt <= this.#now()) {
      throw new ExtensionLibraryError("NOT_FOUND", "Library stream is not available.");
    }
    return stream;
  }

  async #discardStream(session: ActiveSession, stream: ActiveStream): Promise<void> {
    this.#streams.delete(stream.streamId);
    await stream.handle?.close().catch(() => undefined);
    stream.handle = undefined;
    await session.vault.discardTemporaryPath(stream.temporaryPath, ".stream").catch(() => undefined);
  }

  async #destroySession(session: ActiveSession): Promise<void> {
    this.#signalSessionRevoked(session);
    this.#sessions.delete(session.sessionId);
    for (const stream of [...this.#streams.values()]) {
      if (stream.sessionId === session.sessionId) await this.#discardStream(session, stream);
    }
    await session.sql.closeAll().catch(() => undefined);
  }

  async #expire(): Promise<void> {
    if (!this.#initialized || this.#closed) return;
    await this.#mutate(() => this.#expireInternal()).catch(() => undefined);
  }

  async #expireInternal(): Promise<void> {
    const now = this.#now();
    for (const stream of [...this.#streams.values()]) {
      if (stream.expiresAt > now) continue;
      const session = this.#sessions.get(stream.sessionId);
      if (session !== undefined) await this.#discardStream(session, stream);
    }
    for (const session of [...this.#sessions.values()]) {
      if (session.expiresAt <= now) await this.#destroySession(session);
    }
  }

  #createVault(
    root: string,
    extensionId: string,
    beforeFilesystemMutation?: NonNullable<ExtensionLibraryVaultOptions["beforeFilesystemMutation"]>
  ): ExtensionLibraryVault {
    return new ExtensionLibraryVault({
      root,
      extensionId,
      now: this.#now,
      freeBytes: this.#freeBytes,
      ...(beforeFilesystemMutation === undefined ? {} : { beforeFilesystemMutation })
    });
  }

  #binding(extensionId: string): StoredBinding | undefined {
    return this.#state.bindings.find((binding) => binding.extensionId === extensionId);
  }

  #assertNoOperation(extensionId: string): void {
    if (this.#hasOperation(extensionId)) {
      throw new ExtensionLibraryError("CONFLICT", "An Extension Library operation is already in progress.");
    }
  }

  #hasOperation(extensionId: string): boolean {
    return this.#state.migrations.some((entry) => entry.extensionId === extensionId)
      || this.#state.rollbacks.some((entry) => entry.extensionId === extensionId);
  }

  #assertMigrationCurrent(expected: StoredMigration, phase: StoredMigration["phase"]): void {
    const current = this.#state.migrations.find((entry) => entry.migrationId === expected.migrationId);
    if (current === undefined || current.extensionId !== expected.extensionId || current.phase !== phase
      || current.source.generation !== expected.source.generation || current.source.root !== expected.source.root
      || current.targetRoot !== expected.targetRoot || current.stagingRoot !== expected.stagingRoot) {
      throw new ExtensionLibraryError("CONFLICT", "Extension Library migration authority changed.");
    }
  }

  #setExtensionSessionsReadonly(extensionId: string, readonly: boolean): void {
    for (const session of this.#sessions.values()) {
      if (session.authority.extensionId === extensionId) session.vault.setReadonly(readonly);
    }
  }

  #nextGeneration(extensionId: string): string {
    return increment(this.#state.generations.find((entry) => entry.extensionId === extensionId)?.generation ?? "0");
  }

  async #ensureBinding(authority: ExtensionLibraryAuthority): Promise<StoredBinding> {
    const existing = this.#binding(authority.extensionId);
    if (existing !== undefined) return existing;
    const root = join(this.#dataDirectory, authority.extensionId);
    const vault = this.#createVault(root, authority.extensionId);
    const status = await vault.open();
    if (status.state === "unavailable") throw new ExtensionLibraryError("CORRUPT", "Default Extension Library could not be initialized.");
    const binding: StoredBinding = {
      extensionId: authority.extensionId,
      name: boundedName(authority.name),
      kind: "default",
      root,
      generation: this.#nextGeneration(authority.extensionId),
      identity: await captureExtensionLibraryRootIdentity(root),
      updatedAt: this.#now()
    };
    this.#state = reviseState(this.#state, {
      generations: replaceGeneration(this.#state.generations, binding.extensionId, binding.generation),
      bindings: [...this.#state.bindings, binding]
    });
    await this.#persistState();
    return binding;
  }

  async #resolveBinding(binding: StoredBinding): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: "disk_missing" | "binding_moved" }> {
    try {
      await assertExtensionLibraryRootIdentity(binding.root, binding.identity);
      return { ok: true };
    } catch (error) {
      if (error instanceof ExtensionLibraryError && error.code === "UNAVAILABLE") {
        return { ok: false, reason: /missing/iu.test(error.message) ? "disk_missing" : "binding_moved" };
      }
      throw error;
    }
  }

  async #validateCandidate(candidate: string, extensionId: string, allowManagedRoot: boolean): Promise<ExtensionLibraryLocationValidation> {
    if (typeof candidate !== "string" || candidate.length === 0 || !isAbsolute(candidate) || candidate.startsWith("\\\\")) {
      throw new ExtensionLibraryError("PATH_INVALID", "Extension Library location must be a local absolute directory.");
    }
    const lexical = resolve(candidate);
    await mkdir(lexical, { recursive: true, mode: 0o700 });
    const info = await lstat(lexical);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ExtensionLibraryError("PATH_INVALID", "Extension Library location is not a regular directory.");
    const canonical = resolve(await realpath(lexical));
    if (canonical !== lexical) throw new ExtensionLibraryError("PATH_INVALID", "Extension Library location resolves through an alias.");
    const libraryRoot = join(canonical, extensionId);
    if (!allowManagedRoot) {
      for (const managedRoot of this.#managedRoots) {
        const canonicalManaged = await canonicalIfPresent(managedRoot);
        if (inside(canonicalManaged, libraryRoot)) {
          throw new ExtensionLibraryError("PATH_INVALID", "Custom Extension Library location is inside a managed data root.");
        }
      }
    }
    const probe = join(canonical, `.joko-library-probe-${randomUUID()}`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(probe, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      await handle.sync();
    } catch (error) {
      throw new ExtensionLibraryError("UNAVAILABLE", "Extension Library location is not writable.", { cause: error });
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(probe).catch(() => undefined);
    }
    const diskFreeBytes = await this.#freeBytes(canonical).catch(() => undefined);
    if (diskFreeBytes !== undefined && diskFreeBytes < LOCATION_MINIMUM_FREE_BYTES) {
      throw new ExtensionLibraryError("DISK_FULL", "Extension Library location has less than 256 MiB free.");
    }
    const lower = canonical.toLowerCase();
    const warnings = CLOUD_MARKERS.some((marker) => lower.includes(marker))
      ? ["cloud_sync_location"]
      : [];
    return { libraryRoot, warnings, ...(diskFreeBytes === undefined ? {} : { diskFreeBytes }) };
  }

  async #advanceMigration(migration: StoredMigration, phase: StoredMigration["phase"]): Promise<StoredMigration> {
    const updated = { ...migration, phase };
    this.#state = reviseState(this.#state, {
      migrations: this.#state.migrations.map((entry) => entry.migrationId === migration.migrationId ? updated : entry)
    });
    await this.#persistState();
    return updated;
  }

  async #removeStaging(migration: StoredMigration): Promise<void> {
    if (!validStagingPath(migration)) throw new ExtensionLibraryError("PATH_INVALID", "Extension Library migration staging path is invalid.");
    if (!(await exists(migration.stagingRoot))) return;
    const identity = await captureExtensionLibraryRootIdentity(migration.stagingRoot);
    await removeExtensionLibraryRoot(migration.stagingRoot, identity);
  }

  #trash(trashId: string): StoredTrash {
    if (!TRASH_ID.test(trashId)) throw new ExtensionLibraryError("NOT_FOUND", "Extension Library trash entry is not available.");
    const record = this.#state.trash.find((entry) => entry.trashId === trashId);
    if (record === undefined) throw new ExtensionLibraryError("NOT_FOUND", "Extension Library trash entry is not available.");
    if (record.root !== join(this.#trashContainer(record.trashId), "library")) {
      throw new ExtensionLibraryError("CORRUPT", "Extension Library trash entry escaped its owner root.");
    }
    return record;
  }

  #grace(graceId: string): StoredGrace {
    if (!GRACE_ID.test(graceId)) throw new ExtensionLibraryError("NOT_FOUND", "Extension Library grace entry is not available.");
    const record = this.#state.grace.find((entry) => entry.graceId === graceId);
    if (record === undefined) throw new ExtensionLibraryError("NOT_FOUND", "Extension Library grace entry is not available.");
    return record;
  }

  #trashContainer(trashId: string): string {
    if (!TRASH_ID.test(trashId)) throw new ExtensionLibraryError("PATH_INVALID", "Extension Library trash identity is invalid.");
    return join(this.#trashDirectory, trashId);
  }

  async #removeTrashContainer(container: string): Promise<void> {
    const target = resolve(container);
    if (dirname(target) !== this.#trashDirectory || !TRASH_ID.test(basename(target))) {
      throw new ExtensionLibraryError("PATH_INVALID", "Extension Library trash container escaped its owner root.");
    }
    if (!(await exists(target))) return;
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ExtensionLibraryError("PATH_INVALID", "Extension Library trash container identity is invalid.");
    await rm(target, { recursive: true, force: false });
  }

  async #revokeSessionsInternal(extensionId: string): Promise<void> {
    for (const session of [...this.#sessions.values()]) {
      if (session.authority.extensionId === extensionId) await this.#destroySession(session);
    }
  }

  #signalSessionRevoked(session: ActiveSession): void {
    Atomics.store(new Int32Array(session.authorityState), 0, 1);
    session.vault.setReadonly(true);
    session.sql.revoke();
  }

  #signalExtensionRevoked(extensionId: string): void {
    for (const session of this.#sessions.values()) {
      if (session.authority.extensionId === extensionId) this.#signalSessionRevoked(session);
    }
  }

  async #markOrphanedInternal(extensionId: string, orphanedName?: string): Promise<void> {
    if (orphanedName === undefined || this.#stateUnavailable) return;
    const binding = this.#binding(extensionId);
    if (binding === undefined || !(await this.#resolveBinding(binding)).ok) return;
    const vault = this.#createVault(binding.root, extensionId);
    const status = await vault.open({ create: false });
    if (status.state !== "unavailable") await vault.markOrphaned(orphanedName);
  }

  #assertStateTopology(): void {
    const generations = new Map(this.#state.generations.map((entry) => [entry.extensionId, BigInt(entry.generation)]));
    for (const binding of this.#state.bindings) {
      if (generations.get(binding.extensionId) !== BigInt(binding.generation)) {
        throw new ExtensionLibraryError("CORRUPT", "Extension Library binding generation ledger is inconsistent.");
      }
      if (binding.kind === "default" && binding.root !== join(this.#dataDirectory, binding.extensionId)) {
        throw new ExtensionLibraryError("CORRUPT", "Default Extension Library binding escaped its data root.");
      }
      if (binding.kind === "custom" && this.#managedRoots.some((managed) => inside(managed, binding.root))) {
        throw new ExtensionLibraryError("CORRUPT", "Custom Extension Library binding entered a managed root.");
      }
    }
    for (const record of this.#state.trash) {
      if ((generations.get(record.extensionId) ?? -1n) < BigInt(record.source.generation)) {
        throw new ExtensionLibraryError("CORRUPT", "Extension Library trash generation escaped its ledger.");
      }
      if (record.root !== join(this.#trashContainer(record.trashId), "library")) {
        throw new ExtensionLibraryError("CORRUPT", "Extension Library trash entry escaped its owner root.");
      }
    }
    for (const record of this.#state.grace) {
      if ((generations.get(record.extensionId) ?? -1n) < BigInt(record.source.generation)) {
        throw new ExtensionLibraryError("CORRUPT", "Extension Library grace generation escaped its ledger.");
      }
      if (this.#binding(record.extensionId)?.root === record.root) {
        throw new ExtensionLibraryError("CORRUPT", "Extension Library grace copy conflicts with its active binding.");
      }
    }
    for (const migration of this.#state.migrations) {
      if ((generations.get(migration.extensionId) ?? -1n) < BigInt(migration.source.generation)) {
        throw new ExtensionLibraryError("CORRUPT", "Extension Library migration generation escaped its ledger.");
      }
      if (!validStagingPath(migration) || migration.targetRoot === migration.source.root) {
        throw new ExtensionLibraryError("CORRUPT", "Extension Library migration topology is invalid.");
      }
    }
    for (const rollback of this.#state.rollbacks) {
      if ((generations.get(rollback.extensionId) ?? -1n) < BigInt(rollback.current.generation)
        || rollback.current.extensionId !== rollback.extensionId
        || rollback.selectedGrace.extensionId !== rollback.extensionId
        || rollback.selectedGrace.phase !== "ready"
        || rollback.current.root === rollback.selectedGrace.root
        || rollback.nextGraceRoot !== rollbackGraceRootFor(rollback)) {
        throw new ExtensionLibraryError("CORRUPT", "Extension Library rollback topology is invalid.");
      }
    }
    const activeOperations = [
      ...this.#state.migrations.map((entry) => entry.extensionId),
      ...this.#state.rollbacks.map((entry) => entry.extensionId)
    ];
    unique(activeOperations, "Extension Library active operations");
  }

  #controlPath(): string {
    return join(this.#rootDirectory, CONTROL_FILE);
  }

  #previousControlPath(): string {
    return join(this.#rootDirectory, PREVIOUS_CONTROL_FILE);
  }

  async #isFreshRoot(): Promise<boolean> {
    if (await exists(this.#previousControlPath())) return false;
    const [data, trash] = await Promise.all([readdir(this.#dataDirectory), readdir(this.#trashDirectory)]);
    return data.length === 0 && trash.length === 0;
  }

  async #persistState(): Promise<void> {
    const control = this.#controlPath();
    const previous = this.#previousControlPath();
    try {
      const current = await readManagerRecord(control);
      validateState(JSON.parse(current.toString("utf8")));
      await atomicBytes(previous, current);
    } catch (error) {
      if (!missing(error) && !(error instanceof ExtensionLibraryError) && !(error instanceof SyntaxError)) throw error;
    }
    await atomicJson(control, this.#state);
  }

  async #preserveUnavailableControl(): Promise<void> {
    const control = this.#controlPath();
    let before: BigIntStats;
    try {
      before = await lstat(control, { bigint: true });
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    const preserved = join(this.#rootDirectory, `library-state.corrupt.${this.#now()}.${randomUUID()}`);
    await rename(control, preserved);
    const after = await lstat(preserved, { bigint: true });
    if (!sameManagerObject(before, after)) {
      throw new ExtensionLibraryError("CONFLICT", "Extension Library control state changed while it was preserved.");
    }
    await syncDirectory(this.#rootDirectory);
  }

  async #recoverTrashManifests(): Promise<void> {
    let changed = false;
    for (const entry of await readdir(this.#trashDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !TRASH_ID.test(entry.name)) {
        this.#stateUnavailable = true;
        throw new ExtensionLibraryError("CORRUPT", "Extension Library trash root contains an unknown entry.");
      }
      const container = this.#trashContainer(entry.name);
      let manifest: TrashManifest;
      try {
        manifest = validateTrashManifest(JSON.parse(
          (await readManagerRecord(join(container, TRASH_MANIFEST_FILE), 1024 * 1024)).toString("utf8")
        ));
      } catch (error) {
        this.#stateUnavailable = true;
        throw new ExtensionLibraryError("CORRUPT", "Extension Library trash manifest is corrupt.", { cause: error });
      }
      const manifestTrashId = manifest.phase === "moving" ? manifest.trashId : manifest.record.trashId;
      const manifestRoot = manifest.phase === "moving" ? manifest.targetRoot : manifest.record.root;
      if (manifestTrashId !== entry.name || manifestRoot !== join(container, "library")) {
        throw new ExtensionLibraryError("CORRUPT", "Extension Library trash manifest escaped its owner container.");
      }
      if (manifest.phase === "ready") {
        await assertExtensionLibraryRootIdentity(manifest.record.root, manifest.record.identity);
        if (this.#state.trash.some((record) => record.trashId === manifest.record.trashId)) continue;
        const binding = this.#binding(manifest.record.extensionId);
        if (binding !== undefined && !sameBinding(binding, manifest.record.source)) {
          throw new ExtensionLibraryError("CORRUPT", "Recovered Extension Library trash conflicts with an active binding.");
        }
        this.#state = reviseState(this.#state, {
          generations: replaceGeneration(
            this.#state.generations,
            manifest.record.extensionId,
            manifest.record.source.generation
          ),
          bindings: this.#state.bindings.filter((candidate) => candidate.extensionId !== manifest.record.extensionId),
          trash: [...this.#state.trash, manifest.record]
        });
        changed = true;
        continue;
      }
      if (manifest.phase === "restoring") {
        await this.#finishTrashRestore(manifest);
        continue;
      }
      if (manifest.phase === "purging") {
        await this.#purgeTrashRecord(manifest.record);
        continue;
      }
      const sourceExists = await exists(manifest.source.root);
      const targetExists = await exists(manifest.targetRoot);
      if (sourceExists) {
        if (targetExists) {
          const identity = await captureExtensionLibraryRootIdentity(manifest.targetRoot);
          await removeExtensionLibraryRoot(manifest.targetRoot, identity);
        }
        await this.#removeTrashContainer(container);
        continue;
      }
      if (!targetExists) {
        this.#stateUnavailable = true;
        throw new ExtensionLibraryError("CORRUPT", "Extension Library trash recovery lost both source and target.");
      }
      const record: StoredTrash = {
        trashId: manifest.trashId,
        extensionId: manifest.source.extensionId,
        name: manifest.source.name,
        deletedAt: manifest.deletedAt,
        expiresAt: manifest.expiresAt,
        root: manifest.targetRoot,
        identity: await captureExtensionLibraryRootIdentity(manifest.targetRoot),
        source: manifest.source,
        files: manifest.files,
        bytes: manifest.bytes
      };
      await atomicJson(join(container, TRASH_MANIFEST_FILE), { format: 1, phase: "ready", record } satisfies ReadyTrashManifest);
      this.#state = reviseState(this.#state, {
        generations: replaceGeneration(this.#state.generations, record.extensionId, record.source.generation),
        bindings: this.#state.bindings.filter((binding) => binding.extensionId !== record.extensionId),
        trash: [...this.#state.trash, record]
      });
      changed = true;
    }
    if (changed) await this.#persistState();
  }

  async #finishTrashRestore(manifest: RestoringTrashManifest): Promise<StoredBinding | undefined> {
    await this.#assertRestoreManifestTopology(manifest);
    const sourceExists = await exists(manifest.record.root);
    const stagingExists = await exists(manifest.stagingRoot);
    const targetExists = await exists(manifest.targetRoot);
    if (sourceExists) {
      if (targetExists) {
        throw new ExtensionLibraryError("CORRUPT", "Extension Library restore retained both its trash copy and final destination.");
      }
      if (stagingExists) {
        const identity = await captureExtensionLibraryRootIdentity(manifest.stagingRoot);
        await removeExtensionLibraryRoot(manifest.stagingRoot, identity);
      }
      const active = this.#binding(manifest.record.extensionId);
      if (active !== undefined) throw new ExtensionLibraryError("CORRUPT", "Extension Library restore conflicts with an active binding.");
      if (!this.#state.trash.some((entry) => entry.trashId === manifest.record.trashId)) {
        this.#state = reviseState(this.#state, {
          generations: replaceGeneration(
            this.#state.generations,
            manifest.record.extensionId,
            manifest.record.source.generation
          ),
          trash: [...this.#state.trash, manifest.record]
        });
        await this.#persistState();
      }
      await atomicJson(
        join(this.#trashContainer(manifest.record.trashId), TRASH_MANIFEST_FILE),
        { format: 1, phase: "ready", record: manifest.record } satisfies ReadyTrashManifest
      );
      return undefined;
    }
    if (stagingExists && targetExists) {
      throw new ExtensionLibraryError("CORRUPT", "Extension Library restore has both staging and final destinations.");
    }
    if (!targetExists) {
      if (!stagingExists) throw new ExtensionLibraryError("CORRUPT", "Extension Library restore lost every recoverable copy.");
      await rename(manifest.stagingRoot, manifest.targetRoot);
    }
    const vault = this.#createVault(manifest.targetRoot, manifest.record.extensionId);
    const status = await vault.open({ create: false });
    if (status.state === "unavailable") throw new ExtensionLibraryError("CORRUPT", "Restored Extension Library metadata is unavailable.");
    const snapshot = await vault.snapshot();
    if (snapshot.files !== manifest.record.files) {
      throw new ExtensionLibraryError("CORRUPT", "Restored Extension Library file count did not match its verified trash record.");
    }
    const existing = this.#binding(manifest.record.extensionId);
    if (existing !== undefined) {
      if (existing.root !== manifest.targetRoot || existing.kind !== manifest.destinationKind
        || existing.generation !== manifest.bindingGeneration) {
        throw new ExtensionLibraryError("CORRUPT", "Recovered Extension Library restore conflicts with its active binding.");
      }
      await assertExtensionLibraryRootIdentity(existing.root, existing.identity);
      if (this.#state.trash.some((entry) => entry.trashId === manifest.record.trashId)) {
        this.#state = reviseState(this.#state, {
          generations: replaceGeneration(this.#state.generations, existing.extensionId, existing.generation),
          trash: this.#state.trash.filter((entry) => entry.trashId !== manifest.record.trashId)
        });
        await this.#persistState();
      }
      await this.#removeTrashContainer(this.#trashContainer(manifest.record.trashId));
      return existing;
    }
    const binding: StoredBinding = {
      extensionId: manifest.record.extensionId,
      name: manifest.record.name,
      kind: manifest.destinationKind,
      root: manifest.targetRoot,
      generation: manifest.bindingGeneration,
      identity: await captureExtensionLibraryRootIdentity(manifest.targetRoot),
      updatedAt: manifest.updatedAt
    };
    this.#state = reviseState(this.#state, {
      generations: replaceGeneration(this.#state.generations, binding.extensionId, binding.generation),
      bindings: [...this.#state.bindings, binding],
      trash: this.#state.trash.filter((entry) => entry.trashId !== manifest.record.trashId)
    });
    await this.#persistState();
    await this.#removeTrashContainer(this.#trashContainer(manifest.record.trashId));
    return binding;
  }

  async #purgeTrashRecord(record: StoredTrash): Promise<void> {
    const container = this.#trashContainer(record.trashId);
    if (record.root !== join(container, "library")) {
      throw new ExtensionLibraryError("CORRUPT", "Extension Library purge escaped its trash container.");
    }
    await atomicJson(
      join(container, TRASH_MANIFEST_FILE),
      { format: 1, phase: "purging", record } satisfies PurgingTrashManifest
    );
    if (await exists(record.root)) await removeExtensionLibraryRoot(record.root, record.identity);
    if (this.#state.trash.some((entry) => entry.trashId === record.trashId)) {
      this.#state = reviseState(this.#state, {
        trash: this.#state.trash.filter((entry) => entry.trashId !== record.trashId)
      });
      await this.#persistState();
    }
    await this.#removeTrashContainer(container);
  }

  async #assertRestoreManifestTopology(manifest: RestoringTrashManifest): Promise<void> {
    if (manifest.targetRoot === manifest.record.root
      || manifest.stagingRoot !== restoreStagingRoot(manifest.targetRoot, manifest.record.trashId)) {
      throw new ExtensionLibraryError("CORRUPT", "Extension Library restore topology is invalid.");
    }
    const parent = dirname(manifest.targetRoot);
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(parent)) !== resolve(parent)) {
      throw new ExtensionLibraryError("CORRUPT", "Extension Library restore parent is not a canonical directory.");
    }
    if (manifest.destinationKind === "default") {
      if (manifest.targetRoot !== join(this.#dataDirectory, manifest.record.extensionId)) {
        throw new ExtensionLibraryError("CORRUPT", "Default Extension Library restore escaped its data root.");
      }
      return;
    }
    if (basename(manifest.targetRoot) !== manifest.record.extensionId
      || this.#managedRoots.some((managed) => inside(managed, manifest.targetRoot))) {
      throw new ExtensionLibraryError("CORRUPT", "Custom Extension Library restore entered a managed root.");
    }
  }

  async #recoverDefaultBindings(): Promise<void> {
    let changed = false;
    for (const entry of await readdir(this.#dataDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !EXTENSION_ID.test(entry.name)) {
        throw new ExtensionLibraryError("CORRUPT", "Extension Library data root contains an unknown entry.");
      }
      if (this.#binding(entry.name) !== undefined) continue;
      const root = join(this.#dataDirectory, entry.name);
      const vault = this.#createVault(root, entry.name);
      const status = await vault.open({ create: false });
      if (status.state === "unavailable") throw new ExtensionLibraryError("CORRUPT", "Untracked default Extension Library is corrupt.");
      const binding: StoredBinding = {
        extensionId: entry.name,
        name: entry.name,
        kind: "default",
        root,
        generation: this.#nextGeneration(entry.name),
        identity: await captureExtensionLibraryRootIdentity(root),
        updatedAt: this.#now()
      };
      this.#state = reviseState(this.#state, {
        generations: replaceGeneration(this.#state.generations, binding.extensionId, binding.generation),
        bindings: [...this.#state.bindings, binding]
      });
      changed = true;
    }
    if (changed) await this.#persistState();
  }

  async #recoverGracePurges(): Promise<void> {
    for (const record of [...this.#state.grace]) {
      if (record.phase !== "purging") continue;
      await this.#purgeGraceRecord(record);
    }
  }

  async #purgeGraceRecord(record: StoredGrace): Promise<void> {
    if (this.#binding(record.extensionId)?.root === record.root) {
      throw new ExtensionLibraryError("CORRUPT", "Extension Library grace purge conflicts with its active binding.");
    }
    if (record.phase !== "purging") {
      const purging = { ...record, phase: "purging" as const };
      this.#state = reviseState(this.#state, {
        grace: this.#state.grace.map((entry) => entry.graceId === record.graceId ? purging : entry)
      });
      await this.#persistState();
      record = purging;
    }
    if (await exists(record.root)) await removeExtensionLibraryRoot(record.root, record.identity);
    if (this.#state.grace.some((entry) => entry.graceId === record.graceId)) {
      this.#state = reviseState(this.#state, {
        grace: this.#state.grace.filter((entry) => entry.graceId !== record.graceId)
      });
      await this.#persistState();
    }
  }

  async #recoverMigrations(): Promise<void> {
    let changed = false;
    for (const migration of [...this.#state.migrations]) {
      if (migration.phase !== "switching") {
        await this.#removeStaging(migration);
        this.#state = reviseState(this.#state, {
          migrations: this.#state.migrations.filter((entry) => entry.migrationId !== migration.migrationId)
        });
        changed = true;
        continue;
      }
      if (!(await exists(migration.targetRoot))) {
        if (!(await exists(migration.stagingRoot))) {
          this.#stateUnavailable = true;
          throw new ExtensionLibraryError("CORRUPT", "Extension Library switching recovery lost its target.");
        }
        await this.#renameDirectory(migration.stagingRoot, migration.targetRoot);
      }
      const targetVault = this.#createVault(migration.targetRoot, migration.extensionId);
      const targetStatus = await targetVault.open({ create: false });
      if (targetStatus.state === "unavailable") {
        this.#stateUnavailable = true;
        throw new ExtensionLibraryError("CORRUPT", "Extension Library switching target is corrupt.");
      }
      await targetVault.snapshot();
      const graceId = migration.graceId;
      const desiredGraceRoot = graceRootFor(migration, graceId);
      let actualGraceRoot = desiredGraceRoot;
      if (!(await exists(desiredGraceRoot))) {
        if (!(await exists(migration.source.root))) {
          this.#stateUnavailable = true;
          throw new ExtensionLibraryError("CORRUPT", "Extension Library switching recovery lost its source grace copy.");
        }
        try {
          await this.#renameDirectory(migration.source.root, desiredGraceRoot);
        } catch {
          actualGraceRoot = migration.source.root;
        }
      }
      const graceVault = this.#createVault(actualGraceRoot, migration.extensionId);
      const graceStatus = await graceVault.open({ create: false });
      if (graceStatus.state === "unavailable") {
        this.#stateUnavailable = true;
        throw new ExtensionLibraryError("CORRUPT", "Extension Library switching grace copy is corrupt.");
      }
      const graceSnapshot = await graceVault.snapshot();
      const now = this.#now();
      const nextBinding: StoredBinding = {
        extensionId: migration.extensionId,
        name: migration.name,
        kind: migration.targetKind,
        root: migration.targetRoot,
        generation: this.#nextGeneration(migration.extensionId),
        identity: await captureExtensionLibraryRootIdentity(migration.targetRoot),
        updatedAt: now
      };
      const grace: StoredGrace = {
        graceId,
        extensionId: migration.extensionId,
        name: migration.source.name,
        phase: "ready",
        createdAt: now,
        expiresAt: now + GRACE_RETENTION_MS,
        root: actualGraceRoot,
        originalRoot: migration.source.root,
        identity: await captureExtensionLibraryRootIdentity(actualGraceRoot),
        source: migration.source,
        files: graceSnapshot.files,
        bytes: graceSnapshot.bytes
      };
      this.#state = reviseState(this.#state, {
        generations: replaceGeneration(this.#state.generations, nextBinding.extensionId, nextBinding.generation),
        bindings: replaceBinding(this.#state.bindings, nextBinding),
        grace: [...this.#state.grace.filter((entry) => entry.graceId !== graceId), grace],
        migrations: this.#state.migrations.filter((entry) => entry.migrationId !== migration.migrationId)
      });
      changed = true;
    }
    if (changed) await this.#persistState();
  }

  async #recoverRollbacks(): Promise<void> {
    for (const rollback of [...this.#state.rollbacks]) await this.#finishRollback(rollback);
  }

  async #finishRollback(rollback: StoredRollback): Promise<{ readonly binding: StoredBinding; readonly grace: StoredGrace }> {
    const currentRecord = this.#state.rollbacks.find((entry) => entry.rollbackId === rollback.rollbackId);
    if (currentRecord === undefined || !sameRollback(currentRecord, rollback)) {
      throw new ExtensionLibraryError("CONFLICT", "Extension Library rollback authority changed.");
    }
    const active = this.#binding(rollback.extensionId);
    const selected = this.#state.grace.find((entry) => entry.graceId === rollback.selectedGrace.graceId);
    if (active === undefined || !sameBinding(active, rollback.current)
      || selected === undefined || !sameGrace(selected, rollback.selectedGrace)) {
      throw new ExtensionLibraryError("CORRUPT", "Extension Library rollback ledger changed before recovery.");
    }

    const currentAtGrace = await exists(rollback.nextGraceRoot);
    if (currentAtGrace) {
      await assertExtensionLibraryRootIdentity(
        rollback.nextGraceRoot,
        identityAt(rollback.current.identity, rollback.nextGraceRoot)
      );
    } else {
      await assertExtensionLibraryRootIdentity(rollback.current.root, rollback.current.identity);
      await this.#renameDirectory(rollback.current.root, rollback.nextGraceRoot);
      await assertExtensionLibraryRootIdentity(
        rollback.nextGraceRoot,
        identityAt(rollback.current.identity, rollback.nextGraceRoot)
      );
    }

    const targetRoot = rollback.selectedGrace.originalRoot;
    if (rollback.selectedGrace.root === targetRoot) {
      await assertExtensionLibraryRootIdentity(targetRoot, rollback.selectedGrace.identity);
    } else if (await exists(targetRoot)) {
      await assertExtensionLibraryRootIdentity(
        targetRoot,
        identityAt(rollback.selectedGrace.identity, targetRoot)
      );
      if (await exists(rollback.selectedGrace.root)) {
        throw new ExtensionLibraryError("CORRUPT", "Extension Library rollback retained both selected grace locations.");
      }
    } else {
      await assertExtensionLibraryRootIdentity(rollback.selectedGrace.root, rollback.selectedGrace.identity);
      await this.#renameDirectory(rollback.selectedGrace.root, targetRoot);
      await assertExtensionLibraryRootIdentity(targetRoot, identityAt(rollback.selectedGrace.identity, targetRoot));
    }

    const restoredVault = this.#createVault(targetRoot, rollback.extensionId);
    const restoredStatus = await restoredVault.open({ create: false });
    if (restoredStatus.state === "unavailable") {
      throw new ExtensionLibraryError("CORRUPT", "Restored Extension Library metadata is unavailable after rollback.");
    }
    const restoredSnapshot = await restoredVault.snapshot();
    if (restoredSnapshot.files !== rollback.selectedGrace.files || restoredSnapshot.bytes !== rollback.selectedGrace.bytes) {
      throw new ExtensionLibraryError("CORRUPT", "Restored Extension Library changed during rollback.");
    }
    const nextGraceVault = this.#createVault(rollback.nextGraceRoot, rollback.extensionId);
    const nextGraceStatus = await nextGraceVault.open({ create: false });
    if (nextGraceStatus.state === "unavailable") {
      throw new ExtensionLibraryError("CORRUPT", "Retained Extension Library metadata is unavailable after rollback.");
    }
    const nextGraceSnapshot = await nextGraceVault.snapshot();
    if (nextGraceSnapshot.files !== rollback.files || nextGraceSnapshot.bytes !== rollback.bytes) {
      throw new ExtensionLibraryError("CORRUPT", "Retained Extension Library changed during rollback.");
    }

    const binding: StoredBinding = {
      ...rollback.selectedGrace.source,
      name: rollback.name,
      root: targetRoot,
      generation: rollback.bindingGeneration,
      identity: await captureExtensionLibraryRootIdentity(targetRoot),
      updatedAt: rollback.startedAt
    };
    const nextGrace: StoredGrace = {
      graceId: rollback.nextGraceId,
      extensionId: rollback.extensionId,
      name: rollback.current.name,
      phase: "ready",
      createdAt: rollback.startedAt,
      expiresAt: rollback.startedAt + GRACE_RETENTION_MS,
      root: rollback.nextGraceRoot,
      originalRoot: rollback.current.root,
      identity: await captureExtensionLibraryRootIdentity(rollback.nextGraceRoot),
      source: rollback.current,
      files: rollback.files,
      bytes: rollback.bytes
    };
    const previousState = this.#state;
    this.#state = reviseState(this.#state, {
      generations: replaceGeneration(this.#state.generations, binding.extensionId, binding.generation),
      bindings: replaceBinding(this.#state.bindings, binding),
      grace: [...this.#state.grace.filter((entry) => entry.graceId !== rollback.selectedGrace.graceId), nextGrace],
      rollbacks: this.#state.rollbacks.filter((entry) => entry.rollbackId !== rollback.rollbackId)
    });
    try {
      await this.#persistState();
    } catch (error) {
      this.#state = previousState;
      throw error;
    }
    return { binding, grace: nextGrace };
  }

  async #reconstructState(): Promise<StoredManagerState> {
    const bindings: StoredBinding[] = [];
    for (const entry of await readdir(this.#dataDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !EXTENSION_ID.test(entry.name)) continue;
      const root = join(this.#dataDirectory, entry.name);
      const vault = this.#createVault(root, entry.name);
      const status = await vault.open({ create: false });
      if (status.state === "unavailable") continue;
      bindings.push({
        extensionId: entry.name,
        name: entry.name,
        kind: "default",
        root,
        generation: "1",
        identity: await captureExtensionLibraryRootIdentity(root),
        updatedAt: this.#now()
      });
    }
    const state: StoredManagerState = {
      ...emptyState(),
      generations: bindings.map((binding) => ({ extensionId: binding.extensionId, generation: binding.generation })),
      bindings
    };
    return state;
  }

  #assertInitialized(): void {
    if (!this.#initialized || this.#closed) throw new ExtensionLibraryError("UNAVAILABLE", "Extension Library manager is not available.");
  }

  #assertReady(): void {
    this.#assertInitialized();
  }

  #assertStateAvailable(): void {
    if (this.#stateUnavailable) throw new ExtensionLibraryError("CORRUPT", "Extension Library control state is corrupt.");
  }

  #mutate<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#tail.catch(() => undefined).then(action);
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }
}

function emptyState(): StoredManagerState {
  return { format: 1, revision: "0", generations: [], bindings: [], trash: [], grace: [], migrations: [], rollbacks: [] };
}

function reviseState(state: StoredManagerState, changes: Partial<Omit<StoredManagerState, "format" | "revision">>): StoredManagerState {
  return { ...state, ...changes, revision: (BigInt(state.revision) + 1n).toString(10) };
}

function validateAuthority(authority: ExtensionLibraryAuthority): void {
  if (!EXTENSION_ID.test(authority.extensionId) || authority.extensionRevision < 1n || boundedName(authority.name) !== authority.name
    || authority.resourceId.length === 0 || authority.resourceRevision < 1n || authority.discoveredRevision.length === 0
    || authority.backendId.length === 0 || authority.backendRevision < 1n
    || !Number.isSafeInteger(authority.backendGeneration) || authority.backendGeneration < 1
    || authority.library.schemaVersion !== 1 || typeof authority.library.extensionEntry !== "string" || authority.library.extensionEntry.length === 0) {
    throw new ExtensionLibraryError("PATH_INVALID", "Extension Library authority is invalid.");
  }
}

function copyAuthority(authority: ExtensionLibraryAuthority): ExtensionLibraryAuthority {
  return {
    extensionId: authority.extensionId,
    extensionRevision: authority.extensionRevision,
    resourceId: authority.resourceId,
    resourceRevision: authority.resourceRevision,
    discoveredRevision: authority.discoveredRevision,
    backendId: authority.backendId,
    backendRevision: authority.backendRevision,
    backendGeneration: authority.backendGeneration,
    name: authority.name,
    library: { schemaVersion: 1, extensionEntry: authority.library.extensionEntry }
  };
}

function authorityKey(authority: ExtensionLibraryAuthority): string {
  return JSON.stringify([
    authority.extensionId,
    authority.extensionRevision.toString(10),
    authority.resourceId,
    authority.resourceRevision.toString(10),
    authority.discoveredRevision,
    authority.backendId,
    authority.backendRevision.toString(10),
    authority.backendGeneration,
    authority.library.schemaVersion,
    authority.library.extensionEntry
  ]);
}

function overviewFromStatus(
  authority: ExtensionLibraryAuthority,
  binding: StoredBinding,
  status: ExtensionLibraryStatus,
  state: StoredManagerState
): ExtensionLibraryOverview {
  return {
    extensionId: authority.extensionId,
    name: authority.name,
    state: status.state,
    ...(status.reason === undefined ? {} : { reason: status.reason }),
    location: { kind: binding.kind, path: binding.root, generation: BigInt(binding.generation) },
    usage: { files: status.usage.files, bytes: status.usage.bytes },
    ...(status.diskFreeBytes === undefined ? {} : { diskFreeBytes: status.diskFreeBytes }),
    softLimitBytes: status.softLimitBytes,
    softLimitExceeded: status.softLimitExceeded,
    orphaned: status.orphaned,
    trashCount: state.trash.filter((entry) => entry.extensionId === authority.extensionId).length,
    graceCount: state.grace.filter((entry) => entry.extensionId === authority.extensionId).length,
    ...(currentOperation(state, authority.extensionId) === undefined
      ? {}
      : { operation: currentOperation(state, authority.extensionId)! })
  };
}

function unavailableOverview(
  authority: ExtensionLibraryAuthority,
  state: StoredManagerState,
  reason: ExtensionLibraryOverview["reason"],
  binding?: StoredBinding
): ExtensionLibraryOverview {
  return {
    extensionId: authority.extensionId,
    name: authority.name,
    state: "unavailable",
    ...(reason === undefined ? {} : { reason }),
    ...(binding === undefined ? {} : { location: { kind: binding.kind, path: binding.root, generation: BigInt(binding.generation) } }),
    usage: { files: 0, bytes: 0 },
    softLimitBytes: EXTENSION_LIBRARY_LIMITS.softLimitBytes,
    softLimitExceeded: false,
    orphaned: false,
    trashCount: state.trash.filter((entry) => entry.extensionId === authority.extensionId).length,
    graceCount: state.grace.filter((entry) => entry.extensionId === authority.extensionId).length
  };
}

function pickOperation(migration: StoredMigration): { readonly id: string; readonly phase: StoredMigration["phase"] } {
  return { id: migration.migrationId, phase: migration.phase };
}

function currentOperation(
  state: StoredManagerState,
  extensionId: string
): { readonly id: string; readonly phase: StoredMigration["phase"] } | undefined {
  const migration = state.migrations.find((entry) => entry.extensionId === extensionId);
  if (migration !== undefined) return pickOperation(migration);
  const rollback = state.rollbacks.find((entry) => entry.extensionId === extensionId);
  return rollback === undefined ? undefined : { id: rollback.rollbackId, phase: "switching" };
}

function unavailableBinding(reason: "disk_missing" | "binding_moved"): ExtensionLibraryError {
  return new ExtensionLibraryError("UNAVAILABLE", reason === "disk_missing"
    ? "Extension Library disk or directory is missing."
    : "Extension Library binding moved or was replaced.");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer.`);
  return value;
}

function boundedName(value: string): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed === "" ? "" : trimmed.slice(0, 256);
}

async function assertCanonicalDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(path)) !== resolve(path)) {
    throw new ExtensionLibraryError("UNAVAILABLE", "Extension Library manager root identity is invalid.");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await atomicBytes(path, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}

async function atomicBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "EPERM" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readManagerRecord(path: string, maximumBytes = MANAGER_RECORD_MAXIMUM_BYTES): Promise<Buffer> {
  const expected = await lstat(path, { bigint: true });
  if (!expected.isFile() || expected.isSymbolicLink() || expected.size > BigInt(maximumBytes)) {
    throw new ExtensionLibraryError("CORRUPT", "Extension Library owner record is not a bounded regular file.");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!sameManagerFileSnapshot(expected, opened)) {
      throw new ExtensionLibraryError("CONFLICT", "Extension Library owner record changed while it was opened.");
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (offset !== bytes.byteLength || !sameManagerFileSnapshot(opened, after)
      || !sameManagerFileSnapshot(after, pathAfter)) {
      throw new ExtensionLibraryError("CONFLICT", "Extension Library owner record changed while it was read.");
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sameManagerObject(left: BigIntStats, right: BigIntStats): boolean {
  if (left.isFile() !== right.isFile() || left.isDirectory() !== right.isDirectory()
    || left.isSymbolicLink() !== right.isSymbolicLink() || left.dev !== right.dev) return false;
  if (left.ino !== 0n && right.ino !== 0n) return left.ino === right.ino;
  return left.ino === 0n && right.ino === 0n && left.birthtimeNs !== 0n && left.birthtimeNs === right.birthtimeNs;
}

function sameManagerFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile() && sameManagerObject(left, right)
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function validateState(value: unknown): StoredManagerState {
  if (!plainObject(value) || !exactKeys(value, ["format", "revision", "generations", "bindings", "trash", "grace", "migrations", "rollbacks"])
    || value.format !== 1 || typeof value.revision !== "string" || !REVISION.test(value.revision)
    || !Array.isArray(value.generations) || !Array.isArray(value.bindings) || !Array.isArray(value.trash)
    || !Array.isArray(value.grace) || !Array.isArray(value.migrations) || !Array.isArray(value.rollbacks)) {
    throw new ExtensionLibraryError("CORRUPT", "Extension Library control state is malformed.");
  }
  const generations = value.generations.map(validateGeneration);
  const bindings = value.bindings.map(validateBinding);
  const trash = value.trash.map(validateTrash);
  const grace = value.grace.map(validateGrace);
  const migrations = value.migrations.map(validateMigration);
  const rollbacks = value.rollbacks.map(validateRollback);
  unique(generations.map((entry) => entry.extensionId), "Extension Library generations");
  unique(bindings.map((entry) => entry.extensionId), "Extension Library bindings");
  unique(trash.map((entry) => entry.trashId), "Extension Library trash");
  unique(grace.map((entry) => entry.graceId), "Extension Library grace copies");
  unique(migrations.map((entry) => entry.extensionId), "Extension Library migrations");
  unique(rollbacks.map((entry) => entry.rollbackId), "Extension Library rollbacks");
  unique(rollbacks.map((entry) => entry.extensionId), "Extension Library rollback owners");
  return { format: 1, revision: value.revision, generations, bindings, trash, grace, migrations, rollbacks };
}

function validateGeneration(value: unknown): StoredGeneration {
  if (!plainObject(value) || !exactKeys(value, ["extensionId", "generation"])
    || typeof value.extensionId !== "string" || !EXTENSION_ID.test(value.extensionId)
    || typeof value.generation !== "string" || !REVISION.test(value.generation) || value.generation === "0") {
    throw new ExtensionLibraryError("CORRUPT", "Extension Library generation record is malformed.");
  }
  return { extensionId: value.extensionId, generation: value.generation };
}

function validateBinding(value: unknown): StoredBinding {
  if (!plainObject(value) || !exactKeys(value, ["extensionId", "name", "kind", "root", "generation", "identity", "updatedAt"])
    || typeof value.extensionId !== "string" || !EXTENSION_ID.test(value.extensionId)
    || typeof value.name !== "string" || boundedName(value.name) !== value.name
    || value.kind !== "default" && value.kind !== "custom"
    || typeof value.root !== "string" || !isAbsolute(value.root) || resolve(value.root) !== value.root
    || typeof value.generation !== "string" || !REVISION.test(value.generation) || value.generation === "0"
    || !finiteTimestamp(value.updatedAt)) throw new ExtensionLibraryError("CORRUPT", "Extension Library binding is malformed.");
  return {
    extensionId: value.extensionId,
    name: value.name,
    kind: value.kind,
    root: value.root,
    generation: value.generation,
    identity: validateIdentity(value.identity),
    updatedAt: value.updatedAt
  };
}

function validateTrash(value: unknown): StoredTrash {
  if (!plainObject(value) || !exactKeys(value, ["trashId", "extensionId", "name", "deletedAt", "expiresAt", "root", "identity", "source", "files", "bytes"])
    || typeof value.trashId !== "string" || !TRASH_ID.test(value.trashId)
    || typeof value.extensionId !== "string" || !EXTENSION_ID.test(value.extensionId)
    || typeof value.name !== "string" || boundedName(value.name) !== value.name
    || !finiteTimestamp(value.deletedAt) || !finiteTimestamp(value.expiresAt) || value.expiresAt - value.deletedAt !== TRASH_RETENTION_MS
    || typeof value.root !== "string" || !isAbsolute(value.root) || resolve(value.root) !== value.root
    || !nonnegativeInteger(value.files) || !nonnegativeInteger(value.bytes)) {
    throw new ExtensionLibraryError("CORRUPT", "Extension Library trash record is malformed.");
  }
  return {
    trashId: value.trashId,
    extensionId: value.extensionId,
    name: value.name,
    deletedAt: value.deletedAt,
    expiresAt: value.expiresAt,
    root: value.root,
    identity: validateIdentity(value.identity),
    source: validateBinding(value.source),
    files: value.files,
    bytes: value.bytes
  };
}

function validateGrace(value: unknown): StoredGrace {
  if (!plainObject(value) || !exactKeys(value, ["graceId", "extensionId", "name", "phase", "createdAt", "expiresAt", "root", "originalRoot", "identity", "source", "files", "bytes"])
    || typeof value.graceId !== "string" || !GRACE_ID.test(value.graceId)
    || typeof value.extensionId !== "string" || !EXTENSION_ID.test(value.extensionId)
    || typeof value.name !== "string" || boundedName(value.name) !== value.name
    || value.phase !== "ready" && value.phase !== "purging"
    || !finiteTimestamp(value.createdAt) || !finiteTimestamp(value.expiresAt) || value.expiresAt - value.createdAt !== GRACE_RETENTION_MS
    || typeof value.root !== "string" || !isAbsolute(value.root) || resolve(value.root) !== value.root
    || typeof value.originalRoot !== "string" || !isAbsolute(value.originalRoot) || resolve(value.originalRoot) !== value.originalRoot
    || !nonnegativeInteger(value.files) || !nonnegativeInteger(value.bytes)) {
    throw new ExtensionLibraryError("CORRUPT", "Extension Library grace record is malformed.");
  }
  return {
    graceId: value.graceId,
    extensionId: value.extensionId,
    name: value.name,
    phase: value.phase,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    root: value.root,
    originalRoot: value.originalRoot,
    identity: validateIdentity(value.identity),
    source: validateBinding(value.source),
    files: value.files,
    bytes: value.bytes
  };
}

function validateMigration(value: unknown): StoredMigration {
  if (!plainObject(value) || !exactKeys(value, ["migrationId", "graceId", "extensionId", "name", "phase", "source", "targetKind", "targetRoot", "stagingRoot", "startedAt", "warnings", "files", "bytes"])
    || typeof value.migrationId !== "string" || !MIGRATION_ID.test(value.migrationId)
    || typeof value.graceId !== "string" || !GRACE_ID.test(value.graceId)
    || typeof value.extensionId !== "string" || !EXTENSION_ID.test(value.extensionId)
    || typeof value.name !== "string" || boundedName(value.name) !== value.name
    || !["precheck", "copying", "verifying", "switching"].includes(value.phase as string)
    || value.targetKind !== "default" && value.targetKind !== "custom"
    || typeof value.targetRoot !== "string" || !isAbsolute(value.targetRoot) || resolve(value.targetRoot) !== value.targetRoot
    || typeof value.stagingRoot !== "string" || !isAbsolute(value.stagingRoot) || resolve(value.stagingRoot) !== value.stagingRoot
    || !finiteTimestamp(value.startedAt) || !Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== "string")
    || !nonnegativeInteger(value.files) || !nonnegativeInteger(value.bytes)) {
    throw new ExtensionLibraryError("CORRUPT", "Extension Library migration record is malformed.");
  }
  return {
    migrationId: value.migrationId,
    graceId: value.graceId,
    extensionId: value.extensionId,
    name: value.name,
    phase: value.phase as StoredMigration["phase"],
    source: validateBinding(value.source),
    targetKind: value.targetKind,
    targetRoot: value.targetRoot,
    stagingRoot: value.stagingRoot,
    startedAt: value.startedAt,
    warnings: value.warnings as string[],
    files: value.files,
    bytes: value.bytes
  };
}

function validateRollback(value: unknown): StoredRollback {
  if (!plainObject(value) || !exactKeys(value, [
    "rollbackId", "extensionId", "name", "current", "selectedGrace", "nextGraceId", "nextGraceRoot",
    "bindingGeneration", "startedAt", "files", "bytes"
  ]) || typeof value.rollbackId !== "string" || !ROLLBACK_ID.test(value.rollbackId)
    || typeof value.extensionId !== "string" || !EXTENSION_ID.test(value.extensionId)
    || typeof value.name !== "string" || boundedName(value.name) !== value.name
    || typeof value.nextGraceId !== "string" || !GRACE_ID.test(value.nextGraceId)
    || typeof value.nextGraceRoot !== "string" || !isAbsolute(value.nextGraceRoot) || resolve(value.nextGraceRoot) !== value.nextGraceRoot
    || typeof value.bindingGeneration !== "string" || !REVISION.test(value.bindingGeneration) || value.bindingGeneration === "0"
    || !finiteTimestamp(value.startedAt) || !nonnegativeInteger(value.files) || !nonnegativeInteger(value.bytes)) {
    throw new ExtensionLibraryError("CORRUPT", "Extension Library rollback record is malformed.");
  }
  const current = validateBinding(value.current);
  const selectedGrace = validateGrace(value.selectedGrace);
  if (current.extensionId !== value.extensionId || selectedGrace.extensionId !== value.extensionId
    || selectedGrace.phase !== "ready" || BigInt(value.bindingGeneration) <= BigInt(current.generation)) {
    throw new ExtensionLibraryError("CORRUPT", "Extension Library rollback authority is malformed.");
  }
  return {
    rollbackId: value.rollbackId,
    extensionId: value.extensionId,
    name: value.name,
    current,
    selectedGrace,
    nextGraceId: value.nextGraceId,
    nextGraceRoot: value.nextGraceRoot,
    bindingGeneration: value.bindingGeneration,
    startedAt: value.startedAt,
    files: value.files,
    bytes: value.bytes
  };
}

function validateIdentity(value: unknown): ExtensionLibraryRootIdentity {
  if (!plainObject(value) || !exactKeys(value, ["canonicalPath", "device", "inode", "birthtimeMs"])
    || typeof value.canonicalPath !== "string" || !isAbsolute(value.canonicalPath) || resolve(value.canonicalPath) !== value.canonicalPath
    || typeof value.device !== "string" || !REVISION.test(value.device)
    || typeof value.inode !== "string" || !REVISION.test(value.inode)
    || typeof value.birthtimeMs !== "number" || !Number.isFinite(value.birthtimeMs) || value.birthtimeMs < 0) {
    throw new ExtensionLibraryError("CORRUPT", "Extension Library filesystem identity is malformed.");
  }
  return { canonicalPath: value.canonicalPath, device: value.device, inode: value.inode, birthtimeMs: value.birthtimeMs };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key)) && allowed.every((key) => key in value);
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new ExtensionLibraryError("CORRUPT", `${label} contain duplicate identities.`);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function increment(value: string): string {
  const next = BigInt(value) + 1n;
  if (next > BigInt(Number.MAX_SAFE_INTEGER)) throw new ExtensionLibraryError("CONFLICT", "Extension Library generation is exhausted.");
  return next.toString(10);
}

function replaceBinding(bindings: readonly StoredBinding[], binding: StoredBinding): readonly StoredBinding[] {
  return [...bindings.filter((entry) => entry.extensionId !== binding.extensionId), binding];
}

function replaceGeneration(
  generations: readonly StoredGeneration[],
  extensionId: string,
  generation: string
): readonly StoredGeneration[] {
  const current = generations.find((entry) => entry.extensionId === extensionId);
  const effective = current !== undefined && BigInt(current.generation) > BigInt(generation)
    ? current.generation
    : generation;
  return [...generations.filter((entry) => entry.extensionId !== extensionId), { extensionId, generation: effective }];
}

function publicTrash(record: StoredTrash): ExtensionLibraryTrashEntry {
  return {
    trashId: record.trashId,
    extensionId: record.extensionId,
    name: record.name,
    deletedAt: record.deletedAt,
    expiresAt: record.expiresAt,
    files: record.files,
    bytes: record.bytes
  };
}

function publicGrace(record: StoredGrace): ExtensionLibraryGraceEntry {
  return {
    graceId: record.graceId,
    extensionId: record.extensionId,
    name: record.name,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    files: record.files,
    bytes: record.bytes
  };
}

function graceRootFor(migration: StoredMigration, graceId: string): string {
  return `${migration.source.root}.joko-grace-${migration.startedAt}-${graceId.slice(-32)}`;
}

function rollbackGraceRootFor(rollback: StoredRollback): string {
  return `${rollback.current.root}.joko-grace-${rollback.startedAt}-${rollback.nextGraceId.slice(-32)}`;
}

function restoreStagingRoot(targetRoot: string, trashId: string): string {
  return join(dirname(targetRoot), `.joko-library-restore-${basename(targetRoot)}-${trashId.slice(-32)}`);
}

function sameBinding(left: StoredBinding, right: StoredBinding): boolean {
  return left.extensionId === right.extensionId && left.name === right.name && left.kind === right.kind
    && left.root === right.root && left.generation === right.generation && left.updatedAt === right.updatedAt
    && left.identity.canonicalPath === right.identity.canonicalPath && left.identity.device === right.identity.device
    && left.identity.inode === right.identity.inode && left.identity.birthtimeMs === right.identity.birthtimeMs;
}

function sameGrace(left: StoredGrace, right: StoredGrace): boolean {
  return left.graceId === right.graceId && left.extensionId === right.extensionId && left.name === right.name
    && left.phase === right.phase && left.createdAt === right.createdAt && left.expiresAt === right.expiresAt
    && left.root === right.root && left.originalRoot === right.originalRoot && left.files === right.files
    && left.bytes === right.bytes && sameBinding(left.source, right.source)
    && left.identity.canonicalPath === right.identity.canonicalPath && left.identity.device === right.identity.device
    && left.identity.inode === right.identity.inode && left.identity.birthtimeMs === right.identity.birthtimeMs;
}

function sameRollback(left: StoredRollback, right: StoredRollback): boolean {
  return left.rollbackId === right.rollbackId && left.extensionId === right.extensionId && left.name === right.name
    && left.nextGraceId === right.nextGraceId && left.nextGraceRoot === right.nextGraceRoot
    && left.bindingGeneration === right.bindingGeneration && left.startedAt === right.startedAt
    && left.files === right.files && left.bytes === right.bytes && sameBinding(left.current, right.current)
    && sameGrace(left.selectedGrace, right.selectedGrace);
}

function identityAt(identity: ExtensionLibraryRootIdentity, root: string): ExtensionLibraryRootIdentity {
  return { ...identity, canonicalPath: resolve(root) };
}

function validStagingPath(migration: StoredMigration): boolean {
  return dirname(migration.stagingRoot) === dirname(migration.targetRoot)
    && basename(migration.stagingRoot) === `.joko-library-migrate-${migration.extensionId}-${migration.migrationId.slice(-32)}`;
}

async function canonicalIfPresent(path: string): Promise<string> {
  try {
    return resolve(await realpath(path));
  } catch (error) {
    if (missing(error)) return resolve(path);
    throw error;
  }
}

function inside(root: string, target: string): boolean {
  const base = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
  const value = process.platform === "win32" ? resolve(target).toLowerCase() : resolve(target);
  return value === base || value.startsWith(`${base}${sep}`);
}

function validateTrashManifest(value: unknown): TrashManifest {
  if (!plainObject(value) || value.format !== 1
    || !["moving", "ready", "restoring", "purging"].includes(value.phase as string)) {
    throw new ExtensionLibraryError("CORRUPT", "Extension Library trash manifest is malformed.");
  }
  if (value.phase === "ready") {
    if (!exactKeys(value, ["format", "phase", "record"])) throw new ExtensionLibraryError("CORRUPT", "Extension Library trash manifest is malformed.");
    return { format: 1, phase: "ready", record: validateTrash(value.record) };
  }
  if (value.phase === "purging") {
    if (!exactKeys(value, ["format", "phase", "record"])) throw new ExtensionLibraryError("CORRUPT", "Extension Library trash manifest is malformed.");
    return { format: 1, phase: "purging", record: validateTrash(value.record) };
  }
  if (value.phase === "restoring") {
    if (!exactKeys(value, [
      "format", "phase", "record", "destinationKind", "targetRoot", "stagingRoot", "bindingGeneration", "updatedAt"
    ]) || value.destinationKind !== "default" && value.destinationKind !== "custom"
      || typeof value.targetRoot !== "string" || !isAbsolute(value.targetRoot) || resolve(value.targetRoot) !== value.targetRoot
      || typeof value.stagingRoot !== "string" || !isAbsolute(value.stagingRoot) || resolve(value.stagingRoot) !== value.stagingRoot
      || typeof value.bindingGeneration !== "string" || !REVISION.test(value.bindingGeneration) || value.bindingGeneration === "0"
      || !finiteTimestamp(value.updatedAt)) {
      throw new ExtensionLibraryError("CORRUPT", "Extension Library restoring-trash manifest is malformed.");
    }
    return {
      format: 1,
      phase: "restoring",
      record: validateTrash(value.record),
      destinationKind: value.destinationKind,
      targetRoot: value.targetRoot,
      stagingRoot: value.stagingRoot,
      bindingGeneration: value.bindingGeneration,
      updatedAt: value.updatedAt
    };
  }
  if (!exactKeys(value, ["format", "phase", "trashId", "source", "targetRoot", "deletedAt", "expiresAt", "files", "bytes"])
    || typeof value.trashId !== "string" || !TRASH_ID.test(value.trashId)
    || typeof value.targetRoot !== "string" || !isAbsolute(value.targetRoot) || resolve(value.targetRoot) !== value.targetRoot
    || !finiteTimestamp(value.deletedAt) || !finiteTimestamp(value.expiresAt) || value.expiresAt - value.deletedAt !== TRASH_RETENTION_MS
    || !nonnegativeInteger(value.files) || !nonnegativeInteger(value.bytes)) {
    throw new ExtensionLibraryError("CORRUPT", "Extension Library moving-trash manifest is malformed.");
  }
  return {
    format: 1,
    phase: "moving",
    trashId: value.trashId,
    source: validateBinding(value.source),
    targetRoot: value.targetRoot,
    deletedAt: value.deletedAt,
    expiresAt: value.expiresAt,
    files: value.files,
    bytes: value.bytes
  };
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
