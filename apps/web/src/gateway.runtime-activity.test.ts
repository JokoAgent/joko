import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetRuntimeActivityResponseSchema,
  GetSnapshotResponseSchema,
  SnapshotSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createOrchestratorGateway,
  probeOrchestratorRuntimeActivityAt,
  type GatewayTransportFactory
} from "./gateway.js";

describe("Orchestrator runtime activity probe", () => {
  it.each([true, false])("returns the authoritative blocksShutdown value: %s", async (blocksShutdown) => {
    const calls: Array<{ readonly service: string; readonly method: string; readonly input: unknown }> = [];
    const transport = runtimeTransport((method, input) => {
      calls.push({ service: method.parent.typeName, method: method.localName, input });
      return create(GetRuntimeActivityResponseSchema, {
        summary: { blocksShutdown }
      });
    });
    const gateway = createOrchestratorGateway(
      { id: "managed", deviceId: "device-managed", serverId: "server-managed", name: "Local", origin: "http://127.0.0.1:4318", managedLocal: true },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();
    calls.length = 0;

    await expect(gateway.probeRuntimeActivity()).resolves.toBe(blocksShutdown);
    expect(calls).toEqual([{
      service: "joko.v1.EventService",
      method: "getRuntimeActivity",
      input: {}
    }]);
    gateway.disconnect();
  });

  it("rejects a missing summary so the relaunch UI can fail closed", async () => {
    const transport = runtimeTransport(() => create(GetRuntimeActivityResponseSchema, {}));
    const gateway = createOrchestratorGateway(
      { id: "managed", deviceId: "device-managed", serverId: "server-managed", name: "Local", origin: "http://127.0.0.1:4318", managedLocal: true },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    await expect(gateway.probeRuntimeActivity()).rejects.toThrow("no runtime activity summary");
    gateway.disconnect();
  });

  it("uses a one-shot authenticated EventService transport and exposes only the boolean decision", async () => {
    const transport = runtimeTransport((_method, _input) => create(GetRuntimeActivityResponseSchema, {
      summary: { blocksShutdown: false, blockingKinds: [1, 2, 3] }
    }));
    const transportFactory = vi.fn((_origin: string, _authKey?: string) => transport) as GatewayTransportFactory;

    const result = await probeOrchestratorRuntimeActivityAt(
      "http://127.0.0.1:4318",
      "owner-secret",
      undefined,
      transportFactory
    );

    expect(result).toBe(false);
    expect(typeof result).toBe("boolean");
    expect(transportFactory).toHaveBeenCalledWith("http://127.0.0.1:4318", "owner-secret");
    expect(transport.stream).not.toHaveBeenCalled();
  });
});

function runtimeTransport(
  runtimeResponse: (method: any, input: unknown) => unknown
): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: unknown) => {
      const message = method.localName === "getSnapshot"
        ? create(GetSnapshotResponseSchema, {
          snapshot: create(SnapshotSchema, {
            generation: 1n,
            resumeCursor: { generation: 1n, sequence: 0n }
          })
        })
        : runtimeResponse(method, input);
      return {
        stream: false,
        service: method.parent,
        method,
        header: new Headers(),
        trailer: new Headers(),
        message
      };
    }),
    stream: vi.fn(async (method: any) => ({
      stream: true,
      service: method.parent,
      method,
      header: new Headers(),
      trailer: new Headers(),
      message: idleStream()
    }))
  } as unknown as Transport;
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
