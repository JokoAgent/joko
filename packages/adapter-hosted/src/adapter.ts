import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { AdapterContext, BackendAdapter, BackendDescriptor, BlobRef, CreateNativeSessionInput, DurableNativeDispatchPreparation,
  BackgroundTaskOutputResult, NativeHistoryProjection, NativeNavigationTarget, NativeSessionBinding, NativeSessionDerivation, NativeSessionDerivationLifecycle, NativeSessionForkResult,
  NativeSessionNavigation, NativeSessionNavigationResult, NativeSessionState, PromptInput, ProviderModel, RuntimeCommand, RuntimeResource,
  RuntimeToolCatalog, SessionTree, SubagentControlInput, TargetDescriptor, UserShellInput, UserShellResult, NativeTextInferenceInput } from "@joko/core";
import type { HostedNativeCommand, HostedNativeOpen, HostedNativeDerivationLifecycle } from "./protocol.js";
import { JokoError, toPublicError } from "@joko/core";
import type { HostedAgentConnectionPool } from "./connection-pool.js";

const identity = z.string().min(1).max(512).refine(value => !/[\0\r\n]/u.test(value));
const sourceSchema = z.strictObject({ controllerDeviceId: identity, targetDeviceId: identity, backendId: identity });
const bindingSchema = z.strictObject({ format: z.literal(1), backendId: identity, source: sourceSchema,
  sessionId: identity, targetId: identity, nativeSessionId: identity, providerId: identity });
type SourceBinding = z.infer<typeof bindingSchema>;
export type HostedAgentDeviceSource = z.infer<typeof sourceSchema>;
export interface HostedAgentSourceController {
  start(): Promise<void>;
  stop(): Promise<void>;
  abortPending(): void;
  registerOperation(id: string, context: AdapterContext, fence?: (preparation: DurableNativeDispatchPreparation) => Promise<void>, input?: PromptInput, backgroundResume?: SubagentControlInput): void;
  projectResult<T>(value: T): T;
  projectState(state: NativeSessionState): NativeSessionState;
  projectHistory(history: NativeHistoryProjection): NativeHistoryProjection;
}
export interface HostedAgentSourceConnection {
  readonly client: {
    open(input: HostedNativeOpen, signal: AbortSignal): Promise<{ readonly runId: string; readonly virtualRoot: string }>;
    call(runId: string, callId: string, command: HostedNativeCommand, signal: AbortSignal): Promise<unknown>;
  };
  readonly createController: (input: { readonly runId: string; readonly shadow: string; readonly context: AdapterContext;
    readonly binding: () => NativeSessionBinding }) => HostedAgentSourceController;
  readonly assertCurrent: () => void;
  /** Exact run cleanup captured while this relation and route were current. */
  readonly close: () => Promise<void>;
}
export interface HostedAgentSourceAdapterOptions {
  readonly inferNativeText?: (input: NativeTextInferenceInput) => Promise<string>;
  readonly id: string;
  readonly source: HostedAgentDeviceSource;
  readonly describe: () => BackendDescriptor | Promise<BackendDescriptor>;
  readonly capture: (runId: string, context: AdapterContext) => HostedAgentSourceConnection | Promise<HostedAgentSourceConnection>;
  readonly workspace: (context: AdapterContext) => HostedNativeOpen["workspace"] | Promise<HostedNativeOpen["workspace"]>;
  readonly resources?: (context: AdapterContext) => readonly RuntimeResource[];
  readonly commands?: (context: AdapterContext) => readonly RuntimeCommand[];
  readonly prepareInput?: (input: PromptInput, context: AdapterContext, shadow: string) => Promise<{ readonly input: PromptInput; readonly assertCurrent: () => void;
    readonly commit?: (preparation: DurableNativeDispatchPreparation) => Promise<void> }>;
  readonly releaseWorkspace?: (context: AdapterContext) => void | Promise<void>;
  readonly deleteWorkspace?: (context: AdapterContext) => void | Promise<void>;
  readonly readPolicy: (context: AdapterContext) => Pick<NativeSessionState, "permissionMode" | "fastMode" | "effort">;
  readonly assertContext: (context: AdapterContext) => void;
  readonly onRuntimeUnavailable?: (context: AdapterContext) => void;
  readonly validateRemoteTarget?: (target: TargetDescriptor) => Promise<void>;
  readonly takeGroupSwitch?: (context: AdapterContext) => string | undefined;
  readonly takeNewGroupRound?: (context: AdapterContext) => boolean;
  readonly isGroupMember?: (context: AdapterContext) => boolean;
  readonly connectionPool?: HostedAgentConnectionPool;
  /** A typed native admission rejection, distinct from upload/payload limits. */
  readonly isCapacityError?: (error: unknown) => boolean;
  readonly manageDerivation?: (command: HostedNativeDerivationLifecycle, signal: AbortSignal) => Promise<void>;
}
interface ActiveSourceSession {
  readonly binding: NativeSessionBinding;
  readonly context: AdapterContext;
  readonly runId: string;
  readonly connection: HostedAgentSourceConnection;
  readonly controller: HostedAgentSourceController;
  readonly shadow: string;
  failure?: unknown;
  closing?: Promise<void>;
  busy: number;
  lastActivity: number;
  idleClosed?: boolean;
  unregisterPool?: () => void;
  idleRelease?: { readonly id: string; readonly idleMinutes: number; attempted: boolean; confirmed?: boolean; flight?: Promise<boolean> };
}

/** Native Adapter on the original task node. Its durable binding identifies an
 * exact Provider node and native owner, never a Provider-side filesystem path.
 * The captured native-only connection is supplied by the Device route owner. */
export class HostedAgentSourceAdapter implements BackendAdapter {
  readonly id: string;
  readonly #options: HostedAgentSourceAdapterOptions;
  readonly #sessions = new Map<string, ActiveSourceSession>();
  readonly #opening = new Map<string, Promise<ActiveSourceSession>>();
  readonly #unclosed = new Map<string, { readonly connection: HostedAgentSourceConnection; readonly context: AdapterContext }>();
  #closed = false;
  constructor(options: HostedAgentSourceAdapterOptions) {
    identity.parse(options.id); sourceSchema.parse(options.source);
    this.id = options.id; this.#options = { ...options, source: Object.freeze(sourceSchema.parse(options.source)) };
  }
  async describe(): Promise<BackendDescriptor> {
    this.#assertOpen(); const descriptor = await this.#options.describe();
    if (descriptor.id !== this.id) throw new Error("Hosted native instance changed its identity."); return descriptor;
  }
  async inferNativeText(input: NativeTextInferenceInput): Promise<string> {
    this.#assertOpen(); input.signal.throwIfAborted(); input.assertCurrent();
    if (!input.providerId || !input.modelId || !this.#options.inferNativeText) throw new Error("Isolated Source inference is unavailable.");
    input.assertModelAllowed(input.providerId, input.modelId);
    const result = await this.#options.inferNativeText(input);
    this.#assertOpen(); input.signal.throwIfAborted(); input.assertCurrent(); input.assertModelAllowed(input.providerId, input.modelId);
    return result;
  }
  async validateTarget(target: TargetDescriptor): Promise<void> {
    this.#assertOpen();
    if (target.remoteWorkspace?.kind === "device_peer" && target.backendId === this.id && target.trusted && this.#options.validateRemoteTarget) {
      await this.#options.validateRemoteTarget(target); return;
    }
    if (target.backendId !== this.id || target.remoteWorkspace || !target.trusted || !isAbsolute(target.workspaceRoot)
      || await realpath(target.workspaceRoot) !== target.workspaceRoot) throw new Error("Hosted native task workspace is unavailable.");
  }
  async createSession(input: CreateNativeSessionInput, context: AdapterContext): Promise<NativeSessionBinding> {
    this.#check(context); await this.validateTarget(input.target);
    if (input.nativeStart && (input.nativeStart.kind !== "new" || input.nativeStart.parentNativeReference)) throw new Error("Hosted native attachment is unavailable.");
    if (!input.providerId || !input.modelId) throw new Error("Hosted native creation requires an explicit model and source.");
    const nativeSessionId = createHash("sha256").update(JSON.stringify([this.id, context.sessionId, context.target.id,
      context.generation, context.operationId ?? "create"])).digest("hex");
    const binding = this.#binding({ ...context, modelSelection: { providerId: input.providerId, modelId: input.modelId } }, nativeSessionId);
    await this.#activate(binding, { ...context, modelSelection: { providerId: input.providerId, modelId: input.modelId } }, "create",
      { permissionMode: input.permissionMode, fastMode: input.fastMode, ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.effort === undefined ? {} : { effort: input.effort }) });
    return binding;
  }
  async resumeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    const active = await this.#activate(binding, context, "resume"); return this.#state(active, context);
  }
  async inspectSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    const active = await this.#ready(context, binding); return this.#state(active, context);
  }
  async detachSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> { await this.closeSession(binding, context); }
  async closeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    this.#parse(binding, context); const pending = this.#opening.get(context.sessionId);
    if (pending) await pending.catch(() => {});
    const active = this.#sessions.get(context.sessionId); if (!active) return;
    if (active.binding.opaqueRef !== binding.opaqueRef) throw new Error("Hosted native cleanup belongs to another context.");
    await this.#close(active);
  }
  async send(input: PromptInput, context: AdapterContext): Promise<void> { await this.#send(input, context); }
  async sendWithDurableNativeDispatchFence(input: PromptInput, context: AdapterContext,
    persistFence: (preparation: DurableNativeDispatchPreparation) => Promise<void>): Promise<void> { await this.#send(input, context, persistFence); }
  async abort(context: AdapterContext): Promise<void> { const active = this.#active(context); active.controller.abortPending(); await this.#call(active, { kind: "abort" }, context); }
  async setModel(providerId: string, modelId: string, context: AdapterContext): Promise<ProviderModel> {
    return await this.#call(this.#active(context), { kind: "set_model", providerId, modelId }, context) as ProviderModel;
  }
  async setEffort(effort: string, context: AdapterContext): Promise<void> { await this.#call(this.#active(context), { kind: "set_effort", effort }, context); }
  async setFastMode(enabled: boolean | "ultrafast", context: AdapterContext): Promise<void> { await this.#call(this.#active(context), { kind: "set_fast", enabled }, context); }
  async setPermissionMode(mode: NativeSessionState["permissionMode"], context: AdapterContext): Promise<void> { await this.#call(this.#active(context), { kind: "set_permission", mode }, context); }
  async setPlanMode(enabled: boolean, context: AdapterContext): Promise<void> { await this.#call(this.#active(context), { kind: "set_plan", enabled }, context); }
  async setName(name: string, context: AdapterContext): Promise<void> { await this.#call(this.#active(context), { kind: "set_name", name }, context); }
  async setAutoCompaction(enabled: boolean, context: AdapterContext): Promise<void> { await this.#call(this.#active(context), { kind: "set_auto_compaction", enabled }, context); }
  async setAutoRetry(enabled: boolean, context: AdapterContext): Promise<void> { await this.#call(this.#active(context), { kind: "set_auto_retry", enabled }, context); }
  async abortRetry(context: AdapterContext): Promise<void> { await this.#call(this.#active(context), { kind: "abort_retry" }, context); }
  async compact(instructions: string | undefined, context: AdapterContext): Promise<"compacted" | "noop"> {
    return await this.#call(this.#active(context), { kind: "compact", ...(instructions === undefined ? {} : { instructions }) }, context) as "compacted" | "noop";
  }
  async getCommands(context: AdapterContext): Promise<readonly RuntimeCommand[]> {
    const active = this.#active(context), descriptor = await this.describe();
    const native = descriptor.capabilities.get("runtime.commands")?.supported === true
      ? await this.#call(active, { kind: "commands" }, context) as readonly RuntimeCommand[] : [];
    // Native executable extensions belong to the dedicated runtime. Skills and
    // prompts remain bound to the Source's approved resource identities.
    const commands = this.#options.commands?.(context) ?? [];
    const names = new Set(commands.map(command => command.name));
    return [...commands, ...native.filter(command => command.source === "extension" && !names.has(command.name))
      .map(({ path: _path, ...command }) => command)];
  }
  async dispatchDuringCompaction(input: PromptInput, context: AdapterContext): Promise<PromptInput["disposition"] | undefined> {
    if (input.files.length || input.mentions.length) return undefined;
    const value = await this.#call(this.#active(context), { kind: "dispatch_during_compaction", input }, context);
    return value === "prompt" || value === "steer" || value === "follow_up" ? value : undefined;
  }
  async getResources(context: AdapterContext): Promise<readonly RuntimeResource[]> {
    await this.#ready(context);
    return this.#options.resources?.(context) ?? await this.#call(this.#active(context), { kind: "resources" }, context) as readonly RuntimeResource[];
  }
  async getRuntimeTools(context: AdapterContext): Promise<RuntimeToolCatalog> { return await this.#call(this.#active(context), { kind: "tools" }, context) as RuntimeToolCatalog; }
  async getTree(context: AdapterContext): Promise<SessionTree> { return await this.#call(this.#active(context), { kind: "tree" }, context) as SessionTree; }
  async getNativeHistoryProjection(context: AdapterContext): Promise<NativeHistoryProjection> {
    const active = this.#active(context); return active.controller.projectHistory(await this.#call(active, { kind: "history" }, context) as NativeHistoryProjection);
  }
  async executeUserShell(input: UserShellInput, context: AdapterContext): Promise<UserShellResult> { return await this.#call(this.#active(context), { kind: "shell", input }, context) as UserShellResult; }
  async abortUserShell(context: AdapterContext): Promise<void> { await this.#call(this.#active(context), { kind: "abort_shell" }, context); }
  async controlSubagent(input: SubagentControlInput, context: AdapterContext): Promise<void> { await this.#call(this.#active(context), { kind: "control_subagent", input }, context); }
  async cancelBackgroundTask(context: AdapterContext, taskId: string): Promise<void> { await this.#call(this.#active(context), { kind: "cancel_background", taskId }, context); }
  async getBackgroundTaskOutput(context: AdapterContext, taskId: string, maximumBytes: number): Promise<BackgroundTaskOutputResult> {
    return await this.#call(this.#active(context), { kind: "background_output", taskId, maximumBytes }, context) as BackgroundTaskOutputResult;
  }
  async deleteSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    const active = await this.#activate(binding, context, "resume"); await this.#call(active, { kind: "delete" }, context); await this.#close(active); await this.#options.deleteWorkspace?.(context);
  }
  async exportSession(_context: AdapterContext): Promise<BlobRef> { throw new Error("Hosted native export is not connected."); }
  async navigateTree(target: NativeNavigationTarget, summarize: boolean, context: AdapterContext, instructions: string | undefined,
    _navigation: NativeSessionNavigation): Promise<NativeSessionNavigationResult> {
    await this.#call(this.#active(context), { kind: "navigate", target, summarize, ...(instructions === undefined ? {} : { instructions }) }, context);
    // The alias identifies the Provider-owned context. Actual native replacement
    // bindings stay in its private journal; the Source reloads the confirmed tree.
    return { kind: "in_place" };
  }
  async fork(entryId: string, context: AdapterContext, derivation: NativeSessionDerivation): Promise<NativeSessionForkResult> {
    const result = await this.#derive("fork", context, derivation, entryId); return result;
  }
  async clone(context: AdapterContext, derivation: NativeSessionDerivation): Promise<NativeSessionBinding> {
    return (await this.#derive("clone", context, derivation)).binding;
  }
  async ownsNativeSessionDerivationLifecycle(lifecycle: NativeSessionDerivationLifecycle): Promise<boolean> {
    this.#assertOpen();
    if (lifecycle.kind === "navigate" || !this.#options.manageDerivation) return false;
    this.#parse(lifecycle.sourceBinding, { sessionId: lifecycle.sourceSessionId, target: lifecycle.sourceTarget });
    this.#assertDerivedTarget(lifecycle.sourceTarget, lifecycle.target); return true;
  }
  async adoptNativeSessionDerivation(lifecycle: NativeSessionDerivationLifecycle & { readonly binding: NativeSessionBinding }, signal: AbortSignal): Promise<void> {
    await this.#manageDerivation(lifecycle, "adopt", signal);
  }
  async cleanupNativeSessionDerivation(lifecycle: NativeSessionDerivationLifecycle, signal: AbortSignal): Promise<void> {
    await this.#manageDerivation(lifecycle, "cleanup", signal);
  }
  async #derive(kind: "fork" | "clone", context: AdapterContext, derivation: NativeSessionDerivation, entryId?: string): Promise<NativeSessionForkResult> {
    if (!context.operationId || !this.#options.manageDerivation) throw new Error("Native derivation requires its durable Source operation owner.");
    this.#assertDerivedTarget(context.target, derivation.target); await this.validateTarget(derivation.target);
    const descriptor = await this.describe(); if (descriptor.capabilities.get(derivation.completedSnapshot ? "session.side_chat" : `session.${kind}`)?.supported !== true) throw new Error("This native source does not support the selected derivation.");
    const active = await this.#ready(context), source = this.#parse(active.binding, context);
    const binding = this.#derivedBinding(source, context.operationId, kind, derivation.sessionId, derivation.target.id);
    // Register the deterministic Source alias before sending the only native
    // effect. Lost responses therefore keep a recoverable Product placeholder.
    derivation.recordBinding(binding);
    const result = await this.#call(active, { kind: "derive", derivationKind: kind, sessionId: derivation.sessionId, targetId: derivation.target.id,
      nativeSessionId: binding.nativeSessionId!, ...(entryId === undefined ? {} : { entryId }),
      ...(derivation.completedSnapshot ? { completedSnapshot: derivation.completedSnapshot } : {}) }, context) as { readonly editorText?: string };
    return { binding, ...(typeof result?.editorText === "string" ? { editorText: result.editorText } : {}) };
  }
  async #manageDerivation(lifecycle: NativeSessionDerivationLifecycle, action: "adopt" | "cleanup", signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!await this.ownsNativeSessionDerivationLifecycle(lifecycle) || lifecycle.kind === "navigate") throw new Error("The original native derivation authority is unavailable.");
    const source = this.#parse(lifecycle.sourceBinding, { sessionId: lifecycle.sourceSessionId, target: lifecycle.sourceTarget });
    const expected = this.#derivedBinding(source, lifecycle.operationId, lifecycle.kind, lifecycle.sessionId, lifecycle.target.id);
    if (lifecycle.binding && (expected.opaqueRef !== lifecycle.binding.opaqueRef || expected.generation !== lifecycle.binding.generation)) throw new Error("The native derivation child identity conflicts.");
    await this.#options.manageDerivation!({ kind: "derivation_lifecycle", action, derivationKind: lifecycle.kind,
      operationId: createHash("sha256").update(JSON.stringify([lifecycle.operationId, "derive"])).digest("hex"), backendId: source.source.backendId, providerId: source.providerId,
      sourceSessionId: source.sessionId, sourceTargetId: source.targetId, sourceNativeSessionId: source.nativeSessionId,
      sessionId: lifecycle.sessionId, targetId: lifecycle.target.id, nativeSessionId: expected.nativeSessionId! }, signal);
    signal.throwIfAborted();
  }
  #derivedBinding(source: SourceBinding, operationId: string, kind: "fork" | "clone", sessionId: string, targetId: string): NativeSessionBinding {
    const nativeSessionId = createHash("sha256").update(JSON.stringify([this.id, source.nativeSessionId, operationId, kind, sessionId, targetId])).digest("hex");
    return { opaqueRef: JSON.stringify({ ...source, sessionId, targetId, nativeSessionId }), nativeSessionId, generation: 1 };
  }
  #assertDerivedTarget(source: TargetDescriptor, target: TargetDescriptor): void {
    if (source.id !== target.id || source.backendId !== this.id || target.backendId !== this.id || source.managed !== target.managed
      || source.trusted !== target.trusted || source.workspaceRoot !== target.workspaceRoot || JSON.stringify(source.remoteWorkspace) !== JSON.stringify(target.remoteWorkspace)) throw new Error("The native derivation requires the original Source workspace authority.");
  }
  async dispose(): Promise<void> {
    this.#closed = true; await Promise.allSettled([...this.#opening.values()]);
    const results = await Promise.allSettled([...this.#sessions.values()].map(active => this.#close(active)));
    const orphaned = await Promise.allSettled([...this.#unclosed].filter(([id]) => ![...this.#sessions.values()].some(active => active.runId === id))
      .map(async ([id, owner]) => { await owner.connection.close(); await this.#options.releaseWorkspace?.(owner.context); this.#unclosed.delete(id); }));
    const failures = [...results, ...orphaned].filter((value): value is PromiseRejectedResult => value.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(value => value.reason), "Hosted native cleanup could not be confirmed.");
  }
  async #send(input: PromptInput, context: AdapterContext, fence?: (preparation: DurableNativeDispatchPreparation) => Promise<void>): Promise<void> {
    if ((input.files.length || input.mentions.length) && !this.#options.prepareInput) throw new Error("Hosted native input requires its Source resolver.");
    if (!context.operationId) throw new Error("Hosted native dispatch requires its original operation identity.");
    const active = await this.#ready(context);
    const prepared = await this.#options.prepareInput?.(input, context, active.shadow);
    this.#check(context); prepared?.assertCurrent();
    if (prepared?.commit && !fence) throw new Error("File input requires its original durable native dispatch confirmation.");
    if (active !== this.#active(context)) throw new Error("The Source runtime changed while its input was prepared.");
    const newGroupRound = this.#options.takeNewGroupRound?.(context) === true;
    const preparedFence = fence && prepared ? async (value: DurableNativeDispatchPreparation) => {
      prepared.assertCurrent(); await fence(value); prepared.assertCurrent(); await prepared.commit?.(value); prepared.assertCurrent();
    } : fence;
    await this.#call(active, { kind: "send", input: prepared?.input ?? input, durableFence: fence !== undefined,
      ...(newGroupRound ? { newGroupRound: true } : {}) }, context, preparedFence);
  }
  #binding(context: AdapterContext, nativeSessionId: string): NativeSessionBinding {
    if (!context.modelSelection?.providerId) throw new Error("The native Source binding requires its Provider identity.");
    const value: SourceBinding = { format: 1, backendId: this.id, source: this.#options.source, sessionId: context.sessionId, targetId: context.target.id, nativeSessionId, providerId: context.modelSelection.providerId };
    return { opaqueRef: JSON.stringify(value), nativeSessionId, generation: context.generation };
  }
  #parse(binding: NativeSessionBinding, context: Pick<AdapterContext, "sessionId" | "target">): SourceBinding {
    let value: SourceBinding;
    try { if (binding.opaqueRef.length > 8192) throw new Error(); value = bindingSchema.parse(JSON.parse(binding.opaqueRef)); }
    catch { throw new Error("Hosted native binding is invalid."); }
    if (value.backendId !== this.id || value.source.controllerDeviceId !== this.#options.source.controllerDeviceId
      || value.source.targetDeviceId !== this.#options.source.targetDeviceId || value.source.backendId !== this.#options.source.backendId || value.sessionId !== context.sessionId
      || value.targetId !== context.target.id || binding.nativeSessionId !== value.nativeSessionId) throw new Error("Hosted native binding belongs to another source or task.");
    return value;
  }
  #activate(binding: NativeSessionBinding, context: AdapterContext, start: "create" | "resume",
    creation?: Pick<CreateNativeSessionInput, "permissionMode" | "fastMode" | "effort" | "name">): Promise<ActiveSourceSession> {
    this.#check(context); this.#parse(binding, context);
    const current = this.#sessions.get(context.sessionId);
    if (current && !current.failure && !current.idleClosed && !current.idleRelease && !(start === "resume" && current.binding.opaqueRef === binding.opaqueRef
      && current.binding.nativeSessionId === binding.nativeSessionId && context.generation === current.binding.generation + 1)) {
      this.#active(context, binding); return Promise.resolve(current);
    }
    const pending = this.#opening.get(context.sessionId); if (pending) return pending.then(active => {
      if (active.binding.opaqueRef !== binding.opaqueRef || active.binding.generation !== context.generation) throw new Error("Hosted native startup ownership conflicts."); return active;
    });
    const currentBinding = { ...binding, generation: context.generation };
    const opening = (async () => {
      if (current) await this.#close(current);
      return this.#open(currentBinding, context, current ? "resume" : start, creation);
    })().finally(() => { if (this.#opening.get(context.sessionId) === opening) this.#opening.delete(context.sessionId); });
    this.#opening.set(context.sessionId, opening); return opening;
  }
  async #open(binding: NativeSessionBinding, context: AdapterContext, start: "create" | "resume",
    creation?: Pick<CreateNativeSessionInput, "permissionMode" | "fastMode" | "effort" | "name">): Promise<ActiveSourceSession> {
    await this.#options.connectionPool?.beforeOpen();
    try { return await this.#openOnce(binding, context, start, creation); }
    catch (error) {
      if (!(error instanceof HostedNativeCapacityError) && !this.#options.isCapacityError?.(error) || !await this.#options.connectionPool?.releaseForRetry()) throw error;
      this.#check(context); return this.#openOnce(binding, context, start, creation);
    }
  }
  async #openOnce(binding: NativeSessionBinding, context: AdapterContext, start: "create" | "resume",
    creation?: Pick<CreateNativeSessionInput, "permissionMode" | "fastMode" | "effort" | "name">): Promise<ActiveSourceSession> {
    const saved = this.#parse(binding, context), runId = randomUUID();
    let connection: HostedAgentSourceConnection;
    try { connection = await this.#options.capture(runId, context); }
    catch (error) { throw closedStartup(error); }
    this.#unclosed.set(runId, { connection, context });
    let active: ActiveSourceSession | undefined;
    try {
      this.#check(context); connection.assertCurrent(); await this.validateTarget(context.target);
      const selection = context.modelSelection; if (!selection) throw new Error("Hosted native restoration requires its retained model source.");
      const policy = this.#options.readPolicy(context), workspace = await this.#options.workspace(context);
      const groupSwitch = this.#options.takeGroupSwitch?.(context);
      const groupMember = this.#options.isGroupMember?.(context) === true;
      const opened = await connection.client.open({ runId, nativeSessionId: saved.nativeSessionId, start, sessionId: context.sessionId, targetId: context.target.id,
        generation: context.generation, backendId: this.#options.source.backendId, providerId: selection.providerId, modelId: selection.modelId,
        ...(creation?.name === undefined ? {} : { name: creation.name }), ...(groupSwitch === undefined ? {} : { groupSwitch }), ...(groupMember ? { groupMember: true } : {}),
        permissionMode: creation?.permissionMode ?? policy.permissionMode, fastMode: creation?.fastMode ?? policy.fastMode,
        ...((creation?.effort ?? policy.effort) === undefined ? {} : { effort: creation?.effort ?? policy.effort }), workspace }, context.signal);
      this.#check(context); connection.assertCurrent();
      const controller = connection.createController({ runId, shadow: opened.virtualRoot, context, binding: () => binding });
      controller.registerOperation(runId, context);
      active = { binding, context, runId, connection, controller, shadow: opened.virtualRoot, busy: 0, lastActivity: Date.now() }; this.#sessions.set(context.sessionId, active);
      const running = active;
      const unavailable = (error: unknown) => {
        if (running.closing || running.idleRelease || running.idleClosed || this.#closed || this.#sessions.get(context.sessionId) !== running) return;
        running.failure = error; this.#options.onRuntimeUnavailable?.(context);
      };
      void controller.start().then(() => unavailable(new Error("The original native runtime ended.")), unavailable).catch(() => {});
      await connection.client.call(runId, randomUUID(), { kind: "state" }, context.signal);
      this.#check(context); connection.assertCurrent(); if (active.failure) throw active.failure;
      active.unregisterPool = this.#options.connectionPool?.register({ occupiesSlot: () => !running.idleClosed,
        isIdle: () => !running.failure && !running.closing && running.busy === 0, lastActivityAt: () => running.lastActivity,
        release: minutes => this.#releaseIdle(running, minutes) });
      return active;
    } catch (error) {
      // Cleanup remains owned even when authority changes after native open.
      try {
        if (active) await this.#close(active);
        else { await connection.close(); this.#unclosed.delete(runId); await this.#options.releaseWorkspace?.(context); }
      } catch (cleanup) { throw new AggregateError([error, cleanup], "Hosted native startup cleanup could not be confirmed."); }
      if (this.#options.isCapacityError?.(error)) throw new HostedNativeCapacityError(error);
      throw closedStartup(error);
    }
  }
  async #state(active: ActiveSourceSession, context: AdapterContext): Promise<NativeSessionState> {
    return active.controller.projectState(await this.#call(active, { kind: "state" }, context) as NativeSessionState);
  }
  async #call(active: ActiveSourceSession, command: HostedNativeCommand, context: AdapterContext,
    fence?: (preparation: DurableNativeDispatchPreparation) => Promise<void>): Promise<unknown> {
    active = await this.#ready(context, active.binding);
    while (active.idleRelease || active.idleClosed) active = await this.#ready(context, active.binding);
    this.#active(context); active.connection.assertCurrent();
    const observation = ["state", "commands", "resources", "tools", "tree", "history", "dispatch_during_compaction", "background_output"].includes(command.kind);
    const id = command.kind === "send" ? context.operationId! : context.operationId && !observation
      ? createHash("sha256").update(JSON.stringify([context.operationId, command.kind])).digest("hex") : randomUUID();
    if (!observation) active.controller.registerOperation(id, context, fence, command.kind === "send" ? command.input : undefined,
      command.kind === "control_subagent" && command.input.action === "resume" ? command.input : undefined);
    active.busy++;
    try {
      const value = await active.connection.client.call(active.runId, id, command, context.signal);
      this.#check(context); active.connection.assertCurrent(); return active.controller.projectResult(value);
    } finally { active.busy--; if (!observation) active.lastActivity = Date.now(); }
  }
  async #ready(context: AdapterContext, binding = context.binding): Promise<ActiveSourceSession> {
    const active = this.#active(context, binding);
    if (active.idleRelease) await this.#releaseIdle(active);
    return active.idleClosed ? this.#activate(active.binding, context, "resume") : this.#active(context, binding);
  }
  #releaseIdle(active: ActiveSourceSession, idleMinutes = 1): Promise<boolean> {
    if (active.idleClosed) return Promise.resolve(true);
    if (!active.idleRelease && (active.busy || active.failure || active.closing)) return Promise.resolve(false);
    const release = active.idleRelease ??= { id: randomUUID(), idleMinutes, attempted: false };
    return release.flight ??= (async () => {
      active.connection.assertCurrent();
      const signal = AbortSignal.timeout(15_000);
      if (!release.confirmed) {
        const command: HostedNativeCommand = release.attempted ? { kind: "idle_release_status", releaseCallId: release.id } : { kind: "idle_release", idleMinutes: release.idleMinutes };
        release.attempted = true;
        const value = await active.connection.client.call(active.runId, command.kind === "idle_release" ? release.id : randomUUID(), command, signal);
        if (value === false || value === "busy") { active.idleRelease = undefined; active.lastActivity = Date.now(); return false; }
        if (value !== true && value !== "released") throw new Error("The original idle release outcome is unconfirmed.");
        release.confirmed = true;
      }
      await active.connection.close(); await active.controller.stop();
      this.#unclosed.delete(active.runId); active.unregisterPool?.(); active.unregisterPool = undefined;
      await this.#options.releaseWorkspace?.(active.context); active.idleClosed = true; active.idleRelease = undefined;
      return true;
    })().finally(() => { release.flight = undefined; });
  }
  #active(context: AdapterContext, binding = context.binding): ActiveSourceSession {
    this.#check(context); if (binding) this.#parse(binding, context);
    const active = this.#sessions.get(context.sessionId);
    if (!active || active.binding.generation !== context.generation || binding && active.binding.opaqueRef !== binding.opaqueRef || active.failure || active.closing) {
      throw new Error("The selected hosted native context is unavailable.");
    }
    active.connection.assertCurrent(); return active;
  }
  #close(active: ActiveSourceSession): Promise<void> {
    active.controller.abortPending();
    return active.closing ??= (async () => {
      if (!active.idleClosed) { await active.connection.close(); this.#unclosed.delete(active.runId); await active.controller.stop(); }
      active.unregisterPool?.(); active.unregisterPool = undefined;
      if (!active.idleClosed) await this.#options.releaseWorkspace?.(active.context);
      if (this.#sessions.get(active.context.sessionId) === active) this.#sessions.delete(active.context.sessionId);
    })().catch(error => { active.closing = undefined; throw error; });
  }
  #check(context: AdapterContext): void {
    this.#assertOpen(); context.signal.throwIfAborted(); this.#options.assertContext(context);
    if (context.hostedExecution || context.target.backendId !== this.id || !Number.isSafeInteger(context.generation) || context.generation < 0) throw new Error("Hosted native source authority is invalid.");
  }
  #assertOpen(): void { if (this.#closed) throw new Error("Hosted native Adapter is closed."); }
}
/** Positive native admission rejection after the original startup was closed. */
export class HostedNativeCapacityError extends JokoError {
  constructor(cause: unknown) {
    super({ code: "HOSTED_AGENT_CAPACITY_REJECTED", message: "The selected computer rejected native Agent admission because its session capacity is full.",
      phase: "session_start", retryable: true, stateMayHaveChanged: false, recovery: "Use another authorized group computer or release an eligible idle Agent." }, { cause });
  }
}

function closedStartup(error: unknown): JokoError {
  const failure = toPublicError(error, { code: "HOSTED_AGENT_START_FAILED", phase: "session_start", retryable: true, stateMayHaveChanged: false,
    recovery: "The exact failed native startup was closed. Select an available authorized Source or retry." });
  return new JokoError({ ...failure, stateMayHaveChanged: false }, { cause: error });
}
