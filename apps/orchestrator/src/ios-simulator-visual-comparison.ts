import { randomUUID } from "node:crypto";
import { JokoError } from "@joko/core";
import { compareSimulatorRgbaImages, createSimulatorLifecycleRuntime, SimulatorLifecycleError,
  SimulatorVisualDiffError, type SimulatorLifecycleRuntime, type SimulatorPixelDiff } from "@joko/tool-ios-simulator";
import { OperationConflictError, OperationInProgressError, OperationPreviouslyFailedError,
  type OperationalStore } from "@joko/store";
import sharp from "sharp";
import type { SimulatorLifecycleEffectAuthority } from "./ios-simulator-lifecycle-coordinator.js";
import { SimulatorOwnershipError, type PublicSimulatorInstance,
  type SimulatorInstanceRoute, type SimulatorOwnershipRegistry,
  type SimulatorTaskScope } from "./ios-simulator-ownership.js";

const KIND = "ios_simulator_visual_capture";
const DIGEST = /^[0-9a-f]{64}$/u;
const BODY_HASH = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_DIMENSION = 8_192;
const MAX_BASELINES = 4;
const CONFLICTING_KINDS = new Set([KIND, "ios_simulator_instance_control", "ios_simulator_create",
  "ios_simulator_lifecycle", "ios_simulator_driver", "ios_simulator_input",
  "ios_simulator_state_control", "ios_simulator_app_build", "ios_simulator_app_install",
  "ios_simulator_app_control", "ios_simulator_url_control", "ios_simulator_screenshot",
  "ios_simulator_grace_cleanup", "ios_simulator_removed_cleanup"]);

export interface SimulatorVisualBaselineReceipt {
  readonly baselineId: string;
  readonly instanceId: string;
  readonly generation: number;
  readonly byteLength: number;
  readonly capturedAt: string;
}

export interface SimulatorVisualDiffReceipt {
  readonly baselineId: string;
  readonly diff: SimulatorPixelDiff;
}

export class SimulatorVisualComparisonError extends JokoError {
  constructor(readonly code: string, message: string) {
    super({ code, message, phase: "simulator_visual_comparison", retryable: false,
      stateMayHaveChanged: code === "VISUAL_CAPTURE_UNKNOWN",
      recovery: code === "VISUAL_CAPTURE_UNKNOWN"
        ? "Inspect the exact Simulator before requesting another visual capture."
        : "Inspect the baseline and exact Simulator task before another request." });
    this.name = "SimulatorVisualComparisonError";
  }
}

interface Baseline {
  readonly baselineId: string;
  readonly sessionId: string;
  readonly targetId: string;
  readonly bindingGeneration: number;
  readonly instanceId: string;
  readonly generation: number;
  readonly leaseId: string;
  readonly simulatorUdid: string;
  readonly runtimeIdentifier: string;
  readonly deviceTypeIdentifier: string;
  readonly bytes: Uint8Array;
}

type VisualRuntime = Pick<SimulatorLifecycleRuntime, "findExact" | "takeScreenshot">;
type ComparePng = (baseline: Uint8Array, current: Uint8Array,
  threshold: number) => Promise<SimulatorPixelDiff>;

function requirePng(bytes: Uint8Array): void {
  if (bytes.byteLength < PNG_SIGNATURE.byteLength || bytes.byteLength > MAX_PNG_BYTES ||
      !Buffer.from(bytes.subarray(0, PNG_SIGNATURE.byteLength)).equals(PNG_SIGNATURE)) {
    throw new SimulatorVisualComparisonError("SCREENSHOT_INVALID", "Simulator screenshot output was invalid.");
  }
}

async function decodePng(bytes: Uint8Array): Promise<{
  readonly width: number; readonly height: number; readonly data: Uint8Array }> {
  requirePng(bytes);
  try {
    const decoder = sharp(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      failOn: "error", limitInputPixels: MAX_DIMENSION * MAX_DIMENSION,
      sequentialRead: true
    });
    const metadata = await decoder.metadata();
    if (metadata.format !== "png" || !metadata.width || !metadata.height ||
        metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION) {
      throw new SimulatorVisualComparisonError("IMAGE_DECODE_FAILED",
        "Simulator screenshot dimensions or format are invalid.");
    }
    const raw = await decoder.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (raw.info.width !== metadata.width || raw.info.height !== metadata.height ||
        raw.info.channels !== 4 || raw.data.byteLength !== metadata.width * metadata.height * 4) {
      throw new SimulatorVisualComparisonError("IMAGE_DECODE_FAILED",
        "Simulator screenshot pixels are invalid.");
    }
    return { width: metadata.width, height: metadata.height, data: raw.data };
  } catch {
    throw new SimulatorVisualComparisonError("IMAGE_DECODE_FAILED",
      "Simulator screenshot could not be decoded for visual comparison.");
  }
}

export async function compareSimulatorPngBytes(baseline: Uint8Array, current: Uint8Array,
  threshold: number): Promise<SimulatorPixelDiff> {
  const before = await decodePng(baseline);
  const after = await decodePng(current);
  try { return compareSimulatorRgbaImages(before, after, threshold); }
  catch (error) {
    if (error instanceof SimulatorVisualDiffError) throw new SimulatorVisualComparisonError(
      "INVALID_ARGUMENT", error.message);
    throw error;
  }
}

/** Ephemeral baseline ownership and durable capture/diff effect fencing. */
export class SimulatorVisualComparisonCoordinator {
  readonly #store: OperationalStore;
  readonly #ownership: SimulatorOwnershipRegistry;
  readonly #runtime: VisualRuntime;
  readonly #compare: ComparePng;
  readonly #now: () => number;
  readonly #baselines = new Map<string, Baseline>();

  constructor(store: OperationalStore, ownership: SimulatorOwnershipRegistry,
    runtime: VisualRuntime = createSimulatorLifecycleRuntime(),
    options: { readonly now?: () => number; readonly compare?: ComparePng } = {}) {
    this.#store = store;
    this.#ownership = ownership;
    this.#runtime = runtime;
    this.#compare = options.compare ?? compareSimulatorPngBytes;
    this.#now = options.now ?? Date.now;
  }

  clear(instanceId: string): void {
    for (const [id, baseline] of this.#baselines) {
      if (baseline.instanceId === instanceId) this.#baselines.delete(id);
    }
  }

  async captureBaseline(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    authority: SimulatorLifecycleEffectAuthority, signal?: AbortSignal): Promise<{
      readonly receipt: SimulatorVisualBaselineReceipt; readonly replayed: boolean }> {
    const baselineId = randomUUID();
    return this.#execute(scope, route, authority, "capture_visual_baseline", {},
      () => undefined,
      async (instance, captureSignal) => {
        const bytes = await this.#capture(instance, captureSignal);
        const baseline: Baseline = { baselineId, sessionId: scope.sessionId,
          targetId: scope.targetId, bindingGeneration: scope.generation,
          instanceId: route.instanceId, generation: route.generation, leaseId: route.leaseId,
          simulatorUdid: instance.simulatorUdid, runtimeIdentifier: instance.runtimeIdentifier,
          deviceTypeIdentifier: instance.deviceTypeIdentifier, bytes };
        this.#baselines.set(baselineId, baseline);
        return { baselineId, instanceId: route.instanceId, generation: route.generation,
          byteLength: bytes.byteLength, capturedAt: new Date(this.#now()).toISOString() };
      },
      receipt => { this.#requireBaseline(scope, route, receipt.baselineId); },
      () => { this.#baselines.delete(baselineId); },
      () => {
        while (this.#baselines.size > MAX_BASELINES) {
          const oldest = this.#baselines.keys().next().value;
          if (oldest === undefined) break;
          this.#baselines.delete(oldest);
        }
      }, signal);
  }

  async visualDiff(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    baselineId: string, threshold: number,
    authority: SimulatorLifecycleEffectAuthority, signal?: AbortSignal): Promise<{
      readonly receipt: SimulatorVisualDiffReceipt; readonly replayed: boolean }> {
    if (!UUID.test(baselineId) || !Number.isSafeInteger(threshold) || threshold < 0 || threshold > 255) {
      throw new SimulatorVisualComparisonError("INVALID_ARGUMENT", "Simulator visual diff request is invalid.");
    }
    let baseline: Baseline | undefined;
    const requireCurrent = (): void => {
      baseline = this.#requireBaseline(scope, route, baselineId);
    };
    return this.#execute(scope, route, authority, "visual_diff", { baselineId, threshold },
      requireCurrent,
      async (instance, captureSignal) => {
        if (!baseline) throw new Error("Visual baseline admission did not resolve a baseline.");
        const bytes = await this.#capture(instance, captureSignal);
        return { baselineId, diff: await this.#compare(baseline.bytes, bytes, threshold) };
      },
      () => { requireCurrent(); }, () => undefined, () => undefined, signal);
  }

  #requireBaseline(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    baselineId: string): Baseline {
    const baseline = this.#baselines.get(baselineId);
    const instance = this.#ownership.requireRoute(scope, route);
    if (!baseline || baseline.sessionId !== scope.sessionId || baseline.targetId !== scope.targetId ||
        baseline.bindingGeneration !== scope.generation || baseline.instanceId !== route.instanceId ||
        baseline.generation !== route.generation || baseline.leaseId !== route.leaseId ||
        baseline.simulatorUdid !== instance.simulatorUdid ||
        baseline.runtimeIdentifier !== instance.runtimeIdentifier ||
        baseline.deviceTypeIdentifier !== instance.deviceTypeIdentifier ||
        instance.lifecycleState !== "ready" || instance.viewerState !== "attached") {
      throw new SimulatorVisualComparisonError("BASELINE_UNAVAILABLE",
        "The visual baseline is unavailable for this Simulator task and generation.");
    }
    return baseline;
  }

  async #capture(instance: PublicSimulatorInstance, signal?: AbortSignal): Promise<Uint8Array> {
    if (!this.#runtime.takeScreenshot) throw new SimulatorVisualComparisonError(
      "SCREENSHOT_UNAVAILABLE", "Simulator screenshot capture is unavailable.");
    const bytes = await this.#runtime.takeScreenshot(instance.simulatorUdid, signal);
    requirePng(bytes);
    return bytes;
  }

  async #execute<T>(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    authority: SimulatorLifecycleEffectAuthority,
    action: "capture_visual_baseline" | "visual_diff",
    body: Readonly<Record<string, unknown>>,
    preflight: () => void,
    perform: (instance: PublicSimulatorInstance, signal: AbortSignal) => Promise<T>,
    replay: (receipt: T) => void,
    failureCleanup: () => void,
    completed: () => void,
    signal?: AbortSignal): Promise<{ readonly receipt: T; readonly replayed: boolean }> {
    if (!DIGEST.test(authority.effectIdentity) || !BODY_HASH.test(authority.requestBodyHash) ||
        !Number.isSafeInteger(authority.providerGeneration) || authority.providerGeneration < 1) {
      throw new SimulatorVisualComparisonError("INVALID_ARGUMENT", "Simulator visual authority is invalid.");
    }
    if (signal?.aborted) throw new SimulatorVisualComparisonError("MUTATION_CANCELLED",
      "Simulator visual capture was cancelled before admission.");
    const operationId = `ios-simulator-visual:${authority.effectIdentity}`;
    let instance: PublicSimulatorInstance | undefined;
    let claim;
    try {
      claim = this.#store.claimDeferredEffectOperation<T>({ id: operationId, kind: KIND,
        body: { action, sessionId: scope.sessionId, targetId: scope.targetId,
          bindingGeneration: scope.generation, instanceId: route.instanceId,
          instanceGeneration: route.generation, leaseId: route.leaseId,
          requestBodyHash: authority.requestBodyHash,
          providerGeneration: authority.providerGeneration, ...body } }, () => {
        instance = this.#ownership.requireRoute(scope, route);
        if (instance.lifecycleState !== "ready" || instance.viewerState !== "attached") {
          throw new SimulatorVisualComparisonError("SIMULATOR_NOT_READY",
            "Simulator must be booted and attached before visual capture.");
        }
        preflight();
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
          ? String((stored as Record<string, unknown>)["code"]) : "VISUAL_CAPTURE_UNKNOWN";
        throw new SimulatorVisualComparisonError(code,
          "This Simulator visual request already failed and will not be dispatched again.");
      }
      if (error instanceof OperationConflictError) throw new SimulatorVisualComparisonError(
        "MUTATION_CONFLICT", "Simulator visual identity was used with different arguments.");
      if (error instanceof OperationInProgressError) throw new SimulatorVisualComparisonError(
        "MUTATION_IN_PROGRESS", "Another Simulator effect is in progress.");
      throw error;
    }
    if (!claim.claimed) {
      this.#ownership.requireRoute(scope, route);
      replay(claim.value);
      return { receipt: claim.value, replayed: true };
    }
    if (!instance) throw new Error("Simulator visual admission did not resolve its instance.");
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
      await this.#requireBooted(instance, controller.signal);
      if (heartbeatError) throw heartbeatError;
      this.#ownership.heartbeatRoute(scope, route);
      if (controller.signal.aborted) throw new SimulatorVisualComparisonError("MUTATION_CANCELLED",
        "Simulator visual capture was cancelled before dispatch.");
      attempted = true;
      const receipt = await perform(instance, controller.signal);
      if (heartbeatError) throw heartbeatError;
      if (controller.signal.aborted) throw new SimulatorVisualComparisonError("VISUAL_CAPTURE_UNKNOWN",
        "Simulator visual capture was cancelled after dispatch.");
      const latest = this.#ownership.requireRoute(scope, route);
      await this.#requireBooted(latest, controller.signal);
      preflight();
      if (heartbeatError) throw heartbeatError;
      if (controller.signal.aborted) throw new SimulatorVisualComparisonError("VISUAL_CAPTURE_UNKNOWN",
        "Simulator visual capture was cancelled after dispatch.");
      const final = this.#store.completeDeferredEffectOperation<T>(
        operationId, claim.operation.bodyHash, () => {
          this.#ownership.requireRoute(scope, route);
          preflight();
          return receipt;
        });
      completed();
      return { receipt: final.value, replayed: final.replayed };
    } catch (error) {
      failureCleanup();
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
      throw new SimulatorVisualComparisonError("SIMULATOR_NOT_READY",
        "The exact Simulator is not available and booted for visual capture.");
    }
  }

  #failure(error: unknown, attempted: boolean, signal?: AbortSignal): Error {
    if (error instanceof SimulatorLifecycleError &&
        (error.code === "SCREENSHOT_FAILED" || error.code === "SCREENSHOT_INVALID")) {
      return new SimulatorVisualComparisonError(error.code, error.message);
    }
    if (error instanceof SimulatorVisualComparisonError &&
        ["SCREENSHOT_INVALID", "SCREENSHOT_UNAVAILABLE", "IMAGE_DECODE_FAILED",
          "INVALID_ARGUMENT"].includes(error.code)) return error;
    if (!attempted && (error instanceof SimulatorVisualComparisonError ||
        error instanceof SimulatorOwnershipError || error instanceof SimulatorLifecycleError)) return error;
    if (!attempted && signal?.aborted) return new SimulatorVisualComparisonError(
      "MUTATION_CANCELLED", "Simulator visual capture was cancelled before dispatch.");
    return new SimulatorVisualComparisonError("VISUAL_CAPTURE_UNKNOWN",
      "Simulator visual capture outcome is unknown; inspect the exact device before retrying.");
  }
}
