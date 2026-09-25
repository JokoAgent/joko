import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AdapterContext,
  CreateNativeSessionInput,
  EventPayload,
  InteractionDecision,
  InteractionPayload,
  MentionInput,
  NativeSessionBinding,
  ManagedProviderRuntimePort,
  ManagedProviderRouteBinding,
  ManagedProviderSmartRoutingBinding,
  ProviderModel,
  TargetDescriptor
} from "@joko/core";
import { CAPABILITIES } from "@joko/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexBackendAdapter,
  CODEX_MANAGED_PROVIDER_SUPPORT,
  type CodexAdapterOptions,
  type CodexMcpOpenInput,
  type CodexRemoteRuntime
} from "./adapter.js";
import type { CodexSmartRoutingPreparation } from "./smart-subagent-routing.js";
import { AppServerHost } from "./host.js";
import { TransportFault } from "./errors.js";
import type { JsonObject } from "./protocol.js";
import { FakeCodexAppServer } from "./testing.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("CodexBackendAdapter", () => {
  it("keeps managed routes on the original thread, authorizes only the active operation, and adopts revisions before new input", async () => {
    let revision = "1";
    let enabled = true;
    const model: ProviderModel = { providerId: "custom", modelId: "custom-model", displayName: "Custom", api: "openai-responses", contextWindow: 0, maxOutputTokens: 0, supportsImages: false, supportsFastMode: false, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const released = vi.fn();
    const retired = vi.fn();
    const operations: Parameters<ManagedProviderRouteBinding["activate"]>[0][] = [];
    const port: ManagedProviderRuntimePort = {
      support: CODEX_MANAGED_PROVIDER_SUPPORT, environment: { JOKO_PROVIDER_PROXY_TOKEN: "private-fixture-token" }, secretEnvironmentNames: ["JOKO_PROVIDER_PROXY_TOKEN"],
      dispose: retired, hasProvider: (id) => id === "custom", listModels: () => enabled ? [model] : [], listProviders: () => [], getThinkingLevelMap: () => ({}),
      prepare: vi.fn(async (owner: Parameters<ManagedProviderRuntimePort["prepare"]>[0]): Promise<ManagedProviderRouteBinding> => {
        expect(owner).toMatchObject({ backendId: "codex-test", backendInstanceGeneration: 7, targetId: "target-codex", sessionId: "session-codex", sessionGeneration: 1, providerId: "custom", modelId: "custom-model" });
        if (!enabled) throw new Error("route disabled");
        const captured = revision;
        let disposed = false;
        return {
          providerId: "custom", model, protocol: "openai-responses", revision: captured, baseUrl: `http://127.0.0.1:1234/managed/route-${captured}`, apiKeyEnvironment: "JOKO_PROVIDER_PROXY_TOKEN", thinkingLevelMap: {},
          assertCurrent: () => { if (disposed || captured !== revision || !enabled) throw new Error("route changed"); },
          activate: async (operation) => { operation.assertCurrent(); operations.push(operation); return { release: released }; },
          dispose: () => { disposed = true; }
        };
      })
    };
    const setup = await createSetup(7, { managedProviders: port });
    const binding = await setup.adapter.createSession({ ...sessionInput(setup.target), providerId: model.providerId, modelId: model.modelId }, context(setup.target, [], { backendInstanceGeneration: 7 }));
    const nativeStart = setup.fake.transport!.requests.find((request) => request.method === "thread/start")!;
    expect(nativeStart.params).toMatchObject({ modelProvider: "custom", config: { model_providers: { custom: { env_key: "JOKO_PROVIDER_PROXY_TOKEN", wire_api: "responses", request_max_retries: 0 } }, "shell_environment_policy.exclude": ["JOKO_PROVIDER_PROXY_TOKEN"] } });
    expect(JSON.stringify(nativeStart)).not.toContain("private-fixture-token");
    const operationContext = (id: string) => context(setup.target, [], { binding, backendInstanceGeneration: 7, operationId: id });
    await setup.adapter.send(prompt("first"), operationContext("one"));
    expect(operations).toHaveLength(1);
    revision = "2";
    expect(() => operations[0]!.assertCurrent()).not.toThrow();
    await setup.adapter.send({ ...prompt("steer"), disposition: "steer" }, operationContext("steer"));
    expect(operations).toHaveLength(1);
    await setup.fake.completeTurn(binding.nativeSessionId!, "done");
    expect(released).toHaveBeenCalledTimes(1);
    expect(() => operations[0]!.assertCurrent()).toThrow();
    await setup.adapter.send(prompt("second"), operationContext("two"));
    const requests = setup.fake.transport!.requests;
    const resumeIndex = requests.findIndex((request) => request.method === "thread/resume");
    expect(requests.slice(0, resumeIndex).at(-1)?.method).toBe("thread/unsubscribe");
    expect(requests[resumeIndex]?.params).toMatchObject({ threadId: binding.nativeSessionId, modelProvider: "custom", model: "custom-model", config: { model_providers: { custom: { base_url: "http://127.0.0.1:1234/managed/route-2" } } } });
    expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(1);
    expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
    await setup.fake.completeTurn(binding.nativeSessionId!, "done again");
    enabled = false;
    await expect(setup.adapter.send(prompt("retained input"), operationContext("three"))).rejects.toThrow();
    expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
    await setup.adapter.dispose();
    expect(retired).toHaveBeenCalledOnce();
  });

  it("installs one smart route on the original thread and retains its operation through descendant completion", async () => {
    const released = vi.fn();
    const retired = vi.fn();
    const routeDisposed = vi.fn();
    const bindRoot = vi.fn<ManagedProviderSmartRoutingBinding["bindRoot"]>();
    const registerDescendant = vi.fn<ManagedProviderSmartRoutingBinding["registerDescendant"]>();
    const completeDescendant = vi.fn<ManagedProviderSmartRoutingBinding["completeDescendant"]>();
    const operations: Parameters<ManagedProviderSmartRoutingBinding["activate"]>[0][] = [];
    let routeCurrent = true;
    const routes = [{ providerId: "custom", modelId: "worker-model", revision: "provider-a", native: false }] as const;
    const nativeRoutes = [{ providerId: "openai", modelId: "gpt-5.6-sol", revision: "native-a", native: true }] as const;
    const proxyRoutes = [...routes, ...nativeRoutes] as const;
    let returnedRoutes: ManagedProviderSmartRoutingBinding["routes"] = proxyRoutes;
    const prepareSmartRouting = vi.fn(async (
      owner: Parameters<NonNullable<ManagedProviderRuntimePort["prepareSmartRouting"]>>[0]
    ): Promise<ManagedProviderSmartRoutingBinding> => {
      expect(owner).toMatchObject({
        backendId: "codex-test",
        backendInstanceGeneration: 7,
        targetId: "target-codex",
        sessionId: "session-codex",
        sessionGeneration: 1,
        nativeProviderId: "openai",
        rootProviderId: "openai",
        rootModelId: "gpt-test",
        revision: "catalog-a",
        routes: proxyRoutes
      });
      return {
        modelProviderId: "joko-smart-fixture",
        baseUrl: "http://127.0.0.1:1234/smart/fixture",
        proxyTokenEnvironment: "JOKO_PROVIDER_PROXY_TOKEN",
        revision: "catalog-a",
        routes: returnedRoutes,
        assertCurrent: () => { if (!routeCurrent) throw new Error("route changed"); },
        bindRoot,
        registerDescendant,
        completeDescendant,
        activate: async (operation) => {
          operation.assertCurrent();
          operations.push(operation);
          return { release: released };
        },
        dispose: routeDisposed
      };
    });
    const port: ManagedProviderRuntimePort = {
      support: CODEX_MANAGED_PROVIDER_SUPPORT,
      environment: { JOKO_PROVIDER_PROXY_TOKEN: "private-fixture-token" },
      secretEnvironmentNames: ["JOKO_PROVIDER_PROXY_TOKEN"],
      dispose: retired,
      hasProvider: () => false,
      listModels: () => [],
      listProviders: () => [],
      getThinkingLevelMap: () => ({}),
      prepare: async () => { throw new Error("ordinary route must not be prepared"); },
      prepareSmartRouting
    };
    const cleanup = vi.fn(async () => undefined);
    const smartRouting: CodexSmartRoutingPreparation = {
      desired: true,
      applied: true,
      revision: "catalog-a",
      routes,
      nativeRoutes,
      launchArgs: ["-c", "fixture=true"],
      catalogPath: "C:/private/catalog.json",
      unavailableReason: "",
      cleanup
    };
    const setup = await createSetup(7, { managedProviders: port, smartRouting });
    const descriptor = await setup.adapter.describe();
    expect(descriptor.capabilities.get("subagents.smart_routing")).toMatchObject({ supported: true });
    returnedRoutes = [{ ...routes[0], modelId: "forged-worker-model" }];
    await expect(setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, [], { backendInstanceGeneration: 7, operationId: "mismatched-smart-create" })
    )).rejects.toMatchObject({ publicError: { code: "CODEX_SMART_ROUTING_UNAVAILABLE" } });
    expect(setup.fake.transport!.requests.some((request) => request.method === "thread/start")).toBe(false);
    returnedRoutes = proxyRoutes;
    routeDisposed.mockClear();
    const events: EventPayload[] = [];
    let rejectProjection = false;
    const emit: AdapterContext["emit"] = async (event) => {
      events.push(event);
      if (rejectProjection) throw new Error("fixture projection failure");
    };
    const createContext = {
      ...context(setup.target, events, { backendInstanceGeneration: 7 }),
      emit
    };
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      createContext
    );
    expect(bindRoot).toHaveBeenCalledExactlyOnceWith({
      threadId: binding.nativeSessionId,
      providerId: "openai",
      modelId: "gpt-test"
    });
    const nativeStart = setup.fake.transport!.requests.find((request) => request.method === "thread/start")!;
    expect(nativeStart.params).toMatchObject({
      modelProvider: "joko-smart-fixture",
      model: "gpt-test",
      config: {
        model_providers: {
          "joko-smart-fixture": {
            base_url: "http://127.0.0.1:1234/smart/fixture",
            wire_api: "responses",
            requires_openai_auth: true,
            env_http_headers: { "x-joko-provider-proxy-token": "JOKO_PROVIDER_PROXY_TOKEN" },
            supports_websockets: false,
            request_max_retries: 0,
            stream_max_retries: 0
          }
        },
        "shell_environment_policy.exclude": ["JOKO_PROVIDER_PROXY_TOKEN"]
      }
    });
    expect(JSON.stringify(nativeStart)).not.toContain("private-fixture-token");

    const active = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "smart-root-operation"
    });
    await setup.adapter.send(prompt("delegate"), { ...active, emit });
    expect(operations).toHaveLength(1);
    const rootThreadId = binding.nativeSessionId!;
    const childThreadId = "smart-child-thread";
    rejectProjection = true;
    await expect(setup.fake.transport!.emitNotification("item/started", {
      threadId: rootThreadId,
      turnId: "turn-1",
      item: {
        type: "collabAgentToolCall",
        id: "smart-spawn-call",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: rootThreadId,
        receiverThreadIds: [childThreadId],
        agentsStates: { [childThreadId]: { status: "running", message: null } },
        prompt: "Inspect independently",
        model: "worker-model",
        reasoningEffort: "low"
      }
    })).rejects.toThrow("fixture projection failure");
    rejectProjection = false;
    expect(registerDescendant).toHaveBeenCalledWith(childThreadId, rootThreadId);
    await setup.fake.transport!.emitNotification("thread/started", {
      thread: { id: childThreadId, parentThreadId: rootThreadId, agentRole: "worker", agentNickname: "Scout" }
    });
    await setup.fake.transport!.emitNotification("turn/started", {
      threadId: childThreadId,
      turn: { id: "smart-child-turn", status: "inProgress", items: [], error: null }
    });
    await setup.fake.completeTurn(rootThreadId);
    expect(released).not.toHaveBeenCalled();

    rejectProjection = true;
    await expect(setup.fake.transport!.emitNotification("turn/completed", {
      threadId: childThreadId,
      turn: { id: "smart-child-turn", status: "completed", items: [], error: null }
    })).rejects.toThrow("fixture projection failure");
    rejectProjection = false;
    expect(completeDescendant).toHaveBeenCalledWith(childThreadId);
    expect(released).toHaveBeenCalledTimes(1);

    routeCurrent = false;
    await expect(setup.adapter.send(prompt("stale route"), {
      ...active,
      operationId: "stale-smart-operation"
    })).rejects.toMatchObject({ publicError: { code: "CODEX_SMART_ROUTING_UNAVAILABLE" } });
    expect(setup.fake.transport!.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    await setup.fake.transport!.exit();
    expect(routeDisposed).toHaveBeenCalledOnce();
    await setup.adapter.dispose();
    expect(routeDisposed).toHaveBeenCalledOnce();
    expect(retired).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    ["codex/0.153.3", true, 1, false, false, "requires the audited Codex app-server"],
    ["codex/0.153.4", true, 2, true, true, ""],
    ["codex/0.153.4", false, 1, false, true, "native account is unavailable"]
  ] as const)("probes runtime %s without smart flags before deciding its process generation", async (
    userAgent,
    nativeAccountAvailable,
    expectedStarts,
    expectedApplied,
    expectedCapability,
    unavailableReason
  ) => {
    const fake = new FakeCodexAppServer();
    fake.userAgent = userAgent;
    if (!nativeAccountAvailable) fake.account = null;
    let starts = 0;
    const route = { providerId: "openai", modelId: "native-worker", revision: "native-a", native: true } as const;
    const managedProviders: ManagedProviderRuntimePort = {
      support: CODEX_MANAGED_PROVIDER_SUPPORT,
      environment: { JOKO_PROVIDER_PROXY_TOKEN: "private-fixture-token" },
      secretEnvironmentNames: ["JOKO_PROVIDER_PROXY_TOKEN"],
      dispose: () => undefined,
      hasProvider: () => false,
      listModels: () => [],
      listProviders: () => [],
      getThinkingLevelMap: () => ({}),
      prepare: async () => { throw new Error("ordinary route must not be prepared"); },
      prepareSmartRouting: async () => { throw new Error("smart route must not be prepared during probe"); }
    };
    const adapter = new CodexBackendAdapter({
      id: "codex-probe",
      instanceGeneration: 1,
      managedProviders,
      appServer: { transportFactory: () => { starts += 1; return fake.createTransport(); } },
      smartRouting: {
        desired: true,
        applied: true,
        revision: "catalog-a",
        routes: [route],
        nativeRoutes: [],
        launchArgs: ["-c", "fixture=true"],
        unavailableReason: "",
        cleanup: async () => undefined
      }
    });
    cleanups.push(() => adapter.dispose());

    const descriptor = await adapter.describe();

    expect(starts).toBe(expectedStarts);
    expect(adapter.subagentSmartRoutingState()).toMatchObject({
      desired: true,
      applied: expectedApplied,
      runtimeRevision: "catalog-a",
      unavailableReason: expectedApplied ? "" : expect.stringContaining(unavailableReason)
    });
    expect(descriptor.capabilities.get("subagents.smart_routing")).toMatchObject({
      supported: expectedCapability,
      ...(expectedCapability ? {} : { reason: "upstream_missing" })
    });
  });

  it("starts the managed-only smart generation when the exact runtime has no native account", async () => {
    const fake = new FakeCodexAppServer();
    fake.account = null;
    let starts = 0;
    const managedProviders: ManagedProviderRuntimePort = {
      support: CODEX_MANAGED_PROVIDER_SUPPORT,
      environment: { JOKO_PROVIDER_PROXY_TOKEN: "private-fixture-token" },
      secretEnvironmentNames: ["JOKO_PROVIDER_PROXY_TOKEN"],
      dispose: () => undefined,
      hasProvider: () => true,
      listModels: () => [],
      listProviders: () => [],
      getThinkingLevelMap: () => ({}),
      prepare: async () => { throw new Error("ordinary route must not be prepared"); },
      prepareSmartRouting: async () => { throw new Error("smart route must not be prepared during probe"); }
    };
    const adapter = new CodexBackendAdapter({
      id: "codex-managed-only-probe",
      instanceGeneration: 1,
      managedProviders,
      appServer: { transportFactory: () => { starts += 1; return fake.createTransport(); } },
      smartRouting: {
        desired: true,
        applied: true,
        revision: "native-catalog",
        routes: [{ providerId: "openai", modelId: "native-worker", revision: "native-a", native: true }],
        nativeRoutes: [{ providerId: "openai", modelId: "gpt-5.6-sol", revision: "native-a", native: true }],
        launchArgs: ["-c", "catalog=native"],
        managedOnly: {
          revision: "managed-catalog",
          routes: [{ providerId: "managed", modelId: "managed-worker", revision: "managed-a", native: false }],
          nativeRoutes: [],
          launchArgs: ["-c", "catalog=managed"],
          catalogPath: "C:/private/managed-catalog.json"
        },
        managedOnlyInspection: { revision: "managed-catalog", candidateCount: 1, unavailableReason: "" },
        unavailableReason: "",
        cleanup: async () => undefined
      }
    });
    cleanups.push(() => adapter.dispose());

    const descriptor = await adapter.describe();

    expect(starts).toBe(2);
    expect(adapter.subagentSmartRoutingState()).toMatchObject({
      desired: true,
      applied: true,
      runtimeRevision: "managed-catalog",
      unavailableReason: ""
    });
    expect(descriptor.capabilities.get("subagents.smart_routing")).toMatchObject({ supported: true });
  });

  it("rejects every unsupported mention kind before native dispatch", async () => {
    const setup = await createSetup();
    const binding = await setup.adapter.createSession(sessionInput(setup.target), context(setup.target, [], { backendInstanceGeneration: 7 }));
    for (const mention of [
      { kind: "workspace_directory", label: "source", reference: "src" },
      {
        kind: "resource",
        label: "Skill",
        reference: "resource-one",
        discoveredRevision: "sha256:resource-one",
        resourceVersion: "1",
        runtimeGeneration: 1
      },
      {
        kind: "artifact",
        label: "Export",
        reference: "artifact-one",
        sourceSessionId: "session-artifact-source"
      },
      { kind: "workspace_file", label: "lines", reference: "src/main.ts", lineRange: { startLine: 1, endLine: 2 } }
    ] as const) {
      await expect(setup.adapter.send({ ...prompt(""), mentions: [mention] }, context(setup.target, [], { binding, backendInstanceGeneration: 7, operationId: "unsupported-mention" })))
        .rejects.toMatchObject({ publicError: { code: "CODEX_MENTION_KIND_UNSUPPORTED", stateMayHaveChanged: false } });
    }
    expect(setup.fake.transport?.requests.filter((request) => request.method === "turn/start")).toEqual([]);
  });

  it("resolves a canonical Artifact through its service authority and rechecks it at native dispatch", async () => {
    const bytes = Buffer.from("canonical artifact", "utf8");
    const sourceSessionId = "session-artifact-source";
    let artifactPath = "";
    let current = true;
    const assertCurrent = vi.fn(() => { if (!current) throw new Error("retired authority"); });
    const resolveArtifactMention = vi.fn(async () => ({
      blob: {
        id: "artifact-one",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
        mimeType: "text/plain",
        fileName: "report.txt"
      },
      path: artifactPath,
      assertCurrent
    }));
    const setup = await createSetup(7, { resolveArtifactMention });
    artifactPath = join(setup.target.workspaceRoot, "canonical-artifact.txt");
    await writeFile(artifactPath, bytes);
    const descriptor = await setup.adapter.describe();
    expect(descriptor.capabilities.get("input.mention")).toMatchObject({
      supported: true,
      options: ["workspace_file", "artifact"]
    });
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, [], { backendInstanceGeneration: 7 })
    );
    const owner = context(setup.target, [], {
      binding,
      backendInstanceGeneration: 7,
      operationId: "canonical-artifact"
    });
    await expect(setup.adapter.send({
      ...prompt("Inspect lines"),
      mentions: [{
        kind: "artifact",
        label: "Report",
        reference: "artifact-one",
        sourceSessionId,
        lineRange: { startLine: 1, endLine: 2 }
      } as unknown as MentionInput]
    }, { ...owner, operationId: "artifact-line-range" })).rejects.toMatchObject({
      publicError: { code: "CODEX_ARTIFACT_REFERENCE_INVALID", stateMayHaveChanged: false }
    });
    expect(resolveArtifactMention).not.toHaveBeenCalled();
    await setup.adapter.send({
      ...prompt("Inspect"),
      mentions: [{ kind: "artifact", label: "Report", reference: "artifact-one", sourceSessionId }]
    }, owner);
    expect(resolveArtifactMention).toHaveBeenCalledWith("artifact-one", sourceSessionId, owner, owner.signal);
    expect(assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(setup.fake.transport?.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      input: [{
        type: "text",
        text: `Inspect\n\nArtifact reference: ${JSON.stringify({ name: "Report", path: artifactPath })}`,
        text_elements: []
      }]
    });
    await setup.fake.completeTurn(binding.nativeSessionId!, "done");

    const transport = setup.fake.transport!;
    const request = transport.request.bind(transport);
    transport.request = async (...args: Parameters<typeof transport.request>) => {
      if (args[0] === "turn/start") current = false;
      return request(...args);
    };
    await expect(setup.adapter.send({
      ...prompt("Again"),
      mentions: [{ kind: "artifact", label: "Report", reference: "artifact-one", sourceSessionId }]
    }, { ...owner, operationId: "retired-artifact" })).rejects.toMatchObject({
      message: "The referenced Artifact changed in its source task while input was prepared.",
      publicError: { code: "CODEX_ARTIFACT_UNAVAILABLE", stateMayHaveChanged: false }
    });
    expect(setup.fake.transport?.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
  });

  it("rejects an Artifact whose service-owned file no longer matches its immutable digest", async () => {
    const expected = Buffer.from("expected", "utf8");
    let artifactPath = "";
    const setup = await createSetup(7, {
      resolveArtifactMention: async () => ({
        blob: {
          id: "artifact-tampered",
          sha256: createHash("sha256").update(expected).digest("hex"),
          byteLength: expected.byteLength,
          mimeType: "text/plain"
        },
        path: artifactPath,
        assertCurrent: () => undefined
      })
    });
    artifactPath = join(setup.target.workspaceRoot, "tampered-artifact.txt");
    await writeFile(artifactPath, "tampered", "utf8");
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, [], { backendInstanceGeneration: 7 })
    );
    await expect(setup.adapter.send({
      ...prompt("Inspect"),
      mentions: [{
        kind: "artifact",
        label: "Report",
        reference: "artifact-tampered",
        sourceSessionId: "session-artifact-source"
      }]
    }, context(setup.target, [], {
      binding,
      backendInstanceGeneration: 7,
      operationId: "tampered-artifact"
    }))).rejects.toMatchObject({
      publicError: { code: "CODEX_FILE_INTEGRITY_FAILED", stateMayHaveChanged: false }
    });
    expect(setup.fake.transport?.requests.filter((request) => request.method === "turn/start")).toEqual([]);
  });

  it("probes stable account/models, drains pre-subscription events, and translates a complete turn", async () => {
    const setup = await createSetup();
    setup.fake.emitNameBeforeStartResponse = true;
    const descriptor = await setup.adapter.describe();
    expect(descriptor).toMatchObject({
      id: "codex-test",
      adapterKind: "codex",
      instanceGeneration: 7,
      version: "0.153.4",
      health: "healthy",
      authenticationState: "authenticated"
    });
    expect(descriptor.models).toHaveLength(1);
    expect(descriptor.capabilities.size).toBe(CAPABILITIES.length);
    expect(descriptor.capabilities.get("input.mention")).toMatchObject({ supported: true, options: ["workspace_file"] });
    expect(descriptor.capabilities.get("session.catalog")?.supported).toBe(true);
    expect(descriptor.capabilities.get("turn.steer")?.supported).toBe(true);
    expect(descriptor.capabilities.get("model.effort")?.supported).toBe(true);
    expect(descriptor.capabilities.get("model.fast_mode")?.supported).toBe(true);
    expect(descriptor.capabilities.get("provider.account_usage")?.supported).toBe(true);
    expect(descriptor.capabilities.get("review.isolated")).toMatchObject({
      supported: true
    });
    expect(descriptor.capabilities.get("plan_mode")?.supported).toBe(true);
    expect(descriptor.capabilities.get("background.tasks")?.supported).toBe(true);
    expect(descriptor.capabilities.get("subagents.list")?.supported).toBe(true);
    expect(descriptor.capabilities.get("subagents.detail")?.supported).toBe(true);
    expect(descriptor.capabilities.get("subagents.transcript")?.supported).toBe(true);
    expect(descriptor.capabilities.get("subagents.stop")).toMatchObject({
      supported: false,
      reason: "not_implemented"
    });
    expect(descriptor.providers).toEqual([expect.objectContaining({
      accessKind: "subscription",
      accessProduct: "ChatGPT",
      providesModelPricing: true
    })]);
    const initialize = setup.fake.transport?.requests.find((request) => request.method === "initialize");
    expect(initialize?.params).toMatchObject({ capabilities: { experimentalApi: true, requestAttestation: false } });
    expect(setup.fake.transport?.notifications).toContainEqual({ method: "initialized" });

    const events: EventPayload[] = [];
    const createContext = context(setup.target, events, { backendInstanceGeneration: 7 });
    const binding = await setup.adapter.createSession(sessionInput(setup.target), createContext);
    expect(events).toContainEqual({ type: "session_changed" });

    const attachmentPath = join(setup.target.workspaceRoot, "notes.txt");
    await writeFile(attachmentPath, "notes", "utf8");
    const sendContext = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "operation-one"
    });
    await setup.adapter.send({
      text: "work on this",
      images: [],
      files: [{
        blob: { id: "blob-file", sha256: createHash("sha256").update("notes").digest("hex"), byteLength: 5, mimeType: "text/plain", fileName: "notes\"\n.txt" },
        workspacePath: "notes.txt"
      }],
      mentions: [{ kind: "workspace_file", label: "Notes\"\nreference", reference: "notes.txt" }],
      disposition: "prompt"
    }, sendContext);
    const turnStart = setup.fake.transport?.requests.find((request) => request.method === "turn/start");
    expect(turnStart?.params).toMatchObject({ clientUserMessageId: "operation-one" });
    expect((turnStart?.params as JsonObject | undefined)?.["input"]).toEqual([{
      type: "text",
      text: [
        "work on this",
        `Attached file: ${JSON.stringify({ name: "notes\"\n.txt", path: attachmentPath })}`,
        `Workspace file reference: ${JSON.stringify({ name: "Notes\"\nreference", path: attachmentPath })}`
      ].join("\n\n"),
      text_elements: []
    }]);
    expect(JSON.stringify((turnStart?.params as JsonObject | undefined)?.["input"])).not.toContain('"type":"mention"');

    await setup.fake.completeTurn(binding.nativeSessionId!, "hello from fake");
    expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "hello from fake" }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "message_complete",
      role: "assistant",
      nativeHistory: { identity: { entryId: "item-turn-1" } }
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: "usage" }));
    expect(events.at(-1)).toEqual({ type: "done", outcome: "completed" });
  });

  it("reconciles a lost turn/start response by clientUserMessageId without retrying", async () => {
    const setup = await createSetup();
    await setup.adapter.describe();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    setup.fake.timeoutNextTurnStart = true;
    await expect(setup.adapter.send({
      text: "lost response",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "durable-operation-lost-response"
    }))).resolves.toBeUndefined();
    expect(setup.fake.transport?.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    expect(setup.fake.threads.get(binding.nativeSessionId!)?.turns).toHaveLength(1);
    expect(setup.fake.transport?.requests.some((request) => request.method === "thread/read")).toBe(true);
  });

  it("keeps native completion events on the active dispatch context after inspection and history reads", async () => {
    const setup = await createSetup();
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, [], { backendInstanceGeneration: 7 })
    );
    const dispatchEvents: EventPayload[] = [];
    const dispatchContext = context(setup.target, dispatchEvents, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "active-dispatch"
    });
    await setup.adapter.send(prompt("keep the dispatch owner"), dispatchContext);

    const inspectEvents: EventPayload[] = [];
    await expect(setup.adapter.inspectSession(binding, context(setup.target, inspectEvents, {
      binding,
      backendInstanceGeneration: 7
    }))).resolves.toMatchObject({ streaming: true });
    const historyEvents: EventPayload[] = [];
    await setup.adapter.getNativeHistoryProjection(context(setup.target, historyEvents, {
      binding,
      backendInstanceGeneration: 7
    }));

    await setup.fake.completeTurn(binding.nativeSessionId!, "owned completion");

    expect(dispatchEvents).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "owned completion" }));
    expect(dispatchEvents).toContainEqual(expect.objectContaining({ type: "message_complete", role: "assistant" }));
    expect(dispatchEvents).toContainEqual(expect.objectContaining({ type: "usage" }));
    expect(dispatchEvents.at(-1)).toEqual({ type: "done", outcome: "completed" });
    expect(inspectEvents).toEqual([]);
    expect(historyEvents).toEqual([]);
  });

  it("keeps an accepted send unknown when its complete history lookup becomes stale without resending input", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(sessionInput(setup.target), context(setup.target, events, { backendInstanceGeneration: 7 }));
    setup.fake.timeoutNextTurnStart = true;
    const transport = setup.fake.transport!;
    const request = transport.request.bind(transport);
    vi.spyOn(transport, "request").mockImplementation(async (method, params, options) => {
      const result = await request(method, params, options);
      if (method === "thread/turns/list") await transport.emitNotification("thread/reverted", { threadId: binding.nativeSessionId! });
      return result;
    });
    await expect(setup.adapter.send(prompt("Keep the unconfirmed input"), context(setup.target, events, {
      binding, backendInstanceGeneration: 7, operationId: "unconfirmed-paginated-send"
    }))).rejects.toMatchObject({ publicError: { code: "CODEX_DISPATCH_UNKNOWN", stateMayHaveChanged: true, retryable: false } });
    expect(transport.requests.filter((value) => value.method === "turn/start")).toHaveLength(1);
    expect(transport.requests.filter((value) => value.method === "turn/steer")).toHaveLength(0);
    expect(setup.fake.threads.get(binding.nativeSessionId!)!.turns).toHaveLength(1);
  });

  it("reconciles a malformed accepted turn/start response through the durable client id", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    setup.fake.malformedNextTurnStartResponse = true;
    await expect(setup.adapter.send({
      text: "malformed accepted response",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "malformed-response-reconciled"
    }))).resolves.toBeUndefined();
    expect(setup.fake.transport?.requests.some((request) => request.method === "thread/read")).toBe(true);
  });

  it("classifies an unprovable malformed accepted response as dispatch unknown", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    setup.fake.malformedNextTurnStartResponse = true;
    setup.fake.dropNextTurnClientId = true;
    await expect(setup.adapter.send({
      text: "unprovable accepted response",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "malformed-response-unknown"
    }))).rejects.toMatchObject({
      publicError: { code: "CODEX_DISPATCH_UNKNOWN", stateMayHaveChanged: true, retryable: false }
    });
  });

  it("does not reconcile an accepted response against a foreign native thread", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    setup.fake.malformedNextTurnStartResponse = true;
    setup.fake.nextThreadReadOverride = {
      id: "foreign-thread",
      cwd: setup.target.workspaceRoot,
      turns: [{
        id: "foreign-turn",
        status: "inProgress",
        items: [{
          type: "userMessage",
          id: "foreign-message",
          clientId: "foreign-reconciliation"
        }]
      }]
    };
    await expect(setup.adapter.send({
      text: "do not trust a foreign thread",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "foreign-reconciliation"
    }))).rejects.toMatchObject({ publicError: { code: "CODEX_DISPATCH_UNKNOWN" } });
  });

  it("does not revive a turn completed before the turn/start response", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const active = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "terminal-before-response"
    });
    setup.fake.completeTurnBeforeStartResponse = true;
    await setup.adapter.send({
      text: "complete before response",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, active);
    expect(events.filter((event) => event.type === "done")).toEqual([{ type: "done", outcome: "completed" }]);

    await setup.adapter.abort(active);
    expect(setup.fake.transport?.requests.filter((request) => request.method === "turn/interrupt")).toHaveLength(0);
  });

  it("defaults an unowned server approval to the stable safe cancel decision", async () => {
    const setup = await createSetup();
    await setup.host.ensureStarted();
    const threadId = "unowned-thread";
    setup.fake.threads.set(threadId, {
      id: threadId,
      historyMode: "paginated",
      cwd: setup.target.workspaceRoot,
      name: null,
      turns: [],
      status: { type: "idle" },
      createdAt: 1,
      updatedAt: 1,
      config: {}
    });
    await expect(setup.fake.requestCommandApproval(threadId, "turn-unowned")).resolves.toEqual({ decision: "cancel" });
  });

  it("never fabricates a denial decision excluded by availableDecisions", async () => {
    const setup = await createSetup();
    await setup.host.ensureStarted();
    const threadId = "unowned-restricted-thread";
    setup.fake.threads.set(threadId, {
      id: threadId,
      historyMode: "paginated",
      cwd: setup.target.workspaceRoot,
      name: null,
      turns: [],
      status: { type: "idle" },
      createdAt: 1,
      updatedAt: 1,
      config: {}
    });
    await expect(setup.fake.requestCommandApproval(threadId, "turn-unowned", ["accept"]))
      .rejects.toMatchObject({ rpcCode: -32602 });
  });

  it("rechecks Backend instance generation after a pending approval decision", async () => {
    let releaseDecision: ((decision: InteractionDecision) => void) | undefined;
    let interactionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { interactionStarted = resolve; });
    const setup = await createSetup(11);
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 11 })
    );
    const decisionContext = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 11,
      operationId: "approval-generation",
      requestInteraction: async () => {
        interactionStarted?.();
        return new Promise<InteractionDecision>((resolve) => { releaseDecision = resolve; });
      }
    });
    await setup.adapter.send({
      text: "start an approval turn",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, decisionContext);
    const approval = setup.fake.requestCommandApproval(binding.nativeSessionId!, "turn-1");
    await started;

    Object.defineProperty(decisionContext, "backendInstanceGeneration", { value: 12 });
    releaseDecision?.({ kind: "selected", value: "allow_once" });
    await expect(approval).resolves.toEqual({ decision: "cancel" });
  });

  it("refuses secret native user input without opening a durable Interaction", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    let interactionCount = 0;
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const active = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "secret-question-turn",
      requestInteraction: async () => {
        interactionCount += 1;
        return { kind: "question", answers: { secret: { kind: "text", value: "must-not-be-persisted" } } };
      }
    });
    await setup.adapter.send({
      text: "request a credential",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, active);

    await expect(setup.fake.requestUserInput(binding.nativeSessionId!, "turn-1", [{
      id: "secret",
      question: "Token?",
      isSecret: true
    }])).resolves.toEqual({ answers: { secret: { answers: [] } } });
    expect(interactionCount).toBe(0);
  });

  it("fails closed when the app-server resolves a pending approval before the user", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    let releaseDecision: ((decision: InteractionDecision) => void) | undefined;
    let interactionSignal: AbortSignal | undefined;
    let interactionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { interactionStarted = resolve; });
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const active = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "resolved-approval-turn",
      requestInteraction: async (_interaction, requestOptions) => {
        interactionSignal = requestOptions?.signal;
        interactionStarted?.();
        return new Promise<InteractionDecision>((resolve) => { releaseDecision = resolve; });
      }
    });
    await setup.adapter.send({
      text: "start a pending approval",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, active);
    const approval = setup.fake.requestCommandApproval(binding.nativeSessionId!, "turn-1");
    await started;
    const requestId = setup.fake.transport?.lastServerRequestId;
    expect(requestId).toBeDefined();
    await setup.fake.resolveServerRequest(binding.nativeSessionId!, requestId!);
    await expect(approval).resolves.toEqual({ decision: "cancel" });
    expect(interactionSignal?.aborted).toBe(true);

    releaseDecision?.({ kind: "selected", value: "allow_once" });
    await Promise.resolve();
    expect(setup.fake.transport?.lastServerRequestId).toBe(requestId);
  });

  it("denies approval requests that do not belong to the active turn", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    let interactionCount = 0;
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const active = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "terminal-approval-turn",
      requestInteraction: async () => {
        interactionCount += 1;
        return { kind: "selected", value: "allow_once" };
      }
    });
    await setup.adapter.send({
      text: "finish before approval",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, active);
    await setup.fake.completeTurn(binding.nativeSessionId!);

    await expect(setup.fake.requestCommandApproval(binding.nativeSessionId!, "turn-1"))
      .resolves.toEqual({ decision: "cancel" });
    expect(interactionCount).toBe(0);
  });

  it("does not advertise image input unless an immutable blob reader is configured", async () => {
    const setup = await createSetup();
    expect((await setup.adapter.describe()).capabilities.get("input.image")).toMatchObject({
      supported: false,
      reason: "not_implemented"
    });
    const withImages = new CodexBackendAdapter({
      id: "codex-images",
      instanceGeneration: 8,
      host: setup.host,
      readBlob: async () => ({ data: new Uint8Array([1]), mimeType: "image/png" })
    });
    cleanups.push(() => withImages.dispose());
    expect((await withImages.describe()).capabilities.get("input.image")?.supported).toBe(true);
  });

  it("rejects oversized user or generated prompt text before native mutation dispatch", async () => {
    const setup = await createSetup(7, { maximumPromptTextBytes: 8 });
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const before = setup.fake.transport?.requests.filter((request) => request.method === "turn/start").length ?? 0;
    await expect(setup.adapter.send({
      text: "this prompt is too large",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "oversized-prompt"
    }))).rejects.toMatchObject({ publicError: { code: "CODEX_PROMPT_TOO_LARGE", stateMayHaveChanged: false } });
    const attachmentPath = join(setup.target.workspaceRoot, "bounded.txt");
    await writeFile(attachmentPath, "bounded", "utf8");
    await expect(setup.adapter.send({
      text: "",
      images: [],
      files: [{
        blob: { id: "bounded-file", sha256: createHash("sha256").update("bounded").digest("hex"), byteLength: 7, mimeType: "text/plain" },
        workspacePath: "bounded.txt"
      }],
      mentions: [],
      disposition: "prompt"
    }, context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "oversized-generated-prompt"
    }))).rejects.toMatchObject({ publicError: { code: "CODEX_PROMPT_TOO_LARGE", stateMayHaveChanged: false } });
    expect(setup.fake.transport?.requests.filter((request) => request.method === "turn/start")).toHaveLength(before);
  });

  it("fails typed and bounded on cyclic model and thread pagination cursors", async () => {
    const setup = await createSetup();
    setup.fake.modelNextCursor = "model-cycle";
    await expect(setup.adapter.listModels())
      .rejects.toMatchObject({ publicError: { code: "CODEX_MODEL_PAGINATION_INVALID" } });
    setup.fake.modelNextCursor = null;

    const events: EventPayload[] = [];
    await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    setup.fake.threadNextCursor = "thread-cycle";
    await expect(setup.adapter.listNativeSessions(setup.target))
      .rejects.toMatchObject({ publicError: { code: "CODEX_THREAD_PAGINATION_INVALID" } });
  });

  it("keeps local catalog scanning available when the executable is unavailable", async () => {
    const profileDirectory = await mkdtemp(join(tmpdir(), "joko-codex-offline-profile-"));
    cleanups.push(() => rm(profileDirectory, { recursive: true, force: true }));
    const adapter = new CodexBackendAdapter({
      id: "codex-missing",
      instanceGeneration: 9,
      profileDirectory,
      catalogProfileDirectories: [profileDirectory],
      appServer: {
        transport: {
          command: join(tmpdir(), `joko-codex-missing-${process.pid}`),
          requestTimeoutMs: 500
        }
      }
    });
    cleanups.push(() => adapter.dispose());
    const descriptor = await adapter.describe();
    expect(descriptor.installationState).toBe("not_installed");
    expect(descriptor.capabilities.size).toBe(CAPABILITIES.length);
    expect(descriptor.capabilities.get("session.catalog")).toEqual({
      key: "session.catalog",
      supported: true
    });
    expect(descriptor.capabilities.get("turn.stream")).toMatchObject({
      supported: false,
      reason: "upstream_missing"
    });
    await expect(adapter.scanNativeSessionCatalog()).resolves.toEqual({ entries: [], rejectedCount: 0 });
  });

  it("materializes an external profile task once and returns the active profile identity", async () => {
    const fixture = await catalogProfileFixture("11111111-1111-4111-8111-111111111111", true);
    const adapter = catalogOnlyAdapter(fixture.active, fixture.source);
    cleanups.push(() => adapter.dispose());

    const scanned = await adapter.scanNativeSessionCatalog();
    expect(scanned.entries).toHaveLength(1);
    const entry = scanned.entries[0]!;
    expect(entry).toMatchObject({
      nativeSessionId: fixture.nativeSessionId,
      createdAt: 1_000,
      modifiedAt: 2_000,
      placement: "dialogue"
    });

    const first = await adapter.bindCatalogSession(entry, 3);
    const second = await adapter.bindCatalogSession(entry, 3);
    expect(second).toEqual(first);
    expect(first.nativeSessionId).toBe(fixture.nativeSessionId);
    expect(first.opaqueRef).not.toBe(entry.nativeReference);

    const activeRow = readCatalogThread(fixture.active, fixture.nativeSessionId);
    expect(activeRow?.["rollout_path"]).toEqual(expect.any(String));
    const copied = String(activeRow?.["rollout_path"]);
    await expect(readFile(copied, "utf8")).resolves.toBe(fixture.rolloutContent);
    await expect(stat(copied)).resolves.toMatchObject({ size: Buffer.byteLength(fixture.rolloutContent) });
    const profileState = JSON.parse(await readFile(join(fixture.active, ".codex-global-state.json"), "utf8")) as {
      readonly "projectless-thread-ids"?: readonly string[];
    };
    expect(profileState["projectless-thread-ids"]).toContain(fixture.nativeSessionId);

    const rescanned = await adapter.scanNativeSessionCatalog();
    expect(rescanned.entries[0]?.nativeReference).toBe(first.opaqueRef);
  });

  it("fails closed when an external rollout changes after scanning", async () => {
    const fixture = await catalogProfileFixture("22222222-2222-4222-8222-222222222222", false);
    const adapter = catalogOnlyAdapter(fixture.active, fixture.source);
    cleanups.push(() => adapter.dispose());
    const entry = (await adapter.scanNativeSessionCatalog()).entries[0]!;

    await writeFile(fixture.sourceRollout, `${fixture.rolloutContent}changed\n`, "utf8");

    await expect(adapter.bindCatalogSession(entry, 2)).rejects.toMatchObject({
      publicError: { code: "CODEX_CATALOG_SOURCE_CHANGED" }
    });
  });

  it("fails closed when an active task row or rollout changes after scanning", async () => {
    const mutations = ["row", "rollout"] as const;
    for (const [index, mutation] of mutations.entries()) {
      const nativeSessionId = `66666666-6666-4666-8666-66666666666${index}`;
      const fixture = await catalogProfileFixture(nativeSessionId, false);
      const activeRollout = join(fixture.active, "sessions", `${nativeSessionId}.jsonl`);
      await mkdir(join(activeRollout, ".."), { recursive: true });
      await writeFile(activeRollout, fixture.rolloutContent, "utf8");
      insertCatalogThread(fixture.active, {
        nativeSessionId,
        rolloutPath: activeRollout,
        workspace: fixture.active,
        title: "Active native task",
        createdAt: 500,
        modifiedAt: 1_000
      });
      const adapter = catalogOnlyAdapter(fixture.active, fixture.source);
      cleanups.push(() => adapter.dispose());
      const entry = (await adapter.scanNativeSessionCatalog()).entries[0]!;
      expect(entry.title).toBe("Active native task");

      if (mutation === "rollout") {
        await writeFile(activeRollout, `${fixture.rolloutContent}changed\n`, "utf8");
      } else {
        const database = new DatabaseSync(join(fixture.active, "state_5.sqlite"));
        try {
          database.prepare("UPDATE threads SET title = ? WHERE id = ?")
            .run("Changed active task", nativeSessionId);
        } finally {
          database.close();
        }
      }

      await expect(adapter.scanNativeSessionCatalog()).resolves.toMatchObject({ entries: [{}] });
      await expect(adapter.bindCatalogSession(entry, 2)).rejects.toMatchObject({
        publicError: { code: "CODEX_CATALOG_SOURCE_CHANGED" }
      });
    }
  });

  it("does not overwrite a native identity that appears in the active profile after scanning", async () => {
    const fixture = await catalogProfileFixture("33333333-3333-4333-8333-333333333333", false);
    const adapter = catalogOnlyAdapter(fixture.active, fixture.source);
    cleanups.push(() => adapter.dispose());
    const entry = (await adapter.scanNativeSessionCatalog()).entries[0]!;
    const conflictingRollout = join(fixture.active, "sessions", "conflicting.jsonl");
    await mkdir(join(fixture.active, "sessions"), { recursive: true });
    await writeFile(conflictingRollout, "conflict\n", "utf8");
    insertCatalogThread(fixture.active, {
      nativeSessionId: fixture.nativeSessionId,
      rolloutPath: conflictingRollout,
      workspace: fixture.active,
      title: "conflict",
      createdAt: 1_000,
      modifiedAt: 2_000
    });

    await expect(adapter.bindCatalogSession(entry, 2)).rejects.toMatchObject({
      publicError: { code: "CODEX_CATALOG_TARGET_CONFLICT" }
    });
    await expect(readFile(conflictingRollout, "utf8")).resolves.toBe("conflict\n");
  });

  it("rejects a catalog publication path that traverses a symbolic link", async () => {
    const fixture = await catalogProfileFixture("44444444-4444-4444-8444-444444444444", false);
    const adapter = catalogOnlyAdapter(fixture.active, fixture.source);
    cleanups.push(() => adapter.dispose());
    const entry = (await adapter.scanNativeSessionCatalog()).entries[0]!;
    const outside = join(dirname(fixture.active), "outside");
    const sessions = join(fixture.active, "sessions");
    await mkdir(outside, { recursive: true });
    let linked = false;
    try {
      await symlink(outside, sessions, process.platform === "win32" ? "junction" : "dir");
      linked = true;
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("EPERM");
    }
    if (!linked) return;
    try {
      await expect(adapter.bindCatalogSession(entry, 2)).rejects.toMatchObject({
        publicError: { code: "CODEX_CATALOG_TARGET_CONFLICT" }
      });
      await expect(readdir(outside)).resolves.toEqual([]);
    } finally {
      await unlink(sessions);
    }
  });

  it("removes a newly published rollout when the state transaction fails", async () => {
    const fixture = await catalogProfileFixture("55555555-5555-4555-8555-555555555555", false);
    const adapter = catalogOnlyAdapter(fixture.active, fixture.source);
    cleanups.push(() => adapter.dispose());
    const entry = (await adapter.scanNativeSessionCatalog()).entries[0]!;
    const database = new DatabaseSync(join(fixture.active, "state_5.sqlite"));
    try {
      database.exec(`
        CREATE TRIGGER reject_catalog_insert
        BEFORE INSERT ON threads
        BEGIN
          SELECT RAISE(ABORT, 'blocked');
        END
      `);
    } finally {
      database.close();
    }

    await expect(adapter.bindCatalogSession(entry, 2)).rejects.toMatchObject({
      publicError: { code: "CODEX_CATALOG_MATERIALIZATION_UNAVAILABLE" }
    });
    const published = await readdir(join(fixture.active, "sessions", "catalog-imports"), {
      recursive: true
    }).catch(() => []);
    expect(published.filter((name) => name.endsWith(".jsonl"))).toEqual([]);
  });

  it("proves binding identity and native cwd before resolve, resume, or discovery", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const otherWorkspace = await mkdtemp(join(tmpdir(), "joko-codex-other-target-"));
    cleanups.push(() => rm(otherWorkspace, { recursive: true, force: true }));
    const otherTarget: TargetDescriptor = {
      ...setup.target,
      id: "target-codex-other",
      workspaceRoot: otherWorkspace
    };

    await expect(setup.adapter.resolveNativeSessionReference(binding.opaqueRef, otherTarget, 1))
      .rejects.toMatchObject({ publicError: { code: "CODEX_NATIVE_SESSION_TARGET_MISMATCH" } });
    const resumeCount = setup.fake.transport?.requests.filter((request) => request.method === "thread/resume").length ?? 0;
    await expect(setup.adapter.resumeSession(binding, context(otherTarget, events, {
      binding,
      backendInstanceGeneration: 7
    }))).rejects.toMatchObject({ publicError: { code: "CODEX_NATIVE_SESSION_TARGET_MISMATCH" } });
    expect(setup.fake.transport?.requests.filter((request) => request.method === "thread/resume")).toHaveLength(resumeCount);

    await expect(setup.adapter.resumeSession({
      ...binding,
      nativeSessionId: "conflicting-thread-id"
    }, context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7
    }))).rejects.toMatchObject({ publicError: { code: "CODEX_SESSION_BINDING_MISMATCH" } });

    setup.fake.threads.set("foreign-thread", {
      id: "foreign-thread",
      historyMode: "paginated",
      cwd: otherWorkspace,
      name: "Foreign",
      turns: [],
      status: { type: "idle" },
      createdAt: 1,
      updatedAt: 1,
      config: {}
    });
    const discovered = await setup.adapter.listNativeSessions(setup.target);
    expect(discovered.map((candidate) => candidate.nativeSessionId)).toEqual([binding.nativeSessionId]);
    expect(setup.fake.transport?.requests.findLast((request) => request.method === "thread/list")?.params)
      .toMatchObject({ cwd: setup.target.workspaceRoot, useStateDbOnly: true });
  });

  it("uses one independently fenced remote Host for discovery, subscribed runtime, text controls, and history", async () => {
    const setup = await createRemoteSetup();
    const nativeSessionId = setup.remoteFake.seedThread("/srv/joko-project", [historyTurn(0, "remote answer")]);
    const candidates = await setup.adapter.listNativeSessions(setup.target);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ nativeSessionId, workspaceRoot: "/srv/joko-project", messageCount: 0 });
    const binding = await setup.adapter.resolveNativeSessionReference(candidates[0]!.nativeReference, setup.target, 1);
    const events: EventPayload[] = [];
    const bound = context(setup.target, events, { binding, backendInstanceGeneration: 7 });
    const resumed = await setup.adapter.resumeSession(binding, bound);
    expect(resumed.binding).toEqual(binding);
    expect(setup.remoteFake.transport!.requests.filter((request) => request.method === "thread/resume")).toHaveLength(1);
    const projection = await setup.adapter.getNativeHistoryProjection(bound);
    expect(projection.events.length).toBeGreaterThan(0);

    await setup.adapter.send(prompt("remote prompt"), context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "remote-send"
    }));
    await setup.adapter.send({ ...prompt("remote steer"), disposition: "steer" }, context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "remote-steer"
    }));
    expect(setup.remoteFake.transport!.requests.find((request) => request.method === "turn/start")?.params)
      .toMatchObject({ threadId: nativeSessionId, cwd: "/srv/joko-project", clientUserMessageId: "remote-send" });
    expect(setup.remoteFake.transport!.requests.find((request) => request.method === "turn/steer")?.params)
      .toMatchObject({ threadId: nativeSessionId, expectedTurnId: "turn-1", clientUserMessageId: "remote-steer" });
    await setup.remoteFake.completeTurn(nativeSessionId, "remote completion");
    expect(events).toContainEqual({ type: "done", outcome: "completed" });

    await setup.adapter.setName("Remote task", bound);
    await setup.adapter.setModel("openai", "gpt-test", bound);
    await setup.adapter.setEffort("high", bound);
    await setup.adapter.setFastMode(true, bound);
    await setup.adapter.setPermissionMode("auto", bound);
    await setup.adapter.setPlanMode(true, bound);
    await setup.adapter.send(prompt("interrupt me"), context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "remote-interrupt-turn"
    }));
    await setup.adapter.abort(bound);
    expect(setup.remoteFake.transport!.requests.map((request) => request.method)).toEqual(expect.arrayContaining([
      "thread/name/set", "model/list", "thread/settings/update", "thread/resume", "turn/interrupt"
    ]));
    expect(setup.localFake.transport).toBeUndefined();
    expect(setup.resolveRemote).toHaveBeenCalled();
  });

  it("leaves remote Codex native-memory policy owned by the remote host", async () => {
    const resolveNativeMemoryEnabled = vi.fn(() => true);
    const setup = await createRemoteSetup({ resolveNativeMemoryEnabled });
    const nativeSessionId = setup.remoteFake.seedThread("/srv/joko-project");
    const candidate = (await setup.adapter.listNativeSessions(setup.target))[0]!;
    const binding = await setup.adapter.resolveNativeSessionReference(candidate.nativeReference, setup.target, 1);
    await setup.adapter.resumeSession(binding, context(setup.target, [], {
      binding,
      backendInstanceGeneration: 7
    }));
    expect(resolveNativeMemoryEnabled).not.toHaveBeenCalled();
    expect(setup.remoteFake.transport!.requests.some((request) =>
      request.method === "experimentalFeature/enablement/set")).toBe(false);
    expect(setup.remoteFake.memoryEnabledForThread(nativeSessionId)).toBe(false);
    await setup.adapter.send(prompt("remote host memory"), context(setup.target, [], {
      binding,
      backendInstanceGeneration: 7,
      operationId: "remote-host-memory"
    }));
    expect(setup.remoteFake.transport!.requests.findLast((request) => request.method === "turn/start")?.params)
      .toMatchObject({
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/private/memories"]
        }
    });
  });

  it("isolates local MCP config and binds the frozen route to active native turns", async () => {
    const opened: CodexMcpOpenInput[] = [];
    const released = vi.fn(async () => undefined);
    const setup = await createSetup(7, {
      localMcpBridge: async (input) => {
        opened.push(input);
        let retired = false;
        return {
          routes: [{
            serverId: "tools",
            name: "joko_local_tools",
            url: "http://127.0.0.1:4100/private-local"
          }],
          assertCurrent: () => {
            if (retired) throw new Error("local MCP route retired");
            input.assertSessionCurrent();
          },
          release: async () => {
            if (retired) return;
            retired = true;
            await released();
          }
        };
      }
    });
    setup.fake.reviewConfig = {
      mcp_servers: { docs: { command: "docs-server" } },
      plugins: { "plugin@local": { mcp_servers: { plugin_docs: { url: "https://example.invalid/mcp" } } } }
    };
    setup.fake.reviewMcpStatuses.push(
      { name: "docs", authStatus: "unsupported", resourceTemplates: [], resources: [], tools: {} },
      { name: "plugin_docs", authStatus: "unsupported", resourceTemplates: [], resources: [], tools: {} },
      { name: "codex_apps", authStatus: "unsupported", resourceTemplates: [], resources: [], tools: {} }
    );
    const threadId = setup.fake.seedThread(setup.target.workspaceRoot);
    const candidate = (await setup.adapter.listNativeSessions(setup.target))[0]!;
    const binding = await setup.adapter.resolveNativeSessionReference(candidate.nativeReference, setup.target, 1);
    const bound = context(setup.target, [], { binding, backendInstanceGeneration: 7 });
    await setup.adapter.resumeSession(binding, bound);

    const resume = setup.fake.transport!.requests.findLast((request) => request.method === "thread/resume")!;
    expect(resume.params).toMatchObject({ config: {
      "features.apps": false,
      "features.enable_mcp_apps": false,
      "features.remote_plugin": false,
      "mcp_servers.docs.enabled": false,
      "plugins.\"plugin@local\".mcp_servers.plugin_docs.enabled": false,
      "mcp_servers.joko_local_tools.enabled": true,
      "mcp_servers.joko_local_tools.url": "http://127.0.0.1:4100/private-local"
    } });
    expect(JSON.stringify(resume.params)).not.toContain("docs-server");
    expect(JSON.stringify(resume.params)).not.toContain("example.invalid");

    await setup.adapter.send(prompt("use a local tool"), context(setup.target, [], {
      binding,
      backendInstanceGeneration: 7,
      operationId: "local-mcp-turn"
    }));
    const call = opened[0]!.beginToolCall(threadId);
    expect(() => call.assertCurrent()).not.toThrow();
    expect(() => opened[0]!.beginToolCall("foreign-thread")).toThrow();
    await setup.fake.completeTurn(threadId);
    expect(call.signal.aborted).toBe(true);
    call.release();

    await setup.adapter.setPermissionMode("auto", bound);
    expect(setup.fake.transport!.requests.findLast((request) => request.method === "thread/resume")?.params)
      .toMatchObject({ config: expect.objectContaining({
        "mcp_servers.docs.enabled": false,
        "mcp_servers.joko_local_tools.url": "http://127.0.0.1:4100/private-local"
      }) });
    expect(opened).toHaveLength(1);
    expect(released).not.toHaveBeenCalled();
  });

  it("creates and forks local standard threads in isolation before the durable Session can authorize tools", async () => {
    let durable = false;
    const opened: CodexMcpOpenInput[] = [];
    const setup = await createSetup(7, {
      localMcpBridge: async (input) => {
        if (!durable) throw new Error("MCP was opened before the Session commit");
        opened.push(input);
        return {
          routes: [{ serverId: "tools", name: `joko_${input.sessionId.replace(/-/gu, "_")}_tools`, url: "http://127.0.0.1:4100/private" }],
          assertCurrent: input.assertSessionCurrent,
          release: async () => undefined
        };
      }
    });
    setup.fake.reviewConfig = {
      mcp_servers: { docs: { command: "private-docs-command" } },
      plugins: { "plugin@local": { mcp_servers: { plugin_docs: { url: "https://example.invalid/private" } } } }
    };
    setup.fake.reviewMcpStatuses.push(
      { name: "docs", authStatus: "unsupported", resourceTemplates: [], resources: [], tools: {} },
      { name: "plugin_docs", authStatus: "unsupported", resourceTemplates: [], resources: [], tools: {} },
      { name: "codex_apps", authStatus: "unsupported", resourceTemplates: [], resources: [], tools: {} }
    );

    const source = await setup.adapter.createSession(sessionInput(setup.target),
      context(setup.target, [], { backendInstanceGeneration: 7 }));
    const start = setup.fake.transport!.requests.find((request) => request.method === "thread/start")!;
    expect(start.params).toMatchObject({ config: {
      "features.apps": false,
      "features.enable_mcp_apps": false,
      "features.remote_plugin": false,
      "mcp_servers.docs.enabled": false,
      "plugins.\"plugin@local\".mcp_servers.plugin_docs.enabled": false
    } });
    expect(JSON.stringify(start.params)).not.toContain("private-docs-command");
    expect(JSON.stringify(start.params)).not.toContain("example.invalid");
    expect(JSON.stringify(start.params)).not.toContain("joko_session_codex_tools");
    expect(opened).toHaveLength(0);
    durable = true;

    await setup.adapter.send(prompt("source turn"), context(setup.target, [], {
      binding: source, backendInstanceGeneration: 7, operationId: "local-source-turn"
    }));
    const sourceResume = setup.fake.transport!.requests.find((request) => request.method === "thread/resume")!;
    expect(sourceResume.params).toMatchObject({ threadId: source.nativeSessionId, config: {
      "mcp_servers.docs.enabled": false,
      "mcp_servers.joko_session_codex_tools.enabled": true,
      "mcp_servers.joko_session_codex_tools.url": "http://127.0.0.1:4100/private"
    } });
    expect(setup.fake.transport!.requests.findIndex((request) => request.method === "turn/start"))
      .toBeGreaterThan(setup.fake.transport!.requests.findIndex((request) => request.method === "thread/resume"));
    expect(opened[0]).toMatchObject({ sessionId: "session-codex", targetId: setup.target.id, generation: 1, threadId: source.nativeSessionId });
    await setup.fake.completeTurn(source.nativeSessionId!);

    const derivedContext = { ...context(setup.target, [], { backendInstanceGeneration: 7 }), sessionId: "derived-session" };
    const derived = await setup.adapter.createSession({
      ...sessionInput(setup.target), nativeStart: { kind: "new", parentNativeReference: source.opaqueRef }
    }, derivedContext);
    const fork = setup.fake.transport!.requests.find((request) => request.method === "thread/fork")!;
    expect(fork.params).toMatchObject({ threadId: source.nativeSessionId, config: {
      "features.apps": false,
      "mcp_servers.docs.enabled": false,
      "plugins.\"plugin@local\".mcp_servers.plugin_docs.enabled": false
    } });
    expect(JSON.stringify(fork.params)).not.toContain("joko_session_codex_tools");
    expect(opened).toHaveLength(1);

    await setup.adapter.send(prompt("derived turn"), {
      ...derivedContext, binding: derived, operationId: "local-derived-turn"
    });
    expect(opened[1]).toMatchObject({ sessionId: "derived-session", threadId: derived.nativeSessionId });
    expect(setup.fake.transport!.requests.findLast((request) => request.method === "thread/resume")?.params)
      .toMatchObject({ threadId: derived.nativeSessionId, config: {
        "mcp_servers.joko_derived_session_tools.enabled": true,
        "mcp_servers.joko_derived_session_tools.url": "http://127.0.0.1:4100/private"
      } });
  });

  it("keeps local no-tool sessions isolated without installing a route and fails before native work on MCP uncertainty", async () => {
    const opened: CodexMcpOpenInput[] = [];
    let toolsAvailable = false;
    const setup = await createSetup(7, {
      localMcpBridge: async (input) => {
        opened.push(input);
        return {
          routes: toolsAvailable
            ? [{ serverId: "tools", name: "joko_newly_available", url: "http://127.0.0.1:4100/newly-available" }]
            : [],
          assertCurrent: input.assertSessionCurrent,
          release: async () => undefined
        };
      }
    });
    setup.fake.reviewConfig = { mcp_servers: { docs: { command: "private-command" } } };
    setup.fake.reviewMcpStatuses.push({ name: "docs", authStatus: "unsupported", resourceTemplates: [], resources: [], tools: {} });
    const binding = await setup.adapter.createSession(sessionInput(setup.target),
      context(setup.target, [], { backendInstanceGeneration: 7 }));
    expect(opened).toHaveLength(0);
    expect(setup.fake.transport!.requests.find((request) => request.method === "thread/start")?.params)
      .toMatchObject({ config: { "mcp_servers.docs.enabled": false, "features.apps": false } });
    await setup.adapter.send(prompt("text-only"), context(setup.target, [], {
      binding, backendInstanceGeneration: 7, operationId: "local-no-tools"
    }));
    expect(opened).toHaveLength(1);
    const resumeConfig = setup.fake.transport!.requests.findLast((request) => request.method === "thread/resume")!.params as JsonObject;
    expect(resumeConfig["config"]).toMatchObject({ "mcp_servers.docs.enabled": false, "features.apps": false });
    expect(JSON.stringify(resumeConfig)).not.toContain("joko_");
    expect(JSON.stringify(resumeConfig)).not.toContain("private-command");
    await setup.fake.completeTurn(binding.nativeSessionId!);
    toolsAvailable = true;
    await setup.adapter.send(prompt("tool now available"), context(setup.target, [], {
      binding, backendInstanceGeneration: 7, operationId: "local-new-tool"
    }));
    expect(opened).toHaveLength(2);
    expect(setup.fake.transport!.requests.findLast((request) => request.method === "thread/resume")?.params)
      .toMatchObject({ config: {
        "mcp_servers.docs.enabled": false,
        "mcp_servers.joko_newly_available.enabled": true
      } });

    const invalid = await createSetup(7, { localMcpBridge: async () => { throw new Error("must not open"); } });
    invalid.fake.reviewConfig = { mcp_servers: { "invalid\nname": { command: "secret" } } };
    await expect(invalid.adapter.createSession(sessionInput(invalid.target),
      context(invalid.target, [], { backendInstanceGeneration: 7 }))).rejects.toMatchObject({
      publicError: { code: "CODEX_LOCAL_MCP_UNAVAILABLE", stateMayHaveChanged: false }
    });
    expect(invalid.fake.transport!.requests.some((request) => request.method === "thread/start")).toBe(false);
  });

  it("does not dispatch a first local turn after a route bind failure", async () => {
    const released = vi.fn(async () => undefined);
    const setup = await createSetup(7, {
      localMcpBridge: async (input) => ({
        routes: [{ serverId: "tools", name: "joko_local_tools", url: "http://127.0.0.1:4100/private" }],
        assertCurrent: input.assertSessionCurrent,
        release: released
      })
    });
    const binding = await setup.adapter.createSession(sessionInput(setup.target),
      context(setup.target, [], { backendInstanceGeneration: 7 }));
    setup.fake.failNextThreadResumeCode = -32001;
    await expect(setup.adapter.send(prompt("must stay queued"), context(setup.target, [], {
      binding, backendInstanceGeneration: 7, operationId: "local-bind-failure"
    }))).rejects.toMatchObject({
      publicError: { code: "CODEX_LOCAL_MCP_UNAVAILABLE", stateMayHaveChanged: true }
    });
    expect(released).toHaveBeenCalledOnce();
    expect(setup.fake.transport!.requests.some((request) => request.method === "thread/unsubscribe"
      && (request.params as JsonObject)["threadId"] === binding.nativeSessionId)).toBe(true);
    expect(setup.fake.transport!.requests.some((request) => request.method === "turn/start")).toBe(false);
  });

  it("isolates an imported local thread before Session commit and binds its route only on later work", async () => {
    let durable = false;
    const opened: CodexMcpOpenInput[] = [];
    const setup = await createSetup(7, {
      localMcpBridge: async (input) => {
        if (!durable) throw new Error("Imported Session is not durable");
        opened.push(input);
        return {
          routes: [{ serverId: "tools", name: "joko_imported_tools", url: "http://127.0.0.1:4100/private" }],
          assertCurrent: input.assertSessionCurrent,
          release: async () => undefined
        };
      }
    });
    setup.fake.reviewConfig = { mcp_servers: { docs: { command: "private-command" } } };
    setup.fake.reviewMcpStatuses.push({ name: "docs", authStatus: "unsupported", resourceTemplates: [], resources: [], tools: {} });
    const threadId = setup.fake.seedThread(setup.target.workspaceRoot);
    const reference = (await setup.adapter.listNativeSessions(setup.target))[0]!.nativeReference;
    const binding = await setup.adapter.createSession({
      ...sessionInput(setup.target), nativeStart: { kind: "attach", nativeReference: reference }
    }, context(setup.target, [], { backendInstanceGeneration: 7 }));
    expect(binding.nativeSessionId).toBe(threadId);
    expect(opened).toHaveLength(0);
    expect(setup.fake.transport!.requests.findLast((request) => request.method === "thread/resume")?.params)
      .toMatchObject({ threadId, config: { "mcp_servers.docs.enabled": false, "features.apps": false } });
    const bound = context(setup.target, [], { binding, backendInstanceGeneration: 7 });
    await expect(setup.adapter.inspectSession(binding, bound)).resolves.toMatchObject({ binding });
    await expect(setup.adapter.getNativeHistoryProjection(bound)).resolves.toBeDefined();
    expect(opened).toHaveLength(0);
    durable = true;
    await setup.adapter.send(prompt("first imported turn"), { ...bound, operationId: "imported-first" });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ sessionId: "session-codex", threadId });
    expect(setup.fake.transport!.requests.findLast((request) => request.method === "thread/resume")?.params)
      .toMatchObject({ config: { "mcp_servers.joko_imported_tools.enabled": true } });

    const active = await createSetup(7, { localMcpBridge: async () => { throw new Error("must not open"); } });
    const activeId = active.fake.seedThread(active.target.workspaceRoot);
    active.fake.threads.get(activeId)!.status = { type: "active", activeFlags: [] };
    const activeReference = (await active.adapter.listNativeSessions(active.target))[0]!.nativeReference;
    await expect(active.adapter.createSession({
      ...sessionInput(active.target), nativeStart: { kind: "attach", nativeReference: activeReference }
    }, context(active.target, [], { backendInstanceGeneration: 7 }))).rejects.toMatchObject({
      publicError: { code: "CODEX_LOCAL_MCP_UNAVAILABLE", stateMayHaveChanged: false }
    });
    expect(active.fake.transport!.requests.some((request) => request.method === "thread/resume")).toBe(false);
  });

  it("rebinds local MCP isolation when a native model route changes", async () => {
    const model: ProviderModel = {
      providerId: "custom", modelId: "custom-model", displayName: "Custom", api: "openai-responses",
      contextWindow: 0, maxOutputTokens: 0, supportsImages: false, supportsFastMode: false,
      thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    };
    const managedProviders: ManagedProviderRuntimePort = {
      support: CODEX_MANAGED_PROVIDER_SUPPORT,
      environment: { JOKO_PROVIDER_PROXY_TOKEN: "private-token" },
      secretEnvironmentNames: ["JOKO_PROVIDER_PROXY_TOKEN"],
      dispose: () => undefined, hasProvider: (id) => id === "custom",
      listModels: () => [model], listProviders: () => [], getThinkingLevelMap: () => ({}),
      prepare: async (): Promise<ManagedProviderRouteBinding> => ({
        providerId: "custom", model, protocol: "openai-responses", revision: "one",
        baseUrl: "http://127.0.0.1:4101/managed", apiKeyEnvironment: "JOKO_PROVIDER_PROXY_TOKEN",
        thinkingLevelMap: {}, assertCurrent: () => undefined,
        activate: async () => ({ release: () => undefined }), dispose: () => undefined
      })
    };
    const opened: CodexMcpOpenInput[] = [];
    const released: number[] = [];
    const setup = await createSetup(7, {
      managedProviders,
      localMcpBridge: async (input) => {
        const ordinal = opened.push(input);
        let retired = false;
        return {
          routes: [{ serverId: "tools", name: `joko_local_${ordinal}`, url: `http://127.0.0.1:4100/${ordinal}` }],
          assertCurrent: () => {
            if (retired) throw new Error("retired");
            input.assertSessionCurrent();
          },
          release: async () => { retired = true; released.push(ordinal); }
        };
      }
    });
    const binding = await setup.adapter.createSession(sessionInput(setup.target),
      context(setup.target, [], { backendInstanceGeneration: 7 }));
    const bound = context(setup.target, [], { binding, backendInstanceGeneration: 7 });
    await setup.adapter.send(prompt("first"), { ...bound, operationId: "local-before-model-switch" });
    await setup.fake.completeTurn(binding.nativeSessionId!);
    await setup.adapter.setModel("custom", "custom-model", bound);
    expect(released).toContain(1);
    expect(opened).toHaveLength(2);
    expect(setup.fake.transport!.requests.findLast((request) => request.method === "thread/resume")?.params)
      .toMatchObject({ threadId: binding.nativeSessionId, modelProvider: "custom", config: {
        "features.apps": false,
        "mcp_servers.joko_local_2.enabled": true,
        "mcp_servers.joko_local_2.url": "http://127.0.0.1:4100/2"
      } });
    await setup.adapter.send(prompt("second"), { ...bound, operationId: "local-after-model-switch" });
    expect(() => opened[0]!.beginToolCall(binding.nativeSessionId!)).toThrow();
    const call = opened[1]!.beginToolCall(binding.nativeSessionId!);
    expect(() => call.assertCurrent()).not.toThrow();
    call.release();
  });

  it("isolates remote MCP config and fences calls to the active native thread without replacing a busy runtime", async () => {
    let bridgeGeneration = 1;
    const opened: CodexMcpOpenInput[] = [];
    const released: number[] = [];
    const setup = await createRemoteSetup({
      openMcpBridge: async (input) => {
        const capturedGeneration = bridgeGeneration;
        let retired = false;
        opened.push(input);
        return {
          routes: [{
            serverId: "tools",
            name: `joko_tools_generation_${capturedGeneration}`,
            url: `http://127.0.0.1:4100/private-${capturedGeneration}`
          }],
          assertCurrent: () => {
            if (retired || bridgeGeneration !== capturedGeneration) throw new Error("bridge changed");
            input.assertSessionCurrent();
          },
          release: async () => {
            if (retired) return;
            retired = true;
            released.push(capturedGeneration);
          }
        };
      }
    });
    setup.remoteFake.reviewConfig = {
      mcp_servers: { docs: { command: "docs-server" } },
      plugins: { "plugin@remote": { mcp_servers: { plugin_docs: { url: "https://example.invalid/mcp" } } } }
    };
    setup.remoteFake.reviewMcpStatuses.push(
      { name: "docs", authStatus: "unsupported", resourceTemplates: [], resources: [], tools: {} },
      { name: "plugin_docs", authStatus: "unsupported", resourceTemplates: [], resources: [], tools: {} },
      { name: "codex_apps", authStatus: "unsupported", resourceTemplates: [], resources: [], tools: {} }
    );
    const threadId = setup.remoteFake.seedThread("/srv/joko-project");
    const candidate = (await setup.adapter.listNativeSessions(setup.target))[0]!;
    const binding = await setup.adapter.resolveNativeSessionReference(candidate.nativeReference, setup.target, 1);
    const bound = context(setup.target, [], { binding, backendInstanceGeneration: 7 });
    await setup.adapter.resumeSession(binding, bound);

    const resume = setup.remoteFake.transport!.requests.find((request) => request.method === "thread/resume")!;
    expect(resume.params).toMatchObject({
      config: {
        "features.apps": false,
        "features.enable_mcp_apps": false,
        "features.remote_plugin": false,
        "mcp_servers.docs.enabled": false,
        "plugins.\"plugin@remote\".mcp_servers.plugin_docs.enabled": false,
        "mcp_servers.joko_tools_generation_1.enabled": true,
        "mcp_servers.joko_tools_generation_1.url": "http://127.0.0.1:4100/private-1"
      }
    });
    expect(JSON.stringify(resume.params)).not.toContain("docs-server");
    expect(JSON.stringify(resume.params)).not.toContain("example.invalid");

    await setup.adapter.setPermissionMode("auto", bound);
    expect(setup.remoteFake.transport!.requests.findLast((request) => request.method === "thread/resume")?.params)
      .toMatchObject({ config: expect.objectContaining({
        "mcp_servers.docs.enabled": false,
        "mcp_servers.joko_tools_generation_1.url": "http://127.0.0.1:4100/private-1"
      }) });

    await setup.adapter.send(prompt("use a remote tool"), context(setup.target, [], {
      binding,
      backendInstanceGeneration: 7,
      operationId: "remote-mcp-turn"
    }));
    const call = opened[0]!.beginToolCall(threadId);
    expect(() => call.assertCurrent()).not.toThrow();
    expect(() => opened[0]!.beginToolCall("unowned-native-thread")).toThrow();

    bridgeGeneration = 2;
    const resumeCountWhileBusy = setup.remoteFake.transport!.requests.filter((request) => request.method === "thread/resume").length;
    await setup.adapter.setName("Busy route stays attached", bound);
    expect(opened).toHaveLength(1);
    expect(setup.remoteFake.transport!.requests.filter((request) => request.method === "thread/resume"))
      .toHaveLength(resumeCountWhileBusy);
    expect(() => call.assertCurrent()).toThrow();

    await setup.remoteFake.completeTurn(threadId);
    expect(call.signal.aborted).toBe(true);
    call.release();
    await setup.adapter.send(prompt("replace at the idle boundary"), context(setup.target, [], {
      binding,
      backendInstanceGeneration: 7,
      operationId: "remote-mcp-next-turn"
    }));
    expect(opened).toHaveLength(2);
    expect(released).toContain(1);
    expect(setup.remoteFake.transport!.requests.findLast((request) => request.method === "thread/resume")?.params)
      .toMatchObject({ config: expect.objectContaining({
        "mcp_servers.joko_tools_generation_2.url": "http://127.0.0.1:4100/private-2"
      }) });
    const childThreadId = "remote-owned-child";
    await setup.remoteFake.transport!.emitNotification("thread/started", {
      thread: { id: childThreadId, parentThreadId: threadId, agentRole: "worker" }
    });
    await setup.remoteFake.transport!.emitNotification("turn/started", {
      threadId: childThreadId,
      turn: { id: "remote-child-turn", status: "inProgress", items: [], error: null }
    });
    await setup.remoteFake.transport!.emitNotification("item/started", {
      threadId,
      turnId: "turn-2",
      item: {
        type: "collabAgentToolCall",
        id: "remote-spawn-call",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: threadId,
        receiverThreadIds: [childThreadId],
        agentsStates: { [childThreadId]: { status: "running", message: null } }
      }
    });
    const childCall = opened[1]!.beginToolCall(childThreadId);
    expect(() => childCall.assertCurrent()).not.toThrow();
    await setup.remoteFake.transport!.emitNotification("turn/completed", {
      threadId: childThreadId,
      turn: { id: "remote-child-turn", status: "completed", items: [], error: null }
    });
    expect(childCall.signal.aborted).toBe(true);
    childCall.release();
  });

  it("rejects unsupported remote Codex mutations and attachments before native effect", async () => {
    const setup = await createRemoteSetup();
    const nativeSessionId = setup.remoteFake.seedThread("/srv/joko-project");
    const candidate = (await setup.adapter.listNativeSessions(setup.target))[0]!;
    const binding = await setup.adapter.resolveNativeSessionReference(candidate.nativeReference, setup.target, 1);
    const bound = context(setup.target, [], { binding, backendInstanceGeneration: 7 });
    await setup.adapter.resumeSession(binding, bound);
    const beforeRejectedMutations = setup.remoteFake.transport!.requests.length;
    await expect(setup.adapter.send({
      ...prompt("must not dispatch"),
      images: [{ blob: { id: "remote-image", byteLength: 1, sha256: "a".repeat(64), mimeType: "image/png" } }]
    }, context(setup.target, [], {
      binding,
      backendInstanceGeneration: 7,
      operationId: "remote-attachment"
    }))).rejects.toMatchObject({ publicError: { code: "CODEX_REMOTE_MUTATION_UNSUPPORTED", stateMayHaveChanged: false } });
    await expect(setup.adapter.createSession(sessionInput(setup.target), context(setup.target, [], { backendInstanceGeneration: 7 })))
      .rejects.toMatchObject({ publicError: { code: "CODEX_REMOTE_MUTATION_UNSUPPORTED", stateMayHaveChanged: false } });
    await expect(setup.adapter.deleteSession(binding, bound))
      .rejects.toMatchObject({ publicError: { code: "CODEX_REMOTE_MUTATION_UNSUPPORTED", stateMayHaveChanged: false } });
    expect(setup.remoteFake.transport!.requests).toHaveLength(beforeRejectedMutations);
    expect(setup.remoteFake.transport!.requests.filter((request) => request.method === "turn/start")).toEqual([]);
    expect(setup.remoteFake.threads.has(nativeSessionId)).toBe(true);
  });

  it("never resends uncertain remote input and rejects authority drift at the final pre-write fence", async () => {
    const setup = await createRemoteSetup();
    const nativeSessionId = setup.remoteFake.seedThread("/srv/joko-project");
    const candidate = (await setup.adapter.listNativeSessions(setup.target))[0]!;
    const binding = await setup.adapter.resolveNativeSessionReference(candidate.nativeReference, setup.target, 1);
    const bound = context(setup.target, [], { binding, backendInstanceGeneration: 7 });
    await setup.adapter.resumeSession(binding, bound);

    setup.remoteFake.dropNextTurnClientId = true;
    setup.remoteFake.timeoutNextTurnStart = true;
    await expect(setup.adapter.send(prompt("uncertain remote input"), context(setup.target, [], {
      binding,
      backendInstanceGeneration: 7,
      operationId: "remote-unknown"
    }))).rejects.toMatchObject({ publicError: { code: "CODEX_DISPATCH_UNKNOWN", stateMayHaveChanged: true } });
    expect(setup.remoteFake.transport!.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);

    const transport = setup.remoteFake.transport!;
    const request = transport.request.bind(transport);
    vi.spyOn(transport, "request").mockImplementation((method, params, options) => {
      if (method === "turn/steer") setup.setCurrent(false);
      return request(method, params, options);
    });
    const beforeSteer = transport.requests.filter((value) => value.method === "turn/steer").length;
    await expect(setup.adapter.send({ ...prompt("stale steer"), disposition: "steer" }, context(setup.target, [], {
      binding,
      backendInstanceGeneration: 7,
      operationId: "remote-stale-steer"
    }))).rejects.toMatchObject({ publicError: { code: "CODEX_RUNTIME_GENERATION_STALE", stateMayHaveChanged: false } });
    expect(transport.requests.filter((value) => value.method === "turn/steer")).toHaveLength(beforeSteer);
    expect(setup.remoteFake.threads.get(nativeSessionId)?.turns).toHaveLength(1);
  });

  it("terminalizes only the subscribed remote runtime when its owning Host disconnects", async () => {
    const setup = await createRemoteSetup();
    const nativeSessionId = setup.remoteFake.seedThread("/srv/joko-project");
    const candidate = (await setup.adapter.listNativeSessions(setup.target))[0]!;
    const binding = await setup.adapter.resolveNativeSessionReference(candidate.nativeReference, setup.target, 1);
    const events: EventPayload[] = [];
    const bound = context(setup.target, events, { binding, backendInstanceGeneration: 7, operationId: "remote-disconnect" });
    await setup.adapter.resumeSession(binding, bound);
    await setup.adapter.send(prompt("disconnect after acceptance"), bound);
    await setup.remoteFake.transport!.exit(true);

    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      terminal: true,
      error: expect.objectContaining({ code: "CODEX_APP_SERVER_DISCONNECTED", stateMayHaveChanged: true })
    }));
    expect(events).toContainEqual({ type: "done", outcome: "failed" });
  });

  it("reports a side-effect-free continuity gap for validated missing or unresumable native threads", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    setup.fake.threads.delete(binding.nativeSessionId!);
    const nextBinding = { ...binding, generation: binding.generation + 1 };

    await expect(setup.adapter.resumeSession(binding, context(setup.target, events, {
      binding: nextBinding,
      generation: nextBinding.generation,
      backendInstanceGeneration: 7
    }))).rejects.toMatchObject({
      publicError: {
        code: "NATIVE_SESSION_CONTINUITY_GAP",
        retryable: false,
        stateMayHaveChanged: false
      }
    });
    await expect(setup.adapter.resolveNativeSessionReference(
      binding.opaqueRef,
      setup.target,
      nextBinding.generation
    )).rejects.toMatchObject({
      publicError: {
        code: "NATIVE_SESSION_CONTINUITY_GAP",
        retryable: false,
        stateMayHaveChanged: false
      }
    });
    await expect(setup.adapter.inspectSession(binding, context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7
    }))).rejects.toMatchObject({
      publicError: { code: "CODEX_NATIVE_SESSION_UNAVAILABLE" }
    });

    const restartSetup = await createSetup();
    const restartBinding = await restartSetup.adapter.createSession(
      sessionInput(restartSetup.target),
      context(restartSetup.target, events, { backendInstanceGeneration: 7 })
    );
    await restartSetup.adapter.closeSession(restartBinding, context(restartSetup.target, events, {
      binding: restartBinding,
      backendInstanceGeneration: 7
    }));
    restartSetup.fake.failNextThreadResumeCode = -32600;
    const restartedBinding = { ...restartBinding, generation: restartBinding.generation + 1 };
    await expect(restartSetup.adapter.resumeSession(restartBinding, context(restartSetup.target, events, {
      binding: restartedBinding,
      generation: restartedBinding.generation,
      backendInstanceGeneration: 7
    }))).rejects.toMatchObject({
      publicError: {
        code: "NATIVE_SESSION_CONTINUITY_GAP",
        retryable: false,
        stateMayHaveChanged: false
      }
    });
  });

  it("retires a subscription installed after dispose without emitting late callbacks", async () => {
    const setup = await createSetup();
    setup.fake.emitNameBeforeStartResponse = true;
    const events: EventPayload[] = [];
    let releaseEmit: (() => void) | undefined;
    let emitStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { emitStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseEmit = resolve; });
    const createContext = {
      ...context(setup.target, events, { backendInstanceGeneration: 7 }),
      emit: async (event: EventPayload) => {
        if (event.type === "session_changed") {
          emitStarted?.();
          await blocked;
        }
        events.push(event);
      }
    };
    const creation = setup.adapter.createSession(sessionInput(setup.target), createContext);
    await started;

    const disposal = setup.adapter.dispose();
    releaseEmit?.();
    await expect(disposal).resolves.toBeUndefined();
    await expect(creation).rejects.toMatchObject({ publicError: { code: "CODEX_ADAPTER_CLOSED" } });
    expect(events).toEqual([{ type: "session_changed" }]);
    const threadId = [...setup.fake.threads.keys()][0]!;
    await expect(setup.fake.requestCommandApproval(threadId, "turn-late"))
      .resolves.toEqual({ decision: "cancel" });
  });

  it("forks only through a proven native turn boundary and detaches the derived binding without closing the source", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const sourceContext = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "fork-source-message"
    });
    setup.fake.threads.get(binding.nativeSessionId!)!.turns.push(...Array.from({ length: 100 }, (_, index) => historyTurn(index)));
    await setup.adapter.send({
      text: "create a fork point",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, sourceContext);
    await setup.fake.completeTurn(binding.nativeSessionId!);

    const recordBinding = vi.fn((derived: NativeSessionBinding) => {
      expect(derived.nativeSessionId).not.toBe(binding.nativeSessionId);
      expect(setup.fake.transport?.requests.some((request) => request.method === "thread/unsubscribe")).toBe(false);
    });
    const derivedWorkspace = join(setup.target.workspaceRoot, "derived-workspace");
    await mkdir(derivedWorkspace);
    const derivedTarget = { ...sourceContext.target, workspaceRoot: derivedWorkspace };
    expect((await setup.adapter.describe()).capabilities.get("workspace.derive")).toMatchObject({ supported: true });
    const forkRequestsBeforeMismatch = setup.fake.transport?.requests.filter((request) => request.method === "thread/fork").length;
    await expect(setup.adapter.clone(sourceContext, {
      sessionId: "mismatched-target-session",
      target: { ...derivedTarget, trusted: !derivedTarget.trusted },
      recordBinding: vi.fn()
    })).rejects.toMatchObject({
      publicError: {
        code: "CODEX_SESSION_DERIVATION_TARGET_MISMATCH",
        stateMayHaveChanged: false
      }
    });
    expect(setup.fake.transport?.requests.filter((request) => request.method === "thread/fork"))
      .toHaveLength(forkRequestsBeforeMismatch ?? 0);
    const derived = await setup.adapter.fork("fork-source-message", sourceContext, {
      sessionId: "derived-session",
      target: derivedTarget,
      recordBinding
    });
    expect(recordBinding).toHaveBeenCalledExactlyOnceWith(derived.binding);
    const forkRequest = setup.fake.transport?.requests.find((request) => request.method === "thread/fork");
    expect(forkRequest?.params).toMatchObject({
      threadId: binding.nativeSessionId,
      lastTurnId: "turn-1",
      cwd: derivedWorkspace
    });
    await expect(setup.adapter.detachSession(derived.binding, {
      ...sourceContext,
      target: derivedTarget,
      binding: derived.binding
    })).resolves.toBeUndefined();

    await expect(setup.adapter.send({
      text: "source remains attached",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, { ...sourceContext, operationId: "source-after-fork" })).resolves.toBeUndefined();
    await setup.fake.completeTurn(binding.nativeSessionId!);
    expect(events.at(-1)).toEqual({ type: "done", outcome: "completed" });
    const cleanupContext = { ...sourceContext, sessionId: "derived-session", binding: derived.binding };
    expect(setup.adapter.supportsDetachedSessionDeletion(cleanupContext)).toBe(true);
    const nativeStarts = setup.fake.transport!.requests.filter((entry) => entry.method === "thread/start" || entry.method === "thread/resume");
    await setup.adapter.deleteSession(derived.binding, cleanupContext);
    expect(setup.fake.threads.has(derived.binding.nativeSessionId!)).toBe(false);
    expect(setup.fake.threads.has(binding.nativeSessionId!)).toBe(true);
    expect(setup.fake.transport!.requests.filter((entry) => entry.method === "thread/start" || entry.method === "thread/resume")).toEqual(nativeStarts);
  });

  it("rewinds paginated history to an exact retained turn and treats the retained tail as a no-op", async () => {
    const setup = await createRewindSetup();
    expect(setup.transport.requests.find((entry) => entry.method === "thread/start")?.params).toMatchObject({ historyMode: "paginated" });
    expect((await setup.adapter.describe()).capabilities.get("session.rewind")?.supported).toBe(true);
    const retained = structuredClone(setup.thread.turns.slice(0, 1));
    await setup.adapter.navigateTree({ kind: "native_entry", entryId: "history-item-0" }, false, setup.bound, undefined, navigationAuthority);
    expect(setup.transport.requests.filter((entry) => entry.method === "thread/revert").map((entry) => entry.params))
      .toEqual([{ threadId: setup.binding.nativeSessionId, beforeTurnId: "history-turn-1" }]);
    expect(setup.thread.turns).toEqual(retained);
    const projection = await setup.adapter.getNativeHistoryProjection(setup.bound);
    expect(projection.activeEntryId).toBe("history-item-0");
    await setup.adapter.navigateTree({ kind: "native_entry", entryId: "history-turn-0" }, false, setup.bound, undefined, navigationAuthority);
    expect(setup.transport.requests.filter((entry) => entry.method === "thread/revert")).toHaveLength(1);
    await setup.adapter.send(prompt("Continue the confirmed prefix"), { ...setup.bound, operationId: "after-confirmed-rewind" });
  });

  it("clears the first turn with an explicit start target, preserves its binding, and resumes the empty prefix", async () => {
    const setup = await createRewindSetup();
    expect((await setup.adapter.describe()).capabilities.get("session.rewind_to_start")?.supported).toBe(true);
    await setup.adapter.navigateTree({ kind: "session_start" }, false, setup.bound, undefined, navigationAuthority);
    expect(setup.transport.requests.filter((entry) => entry.method === "thread/revert").map((entry) => entry.params))
      .toEqual([{ threadId: setup.binding.nativeSessionId, beforeTurnId: "history-turn-0" }]);
    expect(setup.thread.turns).toEqual([]);
    expect(await setup.adapter.getNativeHistoryProjection(setup.bound)).toMatchObject({ activeNavigationTarget: { kind: "session_start" }, activeLineage: [] });
    await setup.adapter.navigateTree({ kind: "session_start" }, false, setup.bound, undefined, navigationAuthority);
    expect(setup.transport.requests.filter((entry) => entry.method === "thread/revert")).toHaveLength(1);
    await setup.adapter.closeSession(setup.binding, setup.bound);
    await setup.adapter.resumeSession(setup.binding, setup.bound);
    expect((await setup.adapter.getNativeHistoryProjection(setup.bound)).activeNavigationTarget).toEqual({ kind: "session_start" });
    await setup.adapter.send(prompt("Continue the empty prefix"), { ...setup.bound, operationId: "after-start-rewind" });
    expect(setup.thread.turns).toHaveLength(1);
  });

  it.each(["middle-item", "missing", "empty", "mode", "busy", "background", "summary", "instructions"] as const)("rejects an inexact or unavailable %s rewind without native mutation", async (boundary) => {
    const setup = await createRewindSetup();
    let entryId = "history-item-0";
    if (boundary === "middle-item") (setup.thread.turns[0]!["items"] as JsonObject[]).push({ id: "later-item", type: "agentMessage", text: "Later output" });
    if (boundary === "missing") entryId = "missing-item";
    if (boundary === "empty") entryId = "";
    if (boundary === "mode") setup.thread.historyMode = "legacy";
    if (boundary === "busy") setup.thread.status = { type: "active", activeFlags: [] };
    if (boundary === "background") (setup.thread.turns[1]!["items"] as JsonObject[]).push({
      id: "active-spawn", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", receiverThreadIds: ["active-child"], agentsStates: { "active-child": { status: "running", message: null } }
    });
    await expect(setup.adapter.navigateTree({ kind: "native_entry", entryId: entryId }, boundary === "summary", setup.bound, boundary === "instructions" ? "Summary instruction" : undefined, navigationAuthority))
      .rejects.toMatchObject({ publicError: { stateMayHaveChanged: false } });
    expect(setup.transport.requests.some((entry) => entry.method === "thread/revert")).toBe(false);
    expect(setup.thread.turns).toHaveLength(3);
  });

  it.each(["lost-ack-confirmed", "lost-ack-unchanged", "hydrate-failed", "invalid-reply", "cancelled-after-write"] as const)("keeps the exact rewind outcome across %s without replay", async (boundary) => {
    const setup = await createRewindSetup();
    const cancellation = new AbortController();
    const request = setup.transport.request.bind(setup.transport);
    let reverted = false;
    const intercepted = vi.spyOn(setup.transport, "request").mockImplementation(async (method, params, options) => {
      if (method === "thread/revert" && boundary === "lost-ack-unchanged") throw new TransportFault("request_timeout", "Fixture outcome is unknown.", { stateMayHaveChanged: true });
      if (method === "thread/read" && reverted && boundary === "hydrate-failed") throw new TransportFault("request_timeout", "Fixture hydration failed.");
      const result = await request(method, params, options);
      if (method !== "thread/revert") return result;
      reverted = true;
      if (boundary === "lost-ack-confirmed") throw new TransportFault("request_timeout", "Fixture acknowledgement lost.", { stateMayHaveChanged: true });
      if (boundary === "invalid-reply") return { thread: { id: "foreign-thread", turns: [], historyMode: "paginated" } };
      if (boundary === "cancelled-after-write") cancellation.abort();
      return result;
    });
    const result = setup.adapter.navigateTree({ kind: "native_entry", entryId: "history-item-0" }, false, { ...setup.bound, signal: cancellation.signal }, undefined, navigationAuthority);
    if (boundary === "lost-ack-confirmed") await expect(result).resolves.toEqual({ kind: "in_place" });
    else await expect(result).rejects.toMatchObject({ publicError: { code: "CODEX_REWIND_UNKNOWN", stateMayHaveChanged: true, retryable: false } });
    expect(intercepted.mock.calls.filter(([method]) => method === "thread/revert")).toHaveLength(1);
    intercepted.mockRestore();
    if (boundary !== "lost-ack-confirmed") {
      await setup.adapter.getNativeHistoryProjection(setup.bound);
      await expect(setup.adapter.send(prompt("Do not guess the outcome"), { ...setup.bound, operationId: "after-unknown-rewind" }))
        .rejects.toMatchObject({ publicError: { code: "CODEX_REWIND_UNKNOWN" } });
      await expect(setup.adapter.navigateTree({ kind: "native_entry", entryId: "history-item-0" }, false, setup.bound, undefined, navigationAuthority))
        .rejects.toMatchObject({ publicError: { code: "CODEX_REWIND_UNKNOWN" } });
    }
  });

  it.each([false, true])("bounds read-only rewind confirmation after continuing native arrivals: %s", async (continuing) => {
    const setup = await createRewindSetup();
    const request = setup.transport.request.bind(setup.transport);
    let reverted = false;
    let confirmationReads = 0;
    const intercepted = vi.spyOn(setup.transport, "request").mockImplementation(async (method, params, options) => {
      const result = await request(method, params, options);
      if (method === "thread/revert") reverted = true;
      if (method === "thread/read" && reverted) {
        confirmationReads++;
        if (continuing || confirmationReads === 1) {
          await setup.transport.emitNotification("thread/reverted", { threadId: setup.binding.nativeSessionId! });
        }
      }
      return result;
    });
    const pending = setup.adapter.navigateTree({ kind: "native_entry", entryId: "history-item-0" }, false, setup.bound, undefined, navigationAuthority);
    if (continuing) {
      await expect(pending).rejects.toMatchObject({ publicError: { code: "CODEX_REWIND_UNKNOWN", stateMayHaveChanged: true } });
      expect(confirmationReads).toBe(2);
    } else {
      await expect(pending).resolves.toEqual({ kind: "in_place" });
      expect(confirmationReads).toBe(3);
    }
    expect(intercepted.mock.calls.filter(([method]) => method === "thread/revert")).toHaveLength(1);
  });

  it("fences new input and controls while rewind preparation is pending and retires its source before write", async () => {
    const setup = await createRewindSetup();
    const request = setup.transport.request.bind(setup.transport);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const intercepted = vi.spyOn(setup.transport, "request").mockImplementationOnce(async (method, params, options) => {
      entered(); await held; return request(method, params, options);
    });
    const pending = setup.adapter.navigateTree({ kind: "native_entry", entryId: "history-item-0" }, false, setup.bound, undefined, navigationAuthority).catch((error: unknown) => error);
    await waiting;
    for (const mutation of [
      () => setup.adapter.send(prompt("Pending input"), { ...setup.bound, operationId: "during-rewind" }),
      () => setup.adapter.setFastMode(false, setup.bound),
      () => setup.adapter.compact(undefined, setup.bound),
      () => setup.adapter.clone(setup.bound, { sessionId: "derived", target: setup.bound.target, recordBinding: () => undefined })
    ]) await expect(mutation()).rejects.toMatchObject({ publicError: { code: "CODEX_REWIND_BUSY", stateMayHaveChanged: false } });
    await setup.adapter.closeSession(setup.binding, setup.bound);
    release();
    expect(await pending).toMatchObject({ publicError: { stateMayHaveChanged: false } });
    expect(intercepted.mock.calls.some(([method]) => method === "thread/revert")).toBe(false);
  });

  it.each(["reverted", "cancel", "close"] as const)("rechecks a prepared rewind across %s at the final host dispatch boundary", async (boundary) => {
    const setup = await createRewindSetup();
    const cancellation = new AbortController();
    const request = setup.host.request.bind(setup.host);
    const ensureStarted = setup.host.ensureStarted.bind(setup.host);
    vi.spyOn(setup.host, "request").mockImplementation((method, params, options) => {
      if (method === "thread/revert") vi.spyOn(setup.host, "ensureStarted").mockImplementationOnce(async () => {
        if (boundary === "reverted") await setup.transport.emitNotification("thread/reverted", { threadId: setup.binding.nativeSessionId! });
        if (boundary === "cancel") cancellation.abort();
        if (boundary === "close") await setup.adapter.closeSession(setup.binding, setup.bound);
        return ensureStarted();
      });
      return request(method, params, options);
    });
    await expect(setup.adapter.navigateTree({ kind: "native_entry", entryId: "history-item-0" }, false, { ...setup.bound, signal: cancellation.signal }, undefined, navigationAuthority))
      .rejects.toMatchObject({ publicError: { stateMayHaveChanged: false } });
    expect(setup.transport.requests.some((entry) => entry.method === "thread/revert")).toBe(false);
    expect(setup.thread.turns).toHaveLength(3);
  });

  it("requires explicit confirmation of paginated mode on new native threads", async () => {
    const setup = await createSetup();
    setup.fake.threadStartResponseOverrides = { thread: { id: "thread-1", cwd: setup.target.workspaceRoot, turns: [], historyMode: "legacy" } };
    await expect(setup.adapter.createSession(sessionInput(setup.target), context(setup.target, [], { backendInstanceGeneration: 7 })))
      .rejects.toMatchObject({ publicError: { code: "CODEX_HISTORY_MODE_UNCONFIRMED", stateMayHaveChanged: true } });
    expect(setup.fake.transport!.requests.filter((entry) => entry.method === "thread/start")).toHaveLength(1);
  });

  it("refuses rewind when earlier input is still preparing before its native request", async () => {
    let entered!: () => void;
    let release!: (value: { data: Uint8Array; mimeType: string }) => void;
    const preparing = new Promise<void>((resolve) => { entered = resolve; });
    const data = new Uint8Array([1, 2, 3]);
    const setup = await createRewindSetup({ readBlob: async () => { entered(); return new Promise((resolve) => { release = resolve; }); } });
    const cancellation = new AbortController();
    const pending = setup.adapter.send({ ...prompt("Prepared input"), images: [{ blob: { id: "held-image", byteLength: data.byteLength, sha256: createHash("sha256").update(data).digest("hex"), mimeType: "image/png" } }] }, { ...setup.bound, operationId: "prepared-before-rewind", signal: cancellation.signal }).catch((error: unknown) => error);
    await preparing;
    await expect(setup.adapter.navigateTree({ kind: "native_entry", entryId: "history-item-0" }, false, setup.bound, undefined, navigationAuthority)).rejects.toMatchObject({ publicError: { code: "CODEX_REWIND_BUSY" } });
    cancellation.abort(); release({ data, mimeType: "image/png" }); await pending;
    expect(setup.transport.requests.some((entry) => entry.method === "thread/revert")).toBe(false);
  });

  it.each([
    { wait: "host", boundary: "reverted" },
    { wait: "host", boundary: "cancel" },
    { wait: "host", boundary: "close" },
    { wait: "transport", boundary: "reverted" },
    { wait: "transport", boundary: "cancel" },
    { wait: "transport", boundary: "close" }
  ] as const)("does not dispatch a selected fork after $boundary during the $wait wait", async ({ wait, boundary }) => {
    const setup = await createSetup();
    const binding = await setup.adapter.createSession(sessionInput(setup.target), context(setup.target, [], { backendInstanceGeneration: 7 }));
    const base = context(setup.target, [], { binding, backendInstanceGeneration: 7, operationId: "selected-fork-boundary" });
    await setup.adapter.send(prompt("Completed fork point"), base);
    await setup.fake.completeTurn(binding.nativeSessionId!);
    const cancellation = new AbortController();
    const transport = setup.fake.transport!;
    const invalidate = async () => {
      if (boundary === "reverted") await transport.emitNotification("thread/reverted", { threadId: binding.nativeSessionId! });
      if (boundary === "cancel") cancellation.abort();
      if (boundary === "close") await setup.adapter.closeSession(binding, base);
    };
    if (wait === "host") {
      const request = setup.host.request.bind(setup.host);
      const ensureStarted = setup.host.ensureStarted.bind(setup.host);
      vi.spyOn(setup.host, "request").mockImplementation((method, params, options) => {
        if (method === "thread/fork") {
          vi.spyOn(setup.host, "ensureStarted").mockImplementationOnce(async () => {
            await invalidate();
            return ensureStarted();
          });
        }
        return request(method, params, options);
      });
    } else {
      const request = transport.request.bind(transport);
      vi.spyOn(transport, "request").mockImplementation(async (method, params, options) => {
        if (method === "thread/fork") await invalidate();
        return request(method, params, options);
      });
    }
    const recordBinding = vi.fn();
    await expect(setup.adapter.fork("selected-fork-boundary", { ...base, signal: cancellation.signal }, {
      sessionId: "derived-session", target: base.target, recordBinding
    })).rejects.toMatchObject({ publicError: { stateMayHaveChanged: false } });
    expect(recordBinding).not.toHaveBeenCalled();
    expect(transport.requests.some((request) => request.method === "thread/fork")).toBe(false);
    expect(setup.fake.threads.size).toBe(1);
  });

  it.each([
    { response: "source", code: "CODEX_SESSION_FORK_IDENTITY_MISMATCH" },
    { response: "foreign-target", code: "CODEX_SESSION_FORK_TARGET_MISMATCH" },
    { response: "missing-target", code: "CODEX_SESSION_FORK_TARGET_MISMATCH" },
    { response: "malformed", code: "CODEX_SESSION_FORK_INVALID_RESPONSE" },
    { response: "malformed-history", code: "CODEX_SESSION_FORK_INVALID_RESPONSE" }
  ])("rejects a $response fork reply without detaching the source thread", async ({ response, code }) => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const bound = context(setup.target, events, { binding, backendInstanceGeneration: 7 });
    const transport = setup.fake.transport!;
    const request = transport.request.bind(transport);
    const foreignRoot = await realpath(tmpdir());
    const interceptor = vi.spyOn(transport, "request").mockImplementation(async (method, params, options) => {
      const result = await request(method, params, options);
      if (method !== "thread/fork") return result;
      if (response === "malformed") return { thread: { id: null } };
      const envelope = result as JsonObject;
      const thread = { ...(envelope["thread"] as JsonObject) };
      if (response === "source") thread["id"] = binding.nativeSessionId!;
      if (response === "foreign-target") thread["cwd"] = foreignRoot;
      if (response === "missing-target") delete thread["cwd"];
      if (response === "malformed-history") thread["turns"] = "invalid";
      return { ...envelope, thread };
    });

    const recordBinding = vi.fn();
    const failure: unknown = await setup.adapter.clone(bound, { sessionId: "derived-session", target: bound.target, recordBinding }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ publicError: { code, stateMayHaveChanged: true, retryable: false } });
    expect(JSON.stringify(failure)).not.toContain(foreignRoot);
    expect(JSON.stringify(failure)).not.toContain(binding.nativeSessionId);
    const knownDerived = response !== "source" && response !== "malformed";
    expect(recordBinding).toHaveBeenCalledTimes(knownDerived ? 1 : 0);
    const released = transport.requests.filter((entry) => entry.method === "thread/unsubscribe");
    expect(released).toHaveLength(knownDerived ? 1 : 0);
    expect(released.some((entry) => (entry.params as JsonObject)["threadId"] === binding.nativeSessionId)).toBe(false);
    expect(transport.requests.some((entry) => entry.method === "thread/delete")).toBe(false);
    interceptor.mockRestore();

    await expect(setup.adapter.send(prompt("source remains attached"), {
      ...bound,
      operationId: "source-after-invalid-fork"
    })).resolves.toBeUndefined();
    await setup.fake.completeTurn(binding.nativeSessionId!);
    expect(events.at(-1)).toEqual({ type: "done", outcome: "completed" });
  });

  it.each(["source-closed", "receipt-rejected", "detach-rejected"] as const)("retains the exact clone receipt across %s and never releases the source by derived identity", async (boundary) => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(sessionInput(setup.target), context(setup.target, events, { backendInstanceGeneration: 7 }));
    const bound = context(setup.target, events, { binding, backendInstanceGeneration: 7 });
    const transport = setup.fake.transport!;
    const request = transport.request.bind(transport);
    let nativeDerivedId: string | undefined;
    vi.spyOn(transport, "request").mockImplementation(async (method, params, options) => {
      if (method === "thread/unsubscribe" && (params as JsonObject)["threadId"] === nativeDerivedId && boundary === "detach-rejected") {
        throw new TransportFault("request_timeout", "Unsubscribe response unavailable", { stateMayHaveChanged: true });
      }
      const response = await request(method, params, options);
      if (method === "thread/fork") {
        nativeDerivedId = ((response as JsonObject)["thread"] as JsonObject)["id"] as string;
        if (boundary === "source-closed") await setup.adapter.closeSession(binding, bound);
      }
      return response;
    });
    const recordBinding = vi.fn((derived: NativeSessionBinding) => {
      expect(derived.nativeSessionId).toBe(nativeDerivedId);
      if (boundary === "receipt-rejected") throw new Error("Receipt storage unavailable");
    });
    const failure = await setup.adapter.clone(bound, { sessionId: "derived-session", target: bound.target, recordBinding }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(recordBinding).toHaveBeenCalledTimes(1);
    if (boundary === "source-closed") expect(failure).toMatchObject({ publicError: { code: "CODEX_RUNTIME_GENERATION_STALE", stateMayHaveChanged: true } });
    if (boundary === "detach-rejected") expect(failure).toMatchObject({ publicError: { code: "CODEX_SESSION_FORK_DETACH_FAILED", stateMayHaveChanged: true } });
    if (boundary !== "source-closed") {
      expect(transport.requests.some((entry) => entry.method === "thread/unsubscribe" && (entry.params as JsonObject)["threadId"] === binding.nativeSessionId)).toBe(false);
      await setup.adapter.send(prompt("source still owns its event sink"), { ...bound, operationId: "after-clone-failure" });
      await setup.fake.completeTurn(binding.nativeSessionId!);
      expect(events.at(-1)).toEqual({ type: "done", outcome: "completed" });
    }
  });

  it("rejects detached deletion through another owner or profile before issuing native deletion", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(sessionInput(setup.target), context(setup.target, events, { backendInstanceGeneration: 7 }));
    const bound = context(setup.target, events, { binding, backendInstanceGeneration: 7 });
    await expect(setup.adapter.deleteSession(binding, { ...bound, sessionId: "another-product-session" }))
      .rejects.toMatchObject({ publicError: { code: "CODEX_SESSION_ACTIVE", stateMayHaveChanged: false } });
    const profileDirectory = await mkdtemp(join(tmpdir(), "joko-codex-delete-profile-"));
    cleanups.push(() => rm(profileDirectory, { recursive: true, force: true }));
    const otherProfile = await createSetup(7, { profileDirectory });
    await expect(otherProfile.adapter.deleteSession(binding, context(otherProfile.target, [], { binding, backendInstanceGeneration: 7 })))
      .rejects.toMatchObject({ publicError: { code: "CODEX_NATIVE_REFERENCE_INVALID", stateMayHaveChanged: false } });
    expect(setup.fake.transport!.requests.some((entry) => entry.method === "thread/delete")).toBe(false);
    expect(otherProfile.fake.transport?.requests.some((entry) => entry.method === "thread/delete") ?? false).toBe(false);
  });

  it("keeps the steer target selected at entry when native turns change before the first continuation", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(sessionInput(setup.target), context(setup.target, events, { backendInstanceGeneration: 7 }));
    const base = context(setup.target, events, { binding, backendInstanceGeneration: 7, operationId: "entry-first-turn" });
    await setup.adapter.send(prompt("First turn"), base);
    const transport = setup.fake.transport!;
    const thread = setup.fake.threads.get(binding.nativeSessionId!)!;
    const firstTurn = thread.turns.at(-1)!;
    const pending = setup.adapter.send({ ...prompt("Steer the first turn"), disposition: "steer" }, {
      ...base,
      operationId: "entry-steer-first-turn"
    }).catch((error: unknown) => error);

    firstTurn["status"] = "completed";
    thread.status = { type: "idle" };
    const completed = transport.emitNotification("turn/completed", { threadId: thread.id, turn: firstTurn });
    const started = transport.request("turn/start", {
      threadId: thread.id,
      input: [],
      clientUserMessageId: "native-second-turn"
    });
    await Promise.all([completed, started]);

    expect(await pending).toMatchObject({ publicError: { code: "CODEX_ACTIVE_TURN_REQUIRED", stateMayHaveChanged: false } });
    expect(transport.requests.filter((request) => request.method === "turn/steer")).toEqual([]);
    expect(thread.turns.at(-1)?.["id"]).toBe("turn-2");
    expect(thread.turns.flatMap((turn) => turn["items"] as JsonObject[])
      .some((item) => item["clientId"] === "entry-steer-first-turn")).toBe(false);
  });

  it.each(["closed", "disconnected"] as const)("does not restore a %s runtime to select a steer target", async (boundary) => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(sessionInput(setup.target), context(setup.target, events, { backendInstanceGeneration: 7 }));
    const base = context(setup.target, events, { binding, backendInstanceGeneration: 7, operationId: "bound-steer-start" });
    await setup.adapter.send(prompt("First turn"), base);
    if (boundary === "closed") await setup.adapter.closeSession(binding, base);
    else await setup.fake.transport!.exit();
    const resume = vi.spyOn(setup.adapter, "resumeSession");

    await expect(setup.adapter.send({ ...prompt("Keep the selected turn"), disposition: "steer" }, {
      ...base,
      operationId: "retired-runtime-steer"
    })).rejects.toMatchObject({ publicError: { stateMayHaveChanged: false } });

    expect(resume).not.toHaveBeenCalled();
    expect(setup.fake.transport?.requests.filter((request) => request.method === "turn/steer")).toEqual([]);
  });

  it.each(["next_turn", "cancel", "close", "generation"] as const)("does not dispatch a prepared steer across %s", async (boundary) => {
    const data = Buffer.from("bounded image fixture");
    let releaseImage!: (value: { readonly data: Uint8Array; readonly mimeType: string }) => void;
    let imageRequested!: () => void;
    const requested = new Promise<void>((resolve) => { imageRequested = resolve; });
    const image = new Promise<{ readonly data: Uint8Array; readonly mimeType: string }>((resolve) => { releaseImage = resolve; });
    const setup = await createSetup(7, { readBlob: async () => { imageRequested(); return image; } });
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(sessionInput(setup.target), context(setup.target, events, { backendInstanceGeneration: 7 }));
    const base = context(setup.target, events, { binding, backendInstanceGeneration: 7, operationId: "first-turn" });
    await setup.adapter.send(prompt("First turn"), base);
    const cancellation = new AbortController();
    const pending = setup.adapter.send({
      ...prompt("Steer the first turn"),
      disposition: "steer",
      images: [{ blob: { id: "steer-image", byteLength: data.byteLength, sha256: createHash("sha256").update(data).digest("hex"), mimeType: "image/png" } }]
    }, { ...base, operationId: "steer-first-turn", signal: cancellation.signal }).catch((error: unknown) => error);
    await requested;
    if (boundary === "next_turn") {
      await setup.fake.completeTurn(binding.nativeSessionId!);
      await setup.adapter.send(prompt("Second turn"), { ...base, operationId: "second-turn" });
    } else if (boundary === "cancel") {
      cancellation.abort();
    } else {
      await setup.adapter.closeSession(binding, base);
      if (boundary === "generation") {
        await setup.adapter.resumeSession(binding, { ...base, generation: 2, binding: { ...binding, generation: 2 } });
      }
    }
    if (boundary !== "next_turn") expect(await pending).toMatchObject({ publicError: { stateMayHaveChanged: false } });
    releaseImage({ data, mimeType: "image/png" });
    expect(await pending).toMatchObject({ publicError: { stateMayHaveChanged: false } });
    expect(setup.fake.transport?.requests.filter((request) => request.method === "turn/steer")).toEqual([]);
    expect(setup.fake.threads.get(binding.nativeSessionId!)?.turns.flatMap((turn) => turn["items"] as JsonObject[])
      .some((item) => item["clientId"] === "steer-first-turn")).toBe(false);
  });

  it("steers only the active native turn and forwards cancellation to the RPC wait", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(sessionInput(setup.target), context(setup.target, events, { backendInstanceGeneration: 7 }));
    const base = context(setup.target, events, { binding, backendInstanceGeneration: 7, operationId: "steer-owner-start" });
    await setup.adapter.send(prompt("First turn"), base);
    const cancellation = new AbortController();
    await setup.adapter.send({ ...prompt("Same turn"), disposition: "steer" }, { ...base, operationId: "steer-owner-message", signal: cancellation.signal });
    const requests = setup.fake.transport!.requests.filter((request) => request.method === "turn/steer");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.params).toMatchObject({ threadId: binding.nativeSessionId, expectedTurnId: "turn-1", clientUserMessageId: "steer-owner-message" });
    expect(requests[0]?.options.signal?.aborted).toBe(false);
    cancellation.abort();
    expect(requests[0]?.options.signal?.aborted).toBe(true);
    expect(setup.fake.threads.get(binding.nativeSessionId!)?.turns).toHaveLength(1);
    await expect(setup.fake.transport!.request("turn/steer", { threadId: binding.nativeSessionId!, expectedTurnId: "another-turn", input: [] }))
      .rejects.toMatchObject({ rpcCode: -32602 });
    await setup.fake.completeTurn(binding.nativeSessionId!);
    await expect(setup.fake.transport!.request("turn/steer", { threadId: binding.nativeSessionId!, expectedTurnId: "turn-1", input: [] }))
      .rejects.toMatchObject({ rpcCode: -32602 });
  });

  it("cancels steer admission when the runtime closes during the host readiness wait", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(sessionInput(setup.target), context(setup.target, events, { backendInstanceGeneration: 7 }));
    const base = context(setup.target, events, { binding, backendInstanceGeneration: 7, operationId: "before-admission-close" });
    await setup.adapter.send(prompt("First turn"), base);
    const ensureStarted = setup.host.ensureStarted.bind(setup.host);
    vi.spyOn(setup.host, "ensureStarted").mockImplementationOnce(async () => {
      await setup.adapter.closeSession(binding, base);
      return ensureStarted();
    });
    await expect(setup.adapter.send({ ...prompt("Stop before dispatch"), disposition: "steer" }, { ...base, operationId: "closed-at-admission" }))
      .rejects.toMatchObject({ publicError: { stateMayHaveChanged: false } });
    expect(setup.fake.transport?.requests.filter((request) => request.method === "turn/steer")).toEqual([]);
  });

  it("keeps an in-flight cancelled steer unknown and does not send it again after a late response", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(sessionInput(setup.target), context(setup.target, events, { backendInstanceGeneration: 7 }));
    const base = context(setup.target, events, { binding, backendInstanceGeneration: 7, operationId: "inflight-steer-start" });
    await setup.adapter.send(prompt("First turn"), base);
    const transport = setup.fake.transport!;
    const request = transport.request.bind(transport);
    let entered!: () => void;
    const admitted = new Promise<void>((resolve) => { entered = resolve; });
    let lateAck!: (value: JsonObject) => void;
    const intercepted = vi.spyOn(transport, "request").mockImplementation((method, params, options) => {
      if (method !== "turn/steer") return request(method, params, options);
      return new Promise((resolve, reject) => {
        lateAck = resolve;
        options!.signal!.addEventListener("abort", () => reject(new TransportFault("closed", "Scripted delivery is uncertain.", { stateMayHaveChanged: true })), { once: true });
        entered();
      });
    });
    const cancellation = new AbortController();
    const pending = setup.adapter.send({ ...prompt("Unconfirmed input"), disposition: "steer" }, { ...base, operationId: "inflight-steer", signal: cancellation.signal });
    await admitted;
    cancellation.abort();
    await expect(pending).rejects.toMatchObject({ publicError: { code: "CODEX_DISPATCH_UNKNOWN", stateMayHaveChanged: true } });
    lateAck({ turnId: "turn-1" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(intercepted.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(1);
    expect(transport.requests.filter((value) => value.method === "turn/start")).toHaveLength(1);
  });

  it("reconciles a lost steer ACK only in its original turn without replacing a later active turn", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(sessionInput(setup.target), context(setup.target, events, { backendInstanceGeneration: 7 }));
    const base = context(setup.target, events, { binding, backendInstanceGeneration: 7, operationId: "lost-steer-start" });
    await setup.adapter.send(prompt("First turn"), base);
    const transport = setup.fake.transport!;
    const request = transport.request.bind(transport);
    let loseResponse = true;
    vi.spyOn(transport, "request").mockImplementation(async (method, params, options) => {
      const response = await request(method, params, options);
      if (method === "turn/steer" && loseResponse) {
        loseResponse = false;
        await setup.fake.completeTurn(binding.nativeSessionId!);
        setup.fake.threads.get(binding.nativeSessionId!)!.turns.push(...Array.from({ length: 100 }, (_, index) => historyTurn(index)));
        await setup.adapter.send(prompt("Second turn"), { ...base, operationId: "lost-steer-second-turn" });
        throw new TransportFault("request_timeout", "Scripted acknowledgement was lost.", { stateMayHaveChanged: true });
      }
      return response;
    });
    await setup.adapter.send({ ...prompt("Accepted in first turn"), disposition: "steer" }, { ...base, operationId: "lost-steer-first-turn" });
    await expect(setup.adapter.inspectSession(binding, base)).resolves.toMatchObject({ streaming: true });
    expect(transport.requests.filter((value) => value.method === "turn/steer")).toHaveLength(1);
    expect(transport.requests.filter((value) => value.method === "thread/turns/list" && (value.params as JsonObject)["sortDirection"] === "asc")).toHaveLength(2);
    await setup.adapter.send({ ...prompt("Explicit new steer"), disposition: "steer" }, { ...base, operationId: "explicit-second-steer" });
    expect(transport.requests.filter((value) => value.method === "turn/steer").at(-1)?.params).toMatchObject({ expectedTurnId: "turn-2" });
  });

  it("does not clear a newer active turn when an older accepted start is confirmed by complete history", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(sessionInput(setup.target), context(setup.target, events, { backendInstanceGeneration: 7 }));
    const base = context(setup.target, events, { binding, backendInstanceGeneration: 7, operationId: "lost-start-first" });
    const transport = setup.fake.transport!;
    const request = transport.request.bind(transport);
    let first = true;
    vi.spyOn(transport, "request").mockImplementation(async (method, params, options) => {
      const result = await request(method, params, options);
      if (method === "turn/start" && first) {
        first = false;
        await setup.fake.completeTurn(binding.nativeSessionId!);
        await setup.adapter.send(prompt("New active turn"), { ...base, operationId: "new-active-second" });
        throw new TransportFault("request_timeout", "The earlier start acknowledgement was lost.", { stateMayHaveChanged: true });
      }
      return result;
    });
    await setup.adapter.send(prompt("Earlier completed turn"), base);
    await expect(setup.adapter.inspectSession(binding, base)).resolves.toMatchObject({ streaming: true });
    await setup.adapter.send({ ...prompt("Steer the current turn"), disposition: "steer" }, { ...base, operationId: "new-current-steer" });
    expect(transport.requests.filter((value) => value.method === "turn/start")).toHaveLength(2);
    expect(transport.requests.filter((value) => value.method === "turn/steer")).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ expectedTurnId: "turn-2" }) })
    ]);
  });

  it("holds manual compaction until the native compaction item is durably emitted", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const bound = context(setup.target, events, { binding, backendInstanceGeneration: 7 });
    await expect(setup.adapter.compact(undefined, bound)).resolves.toBe("compacted");
    const compactions = events.filter((event) => event.type === "compaction");
    expect(compactions).toEqual([
      expect.objectContaining({ state: "started", compactionId: "compaction-turn-1" }),
      expect.objectContaining({ state: "completed", compactionId: "compaction-turn-1" })
    ]);
  });

  it("recovers the exact active turn id before interrupting a resumed thread", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const bound = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "active-before-resume"
    });
    await setup.adapter.send({
      text: "keep this turn active",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, bound);
    await setup.adapter.closeSession(binding, bound);
    await setup.adapter.resumeSession(binding, bound);
    await setup.adapter.abort(bound);

    expect(setup.fake.transport?.requests.some((request) => request.method === "thread/turns/list")).toBe(true);
    expect(setup.fake.transport?.requests.findLast((request) => request.method === "turn/interrupt")?.params)
      .toMatchObject({ threadId: binding.nativeSessionId, turnId: "turn-1" });
  });

  it("resumes only the same native identity across exactly one durable generation", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const nextBinding = { ...binding, generation: 2 };
    await expect(setup.adapter.resumeSession(binding, context(setup.target, events, {
      binding: nextBinding,
      backendInstanceGeneration: 7,
      generation: 2
    }))).resolves.toMatchObject({ binding: nextBinding });

    const resumeRequests = setup.fake.transport?.requests.filter((request) => request.method === "thread/resume").length ?? 0;
    const failures: readonly [NativeSessionBinding, AdapterContext][] = [
      [binding, context(setup.target, events, {
        binding: { ...binding, generation: 3 },
        backendInstanceGeneration: 7,
        generation: 3
      })],
      [nextBinding, context(setup.target, events, {
        backendInstanceGeneration: 7,
        generation: 3
      })],
      [nextBinding, context(setup.target, events, {
        binding: { ...nextBinding, nativeSessionId: "foreign", generation: 3 },
        backendInstanceGeneration: 7,
        generation: 3
      })]
    ];
    for (const [candidate, resumeContext] of failures) {
      await expect(setup.adapter.resumeSession(candidate, resumeContext))
        .rejects.toMatchObject({ publicError: { code: "CODEX_SESSION_BINDING_MISMATCH" } });
    }
    await expect(setup.adapter.resumeSession(nextBinding, context(setup.target, events, {
      binding: { opaqueRef: "codex-thread:foreign", nativeSessionId: "foreign", generation: 3 },
      backendInstanceGeneration: 7,
      generation: 3
    }))).rejects.toMatchObject({ publicError: { code: "CODEX_NATIVE_REFERENCE_INVALID" } });
    expect(setup.fake.transport?.requests.filter((request) => request.method === "thread/resume"))
      .toHaveLength(resumeRequests);
  });

  it("reads complete bounded native history only through the current thread and cwd fence", async () => {
    const setup = await createSetup(7, { maximumHistoryItems: 2, maximumHistoryEvents: 16 });
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    setup.fake.threads.get(binding.nativeSessionId!)!.turns.push({
      id: "history-turn",
      status: "completed",
      items: [
        { type: "userMessage", id: "history-user", clientId: null, content: [{ type: "text", text: "hello" }] },
        { type: "agentMessage", id: "history-assistant", text: "answer", phase: null, memoryCitation: null, delivery: null }
      ],
      error: null,
      durationMs: 4
    });
    const bound = context(setup.target, events, { binding, backendInstanceGeneration: 7 });
    await expect(setup.adapter.getNativeHistoryProjection(bound)).resolves.toMatchObject({
      activeEntryId: "history-assistant",
      activeLineage: [
        { entryId: "history-user" },
        { entryId: "history-assistant", parentEntryId: "history-user" }
      ]
    });
    expect(setup.fake.transport?.requests.findLast((request) => request.method === "thread/read")?.params)
      .toMatchObject({ threadId: binding.nativeSessionId, includeTurns: false });

    setup.fake.nextThreadReadOverride = {
      id: binding.nativeSessionId!,
      cwd: join(setup.target.workspaceRoot, "foreign"),
      turns: []
    };
    await expect(setup.adapter.getNativeHistoryProjection(bound))
      .rejects.toMatchObject({ publicError: { code: "CODEX_NATIVE_SESSION_TARGET_MISMATCH" } });

    setup.fake.threads.get(binding.nativeSessionId!)!.turns[0]!["items"] = [
      { type: "userMessage", id: "one", content: [] },
      { type: "agentMessage", id: "two", text: "two" },
      { type: "agentMessage", id: "three", text: "three" }
    ];
    await expect(setup.adapter.getNativeHistoryProjection(bound))
      .rejects.toMatchObject({ publicError: { code: "CODEX_NATIVE_HISTORY_UNAVAILABLE" } });
  });

  it("hydrates every full history page in order and ignores unrelated or usage-only wire notifications", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(sessionInput(setup.target), context(setup.target, events, { backendInstanceGeneration: 7 }));
    setup.fake.threads.get(binding.nativeSessionId!)!.turns.push(...Array.from({ length: 201 }, (_, index) => historyTurn(index)));
    const bound = context(setup.target, events, { binding, backendInstanceGeneration: 7 });
    const transport = setup.fake.transport!;
    const request = transport.request.bind(transport);
    vi.spyOn(transport, "request").mockImplementation(async (method, params, options) => {
      const value = await request(method, params, options);
      if (method === "thread/turns/list" && (params as JsonObject)["sortDirection"] === "asc") {
        await transport.emitNotification("thread/reverted", { threadId: "another-thread" });
        await transport.emitNotification("thread/tokenUsage/updated", {
          threadId: binding.nativeSessionId!, turnId: "history-turn-200",
          tokenUsage: { total: { totalTokens: 1, inputTokens: 1, outputTokens: 0, cachedInputTokens: 0 }, last: { totalTokens: 1, inputTokens: 1, outputTokens: 0, cachedInputTokens: 0 } }
        });
      }
      return value;
    });
    const projection = await setup.adapter.getNativeHistoryProjection(bound);
    expect(projection.activeEntryId).toBe("history-item-200");
    expect(projection.activeLineage?.map((entry) => entry.entryId)).toEqual(Array.from({ length: 201 }, (_, index) => `history-item-${index}`));
    const pages = transport.requests.filter((value) => value.method === "thread/turns/list");
    expect(pages.map((value) => value.params)).toEqual([
      { threadId: binding.nativeSessionId, sortDirection: "asc", itemsView: "full", limit: 100 },
      { threadId: binding.nativeSessionId, sortDirection: "asc", itemsView: "full", limit: 100, cursor: "turn-page-100" },
      { threadId: binding.nativeSessionId, sortDirection: "asc", itemsView: "full", limit: 100, cursor: "turn-page-200" },
      { threadId: binding.nativeSessionId, sortDirection: "desc", itemsView: "full", limit: 1 }
    ]);
    expect(pages.every((value) => value.options.signal !== undefined && value.options.timeoutMs! <= 30_000)).toBe(true);
    expect(transport.requests.filter((value) => value.method === "thread/read").every((value) => (value.params as JsonObject)["includeTurns"] === false)).toBe(true);
  });

  it.each(["cursor-loop", "duplicate-turn", "duplicate-item", "pages", "turns", "items", "aggregate-bytes"] as const)(
    "rejects incomplete full history at the %s boundary without returning a truncated projection", async (boundary) => {
      const setup = await createSetup(7, {
        ...(boundary === "pages" ? { maximumHistoryPages: 1 } : {}),
        ...(boundary === "turns" ? { maximumHistoryTurns: 100 } : {}),
        ...(boundary === "items" ? { maximumHistoryItems: 100 } : {}),
        ...(boundary === "aggregate-bytes" ? { maximumHistoryBytes: 1_200 } : {})
      });
      const events: EventPayload[] = [];
      const binding = await setup.adapter.createSession(sessionInput(setup.target), context(setup.target, events, { backendInstanceGeneration: 7 }));
      const thread = setup.fake.threads.get(binding.nativeSessionId!)!;
      thread.turns.push(...Array.from({ length: boundary === "aggregate-bytes" ? 1 : 101 }, (_, index) => historyTurn(index, boundary === "aggregate-bytes" ? "x".repeat(400) : "answer")));
      const transport = setup.fake.transport!;
      const request = transport.request.bind(transport);
      let fullPages = 0;
      const responseBytes: number[] = [];
      const intercepted = vi.spyOn(transport, "request").mockImplementation(async (method, params, options) => {
        let result = await request(method, params, options);
        if (method === "thread/turns/list" && (params as JsonObject)["sortDirection"] === "asc") {
          fullPages += 1;
          if (boundary === "cursor-loop") result = { data: [historyTurn(fullPages)], nextCursor: "turn-page-1", backwardsCursor: null };
          if (fullPages === 2 && boundary === "duplicate-turn") result = { data: [historyTurn(0)], nextCursor: null };
          if (fullPages === 2 && boundary === "duplicate-item") result = { data: [{ ...historyTurn(100), items: (historyTurn(0))["items"]! }], nextCursor: null };
        }
        responseBytes.push(Buffer.byteLength(JSON.stringify(result)));
        return result;
      });
      await expect(setup.adapter.getNativeHistoryProjection(context(setup.target, events, { binding, backendInstanceGeneration: 7 })))
        .rejects.toMatchObject({ publicError: { code: ["cursor-loop", "duplicate-turn", "duplicate-item"].includes(boundary) ? "CODEX_NATIVE_HISTORY_UNAVAILABLE" : "CODEX_NATIVE_HISTORY_SIZE_LIMIT" } });
      expect(fullPages).toBe(boundary === "pages" || boundary === "aggregate-bytes" ? 1 : 2);
      if (boundary === "aggregate-bytes") {
        expect(responseBytes.every((bytes) => bytes < 1_200)).toBe(true);
        expect(responseBytes.reduce((sum, bytes) => sum + bytes, 0)).toBeGreaterThan(1_200);
      }
      expect(intercepted.mock.calls.some(([method]) => method === "turn/start" || method === "turn/steer")).toBe(false);
    }
  );

  it("does not activate a detached runtime for an already cancelled history read", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(sessionInput(setup.target), context(setup.target, events, { backendInstanceGeneration: 7 }));
    const bound = context(setup.target, events, { binding, backendInstanceGeneration: 7 });
    await setup.adapter.closeSession(binding, bound);
    const before = setup.fake.transport!.requests.length;
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(setup.adapter.getNativeHistoryProjection({ ...bound, signal: cancellation.signal }))
      .rejects.toMatchObject({ publicError: { code: "CODEX_NATIVE_HISTORY_CANCELLED" } });
    expect(setup.fake.transport!.requests).toHaveLength(before);
  });

  it.each(["cancel", "close", "replace", "disconnect", "timeout"] as const)(
    "settles a paginated read on %s even when its transport ignores cancellation and returns late", async (boundary) => {
      const setup = await createSetup(7, { historyReadTimeoutMs: boundary === "timeout" ? 60 : 1_000 });
      const events: EventPayload[] = [];
      const binding = await setup.adapter.createSession(sessionInput(setup.target), context(setup.target, events, { backendInstanceGeneration: 7 }));
      setup.fake.threads.get(binding.nativeSessionId!)!.turns.push(...Array.from({ length: 101 }, (_, index) => historyTurn(index)));
      const cancellation = new AbortController();
      const bound = { ...context(setup.target, events, { binding, backendInstanceGeneration: 7 }), signal: cancellation.signal };
      const transport = setup.fake.transport!;
      const request = transport.request.bind(transport);
      let entered!: () => void;
      let release!: () => void;
      const admitted = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      let hold = true;
      const intercepted = vi.spyOn(transport, "request").mockImplementation(async (method, params, options) => {
        const result = await request(method, params, options);
        if (hold && method === "thread/turns/list" && (params as JsonObject)["cursor"] !== undefined) {
          hold = false;
          entered();
          await held;
        }
        return result;
      });
      const pending = setup.adapter.getNativeHistoryProjection(bound).catch((error: unknown) => error);
      await admitted;
      if (boundary === "cancel") cancellation.abort();
      if (boundary === "close" || boundary === "replace") await setup.adapter.closeSession(binding, bound);
      if (boundary === "replace") await setup.adapter.resumeSession(binding, bound);
      if (boundary === "disconnect") await transport.exit();
      expect(await pending).toMatchObject({ publicError: { code: boundary === "timeout" ? "CODEX_NATIVE_HISTORY_TIMEOUT" : "CODEX_NATIVE_HISTORY_CANCELLED" } });
      const calls = intercepted.mock.calls.length;
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(intercepted.mock.calls).toHaveLength(calls);
    }
  );

  it.each(["thread/reverted", "turn/completed", "item/agentMessage/delta", "silent-tail-change", "silent-prefix-change"] as const)(
    "rejects history changed during hydration by %s", async (boundary) => {
      const setup = await createSetup();
      const events: EventPayload[] = [];
      const binding = await setup.adapter.createSession(sessionInput(setup.target), context(setup.target, events, { backendInstanceGeneration: 7 }));
      setup.fake.threads.get(binding.nativeSessionId!)!.turns.push(historyTurn(0));
      const transport = setup.fake.transport!;
      const request = transport.request.bind(transport);
      vi.spyOn(transport, "request").mockImplementation(async (method, params, options) => {
        const result = await request(method, params, options);
        if (method === "thread/turns/list" && (params as JsonObject)["sortDirection"] === "asc") {
          if (boundary === "silent-tail-change") setup.fake.threads.get(binding.nativeSessionId!)!.turns[0] = historyTurn(0, "updated between pages");
          else if (boundary === "silent-prefix-change") setup.fake.threads.get(binding.nativeSessionId!)!.turns.unshift(historyTurn(1));
          else await transport.emitNotification(boundary, { threadId: binding.nativeSessionId!, turnId: "history-turn-0", turn: historyTurn(0), itemId: "history-item-0", delta: "changed" });
        }
        return result;
      });
      await expect(setup.adapter.getNativeHistoryProjection(context(setup.target, events, { binding, backendInstanceGeneration: 7 })))
        .rejects.toMatchObject({ publicError: { code: "CODEX_NATIVE_HISTORY_STALE" } });
    }
  );

  it("publishes only Adapter-safe Host-composed capabilities", async () => {
    const setup = await createSetup(7, {
      hostCapabilities: ["workspace.generated_files", "session.attention"]
    });
    const descriptor = await setup.adapter.describe();
    expect(descriptor.capabilities.get("workspace.generated_files")).toMatchObject({ supported: true });
    expect(descriptor.capabilities.get("session.attention")).toMatchObject({ supported: true });
    expect(descriptor.capabilities.get("tool.browser")).toMatchObject({ supported: false });
    expect(descriptor.capabilities.get("tool.computer")).toMatchObject({ supported: false });
    expect(descriptor.capabilities.get("tool.android")).toMatchObject({ supported: false });
    expect(descriptor.capabilities.get("workspace.extra_dirs")).toMatchObject({ supported: false });
    expect(() => new CodexBackendAdapter({
      instanceGeneration: 7,
      host: setup.host,
      hostCapabilities: ["workspace.extra_dirs" as never]
    })).toThrow("Codex Host-composed capability is invalid");
  });

  it("owns Codex native memory through durable local reconcile while keeping Review and remote policy isolated", async () => {
    let enabled = false;
    const resolveNativeMemoryEnabled = vi.fn(async () => enabled);
    const setup = await createSetup(7, { resolveNativeMemoryEnabled });

    await expect(setup.adapter.reconcileNativeMemory()).resolves.toBe("next_session");
    expect(setup.fake.transport).toBeUndefined();
    const descriptor = await setup.adapter.describe();
    expect(descriptor.capabilities.get("memory.native")).toEqual({
      key: "memory.native",
      supported: true,
      options: ["live_local", "default_disabled", "reset_local"]
    });

    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, [], { backendInstanceGeneration: 7 })
    );
    const transport = setup.fake.transport!;
    const initialOverride = transport.requests.findIndex((request) =>
      request.method === "experimentalFeature/enablement/set");
    const initialStart = transport.requests.findIndex((request) => request.method === "thread/start");
    expect(initialOverride).toBeGreaterThan(-1);
    expect(initialOverride).toBeLessThan(initialStart);
    expect(transport.requests[initialOverride]?.params).toEqual({ enablement: { memories: false } });
    expect(setup.fake.memoryEnabledForThread(binding.nativeSessionId!)).toBe(false);
    await setup.adapter.send(prompt("memory sandbox"), context(setup.target, [], {
      binding,
      backendInstanceGeneration: 7,
      operationId: "memory-sandbox"
    }));
    expect(transport.requests.findLast((request) => request.method === "turn/start")?.params)
      .toMatchObject({
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/private/memories"]
        }
      });
    await setup.fake.completeTurn(binding.nativeSessionId!, "memory sandbox ready");

    enabled = true;
    await expect(setup.adapter.reconcileNativeMemory()).resolves.toBe("immediate");
    expect(setup.fake.memoryEnabledForThread(binding.nativeSessionId!)).toBe(true);

    const reviewContext: AdapterContext = {
      ...context(setup.target, [], { backendInstanceGeneration: 7 }),
      sessionId: "session-codex-review",
      runtimePolicy: "review_read_only",
      extraDirectories: []
    };
    const reviewBinding = await setup.adapter.createSession({
      ...sessionInput(setup.target),
      nativeStart: { kind: "new" },
      runtimePolicy: "review_read_only"
    }, reviewContext);
    expect(setup.fake.memoryEnabledForThread(reviewBinding.nativeSessionId!)).toBe(false);

    enabled = false;
    await setup.adapter.reconcileNativeMemory();
    expect(setup.fake.memoryEnabledForThread(binding.nativeSessionId!)).toBe(false);
    expect(setup.fake.memoryEnabledForThread(reviewBinding.nativeSessionId!)).toBe(false);

    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const request = transport.request.bind(transport);
    let blockNext = true;
    vi.spyOn(transport, "request").mockImplementation(async (method, params, options) => {
      if (method === "experimentalFeature/enablement/set" && blockNext) {
        blockNext = false;
        markFirstStarted();
        await release;
      }
      return request(method, params, options);
    });
    enabled = true;
    const older = setup.adapter.reconcileNativeMemory();
    await firstStarted;
    enabled = false;
    const newer = setup.adapter.reconcileNativeMemory();
    releaseFirst();
    await Promise.all([older, newer]);
    const reconciles = transport.requests
      .filter((request) => request.method === "experimentalFeature/enablement/set")
      .slice(-2)
      .map((request) => request.params);
    expect(reconciles).toEqual([
      { enablement: { memories: true } },
      { enablement: { memories: false } }
    ]);
    expect(setup.fake.nativeMemoryEnabled).toBe(false);

    await setup.fake.transport!.exit(false);
    enabled = true;
    await expect(setup.adapter.reconcileNativeMemory()).resolves.toBe("next_session");
    const restartedContext = {
      ...context(setup.target, [], { backendInstanceGeneration: 7 }),
      sessionId: "session-codex-after-memory-restart"
    };
    await setup.adapter.createSession(sessionInput(setup.target), restartedContext);
    const restartedRequests = setup.fake.transport!.requests;
    const restartedOverride = restartedRequests.findIndex((request) =>
      request.method === "experimentalFeature/enablement/set");
    const restartedStart = restartedRequests.findIndex((request) => request.method === "thread/start");
    expect(restartedOverride).toBeGreaterThan(-1);
    expect(restartedOverride).toBeLessThan(restartedStart);
    expect(restartedRequests[restartedOverride]?.params).toEqual({ enablement: { memories: true } });
  });

  it("resets only the fixed local Codex native-memory owner and preserves unknown counts", async () => {
    const setup = await createSetup(7, { resolveNativeMemoryEnabled: () => true });

    await expect(setup.adapter.resetNativeMemory()).resolves.toEqual({});
    expect(setup.fake.nativeMemoryResetCount).toBe(1);
    expect(setup.fake.transport?.requests.find((request) => request.method === "memory/reset"))
      .toMatchObject({ params: {}, options: { mutation: true } });

    setup.fake.failNextNativeMemoryReset = true;
    await expect(setup.adapter.resetNativeMemory()).rejects.toMatchObject({
      publicError: {
        code: "CODEX_NATIVE_MEMORY_RESET_FAILED",
        stateMayHaveChanged: false
      }
    });
    expect(setup.fake.nativeMemoryResetCount).toBe(1);

    setup.fake.malformedNextNativeMemoryReset = true;
    await expect(setup.adapter.resetNativeMemory()).rejects.toMatchObject({
      publicError: {
        code: "CODEX_NATIVE_MEMORY_RESET_ACK_INVALID",
        stateMayHaveChanged: true
      }
    });
    expect(setup.fake.nativeMemoryResetCount).toBe(2);
  });

  it("keeps a completed Codex native-memory reset authoritative across Adapter disposal", async () => {
    const setup = await createSetup(7, { resolveNativeMemoryEnabled: () => true });
    await setup.adapter.describe();
    const transport = setup.fake.transport!;
    const request = transport.request.bind(transport);
    let releaseResponse!: () => void;
    let markResetCompleted!: () => void;
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const resetCompleted = new Promise<void>((resolve) => { markResetCompleted = resolve; });
    vi.spyOn(transport, "request").mockImplementation(async (method, params, options) => {
      const result = await request(method, params, options);
      if (method === "memory/reset") {
        markResetCompleted();
        await responseGate;
      }
      return result;
    });

    const reset = setup.adapter.resetNativeMemory();
    await resetCompleted;
    expect(setup.fake.nativeMemoryResetCount).toBe(1);
    await setup.adapter.dispose();
    releaseResponse();

    await expect(reset).resolves.toEqual({});
  });

  it("reads effective Codex native-memory status from the exact local runtime and re-pushes after restart", async () => {
    let enabled = true;
    const setup = await createRemoteSetup({ resolveNativeMemoryEnabled: () => enabled });

    await expect(setup.adapter.readNativeMemoryStatus()).resolves.toEqual({ enabled: true });
    let requests = setup.localFake.transport!.requests;
    expect(requests.findIndex((request) => request.method === "experimentalFeature/enablement/set"))
      .toBeLessThan(requests.findIndex((request) => request.method === "config/read"));
    expect(setup.resolveRemote).not.toHaveBeenCalled();
    expect(setup.remoteFake.transport).toBeUndefined();

    enabled = false;
    await expect(setup.adapter.readNativeMemoryStatus()).resolves.toEqual({ enabled: false });
    expect(setup.localFake.nativeMemoryEnabled).toBe(false);

    await setup.localFake.transport!.exit(false);
    enabled = true;
    await expect(setup.adapter.readNativeMemoryStatus()).resolves.toEqual({ enabled: true });
    requests = setup.localFake.transport!.requests;
    expect(requests.findIndex((request) => request.method === "experimentalFeature/enablement/set"))
      .toBeLessThan(requests.findIndex((request) => request.method === "config/read"));
    expect(setup.resolveRemote).not.toHaveBeenCalled();
    expect(setup.remoteFake.transport).toBeUndefined();
  });

  it("fails closed for unconfirmed, malformed, failed, or cancelled Codex native-memory status", async () => {
    const setup = await createSetup(7, { resolveNativeMemoryEnabled: () => true });

    setup.fake.malformedNextNativeMemoryEnablement = true;
    await expect(setup.adapter.readNativeMemoryStatus()).rejects.toMatchObject({
      publicError: { code: "CODEX_NATIVE_MEMORY_ACK_INVALID", stateMayHaveChanged: true }
    });
    expect(setup.fake.transport?.requests.some((request) => request.method === "config/read")).toBe(false);

    setup.fake.nextNativeMemoryStatusResponse = { config: { features: {} } };
    await expect(setup.adapter.readNativeMemoryStatus()).rejects.toMatchObject({
      publicError: { code: "CODEX_NATIVE_MEMORY_STATUS_INVALID", stateMayHaveChanged: false }
    });

    setup.fake.failNextNativeMemoryStatus = true;
    await expect(setup.adapter.readNativeMemoryStatus()).rejects.toMatchObject({
      publicError: { code: "CODEX_NATIVE_MEMORY_STATUS_FAILED", stateMayHaveChanged: false }
    });

    setup.fake.nextNativeMemoryStatusResponse = { config: { features: { memories: false } } };
    await expect(setup.adapter.readNativeMemoryStatus()).resolves.toEqual({ enabled: false });
    const reconcileCount = setup.fake.transport!.requests.filter((request) =>
      request.method === "experimentalFeature/enablement/set").length;
    await expect(setup.adapter.readNativeMemoryStatus()).resolves.toEqual({ enabled: true });
    expect(setup.fake.transport!.requests.filter((request) =>
      request.method === "experimentalFeature/enablement/set")).toHaveLength(reconcileCount + 1);

    const cancelled = new AbortController();
    cancelled.abort();
    const requestsBeforeCancel = setup.fake.transport!.requests.length;
    await expect(setup.adapter.readNativeMemoryStatus(cancelled.signal)).rejects.toMatchObject({
      publicError: { code: "CODEX_NATIVE_MEMORY_STATUS_FAILED", stateMayHaveChanged: false }
    });
    expect(setup.fake.transport!.requests).toHaveLength(requestsBeforeCancel);
  });

  it("marks a lost Codex native-memory reset acknowledgement unknown and never touches a remote runtime", async () => {
    const setup = await createRemoteSetup({ resolveNativeMemoryEnabled: () => true });
    await setup.adapter.describe();
    const transport = setup.localFake.transport!;
    const request = transport.request.bind(transport);
    vi.spyOn(transport, "request").mockImplementation(async (method, params, options) => {
      if (method === "memory/reset") {
        options?.beforeDispatch?.();
        transport.requests.push({ method, params, options: options ?? {} });
        throw new TransportFault("request_timeout", "Fixture acknowledgement was lost.", {
          stateMayHaveChanged: true
        });
      }
      return request(method, params, options);
    });

    await expect(setup.adapter.resetNativeMemory()).rejects.toMatchObject({
      publicError: {
        code: "CODEX_NATIVE_MEMORY_RESET_FAILED",
        stateMayHaveChanged: true,
        retryable: true
      }
    });
    expect(setup.remoteFake.transport).toBeUndefined();
  });

  it("fails closed before native Session mutation when Codex memory authority or acknowledgement is unavailable", async () => {
    const unavailable = await createSetup(7, {
      resolveNativeMemoryEnabled: async () => { throw new Error("private setting failure"); }
    });
    await expect(unavailable.adapter.createSession(
      sessionInput(unavailable.target),
      context(unavailable.target, [], { backendInstanceGeneration: 7 })
    )).rejects.toMatchObject({
      publicError: {
        code: "CODEX_NATIVE_MEMORY_SETTING_UNAVAILABLE",
        stateMayHaveChanged: false
      }
    });
    expect(unavailable.fake.transport?.requests.some((request) => request.method === "thread/start")).toBe(false);

    const malformed = await createSetup(7, { resolveNativeMemoryEnabled: () => true });
    malformed.fake.malformedNextNativeMemoryEnablement = true;
    await expect(malformed.adapter.createSession(
      sessionInput(malformed.target),
      context(malformed.target, [], { backendInstanceGeneration: 7 })
    )).rejects.toMatchObject({
      publicError: {
        code: "CODEX_NATIVE_MEMORY_ACK_INVALID",
        stateMayHaveChanged: true
      }
    });
    expect(malformed.fake.transport?.requests.some((request) => request.method === "thread/start")).toBe(false);
  });

  it.each([
    {
      boundary: "an unaudited app-server version",
      configure: (fake: FakeCodexAppServer) => { fake.userAgent = "codex/0.153.5"; }
    },
    {
      boundary: "a non-absolute codexHome",
      configure: (fake: FakeCodexAppServer) => { fake.codexHome = "relative-private"; }
    }
  ])("keeps native memory unavailable without disturbing standard Codex for $boundary", async ({ configure }) => {
    const resolveNativeMemoryEnabled = vi.fn(() => true);
    const setup = await createSetup(7, { resolveNativeMemoryEnabled });
    configure(setup.fake);

    const descriptor = await setup.adapter.describe();
    expect(descriptor.capabilities.get("memory.native")).toEqual({
      key: "memory.native",
      supported: false,
      reason: "upstream_missing"
    });
    await expect(setup.adapter.resetNativeMemory()).rejects.toMatchObject({
      publicError: { code: "BACKEND_CAPABILITY_UNAVAILABLE", stateMayHaveChanged: false }
    });
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, [], { backendInstanceGeneration: 7 })
    );
    await setup.adapter.send(prompt("standard Codex remains available"), context(setup.target, [], {
      binding,
      backendInstanceGeneration: 7,
      operationId: "unsupported-native-memory"
    }));

    expect(resolveNativeMemoryEnabled).not.toHaveBeenCalled();
    expect(setup.fake.transport?.requests.some((request) =>
      request.method === "experimentalFeature/enablement/set")).toBe(false);
    expect(setup.fake.transport?.requests.findLast((request) => request.method === "turn/start")?.params)
      .not.toHaveProperty("sandboxPolicy");
  });

  it("runs Review through a fresh native profile with only bounded Host-owned readers", async () => {
    const localMcpBridge = vi.fn(async (): Promise<never> => { throw new Error("Review must not open MCP"); });
    const setup = await createSetup(7, { localMcpBridge });
    const skillPath = join(setup.target.workspaceRoot, "review-skill.md");
    await writeFile(skillPath, "skill", "utf8");
    setup.fake.reviewSkills.push({
      name: "review-skill",
      description: "must be disabled",
      enabled: true,
      path: skillPath,
      pluginId: "review-plugin@local",
      scope: "repo"
    });
    setup.fake.reviewConfig = {
      mcp_servers: { docs: { command: "docs-server" } },
      plugins: {
        "review-plugin@local": {
          enabled: true,
          mcp_servers: { plugin_docs: { url: "https://example.invalid/mcp" } }
        }
      }
    };
    setup.fake.reviewMcpStatuses.push(
      { name: "codex_apps", authStatus: "unsupported", resourceTemplates: [], resources: [], tools: {} },
      { name: "docs", authStatus: "unsupported", resourceTemplates: [], resources: [], tools: {} },
      { name: "plugin_docs", authStatus: "unsupported", resourceTemplates: [], resources: [], tools: {} }
    );
    const descriptor = await setup.adapter.describe();
    expect(descriptor.capabilities.get("review.isolated")).toMatchObject({
      supported: true
    });
    const events: EventPayload[] = [];
    let interactionRequests = 0;
    const reviewContext: AdapterContext = {
      ...context(setup.target, events, {
        backendInstanceGeneration: 7,
        requestInteraction: async () => {
          interactionRequests += 1;
          return { kind: "cancelled" };
        }
      }),
      runtimePolicy: "review_read_only",
      extraDirectories: []
    };
    const invalidReviewInputs: CreateNativeSessionInput[] = [{
      ...sessionInput(setup.target),
      nativeStart: { kind: "new", parentNativeReference: "codex:thread:source" },
      runtimePolicy: "review_read_only"
    }, {
      ...sessionInput(setup.target),
      nativeStart: { kind: "attach", nativeReference: "codex:thread:source" },
      runtimePolicy: "review_read_only"
    }, {
      ...sessionInput(setup.target),
      permissionMode: "auto",
      runtimePolicy: "review_read_only"
    }, {
      ...sessionInput(setup.target),
      appendSystemPrompt: "mutable reviewer instructions",
      runtimePolicy: "review_read_only"
    }];
    for (const input of invalidReviewInputs) {
      await expect(setup.adapter.createSession(input, reviewContext))
        .rejects.toMatchObject({ publicError: { code: "CODEX_REVIEW_PROFILE_INVALID" } });
    }
    await expect(setup.adapter.createSession({
      ...sessionInput(setup.target),
      nativeStart: { kind: "new" },
      runtimePolicy: "review_read_only"
    }, context(setup.target, events, { backendInstanceGeneration: 7 })))
      .rejects.toMatchObject({ publicError: { code: "CODEX_REVIEW_PROFILE_INVALID" } });

    await writeFile(join(setup.target.workspaceRoot, "review.txt"), "first line\nneedle line\nlast line", "utf8");
    await writeFile(join(setup.target.workspaceRoot, ".env"), "SECRET=hidden", "utf8");
    const outsideReviewRoot = await realpath(await mkdtemp(join(tmpdir(), "joko-review-outside-")));
    cleanups.push(async () => {
      await rm(outsideReviewRoot, { recursive: true, force: true });
    });
    await writeFile(join(outsideReviewRoot, "outside.txt"), "outside-only-secret", "utf8");
    await symlink(
      outsideReviewRoot,
      join(setup.target.workspaceRoot, "linked-outside"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const binding = await setup.adapter.createSession({
      ...sessionInput(setup.target),
      nativeStart: { kind: "new" },
      runtimePolicy: "review_read_only"
    }, reviewContext);
    const threadStart = setup.fake.transport?.requests.findLast((request) => request.method === "thread/start");
    expect(localMcpBridge).not.toHaveBeenCalled();
    expect(threadStart?.params).toMatchObject({
      approvalPolicy: "never",
      environments: [],
      ephemeral: true,
      permissions: "joko-review-readonly",
      runtimeWorkspaceRoots: [setup.target.workspaceRoot],
      selectedCapabilityRoots: [],
      serviceTier: null
    });
    const startParams = threadStart?.params as Readonly<Record<string, unknown>>;
    const reviewCwd = startParams["cwd"];
    expect(typeof reviewCwd).toBe("string");
    expect(reviewCwd).not.toBe(setup.target.workspaceRoot);
    expect(startParams["developerInstructions"]).toBeUndefined();
    expect(startParams["dynamicTools"]).toEqual([
      expect.objectContaining({ name: "joko_read", type: "function" }),
      expect.objectContaining({ name: "joko_grep", type: "function" }),
      expect.objectContaining({ name: "joko_find", type: "function" }),
      expect.objectContaining({ name: "joko_ls", type: "function" })
    ]);
    const reviewConfig = startParams["config"] as Readonly<Record<string, unknown>>;
    expect(reviewConfig).toMatchObject({
      "features.apps": false,
      "features.browser_use": false,
      "features.hooks": false,
      "features.memories": false,
      "features.multi_agent": false,
      "features.plugins": false,
      "features.remote_plugin": false,
      "features.shell_tool": false,
      "features.unified_exec": false,
      "features.view_image": false,
      "mcp_servers.docs.enabled": false,
      "plugins.\"review-plugin@local\".enabled": false,
      "plugins.\"review-plugin@local\".mcp_servers.plugin_docs.enabled": false,
      web_search: "disabled"
    });
    expect(reviewConfig["skills.config"]).toEqual([{ path: skillPath, enabled: false }]);
    expect(reviewConfig["permissions.joko-review-readonly"]).toMatchObject({
      filesystem: {
        ":root": "deny",
        ":tmpdir": "deny",
        ":workspace_roots": { ".": "read", "**/.env": "deny", "**/.git/**": "deny" }
      },
      network: { enabled: false }
    });

    const boundReview = { ...reviewContext, binding, operationId: "review-prompt" };
    await expect(setup.adapter.resumeSession(binding, boundReview))
      .rejects.toMatchObject({ publicError: { code: "CODEX_REVIEW_OPERATION_DENIED" } });
    await expect(setup.adapter.inspectSession(binding, boundReview)).resolves.toMatchObject({
      binding,
      permissionMode: "ask",
      fastMode: false
    });
    await expect(setup.adapter.getNativeHistoryProjection(boundReview))
      .rejects.toMatchObject({ publicError: { code: "CODEX_REVIEW_OPERATION_DENIED" } });
    await setup.adapter.send({
      text: "Review the captured evidence",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, boundReview);
    expect(setup.fake.transport?.requests.findLast((request) => request.method === "turn/start")?.params)
      .toMatchObject({
        approvalPolicy: "never",
        cwd: reviewCwd,
        environments: [],
        runtimeWorkspaceRoots: [setup.target.workspaceRoot],
        serviceTierForTurn: "default"
      });
    const turnId = String(setup.fake.threads.get(binding.nativeSessionId!)?.turns.at(-1)?.["id"]);
    await expect(setup.fake.requestDynamicTool(binding.nativeSessionId!, turnId, "joko_read", {
      path: "review.txt",
      startLine: 2,
      lineCount: 1
    })).resolves.toMatchObject({ success: true, contentItems: [{ text: "2: needle line" }] });
    await expect(setup.fake.requestDynamicTool(binding.nativeSessionId!, turnId, "joko_grep", {
      path: ".",
      query: "needle"
    })).resolves.toMatchObject({ success: true });
    await expect(setup.fake.requestDynamicTool(binding.nativeSessionId!, turnId, "joko_grep", {
      path: ".",
      query: "outside-only-secret"
    })).resolves.toMatchObject({
      success: true,
      contentItems: [{ text: "No match." }]
    });
    await expect(setup.fake.requestDynamicTool(binding.nativeSessionId!, turnId, "joko_find", {
      path: ".",
      pattern: "*.txt"
    })).resolves.toMatchObject({ success: true });
    await expect(setup.fake.requestDynamicTool(binding.nativeSessionId!, turnId, "joko_ls", {
      path: "."
    })).resolves.toMatchObject({ success: true });
    await expect(setup.fake.requestDynamicTool(binding.nativeSessionId!, turnId, "joko_read", {
      path: "../outside.txt"
    })).resolves.toMatchObject({ success: false });
    await expect(setup.fake.requestDynamicTool(binding.nativeSessionId!, turnId, "joko_read", {
      path: ".env"
    })).resolves.toMatchObject({ success: false });
    await expect(setup.fake.requestCommandApproval(binding.nativeSessionId!, turnId))
      .resolves.toEqual({ decision: "decline" });
    expect(interactionRequests).toBe(0);
    await expect(setup.adapter.setName("review", boundReview))
      .rejects.toMatchObject({ publicError: { code: "CODEX_REVIEW_OPERATION_DENIED" } });
    await expect(setup.adapter.navigateTree({ kind: "native_entry", entryId: "review-entry" }, false, boundReview, undefined, navigationAuthority))
      .rejects.toMatchObject({ publicError: { code: "CODEX_REVIEW_OPERATION_DENIED", stateMayHaveChanged: false } });
    await expect(setup.adapter.deleteSession(binding, boundReview))
      .rejects.toMatchObject({ publicError: { code: "CODEX_REVIEW_OPERATION_DENIED" } });
    await expect(setup.adapter.abort(boundReview)).resolves.toBeUndefined();
    await expect(setup.adapter.closeSession(binding, boundReview)).resolves.toBeUndefined();
    expect(await stat(String(reviewCwd)).catch(() => undefined)).toBeUndefined();
  });

  it("opens a completed native plan through the shared review Interaction and resets execution to default", async () => {
    const setup = await createSetup();
    const descriptor = await setup.adapter.describe();
    expect(descriptor.capabilities.get("interaction.plan_review")).toMatchObject({ supported: true });
    const events: EventPayload[] = [];
    const requests: InteractionPayload[] = [];
    let resolveDecision!: (decision: InteractionDecision) => void;
    const decision = new Promise<InteractionDecision>((resolve) => { resolveDecision = resolve; });
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const active = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "plan-review-source",
      requestInteraction: async (request) => {
        requests.push(request);
        expect(events.at(-1)).toMatchObject({ type: "done", outcome: "completed" });
        return decision;
      }
    });

    await setup.adapter.setPlanMode(true, { ...active, operationId: "plan-review-enable" });
    await setup.adapter.send(prompt("make a plan"), active);
    await setup.fake.completePlanTurn(binding.nativeSessionId!, "1. Inspect\n2. Implement");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual(expect.objectContaining({
      kind: "plan_review",
      title: "Review plan",
      markdown: "1. Inspect\n2. Implement",
      choices: ["execute", "stay", "refine"]
    }));
    expect(events.some((event) => event.type === "text_delta")).toBe(false);

    resolveDecision({ kind: "plan_review", decision: "execute", feedback: "" });
    await vi.waitFor(async () => {
      await expect(setup.adapter.inspectSession(binding, { ...active, operationId: "inspect-plan-review" }))
        .resolves.toMatchObject({ planMode: false });
    });
    await setup.adapter.send(prompt("Implement the plan."), {
      ...active,
      operationId: "plan-review-continuation"
    });
    expect(setup.fake.transport?.requests.filter((request) => request.method === "turn/start").at(-1)?.params)
      .toMatchObject({
        collaborationMode: {
          mode: "default",
          settings: { developer_instructions: null }
        }
      });
    await setup.fake.completeTurn(binding.nativeSessionId!);
  });

  it("does not open plan review for a native plan item from a non-plan turn", async () => {
    const setup = await createSetup();
    await setup.adapter.describe();
    const events: EventPayload[] = [];
    const requestInteraction = vi.fn<AdapterContext["requestInteraction"]>(async () => ({ kind: "cancelled" }));
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    await setup.adapter.send(prompt("normal work"), context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "normal-plan-item",
      requestInteraction
    }));
    await setup.fake.completePlanTurn(binding.nativeSessionId!, "native plan-like output");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requestInteraction).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: "text_delta",
      delta: "native plan-like output"
    }));
  });

  it("keeps the originating Run context when a native plan completes before turn/start responds", async () => {
    const setup = await createSetup();
    await setup.adapter.describe();
    const events: EventPayload[] = [];
    const requestInteraction = vi.fn<AdapterContext["requestInteraction"]>(async () => ({
      kind: "plan_review",
      decision: "stay",
      feedback: ""
    }));
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const active = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "early-plan-owner",
      requestInteraction
    });
    await setup.adapter.setPlanMode(true, { ...active, operationId: "early-plan-enable" });
    setup.fake.completePlanTurnBeforeStartResponse = "1. Capture the early plan";

    await setup.adapter.send(prompt("plan early"), active);
    await vi.waitFor(() => expect(requestInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "plan_review",
        markdown: "1. Capture the early plan"
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    ));
    expect(events.filter((event) => event.type === "done")).toEqual([
      { type: "done", outcome: "completed" }
    ]);
  });

  it("applies exact sticky Plan collaboration settings and explicitly resets later turns", async () => {
    const setup = await createSetup();
    await setup.adapter.describe();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const bound = (operationId: string) => context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId
    });

    await setup.adapter.setPlanMode(true, bound("plan-setting"));
    expect(setup.fake.transport?.requests.filter((request) => request.method === "thread/settings/update").at(-1)?.params)
      .toMatchObject({
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-test",
            reasoning_effort: "medium",
            developer_instructions: null
          }
        }
      });
    expect(await setup.adapter.inspectSession(binding, bound("inspect-plan"))).toMatchObject({ planMode: true });

    await setup.adapter.send(prompt("plan this"), bound("plan-turn"));
    expect(setup.fake.transport?.requests.filter((request) => request.method === "turn/start").at(-1)?.params)
      .toMatchObject({ collaborationMode: { mode: "plan" } });
    await setup.fake.completeTurn(binding.nativeSessionId!);

    await setup.adapter.setPlanMode(false, bound("default-setting"));
    await setup.adapter.send(prompt("implement this"), bound("default-marker-turn"));
    expect(setup.fake.transport?.requests.filter((request) => request.method === "turn/start").at(-1)?.params)
      .toMatchObject({
        collaborationMode: {
          mode: "default",
          settings: { developer_instructions: null }
        }
      });
    await setup.fake.completeTurn(binding.nativeSessionId!);

    await setup.adapter.send(prompt("continue normally"), bound("default-steady-turn"));
    expect(setup.fake.transport?.requests.filter((request) => request.method === "turn/start").at(-1)?.params)
      .toMatchObject({
        collaborationMode: {
          mode: "default",
          settings: { developer_instructions: "" }
        }
      });
    await setup.fake.completeTurn(binding.nativeSessionId!);
    expect(await setup.adapter.inspectSession(binding, bound("inspect-default"))).toMatchObject({ planMode: false });
  });

  it("projects buffered, nested native child threads without contaminating the parent timeline", async () => {
    const setup = await createSetup(7, { now: () => 1_700_000_000_000 });
    await setup.adapter.describe();
    const events: EventPayload[] = [];
    let childInteractionRequests = 0;
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const active = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "delegated-root-turn",
      requestInteraction: async () => {
        childInteractionRequests += 1;
        return { kind: "cancelled" };
      }
    });
    await setup.adapter.send(prompt("delegate this"), active);
    const rootThreadId = binding.nativeSessionId!;
    const transport = setup.fake.transport!;
    const childThreadId = "native-child-sensitive-id";
    const grandchildThreadId = "native-grandchild-sensitive-id";

    await transport.emitNotification("thread/started", {
      thread: {
        id: childThreadId,
        parentThreadId: rootThreadId,
        agentRole: "reviewer",
        agentNickname: "Scout"
      }
    });
    await transport.emitNotification("turn/started", {
      threadId: childThreadId,
      turn: { id: "child-turn", status: "inProgress", items: [], error: null }
    });
    const spawnItem = {
      type: "collabAgentToolCall",
      id: "spawn-call-sensitive-id",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: rootThreadId,
      receiverThreadIds: [childThreadId],
      agentsStates: { [childThreadId]: { status: "running", message: null } },
      prompt: "Inspect the implementation",
      model: "gpt-test",
      reasoningEffort: "high"
    };
    await transport.emitNotification("item/started", {
      threadId: rootThreadId,
      turnId: "turn-1",
      item: spawnItem,
      startedAtMs: 1_700_000_000_010
    });
    await transport.emitNotification("thread/started", {
      thread: {
        id: grandchildThreadId,
        parentThreadId: childThreadId,
        agentRole: "researcher",
        agentNickname: "Mapper"
      }
    });
    await expect(transport.requestFromServer("item/tool/requestUserInput", {
      threadId: childThreadId,
      turnId: "child-turn",
      itemId: "child-question",
      isBlocking: true,
      questions: [{ id: "choice", header: "Choice", question: "Choose", options: [] }]
    })).resolves.toEqual({ answers: {} });
    expect(childInteractionRequests).toBe(0);

    const nestedSpawn = {
      type: "collabAgentToolCall",
      id: "nested-spawn-sensitive-id",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: childThreadId,
      receiverThreadIds: [grandchildThreadId],
      agentsStates: { [grandchildThreadId]: { status: "running", message: null } },
      prompt: "Inspect one module",
      model: "gpt-test",
      reasoningEffort: "medium"
    };
    await transport.emitNotification("item/completed", {
      threadId: childThreadId,
      turnId: "child-turn",
      item: nestedSpawn,
      completedAtMs: 1_700_000_000_020
    });
    await transport.emitNotification("turn/started", {
      threadId: grandchildThreadId,
      turn: { id: "grandchild-turn", status: "inProgress", items: [], error: null }
    });
    const grandchildMessage = { type: "agentMessage", id: "grandchild-message", text: "Nested result" };
    await transport.emitNotification("item/started", {
      threadId: grandchildThreadId,
      turnId: "grandchild-turn",
      item: grandchildMessage,
      startedAtMs: 1_700_000_000_030
    });
    await transport.emitNotification("item/completed", {
      threadId: grandchildThreadId,
      turnId: "grandchild-turn",
      item: grandchildMessage,
      completedAtMs: 1_700_000_000_040
    });
    await transport.emitNotification("turn/completed", {
      threadId: grandchildThreadId,
      turn: { id: "grandchild-turn", status: "completed", items: [grandchildMessage], error: null }
    });

    const childMessage = { type: "agentMessage", id: "child-message", text: "Top-level delegated result" };
    await transport.emitNotification("item/started", {
      threadId: childThreadId,
      turnId: "child-turn",
      item: childMessage,
      startedAtMs: 1_700_000_000_050
    });
    await transport.emitNotification("item/agentMessage/delta", {
      threadId: childThreadId,
      turnId: "child-turn",
      itemId: "child-message",
      delta: "Top-level delegated result"
    });
    await transport.emitNotification("item/completed", {
      threadId: childThreadId,
      turnId: "child-turn",
      item: childMessage,
      completedAtMs: 1_700_000_000_060
    });
    await transport.emitNotification("thread/tokenUsage/updated", {
      threadId: childThreadId,
      turnId: "child-turn",
      tokenUsage: {
        total: { totalTokens: 15, inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
        last: { totalTokens: 15, inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
        modelContextWindow: 128_000
      }
    });
    await transport.emitNotification("turn/completed", {
      threadId: childThreadId,
      turn: { id: "child-turn", status: "completed", items: [childMessage, nestedSpawn], error: null }
    });

    const taskEvents = events.filter((event) =>
      event.type === "background_task" || event.type === "subagent_run" || event.type === "subagent_transcript"
    );
    const latestRuns = new Map(events.flatMap((event) => event.type === "subagent_run" ? [[event.run.id, event.run] as const] : []));
    expect(latestRuns.size).toBe(2);
    const rootRun = [...latestRuns.values()].find((run) => run.parentSubagentRunId === undefined)!;
    const nestedRun = [...latestRuns.values()].find((run) => run.parentSubagentRunId !== undefined)!;
    expect(rootRun).toMatchObject({
      state: "completed",
      returnedResult: "Top-level delegated result",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      capabilities: {
        viewActivity: true,
        viewReturnedResult: true,
        viewFullTranscript: true,
        stop: false
      },
      children: [expect.objectContaining({ role: "reviewer", title: "Scout" })]
    });
    expect(nestedRun).toMatchObject({
      parentSubagentRunId: rootRun.id,
      parentTaskId: rootRun.id,
      state: "completed",
      returnedResult: "Nested result",
      children: [expect.objectContaining({ role: "researcher", title: "Mapper" })]
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "text_delta", delta: "Nested result" }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "text_delta", delta: "Top-level delegated result" }));
    const serialized = JSON.stringify(taskEvents);
    expect(serialized).not.toContain(childThreadId);
    expect(serialized).not.toContain(grandchildThreadId);
    expect(serialized).not.toContain("spawn-call-sensitive-id");
    expect(serialized).not.toContain("nested-spawn-sensitive-id");

    const rootThread = setup.fake.threads.get(rootThreadId)!;
    const rootItems = rootThread.turns[0]!["items"] as JsonObject[];
    rootItems.push({ ...spawnItem, status: "completed" });
    await setup.fake.completeTurn(rootThreadId);
    const retainedEntryId = (rootThread.turns[0]!["items"] as JsonObject[]).at(-1)!["id"] as string;
    await setup.adapter.send(prompt("A later root turn"), { ...active, operationId: "later-root-turn" });
    await setup.fake.completeTurn(rootThreadId);
    await setup.adapter.navigateTree({ kind: "native_entry", entryId: retainedEntryId }, false, active, undefined, navigationAuthority);
    const afterRewind = events.length;
    await transport.emitNotification("turn/started", {
      threadId: grandchildThreadId,
      turn: { id: "grandchild-resumed", status: "inProgress", items: [], error: null }
    });
    expect(events.slice(afterRewind)).toContainEqual(expect.objectContaining({
      type: "subagent_run", run: expect.objectContaining({ id: nestedRun.id, state: "running" })
    }));
    await expect(setup.adapter.navigateTree({ kind: "native_entry", entryId: retainedEntryId }, false, active, undefined, navigationAuthority)).rejects.toMatchObject({
      publicError: { code: "CODEX_REWIND_BUSY", stateMayHaveChanged: false }
    });
  });

  it.each([
    "codex/0.151.0-alpha.7.2",
    "codex/0.153.3",
    "codex/0.153.4-alpha.1",
    "codex/0.153.4+unverified",
    "codex/0.153.5",
    "codex/0.154.0",
    "unknown"
  ])("fails audited capabilities closed for runtime %s", async (userAgent) => {
    const old = await createSetup();
    old.fake.userAgent = userAgent;
    const oldDescriptor = await old.adapter.describe();
    expect(oldDescriptor.capabilities.get("review.isolated")).toMatchObject({
      supported: false,
      reason: "upstream_missing"
    });
    expect(oldDescriptor.capabilities.get("plan_mode")).toMatchObject({ supported: false, reason: "upstream_missing" });
    expect(oldDescriptor.capabilities.get("background.tasks")).toMatchObject({ supported: false, reason: "upstream_missing" });
    expect(oldDescriptor.capabilities.get("subagents.list")).toMatchObject({ supported: false, reason: "upstream_missing" });
    expect(oldDescriptor.capabilities.get("subagents.smart_routing")).toMatchObject({ supported: false, reason: "upstream_missing" });
    await expect(old.adapter.createSession({
      ...sessionInput(old.target),
      runtimePolicy: "review_read_only"
    }, {
      ...context(old.target, [], { backendInstanceGeneration: 7 }),
      runtimePolicy: "review_read_only"
    })).rejects.toMatchObject({ publicError: { code: "CODEX_REVIEW_RUNTIME_UNSUPPORTED" } });
    expect(old.fake.transport?.requests.some((request) => request.method === "thread/start")).toBe(false);
  });

  it("fails Review closed for unknown MCP inventory or inherited instructions", async () => {
    const unknown = await createSetup();
    unknown.fake.reviewMcpStatuses.push({
      name: "unclassified_runtime_server",
      authStatus: "unsupported",
      resourceTemplates: [],
      resources: [],
      tools: {}
    });
    await unknown.adapter.describe();
    await expect(unknown.adapter.createSession({
      ...sessionInput(unknown.target),
      runtimePolicy: "review_read_only"
    }, {
      ...context(unknown.target, [], { backendInstanceGeneration: 7 }),
      runtimePolicy: "review_read_only"
    })).rejects.toMatchObject({ publicError: { code: "CODEX_REVIEW_INVENTORY_INVALID" } });
    expect(unknown.fake.transport?.requests.some((request) => request.method === "thread/start")).toBe(false);

    const inherited = await createSetup();
    inherited.fake.threadStartResponseOverrides = { instructionSources: ["AGENTS.md"] };
    await inherited.adapter.describe();
    await expect(inherited.adapter.createSession({
      ...sessionInput(inherited.target),
      runtimePolicy: "review_read_only"
    }, {
      ...context(inherited.target, [], { backendInstanceGeneration: 7 }),
      runtimePolicy: "review_read_only"
    })).rejects.toMatchObject({ publicError: { code: "CODEX_REVIEW_PROFILE_INVALID" } });
  });

  it("exposes current native account/login/model operations without retaining stale observations", async () => {
    const setup = await createSetup(7, { now: () => 1_700_000_000_000 });
    const initial = await setup.adapter.readAccount();
    expect(initial).toMatchObject({
      authenticationState: "authenticated",
      supportsLogin: true,
      supportsLogout: true,
      loginMethods: ["api_key", "oauth_browser", "device_code"]
    });

    await expect(setup.adapter.readAccountUsage("openai")).resolves.toEqual({
      providerId: "openai",
      primaryWindow: { usedPercent: 25, windowMinutes: 300, resetAt: 1_800_000_000_000 },
      secondaryWindow: { usedPercent: 50, windowMinutes: 10_080 },
      planType: "plus",
      credits: { hasCredits: true, unlimited: false, balance: "12.5", observedAt: 1_700_000_000_000 },
      observedAt: 1_700_000_000_000
    });
    const quotaReads = setup.fake.transport?.requests.filter((request) =>
      request.method === "account/rateLimits/read").length;
    await expect(setup.adapter.readAccountUsage("foreign-provider"))
      .rejects.toMatchObject({ publicError: { code: "CODEX_PROVIDER_ID_MISMATCH" } });
    expect(setup.fake.transport?.requests.filter((request) =>
      request.method === "account/rateLimits/read")).toHaveLength(quotaReads ?? 0);

    await setup.adapter.logout();
    const signedOut = await setup.adapter.readAccount(true);
    expect(signedOut).toMatchObject({ authenticationState: "signed_out", supportsLogout: false });
    const modelReadsAfterLogout = setup.fake.transport?.requests.filter((request) => request.method === "model/list").length;
    await expect(setup.adapter.listModels()).resolves.toEqual([]);
    expect(setup.fake.transport?.requests.filter((request) => request.method === "model/list"))
      .toHaveLength(modelReadsAfterLogout ?? 0);
    await expect(setup.adapter.beginLogin({ method: "oauth_browser" })).resolves.toMatchObject({
      method: "oauth_browser",
      loginId: "login-browser"
    });
    expect(setup.fake.transport?.requests.findLast((request) => request.method === "account/login/start")?.params)
      .toEqual({ type: "chatgpt" });
    await setup.adapter.cancelLogin("login-browser");
    await expect(setup.adapter.beginLogin({ method: "device_code" })).resolves.toMatchObject({
      method: "device_code",
      loginId: "login-device",
      userCode: "ABCD"
    });
    expect(setup.fake.transport?.requests.findLast((request) => request.method === "account/login/start")?.params)
      .toEqual({ type: "chatgptDeviceCode" });

    setup.fake.failNextAccountRead = true;
    setup.fake.failNextModelList = true;
    const degraded = await setup.adapter.describe();
    expect(degraded.authenticationState).toBe("error");
    expect(degraded.models).toEqual([]);
    expect(degraded.health).toBe("degraded");
  });

  it("applies advertised reasoning effort and Fast Mode to creation, turns, and live settings", async () => {
    const setup = await createSetup();
    await setup.adapter.describe();
    const events: EventPayload[] = [];
    const createContext = context(setup.target, events, { backendInstanceGeneration: 7 });
    const binding = await setup.adapter.createSession({
      ...sessionInput(setup.target),
      effort: "high",
      fastMode: true
    }, createContext);
    expect(setup.fake.transport?.requests.find((request) => request.method === "thread/start")?.params)
      .toMatchObject({ model: "gpt-test", modelProvider: "openai", serviceTier: "fast" });

    const active = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "model-controls"
    });
    await setup.adapter.send({
      text: "use the selected controls",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, active);
    expect(setup.fake.transport?.requests.findLast((request) => request.method === "turn/start")?.params)
      .toMatchObject({ effort: "high", serviceTier: "fast" });

    await setup.adapter.setEffort("medium", active);
    await setup.adapter.setFastMode(false, active);
    expect(setup.fake.transport?.requests
      .filter((request) => request.method === "thread/settings/update")
      .map((request) => request.params))
      .toEqual([
        { threadId: binding.nativeSessionId, effort: "medium" },
        { threadId: binding.nativeSessionId, serviceTier: null }
      ]);
    await expect(setup.adapter.inspectSession(binding, active)).resolves.toMatchObject({
      effort: "medium",
      fastMode: false
    });
  });

  it("applies the current private developer instructions when a thread resumes", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const initialContext = {
      ...context(setup.target, events, { backendInstanceGeneration: 7 }),
      appendSystemPrompt: "Version one identity."
    };
    const binding = await setup.adapter.createSession({
      ...sessionInput(setup.target),
      appendSystemPrompt: "Version one identity."
    }, initialContext);
    expect(setup.fake.transport?.requests.findLast((request) => request.method === "thread/start")?.params)
      .toMatchObject({ developerInstructions: "Version one identity." });

    await setup.adapter.closeSession(binding, { ...initialContext, binding });
    const nextBinding = { ...binding, generation: 2 };
    await setup.adapter.resumeSession(binding, {
      ...context(setup.target, events, {
        binding: nextBinding,
        backendInstanceGeneration: 7,
        generation: 2
      }),
      appendSystemPrompt: "Version two identity."
    });
    expect(setup.fake.transport?.requests.findLast((request) => request.method === "thread/resume")?.params)
      .toMatchObject({ developerInstructions: "Version two identity." });
  });

  it("attaches to native truth without applying fresh-task defaults", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const originalContext = context(setup.target, events, { backendInstanceGeneration: 7 });
    const original = await setup.adapter.createSession(sessionInput(setup.target), originalContext);
    await setup.adapter.closeSession(original, { ...originalContext, binding: original });
    const settingsBefore = setup.fake.transport?.requests.filter((request) =>
      request.method === "thread/settings/update").length ?? 0;

    const attached = await setup.adapter.createSession({
      ...sessionInput(setup.target),
      providerId: "draft-provider",
      modelId: "draft-model",
      effort: "draft-effort",
      fastMode: true,
      permissionMode: "bypassPermissions",
      appendSystemPrompt: "draft instructions",
      nativeStart: { kind: "attach", nativeReference: original.opaqueRef }
    }, context(setup.target, events, { backendInstanceGeneration: 7, generation: 2 }));

    expect(attached).toMatchObject({
      opaqueRef: original.opaqueRef,
      nativeSessionId: original.nativeSessionId,
      generation: 2
    });
    expect(setup.fake.transport?.requests.findLast((request) => request.method === "thread/resume")?.params)
      .toEqual({
        threadId: original.nativeSessionId,
        cwd: setup.target.workspaceRoot,
        excludeTurns: true
      });
    expect(setup.fake.transport?.requests.filter((request) => request.method === "thread/settings/update"))
      .toHaveLength(settingsBefore);
    await expect(setup.adapter.inspectSession(attached, context(setup.target, events, {
      binding: attached,
      backendInstanceGeneration: 7,
      generation: 2
    }))).resolves.toMatchObject({
      binding: attached,
      fastMode: false,
      permissionMode: "ask"
    });
  });
});

interface CatalogProfileFixture {
  readonly active: string;
  readonly source: string;
  readonly nativeSessionId: string;
  readonly sourceRollout: string;
  readonly rolloutContent: string;
}

async function catalogProfileFixture(
  nativeSessionId: string,
  projectless: boolean
): Promise<CatalogProfileFixture> {
  const root = await mkdtemp(join(tmpdir(), "joko-codex-profile-import-"));
  const active = join(root, "active");
  const source = join(root, "external");
  await Promise.all([mkdir(active, { recursive: true }), mkdir(source, { recursive: true })]);
  createCatalogDatabase(active);
  createCatalogDatabase(source);
  const sourceRollout = join(source, "sessions", "2026", "08", `${nativeSessionId}.jsonl`);
  await mkdir(join(sourceRollout, ".."), { recursive: true });
  const rolloutContent = `${JSON.stringify({
    type: "session_meta",
    payload: { id: nativeSessionId, cwd: source, timestamp: 1 }
  })}\n${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello" } })}\n`;
  await writeFile(sourceRollout, rolloutContent, "utf8");
  insertCatalogThread(source, {
    nativeSessionId,
    rolloutPath: sourceRollout,
    workspace: source,
    title: "Imported native task",
    createdAt: 1_000,
    modifiedAt: 2_000
  });
  if (projectless) {
    await writeFile(join(source, ".codex-global-state.json"), JSON.stringify({
      "projectless-thread-ids": [nativeSessionId]
    }), "utf8");
  }
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return { active, source, nativeSessionId, sourceRollout, rolloutContent };
}

function catalogOnlyAdapter(active: string, source: string): CodexBackendAdapter {
  return new CodexBackendAdapter({
    id: "codex-catalog-test",
    instanceGeneration: 1,
    profileDirectory: active,
    catalogProfileDirectories: [source],
    appServer: {
      transport: {
        command: join(tmpdir(), `joko-codex-catalog-missing-${process.pid}`),
        requestTimeoutMs: 500
      }
    }
  });
}

function createCatalogDatabase(profile: string): void {
  const database = new DatabaseSync(join(profile, "state_5.sqlite"));
  try {
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        sandbox_policy TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER,
        updated_at_ms INTEGER,
        thread_source TEXT
      )
    `);
  } finally {
    database.close();
  }
}

function insertCatalogThread(profile: string, input: {
  readonly nativeSessionId: string;
  readonly rolloutPath: string;
  readonly workspace: string;
  readonly title: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
}): void {
  const database = new DatabaseSync(join(profile, "state_5.sqlite"));
  try {
    database.prepare(`
      INSERT INTO threads (
        id, rollout_path, created_at, updated_at, source, model_provider,
        cwd, title, sandbox_policy, approval_mode, archived,
        created_at_ms, updated_at_ms, thread_source
      ) VALUES (?, ?, ?, ?, 'cli', 'openai', ?, ?, '{"type":"disabled"}', 'on-request', 0, ?, ?, 'user')
    `).run(
      input.nativeSessionId,
      input.rolloutPath,
      Math.floor(input.createdAt / 1_000),
      Math.floor(input.modifiedAt / 1_000),
      input.workspace,
      input.title,
      input.createdAt,
      input.modifiedAt
    );
  } finally {
    database.close();
  }
}

function readCatalogThread(profile: string, nativeSessionId: string): Readonly<Record<string, unknown>> | undefined {
  const database = new DatabaseSync(join(profile, "state_5.sqlite"), { readOnly: true });
  try {
    return database.prepare("SELECT * FROM threads WHERE id = ?").get(nativeSessionId) as
      | Readonly<Record<string, unknown>>
      | undefined;
  } finally {
    database.close();
  }
}

async function createSetup(
  instanceGeneration = 7,
  adapterOptions: Omit<CodexAdapterOptions, "id" | "instanceGeneration" | "host"> = {}
) {
  const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "joko-codex-adapter-")));
  const fake = new FakeCodexAppServer();
  const host = new AppServerHost({ transportFactory: () => fake.createTransport() });
  const adapter = new CodexBackendAdapter({ ...adapterOptions, id: "codex-test", instanceGeneration, host });
  const target: TargetDescriptor = {
    id: "target-codex",
    backendId: "codex-test",
    displayName: "Codex target",
    workspaceRoot,
    managed: false,
    trusted: true
  };
  cleanups.push(async () => {
    await adapter.dispose();
    await host.shutdown();
    await rm(workspaceRoot, { recursive: true, force: true });
  });
  return { adapter, fake, host, target };
}

async function createRemoteSetup(options: {
  readonly openMcpBridge?: CodexRemoteRuntime["openMcpBridge"];
  readonly resolveNativeMemoryEnabled?: CodexAdapterOptions["resolveNativeMemoryEnabled"];
} = {}) {
  const serviceRoot = await realpath(await mkdtemp(join(tmpdir(), "joko-codex-remote-target-")));
  const localFake = new FakeCodexAppServer();
  const remoteFake = new FakeCodexAppServer();
  const localHost = new AppServerHost({ transportFactory: () => localFake.createTransport() });
  const remoteHost = new AppServerHost({ transportFactory: () => remoteFake.createTransport() });
  const profileKey = "a".repeat(64);
  let current = true;
  const resolveRemote = vi.fn(async () => ({
    host: remoteHost,
    workspaceRoot: "/srv/joko-project",
    profileKey,
    executionDomain: "ssh-codex-profile-fixture",
    assertCurrent: () => { if (!current) throw new Error("remote authority changed"); },
    ...(options.openMcpBridge === undefined ? {} : { openMcpBridge: options.openMcpBridge })
  }));
  const adapter = new CodexBackendAdapter({
    id: "codex-test",
    instanceGeneration: 7,
    host: localHost,
    remoteRuntimes: {
      resolve: resolveRemote,
      shutdown: async () => remoteHost.shutdown(),
      forceShutdown: async () => remoteHost.forceShutdown()
    },
    ...(options.resolveNativeMemoryEnabled === undefined
      ? {}
      : { resolveNativeMemoryEnabled: options.resolveNativeMemoryEnabled })
  });
  const target: TargetDescriptor = {
    id: "target-codex",
    backendId: "codex-test",
    displayName: "Remote Codex target",
    workspaceRoot: serviceRoot,
    managed: false,
    trusted: true,
    remoteWorkspace: { hostTargetId: "target-codex", hostId: "remote-host", workspaceRoot: "/srv/joko-project" }
  };
  cleanups.push(async () => {
    await adapter.dispose();
    await localHost.shutdown();
    await remoteHost.shutdown();
    await rm(serviceRoot, { recursive: true, force: true });
  });
  return {
    adapter,
    localFake,
    remoteFake,
    localHost,
    remoteHost,
    resolveRemote,
    target,
    setCurrent: (value: boolean) => { current = value; }
  };
}

async function createRewindSetup(adapterOptions: Omit<CodexAdapterOptions, "id" | "instanceGeneration" | "host"> = {}) {
  const setup = await createSetup(7, adapterOptions);
  const binding = await setup.adapter.createSession(sessionInput(setup.target), context(setup.target, [], { backendInstanceGeneration: 7 }));
  const bound = context(setup.target, [], { binding, backendInstanceGeneration: 7 });
  const thread = setup.fake.threads.get(binding.nativeSessionId!)!;
  thread.turns.push(historyTurn(0), historyTurn(1), historyTurn(2));
  return { ...setup, binding, bound, thread, transport: setup.fake.transport! };
}

function historyTurn(index: number, text = "answer"): JsonObject {
  return { id: `history-turn-${index}`, status: "completed", items: [{ type: "agentMessage", id: `history-item-${index}`, text }], error: null };
}

function sessionInput(target: TargetDescriptor): CreateNativeSessionInput {
  return {
    target,
    modelId: "gpt-test",
    providerId: "openai",
    fastMode: false,
    permissionMode: "ask"
  };
}

function prompt(text: string) {
  return {
    text,
    images: [],
    files: [],
    mentions: [],
    disposition: "prompt" as const
  };
}

function context(
  target: TargetDescriptor,
  events: EventPayload[],
  options: {
    readonly binding?: NativeSessionBinding;
    readonly backendInstanceGeneration?: number;
    readonly generation?: number;
    readonly operationId?: string;
    readonly requestInteraction?: AdapterContext["requestInteraction"];
  } = {}
): AdapterContext {
  return {
    sessionId: "session-codex",
    generation: options.generation ?? 1,
    ...(options.backendInstanceGeneration === undefined ? {} : { backendInstanceGeneration: options.backendInstanceGeneration }),
    target,
    ...(options.binding === undefined ? {} : { binding: options.binding }),
    ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
    signal: new AbortController().signal,
    emit: async (event) => { events.push(event); },
    requestInteraction: options.requestInteraction ?? (async () => ({ kind: "cancelled" })),
    artifactCapacityBytes: 1024 * 1024,
    storeArtifact: async () => ({ id: "artifact", sha256: "0".repeat(64), byteLength: 0, mimeType: "application/octet-stream" })
  };
}

const navigationAuthority = { recordBinding: (): never => { throw new Error("Unexpected native context replacement."); } };
