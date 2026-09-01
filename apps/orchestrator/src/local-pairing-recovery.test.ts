import { describe, expect, it } from "vitest";

import { needsLocalPairingRecovery } from "./local-pairing-recovery.js";

function store(input: {
  readonly connections: ReadonlyArray<{ readonly id: string; readonly deviceId: string; readonly state: "active" | "revoked" }>;
  readonly devices?: Readonly<Record<string, "active" | "revoked">>;
}) {
  return {
    listConnections: () => input.connections,
    getDevice: (id: string) => {
      const state = input.devices?.[id];
      if (state === undefined) throw new Error("Device not found");
      return { id, state };
    }
  } as never;
}

describe("local pairing recovery", () => {
  it("opens recovery for a fresh store and when all credential history is revoked", () => {
    expect(needsLocalPairingRecovery(store({ connections: [] }))).toBe(true);
    expect(needsLocalPairingRecovery(store({
      connections: [
        { id: "old-a", deviceId: "device-a", state: "revoked" },
        { id: "old-b", deviceId: "device-b", state: "revoked" }
      ],
      devices: { "device-a": "revoked", "device-b": "active" }
    }))).toBe(true);
  });

  it("requires both an active credential and its active durable Device", () => {
    expect(needsLocalPairingRecovery(store({
      connections: [{ id: "connection-a", deviceId: "device-a", state: "active" }],
      devices: { "device-a": "active" }
    }))).toBe(false);
    expect(needsLocalPairingRecovery(store({
      connections: [{ id: "connection-a", deviceId: "device-a", state: "active" }],
      devices: { "device-a": "revoked" }
    }))).toBe(true);
  });

  it("keeps pairing closed while any one-to-many Device credential remains usable", () => {
    expect(needsLocalPairingRecovery(store({
      connections: [
        { id: "connection-old", deviceId: "device-a", state: "revoked" },
        { id: "connection-current", deviceId: "device-a", state: "active" }
      ],
      devices: { "device-a": "active" }
    }))).toBe(false);
  });
});
