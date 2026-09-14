import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, existsSync, lstatSync, readFileSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createGunzip } from "node:zlib";

import type { OperationalStore } from "@joko/store";
import { extract as extractTarArchive } from "tar";

import {
  inspectPiSkillPackage,
  type PiMarketSkillPreview,
  type PiMarketSkillTargetInput,
  type PiResourceDescriptor,
  type PiResourceManager,
  type PiSkillPackageInspection,
  type PreparedPiResourceMutation
} from "./resource-manager.js";
import {
  SkillMutationCoordinator,
  skillInstallSlotMutationKey,
  skillResourceMutationKey,
  type SkillMutationLease
} from "./skill-mutation-coordinator.js";

export type SkillMarketSourceInput =
  | { readonly kind: "local"; readonly path: string }
  | {
      readonly kind: "git";
      readonly repositoryUrl: string;
      readonly ref?: string;
      readonly sparsePaths: readonly string[];
    };

export type SkillMarketSourceKind = SkillMarketSourceInput["kind"];
export type SkillMarketSourceState = "ready" | "error";
export type SkillMarketSort = "trending" | "downloads" | "updated" | "created";

export interface SkillMarketEntryDescriptor {
  readonly id: string;
  readonly sourceId: string;
  readonly revision: bigint;
  readonly contentRevision: string;
  readonly slug: string;
  readonly name: string;
  readonly author?: string;
  readonly description: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly version: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly downloads: number;
  readonly trendScore: number;
  readonly archiveBytes: number;
}

export interface SkillMarketSourceDescriptor {
  readonly id: string;
  readonly revision: bigint;
  readonly kind: SkillMarketSourceKind;
  /** Safe user-facing label. Local absolute paths remain service-private. */
  readonly display: string;
  readonly name: string;
  readonly displayName?: string;
  readonly state: SkillMarketSourceState;
  readonly contentRevision: string;
  readonly entryCount: number;
  readonly addedAt: number;
  readonly refreshedAt?: number;
  readonly error?: string;
}

export interface SkillMarketSourceSnapshot {
  readonly revision: bigint;
  readonly sources: readonly SkillMarketSourceDescriptor[];
  readonly recoveredFromCorruption: boolean;
}

export interface SkillMarketCatalogItem extends SkillMarketEntryDescriptor {
  readonly sourceRevision: bigint;
  readonly sourceName: string;
  readonly sourceDisplayName?: string;
  readonly sourceState: SkillMarketSourceState;
  readonly sourceError?: string;
  /** Exact registered Resource placements that currently occupy this slug. */
  readonly installStatuses: readonly SkillMarketInstallStatus[];
}

export type SkillMarketInstallStatusState = "installed" | "update_available" | "conflict";

export interface SkillMarketInstallStatus {
  readonly resourceId: string;
  readonly resourceRevision: bigint;
  readonly backendId: string;
  readonly targetId?: string;
  readonly scope: "global" | "project";
  readonly relativeParent?: string;
  readonly state: SkillMarketInstallStatusState;
  readonly installedVersion?: string;
}

export interface SkillMarketCatalogPage {
  readonly revision: bigint;
  readonly total: number;
  readonly items: readonly SkillMarketCatalogItem[];
  readonly nextOffset?: number;
  readonly categories: readonly string[];
  readonly sourceCount: number;
}

export interface SkillMarketCatalogQuery {
  readonly expectedRevision: bigint;
  readonly query?: string;
  readonly category?: string;
  readonly sort: SkillMarketSort;
  readonly offset: number;
  readonly pageSize: number;
}

export interface SkillMarketEntryIdentity {
  readonly sourceId: string;
  readonly sourceRevision: bigint;
  readonly entryId: string;
  readonly entryRevision: bigint;
  readonly contentRevision: string;
}

export interface SkillMarketArchiveEntry {
  readonly key: string;
  readonly kind: "directory" | "file";
  readonly size: number;
}

export interface SkillMarketPreviewDescriptor {
  readonly id: string;
  readonly entry: SkillMarketCatalogItem;
  readonly snapshotRevision: string;
  readonly files: number;
  readonly bytes: number;
  readonly expiresAt: number;
}

export interface SkillMarketPreviewFilePage {
  readonly previewId: string;
  readonly snapshotRevision: string;
  readonly total: number;
  readonly items: readonly SkillMarketArchiveEntry[];
  readonly nextOffset?: number;
}

export type SkillMarketPreviewUnavailableReason = "BINARY" | "TOO_LARGE";

export interface SkillMarketPreviewFile {
  readonly previewId: string;
  readonly snapshotRevision: string;
  readonly key: string;
  readonly size: number;
  readonly previewable: boolean;
  readonly content?: string;
  readonly unavailableReason?: SkillMarketPreviewUnavailableReason;
}

export interface SkillMarketEntryLease {
  readonly source: SkillMarketSourceDescriptor;
  readonly entry: SkillMarketCatalogItem;
  readonly archiveEntries: readonly SkillMarketArchiveEntry[];
  /** Extracts the exact archive into a fresh private parent and returns package/. */
  readonly extractTo: (privateParent: string, signal?: AbortSignal) => Promise<PiSkillPackageInspection>;
  /** Synchronous source/entry/generation fence for the Store commit boundary. */
  readonly assertIdentityCurrent: () => void;
  readonly assertCurrent: (signal?: AbortSignal) => Promise<void>;
  readonly release: () => void;
}

export interface SkillMarketGitResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type SkillMarketGitExecutor = (
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs: number; readonly signal?: AbortSignal }
) => Promise<SkillMarketGitResult>;

export interface SkillMarketGitPreflight {
  readonly available: boolean;
  readonly version?: string;
  readonly minimumVersion: string;
}

export interface SkillMarketManagerOptions {
  readonly store: OperationalStore;
  readonly cacheRoot: string;
  readonly scopeId?: string;
  readonly homeDirectory?: string;
  readonly now?: () => number;
  readonly git?: SkillMarketGitExecutor;
  readonly previewTtlMs?: number;
  readonly maximumSkillFiles?: number;
  readonly maximumSkillBytes?: number;
  readonly resources?: PiResourceManager;
  readonly mutationCoordinator?: SkillMutationCoordinator;
  readonly installPlanTtlMs?: number;
}

export type SkillMarketInstallConfirmationReason =
  | "SOURCE_REPLACEMENT"
  | "LOCAL_OWNERSHIP"
  | "DIRTY_CONTENT"
  | "UNREGISTERED_DESTINATION"
  | "DOWNGRADE";

export interface SkillMarketInstallPlanDescriptor {
  readonly id: string;
  readonly entry: SkillMarketCatalogItem;
  readonly target: PiMarketSkillTargetInput;
  readonly resourcePreview: PiMarketSkillPreview;
  readonly confirmationReasons: readonly SkillMarketInstallConfirmationReason[];
  readonly requiresConfirmation: boolean;
  readonly expiresAt: number;
}

export interface PreparedSkillMarketInstallation {
  readonly plan: SkillMarketInstallPlanDescriptor;
  readonly mutation: PreparedPiResourceMutation<PiResourceDescriptor>;
  readonly complete: <T>(completion: (finalize: (store: OperationalStore) => void) => T) => Promise<T>;
  readonly cancel: () => Promise<void>;
}

export interface PrepareSkillMarketInstallInput {
  readonly connectionId: string;
  readonly planId: string;
  readonly expectedCandidateRevision: string;
  readonly confirmReplacement: boolean;
}

export type SkillMarketErrorCode =
  | "SOURCE_INVALID"
  | "SOURCE_CREDENTIALS_FORBIDDEN"
  | "SOURCE_GIT_UNAVAILABLE"
  | "SOURCE_GIT_AUTH_FAILED"
  | "SOURCE_GIT_REF_NOT_FOUND"
  | "SOURCE_GIT_FAILED"
  | "SOURCE_MANIFEST_MISSING"
  | "SOURCE_MANIFEST_INVALID"
  | "SOURCE_ARCHIVE_INVALID"
  | "SOURCE_DUPLICATE"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_CHANGED"
  | "CATALOG_CHANGED"
  | "ENTRY_NOT_FOUND"
  | "PREVIEW_NOT_FOUND"
  | "PREVIEW_CHANGED"
  | "INSTALL_PLAN_NOT_FOUND"
  | "INSTALL_PLAN_CHANGED"
  | "MUTATION_BUSY";

export class SkillMarketError extends Error {
  constructor(readonly code: SkillMarketErrorCode, message: string) {
    super(message);
    this.name = "SkillMarketError";
  }
}

interface StoredSkillMarketEntry extends Omit<SkillMarketEntryDescriptor, "revision"> {
  readonly revision: string;
  readonly archiveRelativePath: string;
  readonly archiveSha256: string;
  readonly archiveEntries: readonly SkillMarketArchiveEntry[];
}

interface StoredSkillMarketSource {
  readonly id: string;
  readonly revision: string;
  readonly source: SkillMarketSourceInput;
  readonly sourceIdentity: string;
  readonly name: string;
  readonly displayName?: string;
  readonly state: SkillMarketSourceState;
  readonly contentRevision: string;
  readonly entries: readonly StoredSkillMarketEntry[];
  readonly entryRevisionHistory: Readonly<Record<string, string>>;
  readonly addedAt: number;
  readonly refreshedAt?: number;
  readonly activeGeneration?: string;
  readonly error?: string;
}

interface StoredSkillMarkets {
  readonly format: 1;
  readonly revision: string;
  readonly sources: readonly StoredSkillMarketSource[];
}

interface DiscoveredSkillMarket {
  readonly name: string;
  readonly displayName?: string;
  readonly contentRevision: string;
  readonly entries: readonly Omit<StoredSkillMarketEntry, "revision">[];
}

interface ArchiveFileIdentity {
  readonly path: string;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly size: number;
  readonly mtimeMs: number;
  readonly digest: string;
}

interface PreviewSession {
  readonly id: string;
  readonly connectionId: string;
  readonly lease: SkillMarketEntryLease;
  readonly root: string;
  readonly inspection: PiSkillPackageInspection;
  readonly files: readonly SkillMarketArchiveEntry[];
  readonly expiresAt: number;
}

interface InstallPlanSession {
  readonly id: string;
  readonly connectionId: string;
  readonly lease: SkillMarketEntryLease;
  readonly root: string;
  readonly sourceInput: {
    readonly sourceId: string;
    readonly sourceRevision: bigint;
    readonly entryId: string;
    readonly entryRevision: bigint;
    readonly entryContentRevision: string;
    readonly sourceName: string;
    readonly slug: string;
    readonly version: string;
    readonly candidateRoot: string;
  };
  readonly target: PiMarketSkillTargetInput;
  readonly preview: PiMarketSkillPreview;
  readonly confirmationReasons: readonly SkillMarketInstallConfirmationReason[];
  readonly expiresAt: number;
  state: "open" | "preparing" | "prepared" | "settling" | "retired";
  retireRequested: boolean;
  preparedMutation?: PreparedPiResourceMutation<PiResourceDescriptor>;
  mutationLease?: SkillMutationLease;
}

interface RawMarketManifest {
  readonly format?: unknown;
  readonly name?: unknown;
  readonly displayName?: unknown;
  readonly entries?: unknown;
}

interface SemverApi {
  valid(version: string): string | null;
  compare(left: string, right: string): number;
}

const semver = createRequire(import.meta.url)("semver") as SemverApi;

const SOURCE_SETTING_KEY = "skill_market_sources";
const MARKETPLACE_MANIFEST = join(".agents", "skills", "marketplace.json");
const SOURCE_ID = /^skill_market_source_[a-f0-9]{32}$/u;
const ENTRY_ID = /^skill_market_entry_[a-f0-9]{32}$/u;
const DECIMAL_REVISION = /^(?:0|[1-9][0-9]*)$/u;
const CONTENT_REVISION = /^sha256:[a-f0-9]{64}$/u;
const ARCHIVE_SHA256 = /^[a-f0-9]{64}$/u;
const GENERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GIT_REVISION = /^[a-f0-9]{7,64}$/iu;
const GIT_REF = /^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const GITHUB_SHORTHAND = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;
const SAFE_GIT_URL = /^(?:https:\/\/|ssh:\/\/|git@)[^\s]+$/iu;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const MANIFEST_MAXIMUM_BYTES = 2 * 1024 * 1024;
const MAXIMUM_ENTRIES = 2_000;
const MAXIMUM_ENTRY_REVISION_HISTORY = 10_000;
const MAXIMUM_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAXIMUM_ARCHIVE_ENTRIES = 10_000;
const MAXIMUM_ARCHIVE_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const MAXIMUM_TAR_STREAM_BYTES = MAXIMUM_ARCHIVE_UNCOMPRESSED_BYTES + MAXIMUM_ARCHIVE_ENTRIES * 512 + 2 * 512;
const MAXIMUM_CATALOG_PAGE = 100;
const MAXIMUM_PREVIEW_PAGE = 500;
const MAXIMUM_PREVIEW_TEXT_BYTES = 2 * 1024 * 1024;
const MAXIMUM_NAME_CHARACTERS = 128;
const MAXIMUM_DESCRIPTION_CHARACTERS = 8_192;
const MAXIMUM_CATEGORY_CHARACTERS = 64;
const MAXIMUM_TAGS = 20;
const MAXIMUM_TAG_CHARACTERS = 48;
const MAXIMUM_QUERY_CHARACTERS = 256;
const MAXIMUM_SOURCE_FAILURE_CHARACTERS = 512;
const DEFAULT_PREVIEW_TTL_MS = 10 * 60_000;
const DEFAULT_INSTALL_PLAN_TTL_MS = 10 * 60_000;
const MINIMUM_GIT_VERSION = { major: 2, minor: 25 } as const;
const GIT_OPERATION_TIMEOUT_MS = 5 * 60_000;

const defaultGitExecutor: SkillMarketGitExecutor = (args, options) => new Promise((resolvePromise, reject) => {
  execFile("git", ["-c", "core.longpaths=true", ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    timeout: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
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

/** Current-v1 source parser. It never returns a Git URL containing credentials. */
export function normalizeSkillMarketSourceInput(
  input: SkillMarketSourceInput,
  homeDirectory = homedir()
): SkillMarketSourceInput {
  if (input.kind === "local") {
    const raw = input.path.trim();
    if (raw === "" || FORBIDDEN_TEXT.test(raw)) throw marketError("SOURCE_INVALID", "Local Skill market source path is invalid.");
    const expanded = raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")
      ? join(homeDirectory, raw.slice(1).replace(/^[/\\]/u, ""))
      : raw;
    return { kind: "local", path: resolve(expanded) };
  }
  let repositoryUrl = input.repositoryUrl.trim();
  if (GITHUB_SHORTHAND.test(repositoryUrl)) repositoryUrl = `https://github.com/${repositoryUrl}.git`;
  if (repositoryUrl === "" || FORBIDDEN_TEXT.test(repositoryUrl) || repositoryUrl.includes("\\") || !SAFE_GIT_URL.test(repositoryUrl)) {
    throw marketError("SOURCE_INVALID", "Git Skill market source URL is invalid.");
  }
  if (gitUrlContainsCredential(repositoryUrl)) {
    throw marketError("SOURCE_CREDENTIALS_FORBIDDEN", "Git Skill market source URLs cannot contain credentials, query parameters, or fragments.");
  }
  const ref = input.ref?.trim();
  if (ref !== undefined && !isValidGitRef(ref)) throw marketError("SOURCE_INVALID", "Git Skill market source ref is invalid.");
  if (!Array.isArray(input.sparsePaths) || input.sparsePaths.length > 64) {
    throw marketError("SOURCE_INVALID", "Git Skill market sparse path list is invalid.");
  }
  const sparsePaths = input.sparsePaths.map(normalizeSparsePath);
  if (new Set(sparsePaths).size !== sparsePaths.length) throw marketError("SOURCE_INVALID", "Git Skill market sparse paths must be unique.");
  return {
    kind: "git",
    repositoryUrl,
    ...(ref === undefined ? {} : { ref }),
    sparsePaths
  };
}

export function skillMarketSourceIdentity(source: SkillMarketSourceInput): string {
  return JSON.stringify(source.kind === "local"
    ? ["local", source.path]
    : ["git", source.repositoryUrl, source.ref ?? null, [...source.sparsePaths]]);
}

/** Source/catalog/archive owner for user-configured, product-neutral Skill markets. */
export class SkillMarketManager {
  readonly #store: OperationalStore;
  readonly #cacheRoot: string;
  readonly #scopeId: string;
  readonly #homeDirectory: string;
  readonly #now: () => number;
  readonly #git: SkillMarketGitExecutor;
  readonly #previewTtlMs: number;
  readonly #maximumSkillFiles: number;
  readonly #maximumSkillBytes: number;
  readonly #resources?: PiResourceManager;
  readonly #mutationCoordinator: SkillMutationCoordinator;
  readonly #installPlanTtlMs: number;
  readonly #records = new Map<string, StoredSkillMarketSource>();
  readonly #previews = new Map<string, PreviewSession>();
  readonly #installPlans = new Map<string, InstallPlanSession>();
  readonly #generationLeases = new Map<string, number>();
  readonly #deferredGenerationRemovals = new Map<string, { readonly path: string; readonly skip: () => boolean }>();
  #catalogRevision = 0n;
  #initialized = false;
  #recoveredFromCorruption = false;
  #mutationTail: Promise<unknown> = Promise.resolve();

  constructor(options: SkillMarketManagerOptions) {
    if (!isAbsolute(options.cacheRoot) || resolve(options.cacheRoot) !== options.cacheRoot) {
      throw new Error("Skill market cache root must be a normalized absolute path.");
    }
    this.#store = options.store;
    this.#cacheRoot = options.cacheRoot;
    this.#scopeId = options.scopeId ?? "orchestrator";
    this.#homeDirectory = options.homeDirectory ?? homedir();
    this.#now = options.now ?? Date.now;
    this.#git = options.git ?? defaultGitExecutor;
    this.#previewTtlMs = options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS;
    this.#maximumSkillFiles = options.maximumSkillFiles ?? MAXIMUM_ARCHIVE_ENTRIES;
    this.#maximumSkillBytes = options.maximumSkillBytes ?? MAXIMUM_ARCHIVE_UNCOMPRESSED_BYTES;
    this.#resources = options.resources;
    this.#mutationCoordinator = options.mutationCoordinator ?? new SkillMutationCoordinator();
    this.#installPlanTtlMs = options.installPlanTtlMs ?? DEFAULT_INSTALL_PLAN_TTL_MS;
    if (!Number.isSafeInteger(this.#previewTtlMs) || this.#previewTtlMs < 1_000 || this.#previewTtlMs > 60 * 60_000) {
      throw new RangeError("Skill market preview lifetime is invalid.");
    }
    if (!Number.isSafeInteger(this.#maximumSkillFiles) || this.#maximumSkillFiles < 1 || this.#maximumSkillFiles > MAXIMUM_ARCHIVE_ENTRIES) {
      throw new RangeError("Skill market file limit is invalid.");
    }
    if (!Number.isSafeInteger(this.#maximumSkillBytes) || this.#maximumSkillBytes < 1 || this.#maximumSkillBytes > MAXIMUM_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw new RangeError("Skill market byte limit is invalid.");
    }
    if (!Number.isSafeInteger(this.#installPlanTtlMs) || this.#installPlanTtlMs < 1_000 || this.#installPlanTtlMs > 60 * 60_000) {
      throw new RangeError("Skill market install plan lifetime is invalid.");
    }
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.#cacheRoot, { recursive: true, mode: 0o700 });
    await assertCanonicalDirectory(this.#cacheRoot, "Skill market cache root");
    await Promise.all(["sources", "previews", "plans"].map((name) => mkdir(join(this.#cacheRoot, name), { recursive: true, mode: 0o700 })));
    for (const name of ["sources", "previews", "plans"]) await assertContainedDirectory(this.#cacheRoot, join(this.#cacheRoot, name), `Skill market ${name}`);
    await removePrivatePath(join(this.#cacheRoot, "previews"));
    await removePrivatePath(join(this.#cacheRoot, "plans"));
    await mkdir(join(this.#cacheRoot, "previews"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.#cacheRoot, "plans"), { recursive: true, mode: 0o700 });

    const stored = this.#store.findSetting<unknown>("service", this.#scopeId, SOURCE_SETTING_KEY);
    if (stored !== undefined) {
      try {
        const value = validateStoredMarkets(stored.value);
        this.#catalogRevision = BigInt(value.revision);
        for (const raw of value.sources) {
          const source = validateStoredSource(raw);
          if (this.#records.has(source.id) || [...this.#records.values()].some((candidate) => candidate.sourceIdentity === source.sourceIdentity)) {
            throw new Error("Stored Skill markets contain duplicate source identities.");
          }
          this.#records.set(source.id, source);
        }
        const audited = await this.#auditAvailability();
        if (audited !== undefined) {
          const revision = this.#catalogRevision + 1n;
          this.#persist(audited, revision);
          this.#replaceState(audited, revision);
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

  snapshot(): SkillMarketSourceSnapshot {
    this.#assertInitialized();
    return {
      revision: this.#catalogRevision,
      sources: [...this.#records.values()]
        .sort((left, right) => left.name.localeCompare(right.name, "en") || left.id.localeCompare(right.id, "en"))
        .map(publicSource),
      recoveredFromCorruption: this.#recoveredFromCorruption
    };
  }

  getSource(sourceId: string): SkillMarketSourceDescriptor {
    this.#assertInitialized();
    return publicSource(this.#requireSource(sourceId));
  }

  getEntry(identity: SkillMarketEntryIdentity): SkillMarketCatalogItem {
    this.#assertInitialized();
    const { source, entry } = this.#requireEntry(identity);
    return publicCatalogItem(source, entry, this.#resources);
  }

  /** Resolve a stable source/entry pair to its exact current catalog identity. */
  getCurrentEntry(sourceId: string, entryId: string): SkillMarketCatalogItem {
    this.#assertInitialized();
    const source = this.#requireSource(sourceId);
    if (!ENTRY_ID.test(entryId)) throw marketError("SOURCE_INVALID", "Skill market entry ID is invalid.");
    const entry = source.entries.find((candidate) => candidate.id === entryId);
    if (entry === undefined) throw marketError("ENTRY_NOT_FOUND", "Skill market entry was not found.");
    return publicCatalogItem(source, entry, this.#resources);
  }

  listCatalog(input: SkillMarketCatalogQuery): SkillMarketCatalogPage {
    this.#assertInitialized();
    if (input.expectedRevision !== this.#catalogRevision) throw marketError("CATALOG_CHANGED", "Skill market catalog changed concurrently.");
    const query = normalizedOptionalQuery(input.query);
    const category = normalizedOptionalCategory(input.category);
    if (!isSkillMarketSort(input.sort)) throw marketError("SOURCE_INVALID", "Skill market sort is invalid.");
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) throw marketError("SOURCE_INVALID", "Skill market page offset is invalid.");
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > MAXIMUM_CATALOG_PAGE) {
      throw marketError("SOURCE_INVALID", `Skill market page size must be between 1 and ${MAXIMUM_CATALOG_PAGE}.`);
    }
    const all = [...this.#records.values()].flatMap((source) => source.entries.map((entry) => publicCatalogItem(source, entry, this.#resources)));
    const categories = [...new Set(all.map((entry) => entry.category))].sort((left, right) => left.localeCompare(right, "en"));
    const filtered = all
      .filter((entry) => category === undefined || entry.category.toLocaleLowerCase("en-US") === category)
      .filter((entry) => query === undefined || marketSearchText(entry).includes(query))
      .sort(catalogComparator(input.sort));
    const items = filtered.slice(input.offset, input.offset + input.pageSize);
    const nextOffset = input.offset + items.length < filtered.length ? input.offset + items.length : undefined;
    return {
      revision: this.#catalogRevision,
      total: filtered.length,
      items,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      categories,
      sourceCount: this.#records.size
    };
  }

  async gitPreflight(): Promise<SkillMarketGitPreflight> {
    const version = await gitVersion(this.#git);
    return {
      available: version !== undefined && supportsGitVersion(version),
      ...(version === undefined ? {} : { version: `${version.major}.${version.minor}.${version.patch}` }),
      minimumVersion: `${MINIMUM_GIT_VERSION.major}.${MINIMUM_GIT_VERSION.minor}`
    };
  }

  async add(
    input: SkillMarketSourceInput,
    expectedCatalogRevision: bigint,
    signal?: AbortSignal
  ): Promise<SkillMarketSourceDescriptor> {
    return this.#mutate(async () => {
      signal?.throwIfAborted();
      this.#assertCatalogRevision(expectedCatalogRevision);
      let source = normalizeSkillMarketSourceInput(input, this.#homeDirectory);
      if (source.kind === "local") {
        source = { kind: "local", path: await canonicalDirectory(source.path, "Local Skill market source") };
      } else {
        const preflight = await this.gitPreflight();
        if (!preflight.available) throw marketError("SOURCE_GIT_UNAVAILABLE", `Git ${preflight.minimumVersion} or newer is required.`);
      }
      const sourceIdentity = skillMarketSourceIdentity(source);
      if ([...this.#records.values()].some((record) => record.sourceIdentity === sourceIdentity)) {
        throw marketError("SOURCE_DUPLICATE", "This Skill market source is already configured.");
      }
      const id = `skill_market_source_${createHash("sha256").update(`${sourceIdentity}\0${randomUUID()}`).digest("hex").slice(0, 32)}`;
      const acquired = source.kind === "local"
        ? { root: source.path, revision: undefined, generation: undefined }
        : await this.#acquireGitGeneration(id, source, signal);
      try {
        const discovered = await discoverSkillMarket(acquired.root, id, acquired.revision, signal);
        const history = Object.fromEntries(discovered.entries.map((entry) => [entry.slug, "1"]));
        const entries = discovered.entries.map((entry) => ({ ...entry, revision: "1" }));
        const now = this.#now();
        const record: StoredSkillMarketSource = {
          id,
          revision: "1",
          source,
          sourceIdentity,
          name: discovered.name,
          ...(discovered.displayName === undefined ? {} : { displayName: discovered.displayName }),
          state: "ready",
          contentRevision: discovered.contentRevision,
          entries,
          entryRevisionHistory: history,
          addedAt: now,
          refreshedAt: now,
          ...(acquired.generation === undefined ? {} : { activeGeneration: acquired.generation })
        };
        if (source.kind === "git") await this.#writeCurrentGeneration(record, acquired.generation!);
        const next = new Map(this.#records).set(id, record);
        try {
          this.#persist(next, this.#catalogRevision + 1n);
        } catch (error) {
          if (source.kind === "git") await this.#removeGenerationPath(this.#slot(record), () => false);
          throw error;
        }
        this.#replaceState(next, this.#catalogRevision + 1n);
        return publicSource(record);
      } catch (error) {
        if (source.kind === "git") await this.#removeGenerationPath(this.#slotFor(id, sourceIdentity), () => false).catch(() => undefined);
        throw normalizeMarketError(error);
      }
    });
  }

  async refresh(sourceId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<SkillMarketSourceDescriptor> {
    return this.#mutate(async () => {
      signal?.throwIfAborted();
      const current = this.#requireSourceRevision(sourceId, expectedRevision);
      let acquired: { root: string; revision?: string; generation?: string } | undefined;
      let publicationFailed = false;
      try {
        acquired = current.source.kind === "local"
          ? { root: await canonicalDirectory(current.source.path, "Local Skill market source") }
          : await this.#acquireGitGeneration(current.id, current.source, signal);
        const discovered = await discoverSkillMarket(acquired.root, current.id, acquired.revision, signal);
        const previousBySlug = new Map(current.entries.map((entry) => [entry.slug, entry]));
        const history: Record<string, string> = { ...current.entryRevisionHistory };
        for (const entry of discovered.entries) {
          const previous = previousBySlug.get(entry.slug);
          const last = history[entry.slug];
          history[entry.slug] = previous?.contentRevision === entry.contentRevision
            ? previous.revision
            : increment(last ?? "0");
        }
        if (Object.keys(history).length > MAXIMUM_ENTRY_REVISION_HISTORY) {
          throw marketError("SOURCE_MANIFEST_INVALID", "Skill market source has exceeded its stable entry identity limit.");
        }
        const entries = discovered.entries.map((entry) => ({ ...entry, revision: history[entry.slug]! }));
        const {
          displayName: _previousDisplayName,
          activeGeneration: _previousGeneration,
          error: _previousError,
          ...base
        } = current;
        const nextRecord: StoredSkillMarketSource = {
          ...base,
          revision: increment(current.revision),
          name: discovered.name,
          ...(discovered.displayName === undefined ? {} : { displayName: discovered.displayName }),
          state: "ready",
          contentRevision: discovered.contentRevision,
          entries,
          entryRevisionHistory: history,
          refreshedAt: this.#now(),
          ...(acquired.generation === undefined ? {} : { activeGeneration: acquired.generation })
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
            await this.#removeGenerationPath(acquired.root, () => false).catch(() => undefined);
          }
          throw error;
        }
        this.#replaceState(next, this.#catalogRevision + 1n);
        if (current.source.kind === "git" && oldGeneration !== undefined && oldGeneration !== acquired.generation) {
          void this.#removeGenerationPath(join(this.#slot(current), "versions", oldGeneration), () => this.#isCurrentGeneration(current.id, oldGeneration));
        }
        return publicSource(nextRecord);
      } catch (error) {
        if (acquired?.generation !== undefined) await this.#removeGenerationPath(acquired.root, () => false).catch(() => undefined);
        if (publicationFailed || signal?.aborted === true || isAbortError(error)) throw error;
        const normalized = normalizeMarketError(error);
        if (normalized.code === "SOURCE_CHANGED" || normalized.code === "SOURCE_NOT_FOUND") throw normalized;
        const failed: StoredSkillMarketSource = {
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
        void this.#removeGenerationPath(this.#slot(current), () => this.#records.has(current.id)
          || [...this.#records.values()].some((record) => record.sourceIdentity === current.sourceIdentity));
      }
    });
  }

  async auditAvailability(): Promise<SkillMarketSourceSnapshot> {
    return this.#mutate(async () => {
      this.#assertInitialized();
      const audited = await this.#auditAvailability();
      if (audited !== undefined) {
        const revision = this.#catalogRevision + 1n;
        this.#persist(audited, revision);
        this.#replaceState(audited, revision);
      }
      return this.snapshot();
    });
  }

  async acquireEntry(identity: SkillMarketEntryIdentity, signal?: AbortSignal): Promise<SkillMarketEntryLease> {
    this.#assertInitialized();
    signal?.throwIfAborted();
    const { source, entry } = this.#requireEntry(identity);
    const root = source.source.kind === "local"
      ? await canonicalDirectory(source.source.path, "Local Skill market source")
      : this.#currentGeneration(source);
    if (root === undefined) throw marketError("SOURCE_CHANGED", "Skill market source generation is unavailable.");
    if (source.source.kind === "local" && normalizedPath(root) !== normalizedPath(source.source.path)) {
      throw marketError("SOURCE_CHANGED", "Local Skill market source changed identity.");
    }
    const retained = source.source.kind === "git";
    if (retained) this.#retainGeneration(root);
    let released = false;
    let archive: ArchiveFileIdentity;
    try {
      archive = await inspectDeclaredArchive(root, entry, signal);
    } catch (error) {
      if (retained) this.#releaseGeneration(root);
      throw normalizeMarketError(error, "SOURCE_CHANGED");
    }
    const assertLeaseOpen = (): void => {
      if (released) throw marketError("SOURCE_CHANGED", "Skill market entry lease has been released.");
    };
    const assertIdentityCurrent = (): void => {
      assertLeaseOpen();
      const current = this.#records.get(source.id);
      if (current !== source) throw marketError("SOURCE_CHANGED", "Skill market source changed concurrently.");
      const currentEntry = current.entries.find((candidate) => candidate.id === entry.id);
      if (currentEntry !== entry) throw marketError("SOURCE_CHANGED", "Skill market entry changed concurrently.");
      if (current.source.kind === "git" && this.#currentGeneration(current) !== root) {
        throw marketError("SOURCE_CHANGED", "Skill market source generation changed concurrently.");
      }
    };
    const assertCurrent = async (currentSignal?: AbortSignal): Promise<void> => {
      assertIdentityCurrent();
      currentSignal?.throwIfAborted();
      const observed = await inspectDeclaredArchive(root, entry, currentSignal);
      if (!sameArchiveIdentity(archive, observed)) throw marketError("SOURCE_CHANGED", "Skill market archive changed concurrently.");
    };
    return Object.freeze({
      source: publicSource(source),
      entry: publicCatalogItem(source, entry, this.#resources),
      archiveEntries: entry.archiveEntries.map((item) => ({ ...item })),
      extractTo: async (privateParent: string, extractSignal?: AbortSignal) => {
        assertLeaseOpen();
        await assertCurrent(extractSignal);
        const inspection = await extractVerifiedArchive(archive, entry.archiveEntries, privateParent, this.#maximumSkillFiles, this.#maximumSkillBytes, extractSignal);
        await assertCurrent(extractSignal);
        return inspection;
      },
      assertIdentityCurrent,
      assertCurrent,
      release: () => {
        if (released) return;
        released = true;
        if (retained) this.#releaseGeneration(root);
      }
    });
  }

  async openPreview(
    connectionId: string,
    identity: SkillMarketEntryIdentity,
    signal?: AbortSignal
  ): Promise<SkillMarketPreviewDescriptor> {
    this.#assertInitialized();
    const owner = boundedConnectionId(connectionId);
    await this.#retireExpiredPreviews();
    const lease = await this.acquireEntry(identity, signal);
    const id = `skill_market_preview_${randomUUID().replaceAll("-", "")}`;
    const parent = join(this.#cacheRoot, "previews", id);
    try {
      const inspection = await lease.extractTo(parent, signal);
      const files = await inspectPreviewTree(inspection.canonicalPath);
      const session: PreviewSession = {
        id,
        connectionId: owner,
        lease,
        root: inspection.canonicalPath,
        inspection,
        files,
        expiresAt: this.#now() + this.#previewTtlMs
      };
      this.#previews.set(id, session);
      return publicPreview(session);
    } catch (error) {
      lease.release();
      await removePrivatePath(parent).catch(() => undefined);
      throw error;
    }
  }

  async listPreviewFiles(input: {
    readonly connectionId: string;
    readonly previewId: string;
    readonly expectedSnapshotRevision: string;
    readonly offset: number;
    readonly pageSize: number;
  }): Promise<SkillMarketPreviewFilePage> {
    await this.#retireExpiredPreviews();
    const preview = await this.#requirePreview(input.connectionId, input.previewId, input.expectedSnapshotRevision);
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.pageSize)
      || input.pageSize < 1 || input.pageSize > MAXIMUM_PREVIEW_PAGE) {
      throw marketError("SOURCE_INVALID", "Skill market preview page is invalid.");
    }
    const items = preview.files.slice(input.offset, input.offset + input.pageSize).map((item) => ({ ...item }));
    const nextOffset = input.offset + items.length < preview.files.length ? input.offset + items.length : undefined;
    return {
      previewId: preview.id,
      snapshotRevision: preview.inspection.revision,
      total: preview.files.length,
      items,
      ...(nextOffset === undefined ? {} : { nextOffset })
    };
  }

  async readPreviewFile(input: {
    readonly connectionId: string;
    readonly previewId: string;
    readonly expectedSnapshotRevision: string;
    readonly key: string;
  }, signal?: AbortSignal): Promise<SkillMarketPreviewFile> {
    await this.#retireExpiredPreviews();
    const preview = await this.#requirePreview(input.connectionId, input.previewId, input.expectedSnapshotRevision, signal);
    const key = portablePreviewKey(input.key);
    const entry = preview.files.find((candidate) => candidate.key === key);
    if (entry === undefined || entry.kind !== "file") throw marketError("PREVIEW_NOT_FOUND", "Skill market preview file was not found.");
    if (entry.size > MAXIMUM_PREVIEW_TEXT_BYTES) {
      return { previewId: preview.id, snapshotRevision: preview.inspection.revision, key, size: entry.size, previewable: false, unavailableReason: "TOO_LARGE" };
    }
    const bytes = await readStableContainedFile(preview.root, key, MAXIMUM_PREVIEW_TEXT_BYTES, signal);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (content.includes("\0")) throw new TypeError("binary");
    } catch {
      return { previewId: preview.id, snapshotRevision: preview.inspection.revision, key, size: entry.size, previewable: false, unavailableReason: "BINARY" };
    }
    await preview.lease.assertCurrent(signal);
    return { previewId: preview.id, snapshotRevision: preview.inspection.revision, key, size: entry.size, previewable: true, content };
  }

  async closePreview(connectionId: string, previewId: string): Promise<boolean> {
    const owner = boundedConnectionId(connectionId);
    const preview = this.#previews.get(previewId);
    if (preview === undefined) return false;
    if (preview.connectionId !== owner) throw marketError("PREVIEW_NOT_FOUND", "Skill market preview was not found.");
    await this.#retirePreview(preview);
    return true;
  }

  /**
   * Extract and inspect the exact selected entry against one exact Resource
   * install slot. The extracted root remains connection-private.
   */
  async createInstallPlan(
    connectionId: string,
    identity: SkillMarketEntryIdentity,
    target: PiMarketSkillTargetInput,
    signal?: AbortSignal
  ): Promise<SkillMarketInstallPlanDescriptor> {
    this.#assertInitialized();
    const resources = this.#requireResources();
    const owner = boundedConnectionId(connectionId);
    await this.#retireExpiredInstallPlans();
    const lease = await this.acquireEntry(identity, signal);
    const id = `skill_market_install_${randomUUID().replaceAll("-", "")}`;
    const parent = join(this.#cacheRoot, "plans", id);
    try {
      const inspection = await lease.extractTo(parent, signal);
      const sourceInput = {
        sourceId: lease.source.id,
        sourceRevision: lease.source.revision,
        entryId: lease.entry.id,
        entryRevision: lease.entry.revision,
        entryContentRevision: lease.entry.contentRevision,
        sourceName: lease.entry.sourceDisplayName ?? lease.entry.sourceName,
        slug: lease.entry.slug,
        version: lease.entry.version,
        candidateRoot: inspection.canonicalPath
      } as const;
      const preview = await resources.previewMarketSkill({ ...sourceInput, ...target });
      if (preview.candidateRevision !== inspection.revision) {
        throw marketError("INSTALL_PLAN_CHANGED", "Skill market candidate changed while its install plan was created.");
      }
      const normalizedTarget: PiMarketSkillTargetInput = {
        backendId: preview.backendId,
        scope: preview.scope,
        ...(preview.targetId === undefined ? {} : { targetId: preview.targetId }),
        ...(preview.relativeParent === undefined ? {} : { relativeParent: preview.relativeParent })
      };
      const confirmationReasons = marketInstallConfirmationReasons(preview, lease.entry.version);
      const plan: InstallPlanSession = {
        id,
        connectionId: owner,
        lease,
        root: inspection.canonicalPath,
        sourceInput,
        target: normalizedTarget,
        preview,
        confirmationReasons,
        expiresAt: this.#now() + this.#installPlanTtlMs,
        state: "open",
        retireRequested: false
      };
      this.#installPlans.set(id, plan);
      return publicInstallPlan(plan);
    } catch (error) {
      lease.release();
      await removePrivatePath(parent).catch(() => undefined);
      throw error;
    }
  }

  async getInstallPlan(connectionId: string, planId: string): Promise<SkillMarketInstallPlanDescriptor> {
    await this.#retireExpiredInstallPlans();
    const plan = this.#requireInstallPlan(connectionId, planId);
    if (plan.state !== "open") throw marketError("INSTALL_PLAN_CHANGED", "Skill market install plan is already being used.");
    await plan.lease.assertCurrent();
    return publicInstallPlan(plan);
  }

  async closeInstallPlan(connectionId: string, planId: string): Promise<boolean> {
    const owner = boundedConnectionId(connectionId);
    if (!/^skill_market_install_[a-f0-9]{32}$/u.test(planId)) return false;
    const plan = this.#installPlans.get(planId);
    if (plan === undefined) return false;
    if (plan.connectionId !== owner) throw marketError("INSTALL_PLAN_NOT_FOUND", "Skill market install plan was not found.");
    await this.#retireInstallPlan(plan);
    return plan.state === "retired";
  }

  /** Prepare the exact confirmed plan while holding the shared Skill writer lease. */
  async prepareInstall(input: PrepareSkillMarketInstallInput, signal?: AbortSignal): Promise<PreparedSkillMarketInstallation> {
    this.#assertInitialized();
    const resources = this.#requireResources();
    await this.#retireExpiredInstallPlans();
    const plan = this.#requireInstallPlan(input.connectionId, input.planId);
    if (plan.state !== "open") throw marketError("INSTALL_PLAN_CHANGED", "Skill market install plan is already being used.");
    if (!CONTENT_REVISION.test(input.expectedCandidateRevision) || input.expectedCandidateRevision !== plan.preview.candidateRevision) {
      throw marketError("INSTALL_PLAN_CHANGED", "Skill market install plan changed after confirmation.");
    }
    if (plan.confirmationReasons.length > 0 && !input.confirmReplacement) {
      throw marketError("INSTALL_PLAN_CHANGED", "This Skill installation requires explicit replacement confirmation.");
    }
    signal?.throwIfAborted();
    await plan.lease.assertCurrent(signal);
    const keys = [
      skillResourceMutationKey(plan.preview.resourceId),
      skillInstallSlotMutationKey({
        backendId: plan.preview.backendId,
        ...(plan.preview.targetId === undefined ? {} : { targetId: plan.preview.targetId }),
        scope: plan.preview.scope,
        ...(plan.preview.scope === "project"
          ? { parentKey: plan.preview.relativeParent ?? ".agents/skills" }
          : {}),
        name: plan.preview.name
      }),
      ...(plan.preview.currentResource === undefined || plan.preview.currentResource.resourceId === plan.preview.resourceId
        ? []
        : [skillResourceMutationKey(plan.preview.currentResource.resourceId)])
    ];
    const mutationLease = this.#mutationCoordinator.acquire(keys);
    if (mutationLease === undefined) throw marketError("MUTATION_BUSY", "This Skill install slot is being changed by another operation.");
    plan.state = "preparing";
    plan.mutationLease = mutationLease;
    let preparedMutation: PreparedPiResourceMutation<PiResourceDescriptor> | undefined;
    try {
      const prepared = await resources.prepareMarketSkill({
        ...plan.sourceInput,
        ...plan.target,
        approvedByConnectionId: plan.connectionId,
        expectedAction: plan.preview.action,
        expectedResourceId: plan.preview.resourceId,
        ...(plan.preview.currentResource === undefined
          ? {}
          : {
              expectedCurrentResourceId: plan.preview.currentResource.resourceId,
              expectedCurrentResourceVersion: plan.preview.currentResource.resourceVersion,
              expectedCurrentObservedRevision: plan.preview.currentResource.observedRevision
            }),
        expectedUnregisteredDestination: plan.preview.unregisteredDestination,
        allowReplacement: input.confirmReplacement
      });
      preparedMutation = prepared.mutation;
      if (this.#installPlans.get(plan.id) !== plan || plan.retireRequested) {
        await resources.discardPreparedMutation(preparedMutation);
        preparedMutation = undefined;
        await this.#finishInstallPlan(plan);
        throw marketError("INSTALL_PLAN_NOT_FOUND", "Skill market install plan was closed before preparation completed.");
      }
      plan.preparedMutation = preparedMutation;
      plan.state = "prepared";
      let consumed = false;
      const publicPlan = publicInstallPlan(plan);
      return Object.freeze({
        plan: publicPlan,
        mutation: preparedMutation,
        complete: async <T>(completion: (finalize: (store: OperationalStore) => void) => T): Promise<T> => {
          if (consumed || plan.state !== "prepared" || plan.preparedMutation !== preparedMutation) {
            throw marketError("INSTALL_PLAN_CHANGED", "Prepared Skill market installation has already completed.");
          }
          consumed = true;
          plan.state = "settling";
          let handedToResource = false;
          try {
            await plan.lease.assertCurrent();
            handedToResource = true;
            return await resources.completePreparedMutation(preparedMutation!, (finalizeResource) => {
              plan.mutationLease?.assertActive();
              plan.lease.assertIdentityCurrent();
              if (this.#installPlans.get(plan.id) !== plan) {
                throw marketError("INSTALL_PLAN_CHANGED", "Skill market install plan changed before commit.");
              }
              return completion(finalizeResource);
            });
          } catch (error) {
            if (!handedToResource) await resources.discardPreparedMutation(preparedMutation!).catch(() => undefined);
            throw error;
          } finally {
            plan.preparedMutation = undefined;
            await this.#finishInstallPlan(plan);
          }
        },
        cancel: async (): Promise<void> => {
          if (consumed || plan.state !== "prepared" || plan.preparedMutation !== preparedMutation) return;
          consumed = true;
          plan.state = "settling";
          try {
            await resources.discardPreparedMutation(preparedMutation!);
          } finally {
            plan.preparedMutation = undefined;
            await this.#finishInstallPlan(plan);
          }
        }
      });
    } catch (error) {
      if (preparedMutation !== undefined && plan.preparedMutation === undefined) {
        await resources.discardPreparedMutation(preparedMutation).catch(() => undefined);
      }
      if (plan.state === "preparing") plan.state = "open";
      if (plan.retireRequested) await this.#finishInstallPlan(plan);
      else {
        plan.mutationLease = undefined;
        mutationLease.release();
      }
      throw error;
    }
  }

  async closeConnection(connectionId: string): Promise<void> {
    const owner = boundedConnectionId(connectionId);
    for (const preview of [...this.#previews.values()]) {
      if (preview.connectionId === owner) await this.#retirePreview(preview);
    }
    for (const plan of [...this.#installPlans.values()]) {
      if (plan.connectionId === owner) await this.#retireInstallPlan(plan);
    }
  }

  async close(): Promise<void> {
    for (const preview of [...this.#previews.values()]) await this.#retirePreview(preview);
    for (const plan of [...this.#installPlans.values()]) await this.#retireInstallPlan(plan);
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new Error("Skill markets are not initialized.");
  }

  #assertCatalogRevision(expected: bigint): void {
    this.#assertInitialized();
    if (expected !== this.#catalogRevision) throw marketError("CATALOG_CHANGED", "Skill market catalog changed concurrently.");
  }

  #requireSource(sourceId: string): StoredSkillMarketSource {
    if (!SOURCE_ID.test(sourceId)) throw marketError("SOURCE_INVALID", "Skill market source ID is invalid.");
    const source = this.#records.get(sourceId);
    if (source === undefined) throw marketError("SOURCE_NOT_FOUND", "Skill market source was not found.");
    return source;
  }

  #requireSourceRevision(sourceId: string, expectedRevision: bigint): StoredSkillMarketSource {
    const source = this.#requireSource(sourceId);
    if (BigInt(source.revision) !== expectedRevision) throw marketError("SOURCE_CHANGED", "Skill market source changed concurrently.");
    return source;
  }

  #requireEntry(identity: SkillMarketEntryIdentity): { readonly source: StoredSkillMarketSource; readonly entry: StoredSkillMarketEntry } {
    const source = this.#requireSourceRevision(identity.sourceId, identity.sourceRevision);
    if (!ENTRY_ID.test(identity.entryId) || !CONTENT_REVISION.test(identity.contentRevision)) {
      throw marketError("SOURCE_INVALID", "Skill market entry identity is invalid.");
    }
    const entry = source.entries.find((candidate) => candidate.id === identity.entryId);
    if (entry === undefined) throw marketError("ENTRY_NOT_FOUND", "Skill market entry was not found.");
    if (BigInt(entry.revision) !== identity.entryRevision || entry.contentRevision !== identity.contentRevision) {
      throw marketError("SOURCE_CHANGED", "Skill market entry changed concurrently.");
    }
    return { source, entry };
  }

  #persist(records: ReadonlyMap<string, StoredSkillMarketSource>, revision: bigint): void {
    this.#store.setSetting("service", this.#scopeId, SOURCE_SETTING_KEY, {
      format: 1,
      revision: revision.toString(10),
      sources: [...records.values()].sort((left, right) => left.id.localeCompare(right.id, "en"))
    } satisfies StoredSkillMarkets);
  }

  #replaceState(records: ReadonlyMap<string, StoredSkillMarketSource>, revision: bigint): void {
    this.#records.clear();
    for (const [id, record] of records) this.#records.set(id, record);
    this.#catalogRevision = revision;
  }

  async #auditAvailability(): Promise<ReadonlyMap<string, StoredSkillMarketSource> | undefined> {
    let next: Map<string, StoredSkillMarketSource> | undefined;
    for (const record of this.#records.values()) {
      const availabilityError = await this.#availabilityError(record);
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

  async #availabilityError(record: StoredSkillMarketSource): Promise<string | undefined> {
    if (record.source.kind === "local") {
      try {
        const canonical = await canonicalDirectory(record.source.path, "Local Skill market source");
        return normalizedPath(canonical) === normalizedPath(record.source.path)
          ? undefined
          : "Local Skill market source changed identity. Refresh or remove it.";
      } catch {
        return "Local Skill market source is unavailable. Restore, refresh, or remove it.";
      }
    }
    const root = this.#currentGeneration(record);
    if (root === undefined) return "Skill market source cache is unavailable. Refresh or remove it.";
    try {
      await assertContainedDirectory(join(this.#slot(record), "versions"), root, "Skill market generation");
      return undefined;
    } catch {
      return "Skill market source cache is unavailable. Refresh or remove it.";
    }
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  #slot(record: Pick<StoredSkillMarketSource, "id" | "sourceIdentity">): string {
    return this.#slotFor(record.id, record.sourceIdentity);
  }

  #slotFor(id: string, sourceIdentity: string): string {
    const suffix = createHash("sha256").update(sourceIdentity).digest("hex").slice(0, 16);
    return join(this.#cacheRoot, "sources", `${id}-${suffix}`);
  }

  async #acquireGitGeneration(
    id: string,
    source: Extract<SkillMarketSourceInput, { readonly kind: "git" }>,
    signal?: AbortSignal
  ): Promise<{ readonly root: string; readonly revision: string; readonly generation: string }> {
    signal?.throwIfAborted();
    const sourceIdentity = skillMarketSourceIdentity(source);
    const slot = this.#slotFor(id, sourceIdentity);
    const incomingRoot = join(slot, "incoming");
    await this.#removeGenerationPath(incomingRoot, () => false);
    await mkdir(incomingRoot, { recursive: true, mode: 0o700 });
    const incoming = join(incomingRoot, randomUUID());
    try {
      const revision = await cloneGitSource(source, incoming, this.#git, signal);
      const generation = randomUUID();
      const version = join(slot, "versions", generation);
      await mkdir(dirname(version), { recursive: true, mode: 0o700 });
      await renameWithRetry(incoming, version);
      signal?.throwIfAborted();
      return { root: version, revision, generation };
    } catch (error) {
      await this.#removeGenerationPath(incoming, () => false).catch(() => undefined);
      throw normalizeMarketError(error);
    }
  }

  async #writeCurrentGeneration(record: Pick<StoredSkillMarketSource, "id" | "sourceIdentity">, generation: string): Promise<void> {
    await atomicWritePointer(join(this.#slot(record), "current"), generation);
  }

  #currentGeneration(source: StoredSkillMarketSource): string | undefined {
    if (source.activeGeneration === undefined) return undefined;
    const current = readPointerSync(join(this.#slot(source), "current"));
    if (current !== source.activeGeneration) return undefined;
    const root = join(this.#slot(source), "versions", current);
    return existsSync(root) ? root : undefined;
  }

  #isCurrentGeneration(sourceId: string, generation: string): boolean {
    return this.#records.get(sourceId)?.activeGeneration === generation;
  }

  #retainGeneration(path: string): void {
    const key = normalizedPath(path);
    this.#generationLeases.set(key, (this.#generationLeases.get(key) ?? 0) + 1);
  }

  #releaseGeneration(path: string): void {
    const key = normalizedPath(path);
    const count = this.#generationLeases.get(key) ?? 0;
    if (count <= 1) this.#generationLeases.delete(key);
    else this.#generationLeases.set(key, count - 1);
    void this.#drainGenerationRemovals();
  }

  async #removeGenerationPath(path: string, skip: () => boolean): Promise<void> {
    const key = normalizedPath(path);
    if ([...this.#generationLeases.keys()].some((leased) => pathsOverlap(key, leased))) {
      this.#deferredGenerationRemovals.set(key, { path, skip });
      return;
    }
    if (!skip()) await removePrivatePath(path);
  }

  async #drainGenerationRemovals(): Promise<void> {
    for (const [key, removal] of [...this.#deferredGenerationRemovals]) {
      if ([...this.#generationLeases.keys()].some((leased) => pathsOverlap(key, leased))) continue;
      this.#deferredGenerationRemovals.delete(key);
      if (!removal.skip()) await removePrivatePath(removal.path).catch(() => undefined);
    }
  }

  async #requirePreview(
    connectionId: string,
    previewId: string,
    expectedSnapshotRevision: string,
    signal?: AbortSignal
  ): Promise<PreviewSession> {
    const owner = boundedConnectionId(connectionId);
    if (!/^skill_market_preview_[a-f0-9]{32}$/u.test(previewId) || !CONTENT_REVISION.test(expectedSnapshotRevision)) {
      throw marketError("PREVIEW_NOT_FOUND", "Skill market preview was not found.");
    }
    const preview = this.#previews.get(previewId);
    if (preview === undefined || preview.connectionId !== owner) throw marketError("PREVIEW_NOT_FOUND", "Skill market preview was not found.");
    if (preview.inspection.revision !== expectedSnapshotRevision) throw marketError("PREVIEW_CHANGED", "Skill market preview changed concurrently.");
    signal?.throwIfAborted();
    await preview.lease.assertCurrent(signal);
    return preview;
  }

  async #retireExpiredPreviews(): Promise<void> {
    const now = this.#now();
    for (const preview of [...this.#previews.values()]) {
      if (preview.expiresAt <= now) await this.#retirePreview(preview);
    }
  }

  async #retirePreview(preview: PreviewSession): Promise<void> {
    if (this.#previews.get(preview.id) !== preview) return;
    this.#previews.delete(preview.id);
    preview.lease.release();
    await removePrivatePath(dirname(preview.root)).catch(() => undefined);
  }

  #requireResources(): PiResourceManager {
    if (this.#resources === undefined) throw new Error("Skill market installation requires a Resource manager.");
    return this.#resources;
  }

  #requireInstallPlan(connectionId: string, planId: string): InstallPlanSession {
    const owner = boundedConnectionId(connectionId);
    if (!/^skill_market_install_[a-f0-9]{32}$/u.test(planId)) {
      throw marketError("INSTALL_PLAN_NOT_FOUND", "Skill market install plan was not found.");
    }
    const plan = this.#installPlans.get(planId);
    if (plan === undefined || plan.connectionId !== owner || plan.expiresAt <= this.#now() || plan.state === "retired") {
      throw marketError("INSTALL_PLAN_NOT_FOUND", "Skill market install plan was not found.");
    }
    return plan;
  }

  async #retireExpiredInstallPlans(): Promise<void> {
    const now = this.#now();
    for (const plan of [...this.#installPlans.values()]) {
      if (plan.expiresAt <= now) await this.#retireInstallPlan(plan);
    }
  }

  async #retireInstallPlan(plan: InstallPlanSession): Promise<void> {
    if (this.#installPlans.get(plan.id) !== plan || plan.state === "retired") return;
    if (plan.state === "preparing" || plan.state === "settling") {
      plan.retireRequested = true;
      return;
    }
    if (plan.preparedMutation !== undefined) {
      const prepared = plan.preparedMutation;
      plan.preparedMutation = undefined;
      plan.state = "settling";
      try {
        await this.#requireResources().discardPreparedMutation(prepared);
      } finally {
        await this.#finishInstallPlan(plan);
      }
      return;
    }
    await this.#finishInstallPlan(plan);
  }

  async #finishInstallPlan(plan: InstallPlanSession): Promise<void> {
    if (this.#installPlans.get(plan.id) === plan) this.#installPlans.delete(plan.id);
    plan.state = "retired";
    plan.preparedMutation = undefined;
    plan.mutationLease?.release();
    plan.mutationLease = undefined;
    plan.lease.release();
    await removePrivatePath(dirname(plan.root)).catch(() => undefined);
  }
}

async function discoverSkillMarket(
  sourceRoot: string,
  sourceId: string,
  gitRevision: string | undefined,
  signal?: AbortSignal
): Promise<DiscoveredSkillMarket> {
  signal?.throwIfAborted();
  const root = await canonicalDirectory(sourceRoot, "Skill market source");
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readStableAbsoluteFile(join(root, MARKETPLACE_MANIFEST), root, MANIFEST_MAXIMUM_BYTES, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw marketError("SOURCE_MANIFEST_MISSING", `Skill market source must contain ${MARKETPLACE_MANIFEST.replaceAll("\\", "/")}.`);
    }
    throw marketError("SOURCE_MANIFEST_INVALID", "Skill market source manifest could not be read safely.");
  }
  let raw: RawMarketManifest;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as RawMarketManifest;
  } catch {
    throw marketError("SOURCE_MANIFEST_INVALID", "Skill market source manifest is not valid UTF-8 JSON.");
  }
  if (!plainObject(raw) || !exactKeys(raw, ["format", "name", "displayName", "entries"]) || raw.format !== 1) {
    throw marketError("SOURCE_MANIFEST_INVALID", "Skill market source manifest shape is invalid.");
  }
  const name = boundedText(raw.name, "Skill market source name", MAXIMUM_NAME_CHARACTERS);
  const displayName = raw.displayName === undefined
    ? undefined
    : boundedText(raw.displayName, "Skill market source display name", MAXIMUM_NAME_CHARACTERS);
  if (!Array.isArray(raw.entries) || raw.entries.length > MAXIMUM_ENTRIES) {
    throw marketError("SOURCE_MANIFEST_INVALID", `Skill market source manifest may contain at most ${MAXIMUM_ENTRIES} entries.`);
  }
  const entries: Omit<StoredSkillMarketEntry, "revision">[] = [];
  const slugs = new Set<string>();
  const archivePaths = new Set<string>();
  for (const rawEntry of raw.entries) {
    signal?.throwIfAborted();
    if (!plainObject(rawEntry) || !exactKeys(rawEntry, [
      "slug", "name", "author", "description", "category", "tags", "version", "createdAt", "updatedAt",
      "downloads", "trendScore", "archive", "compressedBytes", "sha256"
    ])) throw marketError("SOURCE_MANIFEST_INVALID", "Skill market entry shape is invalid.");
    const slug = boundedSlug(rawEntry.slug);
    if (slugs.has(slug)) throw marketError("SOURCE_MANIFEST_INVALID", "Skill market entry slugs must be unique within a source.");
    slugs.add(slug);
    const entryName = boundedText(rawEntry.name, "Skill market entry name", MAXIMUM_NAME_CHARACTERS);
    const author = rawEntry.author === undefined ? undefined : boundedText(rawEntry.author, "Skill market entry author", MAXIMUM_NAME_CHARACTERS);
    const description = boundedText(rawEntry.description, "Skill market entry description", MAXIMUM_DESCRIPTION_CHARACTERS, true);
    const category = boundedText(rawEntry.category, "Skill market entry category", MAXIMUM_CATEGORY_CHARACTERS);
    const tags = boundedTags(rawEntry.tags);
    const version = boundedVersion(rawEntry.version);
    const createdAt = boundedTimestamp(rawEntry.createdAt, "Skill market entry createdAt");
    const updatedAt = boundedTimestamp(rawEntry.updatedAt, "Skill market entry updatedAt");
    if (updatedAt < createdAt) throw marketError("SOURCE_MANIFEST_INVALID", "Skill market entry updatedAt cannot precede createdAt.");
    const downloads = boundedUnsignedInteger(rawEntry.downloads, "Skill market entry downloads");
    const trendScore = boundedTrendScore(rawEntry.trendScore);
    const archiveRelativePath = portableSourceRelativePath(rawEntry.archive, "Skill market archive");
    if (!archiveRelativePath.toLocaleLowerCase("en-US").endsWith(".tgz")) {
      throw marketError("SOURCE_MANIFEST_INVALID", "Skill market archives must use the .tgz extension.");
    }
    const archivePathIdentity = archiveRelativePath.toLocaleLowerCase("en-US");
    if (archivePaths.has(archivePathIdentity)) throw marketError("SOURCE_MANIFEST_INVALID", "Skill market archive paths must be unique.");
    archivePaths.add(archivePathIdentity);
    const archiveBytes = boundedArchiveBytes(rawEntry.compressedBytes);
    if (typeof rawEntry.sha256 !== "string" || !ARCHIVE_SHA256.test(rawEntry.sha256)) {
      throw marketError("SOURCE_MANIFEST_INVALID", "Skill market archive SHA-256 must be 64 lowercase hexadecimal characters.");
    }
    const archiveSha256 = rawEntry.sha256;
    let archiveEntries: readonly SkillMarketArchiveEntry[];
    try {
      archiveEntries = (await inspectMarketArchive(root, archiveRelativePath, archiveBytes, archiveSha256, signal)).entries;
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw marketError("SOURCE_ARCHIVE_INVALID", boundedFailure(error instanceof Error ? error.message : String(error)) || "Skill market archive is invalid.");
    }
    const id = `skill_market_entry_${createHash("sha256").update(`${sourceId}\0${slug}`).digest("hex").slice(0, 32)}`;
    const contentRevision = digest({
      slug,
      name: entryName,
      author: author ?? null,
      description,
      category,
      tags,
      version,
      createdAt,
      updatedAt,
      downloads,
      trendScore,
      archiveBytes,
      archiveSha256,
      archiveEntries
    });
    entries.push({
      id,
      sourceId,
      contentRevision,
      slug,
      name: entryName,
      ...(author === undefined ? {} : { author }),
      description,
      category,
      tags,
      version,
      createdAt,
      updatedAt,
      downloads,
      trendScore,
      archiveBytes,
      archiveRelativePath,
      archiveSha256,
      archiveEntries
    });
  }
  entries.sort((left, right) => left.id.localeCompare(right.id, "en"));
  return {
    name,
    ...(displayName === undefined ? {} : { displayName }),
    contentRevision: digest({
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      gitRevision: gitRevision ?? null,
      entries: entries.map((entry) => [entry.id, entry.contentRevision])
    }),
    entries
  };
}

async function inspectDeclaredArchive(
  root: string,
  entry: StoredSkillMarketEntry,
  signal?: AbortSignal
): Promise<ArchiveFileIdentity> {
  const inspection = await inspectMarketArchive(root, entry.archiveRelativePath, entry.archiveBytes, entry.archiveSha256, signal);
  if (archiveEntryIdentity(inspection.entries) !== archiveEntryIdentity(entry.archiveEntries)) {
    throw marketError("SOURCE_CHANGED", "Skill market archive shape changed without a source refresh.");
  }
  return inspection.identity;
}

async function inspectMarketArchive(
  sourceRoot: string,
  archiveRelativePath: string,
  declaredBytes: number,
  declaredSha256: string,
  signal?: AbortSignal
): Promise<{ readonly identity: ArchiveFileIdentity; readonly entries: readonly SkillMarketArchiveEntry[] }> {
  signal?.throwIfAborted();
  const before = await stableArchiveIdentity(sourceRoot, archiveRelativePath, signal);
  if (before.size !== declaredBytes) throw new Error("Skill market archive compressed byte length does not match its manifest.");
  if (before.digest !== declaredSha256) throw new Error("Skill market archive SHA-256 does not match its manifest.");
  const entries = await parseSafeTarGzip(before.path, signal);
  const after = await stableArchiveIdentity(sourceRoot, archiveRelativePath, signal);
  if (!sameArchiveIdentity(before, after)) throw new Error("Skill market archive changed during validation.");
  return { identity: before, entries };
}

async function stableArchiveIdentity(sourceRoot: string, relativePath: string, signal?: AbortSignal): Promise<ArchiveFileIdentity> {
  const root = await canonicalDirectory(sourceRoot, "Skill market source");
  const candidate = resolve(root, ...relativePath.split("/"));
  if (!within(root, candidate)) throw new Error("Skill market archive escapes its source.");
  const original = await lstat(candidate);
  if (!original.isFile() || original.isSymbolicLink() || original.size < 1 || original.size > MAXIMUM_ARCHIVE_BYTES) {
    throw new Error("Skill market archive must be a bounded regular file.");
  }
  const canonical = await realpath(candidate);
  if (!within(root, canonical) || normalizedPath(canonical) !== normalizedPath(candidate)) {
    throw new Error("Skill market archive contains a path alias or junction.");
  }
  const handle = await open(canonical, constants.O_RDONLY);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== original.size || before.mtimeMs !== original.mtimeMs || !sameFilesystemIdentity(before, original)) {
      throw new Error("Skill market archive changed before validation.");
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, before.size - position), position);
      if (bytesRead === 0) throw new Error("Skill market archive ended during validation.");
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(candidate);
    const currentCanonical = await realpath(candidate);
    if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || !sameFilesystemIdentity(before, after)
      || !current.isFile() || current.isSymbolicLink() || current.size !== before.size || current.mtimeMs !== before.mtimeMs
      || !sameFilesystemIdentity(before, current) || normalizedPath(currentCanonical) !== normalizedPath(canonical)) {
      throw new Error("Skill market archive changed during validation.");
    }
    return {
      path: canonical,
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeMs: before.mtimeMs,
      digest: hash.digest("hex")
    };
  } finally {
    await handle.close();
  }
}

async function parseSafeTarGzip(path: string, signal?: AbortSignal): Promise<readonly SkillMarketArchiveEntry[]> {
  signal?.throwIfAborted();
  const stream = createReadStream(path, signal === undefined ? undefined : { signal }).pipe(createGunzip());
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let payloadBytesRemaining = 0;
  let zeroBlocks = 0;
  let ended = false;
  let decompressedBytes = 0;
  let totalFileBytes = 0;
  const exactPaths = new Set<string>();
  const caseFoldedPaths = new Set<string>();
  const itemKinds = new Map<string, "directory" | "file">();
  const items = new Map<string, SkillMarketArchiveEntry>();

  const registerDirectory = (key: string, explicit: boolean): void => {
    const folded = key.toLocaleLowerCase("en-US");
    const existing = itemKinds.get(folded);
    if (existing === "file") throw new Error("Skill market archive path is both a file and a directory.");
    const existingItem = items.get(folded);
    if (existingItem !== undefined && existingItem.key !== key) throw new Error("Skill market archive contains a case-colliding path key.");
    itemKinds.set(folded, "directory");
    if (!items.has(folded)) items.set(folded, { key, kind: "directory", size: 0 });
    if (explicit && caseFoldedPaths.has(folded)) throw new Error("Skill market archive contains a duplicate path key.");
    if (explicit) caseFoldedPaths.add(folded);
  };

  for await (const rawChunk of stream) {
    signal?.throwIfAborted();
    const chunk = rawChunk as Buffer;
    decompressedBytes += chunk.length;
    if (decompressedBytes > MAXIMUM_TAR_STREAM_BYTES) throw new Error("Skill market archive exceeds its decompressed byte budget.");
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    for (;;) {
      if (payloadBytesRemaining > 0) {
        if (buffer.length === 0) break;
        const consumed = Math.min(buffer.length, payloadBytesRemaining);
        buffer = buffer.subarray(consumed);
        payloadBytesRemaining -= consumed;
        if (payloadBytesRemaining > 0) break;
        continue;
      }
      if (buffer.length < 512) break;
      const header = buffer.subarray(0, 512);
      buffer = buffer.subarray(512);
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        if (zeroBlocks >= 2) ended = true;
        continue;
      }
      if (ended) throw new Error("Skill market archive contains data after its end marker.");
      zeroBlocks = 0;
      assertTarChecksum(header);
      const name = decodeTarField(header.subarray(0, 100), "path");
      const prefix = decodeTarField(header.subarray(345, 500), "prefix");
      const rawPath = prefix === "" ? name : `${prefix}/${name}`;
      const typeByte = header[156] ?? 0;
      const kind = typeByte === 0 || typeByte === 0x30
        ? "file"
        : typeByte === 0x35
          ? "directory"
          : undefined;
      if (kind === undefined) throw new Error("Skill market archive contains a link, special file, or unsupported metadata entry.");
      const size = parseTarOctal(header.subarray(124, 136), "size");
      if (kind === "directory" && size !== 0) throw new Error("Skill market archive directory has a payload.");
      const parsed = portableTarPath(rawPath, kind);
      if (exactPaths.has(parsed.rawIdentity)) throw new Error("Skill market archive contains a duplicate path key.");
      exactPaths.add(parsed.rawIdentity);
      if (parsed.key !== "") {
        const parts = parsed.key.split("/");
        for (let index = 1; index < parts.length; index += 1) registerDirectory(parts.slice(0, index).join("/"), false);
        const folded = parsed.key.toLocaleLowerCase("en-US");
        if (caseFoldedPaths.has(folded) || itemKinds.has(folded) && itemKinds.get(folded) !== kind) {
          throw new Error("Skill market archive contains a duplicate or case-colliding path key.");
        }
        if (kind === "directory") registerDirectory(parsed.key, true);
        else {
          caseFoldedPaths.add(folded);
          itemKinds.set(folded, "file");
          items.set(folded, { key: parsed.key, kind: "file", size });
          totalFileBytes += size;
          if (totalFileBytes > MAXIMUM_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error("Skill market archive exceeds its uncompressed byte budget.");
        }
        if (items.size > MAXIMUM_ARCHIVE_ENTRIES) throw new Error("Skill market archive contains too many items.");
      } else if (kind !== "directory") {
        throw new Error("Skill market archive package root must be a directory.");
      }
      payloadBytesRemaining = Math.ceil(size / 512) * 512;
    }
  }
  signal?.throwIfAborted();
  if (payloadBytesRemaining !== 0 || buffer.length !== 0 || !ended) throw new Error("Skill market archive is truncated or lacks a valid end marker.");
  const manifest = items.get("skill.md");
  if (manifest?.kind !== "file" || manifest.key !== "SKILL.md") {
    throw new Error("Skill market archive must contain a regular package/SKILL.md file.");
  }
  return [...items.values()].sort((left, right) => left.key.localeCompare(right.key, "en"));
}

function assertTarChecksum(header: Buffer): void {
  const expected = parseTarOctal(header.subarray(148, 156), "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  if (actual !== expected) throw new Error("Skill market archive contains an invalid tar checksum.");
}

function parseTarOctal(bytes: Buffer, label: string): number {
  if ((bytes[0] ?? 0) >= 0x80) throw new Error(`Skill market archive uses an unsupported binary tar ${label}.`);
  const text = bytes.toString("ascii").replace(/[\0 ]+$/u, "").replace(/^ +/u, "");
  if (text === "") return 0;
  if (!/^[0-7]+$/u.test(text)) throw new Error(`Skill market archive contains an invalid tar ${label}.`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Skill market archive tar ${label} is out of range.`);
  return value;
}

function decodeTarField(bytes: Buffer, label: string): string {
  const firstNull = bytes.indexOf(0);
  const content = firstNull < 0 ? bytes : bytes.subarray(0, firstNull);
  if (firstNull >= 0 && bytes.subarray(firstNull).some((byte) => byte !== 0)) {
    throw new Error(`Skill market archive tar ${label} contains hidden bytes.`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(`Skill market archive tar ${label} is not valid UTF-8.`);
  }
}

function portableTarPath(rawValue: string, kind: "directory" | "file"): { readonly key: string; readonly rawIdentity: string } {
  if (rawValue === "" || rawValue.length > 520 || rawValue.includes("\\") || rawValue.startsWith("/") || isAbsolute(rawValue)
    || /^[A-Za-z]:/u.test(rawValue) || FORBIDDEN_TEXT.test(rawValue)) {
    throw new Error("Skill market archive contains an unsafe tar path.");
  }
  const value = kind === "directory" && rawValue.endsWith("/") ? rawValue.slice(0, -1) : rawValue;
  if (value.endsWith("/") || value.includes("//")) throw new Error("Skill market archive contains a malformed tar path.");
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error("Skill market archive contains path traversal.");
  if (parts[0] !== "package") throw new Error("Skill market archive must use a single package/ root.");
  if (parts.length > 33) throw new Error("Skill market archive path is too deep.");
  const keyParts = parts.slice(1);
  for (const part of keyParts) assertPortablePart(part, "Skill market archive path");
  const key = keyParts.join("/");
  if (key.length > 512) throw new Error("Skill market archive path is too long.");
  return { key, rawIdentity: value };
}

async function extractVerifiedArchive(
  archive: ArchiveFileIdentity,
  expectedEntries: readonly SkillMarketArchiveEntry[],
  privateParent: string,
  maximumFiles: number,
  maximumBytes: number,
  signal?: AbortSignal
): Promise<PiSkillPackageInspection> {
  signal?.throwIfAborted();
  const destination = normalizedAbsolute(privateParent, "Skill market extraction destination");
  if (await lstat(destination).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) throw new Error("Skill market extraction destination must be fresh.");
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const expected = new Map(expectedEntries.map((entry) => [entry.key.toLocaleLowerCase("en-US"), entry]));
  const seenFiles = new Set<string>();
  try {
    await extractTarArchive({
      file: archive.path,
      cwd: destination,
      gzip: true,
      strict: true,
      preservePaths: false,
      unlink: true,
      noChmod: true,
      noMtime: true,
      maxDepth: 33,
      maxDecompressionRatio: 10_000,
      filter: (path, tarEntry) => {
        signal?.throwIfAborted();
        const tarType = "type" in tarEntry ? tarEntry.type : undefined;
        const kind = tarType === "File" || tarType === "OldFile"
          ? "file"
          : tarType === "Directory"
            ? "directory"
            : undefined;
        if (kind === undefined) throw new Error("Skill market archive changed to an unsafe entry type.");
        const parsed = portableTarPath(path, kind);
        if (parsed.key === "") return true;
        const expectedEntry = expected.get(parsed.key.toLocaleLowerCase("en-US"));
        if (expectedEntry === undefined || expectedEntry.key !== parsed.key || expectedEntry.kind !== kind
          || kind === "file" && expectedEntry.size !== tarEntry.size) {
          throw new Error("Skill market archive shape changed during extraction.");
        }
        if (kind === "file") {
          const folded = parsed.key.toLocaleLowerCase("en-US");
          if (seenFiles.has(folded)) throw new Error("Skill market archive contains a duplicate file.");
          seenFiles.add(folded);
        }
        return true;
      }
    });
    signal?.throwIfAborted();
    const expectedFiles = expectedEntries.filter((entry) => entry.kind === "file");
    if (seenFiles.size !== expectedFiles.length || expectedFiles.some((entry) => !seenFiles.has(entry.key.toLocaleLowerCase("en-US")))) {
      throw new Error("Skill market archive extraction omitted an expected file.");
    }
    const after = await stableAbsoluteArchiveIdentity(archive.path, signal);
    if (!sameArchiveIdentity(archive, after)) throw new Error("Skill market archive changed during extraction.");
    const packageRoot = join(destination, "package");
    const inspection = await inspectPiSkillPackage(packageRoot, maximumFiles, maximumBytes, signal);
    const declaredFileBytes = expectedFiles.reduce((total, entry) => total + entry.size, 0);
    if (inspection.bytes !== declaredFileBytes) throw new Error("Skill market archive extracted byte count changed.");
    return inspection;
  } catch (error) {
    await removePrivatePath(destination).catch(() => undefined);
    throw error;
  }
}

async function stableAbsoluteArchiveIdentity(path: string, signal?: AbortSignal): Promise<ArchiveFileIdentity> {
  const canonical = await realpath(path);
  if (normalizedPath(canonical) !== normalizedPath(path)) throw new Error("Skill market archive changed identity.");
  const info = await lstat(canonical);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAXIMUM_ARCHIVE_BYTES) throw new Error("Skill market archive changed identity.");
  const handle = await open(canonical, constants.O_RDONLY);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFilesystemIdentity(before, info) || before.size !== info.size || before.mtimeMs !== info.mtimeMs) {
      throw new Error("Skill market archive changed identity.");
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, before.size - position), position);
      if (bytesRead === 0) throw new Error("Skill market archive ended while it was read.");
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (!sameFilesystemIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("Skill market archive changed while it was read.");
    }
    return { path: canonical, dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs, digest: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function inspectPreviewTree(root: string): Promise<readonly SkillMarketArchiveEntry[]> {
  const entries: SkillMarketArchiveEntry[] = [];
  const visit = async (directory: string, parentKey: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const key = parentKey === "" ? child.name : `${parentKey}/${child.name}`;
      const path = join(directory, child.name);
      const info = await lstat(path);
      if (child.isSymbolicLink() || info.isSymbolicLink()) throw new Error("Skill market preview contains a symlink.");
      if (child.isDirectory() && info.isDirectory()) {
        entries.push({ key, kind: "directory", size: 0 });
        await visit(path, key);
      } else if (child.isFile() && info.isFile()) {
        entries.push({ key, kind: "file", size: info.size });
      } else throw new Error("Skill market preview contains a special file.");
      if (entries.length > MAXIMUM_ARCHIVE_ENTRIES) throw new Error("Skill market preview contains too many items.");
    }
  };
  await visit(root, "");
  return entries;
}

function publicSource(source: StoredSkillMarketSource): SkillMarketSourceDescriptor {
  return {
    id: source.id,
    revision: BigInt(source.revision),
    kind: source.source.kind,
    display: sourceDisplay(source.source),
    name: source.name,
    ...(source.displayName === undefined ? {} : { displayName: source.displayName }),
    state: source.state,
    contentRevision: source.contentRevision,
    entryCount: source.entries.length,
    addedAt: source.addedAt,
    ...(source.refreshedAt === undefined ? {} : { refreshedAt: source.refreshedAt }),
    ...(source.error === undefined ? {} : { error: source.error })
  };
}

function publicEntry(entry: StoredSkillMarketEntry): SkillMarketEntryDescriptor {
  return {
    id: entry.id,
    sourceId: entry.sourceId,
    revision: BigInt(entry.revision),
    contentRevision: entry.contentRevision,
    slug: entry.slug,
    name: entry.name,
    ...(entry.author === undefined ? {} : { author: entry.author }),
    description: entry.description,
    category: entry.category,
    tags: [...entry.tags],
    version: entry.version,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    downloads: entry.downloads,
    trendScore: entry.trendScore,
    archiveBytes: entry.archiveBytes
  };
}

function publicCatalogItem(
  source: StoredSkillMarketSource,
  entry: StoredSkillMarketEntry,
  resources?: PiResourceManager
): SkillMarketCatalogItem {
  return {
    ...publicEntry(entry),
    sourceRevision: BigInt(source.revision),
    sourceName: source.name,
    ...(source.displayName === undefined ? {} : { sourceDisplayName: source.displayName }),
    sourceState: source.state,
    ...(source.error === undefined ? {} : { sourceError: source.error }),
    installStatuses: marketInstallStatuses(source, entry, resources)
  };
}

function marketInstallStatuses(
  source: StoredSkillMarketSource,
  entry: StoredSkillMarketEntry,
  resources?: PiResourceManager
): readonly SkillMarketInstallStatus[] {
  if (resources === undefined) return [];
  return resources.list({ kind: "skill" })
    .filter((resource) => resource.state !== "removed" && (
      resource.name === entry.slug
      || resource.skillMarket?.sourceId === source.id && resource.skillMarket.entryId === entry.id
    ))
    .map((resource) => ({
      resourceId: resource.id,
      resourceRevision: resource.versionNumber,
      backendId: resource.backendId,
      ...(resource.targetId === undefined ? {} : { targetId: resource.targetId }),
      scope: resource.scope === "project" ? "project" as const : "global" as const,
      ...(resource.scope !== "project" ? {} : { relativeParent: resource.skillMarket?.relativeParent ?? ".agents/skills" }),
      state: marketInstallStatusState(source, entry, resource),
      ...(resource.version === undefined ? {} : { installedVersion: resource.version })
    }))
    .sort((left, right) => Number(left.scope === "project") - Number(right.scope === "project")
      || left.backendId.localeCompare(right.backendId, "en")
      || (left.targetId ?? "").localeCompare(right.targetId ?? "", "en")
      || left.resourceId.localeCompare(right.resourceId, "en"));
}

function marketInstallStatusState(
  source: StoredSkillMarketSource,
  entry: StoredSkillMarketEntry,
  resource: PiResourceDescriptor
): SkillMarketInstallStatusState {
  const provenance = resource.skillMarket;
  if (provenance === undefined || provenance.sourceId !== source.id || provenance.entryId !== entry.id) return "conflict";
  if (resource.discoveredRevision !== provenance.installedContentRevision) return "conflict";
  const installedVersion = resource.version;
  if (installedVersion === undefined || semver.valid(installedVersion) === null) return "conflict";
  const comparison = semver.compare(entry.version, installedVersion);
  if (comparison < 0) return "conflict";
  if (comparison === 0 && provenance.entryContentRevision !== entry.contentRevision) return "conflict";
  if (comparison > 0) return "update_available";
  return "installed";
}

function publicPreview(preview: PreviewSession): SkillMarketPreviewDescriptor {
  return {
    id: preview.id,
    entry: { ...preview.lease.entry, tags: [...preview.lease.entry.tags] },
    snapshotRevision: preview.inspection.revision,
    files: preview.inspection.files,
    bytes: preview.inspection.bytes,
    expiresAt: preview.expiresAt
  };
}

function publicInstallPlan(plan: InstallPlanSession): SkillMarketInstallPlanDescriptor {
  return {
    id: plan.id,
    entry: { ...plan.lease.entry, tags: [...plan.lease.entry.tags] },
    target: { ...plan.target },
    resourcePreview: {
      ...plan.preview,
      ...(plan.preview.currentResource === undefined ? {} : { currentResource: { ...plan.preview.currentResource } }),
      changes: plan.preview.changes.map((change) => ({ ...change }))
    },
    confirmationReasons: [...plan.confirmationReasons],
    requiresConfirmation: plan.confirmationReasons.length > 0,
    expiresAt: plan.expiresAt
  };
}

function marketInstallConfirmationReasons(
  preview: PiMarketSkillPreview,
  availableVersion: string
): readonly SkillMarketInstallConfirmationReason[] {
  const reasons = new Set<SkillMarketInstallConfirmationReason>();
  if (preview.sourceReplacement) reasons.add("SOURCE_REPLACEMENT");
  if (preview.currentResource !== undefined && preview.currentResource.sourceKind !== "skill_market") reasons.add("LOCAL_OWNERSHIP");
  if (preview.currentResource?.dirty === true) reasons.add("DIRTY_CONTENT");
  if (preview.unregisteredDestination) reasons.add("UNREGISTERED_DESTINATION");
  const currentVersion = preview.currentResource?.version;
  if (currentVersion !== undefined && semver.valid(currentVersion) !== null && semver.compare(availableVersion, currentVersion) < 0) {
    reasons.add("DOWNGRADE");
  }
  return [...reasons];
}

function catalogComparator(sort: SkillMarketSort): (left: SkillMarketCatalogItem, right: SkillMarketCatalogItem) => number {
  const numeric = sort === "trending"
    ? (entry: SkillMarketCatalogItem) => entry.trendScore
    : sort === "downloads"
      ? (entry: SkillMarketCatalogItem) => entry.downloads
      : sort === "updated"
        ? (entry: SkillMarketCatalogItem) => entry.updatedAt
        : (entry: SkillMarketCatalogItem) => entry.createdAt;
  return (left, right) => numeric(right) - numeric(left)
    || left.name.localeCompare(right.name, "en")
    || left.sourceId.localeCompare(right.sourceId, "en")
    || left.id.localeCompare(right.id, "en");
}

function marketSearchText(entry: SkillMarketCatalogItem): string {
  return [entry.slug, entry.name, entry.author ?? "", entry.description, entry.category, ...entry.tags, entry.sourceName, entry.sourceDisplayName ?? ""]
    .join("\n")
    .toLocaleLowerCase("en-US");
}

function normalizedOptionalQuery(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const query = value.trim();
  if (query.length > MAXIMUM_QUERY_CHARACTERS || FORBIDDEN_TEXT.test(query)) throw marketError("SOURCE_INVALID", "Skill market query is invalid.");
  return query === "" ? undefined : query.toLocaleLowerCase("en-US");
}

function normalizedOptionalCategory(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const category = value.trim();
  if (category === "") return undefined;
  if (category.length > MAXIMUM_CATEGORY_CHARACTERS || FORBIDDEN_TEXT.test(category)) {
    throw marketError("SOURCE_INVALID", "Skill market category is invalid.");
  }
  return category.toLocaleLowerCase("en-US");
}

function isSkillMarketSort(value: unknown): value is SkillMarketSort {
  return value === "trending" || value === "downloads" || value === "updated" || value === "created";
}

function boundedText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value !== value.trim() || value.length > maximum || FORBIDDEN_TEXT.test(value)
    || !allowEmpty && value === "") throw marketError("SOURCE_MANIFEST_INVALID", `${label} is invalid.`);
  return value;
}

function boundedSlug(value: unknown): string {
  if (typeof value !== "string" || !SLUG.test(value)) throw marketError("SOURCE_MANIFEST_INVALID", "Skill market entry slug is invalid.");
  return value;
}

function boundedTags(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_TAGS) throw marketError("SOURCE_MANIFEST_INVALID", "Skill market entry tags are invalid.");
  const tags = value.map((tag) => boundedText(tag, "Skill market entry tag", MAXIMUM_TAG_CHARACTERS));
  if (new Set(tags.map((tag) => tag.toLocaleLowerCase("en-US"))).size !== tags.length) {
    throw marketError("SOURCE_MANIFEST_INVALID", "Skill market entry tags must be unique.");
  }
  return tags;
}

function boundedVersion(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || value !== value.trim() || semver.valid(value) !== value) {
    throw marketError("SOURCE_MANIFEST_INVALID", "Skill market entry version must be a canonical semantic version.");
  }
  return value;
}

function boundedTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || value !== value.trim() || value.length > 64
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw marketError("SOURCE_MANIFEST_INVALID", `${label} must be an RFC 3339 timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw marketError("SOURCE_MANIFEST_INVALID", `${label} is out of range.`);
  return parsed;
}

function boundedUnsignedInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw marketError("SOURCE_MANIFEST_INVALID", `${label} is invalid.`);
  return value;
}

function boundedTrendScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000_000_000) {
    throw marketError("SOURCE_MANIFEST_INVALID", "Skill market entry trendScore is invalid.");
  }
  return value;
}

function boundedArchiveBytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_ARCHIVE_BYTES) {
    throw marketError("SOURCE_MANIFEST_INVALID", `Skill market archive compressedBytes must be between 1 and ${MAXIMUM_ARCHIVE_BYTES}.`);
  }
  return value;
}

function portableSourceRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string") throw marketError("SOURCE_MANIFEST_INVALID", `${label} path is invalid.`);
  const path = value.trim();
  if (path === "" || path !== value || path.length > 512 || path.includes("\\") || path.startsWith("/") || isAbsolute(path)
    || /^[A-Za-z]:/u.test(path) || FORBIDDEN_TEXT.test(path)) throw marketError("SOURCE_MANIFEST_INVALID", `${label} path is invalid.`);
  const parts = path.split("/");
  if (parts.length > 32 || parts.some((part) => part === "" || part === "." || part === ".." || part.toLocaleLowerCase("en-US") === ".git")) {
    throw marketError("SOURCE_MANIFEST_INVALID", `${label} path is invalid.`);
  }
  for (const part of parts) assertPortablePart(part, `${label} path`);
  return path;
}

function portablePreviewKey(value: string): string {
  if (typeof value !== "string" || value === "" || value !== value.trim() || value.length > 512 || value.includes("\\")
    || value.startsWith("/") || isAbsolute(value) || /^[A-Za-z]:/u.test(value) || FORBIDDEN_TEXT.test(value)) {
    throw marketError("PREVIEW_NOT_FOUND", "Skill market preview file key is invalid.");
  }
  const parts = value.split("/");
  if (parts.length > 32 || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw marketError("PREVIEW_NOT_FOUND", "Skill market preview file key is invalid.");
  }
  for (const part of parts) assertPortablePart(part, "Skill market preview key");
  return value;
}

function assertPortablePart(value: string, label: string): void {
  if (value.length > 255 || /[<>:"|?*\u0000-\u001f]/u.test(value) || /[. ]$/u.test(value) || isWindowsReservedName(value)) {
    throw new Error(`${label} contains a non-portable name.`);
  }
}

function isWindowsReservedName(value: string): boolean {
  const stem = value.split(".")[0]!.toLocaleUpperCase("en-US");
  return stem === "CON" || stem === "PRN" || stem === "AUX" || stem === "NUL"
    || /^COM[1-9]$/u.test(stem) || /^LPT[1-9]$/u.test(stem);
}

function boundedConnectionId(value: string): string {
  const id = value.trim();
  if (id === "" || id.length > 256 || FORBIDDEN_TEXT.test(id)) throw marketError("SOURCE_INVALID", "Connection identity is invalid.");
  return id;
}

function archiveEntryIdentity(entries: readonly SkillMarketArchiveEntry[]): string {
  return JSON.stringify(entries.map((entry) => [entry.key, entry.kind, entry.size]));
}

function sameArchiveIdentity(left: ArchiveFileIdentity, right: ArchiveFileIdentity): boolean {
  return normalizedPath(left.path) === normalizedPath(right.path) && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.digest === right.digest;
}

async function readStableAbsoluteFile(
  path: string,
  root: string,
  maximumBytes: number,
  signal?: AbortSignal
): Promise<Buffer> {
  signal?.throwIfAborted();
  const original = await lstat(path);
  if (!original.isFile() || original.isSymbolicLink() || original.size > maximumBytes) throw new Error("File is not a bounded regular file.");
  const canonical = await realpath(path);
  if (!within(root, canonical) || normalizedPath(canonical) !== normalizedPath(path)) throw new Error("File escapes its source or contains an alias.");
  const handle = await open(canonical, constants.O_RDONLY);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== original.size || before.mtimeMs !== original.mtimeMs || !sameFilesystemIdentity(before, original)) {
      throw new Error("File changed before its safe read.");
    }
    signal?.throwIfAborted();
    const bytes = await handle.readFile();
    signal?.throwIfAborted();
    const after = await handle.stat();
    const current = await lstat(path);
    const currentCanonical = await realpath(path);
    if (bytes.length !== before.size || !after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || !sameFilesystemIdentity(before, after) || !current.isFile() || current.isSymbolicLink()
      || current.size !== before.size || current.mtimeMs !== before.mtimeMs || !sameFilesystemIdentity(before, current)
      || normalizedPath(currentCanonical) !== normalizedPath(canonical)) throw new Error("File changed during its safe read.");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readStableContainedFile(root: string, key: string, maximumBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const canonicalRoot = await canonicalDirectory(root, "Skill market preview root");
  const path = resolve(canonicalRoot, ...key.split("/"));
  if (!within(canonicalRoot, path)) throw marketError("PREVIEW_NOT_FOUND", "Skill market preview file was not found.");
  return readStableAbsoluteFile(path, canonicalRoot, maximumBytes, signal);
}

async function canonicalDirectory(value: string, label: string): Promise<string> {
  const path = normalizedAbsolute(value, label);
  const original = await lstat(path);
  if (!original.isDirectory() || original.isSymbolicLink()) throw marketError("SOURCE_INVALID", `${label} must be a regular directory.`);
  const canonical = await realpath(path);
  if (normalizedPath(canonical) !== normalizedPath(path)) throw marketError("SOURCE_INVALID", `${label} contains a path alias or junction.`);
  const current = await lstat(canonical);
  if (!current.isDirectory() || current.isSymbolicLink() || !sameFilesystemIdentity(original, current)) {
    throw marketError("SOURCE_INVALID", `${label} changed identity.`);
  }
  return canonical;
}

async function assertCanonicalDirectory(path: string, label: string): Promise<void> {
  await canonicalDirectory(path, label);
}

async function assertContainedDirectory(root: string, path: string, label: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  const candidate = normalizedAbsolute(path, label);
  if (!within(canonicalRoot, candidate)) throw new Error(`${label} escapes its owner root.`);
  const original = await lstat(candidate);
  if (!original.isDirectory() || original.isSymbolicLink()) throw new Error(`${label} must be a regular directory.`);
  const canonical = await realpath(candidate);
  if (!within(canonicalRoot, canonical) || normalizedPath(canonical) !== normalizedPath(candidate)) throw new Error(`${label} contains a path alias.`);
}

function normalizedAbsolute(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value) throw new Error(`${label} must be a normalized absolute path.`);
  return value;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function normalizedPath(path: string): string {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

function sameFilesystemIdentity(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function removePrivatePath(path: string): Promise<void> {
  const exact = normalizedAbsolute(path, "Private Skill market path");
  if (dirname(exact) === exact) throw new Error("Refusing to remove a filesystem root.");
  await rm(exact, { recursive: true, force: true });
}

async function cloneGitSource(
  source: Extract<SkillMarketSourceInput, { readonly kind: "git" }>,
  destination: string,
  git: SkillMarketGitExecutor,
  signal?: AbortSignal
): Promise<string> {
  try {
    signal?.throwIfAborted();
    if (source.sparsePaths.length === 0) {
      await git(["clone", source.repositoryUrl, destination], { timeoutMs: GIT_OPERATION_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) });
      if (source.ref !== undefined) {
        await git(["checkout", "--detach", source.ref], { cwd: destination, timeoutMs: GIT_OPERATION_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) });
      }
    } else {
      await git(["clone", "--filter=blob:none", "--no-checkout", source.repositoryUrl, destination], {
        timeoutMs: GIT_OPERATION_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal })
      });
      await git(["sparse-checkout", "set", "--", ...source.sparsePaths], {
        cwd: destination,
        timeoutMs: GIT_OPERATION_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal })
      });
      await git(["checkout", "--detach", source.ref ?? "HEAD"], {
        cwd: destination,
        timeoutMs: GIT_OPERATION_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal })
      });
    }
    signal?.throwIfAborted();
    const revision = (await git(["rev-parse", "HEAD"], {
      cwd: destination,
      timeoutMs: 10_000,
      ...(signal === undefined ? {} : { signal })
    })).stdout.trim();
    if (!GIT_REVISION.test(revision)) throw new Error("Git returned an invalid revision.");
    return revision.toLocaleLowerCase("en-US");
  } catch (error) {
    if (isAbortError(error) || signal?.aborted === true) throw error;
    throw classifyGitError(error);
  }
}

async function gitVersion(git: SkillMarketGitExecutor): Promise<{ readonly major: number; readonly minor: number; readonly patch: number } | undefined> {
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

function classifyGitError(error: unknown): SkillMarketError {
  if (error instanceof SkillMarketError) return error;
  const raw = error instanceof Error ? `${error.message}\n${String((error as { readonly stderr?: unknown }).stderr ?? "")}` : String(error);
  const detail = boundedFailure(redactAbsolutePaths(raw));
  if (/Remote branch \S+ not found|Couldn't find remote ref|couldn't find remote ref|pathspec .* did not match/iu.test(raw)) {
    return marketError("SOURCE_GIT_REF_NOT_FOUND", detail || "Git ref was not found.");
  }
  if (/Authentication failed|could not read Username|Repository not found|Permission denied \(publickey\)|Host key verification failed|Could not read from remote repository|SAML SSO/iu.test(raw)) {
    return marketError("SOURCE_GIT_AUTH_FAILED", detail || "Git authentication failed.");
  }
  return marketError("SOURCE_GIT_FAILED", detail || "Git Skill market source acquisition failed.");
}

function normalizeSparsePath(value: string): string {
  const path = value.trim();
  if (path === "" || path.length > 256 || FORBIDDEN_TEXT.test(path) || path.includes("\\")
    || path.startsWith("/") || path.startsWith("-") || isAbsolute(path)
    || path.split("/").some((part) => part === "" || part === "." || part === ".." || part.toLocaleLowerCase("en-US") === ".git")) {
    throw marketError("SOURCE_INVALID", "Git Skill market sparse path is invalid.");
  }
  return path;
}

function isValidGitRef(value: string): boolean {
  if (value === "" || FORBIDDEN_TEXT.test(value) || !GIT_REF.test(value)
    || value.includes("..") || value.includes("@{") || value.includes("//")
    || value.endsWith("/") || value.endsWith(".")) return false;
  return !value.split("/").some((part) => part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"));
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

function sourceDisplay(source: SkillMarketSourceInput): string {
  if (source.kind === "local") return basename(source.path) || "Local Skill market";
  return `${source.repositoryUrl}${source.ref === undefined ? "" : `#${source.ref}`}`;
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
  if (!GENERATION_ID.test(value)) throw new Error("Skill market generation pointer is invalid.");
  const temporary = `${path}.tmp-${randomUUID()}`;
  const backup = `${path}.bak`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
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
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128) return undefined;
    const value = readFileSync(candidate, "utf8").trim();
    return GENERATION_ID.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function validateStoredMarkets(value: unknown): StoredSkillMarkets {
  if (!plainObject(value) || !exactKeys(value, ["format", "revision", "sources"]) || value.format !== 1
    || typeof value.revision !== "string" || !DECIMAL_REVISION.test(value.revision) || !Array.isArray(value.sources)) {
    throw new Error("Stored Skill markets are invalid.");
  }
  if (value.sources.length > MAXIMUM_ENTRY_REVISION_HISTORY) throw new Error("Stored Skill market source count is invalid.");
  return value as unknown as StoredSkillMarkets;
}

function validateStoredSource(value: unknown): StoredSkillMarketSource {
  if (!plainObject(value) || !exactKeys(value, [
    "id", "revision", "source", "sourceIdentity", "name", "displayName", "state", "contentRevision", "entries",
    "entryRevisionHistory", "addedAt", "refreshedAt", "activeGeneration", "error"
  ]) || !plainObject(value.source)) throw new Error("Stored Skill market source shape is invalid.");
  if (value.source.kind === "local" && !exactKeys(value.source, ["kind", "path"])
    || value.source.kind === "git" && !exactKeys(value.source, ["kind", "repositoryUrl", "ref", "sparsePaths"])
    || value.source.kind !== "local" && value.source.kind !== "git") throw new Error("Stored Skill market input is invalid.");
  const source = normalizeSkillMarketSourceInput(value.source as unknown as SkillMarketSourceInput, "C:\\invalid-home-must-not-expand");
  if (source.kind === "local" && (!isAbsolute(source.path) || resolve(source.path) !== source.path)) throw new Error("Stored local Skill market path is invalid.");
  if (typeof value.id !== "string" || !SOURCE_ID.test(value.id)
    || typeof value.revision !== "string" || !DECIMAL_REVISION.test(value.revision) || value.revision === "0"
    || typeof value.sourceIdentity !== "string" || value.sourceIdentity !== skillMarketSourceIdentity(source)
    || typeof value.name !== "string" || storedBoundedText(value.name, MAXIMUM_NAME_CHARACTERS, false) !== value.name
    || value.displayName !== undefined && (typeof value.displayName !== "string" || storedBoundedText(value.displayName, MAXIMUM_NAME_CHARACTERS, false) !== value.displayName)
    || value.state !== "ready" && value.state !== "error"
    || typeof value.contentRevision !== "string" || !CONTENT_REVISION.test(value.contentRevision)
    || !Array.isArray(value.entries) || value.entries.length > MAXIMUM_ENTRIES
    || !plainObject(value.entryRevisionHistory) || Object.keys(value.entryRevisionHistory).length > MAXIMUM_ENTRY_REVISION_HISTORY
    || typeof value.addedAt !== "number" || !Number.isSafeInteger(value.addedAt) || value.addedAt < 0
    || value.refreshedAt !== undefined && (typeof value.refreshedAt !== "number" || !Number.isSafeInteger(value.refreshedAt) || value.refreshedAt < value.addedAt)
    || value.activeGeneration !== undefined && (typeof value.activeGeneration !== "string" || !GENERATION_ID.test(value.activeGeneration))
    || value.error !== undefined && (typeof value.error !== "string" || value.error !== boundedFailure(value.error))) {
    throw new Error("Stored Skill market source fields are invalid.");
  }
  if ((source.kind === "git" ? value.activeGeneration === undefined : value.activeGeneration !== undefined)
    || (value.state === "error") !== (value.error !== undefined)) throw new Error("Stored Skill market source generation or state is invalid.");
  const history: Record<string, string> = {};
  for (const [slug, revision] of Object.entries(value.entryRevisionHistory)) {
    if (!SLUG.test(slug) || typeof revision !== "string" || !DECIMAL_REVISION.test(revision) || revision === "0") {
      throw new Error("Stored Skill market entry revision history is invalid.");
    }
    history[slug] = revision;
  }
  const entries = value.entries.map((entry) => validateStoredEntry(entry, value.id as string, history));
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length || new Set(entries.map((entry) => entry.slug)).size !== entries.length) {
    throw new Error("Stored Skill market entries contain duplicate identities.");
  }
  return { ...value, source, entries, entryRevisionHistory: history } as unknown as StoredSkillMarketSource;
}

function validateStoredEntry(value: unknown, sourceId: string, history: Readonly<Record<string, string>>): StoredSkillMarketEntry {
  if (!plainObject(value) || !exactKeys(value, [
    "id", "sourceId", "revision", "contentRevision", "slug", "name", "author", "description", "category", "tags", "version",
    "createdAt", "updatedAt", "downloads", "trendScore", "archiveBytes", "archiveRelativePath", "archiveSha256", "archiveEntries"
  ])) throw new Error("Stored Skill market entry shape is invalid.");
  if (typeof value.slug !== "string" || !SLUG.test(value.slug)
    || typeof value.id !== "string" || value.id !== `skill_market_entry_${createHash("sha256").update(`${sourceId}\0${value.slug}`).digest("hex").slice(0, 32)}`
    || value.sourceId !== sourceId
    || typeof value.revision !== "string" || value.revision !== history[value.slug]
    || typeof value.contentRevision !== "string" || !CONTENT_REVISION.test(value.contentRevision)
    || typeof value.name !== "string" || storedBoundedText(value.name, MAXIMUM_NAME_CHARACTERS, false) !== value.name
    || value.author !== undefined && (typeof value.author !== "string" || storedBoundedText(value.author, MAXIMUM_NAME_CHARACTERS, false) !== value.author)
    || typeof value.description !== "string" || storedBoundedText(value.description, MAXIMUM_DESCRIPTION_CHARACTERS, true) !== value.description
    || typeof value.category !== "string" || storedBoundedText(value.category, MAXIMUM_CATEGORY_CHARACTERS, false) !== value.category
    || !Array.isArray(value.tags) || value.tags.length > MAXIMUM_TAGS
    || typeof value.version !== "string" || semver.valid(value.version) !== value.version
    || typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || typeof value.updatedAt !== "number" || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt
    || typeof value.downloads !== "number" || !Number.isSafeInteger(value.downloads) || value.downloads < 0
    || typeof value.trendScore !== "number" || !Number.isFinite(value.trendScore) || value.trendScore < 0 || value.trendScore > 1_000_000_000_000
    || typeof value.archiveBytes !== "number" || !Number.isSafeInteger(value.archiveBytes) || value.archiveBytes < 1 || value.archiveBytes > MAXIMUM_ARCHIVE_BYTES
    || typeof value.archiveRelativePath !== "string" || storedPortableSourcePath(value.archiveRelativePath) !== value.archiveRelativePath
    || !value.archiveRelativePath.toLocaleLowerCase("en-US").endsWith(".tgz")
    || typeof value.archiveSha256 !== "string" || !ARCHIVE_SHA256.test(value.archiveSha256)
    || !Array.isArray(value.archiveEntries)) throw new Error("Stored Skill market entry fields are invalid.");
  const tags = value.tags.map((tag) => {
    if (typeof tag !== "string" || storedBoundedText(tag, MAXIMUM_TAG_CHARACTERS, false) !== tag) throw new Error("Stored Skill market tags are invalid.");
    return tag;
  });
  if (new Set(tags.map((tag) => tag.toLocaleLowerCase("en-US"))).size !== tags.length) throw new Error("Stored Skill market tags are duplicated.");
  const archiveEntries = validateStoredArchiveEntries(value.archiveEntries);
  const expectedContentRevision = digest({
    slug: value.slug,
    name: value.name,
    author: value.author ?? null,
    description: value.description,
    category: value.category,
    tags,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    downloads: value.downloads,
    trendScore: value.trendScore,
    archiveBytes: value.archiveBytes,
    archiveSha256: value.archiveSha256,
    archiveEntries
  });
  if (value.contentRevision !== expectedContentRevision) throw new Error("Stored Skill market entry content revision is invalid.");
  return { ...value, tags, archiveEntries } as unknown as StoredSkillMarketEntry;
}

function validateStoredArchiveEntries(value: readonly unknown[]): readonly SkillMarketArchiveEntry[] {
  if (value.length > MAXIMUM_ARCHIVE_ENTRIES) throw new Error("Stored Skill market archive entry count is invalid.");
  const entries = value.map((item) => {
    if (!plainObject(item) || !exactKeys(item, ["key", "kind", "size"]) || typeof item.key !== "string"
      || item.key === "" || storedPortablePreviewKey(item.key) !== item.key
      || item.kind !== "directory" && item.kind !== "file"
      || typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0
      || item.kind === "directory" && item.size !== 0) throw new Error("Stored Skill market archive entry is invalid.");
    return { key: item.key, kind: item.kind, size: item.size } as SkillMarketArchiveEntry;
  });
  if (entries.some((entry, index) => index > 0 && entries[index - 1]!.key.localeCompare(entry.key, "en") >= 0)
    || new Set(entries.map((entry) => entry.key.toLocaleLowerCase("en-US"))).size !== entries.length
    || !entries.some((entry) => entry.key === "SKILL.md" && entry.kind === "file")
    || entries.filter((entry) => entry.kind === "file").reduce((total, entry) => total + entry.size, 0) > MAXIMUM_ARCHIVE_UNCOMPRESSED_BYTES) {
    throw new Error("Stored Skill market archive tree is invalid.");
  }
  return entries;
}

function storedBoundedText(value: string, maximum: number, allowEmpty: boolean): string {
  if (value !== value.trim() || value.length > maximum || FORBIDDEN_TEXT.test(value) || !allowEmpty && value === "") throw new Error("Stored text is invalid.");
  return value;
}

function storedPortableSourcePath(value: string): string {
  try {
    return portableSourceRelativePath(value, "Stored Skill market archive");
  } catch {
    throw new Error("Stored Skill market archive path is invalid.");
  }
}

function storedPortablePreviewKey(value: string): string {
  try {
    return portablePreviewKey(value);
  } catch {
    throw new Error("Stored Skill market archive key is invalid.");
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const names = new Set(allowed);
  return Object.keys(value).every((key) => names.has(key));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function increment(value: string): string {
  return (BigInt(value) + 1n).toString(10);
}

function marketError(code: SkillMarketErrorCode, message: string): SkillMarketError {
  return new SkillMarketError(code, message);
}

function normalizeMarketError(error: unknown, fallback: SkillMarketErrorCode = "SOURCE_INVALID"): SkillMarketError {
  if (error instanceof SkillMarketError) return error;
  return marketError(fallback, boundedFailure(error instanceof Error ? error.message : String(error)) || "Skill market operation failed.");
}

function boundedFailure(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "").trim().slice(0, MAXIMUM_SOURCE_FAILURE_CHARACTERS);
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
