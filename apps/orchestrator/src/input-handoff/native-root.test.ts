import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialManager } from "../credential-manager.js";
import { CredentialVault } from "../credential-vault.js";
import { McpRouter, type BridgeToolCallContext } from "../mcp-router.js";
import { createClaudeMcpBridge } from "../claude-mcp-bridge.js";
import { mkdtemp } from "../test-paths.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-owner-root-")), store = new OperationalStore(join(root, "store.db"));
  const vault = await CredentialVault.open(join(root, "vault")), credentials = new CredentialManager({ vault, storagePath: join(root, "credentials.json") }); await credentials.initialize();
  let now = 1;
  const router = new McpRouter({ store, credentials, now: () => now }); await router.initialize();
  cleanup.push(async () => { await router.dispose(); store.close(); await rm(root, { recursive: true, force: true }); });
  store.upsertBackend({ id: "native", displayName: "Native", version: "test", health: "healthy", adapterKind: "fixture", instanceGeneration: 1, installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId: "native", displayName: "Local", workspaceRoot: root, managed: false, trusted: true });
  store.createSession({ id: "session", backendId: "native", targetId: "target", title: "Local", binding: { opaqueRef: "native-session", generation: 1 }, pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  const calls: BridgeToolCallContext[] = [];
  router.registerBridgeToolProvider({ id: "owner_input", generation: 1, available: true,
    tools: [{ serverId: "owner_input", name: "request", description: "Request", inputSchema: { type: "object" }, requiresPermission: false, requiresNativeRoot: true }],
    async callTool(_name, _args, _signal, context) { if (!context.assertNativeRoot) throw new Error("Missing root proof"); context.assertNativeRoot(); calls.push(context); return { content: [{ type: "text", text: "pending" }], isError: false }; } });
  const snapshot = () => router.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1/bridge", sessionId: "session", targetId: "target", expectedPiGeneration: 1, ttlMs: 60_000 });
  return { router, store, calls, snapshot, setNow: (value: number) => { now = value; } };
}
describe("owner tool native-root proof", () => {
  it("rejects the same bearer without proof and binds one proof to the exact body, grant and call", async () => {
    const f = await fixture(), snapshot = f.snapshot(), args = { purpose: "Original" };
    const request = { authorization: `Bearer ${snapshot.mcpBridge.token}`, sessionId: "session", targetId: "target", generation: 1, requestId: "native-1", serverId: "owner_input", toolName: "request", arguments: args };
    await expect(f.router.executeBridgeCall(request)).rejects.toThrow("root");
    const nativeRootProof = snapshot.mcpBridge.captureRootCall!({ requestId: "native-1", serverId: "owner_input", toolName: "request", arguments: args, assertCurrent: () => {} });
    await expect(f.router.executeBridgeCall({ ...request, nativeRootProof, arguments: { purpose: "Changed" } })).rejects.toThrow("root");
    const other = f.snapshot(); await expect(f.router.executeBridgeCall({ ...request, nativeRootProof, authorization: `Bearer ${other.mcpBridge.token}` })).rejects.toThrow("root");
    expect(await f.router.executeBridgeCall({ ...request, nativeRootProof })).toMatchObject({ isError: false });
    await expect(f.router.executeBridgeCall({ ...request, nativeRootProof })).rejects.toThrow("root"); expect(f.calls).toHaveLength(1);
  });
  it("retires expired and aborted native turns without touching the provider", async () => {
    const f = await fixture(), snapshot = f.snapshot(), input = { requestId: "native-1", serverId: "owner_input", toolName: "request", arguments: {} };
    let active = true; const assertCurrent = () => { if (!active) throw new Error("Native turn retired"); };
    const nativeRootProof = snapshot.mcpBridge.captureRootCall!({ ...input, assertCurrent }); active = false;
    const request = { ...input, authorization: `Bearer ${snapshot.mcpBridge.token}`, generation: 1, sessionId: "session", targetId: "target" };
    await expect(f.router.executeBridgeCall({ ...request, nativeRootProof })).rejects.toThrow("retired");
    active = true; const expired = snapshot.mcpBridge.captureRootCall!({ ...input, assertCurrent }); f.setNow(31_001);
    await expect(f.router.executeBridgeCall({ ...request, nativeRootProof: expired })).rejects.toThrow("root"); expect(f.calls).toHaveLength(0);
  });
  it("uses the same root gate for the private Claude lease without giving the adapter a router bearer", async () => {
    const f = await fixture(), bridge = createClaudeMcpBridge({ router: f.router, includeToolPolicy: () => true, assertSessionCurrent: () => {} });
    const lease = bridge.open({ sessionId: "session", targetId: "target", generation: 1, signal: new AbortController().signal });
    expect(lease.tools[0]?.requiresNativeRoot).toBe(true);
    const request = { serverId: "owner_input", toolName: "request", requestId: "native-root", arguments: { purpose: "Original" }, signal: new AbortController().signal };
    await expect(lease.call(request)).rejects.toThrow("root");
    expect(await lease.call({ ...request, nativeRootCall: { arguments: request.arguments, assertCurrent: () => {} } })).toMatchObject({ isError: false });
    lease.release(); expect(f.calls).toHaveLength(1);
  });
});
