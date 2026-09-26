import { createHash, randomUUID } from "node:crypto";
import { posix as remotePath } from "node:path";
import { TextDecoder } from "node:util";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

import {
  CLAUDE_AGENT_SDK_VERSION,
  ClaudeSessionStoreError,
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
  type ClaudeSdkStoredSessionRuntime,
  type ClaudeSdkUserMessage,
  type ClaudeTargetRuntime
} from "@joko/adapter-claude-code";
import type {
  ClaudeSessionStoreOperationAccess,
  ClaudeSessionStoreOperationSnapshot,
  ClaudeSessionStoreSessionAccess
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
const MAXIMUM_MCP_PAYLOAD_BYTES = 24 * 1024 * 1024;
const REMOTE_HOOK_EVENTS = ["PreToolUse", "PermissionDenied", "PostToolUse", "PostToolUseFailure"] as const satisfies readonly ClaudeSdkHookEvent[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKSPACE_AUTHORITY = /^workspace-[0-9a-f]{64}$/u;
const STORE_CODES = new Set([
  "INVALID_AUTHORITY", "INVALID_ACCESS", "INVALID_KEY", "INVALID_ENTRY", "LIMIT_EXCEEDED",
  "NOT_FOUND", "CONFLICT", "OPERATION_NOT_READY", "CORRUPT", "STORAGE_UNAVAILABLE",
  "COMMIT_UNKNOWN", "RESERVATION_REQUIRED", "RESERVATION_FAILED"
]);

interface RemoteClaudeStoreAuthority {
  readonly schemaVersion: 1;
  readonly namespace: string;
  readonly generation: number;
}

type ProcessAuthority = Awaited<ReturnType<RemoteHostRegistry["captureProcessAuthority"]>>;

interface ResolverEntry {
  readonly key: string;
  readonly targetId: string;
  readonly targetRevision: bigint;
  readonly targetSignature: string;
  readonly storedSignature: string;
  readonly authority: ProcessAuthority;
  readonly runtime: RemoteClaudeSdkRuntime;
  readonly binding: ClaudeTargetRuntime;
}

export interface RemoteClaudeDerivedWorkspaceAuthority {
  /** Synchronous product/Host fence for a previously verified exact checkout. */
  readonly assertCurrent: () => void;
  /** Read-only remote manifest and Git identity check before an SDK effect. */
  readonly verifyExact: (signal?: AbortSignal) => Promise<void>;
}

export interface RemoteClaudeRuntimeResolverOptions {
  readonly store: Pick<OperationalStore, "getTarget">;
  readonly registry: Pick<RemoteHostRegistry, "captureProcessAuthority">;
  /** Persisted monotonic Backend instance generation, shared by its source and derived runtimes. */
  readonly storeGeneration: number;
  readonly authorizeDerivedWorkspace?: (
    target: TargetDescriptor,
    storedTarget: StoredTarget,
    signal?: AbortSignal
  ) => Promise<RemoteClaudeDerivedWorkspaceAuthority>;
}

/** Target-, Host-, SSH-, installation-, and manager-generation-bound Claude runtime owner. */
export class RemoteClaudeRuntimeResolver implements ClaudeRemoteRuntimePort {
  readonly #store: Pick<OperationalStore, "getTarget">;
  readonly #registry: Pick<RemoteHostRegistry, "captureProcessAuthority">;
  readonly #authorizeDerivedWorkspace: RemoteClaudeRuntimeResolverOptions["authorizeDerivedWorkspace"];
  readonly #storeGeneration: number;
  readonly #entries = new Map<string, ResolverEntry>();
  readonly #flights = new Map<string, Promise<ClaudeTargetRuntime>>();
  #closing = false;
  #closed = false;

  constructor(options: RemoteClaudeRuntimeResolverOptions) {
    if (!Number.isSafeInteger(options.storeGeneration) || options.storeGeneration < 1) {
      throw runtimeFault("store_generation_invalid", false);
    }
    this.#store = options.store;
    this.#registry = options.registry;
    this.#storeGeneration = options.storeGeneration;
    this.#authorizeDerivedWorkspace = options.authorizeDerivedWorkspace;
  }

  async resolve(target: TargetDescriptor, signal?: AbortSignal): Promise<ClaudeTargetRuntime> {
    this.#assertOpen();
    if (signal?.aborted) throw runtimeFault("cancelled", false);
    const stored = this.#storedTarget(target);
    const derived = target.workspaceRoot !== stored.descriptor.workspaceRoot;
    const directoryAuthority = derived
      ? await this.#authorizeDerivedWorkspace!(target, stored, signal)
      : undefined;
    await directoryAuthority?.verifyExact(signal);
    const key = JSON.stringify([target.id, target.workspaceRoot]);
    const signature = targetSignature(target);
    const existing = this.#entries.get(key);
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
    const active = this.#flights.get(key);
    if (active !== undefined) return active;
    const flight = this.#resolveFresh(target, stored, signature, key, directoryAuthority, signal);
    this.#flights.set(key, flight);
    try { return await flight; }
    finally { if (this.#flights.get(key) === flight) this.#flights.delete(key); }
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
    key: string,
    directoryAuthority: RemoteClaudeDerivedWorkspaceAuthority | undefined,
    signal?: AbortSignal
  ): Promise<ClaudeTargetRuntime> {
    const remote = requireRemoteBinding(stored.descriptor);
    const authority = await this.#registry.captureProcessAuthority(remote.hostTargetId, remote.hostId, signal);
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
      runtimeRoot: installation.runtimeRoot,
      ...(directoryAuthority === undefined ? {} : { workspaceRoot: target.workspaceRoot })
    }), "utf8").digest("hex");
    const ownerGeneration = `${stored.revision}:${authority.hostRevision}:${authority.leaseGeneration}:${randomUUID()}`;
    const storeAuthority: RemoteClaudeStoreAuthority = Object.freeze({
      schemaVersion: 1,
      namespace: `backend-${createHash("sha256").update(JSON.stringify({
        kind: "joko-remote-claude-store-v1",
        backendId: target.backendId,
        targetId: target.id,
        primaryWorkspaceRoot: remote.workspaceRoot,
        ownerId: authority.host.ownerId,
        host: executionHostIdentity(authority.host),
        runtimeRoot: installation.runtimeRoot
      }), "utf8").digest("hex")}`,
      generation: this.#storeGeneration
    });
    const workspaceAuthority = claudeWorkspaceAuthority(target);
    const storedSignature = targetSignature(stored.descriptor);
    let entry!: ResolverEntry;
    let runtime: RemoteClaudeSdkRuntime | undefined;
    const assertAuthorityCurrent = (): void => {
      if (this.#closed) throw runtimeFault("authority_changed", false);
      const current = this.#store.getTarget(target.id);
      if (current.revision !== stored.revision
        || targetSignature(current.descriptor) !== storedSignature
        || this.#entries.get(key) !== entry) throw runtimeFault("authority_changed", false);
      authority.assertCurrent();
      directoryAuthority?.assertCurrent();
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
      storeAuthority,
      workspaceAuthority,
      authorizedWorkspaceRoot: target.workspaceRoot,
      ...(directoryAuthority === undefined ? {} : { verifyWorkspace: directoryAuthority.verifyExact }),
      assertCurrent,
      assertAuthorityCurrent,
      assertForwardingCurrent: authority.assertForwardingCurrent
    });
    const binding: ClaudeTargetRuntime = Object.freeze({
      runtime,
      workspaceRoot: target.workspaceRoot,
      remote: true,
      assertCurrent
    });
    entry = Object.freeze({
      key,
      targetId: target.id,
      targetRevision: stored.revision,
      targetSignature: signature,
      storedSignature,
      authority,
      runtime,
      binding
    });
    this.#assertOpen();
    authority.assertCurrent();
    this.#entries.set(key, entry);
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
    finally { if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key); }
  }

  #storedTarget(target: TargetDescriptor): StoredTarget {
    const stored = this.#store.getTarget(target.id);
    const storedSignature = targetSignature(stored.descriptor);
    if (storedSignature !== targetSignature(target)) {
      const binding = target.remoteWorkspace;
      const primaryBinding = stored.descriptor.remoteWorkspace;
      const normalized = binding !== undefined && primaryBinding !== undefined
        && (binding.workspaceRoot === primaryBinding.workspaceRoot || binding.workspaceRoot === target.workspaceRoot)
        ? {
            ...target,
            workspaceRoot: stored.descriptor.workspaceRoot,
            remoteWorkspace: { ...binding, workspaceRoot: primaryBinding.workspaceRoot }
          }
        : undefined;
      if (target.workspaceRoot === stored.descriptor.workspaceRoot
        || !normalizedAbsoluteRemotePath(target.workspaceRoot)
        || normalized === undefined
        || targetSignature(normalized) !== storedSignature
        || this.#authorizeDerivedWorkspace === undefined) {
        throw runtimeFault("target_stale", false);
      }
    }
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
  readonly storeAuthority: RemoteClaudeStoreAuthority;
  readonly workspaceAuthority: string;
  readonly authorizedWorkspaceRoot: string;
  readonly verifyWorkspace?: (signal?: AbortSignal) => Promise<void>;
  readonly assertCurrent: () => void;
  readonly assertAuthorityCurrent: () => void;
  readonly assertForwardingCurrent: () => void;
}

class RemoteClaudeSdkRuntime implements ClaudeSdkRuntime {
  readonly packageVersion = CLAUDE_AGENT_SDK_VERSION;
  readonly supportsWorkspaceDerivation = true;
  readonly storedSessions: ClaudeSdkStoredSessionRuntime;
  readonly #options: RemoteClaudeSdkRuntimeOptions;
  readonly #queries = new Map<ClaudeSdkQuery, RemoteClaudeQuery>();
  readonly #ownedQueries = new WeakSet<ClaudeSdkQuery>();
  readonly #sessionOperations = new Set<Promise<unknown>>();
  readonly #forks = new Set<string>();
  readonly #storeOperations = new Set<string>();
  #managerGeneration: string | undefined;
  #managerGenerationCurrent = true;
  #closed = false;

  constructor(options: RemoteClaudeSdkRuntimeOptions) {
    this.#options = options;
    this.storedSessions = this.#createStoredSessions();
  }

  #createStoredSessions(): ClaudeSdkStoredSessionRuntime {
    const runtime: ClaudeSdkStoredSessionRuntime = {
      prepareImport: async (input) => {
        this.#assertStoreSourceInput(input);
        const value = await this.#storeOperation("store.prepareImport", { input });
        const access = storeOperationAccess(value, this.#options.storeAuthority.generation, true);
        if (access.operationId !== input.operationId || access.source.kind !== "import"
          || access.source.workspaceAuthority !== input.sourceWorkspaceAuthority
          || access.source.sessionId !== input.sourceSessionId
          || access.target.workspaceAuthority !== input.targetWorkspaceAuthority) throw runtimeFault("invalid_response", true);
        this.#storeOperations.add(access.operationId);
        return access;
      },
      prepareDerivation: async (input) => {
        this.#assertStoreSourceInput(input);
        const value = await this.#storeOperation("store.prepareDerivation", { input });
        const access = storeOperationAccess(value, this.#options.storeAuthority.generation, true);
        if (access.operationId !== input.operationId || access.source.kind !== "durable"
          || access.source.workspaceAuthority !== input.sourceWorkspaceAuthority
          || access.source.sessionId !== input.sourceSessionId
          || access.target.workspaceAuthority !== input.targetWorkspaceAuthority) throw runtimeFault("invalid_response", true);
        this.#storeOperations.add(access.operationId);
        return access;
      },
      readOperation: async (access) => {
        this.#assertStoreTargetOperation(access);
        return storeOperationSnapshot(
          await this.#storeOperation("store.readOperation", { access }), access
        );
      },
      recoverOperation: async (input) => {
        if (!UUID.test(input.operationId) || input.targetWorkspaceAuthority !== this.#options.workspaceAuthority
          || (input.expectedChildSessionId !== undefined && !UUID.test(input.expectedChildSessionId))) {
          throw runtimeFault("store_access_mismatch", false);
        }
        const access = storeOperationAccess(
          await this.#storeOperation("store.recoverOperation", { input }),
          this.#options.storeAuthority.generation,
          true
        );
        if (access.operationId !== input.operationId
          || access.target.workspaceAuthority !== input.targetWorkspaceAuthority) throw runtimeFault("invalid_response", true);
        this.#storeOperations.add(access.operationId);
        return access;
      },
      cleanupOperation: async (access, input) => {
        this.#assertStoreTargetOperation(access);
        if (input?.expectedChildSessionId !== undefined && !UUID.test(input.expectedChildSessionId)) {
          throw runtimeFault("store_access_mismatch", false);
        }
        return storeOperationSnapshot(await this.#storeOperation("store.cleanupOperation", {
          access, ...(input === undefined ? {} : { input })
        }), access);
      },
      discardImport: async (access) => {
        this.#assertStoreSourceOperation(access, "import");
        const value = await this.#storeOperation("store.discardImport", { access });
        if (!isRecord(value) || value.discarded !== true) throw runtimeFault("invalid_response", true);
      },
      adopt: async (access, sessionId) => {
        this.#assertStoreTargetOperation(access);
        if (!UUID.test(sessionId)) throw runtimeFault("store_access_mismatch", false);
        return storeSessionAccess(await this.#storeOperation("store.adopt", { access, sessionId }),
          this.#options.storeAuthority.generation, this.#options.workspaceAuthority, sessionId, true);
      },
      claim: async (input) => {
        this.#assertStoreSessionInput(input);
        return storeSessionAccess(await this.#storeOperation("store.claim", { input }),
          this.#options.storeAuthority.generation, input.workspaceAuthority, input.sessionId, true);
      },
      rebind: async (input) => {
        this.#assertStoreSessionInput(input);
        if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1
          || input.expectedGeneration > this.#options.storeAuthority.generation) throw runtimeFault("store_access_mismatch", false);
        return storeSessionAccess(await this.#storeOperation("store.rebind", { input }),
          this.#options.storeAuthority.generation, input.workspaceAuthority, input.sessionId, true);
      },
      importSession: async (sessionId, options) => {
        this.#assertDirectory(options.dir);
        this.#assertStoreSourceOperation(options.access, "import", sessionId);
        const value = await this.#storeOperation("store.import", {
          access: options.access, sessionId, dir: options.dir
        }, options.signal);
        if (!isRecord(value) || value.imported !== true) throw runtimeFault("invalid_response", true);
      },
      forkSession: async (sessionId, options) => {
        this.#assertDirectory(options.dir);
        this.#assertStoreTargetOperation(options.access);
        if (!UUID.test(sessionId) || options.access.source.sessionId !== sessionId
          || (options.upToMessageId !== undefined && !UUID.test(options.upToMessageId))) {
          throw runtimeFault("store_access_mismatch", false);
        }
        this.#forks.add(sessionId);
        let reservedSessionId: string | undefined;
        try {
          const value = await this.#storeOperation("store.fork", {
            access: options.access, sessionId, dir: options.dir,
            ...(options.upToMessageId === undefined ? {} : { upToMessageId: options.upToMessageId })
          }, options.signal, async (channel, frame) => {
            const callbackId = frame.callbackId;
            try {
              if (frame.callback !== "storeChildReserved" || frame.queryId !== undefined
                || typeof callbackId !== "string" || !UUID.test(callbackId)) {
                throw runtimeFault("callback_invalid", false);
              }
              const reservation = storeChildReservation(frame.value, options.access);
              this.#options.assertCurrent();
              if (reservedSessionId === undefined) {
                options.recordSessionId(reservation.sessionId);
                reservedSessionId = reservation.sessionId;
              } else if (reservedSessionId !== reservation.sessionId) {
                throw runtimeFault("callback_invalid", true);
              }
              this.#options.assertCurrent();
              await channel.sendCallback(callbackId, true, { accepted: true });
            } catch {
              if (typeof callbackId === "string") await channel.sendCallback(callbackId, false).catch(() => undefined);
            }
          });
          if (!isRecord(value) || typeof value.sessionId !== "string" || !UUID.test(value.sessionId)
            || value.sessionId.toLowerCase() !== reservedSessionId) throw runtimeFault("invalid_response", true);
          return { sessionId: reservedSessionId };
        } finally { this.#forks.delete(sessionId); }
      },
      getSessionInfo: async (sessionId, options) => {
        this.#assertDirectory(options.dir);
        this.#assertStoreReadAccess(options.access, sessionId);
        const value = await this.#storeOperation("store.info", {
          access: options.access, sessionId, dir: options.dir
        }, options.signal);
        return value === undefined || value === null ? undefined : sessionInfo(value);
      },
      getSessionMessages: async (sessionId, options) => {
        this.#assertDirectory(options.dir);
        this.#assertStoreReadAccess(options.access, sessionId);
        const value = await this.#storeOperation("store.messages", {
          access: options.access, sessionId, dir: options.dir,
          limit: options.limit, offset: options.offset,
          includeSystemMessages: options.includeSystemMessages
        }, options.signal);
        if (!Array.isArray(value) || value.length > options.limit) throw runtimeFault("invalid_response", false);
        return value.map(sessionMessage);
      },
      deleteSession: async (sessionId, options) => {
        this.#assertDirectory(options.dir);
        this.#assertStoreReadAccess(options.access, sessionId);
        await this.#storeOperation("store.delete", {
          access: options.access, sessionId, dir: options.dir
        }, options.signal);
      },
      ownsOperation: (operationId) => this.#storeOperations.has(operationId)
    };
    return Object.freeze(runtime);
  }

  #assertStoreSourceInput(input: {
    readonly operationId: string;
    readonly sourceWorkspaceAuthority: string;
    readonly sourceSessionId: string;
    readonly targetWorkspaceAuthority: string;
  }): void {
    if (!UUID.test(input.operationId) || !UUID.test(input.sourceSessionId)
      || input.sourceWorkspaceAuthority !== this.#options.workspaceAuthority
      || !WORKSPACE_AUTHORITY.test(input.targetWorkspaceAuthority)) throw runtimeFault("store_access_mismatch", false);
  }

  #assertStoreSourceOperation(access: ClaudeSessionStoreOperationAccess, kind: "import" | "durable", sessionId?: string): void {
    storeOperationAccess(access, this.#options.storeAuthority.generation);
    if (access.source.kind !== kind || access.source.workspaceAuthority !== this.#options.workspaceAuthority
      || (sessionId !== undefined && access.source.sessionId !== sessionId)) throw runtimeFault("store_access_mismatch", false);
  }

  #assertStoreTargetOperation(access: ClaudeSessionStoreOperationAccess): void {
    storeOperationAccess(access, this.#options.storeAuthority.generation);
    if (access.target.workspaceAuthority !== this.#options.workspaceAuthority) throw runtimeFault("store_access_mismatch", false);
  }

  #assertStoreSessionInput(input: { readonly workspaceAuthority: string; readonly sessionId: string }): void {
    if (input.workspaceAuthority !== this.#options.workspaceAuthority || !UUID.test(input.sessionId)) {
      throw runtimeFault("store_access_mismatch", false);
    }
  }

  #assertStoreReadAccess(access: ClaudeSessionStoreSessionAccess | ClaudeSessionStoreOperationAccess, sessionId: string): void {
    if (!UUID.test(sessionId)) throw runtimeFault("store_access_mismatch", false);
    if (access.kind === "operation") this.#assertStoreTargetOperation(access);
    else storeSessionAccess(access, this.#options.storeAuthority.generation, this.#options.workspaceAuthority, sessionId);
  }

  async #storeOperation(
    method: string,
    params: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    onCallback?: (channel: RemoteClaudeManagerChannel, frame: Readonly<Record<string, unknown>>) => Promise<void>
  ): Promise<unknown> {
    try {
      return await this.#sessionOperation(method, { authority: this.#options.storeAuthority, ...params }, signal, onCallback);
    } catch (error) {
      if (error instanceof RemoteClaudeManagerFault && STORE_CODES.has(error.code)) {
        throw new ClaudeSessionStoreError(error.code as ConstructorParameters<typeof ClaudeSessionStoreError>[0], error.stateMayHaveChanged);
      }
      throw error;
    }
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
    this.#assertDirectory(params.options.cwd);
    if (params.options.sessionStoreAccess !== undefined) {
      storeSessionAccess(params.options.sessionStoreAccess,
        this.#options.storeAuthority.generation,
        this.#options.workspaceAuthority,
        params.options.resume ?? params.options.sessionId);
    }
    this.#options.assertCurrent();
    await this.#options.verifyWorkspace?.(params.options.abortController.signal);
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
        storeAuthority: this.#options.storeAuthority,
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

  async #sessionOperation(
    method: string,
    params: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    onCallback?: (channel: RemoteClaudeManagerChannel, frame: Readonly<Record<string, unknown>>) => Promise<void>
  ): Promise<unknown> {
    const operation = this.#requestOnce(method, params, signal, SESSION_OPERATION_TIMEOUT_MS, onCallback);
    this.#sessionOperations.add(operation);
    try { return await operation; }
    finally { this.#sessionOperations.delete(operation); }
  }

  async #requestOnce(
    method: string,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    onCallback?: (channel: RemoteClaudeManagerChannel, frame: Readonly<Record<string, unknown>>) => Promise<void>
  ): Promise<unknown> {
    this.#assertOpen();
    signal?.throwIfAborted();
    await this.#options.verifyWorkspace?.(signal);
    this.#assertOpen();
    let channel!: RemoteClaudeManagerChannel;
    channel = await RemoteClaudeManagerChannel.open({
      ...this.#channelOptions(),
      ...(onCallback === undefined ? {} : { onCallback: (frame) => onCallback(channel, frame) })
    }, signal);
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
    if (dir !== this.#options.authorizedWorkspaceRoot) throw runtimeFault("workspace_mismatch", false);
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
  readonly storeAuthority: RemoteClaudeStoreAuthority;
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
  readonly #productMcpValidators = new Map<string, {
    readonly input: ReturnType<AjvJsonSchemaValidator["getValidator"]>;
    readonly output?: ReturnType<AjvJsonSchemaValidator["getValidator"]>;
  }>();
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
    const validator = new AjvJsonSchemaValidator();
    for (const tool of options.params.options.mcpTools ?? []) {
      const identity = `${tool.serverId}\0${tool.name}`;
      if (this.#productMcpValidators.has(identity)) throw runtimeFault("mcp_catalog_invalid", false);
      try {
        this.#productMcpValidators.set(identity, {
          input: validator.getValidator(tool.inputSchema as Parameters<typeof validator.getValidator>[0]),
          ...(tool.outputSchema === undefined ? {} : {
            output: validator.getValidator(tool.outputSchema as Parameters<typeof validator.getValidator>[0])
          })
        });
      } catch { throw runtimeFault("mcp_catalog_invalid", false); }
    }
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
      options: serializeQueryOptions(this.#options.params.options, this.#options.storeAuthority)
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
      } else if (frame.callback === "productMcpTool"
        && this.#options.params.options.mcpTools !== undefined) {
        const request = productMcpCallbackRequest(frame.value, this.#options.params.options.mcpTools);
        const validators = this.#productMcpValidators.get(`${request.tool.serverId}\0${request.tool.name}`);
        const checked = validators?.input(request.arguments);
        if (checked?.valid !== true) throw runtimeFault("callback_invalid", false);
        const result = await request.tool.call(checked.data as Readonly<Record<string, unknown>>, {
          toolUseId: request.toolUseId,
          signal: controller.signal
        });
        if (!isRecord(result) || !Array.isArray(result.content) || typeof result.isError !== "boolean"
          || (result.structuredContent !== undefined && !isRecord(result.structuredContent))
          || encodedBytes(result) > MAXIMUM_MCP_PAYLOAD_BYTES
          || (!result.isError && validators?.output !== undefined && !validators.output(result.structuredContent).valid)) {
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
      this.#send({ v: REMOTE_CLAUDE_PROTOCOL_VERSION, kind: "request", id, method, params }).catch((error) => {
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
    return this.#send({ v: REMOTE_CLAUDE_PROTOCOL_VERSION, kind: "callback_result", callbackId, ok, ...(ok ? { value } : {}) });
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
      if (!isRecord(frame) || frame.v !== REMOTE_CLAUDE_PROTOCOL_VERSION || typeof frame.kind !== "string") return this.#fail(transportFault("protocol_error"));
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

function serializeQueryOptions(
  options: ClaudeSdkQueryOptions,
  storeAuthority: RemoteClaudeStoreAuthority
): Readonly<Record<string, unknown>> {
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
    ...(options.mcpTools === undefined ? {} : { productMcpTools: serializeProductMcpTools(options.mcpTools) }),
    includePartialMessages: true,
    ...(options.disallowedTools === undefined ? {} : { disallowedTools: [...options.disallowedTools] }),
    ...(options.mcpServers === undefined ? {} : { mcpServers: { ...options.mcpServers } }),
    ...(options.model === undefined ? {} : { model: options.model }),
    permissionMode: options.permissionMode,
    persistSession: options.persistSession,
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.sessionStoreAccess === undefined ? {} : {
      sessionStoreAuthority: storeAuthority,
      sessionStoreAccess: options.sessionStoreAccess
    }),
    ...(options.settings === undefined ? {} : { settings: { ...options.settings } }),
    settingSources: [...options.settingSources],
    ...(options.skills === undefined ? {} : { skills: [...options.skills] }),
    ...(options.strictMcpConfig === undefined ? {} : { strictMcpConfig: options.strictMcpConfig }),
    systemPrompt: { ...options.systemPrompt },
    ...(options.title === undefined ? {} : { title: options.title }),
    tools: Array.isArray(options.tools) ? [...options.tools] : { ...options.tools }
  };
}

function serializeProductMcpTools(tools: NonNullable<ClaudeSdkQueryOptions["mcpTools"]>): readonly Readonly<Record<string, unknown>>[] {
  const catalog = tools.map((tool) => ({
    serverId: tool.serverId,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema })
  }));
  if (catalog.length > 10_000 || encodedBytes(catalog) > MAXIMUM_MCP_PAYLOAD_BYTES) {
    throw runtimeFault("mcp_catalog_invalid", false);
  }
  return catalog;
}

function productMcpCallbackRequest(
  value: unknown,
  tools: readonly NonNullable<ClaudeSdkQueryOptions["mcpTools"]>[number][]
): {
  readonly tool: NonNullable<ClaudeSdkQueryOptions["mcpTools"]>[number];
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly toolUseId: string;
} {
  if (!isRecord(value) || !isRecord(value.arguments)
    || typeof value.serverId !== "string" || typeof value.name !== "string"
    || typeof value.toolUseId !== "string" || value.toolUseId.length === 0 || value.toolUseId.length > 512
    || /[\x00-\x1f\x7f]/u.test(value.toolUseId)
    || !Object.keys(value).every((key) => ["serverId", "name", "arguments", "toolUseId"].includes(key))
    || encodedBytes(value) > MAXIMUM_MCP_PAYLOAD_BYTES) throw runtimeFault("callback_invalid", false);
  const tool = tools.find((item) => item.serverId === value.serverId && item.name === value.name);
  if (tool === undefined) throw runtimeFault("callback_invalid", false);
  return { tool, arguments: value.arguments, toolUseId: value.toolUseId };
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

function storeOperationAccess(value: unknown, generation: number, stateMayHaveChanged = false): ClaudeSessionStoreOperationAccess {
  if (!isRecord(value) || value.kind !== "operation" || typeof value.operationId !== "string"
    || !UUID.test(value.operationId) || value.generation !== generation
    || !isRecord(value.source) || !["import", "durable"].includes(String(value.source.kind))
    || typeof value.source.workspaceAuthority !== "string" || !WORKSPACE_AUTHORITY.test(value.source.workspaceAuthority)
    || typeof value.source.sessionId !== "string" || !UUID.test(value.source.sessionId)
    || !isRecord(value.target) || typeof value.target.workspaceAuthority !== "string"
    || !WORKSPACE_AUTHORITY.test(value.target.workspaceAuthority)
    || !exactKeys(value, ["kind", "operationId", "generation", "source", "target"])
    || !exactKeys(value.source, ["kind", "workspaceAuthority", "sessionId"])
    || !exactKeys(value.target, ["workspaceAuthority"])) throw runtimeFault("store_access_mismatch", stateMayHaveChanged);
  return value as unknown as ClaudeSessionStoreOperationAccess;
}

function storeSessionAccess(
  value: unknown,
  generation: number,
  workspaceAuthority: string,
  sessionId: string | undefined,
  stateMayHaveChanged = false
): ClaudeSessionStoreSessionAccess {
  if (!isRecord(value) || value.kind !== "session" || value.generation !== generation
    || value.workspaceAuthority !== workspaceAuthority || typeof value.sessionId !== "string"
    || !UUID.test(value.sessionId) || value.sessionId !== sessionId
    || !exactKeys(value, ["kind", "generation", "workspaceAuthority", "sessionId"])) {
    throw runtimeFault("store_access_mismatch", stateMayHaveChanged);
  }
  return value as unknown as ClaudeSessionStoreSessionAccess;
}

function storeOperationSnapshot(value: unknown, access: ClaudeSessionStoreOperationAccess): ClaudeSessionStoreOperationSnapshot {
  if (!isRecord(value) || value.operationId !== access.operationId || value.generation !== access.generation
    || value.sourceKind !== access.source.kind
    || value.sourceWorkspaceAuthority !== access.source.workspaceAuthority
    || value.sourceSessionId !== access.source.sessionId
    || value.targetWorkspaceAuthority !== access.target.workspaceAuthority
    || !["importing", "ready", "aliased", "child_pending", "child_reserved", "adopted", "cleaned"].includes(String(value.state))
    || typeof value.sourceProjectKeyCaptured !== "boolean" || typeof value.targetProjectKeyCaptured !== "boolean"
    || !Number.isSafeInteger(value.sourceEntryCount) || (value.sourceEntryCount as number) < 0
    || !Number.isSafeInteger(value.sourceBytes) || (value.sourceBytes as number) < 0
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || typeof value.childReservationConfirmed !== "boolean"
    || (value.childSessionId !== undefined && (typeof value.childSessionId !== "string" || !UUID.test(value.childSessionId)))) {
    throw runtimeFault("invalid_response", true);
  }
  return value as unknown as ClaudeSessionStoreOperationSnapshot;
}

function storeChildReservation(value: unknown, access: ClaudeSessionStoreOperationAccess): {
  readonly sessionId: string;
} {
  if (!isRecord(value) || value.operationId !== access.operationId || value.generation !== access.generation
    || value.targetWorkspaceAuthority !== access.target.workspaceAuthority
    || typeof value.sessionId !== "string" || !UUID.test(value.sessionId)
    || !exactKeys(value, ["operationId", "generation", "targetWorkspaceAuthority", "sessionId"])) {
    throw runtimeFault("callback_invalid", false);
  }
  return { sessionId: value.sessionId.toLowerCase() };
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

/** The Adapter's Target-scoped Store key; effective cwd is intentionally part of remote identity. */
function claudeWorkspaceAuthority(target: TargetDescriptor): string {
  const remote = requireRemoteBinding(target);
  if (!normalizedAbsoluteRemotePath(target.workspaceRoot)) throw runtimeFault("remote_target_invalid", false);
  const hash = createHash("sha256")
    .update("joko-claude-workspace\0", "utf8")
    .update(target.backendId, "utf8")
    .update("\0", "utf8")
    .update(target.id, "utf8")
    .update("\0", "utf8")
    .update("remote\0", "utf8")
    .update(remote.hostTargetId, "utf8")
    .update("\0", "utf8")
    .update(remote.hostId, "utf8")
    .update("\0", "utf8")
    .update(remote.workspaceRoot, "utf8")
    .update("\0", "utf8")
    .update(target.workspaceRoot, "utf8");
  return `workspace-${hash.digest("hex")}`;
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
