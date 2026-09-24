import { JokoError } from "@joko/core";
import { createSimulatorLifecycleRuntime, SimulatorLifecycleError,
  type SimulatorLifecycleRuntime } from "@joko/tool-ios-simulator";
import { OperationConflictError, OperationInProgressError, OperationPreviouslyFailedError,
  type OperationalStore } from "@joko/store";
import type { SimulatorLifecycleEffectAuthority } from "./ios-simulator-lifecycle-coordinator.js";
import { SimulatorOwnershipError, type PublicSimulatorInstance,
  type SimulatorInstanceRoute, type SimulatorOwnershipRegistry,
  type SimulatorTaskScope } from "./ios-simulator-ownership.js";
import type { SimulatorScreenObservationCoordinator } from "./ios-simulator-screen-observation.js";

const KIND = "ios_simulator_url_control";
const DIGEST = /^[0-9a-f]{64}$/u;
const BODY_HASH = /^sha256:[0-9a-f]{64}$/u;
const CONFLICTING_KINDS = new Set([KIND, "ios_simulator_instance_control", "ios_simulator_create",
  "ios_simulator_lifecycle", "ios_simulator_driver", "ios_simulator_input",
  "ios_simulator_state_control", "ios_simulator_app_build", "ios_simulator_app_install",
  "ios_simulator_app_control", "ios_simulator_screenshot", "ios_simulator_grace_cleanup", "ios_simulator_removed_cleanup"]);

export interface SimulatorUrlReceipt {
  readonly opened: true;
  readonly instanceId: string;
  readonly generation: number;
  readonly backend: "simctl";
  readonly completedAt: string;
}

export class SimulatorUrlControlError extends JokoError {
  constructor(readonly code: string, message: string) {
    super({ code, message, phase: "simulator_url_control", retryable: false,
      stateMayHaveChanged: code === "OPEN_URL_UNKNOWN",
      recovery: code === "OPEN_URL_UNKNOWN"
        ? "Inspect the exact Simulator before issuing a new URL request."
        : "Correct the URL or inspect the current Simulator task." });
    this.name = "SimulatorUrlControlError";
  }
}

type UrlRuntime = Pick<SimulatorLifecycleRuntime, "findExact" | "openSimulatorUrl">;

/** Durable delivery to simctl openurl; the URL never enters an Operation body. */
export class SimulatorUrlControlCoordinator {
  readonly #store: OperationalStore;
  readonly #ownership: SimulatorOwnershipRegistry;
  readonly #screen: Pick<SimulatorScreenObservationCoordinator, "invalidateOwnedRoute">;
  readonly #runtime: UrlRuntime;
  readonly #now: () => number;

  constructor(store: OperationalStore, ownership: SimulatorOwnershipRegistry,
    screen: Pick<SimulatorScreenObservationCoordinator, "invalidateOwnedRoute">,
    runtime: UrlRuntime = createSimulatorLifecycleRuntime(),
    options: { readonly now?: () => number } = {}) {
    this.#store = store;
    this.#ownership = ownership;
    this.#screen = screen;
    this.#runtime = runtime;
    this.#now = options.now ?? Date.now;
  }

  async execute(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    rawUrl: string, authority: SimulatorLifecycleEffectAuthority,
    signal?: AbortSignal): Promise<{ readonly receipt: SimulatorUrlReceipt;
      readonly replayed: boolean }> {
    if (typeof rawUrl !== "string" || !rawUrl || rawUrl.length > 8_192 ||
        /[\0\r\n]/u.test(rawUrl) || !DIGEST.test(authority.effectIdentity) ||
        !BODY_HASH.test(authority.requestBodyHash) ||
        !Number.isSafeInteger(authority.providerGeneration) || authority.providerGeneration < 1) {
      throw new SimulatorUrlControlError("INVALID_ARGUMENT", "Simulator URL request is invalid.");
    }
    let url: URL;
    try { url = new URL(rawUrl); }
    catch { throw new SimulatorUrlControlError("INVALID_ARGUMENT", "Simulator URL request is invalid."); }
    if (!url.protocol || url.protocol === "file:" || url.protocol === "javascript:") {
      throw new SimulatorUrlControlError("INVALID_ARGUMENT", "Simulator URL scheme is not allowed.");
    }
    if (signal?.aborted) throw new SimulatorUrlControlError("MUTATION_CANCELLED",
      "Simulator URL request was cancelled before admission.");
    const operationId = `ios-simulator-url:${authority.effectIdentity}`;
    let instance: PublicSimulatorInstance | undefined;
    let claim;
    try {
      claim = this.#store.claimDeferredEffectOperation<SimulatorUrlReceipt>({ id: operationId,
        kind: KIND, body: { action: "open_simulator_url", sessionId: scope.sessionId,
          targetId: scope.targetId, bindingGeneration: scope.generation,
          instanceId: route.instanceId, instanceGeneration: route.generation,
          leaseId: route.leaseId, requestBodyHash: authority.requestBodyHash,
          providerGeneration: authority.providerGeneration } }, () => {
        instance = this.#ownership.requireRoute(scope, route);
        if (instance.lifecycleState !== "ready" || instance.viewerState !== "attached") {
          throw new SimulatorUrlControlError("SIMULATOR_NOT_READY",
            "Simulator must be booted and attached before opening a URL.");
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
          ? String((stored as Record<string, unknown>)["code"]) : "OPEN_URL_UNKNOWN";
        throw new SimulatorUrlControlError(code,
          "This Simulator URL request already failed and will not be dispatched again.");
      }
      if (error instanceof OperationConflictError) throw new SimulatorUrlControlError(
        "MUTATION_CONFLICT", "Simulator URL identity was used with different arguments.");
      if (error instanceof OperationInProgressError) throw new SimulatorUrlControlError(
        "MUTATION_IN_PROGRESS", "Another Simulator effect is in progress.");
      throw error;
    }
    if (!claim.claimed) {
      this.#ownership.requireRoute(scope, route);
      return { receipt: claim.value, replayed: true };
    }
    if (!instance) throw new Error("Simulator URL admission did not resolve its instance.");
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
      if (!this.#runtime.openSimulatorUrl) throw new SimulatorUrlControlError(
        "OPEN_URL_UNAVAILABLE", "Simulator URL control is unavailable.");
      this.#ownership.heartbeatRoute(scope, route);
      await this.#requireBooted(instance, controller.signal);
      if (heartbeatError) throw heartbeatError;
      this.#ownership.heartbeatRoute(scope, route);
      if (controller.signal.aborted) throw new SimulatorUrlControlError("MUTATION_CANCELLED",
        "Simulator URL request was cancelled before dispatch.");
      attempted = true;
      await this.#runtime.openSimulatorUrl(instance.simulatorUdid, url.toString(), controller.signal);
      if (heartbeatError) throw heartbeatError;
      const latest = this.#ownership.requireRoute(scope, route);
      await this.#requireBooted(latest, controller.signal);
      if (heartbeatError) throw heartbeatError;
      this.#screen.invalidateOwnedRoute(scope, route);
      const completed = this.#store.completeDeferredEffectOperation<SimulatorUrlReceipt>(
        operationId, claim.operation.bodyHash, () => ({ opened: true,
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

  async #requireBooted(instance: PublicSimulatorInstance, signal?: AbortSignal): Promise<void> {
    const device = await this.#runtime.findExact(instance.simulatorUdid, signal);
    if (!device || !device.isAvailable || device.state !== "Booted" ||
        device.runtimeIdentifier !== instance.runtimeIdentifier ||
        device.deviceTypeIdentifier !== instance.deviceTypeIdentifier) {
      throw new SimulatorUrlControlError("SIMULATOR_NOT_READY",
        "The exact Simulator is not available and booted for opening a URL.");
    }
  }

  #failure(error: unknown, attempted: boolean, signal?: AbortSignal): Error {
    if (error instanceof SimulatorLifecycleError && error.code === "OPEN_URL_FAILED") {
      return new SimulatorUrlControlError("OPEN_URL_FAILED", error.message);
    }
    if (!attempted && (error instanceof SimulatorUrlControlError ||
        error instanceof SimulatorOwnershipError || error instanceof SimulatorLifecycleError)) return error;
    if (!attempted && signal?.aborted) return new SimulatorUrlControlError(
      "MUTATION_CANCELLED", "Simulator URL request was cancelled before dispatch.");
    return new SimulatorUrlControlError("OPEN_URL_UNKNOWN",
      "Simulator URL outcome is unknown; inspect the exact device before retrying.");
  }
}
