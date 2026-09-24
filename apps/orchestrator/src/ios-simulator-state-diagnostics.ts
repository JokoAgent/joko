import { randomUUID } from "node:crypto";
import { redactSecrets } from "@joko/core";
import type { WdaDriverHealth } from "@joko/tool-ios-simulator";
import type { SimulatorDriverCoordinator } from "./ios-simulator-driver-coordinator.js";
import { SimulatorDriverError } from "./ios-simulator-driver-coordinator.js";
import type { SimulatorOwnershipRegistry, PublicSimulatorInstance,
  SimulatorInstanceRoute, SimulatorTaskScope } from "./ios-simulator-ownership.js";
import { SimulatorObservationError, type SimulatorScreenObservationCoordinator } from "./ios-simulator-screen-observation.js";

const TTL_MS = 60 * 60_000;
const MAX_ENTRIES = 64;
const MAX_ENTRY_BYTES = 2 * 1024;

type StateDriver = Pick<SimulatorDriverCoordinator, "isReady" | "observeHealth">;
type StateScreen = Pick<SimulatorScreenObservationCoordinator, "screenMap">;

export class SimulatorStateDiagnosticsError extends Error {
  constructor(readonly code: "INVALID_ARGUMENT", message: string) { super(message); }
}

export interface SimulatorStateDiagnosticsEntry {
  readonly diagnosticsId: string;
  readonly sessionId: string;
  readonly kind: "capture_state";
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly data: Readonly<Record<string, unknown>>;
}

interface StoredEntry {
  readonly scope: SimulatorTaskScope;
  readonly route: SimulatorInstanceRoute;
  readonly entry: SimulatorStateDiagnosticsEntry;
  readonly expiresAt: number;
}

function publicHealthText(value: string | null): string | null {
  if (value === null) return null;
  const safe = redactSecrets(value)
    .replace(/https?:\/\/[^\s)]+/giu, "<redacted-url>")
    .replace(/(?:\/Users\/|\/private\/|\/tmp\/)[^\s"']+/gu, "<redacted-path>")
    .replace(/[A-Za-z]:\\[^\s"']+/gu, "<redacted-path>");
  return safe.slice(0, 256);
}

function publicHealth(health: WdaDriverHealth): WdaDriverHealth {
  return { ready: health.ready, message: publicHealthText(health.message),
    osName: publicHealthText(health.osName), osVersion: publicHealthText(health.osVersion),
    sdkVersion: publicHealthText(health.sdkVersion), deviceIp: publicHealthText(health.deviceIp) };
}

/** Process-local state snapshots. Only structural, bounded data enters diagnostic retention. */
export class SimulatorStateDiagnosticsCoordinator {
  readonly #ownership: SimulatorOwnershipRegistry;
  readonly #driver: StateDriver;
  readonly #screen: StateScreen;
  readonly #now: () => number;
  readonly #entries = new Map<string, StoredEntry>();

  constructor(ownership: SimulatorOwnershipRegistry, driver: StateDriver, screen: StateScreen,
    now: () => number = Date.now) {
    this.#ownership = ownership;
    this.#driver = driver;
    this.#screen = screen;
    this.#now = now;
  }

  async capture(scope: SimulatorTaskScope, route: SimulatorInstanceRoute, signal?: AbortSignal) {
    const instance = this.#requireReady(scope, route);
    const [health, observed] = await Promise.all([
      this.#driver.observeHealth(instance, signal), this.#screen.screenMap(scope, route, signal)
    ]);
    if (signal?.aborted) {
      throw new SimulatorObservationError("OBSERVATION_CANCELLED", "Simulator observation was cancelled.");
    }
    this.#requireReady(scope, route);
    const sanitizedHealth = publicHealth(health);
    const driverDiagnostics = { running: true, logTail: "", capabilityReport: null, nativeSidecar: null };
    const data = { instance, health: sanitizedHealth, orientation: observed.viewport.orientation,
      screenMap: observed.screenMap, stream: null, driverDiagnostics };
    const summary = { instanceId: instance.instanceId, generation: instance.generation,
      simulatorUdid: instance.simulatorUdid, health: { ready: sanitizedHealth.ready },
      orientation: observed.viewport.orientation, viewport: { width: observed.viewport.width,
        height: observed.viewport.height }, screenMap: { snapshotId: observed.screenMap.snapshotId,
        elementCount: observed.screenMap.elements.length, truncated: observed.screenMap.truncated },
      stream: null, driverDiagnostics };
    const entry = this.#record(scope, route, summary);
    return { ...data, diagnosticsId: entry.diagnosticsId };
  }

  get(scope: SimulatorTaskScope, diagnosticsId: string): SimulatorStateDiagnosticsEntry {
    this.#prune();
    const stored = this.#entries.get(diagnosticsId);
    if (!stored || stored.scope.sessionId !== scope.sessionId ||
        stored.scope.targetId !== scope.targetId || stored.scope.generation !== scope.generation) {
      throw new SimulatorStateDiagnosticsError("INVALID_ARGUMENT", "The diagnostics entry does not exist or has expired.");
    }
    this.#requireReady(scope, stored.route);
    return structuredClone(stored.entry);
  }

  clear(instanceId: string): void {
    for (const [id, stored] of this.#entries) {
      if (stored.route.instanceId === instanceId) this.#entries.delete(id);
    }
  }

  #requireReady(scope: SimulatorTaskScope, route: SimulatorInstanceRoute): PublicSimulatorInstance {
    const instance = this.#ownership.requireRoute(scope, route);
    if (instance.lifecycleState !== "ready" || instance.viewerState !== "attached" ||
        !this.#driver.isReady(instance)) {
      throw new SimulatorDriverError("DRIVER_RUNTIME_LOST", "Simulator driver is not ready for observation.");
    }
    return instance;
  }

  #record(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    data: Readonly<Record<string, unknown>>): SimulatorStateDiagnosticsEntry {
    this.#prune();
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_ENTRY_BYTES) {
      throw new SimulatorStateDiagnosticsError("INVALID_ARGUMENT", "Simulator diagnostics exceeded their size limit.");
    }
    const now = this.#now();
    const entry: SimulatorStateDiagnosticsEntry = { diagnosticsId: randomUUID(),
      sessionId: scope.sessionId, kind: "capture_state", createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + TTL_MS).toISOString(), data: structuredClone(data) };
    this.#entries.set(entry.diagnosticsId, { scope: { ...scope }, route: { ...route },
      entry, expiresAt: now + TTL_MS });
    while (this.#entries.size > MAX_ENTRIES) {
      const oldest = this.#entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#entries.delete(oldest);
    }
    return entry;
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, stored] of this.#entries) {
      if (stored.expiresAt <= now) this.#entries.delete(id);
    }
  }
}
