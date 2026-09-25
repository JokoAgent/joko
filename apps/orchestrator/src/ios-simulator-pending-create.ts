import { randomBytes, randomUUID } from "node:crypto";
import type { SimulatorPendingCreateEvidence } from "@joko/tool-ios-simulator";
import type { OperationalStore } from "@joko/store";
import type { SimulatorTaskScope } from "./ios-simulator-ownership.js";

const SCOPE = "service";
const SCOPE_ID = "orchestrator";
const KEY = "ios_simulator_pending_create.v1";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const NAMESPACE = /^[0-9a-f]{32}$/u;
const MAX_PENDING = 128;

export interface SimulatorPendingCreateRecord {
  readonly markerName: string;
  readonly sessionId: string;
  readonly targetId: string;
  readonly bindingGeneration: number;
  readonly operationId: string;
  readonly name: string;
  readonly runtimeIdentifier: string;
  readonly deviceTypeIdentifier: string;
  readonly udid: string | null;
  readonly createdAt: number;
}

interface StoredPendingCreates {
  readonly format: 1;
  readonly namespace: string;
  readonly pending: readonly SimulatorPendingCreateRecord[];
}

export class SimulatorPendingCreateError extends Error {
  constructor(readonly code: "INVALID_STATE" | "INVALID_ARGUMENT" | "PENDING_CREATE_EXISTS", message: string) { super(message); }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function bounded(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function marker(namespace: string, id: string): string {
  return `joko_ios_pending__${namespace}__${id.toLowerCase()}`;
}

function validPending(value: unknown, namespace: string): value is SimulatorPendingCreateRecord {
  if (!record(value) || !exact(value, ["markerName", "sessionId", "targetId", "bindingGeneration", "operationId",
    "name", "runtimeIdentifier", "deviceTypeIdentifier", "udid", "createdAt"])) return false;
  const markerName = value["markerName"];
  const markerPrefix = `joko_ios_pending__${namespace}__`;
  return typeof markerName === "string" && markerName.startsWith(markerPrefix)
    && UUID.test(markerName.slice(markerPrefix.length)) && markerName === markerName.toLowerCase()
    && bounded(value["sessionId"]) && bounded(value["targetId"]) && positive(value["bindingGeneration"])
    && bounded(value["operationId"], 128) && bounded(value["name"], 128)
    && bounded(value["runtimeIdentifier"]) && bounded(value["deviceTypeIdentifier"])
    && (value["udid"] === null || typeof value["udid"] === "string" && UUID.test(value["udid"])
      && value["udid"] === value["udid"].toUpperCase())
    && Number.isSafeInteger(value["createdAt"]) && Number(value["createdAt"]) >= 0;
}

function parse(value: unknown): StoredPendingCreates {
  if (!record(value) || !exact(value, ["format", "namespace", "pending"]) || value["format"] !== 1
    || typeof value["namespace"] !== "string" || !NAMESPACE.test(value["namespace"])
    || !Array.isArray(value["pending"]) || value["pending"].length > MAX_PENDING
    || !value["pending"].every(item => validPending(item, value["namespace"] as string))) {
    throw new SimulatorPendingCreateError("INVALID_STATE", "Simulator pending-create state is invalid.");
  }
  const pending = value["pending"] as SimulatorPendingCreateRecord[];
  if (new Set(pending.map(item => item.markerName)).size !== pending.length
    || new Set(pending.map(item => item.sessionId)).size !== pending.length
    || new Set(pending.map(item => item.operationId)).size !== pending.length) {
    throw new SimulatorPendingCreateError("INVALID_STATE", "Simulator pending-create identities conflict.");
  }
  return { format: 1, namespace: value["namespace"], pending };
}

/** One durable Store namespace and exact markers for interrupted creates. */
export class SimulatorPendingCreateRegistry {
  readonly #store: OperationalStore;
  readonly #createId: () => string;
  readonly #now: () => number;

  constructor(store: OperationalStore, options: { readonly createId?: () => string; readonly now?: () => number } = {}) {
    this.#store = store;
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? Date.now;
    const existing = this.#store.findSetting<unknown>(SCOPE, SCOPE_ID, KEY)?.value;
    if (existing !== undefined) parse(existing);
    else this.#store.transaction(() => {
      const stored = this.#store.findSetting<unknown>(SCOPE, SCOPE_ID, KEY)?.value;
      if (stored === undefined) this.#save({ format: 1, namespace: randomBytes(16).toString("hex"), pending: [] });
      else parse(stored);
    });
  }

  newMarker(): string {
    const stored = this.#load();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = this.#createId();
      if (!UUID.test(id)) throw new SimulatorPendingCreateError("INVALID_ARGUMENT", "Simulator marker identity is invalid.");
      const candidate = marker(stored.namespace, id);
      if (!stored.pending.some(item => item.markerName === candidate)) return candidate;
    }
    throw new SimulatorPendingCreateError("PENDING_CREATE_EXISTS", "Simulator marker identity is already in use.");
  }

  list(): readonly SimulatorPendingCreateRecord[] { return this.#load().pending.map(item => ({ ...item })); }

  forSession(sessionId: string): SimulatorPendingCreateRecord | null {
    return this.#load().pending.find(item => item.sessionId === sessionId) ?? null;
  }

  evidence(input: Omit<SimulatorPendingCreateRecord, "udid" | "createdAt">): SimulatorPendingCreateEvidence {
    return {
      arm: (markerName) => {
        if (markerName !== input.markerName) throw new SimulatorPendingCreateError("INVALID_ARGUMENT", "Simulator marker changed.");
        this.#store.transaction(() => {
          const current = this.#load();
          const pending = { ...input, udid: null, createdAt: this.#now() };
          if (!validPending(pending, current.namespace)) {
            throw new SimulatorPendingCreateError("INVALID_ARGUMENT", "Simulator pending-create input is invalid.");
          }
          if (current.pending.length >= MAX_PENDING || current.pending.some(item => item.sessionId === input.sessionId
            || item.markerName === markerName || item.operationId === input.operationId)) {
            throw new SimulatorPendingCreateError("PENDING_CREATE_EXISTS", "Simulator task already has a pending create.");
          }
          this.#save({ ...current, pending: [...current.pending, pending] });
        });
      },
      clear: (markerName) => {
        if (markerName !== input.markerName) throw new SimulatorPendingCreateError("INVALID_ARGUMENT", "Simulator marker changed.");
        this.clear(markerName);
      }
    };
  }

  markCreated(markerName: string, udid: string): SimulatorPendingCreateRecord {
    if (!UUID.test(udid)) throw new SimulatorPendingCreateError("INVALID_ARGUMENT", "Created Simulator UDID is invalid.");
    return this.#store.transaction(() => {
      const stored = this.#load();
      const current = stored.pending.find(item => item.markerName === markerName);
      if (!current || current.udid !== null && current.udid !== udid.toUpperCase()) {
        throw new SimulatorPendingCreateError("INVALID_STATE", "Simulator pending create is unavailable or conflicted.");
      }
      const updated = { ...current, udid: udid.toUpperCase() };
      this.#save({ ...stored, pending: stored.pending.map(item => item.markerName === markerName ? updated : item) });
      return updated;
    });
  }

  clear(markerName: string): void {
    this.#store.transaction(() => {
      const stored = this.#load();
      if (!stored.pending.some(item => item.markerName === markerName)) return;
      this.#save({ ...stored, pending: stored.pending.filter(item => item.markerName !== markerName) });
    });
  }

  #load(): StoredPendingCreates {
    return parse(this.#store.findSetting<unknown>(SCOPE, SCOPE_ID, KEY)?.value);
  }

  #save(value: StoredPendingCreates): void {
    this.#store.setSetting(SCOPE, SCOPE_ID, KEY, value);
  }
}
