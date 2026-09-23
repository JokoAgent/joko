import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { loadClaudeRemoteManagerSource } from "@joko/adapter-claude-code";
import type {
  ClaudePermissionResult,
  ClaudeSdkQueryOptions,
  ClaudeSdkQueryParams,
  ClaudeSdkUserMessage
} from "@joko/adapter-claude-code";
import type { TargetDescriptor } from "@joko/core";
import type {
  RemoteForwardingTransportPort,
  RemoteProcessHandle,
  RemoteProcessStartRequest,
  RemoteProcessTransportPort,
  RemoteReverseForwardHandle,
  RemoteSshTransportLease
} from "@joko/remote-ssh";
import type { RemoteHostRecord, StoredTarget } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RemoteClaudeRuntimeResolver } from "./remote-claude-runtime.js";
import type { RemoteHostRegistry } from "./remote-host-registry.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const FORK_ID = "22222222-2222-4222-8222-222222222222";
const INPUT_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const MANAGER_GENERATION = "77777777-7777-4777-8777-777777777777";
const RESTARTED_MANAGER_GENERATION = "88888888-8888-4888-8888-888888888888";
const MANAGER_SHA256 = createHash("sha256").update(await loadClaudeRemoteManagerSource()).digest("hex");

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("RemoteClaudeRuntimeResolver", () => {
  it("serializes only the frozen product Tool manifest and fences its callbacks to the exact Query", async () => {
    const fixture = createFixture();
    cleanups.push(() => fixture.resolver.close());
    const binding = await fixture.resolver.resolve(fixture.target);
    const call = vi.fn(async () => ({
      content: [{ type: "text", text: "approved" }],
      structuredContent: { echoed: "approved" }, isError: false
    }));
    const tool = {
      serverId: "approved-tools", name: "echo", description: "Echo approved data",
      inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      outputSchema: { type: "object", properties: { echoed: { type: "string" } }, required: ["echoed"], additionalProperties: false },
      call
    } as const;
    const query = await binding.runtime.query(queryParams(undefined, undefined, false, undefined, {
      mcpTools: [tool], mcpServers: {}, strictMcpConfig: true
    }));
    const startOptions = fixture.processes.startRequests.at(-1)?.params.options as Record<string, unknown>;
    expect(startOptions).toMatchObject({
      mcpServers: {}, strictMcpConfig: true,
      productMcpTools: [{
        serverId: tool.serverId, name: tool.name, description: tool.description,
        inputSchema: tool.inputSchema, outputSchema: tool.outputSchema
      }]
    });
    expect(JSON.stringify(startOptions)).not.toContain('"call"');
    await expect(fixture.processes.invokeCallback("productMcpTool", {
      serverId: tool.serverId, name: tool.name, arguments: { value: "hello" }, toolUseId: "native-root-one"
    })).resolves.toMatchObject({ structuredContent: { echoed: "approved" }, isError: false });
    expect(call).toHaveBeenCalledWith({ value: "hello" }, {
      toolUseId: "native-root-one", signal: expect.any(AbortSignal)
    });
    await expect(fixture.processes.invokeCallback("productMcpTool", {
      serverId: "not-approved", name: tool.name, arguments: {}, toolUseId: "native-root-two"
    })).rejects.toThrow("Callback failed");
    await expect(fixture.processes.invokeCallback("productMcpTool", {
      serverId: tool.serverId, name: tool.name, arguments: { value: "hello", unapproved: true }, toolUseId: "native-root-three"
    })).rejects.toThrow("Callback failed");
    expect(call).toHaveBeenCalledOnce();
    await binding.runtime.retireQuery(query, 2_000);
  });

  it("cancels a remote product Tool callback on manager cancellation before reporting any effect", async () => {
    const fixture = createFixture();
    cleanups.push(() => fixture.resolver.close());
    const binding = await fixture.resolver.resolve(fixture.target);
    let effectSignal: AbortSignal | undefined;
    const call: NonNullable<ClaudeSdkQueryOptions["mcpTools"]>[number]["call"] = vi.fn(async (_input, options) => {
      effectSignal = options.signal;
      await new Promise<void>((_resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(new Error("The effect was cancelled.")), { once: true }));
      return { content: [], isError: false };
    });
    const query = await binding.runtime.query(queryParams(undefined, undefined, false, undefined, {
      mcpTools: [{ serverId: "approved-tools", name: "wait", description: "Wait",
        inputSchema: { type: "object" }, call }]
    }));
    const pending = fixture.processes.invokeCallback("productMcpTool", {
      serverId: "approved-tools", name: "wait", arguments: {}, toolUseId: "native-root-wait"
    });
    await waitUntil(() => effectSignal !== undefined);
    fixture.processes.cancelCallback("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await waitUntil(() => effectSignal?.aborted === true);
    await expect(pending).rejects.toThrow("Callback failed");
    expect(call).toHaveBeenCalledOnce();
    await binding.runtime.retireQuery(query, 2_000);
  });

  it("binds the fixed isolated runtime to exact Target/SSH authority and supports the public Session surface", async () => {
    const fixture = createFixture();
    cleanups.push(() => fixture.resolver.close());
    const binding = await fixture.resolver.resolve(fixture.target);

    expect(binding).toMatchObject({ workspaceRoot: "/srv/project", remote: true });
    expect(fixture.capture).toHaveBeenCalledWith(fixture.target.id, "host-a", undefined);
    expect(fixture.processes.requests[0]).toMatchObject({ executable: "/bin/sh", cwd: "/srv/project" });
    expect(fixture.processes.requests[1]).toMatchObject({
      executable: "/home/test/.joko/runtime/v1/claude-code/current/node/bin/node",
      cwd: "/srv/project",
      env: {
        HOME: "/home/test/.joko/runtime/v1/claude-code/profile",
        CLAUDE_CONFIG_DIR: "/home/test/.joko/runtime/v1/claude-code/profile",
        TMPDIR: "/home/test/.joko/runtime/v1/claude-code/tmp"
      }
    });
    expect(Object.values(fixture.processes.requests[1]?.env ?? {}).join(" ")).not.toContain("private-fixture-token");

    await expect(binding.runtime.getSessionInfo(SESSION_ID, { dir: binding.workspaceRoot })).resolves.toMatchObject({
      sessionId: SESSION_ID,
      cwd: "/srv/project"
    });
    await expect(binding.runtime.listSessions({
      dir: binding.workspaceRoot,
      limit: 10,
      offset: 0,
      includeWorktrees: false,
      includeProgrammatic: true
    })).resolves.toHaveLength(1);
    await expect(binding.runtime.getSessionMessages(SESSION_ID, {
      dir: binding.workspaceRoot,
      limit: 10,
      offset: 0,
      includeSystemMessages: true
    })).resolves.toEqual([expect.objectContaining({ uuid: MESSAGE_ID, session_id: SESSION_ID })]);
    const recorded: string[] = [];
    await expect(binding.runtime.forkSession(SESSION_ID, {
      dir: binding.workspaceRoot,
      signal: new AbortController().signal,
      upToMessageId: MESSAGE_ID,
      recordSessionId: (id) => recorded.push(id)
    })).resolves.toEqual({ sessionId: FORK_ID });
    expect(recorded).toEqual([FORK_ID]);
    await expect(binding.runtime.deleteSession(SESSION_ID, { dir: binding.workspaceRoot })).resolves.toBeUndefined();

    const cached = await fixture.resolver.resolve(fixture.target);
    expect(cached).toBe(binding);
    expect(fixture.capture).toHaveBeenCalledOnce();
  });

  it("replays a lost start receipt, deduplicates a maybe-consumed input, restores callbacks, and confirms retirement", async () => {
    const fixture = createFixture({ dropStartResponseOnce: true, dropInputResponseOnce: true });
    cleanups.push(() => fixture.resolver.close());
    const binding = await fixture.resolver.resolve(fixture.target);
    const forwardClose = vi.fn(async () => undefined);
    fixture.forwarding.listen.mockResolvedValue({
      remoteHost: "127.0.0.1",
      remotePort: 39001,
      close: forwardClose
    } satisfies RemoteReverseForwardHandle);
    const permission = vi.fn(async (): Promise<ClaudePermissionResult> => ({
      behavior: "allow",
      updatedInput: { path: "/srv/project/a.ts" }
    }));
    const oauth = vi.fn(async () => "refreshed-oauth-token");
    const managedHook = vi.fn(async () => ({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: "fixture denied"
      }
    }));
    const managedAgent = vi.fn(async () => ({ text: "delegated remotely" }));
    const query = await binding.runtime.query(queryParams(permission, oauth, true, {
      PreToolUse: [{ matcher: "Agent", hooks: [managedHook] }]
    }, { agent: "general-purpose", managedAgentTool: managedAgent }));

    await waitUntil(() => fixture.processes.inputRequests.length === 2);
    expect(fixture.processes.startRequests).toHaveLength(2);
    expect(new Set(fixture.processes.startRequests.map((request) => request.id)).size).toBe(1);
    expect(fixture.processes.queryStartEffects).toBe(1);
    expect(fixture.processes.inputEffects).toBe(1);
    expect(fixture.processes.inputRequests.map((request) => request.id)).toEqual([INPUT_ID, INPUT_ID]);
    expect(fixture.processes.attachRequests).toEqual([
      expect.objectContaining({ ownerKey: expect.any(String), ownerGeneration: expect.any(String), afterSeq: 1 })
    ]);

    const first = await query[Symbol.asyncIterator]().next();
    expect(first).toEqual({ done: false, value: { type: "assistant", uuid: MESSAGE_ID } });
    await expect(query.initializationResult()).resolves.toMatchObject({ models: [expect.objectContaining({ value: "claude-fixture" })] });
    await expect(query.supportedModels()).resolves.toEqual([expect.objectContaining({ value: "claude-fixture" })]);
    await expect(query.accountInfo()).resolves.toMatchObject({ organization: "fixture" });
    await expect(query.interrupt()).resolves.toEqual({ still_queued: [] });
    await expect(query.setModel("claude-fixture")).resolves.toBeUndefined();
    await expect(query.setPermissionMode("acceptEdits")).resolves.toBeUndefined();
    await expect(query.applyFlagSettings({
      effortLevel: "high",
      fastMode: true,
      autoCompactWindow: 128_000
    })).resolves.toBeUndefined();

    await expect(fixture.processes.invokeCallback("canUseTool", {
      toolName: "Read",
      input: { path: "/srv/project/a.ts" },
      options: { toolUseID: "tool-one", requestId: "permission-one" }
    })).resolves.toEqual({ behavior: "allow", updatedInput: { path: "/srv/project/a.ts" } });
    expect(permission).toHaveBeenCalledOnce();
    await expect(fixture.processes.invokeCallback("oauth", {})).resolves.toEqual({
      value: "refreshed-oauth-token",
      declined: false
    });
    expect(oauth).toHaveBeenCalledOnce();
    await expect(fixture.processes.invokeCallback("hook", {
      event: "PreToolUse", matcherIndex: 0, hookIndex: 0, toolUseId: "agent-one",
      input: {
        hook_event_name: "PreToolUse", session_id: SESSION_ID, transcript_path: "/srv/private/transcript.jsonl",
        cwd: "/srv/project", tool_name: "Agent", tool_input: { model: "child-model" }, tool_use_id: "agent-one"
      }
    })).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(managedHook).toHaveBeenCalledWith(expect.objectContaining({ tool_name: "Agent" }), "agent-one", {
      signal: expect.any(AbortSignal)
    });
    await expect(fixture.processes.invokeCallback("managedAgentTool", {
      input: {
        description: "Remote inspector",
        prompt: "Inspect the exact remote Target.",
        subagent_type: "general-purpose",
        model: "claude-child",
        run_in_background: true
      },
      toolUseId: "agent-two"
    })).resolves.toEqual({ text: "delegated remotely" });
    expect(managedAgent).toHaveBeenCalledWith({
      description: "Remote inspector",
      prompt: "Inspect the exact remote Target.",
      subagent_type: "general-purpose",
      model: "claude-child",
      run_in_background: true
    }, { toolUseId: "agent-two", signal: expect.any(AbortSignal) });
    await expect(fixture.processes.invokeCallback("managedAgentTool", {
      input: { description: "Missing prompt" },
      toolUseId: "agent-invalid"
    })).rejects.toThrow("Callback failed");
    expect(managedAgent).toHaveBeenCalledOnce();

    const startOptions = fixture.processes.startRequests.at(-1)?.params.options as Record<string, unknown>;
    expect(startOptions.env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "private-fixture-token",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:39001/v1"
    });
    expect(startOptions.hooks).toEqual({ PreToolUse: [{ matcher: "Agent", hookCount: 1 }] });
    expect(startOptions).toMatchObject({ agent: "general-purpose", managedAgentTool: true });
    expect(fixture.forwarding.listen).toHaveBeenCalledWith(expect.objectContaining({
      localDestinationHost: "127.0.0.1",
      localDestinationPort: 4567,
      remoteListenHost: "127.0.0.1"
    }));

    await expect(binding.runtime.retireQuery(query, 2_000)).resolves.toBeUndefined();
    await expect(binding.runtime.retireQuery(query, 2_000)).resolves.toBeUndefined();
    expect(fixture.processes.retireEffects).toBe(1);
    expect(forwardClose).toHaveBeenCalledOnce();
  });

  it("preserves peer and task-notification origins across exact remote input receipts", async () => {
    const fixture = createFixture();
    cleanups.push(() => fixture.resolver.close());
    const binding = await fixture.resolver.resolve(fixture.target);
    const notificationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const messages: ClaudeSdkUserMessage[] = [{
      type: "user",
      message: { role: "user", content: "peer work" },
      parent_tool_use_id: null,
      origin: {
        kind: "peer",
        from: SESSION_ID,
        fromMode: "prompting",
        senderTaskId: "managed-agent-one",
        body: "peer work"
      },
      uuid: INPUT_ID
    }, {
      type: "user",
      message: { role: "user", content: "<task-notification>done</task-notification>" },
      parent_tool_use_id: null,
      origin: { kind: "task-notification" },
      uuid: notificationId
    }];
    const query = await binding.runtime.query(queryParams(undefined, undefined, false, undefined, {}, messages));

    await waitUntil(() => fixture.processes.inputEffects === 2);
    expect(fixture.processes.inputRequests.map((request) =>
      (request.params["message"] as ClaudeSdkUserMessage).origin)).toEqual([
      messages[0]!.origin,
      messages[1]!.origin
    ]);
    await binding.runtime.retireQuery(query, 2_000);
  });

  it("propagates a remote manager cancellation into the exact managed Agent callback signal", async () => {
    const fixture = createFixture();
    cleanups.push(() => fixture.resolver.close());
    const binding = await fixture.resolver.resolve(fixture.target);
    let callbackSignal: AbortSignal | undefined;
    const managedAgent = vi.fn(async (_input, options): Promise<{ text: string }> => {
      callbackSignal = options.signal;
      if (!options.signal.aborted) {
        await new Promise<void>((resolvePromise) =>
          options.signal.addEventListener("abort", () => resolvePromise(), { once: true }));
      }
      return { text: "cancelled" };
    });
    const query = await binding.runtime.query(queryParams(undefined, undefined, false, undefined, {
      managedAgentTool: managedAgent
    }));
    const pending = fixture.processes.invokeCallback("managedAgentTool", {
      input: { description: "Cancellable child", prompt: "Wait for cancellation." },
      toolUseId: "agent-cancel"
    });
    await waitUntil(() => callbackSignal !== undefined);

    fixture.processes.cancelCallback("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    await waitUntil(() => callbackSignal?.aborted === true);
    await expect(pending).resolves.toEqual({ text: "cancelled" });
    expect(managedAgent).toHaveBeenCalledOnce();
    await binding.runtime.retireQuery(query, 2_000);
  });

  it("does not replay a maybe-consumed Query start into a replacement manager generation", async () => {
    const fixture = createFixture({ dropStartResponseOnce: true, restartManagerOnStartDrop: true });
    cleanups.push(() => fixture.resolver.close());
    const binding = await fixture.resolver.resolve(fixture.target);

    await expect(binding.runtime.query(queryParams(undefined, undefined, false))).rejects.toMatchObject({
      code: "manager_generation_changed",
      stateMayHaveChanged: true
    });
    expect(fixture.processes.startRequests).toHaveLength(1);
    expect(fixture.processes.queryStartEffects).toBe(1);
    expect(fixture.processes.ownedRetireEffects).toBe(1);
    expect(() => binding.assertCurrent()).toThrow("manager_generation_changed");
  });

  it("fails closed on a replay gap and fences Target or SSH drift before another manager request", async () => {
    const fixture = createFixture({ replayGapOnce: true });
    cleanups.push(() => fixture.resolver.close());
    const binding = await fixture.resolver.resolve(fixture.target);
    const query = await binding.runtime.query(queryParams(undefined, undefined, false));
    fixture.processes.disconnectQuery();
    await expect(query[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "replay_gap",
      stateMayHaveChanged: true
    });
    expect(fixture.processes.attachRequests).toHaveLength(1);

    fixture.stored = { ...fixture.stored, revision: fixture.stored.revision + 1n };
    expect(() => binding.assertCurrent()).toThrow();
    const requests = fixture.processes.frames.length;
    await expect(binding.runtime.getSessionInfo(SESSION_ID, { dir: binding.workspaceRoot })).rejects.toThrow();
    expect(fixture.processes.frames).toHaveLength(requests);

    const ssh = createFixture();
    cleanups.push(() => ssh.resolver.close());
    const sshBinding = await ssh.resolver.resolve(ssh.target);
    ssh.authorityCurrent = false;
    expect(() => sshBinding.assertCurrent()).toThrow("SSH authority changed");
  });

  it("retires the exact persisted process owner after the manager loses its in-memory Query", async () => {
    const fixture = createFixture({ loseQueryOnDisconnect: true });
    cleanups.push(() => fixture.resolver.close());
    const binding = await fixture.resolver.resolve(fixture.target);
    const query = await binding.runtime.query(queryParams(undefined, undefined, false));
    await waitUntil(() => fixture.processes.inputEffects === 1);
    const output = query[Symbol.asyncIterator]();
    await expect(output.next()).resolves.toEqual({ done: false, value: { type: "assistant", uuid: MESSAGE_ID } });

    fixture.processes.disconnectQuery();
    await expect(output.next()).rejects.toMatchObject({ code: "query_missing", stateMayHaveChanged: true });
    await expect(binding.runtime.retireQuery(query, 2_000)).resolves.toBeUndefined();
    expect(fixture.processes.ownedRetireEffects).toBe(1);
  });

  it("rejects a running daemon whose source digest differs from the probed manager asset", async () => {
    const fixture = createFixture({ managerSha256: "0".repeat(64) });
    cleanups.push(() => fixture.resolver.close());

    await expect(fixture.resolver.resolve(fixture.target)).rejects.toMatchObject({
      code: "manager_version_mismatch",
      stateMayHaveChanged: false
    });
    expect(fixture.processes.frames.filter((frame) => frame.method === "owner.reconcile")).toHaveLength(0);
  });
});

interface FixtureOptions {
  readonly dropStartResponseOnce?: boolean;
  readonly dropInputResponseOnce?: boolean;
  readonly replayGapOnce?: boolean;
  readonly loseQueryOnDisconnect?: boolean;
  readonly restartManagerOnStartDrop?: boolean;
  readonly managerSha256?: string;
}

function createFixture(options: FixtureOptions = {}) {
  const target: TargetDescriptor = {
    id: "target-claude",
    backendId: "claude-code",
    displayName: "Remote Claude",
    workspaceRoot: "D:\\service-owned-placeholder",
    managed: false,
    trusted: true,
    remoteWorkspace: { hostTargetId: "target-claude", hostId: "host-a", workspaceRoot: "/srv/project" }
  };
  const host: RemoteHostRecord = {
    ownerId: "owner-a",
    targetId: target.id,
    id: "host-a",
    hostname: "host.example",
    port: 22,
    user: "test",
    source: "manual",
    authenticationMode: "system_agent",
    trust: { algorithm: "ssh-ed25519", fingerprint: "SHA256:pinned-host", pinnedAt: 1 },
    status: { state: "ready", changedAt: 1 },
    createdAt: 1,
    updatedAt: 1,
    revision: 7n
  };
  const processes = new FakeClaudeManagerProcesses(options);
  const forwarding = {
    open: vi.fn(async () => { throw new Error("Unexpected forward stream."); }),
    listen: vi.fn(async (_request: Parameters<RemoteForwardingTransportPort["listen"]>[0]): Promise<RemoteReverseForwardHandle> => {
      throw new Error("Unexpected reverse forward.");
    })
  } satisfies RemoteForwardingTransportPort;
  const lease: RemoteSshTransportLease = {
    capabilities: {
      commandExecution: true,
      processStreaming: true,
      interactiveTerminal: true,
      fileTransfer: true,
      tcpForwarding: true
    },
    processes,
    forwarding
  };
  const fixture = {
    target,
    host,
    processes,
    forwarding,
    stored: {
      descriptor: target,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
      revision: 11n
    } satisfies StoredTarget,
    authorityCurrent: true,
    capture: vi.fn()
  };
  fixture.capture.mockImplementation(async () => ({
    host,
    hostRevision: host.revision,
    leaseGeneration: 3,
    lease,
    assertCurrent: () => { if (!fixture.authorityCurrent) throw new Error("SSH authority changed"); },
    assertForwardingCurrent: () => { if (!fixture.authorityCurrent) throw new Error("SSH forwarding authority changed"); }
  }));
  const resolver = new RemoteClaudeRuntimeResolver({
    store: { getTarget: () => fixture.stored },
    registry: { captureProcessAuthority: fixture.capture } as unknown as Pick<RemoteHostRegistry, "captureProcessAuthority">
  });
  return Object.assign(fixture, { resolver });
}

class FakeClaudeManagerProcesses implements RemoteProcessTransportPort {
  readonly requests: RemoteProcessStartRequest[] = [];
  readonly frames: Array<Record<string, unknown>> = [];
  readonly startRequests: Array<{ readonly id: string; readonly params: Record<string, unknown> }> = [];
  readonly inputRequests: Array<{ readonly id: string; readonly params: Record<string, unknown> }> = [];
  readonly attachRequests: Array<Record<string, unknown>> = [];
  queryStartEffects = 0;
  inputEffects = 0;
  retireEffects = 0;
  ownedRetireEffects = 0;
  readonly #options: FixtureOptions;
  readonly #inputReceipts = new Set<string>();
  readonly #events: Array<Record<string, unknown>> = [];
  readonly #callbacks = new Map<string, { readonly resolve: (value: unknown) => void; readonly reject: (error: unknown) => void }>();
  #query: { queryId: string; sessionId: string; ownerKey: string; ownerGeneration: string; attachmentId: string; process: FixtureProcess } | undefined;
  #lostQuery: { queryId: string; ownerKey: string; ownerGeneration: string } | undefined;
  #startDropped = false;
  #inputDropped = false;
  #replayGapDelivered = false;
  #sequence = 1;
  #managerGeneration = MANAGER_GENERATION;

  constructor(options: FixtureOptions) { this.#options = options; }

  async open(request: RemoteProcessStartRequest): Promise<RemoteProcessHandle> {
    this.requests.push({ ...request, args: [...request.args], ...(request.env === undefined ? {} : { env: { ...request.env } }) });
    if (request.executable === "/bin/sh") {
      return new FixtureProcess(undefined, (process) => {
        queueMicrotask(() => {
          process.stdout.write(probeOutput());
          process.finish(0);
        });
      });
    }
    return new FixtureProcess((frame, process) => this.#accept(frame, process));
  }

  disconnectQuery(): void {
    const query = this.#query;
    if (query === undefined) return;
    if (this.#options.loseQueryOnDisconnect === true) {
      this.#lostQuery = {
        queryId: query.queryId,
        ownerKey: query.ownerKey,
        ownerGeneration: query.ownerGeneration
      };
      this.#query = undefined;
    }
    query.process.finish(1);
  }

  invokeCallback(callback: "canUseTool" | "oauth" | "hook" | "managedAgentTool" | "productMcpTool", value: unknown): Promise<unknown> {
    const query = this.#query;
    if (query === undefined) return Promise.reject(new Error("No query is attached."));
    const callbackId = callback === "oauth"
      ? "55555555-5555-4555-8555-555555555555"
      : callback === "hook"
        ? "99999999-9999-4999-8999-999999999999"
        : callback === "managedAgentTool"
          ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        : callback === "productMcpTool"
          ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        : "66666666-6666-4666-8666-666666666666";
    query.process.send({ v: 1, kind: "callback", callbackId, queryId: query.queryId, callback, value });
    return new Promise((resolve, reject) => this.#callbacks.set(callbackId, { resolve, reject }));
  }

  cancelCallback(callbackId: string): void {
    const query = this.#query;
    if (query === undefined) throw new Error("No query is attached.");
    query.process.send({ v: 1, kind: "callback_cancel", callbackId });
  }

  #accept(frame: Record<string, unknown>, process: FixtureProcess): void {
    this.frames.push(frame);
    if (frame.kind === "callback_result") {
      const callbackId = String(frame.callbackId);
      const pending = this.#callbacks.get(callbackId);
      if (pending === undefined) return;
      this.#callbacks.delete(callbackId);
      if (frame.ok === true) pending.resolve(frame.value);
      else pending.reject(new Error("Callback failed."));
      return;
    }
    if (frame.kind !== "request" || typeof frame.id !== "string" || typeof frame.method !== "string") return;
    const params = record(frame.params);
    if (frame.method === "hello") return process.respond(frame.id, {
      protocolVersion: 1,
      managerVersion: "1.0.0",
      managerSha256: this.#options.managerSha256 ?? MANAGER_SHA256,
      managerGeneration: this.#managerGeneration
    });
    if (frame.method === "owner.reconcile") return process.respond(frame.id, { reconciled: true });
    if (frame.method === "query.start") {
      this.startRequests.push({ id: frame.id, params });
      if (this.#query === undefined) {
        this.queryStartEffects += 1;
        this.#query = {
          queryId: String(params.queryId),
          sessionId: String(params.sessionId),
          ownerKey: String(params.ownerKey),
          ownerGeneration: String(params.ownerGeneration),
          attachmentId: crypto.randomUUID(),
          process
        };
      } else {
        this.#query.process = process;
        this.#query.attachmentId = crypto.randomUUID();
      }
      if (this.#options.dropStartResponseOnce === true && !this.#startDropped) {
        this.#startDropped = true;
        if (this.#options.restartManagerOnStartDrop === true) {
          this.#managerGeneration = RESTARTED_MANAGER_GENERATION;
          this.#lostQuery = {
            queryId: this.#query.queryId,
            ownerKey: this.#query.ownerKey,
            ownerGeneration: this.#query.ownerGeneration
          };
          this.#query = undefined;
        }
        process.finish(1);
        return;
      }
      return process.respond(frame.id, this.#attachment());
    }
    if (frame.method === "query.attach") {
      this.attachRequests.push(params);
      if (this.#options.replayGapOnce === true && !this.#replayGapDelivered) {
        this.#replayGapDelivered = true;
        return process.rejectResponse(frame.id, "replay_gap", true);
      }
      if (this.#query === undefined) return process.rejectResponse(frame.id, "query_missing", true);
      if (params.ownerKey !== this.#query.ownerKey || params.ownerGeneration !== this.#query.ownerGeneration) {
        return process.rejectResponse(frame.id, "query_owner_mismatch", true);
      }
      this.#query.process = process;
      this.#query.attachmentId = crypto.randomUUID();
      const afterSeq = Number(params.afterSeq);
      for (const event of this.#events) if (Number(event.seq) > afterSeq) process.send(event);
      return process.respond(frame.id, this.#attachment());
    }
    if (frame.method === "query.input") {
      this.inputRequests.push({ id: frame.id, params });
      if (!this.#inputReceipts.has(frame.id)) {
        this.#inputReceipts.add(frame.id);
        this.inputEffects += 1;
        this.#emit("message", { type: "assistant", uuid: MESSAGE_ID });
      }
      if (this.#options.dropInputResponseOnce === true && !this.#inputDropped) {
        this.#inputDropped = true;
        process.finish(1);
        return;
      }
      return process.respond(frame.id, { accepted: true });
    }
    if (frame.method === "query.initializationResult") return process.respond(frame.id, initialization());
    if (frame.method === "query.supportedModels") return process.respond(frame.id, initialization().models);
    if (frame.method === "query.accountInfo") return process.respond(frame.id, initialization().account);
    if (frame.method === "query.interrupt") return process.respond(frame.id, { still_queued: [] });
    if (["query.setModel", "query.setPermissionMode", "query.applyFlagSettings", "query.stopTask"].includes(frame.method)) {
      return process.respond(frame.id, undefined);
    }
    if (frame.method === "query.retire") {
      if (this.retireEffects === 0) {
        this.retireEffects += 1;
        this.#emit("retired");
      }
      return process.respond(frame.id, { retired: true });
    }
    if (frame.method === "query.retireOwned") {
      if (this.#query !== undefined) {
        if (params.ownerKey !== this.#query.ownerKey || params.ownerGeneration !== this.#query.ownerGeneration) {
          return process.rejectResponse(frame.id, "query_owner_mismatch", true);
        }
        if (this.retireEffects === 0) this.retireEffects += 1;
        return process.respond(frame.id, { retired: true });
      }
      if (this.#lostQuery === undefined || params.queryId !== this.#lostQuery.queryId
        || params.ownerKey !== this.#lostQuery.ownerKey || params.ownerGeneration !== this.#lostQuery.ownerGeneration) {
        return process.rejectResponse(frame.id, "retirement_unconfirmed", true);
      }
      this.ownedRetireEffects += 1;
      this.#lostQuery = undefined;
      return process.respond(frame.id, { retired: true });
    }
    if (frame.method === "session.info") return process.respond(frame.id, sessionInfo(String(params.sessionId)));
    if (frame.method === "session.list") return process.respond(frame.id, [sessionInfo(SESSION_ID)]);
    if (frame.method === "session.messages") return process.respond(frame.id, [{
      type: "assistant",
      uuid: MESSAGE_ID,
      session_id: String(params.sessionId),
      message: { role: "assistant", content: [] },
      parent_tool_use_id: null,
      parent_agent_id: null
    }]);
    if (frame.method === "session.fork") return process.respond(frame.id, { sessionId: FORK_ID });
    if (frame.method === "session.delete") return process.respond(frame.id, undefined);
    process.rejectResponse(frame.id, "method_unsupported", false);
  }

  #attachment(): Record<string, unknown> {
    if (this.#query === undefined) throw new Error("Missing fixture query.");
    return {
      queryId: this.#query.queryId,
      sessionId: this.#query.sessionId,
      attachmentId: this.#query.attachmentId,
      lastSeq: this.#sequence - 1,
      ended: false,
      retired: false
    };
  }

  #emit(event: "message" | "retired", value?: unknown): void {
    if (this.#query === undefined) return;
    const frame: Record<string, unknown> = {
      v: 1,
      kind: "event",
      queryId: this.#query.queryId,
      seq: this.#sequence++,
      event,
      ...(value === undefined ? {} : { value })
    };
    this.#events.push(frame);
    this.#query.process.send(frame);
  }
}

class FixtureProcess extends EventEmitter implements RemoteProcessHandle {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly pid = 42;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  #buffer = "";
  #finished = false;

  constructor(
    onFrame?: (frame: Record<string, unknown>, process: FixtureProcess) => void,
    onEnd?: (process: FixtureProcess) => void
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.#buffer += Buffer.from(chunk).toString("utf8");
        try {
          for (;;) {
            const newline = this.#buffer.indexOf("\n");
            if (newline < 0) break;
            const line = this.#buffer.slice(0, newline);
            this.#buffer = this.#buffer.slice(newline + 1);
            onFrame?.(JSON.parse(line) as Record<string, unknown>, this);
          }
          callback();
        } catch (error) { callback(error as Error); }
      },
      final: (callback) => { onEnd?.(this); queueMicrotask(() => this.finish(this.exitCode ?? 0)); callback(); }
    });
  }

  respond(id: string, value: unknown): void {
    this.send({ v: 1, kind: "response", id, ok: true, value });
  }

  rejectResponse(id: string, code: string, stateMayHaveChanged: boolean): void {
    this.send({ v: 1, kind: "response", id, ok: false, error: { code, stateMayHaveChanged } });
  }

  send(value: unknown): void {
    if (!this.#finished) this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.#finished) return false;
    this.signalCode = typeof signal === "string" ? signal : "SIGTERM";
    this.finish(null);
    return true;
  }

  finish(code: number | null): void {
    if (this.#finished) return;
    this.#finished = true;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, this.signalCode);
  }
}

function queryParams(
  canUseTool: ClaudeSdkQueryOptions["canUseTool"] = async (_tool, input) => ({ behavior: "allow", updatedInput: { ...input } }),
  getOAuthToken: ClaudeSdkQueryOptions["getOAuthToken"] = async () => null,
  includeProviderRoute = true,
  hooks?: ClaudeSdkQueryOptions["hooks"],
  optionOverrides: Partial<ClaudeSdkQueryOptions> = {},
  messages?: readonly ClaudeSdkUserMessage[]
): ClaudeSdkQueryParams {
  const prompt = (async function* (): AsyncGenerator<ClaudeSdkUserMessage> {
    const input = messages ?? [{
      type: "user",
      message: { role: "user", content: "hello" },
      parent_tool_use_id: null,
      origin: { kind: "human" },
      uuid: INPUT_ID
    } satisfies ClaudeSdkUserMessage];
    for (const message of input) yield message;
  })();
  return {
    prompt,
    options: {
      abortController: new AbortController(),
      additionalDirectories: [],
      allowDangerouslySkipPermissions: true,
      canUseTool,
      cwd: "/srv/project",
      env: includeProviderRoute ? {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:4567/v1",
        ANTHROPIC_AUTH_TOKEN: "private-fixture-token"
      } : {},
      getOAuthToken,
      ...(hooks === undefined ? {} : { hooks }),
      includePartialMessages: true,
      permissionMode: "default",
      persistSession: true,
      sessionId: SESSION_ID,
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      tools: { type: "preset", preset: "claude_code" },
      ...optionOverrides
    }
  };
}

function initialization() {
  return {
    models: [{ value: "claude-fixture", displayName: "Fixture", description: "Fixture model" }],
    account: { organization: "fixture" }
  };
}

function sessionInfo(sessionId: string) {
  return { sessionId, summary: "Fixture", lastModified: 1, cwd: "/srv/project" };
}

function probeOutput(): Buffer {
  const root = "/home/test/.joko/runtime/v1/claude-code";
  return Buffer.from([
    "/srv/project",
    root,
    `${root}/current/node/bin/node`,
    `${root}/current/manager.mjs`,
    `${root}/current/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`,
    `${root}/run/manager.sock`,
    "0.3.259",
    "2.1.259",
    "ready",
    ""
  ].join("\0"), "utf8");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a record.");
  return value as Record<string, unknown>;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Fixture condition timed out.");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
