import type { RemoteInfo } from "node:dgram";

import {
  decodeLanDiscoveryDatagram,
  encodeLanDiscoveryAnnouncement,
  encodeLanDiscoveryQuery,
  type DiscoveredNodeRecord
} from "@joko/contracts";
import { describe, expect, it } from "vitest";

import { scanLanOrchestratorNodes } from "../src/lan-discovery.js";

const REMOTE: RemoteInfo = { address: "192.168.1.20", family: "IPv4", port: 43_180, size: 0 };

class FakeSocket {
  readonly messages: Array<(message: Buffer, remote: RemoteInfo) => void> = [];
  readonly errors: Array<(error: Error) => void> = [];
  sent: Uint8Array | undefined;
  bound = false;
  closed = false;
  ttl: number | undefined;
  loopback: boolean | undefined;
  afterSend: ((message: Uint8Array) => void) | undefined;

  bind(port: number, address: string, callback: () => void): void {
    expect(port).toBe(0);
    expect(address).toBe("0.0.0.0");
    this.bound = true;
    callback();
  }

  setMulticastTTL(ttl: number): void { this.ttl = ttl; }
  setMulticastLoopback(flag: boolean): void { this.loopback = flag; }

  send(message: Uint8Array, port: number, address: string, callback: (error: Error | null) => void): void {
    expect(port).toBe(43_180);
    expect(address).toBe("239.255.77.77");
    this.sent = message;
    callback(null);
    this.afterSend?.(message);
  }

  close(callback?: () => void): void {
    this.closed = true;
    callback?.();
  }

  on(event: "message", listener: (message: Buffer, remote: RemoteInfo) => void): this {
    expect(event).toBe("message");
    this.messages.push(listener);
    return this;
  }

  once(event: "error", listener: (error: Error) => void): this {
    expect(event).toBe("error");
    this.errors.push(listener);
    return this;
  }

  off(event: "error", listener: (error: Error) => void): this {
    expect(event).toBe("error");
    const index = this.errors.indexOf(listener);
    if (index !== -1) this.errors.splice(index, 1);
    return this;
  }

  emit(message: Uint8Array): void {
    for (const listener of [...this.messages]) listener(Buffer.from(message), REMOTE);
  }
}

function node(overrides: Partial<DiscoveredNodeRecord> = {}): DiscoveredNodeRecord {
  return {
    serverId: "orchestrator-a",
    displayName: "Alpha Orchestrator",
    origin: "http://192.168.1.20:4318",
    version: "0.1.0",
    apiVersion: "v1",
    pairingEnabled: true,
    lastSeen: 1_000,
    ...overrides
  };
}

describe("Desktop LAN discovery", () => {
  it("accepts only nonce-matched bounded announcements and deduplicates by stable server ID", async () => {
    const socket = new FakeSocket();
    const nonce = Uint8Array.from({ length: 16 }, () => 0x11);
    socket.afterSend = (query) => {
      expect(decodeLanDiscoveryDatagram(query)).toMatchObject({ kind: "query", nonce });
      socket.emit(encodeLanDiscoveryQuery(nonce));
      socket.emit(new Uint8Array(3_000));
      socket.emit(encodeLanDiscoveryAnnouncement(Uint8Array.from({ length: 16 }, () => 0x22), node()));
      socket.emit(encodeLanDiscoveryAnnouncement(nonce, node()));
      socket.emit(encodeLanDiscoveryAnnouncement(nonce, node({
        displayName: "Duplicate must not replace",
        origin: "http://192.168.1.21:4318"
      })));
      socket.emit(encodeLanDiscoveryAnnouncement(nonce, node({
        serverId: "orchestrator-b",
        displayName: "Beta Orchestrator",
        origin: "https://orchestrator-b.local:4318",
        pairingEnabled: false
      })));
    };

    const result = await scanLanOrchestratorNodes({
      maxResults: 2,
      now: () => 4_321,
      randomNonce: () => nonce,
      socketFactory: () => socket
    });

    expect(socket.bound).toBe(true);
    expect(socket.ttl).toBe(1);
    expect(socket.loopback).toBe(true);
    expect(socket.closed).toBe(true);
    expect(result).toEqual([
      {
        serverId: "orchestrator-a",
        displayName: "Alpha Orchestrator",
        origin: "http://192.168.1.20:4318",
        version: "0.1.0",
        apiVersion: "v1",
        pairingEnabled: true,
        lastSeenAt: 4_321
      },
      {
        serverId: "orchestrator-b",
        displayName: "Beta Orchestrator",
        origin: "https://orchestrator-b.local:4318",
        version: "0.1.0",
        apiVersion: "v1",
        pairingEnabled: false,
        lastSeenAt: 4_321
      }
    ]);
  });

  it("closes the socket and rejects when a scan is cancelled", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    controller.abort();

    await expect(scanLanOrchestratorNodes({
      signal: controller.signal,
      socketFactory: () => socket
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(socket.bound).toBe(false);
    expect(socket.closed).toBe(true);
  });

  it("rejects unbounded caller options before opening a socket", () => {
    expect(() => scanLanOrchestratorNodes({ timeoutMs: 6_000 })).toThrow(/timeout/u);
    expect(() => scanLanOrchestratorNodes({ maxResults: 65 })).toThrow(/result limit/u);
  });
});
