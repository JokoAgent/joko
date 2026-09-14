import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ProjectSkillCandidate } from "@joko/adapter-pi";
import { redactSecrets, type RuntimeResource } from "@joko/core";
import type { OperationalStore } from "@joko/store";

import {
  DefaultPiPackageAcquisition,
  normalizePiPackageSource,
  piPackageSourceApprovalRevision,
  piPackageSourceDisplay,
  piPackageSourceIdentity,
  piPackageSourceWithVersion,
  type PiPackageAcquisition,
  type PiPackageSource
} from "./resource-acquisition.js";
import {
  inspectPiResourceCompatibility,
  shouldShowPiPackageNotice,
  type PiPackageInspection,
  type PiPackageResourceDetail,
  type PiPackageRuntimeRequirement,
  type PiPackageWarning
} from "./pi-package-compatibility.js";
import { isExtensionLibraryDescriptor, isExtensionMainViewDescriptor } from "./extension-surface-manifest.js";

export type PiResourceKind = "extension" | "skill" | "prompt" | "theme" | "package";
export type PiResourceScope = "user" | "global" | "project" | "managed";
export type PiResourceSourceKind = PiPackageSource["kind"] | "extension_source" | "skill_market";
export type PiResourceState =
  | "discovered"
  | "awaiting_approval"
  | "approved"
  | "installing"
  | "installed"
  | "loaded"
  | "disabled"
  | "update_available"
  | "error"
  | "removed";

export interface PiResourceDescriptor {
  readonly id: string;
  readonly backendId: string;
  readonly targetId?: string;
  readonly kind: PiResourceKind;
  readonly scope: PiResourceScope;
  readonly name: string;
  readonly version?: string;
  readonly sourceKind: PiResourceSourceKind;
  readonly sourceIdentity: string;
  readonly sourceDisplay: string;
  readonly canonicalPathFingerprint: string;
  readonly symbolicLinkDetected: boolean;
  readonly specialFileDetected: boolean;
  readonly discoveredRevision: string;
  readonly resourceDetails: readonly PiPackageResourceDetail[];
  readonly runtimeRequirements: readonly PiPackageRuntimeRequirement[];
  readonly warnings: readonly PiPackageWarning[];
  readonly disabledLifecycleScripts: readonly string[];
  readonly canToggle: boolean;
  readonly requiresExtensionApproval: boolean;
  readonly extensionContentFingerprint?: string;
  readonly postMutationNotice: boolean;
  readonly state: PiResourceState;
  readonly enabled: boolean;
  readonly approvedAt?: number;
  readonly approvedByConnectionId?: string;
  readonly versionNumber: bigint;
  readonly updatedAt: number;
  readonly error?: string;
  /** Exact package identity read from the installed package manifest. */
  readonly packageIdentity?: string;
  /** Provenance for packages adopted from the independent Extension Source owner. */
  readonly extensionSource?: {
    readonly sourceId: string;
    readonly sourceRevision: bigint;
    readonly packageRelativePath: string;
    readonly packageContentRevision: string;
  };
  /** Path-free provenance for a standalone Skill installed from a user-added market. */
  readonly skillMarket?: {
    readonly sourceId: string;
    readonly sourceRevision: bigint;
    readonly entryId: string;
    readonly entryRevision: bigint;
    readonly entryContentRevision: string;
    /** Exact Skill tree revision originally adopted from this market entry. */
    readonly installedContentRevision: string;
    /** Portable Target-relative parent for project placements; absent for global. */
    readonly relativeParent?: string;
  };
}

interface StoredExtensionSourcePackage {
  readonly kind: "extension_source";
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly sourceIdentity: string;
  readonly sourceDisplay: string;
  readonly packageRelativePath: string;
  readonly packageContentRevision: string;
}

interface StoredSkillMarketSource {
  readonly kind: "skill_market";
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly entryId: string;
  readonly entryRevision: string;
  readonly entryContentRevision: string;
  readonly installedContentRevision: string;
  readonly sourceName: string;
  readonly slug: string;
  readonly relativeParent?: string;
}

type StoredResourceSource = PiPackageSource | StoredExtensionSourcePackage | StoredSkillMarketSource;

interface StoredResource extends Omit<PiResourceDescriptor, "versionNumber" | "extensionSource" | "skillMarket"> {
  readonly versionNumber: string;
  readonly source: StoredResourceSource;
  readonly canonicalPath?: string;
  readonly workspaceRoot?: string;
  readonly installedPath?: string;
  readonly extensionApprovedRevision?: string;
  /**
   * A discovered replacement is acquisition intent, not authority over the
   * currently installed generation. Keeping it separate lets an update fail
   * without revoking or reinterpreting the last committed bytes.
   */
  readonly pendingUpdate?: StoredResourceUpdateIntent;
}

interface StoredResourceUpdateIntent {
  readonly source: PiPackageSource;
  readonly canonicalPath?: string;
  readonly discoveredRevision: string;
  readonly name: string;
  readonly version?: string;
}

interface StoredResourceCatalog {
  readonly format: 1;
  readonly records: readonly StoredResource[];
}

interface ProjectSkillTransactionJournal {
  readonly format: 1;
  readonly kind: "replace" | "remove";
  readonly transactionId: string;
  readonly backendId: string;
  readonly targetId: string;
  readonly workspaceRoot: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly expectedResourceId: string;
  readonly expectedVersionNumber: string;
  readonly expectedRevision: string;
  readonly committedResourceId: string;
  readonly committedVersionNumber: string;
  readonly committedRevision: string;
}

interface ProjectMarketSkillTransactionJournal {
  readonly format: 1;
  readonly kind: "market_install";
  readonly transactionId: string;
  readonly backendId: string;
  readonly targetId: string;
  readonly workspaceRoot: string;
  readonly destinationPath: string;
  readonly resourceId: string;
  readonly expectedResourceVersion: string | null;
  readonly expectedResourceRevision: string | null;
  readonly expectedDestinationRevision: string | null;
  readonly committedResourceVersion: string;
  readonly committedRevision: string;
  readonly sourceId: string;
  readonly entryId: string;
  readonly entryContentRevision: string;
}

export interface PiResourceManagerOptions {
  readonly store: OperationalStore;
  readonly managedRoot: string;
  readonly scopeId?: string;
  readonly now?: () => number;
  readonly maximumFiles?: number;
  readonly maximumBytes?: number;
  readonly acquisition?: PiPackageAcquisition;
}

export interface DiscoverPiResourceInput {
  readonly id?: string;
  readonly backendId: string;
  readonly targetId?: string;
  readonly kind: PiResourceKind;
  readonly scope: PiResourceScope;
  readonly name?: string;
  readonly version?: string;
  readonly source: PiPackageSource;
  /** Required for project resources and used as the canonical containment fence. */
  readonly workspaceRoot?: string;
}

export interface DiscoverProjectResourcesInput {
  readonly backendId: string;
  readonly targetId: string;
  /** Exact resource kinds advertised by the selected Backend. */
  readonly kinds: readonly PiResourceKind[];
}

export type PiMarketSkillAction = "install" | "update" | "replace";

/** Market-owned, path-free facts supplied while its exact archive lease is held. */
export interface PiMarketSkillSourceInput {
  readonly sourceId: string;
  readonly sourceRevision: bigint;
  readonly entryId: string;
  readonly entryRevision: bigint;
  readonly entryContentRevision: string;
  readonly sourceName: string;
  readonly slug: string;
  readonly version: string;
  readonly candidateRoot: string;
}

export interface PiMarketSkillTargetInput {
  readonly backendId: string;
  readonly scope: "global" | "project";
  readonly targetId?: string;
  /** Omitted means .agents/skills. Otherwise this is a portable Target-relative parent. */
  readonly relativeParent?: string;
}

export interface PiMarketSkillDiffChange {
  readonly key: string;
  readonly kind: "added" | "modified" | "deleted";
  readonly binary: boolean;
  readonly unifiedDiff?: string;
}

export interface PiMarketSkillPreview {
  readonly action: PiMarketSkillAction;
  readonly resourceId: string;
  readonly backendId: string;
  readonly targetId?: string;
  readonly scope: "global" | "project";
  readonly relativeParent?: string;
  readonly name: string;
  readonly availableVersion: string;
  readonly candidateRevision: string;
  readonly files: number;
  readonly bytes: number;
  readonly currentResource?: {
    readonly resourceId: string;
    readonly resourceVersion: bigint;
    readonly name: string;
    readonly version?: string;
    readonly sourceKind: PiResourceSourceKind;
    readonly sourceDisplay: string;
    readonly discoveredRevision: string;
    readonly observedRevision: string;
    readonly dirty: boolean;
  };
  readonly unregisteredDestination: boolean;
  readonly sourceReplacement: boolean;
  readonly preservesEnabled: boolean;
  readonly diffAvailable: boolean;
  readonly diffReason?: string;
  readonly changes: readonly PiMarketSkillDiffChange[];
  readonly diffTruncated: boolean;
}

export interface PreparePiMarketSkillInput extends PiMarketSkillSourceInput, PiMarketSkillTargetInput {
  readonly approvedByConnectionId: string;
  readonly expectedAction: PiMarketSkillAction;
  readonly expectedResourceId: string;
  readonly expectedCurrentResourceId?: string;
  readonly expectedCurrentResourceVersion?: bigint;
  readonly expectedCurrentObservedRevision?: string;
  readonly expectedUnregisteredDestination: boolean;
  readonly allowReplacement: boolean;
}

export interface PreparedPiMarketSkillMutation {
  readonly preview: PiMarketSkillPreview;
  readonly mutation: PreparedPiResourceMutation<PiResourceDescriptor>;
}

export interface DiscoverPiPackageInput {
  readonly id?: string;
  readonly backendId: string;
  readonly targetId?: string;
  readonly scope: PiResourceScope;
  readonly source: PiPackageSource;
  readonly name?: string;
  readonly version?: string;
  /** Required for project-scoped local packages. */
  readonly workspaceRoot?: string;
}

export interface UpdatePiResourceInput {
  readonly source?: PiPackageSource;
  readonly requestedVersion?: string;
  readonly approvedByConnectionId: string;
}

export type PiExtensionPackageAction = "install" | "update" | "replace";

/** Source-owned package facts passed only while the caller holds its exact generation lease. */
export interface PiExtensionSourcePackageInput {
  readonly resourceId: string;
  readonly backendId: string;
  readonly sourceId: string;
  readonly sourceRevision: bigint;
  readonly sourceIdentity: string;
  readonly sourceDisplay: string;
  readonly packageRelativePath: string;
  readonly packageContentRevision: string;
  readonly packageName: string;
  readonly version?: string;
  readonly bindingName: string;
  readonly bindingOrdinal: number;
  readonly packageRoot: string;
}

export interface PiExtensionPackagePreview {
  readonly action: PiExtensionPackageAction;
  readonly resourceId: string;
  readonly backendId: string;
  readonly packageName: string;
  readonly availableVersion?: string;
  readonly installedVersion?: string;
  readonly currentResource?: {
    readonly resourceId: string;
    readonly resourceVersion: bigint;
    readonly name: string;
    readonly sourceDisplay: string;
  };
  readonly sourceReplacement: boolean;
  readonly preservesEnabled: boolean;
  readonly resourceDetails: readonly PiPackageResourceDetail[];
  readonly runtimeRequirements: readonly PiPackageRuntimeRequirement[];
  readonly warnings: readonly PiPackageWarning[];
  readonly disabledLifecycleScripts: readonly string[];
  readonly canToggle: boolean;
}

export interface PreparePiExtensionPackageInput extends PiExtensionSourcePackageInput {
  readonly approvedByConnectionId: string;
  readonly expectedAction: PiExtensionPackageAction;
  readonly expectedCurrentResourceId?: string;
  readonly expectedCurrentResourceVersion?: bigint;
  readonly allowSourceReplacement: boolean;
}

export interface PreparedPiExtensionPackageMutation {
  readonly preview: PiExtensionPackagePreview;
  readonly mutation: PreparedPiResourceMutation<PiResourceDescriptor>;
}

interface InspectedExtensionPackage {
  readonly inspection: ResourceInspection;
  readonly compatibility: PiPackageInspection;
}

interface ExtensionPackagePlan {
  readonly action: PiExtensionPackageAction;
  readonly resourceId: string;
  readonly backendId: string;
  readonly target?: StoredResource;
  readonly current?: StoredResource;
  readonly sourceReplacement: boolean;
}

interface InspectedMarketSkill {
  readonly inspection: ResourceInspection;
  readonly compatibility: PiPackageInspection;
  readonly workspaceRoot?: string;
  readonly relativeParent?: string;
  readonly destination?: string;
  readonly resourceId: string;
  readonly current?: StoredResource;
  readonly currentInspection?: ResourceInspection;
  readonly unregisteredDestination: boolean;
  readonly sourceReplacement: boolean;
  readonly diffAvailable: boolean;
  readonly diffReason?: string;
  readonly changes: readonly PiMarketSkillDiffChange[];
  readonly diffTruncated: boolean;
}

const preparedPiResourceMutationBrand = Symbol("PreparedPiResourceMutation");

/**
 * Filesystem work and compatibility inspection captured without changing the
 * durable catalog. The mutation plan is intentionally opaque; `value` is only
 * the descriptor that will be current if the plan is adopted.
 */
export interface PreparedPiResourceMutation<T> {
  readonly value: T;
  /** True only when adoption revokes bytes already eligible for a live runtime. */
  readonly revokesRuntimeAuthority: boolean;
  readonly [preparedPiResourceMutationBrand]: true;
}

interface PreparedCatalogEntry {
  readonly id: string;
  readonly expected: StoredResource | undefined;
  readonly next: StoredResource;
}

interface PreparedCatalogMutation<T> {
  readonly entries: readonly PreparedCatalogEntry[];
  readonly value: T;
  readonly assertCurrent?: () => void;
  readonly rollbackFilesystem?: () => Promise<void>;
  readonly cleanupAfterCommit?: () => Promise<void>;
  completed: boolean;
}

export interface PiRuntimeResourceSnapshot {
  readonly extensions: readonly string[];
  readonly skills: readonly string[];
  readonly prompts: readonly string[];
  readonly themes: readonly string[];
  readonly packages: readonly string[];
  readonly resources: readonly RuntimeResource[];
}

export interface PiInstalledPackageLeaseInput {
  readonly resourceId: string;
  readonly backendId: string;
  readonly expectedResourceVersion: bigint;
  readonly expectedDiscoveredRevision: string;
  readonly expectedPackageIdentity: string;
  readonly expectedPackageVersion?: string;
}

export interface PiInstalledPackageSnapshotEntry {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly mode: number;
  readonly size: number;
}

export interface PiInstalledPackageSnapshot {
  readonly discoveredRevision: string;
  readonly files: number;
  readonly bytes: number;
  readonly entries: readonly PiInstalledPackageSnapshotEntry[];
}

export interface PiPackageCandidateInspection {
  readonly discoveredRevision: string;
  readonly files: number;
  readonly bytes: number;
  readonly compatibility: PiPackageInspection;
}

/**
 * Process-local lease over one exact managed package generation. The path is
 * deliberately kept behind snapshotTo so consumers cannot turn a private
 * service path into public identity or bypass the Resource tree checks.
 */
export interface PiInstalledPackageLease {
  readonly resource: PiResourceDescriptor;
  readonly snapshotTo: (destination: string, signal?: AbortSignal) => Promise<PiInstalledPackageSnapshot>;
  readonly assertCurrent: (signal?: AbortSignal) => Promise<void>;
  readonly release: () => Promise<void>;
}

export interface PiSkillContentLeaseInput {
  readonly resourceId: string;
  readonly expectedResourceVersion: bigint;
}

export interface PiSkillContentLease {
  readonly resource: PiResourceDescriptor;
  /** Revision approved by the Resource owner. */
  readonly approvedRevision: string;
  /** Exact revision observed when this lease was acquired. */
  readonly observedRevision: string;
  readonly dirty: boolean;
  readonly snapshotTo: (destination: string, signal?: AbortSignal) => Promise<PiInstalledPackageSnapshot>;
  readonly assertCurrent: (signal?: AbortSignal) => Promise<void>;
  readonly release: () => Promise<void>;
}

export interface PreparePiSkillContentInput {
  readonly resourceId: string;
  readonly expectedResourceVersion: bigint;
  readonly expectedObservedRevision: string;
  readonly candidateRoot: string;
  readonly changedByConnectionId: string;
  readonly name?: string;
}

export interface PiSkillContentMutationResult {
  readonly resource: PiResourceDescriptor;
  /** A project directory rename changes the path-derived Resource identity. */
  readonly replacedResourceId?: string;
}

export interface PrepareRemovePiSkillContentInput {
  readonly resourceId: string;
  readonly expectedResourceVersion: bigint;
  readonly expectedObservedRevision: string;
  /** Empty, private directory owned by the Skill content manager. */
  readonly recoveryDestination: string;
}

/** Immutable, path-free text authority captured for one Backend Target runtime. */
export interface RuntimeTextResourceSeed {
  readonly id: string;
  readonly kind: "skill" | "prompt";
  readonly name: string;
  readonly revision: string;
  readonly resourceVersion: bigint;
  readonly version?: string;
  readonly content: string;
  /** Fences delayed native consumption against catalog mutation or Target revocation. */
  readonly assertCurrent: () => void;
}

const MAXIMUM_RUNTIME_TEXT_RESOURCE_BYTES = 256 * 1024;
const MAXIMUM_MARKET_DIFF_CHANGES = 1_000;
const MAXIMUM_MARKET_DIFF_TEXT_BYTES = 2 * 1024 * 1024;
const MAXIMUM_MARKET_UNIFIED_DIFF_BYTES = 2 * 1024 * 1024;
const RESOURCE_GENERATIONS_DIRECTORY = ".generations";
const RESOURCE_GENERATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROJECT_SKILL_TRANSACTION_JOURNALS_DIRECTORY = ".skill-transactions";
const PROJECT_MARKET_SKILL_TRANSACTION_JOURNALS_DIRECTORY = ".skill-market-transactions";
const PROJECT_SKILL_TRANSACTION_DIRECTORY = ".joko-skill-transactions";
const PROJECT_SKILL_TRANSACTION_JOURNAL_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;
const PROJECT_SKILL_TRANSACTION_TEMP_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const PROJECT_MARKET_SKILL_TRANSACTION_JOURNAL_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;
const PROJECT_MARKET_SKILL_TRANSACTION_TEMP_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const MAXIMUM_PROJECT_SKILL_TRANSACTION_JOURNAL_BYTES = 32 * 1024;
const MISSING_INSTALLED_RESOURCE_ERROR = "Installed resource payload is missing.";

export interface PiResourceLoadObservation {
  readonly discoveredRevision: string;
  readonly resourceVersion: bigint;
  readonly sessionId: string;
  readonly runtimeGeneration: number;
}

/**
 * Approval and installation owner for Pi resources. Every executable path is
 * re-canonicalized at the point of use; approval records alone never authorize
 * a changed tree.
 */
export class PiResourceManager {
  readonly #store: OperationalStore;
  readonly #managedRoot: string;
  readonly #scopeId: string;
  readonly #now: () => number;
  readonly #maximumFiles: number;
  readonly #maximumBytes: number;
  readonly #acquisition: PiPackageAcquisition;
  readonly #records = new Map<string, StoredResource>();
  readonly #preparedMutations = new WeakMap<object, PreparedCatalogMutation<unknown>>();
  readonly #installedGenerationLeases = new Map<string, number>();
  readonly #retiredInstalledGenerations = new Map<string, { readonly record: StoredResource; readonly generation: string }>();
  #initialized = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: PiResourceManagerOptions) {
    if (!isAbsolute(options.managedRoot) || resolve(options.managedRoot) !== options.managedRoot) {
      throw new Error("Managed resource root must be a normalized absolute path.");
    }
    this.#store = options.store;
    this.#managedRoot = options.managedRoot;
    this.#scopeId = options.scopeId ?? "orchestrator";
    this.#now = options.now ?? Date.now;
    this.#maximumFiles = options.maximumFiles ?? 10_000;
    this.#maximumBytes = options.maximumBytes ?? 500 * 1024 * 1024;
    this.#acquisition = options.acquisition ?? new DefaultPiPackageAcquisition();
    if (!Number.isSafeInteger(this.#maximumFiles) || this.#maximumFiles < 1) throw new RangeError("Resource file limit is invalid.");
    if (!Number.isSafeInteger(this.#maximumBytes) || this.#maximumBytes < 1) throw new RangeError("Resource byte limit is invalid.");
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.#managedRoot, { recursive: true, mode: 0o700 });
    await assertCanonicalDirectory(this.#managedRoot, "Managed resource root");
    await Promise.all(["extensions", "skills", "prompts", "themes", "packages", ".staging", PROJECT_SKILL_TRANSACTION_JOURNALS_DIRECTORY, PROJECT_MARKET_SKILL_TRANSACTION_JOURNALS_DIRECTORY].map((name) => mkdir(join(this.#managedRoot, name), { recursive: true, mode: 0o700 })));
    for (const name of ["extensions", "skills", "prompts", "themes", "packages", ".staging", PROJECT_SKILL_TRANSACTION_JOURNALS_DIRECTORY, PROJECT_MARKET_SKILL_TRANSACTION_JOURNALS_DIRECTORY]) {
      await assertContainedRegularDirectory(this.#managedRoot, join(this.#managedRoot, name), `Managed resource ${name} directory`);
    }
    const setting = this.#store.findSetting<StoredResourceCatalog>("service", this.#scopeId, "pi_resource_catalog");
    if (setting !== undefined) {
      if (setting.value.format !== 1 || !Array.isArray(setting.value.records)) throw new Error("Pi resource catalog has an unsupported format.");
      for (const raw of setting.value.records) {
        const record = validateStoredResource(raw);
        if (this.#records.has(record.id)) throw new Error("Pi resource catalog contains duplicate IDs.");
        this.#records.set(record.id, record);
      }
    }
    await this.#recoverProjectSkillTransactions();
    await this.#recoverProjectMarketSkillTransactions();
    const recoveryChanged = await this.#recoverOrphanedFilesystemState();
    let compatibilityChanged = false;
    for (const [id, record] of this.#records) {
      const refreshed = await this.#refreshCompatibility(record);
      if (resourceCompatibilityIdentity(refreshed) !== resourceCompatibilityIdentity(record)) {
        this.#records.set(id, refreshed);
        compatibilityChanged = true;
      }
    }
    if (recoveryChanged || compatibilityChanged) this.#persist();
    this.#initialized = true;
  }

  list(filter: {
    readonly backendId?: string;
    readonly targetId?: string;
    readonly kind?: PiResourceKind;
    readonly state?: PiResourceState;
  } = {}): readonly PiResourceDescriptor[] {
    this.#assertInitialized();
    return [...this.#records.values()]
      .map(publicResource)
      .filter((item) => filter.backendId === undefined || item.backendId === filter.backendId)
      .filter((item) => filter.targetId === undefined || item.targetId === filter.targetId)
      .filter((item) => filter.kind === undefined || item.kind === filter.kind)
      .filter((item) => filter.state === undefined || item.state === filter.state)
      .sort((left, right) => left.name.localeCompare(right.name, "en") || left.id.localeCompare(right.id, "en"));
  }

  get(resourceId: string): PiResourceDescriptor {
    this.#assertInitialized();
    return publicResource(this.#require(resourceId));
  }

  get maximumFiles(): number {
    return this.#maximumFiles;
  }

  get maximumBytes(): number {
    return this.#maximumBytes;
  }

  async acquireInstalledPackage(input: PiInstalledPackageLeaseInput): Promise<PiInstalledPackageLease> {
    this.#assertInitialized();
    const resourceId = nonBlank(input.resourceId, "Resource ID");
    const backendId = nonBlank(input.backendId, "Backend ID");
    const expectedRevision = normalizedContentRevision(input.expectedDiscoveredRevision, "Resource discovered revision");
    const expectedIdentity = boundedPackageIdentity(input.expectedPackageIdentity);
    const expectedVersion = input.expectedPackageVersion === undefined
      ? undefined
      : boundedVersion(input.expectedPackageVersion);
    return this.#mutate(async () => {
      const record = this.#require(resourceId);
      this.#assertInstalledPackageLeaseAuthority(record, {
        backendId,
        expectedResourceVersion: input.expectedResourceVersion,
        expectedDiscoveredRevision: expectedRevision,
        expectedPackageIdentity: expectedIdentity,
        ...(expectedVersion === undefined ? {} : { expectedPackageVersion: expectedVersion })
      });
      await this.#assertInstalledSafe(record);
      const generation = installedGenerationContainer(this.#managedRoot, record);
      const generationKey = pathIdentity(generation);
      this.#installedGenerationLeases.set(generationKey, (this.#installedGenerationLeases.get(generationKey) ?? 0) + 1);
      const resource = publicResource(record);
      let released = false;
      let releaseRequested = false;
      let releasePromise: Promise<void> | undefined;
      const assertLeaseOpen = (): void => {
        if (releaseRequested) throw new Error("Installed package lease has been released.");
      };
      return {
        resource,
        snapshotTo: async (destination, signal) => {
          assertLeaseOpen();
          signal?.throwIfAborted();
          await this.#assertInstalledPackageLeaseCurrent(record, signal);
          const snapshot = await snapshotInstalledPackageTree(record.installedPath!, destination, this.#maximumFiles, this.#maximumBytes, signal);
          if (snapshot.discoveredRevision !== record.discoveredRevision) {
            throw new Error("Installed package content changed while it was being snapshotted.");
          }
          await this.#assertInstalledPackageLeaseCurrent(record, signal);
          return snapshot;
        },
        assertCurrent: async (signal) => {
          assertLeaseOpen();
          await this.#assertInstalledPackageLeaseCurrent(record, signal);
        },
        release: async () => {
          if (released) return;
          releaseRequested = true;
          releasePromise ??= this.#releaseInstalledPackageGeneration(generationKey).then(
            () => { released = true; },
            (error: unknown) => {
              releasePromise = undefined;
              throw error;
            }
          );
          await releasePromise;
        }
      };
    });
  }

  /**
   * Acquire path-private authority over one standalone Skill. Project content
   * may be externally dirty; the lease records that exact observed tree while
   * keeping the approved Resource revision separate.
   */
  async acquireSkillContent(input: PiSkillContentLeaseInput): Promise<PiSkillContentLease> {
    this.#assertInitialized();
    const resourceId = nonBlank(input.resourceId, "Resource ID");
    return this.#mutate(async () => {
      const record = this.#require(resourceId);
      this.#assertSkillContentAuthority(record, input.expectedResourceVersion);
      const root = await this.#skillContentRoot(record);
      const inspection = await inspectSkillPackage(root, this.#maximumFiles, this.#maximumBytes);
      if (!samePath(root, inspection.canonicalPath)) throw new Error("Skill content root changed identity.");
      if (!isDirectProjectResource(record) && inspection.revision !== record.discoveredRevision) {
        throw new Error("Installed Skill content changed and is fenced.");
      }
      const generation = record.installedPath === undefined
        ? undefined
        : installedGenerationContainer(this.#managedRoot, record);
      const generationKey = generation === undefined ? undefined : pathIdentity(generation);
      if (generationKey !== undefined) {
        this.#installedGenerationLeases.set(generationKey, (this.#installedGenerationLeases.get(generationKey) ?? 0) + 1);
      }
      const resource = publicResource(record);
      const observedRevision = inspection.revision;
      let released = false;
      let releaseRequested = false;
      let releasePromise: Promise<void> | undefined;
      const assertLeaseOpen = (): void => {
        if (releaseRequested) throw new Error("Skill content lease has been released.");
      };
      const assertCurrent = async (signal?: AbortSignal): Promise<void> => {
        assertLeaseOpen();
        signal?.throwIfAborted();
        const current = this.#records.get(record.id);
        if (current !== record) throw new Error("Skill Resource authority changed after the content lease was acquired.");
        this.#assertSkillContentAuthority(record, input.expectedResourceVersion);
        const currentRoot = await this.#skillContentRoot(record, signal);
        const currentInspection = await inspectSkillPackage(currentRoot, this.#maximumFiles, this.#maximumBytes, signal);
        if (!samePath(currentRoot, currentInspection.canonicalPath) || currentInspection.revision !== observedRevision) {
          throw new Error("Skill content changed after the content lease was acquired.");
        }
      };
      return {
        resource,
        approvedRevision: record.discoveredRevision,
        observedRevision,
        dirty: observedRevision !== record.discoveredRevision,
        snapshotTo: async (destination, signal) => {
          await assertCurrent(signal);
          const snapshot = await snapshotInstalledPackageTree(root, destination, this.#maximumFiles, this.#maximumBytes, signal);
          if (snapshot.discoveredRevision !== observedRevision) {
            throw new Error("Skill content changed while it was being snapshotted.");
          }
          await assertCurrent(signal);
          return snapshot;
        },
        assertCurrent,
        release: async () => {
          if (released) return;
          releaseRequested = true;
          if (generationKey === undefined) {
            released = true;
            return;
          }
          releasePromise ??= this.#releaseInstalledPackageGeneration(generationKey).then(
            () => { released = true; },
            (error: unknown) => {
              releasePromise = undefined;
              throw error;
            }
          );
          await releasePromise;
        }
      };
    });
  }

  /** Stage an exact Skill snapshot and publish it through Resource authority. */
  async prepareReplaceSkillContent(
    input: PreparePiSkillContentInput
  ): Promise<PreparedPiResourceMutation<PiSkillContentMutationResult>> {
    this.#assertInitialized();
    const current = this.#require(nonBlank(input.resourceId, "Resource ID"));
    this.#assertSkillContentAuthority(current, input.expectedResourceVersion);
    const expectedObservedRevision = normalizedContentRevision(input.expectedObservedRevision, "Observed Skill revision");
    const changedByConnectionId = nonBlank(input.changedByConnectionId, "Changing connection ID");
    const requestedName = input.name === undefined ? current.name : portableSkillName(input.name);
    const candidateRoot = await canonicalDirectory(input.candidateRoot, "Skill candidate root");
    const candidateInspection = await inspectSkillPackage(candidateRoot, this.#maximumFiles, this.#maximumBytes);
    const runtimeVersion = this.#runtimeVersion(current.backendId);
    const compatibility = await inspectPiResourceCompatibility("skill", candidateRoot, {
      ...(runtimeVersion === undefined ? {} : { currentRuntimeVersion: runtimeVersion }),
      contentFingerprint: candidateInspection.revision
    });
    if (!compatibility.canToggle) throw new Error("Skill candidate does not contain usable runtime content.");

    if (isDirectProjectResource(current)) {
      return this.#prepareProjectSkillContentMutation(
        current,
        expectedObservedRevision,
        candidateRoot,
        candidateInspection,
        compatibility,
        requestedName,
        changedByConnectionId
      );
    }
    if (current.installedPath === undefined) throw new Error("Global Skill content is not installed.");
    if (expectedObservedRevision !== current.discoveredRevision) throw new Error("Observed Skill revision is stale.");
    await this.#assertInstalledSafe(current);
    return this.#prepareManagedSkillContentMutation(
      current,
      candidateRoot,
      candidateInspection,
      compatibility,
      requestedName,
      changedByConnectionId
    );
  }

  /**
   * Prepare physical removal while retaining an exact private recovery copy.
   * Project content is moved behind a sibling transaction fence before the
   * Resource record can be committed, so a Store failure can restore it.
   */
  async prepareRemoveSkillContent(
    input: PrepareRemovePiSkillContentInput
  ): Promise<PreparedPiResourceMutation<PiResourceDescriptor>> {
    this.#assertInitialized();
    const current = this.#require(nonBlank(input.resourceId, "Resource ID"));
    this.#assertSkillContentAuthority(current, input.expectedResourceVersion);
    const expectedObservedRevision = normalizedContentRevision(input.expectedObservedRevision, "Observed Skill revision");
    const recoveryDestination = await canonicalDirectory(input.recoveryDestination, "Skill recovery destination");
    if ((await readdir(recoveryDestination)).length !== 0) throw new Error("Skill recovery destination must be empty.");
    const sourceRoot = await this.#skillContentRoot(current);
    const observed = await inspectSkillPackage(sourceRoot, this.#maximumFiles, this.#maximumBytes);
    if (observed.revision !== expectedObservedRevision) throw new Error("Observed Skill revision is stale.");
    const recovery = await snapshotInstalledPackageTree(
      sourceRoot,
      recoveryDestination,
      this.#maximumFiles,
      this.#maximumBytes
    );
    if (recovery.discoveredRevision !== expectedObservedRevision) {
      await rm(recoveryDestination, { recursive: true, force: true }).catch(() => undefined);
      throw new Error("Skill content changed while its recovery copy was created.");
    }
    const { pendingUpdate: _pendingUpdate, ...withoutPendingUpdate } = omitInstalledPath(current);
    const removed: StoredResource = {
      ...withoutPendingUpdate,
      state: "removed",
      enabled: false,
      versionNumber: (BigInt(current.versionNumber) + 1n).toString(10),
      updatedAt: this.#now()
    };

    if (!isDirectProjectResource(current)) {
      await this.#assertInstalledSafe(current);
      return this.#prepareMutation(
        [{ id: current.id, expected: current, next: removed }],
        publicResource(removed),
        undefined,
        {
          rollback: () => rm(recoveryDestination, { recursive: true, force: true }),
          cleanupAfterCommit: () => this.#removeInstalledIncarnation(current)
        }
      );
    }

    const workspaceRoot = this.#assertTrustedProjectTarget(current.backendId, current.targetId, current.workspaceRoot);
    const targetId = current.targetId!;
    const parent = dirname(current.canonicalPath);
    assertWithin(workspaceRoot, parent, "Project Skill parent");
    const transactionRoot = join(parent, PROJECT_SKILL_TRANSACTION_DIRECTORY);
    await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
    await assertContainedRegularDirectory(workspaceRoot, transactionRoot, "Project Skill transaction directory");
    const transactionId = randomUUID();
    const journal: ProjectSkillTransactionJournal = {
      format: 1,
      kind: "remove",
      transactionId,
      backendId: current.backendId,
      targetId,
      workspaceRoot,
      sourcePath: current.canonicalPath,
      destinationPath: current.canonicalPath,
      expectedResourceId: current.id,
      expectedVersionNumber: current.versionNumber,
      expectedRevision: expectedObservedRevision,
      committedResourceId: removed.id,
      committedVersionNumber: removed.versionNumber,
      committedRevision: removed.discoveredRevision
    };
    let journalPath: string | undefined;
    try {
      journalPath = await this.#writeProjectSkillTransactionJournal(journal);
      const beforeMove = await inspectSkillPackage(current.canonicalPath, this.#maximumFiles, this.#maximumBytes);
      this.#assertTrustedProjectTarget(current.backendId, current.targetId, workspaceRoot);
      if (beforeMove.revision !== expectedObservedRevision) throw new Error("Project Skill changed before removal.");
      await rename(current.canonicalPath, join(transactionRoot, `${transactionId}.deleted`));
      return this.#prepareMutation(
        [{ id: current.id, expected: current, next: removed }],
        publicResource(removed),
        () => this.#assertTrustedProjectTarget(current.backendId, current.targetId, workspaceRoot),
        {
          rollback: async () => {
            await this.#recoverProjectSkillTransaction(journalPath!, journal);
            await rm(recoveryDestination, { recursive: true, force: true });
          },
          cleanupAfterCommit: () => this.#recoverProjectSkillTransaction(journalPath!, journal)
        }
      );
    } catch (error) {
      if (journalPath !== undefined) {
        try {
          await this.#recoverProjectSkillTransaction(journalPath, journal);
        } catch (recoveryError) {
          throw new AggregateError([error, recoveryError], "Project Skill removal failed and its durable rollback requires recovery.");
        }
      }
      await rm(recoveryDestination, { recursive: true, force: true }).catch(() => undefined);
      if (await directoryIsEmpty(transactionRoot)) await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async inspectPackageCandidate(
    packageRoot: string,
    backendId: string,
    signal?: AbortSignal
  ): Promise<PiPackageCandidateInspection> {
    this.#assertInitialized();
    signal?.throwIfAborted();
    const inspection = await inspectResource(packageRoot, this.#maximumFiles, this.#maximumBytes, signal);
    const runtimeVersion = this.#runtimeVersion(nonBlank(backendId, "Backend ID"));
    const compatibility = await inspectPiResourceCompatibility("package", inspection.canonicalPath, {
      ...(runtimeVersion === undefined ? {} : { currentRuntimeVersion: runtimeVersion }),
      contentFingerprint: inspection.revision
    });
    signal?.throwIfAborted();
    return {
      discoveredRevision: inspection.revision,
      files: inspection.files,
      bytes: inspection.bytes,
      compatibility
    };
  }

  /**
   * Serialize completion of an inspected mutation. The supplied finalize
   * callback is synchronous so an operation owner can call it from the same
   * OperationalStore transaction that records operation completion. If that
   * transaction (or its completion wrapper) fails, the in-memory catalog is
   * restored to the exact pre-adoption records.
   */
  async completePreparedMutation<T, TResult>(
    prepared: PreparedPiResourceMutation<T>,
    completion: (finalize: (store: OperationalStore) => void) => TResult
  ): Promise<TResult> {
    this.#assertInitialized();
    return this.#mutate(async () => {
      const internal = this.#preparedMutations.get(prepared as object) as PreparedCatalogMutation<T> | undefined;
      if (internal === undefined) throw new Error("Prepared resource mutation does not belong to this manager.");
      if (internal.completed) throw new Error("Prepared resource mutation has already completed.");
      let adopted = false;
      const finalize = (store: OperationalStore): void => {
        if (store !== this.#store) throw new Error("Prepared resource mutation must use its owning OperationalStore.");
        if (adopted) throw new Error("Prepared resource mutation can only be adopted once.");
        this.#adoptPreparedMutation(internal, store);
        adopted = true;
      };
      try {
        const result = completion(finalize);
        if (isPromiseLike(result)) {
          void Promise.resolve(result).catch(() => undefined);
          throw new Error("Prepared resource mutation completion must be synchronous.");
        }
        if (!adopted) throw new Error("Prepared resource mutation completion did not adopt the catalog change.");
        internal.completed = true;
        await internal.cleanupAfterCommit?.().catch(() => undefined);
        return result;
      } catch (error) {
        if (adopted) this.#restorePreparedMutation(internal);
        if (internal.rollbackFilesystem !== undefined) {
          internal.completed = true;
          await internal.rollbackFilesystem().catch(() => undefined);
        }
        throw error;
      }
    });
  }

  /** Discard an inspected mutation and remove only its private/staged candidate. */
  async discardPreparedMutation<T>(prepared: PreparedPiResourceMutation<T>): Promise<void> {
    this.#assertInitialized();
    await this.#mutate(async () => {
      const internal = this.#preparedMutations.get(prepared as object) as PreparedCatalogMutation<T> | undefined;
      if (internal === undefined) throw new Error("Prepared resource mutation does not belong to this manager.");
      if (internal.completed) return;
      internal.completed = true;
      await internal.rollbackFilesystem?.();
    });
  }

  async prepareDiscover(input: DiscoverPiResourceInput): Promise<PreparedPiResourceMutation<PiResourceDescriptor>> {
    this.#assertInitialized();
    validateKind(input.kind);
    validateScope(input.scope);
    const source = normalizePiPackageSource(input.source);
    if (source.kind !== "local") throw new Error("Direct resources require a local acquisition source.");
    const inspection = await inspectResourceForKind(input.kind, source.path, this.#maximumFiles, this.#maximumBytes);
    const runtimeVersion = this.#runtimeVersion(input.backendId);
    const compatibility = await inspectPiResourceCompatibility(input.kind, inspection.canonicalPath, {
      ...(runtimeVersion === undefined ? {} : { currentRuntimeVersion: runtimeVersion }),
      contentFingerprint: inspection.revision
    });
    let workspaceRoot: string | undefined;
    if (input.scope === "project") {
      if (input.workspaceRoot === undefined) throw new Error("Project resources require a workspace root.");
      workspaceRoot = await canonicalDirectory(input.workspaceRoot, "Project resource workspace");
      assertWithin(workspaceRoot, inspection.canonicalPath, "Project resource");
      this.#assertTrustedProjectTarget(input.backendId, input.targetId, workspaceRoot);
    } else if (input.workspaceRoot !== undefined || input.targetId !== undefined) {
      throw new Error("Only project resources may declare a Target or workspace root.");
    }
    const id = input.id ?? `resource_${randomUUID()}`;
    validateResourceId(id);
    const plan = this.#planLocalDiscovery(input, id, source, inspection, compatibility, workspaceRoot);
    return this.#prepareMutation([plan.entry], plan.value, workspaceRoot === undefined
      ? undefined
      : () => { void this.#assertTrustedProjectTarget(input.backendId, input.targetId, workspaceRoot); });
  }

  async discover(input: DiscoverPiResourceInput): Promise<PiResourceDescriptor> {
    return this.#completePreparedStandalone(await this.prepareDiscover(input));
  }

  /** Register a typed package intent without touching network or executing package code. */
  async prepareDiscoverPackage(input: DiscoverPiPackageInput): Promise<PreparedPiResourceMutation<PiResourceDescriptor>> {
    this.#assertInitialized();
    validateScope(input.scope);
    const source = normalizePiPackageSource(input.source);
    if (source.kind === "local") {
      return this.prepareDiscover({
        ...(input.id === undefined ? {} : { id: input.id }),
        backendId: input.backendId,
        ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
        kind: "package",
        scope: input.scope,
        source,
        ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.version === undefined ? {} : { version: input.version })
      });
    }
    if (input.workspaceRoot !== undefined) throw new Error("Remote package sources do not accept a workspace path.");
    const workspaceRoot = input.scope === "project"
      ? this.#assertTrustedProjectTarget(input.backendId, input.targetId)
      : undefined;
    if (input.scope !== "project" && input.targetId !== undefined) throw new Error("Only project packages may declare a Target.");
    const id = input.id ?? `resource_${randomUUID()}`;
    validateResourceId(id);
    const sourceIdentity = piPackageSourceIdentity(source);
    const approvalRevision = piPackageSourceApprovalRevision(source);
    const now = this.#now();
    const previous = this.#records.get(id);
    if (previous?.source.kind === "extension_source" || previous?.source.kind === "skill_market") {
      throw new Error("Pi resource ID is already reserved by a source-owned Resource.");
    }
    if (previous !== undefined && (
      previous.backendId !== input.backendId || previous.targetId !== input.targetId ||
      previous.kind !== "package" || previous.scope !== input.scope ||
      previous.sourceIdentity !== sourceIdentity
    )) throw new Error("Pi resource ID is already bound to a different package identity.");
    const requestedName = nonBlank(input.name ?? previous?.name ?? piPackageSourceDisplay(source), "Resource name");
    const requestedVersion = input.version === undefined
      ? previous?.version
      : nonBlank(input.version, "Resource version");
    if (previous?.installedPath !== undefined && previous.state !== "removed") {
      const matchesActive = piPackageSourceApprovalRevision(previous.source) === approvalRevision
        && previous.name === requestedName
        && previous.version === requestedVersion;
      const pendingUpdate: StoredResourceUpdateIntent = {
        source,
        discoveredRevision: approvalRevision,
        name: requestedName,
        ...(requestedVersion === undefined ? {} : { version: requestedVersion })
      };
      const matchesPending = previous.pendingUpdate !== undefined
        && storedUpdateIntentIdentity(previous.pendingUpdate) === storedUpdateIntentIdentity(pendingUpdate);
      if ((matchesActive && previous.pendingUpdate === undefined) || matchesPending) {
        return this.#prepareMutation(
          [{ id, expected: previous, next: previous }],
          publicResource(previous),
          workspaceRoot === undefined
            ? undefined
            : () => { void this.#assertTrustedProjectTarget(input.backendId, input.targetId, workspaceRoot); }
        );
      }
      const { pendingUpdate: _pendingUpdate, ...active } = previous;
      const updated: StoredResource = {
        ...active,
        ...(matchesActive ? {} : { pendingUpdate }),
        updatedAt: now
      };
      return this.#prepareMutation(
        [{ id, expected: previous, next: updated }],
        publicResource(updated),
        workspaceRoot === undefined
          ? undefined
          : () => { void this.#assertTrustedProjectTarget(input.backendId, input.targetId, workspaceRoot); }
      );
    }
    if (
      previous !== undefined && previous.state !== "removed" &&
      previous.sourceIdentity === sourceIdentity &&
      piPackageSourceApprovalRevision(previous.source) === approvalRevision
    ) {
      return this.#prepareMutation(
        [{ id, expected: previous, next: previous }],
        publicResource(previous),
        workspaceRoot === undefined
          ? undefined
          : () => { void this.#assertTrustedProjectTarget(input.backendId, input.targetId, workspaceRoot); }
      );
    }
    const {
      approvedAt: _approvedAt,
      approvedByConnectionId: _approvedBy,
      canonicalPath: _canonicalPath,
      error: _error,
      extensionApprovedRevision: _extensionApprovedRevision,
      workspaceRoot: _workspaceRoot,
      ...previousBase
    } = previous ?? {} as StoredResource;
    const record: StoredResource = {
      ...previousBase,
      id,
      backendId: nonBlank(input.backendId, "Backend ID"),
      ...(input.targetId === undefined ? {} : { targetId: nonBlank(input.targetId, "Target ID") }),
      kind: "package",
      scope: input.scope,
      name: requestedName,
      ...(requestedVersion === undefined ? {} : { version: requestedVersion }),
      sourceKind: source.kind,
      sourceIdentity,
      sourceDisplay: piPackageSourceDisplay(source),
      canonicalPathFingerprint: `sha256:${createHash("sha256").update(sourceIdentity).digest("hex")}`,
      symbolicLinkDetected: false,
      specialFileDetected: false,
      discoveredRevision: approvalRevision,
      ...emptyCompatibilityFields(),
      state: "awaiting_approval",
      enabled: false,
      versionNumber: ((previous === undefined ? 0n : BigInt(previous.versionNumber)) + 1n).toString(10),
      updatedAt: now,
      source,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot })
    };
    return this.#prepareMutation(
      [{ id, expected: previous, next: record }],
      publicResource(record),
      workspaceRoot === undefined
        ? undefined
        : () => { void this.#assertTrustedProjectTarget(input.backendId, input.targetId, workspaceRoot); }
    );
  }

  /** Register a typed package intent without touching network or executing package code. */
  async discoverPackage(input: DiscoverPiPackageInput): Promise<PiResourceDescriptor> {
    return this.#completePreparedStandalone(await this.prepareDiscoverPackage(input));
  }

  /**
   * Inspect an Extension Source package without adopting its bytes. The caller
   * must keep the exact Source generation leased for the duration of this
   * call; the returned facts are advisory until a later revision-fenced
   * mutation repeats the inspection.
   */
  async previewExtensionPackage(input: PiExtensionSourcePackageInput): Promise<PiExtensionPackagePreview> {
    this.#assertInitialized();
    const inspected = await this.#inspectExtensionSourcePackage(input);
    return publicExtensionPackagePreview(this.#planExtensionPackage(input, inspected), inspected.compatibility);
  }

  /**
   * Copy one exact Source-owned package into a Resource-owned candidate and
   * prepare its catalog adoption. No durable Resource state changes until the
   * enclosing Operation adopts `mutation`; a failed or stale completion
   * removes only the candidate and leaves the previous generation intact.
   */
  async prepareExtensionPackage(
    input: PreparePiExtensionPackageInput
  ): Promise<PreparedPiExtensionPackageMutation> {
    this.#assertInitialized();
    const inspected = await this.#inspectExtensionSourcePackage(input);
    const plan = this.#planExtensionPackage(input, inspected);
    const preview = publicExtensionPackagePreview(plan, inspected.compatibility);
    const currentId = preview.currentResource?.resourceId;
    const currentVersion = preview.currentResource?.resourceVersion;
    if (
      preview.action !== input.expectedAction
      || currentId !== input.expectedCurrentResourceId
      || currentVersion !== input.expectedCurrentResourceVersion
    ) {
      throw new Error("Extension package installation facts changed after confirmation.");
    }
    if (preview.sourceReplacement && !input.allowSourceReplacement) {
      throw new Error("Replacing an installed package from another source requires explicit confirmation.");
    }

    const source: StoredExtensionSourcePackage = {
      kind: "extension_source",
      sourceId: normalizedExtensionSourceId(input.sourceId),
      sourceRevision: normalizedDecimalRevision(input.sourceRevision, "Extension source revision"),
      sourceIdentity: nonBlank(input.sourceIdentity, "Extension source identity"),
      sourceDisplay: nonBlank(input.sourceDisplay, "Extension source display"),
      packageRelativePath: normalizeExtensionPackagePath(input.packageRelativePath),
      packageContentRevision: normalizedContentRevision(input.packageContentRevision, "Extension source package revision")
    };
    const expectedTarget = plan.target;
    const replaced = plan.current?.id === input.resourceId ? undefined : plan.current;
    const ownerSeed: StoredResource = {
      id: input.resourceId,
      backendId: nonBlank(input.backendId, "Backend ID"),
      kind: "package",
      scope: "managed",
      name: inspected.compatibility.name,
      ...(inspected.compatibility.version === undefined ? {} : { version: inspected.compatibility.version }),
      sourceKind: "extension_source",
      sourceIdentity: extensionSourcePackageIdentity(source),
      sourceDisplay: source.sourceDisplay,
      canonicalPathFingerprint: extensionSourcePackageFingerprint(source),
      symbolicLinkDetected: false,
      specialFileDetected: false,
      discoveredRevision: inspected.inspection.revision,
      packageIdentity: inspected.compatibility.name,
      ...compatibilityFields(inspected.compatibility, false),
      ...(inspected.compatibility.extensionContentFingerprint === undefined
        ? {}
        : { extensionApprovedRevision: inspected.compatibility.extensionContentFingerprint }),
      state: "installed",
      enabled: false,
      approvedAt: this.#now(),
      approvedByConnectionId: nonBlank(input.approvedByConnectionId, "Approving connection ID"),
      versionNumber: ((expectedTarget === undefined ? 0n : BigInt(expectedTarget.versionNumber)) + 1n).toString(10),
      updatedAt: this.#now(),
      source
    };

    const owner = resourceOwnerPath(this.#managedRoot, ownerSeed);
    await mkdir(owner, { recursive: true, mode: 0o700 });
    await assertContainedRegularDirectory(this.#managedRoot, owner, "Managed resource owner directory");
    const generations = join(owner, RESOURCE_GENERATIONS_DIRECTORY);
    await mkdir(generations, { recursive: true, mode: 0o700 });
    await assertContainedRegularDirectory(this.#managedRoot, generations, "Managed resource generations directory");
    const generation = randomUUID();
    const candidateContainer = join(generations, generation);
    const stage = join(this.#managedRoot, ".staging", `resource-${generation}`);
    await mkdir(stage, { recursive: false, mode: 0o700 });
    let candidatePublished = false;
    try {
      const sourceInspection = await inspectResource(input.packageRoot, this.#maximumFiles, this.#maximumBytes);
      if (
        !samePath(sourceInspection.canonicalPath, inspected.inspection.canonicalPath)
        || sourceInspection.revision !== inspected.inspection.revision
      ) {
        throw new Error("Extension source package changed during Resource preparation.");
      }
      const payloadName = safePayloadName(inspected.compatibility.name);
      const stagedPayload = join(stage, payloadName);
      await mkdir(stagedPayload, { recursive: false, mode: 0o700 });
      await copyTreeFailClosed(
        sourceInspection.canonicalPath,
        sourceInspection.canonicalPath,
        stagedPayload,
        { files: 0, bytes: 0, maxFiles: this.#maximumFiles, maxBytes: this.#maximumBytes }
      );
      const stagedInspection = await inspectResource(stagedPayload, this.#maximumFiles, this.#maximumBytes);
      if (stagedInspection.revision !== sourceInspection.revision) {
        throw new Error("Extension source package changed during staged installation.");
      }
      await rename(stage, candidateContainer);
      candidatePublished = true;
      const installedPath = join(candidateContainer, payloadName);
      await assertContainedPath(this.#managedRoot, installedPath, "Installed extension package candidate");
      const installedInspection = await inspectResource(installedPath, this.#maximumFiles, this.#maximumBytes);
      if (installedInspection.revision !== source.packageContentRevision) {
        throw new Error("Installed extension package does not match the approved Source bytes.");
      }
      const runtimeVersion = this.#runtimeVersion(input.backendId);
      const compatibility = await inspectPiResourceCompatibility("package", installedPath, {
        ...(runtimeVersion === undefined ? {} : { currentRuntimeVersion: runtimeVersion }),
        contentFingerprint: installedInspection.revision
      });
      assertExtensionPackageSelection(input, compatibility);
      const preservesExplicitDisable = plan.current?.state === "disabled";
      const preservesEnabled = plan.current?.enabled === true && compatibility.canToggle;
      const updated: StoredResource = {
        ...ownerSeed,
        name: compatibility.name,
        ...(compatibility.version === undefined ? {} : { version: compatibility.version }),
        installedPath,
        discoveredRevision: installedInspection.revision,
        packageIdentity: compatibility.name,
        ...compatibilityFields(compatibility, false),
        ...(compatibility.extensionContentFingerprint === undefined
          ? {}
          : { extensionApprovedRevision: compatibility.extensionContentFingerprint }),
        state: preservesExplicitDisable ? "disabled" : "installed",
        enabled: preservesEnabled,
        updatedAt: this.#now()
      };
      assertExpectedInstalledLocation(this.#managedRoot, updated);
      const entries: PreparedCatalogEntry[] = [{ id: updated.id, expected: expectedTarget, next: updated }];
      if (replaced !== undefined) {
        const { pendingUpdate: _pendingUpdate, ...withoutPendingUpdate } = omitInstalledPath(replaced);
        entries.push({
          id: replaced.id,
          expected: replaced,
          next: {
            ...withoutPendingUpdate,
            state: "removed",
            enabled: false,
            versionNumber: (BigInt(replaced.versionNumber) + 1n).toString(10),
            updatedAt: this.#now()
          }
        });
      }
      const mutation = this.#prepareMutation(entries, publicResource(updated), undefined, {
        rollback: () => this.#removeCandidateGeneration(updated, candidateContainer),
        cleanupAfterCommit: async () => {
          if (expectedTarget?.installedPath !== undefined) {
            await this.#removeInstalledIncarnation(expectedTarget).catch(() => undefined);
          }
          if (replaced !== undefined) await this.#removeResourceOwner(replaced).catch(() => undefined);
        }
      });
      return { preview, mutation };
    } catch (error) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      if (candidatePublished) await this.#removeCandidateGeneration(ownerSeed, candidateContainer).catch(() => undefined);
      else await this.#pruneResourceOwner(ownerSeed).catch(() => undefined);
      throw error;
    }
  }

  /** Inspect a leased market archive against the exact install slot without changing Resource authority. */
  async previewMarketSkill(input: PiMarketSkillSourceInput & PiMarketSkillTargetInput): Promise<PiMarketSkillPreview> {
    this.#assertInitialized();
    return publicMarketSkillPreview(input, await this.#inspectMarketSkill(input));
  }

  /**
   * Publish one exact, already verified market Skill. The candidate remains
   * path-private; only Source/entry revisions are retained as provenance.
   */
  async prepareMarketSkill(input: PreparePiMarketSkillInput): Promise<PreparedPiMarketSkillMutation> {
    this.#assertInitialized();
    const inspected = await this.#inspectMarketSkill(input);
    const preview = publicMarketSkillPreview(input, inspected);
    if (
      preview.action !== input.expectedAction
      || preview.resourceId !== input.expectedResourceId
      || preview.currentResource?.resourceId !== input.expectedCurrentResourceId
      || preview.currentResource?.resourceVersion !== input.expectedCurrentResourceVersion
      || preview.currentResource?.observedRevision !== input.expectedCurrentObservedRevision
      || preview.unregisteredDestination !== input.expectedUnregisteredDestination
    ) throw new Error("Skill market installation facts changed after confirmation.");
    const requiresReplacement = preview.action === "replace"
      || preview.unregisteredDestination
      || preview.currentResource?.dirty === true;
    if (requiresReplacement && !input.allowReplacement) {
      throw new Error("Replacing existing or locally changed Skill content requires explicit confirmation.");
    }

    const source = normalizeStoredSkillMarketSource(input, inspected.inspection.revision);
    const expectedTarget = this.#records.get(inspected.resourceId);
    const replaced = inspected.current?.id === inspected.resourceId ? undefined : inspected.current;
    const now = this.#now();
    const preservesEnabled = inspected.current?.enabled === true && inspected.compatibility.canToggle;
    const preservesExplicitDisable = inspected.current?.state === "disabled";
    const base: StoredResource = {
      id: inspected.resourceId,
      backendId: nonBlank(input.backendId, "Backend ID"),
      ...(input.scope === "project" ? { targetId: nonBlank(input.targetId!, "Target ID") } : {}),
      kind: "skill",
      scope: input.scope,
      name: source.slug,
      version: boundedVersion(input.version),
      sourceKind: "skill_market",
      sourceIdentity: skillMarketSourceIdentity(source),
      sourceDisplay: skillMarketSourceDisplay(source),
      canonicalPathFingerprint: input.scope === "project"
        ? pathFingerprint(inspected.destination!)
        : skillMarketSourceFingerprint(source),
      symbolicLinkDetected: false,
      specialFileDetected: false,
      discoveredRevision: inspected.inspection.revision,
      ...compatibilityFields(inspected.compatibility, false),
      state: preservesExplicitDisable ? "disabled" : input.scope === "project" ? "approved" : "installed",
      enabled: preservesEnabled,
      approvedAt: now,
      approvedByConnectionId: nonBlank(input.approvedByConnectionId, "Approving connection ID"),
      versionNumber: ((expectedTarget === undefined ? 0n : BigInt(expectedTarget.versionNumber)) + 1n).toString(10),
      updatedAt: now,
      source,
      ...(input.scope === "project"
        ? { workspaceRoot: inspected.workspaceRoot!, canonicalPath: inspected.destination! }
        : {})
    };
    const mutation = input.scope === "global"
      ? await this.#prepareManagedMarketSkill(base, expectedTarget, replaced, inspected)
      : await this.#prepareProjectMarketSkill(base, expectedTarget, inspected);
    return { preview, mutation };
  }

  async #inspectMarketSkill(input: PiMarketSkillSourceInput & PiMarketSkillTargetInput): Promise<InspectedMarketSkill> {
    const backendId = nonBlank(input.backendId, "Backend ID");
    if (!this.#backendSupportsResourceKind(backendId, "skill")) {
      throw new Error("Selected Backend does not advertise Skill resources.");
    }
    const source = normalizeStoredSkillMarketSource(input);
    const candidateRoot = await canonicalDirectory(input.candidateRoot, "Skill market candidate");
    const inspection = await inspectSkillPackage(candidateRoot, this.#maximumFiles, this.#maximumBytes);
    const runtimeVersion = this.#runtimeVersion(backendId);
    const compatibility = await inspectPiResourceCompatibility("skill", candidateRoot, {
      ...(runtimeVersion === undefined ? {} : { currentRuntimeVersion: runtimeVersion }),
      contentFingerprint: inspection.revision
    });
    if (!compatibility.canToggle) throw new Error("Skill market candidate has no usable Skill content.");

    let workspaceRoot: string | undefined;
    let relativeParent: string | undefined;
    let destination: string | undefined;
    let resourceId: string;
    let current: StoredResource | undefined;
    let currentInspection: ResourceInspection | undefined;
    let unregisteredDestination = false;
    let beforeRoot: string | undefined;
    let diffAvailable = true;
    let diffReason: string | undefined;

    if (input.scope === "global") {
      if (input.targetId !== undefined || input.relativeParent !== undefined) {
        throw new Error("Global Skill market targets cannot declare a Target or project parent.");
      }
      resourceId = marketGlobalSkillResourceId(backendId, source.slug);
      const conflicts = [...this.#records.values()].filter((record) =>
        record.backendId === backendId && record.targetId === undefined && record.scope !== "project"
        && record.kind === "skill" && record.name === source.slug && record.state !== "removed");
      if (conflicts.length > 1) throw new Error("Multiple global Skills already claim this install name.");
      current = conflicts[0];
      if (current?.installedPath !== undefined) {
        assertExpectedInstalledLocation(this.#managedRoot, current);
        await assertContainedPath(this.#managedRoot, current.installedPath, "Existing global Skill");
        currentInspection = await inspectSkillPackage(current.installedPath, this.#maximumFiles, this.#maximumBytes);
        beforeRoot = current.installedPath;
      } else if (current !== undefined) {
        diffAvailable = false;
        diffReason = "Existing Skill content is not installed, so its overwrite baseline is unavailable.";
      }
    } else if (input.scope === "project") {
      const targetId = nonBlank(input.targetId!, "Target ID");
      workspaceRoot = this.#assertTrustedProjectTarget(backendId, targetId);
      relativeParent = input.relativeParent === undefined
        ? ".agents/skills"
        : portableProjectSkillParent(input.relativeParent);
      const parent = await resolveProjectSkillParent(workspaceRoot, relativeParent, false);
      destination = join(parent, source.slug);
      assertWithin(workspaceRoot, destination, "Project Skill market destination");
      resourceId = stableDiscoveredResourceId(backendId, targetId, "skill", destination);
      const stored = this.#records.get(resourceId);
      if (stored !== undefined && stored.state !== "removed") {
        if (stored.kind !== "skill" || stored.scope !== "project" || stored.backendId !== backendId || stored.targetId !== targetId
          || !isDirectProjectResource(stored) || !samePath(stored.canonicalPath, destination)) {
          throw new Error("Project Skill install slot is owned by a different Resource.");
        }
        current = stored;
      }
      const destinationInfo = await optionalLstat(destination);
      if (destinationInfo !== undefined) {
        if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) {
          throw new Error("Project Skill install destination is not a regular directory.");
        }
        currentInspection = await inspectSkillPackage(destination, this.#maximumFiles, this.#maximumBytes);
        beforeRoot = destination;
        unregisteredDestination = current === undefined;
      } else if (current !== undefined) {
        throw new Error("Registered project Skill content is missing.");
      }
      this.#assertTrustedProjectTarget(backendId, targetId, workspaceRoot);
    } else {
      throw new Error("Skill market target scope is invalid.");
    }

    const sameMarketEntry = current?.source.kind === "skill_market"
      && current.source.sourceId === source.sourceId
      && current.source.entryId === source.entryId;
    const sourceReplacement = current !== undefined && !sameMarketEntry;
    const action: PiMarketSkillAction = current === undefined && !unregisteredDestination
      ? "install"
      : sameMarketEntry && current?.id === resourceId
        ? "update"
        : "replace";
    const diff = diffAvailable
      ? await compareMarketSkillTrees(beforeRoot, candidateRoot)
      : { changes: [] as readonly PiMarketSkillDiffChange[], truncated: false };
    // Every filesystem inspection above yields; repeat durable and Target
    // authority before publishing advisory facts.
    if (!this.#backendSupportsResourceKind(backendId, "skill")) throw new Error("Selected Backend Skill capability changed.");
    if (input.scope === "project") this.#assertTrustedProjectTarget(backendId, input.targetId, workspaceRoot);
    const liveCurrent = current === undefined ? undefined : this.#records.get(current.id);
    if (liveCurrent !== current) throw new Error("Skill Resource authority changed during market preview.");
    return {
      inspection,
      compatibility,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      ...(relativeParent === undefined ? {} : { relativeParent }),
      ...(destination === undefined ? {} : { destination }),
      resourceId,
      ...(current === undefined ? {} : { current }),
      ...(currentInspection === undefined ? {} : { currentInspection }),
      unregisteredDestination,
      sourceReplacement,
      diffAvailable,
      ...(diffReason === undefined ? {} : { diffReason }),
      changes: diff.changes,
      diffTruncated: diff.truncated
    };
  }

  async #prepareManagedMarketSkill(
    seed: StoredResource,
    expectedTarget: StoredResource | undefined,
    replaced: StoredResource | undefined,
    inspected: InspectedMarketSkill
  ): Promise<PreparedPiResourceMutation<PiResourceDescriptor>> {
    const owner = resourceOwnerPath(this.#managedRoot, seed);
    await mkdir(owner, { recursive: true, mode: 0o700 });
    await assertContainedRegularDirectory(this.#managedRoot, owner, "Managed Skill owner directory");
    const generations = join(owner, RESOURCE_GENERATIONS_DIRECTORY);
    await mkdir(generations, { recursive: true, mode: 0o700 });
    await assertContainedRegularDirectory(this.#managedRoot, generations, "Managed Skill generations directory");
    const generation = randomUUID();
    const candidateContainer = join(generations, generation);
    const stage = join(this.#managedRoot, ".staging", `market-skill-${generation}`);
    const stagedPayload = join(stage, safePayloadName(seed.name));
    await mkdir(stage, { recursive: false, mode: 0o700 });
    let published = false;
    try {
      await mkdir(stagedPayload, { recursive: false, mode: 0o700 });
      await copyTreeFailClosed(inspected.inspection.canonicalPath, inspected.inspection.canonicalPath, stagedPayload, {
        files: 0,
        bytes: 0,
        maxFiles: this.#maximumFiles,
        maxBytes: this.#maximumBytes
      });
      await syncTreeForPublish(stagedPayload);
      const stagedInspection = await inspectSkillPackage(stagedPayload, this.#maximumFiles, this.#maximumBytes);
      if (stagedInspection.revision !== inspected.inspection.revision) throw new Error("Skill market candidate changed while it was staged.");
      await rename(stage, candidateContainer);
      published = true;
      const installedPath = join(candidateContainer, safePayloadName(seed.name));
      const installedInspection = await inspectSkillPackage(installedPath, this.#maximumFiles, this.#maximumBytes);
      if (installedInspection.revision !== inspected.inspection.revision) throw new Error("Published market Skill differs from its candidate.");
      const updated: StoredResource = { ...seed, installedPath };
      assertExpectedInstalledLocation(this.#managedRoot, updated);
      const entries: PreparedCatalogEntry[] = [{ id: updated.id, expected: expectedTarget, next: updated }];
      if (replaced !== undefined) {
        const { pendingUpdate: _pendingUpdate, ...withoutPending } = omitInstalledPath(replaced);
        entries.push({
          id: replaced.id,
          expected: replaced,
          next: {
            ...withoutPending,
            state: "removed",
            enabled: false,
            versionNumber: (BigInt(replaced.versionNumber) + 1n).toString(10),
            updatedAt: this.#now()
          }
        });
      }
      return this.#prepareMutation(entries, publicResource(updated), undefined, {
        rollback: () => this.#removeCandidateGeneration(seed, candidateContainer),
        cleanupAfterCommit: async () => {
          if (expectedTarget?.installedPath !== undefined) await this.#removeInstalledIncarnation(expectedTarget).catch(() => undefined);
          if (replaced !== undefined) await this.#removeResourceOwner(replaced).catch(() => undefined);
        }
      });
    } catch (error) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      if (published) await this.#removeCandidateGeneration(seed, candidateContainer).catch(() => undefined);
      else await this.#pruneResourceOwner(seed).catch(() => undefined);
      throw error;
    }
  }

  async #prepareProjectMarketSkill(
    updated: StoredResource,
    expected: StoredResource | undefined,
    inspected: InspectedMarketSkill
  ): Promise<PreparedPiResourceMutation<PiResourceDescriptor>> {
    const workspaceRoot = inspected.workspaceRoot!;
    const destination = inspected.destination!;
    const parent = await resolveProjectSkillParent(workspaceRoot, inspected.relativeParent!, true);
    if (!samePath(destination, join(parent, updated.name))) throw new Error("Project Skill destination changed while its parent was prepared.");
    const transactionRoot = join(parent, PROJECT_SKILL_TRANSACTION_DIRECTORY);
    await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
    await assertContainedRegularDirectory(workspaceRoot, transactionRoot, "Project Skill transaction directory");
    const transactionId = randomUUID();
    const stage = join(transactionRoot, `${transactionId}.stage`);
    const backup = join(transactionRoot, `${transactionId}.backup`);
    const journal: ProjectMarketSkillTransactionJournal = {
      format: 1,
      kind: "market_install",
      transactionId,
      backendId: updated.backendId,
      targetId: updated.targetId!,
      workspaceRoot,
      destinationPath: destination,
      resourceId: updated.id,
      expectedResourceVersion: expected?.versionNumber ?? null,
      expectedResourceRevision: expected?.discoveredRevision ?? null,
      expectedDestinationRevision: inspected.currentInspection?.revision ?? null,
      committedResourceVersion: updated.versionNumber,
      committedRevision: updated.discoveredRevision,
      sourceId: (updated.source as StoredSkillMarketSource).sourceId,
      entryId: (updated.source as StoredSkillMarketSource).entryId,
      entryContentRevision: (updated.source as StoredSkillMarketSource).entryContentRevision
    };
    let journalPath: string | undefined;
    try {
      journalPath = await this.#writeProjectMarketSkillTransactionJournal(journal);
      await mkdir(stage, { recursive: false, mode: 0o700 });
      await copyTreeFailClosed(inspected.inspection.canonicalPath, inspected.inspection.canonicalPath, stage, {
        files: 0,
        bytes: 0,
        maxFiles: this.#maximumFiles,
        maxBytes: this.#maximumBytes
      });
      await syncTreeForPublish(stage);
      const stagedInspection = await inspectSkillPackage(stage, this.#maximumFiles, this.#maximumBytes);
      if (stagedInspection.revision !== inspected.inspection.revision) throw new Error("Skill market candidate changed while it was staged.");
      const currentDestination = await optionalLstat(destination);
      if (journal.expectedDestinationRevision === null) {
        if (currentDestination !== undefined) throw new Error("Project Skill destination became occupied before installation.");
      } else {
        if (currentDestination === undefined) throw new Error("Project Skill destination disappeared before replacement.");
        const observed = await inspectSkillPackage(destination, this.#maximumFiles, this.#maximumBytes);
        if (observed.revision !== journal.expectedDestinationRevision) throw new Error("Project Skill destination changed before replacement.");
        await rename(destination, backup);
      }
      try {
        await rename(stage, destination);
      } catch (error) {
        if (await optionalLstat(backup) !== undefined && await optionalLstat(destination) === undefined) await rename(backup, destination);
        throw error;
      }
      const published = await inspectSkillPackage(destination, this.#maximumFiles, this.#maximumBytes);
      if (published.revision !== inspected.inspection.revision) throw new Error("Published project market Skill differs from its candidate.");
      return this.#prepareMutation(
        [{ id: updated.id, expected, next: updated }],
        publicResource(updated),
        () => this.#assertTrustedProjectTarget(updated.backendId, updated.targetId, workspaceRoot),
        {
          rollback: () => this.#recoverProjectMarketSkillTransaction(journalPath!, journal),
          cleanupAfterCommit: () => this.#recoverProjectMarketSkillTransaction(journalPath!, journal)
        }
      );
    } catch (error) {
      if (journalPath !== undefined) {
        try {
          await this.#recoverProjectMarketSkillTransaction(journalPath, journal);
        } catch (recoveryError) {
          throw new AggregateError([error, recoveryError], "Project market Skill publication failed and its durable rollback requires recovery.");
        }
      }
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      if (await directoryIsEmpty(transactionRoot)) await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Discover adapter-native project resources after explicit Target trust. */
  async prepareDiscoverProjectResources(
    input: DiscoverProjectResourcesInput
  ): Promise<PreparedPiResourceMutation<readonly PiResourceDescriptor[]>> {
    this.#assertInitialized();
    const backendId = nonBlank(input.backendId, "Backend ID");
    const targetId = nonBlank(input.targetId, "Target ID");
    const kinds = projectResourceKindSet(input.kinds);
    const target = this.#store.getTarget(targetId);
    assertTargetNotDeleted(target.metadata);
    if (target.descriptor.backendId !== backendId) throw new Error("Target does not belong to the requested Backend.");
    if (!target.descriptor.trusted) throw new Error("Project resources can only be discovered after the Target is trusted.");
    const workspaceRoot = await canonicalDirectory(target.descriptor.workspaceRoot, "Project resource workspace");
    const adapterKind = this.#store.getBackend(backendId).descriptor.adapterKind;
    const candidates = await discoverCanonicalProjectCandidates(workspaceRoot, this.#maximumFiles, kinds, adapterKind);

    // Inspect and classify every candidate before creating the batch. An
    // unsafe or incompatible candidate therefore prevents every catalog write.
    const runtimeVersion = this.#runtimeVersion(backendId);
    const inspected = await Promise.all(candidates.map(async (candidate) => {
      const inspection = await inspectResourceForKind(candidate.kind, candidate.sourcePath, this.#maximumFiles, this.#maximumBytes);
      const compatibility = await inspectPiResourceCompatibility(candidate.kind, inspection.canonicalPath, {
        ...(runtimeVersion === undefined ? {} : { currentRuntimeVersion: runtimeVersion }),
        contentFingerprint: inspection.revision
      });
      return { candidate, inspection, compatibility };
    }));
    // Filesystem traversal yields. Revalidate durable ownership, trust and the
    // exact workspace root before deriving a catalog plan from those bytes.
    this.#assertTrustedProjectTarget(backendId, targetId, workspaceRoot);
    const plans = inspected.map(({ candidate, inspection, compatibility }) => {
      const source = { kind: "local", path: candidate.sourcePath } as const;
      const resourceInput: DiscoverPiResourceInput = {
        id: stableDiscoveredResourceId(backendId, targetId, candidate.kind, candidate.sourcePath),
        backendId,
        targetId,
        kind: candidate.kind,
        scope: "project",
        name: candidate.name,
        source,
        workspaceRoot
      };
      return this.#planLocalDiscovery(
        resourceInput,
        resourceInput.id!,
        source,
        inspection,
        compatibility,
        workspaceRoot
      );
    });
    return this.#prepareMutation(
      plans.map((plan) => plan.entry),
      Object.freeze(plans.map((plan) => plan.value)),
      () => { void this.#assertTrustedProjectTarget(backendId, targetId, workspaceRoot); }
    );
  }

  async discoverProjectResources(input: DiscoverProjectResourcesInput): Promise<readonly PiResourceDescriptor[]> {
    return this.#completePreparedStandalone(await this.prepareDiscoverProjectResources(input));
  }

  async prepareApprove(
    resourceId: string,
    discoveredRevision: string,
    approvedByConnectionId: string
  ): Promise<PreparedPiResourceMutation<PiResourceDescriptor>> {
    this.#assertInitialized();
    const current = this.#require(resourceId);
    if (current.state === "removed") throw new Error("Removed resource cannot be approved.");
    this.#assertStoredProjectTargetTrusted(current);
    if (current.discoveredRevision !== discoveredRevision) throw new Error("Resource discovery revision is stale.");
    const installedExtensionApproval = current.installedPath !== undefined
      && current.requiresExtensionApproval
      && current.extensionContentFingerprint === discoveredRevision;
    if (installedExtensionApproval) {
      await this.#assertInstalledSafe(current);
    } else if (current.source.kind === "local") {
      if (current.canonicalPath === undefined) throw new Error("Local resource is missing its canonical source path.");
      const inspection = await inspectResourceForKind(current.kind, current.canonicalPath, this.#maximumFiles, this.#maximumBytes);
      if (current.workspaceRoot !== undefined) assertWithin(current.workspaceRoot, inspection.canonicalPath, "Project resource");
      if (inspection.revision !== discoveredRevision || !samePath(inspection.canonicalPath, current.canonicalPath)) {
        throw new Error("Resource changed after discovery and must be discovered again.");
      }
    } else if (current.source.kind === "extension_source" || current.source.kind === "skill_market") {
      throw new Error("Source-owned resource approval must use its exact catalog entry.");
    } else if (current.kind !== "package" || piPackageSourceApprovalRevision(current.source) !== discoveredRevision) {
      throw new Error("Package acquisition source changed after discovery and must be discovered again.");
    }
    const approvesExtensionContent = current.extensionContentFingerprint === discoveredRevision;
    const nextRequiresExtensionApproval = current.requiresExtensionApproval && !approvesExtensionContent;
    const updated: StoredResource = {
      ...current,
      state: current.installedPath === undefined ? "approved" : "installed",
      enabled: false,
      requiresExtensionApproval: nextRequiresExtensionApproval,
      postMutationNotice: shouldShowPiPackageNotice(inspectionFromRecord(current), nextRequiresExtensionApproval),
      ...(approvesExtensionContent ? { extensionApprovedRevision: discoveredRevision } : {}),
      approvedAt: this.#now(),
      approvedByConnectionId: nonBlank(approvedByConnectionId, "Approving connection ID"),
      versionNumber: (BigInt(current.versionNumber) + 1n).toString(10),
      updatedAt: this.#now()
    };
    return this.#prepareMutation(
      [{ id: resourceId, expected: current, next: updated }],
      publicResource(updated),
      current.scope === "project" ? () => this.#assertStoredProjectTargetTrusted(current) : undefined
    );
  }

  async approve(resourceId: string, discoveredRevision: string, approvedByConnectionId: string): Promise<PiResourceDescriptor> {
    return this.#completePreparedStandalone(await this.prepareApprove(resourceId, discoveredRevision, approvedByConnectionId));
  }

  async prepareInstall(resourceId: string): Promise<PreparedPiResourceMutation<PiResourceDescriptor>> {
    this.#assertInitialized();
    const current = this.#require(resourceId);
    return this.#prepareInstalledMutation(current, current);
  }

  async install(resourceId: string): Promise<PiResourceDescriptor> {
    return this.#completePreparedStandalone(await this.prepareInstall(resourceId));
  }

  async prepareUpdate(
    resourceId: string,
    input: UpdatePiResourceInput
  ): Promise<PreparedPiResourceMutation<PiResourceDescriptor>> {
    this.#assertInitialized();
    const current = this.#require(resourceId);
    if (!(current.state === "installed" || current.state === "loaded" || current.state === "disabled" || current.state === "update_available")) {
      throw new Error("Only an installed resource can be updated.");
    }
    if (current.source.kind === "extension_source" || current.source.kind === "skill_market") {
      throw new Error("Source-owned resources must be updated through their revision-fenced catalog entry.");
    }
    this.#assertStoredProjectTargetTrusted(current);
    if (input.source !== undefined && input.requestedVersion !== undefined) throw new Error("Typed resource acquisition and requested_version cannot both be set.");
    if (input.source !== undefined && input.source.kind !== "local" && current.kind !== "package") {
      throw new Error("Non-package resources require a local acquisition source.");
    }
    const pendingUpdate = input.source === undefined && input.requestedVersion === undefined
      ? current.pendingUpdate
      : undefined;
    const requestedSource = input.source !== undefined
      ? normalizePiPackageSource(input.source)
      : input.requestedVersion !== undefined
        ? piPackageSourceWithVersion(current.source, input.requestedVersion)
        : pendingUpdate?.source ?? current.source;
    let inspection: ResourceInspection | undefined;
    if (requestedSource.kind === "local") {
      inspection = await inspectResourceForKind(current.kind, requestedSource.path, this.#maximumFiles, this.#maximumBytes);
      if (current.workspaceRoot !== undefined) assertWithin(current.workspaceRoot, inspection.canonicalPath, "Project resource");
    }
    const requestedIdentity = current.kind === "package"
      ? piPackageSourceIdentity(requestedSource)
      : `${current.kind}:${pathIdentity(inspection!.canonicalPath)}`;
    if (requestedIdentity !== current.sourceIdentity) {
      throw new Error("Resource update cannot change resource identity; add it as a new resource.");
    }
    const requestedRevision = inspection?.revision ?? piPackageSourceApprovalRevision(requestedSource);
    if (pendingUpdate !== undefined && requestedRevision !== pendingUpdate.discoveredRevision) {
      throw new Error("Resource changed after update discovery and must be discovered again.");
    }
    const compatibility = inspection === undefined
      ? undefined
      : await inspectPiResourceCompatibility(current.kind, inspection.canonicalPath, {
          ...(this.#runtimeVersion(current.backendId) === undefined
            ? {}
            : { currentRuntimeVersion: this.#runtimeVersion(current.backendId)! }),
          contentFingerprint: inspection.revision
        });
    const {
      canonicalPath: _canonicalPath,
      extensionApprovedRevision: _extensionApprovedRevision,
      pendingUpdate: _pendingUpdate,
      error: _error,
      ...currentBase
    } = current;
    const sourceDisplay = piPackageSourceDisplay(requestedSource);
    const approved: StoredResource = {
      ...currentBase,
      name: pendingUpdate?.name ?? current.name,
      source: requestedSource,
      sourceKind: requestedSource.kind,
      sourceDisplay,
      canonicalPathFingerprint: inspection === undefined
        ? `sha256:${createHash("sha256").update(current.sourceIdentity).digest("hex")}`
        : pathFingerprint(inspection.canonicalPath),
      discoveredRevision: requestedRevision,
      ...(compatibility === undefined
        ? emptyCompatibilityFields()
        : compatibilityFields(compatibility, false)),
      ...(current.kind === "package" && compatibility !== undefined
        ? { packageIdentity: compatibility.name }
        : {}),
      ...(compatibility?.extensionContentFingerprint === undefined
        ? {}
        : { extensionApprovedRevision: compatibility.extensionContentFingerprint }),
      ...(requestedSource.kind === "local" ? { canonicalPath: inspection!.canonicalPath } : {}),
      ...(pendingUpdate?.version === undefined ? {} : { version: pendingUpdate.version }),
      ...(input.requestedVersion === undefined ? {} : { version: nonBlank(input.requestedVersion, "Requested resource version") }),
      state: "approved",
      enabled: false,
      approvedAt: this.#now(),
      approvedByConnectionId: nonBlank(input.approvedByConnectionId, "Approving connection ID"),
      versionNumber: (BigInt(current.versionNumber) + 1n).toString(10),
      updatedAt: this.#now()
    };
    if (isDirectProjectResource(approved)) {
      return this.#prepareMutation(
        [{ id: resourceId, expected: current, next: approved }],
        publicResource(approved),
        () => this.#assertStoredProjectTargetTrusted(current)
      );
    }
    return this.#prepareInstalledMutation(current, approved);
  }

  async update(resourceId: string, input: UpdatePiResourceInput): Promise<PiResourceDescriptor> {
    return this.#completePreparedStandalone(await this.prepareUpdate(resourceId, input));
  }

  async prepareSetEnabled(resourceId: string, enabled: boolean): Promise<PreparedPiResourceMutation<PiResourceDescriptor>> {
    this.#assertInitialized();
    const current = this.#require(resourceId);
    // A redundant disable is an exact no-op. In particular, it must not turn
    // an unapproved or removed project resource into the otherwise valid
    // `disabled` state and thereby create an approval bypass on re-enable.
    if (!enabled && !current.enabled) {
      return this.#prepareMutation(
        [{ id: resourceId, expected: current, next: current }],
        publicResource(current)
      );
    }
    if (enabled) {
      this.#assertStoredProjectTargetTrusted(current);
      if (!current.canToggle) throw new Error("Resource has no headless-compatible runtime content to enable.");
      if (
        current.requiresExtensionApproval ||
        current.extensionContentFingerprint !== undefined && current.extensionApprovedRevision !== current.extensionContentFingerprint
      ) {
        throw new Error("Extension content must be approved at its current fingerprint before it can be enabled.");
      }
      if (isDirectProjectResource(current)) {
        if (!(current.state === "approved" || current.state === "disabled" || current.state === "loaded")) throw new Error("Project resource is not approved.");
        await this.#assertSourceUnchanged(current);
      } else {
        if (current.installedPath === undefined || !(current.state === "installed" || current.state === "disabled" || current.state === "loaded")) {
          throw new Error("Managed resource is not installed.");
        }
        await this.#assertInstalledSafe(current);
      }
    }
    const updated: StoredResource = {
      ...current,
      enabled,
      state: enabled ? (current.state === "loaded" ? "loaded" : isDirectProjectResource(current) ? "approved" : "installed") : "disabled",
      versionNumber: (BigInt(current.versionNumber) + 1n).toString(10),
      updatedAt: this.#now()
    };
    return this.#prepareMutation(
      [{ id: resourceId, expected: current, next: updated }],
      publicResource(updated),
      enabled && current.scope === "project" ? () => this.#assertStoredProjectTargetTrusted(current) : undefined
    );
  }

  async setEnabled(resourceId: string, enabled: boolean): Promise<PiResourceDescriptor> {
    return this.#completePreparedStandalone(await this.prepareSetEnabled(resourceId, enabled));
  }

  /** Only an adapter/runtime observation of this exact content revision may promote installed to loaded. */
  async markLoaded(
    resourceId: string,
    loaded: boolean,
    error?: string,
    observation?: PiResourceLoadObservation
  ): Promise<PiResourceDescriptor> {
    this.#assertInitialized();
    return this.#mutate(async () => {
      const current = this.#require(resourceId);
      if (loaded && observation === undefined) {
        throw new Error("A generation- and revision-fenced runtime observation is required to mark a resource loaded.");
      }
      const observationIsCurrent = (): boolean => {
        if (observation === undefined) return true;
        if (
          current.discoveredRevision !== observation.discoveredRevision ||
          BigInt(current.versionNumber) !== observation.resourceVersion
        ) return false;
        try {
          const session = this.#store.getSession(observation.sessionId);
          return session.descriptor.backendId === current.backendId &&
            (current.targetId === undefined || session.descriptor.targetId === current.targetId) &&
            session.descriptor.binding.generation === observation.runtimeGeneration;
        } catch {
          return false;
        }
      };
      if (!observationIsCurrent()) {
        // Publication may have installed a newer immutable revision while an
        // old runtime observation was in flight. A stale observation is a
        // deliberate no-op, never authority to promote the replacement.
        return publicResource(current);
      }
      this.#assertStoredProjectTargetTrusted(current);
      if (!current.enabled) throw new Error("Disabled resource cannot be marked loaded.");
      if (loaded) {
        if (isDirectProjectResource(current)) await this.#assertSourceUnchanged(current);
        else await this.#assertInstalledSafe(current);
        // Filesystem validation yields. Recheck the live Session generation at
        // the final commit boundary so a concurrent restart cannot land an old
        // runtime's observation.
        if (!observationIsCurrent()) return publicResource(current);
      }
      const { error: _oldError, ...withoutError } = current;
      const updated: StoredResource = {
        ...withoutError,
        state: loaded ? "loaded" : "error",
        ...(!loaded && error !== undefined ? { error: redactSecrets(error).slice(0, 2_048) } : {}),
        versionNumber: (BigInt(current.versionNumber) + 1n).toString(10),
        updatedAt: this.#now()
      };
      this.#records.set(resourceId, updated);
      this.#persistWithRollback(resourceId, current);
      return publicResource(updated);
    });
  }

  async prepareRemove(resourceId: string): Promise<PreparedPiResourceMutation<PiResourceDescriptor>> {
    this.#assertInitialized();
    const current = this.#require(resourceId);
    if (current.state === "removed" && current.installedPath === undefined && current.pendingUpdate === undefined) {
      return this.#prepareMutation(
        [{ id: resourceId, expected: current, next: current }],
        publicResource(current)
      );
    }
    if (current.installedPath !== undefined) {
      assertExpectedInstalledLocation(this.#managedRoot, current);
      await assertContainedPathIfPresent(this.#managedRoot, current.installedPath, "Installed resource");
    }
    const { pendingUpdate: _pendingUpdate, ...withoutPendingUpdate } = omitInstalledPath(current);
    const updated: StoredResource = {
      ...withoutPendingUpdate,
      state: "removed",
      enabled: false,
      versionNumber: (BigInt(current.versionNumber) + 1n).toString(10),
      updatedAt: this.#now()
    };
    return this.#prepareMutation(
      [{ id: resourceId, expected: current, next: updated }],
      publicResource(updated),
      undefined,
      {
        rollback: async () => undefined,
        ...(current.installedPath === undefined
          ? {}
          : { cleanupAfterCommit: () => this.#removeResourceOwner(current) })
      }
    );
  }

  async remove(resourceId: string): Promise<PiResourceDescriptor> {
    return this.#completePreparedStandalone(await this.prepareRemove(resourceId));
  }

  /** Callback passed directly to PiAdapterOptions.approveProjectSkill. */
  async approveProjectSkill(candidate: ProjectSkillCandidate): Promise<boolean> {
    this.#assertInitialized();
    const inspection = await inspectSkillPackage(candidate.sourcePath, this.#maximumFiles, this.#maximumBytes).catch(() => undefined);
    if (inspection === undefined) return false;
    for (const record of this.#records.values()) {
      try { this.#assertStoredProjectTargetTrusted(record); } catch { continue; }
      if (
        this.#backendSupportsResourceKind(record.backendId, record.kind) &&
        record.kind === "skill" &&
        record.scope === "project" &&
        isDirectProjectResource(record) &&
        record.canonicalPath !== undefined &&
        record.enabled &&
        (record.state === "approved" || record.state === "loaded") &&
        record.workspaceRoot !== undefined &&
        samePath(record.workspaceRoot, candidate.workspaceRoot) &&
        samePath(record.canonicalPath, inspection.canonicalPath) &&
        record.discoveredRevision === inspection.revision
      ) return true;
    }
    return false;
  }

  async runtimeSnapshot(backendId: string, targetId?: string): Promise<PiRuntimeResourceSnapshot> {
    return this.#runtimeSnapshot(backendId, targetId, false);
  }

  /** Target-specific resources layered over the immutable global generation. */
  async targetRuntimeSnapshot(backendId: string, targetId: string): Promise<PiRuntimeResourceSnapshot> {
    return this.#runtimeSnapshot(backendId, targetId, true);
  }

  /**
   * Capture approved prompt/skill text for one exact Backend Target without
   * exposing its service-owned source path. The read shares the mutation tail,
   * so every returned seed belongs to one coherent catalog incarnation.
   */
  async runtimeTextSnapshot(
    backendId: string,
    targetId: string,
    signal: AbortSignal
  ): Promise<readonly RuntimeTextResourceSeed[]> {
    this.#assertInitialized();
    const expectedBackendId = nonBlank(backendId, "Backend ID");
    const expectedTargetId = nonBlank(targetId, "Target ID");
    signal.throwIfAborted();
    const snapshot = this.#mutate(async () => {
      signal.throwIfAborted();
      this.#assertTargetOwner(expectedBackendId, expectedTargetId);
      const records = [...this.#records.values()]
        .filter((record) => record.backendId === expectedBackendId)
        .filter((record) => record.targetId === undefined || record.targetId === expectedTargetId)
        .filter((record): record is StoredResource & { readonly kind: "skill" | "prompt" } =>
          record.kind === "skill" || record.kind === "prompt")
        .filter((record) => this.#backendSupportsResourceKind(record.backendId, record.kind))
        .filter((record) => record.enabled && runtimeTextState(record.state))
        .sort((left, right) => left.name.localeCompare(right.name, "en") || left.id.localeCompare(right.id, "en"));
      const seeds: RuntimeTextResourceSeed[] = [];
      let totalTextBytes = 0;
      for (const record of records) {
        signal.throwIfAborted();
        this.#assertStoredProjectTargetTrusted(record);
        const root = await this.#runtimeTextRoot(record, signal);
        const before = await inspectResourceForKind(record.kind, root, this.#maximumFiles, this.#maximumBytes, signal);
        assertApprovedRuntimeTextInspection(record, root, before);
        const content = await readRuntimeTextContent(
          root,
          record.kind,
          Math.min(this.#maximumBytes, MAXIMUM_RUNTIME_TEXT_RESOURCE_BYTES),
          signal
        );
        totalTextBytes += Buffer.byteLength(content, "utf8");
        if (totalTextBytes > this.#maximumBytes) {
          throw new Error("Runtime text resource snapshot exceeds the configured byte limit.");
        }
        const after = await inspectResourceForKind(record.kind, root, this.#maximumFiles, this.#maximumBytes, signal);
        assertApprovedRuntimeTextInspection(record, root, after);
        if (before.revision !== after.revision || !samePath(before.canonicalPath, after.canonicalPath)) {
          throw new Error("Runtime text resource changed while its content was read.");
        }
        const authority = {
          id: record.id,
          backendId: record.backendId,
          targetId: record.targetId,
          scope: record.scope,
          kind: record.kind,
          state: record.state,
          revision: record.discoveredRevision,
          versionNumber: record.versionNumber,
          version: record.version,
          sourceIdentity: record.sourceIdentity,
          approvedAt: record.approvedAt,
          approvedByConnectionId: record.approvedByConnectionId
        } as const;
        const assertCurrent = (): void => {
          this.#assertTargetOwner(expectedBackendId, expectedTargetId);
          const current = this.#records.get(authority.id);
          // A live runtime observation advances only the durable presentation
          // state from approved/installed to loaded. Accept that single exact
          // transition; every disable, re-enable, update, or replacement
          // advances the entity again and therefore revokes this seed.
          const sameRuntimeIncarnation = current !== undefined && (
            (current.state === authority.state && current.versionNumber === authority.versionNumber)
            || (
              current.state === "loaded"
              && (authority.state === "approved" || authority.state === "installed")
              && BigInt(current.versionNumber) === BigInt(authority.versionNumber) + 1n
            )
          );
          if (
            current === undefined || !current.enabled
            || !this.#backendSupportsResourceKind(current.backendId, current.kind)
            || current.backendId !== authority.backendId
            || current.targetId !== authority.targetId
            || current.scope !== authority.scope
            || current.kind !== authority.kind
            || !sameRuntimeIncarnation
            || current.discoveredRevision !== authority.revision
            || current.version !== authority.version
            || current.sourceIdentity !== authority.sourceIdentity
            || current.approvedAt !== authority.approvedAt
            || current.approvedByConnectionId !== authority.approvedByConnectionId
          ) throw new Error("Runtime text resource authority is no longer current.");
          this.#assertStoredProjectTargetTrusted(current);
        };
        assertCurrent();
        seeds.push(Object.freeze({
          id: authority.id,
          kind: authority.kind,
          name: record.name,
          revision: authority.revision,
          resourceVersion: BigInt(authority.versionNumber),
          ...(authority.version === undefined ? {} : { version: authority.version }),
          content,
          assertCurrent
        }));
      }
      signal.throwIfAborted();
      return Object.freeze(seeds);
    });
    return waitForCaller(snapshot, signal);
  }

  async #runtimeSnapshot(backendId: string, targetId: string | undefined, targetOnly: boolean): Promise<PiRuntimeResourceSnapshot> {
    this.#assertInitialized();
    const paths: Record<PiResourceKind, string[]> = { extension: [], skill: [], prompt: [], theme: [], package: [] };
    const resources: RuntimeResource[] = [];
    for (const record of this.#records.values()) {
      if (record.backendId !== backendId || !record.enabled || record.state === "removed" || record.state === "error") continue;
      if (record.kind === "theme") continue;
      if (!this.#backendSupportsResourceKind(record.backendId, record.kind)) continue;
      if (targetOnly ? record.targetId !== targetId : record.targetId !== undefined && targetId !== record.targetId) continue;
      let path: string;
      if (isDirectProjectResource(record)) {
        if (!(record.state === "approved" || record.state === "installed" || record.state === "loaded")) continue;
        this.#assertStoredProjectTargetTrusted(record);
        await this.#assertSourceUnchanged(record);
        path = record.canonicalPath;
      } else {
        if (record.installedPath === undefined || !(record.state === "installed" || record.state === "loaded")) continue;
        await this.#assertInstalledSafe(record);
        path = record.installedPath;
      }
      paths[record.kind].push(path);
      resources.push({
        id: record.id,
        kind: record.kind,
        name: record.name,
        source: record.sourceIdentity,
        // Loaded is runtime-specific and must be re-proven by the current Pi
        // process. A previous runtime's observation never enters a new
        // immutable snapshot as already loaded.
        state: "approved",
        revision: record.discoveredRevision,
        resourceVersion: BigInt(record.versionNumber),
        runtimePath: path,
        ...(record.version === undefined
          ? {}
          : { version: record.version, detail: `version ${record.version}` }),
        ...(record.source.kind === "skill_market"
          ? {
              market: {
                sourceId: record.source.sourceId,
                sourceRevision: BigInt(record.source.sourceRevision),
                entryId: record.source.entryId,
                entryRevision: BigInt(record.source.entryRevision),
                entryContentRevision: record.source.entryContentRevision,
                installedContentRevision: record.source.installedContentRevision
              }
            }
          : {})
      });
    }
    return {
      extensions: paths.extension.sort(),
      skills: paths.skill.sort(),
      prompts: paths.prompt.sort(),
      themes: paths.theme.sort(),
      packages: paths.package.sort(),
      resources
    };
  }

  async #writeProjectSkillTransactionJournal(journal: ProjectSkillTransactionJournal): Promise<string> {
    const validated = this.#validateProjectSkillTransactionJournal(journal, journal.transactionId);
    const root = join(this.#managedRoot, PROJECT_SKILL_TRANSACTION_JOURNALS_DIRECTORY);
    const destination = join(root, `${validated.transactionId}.json`);
    const temporary = join(root, `${validated.transactionId}.tmp`);
    if (await optionalLstat(destination) !== undefined || await optionalLstat(temporary) !== undefined) {
      throw new Error("Project Skill transaction journal already exists.");
    }
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(validated)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      await rename(temporary, destination);
      return destination;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #recoverProjectSkillTransactions(): Promise<void> {
    const root = join(this.#managedRoot, PROJECT_SKILL_TRANSACTION_JOURNALS_DIRECTORY);
    const entries = await readdir(root, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      validateEntryName(entry.name);
      const path = join(root, entry.name);
      if (PROJECT_SKILL_TRANSACTION_TEMP_PATTERN.test(entry.name)) {
        await removeOwnedPath(root, path, "Incomplete project Skill transaction journal");
        continue;
      }
      const match = PROJECT_SKILL_TRANSACTION_JOURNAL_PATTERN.exec(entry.name);
      if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("Project Skill transaction journal directory contains an unsupported current-v1 entry.");
      }
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > MAXIMUM_PROJECT_SKILL_TRANSACTION_JOURNAL_BYTES) {
        throw new Error("Project Skill transaction journal is malformed.");
      }
      await assertContainedPath(root, path, "Project Skill transaction journal");
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path, "utf8"));
      } catch {
        throw new Error("Project Skill transaction journal is not valid JSON.");
      }
      const journal = this.#validateProjectSkillTransactionJournal(parsed, match[1]!);
      await this.#recoverProjectSkillTransaction(path, journal);
    }
  }

  #validateProjectSkillTransactionJournal(value: unknown, expectedTransactionId: string): ProjectSkillTransactionJournal {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Project Skill transaction journal is malformed.");
    }
    const record = value as Record<string, unknown>;
    const keys = [
      "format", "kind", "transactionId", "backendId", "targetId", "workspaceRoot",
      "sourcePath", "destinationPath", "expectedResourceId", "expectedVersionNumber",
      "expectedRevision", "committedResourceId", "committedVersionNumber", "committedRevision"
    ];
    if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) {
      throw new Error("Project Skill transaction journal has unsupported fields.");
    }
    const transactionId = requiredJournalString(record, "transactionId");
    if (record["format"] !== 1 || transactionId !== expectedTransactionId || !RESOURCE_GENERATION_PATTERN.test(transactionId)) {
      throw new Error("Project Skill transaction journal identity is malformed.");
    }
    const kind = record["kind"];
    if (kind !== "replace" && kind !== "remove") throw new Error("Project Skill transaction kind is malformed.");
    const backendId = requiredJournalString(record, "backendId");
    const targetId = requiredJournalString(record, "targetId");
    const workspaceRoot = normalizedAbsolute(requiredJournalString(record, "workspaceRoot"), "Project Skill transaction workspace");
    const sourcePath = normalizedAbsolute(requiredJournalString(record, "sourcePath"), "Project Skill transaction source");
    const destinationPath = normalizedAbsolute(requiredJournalString(record, "destinationPath"), "Project Skill transaction destination");
    const expectedResourceId = requiredJournalString(record, "expectedResourceId");
    const committedResourceId = requiredJournalString(record, "committedResourceId");
    validateResourceId(expectedResourceId);
    validateResourceId(committedResourceId);
    const expectedVersionNumber = journalVersion(record, "expectedVersionNumber");
    const committedVersionNumber = journalVersion(record, "committedVersionNumber");
    const expectedRevision = normalizedContentRevision(requiredJournalString(record, "expectedRevision"), "Project Skill transaction source revision");
    const committedRevision = normalizedContentRevision(requiredJournalString(record, "committedRevision"), "Project Skill transaction committed revision");
    const authority = this.#records.get(expectedResourceId);
    if (
      authority === undefined || !isDirectProjectResource(authority) || authority.kind !== "skill"
      || authority.backendId !== backendId || authority.targetId !== targetId
      || authority.workspaceRoot === undefined || !samePath(authority.workspaceRoot, workspaceRoot)
      || !samePath(authority.canonicalPath, sourcePath)
    ) throw new Error("Project Skill transaction journal does not match durable Resource authority.");
    assertWithin(workspaceRoot, sourcePath, "Project Skill transaction source");
    assertWithin(workspaceRoot, destinationPath, "Project Skill transaction destination");
    if (!samePath(dirname(sourcePath), dirname(destinationPath))) {
      throw new Error("Project Skill transaction destination must remain beside its source.");
    }
    validateEntryName(basename(sourcePath));
    validateEntryName(basename(destinationPath));
    if (kind === "remove") {
      if (
        !samePath(sourcePath, destinationPath) || committedResourceId !== expectedResourceId
        || BigInt(committedVersionNumber) !== BigInt(expectedVersionNumber) + 1n
        || committedRevision !== expectedRevision
      ) throw new Error("Project Skill removal transaction journal is inconsistent.");
    } else if (committedResourceId === expectedResourceId) {
      if (!samePath(sourcePath, destinationPath) || BigInt(committedVersionNumber) !== BigInt(expectedVersionNumber) + 1n) {
        throw new Error("Project Skill replacement transaction journal is inconsistent.");
      }
    } else {
      if (
        samePath(sourcePath, destinationPath) || committedVersionNumber !== "1"
        || committedResourceId !== stableDiscoveredResourceId(backendId, targetId, "skill", destinationPath)
      ) throw new Error("Project Skill rename transaction journal is inconsistent.");
      portableSkillName(basename(destinationPath));
    }
    return {
      format: 1,
      kind,
      transactionId,
      backendId,
      targetId,
      workspaceRoot,
      sourcePath,
      destinationPath,
      expectedResourceId,
      expectedVersionNumber,
      expectedRevision,
      committedResourceId,
      committedVersionNumber,
      committedRevision
    };
  }

  async #recoverProjectSkillTransaction(journalPath: string, raw: ProjectSkillTransactionJournal): Promise<void> {
    const journalsRoot = join(this.#managedRoot, PROJECT_SKILL_TRANSACTION_JOURNALS_DIRECTORY);
    const expectedJournalPath = join(journalsRoot, `${raw.transactionId}.json`);
    if (!samePath(journalPath, expectedJournalPath)) throw new Error("Project Skill transaction journal path is invalid.");
    const journal = this.#validateProjectSkillTransactionJournal(raw, raw.transactionId);
    const expected = this.#records.get(journal.expectedResourceId)!;
    const expectedCurrent = expected.versionNumber === journal.expectedVersionNumber
      && isDirectProjectResource(expected)
      && samePath(expected.canonicalPath, journal.sourcePath);
    const committed = this.#records.get(journal.committedResourceId);
    const committedCurrent = committed !== undefined
      && isDirectProjectResource(committed)
      && committed.kind === "skill"
      && committed.backendId === journal.backendId
      && committed.targetId === journal.targetId
      && samePath(committed.canonicalPath, journal.destinationPath)
      && BigInt(committed.versionNumber) >= BigInt(journal.committedVersionNumber)
      && (journal.kind !== "remove" || committed.state === "removed");
    if (expectedCurrent === committedCurrent) {
      throw new Error("Project Skill transaction cannot be matched to exactly one durable catalog state.");
    }
    const transactionRoot = join(dirname(journal.sourcePath), PROJECT_SKILL_TRANSACTION_DIRECTORY);
    const transactionRootInfo = await optionalLstat(transactionRoot);
    if (transactionRootInfo !== undefined) {
      if (!transactionRootInfo.isDirectory() || transactionRootInfo.isSymbolicLink()) {
        throw new Error("Project Skill transaction directory is not a regular directory.");
      }
      await assertContainedRegularDirectory(journal.workspaceRoot, transactionRoot, "Project Skill transaction directory");
    }
    if (committedCurrent) await this.#finalizeProjectSkillTransaction(transactionRoot, journal);
    else await this.#rollbackProjectSkillTransaction(transactionRoot, journal);
    await removeOwnedPath(journalsRoot, journalPath, "Completed project Skill transaction journal");
    if (await directoryIsEmpty(transactionRoot)) await rm(transactionRoot, { recursive: true, force: true });
  }

  async #finalizeProjectSkillTransaction(transactionRoot: string, journal: ProjectSkillTransactionJournal): Promise<void> {
    if (await optionalLstat(transactionRoot) === undefined) return;
    if (journal.kind === "replace") {
      await removeOwnedPath(transactionRoot, join(transactionRoot, `${journal.transactionId}.stage`), "Project Skill transaction stage");
      await removeOwnedPath(transactionRoot, join(transactionRoot, `${journal.transactionId}.backup`), "Project Skill transaction backup");
    } else {
      await removeOwnedPath(transactionRoot, join(transactionRoot, `${journal.transactionId}.deleted`), "Project Skill removal tombstone");
    }
  }

  async #rollbackProjectSkillTransaction(transactionRoot: string, journal: ProjectSkillTransactionJournal): Promise<void> {
    if (journal.kind === "remove") {
      const tombstone = join(transactionRoot, `${journal.transactionId}.deleted`);
      if (await optionalLstat(tombstone) !== undefined) {
        const tombstoneInspection = await inspectSkillPackage(tombstone, this.#maximumFiles, this.#maximumBytes);
        if (tombstoneInspection.revision !== journal.expectedRevision) throw new Error("Project Skill removal tombstone changed before rollback.");
        if (await optionalLstat(journal.sourcePath) === undefined) {
          await rename(tombstone, journal.sourcePath);
        } else {
          const sourceInspection = await inspectSkillPackage(journal.sourcePath, this.#maximumFiles, this.#maximumBytes);
          if (sourceInspection.revision !== journal.expectedRevision) throw new Error("Project Skill removal rollback target is occupied.");
          await removeOwnedPath(transactionRoot, tombstone, "Project Skill removal duplicate tombstone");
        }
      } else if (await optionalLstat(journal.sourcePath) === undefined) {
        throw new Error("Project Skill removal rollback content is missing.");
      }
      return;
    }

    const stage = join(transactionRoot, `${journal.transactionId}.stage`);
    const backup = join(transactionRoot, `${journal.transactionId}.backup`);
    const backupInfo = await optionalLstat(backup);
    if (backupInfo !== undefined) {
      const backupInspection = await inspectSkillPackage(backup, this.#maximumFiles, this.#maximumBytes);
      if (backupInspection.revision !== journal.expectedRevision) throw new Error("Project Skill transaction backup changed before rollback.");
      if (samePath(journal.sourcePath, journal.destinationPath)) {
        const sourceInfo = await optionalLstat(journal.sourcePath);
        if (sourceInfo === undefined) {
          await rename(backup, journal.sourcePath);
        } else {
          const sourceInspection = await inspectSkillPackage(journal.sourcePath, this.#maximumFiles, this.#maximumBytes);
          if (sourceInspection.revision === journal.committedRevision && journal.committedRevision !== journal.expectedRevision) {
            await removeOwnedPath(transactionRoot, stage, "Project Skill transaction stage");
            await rename(journal.sourcePath, stage);
            await rename(backup, journal.sourcePath);
          } else if (sourceInspection.revision === journal.expectedRevision) {
            await removeOwnedPath(transactionRoot, backup, "Project Skill duplicate transaction backup");
          } else {
            throw new Error("Project Skill transaction rollback target changed unexpectedly.");
          }
        }
      } else {
        const destinationInfo = await optionalLstat(journal.destinationPath);
        if (destinationInfo !== undefined) {
          const destinationInspection = await inspectSkillPackage(journal.destinationPath, this.#maximumFiles, this.#maximumBytes);
          if (destinationInspection.revision !== journal.committedRevision) {
            throw new Error("Renamed project Skill changed before rollback.");
          }
          await removeOwnedPath(transactionRoot, stage, "Project Skill transaction stage");
          await rename(journal.destinationPath, stage);
        }
        const sourceInfo = await optionalLstat(journal.sourcePath);
        if (sourceInfo === undefined) {
          await rename(backup, journal.sourcePath);
        } else {
          const sourceInspection = await inspectSkillPackage(journal.sourcePath, this.#maximumFiles, this.#maximumBytes);
          if (sourceInspection.revision !== journal.expectedRevision) throw new Error("Project Skill rename rollback target is occupied.");
          await removeOwnedPath(transactionRoot, backup, "Project Skill duplicate transaction backup");
        }
      }
    } else {
      if (await optionalLstat(journal.sourcePath) === undefined) {
        throw new Error("Project Skill transaction rollback content is missing.");
      }
      if (!samePath(journal.sourcePath, journal.destinationPath) && await optionalLstat(journal.destinationPath) !== undefined) {
        throw new Error("Project Skill rename rollback backup is missing.");
      }
    }
    await removeOwnedPath(transactionRoot, stage, "Project Skill transaction stage");
  }

  async #writeProjectMarketSkillTransactionJournal(journal: ProjectMarketSkillTransactionJournal): Promise<string> {
    const validated = this.#validateProjectMarketSkillTransactionJournal(journal, journal.transactionId);
    const root = join(this.#managedRoot, PROJECT_MARKET_SKILL_TRANSACTION_JOURNALS_DIRECTORY);
    const destination = join(root, `${validated.transactionId}.json`);
    const temporary = join(root, `${validated.transactionId}.tmp`);
    if (await optionalLstat(destination) !== undefined || await optionalLstat(temporary) !== undefined) {
      throw new Error("Project market Skill transaction journal already exists.");
    }
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(validated)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      await rename(temporary, destination);
      return destination;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #recoverProjectMarketSkillTransactions(): Promise<void> {
    const root = join(this.#managedRoot, PROJECT_MARKET_SKILL_TRANSACTION_JOURNALS_DIRECTORY);
    const entries = await readdir(root, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      validateEntryName(entry.name);
      const path = join(root, entry.name);
      if (PROJECT_MARKET_SKILL_TRANSACTION_TEMP_PATTERN.test(entry.name)) {
        await removeOwnedPath(root, path, "Incomplete project market Skill transaction journal");
        continue;
      }
      const match = PROJECT_MARKET_SKILL_TRANSACTION_JOURNAL_PATTERN.exec(entry.name);
      if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("Project market Skill transaction journal directory contains an unsupported current-v1 entry.");
      }
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > MAXIMUM_PROJECT_SKILL_TRANSACTION_JOURNAL_BYTES) {
        throw new Error("Project market Skill transaction journal is malformed.");
      }
      await assertContainedPath(root, path, "Project market Skill transaction journal");
      let parsed: unknown;
      try { parsed = JSON.parse(await readFile(path, "utf8")); } catch {
        throw new Error("Project market Skill transaction journal is not valid JSON.");
      }
      await this.#recoverProjectMarketSkillTransaction(path, this.#validateProjectMarketSkillTransactionJournal(parsed, match[1]!));
    }
  }

  #validateProjectMarketSkillTransactionJournal(value: unknown, expectedTransactionId: string): ProjectMarketSkillTransactionJournal {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Project market Skill transaction journal is malformed.");
    }
    const record = value as Record<string, unknown>;
    const keys = [
      "format", "kind", "transactionId", "backendId", "targetId", "workspaceRoot", "destinationPath", "resourceId",
      "expectedResourceVersion", "expectedResourceRevision", "expectedDestinationRevision", "committedResourceVersion",
      "committedRevision", "sourceId", "entryId", "entryContentRevision"
    ];
    if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) {
      throw new Error("Project market Skill transaction journal has unsupported fields.");
    }
    const transactionId = requiredJournalString(record, "transactionId");
    if (record["format"] !== 1 || record["kind"] !== "market_install" || transactionId !== expectedTransactionId
      || !RESOURCE_GENERATION_PATTERN.test(transactionId)) throw new Error("Project market Skill transaction identity is malformed.");
    const backendId = requiredJournalString(record, "backendId");
    const targetId = requiredJournalString(record, "targetId");
    const workspaceRoot = normalizedAbsolute(requiredJournalString(record, "workspaceRoot"), "Project market Skill workspace");
    const destinationPath = normalizedAbsolute(requiredJournalString(record, "destinationPath"), "Project market Skill destination");
    assertWithin(workspaceRoot, destinationPath, "Project market Skill destination");
    validateEntryName(basename(destinationPath));
    portableSkillName(basename(destinationPath));
    const resourceId = requiredJournalString(record, "resourceId");
    validateResourceId(resourceId);
    if (resourceId !== stableDiscoveredResourceId(backendId, targetId, "skill", destinationPath)) {
      throw new Error("Project market Skill transaction Resource identity is malformed.");
    }
    const expectedResourceVersion = nullableJournalVersion(record, "expectedResourceVersion");
    const expectedResourceRevision = nullableJournalRevision(record, "expectedResourceRevision");
    if ((expectedResourceVersion === null) !== (expectedResourceRevision === null)) {
      throw new Error("Project market Skill expected Resource authority is incomplete.");
    }
    const expectedDestinationRevision = nullableJournalRevision(record, "expectedDestinationRevision");
    const committedResourceVersion = journalVersion(record, "committedResourceVersion");
    if (BigInt(committedResourceVersion) !== (expectedResourceVersion === null ? 1n : BigInt(expectedResourceVersion) + 1n)) {
      throw new Error("Project market Skill committed Resource revision is malformed.");
    }
    const committedRevision = normalizedContentRevision(requiredJournalString(record, "committedRevision"), "Project market Skill committed revision");
    const sourceId = normalizedMarketSourceId(requiredJournalString(record, "sourceId"));
    const entryId = normalizedMarketEntryId(requiredJournalString(record, "entryId"));
    const entryContentRevision = normalizedContentRevision(requiredJournalString(record, "entryContentRevision"), "Project market Skill entry revision");
    return {
      format: 1,
      kind: "market_install",
      transactionId,
      backendId,
      targetId,
      workspaceRoot,
      destinationPath,
      resourceId,
      expectedResourceVersion,
      expectedResourceRevision,
      expectedDestinationRevision,
      committedResourceVersion,
      committedRevision,
      sourceId,
      entryId,
      entryContentRevision
    };
  }

  async #recoverProjectMarketSkillTransaction(journalPath: string, raw: ProjectMarketSkillTransactionJournal): Promise<void> {
    const journalsRoot = join(this.#managedRoot, PROJECT_MARKET_SKILL_TRANSACTION_JOURNALS_DIRECTORY);
    const expectedPath = join(journalsRoot, `${raw.transactionId}.json`);
    if (!samePath(journalPath, expectedPath)) throw new Error("Project market Skill transaction journal path is invalid.");
    const journal = this.#validateProjectMarketSkillTransactionJournal(raw, raw.transactionId);
    const resource = this.#records.get(journal.resourceId);
    const expectedCurrent = journal.expectedResourceVersion === null
      ? resource === undefined
      : resource !== undefined
        && resource.versionNumber === journal.expectedResourceVersion
        && resource.discoveredRevision === journal.expectedResourceRevision;
    const committedCurrent = resource !== undefined
      && resource.kind === "skill"
      && resource.scope === "project"
      && resource.backendId === journal.backendId
      && resource.targetId === journal.targetId
      && resource.versionNumber === journal.committedResourceVersion
      && resource.discoveredRevision === journal.committedRevision
      && isDirectProjectResource(resource)
      && samePath(resource.canonicalPath, journal.destinationPath)
      && resource.source.kind === "skill_market"
      && resource.source.sourceId === journal.sourceId
      && resource.source.entryId === journal.entryId
      && resource.source.entryContentRevision === journal.entryContentRevision;
    if (expectedCurrent === committedCurrent) {
      throw new Error("Project market Skill transaction cannot be matched to exactly one durable catalog state.");
    }
    const transactionRoot = join(dirname(journal.destinationPath), PROJECT_SKILL_TRANSACTION_DIRECTORY);
    const transactionInfo = await optionalLstat(transactionRoot);
    if (transactionInfo !== undefined) {
      if (!transactionInfo.isDirectory() || transactionInfo.isSymbolicLink()) throw new Error("Project market Skill transaction directory is unsafe.");
      await assertContainedRegularDirectory(journal.workspaceRoot, transactionRoot, "Project market Skill transaction directory");
    }
    if (committedCurrent) await this.#finalizeProjectMarketSkillTransaction(transactionRoot, journal);
    else await this.#rollbackProjectMarketSkillTransaction(transactionRoot, journal);
    await removeOwnedPath(journalsRoot, journalPath, "Completed project market Skill transaction journal");
    if (await directoryIsEmpty(transactionRoot)) await rm(transactionRoot, { recursive: true, force: true });
  }

  async #finalizeProjectMarketSkillTransaction(
    transactionRoot: string,
    journal: ProjectMarketSkillTransactionJournal
  ): Promise<void> {
    const destination = await inspectSkillPackage(journal.destinationPath, this.#maximumFiles, this.#maximumBytes);
    if (destination.revision !== journal.committedRevision) throw new Error("Committed project market Skill changed before recovery finalized.");
    if (await optionalLstat(transactionRoot) === undefined) return;
    await removeOwnedPath(transactionRoot, join(transactionRoot, `${journal.transactionId}.stage`), "Project market Skill transaction stage");
    await removeOwnedPath(transactionRoot, join(transactionRoot, `${journal.transactionId}.backup`), "Project market Skill transaction backup");
  }

  async #rollbackProjectMarketSkillTransaction(
    transactionRoot: string,
    journal: ProjectMarketSkillTransactionJournal
  ): Promise<void> {
    const stage = join(transactionRoot, `${journal.transactionId}.stage`);
    const backup = join(transactionRoot, `${journal.transactionId}.backup`);
    const destinationInfo = await optionalLstat(journal.destinationPath);
    const destinationRevision = destinationInfo === undefined
      ? undefined
      : (await inspectSkillPackage(journal.destinationPath, this.#maximumFiles, this.#maximumBytes)).revision;
    const backupInfo = await optionalLstat(backup);
    if (journal.expectedDestinationRevision === null) {
      if (backupInfo !== undefined) throw new Error("New project market Skill transaction unexpectedly has a backup.");
      if (destinationRevision !== undefined) {
        if (destinationRevision !== journal.committedRevision) throw new Error("New project market Skill destination changed before rollback.");
        await removeOwnedPath(transactionRoot, stage, "Project market Skill rollback stage");
        await rename(journal.destinationPath, stage);
      }
    } else {
      if (backupInfo !== undefined) {
        const backupRevision = (await inspectSkillPackage(backup, this.#maximumFiles, this.#maximumBytes)).revision;
        if (backupRevision !== journal.expectedDestinationRevision) throw new Error("Project market Skill backup changed before rollback.");
        if (destinationRevision === undefined) {
          await rename(backup, journal.destinationPath);
        } else if (destinationRevision === journal.committedRevision) {
          await removeOwnedPath(transactionRoot, stage, "Project market Skill rollback stage");
          await rename(journal.destinationPath, stage);
          await rename(backup, journal.destinationPath);
        } else if (destinationRevision === journal.expectedDestinationRevision) {
          await removeOwnedPath(transactionRoot, backup, "Project market Skill duplicate backup");
        } else {
          throw new Error("Project market Skill destination changed before rollback.");
        }
      } else if (destinationRevision !== journal.expectedDestinationRevision) {
        throw new Error("Project market Skill rollback backup is missing.");
      }
    }
    await removeOwnedPath(transactionRoot, stage, "Project market Skill transaction stage");
  }

  async #recoverOrphanedFilesystemState(): Promise<boolean> {
    await this.#clearWorkingDirectory(join(this.#managedRoot, ".staging"));
    let changed = false;
    for (const [id, stored] of this.#records) {
      let record = stored;
      if (record.installedPath !== undefined) {
        assertExpectedInstalledLocation(this.#managedRoot, record);
        if (!await assertContainedPathIfPresent(this.#managedRoot, record.installedPath, "Stored installed resource")) {
          record = this.#fenceMissingInstalledPayload(record);
          if (record !== stored) {
            this.#records.set(id, record);
            changed = true;
          }
        }
      }
      await this.#recoverResourceOwner(record);
    }
    return changed;
  }

  #fenceMissingInstalledPayload(record: StoredResource): StoredResource {
    if (record.state === "error" && !record.enabled && record.error === MISSING_INSTALLED_RESOURCE_ERROR) return record;
    return {
      ...record,
      state: "error",
      enabled: false,
      error: MISSING_INSTALLED_RESOURCE_ERROR,
      versionNumber: (BigInt(record.versionNumber) + 1n).toString(10),
      updatedAt: this.#now()
    };
  }

  async #clearWorkingDirectory(directory: string): Promise<void> {
    await assertContainedRegularDirectory(this.#managedRoot, directory, "Managed resource working directory");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      validateEntryName(entry.name);
      await removeOwnedPath(this.#managedRoot, join(directory, entry.name), "Managed resource working entry");
    }
  }

  async #recoverResourceOwner(record: StoredResource): Promise<void> {
    const owner = resourceOwnerPath(this.#managedRoot, record);
    const ownerInfo = await optionalLstat(owner);
    if (ownerInfo === undefined) return;
    if (!ownerInfo.isDirectory() || ownerInfo.isSymbolicLink()) {
      throw new Error("Managed resource owner must be a regular directory.");
    }
    await assertContainedRegularDirectory(this.#managedRoot, owner, "Managed resource owner directory");
    const referencedGeneration = record.installedPath === undefined
      ? undefined
      : installedGenerationContainer(this.#managedRoot, record);
    for (const entry of await readdir(owner, { withFileTypes: true })) {
      validateEntryName(entry.name);
      const path = join(owner, entry.name);
      if (entry.name === RESOURCE_GENERATIONS_DIRECTORY) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new Error("Managed resource generations must be a regular directory.");
        }
        await assertContainedRegularDirectory(this.#managedRoot, path, "Managed resource generations directory");
        for (const generationEntry of await readdir(path, { withFileTypes: true })) {
          validateEntryName(generationEntry.name);
          if (!RESOURCE_GENERATION_PATTERN.test(generationEntry.name) || !generationEntry.isDirectory() || generationEntry.isSymbolicLink()) {
            throw new Error("Managed resource generation entry is malformed.");
          }
          const generationPath = join(path, generationEntry.name);
          if (referencedGeneration === undefined || !samePath(generationPath, referencedGeneration)) {
            await removeOwnedPath(this.#managedRoot, generationPath, "Orphaned resource generation");
          }
        }
      } else {
        throw new Error("Managed resource owner contains an unsupported current-v1 entry.");
      }
    }
    await this.#pruneResourceOwner(record);
  }

  async #removeCandidateGeneration(record: StoredResource, candidateContainer: string): Promise<void> {
    const generations = join(resourceOwnerPath(this.#managedRoot, record), RESOURCE_GENERATIONS_DIRECTORY);
    if (
      !samePath(dirname(candidateContainer), generations)
      || !RESOURCE_GENERATION_PATTERN.test(basename(candidateContainer))
    ) throw new Error("Prepared resource candidate does not match its managed ownership boundary.");
    await removeOwnedPath(this.#managedRoot, candidateContainer, "Prepared resource candidate");
    await this.#pruneResourceOwner(record);
  }

  async #removeInstalledIncarnation(record: StoredResource): Promise<void> {
    assertExpectedInstalledLocation(this.#managedRoot, record);
    const generation = installedGenerationContainer(this.#managedRoot, record);
    const generationKey = pathIdentity(generation);
    if ((this.#installedGenerationLeases.get(generationKey) ?? 0) > 0) {
      this.#retiredInstalledGenerations.set(generationKey, { record, generation });
      return;
    }
    await removeOwnedPath(
      this.#managedRoot,
      generation,
      "Retired installed resource"
    );
    await this.#pruneResourceOwner(record);
  }

  async #removeResourceOwner(record: StoredResource): Promise<void> {
    if (record.installedPath !== undefined) {
      await this.#removeInstalledIncarnation(record);
      return;
    }
    await this.#pruneResourceOwner(record);
  }

  async #releaseInstalledPackageGeneration(generationKey: string): Promise<void> {
    await this.#mutate(async () => {
      const count = this.#installedGenerationLeases.get(generationKey);
      if (count === undefined || count < 1) throw new Error("Installed package lease accounting is inconsistent.");
      if (count > 1) {
        this.#installedGenerationLeases.set(generationKey, count - 1);
        return;
      }
      const retired = this.#retiredInstalledGenerations.get(generationKey);
      if (retired !== undefined) {
        await removeOwnedPath(this.#managedRoot, retired.generation, "Retired leased resource generation");
        await this.#pruneResourceOwner(retired.record);
        this.#retiredInstalledGenerations.delete(generationKey);
      }
      this.#installedGenerationLeases.delete(generationKey);
    });
  }

  async #assertInstalledPackageLeaseCurrent(record: StoredResource, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.#mutate(async () => {
      signal?.throwIfAborted();
      const current = this.#require(record.id);
      if (current !== record) throw new Error("Installed package Resource changed while it was being exported.");
      await this.#assertInstalledSafe(current);
      signal?.throwIfAborted();
    });
  }

  #assertInstalledPackageLeaseAuthority(
    record: StoredResource,
    input: Omit<PiInstalledPackageLeaseInput, "resourceId">
  ): void {
    if (
      record.backendId !== input.backendId
      || record.versionNumber !== input.expectedResourceVersion.toString(10)
      || record.discoveredRevision !== input.expectedDiscoveredRevision
      || record.kind !== "package"
      || record.scope !== "managed"
      || record.installedPath === undefined
      || record.packageIdentity !== input.expectedPackageIdentity
      || record.version !== input.expectedPackageVersion
      || record.state === "removed"
      || record.state === "error"
    ) {
      throw new Error("Installed package Resource no longer matches the confirmed export authority.");
    }
  }

  async #pruneResourceOwner(record: StoredResource): Promise<void> {
    const owner = resourceOwnerPath(this.#managedRoot, record);
    const generations = join(owner, RESOURCE_GENERATIONS_DIRECTORY);
    if (await directoryIsEmpty(generations)) {
      await removeOwnedPath(this.#managedRoot, generations, "Empty resource generations directory");
    }
    if (await directoryIsEmpty(owner)) {
      await removeOwnedPath(this.#managedRoot, owner, "Empty resource owner directory");
    }
  }

  async #inspectExtensionSourcePackage(
    input: PiExtensionSourcePackageInput
  ): Promise<InspectedExtensionPackage> {
    validateResourceId(input.resourceId);
    normalizedExtensionSourceId(input.sourceId);
    normalizedDecimalRevision(input.sourceRevision, "Extension source revision");
    nonBlank(input.sourceIdentity, "Extension source identity");
    nonBlank(input.sourceDisplay, "Extension source display");
    normalizeExtensionPackagePath(input.packageRelativePath);
    const expectedRevision = normalizedContentRevision(
      input.packageContentRevision,
      "Extension source package revision"
    );
    if (!Number.isSafeInteger(input.bindingOrdinal) || input.bindingOrdinal < 0) {
      throw new Error("Extension source binding ordinal is invalid.");
    }
    nonBlank(input.bindingName, "Extension source binding name");
    const backendId = nonBlank(input.backendId, "Backend ID");
    const inspection = await inspectResource(input.packageRoot, this.#maximumFiles, this.#maximumBytes);
    const rootInfo = await lstat(inspection.canonicalPath);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error("Extension source package must be a regular directory.");
    }
    if (inspection.revision !== expectedRevision) {
      throw new Error("Extension source package changed after discovery.");
    }
    const runtimeVersion = this.#runtimeVersion(backendId);
    const compatibility = await inspectPiResourceCompatibility("package", inspection.canonicalPath, {
      ...(runtimeVersion === undefined ? {} : { currentRuntimeVersion: runtimeVersion }),
      contentFingerprint: inspection.revision
    });
    assertExtensionPackageSelection(input, compatibility);
    return { inspection, compatibility };
  }

  #planExtensionPackage(
    input: PiExtensionSourcePackageInput,
    inspected: InspectedExtensionPackage
  ): ExtensionPackagePlan {
    const target = this.#records.get(input.resourceId);
    if (target !== undefined && target.state !== "removed" && target.installedPath === undefined) {
      throw new Error("The reserved Resource identity is already used by an uninstalled Resource intent.");
    }
    if (target?.installedPath !== undefined) {
      if (target.kind !== "package" || target.packageIdentity !== inspected.compatibility.name) {
        throw new Error("The reserved Resource identity is already bound to another package.");
      }
      if (target.backendId !== input.backendId) {
        throw new Error("Choose the Backend that owns the currently installed package.");
      }
    }
    const conflicts = [...this.#records.values()].filter((record) =>
      record.id !== input.resourceId
      && record.kind === "package"
      && record.installedPath !== undefined
      && record.state !== "removed"
      && record.packageIdentity === inspected.compatibility.name
    );
    if (conflicts.length > 1) {
      throw new Error("Multiple installed Resources claim the same package identity; remove the ambiguity before replacing it.");
    }
    const current = target?.installedPath === undefined ? conflicts[0] : target;
    if (current !== undefined && current.backendId !== input.backendId) {
      throw new Error("Choose the Backend that owns the currently installed package.");
    }
    if (
      current?.id === input.resourceId
      && current.source.kind === "extension_source"
      && current.source.sourceId === input.sourceId
      && current.source.packageRelativePath === normalizeExtensionPackagePath(input.packageRelativePath)
      && current.discoveredRevision === inspected.inspection.revision
    ) {
      throw new Error("The selected Extension package is already installed at this revision.");
    }
    const sameSource = current?.source.kind === "extension_source"
      && current.source.sourceId === input.sourceId
      && current.source.packageRelativePath === normalizeExtensionPackagePath(input.packageRelativePath);
    return {
      action: current === undefined ? "install" : sameSource && current.id === input.resourceId ? "update" : "replace",
      resourceId: input.resourceId,
      backendId: input.backendId,
      ...(target === undefined ? {} : { target }),
      ...(current === undefined ? {} : { current }),
      sourceReplacement: current !== undefined && !sameSource
    };
  }

  async #prepareInstalledMutation(
    expected: StoredResource,
    approved: StoredResource
  ): Promise<PreparedPiResourceMutation<PiResourceDescriptor>> {
    if (isDirectProjectResource(approved)) throw new Error("Project-local resources are snapshotted by the Pi adapter and are not installed globally.");
    if (approved.state !== "approved") throw new Error("Resource must be approved before installation.");
    if (approved.approvedAt === undefined || approved.approvedByConnectionId === undefined) {
      throw new Error("Resource installation requires an explicit owner approval.");
    }
    if (approved.source.kind === "extension_source" || approved.source.kind === "skill_market") {
      throw new Error("Source-owned resources require their leased Resource adoption path.");
    }
    this.#assertStoredProjectTargetTrusted(approved);
    if (approved.source.kind === "local") await this.#assertSourceUnchanged(approved);
    else if (approved.kind !== "package" || approved.discoveredRevision !== piPackageSourceApprovalRevision(approved.source)) {
      throw new Error("Package acquisition approval is stale.");
    }
    if (expected.installedPath !== undefined) {
      assertExpectedInstalledLocation(this.#managedRoot, expected);
      await assertContainedPath(this.#managedRoot, expected.installedPath, "Existing installed resource");
    }
    const owner = resourceOwnerPath(this.#managedRoot, approved);
    await mkdir(owner, { recursive: true, mode: 0o700 });
    await assertContainedRegularDirectory(this.#managedRoot, owner, "Managed resource owner directory");
    const generations = join(owner, RESOURCE_GENERATIONS_DIRECTORY);
    await mkdir(generations, { recursive: true, mode: 0o700 });
    await assertContainedRegularDirectory(this.#managedRoot, generations, "Managed resource generations directory");
    const generation = randomUUID();
    const candidateContainer = join(generations, generation);
    const stage = join(this.#managedRoot, ".staging", `resource-${generation}`);
    await mkdir(stage, { recursive: false, mode: 0o700 });
    const acquisitionRoot = join(stage, ".acquisition");
    let acquiredVersion: string | undefined;
    let candidatePublished = false;
    try {
      let sourceRoot: string;
      let sourceInspection: ResourceInspection;
      if (approved.source.kind === "local") {
        if (approved.canonicalPath === undefined) throw new Error("Local resource is missing its canonical source path.");
        sourceRoot = approved.canonicalPath;
        sourceInspection = await inspectResourceForKind(approved.kind, sourceRoot, this.#maximumFiles, this.#maximumBytes);
      } else {
        const acquired = await this.#acquisition.acquire({
          source: approved.source,
          destinationRoot: acquisitionRoot,
          action: expected.installedPath === undefined ? "install" : "update"
        });
        sourceRoot = normalizedAbsolute(acquired.rootPath, "Acquired package root");
        assertWithin(acquisitionRoot, sourceRoot, "Acquired package root");
        sourceInspection = await inspectResource(sourceRoot, this.#maximumFiles, this.#maximumBytes);
        acquiredVersion = acquired.version === undefined ? undefined : boundedVersion(acquired.version);
      }
      const sourceInfo = await lstat(sourceRoot);
      if (approved.kind === "package" && !sourceInfo.isDirectory()) throw new Error("Package acquisition must produce a regular directory.");
      const payloadName = safePayloadName(approved.source.kind === "local" ? basename(sourceRoot) : approved.name);
      const stagedPayload = join(stage, payloadName);
      if (sourceInfo.isDirectory()) {
        await mkdir(stagedPayload, { recursive: false, mode: 0o700 });
        await copyTreeFailClosed(sourceRoot, sourceRoot, stagedPayload, { files: 0, bytes: 0, maxFiles: this.#maximumFiles, maxBytes: this.#maximumBytes });
      } else if (sourceInfo.isFile() && !sourceInfo.isSymbolicLink()) {
        await copyFile(sourceRoot, stagedPayload, constants.COPYFILE_EXCL);
      } else {
        throw new Error("Approved resource source is no longer a regular file or directory.");
      }
      const stagedInspection = await inspectResourceForKind(approved.kind, stagedPayload, this.#maximumFiles, this.#maximumBytes);
      if (stagedInspection.revision !== sourceInspection.revision) throw new Error("Resource changed during staged installation.");
      if (approved.source.kind === "local") await this.#assertSourceUnchanged(approved);
      else await rm(acquisitionRoot, { recursive: true, force: true });
      await rename(stage, candidateContainer);
      candidatePublished = true;
      const installedPath = join(candidateContainer, payloadName);
      await assertContainedPath(this.#managedRoot, installedPath, "Installed resource candidate");
      const installedInspection = await inspectResourceForKind(approved.kind, installedPath, this.#maximumFiles, this.#maximumBytes);
      const installedRuntimeVersion = this.#runtimeVersion(approved.backendId);
      const compatibility = await inspectPiResourceCompatibility(approved.kind, installedPath, {
        ...(installedRuntimeVersion === undefined ? {} : { currentRuntimeVersion: installedRuntimeVersion }),
        contentFingerprint: installedInspection.revision
      });
      const extensionApprovedRevision = compatibility.extensionContentFingerprint !== undefined
        && approved.extensionApprovedRevision === compatibility.extensionContentFingerprint
        ? approved.extensionApprovedRevision
        : undefined;
      const requiresExtensionApproval = compatibility.extensionContentFingerprint !== undefined
        && extensionApprovedRevision === undefined;
      const { extensionApprovedRevision: _previousExtensionApproval, ...approvedBase } = approved;
      const preservesEnabledState = expected.installedPath !== undefined
        && expected.enabled
        && compatibility.canToggle
        && !requiresExtensionApproval;
      const preservesExplicitDisable = expected.installedPath !== undefined && expected.state === "disabled";
      const updated: StoredResource = {
        ...approvedBase,
        installedPath,
        discoveredRevision: installedInspection.revision,
        ...(approved.kind === "package" ? { packageIdentity: compatibility.name } : {}),
        ...compatibilityFields(compatibility, requiresExtensionApproval),
        ...(extensionApprovedRevision === undefined ? {} : { extensionApprovedRevision }),
        ...(acquiredVersion === undefined ? {} : { version: acquiredVersion }),
        state: preservesExplicitDisable ? "disabled" : "installed",
        enabled: preservesEnabledState,
        versionNumber: (BigInt(approved.versionNumber) + 1n).toString(10),
        updatedAt: this.#now()
      };
      assertExpectedInstalledLocation(this.#managedRoot, updated);
      return this.#prepareMutation(
        [{ id: approved.id, expected, next: updated }],
        publicResource(updated),
        approved.scope === "project" ? () => this.#assertStoredProjectTargetTrusted(approved) : undefined,
        {
          rollback: async () => {
            await this.#removeCandidateGeneration(approved, candidateContainer);
          },
          ...(expected.installedPath === undefined
            ? {}
            : { cleanupAfterCommit: () => this.#removeInstalledIncarnation(expected) })
        }
      );
    } catch (error) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      if (candidatePublished) await this.#removeCandidateGeneration(approved, candidateContainer).catch(() => undefined);
      else await this.#pruneResourceOwner(approved).catch(() => undefined);
      throw error;
    }
  }

  #assertSkillContentAuthority(record: StoredResource, expectedResourceVersion: bigint): void {
    if (record.kind !== "skill") throw new Error("Resource is not a Skill.");
    if (record.state === "removed") throw new Error("Removed Skill content is unavailable.");
    if (BigInt(record.versionNumber) !== expectedResourceVersion) throw new Error("Skill Resource revision is stale.");
    this.#assertStoredProjectTargetTrusted(record);
    if (isDirectProjectResource(record)) {
      if (!(record.state === "approved" || record.state === "disabled" || record.state === "loaded")) {
        throw new Error("Project Skill is not approved.");
      }
      return;
    }
    if (record.source.kind === "extension_source" || record.kind !== "skill") {
      throw new Error("Package-owned Skills must be changed through their package owner.");
    }
    if (record.installedPath === undefined || !(record.state === "installed" || record.state === "disabled" || record.state === "loaded")) {
      throw new Error("Global Skill is not installed.");
    }
  }

  async #skillContentRoot(record: StoredResource, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (isDirectProjectResource(record)) {
      const workspaceRoot = this.#assertTrustedProjectTarget(record.backendId, record.targetId, record.workspaceRoot);
      assertWithin(workspaceRoot, record.canonicalPath, "Project Skill content");
      await assertCanonicalDirectory(record.canonicalPath, "Project Skill content");
      return record.canonicalPath;
    }
    if (record.installedPath === undefined) throw new Error("Global Skill content is not installed.");
    assertExpectedInstalledLocation(this.#managedRoot, record);
    await assertContainedRegularDirectory(this.#managedRoot, record.installedPath, "Global Skill content");
    return record.installedPath;
  }

  async #prepareManagedSkillContentMutation(
    current: StoredResource,
    candidateRoot: string,
    candidateInspection: ResourceInspection,
    compatibility: PiPackageInspection,
    requestedName: string,
    changedByConnectionId: string
  ): Promise<PreparedPiResourceMutation<PiSkillContentMutationResult>> {
    if (current.installedPath === undefined) throw new Error("Global Skill content is not installed.");
    assertExpectedInstalledLocation(this.#managedRoot, current);
    const owner = resourceOwnerPath(this.#managedRoot, current);
    const generations = join(owner, RESOURCE_GENERATIONS_DIRECTORY);
    await assertContainedRegularDirectory(this.#managedRoot, generations, "Managed Skill generations directory");
    const generation = randomUUID();
    const candidateContainer = join(generations, generation);
    const stage = join(this.#managedRoot, ".staging", `skill-${generation}`);
    await mkdir(stage, { recursive: false, mode: 0o700 });
    const payloadName = installedPayloadName(current);
    const stagedPayload = join(stage, payloadName);
    let published = false;
    try {
      await mkdir(stagedPayload, { recursive: false, mode: 0o700 });
      await copyTreeFailClosed(candidateRoot, candidateRoot, stagedPayload, {
        files: 0,
        bytes: 0,
        maxFiles: this.#maximumFiles,
        maxBytes: this.#maximumBytes
      });
      await syncTreeForPublish(stagedPayload);
      const stagedInspection = await inspectSkillPackage(stagedPayload, this.#maximumFiles, this.#maximumBytes);
      if (stagedInspection.revision !== candidateInspection.revision) throw new Error("Skill candidate changed while it was staged.");
      await this.#assertInstalledSafe(current);
      await rename(stage, candidateContainer);
      published = true;
      const installedPath = join(candidateContainer, payloadName);
      const installedInspection = await inspectSkillPackage(installedPath, this.#maximumFiles, this.#maximumBytes);
      if (installedInspection.revision !== candidateInspection.revision) throw new Error("Published Skill generation differs from its draft.");
      const { pendingUpdate: _pendingUpdate, error: _error, ...base } = current;
      const updated: StoredResource = {
        ...base,
        name: requestedName,
        installedPath,
        discoveredRevision: installedInspection.revision,
        ...compatibilityFields(compatibility, false),
        state: current.state === "disabled" ? "disabled" : "installed",
        enabled: current.enabled,
        approvedAt: this.#now(),
        approvedByConnectionId: changedByConnectionId,
        versionNumber: (BigInt(current.versionNumber) + 1n).toString(10),
        updatedAt: this.#now()
      };
      assertExpectedInstalledLocation(this.#managedRoot, updated);
      const resource = publicResource(updated);
      return this.#prepareMutation(
        [{ id: current.id, expected: current, next: updated }],
        { resource },
        undefined,
        {
          rollback: () => this.#removeCandidateGeneration(current, candidateContainer),
          cleanupAfterCommit: () => this.#removeInstalledIncarnation(current)
        }
      );
    } catch (error) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      if (published) await this.#removeCandidateGeneration(current, candidateContainer).catch(() => undefined);
      throw error;
    }
  }

  async #prepareProjectSkillContentMutation(
    current: StoredResource & {
      readonly source: Extract<StoredResourceSource, { readonly kind: "local" | "skill_market" }>;
      readonly canonicalPath: string;
    },
    expectedObservedRevision: string,
    candidateRoot: string,
    candidateInspection: ResourceInspection,
    compatibility: PiPackageInspection,
    requestedName: string,
    changedByConnectionId: string
  ): Promise<PreparedPiResourceMutation<PiSkillContentMutationResult>> {
    const workspaceRoot = this.#assertTrustedProjectTarget(current.backendId, current.targetId, current.workspaceRoot);
    const targetId = current.targetId!;
    const currentInspection = await inspectSkillPackage(current.canonicalPath, this.#maximumFiles, this.#maximumBytes);
    if (!samePath(currentInspection.canonicalPath, current.canonicalPath) || currentInspection.revision !== expectedObservedRevision) {
      throw new Error("Observed Skill revision is stale.");
    }
    const parent = dirname(current.canonicalPath);
    assertWithin(workspaceRoot, parent, "Project Skill parent");
    await assertCanonicalDirectory(parent, "Project Skill parent");
    const renaming = requestedName !== basename(current.canonicalPath);
    const destination = renaming ? join(parent, requestedName) : current.canonicalPath;
    if (renaming && await optionalLstat(destination) !== undefined) throw new Error("A Skill with that name already exists in this scope.");
    const { pendingUpdate: _pendingUpdate, error: _error, ...base } = current;
    const nextState = current.state === "disabled" ? "disabled" : "approved";
    let entries: readonly PreparedCatalogEntry[];
    let result: PiSkillContentMutationResult;
    let committed: StoredResource;
    if (renaming) {
      const nextId = stableDiscoveredResourceId(current.backendId, targetId, "skill", destination);
      if (this.#records.has(nextId)) throw new Error("The renamed Skill Resource identity already exists.");
      const removed: StoredResource = {
        ...base,
        state: "removed",
        enabled: false,
        versionNumber: (BigInt(current.versionNumber) + 1n).toString(10),
        updatedAt: this.#now()
      };
      const next: StoredResource = {
        ...base,
        id: nextId,
        name: requestedName,
        source: { kind: "local", path: destination },
        sourceIdentity: `skill:${pathIdentity(destination)}`,
        sourceDisplay: requestedName,
        canonicalPath: destination,
        canonicalPathFingerprint: pathFingerprint(destination),
        discoveredRevision: candidateInspection.revision,
        ...compatibilityFields(compatibility, false),
        state: nextState,
        enabled: current.enabled,
        approvedAt: this.#now(),
        approvedByConnectionId: changedByConnectionId,
        versionNumber: "1",
        updatedAt: this.#now()
      };
      entries = [
        { id: current.id, expected: current, next: removed },
        { id: nextId, expected: undefined, next }
      ];
      committed = next;
      result = { resource: publicResource(next), replacedResourceId: current.id };
    } else {
      const updated: StoredResource = {
        ...base,
        name: requestedName,
        discoveredRevision: candidateInspection.revision,
        ...compatibilityFields(compatibility, false),
        state: nextState,
        enabled: current.enabled,
        approvedAt: this.#now(),
        approvedByConnectionId: changedByConnectionId,
        versionNumber: (BigInt(current.versionNumber) + 1n).toString(10),
        updatedAt: this.#now()
      };
      entries = [{ id: current.id, expected: current, next: updated }];
      committed = updated;
      result = { resource: publicResource(updated) };
    }

    const transactionRoot = join(parent, PROJECT_SKILL_TRANSACTION_DIRECTORY);
    await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
    await assertContainedRegularDirectory(workspaceRoot, transactionRoot, "Project Skill transaction directory");
    const transactionId = randomUUID();
    const stage = join(transactionRoot, `${transactionId}.stage`);
    const backup = join(transactionRoot, `${transactionId}.backup`);
    const journal: ProjectSkillTransactionJournal = {
      format: 1,
      kind: "replace",
      transactionId,
      backendId: current.backendId,
      targetId,
      workspaceRoot,
      sourcePath: current.canonicalPath,
      destinationPath: destination,
      expectedResourceId: current.id,
      expectedVersionNumber: current.versionNumber,
      expectedRevision: expectedObservedRevision,
      committedResourceId: committed.id,
      committedVersionNumber: committed.versionNumber,
      committedRevision: committed.discoveredRevision
    };
    let journalPath: string | undefined;
    try {
      journalPath = await this.#writeProjectSkillTransactionJournal(journal);
      await mkdir(stage, { recursive: false, mode: 0o700 });
      await copyTreeFailClosed(candidateRoot, candidateRoot, stage, {
        files: 0,
        bytes: 0,
        maxFiles: this.#maximumFiles,
        maxBytes: this.#maximumBytes
      });
      await syncTreeForPublish(stage);
      const stagedInspection = await inspectSkillPackage(stage, this.#maximumFiles, this.#maximumBytes);
      if (stagedInspection.revision !== candidateInspection.revision) throw new Error("Skill candidate changed while it was staged.");
      const beforeSwitch = await inspectSkillPackage(current.canonicalPath, this.#maximumFiles, this.#maximumBytes);
      this.#assertTrustedProjectTarget(current.backendId, current.targetId, workspaceRoot);
      if (!samePath(beforeSwitch.canonicalPath, current.canonicalPath) || beforeSwitch.revision !== expectedObservedRevision) {
        throw new Error("Project Skill changed before its staged content could be published.");
      }
      await rename(current.canonicalPath, backup);
      try {
        await rename(stage, destination);
      } catch (error) {
        await rename(backup, current.canonicalPath);
        throw error;
      }
      const publishedInspection = await inspectSkillPackage(destination, this.#maximumFiles, this.#maximumBytes);
      if (publishedInspection.revision !== candidateInspection.revision) throw new Error("Published project Skill differs from its draft.");
      return this.#prepareMutation(
        entries,
        result,
        () => this.#assertTrustedProjectTarget(current.backendId, current.targetId, workspaceRoot),
        {
          rollback: () => this.#recoverProjectSkillTransaction(journalPath!, journal),
          cleanupAfterCommit: () => this.#recoverProjectSkillTransaction(journalPath!, journal)
        }
      );
    } catch (error) {
      if (journalPath !== undefined) {
        try {
          await this.#recoverProjectSkillTransaction(journalPath, journal);
        } catch (recoveryError) {
          throw new AggregateError([error, recoveryError], "Project Skill publication failed and its durable rollback requires recovery.");
        }
      }
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      if (await directoryIsEmpty(transactionRoot)) await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #assertSourceUnchanged(record: StoredResource): Promise<void> {
    this.#assertStoredProjectTargetTrusted(record);
    if (
      record.canonicalPath === undefined
      || !(record.source.kind === "local" || record.source.kind === "skill_market" && record.scope === "project")
    ) throw new Error("Resource does not have direct content authority.");
    const inspection = await inspectResourceForKind(record.kind, record.canonicalPath, this.#maximumFiles, this.#maximumBytes);
    if (record.workspaceRoot !== undefined) assertWithin(record.workspaceRoot, inspection.canonicalPath, "Project resource");
    if (!samePath(inspection.canonicalPath, record.canonicalPath) || inspection.revision !== record.discoveredRevision) {
      throw new Error("Approved resource changed and is fenced until it is discovered and approved again.");
    }
  }

  async #assertInstalledSafe(record: StoredResource): Promise<void> {
    if (record.installedPath === undefined) throw new Error("Resource has no installed payload.");
    assertExpectedInstalledLocation(this.#managedRoot, record);
    await assertContainedPath(this.#managedRoot, record.installedPath, "Installed resource payload");
    const inspection = await inspectResourceForKind(record.kind, record.installedPath, this.#maximumFiles, this.#maximumBytes);
    if (inspection.revision !== record.discoveredRevision) throw new Error("Installed resource content changed and is fenced.");
  }

  async #runtimeTextRoot(record: StoredResource, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (isDirectProjectResource(record)) {
      const workspaceRoot = this.#assertTrustedProjectTarget(record.backendId, record.targetId, record.workspaceRoot);
      assertWithin(workspaceRoot, record.canonicalPath, "Runtime text project resource");
      return record.canonicalPath;
    }
    if (record.installedPath === undefined) {
      throw new Error("Enabled runtime text resource has no installed payload.");
    }
    assertExpectedInstalledLocation(this.#managedRoot, record);
    await assertContainedPath(this.#managedRoot, record.installedPath, "Runtime text installed resource");
    signal.throwIfAborted();
    return record.installedPath;
  }

  #planLocalDiscovery(
    input: DiscoverPiResourceInput,
    id: string,
    source: Extract<PiPackageSource, { readonly kind: "local" }>,
    inspection: ResourceInspection,
    compatibility: PiPackageInspection,
    workspaceRoot: string | undefined
  ): { readonly entry: PreparedCatalogEntry; readonly value: PiResourceDescriptor } {
    const previous = this.#records.get(id);
    if (previous !== undefined && (
      previous.backendId !== input.backendId ||
      previous.targetId !== input.targetId ||
      previous.kind !== input.kind ||
      previous.scope !== input.scope ||
      previous.canonicalPath === undefined || !samePath(previous.canonicalPath, inspection.canonicalPath)
    )) throw new Error("Pi resource ID is already bound to a different source.");
    const changedInstalledResource = previous?.scope !== "project" && previous?.installedPath !== undefined;
    const requestedName = nonBlank(input.name ?? previous?.name ?? basename(inspection.canonicalPath), "Resource name");
    const requestedVersion = input.version === undefined
      ? previous?.version
      : nonBlank(input.version, "Resource version");
    if (changedInstalledResource && previous.state !== "removed") {
      const matchesActive = previous.discoveredRevision === inspection.revision
        && previous.name === requestedName
        && previous.version === requestedVersion;
      const pendingUpdate: StoredResourceUpdateIntent = {
        source,
        canonicalPath: inspection.canonicalPath,
        discoveredRevision: inspection.revision,
        name: requestedName,
        ...(requestedVersion === undefined ? {} : { version: requestedVersion })
      };
      const matchesPending = previous.pendingUpdate !== undefined
        && storedUpdateIntentIdentity(previous.pendingUpdate) === storedUpdateIntentIdentity(pendingUpdate);
      if ((matchesActive && previous.pendingUpdate === undefined) || matchesPending) {
        return { entry: { id, expected: previous, next: previous }, value: publicResource(previous) };
      }
      const { pendingUpdate: _pendingUpdate, ...active } = previous;
      const updated: StoredResource = {
        ...active,
        ...(matchesActive ? {} : { pendingUpdate }),
        updatedAt: this.#now()
      };
      return { entry: { id, expected: previous, next: updated }, value: publicResource(updated) };
    }
    if (
      previous !== undefined &&
      previous.state !== "removed" &&
      previous.backendId === input.backendId &&
      previous.targetId === input.targetId &&
      previous.kind === input.kind &&
      previous.scope === input.scope &&
      previous.canonicalPath !== undefined && samePath(previous.canonicalPath, inspection.canonicalPath) &&
      previous.discoveredRevision === inspection.revision
    ) {
      return { entry: { id, expected: previous, next: previous }, value: publicResource(previous) };
    }
    const {
      approvedAt: _approvedAt,
      approvedByConnectionId: _approvedBy,
      extensionApprovedRevision: _extensionApprovedRevision,
      pendingUpdate: _pendingUpdate,
      error: _error,
      ...previousBase
    } = previous ?? {} as StoredResource;
    const record: StoredResource = {
      ...previousBase,
      id,
      backendId: nonBlank(input.backendId, "Backend ID"),
      ...(input.targetId === undefined ? {} : { targetId: nonBlank(input.targetId, "Target ID") }),
      kind: input.kind,
      scope: input.scope,
      name: requestedName,
      ...(requestedVersion === undefined ? {} : { version: requestedVersion }),
      sourceKind: source.kind,
      sourceIdentity: input.kind === "package" ? piPackageSourceIdentity(source) : `${input.kind}:${pathIdentity(inspection.canonicalPath)}`,
      sourceDisplay: basename(inspection.canonicalPath),
      canonicalPathFingerprint: pathFingerprint(inspection.canonicalPath),
      symbolicLinkDetected: false,
      specialFileDetected: false,
      discoveredRevision: inspection.revision,
      ...(input.kind === "package" ? { packageIdentity: compatibility.name } : {}),
      ...compatibilityFields(compatibility, compatibility.extensionContentFingerprint !== undefined),
      state: "awaiting_approval",
      enabled: false,
      versionNumber: ((previous === undefined ? 0n : BigInt(previous.versionNumber)) + 1n).toString(10),
      updatedAt: this.#now(),
      source,
      canonicalPath: inspection.canonicalPath,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot })
    };
    return { entry: { id, expected: previous, next: record }, value: publicResource(record) };
  }

  #prepareMutation<T>(
    entries: readonly PreparedCatalogEntry[],
    value: T,
    assertCurrent?: () => void,
    filesystem?: {
      readonly rollback: () => Promise<void>;
      readonly cleanupAfterCommit?: () => Promise<void>;
    }
  ): PreparedPiResourceMutation<T> {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (ids.has(entry.id)) throw new Error("Prepared resource mutation contains duplicate IDs.");
      ids.add(entry.id);
    }
    const prepared = Object.freeze({
      value,
      revokesRuntimeAuthority: entries.some(({ expected, next }) =>
        expected !== undefined
        && expected.scope === "project"
        && expected.enabled
        && runtimeTextState(expected.state)
        && (
          !next.enabled
          || !runtimeTextState(next.state)
          || next.backendId !== expected.backendId
          || next.targetId !== expected.targetId
          || next.kind !== expected.kind
          || next.scope !== expected.scope
          || next.discoveredRevision !== expected.discoveredRevision
          || next.versionNumber !== expected.versionNumber
          || next.sourceIdentity !== expected.sourceIdentity
          || next.canonicalPath !== expected.canonicalPath
        )),
      [preparedPiResourceMutationBrand]: true as const
    });
    this.#preparedMutations.set(prepared, {
      entries: [...entries],
      value,
      ...(assertCurrent === undefined ? {} : { assertCurrent }),
      ...(filesystem === undefined ? {} : { rollbackFilesystem: filesystem.rollback }),
      ...(filesystem?.cleanupAfterCommit === undefined ? {} : { cleanupAfterCommit: filesystem.cleanupAfterCommit }),
      completed: false
    });
    return prepared;
  }

  #adoptPreparedMutation<T>(prepared: PreparedCatalogMutation<T>, store: OperationalStore): void {
    prepared.assertCurrent?.();
    for (const entry of prepared.entries) {
      if (this.#records.get(entry.id) !== entry.expected) {
        throw new Error(`Prepared resource mutation is stale for ${entry.id}.`);
      }
    }
    const changed = prepared.entries.filter((entry) => entry.next !== entry.expected);
    for (const entry of changed) this.#records.set(entry.id, entry.next);
    try {
      if (changed.length > 0) this.#persist(store);
    } catch (error) {
      this.#restorePreparedMutation(prepared);
      throw error;
    }
  }

  #restorePreparedMutation(prepared: PreparedCatalogMutation<unknown>): void {
    for (const entry of prepared.entries) {
      if (entry.next === entry.expected) continue;
      if (entry.expected === undefined) this.#records.delete(entry.id);
      else this.#records.set(entry.id, entry.expected);
    }
  }

  async #completePreparedStandalone<T>(prepared: PreparedPiResourceMutation<T>): Promise<T> {
    return this.completePreparedMutation(prepared, (finalize) => this.#store.transaction((store) => {
      finalize(store);
      return prepared.value;
    }));
  }

  #require(resourceId: string): StoredResource {
    const record = this.#records.get(nonBlank(resourceId, "Resource ID"));
    if (record === undefined) throw new Error("Pi resource does not exist.");
    return record;
  }

  #assertStoredProjectTargetTrusted(record: StoredResource): void {
    if (record.scope !== "project") return;
    if (record.targetId === undefined || record.workspaceRoot === undefined) throw new Error("Project resource is missing its Target trust boundary.");
    this.#assertTrustedProjectTarget(record.backendId, record.targetId, record.workspaceRoot);
  }

  #assertTargetOwner(backendId: string, targetId: string): void {
    const target = this.#store.getTarget(targetId);
    assertTargetNotDeleted(target.metadata);
    if (target.descriptor.backendId !== backendId) throw new Error("Target does not belong to the requested Backend.");
  }

  #assertTrustedProjectTarget(backendId: string, targetId: string | undefined, workspaceRoot?: string): string {
    if (targetId === undefined) throw new Error("Project resources require a Target.");
    const target = this.#store.getTarget(targetId);
    assertTargetNotDeleted(target.metadata);
    const targetWorkspaceRoot = normalizedAbsolute(target.descriptor.workspaceRoot, "Target workspace root");
    if (target.descriptor.backendId !== backendId || (workspaceRoot !== undefined && !samePath(targetWorkspaceRoot, workspaceRoot))) {
      throw new Error("Project resource does not match its durable Target boundary.");
    }
    if (!target.descriptor.trusted) throw new Error("Project resource is fenced because its Target is not trusted.");
    return targetWorkspaceRoot;
  }

  #persistWithRollback(resourceId: string, previous: StoredResource | undefined): void {
    try { this.#persist(); } catch (error) {
      if (previous === undefined) this.#records.delete(resourceId);
      else this.#records.set(resourceId, previous);
      throw error;
    }
  }

  #persist(store: OperationalStore = this.#store): void {
    store.setSetting("service", this.#scopeId, "pi_resource_catalog", {
      format: 1,
      records: [...this.#records.values()].sort((left, right) => left.id.localeCompare(right.id, "en"))
    } satisfies StoredResourceCatalog);
  }

  #mutate<T>(callback: () => Promise<T>): Promise<T> {
    const operation = this.#tail.then(callback, callback);
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new Error("Pi resource manager is not initialized.");
  }

  #runtimeVersion(backendId: string): string | undefined {
    try {
      const version = this.#store.getBackend(backendId).descriptor.version.trim();
      return version === "" ? undefined : version;
    } catch {
      return undefined;
    }
  }

  #backendSupportsResourceKind(backendId: string, kind: PiResourceKind): boolean {
    try {
      const capability = this.#store.getBackend(backendId).descriptor.capabilities.get("runtime.resources");
      return capability?.supported === true && capability.options?.includes(kind) === true;
    } catch {
      return false;
    }
  }

  async #refreshCompatibility(record: StoredResource): Promise<StoredResource> {
    const path = record.installedPath ?? record.canonicalPath;
    if (path === undefined || record.state === "removed") return record;
    const runtimeVersion = this.#runtimeVersion(record.backendId);
    const inspection = await inspectPiResourceCompatibility(record.kind, path, {
      ...(runtimeVersion === undefined ? {} : { currentRuntimeVersion: runtimeVersion }),
      contentFingerprint: record.discoveredRevision
    });
    const extensionFingerprint = inspection.extensionContentFingerprint;
    const inheritedExactApproval = extensionFingerprint !== undefined
      && record.source.kind === "local"
      && record.approvedAt !== undefined
      && record.discoveredRevision === extensionFingerprint;
    const extensionApprovedRevision = extensionFingerprint !== undefined
      && (record.extensionApprovedRevision === extensionFingerprint || inheritedExactApproval)
      ? extensionFingerprint
      : undefined;
    const requiresExtensionApproval = extensionFingerprint !== undefined && extensionApprovedRevision === undefined;
    const { extensionApprovedRevision: _previousApproval, ...base } = record;
    return {
      ...base,
      ...(record.kind === "package" ? { packageIdentity: inspection.name } : {}),
      ...compatibilityFields(inspection, requiresExtensionApproval),
      ...(extensionApprovedRevision === undefined ? {} : { extensionApprovedRevision })
    };
  }
}

export interface PiSkillPackageInspection {
  readonly canonicalPath: string;
  readonly revision: string;
  readonly files: number;
  readonly bytes: number;
}

type ResourceInspection = PiSkillPackageInspection;

interface CopyBudget { files: number; bytes: number; readonly maxFiles: number; readonly maxBytes: number }

async function inspectResource(
  sourcePath: string,
  maximumFiles: number,
  maximumBytes: number,
  signal?: AbortSignal
): Promise<ResourceInspection> {
  signal?.throwIfAborted();
  const source = normalizedAbsolute(sourcePath, "Resource source path");
  const rootInfo = await lstat(source);
  signal?.throwIfAborted();
  if (rootInfo.isSymbolicLink()) throw new Error("Resource symlinks and junctions are not allowed.");
  if (!rootInfo.isDirectory() && !rootInfo.isFile()) throw new Error("Resource source must be a regular file or directory.");
  const canonicalPath = await realpath(source);
  signal?.throwIfAborted();
  if (!samePath(source, canonicalPath)) throw new Error("Resource source contains a path alias or junction.");
  const hash = createHash("sha256");
  const budget = { files: 0, bytes: 0, maxFiles: maximumFiles, maxBytes: maximumBytes };
  if (rootInfo.isFile()) await inspectFile(canonicalPath, canonicalPath, "", hash, budget, signal);
  else await inspectDirectory(canonicalPath, canonicalPath, "", hash, budget, signal);
  signal?.throwIfAborted();
  return { canonicalPath, revision: `sha256:${hash.digest("hex")}`, files: budget.files, bytes: budget.bytes };
}

async function inspectSkillPackage(
  sourcePath: string,
  maximumFiles: number,
  maximumBytes: number,
  signal?: AbortSignal
): Promise<ResourceInspection> {
  const inspection = await inspectResource(sourcePath, maximumFiles, maximumBytes, signal);
  const rootInfo = await lstat(inspection.canonicalPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Skill content must be a regular directory.");
  const manifest = join(inspection.canonicalPath, "SKILL.md");
  const manifestInfo = await lstat(manifest).catch(() => undefined);
  if (manifestInfo === undefined || !manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
    throw new Error("Skill content must contain a regular SKILL.md file.");
  }
  const canonicalManifest = await realpath(manifest);
  if (!samePath(manifest, canonicalManifest)) throw new Error("Skill SKILL.md contains a path alias or junction.");
  assertWithin(inspection.canonicalPath, canonicalManifest, "Skill manifest");
  await assertStableUtf8File(canonicalManifest, signal);
  await assertPortableSkillTreeKeys(inspection.canonicalPath, inspection.canonicalPath, "");
  signal?.throwIfAborted();
  return inspection;
}

/**
 * Validate one path-private Skill tree with the same limits and portability
 * rules used by Resource adoption. Market acquisition calls this only after
 * archive extraction and never projects the canonical path onto the wire.
 */
export function inspectPiSkillPackage(
  sourcePath: string,
  maximumFiles: number,
  maximumBytes: number,
  signal?: AbortSignal
): Promise<PiSkillPackageInspection> {
  return inspectSkillPackage(sourcePath, maximumFiles, maximumBytes, signal);
}

function inspectResourceForKind(
  kind: PiResourceKind,
  sourcePath: string,
  maximumFiles: number,
  maximumBytes: number,
  signal?: AbortSignal
): Promise<ResourceInspection> {
  return kind === "skill"
    ? inspectSkillPackage(sourcePath, maximumFiles, maximumBytes, signal)
    : inspectResource(sourcePath, maximumFiles, maximumBytes, signal);
}

async function assertStableUtf8File(path: string, signal?: AbortSignal): Promise<void> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Skill SKILL.md must be a regular UTF-8 file.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const chunk of createReadStream(path, { signal })) {
      decoder.decode(chunk, { stream: true });
    }
    decoder.decode();
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof TypeError) throw new Error("Skill SKILL.md must be valid UTF-8.");
    throw error;
  }
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("Skill SKILL.md changed while its UTF-8 content was validated.");
  }
}

async function assertPortableSkillTreeKeys(root: string, directory: string, parentKey: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const key = parentKey === "" ? entry.name : `${parentKey}/${entry.name}`;
    const parts = key.split("/");
    if (
      key.length > 512 || parts.length > 32 || /[<>:"|?*\u0000-\u001f]/u.test(entry.name)
      || /[. ]$/u.test(entry.name) || isWindowsReservedSkillName(entry.name)
    ) throw new Error("Skill content contains a non-portable path key.");
    if (entry.isDirectory()) await assertPortableSkillTreeKeys(root, join(directory, entry.name), key);
  }
  assertWithin(root, directory, "Skill portable path");
}

function isWindowsReservedSkillName(value: string): boolean {
  const stem = value.split(".", 1)[0]!.toUpperCase();
  return stem === "CON" || stem === "PRN" || stem === "AUX" || stem === "NUL"
    || /^COM[1-9]$/u.test(stem) || /^LPT[1-9]$/u.test(stem);
}

async function syncTreeForPublish(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    validateEntryName(entry.name);
    const path = join(root, entry.name);
    const info = await lstat(path);
    if (entry.isSymbolicLink() || info.isSymbolicLink()) throw new Error("Skill publish tree contains a symlink or junction.");
    if (entry.isDirectory() && info.isDirectory()) {
      await syncTreeForPublish(path);
      continue;
    }
    if (!entry.isFile() || !info.isFile()) throw new Error("Skill publish tree contains a special file.");
    // Windows requires a writable handle for FlushFileBuffers even though no
    // bytes are changed here. The staged copy is service-owned and writable.
    const handle = await open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

async function inspectDirectory(
  root: string,
  directory: string,
  relativePath: string,
  hash: ReturnType<typeof createHash>,
  budget: CopyBudget,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Resource tree contains a symlink, junction, or non-directory entry.");
  const canonical = await realpath(directory);
  signal?.throwIfAborted();
  assertWithin(root, canonical, "Resource directory");
  hash.update(`D\0${relativePath}\0`);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    signal?.throwIfAborted();
    validateEntryName(entry.name);
    const path = join(directory, entry.name);
    const childRelative = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
    const info = await lstat(path);
    if (entry.isSymbolicLink() || info.isSymbolicLink()) throw new Error("Resource tree contains a symlink or junction.");
    if (entry.isDirectory() && info.isDirectory()) await inspectDirectory(root, path, childRelative, hash, budget, signal);
    else if (entry.isFile() && info.isFile()) await inspectFile(root, path, childRelative, hash, budget, signal);
    else throw new Error("Resource tree contains a special file or changed during inspection.");
  }

  const after = await lstat(directory);
  signal?.throwIfAborted();
  if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after) || before.mtimeMs !== after.mtimeMs) {
    throw new Error("Resource directory changed during inspection.");
  }
}

async function inspectFile(
  root: string,
  path: string,
  relativePath: string,
  hash: ReturnType<typeof createHash>,
  budget: CopyBudget,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Resource tree contains a special file or symlink.");
  const canonical = await realpath(path);
  signal?.throwIfAborted();
  assertWithin(root, canonical, "Resource file");
  budget.files += 1;
  budget.bytes += before.size;
  if (budget.files > budget.maxFiles || budget.bytes > budget.maxBytes) throw new Error("Resource exceeds configured file or byte limits.");
  hash.update(`F\0${relativePath}\0${before.size}\0`);
  for await (const chunk of createReadStream(path, signal === undefined ? undefined : { signal })) {
    signal?.throwIfAborted();
    hash.update(chunk as Buffer);
  }
  const after = await stat(path);
  signal?.throwIfAborted();
  if (!after.isFile() || !sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("Resource file changed during inspection.");
  }
}

async function snapshotInstalledPackageTree(
  sourceRoot: string,
  destinationRoot: string,
  maximumEntries: number,
  maximumBytes: number,
  signal?: AbortSignal
): Promise<PiInstalledPackageSnapshot> {
  signal?.throwIfAborted();
  const source = normalizedAbsolute(sourceRoot, "Installed package snapshot source");
  const destination = normalizedAbsolute(destinationRoot, "Installed package snapshot destination");
  await assertCanonicalDirectory(source, "Installed package snapshot source");
  await assertCanonicalDirectory(destination, "Installed package snapshot destination");
  if ((await readdir(destination)).length !== 0) throw new Error("Installed package snapshot destination must be empty.");
  const entries: PiInstalledPackageSnapshotEntry[] = [];
  const budget = { files: 0, bytes: 0 };

  const visit = async (sourceDirectory: string, destinationDirectory: string, relativeDirectory: string): Promise<void> => {
    signal?.throwIfAborted();
    const directoryBefore = await lstat(sourceDirectory);
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
      throw new Error("Installed package snapshot contains a symlink, junction, or special directory.");
    }
    const canonicalDirectory = await realpath(sourceDirectory);
    assertWithin(source, canonicalDirectory, "Installed package snapshot directory");
    const children = await readdir(sourceDirectory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      signal?.throwIfAborted();
      validateEntryName(child.name);
      const sourcePath = join(sourceDirectory, child.name);
      const destinationPath = join(destinationDirectory, child.name);
      const relativePath = relativeDirectory === "" ? child.name : `${relativeDirectory}/${child.name}`;
      const before = await lstat(sourcePath);
      if (child.isSymbolicLink() || before.isSymbolicLink()) {
        throw new Error("Installed package snapshot contains a symlink or junction.");
      }
      const canonical = await realpath(sourcePath);
      assertWithin(source, canonical, "Installed package snapshot entry");
      if (child.isDirectory() && before.isDirectory()) {
        const mode = portablePackageMode(before.mode, true);
        entries.push({ path: relativePath, kind: "directory", mode, size: 0 });
        if (entries.length > maximumEntries) throw new Error("Installed package snapshot exceeds its entry limit.");
        await mkdir(destinationPath, { recursive: false, mode: 0o700 });
        await visit(canonical, destinationPath, relativePath);
        await chmod(destinationPath, mode);
      } else if (child.isFile() && before.isFile()) {
        budget.files += 1;
        budget.bytes += before.size;
        const mode = portablePackageMode(before.mode, false);
        entries.push({ path: relativePath, kind: "file", mode, size: before.size });
        if (entries.length > maximumEntries || budget.bytes > maximumBytes) {
          throw new Error("Installed package snapshot exceeds its entry or byte limit.");
        }
        signal?.throwIfAborted();
        await copyFile(canonical, destinationPath, constants.COPYFILE_EXCL);
        signal?.throwIfAborted();
        await chmod(destinationPath, mode);
      } else {
        throw new Error("Installed package snapshot contains a special file or changed entry.");
      }
      const after = await lstat(sourcePath);
      if (
        after.isSymbolicLink()
        || !sameIdentity(before, after)
        || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs
      ) throw new Error("Installed package entry changed while snapshotting.");
    }
    const directoryAfter = await lstat(sourceDirectory);
    if (
      !directoryAfter.isDirectory()
      || directoryAfter.isSymbolicLink()
      || !sameIdentity(directoryBefore, directoryAfter)
      || directoryBefore.mtimeMs !== directoryAfter.mtimeMs
    ) throw new Error("Installed package directory changed while snapshotting.");
  };

  await visit(source, destination, "");
  signal?.throwIfAborted();
  const inspection = await inspectResource(destination, maximumEntries, maximumBytes, signal);
  return {
    discoveredRevision: inspection.revision,
    files: inspection.files,
    bytes: inspection.bytes,
    entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry })))
  };
}

function portablePackageMode(sourceMode: number, directory: boolean): number {
  if (directory) return 0o755;
  return (sourceMode & 0o111) === 0 ? 0o644 : 0o755;
}

function runtimeTextState(state: PiResourceState): state is "approved" | "installed" | "loaded" {
  return state === "approved" || state === "installed" || state === "loaded";
}

function assertApprovedRuntimeTextInspection(
  record: StoredResource,
  root: string,
  inspection: ResourceInspection
): void {
  if (!samePath(root, inspection.canonicalPath) || inspection.revision !== record.discoveredRevision) {
    throw new Error("Runtime text resource content changed after approval.");
  }
}

async function readRuntimeTextContent(
  root: string,
  kind: "skill" | "prompt",
  maximumBytes: number,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted();
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || (!rootInfo.isFile() && !rootInfo.isDirectory())) {
    throw new Error("Runtime text resource root must be a regular file or directory.");
  }
  const canonicalRoot = await realpath(root);
  if (!samePath(root, canonicalRoot)) throw new Error("Runtime text resource root contains a path alias or junction.");
  let contentPath: string;
  if (kind === "prompt") {
    if (!rootInfo.isFile()) throw new Error("Runtime prompt content must be a bounded regular UTF-8 file.");
    contentPath = canonicalRoot;
  } else {
    contentPath = rootInfo.isFile() ? canonicalRoot : join(canonicalRoot, "SKILL.md");
  }
  return readBoundedRuntimeTextFile(canonicalRoot, contentPath, maximumBytes, signal);
}

async function readBoundedRuntimeTextFile(
  root: string,
  path: string,
  maximumBytes: number,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted();
  if (!isAbsolute(path)) throw new Error("Runtime text content path must be absolute.");
  assertWithin(root, path, "Runtime text content");
  const before = await lstat(path);
  if (
    !before.isFile() || before.isSymbolicLink()
    || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > maximumBytes
  ) throw new Error("Runtime text content must be a bounded regular UTF-8 file.");
  const canonical = await realpath(path);
  if (!samePath(path, canonical)) throw new Error("Runtime text content contains a path alias or junction.");
  assertWithin(root, canonical, "Runtime text content");
  signal.throwIfAborted();
  const handle = await open(canonical, "r");
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(before, opened) || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) {
      throw new Error("Runtime text content changed before it was read.");
    }
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      signal.throwIfAborted();
      const length = Math.min(64 * 1024, bytes.byteLength - offset);
      const result = await handle.read(bytes, offset, length, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    signal.throwIfAborted();
    if (offset !== bytes.byteLength) throw new Error("Runtime text content changed while it was read.");
    const after = await handle.stat();
    if (!after.isFile() || !sameIdentity(opened, after) || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) {
      throw new Error("Runtime text content changed while it was read.");
    }
  } finally {
    await handle.close();
  }
  signal.throwIfAborted();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Runtime text content must contain valid UTF-8.");
  }
}

async function waitForCaller<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const aborted = (): void => rejectPromise(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        rejectPromise(error);
      }
    );
  });
}

async function copyTreeFailClosed(root: string, source: string, destination: string, budget: CopyBudget): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    validateEntryName(entry.name);
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const before = await lstat(sourcePath);
    if (entry.isSymbolicLink() || before.isSymbolicLink()) throw new Error("Resource tree contains a symlink or junction.");
    const canonical = await realpath(sourcePath);
    assertWithin(root, canonical, "Resource copy source");
    if (entry.isDirectory() && before.isDirectory()) {
      await mkdir(destinationPath, { recursive: false, mode: 0o700 });
      await copyTreeFailClosed(root, canonical, destinationPath, budget);
    } else if (entry.isFile() && before.isFile()) {
      budget.files += 1;
      budget.bytes += before.size;
      if (budget.files > budget.maxFiles || budget.bytes > budget.maxBytes) throw new Error("Resource exceeds configured file or byte limits.");
      await copyFile(canonical, destinationPath, constants.COPYFILE_EXCL);
    } else throw new Error("Resource contains a special file or changed during copy.");
    const after = await lstat(sourcePath);
    if (after.isSymbolicLink() || !sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("Resource changed during copy.");
    }
  }
}

function publicMarketSkillPreview(
  input: PiMarketSkillSourceInput & PiMarketSkillTargetInput,
  inspected: InspectedMarketSkill
): PiMarketSkillPreview {
  const source = normalizeStoredSkillMarketSource(input);
  const current = inspected.current;
  const observedRevision = inspected.currentInspection?.revision ?? current?.discoveredRevision;
  const sameMarketEntry = current?.source.kind === "skill_market"
    && current.source.sourceId === source.sourceId
    && current.source.entryId === source.entryId;
  const action: PiMarketSkillAction = current === undefined && !inspected.unregisteredDestination
    ? "install"
    : sameMarketEntry && current?.id === inspected.resourceId
      ? "update"
      : "replace";
  const marketDirty = current?.source.kind === "skill_market"
    && current.discoveredRevision !== current.source.installedContentRevision;
  return {
    action,
    resourceId: inspected.resourceId,
    backendId: input.backendId,
    ...(input.scope === "project" ? { targetId: input.targetId } : {}),
    scope: input.scope,
    ...(inspected.relativeParent === undefined ? {} : { relativeParent: inspected.relativeParent }),
    name: source.slug,
    availableVersion: boundedVersion(input.version),
    candidateRevision: inspected.inspection.revision,
    files: inspected.inspection.files,
    bytes: inspected.inspection.bytes,
    ...(current === undefined
      ? {}
      : {
          currentResource: {
            resourceId: current.id,
            resourceVersion: BigInt(current.versionNumber),
            name: current.name,
            ...(current.version === undefined ? {} : { version: current.version }),
            sourceKind: current.sourceKind,
            sourceDisplay: current.sourceDisplay,
            discoveredRevision: current.discoveredRevision,
            observedRevision: observedRevision!,
            dirty: marketDirty || observedRevision !== current.discoveredRevision
          }
        }),
    unregisteredDestination: inspected.unregisteredDestination,
    sourceReplacement: inspected.sourceReplacement,
    preservesEnabled: current?.enabled === true && inspected.compatibility.canToggle,
    diffAvailable: inspected.diffAvailable,
    ...(inspected.diffReason === undefined ? {} : { diffReason: inspected.diffReason }),
    changes: inspected.changes.map((change) => ({ ...change })),
    diffTruncated: inspected.diffTruncated
  };
}

function marketGlobalSkillResourceId(backendId: string, name: string): string {
  return `resource_skill_market_${createHash("sha256").update(`${backendId}\0global\0${name}`).digest("hex").slice(0, 32)}`;
}

function portableProjectSkillParent(value: string): string {
  const path = nonBlank(value, "Project Skill parent");
  if (path.length > 512 || path.includes("\\") || path.startsWith("/") || isAbsolute(path) || /^[A-Za-z]:/u.test(path)) {
    throw new Error("Project Skill parent must be a portable Target-relative path.");
  }
  const parts = path.split("/");
  if (parts.length > 32 || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Project Skill parent must be a portable Target-relative path.");
  }
  for (const part of parts) {
    validateEntryName(part);
    if (/[<>:"|?*\u0000-\u001f]/u.test(part) || /[. ]$/u.test(part) || isWindowsReservedSkillName(part)) {
      throw new Error("Project Skill parent contains a non-portable path component.");
    }
  }
  return path;
}

async function resolveProjectSkillParent(workspaceRoot: string, relativeParent: string, create: boolean): Promise<string> {
  const root = await canonicalDirectory(workspaceRoot, "Project Skill workspace");
  const portable = portableProjectSkillParent(relativeParent);
  let current = root;
  for (const part of portable.split("/")) {
    const candidate = join(current, part);
    assertWithin(root, candidate, "Project Skill parent");
    let info = await optionalLstat(candidate);
    if (info === undefined) {
      if (!create) {
        current = candidate;
        continue;
      }
      await mkdir(candidate, { recursive: false, mode: 0o700 });
      info = await lstat(candidate);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Project Skill parent contains a symlink or non-directory entry.");
    const canonical = await realpath(candidate);
    assertWithin(root, canonical, "Project Skill parent");
    if (!samePath(candidate, canonical)) throw new Error("Project Skill parent contains a path alias or junction.");
    current = candidate;
  }
  return current;
}

interface MarketDiffFile {
  readonly hash: string;
  readonly text?: string;
}

async function compareMarketSkillTrees(
  beforeRoot: string | undefined,
  afterRoot: string
): Promise<{ readonly changes: readonly PiMarketSkillDiffChange[]; readonly truncated: boolean }> {
  const [before, after] = await Promise.all([
    beforeRoot === undefined ? Promise.resolve(new Map<string, MarketDiffFile>()) : collectMarketDiffFiles(beforeRoot),
    collectMarketDiffFiles(afterRoot)
  ]);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => left.localeCompare(right, "en"));
  const changes: PiMarketSkillDiffChange[] = [];
  let diffBytes = 0;
  let truncated = false;
  for (const key of keys) {
    const left = before.get(key);
    const right = after.get(key);
    if (left?.hash === right?.hash) continue;
    if (changes.length >= MAXIMUM_MARKET_DIFF_CHANGES) {
      truncated = true;
      break;
    }
    const kind = left === undefined ? "added" : right === undefined ? "deleted" : "modified";
    const binary = left?.text === undefined && left !== undefined || right?.text === undefined && right !== undefined;
    let unifiedDiff: string | undefined;
    if (!binary) {
      const candidate = marketWholeFileDiff(key, left?.text ?? "", right?.text ?? "");
      const bytes = Buffer.byteLength(candidate, "utf8");
      if (diffBytes + bytes <= MAXIMUM_MARKET_UNIFIED_DIFF_BYTES) {
        unifiedDiff = candidate;
        diffBytes += bytes;
      } else truncated = true;
    }
    changes.push({ key, kind, binary, ...(unifiedDiff === undefined ? {} : { unifiedDiff }) });
  }
  return { changes, truncated };
}

async function collectMarketDiffFiles(root: string): Promise<Map<string, MarketDiffFile>> {
  await assertCanonicalDirectory(root, "Skill diff root");
  const files = new Map<string, MarketDiffFile>();
  const visit = async (directory: string, parentKey: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      validateEntryName(entry.name);
      const key = parentKey === "" ? entry.name : `${parentKey}/${entry.name}`;
      const path = join(directory, entry.name);
      const before = await lstat(path);
      if (entry.isSymbolicLink() || before.isSymbolicLink()) throw new Error("Skill diff contains a symlink or junction.");
      if (entry.isDirectory() && before.isDirectory()) await visit(path, key);
      else if (entry.isFile() && before.isFile()) {
        const bytes = await readFile(path);
        let text: string | undefined;
        if (bytes.byteLength <= MAXIMUM_MARKET_DIFF_TEXT_BYTES) {
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            if (text.includes("\0")) text = undefined;
          } catch { /* binary */ }
        }
        const after = await lstat(path);
        if (!sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          throw new Error("Skill diff content changed while it was read.");
        }
        files.set(key, { hash: createHash("sha256").update(bytes).digest("hex"), ...(text === undefined ? {} : { text }) });
      } else throw new Error("Skill diff contains a special file.");
    }
  };
  await visit(root, "");
  return files;
}

function marketWholeFileDiff(key: string, before: string, after: string): string {
  const left = marketSplitLines(before);
  const right = marketSplitLines(after);
  const header = `--- a/${key}\n+++ b/${key}\n@@ -1,${left.length} +1,${right.length} @@\n`;
  return `${header}${left.map((line) => `-${line}`).join("\n")}${left.length > 0 ? "\n" : ""}${right.map((line) => `+${line}`).join("\n")}${right.length > 0 ? "\n" : ""}`;
}

function marketSplitLines(value: string): string[] {
  if (value === "") return [];
  const lines = value.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function publicResource(record: StoredResource): PiResourceDescriptor {
  return {
    id: record.id,
    backendId: record.backendId,
    ...(record.targetId === undefined ? {} : { targetId: record.targetId }),
    kind: record.kind,
    scope: record.scope,
    name: record.name,
    ...(record.version === undefined ? {} : { version: record.version }),
    sourceKind: record.sourceKind,
    sourceIdentity: record.sourceIdentity,
    sourceDisplay: record.sourceDisplay,
    canonicalPathFingerprint: record.canonicalPathFingerprint,
    symbolicLinkDetected: record.symbolicLinkDetected,
    specialFileDetected: record.specialFileDetected,
    discoveredRevision: record.discoveredRevision,
    resourceDetails: record.resourceDetails.map(copyResourceDetail),
    runtimeRequirements: record.runtimeRequirements.map((requirement) => ({ ...requirement })),
    warnings: [...record.warnings],
    disabledLifecycleScripts: [...record.disabledLifecycleScripts],
    canToggle: record.canToggle,
    requiresExtensionApproval: record.requiresExtensionApproval,
    ...(record.extensionContentFingerprint === undefined ? {} : { extensionContentFingerprint: record.extensionContentFingerprint }),
    postMutationNotice: record.postMutationNotice,
    state: record.pendingUpdate !== undefined && record.state !== "error" && record.state !== "removed"
      ? "update_available"
      : record.state,
    enabled: record.enabled,
    ...(record.approvedAt === undefined ? {} : { approvedAt: record.approvedAt }),
    ...(record.approvedByConnectionId === undefined ? {} : { approvedByConnectionId: record.approvedByConnectionId }),
    versionNumber: BigInt(record.versionNumber),
    updatedAt: record.updatedAt,
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.packageIdentity === undefined ? {} : { packageIdentity: record.packageIdentity }),
    ...(record.source.kind === "extension_source"
      ? {
          extensionSource: {
            sourceId: record.source.sourceId,
            sourceRevision: BigInt(record.source.sourceRevision),
            packageRelativePath: record.source.packageRelativePath,
            packageContentRevision: record.source.packageContentRevision
          }
        }
      : record.source.kind === "skill_market"
        ? {
            skillMarket: {
              sourceId: record.source.sourceId,
              sourceRevision: BigInt(record.source.sourceRevision),
              entryId: record.source.entryId,
              entryRevision: BigInt(record.source.entryRevision),
              entryContentRevision: record.source.entryContentRevision,
              installedContentRevision: record.source.installedContentRevision,
              ...(record.source.relativeParent === undefined ? {} : { relativeParent: record.source.relativeParent })
            }
          }
        : {})
  };
}

function publicExtensionPackagePreview(
  plan: ExtensionPackagePlan,
  compatibility: PiPackageInspection
): PiExtensionPackagePreview {
  const current = plan.current;
  return {
    action: plan.action,
    resourceId: plan.resourceId,
    backendId: plan.backendId,
    packageName: compatibility.name,
    ...(compatibility.version === undefined ? {} : { availableVersion: compatibility.version }),
    ...(current?.version === undefined ? {} : { installedVersion: current.version }),
    ...(current === undefined
      ? {}
      : {
          currentResource: {
            resourceId: current.id,
            resourceVersion: BigInt(current.versionNumber),
            name: current.name,
            sourceDisplay: current.sourceDisplay
          }
        }),
    sourceReplacement: plan.sourceReplacement,
    preservesEnabled: current?.enabled === true && compatibility.canToggle,
    resourceDetails: compatibility.resources.map(copyResourceDetail),
    runtimeRequirements: compatibility.runtimeRequirements.map((requirement) => ({ ...requirement })),
    warnings: [...compatibility.warnings],
    disabledLifecycleScripts: [...compatibility.disabledLifecycleScripts],
    canToggle: compatibility.canToggle
  };
}

function assertExtensionPackageSelection(
  input: PiExtensionSourcePackageInput,
  compatibility: PiPackageInspection
): void {
  if (compatibility.name !== nonBlank(input.packageName, "Extension source package name")) {
    throw new Error("Extension source package identity changed after discovery.");
  }
  const expectedVersion = input.version === undefined ? undefined : boundedVersion(input.version);
  if (compatibility.version !== expectedVersion) {
    throw new Error("Extension source package version changed after discovery.");
  }
  let ordinal = 0;
  const selected = compatibility.resources.find((detail) => {
    if (detail.kind !== "extension" || detail.name !== input.bindingName) return false;
    const matches = ordinal === input.bindingOrdinal;
    ordinal += 1;
    return matches;
  });
  if (selected === undefined) {
    throw new Error("The selected Extension binding changed after discovery.");
  }
}

function normalizedExtensionSourceId(value: string): string {
  const id = nonBlank(value, "Extension source ID");
  if (!/^extension_source_[a-f0-9]{32}$/u.test(id)) throw new Error("Extension source ID is invalid.");
  return id;
}

function normalizedDecimalRevision(value: bigint, label: string): string {
  if (value < 1n) throw new Error(`${label} is invalid.`);
  return value.toString(10);
}

function normalizedContentRevision(value: string, label: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function normalizeExtensionPackagePath(value: string): string {
  const path = nonBlank(value, "Extension source package path");
  if (
    path.length > 512
    || path.includes("\\")
    || path.startsWith("/")
    || isAbsolute(path)
    || path.split("/").some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git")
  ) {
    throw new Error("Extension source package path is invalid.");
  }
  return path;
}

function extensionSourcePackageIdentity(source: StoredExtensionSourcePackage): string {
  return `extension-source:${createHash("sha256")
    .update(`${source.sourceIdentity}\0${source.packageRelativePath}`)
    .digest("hex")}`;
}

function extensionSourcePackageFingerprint(source: StoredExtensionSourcePackage): string {
  return `sha256:${createHash("sha256").update(extensionSourcePackageIdentity(source)).digest("hex")}`;
}

function storedUpdateIntentIdentity(intent: StoredResourceUpdateIntent): string {
  return JSON.stringify({
    source: intent.source,
    canonicalPath: intent.canonicalPath,
    discoveredRevision: intent.discoveredRevision,
    name: intent.name,
    version: intent.version
  });
}

type StoredCompatibilityFields = Pick<
  StoredResource,
  | "resourceDetails"
  | "runtimeRequirements"
  | "warnings"
  | "disabledLifecycleScripts"
  | "canToggle"
  | "requiresExtensionApproval"
  | "extensionContentFingerprint"
  | "postMutationNotice"
>;

function compatibilityFields(inspection: PiPackageInspection, requiresExtensionApproval: boolean): StoredCompatibilityFields {
  return {
    resourceDetails: inspection.resources.map(copyResourceDetail),
    runtimeRequirements: inspection.runtimeRequirements.map((requirement) => ({ ...requirement })),
    warnings: [...inspection.warnings],
    disabledLifecycleScripts: [...inspection.disabledLifecycleScripts],
    canToggle: inspection.canToggle,
    requiresExtensionApproval,
    ...(inspection.extensionContentFingerprint === undefined
      ? {}
      : { extensionContentFingerprint: inspection.extensionContentFingerprint }),
    postMutationNotice: shouldShowPiPackageNotice(inspection, requiresExtensionApproval)
  };
}

function emptyCompatibilityFields(): StoredCompatibilityFields {
  return {
    resourceDetails: [],
    runtimeRequirements: [],
    warnings: [],
    disabledLifecycleScripts: [],
    canToggle: false,
    requiresExtensionApproval: false,
    postMutationNotice: false
  };
}

function inspectionFromRecord(record: StoredResource): PiPackageInspection {
  const compatibilityNotice = record.warnings.length > 0
    || record.resourceDetails.some((detail) => detail.compatibility !== "supported" || detail.compatibilityIssues.length > 0)
    || record.runtimeRequirements.some((requirement) => requirement.compatible !== true);
  return {
    name: record.name,
    ...(record.version === undefined ? {} : { version: record.version }),
    resources: record.resourceDetails.map(copyResourceDetail),
    runtimeRequirements: record.runtimeRequirements.map((requirement) => ({ ...requirement })),
    warnings: [...record.warnings],
    disabledLifecycleScripts: [...record.disabledLifecycleScripts],
    canToggle: record.canToggle,
    ...(record.extensionContentFingerprint === undefined ? {} : { extensionContentFingerprint: record.extensionContentFingerprint }),
    compatibilityNotice
  };
}

function copyResourceDetail(detail: PiPackageResourceDetail): PiPackageResourceDetail {
  return {
    kind: detail.kind,
    name: detail.name,
    ...(detail.entryPath === undefined ? {} : { entryPath: detail.entryPath }),
    ...(detail.mainView === undefined ? {} : { mainView: { ...detail.mainView } }),
    ...(detail.library === undefined ? {} : { library: { ...detail.library } }),
    compatibility: detail.compatibility,
    compatibilityIssues: [...detail.compatibilityIssues],
    detectedApis: [...detail.detectedApis],
    adaptedApis: [...detail.adaptedApis],
    unsupportedApis: [...detail.unsupportedApis]
  };
}

function resourceCompatibilityIdentity(record: StoredResource): string {
  return JSON.stringify({
    resourceDetails: record.resourceDetails,
    runtimeRequirements: record.runtimeRequirements,
    warnings: record.warnings,
    disabledLifecycleScripts: record.disabledLifecycleScripts,
    canToggle: record.canToggle,
    requiresExtensionApproval: record.requiresExtensionApproval,
    extensionContentFingerprint: record.extensionContentFingerprint,
    extensionApprovedRevision: record.extensionApprovedRevision,
    postMutationNotice: record.postMutationNotice,
    packageIdentity: record.packageIdentity
  });
}

function validateStoredCompatibility(value: StoredResource): StoredCompatibilityFields {
  const resourceDetails = validateStoredResourceDetails(value.resourceDetails);
  const runtimeRequirements = validateStoredRuntimeRequirements(value.runtimeRequirements);
  const warnings = validateStoredWarnings(value.warnings);
  const disabledLifecycleScripts = validateStoredLifecycleScripts(value.disabledLifecycleScripts);
  if (
    typeof value.canToggle !== "boolean"
    || typeof value.requiresExtensionApproval !== "boolean"
    || typeof value.postMutationNotice !== "boolean"
  ) {
    throw new Error("Stored resource compatibility flags are malformed.");
  }
  const extensionContentFingerprint = value.extensionContentFingerprint;
  if (extensionContentFingerprint !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(extensionContentFingerprint)) {
    throw new Error("Stored extension content fingerprint is malformed.");
  }
  return {
    resourceDetails,
    runtimeRequirements,
    warnings,
    disabledLifecycleScripts,
    canToggle: value.canToggle,
    requiresExtensionApproval: value.requiresExtensionApproval,
    ...(extensionContentFingerprint === undefined ? {} : { extensionContentFingerprint }),
    postMutationNotice: value.postMutationNotice
  };
}

function validateStoredResourceDetails(value: readonly PiPackageResourceDetail[]): readonly PiPackageResourceDetail[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error("Stored resource compatibility details are malformed.");
  const kinds = new Set(["extension", "skill", "prompt", "theme"]);
  const compatibility = new Set(["supported", "partial", "unsupported", "unknown"]);
  const issues = new Set([
    "working-indicator", "widget-component", "editor-integration", "tui-layout", "custom-ui",
    "theme-control", "terminal-input", "tui-rendering", "cli-flags", "analysis-incomplete"
  ]);
  const apis = new Set([
    "select", "confirm", "input", "editor", "notify", "setStatus", "setWorkingMessage", "setWorkingVisible",
    "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setTitle", "setEditorText", "getEditorText",
    "pasteToEditor", "getEditorComponent", "addAutocompleteProvider", "setEditorComponent", "setFooter", "setHeader",
    "setToolsExpanded", "getToolsExpanded", "custom", "getAllThemes", "getTheme", "setTheme", "theme",
    "onTerminalInput", "registerShortcut", "registerFlag", "registerMessageRenderer", "registerMarkdownTransformer",
    "registerEntryRenderer"
  ]);
  return value.map((detail) => {
    if (
      !detail || typeof detail !== "object" || !kinds.has(detail.kind) || !compatibility.has(detail.compatibility)
      || typeof detail.name !== "string" || detail.name.trim() === "" || detail.name.length > 256
      || Object.keys(detail).some((key) => ![
        "kind", "name", "entryPath", "mainView", "library", "compatibility", "compatibilityIssues", "detectedApis", "adaptedApis", "unsupportedApis"
      ].includes(key))
      || detail.kind === "extension" !== (typeof detail.entryPath === "string")
      || detail.entryPath !== undefined && !isStoredPackageRelativePath(detail.entryPath)
      || detail.mainView !== undefined && (detail.kind !== "extension" || !isExtensionMainViewDescriptor(detail.mainView))
      || detail.library !== undefined && (detail.kind !== "extension" || !isExtensionLibraryDescriptor(detail.library))
    ) throw new Error("Stored resource compatibility detail is malformed.");
    const compatibilityIssues = validateStringEnumList(detail.compatibilityIssues, issues, "compatibility issue");
    const detectedApis = validateStringEnumList(detail.detectedApis, apis, "detected API");
    const adaptedApis = validateStringEnumList(detail.adaptedApis, apis, "adapted API");
    const unsupportedApis = validateStringEnumList(detail.unsupportedApis, apis, "unsupported API");
    return {
      kind: detail.kind,
      name: detail.name,
      ...(detail.entryPath === undefined ? {} : { entryPath: detail.entryPath }),
      ...(detail.mainView === undefined ? {} : { mainView: { ...detail.mainView } }),
      ...(detail.library === undefined ? {} : { library: { ...detail.library } }),
      compatibility: detail.compatibility,
      compatibilityIssues: compatibilityIssues as PiPackageResourceDetail["compatibilityIssues"],
      detectedApis: detectedApis as PiPackageResourceDetail["detectedApis"],
      adaptedApis: adaptedApis as PiPackageResourceDetail["adaptedApis"],
      unsupportedApis: unsupportedApis as PiPackageResourceDetail["unsupportedApis"]
    };
  });
}

function isStoredPackageRelativePath(value: string): boolean {
  return value.length > 0 && value.length <= 2_048 && value === value.trim() && !value.includes("\\") && !value.startsWith("/")
    && !/^[A-Za-z]:/u.test(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function validateStoredRuntimeRequirements(value: readonly PiPackageRuntimeRequirement[]): readonly PiPackageRuntimeRequirement[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("Stored runtime requirements are malformed.");
  return value.map((requirement) => {
    if (
      !requirement || typeof requirement !== "object" || typeof requirement.packageName !== "string"
      || requirement.packageName.length === 0 || requirement.packageName.length > 256
      || typeof requirement.range !== "string" || requirement.range.length === 0 || requirement.range.length > 256
      || !(requirement.compatible === true || requirement.compatible === false || requirement.compatible === null)
      || requirement.currentVersion !== undefined && (typeof requirement.currentVersion !== "string" || requirement.currentVersion.length > 128)
    ) throw new Error("Stored runtime requirement is malformed.");
    return { ...requirement };
  });
}

function validateStoredWarnings(value: readonly PiPackageWarning[]): readonly PiPackageWarning[] {
  return validateStringEnumList(value, new Set(["no-resources", "inspection-failed", "inspection-limit", "lifecycle-scripts-disabled"]), "package warning") as PiPackageWarning[];
}

function validateStoredLifecycleScripts(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length > 16 || value.some((item) => typeof item !== "string" || !/^[A-Za-z][A-Za-z0-9:_-]{0,63}$/u.test(item))) {
    throw new Error("Stored disabled lifecycle scripts are malformed.");
  }
  return [...value];
}

function validateStringEnumList(value: readonly string[], allowed: ReadonlySet<string>, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 128 || value.some((item) => typeof item !== "string" || !allowed.has(item))) {
    throw new Error(`Stored ${label} list is malformed.`);
  }
  return [...new Set(value)];
}

function validateStoredResource(value: StoredResource): StoredResource {
  if (!value || typeof value !== "object") throw new Error("Stored Pi resource is malformed.");
  const stored = value as StoredResource & { readonly source?: StoredResourceSource };
  validateResourceId(stored.id);
  validateKind(stored.kind);
  validateScope(stored.scope);
  validateState(stored.state);
  if (!/^\d+$/u.test(stored.versionNumber) || !Number.isSafeInteger(stored.updatedAt)) throw new Error("Stored Pi resource version is malformed.");
  if (stored.source === undefined) throw new Error("Stored Pi resource source is missing.");
  const source = stored.source.kind === "extension_source"
    ? validateStoredExtensionSourcePackage(stored.source)
    : stored.source.kind === "skill_market"
      ? validateStoredSkillMarketSource(stored.source)
      : normalizePiPackageSource(stored.source);
  if (!sameFlatRecord(source, stored.source)) throw new Error("Stored Pi resource source is not canonical.");
  if (source.kind !== "local" && source.kind !== "skill_market" && stored.kind !== "package") {
    throw new Error("Only package resources may use managed package acquisition.");
  }
  if (source.kind === "skill_market" && stored.kind !== "skill") throw new Error("Skill market provenance may only own a Skill Resource.");
  let canonicalPath: string | undefined;
  if (source.kind === "local" || source.kind === "skill_market" && stored.scope === "project") {
    canonicalPath = normalizedAbsolute(stored.canonicalPath!, "Stored canonical resource path");
  } else if (stored.canonicalPath !== undefined) {
    throw new Error("Stored remote resource contains a local canonical path.");
  }
  if (stored.installedPath !== undefined) normalizedAbsolute(stored.installedPath, "Stored installed resource path");
  if (stored.workspaceRoot !== undefined) normalizedAbsolute(stored.workspaceRoot, "Stored project workspace root");
  if (stored.scope === "project" && (stored.targetId === undefined || stored.workspaceRoot === undefined)) {
    throw new Error("Stored project resource is missing its Target trust boundary.");
  }
  if (stored.scope !== "project" && (stored.targetId !== undefined || stored.workspaceRoot !== undefined)) {
    throw new Error("Stored non-project resource crosses a Target trust boundary.");
  }
  if (source.kind === "skill_market" && (
    stored.scope === "project" && stored.installedPath !== undefined
    || stored.scope !== "project" && stored.scope !== "global"
  )) throw new Error("Stored Skill market Resource has an invalid install scope.");
  const sourceIdentity = source.kind === "extension_source"
    ? extensionSourcePackageIdentity(source)
    : source.kind === "skill_market"
      ? skillMarketSourceIdentity(source)
    : stored.kind === "package"
      ? piPackageSourceIdentity(source)
    : `${stored.kind}:${pathIdentity(canonicalPath!)}`;
  if (stored.sourceKind !== source.kind || stored.sourceIdentity !== sourceIdentity) {
    throw new Error("Stored Pi resource source identity is malformed.");
  }
  const sourceDisplay = source.kind === "local"
    ? basename(canonicalPath!)
    : source.kind === "extension_source"
      ? source.sourceDisplay
      : source.kind === "skill_market"
        ? skillMarketSourceDisplay(source)
      : piPackageSourceDisplay(source);
  const canonicalPathFingerprint = source.kind === "local"
    ? pathFingerprint(canonicalPath!)
    : source.kind === "extension_source"
      ? extensionSourcePackageFingerprint(source)
      : source.kind === "skill_market"
        ? stored.scope === "project" ? pathFingerprint(canonicalPath!) : skillMarketSourceFingerprint(source)
      : `sha256:${createHash("sha256").update(sourceIdentity).digest("hex")}`;
  if (stored.sourceDisplay !== sourceDisplay || stored.canonicalPathFingerprint !== canonicalPathFingerprint) {
    throw new Error("Stored Pi resource source metadata is malformed.");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(stored.discoveredRevision)) {
    throw new Error("Stored Pi resource discovery fingerprint is malformed.");
  }
  if (
    typeof stored.symbolicLinkDetected !== "boolean"
    || typeof stored.specialFileDetected !== "boolean"
    || typeof stored.enabled !== "boolean"
  ) {
    throw new Error("Stored Pi resource flags are malformed.");
  }
  const storedCompatibility = validateStoredCompatibility(stored);
  let pendingUpdate: StoredResourceUpdateIntent | undefined;
  if (stored.pendingUpdate !== undefined) {
    if (source.kind === "extension_source" || source.kind === "skill_market") {
      throw new Error("Stored source-owned resources cannot contain a generic update intent.");
    }
    if (!stored.pendingUpdate || typeof stored.pendingUpdate !== "object") {
      throw new Error("Stored resource update intent is malformed.");
    }
    const pendingSource = normalizePiPackageSource(stored.pendingUpdate.source);
    if (!sameFlatRecord(pendingSource, stored.pendingUpdate.source)) {
      throw new Error("Stored resource update source is not canonical.");
    }
    if (stored.kind !== "package" && pendingSource.kind !== "local") {
      throw new Error("Only package update intents may use npm or git acquisition.");
    }
    let pendingCanonicalPath: string | undefined;
    if (pendingSource.kind === "local") {
      pendingCanonicalPath = normalizedAbsolute(stored.pendingUpdate.canonicalPath!, "Stored update canonical resource path");
      if (!samePath(pendingCanonicalPath, pendingSource.path)) {
        throw new Error("Stored resource update path is not canonical.");
      }
    } else if (stored.pendingUpdate.canonicalPath !== undefined) {
      throw new Error("Stored remote resource update contains a local canonical path.");
    }
    const pendingSourceIdentity = stored.kind === "package"
      ? piPackageSourceIdentity(pendingSource)
      : `${stored.kind}:${pathIdentity(pendingCanonicalPath!)}`;
    if (pendingSourceIdentity !== sourceIdentity) {
      throw new Error("Stored resource update intent changes resource identity.");
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(stored.pendingUpdate.discoveredRevision)) {
      throw new Error("Stored resource update fingerprint is malformed.");
    }
    pendingUpdate = {
      source: pendingSource,
      ...(pendingCanonicalPath === undefined ? {} : { canonicalPath: pendingCanonicalPath }),
      discoveredRevision: stored.pendingUpdate.discoveredRevision,
      name: nonBlank(stored.pendingUpdate.name, "Stored resource update name"),
      ...(stored.pendingUpdate.version === undefined ? {} : { version: boundedVersion(stored.pendingUpdate.version) })
    };
  }
  const extensionApprovedRevision = stored.extensionApprovedRevision;
  if (extensionApprovedRevision !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(extensionApprovedRevision)) {
    throw new Error("Stored extension approval fingerprint is malformed.");
  }
  const packageIdentity = stored.packageIdentity === undefined
    ? undefined
    : boundedPackageIdentity(stored.packageIdentity);
  if (stored.kind === "package" && stored.installedPath !== undefined && packageIdentity === undefined) {
    throw new Error("Stored installed package Resource is missing its package identity.");
  }
  const {
    source: _source,
    sourceKind: _sourceKind,
    sourceIdentity: _sourceIdentity,
    sourceDisplay: _sourceDisplay,
    canonicalPathFingerprint: _canonicalPathFingerprint,
    canonicalPath: _canonicalPath,
    extensionApprovedRevision: _extensionApprovedRevision,
    pendingUpdate: _pendingUpdate,
    error: _error,
    ...base
  } = stored;
  return {
    ...base,
    source,
    sourceKind: source.kind,
    sourceIdentity,
    sourceDisplay,
    canonicalPathFingerprint,
    ...storedCompatibility,
    ...(extensionApprovedRevision === undefined ? {} : { extensionApprovedRevision }),
    ...(pendingUpdate === undefined ? {} : { pendingUpdate }),
    ...(canonicalPath === undefined ? {} : { canonicalPath }),
    ...(stored.version === undefined ? {} : { version: boundedVersion(stored.version) }),
    ...(packageIdentity === undefined ? {} : { packageIdentity }),
    ...(stored.error === undefined ? {} : { error: redactSecrets(stored.error).slice(0, 2_048) })
  };
}

function validateStoredExtensionSourcePackage(value: StoredExtensionSourcePackage): StoredExtensionSourcePackage {
  if (!value || typeof value !== "object" || value.kind !== "extension_source") {
    throw new Error("Stored Extension Source provenance is malformed.");
  }
  const sourceRevision = value.sourceRevision;
  if (!/^[1-9]\d*$/u.test(sourceRevision)) throw new Error("Stored Extension Source revision is malformed.");
  return {
    kind: "extension_source",
    sourceId: normalizedExtensionSourceId(value.sourceId),
    sourceRevision,
    sourceIdentity: nonBlank(value.sourceIdentity, "Stored Extension source identity"),
    sourceDisplay: nonBlank(value.sourceDisplay, "Stored Extension source display"),
    packageRelativePath: normalizeExtensionPackagePath(value.packageRelativePath),
    packageContentRevision: normalizedContentRevision(value.packageContentRevision, "Stored Extension source package revision")
  };
}

function normalizeStoredSkillMarketSource(
  value: Pick<PiMarketSkillSourceInput, "sourceId" | "sourceRevision" | "entryId" | "entryRevision" | "entryContentRevision" | "sourceName" | "slug"> & { readonly relativeParent?: string },
  installedContentRevision = value.entryContentRevision
): StoredSkillMarketSource {
  const sourceName = nonBlank(value.sourceName, "Skill market source name");
  if (sourceName.length > 128) throw new Error("Skill market source name is too long.");
  return {
    kind: "skill_market",
    sourceId: normalizedMarketSourceId(value.sourceId),
    sourceRevision: normalizedDecimalRevision(value.sourceRevision, "Skill market source revision"),
    entryId: normalizedMarketEntryId(value.entryId),
    entryRevision: normalizedDecimalRevision(value.entryRevision, "Skill market entry revision"),
    entryContentRevision: normalizedContentRevision(value.entryContentRevision, "Skill market entry content revision"),
    installedContentRevision: normalizedContentRevision(installedContentRevision, "Installed market Skill content revision"),
    sourceName,
    slug: portableSkillName(value.slug),
    ...(value.relativeParent === undefined ? {} : { relativeParent: portableProjectSkillParent(value.relativeParent) })
  };
}

function validateStoredSkillMarketSource(value: StoredSkillMarketSource): StoredSkillMarketSource {
  if (!value || typeof value !== "object" || value.kind !== "skill_market") {
    throw new Error("Stored Skill market provenance is malformed.");
  }
  const normalized = normalizeStoredSkillMarketSource({
    sourceId: value.sourceId,
    sourceRevision: BigInt(value.sourceRevision),
    entryId: value.entryId,
    entryRevision: BigInt(value.entryRevision),
    entryContentRevision: value.entryContentRevision,
    sourceName: value.sourceName,
    slug: value.slug,
    ...(value.relativeParent === undefined ? {} : { relativeParent: value.relativeParent })
  }, value.installedContentRevision);
  if (!sameFlatRecord(normalized, value)) throw new Error("Stored Skill market provenance is not canonical.");
  return normalized;
}

function normalizedMarketSourceId(value: string): string {
  const id = nonBlank(value, "Skill market source ID");
  if (!/^skill_market_source_[a-f0-9]{32}$/u.test(id)) throw new Error("Skill market source ID is invalid.");
  return id;
}

function normalizedMarketEntryId(value: string): string {
  const id = nonBlank(value, "Skill market entry ID");
  if (!/^skill_market_entry_[a-f0-9]{32}$/u.test(id)) throw new Error("Skill market entry ID is invalid.");
  return id;
}

function skillMarketSourceIdentity(source: StoredSkillMarketSource): string {
  return `skill-market:${createHash("sha256").update(`${source.sourceId}\0${source.entryId}`).digest("hex")}`;
}

function skillMarketSourceDisplay(source: StoredSkillMarketSource): string {
  return `${source.sourceName} · ${source.slug}`;
}

function skillMarketSourceFingerprint(source: StoredSkillMarketSource): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(source)).digest("hex")}`;
}

function sameFlatRecord(left: object, right: object): boolean {
  const entries = (value: object): readonly (readonly [string, unknown])[] => Object.entries(value)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey, "en"));
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
}

function omitInstalledPath(record: StoredResource): Omit<StoredResource, "installedPath"> {
  const { installedPath: _installedPath, ...rest } = record;
  return rest;
}

function groupFor(kind: PiResourceKind): string {
  switch (kind) {
    case "extension": return "extensions";
    case "skill": return "skills";
    case "prompt": return "prompts";
    case "theme": return "themes";
    case "package": return "packages";
  }
}

function resourceOwnerPath(managedRoot: string, record: Pick<StoredResource, "id" | "kind">): string {
  return join(managedRoot, groupFor(record.kind), safeId(record.id));
}

function installedPayloadName(record: StoredResource): string {
  return safePayloadName(record.source.kind === "local" ? basename(record.canonicalPath!) : record.name);
}

function installedGenerationContainer(managedRoot: string, record: StoredResource): string {
  if (record.installedPath === undefined) throw new Error("Resource has no installed payload.");
  const owner = resourceOwnerPath(managedRoot, record);
  const container = dirname(record.installedPath);
  const generations = join(owner, RESOURCE_GENERATIONS_DIRECTORY);
  if (
    !samePath(dirname(container), generations)
    || !RESOURCE_GENERATION_PATTERN.test(basename(container))
  ) throw new Error("Installed resource path does not match its managed generation boundary.");
  return container;
}

function assertExpectedInstalledLocation(managedRoot: string, record: StoredResource): void {
  if (record.installedPath === undefined) throw new Error("Resource has no installed payload.");
  void installedGenerationContainer(managedRoot, record);
  if (basename(record.installedPath) !== installedPayloadName(record)) {
    throw new Error("Installed resource path does not match its managed ownership boundary.");
  }
}

function safeId(id: string): string {
  const readable = id.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 96);
  const suffix = createHash("sha256").update(id).digest("hex").slice(0, 12);
  return `${readable}-${suffix}`;
}

function safePayloadName(name: string): string {
  const value = name.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").trim();
  return value === "" || value === "." || value === ".." || value === RESOURCE_GENERATIONS_DIRECTORY ? "resource" : value;
}

function portableSkillName(value: string): string {
  const name = nonBlank(value, "Skill name");
  if (name.length > 100 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
    throw new Error("Skill name must use lowercase letters, numbers, and single hyphens.");
  }
  return name;
}

function validateResourceId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id)) throw new Error("Pi resource ID is invalid.");
}

function validateKind(kind: PiResourceKind): void {
  if (!(["extension", "skill", "prompt", "theme", "package"] as const).includes(kind)) throw new Error("Pi resource kind is invalid.");
}

function projectResourceKindSet(kinds: readonly PiResourceKind[]): ReadonlySet<PiResourceKind> {
  if (!Array.isArray(kinds) || kinds.length === 0) {
    throw new Error("Project resource discovery requires at least one Backend-advertised resource kind.");
  }
  const result = new Set<PiResourceKind>();
  for (const kind of kinds) {
    validateKind(kind);
    result.add(kind);
  }
  return result;
}

function validateScope(scope: PiResourceScope): void {
  if (!(["user", "global", "project", "managed"] as const).includes(scope)) throw new Error("Pi resource scope is invalid.");
}

function validateState(state: PiResourceState): void {
  if (!("discovered awaiting_approval approved installing installed loaded disabled update_available error removed".split(" ") as PiResourceState[]).includes(state)) {
    throw new Error("Pi resource state is invalid.");
  }
}

function normalizedAbsolute(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) throw new Error(`${label} must be a normalized absolute path.`);
  return path;
}

async function assertCanonicalDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a regular directory.`);
  const canonical = await realpath(path);
  if (!samePath(canonical, path)) throw new Error(`${label} contains a path alias or junction.`);
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const normalized = normalizedAbsolute(path, label);
  const info = await lstat(normalized);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a regular directory.`);
  return realpath(normalized);
}

async function assertContainedRegularDirectory(root: string, path: string, label: string): Promise<void> {
  await assertContainedPath(root, path, label);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a regular directory.`);
}

async function assertContainedPath(root: string, path: string, label: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`${label} is a symlink or junction.`);
  const canonical = await realpath(path);
  assertWithin(canonicalRoot, canonical, label);
}

async function assertContainedPathIfPresent(root: string, path: string, label: string): Promise<boolean> {
  if (await optionalLstat(path) === undefined) return false;
  try {
    await assertContainedPath(root, path, label);
    return true;
  } catch (error) {
    if (await optionalLstat(path) === undefined) return false;
    throw error;
  }
}

function assertWithin(root: string, candidate: string, label: string): void {
  const suffix = relative(root, candidate);
  if (suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))) return;
  throw new Error(`${label} escapes its approved root.`);
}

function pathFingerprint(path: string): string {
  return `sha256:${createHash("sha256").update(process.platform === "win32" ? path.toLowerCase() : path).digest("hex")}`;
}

function validateEntryName(name: string): void {
  if (name === "." || name === ".." || name.includes("\0") || name.includes("/") || name.includes("\\")) throw new Error("Resource contains an invalid path component.");
}

function sameIdentity(left: { readonly dev: number; readonly ino: number }, right: { readonly dev: number; readonly ino: number }): boolean {
  return left.dev === right.dev && (left.ino === 0 || right.ino === 0 || left.ino === right.ino);
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathIdentity(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isDirectProjectResource(record: StoredResource): record is StoredResource & {
  readonly source: Extract<StoredResourceSource, { readonly kind: "local" | "skill_market" }>;
  readonly canonicalPath: string;
} {
  return record.scope === "project"
    && (record.source.kind === "local" || record.source.kind === "skill_market")
    && record.canonicalPath !== undefined;
}

function boundedVersion(value: string): string {
  const version = nonBlank(value, "Resource version");
  if (version.length > 128) throw new Error("Resource version is too long.");
  return version;
}

function boundedPackageIdentity(value: string): string {
  const identity = nonBlank(value, "Resource package identity");
  if (identity.length > 214) throw new Error("Resource package identity is too long.");
  return identity;
}

function nonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.includes("\0")) throw new Error(`${label} must not be blank.`);
  return normalized;
}

function requiredJournalString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`Project Skill transaction journal ${key} is malformed.`);
  }
  return value;
}

function journalVersion(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = requiredJournalString(record, key);
  if (!/^\d+$/u.test(value)) throw new Error(`Project Skill transaction journal ${key} is malformed.`);
  return BigInt(value).toString(10);
}

function nullableJournalVersion(record: Readonly<Record<string, unknown>>, key: string): string | null {
  if (record[key] === null) return null;
  return journalVersion(record, key);
}

function nullableJournalRevision(record: Readonly<Record<string, unknown>>, key: string): string | null {
  if (record[key] === null) return null;
  return normalizedContentRevision(requiredJournalString(record, key), `Project Skill transaction ${key}`);
}

async function removeOwnedPath(root: string, path: string, label: string): Promise<void> {
  normalizedAbsolute(root, `${label} root`);
  normalizedAbsolute(path, label);
  assertWithin(root, path, label);
  const info = await optionalLstat(path);
  if (info === undefined) return;
  if (info.isSymbolicLink()) {
    await rm(path, { force: true });
    return;
  }
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(path);
  assertWithin(canonicalRoot, canonical, label);
  await rm(path, { recursive: info.isDirectory(), force: true });
}

async function directoryIsEmpty(path: string): Promise<boolean> {
  const info = await optionalLstat(path);
  if (info === undefined) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  return (await readdir(path)).length === 0;
}

interface ProjectResourceCandidate {
  readonly kind: PiResourceKind;
  readonly sourcePath: string;
  readonly name: string;
}

async function discoverCanonicalProjectCandidates(
  workspaceRoot: string,
  maximumCandidates: number,
  kinds: ReadonlySet<PiResourceKind>,
  adapterKind: string
): Promise<readonly ProjectResourceCandidate[]> {
  const candidates: ProjectResourceCandidate[] = [];
  const push = (kind: PiResourceKind, sourcePath: string, name = basename(sourcePath)): void => {
    if (candidates.length >= maximumCandidates) throw new Error("Project resource discovery exceeds the configured candidate limit.");
    candidates.push({ kind, sourcePath, name });
  };

  if (adapterKind === "claude-agent-sdk-stdio") {
    const claudeRoot = join(workspaceRoot, ".claude");
    await assertOptionalSafeDirectory(workspaceRoot, claudeRoot, "Claude project resource root");
    if (kinds.has("skill")) {
      for (const sourcePath of await discoverClaudeSkillEntries(workspaceRoot, join(claudeRoot, "skills"))) {
        push("skill", sourcePath);
      }
    }
    if (kinds.has("prompt")) {
      for (const sourcePath of await discoverClaudePromptEntries(workspaceRoot, join(claudeRoot, "commands"))) {
        push("prompt", sourcePath, basename(sourcePath, extname(sourcePath)));
      }
    }
    return candidates.sort((left, right) => left.kind.localeCompare(right.kind, "en") || left.sourcePath.localeCompare(right.sourcePath, "en"));
  }
  if (adapterKind !== "pi") throw new Error(`Backend adapter does not define project resource discovery: ${adapterKind}`);

  const piRoot = join(workspaceRoot, ".pi");
  const agentsRoot = join(workspaceRoot, ".agents");
  await assertOptionalSafeDirectory(workspaceRoot, piRoot, "Project resource root");

  if (kinds.has("extension")) {
    for (const sourcePath of await discoverExtensionEntries(workspaceRoot, join(piRoot, "extensions"))) push("extension", sourcePath);
  }
  if (kinds.has("skill")) {
    await assertOptionalSafeDirectory(workspaceRoot, agentsRoot, "Project resource root");
    for (const sourcePath of await discoverSkillEntries(workspaceRoot, join(piRoot, "skills"))) push("skill", sourcePath);
    for (const sourcePath of await discoverSkillEntries(workspaceRoot, join(agentsRoot, "skills"))) push("skill", sourcePath);
  }
  if (kinds.has("prompt")) {
    for (const sourcePath of await discoverPromptEntries(workspaceRoot, join(piRoot, "prompts"))) push("prompt", sourcePath);
  }
  if (kinds.has("theme")) {
    for (const sourcePath of await discoverThemeEntries(workspaceRoot, join(piRoot, "themes"))) push("theme", sourcePath);
  }
  if (kinds.has("package")) {
    for (const sourcePath of await discoverDirectPackageEntries(workspaceRoot, join(piRoot, "packages"))) push("package", sourcePath);
    for (const sourcePath of await discoverNpmPackageEntries(workspaceRoot, join(piRoot, "npm", "node_modules"))) push("package", sourcePath);
    for (const sourcePath of await discoverGitPackageEntries(workspaceRoot, join(piRoot, "git"), maximumCandidates - candidates.length)) push("package", sourcePath);
  }

  return candidates
    .sort((left, right) => left.kind.localeCompare(right.kind, "en") || left.sourcePath.localeCompare(right.sourcePath, "en"));
}

async function discoverExtensionEntries(workspaceRoot: string, root: string): Promise<readonly string[]> {
  const entries = await safeOptionalDirectoryEntries(workspaceRoot, root, "Project extension directory");
  const candidates: string[] = [];
  for (const entry of entries) {
    if (entry.info.isFile() && /\.(?:cjs|js|mjs|ts)$/iu.test(entry.name)) candidates.push(entry.canonicalPath);
    else if (entry.info.isDirectory() && await hasExtensionEntrypoint(workspaceRoot, entry.canonicalPath)) candidates.push(entry.canonicalPath);
  }
  return candidates;
}

async function hasExtensionEntrypoint(workspaceRoot: string, directory: string): Promise<boolean> {
  for (const name of ["index.ts", "index.js", "index.mjs", "index.cjs", "package.json"]) {
    const candidate = join(directory, name);
    const info = await optionalLstat(candidate);
    if (info === undefined) continue;
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Project extension entry contains a symlink or special file.");
    const canonical = await realpath(candidate);
    assertWithin(workspaceRoot, canonical, "Project extension entry");
    return true;
  }
  return false;
}

async function discoverSkillEntries(workspaceRoot: string, root: string): Promise<readonly string[]> {
  const entries = await safeOptionalDirectoryEntries(workspaceRoot, root, "Project skill directory");
  const candidates: string[] = [];
  if (await hasRegularContainedFile(workspaceRoot, join(root, "SKILL.md"), "Project skill manifest")) candidates.push(await realpath(root));
  for (const entry of entries) {
    if (!entry.info.isDirectory()) continue;
    if (await hasRegularContainedFile(workspaceRoot, join(entry.canonicalPath, "SKILL.md"), "Project skill manifest")) candidates.push(entry.canonicalPath);
  }
  return candidates;
}

async function discoverClaudeSkillEntries(workspaceRoot: string, root: string): Promise<readonly string[]> {
  const entries = await safeOptionalDirectoryEntries(workspaceRoot, root, "Claude project skill directory", true);
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.info.isDirectory()) continue;
    if (await hasRegularContainedFile(workspaceRoot, join(entry.canonicalPath, "SKILL.md"), "Claude project skill manifest")) {
      candidates.push(entry.canonicalPath);
    }
  }
  return candidates;
}

async function discoverClaudePromptEntries(workspaceRoot: string, root: string): Promise<readonly string[]> {
  return (await safeOptionalDirectoryEntries(workspaceRoot, root, "Claude project command directory", true))
    .filter((entry) => entry.info.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.canonicalPath);
}

async function discoverPromptEntries(workspaceRoot: string, root: string): Promise<readonly string[]> {
  return (await safeOptionalDirectoryEntries(workspaceRoot, root, "Project prompt directory"))
    .filter((entry) => entry.info.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.canonicalPath);
}

async function discoverThemeEntries(workspaceRoot: string, root: string): Promise<readonly string[]> {
  return (await safeOptionalDirectoryEntries(workspaceRoot, root, "Project theme directory"))
    .filter((entry) => entry.info.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => entry.canonicalPath);
}

async function discoverDirectPackageEntries(workspaceRoot: string, root: string): Promise<readonly string[]> {
  return (await safeOptionalDirectoryEntries(workspaceRoot, root, "Project package directory"))
    .filter((entry) => entry.info.isDirectory())
    .map((entry) => entry.canonicalPath);
}

async function discoverNpmPackageEntries(workspaceRoot: string, root: string): Promise<readonly string[]> {
  const entries = await safeOptionalDirectoryEntries(workspaceRoot, root, "Project npm package directory");
  const packages: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".bin") continue;
    if (!entry.info.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      for (const scoped of await safeOptionalDirectoryEntries(workspaceRoot, entry.canonicalPath, "Project scoped npm package directory")) {
        if (scoped.info.isDirectory()) packages.push(scoped.canonicalPath);
      }
    } else packages.push(entry.canonicalPath);
  }
  return packages;
}

async function discoverGitPackageEntries(workspaceRoot: string, root: string, maximumCandidates: number): Promise<readonly string[]> {
  if (maximumCandidates < 1) return [];
  const found: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (found.length >= maximumCandidates) throw new Error("Project package discovery exceeds the configured candidate limit.");
    const entries = await safeOptionalDirectoryEntries(workspaceRoot, directory, "Project git package directory");
    if (entries.length === 0) return;
    if (entries.some((entry) => entry.name === "package.json" && entry.info.isFile())) {
      found.push(await realpath(directory));
      return;
    }
    if (depth >= 6) return;
    for (const entry of entries) {
      if (!entry.info.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
      await visit(entry.canonicalPath, depth + 1);
    }
  };
  if (await optionalLstat(root) !== undefined) await visit(root, 0);
  return found;
}

interface SafeDirectoryEntry {
  readonly name: string;
  readonly canonicalPath: string;
  readonly info: Awaited<ReturnType<typeof lstat>>;
}

async function safeOptionalDirectoryEntries(
  workspaceRoot: string,
  root: string,
  label: string,
  skipHidden = false
): Promise<readonly SafeDirectoryEntry[]> {
  const info = await optionalLstat(root);
  if (info === undefined) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a regular directory.`);
  const canonicalRoot = await realpath(root);
  assertWithin(workspaceRoot, canonicalRoot, label);
  const entries = await readdir(canonicalRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const result: SafeDirectoryEntry[] = [];
  for (const entry of entries) {
    validateEntryName(entry.name);
    if (skipHidden && entry.name.startsWith(".")) continue;
    const path = join(canonicalRoot, entry.name);
    const child = await lstat(path);
    if (entry.isSymbolicLink() || child.isSymbolicLink() || (!child.isDirectory() && !child.isFile())) {
      throw new Error(`${label} contains a symlink, junction, or special file.`);
    }
    const canonicalPath = await realpath(path);
    assertWithin(workspaceRoot, canonicalPath, label);
    result.push({ name: entry.name, canonicalPath, info: child });
  }
  return result;
}

async function assertOptionalSafeDirectory(workspaceRoot: string, root: string, label: string): Promise<void> {
  const info = await optionalLstat(root);
  if (info === undefined) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a regular directory.`);
  assertWithin(workspaceRoot, await realpath(root), label);
}

async function hasRegularContainedFile(workspaceRoot: string, path: string, label: string): Promise<boolean> {
  const info = await optionalLstat(path);
  if (info === undefined) return false;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
  assertWithin(workspaceRoot, await realpath(path), label);
  return true;
}

async function optionalLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try { return await lstat(path); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function stableDiscoveredResourceId(backendId: string, targetId: string, kind: PiResourceKind, canonicalPath: string): string {
  const identity = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
  return `resource_project_${createHash("sha256").update(`${backendId}\0${targetId}\0${kind}\0${identity}`).digest("hex").slice(0, 32)}`;
}

function assertTargetNotDeleted(metadata: unknown): void {
  if (
    typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
    && (metadata as Record<string, unknown>)["deletedAt"] !== undefined
  ) throw new Error("Project resource is fenced because its Target is deleted.");
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  ) && typeof (value as { readonly then?: unknown }).then === "function";
}
