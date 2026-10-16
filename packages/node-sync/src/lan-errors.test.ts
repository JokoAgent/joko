import dgram, { type Socket as DgramSocket } from "node:dgram";
import { EventEmitter } from "node:events";
import { constants } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { generateNodeSyncIdentity } from "./crypto.js";
import { NodeSyncLanTransport, type NodeSyncLanTransportOptions } from "./lan.js";
import { NodeSyncTcpTransport } from "./tcp.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

describe("LAN error diagnostics", () => {
  it("retains operating system interface selection when no interface is configured", async () => {
    const { transport, socket } = fixture(null);
    await transport.start();
    expect(socket.addMembership).toHaveBeenCalledWith("239.255.74.75", undefined);
    expect(socket.setMulticastInterface).not.toHaveBeenCalled();
  });

  it("uses the explicit IPv4 interface for membership and selects it before sending", async () => {
    const { transport, socket, debug } = fixture(null, { multicastInterface: "127.0.0.1" });
    await transport.start();
    expect(socket.addMembership).toHaveBeenCalledWith("239.255.74.75", "127.0.0.1");
    expect(socket.setMulticastInterface).toHaveBeenCalledWith("127.0.0.1");
    expect(socket.setMulticastInterface.mock.invocationCallOrder[0]).toBeLessThan(socket.send.mock.invocationCallOrder[0]!);
    expect(debug).not.toHaveBeenCalled();
  });

  it.each(["::1", "lo0", "127.0.0.1\nprivate frame"])("rejects an invalid IPv4 interface %s", (multicastInterface) => {
    expect(() => fixture(null, { multicastInterface })).toThrow("Node sync LAN transport options are invalid.");
  });

  it.each(["EHOSTUNREACH", "EPERM", "EINVAL", "EACCES"])("retains standard symbolic errno %s without error details", async (code) => {
    expect(Object.hasOwn(constants.errno, code)).toBe(true);
    const { transport, debug } = fixture(privateError(code));
    await transport.start();
    expect(debug.mock.calls).toEqual([["Node sync LAN beacon failed.", { code }]]);
  });

  it.each(["unknown-credential", "EHOSTUNREACH\nprivate frame", "constructor", "__proto__", -1, undefined])(
    "redacts nonstandard code %s to unavailable", async (code) => {
      const { transport, debug } = fixture(privateError(code));
      await transport.start();
      expect(debug.mock.calls).toEqual([["Node sync LAN beacon failed.", { code: "unavailable" }]]);
    }
  );

  it("uses the same restricted metadata for a discovery socket error", async () => {
    const { transport, socket, debug } = fixture(null);
    await transport.start();
    expect(debug).not.toHaveBeenCalled();
    socket.emit("error", privateError("EINVAL"));
    expect(debug.mock.calls).toEqual([["Node sync LAN discovery is unavailable.", { code: "EINVAL" }]]);
  });
});

function privateError(code: unknown): Error {
  return Object.assign(new Error("private credential and frame"), {
    code, address: "private address", frame: "private frame", credential: "private credential"
  });
}

function fixture(sendError: Error | null, options: Pick<NodeSyncLanTransportOptions, "multicastInterface"> = {}) {
  const socket = Object.assign(new EventEmitter(), {
    bind: vi.fn((_port: number, _address: string, ready: () => void) => ready()),
    addMembership: vi.fn(), setMulticastInterface: vi.fn(), setMulticastTTL: vi.fn(), setMulticastLoopback: vi.fn(),
    unref: vi.fn(), close: vi.fn(),
    send: vi.fn((_bytes: Buffer, _port: number, _group: string, callback: (error: Error | null) => void) => callback(sendError))
  });
  vi.spyOn(dgram, "createSocket").mockReturnValue(socket as unknown as DgramSocket);
  vi.spyOn(NodeSyncTcpTransport.prototype, "start").mockResolvedValue();
  vi.spyOn(NodeSyncTcpTransport.prototype, "listenerPort").mockReturnValue(41_000);
  const debug = vi.fn();
  const identity = { ...generateNodeSyncIdentity(), nodeId: "local-node", displayName: "Local" };
  const transport = new NodeSyncLanTransport({
    purpose: "voice-dictionary", getSelf: () => identity, isPeerAllowed: () => false,
    onCandidate: () => undefined, onFrame: () => undefined, logger: { debug, warn: vi.fn() }, ...options
  });
  cleanups.push(() => transport.stop());
  return { transport, socket, debug };
}
