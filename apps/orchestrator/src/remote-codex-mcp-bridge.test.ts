import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AppServerHost, CodexBackendAdapter } from "@joko/adapter-codex";
import { FakeCodexAppServer } from "@joko/adapter-codex/testing";
import type { CodexMcpOpenInput } from "@joko/adapter-codex";
import type { AdapterContext, NativeSessionBinding } from "@joko/core";
import type { RemoteForwardingTransportPort } from "@joko/remote-ssh";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { McpRouter, type BridgeToolCallContext, type BridgeToolProvider } from "./mcp-router.js";
import { CodexMcpBridgeManager } from "./remote-codex-mcp-bridge.js";
import { mkdtemp } from "./test-paths.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("CodexMcpBridgeManager", () => {
  it("connects a durable local Codex Session through its native config to the standard Router facade", async () => {
    const fixture = await createFixture();
    const calls: BridgeToolCallContext[] = [];
    fixture.router.registerBridgeToolProvider(provider(calls));
    const fake = new FakeCodexAppServer();
    const nativeHost = new AppServerHost({ transportFactory: () => fake.createTransport() });
    const target = {
      id: "target-local-product", backendId: "codex", displayName: "Product local",
      workspaceRoot: fixture.root, managed: false, trusted: true
    } as const;
    fixture.store.upsertTarget(target);
    let routeUrl: string | undefined;
    const adapter = new CodexBackendAdapter({
      id: "codex", instanceGeneration: 1, host: nativeHost, profileDirectory: fixture.root,
      localMcpBridge: async (input) => {
        expect(fixture.store.getSession(input.sessionId).descriptor.binding).toMatchObject({ generation: input.generation });
        const lease = await fixture.manager.openLocal(input);
        routeUrl = lease.routes[0]?.url;
        return lease;
      }
    });
    cleanups.push(async () => {
      await adapter.dispose();
      await nativeHost.shutdown();
    });
    const context = (binding?: NativeSessionBinding, operationId?: string): AdapterContext => ({
      sessionId: "session-local-product", generation: 1, backendInstanceGeneration: 1,
      target, ...(binding === undefined ? {} : { binding }),
      ...(operationId === undefined ? {} : { operationId }),
      signal: new AbortController().signal,
      emit: async () => undefined,
      requestInteraction: async () => ({ kind: "cancelled" }),
      artifactCapacityBytes: 1_048_576,
      storeArtifact: async () => ({ id: "artifact", sha256: "0".repeat(64), byteLength: 0, mimeType: "application/octet-stream" })
    });
    fake.reviewConfig = { mcp_servers: { docs: { command: "private-docs-command" } } };
    fake.reviewMcpStatuses.push({ name: "docs", authStatus: "unsupported", resourceTemplates: [], resources: [], tools: {} });
    const binding = await adapter.createSession({
      target, providerId: "openai", modelId: "gpt-test", fastMode: false, permissionMode: "ask"
    }, context());
    expect(routeUrl).toBeUndefined();
    expect(fake.transport!.requests.find((request) => request.method === "thread/start")?.params)
      .toMatchObject({ config: { "mcp_servers.docs.enabled": false, "features.apps": false } });
    fixture.store.createSession({
      id: "session-local-product", backendId: "codex", targetId: target.id, title: "Local product",
      binding, pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false,
      createdAt: 3, updatedAt: 3
    });
    await adapter.send({ text: "Call the tool", images: [], files: [], mentions: [], disposition: "prompt" },
      context(binding, "local-product-first-turn"));
    expect(routeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//u);
    expect(fake.transport!.requests.findLast((request) => request.method === "thread/resume")?.params)
      .toMatchObject({ threadId: binding.nativeSessionId, config: expect.objectContaining({
        "mcp_servers.docs.enabled": false,
        "features.apps": false
      }) });
    expect(JSON.stringify(fake.transport!.requests.findLast((request) => request.method === "thread/resume")?.params))
      .toContain(routeUrl!);
    const client = new Client({ name: "local-product-fixture", version: "1.0.0" }, { capabilities: {} });
    cleanups.push(async () => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(routeUrl!)));
    expect((await client.listTools()).tools).toMatchObject([{ name: "echo", outputSchema: { type: "object" } }]);
    expect(await client.callTool({
      name: "echo", arguments: { value: "product result" }, _meta: { threadId: binding.nativeSessionId! }
    })).toMatchObject({
      content: [{ type: "text", text: "product result" }],
      structuredContent: { echoed: "product result" }, isError: false
    });
    expect(calls).toHaveLength(1);
    await fake.completeTurn(binding.nativeSessionId!);
    await expect(client.callTool({
      name: "echo", arguments: { value: "late result" }, _meta: { threadId: binding.nativeSessionId! }
    })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("serves the same private standard facade directly on local loopback", async () => {
    const fixture = await createFixture();
    const calls: BridgeToolCallContext[] = [];
    fixture.router.registerBridgeToolProvider(provider(calls));
    let active = true;
    const bridge = await fixture.manager.openLocal({
      sessionId: "session-local",
      targetId: "target-local",
      generation: 1,
      threadId: "native-local-root",
      assertSessionCurrent: () => { if (!active) throw new Error("Local Session changed"); },
      beginToolCall: (threadId) => {
        if (!active || threadId !== "native-local-root") throw new Error("Local native turn is inactive");
        return {
          signal: new AbortController().signal,
          assertCurrent: () => { if (!active) throw new Error("Local native turn changed"); },
          release: () => undefined
        };
      }
    });
    expect(bridge.routes).toHaveLength(1);
    expect(bridge.routes[0]!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/fixture-tools$/u);

    const client = new Client({ name: "local-codex-fixture", version: "1.0.0" }, { capabilities: {} });
    cleanups.push(async () => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.routes[0]!.url)));
    expect(await client.callTool({
      name: "echo",
      arguments: { value: "local result" },
      _meta: { threadId: "native-local-root" }
    })).toMatchObject({
      content: [{ type: "text", text: "local result" }],
      structuredContent: { echoed: "local result" },
      isError: false
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ sessionId: "session-local", targetId: "target-local", generation: 1 });

    active = false;
    expect(() => bridge.assertCurrent()).toThrow();
    await expect(client.listTools()).rejects.toThrow();
    await bridge.release();
  });

  it("does not open a local listener when a Session has no authorized tools", async () => {
    const fixture = await createFixture();
    const bridge = await fixture.manager.openLocal({
      sessionId: "session-local",
      targetId: "target-local",
      generation: 1,
      threadId: "native-local-root",
      assertSessionCurrent: () => undefined,
      beginToolCall: () => { throw new Error("No tool calls are available"); }
    });
    expect(bridge.routes).toEqual([]);
    expect(() => bridge.assertCurrent()).not.toThrow();
    await bridge.release();
    expect(() => bridge.assertCurrent()).toThrow();
  });

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
    const input: CodexMcpOpenInput = {
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
    expect(await client.listTools()).toMatchObject({ tools: [{
      name: "echo",
      description: "Echo one value",
      outputSchema: {
        type: "object",
        properties: { echoed: { type: "string" } },
        required: ["echoed"],
        additionalProperties: false
      }
    }] });
    expect(await client.callTool({
      name: "echo",
      arguments: { value: "remote result" },
      _meta: { threadId: "native-root" }
    })).toMatchObject({
      content: [{ type: "text", text: "remote result" }],
      structuredContent: { echoed: "remote result" },
      isError: false
    });
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
      outputSchema: {
        type: "object",
        properties: { echoed: { type: "string" } },
        required: ["echoed"],
        additionalProperties: false
      },
      requiresPermission: false
    }],
    callTool: async (_name, arguments_, signal, context) => {
      signal?.throwIfAborted();
      calls.push(context);
      const echoed = String(arguments_["value"] ?? "");
      return {
        content: [{ type: "text", text: echoed }],
        structuredContent: { echoed },
        isError: false
      };
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
    remoteWorkspace: { hostTargetId: "target-remote", hostId: "remote-host", workspaceRoot: "/srv/workspace" }
  });
  store.upsertTarget({
    id: "target-local", backendId: "codex", displayName: "Local", workspaceRoot: "D:/workspace",
    managed: false, trusted: true
  });
  store.createSession({
    id: "session-remote", backendId: "codex", targetId: "target-remote", title: "Remote",
    binding: { opaqueRef: "native-root", generation: 1 },
    remoteWorkspace: { hostTargetId: "target-remote", hostId: "remote-host", workspaceRoot: "/srv/workspace" },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false,
    createdAt: 1, updatedAt: 1
  });
  store.createSession({
    id: "session-local", backendId: "codex", targetId: "target-local", title: "Local",
    binding: { opaqueRef: "native-local-root", generation: 1 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false,
    createdAt: 2, updatedAt: 2
  });
  const router = new McpRouter({
    store,
    credentials,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.grantTtlMs === undefined ? {} : { bridgeGrantTtlMs: options.grantTtlMs })
  });
  await router.initialize();
  const manager = new CodexMcpBridgeManager({
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
