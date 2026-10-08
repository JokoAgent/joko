import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { createDedicatedHardwareLightingRuntime } from "./lighting-runtime.js";
import type { DedicatedHardwareLightingState, DedicatedHardwareUtilityDeviceSnapshot } from "./protocol.js";
import { cloneDedicatedHardwareSettings, type DedicatedHardwareModelId, type DedicatedHardwareSettings } from "./settings.js";
import type { DedicatedHardwareUtilityAdapter, DedicatedHardwareUtilityAdapterSink } from "./utility-handler.js";
import { createDedicatedHardwareNotificationCodec } from "./vendor-notifications.js";

const MODEL = "codex-micro";
const EMPTY_LIGHTING: DedicatedHardwareLightingState = {
  version: 1, taskSlots: [null, null, null, null, null, null], revealOccurrence: "0", primaryVisible: false
};
const MAX_LINE_BYTES = 65_536;

interface Helper {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
}

/** USB-only Micro transport. The helper owns HID framing, retries, and lights-off on exit. */
export function createDedicatedHardwareNativeUsbAdapter(options: {
  readonly executablePath: string;
  readonly sink: DedicatedHardwareUtilityAdapterSink;
  readonly spawnHelper?: (path: string) => ChildProcessWithoutNullStreams;
  readonly onFatalError?: () => void;
}): DedicatedHardwareUtilityAdapter {
  let active: Helper | undefined;
  let settings: DedicatedHardwareSettings | undefined;
  let lightingState = EMPTY_LIGHTING;
  let closed = false;
  let state = snapshot(MODEL, "disabled");
  let settle: (() => void) | undefined;
  const codec = createDedicatedHardwareNotificationCodec({ resolvePhysicalKey: key => key });
  const lighting = createDedicatedHardwareLightingRuntime({
    apply: async (frame, signal) => {
      if (signal.aborted || active === undefined || state.status !== "connected") return;
      await send(active, { kind: "apply", frame });
    },
    onApplyFailure: () => { if (active !== undefined) fail(active); }
  });
  lighting.pause();

  function publish(next: DedicatedHardwareUtilityDeviceSnapshot): void {
    state = next;
    if (state.status === "connected" && settings?.enabled === true) lighting.resume();
    else { lighting.pause(); codec.reset(); }
    options.sink.publishState(state);
  }

  function receive(message: unknown): void {
    if (!record(message) || typeof message.kind !== "string") return;
    switch (message.kind) {
      case "presence":
        if (typeof message.present !== "boolean") return;
        state = { ...state, devicePresent: message.present };
        if (settings?.enabled !== true) {
          publish({ ...state, status: "disabled", reason: null });
          settle?.();
        }
        break;
      case "device": {
        if (!record(message.device) || message.device.deviceType !== MODEL || message.device.isUsbConnection !== true) return;
        const device = message.device;
        state = { ...state, devicePresent: true, transport: "usb",
          firmwareVersion: typeof device.firmwareVersion === "string" && device.firmwareVersion.length > 0 &&
            device.firmwareVersion.length <= 128 && device.firmwareVersion.trim() === device.firmwareVersion &&
            !/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(device.firmwareVersion)
            ? device.firmwareVersion : null,
          batteryPercent: typeof device.batteryPercentage === "number" && Number.isFinite(device.batteryPercentage) &&
            device.batteryPercentage >= 0 && device.batteryPercentage <= 100 ? Math.round(device.batteryPercentage) : null,
          charging: typeof device.isCharging === "boolean" ? device.isCharging : null };
        break;
      }
      case "state":
        if (settings?.enabled !== true) return;
        if (message.status === "connected") publish({ ...state, status: "connected", reason: null, devicePresent: true, transport: "usb" });
        else if (message.status === "not-detected") publish(snapshot(MODEL, "not-detected", false));
        else if (message.status === "error") publish({ ...snapshot(MODEL, "error"), reason: "device-disconnected" });
        else return;
        settle?.();
        break;
      case "activity":
        if (state.status === "connected") lighting.physicalActivity();
        break;
      case "hid":
      case "joystick": {
        if (settings?.enabled !== true || state.status !== "connected") return;
        const input = message.kind === "hid"
          ? codec.hid(message.event)
          : codec.joystick(message.event);
        if (input !== undefined) options.sink.publishInput(MODEL, input);
        break;
      }
    }
  }

  function start(): Helper {
    if (closed) throw new Error("The native USB adapter is closed.");
    if (active !== undefined) return active;
    const child = (options.spawnHelper ?? (path => spawn(path, [], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true
    })))(options.executablePath);
    let finish!: () => void;
    const helper: Helper = { child, exited: new Promise<void>(resolve => { finish = resolve; }) };
    active = helper;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (active !== helper || closed) return;
      buffer += chunk;
      let boundary: number;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) { fail(helper); return; }
        try { receive(JSON.parse(line)); } catch { /* Ignore malformed device-host output. */ }
        if (active !== helper) return;
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) fail(helper);
    });
    child.stderr.resume();
    child.stdin.on("error", () => fail(helper));
    child.on("error", () => { fail(helper); finish(); });
    child.on("exit", () => { fail(helper); finish(); });
    return helper;
  }

  function fail(helper: Helper): void {
    if (active !== helper) return;
    active = undefined;
    helper.child.kill();
    publish({ ...snapshot(MODEL, settings?.enabled === true ? "error" : "disabled"),
      reason: settings?.enabled === true ? "host-crash" : null });
    settle?.();
    if (!closed) options.onFatalError?.();
  }

  async function send(helper: Helper, message: unknown): Promise<void> {
    if (active !== helper) throw new Error("The native USB helper has stopped.");
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES || helper.child.stdin.writableLength > MAX_LINE_BYTES) {
      fail(helper);
      throw new Error("The native USB helper queue is full.");
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The native USB helper write timed out.")), 1000);
      helper.child.stdin.write(line, error => {
        clearTimeout(timer);
        if (error !== undefined && error !== null) reject(error); else resolve();
      });
    });
  }

  async function stopHelper(): Promise<void> {
    const helper = active;
    if (helper === undefined) return;
    active = undefined; // Fence old output before yielding; no release may reach a new session.
    lighting.pause();
    codec.reset();
    settle?.();
    helper.child.stdin.end(`${JSON.stringify({ kind: "stop" })}\n`);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([helper.exited, new Promise<void>(resolve => {
      timer = setTimeout(() => { helper.child.kill(); resolve(); }, 1000);
    })]);
    if (timer !== undefined) clearTimeout(timer);
  }

  async function probe(): Promise<DedicatedHardwareUtilityDeviceSnapshot> {
    const helper = start();
    let timer: NodeJS.Timeout | undefined;
    const response = new Promise<void>(resolve => {
      settle = resolve;
      timer = setTimeout(() => {
        if (active === helper) {
          publish({ ...snapshot(MODEL, settings?.enabled === true ? "error" : "disabled"),
            reason: settings?.enabled === true ? "connection-timeout" : null });
        }
        resolve();
      }, 4500);
    });
    try {
      if (settings?.enabled === true) await send(helper, { kind: "listen" });
      await send(helper, { kind: settings?.enabled === true ? "probe" : "discover" });
      await response;
      return { ...state };
    } catch {
      fail(helper);
      return { ...state };
    } finally {
      clearTimeout(timer);
      settle = undefined;
      if (settings?.enabled !== true) await stopHelper();
    }
  }

  const unavailableKeymap = async (): Promise<never> => {
    throw new Error("Creator keymaps require the device SDK.");
  };
  return {
    creatorKeymap: {
      readDeviceFirmwareIdentity: unavailableKeymap, readCurrent: unavailableKeymap,
      buildManaged: () => { throw new Error("Creator keymaps require the device SDK."); },
      writeCurrent: unavailableKeymap, reload: unavailableKeymap
    },
    async setDesiredState(model, desired) {
      if (model !== MODEL) return snapshot(model, desired.settings.enabled ? "unavailable" : "disabled");
      settings = cloneDedicatedHardwareSettings(desired.settings);
      lighting.update(settings, lightingState);
      if (!settings.enabled) {
        await stopHelper();
        publish(snapshot(MODEL, "disabled"));
        return { ...state };
      }
      if (state.status === "connected" && active !== undefined) return { ...state };
      publish(snapshot(MODEL, "connecting"));
      return probe();
    },
    setLightingState(model, next) {
      if (model !== MODEL || closed) return;
      lightingState = next;
      if (settings !== undefined) lighting.update(settings, next);
    },
    probe: async model => model === MODEL ? probe() : snapshot(model, "unavailable"),
    async stop() {
      if (closed) return;
      closed = true;
      lighting.close();
      await stopHelper();
    }
  };
}

function snapshot(model: DedicatedHardwareModelId, status: DedicatedHardwareUtilityDeviceSnapshot["status"],
  present: boolean | null = null): DedicatedHardwareUtilityDeviceSnapshot {
  return { model, status, reason: status === "unavailable" ? "sdk-unavailable" : null,
    devicePresent: present, transport: null, firmwareVersion: null, batteryPercent: null,
    charging: null, inputPermission: "not-required", keymapDeviceFirmwareIdentity: null };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
