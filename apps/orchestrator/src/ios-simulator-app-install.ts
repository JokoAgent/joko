import { JokoError } from "@joko/core";
import { createSimulatorLifecycleRuntime, SimulatorLifecycleError,
  type SimulatorDevice, type SimulatorLifecycleRuntime } from "@joko/tool-ios-simulator";
import { OperationConflictError, OperationInProgressError, OperationPreviouslyFailedError,
  type OperationalStore } from "@joko/store";
import type { SimulatorLifecycleEffectAuthority } from "./ios-simulator-lifecycle-coordinator.js";
import { SimulatorAppBuildError,
  type SimulatorProjectBuildCoordinator } from "./ios-simulator-project-build.js";
import { SimulatorOwnershipError, type PublicSimulatorInstance,
  type SimulatorInstanceRoute, type SimulatorOwnershipRegistry,
  type SimulatorTaskScope } from "./ios-simulator-ownership.js";

const KIND = "ios_simulator_app_install";
const DIGEST = /^[0-9a-f]{64}$/u;
const BODY_HASH = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const CONFLICTING_KINDS = new Set([KIND, "ios_simulator_instance_control", "ios_simulator_create",
  "ios_simulator_lifecycle", "ios_simulator_driver", "ios_simulator_input",
  "ios_simulator_state_control", "ios_simulator_app_build", "ios_simulator_grace_cleanup",
  "ios_simulator_removed_cleanup"]);

export interface SimulatorAppInstallReceipt {
  readonly artifactId: string;
  readonly bundleId: string;
  readonly instanceId: string;
  readonly generation: number;
  readonly backend: "simctl";
  readonly installedAt: string;
}

export class SimulatorAppInstallError extends JokoError {
  constructor(readonly code: string, message: string) {
    super({ code, message, phase: "simulator_app_install", retryable: false,
      stateMayHaveChanged: code === "APP_INSTALL_UNKNOWN",
      recovery: code === "APP_INSTALL_UNKNOWN"
        ? "Inspect the exact Simulator before issuing a new install request."
        : "Correct the request or inspect the current Simulator task." });
    this.name = "SimulatorAppInstallError";
  }
}

type InstallRuntime = Pick<SimulatorLifecycleRuntime, "findExact" | "installApp">;

/** Durable admission for installing one task-owned, already verified app artifact. */
export class SimulatorAppInstallCoordinator {
  readonly #store: OperationalStore;
  readonly #ownership: SimulatorOwnershipRegistry;
  readonly #build: Pick<SimulatorProjectBuildCoordinator, "getArtifact">;
  readonly #runtime: InstallRuntime;
  readonly #now: () => number;

  constructor(store: OperationalStore, ownership: SimulatorOwnershipRegistry,
    build: Pick<SimulatorProjectBuildCoordinator, "getArtifact">,
    runtime: InstallRuntime = createSimulatorLifecycleRuntime(),
    options: { readonly now?: () => number } = {}) {
    this.#store = store;
    this.#ownership = ownership;
    this.#build = build;
    this.#runtime = runtime;
    this.#now = options.now ?? Date.now;
  }

  async execute(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    artifactId: string, authority: SimulatorLifecycleEffectAuthority,
    signal?: AbortSignal): Promise<{ readonly receipt: SimulatorAppInstallReceipt;
      readonly replayed: boolean }> {
    if (!UUID.test(artifactId) || !DIGEST.test(authority.effectIdentity) ||
        !BODY_HASH.test(authority.requestBodyHash) ||
        !Number.isSafeInteger(authority.providerGeneration) || authority.providerGeneration < 1) {
      throw new SimulatorAppInstallError("INVALID_ARGUMENT", "Simulator app install arguments are invalid.");
    }
    if (signal?.aborted) throw new SimulatorAppInstallError("MUTATION_CANCELLED",
      "Simulator app install was cancelled before admission.");
    const operationId = `ios-simulator-install:${authority.effectIdentity}`;
    let instance: PublicSimulatorInstance | undefined;
    let claim;
    try {
      claim = this.#store.claimDeferredEffectOperation<SimulatorAppInstallReceipt>({ id: operationId,
        kind: KIND, body: { action: "install_app", sessionId: scope.sessionId, targetId: scope.targetId,
          bindingGeneration: scope.generation, instanceId: route.instanceId,
          instanceGeneration: route.generation, leaseId: route.leaseId, artifactId,
          requestBodyHash: authority.requestBodyHash,
          providerGeneration: authority.providerGeneration } }, () => {
        instance = this.#ownership.requireRoute(scope, route);
        if (instance.lifecycleState !== "ready" || instance.viewerState !== "attached") {
          throw new SimulatorAppInstallError("SIMULATOR_NOT_READY",
            "Simulator must be booted and attached before installing an app.");
        }
        let offset = 0;
        for (;;) {
          const page = this.#store.listOperations({ sessionId: scope.sessionId,
            status: "started", limit: 500, offset });
          const conflict = page.find(operation => operation.id !== operationId &&
            CONFLICTING_KINDS.has(operation.kind));
          if (conflict) throw new OperationInProgressError(conflict.id);
          if (page.length < 500) break;
          offset += page.length;
        }
      });
    } catch (error) {
      if (error instanceof OperationPreviouslyFailedError) {
        const stored = error.storedError;
        const code = stored && typeof stored === "object" && !Array.isArray(stored) &&
          typeof (stored as Record<string, unknown>)["code"] === "string"
          ? String((stored as Record<string, unknown>)["code"]) : "APP_INSTALL_UNKNOWN";
        throw new SimulatorAppInstallError(code,
          "This app install already failed and will not be dispatched again.");
      }
      if (error instanceof OperationConflictError) throw new SimulatorAppInstallError(
        "MUTATION_CONFLICT", "Simulator app install identity was used with different arguments.");
      if (error instanceof OperationInProgressError) throw new SimulatorAppInstallError(
        "MUTATION_IN_PROGRESS", "Another Simulator effect is in progress.");
      throw error;
    }
    if (!claim.claimed) {
      this.#ownership.requireRoute(scope, route);
      return { receipt: claim.value, replayed: true };
    }
    if (!instance) throw new Error("Simulator install admission did not resolve its instance.");
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    let heartbeatError: unknown;
    const heartbeat = setInterval(() => {
      if (controller.signal.aborted) return;
      try { this.#ownership.heartbeatRoute(scope, route); }
      catch (error) { heartbeatError = error; controller.abort(); }
    }, 20_000);
    let attempted = false;
    try {
      if (!this.#runtime.installApp) throw new SimulatorAppInstallError(
        "APP_INSTALL_UNAVAILABLE", "Simulator app installation is unavailable.");
      this.#ownership.heartbeatRoute(scope, route);
      await this.#requireBooted(instance, controller.signal);
      const artifact = await this.#build.getArtifact(scope, route, artifactId);
      if (heartbeatError) throw heartbeatError;
      this.#ownership.heartbeatRoute(scope, route);
      if (controller.signal.aborted) throw new SimulatorAppInstallError("MUTATION_CANCELLED",
        "Simulator app install was cancelled before dispatch.");
      attempted = true;
      await this.#runtime.installApp(instance.simulatorUdid, artifact.appPath, controller.signal);
      if (heartbeatError) throw heartbeatError;
      const latest = this.#ownership.requireRoute(scope, route);
      await this.#requireBooted(latest, controller.signal);
      if (heartbeatError) throw heartbeatError;
      const completed = this.#store.completeDeferredEffectOperation<SimulatorAppInstallReceipt>(
        operationId, claim.operation.bodyHash, () => ({ artifactId,
          bundleId: artifact.bundleId, instanceId: latest.instanceId,
          generation: latest.generation, backend: "simctl",
          installedAt: new Date(this.#now()).toISOString() }));
      return { receipt: completed.value, replayed: completed.replayed };
    } catch (error) {
      const safe = this.#failure(error, attempted, controller.signal);
      try { this.#store.failEffectOperation(operationId, claim.operation.bodyHash, safe); }
      catch { /* A started effect remains fenced by Store recovery. */ }
      throw safe;
    } finally {
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async #requireBooted(instance: PublicSimulatorInstance, signal?: AbortSignal): Promise<SimulatorDevice> {
    const device = await this.#runtime.findExact(instance.simulatorUdid, signal);
    if (!device || !device.isAvailable || device.state !== "Booted" ||
        device.runtimeIdentifier !== instance.runtimeIdentifier ||
        device.deviceTypeIdentifier !== instance.deviceTypeIdentifier) {
      throw new SimulatorAppInstallError("SIMULATOR_NOT_READY",
        "The exact Simulator is not available and booted for app installation.");
    }
    return device;
  }

  #failure(error: unknown, attempted: boolean, signal?: AbortSignal): Error {
    if (error instanceof SimulatorLifecycleError && error.code === "APP_INSTALL_FAILED") {
      return new SimulatorAppInstallError("APP_INSTALL_FAILED", error.message);
    }
    if (!attempted && (error instanceof SimulatorAppInstallError ||
        error instanceof SimulatorAppBuildError || error instanceof SimulatorOwnershipError ||
        error instanceof SimulatorLifecycleError)) return error;
    if (!attempted && signal?.aborted) return new SimulatorAppInstallError(
      "MUTATION_CANCELLED", "Simulator app install was cancelled before dispatch.");
    return new SimulatorAppInstallError("APP_INSTALL_UNKNOWN",
      "Simulator app install outcome is unknown; inspect the exact device before retrying.");
  }
}
