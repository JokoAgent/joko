import type { Transport } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";

import type { DesktopManagedOrchestratorConnection } from "../src/channels.js";
import { probeManagedRuntimeActivity } from "../src/managed-runtime-activity.js";

const CONNECTION: DesktopManagedOrchestratorConnection = {
  profileId: "managed-local",
  deviceId: "desktop-device",
  serverId: "orchestrator-owner",
  name: "Local Joko",
  origin: "http://127.0.0.1:4318"
};
const AUTH_KEY = "a".repeat(43);

describe("managed Orchestrator runtime activity authority probe", () => {
  it("checks the anonymous stable identity before decrypting bearer and returns durable activity time", async () => {
    const calls: string[] = [];
    const transport = fakeTransport("orchestrator-owner", {
      blocksShutdown: false,
      lastBlockingActivityAt: { seconds: 42n, nanos: 123_000_000 }
    }, calls);
    const factory = vi.fn(() => transport);
    const readAuthKey = vi.fn(async () => AUTH_KEY);
    const isAuthorityCurrent = vi.fn(async () => true);

    await expect(probeManagedRuntimeActivity({
      connection: CONNECTION,
      readAuthKey,
      isAuthorityCurrent,
      transportFactory: factory
    })).resolves.toEqual({ blocksShutdown: false, lastBlockingActivityAtMs: 42_123 });

    expect(calls).toEqual(["getServerInfo", "getRuntimeActivity"]);
    expect(factory).toHaveBeenNthCalledWith(1, CONNECTION.origin, undefined, 2_000);
    expect(factory).toHaveBeenNthCalledWith(2, CONNECTION.origin, AUTH_KEY, 2_000);
    expect(readAuthKey).toHaveBeenCalledWith(CONNECTION.profileId);
    expect(isAuthorityCurrent).toHaveBeenCalledTimes(2);
  });

  it("never reads or sends the long-lived bearer when the loopback port identity is hijacked", async () => {
    const calls: string[] = [];
    const transport = fakeTransport("different-process", { blocksShutdown: false }, calls);
    const factory = vi.fn(() => transport);
    const readAuthKey = vi.fn(async () => AUTH_KEY);

    await expect(probeManagedRuntimeActivity({
      connection: CONNECTION,
      readAuthKey,
      isAuthorityCurrent: vi.fn(async () => true),
      transportFactory: factory
    })).rejects.toThrow("identity changed");
    expect(calls).toEqual(["getServerInfo"]);
    expect(readAuthKey).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(CONNECTION.origin, undefined, 2_000);
  });

  it("rechecks ownership before and after the authenticated RPC", async () => {
    const transport = fakeTransport("orchestrator-owner", { blocksShutdown: false }, []);
    const beforeChanged = vi.fn()
      .mockResolvedValueOnce(false);
    const readAuthKey = vi.fn(async () => AUTH_KEY);
    const factory = vi.fn(() => transport);
    await expect(probeManagedRuntimeActivity({
      connection: CONNECTION,
      readAuthKey,
      isAuthorityCurrent: beforeChanged,
      transportFactory: factory
    })).rejects.toThrow("authority changed");
    expect(factory).toHaveBeenCalledOnce();

    const afterChanged = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(probeManagedRuntimeActivity({
      connection: CONNECTION,
      readAuthKey,
      isAuthorityCurrent: afterChanged,
      transportFactory: () => transport
    })).rejects.toThrow("authority changed");
  });

  it("rejects missing summaries, invalid credentials, and noncanonical origins", async () => {
    const missing = fakeTransport("orchestrator-owner", undefined, []);
    await expect(probeManagedRuntimeActivity({
      connection: CONNECTION,
      readAuthKey: async () => AUTH_KEY,
      isAuthorityCurrent: async () => true,
      transportFactory: () => missing
    })).rejects.toThrow("summary is unavailable");
    await expect(probeManagedRuntimeActivity({
      connection: CONNECTION,
      readAuthKey: async () => "short",
      isAuthorityCurrent: async () => true,
      transportFactory: () => fakeTransport("orchestrator-owner", { blocksShutdown: false }, [])
    })).rejects.toThrow("authority changed");
    await expect(probeManagedRuntimeActivity({
      connection: { ...CONNECTION, origin: `${CONNECTION.origin}/path` },
      readAuthKey: async () => AUTH_KEY,
      isAuthorityCurrent: async () => true,
      transportFactory: () => missing
    })).rejects.toThrow("authority is invalid");
  });
});

function fakeTransport(
  serverId: string,
  summary: { readonly blocksShutdown: boolean; readonly lastBlockingActivityAt?: { seconds: bigint; nanos: number } } | undefined,
  calls: string[]
): Transport {
  return {
    unary: vi.fn(async (method: any) => {
      calls.push(method.localName);
      const message = method.localName === "getServerInfo"
        ? {
          $typeName: "joko.v1.GetServerInfoResponse",
          server: {
            $typeName: "joko.v1.ServerInfo",
            serverId,
            displayName: "Orchestrator",
            version: "0.1.0",
            apiVersion: "joko.v1",
            pairingEnabled: false
          }
        }
        : {
          $typeName: "joko.v1.GetRuntimeActivityResponse",
          ...(summary === undefined ? {} : {
            summary: { $typeName: "joko.v1.RuntimeActivitySummary", ...summary }
          })
        };
      return {
        stream: false,
        service: method.parent,
        method,
        header: new Headers(),
        trailer: new Headers(),
        message
      };
    }),
    stream: vi.fn()
  } as unknown as Transport;
}
