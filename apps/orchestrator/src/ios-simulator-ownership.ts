import { createHash, randomUUID } from "node:crypto";
import type { SimulatorDevice } from "@joko/tool-ios-simulator";
import type { OperationalStore } from "@joko/store";

const SCOPE = "service";
const SCOPE_ID = "orchestrator";
const KEY = "ios_simulator_ownership.v1";
const MAX_INSTANCES = 128;
const LEASE_MS = 60_000;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;

export interface SimulatorTaskScope {
  readonly sessionId: string;
  readonly targetId: string;
  readonly generation: number;
}

export interface SimulatorOwnedInstance {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly targetId: string;
  readonly backendId: string;
  readonly bindingGeneration: number;
  /** Private digest of the current Target root and optional managed worktree lease. */
  readonly workspaceFingerprint: string;
  readonly simulatorUdid: string;
  readonly simulatorName: string;
  readonly runtimeIdentifier: string;
  readonly deviceTypeIdentifier: string;
  readonly creationProvenance: "joko" | "external";
  readonly bootProvenance: "agent_booted" | "user_booted" | "preexisting";
  readonly generation: number;
  readonly lifecycleState: "stopped" | "ready" | "error";
  readonly viewerState: "detached" | "attached";
  readonly healthState: "healthy" | "degraded" | "error";
  readonly lease: { readonly id: string; readonly issuedAt: number; readonly expiresAt: number };
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly errorCode: string | null;
}

export type PublicSimulatorInstance = Omit<SimulatorOwnedInstance, "backendId" | "bindingGeneration" | "workspaceFingerprint">;

interface StoredOwnership {
  readonly format: 1;
  readonly instances: readonly SimulatorOwnedInstance[];
}

export class SimulatorOwnershipError extends Error {
  constructor(readonly code: "INVALID_OWNERSHIP" | "STALE_SCOPE" | "INVALID_ARGUMENT" | "DEVICE_BUSY" | "SESSION_INSTANCE_LIMIT_REACHED", message: string) {
    super(message);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}

function bounded(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value);
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validInstance(value: unknown): value is SimulatorOwnedInstance {
  if (!record(value) || !exactKeys(value, ["instanceId", "sessionId", "targetId", "backendId", "bindingGeneration", "workspaceFingerprint",
    "simulatorUdid", "simulatorName", "runtimeIdentifier", "deviceTypeIdentifier", "creationProvenance", "bootProvenance",
    "generation", "lifecycleState", "viewerState", "healthState", "lease", "createdAt", "updatedAt", "errorCode"])) return false;
  if (!bounded(value["instanceId"], 128) || !bounded(value["sessionId"]) || !bounded(value["targetId"])
    || !bounded(value["backendId"]) || !positive(value["bindingGeneration"])
    || typeof value["workspaceFingerprint"] !== "string" || !DIGEST.test(value["workspaceFingerprint"])
    || typeof value["simulatorUdid"] !== "string" || !UUID.test(value["simulatorUdid"])
    || value["simulatorUdid"] !== value["simulatorUdid"].toUpperCase()
    || !bounded(value["simulatorName"], 128) || !bounded(value["runtimeIdentifier"])
    || !bounded(value["deviceTypeIdentifier"]) || !positive(value["generation"])
    || !timestamp(value["createdAt"]) || !timestamp(value["updatedAt"])
    || Number(value["updatedAt"]) < Number(value["createdAt"])
    || !["joko", "external"].includes(String(value["creationProvenance"]))
    || !["agent_booted", "user_booted", "preexisting"].includes(String(value["bootProvenance"]))
    || !["stopped", "ready", "error"].includes(String(value["lifecycleState"]))
    || !["detached", "attached"].includes(String(value["viewerState"]))
    || !["healthy", "degraded", "error"].includes(String(value["healthState"]))
    || value["errorCode"] !== null && !bounded(value["errorCode"], 128)) return false;
  const lease = value["lease"];
  return record(lease) && exactKeys(lease, ["id", "issuedAt", "expiresAt"])
    && bounded(lease["id"], 128) && timestamp(lease["issuedAt"])
    && timestamp(lease["expiresAt"]) && Number(lease["expiresAt"]) > Number(lease["issuedAt"]);
}

function parseOwnership(value: unknown): StoredOwnership {
  if (!record(value) || !exactKeys(value, ["format", "instances"]) || value["format"] !== 1
    || !Array.isArray(value["instances"]) || value["instances"].length > MAX_INSTANCES
    || !value["instances"].every(validInstance)) {
    throw new SimulatorOwnershipError("INVALID_OWNERSHIP", "Simulator ownership state is invalid.");
  }
  const instances = value["instances"] as SimulatorOwnedInstance[];
  if (new Set(instances.map(item => item.instanceId)).size !== instances.length
    || new Set(instances.map(item => item.simulatorUdid)).size !== instances.length
    || new Set(instances.map(item => item.sessionId)).size !== instances.length) {
    throw new SimulatorOwnershipError("INVALID_OWNERSHIP", "Simulator ownership identities conflict.");
  }
  return { format: 1, instances };
}

function publicInstance(instance: SimulatorOwnedInstance): PublicSimulatorInstance {
  const { backendId: _backendId, bindingGeneration: _bindingGeneration, workspaceFingerprint: _fingerprint, ...visible } = instance;
  return { ...visible, lease: { ...visible.lease } };
}

export class SimulatorOwnershipRegistry {
  readonly #store: OperationalStore;
  readonly #now: () => number;
  readonly #createId: () => string;

  constructor(store: OperationalStore, options: { readonly now?: () => number; readonly createId?: () => string } = {}) {
    this.#store = store;
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
    this.#load();
  }

  listForTask(scope: SimulatorTaskScope): readonly PublicSimulatorInstance[] {
    const fingerprint = this.#fingerprint(scope);
    const stored = this.#load();
    const owned = stored.instances.filter(item => item.sessionId === scope.sessionId);
    for (const item of owned) this.#assertOwner(item, scope, fingerprint);
    if (owned.every(item => item.lease.expiresAt > this.#now())) return owned.map(publicInstance);
    return this.#store.transaction(() => {
      const currentFingerprint = this.#fingerprint(scope);
      const current = this.#load();
      const found = current.instances.find(item => item.sessionId === scope.sessionId);
      if (found === undefined) return [];
      this.#assertOwner(found, scope, currentFingerprint);
      if (found.lease.expiresAt > this.#now()) return [publicInstance(found)];
      const now = this.#now();
      const renewed: SimulatorOwnedInstance = { ...found,
        lease: { id: this.#createId(), issuedAt: now, expiresAt: now + LEASE_MS }, updatedAt: now };
      this.#save({ format: 1, instances: current.instances.map(item => item.instanceId === found.instanceId ? renewed : item) });
      return [publicInstance(renewed)];
    });
  }

  /** Reserve an exact available device before a later lifecycle or viewer action. */
  bindExternalDevice(scope: SimulatorTaskScope, device: SimulatorDevice): PublicSimulatorInstance {
    if (!UUID.test(device.udid) || !device.isAvailable || !bounded(device.name, 128) || !bounded(device.state, 128)
      || !bounded(device.runtimeIdentifier) || !bounded(device.deviceTypeIdentifier)) {
      throw new SimulatorOwnershipError("INVALID_ARGUMENT", "Selected Simulator device is invalid or unavailable.");
    }
    return this.#store.transaction(() => {
      const fingerprint = this.#fingerprint(scope);
      const stored = this.#load();
      const udid = device.udid.toUpperCase();
      const existing = stored.instances.find(item => item.simulatorUdid === udid);
      if (existing !== undefined) {
        if (existing.sessionId !== scope.sessionId) throw new SimulatorOwnershipError("DEVICE_BUSY", "Simulator device belongs to another task.");
        this.#assertOwner(existing, scope, fingerprint);
        return publicInstance(existing);
      }
      if (stored.instances.some(item => item.sessionId === scope.sessionId)) {
        throw new SimulatorOwnershipError("SESSION_INSTANCE_LIMIT_REACHED", "This task already owns a Simulator device.");
      }
      if (stored.instances.length >= MAX_INSTANCES) throw new SimulatorOwnershipError("DEVICE_BUSY", "Simulator capacity is exhausted.");
      const session = this.#store.getSession(scope.sessionId).descriptor;
      const now = this.#now();
      const running = device.state.toLowerCase() === "booted";
      const instance: SimulatorOwnedInstance = {
        instanceId: this.#createId(), sessionId: scope.sessionId, targetId: scope.targetId,
        backendId: session.backendId, bindingGeneration: scope.generation, workspaceFingerprint: fingerprint,
        simulatorUdid: udid, simulatorName: device.name, runtimeIdentifier: device.runtimeIdentifier,
        deviceTypeIdentifier: device.deviceTypeIdentifier!, creationProvenance: "external",
        bootProvenance: running ? "preexisting" : "user_booted", generation: 1,
        lifecycleState: running ? "ready" : "stopped", viewerState: "detached", healthState: "healthy",
        lease: { id: this.#createId(), issuedAt: now, expiresAt: now + LEASE_MS },
        createdAt: now, updatedAt: now, errorCode: null
      };
      this.#save({ format: 1, instances: [...stored.instances, instance] });
      return publicInstance(instance);
    });
  }

  #fingerprint(scope: SimulatorTaskScope): string {
    try {
      const session = this.#store.getSession(scope.sessionId).descriptor;
      const target = this.#store.getTarget(scope.targetId).descriptor;
      if (session.targetId !== scope.targetId || session.backendId !== target.backendId
        || session.binding.generation !== scope.generation || session.archived || session.deletedAt !== undefined
        || !target.trusted || target.remoteWorkspace !== undefined || session.remoteWorkspace !== undefined
        || session.worktree !== undefined && session.worktree.state !== "active") throw new Error("stale");
      return createHash("sha256").update(JSON.stringify([target.workspaceRoot, session.worktree?.path ?? null,
        session.worktree?.leaseId ?? null])).digest("hex");
    } catch {
      throw new SimulatorOwnershipError("STALE_SCOPE", "Simulator task scope is stale or unavailable.");
    }
  }

  #assertOwner(instance: SimulatorOwnedInstance, scope: SimulatorTaskScope, fingerprint: string): void {
    if (instance.targetId !== scope.targetId || instance.bindingGeneration !== scope.generation
      || instance.backendId !== this.#store.getSession(scope.sessionId).descriptor.backendId
      || instance.workspaceFingerprint !== fingerprint) {
      throw new SimulatorOwnershipError("STALE_SCOPE", "Simulator instance ownership no longer matches this task.");
    }
  }

  #load(): StoredOwnership {
    const value = this.#store.findSetting<unknown>(SCOPE, SCOPE_ID, KEY)?.value;
    return value === undefined ? { format: 1, instances: [] } : parseOwnership(value);
  }

  #save(value: StoredOwnership): void {
    this.#store.setSetting(SCOPE, SCOPE_ID, KEY, value);
  }
}
