import { randomUUID } from "node:crypto";
import { createSimulatorLifecycleRuntime, SimulatorCreateError, SimulatorLifecycleError,
  SimulatorResourceError, type SimulatorLifecycleRuntime } from "@joko/tool-ios-simulator";
import { OperationInProgressError, type OperationalStore } from "@joko/store";
import { SimulatorCreateCoordinator } from "./ios-simulator-create-coordinator.js";
import { SimulatorDriverCoordinator, SimulatorDriverError } from "./ios-simulator-driver-coordinator.js";
import { SimulatorLifecycleCoordinator, type SimulatorLifecycleEffectAuthority } from "./ios-simulator-lifecycle-coordinator.js";
import { SimulatorOwnershipError, SimulatorOwnershipRegistry,
  type PublicSimulatorInstance, type SimulatorInstanceRoute, type SimulatorTaskScope } from "./ios-simulator-ownership.js";

const KIND = "ios_simulator_instance_control";
const DIGEST = /^[0-9a-f]{64}$/u;
const BODY_HASH = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const DETACH_GRACE_MS = 10 * 60_000;
const DETACH_RETRY_MS = 60_000;

export class SimulatorInstanceControlError extends Error {
  constructor(readonly code: "INVALID_ARGUMENT" | "MUTATION_CANCELLED" | "INSTANCE_CONTROL_UNKNOWN" |
    "STALE_INSTANCE" | "MUTATION_IN_PROGRESS", message: string) { super(message); }
}

export interface SimulatorInstanceControlExecution {
  readonly instance: PublicSimulatorInstance;
  readonly replayed: boolean;
}

function route(instance: PublicSimulatorInstance): SimulatorInstanceRoute {
  return { instanceId: instance.instanceId, generation: instance.generation, leaseId: instance.lease.id };
}

/** Durable top-level instance actions. The underlying create, lifecycle and driver effects retain their own boundaries. */
export class SimulatorInstanceControlCoordinator {
  readonly #store: OperationalStore;
  readonly #ownership: SimulatorOwnershipRegistry;
  readonly #create: SimulatorCreateCoordinator;
  readonly #lifecycle: SimulatorLifecycleCoordinator;
  readonly #driver: SimulatorDriverCoordinator;
  readonly #devices: SimulatorLifecycleRuntime;
  readonly #now: () => number;
  readonly #graceMs: number;
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #exit = new AbortController();
  #recoverySweep: NodeJS.Timeout | undefined;

  constructor(store: OperationalStore, ownership: SimulatorOwnershipRegistry, input: {
    readonly create: SimulatorCreateCoordinator;
    readonly lifecycle: SimulatorLifecycleCoordinator;
    readonly driver: SimulatorDriverCoordinator;
    readonly devices?: SimulatorLifecycleRuntime;
    readonly now?: () => number;
    readonly detachGraceMs?: number;
  }) {
    this.#store = store;
    this.#ownership = ownership;
    this.#create = input.create;
    this.#lifecycle = input.lifecycle;
    this.#driver = input.driver;
    this.#devices = input.devices ?? createSimulatorLifecycleRuntime();
    this.#now = input.now ?? Date.now;
    this.#graceMs = input.detachGraceMs ?? DETACH_GRACE_MS;
    if (!Number.isSafeInteger(this.#graceMs) || this.#graceMs < 1) {
      throw new SimulatorInstanceControlError("INVALID_ARGUMENT", "Simulator detach grace is invalid.");
    }
  }

  create(scope: SimulatorTaskScope, input: { readonly templateUdid: string; readonly name: string },
    authority: SimulatorLifecycleEffectAuthority, signal?: AbortSignal): Promise<SimulatorInstanceControlExecution> {
    if (!UUID.test(input.templateUdid) || typeof input.name !== "string" || input.name.length < 1 ||
        input.name.length > 128 || input.name.trim() !== input.name || /[\u0000-\u001f\u007f]/u.test(input.name)) {
      throw new SimulatorInstanceControlError("INVALID_ARGUMENT", "Simulator template or name is invalid.");
    }
    return this.#run("create", scope, { templateUdid: input.templateUdid.toUpperCase(), name: input.name },
      authority, () => this.#ownership.assertCanCreate(scope),
      async () => (await this.#create.create(scope, input, authority, signal)).instance,
      instance => this.#attachViewer(scope, instance), signal);
  }

  attach(scope: SimulatorTaskScope, udid: string, authority: SimulatorLifecycleEffectAuthority,
    signal?: AbortSignal): Promise<SimulatorInstanceControlExecution> {
    if (!UUID.test(udid)) throw new SimulatorInstanceControlError("INVALID_ARGUMENT", "Simulator UDID is invalid.");
    const normalized = udid.toUpperCase();
    return this.#run("attach", scope, { udid: normalized }, authority,
      () => this.#ownership.assertScope(scope), async () => {
        const observed = await this.#devices.findExact(normalized, signal);
        if (!observed || observed.udid.toUpperCase() !== normalized || !observed.isAvailable) {
          throw new SimulatorInstanceControlError("STALE_INSTANCE", "Selected Simulator device is unavailable.");
        }
        const bound = this.#ownership.bindExternalDevice(scope, observed);
        if (observed.state.toLowerCase() !== "booted") return bound;
        if (this.#driver.isReady(bound)) return bound;
        return (await this.#driver.start(scope, route(bound), authority, signal)).instance;
      }, instance => this.#attachViewer(scope, instance), signal);
  }

  start(scope: SimulatorTaskScope, instanceRoute: SimulatorInstanceRoute,
    authority: SimulatorLifecycleEffectAuthority, signal?: AbortSignal): Promise<SimulatorInstanceControlExecution> {
    return this.#run("start", scope, { ...instanceRoute }, authority,
      () => this.#ownership.requireRoute(scope, instanceRoute), async () => {
        const current = this.#ownership.requireRoute(scope, instanceRoute);
        if (current.lifecycleState === "ready") {
          if (this.#driver.isReady(current)) return current;
          return (await this.#driver.start(scope, instanceRoute, authority, signal)).instance;
        }
        const booted = await this.#lifecycle.start(scope, instanceRoute, authority, signal);
        return (await this.#driver.start(scope, route(booted.instance), authority, signal)).instance;
      }, instance => this.#attachViewer(scope, instance), signal);
  }

  stop(scope: SimulatorTaskScope, instanceRoute: SimulatorInstanceRoute,
    authority: SimulatorLifecycleEffectAuthority, signal?: AbortSignal): Promise<SimulatorInstanceControlExecution> {
    return this.#run("stop", scope, { ...instanceRoute }, authority,
      () => this.#ownership.requireRoute(scope, instanceRoute), async () => {
        const retired = await this.#driver.stop(scope, instanceRoute, authority, signal);
        return (await this.#lifecycle.stop(scope, route(retired.instance), authority, signal)).instance;
      }, instance => instance, signal);
  }

  detach(scope: SimulatorTaskScope, instanceRoute: SimulatorInstanceRoute,
    authority: SimulatorLifecycleEffectAuthority, signal?: AbortSignal): Promise<SimulatorInstanceControlExecution> {
    return this.#run("detach", scope, { ...instanceRoute }, authority,
      () => this.#ownership.requireRoute(scope, instanceRoute),
      async () => (await this.#driver.stop(scope, instanceRoute, authority, signal)).instance,
      instance => {
        const grace = instance.bootProvenance === "agent_booted" ? this.#now() + this.#graceMs : null;
        const detached = this.#ownership.detachViewer(scope, route(instance), grace);
        return grace === null ? this.#ownership.releaseDetached(scope, route(detached)) : detached;
      }, signal);
  }

  /** Re-arm persisted grace after Store startup recovery; due records are handled before returning. */
  async reconcileDetachedGrace(): Promise<void> {
    for (const candidate of this.#ownership.detachedGraceCandidates()) {
      if (candidate.graceExpiresAt === null) continue;
      if (candidate.graceExpiresAt <= this.#now()) {
        try { await this.#cleanupGrace(candidate); }
        catch { this.#retryGrace(candidate); }
      }
      else this.#scheduleGrace(candidate, candidate.graceExpiresAt - this.#now());
    }
  }

  async reconcileAbandoned(): Promise<void> {
    for (const candidate of this.#ownership.listForRecovery()) {
      if (this.#ownership.isTaskBindingActive(candidate.instanceId)) continue;
      try { await this.#cleanupAbandoned(candidate); }
      catch { /* Exact binding and failed Operation remain for the next sweep. */ }
    }
  }

  startRecoverySweep(): void {
    if (this.#recoverySweep || this.#exit.signal.aborted) return;
    this.#recoverySweep = setInterval(() => {
      void this.reconcileAbandoned().catch(() => undefined);
    }, DETACH_RETRY_MS);
    this.#recoverySweep.unref?.();
  }

  dispose(): void {
    this.#exit.abort();
    if (this.#recoverySweep) clearInterval(this.#recoverySweep);
    this.#recoverySweep = undefined;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  diagnoseDrivers(instances: readonly PublicSimulatorInstance[]): readonly {
    readonly instanceId: string; readonly state: "ready" | "stopped" | "error" | "unavailable";
    readonly reasonCode: string | null }[] {
    return instances.map(instance => ({ instanceId: instance.instanceId, ...this.#driver.diagnose(instance) }));
  }

  async #run(action: "create" | "attach" | "start" | "stop" | "detach", scope: SimulatorTaskScope,
    arguments_: Readonly<Record<string, unknown>>, authority: SimulatorLifecycleEffectAuthority,
    admit: () => unknown, perform: () => Promise<PublicSimulatorInstance>,
    finish: (instance: PublicSimulatorInstance) => PublicSimulatorInstance,
    signal?: AbortSignal): Promise<SimulatorInstanceControlExecution> {
    if (!DIGEST.test(authority.effectIdentity) || !BODY_HASH.test(authority.requestBodyHash) ||
        !Number.isSafeInteger(authority.providerGeneration) || authority.providerGeneration < 1) {
      throw new SimulatorInstanceControlError("INVALID_ARGUMENT", "Simulator effect authority is unavailable.");
    }
    if (signal?.aborted) throw new SimulatorInstanceControlError("MUTATION_CANCELLED", "Simulator operation was cancelled.");
    this.#ownership.reconcileRecoveredEffects(scope);
    const operationId = `ios-simulator-control:${authority.effectIdentity}`;
    const claim = this.#store.claimDeferredEffectOperation<PublicSimulatorInstance>({ id: operationId, kind: KIND,
      body: { action, sessionId: scope.sessionId, targetId: scope.targetId,
        bindingGeneration: scope.generation, ...arguments_, requestBodyHash: authority.requestBodyHash,
        providerGeneration: authority.providerGeneration }
    }, () => {
      admit();
      let offset = 0;
      for (;;) {
        const page = this.#store.listOperations({ sessionId: scope.sessionId, status: "started", limit: 500, offset });
        const conflict = page.find(operation => operation.id !== operationId &&
          [KIND, "ios_simulator_create", "ios_simulator_lifecycle", "ios_simulator_driver",
            "ios_simulator_grace_cleanup", "ios_simulator_removed_cleanup"].includes(operation.kind));
        if (conflict) throw new OperationInProgressError(conflict.id);
        if (page.length < 500) break;
        offset += page.length;
      }
    });
    if (!claim.claimed) {
      const current = this.#ownership.listForTask(scope).find(item => item.instanceId === claim.value.instanceId);
      const released = action === "detach" && !current &&
        this.#ownership.deviceByUdid(claim.value.simulatorUdid) === null;
      if (!released && (!current || current.generation !== claim.value.generation)) {
        throw new SimulatorInstanceControlError("STALE_INSTANCE", "Simulator instance changed after this operation.");
      }
      this.#afterCompleted(claim.value);
      return { instance: claim.value, replayed: true };
    }
    try {
      const performed = await perform();
      const completed = this.#store.completeDeferredEffectOperation<PublicSimulatorInstance>(operationId,
        claim.operation.bodyHash, () => finish(performed));
      this.#afterCompleted(completed.value);
      return { instance: completed.value, replayed: completed.replayed };
    } catch (error) {
      const safe = error instanceof SimulatorInstanceControlError || error instanceof SimulatorCreateError ||
        error instanceof SimulatorLifecycleError || error instanceof SimulatorResourceError ||
        error instanceof SimulatorDriverError || error instanceof SimulatorOwnershipError ? error
        : error instanceof OperationInProgressError
          ? new SimulatorInstanceControlError("MUTATION_IN_PROGRESS", "Simulator operation is already in progress.")
          : new SimulatorInstanceControlError("INSTANCE_CONTROL_UNKNOWN", "Simulator instance outcome is unknown.");
      try { this.#store.failEffectOperation(operationId, claim.operation.bodyHash, safe); }
      catch { /* Store startup recovery fences the unfinished top-level effect. */ }
      throw safe;
    }
  }

  #attachViewer(scope: SimulatorTaskScope, instance: PublicSimulatorInstance): PublicSimulatorInstance {
    const ready = this.#driver.isReady(instance);
    const attached = this.#ownership.attachViewer(scope, route(instance));
    if (ready) this.#driver.rebindReadyRoute(instance, attached);
    return attached;
  }

  #afterCompleted(instance: PublicSimulatorInstance): void {
    this.#cancelGrace(instance.instanceId);
    if (instance.graceExpiresAt !== null) this.#scheduleGrace(instance, instance.graceExpiresAt - this.#now());
  }

  #cancelGrace(instanceId: string): void {
    const timer = this.#timers.get(instanceId);
    if (timer) clearTimeout(timer);
    this.#timers.delete(instanceId);
  }

  #scheduleGrace(instance: PublicSimulatorInstance, delayMs: number): void {
    this.#cancelGrace(instance.instanceId);
    if (this.#exit.signal.aborted || instance.graceExpiresAt === null) return;
    const timer = setTimeout(() => {
      this.#timers.delete(instance.instanceId);
      void this.#cleanupGrace(instance).catch(() => { this.#retryGrace(instance); });
    }, Math.max(0, delayMs));
    timer.unref?.();
    this.#timers.set(instance.instanceId, timer);
  }

  #sameGrace(current: PublicSimulatorInstance, expected: PublicSimulatorInstance): boolean {
    return current.instanceId === expected.instanceId && current.generation === expected.generation &&
      current.simulatorUdid === expected.simulatorUdid && current.viewerState === "detached" &&
      current.bootProvenance === "agent_booted" && current.graceExpiresAt === expected.graceExpiresAt;
  }

  #retryGrace(expected: PublicSimulatorInstance): void {
    try {
      const current = this.#ownership.deviceByUdid(expected.simulatorUdid);
      if (current && this.#sameGrace(current, expected)) this.#scheduleGrace(current, DETACH_RETRY_MS);
    } catch { /* Invalid persisted state remains visible to the next explicit recovery. */ }
  }

  async #cleanupGrace(expected: PublicSimulatorInstance): Promise<void> {
    if (this.#exit.signal.aborted || expected.graceExpiresAt === null || expected.graceExpiresAt > this.#now()) return;
    const operationId = `ios-simulator-grace:${randomUUID()}`;
    const claim = this.#store.claimDeferredEffectOperation<{ released: boolean }>({
      id: operationId, kind: "ios_simulator_grace_cleanup",
      body: { sessionId: expected.sessionId, targetId: expected.targetId,
        instanceId: expected.instanceId, simulatorUdid: expected.simulatorUdid,
        generation: expected.generation, graceExpiresAt: expected.graceExpiresAt }
    }, () => {
      const current = this.#ownership.deviceByUdid(expected.simulatorUdid);
      if (!current || !this.#sameGrace(current, expected) || current.graceExpiresAt! > this.#now()) {
        throw new SimulatorInstanceControlError("STALE_INSTANCE", "Simulator detach grace changed.");
      }
      let offset = 0;
      for (;;) {
        const page = this.#store.listOperations({ sessionId: current.sessionId, status: "started", limit: 500, offset });
        const conflict = page.find(operation => operation.id !== operationId &&
          [KIND, "ios_simulator_create", "ios_simulator_lifecycle", "ios_simulator_driver",
            "ios_simulator_grace_cleanup", "ios_simulator_removed_cleanup"].includes(operation.kind));
        if (conflict) throw new OperationInProgressError(conflict.id);
        if (page.length < 500) break;
        offset += page.length;
      }
    });
    if (!claim.claimed) return;
    try {
      const observed = await this.#devices.findExact(expected.simulatorUdid, this.#exit.signal);
      if (!observed || observed.udid.toUpperCase() !== expected.simulatorUdid) {
        throw new SimulatorInstanceControlError("STALE_INSTANCE", "Detached Simulator device is unavailable.");
      }
      if (observed.state.toLowerCase() !== "shutdown") {
        await this.#devices.shutdownExact(expected.simulatorUdid, this.#exit.signal);
      }
      const terminal = await this.#devices.findExact(expected.simulatorUdid, this.#exit.signal);
      if (!terminal || terminal.udid.toUpperCase() !== expected.simulatorUdid ||
          terminal.state.toLowerCase() !== "shutdown" || this.#exit.signal.aborted) {
        throw new SimulatorInstanceControlError("INSTANCE_CONTROL_UNKNOWN", "Simulator grace cleanup outcome is unknown.");
      }
      this.#store.completeDeferredEffectOperation(operationId, claim.operation.bodyHash, () => ({
        released: this.#ownership.releaseAfterGrace({ instanceId: expected.instanceId,
          simulatorUdid: expected.simulatorUdid, generation: expected.generation,
          graceExpiresAt: expected.graceExpiresAt! }) !== null
      }));
      this.#cancelGrace(expected.instanceId);
    } catch {
      try { this.#store.failEffectOperation(operationId, claim.operation.bodyHash,
        new SimulatorInstanceControlError("INSTANCE_CONTROL_UNKNOWN", "Simulator grace cleanup outcome is unknown.")); }
      catch { /* Startup recovery will fence the unfinished cleanup. */ }
      throw new SimulatorInstanceControlError("INSTANCE_CONTROL_UNKNOWN", "Simulator grace cleanup outcome is unknown.");
    }
  }

  async #cleanupAbandoned(expected: PublicSimulatorInstance): Promise<void> {
    if (this.#exit.signal.aborted) return;
    const operationId = `ios-simulator-removed:${randomUUID()}`;
    let quarantined: PublicSimulatorInstance | null = null;
    const claim = this.#store.claimDeferredEffectOperation<{ released: boolean }>({
      id: operationId, kind: "ios_simulator_removed_cleanup",
      body: { sessionId: expected.sessionId, targetId: expected.targetId,
        instanceId: expected.instanceId, simulatorUdid: expected.simulatorUdid,
        generation: expected.generation }
    }, () => {
      let offset = 0;
      for (;;) {
        const page = this.#store.listOperations({ sessionId: expected.sessionId,
          status: "started", limit: 500, offset });
        const conflict = page.find(operation => operation.id !== operationId &&
          [KIND, "ios_simulator_create", "ios_simulator_lifecycle", "ios_simulator_driver",
            "ios_simulator_grace_cleanup", "ios_simulator_removed_cleanup"].includes(operation.kind));
        if (conflict) throw new OperationInProgressError(conflict.id);
        if (page.length < 500) break;
        offset += page.length;
      }
      quarantined = this.#ownership.quarantineAbandoned(expected);
      if (!quarantined) throw new SimulatorInstanceControlError("STALE_INSTANCE", "Simulator task binding changed.");
    });
    if (!claim.claimed || !quarantined) return;
    const owned = quarantined as PublicSimulatorInstance;
    try {
      await this.#driver.retireAbandoned(owned, this.#exit.signal);
      if (owned.bootProvenance === "agent_booted") {
        const before = await this.#devices.findExact(owned.simulatorUdid, this.#exit.signal);
        if (before && before.udid.toUpperCase() !== owned.simulatorUdid) {
          throw new SimulatorInstanceControlError("STALE_INSTANCE", "Simulator device identity changed.");
        }
        if (before && before.state.toLowerCase() !== "shutdown") {
          await this.#devices.shutdownExact(owned.simulatorUdid, this.#exit.signal);
        }
        const terminal = await this.#devices.findExact(owned.simulatorUdid, this.#exit.signal);
        if ((terminal && (terminal.udid.toUpperCase() !== owned.simulatorUdid ||
            terminal.state.toLowerCase() !== "shutdown")) || this.#exit.signal.aborted) {
          throw new SimulatorInstanceControlError("INSTANCE_CONTROL_UNKNOWN", "Simulator task cleanup outcome is unknown.");
        }
      }
      this.#store.completeDeferredEffectOperation(operationId, claim.operation.bodyHash, () => ({
        released: this.#ownership.releaseAbandoned(owned) !== null
      }));
      this.#cancelGrace(owned.instanceId);
    } catch {
      try { this.#store.failEffectOperation(operationId, claim.operation.bodyHash,
        new SimulatorInstanceControlError("INSTANCE_CONTROL_UNKNOWN", "Simulator task cleanup outcome is unknown.")); }
      catch { /* Startup recovery will fence the unfinished cleanup. */ }
      throw new SimulatorInstanceControlError("INSTANCE_CONTROL_UNKNOWN", "Simulator task cleanup outcome is unknown.");
    }
  }
}
