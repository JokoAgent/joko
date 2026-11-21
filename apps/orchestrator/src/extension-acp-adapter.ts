import { createHash, randomUUID } from "node:crypto";
import type { RpcTransport, RpcTransportHandlers } from "@joko/adapter-codex";
import {
  CAPABILITIES, CapabilityDrivenBackendAdapter, JokoError, NATIVE_PROMPT_IMAGE_MEDIA_TYPES, redactSecrets,
  type AdapterContext, type BackendDescriptor, type BlobRef, type Capability, type CreateNativeSessionInput,
  type MessageBlock, type NativeSessionBinding, type NativeSessionState, type PermissionMode, type PromptInput,
  type ProviderModel, type TargetDescriptor, type UsageSnapshot
} from "@joko/core";

type RpcValue = Parameters<RpcTransport["respond"]>[1];
type ServerRequest = Parameters<RpcTransportHandlers["onRequest"]>[0];
type Notification = Parameters<RpcTransportHandlers["onNotification"]>[0];

const ACP_PROTOCOL_VERSION = 1;
export const ACP_ENGINE_KIND = "plugin-acp";
const DEFAULT_MODEL = "default";
const MAXIMUM_REPLY_CHARS = 1_000_000;
const MAXIMUM_IMAGE_BYTES = 8 * 1024 * 1024;
const STOP_GRACE_MS = 5_000;
const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export interface ExtensionAcpProcess {
  readonly transport: RpcTransport;
  readonly assertCurrent: () => void;
  readonly release: () => Promise<void>;
}

export interface ExtensionAcpAdapterOptions {
  readonly id: string;
  readonly generation: number;
  readonly name: string;
  readonly version?: string;
  readonly approved: () => boolean;
  readonly open: (context: AdapterContext) => Promise<ExtensionAcpProcess>;
  readonly readBlob: (blob: BlobRef) => Promise<Uint8Array>;
  readonly catalogChanged: (observed: unknown) => void;
}

interface ConfigOption {
  readonly id: string;
  readonly category: string;
  readonly value: string;
  readonly choices: readonly { readonly value: string; readonly name: string }[];
}

interface AcpTurn {
  readonly context: AdapterContext;
  readonly controller: AbortController;
  readonly blockId: string;
  readonly tools: Map<string, string>;
  readonly blocks: Array<Extract<MessageBlock, { kind: "text" | "thinking" }>>;
  totalCharacters: number;
  cancelTimer?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
}

interface AcpLiveSession {
  readonly owner: ExtensionAcpProcess;
  readonly drainNotifications: () => Promise<void>;
  readonly canResume: "session/load" | "session/resume" | undefined;
  readonly canUseImages: boolean;
  readonly binding: NativeSessionBinding;
  permissionMode: PermissionMode;
  config: readonly ConfigOption[];
  usage?: UsageSnapshot;
  turn?: AcpTurn;
  closing?: Promise<void>;
}

export class ExtensionAcpAdapter extends CapabilityDrivenBackendAdapter {
  readonly id: string;
  private readonly providerId: string;
  private readonly sessions = new Map<string, AcpLiveSession>();
  private readonly opening = new Map<string, { readonly controller: AbortController; readonly result: Promise<AcpLiveSession> }>();
  private readonly pendingCleanup = new Set<ExtensionAcpProcess>();
  private readonly confirmedIdleExits = new Set<string>();
  private version: string;
  private capabilityState = { resume: false, images: false, model: false, effort: false, modes: ["ask", "bypassPermissions"] as readonly PermissionMode[] };
  private models: readonly ProviderModel[] = [];
  private disposed = false;

  constructor(private readonly options: ExtensionAcpAdapterOptions) {
    super();
    this.id = options.id;
    this.providerId = options.id;
    this.version = options.version ?? "";
  }

  async describe(): Promise<BackendDescriptor> {
    const ready = !this.disposed && this.options.approved();
    const state = this.capabilityState;
    return {
      id: this.id, adapterKind: ACP_ENGINE_KIND, instanceGeneration: this.options.generation,
      displayName: this.options.name, version: this.version,
      health: ready ? "healthy" : "unavailable", installationState: "installed", authenticationState: ready ? "not_required" : "error",
      models: ready ? [this.model(DEFAULT_MODEL, this.options.name, state.images), ...this.models] : [],
      tools: [], diagnostics: [],
      capabilities: new Map(CAPABILITIES.map(key => {
        const options = key === "permission.modes" ? state.modes : undefined;
        const supported = ready && (
          ["turn.stream", "turn.abort", "turn.graceful_stop", "input.text", "model.list", "permission.modes", "permission.change", "interaction.permission"].includes(key)
          || ((key === "session.resume" || key === "session.detach") && state.resume)
          || (key === "input.image" && state.images)
          || (key === "model.switch" && state.model)
          || (key === "model.effort" && state.effort)
        );
        return [key, { key, supported, ...(supported ? {} : { reason: "upstream_missing" }), ...(options === undefined ? {} : { options }) } satisfies Capability] as const;
      }))
    };
  }

  async validateTarget(target: TargetDescriptor): Promise<void> {
    if (this.disposed || !this.options.approved() || target.backendId !== this.id || target.remoteWorkspace !== undefined) {
      throw acpError("ACP_ENGINE_UNAVAILABLE", "This task engine requires its current local plugin approval.");
    }
  }

  async createSession(input: CreateNativeSessionInput, context: AdapterContext): Promise<NativeSessionBinding> {
    if (input.nativeStart !== undefined && (input.nativeStart.kind !== "new" || input.nativeStart.parentNativeReference !== undefined) ||
      input.fastMode !== false || !this.capabilityState.modes.includes(input.permissionMode) ||
      input.providerId !== undefined && input.providerId !== this.providerId) {
      throw acpError("ACP_SELECTION_UNAVAILABLE", "The task engine does not support this native session selection.");
    }
    input.assertNativeCreationCurrent?.();
    const session = await this.open(context, undefined, input.permissionMode, input.assertNativeCreationCurrent);
    try {
      input.assertNativeCreationCurrent?.();
      if (input.modelId !== undefined && input.modelId !== DEFAULT_MODEL) await this.configure(session, "model", input.modelId);
      if (input.effort !== undefined && input.effort !== "off") await this.configureEffort(session, input.effort);
      session.owner.assertCurrent();
      this.publish(session);
      return session.binding;
    } catch (error) {
      await this.stop(context.sessionId, session, true);
      throw error;
    }
  }

  async resumeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    const nativeId = this.nativeId(binding, context);
    const current = this.sessions.get(context.sessionId);
    if (current !== undefined && current.binding.opaqueRef !== binding.opaqueRef) {
      throw acpError("ACP_SESSION_UNAVAILABLE", "The native task binding changed.");
    }
    const session = current ?? await this.open(context, nativeId, "ask");
    return this.state(session);
  }

  override async inspectSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    const session = this.exactSession(context);
    this.nativeId(binding, context);
    return this.state(session);
  }

  hasConfirmedIdleSessionExit(sessionId: string, binding: NativeSessionBinding): boolean {
    return this.confirmedIdleExits.has(JSON.stringify([sessionId, binding.opaqueRef, binding.generation]));
  }

  async closeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    this.nativeId(binding, context);
    const session = this.sessions.get(context.sessionId);
    if (session !== undefined) await this.stop(context.sessionId, session, false);
  }

  override async detachSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    await this.closeSession(binding, context);
  }

  async setModel(providerId: string, modelId: string, context: AdapterContext): Promise<ProviderModel> {
    if (providerId !== this.providerId) throw acpError("ACP_MODEL_UNAVAILABLE", "The model belongs to another task engine.");
    const session = this.exactSession(context);
    const selected = this.models.find(model => model.modelId === modelId);
    if (selected === undefined || session.turn !== undefined) throw acpError("ACP_MODEL_UNAVAILABLE", "The task engine cannot select this model now.");
    await this.configure(session, "model", modelId);
    this.publish(session);
    return selected;
  }

  override async setEffort(level: string, context: AdapterContext): Promise<void> {
    const session = this.exactSession(context);
    await this.configureEffort(session, level);
    this.publish(session);
  }

  override async setPermissionMode(mode: PermissionMode, context: AdapterContext): Promise<void> {
    await this.applyPermissionMode(this.exactSession(context), mode);
  }

  async send(input: PromptInput, context: AdapterContext): Promise<void> {
    const session = this.exactSession(context);
    if (session.turn !== undefined || input.disposition !== "prompt" || input.files.length > 0 || input.mentions.length > 0 ||
      input.images.length > 0 && !session.canUseImages) throw acpError("ACP_INPUT_UNAVAILABLE", "The task engine cannot accept this input.");
    const prompt = await this.promptContent(input, context);
    context.signal.throwIfAborted();
    session.owner.assertCurrent();
    const turn: AcpTurn = {
      context, controller: new AbortController(), blockId: randomUUID(),
      blocks: [], tools: new Map(), totalCharacters: 0, cancelled: false
    };
    if (session.turn !== undefined) throw acpError("ACP_TASK_BUSY", "The task engine is already processing a prompt.");
    session.turn = turn;
    await new Promise<void>((resolve, reject) => {
      let dispatched = false;
      const request = session.owner.transport.request("session/prompt", {
        sessionId: session.binding.nativeSessionId!, prompt
      }, {
        signal: context.signal, mutation: true, timeoutMs: 30 * 60_000,
        beforeDispatch: session.owner.assertCurrent,
        onDispatch: () => { context.onNativeTurnDispatch?.(); dispatched = true; resolve(); }
      });
      void request.then(async result => {
        await session.drainNotifications();
        const reason = record(result)?.["stopReason"];
        if (reason === "cancelled" || turn.cancelled) return this.finishTurn(session, turn, "aborted");
        if (reason === "end_turn" || reason === "stop_sequence") return this.finishTurn(session, turn, "completed");
        await this.finishTurn(session, turn, "failed", "The task engine stopped before completing the prompt.");
      }).catch(async () => {
        if (!dispatched) {
          if (session.turn === turn) session.turn = undefined;
          turn.controller.abort();
          reject(acpError("ACP_PROMPT_REJECTED", "The task engine could not accept the prompt."));
          return;
        }
        await this.finishTurn(session, turn, turn.cancelled ? "aborted" : "failed", "The task engine lost the prompt connection.");
        await this.stop(context.sessionId, session, true);
      }).catch(() => undefined);
    });
  }

  async abort(context: AdapterContext): Promise<void> {
    const session = this.exactSession(context);
    const turn = session.turn;
    if (turn === undefined || turn.cancelled) return;
    context.assertRunControlCurrent?.();
    turn.cancelled = true;
    turn.controller.abort();
    context.onNativeInterruptDispatch?.();
    await session.owner.transport.notify("session/cancel", { sessionId: session.binding.nativeSessionId! });
    if (session.turn !== turn) return;
    turn.cancelTimer = setTimeout(() => { void this.stop(context.sessionId, session, true).catch(() => undefined); }, STOP_GRACE_MS);
    turn.cancelTimer.unref?.();
  }

  /** Called immediately when the approved installation is retired. */
  async revoke(): Promise<void> {
    this.capabilityState = { resume: false, images: false, model: false, effort: false, modes: ["ask", "bypassPermissions"] };
    this.models = [];
    const opening = [...this.opening.values()];
    for (const flight of opening) flight.controller.abort();
    const results = await Promise.allSettled([...this.sessions].map(([sessionId, session]) => this.stop(sessionId, session, true)));
    await Promise.allSettled(opening.map(flight => flight.result));
    const pending = await Promise.allSettled([...this.pendingCleanup].map(owner => this.release(owner, true)));
    if ([...results, ...pending].some(result => result.status === "rejected")) {
      throw acpError("ACP_ENGINE_STOP_UNCONFIRMED", "A task engine process has not confirmed exit.");
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.revoke();
  }

  private async open(context: AdapterContext, nativeId: string | undefined, permissionMode: PermissionMode, assertCreation?: () => void): Promise<AcpLiveSession> {
    if (!context.target.trusted || context.hostedExecution !== undefined || context.runtimePolicy !== undefined || context.persistentReadOnly !== undefined) {
      throw acpError("ACP_ENGINE_UNAVAILABLE", "The plugin task engine does not have access to this runtime mode.");
    }
    const id = context.sessionId;
    if (this.opening.has(id) || this.sessions.has(id)) throw acpError("ACP_TASK_BUSY", "The task engine already owns this task.");
    const controller = new AbortController();
    const result = this.launch({ ...context, signal: AbortSignal.any([context.signal, controller.signal]) }, nativeId, permissionMode, assertCreation);
    this.opening.set(id, { result, controller });
    try { return await result; } finally { this.opening.delete(id); }
  }

  private async launch(context: AdapterContext, nativeId: string | undefined, permissionMode: PermissionMode, assertCreation?: () => void): Promise<AcpLiveSession> {
    await this.validateTarget(context.target);
    const id = context.sessionId;
    let owner: ExtensionAcpProcess | undefined;
    let live: AcpLiveSession | undefined;
    try {
      owner = await this.options.open(context);
      owner.assertCurrent();
      let engineExited = false;
      const transport = owner.transport;
      let delivered = Promise.resolve();
      const projectionReceipts = new WeakMap<Notification, () => void>();
      await transport.start({
        onNotificationObserved: notification => {
          const projected = new Promise<void>(resolve => projectionReceipts.set(notification, resolve));
          delivered = delivered.then(() => projected);
        },
        onNotification: async notification => {
          try { if (live !== undefined) await this.onUpdate(live, notification); }
          finally { projectionReceipts.get(notification)?.(); }
        },
        onRequest: request => this.onRequest(live, transport, request),
        onExit: () => {
          engineExited = true;
          const current = live;
          if (current !== undefined) void this.stop(id, current, true).catch(() => undefined);
        }
      });
      const initialize = record(await transport.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "joko", title: "Joko", version: "1" }
      }, { signal: context.signal, beforeDispatch: owner.assertCurrent }));
      if (initialize?.["protocolVersion"] !== ACP_PROTOCOL_VERSION) throw acpError("ACP_PROTOCOL_UNAVAILABLE", "The task engine did not negotiate ACP version 1.");
      const capabilities = record(initialize["agentCapabilities"]);
      const sessionCapabilities = record(capabilities?.["sessionCapabilities"]);
      const canResume = record(sessionCapabilities?.["resume"]) !== undefined || sessionCapabilities?.["resume"] === true
        ? "session/resume" : capabilities?.["loadSession"] === true ? "session/load" : undefined;
      if (nativeId !== undefined && canResume === undefined) throw acpError("ACP_RESUME_UNAVAILABLE", "The task engine did not negotiate session resume.");
      const result = record(await transport.request(nativeId === undefined ? "session/new" : canResume!, {
        cwd: context.target.workspaceRoot, mcpServers: [], ...(nativeId === undefined ? {} : { sessionId: nativeId })
      }, { signal: context.signal, beforeDispatch: () => { owner!.assertCurrent(); assertCreation?.(); }, mutation: true }));
      const bindingId = nativeId ?? safeIdentifier(result?.["sessionId"]);
      if (bindingId === undefined || engineExited || result === undefined ||
        nativeId !== undefined && result["sessionId"] !== undefined && result["sessionId"] !== nativeId) {
        throw acpError("ACP_SESSION_UNAVAILABLE", "The task engine did not confirm the requested session.");
      }
      owner.assertCurrent(); context.signal.throwIfAborted();
      live = {
        owner, drainNotifications: () => delivered,
        canResume, canUseImages: record(capabilities?.["promptCapabilities"])?.["image"] === true,
        binding: { opaqueRef: this.opaqueRef(bindingId), nativeSessionId: bindingId, generation: context.generation },
        config: configOptions(result["configOptions"]), permissionMode: "ask"
      };
      await this.applyPermissionMode(live, permissionMode);
      if (engineExited || !transport.running) throw acpError("ACP_SESSION_UNAVAILABLE", "The task engine exited before confirming its session.");
      owner.assertCurrent(); context.signal.throwIfAborted();
      this.sessions.set(id, live);
      this.confirmedIdleExits.delete(JSON.stringify([id, live.binding.opaqueRef, live.binding.generation]));
      const version = safeIdentifier(record(initialize["agentInfo"])?.["version"]);
      if (version !== undefined) this.version = version;
      this.publish(live);
      return live;
    } catch (error) {
      if (owner !== undefined) await this.release(owner, true);
      if (error instanceof JokoError) throw error;
      throw acpError("ACP_SESSION_UNAVAILABLE", "The task engine could not open the requested session.");
    }
  }

  private async stop(id: string, session: AcpLiveSession, force: boolean): Promise<void> {
    if (session.closing !== undefined) return session.closing;
    const plan = (async () => {
      const turn = session.turn;
      if (turn !== undefined) {
        turn.controller.abort();
        await this.finishTurn(session, turn, turn.cancelled ? "aborted" : "failed", "The task engine exited.");
      }
      await this.release(session.owner, force);
      if (this.sessions.get(id) === session) {
        this.sessions.delete(id);
        if (turn === undefined && session.canResume !== undefined) this.confirmedIdleExits.add(JSON.stringify([id, session.binding.opaqueRef, session.binding.generation]));
      }
    })();
    session.closing = plan;
    try { await plan; } finally { if (session.closing === plan) session.closing = undefined; }
  }

  private async release(owner: ExtensionAcpProcess, force: boolean): Promise<void> {
    this.pendingCleanup.add(owner);
    if (force && owner.transport.forceClose !== undefined) await owner.transport.forceClose();
    else await owner.transport.close();
    await owner.release();
    this.pendingCleanup.delete(owner);
  }

  private exactSession(context: AdapterContext): AcpLiveSession {
    const session = this.sessions.get(context.sessionId);
    if (session === undefined || session.closing !== undefined || session.binding.generation !== context.generation) {
      throw acpError("ACP_SESSION_UNAVAILABLE", "The exact task engine session is unavailable.");
    }
    session.owner.assertCurrent();
    return session;
  }

  private nativeId(binding: NativeSessionBinding, context: AdapterContext): string {
    const id = safeIdentifier(binding.nativeSessionId);
    if (id === undefined || binding.opaqueRef !== this.opaqueRef(id) || context.generation !== binding.generation) {
      throw acpError("ACP_SESSION_UNAVAILABLE", "The saved task engine binding is invalid.");
    }
    return id;
  }

  private opaqueRef(id: string): string {
    return `acp:${this.id}:${createHash("sha256").update(id).digest("hex")}`;
  }

  private state(session: AcpLiveSession): NativeSessionState {
    return {
      binding: session.binding, streaming: session.turn !== undefined, compacting: false, pendingMessages: 0,
      providerId: this.providerId, modelId: config(session, "model")?.value ?? DEFAULT_MODEL,
      ...(config(session, "thought_level")?.value === undefined ? {} : { effort: config(session, "thought_level")!.value.toLowerCase() }),
      fastMode: false, permissionMode: session.permissionMode,
      ...(session.usage === undefined ? {} : { usage: session.usage })
    };
  }

  private model(id: string, name: string, images: boolean, efforts: readonly string[] = []): ProviderModel {
    return { providerId: this.providerId, modelId: id, displayName: name, api: "acp", contextWindow: 0,
      maxOutputTokens: 0, supportsImages: images, thinkingLevels: efforts, cost: {} };
  }

  private publish(session: AcpLiveSession): void {
    const changed = this.projectCatalog(session.canResume !== undefined, session.canUseImages, session.config);
    if (changed) this.options.catalogChanged({
      format: 1, version: this.version, resume: session.canResume !== undefined, images: session.canUseImages,
      configOptions: session.config.map(option => ({
        type: "select", id: option.id, category: option.category, currentValue: option.value, options: option.choices
      }))
    });
  }

  restoreCatalog(value: unknown): void {
    const observed = record(value);
    if (observed?.["format"] !== 1) return;
    this.version = safeIdentifier(observed["version"]) ?? this.version;
    this.projectCatalog(observed["resume"] === true, observed["images"] === true, configOptions(observed["configOptions"]));
  }

  private projectCatalog(resume: boolean, images: boolean, configurations: readonly ConfigOption[]): boolean {
    const model = configurations.find(option => option.category === "model");
    const effort = configurations.find(option => option.category === "thought_level");
    const modes = configurations.find(option => option.category === "mode")?.choices ?? [];
    const supportedModes = (["ask", "acceptEdits", "auto", "bypassPermissions"] as const).filter(mode =>
      mode === "ask" || mode === "bypassPermissions" || modes.some(choice => modeKey(choice.value) === modeKey(mode)));
    const previous = JSON.stringify([this.models, this.capabilityState]);
    this.models = (model?.choices ?? []).filter(choice => choice.value !== DEFAULT_MODEL).map(choice => this.model(
      choice.value, choice.name, images,
      choice.value === model?.value ? (effort?.choices ?? []).map(level => level.value.toLowerCase()).filter(level => EFFORTS.includes(level)) : []
    ));
    this.capabilityState = { resume, images,
      model: (model?.choices.length ?? 0) > 0, effort: (effort?.choices.length ?? 0) > 0, modes: supportedModes };
    return previous !== JSON.stringify([this.models, this.capabilityState]);
  }

  private async configure(session: AcpLiveSession, category: string, value: string): Promise<void> {
    const option = config(session, category);
    if (option === undefined || !option.choices.some(choice => choice.value === value) || session.turn !== undefined) {
      throw acpError("ACP_SETTING_UNAVAILABLE", "The task engine did not negotiate this setting.");
    }
    if (option.value === value) return;
    const answer = record(await session.owner.transport.request("session/set_config_option", {
      sessionId: session.binding.nativeSessionId!, configId: option.id, value
    }, { mutation: true, beforeDispatch: session.owner.assertCurrent }));
    session.owner.assertCurrent();
    const returned = answer?.["configOptions"];
    session.config = Array.isArray(returned) ? configOptions(returned) : session.config.map(item => item.id === option.id ? { ...item, value } : item);
    if (config(session, category)?.value !== value) throw acpError("ACP_SETTING_UNAVAILABLE", "The task engine did not confirm this setting.");
  }

  private async configureEffort(session: AcpLiveSession, effort: string): Promise<void> {
    const choice = config(session, "thought_level")?.choices.find(level => level.value.toLowerCase() === effort);
    if (choice === undefined && effort === "off") return;
    if (choice === undefined || !EFFORTS.includes(effort)) throw acpError("ACP_SETTING_UNAVAILABLE", "The task engine did not negotiate this reasoning effort.");
    await this.configure(session, "thought_level", choice.value);
  }

  private async applyPermissionMode(session: AcpLiveSession, mode: PermissionMode): Promise<void> {
    const choices = config(session, "mode")?.choices ?? [];
    const native = mode === "bypassPermissions" ? undefined : choices.find(choice => modeKey(choice.value) === modeKey(mode));
    if (native !== undefined) await this.configure(session, "mode", native.value);
    else if (mode !== "ask" && mode !== "bypassPermissions") throw acpError("ACP_SETTING_UNAVAILABLE", "The task engine did not negotiate this permission mode.");
    session.permissionMode = mode;
  }

  private async promptContent(input: PromptInput, context: AdapterContext): Promise<RpcValue[]> {
    const result: RpcValue[] = input.text ? [{ type: "text", text: input.text }] : [];
    let remaining = MAXIMUM_IMAGE_BYTES;
    for (const { blob } of input.images) {
      context.signal.throwIfAborted();
      if (!NATIVE_PROMPT_IMAGE_MEDIA_TYPES.includes(blob.mimeType) || blob.byteLength > remaining) {
        throw acpError("ACP_IMAGE_UNAVAILABLE", "An image exceeds the task engine input bounds.");
      }
      const data = Buffer.from(await this.options.readBlob(blob));
      if (data.length !== blob.byteLength) throw acpError("ACP_IMAGE_UNAVAILABLE", "The original image is unavailable.");
      remaining -= data.length;
      result.push({ type: "image", mimeType: blob.mimeType, data: data.toString("base64") });
    }
    return result;
  }

  private async onUpdate(session: AcpLiveSession, raw: Notification): Promise<void> {
    const params = record(raw.params);
    if (raw.method !== "session/update" || params === undefined || params["sessionId"] !== session.binding.nativeSessionId) return;
    const update = record(params["update"]);
    if (update === undefined) return;
    try { session.owner.assertCurrent(); } catch { return; }
    if (update["sessionUpdate"] === "config_option_update") {
      session.config = configOptions(update["configOptions"]);
      this.publish(session);
      return;
    }
    const turn = session.turn;
    if (turn === undefined || turn.cancelled) return;
    const kind = update["sessionUpdate"];
    if (kind === "usage_update") {
      const used = update["used"], size = update["size"];
      if (typeof used !== "number" || !Number.isSafeInteger(used) || used < 0 ||
        typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) return;
      session.usage = {
        inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0,
        contextTokens: used, contextWindow: size,
        nativeAccounting: { sourceId: session.binding.opaqueRef, tokensComplete: false, costComplete: false, costEstimated: false }
      };
      await turn.context.emit({ type: "usage", usage: session.usage });
    } else if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const content = record(update["content"]);
      const text = content?.["type"] === "text" ? content["text"] : undefined;
      if (typeof text !== "string" || text.length === 0) return;
      if (turn.totalCharacters + text.length > MAXIMUM_REPLY_CHARS) throw acpError("ACP_REPLY_OVERSIZED", "The task engine reply exceeded the supported size.");
      turn.totalCharacters += text.length;
      const blockKind = kind === "agent_message_chunk" ? "text" : "thinking";
      const previous = turn.blocks.at(-1);
      const nextText = previous?.kind === blockKind ? previous.text + text : text;
      const block = blockKind === "text" ? { kind: "text" as const, text: nextText }
        : { kind: "thinking" as const, text: nextText, redacted: false };
      if (previous?.kind === blockKind) turn.blocks[turn.blocks.length - 1] = block;
      else turn.blocks.push(block);
      await turn.context.emit({ type: blockKind === "text" ? "text_delta" : "thinking_delta",
        blockId: `${turn.blockId}-${turn.blocks.length}`, delta: text });
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const id = safeIdentifier(update["toolCallId"]);
      if (id === undefined) return;
      const name = turn.tools.get(id) ?? redactSecrets(safeIdentifier(update["title"]) ?? "Task engine tool");
      const status = update["status"];
      if (!turn.tools.has(id)) {
        turn.tools.set(id, name);
        await turn.context.emit({ type: "tool_start", callId: id, name, input: displayAcpValue(update["rawInput"]) });
      }
      if (status === "completed" || status === "failed") {
        await turn.context.emit({ type: "tool_result", callId: id, name, output: displayAcpValue(update["rawOutput"]), isError: status === "failed" });
      }
    }
  }

  private async onRequest(session: AcpLiveSession | undefined, transport: RpcTransport, request: ServerRequest): Promise<void> {
    if (request.method !== "session/request_permission") {
      await transport.respondError(request.id, -32601, "Unsupported client method.");
      return;
    }
    const params = record(request.params);
    const turn = session?.turn;
    const cancelled = { outcome: { outcome: "cancelled" } };
    if (session === undefined || turn === undefined || turn.cancelled || params === undefined || params["sessionId"] !== session.binding.nativeSessionId) {
      await transport.respond(request.id, cancelled);
      return;
    }
    const options = Array.isArray(params["options"]) ? params["options"].slice(0, 16).map(record) : [];
    const find = (kind: string) => safeIdentifier(options.find(item => item?.["kind"] === kind)?.["optionId"]);
    const allow = find("allow_once"), deny = find("reject_once");
    const tool = record(params["toolCall"]);
    const title = redactSecrets(safeIdentifier(tool?.["title"]) ?? "Task engine tool");
    try {
      session.owner.assertCurrent();
      const decision = session.permissionMode === "bypassPermissions" ? true
        : (await turn.context.requestInteraction({
          id: `acp-permission-${randomUUID()}`, kind: "permission", title, toolName: title,
          summary: displayAcpValue(tool?.["rawInput"]) || title, risk: "medium",
          choices: ["allow_once", "deny_once"]
        }, { signal: turn.controller.signal }));
      session.owner.assertCurrent();
      const selected = decision === true || decision.kind === "selected" && decision.value === "allow_once" ? allow ?? deny : deny;
      await transport.respond(request.id, selected === undefined || turn.controller.signal.aborted
        ? cancelled : { outcome: { outcome: "selected", optionId: selected } });
    } catch { await transport.respond(request.id, cancelled).catch(() => undefined); }
  }

  private async finishTurn(session: AcpLiveSession, turn: AcpTurn, outcome: "completed" | "aborted" | "failed", error?: string): Promise<void> {
    if (session.turn !== turn) return;
    session.turn = undefined;
    turn.controller.abort();
    if (turn.cancelTimer !== undefined) clearTimeout(turn.cancelTimer);
    if (turn.blocks.length > 0) await turn.context.emit({ type: "message_complete", role: "assistant", blocks: turn.blocks });
    if (outcome === "failed" && error !== undefined) await turn.context.emit({
      type: "error", terminal: true, error: acpError("ACP_PROMPT_INTERRUPTED", error, true).publicError
    });
    await turn.context.emit({ type: "done", outcome });
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
}

function configOptions(value: unknown): readonly ConfigOption[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap(item => {
    const source = record(item);
    const id = safeIdentifier(source?.["id"]);
    const selected = safeIdentifier(source?.["currentValue"]);
    if (source?.["type"] !== "select" || id === undefined || selected === undefined || !Array.isArray(source["options"])) return [];
    const category = safeIdentifier(source["category"]) ?? (id === "reasoning_effort" ? "thought_level" : id);
    const choices = source["options"].slice(0, 100).flatMap(raw => {
      const choice = record(raw), value = safeIdentifier(choice?.["value"]), name = safeIdentifier(choice?.["name"]);
      return value === undefined || name === undefined ? [] : [{ value, name: redactSecrets(name) }];
    });
    return [{ id, category, value: selected, choices }];
  });
}

function config(session: AcpLiveSession, category: string): ConfigOption | undefined {
  return session.config.find(option => option.category === category);
}

function modeKey(value: string): string {
  return value.toLowerCase().replace(/[-_\s]/gu, "");
}

function displayAcpValue(value: unknown): string {
  return value === undefined ? "" : redactSecrets(typeof value === "string" ? value : JSON.stringify(value)).slice(0, 8_192);
}

function acpError(code: string, message: string, stateMayHaveChanged = false): JokoError {
  return new JokoError({ code, message, phase: "runtime", retryable: false, stateMayHaveChanged,
    recovery: "Check the approved plugin and reopen the affected task." });
}
