import type { Transport } from "@connectrpc/connect";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { DesktopManagedOrchestratorConnection } from "../src/channels.js";
import { resolveManagedArtifactSource } from "../src/managed-artifact-source.js";

const CONNECTION: DesktopManagedOrchestratorConnection = {
  profileId: "managed-local",
  deviceId: "desktop-device",
  serverId: "orchestrator-owner",
  name: "Local Joko",
  origin: "http://127.0.0.1:4318"
};
const AUTH_KEY = "a".repeat(43);
const HOST_KEY = "b".repeat(43);

describe("managed Artifact source resolver", () => {
  it("fences anonymous identity, sends both private authorities, and returns only a canonical absolute path", async () => {
    const calls: string[] = [];
    const absolutePath = resolve("artifact-source.png");
    const transport = fakeTransport("orchestrator-owner", absolutePath, calls);
    const factory = vi.fn(() => transport);
    const authority = vi.fn(async () => true);

    await expect(resolveManagedArtifactSource({
      connection: CONNECTION,
      sessionId: "source-task",
      artifactId: "artifact-one",
      signal: new AbortController().signal,
      readAuthKey: async (profileId) => profileId === CONNECTION.profileId ? AUTH_KEY : undefined,
      readDesktopHostAuthKey: () => HOST_KEY,
      isAuthorityCurrent: authority,
      transportFactory: factory
    })).resolves.toBe(absolutePath);

    expect(calls).toEqual(["getServerInfo", "resolveArtifactSource:source-task:artifact-one"]);
    expect(factory).toHaveBeenNthCalledWith(1, CONNECTION.origin, undefined, undefined);
    expect(factory).toHaveBeenNthCalledWith(2, CONNECTION.origin, AUTH_KEY, HOST_KEY);
    expect(authority).toHaveBeenCalledTimes(3);
  });

  it("never reads private keys when anonymous server identity changed", async () => {
    const calls: string[] = [];
    const readAuthKey = vi.fn(async () => AUTH_KEY);
    const readDesktopHostAuthKey = vi.fn(() => HOST_KEY);
    const factory = vi.fn(() => fakeTransport("different-process", resolve("artifact-source.png"), calls));
    await expect(resolveManagedArtifactSource({
      connection: CONNECTION,
      sessionId: "source-task",
      artifactId: "artifact-one",
      signal: new AbortController().signal,
      readAuthKey,
      readDesktopHostAuthKey,
      isAuthorityCurrent: async () => true,
      transportFactory: factory
    })).rejects.toThrow("authority is unavailable");
    expect(calls).toEqual(["getServerInfo"]);
    expect(readAuthKey).not.toHaveBeenCalled();
    expect(readDesktopHostAuthKey).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledOnce();
  });

  it("rejects rotated authority, invalid credentials, cancellation, and noncanonical response paths", async () => {
    const base = {
      connection: CONNECTION,
      sessionId: "source-task",
      artifactId: "artifact-one",
      signal: new AbortController().signal,
      readAuthKey: async () => AUTH_KEY,
      readDesktopHostAuthKey: () => HOST_KEY
    } as const;
    const transport = fakeTransport("orchestrator-owner", resolve("artifact-source.png"), []);
    await expect(resolveManagedArtifactSource({
      ...base,
      isAuthorityCurrent: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      transportFactory: () => transport
    })).rejects.toThrow("authority is unavailable");
    await expect(resolveManagedArtifactSource({
      ...base,
      readDesktopHostAuthKey: () => "short",
      isAuthorityCurrent: async () => true,
      transportFactory: () => transport
    })).rejects.toThrow("authority is unavailable");
    const abort = new AbortController(); abort.abort();
    await expect(resolveManagedArtifactSource({
      ...base,
      signal: abort.signal,
      isAuthorityCurrent: async () => true,
      transportFactory: () => transport
    })).rejects.toThrow("authority is unavailable");
    await expect(resolveManagedArtifactSource({
      ...base,
      isAuthorityCurrent: async () => true,
      transportFactory: () => fakeTransport("orchestrator-owner", "relative\\source.png", [])
    })).rejects.toThrow("authority is unavailable");
  });
});

function fakeTransport(serverId: string, absolutePath: string, calls: string[]): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: AbortSignal, _timeoutMs: number | undefined, _header: Headers, input: any) => {
      if (method.localName === "getServerInfo") calls.push("getServerInfo");
      else calls.push(`${method.localName}:${input.sessionId}:${input.artifactId}`);
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
        : { $typeName: "joko.v1.ResolveArtifactSourceResponse", absolutePath };
      return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
    }),
    stream: vi.fn()
  } as unknown as Transport;
}
