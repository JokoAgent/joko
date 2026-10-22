import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { AdapterContext, BackendAdapter, BackendDescriptor, BlobRef, CreateNativeSessionInput, DurableNativeDispatchPreparation,
  NativeHistoryProjection, NativeNavigationTarget, NativeSessionBinding, NativeSessionDerivation, NativeSessionForkResult,
  NativeSessionNavigation, NativeSessionNavigationResult, NativeSessionState, PromptInput, ProviderModel, RuntimeCommand, RuntimeResource,
  RuntimeToolCatalog, SessionTree, SubagentControlInput, TargetDescriptor, UserShellInput, UserShellResult } from "@joko/core";
import type { HostedNativeCommand, HostedNativeOpen } from "./protocol.js";
import { JokoError, toPublicError } from "@joko/core";

const identity = z.string().min(1).max(512).refine(value => !/[\0\r\n]/u.test(value));
const sourceSchema = z.strictObject({ controllerDeviceId: identity, targetDeviceId: identity, backendId: identity });
const bindingSchema = z.strictObject({ format: z.literal(1), backendId: identity, source: sourceSchema,
  sessionId: identity, targetId: identity, nativeSessionId: identity });
type SourceBinding = z.infer<typeof bindingSchema>;
export type HostedAgentDeviceSource = z.infer<typeof sourceSchema>;
export interface HostedAgentSourceController {
  start(): Promise<void>;
  stop(): Promise<void>;
  abortPending(): void;
  registerOperation(id: string, context: AdapterContext, fence?: (preparation: DurableNativeDispatchPreparation) => Promise<void>, input?: PromptInput): void;
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
  readonly takeGroupSwitch?: (context: AdapterContext) => string | undefined;
  readonly takeNewGroupRound?: (context: AdapterContext) => boolean;
  readonly isGroupMember?: (context: AdapterContext) => boolean;
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
  async validateTarget(target: TargetDescriptor): Promise<void> {
    this.#assertOpen();
    if (target.backendId !== this.id || target.remoteWorkspace || !target.trusted || !isAbsolute(target.workspaceRoot)
      || await realpath(target.workspaceRoot) !== target.workspaceRoot) throw new Error("Hosted native task workspace is unavailable.");
  }
  async createSession(input: CreateNativeSessionInput, context: AdapterContext): Promise<NativeSessionBinding> {
    this.#check(context); await this.validateTarget(input.target);
    if (input.nativeStart && (input.nativeStart.kind !== "new" || input.nativeStart.parentNativeReference)) throw new Error("Hosted native attachment is unavailable.");
    if (!input.providerId || !input.modelId) throw new Error("Hosted native creation requires an explicit model and source.");
    const nativeSessionId = createHash("sha256").update(JSON.stringify([this.id, context.sessionId, context.target.id,
      context.generation, context.operationId ?? "create"])).digest("hex");
    const binding = this.#binding(context, nativeSessionId);
    await this.#activate(binding, { ...context, modelSelection: { providerId: input.providerId, modelId: input.modelId } }, "create",
      { permissionMode: input.permissionMode, fastMode: input.fastMode, ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.effort === undefined ? {} : { effort: input.effort }) });
    return binding;
  }
  async resumeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    const active = await this.#activate(binding, context, "resume"); return this.#state(active, context);
  }
  async inspectSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    const active = this.#active(context, binding); return this.#state(active, context);
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
  async setFastMode(enabled: boolean, context: AdapterContext): Promise<void> { await this.#call(this.#active(context), { kind: "set_fast", enabled }, context); }
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
    this.#active(context);
    return this.#options.commands?.(context) ?? await this.#call(this.#active(context), { kind: "commands" }, context) as readonly RuntimeCommand[];
  }
  async getResources(context: AdapterContext): Promise<readonly RuntimeResource[]> {
    this.#active(context);
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
  async deleteSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    const active = await this.#activate(binding, context, "resume"); await this.#call(active, { kind: "delete" }, context); await this.#close(active); await this.#options.deleteWorkspace?.(context);
  }
  async exportSession(_context: AdapterContext): Promise<BlobRef> { throw new Error("Hosted native export is not connected."); }
  async navigateTree(_target: NativeNavigationTarget, _summarize: boolean, _context: AdapterContext, _instructions: string | undefined,
    _navigation: NativeSessionNavigation): Promise<NativeSessionNavigationResult> { throw new Error("Hosted native navigation is not connected."); }
  async fork(_entryId: string, _context: AdapterContext, _derivation: NativeSessionDerivation): Promise<NativeSessionForkResult> { throw new Error("Hosted native fork is not connected."); }
  async clone(_context: AdapterContext, _derivation: NativeSessionDerivation): Promise<NativeSessionBinding> { throw new Error("Hosted native clone is not connected."); }
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
    const active = this.#active(context);
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
    const value: SourceBinding = { format: 1, backendId: this.id, source: this.#options.source, sessionId: context.sessionId, targetId: context.target.id, nativeSessionId };
    return { opaqueRef: JSON.stringify(value), nativeSessionId, generation: context.generation };
  }
  #parse(binding: NativeSessionBinding, context: AdapterContext): SourceBinding {
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
    if (current && !current.failure && !(start === "resume" && current.binding.opaqueRef === binding.opaqueRef
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
      active = { binding, context, runId, connection, controller, shadow: opened.virtualRoot }; this.#sessions.set(context.sessionId, active);
      const running = active;
      const unavailable = (error: unknown) => {
        if (running.closing || this.#closed || this.#sessions.get(context.sessionId) !== running) return;
        running.failure = error; this.#options.onRuntimeUnavailable?.(context);
      };
      void controller.start().then(() => unavailable(new Error("The original native runtime ended.")), unavailable).catch(() => {});
      await connection.client.call(runId, randomUUID(), { kind: "state" }, context.signal);
      this.#check(context); connection.assertCurrent(); if (active.failure) throw active.failure;
      return active;
    } catch (error) {
      // Cleanup remains owned even when authority changes after native open.
      try { await connection.close(); this.#unclosed.delete(runId); } catch (cleanup) { throw new AggregateError([error, cleanup], "Hosted native startup cleanup could not be confirmed."); }
      if (active) await this.#close(active); else await this.#options.releaseWorkspace?.(context); throw closedStartup(error);
    }
  }
  async #state(active: ActiveSourceSession, context: AdapterContext): Promise<NativeSessionState> {
    return active.controller.projectState(await this.#call(active, { kind: "state" }, context) as NativeSessionState);
  }
  async #call(active: ActiveSourceSession, command: HostedNativeCommand, context: AdapterContext,
    fence?: (preparation: DurableNativeDispatchPreparation) => Promise<void>): Promise<unknown> {
    this.#active(context); active.connection.assertCurrent();
    const observation = ["state", "commands", "resources", "tools", "tree", "history"].includes(command.kind);
    const id = command.kind === "send" ? context.operationId! : context.operationId && !observation
      ? createHash("sha256").update(JSON.stringify([context.operationId, command.kind])).digest("hex") : randomUUID();
    if (!observation) active.controller.registerOperation(id, context, fence, command.kind === "send" ? command.input : undefined);
    const value = await active.connection.client.call(active.runId, id, command, context.signal);
    this.#check(context); active.connection.assertCurrent(); return active.controller.projectResult(value);
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
      await active.connection.close(); this.#unclosed.delete(active.runId); await active.controller.stop();
      await this.#options.releaseWorkspace?.(active.context);
      if (this.#sessions.get(active.context.sessionId) === active) this.#sessions.delete(active.context.sessionId);
    })().catch(error => { active.closing = undefined; throw error; });
  }
  #check(context: AdapterContext): void {
    this.#assertOpen(); context.signal.throwIfAborted(); this.#options.assertContext(context);
    if (context.hostedExecution || context.target.backendId !== this.id || !Number.isSafeInteger(context.generation) || context.generation < 0) throw new Error("Hosted native source authority is invalid.");
  }
  #assertOpen(): void { if (this.#closed) throw new Error("Hosted native Adapter is closed."); }
}
function closedStartup(error: unknown): JokoError {
  const failure = toPublicError(error, { code: "HOSTED_AGENT_START_FAILED", phase: "session_start", retryable: true, stateMayHaveChanged: false,
    recovery: "The exact failed native startup was closed. Select an available authorized Source or retry." });
  return new JokoError({ ...failure, stateMayHaveChanged: false }, { cause: error });
}
