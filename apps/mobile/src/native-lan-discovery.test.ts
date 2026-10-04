import {
  LAN_DISCOVERY_GROUP,
  LAN_DISCOVERY_MAX_DATAGRAM_BYTES,
  LAN_DISCOVERY_PORT,
  decodeLanDiscoveryDatagram,
  encodeLanDiscoveryAnnouncement,
  type DiscoveredNodeRecord
} from "@joko/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  discover: vi.fn<(...args: unknown[]) => Promise<readonly { data: string; address: string }[]>>(),
  installed: true,
  nonce: Uint8Array.from({ length: 16 }, (_, index) => index + 1)
}));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => native.installed ? { discover: native.discover } : null }));
vi.mock("expo-crypto", () => ({ getRandomBytes: () => native.nonce }));

const node: DiscoveredNodeRecord = {
  serverId: "node-one", displayName: "Nearby node", origin: "http://192.168.1.20:4318",
  version: "1.0.0", apiVersion: "joko.v1", pairingEnabled: true, lastSeen: 0
};

beforeEach(() => {
  vi.resetModules();
  native.installed = true;
  native.discover.mockReset();
  vi.stubGlobal("btoa", undefined);
  vi.stubGlobal("atob", undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("native LAN datagram encoding", () => {
  it("round-trips the current query and keeps valid replies next to malformed native data without browser codecs", async () => {
    const valid = Buffer.from(encodeLanDiscoveryAnnouncement(native.nonce, node)).toString("base64");
    native.discover.mockResolvedValue([
      ...["", "!invalid", "Zg==Zg==", "Zh==", "Zg", "Zg==\n", "_w==",
        "A".repeat(Math.ceil(LAN_DISCOVERY_MAX_DATAGRAM_BYTES / 3) * 4 + 4),
        Buffer.alloc(LAN_DISCOVERY_MAX_DATAGRAM_BYTES + 1).toString("base64")]
        .map((data) => ({ data, address: "192.168.1.20" })),
      { data: valid, address: "192.168.1.20" }
    ]);
    const { mobileDiscovery } = await import("./native-lan-discovery");
    await expect(mobileDiscovery.scan()).resolves.toEqual([expect.objectContaining({ ...node, lastSeen: expect.any(Number) })]);
    expect(native.discover).toHaveBeenCalledOnce();
    const [query, group, port, timeout, maximum] = native.discover.mock.calls[0]!;
    expect(decodeLanDiscoveryDatagram(Uint8Array.from(Buffer.from(query as string, "base64"))))
      .toEqual({ kind: "query", nonce: native.nonce });
    expect([group, port, timeout, maximum]).toEqual([LAN_DISCOVERY_GROUP, LAN_DISCOVERY_PORT, 1_500, 64]);
  });

  it("preserves unavailable-module and transport failure instead of inventing a discovery result", async () => {
    native.installed = false;
    await expect((await import("./native-lan-discovery")).mobileDiscovery.scan()).rejects.toThrow(/installed Joko mobile build/);
    expect(native.discover).not.toHaveBeenCalled();
    native.installed = true;
    vi.resetModules();
    native.discover.mockRejectedValue(new Error("native socket failed"));
    await expect((await import("./native-lan-discovery")).mobileDiscovery.scan()).rejects.toThrow("native socket failed");
  });
});
