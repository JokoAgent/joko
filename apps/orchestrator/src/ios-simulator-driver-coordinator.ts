import { cleanupWdaOrphanProcesses, createSimulatorEnvironmentRuntime, createSimulatorLifecycleRuntime,
  WdaDriverManager, WdaLoopbackClient, type SimulatorEnvironmentRuntime, type SimulatorLifecycleRuntime,
  type WdaAccessibilitySnapshot, type WdaDriverStartOptions, type WdaOrphanCleanupInput,
  type WdaPoint, type WdaRunningDriver, type WdaViewport } from "@joko/tool-ios-simulator";
import { OperationInProgressError, type OperationalStore } from "@joko/store";
import { SimulatorDriverStateRegistry } from "./ios-simulator-driver-state.js";
import { SimulatorOwnershipError, SimulatorOwnershipRegistry,
  type PublicSimulatorInstance, type SimulatorInstanceRoute, type SimulatorTaskScope } from "./ios-simulator-ownership.js";
import type { SimulatorLifecycleEffectAuthority } from "./ios-simulator-lifecycle-coordinator.js";

const KIND = "ios_simulator_driver";
const DIGEST = /^[0-9a-f]{64}$/u;
const BODY_HASH = /^sha256:[0-9a-f]{64}$/u;

export type SimulatorDriverErrorCode = "INVALID_ARGUMENT" | "MUTATION_CANCELLED" | "DRIVER_UNAVAILABLE" |
  "DEVICE_NOT_BOOTED" | "DRIVER_BUSY" | "DRIVER_CONFLICT" | "DRIVER_START_UNKNOWN" |
  "DRIVER_STOP_UNKNOWN" | "DRIVER_RUNTIME_LOST" | "STALE_DRIVER" | "INPUT_OUTCOME_UNKNOWN" |
  "CLEANUP_REQUIRED";

export class SimulatorDriverError extends Error {
  constructor(readonly code: SimulatorDriverErrorCode, message: string) { super(message); }
}

type DriverManager = Pick<WdaDriverManager, "start" | "stop" | "get" | "retryOwnedCleanup">;
type DriverValue = { readonly instance: PublicSimulatorInstance; readonly state: "ready" | "stopped" };
export type SimulatorDriverExecution = DriverValue & { readonly replayed: boolean };

export interface SimulatorDriverCoordinatorOptions {
  readonly archivePath: string;
  readonly cacheRoot: string;
  readonly manager?: DriverManager;
  readonly environment?: SimulatorEnvironmentRuntime;
  readonly lifecycle?: SimulatorLifecycleRuntime;
  readonly cleanupOrphans?: (input: WdaOrphanCleanupInput) => Promise<void>;
  readonly architecture?: "arm64" | "x86_64";
  readonly state?: SimulatorDriverStateRegistry;
}

function buildVersion(value: string | null): string | null {
  const match = /(?:^|\n)Build version ([A-Za-z0-9.()-]{1,100})(?:\n|$)/u.exec(value ?? "");
  return match?.[1] ?? null;
}

function architecture(value?: "arm64" | "x86_64"): "arm64" | "x86_64" {
  if (value) return value;
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x86_64";
  throw new SimulatorDriverError("DRIVER_UNAVAILABLE", "Host architecture does not support the Simulator driver.");
}

/** Internal Store effect boundary. Tool publication and Viewer presentation belong to later composition. */
export class SimulatorDriverCoordinator {
  readonly #store: OperationalStore;
  readonly #ownership: SimulatorOwnershipRegistry;
  readonly #state: SimulatorDriverStateRegistry;
  readonly #manager: DriverManager;
  readonly #environment: SimulatorEnvironmentRuntime;
  readonly #lifecycle: SimulatorLifecycleRuntime;
  readonly #cleanup: (input: WdaOrphanCleanupInput) => Promise<void>;
  readonly #cacheRoot: string;
  readonly #architecture: "arm64" | "x86_64";

  constructor(store: OperationalStore, ownership: SimulatorOwnershipRegistry,
    options: SimulatorDriverCoordinatorOptions) {
    this.#store = store;
    this.#ownership = ownership;
    this.#state = options.state ?? new SimulatorDriverStateRegistry(store);
    this.#manager = options.manager ?? new WdaDriverManager({ archivePath: options.archivePath,
      cacheRoot: options.cacheRoot });
    this.#environment = options.environment ?? createSimulatorEnvironmentRuntime();
    this.#lifecycle = options.lifecycle ?? createSimulatorLifecycleRuntime();
    this.#cleanup = options.cleanupOrphans ?? cleanupWdaOrphanProcesses;
    this.#cacheRoot = options.cacheRoot;
    this.#architecture = architecture(options.architecture);
  }

  start(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    authority: SimulatorLifecycleEffectAuthority, signal?: AbortSignal): Promise<SimulatorDriverExecution> {
    return this.#execute("start", scope, route, authority, signal);
  }

  stop(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    authority: SimulatorLifecycleEffectAuthority, signal?: AbortSignal): Promise<SimulatorDriverExecution> {
    return this.#execute("stop", scope, route, authority, signal);
  }

  isReady(instance: PublicSimulatorInstance): boolean {
    const active = this.#manager.get(instance.instanceId);
    return active?.state === "ready" && active.simulatorUdid === instance.simulatorUdid &&
      this.#state.isCurrentReady(instance.instanceId, instance.generation, active.leaseId);
  }

  async observeAccessibilityTree(instance: PublicSimulatorInstance,
    signal?: AbortSignal): Promise<WdaAccessibilitySnapshot> {
    const active = this.#manager.get(instance.instanceId);
    if (!active || !this.isReady(instance)) {
      throw new SimulatorDriverError("DRIVER_RUNTIME_LOST", "Simulator driver is not ready for observation.");
    }
    const client = new WdaLoopbackClient({ controlPort: active.controlPort, cacheRoot: this.#cacheRoot,
      instanceId: instance.instanceId, simulatorUdid: instance.simulatorUdid,
      maxResponseBytes: 8 * 1024 * 1024 });
    const observed = await client.getAccessibilityTree(active.driverSessionId, signal);
    const current = this.#manager.get(instance.instanceId);
    if (!this.isReady(instance) || !current || current.leaseId !== active.leaseId ||
        current.driverSessionId !== active.driverSessionId || current.controlPort !== active.controlPort) {
      throw new SimulatorDriverError("STALE_DRIVER", "Simulator driver changed during observation.");
    }
    return observed;
  }

  async observeViewport(instance: PublicSimulatorInstance, signal?: AbortSignal): Promise<WdaViewport> {
    const active = this.#manager.get(instance.instanceId);
    if (!active || !this.isReady(instance)) {
      throw new SimulatorDriverError("DRIVER_RUNTIME_LOST", "Simulator driver is not ready for observation.");
    }
    const client = new WdaLoopbackClient({ controlPort: active.controlPort, cacheRoot: this.#cacheRoot,
      instanceId: instance.instanceId, simulatorUdid: instance.simulatorUdid });
    const viewport = await client.getViewport(active.driverSessionId, signal);
    const current = this.#manager.get(instance.instanceId);
    if (!this.isReady(instance) || !current || current.leaseId !== active.leaseId ||
        current.driverSessionId !== active.driverSessionId || current.controlPort !== active.controlPort) {
      throw new SimulatorDriverError("STALE_DRIVER", "Simulator driver changed during observation.");
    }
    return viewport;
  }

  tap(instance: PublicSimulatorInstance, target: WdaPoint, signal?: AbortSignal): Promise<void> {
    return this.#input(instance, (client, sessionId) => client.tap(sessionId, target, signal));
  }

  swipe(instance: PublicSimulatorInstance, start: WdaPoint, end: WdaPoint, durationMs: number,
    signal?: AbortSignal): Promise<void> {
    return this.#input(instance, (client, sessionId) =>
      client.swipe(sessionId, start, end, durationMs, signal));
  }

  typeText(instance: PublicSimulatorInstance, text: string, signal?: AbortSignal): Promise<void> {
    return this.#input(instance, (client, sessionId) => client.typeText(sessionId, text, signal));
  }

  pressHome(instance: PublicSimulatorInstance, signal?: AbortSignal): Promise<void> {
    return this.#input(instance, (client, sessionId) => client.home(sessionId, signal));
  }

  lockScreen(instance: PublicSimulatorInstance, signal?: AbortSignal): Promise<void> {
    return this.#input(instance, (client, sessionId) => client.lock(sessionId, signal));
  }

  unlockScreen(instance: PublicSimulatorInstance, signal?: AbortSignal): Promise<void> {
    return this.#input(instance, (client, sessionId) => client.unlock(sessionId, signal));
  }

  async setOrientation(instance: PublicSimulatorInstance, orientation: WdaViewport["orientation"],
    signal?: AbortSignal): Promise<WdaViewport> {
    const active = this.#manager.get(instance.instanceId);
    if (!active || !this.isReady(instance)) {
      throw new SimulatorDriverError("DRIVER_RUNTIME_LOST",
        "Simulator driver is not ready for orientation control.");
    }
    const client = new WdaLoopbackClient({ controlPort: active.controlPort, cacheRoot: this.#cacheRoot,
      instanceId: instance.instanceId, simulatorUdid: instance.simulatorUdid });
    await client.setOrientation(active.driverSessionId, orientation, signal);
    const viewport = await client.getViewport(active.driverSessionId, signal);
    const current = this.#manager.get(instance.instanceId);
    if (!this.isReady(instance) || !current || current.leaseId !== active.leaseId ||
        current.driverSessionId !== active.driverSessionId || current.controlPort !== active.controlPort) {
      throw new SimulatorDriverError("INPUT_OUTCOME_UNKNOWN",
        "Simulator orientation completed while its driver route changed; observe before retrying.");
    }
    return viewport;
  }

  diagnose(instance: PublicSimulatorInstance): { readonly state: "ready" | "stopped" | "error" | "unavailable";
    readonly reasonCode: string | null } {
    if (this.isReady(instance)) return { state: "ready", reasonCode: null };
    const record = this.#state.get(instance.instanceId);
    if (!record) return { state: "stopped", reasonCode: null };
    if (record.state === "error") return { state: "error", reasonCode: record.errorCode };
    return { state: "unavailable", reasonCode: "DRIVER_RUNTIME_LOST" };
  }

  /** Keep the ready projection aligned when presentation alone rotates an instance route. */
  rebindReadyRoute(previous: PublicSimulatorInstance, next: PublicSimulatorInstance): void {
    const active = this.#manager.get(previous.instanceId);
    if (!active || !this.isReady(previous) || next.instanceId !== previous.instanceId ||
        next.simulatorUdid !== previous.simulatorUdid || next.generation !== previous.generation + 1) {
      throw new SimulatorDriverError("STALE_DRIVER", "Simulator driver route changed before Viewer attachment.");
    }
    this.#state.ready(next, active.leaseId);
  }

  /** A caller with a durable lost-task cleanup claim may retire only this service's exact runtime. */
  async retireAbandoned(instance: PublicSimulatorInstance, signal?: AbortSignal): Promise<void> {
    const prior = this.#state.get(instance.instanceId);
    const active = this.#manager.get(instance.instanceId);
    if (prior && prior.simulatorUdid !== instance.simulatorUdid ||
        active && active.simulatorUdid !== instance.simulatorUdid) {
      throw new SimulatorDriverError("DRIVER_CONFLICT", "Simulator driver ownership changed.");
    }
    if (prior?.state === "ready" && (!active || active.state !== "ready" ||
        !this.#state.isCurrentReady(instance.instanceId, prior.instanceGeneration, active.leaseId) ||
        ![instance.generation, instance.generation - 1].includes(prior.instanceGeneration))) {
      throw new SimulatorDriverError("DRIVER_BUSY", "Another driver runtime still owns this simulator.");
    }
    if (signal?.aborted) throw new SimulatorDriverError("MUTATION_CANCELLED", "Simulator cleanup was cancelled.");
    if (active) await this.#manager.stop(instance.instanceId, active.leaseId);
    await this.#manager.retryOwnedCleanup(instance.instanceId);
    await this.#cleanup({ cacheRoot: this.#cacheRoot, instanceId: instance.instanceId,
      simulatorUdid: instance.simulatorUdid, signal });
    this.#state.clear(instance.instanceId);
  }

  async #input(instance: PublicSimulatorInstance,
    perform: (client: WdaLoopbackClient, sessionId: string) => Promise<void>): Promise<void> {
    const active = this.#manager.get(instance.instanceId);
    if (!active || !this.isReady(instance)) {
      throw new SimulatorDriverError("DRIVER_RUNTIME_LOST", "Simulator driver is not ready for input.");
    }
    const client = new WdaLoopbackClient({ controlPort: active.controlPort, cacheRoot: this.#cacheRoot,
      instanceId: instance.instanceId, simulatorUdid: instance.simulatorUdid });
    await perform(client, active.driverSessionId);
    const current = this.#manager.get(instance.instanceId);
    if (!this.isReady(instance) || !current || current.leaseId !== active.leaseId ||
        current.driverSessionId !== active.driverSessionId || current.controlPort !== active.controlPort) {
      throw new SimulatorDriverError("INPUT_OUTCOME_UNKNOWN",
        "Simulator input completed while its driver route changed; observe before retrying.");
    }
  }

  async #execute(action: "start" | "stop", scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    authority: SimulatorLifecycleEffectAuthority, signal?: AbortSignal): Promise<SimulatorDriverExecution> {
    if (!DIGEST.test(authority.effectIdentity) || !BODY_HASH.test(authority.requestBodyHash) ||
        !Number.isSafeInteger(authority.providerGeneration) || authority.providerGeneration < 1) {
      throw new SimulatorDriverError("INVALID_ARGUMENT", "Simulator driver effect authority is unavailable.");
    }
    if (signal?.aborted) throw new SimulatorDriverError("MUTATION_CANCELLED", "Simulator driver operation was cancelled.");
    this.#ownership.reconcileRecoveredEffects(scope);
    this.#ownership.assertScope(scope);
    const operationId = `ios-simulator-driver:${authority.effectIdentity}`;
    let owned: PublicSimulatorInstance | undefined;
    const claim = this.#store.claimDeferredEffectOperation<DriverValue>({ id: operationId, kind: KIND,
      body: { action, sessionId: scope.sessionId, targetId: scope.targetId,
        bindingGeneration: scope.generation, instanceId: route.instanceId,
        instanceGeneration: route.generation, leaseId: route.leaseId,
        requestBodyHash: authority.requestBodyHash, providerGeneration: authority.providerGeneration }
    }, () => {
      owned = this.#ownership.requireRoute(scope, route);
      let offset = 0;
      for (;;) {
        const page = this.#store.listOperations({ sessionId: scope.sessionId, status: "started", limit: 500, offset });
        const conflicting = page.find(operation =>
          (operation.kind === KIND || operation.kind === "ios_simulator_lifecycle" ||
            operation.kind === "ios_simulator_input" ||
            operation.kind === "ios_simulator_state_control" ||
            operation.kind === "ios_simulator_app_build" ||
            operation.kind === "ios_simulator_app_install" ||
            operation.kind === "ios_simulator_app_control" ||
            operation.kind === "ios_simulator_url_control" ||
            operation.kind === "ios_simulator_screenshot" ||
            operation.kind === "ios_simulator_visual_capture") && operation.id !== operationId);
        if (conflicting) throw new OperationInProgressError(conflicting.id);
        if (page.length < 500) break;
        offset += page.length;
      }
    });
    if (!claim.claimed) {
      const current = this.#ownership.listForTask(scope).find(item => item.instanceId === claim.value.instance.instanceId);
      if (!current || current.generation !== claim.value.instance.generation) {
        throw new SimulatorDriverError("STALE_DRIVER", "Simulator driver route changed after this operation.");
      }
      if (action === "start") {
        const active = this.#manager.get(current.instanceId);
        if (!active || active.state !== "ready" ||
            !this.#state.isCurrentReady(current.instanceId, current.generation, active.leaseId)) {
          throw new SimulatorDriverError("DRIVER_RUNTIME_LOST", "Simulator driver runtime is no longer active.");
        }
      }
      return { ...claim.value, replayed: true };
    }
    if (!owned) throw new Error("Simulator driver admission did not resolve its instance.");
    let dispatched = false;
    let created: WdaRunningDriver | undefined;
    try {
      const value = action === "start"
        ? await this.#start(scope, route, owned, signal, () => { dispatched = true; }, driver => { created = driver; })
        : await this.#stop(scope, route, owned, signal, () => { dispatched = true; });
      const committed = this.#store.completeDeferredEffectOperation<DriverValue>(operationId,
        claim.operation.bodyHash, () => {
          const instance = this.#ownership.completeDriver(scope, route);
          if (value.state === "ready") this.#state.ready(instance, value.managerLeaseId!);
          else this.#state.clear(instance.instanceId);
          return { instance, state: value.state };
        });
      return { ...committed.value, replayed: committed.replayed };
    } catch (error) {
      let cleanupFailed = false;
      if (created) {
        try { await this.#manager.stop(created.instanceId, created.leaseId); }
        catch { cleanupFailed = true; }
      }
      const safe = cleanupFailed
        ? new SimulatorDriverError("CLEANUP_REQUIRED", "Simulator driver cleanup needs recovery.")
        : signal?.aborted && !dispatched
          ? new SimulatorDriverError("MUTATION_CANCELLED", "Simulator driver operation was cancelled.")
        : error instanceof SimulatorDriverError ? error
          : error instanceof SimulatorOwnershipError && !dispatched
            ? new SimulatorDriverError("STALE_DRIVER", "Simulator driver route changed.")
            : new SimulatorDriverError(action === "start" ? "DRIVER_START_UNKNOWN" : "DRIVER_STOP_UNKNOWN",
              "Simulator driver outcome is unknown; refresh instance state before retrying.");
      try {
        this.#store.transaction(() => {
          this.#store.failEffectOperation(operationId, claim.operation.bodyHash, safe);
          if (dispatched || cleanupFailed) {
            try {
              const failed = this.#ownership.failDriver(scope, route, safe.code);
              this.#state.error(failed, safe.code);
            } catch { /* Another generation may own this route. */ }
          }
        });
      } catch { /* Store startup recovery will tombstone an unfinished effect. */ }
      throw safe;
    }
  }

  async #start(scope: SimulatorTaskScope, route: SimulatorInstanceRoute, owned: PublicSimulatorInstance,
    signal: AbortSignal | undefined, markDispatched: () => void,
    onCreated: (driver: WdaRunningDriver) => void): Promise<{ state: "ready"; managerLeaseId: string }> {
    const environment = await this.#environment.inspect(signal);
    if (signal?.aborted) throw new SimulatorDriverError("MUTATION_CANCELLED", "Simulator driver operation was cancelled.");
    const xcodeBuild = buildVersion(environment.xcodeVersion);
    if (!environment.ready || environment.platform !== "darwin" || !xcodeBuild) {
      throw new SimulatorDriverError("DRIVER_UNAVAILABLE", "Simulator driver environment is unavailable.");
    }
    const observed = await this.#lifecycle.findExact(owned.simulatorUdid, signal);
    if (signal?.aborted) throw new SimulatorDriverError("MUTATION_CANCELLED", "Simulator driver operation was cancelled.");
    if (!observed || observed.udid.toUpperCase() !== owned.simulatorUdid ||
        observed.runtimeIdentifier !== owned.runtimeIdentifier || observed.state.toLowerCase() !== "booted") {
      throw new SimulatorDriverError("DEVICE_NOT_BOOTED", "Owned Simulator device is not booted.");
    }
    this.#ownership.requireRoute(scope, route);
    const active = this.#manager.get(owned.instanceId);
    const prior = this.#state.get(owned.instanceId);
    if (prior?.state === "ready" && (!active || active.state !== "exited" ||
        !this.#state.isCurrentReady(owned.instanceId, prior.instanceGeneration, active.leaseId))) {
      throw new SimulatorDriverError("DRIVER_BUSY", "Simulator driver is already running.");
    }
    if (signal?.aborted) throw new SimulatorDriverError("MUTATION_CANCELLED", "Simulator driver operation was cancelled.");
    markDispatched();
    if (active) await this.#manager.stop(active.instanceId, active.leaseId);
    await this.#manager.retryOwnedCleanup(owned.instanceId);
    await this.#cleanup({ cacheRoot: this.#cacheRoot, instanceId: owned.instanceId,
      simulatorUdid: owned.simulatorUdid, signal });
    this.#ownership.requireRoute(scope, route);
    const options: WdaDriverStartOptions = { instanceId: owned.instanceId,
      simulatorUdid: owned.simulatorUdid, runtimeIdentifier: owned.runtimeIdentifier,
      xcodeBuild, architecture: this.#architecture, signal };
    const driver = await this.#manager.start(options);
    onCreated(driver);
    if (signal?.aborted || this.#manager.get(owned.instanceId)?.leaseId !== driver.leaseId) {
      throw new SimulatorDriverError("DRIVER_START_UNKNOWN", "Simulator driver readiness changed before commit.");
    }
    return { state: "ready", managerLeaseId: driver.leaseId };
  }

  async #stop(scope: SimulatorTaskScope, route: SimulatorInstanceRoute, owned: PublicSimulatorInstance,
    signal: AbortSignal | undefined, markDispatched: () => void): Promise<{ state: "stopped" }> {
    this.#ownership.requireRoute(scope, route);
    const prior = this.#state.get(owned.instanceId);
    const active = this.#manager.get(owned.instanceId);
    if (prior?.state === "ready" && (!active ||
        !this.#state.isCurrentReady(owned.instanceId, prior.instanceGeneration, active.leaseId))) {
      throw new SimulatorDriverError("DRIVER_BUSY", "Another driver runtime still owns this simulator.");
    }
    if (signal?.aborted) throw new SimulatorDriverError("MUTATION_CANCELLED", "Simulator driver operation was cancelled.");
    markDispatched();
    if (active) await this.#manager.stop(owned.instanceId, active.leaseId);
    await this.#manager.retryOwnedCleanup(owned.instanceId);
    await this.#cleanup({ cacheRoot: this.#cacheRoot, instanceId: owned.instanceId,
      simulatorUdid: owned.simulatorUdid, signal });
    return { state: "stopped" };
  }
}
