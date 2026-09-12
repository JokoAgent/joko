import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetSnapshotResponseSchema,
  ListSessionResourcesResponseSchema,
  ResourceKind,
  SnapshotSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway } from "./gateway.js";

describe("task resource gateway", () => {
  it("maps the exact live task catalog without consulting the global resource snapshot", async () => {
    const transport = resourceTransport(() => create(ListSessionResourcesResponseSchema, {
      resources: [{
        sessionId: "session-one",
        resourceId: "prompt-one",
        kind: ResourceKind.PROMPT_TEMPLATE,
        name: "Release",
        version: "1.2.3",
        discoveredRevision: "sha256:exact",
        resourceVersion: 9n,
        runtimeGeneration: 4n
      }]
    }));
    const gateway = createOrchestratorGateway(
      { id: "connection-resource", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    await expect(gateway.listSessionResources("session-one")).resolves.toEqual([{
      sessionId: "session-one",
      id: "prompt-one",
      kind: "prompt",
      name: "Release",
      version: "1.2.3",
      discoveredRevision: "sha256:exact",
      resourceVersion: "9",
      runtimeGeneration: 4
    }]);
    gateway.disconnect();
  });

  it.each([
    { sessionId: "another-session", kind: ResourceKind.SKILL, resourceVersion: 1n, runtimeGeneration: 1n },
    { sessionId: "session-one", kind: ResourceKind.UNSPECIFIED, resourceVersion: 1n, runtimeGeneration: 1n },
    { sessionId: "session-one", kind: ResourceKind.THEME, resourceVersion: 1n, runtimeGeneration: 1n },
    { sessionId: "session-one", kind: 999 as ResourceKind, resourceVersion: 1n, runtimeGeneration: 1n },
    { sessionId: "session-one", kind: ResourceKind.SKILL, resourceId: " resource-one", resourceVersion: 1n, runtimeGeneration: 1n },
    { sessionId: "session-one", kind: ResourceKind.SKILL, discoveredRevision: "revision-one\n", resourceVersion: 1n, runtimeGeneration: 1n },
    { sessionId: "session-one", kind: ResourceKind.SKILL, resourceVersion: 0n, runtimeGeneration: 1n },
    { sessionId: "session-one", kind: ResourceKind.SKILL, resourceVersion: 1n, runtimeGeneration: 0n }
  ])("rejects an invalid task catalog identity", async (invalid) => {
    const transport = resourceTransport(() => create(ListSessionResourcesResponseSchema, {
      resources: [{
        resourceId: "resource-one",
        name: "Resource",
        discoveredRevision: "revision-one",
        ...invalid
      }]
    }));
    const gateway = createOrchestratorGateway(
      { id: "connection-resource", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();
    await expect(gateway.listSessionResources("session-one")).rejects.toThrow("invalid task resource identity");
    gateway.disconnect();
  });
});

function resourceTransport(catalog: () => unknown): Transport {
  return {
    unary: vi.fn(async (method: any) => {
      if (method.localName === "getSnapshot") return response(method, create(GetSnapshotResponseSchema, {
        snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
      }));
      if (method.localName === "listSessionResources") return response(method, catalog());
      throw new Error(`Unexpected method: ${method.localName}`);
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
