import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
  type TargetDescriptor
} from "@joko/core";
import { describe, expect, test } from "vitest";
import { ClaudeCodeAdapter, type ClaudeCodeAdapterOptions } from "./adapter.js";
import {
  CLAUDE_AGENT_SDK_VERSION,
  type ClaudeCanUseToolOptions,
  type ClaudeSdkGetSessionMessagesOptions,
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
  test("describes only authoritative Backend lifecycle state and the exact mature SDK", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);

    const descriptor = await adapter.describe();

    expect(descriptor.adapterKind).toBe("claude-agent-sdk-stdio");
    expect(descriptor.instanceGeneration).toBe(INSTANCE_GENERATION);
    expect(descriptor.version).toBe(`sdk-${CLAUDE_AGENT_SDK_VERSION}+cli-2.1.239`);
    expect(descriptor.installationState).toBe("installed");
    expect(descriptor.authenticationState).toBe("signed_out");
    expect(descriptor.models.map((model) => model.modelId)).toEqual(["model-a", "model-b"]);
    expect("installed" in descriptor).toBe(false);
    expect("authenticated" in descriptor).toBe(false);
    expect(descriptor.capabilities.get("turn.stream")?.supported).toBe(true);
    expect(descriptor.capabilities.get("session.discovery")?.supported).toBe(true);
    expect(descriptor.capabilities.get("session.catalog")?.supported).toBe(true);
    expect(descriptor.capabilities.get("provider.refresh")?.supported).toBe(true);
    expect(descriptor.capabilities.get("provider.model_refresh")?.supported).toBe(true);
    expect(descriptor.capabilities.get("background.tasks")?.supported).toBe(true);
    expect(descriptor.capabilities.get("background.tasks.cancel")?.supported).toBe(true);
    expect(descriptor.capabilities.get("subagents.list")?.supported).toBe(true);
    expect(descriptor.capabilities.get("subagents.detail")?.supported).toBe(true);
    expect(descriptor.capabilities.get("subagents.transcript")?.supported).toBe(true);
    expect(descriptor.capabilities.get("subagents.stop")?.supported).toBe(true);
    expect(descriptor.capabilities.get("subagents.steer")?.supported).toBe(false);
    expect(descriptor.providers).toEqual([expect.objectContaining({
      providerId: "claude-code",
      supportsLogin: false,
      supportsLogout: false,
      supportsRefresh: true,
      supportsModelRefresh: true
    })]);
    expect(descriptor.capabilities.get("turn.steer")?.supported).toBe(false);
    expect(descriptor.capabilities.get("workspace.extra_dirs")?.options).toEqual(["read_write"]);
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

  test("runs isolated review only through the immutable native safe profile", async () => {
    const runtime = new FakeSdkRuntime();
    const adapter = adapterFor(runtime);
    const descriptor = await adapter.describe();
    expect(descriptor.capabilities.get("review.isolated")).toEqual({
      key: "review.isolated",
      supported: true
    });

    const creation = contextFor(undefined, { runtimePolicy: "review_read_only" });
    const invalidReviewInputs: CreateNativeSessionInput[] = [createInput({
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
      () => adapter.setModel("claude-code", "model-b", boundReview),
      () => adapter.setEffort("low", boundReview),
      () => adapter.setPermissionMode("auto", boundReview),
      () => adapter.setPlanMode(true, boundReview),
      () => adapter.setExtraDirectories([{ id: "extra", path: process.cwd(), access: "read_write" }], boundReview),
      () => adapter.getNativeHistoryProjection(boundReview),
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
    expect(query.params.options.additionalDirectories).toEqual([process.cwd()]);
    expect(query.params.options.systemPrompt.append).toBe("Use the product workflow.");
    expect(query.params.options.title).toBe("SDK session");
    expect(query.params.options.env["CLAUDE_AGENT_SDK_CLIENT_APP"]).toBe("joko/0.1.0");

    const beforeTurn = await adapter.describe();
    expect(beforeTurn.version).toBe(`sdk-${CLAUDE_AGENT_SDK_VERSION}+cli-2.1.239`);
    expect(beforeTurn.models.map((model) => model.modelId)).toEqual(["model-a", "model-b"]);
    expect(beforeTurn.tools).toEqual([]);

    const active = contextFor(binding, { operationId: "first-identity-proof" });
    await adapter.send(textPrompt("confirm the turn"), active.context);
    expect(query.receivedInputs).toHaveLength(1);
    const afterTurnStart = await adapter.describe();
    expect(afterTurnStart.version).toContain("cli-2.1.239");
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
    await adapter.deleteSession(binding, context);
    expect(runtime.deleted).toEqual([binding.nativeSessionId]);
    expect(runtime.sessions.has(binding.nativeSessionId!)).toBe(false);
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
          return { kind: "question", answers: { q0: "q0o1" } };
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
      questions: [{
        question: "Choose a route",
        header: "Route",
        options: [
          { label: "Safe", description: "Use the safe route." },
          { label: "Fast", description: "Use the fast route." }
        ],
        multiSelect: false
      }]
    }, permissionOptions("question-one", "tool-question"));
    expect(question).toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "Choose a route": "Fast" } }
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
  readonly initialSessionIdOverride?: string;
  readonly initialPermissionMode?: string;
  readonly initialFrameOverrides?: Readonly<Record<string, unknown>>;
  readonly leaveOutputOpenOnClose?: boolean;
  readonly probeDiagnostic?: string;
  readonly probeInstalled?: boolean;
}

class FakeSdkRuntime implements ClaudeSdkRuntime {
  readonly packageVersion = CLAUDE_AGENT_SDK_VERSION;
  readonly queries: FakeQuery[] = [];
  readonly sessions = new Map<string, ClaudeSdkSessionInfo>();
  readonly messages = new Map<string, readonly ClaudeSdkSessionMessage[]>();
  readonly deleted: string[] = [];
  readonly listOptions: ClaudeSdkListSessionsOptions[] = [];
  readonly messageOptions: {
    readonly sessionId: string;
    readonly options: ClaudeSdkGetSessionMessagesOptions;
  }[] = [];
  readonly probeInputs: ClaudeSdkProbeInput[] = [];
  readonly options: FakeRuntimeOptions;
  probeInitialization: ClaudeSdkInitializationResult | undefined = initialization();
  probeCliVersion: string | undefined = "2.1.239";
  probeApiKeySource: string | undefined = "none";

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
    const nativeSessionId = params.options.resume ?? params.options.sessionId;
    if (nativeSessionId === undefined) throw new Error("Fake Query requires a native Session ID.");
    const query = new FakeQuery(params, initialization(), this.options.leaveOutputOpenOnClose ?? false);
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
      return message;
    });
    return Promise.resolve(query);
  }

  getSessionInfo(sessionId: string): Promise<ClaudeSdkSessionInfo | undefined> {
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
  interruptHandler: () => Promise<{ readonly still_queued?: readonly string[] } | undefined> = async () => ({
    still_queued: []
  });
  interruptCalls = 0;
  closeCalls = 0;

  constructor(
    params: ClaudeSdkQueryParams,
    initializationResult: ClaudeSdkInitializationResult,
    leaveOutputOpenOnClose: boolean
  ) {
    this.params = params;
    this.#initialization = initializationResult;
    this.#leaveOutputOpenOnClose = leaveOutputOpenOnClose;
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.#output[Symbol.asyncIterator]();
  }

  async consumeInput(onMessage: (message: ClaudeSdkUserMessage) => ClaudeSdkUserMessage): Promise<void> {
    for await (const message of this.params.prompt) this.receivedInputs.push(onMessage(message));
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
    return Promise.resolve();
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

function initialization(): ClaudeSdkInitializationResult {
  return {
    models: [
      {
        value: "model-a",
        resolvedModel: "model-a-20260801",
        displayName: "Model A",
        description: "Primary model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "max"]
      },
      {
        value: "model-b",
        displayName: "Model B",
        description: "Secondary model",
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
    claude_code_version: "2.1.239",
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
