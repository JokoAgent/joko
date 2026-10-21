import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListResourcesRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { claudeMcpServerName, createProductMcpServers } from "./sdk-runtime.js";
import { createProductMcpModelServers } from "./mcp-model-server.js";

describe("Claude product MCP SDK server", () => {
  it("connects a native SDK instance to the actual resource-only protocol endpoint", async () => {
    const protocol = new Server({ name: "actual-resource-service", version: "1" }, { capabilities: { resources: {} }, instructions: "Read the resource." });
    protocol.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: "data://fixture/value", name: "Value" }] }));
    const servers = createProductMcpModelServers([{ serverId: "resource-service", connect: transport => protocol.connect(transport) }], claudeMcpServerName);
    const server = servers[claudeMcpServerName("resource-service")]!.instance;
    const client = new Client({ name: "native-model", version: "1" }, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(b), client.connect(a)]);
      expect(client.getServerCapabilities()).toEqual({ resources: {} });
      expect(client.getInstructions()).toBe("Read the resource.");
      expect((await client.listResources()).resources).toEqual([{ uri: "data://fixture/value", name: "Value" }]);
    } finally { await Promise.allSettled([client.close(), server.close(), protocol.close()]); }
  });
  it("advertises the frozen schema and preserves structured results through a standard client", async () => {
    const call = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "approved" }],
      structuredContent: { echoed: "approved" },
      isError: false
    }));
    const tools = createProductMcpServers([{
      serverId: "approved-tools", name: "echo", description: "Echo the approved value",
      inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      outputSchema: { type: "object", properties: { echoed: { type: "string" } }, required: ["echoed"], additionalProperties: false },
      call
    }]);
    const name = claudeMcpServerName("approved-tools");
    expect(Object.keys(tools)).toEqual([name]);
    const client = new Client({ name: "approved-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(clientTransport), tools[name]!.instance.connect(serverTransport)]);
      expect((await client.listTools()).tools[0]).toMatchObject({ name: "echo" });
      expect((await client.listTools()).tools[0]?.inputSchema).toEqual({
        type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false
      });
      expect((await client.listTools()).tools[0]?.outputSchema).toEqual({
        type: "object", properties: { echoed: { type: "string" } }, required: ["echoed"], additionalProperties: false
      });
      expect(await client.callTool({
        name: "echo", arguments: { value: "hello" }, _meta: { "claudecode/toolUseId": "native-tool-one" }
      })).toMatchObject({
        content: [{ type: "text", text: "approved" }],
        structuredContent: { echoed: "approved" }, isError: false
      });
      expect(call).toHaveBeenCalledWith({ value: "hello" }, expect.objectContaining({ toolUseId: "native-tool-one" }));
      expect(await client.callTool({
        name: "echo", arguments: { value: "hello", unauthorized: true }, _meta: { "claudecode/toolUseId": "native-tool-two" }
      })).toMatchObject({ isError: true });
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.allSettled([client.close(), tools[name]!.instance.close()]);
    }
  });
});
