import { EventEmitter } from "node:events";

import { create, toBinary } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  LAN_DISCOVERY_GROUP,
  LAN_DISCOVERY_MAX_DATAGRAM_BYTES,
  LAN_DISCOVERY_PORT,
  LAN_DISCOVERY_PROTOCOL_VERSION,
  LanDiscoveryService,
  decodeLanDiscoveryDatagram,
  encodeLanDiscoveryAnnouncement,
  encodeLanDiscoveryQuery,
  type DiscoveredNodeRecord
} from "./lan-discovery.js";

const active: LanDiscoveryService[] = [];
afterEach(async () => {
  for (const service of active.splice(0)) await service.stop();
});

function node(overrides: Partial<DiscoveredNodeRecord> = {}): DiscoveredNodeRecord {
  return {
    serverId: "orchestrator-node-a",
    displayName: "Office Orchestrator",
    origin: "http://192.168.1.20:4318",
    version: "0.1.0",
    apiVersion: "joko.v1",
    pairingEnabled: true,
    lastSeen: 1_000,
    ...overrides
  };
}

class FakeSocket extends EventEmitter {
  readonly sent: Array<{ bytes: Uint8Array; port: number; address: string }> = [];
  bound: { port: number; address: string } | undefined;
  membership: string | undefined;
  closed = false;

  bind(port: number, address: string, callback: () => void): void {
    this.bound = { port, address };
    callback();
  }
  addMembership(group: string): void { this.membership = group; }
  setMulticastTTL(_ttl: number): void {}
  setMulticastLoopback(_flag: boolean): void {}
  send(bytes: Uint8Array, port: number, address: string, callback?: (error: Error | null) => void): void {
    this.sent.push({ bytes, port, address });
    callback?.(null);
  }
  close(callback?: () => void): void { this.closed = true; callback?.(); }
  emitMessage(bytes: Uint8Array, address = "192.168.1.21", port = LAN_DISCOVERY_PORT): void {
    this.emit("message", Buffer.from(bytes), { address, port, family: "IPv4", size: bytes.byteLength });
  }
}

describe("LAN discovery protocol", () => {
  it("round-trips bounded protobuf query and announcement datagrams", () => {
    const nonce = Uint8Array.from({ length: 16 }, (_, index) => index);
    expect(decodeLanDiscoveryDatagram(encodeLanDiscoveryQuery(nonce), 2_000)).toEqual({ kind: "query", nonce });
    expect(decodeLanDiscoveryDatagram(encodeLanDiscoveryAnnouncement(nonce, node()), 2_000)).toEqual({
      kind: "announce",
      nonce,
      node: node({ lastSeen: 2_000 })
    });
  });

  it("fails closed for malformed, incompatible, oversized, or non-LAN datagrams", () => {
    const nonce = new Uint8Array(16);
    const raw = (overrides: Partial<contract.LanDiscoveryDatagram> = {}) => toBinary(
      contract.LanDiscoveryDatagramSchema,
      create(contract.LanDiscoveryDatagramSchema, {
        magic: Buffer.from("JOKO-ORCHESTRATOR-LAN"),
        protocolVersion: LAN_DISCOVERY_PROTOCOL_VERSION,
        nonce,
        kind: contract.LanDiscoveryDatagramKind.ANNOUNCE,
        node: create(contract.DiscoveredNodeSchema, {
          serverId: "orchestrator-peer",
          displayName: "Peer",
          origin: "http://192.168.1.9:4318",
          version: "0.1.0",
          apiVersion: "joko.v1",
          pairingEnabled: false,
          lastSeen: { seconds: 1n, nanos: 0, $typeName: "google.protobuf.Timestamp" }
        }),
        ...overrides
      })
    );
    expect(decodeLanDiscoveryDatagram(Uint8Array.of(255, 255))).toBeUndefined();
    expect(decodeLanDiscoveryDatagram(new Uint8Array(LAN_DISCOVERY_MAX_DATAGRAM_BYTES + 1))).toBeUndefined();
    expect(decodeLanDiscoveryDatagram(raw({ magic: Buffer.from("wrong") }))).toBeUndefined();
    expect(decodeLanDiscoveryDatagram(raw({ protocolVersion: 2 }))).toBeUndefined();
    expect(decodeLanDiscoveryDatagram(raw({ nonce: new Uint8Array(15) }))).toBeUndefined();
    expect(decodeLanDiscoveryDatagram(raw({
      node: create(contract.DiscoveredNodeSchema, {
        serverId: "orchestrator-peer",
        displayName: "x".repeat(129),
        origin: "http://example.com:4318",
        version: "0.1.0",
        apiVersion: "joko.v1",
        lastSeen: { seconds: 1n, nanos: 0, $typeName: "google.protobuf.Timestamp" }
      })
    }))).toBeUndefined();
    for (const origin of [
      "http://169.254.169.254:4318",
      "http://metadata:4318",
      "http://example.com:4318",
      "http://2130706433:4318",
      "http://user:pass@192.168.1.9:4318",
      "http://192.168.1.9:4318/path"
    ]) expect(decodeLanDiscoveryDatagram(raw({
      node: create(contract.DiscoveredNodeSchema, {
        serverId: "orchestrator-peer",
        displayName: "Peer",
        origin,
        version: "0.1.0",
        apiVersion: "joko.v1",
        lastSeen: { seconds: 1n, nanos: 0, $typeName: "google.protobuf.Timestamp" }
      })
    })), origin).toBeUndefined();
  });

  it("answers a query with the same nonce and no credential material", async () => {
    const socket = new FakeSocket();
    const service = new LanDiscoveryService({
      self: () => node(),
      socketFactory: () => socket,
      announceIntervalMs: 1_000,
      peerTtlMs: 2_000
    });
    active.push(service);
    await service.start();
    expect(socket.bound).toEqual({ port: LAN_DISCOVERY_PORT, address: "0.0.0.0" });
    expect(socket.membership).toBe(LAN_DISCOVERY_GROUP);

    const nonce = Uint8Array.from({ length: 16 }, (_, index) => 15 - index);
    const baseline = socket.sent.length;
    socket.emitMessage(encodeLanDiscoveryQuery(nonce), "192.168.1.44", 44_444);
    socket.emitMessage(encodeLanDiscoveryQuery(nonce), "192.168.1.44", 44_444);

    expect(socket.sent).toHaveLength(baseline + 1);
    expect(socket.sent.at(-1)).toMatchObject({ address: "192.168.1.44", port: 44_444 });
    expect(decodeLanDiscoveryDatagram(socket.sent.at(-1)!.bytes, 1_000)).toMatchObject({
      kind: "announce",
      nonce,
      node: { serverId: "orchestrator-node-a" }
    });
    expect(Buffer.from(socket.sent.at(-1)!.bytes).toString("utf8")).not.toMatch(/code|key|credential|token/iu);
  });

  it("deduplicates peers by durable server ID and expires them by local receive-time TTL", async () => {
    let now = 10_000;
    const socket = new FakeSocket();
    const service = new LanDiscoveryService({
      self: () => node({ serverId: "orchestrator-self", lastSeen: now }),
      socketFactory: () => socket,
      now: () => now,
      announceIntervalMs: 1_000,
      peerTtlMs: 2_000
    });
    active.push(service);
    await service.start();
    const nonce = new Uint8Array(16);
    socket.emitMessage(encodeLanDiscoveryAnnouncement(nonce, node({ displayName: "Old label", lastSeen: now })));
    socket.emitMessage(encodeLanDiscoveryAnnouncement(nonce, node({ displayName: "New label", lastSeen: now })));
    socket.emitMessage(encodeLanDiscoveryAnnouncement(nonce, node({ serverId: "orchestrator-public-spoof", lastSeen: now })), "203.0.113.8");
    expect(service.list().map((item) => item.displayName)).toEqual(["Office Orchestrator", "New label"]);

    now += 2_001;
    expect(service.list()).toHaveLength(1);
  });
});
