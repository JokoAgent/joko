import { randomUUID } from "node:crypto";

export interface HostedAgentLimits { readonly perDevice: number; readonly total: number }
export const DEFAULT_HOSTED_AGENT_LIMITS: HostedAgentLimits = Object.freeze({ perDevice: 16, total: 64 });
export interface HostedAgentSlot {
  readonly id: string;
  /** Called by the actual native-process owner only after it confirms closure. */
  release(): void;
}
export class HostedAgentLimitError extends Error {
  constructor(readonly scope: "device" | "total") { super("The computer has reached its hosted Agent session limit."); }
}
export function validateHostedAgentLimits(value: HostedAgentLimits): HostedAgentLimits {
  if (!Number.isSafeInteger(value.perDevice) || !Number.isSafeInteger(value.total)
    || value.perDevice < 1 || value.total < 1 || value.perDevice > 1000 || value.total > 1000 || value.perDevice > value.total) {
    throw new Error("Hosted Agent limits must be integers from 1 to 1000 with the device limit no greater than the total.");
  }
  return { perDevice: value.perDevice, total: value.total };
}

/** One counter shared by owner, guest, relay and child runtimes. A lower limit
 * affects new admissions and never terminates sessions already admitted. */
export class HostedAgentSessionSlots {
  readonly #readLimits: () => HostedAgentLimits;
  readonly #slots = new Map<string, string>();
  readonly #devices = new Map<string, number>();
  constructor(readLimits: () => HostedAgentLimits = () => DEFAULT_HOSTED_AGENT_LIMITS) { this.#readLimits = readLimits; }
  reserve(sourceDeviceId: string): HostedAgentSlot {
    if (!sourceDeviceId || sourceDeviceId.length > 1024 || /[\0\r\n]/u.test(sourceDeviceId)) throw new Error("Hosted Agent source device is invalid.");
    const limits = validateHostedAgentLimits(this.#readLimits()), current = this.#devices.get(sourceDeviceId) ?? 0;
    if (current >= limits.perDevice) throw new HostedAgentLimitError("device");
    if (this.#slots.size >= limits.total) throw new HostedAgentLimitError("total");
    const id = randomUUID(); this.#slots.set(id, sourceDeviceId); this.#devices.set(sourceDeviceId, current + 1);
    return { id, release: () => {
      if (this.#slots.get(id) !== sourceDeviceId) return;
      this.#slots.delete(id); const count = (this.#devices.get(sourceDeviceId) ?? 1) - 1;
      if (count === 0) this.#devices.delete(sourceDeviceId); else this.#devices.set(sourceDeviceId, count);
    } };
  }
  usage(sourceDeviceId: string): { readonly device: number; readonly total: number; readonly limits: HostedAgentLimits } {
    return { device: this.#devices.get(sourceDeviceId) ?? 0, total: this.#slots.size, limits: validateHostedAgentLimits(this.#readLimits()) };
  }
  summary(): { readonly total: number; readonly devices: number; readonly maximumDevice: number } {
    return { total: this.#slots.size, devices: this.#devices.size, maximumDevice: Math.max(0, ...this.#devices.values()) };
  }
}
