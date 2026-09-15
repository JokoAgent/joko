import { mkdtemp, readFile, readdir, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AdapterContext, EventPayload, ManagedProviderRuntimePort, ManagedProviderRouteBinding, ProviderModel, TargetDescriptor } from "@joko/core";
import { createChildRuntimeEnvironment } from "@joko/runtime-governance";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { ClaudeCodeAdapter, managedModelLimitEnvironment } from "./adapter.js";

const enabled = process.env["JOKO_CLAUDE_LOCAL_GATEWAY_PROBE"] === "1";

test.skipIf(!enabled)("uses fixed-SDK per-model effort and context leases through a local gateway while preserving credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-claude-local-gateway-"));
  const workspaceRoot = join(directory, "workspace");
  const configDirectory = join(directory, "profile");
  await mkdir(workspaceRoot);
  await mkdir(configDirectory);
  const projectSettingsDirectory = join(workspaceRoot, ".claude");
  await mkdir(projectSettingsDirectory);
  const hostileToken = "settings-must-not-own-provider-route";
  await writeFile(join(configDirectory, "settings.json"), JSON.stringify({
    apiKeyHelper: "joko-api-key-helper-must-not-run",
    effortLevel: "low",
    modelOverrides: { "joko-local-model": "settings-must-not-remap-managed-model" },
    modelSettings: {
      "joko-local-model": { effortLevel: "low" },
      "unrelated-local-model": { effortLevel: "medium" }
    },
    env: {
      ANTHROPIC_API_KEY: hostileToken,
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9/hostile",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "999999",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "999999",
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "1",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "123",
      JOKO_NATIVE_SETTINGS_ORDER: "user"
    }
  }));
  await writeFile(join(projectSettingsDirectory, "settings.json"), JSON.stringify({
    env: { JOKO_NATIVE_SETTINGS_ORDER: "project" }
  }));
  await writeFile(join(projectSettingsDirectory, "settings.local.json"), JSON.stringify({
    env: { JOKO_NATIVE_SETTINGS_ORDER: "local" }
  }));
  const token = "local-gateway-fixture-credential";
  const model: ProviderModel = { providerId: "local-gateway", modelId: "joko-local-model", displayName: "Local model",
    api: "anthropic-messages", contextWindow: 64_000, maxOutputTokens: 4_000, supportsImages: false, thinkingLevels: ["high"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const childModel: ProviderModel = {
    ...model,
    modelId: "joko-local-child-model",
    displayName: "Local child model",
    contextWindow: 128_000,
    maxOutputTokens: 8_000
  };
  const requests: { path: string; model: unknown; authenticated: boolean; messages: unknown; outputConfig: unknown;
    maxTokens: unknown; hasBashTool: boolean; parentLease: boolean; childLease: boolean }[] = [];
  const failures: string[] = [];
  const deniedPaths: string[] = [];
  let currentOperation: Parameters<ManagedProviderRouteBinding["activate"]>[0] | undefined;
  let currentSubtask: Parameters<NonNullable<ManagedProviderRouteBinding["authorizeSubtask"]>>[0] | undefined;
  let disposed = false;
  let released = false;
  let subtaskReleased = false;
  const server = createServer((request, response) => {
    void (async () => {
      if (!["/v1/messages", "/v1/messages/count_tokens"].includes(request.url?.split("?")[0] ?? "")) {
        deniedPaths.push(request.url ?? "");
        response.writeHead(404);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 2_000_000) throw new Error("Local fixture body exceeded its bound.");
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: unknown; messages?: unknown;
        output_config?: unknown; max_tokens?: unknown; tools?: { name?: string }[] };
      const authenticated = request.headers["x-api-key"] === token;
      requests.push({ path: request.url ?? "", model: body.model, authenticated, messages: body.messages, outputConfig: body.output_config,
        maxTokens: body.max_tokens, hasBashTool: body.tools?.some((tool) => tool.name === "Bash") === true,
        parentLease: currentOperation !== undefined && !released,
        childLease: currentSubtask !== undefined && !subtaskReleased });
      if (!authenticated || (body.model !== model.modelId && body.model !== childModel.modelId)) {
        throw new Error("Unexpected local route identity.");
      }
      if (body.model === model.modelId) {
        if (currentOperation === undefined || disposed || released) throw new Error(`No active parent request lease for ${request.url}.`);
        currentOperation.assertCurrent();
      } else {
        if (currentSubtask === undefined || disposed || subtaskReleased) throw new Error(`No active child request lease for ${request.url}.`);
        currentSubtask.assertCurrent();
      }
      if (request.url?.split("?")[0] === "/v1/messages/count_tokens") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (request.url?.split("?")[0] !== "/v1/messages") throw new Error("Unexpected local request path.");
      if (body.model === childModel.modelId) {
        sendTextMessage(response, childModel.modelId, "Child effort applied.");
      } else {
        sendParentMessage(response, model.modelId, toolResultCount(body.messages));
      }
    })().catch((error: unknown) => {
      failures.push(error instanceof Error ? error.message : "Local fixture rejected a request.");
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Local fixture rejected the request." } }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The local gateway did not bind.");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const port: ManagedProviderRuntimePort = {
    support: { protocols: ["anthropic-messages"], fields: ["headers", "model_limits"] },
    environment: { JOKO_MODEL_PROXY_TOKEN: token }, secretEnvironmentNames: ["JOKO_MODEL_PROXY_TOKEN"],
    dispose: () => { disposed = true; },
    hasProvider: (providerId) => providerId === model.providerId,
    listModels: () => [model, childModel], listProviders: () => [],
    getThinkingLevelMap: (_providerId, modelId) => ({ high: modelId === childModel.modelId ? "medium" : "xhigh" }),
    prepare: async (owner) => {
      expect(owner).toMatchObject({ providerId: model.providerId, modelId: model.modelId });
      const assertCurrent = () => { if (disposed) throw new Error("The local route has retired."); };
      return { providerId: model.providerId, model, thinkingLevelMap: { high: "xhigh" }, protocol: "anthropic-messages", revision: "local-one", baseUrl,
        apiKeyEnvironment: "JOKO_MODEL_PROXY_TOKEN", assertCurrent,
        activate: async (operation) => { assertCurrent(); operation.assertCurrent(); currentOperation = operation; return { release: () => { released = true; } }; },
        authorizeSubtask: async (operation) => {
          assertCurrent();
          operation.assertCurrent();
          if (operation.modelId !== childModel.modelId) throw new Error("Unexpected child route identity.");
          currentSubtask = operation;
          return {
            model: childModel,
            thinkingLevelMap: { high: "medium" },
            release: () => { subtaskReleased = true; }
          };
        },
        dispose: () => { disposed = true; }
      };
    }
  };
  const adapter = new ClaudeCodeAdapter({ instanceGeneration: 1, managedProviders: port,
    initializationTimeoutMs: 30_000, admissionTimeoutMs: 10_000, teardownTimeoutMs: 3_000,
    environment: { CLAUDE_CONFIG_DIR: configDirectory, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: token },
    probeCwd: workspaceRoot, resolveSubagentModel: () => childModel.modelId });
  const target: TargetDescriptor = { id: "local-gateway-target", backendId: adapter.id, displayName: "Local gateway fixture",
    workspaceRoot, managed: false, trusted: true };
  const events: EventPayload[] = [];
  const cancellation = new AbortController();
  const context: AdapterContext = { sessionId: "local-gateway-session", generation: 1, backendInstanceGeneration: 1,
    target, signal: cancellation.signal, modelSelection: { providerId: model.providerId, modelId: model.modelId },
    emit: async (event) => { events.push(event); }, requestInteraction: async () => ({ kind: "selected", value: "allow_for_session" }),
    artifactCapacityBytes: 1024, storeArtifact: async () => { throw new Error("No artifact is expected."); } };
  try {
    const binding = await adapter.createSession({ target, providerId: model.providerId, modelId: model.modelId,
      effort: "high", fastMode: false, permissionMode: "ask", nativeStart: { kind: "new" } }, context);
    expect(requests).toEqual([]);
    await adapter.send({ text: "Run the supplied local environment check, then finish.", images: [], files: [], mentions: [], disposition: "prompt" },
      { ...context, binding, operationId: "local-gateway-turn" });
    await vi.waitFor(() => expect(events.some((event) => event.type === "done")).toBe(true), { timeout: 30_000, interval: 25 });
    expect(events.at(-1), JSON.stringify(events.filter((event) => event.type === "error"))).toEqual({ type: "done", outcome: "completed" });
    expect(failures, JSON.stringify({
      requests: requests.map((request) => ({
        path: request.path,
        model: request.model,
        toolResults: toolResultCount(request.messages),
        outputConfig: request.outputConfig,
        parentLease: request.parentLease,
        childLease: request.childLease
      })),
      events: events.map((event) => event.type)
    })).toEqual([]);
    expect(requests.filter((request) => request.path.split("?")[0] === "/v1/messages").length).toBeGreaterThanOrEqual(2);
    const messages = requests.flatMap((request) => request.messages as { content: { type: string; content?: unknown; is_error?: boolean }[] | string }[]);
    const toolResults = messages.flatMap((message) => typeof message.content === "string" ? [] : message.content)
      .filter((block) => block.type === "tool_result");
    expect(toolResults.some((block) => block.is_error !== true && JSON.stringify(block.content).includes("joko-tool-environment-scrubbed")), JSON.stringify(toolResults)).toBe(true);
    expect(deniedPaths.every((path) => path === "/api/hello")).toBe(true);
    expect(requests.every((request) => request.authenticated
      && (request.model === model.modelId || request.model === childModel.modelId))).toBe(true);
    expect(requests.filter((request) => request.model === model.modelId).every((request) => request.parentLease)).toBe(true);
    const turnRequests = requests.filter((request) => request.path.split("?")[0] === "/v1/messages"
      && request.model === model.modelId && request.hasBashTool
      && JSON.stringify(request.messages).includes("Run the supplied local environment check, then finish."));
    expect(turnRequests.length).toBeGreaterThanOrEqual(2);
    expect(turnRequests.every((request) => (request.outputConfig as { effort?: unknown } | undefined)?.effort === "xhigh"),
      JSON.stringify(turnRequests.map((request) => ({ path: request.path, outputConfig: request.outputConfig })))).toBe(true);
    // Independent Queries keep the parent and child output envelopes exact;
    // the production private proxy also clamps each route before dispatch.
    expect(turnRequests.every((request) => request.maxTokens === model.maxOutputTokens),
      JSON.stringify(turnRequests.map((request) => ({ path: request.path, maxTokens: request.maxTokens })))).toBe(true);
    const childRequests = requests.filter((request) => request.path.split("?")[0] === "/v1/messages"
      && request.model === childModel.modelId);
    expect(childRequests.length, JSON.stringify(requests.map((request) => ({
      path: request.path,
      model: request.model,
      toolResults: toolResultCount(request.messages)
    })))).toBeGreaterThanOrEqual(1);
    expect(childRequests.every((request) => request.childLease)).toBe(true);
    expect(childRequests.every((request) => (request.outputConfig as { effort?: unknown } | undefined)?.effort === "medium"),
      JSON.stringify(childRequests.map((request) => ({ path: request.path, outputConfig: request.outputConfig })))).toBe(true);
    expect(childRequests.every((request) => request.maxTokens === childModel.maxOutputTokens)).toBe(true);
    const childRequestIndex = requests.findIndex((request) => request.path.split("?")[0] === "/v1/messages"
      && request.model === childModel.modelId);
    expect(childRequestIndex).toBeGreaterThan(0);
    expect(requests.slice(childRequestIndex + 1).some((request) => request.path.split("?")[0] === "/v1/messages"
      && request.model === model.modelId)).toBe(true);
    expect(events.filter((event): event is Extract<EventPayload, { type: "usage" }> => event.type === "usage").at(-1)?.usage.contextWindow)
      .toBe(model.contextWindow);
    expect(released).toBe(true);
    expect(currentSubtask).toMatchObject({ modelId: childModel.modelId });
    expect(subtaskReleased).toBe(true);
    expect(() => currentOperation!.assertCurrent()).toThrow();
    expect(() => currentSubtask!.assertCurrent()).toThrow();
    expect(JSON.stringify(events)).not.toContain(token);
    await adapter.closeSession(binding, { ...context, binding });
    for (const contents of await persistedFiles(directory)) expect(contents.includes(token)).toBe(false);
  } finally {
    cancellation.abort();
    await adapter.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 75_000);

test.skipIf(!enabled)("pins each managed context window when the fixed SDK Query is constructed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-claude-context-policy-"));
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ input_tokens: 100 }));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The context fixture did not bind.");
  try {
    for (const contextWindow of [64_000, 128_000]) {
      const model: ProviderModel = {
        providerId: "local-gateway", modelId: "joko-context-model", displayName: "Context model",
        api: "anthropic-messages", contextWindow, maxOutputTokens: 4_000, supportsImages: false, thinkingLevels: [],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      };
      const limits = managedModelLimitEnvironment(model);
      let releasePrompt!: () => void;
      const pendingPrompt = new Promise<void>((resolvePromise) => { releasePrompt = resolvePromise; });
      async function* prompt(): AsyncGenerator<SDKUserMessage> { await pendingPrompt; }
      const environment = createChildRuntimeEnvironment({
        overrides: {
          HOME: directory,
          USERPROFILE: directory,
          CLAUDE_CONFIG_DIR: directory,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
          ANTHROPIC_API_KEY: "fake-context-test-key",
          CLAUDE_CODE_OAUTH_TOKEN: undefined,
          ...limits
        }
      }).environment;
      const nativeQuery = query({
        prompt: prompt(),
        options: {
          cwd: directory,
          model: model.modelId,
          tools: [],
          mcpServers: {},
          settingSources: [],
          systemPrompt: "Context control test.",
          env: environment,
          settings: { env: { ...limits } }
        }
      });
      try {
        const usage = await nativeQuery.getContextUsage({ detail: "summary" });
        // Provider-routed model ids have no built-in capacity, so the fixed
        // CLI reports the host-declared working window directly.
        expect(usage.rawMaxTokens).toBe(contextWindow);
        expect(usage.maxTokens).toBe(contextWindow);
        expect(usage.isAutoCompactEnabled).toBe(true);
      } finally {
        nativeQuery.close();
        releasePrompt();
      }
    }

    const parent: ProviderModel = {
      providerId: "local-gateway", modelId: "joko-context-switch-model", displayName: "Context switch model",
      api: "anthropic-messages", contextWindow: 64_000, maxOutputTokens: 4_000, supportsImages: false, thinkingLevels: [],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    };
    const envelope = {
      ...managedModelLimitEnvironment(parent),
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "128000",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000"
    };
    let releaseSwitchPrompt!: () => void;
    const pendingSwitchPrompt = new Promise<void>((resolvePromise) => { releaseSwitchPrompt = resolvePromise; });
    async function* switchPrompt(): AsyncGenerator<SDKUserMessage> { await pendingSwitchPrompt; }
    const switchEnvironment = createChildRuntimeEnvironment({
      overrides: {
        HOME: directory,
        USERPROFILE: directory,
        CLAUDE_CONFIG_DIR: directory,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        ANTHROPIC_API_KEY: "fake-context-switch-key",
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        ...envelope
      }
    }).environment;
    const switchingQuery = query({
      prompt: switchPrompt(),
      options: {
        cwd: directory,
        model: parent.modelId,
        tools: [],
        mcpServers: {},
        settingSources: [],
        systemPrompt: "Context switching control test.",
        env: switchEnvironment,
        settings: { env: { ...envelope } }
      }
    });
    try {
      // The fixed CLI exposes its 100K native floor; the 57.6% process
      // override preserves the parent's effective 64K working budget. A
      // post-start flag update is queued for a future engine turn, so it is
      // not a valid way to reconfigure an already-running delegated Query.
      expect((await switchingQuery.getContextUsage({ detail: "summary" })).maxTokens).toBe(100_000);
      await switchingQuery.applyFlagSettings({ autoCompactWindow: 128_000 });
      expect((await switchingQuery.getContextUsage({ detail: "summary" })).maxTokens).toBe(100_000);
      await switchingQuery.applyFlagSettings({ autoCompactWindow: 64_000 });
      expect((await switchingQuery.getContextUsage({ detail: "summary" })).maxTokens).toBe(100_000);
    } finally {
      switchingQuery.close();
      releaseSwitchPrompt();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 75_000);

test.skipIf(!enabled)("keeps an explicit child Query model authoritative over its main-thread agent definition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-claude-agent-model-"));
  const requestedModels: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: unknown };
      if (request.url?.split("?")[0] === "/v1/messages/count_tokens") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (typeof body.model === "string") requestedModels.push(body.model);
      sendTextMessage(response, typeof body.model === "string" ? body.model : "missing-model", "Child finished.");
    })().catch(() => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "fixture failed" } }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The agent-model fixture did not bind.");
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: "Return a short completion." },
      parent_tool_use_id: null,
      origin: { kind: "peer", from: "managed-parent", body: "Return a short completion." },
      uuid: "f04b1b5d-20f7-49b7-bd6d-183d37c1621f"
    };
  }
  const environment = createChildRuntimeEnvironment({
    overrides: {
      HOME: directory,
      USERPROFILE: directory,
      CLAUDE_CONFIG_DIR: directory,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      ANTHROPIC_API_KEY: "fake-agent-model-key",
      CLAUDE_CODE_OAUTH_TOKEN: undefined
    }
  }).environment;
  const nativeQuery = query({
    prompt: prompt(),
    options: {
      cwd: directory,
      model: "exact-child-model",
      agent: "joko-test-agent",
      agents: {
        "joko-test-agent": {
          description: "Exercise main-thread agent precedence.",
          prompt: "Return the requested completion.",
          model: "definition-model",
          tools: []
        }
      },
      tools: [],
      settingSources: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      env: environment
    }
  });
  const output: unknown[] = [];
  try {
    for await (const message of nativeQuery) {
      output.push(message);
      if ((message as { type?: unknown }).type === "result") break;
    }
    expect(requestedModels.length, JSON.stringify(output)).toBeGreaterThanOrEqual(1);
    expect(requestedModels.every((model) => model === "exact-child-model"), JSON.stringify(requestedModels)).toBe(true);
  } finally {
    nativeQuery.close();
    server.closeAllConnections();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 75_000);

test.skipIf(!enabled)("redirects the fixed SDK Agent tool through an in-process SDK MCP result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-claude-agent-alias-"));
  const requests: unknown[] = [];
  const handlerCalls: { args: unknown; extra: unknown }[] = [];
  const hookCalls: { input: unknown; toolUseId: unknown }[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: unknown; model?: string };
      requests.push(body);
      if (request.url?.split("?")[0] === "/v1/messages/count_tokens") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      const completedTools = toolResultCount(body.messages);
      if (completedTools === 0) sendParentMessage(response, body.model ?? "joko-alias-model", 1);
      else sendTextMessage(response, body.model ?? "joko-alias-model", "Alias result accepted.");
    })().catch(() => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "fixture failed" } }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The alias fixture did not bind.");
  let releasePrompt!: () => void;
  const pendingPrompt = new Promise<void>((resolvePromise) => { releasePrompt = resolvePromise; });
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: "Delegate this check." },
      parent_tool_use_id: null,
      origin: { kind: "human" },
      uuid: "8ac25d8e-35f5-4a76-bf42-ae3bb4145ea0"
    };
    await pendingPrompt;
  }
  const sdkServer = createSdkMcpServer({
    name: "joko_managed_subagent",
    version: "1.0.0",
    tools: [{
      name: "delegate",
      description: "Run an exactly configured managed subtask.",
      inputSchema: {
        description: z.string(),
        prompt: z.string(),
        subagent_type: z.string().optional(),
        model: z.string().optional(),
        run_in_background: z.boolean().optional()
      },
      handler: async (args, extra) => {
        handlerCalls.push({ args, extra });
        return { content: [{ type: "text", text: "Managed child completed." }] };
      }
    }]
  });
  const environment = createChildRuntimeEnvironment({
    overrides: {
      HOME: directory,
      USERPROFILE: directory,
      CLAUDE_CONFIG_DIR: directory,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      ANTHROPIC_API_KEY: "fake-agent-alias-key",
      CLAUDE_CODE_OAUTH_TOKEN: undefined
    }
  }).environment;
  const nativeQuery = query({
    prompt: prompt(),
    options: {
      cwd: directory,
      model: "joko-alias-model",
      tools: { type: "preset", preset: "claude_code" },
      toolAliases: { Agent: "mcp__joko_managed_subagent__delegate" },
      mcpServers: { joko_managed_subagent: sdkServer },
      hooks: {
        PreToolUse: [{
          hooks: [async (input, toolUseId) => {
            hookCalls.push({ input, toolUseId });
            return { continue: true };
          }]
        }]
      },
      settingSources: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      systemPrompt: "Use Agent exactly once, then report its result.",
      env: environment
    }
  });
  const output: unknown[] = [];
  try {
    for await (const message of nativeQuery) {
      output.push(message);
      if ((message as { type?: unknown }).type === "result") break;
    }
    expect(handlerCalls.length, JSON.stringify(output)).toBe(1);
    expect(handlerCalls[0]!.args).toMatchObject({
      description: "Check child effort",
      prompt: "Return a short completion.",
      subagent_type: "general-purpose"
    });
    expect((handlerCalls[0]!.extra as { _meta?: Readonly<Record<string, unknown>> })._meta?.["claudecode/toolUseId"])
      .toBe("toolu_local_agent");
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]).toMatchObject({
      input: { hook_event_name: "PreToolUse", tool_name: "mcp__joko_managed_subagent__delegate" },
      toolUseId: "toolu_local_agent"
    });
    expect(JSON.stringify(requests)).toContain("Managed child completed.");
    expect(JSON.stringify(output)).toContain("Alias result accepted.");
  } finally {
    nativeQuery.close();
    releasePrompt();
    server.closeAllConnections();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 75_000);

test.skipIf(!enabled)("accepts a host-owned task notification after a background Agent alias result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-claude-agent-task-"));
  const requests: unknown[] = [];
  const output: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: unknown; model?: string };
      requests.push(body);
      if (request.url?.split("?")[0] === "/v1/messages/count_tokens") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (toolResultCount(body.messages) === 0) {
        sendAliasedAgentMessage(response, body.model ?? "joko-task-model", true);
      } else {
        sendTextMessage(response, body.model ?? "joko-task-model", JSON.stringify(body.messages).includes("task-notification")
          ? "Background continuation accepted."
          : "Background launch accepted.");
      }
    })().catch(() => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "fixture failed" } }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The task fixture did not bind.");
  let releasePrompt!: () => void;
  const pendingPrompt = new Promise<void>((resolvePromise) => { releasePrompt = resolvePromise; });
  let deliverNotification!: () => void;
  const notificationReady = new Promise<void>((resolvePromise) => { deliverNotification = resolvePromise; });
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: "Launch the delegated check in the background." },
      parent_tool_use_id: null,
      origin: { kind: "human" },
      uuid: "ad3d6973-193c-4f91-af55-542c85cc8d37"
    };
    await notificationReady;
    yield {
      type: "user",
      message: {
        role: "user",
        content: "<task-notification>\n<task-id>managed-child-1</task-id>\n<status>completed</status>\n<summary>Managed background child completed.</summary>\n</task-notification>"
      },
      parent_tool_use_id: null,
      origin: { kind: "task-notification" },
      uuid: "3578ea56-d553-47cc-bb78-ae2b2ca3834c"
    };
    await pendingPrompt;
  }
  const sdkServer = createSdkMcpServer({
    name: "joko_managed_task",
    version: "1.0.0",
    tools: [{
      name: "delegate",
      description: "Run an exactly configured managed subtask.",
      inputSchema: {
        description: z.string(),
        prompt: z.string(),
        subagent_type: z.string().optional(),
        model: z.string().optional(),
        run_in_background: z.boolean().optional()
      },
      handler: async (args, extra) => {
        expect(args.run_in_background).toBe(true);
        expect((extra as { _meta?: Readonly<Record<string, unknown>> })._meta?.["claudecode/toolUseId"])
          .toBe("toolu_alias_background");
        return { content: [{ type: "text", text: "Managed child launched in the background as managed-child-1." }] };
      }
    }]
  });
  const environment = createChildRuntimeEnvironment({
    overrides: {
      HOME: directory,
      USERPROFILE: directory,
      CLAUDE_CONFIG_DIR: directory,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      ANTHROPIC_API_KEY: "fake-agent-task-key",
      CLAUDE_CODE_OAUTH_TOKEN: undefined
    }
  }).environment;
  const nativeQuery = query({
    prompt: prompt(),
    options: {
      cwd: directory,
      model: "joko-task-model",
      tools: { type: "preset", preset: "claude_code" },
      toolAliases: { Agent: "mcp__joko_managed_task__delegate" },
      mcpServers: { joko_managed_task: sdkServer },
      settingSources: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      systemPrompt: "Use Agent once in the background, then continue after its notification.",
      env: environment
    }
  });
  const iterator = nativeQuery[Symbol.asyncIterator]();
  try {
    let firstResult = false;
    while (!firstResult) {
      const next = await iterator.next();
      if (next.done) break;
      output.push(next.value);
      if ((next.value as { type?: unknown }).type === "result") firstResult = true;
    }
    expect(firstResult, JSON.stringify(output)).toBe(true);
    deliverNotification();
    const continuationDeadline = Date.now() + 10_000;
    let continuationResult = false;
    while (!continuationResult && Date.now() < continuationDeadline) {
      const remaining = Math.max(1, continuationDeadline - Date.now());
      const pending = iterator.next();
      const next = await Promise.race([
        pending,
        new Promise<undefined>((resolvePromise) => setTimeout(resolvePromise, remaining, undefined))
      ]);
      if (next === undefined) {
        await pending.catch(() => undefined);
        break;
      }
      if (next.done) break;
      output.push(next.value);
      if ((next.value as { type?: unknown }).type === "result") continuationResult = true;
    }
    expect(continuationResult, JSON.stringify(output)).toBe(true);
    expect(output.filter((message): message is { type: "result"; user_message_uuid?: string } =>
      (message as { type?: unknown }).type === "result").at(-1)?.user_message_uuid, JSON.stringify(output))
      .toBe("3578ea56-d553-47cc-bb78-ae2b2ca3834c");
    expect(JSON.stringify(requests)).toContain("Managed background child completed.");
  } finally {
    nativeQuery.close();
    releasePrompt();
    server.closeAllConnections();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 75_000);

function toolResultCount(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const message of messages) {
    if (typeof message !== "object" || message === null || !Array.isArray((message as { content?: unknown }).content)) continue;
    count += (message as { content: { type?: unknown }[] }).content.filter((block) => block.type === "tool_result").length;
  }
  return count;
}

function sendParentMessage(response: ServerResponse, model: string, completedTools: number): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (type: string, value: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  const done = completedTools >= 2;
  const agent = completedTools === 1;
  send("message_start", { message: { id: done ? "msg_local_done" : agent ? "msg_local_agent" : "msg_local_tool", type: "message", role: "assistant",
    model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  send("content_block_start", { index: 0, content_block: done
    ? { type: "text", text: "" }
    : { type: "tool_use", id: agent ? "toolu_local_agent" : "toolu_local_environment", name: agent ? "Agent" : "Bash", input: {} } });
  send("content_block_delta", { index: 0, delta: done
    ? { type: "text_delta", text: "Local checks complete." }
    : { type: "input_json_delta", partial_json: JSON.stringify(agent
        ? { description: "Check child effort", prompt: "Return a short completion.", subagent_type: "general-purpose" }
        : { command: 'test "$JOKO_NATIVE_SETTINGS_ORDER" = "local" && test -z "${ANTHROPIC_API_KEY-}" && test -z "${ANTHROPIC_AUTH_TOKEN-}" && test -z "${JOKO_MODEL_PROXY_TOKEN-}" && printf joko-tool-environment-scrubbed', description: "Check the local tool environment without printing credentials" }) } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: done ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } });
  send("message_stop", {});
  response.end();
}

function sendTextMessage(response: ServerResponse, model: string, text: string): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (type: string, value: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  send("message_start", { message: { id: "msg_local_child", type: "message", role: "assistant",
    model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  send("message_stop", {});
  response.end();
}

function sendAliasedAgentMessage(response: ServerResponse, model: string, runInBackground: boolean): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (type: string, value: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  send("message_start", { message: { id: "msg_alias_background", type: "message", role: "assistant",
    model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  send("content_block_start", { index: 0, content_block: {
    type: "tool_use", id: "toolu_alias_background", name: "Agent", input: {}
  } });
  send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({
    description: "Check managed background limits",
    prompt: "Return the background completion.",
    subagent_type: "general-purpose",
    run_in_background: runInBackground
  }) } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } });
  send("message_stop", {});
  response.end();
}

async function persistedFiles(directory: string): Promise<Buffer[]> {
  const contents: Buffer[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) contents.push(...await persistedFiles(path));
    else if (entry.isFile()) contents.push(await readFile(path));
  }
  return contents;
}
