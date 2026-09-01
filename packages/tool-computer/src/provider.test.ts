import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ComputerToolProvider as PublicComputerToolProvider,
  ComputerToolProviderError,
  isStaleComputerTransportError,
  type ComputerMcpConnection,
  type ComputerMcpConnectionFactoryInput,
  type ComputerMcpToolPage,
  type ComputerToolCallResult
} from "./provider.js";
import { COMPUTER_TOOL_NAMES } from "./catalog.js";
import { ComputerRuntime } from "./runtime.js";

class ComputerToolProvider extends PublicComputerToolProvider {
  constructor(options: ConstructorParameters<typeof PublicComputerToolProvider>[0] = {}) {
    super({ ...options, catalogMode: "dynamic" });
  }
}

class UndecoratedComputerToolProvider extends PublicComputerToolProvider {
  constructor(options: ConstructorParameters<typeof PublicComputerToolProvider>[0] = {}) {
    super({ ...options, decorateCursor: false });
  }
}

describe("ComputerToolProvider sessions", () => {
  it("creates one independent MCP transport per Session with a scrubbed environment", async () => {
    const harness = connectionHarness([new FakeConnection(), new FakeConnection()]);
    const provider = new ComputerToolProvider({
      executablePath: "/runtime/bin/driver",
      platform: "linux",
      environment: {
        HOME: "/home/joko",
        PATH: "/bin",
        OPENAI_API_KEY: "must-not-cross-the-boundary",
        HTTPS_PROXY: "https://credential@example.test"
      },
      connectionFactory: harness.factory,
      idFactory: sequenceIds("fence-a", "fence-b")
    });

    const [first, second] = await Promise.all([
      provider.openSession("session-a"),
      provider.openSession("session-b")
    ]);

    expect(first).toEqual({ sessionId: "session-a", generation: 1, token: "fence-a" });
    expect(second).toEqual({ sessionId: "session-b", generation: 1, token: "fence-b" });
    expect(harness.inputs).toEqual([
      {
        sessionId: "session-a",
        command: "/runtime/bin/driver",
        arguments: ["mcp"],
        environment: { HOME: "/home/joko", PATH: "/bin" },
        startupTimeoutMs: 10_000,
        requestTimeoutMs: 45_000
      },
      {
        sessionId: "session-b",
        command: "/runtime/bin/driver",
        arguments: ["mcp"],
        environment: { HOME: "/home/joko", PATH: "/bin" },
        startupTimeoutMs: 10_000,
        requestTimeoutMs: 45_000
      }
    ]);
    expect(provider.activeSessionCount).toBe(2);
  });

  it("deduplicates concurrent opens for the same Session", async () => {
    const connection = new FakeConnection({
      connect: async () => new Promise<void>((resolve) => queueMicrotask(resolve))
    });
    const harness = connectionHarness([connection]);
    const provider = new ComputerToolProvider({
      connectionFactory: harness.factory,
      idFactory: () => "one-fence"
    });

    const [first, second] = await Promise.all([
      provider.openSession("same-session"),
      provider.openSession("same-session")
    ]);

    expect(first).toBe(second);
    expect(harness.inputs).toHaveLength(1);
    expect(connection.connectCount).toBe(1);
  });

  it("closes a Session, fences the old handle, and increments its generation when reopened", async () => {
    const firstConnection = new FakeConnection();
    const secondConnection = new FakeConnection();
    const harness = connectionHarness([firstConnection, secondConnection]);
    const provider = new ComputerToolProvider({
      connectionFactory: harness.factory,
      idFactory: sequenceIds("first-fence", "second-fence")
    });
    const first = await provider.openSession("reused-session");

    await provider.closeSession(first);
    expect(firstConnection.closeCount).toBe(1);
    expect(provider.activeSessionCount).toBe(0);
    expect(() => provider.listTools(first)).toThrowError(ComputerToolProviderError);

    const second = await provider.openSession("reused-session");
    expect(second).toEqual({
      sessionId: "reused-session",
      generation: 2,
      token: "second-fence"
    });
    expect(secondConnection.connectCount).toBe(1);
  });

  it("aborts in-flight work before closing its transport", async () => {
    let operationSignal: AbortSignal | undefined;
    const connection = new FakeConnection({
      listTools: async (_cursor, signal) => {
        operationSignal = signal;
        return new Promise<ComputerMcpToolPage>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true }
          );
        });
      }
    });
    const provider = new ComputerToolProvider({
      connectionFactory: connectionHarness([connection]).factory,
      idFactory: () => "fence"
    });
    const fence = await provider.openSession("session");
    const pending = provider.listTools(fence);
    await waitUntil(() => operationSignal !== undefined);

    await provider.closeSession(fence);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(operationSignal?.aborted).toBe(true);
    expect(connection.closeCount).toBe(1);
  });

  it("closes all active transports", async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    const provider = new ComputerToolProvider({
      connectionFactory: connectionHarness([first, second]).factory,
      idFactory: sequenceIds("one", "two")
    });
    await provider.openSession("one");
    await provider.openSession("two");

    await provider.closeAll();

    expect(first.closeCount).toBe(1);
    expect(second.closeCount).toBe(1);
    expect(provider.activeSessionCount).toBe(0);
  });

  it("closes transports that are still opening and gates new opens until closure finishes", async () => {
    let finishConnect: (() => void) | undefined;
    const first = new FakeConnection({
      connect: async () => new Promise<void>((resolve) => { finishConnect = resolve; })
    });
    const second = new FakeConnection();
    const harness = connectionHarness([first, second]);
    const provider = new ComputerToolProvider({
      connectionFactory: harness.factory,
      idFactory: sequenceIds("opening-fence", "later-fence")
    });
    const opening = provider.openSession("opening");
    await waitUntil(() => finishConnect !== undefined);

    const closing = provider.closeAll();
    const laterOpening = provider.openSession("later");
    expect(harness.inputs).toHaveLength(1);
    finishConnect?.();

    await opening;
    await closing;
    const later = await laterOpening;
    expect(first.closeCount).toBe(1);
    expect(later).toEqual({ sessionId: "later", generation: 1, token: "later-fence" });
    expect(second.connectCount).toBe(1);
  });
});

describe("ComputerToolProvider tool discovery and calls", () => {
  it("reads the dynamic paginated tool catalog and returns defensive copies", async () => {
    const inputSchema = { type: "object", properties: { key: { type: "string" } } };
    const connection = new FakeConnection({
      listTools: async (cursor) => cursor === undefined
        ? {
            tools: [{
              name: "screen.capture",
              title: "Capture\0 Screen",
              description: "Read the active display",
              inputSchema
            }],
            nextCursor: "next"
          }
        : {
            tools: [{ name: "pointer.click", inputSchema: { type: "object" } }]
          }
    });
    const provider = new ComputerToolProvider({
      connectionFactory: connectionHarness([connection]).factory,
      idFactory: () => "fence"
    });
    const fence = await provider.openSession("session");

    const tools = await provider.listTools(fence);
    (inputSchema.properties.key as { type: string }).type = "number";

    expect(connection.listRequests.map(({ cursor }) => cursor)).toEqual([undefined, "next"]);
    expect(tools).toEqual([
      {
        name: "screen.capture",
        title: "Capture Screen",
        description: "Read the active display",
        inputSchema: { type: "object", properties: { key: { type: "string" } } }
      },
      { name: "pointer.click", inputSchema: { type: "object" } }
    ]);
  });

  it("re-reads the catalog before each call and passes a bounded clone of arguments", async () => {
    let catalogReads = 0;
    const connection = new FakeConnection({
      listTools: async () => {
        catalogReads += 1;
        return { tools: [{ name: "pointer.click", inputSchema: { type: "object" } }] };
      },
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] })
    });
    const provider = new ComputerToolProvider({
      connectionFactory: connectionHarness([connection]).factory,
      idFactory: () => "fence"
    });
    const fence = await provider.openSession("session");
    const point = { x: 12, y: 34 };

    const pending = provider.callTool(fence, "pointer.click", { point });
    point.x = 999;
    const response = await pending;
    await provider.callTool(fence, "pointer.click", { point: { x: 2, y: 3 } });

    expect(response).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(catalogReads).toBe(2);
    expect(connection.callRequests[0]).toMatchObject({
      name: "pointer.click",
      arguments: { point: { x: 12, y: 34 } }
    });
  });

  it("rejects tools absent from the latest catalog", async () => {
    const connection = new FakeConnection({
      listTools: async () => ({ tools: [{ name: "screen.capture", inputSchema: {} }] })
    });
    const provider = new ComputerToolProvider({
      connectionFactory: connectionHarness([connection]).factory,
      idFactory: () => "fence"
    });
    const fence = await provider.openSession("session");

    await expect(provider.callTool(fence, "pointer.click", {})).rejects.toMatchObject({
      name: "ComputerToolProviderError",
      code: "unknown_tool",
      toolName: "pointer.click"
    });
    expect(connection.callRequests).toHaveLength(0);
  });

  it("rejects cyclic, non-JSON, and oversized arguments before transport use", async () => {
    const connection = new FakeConnection();
    const provider = new ComputerToolProvider({
      connectionFactory: connectionHarness([connection]).factory,
      maximumArgumentBytes: 32,
      idFactory: () => "fence"
    });
    const fence = await provider.openSession("session");
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    expect(() => provider.callTool(fence, "pointer.click", cyclic)).toThrowError(
      expect.objectContaining({ code: "invalid_arguments" })
    );
    expect(() => provider.callTool(fence, "pointer.click", { action: () => undefined })).toThrowError(
      expect.objectContaining({ code: "invalid_arguments" })
    );
    expect(() => provider.callTool(fence, "pointer.click", { text: "x".repeat(100) })).toThrowError(
      expect.objectContaining({ code: "invalid_arguments" })
    );
    expect(connection.listRequests).toHaveLength(0);
    expect(connection.callRequests).toHaveLength(0);
  });

  it("propagates a caller AbortSignal to catalog and tool requests", async () => {
    let callSignal: AbortSignal | undefined;
    const connection = new FakeConnection({
      listTools: async () => ({ tools: [{ name: "pointer.click", inputSchema: {} }] }),
      callTool: async (_name, _arguments, signal) => {
        callSignal = signal;
        return new Promise<ComputerToolCallResult>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true }
          );
        });
      }
    });
    const provider = new ComputerToolProvider({
      connectionFactory: connectionHarness([connection]).factory,
      idFactory: () => "fence"
    });
    const fence = await provider.openSession("session");
    const controller = new AbortController();
    const pending = provider.callTool(fence, "pointer.click", {}, controller.signal);
    await waitUntil(() => callSignal !== undefined);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(callSignal?.aborted).toBe(true);
  });
});

describe("ComputerToolProvider recovery", () => {
  it("reconnects once after a stale transport and retries discovery", async () => {
    const first = new FakeConnection({
      listTools: async () => { throw new Error("broken pipe: private detail"); }
    });
    const second = new FakeConnection({
      listTools: async () => ({ tools: [{ name: "screen.capture", inputSchema: {} }] })
    });
    const harness = connectionHarness([first, second]);
    const provider = new ComputerToolProvider({
      connectionFactory: harness.factory,
      idFactory: () => "fence"
    });
    const fence = await provider.openSession("session");

    await expect(provider.listTools(fence)).resolves.toEqual([
      { name: "screen.capture", inputSchema: {} }
    ]);
    expect(harness.inputs).toHaveLength(2);
    expect(first.closeCount).toBe(1);
    expect(second.connectCount).toBe(1);
  });

  it("reconnects once when a tool result reports a stale transport", async () => {
    const toolPage = { tools: [{ name: "pointer.click", inputSchema: {} }] };
    const first = new FakeConnection({
      listTools: async () => toolPage,
      callTool: async () => ({
        isError: true,
        content: [{ type: "text", text: "connection is closed: private detail" }]
      })
    });
    const second = new FakeConnection({
      listTools: async () => toolPage,
      callTool: async () => ({ content: [{ type: "text", text: "done" }] })
    });
    const harness = connectionHarness([first, second]);
    const provider = new ComputerToolProvider({
      connectionFactory: harness.factory,
      idFactory: () => "fence"
    });
    const fence = await provider.openSession("session");

    await expect(provider.callTool(fence, "pointer.click", { x: 1 })).resolves.toEqual({
      content: [{ type: "text", text: "done" }]
    });
    expect(first.callRequests.filter((call) => call.name === "pointer.click")).toHaveLength(1);
    expect(second.callRequests).toHaveLength(1);
    expect(harness.inputs).toHaveLength(2);
  });

  it("never performs a second reconnect and never exposes a transport error detail", async () => {
    const first = new FakeConnection({
      listTools: async () => { throw new Error("not connected: first private detail"); }
    });
    const second = new FakeConnection({
      listTools: async () => { throw new Error("broken pipe: second private detail"); }
    });
    const harness = connectionHarness([first, second]);
    const provider = new ComputerToolProvider({
      connectionFactory: harness.factory,
      idFactory: () => "fence"
    });
    const fence = await provider.openSession("session");

    const failure = await provider.listTools(fence).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "ComputerToolProviderError",
      code: "transport_failed",
      message: "Computer automation transport failed."
    });
    expect(String(failure)).not.toContain("private detail");
    expect(harness.inputs).toHaveLength(2);
  });

  it("closes a failed initial connection and returns a generic error", async () => {
    const connection = new FakeConnection({
      connect: async () => { throw new Error("credential-like private detail"); }
    });
    const provider = new ComputerToolProvider({
      connectionFactory: connectionHarness([connection]).factory,
      idFactory: () => "fence"
    });

    const failure = await provider.openSession("session").catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "ComputerToolProviderError",
      code: "connect_failed",
      message: "Computer automation transport could not connect."
    });
    expect(String(failure)).not.toContain("private detail");
    expect(connection.closeCount).toBe(1);
  });
});

describe("isStaleComputerTransportError", () => {
  it("recognizes transport closure families without classifying ordinary failures", () => {
    expect(isStaleComputerTransportError(new Error("write after end"))).toBe(true);
    expect(isStaleComputerTransportError(new Error("ECONNRESET"))).toBe(true);
    expect(isStaleComputerTransportError(new Error("operation rejected"))).toBe(false);
  });
});

describe("public computer automation surface", () => {
  it("publishes the complete stable 24-tool catalog independently of private driver tools", async () => {
    const connection = new FakeConnection({
      listTools: async () => ({ tools: [{ name: "private_driver_tool", inputSchema: {} }] })
    });
    const provider = new UndecoratedComputerToolProvider({
      connectionFactory: connectionHarness([connection]).factory,
      idFactory: () => "fence"
    });
    const fence = await provider.openSession("session");

    const tools = await provider.listTools(fence);

    expect(tools.map((tool) => tool.name)).toEqual(COMPUTER_TOOL_NAMES);
    expect(tools).toHaveLength(24);
    expect(connection.listRequests).toHaveLength(0);
  });

  it("falls back to the bounded one-shot CLI for lightweight state transport failures", async () => {
    const connection = new FakeConnection({
      callTool: async () => { throw new Error("request timed out after the bounded deadline"); }
    });
    const requests: Array<{ readonly arguments?: readonly string[]; readonly stdin?: string }> = [];
    const runtime = new ComputerRuntime({
      platform: "linux",
      executablePath: "/runtime/bin/driver",
      runner: {
        run: async (request) => {
          requests.push(request);
          return {
            stdout: '{"ok":true,"width":1920,"height":1080}\n',
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            exitCode: 0,
            signal: null
          };
        }
      }
    });
    const provider = new UndecoratedComputerToolProvider({
      runtime,
      connectionFactory: connectionHarness([connection]).factory,
      idFactory: () => "fence"
    });
    const fence = await provider.openSession("session");

    const value = await provider.callTool(fence, "get_screen_size", {});

    expect(value.structuredContent).toEqual({ ok: true, width: 1920, height: 1080 });
    expect(requests).toEqual([expect.objectContaining({
      arguments: ["call", "get_screen_size"],
      stdin: "{}\n"
    })]);
  });

  it("retries a lightweight non-CLI timeout once but does not retry long enumeration", async () => {
    const timedOut = new FakeConnection({
      callTool: async () => { throw new Error("driver request timed out after 10000ms"); }
    });
    const recovered = new FakeConnection({
      callTool: async () => ({ structuredContent: { ok: true, x: 10, y: 20 } })
    });
    const lightweightHarness = connectionHarness([timedOut, recovered]);
    const lightweight = new UndecoratedComputerToolProvider({
      platform: "linux",
      connectionFactory: lightweightHarness.factory,
      idFactory: () => "fence"
    });
    const lightweightFence = await lightweight.openSession("session-lightweight");

    await expect(lightweight.callTool(lightweightFence, "get_agent_cursor_state", {}))
      .resolves.toMatchObject({ structuredContent: { ok: true, x: 10, y: 20 } });
    expect(lightweightHarness.inputs).toHaveLength(2);
    expect(timedOut.callRequests.filter((request) => request.name === "get_agent_cursor_state")).toHaveLength(1);
    expect(recovered.callRequests.filter((request) => request.name === "get_agent_cursor_state")).toHaveLength(1);

    const enumerationConnection = new FakeConnection({
      callTool: async () => { throw new Error("driver request timed out after 45000ms"); }
    });
    const enumerationHarness = connectionHarness([enumerationConnection]);
    const enumeration = new UndecoratedComputerToolProvider({
      platform: "linux",
      connectionFactory: enumerationHarness.factory,
      idFactory: () => "fence"
    });
    const enumerationFence = await enumeration.openSession("session-enumeration");

    await expect(enumeration.callTool(enumerationFence, "list_windows", {}))
      .rejects.toMatchObject({ code: "transport_failed" });
    expect(enumerationHarness.inputs).toHaveLength(1);
    expect(enumerationConnection.callRequests.filter((request) => request.name === "list_windows"))
      .toHaveLength(1);
  });

  it("does not invoke the Windows degraded fallback for permission or ordinary driver failures", async () => {
    const connection = new FakeConnection({
      callTool: async () => { throw new Error("permission denied by desktop service"); }
    });
    const run = vi.fn(async () => ({
      stdout: "[]",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: 0,
      signal: null
    }));
    const runtime = new ComputerRuntime({ platform: "win32", runner: { run } });
    const provider = new UndecoratedComputerToolProvider({
      runtime,
      connectionFactory: connectionHarness([connection]).factory,
      idFactory: () => "fence"
    });
    const fence = await provider.openSession("session");

    await expect(provider.callTool(fence, "list_windows", {}))
      .rejects.toMatchObject({ code: "transport_failed" });
    expect(run).not.toHaveBeenCalled();
  });

  it("enriches Windows fallback windows before applying host process filters", async () => {
    const connection = new FakeConnection({
      callTool: async () => { throw new Error("driver request timed out after the bounded deadline"); }
    });
    const requests: Array<{ readonly arguments?: readonly string[] }> = [];
    const runtime = new ComputerRuntime({
      platform: "win32",
      executablePath: "C:\\runtime\\driver.exe",
      runner: {
        run: async (request) => {
          requests.push(request);
          const processSnapshot = request.arguments?.some((argument) => argument.includes("Get-CimInstance")) === true;
          return {
            stdout: processSnapshot
              ? JSON.stringify({
                  ProcessId: 77,
                  ParentProcessId: 12,
                  Name: "node.exe",
                  ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
                  CommandLine: "node D:\\workspace\\project\\server.js"
                })
              : JSON.stringify({
                  window_id: 9,
                  pid: 77,
                  title: "Development Server",
                  process_name: "node",
                  executable_path: "C:\\Program Files\\nodejs\\node.exe",
                  on_screen: true,
                  minimized: false,
                  bounds: { x: 0, y: 0, width: 1280, height: 720 }
                }),
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            exitCode: 0,
            signal: null
          };
        }
      }
    });
    const provider = new UndecoratedComputerToolProvider({
      runtime,
      connectionFactory: connectionHarness([connection]).factory,
      idFactory: () => "fence"
    });
    const fence = await provider.openSession("session");

    const value = await provider.callTool(fence, "list_windows", {
      process_name: "node",
      query: "server.js",
      workspace_root: "D:\\workspace\\project"
    });

    expect(value.structuredContent?.["windows"]).toEqual([
      expect.objectContaining({
        pid: 77,
        process: expect.objectContaining({
          name: "node.exe",
          command: "node D:\\workspace\\project\\server.js"
        })
      })
    ]);
    expect(requests).toHaveLength(2);
  });

  it("owns driver session arguments and rejects stale element snapshots", async () => {
    let observations = 0;
    const connection = new FakeConnection({
      callTool: async (name) => {
        if (name === "get_window_state") {
          observations += 1;
          return {
            structuredContent: {
              ok: true,
              elements: [{ element_token: `driver-${observations}:0` }]
            }
          };
        }
        return { structuredContent: { ok: true } };
      }
    });
    const provider = new UndecoratedComputerToolProvider({
      connectionFactory: connectionHarness([connection]).factory,
      idFactory: sequenceIds("fence", "snapshot-a", "snapshot-b")
    });
    const fence = await provider.openSession("session-a");

    const first = await provider.callTool(fence, "get_window_state", {
      pid: 10,
      window_id: 2,
      capture_mode: "vision",
      session: "untrusted"
    });
    const firstSnapshot = first.structuredContent?.["snapshot_id"];
    expect(typeof firstSnapshot).toBe("string");
    expect(connection.callRequests[0]).toMatchObject({
      name: "get_window_state",
      arguments: {
        pid: 10,
        window_id: 2,
        capture_mode: "vision",
        session: "session-a-computer-fence-1-1"
      }
    });

    await provider.callTool(fence, "click", {
      pid: 10,
      window_id: 2,
      element_index: 0,
      snapshot_id: firstSnapshot
    });
    expect(connection.callRequests[1]?.arguments).toEqual({
      pid: 10,
      window_id: 2,
      element_index: 0,
      session: "session-a-computer-fence-1-1"
    });

    await provider.callTool(fence, "get_window_state", { pid: 10, window_id: 2 });
    const callsBeforeStaleAction = connection.callRequests.length;
    const stale = await provider.callTool(fence, "click", {
      pid: 10,
      window_id: 2,
      element_index: 0,
      snapshot_id: firstSnapshot
    });
    expect(stale).toMatchObject({
      isError: true,
      structuredContent: { errorCode: "STALE_SNAPSHOT" }
    });
    expect(connection.callRequests).toHaveLength(callsBeforeStaleAction);
  });

  it("owns the default screenshot path while preserving explicit and accessibility-only reads", async () => {
    const connection = new FakeConnection({
      callTool: async () => ({ structuredContent: { ok: true } })
    });
    const provider = new UndecoratedComputerToolProvider({
      connectionFactory: connectionHarness([connection]).factory,
      idFactory: () => "stable"
    });
    const fence = await provider.openSession("session");

    await provider.callTool(fence, "get_window_state", {
      pid: 7,
      window_id: 2,
      capture_mode: "vision"
    });
    await provider.callTool(fence, "get_window_state", {
      pid: 7,
      window_id: 2,
      capture_mode: "ax"
    });
    await provider.callTool(fence, "get_window_state", {
      pid: 7,
      window_id: 2,
      capture_mode: "som",
      screenshot_out_file: "D:\\workspace\\explicit.png"
    });

    expect(connection.callRequests[0]?.arguments["screenshot_out_file"])
      .toMatch(/joko-computer-automation[/\\]get_window_state-2-\d+-[a-f0-9]{8}\.png$/u);
    expect(connection.callRequests[1]?.arguments).not.toHaveProperty("screenshot_out_file");
    expect(connection.callRequests[2]?.arguments["screenshot_out_file"]).toBe("D:\\workspace\\explicit.png");
  });

  it("continues chunked Unicode text from the first unconfirmed chunk after one transport recovery", async () => {
    let firstCalls = 0;
    const first = new FakeConnection({
      callTool: async () => {
        firstCalls += 1;
        if (firstCalls === 2) {
          return { isError: true, content: [{ type: "text", text: "connection is closed" }] };
        }
        return { structuredContent: { ok: true, inserted: 400 } };
      }
    });
    const second = new FakeConnection({
      callTool: async () => ({ structuredContent: { ok: true, inserted: 50 } })
    });
    const provider = new UndecoratedComputerToolProvider({
      connectionFactory: connectionHarness([first, second]).factory,
      idFactory: () => "fence"
    });
    const fence = await provider.openSession("session");

    const result = await provider.callTool(fence, "type_text", {
      pid: 7,
      text: "界".repeat(450)
    });

    expect(Array.from(first.callRequests[0]?.arguments["text"] as string)).toHaveLength(400);
    expect(Array.from(first.callRequests[1]?.arguments["text"] as string)).toHaveLength(50);
    expect(Array.from(second.callRequests[0]?.arguments["text"] as string)).toHaveLength(50);
    expect(result.structuredContent).toMatchObject({ ok: true, inserted: 450, chars: 450, chunks: 2 });
    expect(JSON.stringify(result)).not.toContain("界");
  });

  it("rejects unknown fields before driver dispatch", async () => {
    const connection = new FakeConnection();
    const provider = new UndecoratedComputerToolProvider({
      connectionFactory: connectionHarness([connection]).factory,
      idFactory: () => "fence"
    });
    const fence = await provider.openSession("session");

    expect(() => provider.callTool(fence, "list_windows", {
      unknown_filter: "Editor"
    })).toThrow(expect.objectContaining({ code: "invalid_arguments" }));
    expect(() => provider.callTool(fence, "click", {
      pid: 1,
      secret_private_argument: true
    })).toThrow(expect.objectContaining({ code: "invalid_arguments" }));
    expect(connection.callRequests).toHaveLength(0);
  });

  it("validates and replays bounded trajectory actions through the normal guarded dispatch path", async () => {
    const root = mkdtempSync(join(tmpdir(), "joko-computer-replay-"));
    const recording = join(root, "recording");
    mkdirSync(recording);
    const debugImage = join(root, "captures", "click.png");
    try {
      writeTrajectoryAction(recording, "turn-001", {
        tool: "click",
        arguments: { pid: 9, window_id: 2, x: 10, y: 20, debug_image_out: debugImage }
      });
      writeTrajectoryAction(recording, "turn-002", {
        tool: "get_cursor_position",
        arguments: {}
      });
      const connection = new FakeConnection({
        callTool: async () => ({ structuredContent: { ok: true } })
      });
      const provider = new UndecoratedComputerToolProvider({
        connectionFactory: connectionHarness([connection]).factory,
        idFactory: () => "fence"
      });
      const fence = await provider.openSession("session");

      const replayed = await provider.callTool(fence, "replay_trajectory", {
        dir: recording,
        delay_ms: 0
      }, undefined, { workspaceRoot: root });

      expect(connection.callRequests.map((call) => call.name)).toEqual(["click", "get_cursor_position"]);
      expect(connection.callRequests[0]?.arguments).toMatchObject({
        pid: 9,
        debug_image_out: debugImage,
        session: "session-computer-fence-1-1"
      });
      expect(replayed.structuredContent).toMatchObject({
        ok: true,
        data: { attempted: 2, succeeded: 2, failed: 0 }
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects nested replay before any driver effect", async () => {
    const root = mkdtempSync(join(tmpdir(), "joko-computer-replay-"));
    try {
      const turn = join(root, "turn-001");
      mkdirSync(turn);
      writeFileSync(
        join(turn, "action.json"),
        JSON.stringify({ tool: "replay_trajectory", arguments: { dir: root } })
      );
      const connection = new FakeConnection();
      const provider = new UndecoratedComputerToolProvider({
        connectionFactory: connectionHarness([connection]).factory,
        idFactory: () => "fence"
      });
      const fence = await provider.openSession("session");

      const rejected = await provider.callTool(fence, "replay_trajectory", { dir: root });

      expect(rejected).toMatchObject({
        isError: true,
        structuredContent: { errorCode: "TRAJECTORY_VALIDATION_FAILED" }
      });
      expect(connection.callRequests).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies the Joko-owned cursor decoration once per live driver session", async () => {
    const connection = new FakeConnection({
      callTool: async () => ({ structuredContent: { ok: true } })
    });
    const provider = new PublicComputerToolProvider({
      connectionFactory: connectionHarness([connection]).factory,
      idFactory: () => "fence"
    });
    const fence = await provider.openSession("session");

    await provider.callTool(fence, "click", { pid: 1, x: 2, y: 3 });
    await provider.callTool(fence, "click", { pid: 1, x: 4, y: 5 });

    expect(connection.callRequests.map((call) => call.name)).toEqual([
      "set_agent_cursor_motion",
      "set_agent_cursor_style",
      "click",
      "click"
    ]);
    expect(connection.callRequests[0]?.arguments).toMatchObject({
      cursor_color: "#ff9800",
      cursor_label: "Joko"
    });
    expect(connection.callRequests[1]?.arguments).toMatchObject({
      gradient_colors: ["#ff9800", "#d97706"],
      bloom_color: "#ff9800"
    });
  });

  it("keeps local list-window filters away from the driver and applies them to enriched results", async () => {
    const connection = new FakeConnection({
      callTool: async () => ({
        structuredContent: {
          ok: true,
          windows: [
            {
              pid: 7,
              title: "Editor - Project",
              process_name: "Editor",
              workspace_root: "D:/workspace/project"
            },
            {
              pid: 8,
              title: "Terminal",
              process_name: "Terminal",
              workspace_root: "D:/workspace/other"
            }
          ]
        }
      })
    });
    const provider = new UndecoratedComputerToolProvider({
      connectionFactory: connectionHarness([connection]).factory,
      idFactory: () => "fence"
    });
    const fence = await provider.openSession("session");

    const result = await provider.callTool(fence, "list_windows", {
      process_name: "edit",
      query: "project",
      workspace_root: "D:/workspace/project"
    });

    expect(connection.callRequests[0]?.arguments).toEqual({ session: "session-computer-fence-1-1" });
    expect(result.structuredContent?.["windows"]).toEqual([
      expect.objectContaining({ pid: 7, process_name: "Editor" })
    ]);
  });
});

function writeTrajectoryAction(
  root: string,
  turn: string,
  action: Readonly<Record<string, unknown>>
): void {
  const directory = join(root, turn);
  mkdirSync(directory);
  writeFileSync(join(directory, "action.json"), JSON.stringify(action));
}

interface FakeConnectionOptions {
  readonly connect?: (signal?: AbortSignal) => Promise<void>;
  readonly listTools?: (cursor: string | undefined, signal?: AbortSignal) => Promise<ComputerMcpToolPage>;
  readonly callTool?: (
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ) => Promise<ComputerToolCallResult>;
  readonly close?: () => Promise<void>;
}

class FakeConnection implements ComputerMcpConnection {
  readonly #options: FakeConnectionOptions;
  connectCount = 0;
  closeCount = 0;
  readonly listRequests: { cursor: string | undefined; signal: AbortSignal | undefined }[] = [];
  readonly callRequests: {
    name: string;
    arguments: Readonly<Record<string, unknown>>;
    signal: AbortSignal | undefined;
  }[] = [];

  constructor(options: FakeConnectionOptions = {}) {
    this.#options = options;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    this.connectCount += 1;
    await this.#options.connect?.(signal);
  }

  async listTools(cursor: string | undefined, signal?: AbortSignal): Promise<ComputerMcpToolPage> {
    this.listRequests.push({ cursor, signal });
    return await this.#options.listTools?.(cursor, signal) ?? { tools: [] };
  }

  async callTool(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<ComputerToolCallResult> {
    this.callRequests.push({ name, arguments: arguments_, signal });
    return await this.#options.callTool?.(name, arguments_, signal) ?? {};
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    await this.#options.close?.();
  }
}

function connectionHarness(connections: readonly FakeConnection[]): {
  readonly inputs: ComputerMcpConnectionFactoryInput[];
  readonly factory: (input: ComputerMcpConnectionFactoryInput) => ComputerMcpConnection;
} {
  const queue = [...connections];
  const inputs: ComputerMcpConnectionFactoryInput[] = [];
  return {
    inputs,
    factory: (input) => {
      inputs.push(input);
      const connection = queue.shift();
      if (connection === undefined) throw new Error("Unexpected connection creation.");
      return connection;
    }
  };
}

function sequenceIds(...values: readonly string[]): () => string {
  const queue = [...values];
  return () => {
    const value = queue.shift();
    if (value === undefined) throw new Error("Unexpected fence creation.");
    return value;
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out while waiting for test state.");
}
