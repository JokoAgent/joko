import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import {
  CLAUDE_AGENT_SDK_VERSION,
  ClaudeCodeAdapter,
  type ClaudeTextResourceSeed
} from "@joko/adapter-claude-code";
import type {
  ClaudeSdkForkOptions,
  ClaudeSdkGetSessionMessagesOptions,
  ClaudeSdkInitializationResult,
  ClaudeSdkListSessionsOptions,
  ClaudeSdkQuery,
  ClaudeSdkQueryParams,
  ClaudeSdkRuntime,
  ClaudeSdkSessionInfo,
  ClaudeSdkSessionMessage,
  ClaudeSdkUserMessage
} from "@joko/adapter-claude-code/testing";
import {
  CapabilitySupport,
  InputMentionRangeSchema,
  InputPartSchema,
  OperationState,
  ResourceKind
} from "@joko/contracts";
import type { AdapterContext, PromptInput, RuntimeResource } from "@joko/core";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { expect, it } from "vitest";

import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  createSessionMutation,
  pauseQueueMutation,
  resumeQueueMutation,
  sendInputMutation,
  sessionIdFrom,
  submit
} from "./operations.js";

it("uses the authenticated live task resource catalog through durable queue dispatch", async () => {
  const profile = {
    ...PI_LIKE_PROFILE,
    capabilities: [
      ...PI_LIKE_PROFILE.capabilities.filter((entry) => entry.key !== "input.mention"),
      { key: "input.mention", supported: true, options: ["resource"] }
    ]
  };
  let revision = "sha256:resource-one";
  let resourceVersion = 5n;
  class ResourceAdapter extends InstrumentedFakeAdapter {
    override async getResources(context: AdapterContext): Promise<readonly RuntimeResource[]> {
      return [{
        id: "prompt-release",
        kind: "prompt",
        name: "Release prompt",
        source: "managed",
        state: "loaded",
        revision,
        resourceVersion,
        runtimePath: join(context.target.workspaceRoot, ".runtime", "release.md"),
        runtimeGeneration: context.generation
      }];
    }
  }

  let fixture: OrchestratorE2eFixture | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({
      profiles: [profile],
      createAdapter: (entry) => new ResourceAdapter(entry)
    });
    const paired = await fixture.pair("Resource mention owner");
    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId: profile.id, targetId: fixture.targetId(profile.id) })
    ));
    const catalog = await paired.clients.session.listSessionResources({ sessionId });
    expect(catalog.resources).toEqual([expect.objectContaining({
      sessionId,
      resourceId: "prompt-release",
      kind: ResourceKind.PROMPT_TEMPLATE,
      discoveredRevision: revision,
      resourceVersion,
      runtimeGeneration: expect.any(BigInt)
    })]);
    const generation = catalog.resources[0]!.runtimeGeneration;
    const mutation = resourceInputMutation(sessionId, generation, revision, resourceVersion);
    const accepted = await submit(paired.clients.operation, paired.connectionId, mutation);
    expect(accepted.state).toBe(OperationState.SUCCEEDED);
    await waitFor(
      async () => fixture!.application.store.listQueueItems({ sessionId }),
      (items) => items[0]?.state === "completed",
      "resource mention completion"
    );
    const adapter = fixture.adapter(profile.id);
    expect(adapter.sendCalls[0]).toMatchObject({
      text: "Apply @Release",
      mentions: [{
        kind: "resource",
        reference: "prompt-release",
        discoveredRevision: revision,
        resourceVersion: resourceVersion.toString(10),
        runtimeGeneration: Number(generation)
      }],
      mentionRanges: [{ start: 6, end: 14, mentionIndex: 0 }]
    });
    expect(fixture.application.store.listQueueItems({ sessionId })[0]?.body).toMatchObject({
      mentions: [{
        kind: "resource",
        reference: "prompt-release",
        discoveredRevision: revision,
        resourceVersion: resourceVersion.toString(10),
        runtimeGeneration: Number(generation)
      }]
    });

    const control = (await paired.clients.queue.getQueueControl({ sessionId })).queueControl!;
    await submit(paired.clients.operation, paired.connectionId, pauseQueueMutation(control));
    const queued = await submit(
      paired.clients.operation,
      paired.connectionId,
      resourceInputMutation(sessionId, generation, revision, resourceVersion),
      randomUUID()
    );
    expect(queued.state).toBe(OperationState.SUCCEEDED);
    revision = "sha256:resource-two";
    resourceVersion = 6n;
    const paused = (await paired.clients.queue.getQueueControl({ sessionId })).queueControl!;
    await submit(paired.clients.operation, paired.connectionId, resumeQueueMutation(paused));
    const failedItems = await waitFor(
      async () => fixture!.application.store.listQueueItems({ sessionId }),
      (items) => items.some((item) => item.state === "failed"),
      "replaced resource queue failure"
    );
    expect(failedItems.find((item) => item.state === "failed")).toMatchObject({
      state: "failed",
      error: {
        code: "INPUT_RESOURCE_CATALOG_STALE",
        stateMayHaveChanged: false
      }
    });
    expect(adapter.sendCalls).toHaveLength(1);
  } finally {
    await fixture?.close({ removeRoot: true });
  }
});

it("keeps approved Claude resource content inside the live Query and rejects a queued stale catalog", async () => {
  const backendId = "claude-code";
  const revision = "sha256:claude-resource-one";
  const resourceVersion = 17n;
  const resourceContent = "Release only after fixture approval: query-local-resource-content-7f6c.";
  let authorityCurrent = true;
  const seed: ClaudeTextResourceSeed = {
    id: "prompt-release",
    kind: "prompt",
    name: "Release prompt",
    revision,
    resourceVersion,
    version: "1.0.0",
    content: resourceContent,
    assertCurrent: () => {
      if (!authorityCurrent) throw new Error("The fixture resource authority was retired.");
    }
  };
  const runtime = new ControlledClaudeRuntime();
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({
      profiles: [],
      backendFactories: [{
        instanceId: backendId,
        adapterKind: "claude-agent-sdk-stdio",
        displayName: "Controlled Claude fixture",
        create: ({ generation }) => new ClaudeCodeAdapter({
          instanceGeneration: generation,
          runtime,
          environment: {},
          initializationTimeoutMs: 5_000,
          admissionTimeoutMs: 5_000,
          teardownTimeoutMs: 100,
          resolveTextResources: (_context, signal) => {
            signal.throwIfAborted();
            return authorityCurrent ? [seed] : [];
          }
        })
      }]
    });
    const paired = await fixture.pair("Claude resource mention owner");
    const descriptor = (await paired.clients.backend.listBackends({})).backends
      .find((backend) => backend.backendId === backendId);
    const mentionCapability = descriptor?.capabilities?.capabilities
      .find((capability) => capability.name === "input.mention");
    expect(mentionCapability?.support).toBe(CapabilitySupport.SUPPORTED);
    expect(mentionCapability?.options?.kind.case).toBe("input");
    if (mentionCapability?.options?.kind.case !== "input") throw new Error("Claude did not publish input mention options.");
    expect(mentionCapability.options.kind.value.mediaTypes).toContain("resource");

    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId, targetId: fixture.targetId(backendId) })
    ));
    const catalog = await paired.clients.session.listSessionResources({ sessionId });
    expect(catalog.resources).toHaveLength(1);
    const resource = catalog.resources[0]!;
    expect({
      sessionId: resource.sessionId,
      resourceId: resource.resourceId,
      kind: resource.kind,
      discoveredRevision: resource.discoveredRevision,
      resourceVersion: resource.resourceVersion,
      runtimeGeneration: resource.runtimeGeneration
    }).toEqual({
      sessionId,
      resourceId: seed.id,
      kind: ResourceKind.PROMPT_TEMPLATE,
      discoveredRevision: revision,
      resourceVersion,
      runtimeGeneration: BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation)
    });

    const mutation = resourceInputMutation(sessionId, resource.runtimeGeneration, revision, resourceVersion);
    expect((await submit(paired.clients.operation, paired.connectionId, mutation)).state).toBe(OperationState.SUCCEEDED);
    await waitFor(
      async () => fixture!.application.store.listQueueItems({ sessionId }),
      (items) => items[0]?.state === "completed",
      "Claude resource mention completion"
    );
    expect(runtime.receivedInputs).toHaveLength(1);
    const nativeContent = runtime.receivedInputs[0]!.message.content;
    expect(typeof nativeContent).toBe("string");
    expect(nativeContent).toContain("Apply @Release");
    expect(nativeContent).toContain(resourceContent);
    expect(nativeContent).toContain("[Joko approved prompt resource]");

    const durableQueue = fixture.application.store.listQueueItems({ sessionId });
    const queueJson = durableJson(durableQueue);
    const durableEvents = fixture.application.store.listEvents({ sessionId, limit: 1_000 });
    const eventJson = durableJson(durableEvents);
    expect(durableJson([...runtime.messages.values()].flat())).toContain(resourceContent);
    expect(queueJson).toContain(seed.id);
    expect(queueJson).not.toContain(resourceContent);
    expect(eventJson).not.toContain(resourceContent);
    expect(durableEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: expect.stringMatching(/^native-event-/u),
        operationId: durableQueue[0]!.operationId,
        runId: durableQueue[0]!.runId,
        payload: expect.objectContaining({
          type: "message_complete",
          role: "user",
          blocks: [{ kind: "text", text: "Apply @Release" }],
          acceptedInput: expect.objectContaining({
            text: "Apply @Release",
            mentions: [expect.objectContaining({ kind: "resource", reference: seed.id })]
          })
        })
      })
    ]));

    const control = (await paired.clients.queue.getQueueControl({ sessionId })).queueControl!;
    await submit(paired.clients.operation, paired.connectionId, pauseQueueMutation(control));
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      mutation,
      randomUUID()
    )).state).toBe(OperationState.SUCCEEDED);
    authorityCurrent = false;
    const paused = (await paired.clients.queue.getQueueControl({ sessionId })).queueControl!;
    await submit(paired.clients.operation, paired.connectionId, resumeQueueMutation(paused));
    const failedItems = await waitFor(
      async () => fixture!.application.store.listQueueItems({ sessionId }),
      (items) => items.some((item) => item.state === "failed"),
      "retired Claude resource queue failure"
    );
    expect(failedItems.find((item) => item.state === "failed")).toMatchObject({
      state: "failed",
      error: {
        code: "INPUT_RESOURCE_CATALOG_STALE",
        stateMayHaveChanged: false
      }
    });
    expect(runtime.receivedInputs).toHaveLength(1);
  } finally {
    await fixture?.close({ removeRoot: true });
  }
});

function resourceInputMutation(
  sessionId: string,
  generation: bigint,
  discoveredRevision: string,
  resourceVersion: bigint
) {
  const mutation = sendInputMutation(sessionId, generation, "Apply @Release");
  if (mutation.payload.case !== "sendInput" || mutation.payload.value.input === undefined) {
    throw new Error("Missing resource input mutation.");
  }
  mutation.payload.value.input.parts.push(create(InputPartSchema, {
    content: {
      case: "resourceMention",
      value: {
        resourceId: "prompt-release",
        displayText: "Release",
        discoveredRevision,
        resourceVersion,
        runtimeGeneration: generation
      }
    }
  }));
  mutation.payload.value.input.mentionRanges.push(create(InputMentionRangeSchema, {
    start: 6,
    end: 14,
    mentionIndex: 0
  }));
  return mutation;
}

const claudeInitialization: ClaudeSdkInitializationResult = {
  models: [{
    value: "fixture-model",
    displayName: "Fixture model",
    description: "Controlled resource mention Query"
  }],
  account: { tokenSource: "fixture" }
};

class ControlledClaudeRuntime implements ClaudeSdkRuntime {
  readonly packageVersion = CLAUDE_AGENT_SDK_VERSION;
  readonly queries: ControlledClaudeQuery[] = [];
  readonly sessions = new Map<string, ClaudeSdkSessionInfo>();
  readonly messages = new Map<string, ClaudeSdkSessionMessage[]>();

  get receivedInputs(): readonly ClaudeSdkUserMessage[] {
    return this.queries.flatMap((query) => query.receivedInputs);
  }

  async probe(_input: Parameters<ClaudeSdkRuntime["probe"]>[0]) {
    return {
      installed: true,
      packageVersion: this.packageVersion,
      cliVersion: "2.1.259",
      apiKeySource: "none",
      initialization: claudeInitialization
    };
  }

  async query(params: ClaudeSdkQueryParams): Promise<ClaudeSdkQuery> {
    const nativeSessionId = params.options.resume ?? params.options.sessionId;
    if (nativeSessionId === undefined) throw new Error("The controlled Query requires a native Session ID.");
    const query = new ControlledClaudeQuery(params, nativeSessionId, (message) => {
      const history = this.messages.get(nativeSessionId) ?? [];
      history.push({
        ...message,
        session_id: nativeSessionId,
        parent_agent_id: null
      });
      this.messages.set(nativeSessionId, history);
    });
    this.queries.push(query);
    this.sessions.set(nativeSessionId, {
      sessionId: nativeSessionId,
      summary: "Controlled resource mention Session",
      lastModified: Date.now(),
      cwd: params.options.cwd
    });
    return query;
  }

  async retireQuery(query: ClaudeSdkQuery, _timeoutMs: number): Promise<void> {
    query.close();
  }

  async getSessionInfo(
    sessionId: string,
    _options: { readonly dir: string; readonly signal?: AbortSignal }
  ): Promise<ClaudeSdkSessionInfo | undefined> {
    return this.sessions.get(sessionId);
  }

  async getSessionMessages(
    sessionId: string,
    _options: ClaudeSdkGetSessionMessagesOptions
  ): Promise<readonly ClaudeSdkSessionMessage[]> {
    return this.messages.get(sessionId) ?? [];
  }

  async listSessions(options: ClaudeSdkListSessionsOptions): Promise<readonly ClaudeSdkSessionInfo[]> {
    return [...this.sessions.values()].slice(options.offset, options.offset + options.limit);
  }

  async deleteSession(
    sessionId: string,
    _options: { readonly dir: string; readonly signal?: AbortSignal }
  ): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async forkSession(
    _sessionId: string,
    _options: ClaudeSdkForkOptions
  ): Promise<{ readonly sessionId: string }> {
    throw new Error("The controlled Query does not fork native Sessions.");
  }

  ownsSessionFork(_sessionId: string): boolean {
    return false;
  }

  async closeSessionOperations(): Promise<void> {}
}

class ControlledClaudeQuery implements ClaudeSdkQuery {
  readonly receivedInputs: ClaudeSdkUserMessage[] = [];
  readonly #params: ClaudeSdkQueryParams;
  readonly #nativeSessionId: string;
  readonly #persistInput: (message: ClaudeSdkUserMessage) => void;
  readonly #output = new ControlledAsyncOutput();
  #closed = false;

  constructor(
    params: ClaudeSdkQueryParams,
    nativeSessionId: string,
    persistInput: (message: ClaudeSdkUserMessage) => void
  ) {
    this.#params = params;
    this.#nativeSessionId = nativeSessionId;
    this.#persistInput = persistInput;
    void this.#consume();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.#output[Symbol.asyncIterator]();
  }

  async #consume(): Promise<void> {
    for await (const message of this.#params.prompt) {
      if (this.#closed) return;
      this.receivedInputs.push(message);
      this.#persistInput(message);
      this.#output.push(claudeSystemInit(this.#nativeSessionId, this.#params));
      this.#output.push(claudeResult(this.#nativeSessionId, message.uuid));
    }
  }

  async initializationResult(): Promise<ClaudeSdkInitializationResult> {
    return claudeInitialization;
  }

  async supportedModels() {
    return claudeInitialization.models;
  }

  async accountInfo() {
    return claudeInitialization.account;
  }

  async interrupt() {
    return { still_queued: [] };
  }

  async stopTask(_taskId: string): Promise<void> {}

  async setPermissionMode(_mode: Parameters<ClaudeSdkQuery["setPermissionMode"]>[0]): Promise<void> {}

  async setModel(_model?: string): Promise<void> {}

  async applyFlagSettings(_settings: Parameters<ClaudeSdkQuery["applyFlagSettings"]>[0]): Promise<void> {}

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.#params.prompt[Symbol.asyncIterator]().return?.();
    this.#output.close();
  }
}

class ControlledAsyncOutput implements AsyncIterable<unknown>, AsyncIterator<unknown> {
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
    return new Promise((resolvePromise) => this.#readers.push(resolvePromise));
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }
}

function claudeSystemInit(nativeSessionId: string, params: ClaudeSdkQueryParams) {
  return {
    type: "system",
    subtype: "init",
    session_id: nativeSessionId,
    uuid: randomUUID(),
    claude_code_version: "2.1.259",
    apiKeySource: "none",
    cwd: params.options.cwd,
    model: params.options.model ?? "fixture-model",
    permissionMode: params.options.permissionMode,
    tools: ["Read"],
    mcp_servers: [],
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    capabilities: []
  };
}

function claudeResult(nativeSessionId: string, userMessageUuid: string) {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: "Controlled Claude resource response.",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    },
    modelUsage: {
      "fixture-model": {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 200_000,
        maxOutputTokens: 32_000
      }
    },
    permission_denials: [],
    terminal_reason: "completed",
    origin: { kind: "human" },
    user_message_uuid: userMessageUuid,
    uuid: randomUUID(),
    session_id: nativeSessionId
  };
}

function durableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => typeof entry === "bigint" ? entry.toString(10) : entry);
}
