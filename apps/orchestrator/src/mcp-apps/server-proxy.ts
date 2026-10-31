import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema, ListToolsRequestSchema, CancelledNotificationSchema, SetLevelRequestSchema, ResultSchema,
  ErrorCode, McpError, isJSONRPCErrorResponse, isJSONRPCRequest, isJSONRPCResultResponse,
  type CallToolRequest, type CallToolResult, type CreateTaskResult, type ClientRequest, type ClientNotification,
  type Progress, type Request, type RequestId, type ServerCapabilities, type ServerRequest, type ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { AppConnection } from "./connection.js";
import { toolVisibleTo } from "./protocol.js";

export type McpModelRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
export interface McpModelChannel {
  readonly connection: AppConnection;
  assertCurrent(): void;
  release(): Promise<void>;
}
interface FrozenTool {
  readonly name: string; readonly description: string; readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}
interface Options {
  readonly name: string;
  readonly tools: readonly FrozenTool[];
  readonly open: (peer: NonNullable<ConstructorParameters<typeof AppConnection>[1]>) => McpModelChannel | undefined;
  readonly callTool: (request: CallToolRequest, extra: McpModelRequestExtra, connection: AppConnection) => Promise<CallToolResult | CreateTaskResult>;
  readonly redact: <T>(value: T) => T;
}

/** Preserve the SDK handshake while advertising only the actual upstream.
 * The internal capability superset permits forwarding ordinary MCP methods. */
class ModelProxyServer extends McpServer {
  constructor(name: string, private readonly readInitialize: () => Promise<{ instructions?: string; capabilities: ServerCapabilities }>) {
    super({ name, version: "0.1.0" }, { capabilities: {
      tools: { listChanged: true }, resources: { listChanged: true, subscribe: true }, prompts: { listChanged: true },
      completions: {}, logging: {}, tasks: { requests: { tools: { call: {} } } },
    } });
  }
  override connect(transport: Transport): Promise<void> {
    const initializing = new Set<RequestId>();
    const wrapped: Transport = {
      get sessionId() { return transport.sessionId; },
      setProtocolVersion: version => transport.setProtocolVersion?.(version),
      start: async () => {
        const onmessage = transport.onmessage, onerror = transport.onerror, onclose = transport.onclose;
        transport.onmessage = (message, extra) => {
          if (isJSONRPCRequest(message) && message.method === "initialize") initializing.add(message.id);
          onmessage?.(message, extra); wrapped.onmessage?.(message, extra);
        };
        transport.onerror = error => { onerror?.(error); wrapped.onerror?.(error); };
        transport.onclose = () => { initializing.clear(); onclose?.(); wrapped.onclose?.(); };
        await transport.start();
      },
      send: async (message, options?: TransportSendOptions) => {
        if (isJSONRPCResultResponse(message) && initializing.delete(message.id)) {
          try { message = { ...message, result: { ...message.result, ...await this.readInitialize() } }; }
          catch { message = { jsonrpc: "2.0", id: message.id, error: { code: ErrorCode.InternalError, message: "MCP_INITIALIZE_FAILED" } }; }
        } else if (isJSONRPCErrorResponse(message) && message.id !== undefined) initializing.delete(message.id);
        await transport.send(message, options);
      },
      close: () => transport.close(),
    };
    return super.connect(wrapped);
  }
}

/** One native protocol peer owns one upstream client and its callback capability
 * negotiation. Tool execution still goes through the existing product bridge. */
export function createMcpModelProxy(options: Options): McpServer | undefined {
  let server: ModelProxyServer;
  const channel = options.open({
    capabilities: () => server.server.getClientCapabilities() ?? {},
    request: async (request, extra) => {
      channel!.assertCurrent();
      const token = request.params?._meta?.progressToken;
      const result = await server.server.request(request as ServerRequest, ResultSchema, {
        signal: extra.signal,
        ...(token === undefined ? {} : { onprogress: (progress: Progress) => {
          try { channel!.assertCurrent(); } catch { return; }
          void extra.sendNotification({ method: "notifications/progress", params: { ...progress, progressToken: token } }).catch(() => {});
        } }),
      });
      channel!.assertCurrent(); return result;
    },
  });
  if (!channel) return;
  const currentClient = async (signal?: AbortSignal) => {
    channel.assertCurrent(); const client = await channel.connection.getClient(signal); channel.assertCurrent(); signal?.throwIfAborted(); return client;
  };
  server = new ModelProxyServer(options.name, async () => {
    const client = await currentClient();
    return options.redact({ capabilities: client.getServerCapabilities() ?? {}, instructions: client.getInstructions() });
  });
  const pending = new Map<RequestId, AbortController>();
  const handle = <T>(work: (request: Request, extra: McpModelRequestExtra) => Promise<T>) => async (request: Request, extra: McpModelRequestExtra): Promise<T> => {
    const abort = new AbortController(); pending.set(extra.requestId, abort);
    try { channel.assertCurrent(); return await work(request, { ...extra, signal: AbortSignal.any([extra.signal, abort.signal]) }); }
    catch (error) {
      const message = options.redact(error instanceof Error ? error.message : "MCP_REQUEST_FAILED");
      throw error instanceof McpError ? new McpError(error.code, message, error.data === undefined ? undefined : options.redact(error.data)) : new Error(message);
    }
    finally { if (pending.get(extra.requestId) === abort) pending.delete(extra.requestId); }
  };
  // SDK 1.29 does not cancel numeric ID 0. These forwarded handlers retain the
  // exact ID rather than depending on a truthiness check in the SDK.
  server.server.setNotificationHandler(CancelledNotificationSchema, message => {
    if (message.params.requestId !== undefined) pending.get(message.params.requestId)?.abort(message.params.reason);
  });
  const requestOptions = (request: Request, extra: McpModelRequestExtra) => {
    const token = request.params?._meta?.progressToken;
    return { signal: extra.signal, ...(token === undefined ? {} : { onprogress: (progress: Progress) => {
      try { channel.assertCurrent(); } catch { return; }
      void server.server.notification({ method: "notifications/progress", params: { ...progress, progressToken: token } }, { relatedRequestId: extra.requestId }).catch(() => {});
    } }) };
  };
  const forward = handle(async (request, extra) => {
    const client = await currentClient(extra.signal), result = await client.request(request as ClientRequest, ResultSchema, requestOptions(request, extra));
    channel.assertCurrent();
    // Tool-result root metadata belongs to Views, including task results.
    if (request.method === "tasks/result") { const model = { ...result }; delete model._meta; return options.redact(model); }
    return options.redact(result);
  });
  server.server.fallbackRequestHandler = forward;
  server.server.fallbackNotificationHandler = async message => {
    const client = await currentClient(); await client.notification(message as ClientNotification); channel.assertCurrent();
  };
  server.server.setRequestHandler(SetLevelRequestSchema, forward);
  const frozen = new Map(options.tools.map(tool => [tool.name, tool]));
  server.server.setRequestHandler(ListToolsRequestSchema, handle(async (_request, extra) => {
    const tools = await channel.connection.tools(extra.signal); channel.assertCurrent();
    return options.redact({ tools: tools.filter(tool => frozen.has(tool.name) && toolVisibleTo(tool, "model")).map(tool => {
      const schema = frozen.get(tool.name)!;
      const { outputSchema: _upstreamOutputSchema, ...metadata } = tool;
      return { ...metadata, description: schema.description, inputSchema: { ...schema.inputSchema, type: "object" as const },
        ...(schema.outputSchema === undefined ? {} : { outputSchema: { ...schema.outputSchema, type: "object" as const } }) };
    }) });
  }));
  server.server.setRequestHandler(CallToolRequestSchema, handle(async (request, extra) => {
    const parsed = CallToolRequestSchema.parse(request);
    if (!frozen.has(parsed.params.name)) throw new Error("MCP_TOOL_NOT_VISIBLE");
    const tool = (await channel.connection.tools(extra.signal)).find(tool => tool.name === parsed.params.name);
    channel.assertCurrent(); extra.signal.throwIfAborted(); if (!tool || !toolVisibleTo(tool, "model")) throw new Error("MCP_TOOL_NOT_VISIBLE");
    return options.callTool(parsed, extra, channel.connection);
  }));
  const unlisten = channel.connection.listen(message => {
    try { channel.assertCurrent(); } catch { return; }
    void server.server.notification(options.redact(message)).catch(() => {});
  });
  server.server.onclose = () => { unlisten(); for (const abort of pending.values()) abort.abort(); pending.clear(); void channel.release().catch(() => {}); };
  return server;
}
