import { randomUUID } from "node:crypto";

import {
  CLAUDE_AGENT_SDK_VERSION,
  ClaudeCodeAdapter,
  type ClaudeRemoteRuntimePort,
  type ClaudeSdkForkOptions,
  type ClaudeSdkGetSessionMessagesOptions,
  type ClaudeSdkInitializationResult,
  type ClaudeSdkListSessionsOptions,
  type ClaudeSdkProbeInput,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryParams,
  type ClaudeSdkRuntime,
  type ClaudeSdkSessionInfo,
  type ClaudeSdkSessionMessage,
  type ClaudeSdkUserMessage
} from "@joko/adapter-claude-code";
import { OperationState } from "@joko/contracts";
import { expect, it } from "vitest";

import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  createSessionMutation,
  queueRunIdFrom,
  sendInputMutation,
  sessionIdFrom,
  submit
} from "./operations.js";

const BACKEND_ID = "remote-claude-product";
const REMOTE_WORKSPACE = "/srv/joko-project";
const initialization: ClaudeSdkInitializationResult = {
  models: [{
    value: "claude-remote-fixture",
    resolvedModel: "claude-remote-fixture-20260901",
    displayName: "Remote Claude fixture",
    description: "Controlled remote Claude runtime",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
    supportsFastMode: true
  }],
  account: { tokenSource: "managed-provider" }
};

it("dispatches a remote Claude turn through HTTP only after durable admission and fences stale authority before native input", async () => {
  const localRuntime = new ControlledClaudeRuntime();
  const remoteRuntime = new ControlledClaudeRuntime();
  let authorityCurrent = true;
  let remotePortClosed = false;
  const remoteRuntimes: ClaudeRemoteRuntimePort = {
    resolve: async (target) => {
      expect(target.remoteWorkspace).toEqual({ hostId: "host-a", workspaceRoot: REMOTE_WORKSPACE });
      return {
        runtime: remoteRuntime,
        workspaceRoot: REMOTE_WORKSPACE,
        remote: true,
        assertCurrent: () => {
          if (!authorityCurrent) throw new Error("Remote Target/Host/SSH authority changed.");
        }
      };
    },
    close: async () => { remotePortClosed = true; }
  };
  let fixture: OrchestratorE2eFixture | undefined;
  let adapter: ClaudeCodeAdapter | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({
      profiles: [],
      backendFactories: [{
        instanceId: BACKEND_ID,
        adapterKind: "claude-agent-sdk-stdio",
        displayName: "Remote Claude product fixture",
        create: ({ generation }) => {
          adapter = new ClaudeCodeAdapter({
            id: BACKEND_ID,
            instanceGeneration: generation,
            runtime: localRuntime,
            remoteRuntimes,
            environment: {},
            initializationTimeoutMs: 500,
            admissionTimeoutMs: 500,
            teardownTimeoutMs: 100
          });
          return adapter;
        }
      }]
    });
    const targetId = fixture.targetId(BACKEND_ID);
    const initialTarget = fixture.application.store.getTarget(targetId).descriptor;
    await fixture.application.sessionHost.registerTarget({
      ...initialTarget,
      workspaceRoot: "D:\\service-owned-placeholder",
      managed: false,
      remoteWorkspace: { hostId: "host-a", workspaceRoot: REMOTE_WORKSPACE }
    });
    const paired = await fixture.pair("Remote Claude product client");
    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId: BACKEND_ID, targetId })
    ));
    expect(localRuntime.queries).toHaveLength(0);
    expect(remoteRuntime.queries).toHaveLength(1);
    expect(remoteRuntime.queries[0]!.params.options.cwd).toBe(REMOTE_WORKSPACE);

    const operationId = "dispatch-remote-claude-text";
    let admission: {
      readonly operationStatus: string;
      readonly queueState: string;
      readonly runState: string;
      readonly attemptPersisted: boolean;
    } | undefined;
    remoteRuntime.onInput = () => {
      const item = fixture!.application.store.listQueueItems({ sessionId })
        .find((candidate) => candidate.operationId === operationId)!;
      const run = fixture!.application.store.getRun(item.runId);
      admission = {
        operationStatus: fixture!.application.store.getOperation(operationId).status,
        queueState: item.state,
        runState: run.descriptor.state,
        attemptPersisted: item.attemptId !== undefined
          && fixture!.application.store.getAttempt(item.attemptId).descriptor.endedAt === undefined
      };
    };
    const accepted = await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(
        sessionId,
        BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation),
        "Run this turn on the exact remote workspace."
      ),
      operationId
    );
    expect(accepted.state).toBe(OperationState.SUCCEEDED);
    await waitFor(
      async () => remoteRuntime.queries[0]!.receivedInputs.length,
      (count) => count === 1,
      "remote Claude input admission"
    );
    expect(admission).toEqual({
      operationStatus: "completed",
      queueState: "dispatching",
      runState: "queued",
      attemptPersisted: true
    });
    expect(remoteRuntime.queries[0]!.receivedInputs[0]!.message.content)
      .toBe("Run this turn on the exact remote workspace.");
    remoteRuntime.queries[0]!.complete("Remote Claude result");
    const runId = queueRunIdFrom(accepted);
    await waitFor(
      async () => fixture!.application.store.getRun(runId).descriptor.state,
      (state) => state === "completed",
      "remote Claude turn completion"
    );
    expect(fixture.application.store.findQueueItemByRunId(sessionId, runId)?.state).toBe("completed");

    authorityCurrent = false;
    const staleOperationId = "dispatch-stale-remote-claude-text";
    const stale = await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(
        sessionId,
        BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation),
        "This must not reach the retired remote authority."
      ),
      staleOperationId
    );
    expect(stale.state).toBe(OperationState.SUCCEEDED);
    const staleRunId = queueRunIdFrom(stale);
    await waitFor(
      async () => fixture!.application.store.getRun(staleRunId).descriptor.state,
      (state) => state === "failed",
      "stale remote Claude dispatch rejection"
    );
    expect(remoteRuntime.queries[0]!.receivedInputs).toHaveLength(1);
    expect(fixture.application.store.getRun(staleRunId).descriptor.error).toMatchObject({
      stateMayHaveChanged: false
    });
  } finally {
    authorityCurrent = true;
    await fixture?.close();
    await adapter?.dispose();
    if (adapter !== undefined) expect(remotePortClosed).toBe(true);
  }
});

class ControlledClaudeRuntime implements ClaudeSdkRuntime {
  readonly packageVersion = CLAUDE_AGENT_SDK_VERSION;
  readonly supportsWorkspaceDerivation = false;
  readonly queries: ControlledClaudeQuery[] = [];
  readonly sessions = new Map<string, ClaudeSdkSessionInfo>();
  onInput?: (message: ClaudeSdkUserMessage) => void;

  async probe(_input: ClaudeSdkProbeInput) {
    return {
      installed: true,
      packageVersion: this.packageVersion,
      cliVersion: "2.1.259",
      initialization
    };
  }

  async query(params: ClaudeSdkQueryParams): Promise<ClaudeSdkQuery> {
    const sessionId = params.options.resume ?? params.options.sessionId;
    if (sessionId === undefined) throw new Error("Controlled Query requires an exact native Session ID.");
    this.sessions.set(sessionId, {
      sessionId,
      summary: "Remote Claude product fixture",
      lastModified: Date.now(),
      cwd: params.options.cwd
    });
    const query = new ControlledClaudeQuery(params, sessionId, (message) => this.onInput?.(message));
    this.queries.push(query);
    return query;
  }

  async retireQuery(query: ClaudeSdkQuery): Promise<void> {
    query.close();
  }

  async getSessionInfo(sessionId: string): Promise<ClaudeSdkSessionInfo | undefined> {
    return this.sessions.get(sessionId);
  }

  async getSessionMessages(
    _sessionId: string,
    _options: ClaudeSdkGetSessionMessagesOptions
  ): Promise<readonly ClaudeSdkSessionMessage[]> {
    return [];
  }

  async listSessions(options: ClaudeSdkListSessionsOptions): Promise<readonly ClaudeSdkSessionInfo[]> {
    return [...this.sessions.values()].slice(options.offset, options.offset + options.limit);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async forkSession(_sessionId: string, _options: ClaudeSdkForkOptions): Promise<{ readonly sessionId: string }> {
    throw new Error("This controlled remote runtime does not support workspace derivation.");
  }

  ownsSessionFork(): boolean {
    return false;
  }

  async closeSessionOperations(): Promise<void> {}
}

class ControlledClaudeQuery implements ClaudeSdkQuery {
  readonly receivedInputs: ClaudeSdkUserMessage[] = [];
  readonly #output = new AsyncOutput();
  readonly #sessionId: string;
  readonly #onInput: (message: ClaudeSdkUserMessage) => void;
  readonly params: ClaudeSdkQueryParams;
  #closed = false;

  constructor(params: ClaudeSdkQueryParams, sessionId: string, onInput: (message: ClaudeSdkUserMessage) => void) {
    this.params = params;
    this.#sessionId = sessionId;
    this.#onInput = onInput;
    void this.#consume();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.#output;
  }

  async #consume(): Promise<void> {
    for await (const message of this.params.prompt) {
      this.receivedInputs.push(message);
      this.#onInput(message);
      this.#output.push({
        type: "system",
        subtype: "init",
        session_id: this.#sessionId,
        uuid: randomUUID(),
        claude_code_version: "2.1.259",
        apiKeySource: "managed-provider",
        cwd: this.params.options.cwd,
        model: "claude-remote-fixture",
        permissionMode: this.params.options.permissionMode,
        effort: this.params.options.effort ?? "high",
        tools: ["Read", "Edit", "Bash"],
        mcp_servers: [],
        slash_commands: [],
        output_style: "default",
        skills: [],
        plugins: [],
        capabilities: ["interrupt_receipt_v1"]
      });
      if (this.params.options.extraArgs?.["replay-user-messages"] === null) {
        this.#output.push({ ...message, isReplay: true, session_id: this.#sessionId });
      }
    }
  }

  complete(result: string): void {
    const userMessageUuid = this.receivedInputs.at(-1)?.uuid;
    this.#output.push({
      type: "result",
      subtype: "success",
      duration_ms: 100,
      duration_api_ms: 90,
      is_error: false,
      num_turns: 1,
      result,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      },
      modelUsage: {},
      permission_denials: [],
      terminal_reason: "completed",
      uuid: randomUUID(),
      session_id: this.#sessionId,
      ...(userMessageUuid === undefined ? {} : { user_message_uuid: userMessageUuid }),
      origin: { kind: "human" }
    });
  }

  async interrupt() {
    return { still_queued: [] };
  }

  async stopTask(_taskId: string): Promise<void> {}

  async setPermissionMode(_mode: Parameters<ClaudeSdkQuery["setPermissionMode"]>[0]): Promise<void> {}

  async setModel(_model?: string): Promise<void> {}

  async applyFlagSettings(_settings: Parameters<ClaudeSdkQuery["applyFlagSettings"]>[0]): Promise<void> {}

  async initializationResult(): Promise<ClaudeSdkInitializationResult> {
    return initialization;
  }

  async supportedModels() {
    return initialization.models;
  }

  async accountInfo() {
    return initialization.account;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.params.prompt[Symbol.asyncIterator]().return?.();
    this.#output.close();
  }
}

class AsyncOutput implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  readonly #values: unknown[] = [];
  readonly #readers: Array<(result: IteratorResult<unknown>) => void> = [];
  #closed = false;

  push(value: unknown): void {
    const reader = this.#readers.shift();
    if (reader === undefined) this.#values.push(value);
    else reader({ value, done: false });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const reader of this.#readers.splice(0)) reader({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<unknown>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.#readers.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }
}
