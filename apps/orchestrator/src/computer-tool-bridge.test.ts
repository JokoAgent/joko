import { rmSync, symlinkSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  COMPUTER_PUBLIC_TOOLS,
  COMPUTER_TOOL_NAMES,
  computerPublicTool,
  ComputerToolProviderError,
  type ComputerSessionFence,
  type ComputerToolCallResult,
  type ComputerToolDescriptor,
  type ComputerToolProvider
} from "@joko/tool-computer";
import type { OperationalStore } from "@joko/store";
import { describe, expect, it } from "vitest";

import type { CredentialManager } from "./credential-manager.js";
import { ComputerToolBridgeProvider } from "./computer-tool-bridge.js";
import { McpRouter } from "./mcp-router.js";

const WORKSPACE_ROOT = resolve("D:\\workspace");
const TOOL_SCHEMA = { type: "object", properties: {}, additionalProperties: false } as const;

describe("ComputerToolBridgeProvider", () => {
  it("lists the complete frozen 24-tool catalog behind the two public wrappers", async () => {
    const provider = new FakeComputerProvider(COMPUTER_PUBLIC_TOOLS);
    const bridge = createBridge(provider);
    await bridge.prepare();

    expect(bridge.tools.map((tool) => tool.name)).toEqual(["list_tools", "call_tool"]);
    expect(bridge.tools.map((tool) => tool.requiresPermission)).toEqual([true, true]);
    expect(bridge.tools.every((tool) => !("annotations" in tool))).toBe(true);
    const payload = textPayload(await bridge.callTool(
      "list_tools",
      {},
      undefined,
      bridgeContext("session-public-catalog")
    ));
    const tools = payload["tools"] as readonly Record<string, unknown>[];
    expect(tools.map((tool) => tool["name"])).toEqual(COMPUTER_TOOL_NAMES);
    expect(tools).toHaveLength(24);
    expect(tools.filter((tool) => tool["readOnly"] === true).map((tool) => tool["name"])).toEqual([
      "status",
      "check_permissions",
      "get_accessibility_tree",
      "list_apps",
      "list_windows",
      "get_window_state",
      "zoom",
      "get_screen_size",
      "get_cursor_position",
      "get_agent_cursor_state"
    ]);
    expect(tools.find((tool) => tool["name"] === "get_window_state")).toMatchObject({
      description: expect.stringContaining("normally omit screenshot_out_file"),
      inputSchema: expect.objectContaining({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        required: ["pid", "window_id"],
        additionalProperties: false
      })
    });
  });

  it("discovers the runtime catalog once and exposes the two-tool discovery workflow", async () => {
    let enabled = true;
    const provider = new FakeComputerProvider([
      {
        name: "screen_inspect",
        description: "Inspect the screen",
        inputSchema: TOOL_SCHEMA,
        annotations: { readOnlyHint: true }
      },
      {
        name: "guarded_inspect",
        inputSchema: TOOL_SCHEMA,
        outputSchema: { type: "object" },
        annotations: { readOnlyHint: true, destructiveHint: true }
      },
      { name: "pointer_click", title: "Click", inputSchema: TOOL_SCHEMA }
    ]);
    const bridge = createBridge(provider, () => enabled);

    expect(bridge.available).toBe(false);
    expect(bridge.includeInSnapshot).toBe(false);

    await Promise.all([bridge.prepare(), bridge.prepare()]);

    expect(provider.openRequests.map((request) => request.sessionId)).toEqual(["catalog"]);
    expect(provider.listRequests).toHaveLength(1);
    expect(provider.closeSessionRequests.map((request) => request.sessionId)).toEqual(["catalog"]);
    expect(bridge.available).toBe(true);
    expect(bridge.includeInSnapshot).toBe(true);
    expect(bridge.tools).toEqual([
      expect.objectContaining({
        name: "list_tools",
        requiresPermission: true
      }),
      expect.objectContaining({
        name: "call_tool",
        requiresPermission: true,
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            name: expect.objectContaining({ enum: ["screen_inspect", "guarded_inspect", "pointer_click"] })
          })
        })
      })
    ]);
    const result = await bridge.callTool("list_tools", {}, undefined, bridgeContext("session-catalog"));
    const listed = textPayload(result);
    expect(Object.keys(result).sort()).toEqual(["content", "isError"]);
    expect(result.structuredContent).toBeUndefined();
    expect(listed).toMatchObject({
      ok: true,
      tools: [
        expect.objectContaining({ name: "screen_inspect", readOnly: true }),
        expect.objectContaining({ name: "guarded_inspect", readOnly: true }),
        expect.objectContaining({ name: "pointer_click", description: "Click", readOnly: false })
      ]
    });
    expect(String(listed["workflow"])).toContain("Start with status and check_permissions");

    enabled = false;
    expect(bridge.available).toBe(true);
    expect(bridge.includeInSnapshot).toBe(false);
  });

  it("omits the provider from new snapshots after disable while an active grant remains callable", async () => {
    let enabled = true;
    const provider = new FakeComputerProvider([
      { name: "screen_inspect", inputSchema: TOOL_SCHEMA, annotations: { readOnlyHint: true } }
    ]);
    provider.result = { content: [{ type: "text", text: "active" }], isError: false };
    const bridge = createBridge(provider, () => enabled);
    await bridge.prepare();
    const { router } = await routerFixture();
    router.registerBridgeToolProvider(bridge);
    const active = router.createPiBridgeSnapshot({
      endpoint: "http://127.0.0.1:4318/internal/mcp",
      expectedPiGeneration: 7
    });

    enabled = false;
    const next = router.createPiBridgeSnapshot({
      endpoint: "http://127.0.0.1:4318/internal/mcp",
      expectedPiGeneration: 8
    });

    expect(active.mcpBridge.tools).toContainEqual(expect.objectContaining({
      serverId: bridge.id,
      name: "call_tool"
    }));
    expect(next.mcpBridge.tools).toEqual([]);
    const activeResult = await router.executeBridgeCall({
      authorization: `Bearer ${active.mcpBridge.token}`,
      requestId: "computer-bridge-active",
      generation: 7,
      sessionId: "session-7",
      targetId: "target-1",
      serverId: bridge.id,
      toolName: "call_tool",
      arguments: { name: "screen_inspect", args: {} }
    });
    expect(activeResult).toMatchObject({
      isError: false,
      content: [expect.objectContaining({ type: "text" })]
    });
    expect(textPayload(activeResult)).toMatchObject({ ok: true, tool: "screen_inspect", data: "active" });
    expect(provider.callRequests.at(-1)?.fence.sessionId).toBe("session-7");

    active.revoke();
    next.revoke();
    await router.dispose();
    await bridge.close();
  });

  it("constrains every recognized file argument to the workspace and redacts roots from results", async () => {
    const provider = new FakeComputerProvider([
      { name: "screen_capture", inputSchema: TOOL_SCHEMA }
    ]);
    const normalizedRoot = WORKSPACE_ROOT.replaceAll("\\", "/");
    provider.result = {
      content: [{
        type: "text",
        text: `saved ${WORKSPACE_ROOT}\\captures\\screen.png`,
        metadata: { [`${normalizedRoot}/private`]: `${normalizedRoot}/captures/screen.png` }
      }],
      structuredContent: {
        root: WORKSPACE_ROOT,
        files: [`${normalizedRoot}/captures/screen.png`],
        windowsCaseVariant: `${normalizedRoot.toLowerCase()}/other.txt`,
        privateServicePath: "C:/Users/Joseph/AppData/Local/driver/capture.png"
      },
      isError: false
    };
    const bridge = createBridge(provider);
    await bridge.prepare();

    const result = await bridge.callTool("call_tool", {
      name: "screen_capture",
      args: {
        file_path: "reports/daily.txt",
        nested: { outputPath: "captures/screen.png" },
        matrix: [[{ directory: "assets" }]]
      }
    }, undefined, bridgeContext("session-paths"));

    expect(provider.callRequests.at(-1)?.arguments).toEqual({
      file_path: resolve(WORKSPACE_ROOT, "reports/daily.txt"),
      nested: { outputPath: resolve(WORKSPACE_ROOT, "captures/screen.png") },
      matrix: [[{ directory: resolve(WORKSPACE_ROOT, "assets") }]]
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(WORKSPACE_ROOT);
    expect(serialized).not.toContain(normalizedRoot);
    if (process.platform === "win32") {
      expect(serialized).not.toContain(normalizedRoot.toLowerCase());
      expect(serialized).toContain("./other.txt");
    }
    expect(serialized).toContain("./captures/screen.png");
    expect(serialized).not.toContain("AppData");
    expect(serialized).toContain("[local-path]");
    expect(result.structuredContent).toBeUndefined();

    const callCount = provider.callRequests.length;
    expect(textPayload(await bridge.callTool("call_tool", {
      name: "screen_capture",
      args: { filePath: "../outside.txt" }
    }, undefined, bridgeContext("session-paths")))["errorCode"]).toBe("PATH_NOT_ALLOWED");
    expect(textPayload(await bridge.callTool("call_tool", {
      name: "screen_capture",
      args: { output_path: resolve(WORKSPACE_ROOT, "absolute.txt") }
    }, undefined, bridgeContext("session-paths")))["ok"]).toBe(true);
    expect(provider.callRequests.at(-1)?.arguments["output_path"])
      .toBe(resolve(WORKSPACE_ROOT, "absolute.txt"));
    const outsideAbsolute = textPayload(await bridge.callTool("call_tool", {
      name: "screen_capture",
      args: { output_path: resolve(WORKSPACE_ROOT, "..", "outside.txt") }
    }, undefined, bridgeContext("session-paths")));
    expect(outsideAbsolute).toMatchObject({
      errorCode: "PATH_NOT_ALLOWED",
      data: { arg: "output_path" }
    });
    expect(textPayload(await bridge.callTool("call_tool", {
      name: "screen_capture",
      args: { nested: [[[{ recording_path: "../../outside.mp4" }]]] }
    }, undefined, bridgeContext("session-paths")))["errorCode"]).toBe("PATH_NOT_ALLOWED");
    expect(provider.callRequests).toHaveLength(callCount + 1);
  });

  it("rejects an existing workspace symlink that resolves a driver read outside the task root", async () => {
    const root = mkdtempSync(join(tmpdir(), "joko-computer-path-root-"));
    const outside = mkdtempSync(join(tmpdir(), "joko-computer-path-outside-"));
    const link = join(root, "recording-link");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    try {
      const provider = new FakeComputerProvider([{ name: "replay_trajectory", inputSchema: TOOL_SCHEMA }]);
      const bridge = createBridge(provider, () => true, root);
      await bridge.prepare();

      const result = await bridge.callTool(
        "call_tool",
        { name: "replay_trajectory", args: { dir: "recording-link" } },
        undefined,
        bridgeContext("session-paths")
      );
      expect(textPayload(result)["errorCode"]).toBe("PATH_NOT_ALLOWED");
      expect(provider.callRequests).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("replaces a stale per-session fence once, reuses the replacement, and closes all sessions", async () => {
    const provider = new FakeComputerProvider([
      { name: "pointer_click", inputSchema: TOOL_SCHEMA }
    ]);
    provider.staleOnceFor.add("session-active");
    provider.result = { content: [{ type: "text", text: "done" }] };
    const bridge = createBridge(provider);
    await bridge.prepare();

    await expect(bridge.callTool(
      "call_tool",
      { name: "pointer_click", args: { x: 10, y: 20 } },
      undefined,
      bridgeContext("session-active")
    )).resolves.toMatchObject({ content: [expect.objectContaining({ type: "text" })], isError: false });
    await bridge.callTool("call_tool", {
      name: "pointer_click",
      args: {}
    }, undefined, bridgeContext("session-active"));

    const activeOpens = provider.openRequests.filter((request) => request.sessionId === "session-active");
    const activeCalls = provider.callRequests.filter((request) => request.fence.sessionId === "session-active");
    expect(activeOpens.map((request) => request.generation)).toEqual([1, 2]);
    expect(activeCalls.map((request) => request.fence.generation)).toEqual([1, 2, 2]);

    await bridge.close();
    expect(provider.closeAllCount).toBe(1);
    await bridge.callTool("call_tool", {
      name: "pointer_click",
      args: {}
    }, undefined, bridgeContext("session-active"));
    expect(provider.openRequests.filter((request) => request.sessionId === "session-active")).toHaveLength(3);
  });

  it("ends and forgets one driver fence when its owning Session runtime closes", async () => {
    const provider = new FakeComputerProvider([
      { name: "pointer_click", inputSchema: TOOL_SCHEMA }
    ]);
    const bridge = createBridge(provider);
    await bridge.prepare();
    await bridge.callTool("call_tool", {
      name: "pointer_click",
      args: {}
    }, undefined, bridgeContext("session-active"));

    await bridge.closeSession("session-active");
    await bridge.closeSession("session-active");

    expect(provider.closeSessionRequests.filter((fence) => fence.sessionId === "session-active"))
      .toEqual([expect.objectContaining({ generation: 1 })]);
    await bridge.callTool("call_tool", {
      name: "pointer_click",
      args: {}
    }, undefined, bridgeContext("session-active"));
    expect(provider.openRequests.filter((fence) => fence.sessionId === "session-active"))
      .toEqual([
        expect.objectContaining({ generation: 1 }),
        expect.objectContaining({ generation: 2 })
      ]);
  });

  it("returns strict text-only envelopes for unknown names, invalid args, driver failures, and cancellation", async () => {
    const click = computerPublicTool("click");
    if (click === undefined) throw new Error("Missing click fixture.");
    const provider = new FakeComputerProvider([click]);
    const bridge = createBridge(provider);
    await bridge.prepare();

    const unknown = await bridge.callTool("call_tool", {
      name: "not_in_catalog",
      args: {}
    }, undefined, bridgeContext("session-errors"));
    expect(textPayload(unknown)).toEqual({
      ok: false,
      errorCode: "UNKNOWN_TOOL",
      data: { requested: "not_in_catalog" }
    });
    expect(Object.keys(unknown).sort()).toEqual(["content", "isError"]);
    expect(unknown.structuredContent).toBeUndefined();

    const invalidWrapper = await bridge.callTool("call_tool", {
      name: "click",
      args: { pid: 7, x: 1, y: 2 },
      unexpected: true
    }, undefined, bridgeContext("session-errors"));
    expect(textPayload(invalidWrapper)).toMatchObject({
      ok: false,
      errorCode: "INVALID_ARGS",
      data: { tool: "call_tool" }
    });

    const invalid = await bridge.callTool("call_tool", {
      name: "click",
      args: { pid: 0, x: 1, y: 2 }
    }, undefined, bridgeContext("session-errors"));
    expect(textPayload(invalid)).toMatchObject({
      ok: false,
      errorCode: "INVALID_ARGS",
      data: { tool: "click", validation_errors: [expect.objectContaining({ path: ["pid"] })] }
    });
    expect(provider.callRequests).toHaveLength(0);

    provider.result = { content: [{ type: "text", text: "driver rejected request" }], isError: true };
    const failed = await bridge.callTool("call_tool", {
      name: "click",
      args: JSON.stringify({ pid: 7, x: 1, y: 2 })
    }, undefined, bridgeContext("session-errors"));
    expect(textPayload(failed)).toEqual({
      ok: false,
      errorCode: "COMPUTER_DRIVER_ERROR",
      data: { message: "driver rejected request" }
    });
    expect(failed.structuredContent).toBeUndefined();

    const abort = new AbortController();
    abort.abort();
    const cancelled = await bridge.callTool("call_tool", {
      name: "click",
      args: { pid: 7, x: 1, y: 2 }
    }, abort.signal, bridgeContext("session-errors"));
    expect(textPayload(cancelled)).toMatchObject({ ok: false, errorCode: "REQUEST_CANCELLED" });
    expect(provider.callRequests).toHaveLength(1);
  });

  it("projects the current window snapshot id at the call envelope boundary", async () => {
    const state = computerPublicTool("get_window_state");
    if (state === undefined) throw new Error("Missing window state fixture.");
    const provider = new FakeComputerProvider([state]);
    provider.result = {
      structuredContent: { ok: true, snapshot_id: "snapshot-current", elements: [] },
      content: [{ type: "text", text: "ignored" }],
      isError: false
    };
    const bridge = createBridge(provider);
    await bridge.prepare();

    const result = await bridge.callTool("call_tool", {
      name: "get_window_state",
      args: { pid: 7, window_id: 2 }
    }, undefined, bridgeContext("session-snapshot"));

    expect(textPayload(result)).toEqual({
      ok: true,
      tool: "get_window_state",
      snapshot_id: "snapshot-current",
      data: { ok: true, snapshot_id: "snapshot-current", elements: [] }
    });
    expect(result.structuredContent).toBeUndefined();
  });

  it("freezes the discovered catalog for the provider generation", async () => {
    const mutableCatalog: ComputerToolDescriptor[] = [{
      name: "screen_inspect",
      description: "Original description",
      inputSchema: TOOL_SCHEMA,
      annotations: { readOnlyHint: true }
    }];
    const provider = new FakeComputerProvider(mutableCatalog);
    const bridge = createBridge(provider);
    await bridge.prepare();
    mutableCatalog[0] = {
      name: "screen_inspect",
      description: "Mutated description",
      inputSchema: TOOL_SCHEMA
    };
    mutableCatalog.push({ name: "late_tool", inputSchema: TOOL_SCHEMA });
    await bridge.prepare();

    const listed = textPayload(await bridge.callTool(
      "list_tools",
      {},
      undefined,
      bridgeContext("session-frozen")
    ));
    expect(listed["tools"]).toEqual([
      expect.objectContaining({ name: "screen_inspect", description: "Original description", readOnly: true })
    ]);
    expect(textPayload(await bridge.callTool("call_tool", {
      name: "late_tool",
      args: {}
    }, undefined, bridgeContext("session-frozen")))["errorCode"]).toBe("UNKNOWN_TOOL");
    expect(provider.listRequests).toHaveLength(1);
  });
});

class FakeComputerProvider {
  readonly openRequests: ComputerSessionFence[] = [];
  readonly listRequests: ComputerSessionFence[] = [];
  readonly callRequests: {
    readonly fence: ComputerSessionFence;
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }[] = [];
  readonly closeSessionRequests: ComputerSessionFence[] = [];
  readonly staleOnceFor = new Set<string>();
  readonly #generations = new Map<string, number>();
  result: ComputerToolCallResult = { content: [], isError: false };
  closeAllCount = 0;

  constructor(readonly catalog: readonly ComputerToolDescriptor[]) {}

  async openSession(sessionId: string): Promise<ComputerSessionFence> {
    const generation = (this.#generations.get(sessionId) ?? 0) + 1;
    this.#generations.set(sessionId, generation);
    const fence = { sessionId, generation, token: `${sessionId}-${generation}` };
    this.openRequests.push(fence);
    return fence;
  }

  async listTools(fence: ComputerSessionFence): Promise<readonly ComputerToolDescriptor[]> {
    this.listRequests.push(fence);
    return this.catalog;
  }

  async callTool(
    fence: ComputerSessionFence,
    name: string,
    arguments_: Readonly<Record<string, unknown>>
  ): Promise<ComputerToolCallResult> {
    this.callRequests.push({ fence, name, arguments: arguments_ });
    if (this.staleOnceFor.delete(fence.sessionId)) {
      throw new ComputerToolProviderError("stale_session");
    }
    return this.result;
  }

  async closeSession(fence: ComputerSessionFence): Promise<void> {
    this.closeSessionRequests.push(fence);
  }

  async closeAll(): Promise<void> {
    this.closeAllCount += 1;
  }
}

function createBridge(
  provider: FakeComputerProvider,
  enabledForNewSessions: () => boolean = () => true,
  workspaceRoot = WORKSPACE_ROOT
): ComputerToolBridgeProvider {
  return new ComputerToolBridgeProvider({
    provider: provider as unknown as ComputerToolProvider,
    store: new FakeStore(workspaceRoot) as unknown as OperationalStore,
    enabledForNewSessions
  });
}

async function routerFixture(): Promise<{ readonly router: McpRouter }> {
  const store = new FakeStore(WORKSPACE_ROOT);
  const credentials = {
    redactText: (value: string) => value
  } as unknown as CredentialManager;
  const router = new McpRouter({
    store: store as unknown as OperationalStore,
    credentials
  });
  await router.initialize();
  return { router };
}

class FakeStore {
  constructor(readonly workspaceRoot: string) {}

  findSetting(): undefined {
    return undefined;
  }

  getTarget(targetId: string): unknown {
    if (targetId !== "target-1") throw new Error("Unknown target.");
    return { descriptor: { workspaceRoot: this.workspaceRoot } };
  }

  getSession(sessionId: string): unknown {
    const match = /^session-(\d+)$/u.exec(sessionId);
    if (match?.[1] === undefined) throw new Error("Unknown session.");
    return {
      descriptor: {
        targetId: "target-1",
        binding: { generation: Number(match[1]) }
      }
    };
  }

  findPendingSessionLifecycleCleanup(): undefined {
    return undefined;
  }
}

function bridgeContext(sessionId: string) {
  return { sessionId, targetId: "target-1", generation: 1 } as const;
}

function textPayload(result: { readonly content: readonly unknown[] }): Record<string, unknown> {
  const block = result.content.find((item) => (
    typeof item === "object"
    && item !== null
    && !Array.isArray(item)
    && (item as { readonly type?: unknown }).type === "text"
    && typeof (item as { readonly text?: unknown }).text === "string"
  )) as { readonly text: string } | undefined;
  if (block === undefined) throw new Error("Expected a text-only computer tool result.");
  const parsed: unknown = JSON.parse(block.text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object computer tool result.");
  }
  return parsed as Record<string, unknown>;
}
