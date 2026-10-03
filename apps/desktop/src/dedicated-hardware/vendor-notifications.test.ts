import { describe, expect, it } from "vitest";

import { createDedicatedHardwareNotificationCodec, installCompactHardwareNotifications } from "./vendor-notifications.js";

describe("dedicated hardware notification codec", () => {
  it("translates only current callback keys through the confirmed physical mapping", () => {
    const codec = createDedicatedHardwareNotificationCodec({
      resolvePhysicalKey: (wire) => wire === "AG01" ? "ACT07" : undefined
    });
    expect(codec.hid({ key: "AG01", act: 1 })).toEqual({ kind: "key", key: "ACT07", pressed: true });
    expect(codec.hid({ key: "AG01", act: 0 })).toEqual({ kind: "key", key: "ACT07", pressed: false });
    for (const value of [
      { key: "AG00", act: 1 }, { key: "AG06", act: 1 }, { key: "AG01", act: 2 },
      { k: "AG01", act: 1 }, { key: "AG01" }, { key: "AG01", act: "1" },
      { key: "AG01", act: 1, agent: 0 }, null
    ]) expect(codec.hid(value)).toBeUndefined();
  });

  it("keeps the encoder held while rotating and clears only its button state on reset", () => {
    const codec = createDedicatedHardwareNotificationCodec({ resolvePhysicalKey: (wire) => wire });
    expect(codec.hid({ key: "ENC", act: 1 })).toEqual({ kind: "encoder", delta: 0, pressed: true });
    expect(codec.hid({ key: "ENC_CW", act: 2 })).toEqual({ kind: "encoder", delta: 1, pressed: true });
    expect(codec.hid({ key: "ENC_CC", act: 2 })).toEqual({ kind: "encoder", delta: -1, pressed: true });
    expect(codec.hid({ key: "ENC", act: 0 })).toEqual({ kind: "encoder", delta: 0, pressed: false });
    expect(codec.hid({ key: "ENC_CLK", act: 1 })).toEqual({ kind: "encoder", delta: 0, pressed: true });
    codec.reset();
    expect(codec.hid({ key: "ENC_CW", act: 2 })).toEqual({ kind: "encoder", delta: 1, pressed: false });
    expect(codec.hid({ key: "ENC_OTHER", act: 1 })).toBeUndefined();
    expect(codec.hid({ key: "ENC", act: 2 })).toBeUndefined();
  });

  it("converts the device polar stick orientation and publishes a neutral centre", () => {
    const codec = createDedicatedHardwareNotificationCodec({ resolvePhysicalKey: () => undefined });
    for (const [angle, x, y] of [[0, 0.8, 0], [0.25, 0, 0.8], [0.5, -0.8, 0], [0.75, 0, -0.8]]) {
      const input = codec.joystick({ angle, distance: 0.8 });
      expect(input?.kind).toBe("stick");
      if (input?.kind !== "stick") throw new Error("Stick input is unavailable.");
      expect(input.x).toBeCloseTo(x!);
      expect(input.y).toBeCloseTo(y!);
      expect(input.pressed).toBe(true);
    }
    expect(codec.joystick({ angle: 0.5, distance: 0 })).toEqual({ kind: "stick", x: 0, y: 0, pressed: false });
    for (const value of [
      { a: 0.5, d: 1 }, { angle: 0.5 }, { angle: NaN, distance: 1 },
      { angle: -0.1, distance: 1 }, { angle: 1.1, distance: 1 },
      { angle: 0.5, distance: 1.1 }, { angle: 0.5, distance: 1, pressed: true }
    ]) expect(codec.joystick(value)).toBeUndefined();
  });
});

function communicationFixture() {
  const records: unknown[] = [];
  const forwarded: string[] = [];
  const comm = {
    rpcResponse: "",
    parseRpcData(data: string): boolean {
      forwarded.push(data);
      const combined = this.rpcResponse + data;
      let value: unknown;
      try { value = JSON.parse(combined); } catch { this.rpcResponse = combined; return false; }
      this.rpcResponse = "";
      records.push(value);
      return true;
    }
  };
  return { comm, records, forwarded };
}

describe("compact hardware notification decoration", () => {
  it("recovers complete and fragmented compact reports while preserving the original parser and true RPC frames", () => {
    const { comm, records, forwarded } = communicationFixture();
    const original = comm.parseRpcData;
    const restore = installCompactHardwareNotifications(comm);
    expect(comm.parseRpcData('{"k":"AG')).toBe(false);
    expect(comm.parseRpcData('01","act":1}')).toBe(true);
    expect(records.shift()).toEqual({ method: "v.oai.hid", params: { k: "AG01", act: 1 } });
    expect(comm.parseRpcData('prefix {"a":0.25,"d":0.8}')).toBe(true);
    expect(records.shift()).toEqual({ method: "v.oai.rad", params: { a: 0.25, d: 0.8 } });
    const rpc = '{"id":12,"method":"fs.read","value":{"k":"AG01","act":1}}';
    expect(comm.parseRpcData(rpc.slice(0, 28))).toBe(false);
    expect(comm.parseRpcData(rpc.slice(28))).toBe(true);
    expect(records.shift()).toEqual(JSON.parse(rpc));
    expect(forwarded.slice(-2)).toEqual([rpc.slice(0, 28), rpc.slice(28)]);
    restore();
    expect(comm.parseRpcData).toBe(original);
  });

  it("leaves malformed, alternate-field and RPC records unchanged and rejects oversized pending frames", () => {
    const { comm, forwarded } = communicationFixture();
    installCompactHardwareNotifications(comm);
    for (const value of [
      { key: "AG00", act: 1 }, { k: "AG06", act: 1 }, { k: "AG00", act: "1" },
      { k: "AG00", act: 1, id: 9 }, { a: 0.25, d: 2 }, { angle: 0.25, distance: 1 }
    ]) {
      const data = JSON.stringify(value);
      comm.parseRpcData(data);
      expect(forwarded.at(-1)).toBe(data);
    }
    comm.rpcResponse = "x".repeat(2_000_000);
    expect(() => comm.parseRpcData("{}")).toThrow("size boundary");
    expect(comm.rpcResponse).toBe("");
  });
});
