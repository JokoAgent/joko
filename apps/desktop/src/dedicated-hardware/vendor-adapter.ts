import {
  buildCreatorManagedKeymap,
  readCreatorManagedHidMapping,
  type CreatorKeymapContext
} from "./creator-keymap.js";
import {
  DEDICATED_HARDWARE_KEYMAP_MAX_BYTES,
  isDedicatedHardwareKeymapDeviceFirmwareIdentity
} from "./keymap-controller.js";
import type { DedicatedHardwareDesiredState, DedicatedHardwareUtilityDeviceSnapshot } from "./protocol.js";
import { DEDICATED_HARDWARE_MODEL_IDS, type DedicatedHardwareModelId, type DedicatedHardwarePhysicalKey }
  from "./settings.js";
import type { DedicatedHardwareUtilityAdapter, DedicatedHardwareUtilityAdapterSink } from "./utility-handler.js";
import { createDedicatedHardwareNotificationCodec, installCompactHardwareNotifications }
  from "./vendor-notifications.js";

const KEYMAP_FILE = "keymap.json";
const KEYMAP_SETTLE_MS = 2_500;
const RPC_TIMEOUT_MS = 4_000;
const logger = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

interface Device {
  readonly isUsbConnection: boolean;
  readonly serialNumber?: string;
}
interface Communication {
  connect(device: Device): Promise<boolean>;
  disconnect(): Promise<void>;
  parseRpcData(data: string): boolean;
  rpcResponse?: string;
}
interface DeviceApi {
  readonly api: {
    readFile(name: string): Promise<unknown>;
    writeFile(name: string, contents: string): Promise<unknown>;
  };
  getDeviceStatus(): Promise<unknown>;
  onHidReceived(listener: (value: unknown) => void): (() => void) | void;
  onJoystickMove(listener: (value: unknown) => void): (() => void) | void;
}
interface Sdk {
  readonly DeviceType: { readonly CodexMicro: unknown; readonly CreatorMicroV2: unknown };
  readonly WLDeviceDiscovery: new (log: typeof logger) => { findWLDevices(filter: unknown[]): unknown[] };
  readonly WLDeviceCommImpl: new (log: typeof logger) => Communication;
  readonly RPCApiOAI: new (comm: Communication, log: typeof logger) => DeviceApi;
}
interface Status {
  readonly firmwareVersion: string | null;
  readonly batteryPercentage: number | null;
  readonly isCharging: boolean | null;
  readonly profileIndex: number | null;
  readonly layerIndex: number | null;
}
interface Connection {
  readonly generation: number;
  readonly device: Device;
  readonly comm: Communication;
  readonly api: DeviceApi;
  readonly codec: ReturnType<typeof createDedicatedHardwareNotificationCodec>;
  readonly unsubscribers: (() => void)[];
  readonly restoreParser: () => void;
  ready: boolean;
  status: Status;
  context?: CreatorKeymapContext;
  expectedContents?: string;
  mapping?: ReadonlyMap<DedicatedHardwarePhysicalKey, DedicatedHardwarePhysicalKey>;
}
interface Slot {
  readonly model: DedicatedHardwareModelId;
  generation: number;
  enabled: boolean;
  connection?: Connection;
}

/** Adapts the admitted SDK's declared raw API; it never resolves package paths or grants. */
export function createDedicatedHardwareVendorAdapter(options: {
  readonly sdk: unknown;
  readonly sink: DedicatedHardwareUtilityAdapterSink;
  readonly platform: NodeJS.Platform;
  readonly settle?: (milliseconds: number) => Promise<void>;
}): DedicatedHardwareUtilityAdapter {
  const sdk = admitSdk(options.sdk);
  const discovery = new sdk.WLDeviceDiscovery(logger);
  if (typeof discovery.findWLDevices !== "function") throw failure();
  const slots = new Map<DedicatedHardwareModelId, Slot>(
    DEDICATED_HARDWARE_MODEL_IDS.map((model) => [model, { model, generation: 0, enabled: false }])
  );
  const settle = options.settle ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let stopped = false;

  const slotFor = (model: DedicatedHardwareModelId): Slot => {
    const slot = slots.get(model);
    if (stopped || slot === undefined) throw failure();
    return slot;
  };
  const candidates = (model: DedicatedHardwareModelId): Device[] => {
    const type = model === "codex-micro" ? sdk.DeviceType.CodexMicro : sdk.DeviceType.CreatorMicroV2;
    const found = discovery.findWLDevices([type]);
    if (!Array.isArray(found) || found.length > 32) throw failure();
    const parsed = found.map((device) => {
      if (!record(device) || typeof device.isUsbConnection !== "boolean") throw failure();
      return device as unknown as Device;
    }).sort((left, right) => Number(right.isUsbConnection) - Number(left.isUsbConnection));
    if (parsed.length > 1 && (parsed.some((device) => !validIdentityPart(device.serialNumber)) ||
      new Set(parsed.map((device) => device.serialNumber)).size !== 1)) {
      throw Object.assign(failure(), { code: "EBUSY" });
    }
    return parsed;
  };
  const current = (slot: Slot, connection: Connection): boolean =>
    !stopped && slot.connection === connection && slot.generation === connection.generation;
  const retire = async (slot: Slot): Promise<void> => {
    const connection = slot.connection;
    slot.connection = undefined;
    slot.generation += 1;
    if (connection === undefined) return;
    connection.ready = false;
    connection.codec.reset();
    connection.restoreParser();
    for (const unsubscribe of connection.unsubscribers) {
      try { unsubscribe(); } catch { /* Generation retirement already revoked callbacks. */ }
    }
    await bounded(connection.comm.disconnect());
  };
  const readStatus = async (slot: Slot, connection: Connection): Promise<Status> => {
    if (!current(slot, connection)) throw failure();
    const found = candidates(slot.model);
    if (!found.some((device) => device.serialNumber === connection.device.serialNumber &&
      device.isUsbConnection === connection.device.isUsbConnection)) throw failure();
    const status = parseStatus(await bounded(connection.api.getDeviceStatus()));
    if (!current(slot, connection)) throw failure();
    connection.status = status;
    return status;
  };
  const connect = async (slot: Slot): Promise<Connection | undefined> => {
    if (slot.connection !== undefined) {
      await readStatus(slot, slot.connection);
      return slot.connection;
    }
    const device = candidates(slot.model)[0];
    if (device === undefined) return undefined;
    const comm = new sdk.WLDeviceCommImpl(logger);
    if (typeof comm.connect !== "function" || typeof comm.disconnect !== "function" ||
      typeof comm.parseRpcData !== "function") throw failure();
    const generation = ++slot.generation;
    try {
      if (await bounded(comm.connect(device)) !== true || stopped || slot.generation !== generation) throw failure();
      const api = new sdk.RPCApiOAI(comm, logger);
      if (typeof api.getDeviceStatus !== "function" || typeof api.onHidReceived !== "function" ||
        typeof api.onJoystickMove !== "function" || !record(api.api) ||
        typeof api.api.readFile !== "function" || typeof api.api.writeFile !== "function") throw failure();
      let connection: Connection;
      const codec = createDedicatedHardwareNotificationCodec({
        resolvePhysicalKey: (wire) => slot.model === "creator-micro-2" ? connection.mapping?.get(wire) : wire
      });
      connection = {
        generation, device, comm, api, codec, ready: false, unsubscribers: [],
        restoreParser: installCompactHardwareNotifications(comm),
        status: { firmwareVersion: null, batteryPercentage: null, isCharging: null, profileIndex: null, layerIndex: null }
      };
      slot.connection = connection;
      const receive = (kind: "hid" | "joystick", value: unknown): void => {
        if (!current(slot, connection) || !slot.enabled || !connection.ready ||
          (slot.model === "creator-micro-2" && connection.mapping === undefined)) return;
        const input = codec[kind](value);
        if (input !== undefined) options.sink.publishInput(slot.model, input);
      };
      for (const subscription of [api.onHidReceived((value) => receive("hid", value)),
        api.onJoystickMove((value) => receive("joystick", value))]) {
        if (subscription !== undefined && typeof subscription !== "function") throw failure();
        if (subscription !== undefined) connection.unsubscribers.push(subscription);
      }
      await readStatus(slot, connection);
      if (slot.model === "creator-micro-2") deviceIdentity(connection);
      connection.ready = slot.enabled;
      return connection;
    } catch (error) {
      if (slot.connection?.comm === comm) await retire(slot).catch(() => undefined);
      else await bounded(comm.disconnect()).catch(() => undefined);
      throw error;
    }
  };
  const snapshot = (slot: Slot, status: DedicatedHardwareUtilityDeviceSnapshot["status"],
    reason: DedicatedHardwareUtilityDeviceSnapshot["reason"] = null): DedicatedHardwareUtilityDeviceSnapshot => {
    const connection = slot.connection;
    return {
      model: slot.model, status, reason,
      devicePresent: connection === undefined ? (status === "not-detected" ? false : null) : true,
      transport: connection === undefined ? null : connection.device.isUsbConnection ? "usb" : "bluetooth",
      firmwareVersion: connection?.status.firmwareVersion ?? null,
      batteryPercent: connection?.status.batteryPercentage ?? null,
      charging: connection?.status.isCharging ?? null,
      inputPermission: reason === "permission-required" ? "denied" : connection === undefined ? "unknown" :
        options.platform === "darwin" ? "granted" : "not-required",
      keymapDeviceFirmwareIdentity: slot.model === "creator-micro-2" && connection !== undefined
        ? deviceIdentity(connection) : null
    };
  };
  const refresh = async (slot: Slot): Promise<DedicatedHardwareUtilityDeviceSnapshot> => {
    if (!slot.enabled) return snapshot(slot, "disabled");
    if (slot.connection !== undefined) slot.connection.ready = false;
    try {
      const connection = await connect(slot);
      if (connection === undefined) return snapshot(slot, "not-detected");
      connection.ready = true;
      return snapshot(slot, "connected");
    } catch (error) {
      await retire(slot).catch(() => undefined);
      return snapshot(slot, "error", errorReason(error));
    }
  };
  const creator = async (expected?: string): Promise<Readonly<{ slot: Slot; connection: Connection; identity: string }>> => {
    const slot = slotFor("creator-micro-2");
    const connection = await connect(slot);
    if (connection === undefined) throw failure();
    const identity = deviceIdentity(connection);
    if (expected !== undefined && identity !== expected) throw failure();
    if (connection.context !== undefined) assertContext(connection.context, connection.status);
    return { slot, connection, identity };
  };
  const readContents = async (slot: Slot, connection: Connection): Promise<string> => {
    const value = success(await bounded(connection.api.api.readFile(KEYMAP_FILE)));
    if (!current(slot, connection) || typeof value !== "string" || value.length === 0 ||
      Buffer.byteLength(value, "utf8") > DEDICATED_HARDWARE_KEYMAP_MAX_BYTES) throw failure();
    return value;
  };

  return Object.freeze({
    creatorKeymap: Object.freeze({
      readDeviceFirmwareIdentity: async () => (await creator()).identity,
      readCurrent: async (expected: string) => {
        const { slot, connection } = await creator(expected);
        const context = contextOf(connection.status);
        const contents = await readContents(slot, connection);
        assertContext(context, await readStatus(slot, connection));
        if (deviceIdentity(connection) !== expected) throw failure();
        connection.context ??= context;
        connection.expectedContents ??= contents;
        return contents;
      },
      buildManaged: (original: string, taskKeys: readonly DedicatedHardwarePhysicalKey[]) => {
        const connection = slotFor("creator-micro-2").connection;
        if (connection?.context === undefined) throw failure();
        return buildCreatorManagedKeymap(original, taskKeys, connection.context);
      },
      writeCurrent: async (expected: string, contents: string) => {
        if (typeof contents !== "string" || contents.length === 0 ||
          Buffer.byteLength(contents, "utf8") > DEDICATED_HARDWARE_KEYMAP_MAX_BYTES) throw failure();
        const { slot, connection } = await creator(expected);
        if (connection.context === undefined) throw failure();
        connection.ready = false;
        success(await bounded(connection.api.api.writeFile(KEYMAP_FILE, contents)));
        if (!current(slot, connection)) throw failure();
        connection.expectedContents = contents;
      },
      reload: async (expected: string) => {
        const { slot, connection } = await creator(expected);
        if (connection.context === undefined || connection.expectedContents === undefined) throw failure();
        await settle(KEYMAP_SETTLE_MS);
        await readStatus(slot, connection);
        if (deviceIdentity(connection) !== expected) throw failure();
        assertContext(connection.context, connection.status);
        const contents = await readContents(slot, connection);
        if (contents !== connection.expectedContents) throw failure();
        assertContext(connection.context, await readStatus(slot, connection));
        if (deviceIdentity(connection) !== expected) throw failure();
        connection.mapping = readCreatorManagedHidMapping(contents, connection.context);
        connection.ready = slot.enabled;
      }
    }),
    setDesiredState: async (model: DedicatedHardwareModelId, desired: DedicatedHardwareDesiredState) => {
      const slot = slotFor(model);
      slot.enabled = desired.settings.enabled;
      if (!slot.enabled && slot.connection !== undefined) {
        slot.connection.ready = false;
        slot.connection.codec.reset();
      }
      return refresh(slot);
    },
    probe: async (model: DedicatedHardwareModelId) => refresh(slotFor(model)),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      for (const slot of slots.values()) slot.enabled = false;
      const results = await Promise.allSettled([...slots.values()].map(retire));
      if (results.some((result) => result.status === "rejected")) throw failure();
    }
  });
}

function admitSdk(value: unknown): Sdk {
  if (!record(value) || !record(value.DeviceType) || value.DeviceType.CodexMicro === undefined ||
    value.DeviceType.CreatorMicroV2 === undefined || value.DeviceType.CodexMicro === value.DeviceType.CreatorMicroV2 ||
    typeof value.WLDeviceDiscovery !== "function" || typeof value.WLDeviceCommImpl !== "function" ||
    typeof value.RPCApiOAI !== "function") throw failure();
  return value as unknown as Sdk;
}
function success(value: unknown): unknown {
  if (!record(value) || value.ok !== true ||
    value.error !== undefined) throw failure();
  return value.value;
}
function parseStatus(envelope: unknown): Status {
  const value = success(envelope);
  if (!record(value)) throw failure();
  const optional = <T>(field: unknown, valid: (candidate: unknown) => candidate is T): T | null => {
    if (field === undefined) return null;
    if (!valid(field)) throw failure();
    return field;
  };
  return {
    firmwareVersion: optional(value.firmwareVersion, validIdentityPart),
    batteryPercentage: optional(value.batteryPercentage, (field): field is number =>
      typeof field === "number" && Number.isFinite(field) && field >= 0 && field <= 100),
    isCharging: optional(value.isCharging, (field): field is boolean => typeof field === "boolean"),
    profileIndex: optional(value.profileIndex, (field): field is number => Number.isSafeInteger(field) && Number(field) >= 0),
    layerIndex: optional(value.layerIndex, (field): field is number => Number.isSafeInteger(field) && Number(field) >= 1)
  };
}
function contextOf(status: Status): CreatorKeymapContext {
  if (status.profileIndex === null || status.layerIndex === null) throw failure();
  return Object.freeze({ profileIndex: status.profileIndex, layerIndex: status.layerIndex });
}
function assertContext(context: CreatorKeymapContext, status: Status): void {
  if (status.profileIndex !== context.profileIndex || status.layerIndex !== context.layerIndex) throw failure();
}
function deviceIdentity(connection: Connection): string {
  if (!validIdentityPart(connection.device.serialNumber) || connection.status.firmwareVersion === null) throw failure();
  const identity = JSON.stringify(["creator-micro-2", connection.device.serialNumber,
    connection.status.firmwareVersion, "keymap-v1"]);
  if (!isDedicatedHardwareKeymapDeviceFirmwareIdentity(identity)) throw failure();
  return identity;
}
function validIdentityPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}
function errorReason(error: unknown): DedicatedHardwareUtilityDeviceSnapshot["reason"] {
  const code = record(error) ? error.code : undefined;
  if (code === "EACCES" || code === "EPERM") return "permission-required";
  if (code === "EBUSY") return "device-in-use";
  if (code === "ETIMEDOUT") return "connection-timeout";
  return "device-disconnected";
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(failure(), { code: "ETIMEDOUT" })), RPC_TIMEOUT_MS);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function failure(): Error { return new Error("The hardware device operation could not be confirmed."); }
