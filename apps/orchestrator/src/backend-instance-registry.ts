import type { BackendAdapter, BackendDescriptor } from "@joko/core";
import type {
  BackendDescriptorPublication,
  BackendInstanceGenerationReservation,
  StoredBackend
} from "@joko/store";

export interface BackendInstanceFactory {
  /** Stable product identity. Adapter kind and credentials remain factory-private. */
  readonly instanceId: string;
  readonly adapterKind: string;
  readonly displayName: string;
  readonly create: (input: {
    readonly instanceId: string;
    readonly generation: number;
  }) => BackendAdapter | Promise<BackendAdapter>;
}

export interface BackendInstanceSnapshot {
  readonly instanceId: string;
  readonly generation: number;
  readonly state: "available" | "unavailable";
  readonly descriptor: BackendDescriptor;
}

export interface BackendCandidateCleanupSnapshot {
  readonly instanceId: string;
  readonly generation: number;
  readonly state: "cleanup_unknown";
}

export interface BackendRetiredCleanupSnapshot {
  readonly instanceId: string;
  readonly generation: number;
  readonly state: "cleanup_unknown";
}

export interface BackendInstanceAuthority {
  reserveBackendInstanceGeneration(input: {
    readonly backendId: string;
    readonly adapterKind: string;
  }): BackendInstanceGenerationReservation;
  publishBackendInstanceDescriptor(input: {
    readonly descriptor: BackendDescriptor;
    readonly expectedCurrentGeneration?: number;
  }): BackendDescriptorPublication;
  getBackend(id: string): StoredBackend;
}

interface AvailableBackendInstance extends BackendInstanceSnapshot {
  readonly state: "available";
  readonly adapter: BackendAdapter;
}

interface UnavailableBackendInstance extends BackendInstanceSnapshot {
  readonly state: "unavailable";
}

interface BackendCandidateCleanupOwner extends BackendCandidateCleanupSnapshot {
  readonly adapter: BackendAdapter;
  janitor?: Promise<void>;
}

interface BackendRetiredCleanupOwner extends BackendRetiredCleanupSnapshot {
  readonly adapter: BackendAdapter;
  janitor?: Promise<void>;
}

type BackendInstance = AvailableBackendInstance | UnavailableBackendInstance;

export interface BackendInstanceRegistryOptions {
  /** Deterministic Host-owned capability composition applied before every durable descriptor publication. */
  readonly projectDescriptor?: (descriptor: BackendDescriptor) => BackendDescriptor;
  /** Deadline for each graceful or hard old-generation cleanup step. */
  readonly retirementStepTimeoutMs?: number;
  /** Delay between detached exact-owner janitor attempts. */
  readonly retirementRetryDelayMs?: number;
  /** Total cleanup attempts, including the synchronous first attempt. */
  readonly retirementAttempts?: number;
  /** Stable, content-free notification that an exact unpublished candidate still needs cleanup. */
  readonly onCandidateCleanupUnknown?: (input: BackendCandidateCleanupSnapshot) => void;
}

export interface BackendInstanceReplacementOptions {
  /**
   * Called only for a healthy candidate, before durable publication. The
   * owner uses this window to fence admissions and detach idle runtimes from
   * the exact previous process instance.
   */
  readonly preparePrevious?: (input: {
    readonly instanceId: string;
    readonly generation: number;
    readonly adapter?: BackendAdapter;
    readonly candidateGeneration: number;
    readonly candidateAdapter: BackendAdapter;
  }) => Promise<void>;
  /**
   * Synchronous, prevalidated process-local pointer switch. Durable
   * publication has already committed when this callback runs, no await
   * separates the two steps, and production callbacks must not throw.
   */
  readonly activateCurrent?: (input: {
    readonly instanceId: string;
    readonly generation: number;
    readonly adapter: BackendAdapter;
  }) => void;
  /** Post-publication cleanup is diagnostic-only; the new current is authoritative. */
  readonly onPreviousCleanupFailure?: (input: {
    readonly instanceId: string;
    readonly generation: number;
  }) => void;
}

/**
 * Orchestrator-owned authority for Backend process instances. Every candidate
 * receives a durable, non-reusable generation before construction. A probed
 * candidate becomes reachable only after its descriptor wins the durable
 * expected-current CAS.
 */
export class BackendInstanceRegistry {
  readonly #instances = new Map<string, BackendInstance>();
  readonly #factories = new Map<string, BackendInstanceFactory>();
  readonly #candidateCleanupOwners = new Map<string, BackendCandidateCleanupOwner>();
  readonly #retiredCleanupOwners = new Map<string, BackendRetiredCleanupOwner>();
  readonly #retirementStepTimeoutMs: number;
  readonly #retirementRetryDelayMs: number;
  readonly #retirementAttempts: number;
  readonly #projectDescriptor: (descriptor: BackendDescriptor) => BackendDescriptor;
  readonly #onCandidateCleanupUnknown?: (input: BackendCandidateCleanupSnapshot) => void;

  constructor(
    private readonly authority: BackendInstanceAuthority,
    options: BackendInstanceRegistryOptions = {}
  ) {
    this.#projectDescriptor = options.projectDescriptor ?? ((descriptor) => descriptor);
    this.#retirementStepTimeoutMs = positiveSafeInteger(
      options.retirementStepTimeoutMs ?? 10_000,
      "Backend retirement step timeout"
    );
    this.#retirementRetryDelayMs = nonNegativeSafeInteger(
      options.retirementRetryDelayMs ?? 1_000,
      "Backend retirement retry delay"
    );
    this.#retirementAttempts = positiveSafeInteger(
      options.retirementAttempts ?? 3,
      "Backend retirement attempt count"
    );
    this.#onCandidateCleanupUnknown = options.onCandidateCleanupUnknown;
  }

  async provision(factories: readonly BackendInstanceFactory[]): Promise<readonly BackendInstanceSnapshot[]> {
    if (this.#instances.size !== 0) throw new Error("Backend instances are already provisioned.");
    assertUniqueFactories(factories);
    for (const factory of factories) this.#factories.set(factory.instanceId, factory);

    // Reserve every identity before any factory can construct a native client.
    // A later failure therefore cannot make its generation reusable.
    const reservations = factories.map((factory) => ({
      factory,
      reservation: this.authority.reserveBackendInstanceGeneration({
        backendId: factory.instanceId,
        adapterKind: factory.adapterKind
      })
    }));
    const prepared = await Promise.all(reservations.map(({ factory, reservation }) =>
      this.#prepare(factory, reservation.generation)
    ));

    try {
      for (let index = 0; index < prepared.length; index += 1) {
        const candidate = prepared[index]!;
        const { reservation } = reservations[index]!;
        const published = await this.#publishProvisioned(candidate, reservation);
        this.#instances.set(published.instanceId, published);
      }
    } catch (error) {
      const candidates = prepared
        .filter((candidate): candidate is AvailableBackendInstance => candidate.state === "available");
      await Promise.all(candidates.map((candidate) => this.#cleanupRejectedCandidate(candidate)));
      this.#instances.clear();
      this.#factories.clear();
      throw error;
    }
    return this.snapshots();
  }

  snapshots(): readonly BackendInstanceSnapshot[] {
    return [...this.#instances.values()]
      .map(({ instanceId, generation, state, descriptor }) => ({ instanceId, generation, state, descriptor }))
      .sort((left, right) => left.instanceId.localeCompare(right.instanceId, "en"));
  }

  descriptors(): readonly BackendDescriptor[] {
    return this.snapshots().map((snapshot) => snapshot.descriptor);
  }

  availableAdapters(): readonly BackendAdapter[] {
    return [...this.#instances.values()]
      .filter((instance): instance is AvailableBackendInstance => instance.state === "available")
      .map((instance) => instance.adapter);
  }

  candidateCleanupSnapshots(): readonly BackendCandidateCleanupSnapshot[] {
    return [...this.#candidateCleanupOwners.values()]
      .map(({ instanceId, generation, state }) => ({ instanceId, generation, state }))
      .sort((left, right) => left.instanceId.localeCompare(right.instanceId, "en")
        || left.generation - right.generation);
  }

  retiredCleanupSnapshots(): readonly BackendRetiredCleanupSnapshot[] {
    return [...this.#retiredCleanupOwners.values()]
      .map(({ instanceId, generation, state }) => ({ instanceId, generation, state }))
      .sort((left, right) => left.instanceId.localeCompare(right.instanceId, "en")
        || left.generation - right.generation);
  }

  get(instanceId: string): BackendInstanceSnapshot {
    const instance = this.#instances.get(instanceId);
    if (instance === undefined) throw new Error(`Unknown Backend instance: ${instanceId}`);
    const { generation, state, descriptor } = instance;
    return { instanceId, generation, state, descriptor };
  }

  adapter(instanceId: string): BackendAdapter | undefined {
    const instance = this.#instances.get(instanceId);
    return instance?.state === "available" ? instance.adapter : undefined;
  }

  /**
   * Refresh the public descriptor owned by the exact current process
   * generation. Native account and model discovery can change after initial
   * provisioning, so those changes must reach both durable projection and the
   * in-process admission authority without replacing the Adapter.
   */
  async refresh(instanceId: string): Promise<BackendInstanceSnapshot> {
    const current = this.#instances.get(instanceId);
    if (current === undefined) throw new Error(`Unknown Backend instance: ${instanceId}`);
    if (current.state !== "available") {
      throw new Error(`Unavailable Backend instance cannot refresh its descriptor: ${instanceId}`);
    }

    const described = await current.adapter.describe();
    if (described.id !== instanceId) {
      throw new Error("Backend descriptor identity changed during refresh.");
    }
    if (this.#instances.get(instanceId) !== current) {
      throw new Error(`Backend instance changed while its descriptor was being refreshed: ${instanceId}`);
    }
    const refreshed: AvailableBackendInstance = {
      ...current,
      descriptor: this.#normalizeDescriptor(described, current.descriptor.adapterKind, current.generation)
    };
    const publication = this.authority.publishBackendInstanceDescriptor({
      descriptor: refreshed.descriptor,
      expectedCurrentGeneration: current.generation
    });
    if (publication.status === "stale") {
      throw new Error(`Backend descriptor refresh lost its current-generation fence: ${instanceId}`);
    }

    // Durable publication precedes the process-local pointer update and no
    // await separates the two authority changes.
    this.#instances.set(instanceId, refreshed);
    return this.get(instanceId);
  }

  async replace(
    instanceId: string,
    options: BackendInstanceReplacementOptions = {}
  ): Promise<BackendInstanceSnapshot> {
    const previous = this.#instances.get(instanceId);
    const factory = this.#factories.get(instanceId);
    if (previous === undefined || factory === undefined) throw new Error(`Unknown Backend instance: ${instanceId}`);
    if (factory.adapterKind !== previous.descriptor.adapterKind) {
      throw new Error(`Backend Adapter kind cannot change for an existing instance: ${instanceId}`);
    }

    const reservation = this.authority.reserveBackendInstanceGeneration({
      backendId: factory.instanceId,
      adapterKind: factory.adapterKind
    });
    if (reservation.expectedCurrentGeneration !== previous.generation) {
      throw new Error(`Backend durable current generation changed before replacement: ${factory.instanceId}`);
    }
    const protectedAdapters = new Set(this.availableAdapters());
    let candidate = await this.#prepare(factory, reservation.generation, protectedAdapters);
    if (previous.state === "available" && candidate.state === "available" && candidate.adapter === previous.adapter) {
      throw new Error(`Backend replacement factory reused the current Adapter object: ${instanceId}`);
    }
    if (candidate.state === "unavailable" || !replacementCandidateAccepted(candidate.descriptor)) {
      if (candidate.state === "available") await this.#cleanupRejectedCandidate(candidate);
      throw new Error(`Backend replacement candidate failed validation: ${instanceId}`);
    }
    if (this.#instances.get(factory.instanceId) !== previous) {
      await this.#cleanupRejectedCandidate(candidate);
      throw new Error(`Backend instance changed during replacement: ${factory.instanceId}`);
    }

    let publication: BackendDescriptorPublication;
    let published = false;
    try {
      await options.preparePrevious?.({
        instanceId: previous.instanceId,
        generation: previous.generation,
        ...(previous.state === "available" ? { adapter: previous.adapter } : {}),
        candidateGeneration: candidate.generation,
        candidateAdapter: candidate.adapter
      });
      if (previous.state === "available") await previous.adapter.quiesceForReplacement?.();
      if (this.#instances.get(factory.instanceId) !== previous) {
        throw new Error(`Backend instance changed while its previous generation was being prepared: ${factory.instanceId}`);
      }
      const refreshedDescriptor = await candidate.adapter.describe();
      if (refreshedDescriptor.id !== factory.instanceId) {
        throw new Error("Backend descriptor identity changed during replacement preparation.");
      }
      candidate = {
        ...candidate,
        descriptor: this.#normalizeDescriptor(refreshedDescriptor, factory.adapterKind, candidate.generation)
      };
      if (!replacementCandidateAccepted(candidate.descriptor)) {
        throw new Error(`Backend replacement candidate failed validation after preparation: ${instanceId}`);
      }
      if (this.#instances.get(factory.instanceId) !== previous) {
        throw new Error(`Backend instance changed while its candidate was being revalidated: ${factory.instanceId}`);
      }
      publication = this.authority.publishBackendInstanceDescriptor({
        descriptor: candidate.descriptor,
        ...(reservation.expectedCurrentGeneration === undefined
          ? {}
          : { expectedCurrentGeneration: reservation.expectedCurrentGeneration })
      });
      published = publication.status === "published";
    } catch (error) {
      if (!published) await this.#cleanupRejectedCandidate(candidate);
      throw error;
    }
    if (publication.status === "stale") {
      await this.#cleanupRejectedCandidate(candidate);
      throw new Error(`Backend descriptor publication lost its current-generation fence: ${factory.instanceId}`);
    }

    // Durable publication precedes the in-process pointer switch. There is no
    // await between them, so new admissions cannot observe a half-switched
    // process-local registry.
    this.#instances.set(factory.instanceId, candidate);
    options.activateCurrent?.({
      instanceId: candidate.instanceId,
      generation: candidate.generation,
      adapter: candidate.adapter
    });
    if (previous.state === "available") {
      await this.#retirePrevious(previous, options);
    }
    return this.get(factory.instanceId);
  }

  async dispose(): Promise<void> {
    const adapters = this.availableAdapters();
    this.#instances.clear();
    this.#factories.clear();
    const failures: unknown[] = [];
    try {
      await this.disposeRetainedCleanups();
    } catch (error) {
      failures.push(error);
    }
    const results = await Promise.all(adapters.map((adapter) => this.#disposeAdapter(adapter)));
    failures.push(...results.flatMap((result, index) => result
      ? []
      : [new Error(`Backend instance cleanup remained unconfirmed: ${adapters[index]!.id}`)]));
    if (failures.length > 0) throw new AggregateError(failures, "Backend instance disposal failed.");
  }

  async disposeRetainedCleanups(): Promise<void> {
    await Promise.allSettled([
      ...[...this.#candidateCleanupOwners.values()]
        .flatMap((owner) => owner.janitor === undefined ? [] : [owner.janitor]),
      ...[...this.#retiredCleanupOwners.values()]
        .flatMap((owner) => owner.janitor === undefined ? [] : [owner.janitor])
    ]);
    const owners = [
      ...[...this.#candidateCleanupOwners.values()].map((owner) => ({ kind: "candidate" as const, owner })),
      ...[...this.#retiredCleanupOwners.values()].map((owner) => ({ kind: "retired" as const, owner }))
    ];
    const results = await Promise.all(owners.map(({ owner }) => this.#disposeAdapter(owner.adapter)));
    const failures: Error[] = [];
    for (let index = 0; index < owners.length; index += 1) {
      const { kind, owner } = owners[index]!;
      if (results[index]) {
        const key = cleanupKey(owner);
        if (kind === "candidate") {
          if (this.#candidateCleanupOwners.get(key) === owner) this.#candidateCleanupOwners.delete(key);
        } else if (this.#retiredCleanupOwners.get(key) === owner) {
          this.#retiredCleanupOwners.delete(key);
        }
      } else {
        failures.push(new Error(
          `Backend ${kind} cleanup remained unconfirmed: ${owner.instanceId} generation ${owner.generation}`
        ));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Backend retained cleanup remained unconfirmed.");
    }
  }

  async #retirePrevious(
    previous: AvailableBackendInstance,
    options: BackendInstanceReplacementOptions
  ): Promise<void> {
    if (await this.#disposeAdapter(previous.adapter)) return;
    const key = cleanupKey(previous);
    const existing = this.#retiredCleanupOwners.get(key);
    if (existing !== undefined) {
      if (existing.adapter !== previous.adapter) {
        throw new Error(`Backend retired cleanup owner changed for ${previous.instanceId} generation ${previous.generation}.`);
      }
      return;
    }
    const owner: BackendRetiredCleanupOwner = {
      instanceId: previous.instanceId,
      generation: previous.generation,
      state: "cleanup_unknown",
      adapter: previous.adapter
    };
    this.#retiredCleanupOwners.set(key, owner);
    try {
      options.onPreviousCleanupFailure?.({
        instanceId: previous.instanceId,
        generation: previous.generation
      });
    } catch {
      // Diagnostic sinks cannot roll back a durably current generation.
    }
    if (this.#retirementAttempts <= 1) return;
    const janitor = this.#runRetiredCleanupJanitor(owner)
      .finally(() => {
        if (owner.janitor === janitor) owner.janitor = undefined;
      });
    owner.janitor = janitor;
    // The new generation is already durable current. Cleanup retries retain
    // only the exact retired Adapter object and must not delay new dispatch.
    void janitor.catch(() => undefined);
  }

  async #runRetiredCleanupJanitor(owner: BackendRetiredCleanupOwner): Promise<void> {
    for (let attempt = 1; attempt < this.#retirementAttempts; attempt += 1) {
      await delay(this.#retirementRetryDelayMs);
      if (!await this.#disposeAdapter(owner.adapter)) continue;
      const key = cleanupKey(owner);
      if (this.#retiredCleanupOwners.get(key) === owner) this.#retiredCleanupOwners.delete(key);
      return;
    }
  }

  async #disposeAdapter(adapter: BackendAdapter): Promise<boolean> {
    if (await settleBeforeDeadline(
      Promise.resolve().then(() => adapter.dispose()),
      this.#retirementStepTimeoutMs
    )) return true;
    if (adapter.forceDispose === undefined) return false;
    return settleBeforeDeadline(
      Promise.resolve().then(() => adapter.forceDispose!()),
      this.#retirementStepTimeoutMs
    );
  }

  async #cleanupRejectedCandidate(candidate: AvailableBackendInstance): Promise<boolean> {
    const key = cleanupKey(candidate);
    const existing = this.#candidateCleanupOwners.get(key);
    if (existing !== undefined) {
      if (existing.adapter !== candidate.adapter) {
        throw new Error(`Backend candidate cleanup owner changed for ${candidate.instanceId} generation ${candidate.generation}.`);
      }
      return false;
    }
    if (await this.#disposeAdapter(candidate.adapter)) return true;

    const owner: BackendCandidateCleanupOwner = {
      instanceId: candidate.instanceId,
      generation: candidate.generation,
      state: "cleanup_unknown",
      adapter: candidate.adapter
    };
    this.#candidateCleanupOwners.set(key, owner);
    try {
      this.#onCandidateCleanupUnknown?.({
        instanceId: owner.instanceId,
        generation: owner.generation,
        state: owner.state
      });
    } catch {
      // Diagnostic sinks cannot replace the original candidate failure.
    }
    if (this.#retirementAttempts > 1) {
      const janitor = this.#runCandidateCleanupJanitor(owner).finally(() => {
        if (owner.janitor === janitor) owner.janitor = undefined;
      });
      owner.janitor = janitor;
      void janitor.catch(() => undefined);
    }
    return false;
  }

  async #runCandidateCleanupJanitor(owner: BackendCandidateCleanupOwner): Promise<void> {
    for (let attempt = 1; attempt < this.#retirementAttempts; attempt += 1) {
      await delay(this.#retirementRetryDelayMs);
      if (!await this.#disposeAdapter(owner.adapter)) continue;
      const key = cleanupKey(owner);
      if (this.#candidateCleanupOwners.get(key) === owner) this.#candidateCleanupOwners.delete(key);
      return;
    }
  }

  async #publishProvisioned(
    candidate: BackendInstance,
    reservation: BackendInstanceGenerationReservation
  ): Promise<BackendInstance> {
    const publication = this.authority.publishBackendInstanceDescriptor({
      descriptor: candidate.descriptor,
      ...(reservation.expectedCurrentGeneration === undefined
        ? {}
        : { expectedCurrentGeneration: reservation.expectedCurrentGeneration })
    });
    if (publication.status === "published") return candidate;

    if (candidate.state === "available") await this.#cleanupRejectedCandidate(candidate);
    if (publication.current === undefined) {
      throw new Error(`Backend descriptor publication has no durable current: ${candidate.instanceId}`);
    }
    return unavailableCurrent(publication.current);
  }

  async #prepare(
    factory: BackendInstanceFactory,
    generation: number,
    protectedAdapters: ReadonlySet<BackendAdapter> = new Set()
  ): Promise<BackendInstance> {
    validateFactory(factory);
    let adapter: BackendAdapter | undefined;
    try {
      adapter = await factory.create({ instanceId: factory.instanceId, generation });
      if (adapter.id !== factory.instanceId) {
        throw new Error("Backend Adapter identity does not match its registered instance.");
      }
      const descriptor = await adapter.describe();
      if (descriptor.id !== factory.instanceId) {
        throw new Error("Backend descriptor identity does not match its registered instance.");
      }
      return {
        instanceId: factory.instanceId,
        generation,
        state: "available",
        descriptor: this.#normalizeDescriptor(descriptor, factory.adapterKind, generation),
        adapter
      };
    } catch {
      if (adapter !== undefined && !protectedAdapters.has(adapter)) {
        await this.#cleanupRejectedCandidate({
          instanceId: factory.instanceId,
          generation,
          state: "available",
          descriptor: unavailableDescriptor(factory, generation),
          adapter
        });
      }
      return {
        instanceId: factory.instanceId,
        generation,
        state: "unavailable",
        descriptor: unavailableDescriptor(factory, generation)
      };
    }
  }

  #normalizeDescriptor(descriptor: BackendDescriptor, adapterKind: string, generation: number): BackendDescriptor {
    const normalized = normalizeDescriptor(descriptor, adapterKind, generation);
    const projected = this.#projectDescriptor(normalized);
    if (projected.id !== normalized.id) {
      throw new Error("Backend descriptor projection changed its registered identity.");
    }
    return normalizeDescriptor(projected, adapterKind, generation);
  }
}

function unavailableCurrent(current: StoredBackend): UnavailableBackendInstance {
  return {
    instanceId: current.descriptor.id,
    generation: current.descriptor.instanceGeneration,
    state: "unavailable",
    descriptor: current.descriptor
  };
}

function cleanupKey(input: { readonly instanceId: string; readonly generation: number }): string {
  return `${input.instanceId}\0${input.generation}`;
}

function assertUniqueFactories(factories: readonly BackendInstanceFactory[]): void {
  const seen = new Set<string>();
  for (const factory of factories) {
    validateFactory(factory);
    if (seen.has(factory.instanceId)) throw new Error(`Duplicate Backend instance: ${factory.instanceId}`);
    seen.add(factory.instanceId);
  }
}

function validateFactory(factory: BackendInstanceFactory): void {
  if (factory.instanceId.trim() === "" || factory.instanceId !== factory.instanceId.trim()) {
    throw new Error("Backend instance identity must be a non-empty normalized string.");
  }
  if (factory.displayName.trim() === "") throw new Error("Backend instance display name is required.");
  if (factory.adapterKind.trim() === "" || factory.adapterKind !== factory.adapterKind.trim()) {
    throw new Error("Backend Adapter kind must be a non-empty normalized string.");
  }
}

function unavailableDescriptor(factory: BackendInstanceFactory, generation: number): BackendDescriptor {
  return {
    id: factory.instanceId,
    adapterKind: factory.adapterKind,
    instanceGeneration: generation,
    displayName: factory.displayName,
    version: "unknown",
    health: "unavailable",
    installationState: "error",
    authenticationState: "error",
    error: {
      code: "BACKEND_INSTANCE_INITIALIZATION_FAILED",
      message: "Backend instance initialization failed before publication.",
      phase: "provision",
      retryable: true,
      stateMayHaveChanged: false,
      recovery: "Verify the native runtime installation and retry provisioning."
    },
    capabilities: new Map(),
    models: [],
    tools: [],
    // Never retain or project the candidate exception: process failures can
    // contain command lines, environment fragments, or credential material.
    diagnostics: ["Backend instance initialization failed before publication."]
  };
}

function normalizeDescriptor(
  descriptor: BackendDescriptor,
  adapterKind: string,
  generation: number
): BackendDescriptor {
  return {
    ...descriptor,
    adapterKind,
    instanceGeneration: generation
  };
}

function replacementCandidateAccepted(descriptor: BackendDescriptor): boolean {
  return descriptor.health !== "unavailable"
    && (descriptor.installationState === "installed" || descriptor.installationState === "update_available");
}

async function settleBeforeDeadline(task: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      task.then(() => true, () => false),
      timeout
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function delay(timeoutMs: number): Promise<void> {
  if (timeoutMs === 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer.`);
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer.`);
  return value;
}
