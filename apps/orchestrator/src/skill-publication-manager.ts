import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { redactSecrets } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import { create as createTarArchive } from "tar";
import { parseDocument } from "yaml";

import { isSensitiveSkillPath, looksLikeSecretMaterial } from "./skill-content-policy.js";
import {
  normalizeSkillMarketPublicationMetadata,
  type SkillMarketCatalogItem,
  type SkillMarketManager,
  type SkillMarketPublicationIntent,
  type SkillMarketPublicationMetadata,
  type SkillMarketPublicationResult,
  type SkillMarketSourceDescriptor
} from "./skill-market-manager.js";
import {
  inspectPiSkillPackage,
  type PiResourceDescriptor,
  type PiResourceManager,
  type PiSkillContentLease
} from "./resource-manager.js";

export type SkillPublicationState =
  | "pending"
  | "snapshotting"
  | "packaging"
  | "scanning"
  | "committing"
  | "reconciling"
  | "cancelling"
  | "published"
  | "blocked"
  | "failed"
  | "cancelled";

export type SkillPublicationGateStatus = "pending" | "passed" | "blocked";
export type SkillPublicationVerdict = "pending" | "passed" | "blocked";
export type SkillPublicationMode = "first" | "version";
export type SkillPublicationPublisher = "personal";
export type SkillPublicationVisibility = "public";

export interface SkillPublicationGateIssue {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface SkillPublicationGate {
  readonly id: "metadata" | "package" | "sensitive_content" | "source_authority";
  readonly label: string;
  readonly status: SkillPublicationGateStatus;
  readonly issues: readonly SkillPublicationGateIssue[];
}

export interface SkillPublicationAuthority {
  readonly resourceId: string;
  readonly resourceRevision: bigint;
  readonly observedRevision: string;
  readonly backendId: string;
  readonly targetId?: string;
  readonly scope: "global" | "project";
  readonly sourceId: string;
  readonly sourceRevision: bigint;
  readonly sourceContentRevision: string;
  readonly sourceDisplay: string;
  readonly existingEntryId?: string;
}

export interface SkillPublicationResult {
  readonly sourceId: string;
  readonly sourceRevision: bigint;
  readonly entryId: string;
  readonly entryRevision: bigint;
  readonly entryContentRevision: string;
  readonly version: string;
}

export interface SkillPublicationJob {
  readonly id: string;
  readonly revision: bigint;
  readonly state: SkillPublicationState;
  readonly authority: SkillPublicationAuthority;
  readonly metadata: SkillMarketPublicationMetadata;
  readonly publisher: SkillPublicationPublisher;
  readonly visibility: SkillPublicationVisibility;
  readonly gates: readonly SkillPublicationGate[];
  readonly verdict: SkillPublicationVerdict;
  readonly files: number;
  readonly uncompressedBytes: number;
  readonly archiveBytes: number;
  readonly attempt: number;
  readonly retryOfJobId?: string;
  readonly result?: SkillPublicationResult;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  readonly error?: string;
  readonly cancellable: boolean;
}

export interface SkillPublicationPreview {
  readonly authority: SkillPublicationAuthority;
  readonly source: SkillMarketSourceDescriptor;
  readonly mode: SkillPublicationMode;
  readonly suggestedSlug: string;
  readonly suggestedVersion: string;
  readonly existingEntry?: SkillMarketCatalogItem;
  readonly dirty: boolean;
  readonly personalPublisherAvailable: true;
  readonly teamPublisherAvailable: false;
  readonly publicVisibilityAvailable: true;
  readonly departmentVisibilityAvailable: false;
  readonly privateVisibilityAvailable: false;
  readonly collaborationUnavailableReason: string;
}

export interface GetSkillPublicationPreviewInput {
  readonly resourceId: string;
  readonly expectedResourceRevision: bigint;
  readonly sourceId: string;
  readonly expectedSourceRevision: bigint;
  readonly slug?: string;
}

export interface StartSkillPublicationInput {
  readonly jobId: string;
  readonly resourceId: string;
  readonly expectedResourceRevision: bigint;
  readonly expectedObservedRevision: string;
  readonly sourceId: string;
  readonly expectedSourceRevision: bigint;
  readonly expectedSourceContentRevision: string;
  readonly expectedExistingEntryId?: string;
  readonly metadata: SkillMarketPublicationMetadata;
  readonly publisher: SkillPublicationPublisher;
  readonly visibility: SkillPublicationVisibility;
  readonly attempt?: number;
  readonly retryOfJobId?: string;
}

export interface SkillPublicationManagerOptions {
  readonly store: OperationalStore;
  readonly resources: PiResourceManager;
  readonly market: SkillMarketManager;
  readonly rootDirectory: string;
  readonly scopeId?: string;
  readonly now?: () => number;
  readonly maximumRecords?: number;
  readonly maximumConcurrentJobs?: number;
  /** Owning-test seam invoked only after a durable public phase transition. */
  readonly afterStatePersisted?: (job: SkillPublicationJob) => void | Promise<void>;
}

interface StoredSkillPublicationAuthority extends Omit<SkillPublicationAuthority, "resourceRevision" | "sourceRevision"> {
  readonly resourceRevision: string;
  readonly sourceRevision: string;
}

interface StoredSkillPublicationResult extends Omit<SkillPublicationResult, "sourceRevision" | "entryRevision"> {
  readonly sourceRevision: string;
  readonly entryRevision: string;
}

interface StoredSkillPublicationJob extends Omit<
  SkillPublicationJob,
  "revision" | "authority" | "result" | "cancellable"
> {
  readonly revision: string;
  readonly authority: StoredSkillPublicationAuthority;
  readonly intent?: SkillMarketPublicationIntent;
  readonly result?: StoredSkillPublicationResult;
}

interface StoredSkillPublicationCatalog {
  readonly format: 1;
  readonly records: readonly StoredSkillPublicationJob[];
}

interface ActivePublication {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  finalSwitched: boolean;
}

const SETTING_KEY = "skill_publications";
const JOB_ID = /^skill_publication_[a-f0-9]{32}$/u;
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const CONTENT_REVISION = /^sha256:[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const ACTIVE_PRECOMMIT = new Set<SkillPublicationState>([
  "pending", "snapshotting", "packaging", "scanning", "committing", "cancelling"
]);
const TERMINAL = new Set<SkillPublicationState>(["published", "blocked", "failed", "cancelled"]);
const COLLABORATION_UNAVAILABLE = "Team and restricted visibility require a configured collaboration identity owner.";
const MAXIMUM_SCAN_TEXT_BYTES = 2 * 1024 * 1024;
const MAXIMUM_GATE_ISSUES = 20;

interface SemverApi {
  compare(left: string, right: string): number;
  inc(version: string, release: "patch"): string | null;
  valid(version: string): string | null;
}

const semver = createRequire(import.meta.url)("semver") as SemverApi;

export function skillPublicationJobId(seed: string): string {
  if (seed.trim() === "" || seed.length > 1_024) throw new Error("Skill publication operation identity is invalid.");
  return `skill_publication_${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}

/** Durable publication, scan, final-switch, and recovery owner. */
export class SkillPublicationManager {
  readonly #store: OperationalStore;
  readonly #resources: PiResourceManager;
  readonly #market: SkillMarketManager;
  readonly #rootDirectory: string;
  readonly #workingDirectory: string;
  readonly #scopeId: string;
  readonly #now: () => number;
  readonly #maximumRecords: number;
  readonly #maximumConcurrentJobs: number;
  readonly #afterStatePersisted?: SkillPublicationManagerOptions["afterStatePersisted"];
  readonly #records = new Map<string, StoredSkillPublicationJob>();
  readonly #active = new Map<string, ActivePublication>();
  #tail: Promise<unknown> = Promise.resolve();
  #initialized = false;
  #closing = false;
  #recoveredFromCorruption = false;

  constructor(options: SkillPublicationManagerOptions) {
    if (!isAbsolute(options.rootDirectory) || resolve(options.rootDirectory) !== options.rootDirectory) {
      throw new Error("Skill publication root must be a normalized absolute path.");
    }
    this.#store = options.store;
    this.#resources = options.resources;
    this.#market = options.market;
    this.#rootDirectory = options.rootDirectory;
    this.#workingDirectory = join(options.rootDirectory, ".working");
    this.#scopeId = options.scopeId ?? "orchestrator";
    this.#now = options.now ?? Date.now;
    this.#maximumRecords = options.maximumRecords ?? 128;
    this.#maximumConcurrentJobs = options.maximumConcurrentJobs ?? 2;
    this.#afterStatePersisted = options.afterStatePersisted;
    if (!Number.isSafeInteger(this.#maximumRecords) || this.#maximumRecords < 1 || this.#maximumRecords > 1_000) {
      throw new Error("Skill publication history limit is invalid.");
    }
    if (!Number.isSafeInteger(this.#maximumConcurrentJobs) || this.#maximumConcurrentJobs < 1 || this.#maximumConcurrentJobs > 16) {
      throw new Error("Skill publication concurrency limit is invalid.");
    }
  }

  get recoveredFromCorruption(): boolean {
    this.#assertInitialized();
    return this.#recoveredFromCorruption;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 });
    await assertCanonicalDirectory(this.#rootDirectory, "Skill publication root");
    await clearOwnedWorkingDirectory(this.#workingDirectory);
    await mkdir(this.#workingDirectory, { recursive: true, mode: 0o700 });
    const setting = this.#store.findSetting<unknown>("service", this.#scopeId, SETTING_KEY);
    if (setting !== undefined) {
      try {
        const catalog = validateStoredCatalog(setting.value, this.#maximumRecords);
        for (const record of catalog.records) {
          if (this.#records.has(record.id)) throw new Error("Skill publication catalog contains duplicate job IDs.");
          this.#records.set(record.id, record);
        }
      } catch {
        this.#records.clear();
        this.#recoveredFromCorruption = true;
        this.#persist();
      }
    }
    let changed = false;
    for (const [id, record] of this.#records) {
      if (["snapshotting", "packaging", "scanning"].includes(record.state)) {
        this.#records.set(id, resetPendingAfterRestart(record, this.#now()));
        changed = true;
      }
    }
    if (changed) this.#persist();
    this.#initialized = true;
    for (const record of this.#records.values()) {
      if (ACTIVE_PRECOMMIT.has(record.state) || record.state === "reconciling") this.begin(record.id);
    }
  }

  async preview(input: GetSkillPublicationPreviewInput): Promise<SkillPublicationPreview> {
    this.#assertInitialized();
    const resourceId = entityId(input.resourceId, "Skill Resource ID");
    const resource = this.#resources.get(resourceId);
    assertStandalonePublicationResource(resource);
    const lease = await this.#resources.acquireSkillContent({
      resourceId,
      expectedResourceVersion: positiveRevision(input.expectedResourceRevision, "Skill Resource revision")
    });
    try {
      const suggestedSlug = input.slug === undefined || input.slug.trim() === ""
        ? suggestedPublicationSlug(resource)
        : input.slug;
      const target = this.#market.getPublicationTarget(
        input.sourceId,
        positiveRevision(input.expectedSourceRevision, "Skill market source revision"),
        suggestedSlug
      );
      const existing = target.existingEntry;
      return {
        authority: publicationAuthority(resource, lease, target.source, existing?.id),
        source: target.source,
        mode: existing === undefined ? "first" : "version",
        suggestedSlug,
        suggestedVersion: suggestedPublicationVersion(resource.version, existing?.version),
        ...(existing === undefined ? {} : { existingEntry: copyMarketEntry(existing) }),
        dirty: lease.dirty,
        personalPublisherAvailable: true,
        teamPublisherAvailable: false,
        publicVisibilityAvailable: true,
        departmentVisibilityAvailable: false,
        privateVisibilityAvailable: false,
        collaborationUnavailableReason: COLLABORATION_UNAVAILABLE
      };
    } finally {
      await lease.release();
    }
  }

  list(filter: { readonly resourceId?: string } = {}): readonly SkillPublicationJob[] {
    this.#assertInitialized();
    const resourceId = filter.resourceId === undefined ? undefined : entityId(filter.resourceId, "Skill Resource ID");
    return [...this.#records.values()]
      .filter((record) => resourceId === undefined || record.authority.resourceId === resourceId)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id, "en"))
      .map((record) => publicJob(record, this.#active.get(record.id)?.finalSwitched === true));
  }

  get(jobId: string): SkillPublicationJob {
    this.#assertInitialized();
    const id = normalizedJobId(jobId);
    const record = this.#records.get(id);
    if (record === undefined) throw new Error("Skill publication job does not exist.");
    return publicJob(record, this.#active.get(record.id)?.finalSwitched === true);
  }

  async start(input: StartSkillPublicationInput): Promise<SkillPublicationJob> {
    this.#assertInitialized();
    if (this.#closing) throw new Error("Skill publication manager is closing.");
    const normalized = await this.#validateStart(input);
    return this.#mutate(async () => {
      if (this.#records.has(normalized.jobId)) throw new Error("Skill publication job ID already exists.");
      const active = [...this.#records.values()].filter((record) => !TERMINAL.has(record.state));
      if (active.length >= this.#maximumConcurrentJobs) throw new Error("The Skill publication concurrency limit has been reached.");
      if (active.some((record) => record.authority.resourceId === normalized.authority.resourceId
        || record.authority.sourceId === normalized.authority.sourceId && record.metadata.slug === normalized.metadata.slug)) {
        throw new Error("This Skill or destination already has an active publication.");
      }
      const terminal = [...this.#records.values()]
        .filter((record) => TERMINAL.has(record.state))
        .sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id, "en"));
      const pruneCount = Math.max(0, this.#records.size + 1 - this.#maximumRecords);
      if (pruneCount > terminal.length) throw new Error("Skill publication history is full of active recovery jobs.");
      for (const record of terminal.slice(0, pruneCount)) this.#records.delete(record.id);
      const now = this.#now();
      const record: StoredSkillPublicationJob = {
        id: normalized.jobId,
        revision: "1",
        state: "pending",
        authority: storedAuthority(normalized.authority),
        metadata: normalized.metadata,
        publisher: "personal",
        visibility: "public",
        gates: pendingPublicationGates(),
        verdict: "pending",
        files: 0,
        uncompressedBytes: 0,
        archiveBytes: 0,
        attempt: normalized.attempt,
        ...(normalized.retryOfJobId === undefined ? {} : { retryOfJobId: normalized.retryOfJobId }),
        createdAt: now,
        updatedAt: now
      };
      this.#records.set(record.id, record);
      try {
        this.#persist();
      } catch (error) {
        this.#records.delete(record.id);
        for (const pruned of terminal.slice(0, pruneCount)) this.#records.set(pruned.id, pruned);
        throw error;
      }
      return publicJob(record, false);
    });
  }

  begin(jobId: string): void {
    this.#assertInitialized();
    if (this.#closing) return;
    const id = normalizedJobId(jobId);
    if (this.#active.has(id)) return;
    const record = this.#records.get(id);
    if (record === undefined || TERMINAL.has(record.state)) return;
    const controller = new AbortController();
    const active: ActivePublication = {
      controller,
      finalSwitched: record.state === "reconciling",
      completion: Promise.resolve()
    };
    const completion = this.#resume(id, active, controller.signal).finally(() => {
      if (this.#active.get(id) === active) this.#active.delete(id);
    });
    Object.assign(active, { completion });
    this.#active.set(id, active);
  }

  async cancel(jobId: string, expectedRevision: bigint): Promise<SkillPublicationJob> {
    const id = normalizedJobId(jobId);
    const revision = positiveRevision(expectedRevision, "Skill publication revision");
    const active = this.#active.get(id);
    const result = await this.#mutate(async () => {
      const current = this.#require(id);
      if (BigInt(current.revision) !== revision) throw new Error("Skill publication changed after it was observed.");
      if (TERMINAL.has(current.state)) throw new Error("Skill publication is already terminal.");
      if (current.state === "reconciling" || active?.finalSwitched === true) {
        throw new Error("Skill publication crossed its final manifest switch and must finish reconciliation.");
      }
      const now = this.#now();
      const next: StoredSkillPublicationJob = active === undefined || current.state === "pending"
        ? terminalJob(current, "cancelled", now)
        : {
            ...current,
            revision: increment(current.revision),
            state: "cancelling",
            updatedAt: now,
            error: "Cancellation requested before the final manifest switch."
          };
      this.#replaceRecord(current, next);
      return publicJob(next, false);
    });
    active?.controller.abort();
    return result;
  }

  async retry(jobId: string, expectedRevision: bigint, nextJobId: string): Promise<SkillPublicationJob> {
    const previous = this.#require(normalizedJobId(jobId));
    if (BigInt(previous.revision) !== positiveRevision(expectedRevision, "Skill publication revision")) {
      throw new Error("Skill publication changed after it was observed.");
    }
    if (previous.state === "reconciling" || previous.state === "committing") {
      this.begin(previous.id);
      return this.get(previous.id);
    }
    if (!TERMINAL.has(previous.state) || previous.state === "published") {
      throw new Error("Only blocked, failed, or cancelled Skill publications can be retried.");
    }
    const authority = publicAuthority(previous.authority);
    return this.start({
      jobId: normalizedJobId(nextJobId),
      resourceId: authority.resourceId,
      expectedResourceRevision: authority.resourceRevision,
      expectedObservedRevision: authority.observedRevision,
      sourceId: authority.sourceId,
      expectedSourceRevision: authority.sourceRevision,
      expectedSourceContentRevision: authority.sourceContentRevision,
      ...(authority.existingEntryId === undefined ? {} : { expectedExistingEntryId: authority.existingEntryId }),
      metadata: previous.metadata,
      publisher: previous.publisher,
      visibility: previous.visibility,
      attempt: previous.attempt + 1,
      retryOfJobId: previous.id
    });
  }

  async wait(jobId: string): Promise<SkillPublicationJob> {
    const id = normalizedJobId(jobId);
    await this.#active.get(id)?.completion;
    return this.get(id);
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    const active = [...this.#active.values()];
    for (const item of active) {
      if (!item.finalSwitched) item.controller.abort();
    }
    await Promise.allSettled(active.map((item) => item.completion));
  }

  async #validateStart(input: StartSkillPublicationInput): Promise<{
    readonly jobId: string;
    readonly authority: SkillPublicationAuthority;
    readonly metadata: SkillMarketPublicationMetadata;
    readonly attempt: number;
    readonly retryOfJobId?: string;
  }> {
    const jobId = normalizedJobId(input.jobId);
    if (input.publisher !== "personal") throw new Error(COLLABORATION_UNAVAILABLE);
    if (input.visibility !== "public") throw new Error(COLLABORATION_UNAVAILABLE);
    const metadata = normalizeSkillMarketPublicationMetadata(input.metadata);
    const resourceId = entityId(input.resourceId, "Skill Resource ID");
    const expectedResourceRevision = positiveRevision(input.expectedResourceRevision, "Skill Resource revision");
    const resource = this.#resources.get(resourceId);
    assertStandalonePublicationResource(resource);
    const lease = await this.#resources.acquireSkillContent({ resourceId, expectedResourceVersion: expectedResourceRevision });
    try {
      if (lease.observedRevision !== contentRevision(input.expectedObservedRevision, "Skill observed revision")) {
        throw new Error("Skill content changed after the publication form was opened.");
      }
      const target = this.#market.getPublicationTarget(
        input.sourceId,
        positiveRevision(input.expectedSourceRevision, "Skill market source revision"),
        metadata.slug
      );
      if (target.source.contentRevision !== contentRevision(input.expectedSourceContentRevision, "Skill market source content revision")) {
        throw new Error("Skill market source content changed after the publication form was opened.");
      }
      const expectedExistingEntryId = input.expectedExistingEntryId === undefined
        ? undefined
        : entityId(input.expectedExistingEntryId, "Existing Skill market entry ID");
      if (target.existingEntry?.id !== expectedExistingEntryId) {
        throw new Error(target.existingEntry === undefined
          ? "The existing Skill market entry disappeared after the publication form was opened."
          : "This Skill slug already exists or changed after the publication form was opened.");
      }
      if (target.existingEntry !== undefined) {
        if (semver.compare(metadata.version, target.existingEntry.version) <= 0) {
          throw new Error(`Skill publication version must be greater than ${target.existingEntry.version}.`);
        }
        if (metadata.changelog === undefined) throw new Error("A changelog is required when publishing a new Skill version.");
      }
      const attempt = input.attempt ?? 1;
      if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 1_000) throw new Error("Skill publication attempt is invalid.");
      const retryOfJobId = input.retryOfJobId === undefined ? undefined : normalizedJobId(input.retryOfJobId);
      return {
        jobId,
        authority: publicationAuthority(resource, lease, target.source, expectedExistingEntryId),
        metadata,
        attempt,
        ...(retryOfJobId === undefined ? {} : { retryOfJobId })
      };
    } finally {
      await lease.release();
    }
  }

  async #resume(jobId: string, active: ActivePublication, signal: AbortSignal): Promise<void> {
    const record = this.#records.get(jobId);
    if (record === undefined || TERMINAL.has(record.state)) return;
    if (record.state === "committing" || record.state === "reconciling" || record.state === "cancelling") {
      if (record.intent === undefined) {
        if (record.state === "cancelling") await this.#cancelled(jobId);
        else {
          await this.#resetPending(jobId);
          await this.#run(jobId, active, signal);
        }
        return;
      }
      await this.#recover(jobId, active, signal);
      return;
    }
    await this.#run(jobId, active, signal);
  }

  async #recover(jobId: string, active: ActivePublication, signal: AbortSignal): Promise<void> {
    const initial = this.#require(jobId);
    if (initial.intent === undefined) throw new Error("Recovering Skill publication is missing its commit intent.");
    active.finalSwitched = initial.state === "reconciling";
    try {
      const recovered = await this.#market.recoverLocalPublication({
        jobId: initial.id,
        sourceId: initial.authority.sourceId,
        expectedSourceContentRevision: initial.authority.sourceContentRevision,
        metadata: initial.metadata,
        intent: initial.intent
      }, (store, result) => {
        const current = this.#require(jobId);
        const published = publishedJob(current, result, this.#now());
        store.setSetting("service", this.#scopeId, SETTING_KEY, this.#catalogReplacing(published));
        return published;
      });
      if (recovered.committed) {
        active.finalSwitched = true;
        this.#records.set(jobId, recovered.value);
        await this.#afterStatePersisted?.(publicJob(recovered.value, true));
        return;
      }
      active.finalSwitched = false;
      const current = this.#require(jobId);
      if (current.state === "cancelling") {
        await this.#cancelled(jobId);
        return;
      }
      await this.#resetPending(jobId);
      signal.throwIfAborted();
      await this.#run(jobId, active, signal);
    } catch (error) {
      if (signal.aborted && !active.finalSwitched) {
        await this.#cancelled(jobId);
        return;
      }
      await this.#reconciling(jobId, error);
    }
  }

  async #run(jobId: string, active: ActivePublication, signal: AbortSignal): Promise<void> {
    let lease: PiSkillContentLease | undefined;
    const working = join(this.#workingDirectory, createHash("sha256").update(jobId).digest("hex"));
    try {
      const initial = this.#require(jobId);
      const authority = publicAuthority(initial.authority);
      signal.throwIfAborted();
      lease = await this.#resources.acquireSkillContent({
        resourceId: authority.resourceId,
        expectedResourceVersion: authority.resourceRevision
      });
      if (lease.observedRevision !== authority.observedRevision) {
        throw new Error("Skill content changed after publication was confirmed.");
      }
      await this.#phase(jobId, "snapshotting");
      signal.throwIfAborted();
      await removeOwnedWorkingDirectory(this.#workingDirectory, working);
      await mkdir(working, { recursive: false, mode: 0o700 });
      const snapshotRoot = join(working, "snapshot");
      await mkdir(snapshotRoot, { recursive: false, mode: 0o700 });
      await lease.snapshotTo(snapshotRoot, signal);
      await stagePublishedSkillManifest(snapshotRoot, initial.metadata.slug, initial.metadata.version, signal);
      const inspection = await inspectPiSkillPackage(
        snapshotRoot,
        this.#resources.maximumFiles,
        this.#resources.maximumBytes,
        signal
      );
      await lease.assertCurrent(signal);
      await this.#phase(jobId, "packaging", {
        files: inspection.files,
        uncompressedBytes: inspection.bytes
      });
      const archivePath = join(working, "package.tgz");
      await createSkillPublicationArchive(snapshotRoot, archivePath, signal);
      const archive = await hashPublicationArchive(archivePath, signal);
      await lease.assertCurrent(signal);
      await this.#phase(jobId, "scanning", {
        files: inspection.files,
        uncompressedBytes: inspection.bytes,
        archiveBytes: archive.bytes
      });
      const gates = await scanPublication(snapshotRoot, initial, this.#market, signal);
      await this.#scanResult(jobId, gates);
      if (gates.some((gate) => gate.status === "blocked")) {
        await this.#blocked(jobId);
        return;
      }
      await lease.assertCurrent(signal);
      const committed = await this.#market.commitLocalPublication({
        jobId,
        sourceId: authority.sourceId,
        expectedSourceRevision: authority.sourceRevision,
        expectedSourceContentRevision: authority.sourceContentRevision,
        ...(authority.existingEntryId === undefined ? {} : { expectedExistingEntryId: authority.existingEntryId }),
        metadata: initial.metadata,
        archivePath,
        archiveBytes: archive.bytes,
        archiveSha256: archive.sha256,
        ...(initial.intent === undefined ? {} : { recoveredIntent: initial.intent })
      }, {
        beforeSwitch: async (intent) => {
          await lease!.assertCurrent(signal);
          await this.#committing(jobId, intent);
        },
        afterFinalSwitch: () => { active.finalSwitched = true; },
        finalize: (store, result) => {
          const current = this.#require(jobId);
          const published = publishedJob(current, result, this.#now());
          store.setSetting("service", this.#scopeId, SETTING_KEY, this.#catalogReplacing(published));
          return published;
        }
      }, signal);
      this.#records.set(jobId, committed.value);
      await this.#afterStatePersisted?.(publicJob(committed.value, true));
    } catch (error) {
      if (active.finalSwitched) {
        await this.#reconciling(jobId, error);
        await this.#recover(jobId, active, signal);
      } else if (signal.aborted || this.#records.get(jobId)?.state === "cancelling") {
        await this.#cancelled(jobId);
      } else {
        await this.#failed(jobId, error);
      }
    } finally {
      await lease?.release().catch(() => undefined);
      await removeOwnedWorkingDirectory(this.#workingDirectory, working).catch(() => undefined);
    }
  }

  async #phase(
    jobId: string,
    state: Extract<SkillPublicationState, "snapshotting" | "packaging" | "scanning">,
    progress?: { readonly files: number; readonly uncompressedBytes: number; readonly archiveBytes?: number }
  ): Promise<void> {
    const job = await this.#transition(jobId, (current) => {
      const { error: _error, completedAt: _completedAt, ...base } = current;
      return {
        ...base,
        revision: increment(current.revision),
        state,
        ...(progress === undefined ? {} : {
          files: progress.files,
          uncompressedBytes: progress.uncompressedBytes,
          ...(progress.archiveBytes === undefined ? {} : { archiveBytes: progress.archiveBytes })
        }),
        updatedAt: this.#now()
      };
    });
    await this.#afterStatePersisted?.(job);
  }

  async #scanResult(jobId: string, gates: readonly SkillPublicationGate[]): Promise<void> {
    const verdict: SkillPublicationVerdict = gates.some((gate) => gate.status === "blocked") ? "blocked" : "passed";
    const job = await this.#transition(jobId, (current) => ({
      ...current,
      revision: increment(current.revision),
      gates: copyGates(gates),
      verdict,
      updatedAt: this.#now()
    }));
    await this.#afterStatePersisted?.(job);
  }

  async #committing(jobId: string, intent: SkillMarketPublicationIntent): Promise<void> {
    const job = await this.#transition(jobId, (current) => ({
      ...current,
      revision: increment(current.revision),
      state: "committing",
      intent: { ...intent },
      verdict: "passed",
      updatedAt: this.#now()
    }));
    await this.#afterStatePersisted?.(job);
  }

  async #blocked(jobId: string): Promise<void> {
    const job = await this.#transition(jobId, (current) => terminalJob(current, "blocked", this.#now()));
    await this.#afterStatePersisted?.(job);
  }

  async #failed(jobId: string, error: unknown): Promise<void> {
    const job = await this.#transition(jobId, (current) => ({
      ...terminalJob(current, "failed", this.#now()),
      error: publicError(error)
    }));
    await this.#afterStatePersisted?.(job);
  }

  async #cancelled(jobId: string): Promise<void> {
    const current = this.#records.get(jobId);
    if (current === undefined || TERMINAL.has(current.state)) return;
    const job = await this.#transition(jobId, (value) => terminalJob(value, "cancelled", this.#now()));
    await this.#afterStatePersisted?.(job);
  }

  async #reconciling(jobId: string, error: unknown): Promise<void> {
    const current = this.#records.get(jobId);
    if (current === undefined || current.state === "published") return;
    const job = await this.#transition(jobId, (value) => {
      const { completedAt: _completedAt, ...base } = value;
      return {
        ...base,
        revision: increment(value.revision),
        state: "reconciling",
        error: publicError(error),
        updatedAt: this.#now()
      };
    });
    await this.#afterStatePersisted?.(job);
  }

  async #resetPending(jobId: string): Promise<void> {
    const job = await this.#transition(jobId, (current) => resetPendingAfterRestart(current, this.#now()));
    await this.#afterStatePersisted?.(job);
  }

  async #transition(
    jobId: string,
    update: (current: StoredSkillPublicationJob) => StoredSkillPublicationJob
  ): Promise<SkillPublicationJob> {
    return this.#mutate(async () => {
      const current = this.#require(jobId);
      if (TERMINAL.has(current.state)) return publicJob(current, current.state === "published");
      const next = validateStoredJob(update(current));
      this.#replaceRecord(current, next);
      return publicJob(next, this.#active.get(jobId)?.finalSwitched === true);
    });
  }

  #replaceRecord(current: StoredSkillPublicationJob, next: StoredSkillPublicationJob): void {
    if (this.#records.get(current.id) !== current) throw new Error("Skill publication changed concurrently.");
    this.#records.set(next.id, next);
    try {
      this.#persist();
    } catch (error) {
      this.#records.set(current.id, current);
      throw error;
    }
  }

  #catalogReplacing(record: StoredSkillPublicationJob): StoredSkillPublicationCatalog {
    return {
      format: 1,
      records: [...this.#records.values()]
        .map((current) => current.id === record.id ? record : current)
        .sort((left, right) => left.id.localeCompare(right.id, "en"))
    };
  }

  #persist(store: OperationalStore = this.#store): void {
    store.setSetting("service", this.#scopeId, SETTING_KEY, {
      format: 1,
      records: [...this.#records.values()].sort((left, right) => left.id.localeCompare(right.id, "en"))
    } satisfies StoredSkillPublicationCatalog);
  }

  #require(jobId: string): StoredSkillPublicationJob {
    const record = this.#records.get(normalizedJobId(jobId));
    if (record === undefined) throw new Error("Skill publication job does not exist.");
    return record;
  }

  #mutate<T>(callback: () => Promise<T>): Promise<T> {
    const operation = this.#tail.then(callback, callback);
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new Error("Skill publication manager is not initialized.");
  }
}

function publicationAuthority(
  resource: PiResourceDescriptor,
  lease: PiSkillContentLease,
  source: SkillMarketSourceDescriptor,
  existingEntryId?: string
): SkillPublicationAuthority {
  return {
    resourceId: resource.id,
    resourceRevision: resource.versionNumber,
    observedRevision: lease.observedRevision,
    backendId: resource.backendId,
    ...(resource.targetId === undefined ? {} : { targetId: resource.targetId }),
    scope: resource.scope === "project" ? "project" : "global",
    sourceId: source.id,
    sourceRevision: source.revision,
    sourceContentRevision: source.contentRevision,
    sourceDisplay: source.display,
    ...(existingEntryId === undefined ? {} : { existingEntryId })
  };
}

function storedAuthority(value: SkillPublicationAuthority): StoredSkillPublicationAuthority {
  return {
    ...value,
    resourceRevision: value.resourceRevision.toString(10),
    sourceRevision: value.sourceRevision.toString(10)
  };
}

function publicAuthority(value: StoredSkillPublicationAuthority): SkillPublicationAuthority {
  return {
    ...value,
    resourceRevision: BigInt(value.resourceRevision),
    sourceRevision: BigInt(value.sourceRevision)
  };
}

function storedResult(value: SkillPublicationResult): StoredSkillPublicationResult {
  return {
    ...value,
    sourceRevision: value.sourceRevision.toString(10),
    entryRevision: value.entryRevision.toString(10)
  };
}

function publicResult(value: StoredSkillPublicationResult): SkillPublicationResult {
  return {
    ...value,
    sourceRevision: BigInt(value.sourceRevision),
    entryRevision: BigInt(value.entryRevision)
  };
}

function publicJob(value: StoredSkillPublicationJob, finalSwitched: boolean): SkillPublicationJob {
  return {
    id: value.id,
    revision: BigInt(value.revision),
    state: value.state,
    authority: publicAuthority(value.authority),
    metadata: { ...value.metadata, tags: [...value.metadata.tags] },
    publisher: value.publisher,
    visibility: value.visibility,
    gates: copyGates(value.gates),
    verdict: value.verdict,
    files: value.files,
    uncompressedBytes: value.uncompressedBytes,
    archiveBytes: value.archiveBytes,
    attempt: value.attempt,
    ...(value.retryOfJobId === undefined ? {} : { retryOfJobId: value.retryOfJobId }),
    ...(value.result === undefined ? {} : { result: publicResult(value.result) }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.completedAt === undefined ? {} : { completedAt: value.completedAt }),
    ...(value.error === undefined ? {} : { error: value.error }),
    cancellable: !TERMINAL.has(value.state) && value.state !== "reconciling" && !(value.state === "committing" && finalSwitched)
  };
}

function copyMarketEntry(value: SkillMarketCatalogItem): SkillMarketCatalogItem {
  return {
    ...value,
    tags: [...value.tags],
    installStatuses: value.installStatuses.map((status) => ({ ...status }))
  };
}

function pendingPublicationGates(): readonly SkillPublicationGate[] {
  return [
    { id: "metadata", label: "Metadata", status: "pending", issues: [] },
    { id: "package", label: "Package", status: "pending", issues: [] },
    { id: "sensitive_content", label: "Sensitive content", status: "pending", issues: [] },
    { id: "source_authority", label: "Destination authority", status: "pending", issues: [] }
  ];
}

function copyGates(value: readonly SkillPublicationGate[]): readonly SkillPublicationGate[] {
  return value.map((gate) => ({
    ...gate,
    issues: gate.issues.map((issue) => ({ ...issue }))
  }));
}

function publishedJob(
  current: StoredSkillPublicationJob,
  publication: SkillMarketPublicationResult,
  at: number
): StoredSkillPublicationJob {
  const { error: _error, ...base } = current;
  return {
    ...base,
    revision: increment(current.revision),
    state: "published",
    gates: current.gates.map((gate) => ({ ...gate, status: "passed", issues: [] })),
    verdict: "passed",
    result: storedResult({
      sourceId: publication.source.id,
      sourceRevision: publication.source.revision,
      entryId: publication.entry.id,
      entryRevision: publication.entry.revision,
      entryContentRevision: publication.entry.contentRevision,
      version: publication.entry.version
    }),
    updatedAt: at,
    completedAt: at
  };
}

function terminalJob(
  current: StoredSkillPublicationJob,
  state: Extract<SkillPublicationState, "blocked" | "failed" | "cancelled">,
  at: number
): StoredSkillPublicationJob {
  const { result: _result, completedAt: _completedAt, error: _error, ...base } = current;
  return {
    ...base,
    revision: increment(current.revision),
    state,
    updatedAt: at,
    completedAt: at,
    ...(state === "cancelled" ? { error: "Skill publication was cancelled before the final manifest switch." } : {})
  };
}

function resetPendingAfterRestart(current: StoredSkillPublicationJob, at: number): StoredSkillPublicationJob {
  const {
    result: _result,
    intent: _intent,
    completedAt: _completedAt,
    error: _error,
    ...base
  } = current;
  return {
    ...base,
    revision: increment(current.revision),
    state: "pending",
    gates: pendingPublicationGates(),
    verdict: "pending",
    files: 0,
    uncompressedBytes: 0,
    archiveBytes: 0,
    updatedAt: at
  };
}

function suggestedPublicationSlug(resource: PiResourceDescriptor): string {
  const normalized = resource.name.normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 100)
    .replace(/-+$/u, "");
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(normalized)) return normalized;
  return `skill-${createHash("sha256").update(resource.id).digest("hex").slice(0, 12)}`;
}

function suggestedPublicationVersion(resourceVersion: string | undefined, existingVersion: string | undefined): string {
  if (existingVersion !== undefined) return semver.inc(existingVersion, "patch") ?? "1.0.0";
  return resourceVersion !== undefined
    && /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(resourceVersion)
    && semver.valid(resourceVersion) === resourceVersion
    ? resourceVersion
    : "1.0.0";
}

async function stagePublishedSkillManifest(
  root: string,
  slug: string,
  version: string,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted();
  const path = join(root, "SKILL.md");
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAXIMUM_SCAN_TEXT_BYTES) {
    throw new Error("Skill SKILL.md must be a bounded regular UTF-8 file before publication.");
  }
  const canonical = await realpath(path);
  assertWithin(root, canonical, "Skill publication manifest");
  if (resolve(canonical) !== resolve(path)) throw new Error("Skill publication manifest contains a path alias or junction.");
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const normalized = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const match = /^(?:---)[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u.exec(normalized);
  let next: string;
  if (match === null) {
    next = `---${newline}name: ${slug}${newline}version: ${version}${newline}---${newline}${normalized}`;
  } else {
    const document = parseDocument(match[1]!, { schema: "core", prettyErrors: false });
    if (document.errors.length > 0) throw new Error("Skill frontmatter must be valid before publication.");
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Skill frontmatter must be a mapping before publication.");
    }
    if (!("name" in value) || typeof (value as Record<string, unknown>)["name"] !== "string"
      || String((value as Record<string, unknown>)["name"]).trim() === "") {
      document.set("name", slug);
    }
    document.set("version", version);
    const frontmatter = document.toString({ lineWidth: 0 }).trimEnd().replaceAll("\n", newline);
    next = `---${newline}${frontmatter}${newline}---${newline}${normalized.slice(match[0].length)}`;
  }
  const bytes = Buffer.from(next, "utf8");
  if (bytes.length > MAXIMUM_SCAN_TEXT_BYTES) throw new Error("Published SKILL.md exceeds its size limit.");
  const temporary = join(root, `.SKILL.md.publish-${createHash("sha256").update(`${slug}\0${version}`).digest("hex").slice(0, 16)}`);
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  const handle = await open(temporary, constants.O_RDWR);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  signal.throwIfAborted();
  await rename(temporary, path);
}

async function createSkillPublicationArchive(root: string, archivePath: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const entries = (await readdir(root)).sort((left, right) => left.localeCompare(right, "en"));
  if (entries.length === 0) throw new Error("Skill publication snapshot is empty.");
  await createTarArchive({
    cwd: root,
    file: archivePath,
    gzip: true,
    portable: true,
    noMtime: true,
    prefix: "package/",
    strict: true,
    follow: false,
    onWriteEntry: () => signal.throwIfAborted()
  }, entries);
  signal.throwIfAborted();
}

async function hashPublicationArchive(path: string, signal: AbortSignal): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 200 * 1024 * 1024) {
    throw new Error("Generated Skill publication archive is not a bounded regular file.");
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer);
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error("Generated Skill publication archive changed while it was hashed.");
  }
  return { bytes: before.size, sha256: hash.digest("hex") };
}

async function scanPublication(
  root: string,
  job: StoredSkillPublicationJob,
  market: SkillMarketManager,
  signal: AbortSignal
): Promise<readonly SkillPublicationGate[]> {
  const sensitiveIssues = await scanSensitiveContent(root, signal);
  const sourceIssues: SkillPublicationGateIssue[] = [];
  try {
    await market.verifyPublicationTarget({
      sourceId: job.authority.sourceId,
      expectedRevision: BigInt(job.authority.sourceRevision),
      expectedContentRevision: job.authority.sourceContentRevision,
      slug: job.metadata.slug,
      ...(job.authority.existingEntryId === undefined ? {} : { expectedExistingEntryId: job.authority.existingEntryId }),
      signal
    });
  } catch (error) {
    sourceIssues.push({ code: "SOURCE_AUTHORITY_CHANGED", message: publicError(error) });
  }
  return [
    { id: "metadata", label: "Metadata", status: "passed", issues: [] },
    { id: "package", label: "Package", status: "passed", issues: [] },
    {
      id: "sensitive_content",
      label: "Sensitive content",
      status: sensitiveIssues.length === 0 ? "passed" : "blocked",
      issues: sensitiveIssues
    },
    {
      id: "source_authority",
      label: "Destination authority",
      status: sourceIssues.length === 0 ? "passed" : "blocked",
      issues: sourceIssues
    }
  ];
}

async function scanSensitiveContent(root: string, signal: AbortSignal): Promise<readonly SkillPublicationGateIssue[]> {
  const canonicalRoot = await realpath(root);
  const issues: SkillPublicationGateIssue[] = [];
  const visit = async (directory: string, parentKey: string): Promise<void> => {
    if (issues.length >= MAXIMUM_GATE_ISSUES) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      signal.throwIfAborted();
      if (issues.length >= MAXIMUM_GATE_ISSUES) return;
      const key = parentKey === "" ? entry.name : `${parentKey}/${entry.name}`;
      const path = join(directory, entry.name);
      const before = await lstat(path);
      if (entry.isSymbolicLink() || before.isSymbolicLink()) throw new Error("Skill publication scan encountered a link or junction.");
      const canonical = await realpath(path);
      assertWithin(canonicalRoot, canonical, "Skill publication scan");
      if (resolve(path) !== resolve(canonical)) throw new Error("Skill publication scan encountered a path alias or junction.");
      if (isSensitiveSkillPath(key)) {
        issues.push({ code: "SENSITIVE_PATH", message: "A credential- or service-private path cannot be published.", path: key });
        continue;
      }
      if (entry.isDirectory() && before.isDirectory()) {
        await visit(path, key);
        continue;
      }
      if (!entry.isFile() || !before.isFile()) throw new Error("Skill publication scan encountered a special file.");
      if (await fileLooksLikeSecretMaterial(path, signal)) {
        issues.push({ code: "SECRET_MATERIAL", message: "High-confidence secret material must be removed before publication.", path: key });
      }
      const after = await lstat(path);
      if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.dev !== after.dev || before.ino !== after.ino) {
        throw new Error("Skill publication content changed while it was scanned.");
      }
    }
  };
  await visit(canonicalRoot, "");
  return issues;
}

async function fileLooksLikeSecretMaterial(path: string, signal: AbortSignal): Promise<boolean> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let tail = "";
  try {
    for await (const chunk of createReadStream(path, { signal })) {
      const text = tail + decoder.decode(chunk as Buffer, { stream: true });
      if (looksLikeSecretMaterial(text)) return true;
      // Retain enough overlap to catch any high-confidence marker split across
      // stream chunks without loading a large text asset into memory.
      tail = text.slice(-4_096);
    }
    return looksLikeSecretMaterial(tail + decoder.decode());
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

function assertStandalonePublicationResource(resource: PiResourceDescriptor): void {
  if (resource.kind !== "skill" || resource.sourceKind !== "local" && resource.sourceKind !== "skill_market") {
    throw new Error("Only independently managed local Skills can be published.");
  }
}

async function assertCanonicalDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a regular directory.`);
  if (resolve(await realpath(path)) !== resolve(path)) throw new Error(`${label} contains a path alias or junction.`);
}

async function clearOwnedWorkingDirectory(path: string): Promise<void> {
  const exact = normalizedAbsolute(path, "Skill publication working directory");
  if (dirname(exact) === exact) throw new Error("Refusing to clear a filesystem root.");
  await rm(exact, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
}

async function removeOwnedWorkingDirectory(owner: string, path: string): Promise<void> {
  const root = normalizedAbsolute(owner, "Skill publication working owner");
  const candidate = normalizedAbsolute(path, "Skill publication working path");
  assertWithin(root, candidate, "Skill publication working path");
  if (candidate === root) throw new Error("Refusing to remove the Skill publication working owner.");
  await rm(candidate, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
}

function normalizedAbsolute(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value) throw new Error(`${label} must be a normalized absolute path.`);
  return value;
}

function assertWithin(root: string, candidate: string, label: string): void {
  const suffix = relative(resolve(root), resolve(candidate));
  if (suffix === "" || !suffix.startsWith("..") && !isAbsolute(suffix)) return;
  throw new Error(`${label} escapes its owner.`);
}

function normalizedJobId(value: string): string {
  const id = value.trim();
  if (!JOB_ID.test(id)) throw new Error("Skill publication job ID is invalid.");
  return id;
}

function entityId(value: string, label: string): string {
  const id = value.trim();
  if (!ENTITY_ID.test(id)) throw new Error(`${label} is invalid.`);
  return id;
}

function contentRevision(value: string, label: string): string {
  if (!CONTENT_REVISION.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function positiveRevision(value: bigint, label: string): bigint {
  if (value < 1n) throw new Error(`${label} is invalid.`);
  return value;
}

function increment(value: string): string {
  if (!DECIMAL.test(value)) throw new Error("Stored Skill publication revision is invalid.");
  return (BigInt(value) + 1n).toString(10);
}

function publicError(error: unknown): string {
  const message = redactSecrets(error instanceof Error ? error.message : String(error))
    .replace(/(["'])(?:[A-Za-z]:\\|\\\\|\/)[^"'\r\n]+\1/gu, "[path]")
    .replace(/[A-Za-z]:\\[^\s"']+/gu, "[path]")
    .replace(/\\\\[^\s"']+/gu, "[path]")
    .replace(/(?:^|\s)\/(?:[^\s"']+\/)+[^\s"']*/gu, " [path]")
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .trim();
  return message.slice(0, 2_048) || "Skill publication failed.";
}

function isSkillPublicationState(value: unknown): value is SkillPublicationState {
  return value === "pending" || value === "snapshotting" || value === "packaging" || value === "scanning"
    || value === "committing" || value === "reconciling" || value === "cancelling" || value === "published"
    || value === "blocked" || value === "failed" || value === "cancelled";
}

function validateStoredCatalog(value: unknown, maximumRecords: number): StoredSkillPublicationCatalog {
  const object = strictObject(value, ["format", "records"], "Skill publication catalog");
  if (object.format !== 1 || !Array.isArray(object.records) || object.records.length > maximumRecords) {
    throw new Error("Skill publication catalog is invalid.");
  }
  const records = object.records.map(validateStoredJob);
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    throw new Error("Skill publication catalog contains duplicate job IDs.");
  }
  return { format: 1, records };
}

function validateStoredJob(value: unknown): StoredSkillPublicationJob {
  const object = strictObject(value, [
    "id", "revision", "state", "authority", "metadata", "publisher", "visibility", "gates", "verdict",
    "files", "uncompressedBytes", "archiveBytes", "attempt", "retryOfJobId", "intent", "result",
    "createdAt", "updatedAt", "completedAt", "error"
  ], "Skill publication job");
  const id = normalizedJobId(stringValue(object.id, "Skill publication job ID"));
  const revision = storedPositiveRevision(object.revision, "Skill publication revision");
  if (!isSkillPublicationState(object.state)) throw new Error("Skill publication state is invalid.");
  const state = object.state;
  const authority = validateStoredAuthority(object.authority);
  const metadata = normalizeSkillMarketPublicationMetadata(object.metadata as SkillMarketPublicationMetadata);
  if (object.publisher !== "personal" || object.visibility !== "public") {
    throw new Error("Stored Skill publication publisher or visibility is invalid.");
  }
  const gates = validateStoredGates(object.gates);
  if (object.verdict !== "pending" && object.verdict !== "passed" && object.verdict !== "blocked") {
    throw new Error("Skill publication verdict is invalid.");
  }
  const verdict = object.verdict;
  const files = nonNegativeSafeInteger(object.files, "Skill publication file count");
  const uncompressedBytes = nonNegativeSafeInteger(object.uncompressedBytes, "Skill publication byte count");
  const archiveBytes = nonNegativeSafeInteger(object.archiveBytes, "Skill publication archive byte count");
  const attempt = positiveSafeInteger(object.attempt, "Skill publication attempt");
  const retryOfJobId = object.retryOfJobId === undefined
    ? undefined
    : normalizedJobId(stringValue(object.retryOfJobId, "Retried Skill publication job ID"));
  const intent = object.intent === undefined ? undefined : validateStoredIntent(object.intent);
  const result = object.result === undefined ? undefined : validateStoredResult(object.result);
  const createdAt = finiteTime(object.createdAt, "Skill publication creation time");
  const updatedAt = finiteTime(object.updatedAt, "Skill publication update time");
  const completedAt = object.completedAt === undefined ? undefined : finiteTime(object.completedAt, "Skill publication completion time");
  const error = object.error === undefined ? undefined : boundedStoredError(object.error);
  if (updatedAt < createdAt || completedAt !== undefined && completedAt < updatedAt) {
    throw new Error("Skill publication timestamps are invalid.");
  }
  if ((TERMINAL.has(state)) !== (completedAt !== undefined)) throw new Error("Skill publication terminal state is inconsistent.");
  if ((state === "published") !== (result !== undefined)) throw new Error("Skill publication result is inconsistent.");
  if (["committing", "reconciling", "published"].includes(state) && intent === undefined) {
    throw new Error("Committed Skill publication is missing its recovery intent.");
  }
  if (state === "published" && (verdict !== "passed" || gates.some((gate) => gate.status !== "passed"))) {
    throw new Error("Published Skill publication has an invalid verdict.");
  }
  if (state === "blocked" && (verdict !== "blocked" || !gates.some((gate) => gate.status === "blocked"))) {
    throw new Error("Blocked Skill publication has an invalid verdict.");
  }
  if ((state === "failed" || state === "reconciling" || state === "cancelled") && error === undefined) {
    throw new Error("Skill publication failure state is missing its public error.");
  }
  return {
    id,
    revision,
    state,
    authority,
    metadata,
    publisher: "personal",
    visibility: "public",
    gates,
    verdict,
    files,
    uncompressedBytes,
    archiveBytes,
    attempt,
    ...(retryOfJobId === undefined ? {} : { retryOfJobId }),
    ...(intent === undefined ? {} : { intent }),
    ...(result === undefined ? {} : { result }),
    createdAt,
    updatedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(error === undefined ? {} : { error })
  };
}

function validateStoredAuthority(value: unknown): StoredSkillPublicationAuthority {
  const object = strictObject(value, [
    "resourceId", "resourceRevision", "observedRevision", "backendId", "targetId", "scope", "sourceId",
    "sourceRevision", "sourceContentRevision", "sourceDisplay", "existingEntryId"
  ], "Skill publication authority");
  if (object.scope !== "global" && object.scope !== "project") throw new Error("Skill publication scope is invalid.");
  const targetId = object.targetId === undefined ? undefined : entityId(stringValue(object.targetId, "Target ID"), "Target ID");
  if ((object.scope === "project") !== (targetId !== undefined)) throw new Error("Skill publication Target authority is invalid.");
  const sourceDisplay = boundedText(stringValue(object.sourceDisplay, "Skill market source display"), 256, "Skill market source display");
  if (sourceDisplay.includes("/") || sourceDisplay.includes("\\")) throw new Error("Skill market source display cannot contain a path.");
  const existingEntryId = object.existingEntryId === undefined
    ? undefined
    : entityId(stringValue(object.existingEntryId, "Existing Skill market entry ID"), "Existing Skill market entry ID");
  return {
    resourceId: entityId(stringValue(object.resourceId, "Skill Resource ID"), "Skill Resource ID"),
    resourceRevision: storedPositiveRevision(object.resourceRevision, "Skill Resource revision"),
    observedRevision: contentRevision(stringValue(object.observedRevision, "Skill observed revision"), "Skill observed revision"),
    backendId: entityId(stringValue(object.backendId, "Backend ID"), "Backend ID"),
    ...(targetId === undefined ? {} : { targetId }),
    scope: object.scope,
    sourceId: entityId(stringValue(object.sourceId, "Skill market source ID"), "Skill market source ID"),
    sourceRevision: storedPositiveRevision(object.sourceRevision, "Skill market source revision"),
    sourceContentRevision: contentRevision(
      stringValue(object.sourceContentRevision, "Skill market source content revision"),
      "Skill market source content revision"
    ),
    sourceDisplay,
    ...(existingEntryId === undefined ? {} : { existingEntryId })
  };
}

function validateStoredResult(value: unknown): StoredSkillPublicationResult {
  const object = strictObject(value, [
    "sourceId", "sourceRevision", "entryId", "entryRevision", "entryContentRevision", "version"
  ], "Skill publication result");
  const version = stringValue(object.version, "Published Skill version");
  if (semver.valid(version) !== version) throw new Error("Published Skill version is invalid.");
  return {
    sourceId: entityId(stringValue(object.sourceId, "Skill market source ID"), "Skill market source ID"),
    sourceRevision: storedPositiveRevision(object.sourceRevision, "Skill market source revision"),
    entryId: entityId(stringValue(object.entryId, "Skill market entry ID"), "Skill market entry ID"),
    entryRevision: storedPositiveRevision(object.entryRevision, "Skill market entry revision"),
    entryContentRevision: contentRevision(
      stringValue(object.entryContentRevision, "Skill market entry content revision"),
      "Skill market entry content revision"
    ),
    version
  };
}

function validateStoredIntent(value: unknown): SkillMarketPublicationIntent {
  const object = strictObject(value, [
    "beforeManifestSha256", "nextManifestSha256", "archiveRelativePath", "archiveBytes", "archiveSha256"
  ], "Skill publication commit intent");
  const beforeManifestSha256 = storedSha256(object.beforeManifestSha256, "Previous manifest SHA-256");
  const nextManifestSha256 = storedSha256(object.nextManifestSha256, "Next manifest SHA-256");
  const archiveSha256 = storedSha256(object.archiveSha256, "Publication archive SHA-256");
  const archiveRelativePath = stringValue(object.archiveRelativePath, "Publication archive relative path");
  if (archiveRelativePath.length > 512 || archiveRelativePath.includes("\\") || archiveRelativePath.startsWith("/")
    || archiveRelativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Publication archive relative path is invalid.");
  }
  const archiveBytes = positiveSafeInteger(object.archiveBytes, "Publication archive byte count");
  if (archiveBytes > 200 * 1024 * 1024) throw new Error("Publication archive byte count is invalid.");
  return { beforeManifestSha256, nextManifestSha256, archiveRelativePath, archiveBytes, archiveSha256 };
}

function validateStoredGates(value: unknown): readonly SkillPublicationGate[] {
  if (!Array.isArray(value) || value.length !== 4) throw new Error("Skill publication gates are invalid.");
  const expectedIds: SkillPublicationGate["id"][] = ["metadata", "package", "sensitive_content", "source_authority"];
  return value.map((raw, index) => {
    const object = strictObject(raw, ["id", "label", "status", "issues"], "Skill publication gate");
    if (object.id !== expectedIds[index]) throw new Error("Skill publication gate identity is invalid.");
    if (object.status !== "pending" && object.status !== "passed" && object.status !== "blocked") {
      throw new Error("Skill publication gate status is invalid.");
    }
    if (!Array.isArray(object.issues) || object.issues.length > MAXIMUM_GATE_ISSUES) {
      throw new Error("Skill publication gate issues are invalid.");
    }
    const issues = object.issues.map((issue) => {
      const item = strictObject(issue, ["code", "message", "path"], "Skill publication gate issue");
      const code = stringValue(item.code, "Skill publication gate issue code");
      if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) throw new Error("Skill publication gate issue code is invalid.");
      const message = boundedText(stringValue(item.message, "Skill publication gate issue message"), 512, "Skill publication gate issue message");
      const path = item.path === undefined ? undefined : portableIssuePath(stringValue(item.path, "Skill publication gate issue path"));
      return { code, message, ...(path === undefined ? {} : { path }) };
    });
    return {
      id: object.id,
      label: boundedText(stringValue(object.label, "Skill publication gate label"), 80, "Skill publication gate label"),
      status: object.status,
      issues
    } as SkillPublicationGate;
  });
}

function portableIssuePath(value: string): string {
  if (value === "" || value.length > 512 || value.includes("\\") || value.startsWith("/") || isAbsolute(value)
    || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Skill publication gate issue path is invalid.");
  }
  return value;
}

function strictObject(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key))) throw new Error(`${label} contains unsupported current-v1 fields.`);
  return object;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  return value;
}

function storedPositiveRevision(value: unknown, label: string): string {
  if (typeof value !== "string" || !DECIMAL.test(value) || value === "0") throw new Error(`${label} is invalid.`);
  return value;
}

function storedSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  const result = nonNegativeSafeInteger(value, label);
  if (result < 1) throw new Error(`${label} is invalid.`);
  return result;
}

function finiteTime(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
  return value;
}

function boundedStoredError(value: unknown): string {
  const error = stringValue(value, "Skill publication error");
  if (error !== publicError(error)) throw new Error("Skill publication error is not safely bounded.");
  return error;
}

function boundedText(value: string, maximum: number, label: string): string {
  if (value !== value.trim() || value === "" || value.length > maximum
    || /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
