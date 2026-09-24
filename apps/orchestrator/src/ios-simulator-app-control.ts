import { JokoError } from "@joko/core";
import { createSimulatorLifecycleRuntime, SimulatorLifecycleError,
  type SimulatorLifecycleRuntime } from "@joko/tool-ios-simulator";
import { OperationConflictError, OperationInProgressError, OperationPreviouslyFailedError,
  type OperationalStore } from "@joko/store";
import type { SimulatorLifecycleEffectAuthority } from "./ios-simulator-lifecycle-coordinator.js";
import { SimulatorAppBuildError,
  type SimulatorProjectBuildCoordinator } from "./ios-simulator-project-build.js";
import { SimulatorOwnershipError, type PublicSimulatorInstance,
  type SimulatorInstanceRoute, type SimulatorOwnershipRegistry,
  type SimulatorTaskScope } from "./ios-simulator-ownership.js";
import type { SimulatorScreenObservationCoordinator } from "./ios-simulator-screen-observation.js";

const KIND = "ios_simulator_app_control";
const DIGEST = /^[0-9a-f]{64}$/u;
const BODY_HASH = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const CONFLICTING_KINDS = new Set([KIND, "ios_simulator_instance_control", "ios_simulator_create",
  "ios_simulator_lifecycle", "ios_simulator_driver", "ios_simulator_input",
  "ios_simulator_state_control", "ios_simulator_app_build", "ios_simulator_app_install",
  "ios_simulator_url_control", "ios_simulator_screenshot",
  "ios_simulator_grace_cleanup", "ios_simulator_removed_cleanup"]);

export type SimulatorAppControlAction =
  | { readonly type: "launch_app"; readonly artifactId: string; readonly args: readonly string[] }
  | { readonly type: "terminate_app"; readonly artifactId: string };

export interface SimulatorAppControlReceipt {
  readonly action: SimulatorAppControlAction["type"];
  readonly artifactId: string;
  readonly bundleId: string;
  readonly instanceId: string;
  readonly generation: number;
  readonly backend: "simctl";
  readonly completedAt: string;
}

export class SimulatorAppControlError extends JokoError {
  constructor(readonly code: string, message: string) {
    super({ code, message, phase: "simulator_app_control", retryable: false,
      stateMayHaveChanged: code === "APP_CONTROL_UNKNOWN",
      recovery: code === "APP_CONTROL_UNKNOWN"
        ? "Inspect the exact Simulator before issuing a new app control request."
        : "Correct the request or inspect the current Simulator task." });
    this.name = "SimulatorAppControlError";
  }
}

type ControlRuntime = Pick<SimulatorLifecycleRuntime, "findExact" | "launchApp" | "terminateApp">;

/** Durable exact-bundle launch and termination with no launch arguments in Store records. */
export class SimulatorAppControlCoordinator {
  readonly #store: OperationalStore;
  readonly #ownership: SimulatorOwnershipRegistry;
  readonly #build: Pick<SimulatorProjectBuildCoordinator, "getArtifact">;
  readonly #screen: Pick<SimulatorScreenObservationCoordinator, "invalidateOwnedRoute">;
  readonly #runtime: ControlRuntime;
  readonly #now: () => number;

  constructor(store: OperationalStore, ownership: SimulatorOwnershipRegistry,
    build: Pick<SimulatorProjectBuildCoordinator, "getArtifact">,
    screen: Pick<SimulatorScreenObservationCoordinator, "invalidateOwnedRoute">,
    runtime: ControlRuntime = createSimulatorLifecycleRuntime(),
    options: { readonly now?: () => number } = {}) {
    this.#store = store;
    this.#ownership = ownership;
    this.#build = build;
    this.#screen = screen;
    this.#runtime = runtime;
    this.#now = options.now ?? Date.now;
  }

  async execute(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    action: SimulatorAppControlAction, authority: SimulatorLifecycleEffectAuthority,
    signal?: AbortSignal): Promise<{ readonly receipt: SimulatorAppControlReceipt;
      readonly replayed: boolean }> {
    if (!action || action.type !== "launch_app" && action.type !== "terminate_app" ||
        !UUID.test(action.artifactId) || action.type === "launch_app" &&
          (!Array.isArray(action.args) || action.args.length > 64 ||
            action.args.some(arg => typeof arg !== "string" || arg.length > 4_096 || /\0/u.test(arg))) ||
        !DIGEST.test(authority.effectIdentity) || !BODY_HASH.test(authority.requestBodyHash) ||
        !Number.isSafeInteger(authority.providerGeneration) || authority.providerGeneration < 1) {
      throw new SimulatorAppControlError("INVALID_ARGUMENT", "Simulator app control arguments are invalid.");
    }
    if (signal?.aborted) throw new SimulatorAppControlError("MUTATION_CANCELLED",
      "Simulator app control was cancelled before admission.");
    const operationId = `ios-simulator-app-control:${authority.effectIdentity}`;
    let instance: PublicSimulatorInstance | undefined;
    let claim;
    try {
      claim = this.#store.claimDeferredEffectOperation<SimulatorAppControlReceipt>({ id: operationId,
        kind: KIND, body: { action: action.type, sessionId: scope.sessionId, targetId: scope.targetId,
          bindingGeneration: scope.generation, instanceId: route.instanceId,
          instanceGeneration: route.generation, leaseId: route.leaseId,
          artifactId: action.artifactId, requestBodyHash: authority.requestBodyHash,
          providerGeneration: authority.providerGeneration } }, () => {
        instance = this.#ownership.requireRoute(scope, route);
        if (instance.lifecycleState !== "ready" || instance.viewerState !== "attached") {
          throw new SimulatorAppControlError("SIMULATOR_NOT_READY",
            "Simulator must be booted and attached before app control.");
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
          ? String((stored as Record<string, unknown>)["code"]) : "APP_CONTROL_UNKNOWN";
        throw new SimulatorAppControlError(code,
          "This app control already failed and will not be dispatched again.");
      }
      if (error instanceof OperationConflictError) throw new SimulatorAppControlError(
        "MUTATION_CONFLICT", "Simulator app control identity was used with different arguments.");
      if (error instanceof OperationInProgressError) throw new SimulatorAppControlError(
        "MUTATION_IN_PROGRESS", "Another Simulator effect is in progress.");
      throw error;
    }
    if (!claim.claimed) {
      this.#ownership.requireRoute(scope, route);
      return { receipt: claim.value, replayed: true };
    }
    if (!instance) throw new Error("Simulator app-control admission did not resolve its instance.");
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
      this.#ownership.heartbeatRoute(scope, route);
      const device = await this.#runtime.findExact(instance.simulatorUdid, controller.signal);
      this.#requireBooted(instance, device);
      const artifact = await this.#build.getArtifact(scope, route, action.artifactId);
      if (heartbeatError) throw heartbeatError;
      this.#ownership.heartbeatRoute(scope, route);
      if (controller.signal.aborted) throw new SimulatorAppControlError("MUTATION_CANCELLED",
        "Simulator app control was cancelled before dispatch.");
      if (action.type === "launch_app") {
        if (!this.#runtime.launchApp) throw new SimulatorAppControlError(
          "APP_CONTROL_UNAVAILABLE", "Simulator app launch is unavailable.");
        attempted = true;
        await this.#runtime.launchApp(instance.simulatorUdid, artifact.bundleId,
          action.args, controller.signal);
      } else {
        if (!this.#runtime.terminateApp) throw new SimulatorAppControlError(
          "APP_CONTROL_UNAVAILABLE", "Simulator app termination is unavailable.");
        attempted = true;
        await this.#runtime.terminateApp(instance.simulatorUdid, artifact.bundleId,
          controller.signal);
      }
      if (heartbeatError) throw heartbeatError;
      const latest = this.#ownership.requireRoute(scope, route);
      const observed = await this.#runtime.findExact(latest.simulatorUdid, controller.signal);
      this.#requireBooted(latest, observed);
      if (heartbeatError) throw heartbeatError;
      this.#screen.invalidateOwnedRoute(scope, route);
      const completed = this.#store.completeDeferredEffectOperation<SimulatorAppControlReceipt>(
        operationId, claim.operation.bodyHash, () => ({ action: action.type,
          artifactId: action.artifactId, bundleId: artifact.bundleId,
          instanceId: latest.instanceId, generation: latest.generation,
          backend: "simctl", completedAt: new Date(this.#now()).toISOString() }));
      return { receipt: completed.value, replayed: completed.replayed };
    } catch (error) {
      const safe = this.#failure(error, attempted, controller.signal);
      try { this.#store.failEffectOperation(operationId, claim.operation.bodyHash, safe); }
      catch { /* Store recovery keeps a started effect fenced. */ }
      throw safe;
    } finally {
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  #requireBooted(instance: PublicSimulatorInstance,
    device: Awaited<ReturnType<ControlRuntime["findExact"]>>): void {
    if (!device || !device.isAvailable || device.state !== "Booted" ||
        device.runtimeIdentifier !== instance.runtimeIdentifier ||
        device.deviceTypeIdentifier !== instance.deviceTypeIdentifier) {
      throw new SimulatorAppControlError("SIMULATOR_NOT_READY",
        "The exact Simulator is not available and booted for app control.");
    }
  }

  #failure(error: unknown, attempted: boolean, signal?: AbortSignal): Error {
    if (error instanceof SimulatorLifecycleError &&
        (error.code === "APP_LAUNCH_FAILED" || error.code === "APP_TERMINATE_FAILED")) {
      return new SimulatorAppControlError(error.code, error.message);
    }
    if (!attempted && (error instanceof SimulatorAppControlError ||
        error instanceof SimulatorAppBuildError || error instanceof SimulatorOwnershipError ||
        error instanceof SimulatorLifecycleError)) return error;
    if (!attempted && signal?.aborted) return new SimulatorAppControlError(
      "MUTATION_CANCELLED", "Simulator app control was cancelled before dispatch.");
    return new SimulatorAppControlError("APP_CONTROL_UNKNOWN",
      "Simulator app control outcome is unknown; inspect the exact device before retrying.");
  }
}
