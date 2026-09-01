import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

export type PiResourceKind = "extension" | "skill" | "prompt" | "theme" | "package";
export type PiResourceScope = "user" | "global" | "project" | "managed";
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
  readonly sourceKind: PiPackageSource["kind"];
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
}

interface StoredResource extends Omit<PiResourceDescriptor, "versionNumber"> {
  readonly versionNumber: string;
  readonly source: PiPackageSource;
  readonly canonicalPath?: string;
  readonly workspaceRoot?: string;
  readonly installedPath?: string;
  readonly extensionApprovedRevision?: string;
}

interface StoredResourceCatalog {
  readonly format: 1;
  readonly records: readonly StoredResource[];
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

export interface PiRuntimeResourceSnapshot {
  readonly extensions: readonly string[];
  readonly skills: readonly string[];
  readonly prompts: readonly string[];
  readonly themes: readonly string[];
  readonly packages: readonly string[];
  readonly resources: readonly RuntimeResource[];
}

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
    this.#maximumBytes = options.maximumBytes ?? 256 * 1024 * 1024;
    this.#acquisition = options.acquisition ?? new DefaultPiPackageAcquisition();
    if (!Number.isSafeInteger(this.#maximumFiles) || this.#maximumFiles < 1) throw new RangeError("Resource file limit is invalid.");
    if (!Number.isSafeInteger(this.#maximumBytes) || this.#maximumBytes < 1) throw new RangeError("Resource byte limit is invalid.");
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.#managedRoot, { recursive: true, mode: 0o700 });
    await assertCanonicalDirectory(this.#managedRoot, "Managed resource root");
    await Promise.all(["extensions", "skills", "prompts", "themes", "packages", ".staging", ".trash"].map((name) => mkdir(join(this.#managedRoot, name), { recursive: true, mode: 0o700 })));
    for (const name of ["extensions", "skills", "prompts", "themes", "packages", ".staging", ".trash"]) {
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
    let compatibilityChanged = false;
    for (const [id, record] of this.#records) {
      const refreshed = await this.#refreshCompatibility(record);
      if (resourceCompatibilityIdentity(refreshed) !== resourceCompatibilityIdentity(record)) {
        this.#records.set(id, refreshed);
        compatibilityChanged = true;
      }
    }
    if (compatibilityChanged) this.#persist();
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
      .filter((item) => filter.backendId === undefined || item.backendId === filter.backendId)
      .filter((item) => filter.targetId === undefined || item.targetId === filter.targetId)
      .filter((item) => filter.kind === undefined || item.kind === filter.kind)
      .filter((item) => filter.state === undefined || item.state === filter.state)
      .sort((left, right) => left.name.localeCompare(right.name, "en") || left.id.localeCompare(right.id, "en"))
      .map(publicResource);
  }

  get(resourceId: string): PiResourceDescriptor {
    this.#assertInitialized();
    return publicResource(this.#require(resourceId));
  }

  async discover(input: DiscoverPiResourceInput): Promise<PiResourceDescriptor> {
    this.#assertInitialized();
    validateKind(input.kind);
    validateScope(input.scope);
    const source = normalizePiPackageSource(input.source);
    if (source.kind !== "local") throw new Error("Direct resources require a local acquisition source.");
    const inspection = await inspectResource(source.path, this.#maximumFiles, this.#maximumBytes);
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
    const now = this.#now();
    return this.#mutate(async () => {
      const previous = this.#records.get(id);
      if (previous !== undefined && (
        previous.backendId !== input.backendId ||
        previous.targetId !== input.targetId ||
        previous.kind !== input.kind ||
        previous.scope !== input.scope ||
        previous.canonicalPath === undefined || !samePath(previous.canonicalPath, inspection.canonicalPath)
      )) throw new Error("Pi resource ID is already bound to a different source.");
      if (
        previous !== undefined &&
        previous.state !== "removed" &&
        previous.backendId === input.backendId &&
        previous.targetId === input.targetId &&
        previous.kind === input.kind &&
        previous.scope === input.scope &&
        previous.canonicalPath !== undefined && samePath(previous.canonicalPath, inspection.canonicalPath) &&
        previous.discoveredRevision === inspection.revision
      ) return publicResource(previous);
      const changedInstalledResource = previous?.scope !== "project" && previous?.installedPath !== undefined;
      const {
        approvedAt: _approvedAt,
        approvedByConnectionId: _approvedBy,
        extensionApprovedRevision: _extensionApprovedRevision,
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
        name: nonBlank(input.name ?? basename(inspection.canonicalPath), "Resource name"),
        ...(input.version === undefined ? {} : { version: nonBlank(input.version, "Resource version") }),
        sourceKind: source.kind,
        sourceIdentity: input.kind === "package" ? piPackageSourceIdentity(source) : `${input.kind}:${pathIdentity(inspection.canonicalPath)}`,
        sourceDisplay: basename(inspection.canonicalPath),
        canonicalPathFingerprint: pathFingerprint(inspection.canonicalPath),
        symbolicLinkDetected: false,
        specialFileDetected: false,
        discoveredRevision: inspection.revision,
        ...compatibilityFields(compatibility, compatibility.extensionContentFingerprint !== undefined),
        state: changedInstalledResource ? "update_available" : "awaiting_approval",
        enabled: false,
        versionNumber: ((previous === undefined ? 0n : BigInt(previous.versionNumber)) + 1n).toString(10),
        updatedAt: now,
        source,
        canonicalPath: inspection.canonicalPath,
        ...(workspaceRoot === undefined ? {} : { workspaceRoot })
      };
      this.#records.set(id, record);
      this.#persistWithRollback(id, previous);
      return publicResource(record);
    });
  }

  /** Register a typed package intent without touching network or executing package code. */
  async discoverPackage(input: DiscoverPiPackageInput): Promise<PiResourceDescriptor> {
    this.#assertInitialized();
    validateScope(input.scope);
    const source = normalizePiPackageSource(input.source);
    if (source.kind === "local") {
      return this.discover({
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
    return this.#mutate(async () => {
      const previous = this.#records.get(id);
      if (previous !== undefined && (
        previous.backendId !== input.backendId || previous.targetId !== input.targetId ||
        previous.kind !== "package" || previous.scope !== input.scope ||
        previous.sourceIdentity !== sourceIdentity
      )) throw new Error("Pi resource ID is already bound to a different package identity.");
      if (
        previous !== undefined && previous.state !== "removed" &&
        previous.sourceIdentity === sourceIdentity &&
        piPackageSourceApprovalRevision(previous.source) === approvalRevision
      ) return publicResource(previous);
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
        name: nonBlank(input.name ?? piPackageSourceDisplay(source), "Resource name"),
        ...(input.version === undefined ? {} : { version: nonBlank(input.version, "Resource version") }),
        sourceKind: source.kind,
        sourceIdentity,
        sourceDisplay: piPackageSourceDisplay(source),
        canonicalPathFingerprint: `sha256:${createHash("sha256").update(sourceIdentity).digest("hex")}`,
        symbolicLinkDetected: false,
        specialFileDetected: false,
        discoveredRevision: approvalRevision,
        ...emptyCompatibilityFields(),
        state: previous?.installedPath === undefined ? "awaiting_approval" : "update_available",
        enabled: false,
        versionNumber: ((previous === undefined ? 0n : BigInt(previous.versionNumber)) + 1n).toString(10),
        updatedAt: now,
        source,
        ...(workspaceRoot === undefined ? {} : { workspaceRoot })
      };
      this.#records.set(id, record);
      this.#persistWithRollback(id, previous);
      return publicResource(record);
    });
  }

  /**
   * Discover conventional project-local Pi resources only after an owner has
   * trusted the durable Target and explicitly requested a scan. Discovery is
   * inert: no returned path is installed, enabled, or reported as loaded.
   */
  async discoverProjectResources(input: DiscoverProjectResourcesInput): Promise<readonly PiResourceDescriptor[]> {
    this.#assertInitialized();
    const backendId = nonBlank(input.backendId, "Backend ID");
    const targetId = nonBlank(input.targetId, "Target ID");
    const target = this.#store.getTarget(targetId).descriptor;
    if (target.backendId !== backendId) throw new Error("Target does not belong to the requested Backend.");
    if (!target.trusted) throw new Error("Project resources can only be discovered after the Target is trusted.");
    const workspaceRoot = await canonicalDirectory(target.workspaceRoot, "Project resource workspace");
    const candidates = await discoverCanonicalProjectCandidates(workspaceRoot, this.#maximumFiles);

    // Inspect every candidate before committing any catalog mutation. An
    // unsafe symlink/special file therefore fails the whole scan closed.
    await Promise.all(candidates.map((candidate) => inspectResource(candidate.sourcePath, this.#maximumFiles, this.#maximumBytes)));
    const discovered: PiResourceDescriptor[] = [];
    for (const candidate of candidates) {
      discovered.push(await this.discover({
        id: stableDiscoveredResourceId(backendId, targetId, candidate.kind, candidate.sourcePath),
        backendId,
        targetId,
        kind: candidate.kind,
        scope: "project",
        name: candidate.name,
        source: { kind: "local", path: candidate.sourcePath },
        workspaceRoot
      }));
    }
    return discovered;
  }

  async approve(resourceId: string, discoveredRevision: string, approvedByConnectionId: string): Promise<PiResourceDescriptor> {
    this.#assertInitialized();
    return this.#mutate(async () => {
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
        const inspection = await inspectResource(current.canonicalPath, this.#maximumFiles, this.#maximumBytes);
        if (current.workspaceRoot !== undefined) assertWithin(current.workspaceRoot, inspection.canonicalPath, "Project resource");
        if (inspection.revision !== discoveredRevision || !samePath(inspection.canonicalPath, current.canonicalPath)) {
          throw new Error("Resource changed after discovery and must be discovered again.");
        }
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
      this.#records.set(resourceId, updated);
      this.#persistWithRollback(resourceId, current);
      return publicResource(updated);
    });
  }

  async install(resourceId: string): Promise<PiResourceDescriptor> {
    this.#assertInitialized();
    return this.#mutate(() => this.#installLocked(resourceId));
  }

  async update(resourceId: string, input: UpdatePiResourceInput): Promise<PiResourceDescriptor> {
    this.#assertInitialized();
    return this.#mutate(async () => {
      const current = this.#require(resourceId);
      if (!(current.state === "installed" || current.state === "loaded" || current.state === "disabled" || current.state === "update_available")) {
        throw new Error("Only an installed resource can be updated.");
      }
      this.#assertStoredProjectTargetTrusted(current);
      if (input.source !== undefined && input.requestedVersion !== undefined) throw new Error("Typed resource acquisition and requested_version cannot both be set.");
      if (input.source !== undefined && input.source.kind !== "local" && current.kind !== "package") {
        throw new Error("Non-package resources require a local acquisition source.");
      }
      const requestedSource = input.source !== undefined
        ? normalizePiPackageSource(input.source)
        : piPackageSourceWithVersion(current.source, input.requestedVersion);
      let inspection: ResourceInspection | undefined;
      if (requestedSource.kind === "local") {
        inspection = await inspectResource(requestedSource.path, this.#maximumFiles, this.#maximumBytes);
        if (current.workspaceRoot !== undefined) assertWithin(current.workspaceRoot, inspection.canonicalPath, "Project resource");
      }
      const requestedIdentity = current.kind === "package"
        ? piPackageSourceIdentity(requestedSource)
        : `${current.kind}:${pathIdentity(inspection!.canonicalPath)}`;
      if (requestedIdentity !== current.sourceIdentity) {
        throw new Error("Resource update cannot change package identity; add it as a new resource.");
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
        error: _error,
        ...currentBase
      } = current;
      const sourceDisplay = piPackageSourceDisplay(requestedSource);
      const approved: StoredResource = {
        ...currentBase,
        source: requestedSource,
        sourceKind: requestedSource.kind,
        sourceDisplay,
        canonicalPathFingerprint: inspection === undefined
          ? `sha256:${createHash("sha256").update(current.sourceIdentity).digest("hex")}`
          : pathFingerprint(inspection.canonicalPath),
        discoveredRevision: inspection?.revision ?? piPackageSourceApprovalRevision(requestedSource),
        ...(compatibility === undefined
          ? emptyCompatibilityFields()
          : compatibilityFields(compatibility, false)),
        ...(compatibility?.extensionContentFingerprint === undefined
          ? {}
          : { extensionApprovedRevision: compatibility.extensionContentFingerprint }),
        ...(requestedSource.kind === "local" ? { canonicalPath: inspection!.canonicalPath } : {}),
        ...(input.requestedVersion === undefined ? {} : { version: nonBlank(input.requestedVersion, "Requested resource version") }),
        state: "approved",
        enabled: false,
        approvedAt: this.#now(),
        approvedByConnectionId: nonBlank(input.approvedByConnectionId, "Approving connection ID"),
        versionNumber: (BigInt(current.versionNumber) + 1n).toString(10),
        updatedAt: this.#now()
      };
      this.#records.set(resourceId, approved);
      this.#persistWithRollback(resourceId, current);
      if (isDirectProjectResource(approved)) return publicResource(approved);
      return this.#installLocked(resourceId);
    });
  }

  async setEnabled(resourceId: string, enabled: boolean): Promise<PiResourceDescriptor> {
    this.#assertInitialized();
    return this.#mutate(async () => {
      const current = this.#require(resourceId);
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
      this.#records.set(resourceId, updated);
      this.#persistWithRollback(resourceId, current);
      return publicResource(updated);
    });
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

  async remove(resourceId: string): Promise<PiResourceDescriptor> {
    this.#assertInitialized();
    return this.#mutate(async () => {
      const current = this.#require(resourceId);
      if (current.installedPath !== undefined) {
        assertExpectedInstalledLocation(this.#managedRoot, current);
        await assertContainedPath(this.#managedRoot, current.installedPath, "Installed resource");
        const container = installedContainer(current.installedPath);
        await assertContainedPath(this.#managedRoot, container, "Installed resource container");
        const trash = join(this.#managedRoot, ".trash", `${safeId(current.id)}-${randomUUID()}`);
        if (await exists(container)) {
          await rename(container, trash);
          await rm(trash, { recursive: true, force: true });
        }
      }
      const updated: StoredResource = {
        ...omitInstalledPath(current),
        state: "removed",
        enabled: false,
        versionNumber: (BigInt(current.versionNumber) + 1n).toString(10),
        updatedAt: this.#now()
      };
      this.#records.set(resourceId, updated);
      this.#persistWithRollback(resourceId, current);
      return publicResource(updated);
    });
  }

  /** Callback passed directly to PiAdapterOptions.approveProjectSkill. */
  async approveProjectSkill(candidate: ProjectSkillCandidate): Promise<boolean> {
    this.#assertInitialized();
    const inspection = await inspectResource(candidate.sourcePath, this.#maximumFiles, this.#maximumBytes).catch(() => undefined);
    if (inspection === undefined) return false;
    for (const record of this.#records.values()) {
      try { this.#assertStoredProjectTargetTrusted(record); } catch { continue; }
      if (
        record.kind === "skill" &&
        record.scope === "project" &&
        record.source.kind === "local" &&
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

  async #runtimeSnapshot(backendId: string, targetId: string | undefined, targetOnly: boolean): Promise<PiRuntimeResourceSnapshot> {
    this.#assertInitialized();
    const paths: Record<PiResourceKind, string[]> = { extension: [], skill: [], prompt: [], theme: [], package: [] };
    const resources: RuntimeResource[] = [];
    for (const record of this.#records.values()) {
      if (record.backendId !== backendId || !record.enabled || record.state === "removed" || record.state === "error") continue;
      if (record.kind === "theme") continue;
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
        ...(record.version === undefined ? {} : { detail: `version ${record.version}` })
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

  async #installLocked(resourceId: string): Promise<PiResourceDescriptor> {
    const current = this.#require(resourceId);
    if (isDirectProjectResource(current)) throw new Error("Project-local resources are snapshotted by the Pi adapter and are not installed globally.");
    if (current.state !== "approved") throw new Error("Resource must be approved before installation.");
    if (current.approvedAt === undefined || current.approvedByConnectionId === undefined) {
      throw new Error("Resource installation requires an explicit owner approval.");
    }
    this.#assertStoredProjectTargetTrusted(current);
    if (current.source.kind === "local") await this.#assertSourceUnchanged(current);
    else if (current.kind !== "package" || current.discoveredRevision !== piPackageSourceApprovalRevision(current.source)) {
      throw new Error("Package acquisition approval is stale.");
    }
    const group = join(this.#managedRoot, groupFor(current.kind));
    const containerName = safeId(current.id);
    const finalContainer = join(group, containerName);
    const stage = join(this.#managedRoot, ".staging", `${containerName}-${randomUUID()}`);
    const backup = join(this.#managedRoot, ".trash", `${containerName}-${randomUUID()}`);
    await mkdir(stage, { recursive: false, mode: 0o700 });
    const acquisitionRoot = join(stage, ".acquisition");
    let acquiredVersion: string | undefined;
    let sourceRoot: string;
    let sourceInspection: ResourceInspection;
    try {
      if (current.source.kind === "local") {
        if (current.canonicalPath === undefined) throw new Error("Local resource is missing its canonical source path.");
        sourceRoot = current.canonicalPath;
        sourceInspection = await inspectResource(sourceRoot, this.#maximumFiles, this.#maximumBytes);
      } else {
        const acquired = await this.#acquisition.acquire({
          source: current.source,
          destinationRoot: acquisitionRoot,
          action: current.installedPath === undefined ? "install" : "update"
        });
        sourceRoot = normalizedAbsolute(acquired.rootPath, "Acquired package root");
        assertWithin(acquisitionRoot, sourceRoot, "Acquired package root");
        sourceInspection = await inspectResource(sourceRoot, this.#maximumFiles, this.#maximumBytes);
        acquiredVersion = acquired.version === undefined ? undefined : boundedVersion(acquired.version);
      }
    } catch (error) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const sourceInfo = await lstat(sourceRoot);
    if (current.kind === "package" && !sourceInfo.isDirectory()) throw new Error("Package acquisition must produce a regular directory.");
    const payloadName = safePayloadName(current.source.kind === "local" ? basename(sourceRoot) : current.name);
    const stagedPayload = join(stage, payloadName);
    let backedUp = false;
    try {
      if (sourceInfo.isDirectory()) {
        await mkdir(stagedPayload, { recursive: false, mode: 0o700 });
        await copyTreeFailClosed(sourceRoot, sourceRoot, stagedPayload, { files: 0, bytes: 0, maxFiles: this.#maximumFiles, maxBytes: this.#maximumBytes });
      } else if (sourceInfo.isFile() && !sourceInfo.isSymbolicLink()) {
        await copyFile(sourceRoot, stagedPayload, constants.COPYFILE_EXCL);
      } else {
        throw new Error("Approved resource source is no longer a regular file or directory.");
      }
      const stagedInspection = await inspectResource(stagedPayload, this.#maximumFiles, this.#maximumBytes);
      if (stagedInspection.revision !== sourceInspection.revision) throw new Error("Resource changed during staged installation.");
      if (current.source.kind === "local") await this.#assertSourceUnchanged(current);
      else await rm(acquisitionRoot, { recursive: true, force: true });
      if (await exists(finalContainer)) {
        await assertContainedPath(this.#managedRoot, finalContainer, "Existing managed resource");
        await rename(finalContainer, backup);
        backedUp = true;
      }
      await rename(stage, finalContainer);
      if (backedUp) await rm(backup, { recursive: true, force: true });
    } catch (error) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      if (backedUp && !(await exists(finalContainer))) await rename(backup, finalContainer).catch(() => undefined);
      throw error;
    }
    const installedPath = join(finalContainer, payloadName);
    await assertContainedPath(this.#managedRoot, installedPath, "Installed resource payload");
    const installedInspection = await inspectResource(installedPath, this.#maximumFiles, this.#maximumBytes);
    const installedRuntimeVersion = this.#runtimeVersion(current.backendId);
    const compatibility = await inspectPiResourceCompatibility(current.kind, installedPath, {
      ...(installedRuntimeVersion === undefined ? {} : { currentRuntimeVersion: installedRuntimeVersion }),
      contentFingerprint: installedInspection.revision
    });
    const extensionApprovedRevision = compatibility.extensionContentFingerprint !== undefined
      && current.extensionApprovedRevision === compatibility.extensionContentFingerprint
      ? current.extensionApprovedRevision
      : undefined;
    const requiresExtensionApproval = compatibility.extensionContentFingerprint !== undefined
      && extensionApprovedRevision === undefined;
    const { extensionApprovedRevision: _previousExtensionApproval, ...currentBase } = current;
    const updated: StoredResource = {
      ...currentBase,
      installedPath,
      discoveredRevision: installedInspection.revision,
      ...compatibilityFields(compatibility, requiresExtensionApproval),
      ...(extensionApprovedRevision === undefined ? {} : { extensionApprovedRevision }),
      ...(acquiredVersion === undefined ? {} : { version: acquiredVersion }),
      state: "installed",
      enabled: false,
      versionNumber: (BigInt(current.versionNumber) + 1n).toString(10),
      updatedAt: this.#now()
    };
    this.#records.set(resourceId, updated);
    this.#persistWithRollback(resourceId, current);
    return publicResource(updated);
  }

  async #assertSourceUnchanged(record: StoredResource): Promise<void> {
    this.#assertStoredProjectTargetTrusted(record);
    if (record.source.kind !== "local" || record.canonicalPath === undefined) throw new Error("Resource does not have a local approved source.");
    const inspection = await inspectResource(record.canonicalPath, this.#maximumFiles, this.#maximumBytes);
    if (record.workspaceRoot !== undefined) assertWithin(record.workspaceRoot, inspection.canonicalPath, "Project resource");
    if (!samePath(inspection.canonicalPath, record.canonicalPath) || inspection.revision !== record.discoveredRevision) {
      throw new Error("Approved resource changed and is fenced until it is discovered and approved again.");
    }
  }

  async #assertInstalledSafe(record: StoredResource): Promise<void> {
    if (record.installedPath === undefined) throw new Error("Resource has no installed payload.");
    assertExpectedInstalledLocation(this.#managedRoot, record);
    await assertContainedPath(this.#managedRoot, record.installedPath, "Installed resource payload");
    const inspection = await inspectResource(record.installedPath, this.#maximumFiles, this.#maximumBytes);
    if (inspection.revision !== record.discoveredRevision) throw new Error("Installed resource content changed and is fenced.");
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

  #assertTrustedProjectTarget(backendId: string, targetId: string | undefined, workspaceRoot?: string): string {
    if (targetId === undefined) throw new Error("Project resources require a Target.");
    const target = this.#store.getTarget(targetId).descriptor;
    const targetWorkspaceRoot = normalizedAbsolute(target.workspaceRoot, "Target workspace root");
    if (target.backendId !== backendId || (workspaceRoot !== undefined && !samePath(targetWorkspaceRoot, workspaceRoot))) {
      throw new Error("Project resource does not match its durable Target boundary.");
    }
    if (!target.trusted) throw new Error("Project resource is fenced because its Target is not trusted.");
    return targetWorkspaceRoot;
  }

  #persistWithRollback(resourceId: string, previous: StoredResource | undefined): void {
    try { this.#persist(); } catch (error) {
      if (previous === undefined) this.#records.delete(resourceId);
      else this.#records.set(resourceId, previous);
      throw error;
    }
  }

  #persist(): void {
    this.#store.setSetting("service", this.#scopeId, "pi_resource_catalog", {
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
      ...compatibilityFields(inspection, requiresExtensionApproval),
      ...(extensionApprovedRevision === undefined ? {} : { extensionApprovedRevision })
    };
  }
}

interface ResourceInspection {
  readonly canonicalPath: string;
  readonly revision: string;
  readonly files: number;
  readonly bytes: number;
}

interface CopyBudget { files: number; bytes: number; readonly maxFiles: number; readonly maxBytes: number }

async function inspectResource(sourcePath: string, maximumFiles: number, maximumBytes: number): Promise<ResourceInspection> {
  const source = normalizedAbsolute(sourcePath, "Resource source path");
  const rootInfo = await lstat(source);
  if (rootInfo.isSymbolicLink()) throw new Error("Resource symlinks and junctions are not allowed.");
  if (!rootInfo.isDirectory() && !rootInfo.isFile()) throw new Error("Resource source must be a regular file or directory.");
  const canonicalPath = await realpath(source);
  if (!samePath(source, canonicalPath)) throw new Error("Resource source contains a path alias or junction.");
  const hash = createHash("sha256");
  const budget = { files: 0, bytes: 0, maxFiles: maximumFiles, maxBytes: maximumBytes };
  if (rootInfo.isFile()) await inspectFile(canonicalPath, canonicalPath, "", hash, budget);
  else await inspectDirectory(canonicalPath, canonicalPath, "", hash, budget);
  return { canonicalPath, revision: `sha256:${hash.digest("hex")}`, files: budget.files, bytes: budget.bytes };
}

async function inspectDirectory(root: string, directory: string, relativePath: string, hash: ReturnType<typeof createHash>, budget: CopyBudget): Promise<void> {
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Resource tree contains a symlink, junction, or non-directory entry.");
  const canonical = await realpath(directory);
  assertWithin(root, canonical, "Resource directory");
  hash.update(`D\0${relativePath}\0`);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    validateEntryName(entry.name);
    const path = join(directory, entry.name);
    const childRelative = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
    const info = await lstat(path);
    if (entry.isSymbolicLink() || info.isSymbolicLink()) throw new Error("Resource tree contains a symlink or junction.");
    if (entry.isDirectory() && info.isDirectory()) await inspectDirectory(root, path, childRelative, hash, budget);
    else if (entry.isFile() && info.isFile()) await inspectFile(root, path, childRelative, hash, budget);
    else throw new Error("Resource tree contains a special file or changed during inspection.");
  }
  const after = await lstat(directory);
  if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after) || before.mtimeMs !== after.mtimeMs) {
    throw new Error("Resource directory changed during inspection.");
  }
}

async function inspectFile(root: string, path: string, relativePath: string, hash: ReturnType<typeof createHash>, budget: CopyBudget): Promise<void> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Resource tree contains a special file or symlink.");
  const canonical = await realpath(path);
  assertWithin(root, canonical, "Resource file");
  budget.files += 1;
  budget.bytes += before.size;
  if (budget.files > budget.maxFiles || budget.bytes > budget.maxBytes) throw new Error("Resource exceeds configured file or byte limits.");
  hash.update(`F\0${relativePath}\0${before.size}\0`);
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const after = await stat(path);
  if (!after.isFile() || !sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("Resource file changed during inspection.");
  }
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
    state: record.state,
    enabled: record.enabled,
    ...(record.approvedAt === undefined ? {} : { approvedAt: record.approvedAt }),
    ...(record.approvedByConnectionId === undefined ? {} : { approvedByConnectionId: record.approvedByConnectionId }),
    versionNumber: BigInt(record.versionNumber),
    updatedAt: record.updatedAt,
    ...(record.error === undefined ? {} : { error: record.error })
  };
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
    postMutationNotice: record.postMutationNotice
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
    ) throw new Error("Stored resource compatibility detail is malformed.");
    const compatibilityIssues = validateStringEnumList(detail.compatibilityIssues, issues, "compatibility issue");
    const detectedApis = validateStringEnumList(detail.detectedApis, apis, "detected API");
    const adaptedApis = validateStringEnumList(detail.adaptedApis, apis, "adapted API");
    const unsupportedApis = validateStringEnumList(detail.unsupportedApis, apis, "unsupported API");
    return {
      kind: detail.kind,
      name: detail.name,
      compatibility: detail.compatibility,
      compatibilityIssues: compatibilityIssues as PiPackageResourceDetail["compatibilityIssues"],
      detectedApis: detectedApis as PiPackageResourceDetail["detectedApis"],
      adaptedApis: adaptedApis as PiPackageResourceDetail["adaptedApis"],
      unsupportedApis: unsupportedApis as PiPackageResourceDetail["unsupportedApis"]
    };
  });
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
  const stored = value as StoredResource & { readonly source?: PiPackageSource };
  validateResourceId(stored.id);
  validateKind(stored.kind);
  validateScope(stored.scope);
  validateState(stored.state);
  if (!/^\d+$/u.test(stored.versionNumber) || !Number.isSafeInteger(stored.updatedAt)) throw new Error("Stored Pi resource version is malformed.");
  if (stored.source === undefined) throw new Error("Stored Pi resource source is missing.");
  const source = normalizePiPackageSource(stored.source);
  if (JSON.stringify(source) !== JSON.stringify(stored.source)) throw new Error("Stored Pi resource source is not canonical.");
  if (source.kind !== "local" && stored.kind !== "package") throw new Error("Only package resources may use npm or git acquisition.");
  let canonicalPath: string | undefined;
  if (source.kind === "local") {
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
  const sourceIdentity = stored.kind === "package"
    ? piPackageSourceIdentity(source)
    : `${stored.kind}:${pathIdentity(canonicalPath!)}`;
  if (stored.sourceKind !== source.kind || stored.sourceIdentity !== sourceIdentity) {
    throw new Error("Stored Pi resource source identity is malformed.");
  }
  const sourceDisplay = source.kind === "local" ? basename(canonicalPath!) : piPackageSourceDisplay(source);
  const canonicalPathFingerprint = source.kind === "local"
    ? pathFingerprint(canonicalPath!)
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
  const extensionApprovedRevision = stored.extensionApprovedRevision;
  if (extensionApprovedRevision !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(extensionApprovedRevision)) {
    throw new Error("Stored extension approval fingerprint is malformed.");
  }
  const {
    source: _source,
    sourceKind: _sourceKind,
    sourceIdentity: _sourceIdentity,
    sourceDisplay: _sourceDisplay,
    canonicalPathFingerprint: _canonicalPathFingerprint,
    canonicalPath: _canonicalPath,
    extensionApprovedRevision: _extensionApprovedRevision,
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
    ...(canonicalPath === undefined ? {} : { canonicalPath }),
    ...(stored.version === undefined ? {} : { version: boundedVersion(stored.version) }),
    ...(stored.error === undefined ? {} : { error: redactSecrets(stored.error).slice(0, 2_048) })
  };
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

function installedContainer(path: string): string {
  return dirname(path);
}

function assertExpectedInstalledLocation(managedRoot: string, record: StoredResource): void {
  if (record.installedPath === undefined) throw new Error("Resource has no installed payload.");
  const expectedContainer = join(managedRoot, groupFor(record.kind), safeId(record.id));
  if (!samePath(dirname(record.installedPath), expectedContainer)) {
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
  return value === "" || value === "." || value === ".." ? "resource" : value;
}

function validateResourceId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id)) throw new Error("Pi resource ID is invalid.");
}

function validateKind(kind: PiResourceKind): void {
  if (!(["extension", "skill", "prompt", "theme", "package"] as const).includes(kind)) throw new Error("Pi resource kind is invalid.");
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
  readonly source: Extract<PiPackageSource, { readonly kind: "local" }>;
  readonly canonicalPath: string;
} {
  return record.scope === "project" && record.source.kind === "local" && record.canonicalPath !== undefined;
}

function boundedVersion(value: string): string {
  const version = nonBlank(value, "Resource version");
  if (version.length > 128) throw new Error("Resource version is too long.");
  return version;
}

function nonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.includes("\0")) throw new Error(`${label} must not be blank.`);
  return normalized;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

interface ProjectResourceCandidate {
  readonly kind: PiResourceKind;
  readonly sourcePath: string;
  readonly name: string;
}

async function discoverCanonicalProjectCandidates(workspaceRoot: string, maximumCandidates: number): Promise<readonly ProjectResourceCandidate[]> {
  const candidates: ProjectResourceCandidate[] = [];
  const push = (kind: PiResourceKind, sourcePath: string): void => {
    if (candidates.length >= maximumCandidates) throw new Error("Project resource discovery exceeds the configured candidate limit.");
    candidates.push({ kind, sourcePath, name: basename(sourcePath) });
  };

  const piRoot = join(workspaceRoot, ".pi");
  const agentsRoot = join(workspaceRoot, ".agents");
  for (const root of [piRoot, agentsRoot]) await assertOptionalSafeDirectory(workspaceRoot, root, "Project resource root");

  for (const sourcePath of await discoverExtensionEntries(workspaceRoot, join(piRoot, "extensions"))) push("extension", sourcePath);
  for (const sourcePath of await discoverSkillEntries(workspaceRoot, join(piRoot, "skills"))) push("skill", sourcePath);
  for (const sourcePath of await discoverSkillEntries(workspaceRoot, join(agentsRoot, "skills"))) push("skill", sourcePath);
  for (const sourcePath of await discoverPromptEntries(workspaceRoot, join(piRoot, "prompts"))) push("prompt", sourcePath);
  for (const sourcePath of await discoverThemeEntries(workspaceRoot, join(piRoot, "themes"))) push("theme", sourcePath);
  for (const sourcePath of await discoverDirectPackageEntries(workspaceRoot, join(piRoot, "packages"))) push("package", sourcePath);
  for (const sourcePath of await discoverNpmPackageEntries(workspaceRoot, join(piRoot, "npm", "node_modules"))) push("package", sourcePath);
  for (const sourcePath of await discoverGitPackageEntries(workspaceRoot, join(piRoot, "git"), maximumCandidates - candidates.length)) push("package", sourcePath);

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

async function safeOptionalDirectoryEntries(workspaceRoot: string, root: string, label: string): Promise<readonly SafeDirectoryEntry[]> {
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
