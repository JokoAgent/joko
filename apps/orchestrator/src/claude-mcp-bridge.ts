import type { ClaudeMcpBridgePort, ClaudeMcpRuntimeLease } from "@joko/adapter-claude-code";
import type { McpRouter } from "./mcp-router.js";

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
      let renewal: ReturnType<typeof setInterval> | undefined;
      const release = (): void => {
        if (released) return;
        released = true;
        if (renewal !== undefined) clearInterval(renewal);
        snapshot.revoke();
      };
      const assertCurrent = (): void => {
        if (released) throw new Error("The MCP Query authority is retired.");
        input.signal.throwIfAborted();
        options.assertSessionCurrent(input.sessionId, input.targetId, input.generation);
        snapshot.assertCurrent();
      };
      if (snapshot.mcpBridge.tools.length > 0) {
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
        assertCurrent: () => {
          if (snapshot.mcpBridge.tools.length === 0) {
            if (released) throw new Error("The MCP Query authority is retired.");
            options.assertSessionCurrent(input.sessionId, input.targetId, input.generation);
          } else assertCurrent();
        },
        call: async (call) => {
          assertCurrent();
          const signal = AbortSignal.any([input.signal, call.signal]);
          signal.throwIfAborted();
          const result = await options.router.executeBridgeCall({
            authorization: `Bearer ${snapshot.mcpBridge.token}`,
            requestId: call.requestId,
            generation: input.generation,
            sessionId: input.sessionId,
            targetId: input.targetId,
            serverId: call.serverId,
            toolName: call.toolName,
            arguments: call.arguments,
            signal
          });
          signal.throwIfAborted();
          assertCurrent();
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
