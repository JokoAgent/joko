import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { AdapterContext, AdapterEventMetadata, BackendAdapter, BlobRef, CreateNativeSessionInput, EventPayload, HostedExecution, NativeSessionBinding, PermissionMode, PromptInput, SubagentControlInput, UserShellInput } from "@joko/core";
import type { HostedAgentStore, HostedNativeSessionOwner, HostedNativeProviderGrantOwner } from "@joko/store";
import { HostedAgentArtifacts } from "./hosted-agent-artifacts.js";
import { HostedAgentExchange } from "./hosted-agent-exchange.js";
import { HostedAgentSessionSlots, type HostedAgentSlot } from "./hosted-agent-limits.js";
import { createHostedAgentToolChannel, type HostedAgentToolChannel } from "./hosted-agent-tool-channel.js";
import type { HostedNativeCommand } from "@joko/adapter-hosted";
import { materializeHostedProjectFiles } from "./hosted-agent-project-files.js";

export type HostedAgentCall = HostedNativeCommand;

export interface HostedAgentRunOptions {
  readonly runId: string;
  readonly nativeSessionId: string;
  readonly start: "create" | "resume";
  readonly root: string;
  readonly source: { readonly authorityId: string; readonly deviceId: string; readonly sessionId: string; readonly targetId: string; readonly generation: number };
  readonly store: HostedAgentStore;
  readonly trust: "owner" | "guest";
  readonly providerCleanup?: HostedNativeProviderGrantOwner;
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly name?: string;
  readonly modelIds: readonly string[];
  readonly permissionMode: PermissionMode;
  readonly fastMode: boolean;
  readonly effort?: string;
  readonly workspace: Omit<HostedExecution["workspace"], "root" | "additionalRoots">;
  readonly artifactCapacityBytes: number;
  readonly slots: HostedAgentSessionSlots;
  readonly assertCurrent: () => void;
  readonly assertModelAllowed: (providerId: string, modelId: string) => void;
  /** Internal startup owner, before SDK initialization can call Source tools. */
  readonly onCreated?: (run: HostedAgentRun) => void;
  /** A dedicated native Adapter with this run's isolated credential snapshot.
   * The application owns Provider login, network and native executable choice. */
  readonly createAdapter: (input: { readonly home: string; readonly trust: "owner" | "guest"; readonly providerId: string;
    readonly modelIds: readonly string[]; readonly signal: AbortSignal; readonly execution: HostedExecution;
    readonly readBlob: (blob: BlobRef) => Promise<Uint8Array>;
    readonly nativeOwner: { readonly sessionId: string; readonly targetId: string; readonly generation: number; readonly backendInstanceGeneration: number } }) => BackendAdapter | Promise<BackendAdapter>;
}
interface CallReceipt { readonly digest: string; readonly result: Promise<unknown>; settled: boolean }
export class HostedAgentCleanupError extends Error {
  constructor(readonly run: HostedAgentRun) { super("Hosted Agent native cleanup could not be confirmed."); }
}

/** The provider computer owns the actual SDK process. Its reverse tool port,
 * events, interactions and Artifacts remain tied to one authenticated task. */
export class HostedAgentRun {
  readonly id: string;
  readonly exchange: HostedAgentExchange;
  readonly #options: HostedAgentRunOptions;
  readonly #lifetime = new AbortController();
  readonly #slot: HostedAgentSlot;
  readonly #owner: HostedNativeSessionOwner;
  readonly #leaseId = randomUUID();
  #claimed = false;
  #nativeCleaned = false;
  readonly #receipts = new Map<string, CallReceipt>();
  readonly #expiredCalls = new Set<string>();
  #adapter?: BackendAdapter;
  #context?: AdapterContext;
  #binding?: NativeSessionBinding;
  #channel?: HostedAgentToolChannel;
  #artifacts?: HostedAgentArtifacts;
  #opening?: Promise<void>;
  #closing?: Promise<void>;
  #cleanup?: Promise<void>;
  #purging?: Promise<void>;
  #purgeRequested = false;
  #ready = false;
  #startupSettled = false;
  #inputOperationId?: string;
  #shellOperationId?: string;
  #inputImages: readonly BlobRef[] = [];
  #activeProvider?: string;
  readonly #toolOwners = new Map<string, { readonly operationId: string; readonly origin: string }>();

  private constructor(options: HostedAgentRunOptions) {
    if (!options.runId || options.runId.length > 512 || !isAbsolute(options.root) || resolve(options.root) !== options.root
      || !["owner", "guest"].includes(options.trust) || !options.providerId || !options.modelId
      || !options.source.authorityId || !options.source.deviceId || !options.source.sessionId || !options.source.targetId
      || !options.nativeSessionId || !["create", "resume"].includes(options.start)
      || !Number.isSafeInteger(options.source.generation) || options.source.generation < 0) throw new Error("Hosted Agent identity is invalid.");
    options.assertCurrent(); options.assertModelAllowed(options.providerId, options.modelId);
    if (options.trust === "guest" && !options.modelIds.includes(options.modelId)) throw new Error("Shared Agent model is unavailable.");
    this.#options = options;
    this.#owner = { authorityId: options.source.authorityId, deviceId: options.source.deviceId, sessionId: options.source.sessionId,
      targetId: options.source.targetId, nativeSessionId: options.nativeSessionId, backendId: options.backendId, trust: options.trust,
      ...(options.providerCleanup ? { providerGrant: options.providerCleanup } : {}) };
    this.id = options.store.key(this.#owner);
    this.#slot = options.slots.reserve(options.source.deviceId);
    try { this.exchange = new HostedAgentExchange({ assertCurrent: () => options.assertCurrent(), onOverflow: () => { void this.close().catch(() => {}); } }); }
    catch (error) { this.#slot.release(); throw error; }
  }
  static async create(options: HostedAgentRunOptions): Promise<HostedAgentRun> {
    const run = new HostedAgentRun(options); run.#opening = Promise.resolve().then(() => run.#start()).finally(() => { run.#startupSettled = true; });
    options.onCreated?.(run);
    try { await run.#opening; return run; }
    catch (error) { if (!run.#nativeCleaned) throw new HostedAgentCleanupError(run); throw error; }
  }
  get sourceDeviceId(): string { return this.#options.source.deviceId; }
  get sourceSessionId(): string { return this.#options.source.sessionId; }
  get ready(): boolean { return this.#ready && !this.#lifetime.signal.aborted; }
  get initializing(): boolean { return !this.#startupSettled && !this.#lifetime.signal.aborted; }
  checkAuthority(): void { this.#assertAuthority(); }
  get workspaceRoot(): string { return join(this.#options.root, this.id, "workspace"); }
  activeProviderTurns(backendId: string, providerId: string): number {
    return this.#options.backendId === backendId && this.#activeProvider === providerId && !this.#nativeCleaned ? 1 : 0;
  }
  readArtifact(id: string, offset: number, maximum: number): Promise<{ readonly data: string }> {
    this.#assertCurrent(); if (!this.#artifacts) throw new Error("Hosted Artifacts are unavailable."); return this.#artifacts.read(id, offset, maximum);
  }

  call(id: string, command: HostedAgentCall): Promise<unknown> {
    this.#assertCurrent();
    if (!id || id.length > 512 || /[\0\r\n]/u.test(id)) throw new Error("Hosted Agent call identity is invalid.");
    const serialized = JSON.stringify(command);
    if (Buffer.byteLength(serialized) > 64 * 1024 * 1024) throw new Error("Hosted Agent call exceeds its limit.");
    const digest = createHash("sha256").update(serialized).digest("hex"), existing = this.#receipts.get(id);
    if (existing) { if (existing.digest !== digest) throw new Error("Hosted Agent call identity conflicts."); return existing.result; }
    if (this.#expiredCalls.has(id)) throw new Error("Hosted Agent call receipt expired; the native operation was not repeated.");
    // Preserve the exact pending result before calling into a native SDK. No
    // retry or uncertain-response path dispatches the same command a second time.
    if (this.#receipts.size >= 256) {
      const completed = [...this.#receipts].find(([, value]) => value.settled);
      if (!completed || this.#expiredCalls.size >= 65_536) throw new Error("Hosted Agent call receipt capacity is exhausted.");
      this.#receipts.delete(completed[0]); this.#expiredCalls.add(completed[0]);
    }
    const input = JSON.parse(serialized) as HostedAgentCall;
    const result = Promise.resolve().then(() => this.#invokeOnce(id, digest, input)).finally(() => { const current = this.#receipts.get(id); if (current) current.settled = true; });
    this.#receipts.set(id, { digest, result, settled: false }); void result.catch(() => {}); return result;
  }
  close(): Promise<void> {
    return this.#closing ??= (async () => {
      this.#lifetime.abort(); this.exchange.finish(); await this.#channel?.close();
      await this.#opening?.catch(() => {}); await this.#disposeNative(); this.#ready = false;
    })().catch(error => { this.#closing = undefined; throw error; });
  }
  /** Deletion owns this exact lease after the SDK and its processes close.
   * An uncertain cleanup retains the run and quota so a later retry can finish. */
  purge(): Promise<void> {
    this.#purgeRequested = true;
    return this.#purging ??= (async () => {
      await this.close();
      if (!this.#nativeCleaned) throw new HostedAgentCleanupError(this);
      if (this.#claimed) await purgeHostedAgentStorage({ root: this.#options.root, store: this.#options.store, key: this.id, leaseId: this.#leaseId });
      this.#slot.release();
    })().catch(error => { this.#purging = undefined; throw error; });
  }
  /** The connection owner calls this after the final cursor was drained. */
  disposeExchange(): void { this.exchange.close(); this.#receipts.clear(); this.#expiredCalls.clear(); }

  async #start(): Promise<void> {
    try {
      const root = join(this.#options.root, this.id), home = join(root, "native"), workspace = join(root, "workspace");
      await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error("Hosted Agent storage is unsafe.");
      const prior = this.#options.store.claim(this.#owner, this.#leaseId, this.#options.start); this.#claimed = true;
      await mkdir(home, { recursive: true, mode: 0o700 });
      await mkdir(workspace, { recursive: true, mode: 0o700 }); this.#assertAuthority();
      const contextFiles = await materializeHostedProjectFiles({ root: workspace, files: this.#options.workspace.contextFiles ?? [],
        assertCurrent: () => this.#assertAuthority(),
        ...(this.#options.workspace.personalInstructions === undefined ? {} : { personalInstructions: this.#options.workspace.personalInstructions }) });
      this.#channel = await createHostedAgentToolChannel({ assertCurrent: () => this.#assertAuthority(), execute: (input, signal) => this.#executeTool(input, signal) });
      this.#artifacts = new HostedAgentArtifacts({ root, maximumBytes: this.#options.artifactCapacityBytes, assertCurrent: () => this.#assertAuthority(), exchange: this.exchange });
      const hosted: HostedExecution = {
        workspace: { ...this.#options.workspace, contextFiles, root: workspace, additionalRoots: [] },
        channel: this.#channel, source: { sessionId: this.#options.source.sessionId, targetId: this.#options.source.targetId, generation: this.#options.source.generation },
        assertCurrent: () => this.#assertAuthority(),
        ...(this.#options.trust === "owner" ? { trust: "owner" as const } : { trust: "guest" as const, guestHome: root,
          providerId: this.#options.providerId, modelIds: [...this.#options.modelIds] })
      };
      this.#adapter = await this.#options.createAdapter({ home, trust: this.#options.trust, providerId: this.#options.providerId,
        modelIds: this.#options.modelIds, signal: this.#lifetime.signal, execution: hosted,
        readBlob: blob => this.#readInputBlob(blob),
        nativeOwner: { sessionId: `hosted-session:${this.id}`, targetId: `hosted-target:${this.id}`, generation: prior.binding?.generation ?? 1, backendInstanceGeneration: 1 } }); this.#assertAuthority();
      if (this.#adapter.id !== this.#options.backendId || this.#adapter.hostedExecutionCapabilities?.toolsOnSource !== true
        || this.#options.trust === "guest" && this.#adapter.hostedExecutionCapabilities.isolatedGuests !== true) throw new Error("This native Adapter does not support isolated hosted execution.");
      const target = { id: `hosted-target:${this.id}`, backendId: this.#adapter.id, displayName: "Hosted Agent", workspaceRoot: workspace, trusted: false, managed: true };
      this.#context = { sessionId: `hosted-session:${this.id}`, generation: prior.binding?.generation ?? 1, backendInstanceGeneration: 1, target, hostedExecution: hosted,
        signal: this.#lifetime.signal, operationId: this.#options.runId, modelSelection: { providerId: this.#options.providerId, modelId: this.#options.modelId },
        emit: (event, metadata) => this.#emit(event, metadata, this.#options.runId),
        requestInteraction: (interaction, options) => this.exchange.interaction(interaction,
          options?.signal ? AbortSignal.any([this.#lifetime.signal, options.signal]) : this.#lifetime.signal, this.#options.runId),
        artifactCapacityBytes: this.#options.artifactCapacityBytes,
        storeArtifact: (path, options) => this.#artifacts!.store(path, this.#lifetime.signal, options, this.#options.runId) };
      const creation: CreateNativeSessionInput = { target, providerId: this.#options.providerId, modelId: this.#options.modelId,
        ...(this.#options.name === undefined ? {} : { name: this.#options.name }),
        permissionMode: this.#options.permissionMode, fastMode: this.#options.fastMode, ...(this.#options.effort ? { effort: this.#options.effort } : {}) };
      if (prior.binding) {
        this.#context = { ...this.#context, binding: prior.binding };
        const resumed = await this.#adapter.resumeSession(prior.binding, this.#context); this.#assertAuthority(); this.#binding = resumed.binding;
        if (resumed.streaming) this.#activeProvider = resumed.providerId ?? this.#options.providerId;
        this.#context = { ...this.#context, binding: resumed.binding, generation: resumed.binding.generation };
        if (resumed.providerId !== this.#options.providerId || resumed.modelId !== this.#options.modelId) {
          this.#options.assertModelAllowed(this.#options.providerId, this.#options.modelId);
          await this.#adapter.setModel(this.#options.providerId, this.#options.modelId, this.#context);
        }
        if (this.#options.effort !== undefined && resumed.effort !== this.#options.effort) await this.#adapter.setEffort(this.#options.effort, this.#context);
        if (resumed.fastMode !== this.#options.fastMode) await this.#adapter.setFastMode(this.#options.fastMode, this.#context);
        if (resumed.permissionMode !== this.#options.permissionMode) await this.#adapter.setPermissionMode(this.#options.permissionMode, this.#context);
      } else this.#binding = await this.#adapter.createSession(creation, this.#context);
      this.#assertAuthority(); this.#options.store.bind(this.id, this.#leaseId, this.#binding);
      this.#context = { ...this.#context, binding: this.#binding }; this.#ready = true;
    } catch (error) {
      this.#lifetime.abort(); this.exchange.finish(); await this.#channel?.close();
      try { await this.#disposeNative(); } catch { throw new Error("Hosted Agent startup cleanup could not be confirmed."); }
      throw error;
    }
  }
  #assertAuthority(): void {
    this.#lifetime.signal.throwIfAborted(); this.#options.assertCurrent();
    if (this.#claimed) this.#options.store.assertLease(this.id, this.#leaseId);
    const model = this.#context?.modelSelection;
    this.#options.assertModelAllowed(model?.providerId ?? this.#options.providerId, model?.modelId ?? this.#options.modelId);
  }
  async #emit(event: EventPayload, metadata?: AdapterEventMetadata, operationId?: string): Promise<void> {
    this.#assertAuthority();
    if (event.type === "done" || event.type === "run_state" && ["completed", "aborted", "failed"].includes(event.state)) this.#activeProvider = undefined;
    else if (event.type === "run_state" && ["running", "waiting", "retrying", "dispatch_unknown"].includes(event.state)) this.#activeProvider = this.#context?.modelSelection?.providerId ?? this.#options.providerId;
    if (event.type === "native_session_changed") {
      const binding: NativeSessionBinding = { opaqueRef: event.opaqueRef,
        ...(event.nativeSessionId === undefined ? {} : { nativeSessionId: event.nativeSessionId }),
        generation: this.#context?.generation ?? 1 };
      // The native SDK can switch its active persistence independently of a
      // product control response. Adopt that exact reference before publishing
      // the event so a restart cannot resume the previous context instead.
      this.#options.store.bind(this.id, this.#leaseId, binding); this.#binding = binding;
      if (this.#context) this.#context = { ...this.#context, binding };
    }
    // Some native SDK subscriptions retain the creation context. Once a turn
    // is dispatched, its foreground events still belong to that original
    // input operation so the Source can settle its exact queue item.
    const owner = operationId === this.#options.runId ? this.#inputOperationId ?? operationId : operationId;
    this.exchange.emit(event, metadata, owner);
  }
  async #executeTool(value: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Hosted tool ownership is invalid.");
    const { origin, ...input } = value as Record<string, unknown>;
    if (origin !== "agent" && origin !== "user_shell" || typeof input.callId !== "string") throw new Error("Hosted tool ownership is invalid.");
    if (input.operation === "codex.exec_server") {
      if (origin !== "agent") throw new Error("Hosted native execution ownership is invalid.");
      return this.exchange.tool(input, signal, this.#inputOperationId ?? this.#options.runId);
    }
    let owner = this.#toolOwners.get(input.callId);
    if (input.operation === "tool.begin") {
      const operationId = origin === "user_shell" ? this.#shellOperationId : this.#inputOperationId;
      if (!operationId || owner || this.#toolOwners.size >= 256) throw new Error("Hosted tool has no current native owner.");
      owner = { operationId, origin }; this.#toolOwners.set(input.callId, owner);
    }
    if (!owner || owner.origin !== origin) throw new Error("Hosted tool has no current native owner.");
    try { return await this.exchange.tool(input, signal, owner.operationId); }
    catch (error) { if (input.operation === "tool.begin") this.#toolOwners.delete(input.callId); throw error; }
    finally { if (input.operation === "tool.end") this.#toolOwners.delete(input.callId); }
  }
  async #readInputBlob(blob: BlobRef): Promise<Uint8Array> {
    const operationId = this.#inputOperationId;
    const expected = this.#inputImages.find(candidate => candidate.id === blob.id && candidate.sha256 === blob.sha256 && candidate.byteLength === blob.byteLength && candidate.mimeType === blob.mimeType);
    if (!operationId || !expected || !Number.isSafeInteger(blob.byteLength) || blob.byteLength < 0 || blob.byteLength > this.#options.artifactCapacityBytes) throw new Error("The native input image is outside this dispatch.");
    const parts: Buffer[] = []; let received = 0;
    while (received < blob.byteLength) {
      this.#assertCurrent();
      const maximum = Math.min(1024 * 1024, blob.byteLength - received);
      const result = await this.exchange.tool({ operation: "input.blob", blob: expected, offset: received, maximum }, this.#lifetime.signal, operationId);
      if (!result || typeof result.data !== "string" || result.data.length > Math.ceil(maximum / 3) * 4) throw new Error("The Source input image is invalid.");
      const bytes = Buffer.from(result.data, "base64");
      if (!bytes.length || bytes.length > maximum || bytes.toString("base64") !== result.data) throw new Error("The Source input image is invalid.");
      parts.push(bytes); received += bytes.length;
    }
    const bytes = Buffer.concat(parts); this.#assertCurrent();
    if (received !== blob.byteLength || createHash("sha256").update(bytes).digest("hex") !== blob.sha256) throw new Error("The Source input image failed integrity validation.");
    return bytes;
  }
  #operationContext(id: string): AdapterContext {
    return { ...this.#context!, operationId: id,
      emit: (event, metadata) => this.#emit(event, metadata, id),
      requestInteraction: (interaction, options) => this.exchange.interaction(interaction,
        options?.signal ? AbortSignal.any([this.#lifetime.signal, options.signal]) : this.#lifetime.signal, id),
      storeArtifact: (path, options) => this.#artifacts!.store(path, this.#lifetime.signal, options, id) };
  }
  #assertCurrent(): void { this.#assertAuthority(); if (!this.#ready || !this.#adapter || !this.#context || !this.#binding) throw new Error("Hosted Agent runtime is not active."); }
  #disposeNative(): Promise<void> {
    return this.#cleanup ??= (async () => {
      await this.#adapter?.dispose(); await this.#artifacts?.close(); this.#toolOwners.clear(); this.#nativeCleaned = true; this.#activeProvider = undefined;
      try { if (this.#claimed && this.#options.store.find(this.id)?.leaseId === this.#leaseId) this.#options.store.close(this.id, this.#leaseId); }
      finally { if (!this.#purgeRequested) this.#slot.release(); }
    })().catch(error => { this.#cleanup = undefined; throw error; });
  }
  async #invokeOnce(id: string, digest: string, command: HostedAgentCall): Promise<unknown> {
    this.#assertCurrent();
    if (["state", "commands", "resources", "tools", "tree", "history"].includes(command.kind)) return this.#invoke(id, command);
    const prior = this.#options.store.call(this.id, id);
    if (prior) {
      if (prior.digest !== digest) throw new Error("Hosted Agent durable call identity conflicts.");
      if (prior.state === "completed") return JSON.parse(prior.resultJson!);
      throw new Error(prior.state === "pending" ? "The prior native outcome is unknown; the operation was not repeated." : "The prior native operation failed and was not repeated.");
    }
    this.#options.store.claimCall(this.id, this.#leaseId, id, digest);
    let result: unknown;
    try { result = await this.#invoke(id, command); }
    catch (error) {
      try { this.#options.store.finishCall(this.id, this.#leaseId, id, digest, { ok: false }); } catch { /* A pending receipt remains outcome-unknown. */ }
      throw error;
    }
    // A commit failure leaves the durable pending receipt intact. Retrying that
    // ID must not repeat a native effect whose response could have been lost.
    this.#options.store.finishCall(this.id, this.#leaseId, id, digest, { ok: true, value: result }); return result;
  }
  async #invoke(id: string, command: HostedAgentCall): Promise<unknown> {
    this.#assertCurrent(); const adapter = this.#adapter!, observation = ["state", "commands", "resources", "tools", "tree", "history"].includes(command.kind);
    const context = this.#operationContext(observation ? this.#options.runId : id);
    switch (command.kind) {
      case "state": return adapter.inspectSession(this.#binding!, context);
      case "send":
        this.#activeProvider = context.modelSelection?.providerId ?? this.#options.providerId;
        this.#inputOperationId = id;
        this.#inputImages = command.input.images.map(image => ({ ...image.blob }));
        this.#options.assertModelAllowed(context.modelSelection!.providerId, context.modelSelection!.modelId);
        if (command.durableFence) {
          if (!adapter.sendWithDurableNativeDispatchFence) throw new Error("Hosted native dispatch fencing is unsupported.");
          await adapter.sendWithDurableNativeDispatchFence(command.input, context, preparation => this.exchange.nativeDispatch(id, preparation, this.#lifetime.signal));
        } else await adapter.send(command.input, context);
        return null;
      case "abort": await adapter.abort(context); return null;
      case "delete": await adapter.deleteSession(this.#binding!, context); return null;
      case "set_model": {
        this.#options.assertModelAllowed(command.providerId, command.modelId);
        const model = await adapter.setModel(command.providerId, command.modelId, context); this.#assertCurrent();
        this.#context = { ...this.#context!, modelSelection: { providerId: command.providerId, modelId: command.modelId } }; return model;
      }
      case "set_effort": await adapter.setEffort(command.effort, context); return null;
      case "set_fast": await adapter.setFastMode(command.enabled, context); return null;
      case "set_permission": await adapter.setPermissionMode(command.mode, context); return null;
      case "set_plan": await adapter.setPlanMode(command.enabled, context); return null;
      case "set_name": await adapter.setName(command.name, context); return null;
      case "set_auto_compaction": await adapter.setAutoCompaction(command.enabled, context); return null;
      case "set_auto_retry": await adapter.setAutoRetry(command.enabled, context); return null;
      case "abort_retry": await adapter.abortRetry(context); return null;
      case "compact": return adapter.compact(command.instructions, context);
      case "commands": return adapter.getCommands(context);
      case "resources": return adapter.getResources(context);
      case "tree": return adapter.getTree(context);
      case "tools": if (!adapter.getRuntimeTools) throw new Error("Hosted runtime tool catalog is unsupported."); return adapter.getRuntimeTools(context);
      case "history": if (!adapter.getNativeHistoryProjection) throw new Error("Hosted native history is unsupported."); return adapter.getNativeHistoryProjection(context);
      case "shell": {
        if (!adapter.executeUserShell || this.#shellOperationId) throw new Error("Hosted user shell is unavailable.");
        this.#shellOperationId = id;
        try { return await adapter.executeUserShell(command.input, context); }
        finally { if (this.#shellOperationId === id) this.#shellOperationId = undefined; }
      }
      case "abort_shell": if (!adapter.abortUserShell) throw new Error("Hosted user shell is unsupported."); await adapter.abortUserShell(context); return null;
      case "control_subagent": if (!adapter.controlSubagent) throw new Error("Hosted child control is unsupported."); await adapter.controlSubagent(command.input, context); return null;
    }
  }
}

/** Only a confirmed closed process or its in-memory owner may call this.
 * The persistent purge fence prevents a resume from replacing this lease
 * while filesystem deletion awaits the operating system. */
export async function purgeHostedAgentStorage(options: { readonly root: string; readonly store: HostedAgentStore; readonly key: string; readonly leaseId: string }): Promise<void> {
  if (!isAbsolute(options.root) || resolve(options.root) !== options.root || !/^[a-f0-9]{64}$/u.test(options.key)) throw new Error("Hosted Agent cleanup path is invalid.");
  const target = resolve(options.root, options.key);
  if (target !== join(options.root, options.key) || target === options.root || await realpath(options.root) !== options.root) throw new Error("Hosted Agent cleanup path is unsafe.");
  options.store.beginPurge(options.key, options.leaseId);
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(target) !== target) throw new Error("Hosted Agent cleanup directory is unsafe.");
    options.store.assertLease(options.key, options.leaseId);
    await rm(target, { recursive: true, force: false });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  options.store.finishPurge(options.key, options.leaseId);
}
