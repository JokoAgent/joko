import { DEDICATED_HARDWARE_KEYMAP_MAX_BYTES } from "./keymap-controller.js";
import type { DedicatedHardwareInputEvent } from "./protocol.js";
import {
  DEDICATED_HARDWARE_PHYSICAL_KEYS,
  type DedicatedHardwarePhysicalKey
} from "./settings.js";

export interface CompactHardwareCommunication {
  parseRpcData(data: string): boolean;
  rpcResponse?: string;
}

const MAX_RPC_BYTES = 2 * DEDICATED_HARDWARE_KEYMAP_MAX_BYTES + 4096;
const ENCODER_KEYS = ["ENC", "ENC_CLK", "ENC_CW", "ENC_CC"];

export function createDedicatedHardwareNotificationCodec(options: {
  readonly resolvePhysicalKey: (wire: DedicatedHardwarePhysicalKey) => DedicatedHardwarePhysicalKey | undefined;
}): {
  readonly hid: (value: unknown) => DedicatedHardwareInputEvent | undefined;
  readonly joystick: (value: unknown) => DedicatedHardwareInputEvent | undefined;
  readonly reset: () => void;
} {
  let encoderPressed = false;
  return Object.freeze({
    hid: (value: unknown): DedicatedHardwareInputEvent | undefined => {
      if (!exact(value, ["key", "act"]) || typeof value.key !== "string" || !isAct(value.act)) return undefined;
      if (ENCODER_KEYS.includes(value.key)) {
        if (value.act === 2) {
          if (value.key !== "ENC_CW" && value.key !== "ENC_CC") return undefined;
          return { kind: "encoder", delta: value.key === "ENC_CW" ? 1 : -1, pressed: encoderPressed };
        }
        encoderPressed = value.act === 1;
        return { kind: "encoder", delta: 0, pressed: encoderPressed };
      }
      if (!isPhysicalKey(value.key) || value.act === 2) return undefined;
      const physical = options.resolvePhysicalKey(value.key);
      if (physical === undefined || !isPhysicalKey(physical)) return undefined;
      return { kind: "key", key: physical, pressed: value.act === 1 };
    },
    joystick: (value: unknown): DedicatedHardwareInputEvent | undefined => {
      if (!exact(value, ["angle", "distance"]) || !unit(value.angle) || !unit(value.distance)) return undefined;
      if (value.distance === 0) return { kind: "stick", x: 0, y: 0, pressed: false };
      const radians = value.angle * 2 * Math.PI;
      return {
        kind: "stick", x: Math.cos(radians) * value.distance,
        y: Math.sin(radians) * value.distance, pressed: true
      };
    },
    reset: () => { encoderPressed = false; }
  });
}

/** Decorates one owned SDK connection; its original RPC parser retains framing and response ownership. */
export function installCompactHardwareNotifications(comm: CompactHardwareCommunication): () => void {
  if (!record(comm) || typeof comm.parseRpcData !== "function") {
    throw new TypeError("The hardware communication parser is unavailable.");
  }
  const original = comm.parseRpcData;
  const decorated = function(this: CompactHardwareCommunication, data: string): boolean {
    const pending = this.rpcResponse === undefined ? "" : this.rpcResponse;
    if (!bounded(pending) || !bounded(data) ||
        pending.length + data.length > MAX_RPC_BYTES ||
        new TextEncoder().encode(pending).byteLength + new TextEncoder().encode(data).byteLength > MAX_RPC_BYTES) {
      this.rpcResponse = "";
      throw new TypeError("The hardware communication frame exceeds its size boundary.");
    }
    const start = pending.length === 0 ? data.indexOf("{") : -1;
    const combined = pending.length === 0 ? (start < 0 ? data : data.slice(start)) : pending + data;
    const rewritten = compactNotification(combined);
    if (rewritten !== undefined) {
      this.rpcResponse = "";
      return original.call(this, rewritten);
    }
    return original.call(this, data);
  };
  comm.parseRpcData = decorated;
  return () => { if (comm.parseRpcData === decorated) comm.parseRpcData = original; };
}

function compactNotification(data: string): string | undefined {
  let value: unknown;
  try { value = JSON.parse(data); } catch { return undefined; }
  if (exact(value, ["k", "act"]) && typeof value.k === "string" &&
      (isPhysicalKey(value.k) || ENCODER_KEYS.includes(value.k)) && isAct(value.act)) {
    return JSON.stringify({ method: "v.oai.hid", params: { k: value.k, act: value.act } });
  }
  if (exact(value, ["a", "d"]) && unit(value.a) && unit(value.d)) {
    return JSON.stringify({ method: "v.oai.rad", params: { a: value.a, d: value.d } });
  }
  return undefined;
}

function bounded(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_RPC_BYTES;
}

function isPhysicalKey(value: string): value is DedicatedHardwarePhysicalKey {
  return (DEDICATED_HARDWARE_PHYSICAL_KEYS as readonly string[]).includes(value);
}

function isAct(value: unknown): value is 0 | 1 | 2 {
  return value === 0 || value === 1 || value === 2;
}

function unit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}
