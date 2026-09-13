import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, readFileSync } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { OperationalStore } from "@joko/store";

import { inspectPiPackageCatalog } from "./pi-package-compatibility.js";

export type ExtensionSourceInput =
  | { readonly kind: "local"; readonly path: string }
  | {
      readonly kind: "git";
      readonly repositoryUrl: string;
      readonly ref?: string;
      readonly sparsePaths: readonly string[];
    };

export type ExtensionSourceState = "ready" | "error";

export interface ExtensionSourceEntryDescriptor {
  readonly id: string;
  readonly revision: string;
  readonly contentRevision: string;
  readonly packageContentRevision: string;
  readonly resourceId: string;
  readonly packageRelativePath: string;
  readonly extensionRelativePath: string;
  readonly bindingName: string;
  readonly bindingOrdinal: number;
  readonly name: string;
  readonly packageName: string;
  readonly version?: string;
  readonly author?: string;
  readonly description: string;
}

export interface ExtensionSourceDescriptor {
  readonly id: string;
  readonly revision: bigint;
  readonly source: ExtensionSourceInput;
  readonly sourceIdentity: string;
  readonly sourceDisplay: string;
  readonly name: string;
  readonly displayName?: string;
  readonly state: ExtensionSourceState;
  readonly contentRevision: string;
  readonly entries: readonly ExtensionSourceEntryDescriptor[];
  readonly declaredEntryCount: number;
  readonly skippedEntryCount: number;
  readonly unreadableEntryCount: number;
  readonly addedAt: number;
  readonly refreshedAt?: number;
  readonly error?: string;
}

export interface ExtensionSourceSnapshot {
  readonly revision: bigint;
  readonly sources: readonly ExtensionSourceDescriptor[];
  readonly recoveredFromCorruption: boolean;
}

export interface ExtensionSourceGitPreflight {
  readonly available: boolean;
  readonly version?: string;
  readonly minimumVersion: string;
}

export interface ExtensionSourceManagerOptions {
  readonly store: OperationalStore;
  readonly cacheRoot: string;
  readonly scopeId?: string;
  readonly homeDirectory?: string;
  readonly now?: () => number;
  readonly git?: ExtensionSourceGitExecutor;
  readonly inspectPackageCatalog?: typeof inspectPiPackageCatalog;
}

export interface ExtensionSourceGitResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type ExtensionSourceGitExecutor = (
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs: number }
) => Promise<ExtensionSourceGitResult>;

export type ExtensionSourceErrorCode =
  | "SOURCE_INVALID"
  | "SOURCE_CREDENTIALS_FORBIDDEN"
  | "SOURCE_GIT_UNAVAILABLE"
  | "SOURCE_GIT_AUTH_FAILED"
  | "SOURCE_GIT_REF_NOT_FOUND"
  | "SOURCE_GIT_FAILED"
  | "SOURCE_MANIFEST_MISSING"
  | "SOURCE_MANIFEST_INVALID"
  | "SOURCE_DUPLICATE"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_CHANGED";

export class ExtensionSourceError extends Error {
  constructor(readonly code: ExtensionSourceErrorCode, message: string) {
    super(message);
    this.name = "ExtensionSourceError";
  }
}

interface StoredExtensionSourceEntry extends ExtensionSourceEntryDescriptor {}

interface StoredExtensionSource {
  readonly id: string;
  readonly revision: string;
  readonly source: ExtensionSourceInput;
  readonly sourceIdentity: string;
  readonly sourceDisplay: string;
  readonly name: string;
  readonly displayName?: string;
  readonly state: ExtensionSourceState;
  readonly contentRevision: string;
  readonly entries: readonly StoredExtensionSourceEntry[];
  readonly declaredEntryCount: number;
  readonly skippedEntryCount: number;
  readonly unreadableEntryCount: number;
  readonly addedAt: number;
  readonly refreshedAt?: number;
  readonly activeGeneration?: string;
  readonly error?: string;
}

interface StoredExtensionSources {
  readonly format: 1;
  readonly revision: string;
  readonly sources: readonly StoredExtensionSource[];
}

interface DiscoveryResult {
  readonly name: string;
  readonly displayName?: string;
  readonly contentRevision: string;
  readonly entries: readonly StoredExtensionSourceEntry[];
  readonly declaredEntryCount: number;
  readonly skippedEntryCount: number;
  readonly unreadableEntryCount: number;
}

interface RawMarketplaceManifest {
  readonly name?: unknown;
  readonly displayName?: unknown;
  readonly plugins?: unknown;
}

const SOURCE_SETTING_KEY = "extension_sources";
const SOURCE_ID = /^extension_source_[a-f0-9]{32}$/u;
const ENTRY_ID = /^extension_source_entry_[a-f0-9]{32}$/u;
const RESOURCE_ID = /^resource_market_[a-f0-9]{32}$/u;
const DECIMAL_REVISION = /^(?:0|[1-9][0-9]*)$/u;
const CONTENT_REVISION = /^sha256:[a-f0-9]{64}$/u;
const GIT_REVISION = /^[a-f0-9]{7,64}$/iu;
const GENERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GIT_REF = /^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const GITHUB_SHORTHAND = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;
const SAFE_GIT_URL = /^(?:https:\/\/|ssh:\/\/|git@)[^\s]+$/iu;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const MARKETPLACE_MANIFEST = join(".agents", "plugins", "marketplace.json");
const MANIFEST_MAXIMUM_BYTES = 1024 * 1024;
const MAXIMUM_DECLARED_ENTRIES = 512;
const MAXIMUM_DISCOVERED_EXTENSIONS = 2_048;
const MAXIMUM_DISCOVERY_NODES = 25_000;
const MAXIMUM_DISCOVERY_BYTES = 256 * 1024 * 1024;
const MAXIMUM_DISCOVERY_DURATION_MS = 30_000;
const MAXIMUM_NAME_CHARACTERS = 128;
const MINIMUM_GIT_VERSION = { major: 2, minor: 25 } as const;
const GIT_OPERATION_TIMEOUT_MS = 5 * 60_000;
const SOURCE_FAILURE_MAXIMUM_CHARACTERS = 512;

const defaultGitExecutor: ExtensionSourceGitExecutor = (args, options) => new Promise((resolvePromise, reject) => {
  execFile("git", ["-c", "core.longpaths=true", ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    timeout: options.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      LC_ALL: "C"
    }
  }, (error, stdout, stderr) => {
    if (error !== null) {
      reject(Object.assign(error, { stderr }));
      return;
    }
    resolvePromise({ stdout, stderr });
  });
});

/** Current-v1 parser. It performs no network or filesystem access and never
 * returns an input containing URL credentials. */
export function normalizeExtensionSourceInput(
  input: ExtensionSourceInput,
  homeDirectory = homedir()
): ExtensionSourceInput {
  if (input.kind === "local") {
    const raw = input.path.trim();
    if (raw === "" || FORBIDDEN_TEXT.test(raw)) throw new ExtensionSourceError("SOURCE_INVALID", "Local source path is invalid.");
    const expanded = raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")
      ? join(homeDirectory, raw.slice(1).replace(/^[/\\]/u, ""))
      : raw;
    return { kind: "local", path: resolve(expanded) };
  }
  let repositoryUrl = input.repositoryUrl.trim();
  if (GITHUB_SHORTHAND.test(repositoryUrl)) repositoryUrl = `https://github.com/${repositoryUrl}.git`;
  if (repositoryUrl === "" || FORBIDDEN_TEXT.test(repositoryUrl) || repositoryUrl.includes("\\") || !SAFE_GIT_URL.test(repositoryUrl)) {
    throw new ExtensionSourceError("SOURCE_INVALID", "Git source URL is invalid.");
  }
  if (gitUrlContainsCredential(repositoryUrl)) {
    throw new ExtensionSourceError("SOURCE_CREDENTIALS_FORBIDDEN", "Git source URLs cannot contain credentials, query parameters, or fragments.");
  }
  const ref = input.ref?.trim();
  if (ref !== undefined && !isValidGitRef(ref)) {
    throw new ExtensionSourceError("SOURCE_INVALID", "Git source ref is invalid.");
  }
  if (!Array.isArray(input.sparsePaths) || input.sparsePaths.length > 64) {
    throw new ExtensionSourceError("SOURCE_INVALID", "Git sparse path list is invalid.");
  }
  const sparsePaths = input.sparsePaths.map((value) => normalizeSparsePath(value));
  if (new Set(sparsePaths).size !== sparsePaths.length) throw new ExtensionSourceError("SOURCE_INVALID", "Git sparse paths must be unique.");
  return {
    kind: "git",
    repositoryUrl,
    ...(ref === undefined ? {} : { ref }),
    sparsePaths
  };
}

export function extensionSourceIdentity(source: ExtensionSourceInput): string {
  return JSON.stringify(source.kind === "local"
    ? ["local", source.path]
    : ["git", source.repositoryUrl, source.ref ?? null, [...source.sparsePaths]]);
}

/** Owner for user-added Extension sources and immutable discovery generations. */
export class ExtensionSourceManager {
  readonly #store: OperationalStore;
  readonly #cacheRoot: string;
  readonly #scopeId: string;
  readonly #homeDirectory: string;
  readonly #now: () => number;
  readonly #git: ExtensionSourceGitExecutor;
  readonly #inspectPackageCatalog: typeof inspectPiPackageCatalog;
  readonly #records = new Map<string, StoredExtensionSource>();
  #catalogRevision = 0n;
  #initialized = false;
  #recoveredFromCorruption = false;
  #mutationTail: Promise<unknown> = Promise.resolve();

  constructor(options: ExtensionSourceManagerOptions) {
    this.#store = options.store;
    this.#cacheRoot = resolve(options.cacheRoot);
    this.#scopeId = options.scopeId ?? "orchestrator";
    this.#homeDirectory = options.homeDirectory ?? homedir();
    this.#now = options.now ?? Date.now;
    this.#git = options.git ?? defaultGitExecutor;
    this.#inspectPackageCatalog = options.inspectPackageCatalog ?? inspectPiPackageCatalog;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.#cacheRoot, { recursive: true });
    const stored = this.#store.findSetting<unknown>("service", this.#scopeId, SOURCE_SETTING_KEY);
    if (stored !== undefined) {
      try {
        const value = validateStoredSources(stored.value);
        this.#catalogRevision = BigInt(value.revision);
        for (const raw of value.sources) {
          const record = validateStoredSource(raw);
          if (this.#records.has(record.id)) throw new Error("Extension sources contain duplicate IDs.");
          if ([...this.#records.values()].some((candidate) => candidate.name === record.name || candidate.sourceIdentity === record.sourceIdentity)) {
            throw new Error("Extension sources contain duplicate identities.");
          }
          this.#records.set(record.id, record);
        }
        const audited = await this.#auditStoredSources();
        if (audited !== undefined) {
          this.#persist(audited, this.#catalogRevision + 1n);
          this.#replaceState(audited, this.#catalogRevision + 1n);
        }
      } catch {
        this.#records.clear();
        this.#catalogRevision = 0n;
        this.#recoveredFromCorruption = true;
        this.#persist(this.#records, 0n);
      }
    }
    this.#initialized = true;
  }

  snapshot(): ExtensionSourceSnapshot {
    this.#assertInitialized();
    return {
      revision: this.#catalogRevision,
      sources: [...this.#records.values()]
        .sort((left, right) => left.name.localeCompare(right.name, "en") || left.id.localeCompare(right.id, "en"))
        .map(publicSource),
      recoveredFromCorruption: this.#recoveredFromCorruption
    };
  }

  get(sourceId: string): ExtensionSourceDescriptor {
    this.#assertInitialized();
    return publicSource(this.#requireSource(sourceId));
  }

  async auditAvailability(): Promise<ExtensionSourceSnapshot> {
    return this.#mutate(async () => {
      this.#assertInitialized();
      const audited = await this.#auditStoredSources();
      if (audited !== undefined) {
        this.#persist(audited, this.#catalogRevision + 1n);
        this.#replaceState(audited, this.#catalogRevision + 1n);
      }
      return this.snapshot();
    });
  }

  async gitPreflight(): Promise<ExtensionSourceGitPreflight> {
    const version = await gitVersion(this.#git);
    return {
      available: version !== undefined && supportsGitVersion(version),
      ...(version === undefined ? {} : { version: `${version.major}.${version.minor}.${version.patch}` }),
      minimumVersion: `${MINIMUM_GIT_VERSION.major}.${MINIMUM_GIT_VERSION.minor}`
    };
  }

  async add(input: ExtensionSourceInput, expectedCatalogRevision: bigint): Promise<ExtensionSourceDescriptor> {
    return this.#mutate(async () => {
      this.#assertCatalogRevision(expectedCatalogRevision);
      let source = normalizeExtensionSourceInput(input, this.#homeDirectory);
      if (source.kind === "local") {
        const canonical = await canonicalDirectory(source.path, "Extension source");
        source = { kind: "local", path: canonical };
      } else {
        const preflight = await this.gitPreflight();
        if (!preflight.available) throw new ExtensionSourceError("SOURCE_GIT_UNAVAILABLE", `Git ${preflight.minimumVersion} or newer is required.`);
      }
      const sourceIdentity = extensionSourceIdentity(source);
      if ([...this.#records.values()].some((record) => record.sourceIdentity === sourceIdentity)) {
        throw new ExtensionSourceError("SOURCE_DUPLICATE", "This Extension source is already configured.");
      }
      const id = `extension_source_${createHash("sha256").update(`${sourceIdentity}\0${randomUUID()}`).digest("hex").slice(0, 32)}`;
      const acquired = source.kind === "local"
        ? { root: source.path, revision: undefined, generation: undefined }
        : await this.#acquireGitGeneration(id, source);
      try {
        const discovered = await discoverMarketplace(acquired.root, id, sourceIdentity, acquired.revision, this.#inspectPackageCatalog);
        if ([...this.#records.values()].some((record) => record.name === discovered.name)) {
          throw new ExtensionSourceError("SOURCE_DUPLICATE", "An Extension source with this manifest name already exists.");
        }
        const now = this.#now();
        const record: StoredExtensionSource = {
          id,
          revision: "1",
          source,
          sourceIdentity,
          sourceDisplay: sourceDisplay(source),
          name: discovered.name,
          ...(discovered.displayName === undefined ? {} : { displayName: discovered.displayName }),
          state: "ready",
          contentRevision: discovered.contentRevision,
          entries: discovered.entries,
          declaredEntryCount: discovered.declaredEntryCount,
          skippedEntryCount: discovered.skippedEntryCount,
          unreadableEntryCount: discovered.unreadableEntryCount,
          addedAt: now,
          refreshedAt: now,
          ...(acquired.generation === undefined ? {} : { activeGeneration: acquired.generation })
        };
        if (source.kind === "git") await this.#writeCurrentGeneration(record, acquired.generation!);
        const next = new Map(this.#records).set(id, record);
        try {
          this.#persist(next, this.#catalogRevision + 1n);
        } catch (error) {
          if (source.kind === "git") await removeCachedPath(this.#slot(record), () => false);
          throw error;
        }
        this.#replaceState(next, this.#catalogRevision + 1n);
        return publicSource(record);
      } catch (error) {
        if (source.kind === "git") await removeCachedPath(this.#slotFor(id, sourceIdentity), () => false).catch(() => undefined);
        throw normalizeSourceError(error);
      }
    });
  }

  async refresh(sourceId: string, expectedRevision: bigint): Promise<ExtensionSourceDescriptor> {
    return this.#mutate(async () => {
      const current = this.#requireSourceRevision(sourceId, expectedRevision);
      let acquired: { root: string; revision?: string; generation?: string } | undefined;
      let publicationFailed = false;
      try {
        acquired = current.source.kind === "local"
          ? { root: await canonicalDirectory(current.source.path, "Extension source") }
          : await this.#acquireGitGeneration(current.id, current.source);
        const discovered = await discoverMarketplace(acquired.root, current.id, current.sourceIdentity, acquired.revision, this.#inspectPackageCatalog);
        const duplicate = [...this.#records.values()].find((record) => record.id !== current.id && record.name === discovered.name);
        if (duplicate !== undefined) throw new ExtensionSourceError("SOURCE_DUPLICATE", "An Extension source with this manifest name already exists.");
        const {
          displayName: _previousDisplayName,
          activeGeneration: _previousActiveGeneration,
          error: _previousError,
          ...currentBase
        } = current;
        const nextRecord: StoredExtensionSource = {
          ...currentBase,
          revision: increment(current.revision),
          name: discovered.name,
          ...(discovered.displayName === undefined ? {} : { displayName: discovered.displayName }),
          state: "ready",
          contentRevision: discovered.contentRevision,
          entries: discovered.entries,
          declaredEntryCount: discovered.declaredEntryCount,
          skippedEntryCount: discovered.skippedEntryCount,
          unreadableEntryCount: discovered.unreadableEntryCount,
          refreshedAt: this.#now(),
          ...(acquired.generation === undefined ? {} : { activeGeneration: acquired.generation }),
        };
        const oldGeneration = current.activeGeneration;
        if (current.source.kind === "git") await this.#writeCurrentGeneration(nextRecord, acquired.generation!);
        const next = new Map(this.#records).set(current.id, nextRecord);
        try {
          this.#persist(next, this.#catalogRevision + 1n);
        } catch (error) {
          publicationFailed = true;
          if (current.source.kind === "git") {
            if (oldGeneration !== undefined) await this.#writeCurrentGeneration(current, oldGeneration);
            await removeCachedPath(acquired.root, () => false).catch(() => undefined);
          }
          throw error;
        }
        this.#replaceState(next, this.#catalogRevision + 1n);
        if (current.source.kind === "git" && oldGeneration !== undefined && oldGeneration !== acquired.generation) {
          void removeCachedPath(join(this.#slot(current), "versions", oldGeneration), () => this.#isCurrentGeneration(current.id, oldGeneration));
        }
        return publicSource(nextRecord);
      } catch (error) {
        if (acquired?.generation !== undefined) await removeCachedPath(acquired.root, () => false).catch(() => undefined);
        if (publicationFailed) throw error;
        const normalized = normalizeSourceError(error);
        if (normalized.code === "SOURCE_CHANGED" || normalized.code === "SOURCE_NOT_FOUND") throw normalized;
        const failed: StoredExtensionSource = {
          ...current,
          revision: increment(current.revision),
          state: "error",
          error: boundedFailure(normalized.message),
          refreshedAt: this.#now()
        };
        const next = new Map(this.#records).set(current.id, failed);
        this.#persist(next, this.#catalogRevision + 1n);
        this.#replaceState(next, this.#catalogRevision + 1n);
        throw normalized;
      }
    });
  }

  async remove(sourceId: string, expectedRevision: bigint): Promise<void> {
    return this.#mutate(async () => {
      const current = this.#requireSourceRevision(sourceId, expectedRevision);
      const next = new Map(this.#records);
      next.delete(current.id);
      this.#persist(next, this.#catalogRevision + 1n);
      this.#replaceState(next, this.#catalogRevision + 1n);
      if (current.source.kind === "git") {
        void removeCachedPath(this.#slot(current), () => this.#records.has(current.id)
          || [...this.#records.values()].some((record) => record.sourceIdentity === current.sourceIdentity)).catch(() => undefined);
      }
    });
  }

  /** Exact generation lease used by the following install slice. It is public
   * now so source refresh/remove already obey the reader boundary. */
  async withEntry<T>(input: {
    readonly sourceId: string;
    readonly sourceRevision: bigint;
    readonly entryId: string;
    readonly contentRevision: string;
  }, read: (entry: ExtensionSourceEntryDescriptor, packageRoot: string) => Promise<T>): Promise<T> {
    this.#assertInitialized();
    const source = this.#requireSourceRevision(input.sourceId, input.sourceRevision);
    const entry = source.entries.find((candidate) => candidate.id === input.entryId);
    if (entry === undefined || entry.contentRevision !== input.contentRevision) {
      throw new ExtensionSourceError("SOURCE_CHANGED", "Extension source entry changed concurrently.");
    }
    const root = source.source.kind === "local" ? source.source.path : this.#acquireCurrentGeneration(source);
    if (root === undefined) throw new ExtensionSourceError("SOURCE_CHANGED", "Extension source generation is unavailable.");
    if (source.source.kind === "git") retainCachedPath(root);
    try {
      const packageRoot = await canonicalContainedDirectory(root, entry.packageRelativePath, "Extension package");
      try {
        const currentContentRevision = await fingerprintPackageContent(packageRoot, discoveryBudget());
        if (currentContentRevision !== entry.packageContentRevision) {
          throw new Error("content changed");
        }
      } catch {
        throw new ExtensionSourceError("SOURCE_CHANGED", "Extension source entry changed concurrently.");
      }
      return await read(copyEntry(entry), packageRoot);
    } finally {
      if (source.source.kind === "git") releaseCachedPath(root);
    }
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new Error("Extension sources are not initialized.");
  }

  #assertCatalogRevision(expected: bigint): void {
    this.#assertInitialized();
    if (expected !== this.#catalogRevision) throw new ExtensionSourceError("SOURCE_CHANGED", "Extension sources changed concurrently.");
  }

  #requireSource(sourceId: string): StoredExtensionSource {
    if (!SOURCE_ID.test(sourceId)) throw new ExtensionSourceError("SOURCE_INVALID", "Extension source ID is invalid.");
    const source = this.#records.get(sourceId);
    if (source === undefined) throw new ExtensionSourceError("SOURCE_NOT_FOUND", "Extension source not found.");
    return source;
  }

  #requireSourceRevision(sourceId: string, expectedRevision: bigint): StoredExtensionSource {
    const source = this.#requireSource(sourceId);
    if (BigInt(source.revision) !== expectedRevision) throw new ExtensionSourceError("SOURCE_CHANGED", "Extension source changed concurrently.");
    return source;
  }

  #persist(records: ReadonlyMap<string, StoredExtensionSource>, revision: bigint): void {
    this.#store.setSetting("service", this.#scopeId, SOURCE_SETTING_KEY, {
      format: 1,
      revision: revision.toString(10),
      sources: [...records.values()].sort((left, right) => left.id.localeCompare(right.id, "en"))
    } satisfies StoredExtensionSources);
  }

  #replaceState(records: ReadonlyMap<string, StoredExtensionSource>, revision: bigint): void {
    this.#records.clear();
    for (const [id, record] of records) this.#records.set(id, record);
    this.#catalogRevision = revision;
  }

  async #auditStoredSources(): Promise<ReadonlyMap<string, StoredExtensionSource> | undefined> {
    let next: Map<string, StoredExtensionSource> | undefined;
    for (const record of this.#records.values()) {
      const availabilityError = await this.#sourceAvailabilityError(record);
      if (availabilityError === undefined || record.state === "error" && record.error === availabilityError) continue;
      next ??= new Map(this.#records);
      next.set(record.id, {
        ...record,
        revision: increment(record.revision),
        state: "error",
        error: availabilityError
      });
    }
    return next;
  }

  async #sourceAvailabilityError(record: StoredExtensionSource): Promise<string | undefined> {
    if (record.source.kind === "local") {
      try {
        const canonical = await canonicalDirectory(record.source.path, "Extension source");
        return normalizedCachePath(canonical) === normalizedCachePath(record.source.path)
          ? undefined
          : "Local Extension source folder changed identity. Refresh or remove this source.";
      } catch {
        return "Local Extension source folder is unavailable. Restore, refresh, or remove this source.";
      }
    }
    const root = this.#acquireCurrentGeneration(record);
    if (root === undefined) return "Extension source cache is unavailable. Refresh or remove this source.";
    try {
      const versionsRoot = join(this.#slot(record), "versions");
      const canonical = await canonicalContainedDirectory(versionsRoot, record.activeGeneration!, "Extension source generation");
      return normalizedCachePath(canonical) === normalizedCachePath(root)
        ? undefined
        : "Extension source cache changed identity. Refresh or remove this source.";
    } catch {
      return "Extension source cache is unavailable. Refresh or remove this source.";
    }
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  #slot(record: Pick<StoredExtensionSource, "id" | "sourceIdentity">): string {
    return this.#slotFor(record.id, record.sourceIdentity);
  }

  #slotFor(id: string, sourceIdentity: string): string {
    const suffix = createHash("sha256").update(sourceIdentity).digest("hex").slice(0, 16);
    return join(this.#cacheRoot, `${id}-${suffix}`);
  }

  async #acquireGitGeneration(id: string, source: Extract<ExtensionSourceInput, { readonly kind: "git" }>): Promise<{
    readonly root: string;
    readonly revision: string;
    readonly generation: string;
  }> {
    const sourceIdentity = extensionSourceIdentity(source);
    const slot = this.#slotFor(id, sourceIdentity);
    const incomingRoot = join(slot, "incoming");
    await removeCachedPath(incomingRoot, () => false);
    await mkdir(incomingRoot, { recursive: true });
    const incoming = join(incomingRoot, randomUUID());
    try {
      const revision = await cloneGitSource(source, incoming, this.#git);
      const generation = randomUUID();
      const version = join(slot, "versions", generation);
      await mkdir(dirname(version), { recursive: true });
      await renameWithRetry(incoming, version);
      return { root: version, revision, generation };
    } catch (error) {
      await removeCachedPath(incoming, () => false).catch(() => undefined);
      throw normalizeSourceError(error);
    }
  }

  async #writeCurrentGeneration(record: Pick<StoredExtensionSource, "id" | "sourceIdentity">, generation: string): Promise<void> {
    await atomicWritePointer(join(this.#slot(record), "current"), generation);
  }

  #acquireCurrentGeneration(source: StoredExtensionSource): string | undefined {
    if (source.activeGeneration === undefined) return undefined;
    const pointer = join(this.#slot(source), "current");
    const current = readPointerSync(pointer);
    if (current !== source.activeGeneration) return undefined;
    const root = join(this.#slot(source), "versions", current);
    return existsSync(root) ? root : undefined;
  }

  #isCurrentGeneration(sourceId: string, generation: string): boolean {
    const source = this.#records.get(sourceId);
    return source?.activeGeneration === generation;
  }
}

async function discoverMarketplace(
  sourceRoot: string,
  sourceId: string,
  sourceIdentity: string,
  gitRevision: string | undefined,
  inspectPackageCatalog: typeof inspectPiPackageCatalog
): Promise<DiscoveryResult> {
  const root = await canonicalDirectory(sourceRoot, "Extension source");
  const manifestPath = join(root, MARKETPLACE_MANIFEST);
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readBoundedRegularFile(manifestPath, root, MANIFEST_MAXIMUM_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new ExtensionSourceError("SOURCE_MANIFEST_MISSING", `Extension source must contain ${MARKETPLACE_MANIFEST.replaceAll("\\", "/")}.`);
    }
    throw new ExtensionSourceError("SOURCE_MANIFEST_INVALID", "Extension source manifest could not be read safely.");
  }
  let raw: RawMarketplaceManifest;
  try {
    raw = JSON.parse(manifestBytes.toString("utf8")) as RawMarketplaceManifest;
  } catch {
    throw new ExtensionSourceError("SOURCE_MANIFEST_INVALID", "Extension source manifest is not valid JSON.");
  }
  if (!plainObject(raw) || !exactKeys(raw, ["name", "displayName", "plugins"])) {
    throw new ExtensionSourceError("SOURCE_MANIFEST_INVALID", "Extension source manifest shape is invalid.");
  }
  const name = boundedName(raw.name, "Extension source name");
  const displayName = raw.displayName === undefined ? undefined : boundedName(raw.displayName, "Extension source display name");
  if (!Array.isArray(raw.plugins) || raw.plugins.length > MAXIMUM_DECLARED_ENTRIES) {
    throw new ExtensionSourceError("SOURCE_MANIFEST_INVALID", `Extension source manifest may list at most ${MAXIMUM_DECLARED_ENTRIES} packages.`);
  }
  const entries: StoredExtensionSourceEntry[] = [];
  const seenEntries = new Set<string>();
  const seenResources = new Set<string>();
  let skippedEntryCount = 0;
  let unreadableEntryCount = 0;
  const budget = discoveryBudget();
  for (const rawEntry of raw.plugins) {
    try {
      if (!plainObject(rawEntry) || !exactKeys(rawEntry, ["name", "source"])) throw new Error("entry shape");
      const packageLabel = boundedName(rawEntry.name, "Extension package name");
      const packageRelativePath = normalizeRelativePath(rawEntry.source);
      const packageRoot = await canonicalContainedDirectory(root, packageRelativePath, "Extension package");
      const contentBeforeInspection = await fingerprintPackageContent(packageRoot, budget);
      const inspection = await inspectPackageCatalog(packageRoot);
      const packageContentRevision = await fingerprintPackageContent(packageRoot, budget);
      if (contentBeforeInspection !== packageContentRevision) throw new Error("package changed during inspection");
      const resourceId = `resource_market_${createHash("sha256").update(`${sourceIdentity}\0${packageRelativePath}`).digest("hex").slice(0, 32)}`;
      if (seenResources.has(resourceId)) throw new Error("duplicate package");
      seenResources.add(resourceId);
      const ordinals = new Map<string, number>();
      for (const [index, extension] of inspection.extensions.entries()) {
        if (entries.length >= MAXIMUM_DISCOVERED_EXTENSIONS) throw new ExtensionSourceError("SOURCE_MANIFEST_INVALID", `Extension source exposes more than ${MAXIMUM_DISCOVERED_EXTENSIONS} extensions.`);
        const ordinal = ordinals.get(extension.resourceName) ?? 0;
        ordinals.set(extension.resourceName, ordinal + 1);
        const identity = `${packageRelativePath}\0${extension.relativePath}`;
        if (seenEntries.has(identity)) throw new Error("duplicate extension");
        seenEntries.add(identity);
        const id = `extension_source_entry_${createHash("sha256").update(`${sourceId}\0${identity}`).digest("hex").slice(0, 32)}`;
        const revision = digest({
          gitRevision: gitRevision ?? null,
          packageRelativePath,
          extensionRelativePath: extension.relativePath,
          packageName: inspection.name,
          packageVersion: inspection.version ?? null,
          author: inspection.author ?? null,
          description: inspection.description,
          packageContentRevision
        });
        entries.push({
          id,
          revision,
          contentRevision: revision,
          packageContentRevision,
          resourceId,
          packageRelativePath,
          extensionRelativePath: extension.relativePath,
          bindingName: extension.resourceName,
          bindingOrdinal: ordinal,
          name: inspection.extensions.length === 1 ? packageLabel : `${packageLabel} · ${basename(extension.relativePath)}`,
          packageName: inspection.name,
          ...(inspection.version === undefined ? {} : { version: inspection.version }),
          ...(inspection.author === undefined ? {} : { author: inspection.author }),
          description: inspection.description
        });
        if (index > MAXIMUM_DISCOVERED_EXTENSIONS) throw new Error("unreachable extension limit");
      }
    } catch (error) {
      if (error instanceof ExtensionSourceError) throw error;
      if (transientFilesystemError(error)) unreadableEntryCount += 1;
      else skippedEntryCount += 1;
    }
  }
  entries.sort((left, right) => left.id.localeCompare(right.id, "en"));
  const contentRevision = digest({
    manifest: createHash("sha256").update(manifestBytes).digest("hex"),
    gitRevision: gitRevision ?? null,
    entries: entries.map((entry) => [entry.id, entry.revision]),
    skippedEntryCount,
    unreadableEntryCount
  });
  return {
    name,
    ...(displayName === undefined ? {} : { displayName }),
    contentRevision,
    entries,
    declaredEntryCount: raw.plugins.length,
    skippedEntryCount,
    unreadableEntryCount
  };
}

async function cloneGitSource(
  source: Extract<ExtensionSourceInput, { readonly kind: "git" }>,
  destination: string,
  git: ExtensionSourceGitExecutor
): Promise<string> {
  try {
    if (source.sparsePaths.length === 0) {
      await git(["clone", source.repositoryUrl, destination], { timeoutMs: GIT_OPERATION_TIMEOUT_MS });
      if (source.ref !== undefined) {
        await git(["checkout", "--detach", source.ref], { cwd: destination, timeoutMs: GIT_OPERATION_TIMEOUT_MS });
      }
    } else {
      await git(["clone", "--filter=blob:none", "--no-checkout", source.repositoryUrl, destination], { timeoutMs: GIT_OPERATION_TIMEOUT_MS });
      await git(["sparse-checkout", "set", "--", ...source.sparsePaths], { cwd: destination, timeoutMs: GIT_OPERATION_TIMEOUT_MS });
      await git(["checkout", "--detach", source.ref ?? "HEAD"], { cwd: destination, timeoutMs: GIT_OPERATION_TIMEOUT_MS });
    }
    const revision = (await git(["rev-parse", "HEAD"], { cwd: destination, timeoutMs: 10_000 })).stdout.trim();
    if (!GIT_REVISION.test(revision)) throw new Error("Git returned an invalid revision.");
    return revision.toLowerCase();
  } catch (error) {
    throw classifyGitError(error);
  }
}

async function gitVersion(git: ExtensionSourceGitExecutor): Promise<{ readonly major: number; readonly minor: number; readonly patch: number } | undefined> {
  try {
    const output = (await git(["--version"], { timeoutMs: 10_000 })).stdout;
    const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/u.exec(output);
    return match === null ? undefined : { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) };
  } catch {
    return undefined;
  }
}

function supportsGitVersion(version: { readonly major: number; readonly minor: number }): boolean {
  return version.major > MINIMUM_GIT_VERSION.major
    || version.major === MINIMUM_GIT_VERSION.major && version.minor >= MINIMUM_GIT_VERSION.minor;
}

function classifyGitError(error: unknown): ExtensionSourceError {
  if (error instanceof ExtensionSourceError) return error;
  const raw = error instanceof Error ? `${error.message}\n${String((error as { readonly stderr?: unknown }).stderr ?? "")}` : String(error);
  const detail = boundedFailure(redactAbsolutePaths(raw));
  if (/Remote branch \S+ not found|Couldn't find remote ref|couldn't find remote ref|pathspec .* did not match/iu.test(raw)) {
    return new ExtensionSourceError("SOURCE_GIT_REF_NOT_FOUND", detail || "Git ref was not found.");
  }
  if (/Authentication failed|could not read Username|Repository not found|Permission denied \(publickey\)|Host key verification failed|Could not read from remote repository|SAML SSO/iu.test(raw)) {
    return new ExtensionSourceError("SOURCE_GIT_AUTH_FAILED", detail || "Git authentication failed.");
  }
  return new ExtensionSourceError("SOURCE_GIT_FAILED", detail || "Git source acquisition failed.");
}

function normalizeSourceError(error: unknown): ExtensionSourceError {
  if (error instanceof ExtensionSourceError) return error;
  return new ExtensionSourceError("SOURCE_INVALID", boundedFailure(error instanceof Error ? error.message : String(error)) || "Extension source operation failed.");
}

function normalizeSparsePath(value: string): string {
  const path = value.trim();
  if (path === "" || path.length > 256 || FORBIDDEN_TEXT.test(path) || path.includes("\\")
    || path.startsWith("/") || path.startsWith("-") || isAbsolute(path)
    || path.split("/").some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new ExtensionSourceError("SOURCE_INVALID", "Git sparse path is invalid.");
  }
  return path;
}

function isValidGitRef(value: string): boolean {
  if (value === "" || FORBIDDEN_TEXT.test(value) || !GIT_REF.test(value)
    || value.includes("..") || value.includes("@{") || value.includes("//")
    || value.endsWith("/") || value.endsWith(".")) return false;
  return !value.split("/").some((part) => part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"));
}

function normalizeRelativePath(value: unknown): string {
  if (typeof value !== "string") throw new Error("relative path type");
  const path = value.trim();
  if (path === "" || path.length > 512 || FORBIDDEN_TEXT.test(path) || path.includes("\\") || path.startsWith("/")
    || isAbsolute(path) || path.split("/").some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new Error("relative path shape");
  }
  return path;
}

function gitUrlContainsCredential(value: string): boolean {
  if (/^git@/iu.test(value)) return value.includes("?") || value.includes("#");
  try {
    const url = new URL(value);
    if (url.search !== "" || url.hash !== "" || url.password !== "") return true;
    return url.protocol === "https:" && url.username !== "";
  } catch {
    return true;
  }
}

function sourceDisplay(source: ExtensionSourceInput): string {
  return source.kind === "local"
    ? source.path
    : `${source.repositoryUrl}${source.ref === undefined ? "" : `#${source.ref}`}`;
}

async function canonicalDirectory(value: string, label: string): Promise<string> {
  const canonical = await realpath(value);
  if (!(await lstat(canonical)).isDirectory()) throw new ExtensionSourceError("SOURCE_INVALID", `${label} must be a directory.`);
  return canonical;
}

async function canonicalContainedDirectory(root: string, relativePath: string, label: string): Promise<string> {
  const candidate = resolve(root, ...relativePath.split("/"));
  if (!within(root, candidate)) throw new Error(`${label} escapes its source.`);
  const original = await lstat(candidate);
  if (original.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link.`);
  const canonical = await realpath(candidate);
  if (!within(root, canonical) || !(await lstat(canonical)).isDirectory()) throw new Error(`${label} is invalid.`);
  return canonical;
}

async function readBoundedRegularFile(path: string, root: string, maximumBytes: number): Promise<Buffer> {
  const original = await lstat(path);
  if (original.isSymbolicLink() || !original.isFile() || original.size > maximumBytes) throw new Error("File is not a regular file.");
  const canonical = await realpath(path);
  if (!within(root, canonical)) throw new Error("File escapes its source.");
  const handle = await open(canonical, constants.O_RDONLY);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes || before.size !== original.size || before.mtimeMs !== original.mtimeMs
      || !sameFilesystemIdentity(original, before)) throw new Error("File changed before its safe read.");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(path);
    const currentCanonical = await realpath(path);
    if (bytes.length !== before.size || !after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || !sameFilesystemIdentity(before, after) || !current.isFile() || current.isSymbolicLink()
      || current.size !== before.size || current.mtimeMs !== before.mtimeMs || !sameFilesystemIdentity(before, current)
      || normalizedCachePath(currentCanonical) !== normalizedCachePath(canonical)) throw new Error("File changed during its safe read.");
    return bytes;
  } finally {
    await handle.close();
  }
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function transientFilesystemError(error: unknown): boolean {
  return ["EACCES", "EBUSY", "EMFILE", "ENFILE", "EPERM", "ETIMEDOUT"].includes(String((error as NodeJS.ErrnoException)?.code ?? ""));
}

function boundedName(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ExtensionSourceError("SOURCE_MANIFEST_INVALID", `${label} is missing.`);
  const name = value.trim();
  if (name === "" || name.length > MAXIMUM_NAME_CHARACTERS || FORBIDDEN_TEXT.test(name)) {
    throw new ExtensionSourceError("SOURCE_MANIFEST_INVALID", `${label} is invalid.`);
  }
  return name;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function increment(value: string): string {
  return (BigInt(value) + 1n).toString(10);
}

function boundedFailure(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "").trim().slice(0, SOURCE_FAILURE_MAXIMUM_CHARACTERS);
}

function redactAbsolutePaths(value: string): string {
  const urls: string[] = [];
  const masked = value.replace(/\b(?:https?|ssh):\/\/[^\s"'<>|]+/giu, (url) => {
    urls.push(url);
    return `\0URL${urls.length - 1}\0`;
  });
  return masked
    .replace(/[A-Za-z]:\\[^\s"'<>|]*/gu, "<path>")
    .replace(/\\\\[^\s"'<>|]+/gu, "<path>")
    .replace(/\/(?:[^\s"'<>|/]+\/)+[^\s"'<>|/]*/gu, "<path>")
    .replace(/~\/[^\s"'<>|]*/gu, "<path>")
    .replace(/\0URL(\d+)\0/gu, (_match, index: string) => (urls[Number(index)] ?? "<url>").replace(/^((?:https?|ssh):\/\/)[^/@\s]+@/iu, "$1***@"));
}

function publicSource(record: StoredExtensionSource): ExtensionSourceDescriptor {
  return {
    id: record.id,
    revision: BigInt(record.revision),
    source: copySource(record.source),
    sourceIdentity: record.sourceIdentity,
    sourceDisplay: record.sourceDisplay,
    name: record.name,
    ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
    state: record.state,
    contentRevision: record.contentRevision,
    entries: record.entries.map(copyEntry),
    declaredEntryCount: record.declaredEntryCount,
    skippedEntryCount: record.skippedEntryCount,
    unreadableEntryCount: record.unreadableEntryCount,
    addedAt: record.addedAt,
    ...(record.refreshedAt === undefined ? {} : { refreshedAt: record.refreshedAt }),
    ...(record.error === undefined ? {} : { error: record.error })
  };
}

function copySource(source: ExtensionSourceInput): ExtensionSourceInput {
  return source.kind === "local" ? { ...source } : { ...source, sparsePaths: [...source.sparsePaths] };
}

function copyEntry(entry: StoredExtensionSourceEntry): ExtensionSourceEntryDescriptor {
  return { ...entry };
}

function validateStoredSources(value: unknown): StoredExtensionSources {
  if (!plainObject(value) || !exactKeys(value, ["format", "revision", "sources"]) || value.format !== 1
    || typeof value.revision !== "string" || !DECIMAL_REVISION.test(value.revision) || !Array.isArray(value.sources)) {
    throw new Error("Stored Extension source catalog is invalid.");
  }
  return value as unknown as StoredExtensionSources;
}

function validateStoredSource(value: unknown): StoredExtensionSource {
  if (!plainObject(value) || !exactKeys(value, [
    "id", "revision", "source", "sourceIdentity", "sourceDisplay", "name", "displayName", "state", "contentRevision",
    "entries", "declaredEntryCount", "skippedEntryCount", "unreadableEntryCount", "addedAt", "refreshedAt", "activeGeneration", "error"
  ])) throw new Error("Stored Extension source is invalid.");
  if (!plainObject(value.source) || typeof value.source.kind !== "string"
    || value.source.kind === "local" && !exactKeys(value.source, ["kind", "path"])
    || value.source.kind === "git" && !exactKeys(value.source, ["kind", "repositoryUrl", "ref", "sparsePaths"])
    || value.source.kind !== "local" && value.source.kind !== "git") throw new Error("Stored Extension source input is invalid.");
  if (value.source.kind === "local" && (typeof value.source.path !== "string" || !isAbsolute(value.source.path))) {
    throw new Error("Stored local Extension source path is invalid.");
  }
  const source = normalizeExtensionSourceInput(value.source as unknown as ExtensionSourceInput, "C:\\invalid-home-must-not-expand");
  if (typeof value.id !== "string" || !SOURCE_ID.test(value.id) || typeof value.revision !== "string" || !DECIMAL_REVISION.test(value.revision)
    || value.revision === "0"
    || typeof value.sourceIdentity !== "string" || value.sourceIdentity !== extensionSourceIdentity(source)
    || typeof value.sourceDisplay !== "string" || value.sourceDisplay !== sourceDisplay(source)
    || typeof value.name !== "string" || boundedName(value.name, "Extension source name") !== value.name
    || value.displayName !== undefined && (typeof value.displayName !== "string" || boundedName(value.displayName, "Extension source display name") !== value.displayName)
    || value.state !== "ready" && value.state !== "error" || typeof value.contentRevision !== "string" || !CONTENT_REVISION.test(value.contentRevision)
    || !Array.isArray(value.entries) || !safeCount(value.declaredEntryCount, MAXIMUM_DECLARED_ENTRIES)
    || !safeCount(value.skippedEntryCount, MAXIMUM_DECLARED_ENTRIES) || !safeCount(value.unreadableEntryCount, MAXIMUM_DECLARED_ENTRIES)
    || typeof value.addedAt !== "number" || !Number.isSafeInteger(value.addedAt) || value.addedAt < 0
    || value.refreshedAt !== undefined && (typeof value.refreshedAt !== "number" || !Number.isSafeInteger(value.refreshedAt) || value.refreshedAt < value.addedAt)
    || value.activeGeneration !== undefined && (typeof value.activeGeneration !== "string" || !GENERATION_ID.test(value.activeGeneration))
    || value.error !== undefined && (typeof value.error !== "string" || value.error !== boundedFailure(value.error))) {
    throw new Error("Stored Extension source fields are invalid.");
  }
  if ((source.kind === "git" ? value.activeGeneration === undefined : value.activeGeneration !== undefined)
    || value.state === "error" !== (value.error !== undefined)
    || (value.skippedEntryCount as number) + (value.unreadableEntryCount as number) > (value.declaredEntryCount as number)) {
    throw new Error("Stored Extension source generation or state is invalid.");
  }
  const entries = value.entries.map(validateStoredEntry);
  if (entries.length > MAXIMUM_DISCOVERED_EXTENSIONS || new Set(entries.map((entry) => entry.id)).size !== entries.length
    || new Set(entries.map((entry) => `${entry.resourceId}\0${entry.bindingName}\0${entry.bindingOrdinal}`)).size !== entries.length
    || entries.some((entry) => entry.resourceId !== `resource_market_${createHash("sha256").update(`${value.sourceIdentity}\0${entry.packageRelativePath}`).digest("hex").slice(0, 32)}`
      || entry.id !== `extension_source_entry_${createHash("sha256").update(`${value.id}\0${entry.packageRelativePath}\0${entry.extensionRelativePath}`).digest("hex").slice(0, 32)}`)) {
    throw new Error("Stored Extension source entries are invalid.");
  }
  return { ...value, source, entries } as unknown as StoredExtensionSource;
}

function validateStoredEntry(value: unknown): StoredExtensionSourceEntry {
  if (!plainObject(value) || !exactKeys(value, [
    "id", "revision", "contentRevision", "packageContentRevision", "resourceId", "packageRelativePath", "extensionRelativePath", "bindingName", "bindingOrdinal",
    "name", "packageName", "version", "author", "description"
  ]) || typeof value.id !== "string" || !ENTRY_ID.test(value.id) || typeof value.revision !== "string" || !CONTENT_REVISION.test(value.revision)
    || typeof value.contentRevision !== "string" || value.contentRevision !== value.revision
    || typeof value.packageContentRevision !== "string" || !CONTENT_REVISION.test(value.packageContentRevision)
    || typeof value.resourceId !== "string" || !RESOURCE_ID.test(value.resourceId)
    || normalizeRelativePath(value.packageRelativePath) !== value.packageRelativePath || normalizeRelativePath(value.extensionRelativePath) !== value.extensionRelativePath
    || typeof value.bindingName !== "string" || value.bindingName.trim() === "" || typeof value.bindingOrdinal !== "number" || !Number.isSafeInteger(value.bindingOrdinal) || value.bindingOrdinal < 0
    || typeof value.name !== "string" || value.name.trim() === "" || typeof value.packageName !== "string" || value.packageName.trim() === ""
    || value.version !== undefined && (typeof value.version !== "string" || value.version.trim() === "")
    || value.author !== undefined && (typeof value.author !== "string" || value.author.trim() === "")
    || typeof value.description !== "string") throw new Error("Stored Extension source entry is invalid.");
  return value as unknown as StoredExtensionSourceEntry;
}

function safeCount(value: unknown, maximum: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

interface DiscoveryBudget {
  nodes: number;
  bytes: number;
  readonly maximumNodes: number;
  readonly maximumBytes: number;
  readonly deadline: number;
}

function discoveryBudget(): DiscoveryBudget {
  return {
    nodes: 0,
    bytes: 0,
    maximumNodes: MAXIMUM_DISCOVERY_NODES,
    maximumBytes: MAXIMUM_DISCOVERY_BYTES,
    deadline: Date.now() + MAXIMUM_DISCOVERY_DURATION_MS
  };
}

async function fingerprintPackageContent(packageRoot: string, budget: DiscoveryBudget): Promise<string> {
  const root = await canonicalDirectory(packageRoot, "Extension package");
  const hash = createHash("sha256");
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    assertDiscoveryBudget(budget);
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Extension package directory is unsafe.");
    const canonical = await realpath(directory);
    if (!within(root, canonical)) throw new Error("Extension package directory escapes its root.");
    hash.update(`D\0${relativeDirectory}\0`);
    const children = await safePackageEntries(directory);
    for (const child of children) {
      if (child.name.toLowerCase() === ".git") continue;
      if (FORBIDDEN_TEXT.test(child.name) || child.name.includes("/") || child.name.includes("\\")) {
        throw new Error("Extension package entry name is unsafe.");
      }
      budget.nodes += 1;
      assertDiscoveryBudget(budget);
      const path = join(directory, child.name);
      const relativePath = relativeDirectory === "" ? child.name : `${relativeDirectory}/${child.name}`;
      const info = await lstat(path);
      if (child.isSymbolicLink() || info.isSymbolicLink()) throw new Error("Extension package contains a symlink or junction.");
      if (child.isDirectory() && info.isDirectory()) {
        await visit(path, relativePath);
      } else if (child.isFile() && info.isFile()) {
        await fingerprintPackageFile(root, path, relativePath, info, hash, budget);
      } else {
        throw new Error("Extension package contains a special or changing entry.");
      }
    }
    const after = await lstat(directory);
    if (!after.isDirectory() || after.isSymbolicLink() || !sameFilesystemIdentity(before, after) || before.mtimeMs !== after.mtimeMs) {
      throw new Error("Extension package changed during discovery.");
    }
  };
  await visit(root, "");
  return `sha256:${hash.digest("hex")}`;
}

async function fingerprintPackageFile(
  root: string,
  path: string,
  relativePath: string,
  pathInfo: Awaited<ReturnType<typeof lstat>>,
  hash: ReturnType<typeof createHash>,
  budget: DiscoveryBudget
): Promise<void> {
  const canonical = await realpath(path);
  if (!within(root, canonical)) throw new Error("Extension package file escapes its root.");
  const handle = await open(canonical, constants.O_RDONLY);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFilesystemIdentity(pathInfo, before) || before.size !== pathInfo.size || before.mtimeMs !== pathInfo.mtimeMs) {
      throw new Error("Extension package file changed before discovery.");
    }
    budget.bytes += before.size;
    assertDiscoveryBudget(budget);
    hash.update(`F\0${relativePath}\0${before.size}\0`);
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      assertDiscoveryBudget(budget);
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, before.size - position), position);
      if (bytesRead === 0) throw new Error("Extension package file ended during discovery.");
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (!after.isFile() || !sameFilesystemIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("Extension package file changed during discovery.");
    }
  } finally {
    await handle.close();
  }
}

async function safePackageEntries(directory: string) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  return entries;
}

function assertDiscoveryBudget(budget: DiscoveryBudget): void {
  if (budget.nodes > budget.maximumNodes || budget.bytes > budget.maximumBytes || Date.now() > budget.deadline) {
    throw new ExtensionSourceError("SOURCE_MANIFEST_INVALID", "Extension source discovery exceeded its safe work limits.");
  }
}

function sameFilesystemIdentity(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt >= 3 || !["EBUSY", "EACCES", "EPERM", "ENOTEMPTY"].includes(String((error as NodeJS.ErrnoException).code ?? ""))) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50 * (attempt + 1)));
    }
  }
}

async function atomicWritePointer(path: string, value: string): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const backup = `${path}.bak`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${value}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  let backedUp = false;
  try {
    if (existsSync(path)) {
      await rm(backup, { force: true });
      await renameWithRetry(path, backup);
      backedUp = true;
    }
    await renameWithRetry(temporary, path);
    if (backedUp) await rm(backup, { force: true });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (!existsSync(path) && backedUp && existsSync(backup)) await renameWithRetry(backup, path).catch(() => undefined);
    throw error;
  }
}

function readPointerSync(path: string): string | undefined {
  try {
    const candidate = !existsSync(path) && existsSync(`${path}.bak`) ? `${path}.bak` : path;
    const info = lstatSync(candidate);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 128) return undefined;
    const value = readFileSync(candidate, "utf8").trim();
    return GENERATION_ID.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const cachedPathLeases = new Map<string, number>();
const deferredCachedPathRemovals = new Map<string, { readonly path: string; readonly skip: () => boolean }>();

function normalizedCachePath(path: string): string {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

function retainCachedPath(path: string): void {
  const key = normalizedCachePath(path);
  cachedPathLeases.set(key, (cachedPathLeases.get(key) ?? 0) + 1);
}

function releaseCachedPath(path: string): void {
  const key = normalizedCachePath(path);
  const count = cachedPathLeases.get(key) ?? 0;
  if (count <= 1) cachedPathLeases.delete(key);
  else cachedPathLeases.set(key, count - 1);
  void drainCachedPathRemovals();
}

async function removeCachedPath(path: string, skip: () => boolean): Promise<void> {
  const key = normalizedCachePath(path);
  if ([...cachedPathLeases.keys()].some((leased) => pathsOverlap(key, leased))) {
    deferredCachedPathRemovals.set(key, { path, skip });
    return;
  }
  if (!skip()) await rm(path, { recursive: true, force: true });
}

async function drainCachedPathRemovals(): Promise<void> {
  for (const [key, removal] of [...deferredCachedPathRemovals]) {
    if ([...cachedPathLeases.keys()].some((leased) => pathsOverlap(key, leased))) continue;
    deferredCachedPathRemovals.delete(key);
    if (!removal.skip()) await rm(removal.path, { recursive: true, force: true }).catch(() => undefined);
  }
}
