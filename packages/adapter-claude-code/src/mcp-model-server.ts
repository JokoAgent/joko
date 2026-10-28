import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** A Query-owned standard protocol endpoint. Credentials and upstream clients
 * stay with its owner; native runtimes receive only this transport capability. */
export interface ClaudeSdkMcpModelServer {
  readonly serverId: string;
  connect(transport: Transport): Promise<void>;
}

class ModelEndpointServer extends McpServer {
  #transport: Transport | undefined;
  constructor(name: string, private readonly endpoint: ClaudeSdkMcpModelServer) { super({ name, version: "0.1.0" }); }
  override async connect(transport: Transport): Promise<void> {
    await this.#transport?.close(); this.#transport = transport;
    const closed = transport.onclose;
    transport.onclose = () => { if (this.#transport === transport) this.#transport = undefined; closed?.(); };
    try { await this.endpoint.connect(transport); }
    catch (error) { await transport.close().catch(() => {}); throw error; }
  }
  override async close(): Promise<void> { const transport = this.#transport; this.#transport = undefined; await transport?.close(); }
}

export function createProductMcpModelServers(endpoints: readonly ClaudeSdkMcpModelServer[], serverName: (serverId: string) => string) {
  const servers: Record<string, { type: "sdk"; name: string; instance: McpServer }> = Object.create(null);
  for (const endpoint of endpoints) {
    const name = serverName(endpoint.serverId);
    if (Object.hasOwn(servers, name)) throw new Error("The product MCP model identity is ambiguous.");
    servers[name] = { type: "sdk", name, instance: new ModelEndpointServer(name, endpoint) };
  }
  return servers;
}
