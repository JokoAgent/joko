import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { access, mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { AdapterContext, BlobRef, EventPayload, NativeSessionBinding, PolicySnapshot, TargetDescriptor } from "@joko/core";
import { describe, expect, it, vi } from "vitest";
import { appendVisionBridgeDescriptions, createPiAdapter, escapePiComposerSlashCommand, isRuntimeResourceProvenLoaded, mergeManagedResourceSnapshots, projectPiTreeNodes, resolvePiComposerSlashCommand } from "./adapter.js";
import { managedSubagentSessionKey } from "./durable-subagent-runs.js";
import type { PiManagedDurableStore } from "./managed-durable-store.js";
import {
  PI_RUNTIME_TOOL_CATALOG_CHUNK_BYTES,
  PI_RUNTIME_TOOL_CATALOG_STATUS_KEY
} from "./runtime-tool-catalog.js";
import type { PiProcessHandle, PiProcessSpec } from "./transport.js";
import { encodePolicyDecisionRequest } from "./policy-decision-bridge.js";
import { mkdtemp } from "./test-paths.js";

interface ScriptedPiProcessOptions {
  readonly commands?: readonly Record<string, unknown>[];
  readonly synchronousExtensionCommand?: string;
  readonly holdAgentLifecycle?: boolean;
  readonly modelInputs?: Readonly<Record<string, readonly string[]>>;
  readonly modelContextWindows?: Readonly<Record<string, number>>;
  readonly contextUsage?: { readonly tokens: number; readonly contextWindow: number };
  readonly contextTokens?: number;
  readonly compactEmitsEvents?: boolean;
  readonly toolImage?: { readonly data: string; readonly mimeType: string };
  readonly bash?: {
    readonly deltas?: readonly string[];
    readonly output: string;
    readonly exitCode?: number;
    readonly cancelled?: boolean;
    readonly truncated?: boolean;
    readonly fullOutput?: string;
    readonly responseDelayMs?: number;
  };
  readonly historyEntries?: readonly Record<string, unknown>[];
  readonly historyLeafId?: string;
  readonly historyResponseData?: unknown;
  readonly messages?: readonly Record<string, unknown>[];
  readonly tree?: readonly Record<string, unknown>[];
  readonly forkMessages?: readonly Record<string, unknown>[];
  readonly forkText?: string;
  readonly availableModels?: readonly Record<string, unknown>[];
  readonly availableThinkingLevels?: readonly unknown[];
  readonly runtimeToolCatalog?: unknown;
  readonly runtimeToolCatalogStatuses?: readonly unknown[];
  readonly responseDelayMsByCommand?: Readonly<Record<string, number>>;
  readonly omitResponsesFor?: readonly string[];
  readonly failResponsesFor?: readonly string[];
  readonly clearQueueResponseData?: unknown;
  readonly echoQueuedUserMessages?: boolean;
  readonly queuedUserMessageTransform?: (command: Record<string, unknown>) => string;
}

function chunkedRuntimeToolCatalog(
  document: Readonly<Record<string, unknown>>,
  chunkBytes = PI_RUNTIME_TOOL_CATALOG_CHUNK_BYTES
): readonly Record<string, unknown>[] {
  const bytes = Buffer.from(JSON.stringify(document), "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const count = Math.ceil(bytes.byteLength / chunkBytes);
  return Array.from({ length: count }, (_, index) => ({
    format: 1,
    catalogId: sha256,
    index,
    count,
    byteLength: bytes.byteLength,
    sha256,
    payload: bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString("base64url")
  }));
}

class ScriptedPiProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly pid = 100;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly spec: PiProcessSpec;
  sessionFile: string;
  sessionId: string;
  sessionName: string | undefined;
  isStreaming = false;
  isCompacting = false;
  omitModelFromState = false;
  contextRebuildHandoff: string | undefined;
  model = {
    provider: "local",
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
  readonly commands: Record<string, unknown>[] = [];
  #pending = Buffer.alloc(0);
  #pendingBash: { readonly command: Record<string, unknown>; readonly timer: NodeJS.Timeout } | undefined;
  #runtimeToolCatalogSent = false;
  #contextTokens: number | undefined;

  constructor(spec: PiProcessSpec, private readonly options: ScriptedPiProcessOptions = {}) {
    super();
    this.spec = spec;
    const sessionDirectory = argument(spec.args, "--session-dir");
    const resume = optionalArgument(spec.args, "--session");
    this.sessionId = optionalArgument(spec.args, "--session-id") ?? "resumed";
    this.sessionFile = resume ?? join(sessionDirectory, `${this.sessionId}.jsonl`);
    this.#contextTokens = options.contextUsage?.tokens ?? options.contextTokens;
    mkdirSync(sessionDirectory, { recursive: true });
    if (!resume) this.#writeSession();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.#pending = Buffer.concat([this.#pending, chunk]);
        let index: number;
        while ((index = this.#pending.indexOf(0x0a)) >= 0) {
          const command = JSON.parse(this.#pending.subarray(0, index).toString("utf8")) as Record<string, unknown>;
          this.#pending = this.#pending.subarray(index + 1);
          this.#handle(command);
        }
        callback();
      }
    });
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.#pendingBash !== undefined) {
      clearTimeout(this.#pendingBash.timer);
      this.#pendingBash = undefined;
    }
    this.signalCode = typeof signal === "string" ? signal : null;
    this.exitCode = 0;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("exit", 0, this.signalCode));
    return true;
  }

  settle(): void {
    if (!this.isStreaming) return;
    this.isStreaming = false;
    this.#send({ type: "agent_settled" });
  }

  emitAssistant(text: string): void {
    this.#send({ type: "message_start", message: { role: "assistant", content: [] } });
    this.#send({
      type: "message_update",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text }
    });
    this.#send({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }
      }
    });
  }

  emitExtensionInput(id: string, title: string): void {
    this.#send({ type: "extension_ui_request", id, method: "input", title, placeholder: "" });
  }

  #send(value: unknown): void {
    this.stdout.write(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
  }

  #success(command: Record<string, unknown>, data?: unknown): void {
    if (this.options.omitResponsesFor?.includes(String(command.type)) === true) return;
    const response = this.options.failResponsesFor?.includes(String(command.type)) === true
      ? { type: "response", id: command.id, command: command.type, success: false, error: `${String(command.type)} rejected` }
      : { type: "response", id: command.id, command: command.type, success: true, ...(data === undefined ? {} : { data }) };
    const delayMs = this.options.responseDelayMsByCommand?.[String(command.type)] ?? 0;
    if (delayMs > 0) {
      setTimeout(() => this.#send(response), delayMs);
      return;
    }
    this.#send(response);
  }

  #completeBash(command: Record<string, unknown>, override?: ScriptedPiProcessOptions["bash"]): void {
    const result = override ?? this.options.bash ?? { output: "ok", exitCode: 0, cancelled: false, truncated: false };
    if (result.fullOutput !== undefined) {
      const fullOutputPath = join(String(this.spec.env.TEMP), "pi-bash-full-output.log");
      writeFileSync(fullOutputPath, result.fullOutput);
      this.#success(command, {
        output: result.output,
        exitCode: result.exitCode,
        cancelled: result.cancelled ?? false,
        truncated: result.truncated ?? true,
        fullOutputPath
      });
      return;
    }
    this.#success(command, {
      output: result.output,
      exitCode: result.exitCode,
      cancelled: result.cancelled ?? false,
      truncated: result.truncated ?? false
    });
  }

  #handle(command: Record<string, unknown>): void {
    this.commands.push(command);
    switch (command.type) {
      case "get_state":
        if (
          !this.#runtimeToolCatalogSent &&
          (this.options.runtimeToolCatalog !== undefined || this.options.runtimeToolCatalogStatuses !== undefined)
        ) {
          this.#runtimeToolCatalogSent = true;
          const statuses = this.options.runtimeToolCatalogStatuses ?? [this.options.runtimeToolCatalog];
          for (const [index, status] of statuses.entries()) {
            this.#send({
              type: "extension_ui_request",
              id: `runtime-tool-catalog-${index}`,
              method: "setStatus",
              statusKey: PI_RUNTIME_TOOL_CATALOG_STATUS_KEY,
              statusText: JSON.stringify(status)
            });
          }
        }
        this.#success(command, {
          model: this.omitModelFromState ? undefined : this.model,
          thinkingLevel: "medium",
          isStreaming: this.isStreaming,
          isCompacting: this.isCompacting,
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
          sessionFile: this.sessionFile,
          sessionId: this.sessionId,
          sessionName: this.sessionName,
          autoCompactionEnabled: true,
          messageCount: 2,
          pendingMessageCount: 0
        });
        return;
      case "get_session_stats":
        const contextUsage = {
          tokens: this.#contextTokens ?? 18,
          contextWindow: this.options.contextUsage?.contextWindow ?? this.model.contextWindow
        };
        this.#success(command, {
          tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 },
          cost: 0,
          contextUsage: {
            ...contextUsage,
            percent: contextUsage.contextWindow === 0 ? 0 : contextUsage.tokens / contextUsage.contextWindow * 100
          }
        });
        return;
      case "clear_queue":
        this.#success(command, this.options.clearQueueResponseData ?? { steering: [], followUp: [] });
        return;
      case "prompt":
        if (
          this.options.synchronousExtensionCommand !== undefined &&
          String(command.message).trimStart().match(/^\/([^\s]+)/u)?.[1] === this.options.synchronousExtensionCommand
        ) {
          if (this.options.synchronousExtensionCommand === "joko-rebuild-context") {
            const encoded = String(command.message).slice("/joko-rebuild-context ".length);
            const descriptor = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
              fileName: string;
              byteLength: number;
              sha256: string;
            };
            const handoffBytes = readFileSync(join(String(this.spec.env.TEMP), descriptor.fileName));
            if (
              handoffBytes.byteLength !== descriptor.byteLength ||
              createHash("sha256").update(handoffBytes).digest("hex") !== descriptor.sha256
            ) {
              throw new Error("Invalid scripted context rebuild Artifact");
            }
            this.contextRebuildHandoff = handoffBytes.toString("utf8");
            this.sessionId = "context-rebuild-native";
            this.sessionFile = join(argument(this.spec.args, "--session-dir"), `${this.sessionId}.jsonl`);
            this.#writeSession();
          } else if (this.options.synchronousExtensionCommand === "joko-reset-context") {
            this.sessionId = "context-reset-native";
            this.sessionFile = join(argument(this.spec.args, "--session-dir"), `${this.sessionId}.jsonl`);
            this.#writeSession();
          }
          this.#success(command);
          return;
        }
      case "steer":
      case "follow_up":
        this.#success(command);
        if (this.options.echoQueuedUserMessages) {
          const text = this.options.queuedUserMessageTransform?.(command) ?? String(command.message ?? "");
          const message = { role: "user", content: [{ type: "text", text }] };
          this.#send({ type: "message_start", message });
          this.#send({ type: "message_end", message });
        }
        if (this.options.holdAgentLifecycle) {
          if (command.type === "prompt") {
            this.isStreaming = true;
            this.#send({ type: "agent_start" });
          }
          return;
        }
        this.#send({ type: "agent_start" });
        if (this.options.toolImage !== undefined) {
          this.#send({ type: "tool_execution_start", toolCallId: "read-image", toolName: "read", args: { path: "preview.png" } });
          this.#send({
            type: "tool_execution_end",
            toolCallId: "read-image",
            toolName: "read",
            isError: false,
            result: {
              content: [
                { type: "text", text: "Image Size: 16x16." },
                { type: "image", data: this.options.toolImage.data, mimeType: this.options.toolImage.mimeType }
              ],
              details: {}
            }
          });
        }
        this.#send({ type: "message_start", message: { role: "assistant", content: [] } });
        this.#send({
          type: "message_update",
          usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { total: 0 } },
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done" }
        });
        this.#send({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { total: 0 } }
          }
        });
        this.#send({ type: "agent_end", messages: [], willRetry: false });
        this.#send({ type: "agent_settled" });
        return;
      case "set_model":
        this.model = {
          ...this.model,
          provider: String(command.provider),
          id: String(command.modelId),
          input: [...(this.options.modelInputs?.[String(command.modelId)] ?? this.model.input)],
          contextWindow: this.options.modelContextWindows?.[String(command.modelId)] ?? this.model.contextWindow
        };
        this.#success(command, this.model);
        return;
      case "get_available_models":
        this.#success(command, { models: this.options.availableModels ?? [this.model] });
        return;
      case "get_available_thinking_levels":
        this.#success(command, { levels: this.options.availableThinkingLevels ?? ["off", "low", "medium", "high"] });
        return;
      case "cycle_thinking_level":
        this.#success(command, { level: "high" });
        return;
      case "cycle_model":
        this.#success(command, { model: this.model, thinkingLevel: "medium", isScoped: false });
        return;
      case "get_tree":
        this.#success(command, {
          tree: this.options.tree ?? [
            {
              entry: {
                type: "message",
                id: "entry-1",
                parentId: null,
                timestamp: new Date(0).toISOString(),
                message: { role: "user", content: [{ type: "text", text: "native tree" }] }
              },
              label: "checkpoint",
              labelTimestamp: new Date(4).toISOString(),
              children: [
                {
                  entry: {
                    type: "message",
                    id: "entry-2",
                    parentId: "entry-1",
                    timestamp: new Date(1).toISOString(),
                    message: { role: "assistant", content: [{ type: "text", text: "assistant preview" }] }
                  },
                  children: [
                    {
                      entry: {
                        type: "message",
                        id: "entry-3",
                        parentId: "entry-2",
                        timestamp: new Date(2).toISOString(),
                        message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "tool preview" }] }
                      },
                      children: [
                        {
                          entry: {
                            type: "custom_message",
                            id: "entry-4",
                            parentId: "entry-3",
                            timestamp: new Date(3).toISOString(),
                            customType: "notice",
                            content: `custom preview sk-abcdefghijklmnop ${"x".repeat(300)}`
                          },
                          children: []
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ],
          leafId: "entry-1"
        });
        return;
      case "get_entries":
        if (Object.hasOwn(this.options, "historyResponseData")) {
          this.#success(command, this.options.historyResponseData);
          return;
        }
        this.#success(command, {
          entries: this.options.historyEntries ?? [{
            type: "message",
            id: "entry-1",
            parentId: null,
            timestamp: new Date(0).toISOString(),
            message: { role: "user", content: [{ type: "text", text: "native history" }], timestamp: 0 }
          }],
          leafId: this.options.historyLeafId ?? "entry-1"
        });
        return;
      case "get_commands":
        this.#success(command, {
          commands: [
            // Pi suffixes duplicate invocations. The bridge identity must
            // still fence the semantic base name while retaining the user's
            // same-name prompt descriptor below.
            { name: "plan:1", description: "Toggle plan mode", source: "extension", sourceInfo: { path: managedBridgePath(this.spec), scope: "temporary" } },
            { name: "joko-navigate-tree", description: "Navigate internally", source: "extension", sourceInfo: { path: managedBridgePath(this.spec), scope: "temporary" } },
            { name: "joko-rebuild-context", description: "Rebuild internally", source: "extension", sourceInfo: { path: managedBridgePath(this.spec), scope: "temporary" } },
            { name: "joko-reset-context", description: "Reset internally", source: "extension", sourceInfo: { path: managedBridgePath(this.spec), scope: "temporary" } },
            ...(optionalManagedSubagentPath(this.spec) === undefined ? [] : [
              { name: "joko-stop-background-task", description: "Stop background work internally", source: "extension", sourceInfo: { path: managedSubagentPath(this.spec), scope: "temporary" } }
            ]),
            ...(this.options.commands ?? [
              { name: "plan", description: "User-authored planning prompt", source: "prompt", sourceInfo: { path: join(this.spec.cwd, "plan.md"), scope: "project" } },
              { name: "review", description: "Review changes", source: "prompt", sourceInfo: { path: "managed" } }
            ])
          ]
        });
        return;
      case "get_messages":
        this.#success(command, { messages: this.options.messages ?? [] });
        return;
      case "get_fork_messages":
        this.#success(command, { messages: this.options.forkMessages ?? [{ entryId: "entry-1", text: "hello" }] });
        return;
      case "get_last_assistant_text":
        this.#success(command, { text: "done" });
        return;
      case "set_session_name":
        this.sessionName = String(command.name);
        this.#append({ type: "session_info", id: "name", parentId: null, timestamp: new Date().toISOString(), name: this.sessionName });
        this.#success(command);
        return;
      case "compact":
        if (this.options.compactEmitsEvents) this.#send({ type: "compaction_start", reason: "manual" });
        if (this.options.compactEmitsEvents) {
          this.#send({
            type: "compaction_end",
            reason: "manual",
            result: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 80, estimatedTokensAfter: 20 },
            aborted: false,
            willRetry: false
          });
        }
        this.#contextTokens = 20;
        this.#success(command, { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 80, estimatedTokensAfter: 20 });
        return;
      case "export_html": {
        const path = join(this.spec.cwd, "export.html");
        writeFileSync(path, "<html></html>");
        this.#success(command, { path: "export.html" });
        return;
      }
      case "bash": {
        for (const delta of this.options.bash?.deltas ?? ["ok"]) {
          this.#send({ type: "bash_execution_update", id: "native-bash", delta });
        }
        const responseDelayMs = this.options.bash?.responseDelayMs ?? 0;
        if (responseDelayMs > 0) {
          const timer = setTimeout(() => {
            if (this.#pendingBash?.command !== command) return;
            this.#pendingBash = undefined;
            this.#completeBash(command);
          }, responseDelayMs);
          this.#pendingBash = { command, timer };
          return;
        }
        this.#completeBash(command);
        return;
      }
      case "abort_bash": {
        const pending = this.#pendingBash;
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          this.#pendingBash = undefined;
          this.#completeBash(pending.command, { output: "", cancelled: true, truncated: false });
        }
        this.#success(command);
        return;
      }
      case "extension_ui_response":
        // Pi extension UI responses are one-way notifications, not RPCs with
        // a second response envelope.
        return;
      case "fork":
      case "clone":
      case "new_session": {
        this.sessionId = `${String(command.type)}-native`;
        this.sessionFile = join(argument(this.spec.args, "--session-dir"), `${this.sessionId}.jsonl`);
        this.#writeSession();
        this.#success(command, command.type === "fork" ? { text: this.options.forkText ?? "", cancelled: false } : { cancelled: false });
        return;
      }
      case "switch_session":
        this.sessionFile = String(command.sessionPath);
        this.sessionId = "switched";
        this.#success(command, { cancelled: false });
        return;
      default:
        this.#success(command);
    }
  }

  #writeSession(): void {
    writeFileSync(
      this.sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: this.sessionId, timestamp: new Date().toISOString(), cwd: this.spec.cwd })}\n`
    );
  }

  #append(value: unknown): void {
    writeFileSync(this.sessionFile, `${JSON.stringify(value)}\n`, { flag: "a" });
  }
}

describe("PiBackendAdapter", () => {
  it("samples the Target-scoped MCP bridge exactly once per runtime spawn", { timeout: 20_000 }, async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-target-bridge-home-"));
    const firstWorkspace = await mkdtemp(join(tmpdir(), "joko-pi-target-bridge-first-"));
    const secondWorkspace = await mkdtemp(join(tmpdir(), "joko-pi-target-bridge-second-"));
    const specs: PiProcessSpec[] = [];
    const reservationToken = "r".repeat(43);
    const resolveMcpBridge = vi.fn((context: AdapterContext) => ({
      endpoint: "http://127.0.0.1:4318/internal/mcp",
      token: `bridge-${context.target.id}-${context.generation}`,
      nativeAuthReservationToken: reservationToken,
      nativeAuthLease: {
        endpoint: "http://127.0.0.1:4318/internal/pi-native-auth",
        catalogGeneration: 7,
        providerIds: ["local"],
        authenticatedProviderIds: ["local"]
      },
      tools: [{
        serverId: "browser",
        name: "list_tools",
        description: `Browser catalog for ${context.target.id}`,
        inputSchema: { type: "object", additionalProperties: false },
        requiresPermission: true
      }]
    }));
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.1.0",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32768, maxTokens: 4096 }]
      }],
      resolveMcpBridge,
      processFactory: (spec) => {
        specs.push(spec);
        return new ScriptedPiProcess(spec) as unknown as PiProcessHandle;
      }
    });
    const targets: readonly TargetDescriptor[] = [
      { id: "target-first", backendId: "pi", displayName: "First", workspaceRoot: firstWorkspace, managed: false, trusted: false },
      { id: "target-second", backendId: "pi", displayName: "Second", workspaceRoot: secondWorkspace, managed: false, trusted: false }
    ];

    try {
      for (const [index, target] of targets.entries()) {
        const context = { ...makeContext(target, []), sessionId: `session-${index + 1}`, generation: index + 3 };
        await adapter.createSession({
          target,
          providerId: "local",
          modelId: "test-model",
          fastMode: false,
          permissionMode: "ask"
        }, context);
      }

      expect(resolveMcpBridge).toHaveBeenCalledTimes(2);
      expect(resolveMcpBridge.mock.calls.map(([context]) => [context.target.id, context.generation])).toEqual([
        ["target-first", 3],
        ["target-second", 4]
      ]);
      for (const [index, target] of targets.entries()) {
        const spec = specs[index]!;
        const token = `bridge-${target.id}-${index + 3}`;
        expect(spec.env.JOKO_PI_MCP_TOKEN).toBe(token);
        expect(spec.env.JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN).toBe(reservationToken);
        expect(JSON.parse(spec.env.JOKO_PI_SECRET_ENV_NAMES!)).toContain("JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN");
        expect(JSON.parse(spec.env.JOKO_PI_SUBAGENT_CREDENTIAL_ENV_NAMES!))
          .not.toContain("JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN");
        const descriptorText = await readFile(spec.env.JOKO_PI_MCP_DESCRIPTOR_FILE!, "utf8");
        expect(descriptorText).not.toContain(token);
        expect(descriptorText).not.toContain(reservationToken);
        expect(JSON.parse(descriptorText)).toMatchObject({
          endpoint: "http://127.0.0.1:4318/internal/mcp",
          generation: index + 3,
          sessionId: `session-${index + 1}`,
          targetId: target.id,
          tools: [{ serverId: "browser", name: "list_tools", requiresPermission: true }]
        });
      }
    } finally {
      await adapter.dispose();
    }
  });

  it("omits collaboration tools and their process environment when the Session policy is disabled", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-collaboration-policy-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-collaboration-policy-workspace-"));
    const specs: PiProcessSpec[] = [];
    const includeManagedSubagentTools = vi.fn(() => false);
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.1.0",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32768, maxTokens: 4096 }]
      }],
      includeManagedSubagentTools,
      processFactory: (spec) => {
        specs.push(spec);
        return new ScriptedPiProcess(spec) as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-policy",
      backendId: "pi",
      displayName: "Policy",
      workspaceRoot: workspace,
      managed: false,
      trusted: false
    };

    try {
      await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, makeContext(target, []));
      expect(includeManagedSubagentTools).toHaveBeenCalledTimes(1);
      expect(valuesForArgument(specs[0]!.args, "--extension").map((path) => path.split(/[\\/]/u).at(-1))).toEqual([
        "joko-managed-silent-encrypted-retry.ts",
        "joko-managed-bridge.ts"
      ]);
      expect(specs[0]!.env).not.toHaveProperty("JOKO_PI_SUBAGENT_CREDENTIAL_ENV_NAMES");
      expect(specs[0]!.env).not.toHaveProperty("JOKO_PI_WORKER_SOFT_LIMIT");
      expect(specs[0]!.env).not.toHaveProperty("JOKO_PI_WORKER_HARD_LIMIT");
      expect(specs[0]!.env).not.toHaveProperty("JOKO_PI_WORKER_IDLE_RELEASE_MINUTES");
    } finally {
      await adapter.dispose();
    }
  });

  it("replays a local native deletion with the same durable operation identity", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-local-delete-replay-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-local-delete-replay-workspace-"));
    const target: TargetDescriptor = {
      id: "local-delete-replay-target",
      backendId: "pi",
      displayName: "Local delete replay",
      workspaceRoot: workspace,
      managed: true,
      trusted: false
    };
    const options = {
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.1.0",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions" as const,
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32768, maxTokens: 4096 }]
      }],
      processFactory: (spec: PiProcessSpec) => new ScriptedPiProcess(spec) as unknown as PiProcessHandle
    };
    const creation = createPiAdapter(options);
    const context = {
      ...makeContext(target, []),
      operationId: "session-delete-operation-1"
    };
    const binding = await creation.createSession({
      target,
      providerId: "local",
      modelId: "test-model",
      fastMode: false,
      permissionMode: "ask"
    }, context);
    await creation.closeSession(binding, { ...context, binding });
    await creation.dispose();

    const firstAttempt = createPiAdapter(options);
    await firstAttempt.deleteSession(binding, { ...context, binding });
    await firstAttempt.dispose();
    await expect(access(binding.opaqueRef)).rejects.toMatchObject({ code: "ENOENT" });

    const replay = createPiAdapter(options);
    try {
      await expect(replay.deleteSession(binding, { ...context, binding })).resolves.toBeUndefined();
      await expect(access(binding.opaqueRef)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(join(agentHome, "trash", "sessions"))).toHaveLength(1);
    } finally {
      await replay.dispose();
    }
  });

  it("finishes a retained remote delegated-run deletion journal before detached startup observation", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-remote-lineage-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-remote-lineage-workspace-"));
    const revision = createHash("sha256").update("empty remote lineage").digest("hex");
    const deletionReceipt = createHash("sha256").update("remote lineage deleted").digest("hex");
    const stopAndRemoveSession = vi.fn(async () => ({ terminalRunIds: [], removed: true as const, deletionReceipt }));
    const finalizeDeletion = vi.fn(async () => undefined);
    const scan = vi.fn(async () => ({ revision, unchanged: false, retryAfterMs: 500, runs: [] }));
    const disposeStore = vi.fn(async () => undefined);
    const store: PiManagedDurableStore = {
      scan,
      readTail: vi.fn(async () => { throw new Error("No remote run exists in this fixture."); }),
      writeControl: vi.fn(async () => { throw new Error("No remote run exists in this fixture."); }),
      stopAndRemoveSession,
      finalizeDeletion,
      dispose: disposeStore
    };
    const storeFor = vi.fn(async (_input: {
      readonly sessionId: string;
      readonly targetId: string;
      readonly bindingOpaqueRef: string;
      readonly generation: number;
    }) => store);
    let cleanupAllowed = true;
    const onManagedSubagentLineageRemoved = vi.fn(async () => {
      if (!cleanupAllowed) throw new Error("simulated service interruption after receipt persistence");
    });
    const processFactory = vi.fn((spec: PiProcessSpec) => (
      new ScriptedPiProcess(spec) as unknown as PiProcessHandle
    ));
    const options = {
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.1.0",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions" as const,
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32768, maxTokens: 4096 }]
      }],
      validateRemoteWorkspace: async () => undefined,
      managedDurableStoreRegistry: { storeFor },
      onManagedSubagentLineageRemoved,
      processFactory
    };
    const target: TargetDescriptor = {
      id: "remote-lineage-target",
      backendId: "pi",
      displayName: "Remote lineage",
      workspaceRoot: workspace,
      managed: true,
      trusted: false,
      remoteWorkspace: { hostId: "fixture-host", workspaceRoot: "/workspace" }
    };
    const context = makeContext(target, []);
    const initial = createPiAdapter(options);
    const binding = await initial.createSession({
      target,
      providerId: "local",
      modelId: "test-model",
      fastMode: false,
      permissionMode: "ask"
    }, context);
    await initial.closeSession(binding, { ...context, binding });
    await initial.dispose();

    const deletionContext = {
      ...context,
      generation: binding.generation + 1,
      binding
    };
    const observationDirectory = join(
      agentHome,
      "subagent-observations",
      managedSubagentSessionKey(context.sessionId)
    );
    const observationMarker = join(observationDirectory, "retained.json");
    await mkdir(observationDirectory, { recursive: true });
    await writeFile(observationMarker, "{}", "utf8");

    const interrupted = createPiAdapter(options);
    try {
      cleanupAllowed = false;
      await expect(interrupted.deleteSession(binding, deletionContext)).rejects.toMatchObject({
        publicError: { code: "PI_SESSION_DELETE_INCOMPLETE", stateMayHaveChanged: true }
      });
      await expect(access(binding.opaqueRef)).resolves.toBeUndefined();
      await expect(access(observationMarker)).resolves.toBeUndefined();
    } finally {
      await interrupted.dispose();
    }

    const scanCallsBeforeRecovery = scan.mock.calls.length;
    cleanupAllowed = true;
    const recovered = createPiAdapter(options);
    try {
      await recovered.observeDetachedSubagents(deletionContext);

      expect(storeFor).toHaveBeenCalledTimes(3);
      expect(storeFor.mock.calls[1]?.[0]).toMatchObject({
        sessionId: context.sessionId,
        targetId: target.id,
        bindingOpaqueRef: binding.opaqueRef,
        generation: binding.generation + 1
      });
      expect(storeFor.mock.calls[2]?.[0]).toEqual(storeFor.mock.calls[1]?.[0]);
      expect(stopAndRemoveSession).toHaveBeenCalledExactlyOnceWith({
        sessionId: context.sessionId,
        sessionKey: managedSubagentSessionKey(context.sessionId),
        timeoutMs: 5_000
      });
      expect(finalizeDeletion).toHaveBeenCalledExactlyOnceWith({
        sessionId: context.sessionId,
        sessionKey: managedSubagentSessionKey(context.sessionId),
        deletionReceipt
      });
      expect(onManagedSubagentLineageRemoved).toHaveBeenCalledTimes(2);
      expect(onManagedSubagentLineageRemoved).toHaveBeenLastCalledWith({
        sessionId: context.sessionId,
        targetId: target.id
      });
      expect(scan).toHaveBeenCalledTimes(scanCallsBeforeRecovery);
      expect(processFactory).toHaveBeenCalledTimes(1);
      expect(disposeStore).toHaveBeenCalledTimes(3);
      await expect(access(binding.opaqueRef)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(observationDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(join(agentHome, "subagent-deletions"))).toEqual([]);
    } finally {
      await recovered.dispose();
    }
  });

  it("fails closed on unsafe or conflicting retained remote deletion journals", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-remote-deletion-journal-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-remote-deletion-journal-workspace-"));
    const target: TargetDescriptor = {
      id: "remote-deletion-journal-target",
      backendId: "pi",
      displayName: "Remote deletion journal",
      workspaceRoot: workspace,
      managed: true,
      trusted: false,
      remoteWorkspace: { hostId: "fixture-host", workspaceRoot: "/workspace" }
    };
    const binding: NativeSessionBinding = {
      opaqueRef: join(agentHome, "native-session.jsonl"),
      generation: 1
    };
    const context = { ...makeContext(target, []), binding };
    const bindingDigest = createHash("sha256").update(binding.opaqueRef).digest("hex");
    const deletionRoot = join(agentHome, "subagent-deletions");
    const journalPath = (scope: "session" | "lineage"): string => {
      const key = createHash("sha256").update([
        scope,
        context.sessionId,
        target.id,
        bindingDigest
      ].join("\u0000")).digest("hex");
      return join(deletionRoot, `${key}.json`);
    };
    const storeFor = vi.fn(async () => {
      throw new Error("unsafe deletion recovery must not acquire remote storage");
    });
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      providers: [],
      managedDurableStoreRegistry: { storeFor }
    });
    try {
      await mkdir(journalPath("session"), { recursive: true });
      await expect(adapter.observeDetachedSubagents(context)).rejects.toThrow(
        "remote managed Subagent deletion retry journal is unsafe"
      );

      await rm(journalPath("session"), { recursive: true, force: false });
      const deletionReceipt = createHash("sha256").update("retained deletion").digest("hex");
      for (const scope of ["session", "lineage"] as const) {
        const trashRecoveryKey = createHash("sha256").update([
          "native-trash",
          context.sessionId,
          target.id,
          bindingDigest,
          deletionReceipt
        ].join("\u0000")).digest("hex");
        await writeFile(journalPath(scope), JSON.stringify({
          format: 1,
          scope,
          sessionId: context.sessionId,
          targetId: target.id,
          sessionKey: managedSubagentSessionKey(context.sessionId),
          bindingDigest,
          deletionReceipt,
          trashRecoveryKey,
          recordedAt: Date.now()
        }), "utf8");
      }
      await expect(adapter.observeDetachedSubagents(context)).rejects.toThrow(
        "remote managed Subagent deletion retry journals conflict for the same Session binding"
      );
      expect(storeFor).not.toHaveBeenCalled();
    } finally {
      await adapter.dispose();
    }
  });

  it("restores the private append prompt from AdapterContext after an adapter restart", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-personalization-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-personalization-workspace-"));
    const specs: PiProcessSpec[] = [];
    const memoryPrompt = "MAKER-MEMORY-INDEX: release policy";
    const options = {
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.1.0",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions" as const,
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32768, maxTokens: 4096 }]
      }],
      resolveMakerMemoryPrompt: () => memoryPrompt,
      processFactory: (spec: PiProcessSpec) => {
        specs.push(spec);
        return new ScriptedPiProcess(spec) as unknown as PiProcessHandle;
      }
    };
    const target: TargetDescriptor = {
      id: "target-personalization",
      backendId: "pi",
      displayName: "Local",
      workspaceRoot: workspace,
      managed: false,
      trusted: false
    };
    const prompt = "Prefer concise replies and preserve repository conventions.";
    const initialContext = makeContext(target, []);
    const first = createPiAdapter(options);
    const binding = await first.createSession({
      target,
      providerId: "local",
      modelId: "test-model",
      fastMode: false,
      permissionMode: "ask",
      appendSystemPrompt: prompt
    }, initialContext);
    await first.closeSession(binding, { ...initialContext, binding });
    await first.dispose();

    const restarted = createPiAdapter(options);
    const resumeContext: AdapterContext = {
      ...initialContext,
      generation: binding.generation + 1,
      binding,
      appendSystemPrompt: prompt
    };
    try {
      await restarted.resumeSession(binding, resumeContext);
      const restoredPrompt = optionalArgument(specs.at(-1)!.args, "--append-system-prompt");
      expect(restoredPrompt).toContain(prompt);
      expect(restoredPrompt).toContain(memoryPrompt);
      expect(restoredPrompt).toContain("Use the dedicated grep tool for content search");
      expect(restoredPrompt).toContain("After locating a target, read only the relevant range when practical");
    } finally {
      await restarted.dispose();
    }
  });

  it("captures compaction memory for the runtime and keeps compaction best-effort", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-memory-compaction-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-memory-compaction-workspace-"));
    const digests: Array<Record<string, string>> = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.1.0",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32768, maxTokens: 4096 }]
      }],
      isCompactionMemoryEnabled: () => true,
      onCompactionDigest: async (input) => {
        digests.push({ ...input });
        throw new Error("private memory storage unavailable");
      },
      processFactory: (spec) => new ScriptedPiProcess(spec, { compactEmitsEvents: true }) as unknown as PiProcessHandle
    });
    const target: TargetDescriptor = {
      id: "target-memory",
      backendId: "pi",
      displayName: "Memory-capable adapter",
      workspaceRoot: workspace,
      managed: false,
      trusted: false
    };
    const events: EventPayload[] = [];
    const context = makeContext(target, events);
    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      await expect(adapter.compact(undefined, { ...context, binding })).resolves.toBe("compacted");
      await flushAdapterEvents();
      expect(digests).toEqual([expect.objectContaining({
        backendId: "pi",
        targetId: "target-memory",
        sessionId: "session-1",
        summary: "summary",
        reason: "manual"
      })]);
    } finally {
      await adapter.dispose();
    }
  });

  it("does not return manual compaction before its received terminal event is durably emitted", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-compaction-event-order-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-compaction-event-order-workspace-"));
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.1.0",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32768, maxTokens: 4096 }]
      }],
      processFactory: (spec) => new ScriptedPiProcess(spec, { compactEmitsEvents: true }) as unknown as PiProcessHandle
    });
    const target: TargetDescriptor = {
      id: "target-compaction-event-order",
      backendId: "pi",
      displayName: "Compaction event ordering",
      workspaceRoot: workspace,
      managed: false,
      trusted: false
    };
    const events: EventPayload[] = [];
    let terminalObservedResolve!: () => void;
    let terminalRelease!: () => void;
    const terminalObserved = new Promise<void>((resolve) => { terminalObservedResolve = resolve; });
    const terminalGate = new Promise<void>((resolve) => { terminalRelease = resolve; });
    const context: AdapterContext = {
      ...makeContext(target, events),
      emit: async (payload) => {
        events.push(payload);
        if (payload.type === "compaction" && payload.state === "completed") {
          terminalObservedResolve();
          await terminalGate;
        }
      }
    };
    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      let settled = false;
      const compacted = adapter.compact(undefined, { ...context, binding }).finally(() => { settled = true; });
      await terminalObserved;
      await Promise.resolve();
      expect(settled).toBe(false);
      terminalRelease();
      await expect(compacted).resolves.toBe("compacted");
      expect(events.filter((event) => event.type === "compaction").map((event) => event.state)).toEqual([
        "started",
        "completed"
      ]);
    } finally {
      terminalRelease();
      await adapter.dispose();
    }
  });

  it("enforces the relative threshold before publishing turn settlement and suppresses manual RPC duplicates", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-threshold-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-threshold-workspace-"));
    const processes: ScriptedPiProcess[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      settings: { compaction: { enabled: true, thresholdPercent: 75 } },
      versionProbe: async () => "pi 99.1.0",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 100, maxTokens: 20 }]
      }],
      processFactory: (spec) => {
        const process = new ScriptedPiProcess(spec, {
          contextUsage: { tokens: 80, contextWindow: 100 },
          compactEmitsEvents: true
        });
        processes.push(process);
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-threshold",
      backendId: "pi",
      displayName: "Threshold",
      workspaceRoot: workspace,
      managed: false,
      trusted: false
    };
    const events: EventPayload[] = [];
    const context = makeContext(target, events);
    try {
      const binding = await adapter.createSession(
        { target, providerId: "local", modelId: "test-model", fastMode: false, permissionMode: "ask" },
        context
      );
      await adapter.send(
        { text: "finish", images: [], files: [], mentions: [], disposition: "prompt" },
        { ...context, binding }
      );
      await flushAdapterEvents();

      expect(processes[0]?.commands.filter((command) => command.type === "compact")).toHaveLength(1);
      expect(events.filter((event) => event.type === "compaction")).toEqual([
        expect.objectContaining({ type: "compaction", state: "started", reason: "threshold", automatic: true }),
        expect.objectContaining({ type: "compaction", state: "completed", reason: "threshold", automatic: true, tokensBefore: 80, tokensAfter: 20 })
      ]);
      const compactEnd = events.findIndex((event) => event.type === "compaction" && event.state === "completed");
      const done = events.findIndex((event) => event.type === "done");
      expect(compactEnd).toBeGreaterThanOrEqual(0);
      expect(done).toBeGreaterThan(compactEnd);
    } finally {
      await adapter.dispose();
    }
  });

  it("persists the native dispatch fence after automatic compaction and immediately before prompt acceptance", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-native-fence-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-native-fence-workspace-"));
    const processes: ScriptedPiProcess[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      settings: { compaction: { enabled: true, thresholdPercent: 75 } },
      versionProbe: async () => "pi 99.1.0",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 100, maxTokens: 20 }]
      }],
      validateRemoteWorkspace: async () => undefined,
      includeManagedSubagentTools: () => false,
      processFactory: (spec) => {
        const process = new ScriptedPiProcess(spec, {
          contextUsage: { tokens: 80, contextWindow: 100 },
          compactEmitsEvents: true
        });
        processes.push(process);
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-native-fence",
      backendId: "pi",
      displayName: "Native fence",
      workspaceRoot: workspace,
      managed: false,
      trusted: false,
      remoteWorkspace: { hostId: "test-host", workspaceRoot: "/workspace" }
    };
    const events: EventPayload[] = [];
    const context = makeContext(target, events);
    try {
      const binding = await adapter.createSession(
        { target, providerId: "local", modelId: "test-model", fastMode: false, permissionMode: "ask" },
        context
      );
      let commandsAtFence: readonly string[] = [];
      let fingerprint = "";
      await adapter.sendWithDurableNativeDispatchFence(
        { text: "durable prompt", images: [], files: [], mentions: [], disposition: "prompt" },
        { ...context, binding },
        async (preparation) => {
          commandsAtFence = processes[0]!.commands.map((command) => String(command.type));
          fingerprint = preparation.inputFingerprint;
          expect(preparation.nativeHistory.activeEntryId).toBe("entry-1");
        }
      );

      const commandTypes = processes[0]!.commands.map((command) => String(command.type));
      expect(commandsAtFence.at(-2)).toBe("compact");
      expect(commandsAtFence.at(-1)).toBe("get_entries");
      expect(commandsAtFence).not.toContain("prompt");
      expect(commandTypes.at(-1)).toBe("prompt");
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await adapter.dispose();
    }
  });

  it("hot-applies a new threshold and evaluates it against a smaller switched model window", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-threshold-switch-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-threshold-switch-workspace-"));
    const processes: ScriptedPiProcess[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      settings: { compaction: { enabled: true, thresholdPercent: 95 } },
      versionProbe: async () => "pi 99.1.0",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [
          { id: "large", contextWindow: 32_768, maxTokens: 4_096 },
          { id: "small", contextWindow: 100, maxTokens: 20 }
        ]
      }],
      processFactory: (spec) => {
        const process = new ScriptedPiProcess(spec, {
          contextTokens: 80,
          modelContextWindows: { large: 32_768, small: 100 },
          compactEmitsEvents: true
        });
        processes.push(process);
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-threshold-switch",
      backendId: "pi",
      displayName: "Threshold switch",
      workspaceRoot: workspace,
      managed: false,
      trusted: false
    };
    const events: EventPayload[] = [];
    const context = makeContext(target, events);
    try {
      const binding = await adapter.createSession(
        { target, providerId: "local", modelId: "large", fastMode: false, permissionMode: "ask" },
        context
      );
      const bound = { ...context, binding };
      await adapter.setAutoCompactionThreshold(75, bound);
      await adapter.setModel("local", "small", bound);
      await flushAdapterEvents();

      expect(processes[0]?.commands.filter((command) => command.type === "compact")).toHaveLength(1);
      expect(events.filter((event) => event.type === "compaction")).toEqual([
        expect.objectContaining({ state: "started", reason: "threshold", automatic: true }),
        expect.objectContaining({ state: "completed", reason: "threshold", automatic: true })
      ]);
    } finally {
      await adapter.dispose();
    }
  });

  it("evaluates a lowered threshold immediately while the restored runtime is idle", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-threshold-hot-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-threshold-hot-workspace-"));
    const processes: ScriptedPiProcess[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      settings: { compaction: { enabled: true, thresholdPercent: 95 } },
      versionProbe: async () => "pi 99.1.0",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 100, maxTokens: 20 }]
      }],
      processFactory: (spec) => {
        const process = new ScriptedPiProcess(spec, {
          contextUsage: { tokens: 80, contextWindow: 100 },
          compactEmitsEvents: true
        });
        processes.push(process);
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-threshold-hot",
      backendId: "pi",
      displayName: "Hot threshold",
      workspaceRoot: workspace,
      managed: false,
      trusted: false
    };
    const events: EventPayload[] = [];
    const context = makeContext(target, events);
    try {
      const binding = await adapter.createSession(
        { target, providerId: "local", modelId: "test-model", fastMode: false, permissionMode: "ask" },
        context
      );
      await adapter.setAutoCompactionThreshold(75, { ...context, binding });
      await flushAdapterEvents();

      const commandTypes = processes[0]?.commands.map((command) => command.type) ?? [];
      expect(commandTypes).toContain("get_session_stats");
      expect(commandTypes).toContain("compact");
      expect(commandTypes).not.toContain("prompt");
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "compaction", state: "started", reason: "threshold" }),
        expect.objectContaining({ type: "compaction", state: "completed", reason: "threshold" })
      ]));
    } finally {
      await adapter.dispose();
    }
  });

  it("compacts a resumed hot session before its first provider prompt", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-threshold-resume-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-threshold-resume-workspace-"));
    const processes: ScriptedPiProcess[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      settings: { compaction: { enabled: true, thresholdPercent: 75 } },
      versionProbe: async () => "pi 99.1.0",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 100, maxTokens: 20 }]
      }],
      processFactory: (spec) => {
        const process = new ScriptedPiProcess(spec, {
          contextUsage: { tokens: 80, contextWindow: 100 },
          compactEmitsEvents: true
        });
        processes.push(process);
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-threshold-resume",
      backendId: "pi",
      displayName: "Resume threshold",
      workspaceRoot: workspace,
      managed: false,
      trusted: false
    };
    const events: EventPayload[] = [];
    const context = makeContext(target, events);
    try {
      const binding = await adapter.createSession(
        { target, providerId: "local", modelId: "test-model", fastMode: false, permissionMode: "ask" },
        context
      );
      await adapter.detachSession(binding, context);
      events.length = 0;
      const resumed = await adapter.resumeSession(binding, context);
      const bound = { ...context, binding: resumed.binding };
      await adapter.send({ text: "first resumed prompt", images: [], files: [], mentions: [], disposition: "prompt" }, bound);
      await flushAdapterEvents();

      const resumedProcess = processes[1];
      const commandTypes = resumedProcess?.commands.map((command) => command.type) ?? [];
      expect(commandTypes.filter((type) => type === "compact")).toHaveLength(1);
      expect(commandTypes.indexOf("prompt")).toBeGreaterThan(commandTypes.indexOf("compact"));
      expect(events.findIndex((event) => event.type === "compaction" && event.state === "completed")).toBeLessThan(
        events.findIndex((event) => event.type === "done")
      );
    } finally {
      await adapter.dispose();
    }
  });

  it("reports Backend authentication from the non-secret native OAuth generation state", async () => {
    const authenticatedHome = await mkdtemp(join(tmpdir(), "joko-pi-native-authenticated-"));
    const signedOutHome = await mkdtemp(join(tmpdir(), "joko-pi-native-signed-out-"));
    const nativeOptions = {
      catalogGeneration: 1,
      nativeAuthProviderIds: ["native-oauth"],
      loadNativeAuth: () => ({ catalogGeneration: 1, credentials: {} }),
      versionProbe: async () => "pi 99.1.0"
    } as const;
    const authenticated = createPiAdapter({
      agentHome: authenticatedHome,
      sessionRoot: authenticatedHome,
      ...nativeOptions,
      nativeAuthenticatedProviderIds: ["native-oauth"]
    });
    const signedOut = createPiAdapter({ agentHome: signedOutHome, sessionRoot: signedOutHome, ...nativeOptions });

    try {
      await expect(authenticated.describe()).resolves.toMatchObject({ authenticationState: "authenticated" });
      await expect(signedOut.describe()).resolves.toMatchObject({ authenticationState: "signed_out" });
    } finally {
      await Promise.all([authenticated.dispose(), signedOut.dispose()]);
    }
  });

  it("keeps encrypted-retry controls session-isolated and applies the owner default to future runtimes", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-encrypted-retry-isolation-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-encrypted-retry-workspace-"));
    const specs: PiProcessSpec[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      providers: [{
        id: "local",
        baseUrl: "https://provider.test/v1",
        api: "openai-responses",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      versionProbe: async () => "pi 99.1.0",
      processFactory: (spec) => {
        specs.push(spec);
        return new ScriptedPiProcess(spec) as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "encrypted-retry-target",
      backendId: "pi",
      displayName: "Encrypted retry",
      workspaceRoot: workspace,
      managed: false,
      trusted: false
    };
    const first = makeContext(target, []);
    const second = { ...makeContext(target, []), sessionId: "session-2" };
    const third = { ...makeContext(target, []), sessionId: "session-3" };

    try {
      const firstBinding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, first);
      await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, second);

      const firstControl = String(specs[0]?.env.JOKO_PI_SILENT_ENCRYPTED_RETRY_CONTROL_FILE);
      const secondControl = String(specs[1]?.env.JOKO_PI_SILENT_ENCRYPTED_RETRY_CONTROL_FILE);
      expect(firstControl).not.toBe(secondControl);
      await adapter.setSilentEncryptedRetry(false, { ...first, binding: firstBinding });
      await expect(readFile(firstControl, "utf8").then(JSON.parse)).resolves.toMatchObject({ enabled: false });
      await expect(readFile(secondControl, "utf8").then(JSON.parse)).resolves.toMatchObject({ enabled: true });

      await adapter.configureSilentEncryptedRetry(false);
      expect(specs).toHaveLength(2);
      await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, third);
      const thirdControl = String(specs[2]?.env.JOKO_PI_SILENT_ENCRYPTED_RETRY_CONTROL_FILE);
      await expect(readFile(thirdControl, "utf8").then(JSON.parse)).resolves.toMatchObject({ enabled: false });
    } finally {
      await adapter.dispose();
    }
  });

  it("maps canonical Subagent control to the exact owned hidden command", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-subagent-control-adapter-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-subagent-control-workspace-"));
    const processes: ScriptedPiProcess[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.1.0",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      processFactory: (spec) => {
        const process = new ScriptedPiProcess(spec, { synchronousExtensionCommand: "joko-stop-background-task" });
        processes.push(process);
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "subagent-control-target",
      backendId: "pi",
      displayName: "Subagent control",
      workspaceRoot: workspace,
      managed: true,
      trusted: false
    };
    const events: EventPayload[] = [];
    const context = makeContext(target, events);
    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      const boundContext = { ...context, binding };
      const taskId = "canonical-control:1";
      const activeRunDirectory = await writeDurableSubagentControlFixture(agentHome, context.sessionId, context.generation, taskId);
      await expect(adapter.controlSubagent({
        runId: taskId,
        childId: `${taskId}:child`,
        action: "steer",
        message: "Focus on the failing assertion"
      }, boundContext)).resolves.toBeUndefined();
      await expect(adapter.controlSubagent({ runId: taskId, action: "follow_up", message: "Check the adjacent case" }, boundContext)).resolves.toBeUndefined();
      await expect(adapter.controlSubagent({ runId: taskId, action: "stop" }, boundContext)).resolves.toBeUndefined();
      const terminalTaskId = "canonical-resume:1";
      await writeDurableSubagentControlFixture(agentHome, context.sessionId, context.generation, terminalTaskId, "completed");
      await expect(adapter.controlSubagent({ runId: terminalTaskId, action: "resume", message: "Continue once" }, boundContext)).resolves.toBeUndefined();
      const controlPayloads = processes[0]?.commands
        .filter((candidate) => candidate.type === "prompt" && String(candidate.message).startsWith("/joko-stop-background-task "))
        .map((command) => JSON.parse(Buffer.from(
          String(command.message).slice("/joko-stop-background-task ".length),
          "base64url"
        ).toString("utf8")) as Record<string, unknown>) ?? [];
      expect(controlPayloads.map((payload) => payload["action"])).toEqual(["steer", "follow_up", "stop", "resume"]);
      expect(controlPayloads[0]).toEqual({
        sessionId: context.sessionId,
        generation: context.generation,
        taskId,
        childId: `${taskId}:child`,
        action: "steer",
        message: "Focus on the failing assertion"
      });
      expect(controlPayloads[3]).toMatchObject({
        taskId: terminalTaskId,
        action: "resume",
        message: "Continue once"
      });
      await expect(adapter.controlSubagent({
        runId: taskId,
        childId: "foreign-child",
        action: "stop"
      }, boundContext)).rejects.toMatchObject({
        publicError: { code: "PI_SUBAGENT_CONTROL_OWNERSHIP_UNCONFIRMED", stateMayHaveChanged: false }
      });
      await rm(activeRunDirectory, { recursive: true, force: true });
      await adapter.deleteSession(binding, boundContext);
      const eventCountAfterDelete = events.length;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
      expect(events).toHaveLength(eventCountAfterDelete);
      await expect(access(join(agentHome, "subagent-runs", managedSubagentSessionKey(context.sessionId))))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await adapter.dispose();
    }
  });

  it("discovers upstream Pi history through an opaque reference and materializes a managed copy on attach", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-external-agent-"));
    const sessionRoot = await mkdtemp(join(tmpdir(), "joko-pi-external-managed-"));
    const externalRoot = await mkdtemp(join(tmpdir(), "joko-pi-external-source-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-external-workspace-"));
    const otherWorkspace = await mkdtemp(join(tmpdir(), "joko-pi-external-other-workspace-"));
    const sourcePath = join(externalRoot, "upstream.jsonl");
    const sourceBytes = [
      JSON.stringify({ type: "session", version: 3, id: "upstream-native", cwd: workspace }),
      JSON.stringify({ type: "message", id: "one", parentId: null, message: { role: "user", content: "continue me" } }),
      JSON.stringify({ type: "session_info", id: "two", parentId: "one", name: "Upstream task" })
    ].join("\n") + "\n";
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(externalRoot, "other-workspace.jsonl"), `${JSON.stringify({
      type: "session",
      version: 3,
      id: "other-workspace-native",
      cwd: otherWorkspace
    })}\n`);
    const adapter = createPiAdapter({ agentHome, sessionRoot, externalSessionRoots: [externalRoot] });
    const target: TargetDescriptor = {
      id: "external-target",
      backendId: "pi",
      displayName: "External import target",
      workspaceRoot: workspace,
      managed: false,
      trusted: false
    };
    try {
      const discovered = await adapter.listNativeSessions(target);
      expect(discovered).toHaveLength(1);
      const [candidate] = discovered;
      expect(candidate).toMatchObject({
        nativeSessionId: "upstream-native",
        name: "Upstream task",
        workspaceRoot: workspace,
        messageCount: 1,
        state: "ready"
      });
      expect(candidate?.nativeReference).toMatch(/^pi-external-session:[a-f0-9]{64}$/);
      expect(candidate?.nativeReference).not.toContain(externalRoot);

      await writeFile(sourcePath, `${sourceBytes}${JSON.stringify({
        type: "message",
        id: "changed",
        parentId: "two",
        message: { role: "assistant", content: "new upstream output" }
      })}\n`);
      await expect(adapter.resolveNativeSessionReference(candidate!.nativeReference, target, 1))
        .rejects.toMatchObject({ publicError: { code: "PI_EXTERNAL_SESSION_CHANGED" } });

      const [rescanned] = await adapter.listNativeSessions(target);
      expect(rescanned?.nativeReference).not.toBe(candidate?.nativeReference);
      const stableSource = await readFile(sourcePath);
      const stableSourceStat = await stat(sourcePath);
      const binding = await adapter.resolveNativeSessionReference(rescanned!.nativeReference, target, 2);
      expect(binding.generation).toBe(2);
      expect(binding.nativeSessionId).not.toBe("upstream-native");
      expect(binding.opaqueRef.startsWith(join(sessionRoot, "sessions"))).toBe(true);
      expect(binding.opaqueRef).not.toBe(sourcePath);
      expect(await readFile(sourcePath)).toEqual(stableSource);
      expect((await stat(sourcePath)).mtimeMs).toBe(stableSourceStat.mtimeMs);
      const importedRecords = (await readFile(binding.opaqueRef, "utf8")).trim().split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(importedRecords[0]).toMatchObject({ type: "session", cwd: workspace });
      expect(importedRecords[0]?.id).toBe(binding.nativeSessionId);
      expect(importedRecords[0]).not.toHaveProperty("parentSession");
      await expect(adapter.resolveNativeSessionReference(rescanned!.nativeReference, target, 3))
        .rejects.toMatchObject({ publicError: { code: "PI_EXTERNAL_SESSION_REFERENCE_STALE" } });
    } finally {
      await adapter.dispose();
    }
  });

  it("runs the full backend-neutral flow against a real JSONL fake process", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-adapter-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-workspace-"));
    await writeFile(join(workspace, "input.txt"), "hello");
    const processes: ScriptedPiProcess[] = [];
    const specs: PiProcessSpec[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.1.0",
      providers: [
        {
          id: "local",
          baseUrl: "http://127.0.0.1:11434/v1",
          api: "openai-completions",
          keyless: true,
          models: [{ id: "test-model", contextWindow: 32768, maxTokens: 4096 }]
        }
      ],
      processFactory: (spec) => {
        specs.push(spec);
        const process = new ScriptedPiProcess(spec, { synchronousExtensionCommand: "joko-stop-background-task" });
        processes.push(process);
        return process as unknown as PiProcessHandle;
      }
    });
    const descriptor = await adapter.describe();
    expect(descriptor.tools.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls", "ask_user_question", "subagent", "subagent_status"]);
    expect(descriptor.tools.filter((tool) => tool.enabled).map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write", "ask_user_question", "subagent", "subagent_status"]);
    expect(descriptor.capabilities.get("permission.modes")).toMatchObject({
      supported: true,
      options: ["ask", "auto", "bypassPermissions"]
    });
    expect(descriptor.capabilities.get("background.tasks")).toMatchObject({ supported: true });
    expect(descriptor.capabilities.get("background.tasks.cancel")).toMatchObject({ supported: true });
    for (const capability of [
      "subagents.list",
      "subagents.detail",
      "subagents.transcript",
      "subagents.stop",
      "subagents.steer",
      "subagents.follow_up",
      "subagents.resume"
    ]) expect(descriptor.capabilities.get(capability)).toMatchObject({ supported: true });
    expect(descriptor.capabilities.get("session.discovery")).toMatchObject({ supported: true });
    expect(descriptor.capabilities.get("session.portable_transfer")).toMatchObject({ supported: true });
    expect(descriptor.capabilities.get("runtime.user_shell")).toMatchObject({ supported: true });
    expect(descriptor.models).toEqual([expect.objectContaining({ supportsFastMode: false })]);
    const target: TargetDescriptor = {
      id: "target-1",
      backendId: "pi",
      displayName: "Local",
      workspaceRoot: workspace,
      managed: false,
      trusted: false
    };
    const events: EventPayload[] = [];
    const context = makeContext(target, events);
    vi.stubEnv("ProgramFiles", "C:\\Program Files");
    vi.stubEnv("ProgramFiles(x86)", "C:\\Program Files (x86)");
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    let binding!: NativeSessionBinding;
    try {
      binding = await adapter.createSession(
        { target, name: "Test", providerId: "local", modelId: "test-model", effort: "medium", fastMode: false, permissionMode: "ask" },
        context
      );
    } finally {
      vi.unstubAllEnvs();
    }
    const boundContext = { ...context, binding };

    expect(specs[0]?.env.JOKO_PI_PRODUCT_SESSION_ID).toBe(context.sessionId);
    await expect(adapter.cancelBackgroundTask(boundContext, "managed-call:1")).resolves.toBeUndefined();
    const stopCommand = processes[0]?.commands.find((command) =>
      command.type === "prompt" && String(command.message).startsWith("/joko-stop-background-task "));
    expect(stopCommand).toBeDefined();
    const stopPayload = JSON.parse(Buffer.from(
      String(stopCommand!.message).slice("/joko-stop-background-task ".length),
      "base64url"
    ).toString("utf8")) as Record<string, unknown>;
    expect(stopPayload).toEqual({ sessionId: context.sessionId, taskId: "managed-call:1" });
    await expect(adapter.cancelBackgroundTask(boundContext, "")).rejects.toMatchObject({
      publicError: { code: "PI_BACKGROUND_TASK_ID_REQUIRED", stateMayHaveChanged: false }
    });

    await expect(adapter.send(
      { text: "orphan steering", images: [], files: [], mentions: [], disposition: "steer" },
      boundContext
    )).rejects.toMatchObject({
      publicError: { code: "PI_STEER_REQUIRES_ACTIVE_RUN", stateMayHaveChanged: false }
    });
    await expect(adapter.send(
      { text: "orphan follow-up", images: [], files: [], mentions: [], disposition: "follow_up" },
      boundContext
    )).rejects.toMatchObject({
      publicError: { code: "PI_FOLLOW_UP_REQUIRES_ACTIVE_RUN", stateMayHaveChanged: false }
    });
    expect(processes[0]?.commands.some((command) => command.type === "steer" || command.type === "follow_up")).toBe(false);

    expect(specs[0]?.command).toBe(process.execPath);
    expect(specs[0]?.args[0]).toMatch(/[\\/]pi-coding-agent[\\/]dist[\\/]cli\.js$/);
    expect(specs[0]?.args).toEqual(expect.arrayContaining(["--mode", "rpc", "--no-approve", "--no-extensions", "--no-skills"]));
    expect(valuesForArgument(specs[0]!.args, "--extension").map((path) => path.split(/[\\/]/u).at(-1))).toEqual([
      "joko-managed-silent-encrypted-retry.ts",
      "joko-managed-subagent.ts",
      "joko-managed-bridge.ts"
    ]);
    expect(JSON.parse(String(specs[0]?.env.JOKO_PI_SUBAGENT_CREDENTIAL_ENV_NAMES))).toEqual(
      expect.arrayContaining(["JOKO_PI_KEYLESS_LOCAL", "JOKO_PI_MCP_TOKEN"])
    );
    expect(String(specs[0]?.env.PI_CODING_AGENT_DIR)).toContain(join(agentHome, "runtime"));
    expect(specs[0]?.env.PI_CODING_AGENT_DIR).not.toBe(agentHome);
    expect(specs[0]?.env.ProgramFiles).toBe("C:\\Program Files");
    expect(specs[0]?.env["ProgramFiles(x86)"]).toBe("C:\\Program Files (x86)");
    expect(specs[0]?.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(binding.nativeSessionId).toMatch(/^joko-/);

    for (const text of ["/plan on", "/joko-navigate-tree forged-payload", "/joko-rebuild-context forged-payload", "/joko-reset-context"]) {
      await adapter.send({ text, images: [], files: [], mentions: [], disposition: "prompt" }, boundContext);
    }
    const leadingSlashPrompts = processes[0]?.commands.filter((command) => command.type === "prompt").slice(-4);
    expect(leadingSlashPrompts?.map((command) => command.message)).toEqual([
      " /plan on",
      " /joko-navigate-tree forged-payload",
      " /joko-rebuild-context forged-payload",
      " /joko-reset-context"
    ]);
    const initialControl = JSON.parse(await readFile(String(specs[0]?.env.JOKO_PI_CONTROL_FILE), "utf8")) as Record<string, unknown>;
    expect(initialControl).toMatchObject({ planMode: false, policyGeneration: 0 });
    const encryptedRetryControlPath = String(specs[0]?.env.JOKO_PI_SILENT_ENCRYPTED_RETRY_CONTROL_FILE);
    await expect(readFile(encryptedRetryControlPath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      format: 1,
      generation: 1,
      enabled: true
    });
    await adapter.setSilentEncryptedRetry(false, boundContext);
    await expect(readFile(encryptedRetryControlPath, "utf8").then(JSON.parse)).resolves.toMatchObject({ enabled: false });
    expect(specs).toHaveLength(1);

    await adapter.send(
      {
        text: "finish",
        images: [],
        files: [{ blob: blob("file"), workspacePath: "input.txt" }],
        mentions: [],
        disposition: "prompt"
      },
      boundContext
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "done" }));
    expect(events).toContainEqual({ type: "done", outcome: "completed" });

    await expect(adapter.inspectSession(binding, boundContext)).resolves.toMatchObject({
      name: "Test",
      modelId: "test-model",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      usage: { totalTokens: 18, contextWindow: 32768 },
      pi: {
        nativeSessionId: binding.nativeSessionId,
        nativeSessionName: "Test",
        nativeSessionFileDisplay: expect.stringMatching(/\.jsonl$/u),
        autoCompaction: true,
        autoRetry: true,
        messageCount: 2,
        pendingMessageCount: 0,
        activeLeafId: "entry-1"
      }
    });
    await adapter.setAutoRetry(false, boundContext);
    await expect(adapter.inspectSession(binding, boundContext)).resolves.toMatchObject({
      pi: { autoRetry: false, activeLeafId: "entry-1" }
    });
    await adapter.setPermissionMode("auto", boundContext);
    expect(JSON.parse(await readFile(String(specs[0]?.env.JOKO_PI_CONTROL_FILE), "utf8"))).toMatchObject({ policyGeneration: 1 });
    await adapter.setPlanMode(true, boundContext);
    expect(JSON.parse(await readFile(String(specs[0]?.env.JOKO_PI_CONTROL_FILE), "utf8"))).toMatchObject({ policyGeneration: 2 });
    await expect(adapter.inspectSession(binding, boundContext)).resolves.toMatchObject({ planMode: true });
    await adapter.setModel("local", "test-model", boundContext);
    expect(JSON.parse(await readFile(String(specs[0]?.env.JOKO_PI_CONTROL_FILE), "utf8"))).toMatchObject({ policyGeneration: 3 });
    await adapter.setEffort("high", boundContext);
    expect(JSON.parse(await readFile(String(specs[0]?.env.JOKO_PI_CONTROL_FILE), "utf8"))).toMatchObject({ policyGeneration: 4 });
    const nativeTree = await adapter.getTree(boundContext);
    expect(nativeTree).toMatchObject({
      leafId: "entry-1",
      roots: [{
        entryId: "entry-1",
        kind: "message",
        role: "user",
        label: "[checkpoint] native tree",
        timestamp: 0,
        children: [{
          entryId: "entry-2",
          parentId: "entry-1",
          kind: "message",
          role: "assistant",
          label: "assistant preview",
          children: [{
            entryId: "entry-3",
            kind: "message",
            role: "toolResult",
            label: "[read] tool preview",
            children: [{ entryId: "entry-4", kind: "custom_message", role: "custom", label: expect.stringContaining("[notice]: custom preview [REDACTED]") }]
          }]
        }]
      }]
    });
    const customPreview = nativeTree.roots[0]?.children[0]?.children[0]?.children[0]?.label ?? "";
    expect(customPreview).toHaveLength(200);
    expect(customPreview).not.toContain("sk-abcdefghijklmnop");
    const nativeHistoryProjection = await adapter.getNativeHistoryProjection(boundContext);
    expect(nativeHistoryProjection).toMatchObject({
      activeEntryId: "entry-1",
      events: [{
        nativeEntryId: "entry-1",
        projectionKind: "message_user",
        emittedAt: 0,
        payload: { type: "message_complete", role: "user" }
      }]
    });
    expect(JSON.stringify(nativeHistoryProjection)).not.toContain(binding.opaqueRef);
    await expect(adapter.getCommands(boundContext)).resolves.toEqual([
      expect.objectContaining({ name: "plan", description: "User-authored planning prompt", source: "prompt", loaded: true }),
      expect.objectContaining({ name: "review", source: "prompt", loaded: true })
    ]);
    await expect(adapter.getAvailableModels(boundContext)).resolves.toMatchObject([{ providerId: "local", modelId: "test-model" }]);
    const beforeShell = events.length;
    await expect(adapter.executeUserShell({ command: "pwd", excludeFromContext: false }, boundContext))
      .resolves.toMatchObject({ output: "ok", exitCode: 0, cancelled: false });
    const shellEvents = events.slice(beforeShell).filter((event) =>
      event.type === "tool_start" || event.type === "tool_update" || event.type === "tool_result");
    expect(shellEvents).toHaveLength(3);
    expect(shellEvents[0]).toMatchObject({ type: "tool_start", name: "Shell", input: "pwd" });
    expect(shellEvents[1]).toMatchObject({ type: "tool_update", output: "ok" });
    expect(shellEvents[2]).toMatchObject({ type: "tool_result", output: "ok", isError: false });
    expect(new Set(shellEvents.map((event) => "callId" in event ? event.callId : undefined)).size).toBe(1);
    await expect(adapter.abortUserShell(boundContext)).resolves.toBeUndefined();

    const portable = await adapter.exportPortableNativeSession(boundContext);
    expect(portable.sha256).toBe(createHash("sha256").update(portable.bytes).digest("hex"));
    expect(portable.nativeSessionId).toBe(binding.nativeSessionId);
    const portableWorkspace = await mkdtemp(join(tmpdir(), "joko-pi-portable-target-"));
    const importedBinding = await adapter.importPortableNativeSession({
      target: { ...target, id: "portable-target", workspaceRoot: portableWorkspace },
      bytes: portable.bytes,
      generation: 1,
      nativeSessionId: "portable-copy"
    }, new AbortController().signal);
    expect(importedBinding).toMatchObject({ nativeSessionId: "portable-copy", generation: 1 });
    const importedHeader = JSON.parse((await readFile(importedBinding.opaqueRef, "utf8")).split("\n")[0]!) as Record<string, unknown>;
    expect(importedHeader).toMatchObject({ id: "portable-copy", cwd: portableWorkspace });
    expect(importedHeader).not.toHaveProperty("parentSession");
    await adapter.deleteNativeSession(importedBinding.opaqueRef);

    const clonedBinding = await adapter.clone(boundContext);
    expect(clonedBinding.nativeSessionId).toBe("clone-native");
    expect(clonedBinding.opaqueRef).not.toBe(binding.opaqueRef);
    expect(processes[0]?.commands.some((command) => command.type === "clone" || command.type === "abort")).toBe(false);
    expect(processes[0]?.signalCode).toBeNull();
    expect(processes[1]?.commands.some((command) => command.type === "clone")).toBe(true);
    expect(processes[1]?.signalCode).toBe("SIGTERM");
    expect(specs[1]?.env.JOKO_PI_CONTROL_FILE).not.toBe(specs[0]?.env.JOKO_PI_CONTROL_FILE);
    await expect(adapter.getState(boundContext)).resolves.toMatchObject({
      sessionFile: binding.opaqueRef,
      sessionId: binding.nativeSessionId
    });

    await adapter.closeSession(binding, boundContext);
    const clonedContext = { ...boundContext, sessionId: "session-clone", binding: clonedBinding };
    await adapter.resumeSession(clonedBinding, clonedContext);
    await adapter.setPermissionMode("auto", clonedContext);
    await adapter.setPlanMode(true, clonedContext);
    await expect(adapter.inspectSession(clonedBinding, clonedContext)).resolves.toMatchObject({ permissionMode: "auto", effort: "medium" });
    expect(specs[2]?.env.JOKO_PI_SPAWN_IDENTITY).not.toBe(specs[0]?.env.JOKO_PI_SPAWN_IDENTITY);

    await adapter.closeSession(clonedBinding, clonedContext);
    await expect(adapter.listNativeSessions(workspace)).resolves.toHaveLength(2);
    await adapter.deleteSession(clonedBinding, clonedContext);
    await expect(adapter.listNativeSessions(workspace)).resolves.toHaveLength(1);
    await adapter.deleteNativeSession(binding.opaqueRef);
    await expect(adapter.listNativeSessions(workspace)).resolves.toHaveLength(0);
    await adapter.dispose();
    expect(processes[0]?.exitCode).toBe(0);
  });

  it("hot-fences one ordered policy snapshot and answers current versus stale Pi decisions", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-policy-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-policy-workspace-"));
    const specs: PiProcessSpec[] = [];
    const processes: ScriptedPiProcess[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-policy-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      processFactory: (spec) => {
        specs.push(spec);
        const process = new ScriptedPiProcess(spec);
        processes.push(process);
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "policy-target",
      backendId: "pi",
      displayName: "Policy target",
      workspaceRoot: workspace,
      managed: true,
      trusted: false
    };
    const base = { ...makeContext(target, []), sessionId: "policy-session" };
    const snapshot: PolicySnapshot = {
      generation: "3",
      backendId: target.backendId,
      targetId: target.id,
      workspaceRoot: target.workspaceRoot,
      rules: [{
        id: "deny-browser-navigation",
        effect: "deny",
        subjectKind: "browser",
        toolProviderId: "browser",
        toolName: "navigate",
        ceiling: "critical",
        priority: 10,
        order: 0
      }]
    };

    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        effort: "off",
        fastMode: false,
        permissionMode: "auto"
      }, base);
      const context = { ...base, binding, policySnapshot: snapshot };
      await adapter.setPolicySnapshot(context);
      const controlPath = String(specs[0]?.env.JOKO_PI_CONTROL_FILE);
      expect(JSON.parse(await readFile(controlPath, "utf8"))).toMatchObject({ policyGeneration: 1 });

      const observation = {
        subjectKind: "browser" as const,
        risk: "high" as const,
        toolProviderId: "browser",
        toolName: "navigate"
      };
      processes[0]?.emitExtensionInput("policy-current", encodePolicyDecisionRequest({
        policyGeneration: 1,
        observation
      }));
      processes[0]?.emitExtensionInput("policy-stale", encodePolicyDecisionRequest({
        policyGeneration: 0,
        observation
      }));
      await waitForAdapterCondition(() => processes[0]?.commands.some((command) =>
        command.type === "extension_ui_response" && command.id === "policy-stale"
      ) === true);

      expect(processes[0]?.commands).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "extension_ui_response", id: "policy-current", value: "deny" }),
        expect.objectContaining({ type: "extension_ui_response", id: "policy-stale", value: "stale" })
      ]));
      await adapter.closeSession(binding, context);
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("projects the live Pi tool registry and uses tool source evidence for a commandless extension", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-runtime-tools-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-runtime-tools-workspace-"));
    const resources = await mkdtemp(join(tmpdir(), "joko-pi-runtime-tools-resources-"));
    const extension = join(resources, "lookup.ts");
    await writeFile(extension, "export default function lookup() {}\n");
    const events: EventPayload[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-runtime-tools-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      managedResources: {
        extensions: [extension],
        skills: [],
        prompts: [],
        packages: [],
        resources: [{
          id: "tool-only-extension",
          kind: "extension",
          name: "lookup",
          source: "local:lookup",
          state: "approved",
          runtimePath: extension
        }]
      },
      processFactory: (spec) => {
        const runtimeExtension = valuesForArgument(spec.args, "--extension")[0]!;
        const document = {
          format: 1,
          complete: true,
          activeToolNames: ["lookup_records"],
          tools: [{
            name: "lookup_records",
            description: "Look up records from the approved extension.",
            parameters: {
              type: "object",
              additionalProperties: false,
              required: ["query"],
              properties: {
                query: { type: "string", description: "Search query", minLength: 1 }
              }
            },
            promptGuidelines: ["Use a narrow query."],
            sourceInfo: {
              path: runtimeExtension,
              source: "lookup.ts",
              scope: "temporary",
              origin: "top-level",
              baseDir: dirname(runtimeExtension)
            }
          }]
        };
        return new ScriptedPiProcess(spec, {
          commands: [],
          runtimeToolCatalogStatuses: [...chunkedRuntimeToolCatalog(
            document,
            Math.ceil(Buffer.byteLength(JSON.stringify(document), "utf8") / 2)
          )].reverse()
        }) as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "runtime-tools-target",
      backendId: "pi",
      displayName: "Runtime tools",
      workspaceRoot: workspace,
      managed: true,
      trusted: false
    };
    const context = makeContext(target, events);
    try {
      expect((await adapter.describe()).capabilities.get("runtime.tools")).toMatchObject({ supported: true });
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      const bound = { ...context, binding };
      await expect(adapter.getRuntimeTools(bound)).resolves.toMatchObject({
        runtimeGeneration: 1,
        observedAt: expect.any(Number),
        tools: [{
          name: "lookup_records",
          active: true,
          description: "Look up records from the approved extension.",
          promptGuidelines: ["Use a narrow query."],
          sourceInfo: { scope: "temporary", origin: "top-level" },
          inputSchema: {
            allowsAdditionalFields: false,
            fields: [expect.objectContaining({ fieldPath: "query", required: true, type: "string" })]
          }
        }]
      });
      await expect(adapter.getCommands(bound)).resolves.toEqual([]);
      await expect(adapter.getResources(bound)).resolves.toEqual([
        expect.objectContaining({
          id: "tool-only-extension",
          state: "loaded",
          runtimeGeneration: 1
        })
      ]);
      expect(events.some((event) => event.type === "extension_status" && event.key === PI_RUNTIME_TOOL_CATALOG_STATUS_KEY)).toBe(false);
    } finally {
      await adapter.dispose();
    }
  });

  it("keeps user Bash correlated within its explicit deadline and aborts explicitly on context cancellation", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-delayed-bash-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-delayed-bash-workspace-"));
    let process!: ScriptedPiProcess;
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      requestTimeoutMs: 500,
      versionProbe: async () => "pi 99.99.99-delayed-bash-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      processFactory: (spec) => {
        process = new ScriptedPiProcess(spec, {
          bash: {
            deltas: ["delayed"],
            output: "completed after generic timeout",
            exitCode: 0,
            cancelled: false,
            truncated: false,
            responseDelayMs: 250
          }
        });
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-delayed-bash",
      backendId: "pi",
      displayName: "Delayed Bash",
      workspaceRoot: workspace,
      managed: true,
      trusted: true
    };
    const events: EventPayload[] = [];
    const context = makeContext(target, events);
    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      const bound = { ...context, binding };

      await expect(adapter.executeUserShell({ command: "delayed-success", excludeFromContext: false }, bound))
        .resolves.toMatchObject({ output: "completed after generic timeout", exitCode: 0, cancelled: false });
      expect(events.filter((event) => event.type === "tool_result").at(-1))
        .toMatchObject({ type: "tool_result", output: "completed after generic timeout", isError: false });

      const cancellation = new AbortController();
      const cancelledContext = { ...bound, signal: cancellation.signal };
      const cancelled = adapter.executeUserShell(
        { command: "delayed-cancel", excludeFromContext: true },
        cancelledContext
      );
      await vi.waitFor(() => {
        expect(process.commands.filter((command) => command.type === "bash")).toHaveLength(2);
      });
      cancellation.abort();

      await expect(cancelled).resolves.toMatchObject({ cancelled: true, truncated: false });
      expect(process.commands.filter((command) => command.type === "abort_bash")).toHaveLength(1);
      expect(events.filter((event) => event.type === "tool_result").at(-1))
        .toMatchObject({ type: "tool_result", isError: true });
      await expect(adapter.inspectSession(binding, bound)).resolves.toMatchObject({ binding });
    } finally {
      await adapter.dispose();
    }
  });

  it("keeps credentialed ambient proxies host-side while fencing shell output and child credentials", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-proxy-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-proxy-workspace-"));
    const credentialedProxy = "http://proxy-user:proxy-passphrase@127.0.0.1:8080";
    const uncredentialedProxy = "http://127.0.0.1:8081";
    const specs: PiProcessSpec[] = [];
    const events: EventPayload[] = [];
    vi.stubEnv("HTTP_PROXY", credentialedProxy);
    vi.stubEnv("HTTPS_PROXY", uncredentialedProxy);
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.1.0-proxy-fence",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32768, maxTokens: 4096 }]
      }],
      processFactory: (spec) => {
        specs.push(spec);
        return new ScriptedPiProcess(spec, {
          bash: {
            deltas: [`progress ${credentialedProxy} proxy-passphrase`],
            output: `result ${credentialedProxy} proxy-passphrase`,
            exitCode: 0,
            cancelled: false,
            truncated: false
          }
        }) as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-proxy-fence",
      backendId: "pi",
      displayName: "Proxy fence",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    };
    const context = makeContext(target, events);

    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      const spec = specs[0]!;
      expect(spec.env.HTTP_PROXY).toBe(credentialedProxy);
      expect(spec.env.HTTPS_PROXY).toBe(uncredentialedProxy);
      const runtimeSecretNames = JSON.parse(String(spec.env.JOKO_PI_SECRET_ENV_NAMES)) as string[];
      const childCredentialNames = JSON.parse(String(spec.env.JOKO_PI_SUBAGENT_CREDENTIAL_ENV_NAMES)) as string[];
      expect(runtimeSecretNames).toContain("HTTP_PROXY");
      expect(runtimeSecretNames).not.toContain("HTTPS_PROXY");
      expect(childCredentialNames).toContain("HTTP_PROXY");
      expect(childCredentialNames).not.toContain("HTTPS_PROXY");

      const result = await adapter.executeUserShell(
        { command: "proxy-diagnostic", excludeFromContext: false },
        { ...context, binding }
      );
      await flushAdapterEvents();
      const published = JSON.stringify({ events, result });
      expect(published).toContain("[REDACTED]");
      expect(published).not.toContain(credentialedProxy);
      expect(published).not.toContain("proxy-passphrase");
    } finally {
      await adapter.dispose().catch(() => undefined);
      vi.unstubAllEnvs();
    }
  });

  it("stores complete user Bash output above 64 MiB within the host Artifact capacity", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-large-bash-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-large-bash-workspace-"));
    const secret = "managed-large-bash-secret";
    const sourceBytes = 64 * 1024 * 1024 + 1;
    const fullOutput = `${"x".repeat(sourceBytes)}${secret}`;
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.1.0-large-bash",
      mcpBridge: { endpoint: "http://127.0.0.1:4040", token: secret, tools: [] },
      processFactory: (spec) => new ScriptedPiProcess(spec, {
        bash: { output: `preview ${secret}`, fullOutput, exitCode: 0, cancelled: false, truncated: true }
      }) as unknown as PiProcessHandle
    });
    const target: TargetDescriptor = {
      id: "target-large-user-bash",
      backendId: "pi",
      displayName: "Large Bash",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    };
    const events: EventPayload[] = [];
    let stagedSize = 0;
    let stagedTail = "";
    const context: AdapterContext = {
      ...makeContext(target, events),
      artifactCapacityBytes: 256 * 1024 * 1024,
      storeArtifact: async (sourcePath, options) => {
        const info = await stat(sourcePath);
        stagedSize = info.size;
        const handle = await open(sourcePath, "r");
        try {
          const tail = Buffer.alloc(64);
          const { bytesRead } = await handle.read(tail, 0, tail.length, Math.max(0, info.size - tail.length));
          stagedTail = tail.subarray(0, bytesRead).toString("utf8");
        } finally {
          await handle.close();
        }
        return {
          id: "large-user-bash-artifact",
          sha256: "a".repeat(64),
          byteLength: info.size,
          mimeType: options?.mimeType ?? "text/plain",
          fileName: options?.fileName
        };
      }
    };

    try {
      const binding = await adapter.createSession({ target, fastMode: false, permissionMode: "ask" }, context);
      const result = await adapter.executeUserShell(
        { command: "large-output", excludeFromContext: false },
        { ...context, binding }
      );
      expect(result).toMatchObject({
        output: "preview [REDACTED]",
        truncated: true,
        artifact: { id: "large-user-bash-artifact", byteLength: sourceBytes + "[REDACTED]".length }
      });
      expect(stagedSize).toBe(sourceBytes + "[REDACTED]".length);
      expect(stagedTail).toContain("[REDACTED]");
      expect(stagedTail).not.toContain(secret);
      expect(JSON.stringify(events)).not.toContain(secret);
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("reports a typed incomplete user Bash result one byte above host Artifact capacity", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-bash-capacity-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-bash-capacity-workspace-"));
    const secret = "managed-capacity-secret";
    const capacity = 1_024;
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.1.0-bash-capacity",
      mcpBridge: { endpoint: "http://127.0.0.1:4040", token: secret, tools: [] },
      processFactory: (spec) => new ScriptedPiProcess(spec, {
        bash: { output: "preview", fullOutput: `${"x".repeat(capacity + 1)}${secret}`, exitCode: 0, cancelled: false, truncated: true }
      }) as unknown as PiProcessHandle
    });
    const target: TargetDescriptor = {
      id: "target-bash-capacity",
      backendId: "pi",
      displayName: "Bash capacity",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    };
    const events: EventPayload[] = [];
    const storeArtifact = vi.fn();
    const context: AdapterContext = { ...makeContext(target, events), artifactCapacityBytes: capacity, storeArtifact };

    try {
      const binding = await adapter.createSession({ target, fastMode: false, permissionMode: "ask" }, context);
      const result = await adapter.executeUserShell(
        { command: "over-capacity", excludeFromContext: false },
        { ...context, binding }
      );
      expect(result).toMatchObject({ truncated: true });
      expect(result.artifact).toBeUndefined();
      expect(events).toContainEqual(expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ code: "PI_ARTIFACT_CAPACITY_EXCEEDED" }),
        terminal: false
      }));
      expect(events.filter((event) => event.type === "tool_result").at(-1))
        .toMatchObject({ output: expect.stringContaining("[full output artifact unavailable]") });
      expect(storeArtifact).not.toHaveBeenCalled();
      expect(JSON.stringify(events)).not.toContain(secret);
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("keeps prompt, compaction, abort, and native-session mutations correlated within explicit deadlines", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-delayed-stateful-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-delayed-stateful-workspace-"));
    let scripted!: ScriptedPiProcess;
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      requestTimeoutMs: 100,
      versionProbe: async () => "pi 99.99.99-delayed-stateful-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      processFactory: (spec) => {
        scripted = new ScriptedPiProcess(spec, {
          compactEmitsEvents: true,
          responseDelayMsByCommand: { prompt: 40, compact: 40, clear_queue: 40, abort: 40, clone: 40 }
        });
        return scripted as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-delayed-stateful",
      backendId: "pi",
      displayName: "Delayed stateful RPC",
      workspaceRoot: workspace,
      managed: true,
      trusted: true
    };
    const context = makeContext(target, []);
    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      const bound = { ...context, binding };

      await expect(adapter.send({ text: "slow prompt", images: [], files: [], mentions: [], disposition: "prompt" }, bound)).resolves.toBeUndefined();
      await expect(adapter.compact(undefined, bound)).resolves.toBe("compacted");
      await expect(adapter.abort(bound)).resolves.toBeUndefined();
      const clearIndex = scripted.commands.findIndex((command) => command.type === "clear_queue");
      const abortIndex = scripted.commands.findIndex((command) => command.type === "abort");
      expect(clearIndex).toBeGreaterThanOrEqual(0);
      expect(abortIndex).toBe(clearIndex + 1);
      await expect(adapter.clone(bound)).resolves.toMatchObject({ opaqueRef: expect.stringContaining("clone-native") });
    } finally {
      await adapter.dispose();
    }
  });

  it("fails closed when native queue clearing returns a malformed acknowledgement", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-clear-queue-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-clear-queue-workspace-"));
    let scripted!: ScriptedPiProcess;
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-clear-queue-test",
      processFactory: (spec) => {
        scripted = new ScriptedPiProcess(spec, {
          clearQueueResponseData: { steering: [], followUp: [42] }
        });
        return scripted as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-clear-queue",
      backendId: "pi",
      displayName: "Clear queue validation",
      workspaceRoot: workspace,
      managed: true,
      trusted: true
    };
    const context = makeContext(target, []);
    try {
      const binding = await adapter.createSession({ target, fastMode: false, permissionMode: "ask" }, context);
      await expect(adapter.abort({ ...context, binding })).rejects.toMatchObject({
        publicError: { code: "PI_CLEAR_QUEUE_RESPONSE_INVALID", stateMayHaveChanged: true }
      });
      expect(scripted.commands.map((command) => command.type)).toContain("clear_queue");
      expect(scripted.commands.map((command) => command.type)).not.toContain("abort");
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("classifies a silent prompt acceptance timeout without relying on error copy", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-prompt-deadline-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-prompt-deadline-workspace-"));
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      requestTimeoutMs: 15,
      versionProbe: async () => "pi 99.99.99-prompt-deadline-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      processFactory: (spec) => new ScriptedPiProcess(spec, {
        holdAgentLifecycle: true,
        omitResponsesFor: ["prompt"]
      }) as unknown as PiProcessHandle
    });
    const target: TargetDescriptor = {
      id: "target-prompt-deadline",
      backendId: "pi",
      displayName: "Prompt deadline",
      workspaceRoot: workspace,
      managed: true,
      trusted: true
    };
    const context = makeContext(target, []);
    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      await expect(adapter.send(
        { text: "silent acceptance", images: [], files: [], mentions: [], disposition: "prompt" },
        { ...context, binding }
      )).rejects.toMatchObject({
        publicError: {
          code: "PI_PROMPT_ACCEPTANCE_TIMEOUT",
          stateMayHaveChanged: true
        }
      });
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("orders native Session mutations and preserves every concurrent control update", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-session-order-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-session-order-workspace-"));
    let sourceProcess!: ScriptedPiProcess;
    let spec!: PiProcessSpec;
    const processes: ScriptedPiProcess[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-session-order-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [
          { id: "test-model", contextWindow: 32_768, maxTokens: 4_096 },
          { id: "next-model", contextWindow: 32_768, maxTokens: 4_096 }
        ]
      }],
      processFactory: (processSpec) => {
        const process = new ScriptedPiProcess(processSpec, {
          responseDelayMsByCommand: processes.length === 0 ? { set_model: 80 } : { fork: 50 }
        });
        processes.push(process);
        if (processes.length === 1) {
          sourceProcess = process;
          spec = processSpec;
        }
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-session-order",
      backendId: "pi",
      displayName: "Session order",
      workspaceRoot: workspace,
      managed: true,
      trusted: true
    };
    const context = makeContext(target, []);
    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      const bound = { ...context, binding };

      const switching = adapter.setModel("local", "next-model", bound);
      await vi.waitFor(() => {
        expect(sourceProcess.commands.some((command) => command.type === "set_model")).toBe(true);
      });
      const prompting = adapter.send({
        text: "accepted only after the model switch",
        images: [],
        files: [],
        mentions: [],
        disposition: "prompt"
      }, bound);
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(sourceProcess.commands.some((command) => command.type === "prompt")).toBe(false);
      await switching;
      await prompting;

      await Promise.all([
        adapter.setPermissionMode("auto", bound),
        adapter.setPlanMode(true, bound),
        adapter.setExtraDirectories([], bound)
      ]);
      await expect(readFile(String(spec.env.JOKO_PI_CONTROL_FILE), "utf8").then(JSON.parse)).resolves.toMatchObject({
        policyGeneration: 4,
        permissionMode: "auto",
        planMode: true,
        approvedRoots: []
      });

      const rejected = adapter.setEffort("unsupported", bound);
      const recovered = adapter.setPermissionMode("ask", bound);
      await expect(rejected).rejects.toMatchObject({ publicError: { code: "PI_THINKING_LEVEL_UNAVAILABLE" } });
      await expect(recovered).resolves.toBeUndefined();
      await expect(readFile(String(spec.env.JOKO_PI_CONTROL_FILE), "utf8").then(JSON.parse)).resolves.toMatchObject({
        policyGeneration: 5,
        permissionMode: "ask",
        planMode: true
      });

      const deriving = adapter.fork("entry-1", bound);
      await vi.waitFor(() => {
        expect(processes[1]?.commands.some((command) => command.type === "fork")).toBe(true);
      });
      const staleControl = adapter.setPermissionMode("auto", bound);
      const sourceControlApplied = expect(staleControl).resolves.toBeUndefined();
      const forked = await deriving;
      await sourceControlApplied;
      expect(sourceProcess.commands.some((command) => command.type === "fork" || command.type === "abort")).toBe(false);
      expect(sourceProcess.signalCode).toBeNull();
      expect(processes[1]?.signalCode).toBe("SIGTERM");
      expect(new Set(processes.map((process) => process.spec.env.JOKO_PI_CONTROL_FILE)).size).toBe(2);
      expect(forked.binding.opaqueRef).not.toBe(binding.opaqueRef);
      await expect(adapter.setPermissionMode("auto", { ...bound, binding: forked.binding })).rejects.toMatchObject({
        publicError: { code: "PI_SESSION_BINDING_MISMATCH" }
      });
      await expect(adapter.getState(bound)).resolves.toMatchObject({ sessionFile: binding.opaqueRef });
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("retires a runtime when model-switch acknowledgement is lost", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-model-unknown-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-model-unknown-workspace-"));
    let process!: ScriptedPiProcess;
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      requestTimeoutMs: 15,
      versionProbe: async () => "pi 99.99.99-model-unknown-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [
          { id: "test-model", contextWindow: 32_768, maxTokens: 4_096 },
          { id: "next-model", contextWindow: 32_768, maxTokens: 4_096 }
        ]
      }],
      processFactory: (spec) => {
        process = new ScriptedPiProcess(spec, { omitResponsesFor: ["set_model"] });
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-model-unknown",
      backendId: "pi",
      displayName: "Model acknowledgement",
      workspaceRoot: workspace,
      managed: true,
      trusted: true
    };
    const context = makeContext(target, []);
    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      const bound = { ...context, binding };

      await expect(adapter.setModel("local", "next-model", bound)).rejects.toMatchObject({
        publicError: {
          code: "PI_MODEL_SWITCH_UNCONFIRMED",
          retryable: true,
          stateMayHaveChanged: true
        }
      });
      expect(process.commands.some((command) => command.type === "set_model")).toBe(true);
      expect(process.signalCode).toBe("SIGTERM");
      await expect(adapter.setPermissionMode("auto", bound)).rejects.toMatchObject({
        publicError: { code: "PI_RUNTIME_NOT_ACTIVE" }
      });
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("drops malformed native tree nodes without discarding valid siblings", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-tree-normalization-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-tree-normalization-workspace-"));
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-tree-normalization-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      processFactory: (spec) => new ScriptedPiProcess(spec, {
        tree: [
          { entry: { type: "message" }, children: [] },
          {
            entry: {
              id: "valid-root",
              parentId: null,
              type: "message",
              timestamp: new Date(0).toISOString(),
              message: { role: "user", content: [{ type: "text", text: "valid" }] }
            },
            children: [
              { entry: null, children: [] },
              { entry: { id: "valid-child", parentId: "valid-root" }, children: "invalid" }
            ]
          }
        ]
      }) as unknown as PiProcessHandle
    });
    const target: TargetDescriptor = {
      id: "target-tree-normalization",
      backendId: "pi",
      displayName: "Tree normalization",
      workspaceRoot: workspace,
      managed: true,
      trusted: true
    };
    const context = makeContext(target, []);
    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      await expect(adapter.getTree({ ...context, binding })).resolves.toEqual({
        leafId: "entry-1",
        roots: [{
          entryId: "valid-root",
          parentId: undefined,
          kind: "message",
          role: "user",
          label: "valid",
          timestamp: 0,
          children: [{
            entryId: "valid-child",
            parentId: "valid-root",
            kind: "other",
            label: undefined,
            timestamp: 0,
            children: []
          }]
        }]
      });
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("projects a deeply nested native tree without exhausting the JavaScript call stack", async () => {
    const depth = 12_000;
    let nested: Record<string, unknown> | undefined;
    for (let index = depth - 1; index >= 0; index -= 1) {
      nested = {
        entry: {
          id: `entry-${index}`,
          parentId: index === 0 ? null : `entry-${index - 1}`,
          type: "message",
          timestamp: new Date(index).toISOString(),
          message: { role: "user", content: [{ type: "text", text: `message-${index}` }] }
        },
        children: nested === undefined ? [] : [nested]
      };
    }
    const roots = projectPiTreeNodes([nested!], []);
    let node = roots[0];
    let projected = 0;
    while (node !== undefined) {
      projected += 1;
      node = node.children[0];
    }
    expect(projected).toBe(depth);
    expect(roots[0]?.entryId).toBe("entry-0");
  });

  it("routes expanded and duplicate queued inputs by accepted queue order instead of message text", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-ordered-continuation-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-ordered-continuation-workspace-"));
    let scripted!: ScriptedPiProcess;
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-ordered-continuation-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      processFactory: (spec) => {
        scripted = new ScriptedPiProcess(spec, {
          holdAgentLifecycle: true,
          echoQueuedUserMessages: true,
          queuedUserMessageTransform: (command) => command.type === "prompt"
            ? String(command.message)
            : `<expanded-resource>\n${String(command.message)}`
        });
        return scripted as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-ordered-continuation",
      backendId: "pi",
      displayName: "Ordered continuation",
      workspaceRoot: workspace,
      managed: true,
      trusted: true
    };
    const ownerEvents: EventPayload[] = [];
    const steerEvents: EventPayload[] = [];
    const followUpEvents: EventPayload[] = [];
    const owner = makeContext(target, ownerEvents);
    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, owner);
      const shared = { sessionId: owner.sessionId, binding };
      await adapter.send({ text: "initial", images: [], files: [], mentions: [], disposition: "prompt" }, { ...owner, ...shared });
      await adapter.send({ text: "/skill:inspect repeated", images: [], files: [], mentions: [], disposition: "steer" }, { ...makeContext(target, steerEvents), ...shared });
      await adapter.send({ text: "/skill:inspect repeated", images: [], files: [], mentions: [], disposition: "follow_up" }, { ...makeContext(target, followUpEvents), ...shared });

      scripted.emitAssistant("follow-up-owned-output");
      scripted.settle();
      await vi.waitFor(() => expect(followUpEvents.some((event) => event.type === "text_delta")).toBe(true));
      expect(followUpEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text_delta", delta: "follow-up-owned-output" }),
        expect.objectContaining({ type: "done", outcome: "completed" })
      ]));
      expect(steerEvents.some((event) => event.type === "text_delta")).toBe(false);
      expect(ownerEvents.some((event) => event.type === "text_delta")).toBe(false);
    } finally {
      await adapter.dispose();
    }
  });

  it("starts a fresh reviewer with only the policy bridge and rejects every mutable or history-bearing operation", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-review-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-review-workspace-"));
    const specs: PiProcessSpec[] = [];
    const processes: ScriptedPiProcess[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.1.0-review",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      mcpBridge: { endpoint: "http://127.0.0.1:4318/internal/mcp", token: "must-not-enter-review", tools: [] },
      processFactory: (spec) => {
        specs.push(spec);
        const process = new ScriptedPiProcess(spec);
        processes.push(process);
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-review",
      backendId: "pi",
      displayName: "Review",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    };
    const context: AdapterContext = {
      ...makeContext(target, []),
      sessionId: "reviewer-session",
      runtimePolicy: "review_read_only",
      extraDirectories: []
    };
    const binding = await adapter.createSession({
      target,
      providerId: "local",
      modelId: "test-model",
      effort: "medium",
      fastMode: false,
      permissionMode: "ask",
      nativeStart: { kind: "new" },
      runtimePolicy: "review_read_only"
    }, context);
    const bound = { ...context, binding };
    const spec = specs[0]!;
    expect(spec.args).toEqual(expect.arrayContaining(["--no-extensions", "--no-skills", "--no-prompt-templates", "--offline"]));
    expect(valuesForArgument(spec.args, "--extension").map((path) => path.split(/[\\/]/u).at(-1)))
      .toEqual(["joko-managed-silent-encrypted-retry.ts", "joko-managed-bridge.ts"]);
    expect(valuesForArgument(spec.args, "--skill")).toEqual([]);
    expect(valuesForArgument(spec.args, "--prompt-template")).toEqual([]);
    expect(spec.env.JOKO_PI_MCP_DESCRIPTOR_FILE).toBeUndefined();
    expect(spec.env.JOKO_PI_MCP_TOKEN).toBeUndefined();
    expect(spec.env.JOKO_PI_RUNTIME_POLICY).toBe("review_read_only");
    expect(JSON.parse(await readFile(String(spec.env.JOKO_PI_CONTROL_FILE), "utf8")))
      .toMatchObject({ runtimePolicy: "review_read_only", permissionMode: "ask", planMode: false, fastMode: false });

    await expect(adapter.createSession({
      target,
      name: "mutable reviewer",
      fastMode: false,
      permissionMode: "ask",
      nativeStart: { kind: "new" },
      runtimePolicy: "review_read_only"
    }, { ...context, sessionId: "invalid-reviewer" }))
      .rejects.toMatchObject({ publicError: { code: "PI_REVIEW_PROFILE_INVALID" } });
    expect(specs).toHaveLength(1);

    await expect(adapter.inspectSession(binding, bound)).resolves.toMatchObject({ modelId: "test-model" });
    expect(processes[0]!.commands.some((command) => command.type === "get_tree")).toBe(false);
    await expect(adapter.getCommands(bound)).resolves.toEqual([]);
    await expect(adapter.getResources(bound)).resolves.toEqual([]);
    await expect(adapter.setPermissionMode("auto", bound)).rejects.toMatchObject({ publicError: { code: "PI_REVIEW_POLICY_IMMUTABLE" } });
    await expect(adapter.setPlanMode(true, bound)).rejects.toMatchObject({ publicError: { code: "PI_REVIEW_POLICY_IMMUTABLE" } });
    await expect(adapter.setModel("local", "test-model", bound)).rejects.toMatchObject({ publicError: { code: "PI_REVIEW_OPERATION_DENIED" } });
    await expect(adapter.setAutoCompaction(true, bound)).rejects.toMatchObject({ publicError: { code: "PI_REVIEW_OPERATION_DENIED" } });
    await expect(adapter.executeUserShell({ command: "pwd", excludeFromContext: true }, bound))
      .rejects.toMatchObject({ publicError: { code: "PI_REVIEW_OPERATION_DENIED" } });
    await expect(adapter.getTree(bound)).rejects.toMatchObject({ publicError: { code: "PI_REVIEW_OPERATION_DENIED" } });
    await expect(adapter.getNativeHistoryProjection(bound)).rejects.toMatchObject({ publicError: { code: "PI_REVIEW_OPERATION_DENIED" } });
    await adapter.dispose();
  });

  it("rebuilds deletion context through a fresh supported Pi session without editing the old JSONL", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-context-rebuild-home-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "joko-pi-context-rebuild-workspace-"));
    let scripted!: ScriptedPiProcess;
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-context-rebuild-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model" }]
      }],
      processFactory: (spec) => {
        scripted = new ScriptedPiProcess(spec, { synchronousExtensionCommand: "joko-rebuild-context" });
        return scripted as unknown as PiProcessHandle;
      }
    });
    expect((await adapter.describe()).capabilities.get("session.message_delete")).toMatchObject({ supported: true });
    const target: TargetDescriptor = {
      id: "target-context-rebuild",
      backendId: "pi",
      displayName: "Context rebuild",
      workspaceRoot,
      managed: true,
      trusted: true
    };
    const events: EventPayload[] = [];
    const context = makeContext(target, events);
    const binding = await adapter.createSession(
      { target, providerId: "local", modelId: "test-model", fastMode: false, permissionMode: "ask" },
      context
    );
    await writeDurableSubagentControlFixture(agentHome, context.sessionId, context.generation, "rebuild-owned:1", "completed");
    const durableSessionDirectory = join(agentHome, "subagent-runs", managedSubagentSessionKey(context.sessionId));
    await expect(access(durableSessionDirectory)).resolves.toBeUndefined();
    const beforeEvents = events.length;
    const rebuilt = await adapter.rebuildContext({
      reason: "message_deletion",
      handoff: [
        "[JOKO SAFE CONTEXT HANDOFF]",
        "Continue from the surviving visible conversation below. A user explicitly deleted content; do not infer or restore omitted messages.",
        "<user>",
        "surviving request with sk-abcdefghijklmnop",
        "<assistant>",
        "surviving answer"
      ].join("\n"),
      messages: [
        {
          role: "user",
          blocks: [
            { kind: "text", text: "surviving request with sk-abcdefghijklmnop" },
            { kind: "tool_call", callId: "private-call", name: "bash", input: "complete private execution plan" }
          ]
        },
        {
          role: "assistant",
          blocks: [
            { kind: "text", text: "surviving answer" },
            { kind: "thinking", text: "private chain of thought", redacted: false }
          ]
        }
      ]
    }, { ...context, binding });

    expect(rebuilt).toMatchObject({
      nativeSessionId: "context-rebuild-native",
      generation: binding.generation + 1
    });
    expect(rebuilt.opaqueRef).not.toBe(binding.opaqueRef);
    await expect(access(binding.opaqueRef)).resolves.toBeUndefined();
    await expect(access(rebuilt.opaqueRef)).resolves.toBeUndefined();
    const command = scripted.commands.find((candidate) =>
      candidate.type === "prompt" && String(candidate.message).startsWith("/joko-rebuild-context "));
    expect(command).toBeDefined();
    const encoded = String(command!.message).slice("/joko-rebuild-context ".length);
    const descriptor = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      format: number;
      fileName: string;
      byteLength: number;
      sha256: string;
    };
    expect(descriptor).toMatchObject({ format: 1, byteLength: Buffer.byteLength(scripted.contextRebuildHandoff!, "utf8") });
    expect(scripted.contextRebuildHandoff).toContain("surviving request");
    expect(scripted.contextRebuildHandoff).toContain("surviving answer");
    expect(scripted.contextRebuildHandoff).not.toContain("sk-abcdefghijklmnop");
    expect(scripted.contextRebuildHandoff).not.toContain("complete private execution plan");
    expect(scripted.contextRebuildHandoff).not.toContain("private chain of thought");
    expect(events.slice(beforeEvents).some((event) => event.type === "native_session_changed")).toBe(false);
    await expect(access(durableSessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    const transcriptCountAfterRebuild = events.filter((event) => event.type === "subagent_transcript").length;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
    expect(events.filter((event) => event.type === "subagent_transcript")).toHaveLength(transcriptCountAfterRebuild);
    expect(scripted.exitCode).toBe(0);
    await adapter.dispose();
  });

  it("rebuilds a context handoff larger than 512 KiB and rejects capacity plus one before materialization", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-large-context-rebuild-home-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "joko-pi-large-context-rebuild-workspace-"));
    const processes: ScriptedPiProcess[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-large-context-rebuild-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model" }]
      }],
      processFactory: (spec) => {
        const process = new ScriptedPiProcess(spec, { synchronousExtensionCommand: "joko-rebuild-context" });
        processes.push(process);
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-large-context-rebuild",
      backendId: "pi",
      displayName: "Large context rebuild",
      workspaceRoot,
      managed: true,
      trusted: true
    };
    const context = makeContext(target, []);
    const binding = await adapter.createSession(
      { target, providerId: "local", modelId: "test-model", fastMode: false, permissionMode: "ask" },
      context
    );
    const handoff = `  [JOKO SAFE CONTEXT HANDOFF]\n${"x".repeat(512 * 1024 + 1)}  `;
    const rebuilt = await adapter.rebuildContext({
      reason: "message_deletion",
      handoff,
      messages: []
    }, { ...context, binding });

    expect(processes).toHaveLength(2);
    expect(processes[1]?.contextRebuildHandoff).toBe(handoff);
    const command = processes[1]?.commands.find((candidate) =>
      candidate.type === "prompt" && String(candidate.message).startsWith("/joko-rebuild-context "));
    const encoded = String(command?.message).slice("/joko-rebuild-context ".length);
    expect(encoded.length).toBeLessThan(4_096);
    const descriptor = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { fileName: string };
    await expect(access(join(String(processes[1]?.spec.env.TEMP), descriptor.fileName))).rejects.toMatchObject({ code: "ENOENT" });

    const processCount = processes.length;
    await expect(adapter.rebuildContext({
      reason: "context_overflow",
      handoff: "y".repeat(1_025),
      messages: []
    }, {
      ...context,
      generation: rebuilt.generation,
      binding: rebuilt,
      artifactCapacityBytes: 1_024
    })).rejects.toMatchObject({
      publicError: {
        code: "PI_CONTEXT_REBUILD_HANDOFF_CAPACITY_EXCEEDED",
        phase: "resource"
      }
    });
    expect(processes).toHaveLength(processCount);
    await adapter.dispose();
  });

  it("retires an unhealthy runtime without inspecting or resuming its native context", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-unhealthy-context-home-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "joko-unhealthy-context-workspace-"));
    const processes: ScriptedPiProcess[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-unhealthy-context-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model" }]
      }],
      processFactory: (spec) => {
        const process = new ScriptedPiProcess(spec, { synchronousExtensionCommand: "joko-rebuild-context" });
        processes.push(process);
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-unhealthy-context",
      backendId: "pi",
      displayName: "Unhealthy context",
      workspaceRoot,
      managed: true,
      trusted: true
    };
    const context = makeContext(target, []);
    const binding = await adapter.createSession(
      { target, providerId: "local", modelId: "test-model", fastMode: false, permissionMode: "ask" },
      context
    );
    const previousGenerationRuntime = processes[0]!;
    const previousGenerationStateRequests = previousGenerationRuntime.commands.filter((command) => command.type === "get_state").length;
    const rebuilt = await adapter.rebuildContext({
      reason: "context_overflow",
      handoff: "[JOKO SAFE CONTEXT HANDOFF]\nOnly surviving context.",
      messages: []
    }, { ...context, binding });

    expect(processes).toHaveLength(2);
    expect(previousGenerationRuntime.exitCode).toBe(0);
    expect(previousGenerationRuntime.commands.filter((command) => command.type === "get_state")).toHaveLength(previousGenerationStateRequests);
    expect(previousGenerationRuntime.commands.some((command) => command.type === "prompt" &&
      String(command.message).startsWith("/joko-rebuild-context "))).toBe(false);
    expect(processes[1]!.commands.some((command) => command.type === "prompt" &&
      String(command.message).startsWith("/joko-rebuild-context "))).toBe(true);
    expect(argument(processes[1]!.spec.args, "--session-id"))
      .not.toBe(argument(previousGenerationRuntime.spec.args, "--session-id"));
    expect(rebuilt).toMatchObject({
      nativeSessionId: "context-rebuild-native",
      generation: binding.generation + 1
    });
    await adapter.dispose();
  });

  it("resets context through a fresh empty Pi session without a handoff payload", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-context-reset-home-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "joko-pi-context-reset-workspace-"));
    let scripted!: ScriptedPiProcess;
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-context-reset-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model" }]
      }],
      processFactory: (spec) => {
        scripted = new ScriptedPiProcess(spec, { synchronousExtensionCommand: "joko-reset-context" });
        return scripted as unknown as PiProcessHandle;
      }
    });
    expect((await adapter.describe()).capabilities.get("session.reset")).toMatchObject({ supported: true });
    const target: TargetDescriptor = {
      id: "target-context-reset",
      backendId: "pi",
      displayName: "Context reset",
      workspaceRoot,
      managed: true,
      trusted: true
    };
    const events: EventPayload[] = [];
    const context = makeContext(target, events);
    const binding = await adapter.createSession(
      { target, providerId: "local", modelId: "test-model", fastMode: false, permissionMode: "ask" },
      context
    );
    await writeDurableSubagentControlFixture(agentHome, context.sessionId, context.generation, "reset-owned:1", "completed");
    const durableSessionDirectory = join(agentHome, "subagent-runs", managedSubagentSessionKey(context.sessionId));
    const reset = await adapter.resetContext({ ...context, binding });

    expect(reset).toMatchObject({
      nativeSessionId: "context-reset-native",
      generation: binding.generation + 1
    });
    expect(reset.opaqueRef).not.toBe(binding.opaqueRef);
    const command = scripted.commands.find((candidate) =>
      candidate.type === "prompt" && candidate.message === "/joko-reset-context");
    expect(command).toBeDefined();
    expect(String(command!.message)).not.toContain(" ");
    await expect(access(durableSessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    const transcriptCountAfterReset = events.filter((event) => event.type === "subagent_transcript").length;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
    expect(events.filter((event) => event.type === "subagent_transcript")).toHaveLength(transcriptCountAfterReset);
    expect(scripted.exitCode).toBe(0);
    await adapter.dispose();
  });

  it("projects each model's Pi thinking metadata without leaking the current model's RPC levels", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-thinking-levels-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-thinking-levels-workspace-"));
    const commonModel = {
      name: "Thinking model",
      api: "openai-responses",
      input: ["text"],
      contextWindow: 32_768,
      maxTokens: 4_096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    };
    let scripted!: ScriptedPiProcess;
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-thinking-level-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", reasoning: true, contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      processFactory: (spec) => {
        scripted = new ScriptedPiProcess(spec, {
          availableThinkingLevels: ["max", "future", "off", "high", "off"],
          availableModels: [
            {
              ...commonModel,
              provider: "local",
              id: "test-model",
              reasoning: true,
              thinkingLevelMap: { off: null, low: "low" }
            },
            { ...commonModel, provider: "remote", id: "test-model", reasoning: true },
            {
              ...commonModel,
              provider: "remote",
              id: "mapped",
              reasoning: true,
              thinkingLevelMap: {
                off: null,
                minimal: "minimal",
                low: null,
                medium: null,
                high: "high",
                xhigh: "xhigh",
                max: null,
                future: "future"
              }
            },
            {
              ...commonModel,
              provider: "remote",
              id: "plain",
              reasoning: false,
              thinkingLevelMap: { xhigh: "xhigh", max: "max", future: "future" }
            }
          ]
        });
        return scripted as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-thinking-levels",
      backendId: "pi",
      displayName: "Thinking levels",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    };
    const context = makeContext(target, []);

    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      const stateRequestsBefore = scripted.commands.filter((command) => command.type === "get_state").length;
      const models = await adapter.getAvailableModels({ ...context, binding });
      const byIdentity = Object.fromEntries(models.map((model) => [`${model.providerId}/${model.modelId}`, model.thinkingLevels]));

      expect(byIdentity).toEqual({
        "local/test-model": ["off", "high", "max"],
        "remote/test-model": ["off", "minimal", "low", "medium", "high"],
        "remote/mapped": ["minimal", "high", "xhigh"],
        "remote/plain": []
      });
      expect(scripted.commands.filter((command) => command.type === "get_state")).toHaveLength(stateRequestsBefore + 2);
    } finally {
      await adapter.dispose();
    }
  });

  it("projects real ID-less Pi AgentMessages with stable bounded non-native identities", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-message-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-message-workspace-"));
    const secret = "adapter-owned-secret-value";
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.1.0",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32768, maxTokens: 4096 }]
      }],
      mcpBridge: { endpoint: "http://127.0.0.1:4040", token: secret, tools: [] },
      processFactory: (spec) => new ScriptedPiProcess(spec, {
        messages: [
          { role: "user", content: `keep ${secret} hidden`, timestamp: 1 },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: `reason ${secret}` },
              { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md", apiKey: secret } },
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
              { type: "text", text: "x".repeat(70_000) }
            ],
            usage: {
              input: 3,
              output: 4,
              cacheRead: 1,
              cacheWrite: 2,
              totalTokens: 10,
              cost: { total: 0.000123 }
            },
            timestamp: 2
          },
          { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: 3 },
          { role: "custom", customType: "notice", content: "extension note", display: true, timestamp: 4 },
          { role: "bashExecution", command: `echo ${secret}`, output: "shell output", exitCode: 0, cancelled: false, timestamp: 5 },
          { role: "branchSummary", summary: "branch summary", fromId: "entry-1", timestamp: 6 },
          { role: "compactionSummary", summary: "compaction summary", tokensBefore: 100, timestamp: 7 }
        ]
      }) as unknown as PiProcessHandle
    });
    const target: TargetDescriptor = {
      id: "target-message-projection",
      backendId: "pi",
      displayName: "Message projection",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    };
    const context = makeContext(target, []);

    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      const boundContext = { ...context, binding };
      const first = await adapter.getMessages(boundContext);
      const second = await adapter.getMessages(boundContext);

      expect(first.map((message) => message.role)).toEqual([
        "user", "assistant", "toolResult", "custom", "custom", "custom", "custom"
      ]);
      expect(first.map((message) => message.id)).toEqual(second.map((message) => message.id));
      expect(new Set(first.map((message) => message.id)).size).toBe(first.length);
      expect(first.every((message) => message.id.startsWith("joko:pi-message:"))).toBe(true);
      expect(first[1]?.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "toolCall", arguments: { path: "\"README.md\"", apiKey: "[REDACTED]" } }),
        expect.objectContaining({ type: "text", text: "x".repeat(70_000) })
      ]));
      expect(first[1]?.usage).toMatchObject({ totalTokens: 10, costMicros: 123 });
      expect(JSON.stringify(first)).not.toContain(secret);
      expect(first[1]?.content).toContainEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
      expect(first[2]).toMatchObject({ toolCallId: "call-1", toolName: "read", isError: false });
    } finally {
      await adapter.dispose();
    }
  });

  it("projects every message, part, and tool argument across the former native panel boundaries", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-complete-message-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-complete-message-workspace-"));
    const secret = "managed-panel-secret-value";
    const longText = "t".repeat(65_537);
    const longArgument = "a".repeat(4_097);
    const arguments_ = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [
      index === 0 ? "apiKey" : index === 1 ? `key-${secret}` : index === 2 ? "key-[REDACTED]" : `argument-${index}`,
      index === 0 ? secret : index === 64 ? longArgument : `value-${index}`
    ]));
    const finalParts = [
      { type: "text", text: longText },
      ...Array.from({ length: 127 }, (_, index) => ({ type: "text", text: `part-${index + 1}` })),
      { type: "toolCall", id: "complete-call", name: "complete_tool", arguments: arguments_ }
    ];
    const messages = [
      ...Array.from({ length: 9_999 }, (_, index) => ({ role: "user", content: `message-${index}`, timestamp: index })),
      { role: "bashExecution", command: "  printf value  ", output: "  first\nlast  \n", exitCode: 0, cancelled: false, timestamp: 9_999 },
      { role: "assistant", content: finalParts, timestamp: 10_000 }
    ];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.1.0-complete-panel",
      mcpBridge: { endpoint: "http://127.0.0.1:4040", token: secret, tools: [] },
      processFactory: (spec) => new ScriptedPiProcess(spec, { messages }) as unknown as PiProcessHandle
    });
    const target: TargetDescriptor = {
      id: "target-complete-message-projection",
      backendId: "pi",
      displayName: "Complete messages",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    };
    const context = makeContext(target, []);

    try {
      const binding = await adapter.createSession({ target, fastMode: false, permissionMode: "ask" }, context);
      const projected = await adapter.getMessages({ ...context, binding });
      const repeated = await adapter.getMessages({ ...context, binding });
      expect(projected).toHaveLength(10_001);
      expect(repeated.map((message) => message.id)).toEqual(projected.map((message) => message.id));
      expect(projected[9_999]?.content).toEqual([{ type: "text", text: "$   printf value  \n  first\nlast  \n" }]);
      expect(projected[10_000]?.content).toHaveLength(129);
      expect(projected[10_000]?.content[0]).toEqual({ type: "text", text: longText });
      const toolCall = projected[10_000]?.content[128];
      expect(toolCall).toMatchObject({ type: "toolCall", id: "complete-call", name: "complete_tool" });
      if (toolCall?.type !== "toolCall") throw new Error("Expected the final projected tool call.");
      expect(Object.keys(toolCall.arguments)).toHaveLength(65);
      expect(toolCall.arguments["apiKey"]).toBe("[REDACTED]");
      expect(toolCall.arguments["argument-64"]).toBe(JSON.stringify(longArgument));
      expect(Object.keys(toolCall.arguments).filter((key) => key.startsWith("key-[REDACTED]"))).toHaveLength(2);
      expect(JSON.stringify(projected)).not.toContain(secret);
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("exact-redacts managed credentials before entries and fork candidates cross the Adapter boundary", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-entry-redaction-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-entry-redaction-workspace-"));
    const secret = "non-pattern-entry-managed-secret";
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.1.0-entry-redaction",
      mcpBridge: { endpoint: "http://127.0.0.1:4040", token: secret, tools: [] },
      processFactory: (spec) => new ScriptedPiProcess(spec, {
        historyEntries: [{
          id: "custom-entry",
          parentId: null,
          type: "custom",
          timestamp: new Date(0).toISOString(),
          customType: "redaction-fixture",
          payload: {
            text: `custom ${secret}`,
            toolArguments: { query: `lookup ${secret}` },
            nested: [{ summary: `summary ${secret}` }]
          }
        }],
        historyLeafId: "custom-entry",
        forkMessages: [{ entryId: "custom-entry", text: `fork ${secret}` }]
      }) as unknown as PiProcessHandle
    });
    const target: TargetDescriptor = {
      id: "target-entry-redaction",
      backendId: "pi",
      displayName: "Entry redaction",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    };
    const context = makeContext(target, []);

    try {
      const binding = await adapter.createSession({ target, fastMode: false, permissionMode: "ask" }, context);
      const bound = { ...context, binding };
      const entries = await adapter.getEntries(undefined, bound);
      const forks = await adapter.getForkMessages(bound);
      expect(JSON.stringify({ entries, forks })).not.toContain(secret);
      expect(entries.entries[0]).toMatchObject({
        payload: {
          text: "custom [REDACTED]",
          toolArguments: { query: "lookup [REDACTED]" },
          nested: [{ summary: "summary [REDACTED]" }]
        }
      });
      expect(forks).toEqual([{ entryId: "custom-entry", text: "fork [REDACTED]" }]);
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("strictly validates and preserves the complete successful get_entries history surface", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-invalid-entries-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-invalid-entries-workspace-"));
    const currentUsage = {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 10,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 }
    };
    const validEntry = {
      id: "stable-entry",
      parentId: null,
      type: "message",
      timestamp: new Date(0).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "stable" }], timestamp: 0 }
    };
    let historyResponseData: unknown = { entries: [validEntry], leafId: "stable-entry" };
    const scriptedOptions: ScriptedPiProcessOptions = {
      get historyResponseData() {
        return historyResponseData;
      }
    };
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.1.0-invalid-entries",
      processFactory: (spec) => new ScriptedPiProcess(spec, scriptedOptions) as unknown as PiProcessHandle
    });
    const target: TargetDescriptor = {
      id: "target-invalid-entries",
      backendId: "pi",
      displayName: "Invalid entries",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    };
    const context = makeContext(target, []);

    try {
      const binding = await adapter.createSession({ target, fastMode: false, permissionMode: "ask" }, context);
      const bound = { ...context, binding };
      const knownPayloadInvalidEntries = [
        { type: "message" },
        { type: "message", message: { role: "user", content: "missing message timestamp" } },
        { type: "message", message: { role: "user", content: null, timestamp: 1 } },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [],
            api: "test-api",
            provider: "test-provider",
            model: "test-model",
            usage: { input: 1, cacheRead: 0, cacheWrite: 0 },
            stopReason: "stop",
            timestamp: 1
          }
        },
        { type: "thinking_level_change" },
        { type: "model_change", provider: "provider-only" },
        { type: "compaction", summary: "summary", firstKeptEntryId: "kept" },
        {
          type: "compaction",
          summary: "summary",
          firstKeptEntryId: "kept",
          tokensBefore: 10,
          usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }
        },
        { type: "branch_summary", summary: "summary" },
        { type: "custom" },
        { type: "custom_message", customType: "notice", content: "text" },
        { type: "label", label: "bookmark" },
        { type: "session_info", name: 42 }
      ].map((payload, index) => ({
        id: `known-invalid-${index}`,
        parentId: null,
        timestamp: new Date(index + 1).toISOString(),
        ...payload
      }));
      const invalidResponses: readonly unknown[] = [
        undefined,
        { entries: "not-an-array", leafId: null },
        { entries: [], leafId: 42 },
        { entries: [{ id: "partial", parentId: null, type: "message" }], leafId: "partial" },
        { entries: [{ ...validEntry, parentId: 42 }], leafId: "stable-entry" },
        { entries: [{ ...validEntry, timestamp: "not-a-timestamp" }], leafId: "stable-entry" },
        { entries: [validEntry, { ...validEntry }], leafId: "stable-entry" },
        ...knownPayloadInvalidEntries.map((entry) => ({ entries: [entry], leafId: entry.id }))
      ];
      for (const invalid of invalidResponses) {
        historyResponseData = invalid;
        await expect(adapter.getEntries(undefined, bound)).rejects.toMatchObject({
          publicError: {
            code: "PI_ENTRIES_INVALID_RESPONSE",
            phase: "session",
            retryable: false,
            stateMayHaveChanged: false
          }
        });
        await expect(adapter.getNativeHistoryProjection(bound)).rejects.toMatchObject({
          publicError: {
            code: "PI_ENTRIES_INVALID_RESPONSE",
            phase: "session",
            retryable: false,
            stateMayHaveChanged: false
          }
        });
      }

      const knownValidEntries = [
        validEntry,
        {
          id: "known-message-assistant",
          parentId: null,
          type: "message",
          timestamp: new Date(2).toISOString(),
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "answer" },
              { type: "thinking", thinking: "reason" },
              { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }
            ],
            api: "test-api",
            provider: "test-provider",
            model: "test-model",
            usage: currentUsage,
            stopReason: "toolUse",
            timestamp: 2
          }
        },
        {
          id: "known-message-tool-result",
          parentId: null,
          type: "message",
          timestamp: new Date(3).toISOString(),
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text: "result" }],
            usage: currentUsage,
            isError: false,
            timestamp: 3
          }
        },
        {
          id: "known-message-bash",
          parentId: null,
          type: "message",
          timestamp: new Date(4).toISOString(),
          message: {
            role: "bashExecution",
            command: "pwd",
            output: "workspace",
            exitCode: 0,
            cancelled: false,
            truncated: false,
            timestamp: 4
          }
        },
        {
          id: "known-message-custom",
          parentId: null,
          type: "message",
          timestamp: new Date(5).toISOString(),
          message: {
            role: "custom",
            customType: "notice",
            content: "extension notice",
            display: true,
            timestamp: 5
          }
        },
        {
          id: "known-message-branch-summary",
          parentId: null,
          type: "message",
          timestamp: new Date(6).toISOString(),
          message: { role: "branchSummary", summary: "branch", fromId: "stable-entry", timestamp: 6 }
        },
        {
          id: "known-message-compaction-summary",
          parentId: null,
          type: "message",
          timestamp: new Date(7).toISOString(),
          message: { role: "compactionSummary", summary: "compact", tokensBefore: 100, timestamp: 7 }
        },
        {
          id: "opaque-message-role",
          parentId: null,
          type: "message",
          timestamp: new Date(8).toISOString(),
          message: { role: "extensionOwnedRole", timestamp: 8, payload: { preserved: true } }
        },
        {
          id: "known-thinking-level",
          parentId: null,
          type: "thinking_level_change",
          timestamp: new Date(9).toISOString(),
          thinkingLevel: "high"
        },
        {
          id: "known-model-change",
          parentId: null,
          type: "model_change",
          timestamp: new Date(10).toISOString(),
          provider: "test-provider",
          modelId: "test-model"
        },
        {
          id: "known-compaction",
          parentId: null,
          type: "compaction",
          timestamp: new Date(11).toISOString(),
          summary: "summary",
          firstKeptEntryId: "stable-entry",
          tokensBefore: 100,
          usage: currentUsage,
          fromHook: false
        },
        {
          id: "known-branch-summary",
          parentId: null,
          type: "branch_summary",
          timestamp: new Date(12).toISOString(),
          fromId: "stable-entry",
          summary: "summary",
          usage: currentUsage,
          fromHook: true
        },
        {
          id: "known-custom",
          parentId: null,
          type: "custom",
          timestamp: new Date(13).toISOString(),
          customType: "extension-state",
          data: { preserved: true }
        },
        {
          id: "known-custom-message",
          parentId: null,
          type: "custom_message",
          timestamp: new Date(14).toISOString(),
          customType: "notice",
          content: [{ type: "text", text: "notice" }],
          display: true
        },
        {
          id: "known-label",
          parentId: null,
          type: "label",
          timestamp: new Date(15).toISOString(),
          targetId: "stable-entry",
          label: "checkpoint"
        },
        {
          id: "known-session-info",
          parentId: null,
          type: "session_info",
          timestamp: new Date(16).toISOString(),
          name: "History matrix"
        }
      ];
      historyResponseData = {
        entries: knownValidEntries,
        leafId: "known-session-info"
      };
      const known = await adapter.getEntries(undefined, bound);
      expect(known.entries.map((entry) => entry.id)).toEqual(knownValidEntries.map((entry) => entry.id));
      expect(known.entries
        .filter((entry) => entry.type === "message")
        .map((entry) => (entry["message"] as { readonly role: string }).role)).toEqual([
          "user",
          "assistant",
          "toolResult",
          "bashExecution",
          "custom",
          "branchSummary",
          "compactionSummary",
          "extensionOwnedRole"
        ]);

      historyResponseData = {
        entries: [{
          id: "opaque-extension-entry",
          parentId: null,
          type: "extension_owned_entry",
          timestamp: new Date(1).toISOString(),
          payload: { preserved: true }
        }],
        leafId: "opaque-extension-entry"
      };
      await expect(adapter.getEntries(undefined, bound)).resolves.toMatchObject({
        entries: [expect.objectContaining({ id: "opaque-extension-entry", type: "extension_owned_entry" })]
      });

      historyResponseData = { entries: [validEntry], leafId: "stable-entry" };
      await expect(adapter.getNativeHistoryProjection(bound)).resolves.toMatchObject({
        activeEntryId: "stable-entry"
      });
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("projects a resumed Pi message image larger than 25 MiB without tripping the runtime record budget", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-large-message-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-large-message-workspace-"));
    const imageData = Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64");
    let scripted!: ScriptedPiProcess;
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.1.0-large-message",
      processFactory: (spec) => {
        scripted = new ScriptedPiProcess(spec, {
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "inspect resumed image" },
              { type: "image", data: imageData, mimeType: "image/png" }
            ],
            timestamp: 1
          }]
        });
        return scripted as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-large-message-projection",
      backendId: "pi",
      displayName: "Large message projection",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    };
    const context = makeContext(target, []);

    try {
      const binding = await adapter.createSession({
        target,
        fastMode: false,
        permissionMode: "ask"
      }, context);
      const messages = await adapter.getMessages({ ...context, binding });
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content[1]).toMatchObject({
        type: "image",
        mimeType: "image/png",
        data: imageData
      });
      expect(scripted.signalCode).toBeNull();
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("returns Pi's complete redacted selected user text with the fork binding", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-fork-text-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-fork-text-workspace-"));
    const selectedText = `restore me sk-abcdefghijklmnop ${"x".repeat(70_000)}`;
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-fork-text-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      processFactory: (spec) => new ScriptedPiProcess(spec, { forkText: selectedText }) as unknown as PiProcessHandle
    });
    const target: TargetDescriptor = {
      id: "target-fork-text",
      backendId: "pi",
      displayName: "Fork text",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    };
    const context = makeContext(target, []);
    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      const result = await adapter.fork("entry-1", { ...context, binding });
      expect(result.binding.nativeSessionId).toBe("fork-native");
      expect(result.editorText).toBe(`restore me [REDACTED] ${"x".repeat(70_000)}`);
      expect(result.editorText).toContain("restore me [REDACTED]");
      expect(result.editorText).not.toContain("sk-abcdefghijklmnop");
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("forks durable history in an isolated runtime while the source keeps streaming", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-isolated-fork-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-isolated-fork-workspace-"));
    const processes: ScriptedPiProcess[] = [];
    const events: EventPayload[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-isolated-fork-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      processFactory: (spec) => {
        const process = new ScriptedPiProcess(spec, processes.length === 0
          ? {
              holdAgentLifecycle: true,
              historyEntries: [{
                type: "message",
                id: "stable-user",
                parentId: null,
                timestamp: new Date(0).toISOString(),
                message: { role: "user", content: [{ type: "text", text: "stable prompt" }], timestamp: 0 }
              }]
            }
          : { forkText: "stable prompt", responseDelayMsByCommand: { fork: 50 } });
        processes.push(process);
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-isolated-fork",
      backendId: "pi",
      displayName: "Isolated fork",
      workspaceRoot: workspace,
      managed: true,
      trusted: true
    };
    const context = makeContext(target, events);
    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      const bound = { ...context, binding };
      await adapter.send({
        text: "source run",
        images: [],
        files: [],
        mentions: [],
        disposition: "prompt"
      }, bound);
      expect(processes[0]?.isStreaming).toBe(true);

      const pendingFork = adapter.fork("stable-user", bound);
      await vi.waitFor(() => {
        expect(processes[1]?.commands.some((command) => command.type === "fork")).toBe(true);
      });
      processes[0]!.emitAssistant("source output during fork");
      await flushAdapterEvents();
      expect(events).toContainEqual(expect.objectContaining({ type: "message_complete", role: "assistant" }));

      const derived = await pendingFork;
      expect(derived.editorText).toBe("stable prompt");
      expect(derived.binding.opaqueRef).not.toBe(binding.opaqueRef);
      expect(processes).toHaveLength(2);
      expect(processes[0]?.commands.some((command) => command.type === "fork" || command.type === "abort")).toBe(false);
      expect(processes[0]?.signalCode).toBeNull();
      expect(processes[1]?.signalCode).toBe("SIGTERM");
      expect(processes[0]?.spec.env.JOKO_PI_CONTROL_FILE).not.toBe(processes[1]?.spec.env.JOKO_PI_CONTROL_FILE);
      await expect(adapter.getState(bound)).resolves.toMatchObject({
        isStreaming: true,
        sessionFile: binding.opaqueRef
      });

      await adapter.detachSession(derived.binding, { ...bound, binding: derived.binding });
      expect(processes[0]?.signalCode).toBeNull();
      processes[0]!.settle();
      await flushAdapterEvents();
      await expect(adapter.setPermissionMode("auto", bound)).resolves.toBeUndefined();
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("clones a stable durable leaf in an isolated runtime while the source keeps streaming", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-isolated-clone-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-isolated-clone-workspace-"));
    const processes: ScriptedPiProcess[] = [];
    const events: EventPayload[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-isolated-clone-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      processFactory: (spec) => {
        const process = new ScriptedPiProcess(spec, processes.length === 0
          ? { holdAgentLifecycle: true }
          : { responseDelayMsByCommand: { clone: 50 } });
        processes.push(process);
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-isolated-clone",
      backendId: "pi",
      displayName: "Isolated clone",
      workspaceRoot: workspace,
      managed: true,
      trusted: true
    };
    const context = makeContext(target, events);
    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      const bound = { ...context, binding };
      const sourceControlPath = String(processes[0]?.spec.env.JOKO_PI_CONTROL_FILE);
      await adapter.send({
        text: "source run",
        images: [],
        files: [],
        mentions: [],
        disposition: "prompt"
      }, bound);
      expect(processes[0]?.isStreaming).toBe(true);

      const pendingClone = adapter.clone(bound);
      await vi.waitFor(() => {
        expect(processes[1]?.commands.some((command) => command.type === "clone")).toBe(true);
      });
      const shadowCommandTypes = processes[1]!.commands.map((command) => command.type);
      expect(shadowCommandTypes.indexOf("get_entries")).toBeLessThan(shadowCommandTypes.indexOf("clone"));
      processes[0]!.emitAssistant("source output during clone");
      await flushAdapterEvents();
      expect(events).toContainEqual(expect.objectContaining({ type: "message_complete", role: "assistant" }));

      const derived = await pendingClone;
      expect(derived.opaqueRef).not.toBe(binding.opaqueRef);
      expect(derived.nativeSessionId).toBe("clone-native");
      expect(processes).toHaveLength(2);
      expect(processes[0]?.commands.some((command) => command.type === "clone" || command.type === "abort")).toBe(false);
      expect(processes[0]?.signalCode).toBeNull();
      expect(processes[1]?.signalCode).toBe("SIGTERM");
      expect(processes[0]?.spec.env.JOKO_PI_CONTROL_FILE).toBe(sourceControlPath);
      expect(processes[1]?.spec.env.JOKO_PI_CONTROL_FILE).not.toBe(sourceControlPath);
      await expect(adapter.getState(bound)).resolves.toMatchObject({
        isStreaming: true,
        sessionFile: binding.opaqueRef,
        sessionId: binding.nativeSessionId
      });

      await adapter.setPermissionMode("auto", bound);
      await expect(readFile(sourceControlPath, "utf8").then(JSON.parse)).resolves.toMatchObject({
        generation: binding.generation,
        permissionMode: "auto"
      });
      await adapter.detachSession(derived, { ...bound, binding: derived });
      expect(processes[0]?.signalCode).toBeNull();
      processes[0]!.settle();
      await flushAdapterEvents();
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("rejects clone before dispatch when the shadow runtime cannot prove the captured leaf", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-clone-fence-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-clone-fence-workspace-"));
    const processes: ScriptedPiProcess[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-clone-fence-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      processFactory: (spec) => {
        const process = new ScriptedPiProcess(spec, processes.length === 0
          ? {}
          : {
              historyLeafId: "changed-leaf",
              historyEntries: [{
                type: "message",
                id: "changed-leaf",
                parentId: null,
                timestamp: new Date(1).toISOString(),
                message: { role: "user", content: [{ type: "text", text: "changed" }], timestamp: 1 }
              }]
            });
        processes.push(process);
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-clone-fence",
      backendId: "pi",
      displayName: "Clone fence",
      workspaceRoot: workspace,
      managed: true,
      trusted: true
    };
    const context = makeContext(target, []);
    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      const bound = { ...context, binding };

      await expect(adapter.clone(bound)).rejects.toMatchObject({
        publicError: { code: "PI_SESSION_CLONE_ENTRY_FENCE_CHANGED", stateMayHaveChanged: false }
      });
      expect(processes).toHaveLength(2);
      expect(processes[0]?.commands.some((command) => command.type === "clone" || command.type === "abort")).toBe(false);
      expect(processes[0]?.signalCode).toBeNull();
      expect(processes[1]?.commands.some((command) => command.type === "clone")).toBe(false);
      expect(processes[1]?.signalCode).toBe("SIGTERM");
      await expect(adapter.getState(bound)).resolves.toMatchObject({
        sessionFile: binding.opaqueRef,
        sessionId: binding.nativeSessionId
      });
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("retires an acknowledgement-ambiguous clone shadow while preserving both source control and derived JSONL", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-ambiguous-clone-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-ambiguous-clone-workspace-"));
    const processes: ScriptedPiProcess[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-ambiguous-clone-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      processFactory: (spec) => {
        const process = new ScriptedPiProcess(spec, processes.length === 0
          ? {}
          : { omitResponsesFor: ["clone"] });
        processes.push(process);
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-ambiguous-clone",
      backendId: "pi",
      displayName: "Ambiguous clone",
      workspaceRoot: workspace,
      managed: true,
      trusted: true
    };
    const context = makeContext(target, []);
    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      const bound = { ...context, binding };
      const cancellation = new AbortController();
      const pendingClone = adapter.clone({ ...bound, signal: cancellation.signal });
      await vi.waitFor(() => {
        expect(processes[1]?.commands.some((command) => command.type === "clone")).toBe(true);
      });
      cancellation.abort();

      await expect(pendingClone).rejects.toMatchObject({
        publicError: { code: "PI_SESSION_CLONE_UNCONFIRMED", stateMayHaveChanged: true }
      });
      expect(processes[0]?.commands.some((command) => command.type === "clone" || command.type === "abort")).toBe(false);
      expect(processes[0]?.signalCode).toBeNull();
      expect(processes[1]?.signalCode).toBe("SIGTERM");
      expect(processes[1]?.spec.env.JOKO_PI_CONTROL_FILE).not.toBe(processes[0]?.spec.env.JOKO_PI_CONTROL_FILE);
      await expect(adapter.getState(bound)).resolves.toMatchObject({
        sessionFile: binding.opaqueRef,
        sessionId: binding.nativeSessionId
      });
      await expect(adapter.listNativeSessions(workspace)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ nativeSessionId: "clone-native" })
      ]));
      await expect(adapter.setPermissionMode("auto", bound)).resolves.toBeUndefined();
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("retires a rejected fork shadow without disturbing the source runtime", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-rejected-fork-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-rejected-fork-workspace-"));
    const processes: ScriptedPiProcess[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-rejected-fork-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      processFactory: (spec) => {
        const process = new ScriptedPiProcess(spec, processes.length === 0
          ? {}
          : { failResponsesFor: ["fork"] });
        processes.push(process);
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-rejected-fork",
      backendId: "pi",
      displayName: "Rejected fork",
      workspaceRoot: workspace,
      managed: true,
      trusted: true
    };
    const context = makeContext(target, []);
    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      const bound = { ...context, binding };

      await expect(adapter.fork("entry-1", bound)).rejects.toMatchObject({
        publicError: { code: "PI_RPC_REJECTED", stateMayHaveChanged: true }
      });
      expect(processes).toHaveLength(2);
      expect(processes[0]?.signalCode).toBeNull();
      expect(processes[0]?.commands.some((command) => command.type === "fork" || command.type === "abort")).toBe(false);
      expect(processes[1]?.signalCode).toBe("SIGTERM");
      await expect(adapter.getState(bound)).resolves.toMatchObject({ sessionFile: binding.opaqueRef });
      await expect(adapter.setPermissionMode("auto", bound)).resolves.toBeUndefined();
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("cleans Pi JSONL tool images into the same online BlobRef before native history crosses the Adapter boundary", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-native-image-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-native-image-workspace-"));
    const imageBytes = Buffer.from("pi-native-image-fixture\0", "utf8");
    const inlineBase64 = imageBytes.toString("base64");
    const artifactWrites: string[] = [];
    const durableByDigest = new Map<string, BlobRef>();
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-native-image-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32768, maxTokens: 4096 }]
      }],
      processFactory: (spec) => new ScriptedPiProcess(spec, {
        toolImage: { data: inlineBase64, mimeType: "image/png" },
        historyEntries: [{
          type: "message",
          id: "native-tool-image",
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: {
            role: "toolResult",
            toolCallId: "read-image",
            toolName: "read",
            content: [
              { type: "text", text: "Image Size: 16x16." },
              { type: "image", data: inlineBase64, mimeType: "image/png" }
            ],
            isError: false,
            timestamp: 0
          }
        }],
        historyLeafId: "native-tool-image"
      }) as unknown as PiProcessHandle
    });
    const target: TargetDescriptor = {
      id: "target-native-image",
      backendId: "pi",
      displayName: "Native image",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    };
    const events: EventPayload[] = [];
    const base = makeContext(target, events);
    const context: AdapterContext = {
      ...base,
      storeArtifact: async (sourcePath, options) => {
        const bytes = await readFile(sourcePath);
        artifactWrites.push(bytes.toString("base64"));
        const digest = createHash("sha256").update(bytes).digest("hex");
        const existing = durableByDigest.get(digest);
        if (existing !== undefined) return existing;
        const blob: BlobRef = {
          id: `durable-${digest}`,
          sha256: digest,
          byteLength: bytes.byteLength,
          mimeType: options?.mimeType ?? "application/octet-stream",
          ...(options?.fileName === undefined ? {} : { fileName: options.fileName })
        };
        durableByDigest.set(digest, blob);
        return blob;
      }
    };

    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      const boundContext = { ...context, binding };
      await adapter.send({ text: "read image", images: [], files: [], mentions: [], disposition: "prompt" }, boundContext);
      await vi.waitFor(() => expect(events.some((event) => event.type === "done")).toBe(true));
      const online = events.find((event) => event.type === "tool_result");
      const firstHistory = await adapter.getNativeHistoryProjection(boundContext);
      const reconnectHistory = await adapter.getNativeHistoryProjection(boundContext);

      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
        type: "tool_result",
        output: "Image Size: 16x16.",
        parts: [
          expect.objectContaining({ kind: "text" }),
          expect.objectContaining({ kind: "image", blob: expect.objectContaining({ id: expect.stringMatching(/^durable-/u) }) })
        ]
      })]));
      expect(online).toBeDefined();
      expect(firstHistory).toEqual(reconnectHistory);
      expect(firstHistory.events[0]?.payload).toMatchObject({
        type: "tool_result",
        output: "Image Size: 16x16.",
        parts: [
          { kind: "text", text: "Image Size: 16x16." },
          { kind: "image", blob: { id: expect.stringMatching(/^durable-/u) } }
        ]
      });
      expect(artifactWrites).toEqual([inlineBase64]);
      expect(JSON.stringify({ online, firstHistory, reconnectHistory })).not.toContain(inlineBase64);
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("enforces explicit model eligibility while dynamically applying and restoring Fast Mode", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-fast-mode-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-fast-workspace-"));
    const processes: ScriptedPiProcess[] = [];
    const specs: PiProcessSpec[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-latest-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [
          { id: "test-model", supportsFastMode: true },
          { id: "standard-model", supportsFastMode: false }
        ]
      }],
      processFactory: (spec) => {
        specs.push(spec);
        const process = new ScriptedPiProcess(spec);
        processes.push(process);
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-fast",
      backendId: "pi",
      displayName: "Fast",
      workspaceRoot: workspace,
      managed: true,
      trusted: false
    };
    const context = makeContext(target, []);
    try {
      await expect(adapter.describe()).resolves.toMatchObject({
        capabilities: expect.any(Map),
        models: expect.arrayContaining([
          expect.objectContaining({ modelId: "test-model", supportsFastMode: true }),
          expect.objectContaining({ modelId: "standard-model", supportsFastMode: false })
        ])
      });
      expect((await adapter.describe()).capabilities.get("model.fast_mode")).toMatchObject({ supported: true });
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      const boundContext = { ...context, binding };
      await adapter.setFastMode(true, boundContext);
      expect(JSON.parse(await readFile(String(specs[0]?.env.JOKO_PI_CONTROL_FILE), "utf8"))).toMatchObject({
        fastMode: true,
        policyGeneration: 1
      });
      await expect(adapter.inspectSession(binding, boundContext)).resolves.toMatchObject({ fastMode: true });
      await expect(adapter.setModel("local", "standard-model", boundContext)).rejects.toMatchObject({
        publicError: { code: "PI_FAST_MODE_MODEL_SWITCH_UNSUPPORTED", stateMayHaveChanged: false }
      });
      expect(processes[0]?.commands.some((command) => command.type === "set_model" && command.modelId === "standard-model")).toBe(false);
      await adapter.setFastMode(false, boundContext);
      await adapter.setModel("local", "standard-model", boundContext);
      expect(JSON.parse(await readFile(String(specs[0]?.env.JOKO_PI_CONTROL_FILE), "utf8"))).toMatchObject({
        fastMode: false,
        policyGeneration: 3
      });
      await adapter.setModel("local", "test-model", boundContext);
      await adapter.setFastMode(true, boundContext);
      await expect(adapter.inspectSession(binding, boundContext)).resolves.toMatchObject({ fastMode: true });
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("allows only live catalogued commands through prompt Composer input", () => {
    const commands = [
      { name: "skill:review", description: "", source: "skill" as const, loaded: true },
      { name: "release-notes", description: "", source: "prompt" as const, loaded: true },
      { name: "plan", description: "", source: "extension" as const, loaded: true },
      { name: "unsafe-extension", description: "", source: "extension" as const, loaded: true }
    ];
    const managedInternalNames = new Set(["plan", "joko-navigate-tree"]);
    expect(escapePiComposerSlashCommand("/skill:review now", commands)).toBe("/skill:review now");
    expect(escapePiComposerSlashCommand("/release-notes v1", commands)).toBe("/release-notes v1");
    expect(escapePiComposerSlashCommand("/plan", commands)).toBe("/plan");
    expect(escapePiComposerSlashCommand("/plan", commands, managedInternalNames)).toBe(" /plan");
    expect(escapePiComposerSlashCommand("/joko-navigate-tree payload", commands, managedInternalNames)).toBe(" /joko-navigate-tree payload");
    expect(escapePiComposerSlashCommand("/unsafe-extension", commands)).toBe("/unsafe-extension");
    expect(resolvePiComposerSlashCommand("/unsafe-extension", "steer", commands)).toEqual({
      message: "/unsafe-extension",
      extensionCommand: "unsafe-extension"
    });
    expect(resolvePiComposerSlashCommand("/unsafe-extension", "follow_up", commands)).toEqual({
      message: "/unsafe-extension",
      extensionCommand: "unsafe-extension"
    });
    expect(escapePiComposerSlashCommand("ordinary text", commands)).toBe("ordinary text");
  });

  it("publishes a synchronous extension terminal only after send crosses the acceptance boundary", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-sync-command-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-sync-command-workspace-"));
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-sync-command-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32768, maxTokens: 4096 }]
      }],
      processFactory: (spec) => new ScriptedPiProcess(spec, {
        commands: [{
          name: "synchronous-extension",
          description: "Completes without an agent lifecycle",
          source: "extension",
          sourceInfo: { path: "managed" }
        }],
        synchronousExtensionCommand: "synchronous-extension"
      }) as unknown as PiProcessHandle
    });
    const target: TargetDescriptor = {
      id: "target-synchronous-command",
      backendId: "pi",
      displayName: "Synchronous command",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    };
    const events: EventPayload[] = [];
    let sendAccepted = false;
    let terminalObservedAfterAcceptance: boolean | undefined;
    const baseContext = makeContext(target, events);
    const context: AdapterContext = {
      ...baseContext,
      emit: async (payload) => {
        events.push(payload);
        if (payload.type === "done") terminalObservedAfterAcceptance = sendAccepted;
      }
    };

    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      await adapter.send({
        text: "/synchronous-extension",
        images: [],
        files: [],
        mentions: [],
        disposition: "prompt"
      }, { ...context, binding });
      sendAccepted = true;
      await new Promise((resolve) => setImmediate(resolve));

      expect(terminalObservedAfterAcceptance).toBe(true);
      expect(events.filter((event) => event.type === "done")).toEqual([{ type: "done", outcome: "completed" }]);
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("executes a catalogued extension command through prompt while Pi is streaming and terminates only its Run", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-running-command-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-running-command-workspace-"));
    let scripted!: ScriptedPiProcess;
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-running-command-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32768, maxTokens: 4096 }]
      }],
      processFactory: (spec) => {
        scripted = new ScriptedPiProcess(spec, {
          commands: [{
            name: "running-extension",
            description: "Executes immediately during streaming",
            source: "extension",
            sourceInfo: { path: "managed" }
          }],
          synchronousExtensionCommand: "running-extension",
          holdAgentLifecycle: true
        });
        return scripted as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-running-command",
      backendId: "pi",
      displayName: "Running command",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    };
    const ownerEvents: EventPayload[] = [];
    const commandEvents: EventPayload[] = [];
    const ownerContext = makeContext(target, ownerEvents);

    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, ownerContext);
      const boundOwner = { ...ownerContext, binding };
      await adapter.send({
        text: "long-running task",
        images: [],
        files: [],
        mentions: [],
        disposition: "prompt"
      }, boundOwner);
      expect(scripted.isStreaming).toBe(true);

      let commandAccepted = false;
      let terminalObservedAfterAcceptance: boolean | undefined;
      const commandContext: AdapterContext = {
        ...boundOwner,
        emit: async (payload) => {
          commandEvents.push(payload);
          if (payload.type === "done") terminalObservedAfterAcceptance = commandAccepted;
        }
      };
      await adapter.send({
        text: "/running-extension now",
        images: [],
        files: [],
        mentions: [],
        disposition: "steer"
      }, commandContext);
      commandAccepted = true;
      await new Promise((resolve) => setImmediate(resolve));

      expect(scripted.commands.at(-1)).toMatchObject({ type: "prompt", message: "/running-extension now" });
      expect(scripted.commands.some((command) => command.type === "steer")).toBe(false);
      expect(terminalObservedAfterAcceptance).toBe(true);
      expect(commandEvents.filter((event) => event.type === "done")).toEqual([{ type: "done", outcome: "completed" }]);
      expect(ownerEvents.some((event) => event.type === "done")).toBe(false);

      scripted.settle();
      await vi.waitFor(() => expect(ownerEvents.some((event) => event.type === "done")).toBe(true));
      expect(commandEvents.filter((event) => event.type === "done")).toHaveLength(1);
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("classifies only catalogued extensions for compaction bypass and executes the normalized prompt during a running lifecycle", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-compaction-command-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-compaction-command-workspace-"));
    let scripted!: ScriptedPiProcess;
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-compaction-command-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32768, maxTokens: 4096 }]
      }],
      processFactory: (spec) => {
        scripted = new ScriptedPiProcess(spec, {
          commands: [
            {
              name: "compaction-extension",
              description: "Executes immediately during compaction",
              source: "extension",
              sourceInfo: { path: "managed" }
            },
            {
              name: "review-template",
              description: "Must remain queued",
              source: "prompt",
              sourceInfo: { path: "managed" }
            }
          ],
          synchronousExtensionCommand: "compaction-extension",
          holdAgentLifecycle: true
        });
        return scripted as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-compaction-command",
      backendId: "pi",
      displayName: "Compaction command",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    };
    const ownerEvents: EventPayload[] = [];
    const commandEvents: EventPayload[] = [];
    const ownerContext = makeContext(target, ownerEvents);

    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, ownerContext);
      const boundOwner = { ...ownerContext, binding };
      await adapter.send({
        text: "long-running task",
        images: [],
        files: [],
        mentions: [],
        disposition: "prompt"
      }, boundOwner);
      scripted.isCompacting = true;

      await expect(adapter.dispatchDuringCompaction?.({
        text: "ordinary input",
        images: [],
        files: [],
        mentions: [],
        disposition: "steer"
      }, boundOwner)).resolves.toBeUndefined();
      await expect(adapter.dispatchDuringCompaction?.({
        text: "/review-template",
        images: [],
        files: [],
        mentions: [],
        disposition: "follow_up"
      }, boundOwner)).resolves.toBeUndefined();
      await expect(adapter.dispatchDuringCompaction?.({
        text: "/unknown-command",
        images: [],
        files: [],
        mentions: [],
        disposition: "follow_up"
      }, boundOwner)).resolves.toBeUndefined();
      await expect(adapter.dispatchDuringCompaction?.({
        text: "/compaction-extension now",
        images: [],
        files: [],
        mentions: [],
        disposition: "follow_up"
      }, boundOwner)).resolves.toBe("prompt");

      // The queue classifier and final send are separated by durable Store
      // work. Compaction may finish in that gap while the owner lifecycle is
      // still streaming; a normalized extension prompt remains immediate.
      scripted.isCompacting = false;
      expect(scripted.isStreaming).toBe(true);

      const commandContext: AdapterContext = {
        ...boundOwner,
        emit: async (payload) => { commandEvents.push(payload); }
      };
      await adapter.send({
        text: "/compaction-extension now",
        images: [],
        files: [],
        mentions: [],
        disposition: "prompt"
      }, commandContext);
      await new Promise((resolve) => setImmediate(resolve));

      expect(scripted.commands.at(-1)).toMatchObject({
        type: "prompt",
        message: "/compaction-extension now"
      });
      expect(commandEvents.filter((event) => event.type === "done"))
        .toEqual([{ type: "done", outcome: "completed" }]);
      expect(ownerEvents.some((event) => event.type === "done")).toBe(false);

      scripted.settle();
      await vi.waitFor(() => expect(ownerEvents.some((event) => event.type === "done")).toBe(true));
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("fails image input closed against live model state across prompt, steer, follow-up, and model switches", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-image-model-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-image-model-workspace-"));
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const imageBlob: BlobRef = {
      id: "image-model-gate",
      sha256: createHash("sha256").update(imageBytes).digest("hex"),
      byteLength: imageBytes.byteLength,
      mimeType: "image/png"
    };
    let scripted!: ScriptedPiProcess;
    const blobReadCommandCounts: number[] = [];
    const readBlob = vi.fn(async () => {
      blobReadCommandCounts.push(scripted.commands.length);
      return { data: imageBytes, mimeType: "image/png" };
    });
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      readBlob,
      versionProbe: async () => "pi 99.99.99-image-model-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [
          { id: "text-model", contextWindow: 32768, maxTokens: 4096 },
          { id: "vision-model", contextWindow: 32768, maxTokens: 4096 }
        ]
      }],
      processFactory: (spec) => {
        scripted = new ScriptedPiProcess(spec, {
          holdAgentLifecycle: true,
          modelInputs: {
            "text-model": ["text"],
            "vision-model": ["text", "image"]
          }
        });
        return scripted as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-image-model",
      backendId: "pi",
      displayName: "Image model gate",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    };
    const context = makeContext(target, []);
    const dispatchCount = (type: "prompt" | "steer" | "follow_up"): number =>
      scripted.commands.filter((command) => command.type === type).length;
    const expectImageRejected = async (disposition: "prompt" | "steer" | "follow_up", text: string): Promise<void> => {
      const readsBefore = readBlob.mock.calls.length;
      const dispatchesBefore = dispatchCount(disposition);
      await expect(adapter.send({
        text,
        images: [{ blob: imageBlob }],
        files: [],
        mentions: [],
        disposition
      }, boundContext)).rejects.toMatchObject({
        publicError: {
          code: "PI_IMAGE_INPUT_UNSUPPORTED",
          phase: "dispatch",
          retryable: false,
          stateMayHaveChanged: false,
          recovery: expect.stringContaining("Select a model")
        }
      });
      expect(readBlob).toHaveBeenCalledTimes(readsBefore);
      expect(dispatchCount(disposition)).toBe(dispatchesBefore);
    };
    let boundContext!: AdapterContext;

    try {
      const binding = await adapter.createSession({
        target,
        providerId: "local",
        modelId: "text-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      boundContext = { ...context, binding };

      scripted.omitModelFromState = true;
      await expectImageRejected("prompt", "unknown model");
      scripted.omitModelFromState = false;
      await expectImageRejected("prompt", "text model before switch");

      await adapter.setModel("local", "vision-model", boundContext);
      for (const disposition of ["prompt", "steer", "follow_up"] as const) {
        await adapter.send({
          text: `vision ${disposition}`,
          images: [{ blob: imageBlob }],
          files: [],
          mentions: [],
          disposition
        }, boundContext);
      }
      expect(readBlob).toHaveBeenCalledTimes(3);
      expect([dispatchCount("prompt"), dispatchCount("steer"), dispatchCount("follow_up")]).toEqual([1, 1, 1]);
      let previousImageDispatchIndex = -1;
      for (const command of scripted.commands.filter((candidate) =>
        candidate.type === "prompt" || candidate.type === "steer" || candidate.type === "follow_up"
      )) {
        expect(command.images).toEqual([{ type: "image", data: imageBytes.toString("base64"), mimeType: "image/png" }]);
        const dispatchIndex = scripted.commands.indexOf(command);
        expect(scripted.commands.slice(previousImageDispatchIndex + 1, dispatchIndex).some((candidate) =>
          candidate.type === "get_state"
        )).toBe(true);
        previousImageDispatchIndex = dispatchIndex;
      }
      for (const commandCount of blobReadCommandCounts) {
        expect(scripted.commands[commandCount - 1]?.type).toBe("get_state");
      }

      scripted.settle();
      await new Promise((resolve) => setImmediate(resolve));
      await adapter.setModel("local", "text-model", boundContext);
      await expectImageRejected("prompt", "text model after switch back");

      await adapter.send({
        text: "start text-only lifecycle",
        images: [],
        files: [],
        mentions: [],
        disposition: "prompt"
      }, boundContext);
      await expectImageRejected("steer", "text-only steer");
      await expectImageRejected("follow_up", "text-only follow-up");
      expect(readBlob).toHaveBeenCalledTimes(3);
      expect([dispatchCount("steer"), dispatchCount("follow_up")]).toEqual([1, 1]);
      scripted.settle();
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("dispatches integrity-checked image descriptors and bytes larger than 25 MiB", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-large-image-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-large-image-workspace-"));
    const byteLength = 25 * 1024 * 1024 + 1;
    const imageBytes = Buffer.alloc(byteLength);
    imageBytes.set([0x89, 0x50, 0x4e, 0x47]);
    const imageBlob: BlobRef = {
      id: "large-image",
      sha256: createHash("sha256").update(imageBytes).digest("hex"),
      byteLength,
      mimeType: "image/png"
    };
    let scripted!: ScriptedPiProcess;
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      readBlob: async () => ({ data: imageBytes, mimeType: "image/png" }),
      versionProbe: async () => "pi 99.99.99-large-image-test",
      processFactory: (spec) => {
        scripted = new ScriptedPiProcess(spec);
        scripted.model = { ...scripted.model, input: ["text", "image"] };
        return scripted as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-large-image",
      backendId: "pi",
      displayName: "Large image",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    };
    const context = makeContext(target, []);

    try {
      const binding = await adapter.createSession({
        target,
        fastMode: false,
        permissionMode: "ask"
      }, context);
      await adapter.send({
        text: "inspect large image",
        images: [{ blob: imageBlob }],
        files: [],
        mentions: [],
        disposition: "prompt"
      }, { ...context, binding });

      const prompt = scripted.commands.findLast((command) => command.type === "prompt");
      const nativeImage = (prompt?.images as Array<{ data: string; mimeType: string }> | undefined)?.[0];
      expect(nativeImage?.mimeType).toBe("image/png");
      expect(nativeImage?.data.length).toBe(Math.ceil(byteLength / 3) * 4);
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("preserves every Vision Bridge description and its complete text", () => {
    const longDescription = `description-start-${"x".repeat(32_768)}-description-end`;
    const descriptions = [
      ...Array.from({ length: 16 }, (_, index) => `description-${index + 1}`),
      longDescription
    ];
    const composed = appendVisionBridgeDescriptions("Inspect the images", descriptions);

    expect(composed).toContain("[Vision Bridge image 17]");
    expect(composed).toContain("description-end");
    expect(composed.match(/\[End Vision Bridge image description\]/gu)).toHaveLength(17);
  });

  it("bridges exact live Backend+Provider+Model images, preserves native images on undefined, and never partially dispatches failures", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-vision-bridge-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-vision-bridge-workspace-"));
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const imageBlob: BlobRef = {
      id: "vision-bridge-image",
      sha256: createHash("sha256").update(imageBytes).digest("hex"),
      byteLength: imageBytes.byteLength,
      mimeType: "image/png"
    };
    let scripted!: ScriptedPiProcess;
    const readBlob = vi.fn(async () => ({ data: imageBytes, mimeType: "image/png" }));
    const visionBridge = vi.fn(async (input: {
      readonly text: string;
      readonly onStart?: (imageCount: number) => void | Promise<void>;
    }) => {
      if (input.text === "native image") return undefined;
      await input.onStart?.(1);
      if (input.text === "bridge failure") throw new Error("bridge failed before dispatch");
      if (input.text === "bridge abort") throw new DOMException("aborted", "AbortError");
      if (input.text === "bridge fallback") {
        return { descriptions: ["Fallback description."], usedFallback: true, unavailableCount: 0 };
      }
      if (input.text === "bridge unavailable") {
        return { descriptions: ["Image unavailable; do not infer its content."], usedFallback: false, unavailableCount: 1 };
      }
      if (input.text === "bridge partial") {
        return { descriptions: ["Visible image.", "Image unavailable."], usedFallback: false, unavailableCount: 1 };
      }
      if (input.text === "bridge fallback partial") {
        return { descriptions: ["Fallback image.", "Image unavailable."], usedFallback: true, unavailableCount: 1 };
      }
      return { descriptions: ["Visible UI with a red error banner."], usedFallback: false, unavailableCount: 0 };
    });
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      readBlob,
      visionBridge,
      versionProbe: async () => "pi 99.99.99-vision-bridge-test",
      providers: [{
        id: "provider-a",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "same-model", contextWindow: 32768, maxTokens: 4096, input: ["text", "image"] }]
      }],
      processFactory: (spec) => {
        scripted = new ScriptedPiProcess(spec, { holdAgentLifecycle: true });
        scripted.model = {
          ...scripted.model,
          provider: "provider-a",
          id: "same-model",
          input: ["text", "image"]
        };
        return scripted as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-vision-bridge",
      backendId: "pi",
      displayName: "Vision Bridge",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    };
    const events: EventPayload[] = [];
    const context = makeContext(target, events);

    try {
      const binding = await adapter.createSession({
        target,
        providerId: "provider-a",
        modelId: "same-model",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      const bound = { ...context, binding };
      const imageInput = [{ blob: imageBlob }];

      await adapter.send({ text: "bridge this", images: imageInput, files: [], mentions: [], disposition: "prompt" }, bound);
      const bridgedCommand = scripted.commands.findLast((command) => command.type === "prompt");
      expect(visionBridge).toHaveBeenLastCalledWith({
        backendId: "pi",
        providerId: "provider-a",
        modelId: "same-model",
        text: "bridge this",
        images: imageInput,
        signal: context.signal,
        onStart: expect.any(Function)
      });
      expect(bridgedCommand).toMatchObject({ type: "prompt", images: [] });
      expect(String(bridgedCommand?.message)).toContain("[Vision Bridge image 1]");
      expect(String(bridgedCommand?.message)).toContain("Visible UI with a red error banner.");
      expect(readBlob).not.toHaveBeenCalled();

      scripted.settle();
      await flushAdapterEvents();
      await adapter.send({ text: "native image", images: imageInput, files: [], mentions: [], disposition: "prompt" }, bound);
      expect(scripted.commands.findLast((command) => command.type === "prompt")).toMatchObject({
        message: "native image",
        images: [{ type: "image", data: imageBytes.toString("base64"), mimeType: "image/png" }]
      });
      expect(readBlob).toHaveBeenCalledOnce();

      scripted.settle();
      await flushAdapterEvents();
      await adapter.send({ text: "bridge fallback", images: imageInput, files: [], mentions: [], disposition: "prompt" }, bound);
      scripted.settle();
      await flushAdapterEvents();
      await adapter.send({ text: "bridge unavailable", images: imageInput, files: [], mentions: [], disposition: "prompt" }, bound);
      expect(events.filter((event) => event.type === "status").map((event) => event.key)).toEqual([
        "vision-bridge-recognizing",
        "vision-bridge-recognizing",
        "vision-bridge-fallback",
        "vision-bridge-recognizing",
        "vision-bridge-unavailable"
      ]);

      scripted.settle();
      await flushAdapterEvents();
      const statusCountBeforePartial = events.filter((event) => event.type === "status").length;
      const twoImages = [...imageInput, ...imageInput];
      await adapter.send({ text: "bridge partial", images: twoImages, files: [], mentions: [], disposition: "prompt" }, bound);
      expect(events.filter((event) => event.type === "status").slice(statusCountBeforePartial).map((event) => event.key))
        .toEqual(["vision-bridge-recognizing"]);
      scripted.settle();
      await flushAdapterEvents();
      await adapter.send({ text: "bridge fallback partial", images: twoImages, files: [], mentions: [], disposition: "prompt" }, bound);
      expect(events.filter((event) => event.type === "status").slice(-2).map((event) => event.key))
        .toEqual(["vision-bridge-recognizing", "vision-bridge-fallback"]);

      scripted.settle();
      await flushAdapterEvents();
      const dispatchesBeforeStatusFailure = scripted.commands.filter((command) => command.type === "prompt").length;
      const rejectingStatusContext: AdapterContext = {
        ...bound,
        emit: async (payload) => {
          if (payload.type === "status") throw new Error("status persistence unavailable");
          events.push(payload);
        }
      };
      await expect(adapter.send({
        text: "bridge fallback",
        images: imageInput,
        files: [],
        mentions: [],
        disposition: "prompt"
      }, rejectingStatusContext)).resolves.toBeUndefined();
      expect(scripted.commands.filter((command) => command.type === "prompt"))
        .toHaveLength(dispatchesBeforeStatusFailure + 1);

      scripted.settle();
      await flushAdapterEvents();
      const dispatchesBeforeFailure = scripted.commands.filter((command) => command.type === "prompt").length;
      await expect(adapter.send({ text: "bridge failure", images: imageInput, files: [], mentions: [], disposition: "prompt" }, bound))
        .rejects.toThrow("bridge failed before dispatch");
      await expect(adapter.send({ text: "bridge abort", images: imageInput, files: [], mentions: [], disposition: "prompt" }, bound))
        .rejects.toMatchObject({ name: "AbortError" });
      expect(events.filter((event) => event.type === "status").map((event) => event.key).slice(-4)).toEqual([
        "vision-bridge-recognizing",
        "vision-bridge-clear",
        "vision-bridge-recognizing",
        "vision-bridge-clear"
      ]);
      expect(scripted.commands.filter((command) => command.type === "prompt")).toHaveLength(dispatchesBeforeFailure);
      expect(readBlob).toHaveBeenCalledOnce();
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  });

  it("never promotes a package from only one loaded leaf command", () => {
    const packageRoot = join(process.cwd(), "runtime-package");
    const promptPath = join(packageRoot, "prompts", "working.md");
    expect(isRuntimeResourceProvenLoaded({
      id: "partial-package",
      kind: "package",
      name: "Partial package",
      source: "managed",
      state: "approved",
      runtimePath: packageRoot
    }, [{
      name: "working",
      description: "Only one valid leaf",
      source: "prompt",
      path: promptPath,
      loaded: true
    }])).toBe(false);
  });

  it("rotates managed Agent Home without moving the stable native session store", async () => {
    const firstAgentHome = await mkdtemp(join(tmpdir(), "joko-pi-generation-one-"));
    const secondAgentHome = await mkdtemp(join(tmpdir(), "joko-pi-generation-two-"));
    const failedAgentHome = await mkdtemp(join(tmpdir(), "joko-pi-generation-failed-"));
    const sessionRoot = await mkdtemp(join(tmpdir(), "joko-pi-stable-sessions-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-generation-workspace-"));
    const resources = await mkdtemp(join(tmpdir(), "joko-pi-generation-resources-"));
    const extension = join(resources, "managed.ts");
    const skill = join(resources, "skill");
    const prompt = join(resources, "prompt.md");
    await mkdir(skill, { recursive: true });
    await Promise.all([
      // The scripted process models Pi remaining ready after a resource load
      // failure; no get_commands evidence may turn this invalid source loaded.
      writeFile(extension, "this is not valid extension syntax\n"),
      writeFile(join(skill, "SKILL.md"), "managed skill\n"),
      writeFile(prompt, "managed prompt\n")
    ]);
    const specs: PiProcessSpec[] = [];
    const processes: ScriptedPiProcess[] = [];
    const releasedGenerations: string[] = [];
    const processFactory = (spec: PiProcessSpec): PiProcessHandle => {
      specs.push(spec);
      const child = new ScriptedPiProcess(spec);
      processes.push(child);
      return child as unknown as PiProcessHandle;
    };
    const provider = {
      id: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      api: "openai-completions" as const,
      keyless: true,
      models: [{ id: "test-model", contextWindow: 32768, maxTokens: 4096 }]
    };
    const adapter = createPiAdapter({
      agentHome: firstAgentHome,
      sessionRoot,
      providers: [provider],
      mcpBridge: { endpoint: "http://127.0.0.1:4318/internal/mcp", token: "bridge-one", tools: [] },
      releaseManagedGeneration: () => { releasedGenerations.push("one"); },
      versionProbe: async () => "pi 99.99.99-latest-test",
      processFactory
    });
    const target: TargetDescriptor = {
      id: "target-1",
      backendId: "pi",
      displayName: "Local",
      workspaceRoot: workspace,
      managed: true,
      trusted: false
    };
    const context = makeContext(target, []);
    const binding = await adapter.createSession(
      { target, providerId: "local", modelId: "test-model", effort: "medium", fastMode: false, permissionMode: "ask" },
      context
    );
    expect(binding.opaqueRef.startsWith(join(sessionRoot, "sessions"))).toBe(true);
    expect(specs[0]?.env.PI_CODING_AGENT_SESSION_DIR).toBe(join(sessionRoot, "sessions"));

    const patternedPackage = join(resources, "patterned-package");
    await mkdir(join(patternedPackage, "extensions"), { recursive: true });
    await Promise.all([
      writeFile(join(patternedPackage, "extensions", "one.ts"), "export default () => undefined;\n"),
      writeFile(join(patternedPackage, "package.json"), JSON.stringify({ pi: { extensions: ["extensions/*.ts"] } }))
    ]);
    await adapter.updateManagedGeneration({
      agentHome: failedAgentHome,
      providers: [provider],
      managedResources: { extensions: [], skills: [], prompts: [], packages: [patternedPackage], resources: [] },
      mcpBridge: { endpoint: "http://127.0.0.1:4318/internal/mcp", token: "bridge-two", tools: [] },
      releaseManagedGeneration: () => { releasedGenerations.push("two"); }
    });
    expect(processes[0]?.exitCode).toBeNull();
    expect(releasedGenerations).toEqual([]);
    expect(specs[0]?.env.JOKO_PI_MCP_TOKEN).toBe("bridge-one");
    await expect(adapter.inspectSession(binding, { ...context, binding })).resolves.toMatchObject({ streaming: false });
    await adapter.closeSession(binding, { ...context, binding });
    expect(releasedGenerations).toEqual(["one"]);
    const generationTwoContext = { ...context, generation: 2, binding };
    await adapter.resumeSession(binding, generationTwoContext);
    expect(processes[1]?.commands).toContainEqual(expect.objectContaining({
      type: "switch_session",
      sessionPath: binding.opaqueRef
    }));
    expect(valuesForArgument(specs[1]!.args, "--extension")).toHaveLength(4);
    expect(specs[1]?.env.JOKO_PI_MCP_TOKEN).toBe("bridge-two");

    await adapter.updateManagedGeneration({
      agentHome: secondAgentHome,
      providers: [provider],
      environment: { JOKO_GENERATION_MARKER: "two" },
      managedResources: {
        extensions: [extension],
        skills: [skill],
        prompts: [prompt],
        packages: [],
        resources: [{
          id: "managed-extension",
          kind: "extension",
          name: "managed",
          source: "approved",
          state: "approved",
          revision: "sha256:managed-extension",
          runtimePath: extension
        }]
      },
      releaseManagedGeneration: () => { releasedGenerations.push("three"); }
    });
    expect(processes[1]?.exitCode).toBeNull();
    expect(releasedGenerations).toEqual(["one"]);
    await expect(readFile(binding.opaqueRef, "utf8")).resolves.toContain(binding.nativeSessionId!);
    await expect(adapter.inspectSession(binding, generationTwoContext)).resolves.toMatchObject({ streaming: false });
    await adapter.closeSession(binding, generationTwoContext);
    expect(releasedGenerations).toEqual(["one", "two"]);

    const nextContext = { ...context, generation: 3, binding };
    await adapter.resumeSession(binding, nextContext);
    expect(processes[2]?.commands).toContainEqual(expect.objectContaining({
      type: "switch_session",
      sessionPath: binding.opaqueRef
    }));
    expect(String(specs[2]?.env.PI_CODING_AGENT_DIR)).toContain(join(secondAgentHome, "runtime"));
    expect(specs[2]?.env.PI_CODING_AGENT_SESSION_DIR).toBe(join(sessionRoot, "sessions"));
    expect(specs[2]?.env.JOKO_GENERATION_MARKER).toBe("two");
    expect(specs[2]?.args).toEqual(expect.arrayContaining(["--no-prompt-templates", "--offline", "--skill", "--prompt-template"]));
    expect(valuesForArgument(specs[2]!.args, "--extension")).toHaveLength(4);
    expect(valuesForArgument(specs[2]!.args, "--extension").at(-1)?.split(/[\\/]/u).at(-1)).toBe("joko-managed-bridge.ts");
    await expect(adapter.getRuntimeTools(nextContext)).rejects.toMatchObject({
      publicError: { code: "PI_RUNTIME_TOOL_CATALOG_UNAVAILABLE" }
    });
    await expect(adapter.getResources(nextContext)).resolves.toMatchObject([{
      id: "managed-extension",
      state: "approved",
      revision: "sha256:managed-extension",
      runtimeGeneration: 3
    }]);
    await adapter.dispose();
    expect(releasedGenerations).toEqual(["one", "two", "three"]);
  });

  it("keeps native OAuth only in a generation-fenced runtime Agent Home and persists refreshes after cleanup", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-native-auth-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-native-auth-workspace-"));

    const initial = { type: "oauth" as const, access: "access-old-secret", refresh: "refresh-old-secret", expires: 10_000 };
    const refreshed = { ...initial, access: "access-new-secret", refresh: "refresh-new-secret", expires: 20_000 };
    const persisted: Array<{ providerId: string; credential: unknown; expectedCatalogGeneration: number }> = [];
    const specs: PiProcessSpec[] = [];
    const processes: ScriptedPiProcess[] = [];
    const events: EventPayload[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      catalogGeneration: 7,
      providers: [{
        id: "local-byom",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "local-model" }]
      }],
      nativeAuthProviderIds: ["openai-codex"],
      nativeModels: [{
        providerId: "openai-codex",
        modelId: "gpt-native",
        logicalId: "gpt-shared",
        displayName: "Native GPT",
        api: "openai-responses",
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        supportsImages: true,
        defaultVisible: false,
        thinkingLevels: ["low", "medium", "high"],
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }
      }],
      loadNativeAuth: ({ providerIds, expectedCatalogGeneration }) => {
        expect(providerIds).toEqual(["openai-codex"]);
        expect(expectedCatalogGeneration).toBe(7);
        return { catalogGeneration: 7, credentials: { "openai-codex": initial } };
      },
      persistNativeAuth: async (input) => {
        persisted.push(input);
        return { catalogGeneration: 8, credentialReferenceId: "credential-native", expiresAt: refreshed.expires };
      },
      versionProbe: async () => "pi 99.99.99-latest-test",
      processFactory: (spec) => {
        specs.push(spec);
        const process = new ScriptedPiProcess(spec);
        processes.push(process);
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-native-auth",
      backendId: "pi",
      displayName: "OAuth",
      workspaceRoot: workspace,
      managed: true,
      trusted: false
    };
    const context = makeContext(target, events);
    await expect(adapter.describe()).resolves.toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ providerId: "local-byom", modelId: "local-model" }),
        expect.objectContaining({
          providerId: "openai-codex",
          modelId: "gpt-native",
          logicalId: "gpt-shared",
          defaultVisible: false
        })
      ])
    });
    const binding = await adapter.createSession(
      { target, providerId: "openai-codex", modelId: "gpt-native", fastMode: false, permissionMode: "ask" },
      context
    );
    const runtimeAgentHome = String(specs[0]?.env.PI_CODING_AGENT_DIR);
    const authPath = join(runtimeAgentHome, "auth.json");
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({ "openai-codex": initial });
    const runtimeModels = await readFile(join(runtimeAgentHome, "models.json"), "utf8");
    expect(runtimeModels).toContain("local-byom");
    expect(runtimeModels).not.toContain("openai-codex");
    await expect(readFile(join(runtimeAgentHome, "settings.json"), "utf8")).resolves.toContain("defaultProjectTrust");
    await expect(access(join(agentHome, "auth.json"))).rejects.toBeDefined();
    if (process.platform !== "win32") {
      expect((await stat(runtimeAgentHome)).mode & 0o777).toBe(0o700);
      expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.stringify(specs[0])).not.toContain(initial.access);
    expect(JSON.stringify(specs[0])).not.toContain(initial.refresh);
    expect(await readFile(binding.opaqueRef, "utf8")).not.toContain(initial.access);

    await writeFile(authPath, `${JSON.stringify({ "openai-codex": refreshed })}\n`, { mode: 0o600 });
    await adapter.closeSession(binding, { ...context, binding });
    expect(persisted).toEqual([{
      providerId: "openai-codex",
      credential: refreshed,
      expectedCatalogGeneration: 7
    }]);
    await expect(access(dirname(runtimeAgentHome))).rejects.toBeDefined();
    expect(JSON.stringify(events)).not.toContain(initial.access);
    expect(JSON.stringify(events)).not.toContain(initial.refresh);
    expect(JSON.stringify(events)).not.toContain(refreshed.access);
    expect(JSON.stringify(events)).not.toContain(refreshed.refresh);
    await adapter.dispose();
  });

  it("probes a hot replacement generation without recovering sibling runtimes owned by the current Adapter", async () => {
    const sessionRoot = await mkdtemp(join(tmpdir(), "joko-pi-hot-replacement-root-"));
    const generationsRoot = join(sessionRoot, "generations");
    const currentRuntime = join(generationsRoot, "current", "runtime", "owned-live-runtime");
    const candidateHome = join(generationsRoot, "candidate");
    await mkdir(currentRuntime, { recursive: true });
    await writeFile(join(currentRuntime, "current-owner-marker"), "owned by current Adapter");

    const candidate = createPiAdapter({
      agentHome: candidateHome,
      sessionRoot,
      managedGenerationsRoot: generationsRoot,
      recoverManagedGenerationsOnInitialize: false,
      externalSessionRoots: [],
      versionProbe: async () => "pi 99.99.99-hot-replacement-test"
    });

    await expect(candidate.describe()).resolves.toMatchObject({
      id: "pi",
      health: expect.not.stringMatching(/^unavailable$/u)
    });
    await expect(readFile(join(currentRuntime, "current-owner-marker"), "utf8"))
      .resolves.toBe("owned by current Adapter");
    await candidate.dispose();
    await rm(sessionRoot, { recursive: true, force: true });
  });

  it("identity-checks a recorded managed process before startup cleanup and fails closed when exit is unconfirmed", async () => {
    const createStaleGeneration = async (outcome: "terminated" | "unconfirmed") => {
      const agentHome = await mkdtemp(join(tmpdir(), `joko-pi-stale-process-${outcome}-`));
      const staleDirectory = join(agentHome, "runtime", "stale-runtime");
      await mkdir(staleDirectory, { recursive: true });
      await writeFile(join(staleDirectory, "runtime-owner.json"), JSON.stringify({
        format: 1,
        spawnIdentity: "a".repeat(64),
        sessionKey: "b".repeat(24),
        productGeneration: 4,
        state: "running",
        pid: 4242,
        processIdentity: "c".repeat(64)
      }));
      const terminations: unknown[][] = [];
      const adapter = createPiAdapter({
        agentHome,
        sessionRoot: agentHome,
        providers: [],
        versionProbe: async () => "pi 99.99.99-latest-test",
        processFactory: () => { throw new Error("not started"); },
        processSupervisor: {
          capture: async () => "c".repeat(64),
          captureSync: () => "c".repeat(64),
          terminate: async (...args) => {
            terminations.push(args);
            return outcome;
          }
        }
      });
      return { adapter, agentHome, staleDirectory, terminations };
    };

    const missingOwnerHome = await mkdtemp(join(tmpdir(), "joko-pi-stale-process-missing-owner-"));
    const missingOwnerDirectory = join(missingOwnerHome, "runtime", "unowned-runtime");
    await mkdir(missingOwnerDirectory, { recursive: true });
    const missingOwner = createPiAdapter({
      agentHome: missingOwnerHome,
      sessionRoot: missingOwnerHome,
      providers: [],
      versionProbe: async () => "pi 99.99.99-latest-test",
      processFactory: () => { throw new Error("not started"); }
    });
    await expect(missingOwner.describe()).rejects.toMatchObject({
      publicError: { code: "PI_STALE_RUNTIME_IDENTITY_MISSING", stateMayHaveChanged: true }
    });
    await expect(access(missingOwnerDirectory)).resolves.toBeUndefined();
    await missingOwner.dispose();

    const recovered = await createStaleGeneration("terminated");
    await expect(recovered.adapter.describe()).resolves.toMatchObject({ id: "pi" });
    expect(recovered.terminations).toEqual([[4242, "c".repeat(64), 5_000]]);
    expect(await readdir(join(recovered.agentHome, "runtime"))).toEqual([]);
    await recovered.adapter.dispose();

    const fenced = await createStaleGeneration("unconfirmed");
    await expect(fenced.adapter.describe()).rejects.toMatchObject({
      publicError: { code: "PI_STALE_PROCESS_EXIT_UNCONFIRMED", stateMayHaveChanged: true }
    });
    await expect(access(fenced.staleDirectory)).resolves.toBeUndefined();
    await fenced.adapter.dispose();
  });

  it("projects only registered local runtime trees and requires the complete public spawn fence to terminate", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-runtime-process-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-runtime-process-workspace-"));
    const privateIdentity = "d".repeat(64);
    const inspect = vi.fn(async (roots: readonly { readonly pid: number; readonly expectedIdentity: string }[]) => {
      if (roots.length === 0) return [];
      expect(roots).toEqual([{ pid: 100, expectedIdentity: privateIdentity }]);
      return [{ pid: 100, cpuPercent: 8.5, memoryKb: 4096, processCount: 3 }];
    });
    const terminate = vi.fn(async () => "terminated" as const);
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-latest-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model" }]
      }],
      processFactory: (spec) => new ScriptedPiProcess(spec) as unknown as PiProcessHandle,
      processSupervisor: {
        capture: async () => privateIdentity,
        captureSync: () => privateIdentity,
        inspect,
        terminate
      }
    });
    const target: TargetDescriptor = {
      id: "target-runtime-process",
      backendId: "pi",
      displayName: "Runtime process",
      workspaceRoot: workspace,
      managed: true,
      trusted: false
    };
    const context = makeContext(target, []);
    const binding = await adapter.createSession(
      { target, fastMode: false, permissionMode: "ask" },
      context
    );

    const descriptor = await adapter.describe();
    expect(descriptor.capabilities.get("runtime.process_usage")).toMatchObject({ supported: true });
    expect(descriptor.capabilities.get("runtime.process_terminate")).toMatchObject({ supported: true });
    const sampled = await adapter.getRuntimeProcessUsage();
    expect(sampled.processes).toEqual([expect.objectContaining({
      sessionId: "session-1",
      generation: 1,
      pid: 100,
      cpuPercent: 8.5,
      memoryKb: 4096,
      processCount: 3,
      terminable: true
    })]);
    const processInstanceId = sampled.processes[0]?.processInstanceId;
    expect(processInstanceId).toMatch(/^[0-9a-f-]{36}$/iu);
    expect(JSON.stringify(sampled)).not.toContain(privateIdentity);

    await expect(adapter.terminateRuntimeProcess({
      sessionId: "session-1",
      generation: 1,
      pid: 100,
      processInstanceId: randomUUID()
    })).rejects.toMatchObject({ publicError: { code: "PI_RUNTIME_PROCESS_FENCE_MISMATCH" } });
    expect(terminate).not.toHaveBeenCalled();

    await adapter.terminateRuntimeProcess({
      sessionId: "session-1",
      generation: 1,
      pid: 100,
      processInstanceId: processInstanceId!
    });
    expect(terminate).toHaveBeenCalledWith(100, privateIdentity, 5_000);
    await expect(adapter.getState({ ...context, binding })).rejects.toMatchObject({
      publicError: { code: "PI_RUNTIME_NOT_ACTIVE" }
    });
    await expect(adapter.getRuntimeProcessUsage()).resolves.toMatchObject({ processes: [] });
    await adapter.dispose();
  });

  it("injects native ambient API-key auth into the selected native Provider generation without leaking it", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-native-ambient-auth-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-native-ambient-workspace-"));
    const credential = {
      type: "api_key" as const,
      env: {
        AWS_PROFILE: "private-engineering-profile",
        AWS_REGION: "us-west-2"
      }
    };
    const specs: PiProcessSpec[] = [];
    const events: EventPayload[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      catalogGeneration: 11,
      nativeAuthProviderIds: ["amazon-bedrock"],
      nativeAuthenticatedProviderIds: ["amazon-bedrock"],
      nativeModels: [{
        providerId: "amazon-bedrock",
        modelId: "native-bedrock-model",
        displayName: "Native Bedrock Model",
        api: "bedrock-converse-stream",
        contextWindow: 128_000,
        maxOutputTokens: 16_000,
        supportsImages: true,
        thinkingLevels: ["low", "medium", "high"],
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }
      }],
      loadNativeAuth: ({ providerIds, expectedCatalogGeneration }) => {
        expect(providerIds).toEqual(["amazon-bedrock"]);
        expect(expectedCatalogGeneration).toBe(11);
        return { catalogGeneration: 11, credentials: { "amazon-bedrock": credential } };
      },
      versionProbe: async () => "pi 99.99.99-latest-test",
      processFactory: (spec) => {
        specs.push(spec);
        return new ScriptedPiProcess(spec) as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-native-ambient-auth",
      backendId: "pi",
      displayName: "Ambient auth",
      workspaceRoot: workspace,
      managed: true,
      trusted: false
    };
    const context = makeContext(target, events);

    await expect(adapter.describe()).resolves.toMatchObject({
      authenticationState: "authenticated",
      models: expect.arrayContaining([
        expect.objectContaining({ providerId: "amazon-bedrock", modelId: "native-bedrock-model" })
      ])
    });
    const binding = await adapter.createSession({
      target,
      providerId: "amazon-bedrock",
      modelId: "native-bedrock-model",
      fastMode: false,
      permissionMode: "ask"
    }, context);
    const runtimeAgentHome = String(specs[0]?.env.PI_CODING_AGENT_DIR);
    expect(argument(specs[0]!.args, "--provider")).toBe("amazon-bedrock");
    expect(argument(specs[0]!.args, "--model")).toBe("native-bedrock-model");
    expect(JSON.parse(await readFile(join(runtimeAgentHome, "auth.json"), "utf8"))).toEqual({
      "amazon-bedrock": credential
    });
    expect(await readFile(join(runtimeAgentHome, "models.json"), "utf8")).not.toContain("amazon-bedrock");
    expect(JSON.stringify(specs[0])).not.toContain("private-engineering-profile");
    expect(await readFile(binding.opaqueRef, "utf8")).not.toContain("private-engineering-profile");

    await adapter.closeSession(binding, { ...context, binding });
    expect(JSON.stringify(events)).not.toContain("private-engineering-profile");
    await expect(access(dirname(runtimeAgentHome))).rejects.toBeDefined();
    await adapter.dispose();
  });

  it("rejects stale native auth loads and CAS persistence without leaving runtime credentials", async () => {
    const create = async (persistThrows: boolean) => {
      const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-native-auth-fence-"));
      const workspace = await mkdtemp(join(tmpdir(), "joko-pi-native-auth-fence-workspace-"));
      const specs: PiProcessSpec[] = [];
      const initial = { type: "oauth" as const, access: "vault-token-old", refresh: "vault-refresh-old", expires: 10_000 };
      const adapter = createPiAdapter({
        agentHome,
        sessionRoot: agentHome,
        catalogGeneration: 3,
        providers: [{ id: "oauth-provider", api: "openai-responses", models: [{ id: "test-model" }] }],
        nativeAuthProviderIds: ["oauth-provider"],
        loadNativeAuth: () => ({
          catalogGeneration: persistThrows ? 3 : 4,
          credentials: { "oauth-provider": initial }
        }),
        persistNativeAuth: async () => {
          throw new Error("catalog generation changed");
        },
        versionProbe: async () => "pi 99.99.99-latest-test",
        processFactory: (spec) => {
          specs.push(spec);
          return new ScriptedPiProcess(spec) as unknown as PiProcessHandle;
        }
      });
      const target: TargetDescriptor = {
        id: "target-native-auth-fence",
        backendId: "pi",
        displayName: "OAuth fence",
        workspaceRoot: workspace,
        managed: true,
        trusted: false
      };
      return { adapter, agentHome, specs, target, initial };
    };

    const staleLoad = await create(false);
    await expect(staleLoad.adapter.createSession(
      { target: staleLoad.target, fastMode: false, permissionMode: "ask" },
      makeContext(staleLoad.target, [])
    )).rejects.toMatchObject({ publicError: { code: "PI_NATIVE_AUTH_GENERATION_MISMATCH" } });
    expect(staleLoad.specs).toHaveLength(0);
    expect(await readdir(join(staleLoad.agentHome, "runtime"))).toEqual([]);
    await staleLoad.adapter.dispose();

    const stalePersist = await create(true);
    const context = makeContext(stalePersist.target, []);
    const binding = await stalePersist.adapter.createSession(
      { target: stalePersist.target, fastMode: false, permissionMode: "ask" },
      context
    );
    const runtimeAgentHome = String(stalePersist.specs[0]?.env.PI_CODING_AGENT_DIR);
    await writeFile(join(runtimeAgentHome, "auth.json"), JSON.stringify({
      "oauth-provider": { ...stalePersist.initial, access: "runtime-token-new" }
    }), { mode: 0o600 });
    await expect(stalePersist.adapter.closeSession(binding, { ...context, binding })).rejects.toMatchObject({
      publicError: { code: "PI_NATIVE_AUTH_REFRESH_OUTCOME_UNKNOWN", stateMayHaveChanged: true }
    });
    await expect(access(dirname(runtimeAgentHome))).rejects.toBeDefined();
    await stalePersist.adapter.dispose();
  });

  it("creates parented sessions without a throwaway JSONL and attaches only inspected managed sessions", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-native-start-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-native-workspace-"));
    const specs: PiProcessSpec[] = [];
    const processes: ScriptedPiProcess[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.99.99-latest-test",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model" }]
      }],
      processFactory: (spec) => {
        specs.push(spec);
        const process = new ScriptedPiProcess(spec);
        processes.push(process);
        return process as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-native",
      backendId: "pi",
      displayName: "Native",
      workspaceRoot: workspace,
      managed: true,
      trusted: true
    };
    const parentContext = { ...makeContext(target, []), sessionId: "native-parent" };
    const parent = await adapter.createSession({ target, fastMode: false, permissionMode: "ask" }, parentContext);
    await adapter.closeSession(parent, { ...parentContext, binding: parent });

    const childContext = { ...makeContext(target, []), sessionId: "native-child" };
    const before = (await adapter.listNativeSessions(workspace)).length;
    const child = await adapter.createSession({
      target,
      fastMode: false,
      permissionMode: "ask",
      nativeStart: { kind: "new", parentNativeReference: parent.opaqueRef }
    }, childContext);
    expect(processes[1]?.commands).toContainEqual(expect.objectContaining({
      type: "new_session",
      parentSession: parent.opaqueRef
    }));
    expect(specs[1]?.args).toEqual(expect.arrayContaining(["--session", parent.opaqueRef]));
    expect((await adapter.listNativeSessions(workspace)).length).toBe(before + 1);
    await adapter.closeSession(child, { ...childContext, binding: child });

    const attachedContext = { ...makeContext(target, []), sessionId: "native-attached" };
    const attached = await adapter.createSession({
      target,
      fastMode: false,
      permissionMode: "ask",
      nativeStart: { kind: "attach", nativeReference: parent.opaqueRef }
    }, attachedContext);
    expect(attached.opaqueRef).toBe(parent.opaqueRef);
    expect(specs[2]?.args).toEqual(expect.arrayContaining(["--session", parent.opaqueRef]));
    expect(processes[2]?.commands).toContainEqual(expect.objectContaining({
      type: "switch_session",
      sessionPath: parent.opaqueRef
    }));
    await adapter.dispose();
  });
});

describe("managed resource precedence", () => {
  it("deduplicates by stable source identity with project-over-global precedence and immutable output", () => {
    const globalPath = join(tmpdir(), "joko-global-same-package");
    const targetPath = join(tmpdir(), "joko-project-same-package");
    const sameNameOtherIdentityPath = join(tmpdir(), "joko-global-same-name-other-identity");
    const unrelatedPath = join(tmpdir(), "joko-global-unrelated-extension");
    const global = {
      extensions: [unrelatedPath],
      skills: [],
      prompts: [],
      packages: [globalPath, sameNameOtherIdentityPath],
      resources: [{
        id: "global-package-v1",
        kind: "package" as const,
        name: "same-package",
        source: "npm:same-package",
        state: "approved" as const,
        runtimePath: globalPath,
        detail: "version 1.0.0"
      }, {
        id: "global-other-package",
        kind: "package" as const,
        name: "same-package",
        source: "npm:other-package",
        state: "approved" as const,
        runtimePath: sameNameOtherIdentityPath
      }]
    };
    const target = {
      extensions: [],
      skills: [],
      prompts: [],
      packages: [targetPath],
      resources: [{
        id: "project-package-v2",
        kind: "package" as const,
        name: "same-package",
        source: "npm:same-package",
        state: "approved" as const,
        runtimePath: targetPath,
        detail: "version 2.0.0"
      }]
    };

    const merged = mergeManagedResourceSnapshots(global, target);
    expect(merged.packages).toEqual([targetPath, sameNameOtherIdentityPath]);
    expect(merged.extensions).toEqual([unrelatedPath]);
    expect(merged.resources).toMatchObject([
      { id: "project-package-v2", source: "npm:same-package" },
      { id: "global-other-package", source: "npm:other-package" }
    ]);

    (target.resources[0] as { detail: string }).detail = "mutated after snapshot";
    (target.packages as string[]).push(join(tmpdir(), "late-package"));
    expect(merged.resources?.[0]?.detail).toBe("version 2.0.0");
    expect(merged.packages).toEqual([targetPath, sameNameOtherIdentityPath]);
  });

  it("passes only the project package to Pi argv and runtime resources for the same identity", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-resource-precedence-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-resource-precedence-workspace-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "joko-pi-resource-precedence-source-"));
    const globalPackage = join(sourceRoot, "global-package");
    const projectPackage = join(sourceRoot, "project-package");
    await Promise.all([
      mkdir(join(globalPackage, "extensions"), { recursive: true }),
      mkdir(join(projectPackage, "extensions"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(globalPackage, "package.json"), JSON.stringify({ pi: { extensions: ["extensions/global.ts"] } })),
      writeFile(join(globalPackage, "extensions", "global.ts"), "export default () => 'global';\n"),
      writeFile(join(projectPackage, "package.json"), JSON.stringify({ pi: { extensions: ["extensions/project.ts"] } })),
      writeFile(join(projectPackage, "extensions", "project.ts"), "export default () => 'project';\n")
    ]);
    const specs: PiProcessSpec[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      managedResources: {
        extensions: [], skills: [], prompts: [], packages: [globalPackage],
        resources: [{
          id: "global-v1", kind: "package", name: "same", source: "npm:same", state: "approved", runtimePath: globalPackage
        }]
      },
      resolveTargetResources: () => ({
        extensions: [], skills: [], prompts: [], packages: [projectPackage],
        resources: [{
          id: "project-v2", kind: "package", name: "same", source: "npm:same", state: "approved", runtimePath: projectPackage
        }]
      }),
      versionProbe: async () => "pi 99.99.99-latest-test",
      processFactory: (spec) => {
        specs.push(spec);
        return new ScriptedPiProcess(spec) as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "target-precedence",
      backendId: "pi",
      displayName: "Precedence",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    };
    const context = makeContext(target, []);
    const binding = await adapter.createSession({
      target,
      providerId: "local",
      modelId: "test-model",
      fastMode: false,
      permissionMode: "ask"
    }, context);
    const extensions = valuesForArgument(specs[0]!.args, "--extension");
    expect(extensions.some((path) => path.endsWith("project.ts"))).toBe(true);
    expect(extensions.some((path) => path.endsWith("global.ts"))).toBe(false);
    const resources = await adapter.getResources({ ...context, binding });
    expect(resources.some((resource) => resource.id === "project-v2")).toBe(true);
    expect(resources.some((resource) => resource.id === "global-v1")).toBe(false);
    await adapter.dispose();
  });

  it("does not trust a custom executable that only returns a semantic version", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-custom-compatibility-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-custom-compatibility-workspace-"));
    const command = join(agentHome, "custom-pi.exe");
    await writeFile(command, "not a compatible RPC executable\n");
    let spawns = 0;
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      command,
      versionProbe: async () => "pi 99.99.99",
      startupTimeoutMs: 250,
      shutdownTimeoutMs: 250,
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      processFactory: (spec) => {
        spawns += 1;
        return new ScriptedPiProcess(spec) as unknown as PiProcessHandle;
      }
    });
    const target: TargetDescriptor = {
      id: "custom-compatibility-target",
      backendId: "pi",
      displayName: "Custom executable",
      workspaceRoot: workspace,
      managed: true,
      trusted: false
    };
    const context = makeContext(target, []);
    try {
      const descriptor = await adapter.describe();
      expect(descriptor).toMatchObject({ installationState: "installed", health: "unavailable" });
      expect(descriptor.capabilities.get("input.text")).toMatchObject({
        supported: false,
        reason: "upstream_missing"
      });
      expect(descriptor.diagnostics).toEqual(expect.arrayContaining([
        expect.stringContaining("PI_EXECUTABLE_INCOMPATIBLE")
      ]));

      await expect(adapter.createSession({
        target,
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask"
      }, context)).rejects.toMatchObject({ publicError: { code: "PI_EXECUTABLE_INCOMPATIBLE" } });
      expect(spawns).toBe(1);
    } finally {
      await adapter.dispose();
    }
  });

  it("caches a custom executable probe by identity and downgrades rejected get_tree capabilities", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-pi-custom-tree-home-"));
    const script = join(agentHome, "compatible-rpc.mjs");
    const marker = join(agentHome, "probe-spawns.log");
    await writeFile(script, compatibilityExecutableSource());
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      command: process.execPath,
      commandArgs: [script, marker],
      versionProbe: async () => "pi 99.99.99",
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 1_000,
      providers: []
    });
    try {
      const first = await adapter.describe();
      const second = await adapter.describe();
      expect(first.health).toBe("degraded");
      expect(first.capabilities.get("session.tree")).toMatchObject({
        supported: false,
        reason: "upstream_missing"
      });
      expect(first.capabilities.get("input.text")).toMatchObject({ supported: true });
      expect(second.capabilities.get("session.tree")).toEqual(first.capabilities.get("session.tree"));
      expect((await readFile(marker, "utf8")).trim().split(/\r?\n/u)).toHaveLength(1);
    } finally {
      await adapter.dispose();
    }
  });
});

function makeContext(target: TargetDescriptor, events: EventPayload[]): AdapterContext {
  return {
    sessionId: "session-1",
    generation: 1,
    target,
    signal: new AbortController().signal,
    emit: async (payload) => {
      events.push(payload);
    },
    requestInteraction: async () => ({ kind: "confirmed", confirmed: true }),
    artifactCapacityBytes: 256 * 1024 * 1024,
    storeArtifact: async (sourcePath, options) => {
      const data = Buffer.from(sourcePath);
      return {
        id: `artifact-${events.length}`,
        sha256: createHash("sha256").update(data).digest("hex"),
        byteLength: data.length,
        mimeType: options?.mimeType ?? "application/octet-stream",
        fileName: options?.fileName
      };
    }
  };
}

async function flushAdapterEvents(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitForAdapterCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Adapter condition did not become true in time.");
}

function argument(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0 || !value) throw new Error(`Missing ${name}`);
  return value;
}

function valuesForArgument(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === name) values.push(args[index + 1]!);
  }
  return values;
}

function managedBridgePath(spec: PiProcessSpec): string {
  const path = valuesForArgument(spec.args, "--extension")
    .findLast((candidate) => candidate.replace(/\\/gu, "/").endsWith("/joko-managed-bridge.ts"));
  if (path === undefined) throw new Error("Managed bridge extension path is missing from the Pi process spec.");
  return path;
}

function managedSubagentPath(spec: PiProcessSpec): string {
  const path = optionalManagedSubagentPath(spec);
  if (path === undefined) throw new Error("Managed subagent extension path is missing from the Pi process spec.");
  return path;
}

function optionalManagedSubagentPath(spec: PiProcessSpec): string | undefined {
  const path = valuesForArgument(spec.args, "--extension")
    .find((candidate) => candidate.replace(/\\/gu, "/").endsWith("/joko-managed-subagent.ts"));
  return path;
}

function optionalArgument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function blob(id: string): BlobRef {
  return { id, sha256: "0".repeat(64), byteLength: 5, mimeType: "text/plain", fileName: "input.txt" };
}

async function writeDurableSubagentControlFixture(
  agentHome: string,
  productSessionId: string,
  productGeneration: number,
  taskId: string,
  state: "running" | "completed" = "running"
): Promise<string> {
  const runId = randomUUID();
  const launchToken = randomUUID();
  const runnerInstanceId = randomUUID();
  const runnerPid = state === "completed" ? 999_999_999 : process.pid;
  const runDirectory = join(agentHome, "subagent-runs", managedSubagentSessionKey(productSessionId), runId);
  const runnerScript = join(runDirectory, "joko-managed-subagent-runner.cjs");
  const runnerScriptSource = "fixture runner\n";
  const runnerScriptSha256 = createHash("sha256").update(runnerScriptSource).digest("hex");
  const transcriptPath = join(runDirectory, "transcript.jsonl");
  const nativeSessionId = randomUUID();
  const nativeSessionPath = join(runDirectory, "sessions", `${nativeSessionId}.jsonl`);
  await mkdir(join(runDirectory, "sessions"), { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(runnerScript, runnerScriptSource, { mode: 0o600 }),
    writeFile(join(runDirectory, "config.json"), `${JSON.stringify({
      format: 1,
      runId,
      launchToken,
      runDir: runDirectory,
      runnerScript,
      runnerScriptSha256,
      productSessionId,
      productGeneration,
      parentTaskId: "parent-call",
      taskId,
      route: { provider: "local", model: "test-model", effort: "medium" },
      turnCount: 1,
      transcriptPath
    })}\n`, { mode: 0o600 }),
    writeFile(join(runDirectory, "owner.json"), `${JSON.stringify({
      format: 1,
      runId,
      launchToken,
      productSessionId,
      taskId,
      runnerScript,
      runnerScriptSha256,
      state: "running",
      runnerPid,
      runnerInstanceId
    })}\n`, { mode: 0o600 }),
    writeFile(join(runDirectory, "status.json"), `${JSON.stringify({
      format: 1,
      runId,
      launchToken,
      productSessionId,
      parentTaskId: "parent-call",
      taskId,
      agentName: "scout",
      task: "Inspect the fixture",
      runnerScript,
      runnerScriptSha256,
      runnerPid,
      runnerInstanceId,
      state,
      summary: state,
      createdAt: 1,
      startedAt: 2,
      heartbeatAt: Date.now(),
      ...(state === "completed" ? { endedAt: 3, nativeSessionId, nativeSessionPath } : {}),
      transcriptPath,
      turnCount: 1,
      usage: {},
      toolUses: 0,
      durationMs: 1
    })}\n`, { mode: 0o600 }),
    writeFile(join(runDirectory, "runner.claim.json"), `${JSON.stringify({
      format: 1,
      runId,
      launchToken,
      runnerPid,
      runnerInstanceId,
      runnerScriptSha256
    })}\n`, { mode: 0o600 }),
    writeFile(transcriptPath, `${JSON.stringify({ type: "joko.subagent.parent", message: "Inspect the fixture", at: 1 })}\n`, { mode: 0o600 }),
    ...(state === "completed" ? [
      writeFile(nativeSessionPath, "{}\n", { mode: 0o600 }),
      writeFile(join(runDirectory, "result.json"), `${JSON.stringify({
        format: 1,
        runId,
        launchToken,
        taskId,
        state,
        result: "completed"
      })}\n`, { mode: 0o600 })
    ] : [])
  ]);
  return runDirectory;
}

function compatibilityExecutableSource(): string {
  return [
    'import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";',
    'import { basename, join } from "node:path";',
    'const marker = process.argv[2];',
    'const args = process.argv.slice(3);',
    'const value = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };',
    'const extensions = args.flatMap((item, index) => item === "--extension" ? [args[index + 1]] : []).filter(Boolean);',
    'const extension = extensions.at(-1);',
    'const compatibility = extension && basename(extension) === "compatibility-extension.mjs";',
    'const sessionDirectory = value("--session-dir");',
    'const sessionId = value("--session-id") || "native";',
    'mkdirSync(sessionDirectory, { recursive: true });',
    'const sessionFile = join(sessionDirectory, sessionId + ".jsonl");',
    'writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\\n");',
    'appendFileSync(marker, "spawn\\n");',
    'const send = (record) => process.stdout.write(JSON.stringify(record) + "\\n");',
    'if (compatibility) send({ type: "extension_ui_request", id: "status", method: "setStatus", statusKey: "joko-compatibility/v1", statusText: JSON.stringify({ format: 1, terminalEvent: "agent_settled" }) });',
    'let pending = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { pending += chunk; let index; while ((index = pending.indexOf("\\n")) >= 0) { const command = JSON.parse(pending.slice(0, index)); pending = pending.slice(index + 1); handle(command); } });',
    'process.stdin.on("end", () => process.exit(0));',
    'process.on("SIGTERM", () => process.exit(0));',
    'function success(command, data) { send({ type: "response", id: command.id, command: command.type, success: true, ...(data === undefined ? {} : { data }) }); }',
    'function handle(command) {',
    '  if (command.type === "get_state") return success(command, { model: { provider: "local", id: "model" }, thinkingLevel: "off", isStreaming: false, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", sessionFile, sessionId, autoCompactionEnabled: false, messageCount: 0, pendingMessageCount: 0 });',
    '  if (command.type === "get_commands") return success(command, { commands: compatibility ? [{ name: "joko-compatibility", source: "extension", sourceInfo: { path: extension } }] : [] });',
    '  if (command.type === "get_tree") return send({ type: "response", id: command.id, command: command.type, success: false, error: "unsupported" });',
    '  if (command.type === "get_entries") return success(command, { entries: [], leafId: null });',
    '  if (command.type === "get_messages") return success(command, { messages: [] });',
    '  if (command.type === "get_available_models") return success(command, { models: [] });',
    '  if (command.type === "get_available_thinking_levels") return success(command, { levels: ["off"] });',
    '  if (command.type === "get_session_stats") return success(command, { tokens: {}, cost: 0 });',
    '  if (command.type === "get_fork_messages") return success(command, { messages: [] });',
    '  if (command.type === "get_last_assistant_text") return success(command, { text: null });',
    '  if (command.type === "prompt") { success(command); send({ type: "agent_start" }); send({ type: "agent_end", messages: [], willRetry: false }); send({ type: "agent_settled" }); return; }',
    '  success(command);',
    '}',
    ''
  ].join("\n");
}
