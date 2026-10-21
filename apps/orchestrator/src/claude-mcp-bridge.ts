import type { ClaudeMcpBridgePort, ClaudeMcpRuntimeLease } from "@joko/adapter-claude-code";
import { randomUUID } from "node:crypto";
import { operationBodyHash } from "@joko/store";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CreateTaskResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { McpRouter } from "./mcp-router.js";
import { createMcpModelProxy } from "./mcp-apps/server-proxy.js";

const GRANT_TTL_MS = 60_000;

/** The Router bearer never crosses the service/Adapter boundary. */
export function createClaudeMcpBridge(options: {
  readonly router: McpRouter;
  readonly assertSessionCurrent: (sessionId: string, targetId: string, generation: number) => void;
  readonly includeToolPolicy: (sessionId: string, targetId: string, policyId: string) => boolean;
}): ClaudeMcpBridgePort {
  return {
    open(input): ClaudeMcpRuntimeLease {
      input.signal.throwIfAborted();
      options.assertSessionCurrent(input.sessionId, input.targetId, input.generation);
      const snapshot = options.router.createPiBridgeSnapshot({
        endpoint: "http://127.0.0.1/claude-mcp",
        sessionId: input.sessionId,
        targetId: input.targetId,
        expectedPiGeneration: input.generation,
        ttlMs: GRANT_TTL_MS,
        includeToolPolicy: (policyId) => options.includeToolPolicy(input.sessionId, input.targetId, policyId)
      });
      let released = false;
      const models = new Set<McpServer>();
      const pending = new Map<string, { serverId: string; invocation: NonNullable<Parameters<McpRouter["executeBridgeCall"]>[0]["appCall"]>; claimed: boolean; signal: AbortSignal }>();
      let renewal: ReturnType<typeof setInterval> | undefined;
      const release = (): void => {
        if (released) return;
        released = true;
        if (renewal !== undefined) clearInterval(renewal);
        snapshot.revoke();
        pending.clear();
        for (const model of models) void model.close().catch(() => {});
        models.clear();
      };
      const assertCurrent = (): void => {
        if (released) throw new Error("The MCP Query authority is retired.");
        input.signal.throwIfAborted();
        options.assertSessionCurrent(input.sessionId, input.targetId, input.generation);
        snapshot.assertCurrent();
      };
      const hasServers = snapshot.mcpBridge.tools.length > 0 || snapshot.modelServerIds.length > 0;
      if (hasServers) {
        renewal = setInterval(() => {
          try { assertCurrent(); snapshot.renew(GRANT_TTL_MS); }
          catch { release(); }
        }, GRANT_TTL_MS / 2);
        renewal.unref();
      } else {
        snapshot.revoke();
      }
      return {
        tools: snapshot.mcpBridge.tools.map((tool) => ({
          serverId: tool.serverId,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema })
        })),
        models: snapshot.modelServerIds.map(serverId => ({ serverId, connect: async (transport, callNative) => {
          assertCurrent();
          const tools = snapshot.mcpBridge.tools.filter(tool => tool.serverId === serverId), validator = new AjvJsonSchemaValidator();
          const validators = new Map(tools.map(tool => [tool.name, {
            input: validator.getValidator(tool.inputSchema as Parameters<typeof validator.getValidator>[0]),
            output: tool.outputSchema === undefined ? undefined : validator.getValidator(tool.outputSchema as Parameters<typeof validator.getValidator>[0]),
          }]));
          const model = createMcpModelProxy({ name: `joko-claude-${serverId}`, tools,
            open: peer => options.router.createAppModelChannel(snapshot, serverId, peer, assertCurrent),
            redact: value => options.router.redactModelValue(value),
            callTool: async (request, extra, connection) => {
              assertCurrent(); extra.signal.throwIfAborted();
              const toolUseId = request.params._meta?.["claudecode/toolUseId"], checks = validators.get(request.params.name), args = request.params.arguments ?? {};
              if (typeof toolUseId !== "string" || toolUseId.length === 0 || toolUseId.length > 512 || /[\x00-\x1f\x7f]/u.test(toolUseId)) throw new Error("MCP tool has no native owner.");
              if (!checks?.input(args).valid) throw new Error("MCP tool arguments do not satisfy the frozen schema.");
              const progressToken = request.params._meta?.progressToken, modelCallId = randomUUID();
              pending.set(modelCallId, { serverId, claimed: false, signal: extra.signal, invocation: { connection, params: request.params,
                ...(progressToken === undefined ? {} : { onprogress: progress => {
                  try { assertCurrent(); extra.signal.throwIfAborted(); } catch { return; }
                  void extra.sendNotification({ method: "notifications/progress", params: { ...progress, progressToken } }).catch(() => {});
                } }),
              } });
              try {
                const result = await callNative({ toolName: request.params.name, arguments: args, toolUseId, signal: extra.signal, modelCallId });
                assertCurrent(); extra.signal.throwIfAborted();
                if (request.params.task) {
                  if (result.isError) throw new Error("MCP task delegation failed.");
                  return CreateTaskResultSchema.parse(result.taskResult);
                }
                if (!result.isError && checks.output && !checks.output(result.structuredContent).valid) throw new Error("MCP result does not satisfy the frozen schema.");
                return { content: [...result.content] as import("@modelcontextprotocol/sdk/types.js").CallToolResult["content"], isError: result.isError,
                  ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
                  ...(result.bridgeMetadata === undefined ? {} : { _meta: { jokoMcpBridge: result.bridgeMetadata } }),
                };
              } finally { pending.delete(modelCallId); }
            },
          });
          if (!model) throw new Error("The MCP model server is unavailable.");
          const closed = model.server.onclose;
          model.server.onclose = () => { models.delete(model); closed?.(); };
          models.add(model);
          try { await model.connect(transport); assertCurrent(); }
          catch (error) { await model.close().catch(() => {}); throw error; }
        } })),
        assertCurrent: () => {
          if (!hasServers) {
            if (released) throw new Error("The MCP Query authority is retired.");
            options.assertSessionCurrent(input.sessionId, input.targetId, input.generation);
          } else assertCurrent();
        },
        call: async (call) => {
          assertCurrent();
          const original = call.modelCallId === undefined ? undefined : pending.get(call.modelCallId);
          const signal = AbortSignal.any([input.signal, call.signal, ...(original ? [original.signal] : [])]);
          signal.throwIfAborted();
          if (call.modelCallId !== undefined) {
            if (!original || original.claimed || original.serverId !== call.serverId || original.invocation.params.name !== call.toolName
              || operationBodyHash(original.invocation.params.arguments ?? {}) !== operationBodyHash(call.arguments)) throw new Error("The MCP model call is outside its original request.");
            original.signal.throwIfAborted(); original.claimed = true;
          }
          const result = await options.router.executeBridgeCall({
            authorization: `Bearer ${snapshot.mcpBridge.token}`,
            requestId: call.requestId,
            generation: input.generation,
            sessionId: input.sessionId,
            targetId: input.targetId,
            serverId: call.serverId,
            toolName: call.toolName,
            arguments: call.arguments,
            signal,
            ...(original === undefined ? {} : { appCall: original.invocation }),
            ...(call.partnerLearningAuthority === undefined ? {} : { partnerLearningAuthority: call.partnerLearningAuthority })
          });
          signal.throwIfAborted();
          assertCurrent();
          if (original?.invocation.params.task && !result.isError) return { content: [], isError: false, taskResult: CreateTaskResultSchema.parse(result.details?.["mcpTask"]) };
          const structured = result.details?.["mcpStructuredContent"];
          return {
            content: result.content.length > 0
              ? result.content
              : result.error === undefined ? [] : [{ type: "text", text: result.error }],
            isError: result.isError,
            ...(structured !== null && typeof structured === "object" && !Array.isArray(structured)
              ? { structuredContent: structured as Readonly<Record<string, unknown>> }
              : {}),
            ...(result.details?.["jokoMcpBridge"] === undefined
              ? {}
              : { bridgeMetadata: result.details["jokoMcpBridge"] })
          };
        },
        release
      };
    }
  };
}
