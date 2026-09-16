import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeMcpBridge } from "./claude-mcp-bridge.js";
import { CredentialManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { McpRouter, type BridgeToolCallContext } from "./mcp-router.js";
import { mkdtemp } from "./test-paths.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup())); });

describe("Claude product MCP Router bridge", () => {
  it("requires a durable Session, forwards exact schema/result without exposing the Router bearer, and retires on scope loss", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-claude-mcp-"));
    const store = new OperationalStore(join(root, "orchestrator.db"));
    const vault = await CredentialVault.open(join(root, "vault.key"));
    const credentials = new CredentialManager({ vault, storagePath: join(root, "credentials.json") });
    await credentials.initialize();
    const router = new McpRouter({ store, credentials });
    await router.initialize();
    cleanups.push(async () => { await router.dispose(); store.close(); await rm(root, { recursive: true, force: true }); });
    store.upsertBackend({
      id: "claude-code", displayName: "Claude", version: "test", health: "healthy", adapterKind: "fixture",
      instanceGeneration: 1, installationState: "installed", authenticationState: "authenticated",
      capabilities: new Map(), models: [], tools: [], diagnostics: []
    });
    store.upsertTarget({
      id: "target-local", backendId: "claude-code", displayName: "Local", workspaceRoot: root,
      managed: false, trusted: true
    });
    const calls: BridgeToolCallContext[] = [];
    router.registerBridgeToolProvider({
      id: "approved-tools", generation: 1, available: true,
      tools: [{
        serverId: "approved-tools", name: "echo", description: "Echo one value",
        inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        outputSchema: { type: "object", properties: { echoed: { type: "string" } }, required: ["echoed"] },
        requiresPermission: false
      }],
      callTool: async (_name, arguments_, _signal, context) => {
        calls.push(context);
        const echoed = String(arguments_["value"] ?? "");
        return { content: [{ type: "text", text: echoed }], structuredContent: { echoed }, isError: false };
      }
    });
    const bridge = createClaudeMcpBridge({
      router,
      includeToolPolicy: () => true,
      assertSessionCurrent: (sessionId, targetId, generation) => {
        const session = store.getSession(sessionId).descriptor;
        if (session.targetId !== targetId || session.binding.generation !== generation || session.deletedAt !== undefined) {
          throw new Error("The Session is stale.");
        }
      }
    });
    const open = () => bridge.open({
      sessionId: "session-local", targetId: "target-local", generation: 1,
      signal: new AbortController().signal
    });
    expect(open).toThrow();
    store.createSession({
      id: "session-local", backendId: "claude-code", targetId: "target-local", title: "Local",
      binding: { opaqueRef: "native-uuid", generation: 1 }, pinned: false, archived: false,
      permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1
    });
    const lease = open();
    expect(lease.tools).toMatchObject([{
      serverId: "approved-tools", name: "echo", inputSchema: { type: "object" }, outputSchema: { type: "object" }
    }]);
    expect(JSON.stringify(lease)).not.toContain("Bearer");
    expect(await lease.call({
      serverId: "approved-tools", toolName: "echo", requestId: "native-tool-use-one",
      arguments: { value: "approved" }, signal: new AbortController().signal
    })).toMatchObject({ content: [{ type: "text", text: "approved" }], structuredContent: { echoed: "approved" }, isError: false });
    expect(calls).toHaveLength(1);
    lease.release();
    await expect(lease.call({
      serverId: "approved-tools", toolName: "echo", requestId: "late-tool",
      arguments: { value: "late" }, signal: new AbortController().signal
    })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
