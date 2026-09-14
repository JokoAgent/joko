import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  JokoError,
  type AdapterContext,
  type CreateNativeSessionInput,
  type EventPayload,
  type InteractionDecision,
  type InteractionPayload,
  type NativeSessionBinding,
  type ManagedProviderRuntimePort,
  type ManagedProviderRouteBinding,
  type ProviderModel,
  type TargetDescriptor
} from "@joko/core";
import { describe, expect, test, vi } from "vitest";
import { ClaudeCodeAdapter, type ClaudeCodeAdapterOptions } from "./adapter.js";
import { SessionSdkFailure } from "./session-sdk-owner.js";
import {
  CLAUDE_AGENT_SDK_VERSION,
  type ClaudeRemoteRuntimePort,
  type ClaudeCanUseToolOptions,
  type ClaudeSdkGetSessionMessagesOptions,
  type ClaudeSdkForkOptions,
  type ClaudeSdkListSessionsOptions,
  type ClaudePermissionResult,
  type ClaudeSdkInitializationResult,
  type ClaudeSdkProbeInput,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryParams,
  type ClaudeSdkRuntime,
  type ClaudeSdkSessionInfo,
  type ClaudeSdkSessionMessage,
  type ClaudeSdkUserMessage
} from "./sdk-runtime.js";

const INSTANCE_GENERATION = 41;
const target: TargetDescriptor = {
  id: "target-local",
  backendId: "claude-code",
  displayName: "Workspace",
  workspaceRoot: process.cwd(),
  managed: false,
  trusted: true
};

describe("ClaudeCodeAdapter", () => {
  test("applies an exact configured effort mapping while retaining the product effort and excluding disabled levels", async () => {
    const managed = managedProviderFixture({ high: "xhigh", low: null });
    const runtime = new FakeSdkRuntime({ initialFrameOverrides: { model: "configured-model", effort: "xhigh" } });
    const adapter = adapterFor(runtime, { managedProviders: managed.port });
    expect((await adapter.describe()).models.find((model) => model.providerId === "configured-provider")!.thinkingLevels).toEqual(["high"]);
    const binding = await adapter.createSession(createInput({ providerId: "configured-provider", modelId: "configured-model", effort: "high" }), contextFor().context);
    expect(runtime.queries[0]!.params.options.effort).toBe("xhigh");
    const source = contextFor(binding, { operationId: "mapped-effort" });
    const context = { ...source.context, modelSelection: { providerId: "configured-provider", modelId: "configured-model" } };
    await expect(adapter.setEffort("low", context)).rejects.toThrow();
    expect(runtime.queries[0]!.settingCalls).toEqual([]);
    await adapter.setEffort("high", context);
    expect(runtime.queries[0]!.settingCalls).toEqual([{ effortLevel: "xhigh" }]);
    await adapter.send(textPrompt("mapped effort"), context);
    expect((await adapter.inspectSession(binding, context)).effort).toBe("high");
    await adapter.dispose();
  });

  test("rejects an unsupported mapping before Query startup or an existing route replacement and does not advertise it as executable", async () => {
    const mapping: Record<string, string | null> = { high: "default" };
    const managed = managedProviderFixture(mapping);
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime, { managedProviders: managed.port });
    expect((await adapter.describe()).models.some((model) => model.providerId === "configured-provider")).toBe(false);
    await expect(adapter.createSession(createInput({ providerId: "configured-provider", modelId: "configured-model" }), contextFor().context))
      .rejects.toMatchObject({ publicError: { code: "MANAGED_PROVIDER_EFFORT_MAPPING_INVALID", stateMayHaveChanged: false } });
    expect(runtime.queries).toEqual([]);
    mapping.high = "high";
    const binding = await adapter.createSession(createInput({ providerId: "configured-provider", modelId: "configured-model" }), contextFor().context);
    mapping.high = "default"; managed.revision = "revision-two";
    await expect(adapter.send(textPrompt("not dispatched"), { ...contextFor(binding, { operationId: "invalid-mapping" }).context,
      modelSelection: { providerId: "configured-provider", modelId: "configured-model" } }))
      .rejects.toMatchObject({ publicError: { code: "MANAGED_PROVIDER_EFFORT_MAPPING_INVALID", stateMayHaveChanged: false } });
    expect(runtime.queries[0]!.closeCalls).toBe(0);
    expect(runtime.queries[0]!.receivedInputs).toEqual([]);
    expect(managed.activations).toEqual([]);
    await adapter.dispose();
  });

  test("owns a configured model request lease through its terminal frame and keeps the proxy credential out of settings and public projections", async () => {
    const managed = managedProviderFixture();
    const runtime = new FakeSdkRuntime({ initialFrameOverrides: { model: "configured-model" } });
    const adapter = adapterFor(runtime, { managedProviders: managed.port });
    const descriptor = await adapter.describe();
    expect(descriptor.models.find((model) => model.providerId === "configured-provider")).toMatchObject({ modelId: "configured-model", supportsImages: true,
      supportsFastMode: false, thinkingLevels: ["low", "high"] });
    expect(descriptor.providerRuntimeSupport).toEqual({ protocols: ["anthropic-messages"], fields: ["headers", "model_input_modalities", "model_limits"] });
    const binding = await adapter.createSession(createInput({ providerId: "configured-provider", modelId: "configured-model" }), contextFor().context);
    const options = runtime.queries[0]!.params.options;
    expect(options.env["ANTHROPIC_API_KEY"]).toBe(managed.token);
    expect(options.env["JOKO_MODEL_PROXY_TOKEN"]).toBeUndefined();
    expect(options.env["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"]).toBe("1");
    expect(options.env["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"]).toBe("1");
    expect(options.env["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:31415/routes/fixture");
    expect(options.env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"]).toBe("64000");
    expect(options.env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"]).toBe("64000");
    expect(options.env["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"]).toBe("57.6");
    expect(options.env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"]).toBe("4000");
    expect(options.settingSources).toEqual(["user", "project", "local"]);
    expect(options.settings).toMatchObject({
      apiKeyHelper: "",
      env: {
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "64000",
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "64000",
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "57.6",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4000"
      },
      fastMode: false
    });
    expect(JSON.stringify(options.settings)).not.toContain(managed.token);
    expect(managed.activations).toHaveLength(0);
    const source = contextFor(binding, { operationId: "managed-first-turn" });
    const context = { ...source.context, modelSelection: { providerId: "configured-provider", modelId: "configured-model" } };
    await adapter.send(textPrompt("local controlled prompt"), context);
    expect(managed.activations).toHaveLength(1);
    expect(managed.activations[0]!.input.operationId).toBe("managed-first-turn");
    expect(() => managed.activations[0]!.input.assertCurrent()).not.toThrow();
    runtime.queries[0]!.push(resultMessage(binding.nativeSessionId!, { result: `Output ${managed.token}`, totalCostUsd: 0 }));
    await eventually(() => source.events.some((event) => event.type === "done"));
    expect(source.events.filter((event): event is Extract<EventPayload, { type: "usage" }> => event.type === "usage").at(-1)?.usage.contextWindow)
      .toBe(64_000);
    expect(managed.activations[0]!.release).toHaveBeenCalledOnce();
    expect(() => managed.activations[0]!.input.assertCurrent()).toThrow();
    expect(JSON.stringify(source.events)).not.toContain(managed.token);
    expect(JSON.stringify(descriptor)).not.toContain(managed.token);
    await adapter.dispose();
    expect(managed.port.dispose).toHaveBeenCalledOnce();
  });

  test("passes the same managed model limit snapshot to an exact remote Query", async () => {
    const managed = managedProviderFixture();
    const remoteTarget: TargetDescriptor = {
      ...target,
      id: "target-remote-managed-limits",
      workspaceRoot: "D:\\service-owned-placeholder",
      remoteWorkspace: { hostId: "host-a", workspaceRoot: "/srv/project" }
    };
    const remoteRuntime = new FakeSdkRuntime({ initialFrameOverrides: { cwd: "/srv/project", model: "configured-model" } });
    const close = vi.fn(async () => undefined);
    const adapter = adapterFor(new FakeSdkRuntime(), {
      managedProviders: managed.port,
      resolveNativeMemoryEnabled: () => false,
      remoteRuntimes: {
        resolve: async () => ({
          runtime: remoteRuntime,
          workspaceRoot: "/srv/project",
          remote: true,
          assertCurrent: () => undefined
        }),
        close
      }
    });
    const binding = await adapter.createSession(
      createInput({ target: remoteTarget, providerId: "configured-provider", modelId: "configured-model" }),
      contextFor(undefined, { target: remoteTarget }).context
    );
    expect(remoteRuntime.queries).toHaveLength(1);
    expect(remoteRuntime.queries[0]!.params.options).toMatchObject({
      cwd: "/srv/project",
      env: {
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "64000",
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "64000",
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "57.6",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4000"
      },
      settings: {
        autoDreamEnabled: false,
        autoMemoryEnabled: false,
        env: {
          CLAUDE_CODE_MAX_CONTEXT_TOKENS: "64000",
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: "64000",
          CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "57.6",
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4000"
        }
      }
    });
    await adapter.closeSession(binding, contextFor(binding, { target: remoteTarget }).context);
    await adapter.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  test("revokes the managed HTTP lease as Stop starts while native cancellation confirmation is still pending", async () => {
    const managed = managedProviderFixture();
    const runtime = new FakeSdkRuntime({ initialFrameOverrides: { model: "configured-model" } });
    const adapter = adapterFor(runtime, { managedProviders: managed.port });
    const binding = await adapter.createSession(createInput({ providerId: "configured-provider", modelId: "configured-model" }), contextFor().context);
    const source = contextFor(binding, { operationId: "stopped-managed-turn" });
    const context = { ...source.context, modelSelection: { providerId: "configured-provider", modelId: "configured-model" } };
    await adapter.send(textPrompt("begin"), context);
    let acknowledge!: () => void;
    runtime.queries[0]!.interruptHandler = () => new Promise((resolvePromise) => { acknowledge = () => resolvePromise({ still_queued: [] }); });
    const stopping = adapter.abort(context);
    expect(managed.activations[0]!.release).toHaveBeenCalledOnce();
    expect(() => managed.activations[0]!.input.assertCurrent()).toThrow();
    expect(source.events.some((event) => event.type === "done")).toBe(false);
    acknowledge();
    await stopping;
    runtime.queries[0]!.push(resultMessage(binding.nativeSessionId!, { result: "", totalCostUsd: 0, terminalReason: "aborted_tools" }));
    await vi.waitFor(() => expect(source.events.at(-1)).toEqual({ type: "done", outcome: "aborted" }));
    await adapter.dispose();
  });

  test("restores the durable configured route and changes it by retiring and resuming the exact native session", async () => {
    const managed = managedProviderFixture();
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime, { managedProviders: managed.port });
    const binding = await adapter.createSession(createInput({ providerId: "configured-provider", modelId: "configured-model" }), contextFor().context);
    await adapter.closeSession(binding, contextFor(binding).context);
    const context = { ...contextFor({ ...binding, generation: 2 }, { generation: 2 }).context, modelSelection: { providerId: "configured-provider", modelId: "configured-model" } };
    const restored = await adapter.resumeSession(binding, context);
    expect(restored).toMatchObject({ providerId: "configured-provider", modelId: "configured-model", binding: { generation: 2 } });
    expect(runtime.queries[1]!.params.options).toMatchObject({ resume: binding.nativeSessionId, model: "configured-model" });
    expect(runtime.queries[1]!.params.options.env).toMatchObject({
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "64000",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4000"
    });
    const selected = await adapter.setModel("configured-provider", "second-model", { ...context, binding: restored.binding });
    expect(selected.modelId).toBe("second-model");
    expect(runtime.queries[1]!.closeCalls).toBe(1);
    expect(runtime.queries[2]!.params.options).toMatchObject({ resume: binding.nativeSessionId, model: "second-model" });
    expect(runtime.queries[2]!.params.options.env).toMatchObject({
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "128000",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000"
    });
    expect(managed.activations).toEqual([]);
    await adapter.dispose();
  });

  test("refuses a disabled or stale managed route before offering input and never falls back to native authentication", async () => {
    const managed = managedProviderFixture();
    managed.enabled = false;
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime, { managedProviders: managed.port });
    await expect(adapter.createSession(createInput({ providerId: "configured-provider", modelId: "configured-model" }), contextFor().context)).rejects.toThrow();
    expect(runtime.queries).toEqual([]);
    managed.enabled = true;
    const binding = await adapter.createSession(createInput({ providerId: "configured-provider", modelId: "configured-model" }), contextFor().context);
    managed.enabled = false;
    await expect(adapter.send(textPrompt("not dispatched"), { ...contextFor(binding, { operationId: "stale-route" }).context,
      modelSelection: { providerId: "configured-provider", modelId: "configured-model" } })).rejects.toThrow();
    expect(runtime.queries[0]!.receivedInputs).toEqual([]);
    expect(managed.activations).toEqual([]);
    await adapter.dispose();
  });

  test.each(["selection", "input"])("refreshes the durable pair before new %s after its route revision changes without changing the native Session", async (action) => {
    const managed = managedProviderFixture();
    const runtime = new FakeSdkRuntime({ initialFrameOverrides: { model: "configured-model" } });
    const adapter = adapterFor(runtime, { managedProviders: managed.port });
    const binding = await adapter.createSession(createInput({ providerId: "configured-provider", modelId: "configured-model", effort: "high" }), contextFor().context);
    const source = contextFor(binding, { operationId: "revised-route" });
    const context = { ...source.context, modelSelection: { providerId: "configured-provider", modelId: "configured-model" } };
    managed.revision = "revision-two";
    if (action === "selection") await adapter.setModel("configured-provider", "configured-model", context);
    else await adapter.send(textPrompt("new revision input"), context);
    expect(runtime.queries).toHaveLength(2);
    expect(runtime.queries[0]!.closeCalls).toBe(1);
    expect(runtime.queries[1]!.params.options).toMatchObject({ resume: binding.nativeSessionId, model: "configured-model", effort: "high" });
    expect(runtime.retiredQueries).toEqual([runtime.queries[0]]);
    expect(managed.activations).toHaveLength(action === "selection" ? 0 : 1);
    expect(runtime.queries[0]!.receivedInputs).toEqual([]);
    if (action === "input") expect(runtime.queries[1]!.receivedInputs[0]!.message.content).toBe("new revision input");
    await adapter.dispose();
  });

  test.each(["missing history", "unknown close"])("does not dispatch a new prompt during route refresh with %s", async (failure) => {
    const managed = managedProviderFixture();
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime, { managedProviders: managed.port });
    const binding = await adapter.createSession(createInput({ providerId: "configured-provider", modelId: "configured-model" }), contextFor().context);
    if (failure === "missing history") runtime.sessions.clear();
    else runtime.retirementFailure = true;
    managed.revision = "revision-two";
    await expect(adapter.send(textPrompt("not sent"), { ...contextFor(binding, { operationId: "failed-revision" }).context,
      modelSelection: { providerId: "configured-provider", modelId: "configured-model" } }))
      .rejects.toMatchObject({ publicError: { stateMayHaveChanged: failure === "unknown close" } });
    expect(runtime.queries).toHaveLength(1);
    expect(runtime.queries[0]!.receivedInputs).toEqual([]);
    expect(runtime.retiredQueries).toHaveLength(failure === "unknown close" ? 1 : 0);
    expect(managed.activations).toEqual([]);
    await adapter.dispose();
  });

  test("rejects a prepared route whose model belongs to another Provider before creating a Query", async () => {
    const managed = managedProviderFixture();
    const dispose = vi.fn();
    const port: ManagedProviderRuntimePort = { ...managed.port, prepare: async (owner) => {
      const route = await managed.port.prepare(owner);
      return { ...route, model: { ...route.model, providerId: "another-provider" }, dispose };
    } };
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime, { managedProviders: port });
    await expect(adapter.createSession(createInput({ providerId: "configured-provider", modelId: "configured-model" }), contextFor().context))
      .rejects.toMatchObject({ publicError: { code: "MANAGED_PROVIDER_ROUTE_UNAVAILABLE", stateMayHaveChanged: false } });
    expect(dispose).toHaveBeenCalledOnce();
    expect(runtime.queries).toEqual([]);
    await adapter.dispose();
  });

  test("rejects invalid managed model limits before advertising the model or creating a Query", async () => {
    const managed = managedProviderFixture();
    const invalidModel = { ...managed.port.listModels()[0]!, contextWindow: -1 };
    const port: ManagedProviderRuntimePort = {
      ...managed.port,
      listModels: () => [invalidModel],
      prepare: async (owner) => {
        const route = await managed.port.prepare(owner);
        return { ...route, model: invalidModel };
      }
    };
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime, { managedProviders: port });
    expect((await adapter.describe()).models.some((model) => model.providerId === "configured-provider")).toBe(false);
    await expect(adapter.createSession(
      createInput({ providerId: "configured-provider", modelId: "configured-model" }),
      contextFor().context
    )).rejects.toMatchObject({
      publicError: { code: "MANAGED_PROVIDER_MODEL_LIMIT_INVALID", stateMayHaveChanged: false }
    });
    expect(runtime.queries).toEqual([]);
    await adapter.dispose();
  });

  test.each(["cancel", "close"])("releases a late managed request activation after %s without admitting native input", async (ending) => {
    const managed = managedProviderFixture();
    let finishActivation!: () => void;
    const release = vi.fn();
    let activationStarted = false;
    const port: ManagedProviderRuntimePort = { ...managed.port, prepare: async (owner) => {
      const route = await managed.port.prepare(owner);
      return { ...route, activate: async () => {
        activationStarted = true;
        await new Promise<void>((resolvePromise) => { finishActivation = resolvePromise; });
        return { release };
      } };
    } };
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime, { managedProviders: port });
    const binding = await adapter.createSession(createInput({ providerId: "configured-provider", modelId: "configured-model" }), contextFor().context);
    const cancellation = new AbortController();
    const source = contextFor(binding, { operationId: "cancelled-activation" });
    const sending = adapter.send(textPrompt("not admitted"), { ...source.context, signal: cancellation.signal,
      modelSelection: { providerId: "configured-provider", modelId: "configured-model" } });
    const rejected = expect(sending).rejects.toThrow();
    await vi.waitFor(() => expect(activationStarted).toBe(true));
    if (ending === "cancel") cancellation.abort();
    else await adapter.closeSession(binding, source.context);
    await rejected;
    finishActivation();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(runtime.queries[0]!.receivedInputs).toEqual([]);
    expect(source.events).toEqual([]);
    await adapter.dispose();
  });

  test("rejects a same-session start rewind without inventing an inclusive message or starting a Query", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    expect((await adapter.describe()).capabilities.get("session.rewind_to_start")?.supported).toBe(false);
    await expect(adapter.navigateTree({ kind: "session_start" }, false, contextFor().context, undefined, navigationAuthority)).rejects.toThrow();
    await adapter.dispose();
  });

  test("describes only authoritative Backend lifecycle state and the exact mature SDK", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);

    const descriptor = await adapter.describe();

    expect(descriptor.adapterKind).toBe("claude-agent-sdk-stdio");
    expect(descriptor.instanceGeneration).toBe(INSTANCE_GENERATION);
    expect(descriptor.version).toBe(`sdk-${CLAUDE_AGENT_SDK_VERSION}+cli-2.1.259`);
    expect(descriptor.installationState).toBe("installed");
    expect(descriptor.authenticationState).toBe("signed_out");
    expect(descriptor.models.map((model) => model.modelId)).toEqual(["model-a", "model-b"]);
    expect("installed" in descriptor).toBe(false);
    expect("authenticated" in descriptor).toBe(false);
    expect(descriptor.capabilities.get("turn.stream")?.supported).toBe(true);
    expect(descriptor.capabilities.get("session.discovery")?.supported).toBe(true);
    expect(descriptor.capabilities.get("session.catalog")?.supported).toBe(true);
    expect(descriptor.capabilities.get("session.clone")?.supported).toBe(true);
    expect(descriptor.capabilities.get("session.fork")?.supported).toBe(true);
    expect(descriptor.capabilities.get("provider.refresh")?.supported).toBe(true);
    expect(descriptor.capabilities.get("provider.model_refresh")?.supported).toBe(true);
    expect(descriptor.capabilities.get("background.tasks")?.supported).toBe(true);
    expect(descriptor.capabilities.get("background.tasks.cancel")?.supported).toBe(true);
    expect(descriptor.capabilities.get("subagents.list")?.supported).toBe(true);
    expect(descriptor.capabilities.get("subagents.detail")?.supported).toBe(true);
    expect(descriptor.capabilities.get("subagents.transcript")?.supported).toBe(true);
    expect(descriptor.capabilities.get("subagents.stop")?.supported).toBe(true);
    expect(descriptor.capabilities.get("subagents.steer")?.supported).toBe(false);
    expect(descriptor.capabilities.get("subagents.default_model")).toMatchObject({ supported: false, reason: "not_implemented" });
    expect(descriptor.providers).toEqual([expect.objectContaining({
      providerId: "claude-code",
      supportsLogin: false,
      supportsLogout: false,
      supportsRefresh: true,
      supportsModelRefresh: true
    })]);
    expect(descriptor.capabilities.get("turn.steer")?.supported).toBe(true);
    expect(descriptor.capabilities.get("workspace.extra_dirs")?.options).toEqual(["read_write"]);
  });

  test.each(["2.1.258", "2.1.260", "unknown"])("keeps same-turn input closed for an unverified CLI %s", async (version) => {
    const runtime = new FakeSdkRuntime({ initialFrameOverrides: { claude_code_version: version } });
    runtime.probeCliVersion = version;
    const adapter = adapterFor(runtime);
    expect((await adapter.describe()).capabilities.get("turn.steer")).toMatchObject({ supported: false, reason: "upstream_missing" });
    const binding = await adapter.createSession(createInput(), contextFor().context);
    await adapter.send(textPrompt("Start"), contextFor(binding, { operationId: "start" }).context);
    await expect(adapter.send({ ...textPrompt("Adjust"), disposition: "steer" }, contextFor(binding, { operationId: "adjust" }).context))
      .rejects.toMatchObject({ publicError: { code: "BACKEND_CAPABILITY_UNAVAILABLE", stateMayHaveChanged: false } });
    expect(runtime.queries[0]!.receivedInputs).toHaveLength(1);
    await adapter.dispose();
  });

  test.each(["replay", "result"])("acknowledges same-turn input through an exact %s and keeps content and usage on the parent", async (ack) => {
    const runtime = new FakeSdkRuntime({ autoReplayInputs: false });
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const parent = contextFor(binding, { operationId: "parent" });
    const adjustment = contextFor(binding, { operationId: "adjustment" });
    await adapter.send(textPrompt("Start"), parent.context);
    const query = runtime.queries[0]!;
    expect(query.params.options.extraArgs).toEqual({ "replay-user-messages": null });
    query.push(assistantMessage(binding.nativeSessionId!, randomUUID(), [{ type: "text", text: "Before adjustment." }]));
    let admitted = false;
    const sending = adapter.send({ ...textPrompt("Adjust in this turn"), disposition: "steer" }, adjustment.context)
      .then(() => { admitted = true; });
    await vi.waitFor(() => expect(query.receivedInputs).toHaveLength(2));
    expect(admitted).toBe(false);
    expect(runtime.queries).toHaveLength(1);
    expect(adjustment.events).toEqual([]);
    const native = query.receivedInputs[1]!;
    if (ack === "replay") {
      query.push({ ...native, isReplay: true, session_id: binding.nativeSessionId });
      await sending;
      query.push({ ...native, isReplay: true, session_id: binding.nativeSessionId });
      await expect(adapter.send({ ...textPrompt("Duplicate"), disposition: "steer" }, adjustment.context))
        .rejects.toMatchObject({ publicError: { code: "NATIVE_INPUT_ALREADY_DISPATCHED", stateMayHaveChanged: true } });
    }
    const result = {
      ...resultMessage(binding.nativeSessionId!, { result: "Finished", totalCostUsd: 0.1 }),
      user_message_uuid: ack === "result" ? native.uuid : query.receivedInputs[0]!.uuid,
      user_message_uuids: query.receivedInputs.map((message) => message.uuid), queued_turn_count: 0
    };
    query.push(result);
    await sending;
    await vi.waitFor(() => expect(parent.events.at(-1)).toEqual({ type: "done", outcome: "completed" }));
    query.push(result);
    expect(adjustment.events).toEqual([{ type: "done", outcome: "completed" }]);
    expect(parent.events.filter((event) => event.type === "usage")).toHaveLength(1);
    expect(parent.events.filter((event) => event.type === "message_complete")).toEqual([
      expect.objectContaining({ blocks: [{ kind: "text", text: "Before adjustment." }] })
    ]);
    await adapter.dispose();
  });

  test.each(["missing consumption", "queued backlog", "foreign consumption"])("retires an acknowledged steer with %s in its Result", async (failure) => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const parent = contextFor(binding, { operationId: "parent" });
    const adjustment = contextFor(binding, { operationId: "adjustment" });
    await adapter.send(textPrompt("Start"), parent.context);
    await adapter.send({ ...textPrompt("Adjust"), disposition: "steer" }, adjustment.context);
    const query = runtime.queries[0]!;
    const ids = query.receivedInputs.map((message) => message.uuid);
    query.push({ ...resultMessage(binding.nativeSessionId!, { result: "Done", totalCostUsd: 0.1 }),
      user_message_uuid: ids[0],
      user_message_uuids: failure === "missing consumption" ? ids.slice(0, 1)
        : failure === "foreign consumption" ? [...ids, randomUUID()] : ids,
      queued_turn_count: failure === "queued backlog" ? 1 : 0
    });
    await vi.waitFor(() => expect(query.closeCalls).toBe(1));
    expect(adjustment.events).toEqual([
      expect.objectContaining({ type: "error", terminal: true, error: expect.objectContaining({ stateMayHaveChanged: true }) }),
      { type: "done", outcome: "failed" }
    ]);
    expect(parent.events.at(-1)).toEqual({ type: "done", outcome: "failed" });
    expect(parent.events.some((event) => event.type === "message_complete")).toBe(false);
    await adapter.dispose();
  });

  test.each(["caller cancellation", "original Result"])("withdraws unread same-turn input on %s and leaves the Query usable", async (ending) => {
    const runtime = new FakeSdkRuntime({ pauseAfterFirstInput: true });
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const parent = contextFor(binding, { operationId: "parent" });
    await adapter.send(textPrompt("Start"), parent.context);
    const query = runtime.queries[0]!;
    const cancellation = new AbortController();
    const sending = adapter.send({ ...textPrompt("Adjust"), disposition: "steer" }, {
      ...contextFor(binding, { operationId: "adjustment" }).context, signal: cancellation.signal
    });
    const rejected = expect(sending).rejects.toMatchObject({ publicError: { stateMayHaveChanged: false } });
    await vi.waitFor(async () => expect((await adapter.inspectSession(binding, parent.context)).pendingMessages).toBe(1));
    // Let preparation finish and place its input into the unread SDK slot.
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    if (ending === "caller cancellation") cancellation.abort();
    query.push(resultMessage(binding.nativeSessionId!, { result: "Done", totalCostUsd: 0.1 }));
    await rejected;
    await vi.waitFor(() => expect(parent.events.at(-1)).toEqual({ type: "done", outcome: "completed" }));
    query.resumeInputs();
    await adapter.send(textPrompt("Next explicit prompt"), contextFor(binding, { operationId: "next" }).context);
    expect(query.receivedInputs.map((message) => message.message.content)).toEqual(["Start", "Next explicit prompt"]);
    expect(query.closeCalls).toBe(0);
    await adapter.dispose();
  });

  test.each(["timeout", "cancel", "stop", "close", "original Result"])("fences consumed but unacknowledged steer on %s including late replay", async (ending) => {
    const runtime = new FakeSdkRuntime({ autoReplayInputs: false, leaveOutputOpenOnClose: true });
    const adapter = adapterFor(runtime, { admissionTimeoutMs: ending === "timeout" ? 150 : 500 });
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const parent = contextFor(binding, { operationId: "parent" });
    await adapter.send(textPrompt("Start"), parent.context);
    const query = runtime.queries[0]!;
    const adjustment = contextFor(binding, { operationId: "adjustment" });
    const cancellation = new AbortController();
    const sending = adapter.send({ ...textPrompt("Adjust"), disposition: "steer" }, { ...adjustment.context, signal: cancellation.signal });
    const rejected = expect(sending).rejects.toMatchObject({ publicError: { code: "NATIVE_DISPATCH_UNKNOWN", stateMayHaveChanged: true } });
    await vi.waitFor(() => expect(query.receivedInputs).toHaveLength(2));
    if (ending === "cancel") cancellation.abort();
    if (ending === "stop") await adapter.abort(parent.context).catch(() => undefined);
    if (ending === "close") await adapter.closeSession(binding, parent.context);
    if (ending === "original Result") query.push({
      ...resultMessage(binding.nativeSessionId!, { result: "Done", totalCostUsd: 0.1 }), user_message_uuid: query.receivedInputs[0]!.uuid
    });
    await rejected;
    await vi.waitFor(() => expect(query.closeCalls).toBe(1));
    const before = [...parent.events];
    query.push({ ...query.receivedInputs[1]!, isReplay: true, session_id: binding.nativeSessionId });
    query.push(resultMessage(binding.nativeSessionId!, { result: "Late", totalCostUsd: 1 }));
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(adjustment.events).toEqual([]);
    expect(parent.events).toEqual(before);
    expect(query.receivedInputs).toHaveLength(2);
    query.endOutput();
    await adapter.dispose();
  });

  test("waits for authoritative Stop before settling an acknowledged steer and rejects new input while stopping", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const parent = contextFor(binding, { operationId: "parent" });
    const adjustment = contextFor(binding, { operationId: "adjustment" });
    await adapter.send(textPrompt("Start"), parent.context);
    await adapter.send({ ...textPrompt("Adjust"), disposition: "steer" }, adjustment.context);
    const query = runtime.queries[0]!;
    let confirm!: () => void;
    query.interruptHandler = () => new Promise((resolvePromise) => { confirm = () => resolvePromise({ still_queued: [] }); });
    const stopping = adapter.abort(parent.context);
    await expect(adapter.send({ ...textPrompt("Too late"), disposition: "steer" }, contextFor(binding, { operationId: "late" }).context))
      .rejects.toMatchObject({ publicError: { code: "NATIVE_STEER_NOT_ACTIVE" } });
    query.push({ ...resultMessage(binding.nativeSessionId!, { result: "", totalCostUsd: 0.1, terminalReason: "aborted_tools" }),
      user_message_uuid: query.receivedInputs[0]!.uuid, queued_turn_count: 0 });
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(parent.events.some((event) => event.type === "done")).toBe(false);
    confirm();
    await stopping;
    await vi.waitFor(() => expect(adjustment.events).toEqual([{ type: "done", outcome: "aborted" }]));
    expect(parent.events.at(-1)).toEqual({ type: "done", outcome: "aborted" });
    expect(query.closeCalls).toBe(0);
    await adapter.dispose();
  });

  test("settles acknowledged steer as unknown when Stop leaves native queued work", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const parent = contextFor(binding, { operationId: "parent" });
    const adjustment = contextFor(binding, { operationId: "adjustment" });
    await adapter.send(textPrompt("Start"), parent.context);
    await adapter.send({ ...textPrompt("Adjust"), disposition: "steer" }, adjustment.context);
    const query = runtime.queries[0]!;
    query.interruptHandler = async () => ({ still_queued: [query.receivedInputs[1]!.uuid] });
    await expect(adapter.abort(parent.context)).rejects.toMatchObject({ publicError: { code: "TURN_ABORT_UNKNOWN", stateMayHaveChanged: true } });
    expect(adjustment.events).toEqual([
      expect.objectContaining({ type: "error", error: expect.objectContaining({ code: "TURN_ABORT_UNKNOWN" }) }),
      { type: "done", outcome: "failed" }
    ]);
    expect(query.closeCalls).toBe(1);
    await adapter.dispose();
  });

  test("does not publish a second terminal when steer cancellation races an awaited Result publication", async () => {
    const runtime = new FakeSdkRuntime({ autoReplayInputs: false });
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const parent = contextFor(binding, { operationId: "parent" });
    let release!: () => void;
    let publishing = false;
    const publication = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const parentContext = { ...parent.context, emit: async (event: EventPayload) => {
      parent.events.push(event);
      if (event.type === "status") { publishing = true; await publication; }
    } };
    await adapter.send(textPrompt("Start"), parentContext);
    const query = runtime.queries[0]!;
    const cancellation = new AbortController();
    const sending = adapter.send({ ...textPrompt("Adjust"), disposition: "steer" }, {
      ...contextFor(binding, { operationId: "adjustment" }).context, signal: cancellation.signal
    });
    const rejected = expect(sending).rejects.toMatchObject({ publicError: { code: "NATIVE_DISPATCH_UNKNOWN" } });
    await vi.waitFor(() => expect(query.receivedInputs).toHaveLength(2));
    query.push({ ...resultMessage(binding.nativeSessionId!, { result: "Done", totalCostUsd: 0.1 }),
      user_message_uuid: query.receivedInputs[0]!.uuid,
      user_message_uuids: query.receivedInputs.map((message) => message.uuid), fast_mode_state: "on"
    });
    await vi.waitFor(() => expect(publishing).toBe(true));
    cancellation.abort();
    await rejected;
    release();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(parent.events.filter((event) => event.type === "done")).toEqual([{ type: "done", outcome: "failed" }]);
    expect(parent.events.some((event) => event.type === "message_complete" || event.type === "usage")).toBe(false);
    await adapter.dispose();
  });

  test("rejects foreign ACK identities and concurrent operations without admitting another input", async () => {
    const runtime = new FakeSdkRuntime({ autoReplayInputs: false });
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const parent = contextFor(binding, { operationId: "parent" });
    const adjustment = contextFor(binding, { operationId: "adjustment" });
    await adapter.send(textPrompt("Start"), parent.context);
    const query = runtime.queries[0]!;
    const sending = adapter.send({ ...textPrompt("Adjust"), disposition: "steer" }, adjustment.context);
    const rejected = expect(sending).rejects.toMatchObject({ publicError: { code: "NATIVE_DISPATCH_UNKNOWN", stateMayHaveChanged: true } });
    await vi.waitFor(() => expect(query.receivedInputs).toHaveLength(2));
    await expect(adapter.send({ ...textPrompt("Concurrent"), disposition: "steer" }, contextFor(binding, { operationId: "concurrent" }).context))
      .rejects.toMatchObject({ publicError: { code: "SESSION_BUSY" } });
    query.push({ ...query.receivedInputs[1]!, uuid: randomUUID(), isReplay: true, session_id: binding.nativeSessionId });
    await rejected;
    expect(query.receivedInputs).toHaveLength(2);
    await adapter.dispose();
  });

  test("advertises Fast from the native catalog and acknowledges the initial session selection", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const descriptor = await adapter.describe();
    expect(descriptor.capabilities.get("model.fast_mode")?.supported).toBe(true);
    expect(descriptor.models.map((model) => model.supportsFastMode)).toEqual([true, false]);
    const binding = await adapter.createSession(createInput({ modelId: "model-a-20260801", fastMode: true }), contextFor().context);
    expect(runtime.queries[0]!.params.options.settings).toEqual({ apiKeyHelper: "", fastMode: true });
    await expect(adapter.inspectSession(binding, contextFor(binding).context)).resolves.toMatchObject({ fastMode: true });
    await adapter.dispose();
    const unavailable = new FakeSdkRuntime();
    unavailable.probeInitialization = { ...initialization(), models: [initialization().models[1]!] };
    const unavailableAdapter = adapterFor(unavailable);
    expect((await unavailableAdapter.describe()).capabilities.get("model.fast_mode")?.supported).toBe(false);
    await unavailableAdapter.dispose();
  });

  test("snapshots committed subtask defaults for each Query while retaining existing runtimes", async () => {
    const runtime = new FakeSdkRuntime();
    let model: string | undefined = "model-a";
    const resolveSubagentModel = vi.fn(() => model);
    const adapter = adapterFor(runtime, {
      resolveSubagentModel,
      environment: { CLAUDE_CODE_SUBAGENT_MODEL: "external-model", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" }
    });
    try {
      const binding = await adapter.createSession(createInput(), contextFor().context);
      const first = runtime.queries[0]!;
      expect((await adapter.describe()).capabilities.get("subagents.default_model")?.supported).toBe(true);
      expect(resolveSubagentModel.mock.calls).toEqual([["claude-code"]]);
      expect(first.params.options.env["CLAUDE_CODE_SUBAGENT_MODEL"]).toBe("model-a");
      expect(first.params.options.env["CLAUDE_CODE_SUBAGENT_MODEL_FORCE"]).toBeUndefined();
      expect(first.params.options.agents).toBeUndefined();
      expect(first.params.options.model).toBeUndefined();

      model = "model-b";
      await adapter.send(textPrompt("Use the committed runtime"), contextFor(binding, { operationId: "original-default" }).context);
      expect(resolveSubagentModel).toHaveBeenCalledTimes(1);
      expect(first.params.options.env["CLAUDE_CODE_SUBAGENT_MODEL"]).toBe("model-a");
      await adapter.closeSession(binding, contextFor(binding).context);
      const resumedBinding = { ...binding, generation: 2 };
      await adapter.resumeSession(binding, contextFor(resumedBinding, { generation: 2 }).context);
      expect(runtime.queries[1]!.params.options.env["CLAUDE_CODE_SUBAGENT_MODEL"]).toBe("model-b");
      await adapter.closeSession(resumedBinding, contextFor(resumedBinding, { generation: 2 }).context);

      model = undefined;
      await adapter.createSession(createInput(), contextFor().context);
      expect(runtime.queries[2]!.params.options.env["CLAUDE_CODE_SUBAGENT_MODEL"]).toBeUndefined();
      expect(runtime.queries[2]!.params.options.env["CLAUDE_CODE_SUBAGENT_MODEL_FORCE"]).toBeUndefined();
      expect(resolveSubagentModel).toHaveBeenCalledTimes(3);
    } finally {
      await adapter.dispose();
    }
  });

  test.each([undefined, "2.1.258", "2.1.260"])("rejects a configured subtask default without exact native precedence (%s)", async (version) => {
    const runtime = new FakeSdkRuntime();
    runtime.probeCliVersion = version;
    let selectedModel: string | undefined = "model-a";
    const adapter = adapterFor(runtime, { resolveSubagentModel: () => selectedModel });
    try {
      expect((await adapter.describe()).capabilities.get("subagents.default_model")).toMatchObject({
        supported: false, reason: "upstream_missing"
      });
      await expect(adapter.createSession(createInput(), contextFor().context)).rejects.toMatchObject({
        publicError: { code: "SUBAGENT_MODEL_DEFAULT_UNAVAILABLE", stateMayHaveChanged: false }
      });
      expect(runtime.queries).toEqual([]);
      selectedModel = undefined;
      await adapter.createSession(createInput(), contextFor().context);
      expect(runtime.queries).toHaveLength(1);
      expect(runtime.queries[0]!.params.options.env["CLAUDE_CODE_SUBAGENT_MODEL"]).toBeUndefined();
    } finally {
      await adapter.dispose();
    }
  });

  test.each(["", " padded", "line\nmodel", "x".repeat(513)])("rejects a malformed configured subtask identifier before creating a Query", async (model) => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime, { resolveSubagentModel: () => model });
    await expect(adapter.createSession(createInput(), contextFor().context)).rejects.toMatchObject({
      publicError: { code: "SUBAGENT_MODEL_INVALID", stateMayHaveChanged: false }
    });
    expect(runtime.queries).toEqual([]);
    await adapter.dispose();
  });

  test("rejects a removed subtask model in the actual Query catalog before sending input", async () => {
    const runtime = new FakeSdkRuntime();
    runtime.queryInitialization = { ...initialization(), models: [initialization().models[1]!] };
    const adapter = adapterFor(runtime, { resolveSubagentModel: () => "model-a" });
    await expect(adapter.createSession(createInput(), contextFor().context)).rejects.toMatchObject({
      publicError: { code: "SUBAGENT_MODEL_UNAVAILABLE", recovery: expect.stringContaining("explicitly retry") }
    });
    expect(runtime.queries).toHaveLength(1);
    expect(runtime.queries[0]!.receivedInputs).toEqual([]);
    expect(runtime.queries[0]!.closeCalls).toBe(1);
    await adapter.dispose();
  });

  test("fails subtask default admission when the Query reports a different native version", async () => {
    const runtime = new FakeSdkRuntime({ initialFrameOverrides: { claude_code_version: "2.1.260" } });
    const adapter = adapterFor(runtime, { resolveSubagentModel: () => "model-a", admissionTimeoutMs: 50 });
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const turn = contextFor(binding, { operationId: "changed-native-priority" });
    await expect(adapter.send(textPrompt("Keep explicit models authoritative"), turn.context)).rejects.toMatchObject({
      publicError: { code: "SUBAGENT_MODEL_DEFAULT_UNAVAILABLE", stateMayHaveChanged: true, recovery: expect.stringContaining("explicitly retry") }
    });
    expect(runtime.queries).toHaveLength(1);
    expect(runtime.queries[0]!.closeCalls).toBe(1);
    await adapter.dispose();
  });

  test("keeps subtask setting read failures bounded and outside native startup", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime, { resolveSubagentModel: () => { throw new Error("private-read-detail"); } });
    const outcome = await adapter.createSession(createInput(), contextFor().context).catch((error: unknown) => error);
    expect(outcome).toMatchObject({ publicError: { code: "SUBAGENT_MODEL_DEFAULT_READ_FAILED", stateMayHaveChanged: false } });
    expect(JSON.stringify(outcome)).not.toContain("private-read-detail");
    expect(runtime.queries).toEqual([]);
    await adapter.dispose();
  });

  test("uses the attached Query catalog rather than a stale probe capability for Fast selection", async () => {
    const runtime = new FakeSdkRuntime();
    runtime.queryInitialization = {
      ...initialization(), models: initialization().models.map((model) => ({ ...model, supportsFastMode: false }))
    };
    const adapter = adapterFor(runtime);
    expect((await adapter.describe()).capabilities.get("model.fast_mode")?.supported).toBe(true);
    await expect(adapter.createSession(createInput({ modelId: "model-a", fastMode: true }), contextFor().context))
      .rejects.toMatchObject({ publicError: { code: "FAST_MODE_UNAVAILABLE" } });
    expect(runtime.queries[0]!.closeCalls).toBe(1);
    await adapter.dispose();
  });

  test.each([undefined, "model-b"])("rejects a new Fast selection without model authority (%s) before sending input", async (modelId) => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    await expect(adapter.createSession(createInput({ modelId, fastMode: true }), contextFor().context))
      .rejects.toMatchObject({ publicError: { code: "FAST_MODE_UNAVAILABLE" } });
    expect(runtime.queries[0]!.receivedInputs).toEqual([]);
    expect(runtime.queries[0]!.closeCalls).toBe(1);
    await adapter.dispose();
  });

  test("serializes Fast ACKs with dispatch and model changes, clearing Fast before an incompatible model", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput({ modelId: "model-a" }), contextFor().context);
    const context = contextFor(binding).context;
    const query = runtime.queries[0]!;
    expect(query.params.options.settings).toEqual({ apiKeyHelper: "", fastMode: false });
    await expect(adapter.setFastMode(true, { ...context, signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ publicError: { code: "NATIVE_CONTROL_ABORTED", stateMayHaveChanged: false } });
    expect(query.settingCalls).toEqual([]);
    let acknowledge!: () => void;
    query.settingsHandler = () => new Promise<void>((resolve) => { acknowledge = resolve; });
    const enabling = adapter.setFastMode(true, context);
    await eventually(() => query.settingCalls.length === 1);
    await expect(adapter.inspectSession(binding, context)).resolves.toMatchObject({ fastMode: false });
    await expect(adapter.send(textPrompt("wait for the control"), contextFor(binding, { operationId: "pending-fast" }).context))
      .rejects.toMatchObject({ publicError: { code: "SESSION_BUSY" } });
    await expect(adapter.setModel("claude-code", "model-b", context)).rejects.toMatchObject({ publicError: { code: "SESSION_BUSY" } });
    acknowledge();
    await enabling;
    await expect(adapter.inspectSession(binding, context)).resolves.toMatchObject({ fastMode: true });
    const changingModel = adapter.setModel("claude-code", "model-b", context);
    await eventually(() => query.settingCalls.length === 2);
    expect(query.settingCalls[1]).toEqual({ fastMode: false });
    expect(query.modelCalls).toEqual([]);
    acknowledge();
    await changingModel;
    await expect(adapter.inspectSession(binding, context)).resolves.toMatchObject({ modelId: "model-b", fastMode: false });
    await expect(adapter.setFastMode(true, context)).rejects.toMatchObject({ publicError: { code: "FAST_MODE_UNAVAILABLE" } });
    query.settingsHandler = async () => {};
    await adapter.setFastMode(false, context);
    await adapter.setModel("claude-code", "model-a", context);
    await adapter.setFastMode(true, context);
    await adapter.send(textPrompt("Fast is now selected"), contextFor(binding, { operationId: "fast-turn" }).context);
    await expect(adapter.setFastMode(false, context)).rejects.toMatchObject({ publicError: { code: "SESSION_BUSY" } });
    await adapter.dispose();
  });

  test("restores a saved Fast selection through acknowledged controls after resume", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput({ modelId: "model-a", fastMode: true }), contextFor().context);
    await adapter.closeSession(binding, contextFor(binding).context);
    const resumedBinding = { ...binding, generation: 2 };
    const context = contextFor(resumedBinding, { generation: 2 }).context;
    await adapter.resumeSession(binding, context);
    const resumedQuery = runtime.queries[1]!;
    expect(resumedQuery.params.options.settings).toEqual({ apiKeyHelper: "" });
    await adapter.setModel("claude-code", "model-a", context);
    await adapter.setFastMode(true, context);
    expect(resumedQuery.settingCalls).toEqual([{ fastMode: true }]);
    await expect(adapter.inspectSession(resumedBinding, context)).resolves.toMatchObject({ fastMode: true, modelId: "model-a" });
    await adapter.dispose();
  });

  test("keeps the last ACK and blocks dispatch when a Fast control fails without a receipt", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput({ modelId: "model-a" }), contextFor().context);
    const context = contextFor(binding).context;
    const query = runtime.queries[0]!;
    query.settingsHandler = async () => { throw new Error("provider-secret-must-not-escape"); };
    const result = await adapter.setFastMode(true, context).catch((error: unknown) => error);
    expect(result).toMatchObject({ publicError: { code: "NATIVE_CONTROL_UNKNOWN", stateMayHaveChanged: true } });
    expect(JSON.stringify(result)).not.toContain("provider-secret-must-not-escape");
    await expect(adapter.inspectSession(binding, context)).resolves.toMatchObject({ fastMode: false });
    await expect(adapter.send(textPrompt("uncertain"), contextFor(binding, { operationId: "uncertain-fast" }).context))
      .rejects.toMatchObject({ publicError: { code: "NATIVE_CONTROL_UNKNOWN" } });
    expect(query.receivedInputs).toEqual([]);
    await adapter.dispose();
  });

  test.each(["cancel", "timeout", "retire"] as const)("does not install a late Fast ACK after %s", async (boundary) => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime, { initializationTimeoutMs: 50 });
    const binding = await adapter.createSession(createInput({ modelId: "model-a" }), contextFor().context);
    const cancellation = new AbortController();
    const context = { ...contextFor(binding).context, signal: cancellation.signal };
    const query = runtime.queries[0]!;
    let acknowledge!: () => void;
    query.settingsHandler = () => new Promise<void>((resolve) => { acknowledge = resolve; });
    const pending = adapter.setFastMode(true, context).catch((error: unknown) => error);
    await eventually(() => query.settingCalls.length === 1);
    if (boundary === "cancel") cancellation.abort();
    if (boundary === "retire") await adapter.closeSession(binding, contextFor(binding).context);
    expect(await pending).toMatchObject({ publicError: { code: "NATIVE_CONTROL_UNKNOWN", stateMayHaveChanged: true } });
    acknowledge();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (boundary === "retire") {
      const replacement = await adapter.createSession(createInput({ modelId: "model-a" }), contextFor(undefined, { generation: 2 }).context);
      await expect(adapter.inspectSession(replacement, contextFor(replacement, { generation: 2 }).context))
        .resolves.toMatchObject({ fastMode: false });
    } else {
      await expect(adapter.inspectSession(binding, contextFor(binding).context)).resolves.toMatchObject({ fastMode: false });
      await expect(adapter.setFastMode(false, contextFor(binding).context)).rejects.toMatchObject({ publicError: { code: "NATIVE_CONTROL_UNKNOWN" } });
    }
    await adapter.dispose();
  });

  test("projects native Fast cooldown and disabled reasons without overwriting the selected session mode", async () => {
    const runtime = new FakeSdkRuntime({ initialFrameOverrides: { fast_mode_state: "on" } });
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput({ modelId: "model-a", fastMode: true }), contextFor().context);
    const active = contextFor(binding, { operationId: "fast-cooldown" });
    await adapter.send(textPrompt("Check the current state"), active.context);
    await eventually(() => active.events.some((event) => event.type === "status" && event.key === "claude-code.fast-mode"));
    const query = runtime.queries[0]!;
    query.push({ ...resultMessage(binding.nativeSessionId!, { result: "Completed", totalCostUsd: 0 }), fast_mode_state: "cooldown" });
    await eventually(() => active.events.some((event) => event.type === "done"));
    expect(active.events.filter((event) => event.type === "status")).toEqual([
      expect.objectContaining({ key: "claude-code.fast-mode", text: expect.stringContaining("individual requests may still use standard speed") }),
      expect.objectContaining({ key: "claude-code.fast-mode", text: expect.stringContaining("cooling down") })
    ]);
    await expect(adapter.inspectSession(binding, contextFor(binding).context)).resolves.toMatchObject({ fastMode: true });
    const next = contextFor(binding, { operationId: "fast-disabled" });
    await adapter.send(textPrompt("Retry later"), next.context);
    query.push({ ...resultMessage(binding.nativeSessionId!, { result: "Completed again", totalCostUsd: 0 }), fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled" });
    await eventually(() => next.events.some((event) => event.type === "done"));
    expect(next.events).toContainEqual(expect.objectContaining({ type: "status", key: "claude-code.fast-mode", text: expect.stringContaining("requires extra usage") }));
    await expect(adapter.inspectSession(binding, contextFor(binding).context)).resolves.toMatchObject({ fastMode: true });
    await adapter.dispose();
  });

  test("preserves a cooldown observation from native initialization until the first owned turn", async () => {
    const runtime = new FakeSdkRuntime();
    runtime.queryInitialization = { ...initialization(), fast_mode_state: "cooldown" };
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput({ modelId: "model-a", fastMode: true }), contextFor().context);
    const active = contextFor(binding, { operationId: "initial-fast-cooldown" });
    await adapter.send(textPrompt("Continue"), active.context);
    await eventually(() => active.events.some((event) => event.type === "status" && event.key === "claude-code.fast-mode"));
    expect(active.events).toContainEqual(expect.objectContaining({ type: "status", text: expect.stringContaining("cooling down") }));
    await expect(adapter.inspectSession(binding, contextFor(binding).context)).resolves.toMatchObject({ fastMode: true });
    await adapter.dispose();
  });

  test("does not replay a pre-control Fast observation when later native frames omit optional state", async () => {
    const runtime = new FakeSdkRuntime();
    runtime.queryInitialization = { ...initialization(), fast_mode_state: "cooldown" };
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput({ modelId: "model-a", fastMode: true }), contextFor().context);
    await adapter.setFastMode(false, contextFor(binding).context);
    const active = contextFor(binding, { operationId: "no-stale-fast-cooldown" });
    await adapter.send(textPrompt("Continue at the selected setting"), active.context);
    runtime.queries[0]!.push(resultMessage(binding.nativeSessionId!, { result: "Completed", totalCostUsd: 0 }));
    await eventually(() => active.events.some((event) => event.type === "done"));
    expect(active.events.filter((event) => event.type === "status" && event.key === "claude-code.fast-mode")).toEqual([]);
    await expect(adapter.inspectSession(binding, contextFor(binding).context)).resolves.toMatchObject({ fastMode: false });
    await adapter.dispose();
  });

  test("keeps local catalog scanning available without an installed executable", async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), "joko-claude-offline-profile-"));
    const adapter = adapterFor(new FakeSdkRuntime({ probeInstalled: false }), {
      environment: { CLAUDE_CONFIG_DIR: configDirectory }
    });
    try {
      const descriptor = await adapter.describe();
      expect(descriptor.installationState).toBe("not_installed");
      expect(descriptor.capabilities.get("session.catalog")).toEqual({
        key: "session.catalog",
        supported: true
      });
      expect(descriptor.capabilities.get("turn.stream")).toMatchObject({
        supported: false,
        reason: "upstream_missing"
      });
      await expect(adapter.scanNativeSessionCatalog()).resolves.toEqual({ entries: [], rejectedCount: 0 });
    } finally {
      await adapter.dispose();
      await rm(configDirectory, { recursive: true, force: true });
    }
  });

  test("discovers and replaces account, model, and CLI state without opening a task Query", async () => {
    const runtime = new FakeSdkRuntime();
    runtime.probeInitialization = {
      models: [initialization().models[0]!],
      account: { email: "developer@example.test" }
    };
    runtime.probeCliVersion = "2.1.240";
    const probeCwd = resolve(process.cwd(), "probe-workspace");
    const adapter = adapterFor(runtime, { probeCwd });

    const first = await adapter.describe();
    expect(first.authenticationState).toBe("authenticated");
    expect(first.models.map((model) => model.modelId)).toEqual(["model-a"]);
    expect(first.capabilities.get("model.effort")?.supported).toBe(true);
    expect(first.version).toContain("cli-2.1.240");
    expect(runtime.queries).toEqual([]);
    expect(runtime.probeInputs).toEqual([expect.objectContaining({
      cwd: probeCwd,
      settings: { apiKeyHelper: "" },
      settingSources: ["user", "project", "local"],
      initializationTimeoutMs: 500
    })]);

    runtime.probeInitialization = {
      models: [{
        value: "model-c",
        displayName: "Model C",
        description: "Replacement model"
      }],
      account: {}
    };
    runtime.probeCliVersion = "2.1.241";
    const replacement = await adapter.describe();

    expect(replacement.authenticationState).toBe("signed_out");
    expect(replacement.models.map((model) => model.modelId)).toEqual(["model-c"]);
    expect(replacement.capabilities.get("model.effort")?.supported).toBe(false);
    expect(replacement.version).toContain("cli-2.1.241");
  });

  test("dispatches immutable images, bounded files, and a source-qualified Artifact through the native content contract", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "joko-claude-input-"));
    const workspaceTarget = { ...target, workspaceRoot: await realpath(workspace) };
    const attachmentPath = join(workspaceTarget.workspaceRoot, "attached.txt");
    const mentionedPath = join(workspaceTarget.workspaceRoot, "mentioned.txt");
    const directoryPath = join(workspaceTarget.workspaceRoot, "source files");
    await writeFile(attachmentPath, "attachment");
    await writeFile(mentionedPath, "workspace reference");
    await mkdir(directoryPath);
    const image = imageAttachment();
    const readBlob = vi.fn(async () => ({ data: image.data, mimeType: "image/png" }));
    const resolveFile = vi.fn(async () => attachmentPath);
    const artifactBlob = { id: "mentioned-artifact", sha256: createHash("sha256").update("attachment").digest("hex"), byteLength: 10, mimeType: "text/plain" };
    const artifactSourceSessionId = "artifact-source-session";
    const assertArtifactCurrent = vi.fn();
    const resolveArtifactMention = vi.fn(async () => ({ blob: artifactBlob, path: attachmentPath, assertCurrent: assertArtifactCurrent }));
    const runtime = new FakeSdkRuntime({ initialFrameOverrides: { cwd: workspaceTarget.workspaceRoot } });
    const adapter = adapterFor(runtime, { readBlob, resolveFile, resolveArtifactMention });
    try {
      const descriptor = await adapter.describe();
      expect(descriptor.capabilities.get("input.image")?.supported).toBe(true);
      expect(descriptor.capabilities.get("input.file")?.supported).toBe(true);
      expect(descriptor.capabilities.get("input.mention")).toMatchObject({ supported: true, options: ["workspace_file", "workspace_directory", "workspace_line_range", "artifact"] });
      const binding = await adapter.createSession(createInput({ target: workspaceTarget }), contextFor(undefined, { target: workspaceTarget }).context);
      const active = contextFor(binding, { target: workspaceTarget, operationId: "mixed-input" });
      await adapter.send({
        ...textPrompt("Describe the image and compare the files."),
        images: [{ blob: image.blob }],
        files: [{ blob: { id: "file-artifact", sha256: createHash("sha256").update("attachment").digest("hex"), byteLength: 10, mimeType: "text/plain", fileName: "attached.txt" } }],
        mentions: [
          { kind: "workspace_file", label: "mentioned", reference: "mentioned.txt" },
          { kind: "workspace_directory", label: "sources", reference: "source files" },
          { kind: "workspace_file", label: "selected lines", reference: "mentioned.txt", lineRange: { startLine: 1, endLine: 1 } },
          { kind: "artifact", label: "prior output", reference: artifactBlob.id, sourceSessionId: artifactSourceSessionId }
        ]
      }, active.context);
      expect(runtime.queries[0]!.receivedInputs[0]!.message.content).toEqual([
        { type: "image", source: { type: "base64", media_type: "image/png", data: image.data.toString("base64") } },
        { type: "text", text: [
          "Describe the image and compare the files.",
          `Attached file: ${JSON.stringify({ name: "attached.txt", path: attachmentPath })}`,
          `Workspace file reference: ${JSON.stringify({ name: "mentioned", path: mentionedPath })}`,
          `Workspace directory reference: ${JSON.stringify({ name: "sources", path: directoryPath })}`,
          `Workspace file reference: ${JSON.stringify({ name: "selected lines", path: mentionedPath, lineRange: { startLine: 1, endLine: 1 } })}`,
          `Artifact reference: ${JSON.stringify({ name: "prior output", path: attachmentPath })}`
        ].join("\n\n") }
      ]);
      expect(resolveFile).toHaveBeenCalledWith(expect.objectContaining({ fileName: "attached.txt" }), active.context);
      expect(readBlob).toHaveBeenCalledOnce();
      expect(resolveArtifactMention).toHaveBeenCalledWith(
        artifactBlob.id,
        artifactSourceSessionId,
        active.context,
        expect.any(AbortSignal)
      );
      expect(assertArtifactCurrent).toHaveBeenCalled();
    } finally {
      await adapter.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("advertises exact loaded text resources and injects only approved content into the selected native input", async () => {
    let current = true;
    const assertCurrent = vi.fn(() => {
      if (!current) throw new Error("Private managed-resource location changed.");
    });
    const seed = textResourceSeed({ assertCurrent });
    const resolveTextResources: NonNullable<ClaudeCodeAdapterOptions["resolveTextResources"]> = vi.fn(
      async (_context, signal) => {
        signal.throwIfAborted();
        return [seed];
      }
    );
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime, { resolveTextResources });
    try {
      const descriptor = await adapter.describe();
      expect(descriptor.capabilities.get("runtime.resources")).toMatchObject({
        supported: true,
        options: ["skill", "prompt"]
      });
      expect(descriptor.capabilities.get("input.mention")?.options).toContain("resource");

      const creation = contextFor();
      const binding = await adapter.createSession(createInput(), creation.context);
      expect(resolveTextResources).toHaveBeenCalledWith(creation.context, expect.any(AbortSignal));
      const active = contextFor(binding, { operationId: "resource-input" });
      await expect(adapter.getResources(active.context)).resolves.toEqual([{
        id: seed.id,
        kind: seed.kind,
        name: seed.name,
        source: "managed",
        state: "loaded",
        revision: seed.revision,
        resourceVersion: seed.resourceVersion,
        runtimeGeneration: active.context.generation,
        version: seed.version
      }]);
      await adapter.send({
        ...textPrompt("Use the selected instructions."),
        mentions: [resourceMention(seed, active.context.generation)]
      }, active.context);
      const nativeContent = runtime.queries[0]!.receivedInputs[0]!.message.content;
      expect(nativeContent).toContain("Use the selected instructions.");
      expect(nativeContent).toContain(seed.content);
      expect(nativeContent).toContain(JSON.stringify(seed.name));
      expect(nativeContent).not.toContain(seed.id);
      expect(nativeContent).not.toContain(seed.revision);
      expect(nativeContent).not.toContain("managed-resources");
      expect(assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(5);

      const nativeUser = runtime.queries[0]!.receivedInputs[0]!;
      expect(adapter.nativeUserEntryIdForOperation(active.context.operationId!)).toBe(nativeUser.uuid);
      const foreignUserId = randomUUID();
      runtime.messages.set(binding.nativeSessionId!, [
        {
          ...nativeUser,
          session_id: binding.nativeSessionId!,
          parent_agent_id: null
        },
        historyMessage("user", foreignUserId, binding.nativeSessionId!, {
          role: "user",
          content: "An ordinary foreign native prompt remains visible."
        })
      ]);
      const history = await adapter.getNativeHistoryProjection(active.context);
      expect(history.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          nativeEntryId: nativeUser.uuid,
          payload: { type: "message_complete", role: "user", blocks: [] }
        }),
        expect.objectContaining({
          nativeEntryId: foreignUserId,
          payload: {
            type: "message_complete",
            role: "user",
            blocks: [{ kind: "text", text: "An ordinary foreign native prompt remains visible." }]
          }
        })
      ]));
      expect(JSON.stringify(history)).not.toContain(seed.content);

      current = false;
      await expect(adapter.getResources(active.context)).resolves.toEqual([]);
    } finally {
      await adapter.dispose();
    }
  });

  test.each([
    ["revision", { discoveredRevision: "sha256:replacement" }],
    ["entity version", { resourceVersion: "8" }],
    ["runtime generation", { runtimeGeneration: 2 }]
  ] as const)("rejects a resource mention with a stale %s before native admission", async (_label, replacement) => {
    const seed = textResourceSeed();
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime, { resolveTextResources: async () => [seed] });
    try {
      const binding = await adapter.createSession(createInput(), contextFor().context);
      const active = contextFor(binding, { operationId: `stale-resource-${_label}` });
      await expect(adapter.send({
        ...textPrompt(""),
        mentions: [{ ...resourceMention(seed, active.context.generation), ...replacement }]
      }, active.context)).rejects.toMatchObject({
        publicError: { code: "RESOURCE_MENTION_STALE", stateMayHaveChanged: false }
      });
      expect(runtime.queries[0]!.receivedInputs).toEqual([]);
    } finally {
      await adapter.dispose();
    }
  });

  test("withdraws a text resource whose authority expires before the native input gate consumes it", async () => {
    let current = true;
    const assertCurrent = vi.fn(() => {
      if (!current) throw new Error("The approved record was replaced.");
    });
    const seed = textResourceSeed({ assertCurrent });
    const runtime = new FakeSdkRuntime({ pauseAfterFirstInput: true });
    const adapter = adapterFor(runtime, { resolveTextResources: async () => [seed] });
    try {
      const binding = await adapter.createSession(createInput(), contextFor().context);
      const query = runtime.queries[0]!;
      const first = contextFor(binding, { operationId: "resource-gate-first" });
      await adapter.send(textPrompt("Start"), first.context);
      query.push(resultMessage(binding.nativeSessionId!, { result: "Done", totalCostUsd: 0 }));
      await eventually(() => first.events.some((event) => event.type === "done"));

      const sending = adapter.send({
        ...textPrompt(""),
        mentions: [resourceMention(seed, 1)]
      }, contextFor(binding, { operationId: "resource-gate-second" }).context);
      const rejected = expect(sending).rejects.toMatchObject({
        publicError: { code: "RESOURCE_MENTION_STALE", stateMayHaveChanged: false }
      });
      await vi.waitFor(() => expect(assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(4));
      current = false;
      query.resumeInputs();
      await rejected;
      expect(query.receivedInputs.map((input) => input.message.content)).toEqual(["Start"]);
    } finally {
      await adapter.dispose();
    }
  });

  test("keeps approved text resources out of isolated review runtimes", async () => {
    const resolveTextResources: NonNullable<ClaudeCodeAdapterOptions["resolveTextResources"]> = vi.fn(async () => [textResourceSeed()]);
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime, { resolveTextResources });
    try {
      await adapter.describe();
      const creation = contextFor(undefined, { runtimePolicy: "review_read_only" });
      const binding = await adapter.createSession(createInput({
        runtimePolicy: "review_read_only",
        permissionMode: "ask"
      }), creation.context);
      const review = contextFor(binding, { runtimePolicy: "review_read_only" }).context;
      await expect(adapter.getResources(review)).resolves.toEqual([]);
      expect(resolveTextResources).not.toHaveBeenCalled();
    } finally {
      await adapter.dispose();
    }
  });

  test("refuses mismatched or retired Artifact authority before native admission", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "joko-claude-artifact-"));
    const path = join(workspace, "report.txt");
    await writeFile(path, "report");
    const blob = { id: "report", sha256: createHash("sha256").update("report").digest("hex"), byteLength: 6, mimeType: "text/plain" };
    const sourceSessionId = "artifact-source-session";
    let mode: "mismatch" | "retired" | "valid" = "mismatch";
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime, { resolveArtifactMention: async () => ({
      blob: mode === "mismatch" ? { ...blob, id: "different" } : blob, path,
      assertCurrent: () => { if (mode === "retired") throw new Error("Private authority details"); }
    }) });
    try {
      const binding = await adapter.createSession(createInput(), contextFor().context);
      const prompt = { ...textPrompt(""), mentions: [{
        kind: "artifact" as const,
        label: "report",
        reference: blob.id,
        sourceSessionId
      }] };
      await expect(adapter.send(prompt, contextFor(binding, { operationId: "mismatch" }).context))
        .rejects.toMatchObject({ publicError: { code: "ARTIFACT_REFERENCE_INVALID", stateMayHaveChanged: false } });
      mode = "retired";
      await expect(adapter.send(prompt, contextFor(binding, { operationId: "retired" }).context))
        .rejects.toMatchObject({ publicError: {
          code: "ARTIFACT_UNAVAILABLE",
          message: "The referenced Artifact changed in its source task while input was prepared.",
          stateMayHaveChanged: false
        } });
      expect(runtime.queries[0]!.receivedInputs).toEqual([]);
      mode = "valid";
      await adapter.send(prompt, contextFor(binding, { operationId: "valid" }).context);
      expect(runtime.queries[0]!.receivedInputs[0]!.message.content).toContain("Artifact reference:");
    } finally { await adapter.dispose(); await rm(workspace, { recursive: true, force: true }); }
  });

  test.each(["managed admission", "unread prompt", "unread steer"] as const)("withdraws an Artifact that is deleted while waiting for %s", async (waiting) => {
    const workspace = await mkdtemp(join(tmpdir(), "joko-claude-artifact-authority-"));
    const path = join(workspace, "report.txt");
    await writeFile(path, "report");
    const blob = { id: "report", sha256: createHash("sha256").update("report").digest("hex"), byteLength: 6, mimeType: "text/plain" };
    const sourceSessionId = "artifact-source-session";
    let deleted = false;
    const assertArtifactCurrent = vi.fn();
    const resolveArtifactMention: NonNullable<ClaudeCodeAdapterOptions["resolveArtifactMention"]> = async (
      _id,
      _sourceSessionId,
      _context,
      signal
    ) => ({
      blob, path, assertCurrent: () => {
        signal.throwIfAborted();
        assertArtifactCurrent();
        if (deleted) throw new Error("The canonical record was deleted.");
      }
    });
    const managed = managedProviderFixture();
    let finishActivation: (() => void) | undefined;
    const release = vi.fn();
    const port: ManagedProviderRuntimePort = { ...managed.port, prepare: async (owner) => ({
      ...await managed.port.prepare(owner), activate: async () => {
        await new Promise<void>((resolvePromise) => { finishActivation = resolvePromise; });
        return { release };
      }
    }) };
    const runtime = new FakeSdkRuntime({ pauseAfterFirstInput: waiting !== "managed admission", initialFrameOverrides: {
      ...(waiting === "managed admission" ? { model: "configured-model" } : {})
    } });
    const adapter = adapterFor(runtime, { resolveArtifactMention, ...(waiting === "managed admission" ? { managedProviders: port } : {}) });
    try {
      const selection = waiting === "managed admission" ? { providerId: "configured-provider", modelId: "configured-model" } : {};
      const binding = await adapter.createSession(createInput(selection), contextFor().context);
      const query = runtime.queries[0]!;
      const parent = contextFor(binding, { operationId: "first" });
      if (waiting !== "managed admission") {
        await adapter.send(textPrompt("Start"), parent.context);
        if (waiting === "unread prompt") {
          query.push(resultMessage(binding.nativeSessionId!, { result: "Done", totalCostUsd: 0 }));
          await eventually(() => parent.events.some((event) => event.type === "done"));
        }
      }
      const context = { ...contextFor(binding, { operationId: "artifact-input" }).context,
        ...(waiting === "managed admission" ? { modelSelection: { providerId: "configured-provider", modelId: "configured-model" } } : {}) };
      const sending = adapter.send({ ...textPrompt(""), ...(waiting === "unread steer" ? { disposition: "steer" as const } : {}),
        mentions: [{ kind: "artifact", label: "report", reference: blob.id, sourceSessionId }] }, context);
      const rejected = expect(sending).rejects.toMatchObject({ publicError: { code: "ARTIFACT_UNAVAILABLE", stateMayHaveChanged: false } });
      if (waiting === "managed admission") await vi.waitFor(() => expect(finishActivation).toBeTypeOf("function"));
      else await vi.waitFor(() => expect(assertArtifactCurrent).toHaveBeenCalled());
      deleted = true;
      if (waiting === "managed admission") finishActivation!();
      else query.resumeInputs();
      await rejected;
      expect(query.receivedInputs.map((entry) => entry.message.content)).toEqual(waiting === "managed admission" ? [] : ["Start"]);
      if (waiting === "managed admission") expect(release).toHaveBeenCalledOnce();
      if (waiting === "unread steer") {
        expect(query.closeCalls).toBe(0);
        query.push(resultMessage(binding.nativeSessionId!, { result: "Done", totalCostUsd: 0 }));
        await eventually(() => parent.events.some((event) => event.type === "done"));
        deleted = false;
        await adapter.send({ ...textPrompt(""), mentions: [{
          kind: "artifact",
          label: "report",
          reference: blob.id,
          sourceSessionId
        }] },
          contextFor(binding, { operationId: "current-artifact" }).context);
        expect(query.receivedInputs).toHaveLength(2);
      }
    } finally { await adapter.dispose(); await rm(workspace, { recursive: true, force: true }); }
  });

  test.each([
    ["missing reader", {}, "IMAGE_RESOLVER_MISSING"],
    ["unavailable artifact", { readBlob: async () => { throw new Error("private storage location"); } }, "IMAGE_UNAVAILABLE"],
    ["changed bytes", { readBlob: async () => ({ data: Buffer.from("changed") }) }, "IMAGE_INTEGRITY_FAILED"],
    ["changed media type", { readBlob: async () => ({ data: imageAttachment().data, mimeType: "image/jpeg" }) }, "IMAGE_TYPE_UNSUPPORTED"]
  ] as const)("rejects image %s before native admission and keeps the task reusable", async (_label, resolvers, code) => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime, resolvers);
    try {
      const binding = await adapter.createSession(createInput(), contextFor().context);
      const active = contextFor(binding, { operationId: "invalid-image" });
      await expect(adapter.send({ ...textPrompt(""), images: [{ blob: imageAttachment().blob }] }, active.context))
        .rejects.toMatchObject({ publicError: { code, stateMayHaveChanged: false } });
      expect(runtime.queries[0]!.receivedInputs).toEqual([]);
      await adapter.send(textPrompt("continue"), contextFor(binding, { operationId: "valid-text" }).context);
      expect(runtime.queries[0]!.receivedInputs[0]!.message.content).toBe("continue");
    } finally {
      await adapter.dispose();
    }
  });

  test("bounds image admission and rejects workspace escape before resolving native input", async () => {
    const runtime = new FakeSdkRuntime();
    const readBlob = vi.fn(async () => ({ data: imageAttachment().data }));
    const adapter = adapterFor(runtime, { readBlob });
    try {
      const descriptor = await adapter.describe();
      expect(descriptor.capabilities.get("input.file")?.supported).toBe(false);
      const binding = await adapter.createSession(createInput(), contextFor().context);
      const active = contextFor(binding, { operationId: "bounded-input" });
      await expect(adapter.send({
        ...textPrompt(""), images: [{ blob: { ...imageAttachment().blob, byteLength: 5 * 1024 * 1024 + 1 } }]
      }, active.context)).rejects.toMatchObject({ publicError: { code: "IMAGE_TOO_LARGE" } });
      expect(readBlob).not.toHaveBeenCalled();
      await expect(adapter.send({
        ...textPrompt(""), mentions: [{ kind: "workspace_file", label: "outside", reference: "../outside.txt" }]
      }, active.context)).rejects.toMatchObject({ publicError: { code: "WORKSPACE_PATH_DENIED" } });
      await expect(adapter.send({
        ...textPrompt(""), mentions: [{
          kind: "resource",
          label: "unknown",
          reference: "resource://unknown",
          discoveredRevision: "sha256:unknown",
          resourceVersion: "1",
          runtimeGeneration: 1
        }]
      }, active.context)).rejects.toMatchObject({ publicError: { code: "MENTION_KIND_UNSUPPORTED" } });
      expect(runtime.queries[0]!.receivedInputs).toEqual([]);
    } finally {
      await adapter.dispose();
    }
  });

  test("fences a late image preparation result after the native Session is closed", async () => {
    const runtime = new FakeSdkRuntime();
    let resolveImage!: (value: { readonly data: Uint8Array }) => void;
    const readBlob = vi.fn(() => new Promise<{ readonly data: Uint8Array }>((resolvePromise) => { resolveImage = resolvePromise; }));
    const adapter = adapterFor(runtime, { readBlob });
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const sending = adapter.send({ ...textPrompt(""), images: [{ blob: imageAttachment().blob }] }, contextFor(binding, { operationId: "late-image" }).context);
    const rejected = expect(sending).rejects.toMatchObject({ publicError: { code: "BACKEND_GENERATION_MISMATCH" } });
    await eventually(() => readBlob.mock.calls.length === 1);
    await adapter.closeSession(binding, contextFor(binding).context);
    resolveImage({ data: imageAttachment().data });
    await rejected;
    expect(runtime.queries[0]!.receivedInputs).toEqual([]);
    await adapter.dispose();
  });

  test("cancels input preparation before native admission and ignores a late attachment result", async () => {
    const runtime = new FakeSdkRuntime();
    let resolveImage!: (value: { readonly data: Uint8Array }) => void;
    const readBlob = vi.fn(() => new Promise<{ readonly data: Uint8Array }>((resolvePromise) => { resolveImage = resolvePromise; }));
    const adapter = adapterFor(runtime, { readBlob });
    try {
      const binding = await adapter.createSession(createInput(), contextFor().context);
      const sending = adapter.send({ ...textPrompt(""), images: [{ blob: imageAttachment().blob }] }, contextFor(binding, { operationId: "cancel-preparation" }).context);
      const rejected = expect(sending).rejects.toMatchObject({
        publicError: { code: "INPUT_PREPARATION_ABORTED", stateMayHaveChanged: false }
      });
      await eventually(() => readBlob.mock.calls.length === 1);
      await expect(adapter.inspectSession(binding, contextFor(binding).context)).resolves.toMatchObject({
        streaming: false, pendingMessages: 1
      });
      await expect(adapter.send(textPrompt("concurrent"), contextFor(binding, { operationId: "concurrent-input" }).context))
        .rejects.toMatchObject({ publicError: { code: "SESSION_BUSY" } });
      await expect(adapter.setModel("claude-code", "model-b", contextFor(binding).context))
        .rejects.toMatchObject({ publicError: { code: "SESSION_BUSY" } });
      await adapter.abort(contextFor(binding).context);
      await rejected;
      await expect(adapter.inspectSession(binding, contextFor(binding).context)).resolves.toMatchObject({
        streaming: false, pendingMessages: 0
      });
      resolveImage({ data: imageAttachment().data });
      expect(runtime.queries[0]!.receivedInputs).toEqual([]);
      expect(runtime.queries[0]!.interruptCalls).toBe(0);
      await adapter.send(textPrompt("continue"), contextFor(binding, { operationId: "after-cancel" }).context);
      expect(runtime.queries[0]!.receivedInputs.map((input) => input.message.content)).toEqual(["continue"]);
    } finally {
      await adapter.dispose();
    }
  });

  test("rejects altered file attachments and parent-directory links that escape the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "joko-claude-files-"));
    const originalWorkspace = `${workspace}-original`;
    const outside = await mkdtemp(join(tmpdir(), "joko-claude-outside-"));
    const workspaceTarget = { ...target, workspaceRoot: await realpath(workspace) };
    const file = join(workspaceTarget.workspaceRoot, "attachment.txt");
    await writeFile(file, "modified");
    await writeFile(join(outside, "outside.txt"), "outside");
    await symlink(outside, join(workspace, "linked-directory"), "junction");
    const runtime = new FakeSdkRuntime({ initialFrameOverrides: { cwd: workspaceTarget.workspaceRoot } });
    const adapter = adapterFor(runtime, { resolveFile: async () => file });
    try {
      const binding = await adapter.createSession(createInput({ target: workspaceTarget }), contextFor(undefined, { target: workspaceTarget }).context);
      const active = contextFor(binding, { target: workspaceTarget, operationId: "invalid-file" });
      await expect(adapter.send({
        ...textPrompt("Inspect"),
        files: [{ blob: { id: "file-artifact", sha256: createHash("sha256").update("original").digest("hex"), byteLength: 8, mimeType: "text/plain" } }]
      }, active.context)).rejects.toMatchObject({ publicError: { code: "FILE_INTEGRITY_FAILED" } });
      await expect(adapter.send({
        ...textPrompt("Inspect"),
        mentions: [{ kind: "workspace_file", label: "outside", reference: "linked-directory/outside.txt" }]
      }, active.context)).rejects.toMatchObject({ publicError: { code: "WORKSPACE_PATH_DENIED" } });
      for (const mention of [
        { kind: "workspace_directory", label: "linked", reference: "linked-directory" },
        { kind: "workspace_directory", label: "file", reference: "attachment.txt" },
        { kind: "workspace_file", label: "directory", reference: "." }
      ] as const) {
        await expect(adapter.send({ ...textPrompt("Inspect"), mentions: [mention] }, active.context))
          .rejects.toMatchObject({ publicError: { code: "FILE_UNSAFE" } });
      }
      for (const lineRange of [
        { startLine: 0, endLine: 1 },
        { startLine: 2, endLine: 1 },
        { startLine: 1, endLine: 1.5 },
        { startLine: 1, endLine: 0x1_0000_0000 }
      ]) {
        await expect(adapter.send({
          ...textPrompt("Inspect"),
          mentions: [{ kind: "workspace_file", label: "lines", reference: "attachment.txt", lineRange }]
        }, active.context)).rejects.toMatchObject({ publicError: { code: "WORKSPACE_LINE_RANGE_INVALID" } });
      }
      await rename(workspace, originalWorkspace);
      await symlink(outside, workspace, "junction");
      await expect(adapter.send({
        ...textPrompt("Inspect"),
        mentions: [{ kind: "workspace_file", label: "outside", reference: "outside.txt" }]
      }, active.context)).rejects.toMatchObject({ publicError: { code: "WORKSPACE_PATH_DENIED" } });
      expect(runtime.queries[0]!.receivedInputs).toEqual([]);
    } finally {
      await adapter.dispose();
      await rm(workspace, { recursive: true, force: true });
      await rm(originalWorkspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("derives authentication only from explicit account or credential evidence", async () => {
    const cases = [
      { account: { subscriptionType: "pro" }, apiKeySource: "none", expected: "authenticated" },
      { account: { tokenSource: "oauth" }, apiKeySource: "none", expected: "authenticated" },
      { account: { apiKeySource: "environment" }, apiKeySource: "none", expected: "authenticated" },
      { account: {}, apiKeySource: "environment", expected: "authenticated" },
      { account: { apiProvider: "external" }, apiKeySource: "none", expected: "not_required" },
      { account: { tokenSource: "unknown", apiKeySource: "none" }, apiKeySource: "", expected: "signed_out" }
    ] as const;

    for (const item of cases) {
      const runtime = new FakeSdkRuntime();
      runtime.probeInitialization = { ...initialization(), account: item.account };
      runtime.probeApiKeySource = item.apiKeySource;
      const descriptor = await adapterFor(runtime).describe();
      expect(descriptor.authenticationState).toBe(item.expected);
    }
  });

  test("composes only Adapter-safe Host capabilities without Backend branching", async () => {
    const adapter = adapterFor(new FakeSdkRuntime(), {
      hostCapabilities: ["workspace.files"]
    });

    const descriptor = await adapter.describe();

    expect(descriptor.capabilities.get("workspace.files")?.supported).toBe(true);
    expect(descriptor.capabilities.get("session.export")?.supported).toBe(false);
    expect(descriptor.capabilities.get("session.ai_rename")?.supported).toBe(false);
    expect(descriptor.capabilities.get("tool.browser")?.supported).toBe(false);
    expect(descriptor.capabilities.get("tool.computer")?.supported).toBe(false);
    expect(descriptor.capabilities.get("tool.android")?.supported).toBe(false);
    expect(descriptor.capabilities.get("workspace.extra_dirs")?.supported).toBe(true);
    expect(() => adapterFor(new FakeSdkRuntime(), {
      hostCapabilities: ["session.export" as never]
    })).toThrow("Claude Code Host-composed capability is invalid");
  });

  test("advertises native auto-memory and snapshots its effective value for each standard Query", async () => {
    let enabled = true;
    const resolveNativeMemoryEnabled = vi.fn(() => enabled);
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime, { resolveNativeMemoryEnabled });

    expect((await adapter.describe()).capabilities.get("memory.native")).toEqual({
      key: "memory.native",
      supported: true,
      options: ["reset_local"]
    });
    const binding = await adapter.createSession(createInput(), contextFor().context);
    expect(runtime.queries[0]!.params.options.settings).toMatchObject({
      autoMemoryEnabled: true,
      autoDreamEnabled: true
    });

    enabled = false;
    expect(runtime.queries[0]!.params.options.settings).toMatchObject({
      autoMemoryEnabled: true,
      autoDreamEnabled: true
    });
    await adapter.closeSession(binding, contextFor(binding).context);
    const resumedBinding = { ...binding, generation: 2 };
    await adapter.resumeSession(binding, contextFor(resumedBinding, { generation: 2 }).context);
    expect(runtime.queries[1]!.params.options.settings).toMatchObject({
      autoMemoryEnabled: false,
      autoDreamEnabled: false
    });
    expect(resolveNativeMemoryEnabled).toHaveBeenCalledTimes(2);
    await adapter.dispose();
  });

  test("reports and resets only regular native memory beneath the exact local profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-claude-native-memory-"));
    const configDirectory = join(root, "profile");
    const firstMemory = join(configDirectory, "projects", "first", "memory");
    const secondMemory = join(configDirectory, "projects", "second", "memory");
    const remoteResolve = vi.fn();
    const adapter = adapterFor(new FakeSdkRuntime(), {
      environment: { CLAUDE_CONFIG_DIR: configDirectory },
      resolveNativeMemoryEnabled: () => true,
      remoteRuntimes: { resolve: remoteResolve, close: async () => undefined }
    });
    try {
      await Promise.all([
        mkdir(join(firstMemory, "nested"), { recursive: true }),
        mkdir(secondMemory, { recursive: true })
      ]);
      await Promise.all([
        writeFile(join(firstMemory, "MEMORY.md"), "first"),
        writeFile(join(firstMemory, "notes.md"), "second"),
        writeFile(join(firstMemory, "ignored.txt"), "ignored"),
        writeFile(join(firstMemory, "nested", "ignored.md"), "nested"),
        writeFile(join(secondMemory, "topic.md"), "third"),
        writeFile(join(configDirectory, "projects", "first", "session.jsonl"), "history"),
        writeFile(join(configDirectory, "settings.json"), "settings")
      ]);

      expect((await adapter.describe()).capabilities.get("memory.native")).toEqual({
        key: "memory.native",
        supported: true,
        options: ["reset_local"]
      });
      await expect(adapter.readNativeMemoryStatus()).resolves.toEqual({
        entryCount: 3,
        sizeBytes: 16
      });
      await expect(adapter.resetNativeMemory()).resolves.toEqual({
        removedEntries: 3,
        removedTargets: 2
      });
      await expect(adapter.readNativeMemoryStatus()).resolves.toEqual({ entryCount: 0, sizeBytes: 0 });
      await expect(readFile(join(configDirectory, "projects", "first", "session.jsonl"), "utf8"))
        .resolves.toBe("history");
      await expect(readFile(join(configDirectory, "settings.json"), "utf8")).resolves.toBe("settings");
      expect(remoteResolve).not.toHaveBeenCalled();
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("treats a missing local profile as known empty memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-claude-native-memory-missing-"));
    const adapter = adapterFor(new FakeSdkRuntime(), {
      environment: { CLAUDE_CONFIG_DIR: join(root, "not-created") },
      resolveNativeMemoryEnabled: () => true
    });
    try {
      await expect(adapter.readNativeMemoryStatus()).resolves.toEqual({ entryCount: 0, sizeBytes: 0 });
      await expect(adapter.resetNativeMemory()).resolves.toEqual({ removedEntries: 0, removedTargets: 0 });
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an aliased native memory directory without following or deleting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-claude-native-memory-alias-"));
    const outside = await mkdtemp(join(tmpdir(), "joko-claude-native-memory-outside-"));
    const configDirectory = join(root, "profile");
    const projectDirectory = join(configDirectory, "projects", "project");
    const adapter = adapterFor(new FakeSdkRuntime(), {
      environment: { CLAUDE_CONFIG_DIR: configDirectory },
      resolveNativeMemoryEnabled: () => true
    });
    try {
      await mkdir(projectDirectory, { recursive: true });
      await writeFile(join(outside, "MEMORY.md"), "must remain");
      await symlink(outside, join(projectDirectory, "memory"), "junction");

      await expect(adapter.readNativeMemoryStatus()).rejects.toMatchObject({
        publicError: { code: "CLAUDE_NATIVE_MEMORY_PATH_UNSAFE", stateMayHaveChanged: false }
      });
      await expect(adapter.resetNativeMemory()).rejects.toMatchObject({
        publicError: { code: "CLAUDE_NATIVE_MEMORY_PATH_UNSAFE", stateMayHaveChanged: false }
      });
      await expect(readFile(join(outside, "MEMORY.md"), "utf8")).resolves.toBe("must remain");
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("rejects an aliased native memory project without following or deleting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-claude-native-project-alias-"));
    const outside = await mkdtemp(join(tmpdir(), "joko-claude-native-project-outside-"));
    const configDirectory = join(root, "profile");
    const adapter = adapterFor(new FakeSdkRuntime(), {
      environment: { CLAUDE_CONFIG_DIR: configDirectory },
      resolveNativeMemoryEnabled: () => true
    });
    try {
      await mkdir(join(configDirectory, "projects"), { recursive: true });
      await mkdir(join(outside, "memory"), { recursive: true });
      await writeFile(join(outside, "memory", "MEMORY.md"), "must remain");
      await symlink(outside, join(configDirectory, "projects", "project"), "junction");

      await expect(adapter.readNativeMemoryStatus()).rejects.toMatchObject({
        publicError: { code: "CLAUDE_NATIVE_MEMORY_PATH_UNSAFE", stateMayHaveChanged: false }
      });
      await expect(adapter.resetNativeMemory()).rejects.toMatchObject({
        publicError: { code: "CLAUDE_NATIVE_MEMORY_PATH_UNSAFE", stateMayHaveChanged: false }
      });
      await expect(readFile(join(outside, "memory", "MEMORY.md"), "utf8")).resolves.toBe("must remain");
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "a resolver failure",
      resolveNativeMemoryEnabled: () => { throw new Error("private-setting-failure"); },
      code: "NATIVE_MEMORY_SETTING_READ_FAILED"
    },
    {
      name: "an invalid resolver value",
      resolveNativeMemoryEnabled: () => "enabled" as never,
      code: "NATIVE_MEMORY_SETTING_INVALID"
    }
  ])("rejects $name before starting a native Query", async ({ resolveNativeMemoryEnabled, code }) => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime, { resolveNativeMemoryEnabled });

    await expect(adapter.createSession(createInput(), contextFor().context)).rejects.toMatchObject({
      publicError: { code, stateMayHaveChanged: false }
    });
    expect(runtime.queries).toEqual([]);
    await adapter.dispose();
  });

  test("runs isolated review only through the immutable native safe profile", async () => {
    const runtime = new FakeSdkRuntime();
    const resolveSubagentModel = vi.fn(() => "model-b");
    const resolveNativeMemoryEnabled = vi.fn(() => { throw new Error("Review must not read mutable Memory settings."); });
    const adapter = adapterFor(runtime, { resolveSubagentModel, resolveNativeMemoryEnabled });
    const descriptor = await adapter.describe();
    expect(descriptor.capabilities.get("review.isolated")).toEqual({
      key: "review.isolated",
      supported: true
    });

    const creation = contextFor(undefined, { runtimePolicy: "review_read_only" });
    const invalidReviewInputs: CreateNativeSessionInput[] = [createInput({
      runtimePolicy: "review_read_only",
      fastMode: true
    }), createInput({
      runtimePolicy: "review_read_only",
      nativeStart: { kind: "new", parentNativeReference: "claude-code:session:source" }
    }), createInput({
      runtimePolicy: "review_read_only",
      nativeStart: { kind: "attach", nativeReference: "claude-code:session:source" }
    }), createInput({
      runtimePolicy: "review_read_only",
      permissionMode: "auto"
    }), createInput({
      runtimePolicy: "review_read_only",
      appendSystemPrompt: "mutable reviewer instructions"
    })];
    for (const input of invalidReviewInputs) {
      await expect(adapter.createSession(input, creation.context)).rejects.toMatchObject({
        publicError: { code: "CLAUDE_CODE_REVIEW_PROFILE_INVALID" }
      });
    }
    await expect(adapter.createSession(createInput({ runtimePolicy: "review_read_only" }), contextFor().context))
      .rejects.toMatchObject({ publicError: { code: "CLAUDE_CODE_REVIEW_PROFILE_INVALID" } });

    const binding = await adapter.createSession(createInput({
      runtimePolicy: "review_read_only",
      permissionMode: "ask",
      nativeStart: { kind: "new" },
      modelId: "model-a",
      effort: "high"
    }), creation.context);
    const query = runtime.queries[0]!;
    expect(resolveSubagentModel).not.toHaveBeenCalled();
    expect(resolveNativeMemoryEnabled).not.toHaveBeenCalled();
    expect(query.params.options.env["CLAUDE_CODE_SUBAGENT_MODEL"]).toBeUndefined();
    expect(query.params.options.env["CLAUDE_CODE_SUBAGENT_MODEL_FORCE"]).toBeUndefined();
    expect(query.params.options).toMatchObject({
      additionalDirectories: [],
      agents: {},
      allowDangerouslySkipPermissions: false,
      disallowedTools: expect.arrayContaining(["Bash", "Write", "Edit", "Task", "mcp__*"]),
      extraArgs: {
        "safe-mode": null,
        "disable-slash-commands": null,
        "no-chrome": null
      },
      mcpServers: {},
      permissionMode: "default",
      persistSession: false,
      settingSources: [],
      settings: {
        allowedMcpServers: [],
        autoDreamEnabled: false,
        autoMemoryEnabled: false,
        disableAgentView: true,
        disableAllHooks: true,
        disableArtifact: true,
        disableBundledSkills: true,
        disableClaudeAiConnectors: true,
        disableRemoteControl: true,
        disableWorkflows: true,
        fastMode: false,
        includeGitInstructions: false,
        permissions: {
          additionalDirectories: [],
          defaultMode: "default",
          deny: expect.arrayContaining(["Read(**/.env)", "Read(**/.git/**)", "Read(**/node_modules/**)"]),
          disableBypassPermissionsMode: "disable"
        }
      },
      skills: [],
      strictMcpConfig: true,
      tools: ["Read", "Glob", "Grep"]
    });
    expect(query.params.options.forwardSubagentText).toBeUndefined();

    await expect(adapter.resumeSession(binding, contextFor(binding, {
      runtimePolicy: "review_read_only"
    }).context)).rejects.toMatchObject({
      publicError: { code: "CLAUDE_CODE_REVIEW_PROFILE_INVALID" }
    });
    const reviewTurn = contextFor(binding, {
      operationId: "isolated-review",
      runtimePolicy: "review_read_only"
    });
    const boundReview = reviewTurn.context;
    expect(adapter.supportsDetachedSessionDeletion(boundReview)).toBe(false);
    await expect(adapter.inspectSession(binding, boundReview)).resolves.toMatchObject({
      binding,
      permissionMode: "ask",
      fastMode: false
    });

    await adapter.send(textPrompt("Review the supplied evidence."), boundReview);
    expect(query.receivedInputs).toHaveLength(1);
    await expect(query.params.options.canUseTool(
      "Read",
      { file_path: process.cwd() },
      permissionOptions("review-read", "review-read-tool")
    )).resolves.toMatchObject({ behavior: "allow" });
    await expect(query.params.options.canUseTool(
      "Read",
      { file_path: resolve(process.cwd(), "..") },
      permissionOptions("review-outside", "review-outside-tool")
    )).resolves.toMatchObject({ behavior: "deny" });
    await expect(query.params.options.canUseTool(
      "Read",
      { file_path: resolve(process.cwd(), ".git", "config") },
      permissionOptions("review-sensitive", "review-sensitive-tool")
    )).resolves.toMatchObject({ behavior: "deny" });
    await expect(query.params.options.canUseTool(
      "Bash",
      { command: "git status" },
      permissionOptions("review-shell", "review-shell-tool")
    )).resolves.toMatchObject({ behavior: "deny" });

    query.push(resultMessage(binding.nativeSessionId!, { result: "No blocking findings.", totalCostUsd: 0 }));
    await eventually(() => reviewTurn.events.some((event) => event.type === "done"));
    const deniedControls: readonly (() => Promise<unknown>)[] = [
      () => adapter.setFastMode(true, boundReview),
      () => adapter.setFastMode(false, boundReview),
      () => adapter.setModel("claude-code", "model-b", boundReview),
      () => adapter.setEffort("low", boundReview),
      () => adapter.setPermissionMode("auto", boundReview),
      () => adapter.setPlanMode(true, boundReview),
      () => adapter.setExtraDirectories([{ id: "extra", path: process.cwd(), access: "read_write" }], boundReview),
      () => adapter.getNativeHistoryProjection(boundReview),
      () => adapter.clone(boundReview, { sessionId: "derived-review", target: boundReview.target, recordBinding: vi.fn() }),
      () => adapter.deleteSession(binding, boundReview)
    ];
    for (const operation of deniedControls) {
      await expect(operation()).rejects.toMatchObject({
        publicError: { code: "CLAUDE_CODE_REVIEW_OPERATION_DENIED" }
      });
    }

    const abortContext = contextFor(binding, {
      operationId: "isolated-review-abort",
      runtimePolicy: "review_read_only"
    }).context;
    await adapter.send(textPrompt("Check one more invariant."), abortContext);
    await expect(adapter.abort(abortContext)).resolves.toBeUndefined();
    expect(query.interruptCalls).toBe(1);
    await expect(adapter.closeSession(binding, contextFor(binding, {
      runtimePolicy: "review_read_only"
    }).context)).resolves.toBeUndefined();
    expect(query.closeCalls).toBe(1);
    expect(runtime.sessions.has(binding.nativeSessionId!)).toBe(true);
  });

  test("fails review admission when the native init frame exposes an isolated surface", async () => {
    const runtime = new FakeSdkRuntime({
      initialFrameOverrides: { mcp_servers: [{ name: "unexpected" }] }
    });
    const adapter = adapterFor(runtime, { admissionTimeoutMs: 50 });
    await adapter.describe();
    const creation = contextFor(undefined, { runtimePolicy: "review_read_only" });
    const binding = await adapter.createSession(createInput({
      runtimePolicy: "review_read_only"
    }), creation.context);

    await expect(adapter.send(textPrompt("Review."), contextFor(binding, {
      operationId: "unsafe-review-init",
      runtimePolicy: "review_read_only"
    }).context)).rejects.toMatchObject({
      publicError: { code: "CLAUDE_CODE_REVIEW_PROFILE_INVALID" }
    });
  });

  test("does not advertise isolated review for a native CLI below the safe-profile floor", async () => {
    const runtime = new FakeSdkRuntime();
    runtime.probeCliVersion = "2.1.238";
    const descriptor = await adapterFor(runtime).describe();
    expect(descriptor.capabilities.get("review.isolated")).toEqual({
      key: "review.isolated",
      supported: false,
      reason: "upstream_missing"
    });

    runtime.probeCliVersion = "2.1.240";
    const unauditedDescriptor = await adapterFor(runtime).describe();
    expect(unauditedDescriptor.capabilities.get("review.isolated")).toEqual({
      key: "review.isolated",
      supported: false,
      reason: "upstream_missing"
    });
    for (const key of ["background.tasks", "background.tasks.cancel", "subagents.list", "subagents.stop"]) {
      expect(descriptor.capabilities.get(key)).toEqual({ key, supported: false, reason: "upstream_missing" });
      expect(unauditedDescriptor.capabilities.get(key)).toEqual({ key, supported: false, reason: "upstream_missing" });
    }
  });

  test("keeps the configurable Backend instance ID separate from its Adapter kind", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = new ClaudeCodeAdapter({
      id: "claude-local-one",
      instanceGeneration: INSTANCE_GENERATION,
      runtime
    });
    const descriptor = await adapter.describe();
    expect(descriptor.id).toBe("claude-local-one");
    expect(descriptor.adapterKind).toBe("claude-agent-sdk-stdio");
    await expect(adapter.validateTarget(target)).rejects.toMatchObject({
      publicError: { code: "TARGET_BACKEND_MISMATCH" }
    });
    await expect(adapter.validateTarget({ ...target, backendId: "claude-local-one" })).resolves.toBeUndefined();
  });

  test("routes a remote Target through its exact runtime and rejects local path authority before native input", async () => {
    const remoteTarget: TargetDescriptor = {
      ...target,
      id: "target-remote",
      workspaceRoot: "D:\\service-owned-placeholder",
      remoteWorkspace: { hostId: "host-a", workspaceRoot: "/srv/project" }
    };
    const localRuntime = new FakeSdkRuntime();
    const remoteRuntime = new FakeSdkRuntime({ initialFrameOverrides: { cwd: "/srv/project" } });
    remoteRuntime.supportsWorkspaceDerivation = false;
    const nativeSessionId = randomUUID();
    remoteRuntime.sessions.set(nativeSessionId, {
      ...sessionInfo(nativeSessionId),
      cwd: "/srv/project"
    });
    let authorityCurrent = true;
    const close = vi.fn(async () => undefined);
    const resolveRemote = vi.fn(async () => ({
      runtime: remoteRuntime,
      workspaceRoot: "/srv/project",
      remote: true,
      assertCurrent: () => { if (!authorityCurrent) throw new Error("Remote authority changed."); }
    }));
    const remoteRuntimes: ClaudeRemoteRuntimePort = { resolve: resolveRemote, close };
    const resolveFile = vi.fn(async () => { throw new Error("Remote files must not resolve locally."); });
    const adapter = adapterFor(localRuntime, { remoteRuntimes, resolveFile });

    await adapter.validateTarget(remoteTarget);
    expect(resolveRemote).toHaveBeenCalledWith(remoteTarget, undefined);
    await expect(adapter.listNativeSessions(remoteTarget)).resolves.toEqual([
      expect.objectContaining({ nativeReference: `claude-code:session:${nativeSessionId}` })
    ]);
    expect(remoteRuntime.listOptions).toEqual([expect.objectContaining({ dir: "/srv/project" })]);
    expect(localRuntime.listOptions).toEqual([]);

    const binding = await adapter.createSession(
      createInput({ target: remoteTarget }),
      contextFor(undefined, { target: remoteTarget }).context
    );
    expect(remoteRuntime.queries[0]!.params.options.cwd).toBe("/srv/project");
    expect(localRuntime.queries).toEqual([]);
    const rejected = contextFor(binding, { target: remoteTarget, operationId: "remote-file" });
    await expect(adapter.send({
      ...textPrompt("Do not resolve this locally."),
      files: [{ blob: { id: "remote-file", sha256: "a".repeat(64), byteLength: 1, mimeType: "text/plain" } }]
    }, rejected.context)).rejects.toMatchObject({
      publicError: { code: "REMOTE_FILE_INPUT_UNSUPPORTED", stateMayHaveChanged: false }
    });
    expect(resolveFile).not.toHaveBeenCalled();
    expect(remoteRuntime.queries[0]!.receivedInputs).toEqual([]);

    const accepted = contextFor(binding, { target: remoteTarget, operationId: "remote-text" });
    await adapter.send(textPrompt("Run remotely."), accepted.context);
    expect(remoteRuntime.queries[0]!.receivedInputs[0]!.message.content).toBe("Run remotely.");
    remoteRuntime.queries[0]!.push(resultMessage(binding.nativeSessionId!, { result: "done", totalCostUsd: 0 }));
    await eventually(() => accepted.events.some((event) => event.type === "done"));

    authorityCurrent = false;
    await expect(adapter.send(textPrompt("Must not cross a stale lease."), contextFor(binding, {
      target: remoteTarget,
      operationId: "stale-remote"
    }).context)).rejects.toMatchObject({ publicError: { code: "BACKEND_GENERATION_MISMATCH" } });
    expect(remoteRuntime.queries[0]!.receivedInputs).toHaveLength(1);
    authorityCurrent = true;

    remoteRuntime.retirementFailure = true;
    await expect(adapter.closeSession(binding, contextFor(binding, { target: remoteTarget }).context))
      .rejects.toMatchObject({ publicError: { code: "REMOTE_QUERY_RETIREMENT_UNKNOWN", stateMayHaveChanged: true } });
    await expect(adapter.resumeSession(binding, contextFor(binding, { target: remoteTarget }).context))
      .rejects.toMatchObject({ publicError: { code: "BACKEND_GENERATION_MISMATCH" } });
    expect(remoteRuntime.queries).toHaveLength(1);
    remoteRuntime.retirementFailure = false;
    await adapter.closeSession(binding, contextFor(binding, { target: remoteTarget }).context);
    expect(remoteRuntime.retiredQueries).toEqual([remoteRuntime.queries[0], remoteRuntime.queries[0]]);
    await adapter.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  test("closes the remote runtime owner even when an SDK cleanup boundary fails", async () => {
    const runtime = new FakeSdkRuntime();
    runtime.closeSessionOperationsFailure = true;
    const close = vi.fn(async () => undefined);
    const adapter = adapterFor(runtime, {
      remoteRuntimes: {
        resolve: async () => {
          throw new Error("Unexpected remote runtime resolution.");
        },
        close
      }
    });

    await expect(adapter.dispose()).rejects.toThrow("The controlled Session SDK cleanup failed.");
    expect(runtime.closeSessionOperationsCalls).toBe(1);
    expect(close).toHaveBeenCalledOnce();
  });

  test("preserves an unknown remote Query start outcome when the manager generation changes", async () => {
    const remoteTarget: TargetDescriptor = {
      ...target,
      id: "target-remote-manager-replacement",
      workspaceRoot: "D:\\service-owned-placeholder",
      remoteWorkspace: { hostId: "host-a", workspaceRoot: "/srv/project" }
    };
    const runtime = new FakeSdkRuntime();
    runtime.queryFailure = Object.assign(new Error("manager generation changed"), {
      stateMayHaveChanged: true
    });
    const adapter = adapterFor(new FakeSdkRuntime(), {
      remoteRuntimes: {
        resolve: async () => ({
          runtime,
          workspaceRoot: "/srv/project",
          remote: true,
          assertCurrent: () => undefined
        }),
        close: async () => undefined
      }
    });

    await expect(adapter.createSession(
      createInput({ target: remoteTarget }),
      contextFor(undefined, { target: remoteTarget }).context
    )).rejects.toMatchObject({
      publicError: { code: "NATIVE_RUNTIME_START_FAILED", stateMayHaveChanged: true }
    });
    await adapter.dispose();
  });

  test("redacts probe diagnostics before they enter the Backend descriptor", async () => {
    const runtime = new FakeSdkRuntime({
      probeDiagnostic: "Bearer abcdefghijklmnopqrstuvwxyz and local-value"
    });
    const adapter = adapterFor(runtime, { redactValues: ["local-value"] });

    const descriptor = await adapter.describe();

    expect(descriptor.diagnostics.join("\n")).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(descriptor.diagnostics.join("\n")).not.toContain("local-value");
    expect(descriptor.diagnostics.join("\n")).toContain("[REDACTED]");
  });

  test("uses a bounded child environment for probes and Queries while redacting its sensitive values", async () => {
    const unrelatedName = "JOKO_CLAUDE_UNRELATED_TEST_VALUE";
    const originalUnrelated = process.env[unrelatedName];
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env[unrelatedName] = "ambient-value-must-not-cross";
    process.env.ANTHROPIC_API_KEY = "inherited-api-secret";
    const runtime = new FakeSdkRuntime({
      probeDiagnostic: "inherited-api-secret explicit-config-value ambient-value-must-not-cross"
    });
    const adapter = adapterFor(runtime, {
      environment: {
        JOKO_EXPLICIT_CONFIG: "explicit-config-value"
      }
    });

    try {
      const descriptor = await adapter.describe();
      const probeEnvironment = runtime.probeInputs[0]!.env;
      expect(probeEnvironment.ANTHROPIC_API_KEY).toBe("inherited-api-secret");
      expect(probeEnvironment.JOKO_EXPLICIT_CONFIG).toBe("explicit-config-value");
      expect(probeEnvironment.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("joko/0.1.0");
      expect(probeEnvironment[unrelatedName]).toBeUndefined();
      expect(descriptor.diagnostics.join("\n")).not.toContain("inherited-api-secret");
      expect(descriptor.diagnostics.join("\n")).not.toContain("explicit-config-value");
      expect(descriptor.diagnostics.join("\n")).toContain("ambient-value-must-not-cross");

      const binding = await adapter.createSession(createInput(), contextFor().context);
      expect(runtime.queries[0]!.params.options.env).toEqual(probeEnvironment);
      await adapter.closeSession(binding, contextFor(binding).context);
    } finally {
      await adapter.dispose();
      restoreEnvironment(unrelatedName, originalUnrelated);
      restoreEnvironment("ANTHROPIC_API_KEY", originalApiKey);
    }
  });

  test("starts one isolated streaming Query and confirms per-turn native identity only after input", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const creation = contextFor();

    const binding = await adapter.createSession(createInput({
      name: "SDK session",
      modelId: "model-a",
      effort: "high",
      permissionMode: "bypassPermissions"
    }), {
      ...creation.context,
      appendSystemPrompt: "Use the product workflow.",
      extraDirectories: [{ id: "workspace-again", path: process.cwd(), access: "read_write" }]
    });

    expect(binding.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(runtime.queries).toHaveLength(1);
    const query = runtime.queries[0]!;
    expect(query.params.options.sessionId).toBe(binding.nativeSessionId);
    expect(query.params.options.resume).toBeUndefined();
    expect(query.params.options.model).toBe("model-a");
    expect(query.params.options.effort).toBe("high");
    expect(query.params.options.permissionMode).toBe("bypassPermissions");
    expect(query.params.options.allowDangerouslySkipPermissions).toBe(true);
    expect(query.params.options.includePartialMessages).toBe(true);
    expect(query.params.options.forwardSubagentText).toBe(true);
    expect(query.params.options.persistSession).toBe(true);
    expect(query.params.options.settingSources).toEqual(["user", "project", "local"]);
    expect(query.params.options.settings).toMatchObject({ apiKeyHelper: "", fastMode: false });
    expect(query.params.options.additionalDirectories).toEqual([process.cwd()]);
    expect(query.params.options.systemPrompt.append).toBe("Use the product workflow.");
    expect(query.params.options.title).toBe("SDK session");
    expect(query.params.options.env["CLAUDE_AGENT_SDK_CLIENT_APP"]).toBe("joko/0.1.0");

    const beforeTurn = await adapter.describe();
    expect(beforeTurn.version).toBe(`sdk-${CLAUDE_AGENT_SDK_VERSION}+cli-2.1.259`);
    expect(beforeTurn.models.map((model) => model.modelId)).toEqual(["model-a", "model-b"]);
    expect(beforeTurn.tools).toEqual([]);

    const active = contextFor(binding, { operationId: "first-identity-proof" });
    await adapter.send(textPrompt("confirm the turn"), active.context);
    expect(query.receivedInputs).toHaveLength(1);
    const afterTurnStart = await adapter.describe();
    expect(afterTurnStart.version).toContain("cli-2.1.259");
    expect(afterTurnStart.tools.map((tool) => tool.name)).toEqual(["Bash", "Edit", "Read"]);
    query.push(resultMessage(binding.nativeSessionId!, { result: "done", totalCostUsd: 0 }));
    await eventually(() => active.events.some((event) => event.type === "done"));

    await adapter.closeSession(binding, contextFor(binding).context);
    expect(query.closeCalls).toBe(1);
    expect(query.params.options.abortController.signal.aborted).toBe(true);
    expect(query.interruptCalls).toBe(0);
  });

  test("keeps one Query across turns and translates partial, assistant, and Result authority", async () => {
    const runtime = new FakeSdkRuntime({ autoAdmitTurns: true });
    const adapter = adapterFor(runtime, { redactValues: ["super-secret"] });
    const creation = contextFor();
    const binding = await adapter.createSession(createInput(), creation.context);
    const first = contextFor(binding, { operationId: "operation-one" });

    await adapter.send(textPrompt("first"), first.context);
    await expect(adapter.send(textPrompt("overlap"), contextFor(binding, { operationId: "overlap" }).context))
      .rejects.toMatchObject({ publicError: { code: "SESSION_BUSY" } });
    const query = runtime.queries[0]!;
    query.push(streamEvent(binding.nativeSessionId!, { type: "message_start", message: { id: "m1" } }));
    query.push(streamEvent(binding.nativeSessionId!, {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    }));
    query.push(streamEvent(binding.nativeSessionId!, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "super-" }
    }));
    query.push(streamEvent(binding.nativeSessionId!, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "secret" }
    }));
    query.push(streamEvent(binding.nativeSessionId!, { type: "content_block_stop", index: 0 }));
    query.push(assistantMessage(binding.nativeSessionId!, "assistant-1", [
      { type: "text", text: "super-secret" },
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }
    ]));
    query.push(userToolResult(binding.nativeSessionId!, "tool-result-1", "tool-1", "file text", false));
    query.push(resultMessage(binding.nativeSessionId!, { result: "super-secret", totalCostUsd: 0.25 }));

    await eventually(() => first.events.some((event) => event.type === "done"));
    expect(first.events).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "[REDACTED]" }));
    expect(first.events).toContainEqual(expect.objectContaining({
      type: "tool_start",
      callId: "tool-1",
      name: "Read"
    }));
    expect(first.events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      callId: "tool-1",
      output: "file text",
      isError: false
    }));
    const complete = first.events.find((event) => event.type === "message_complete");
    expect(complete).toMatchObject({
      type: "message_complete",
      role: "assistant",
      generationDurationMs: 90,
      generationReliable: true
    });
    expect(JSON.stringify(complete)).not.toContain("super-secret");
    expect(first.events.at(-1)).toEqual({ type: "done", outcome: "completed" });

    const second = contextFor(binding, { operationId: "operation-two" });
    await adapter.send(textPrompt("second"), second.context);
    query.push(assistantMessage(binding.nativeSessionId!, "assistant-2", [{ type: "text", text: "second answer" }]));
    query.push(resultMessage(binding.nativeSessionId!, { result: "second answer", totalCostUsd: 0.4 }));
    await eventually(() => second.events.some((event) => event.type === "done"));
    expect(runtime.queries).toHaveLength(1);
    expect(query.receivedInputs.map((message) => message.message.content)).toEqual(["first", "second"]);

    await adapter.closeSession(binding, contextFor(binding).context);
  });

  test("projects native task lifecycle and child work without mixing child text into the parent turn", async () => {
    const runtime = new FakeSdkRuntime({ autoAdmitTurns: true });
    const adapter = adapterFor(runtime, { redactValues: ["task-secret"] });
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const active = contextFor(binding, { operationId: "native-delegated-task" });
    await adapter.send(textPrompt("delegate safely"), active.context);
    const query = runtime.queries[0]!;
    const rawTaskId = "native-task-raw-one";
    const parentToolUseId = "agent-tool-one";
    const childToolUseId = "child-read-one";

    query.push(assistantMessage(binding.nativeSessionId!, "parent-agent-tool", [{
      type: "tool_use",
      id: parentToolUseId,
      name: "Agent",
      input: { prompt: "inspect task-secret" }
    }]));
    query.push(childAssistantMessage(binding.nativeSessionId!, "child-before-start", parentToolUseId, [
      { type: "text", text: "child answer task-secret" },
      { type: "tool_use", id: childToolUseId, name: "Read", input: { file_path: "task-secret.txt" } }
    ], "child-model"));
    query.push(taskStarted(binding.nativeSessionId!, rawTaskId, parentToolUseId, {
      taskType: "local_agent",
      description: "Repository investigator",
      prompt: "Inspect task-secret"
    }));
    query.push(taskProgress(binding.nativeSessionId!, rawTaskId, parentToolUseId, {
      totalTokens: 33,
      toolUses: 1,
      durationMs: 250,
      lastToolName: "Read",
      summary: "Inspecting task-secret"
    }));
    query.push(childToolProgress(binding.nativeSessionId!, parentToolUseId, childToolUseId, "Read", 5));
    query.push(childUserToolResult(
      binding.nativeSessionId!,
      "child-tool-result",
      parentToolUseId,
      childToolUseId,
      "child tool output task-secret",
      false
    ));

    await eventually(() => active.events.some((event) => event.type === "subagent_transcript"));
    const runningTask = active.events.find((event): event is Extract<EventPayload, { type: "background_task" }> =>
      event.type === "background_task" && event.state === "running");
    expect(runningTask?.taskId).toMatch(/^claude-task-[a-f0-9]{32}$/);
    const publicTaskId = runningTask!.taskId;
    const runningRun = active.events.find((event): event is Extract<EventPayload, { type: "subagent_run" }> =>
      event.type === "subagent_run" && event.run.id === publicTaskId);
    const childId = runningRun?.run.children?.[0]?.id;
    expect(childId).toBe(`${publicTaskId}:child`);

    query.push(assistantMessage(binding.nativeSessionId!, "parent-finish", [{ type: "text", text: "parent answer" }]));
    const foregroundResult = resultMessage(binding.nativeSessionId!, { result: "parent answer", totalCostUsd: 0.2 });
    query.push(foregroundResult);
    query.push(foregroundResult);
    await eventually(() => active.events.some((event) => event.type === "usage"));
    expect(active.events.some((event) => event.type === "done")).toBe(false);
    query.push(taskNotification(binding.nativeSessionId!, rawTaskId, parentToolUseId, {
      status: "completed",
      summary: "Finished task-secret",
      outputFile: "C:\\private\\must-not-project.txt",
      totalTokens: 40,
      toolUses: 2,
      durationMs: 500
    }));
    await eventually(() => active.events.some((event) =>
      event.type === "background_task" && event.taskId === publicTaskId && event.state === "completed"));
    query.push(assistantMessage(binding.nativeSessionId!, "parent-continuation", [{
      type: "text",
      text: "continued parent answer"
    }]));
    query.push(resultMessage(binding.nativeSessionId!, { result: "continued parent answer", totalCostUsd: 0.3 }));
    await eventually(() => active.events.some((event) => event.type === "done"));

    const transcript = active.events
      .filter((event): event is Extract<EventPayload, { type: "subagent_transcript" }> =>
        event.type === "subagent_transcript" && event.subagentRunId === publicTaskId)
      .map((event) => event.entry);
    expect(transcript.map((entry) => [entry.role, entry.toolPhase])).toEqual(expect.arrayContaining([
      ["parent", undefined],
      ["subagent", undefined],
      ["tool", "start"],
      ["tool", "update"],
      ["tool", "end"],
      ["system", undefined]
    ]));
    const terminalRun = active.events
      .filter((event): event is Extract<EventPayload, { type: "subagent_run" }> =>
        event.type === "subagent_run" && event.run.id === publicTaskId)
      .at(-1)?.run;
    expect(terminalRun).toMatchObject({
      state: "completed",
      route: { providerId: "claude-code", modelId: "child-model" },
      usage: { totalTokens: 40, toolUses: 2, durationMs: 500 },
      returnedResult: "child answer [REDACTED]",
      capabilities: { stop: false, viewFullTranscript: true, parentContext: "live" }
    });
    const parentComplete = active.events.find((event) => event.type === "message_complete");
    expect(JSON.stringify(parentComplete)).not.toContain("child answer");
    expect(active.events.filter((event) => event.type === "message_complete")).toHaveLength(2);
    expect(active.events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(JSON.stringify(active.events)).not.toContain(rawTaskId);
    expect(JSON.stringify(active.events)).not.toContain("must-not-project.txt");
    expect(JSON.stringify(active.events)).not.toContain("task-secret");

    const beforeLateProgress = active.events.length;
    query.push(taskProgress(binding.nativeSessionId!, rawTaskId, parentToolUseId, {
      totalTokens: 99,
      toolUses: 9,
      durationMs: 999,
      summary: "late running frame"
    }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    expect(active.events).toHaveLength(beforeLateProgress);
    query.push(taskNotification(binding.nativeSessionId!, rawTaskId, parentToolUseId, {
      status: "failed",
      summary: "late terminal override",
      outputFile: "C:\\private\\late.txt",
      totalTokens: 100,
      toolUses: 10,
      durationMs: 1_000
    }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    expect(active.events).toHaveLength(beforeLateProgress);
    await adapter.cancelBackgroundTask(active.context, publicTaskId);
    expect(query.stopTaskCalls).toEqual([]);
    await adapter.closeSession(binding, contextFor(binding).context);
  });

  test.each([
    ["local_agent", true],
    ["local_workflow", true],
    ["local_bash", false],
    ["remote_agent", false]
  ] as const)("stops only model-backed native work before abort for %s", async (taskType, stopped) => {
    const runtime = new FakeSdkRuntime({ autoAdmitTurns: true });
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const active = contextFor(binding, { operationId: `abort-${taskType}` });
    await adapter.send(textPrompt("start work"), active.context);
    const query = runtime.queries[0]!;
    const toolUseId = `tool-${taskType}`;
    query.push(assistantMessage(binding.nativeSessionId!, `assistant-${taskType}`, [{
      type: "tool_use",
      id: toolUseId,
      name: taskType === "local_agent" ? "Agent" : "Bash",
      input: {}
    }]));
    query.push(taskStarted(binding.nativeSessionId!, `task-${taskType}`, toolUseId, {
      taskType,
      description: taskType
    }));
    await eventually(() => active.events.some((event) => event.type === "background_task"));

    await adapter.abort(active.context);

    expect(query.stopTaskCalls).toEqual(stopped ? [`task-${taskType}`] : []);
    expect(query.interruptCalls).toBe(1);
    await adapter.closeSession(binding, contextFor(binding).context);
  });

  test("confirms an explicit wake-task stop without waiting for a provider echo", async () => {
    const runtime = new FakeSdkRuntime({ autoAdmitTurns: true });
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const active = contextFor(binding, { operationId: "stop-awaiting-native-task" });
    await adapter.send(textPrompt("start delegated work"), active.context);
    const query = runtime.queries[0]!;
    const rawTaskId = "wake-task-without-stop-echo";
    const toolUseId = "wake-tool-without-stop-echo";
    query.push(assistantMessage(binding.nativeSessionId!, "wake-parent-tool", [{
      type: "tool_use",
      id: toolUseId,
      name: "Agent",
      input: { prompt: "inspect" }
    }]));
    query.push(taskStarted(binding.nativeSessionId!, rawTaskId, toolUseId, {
      taskType: "local_agent",
      description: "Inspector"
    }));
    await eventually(() => active.events.some((event) => event.type === "background_task"));
    const publicTaskId = active.events.find((event): event is Extract<EventPayload, { type: "background_task" }> =>
      event.type === "background_task")!.taskId;
    query.push(resultMessage(binding.nativeSessionId!, { result: "Waiting for delegated work", totalCostUsd: 0.1 }));
    await eventually(() => active.events.some((event) => event.type === "usage"));
    expect(active.events.some((event) => event.type === "done")).toBe(false);

    await adapter.controlSubagent({
      runId: publicTaskId,
      childId: `${publicTaskId}:child`,
      action: "stop"
    }, active.context);

    await eventually(() => active.events.some((event) => event.type === "done"));
    expect(query.stopTaskCalls).toEqual([rawTaskId]);
    expect(active.events.filter((event) => event.type === "done")).toEqual([{ type: "done", outcome: "completed" }]);
    expect(active.events.filter((event): event is Extract<EventPayload, { type: "background_task" }> =>
      event.type === "background_task" && event.taskId === publicTaskId).at(-1)).toMatchObject({ state: "aborted" });
    await adapter.cancelBackgroundTask(active.context, publicTaskId);
    expect(query.stopTaskCalls).toEqual([rawTaskId]);
    await adapter.closeSession(binding, contextFor(binding).context);
  });

  test("settles a completed workflow when its automatic continuation never arrives", async () => {
    const runtime = new FakeSdkRuntime({ autoAdmitTurns: true });
    const adapter = adapterFor(runtime, { nativeContinuationGraceMs: 10 });
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const active = contextFor(binding, { operationId: "missing-workflow-continuation" });
    await adapter.send(textPrompt("run workflow"), active.context);
    const query = runtime.queries[0]!;
    const rawTaskId = "workflow-without-continuation";
    const toolUseId = "workflow-tool";
    query.push(assistantMessage(binding.nativeSessionId!, "workflow-parent-tool", [{
      type: "tool_use",
      id: toolUseId,
      name: "Bash",
      input: { command: "workflow" }
    }]));
    query.push(taskStarted(binding.nativeSessionId!, rawTaskId, toolUseId, {
      taskType: "local_workflow",
      description: "Workflow"
    }));
    query.push(resultMessage(binding.nativeSessionId!, { result: "Workflow is running", totalCostUsd: 0.1 }));
    await eventually(() => active.events.some((event) => event.type === "usage"));
    expect(active.events.some((event) => event.type === "done")).toBe(false);
    query.push(taskNotification(binding.nativeSessionId!, rawTaskId, toolUseId, {
      status: "completed",
      summary: "Workflow completed",
      outputFile: "C:\\private\\workflow.txt",
      totalTokens: 20,
      toolUses: 1,
      durationMs: 200
    }));

    await eventually(() => active.events.some((event) => event.type === "done"));
    expect(active.events.filter((event) => event.type === "done")).toEqual([{ type: "done", outcome: "completed" }]);
    await adapter.closeSession(binding, contextFor(binding).context);
  });

  test("globally stops an awaiting workflow and closes the product turn as aborted", async () => {
    const runtime = new FakeSdkRuntime({ autoAdmitTurns: true });
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const active = contextFor(binding, { operationId: "abort-awaiting-workflow" });
    await adapter.send(textPrompt("start a workflow"), active.context);
    const query = runtime.queries[0]!;
    const rawTaskId = "workflow-stopped-globally";
    const toolUseId = "workflow-global-tool";
    query.push(taskStarted(binding.nativeSessionId!, rawTaskId, toolUseId, {
      taskType: "local_workflow",
      description: "Long workflow"
    }));
    query.push(resultMessage(binding.nativeSessionId!, { result: "Workflow is still running", totalCostUsd: 0.1 }));
    await eventually(() => active.events.some((event) => event.type === "usage"));
    expect(active.events.some((event) => event.type === "done")).toBe(false);

    await adapter.abort(active.context);

    expect(query.stopTaskCalls).toEqual([rawTaskId]);
    expect(query.interruptCalls).toBe(1);
    expect(active.events.filter((event) => event.type === "done")).toEqual([{ type: "done", outcome: "aborted" }]);
    await adapter.closeSession(binding, contextFor(binding).context);
  });

  test("measures parent-only generation time when a child stream is present", async () => {
    const ticks = [100, 200];
    const runtime = new FakeSdkRuntime({ autoAdmitTurns: true });
    const adapter = adapterFor(runtime, { now: () => ticks.shift() ?? 200 });
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const active = contextFor(binding, { operationId: "parent-generation-only" });
    await adapter.send(textPrompt("measure"), active.context);
    const query = runtime.queries[0]!;
    query.push(streamEvent(binding.nativeSessionId!, {
      type: "message_start",
      message: {
        id: "message-parent-stream",
        usage: {
          input_tokens: 11,
          output_tokens: 0,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2
        }
      }
    }));
    query.push(streamEvent(binding.nativeSessionId!, {
      type: "message_delta",
      usage: { output_tokens: 7 }
    }));
    query.push(streamEvent(binding.nativeSessionId!, { type: "message_stop" }));
    query.push(childStreamEvent(binding.nativeSessionId!, "unmapped-agent-tool", {
      type: "message_start",
      message: { id: "child-stream", usage: { input_tokens: 100, output_tokens: 0 } }
    }));
    query.push(assistantMessage(binding.nativeSessionId!, "parent-stream", [{ type: "text", text: "parent" }]));
    query.push(resultMessage(binding.nativeSessionId!, { result: "parent", totalCostUsd: 1 }));

    await eventually(() => active.events.some((event) => event.type === "done"));
    expect(active.events.find((event) => event.type === "message_complete")).toMatchObject({
      type: "message_complete",
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalTokens: 18,
        cost: 0
      },
      generationDurationMs: 100,
      generationReliable: true
    });
    await adapter.closeSession(binding, contextFor(binding).context);
  });

  test.each([
    ["missing origin", { origin: null }],
    ["non-human origin", { origin: { kind: "peer", from: "another-session" } }],
    ["missing user UUID", { origin: { kind: "human" }, user_message_uuid: null }],
    ["mismatched user UUID", { origin: { kind: "human" }, user_message_uuid: randomUUID() }]
  ])("fails closed when a Result has %s", async (_label, ownership) => {
    const runtime = new FakeSdkRuntime({ autoAdmitTurns: true });
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const active = contextFor(binding, { operationId: `ownership-${_label}` });
    await adapter.send(textPrompt("owned turn"), active.context);
    const query = runtime.queries[0]!;

    query.push({
      ...resultMessage(binding.nativeSessionId!, { result: "must not project", totalCostUsd: 0 }),
      ...ownership
    });

    await eventually(() => active.events.some((event) => event.type === "done"));
    expect(active.events).toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ code: "NATIVE_TURN_OWNERSHIP_GAP" }),
      terminal: true
    }));
    expect(active.events.filter((event) => event.type === "done")).toEqual([
      { type: "done", outcome: "failed" }
    ]);
    expect(query.closeCalls).toBe(1);
  });

  test("emits one terminal boundary when the native stream repeats a Result", async () => {
    const runtime = new FakeSdkRuntime({ autoAdmitTurns: true });
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const active = contextFor(binding, { operationId: "duplicate-result" });
    await adapter.send(textPrompt("once"), active.context);
    const query = runtime.queries[0]!;
    const result = resultMessage(binding.nativeSessionId!, { result: "once", totalCostUsd: 0 });

    query.push(result);
    query.push({ ...result, uuid: randomUUID() });

    await eventually(() => active.events.some((event) => event.type === "done"));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    expect(active.events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(active.events.filter((event) => event.type === "message_complete")).toHaveLength(1);
    await adapter.closeSession(binding, contextFor(binding).context);
  });

  test("rejects an unknown future permission mode before admitting turn output", async () => {
    const runtime = new FakeSdkRuntime({ initialPermissionMode: "future-mode" });
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const active = contextFor(binding, { operationId: "unknown-permission-mode" });

    await expect(adapter.send(textPrompt("must fail closed"), active.context)).rejects.toMatchObject({
      publicError: { code: "NATIVE_PERMISSION_MODE_UNSUPPORTED" }
    });
    expect(active.events).toEqual([]);
    expect(runtime.queries[0]!.closeCalls).toBe(1);
  });

  test("bounds prompt and streamed content retained by the Adapter", async () => {
    const runtime = new FakeSdkRuntime({ autoAdmitTurns: true });
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    await expect(adapter.send(
      textPrompt("x".repeat(1024 * 1024 + 1)),
      contextFor(binding, { operationId: "oversized-input" }).context
    )).rejects.toMatchObject({ publicError: { code: "PROMPT_TOO_LARGE" } });
    const active = contextFor(binding, { operationId: "bounded-stream" });
    await adapter.send(textPrompt("bounded"), active.context);
    const query = runtime.queries[0]!;
    query.push(streamEvent(binding.nativeSessionId!, { type: "message_start", message: { id: "bounded" } }));
    query.push(streamEvent(binding.nativeSessionId!, {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    }));
    query.push(streamEvent(binding.nativeSessionId!, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "z".repeat(128 * 1024) }
    }));
    query.push(streamEvent(binding.nativeSessionId!, { type: "content_block_stop", index: 0 }));
    query.push(resultMessage(binding.nativeSessionId!, { result: "done", totalCostUsd: 0 }));

    await eventually(() => active.events.some((event) => event.type === "done"));
    const delta = active.events.find((event) => event.type === "text_delta");
    expect(delta).toMatchObject({ type: "text_delta" });
    expect(delta?.type === "text_delta" ? delta.delta.length : 0).toBeLessThanOrEqual(64 * 1024);
    expect(delta?.type === "text_delta" ? delta.delta : "").toContain("[Truncated]");
    await adapter.closeSession(binding, contextFor(binding).context);
  });

  test("retires a native stream that exceeds the per-message content-block limit", async () => {
    const runtime = new FakeSdkRuntime({ autoAdmitTurns: true });
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const active = contextFor(binding, { operationId: "event-limit" });
    await adapter.send(textPrompt("many blocks"), active.context);
    const query = runtime.queries[0]!;
    query.push(assistantMessage(
      binding.nativeSessionId!,
      "too-many-blocks",
      Array.from({ length: 257 }, () => ({ type: "text", text: "x" }))
    ));

    await eventually(() => active.events.some((event) => event.type === "done"));
    expect(active.events).toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ code: "NATIVE_EVENT_LIMIT_EXCEEDED" })
    }));
    expect(query.closeCalls).toBe(1);
  });

  test("fails an unprovable resume as a continuity gap without starting fresh", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const nativeSessionId = randomUUID();
    const binding: NativeSessionBinding = {
      opaqueRef: `claude-code:session:${nativeSessionId}`,
      nativeSessionId,
      generation: 1
    };

    await expect(adapter.resumeSession(binding, contextFor(binding).context)).rejects.toMatchObject({
      publicError: {
        code: "NATIVE_SESSION_CONTINUITY_GAP",
        stateMayHaveChanged: false
      }
    });
    expect(runtime.queries).toHaveLength(0);
  });

  test("attaches with safe resume options without applying new-task model or permission defaults", async () => {
    const nativeSessionId = randomUUID();
    const runtime = new FakeSdkRuntime();
    runtime.sessions.set(nativeSessionId, sessionInfo(nativeSessionId));
    const adapter = adapterFor(runtime);
    const untrustedTarget = { ...target, trusted: false };
    const creation = contextFor(undefined, { target: untrustedTarget }).context;

    const binding = await adapter.createSession(createInput({
      target: untrustedTarget,
      nativeStart: { kind: "attach", nativeReference: `claude-code:session:${nativeSessionId}` },
      providerId: "stale-provider",
      modelId: "stale-model",
      effort: "stale-effort",
      fastMode: true,
      permissionMode: "bypassPermissions",
      appendSystemPrompt: "must not change an existing native task"
    }), {
      ...creation,
      appendSystemPrompt: "must also be ignored while attaching"
    });

    expect(runtime.queries).toHaveLength(1);
    expect(runtime.queries[0]!.params.options).toMatchObject({
      resume: nativeSessionId,
      permissionMode: "default"
    });
    expect(runtime.queries[0]!.params.options.model).toBeUndefined();
    expect(runtime.queries[0]!.params.options.effort).toBeUndefined();
    expect(runtime.queries[0]!.params.options.systemPrompt.append).toBeUndefined();
    const state = await adapter.inspectSession(binding, { ...creation, binding });
    expect(state).toMatchObject({
      providerId: "claude-code",
      permissionMode: "ask",
      fastMode: false
    });
    expect(state.modelId).toBeUndefined();
    expect(state.effort).toBeUndefined();
    await adapter.closeSession(binding, { ...creation, binding });
  });

  test("uses resume only and rejects a mismatched per-turn system/init identity", async () => {
    const nativeSessionId = randomUUID();
    const runtime = new FakeSdkRuntime({ initialSessionIdOverride: randomUUID() });
    runtime.sessions.set(nativeSessionId, sessionInfo(nativeSessionId));
    const adapter = adapterFor(runtime);
    const binding: NativeSessionBinding = {
      opaqueRef: `claude-code:session:${nativeSessionId}`,
      nativeSessionId,
      generation: 1
    };

    await expect(adapter.resumeSession(binding, contextFor(binding).context)).resolves.toMatchObject({
      binding
    });
    await expect(adapter.send(
      textPrompt("prove the resumed identity"),
      contextFor(binding, { operationId: "mismatched-resume-init" }).context
    )).rejects.toMatchObject({
      publicError: { code: "NATIVE_SESSION_CONTINUITY_GAP" }
    });
    expect(runtime.queries).toHaveLength(1);
    expect(runtime.queries[0]!.params.options.resume).toBe(nativeSessionId);
    expect(runtime.queries[0]!.params.options.sessionId).toBeUndefined();
  });

  test("marks consumed-but-unconfirmed dispatch admission as stateMayHaveChanged", async () => {
    const runtime = new FakeSdkRuntime({ autoAdmitTurns: false });
    const adapter = adapterFor(runtime, { admissionTimeoutMs: 25 });
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const query = runtime.queries[0]!;

    await expect(adapter.send(textPrompt("uncertain"), contextFor(binding, { operationId: "uncertain" }).context))
      .rejects.toMatchObject({
        publicError: {
          code: "NATIVE_DISPATCH_UNKNOWN",
          stateMayHaveChanged: true
        }
      });
    expect(query.receivedInputs).toHaveLength(1);
    expect(query.params.options.abortController.signal.aborted).toBe(true);
    expect(query.closeCalls).toBe(1);
    expect(query.interruptCalls).toBe(0);
  });

  test("resumes the Host's previous binding into the exact next product generation", async () => {
    const nativeSessionId = randomUUID();
    const runtime = new FakeSdkRuntime();
    runtime.sessions.set(nativeSessionId, sessionInfo(nativeSessionId));
    const adapter = adapterFor(runtime);
    const previousBinding: NativeSessionBinding = {
      opaqueRef: `claude-code:session:${nativeSessionId}`,
      nativeSessionId,
      generation: 1
    };
    const currentBinding = { ...previousBinding, generation: 2 };
    const current = {
      ...contextFor(currentBinding, { generation: 2 }).context,
      appendSystemPrompt: "Preserve this immutable runtime launch policy."
    };

    await expect(adapter.resumeSession(previousBinding, current)).resolves.toMatchObject({
      binding: currentBinding
    });
    expect(runtime.queries).toHaveLength(1);
    expect(runtime.queries[0]!.params.options.resume).toBe(nativeSessionId);
    expect(runtime.queries[0]!.params.options.sessionId).toBeUndefined();
    expect(runtime.queries[0]!.params.options.systemPrompt.append)
      .toBe("Preserve this immutable runtime launch policy.");

    await adapter.closeSession(currentBinding, current);
    const skippedGenerationBinding = { ...previousBinding, generation: 3 };
    await expect(adapter.resumeSession(
      previousBinding,
      contextFor(skippedGenerationBinding, { generation: 3 }).context
    )).rejects.toMatchObject({ publicError: { code: "SESSION_GENERATION_MISMATCH" } });
    expect(runtime.queries).toHaveLength(1);
  });

  test("rejects a next-generation resume when the current binding changes native identity", async () => {
    const nativeSessionId = randomUUID();
    const runtime = new FakeSdkRuntime();
    runtime.sessions.set(nativeSessionId, sessionInfo(nativeSessionId));
    const adapter = adapterFor(runtime);
    const previousBinding: NativeSessionBinding = {
      opaqueRef: `claude-code:session:${nativeSessionId}`,
      nativeSessionId,
      generation: 1
    };
    const otherNativeSessionId = randomUUID();
    const forgedCurrentBinding: NativeSessionBinding = {
      opaqueRef: `claude-code:session:${otherNativeSessionId}`,
      nativeSessionId: otherNativeSessionId,
      generation: 2
    };

    await expect(adapter.resumeSession(
      previousBinding,
      contextFor(forgedCurrentBinding, { generation: 2 }).context
    )).rejects.toMatchObject({ publicError: { code: "NATIVE_SESSION_CONTINUITY_GAP" } });
    expect(runtime.queries).toHaveLength(0);
  });

  test("rejects a next-generation resume whose native metadata belongs to another Target", async () => {
    const nativeSessionId = randomUUID();
    const runtime = new FakeSdkRuntime();
    runtime.sessions.set(nativeSessionId, {
      ...sessionInfo(nativeSessionId),
      cwd: `${process.cwd()}-other`
    });
    const adapter = adapterFor(runtime);
    const previousBinding: NativeSessionBinding = {
      opaqueRef: `claude-code:session:${nativeSessionId}`,
      nativeSessionId,
      generation: 1
    };
    const currentBinding = { ...previousBinding, generation: 2 };

    await expect(adapter.resumeSession(
      previousBinding,
      contextFor(currentBinding, { generation: 2 }).context
    )).rejects.toMatchObject({ publicError: { code: "NATIVE_SESSION_CONTINUITY_GAP" } });
    expect(runtime.queries).toHaveLength(0);
  });

  test("discovers only bounded native Sessions proven to belong to the exact Target", async () => {
    const runtime = new FakeSdkRuntime();
    const firstId = randomUUID();
    const secondId = randomUUID();
    runtime.sessions.set(firstId, {
      ...sessionInfo(firstId),
      summary: "older",
      lastModified: 10
    });
    runtime.sessions.set(secondId, {
      ...sessionInfo(secondId),
      customTitle: "newer",
      lastModified: 20
    });
    runtime.sessions.set(randomUUID(), {
      ...sessionInfo(randomUUID()),
      cwd: `${process.cwd()}-other`,
      lastModified: 30
    });
    runtime.sessions.set("invalid", {
      ...sessionInfo("invalid"),
      lastModified: 40
    });
    const adapter = adapterFor(runtime, { maximumDiscoveredSessions: 4 });

    const candidates = await adapter.listNativeSessions(target);

    expect(runtime.listOptions).toEqual([{
      dir: process.cwd(),
      limit: 4,
      offset: 0,
      includeWorktrees: false,
      includeProgrammatic: true
    }]);
    expect(candidates).toEqual([
      expect.objectContaining({ nativeSessionId: secondId, name: "newer", modifiedAt: 20 }),
      expect.objectContaining({ nativeSessionId: firstId, name: "older", modifiedAt: 10 })
    ]);
    expect(candidates.every((candidate) => candidate.workspaceRoot === process.cwd())).toBe(true);
  });

  test("projects bounded public SDK history with stable lineage, redaction, and typed placeholders", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime, { redactValues: ["history-secret"] });
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const nativeSessionId = binding.nativeSessionId!;
    const userId = randomUUID();
    const assistantId = randomUUID();
    const childAssistantId = randomUUID();
    const toolResultId = randomUUID();
    const systemId = randomUUID();
    runtime.messages.set(nativeSessionId, [
      historyMessage("user", userId, nativeSessionId, {
        role: "user",
        content: [{ type: "text", text: "question history-secret" }]
      }),
      historyMessage("assistant", assistantId, nativeSessionId, {
        role: "assistant",
        content: [
          { type: "text", text: "answer history-secret" },
          { type: "thinking", thinking: "reason history-secret" },
          { type: "redacted_thinking", data: "must-not-project" },
          { type: "tool_use", id: "tool-history", name: "Read", input: { path: "history-secret" } }
        ]
      }),
      {
        ...historyMessage("assistant", childAssistantId, nativeSessionId, {
          role: "assistant",
          content: [{ type: "text", text: "child-only-history" }]
        }),
        parent_tool_use_id: "tool-history"
      },
      historyMessage("user", toolResultId, nativeSessionId, {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-history",
          content: "output history-secret",
          is_error: false
        }]
      }),
      historyMessage("system", systemId, nativeSessionId, { raw: "history-secret" })
    ]);
    const bound = contextFor(binding).context;

    const first = await adapter.getNativeHistoryProjection(bound);
    const second = await adapter.getNativeHistoryProjection(bound);

    expect(first).toEqual(second);
    expect(runtime.messageOptions[0]).toEqual({
      sessionId: nativeSessionId,
      options: {
        dir: process.cwd(),
        limit: 10_001,
        offset: 0,
        includeSystemMessages: true
      }
    });
    expect(runtime.messageOptions).toHaveLength(2);
    expect(first.activeEntryId).toBe(systemId);
    expect(first.activeLineage).toEqual([
      { entryId: userId },
      { entryId: assistantId, parentEntryId: userId },
      { entryId: toolResultId, parentEntryId: assistantId },
      { entryId: systemId, parentEntryId: toolResultId }
    ]);
    expect(first.events.map((event) => event.payload.type)).toEqual([
      "message_complete",
      "text_delta",
      "thinking_delta",
      "tool_start",
      "message_complete",
      "tool_result",
      "status"
    ]);
    expect(first.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nativeEntryId: toolResultId,
        payload: expect.objectContaining({
          type: "tool_result",
          callId: "tool-history",
          name: "Read",
          output: "output [REDACTED]"
        })
      }),
      expect.objectContaining({
        nativeEntryId: systemId,
        payload: {
          type: "status",
          key: "claude-code.history.system",
          text: "Native system event preserved."
        }
      })
    ]));
    expect(JSON.stringify(first)).not.toContain("history-secret");
    expect(JSON.stringify(first)).not.toContain("must-not-project");
    expect(JSON.stringify(first)).not.toContain("child-only-history");
    await adapter.closeSession(binding, bound);
  });

  test("fails native history closed across generation, Target, session identity, and bounds", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const nativeSessionId = binding.nativeSessionId!;
    const valid = historyMessage("user", randomUUID(), nativeSessionId, {
      role: "user",
      content: "bounded"
    });
    runtime.messages.set(nativeSessionId, [{ ...valid, session_id: randomUUID() }]);

    await expect(adapter.getNativeHistoryProjection(contextFor(binding).context)).rejects.toMatchObject({
      publicError: { code: "NATIVE_SESSION_CONTINUITY_GAP" }
    });
    await expect(adapter.getNativeHistoryProjection(contextFor(binding, { generation: 2 }).context)).rejects.toMatchObject({
      publicError: { code: "BACKEND_GENERATION_MISMATCH" }
    });

    runtime.sessions.set(nativeSessionId, { ...sessionInfo(nativeSessionId), cwd: `${process.cwd()}-other` });
    await expect(adapter.getNativeHistoryProjection(contextFor(binding).context)).rejects.toMatchObject({
      publicError: { code: "NATIVE_SESSION_CONTINUITY_GAP" }
    });

    runtime.sessions.set(nativeSessionId, sessionInfo(nativeSessionId));
    runtime.messages.set(nativeSessionId, Array.from({ length: 10_001 }, () => valid));
    await expect(adapter.getNativeHistoryProjection(contextFor(binding).context)).rejects.toMatchObject({
      publicError: { code: "NATIVE_HISTORY_LIMIT_EXCEEDED" }
    });
    await adapter.closeSession(binding, contextFor(binding).context);
  });

  test("requires a trusted Target for every full-access entry point", async () => {
    const untrustedTarget = { ...target, trusted: false };
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);

    await expect(adapter.createSession(
      createInput({ target: untrustedTarget, permissionMode: "bypassPermissions" }),
      contextFor(undefined, { target: untrustedTarget }).context
    )).rejects.toMatchObject({
      publicError: { code: "CLAUDE_CODE_FULL_ACCESS_REQUIRES_TRUST" }
    });
    expect(runtime.queries).toHaveLength(0);

    const binding = await adapter.createSession(
      createInput({ target: untrustedTarget }),
      contextFor(undefined, { target: untrustedTarget }).context
    );
    const query = runtime.queries[0]!;
    await expect(adapter.setPermissionMode(
      "bypassPermissions",
      contextFor(binding, { target: untrustedTarget }).context
    )).rejects.toMatchObject({
      publicError: { code: "CLAUDE_CODE_FULL_ACCESS_REQUIRES_TRUST" }
    });
    expect(query.permissionCalls).toEqual([]);

    const active = contextFor(binding, {
      operationId: "untrusted-permission-suggestion",
      target: untrustedTarget,
      requestInteraction: async () => ({ kind: "selected", value: "allow_for_session" })
    });
    await adapter.send(textPrompt("request a scoped permission"), active.context);
    const permission = await query.params.options.canUseTool(
      "Bash",
      { command: "pnpm test" },
      {
        ...permissionOptions("untrusted-full-access-suggestion", "untrusted-tool"),
        suggestions: [
          { type: "setMode", mode: "bypassPermissions", destination: "session" },
          { type: "setMode", mode: "acceptEdits", destination: "session" },
          { type: "setMode", mode: "dontAsk", destination: "session" },
          { type: "setMode", mode: "plan", destination: "session" },
          { type: "addDirectories", directories: [process.cwd()], destination: "session" },
          { type: "addRules", rules: [], behavior: "allow", destination: "session" }
        ]
      }
    );
    expect(permission).toMatchObject({ behavior: "allow" });
    expect(permission.behavior === "allow" ? permission.updatedPermissions : []).toEqual([
      { type: "addRules", rules: [], behavior: "allow", destination: "session" }
    ]);
    query.push(resultMessage(binding.nativeSessionId!, { result: "done", totalCostUsd: 0 }));
    await eventually(() => active.events.some((event) => event.type === "done"));
    await adapter.closeSession(binding, contextFor(binding, { target: untrustedTarget }).context);
  });

  test("uses interrupt for a turn and reserves AbortController for teardown", async () => {
    const runtime = new FakeSdkRuntime({ autoAdmitTurns: true });
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const context = contextFor(binding, { operationId: "abort-me" });
    await adapter.send(textPrompt("work"), context.context);
    const query = runtime.queries[0]!;

    await adapter.abort(context.context);
    expect(query.interruptCalls).toBe(1);
    expect(query.params.options.abortController.signal.aborted).toBe(false);
    expect(query.closeCalls).toBe(0);
    query.push(resultMessage(binding.nativeSessionId!, {
      result: "",
      terminalReason: "aborted_tools",
      totalCostUsd: 0
    }));
    await eventually(() => context.events.some((event) => event.type === "done"));
    expect(context.events.at(-1)).toEqual({ type: "done", outcome: "aborted" });

    await adapter.closeSession(binding, contextFor(binding).context);
    expect(query.params.options.abortController.signal.aborted).toBe(true);
    expect(query.closeCalls).toBe(1);
    expect(query.interruptCalls).toBe(1);
  });

  test.each([
    ["missing receipt", async () => undefined],
    ["surviving queued work", async () => ({ still_queued: [randomUUID()] })]
  ])("retires the Query when interrupt has %s", async (_label, interruptHandler) => {
    const runtime = new FakeSdkRuntime({ autoAdmitTurns: true });
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const active = contextFor(binding, { operationId: `abort-${_label}` });
    await adapter.send(textPrompt("work"), active.context);
    const query = runtime.queries[0]!;
    query.interruptHandler = interruptHandler;

    await expect(adapter.abort(active.context)).rejects.toMatchObject({
      publicError: {
        code: "TURN_ABORT_UNKNOWN",
        stateMayHaveChanged: true
      }
    });
    expect(query.closeCalls).toBe(1);
    expect(query.params.options.abortController.signal.aborted).toBe(true);
    await expect(adapter.send(
      textPrompt("must resume explicitly"),
      contextFor(binding, { operationId: `after-${_label}` }).context
    )).rejects.toMatchObject({ publicError: { code: "SESSION_NOT_ATTACHED" } });
  });

  test("bounds an interrupt that never settles and retires the uncertain Query", async () => {
    const runtime = new FakeSdkRuntime({ autoAdmitTurns: true });
    const adapter = adapterFor(runtime, { interruptTimeoutMs: 20 });
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const active = contextFor(binding, { operationId: "abort-timeout" });
    await adapter.send(textPrompt("work"), active.context);
    const query = runtime.queries[0]!;
    query.interruptHandler = () => new Promise(() => undefined);

    await expect(adapter.abort(active.context)).rejects.toMatchObject({
      publicError: { code: "TURN_ABORT_UNKNOWN" }
    });
    expect(query.closeCalls).toBe(1);
    expect(query.params.options.abortController.signal.aborted).toBe(true);
  });

  test("detaches without deleting persistence, resumes explicitly, and deletes through the SDK", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const context = contextFor(binding).context;
    const firstQuery = runtime.queries[0]!;

    await adapter.detachSession(binding, context);
    expect(firstQuery.closeCalls).toBe(1);
    expect(runtime.sessions.has(binding.nativeSessionId!)).toBe(true);
    expect(adapter.supportsDetachedSessionDeletion(context)).toBe(true);

    await adapter.resumeSession(binding, context);
    expect(runtime.queries).toHaveLength(2);
    expect(runtime.queries[1]!.params.options.resume).toBe(binding.nativeSessionId);
    const deleteNative = vi.spyOn(runtime, "deleteSession");
    await adapter.deleteSession(binding, context);
    expect(deleteNative).toHaveBeenCalledExactlyOnceWith(binding.nativeSessionId, { dir: context.target.workspaceRoot, signal: context.signal });
    expect(runtime.deleted).toEqual([binding.nativeSessionId]);
    expect(runtime.sessions.has(binding.nativeSessionId!)).toBe(false);
  });

  test.each(["wrong-cwd", "missing", "cancelled", "new-owner"] as const)("fences %s detached deletion after metadata lookup before the SDK mutation", async (boundary) => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const cancellation = new AbortController();
    const bound = { ...contextFor(binding).context, signal: cancellation.signal };
    await adapter.detachSession(binding, bound);
    const inspect = vi.spyOn(runtime, "getSessionInfo").mockImplementation(async () => {
      if (boundary === "missing") return undefined;
      if (boundary === "cancelled") cancellation.abort();
      if (boundary === "new-owner") runtime.pendingForkIds.add(binding.nativeSessionId!);
      return { ...sessionInfo(binding.nativeSessionId!), ...(boundary === "wrong-cwd" ? { cwd: resolve(target.workspaceRoot, "..") } : {}) };
    });
    await expect(adapter.deleteSession(binding, bound)).rejects.toMatchObject({ publicError: { code: "NATIVE_SESSION_DELETE_UNKNOWN" } });
    expect(inspect).toHaveBeenCalledExactlyOnceWith(binding.nativeSessionId, { dir: target.workspaceRoot, signal: cancellation.signal });
    expect(runtime.deleted).toEqual([]);
    runtime.pendingForkIds.clear();
    await adapter.dispose();
  });

  test("clones full native history with a receipt, preserves the source Query, and resumes independent native message identities", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const source = contextFor(binding, { operationId: "source-after-copy" });
    const oldMessageId = randomUUID();
    runtime.messages.set(binding.nativeSessionId!, [{ type: "user", uuid: oldMessageId, session_id: binding.nativeSessionId!, message: { role: "user", content: "saved history" }, parent_tool_use_id: null, parent_agent_id: null }]);
    const recordBinding = vi.fn((derived: NativeSessionBinding) => {
      expect(derived.nativeSessionId).not.toBe(binding.nativeSessionId);
      expect(runtime.queries[0]!.closeCalls).toBe(0);
    });
    const derivedTarget = {
      ...source.context.target,
      workspaceRoot: await mkdtemp(join(tmpdir(), "joko-claude-derived-workspace-"))
    };
    expect((await adapter.describe()).capabilities.get("workspace.derive")).toMatchObject({ supported: true });
    await expect(adapter.clone(source.context, {
      sessionId: "mismatched-target-product",
      target: { ...derivedTarget, managed: !derivedTarget.managed },
      recordBinding: vi.fn()
    })).rejects.toMatchObject({
      publicError: {
        code: "SESSION_DERIVATION_TARGET_MISMATCH",
        stateMayHaveChanged: false
      }
    });
    expect(runtime.forks).toHaveLength(0);
    const derived = await adapter.clone(source.context, { sessionId: "derived-product", target: derivedTarget, recordBinding });
    expect(recordBinding).toHaveBeenCalledExactlyOnceWith(derived);
    expect(runtime.forks).toHaveLength(1);
    expect(runtime.forks[0]!.sourceId).toBe(binding.nativeSessionId);
    expect(runtime.forks[0]!.options.dir).toBe(derivedTarget.workspaceRoot);
    expect(runtime.infoOptions.at(-1)).toMatchObject({
      sessionId: derived.nativeSessionId,
      options: { dir: derivedTarget.workspaceRoot }
    });
    expect(runtime.forks[0]!.options).not.toHaveProperty("upToMessageId");
    expect(runtime.queries).toHaveLength(1);
    await adapter.send(textPrompt("continue source"), source.context);
    runtime.queries[0]!.push(resultMessage(binding.nativeSessionId!, { result: "source output", totalCostUsd: 0 }));
    await eventually(() => source.events.some((event) => event.type === "done"));
    const derivedContext = { ...contextFor(derived).context, sessionId: "derived-product", target: derivedTarget };
    await adapter.resumeSession(derived, derivedContext);
    expect(runtime.queries[1]!.params.options.resume).toBe(derived.nativeSessionId);
    const projection = await adapter.getNativeHistoryProjection(derivedContext);
    expect(JSON.stringify(projection)).toContain("saved history");
    expect(runtime.messages.get(derived.nativeSessionId!)![0]!.uuid).not.toBe(oldMessageId);
    expect(runtime.queries[0]!.closeCalls).toBe(0);
    await adapter.dispose();
  });

  test("does not advertise or dispatch cross-workspace derivation without a native migration primitive", async () => {
    const runtime = new FakeSdkRuntime();
    runtime.supportsWorkspaceDerivation = false;
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const source = contextFor(binding, { operationId: "unsupported-workspace-copy" });
    const derivedWorkspace = await mkdtemp(join(tmpdir(), "joko-claude-unsupported-derived-workspace-"));
    try {
      const derivedTarget = { ...source.context.target, workspaceRoot: derivedWorkspace };

      expect((await adapter.describe()).capabilities.get("workspace.derive")).toMatchObject({ supported: false });
      await expect(adapter.clone(source.context, {
        sessionId: "unsupported-derived-product",
        target: derivedTarget,
        recordBinding: vi.fn()
      })).rejects.toMatchObject({
        publicError: {
          code: "SESSION_DERIVATION_TARGET_MISMATCH",
          stateMayHaveChanged: false
        }
      });
      expect(runtime.forks).toEqual([]);
    } finally {
      await adapter.dispose();
      await rm(derivedWorkspace, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  test.each(["user", "assistant"] as const)("forks through the exact persisted %s boundary with independent native identities", async (role) => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const messages = forkHistory(binding.nativeSessionId!);
    const selectedIndex = role === "user" ? 0 : 1;
    // Public projection normalizes UUIDs; the SDK still receives its exact spelling.
    messages[selectedIndex] = { ...messages[selectedIndex]!, uuid: messages[selectedIndex]!.uuid.toUpperCase() };
    runtime.messages.set(binding.nativeSessionId!, messages);
    const source = contextFor(binding, { operationId: "source-after-fork" });
    const recordBinding = vi.fn();
    const derivedTarget = {
      ...source.context.target,
      workspaceRoot: await mkdtemp(join(tmpdir(), "joko-claude-fork-workspace-"))
    };
    const fork = await adapter.fork(messages[selectedIndex]!.uuid.toLowerCase(), source.context, {
      sessionId: "forked-product",
      target: derivedTarget,
      recordBinding
    });
    expect(fork).not.toHaveProperty("editorText");
    expect(recordBinding).toHaveBeenCalledExactlyOnceWith(fork.binding);
    expect(runtime.forks[0]!.options.upToMessageId).toBe(messages[selectedIndex]!.uuid);
    expect(runtime.forks[0]!.options.dir).toBe(derivedTarget.workspaceRoot);
    expect(runtime.messageOptions.at(-1)?.options.dir).toBe(derivedTarget.workspaceRoot);
    expect(runtime.queries).toHaveLength(1);
    expect(runtime.queries[0]!.closeCalls).toBe(0);
    expect(runtime.messages.get(binding.nativeSessionId!)).toEqual(messages);
    const forkContext = { ...contextFor(fork.binding).context, sessionId: "forked-product", target: derivedTarget };
    await adapter.resumeSession(fork.binding, forkContext);
    const projected = await adapter.getNativeHistoryProjection(forkContext);
    expect(projected.activeLineage).toHaveLength(selectedIndex + 1);
    expect(projected.activeLineage!.every((entry) => !messages.some((message) => message.uuid.toLowerCase() === entry.entryId))).toBe(true);
    expect(JSON.stringify(projected)).not.toContain("later question");
    await adapter.send(textPrompt("source remains usable"), source.context);
    runtime.queries[0]!.push(resultMessage(binding.nativeSessionId!, { result: "source output", totalCostUsd: 0 }));
    await eventually(() => source.events.some((event) => event.type === "done"));
    await adapter.dispose();
  });

  test("rewinds before the selected user using its exact preceding assistant and returns a registered fresh context", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const messages = forkHistory(binding.nativeSessionId!);
    runtime.messages.set(binding.nativeSessionId!, messages);
    const context = contextFor(binding).context;
    const history = await adapter.getNativeHistoryProjection(context);
    expect(history.events.find((event) => event.nativeEntryId === messages[0]!.uuid)?.nativeRewindBefore).toBeUndefined();
    expect(history.events.find((event) => event.nativeEntryId === messages[2]!.uuid)?.nativeRewindBefore)
      .toEqual({ kind: "native_entry", entryId: messages[1]!.uuid });
    const recordBinding = vi.fn();
    const result = await adapter.navigateTree({ kind: "native_entry", entryId: messages[1]!.uuid }, false, context, undefined, { recordBinding });
    expect(result.kind).toBe("replacement");
    if (result.kind !== "replacement") throw new Error("Missing native replacement.");
    expect(recordBinding).toHaveBeenCalledExactlyOnceWith(result.binding);
    expect(result.binding.generation).toBe(binding.generation + 1);
    expect(result.nativeHistory.activeLineage).toHaveLength(2);
    expect(result.nativeHistory.activeLineage!.every((entry) => !messages.some((message) => message.uuid === entry.entryId))).toBe(true);
    expect(JSON.stringify(result.nativeHistory)).not.toContain("later question");
    expect(runtime.queries[0]!.closeCalls).toBe(0);
    // Failed same-product adoption may clean the detached derivative while the
    // original Query still owns that product Session ID.
    await adapter.deleteSession(result.binding, { ...context, binding: result.binding, generation: result.binding.generation });
    expect(runtime.deleted).toEqual([result.binding.nativeSessionId]);
    expect(runtime.queries[0]!.closeCalls).toBe(0);
    expect(runtime.messages.get(binding.nativeSessionId!)).toEqual(messages);
    await adapter.dispose();
  });

  test.each(["tool-result", "tool-use", "system", "missing-user", "summary"] as const)("rejects an unproven %s conversation rewind before native dispatch", async (boundary) => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const messages = forkHistory(binding.nativeSessionId!);
    if (boundary === "tool-result") messages[2] = { ...messages[2]!, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: "output" }] } };
    if (boundary === "tool-use") messages[1] = { ...messages[1]!, message: { role: "assistant", content: [{ type: "text", text: "answer" }, { type: "tool_use", id: "tool" }] } };
    if (boundary === "system") messages[2] = { ...messages[2]!, type: "system", message: {} };
    if (boundary === "missing-user") messages.pop();
    runtime.messages.set(binding.nativeSessionId!, messages);
    const recordBinding = vi.fn();
    await expect(adapter.navigateTree({ kind: "native_entry", entryId: messages[1]!.uuid }, boundary === "summary", contextFor(binding).context, undefined, { recordBinding }))
      .rejects.toMatchObject({ publicError: { stateMayHaveChanged: false } });
    expect(runtime.forks).toHaveLength(0);
    expect(recordBinding).not.toHaveBeenCalled();
    await adapter.dispose();
  });

  test.each(["malformed-id", "missing", "child", "system", "duplicate", "foreign-session", "over-limit"] as const)("rejects a %s fork boundary before a native effect", async (boundary) => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const messages = forkHistory(binding.nativeSessionId!);
    let entryId = messages[1]!.uuid;
    if (boundary === "malformed-id") entryId = "not-a-message";
    if (boundary === "missing") entryId = randomUUID();
    if (boundary === "child") messages[1] = { ...messages[1]!, parent_agent_id: "child-agent" };
    if (boundary === "system") messages[1] = { ...messages[1]!, type: "system", message: {} };
    if (boundary === "duplicate") messages.push(messages[1]!);
    if (boundary === "foreign-session") messages[1] = { ...messages[1]!, session_id: randomUUID() };
    if (boundary === "over-limit") messages.push(...Array.from({ length: 10_000 }, () => ({ ...messages[0]!, uuid: randomUUID() })));
    runtime.messages.set(binding.nativeSessionId!, messages);
    const recordBinding = vi.fn();
    await expect(adapter.fork(entryId, contextFor(binding).context, { sessionId: "derived", target, recordBinding })).rejects.toMatchObject({ publicError: { stateMayHaveChanged: false } });
    expect(runtime.forks).toHaveLength(0);
    expect(recordBinding).not.toHaveBeenCalled();
    await adapter.dispose();
  });

  test.each(["source-change", "cancel", "close"] as const)("fences %s during the persisted fork boundary read", async (boundary) => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const messages = forkHistory(binding.nativeSessionId!);
    const cancellation = new AbortController();
    const context = { ...contextFor(binding).context, signal: cancellation.signal };
    let release!: () => void;
    const ready = new Promise<void>((resolveReady) => { release = resolveReady; });
    const read = vi.spyOn(runtime, "getSessionMessages").mockImplementation(async () => { await ready; return messages; });
    const recordBinding = vi.fn();
    const forking = adapter.fork(messages[1]!.uuid, context, { sessionId: "derived", target: context.target, recordBinding }).catch((error: unknown) => error);
    await eventually(() => read.mock.calls.length === 1);
    await expect(adapter.send(textPrompt("locked"), context)).rejects.toMatchObject({ publicError: { code: "SESSION_BUSY" } });
    if (boundary === "source-change") runtime.sessions.set(binding.nativeSessionId!, { ...sessionInfo(binding.nativeSessionId!), lastModified: 42 });
    else if (boundary === "cancel") cancellation.abort();
    else await adapter.closeSession(binding, context);
    release();
    expect(await forking).toMatchObject({ publicError: { stateMayHaveChanged: false } });
    expect(runtime.forks).toHaveLength(0);
    expect(recordBinding).not.toHaveBeenCalled();
    await adapter.dispose();
  });

  test.each(["full-copy", "changed-content", "reused-message-id", "read-timeout", "source-change"] as const)("preserves a registered fork receipt after %s fails boundary verification", async (failure) => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const messages = forkHistory(binding.nativeSessionId!);
    runtime.messages.set(binding.nativeSessionId!, messages);
    const read = runtime.getSessionMessages.bind(runtime);
    vi.spyOn(runtime, "getSessionMessages").mockImplementation(async (sessionId, options) => {
      if (sessionId === binding.nativeSessionId) return read(sessionId, options);
      if (failure === "read-timeout") throw new SessionSdkFailure("TIMEOUT", false);
      const derived = [...await read(sessionId, options)];
      if (failure === "full-copy") derived.push({ ...messages[2]!, uuid: randomUUID(), session_id: sessionId });
      if (failure === "changed-content") derived[0] = { ...derived[0]!, message: { role: "user", content: "unrelated context" } };
      if (failure === "reused-message-id") derived[0] = { ...derived[0]!, uuid: messages[0]!.uuid };
      if (failure === "source-change") runtime.sessions.set(binding.nativeSessionId!, { ...sessionInfo(binding.nativeSessionId!), lastModified: 42 });
      return derived;
    });
    const recordBinding = vi.fn();
    await expect(adapter.fork(messages[1]!.uuid, contextFor(binding).context, { sessionId: "derived", target, recordBinding })).rejects.toMatchObject({ publicError: { code: "NATIVE_SESSION_FORK_UNKNOWN", stateMayHaveChanged: true } });
    expect(recordBinding).toHaveBeenCalledTimes(1);
    expect(runtime.forks).toHaveLength(1);
    expect(runtime.deleted).toEqual([]);
    expect(runtime.queries).toHaveLength(1);
    await adapter.dispose();
  });

  test("keeps an unconfirmed fork outcome unknown without guessing a derived identity or retrying", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const messages = forkHistory(binding.nativeSessionId!);
    runtime.messages.set(binding.nativeSessionId!, messages);
    runtime.forkHandler = async () => { throw new SessionSdkFailure("TIMEOUT", true); };
    const recordBinding = vi.fn();
    await expect(adapter.fork(messages[1]!.uuid, contextFor(binding).context, { sessionId: "derived", target, recordBinding })).rejects.toMatchObject({ publicError: { code: "NATIVE_SESSION_FORK_UNKNOWN", stateMayHaveChanged: true } });
    expect(runtime.forks).toHaveLength(1);
    expect(recordBinding).not.toHaveBeenCalled();
    expect(runtime.deleted).toEqual([]);
    await adapter.dispose();
  });

  test.each(["missing", "wrong-cwd"] as const)("rejects a %s source before copying native history", async (state) => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    if (state === "missing") runtime.sessions.delete(binding.nativeSessionId!);
    else runtime.sessions.set(binding.nativeSessionId!, { ...sessionInfo(binding.nativeSessionId!), cwd: resolve(target.workspaceRoot, "..") });
    const recordBinding = vi.fn();
    await expect(adapter.clone(contextFor(binding).context, { sessionId: "derived", target, recordBinding })).rejects.toMatchObject({ publicError: { stateMayHaveChanged: false } });
    expect(runtime.forks).toHaveLength(0);
    expect(recordBinding).not.toHaveBeenCalled();
    await adapter.dispose();
  });

  test("locks the source during preparation and preserves the receipt when post-copy metadata fails", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const bound = contextFor(binding).context;
    const derivedId = randomUUID();
    let release!: () => void;
    const ready = new Promise<void>((resolveReady) => { release = resolveReady; });
    runtime.forkHandler = async (_sourceId, options) => {
      await ready;
      options.recordSessionId(derivedId);
      return { sessionId: derivedId };
    };
    const recordBinding = vi.fn();
    const copying = adapter.clone(bound, { sessionId: "derived", target: bound.target, recordBinding });
    await expect(adapter.send(textPrompt("too early"), { ...bound, operationId: "copy-busy" })).rejects.toMatchObject({ publicError: { code: "SESSION_BUSY" } });
    await expect(adapter.setFastMode(true, bound)).rejects.toMatchObject({ publicError: { code: "SESSION_BUSY" } });
    await expect(adapter.clone(bound, { sessionId: "another-copy", target: bound.target, recordBinding: vi.fn() })).rejects.toMatchObject({ publicError: { code: "SESSION_BUSY" } });
    release();
    await expect(copying).rejects.toMatchObject({ publicError: { code: "NATIVE_SESSION_CLONE_UNKNOWN", stateMayHaveChanged: true } });
    expect(recordBinding).toHaveBeenCalledTimes(1);
    expect(runtime.deleted).toEqual([]);
    expect(runtime.queries[0]!.closeCalls).toBe(0);
    await adapter.setFastMode(false, bound);
    await adapter.dispose();
  });

  test.each(["cancel", "close", "dispose"] as const)("records a known copy while %s drains and never installs the derived Query", async (boundary) => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const cancellation = new AbortController();
    const bound = { ...contextFor(binding).context, signal: cancellation.signal };
    const derivedId = randomUUID();
    runtime.forkHandler = async (_sourceId, options) => new Promise((resolveResult) => {
      options.signal.addEventListener("abort", () => {
        options.recordSessionId(derivedId);
        resolveResult({ sessionId: derivedId });
      }, { once: true });
    });
    const recordBinding = vi.fn();
    const copying = adapter.clone(bound, { sessionId: "derived", target: bound.target, recordBinding }).catch((error: unknown) => error);
    await eventually(() => runtime.forks.length === 1);
    if (boundary === "cancel") cancellation.abort();
    else if (boundary === "close") await adapter.closeSession(binding, bound);
    else await adapter.dispose();
    expect(await copying).toMatchObject({ publicError: { code: "NATIVE_SESSION_CLONE_UNKNOWN", stateMayHaveChanged: true } });
    expect(recordBinding).toHaveBeenCalledTimes(1);
    expect(runtime.queries).toHaveLength(1);
    expect(runtime.deleted).toEqual([]);
    await adapter.dispose();
  });

  test("does not delete registration conflicts and fences an unconfirmed copy owner from input or cleanup", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const bound = contextFor(binding).context;
    const recordBinding = vi.fn(() => { throw new Error("Binding already adopted"); });
    await expect(adapter.clone(bound, { sessionId: "derived", target: bound.target, recordBinding })).rejects.toMatchObject({ publicError: { code: "NATIVE_SESSION_CLONE_UNKNOWN", stateMayHaveChanged: true } });
    expect(recordBinding).toHaveBeenCalledTimes(1);
    expect(runtime.deleted).toEqual([]);
    runtime.pendingForkIds.add(binding.nativeSessionId!);
    await expect(adapter.send(textPrompt("still owned"), { ...bound, operationId: "owned-copy" })).rejects.toMatchObject({ publicError: { code: "SESSION_BUSY" } });
    await expect(adapter.deleteSession(binding, bound)).rejects.toMatchObject({ publicError: { code: "NATIVE_SESSION_DELETE_BUSY" } });
    runtime.pendingForkIds.clear();
    await adapter.dispose();
  });

  test("rejects full copy while a native background writer remains active after its foreground result", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const active = contextFor(binding, { operationId: "writer-before-copy" });
    await adapter.send(textPrompt("start background work"), active.context);
    const query = runtime.queries[0]!;
    query.push(assistantMessage(binding.nativeSessionId!, "writer-message", [{ type: "tool_use", id: "writer-tool", name: "Bash", input: {} }]));
    query.push(taskStarted(binding.nativeSessionId!, "writer-task", "writer-tool", { taskType: "local_bash", description: "Background task" }));
    query.push(resultMessage(binding.nativeSessionId!, { result: "foreground done", totalCostUsd: 0 }));
    await eventually(() => active.events.some((event) => event.type === "done"));
    expect(active.events.some((event) => event.type === "background_task" && event.state === "running")).toBe(true);
    const sourceContext = contextFor(binding).context;
    await expect(adapter.clone(sourceContext, { sessionId: "derived", target: sourceContext.target, recordBinding: vi.fn() })).rejects.toMatchObject({ publicError: { code: "SESSION_BUSY" } });
    expect(runtime.forks).toHaveLength(0);
    await adapter.dispose();
  });

  test("maps permission, question, and plan tools to typed interactions with replay-safe decisions", async () => {
    const runtime = new FakeSdkRuntime({ autoAdmitTurns: true });
    const adapter = adapterFor(runtime);
    const interactions: InteractionPayload[] = [];
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const active = contextFor(binding, {
      operationId: "interactions",
      requestInteraction: async (interaction) => {
        interactions.push(interaction);
        if (interaction.kind === "permission") {
          return interaction.toolName === "Edit"
            ? { kind: "selected", value: "deny" }
            : { kind: "selected", value: "allow_for_session" };
        }
        if (interaction.kind === "question") {
          return { kind: "question", answers: {
            q0: { kind: "single", selection: { kind: "choice", choiceId: "q0o1" } },
            q1: { kind: "single", selection: { kind: "other", text: "q1o0" } }
          } };
        }
        return { kind: "plan_review", decision: "execute", feedback: "" };
      }
    });
    await adapter.send(textPrompt("interact"), active.context);
    const query = runtime.queries[0]!;
    const allowOptions = permissionOptions("permission-one", "tool-bash");
    const allow = await query.params.options.canUseTool("Bash", { command: "pnpm test" }, {
      ...allowOptions,
      suggestions: [
        { type: "addRules", destination: "session", rules: [], behavior: "allow" },
        { type: "addRules", destination: "projectSettings", rules: [], behavior: "allow" }
      ]
    });
    expect(allow).toMatchObject({ behavior: "allow", updatedInput: { command: "pnpm test" } });
    expect(allow.behavior === "allow" ? allow.updatedPermissions : []).toHaveLength(1);
    const replay = await query.params.options.canUseTool("Bash", { command: "pnpm test" }, allowOptions);
    expect(replay).toEqual(allow);

    const denied = await query.params.options.canUseTool(
      "Edit",
      { file_path: "src/main.ts" },
      permissionOptions("permission-two", "tool-edit")
    );
    expect(denied).toEqual({ behavior: "deny", message: "The user denied this tool request." });

    const question = await query.params.options.canUseTool("AskUserQuestion", {
      questions: [
        {
          question: "Choose a route",
          header: "Route",
          options: [
            { label: "Safe", description: "Use the safe route." },
            { label: "Fast", description: "Use the fast route." }
          ],
          multiSelect: false
        },
        {
          question: "Name another route",
          header: "Other route",
          options: [{ label: "Slow", description: "Use the slow route." }],
          multiSelect: false
        }
      ]
    }, permissionOptions("question-one", "tool-question"));
    expect(question).toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "Choose a route": "Fast", "Name another route": "q1o0" } }
    });

    const plan = await query.params.options.canUseTool(
      "ExitPlanMode",
      { plan: "1. Test\n2. Ship" },
      permissionOptions("plan-one", "tool-plan")
    );
    expect(plan).toMatchObject({ behavior: "allow", updatedInput: { plan: "1. Test\n2. Ship" } });
    expect(interactions.map((interaction) => interaction.kind)).toEqual([
      "permission",
      "permission",
      "question",
      "plan_review"
    ]);
    expect(interactions[0]).toMatchObject({ kind: "permission", risk: "high", toolName: "Bash" });
    expect(interactions[1]).toMatchObject({ kind: "permission", risk: "medium", toolName: "Edit" });

    query.push(resultMessage(binding.nativeSessionId!, { result: "done", totalCostUsd: 0.1 }));
    await eventually(() => active.events.some((event) => event.type === "done"));
    await adapter.closeSession(binding, contextFor(binding).context);
  });

  test("applies model, effort, permission, plan, and read-write directory controls to the Query", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const binding = await adapter.createSession(createInput(), contextFor().context);
    const context = contextFor(binding).context;
    const query = runtime.queries[0]!;

    await expect(adapter.setModel("claude-code", "model-b", context)).resolves.toMatchObject({ modelId: "model-b" });
    await adapter.setEffort("max", context);
    await adapter.setPermissionMode("bypassPermissions", context);
    await adapter.setPlanMode(true, context);
    await adapter.setPlanMode(false, context);
    await adapter.setExtraDirectories(
      [{ id: "approved", path: process.cwd(), access: "read_write" }],
      context
    );

    expect(query.modelCalls).toEqual(["model-b"]);
    expect(query.settingCalls).toContainEqual({ effortLevel: "max" });
    expect(query.permissionCalls).toEqual(["bypassPermissions", "plan", "bypassPermissions"]);
    expect(query.settingCalls).toContainEqual({ permissions: { additionalDirectories: [process.cwd()] } });
    await expect(adapter.setExtraDirectories(
      [{ id: "read-only", path: process.cwd(), access: "read_only" }],
      context
    )).rejects.toMatchObject({ publicError: { code: "EXTRA_DIRECTORY_ACCESS_UNSUPPORTED" } });

    await adapter.closeSession(binding, context);
  });

  test("rejects stale Backend instance contexts and drops late output from a retired Query generation", async () => {
    const runtime = new FakeSdkRuntime({ autoAdmitTurns: true, leaveOutputOpenOnClose: true });
    const adapter = adapterFor(runtime, { teardownTimeoutMs: 10 });
    const binding = await adapter.createSession(createInput(), contextFor().context);
    await expect(adapter.send(textPrompt("stale"), {
      ...contextFor(binding, { operationId: "stale" }).context,
      backendInstanceGeneration: INSTANCE_GENERATION + 1
    })).rejects.toMatchObject({ publicError: { code: "BACKEND_GENERATION_MISMATCH" } });

    const active = contextFor(binding, { operationId: "late" });
    await adapter.send(textPrompt("late"), active.context);
    const oldQuery = runtime.queries[0]!;
    await adapter.closeSession(binding, contextFor(binding).context);
    await expect(oldQuery.params.options.canUseTool(
      "Bash",
      { command: "must-not-run" },
      permissionOptions("late-permission", "late-tool")
    )).resolves.toEqual({ behavior: "deny", message: "The originating turn is no longer active." });
    oldQuery.push(assistantMessage(binding.nativeSessionId!, "late-assistant", [{ type: "text", text: "must drop" }]));
    oldQuery.push(resultMessage(binding.nativeSessionId!, { result: "must drop", totalCostUsd: 0 }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
    expect(active.events).toEqual([]);
    oldQuery.endOutput();
  });
});

interface FakeRuntimeOptions {
  readonly autoAdmitTurns?: boolean;
  readonly autoReplayInputs?: boolean;
  readonly pauseAfterFirstInput?: boolean;
  readonly initialSessionIdOverride?: string;
  readonly initialPermissionMode?: string;
  readonly initialFrameOverrides?: Readonly<Record<string, unknown>>;
  readonly leaveOutputOpenOnClose?: boolean;
  readonly probeDiagnostic?: string;
  readonly probeInstalled?: boolean;
}

function managedProviderFixture(thinkingLevelMap: Readonly<Record<string, string | null>> = {}) {
  const token = "private-model-proxy-fixture-token";
  const models: ProviderModel[] = ["configured-model", "second-model"].map((modelId, index) => ({
    providerId: "configured-provider", modelId, displayName: modelId, api: "anthropic-messages",
    contextWindow: index === 0 ? 64_000 : 128_000, maxOutputTokens: index === 0 ? 4_000 : 8_000,
    supportsImages: true, supportsFastMode: true, thinkingLevels: ["low", "high", "unavailable"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
  }));
  const activations: { input: Parameters<ManagedProviderRouteBinding["activate"]>[0]; release: ReturnType<typeof vi.fn> }[] = [];
  let enabled = true;
  let revision = "revision-one";
  const port: ManagedProviderRuntimePort = {
    support: { protocols: ["anthropic-messages"], fields: ["headers", "model_input_modalities", "model_limits"] },
    environment: { JOKO_MODEL_PROXY_TOKEN: token }, secretEnvironmentNames: ["JOKO_MODEL_PROXY_TOKEN"],
    dispose: vi.fn(),
    hasProvider: (providerId) => providerId === "configured-provider",
    listModels: () => models,
    getThinkingLevelMap: () => Object.freeze({ ...thinkingLevelMap }),
    listProviders: () => [{ providerId: "configured-provider", displayName: "Configured Provider", api: "anthropic-messages",
      authenticationState: "authenticated", loginMethods: [], supportsLogin: false, supportsLogout: false, supportsRefresh: true, supportsModelRefresh: true }],
    prepare: async (owner) => {
      if (!enabled) throw new Error("The managed route is disabled.");
      let disposed = false;
      const preparedRevision = revision;
      const assertCurrent = () => { if (!enabled || disposed || preparedRevision !== revision) throw new Error("The managed route is stale."); };
      return { providerId: owner.providerId, model: models.find((model) => model.modelId === owner.modelId)!, thinkingLevelMap: Object.freeze({ ...thinkingLevelMap }), protocol: "anthropic-messages",
        revision: preparedRevision, baseUrl: "http://127.0.0.1:31415/routes/fixture", apiKeyEnvironment: "JOKO_MODEL_PROXY_TOKEN",
        assertCurrent, activate: async (input) => { assertCurrent(); input.assertCurrent(); const release = vi.fn(); activations.push({ input, release }); return { release }; },
        dispose: () => { disposed = true; }
      };
    }
  };
  return { port, token, activations, get enabled() { return enabled; }, set enabled(value: boolean) { enabled = value; },
    get revision() { return revision; }, set revision(value: string) { revision = value; } };
}

function forkHistory(sessionId: string): ClaudeSdkSessionMessage[] {
  return ["first question", "first answer", "later question"].map((text, index) => ({
    type: index === 1 ? "assistant" : "user",
    uuid: randomUUID(), session_id: sessionId,
    message: index === 1 ? { role: "assistant", content: [{ type: "text", text }] } : { role: "user", content: text },
    parent_tool_use_id: null, parent_agent_id: null
  }));
}

class FakeSdkRuntime implements ClaudeSdkRuntime {
  readonly packageVersion = CLAUDE_AGENT_SDK_VERSION;
  supportsWorkspaceDerivation = true;
  readonly queries: FakeQuery[] = [];
  retirementFailure = false;
  readonly retiredQueries: ClaudeSdkQuery[] = [];
  async retireQuery(query: ClaudeSdkQuery): Promise<void> {
    this.retiredQueries.push(query);
    if (this.retirementFailure) throw new Error("The controlled Query has not confirmed exit.");
  }
  readonly sessions = new Map<string, ClaudeSdkSessionInfo>();
  readonly messages = new Map<string, readonly ClaudeSdkSessionMessage[]>();
  readonly deleted: string[] = [];
  readonly forks: { readonly sourceId: string; readonly options: ClaudeSdkForkOptions }[] = [];
  readonly pendingForkIds = new Set<string>();
  forkHandler?: (sessionId: string, options: ClaudeSdkForkOptions) => Promise<{ readonly sessionId: string }>;
  readonly listOptions: ClaudeSdkListSessionsOptions[] = [];
  closeSessionOperationsCalls = 0;
  closeSessionOperationsFailure = false;
  readonly messageOptions: {
    readonly sessionId: string;
    readonly options: ClaudeSdkGetSessionMessagesOptions;
  }[] = [];
  readonly infoOptions: {
    readonly sessionId: string;
    readonly options: { readonly dir: string; readonly signal?: AbortSignal };
  }[] = [];
  readonly probeInputs: ClaudeSdkProbeInput[] = [];
  readonly options: FakeRuntimeOptions;
  probeInitialization: ClaudeSdkInitializationResult | undefined = initialization();
  queryInitialization: ClaudeSdkInitializationResult = initialization();
  probeCliVersion: string | undefined = "2.1.259";
  probeApiKeySource: string | undefined = "none";
  queryFailure: unknown = undefined;

  constructor(options: FakeRuntimeOptions = {}) {
    this.options = options;
  }

  probe(input: ClaudeSdkProbeInput) {
    this.probeInputs.push(input);
    return Promise.resolve({
      installed: this.options.probeInstalled ?? true,
      packageVersion: this.packageVersion,
      ...(this.probeInitialization === undefined ? {} : { initialization: this.probeInitialization }),
      ...(this.probeCliVersion === undefined ? {} : { cliVersion: this.probeCliVersion }),
      ...(this.probeApiKeySource === undefined ? {} : { apiKeySource: this.probeApiKeySource }),
      ...(this.options.probeDiagnostic === undefined ? {} : { diagnostic: this.options.probeDiagnostic })
    });
  }

  query(params: ClaudeSdkQueryParams): Promise<ClaudeSdkQuery> {
    if (this.queryFailure !== undefined) return Promise.reject(this.queryFailure);
    const nativeSessionId = params.options.resume ?? params.options.sessionId;
    if (nativeSessionId === undefined) throw new Error("Fake Query requires a native Session ID.");
    const query = new FakeQuery(params, this.queryInitialization, this.options.leaveOutputOpenOnClose ?? false,
      this.options.pauseAfterFirstInput ?? false);
    this.queries.push(query);
    if (params.options.sessionId !== undefined) this.sessions.set(nativeSessionId, sessionInfo(nativeSessionId));
    void query.consumeInput((message) => {
      if (this.options.autoAdmitTurns !== false) {
        query.push({
          ...systemInit(this.options.initialSessionIdOverride ?? nativeSessionId),
          ...(Array.isArray(params.options.tools) ? { tools: [...params.options.tools] } : {}),
          ...(this.options.initialPermissionMode === undefined
            ? {}
            : { permissionMode: this.options.initialPermissionMode }),
          ...this.options.initialFrameOverrides
        });
      }
      if (this.options.autoReplayInputs !== false && params.options.extraArgs?.["replay-user-messages"] === null) {
        query.push({ ...message, isReplay: true, session_id: nativeSessionId });
      }
      return message;
    });
    return Promise.resolve(query);
  }

  getSessionInfo(sessionId: string, options: { readonly dir: string; readonly signal?: AbortSignal }): Promise<ClaudeSdkSessionInfo | undefined> {
    this.infoOptions.push({ sessionId, options });
    return Promise.resolve(this.sessions.get(sessionId));
  }

  getSessionMessages(
    sessionId: string,
    options: ClaudeSdkGetSessionMessagesOptions
  ): Promise<readonly ClaudeSdkSessionMessage[]> {
    this.messageOptions.push({ sessionId, options });
    return Promise.resolve(this.messages.get(sessionId) ?? []);
  }

  listSessions(options: ClaudeSdkListSessionsOptions): Promise<readonly ClaudeSdkSessionInfo[]> {
    this.listOptions.push(options);
    return Promise.resolve([...this.sessions.values()].slice(options.offset, options.offset + options.limit));
  }

  deleteSession(sessionId: string): Promise<void> {
    this.deleted.push(sessionId);
    this.sessions.delete(sessionId);
    return Promise.resolve();
  }

  ownsSessionFork(sessionId: string): boolean {
    return this.pendingForkIds.has(sessionId);
  }

  async closeSessionOperations(): Promise<void> {
    this.closeSessionOperationsCalls += 1;
    if (this.closeSessionOperationsFailure) throw new Error("The controlled Session SDK cleanup failed.");
  }

  async forkSession(sessionId: string, options: ClaudeSdkForkOptions): Promise<{ readonly sessionId: string }> {
    this.forks.push({ sourceId: sessionId, options });
    if (this.forkHandler !== undefined) return this.forkHandler(sessionId, options);
    const derived = randomUUID();
    this.sessions.set(derived, { ...sessionInfo(derived), cwd: options.dir });
    const source = this.messages.get(sessionId) ?? [];
    const selected = options.upToMessageId === undefined ? source : source.slice(0, source.findIndex((message) => message.uuid === options.upToMessageId) + 1);
    this.messages.set(derived, selected.map((message) => ({ ...message, uuid: randomUUID(), session_id: derived })));
    options.recordSessionId(derived);
    return { sessionId: derived };
  }
}

class FakeQuery implements ClaudeSdkQuery {
  readonly params: ClaudeSdkQueryParams;
  readonly receivedInputs: ClaudeSdkUserMessage[] = [];
  readonly permissionCalls: string[] = [];
  readonly modelCalls: (string | undefined)[] = [];
  readonly settingCalls: Readonly<Record<string, unknown>>[] = [];
  readonly stopTaskCalls: string[] = [];
  readonly #initialization: ClaudeSdkInitializationResult;
  readonly #output = new AsyncOutput();
  readonly #leaveOutputOpenOnClose: boolean;
  readonly #pauseAfterFirstInput: boolean;
  #resumeInput?: () => void;
  interruptHandler: () => Promise<{ readonly still_queued?: readonly string[] } | undefined> = async () => ({
    still_queued: []
  });
  interruptCalls = 0;
  closeCalls = 0;
  settingsHandler: (settings: Readonly<Record<string, unknown>>) => Promise<void> = async () => {};

  constructor(
    params: ClaudeSdkQueryParams,
    initializationResult: ClaudeSdkInitializationResult,
    leaveOutputOpenOnClose: boolean,
    pauseAfterFirstInput: boolean
  ) {
    this.params = params;
    this.#initialization = initializationResult;
    this.#leaveOutputOpenOnClose = leaveOutputOpenOnClose;
    this.#pauseAfterFirstInput = pauseAfterFirstInput;
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.#output[Symbol.asyncIterator]();
  }

  async consumeInput(onMessage: (message: ClaudeSdkUserMessage) => ClaudeSdkUserMessage): Promise<void> {
    for await (const message of this.params.prompt) {
      this.receivedInputs.push(onMessage(message));
      if (this.#pauseAfterFirstInput && this.receivedInputs.length === 1) {
        await new Promise<void>((resolvePromise) => { this.#resumeInput = resolvePromise; });
      }
    }
  }

  resumeInputs(): void {
    this.#resumeInput?.();
    this.#resumeInput = undefined;
  }

  push(message: unknown): void {
    if (typeof message === "object" && message !== null && !Array.isArray(message)
      && (message as Record<string, unknown>)["type"] === "result") {
      const envelope = message as Record<string, unknown>;
      const userMessageUuid = this.receivedInputs.at(-1)?.uuid;
      this.#output.push({
        ...envelope,
        ...(envelope["origin"] === undefined ? { origin: { kind: "human" } } : {}),
        ...(envelope["user_message_uuid"] === undefined && userMessageUuid !== undefined
          ? { user_message_uuid: userMessageUuid }
          : {})
      });
      return;
    }
    this.#output.push(message);
  }

  endOutput(): void {
    this.#output.close();
  }

  interrupt(): Promise<{ readonly still_queued?: readonly string[] } | undefined> {
    this.interruptCalls += 1;
    return this.interruptHandler();
  }

  stopTask(taskId: string): Promise<void> {
    this.stopTaskCalls.push(taskId);
    return Promise.resolve();
  }

  setPermissionMode(mode: string): Promise<void> {
    this.permissionCalls.push(mode);
    return Promise.resolve();
  }

  setModel(model?: string): Promise<void> {
    this.modelCalls.push(model);
    return Promise.resolve();
  }

  applyFlagSettings(settings: Readonly<Record<string, unknown>>): Promise<void> {
    this.settingCalls.push(settings);
    return this.settingsHandler(settings);
  }

  initializationResult(): Promise<ClaudeSdkInitializationResult> {
    return Promise.resolve(this.#initialization);
  }

  supportedModels() {
    return Promise.resolve(this.#initialization.models);
  }

  accountInfo() {
    return Promise.resolve(this.#initialization.account);
  }

  close(): void {
    this.closeCalls += 1;
    this.resumeInputs();
    void this.params.prompt[Symbol.asyncIterator]().return?.();
    if (!this.#leaveOutputOpenOnClose) this.#output.close();
  }
}

class AsyncOutput implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  readonly #values: unknown[] = [];
  readonly #readers: ((result: IteratorResult<unknown>) => void)[] = [];
  #closed = false;

  push(value: unknown): void {
    const reader = this.#readers.shift();
    if (reader !== undefined) reader({ value, done: false });
    else this.#values.push(value);
  }

  close(): void {
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

function adapterFor(
  runtime: FakeSdkRuntime,
  options: Partial<ClaudeCodeAdapterOptions> = {}
): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    ...options,
    instanceGeneration: INSTANCE_GENERATION,
    runtime,
    initializationTimeoutMs: options.initializationTimeoutMs ?? 500,
    admissionTimeoutMs: options.admissionTimeoutMs ?? 500,
    teardownTimeoutMs: options.teardownTimeoutMs ?? 50
  });
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function createInput(overrides: Partial<CreateNativeSessionInput> = {}): CreateNativeSessionInput {
  return {
    target,
    fastMode: false,
    permissionMode: "ask",
    nativeStart: { kind: "new" },
    ...overrides
  };
}

function contextFor(
  binding?: NativeSessionBinding,
  overrides: {
    readonly operationId?: string;
    readonly requestInteraction?: (interaction: InteractionPayload) => Promise<InteractionDecision>;
    readonly generation?: number;
    readonly target?: TargetDescriptor;
    readonly runtimePolicy?: "review_read_only";
  } = {}
): { readonly context: AdapterContext; readonly events: EventPayload[] } {
  const events: EventPayload[] = [];
  const context: AdapterContext = {
    sessionId: "product-session",
    generation: overrides.generation ?? 1,
    backendInstanceGeneration: INSTANCE_GENERATION,
    target: overrides.target ?? target,
    ...(overrides.runtimePolicy === undefined ? {} : { runtimePolicy: overrides.runtimePolicy }),
    ...(binding === undefined ? {} : { binding }),
    ...(overrides.operationId === undefined ? {} : { operationId: overrides.operationId }),
    signal: new AbortController().signal,
    emit: async (payload) => {
      events.push(payload);
    },
    requestInteraction: overrides.requestInteraction ?? (async () => ({ kind: "cancelled" })),
    artifactCapacityBytes: 1024,
    storeArtifact: async () => {
      throw new Error("Artifacts are not expected in these tests.");
    }
  };
  return { context, events };
}

function textPrompt(text: string) {
  return { text, images: [], files: [], mentions: [], disposition: "prompt" as const };
}

function textResourceSeed(overrides: Partial<NonNullable<Awaited<ReturnType<NonNullable<ClaudeCodeAdapterOptions["resolveTextResources"]>>>[number]>> = {}) {
  return {
    id: "approved-skill-one",
    kind: "skill" as const,
    name: "Approved workflow",
    revision: "sha256:approved-resource-revision",
    resourceVersion: 7n,
    version: "1.0.0",
    content: "Follow the approved workflow without reading ambient settings.",
    assertCurrent: vi.fn(),
    ...overrides
  };
}

function resourceMention(seed: ReturnType<typeof textResourceSeed>, runtimeGeneration: number) {
  return {
    kind: "resource" as const,
    label: seed.name,
    reference: seed.id,
    discoveredRevision: seed.revision,
    resourceVersion: seed.resourceVersion.toString(10),
    runtimeGeneration
  };
}

function initialization(): ClaudeSdkInitializationResult {
  return {
    models: [
      {
        value: "model-a",
        resolvedModel: "model-a-20260801",
        displayName: "Model A",
        description: "Primary model",
        supportsFastMode: true,
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "max"]
      },
      {
        value: "model-b",
        displayName: "Model B",
        description: "Secondary model",
        supportsFastMode: false,
        supportsEffort: true,
        supportedEffortLevels: ["low", "high", "max"]
      }
    ],
    account: {}
  };
}

function systemInit(sessionId: string) {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    uuid: randomUUID(),
    claude_code_version: "2.1.259",
    apiKeySource: "none",
    cwd: process.cwd(),
    model: "model-a",
    permissionMode: "default",
    effort: "high",
    tools: ["Read", "Edit", "Bash"],
    mcp_servers: [],
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    capabilities: ["interrupt_receipt_v1"]
  };
}

function streamEvent(sessionId: string, event: Readonly<Record<string, unknown>>) {
  return {
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId
  };
}

function imageAttachment() {
  const data = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  return { data, blob: { id: "image-artifact", sha256: createHash("sha256").update(data).digest("hex"), byteLength: data.byteLength, mimeType: "image/png" } };
}

function childStreamEvent(
  sessionId: string,
  parentToolUseId: string,
  event: Readonly<Record<string, unknown>>
) {
  return {
    ...streamEvent(sessionId, event),
    parent_tool_use_id: parentToolUseId
  };
}

function assistantMessage(sessionId: string, uuid: string, content: readonly Readonly<Record<string, unknown>>[]) {
  return {
    type: "assistant",
    message: {
      id: `message-${uuid}`,
      role: "assistant",
      model: "model-a",
      content,
      stop_reason: null,
      usage: {}
    },
    parent_tool_use_id: null,
    uuid,
    session_id: sessionId
  };
}

function childAssistantMessage(
  sessionId: string,
  uuid: string,
  parentToolUseId: string,
  content: readonly Readonly<Record<string, unknown>>[],
  model = "model-a"
) {
  return {
    ...assistantMessage(sessionId, uuid, content),
    message: {
      id: `message-${uuid}`,
      role: "assistant",
      model,
      content,
      stop_reason: null,
      usage: {}
    },
    parent_tool_use_id: parentToolUseId
  };
}

function userToolResult(
  sessionId: string,
  uuid: string,
  toolUseId: string,
  content: string,
  isError: boolean
) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }]
    },
    parent_tool_use_id: null,
    uuid,
    session_id: sessionId
  };
}

function childUserToolResult(
  sessionId: string,
  uuid: string,
  parentToolUseId: string,
  toolUseId: string,
  content: string,
  isError: boolean
) {
  return {
    ...userToolResult(sessionId, uuid, toolUseId, content, isError),
    parent_tool_use_id: parentToolUseId
  };
}

function childToolProgress(
  sessionId: string,
  parentToolUseId: string,
  toolUseId: string,
  toolName: string,
  elapsedTimeSeconds: number
) {
  return {
    type: "tool_progress",
    tool_use_id: toolUseId,
    tool_name: toolName,
    parent_tool_use_id: parentToolUseId,
    elapsed_time_seconds: elapsedTimeSeconds,
    uuid: randomUUID(),
    session_id: sessionId
  };
}

function taskStarted(
  sessionId: string,
  taskId: string,
  toolUseId: string,
  options: {
    readonly taskType: string;
    readonly description: string;
    readonly prompt?: string;
  }
) {
  return {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: toolUseId,
    description: options.description,
    task_type: options.taskType,
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
    is_backgrounded: true,
    uuid: randomUUID(),
    session_id: sessionId
  };
}

function taskProgress(
  sessionId: string,
  taskId: string,
  toolUseId: string,
  options: {
    readonly totalTokens: number;
    readonly toolUses: number;
    readonly durationMs: number;
    readonly lastToolName?: string;
    readonly summary?: string;
  }
) {
  return {
    type: "system",
    subtype: "task_progress",
    task_id: taskId,
    tool_use_id: toolUseId,
    description: "Native task",
    usage: {
      total_tokens: options.totalTokens,
      tool_uses: options.toolUses,
      duration_ms: options.durationMs
    },
    ...(options.lastToolName === undefined ? {} : { last_tool_name: options.lastToolName }),
    ...(options.summary === undefined ? {} : { summary: options.summary }),
    uuid: randomUUID(),
    session_id: sessionId
  };
}

function taskNotification(
  sessionId: string,
  taskId: string,
  toolUseId: string,
  options: {
    readonly status: "completed" | "failed" | "stopped";
    readonly summary: string;
    readonly outputFile: string;
    readonly totalTokens: number;
    readonly toolUses: number;
    readonly durationMs: number;
  }
) {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    tool_use_id: toolUseId,
    status: options.status,
    output_file: options.outputFile,
    summary: options.summary,
    usage: {
      total_tokens: options.totalTokens,
      tool_uses: options.toolUses,
      duration_ms: options.durationMs
    },
    uuid: randomUUID(),
    session_id: sessionId
  };
}

function resultMessage(
  sessionId: string,
  options: {
    readonly result: string;
    readonly totalCostUsd: number;
    readonly terminalReason?: string;
  }
) {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 100,
    duration_api_ms: 90,
    is_error: false,
    num_turns: 1,
    result: options.result,
    stop_reason: "end_turn",
    total_cost_usd: options.totalCostUsd,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1
    },
    modelUsage: {
      "model-a": {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
        webSearchRequests: 0,
        costUSD: options.totalCostUsd,
        contextWindow: 200_000,
        maxOutputTokens: 32_000
      }
    },
    permission_denials: [],
    terminal_reason: options.terminalReason ?? "completed",
    uuid: randomUUID(),
    session_id: sessionId
  };
}

function permissionOptions(requestId: string, toolUseID: string): ClaudeCanUseToolOptions {
  return {
    signal: new AbortController().signal,
    toolUseID,
    requestId
  };
}

function historyMessage(
  type: ClaudeSdkSessionMessage["type"],
  uuid: string,
  sessionId: string,
  message: unknown
): ClaudeSdkSessionMessage {
  return {
    type,
    uuid,
    session_id: sessionId,
    message,
    parent_tool_use_id: null,
    parent_agent_id: null
  };
}

function sessionInfo(sessionId: string): ClaudeSdkSessionInfo {
  return {
    sessionId,
    summary: "Native Session",
    lastModified: Date.now(),
    cwd: process.cwd()
  };
}

async function eventually(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met before timeout.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
}

const navigationAuthority = { recordBinding: (): never => { throw new Error("Unexpected native context replacement."); } };
