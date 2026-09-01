import { randomUUID } from "node:crypto";
import {
  JokoError,
  type AdapterContext,
  type BackendAdapter,
  type BackendDescriptor,
  type BackendToolDescriptor,
  type BlobRef,
  type Capability,
  type ContextRebuildInput,
  type CreateNativeSessionInput,
  type NativeSessionBinding,
  type NativeSessionCandidate,
  type NativeSessionForkResult,
  type NativeSessionState,
  type PermissionMode,
  type PromptInput,
  type ProviderModel,
  type RuntimeCommand,
  type RuntimeResource,
  type SessionTree,
  type TargetDescriptor,
  type UserShellInput,
  type UserShellResult
} from "@joko/core";

export interface FakeAdapterProfile {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly Capability[];
  readonly models: readonly ProviderModel[];
  readonly tools: readonly BackendToolDescriptor[];
  readonly permissionModes: readonly PermissionMode[];
  readonly nativeSessions?: readonly NativeSessionCandidate[];
  readonly streamDelayMs?: number;
}

interface FakeSession {
  binding: NativeSessionBinding;
  name: string;
  providerId?: string;
  modelId?: string;
  effort?: string;
  fastMode: boolean;
  permissionMode: PermissionMode;
  planMode: boolean;
  streaming: boolean;
  compacting: boolean;
  aborted: boolean;
  messages: string[];
  leafId: string;
}

export class FakeBackendAdapter implements BackendAdapter {
  readonly id: string;
  readonly profile: FakeAdapterProfile;
  readonly #sessions = new Map<string, FakeSession>();
  readonly #faults = new Map<string, "crash" | "hang" | "dispatch_unknown">();
  readonly #hungDispatchInterruptions = new Set<() => void>();
  #disposed = false;

  constructor(profile: FakeAdapterProfile) {
    this.id = profile.id;
    this.profile = profile;
  }

  injectFault(sessionId: string, fault: "crash" | "hang" | "dispatch_unknown"): void {
    this.#faults.set(sessionId, fault);
  }

  clearFault(sessionId: string): void {
    this.#faults.delete(sessionId);
  }

  async describe(): Promise<BackendDescriptor> {
    return {
      id: this.id,
      adapterKind: "fake",
      instanceGeneration: 0,
      displayName: this.profile.displayName,
      version: "test-1",
      health: this.#disposed ? "unavailable" : "healthy",
      installationState: "installed",
      authenticationState: "not_required",
      capabilities: new Map(this.profile.capabilities.map((capability) => [capability.key, capability])),
      models: this.profile.models,
      tools: this.profile.tools,
      diagnostics: []
    };
  }

  async validateTarget(target: TargetDescriptor): Promise<void> {
    this.assertOpen();
    if (target.backendId !== this.id) throw new Error("Fake target uses a different Backend.");
  }

  async listNativeSessions(target: TargetDescriptor): Promise<readonly NativeSessionCandidate[]> {
    await this.validateTarget(target);
    if (!supported(this.profile.capabilities, "session.discovery")) throw unsupported("session.discovery");
    return this.profile.nativeSessions ?? [];
  }

  async resolveNativeSessionReference(
    nativeReference: string,
    target: TargetDescriptor,
    generation: number
  ): Promise<NativeSessionBinding> {
    await this.validateTarget(target);
    if (!supported(this.profile.capabilities, "session.resume")) throw unsupported("session.resume");
    const candidate = this.profile.nativeSessions?.find((item) => item.nativeReference === nativeReference);
    if (candidate === undefined || candidate.state !== "ready") {
      throw new JokoError({
        code: "NATIVE_SESSION_UNAVAILABLE",
        message: "The fake native session is unavailable.",
        phase: "session",
        retryable: false,
        stateMayHaveChanged: false,
        recovery: "Refresh native session discovery before attaching."
      });
    }
    return {
      opaqueRef: candidate.nativeReference,
      ...(candidate.nativeSessionId === undefined ? {} : { nativeSessionId: candidate.nativeSessionId }),
      generation
    };
  }

  async createSession(input: CreateNativeSessionInput, context: AdapterContext): Promise<NativeSessionBinding> {
    await this.validateTarget(input.target);
    const binding = input.nativeStart?.kind === "attach"
      ? await this.resolveNativeSessionReference(input.nativeStart.nativeReference, input.target, context.generation)
      : { opaqueRef: `fake://${this.id}/${context.sessionId}`, nativeSessionId: randomUUID(), generation: context.generation };
    this.#sessions.set(context.sessionId, {
      binding,
      name: input.name ?? "Fake task",
      providerId: input.providerId,
      modelId: input.modelId,
      effort: input.effort,
      fastMode: input.fastMode,
      permissionMode: input.permissionMode,
      planMode: false,
      streaming: false,
      compacting: false,
      aborted: false,
      messages: [],
      leafId: "root"
    });
    return binding;
  }

  async resumeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    let session = this.#sessions.get(context.sessionId);
    if (session === undefined) {
      session = {
        binding: { ...binding, generation: context.generation },
        name: "Resumed fake task",
        permissionMode: "ask",
        fastMode: false,
        planMode: false,
        streaming: false,
        compacting: false,
        aborted: false,
        messages: [],
        leafId: "root"
      };
      this.#sessions.set(context.sessionId, session);
    }
    session.binding = { ...session.binding, generation: context.generation };
    return this.inspectSession(session.binding, context);
  }

  async inspectSession(_binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    const session = this.session(context.sessionId);
    return {
      binding: session.binding,
      name: session.name,
      streaming: session.streaming,
      compacting: session.compacting,
      pendingMessages: 0,
      providerId: session.providerId,
      modelId: session.modelId,
      effort: session.effort,
      fastMode: session.fastMode,
      permissionMode: session.permissionMode,
      usage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 20, contextTokens: 20, contextWindow: 32_000, cost: 0.001 }
    };
  }

  async detachSession(_binding: NativeSessionBinding, _context: AdapterContext): Promise<void> {}

  async closeSession(_binding: NativeSessionBinding, _context: AdapterContext): Promise<void> {}

  async deleteSession(_binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    this.#sessions.delete(context.sessionId);
  }

  async send(input: PromptInput, context: AdapterContext): Promise<void> {
    const session = this.session(context.sessionId);
    const fault = this.#faults.get(context.sessionId);
    if (fault === "crash") throw fakeError("FAKE_CRASH", false);
    if (fault === "dispatch_unknown") throw fakeError("FAKE_DISPATCH_UNKNOWN", true);
    if (fault === "hang") {
      let interrupt!: () => void;
      return new Promise<void>((_resolve, reject) => {
        interrupt = () => reject(new Error("Fake Backend was disposed during a hung dispatch."));
        this.#hungDispatchInterruptions.add(interrupt);
      }).finally(() => {
        this.#hungDispatchInterruptions.delete(interrupt);
      });
    }
    if (input.disposition === "steer" && !supported(this.profile.capabilities, "turn.steer")) {
      throw unsupported("turn.steer");
    }
    if (input.disposition === "follow_up" && !supported(this.profile.capabilities, "turn.follow_up")) {
      throw unsupported("turn.follow_up");
    }
    session.messages.push(input.text);
    session.streaming = true;
    session.aborted = false;
    queueMicrotask(() => void this.streamReply(input.text, context, session));
  }

  async abort(context: AdapterContext): Promise<void> {
    const session = this.session(context.sessionId);
    session.aborted = true;
    session.streaming = false;
    await context.emit({ type: "done", outcome: "aborted" });
  }

  async setModel(providerId: string, modelId: string, context: AdapterContext): Promise<ProviderModel> {
    const model = this.profile.models.find((candidate) => candidate.providerId === providerId && candidate.modelId === modelId);
    if (model === undefined) throw new Error("Fake model is unavailable.");
    const session = this.session(context.sessionId);
    session.providerId = providerId;
    session.modelId = modelId;
    return model;
  }

  async setEffort(level: string, context: AdapterContext): Promise<void> {
    this.session(context.sessionId).effort = level;
  }

  async setFastMode(enabled: boolean, context: AdapterContext): Promise<void> {
    const session = this.session(context.sessionId);
    if (enabled) {
      const selected = this.profile.models.find((model) =>
        model.providerId === session.providerId && model.modelId === session.modelId);
      if (selected?.supportsFastMode !== true || !supported(this.profile.capabilities, "model.fast_mode")) {
        throw unsupported("model.fast_mode");
      }
    }
    session.fastMode = enabled;
  }

  async setPermissionMode(mode: PermissionMode, context: AdapterContext): Promise<void> {
    if (!this.profile.permissionModes.includes(mode)) throw unsupported("permission.modes");
    this.session(context.sessionId).permissionMode = mode;
  }

  async setPlanMode(enabled: boolean, context: AdapterContext): Promise<void> {
    if (!supported(this.profile.capabilities, "plan_mode")) throw unsupported("plan_mode");
    this.session(context.sessionId).planMode = enabled;
  }

  async compact(_customInstructions: string | undefined, context: AdapterContext): Promise<"compacted" | "noop"> {
    if (!supported(this.profile.capabilities, "context.compact")) throw unsupported("context.compact");
    const compactionId = `fake-compaction-${randomUUID()}`;
    await context.emit({ type: "compaction", compactionId, state: "started", reason: "fake" });
    await context.emit({ type: "compaction", compactionId, state: "completed", reason: "fake", summary: "Fake context summary" });
    return "compacted";
  }

  async setAutoCompaction(_enabled: boolean, _context: AdapterContext): Promise<void> {}
  async setAutoRetry(_enabled: boolean, _context: AdapterContext): Promise<void> {}
  async abortRetry(_context: AdapterContext): Promise<void> {}

  async exportSession(context: AdapterContext): Promise<BlobRef> {
    if (!supported(this.profile.capabilities, "session.export")) throw unsupported("session.export");
    return { id: `export-${context.sessionId}`, sha256: "0".repeat(64), byteLength: 0, mimeType: "text/html", fileName: "fake.html" };
  }

  async getTree(context: AdapterContext): Promise<SessionTree> {
    if (!supported(this.profile.capabilities, "session.tree")) throw unsupported("session.tree");
    const session = this.session(context.sessionId);
    return { roots: [{ entryId: "root", kind: "root", label: session.name, timestamp: 0, children: [] }], leafId: session.leafId };
  }

  async navigateTree(entryId: string, _summarize: boolean, context: AdapterContext, _customInstructions?: string): Promise<void> {
    if (!supported(this.profile.capabilities, "session.rewind")) throw unsupported("session.rewind");
    this.session(context.sessionId).leafId = entryId;
  }

  async fork(entryId: string, context: AdapterContext): Promise<NativeSessionForkResult> {
    if (!supported(this.profile.capabilities, "session.fork")) throw unsupported("session.fork");
    return {
      binding: {
        opaqueRef: `fake://${this.id}/${context.sessionId}/fork/${entryId}`,
        nativeSessionId: randomUUID(),
        generation: context.generation
      }
    };
  }

  async clone(context: AdapterContext): Promise<NativeSessionBinding> {
    if (!supported(this.profile.capabilities, "session.fork")) throw unsupported("session.clone");
    const nativeSessionId = randomUUID();
    return {
      opaqueRef: `fake://${this.id}/${context.sessionId}/clone/${nativeSessionId}`,
      nativeSessionId,
      generation: context.generation
    };
  }

  async rebuildContext(input: ContextRebuildInput, context: AdapterContext): Promise<NativeSessionBinding> {
    if (!supported(this.profile.capabilities, "session.message_delete")) {
      throw unsupported("session.message_delete");
    }
    const session = this.session(context.sessionId);
    const nativeSessionId = randomUUID();
    const binding = {
      opaqueRef: `fake://${this.id}/${context.sessionId}/rebuild/${nativeSessionId}`,
      nativeSessionId,
      generation: Math.max(context.generation, session.binding.generation) + 1
    };
    session.binding = binding;
    session.messages = input.messages.map((message) => `${message.role}:${message.blocks
      .filter((block) => block.kind === "text")
      .map((block) => block.kind === "text" ? block.text : "")
      .join("\n")}`);
    return binding;
  }

  async resetContext(context: AdapterContext): Promise<NativeSessionBinding> {
    if (!supported(this.profile.capabilities, "session.reset")) throw unsupported("session.reset");
    const session = this.session(context.sessionId);
    const nativeSessionId = randomUUID();
    const binding = {
      opaqueRef: `fake://${this.id}/${context.sessionId}/reset/${nativeSessionId}`,
      nativeSessionId,
      generation: Math.max(context.generation, session.binding.generation) + 1
    };
    session.binding = binding;
    session.messages = [];
    session.leafId = "root";
    session.streaming = false;
    session.compacting = false;
    session.aborted = false;
    return binding;
  }

  async setName(name: string, context: AdapterContext): Promise<void> {
    this.session(context.sessionId).name = name;
  }

  async getCommands(_context: AdapterContext): Promise<readonly RuntimeCommand[]> {
    return [{ name: "review", description: "Run a fake review", source: "extension", loaded: true }];
  }

  async getResources(_context: AdapterContext): Promise<readonly RuntimeResource[]> {
    return [{ id: "fake-skill", kind: "skill", name: "Fake skill", source: "managed", state: "loaded" }];
  }

  async executeUserShell(input: UserShellInput, context: AdapterContext): Promise<UserShellResult> {
    if (!supported(this.profile.capabilities, "runtime.user_shell")) throw unsupported("runtime.user_shell");
    this.session(context.sessionId);
    return { output: `fake shell: ${input.command}`, exitCode: 0, cancelled: false, truncated: false };
  }

  async abortUserShell(context: AdapterContext): Promise<void> {
    if (!supported(this.profile.capabilities, "runtime.user_shell")) throw unsupported("runtime.user_shell");
    this.session(context.sessionId);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const interrupt of this.#hungDispatchInterruptions) interrupt();
    this.#hungDispatchInterruptions.clear();
    this.#sessions.clear();
  }

  private async streamReply(prompt: string, context: AdapterContext, session: FakeSession): Promise<void> {
    if ((this.profile.streamDelayMs ?? 0) > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, this.profile.streamDelayMs));
    if (session.aborted) return;
    const blockId = randomUUID();
    await context.emit({ type: "text_delta", blockId, delta: `Reply from ${this.id}: ` });
    await context.emit({ type: "text_delta", blockId, delta: prompt });
    await context.emit({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: `Reply from ${this.id}: ${prompt}` }] });
    session.streaming = false;
    await context.emit({ type: "done", outcome: "completed" });
  }

  private session(id: string): FakeSession {
    this.assertOpen();
    const session = this.#sessions.get(id);
    if (session === undefined) throw new Error(`Fake task '${id}' is not active.`);
    return session;
  }

  private assertOpen(): void {
    if (this.#disposed) throw new Error("Fake Backend is disposed.");
  }
}

function supported(capabilities: readonly Capability[], name: string): boolean {
  return capabilities.some((capability) => capability.key === name && capability.supported);
}

function unsupported(capability: string): JokoError {
  return new JokoError({
    code: "CAPABILITY_UNSUPPORTED",
    message: `Capability '${capability}' is unsupported by this Backend.`,
    phase: "capability",
    retryable: false,
    stateMayHaveChanged: false,
    recovery: "Use the capability manifest to choose an available action."
  });
}

function fakeError(code: string, stateMayHaveChanged: boolean): JokoError {
  return new JokoError({
    code,
    message: code,
    phase: "dispatch",
    retryable: !stateMayHaveChanged,
    stateMayHaveChanged,
    recovery: stateMayHaveChanged ? "Reconcile before retrying." : "Retry safely."
  });
}
