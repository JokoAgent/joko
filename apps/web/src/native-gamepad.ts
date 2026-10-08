import type {
  GamepadDeviceBatteryState, GamepadDeviceFamily, GamepadDeviceTransport, GamepadSample
} from "./gamepad-input.js";

export const NATIVE_GAMEPAD_STATUSES = ["idle", "starting", "waiting", "connected", "unavailable", "error"] as const;
export type NativeGamepadStatus = (typeof NATIVE_GAMEPAD_STATUSES)[number];

export interface NativeGamepadDeviceSnapshot {
  readonly family: GamepadDeviceFamily;
  readonly name: string | null;
  readonly category: string | null;
  readonly transport: GamepadDeviceTransport;
  readonly batteryPercentage: number | null;
  readonly batteryState: GamepadDeviceBatteryState;
  readonly buttons: readonly number[];
  readonly axes: readonly number[];
}

export interface NativeGamepadSnapshot {
  readonly version: 1;
  readonly revision: number;
  readonly status: NativeGamepadStatus;
  readonly devices: readonly NativeGamepadDeviceSnapshot[];
}

export interface NativeGamepadClientState {
  readonly version: 1;
  readonly enabled: boolean;
  readonly preview: boolean;
}

export interface NativeGamepadBridge {
  getSnapshot(): Promise<unknown>;
  setClientState(state: NativeGamepadClientState): Promise<unknown>;
  probe(): Promise<unknown>;
  onSnapshot(listener: (value: unknown) => void): () => void;
}

const FAMILIES = ["xbox", "playstation", "nintendo", "generic"] as const;
const TRANSPORTS = ["usb", "bluetooth", "unknown"] as const;
const BATTERY_STATES = ["unknown", "discharging", "charging", "full"] as const;
const MAX_DEVICE_TEXT_LENGTH = 512;

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function boundedDeviceText(value: unknown): value is string | null {
  return value === null || typeof value === "string" && value.length <= MAX_DEVICE_TEXT_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function finiteArray(value: unknown, length: number, minimum: number, maximum: number): value is number[] {
  return Array.isArray(value) && value.length === length
    && value.every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= minimum && entry <= maximum);
}

function parseDevice(value: unknown): NativeGamepadDeviceSnapshot | undefined {
  if (!exactRecord(value, ["family", "name", "category", "transport", "batteryPercentage", "batteryState", "buttons", "axes"])
    || !(FAMILIES as readonly unknown[]).includes(value.family)
    || !boundedDeviceText(value.name) || !boundedDeviceText(value.category)
    || !(TRANSPORTS as readonly unknown[]).includes(value.transport)
    || value.batteryPercentage !== null && (typeof value.batteryPercentage !== "number"
      || !Number.isInteger(value.batteryPercentage) || value.batteryPercentage < 0 || value.batteryPercentage > 100)
    || !(BATTERY_STATES as readonly unknown[]).includes(value.batteryState)
    || !finiteArray(value.buttons, 17, 0, 1) || !finiteArray(value.axes, 4, -1, 1)) return undefined;
  return {
    family: value.family as GamepadDeviceFamily,
    name: value.name,
    category: value.category,
    transport: value.transport as GamepadDeviceTransport,
    batteryPercentage: value.batteryPercentage,
    batteryState: value.batteryState as GamepadDeviceBatteryState,
    buttons: [...value.buttons],
    axes: [...value.axes]
  };
}

/** The preload boundary remains untrusted even though it is context-isolated. */
export function parseNativeGamepadSnapshot(value: unknown): NativeGamepadSnapshot | undefined {
  if (!exactRecord(value, ["version", "revision", "status", "devices"])
    || value.version !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || !(NATIVE_GAMEPAD_STATUSES as readonly unknown[]).includes(value.status)
    || !Array.isArray(value.devices) || value.devices.length > FAMILIES.length) return undefined;
  const devices = value.devices.map(parseDevice);
  if (devices.some((device) => device === undefined)) return undefined;
  const parsed = devices as NativeGamepadDeviceSnapshot[];
  if (new Set(parsed.map((device) => device.family)).size !== parsed.length) return undefined;
  return { version: 1, revision: value.revision as number, status: value.status as NativeGamepadStatus, devices: parsed };
}

/** Native frames already use the product's 17-button / four-axis semantic order. */
export function nativeGamepadSamples(snapshot: NativeGamepadSnapshot): readonly GamepadSample[] {
  if (snapshot.status !== "connected") return [];
  return snapshot.devices.map((device) => ({
    index: FAMILIES.indexOf(device.family),
    id: `native:${device.family}:${device.transport}:${device.name ?? ""}:${device.category ?? ""}`.slice(0, MAX_DEVICE_TEXT_LENGTH),
    mapping: "standard",
    connected: true,
    buttons: device.buttons.map((value) => ({ value, pressed: value >= 0.55, touched: value > 0 })),
    axes: [...device.axes],
    source: "native",
    family: device.family,
    name: device.name,
    category: device.category,
    transport: device.transport,
    batteryPercentage: device.batteryPercentage,
    batteryState: device.batteryState
  }));
}
