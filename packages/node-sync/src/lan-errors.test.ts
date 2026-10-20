import dgram, { type Socket as DgramSocket } from "node:dgram";
import { EventEmitter } from "node:events";
import { constants } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { encryptNodeSyncBytes, generateNodeSyncIdentity, nodeSyncDomain } from "./crypto.js";
import { NodeSyncLanTransport, type NodeSyncLanTransportOptions } from "./lan.js";
import { NodeSyncTcpTransport } from "./tcp.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

describe("LAN error diagnostics", () => {
  it.each(["before-failure", "during-cooldown", "after-cooldown"] as const)("recovers an unchanged LAN route %s", async (hintAt) => {
    const first = { ...generateNodeSyncIdentity(), nodeId: "recovery-local", displayName: "Local" };
    const second = { ...generateNodeSyncIdentity(), nodeId: "recovery-peer", displayName: "Peer" };
    const socket = discoverySocket(null);
    vi.spyOn(dgram, "createSocket").mockReturnValue(socket as unknown as DgramSocket);
    let received = 0;
    const receiver = new NodeSyncTcpTransport({
      purpose: "voice-dictionary", getSelf: () => second, listenHost: "127.0.0.1",
      isPeerAllowed: (nodeId, publicKey) => nodeId === first.nodeId && publicKey === first.publicKey,
      onFrame: () => { received += 1; }, logger: { debug: () => undefined, warn: () => undefined }
    });
    const sender = new NodeSyncLanTransport({
      purpose: "voice-dictionary", getSelf: () => first,
      isPeerAllowed: (nodeId, publicKey) => nodeId === second.nodeId && publicKey === second.publicKey,
      onCandidate: () => undefined, onFrame: () => undefined, logger: { debug: () => undefined, warn: () => undefined }
    });
    cleanups.push(() => receiver.stop(), () => sender.stop());
    await receiver.start();
    await sender.start();
    const announce = () => socket.emit("message", Buffer.from(JSON.stringify({
      magic: nodeSyncDomain("voice-dictionary").magic, version: 1, nodeId: second.nodeId,
      displayName: second.displayName, publicKey: second.publicKey, port: receiver.listenerPort()
    })), { address: "127.0.0.1" });
    announce();
    expect(sender.onlinePeerIds()).toEqual([second.nodeId]);
    const encrypted = encryptNodeSyncBytes("voice-dictionary", Buffer.from("private document"), first.privateKey, second.publicKey,
      { sourceNodeId: first.nodeId, destinationNodeId: second.nodeId, transferId: "recovery-frame", totalChunks: 1 });
    const frame = { version: 1, type: "cipher-chunk", senderPublicKey: first.publicKey, transferId: "recovery-frame", index: 0, total: 1,
      iv: encrypted.iv, tag: encrypted.tag, compression: "gzip", data: encrypted.ciphertext.toString("base64") } as const;
    let release!: (success: boolean) => void;
    const oldSend = new Promise<boolean>(resolve => { release = resolve; });
    let outgoingSends = 0;
    const originalSend = NodeSyncTcpTransport.prototype.send;
    const send = vi.spyOn(NodeSyncTcpTransport.prototype, "send").mockImplementation(function (this: NodeSyncTcpTransport, endpoint, nodeId, value, delivery) {
      if (nodeId === second.nodeId && ++outgoingSends === 1) return oldSend;
      return originalSend.call(this, endpoint, nodeId, value, delivery);
    });
    const authenticate = () => receiver.probe({ host: "127.0.0.1", port: sender.listenerPort()!, publicKey: first.publicKey }, first.nodeId);
    try {
      const pending = sender.send(second.nodeId, frame);
      if (hintAt === "before-failure") expect(await authenticate()).toBe(true);
      release(false);
      expect(await pending).toBe(false);
      expect(received).toBe(0);
      if (hintAt === "during-cooldown") {
        announce();
        expect(sender.onlinePeerIds()).toEqual([]);
        expect(await authenticate()).toBe(true);
      }
      if (hintAt === "after-cooldown") {
        announce();
        expect(sender.onlinePeerIds()).toEqual([]);
        expect(await sender.send(second.nodeId, frame)).toBe(false);
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
        announce();
      }
      expect(sender.onlinePeerIds()).toEqual([second.nodeId]);
      expect(await sender.send(second.nodeId, frame)).toBe(true);
      expect(received).toBe(1);
      expect(outgoingSends).toBe(2);
    } finally { release(false); send.mockRestore(); }
  });

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

function discoverySocket(sendError: Error | null) {
  return Object.assign(new EventEmitter(), {
    bind: vi.fn((_port: number, _address: string, ready: () => void) => ready()),
    addMembership: vi.fn(), setMulticastInterface: vi.fn(), setMulticastTTL: vi.fn(), setMulticastLoopback: vi.fn(),
    unref: vi.fn(), close: vi.fn(),
    send: vi.fn((_bytes: Buffer, _port: number, _group: string, callback: (error: Error | null) => void) => callback(sendError))
  });
}

function fixture(sendError: Error | null, options: Pick<NodeSyncLanTransportOptions, "multicastInterface"> = {}) {
  const socket = discoverySocket(sendError);
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
