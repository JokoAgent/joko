import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  LspBridgeResponse,
  LspCallOptions,
  LspToolRequest,
  LspToolResponse
} from "@joko/tool-lsp";
import { OperationalStore } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import type { CredentialManager } from "./credential-manager.js";
import {
  LSP_BRIDGE_PROVIDER_ID,
  LspToolBridgeProvider,
  resolveAuthenticatedLspTarget,
  type LspToolBackend,
  type LspToolTargetResolver
} from "./lsp-tool-bridge.js";
import { McpRouter, type BridgeToolCallContext } from "./mcp-router.js";

const context: BridgeToolCallContext = {
  sessionId: "session-7",
  targetId: "target-trusted",
  generation: 7
};

describe("LspToolBridgeProvider", () => {
  it("binds execution to the active isolated Session workspace and fails closed after release", () => {
    const session = {
      targetId: "target-trusted",
      binding: { generation: 7 },
      worktree: { state: "active", path: "D:/isolated-session" }
    };
    const store = {
      getSession: () => ({ descriptor: session }),
      getTarget: () => ({ descriptor: { workspaceRoot: "D:/primary", trusted: true } })
    };

    expect(resolveAuthenticatedLspTarget(store as never, context)).toEqual({
      workspaceRoot: "D:/isolated-session",
      trusted: true
    });
    session.worktree = { state: "preserved", path: "D:/isolated-session" };
    expect(() => resolveAuthenticatedLspTarget(store as never, context)).toThrow(/no longer active/u);
    session.worktree = { state: "active", path: "D:/isolated-session" };
    session.binding.generation = 8;
    expect(() => resolveAuthenticatedLspTarget(store as never, context)).toThrow(/stale/u);
  });

  it("advertises six direct read-only runtime tools without a model-controlled workspace root", () => {
    const value = providerFixture();

    expect(value.provider.tools.map(({ name, runtimeName }) => ({ name, runtimeName }))).toEqual([
      { name: "hover", runtimeName: "hover" },
      { name: "goto_definition", runtimeName: "goto_definition" },
      { name: "find_references", runtimeName: "find_references" },
      { name: "outline", runtimeName: "file_outline" },
      { name: "workspace_symbol", runtimeName: "workspace_symbols" },
      { name: "incoming_calls", runtimeName: "incoming_calls" }
    ]);
    expect(value.provider.tools.every((tool) => tool.serverId === LSP_BRIDGE_PROVIDER_ID)).toBe(true);
    expect(value.provider.tools.every((tool) => tool.requiresPermission === false)).toBe(true);
    expect(JSON.stringify(value.provider.tools.map((tool) => tool.inputSchema))).not.toContain("workspaceRoot");
    expect(value.provider.includeForTarget("target-trusted")).toBe(true);
  });

  it("defaults off and gates each new snapshot by opt-in, trust, and TypeScript project detection", () => {
    const defaultOff = providerFixture({ enabled: undefined });
    expect(defaultOff.provider.includeForTarget("target-trusted")).toBe(false);

    const disabled = providerFixture({ enabled: false });
    expect(disabled.provider.includeForTarget("target-trusted")).toBe(false);
    expect(disabled.resolveSnapshot).not.toHaveBeenCalled();

    const untrusted = providerFixture({ trusted: false });
    expect(untrusted.provider.includeForTarget("target-trusted")).toBe(false);

    const ordinary = providerFixture({ detected: false });
    expect(ordinary.provider.includeForTarget("target-trusted")).toBe(false);

    const eligible = providerFixture();
    expect(eligible.provider.includeForTarget("target-trusted")).toBe(true);
    expect(eligible.detectProject).toHaveBeenCalledWith(eligible.workspaceRoot);
  });

  it("maps all direct tools to package actions and injects only the authenticated workspace root", async () => {
    const signal = new AbortController().signal;
    const value = providerFixture();
    const calls = [
      ["hover", { file: "src/main.ts", line: 3, character: 7, max_results: 5 }],
      ["goto_definition", { file: "src/main.ts", line: 3, character: 7 }],
      ["find_references", { file: "src/main.ts", line: 3, character: 7 }],
      ["outline", { file: "src/main.ts", max_results: 8 }],
      ["workspace_symbol", { query: "Main", max_results: 9 }],
      ["incoming_calls", { file: "src/main.ts", line: 3, character: 7 }]
    ] as const;

    for (const [name, arguments_] of calls) {
      const result = await value.provider.callTool(name, arguments_, signal, context);
      expect(result.isError).toBe(false);
      expect(textPayload(result)).toMatchObject({ ok: true });
    }

    expect(value.resolveAuthenticated).toHaveBeenCalledTimes(6);
    expect(value.call.mock.calls.map(([request]) => request)).toEqual([
      {
        action: "hover",
        workspaceRoot: value.workspaceRoot,
        file: "src/main.ts",
        line: 3,
        column: 7,
        maxResults: 5
      },
      {
        action: "goto_definition",
        workspaceRoot: value.workspaceRoot,
        file: "src/main.ts",
        line: 3,
        column: 7
      },
      {
        action: "find_references",
        workspaceRoot: value.workspaceRoot,
        file: "src/main.ts",
        line: 3,
        column: 7
      },
      { action: "outline", workspaceRoot: value.workspaceRoot, file: "src/main.ts", maxResults: 8 },
      { action: "workspace_symbol", workspaceRoot: value.workspaceRoot, query: "Main", maxResults: 9 },
      {
        action: "incoming_calls",
        workspaceRoot: value.workspaceRoot,
        file: "src/main.ts",
        line: 3,
        column: 7
      }
    ]);
    expect(value.call.mock.calls.every(([, options]) => options?.signal === signal)).toBe(true);
  });

  it("fails closed for forged roots, unsupported fields, untrusted targets, and unknown tools", async () => {
    const value = providerFixture({ trusted: false });

    expect(value.provider.includeForTarget("target-trusted")).toBe(false);
    const forged = await value.provider.callTool(
      "outline",
      { file: "src/main.ts", workspaceRoot: "D:/forged" },
      undefined,
      context
    );
    expect(forged).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: "INVALID_ARGUMENT" } }
    });
    expect(value.resolveAuthenticated).not.toHaveBeenCalled();
    expect(value.call).not.toHaveBeenCalled();

    const untrusted = await value.provider.callTool("outline", { file: "src/main.ts" }, undefined, context);
    expect(untrusted).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: "WORKSPACE_UNSAFE" } }
    });
    expect(value.call).not.toHaveBeenCalled();

    await expect(value.provider.callTool("not_available", {}, undefined, context))
      .rejects.toThrow(/not part/u);
  });

  it("preserves the backend's structured error envelope and exact AbortSignal", async () => {
    const failure: LspBridgeResponse = {
      ok: false,
      error: { code: "ABORTED", message: "The operation was aborted." }
    };
    const value = providerFixture({ response: failure });
    const signal = new AbortController().signal;

    const result = await value.provider.callTool(
      "hover",
      { file: "src/main.ts", line: 1, character: 1 },
      signal,
      context
    );

    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify(failure) }],
      structuredContent: failure,
      isError: true
    });
    expect(value.call).toHaveBeenCalledWith(expect.any(Object), { signal });
  });

  it("projects the six-tool router snapshot and executes through its authenticated grant", async () => {
    const value = await routerFixture();
    try {
      const snapshot = value.router.createPiBridgeSnapshot({
        endpoint: "http://127.0.0.1:4318/internal/mcp",
        targetId: "target-trusted",
        expectedPiGeneration: 7
      });
      value.snapshots.push(snapshot);
      const tools = snapshot.mcpBridge.tools.filter((tool) => tool.serverId === LSP_BRIDGE_PROVIDER_ID);

      expect(tools.map(({ name, runtimeName, requiresPermission }) => ({
        name,
        runtimeName,
        requiresPermission
      }))).toEqual([
        { name: "find_references", runtimeName: "find_references", requiresPermission: false },
        { name: "goto_definition", runtimeName: "goto_definition", requiresPermission: false },
        { name: "hover", runtimeName: "hover", requiresPermission: false },
        { name: "incoming_calls", runtimeName: "incoming_calls", requiresPermission: false },
        { name: "outline", runtimeName: "file_outline", requiresPermission: false },
        { name: "workspace_symbol", runtimeName: "workspace_symbols", requiresPermission: false }
      ]);

      const result = await value.router.executeBridgeCall({
        authorization: `Bearer ${snapshot.mcpBridge.token}`,
        requestId: "lsp-outline",
        generation: 7,
        sessionId: "session-7",
        targetId: "target-trusted",
        serverId: LSP_BRIDGE_PROVIDER_ID,
        toolName: "outline",
        arguments: { file: "index.ts", max_results: 10 }
      });
      expect(result).toMatchObject({
        isError: false,
        details: {
          mcpStructuredContent: {
            ok: true,
            result: { action: "outline", items: [expect.objectContaining({ name: "greet" })] }
          },
          jokoMcpBridge: { format: 1, truncated: false }
        }
      });

      const escaped = await value.router.executeBridgeCall({
        authorization: `Bearer ${snapshot.mcpBridge.token}`,
        requestId: "lsp-escaped-outline",
        generation: 7,
        sessionId: "session-7",
        targetId: "target-trusted",
        serverId: LSP_BRIDGE_PROVIDER_ID,
        toolName: "outline",
        arguments: { file: "../outside.ts" }
      });
      expect(escaped).toMatchObject({
        isError: true,
        details: {
          mcpStructuredContent: { ok: false, error: { code: "PATH_OUTSIDE_WORKSPACE" } },
          jokoMcpBridge: { format: 1, truncated: false }
        }
      });

      const untrusted = value.router.createPiBridgeSnapshot({
        endpoint: "http://127.0.0.1:4318/internal/mcp",
        targetId: "target-untrusted",
        expectedPiGeneration: 8
      });
      value.snapshots.push(untrusted);
      expect(untrusted.mcpBridge.tools.some((tool) => tool.serverId === LSP_BRIDGE_PROVIDER_ID)).toBe(false);
    } finally {
      await value.close();
    }
  });

  it("samples opt-in only for new snapshots and preserves an already frozen Session grant", async () => {
    const value = await routerFixture(false);
    try {
      const disabled = value.router.createPiBridgeSnapshot({
        endpoint: "http://127.0.0.1:4318/internal/mcp",
        targetId: "target-trusted",
        expectedPiGeneration: 7
      });
      value.snapshots.push(disabled);
      expect(disabled.mcpBridge.tools.some((tool) => tool.serverId === LSP_BRIDGE_PROVIDER_ID)).toBe(false);

      value.setEnabled(true);
      const enabled = value.router.createPiBridgeSnapshot({
        endpoint: "http://127.0.0.1:4318/internal/mcp",
        targetId: "target-trusted",
        expectedPiGeneration: 7
      });
      value.snapshots.push(enabled);
      expect(enabled.mcpBridge.tools.some((tool) => tool.serverId === LSP_BRIDGE_PROVIDER_ID)).toBe(true);

      value.setEnabled(false);
      const nextDisabled = value.router.createPiBridgeSnapshot({
        endpoint: "http://127.0.0.1:4318/internal/mcp",
        targetId: "target-trusted",
        expectedPiGeneration: 7
      });
      value.snapshots.push(nextDisabled);
      expect(nextDisabled.mcpBridge.tools.some((tool) => tool.serverId === LSP_BRIDGE_PROVIDER_ID)).toBe(false);

      await expect(value.router.executeBridgeCall({
        authorization: `Bearer ${enabled.mcpBridge.token}`,
        requestId: "lsp-frozen-grant",
        generation: 7,
        sessionId: "session-7",
        targetId: "target-trusted",
        serverId: LSP_BRIDGE_PROVIDER_ID,
        toolName: "outline",
        arguments: { file: "index.ts" }
      })).resolves.toMatchObject({ isError: false });
    } finally {
      await value.close();
    }
  });
});

function providerFixture(options: {
  readonly trusted?: boolean;
  readonly response?: LspBridgeResponse;
  readonly enabled?: boolean | undefined;
  readonly detected?: boolean;
} = {}) {
  const workspaceRoot = "D:/authenticated-workspace";
  const response = options.response;
  const call = vi.fn(async (request: LspToolRequest, _options?: LspCallOptions): Promise<LspBridgeResponse> => response ?? ({
    ok: true,
    result: {
      action: request.action,
      items: [],
      truncated: false
    } as LspToolResponse
  }));
  const resolveAuthenticated = vi.fn(async () => ({
    workspaceRoot,
    trusted: options.trusted ?? true
  }));
  const resolveSnapshot = vi.fn(() => ({ workspaceRoot, trusted: options.trusted ?? true }));
  const resolver: LspToolTargetResolver = {
    resolveSnapshot,
    resolveAuthenticated
  };
  const backend: LspToolBackend = { call };
  const detectProject = vi.fn(() => options.detected ?? true);
  return {
    provider: new LspToolBridgeProvider({
      targetResolver: resolver,
      backend,
      ...(options.enabled === undefined
        ? (Object.prototype.hasOwnProperty.call(options, "enabled") ? {} : { isUserEnabled: () => true })
        : { isUserEnabled: () => options.enabled as boolean }),
      detectProject
    }),
    workspaceRoot,
    call,
    resolveAuthenticated,
    resolveSnapshot,
    detectProject
  };
}

async function routerFixture(initialEnabled = true) {
  const root = await mkdtemp(join(tmpdir(), "joko-lsp-router-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "index.ts"), "export function greet(name: string): string { return `Hello ${name}`; }\n", "utf8");
  await writeFile(join(workspaceRoot, "tsconfig.json"), "{}\n", "utf8");
  const store = new OperationalStore(join(root, "orchestrator.db"));
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "test",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  for (const [id, trusted] of [["target-trusted", true], ["target-untrusted", false]] as const) {
    store.upsertTarget({
      id,
      backendId: "pi",
      displayName: id,
      workspaceRoot,
      managed: false,
      trusted
    });
  }
  store.createSession({
    id: "session-7",
    backendId: "pi",
    targetId: "target-trusted",
    title: "Session 7",
    binding: { opaqueRef: "session-7.jsonl", generation: 7 },
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    createdAt: 1,
    updatedAt: 1
  });
  const router = new McpRouter({
    store,
    credentials: {} as unknown as CredentialManager
  });
  await router.initialize();
  const targetResolver: LspToolTargetResolver = {
    resolveSnapshot(targetId) {
      const target = store.getTarget(targetId).descriptor;
      return { workspaceRoot: target.workspaceRoot, trusted: target.trusted };
    },
    resolveAuthenticated(callContext) {
      const session = store.getSession(callContext.sessionId).descriptor;
      if (session.targetId !== callContext.targetId || session.binding.generation !== callContext.generation) {
        throw new Error("Authenticated language target context is stale.");
      }
      const target = store.getTarget(callContext.targetId).descriptor;
      return { workspaceRoot: target.workspaceRoot, trusted: target.trusted };
    }
  };
  let enabled = initialEnabled;
  const provider = new LspToolBridgeProvider({ targetResolver, isUserEnabled: () => enabled });
  const unregister = router.registerBridgeToolProvider(provider);
  const snapshots: Array<{ revoke(): void }> = [];
  return {
    router,
    snapshots,
    setEnabled(value: boolean) { enabled = value; },
    async close() {
      for (const snapshot of snapshots) snapshot.revoke();
      unregister();
      provider.dispose();
      await router.dispose();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

function textPayload(result: { readonly content: readonly unknown[] }): unknown {
  const first = result.content[0] as { readonly type?: string; readonly text?: string } | undefined;
  if (first?.type !== "text" || first.text === undefined) throw new Error("Missing language tool text payload.");
  return JSON.parse(first.text) as unknown;
}
