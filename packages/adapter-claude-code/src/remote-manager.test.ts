import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createManagerState, ManagerConnection } from "./remote-manager/manager.mjs";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const QUERY_ID = "22222222-2222-4222-8222-222222222222";
const INPUT_ID = "33333333-3333-4333-8333-333333333333";
const FORK_ID = "44444444-4444-4444-8444-444444444444";
const PEER_INPUT_ID = "55555555-5555-4555-8555-555555555555";
const NOTIFICATION_INPUT_ID = "66666666-6666-4666-8666-666666666666";
const CALLBACK_TOKEN = "manager-callback-token";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("remote Claude manager protocol", () => {
  it("exposes only the frozen product catalog and returns structured calls through its exact Query callback", async () => {
    const previousRoot = process.env["JOKO_CLAUDE_RUNTIME_ROOT"];
    const previousExecutable = process.env["JOKO_CLAUDE_EXECUTABLE"];
    process.env["JOKO_CLAUDE_RUNTIME_ROOT"] = "/srv/joko-runtime";
    process.env["JOKO_CLAUDE_EXECUTABLE"] = "/srv/joko-runtime/current/claude";
    cleanups.push(async () => {
      restoreEnvironment("JOKO_CLAUDE_RUNTIME_ROOT", previousRoot);
      restoreEnvironment("JOKO_CLAUDE_EXECUTABLE", previousExecutable);
    });
    const sdk = new FakeSdk();
    const managerState = createManagerState(sdk as never);
    const socketPath = managerSocketPath();
    const server = net.createServer((socket) => new ManagerConnection(socket, managerState));
    await listen(server, socketPath);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") await rm(socketPath, { force: true });
    });
    const connection = await FrameClient.connect(socketPath);
    cleanups.push(() => connection.close());
    const productTool = {
      serverId: "approved-tools", name: "echo", description: "Echo approved data",
      inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      outputSchema: { type: "object", properties: { echoed: { type: "string" } }, required: ["echoed"], additionalProperties: false }
    };
    const params = {
      requestId: QUERY_ID, queryId: QUERY_ID, sessionId: SESSION_ID,
      ownerKey: "a".repeat(64), ownerGeneration: "target:host:ssh:one", afterSeq: 0,
      options: { ...queryOptions(), managedAgentTool: undefined, productMcpTools: [productTool] }
    };
    await connection.request("query.start", params, QUERY_ID);
    expect(sdk.queries).toHaveLength(1);
    const name = `joko_${createHash("sha256").update(productTool.serverId).digest("hex").slice(0, 24)}`;
    const mcpServers = sdk.queries[0]!.options["mcpServers"] as Record<string, { instance: {
      connect(transport: unknown): Promise<void>; close(): Promise<void>;
    } }>;
    expect(Object.keys(mcpServers)).toEqual([name]);
    expect(sdk.queries[0]!.options["strictMcpConfig"]).toBe(true);
    const client = new Client({ name: "remote-fixture", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(clientTransport), mcpServers[name]!.instance.connect(serverTransport)]);
      expect((await client.listTools()).tools).toEqual([expect.objectContaining({
        name: productTool.name, description: productTool.description,
        inputSchema: productTool.inputSchema, outputSchema: productTool.outputSchema
      })]);
      expect(await client.callTool({
        name: "echo", arguments: { value: "hello" }, _meta: { "claudecode/toolUseId": "remote-root-one" }
      })).toMatchObject({
        content: [{ type: "text", text: "approved" }], structuredContent: { echoed: "approved" }, isError: false
      });
      expect(connection.callbackFrames).toEqual([expect.objectContaining({
        callback: "productMcpTool",
        value: { serverId: "approved-tools", name: "echo", arguments: { value: "hello" }, toolUseId: "remote-root-one" }
      })]);
      expect(await client.callTool({
        name: "echo", arguments: { value: "hello", extra: true }, _meta: { "claudecode/toolUseId": "remote-root-two" }
      })).toMatchObject({ isError: true });
      expect(connection.callbackFrames).toHaveLength(1);
    } finally {
      await Promise.allSettled([client.close(), mcpServers[name]!.instance.close()]);
    }
    await expect(connection.request("query.retire", {
      queryId: QUERY_ID, attachmentId: managerState.queries.get(QUERY_ID)?.attachmentId,
      ownerKey: "a".repeat(64), ownerGeneration: "target:host:ssh:one", timeoutMs: 1_000
    })).resolves.toEqual({ retired: true });
    await expect(connection.request("query.start", {
      ...params, requestId: randomUUID(), queryId: randomUUID(),
      options: { ...queryOptions(), mcpServers: { unapproved: { command: "secret" } } }
    })).rejects.toThrow("invalid_request");
  });

  it("owns one daemon generation across attach, replay, callbacks, controls, Session operations, and exact retirement", async () => {
    const previousRoot = process.env["JOKO_CLAUDE_RUNTIME_ROOT"];
    const previousExecutable = process.env["JOKO_CLAUDE_EXECUTABLE"];
    process.env["JOKO_CLAUDE_RUNTIME_ROOT"] = "/srv/joko-runtime";
    process.env["JOKO_CLAUDE_EXECUTABLE"] = "/srv/joko-runtime/current/claude";
    cleanups.push(async () => {
      restoreEnvironment("JOKO_CLAUDE_RUNTIME_ROOT", previousRoot);
      restoreEnvironment("JOKO_CLAUDE_EXECUTABLE", previousExecutable);
    });

    const sdk = new FakeSdk();
    const managerState = createManagerState(sdk as never);
    const socketPath = managerSocketPath();
    const server = net.createServer((socket) => new ManagerConnection(socket, managerState));
    await listen(server, socketPath);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") await rm(socketPath, { force: true });
    });

    const first = await FrameClient.connect(socketPath);
    cleanups.push(() => first.close());
    const hello = await first.request("hello", {}) as Record<string, unknown>;
    expect(hello).toMatchObject({
      protocolVersion: 1,
      managerVersion: "1.0.0",
      managerGeneration: managerState.generation
    });

    const startParams = {
      requestId: QUERY_ID,
      queryId: QUERY_ID,
      sessionId: SESSION_ID,
      ownerKey: "a".repeat(64),
      ownerGeneration: "target:host:ssh:one",
      afterSeq: 0,
      options: queryOptions()
    };
    const started = await first.request("query.start", startParams, QUERY_ID) as Record<string, unknown>;
    expect(started).toMatchObject({ queryId: QUERY_ID, sessionId: SESSION_ID });
    const firstAttachment = String(started["attachmentId"]);
    await first.waitForEvent((frame) => frame["event"] === "message");

    const replayedStart = await first.request("query.start", startParams, QUERY_ID) as Record<string, unknown>;
    expect(sdk.queryCalls).toBe(1);
    expect(replayedStart["attachmentId"]).not.toBe(firstAttachment);
    const attachment = String(replayedStart["attachmentId"]);
    expect(sdk.managedServerCalls).toHaveLength(1);
    expect(sdk.queries[0]?.options).toMatchObject({
      agent: "general-purpose",
      toolAliases: {
        Agent: "mcp__joko_managed_subagent__delegate",
        Task: "mcp__joko_managed_subagent__delegate"
      },
      mcpServers: { joko_managed_subagent: expect.any(Object) }
    });

    const message = userMessage(INPUT_ID, "first input");
    await expect(first.request("query.input", {
      queryId: QUERY_ID,
      attachmentId: attachment,
      requestId: INPUT_ID,
      message
    }, INPUT_ID)).resolves.toEqual({ accepted: true });
    await first.waitForEvent((frame) => frame["event"] === "message"
      && (frame["value"] as Record<string, unknown> | undefined)?.["type"] === "assistant");
    await expect(first.request("query.input", {
      queryId: QUERY_ID,
      attachmentId: attachment,
      requestId: INPUT_ID,
      message
    }, INPUT_ID)).resolves.toEqual({ accepted: true });
    await waitUntil(() => sdk.queries[0]?.managedResults.length === 1);
    expect(sdk.queries[0]?.permissionResults).toEqual([{
      behavior: "allow",
      updatedInput: { path: "/srv/project/a.ts" }
    }]);
    expect(sdk.queries[0]?.oauthTokens).toEqual([CALLBACK_TOKEN]);
    expect(sdk.queries[0]?.hookResults).toEqual([{
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "fixture denied"
      }
    }]);
    expect(sdk.queries[0]?.managedResults).toEqual([{
      content: [{ type: "text", text: "delegated from host" }]
    }]);

    await expect(first.request("query.input", {
      queryId: QUERY_ID,
      attachmentId: attachment,
      requestId: PEER_INPUT_ID,
      message: userMessage(PEER_INPUT_ID, "peer input", {
        kind: "peer",
        from: SESSION_ID,
        fromMode: "prompting",
        senderTaskId: "managed-agent-parent",
        body: "peer input"
      })
    }, PEER_INPUT_ID)).resolves.toEqual({ accepted: true });
    await expect(first.request("query.input", {
      queryId: QUERY_ID,
      attachmentId: attachment,
      requestId: NOTIFICATION_INPUT_ID,
      message: userMessage(NOTIFICATION_INPUT_ID, "<task-notification>done</task-notification>", {
        kind: "task-notification"
      })
    }, NOTIFICATION_INPUT_ID)).resolves.toEqual({ accepted: true });
    await waitUntil(() => sdk.queries[0]?.inputs.length === 3);
    expect(sdk.queries[0]?.inputs.map((input) =>
      (input as Record<string, unknown>)["origin"])).toEqual([
      { kind: "human" },
      {
        kind: "peer",
        from: SESSION_ID,
        fromMode: "prompting",
        senderTaskId: "managed-agent-parent",
        body: "peer input"
      },
      { kind: "task-notification" }
    ]);

    await Promise.all([
      first.request("query.setModel", { queryId: QUERY_ID, attachmentId: attachment, model: "claude-fixture" }),
      first.request("query.setPermissionMode", { queryId: QUERY_ID, attachmentId: attachment, mode: "plan" }),
      first.request("query.applyFlagSettings", {
        queryId: QUERY_ID,
        attachmentId: attachment,
        settings: { effortLevel: "high", fastMode: true, autoCompactWindow: 128_000 }
      }),
      first.request("query.interrupt", { queryId: QUERY_ID, attachmentId: attachment })
    ]);
    expect(sdk.queries[0]?.controls).toEqual([
      ["model", "claude-fixture"],
      ["permission", "plan"],
      ["flags", { effortLevel: "high", fastMode: true, autoCompactWindow: 128_000 }],
      ["interrupt"]
    ]);

    const lastSeen = first.lastSequence;
    await first.close();
    sdk.queries[0]?.emit({ type: "assistant", uuid: randomUUID(), detached: true });
    await waitUntil(() => managerState.queries.get(QUERY_ID)?.nextSeq === lastSeen + 2);

    const second = await FrameClient.connect(socketPath);
    cleanups.push(() => second.close());
    const secondHello = await second.request("hello", {}) as Record<string, unknown>;
    expect(secondHello["managerGeneration"]).toBe(hello["managerGeneration"]);
    const attached = await second.request("query.attach", {
      queryId: QUERY_ID,
      ownerKey: "a".repeat(64),
      ownerGeneration: "target:host:ssh:one",
      afterSeq: lastSeen
    }) as Record<string, unknown>;
    expect(attached).toMatchObject({ queryId: QUERY_ID, sessionId: SESSION_ID });
    await expect(second.waitForEvent((frame) =>
      (frame["value"] as Record<string, unknown> | undefined)?.["detached"] === true
    )).resolves.toMatchObject({ seq: lastSeen + 1 });

    await expect(second.request("session.info", { sessionId: SESSION_ID, dir: "/srv/project" }))
      .resolves.toMatchObject({ sessionId: SESSION_ID, cwd: "/srv/project" });
    await expect(second.request("session.list", { dir: "/srv/project", limit: 10, offset: 0 }))
      .resolves.toHaveLength(1);
    await expect(second.request("session.messages", {
      sessionId: SESSION_ID,
      dir: "/srv/project",
      limit: 10,
      offset: 0,
      includeSystemMessages: true
    })).resolves.toEqual([]);
    await expect(second.request("session.fork", {
      sessionId: SESSION_ID,
      dir: "/srv/project"
    })).resolves.toEqual({ sessionId: FORK_ID });
    await expect(second.request("session.delete", { sessionId: FORK_ID, dir: "/srv/project" }))
      .resolves.toBeUndefined();

    await expect(second.request("query.retire", {
      queryId: QUERY_ID,
      attachmentId: attached["attachmentId"],
      ownerKey: "a".repeat(64),
      ownerGeneration: "target:host:ssh:one",
      timeoutMs: 1_000
    })).resolves.toEqual({ retired: true });
    expect(managerState.queries.get(QUERY_ID)?.retired).toBe(true);
  });
});

class FakeSdk {
  queryCalls = 0;
  readonly queries: FakeQuery[] = [];
  readonly managedServerCalls: Array<Record<string, unknown>> = [];
  readonly sessions = new Map<string, { sessionId: string; cwd: string }>([
    [SESSION_ID, { sessionId: SESSION_ID, cwd: "/srv/project" }]
  ]);

  query(params: { readonly prompt: AsyncIterable<unknown>; readonly options: Record<string, unknown> }): FakeQuery {
    this.queryCalls += 1;
    const query = new FakeQuery(params);
    this.queries.push(query);
    return query;
  }

  createSdkMcpServer(options: Record<string, unknown>): Record<string, unknown> {
    this.managedServerCalls.push(options);
    return { type: "sdk", name: options["name"], options };
  }

  async getSessionInfo(sessionId: string, options: { readonly dir: string }) {
    const session = this.sessions.get(sessionId);
    return session === undefined ? undefined : {
      ...session,
      summary: "Remote fixture",
      lastModified: 1,
      cwd: options.dir
    };
  }

  async getSessionMessages() { return []; }

  async listSessions(options: { readonly dir: string }) {
    return [...this.sessions.values()].map((session) => ({
      ...session,
      summary: "Remote fixture",
      lastModified: 1,
      cwd: options.dir
    }));
  }

  async deleteSession(sessionId: string) { this.sessions.delete(sessionId); }

  async forkSession() {
    this.sessions.set(FORK_ID, { sessionId: FORK_ID, cwd: "/srv/project" });
    return { sessionId: FORK_ID };
  }
}

class FakeQuery implements AsyncIterable<unknown> {
  readonly inputs: unknown[] = [];
  readonly permissionResults: unknown[] = [];
  readonly oauthTokens: unknown[] = [];
  readonly hookResults: unknown[] = [];
  readonly managedResults: unknown[] = [];
  readonly controls: unknown[][] = [];
  readonly #output = new AsyncQueue<unknown>();
  readonly #params: { readonly prompt: AsyncIterable<unknown>; readonly options: Record<string, unknown> };

  constructor(params: { readonly prompt: AsyncIterable<unknown>; readonly options: Record<string, unknown> }) {
    this.#params = params;
    this.emit({ type: "system", subtype: "init", session_id: SESSION_ID, cwd: "/srv/project" });
    void this.#consume();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> { return this.#output; }

  get options(): Record<string, unknown> { return this.#params.options; }

  emit(value: unknown): void { this.#output.push(value); }

  async #consume(): Promise<void> {
    for await (const input of this.#params.prompt) {
      this.inputs.push(input);
      const canUseTool = this.#params.options["canUseTool"] as (
        tool: string,
        input: Record<string, unknown>,
        options: Record<string, unknown>
      ) => Promise<unknown>;
      this.permissionResults.push(await canUseTool("Read", { path: "/srv/project/a.ts" }, {
        toolUseID: "tool-one",
        requestId: "permission-one",
        signal: new AbortController().signal
      }));
      const getOAuthToken = this.#params.options["getOAuthToken"] as (
        options: { readonly signal: AbortSignal; onDecline(): void }
      ) => Promise<unknown>;
      this.oauthTokens.push(await getOAuthToken({
        signal: new AbortController().signal,
        onDecline: () => undefined
      }));
      const hooks = this.#params.options["hooks"] as Record<string, Array<{
        hooks: Array<(input: Record<string, unknown>, toolUseId: string, options: { signal: AbortSignal }) => Promise<unknown>>;
      }>>;
      this.hookResults.push(await hooks["PreToolUse"]![0]!.hooks[0]!({
        hook_event_name: "PreToolUse",
        session_id: SESSION_ID,
        transcript_path: "/srv/private/transcript.jsonl",
        cwd: "/srv/project",
        tool_name: "Agent",
        tool_input: { model: "child-model" },
        tool_use_id: "agent-one"
      }, "agent-one", { signal: new AbortController().signal }));
      if (this.managedResults.length === 0) {
        const mcpServers = this.#params.options["mcpServers"] as Record<string, {
          readonly options: {
            readonly tools: Array<{
              readonly handler: (input: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown>;
            }>;
          };
        }>;
        const managedTool = mcpServers["joko_managed_subagent"]?.options.tools[0];
        if (managedTool === undefined) throw new Error("Managed Agent server was not installed.");
        this.managedResults.push(await managedTool.handler({
          description: "Remote inspector",
          prompt: "Inspect the remote Target.",
          subagent_type: "general-purpose",
          model: "claude-child"
        }, {
          _meta: { "claudecode/toolUseId": "agent-two" },
          signal: new AbortController().signal
        }));
      }
      this.emit({ type: "assistant", uuid: randomUUID() });
    }
    this.#output.close();
  }

  async interrupt() { this.controls.push(["interrupt"]); return { still_queued: [] }; }
  async stopTask(taskId: string) { this.controls.push(["stopTask", taskId]); }
  async setPermissionMode(mode: string) { this.controls.push(["permission", mode]); }
  async setModel(model?: string) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    this.controls.push(["model", model]);
  }
  async applyFlagSettings(settings: unknown) { this.controls.push(["flags", settings]); }
  async initializationResult() { return { models: [], account: {} }; }
  async supportedModels() { return []; }
  async accountInfo() { return {}; }
  close(): void { this.#output.close(); }
}

class AsyncQueue<T> implements AsyncIterableIterator<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  [Symbol.asyncIterator](): AsyncIterableIterator<T> { return this; }

  next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter({ value, done: false });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }
}

class FrameClient {
  readonly callbackFrames: Array<Record<string, unknown>> = [];
  readonly #socket: net.Socket;
  readonly #pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();
  readonly #events: Array<Record<string, unknown>> = [];
  readonly #eventWaiters: Array<{
    readonly predicate: (frame: Record<string, unknown>) => boolean;
    readonly resolve: (frame: Record<string, unknown>) => void;
    readonly reject: (error: unknown) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }> = [];
  #buffer = "";
  #closed = false;
  lastSequence = 0;

  private constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.#accept(chunk));
    socket.once("error", (error) => this.#fail(error));
    socket.once("close", () => this.#fail(new Error("Manager test connection closed.")));
  }

  static async connect(path: string): Promise<FrameClient> {
    const socket = net.createConnection(path);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new FrameClient(socket);
  }

  request(method: string, params: Record<string, unknown>, id = randomUUID()): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("Manager test client is closed."));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.write(`${JSON.stringify({ v: 1, kind: "request", id, method, params })}\n`);
    });
  }

  waitForEvent(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const existing = this.#events.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.#eventWaiters.indexOf(waiter);
          if (index >= 0) this.#eventWaiters.splice(index, 1);
          reject(new Error("Timed out waiting for a manager event."));
        }, 2_000)
      };
      this.#eventWaiters.push(waiter);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await new Promise<void>((resolve) => {
      this.#socket.once("close", resolve);
      this.#socket.end();
    });
  }

  #accept(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const raw = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const frame = JSON.parse(raw) as Record<string, unknown>;
      if (frame["kind"] === "response") {
        const id = String(frame["id"]);
        const pending = this.#pending.get(id);
        if (pending === undefined) continue;
        this.#pending.delete(id);
        if (frame["ok"] === true) pending.resolve(frame["value"]);
        else pending.reject(Object.assign(new Error(String((frame["error"] as Record<string, unknown>)?.["code"])), frame["error"]));
      } else if (frame["kind"] === "event") {
        this.lastSequence = Math.max(this.lastSequence, Number(frame["seq"]));
        this.#events.push(frame);
        for (const waiter of [...this.#eventWaiters]) {
          if (!waiter.predicate(frame)) continue;
          this.#eventWaiters.splice(this.#eventWaiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        }
      } else if (frame["kind"] === "callback") {
        if (frame["callback"] === "productMcpTool") this.callbackFrames.push(frame);
        const value = frame["callback"] === "canUseTool"
          ? { behavior: "allow", updatedInput: { path: "/srv/project/a.ts" } }
          : frame["callback"] === "hook"
            ? {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: "fixture denied"
                }
              }
            : frame["callback"] === "managedAgentTool"
              ? { text: "delegated from host" }
              : frame["callback"] === "productMcpTool"
                ? { content: [{ type: "text", text: "approved" }], structuredContent: { echoed: "approved" }, isError: false }
              : { value: CALLBACK_TOKEN, declined: false };
        this.#socket.write(`${JSON.stringify({
          v: 1,
          kind: "callback_result",
          callbackId: frame["callbackId"],
          ok: true,
          value
        })}\n`);
      }
    }
  }

  #fail(error: unknown): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const waiter of this.#eventWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

function queryOptions(): Record<string, unknown> {
  return {
    additionalDirectories: [],
    allowDangerouslySkipPermissions: true,
    agent: "general-purpose",
    cwd: "/srv/project",
    env: { CLAUDE_CODE_OAUTH_TOKEN: "startup-token" },
    extraArgs: { "replay-user-messages": null },
    getOAuthToken: true,
    hooks: { PreToolUse: [{ matcher: "Agent", hookCount: 1 }] },
    managedAgentTool: true,
    includePartialMessages: true,
    mcpServers: {},
    model: "claude-fixture",
    permissionMode: "bypassPermissions",
    persistSession: true,
    sessionId: SESSION_ID,
    settingSources: [],
    skills: [],
    strictMcpConfig: true,
    systemPrompt: { type: "preset", preset: "claude_code" },
    tools: { type: "preset", preset: "claude_code" }
  };
}

function userMessage(
  uuid: string,
  content: string,
  origin: Readonly<Record<string, unknown>> = { kind: "human" }
): Record<string, unknown> {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    origin,
    uuid
  };
}

function managerSocketPath(): string {
  const id = `joko-remote-claude-${process.pid}-${randomUUID()}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
}

async function listen(server: net.Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for manager state.");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
