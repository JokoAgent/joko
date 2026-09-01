import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetSnapshotResponseSchema,
  ListManagedModelRuntimesResponseSchema,
  OperationState,
  SnapshotSchema,
  SubmitOperationResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";
import type { ResourceDraft } from "./model.js";

describe("Pi resource acquisition gateway", () => {
  it("encodes local, npm, and Git drafts as typed acquisition oneofs", async () => {
    const submitted: any[] = [];
    const transport = operationTransport(submitted);
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    const drafts: readonly ResourceDraft[] = [
      {
        backendId: "pi",
        kind: "skill",
        scope: "managed",
        source: { kind: "local", serverPath: "D:\\pi-resources\\skill" },
        name: "Local skill",
        version: ""
      },
      {
        backendId: "pi",
        kind: "package",
        scope: "global",
        source: { kind: "npm", packageName: "@joko/example", versionSpec: "^1.2.0" },
        name: "Npm package",
        version: "1.2.0"
      },
      {
        backendId: "pi",
        kind: "package",
        scope: "user",
        source: { kind: "git", repositoryUrl: "https://example.test/org/repo.git", ref: "main", subdirectory: "packages/agent" },
        name: "Git package",
        version: ""
      }
    ];
    for (const draft of drafts) await gateway.addResource(draft);

    expect(submitted.map((payload) => payload.case)).toEqual(["addResource", "addResource", "addResource"]);
    expect(submitted[0]?.value).toMatchObject({
      backendId: "pi",
      acquisition: { source: { case: "local", value: { serverPath: "D:\\pi-resources\\skill" } } }
    });
    expect(submitted[1]?.value).toMatchObject({
      name: "Npm package",
      version: "1.2.0",
      acquisition: { source: { case: "npm", value: { packageName: "@joko/example", versionSpec: "^1.2.0" } } }
    });
    expect(submitted[2]?.value).toMatchObject({
      acquisition: { source: { case: "git", value: { repositoryUrl: "https://example.test/org/repo.git", ref: "main", subdirectory: "packages/agent" } } }
    });
    for (const payload of submitted) expect(payload.value).not.toHaveProperty("serverPath");
    gateway.disconnect();
  });

  it("rejects a remote source for a non-package resource before submission", async () => {
    const submitted: any[] = [];
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => operationTransport(submitted)
    );
    await gateway.connect();

    await expect(gateway.addResource({
      backendId: "pi",
      kind: "skill",
      scope: "managed",
      source: { kind: "npm", packageName: "example", versionSpec: "" },
      name: "",
      version: ""
    })).rejects.toThrow("source is invalid");
    expect(submitted).toEqual([]);
    gateway.disconnect();
  });
});

function operationTransport(submitted: any[]): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") {
        return response(method, create(GetSnapshotResponseSchema, {
          snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
        }));
      }
      if (method.localName === "listManagedModelRuntimes") {
        return response(method, create(ListManagedModelRuntimesResponseSchema, {}));
      }
      if (method.localName === "submitOperation") {
        submitted.push(input.mutation.payload);
        return response(method, create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            connectionId: input.connectionId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "acknowledgement", value: { accepted: true } } }
          }
        }));
      }
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
