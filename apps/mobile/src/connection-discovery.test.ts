import {
  LAN_DISCOVERY_GROUP,
  LAN_DISCOVERY_MAX_DATAGRAM_BYTES,
  LAN_DISCOVERY_PORT,
  decodeLanDiscoveryDatagram,
  encodeLanDiscoveryAnnouncement,
  type DiscoveredNodeRecord
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createMobileDiscovery, type MobileLanDiscoveryTransport } from "./connection-discovery";

const nonce = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const node: DiscoveredNodeRecord = {
  serverId: "node-one",
  displayName: "Living room",
  origin: "http://192.168.1.20:4318",
  version: "1.0.0",
  apiVersion: "joko.v1",
  pairingEnabled: true,
  lastSeen: 1_000
};

describe("native mobile LAN discovery boundary", () => {
  it("sends one bounded current-v1 query and accepts only matching private replies", async () => {
    const otherNonce = new Uint8Array(16).fill(9);
    const transport: MobileLanDiscoveryTransport = {
      discover: vi.fn(async (request) => {
        const query = decodeLanDiscoveryDatagram(request.bytes);
        expect(query).toMatchObject({ kind: "query" });
        if (query?.kind === "query") expect([...query.nonce]).toEqual([...nonce]);
        expect(request).toMatchObject({
          group: LAN_DISCOVERY_GROUP,
          port: LAN_DISCOVERY_PORT,
          timeoutMs: 1_500,
          maximumResponses: 64
        });
        return [
          { bytes: encodeLanDiscoveryAnnouncement(nonce, node), address: "192.168.1.20" },
          { bytes: encodeLanDiscoveryAnnouncement(nonce, node), address: "192.168.1.20" },
          { bytes: encodeLanDiscoveryAnnouncement(otherNonce, { ...node, serverId: "wrong-nonce" }), address: "192.168.1.21" },
          { bytes: encodeLanDiscoveryAnnouncement(nonce, { ...node, serverId: "public-source" }), address: "8.8.8.8" },
          { bytes: new Uint8Array(LAN_DISCOVERY_MAX_DATAGRAM_BYTES + 1), address: "192.168.1.22" },
          { bytes: Uint8Array.of(0xff, 0x00), address: "192.168.1.23" }
        ];
      })
    };
    const discovery = createMobileDiscovery(transport, () => nonce, () => 20_000);

    await expect(discovery.scan()).resolves.toEqual([{ ...node, lastSeen: 20_000 }]);
    expect(transport.discover).toHaveBeenCalledOnce();
  });

  it("excludes a stable server identity when replies disagree on its origin", async () => {
    const transport: MobileLanDiscoveryTransport = {
      async discover() {
        return [
          { bytes: encodeLanDiscoveryAnnouncement(nonce, node), address: "192.168.1.20" },
          { bytes: encodeLanDiscoveryAnnouncement(nonce, { ...node, origin: "http://192.168.1.21:4318" }), address: "192.168.1.21" },
          { bytes: encodeLanDiscoveryAnnouncement(nonce, { ...node, serverId: "node-two", displayName: "Office", origin: "https://office.local:4318" }), address: "192.168.1.22" }
        ];
      }
    };
    const discovery = createMobileDiscovery(transport, () => nonce, () => 20_000);

    await expect(discovery.scan()).resolves.toEqual([
      expect.objectContaining({ serverId: "node-two", origin: "https://office.local:4318" })
    ]);
  });

  it("rejects an invalid nonce before opening the native transport and honors cancellation", async () => {
    const transport: MobileLanDiscoveryTransport = { discover: vi.fn(async () => []) };
    await expect(createMobileDiscovery(transport, () => new Uint8Array(15)).scan()).rejects.toThrow(/request identity/);
    expect(transport.discover).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort();
    await expect(createMobileDiscovery(transport, () => nonce).scan(controller.signal)).rejects.toThrow(/cancelled/);
    expect(transport.discover).not.toHaveBeenCalled();
  });
});
