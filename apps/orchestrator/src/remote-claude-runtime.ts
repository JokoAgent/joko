import { createHash, randomUUID } from "node:crypto";
import { posix as remotePath } from "node:path";
import { TextDecoder } from "node:util";

import {
  CLAUDE_AGENT_SDK_VERSION,
  type ClaudeCanUseToolOptions,
  type ClaudePermissionResult,
  type ClaudeRemoteRuntimePort,
  type ClaudeSdkAccountInfo,
  type ClaudeSdkForkOptions,
  type ClaudeSdkGetSessionMessagesOptions,
  type ClaudeSdkHookEvent,
  type ClaudeSdkHookInput,
  type ClaudeSdkHookOutput,
  type ClaudeSdkInitializationResult,
  type ClaudeSdkListSessionsOptions,
  type ClaudeSdkManagedAgentInput,
  type ClaudeSdkModelInfo,
  type ClaudeSdkPermissionMode,
  type ClaudeSdkProbe,
  type ClaudeSdkProbeInput,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryOptions,
  type ClaudeSdkQueryParams,
  type ClaudeSdkRuntime,
  type ClaudeSdkSessionInfo,
  type ClaudeSdkSessionMessage,
  type ClaudeSdkUserMessage,
  type ClaudeTargetRuntime
} from "@joko/adapter-claude-code";
import type { TargetDescriptor } from "@joko/core";
import type {
  RemoteProcessHandle,
  RemoteProcessTransportPort,
  RemoteReverseForwardHandle,
  RemoteSshTransportLease
} from "@joko/remote-ssh";
import type { OperationalStore, RemoteHostRecord, StoredTarget } from "@joko/store";
import {
  REMOTE_CLAUDE_EXPECTED_VERSION,
  REMOTE_CLAUDE_MANAGER_VERSION,
  REMOTE_CLAUDE_PROTOCOL_VERSION,
  probeRemoteClaudeInstallation,
  type RemoteClaudeInstallationProbe
} from "./remote-claude-installation.js";
import type { RemoteHostRegistry } from "./remote-host-registry.js";

const MAXIMUM_LINE_BYTES = 32 * 1024 * 1024;
const MAXIMUM_BUFFER_BYTES = MAXIMUM_LINE_BYTES + 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const SESSION_OPERATION_TIMEOUT_MS = 60_000;
const CHANNEL_CLOSE_TIMEOUT_MS = 2_000;
const RECONNECT_DELAYS_MS = [0, 100, 250, 500] as const;
const MAXIMUM_QUEUED_EVENTS = 4_096;
const MAXIMUM_QUEUED_EVENT_BYTES = 32 * 1024 * 1024;
const MAXIMUM_CALLBACKS_PER_QUERY = 256;
const MAXIMUM_HOOK_PAYLOAD_BYTES = 1024 * 1024;
const MAXIMUM_MANAGED_AGENT_RESULT_BYTES = 64 * 1024;
const REMOTE_HOOK_EVENTS = ["PreToolUse", "PermissionDenied", "PostToolUse", "PostToolUseFailure"] as const satisfies readonly ClaudeSdkHookEvent[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type ProcessAuthority = Awaited<ReturnType<RemoteHostRegistry["captureProcessAuthority"]>>;

interface ResolverEntry {
  readonly targetId: string;
  readonly targetRevision: bigint;
  readonly targetSignature: string;
  readonly authority: ProcessAuthority;
  readonly runtime: RemoteClaudeSdkRuntime;
  readonly binding: ClaudeTargetRuntime;
}

export interface RemoteClaudeRuntimeResolverOptions {
  readonly store: Pick<OperationalStore, "getTarget">;
  readonly registry: Pick<RemoteHostRegistry, "captureProcessAuthority">;
}

/** Target-, Host-, SSH-, installation-, and manager-generation-bound Claude runtime owner. */
export class RemoteClaudeRuntimeResolver implements ClaudeRemoteRuntimePort {
  readonly #store: Pick<OperationalStore, "getTarget">;
  readonly #registry: Pick<RemoteHostRegistry, "captureProcessAuthority">;
  readonly #entries = new Map<string, ResolverEntry>();
  readonly #flights = new Map<string, Promise<ClaudeTargetRuntime>>();
  #closing = false;
  #closed = false;

  constructor(options: RemoteClaudeRuntimeResolverOptions) {
    this.#store = options.store;
    this.#registry = options.registry;
  }

  async resolve(target: TargetDescriptor, signal?: AbortSignal): Promise<ClaudeTargetRuntime> {
    this.#assertOpen();
    if (signal?.aborted) throw runtimeFault("cancelled", false);
    const stored = this.#storedTarget(target);
    const signature = targetSignature(target);
    const existing = this.#entries.get(target.id);
    if (existing !== undefined
      && existing.targetRevision === stored.revision
      && existing.targetSignature === signature) {
      try {
        existing.binding.assertCurrent();
        return existing.binding;
      } catch {
        await this.#retire(existing);
      }
    } else if (existing !== undefined) {
      await this.#retire(existing);
    }
    const active = this.#flights.get(target.id);
    if (active !== undefined) return active;
    const flight = this.#resolveFresh(target, stored, signature, signal);
    this.#flights.set(target.id, flight);
    try { return await flight; }
    finally { if (this.#flights.get(target.id) === flight) this.#flights.delete(target.id); }
  }

  async close(): Promise<void> {
    if (this.#closed || this.#closing) return;
    this.#closing = true;
    let failure: unknown;
    try {
      await Promise.allSettled([...this.#flights.values()]);
      const results = await Promise.allSettled([...this.#entries.values()].map(async (entry) => this.#retire(entry)));
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (rejected.length === 1) failure = rejected[0]!.reason;
      else if (rejected.length > 1) failure = new AggregateError(rejected.map((result) => result.reason), "Remote Claude runtimes could not all retire.");
    } finally {
      this.#closed = true;
      this.#closing = false;
    }
    if (failure !== undefined) throw failure;
  }

  async #resolveFresh(
    target: TargetDescriptor,
    stored: StoredTarget,
    signature: string,
    signal?: AbortSignal
  ): Promise<ClaudeTargetRuntime> {
    const remote = requireRemoteBinding(target);
    const authority = await this.#registry.captureProcessAuthority(target.id, remote.hostId, signal);
    const processes = requireProcesses(authority.lease);
    authority.assertCurrent();
    const installation = await probeRemoteClaudeInstallation(processes, remote.workspaceRoot, authority.assertCurrent, signal);
    authority.assertCurrent();
    if (installation.state !== "ready") throw runtimeFault("runtime_unavailable", false);
    if (installation.workspaceRoot !== remote.workspaceRoot) throw runtimeFault("workspace_alias", false);
    const ownerKey = createHash("sha256").update(JSON.stringify({
      kind: "joko-remote-claude-owner-v1",
      ownerId: authority.host.ownerId,
      targetId: target.id,
      host: executionHostIdentity(authority.host),
      runtimeRoot: installation.runtimeRoot
    }), "utf8").digest("hex");
    const ownerGeneration = `${stored.revision}:${authority.hostRevision}:${authority.leaseGeneration}:${randomUUID()}`;
    let entry!: ResolverEntry;
    let runtime: RemoteClaudeSdkRuntime | undefined;
    const assertAuthorityCurrent = (): void => {
      if (this.#closed) throw runtimeFault("authority_changed", false);
      const current = this.#store.getTarget(target.id);
      if (current.revision !== stored.revision
        || targetSignature(current.descriptor) !== signature
        || this.#entries.get(target.id) !== entry) throw runtimeFault("authority_changed", false);
      authority.assertCurrent();
    };
    const assertCurrent = (): void => {
      if (this.#closed || this.#closing) throw runtimeFault("authority_changed", false);
      assertAuthorityCurrent();
      runtime?.assertManagerGenerationCurrent();
    };
    runtime = new RemoteClaudeSdkRuntime({
      processes,
      lease: authority.lease,
      installation,
      ownerKey,
      ownerGeneration,
      assertCurrent,
      assertAuthorityCurrent,
      assertForwardingCurrent: authority.assertForwardingCurrent
    });
    const binding: ClaudeTargetRuntime = Object.freeze({
      runtime,
      workspaceRoot: installation.workspaceRoot,
      remote: true,
      assertCurrent
    });
    entry = Object.freeze({
      targetId: target.id,
      targetRevision: stored.revision,
      targetSignature: signature,
      authority,
      runtime,
      binding
    });
    this.#assertOpen();
    authority.assertCurrent();
    this.#entries.set(target.id, entry);
    try {
      binding.assertCurrent();
      await runtime.initialize(signal);
      binding.assertCurrent();
      return binding;
    } catch (error) {
      await this.#retire(entry).catch(() => undefined);
      throw error;
    }
  }

  async #retire(entry: ResolverEntry): Promise<void> {
    try { await entry.runtime.shutdown(); }
    finally { if (this.#entries.get(entry.targetId) === entry) this.#entries.delete(entry.targetId); }
  }

  #storedTarget(target: TargetDescriptor): StoredTarget {
    const stored = this.#store.getTarget(target.id);
    if (targetSignature(stored.descriptor) !== targetSignature(target)) throw runtimeFault("target_stale", false);
    requireRemoteBinding(stored.descriptor);
    return stored;
  }

  #assertOpen(): void {
    if (this.#closed || this.#closing) throw runtimeFault("resolver_closed", false);
  }
}

interface RemoteClaudeSdkRuntimeOptions {
  readonly processes: RemoteProcessTransportPort;
  readonly lease: RemoteSshTransportLease;
  readonly installation: RemoteClaudeInstallationProbe;
  readonly ownerKey: string;
  readonly ownerGeneration: string;
  readonly assertCurrent: () => void;
  readonly assertAuthorityCurrent: () => void;
  readonly assertForwardingCurrent: () => void;
}

class RemoteClaudeSdkRuntime implements ClaudeSdkRuntime {
  readonly packageVersion = CLAUDE_AGENT_SDK_VERSION;
  readonly supportsWorkspaceDerivation = false;
  readonly #options: RemoteClaudeSdkRuntimeOptions;
  readonly #queries = new Map<ClaudeSdkQuery, RemoteClaudeQuery>();
  readonly #ownedQueries = new WeakSet<ClaudeSdkQuery>();
  readonly #sessionOperations = new Set<Promise<unknown>>();
  readonly #forks = new Set<string>();
  #managerGeneration: string | undefined;
  #managerGenerationCurrent = true;
  #closed = false;

  constructor(options: RemoteClaudeSdkRuntimeOptions) {
    this.#options = options;
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    await this.#requestOnce("owner.reconcile", {
      ownerKey: this.#options.ownerKey,
      ownerGeneration: this.#options.ownerGeneration,
      timeoutMs: SESSION_OPERATION_TIMEOUT_MS
    }, signal, SESSION_OPERATION_TIMEOUT_MS);
  }

  assertManagerGenerationCurrent(): void {
    if (!this.#managerGenerationCurrent) throw runtimeFault("manager_generation_changed", true);
  }

  async probe(_input: ClaudeSdkProbeInput): Promise<ClaudeSdkProbe> {
    try {
      await this.#requestOnce("hello", {}, undefined, REQUEST_TIMEOUT_MS);
      return { installed: true, packageVersion: this.packageVersion };
    } catch {
      return { installed: false, packageVersion: this.packageVersion, diagnostic: "The fixed remote Claude runtime is unavailable." };
    }
  }

  async query(params: ClaudeSdkQueryParams): Promise<ClaudeSdkQuery> {
    this.#assertOpen();
    this.#options.assertCurrent();
    let forward: RemoteReverseForwardHandle | undefined;
    let forwardedParams = params;
    try {
      const prepared = await this.#prepareProviderForward(params);
      forward = prepared.forward;
      forwardedParams = prepared.params;
      const query = await RemoteClaudeQuery.open({
        ...this.#channelOptions(),
        ownerKey: this.#options.ownerKey,
        ownerGeneration: this.#options.ownerGeneration,
        params: forwardedParams,
        assertAuthorityCurrent: this.#options.assertAuthorityCurrent,
        ...(forward === undefined ? {} : { forward }),
        onRetired: (query) => this.#queries.delete(query)
      });
      this.#queries.set(query, query);
      this.#ownedQueries.add(query);
      return query;
    } catch (error) {
      await forward?.close().catch(() => undefined);
      throw error;
    }
  }

  async retireQuery(query: ClaudeSdkQuery, timeoutMs: number): Promise<void> {
    if (!this.#ownedQueries.has(query) || !(query instanceof RemoteClaudeQuery)) {
      throw runtimeFault("query_not_owned", true);
    }
    await query.retire(timeoutMs);
  }

  async getSessionInfo(
    sessionId: string,
    options: { readonly dir: string; readonly signal?: AbortSignal }
  ): Promise<ClaudeSdkSessionInfo | undefined> {
    this.#assertDirectory(options.dir);
    const value = await this.#sessionOperation("session.info", { sessionId, dir: options.dir }, options.signal);
    return value === undefined || value === null ? undefined : sessionInfo(value);
  }

  async getSessionMessages(
    sessionId: string,
    options: ClaudeSdkGetSessionMessagesOptions
  ): Promise<readonly ClaudeSdkSessionMessage[]> {
    this.#assertDirectory(options.dir);
    const value = await this.#sessionOperation("session.messages", {
      sessionId,
      dir: options.dir,
      limit: options.limit,
      offset: options.offset,
      includeSystemMessages: options.includeSystemMessages
    }, options.signal);
    if (!Array.isArray(value) || value.length > options.limit) throw runtimeFault("invalid_response", false);
    return value.map(sessionMessage);
  }

  async listSessions(options: ClaudeSdkListSessionsOptions): Promise<readonly ClaudeSdkSessionInfo[]> {
    this.#assertDirectory(options.dir);
    const value = await this.#sessionOperation("session.list", {
      dir: options.dir,
      limit: options.limit,
      offset: options.offset,
      includeWorktrees: false,
      includeProgrammatic: true
    });
    if (!Array.isArray(value) || value.length > options.limit) throw runtimeFault("invalid_response", false);
    return value.map(sessionInfo);
  }

  async deleteSession(
    sessionId: string,
    options: { readonly dir: string; readonly signal?: AbortSignal }
  ): Promise<void> {
    this.#assertDirectory(options.dir);
    await this.#sessionOperation("session.delete", { sessionId, dir: options.dir }, options.signal);
  }

  async forkSession(sessionId: string, options: ClaudeSdkForkOptions): Promise<{ readonly sessionId: string }> {
    this.#assertDirectory(options.dir);
    this.#forks.add(sessionId);
    try {
      const value = await this.#sessionOperation("session.fork", {
        sessionId,
        dir: options.dir,
        ...(options.upToMessageId === undefined ? {} : { upToMessageId: options.upToMessageId })
      }, options.signal);
      if (!isRecord(value) || typeof value.sessionId !== "string" || !UUID.test(value.sessionId)) {
        throw runtimeFault("invalid_response", true);
      }
      const derived = value.sessionId.toLowerCase();
      options.recordSessionId(derived);
      return { sessionId: derived };
    } finally {
      this.#forks.delete(sessionId);
    }
  }

  ownsSessionFork(sessionId: string): boolean {
    return this.#forks.has(sessionId);
  }

  async closeSessionOperations(): Promise<void> {
    await Promise.allSettled([...this.#sessionOperations]);
  }

  async retireOwnedProcesses(timeoutMs: number): Promise<void> {
    const results = await Promise.allSettled([...this.#queries.values()].map(async (query) => query.retire(timeoutMs)));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    let failure: unknown;
    try {
      await this.retireOwnedProcesses(5_000);
      await this.closeSessionOperations();
    } catch (error) {
      failure = error;
    }
    this.#closed = true;
    if (failure !== undefined) throw failure;
  }

  async #sessionOperation(method: string, params: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    const operation = this.#requestOnce(method, params, signal, SESSION_OPERATION_TIMEOUT_MS);
    this.#sessionOperations.add(operation);
    try { return await operation; }
    finally { this.#sessionOperations.delete(operation); }
  }

  async #requestOnce(
    method: string,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    timeoutMs: number
  ): Promise<unknown> {
    this.#assertOpen();
    signal?.throwIfAborted();
    const channel = await RemoteClaudeManagerChannel.open(this.#channelOptions(), signal);
    try {
      const value = await channel.request(method, params, { timeoutMs, signal });
      this.#options.assertCurrent();
      return value;
    } finally {
      await channel.close().catch(() => undefined);
    }
  }

  async #prepareProviderForward(params: ClaudeSdkQueryParams): Promise<{
    readonly params: ClaudeSdkQueryParams;
    readonly forward?: RemoteReverseForwardHandle;
  }> {
    const raw = params.options.env["ANTHROPIC_BASE_URL"];
    if (raw === undefined) return { params };
    let url: URL;
    try { url = new URL(raw); }
    catch { throw runtimeFault("provider_route_invalid", false); }
    if (!["127.0.0.1", "::1", "localhost"].includes(url.hostname)) return { params };
    const forwarding = this.#options.lease.forwarding;
    if (this.#options.lease.capabilities.tcpForwarding !== true || forwarding === undefined) {
      throw runtimeFault("provider_forwarding_unavailable", false);
    }
    const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw runtimeFault("provider_route_invalid", false);
    this.#options.assertForwardingCurrent();
    const forward = await forwarding.listen({
      localDestinationHost: url.hostname as "127.0.0.1" | "::1" | "localhost",
      localDestinationPort: port,
      remoteListenHost: "127.0.0.1",
      signal: params.options.abortController.signal
    });
    try {
      this.#options.assertForwardingCurrent();
      const remoteUrl = new URL(url.toString());
      remoteUrl.hostname = forward.remoteHost;
      remoteUrl.port = String(forward.remotePort);
      return {
        params: {
          ...params,
          options: {
            ...params.options,
            env: { ...params.options.env, ANTHROPIC_BASE_URL: remoteUrl.toString().replace(/\/$/u, url.pathname === "/" ? "" : "/") }
          }
        },
        forward
      };
    } catch (error) {
      await forward.close().catch(() => undefined);
      throw error;
    }
  }

  #channelOptions(): RemoteClaudeManagerChannelOptions {
    return {
      processes: this.#options.processes,
      installation: this.#options.installation,
      assertCurrent: this.#options.assertCurrent,
      acceptManagerGeneration: (generation) => {
        if (this.#managerGeneration === undefined) {
          this.#managerGeneration = generation;
          return;
        }
        if (this.#managerGeneration !== generation) {
          this.#managerGenerationCurrent = false;
          throw runtimeFault("manager_generation_changed", true);
        }
      }
    };
  }

  #assertDirectory(dir: string): void {
    this.#options.assertCurrent();
    if (dir !== this.#options.installation.workspaceRoot) throw runtimeFault("workspace_mismatch", false);
  }

  #assertOpen(): void {
    if (this.#closed) throw runtimeFault("runtime_closed", false);
    this.assertManagerGenerationCurrent();
    this.#options.assertCurrent();
  }
}

interface RemoteClaudeQueryOpenOptions extends RemoteClaudeManagerChannelOptions {
  readonly ownerKey: string;
  readonly ownerGeneration: string;
  readonly params: ClaudeSdkQueryParams;
  readonly assertAuthorityCurrent: () => void;
  readonly forward?: RemoteReverseForwardHandle;
  readonly onRetired: (query: RemoteClaudeQuery) => void;
}

class RemoteClaudeQuery implements ClaudeSdkQuery {
  readonly #options: RemoteClaudeQueryOpenOptions;
  readonly #queryId = randomUUID();
  readonly #sessionId: string;
  readonly #output = new AsyncValueQueue<unknown>();
  readonly #callbackControllers = new Map<string, AbortController>();
  readonly #hookCallbackIds = new Set<string>();
  #channel: RemoteClaudeManagerChannel | undefined;
  #attachmentId: string | undefined;
  #lastSeq = 0;
  #reconnectFlight: Promise<RemoteClaudeManagerChannel> | undefined;
  #inputPump: Promise<void> | undefined;
  #retirement: Promise<void> | undefined;
  #closing = false;
  #ended = false;

  private constructor(options: RemoteClaudeQueryOpenOptions) {
    this.#options = options;
    const sessionId = options.params.options.resume ?? options.params.options.sessionId;
    if (sessionId === undefined || !UUID.test(sessionId)) throw runtimeFault("session_invalid", false);
    this.#sessionId = sessionId.toLowerCase();
  }

  static async open(options: RemoteClaudeQueryOpenOptions): Promise<RemoteClaudeQuery> {
    const query = new RemoteClaudeQuery(options);
    await query.#start();
    return query;
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.#output[Symbol.asyncIterator]();
  }

  interrupt(): Promise<{ readonly still_queued?: readonly string[] } | undefined> {
    return this.#control("query.interrupt", {}) as Promise<{ readonly still_queued?: readonly string[] } | undefined>;
  }

  async stopTask(taskId: string): Promise<void> {
    await this.#control("query.stopTask", { taskId });
  }

  async setPermissionMode(mode: ClaudeSdkPermissionMode): Promise<void> {
    await this.#control("query.setPermissionMode", { mode });
  }

  async setModel(model?: string): Promise<void> {
    await this.#control("query.setModel", { ...(model === undefined ? {} : { model }) });
  }

  async applyFlagSettings(settings: {
    readonly effortLevel?: "low" | "medium" | "high" | "xhigh" | "max" | null;
    readonly fastMode?: boolean | null;
    readonly autoCompactWindow?: number | null;
    readonly permissions?: { readonly additionalDirectories?: readonly string[] } | null;
  }): Promise<void> {
    await this.#control("query.applyFlagSettings", { settings });
  }

  initializationResult(): Promise<ClaudeSdkInitializationResult> {
    return this.#control("query.initializationResult", {}) as Promise<ClaudeSdkInitializationResult>;
  }

  supportedModels(): Promise<readonly ClaudeSdkModelInfo[]> {
    return this.#control("query.supportedModels", {}) as Promise<readonly ClaudeSdkModelInfo[]>;
  }

  accountInfo(): Promise<ClaudeSdkAccountInfo> {
    return this.#control("query.accountInfo", {}) as Promise<ClaudeSdkAccountInfo>;
  }

  close(): void {
    if (this.#closing) return;
    this.#closing = true;
    this.#cancelCallbacks();
    void this.retire(5_000).catch((error) => this.#output.fail(error));
  }

  retire(timeoutMs: number): Promise<void> {
    this.#closing = true;
    if (this.#retirement === undefined) {
      const attempt = this.#retire(timeoutMs);
      this.#retirement = attempt;
      void attempt.catch(() => {
        if (this.#retirement === attempt) this.#retirement = undefined;
      });
    }
    return this.#retirement;
  }

  async #start(): Promise<void> {
    const params = {
      requestId: this.#queryId,
      queryId: this.#queryId,
      sessionId: this.#sessionId,
      ownerKey: this.#options.ownerKey,
      ownerGeneration: this.#options.ownerGeneration,
      afterSeq: 0,
      options: serializeQueryOptions(this.#options.params.options)
    };
    let previous: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let channel: RemoteClaudeManagerChannel | undefined;
      try {
        channel = await this.#openChannel();
        const value = await channel.request("query.start", params, {
          id: this.#queryId,
          timeoutMs: REQUEST_TIMEOUT_MS
        });
        this.#acceptAttachment(value);
        this.#channel = channel;
        previous = undefined;
        break;
      } catch (error) {
        previous = error;
        if (channel !== undefined) {
          await this.#detachChannel(channel);
        }
        if (error instanceof RemoteClaudeManagerFault && error.stateMayHaveChanged && !error.transport) {
          try { await this.#retireOwnedDirect(5_000); }
          catch (cleanupError) { throw cleanupError; }
        }
        if (!(error instanceof RemoteClaudeManagerFault) || !error.transport) throw error;
      }
    }
    if (previous !== undefined) {
      await this.#retireOwnedDirect(5_000).catch(() => undefined);
      throw previous;
    }
    this.#inputPump = this.#pumpInput();
    void this.#inputPump.catch((error) => {
      if (!this.#closing && !this.#ended) this.#output.fail(error);
    });
    this.#options.params.options.abortController.signal.addEventListener("abort", () => this.close(), { once: true });
  }

  async #pumpInput(): Promise<void> {
    for await (const message of this.#options.params.prompt) {
      if (this.#closing || this.#ended) return;
      await this.#sendInput(message);
    }
  }

  async #sendInput(message: ClaudeSdkUserMessage): Promise<void> {
    let previous: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const channel = await this.#ensureChannel();
      const attachmentId = this.#requireAttachment();
      try {
        await channel.request("query.input", {
          queryId: this.#queryId,
          attachmentId,
          requestId: message.uuid,
          message
        }, { id: message.uuid, timeoutMs: REQUEST_TIMEOUT_MS });
        return;
      } catch (error) {
        previous = error;
        if (!(error instanceof RemoteClaudeManagerFault) || !error.transport) throw error;
        await this.#detachChannel(channel);
      }
    }
    throw previous ?? runtimeFault("input_unknown", true);
  }

  async #control(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.#ended || this.#closing) throw runtimeFault("query_closed", false);
    const channel = await this.#ensureChannel();
    return await channel.request(method, {
      queryId: this.#queryId,
      attachmentId: this.#requireAttachment(),
      ...params
    }, { timeoutMs: REQUEST_TIMEOUT_MS });
  }

  async #retire(timeoutMs: number): Promise<void> {
    let previous: unknown;
    let bridgeRetirementUnknown = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const channel = await this.#ensureChannel(true);
        await channel.request("query.retire", {
          queryId: this.#queryId,
          attachmentId: this.#requireAttachment(),
          ownerKey: this.#options.ownerKey,
          ownerGeneration: this.#options.ownerGeneration,
          timeoutMs
        }, { id: `retire:${this.#queryId}`, timeoutMs: timeoutMs + CHANNEL_CLOSE_TIMEOUT_MS });
        await this.#options.forward?.close();
        await channel.close();
        this.#channel = undefined;
        this.#ended = true;
        this.#output.close();
        this.#options.onRetired(this);
        return;
      } catch (error) {
        previous = error;
        const channel = this.#channel;
        if (channel !== undefined) {
          try { await this.#detachChannel(channel); }
          catch (cleanupError) {
            previous = cleanupError;
            bridgeRetirementUnknown = true;
            break;
          }
        }
        if (!(error instanceof RemoteClaudeManagerFault) || !error.transport) break;
      }
    }
    if (!bridgeRetirementUnknown) {
      try {
        await this.#retireOwnedDirect(timeoutMs);
        await this.#options.forward?.close();
        this.#ended = true;
        this.#output.close();
        this.#options.onRetired(this);
        return;
      } catch (error) {
        previous = error;
      }
    }
    await this.#options.forward?.close().catch(() => undefined);
    throw previous ?? runtimeFault("retirement_unconfirmed", true);
  }

  async #retireOwnedDirect(timeoutMs: number): Promise<void> {
    const channel = await RemoteClaudeManagerChannel.open({
      processes: this.#options.processes,
      installation: this.#options.installation,
      assertCurrent: this.#options.assertAuthorityCurrent,
      acceptManagerGeneration: () => undefined
    });
    try {
      await channel.request("query.retireOwned", {
        queryId: this.#queryId,
        ownerKey: this.#options.ownerKey,
        ownerGeneration: this.#options.ownerGeneration,
        timeoutMs
      }, { id: `retire-owned:${this.#queryId}`, timeoutMs: timeoutMs + CHANNEL_CLOSE_TIMEOUT_MS });
    } finally {
      await channel.close();
    }
  }

  async #ensureChannel(forRetirement = false): Promise<RemoteClaudeManagerChannel> {
    if (this.#channel?.active) return this.#channel;
    if (this.#ended && !forRetirement) throw runtimeFault("query_closed", false);
    this.#reconnectFlight ??= this.#reconnect();
    try { return await this.#reconnectFlight; }
    finally { this.#reconnectFlight = undefined; }
  }

  async #reconnect(): Promise<RemoteClaudeManagerChannel> {
    let previous: unknown;
    for (const delayMs of RECONNECT_DELAYS_MS) {
      if (delayMs > 0) await delay(delayMs);
      let channel: RemoteClaudeManagerChannel | undefined;
      try {
        channel = await this.#openChannel();
        const value = await channel.request("query.attach", {
          queryId: this.#queryId,
          ownerKey: this.#options.ownerKey,
          ownerGeneration: this.#options.ownerGeneration,
          afterSeq: this.#lastSeq
        }, { timeoutMs: REQUEST_TIMEOUT_MS });
        this.#acceptAttachment(value);
        this.#channel = channel;
        return channel;
      } catch (error) {
        previous = error;
        if (channel !== undefined) {
          try { await channel.close(); }
          catch (cleanupError) { previous = cleanupError; break; }
        }
        if (!(error instanceof RemoteClaudeManagerFault) || !error.transport) break;
      }
    }
    const error = previous instanceof Error ? previous : runtimeFault("reconnect_failed", true);
    this.#ended = true;
    this.#output.fail(error);
    throw error;
  }

  async #openChannel(): Promise<RemoteClaudeManagerChannel> {
    let channel!: RemoteClaudeManagerChannel;
    channel = await RemoteClaudeManagerChannel.open({
      ...this.#options,
      onEvent: (frame) => this.#acceptEvent(frame),
      onCallback: (frame) => this.#handleCallback(channel, frame),
      onCallbackCancel: (callbackId) => this.#cancelCallback(callbackId),
      onClosed: (error) => {
        if (this.#channel !== channel) return;
        void channel.close().then(() => {
          if (this.#channel === channel) this.#channel = undefined;
          if (!this.#closing && !this.#ended) void this.#ensureChannel().catch(() => undefined);
        }).catch((cleanupError) => {
          this.#ended = true;
          this.#output.fail(cleanupError instanceof Error ? cleanupError : error);
        });
      }
    });
    return channel;
  }

  async #detachChannel(channel: RemoteClaudeManagerChannel): Promise<void> {
    await channel.close();
    if (this.#channel === channel) this.#channel = undefined;
  }

  #acceptAttachment(value: unknown): void {
    if (!isRecord(value) || value.queryId !== this.#queryId || value.sessionId !== this.#sessionId
      || typeof value.attachmentId !== "string" || !UUID.test(value.attachmentId)) {
      throw runtimeFault("invalid_response", true);
    }
    this.#attachmentId = value.attachmentId;
  }

  #acceptEvent(frame: Readonly<Record<string, unknown>>): void {
    if (frame.queryId !== this.#queryId || !Number.isSafeInteger(frame.seq) || (frame.seq as number) < 1) {
      return this.#failProtocol();
    }
    const sequence = frame.seq as number;
    if (sequence <= this.#lastSeq) return;
    if (sequence !== this.#lastSeq + 1) return this.#failProtocol();
    this.#lastSeq = sequence;
    if (frame.event === "message") {
      if (!this.#output.push(frame.value)) this.#failProtocol();
    }
    else if (frame.event === "end" || frame.event === "retired") {
      this.#ended = true;
      this.#cancelCallbacks();
      this.#output.close();
    } else if (frame.event === "fault") {
      this.#ended = true;
      this.#cancelCallbacks();
      this.#output.fail(runtimeFault("remote_query_failed", frame.stateMayHaveChanged === true));
    } else this.#failProtocol();
  }

  async #handleCallback(channel: RemoteClaudeManagerChannel, frame: Readonly<Record<string, unknown>>): Promise<void> {
    if (frame.queryId !== this.#queryId || typeof frame.callbackId !== "string" || !UUID.test(frame.callbackId)) {
      await channel.sendCallback(String(frame.callbackId ?? "invalid"), false);
      return;
    }
    const callbackId = frame.callbackId;
    if (this.#callbackControllers.has(callbackId) || this.#callbackControllers.size >= MAXIMUM_CALLBACKS_PER_QUERY) {
      await channel.sendCallback(callbackId, false);
      return;
    }
    const controller = new AbortController();
    this.#callbackControllers.set(callbackId, controller);
    if (frame.callback === "hook") this.#hookCallbackIds.add(callbackId);
    try {
      if (frame.callback === "canUseTool") {
        const value = callbackRequest(frame.value);
        const result = await this.#options.params.options.canUseTool(value.toolName, value.input, {
          ...value.options,
          signal: controller.signal
        });
        await channel.sendCallback(callbackId, true, result);
      } else if (frame.callback === "oauth" && this.#options.params.options.getOAuthToken !== undefined) {
        let declined = false;
        const value = await this.#options.params.options.getOAuthToken({
          signal: controller.signal,
          onDecline: () => { declined = true; }
        });
        await channel.sendCallback(callbackId, true, { value, declined });
      } else if (frame.callback === "hook") {
        const request = hookCallbackRequest(frame.value, this.#options.params.options);
        const result = await request.callback(request.input, request.toolUseId, { signal: controller.signal });
        if (!isRecord(result) || encodedBytes(result) > MAXIMUM_HOOK_PAYLOAD_BYTES) {
          throw runtimeFault("callback_invalid", false);
        }
        await channel.sendCallback(callbackId, true, result);
      } else if (frame.callback === "managedAgentTool"
        && this.#options.params.options.managedAgentTool !== undefined) {
        const request = managedAgentCallbackRequest(frame.value);
        const result = await this.#options.params.options.managedAgentTool(request.input, {
          toolUseId: request.toolUseId,
          signal: controller.signal
        });
        if (!isRecord(result) || typeof result["text"] !== "string"
          || Buffer.byteLength(result["text"], "utf8") > MAXIMUM_MANAGED_AGENT_RESULT_BYTES
          || (result["isError"] !== undefined && typeof result["isError"] !== "boolean")) {
          throw runtimeFault("callback_invalid", false);
        }
        await channel.sendCallback(callbackId, true, result);
      } else {
        await channel.sendCallback(callbackId, false);
      }
    } catch {
      controller.abort();
      await channel.sendCallback(callbackId, false).catch(() => undefined);
      if (frame.callback === "hook" && !this.#ended) this.#failProtocol();
    } finally {
      this.#callbackControllers.delete(callbackId);
      this.#hookCallbackIds.delete(callbackId);
    }
  }

  #cancelCallback(callbackId: string): void {
    const hook = this.#hookCallbackIds.delete(callbackId);
    this.#callbackControllers.get(callbackId)?.abort();
    this.#callbackControllers.delete(callbackId);
    if (hook && !this.#ended) this.#failProtocol();
  }

  #requireAttachment(): string {
    if (this.#attachmentId === undefined) throw runtimeFault("attachment_missing", true);
    return this.#attachmentId;
  }

  #failProtocol(): void {
    this.#ended = true;
    this.#cancelCallbacks();
    this.#output.fail(runtimeFault("protocol_error", true));
    void this.#channel?.close().catch(() => undefined);
  }

  #cancelCallbacks(): void {
    for (const controller of this.#callbackControllers.values()) controller.abort();
    this.#callbackControllers.clear();
    this.#hookCallbackIds.clear();
  }
}

interface RemoteClaudeManagerChannelOptions {
  readonly processes: RemoteProcessTransportPort;
  readonly installation: RemoteClaudeInstallationProbe;
  readonly assertCurrent: () => void;
  readonly acceptManagerGeneration: (generation: string) => void;
  readonly onEvent?: (frame: Readonly<Record<string, unknown>>) => void;
  readonly onCallback?: (frame: Readonly<Record<string, unknown>>) => void | Promise<void>;
  readonly onCallbackCancel?: (callbackId: string) => void;
  readonly onClosed?: (error: Error) => void;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
}

class RemoteClaudeManagerChannel {
  readonly #options: RemoteClaudeManagerChannelOptions;
  readonly #process: RemoteProcessHandle;
  readonly #pending = new Map<string, PendingRequest>();
  #buffer = Buffer.alloc(0);
  #writeTail: Promise<void> = Promise.resolve();
  #closeFlight: Promise<void> | undefined;
  #closed = false;
  #failureDelivered = false;

  private constructor(options: RemoteClaudeManagerChannelOptions, processHandle: RemoteProcessHandle) {
    this.#options = options;
    this.#process = processHandle;
    processHandle.stdout.on("data", (chunk: Buffer | string) => this.#acceptBytes(chunk));
    processHandle.stdout.once("error", () => this.#fail(transportFault("stream_failed")));
    processHandle.stderr.once("error", () => this.#fail(transportFault("stream_failed")));
    processHandle.stdin.once("error", () => this.#fail(transportFault("write_failed")));
    processHandle.stderr.resume();
    processHandle.once("error", () => this.#fail(transportFault("process_failed")));
    processHandle.once("exit", () => this.#fail(transportFault("process_exited")));
  }

  static async open(options: RemoteClaudeManagerChannelOptions, signal?: AbortSignal): Promise<RemoteClaudeManagerChannel> {
    options.assertCurrent();
    const processHandle = await options.processes.open({
      executable: options.installation.nodeExecutable,
      args: [
        options.installation.managerModule,
        "bridge",
        options.installation.socketPath,
        options.installation.runtimeRoot,
        options.installation.claudeExecutable
      ],
      cwd: options.installation.workspaceRoot,
      env: managerEnvironment(options.installation),
      signal
    }).catch(() => { throw transportFault("spawn_failed", false); });
    const channel = new RemoteClaudeManagerChannel(options, processHandle);
    try {
      const hello = await channel.request("hello", {}, { timeoutMs: REQUEST_TIMEOUT_MS, signal });
      if (!isRecord(hello)
        || hello.protocolVersion !== REMOTE_CLAUDE_PROTOCOL_VERSION
        || hello.managerVersion !== REMOTE_CLAUDE_MANAGER_VERSION
        || hello.managerSha256 !== options.installation.managerSha256
        || typeof hello.managerGeneration !== "string"
        || !UUID.test(hello.managerGeneration)) {
        throw runtimeFault("manager_version_mismatch", false);
      }
      options.acceptManagerGeneration(hello.managerGeneration.toLowerCase());
      options.assertCurrent();
      return channel;
    } catch (error) {
      try { await channel.forceClose(); }
      catch (cleanupError) { throw cleanupError; }
      throw error;
    }
  }

  get active(): boolean {
    return !this.#closed && this.#process.exitCode === null && this.#process.signalCode === null;
  }

  request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options: { readonly id?: string; readonly timeoutMs: number; readonly signal?: AbortSignal }
  ): Promise<unknown> {
    if (!this.active) return Promise.reject(transportFault("connection_closed"));
    this.#options.assertCurrent();
    const id = options.id ?? randomUUID();
    if (this.#pending.has(id)) return Promise.reject(runtimeFault("request_duplicate", false));
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(transportFault("request_timeout"));
      }, options.timeoutMs);
      timer.unref?.();
      const abort = options.signal === undefined ? undefined : () => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(transportFault("request_cancelled"));
        void this.forceClose().catch(() => undefined);
      };
      this.#pending.set(id, {
        resolve: resolvePromise,
        reject,
        timer,
        ...(options.signal === undefined ? {} : { signal: options.signal, abort })
      });
      options.signal?.addEventListener("abort", abort!, { once: true });
      this.#send({ v: 1, kind: "request", id, method, params }).catch((error) => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        this.#cleanPending(pending);
        reject(error);
      });
      if (options.signal?.aborted) abort?.();
    });
  }

  sendCallback(callbackId: string, ok: boolean, value?: unknown): Promise<void> {
    return this.#send({ v: 1, kind: "callback_result", callbackId, ok, ...(ok ? { value } : {}) });
  }

  close(): Promise<void> {
    this.#closeFlight ??= this.#closeAndConfirm();
    return this.#closeFlight;
  }

  async #closeAndConfirm(): Promise<void> {
    const wasClosed = this.#closed;
    this.#closed = true;
    if (!wasClosed) {
      try { this.#process.stdin.end(); } catch { /* Exit confirmation below owns the outcome. */ }
    }
    let exited = await processExitBefore(this.#process, CHANNEL_CLOSE_TIMEOUT_MS);
    if (!exited) {
      try { this.#process.kill("SIGTERM"); } catch { /* Continue to hard close. */ }
      exited = await processExitBefore(this.#process, CHANNEL_CLOSE_TIMEOUT_MS);
    }
    if (!exited) {
      try { this.#process.kill("SIGKILL"); } catch { /* Confirmation below is authoritative. */ }
      exited = await processExitBefore(this.#process, CHANNEL_CLOSE_TIMEOUT_MS);
    }
    this.#rejectPending(transportFault("connection_closed"));
    if (!exited) throw runtimeFault("bridge_retirement_unconfirmed", true);
  }

  forceClose(): Promise<void> {
    this.#closeFlight ??= this.#forceCloseAndConfirm();
    return this.#closeFlight;
  }

  async #forceCloseAndConfirm(): Promise<void> {
    if (!this.#closed) this.#closed = true;
    if (this.#process.exitCode === null && this.#process.signalCode === null) {
      try { this.#process.kill("SIGKILL"); } catch { /* Confirmation below is authoritative. */ }
      if (!(await processExitBefore(this.#process, CHANNEL_CLOSE_TIMEOUT_MS))) {
        throw runtimeFault("bridge_retirement_unconfirmed", true);
      }
    }
    this.#rejectPending(transportFault("connection_closed"));
  }

  #acceptBytes(chunk: Buffer | string): void {
    if (this.#closed) return;
    const value = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (this.#buffer.byteLength + value.byteLength > MAXIMUM_BUFFER_BYTES) return this.#fail(transportFault("buffer_overflow"));
    this.#buffer = Buffer.concat([this.#buffer, value]);
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#buffer.byteLength > MAXIMUM_LINE_BYTES) this.#fail(transportFault("frame_too_large"));
        return;
      }
      if (newline === 0 || newline > MAXIMUM_LINE_BYTES) return this.#fail(transportFault("protocol_error"));
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      let frame: unknown;
      try { frame = JSON.parse(decodeUtf8(line)); }
      catch { return this.#fail(transportFault("protocol_error")); }
      if (!isRecord(frame) || frame.v !== 1 || typeof frame.kind !== "string") return this.#fail(transportFault("protocol_error"));
      this.#acceptFrame(frame);
      if (this.#closed) return;
    }
  }

  #acceptFrame(frame: Readonly<Record<string, unknown>>): void {
    if (frame.kind === "response") {
      if (typeof frame.id !== "string") return this.#fail(transportFault("protocol_error"));
      const pending = this.#pending.get(frame.id);
      if (pending === undefined) return;
      this.#pending.delete(frame.id);
      this.#cleanPending(pending);
      try { this.#options.assertCurrent(); }
      catch { pending.reject(runtimeFault("authority_changed", true)); return; }
      if (frame.ok === true) pending.resolve(frame.value);
      else if (frame.ok === false && isRecord(frame.error) && typeof frame.error.code === "string") {
        pending.reject(new RemoteClaudeManagerFault(frame.error.code, frame.error.stateMayHaveChanged === true));
      } else pending.reject(runtimeFault("protocol_error", true));
      return;
    }
    if (frame.kind === "event") {
      try { this.#options.onEvent?.(frame); }
      catch { this.#fail(transportFault("protocol_error")); }
      return;
    }
    if (frame.kind === "callback") {
      void Promise.resolve(this.#options.onCallback?.(frame)).catch(() => undefined);
      return;
    }
    if (frame.kind === "callback_cancel" && typeof frame.callbackId === "string") {
      this.#options.onCallbackCancel?.(frame.callbackId);
      return;
    }
    this.#fail(transportFault("protocol_error"));
  }

  #send(value: unknown): Promise<void> {
    if (!this.active) return Promise.reject(transportFault("connection_closed"));
    let bytes: Buffer;
    try { bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8"); }
    catch { return Promise.reject(runtimeFault("invalid_request", false)); }
    if (bytes.byteLength > MAXIMUM_LINE_BYTES) return Promise.reject(runtimeFault("frame_too_large", false));
    const operation = this.#writeTail.then(async () => {
      this.#options.assertCurrent();
      await writeProcessBytes(this.#process, bytes);
    });
    this.#writeTail = operation.catch(() => undefined);
    return operation;
  }

  #fail(error: RemoteClaudeManagerFault): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(error);
    try { this.#process.kill("SIGKILL"); } catch { /* The bridge may already be gone. */ }
    if (!this.#failureDelivered) {
      this.#failureDelivered = true;
      this.#options.onClosed?.(error);
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      this.#cleanPending(pending);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #cleanPending(pending: PendingRequest): void {
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.abort !== undefined) pending.signal.removeEventListener("abort", pending.abort);
  }
}

class AsyncValueQueue<T> implements AsyncIterableIterator<T> {
  readonly #values: Array<{ readonly value: T; readonly bytes: number }> = [];
  readonly #waiters: Array<{ readonly resolve: (value: IteratorResult<T>) => void; readonly reject: (error: unknown) => void }> = [];
  #bytes = 0;
  #closed = false;
  #error: unknown;

  [Symbol.asyncIterator](): AsyncIterableIterator<T> { return this; }

  next(): Promise<IteratorResult<T>> {
    const queued = this.#values.shift();
    if (queued !== undefined) {
      this.#bytes -= queued.bytes;
      return Promise.resolve({ value: queued.value, done: false });
    }
    if (this.#closed) return this.#error === undefined
      ? Promise.resolve({ value: undefined, done: true })
      : Promise.reject(this.#error);
    return new Promise((resolvePromise, reject) => this.#waiters.push({ resolve: resolvePromise, reject }));
  }

  push(value: T): boolean {
    if (this.#closed) return false;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value, done: false });
      return true;
    }
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(value), "utf8"); }
    catch { return false; }
    if (this.#values.length >= MAXIMUM_QUEUED_EVENTS || this.#bytes + bytes > MAXIMUM_QUEUED_EVENT_BYTES) return false;
    this.#values.push({ value, bytes });
    this.#bytes += bytes;
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
}

class RemoteClaudeManagerFault extends Error {
  constructor(
    readonly code: string,
    readonly stateMayHaveChanged: boolean,
    readonly transport = false
  ) {
    super(`Remote Claude manager failure: ${code}.`);
    this.name = "RemoteClaudeManagerFault";
  }
}

function serializeQueryOptions(options: ClaudeSdkQueryOptions): Readonly<Record<string, unknown>> {
  return {
    additionalDirectories: [...options.additionalDirectories],
    allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions,
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.agents === undefined ? {} : { agents: { ...options.agents } }),
    cwd: options.cwd,
    env: { ...options.env },
    ...(options.extraArgs === undefined ? {} : { extraArgs: { ...options.extraArgs } }),
    ...(options.getOAuthToken === undefined ? {} : { getOAuthToken: true }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    ...(options.forwardSubagentText === undefined ? {} : { forwardSubagentText: options.forwardSubagentText }),
    ...(options.hooks === undefined ? {} : { hooks: serializeHookManifest(options.hooks) }),
    ...(options.managedAgentTool === undefined ? {} : { managedAgentTool: true }),
    includePartialMessages: true,
    ...(options.disallowedTools === undefined ? {} : { disallowedTools: [...options.disallowedTools] }),
    ...(options.mcpServers === undefined ? {} : { mcpServers: { ...options.mcpServers } }),
    ...(options.model === undefined ? {} : { model: options.model }),
    permissionMode: options.permissionMode,
    persistSession: options.persistSession,
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.settings === undefined ? {} : { settings: { ...options.settings } }),
    settingSources: [...options.settingSources],
    ...(options.skills === undefined ? {} : { skills: [...options.skills] }),
    ...(options.strictMcpConfig === undefined ? {} : { strictMcpConfig: options.strictMcpConfig }),
    systemPrompt: { ...options.systemPrompt },
    ...(options.title === undefined ? {} : { title: options.title }),
    tools: Array.isArray(options.tools) ? [...options.tools] : { ...options.tools }
  };
}

function managedAgentCallbackRequest(value: unknown): {
  readonly input: ClaudeSdkManagedAgentInput;
  readonly toolUseId: string;
} {
  if (!isRecord(value) || !isRecord(value["input"]) || typeof value["toolUseId"] !== "string"
    || value["toolUseId"].length === 0 || value["toolUseId"].length > 512
    || /[\x00-\x1f\x7f]/u.test(value["toolUseId"])
    || !Object.keys(value).every((key) => key === "input" || key === "toolUseId")
    || encodedBytes(value) > MAXIMUM_HOOK_PAYLOAD_BYTES) {
    throw runtimeFault("callback_invalid", false);
  }
  const raw = value["input"];
  const allowedKeys = new Set([
    "description", "prompt", "subagent_type", "model", "run_in_background",
    "name", "team_name", "mode", "isolation", "cwd"
  ]);
  if (!Object.keys(raw).every((key) => allowedKeys.has(key))
    || !trimmedString(raw["description"], 1, 512)
    || typeof raw["prompt"] !== "string" || raw["prompt"].length < 1 || raw["prompt"].length > 1024 * 1024
    || !optionalTrimmedString(raw["subagent_type"], 1, 256)
    || !optionalTrimmedString(raw["model"], 1, 512)
    || (raw["run_in_background"] !== undefined && typeof raw["run_in_background"] !== "boolean")
    || (raw["name"] !== undefined && (typeof raw["name"] !== "string"
      || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(raw["name"])))
    || !optionalStringWithin(raw["team_name"], 256)
    || !optionalStringWithin(raw["mode"], 64)
    || (raw["isolation"] !== undefined && raw["isolation"] !== "worktree" && raw["isolation"] !== "remote")
    || !optionalStringWithin(raw["cwd"], 16_384)) {
    throw runtimeFault("callback_invalid", false);
  }
  return {
    input: Object.freeze({ ...raw }) as unknown as ClaudeSdkManagedAgentInput,
    toolUseId: value["toolUseId"]
  };
}

function trimmedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum && value.trim() === value;
}

function optionalTrimmedString(value: unknown, minimum: number, maximum: number): boolean {
  return value === undefined || trimmedString(value, minimum, maximum);
}

function optionalStringWithin(value: unknown, maximum: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= maximum);
}

function serializeHookManifest(hooks: NonNullable<ClaudeSdkQueryOptions["hooks"]>): Readonly<Record<string, unknown>> {
  const manifest: Record<string, unknown> = {};
  let callbacks = 0;
  for (const [rawEvent, matchers] of Object.entries(hooks)) {
    if (!REMOTE_HOOK_EVENTS.includes(rawEvent as typeof REMOTE_HOOK_EVENTS[number]) || !Array.isArray(matchers)
      || matchers.length === 0 || matchers.length > MAXIMUM_CALLBACKS_PER_QUERY) {
      throw runtimeFault("hook_manifest_invalid", false);
    }
    manifest[rawEvent] = matchers.map((matcher) => {
      if (!isRecord(matcher) || !Array.isArray(matcher.hooks) || matcher.hooks.length === 0
        || matcher.hooks.some((callback) => typeof callback !== "function")) {
        throw runtimeFault("hook_manifest_invalid", false);
      }
      callbacks += matcher.hooks.length;
      if (callbacks > MAXIMUM_CALLBACKS_PER_QUERY) throw runtimeFault("hook_manifest_invalid", false);
      if (matcher.matcher !== undefined && (typeof matcher.matcher !== "string" || matcher.matcher.length === 0
        || matcher.matcher.length > 512 || /[\x00-\x1f\x7f]/u.test(matcher.matcher))) {
        throw runtimeFault("hook_manifest_invalid", false);
      }
      if (matcher.timeout !== undefined && (!Number.isSafeInteger(matcher.timeout) || matcher.timeout < 1 || matcher.timeout > 3_600)) {
        throw runtimeFault("hook_manifest_invalid", false);
      }
      return {
        ...(matcher.matcher === undefined ? {} : { matcher: matcher.matcher }),
        hookCount: matcher.hooks.length,
        ...(matcher.timeout === undefined ? {} : { timeout: matcher.timeout })
      };
    });
  }
  if (callbacks === 0 || encodedBytes(manifest) > MAXIMUM_HOOK_PAYLOAD_BYTES) {
    throw runtimeFault("hook_manifest_invalid", false);
  }
  return manifest;
}

function callbackRequest(value: unknown): {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly options: Omit<ClaudeCanUseToolOptions, "signal">;
} {
  if (!isRecord(value) || typeof value.toolName !== "string" || !isRecord(value.input) || !isRecord(value.options)) {
    throw runtimeFault("callback_invalid", false);
  }
  const options = value.options;
  if (typeof options.toolUseID !== "string" || typeof options.requestId !== "string") throw runtimeFault("callback_invalid", false);
  return {
    toolName: value.toolName,
    input: value.input,
    options: options as unknown as Omit<ClaudeCanUseToolOptions, "signal">
  };
}

function hookCallbackRequest(
  value: unknown,
  options: ClaudeSdkQueryOptions
): {
  readonly callback: (
    input: ClaudeSdkHookInput,
    toolUseId: string | undefined,
    options: { readonly signal: AbortSignal }
  ) => Promise<ClaudeSdkHookOutput>;
  readonly input: ClaudeSdkHookInput;
  readonly toolUseId: string | undefined;
} {
  if (!isRecord(value) || typeof value.event !== "string"
    || !REMOTE_HOOK_EVENTS.includes(value.event as typeof REMOTE_HOOK_EVENTS[number])
    || !Number.isSafeInteger(value.matcherIndex) || !Number.isSafeInteger(value.hookIndex)
    || (value.matcherIndex as number) < 0 || (value.hookIndex as number) < 0
    || !isRecord(value.input) || value.input.hook_event_name !== value.event
    || encodedBytes(value) > MAXIMUM_HOOK_PAYLOAD_BYTES
    || (value.toolUseId !== undefined && (typeof value.toolUseId !== "string" || value.toolUseId.length === 0
      || value.toolUseId.length > 512 || /[\x00-\x1f\x7f]/u.test(value.toolUseId)))) {
    throw runtimeFault("callback_invalid", false);
  }
  const event = value.event as ClaudeSdkHookEvent;
  const matcher = options.hooks?.[event]?.[value.matcherIndex as number];
  const callback = matcher?.hooks[value.hookIndex as number];
  if (callback === undefined) throw runtimeFault("callback_invalid", false);
  return {
    callback,
    input: value.input as unknown as ClaudeSdkHookInput,
    toolUseId: value.toolUseId as string | undefined
  };
}

function encodedBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
  catch { return Number.POSITIVE_INFINITY; }
}

function sessionInfo(value: unknown): ClaudeSdkSessionInfo {
  if (!isRecord(value) || typeof value.sessionId !== "string" || !UUID.test(value.sessionId)
    || typeof value.summary !== "string" || value.summary.length > 16_384
    || typeof value.lastModified !== "number" || !Number.isFinite(value.lastModified)
    || (value.customTitle !== undefined && (typeof value.customTitle !== "string" || value.customTitle.length > 16_384))
    || (value.cwd !== undefined && (typeof value.cwd !== "string" || !normalizedAbsoluteRemotePath(value.cwd)))) {
    throw runtimeFault("invalid_response", false);
  }
  return value as unknown as ClaudeSdkSessionInfo;
}

function sessionMessage(value: unknown): ClaudeSdkSessionMessage {
  if (!isRecord(value) || !["user", "assistant", "system"].includes(String(value.type))
    || typeof value.uuid !== "string" || !UUID.test(value.uuid)
    || typeof value.session_id !== "string" || !UUID.test(value.session_id)
    || (value.parent_tool_use_id !== null && typeof value.parent_tool_use_id !== "string")
    || (value.parent_agent_id !== null && typeof value.parent_agent_id !== "string")) {
    throw runtimeFault("invalid_response", false);
  }
  return value as unknown as ClaudeSdkSessionMessage;
}

function targetSignature(target: TargetDescriptor): string {
  return JSON.stringify({
    id: target.id,
    backendId: target.backendId,
    displayName: target.displayName,
    workspaceRoot: target.workspaceRoot,
    managed: target.managed,
    trusted: target.trusted,
    remoteWorkspace: target.remoteWorkspace ?? null
  });
}

function requireRemoteBinding(target: TargetDescriptor): NonNullable<TargetDescriptor["remoteWorkspace"]> {
  const binding = target.remoteWorkspace;
  if (binding === undefined || binding.hostId.length === 0 || binding.hostId.length > 256
    || !normalizedAbsoluteRemotePath(binding.workspaceRoot)) throw runtimeFault("remote_target_invalid", false);
  return binding;
}

function requireProcesses(lease: RemoteSshTransportLease): RemoteProcessTransportPort {
  if (lease.capabilities.processStreaming !== true || lease.processes === undefined) throw runtimeFault("process_transport_unavailable", false);
  return lease.processes;
}

function executionHostIdentity(host: RemoteHostRecord): Readonly<Record<string, unknown>> {
  if (host.trust === undefined || host.user.length === 0) throw runtimeFault("host_unpinned", false);
  return {
    hostname: host.hostname,
    port: host.port,
    user: host.user,
    algorithm: host.trust.algorithm,
    fingerprint: host.trust.fingerprint
  };
}

function normalizedAbsoluteRemotePath(value: string): boolean {
  return value.length > 0
    && value.length <= 16_384
    && !/[\u0000-\u001f\u007f\\]/u.test(value)
    && remotePath.isAbsolute(value)
    && remotePath.normalize(value) === value;
}

function managerEnvironment(installation: RemoteClaudeInstallationProbe): Readonly<Record<string, string>> {
  const profile = remotePath.join(installation.runtimeRoot, "profile");
  const temporary = remotePath.join(installation.runtimeRoot, "tmp");
  return Object.freeze({
    HOME: profile,
    PATH: `${remotePath.dirname(installation.nodeExecutable)}:/usr/local/bin:/usr/bin:/bin`,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    CLAUDE_CONFIG_DIR: profile,
    CLAUDE_CODE_TMPDIR: temporary,
    JOKO_CLAUDE_RUNTIME_ROOT: installation.runtimeRoot,
    JOKO_CLAUDE_EXECUTABLE: installation.claudeExecutable
  });
}

function decodeUtf8(value: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { throw transportFault("protocol_error"); }
}

async function writeProcessBytes(handle: RemoteProcessHandle, bytes: Buffer): Promise<void> {
  if (handle.exitCode !== null || handle.signalCode !== null) throw transportFault("write_failed");
  await new Promise<void>((resolvePromise, reject) => {
    try {
      handle.stdin.write(bytes, (error) => error ? reject(transportFault("write_failed")) : resolvePromise());
    } catch { reject(transportFault("write_failed")); }
  });
}

async function processExitBefore(handle: RemoteProcessHandle, timeoutMs: number): Promise<boolean> {
  if (handle.exitCode !== null || handle.signalCode !== null) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<true>((resolvePromise) => handle.once("exit", () => resolvePromise(true))),
      new Promise<false>((resolvePromise) => { timer = setTimeout(() => resolvePromise(false), timeoutMs); timer.unref?.(); })
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimeFault(code: string, stateMayHaveChanged: boolean): RemoteClaudeManagerFault {
  return new RemoteClaudeManagerFault(code, stateMayHaveChanged);
}

function transportFault(code: string, stateMayHaveChanged = true): RemoteClaudeManagerFault {
  return new RemoteClaudeManagerFault(code, stateMayHaveChanged, true);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
