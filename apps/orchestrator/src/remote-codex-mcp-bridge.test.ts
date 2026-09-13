import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CodexRemoteMcpOpenInput } from "@joko/adapter-codex";
import type { RemoteForwardingTransportPort } from "@joko/remote-ssh";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { McpRouter, type BridgeToolCallContext, type BridgeToolProvider } from "./mcp-router.js";
import { RemoteCodexMcpBridgeManager } from "./remote-codex-mcp-bridge.js";
import { mkdtemp } from "./test-paths.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("RemoteCodexMcpBridgeManager", () => {
  it("keeps remote text usable without SSH forwarding when the frozen tool snapshot is empty", async () => {
    const fixture = await createFixture();
    const assertForwardingCurrent = vi.fn(() => { throw new Error("No forwarding authority should be required."); });
    const bridge = await fixture.manager.open({
      assertCurrent: () => undefined,
      assertForwardingCurrent
    }, {
      sessionId: "session-remote",
      targetId: "target-remote",
      generation: 1,
      threadId: "native-root",
      assertSessionCurrent: () => undefined,
      beginToolCall: () => { throw new Error("No tool call expected."); }
    });

    expect(bridge.routes).toEqual([]);
    expect(() => bridge.assertCurrent()).not.toThrow();
    expect(assertForwardingCurrent).not.toHaveBeenCalled();
    await bridge.release();
    expect(() => bridge.assertCurrent()).toThrow();
  });

  it("serves a standard private route while preserving the frozen product and native-turn authority", async () => {
    const fixture = await createFixture();
    const calls: BridgeToolCallContext[] = [];
    const unregister = fixture.router.registerBridgeToolProvider(provider(calls));
    const closeForward = vi.fn(async () => undefined);
    const forwarded: Array<{ readonly localDestinationPort: number }> = [];
    const forwarding: RemoteForwardingTransportPort = {
      open: async () => { throw new Error("Unexpected local-to-remote forward."); },
      listen: async (request) => {
        forwarded.push({ localDestinationPort: request.localDestinationPort });
        return { remoteHost: "127.0.0.1", remotePort: request.localDestinationPort, close: closeForward };
      }
    };
    let authorityCurrent = true;
    let turnActive = true;
    const activeCalls = new Set<AbortController>();
    const input: CodexRemoteMcpOpenInput = {
      sessionId: "session-remote",
      targetId: "target-remote",
      generation: 1,
      threadId: "native-root",
      assertSessionCurrent: () => { if (!authorityCurrent) throw new Error("Session changed"); },
      beginToolCall: (threadId) => {
        if (threadId !== "native-root" || !turnActive) throw new Error("Native turn is inactive");
        const abort = new AbortController();
        activeCalls.add(abort);
        return {
          signal: abort.signal,
          assertCurrent: () => {
            if (!authorityCurrent || !turnActive || !activeCalls.has(abort)) throw new Error("Native turn changed");
          },
          release: () => activeCalls.delete(abort)
        };
      }
    };
    const snapshotSpy = vi.spyOn(fixture.router, "createPiBridgeSnapshot");
    const bridge = await fixture.manager.open({
      forwarding,
      assertCurrent: () => { if (!authorityCurrent) throw new Error("SSH changed"); },
      assertForwardingCurrent: () => { if (!authorityCurrent) throw new Error("SSH forward changed"); }
    }, input);
    const snapshot = snapshotSpy.mock.results[0]!.value;
    expect(bridge.routes).toHaveLength(1);
    expect(forwarded).toHaveLength(1);
    expect(bridge.routes[0]!.url).not.toContain(snapshot.mcpBridge.token);
    expect(bridge.routes[0]!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/fixture-tools$/u);

    const client = new Client({ name: "remote-codex-fixture", version: "1.0.0" }, { capabilities: {} });
    cleanups.push(async () => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.routes[0]!.url)));
    expect(await client.listTools()).toMatchObject({ tools: [{ name: "echo", description: "Echo one value" }] });
    expect(await client.callTool({
      name: "echo",
      arguments: { value: "remote result" },
      _meta: { threadId: "native-root" }
    })).toMatchObject({ content: [{ type: "text", text: "remote result" }], isError: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ sessionId: "session-remote", targetId: "target-remote", generation: 1 });
    expect(calls[0]!.requestIdentity).toMatch(/^[a-f0-9]{64}$/u);
    expect(calls[0]!.effectIdentity).toMatch(/^[a-f0-9]{64}$/u);
    expect(activeCalls).toHaveLength(0);

    await expect(client.callTool({
      name: "echo",
      arguments: { value: "foreign" },
      _meta: { threadId: "foreign-thread" }
    })).rejects.toThrow();
    await expect(client.callTool({ name: "echo", arguments: { value: "missing identity" } })).rejects.toThrow();
    expect(calls).toHaveLength(1);

    const storedSession = fixture.store.getSession("session-remote");
    fixture.store.updateSession("session-remote", { archived: true }, storedSession.revision, 2);
    await expect(client.callTool({
      name: "echo",
      arguments: { value: "stale product scope" },
      _meta: { threadId: "native-root" }
    })).rejects.toThrow();
    expect(calls).toHaveLength(1);

    unregister();
    expect(() => bridge.assertCurrent()).toThrow();
    await expect(client.listTools()).rejects.toThrow();
    await bridge.release();
    expect(closeForward).toHaveBeenCalledTimes(1);
    expect(JSON.stringify({
      events: fixture.store.listEvents({ sessionId: "session-remote" }),
      operations: fixture.store.listOperations()
    }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)).not.toContain(snapshot.mcpBridge.token);
  });

  it("cannot renew an expired grant and fails closed across the captured SSH authority", async () => {
    let now = 10_000;
    const fixture = await createFixture({ now: () => now, grantTtlMs: 1_000 });
    fixture.router.registerBridgeToolProvider(provider([]));
    let forwardingCurrent = true;
    const close = vi.fn(async () => undefined);
    const forwarding: RemoteForwardingTransportPort = {
      open: async () => { throw new Error("Unexpected local-to-remote forward."); },
      listen: async (request) => ({ remoteHost: "127.0.0.1", remotePort: request.localDestinationPort, close })
    };
    const bridge = await fixture.manager.open({
      forwarding,
      assertCurrent: () => undefined,
      assertForwardingCurrent: () => { if (!forwardingCurrent) throw new Error("forward changed"); }
    }, {
      sessionId: "session-remote",
      targetId: "target-remote",
      generation: 1,
      threadId: "native-root",
      assertSessionCurrent: () => undefined,
      beginToolCall: () => { throw new Error("No call expected."); }
    });
    forwardingCurrent = false;
    expect(() => bridge.assertCurrent()).toThrow();
    forwardingCurrent = true;
    now += 1_001;
    expect(() => bridge.assertCurrent()).toThrow();
    await bridge.release();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("propagates native-turn cancellation through the standard MCP request and suppresses its result", async () => {
    const fixture = await createFixture();
    let callAbort: AbortController | undefined;
    let providerSignal: AbortSignal | undefined;
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => { started = resolve; });
    fixture.router.registerBridgeToolProvider({
      ...provider([]),
      callTool: async (_name, _arguments, signal) => {
        providerSignal = signal;
        started();
        await new Promise<void>((resolve, reject) => {
          if (signal === undefined) return reject(new Error("Missing cancellation signal."));
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return { content: [{ type: "text", text: "must not publish" }], isError: false };
      }
    });
    const forwarding: RemoteForwardingTransportPort = {
      open: async () => { throw new Error("Unexpected local-to-remote forward."); },
      listen: async (request) => ({
        remoteHost: "127.0.0.1", remotePort: request.localDestinationPort, close: async () => undefined
      })
    };
    const bridge = await fixture.manager.open({
      forwarding,
      assertCurrent: () => undefined,
      assertForwardingCurrent: () => undefined
    }, {
      sessionId: "session-remote", targetId: "target-remote", generation: 1, threadId: "native-root",
      assertSessionCurrent: () => undefined,
      beginToolCall: () => {
        const abort = new AbortController();
        callAbort = abort;
        return {
          signal: abort.signal,
          assertCurrent: () => abort.signal.throwIfAborted(),
          release: () => undefined
        };
      }
    });
    const client = new Client({ name: "remote-cancel-fixture", version: "1.0.0" }, { capabilities: {} });
    cleanups.push(async () => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.routes[0]!.url)));
    const call = client.callTool({ name: "echo", arguments: {}, _meta: { threadId: "native-root" } });
    await providerStarted;
    callAbort!.abort();
    await expect(call).rejects.toThrow();
    expect(providerSignal?.aborted).toBe(true);
  });
});

function provider(calls: BridgeToolCallContext[]): BridgeToolProvider {
  return {
    id: "fixture-tools",
    generation: 3,
    available: true,
    tools: [{
      serverId: "fixture-tools",
      name: "echo",
      description: "Echo one value",
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
      requiresPermission: false
    }],
    callTool: async (_name, arguments_, signal, context) => {
      signal?.throwIfAborted();
      calls.push(context);
      return { content: [{ type: "text", text: String(arguments_["value"] ?? "") }], isError: false };
    }
  };
}

async function createFixture(options: { readonly now?: () => number; readonly grantTtlMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "joko-remote-codex-mcp-"));
  const store = new OperationalStore(join(root, "orchestrator.db"));
  const vault = await CredentialVault.open(join(root, "vault.key"));
  const credentials = new CredentialManager({ vault, storagePath: join(root, "credentials.json") });
  await credentials.initialize();
  store.upsertBackend({
    id: "codex", displayName: "Codex", version: "test", health: "healthy", adapterKind: "fixture",
    instanceGeneration: 1, installationState: "installed", authenticationState: "authenticated",
    capabilities: new Map(), models: [], tools: [], diagnostics: []
  });
  store.upsertTarget({
    id: "target-remote", backendId: "codex", displayName: "Remote", workspaceRoot: "D:/remote-placeholder",
    managed: false, trusted: true,
    remoteWorkspace: { hostId: "remote-host", workspaceRoot: "/srv/workspace" }
  });
  store.createSession({
    id: "session-remote", backendId: "codex", targetId: "target-remote", title: "Remote",
    binding: { opaqueRef: "native-root", generation: 1 },
    remoteWorkspace: { hostId: "remote-host", workspaceRoot: "/srv/workspace" },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false,
    createdAt: 1, updatedAt: 1
  });
  const router = new McpRouter({
    store,
    credentials,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.grantTtlMs === undefined ? {} : { bridgeGrantTtlMs: options.grantTtlMs })
  });
  await router.initialize();
  const manager = new RemoteCodexMcpBridgeManager({
    router,
    ...(options.grantTtlMs === undefined ? {} : { grantTtlMs: options.grantTtlMs })
  });
  cleanups.push(async () => {
    await manager.shutdown();
    await router.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, router, manager };
}
