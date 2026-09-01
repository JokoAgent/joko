import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetSnapshotResponseSchema,
  McpCredentialTarget,
  McpServerState,
  McpTransport,
  OperationState,
  SnapshotSchema,
  SubmitOperationResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway, mapSnapshot } from "./gateway.js";

describe("MCP gateway", () => {
  it("maps a complete editable configuration without projecting credential values", () => {
    const projected = mapSnapshot(create(SnapshotSchema, {
      settings: {
        agentResource: {},
        collaboration: {},
        gitSafety: {},
        mcpServers: [{
          mcpServerId: "local-tools",
          displayName: "Local tools",
          transport: McpTransport.STDIO,
          endpointDisplay: "node",
          state: McpServerState.CONNECTED,
          runtimeGeneration: 8n,
          enabled: true,
          credentialBindings: [{
            credentialReferenceId: "credential-reference-token",
            configured: true,
            target: McpCredentialTarget.ENVIRONMENT,
            targetName: "MCP_TOKEN"
          }, {
            credentialReferenceId: "credential-reference-tenant",
            configured: false,
            target: McpCredentialTarget.ENVIRONMENT,
            targetName: "MCP_TENANT"
          }],
          transportConfig: {
            case: "stdio",
            value: {
              command: "node",
              arguments: ["server.mjs", "argument with spaces"],
              workingDirectory: "D:\\workspace",
              environment: [{ name: "LOG_LEVEL", value: "info" }]
            }
          },
          version: { revision: { value: 9n } }
        }]
      }
    }));

    expect(projected.settings.mcpServers).toEqual([{
      id: "local-tools",
      name: "Local tools",
      transport: "stdio",
      endpoint: "",
      state: "connected",
      generation: 8n,
      toolCount: 0,
      credentialIds: ["credential-reference-token", "credential-reference-tenant"],
      credentialBindings: [
        { credentialId: "credential-reference-token", configured: true, target: "environment", name: "MCP_TOKEN" },
        { credentialId: "credential-reference-tenant", configured: false, target: "environment", name: "MCP_TENANT" }
      ],
      enabled: true,
      command: "node",
      arguments: ["server.mjs", "argument with spaces"],
      workingDirectory: "D:\\workspace",
      environment: [{ name: "LOG_LEVEL", value: "info" }],
      revision: 9n
    }]);
    expect(safeStringify(projected.settings.mcpServers)).not.toContain("secret-material");
  });

  it("keeps the saved ID and submits ordered bindings behind an exact revision fence", async () => {
    const payloads: any[] = [];
    const gateway = createOrchestratorGateway(
      { id: "connection", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "auth-key",
      {},
      () => operationTransport(payloads)
    );
    await gateway.connect();

    await gateway.saveMcpServer({
      id: "saved-server",
      revision: 12n,
      name: "Saved server",
      transport: "https",
      endpoint: "https://mcp.example.test/rpc",
      command: "",
      arguments: [],
      workingDirectory: "",
      environment: [],
      credentialBindings: [
        { target: "header", name: "Authorization", credentialId: "credential-reference-token" },
        { target: "header", name: "X-Tenant", credentialId: "credential-reference-tenant" }
      ],
      enabled: true
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      case: "upsertMcpServer",
      value: {
        mcpServerId: "saved-server",
        expectedRevision: { value: 12n },
        server: {
          displayName: "Saved server",
          credentialBindings: [
            { target: McpCredentialTarget.HEADER, targetName: "Authorization", credentialReferenceId: "credential-reference-token" },
            { target: McpCredentialTarget.HEADER, targetName: "X-Tenant", credentialReferenceId: "credential-reference-tenant" }
          ]
        }
      }
    });
    expect(safeStringify(payloads[0])).not.toContain("secret-material");
    gateway.disconnect();
  });

  it("rejects duplicate binding targets before any durable operation is submitted", async () => {
    const payloads: any[] = [];
    const gateway = createOrchestratorGateway(
      { id: "connection", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "auth-key",
      {},
      () => operationTransport(payloads)
    );
    await gateway.connect();

    await expect(gateway.saveMcpServer({
      id: "saved-server",
      revision: 12n,
      name: "Saved server",
      transport: "https",
      endpoint: "https://mcp.example.test/rpc",
      command: "",
      arguments: [],
      workingDirectory: "",
      environment: [],
      credentialBindings: [
        { target: "header", name: "Authorization", credentialId: "credential-reference-token" },
        { target: "header", name: "authorization", credentialId: "credential-reference-other" }
      ],
      enabled: true
    })).rejects.toThrow(/unique/u);
    expect(payloads).toHaveLength(0);
    gateway.disconnect();
  });
});

function operationTransport(payloads: any[]): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") {
        return response(method, create(GetSnapshotResponseSchema, {
          snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
        }));
      }
      if (method.localName === "submitOperation") {
        payloads.push(input.mutation.payload);
        return response(method, create(SubmitOperationResponseSchema, {
          operation: { operationId: input.operationId, connectionId: input.connectionId, state: OperationState.SUCCEEDED }
        }));
      }
      throw new Error(`Unexpected method: ${method.localName}`);
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function response(method: any, message: unknown, stream = false): any {
  return stream
    ? { stream: true, service: method.parent, method, header: new Headers(), trailer: new Headers(), message }
    : { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncGenerator<never, void, unknown> {
  await new Promise<void>(() => undefined);
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString(10) : item);
}
