import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { AdapterContext, AdapterEventMetadata, BackendAdapter, BlobRef, CreateNativeSessionInput, EventPayload, HostedExecution, NativeSessionBinding, NativeSessionDerivationLifecycle, PermissionMode, PromptInput, SubagentControlInput, UsageSnapshot, UserShellInput } from "@joko/core";
import { JokoError } from "@joko/core";
import { assertManagedSubagentHostedToolScope, managedSubagentRunRoot, type PiHostedBackgroundScope } from "@joko/adapter-pi";
import type { HostedAgentStore, HostedNativeSessionOwner, HostedNativeProviderGrantOwner } from "@joko/store";
import { HostedAgentArtifacts } from "./hosted-agent-artifacts.js";
import { HostedAgentExchange } from "./hosted-agent-exchange.js";
import { HostedAgentSessionSlots, type HostedAgentSlot } from "./hosted-agent-limits.js";
import { createHostedAgentToolChannel, type HostedAgentToolChannel } from "./hosted-agent-tool-channel.js";
import { HostedAgentNativeMcp } from "./hosted-agent-native-mcp.js";
import type { HostedNativeCommand } from "@joko/adapter-hosted";
import { materializeHostedProjectFiles } from "./hosted-agent-project-files.js";
import { hostedDirectoryPath } from "./hosted-agent-directories.js";
import { HostedAgentNavigation } from "./hosted-agent-navigation.js";

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
  readonly fastMode: boolean | "ultrafast";
  readonly effort?: string;
  readonly workspace: Omit<HostedExecution["workspace"], "root" | "additionalRoots">;
  readonly artifactCapacityBytes: number;
  readonly slots: HostedAgentSessionSlots;
  readonly assertCurrent: () => void;
  readonly assertModelAllowed: (providerId: string, modelId: string) => void;
  readonly usage?: {
    begin(callId: string, modelId: string, baseline: UsageSnapshot | undefined): void;
    finish(callId: string, observation: UsageSnapshot | undefined): void;
  };
  /** Internal startup owner, before SDK initialization can call Source tools. */
  readonly onCreated?: (run: HostedAgentRun) => void;
  /** A dedicated native Adapter with this run's isolated credential snapshot.
   * The application owns Provider login, network and native executable choice. */
  readonly createAdapter: (input: { readonly home: string; readonly trust: "owner" | "guest"; readonly providerId: string;
    readonly modelIds: readonly string[]; readonly signal: AbortSignal; readonly execution: HostedExecution;
    readonly sourceMcp?: HostedAgentNativeMcp;
    readonly readBlob: (blob: BlobRef) => Promise<Uint8Array>;
    readonly nativeOwner: { readonly sessionId: string; readonly targetId: string; readonly generation: number; readonly backendInstanceGeneration: number } }) => BackendAdapter | Promise<BackendAdapter>;
}
interface CallReceipt { readonly digest: string; readonly result: Promise<unknown>; settled: boolean }
export class HostedAgentCleanupError extends Error {
  constructor(readonly run: HostedAgentRun) { super("Hosted Agent native cleanup could not be confirmed."); }
}
function sameBackgroundScope(expected: PiHostedBackgroundScope, value: unknown): value is PiHostedBackgroundScope {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 5) return false;
  const scope = value as PiHostedBackgroundScope;
  return scope.taskId === expected.taskId && scope.runId === expected.runId && scope.launchToken === expected.launchToken
    && scope.runnerInstanceId === expected.runnerInstanceId && scope.nativeSessionId === expected.nativeSessionId;
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
  readonly #storageKey: string;
  readonly #persistentReadOnly: boolean;
  readonly #derivations = new Set<string>();
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
  #usageTurn?: string;
  #lastUsage?: UsageSnapshot;
  readonly #usageFollowUps = new Map<string, string>();
  #usageObserved = false;
  readonly #toolOwners = new Map<string, { readonly operationId: string; readonly origin: string; readonly backgroundScope?: string }>();
  readonly #backgroundOwners = new Map<string, { readonly operationId: string; readonly scope: PiHostedBackgroundScope; readonly generation: number }>();
  readonly #nativeToolOwners = new Map<string, string>();
  readonly #nativeToolOwnerWaiters = new Map<string, Set<() => void>>();
  readonly #backgroundResumes = new Map<string, string>();
  readonly #backgroundRegistrations = new Set<string>();
  #nativeHome?: string;
  #mcp?: HostedAgentNativeMcp;
  readonly #navigation: HostedAgentNavigation;
  #navigating = false;
  #idleReleaseId?: string;
  readonly #activeBackground = new Set<string>();
  readonly #observedBackground = new Set<string>();
  #lastActivity = Date.now();

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
    this.#storageKey = options.store.find(this.id)?.storageKey ?? this.id;
    this.#persistentReadOnly = options.store.find(this.id)?.derivation?.completedSnapshot !== undefined;
    this.#navigation = new HostedAgentNavigation(options.store, this.id, this.#leaseId);
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
  get workspaceRoot(): string { return join(this.#options.root, this.#storageKey, "workspace"); }
  hasNativeDerivation(operationId: string): boolean { return this.#derivations.has(operationId); }
  activeProviderTurns(backendId: string, providerId: string): number {
    return this.#options.backendId === backendId && this.#activeProvider === providerId && !this.#nativeCleaned ? 1 : 0;
  }
  readArtifact(id: string, offset: number, maximum: number): Promise<{ readonly data: string }> {
    this.#assertCurrent(); if (!this.#artifacts) throw new Error("Hosted Artifacts are unavailable."); return this.#artifacts.read(id, offset, maximum);
  }

  call(id: string, command: HostedAgentCall): Promise<unknown> {
    if (command.kind !== "idle_release_status") this.#assertCurrent(); else this.#options.assertCurrent();
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
      if (this.#claimed) { this.#navigation.clear(); await purgeHostedAgentStorage({ root: this.#options.root, store: this.#options.store, key: this.id, leaseId: this.#leaseId }); }
      this.#slot.release();
    })().catch(error => { this.#purging = undefined; throw error; });
  }
  /** The connection owner calls this after the final cursor was drained. */
  disposeExchange(): void { this.exchange.close(); this.#receipts.clear(); this.#expiredCalls.clear(); }

  async #start(): Promise<void> {
    try {
      const root = join(this.#options.root, this.#storageKey), home = join(root, "native"), workspace = join(root, "workspace");
      await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error("Hosted Agent storage is unsafe.");
      const prior = this.#options.store.claim(this.#owner, this.#leaseId, this.#options.start); this.#claimed = true;
      await mkdir(home, { recursive: true, mode: 0o700 });
      this.#nativeHome = home;
      await mkdir(workspace, { recursive: true, mode: 0o700 }); this.#assertAuthority();
      const contextFiles = await materializeHostedProjectFiles({ root: workspace, files: this.#options.workspace.contextFiles ?? [],
        assertCurrent: () => this.#assertAuthority(),
        ...(this.#options.workspace.personalInstructions === undefined ? {} : { personalInstructions: this.#options.workspace.personalInstructions }) });
      this.#channel = await createHostedAgentToolChannel({ assertCurrent: () => this.#assertAuthority(), execute: (input, signal) => this.#executeTool(input, signal) });
      this.#artifacts = new HostedAgentArtifacts({ root, maximumBytes: this.#options.artifactCapacityBytes, assertCurrent: () => this.#assertAuthority(), exchange: this.exchange });
      const hosted: HostedExecution = {
        workspace: { ...this.#options.workspace, contextFiles, root: workspace,
          additionalRoots: (this.#options.workspace.additionalDirectoryIds ?? []).map(id => hostedDirectoryPath(workspace, id)) },
        channel: this.#channel, source: { sessionId: this.#options.source.sessionId, targetId: this.#options.source.targetId, generation: this.#options.source.generation },
        assertCurrent: () => this.#assertAuthority(),
        ...(this.#options.trust === "owner" ? { trust: "owner" as const } : { trust: "guest" as const, guestHome: root,
          providerId: this.#options.providerId, modelIds: [...this.#options.modelIds] })
      };
      const pendingNavigation = this.#navigation.read();
      const retainedBinding = pendingNavigation?.sourceRetired ? pendingNavigation.binding : prior.binding;
      const nativeOwner = { sessionId: `hosted-session:${this.id}`, targetId: `hosted-target:${this.#storageKey}`, generation: retainedBinding?.generation ?? 1, backendInstanceGeneration: 1 };
      if (hosted.workspace.mcpEnabled && !this.#persistentReadOnly) this.#mcp = await HostedAgentNativeMcp.create({ owner: nativeOwner, signal: this.#lifetime.signal,
        assertCurrent: () => this.#assertAuthority(), execute: (request, signal) => this.exchange.tool({ operation: "mcp.request", request }, signal,
          request.kind === "catalog" || request.kind === "model_open" || request.kind === "model_poll" || request.kind === "model_close" ? this.#options.runId : this.#inputOperationId ?? this.#options.runId) });
      this.#adapter = await this.#options.createAdapter({ home, trust: this.#options.trust, providerId: this.#options.providerId,
        modelIds: this.#options.modelIds, signal: this.#lifetime.signal, execution: hosted,
        ...(this.#mcp ? { sourceMcp: this.#mcp } : {}),
        readBlob: blob => this.#readInputBlob(blob),
        nativeOwner }); this.#assertAuthority();
      if (this.#adapter.id !== this.#options.backendId || this.#adapter.hostedExecutionCapabilities?.toolsOnSource !== true
        || this.#options.trust === "guest" && this.#adapter.hostedExecutionCapabilities.isolatedGuests !== true) throw new Error("This native Adapter does not support isolated hosted execution.");
      const target = { id: `hosted-target:${this.#storageKey}`, backendId: this.#adapter.id, displayName: "Hosted Agent", workspaceRoot: workspace, trusted: false, managed: true };
      this.#context = { sessionId: `hosted-session:${this.id}`, generation: retainedBinding?.generation ?? 1, backendInstanceGeneration: 1, target, hostedExecution: hosted,
        ...(this.#persistentReadOnly ? { runtimePolicy: "review_read_only" as const, persistentReadOnly: "side_chat" as const } : {}),
        signal: this.#lifetime.signal, operationId: this.#options.runId, modelSelection: { providerId: this.#options.providerId, modelId: this.#options.modelId },
        emit: (event, metadata) => this.#emit(event, metadata, this.#options.runId),
        requestInteraction: (interaction, options) => this.exchange.interaction(interaction,
          options?.signal ? AbortSignal.any([this.#lifetime.signal, options.signal]) : this.#lifetime.signal, this.#options.runId),
        artifactCapacityBytes: this.#options.artifactCapacityBytes,
        storeArtifact: (path, options) => this.#artifacts!.store(path, this.#lifetime.signal, options, this.#options.runId) };
      const creation: CreateNativeSessionInput = { target, providerId: this.#options.providerId, modelId: this.#options.modelId,
        ...(this.#options.name === undefined ? {} : { name: this.#options.name }),
        permissionMode: this.#options.permissionMode, fastMode: this.#options.fastMode, ...(this.#options.effort ? { effort: this.#options.effort } : {}) };
      if (pendingNavigation) {
        const lifecycle = this.#navigation.lifecycle(this.#context.sessionId, target);
        const owned = await this.#adapter.ownsNativeSessionDerivationLifecycle?.(lifecycle) === true;
        if (pendingNavigation.sourceRetired) {
          if (owned) {
            if (!this.#adapter.adoptNativeSessionDerivation) throw new Error("The native navigation adoption owner is unavailable.");
            await this.#adapter.adoptNativeSessionDerivation(lifecycle, this.#lifetime.signal);
          }
          this.#navigation.complete(pendingNavigation.binding);
        } else {
          if (owned) {
            if (!this.#adapter.cleanupNativeSessionDerivation) throw new Error("The native navigation cleanup owner is unavailable.");
            await this.#adapter.cleanupNativeSessionDerivation(lifecycle, this.#lifetime.signal);
          } else await this.#adapter.deleteSession(pendingNavigation.binding, { ...this.#context,
            binding: pendingNavigation.binding, generation: pendingNavigation.binding.generation });
          this.#navigation.clear();
        }
      }
      if (retainedBinding) {
        this.#context = { ...this.#context, binding: retainedBinding };
        const resumed = await this.#adapter.resumeSession(retainedBinding, this.#context); this.#assertAuthority(); this.#binding = resumed.binding;
        if (resumed.streaming) this.#activeProvider = resumed.providerId ?? this.#options.providerId;
        this.#context = { ...this.#context, binding: resumed.binding, generation: resumed.binding.generation };
        if (!this.#persistentReadOnly && (resumed.providerId !== this.#options.providerId || resumed.modelId !== this.#options.modelId)) {
          this.#options.assertModelAllowed(this.#options.providerId, this.#options.modelId);
          await this.#adapter.setModel(this.#options.providerId, this.#options.modelId, this.#context);
        }
        if (!this.#persistentReadOnly) {
          if (this.#options.effort !== undefined && resumed.effort !== this.#options.effort) await this.#adapter.setEffort(this.#options.effort, this.#context);
          if (resumed.fastMode !== this.#options.fastMode) await this.#adapter.setFastMode(this.#options.fastMode, this.#context);
          if (resumed.permissionMode !== this.#options.permissionMode) await this.#adapter.setPermissionMode(this.#options.permissionMode, this.#context);
        } else if (resumed.permissionMode !== "ask" || resumed.fastMode !== false) throw new Error("The native Side Chat did not confirm its immutable read-only launch profile.");
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
    const usageOwner = operationId === this.#options.runId ? this.#inputOperationId ?? operationId : operationId;
    if (this.#options.usage && !this.#usageTurn && event.type === "run_state" && event.state === "running" && usageOwner) {
      const modelId = this.#usageFollowUps.get(usageOwner);
      if (modelId) {
        this.#options.usage.begin(usageOwner, modelId, this.#lastUsage); this.#usageTurn = usageOwner;
        this.#usageObserved = false; this.#usageFollowUps.delete(usageOwner);
      }
    }
    if (["done", "run_state", "tool_start", "tool_result", "background_task", "subagent_run", "subagent_transcript"].includes(event.type)) this.#lastActivity = Date.now();
    this.#observeBackground(event);
    if (event.type === "usage") { this.#lastUsage = event.usage; this.#usageObserved = true; }
    if (this.#usageTurn && (event.type === "done" || event.type === "run_state" && ["completed", "aborted", "failed"].includes(event.state))) {
      this.#options.usage?.finish(this.#usageTurn, this.#usageObserved ? this.#lastUsage : undefined); this.#usageTurn = undefined;
    }
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
    let owner = operationId === this.#options.runId ? this.#inputOperationId ?? operationId : operationId;
    if (event.type === "tool_start" && event.name === "subagent" && owner) {
      const previous = this.#nativeToolOwners.get(event.callId);
      if (previous !== undefined && previous !== owner) throw new Error("The original native tool owner conflicts.");
      if (this.#nativeToolOwners.size >= 256 && previous === undefined) throw new Error("The original native tool capacity is unavailable.");
      this.#nativeToolOwners.set(event.callId, owner);
      for (const wake of this.#nativeToolOwnerWaiters.get(event.callId) ?? []) wake();
    }
    const backgroundId = event.type === "background_task" ? event.taskId : event.type === "subagent_run" ? event.run.id
      : event.type === "subagent_transcript" ? event.subagentRunId : undefined;
    if (backgroundId !== undefined) owner = this.#backgroundOwners.get(backgroundId)?.operationId ?? owner;
    if (event.type === "subagent_run" && ["completed", "failed", "stopped"].includes(event.run.state)) {
      const scopeId = this.#backgroundOwners.get(event.run.id)?.scope.runId;
      if (scopeId !== undefined && event.run.providerRunIds[0] === scopeId) this.#retireBackgroundTools(scopeId);
    }
    this.exchange.emit(event, metadata, owner);
    if (event.type === "tool_result" && event.name === "subagent") this.#nativeToolOwners.delete(event.callId);
  }
  #retireBackgroundTools(scopeId: string): void {
    for (const [callId, owner] of this.#toolOwners) if (owner.backgroundScope === scopeId) this.#toolOwners.delete(callId);
  }
  async #nativeToolOwner(callId: string, signal: AbortSignal): Promise<string> {
    const current = this.#nativeToolOwners.get(callId);
    if (current !== undefined) return current;
    // The private HTTP registration can arrive before stdout's exact tool_start.
    // Wait for that event; never substitute a later foreground input.
    await new Promise<void>((resolveOwner, rejectOwner) => {
      const waiters = this.#nativeToolOwnerWaiters.get(callId) ?? new Set<() => void>();
      const finish = () => { signal.removeEventListener("abort", aborted); waiters.delete(finish); if (!waiters.size) this.#nativeToolOwnerWaiters.delete(callId); resolveOwner(); };
      const aborted = () => { waiters.delete(finish); if (!waiters.size) this.#nativeToolOwnerWaiters.delete(callId); rejectOwner(new Error("The original native tool owner is unavailable.")); };
      waiters.add(finish); this.#nativeToolOwnerWaiters.set(callId, waiters); signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
    const owner = this.#nativeToolOwners.get(callId);
    if (!owner) throw new Error("The original native tool owner is unavailable.");
    return owner;
  }
  async #registerBackground(scope: PiHostedBackgroundScope, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!scope || typeof scope.taskId !== "string" || !scope.taskId || scope.taskId.length > 256
      || this.#backgroundRegistrations.has(scope.taskId) || this.#backgroundRegistrations.size >= 256) throw new Error("Hosted child registration is already in progress or invalid.");
    this.#backgroundRegistrations.add(scope.taskId);
    try { return await this.#registerBackgroundOnce(scope, AbortSignal.any([signal, AbortSignal.timeout(5_000)])); }
    finally { this.#backgroundRegistrations.delete(scope.taskId); }
  }
  async #registerBackgroundOnce(scope: PiHostedBackgroundScope, signal: AbortSignal): Promise<Record<string, unknown>> {
    this.#assertCurrent();
    if (this.#options.backendId !== "pi" || !this.#nativeHome) throw new Error("Hosted child execution is unavailable.");
    const generation = this.#context!.generation;
    const previous = scope && this.#backgroundOwners.get(scope.taskId);
    if (previous && sameBackgroundScope(previous.scope, scope) && previous.generation === generation) return { registered: true };
    const metadata = await assertManagedSubagentHostedToolScope({ root: managedSubagentRunRoot(this.#nativeHome),
      productSessionId: this.#context!.sessionId, productGeneration: generation, scope, reserved: true });
    this.#assertCurrent(); signal.throwIfAborted();
    const resuming = this.#backgroundResumes.get(scope.taskId);
    if (previous && (!resuming || previous.generation !== generation || previous.scope.nativeSessionId !== scope.nativeSessionId
      || previous.scope.runId === scope.runId)) throw new Error("The original background task cannot be replaced by this runner.");
    if (!previous && this.#backgroundOwners.size >= 65_536) throw new Error("The original background task capacity is unavailable.");
    const operationId = previous?.operationId ?? (metadata.parentTaskId === undefined ? undefined : await this.#nativeToolOwner(metadata.parentTaskId, signal));
    if (!operationId) throw new Error("The original background task owner is unavailable.");
    this.#assertCurrent(); signal.throwIfAborted();
    if (this.#context!.generation !== generation || this.#backgroundOwners.get(scope.taskId) !== previous) throw new Error("The original background task owner changed.");
    const registered = { operationId, scope: { ...scope }, generation };
    this.#backgroundOwners.set(scope.taskId, registered);
    if (previous) this.#retireBackgroundTools(previous.scope.runId);
    // A lost registration reply cannot reassign later failure observations to
    // another input. The native launcher has not spawned yet and records its
    // exact physical manifest as failed; observation owns terminal cleanup.
    const result = await this.exchange.tool({ operation: "background.register", ...metadata, scopeId: scope.runId, originalOperationId: operationId }, signal, resuming ?? operationId);
    if (result.registered !== true) throw new Error("The original background task registration was rejected.");
    return { registered: true };
  }
  async #executeTool(value: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Hosted tool ownership is invalid.");
    const { origin, backgroundScope, ...input } = value as Record<string, unknown>;
    if (origin !== "agent" && origin !== "user_shell" || typeof input.callId !== "string") throw new Error("Hosted tool ownership is invalid.");
    if (input.operation === "background.register") {
      if (origin !== "agent" || backgroundScope !== undefined || input.format !== 1
        || !input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)
        || input.callId !== "background-" + (input.payload as PiHostedBackgroundScope).runId
        || input.requestId !== input.callId + ":1" || Object.keys(input).length !== 5) throw new Error("Hosted child registration is invalid.");
      return this.#registerBackground(input.payload as PiHostedBackgroundScope, signal);
    }
    if (input.operation === "tool.end" && backgroundScope && typeof backgroundScope === "object") {
      const scope = backgroundScope as PiHostedBackgroundScope, owner = this.#toolOwners.get(input.callId), scopeId = scope.runId;
      const current = this.#backgroundOwners.get(scope.taskId);
      if (owner?.origin === origin && owner.backgroundScope === scopeId && current && sameBackgroundScope(current.scope, scope)) {
        try { return await this.exchange.tool({ ...input, backgroundScope: scopeId }, signal, owner.operationId); }
        finally { this.#toolOwners.delete(input.callId); }
      }
    }
    let background: { readonly operationId: string; readonly scope: PiHostedBackgroundScope; readonly generation: number } | undefined;
    if (backgroundScope !== undefined) {
      const scope = backgroundScope as PiHostedBackgroundScope;
      background = scope && this.#backgroundOwners.get(scope.taskId);
      if (origin !== "agent" || !background || background.generation !== this.#context?.generation
        || !sameBackgroundScope(background.scope, scope) || !this.#nativeHome) throw new Error("The native background runner was retired.");
      await assertManagedSubagentHostedToolScope({ root: managedSubagentRunRoot(this.#nativeHome), productSessionId: this.#context!.sessionId,
        productGeneration: background.generation, scope });
      this.#assertCurrent(); signal.throwIfAborted();
      if (this.#backgroundOwners.get(scope.taskId) !== background) throw new Error("The native background runner was retired.");
    }
    if (input.operation === "codex.exec_server") {
      if (origin !== "agent" || background !== undefined) throw new Error("Hosted native execution ownership is invalid.");
      return this.exchange.tool(input, signal, this.#inputOperationId ?? this.#options.runId);
    }
    let owner = this.#toolOwners.get(input.callId);
    if (input.operation === "tool.begin") {
      const operationId = background?.operationId ?? (origin === "user_shell" ? this.#shellOperationId : this.#inputOperationId);
      if (!operationId || owner || this.#toolOwners.size >= 256) throw new Error("Hosted tool has no current native owner.");
      owner = { operationId, origin, ...(background === undefined ? {} : { backgroundScope: background.scope.runId }) }; this.#toolOwners.set(input.callId, owner);
    }
    if (!owner || owner.origin !== origin || owner.backgroundScope !== background?.scope.runId) throw new Error("Hosted tool has no current native owner.");
    try { return await this.exchange.tool({ ...input, ...(background === undefined ? {} : { backgroundScope: background.scope.runId }) }, signal, owner.operationId); }
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
      await this.#adapter?.dispose(); await this.#mcp?.close(); await this.#artifacts?.close(); this.#toolOwners.clear(); this.#backgroundOwners.clear(); this.#nativeToolOwners.clear(); this.#nativeCleaned = true; this.#activeProvider = undefined;
      try { if (this.#claimed && this.#options.store.find(this.id)?.leaseId === this.#leaseId) this.#options.store.close(this.id, this.#leaseId); }
      finally { if (!this.#purgeRequested) this.#slot.release(); }
    })().catch(error => { this.#cleanup = undefined; throw error; });
  }
  async #invokeOnce(id: string, digest: string, command: HostedAgentCall): Promise<unknown> {
    if (command.kind === "idle_release_status") return this.#idleReleaseStatus(command.releaseCallId);
    this.#assertCurrent();
    if (["state", "commands", "resources", "tools", "tree", "history", "dispatch_during_compaction", "background_output"].includes(command.kind)) return this.#invoke(id, command);
    const prior = this.#options.store.call(this.id, id);
    if (prior) {
      if (prior.digest !== digest) throw new Error("Hosted Agent durable call identity conflicts.");
      if (prior.state === "completed") return JSON.parse(prior.resultJson!);
      throw new Error(prior.state === "pending" ? "The prior native outcome is unknown; the operation was not repeated." : "The prior native operation failed and was not repeated.");
    }
    this.#options.store.claimCall(this.id, this.#leaseId, id, digest);
    if (command.kind !== "idle_release") this.#lastActivity = Date.now();
    let result: unknown;
    try { result = await this.#invoke(id, command); }
    catch (error) {
      try { this.#options.store.finishCall(this.id, this.#leaseId, id, digest, { ok: false }); } catch { /* A pending receipt remains outcome-unknown. */ }
      throw error;
    }
    // A commit failure leaves the durable pending receipt intact. Retrying that
    // ID must not repeat a native effect whose response could have been lost.
    this.#options.store.finishCall(this.id, this.#leaseId, id, digest, { ok: true, value: result });
    if (command.kind === "idle_release" && result === true) this.exchange.finish();
    return result;
  }
  async #invoke(id: string, command: HostedAgentCall): Promise<unknown> {
    this.#assertCurrent();
    if (this.#navigating) throw new Error("Native history navigation is in progress.");
    const adapter = this.#adapter!, observation = ["state", "commands", "resources", "tools", "tree", "history", "dispatch_during_compaction", "background_output"].includes(command.kind);
    const context = this.#operationContext(observation ? this.#options.runId : id);
    switch (command.kind) {
      case "derive": return this.#derive(id, command, context);
      case "derivation_lifecycle": throw new Error("Native derivation lifecycle requires the authenticated service owner.");
      case "idle_release": return this.#releaseIdle(id, command.idleMinutes, context);
      case "idle_release_status": return this.#idleReleaseStatus(command.releaseCallId);
      case "state": return adapter.inspectSession(this.#binding!, context);
      case "send":
        if (this.#options.usage && !this.#usageTurn && !this.#activeProvider && command.input.disposition !== "steer") {
          const state = await adapter.inspectSession(this.#binding!, context); this.#assertCurrent();
          if (!state.streaming && !state.compacting && state.pendingMessages === 0) {
            this.#lastUsage = state.usage; this.#usageObserved = false;
            this.#options.usage.begin(id, context.modelSelection!.modelId, state.usage); this.#usageTurn = id;
          }
        }
        if (this.#options.usage && this.#usageTurn !== id && command.input.disposition === "follow_up") {
          if (this.#usageFollowUps.size >= 256) throw new Error("Hosted queued usage attribution capacity is exhausted.");
          this.#usageFollowUps.set(id, context.modelSelection!.modelId);
        }
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
      case "dispatch_during_compaction": return await adapter.dispatchDuringCompaction?.(command.input, context) ?? null;
      case "navigate": return this.#navigate(id, command, context);
      case "shell": {
        if (!adapter.executeUserShell || this.#shellOperationId) throw new Error("Hosted user shell is unavailable.");
        this.#shellOperationId = id;
        try { return await adapter.executeUserShell(command.input, context); }
        finally { if (this.#shellOperationId === id) this.#shellOperationId = undefined; }
      }
      case "abort_shell": if (!adapter.abortUserShell) throw new Error("Hosted user shell is unsupported."); await adapter.abortUserShell(context); return null;
      case "control_subagent": {
        if (!adapter.controlSubagent) throw new Error("Hosted child control is unsupported.");
        if (command.input.action !== "resume") { await adapter.controlSubagent(command.input, context); return null; }
        if (this.#backgroundResumes.has(command.input.runId)) throw new Error("Hosted child resume is already in progress.");
        this.#backgroundResumes.set(command.input.runId, id);
        try { await adapter.controlSubagent(command.input, context); return null; }
        finally { this.#backgroundResumes.delete(command.input.runId); }
      }
      case "cancel_background": if (!adapter.cancelBackgroundTask) throw new Error("Hosted background task cancellation is unsupported."); await adapter.cancelBackgroundTask(context, command.taskId); return null;
      case "background_output": if (!adapter.getBackgroundTaskOutput) throw new Error("Hosted background task output is unsupported."); return adapter.getBackgroundTaskOutput(context, command.taskId, command.maximumBytes);
    }
  }
  async #derive(id: string, command: Extract<HostedAgentCall, { kind: "derive" }>, context: AdapterContext): Promise<{ readonly editorText?: string }> {
    if (command.sessionId === this.#owner.sessionId || command.targetId !== this.#owner.targetId
      || command.nativeSessionId === this.#owner.nativeSessionId || command.derivationKind === "fork" && !command.entryId
      || command.derivationKind === "clone" && command.entryId !== undefined
      || command.completedSnapshot && (command.derivationKind !== "fork" || command.completedSnapshot.nativeBoundaryId !== command.entryId)) throw new Error("The native derivation child authority is invalid.");
    const adapter = this.#adapter!, descriptor = await adapter.describe(); this.#assertCurrent();
    if (descriptor.capabilities.get(command.completedSnapshot ? "session.side_chat" : `session.${command.derivationKind}`)?.supported !== true) {
      throw new Error("The native source does not support this derivation.");
    }
    if (!command.completedSnapshot && this.#idleBusy(id)) throw new Error("The native source is busy and cannot derive its history.");
    const sourceBinding = this.#binding!, owner: HostedNativeSessionOwner = { ...this.#owner, sessionId: command.sessionId,
      targetId: command.targetId, nativeSessionId: command.nativeSessionId };
    const record = this.#options.store.prepareDerivation(this.id, this.#leaseId, owner, { operationId: id, kind: command.derivationKind,
      providerId: context.modelSelection!.providerId, modelId: context.modelSelection!.modelId,
      ...(command.completedSnapshot ? { completedSnapshot: command.completedSnapshot } : {}) });
    const lifecycle: NativeSessionDerivationLifecycle = { operationId: id, kind: command.derivationKind,
      sourceSessionId: context.sessionId, sourceBinding, sessionId: `hosted-session:${record.key}`, sourceTarget: context.target, target: context.target };
    this.#derivations.add(id);
    try {
      const derivation = { sessionId: lifecycle.sessionId, target: context.target,
        ...(command.completedSnapshot ? { completedSnapshot: command.completedSnapshot } : {}),
        recordBinding: (binding: NativeSessionBinding) => { this.#options.store.updateDerivation(record.key, record.leaseId, {}, binding); } };
      const result = command.derivationKind === "fork" ? await adapter.fork(command.entryId!, context, derivation)
        : { binding: await adapter.clone(context, derivation) };
      this.#assertCurrent();
      const recorded = this.#options.store.assertLease(record.key, record.leaseId);
      if (!recorded.binding || recorded.binding.opaqueRef !== result.binding.opaqueRef
        || recorded.binding.nativeSessionId !== result.binding.nativeSessionId
        || recorded.binding.generation !== result.binding.generation) throw new Error("The native derivation did not register its exact child binding.");
      if (await adapter.ownsNativeSessionDerivationLifecycle?.(lifecycle) === true) {
        if (!adapter.adoptNativeSessionDerivation) throw new Error("The native derivation adopter is unavailable.");
        await adapter.adoptNativeSessionDerivation({ ...lifecycle, binding: result.binding }, this.#lifetime.signal); this.#assertCurrent();
      }
      const settled = this.#options.store.updateDerivation(record.key, record.leaseId, { state: "settled", nativeAdopted: true });
      if (settled.derivation!.cleanupRequested) throw new Error("The original native derivation was cancelled before adoption.");
      return "editorText" in result && typeof result.editorText === "string" ? { editorText: result.editorText } : {};
    } catch (error) {
      this.#options.store.updateDerivation(record.key, record.leaseId, { state: "unknown" }); throw error;
    } finally { this.#derivations.delete(id); }
  }
  #observeBackground(event: EventPayload, historical = false): void {
    const id = event.type === "background_task" ? `task:${event.taskId}` : event.type === "subagent_run" ? `child:${event.run.id}` : undefined;
    const state = event.type === "background_task" ? event.state : event.type === "subagent_run" ? event.run.state : undefined;
    if (id === undefined || state === undefined) return;
    if (historical && this.#observedBackground.has(id)) return;
    if (!historical) this.#observedBackground.add(id);
    if (["completed", "failed", "stopped", "cancelled", "aborted"].includes(state)) this.#activeBackground.delete(id);
    else this.#activeBackground.add(id);
  }
  #idleBusy(id: string): boolean {
    return !!this.#activeProvider || !!this.#shellOperationId || this.#navigating || this.#toolOwners.size > 0
      || this.#backgroundRegistrations.size > 0 || this.#backgroundResumes.size > 0 || this.#activeBackground.size > 0
      || this.exchange.pendingRequests > 0 || [...this.#receipts].some(([call, receipt]) => call !== id && !receipt.settled);
  }
  async #releaseIdle(id: string, idleMinutes: number, context: AdapterContext): Promise<boolean> {
    if (!Number.isSafeInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > 120) throw new Error("Native idle release threshold is invalid.");
    if (this.#idleBusy(id)) return false;
    if (this.#adapter!.getNativeHistoryProjection && !this.#persistentReadOnly) {
      const history = await this.#adapter!.getNativeHistoryProjection(context);
      for (const event of history.events) this.#observeBackground(event.payload, true);
      this.#assertCurrent();
    }
    const state = await this.#adapter!.inspectSession(this.#binding!, context); this.#assertCurrent();
    if (state.streaming || state.compacting || state.pendingMessages > 0 || this.#idleBusy(id) || Date.now() - this.#lastActivity < idleMinutes * 60_000) return false;
    // Fence dispatch synchronously before any process cleanup awaits. A lost
    // response is reconciled through this exact release identity, never a new run.
    this.#idleReleaseId = id; this.#ready = false;
    await this.#channel?.close(); await this.#disposeNative(); return true;
  }
  async #idleReleaseStatus(id: string): Promise<"busy" | "released" | "unknown"> {
    this.#options.assertCurrent();
    if (this.#idleReleaseId === id) {
      await this.#channel?.close(); await this.#disposeNative(); this.exchange.finish(); return "released";
    }
    const receipt = this.#options.store.call(this.id, id);
    if (receipt?.state === "completed" && receipt.resultJson === "false") return "busy";
    return "unknown";
  }
  async #navigate(id: string, command: Extract<HostedAgentCall, { kind: "navigate" }>, context: AdapterContext): Promise<null> {
    const adapter = this.#adapter!, sourceBinding = this.#binding!;
    let nativeConfirmed = false;
    this.#navigating = true;
    try {
      if (this.#navigation.read()) throw new Error("The prior native navigation must be reconciled before another navigation.");
      const result = await adapter.navigateTree(command.target, command.summarize, context, command.instructions, {
        recordBinding: binding => this.#navigation.record(id, sourceBinding, binding, command.target)
      });
      nativeConfirmed = true;
      this.#assertCurrent();
      if (result.kind === "replacement") {
        const receipt = this.#navigation.read();
        if (!receipt || receipt.binding.opaqueRef !== result.binding.opaqueRef || receipt.binding.nativeSessionId !== result.binding.nativeSessionId
          || receipt.binding.generation !== result.binding.generation) throw new Error("The native navigation returned an unregistered context.");
        await adapter.closeSession(sourceBinding, context); this.#assertCurrent(); this.#navigation.retire();
        const lifecycle = this.#navigation.lifecycle(context.sessionId, context.target);
        if (await adapter.ownsNativeSessionDerivationLifecycle?.(lifecycle) === true) {
          if (!adapter.adoptNativeSessionDerivation) throw new Error("The native navigation adoption owner is unavailable.");
          await adapter.adoptNativeSessionDerivation(lifecycle, this.#lifetime.signal);
        }
        this.#mcp?.replaceOwnerGeneration(result.binding.generation);
        this.#context = { ...this.#context!, binding: result.binding, generation: result.binding.generation };
        const state = await adapter.resumeSession(result.binding, this.#operationContext(id)); this.#assertAuthority();
        if (state.binding.opaqueRef !== result.binding.opaqueRef || state.binding.nativeSessionId !== result.binding.nativeSessionId
          || state.binding.generation !== result.binding.generation || state.streaming) throw new Error("The native navigation replacement was not confirmed.");
        this.#binding = state.binding; this.#context = { ...this.#context, binding: state.binding };
        this.#navigation.complete(state.binding);
      } else if (this.#navigation.read()) throw new Error("An in-place native navigation registered a replacement.");
      if (!adapter.getNativeHistoryProjection) throw new Error("The native navigation has no history confirmation.");
      await adapter.getNativeHistoryProjection(this.#operationContext(id)); this.#assertCurrent();
      return null;
    } catch (error) {
      // A recorded child or unknown SDK mutation cannot accept another input.
      // Restart reconciles only the exact recorded adoption or cleanup.
      if (nativeConfirmed || this.#navigation.read() || !(error instanceof JokoError) || error.publicError.stateMayHaveChanged) this.#ready = false;
      throw error;
    } finally { this.#navigating = false; }
  }
}

/** Only a confirmed closed process or its in-memory owner may call this.
 * The persistent purge fence prevents a resume from replacing this lease
 * while filesystem deletion awaits the operating system. */
export async function purgeHostedAgentStorage(options: { readonly root: string; readonly store: HostedAgentStore; readonly key: string; readonly leaseId: string }): Promise<void> {
  if (!isAbsolute(options.root) || resolve(options.root) !== options.root || !/^[a-f0-9]{64}$/u.test(options.key)) throw new Error("Hosted Agent cleanup path is invalid.");
  const record = options.store.assertLease(options.key, options.leaseId), storageKey = record.storageKey ?? record.key;
  const references = options.store.list().filter(row => row.key !== record.key && (row.storageKey ?? row.key) === storageKey && row.derivation?.state !== "cleaned");
  const targetKey = record.key === storageKey && references.length ? undefined : record.key;
  const target = resolve(options.root, targetKey ?? options.key);
  if (target !== join(options.root, options.key) || target === options.root || await realpath(options.root) !== options.root) throw new Error("Hosted Agent cleanup path is unsafe.");
  options.store.beginPurge(options.key, options.leaseId);
  try {
    const info = targetKey === undefined ? undefined : await lstat(target);
    if (info === undefined) { options.store.finishPurge(options.key, options.leaseId); return; }
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(target) !== target) throw new Error("Hosted Agent cleanup directory is unsafe.");
    options.store.assertLease(options.key, options.leaseId);
    await rm(target, { recursive: true, force: false });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (storageKey !== record.key && references.length === 0) {
    const lineage = resolve(options.root, storageKey);
    try {
      const info = await lstat(lineage);
      if (lineage !== join(options.root, storageKey) || !info.isDirectory() || info.isSymbolicLink() || await realpath(lineage) !== lineage) throw new Error("Hosted native lineage cleanup is unsafe.");
      options.store.assertLease(options.key, options.leaseId); await rm(lineage, { recursive: true, force: false });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  options.store.finishPurge(options.key, options.leaseId);
}
