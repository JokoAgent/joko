import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import type {
  DesktopNativeGamepadBatteryState,
  DesktopNativeGamepadClientState,
  DesktopNativeGamepadDevice,
  DesktopNativeGamepadFamily,
  DesktopNativeGamepadSnapshot,
  DesktopNativeGamepadStatus,
  DesktopNativeGamepadTransport
} from "./channels.js";

const HELPER_NAME = "joko-macos-gamepad-helper";
const HELPER_MANIFEST = "manifest.json";
const MAXIMUM_HELPER_BYTES = 16 * 1024 * 1024;
const MAXIMUM_PROTOCOL_LINE_BYTES = 64 * 1024;
const HELPER_RESTART_LIMIT = 3;
const HELPER_RESTART_BASE_MS = 1_000;
const HELPER_STABLE_MS = 10_000;
const HELPER_STOP_TIMEOUT_MS = 1_000;
const HELPER_KILL_CONFIRM_TIMEOUT_MS = 1_000;
const GAMEPAD_FAMILIES = ["xbox", "playstation", "nintendo", "generic"] as const;
const HELPER_BUTTON_KEYS = [
  "a", "b", "x", "y", "lb", "rb", "lt", "rt", "view", "menu", "xbox", "ls", "rs",
  "dpadUp", "dpadDown", "dpadLeft", "dpadRight"
] as const;
const HELPER_AXIS_KEYS = ["lx", "ly", "rx", "ry"] as const;

interface NativeGamepadPresenceMessage {
  readonly kind: "presence";
  readonly present: boolean;
  readonly family: DesktopNativeGamepadFamily;
  readonly name: string | null;
  readonly category: string | null;
  readonly transport: DesktopNativeGamepadTransport;
  readonly batteryPercentage: number | null;
  readonly batteryState: DesktopNativeGamepadBatteryState;
}

interface NativeGamepadFrameMessage {
  readonly kind: "frame";
  readonly family: DesktopNativeGamepadFamily;
  readonly buttons: readonly number[];
  readonly axes: readonly number[];
}

interface NativeGamepadLogMessage {
  readonly kind: "log";
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
}

export type NativeGamepadHelperMessage =
  | NativeGamepadPresenceMessage
  | NativeGamepadFrameMessage
  | NativeGamepadLogMessage;

export interface NativeGamepadRuntimeOptions<Owner> {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly directory: string;
  readonly onSnapshot?: (snapshot: DesktopNativeGamepadSnapshot) => void;
  readonly spawnProcess?: (helperPath: string) => ChildProcessWithoutNullStreams;
}

export interface NativeGamepadRuntime<Owner> {
  readonly snapshot: () => DesktopNativeGamepadSnapshot;
  readonly clients: () => readonly Owner[];
  readonly setClientState: (owner: Owner, state: DesktopNativeGamepadClientState) => DesktopNativeGamepadSnapshot;
  readonly retireClient: (owner: Owner) => void;
  readonly probe: () => DesktopNativeGamepadSnapshot;
  readonly stop: () => Promise<void>;
  readonly recover: () => void;
  readonly dispose: () => Promise<void>;
}

/**
 * Owns one verified macOS helper and starts it only while at least one trusted
 * renderer declares enabled input or an active preview.
 */
export function createNativeGamepadRuntime<Owner>(
  options: NativeGamepadRuntimeOptions<Owner>
): NativeGamepadRuntime<Owner> {
  return new NativeGamepadRuntimeController(options);
}

export function resolveNativeGamepadDirectory(options: {
  readonly packaged: boolean;
  readonly resourcesPath: string;
  readonly sourceDirectory: string;
}): string {
  return resolve(options.packaged ? options.resourcesPath : options.sourceDirectory, "native-gamepad");
}

class NativeGamepadRuntimeController<Owner> implements NativeGamepadRuntime<Owner> {
  readonly #clients = new Map<Owner, DesktopNativeGamepadClientState>();
  readonly #devices = new Map<DesktopNativeGamepadFamily, DesktopNativeGamepadDevice>();
  readonly #onSnapshot: ((snapshot: DesktopNativeGamepadSnapshot) => void) | undefined;
  readonly #available: boolean;
  readonly #host: NativeGamepadHost | undefined;
  #interested = false;
  #suspended = false;
  #disposed = false;
  #disposal: Promise<void> | undefined;
  #snapshot: DesktopNativeGamepadSnapshot;

  constructor(options: NativeGamepadRuntimeOptions<Owner>) {
    this.#onSnapshot = options.onSnapshot;
    const resolveHelper = (): string | undefined => verifyNativeGamepadHelper({
      directory: options.directory,
      platform: options.platform,
      architecture: options.architecture
    });
    this.#available = options.platform === "darwin" && resolveHelper() !== undefined;
    this.#snapshot = frozenSnapshot(0, this.#available ? "idle" : "unavailable", []);
    if (this.#available) {
      this.#host = new NativeGamepadHost({
        resolveHelper,
        spawnProcess: options.spawnProcess,
        onStarted: () => this.#hostStarted(),
        onRestarting: () => this.#hostRestarting(),
        onFailure: () => this.#hostFailed(),
        onMessage: (message) => this.#handleMessage(message)
      });
    }
  }

  snapshot = (): DesktopNativeGamepadSnapshot => this.#snapshot;

  clients = (): readonly Owner[] => Object.freeze([...this.#clients.keys()]);

  setClientState = (owner: Owner, state: DesktopNativeGamepadClientState): DesktopNativeGamepadSnapshot => {
    if (this.#disposed) return this.#snapshot;
    this.#clients.set(owner, Object.freeze({ version: 1, enabled: state.enabled, preview: state.preview }));
    this.#reconcileInterest();
    return this.#snapshot;
  };

  retireClient = (owner: Owner): void => {
    if (!this.#clients.delete(owner) || this.#disposed) return;
    this.#reconcileInterest();
  };

  probe = (): DesktopNativeGamepadSnapshot => {
    if (!this.#disposed && !this.#suspended && this.#interested) this.#host?.probe();
    return this.#snapshot;
  };

  stop = async (): Promise<void> => {
    if (this.#disposed) {
      await this.#disposal;
      return;
    }
    this.#suspended = true;
    this.#devices.clear();
    this.#publish(this.#available ? "idle" : "unavailable");
    await this.#host?.stop();
  };

  recover = (): void => {
    if (this.#disposed || !this.#suspended) return;
    this.#suspended = false;
    if (!this.#interested) {
      this.#publish(this.#available ? "idle" : "unavailable");
      return;
    }
    if (this.#host === undefined) {
      this.#publish("unavailable");
      return;
    }
    this.#publish("starting");
    this.#host.start();
  };

  dispose = (): Promise<void> => {
    if (this.#disposal !== undefined) return this.#disposal;
    this.#disposed = true;
    this.#suspended = true;
    this.#clients.clear();
    this.#interested = false;
    this.#devices.clear();
    this.#publish(this.#available ? "idle" : "unavailable");
    this.#disposal = this.#host?.stop() ?? Promise.resolve();
    return this.#disposal;
  };

  #reconcileInterest(): void {
    const interested = [...this.#clients.values()].some((state) => state.enabled || state.preview);
    if (interested === this.#interested) return;
    this.#interested = interested;
    this.#devices.clear();
    if (this.#suspended) {
      this.#publish(this.#available ? "idle" : "unavailable");
      return;
    }
    if (!interested) {
      void this.#host?.stop().catch(() => {
        if (!this.#disposed && !this.#suspended && !this.#interested) this.#publish("error");
      });
      this.#publish(this.#available ? "idle" : "unavailable");
      return;
    }
    if (this.#host === undefined) {
      this.#publish("unavailable");
      return;
    }
    this.#publish("starting");
    this.#host.start();
  }

  #hostStarted(): void {
    if (!this.#interested || this.#suspended || this.#disposed) return;
    this.#devices.clear();
    this.#publish("waiting");
  }

  #hostRestarting(): void {
    if (!this.#interested || this.#suspended || this.#disposed) return;
    this.#devices.clear();
    this.#publish("starting");
  }

  #hostFailed(): void {
    if (!this.#interested || this.#suspended || this.#disposed) return;
    this.#devices.clear();
    this.#publish("error");
  }

  #handleMessage(message: NativeGamepadHelperMessage): void {
    if (!this.#interested || this.#suspended || this.#disposed || message.kind === "log") return;
    if (message.kind === "presence") {
      if (!message.present) {
        this.#devices.delete(message.family);
      } else {
        const previous = this.#devices.get(message.family);
        this.#devices.set(message.family, frozenDevice({
          family: message.family,
          name: message.name,
          category: message.category,
          transport: message.transport,
          batteryPercentage: message.batteryPercentage,
          batteryState: message.batteryState,
          buttons: previous?.buttons ?? zeroButtons(),
          axes: previous?.axes ?? zeroAxes()
        }));
      }
    } else {
      const previous = this.#devices.get(message.family);
      this.#devices.set(message.family, frozenDevice({
        family: message.family,
        name: previous?.name ?? null,
        category: previous?.category ?? null,
        transport: previous?.transport ?? "unknown",
        batteryPercentage: previous?.batteryPercentage ?? null,
        batteryState: previous?.batteryState ?? "unknown",
        buttons: message.buttons,
        axes: message.axes
      }));
    }
    this.#publish(this.#devices.size === 0 ? "waiting" : "connected");
  }

  #publish(status: DesktopNativeGamepadStatus): void {
    const devices = GAMEPAD_FAMILIES.flatMap((family) => {
      const device = this.#devices.get(family);
      return device === undefined ? [] : [device];
    });
    if (status === this.#snapshot.status && devicesEqual(devices, this.#snapshot.devices)) return;
    const revision = this.#snapshot.revision === Number.MAX_SAFE_INTEGER ? 1 : this.#snapshot.revision + 1;
    this.#snapshot = frozenSnapshot(revision, status, devices);
    try {
      this.#onSnapshot?.(this.#snapshot);
    } catch {
      // A renderer broadcaster cannot own or stop the native input lifetime.
    }
  }
}

interface NativeGamepadHostOptions {
  readonly resolveHelper: () => string | undefined;
  readonly spawnProcess?: (helperPath: string) => ChildProcessWithoutNullStreams;
  readonly onStarted: () => void;
  readonly onRestarting: () => void;
  readonly onFailure: (message: string) => void;
  readonly onMessage: (message: NativeGamepadHelperMessage) => void;
}

class NativeGamepadHost {
  readonly #options: NativeGamepadHostOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  readonly #retiringChildren = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  #wanted = false;
  #starting = false;
  #generation = 0;
  #restartAttempts = 0;
  #restartTimer: ReturnType<typeof setTimeout> | undefined;
  #stableTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: NativeGamepadHostOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#wanted) return;
    this.#generation += 1;
    this.#wanted = true;
    this.#restartAttempts = 0;
    this.#clearRestartTimer();
    this.#startChild();
  }

  probe(): void {
    if (!this.#wanted) return;
    if (this.#write(this.#child, "probe\n")) return;
    this.#restartAttempts = 0;
    this.#clearRestartTimer();
    this.#startChild();
  }

  stop(): Promise<void> {
    this.#generation += 1;
    this.#wanted = false;
    this.#starting = false;
    this.#restartAttempts = 0;
    this.#clearRestartTimer();
    this.#clearStableTimer();
    const child = this.#child;
    this.#child = undefined;
    if (child !== undefined) this.#retireChild(child, true);
    return Promise.all([...this.#retiringChildren.values()]).then(() => undefined);
  }

  #retireChild(child: ChildProcessWithoutNullStreams, graceful: boolean): Promise<void> {
    const existing = this.#retiringChildren.get(child);
    if (existing !== undefined) return existing;
    let confirmed = false;
    let settled = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let killConfirmationTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveRetirement!: () => void;
    let rejectRetirement!: (error: Error) => void;
    const retirement = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveRetirement = resolvePromise;
      rejectRetirement = rejectPromise;
    });
    this.#retiringChildren.set(child, retirement);
    const finishRetirement = (): void => {
      if (confirmed) return;
      confirmed = true;
      if (stopTimer !== undefined) clearTimeout(stopTimer);
      if (killConfirmationTimer !== undefined) clearTimeout(killConfirmationTimer);
      this.#retiringChildren.delete(child);
      if (!settled) {
        settled = true;
        resolveRetirement();
      }
      if (this.#wanted && this.#restartTimer === undefined) this.#startChild();
    };
    const failRetirement = (message: string): void => {
      if (confirmed || settled) return;
      settled = true;
      rejectRetirement(new Error(message));
    };
    child.once("exit", finishRetirement);
    child.once("close", finishRetirement);
    stopTimer = setTimeout(() => {
      let accepted = false;
      try { accepted = child.kill("SIGKILL"); } catch { /* The retirement fence remains owned below. */ }
      if (confirmed) return;
      if (!accepted) {
        failRetirement("Native gamepad helper could not be killed after its stop timeout.");
        return;
      }
      killConfirmationTimer = setTimeout(() => {
        failRetirement("Native gamepad helper did not confirm exit after SIGKILL.");
      }, HELPER_KILL_CONFIRM_TIMEOUT_MS);
    }, HELPER_STOP_TIMEOUT_MS);
    if (graceful) {
      try {
        if (!child.stdin.destroyed) {
          child.stdin.write("switch2-usb off\nstop\n");
          child.stdin.end();
        }
      } catch {
        // The bounded hard kill above still closes an already-failing helper.
      }
      return retirement;
    }
    try { child.kill(); } catch { /* The bounded hard kill above remains armed. */ }
    return retirement;
  }

  #startChild(): void {
    if (!this.#wanted || this.#starting || this.#child !== undefined ||
      this.#retiringChildren.size > 0 || this.#restartAttempts > HELPER_RESTART_LIMIT) return;
    this.#starting = true;
    const helperPath = this.#options.resolveHelper();
    if (helperPath === undefined) {
      this.#starting = false;
      this.#failed("Native gamepad helper admission failed.");
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (this.#options.spawnProcess ?? spawnNativeGamepadHelper)(helperPath);
    } catch (error) {
      this.#starting = false;
      this.#failed(error instanceof Error ? error.message : "Native gamepad helper spawn failed.");
      return;
    }
    this.#attach(child, this.#generation);
  }

  #attach(child: ChildProcessWithoutNullStreams, generation: number): void {
    this.#child = child;
    this.#starting = false;
    this.#clearStableTimer();
    this.#stableTimer = setTimeout(() => {
      if (this.#child === child) this.#restartAttempts = 0;
    }, HELPER_STABLE_MS);
    this.#stableTimer.unref?.();
    let buffer = "";
    let accounted = false;
    const fail = (message: string, alreadyExited = false): void => {
      if (accounted) return;
      accounted = true;
      if (generation !== this.#generation || this.#child !== child) return;
      if (this.#child === child) this.#child = undefined;
      this.#clearStableTimer();
      if (this.#wanted) this.#failed(message);
      if (!alreadyExited) void this.#retireChild(child, false).catch(() => undefined);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => {
      if (this.#child !== child) return;
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const rawLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(rawLine, "utf8") > MAXIMUM_PROTOCOL_LINE_BYTES) {
          buffer = "";
          fail("Native gamepad helper emitted an oversized protocol line.");
          return;
        }
        const line = rawLine.trim();
        if (line !== "") {
          const message = parseNativeGamepadHelperLine(line);
          if (message === undefined) {
            buffer = "";
            fail("Native gamepad helper emitted an invalid protocol message.");
            return;
          }
          this.#options.onMessage(message);
        }
        if (this.#child !== child) return;
        newline = buffer.indexOf("\n");
      }
      if (Buffer.byteLength(buffer, "utf8") > MAXIMUM_PROTOCOL_LINE_BYTES) {
        buffer = "";
        fail("Native gamepad helper exceeded the protocol buffer limit.");
      }
    });
    child.stdout.on("error", (error: Error) => fail(error.message));
    child.stderr.on("error", (error: Error) => fail(error.message));
    child.stderr.resume();
    child.stdin.on("error", (error: Error) => fail(error.message));
    child.on("error", (error: Error) => fail(error.message));
    child.once("exit", (code, signal) => {
      fail(`Native gamepad helper exited (${code ?? signal ?? "unknown"}).`, true);
    });
    child.once("close", (code, signal) => {
      fail(`Native gamepad helper closed (${code ?? signal ?? "unknown"}).`, true);
    });
    if (!this.#write(child, "switch2-usb on\n")) {
      fail("Native gamepad helper stdin is unavailable.");
      return;
    }
    this.#options.onStarted();
  }

  #write(child: ChildProcessWithoutNullStreams | undefined, line: string): boolean {
    if (child === undefined || child.stdin.destroyed || !child.stdin.writable) return false;
    try {
      child.stdin.write(line, (error) => {
        if (error !== null && error !== undefined && this.#child === child) {
          if (!child.killed) child.kill();
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  #failed(message: string): void {
    if (!this.#wanted) return;
    this.#options.onFailure(message);
    this.#restartAttempts += 1;
    if (this.#restartAttempts > HELPER_RESTART_LIMIT || this.#restartTimer !== undefined) return;
    const delay = HELPER_RESTART_BASE_MS * 2 ** (this.#restartAttempts - 1);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      if (!this.#wanted) return;
      this.#options.onRestarting();
      this.#startChild();
    }, delay);
    this.#restartTimer.unref?.();
  }

  #clearRestartTimer(): void {
    if (this.#restartTimer === undefined) return;
    clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
  }

  #clearStableTimer(): void {
    if (this.#stableTimer === undefined) return;
    clearTimeout(this.#stableTimer);
    this.#stableTimer = undefined;
  }
}

export function verifyNativeGamepadHelper(options: {
  readonly directory: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
}): string | undefined {
  if (options.platform !== "darwin" || (options.architecture !== "x64" && options.architecture !== "arm64")) {
    return undefined;
  }
  try {
    const directory = resolve(options.directory);
    const directoryInfo = lstatSync(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || realpathSync(directory) !== directory) {
      return undefined;
    }
    const entries = readdirSync(directory).sort();
    if (entries.length !== 2 || entries[0] !== HELPER_NAME || entries[1] !== HELPER_MANIFEST) return undefined;
    const manifestPath = resolve(directory, HELPER_MANIFEST);
    if (!regularFile(manifestPath, 4_096)) return undefined;
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!exactRecord(manifest, ["architecture", "helper", "platform", "protocolVersion", "sha256"]) ||
      manifest.architecture !== options.architecture || manifest.helper !== HELPER_NAME || manifest.platform !== "darwin" ||
      manifest.protocolVersion !== 1 || typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(manifest.sha256)) {
      return undefined;
    }
    const helperPath = resolve(directory, HELPER_NAME);
    if (!regularExecutableFile(helperPath, MAXIMUM_HELPER_BYTES)) return undefined;
    const helperBytes = readFileSync(helperPath);
    if (!isTargetMachOExecutable(helperBytes, options.architecture)) return undefined;
    const digest = createHash("sha256").update(helperBytes).digest("hex");
    return digest === manifest.sha256 ? helperPath : undefined;
  } catch {
    return undefined;
  }
}

export function parseNativeGamepadHelperLine(line: string): NativeGamepadHelperMessage | undefined {
  if (Buffer.byteLength(line, "utf8") > MAXIMUM_PROTOCOL_LINE_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!record(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "presence") return parsePresence(value);
  if (value.kind === "frame") return parseFrame(value);
  if (value.kind === "log") return parseLog(value);
  return undefined;
}

function parsePresence(value: Record<string, unknown>): NativeGamepadPresenceMessage | undefined {
  if (value.present === false) {
    if (!exactRecord(value, ["kind", "present", "family"]) || !isFamily(value.family)) return undefined;
    return Object.freeze({
      kind: "presence", present: false, family: value.family, name: null, category: null,
      transport: "unknown", batteryPercentage: null, batteryState: "unknown"
    });
  }
  const keys = value.batteryPercentage === undefined
    ? ["kind", "present", "name", "category", "family", "transport", "batteryState"]
    : ["kind", "present", "name", "category", "family", "transport", "batteryPercentage", "batteryState"];
  if (!exactRecord(value, keys) || value.present !== true || !isFamily(value.family) ||
    !boundedHelperText(value.name, 512) || !boundedHelperText(value.category, 512) ||
    !isTransport(value.transport) || !isBatteryState(value.batteryState) ||
    (value.batteryPercentage !== undefined && (typeof value.batteryPercentage !== "number" ||
      !Number.isInteger(value.batteryPercentage) || value.batteryPercentage < 0 || value.batteryPercentage > 100))) {
    return undefined;
  }
  return Object.freeze({
    kind: "presence",
    present: true,
    family: value.family,
    name: value.name,
    category: value.category,
    transport: value.transport,
    batteryPercentage: value.batteryPercentage === undefined ? null : value.batteryPercentage,
    batteryState: value.batteryState
  });
}

function parseFrame(value: Record<string, unknown>): NativeGamepadFrameMessage | undefined {
  if (!exactRecord(value, ["kind", "family", "buttons", "axes", "ltAnalog", "rtAnalog"]) ||
    !isFamily(value.family) || !exactRecord(value.buttons, HELPER_BUTTON_KEYS) ||
    !exactRecord(value.axes, HELPER_AXIS_KEYS) || !unitValue(value.ltAnalog, 0, 1) ||
    !unitValue(value.rtAnalog, 0, 1)) return undefined;
  const buttonRecord = value.buttons;
  const axisRecord = value.axes;
  for (const key of HELPER_BUTTON_KEYS) if (typeof buttonRecord[key] !== "boolean") return undefined;
  for (const key of HELPER_AXIS_KEYS) if (!unitValue(axisRecord[key], -1, 1)) return undefined;
  const pressed = (key: typeof HELPER_BUTTON_KEYS[number]): number => buttonRecord[key] ? 1 : 0;
  const buttons = Object.freeze([
    pressed("a"), pressed("b"), pressed("x"), pressed("y"), pressed("lb"), pressed("rb"),
    value.ltAnalog, value.rtAnalog, pressed("view"), pressed("menu"), pressed("ls"), pressed("rs"),
    pressed("dpadUp"), pressed("dpadDown"), pressed("dpadLeft"), pressed("dpadRight"), pressed("xbox")
  ]);
  const invert = (axis: number): number => axis === 0 ? 0 : -axis;
  const axes = Object.freeze([
    axisRecord.lx as number,
    invert(axisRecord.ly as number),
    axisRecord.rx as number,
    invert(axisRecord.ry as number)
  ]);
  return Object.freeze({ kind: "frame", family: value.family, buttons, axes });
}

function parseLog(value: Record<string, unknown>): NativeGamepadLogMessage | undefined {
  if (!exactRecord(value, ["kind", "level", "message"]) ||
    (value.level !== "debug" && value.level !== "info" && value.level !== "warn" && value.level !== "error") ||
    !boundedHelperText(value.message, 4_096)) return undefined;
  return Object.freeze({ kind: "log", level: value.level, message: value.message });
}

function spawnNativeGamepadHelper(helperPath: string): ChildProcessWithoutNullStreams {
  return spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

function frozenSnapshot(
  revision: number,
  status: DesktopNativeGamepadStatus,
  devices: readonly DesktopNativeGamepadDevice[]
): DesktopNativeGamepadSnapshot {
  return Object.freeze({ version: 1, revision, status, devices: Object.freeze([...devices]) });
}

function frozenDevice(device: DesktopNativeGamepadDevice): DesktopNativeGamepadDevice {
  return Object.freeze({
    ...device,
    buttons: Object.freeze([...device.buttons]),
    axes: Object.freeze([...device.axes])
  });
}

function zeroButtons(): readonly number[] {
  return Object.freeze(Array<number>(17).fill(0));
}

function zeroAxes(): readonly number[] {
  return Object.freeze(Array<number>(4).fill(0));
}

function devicesEqual(left: readonly DesktopNativeGamepadDevice[], right: readonly DesktopNativeGamepadDevice[]): boolean {
  return left.length === right.length && left.every((device, index) => {
    const other = right[index];
    return other !== undefined && device.family === other.family && device.name === other.name &&
      device.category === other.category && device.transport === other.transport &&
      device.batteryPercentage === other.batteryPercentage && device.batteryState === other.batteryState &&
      numberArraysEqual(device.buttons, other.buttons) && numberArraysEqual(device.axes, other.axes);
  });
}

function numberArraysEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function regularFile(path: string, maximumBytes: number): boolean {
  const info = lstatSync(path);
  return info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maximumBytes && realpathSync(path) === path;
}

function regularExecutableFile(path: string, maximumBytes: number): boolean {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 32 || info.size > maximumBytes ||
    realpathSync(path) !== path) return false;
  accessSync(path, fsConstants.X_OK);
  return true;
}

function isTargetMachOExecutable(bytes: Buffer, architecture: string): boolean {
  const cpu = architecture === "x64" ? 0x0100_0007 : architecture === "arm64" ? 0x0100_000c : undefined;
  if (cpu === undefined || bytes.length < 8) return false;
  const magic = bytes.subarray(0, 4).toString("hex");
  if (magic === "cffaedfe") return isThinMachOExecutable(bytes, cpu, "little");
  if (magic === "feedfacf") return isThinMachOExecutable(bytes, cpu, "big");
  const fat = magic === "cafebabe" ? { endian: "big" as const, entryBytes: 20 }
    : magic === "bebafeca" ? { endian: "little" as const, entryBytes: 20 }
      : magic === "cafebabf" ? { endian: "big" as const, entryBytes: 32 }
        : magic === "bfbafeca" ? { endian: "little" as const, entryBytes: 32 }
          : undefined;
  if (fat === undefined) return false;
  const count = readMachOUint32(bytes, 4, fat.endian);
  if (count === undefined || count < 1 || count > 16 || 8 + count * fat.entryBytes > bytes.length) return false;
  for (let index = 0; index < count; index += 1) {
    const entry = 8 + index * fat.entryBytes;
    if (readMachOUint32(bytes, entry, fat.endian) !== cpu) continue;
    const offset = fat.entryBytes === 20
      ? readMachOUint32(bytes, entry + 8, fat.endian)
      : readMachOUint64(bytes, entry + 8, fat.endian);
    const size = fat.entryBytes === 20
      ? readMachOUint32(bytes, entry + 12, fat.endian)
      : readMachOUint64(bytes, entry + 16, fat.endian);
    if (offset === undefined || size === undefined || size < 32 || offset > bytes.length - size) return false;
    if (isThinMachOExecutable(bytes.subarray(offset, offset + size), cpu)) return true;
  }
  return false;
}

function isThinMachOExecutable(
  bytes: Buffer,
  cpu: number,
  expectedEndian?: "little" | "big"
): boolean {
  if (bytes.length < 32) return false;
  const magic = bytes.subarray(0, 4).toString("hex");
  const endian = magic === "cffaedfe" ? "little" : magic === "feedfacf" ? "big" : undefined;
  if (endian === undefined || (expectedEndian !== undefined && endian !== expectedEndian)) return false;
  const declaredCpu = readMachOUint32(bytes, 4, endian);
  const fileType = readMachOUint32(bytes, 12, endian);
  const commandCount = readMachOUint32(bytes, 16, endian);
  const commandBytes = readMachOUint32(bytes, 20, endian);
  return declaredCpu === cpu && fileType === 2 && commandCount !== undefined && commandBytes !== undefined &&
    commandCount <= 16_384 && commandBytes <= bytes.length - 32;
}

function readMachOUint32(bytes: Buffer, offset: number, endian: "little" | "big"): number | undefined {
  if (offset < 0 || offset > bytes.length - 4) return undefined;
  return endian === "little" ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
}

function readMachOUint64(bytes: Buffer, offset: number, endian: "little" | "big"): number | undefined {
  if (offset < 0 || offset > bytes.length - 8) return undefined;
  const value = endian === "little" ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!record(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function boundedHelperText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}

function unitValue(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isFamily(value: unknown): value is DesktopNativeGamepadFamily {
  return value === "xbox" || value === "playstation" || value === "nintendo" || value === "generic";
}

function isTransport(value: unknown): value is DesktopNativeGamepadTransport {
  return value === "usb" || value === "bluetooth" || value === "unknown";
}

function isBatteryState(value: unknown): value is DesktopNativeGamepadBatteryState {
  return value === "unknown" || value === "discharging" || value === "charging" || value === "full";
}
