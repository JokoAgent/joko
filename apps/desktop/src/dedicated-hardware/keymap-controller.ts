import {
  DEDICATED_HARDWARE_PHYSICAL_KEYS,
  type DedicatedHardwarePhysicalKey
} from "./settings.js";

export const DEDICATED_HARDWARE_KEYMAP_MAX_BYTES = 512 * 1024;
export const DEDICATED_HARDWARE_KEYMAP_IDENTITY_MAX_CHARACTERS = 512;

export type DedicatedHardwareKeymapPhase = "idle" | "applying" | "occupied" | "restoring" | "error";
export type DedicatedHardwareKeymapFailure =
  | "read"
  | "backup"
  | "transform"
  | "apply"
  | "rollback"
  | "restore"
  | "backup-cleanup"
  | "recovery-required";

export interface DedicatedHardwareKeymapState {
  readonly phase: DedicatedHardwareKeymapPhase;
  readonly backupAvailable: boolean;
  readonly failure: DedicatedHardwareKeymapFailure | null;
}

export interface DedicatedHardwareKeymapBackup {
  readonly version: 1;
  readonly deviceFirmwareIdentity: string;
  readonly contents: string;
}

export interface DedicatedHardwareKeymapDeviceAdapter {
  readonly readDeviceFirmwareIdentity: () => Promise<string>;
  readonly readCurrent: (expectedDeviceFirmwareIdentity: string) => Promise<string>;
  readonly buildManaged: (
    original: string,
    taskKeys: readonly DedicatedHardwarePhysicalKey[]
  ) => string;
  readonly writeCurrent: (expectedDeviceFirmwareIdentity: string, contents: string) => Promise<void>;
  readonly reload: (expectedDeviceFirmwareIdentity: string) => Promise<void>;
}

export interface DedicatedHardwareKeymapBackupStore {
  readonly listBackups: () => Promise<readonly DedicatedHardwareKeymapBackup[]>;
  readonly readBackup: (deviceFirmwareIdentity: string) => Promise<DedicatedHardwareKeymapBackup | undefined>;
  readonly saveBackup: (backup: DedicatedHardwareKeymapBackup) => Promise<void>;
  readonly clearBackup: (expectedDeviceFirmwareIdentity: string) => Promise<void>;
}

export interface DedicatedHardwareKeymapAdapter
  extends DedicatedHardwareKeymapDeviceAdapter, DedicatedHardwareKeymapBackupStore {}

export interface DedicatedHardwareKeymapController {
  readonly getState: () => DedicatedHardwareKeymapState;
  readonly initialize: () => Promise<void>;
  readonly occupy: (
    taskKeys: readonly DedicatedHardwarePhysicalKey[],
    expectedDeviceFirmwareIdentity?: string
  ) => Promise<void>;
  readonly release: () => Promise<void>;
  readonly recover: () => Promise<void>;
  readonly subscribe: (listener: (state: DedicatedHardwareKeymapState) => void) => () => void;
}

export function createDedicatedHardwareKeymapController(
  adapter: DedicatedHardwareKeymapAdapter
): DedicatedHardwareKeymapController {
  let state: DedicatedHardwareKeymapState = { phase: "idle", backupAvailable: false, failure: null };
  let backup: DedicatedHardwareKeymapBackup | undefined;
  let applied: string | undefined;
  let tail = Promise.resolve();
  const listeners = new Set<(state: DedicatedHardwareKeymapState) => void>();

  const publish = (next: DedicatedHardwareKeymapState): void => {
    state = next;
    for (const listener of listeners) {
      try { listener({ ...next }); } catch { /* State observers cannot own keymap recovery. */ }
    }
  };

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => undefined);
    return result;
  };

  const listActiveBackups = async (): Promise<readonly DedicatedHardwareKeymapBackup[]> => {
    const candidates = await adapter.listBackups();
    if (!Array.isArray(candidates)) throw operationError("read");
    const identities = new Set<string>();
    const parsed: DedicatedHardwareKeymapBackup[] = [];
    for (const candidate of candidates) {
      if (!isKeymapBackup(candidate) || identities.has(candidate.deviceFirmwareIdentity)) {
        throw operationError("read");
      }
      identities.add(candidate.deviceFirmwareIdentity);
      parsed.push(candidate);
    }
    return parsed;
  };

  const publishRecoveryRequired = (
    active: readonly DedicatedHardwareKeymapBackup[],
    failure: DedicatedHardwareKeymapFailure = "recovery-required"
  ): void => {
    backup = active.length === 1 ? active[0] : undefined;
    applied = undefined;
    publish({ phase: "error", backupAvailable: true, failure });
  };

  const publishAfterSessionClear = async (
    idleFailure: DedicatedHardwareKeymapFailure | null = null
  ): Promise<void> => {
    let remaining: readonly DedicatedHardwareKeymapBackup[];
    try {
      remaining = await listActiveBackups();
    } catch {
      backup = undefined;
      applied = undefined;
      publish({ phase: "error", backupAvailable: true, failure: "read" });
      throw operationError("read");
    }
    if (remaining.length > 0) {
      publishRecoveryRequired(remaining);
      throw operationError("recovery-required");
    }
    backup = undefined;
    applied = undefined;
    publish({
      phase: idleFailure === null ? "idle" : "error",
      backupAvailable: false,
      failure: idleFailure
    });
  };

  const releaseInternal = async (recovery: boolean): Promise<void> => {
    let identity: string | undefined;
    try {
      identity = await readDeviceFirmwareIdentity(adapter);
    } catch {
      publish({ phase: "error", backupAvailable: state.backupAvailable, failure: "read" });
      throw operationError("read");
    }
    if (identity === undefined) throw operationError("read");
    const wasConfirmedOccupied = state.phase === "occupied" &&
      backup?.deviceFirmwareIdentity === identity && applied !== undefined;
    let active: readonly DedicatedHardwareKeymapBackup[];
    try {
      active = await listActiveBackups();
    } catch {
      publish({ phase: "error", backupAvailable: true, failure: "read" });
      throw operationError("read");
    }
    const original = active.find((candidate) => candidate.deviceFirmwareIdentity === identity);
    if (original === undefined) {
      if (active.length > 0) {
        publishRecoveryRequired(active);
        throw operationError("recovery-required");
      }
      if (state.phase === "occupied") {
        backup = undefined;
        applied = undefined;
        publish({ phase: "error", backupAvailable: false, failure: "restore" });
        throw operationError("restore");
      }
      backup = undefined;
      applied = undefined;
      publish({ phase: "idle", backupAvailable: false, failure: null });
      return;
    }
    backup = original;
    if (!recovery && !wasConfirmedOccupied) {
      publishRecoveryRequired(active);
      throw operationError("recovery-required");
    }
    const cleanupOnly = recovery && state.failure === "backup-cleanup";
    publish({ phase: "restoring", backupAvailable: true, failure: null });
    let current: string;
    try {
      current = await adapter.readCurrent(identity);
    } catch {
      backup = original;
      publish({ phase: "error", backupAvailable: true, failure: "read" });
      throw operationError("read");
    }
    if (cleanupOnly && current === original.contents) {
      try {
        await assertDeviceFirmwareIdentity(adapter, identity);
        await adapter.clearBackup(identity);
      } catch {
        backup = original;
        applied = undefined;
        publish({ phase: "error", backupAvailable: true, failure: "backup-cleanup" });
        throw operationError("backup-cleanup");
      }
      await publishAfterSessionClear();
      return;
    }
    try {
      await assertDeviceFirmwareIdentity(adapter, identity);
      if (current !== original.contents) await adapter.writeCurrent(identity, original.contents);
      await assertDeviceFirmwareIdentity(adapter, identity);
      await adapter.reload(identity);
    } catch {
      backup = original;
      publish({ phase: "error", backupAvailable: true, failure: "restore" });
      throw operationError("restore");
    }
    try {
      await assertDeviceFirmwareIdentity(adapter, identity);
      await adapter.clearBackup(identity);
    } catch {
      backup = original;
      applied = undefined;
      publish({ phase: "error", backupAvailable: true, failure: "backup-cleanup" });
      throw operationError("backup-cleanup");
    }
    await publishAfterSessionClear();
  };

  const occupyInternal = async (
    taskKeys: readonly DedicatedHardwarePhysicalKey[],
    expectedDeviceFirmwareIdentity?: string
  ): Promise<void> => {
    const canonicalTaskKeys = parseTaskKeys(taskKeys);
    if (canonicalTaskKeys === undefined) throw new TypeError("Invalid dedicated hardware task-key layout.");
    if (expectedDeviceFirmwareIdentity !== undefined &&
        !isDeviceFirmwareIdentity(expectedDeviceFirmwareIdentity)) {
      throw new TypeError("Invalid dedicated hardware device-firmware identity.");
    }
    let identity: string;
    try {
      identity = await readDeviceFirmwareIdentity(adapter);
      if (expectedDeviceFirmwareIdentity !== undefined && identity !== expectedDeviceFirmwareIdentity) {
        throw operationError("read");
      }
    } catch {
      publish({ phase: "error", backupAvailable: state.backupAvailable, failure: "read" });
      throw operationError("read");
    }
    const confirmedOccupied = state.phase === "occupied" && backup?.deviceFirmwareIdentity === identity &&
      applied !== undefined;
    if (confirmedOccupied) {
      let active: readonly DedicatedHardwareKeymapBackup[];
      try {
        active = await listActiveBackups();
      } catch {
        publish({ phase: "error", backupAvailable: true, failure: "read" });
        throw operationError("read");
      }
      if (active.length !== 1 || active[0]?.deviceFirmwareIdentity !== identity) {
        if (active.length > 0) publishRecoveryRequired(active);
        else publish({ phase: "error", backupAvailable: false, failure: "restore" });
        throw operationError(active.length > 0 ? "recovery-required" : "restore");
      }
      await updateManaged(canonicalTaskKeys);
      return;
    }

    let stranded: readonly DedicatedHardwareKeymapBackup[];
    try {
      stranded = await listActiveBackups();
    } catch {
      publish({ phase: "error", backupAvailable: true, failure: "read" });
      throw operationError("read");
    }
    if (stranded.length > 0) {
      publishRecoveryRequired(
        stranded,
        state.failure === "backup-cleanup" && stranded.length === 1 &&
          stranded[0]?.deviceFirmwareIdentity === identity
          ? "backup-cleanup"
          : "recovery-required"
      );
      throw operationError("recovery-required");
    }

    let originalContents: string;
    try {
      originalContents = await adapter.readCurrent(identity);
    } catch {
      publish({ phase: "error", backupAvailable: false, failure: "read" });
      throw operationError("read");
    }
    if (!isKeymapDocument(originalContents)) {
      publish({ phase: "error", backupAvailable: false, failure: "read" });
      throw operationError("read");
    }
    const original: DedicatedHardwareKeymapBackup = {
      version: 1,
      deviceFirmwareIdentity: identity,
      contents: originalContents
    };
    try {
      await adapter.saveBackup(original);
    } catch {
      publish({ phase: "error", backupAvailable: false, failure: "backup" });
      throw operationError("backup");
    }
    backup = original;
    publish({ phase: "applying", backupAvailable: true, failure: null });

    let managed: string;
    try {
      managed = adapter.buildManaged(original.contents, canonicalTaskKeys);
    } catch {
      await abandonUnchangedBackup("transform");
      throw operationError("transform");
    }
    if (!isKeymapDocument(managed)) {
      await abandonUnchangedBackup("transform");
      throw operationError("transform");
    }

    try {
      await assertDeviceFirmwareIdentity(adapter, identity);
      await adapter.writeCurrent(identity, managed);
      await assertDeviceFirmwareIdentity(adapter, identity);
      await adapter.reload(identity);
    } catch {
      if (!await deviceIdentityMatches(adapter, identity)) {
        applied = undefined;
        publish({ phase: "error", backupAvailable: true, failure: "recovery-required" });
        throw operationError("recovery-required");
      }
      await rollbackInitial(original);
      throw operationError(state.failure ?? "apply");
    }
    applied = managed;
    publish({ phase: "occupied", backupAvailable: true, failure: null });
  };

  const abandonUnchangedBackup = async (failure: DedicatedHardwareKeymapFailure): Promise<void> => {
    try {
      const identity = backup?.deviceFirmwareIdentity;
      if (identity === undefined) throw operationError("backup-cleanup");
      await assertDeviceFirmwareIdentity(adapter, identity);
      await adapter.clearBackup(identity);
      await publishAfterSessionClear(failure);
    } catch {
      if (state.failure !== "recovery-required" && state.failure !== "read") {
        publish({ phase: "error", backupAvailable: true, failure: "backup-cleanup" });
      }
    }
  };

  const rollbackInitial = async (original: DedicatedHardwareKeymapBackup): Promise<void> => {
    try {
      await assertDeviceFirmwareIdentity(adapter, original.deviceFirmwareIdentity);
      await adapter.writeCurrent(original.deviceFirmwareIdentity, original.contents);
      await assertDeviceFirmwareIdentity(adapter, original.deviceFirmwareIdentity);
      await adapter.reload(original.deviceFirmwareIdentity);
    } catch {
      publish({
        phase: "error",
        backupAvailable: true,
        failure: await deviceIdentityMatches(adapter, original.deviceFirmwareIdentity)
          ? "rollback"
          : "recovery-required"
      });
      return;
    }
    try {
      await assertDeviceFirmwareIdentity(adapter, original.deviceFirmwareIdentity);
      await adapter.clearBackup(original.deviceFirmwareIdentity);
    } catch {
      publish({ phase: "error", backupAvailable: true, failure: "backup-cleanup" });
      return;
    }
    try {
      await publishAfterSessionClear("apply");
    } catch {
      // A different retained session remains the recovery authority.
    }
  };

  const updateManaged = async (taskKeys: readonly DedicatedHardwarePhysicalKey[]): Promise<void> => {
    const original = backup!;
    const previous = applied!;
    publish({ phase: "applying", backupAvailable: true, failure: null });
    let managed: string;
    try {
      managed = adapter.buildManaged(original.contents, taskKeys);
    } catch {
      publish({ phase: "occupied", backupAvailable: true, failure: "transform" });
      throw operationError("transform");
    }
    if (!isKeymapDocument(managed)) {
      publish({ phase: "occupied", backupAvailable: true, failure: "transform" });
      throw operationError("transform");
    }
    if (managed === previous) {
      publish({ phase: "occupied", backupAvailable: true, failure: null });
      return;
    }
    try {
      await assertDeviceFirmwareIdentity(adapter, original.deviceFirmwareIdentity);
      await adapter.writeCurrent(original.deviceFirmwareIdentity, managed);
      await assertDeviceFirmwareIdentity(adapter, original.deviceFirmwareIdentity);
      await adapter.reload(original.deviceFirmwareIdentity);
    } catch {
      if (!await deviceIdentityMatches(adapter, original.deviceFirmwareIdentity)) {
        applied = undefined;
        publish({ phase: "error", backupAvailable: true, failure: "recovery-required" });
        throw operationError("recovery-required");
      }
      try {
        await assertDeviceFirmwareIdentity(adapter, original.deviceFirmwareIdentity);
        await adapter.writeCurrent(original.deviceFirmwareIdentity, previous);
        await assertDeviceFirmwareIdentity(adapter, original.deviceFirmwareIdentity);
        await adapter.reload(original.deviceFirmwareIdentity);
        publish({ phase: "occupied", backupAvailable: true, failure: "apply" });
      } catch {
        publish({ phase: "error", backupAvailable: true, failure: "rollback" });
      }
      throw operationError(state.failure ?? "apply");
    }
    applied = managed;
    publish({ phase: "occupied", backupAvailable: true, failure: null });
  };

  const controller: DedicatedHardwareKeymapController = {
    getState: () => ({ ...state }),
    initialize: () => enqueue(async () => {
      if (backup !== undefined || state.phase !== "idle") return;
      let stranded: readonly DedicatedHardwareKeymapBackup[];
      try {
        stranded = await listActiveBackups();
      } catch {
        publish({ phase: "error", backupAvailable: true, failure: "read" });
        throw operationError("read");
      }
      if (stranded.length === 0) return;
      publishRecoveryRequired(stranded);
    }),
    occupy: (taskKeys, expectedDeviceFirmwareIdentity) => enqueue(() =>
      occupyInternal(taskKeys, expectedDeviceFirmwareIdentity)),
    release: () => enqueue(() => releaseInternal(false)),
    recover: () => enqueue(() => releaseInternal(true)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
  return Object.freeze(controller);
}

function parseTaskKeys(value: readonly DedicatedHardwarePhysicalKey[]): DedicatedHardwarePhysicalKey[] | undefined {
  if (!Array.isArray(value) || value.length > DEDICATED_HARDWARE_PHYSICAL_KEYS.length) return undefined;
  let prior = -1;
  const parsed: DedicatedHardwarePhysicalKey[] = [];
  for (const item of value) {
    if (!(DEDICATED_HARDWARE_PHYSICAL_KEYS as readonly string[]).includes(item)) return undefined;
    const index = DEDICATED_HARDWARE_PHYSICAL_KEYS.indexOf(item);
    if (index <= prior) return undefined;
    prior = index;
    parsed.push(item);
  }
  return parsed;
}

function isKeymapDocument(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > DEDICATED_HARDWARE_KEYMAP_MAX_BYTES) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || !Array.isArray(parsed.profiles) || parsed.profiles.length === 0) return false;
    const profile = parsed.profiles[0];
    return isRecord(profile) && Array.isArray(profile.layers) && profile.layers.length > 0;
  } catch {
    return false;
  }
}

function isKeymapBackup(value: DedicatedHardwareKeymapBackup): boolean {
  return value.version === 1 && isDeviceFirmwareIdentity(value.deviceFirmwareIdentity) &&
    isKeymapDocument(value.contents);
}

async function readDeviceFirmwareIdentity(adapter: DedicatedHardwareKeymapAdapter): Promise<string> {
  const identity = await adapter.readDeviceFirmwareIdentity();
  if (!isDeviceFirmwareIdentity(identity)) throw operationError("read");
  return identity;
}

async function assertDeviceFirmwareIdentity(
  adapter: DedicatedHardwareKeymapAdapter,
  expected: string
): Promise<void> {
  if (await readDeviceFirmwareIdentity(adapter) !== expected) throw operationError("recovery-required");
}

async function deviceIdentityMatches(
  adapter: DedicatedHardwareKeymapAdapter,
  expected: string
): Promise<boolean> {
  try {
    return await readDeviceFirmwareIdentity(adapter) === expected;
  } catch {
    return false;
  }
}

export function isDedicatedHardwareKeymapDeviceFirmwareIdentity(value: unknown): value is string {
  return isDeviceFirmwareIdentity(value);
}

function isDeviceFirmwareIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= DEDICATED_HARDWARE_KEYMAP_IDENTITY_MAX_CHARACTERS && value.trim() === value &&
    !hasLoneSurrogate(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function operationError(failure: DedicatedHardwareKeymapFailure): Error {
  return new Error(`Dedicated hardware keymap operation failed (${failure}).`);
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
