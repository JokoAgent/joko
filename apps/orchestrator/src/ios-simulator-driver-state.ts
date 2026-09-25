import { randomUUID } from "node:crypto";
import type { OperationalStore } from "@joko/store";
import type { PublicSimulatorInstance } from "./ios-simulator-ownership.js";

const KEY = "ios_simulator_driver.v1";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const epochs = new WeakMap<OperationalStore, string>();

export interface SimulatorDriverRecord {
  readonly instanceId: string;
  readonly simulatorUdid: string;
  readonly instanceGeneration: number;
  readonly state: "ready" | "error";
  readonly managerLeaseId: string | null;
  readonly ownerEpoch: string | null;
  readonly ownerPid: number | null;
  readonly errorCode: string | null;
  readonly updatedAt: number;
}

interface StoredDriverState { readonly format: 1; readonly records: readonly SimulatorDriverRecord[] }

export class SimulatorDriverStateError extends Error {
  constructor(readonly code: "INVALID_STATE", message: string) { super(message); }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function validRecord(value: unknown): value is SimulatorDriverRecord {
  if (!object(value) || !keys(value, ["instanceId", "simulatorUdid", "instanceGeneration", "state",
    "managerLeaseId", "ownerEpoch", "ownerPid", "errorCode", "updatedAt"])) return false;
  return typeof value["instanceId"] === "string" && value["instanceId"].length > 0 &&
    value["instanceId"].length <= 128 && value["instanceId"].trim() === value["instanceId"] &&
    !/[\0\r\n]/u.test(value["instanceId"]) && typeof value["simulatorUdid"] === "string" &&
    UUID.test(value["simulatorUdid"]) && value["simulatorUdid"] === value["simulatorUdid"].toUpperCase() &&
    Number.isSafeInteger(value["instanceGeneration"]) && Number(value["instanceGeneration"]) > 0 &&
    Number.isSafeInteger(value["updatedAt"]) && Number(value["updatedAt"]) >= 0 &&
    (value["state"] === "ready" && typeof value["managerLeaseId"] === "string" &&
      UUID.test(value["managerLeaseId"]) && typeof value["ownerEpoch"] === "string" &&
      UUID.test(value["ownerEpoch"]) && Number.isSafeInteger(value["ownerPid"]) &&
      Number(value["ownerPid"]) > 0 && value["errorCode"] === null ||
      value["state"] === "error" && value["managerLeaseId"] === null && value["ownerEpoch"] === null &&
      value["ownerPid"] === null &&
      typeof value["errorCode"] === "string" && /^[A-Z][A-Z0-9_]{0,127}$/u.test(value["errorCode"]));
}

function parse(value: unknown): StoredDriverState {
  if (!object(value) || !keys(value, ["format", "records"]) || value["format"] !== 1 ||
      !Array.isArray(value["records"]) || value["records"].length > 128 || !value["records"].every(validRecord)) {
    throw new SimulatorDriverStateError("INVALID_STATE", "Simulator driver state is invalid.");
  }
  const records = value["records"] as SimulatorDriverRecord[];
  if (new Set(records.map(record => record.instanceId)).size !== records.length ||
      new Set(records.map(record => record.simulatorUdid)).size !== records.length) {
    throw new SimulatorDriverStateError("INVALID_STATE", "Simulator driver identities conflict.");
  }
  return { format: 1, records };
}

/** A runtime-specific Store projection; old process readiness is invalidated on Store reopen. */
export class SimulatorDriverStateRegistry {
  readonly #store: OperationalStore;
  readonly #epoch: string;
  readonly #now: () => number;
  readonly #ownerAlive: (pid: number) => boolean;

  constructor(store: OperationalStore, options: { readonly now?: () => number; readonly epoch?: string;
    readonly ownerAlive?: (pid: number) => boolean } = {}) {
    this.#store = store;
    this.#now = options.now ?? Date.now;
    const ownerAlive = options.ownerAlive ?? ((pid: number) => {
      try { process.kill(pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    });
    this.#ownerAlive = pid => { try { return ownerAlive(pid); } catch { return true; } };
    let epoch = options.epoch ?? epochs.get(store);
    epoch ??= randomUUID();
    if (!UUID.test(epoch)) throw new SimulatorDriverStateError("INVALID_STATE", "Driver runtime identity is invalid.");
    epochs.set(store, epoch);
    this.#epoch = epoch;
    this.#load();
    this.#store.transaction(() => {
      const current = this.#load();
      const changed = current.records.some(record => record.state === "ready" &&
        record.ownerEpoch !== this.#epoch && !this.#ownerAlive(record.ownerPid!));
      if (!changed) return;
      this.#save({ format: 1, records: current.records.map(record =>
        record.state === "ready" && record.ownerEpoch !== this.#epoch && !this.#ownerAlive(record.ownerPid!)
          ? { ...record, state: "error" as const, managerLeaseId: null, ownerEpoch: null, ownerPid: null,
            errorCode: "DRIVER_RUNTIME_LOST", updatedAt: this.#now() }
          : record) });
    });
  }

  get(instanceId: string): SimulatorDriverRecord | null {
    const record = this.#load().records.find(item => item.instanceId === instanceId);
    return record ? { ...record } : null;
  }

  isCurrentReady(instanceId: string, generation: number, managerLeaseId: string): boolean {
    const record = this.get(instanceId);
    return record?.state === "ready" && record.instanceGeneration === generation &&
      record.managerLeaseId === managerLeaseId && record.ownerEpoch === this.#epoch;
  }

  ready(instance: PublicSimulatorInstance, managerLeaseId: string): SimulatorDriverRecord {
    if (!UUID.test(managerLeaseId)) throw new SimulatorDriverStateError("INVALID_STATE", "Driver lease is invalid.");
    const record: SimulatorDriverRecord = { instanceId: instance.instanceId,
      simulatorUdid: instance.simulatorUdid, instanceGeneration: instance.generation,
      state: "ready", managerLeaseId, ownerEpoch: this.#epoch, ownerPid: process.pid,
      errorCode: null, updatedAt: this.#now() };
    this.#replace(record);
    return record;
  }

  error(instance: PublicSimulatorInstance, code: string): SimulatorDriverRecord {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(code)) {
      throw new SimulatorDriverStateError("INVALID_STATE", "Driver error code is invalid.");
    }
    const record: SimulatorDriverRecord = { instanceId: instance.instanceId,
      simulatorUdid: instance.simulatorUdid, instanceGeneration: instance.generation,
      state: "error", managerLeaseId: null, ownerEpoch: null, ownerPid: null,
      errorCode: code, updatedAt: this.#now() };
    this.#replace(record);
    return record;
  }

  clear(instanceId: string): void {
    const current = this.#load();
    if (!current.records.some(item => item.instanceId === instanceId)) return;
    this.#save({ format: 1, records: current.records.filter(item => item.instanceId !== instanceId) });
  }

  #replace(record: SimulatorDriverRecord): void {
    const current = this.#load();
    const existing = current.records.find(item => item.instanceId === record.instanceId ||
      item.simulatorUdid === record.simulatorUdid);
    if (existing && (existing.instanceId !== record.instanceId || existing.simulatorUdid !== record.simulatorUdid)) {
      throw new SimulatorDriverStateError("INVALID_STATE", "Driver ownership changed.");
    }
    if (!existing && current.records.length >= 128) throw new SimulatorDriverStateError("INVALID_STATE", "Driver capacity is exhausted.");
    this.#save({ format: 1, records: [...current.records.filter(item => item.instanceId !== record.instanceId), record] });
  }

  #load(): StoredDriverState {
    const value = this.#store.findSetting<unknown>("service", "orchestrator", KEY)?.value;
    return value === undefined ? { format: 1, records: [] } : parse(value);
  }

  #save(state: StoredDriverState): void { this.#store.setSetting("service", "orchestrator", KEY, state); }
}
