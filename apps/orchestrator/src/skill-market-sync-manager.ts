import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import type { OperationalStore } from "@joko/store";

import type { PiMarketSkillTargetInput, PiResourceDescriptor, PiResourceManager } from "./resource-manager.js";
import {
  SkillMarketManager,
  type PreparedSkillMarketInstallation,
  type SkillMarketCatalogItem,
  type SkillMarketEntryIdentity
} from "./skill-market-manager.js";

export type SkillMarketSyncJobState =
  | "pending_revalidation"
  | "running"
  | "cancelling"
  | "succeeded"
  | "up_to_date"
  | "blocked"
  | "failed"
  | "cancelled";

export type SkillMarketSyncOutcome =
  | "UPDATED"
  | "ALREADY_CURRENT"
  | "DOWNGRADE_BLOCKED"
  | "DIRTY_CONTENT"
  | "OWNER_CHANGED"
  | "TARGET_CHANGED"
  | "RESOURCE_REMOVED"
  | "CANCELLED";

export interface SkillMarketSyncTarget {
  readonly backendId: string;
  readonly scope: "global" | "project";
  readonly targetId?: string;
  readonly relativeParent?: string;
  readonly targetRevision?: bigint;
}

export interface SkillMarketSyncBaseline {
  readonly resourceVersion: bigint;
  readonly resourceContentRevision: string;
  readonly installedContentRevision: string;
  readonly installedVersion: string;
  readonly sourceRevision: bigint;
  readonly entryRevision: bigint;
  readonly entryContentRevision: string;
}

export interface SkillMarketSyncPolicy {
  readonly resourceId: string;
  readonly revision: bigint;
  readonly enabled: boolean;
  readonly sourceId: string;
  readonly entryId: string;
  readonly target: SkillMarketSyncTarget;
  readonly baseline: SkillMarketSyncBaseline;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly disabledReason?: "user" | "resource_removed";
}

export interface SkillMarketSyncJobAuthority {
  readonly sourceId: string;
  readonly entryId: string;
  readonly target: SkillMarketSyncTarget;
  readonly baseline: SkillMarketSyncBaseline;
}

export interface SkillMarketSyncJob {
  readonly id: string;
  readonly revision: bigint;
  readonly state: SkillMarketSyncJobState;
  readonly policyResourceId: string;
  readonly policyRevision: bigint;
  readonly authority: SkillMarketSyncJobAuthority;
  readonly attempt: number;
  readonly retryOfJobId?: string;
  readonly availableVersion?: string;
  readonly outcome?: SkillMarketSyncOutcome;
  readonly error?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export interface EnableSkillMarketSyncInput {
  readonly resourceId: string;
  readonly expectedResourceVersion: bigint;
  readonly target: PiMarketSkillTargetInput;
}

export interface SkillMarketSyncManagerOptions {
  readonly store: OperationalStore;
  readonly resources: PiResourceManager;
  readonly market: SkillMarketManager;
  readonly scopeId?: string;
  readonly now?: () => number;
  readonly maximumJobs?: number;
  /** Reconciles the derived Backend runtime generation after atomic Resource adoption. */
  readonly onResourceCommitted?: (resource: {
    readonly resourceId: string;
    readonly backendId: string;
  }) => void | Promise<void>;
  /** Deterministic owning-test seam; production leaves it undefined. */
  readonly afterJobPersisted?: (job: SkillMarketSyncJob) => void | Promise<void>;
}

export interface PreparedSkillMarketSyncRemoval {
  readonly finalize: (store: OperationalStore) => void;
  readonly committed: () => void;
  readonly rolledBack: () => void;
}

interface StoredSyncTarget extends Omit<SkillMarketSyncTarget, "targetRevision"> {
  readonly targetRevision?: string;
}

interface StoredSyncBaseline extends Omit<SkillMarketSyncBaseline, "resourceVersion" | "sourceRevision" | "entryRevision"> {
  readonly resourceVersion: string;
  readonly sourceRevision: string;
  readonly entryRevision: string;
}

interface StoredSyncPolicy extends Omit<SkillMarketSyncPolicy, "revision" | "target" | "baseline"> {
  readonly revision: string;
  readonly target: StoredSyncTarget;
  readonly baseline: StoredSyncBaseline;
}

interface StoredSyncJobAuthority extends Omit<SkillMarketSyncJobAuthority, "target" | "baseline"> {
  readonly target: StoredSyncTarget;
  readonly baseline: StoredSyncBaseline;
}

interface StoredSyncJob extends Omit<SkillMarketSyncJob, "revision" | "policyRevision" | "authority"> {
  readonly revision: string;
  readonly policyRevision: string;
  readonly authority: StoredSyncJobAuthority;
}

interface StoredSyncCatalog {
  readonly format: 1;
  readonly policies: readonly StoredSyncPolicy[];
  readonly jobs: readonly StoredSyncJob[];
}

interface ActiveSyncJob {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
}

interface SyncRunContext {
  readonly job: StoredSyncJob;
  readonly policy: StoredSyncPolicy;
  readonly resource: PiResourceDescriptor;
  readonly entry: SkillMarketCatalogItem;
}

const SYNC_SETTING_KEY = "skill_market_sync";
const JOB_ID = /^skill_sync_[a-f0-9]{32}$/u;
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SOURCE_ID = /^skill_market_source_[a-f0-9]{32}$/u;
const ENTRY_ID = /^skill_market_entry_[a-f0-9]{32}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const CONTENT_REVISION = /^sha256:[a-f0-9]{64}$/u;
const ACTIVE_STATES = new Set<SkillMarketSyncJobState>(["pending_revalidation", "running", "cancelling"]);
const TERMINAL_STATES = new Set<SkillMarketSyncJobState>(["succeeded", "up_to_date", "blocked", "failed", "cancelled"]);
const MAXIMUM_POLICIES = 2_000;
const DEFAULT_MAXIMUM_JOBS = 512;
const semver = createRequire(import.meta.url)("semver") as {
  valid(version: string): string | null;
  compare(left: string, right: string): number;
};

class SyncAuthorityError extends Error {
  constructor(
    readonly outcome: Exclude<SkillMarketSyncOutcome, "UPDATED" | "ALREADY_CURRENT" | "CANCELLED">,
    message: string,
    readonly disablePolicy = false
  ) {
    super(message);
    this.name = "SyncAuthorityError";
  }
}

/** Durable, per-installed-Resource opt-in synchronization owner. */
export class SkillMarketSyncManager {
  readonly #store: OperationalStore;
  readonly #resources: PiResourceManager;
  readonly #market: SkillMarketManager;
  readonly #scopeId: string;
  readonly #now: () => number;
  readonly #maximumJobs: number;
  readonly #onResourceCommitted?: SkillMarketSyncManagerOptions["onResourceCommitted"];
  readonly #afterJobPersisted?: SkillMarketSyncManagerOptions["afterJobPersisted"];
  readonly #policies = new Map<string, StoredSyncPolicy>();
  readonly #jobs = new Map<string, StoredSyncJob>();
  readonly #active = new Map<string, ActiveSyncJob>();
  #tail: Promise<unknown> = Promise.resolve();
  #initialized = false;
  #closing = false;
  #recoveredFromCorruption = false;

  constructor(options: SkillMarketSyncManagerOptions) {
    this.#store = options.store;
    this.#resources = options.resources;
    this.#market = options.market;
    this.#scopeId = options.scopeId ?? "orchestrator";
    this.#now = options.now ?? Date.now;
    this.#maximumJobs = options.maximumJobs ?? DEFAULT_MAXIMUM_JOBS;
    this.#onResourceCommitted = options.onResourceCommitted;
    this.#afterJobPersisted = options.afterJobPersisted;
    if (!Number.isSafeInteger(this.#maximumJobs) || this.#maximumJobs < 1 || this.#maximumJobs > 10_000) {
      throw new RangeError("Skill market sync job limit is invalid.");
    }
  }

  get recoveredFromCorruption(): boolean {
    this.#assertUsable();
    return this.#recoveredFromCorruption;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    const setting = this.#store.findSetting<unknown>("service", this.#scopeId, SYNC_SETTING_KEY);
    if (setting !== undefined) {
      try {
        const catalog = validateStoredCatalog(setting.value, this.#maximumJobs);
        for (const policy of catalog.policies) this.#policies.set(policy.resourceId, policy);
        for (const job of catalog.jobs) this.#jobs.set(job.id, job);
      } catch {
        this.#policies.clear();
        this.#jobs.clear();
        this.#recoveredFromCorruption = true;
        this.#persist();
      }
    }
    let recovered = false;
    const now = this.#now();
    for (const [id, job] of this.#jobs) {
      if (job.state !== "running" && job.state !== "cancelling") continue;
      this.#jobs.set(id, {
        ...withoutTerminalJobFields(job),
        revision: increment(job.revision),
        state: "pending_revalidation",
        updatedAt: now
      });
      recovered = true;
    }
    if (recovered) this.#persist();
    this.#initialized = true;
  }

  listPolicies(): readonly SkillMarketSyncPolicy[] {
    this.#assertUsable();
    return [...this.#policies.values()]
      .sort((left, right) => left.resourceId.localeCompare(right.resourceId, "en"))
      .map(publicPolicy);
  }

  getPolicy(resourceId: string): SkillMarketSyncPolicy {
    this.#assertUsable();
    const policy = this.#policies.get(entityId(resourceId, "Resource ID"));
    if (policy === undefined) throw new Error("Skill market sync policy does not exist.");
    return publicPolicy(policy);
  }

  listJobs(input: { readonly resourceId?: string } = {}): readonly SkillMarketSyncJob[] {
    this.#assertUsable();
    const resourceId = input.resourceId === undefined ? undefined : entityId(input.resourceId, "Resource ID");
    return [...this.#jobs.values()]
      .filter((job) => resourceId === undefined || job.policyResourceId === resourceId)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id, "en"))
      .map(publicJob);
  }

  getJob(jobId: string): SkillMarketSyncJob {
    this.#assertUsable();
    const job = this.#jobs.get(normalizedJobId(jobId));
    if (job === undefined) throw new Error("Skill market sync job does not exist.");
    return publicJob(job);
  }

  async enable(input: EnableSkillMarketSyncInput, signal?: AbortSignal): Promise<SkillMarketSyncPolicy> {
    this.#assertUsable();
    signal?.throwIfAborted();
    const current = this.#resources.get(entityId(input.resourceId, "Resource ID"));
    if (current.versionNumber !== input.expectedResourceVersion) throw new Error("Skill Resource changed before sync opt-in.");
    assertSyncableResource(current);
    const entry = this.#market.getCurrentEntry(current.skillMarket!.sourceId, current.skillMarket!.entryId);
    if (entry.sourceState !== "ready") throw new Error("Skill market source is not currently available for synchronization.");

    const validationConnection = `skill-sync-policy-${randomUUID().replaceAll("-", "")}`;
    try {
      const plan = await this.#market.createInstallPlan(validationConnection, entryIdentity(entry), input.target, signal);
      const observed = plan.resourcePreview.currentResource;
      if (
        observed === undefined || observed.resourceId !== current.id || observed.resourceVersion !== current.versionNumber
        || observed.observedRevision !== current.discoveredRevision || observed.dirty || plan.resourcePreview.sourceReplacement
      ) throw new Error("Skill sync target does not match the exact installed market Resource.");
    } finally {
      await this.#market.closeConnection(validationConnection);
    }

    signal?.throwIfAborted();
    const exact = this.#resources.get(current.id);
    assertSameSyncResource(current, exact);
    const target = this.#validatedTarget(input.target, exact);
    return this.#mutate(async () => {
      this.#assertNoActiveJob(current.id);
      const previous = this.#policies.get(current.id);
      const now = this.#now();
      const next: StoredSyncPolicy = {
        resourceId: current.id,
        revision: previous === undefined ? "1" : increment(previous.revision),
        enabled: true,
        sourceId: current.skillMarket!.sourceId,
        entryId: current.skillMarket!.entryId,
        target: storedTarget(target),
        baseline: storedBaseline(baselineFromResource(current)),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      };
      const policies = new Map(this.#policies).set(next.resourceId, next);
      this.#persist(policies, this.#jobs);
      this.#replacePolicies(policies);
      return publicPolicy(next);
    });
  }

  async disable(resourceId: string, expectedRevision: bigint): Promise<SkillMarketSyncPolicy> {
    this.#assertUsable();
    const id = entityId(resourceId, "Resource ID");
    let abortIds: string[] = [];
    const result = await this.#mutate(async () => {
      const current = this.#requirePolicy(id, expectedRevision);
      const now = this.#now();
      const next: StoredSyncPolicy = {
        ...current,
        revision: increment(current.revision),
        enabled: false,
        disabledReason: "user",
        updatedAt: now
      };
      const policies = new Map(this.#policies).set(id, next);
      const jobs = new Map(this.#jobs);
      abortIds = [];
      for (const [jobId, job] of jobs) {
        if (job.policyResourceId !== id || !ACTIVE_STATES.has(job.state)) continue;
        abortIds.push(jobId);
        jobs.set(jobId, cancelledOrCancelling(job, now));
      }
      this.#persist(policies, jobs);
      this.#replacePolicies(policies);
      this.#replaceJobs(jobs);
      return publicPolicy(next);
    });
    for (const idToAbort of abortIds) this.#active.get(idToAbort)?.controller.abort();
    return result;
  }

  /**
   * Compose policy termination into the Local Skill owner's exact physical
   * deletion transaction. No asynchronous effect is dispatched from finalize.
   */
  prepareResourceRemoval(resource: PiResourceDescriptor): PreparedSkillMarketSyncRemoval {
    this.#assertUsable();
    const resourceId = entityId(resource.id, "Resource ID");
    const expectedPolicy = this.#policies.get(resourceId);
    if (expectedPolicy === undefined) {
      return Object.freeze({
        finalize: (store: OperationalStore) => {
          if (store !== this.#store) throw new Error("Skill sync removal must use its owning OperationalStore.");
        },
        committed: () => undefined,
        rolledBack: () => undefined
      });
    }
    const now = this.#now();
    const nextPolicy: StoredSyncPolicy = {
      ...expectedPolicy,
      revision: increment(expectedPolicy.revision),
      enabled: false,
      disabledReason: "resource_removed",
      updatedAt: now
    };
    const expectedJobs = new Map<string, StoredSyncJob>();
    const nextJobs = new Map(this.#jobs);
    const abortIds: string[] = [];
    for (const [id, job] of this.#jobs) {
      if (job.policyResourceId !== resourceId || !ACTIVE_STATES.has(job.state)) continue;
      expectedJobs.set(id, job);
      nextJobs.set(id, cancelledOrCancelling(job, now));
      abortIds.push(id);
    }
    const nextPolicies = new Map(this.#policies).set(resourceId, nextPolicy);
    let finalized = false;
    return Object.freeze({
      finalize: (store: OperationalStore): void => {
        if (store !== this.#store) throw new Error("Skill sync removal must use its owning OperationalStore.");
        if (finalized || this.#policies.get(resourceId) !== expectedPolicy
          || [...expectedJobs].some(([id, expected]) => this.#jobs.get(id) !== expected)) {
          throw new Error("Skill sync policy changed before Resource removal committed.");
        }
        this.#persist(nextPolicies, nextJobs, store);
        this.#policies.set(resourceId, nextPolicy);
        for (const [id, next] of nextJobs) {
          if (expectedJobs.has(id)) this.#jobs.set(id, next);
        }
        finalized = true;
      },
      committed: (): void => {
        if (!finalized) return;
        for (const id of abortIds) this.#active.get(id)?.controller.abort();
      },
      rolledBack: (): void => {
        if (!finalized) return;
        if (this.#policies.get(resourceId) === nextPolicy) this.#policies.set(resourceId, expectedPolicy);
        for (const [id, expected] of expectedJobs) {
          if (this.#jobs.get(id) === nextJobs.get(id)) this.#jobs.set(id, expected);
        }
        finalized = false;
      }
    });
  }

  async enqueue(resourceId: string, expectedPolicyRevision: bigint): Promise<SkillMarketSyncJob> {
    this.#assertUsable();
    return this.#mutate(async () => {
      const policy = this.#requirePolicy(entityId(resourceId, "Resource ID"), expectedPolicyRevision);
      const job = this.#newJob(policy);
      const jobs = this.#withPrunedJob(job);
      this.#persist(this.#policies, jobs);
      this.#replaceJobs(jobs);
      return publicJob(job);
    });
  }

  async enqueueAll(): Promise<readonly SkillMarketSyncJob[]> {
    this.#assertUsable();
    return this.#mutate(async () => {
      let jobs = new Map(this.#jobs);
      const created: StoredSyncJob[] = [];
      for (const policy of [...this.#policies.values()].sort((left, right) => left.resourceId.localeCompare(right.resourceId, "en"))) {
        if (!policy.enabled || [...jobs.values()].some((job) => job.policyResourceId === policy.resourceId && ACTIVE_STATES.has(job.state))) continue;
        const job = this.#newJob(policy, jobs);
        jobs = this.#withPrunedJob(job, jobs);
        created.push(job);
      }
      if (created.length > 0) {
        this.#persist(this.#policies, jobs);
        this.#replaceJobs(jobs);
      }
      return created.map(publicJob);
    });
  }

  async retry(jobId: string, expectedRevision: bigint): Promise<SkillMarketSyncJob> {
    this.#assertUsable();
    return this.#mutate(async () => {
      const previous = this.#requireJob(jobId, expectedRevision);
      if (previous.state !== "failed" && previous.state !== "blocked" && previous.state !== "cancelled") {
        throw new Error("Only a failed, blocked, or cancelled Skill sync job can be retried.");
      }
      const policy = this.#policies.get(previous.policyResourceId);
      if (policy === undefined || !policy.enabled) throw new Error("Skill market sync policy is disabled or missing.");
      this.#assertNoActiveJob(policy.resourceId);
      const job = this.#newJob(policy, this.#jobs, previous.id, previous.attempt + 1);
      const jobs = this.#withPrunedJob(job);
      this.#persist(this.#policies, jobs);
      this.#replaceJobs(jobs);
      return publicJob(job);
    });
  }

  async cancel(jobId: string, expectedRevision: bigint): Promise<SkillMarketSyncJob> {
    this.#assertUsable();
    let shouldAbort = false;
    const result = await this.#mutate(async () => {
      const current = this.#requireJob(jobId, expectedRevision);
      if (!ACTIVE_STATES.has(current.state)) throw new Error("Skill market sync job is already terminal.");
      const next = cancelledOrCancelling(current, this.#now());
      const jobs = new Map(this.#jobs).set(current.id, next);
      this.#persist(this.#policies, jobs);
      this.#replaceJobs(jobs);
      shouldAbort = current.state === "running" || current.state === "cancelling";
      return publicJob(next);
    });
    if (shouldAbort) this.#active.get(result.id)?.controller.abort();
    await this.#afterJobPersisted?.(result);
    return result;
  }

  begin(jobId: string): void {
    this.#assertUsable();
    if (this.#closing) return;
    const id = normalizedJobId(jobId);
    if (this.#active.has(id)) return;
    const job = this.#jobs.get(id);
    if (job === undefined || job.state !== "pending_revalidation") return;
    const controller = new AbortController();
    const completion = this.#run(id, controller.signal).finally(() => {
      if (this.#active.get(id)?.controller === controller) this.#active.delete(id);
    });
    this.#active.set(id, { controller, completion });
  }

  beginPending(): void {
    this.#assertUsable();
    for (const job of this.#jobs.values()) if (job.state === "pending_revalidation") this.begin(job.id);
  }

  async wait(jobId: string): Promise<SkillMarketSyncJob> {
    const id = normalizedJobId(jobId);
    await this.#active.get(id)?.completion;
    return this.getJob(id);
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    const active = [...this.#active.values()];
    for (const item of active) item.controller.abort();
    await Promise.allSettled(active.map((item) => item.completion));
  }

  async #run(jobId: string, signal: AbortSignal): Promise<void> {
    const connectionId = `skill-sync-run-${jobId.slice("skill_sync_".length)}`;
    let prepared: PreparedSkillMarketInstallation | undefined;
    try {
      const running = await this.#transitionToRunning(jobId);
      if (running === undefined) return;
      await this.#afterJobPersisted?.(running);
      signal.throwIfAborted();
      let context = this.#runContext(jobId);
      const comparison = compareVersions(context.entry.version, context.resource.version!);
      if (comparison < 0) {
        throw new SyncAuthorityError("DOWNGRADE_BLOCKED", "The current market version is lower than the installed version.");
      }
      if (comparison === 0) {
        await this.#finishJob(jobId, "up_to_date", "ALREADY_CURRENT", context.entry.version);
        return;
      }

      const plan = await this.#market.createInstallPlan(connectionId, entryIdentity(context.entry), installTarget(context.policy.target), signal);
      context = this.#runContext(jobId);
      if (
        plan.resourcePreview.action !== "update"
        || plan.resourcePreview.resourceId !== context.resource.id
        || plan.resourcePreview.currentResource?.resourceId !== context.resource.id
        || plan.resourcePreview.currentResource.resourceVersion !== context.resource.versionNumber
        || plan.resourcePreview.currentResource.observedRevision !== context.resource.discoveredRevision
        || plan.resourcePreview.currentResource.dirty
        || plan.resourcePreview.sourceReplacement
        || plan.confirmationReasons.length > 0
      ) throw new SyncAuthorityError("OWNER_CHANGED", "Installed Skill ownership changed before synchronization.");
      signal.throwIfAborted();
      prepared = await this.#market.prepareInstall({
        connectionId,
        planId: plan.id,
        expectedCandidateRevision: plan.resourcePreview.candidateRevision,
        confirmReplacement: false
      }, signal);
      signal.throwIfAborted();
      context = this.#runContext(jobId);
      await this.#commitSuccess(context, prepared, context.entry.version);
      prepared = undefined;
    } catch (error) {
      await prepared?.cancel().catch(() => undefined);
      if (this.#isTerminal(jobId)) return;
      if (this.#closing) {
        await this.#returnToPending(jobId).catch(() => undefined);
      } else if (isAbort(error) || this.#jobs.get(jobId)?.state === "cancelling") {
        await this.#finishJob(jobId, "cancelled", "CANCELLED").catch(() => undefined);
      } else if (error instanceof SyncAuthorityError) {
        await this.#finishJob(jobId, "blocked", error.outcome, undefined, error.message, error.disablePolicy).catch(() => undefined);
      } else {
        await this.#failJob(jobId).catch(() => undefined);
      }
    } finally {
      await this.#market.closeConnection(connectionId).catch(() => undefined);
    }
  }

  #runContext(jobId: string): SyncRunContext {
    const job = this.#jobs.get(jobId);
    if (job === undefined || job.state !== "running") throw abortError();
    const policy = this.#policies.get(job.policyResourceId);
    if (policy === undefined || !policy.enabled || policy.revision !== job.policyRevision) {
      throw new SyncAuthorityError("OWNER_CHANGED", "Skill synchronization policy changed after dispatch.");
    }
    assertSameAuthority(job.authority, policy);
    const target = policy.target;
    if (target.scope === "project") {
      let storedTarget;
      try { storedTarget = this.#store.getTarget(target.targetId!); } catch {
        throw new SyncAuthorityError("TARGET_CHANGED", "Skill synchronization Target no longer exists.");
      }
      if (
        storedTarget.revision.toString(10) !== target.targetRevision || !storedTarget.descriptor.trusted
        || storedTarget.descriptor.backendId !== target.backendId
      ) throw new SyncAuthorityError("TARGET_CHANGED", "Skill synchronization Target authority changed.");
    }
    let resource: PiResourceDescriptor;
    try { resource = this.#resources.get(policy.resourceId); } catch {
      throw new SyncAuthorityError("RESOURCE_REMOVED", "Installed Skill Resource no longer exists.", true);
    }
    if (resource.state === "removed") {
      throw new SyncAuthorityError("RESOURCE_REMOVED", "Installed Skill Resource was removed.", true);
    }
    assertResourceAuthority(policy, resource);
    let entry: SkillMarketCatalogItem;
    try { entry = this.#market.getCurrentEntry(policy.sourceId, policy.entryId); } catch {
      throw new SyncAuthorityError("OWNER_CHANGED", "Configured Skill market source or entry is no longer current.");
    }
    if (entry.sourceState !== "ready") throw new Error("Skill market source is temporarily unavailable.");
    return { job, policy, resource, entry };
  }

  async #commitSuccess(
    context: SyncRunContext,
    prepared: PreparedSkillMarketInstallation,
    availableVersion: string
  ): Promise<void> {
    const currentJob = context.job;
    const currentPolicy = context.policy;
    const installed = prepared.mutation.value;
    assertSyncableResource(installed);
    const now = this.#now();
    const nextPolicy: StoredSyncPolicy = {
      ...currentPolicy,
      revision: increment(currentPolicy.revision),
      baseline: storedBaseline(baselineFromResource(installed)),
      updatedAt: now
    };
    const nextJob: StoredSyncJob = {
      ...withoutTerminalJobFields(currentJob),
      revision: increment(currentJob.revision),
      state: "succeeded",
      availableVersion,
      outcome: "UPDATED",
      updatedAt: now,
      completedAt: now
    };
    const policies = new Map(this.#policies).set(nextPolicy.resourceId, nextPolicy);
    const jobs = new Map(this.#jobs).set(nextJob.id, nextJob);
    let adopted = false;
    try {
      await prepared.complete((finalizeResource) => this.#store.transaction((store) => {
        const exact = this.#runContext(currentJob.id);
        if (exact.job !== currentJob || exact.policy !== currentPolicy) {
          throw new SyncAuthorityError("OWNER_CHANGED", "Skill synchronization authority changed before final switch.");
        }
        finalizeResource(store);
        this.#persist(policies, jobs, store);
        this.#replacePolicies(policies);
        this.#replaceJobs(jobs);
        adopted = true;
      }));
    } catch (error) {
      if (adopted) {
        this.#policies.set(currentPolicy.resourceId, currentPolicy);
        this.#jobs.set(currentJob.id, currentJob);
      }
      throw error;
    }
    await this.#onResourceCommitted?.({ resourceId: installed.id, backendId: installed.backendId });
    await this.#afterJobPersisted?.(publicJob(nextJob));
  }

  async #transitionToRunning(jobId: string): Promise<SkillMarketSyncJob | undefined> {
    return this.#mutate(async () => {
      const current = this.#jobs.get(jobId);
      if (current === undefined || current.state !== "pending_revalidation") return undefined;
      const next: StoredSyncJob = {
        ...withoutTerminalJobFields(current),
        revision: increment(current.revision),
        state: "running",
        updatedAt: this.#now()
      };
      const jobs = new Map(this.#jobs).set(jobId, next);
      this.#persist(this.#policies, jobs);
      this.#replaceJobs(jobs);
      return publicJob(next);
    });
  }

  async #finishJob(
    jobId: string,
    state: Extract<SkillMarketSyncJobState, "succeeded" | "up_to_date" | "blocked" | "cancelled">,
    outcome: SkillMarketSyncOutcome,
    availableVersion?: string,
    error?: string,
    disablePolicy = false
  ): Promise<void> {
    const published = await this.#mutate(async () => {
      const current = this.#jobs.get(jobId);
      if (current === undefined || TERMINAL_STATES.has(current.state)) return undefined;
      const now = this.#now();
      const next: StoredSyncJob = {
        ...withoutTerminalJobFields(current),
        revision: increment(current.revision),
        state,
        ...(availableVersion === undefined ? {} : { availableVersion }),
        outcome,
        ...(error === undefined ? {} : { error: safeSyncError(error) }),
        updatedAt: now,
        completedAt: now
      };
      const jobs = new Map(this.#jobs).set(jobId, next);
      const policies = new Map(this.#policies);
      if (disablePolicy) {
        const policy = policies.get(current.policyResourceId);
        if (policy !== undefined && policy.enabled) {
          policies.set(policy.resourceId, {
            ...policy,
            revision: increment(policy.revision),
            enabled: false,
            disabledReason: "resource_removed",
            updatedAt: now
          });
        }
      }
      this.#persist(policies, jobs);
      this.#replacePolicies(policies);
      this.#replaceJobs(jobs);
      return publicJob(next);
    });
    if (published !== undefined) await this.#afterJobPersisted?.(published);
  }

  async #failJob(jobId: string): Promise<void> {
    const published = await this.#mutate(async () => {
      const current = this.#jobs.get(jobId);
      if (current === undefined || TERMINAL_STATES.has(current.state)) return undefined;
      const now = this.#now();
      const next: StoredSyncJob = {
        ...withoutTerminalJobFields(current),
        revision: increment(current.revision),
        state: "failed",
        error: "Skill synchronization failed while revalidating current source, Target, or Resource authority.",
        updatedAt: now,
        completedAt: now
      };
      const jobs = new Map(this.#jobs).set(jobId, next);
      this.#persist(this.#policies, jobs);
      this.#replaceJobs(jobs);
      return publicJob(next);
    });
    if (published !== undefined) await this.#afterJobPersisted?.(published);
  }

  async #returnToPending(jobId: string): Promise<void> {
    await this.#mutate(async () => {
      const current = this.#jobs.get(jobId);
      if (current === undefined || TERMINAL_STATES.has(current.state)) return;
      const next: StoredSyncJob = {
        ...withoutTerminalJobFields(current),
        revision: increment(current.revision),
        state: "pending_revalidation",
        updatedAt: this.#now()
      };
      const jobs = new Map(this.#jobs).set(jobId, next);
      this.#persist(this.#policies, jobs);
      this.#replaceJobs(jobs);
    });
  }

  #validatedTarget(input: PiMarketSkillTargetInput, resource: PiResourceDescriptor): SkillMarketSyncTarget {
    const backendId = entityId(input.backendId, "Backend ID");
    if (backendId !== resource.backendId || input.scope !== (resource.scope === "project" ? "project" : "global")) {
      throw new Error("Skill sync target does not match the installed Resource.");
    }
    if (input.scope === "global") {
      if (input.targetId !== undefined || input.relativeParent !== undefined || resource.targetId !== undefined) {
        throw new Error("Global Skill sync target cannot contain project authority.");
      }
      return { backendId, scope: "global" };
    }
    const targetId = entityId(input.targetId ?? "", "Target ID");
    if (resource.targetId !== targetId) throw new Error("Skill sync Target does not match the installed Resource.");
    const relativeParent = portableParent(input.relativeParent ?? ".agents/skills");
    const target = this.#store.getTarget(targetId);
    if (!target.descriptor.trusted || target.descriptor.backendId !== backendId) throw new Error("Skill sync Target is not trusted.");
    return { backendId, scope: "project", targetId, relativeParent, targetRevision: target.revision };
  }

  #newJob(
    policy: StoredSyncPolicy,
    jobs: ReadonlyMap<string, StoredSyncJob> = this.#jobs,
    retryOfJobId?: string,
    attempt = 1
  ): StoredSyncJob {
    if (!policy.enabled) throw new Error("Skill market sync policy is disabled.");
    if ([...jobs.values()].some((job) => job.policyResourceId === policy.resourceId && ACTIVE_STATES.has(job.state))) {
      throw new Error("This Skill already has an active sync job.");
    }
    const now = this.#now();
    return {
      id: `skill_sync_${randomUUID().replaceAll("-", "")}`,
      revision: "1",
      state: "pending_revalidation",
      policyResourceId: policy.resourceId,
      policyRevision: policy.revision,
      authority: {
        sourceId: policy.sourceId,
        entryId: policy.entryId,
        target: { ...policy.target },
        baseline: { ...policy.baseline }
      },
      attempt,
      ...(retryOfJobId === undefined ? {} : { retryOfJobId }),
      createdAt: now,
      updatedAt: now
    };
  }

  #withPrunedJob(job: StoredSyncJob, base: ReadonlyMap<string, StoredSyncJob> = this.#jobs): Map<string, StoredSyncJob> {
    const next = new Map(base);
    const terminal = [...next.values()]
      .filter((candidate) => TERMINAL_STATES.has(candidate.state))
      .sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id, "en"));
    const prune = Math.max(0, next.size + 1 - this.#maximumJobs);
    if (prune > terminal.length) throw new Error("Skill market sync history is full of active jobs.");
    for (const old of terminal.slice(0, prune)) next.delete(old.id);
    next.set(job.id, job);
    return next;
  }

  #requirePolicy(resourceId: string, expectedRevision?: bigint): StoredSyncPolicy {
    const policy = this.#policies.get(resourceId);
    if (policy === undefined) throw new Error("Skill market sync policy does not exist.");
    if (expectedRevision !== undefined && policy.revision !== decimal(expectedRevision, "Sync policy revision")) {
      throw new Error("Skill market sync policy changed after it was observed.");
    }
    return policy;
  }

  #requireJob(jobId: string, expectedRevision?: bigint): StoredSyncJob {
    const job = this.#jobs.get(normalizedJobId(jobId));
    if (job === undefined) throw new Error("Skill market sync job does not exist.");
    if (expectedRevision !== undefined && job.revision !== decimal(expectedRevision, "Sync job revision")) {
      throw new Error("Skill market sync job changed after it was observed.");
    }
    return job;
  }

  #assertNoActiveJob(resourceId: string): void {
    if ([...this.#jobs.values()].some((job) => job.policyResourceId === resourceId && ACTIVE_STATES.has(job.state))) {
      throw new Error("This Skill has an active sync job.");
    }
  }

  #isTerminal(jobId: string): boolean {
    const state = this.#jobs.get(jobId)?.state;
    return state !== undefined && TERMINAL_STATES.has(state);
  }

  #persist(
    policies: ReadonlyMap<string, StoredSyncPolicy> = this.#policies,
    jobs: ReadonlyMap<string, StoredSyncJob> = this.#jobs,
    store: OperationalStore = this.#store
  ): void {
    store.setSetting("service", this.#scopeId, SYNC_SETTING_KEY, {
      format: 1,
      policies: [...policies.values()].sort((left, right) => left.resourceId.localeCompare(right.resourceId, "en")),
      jobs: [...jobs.values()].sort((left, right) => left.id.localeCompare(right.id, "en"))
    } satisfies StoredSyncCatalog);
  }

  #replacePolicies(next: ReadonlyMap<string, StoredSyncPolicy>): void {
    this.#policies.clear();
    for (const [id, policy] of next) this.#policies.set(id, policy);
  }

  #replaceJobs(next: ReadonlyMap<string, StoredSyncJob>): void {
    this.#jobs.clear();
    for (const [id, job] of next) this.#jobs.set(id, job);
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  #assertUsable(): void {
    if (!this.#initialized) throw new Error("Skill market sync manager is not initialized.");
  }
}

function assertSyncableResource(resource: PiResourceDescriptor): void {
  if (resource.kind !== "skill" || resource.sourceKind !== "skill_market" || resource.skillMarket === undefined) {
    throw new Error("Only an installed market-owned Skill can opt into synchronization.");
  }
  if (resource.state === "removed" || resource.version === undefined || validVersion(resource.version) === undefined) {
    throw new Error("Installed Skill has no synchronizable semantic version.");
  }
  if (
    resource.discoveredRevision !== resource.skillMarket.installedContentRevision
    || resource.skillMarket.installedContentRevision === ""
  ) throw new Error("Locally changed Skill content cannot opt into automatic synchronization.");
}

function assertSameSyncResource(expected: PiResourceDescriptor, current: PiResourceDescriptor): void {
  if (
    expected.id !== current.id || expected.versionNumber !== current.versionNumber
    || expected.discoveredRevision !== current.discoveredRevision || expected.state !== current.state
    || expected.enabled !== current.enabled || expected.skillMarket?.sourceId !== current.skillMarket?.sourceId
    || expected.skillMarket?.entryId !== current.skillMarket?.entryId
    || expected.skillMarket?.installedContentRevision !== current.skillMarket?.installedContentRevision
  ) throw new Error("Skill Resource changed while synchronization was enabled.");
}

function assertResourceAuthority(policy: StoredSyncPolicy, resource: PiResourceDescriptor): void {
  if (resource.kind !== "skill" || resource.sourceKind !== "skill_market" || resource.skillMarket === undefined) {
    throw new SyncAuthorityError("OWNER_CHANGED", "Installed Skill is no longer owned by its market entry.");
  }
  if (
    resource.id !== policy.resourceId || resource.backendId !== policy.target.backendId
    || (resource.scope === "project" ? "project" : "global") !== policy.target.scope
    || resource.targetId !== policy.target.targetId
    || resource.skillMarket.sourceId !== policy.sourceId || resource.skillMarket.entryId !== policy.entryId
    || resource.skillMarket.sourceRevision.toString(10) !== policy.baseline.sourceRevision
    || resource.skillMarket.entryRevision.toString(10) !== policy.baseline.entryRevision
    || resource.skillMarket.entryContentRevision !== policy.baseline.entryContentRevision
    || resource.skillMarket.installedContentRevision !== policy.baseline.installedContentRevision
    || resource.version !== policy.baseline.installedVersion
  ) throw new SyncAuthorityError("OWNER_CHANGED", "Installed Skill ownership changed after synchronization was scheduled.");
  if (
    resource.discoveredRevision !== policy.baseline.resourceContentRevision
    || resource.discoveredRevision !== resource.skillMarket.installedContentRevision
  ) throw new SyncAuthorityError("DIRTY_CONTENT", "Locally changed Skill content cannot be overwritten automatically.");
  if (resource.versionNumber < BigInt(policy.baseline.resourceVersion)) {
    throw new SyncAuthorityError("OWNER_CHANGED", "Skill Resource revision moved backwards.");
  }
}

function assertSameAuthority(authority: StoredSyncJobAuthority, policy: StoredSyncPolicy): void {
  if (
    authority.sourceId !== policy.sourceId || authority.entryId !== policy.entryId
    || JSON.stringify(authority.target) !== JSON.stringify(policy.target)
    || JSON.stringify(authority.baseline) !== JSON.stringify(policy.baseline)
  ) throw new SyncAuthorityError("OWNER_CHANGED", "Skill synchronization policy authority changed after scheduling.");
}

function baselineFromResource(resource: PiResourceDescriptor): SkillMarketSyncBaseline {
  assertSyncableResource(resource);
  return {
    resourceVersion: resource.versionNumber,
    resourceContentRevision: resource.discoveredRevision,
    installedContentRevision: resource.skillMarket!.installedContentRevision,
    installedVersion: resource.version!,
    sourceRevision: resource.skillMarket!.sourceRevision,
    entryRevision: resource.skillMarket!.entryRevision,
    entryContentRevision: resource.skillMarket!.entryContentRevision
  };
}

function entryIdentity(entry: SkillMarketCatalogItem): SkillMarketEntryIdentity {
  return {
    sourceId: entry.sourceId,
    sourceRevision: entry.sourceRevision,
    entryId: entry.id,
    entryRevision: entry.revision,
    contentRevision: entry.contentRevision
  };
}

function storedTarget(target: SkillMarketSyncTarget): StoredSyncTarget {
  const { targetRevision, ...base } = target;
  return {
    ...base,
    ...(targetRevision === undefined ? {} : { targetRevision: targetRevision.toString(10) })
  };
}

function publicTarget(target: StoredSyncTarget): SkillMarketSyncTarget {
  const { targetRevision, ...base } = target;
  return {
    ...base,
    ...(targetRevision === undefined ? {} : { targetRevision: BigInt(targetRevision) })
  };
}

function installTarget(target: StoredSyncTarget): PiMarketSkillTargetInput {
  return {
    backendId: target.backendId,
    scope: target.scope,
    ...(target.targetId === undefined ? {} : { targetId: target.targetId }),
    ...(target.relativeParent === undefined ? {} : { relativeParent: target.relativeParent })
  };
}

function storedBaseline(value: SkillMarketSyncBaseline): StoredSyncBaseline {
  return {
    ...value,
    resourceVersion: value.resourceVersion.toString(10),
    sourceRevision: value.sourceRevision.toString(10),
    entryRevision: value.entryRevision.toString(10)
  };
}

function publicBaseline(value: StoredSyncBaseline): SkillMarketSyncBaseline {
  return {
    ...value,
    resourceVersion: BigInt(value.resourceVersion),
    sourceRevision: BigInt(value.sourceRevision),
    entryRevision: BigInt(value.entryRevision)
  };
}

function publicPolicy(value: StoredSyncPolicy): SkillMarketSyncPolicy {
  return {
    ...value,
    revision: BigInt(value.revision),
    target: publicTarget(value.target),
    baseline: publicBaseline(value.baseline)
  };
}

function publicAuthority(value: StoredSyncJobAuthority): SkillMarketSyncJobAuthority {
  return { sourceId: value.sourceId, entryId: value.entryId, target: publicTarget(value.target), baseline: publicBaseline(value.baseline) };
}

function publicJob(value: StoredSyncJob): SkillMarketSyncJob {
  return {
    ...value,
    revision: BigInt(value.revision),
    policyRevision: BigInt(value.policyRevision),
    authority: publicAuthority(value.authority)
  };
}

function withoutTerminalJobFields(value: StoredSyncJob): Omit<StoredSyncJob, "state" | "revision" | "updatedAt"> {
  const { state: _state, revision: _revision, updatedAt: _updatedAt, availableVersion: _availableVersion,
    outcome: _outcome, error: _error, completedAt: _completedAt, ...base } = value;
  return base;
}

function cancelledOrCancelling(job: StoredSyncJob, now: number): StoredSyncJob {
  if (job.state === "pending_revalidation") {
    return {
      ...withoutTerminalJobFields(job),
      revision: increment(job.revision),
      state: "cancelled",
      outcome: "CANCELLED",
      updatedAt: now,
      completedAt: now
    };
  }
  return {
    ...withoutTerminalJobFields(job),
    revision: increment(job.revision),
    state: "cancelling",
    updatedAt: now
  };
}

function validateStoredCatalog(value: unknown, maximumJobs: number): StoredSyncCatalog {
  const object = strictObject(value, ["format", "policies", "jobs"], "Skill market sync catalog");
  if (object.format !== 1 || !Array.isArray(object.policies) || !Array.isArray(object.jobs)
    || object.policies.length > MAXIMUM_POLICIES || object.jobs.length > maximumJobs) {
    throw new Error("Skill market sync catalog shape is invalid.");
  }
  const policies = object.policies.map(validateStoredPolicy);
  const jobs = object.jobs.map(validateStoredJob);
  if (new Set(policies.map((policy) => policy.resourceId)).size !== policies.length
    || new Set(jobs.map((job) => job.id)).size !== jobs.length) throw new Error("Skill market sync catalog contains duplicate identities.");
  return { format: 1, policies, jobs };
}

function validateStoredPolicy(value: unknown): StoredSyncPolicy {
  const object = strictObject(value, [
    "resourceId", "revision", "enabled", "sourceId", "entryId", "target", "baseline",
    "createdAt", "updatedAt", "disabledReason"
  ], "Skill market sync policy");
  const enabled = booleanValue(object.enabled, "Skill market sync enabled state");
  const disabledReason = object.disabledReason;
  if (enabled ? disabledReason !== undefined : disabledReason !== "user" && disabledReason !== "resource_removed") {
    throw new Error("Skill market sync policy disabled state is invalid.");
  }
  const normalizedDisabledReason = disabledReason as "user" | "resource_removed" | undefined;
  const createdAt = timeValue(object.createdAt, "Skill market sync policy creation time");
  const updatedAt = timeValue(object.updatedAt, "Skill market sync policy update time");
  if (updatedAt < createdAt) throw new Error("Skill market sync policy time order is invalid.");
  return {
    resourceId: entityId(stringValue(object.resourceId, "Resource ID"), "Resource ID"),
    revision: storedDecimal(object.revision, "Skill market sync policy revision"),
    enabled,
    sourceId: sourceId(stringValue(object.sourceId, "Skill market source ID")),
    entryId: entryId(stringValue(object.entryId, "Skill market entry ID")),
    target: validateStoredTarget(object.target),
    baseline: validateStoredBaseline(object.baseline),
    createdAt,
    updatedAt,
    ...(normalizedDisabledReason === undefined ? {} : { disabledReason: normalizedDisabledReason })
  };
}

function validateStoredJob(value: unknown): StoredSyncJob {
  const object = strictObject(value, [
    "id", "revision", "state", "policyResourceId", "policyRevision", "authority", "attempt", "retryOfJobId",
    "availableVersion", "outcome", "error", "createdAt", "updatedAt", "completedAt"
  ], "Skill market sync job");
  const state = object.state;
  if (typeof state !== "string" || ![...ACTIVE_STATES, ...TERMINAL_STATES].includes(state as SkillMarketSyncJobState)) {
    throw new Error("Skill market sync job state is invalid.");
  }
  const createdAt = timeValue(object.createdAt, "Skill market sync job creation time");
  const updatedAt = timeValue(object.updatedAt, "Skill market sync job update time");
  const completedAt = object.completedAt === undefined ? undefined : timeValue(object.completedAt, "Skill market sync job completion time");
  const error = object.error === undefined ? undefined : boundedString(object.error, "Skill market sync job error", 1_024);
  const outcome = object.outcome;
  if (outcome !== undefined && ![
    "UPDATED", "ALREADY_CURRENT", "DOWNGRADE_BLOCKED", "DIRTY_CONTENT", "OWNER_CHANGED",
    "TARGET_CHANGED", "RESOURCE_REMOVED", "CANCELLED"
  ].includes(outcome as string)) throw new Error("Skill market sync job outcome is invalid.");
  if (ACTIVE_STATES.has(state as SkillMarketSyncJobState)) {
    if (completedAt !== undefined || error !== undefined || outcome !== undefined) throw new Error("Active Skill market sync job contains terminal fields.");
  } else if (completedAt === undefined || completedAt < updatedAt) {
    throw new Error("Terminal Skill market sync job is incomplete.");
  }
  if ((state === "failed" || state === "blocked") !== (error !== undefined)) {
    throw new Error("Skill market sync job failure details are invalid.");
  }
  if (state === "cancelled" && outcome !== "CANCELLED") throw new Error("Cancelled Skill market sync job outcome is invalid.");
  if (state === "succeeded" && outcome !== "UPDATED") throw new Error("Successful Skill market sync job outcome is invalid.");
  if (state === "up_to_date" && outcome !== "ALREADY_CURRENT") throw new Error("Current Skill market sync job outcome is invalid.");
  const attempt = object.attempt;
  if (!Number.isSafeInteger(attempt) || (attempt as number) < 1) throw new Error("Skill market sync job attempt is invalid.");
  const retryOfJobId = object.retryOfJobId === undefined ? undefined : normalizedJobId(stringValue(object.retryOfJobId, "Retry job ID"));
  const availableVersion = object.availableVersion === undefined ? undefined : versionValue(object.availableVersion);
  return {
    id: normalizedJobId(stringValue(object.id, "Skill market sync job ID")),
    revision: storedDecimal(object.revision, "Skill market sync job revision"),
    state: state as SkillMarketSyncJobState,
    policyResourceId: entityId(stringValue(object.policyResourceId, "Policy Resource ID"), "Policy Resource ID"),
    policyRevision: storedDecimal(object.policyRevision, "Skill market sync policy revision"),
    authority: validateStoredAuthority(object.authority),
    attempt: attempt as number,
    ...(retryOfJobId === undefined ? {} : { retryOfJobId }),
    ...(availableVersion === undefined ? {} : { availableVersion }),
    ...(outcome === undefined ? {} : { outcome: outcome as SkillMarketSyncOutcome }),
    ...(error === undefined ? {} : { error }),
    createdAt,
    updatedAt,
    ...(completedAt === undefined ? {} : { completedAt })
  };
}

function validateStoredAuthority(value: unknown): StoredSyncJobAuthority {
  const object = strictObject(value, ["sourceId", "entryId", "target", "baseline"], "Skill market sync job authority");
  return {
    sourceId: sourceId(stringValue(object.sourceId, "Skill market source ID")),
    entryId: entryId(stringValue(object.entryId, "Skill market entry ID")),
    target: validateStoredTarget(object.target),
    baseline: validateStoredBaseline(object.baseline)
  };
}

function validateStoredTarget(value: unknown): StoredSyncTarget {
  const object = strictObject(value, ["backendId", "scope", "targetId", "relativeParent", "targetRevision"], "Skill market sync target");
  const backendId = entityId(stringValue(object.backendId, "Backend ID"), "Backend ID");
  if (object.scope === "global") {
    if (object.targetId !== undefined || object.relativeParent !== undefined || object.targetRevision !== undefined) {
      throw new Error("Global Skill market sync target contains project fields.");
    }
    return { backendId, scope: "global" };
  }
  if (object.scope !== "project") throw new Error("Skill market sync target scope is invalid.");
  return {
    backendId,
    scope: "project",
    targetId: entityId(stringValue(object.targetId, "Target ID"), "Target ID"),
    relativeParent: portableParent(stringValue(object.relativeParent, "Target-relative parent")),
    targetRevision: storedDecimal(object.targetRevision, "Target revision")
  };
}

function validateStoredBaseline(value: unknown): StoredSyncBaseline {
  const object = strictObject(value, [
    "resourceVersion", "resourceContentRevision", "installedContentRevision", "installedVersion",
    "sourceRevision", "entryRevision", "entryContentRevision"
  ], "Skill market sync baseline");
  return {
    resourceVersion: storedDecimal(object.resourceVersion, "Resource revision"),
    resourceContentRevision: contentRevision(object.resourceContentRevision, "Resource content revision"),
    installedContentRevision: contentRevision(object.installedContentRevision, "Installed content revision"),
    installedVersion: versionValue(object.installedVersion),
    sourceRevision: storedDecimal(object.sourceRevision, "Source revision"),
    entryRevision: storedDecimal(object.entryRevision, "Entry revision"),
    entryContentRevision: contentRevision(object.entryContentRevision, "Entry content revision")
  };
}

function strictObject(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is not an object.`);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} has unsupported fields.`);
  }
  return object;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid.`);
  return value;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  const text = stringValue(value, label);
  if (text.length < 1 || text.length > maximum || /[\u0000-\u001f\u007f]/u.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function entityId(value: string, label: string): string {
  const id = value.trim();
  if (!ENTITY_ID.test(id)) throw new Error(`${label} is invalid.`);
  return id;
}

function sourceId(value: string): string {
  if (!SOURCE_ID.test(value)) throw new Error("Skill market source ID is invalid.");
  return value;
}

function entryId(value: string): string {
  if (!ENTRY_ID.test(value)) throw new Error("Skill market entry ID is invalid.");
  return value;
}

function normalizedJobId(value: string): string {
  const id = value.trim();
  if (!JOB_ID.test(id)) throw new Error("Skill market sync job ID is invalid.");
  return id;
}

function storedDecimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function decimal(value: bigint, label: string): string {
  if (value < 0n) throw new Error(`${label} is invalid.`);
  return value.toString(10);
}

function increment(value: string): string {
  return (BigInt(value) + 1n).toString(10);
}

function contentRevision(value: unknown, label: string): string {
  if (typeof value !== "string" || !CONTENT_REVISION.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function timeValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
  return value;
}

function versionValue(value: unknown): string {
  const version = typeof value === "string" ? validVersion(value) : undefined;
  if (version === undefined) throw new Error("Semantic version is invalid.");
  return version;
}

function validVersion(value: string): string | undefined {
  return semver.valid(value) ?? undefined;
}

function compareVersions(left: string, right: string): number {
  versionValue(left);
  versionValue(right);
  return semver.compare(left, right);
}

function portableParent(value: string): string {
  if (value.length < 1 || value.length > 512 || value !== value.trim() || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) {
    throw new Error("Skill target parent must be a portable relative path.");
  }
  const parts = value.split("/");
  if (parts.length > 32 || parts.some((part) => part === "" || part === "." || part === ".." || part.length > 255
    || /[<>:"|?*\u0000-\u001f]/u.test(part) || /[. ]$/u.test(part))) {
    throw new Error("Skill target parent must be a portable relative path.");
  }
  return value;
}

function safeSyncError(value: string): string {
  return value.length > 1_024 ? `${value.slice(0, 1_021)}...` : value;
}

function abortError(): Error {
  return new DOMException("Skill synchronization was cancelled.", "AbortError");
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}
