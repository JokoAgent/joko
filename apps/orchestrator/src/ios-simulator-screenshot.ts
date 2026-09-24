import { JokoError, type BlobRef } from "@joko/core";
import { createSimulatorLifecycleRuntime, SimulatorLifecycleError,
  type SimulatorLifecycleRuntime } from "@joko/tool-ios-simulator";
import { OperationConflictError, OperationInProgressError, OperationPreviouslyFailedError,
  type OperationalStore } from "@joko/store";
import type { ArtifactStore } from "./artifact-store.js";
import type { SimulatorLifecycleEffectAuthority } from "./ios-simulator-lifecycle-coordinator.js";
import { SimulatorOwnershipError, type PublicSimulatorInstance,
  type SimulatorInstanceRoute, type SimulatorOwnershipRegistry,
  type SimulatorTaskScope } from "./ios-simulator-ownership.js";

const KIND = "ios_simulator_screenshot";
const DIGEST = /^[0-9a-f]{64}$/u;
const BODY_HASH = /^sha256:[0-9a-f]{64}$/u;
const CONFLICTING_KINDS = new Set([KIND, "ios_simulator_instance_control", "ios_simulator_create",
  "ios_simulator_lifecycle", "ios_simulator_driver", "ios_simulator_input",
  "ios_simulator_state_control", "ios_simulator_app_build", "ios_simulator_app_install",
  "ios_simulator_app_control", "ios_simulator_url_control", "ios_simulator_visual_capture",
  "ios_simulator_grace_cleanup",
  "ios_simulator_removed_cleanup"]);

export interface SimulatorScreenshotReceipt {
  readonly instanceId: string;
  readonly generation: number;
  readonly backend: "simctl";
  readonly capturedAt: string;
  readonly image: BlobRef;
}

export class SimulatorScreenshotError extends JokoError {
  constructor(readonly code: string, message: string) {
    super({ code, message, phase: "simulator_screenshot", retryable: false,
      stateMayHaveChanged: code === "SCREENSHOT_UNKNOWN",
      recovery: code === "SCREENSHOT_UNKNOWN"
        ? "Inspect the exact Simulator and task artifact before requesting another capture."
        : "Inspect the current Simulator task and try a new request if needed." });
    this.name = "SimulatorScreenshotError";
  }
}

type ScreenshotRuntime = Pick<SimulatorLifecycleRuntime, "findExact" | "takeScreenshot">;
type ScreenshotArtifacts = Pick<ArtifactStore, "ingestBytes" | "get">;

/** Exact-device capture, task-bound durable receipt and model-readable image artifact. */
export class SimulatorScreenshotCoordinator {
  readonly #store: OperationalStore;
  readonly #ownership: SimulatorOwnershipRegistry;
  readonly #artifacts: ScreenshotArtifacts;
  readonly #runtime: ScreenshotRuntime;
  readonly #now: () => number;

  constructor(store: OperationalStore, ownership: SimulatorOwnershipRegistry,
    artifacts: ScreenshotArtifacts,
    runtime: ScreenshotRuntime = createSimulatorLifecycleRuntime(),
    options: { readonly now?: () => number } = {}) {
    this.#store = store;
    this.#ownership = ownership;
    this.#artifacts = artifacts;
    this.#runtime = runtime;
    this.#now = options.now ?? Date.now;
  }

  async execute(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    authority: SimulatorLifecycleEffectAuthority, signal?: AbortSignal): Promise<{
      readonly receipt: SimulatorScreenshotReceipt; readonly replayed: boolean }> {
    if (!DIGEST.test(authority.effectIdentity) || !BODY_HASH.test(authority.requestBodyHash) ||
        !Number.isSafeInteger(authority.providerGeneration) || authority.providerGeneration < 1) {
      throw new SimulatorScreenshotError("INVALID_ARGUMENT", "Simulator screenshot authority is invalid.");
    }
    if (signal?.aborted) throw new SimulatorScreenshotError("MUTATION_CANCELLED",
      "Simulator screenshot was cancelled before admission.");
    const operationId = `ios-simulator-screenshot:${authority.effectIdentity}`;
    let instance: PublicSimulatorInstance | undefined;
    let claim;
    try {
      claim = this.#store.claimDeferredEffectOperation<SimulatorScreenshotReceipt>({ id: operationId,
        kind: KIND, body: { action: "take_simulator_screenshot", sessionId: scope.sessionId,
          targetId: scope.targetId, bindingGeneration: scope.generation,
          instanceId: route.instanceId, instanceGeneration: route.generation,
          leaseId: route.leaseId, requestBodyHash: authority.requestBodyHash,
          providerGeneration: authority.providerGeneration } }, () => {
        instance = this.#ownership.requireRoute(scope, route);
        if (instance.lifecycleState !== "ready" || instance.viewerState !== "attached") {
          throw new SimulatorScreenshotError("SIMULATOR_NOT_READY",
            "Simulator must be booted and attached before a screenshot.");
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
          ? String((stored as Record<string, unknown>)["code"]) : "SCREENSHOT_UNKNOWN";
        throw new SimulatorScreenshotError(code,
          "This Simulator screenshot request already failed and will not be dispatched again.");
      }
      if (error instanceof OperationConflictError) throw new SimulatorScreenshotError(
        "MUTATION_CONFLICT", "Simulator screenshot identity was used with different arguments.");
      if (error instanceof OperationInProgressError) throw new SimulatorScreenshotError(
        "MUTATION_IN_PROGRESS", "Another Simulator effect is in progress.");
      throw error;
    }
    if (!claim.claimed) {
      this.#ownership.requireRoute(scope, route);
      try {
        const artifact = await this.#artifacts.get(claim.value.image.id);
        if (artifact.sha256 !== claim.value.image.sha256 ||
            artifact.byteLength !== claim.value.image.byteLength ||
            artifact.mimeType !== claim.value.image.mimeType) throw new Error("Artifact identity changed.");
      }
      catch { throw new SimulatorScreenshotError("SCREENSHOT_ARTIFACT_UNAVAILABLE",
        "The earlier Simulator screenshot artifact is unavailable."); }
      return { receipt: claim.value, replayed: true };
    }
    if (!instance) throw new Error("Simulator screenshot admission did not resolve its instance.");
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
      if (!this.#runtime.takeScreenshot) throw new SimulatorScreenshotError(
        "SCREENSHOT_UNAVAILABLE", "Simulator screenshot capture is unavailable.");
      this.#ownership.heartbeatRoute(scope, route);
      await this.#requireBooted(instance, controller.signal);
      if (heartbeatError) throw heartbeatError;
      this.#ownership.heartbeatRoute(scope, route);
      if (controller.signal.aborted) throw new SimulatorScreenshotError("MUTATION_CANCELLED",
        "Simulator screenshot was cancelled before dispatch.");
      attempted = true;
      const bytes = await this.#runtime.takeScreenshot(instance.simulatorUdid, controller.signal);
      if (heartbeatError) throw heartbeatError;
      const latest = this.#ownership.requireRoute(scope, route);
      await this.#requireBooted(latest, controller.signal);
      if (heartbeatError) throw heartbeatError;
      if (bytes.byteLength < 8 || bytes.byteLength > 32 * 1024 * 1024 ||
          !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new SimulatorScreenshotError("SCREENSHOT_INVALID", "Simulator screenshot output was invalid.");
      }
      const artifact = await this.#artifacts.ingestBytes(bytes, {
        fileName: `simulator-${latest.instanceId}.png`, mimeType: "image/png" });
      this.#ownership.requireRoute(scope, route);
      const completed = this.#store.completeDeferredEffectOperation<SimulatorScreenshotReceipt>(
        operationId, claim.operation.bodyHash, () => {
          this.#ownership.requireRoute(scope, route);
          return { instanceId: latest.instanceId, generation: latest.generation,
            backend: "simctl", capturedAt: new Date(this.#now()).toISOString(),
            image: { id: artifact.id, sha256: artifact.sha256, byteLength: artifact.byteLength,
              mimeType: artifact.mimeType, fileName: artifact.fileName } };
        });
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
      throw new SimulatorScreenshotError("SIMULATOR_NOT_READY",
        "The exact Simulator is not available and booted for a screenshot.");
    }
  }

  #failure(error: unknown, attempted: boolean, signal?: AbortSignal): Error {
    if (error instanceof SimulatorScreenshotError && error.code === "SCREENSHOT_INVALID") return error;
    if (error instanceof SimulatorLifecycleError &&
        (error.code === "SCREENSHOT_FAILED" || error.code === "SCREENSHOT_INVALID")) {
      return new SimulatorScreenshotError(error.code, error.message);
    }
    if (!attempted && (error instanceof SimulatorScreenshotError ||
        error instanceof SimulatorOwnershipError || error instanceof SimulatorLifecycleError)) return error;
    if (!attempted && signal?.aborted) return new SimulatorScreenshotError(
      "MUTATION_CANCELLED", "Simulator screenshot was cancelled before dispatch.");
    return new SimulatorScreenshotError("SCREENSHOT_UNKNOWN",
      "Simulator screenshot outcome is unknown; inspect the exact device and task artifact before retrying.");
  }
}
