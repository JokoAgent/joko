import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PiMcpBridgeOptions, PiMcpToolDescriptor } from "@joko/adapter-pi";
import { validateMcpEndpoint } from "@joko/adapter-pi";
import { redactSecrets, type BlobRef, type PolicySubjectKind } from "@joko/core";
import { operationBodyHash, type OperationalStore } from "@joko/store";

import type { CredentialManager } from "./credential-manager.js";
import type {
  NativeAuthRecoveryPort,
  NativeAuthRecoverySignedRunnerEvidence,
  NativeAuthRecoverySnapshot,
  NativeAuthRecoveryRemoteRunnerEvidence,
  NativeAuthRunnerProof,
  RemoteNativeAuthRunnerAttestation
} from "./native-auth-recovery.js";
import { nativeAuthCredentialDigest, verifyRemoteNativeAuthRunnerAttestation } from "./native-auth-recovery.js";

export const MCP_BRIDGE_RESPONSE_MAXIMUM_BYTES = 2 * 1024 * 1024;
const MCP_BRIDGE_INLINE_RESULT_MAXIMUM_BYTES = 512 * 1024;
const MCP_BRIDGE_PREVIEW_MAXIMUM_BYTES = 128 * 1024;

export type McpBridgeErrorCode = "resource_exhausted" | "artifact_unavailable" | "invalid_result";

export class McpResultResourceExhaustedError extends Error {
  readonly code = "resource_exhausted" as const;

  constructor() {
    super("MCP tool result exceeds the configured Artifact capacity.");
    this.name = "McpResultResourceExhaustedError";
  }
}

export type McpServerState = "disabled" | "starting" | "connected" | "degraded" | "disconnected" | "error";

export const MCP_TOOL_DISCOVERY_DEFAULT_TIMEOUT_MS = 30_000;
export const MCP_TOOL_DISCOVERY_MAXIMUM_PAGES = 256;
export const MCP_TOOL_DISCOVERY_MAXIMUM_TOOLS = 10_000;
export const MCP_TOOL_DISCOVERY_MAXIMUM_BYTES = 16 * 1024 * 1024;

export type McpToolDiscoveryErrorCode =
  | "aborted"
  | "timed_out"
  | "invalid_page"
  | "pagination_cycle"
  | "page_limit"
  | "tool_limit"
  | "catalog_too_large";

export class McpToolDiscoveryError extends Error {
  constructor(readonly code: McpToolDiscoveryErrorCode, message: string) {
    super(message);
    this.name = "McpToolDiscoveryError";
  }
}

export interface McpCredentialBinding {
  readonly target: "header" | "environment";
  readonly name: string;
  readonly credentialReferenceId: string;
}

interface McpServerBase {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly credentialBindings: readonly McpCredentialBinding[];
}

export interface McpStdioServerInput extends McpServerBase {
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Non-secret environment only. Secret values must use credentialBindings. */
  readonly environment?: Readonly<Record<string, string>>;
}

export interface McpHttpServerInput extends McpServerBase {
  readonly transport: "streamable_http";
  readonly endpoint: string;
}

export type McpServerInput = McpStdioServerInput | McpHttpServerInput;

export interface McpToolDescriptor {
  readonly serverId: string;
  readonly name: string;
  /** Service-owned direct runtime name; absent for every user MCP server. */
  readonly runtimeName?: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly requiresPermission: boolean;
}

export interface McpServerDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly transport: McpServerInput["transport"];
  readonly endpointDisplay: string;
  readonly enabled: boolean;
  readonly state: McpServerState;
  readonly runtimeGeneration: number;
  readonly tools: readonly McpToolDescriptor[];
  readonly credentialBindings: readonly (McpCredentialBinding & { readonly configured: boolean })[];
  readonly configuration:
    | {
      readonly case: "stdio";
      readonly command: string;
      readonly arguments: readonly string[];
      readonly workingDirectory: string;
      readonly environment: Readonly<Record<string, string>>;
    }
    | { readonly case: "streamableHttp"; readonly endpoint: string };
  readonly version: bigint;
  readonly updatedAt: number;
  readonly error?: string;
  readonly errorCode?: McpToolDiscoveryErrorCode;
}

export interface McpCallResult {
  readonly content: readonly unknown[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
}

/** Binary outputs created by an in-process service provider, never accepted from remote MCP. */
export interface BridgeToolImageOutput {
  readonly blob: BlobRef;
  readonly alt?: string;
}

export interface BridgeToolCallResult extends McpCallResult {
  readonly hostImages?: readonly BridgeToolImageOutput[];
}

export interface McpListedTool {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
    readonly outputSchema?: Readonly<Record<string, unknown>>;
    readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean };
}

export interface McpToolListPage {
  readonly tools: readonly McpListedTool[];
  readonly nextCursor?: string;
}

export interface McpClientConnection {
  listTools(cursor?: string, signal?: AbortSignal): Promise<McpToolListPage>;
  callTool(name: string, arguments_: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface McpClientFactoryInput {
  readonly config: McpServerInput;
  readonly generation: number;
  readonly credentials: Readonly<Record<string, string>>;
  readonly onClose: () => void;
  readonly onError: (error: Error) => void;
}

export interface McpClientFactory {
  connect(input: McpClientFactoryInput): Promise<McpClientConnection>;
}

/** Narrow Artifact capability required by the MCP bridge. */
export interface McpResultArtifactStore {
  readonly maximumBlobBytes: number;
  ingestBytes(
    bytes: Uint8Array,
    options?: { readonly fileName?: string; readonly mimeType?: string; readonly expiresAt?: number }
  ): Promise<BlobRef>;
}

/**
 * A service-owned Tool Provider exposed through the same authenticated,
 * generation-fenced Pi bridge as MCP without being persisted as user MCP
 * configuration. The provider remains responsible for its own lifecycle.
 */
export interface BridgeToolProvider {
  readonly id: string;
  readonly generation: number;
  readonly available: boolean;
  /** Capability-neutral subject applied to this Provider's full Tool snapshot. */
  readonly policySubject?: PolicySubjectKind;
  /** Provider-owned declaration for ordinary user/project availability policy. */
  readonly configurablePolicy?: BridgeToolPolicyDeclaration;
  /** False omits this Provider only from newly-created Pi snapshots. */
  readonly includeInSnapshot?: boolean;
  /** Optional product-scope gate sampled only when one new Target runtime is frozen. */
  includeForTarget?(targetId: string): boolean;
  readonly tools: readonly McpToolDescriptor[];
  callTool(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    context: BridgeToolCallContext
  ): Promise<BridgeToolCallResult>;
}

export interface BridgeToolPolicyDeclaration {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly productDefaultEnabled: boolean;
  readonly localizations?: Readonly<Record<string, {
    readonly displayName: string;
    readonly description: string;
  }>>;
}

/** Product scope authenticated from the durable Session binding, never from tool arguments. */
export interface BridgeToolCallContext {
  readonly sessionId: string;
  readonly targetId: string;
  readonly generation: number;
  readonly providerGeneration?: number;
  /** Grant-bound digest of the native tool-call identity; the raw ID is never forwarded. */
  readonly requestIdentity?: string;
  /** Digest binding the request identity to its canonical authenticated body. */
  readonly effectIdentity?: string;
  readonly requestBodyHash?: string;
}

interface StoredMcpServer {
  readonly input: McpServerInput;
  readonly generation: number;
  readonly version: string;
  readonly updatedAt: number;
}

interface StoredMcpCatalog {
  readonly format: 1;
  readonly lastGeneration: number;
  readonly servers: readonly StoredMcpServer[];
}

interface Runtime {
  readonly serverId: string;
  readonly generation: number;
  readonly connection: McpClientConnection;
  readonly tools: readonly McpToolDescriptor[];
  state: McpServerState;
  error?: string;
}

interface BridgeGrant {
  readonly digest: Buffer;
  /** Stable digest of immutable grant authority; excludes bearer material and expiry. */
  readonly authorityDigest: Buffer;
  readonly serverGenerations: ReadonlyMap<string, number>;
  readonly tools: readonly PiMcpToolDescriptor[];
  readonly expectedPiGeneration?: number;
  readonly productScope?: {
    readonly sessionId: string;
    readonly targetId: string;
  };
  readonly nativeAuth?: {
    readonly catalogGeneration: number;
    readonly providerIds: ReadonlySet<string>;
    readonly authenticatedProviderIds: ReadonlySet<string>;
    /** Digest of a parent-extension-only reservation authority. */
    readonly launchAuthorityDigest?: Buffer;
    readonly leases: Map<string, NativeAuthLease>;
  };
  expiresAt: number;
}

interface NativeAuthLease {
  readonly runId: string;
  readonly runnerFence: string;
  readonly providerId: string;
  readonly accountId: string;
  authGeneration: string;
  readonly catalogGeneration: number;
  sourceCatalogGeneration: number;
  refreshPending: boolean;
  refreshSuperseded: boolean;
  release?: Promise<PiNativeAuthLeaseResult>;
  expiresAt: number;
}

interface DetachedNativeAuthLease {
  readonly digest: Buffer;
  readonly sessionId: string;
  readonly targetId: string;
  readonly generation: number;
  readonly runnerProductGeneration: number;
  readonly providerId: string;
  readonly catalogGeneration: number;
  readonly runId: string;
  readonly runnerFence: string;
  readonly owner: NonNullable<BridgeGrant["nativeAuth"]>;
  readonly lease: NativeAuthLease;
  recoveryId?: string;
  recoveryProof?: string;
  released: boolean;
  expiresAt: number;
}

interface NormalizedMcpResult {
  readonly value: McpCallResult;
  readonly bytes: Uint8Array;
}

export interface McpBridgeCallResult {
  readonly content: readonly unknown[];
  readonly details?: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
  readonly error?: string;
  readonly errorCode?: McpBridgeErrorCode;
}

export interface PiMcpBridgeSnapshot {
  readonly mcpBridge: PiMcpBridgeOptions;
  readonly expiresAt: number;
  /** Extend this exact immutable grant without changing its token or tool snapshot. */
  renew(ttlMs?: number): number;
  revoke(): void;
}

export interface McpRouterOptions {
  readonly store: OperationalStore;
  readonly credentials: CredentialManager;
  readonly resultArtifacts?: McpResultArtifactStore;
  readonly clientFactory?: McpClientFactory;
  readonly scopeId?: string;
  readonly now?: () => number;
  readonly bridgeGrantTtlMs?: number;
  readonly nativeAuthLeaseTtlMs?: number;
  readonly nativeAuth?: PiNativeAuthLeaseSource;
  readonly nativeAuthRecovery?: NativeAuthRecoveryPort;
  readonly trustedManagedRunnerScriptSha256?: string;
  readonly toolDiscoveryPolicy?: Partial<McpToolDiscoveryPolicy>;
}

/**
 * In-process sealed-vault join used only by the authenticated loopback lease
 * route. Account identity and credential generations never cross the route.
 */
export interface PiNativeAuthLeaseSource {
  describe(providerId: string): {
    readonly accountId: string;
    readonly authGeneration: string;
    readonly catalogGeneration: number;
    readonly authenticated: boolean;
  };
  load(input: {
    readonly providerIds: readonly string[];
    readonly expectedCatalogGeneration: number;
  }): {
    readonly catalogGeneration: number;
    readonly credentials: Readonly<Record<string, unknown>>;
  };
  persist(input: {
    readonly providerId: string;
    readonly credential: unknown;
    readonly expectedCatalogGeneration: number;
    readonly expectedAccountId: string;
  }): Promise<unknown>;
}

export interface PiNativeAuthLeaseResult {
  readonly active: boolean;
  /** Relative lease lifetime for the runner's own monotonic clock. */
  readonly validForMs?: number;
  readonly credential?: unknown;
  /** Returned only once to the trusted managed runner and never persisted raw. */
  readonly recoveryProof?: string;
}

export interface McpToolDiscoveryPolicy {
  readonly timeoutMs: number;
  readonly maximumPages: number;
  readonly maximumTools: number;
  readonly maximumBytes: number;
}

const DEFAULT_MCP_TOOL_DISCOVERY_POLICY: McpToolDiscoveryPolicy = {
  timeoutMs: MCP_TOOL_DISCOVERY_DEFAULT_TIMEOUT_MS,
  maximumPages: MCP_TOOL_DISCOVERY_MAXIMUM_PAGES,
  maximumTools: MCP_TOOL_DISCOVERY_MAXIMUM_TOOLS,
  maximumBytes: MCP_TOOL_DISCOVERY_MAXIMUM_BYTES
};

/**
 * Supervises MCP transports and keeps each Pi bridge token pinned to a complete
 * server-generation/tool snapshot. Updating an MCP server never retargets an
 * already running Pi process to a newer server generation.
 */
export class McpRouter {
  readonly #store: OperationalStore;
  readonly #credentials: CredentialManager;
  readonly #resultArtifacts: McpResultArtifactStore | undefined;
  readonly #factory: McpClientFactory;
  readonly #scopeId: string;
  readonly #now: () => number;
  readonly #resultCapacityBytes: number;
  readonly #bridgeGrantTtlMs: number;
  readonly #nativeAuthLeaseTtlMs: number;
  readonly #nativeAuth: PiNativeAuthLeaseSource | undefined;
  readonly #nativeAuthRecovery: NativeAuthRecoveryPort | undefined;
  readonly #trustedManagedRunnerScriptSha256: string | undefined;
  readonly #toolDiscoveryPolicy: McpToolDiscoveryPolicy;
  readonly #servers = new Map<string, StoredMcpServer>();
  readonly #runtimes = new Map<string, Map<number, Runtime>>();
  readonly #states = new Map<string, {
    readonly state: McpServerState;
    readonly generation: number;
    readonly error?: string;
    readonly errorCode?: McpToolDiscoveryErrorCode;
  }>();
  readonly #grants = new Map<string, BridgeGrant>();
  /**
   * A detached child owns its short native-auth lease independently of the
   * parent Pi runtime's ordinary MCP grant. Keeping only the bearer digest and
   * exact product/runner fences here lets the parent runtime release its tool
   * snapshot without revoking an already-running child or extending ordinary
   * MCP authority.
   */
  readonly #detachedNativeAuthLeases = new Map<string, Map<string, DetachedNativeAuthLease>>();
  readonly #recoveryNativeAuthLeases = new Map<string, DetachedNativeAuthLease>();
  readonly #nativeAuthReleaseTails = new Map<string, Promise<void>>();
  readonly #remoteAttestationNonces = new Map<string, number>();
  readonly #bridgeToolProviders = new Map<string, BridgeToolProvider>();
  #lastGeneration = 0;
  #initialized = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: McpRouterOptions) {
    this.#store = options.store;
    this.#credentials = options.credentials;
    this.#resultArtifacts = options.resultArtifacts;
    this.#factory = options.clientFactory ?? new SdkMcpClientFactory();
    this.#scopeId = options.scopeId ?? "orchestrator";
    this.#now = options.now ?? Date.now;
    this.#resultCapacityBytes = options.resultArtifacts?.maximumBlobBytes ?? 256 * 1024 * 1024;
    this.#bridgeGrantTtlMs = options.bridgeGrantTtlMs ?? 24 * 60 * 60_000;
    this.#nativeAuthLeaseTtlMs = options.nativeAuthLeaseTtlMs ?? 15_000;
    this.#nativeAuth = options.nativeAuth;
    this.#nativeAuthRecovery = options.nativeAuthRecovery;
    this.#trustedManagedRunnerScriptSha256 = options.trustedManagedRunnerScriptSha256;
    this.#toolDiscoveryPolicy = {
      ...DEFAULT_MCP_TOOL_DISCOVERY_POLICY,
      ...options.toolDiscoveryPolicy
    };
    if (!Number.isSafeInteger(this.#resultCapacityBytes) || this.#resultCapacityBytes < 1) {
      throw new RangeError("MCP Artifact capacity is invalid.");
    }
    if (!Number.isSafeInteger(this.#bridgeGrantTtlMs) || this.#bridgeGrantTtlMs < 1_000) throw new RangeError("MCP bridge grant lifetime is invalid.");
    if (!Number.isSafeInteger(this.#nativeAuthLeaseTtlMs) || this.#nativeAuthLeaseTtlMs < 1_000 || this.#nativeAuthLeaseTtlMs > 60_000) {
      throw new RangeError("Native auth lease lifetime is invalid.");
    }
    if (this.#nativeAuthRecovery !== undefined
        && !/^[0-9a-f]{64}$/u.test(this.#trustedManagedRunnerScriptSha256 ?? "")) {
      throw new RangeError("Managed runner trust anchor is invalid.");
    }
    validateToolDiscoveryPolicy(this.#toolDiscoveryPolicy);
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await this.#nativeAuthRecovery?.initialize();
    const stored = this.#store.findSetting<StoredMcpCatalog>("service", this.#scopeId, "mcp_catalog");
    if (stored !== undefined) {
      if (stored.value.format !== 1 || !Array.isArray(stored.value.servers) || !Number.isSafeInteger(stored.value.lastGeneration)) {
        throw new Error("MCP catalog setting has an unsupported format.");
      }
      this.#lastGeneration = stored.value.lastGeneration;
      for (const raw of stored.value.servers) {
        const server = validateStoredServer(raw);
        await validateServerInput(server.input);
        if (this.#servers.has(server.input.id)) throw new Error("MCP catalog contains duplicate server IDs.");
        this.#servers.set(server.input.id, server);
        this.#states.set(server.input.id, {
          state: server.input.enabled ? "disconnected" : "disabled",
          generation: server.generation
        });
      }
    }
    this.#initialized = true;
    await Promise.all([...this.#servers.values()].filter((server) => server.input.enabled).map(async (server) => {
      try { await this.#start(server); } catch { /* State retains the redacted error. */ }
    }));
  }

  list(state?: McpServerState): readonly McpServerDescriptor[] {
    this.#assertInitialized();
    return [...this.#servers.values()]
      .map((server) => this.#descriptor(server))
      .filter((server) => state === undefined || server.state === state)
      .sort((left, right) => left.displayName.localeCompare(right.displayName, "en") || left.id.localeCompare(right.id, "en"));
  }

  get(serverId: string): McpServerDescriptor {
    this.#assertInitialized();
    return this.#descriptor(this.#requireServer(serverId));
  }

  /** Register an in-process Tool Provider without persisting it as MCP configuration. */
  registerBridgeToolProvider(provider: BridgeToolProvider): () => void {
    this.#assertInitialized();
    nonBlank(provider.id, "Bridge Tool Provider ID");
    if (this.#servers.has(provider.id) || this.#bridgeToolProviders.has(provider.id)) {
      throw new Error("Bridge Tool Provider ID collides with an existing provider.");
    }
    if (provider.tools.some((tool) => tool.serverId !== provider.id)) {
      throw new Error("Bridge Tool descriptor uses a different provider ID.");
    }
    const duplicate = duplicateToolName(provider.tools);
    if (duplicate !== undefined) throw new Error(`Bridge Tool Provider advertised duplicate tool '${duplicate}'.`);
    if (provider.configurablePolicy !== undefined) {
      validateBridgeToolPolicyDeclaration(provider.configurablePolicy);
      const conflicting = [...this.#bridgeToolProviders.values()]
        .map((candidate) => candidate.configurablePolicy)
        .find((candidate) => candidate?.id === provider.configurablePolicy?.id);
      if (conflicting !== undefined && !sameBridgeToolPolicyDeclaration(conflicting, provider.configurablePolicy)) {
        throw new Error("Bridge Tool Providers declared conflicting policy metadata.");
      }
    }
    this.#bridgeToolProviders.set(provider.id, provider);
    return () => {
      if (this.#bridgeToolProviders.get(provider.id) !== provider) return;
      this.#bridgeToolProviders.delete(provider.id);
      for (const [key, grant] of this.#grants) {
        if (grant.serverGenerations.has(provider.id)) this.#grants.delete(key);
      }
    };
  }

  /** Provider-owned ordinary policy catalog; machine lifecycle tools do not declare entries. */
  toolPolicyDeclarations(): readonly BridgeToolPolicyDeclaration[] {
    this.#assertInitialized();
    const declarations = new Map<string, BridgeToolPolicyDeclaration>();
    for (const provider of this.#bridgeToolProviders.values()) {
      const declaration = provider.configurablePolicy;
      if (declaration !== undefined && !declarations.has(declaration.id)) declarations.set(declaration.id, declaration);
    }
    return [...declarations.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName, "en") || left.id.localeCompare(right.id, "en"));
  }

  async upsert(input: McpServerInput, expectedVersion?: bigint): Promise<McpServerDescriptor> {
    this.#assertInitialized();
    await validateServerInput(input);
    if (this.#bridgeToolProviders.has(input.id)) throw new Error("MCP server ID is reserved by a service Tool Provider.");
    return this.#mutate(async () => {
      const existing = this.#servers.get(input.id);
      if (expectedVersion !== undefined && existing !== undefined && BigInt(existing.version) !== expectedVersion) {
        throw new Error("MCP server changed concurrently.");
      }
      if (expectedVersion !== undefined && existing === undefined && expectedVersion !== 0n) throw new Error("MCP server does not exist at the expected version.");
      const generation = ++this.#lastGeneration;
      const next: StoredMcpServer = {
        input: cloneServerInput(input),
        generation,
        version: ((existing === undefined ? 0n : BigInt(existing.version)) + 1n).toString(10),
        updatedAt: this.#now()
      };
      this.#servers.set(input.id, next);
      this.#states.set(input.id, { state: input.enabled ? "starting" : "disabled", generation });
      try {
        this.#persist();
      } catch (error) {
        if (existing === undefined) {
          this.#servers.delete(input.id);
          this.#states.delete(input.id);
        } else {
          this.#servers.set(input.id, existing);
          this.#states.set(input.id, this.#stateForRuntime(existing));
        }
        this.#lastGeneration -= 1;
        throw error;
      }
      if (input.enabled) {
        try { await this.#start(next); } catch { /* return durable error state */ }
      }
      await this.#retireUnused(input.id);
      return this.#descriptor(next);
    });
  }

  async restart(serverId: string): Promise<McpServerDescriptor> {
    this.#assertInitialized();
    return this.#mutate(async () => {
      const current = this.#requireServer(serverId);
      if (!current.input.enabled) throw new Error("Disabled MCP server cannot be restarted.");
      const next: StoredMcpServer = {
        ...current,
        generation: ++this.#lastGeneration,
        version: (BigInt(current.version) + 1n).toString(10),
        updatedAt: this.#now()
      };
      this.#servers.set(serverId, next);
      this.#states.set(serverId, { state: "starting", generation: next.generation });
      this.#persist();
      try { await this.#start(next); } catch { /* descriptor contains failure */ }
      await this.#retireUnused(serverId);
      return this.#descriptor(next);
    });
  }

  async delete(serverId: string): Promise<boolean> {
    this.#assertInitialized();
    return this.#mutate(async () => {
      const existing = this.#servers.get(serverId);
      if (existing === undefined) return false;
      this.#servers.delete(serverId);
      this.#states.delete(serverId);
      this.#lastGeneration += 1;
      try { this.#persist(); } catch (error) {
        this.#lastGeneration -= 1;
        this.#servers.set(serverId, existing);
        this.#states.set(serverId, this.#stateForRuntime(existing));
        throw error;
      }
      // Deletion changes the catalog used by future snapshots. Existing
      // generation grants continue to own their exact server runtime until
      // their Pi runtime releases the grant.
      await this.#retireUnused(serverId);
      return true;
    });
  }

  async discoverTools(serverId: string, expectedGeneration?: number): Promise<readonly McpToolDescriptor[]> {
    this.#assertInitialized();
    const server = this.#requireServer(serverId);
    const generation = expectedGeneration ?? server.generation;
    const runtime = this.#requireRuntime(serverId, generation);
    return runtime.tools;
  }

  async callTool(input: {
    readonly serverId: string;
    readonly toolName: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
    readonly expectedGeneration?: number;
    readonly signal?: AbortSignal;
  }): Promise<McpCallResult> {
    this.#assertInitialized();
    // A deleted or replaced catalog entry must not invalidate an immutable
    // bridge snapshot that is still referenced by a live Pi runtime.
    const generation = input.expectedGeneration ?? this.#requireServer(input.serverId).generation;
    const runtime = this.#requireRuntime(input.serverId, generation);
    if (!runtime.tools.some((tool) => tool.name === input.toolName)) throw new Error("MCP tool is not part of the fenced discovery snapshot.");
    const result = await runtime.connection.callTool(input.toolName, input.arguments ?? {}, input.signal);
    return this.#normalizeResult(result, "MCP tool result").value;
  }

  createPiBridgeSnapshot(input: {
    readonly endpoint: string;
    readonly sessionId?: string;
    readonly targetId?: string;
    readonly expectedPiGeneration?: number;
    readonly ttlMs?: number;
    readonly nativeAuthLease?: {
      readonly endpoint: string;
      readonly catalogGeneration: number;
      readonly providerIds: readonly string[];
      readonly authenticatedProviderIds: readonly string[];
    };
    /** Session-frozen ordinary policy resolver. Product defaults apply when omitted. */
    readonly includeToolPolicy?: (policyId: string) => boolean;
  }): PiMcpBridgeSnapshot {
    this.#assertInitialized();
    validateMcpEndpoint(input.endpoint);
    if (input.expectedPiGeneration !== undefined && (!Number.isSafeInteger(input.expectedPiGeneration) || input.expectedPiGeneration < 0)) {
      throw new Error("Pi runtime generation fence is invalid.");
    }
    if (input.sessionId !== undefined && input.targetId === undefined) {
      throw new Error("Pi MCP bridge Session scope requires a Target.");
    }
    if (input.sessionId !== undefined && !boundedBridgeIdentity(input.sessionId)) {
      throw new Error("Pi MCP bridge Session scope is invalid.");
    }
    if (input.targetId !== undefined && !boundedBridgeIdentity(input.targetId)) {
      throw new Error("Pi MCP bridge Target scope is invalid.");
    }
    this.#purgeGrants();
    let nativeAuth: BridgeGrant["nativeAuth"];
    let nativeAuthReservationToken: string | undefined;
    if (input.nativeAuthLease !== undefined) {
      if (this.#nativeAuth === undefined) throw new Error("Native auth lease source is unavailable.");
      validateMcpEndpoint(input.nativeAuthLease.endpoint);
      if (!Number.isSafeInteger(input.nativeAuthLease.catalogGeneration) || input.nativeAuthLease.catalogGeneration < 0) {
        throw new Error("Native auth lease catalog generation is invalid.");
      }
      const providerIds = normalizedProviderIds(input.nativeAuthLease.providerIds, "Native auth lease Provider allowlist");
      const authenticatedProviderIds = normalizedProviderIds(
        input.nativeAuthLease.authenticatedProviderIds,
        "Native auth lease authenticated Provider allowlist"
      );
      if ([...authenticatedProviderIds].some((providerId) => !providerIds.has(providerId))) {
        throw new Error("Native auth lease authenticated Provider allowlist escaped its Provider snapshot.");
      }
      nativeAuthReservationToken = randomBytes(32).toString("base64url");
      nativeAuth = {
        catalogGeneration: input.nativeAuthLease.catalogGeneration,
        providerIds,
        authenticatedProviderIds,
        launchAuthorityDigest: digestToken(nativeAuthReservationToken),
        leases: new Map()
      };
    }
    const serverGenerations = new Map<string, number>();
    const tools: PiMcpToolDescriptor[] = [];
    for (const server of this.#servers.values()) {
      if (!server.input.enabled) continue;
      const runtime = this.#runtime(server.input.id, server.generation);
      if (runtime === undefined || runtime.state !== "connected") continue;
      serverGenerations.set(server.input.id, server.generation);
      for (const tool of runtime.tools) tools.push({
        serverId: tool.serverId,
        name: tool.name,
        policySubject: "mcp",
        description: tool.description,
        inputSchema: tool.inputSchema,
        requiresPermission: tool.requiresPermission
      });
    }
    for (const provider of this.#bridgeToolProviders.values()) {
      if (!provider.available || provider.includeInSnapshot === false) continue;
      if (provider.configurablePolicy !== undefined) {
        const enabled = input.includeToolPolicy?.(provider.configurablePolicy.id)
          ?? provider.configurablePolicy.productDefaultEnabled;
        if (!enabled) continue;
      }
      if (provider.includeForTarget !== undefined
        && (input.targetId === undefined || !provider.includeForTarget(input.targetId))) continue;
      if (!Number.isSafeInteger(provider.generation) || provider.generation < 1) {
        throw new Error("Bridge Tool Provider generation is invalid.");
      }
      serverGenerations.set(provider.id, provider.generation);
      for (const tool of provider.tools) tools.push({
        serverId: tool.serverId,
        name: tool.name,
        ...(tool.runtimeName === undefined ? {} : { runtimeName: tool.runtimeName }),
        policySubject: provider.policySubject ?? "mcp",
        description: tool.description,
        inputSchema: tool.inputSchema,
        requiresPermission: tool.requiresPermission
      });
    }
    tools.sort((left, right) => left.serverId.localeCompare(right.serverId, "en") || left.name.localeCompare(right.name, "en"));
    const token = randomBytes(32).toString("base64url");
    const digest = digestToken(token);
    const ttl = input.ttlMs ?? this.#bridgeGrantTtlMs;
    if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > this.#bridgeGrantTtlMs) throw new Error("MCP bridge snapshot lifetime is invalid.");
    const expiresAt = this.#now() + ttl;
    const key = digest.toString("hex");
    const productScope = input.sessionId === undefined || input.targetId === undefined
      ? undefined
      : { sessionId: input.sessionId, targetId: input.targetId };
    const authorityDigest = bridgeGrantAuthorityDigest({
      expectedPiGeneration: input.expectedPiGeneration,
      productScope,
      serverGenerations,
      tools,
      nativeAuth
    });
    const grant: BridgeGrant = {
      digest,
      authorityDigest,
      serverGenerations,
      tools,
      ...(input.expectedPiGeneration === undefined ? {} : { expectedPiGeneration: input.expectedPiGeneration }),
      ...(productScope === undefined ? {} : { productScope }),
      ...(nativeAuth === undefined ? {} : { nativeAuth }),
      expiresAt
    };
    this.#grants.set(key, grant);
    const snapshot: PiMcpBridgeSnapshot = {
      mcpBridge: {
        endpoint: input.endpoint,
        token,
        tools,
        ...(nativeAuthReservationToken === undefined ? {} : { nativeAuthReservationToken }),
        ...(input.nativeAuthLease === undefined ? {} : {
          nativeAuthLease: {
            endpoint: input.nativeAuthLease.endpoint,
            catalogGeneration: input.nativeAuthLease.catalogGeneration,
            providerIds: [...input.nativeAuthLease.providerIds],
            authenticatedProviderIds: [...input.nativeAuthLease.authenticatedProviderIds]
          }
        })
      },
      get expiresAt() { return grant.expiresAt; },
      renew: (renewalTtlMs?: number) => {
        const current = this.#grants.get(key);
        if (current !== grant) throw new Error("MCP bridge grant is revoked.");
        const renewalTtl = renewalTtlMs ?? this.#bridgeGrantTtlMs;
        if (!Number.isSafeInteger(renewalTtl) || renewalTtl < 1_000 || renewalTtl > this.#bridgeGrantTtlMs) {
          throw new Error("MCP bridge renewal lifetime is invalid.");
        }
        current.expiresAt = this.#now() + renewalTtl;
        return current.expiresAt;
      },
      revoke: () => {
        this.#grants.delete(key);
        void this.#retireAllUnused();
      }
    };
    return snapshot;
  }

  /** Adapter-facing authenticated bridge executor; suitable for a loopback POST handler. */
  async executeBridgeCall(input: {
    readonly authorization: string | undefined;
    readonly requestId: string;
    readonly generation: number;
    readonly sessionId: string;
    readonly targetId: string;
    readonly serverId: string;
    readonly toolName: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<McpBridgeCallResult> {
    this.#assertInitialized();
    const token = bearerToken(input.authorization);
    const grant = this.#findGrant(token);
    if (!boundedBridgeRequestId(input.requestId)) throw new Error("Pi MCP bridge request identity is invalid.");
    if (grant.expectedPiGeneration !== undefined && grant.expectedPiGeneration !== input.generation) throw new Error("Pi MCP bridge generation is stale.");
    if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new Error("Pi MCP bridge generation is invalid.");
    if (grant.productScope !== undefined && (
      grant.productScope.sessionId !== input.sessionId || grant.productScope.targetId !== input.targetId
    )) throw new Error("Pi MCP bridge grant belongs to another product scope.");
    const session = this.#store.getSession(input.sessionId).descriptor;
    if (
      session.targetId !== input.targetId ||
      session.binding.generation !== input.generation ||
      session.archived ||
      session.deletedAt !== undefined ||
      this.#store.findPendingSessionLifecycleCleanup(input.sessionId) !== undefined
    ) {
      throw new Error("Pi MCP bridge product scope is stale or mismatched.");
    }
    const serverGeneration = grant.serverGenerations.get(input.serverId);
    if (serverGeneration === undefined) throw new Error("MCP server is not present in this Pi runtime snapshot.");
    if (!grant.tools.some((tool) => tool.serverId === input.serverId && tool.name === input.toolName)) {
      throw new Error("MCP tool is not present in this Pi runtime snapshot.");
    }
    try {
      const bridgeProvider = this.#bridgeToolProviders.get(input.serverId);
      if (bridgeProvider?.policySubject === "browser" && grant.productScope === undefined) {
        throw new Error("Browser bridge grant is missing its product scope.");
      }
      const requestBodyHash = operationBodyHash({
        arguments: input.arguments ?? {},
        generation: input.generation,
        serverId: input.serverId,
        sessionId: input.sessionId,
        targetId: input.targetId,
        toolName: input.toolName
      });
      const requestIdentity = bridgeRequestIdentity(grant.authorityDigest, input.requestId);
      const effectIdentity = bridgeEffectIdentity(requestIdentity, requestBodyHash);
      let result: McpCallResult;
      let hostImages: readonly BridgeToolImageOutput[] = [];
      if (bridgeProvider === undefined) {
        result = await this.callTool({
            serverId: input.serverId,
            toolName: input.toolName,
            arguments: input.arguments ?? {},
            expectedGeneration: serverGeneration,
            ...(input.signal === undefined ? {} : { signal: input.signal })
          });
      } else {
        const execution = await this.#callBridgeToolProvider(
            bridgeProvider,
            serverGeneration,
            input.toolName,
            input.arguments ?? {},
            input.signal,
            {
              sessionId: input.sessionId,
              targetId: input.targetId,
              generation: input.generation,
              providerGeneration: serverGeneration,
              requestIdentity,
              effectIdentity,
              requestBodyHash
            }
          );
        result = execution.result;
        hostImages = execution.hostImages;
      }
      return await this.#projectBridgeResult(result, input.serverId, input.toolName, hostImages);
    } catch (error) {
      const errorCode = mcpBridgeErrorCode(error);
      return {
        content: [],
        isError: true,
        error: this.#redactedError(error),
        ...(errorCode === undefined ? {} : { errorCode })
      };
    }
  }

  async dispose(): Promise<void> {
    this.#grants.clear();
    this.#detachedNativeAuthLeases.clear();
    this.#recoveryNativeAuthLeases.clear();
    this.#nativeAuthReleaseTails.clear();
    this.#remoteAttestationNonces.clear();
    this.#bridgeToolProviders.clear();
    const runtimes = [...this.#runtimes.values()].flatMap((group) => [...group.values()]);
    this.#runtimes.clear();
    this.#states.clear();
    await Promise.allSettled(runtimes.map((runtime) => runtime.connection.close()));
  }

  /**
   * Fail-closed Session deletion boundary. The caller must first stop the
   * exact managed runners; this operation then removes only native-auth lease
   * metadata and in-memory snapshots. It never requires or returns raw proof.
   */
  async revokeNativeAuthSession(input: {
    readonly sessionId: string;
    readonly targetId: string;
  }): Promise<void> {
    this.#assertInitialized();
    if (input.sessionId.trim() === "" || input.targetId.trim() === "") {
      throw new Error("Pi native auth Session revocation scope is invalid.");
    }
    const candidates = new Set<DetachedNativeAuthLease>();
    for (const byRun of this.#detachedNativeAuthLeases.values()) {
      for (const detached of byRun.values()) {
        if (detached.sessionId === input.sessionId && detached.targetId === input.targetId) candidates.add(detached);
      }
    }
    for (const detached of this.#recoveryNativeAuthLeases.values()) {
      if (detached.sessionId === input.sessionId && detached.targetId === input.targetId) candidates.add(detached);
    }
    const accounts = new Map<string, DetachedNativeAuthLease[]>();
    for (const detached of candidates) {
      const key = `${detached.lease.providerId}\0${detached.lease.accountId}`;
      const group = accounts.get(key) ?? [];
      group.push(detached);
      accounts.set(key, group);
    }
    for (const [accountKey, group] of accounts) {
      await this.#withNativeAuthAccountLock(accountKey, async () => {
        for (const detached of group) {
          detached.released = true;
          this.#expireDetachedNativeAuthLease(detached);
        }
      });
    }
    await this.#nativeAuthRecovery?.revokeScope(input);
  }

  async reserveNativeAuthRunner(input: {
    readonly authorization: string | undefined;
    readonly launchAuthorization: string | undefined;
    readonly generation: number;
    readonly runnerProductGeneration: number;
    readonly sessionId: string;
    readonly targetId: string;
    readonly providerId: string;
    readonly catalogGeneration: number;
    readonly runId: string;
    readonly runnerFence: string;
    readonly publicKey: string;
  }): Promise<{
    readonly reserved: true;
    readonly reservationId: string;
    readonly serviceGeneration: number;
    readonly validForMs: number;
  }> {
    this.#assertInitialized();
    const token = bearerToken(input.authorization);
    if (!Number.isSafeInteger(input.generation) || input.generation < 0
        || !Number.isSafeInteger(input.runnerProductGeneration) || input.runnerProductGeneration < 0
        || !Number.isSafeInteger(input.catalogGeneration) || input.catalogGeneration < 0
        || !isLeaseUuid(input.runId) || !isLeaseUuid(input.runnerFence)) {
      throw new Error("Pi native auth runner reservation scope is invalid.");
    }
    const recovery = this.#nativeAuthRecovery;
    if (recovery === undefined) throw new Error("Pi native auth recovery is unavailable.");
    const session = this.#store.getSession(input.sessionId).descriptor;
    if (session.targetId !== input.targetId || session.binding.generation !== input.generation) {
      throw new Error("Pi native auth runner reservation product scope is stale or mismatched.");
    }
    const grant = this.#findGrant(token);
    if (grant.expectedPiGeneration !== undefined && grant.expectedPiGeneration !== input.generation) {
      throw new Error("Pi native auth runner reservation generation is stale.");
    }
    const nativeAuth = grant.nativeAuth;
    const launchAuthority = input.launchAuthorization;
    const launchAuthorityDigest = typeof launchAuthority === "string" && /^[A-Za-z0-9_-]{43}$/u.test(launchAuthority)
      ? digestToken(launchAuthority)
      : undefined;
    if (nativeAuth === undefined || input.catalogGeneration !== nativeAuth.catalogGeneration
        || !nativeAuth.providerIds.has(input.providerId)
        || !nativeAuth.authenticatedProviderIds.has(input.providerId)
        || nativeAuth.launchAuthorityDigest === undefined || launchAuthorityDigest === undefined
        || nativeAuth.launchAuthorityDigest.byteLength !== launchAuthorityDigest.byteLength
        || !timingSafeEqual(nativeAuth.launchAuthorityDigest, launchAuthorityDigest)) {
      throw new Error("Pi native auth runner reservation is outside this runtime snapshot.");
    }
    const now = this.#now();
    const reserved = await recovery.reserve({
      sessionId: input.sessionId,
      targetId: input.targetId,
      serviceGeneration: input.generation,
      runnerProductGeneration: input.runnerProductGeneration,
      providerId: input.providerId,
      catalogGeneration: input.catalogGeneration,
      runId: input.runId,
      runnerFence: input.runnerFence,
      publicKey: input.publicKey,
      expiresAt: now + this.#nativeAuthLeaseTtlMs
    });
    return {
      reserved: true,
      reservationId: reserved.reservationId,
      serviceGeneration: input.generation,
      validForMs: Math.max(1, reserved.expiresAt - now)
    };
  }

  /** Credential-bearing responses are returned only to trusted Pi runners. */
  async executeNativeAuthLease(input: {
    readonly authorization: string | undefined;
    readonly action: "acquire" | "validate" | "release";
    readonly generation: number;
    readonly runnerProductGeneration: number;
    readonly sessionId: string;
    readonly targetId: string;
    readonly providerId: string;
    readonly catalogGeneration: number;
    readonly runId: string;
    readonly runnerFence: string;
    readonly credential?: unknown;
    readonly recoveryProof?: string;
    readonly recovery?: {
      readonly runnerPid: number;
    };
    readonly runnerProof?: NativeAuthRunnerProof;
    readonly remoteRunnerAttestation?: RemoteNativeAuthRunnerAttestation;
  }): Promise<PiNativeAuthLeaseResult> {
    this.#assertInitialized();
    const token = bearerToken(input.authorization);
    if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new Error("Pi native auth lease generation is invalid.");
    if (!Number.isSafeInteger(input.runnerProductGeneration) || input.runnerProductGeneration < 0) {
      throw new Error("Pi native auth runner generation is invalid.");
    }
    if (!Number.isSafeInteger(input.catalogGeneration) || input.catalogGeneration < 0) {
      throw new Error("Pi native auth lease catalog generation is invalid.");
    }
    if (!isLeaseUuid(input.runId) || !isLeaseUuid(input.runnerFence)) throw new Error("Pi native auth runner fence is invalid.");
    if (input.recoveryProof !== undefined && (input.action === "acquire" || !/^[A-Za-z0-9_-]{43}$/u.test(input.recoveryProof))) {
      throw new Error("Pi native auth recovery proof is invalid.");
    }
    if (input.recovery !== undefined && (input.action !== "acquire"
        || !Number.isSafeInteger(input.recovery.runnerPid) || input.recovery.runnerPid < 1)) {
      throw new Error("Pi native auth recovery runner identity is invalid.");
    }
    if (input.runnerProof !== undefined && (input.runnerProof.format !== 1
        || !isLeaseUuid(input.runnerProof.reservationId)
        || !Number.isSafeInteger(input.runnerProof.runnerPid) || input.runnerProof.runnerPid < 1
        || !/^[A-Za-z0-9_-]{43}$/u.test(input.runnerProof.nonce)
        || !/^[A-Za-z0-9_-]{86}$/u.test(input.runnerProof.signature))) {
      throw new Error("Pi native auth signed runner proof is invalid.");
    }
    const source = this.#nativeAuth;
    if (source === undefined) throw new Error("Pi native auth lease is unavailable.");
    const now = this.#now();
    this.#purgeDetachedNativeAuthLeases(now);
    const targetIsRemote = this.#store.getTarget(input.targetId).descriptor.remoteWorkspace !== undefined;
    let remoteRunnerEvidence: NativeAuthRecoveryRemoteRunnerEvidence | undefined;
    if (input.remoteRunnerAttestation !== undefined) {
      if (!targetIsRemote || this.#trustedManagedRunnerScriptSha256 === undefined) {
        throw new Error("Pi native auth remote runner attestation is outside its target scope.");
      }
      remoteRunnerEvidence = verifyRemoteNativeAuthRunnerAttestation({
        action: input.action,
        bearer: token,
        sessionId: input.sessionId,
        targetId: input.targetId,
        serviceGeneration: input.generation,
        runnerProductGeneration: input.runnerProductGeneration,
        providerId: input.providerId,
        catalogGeneration: input.catalogGeneration,
        runId: input.runId,
        runnerFence: input.runnerFence,
        attestation: input.remoteRunnerAttestation,
        trustedRunnerScriptSha256: this.#trustedManagedRunnerScriptSha256,
        now
      });
      this.#claimRemoteAttestationNonce(token, input.remoteRunnerAttestation.nonce, now);
    }
    let signedRunnerEvidence: NativeAuthRecoverySignedRunnerEvidence | undefined;
    if (input.runnerProof !== undefined) {
      const recovery = this.#nativeAuthRecovery;
      if (recovery === undefined) throw new Error("Pi native auth recovery is unavailable.");
      signedRunnerEvidence = recovery.verifyRunnerProof({
        action: input.action,
        sessionId: input.sessionId,
        targetId: input.targetId,
        serviceGeneration: input.generation,
        runnerProductGeneration: input.runnerProductGeneration,
        providerId: input.providerId,
        catalogGeneration: input.catalogGeneration,
        runId: input.runId,
        runnerFence: input.runnerFence,
        proof: input.runnerProof,
        ...(input.recoveryProof === undefined ? {} : { recoveryProof: input.recoveryProof }),
        credentialDigest: nativeAuthCredentialDigest(input.credential),
        location: targetIsRemote ? "remote" : "local",
        ...(remoteRunnerEvidence === undefined ? {} : { depthEvidence: remoteRunnerEvidence })
      });
    }
    const durableRecoveryRequest = input.recovery !== undefined || input.recoveryProof !== undefined
      || signedRunnerEvidence !== undefined;
    if (durableRecoveryRequest && targetIsRemote && remoteRunnerEvidence === undefined
        && signedRunnerEvidence === undefined) {
      throw new Error("Pi native auth remote runner attestation is unavailable.");
    }
    if (input.recovery !== undefined && remoteRunnerEvidence !== undefined
        && remoteRunnerEvidence.runnerPid !== input.recovery.runnerPid) {
      throw new Error("Pi native auth remote runner PID is mismatched.");
    }
    if (input.recovery !== undefined && signedRunnerEvidence !== undefined
        && signedRunnerEvidence.runnerPid !== input.recovery.runnerPid) {
      throw new Error("Pi native auth signed runner PID is mismatched.");
    }
    const recoveryRunnerEvidence = signedRunnerEvidence ?? remoteRunnerEvidence;

    let detached: DetachedNativeAuthLease | undefined;
    if (input.action !== "acquire" && input.recoveryProof !== undefined
        && this.#nativeAuthRecovery !== undefined) {
      const recoveryDescriptor = source.describe(input.providerId);
      const recovered = await this.#nativeAuthRecovery.recover({
        action: input.action,
        proof: input.recoveryProof,
        sessionId: input.sessionId,
        targetId: input.targetId,
        serviceGeneration: input.generation,
        runnerProductGeneration: input.runnerProductGeneration,
        providerId: input.providerId,
        catalogGeneration: input.catalogGeneration,
        runId: input.runId,
        runnerFence: input.runnerFence,
        descriptor: recoveryDescriptor,
        ...(recoveryRunnerEvidence === undefined ? {} : { runnerEvidence: recoveryRunnerEvidence })
      });
      if (recovered?.released === true) return { active: false };
      if (recovered !== undefined) {
        detached = this.#findDetachedNativeAuthLease(token, input.recoveryProof, input)
          ?? this.#restoreDetachedNativeAuthLease(token, recovered, recoveryDescriptor.accountId);
      }
    } else {
      detached = this.#findDetachedNativeAuthLease(token, input.recoveryProof, input);
    }
    if (detached !== undefined) {
      if (detached.released) {
        if (input.action === "release") return { active: false };
        throw new Error("Pi native auth lease is expired or revoked.");
      }
      if (input.action === "release") return this.#releaseDetachedNativeAuthLease(detached, input.credential, source);
      if (input.action === "acquire") {
        if (input.recovery === undefined || detached.recoveryId === undefined
            || detached.recoveryProof === undefined || this.#nativeAuthRecovery === undefined) {
          throw new Error("Pi native auth lease is already active.");
        }
        const descriptor = source.describe(detached.providerId);
        const replay = await this.#nativeAuthRecovery.recover({
          action: "validate",
          proof: detached.recoveryProof,
          sessionId: detached.sessionId,
          targetId: detached.targetId,
          serviceGeneration: detached.generation,
          runnerProductGeneration: detached.runnerProductGeneration,
          providerId: detached.providerId,
          catalogGeneration: detached.catalogGeneration,
          runId: detached.runId,
          runnerFence: detached.runnerFence,
          descriptor,
          ...(recoveryRunnerEvidence === undefined ? {} : { runnerEvidence: recoveryRunnerEvidence })
        });
        if (replay === undefined || replay.released) throw new Error("Pi native auth lease is expired or revoked.");
        const loaded = source.load({
          providerIds: [detached.providerId],
          expectedCatalogGeneration: detached.lease.sourceCatalogGeneration
        });
        if (loaded.catalogGeneration !== detached.lease.sourceCatalogGeneration) {
          throw new Error("Pi native auth load crossed a catalog generation.");
        }
        const credential = loaded.credentials[detached.providerId];
        if (credential === undefined) throw new Error("Pi native auth credential is unavailable.");
        return {
          active: true,
          validForMs: Math.max(1, detached.expiresAt - now),
          credential,
          recoveryProof: detached.recoveryProof
        };
      }
      return await this.#validateDetachedNativeAuthLease(detached, source, now);
    }

    if (input.action === "acquire" && input.recovery !== undefined && this.#nativeAuthRecovery !== undefined) {
      const descriptor = source.describe(input.providerId);
      const reissued = await this.#nativeAuthRecovery.reissue({
        sessionId: input.sessionId,
        targetId: input.targetId,
        serviceGeneration: input.generation,
        runnerProductGeneration: input.runnerProductGeneration,
        providerId: input.providerId,
        catalogGeneration: input.catalogGeneration,
        runId: input.runId,
        runnerFence: input.runnerFence,
        bearerDigest: digestToken(token).toString("hex"),
        descriptor,
        runnerEvidence: recoveryRunnerEvidence ?? { kind: "local", runnerPid: input.recovery.runnerPid }
      });
      if (reissued !== undefined) {
        const restored = this.#restoreDetachedNativeAuthLease(token, reissued.snapshot, descriptor.accountId);
        restored.recoveryProof = reissued.proof;
        const loaded = source.load({
          providerIds: [restored.providerId],
          expectedCatalogGeneration: restored.lease.sourceCatalogGeneration
        });
        if (loaded.catalogGeneration !== restored.lease.sourceCatalogGeneration) {
          throw new Error("Pi native auth load crossed a catalog generation.");
        }
        const credential = loaded.credentials[restored.providerId];
        if (credential === undefined) throw new Error("Pi native auth credential is unavailable.");
        return {
          active: true,
          validForMs: Math.max(1, restored.expiresAt - now),
          credential,
          recoveryProof: reissued.proof
        };
      }
    }

    // SessionHost advances the product binding generation whenever it resumes a
    // reaped parent runtime. That lifecycle must not revoke an already-acquired
    // detached child: its immutable acquisition generation, bearer digest, Run,
    // and runner fence remain authoritative until release or lease expiry. The
    // current product binding is joined only while minting a new lease.
    const session = this.#store.getSession(input.sessionId).descriptor;
    const reservedSignedAcquire = input.action === "acquire" && input.recovery !== undefined
      && signedRunnerEvidence !== undefined;
    let nativeAuth: NonNullable<BridgeGrant["nativeAuth"]>;
    if (reservedSignedAcquire) {
      if (session.targetId !== input.targetId) {
        throw new Error("Pi native auth lease product scope is stale or mismatched.");
      }
      nativeAuth = {
        catalogGeneration: input.catalogGeneration,
        providerIds: new Set([input.providerId]),
        authenticatedProviderIds: new Set([input.providerId]),
        leases: new Map()
      };
    } else {
      if (session.targetId !== input.targetId || session.binding.generation !== input.generation) {
        throw new Error("Pi native auth lease product scope is stale or mismatched.");
      }
      const grant = this.#findGrant(token);
      if (grant.expectedPiGeneration !== undefined && grant.expectedPiGeneration !== input.generation) {
        throw new Error("Pi native auth lease generation is stale.");
      }
      if (grant.nativeAuth === undefined) throw new Error("Pi native auth lease is unavailable.");
      nativeAuth = grant.nativeAuth;
    }
    if (input.catalogGeneration !== nativeAuth.catalogGeneration) throw new Error("Pi native auth lease catalog generation is stale.");
    if (!nativeAuth.providerIds.has(input.providerId) || !nativeAuth.authenticatedProviderIds.has(input.providerId)) {
      throw new Error("Pi native auth Provider is outside this runtime snapshot.");
    }
    if (input.action !== "acquire") throw new Error("Pi native auth lease is expired or revoked.");
    const descriptor = source.describe(input.providerId);
    if (
      descriptor.authenticated !== true || descriptor.catalogGeneration !== nativeAuth.catalogGeneration
      || descriptor.accountId.length < 1 || descriptor.authGeneration.length < 1
    ) throw new Error("Pi native auth account or generation is unavailable.");
    const loaded = source.load({
      providerIds: [input.providerId],
      expectedCatalogGeneration: nativeAuth.catalogGeneration
    });
    if (loaded.catalogGeneration !== nativeAuth.catalogGeneration) throw new Error("Pi native auth load crossed a catalog generation.");
    const credential = loaded.credentials[input.providerId];
    if (credential === undefined) throw new Error("Pi native auth credential is unavailable.");
    const lease: NativeAuthLease = {
      runId: input.runId,
      runnerFence: input.runnerFence,
      providerId: input.providerId,
      accountId: descriptor.accountId,
      authGeneration: descriptor.authGeneration,
      catalogGeneration: descriptor.catalogGeneration,
      sourceCatalogGeneration: descriptor.catalogGeneration,
      refreshPending: false,
      refreshSuperseded: false,
      expiresAt: now + this.#nativeAuthLeaseTtlMs
    };
    nativeAuth.leases.set(input.runId, lease);
    const digest = digestToken(token);
    const key = digest.toString("hex");
    const detachedByRun = this.#detachedNativeAuthLeases.get(key) ?? new Map<string, DetachedNativeAuthLease>();
    const detachedLease: DetachedNativeAuthLease = {
      digest,
      sessionId: input.sessionId,
      targetId: input.targetId,
      generation: input.generation,
      runnerProductGeneration: input.runnerProductGeneration,
      providerId: input.providerId,
      catalogGeneration: input.catalogGeneration,
      runId: input.runId,
      runnerFence: input.runnerFence,
      owner: nativeAuth,
      lease,
      released: false,
      expiresAt: lease.expiresAt
    };
    detachedByRun.set(input.runId, detachedLease);
    this.#detachedNativeAuthLeases.set(key, detachedByRun);
    let recoveryProof: string | undefined;
    if (input.recovery !== undefined) {
      const recovery = this.#nativeAuthRecovery;
      if (recovery === undefined) {
        this.#expireDetachedNativeAuthLease(detachedLease);
        throw new Error("Pi native auth recovery is unavailable.");
      }
      try {
        const issued = await recovery.issue({
          sessionId: input.sessionId,
          targetId: input.targetId,
          serviceGeneration: input.generation,
          runnerProductGeneration: input.runnerProductGeneration,
          providerId: input.providerId,
          catalogGeneration: input.catalogGeneration,
          runId: input.runId,
          runnerFence: input.runnerFence,
          bearerDigest: digestToken(token).toString("hex"),
          accountId: descriptor.accountId,
          authGeneration: descriptor.authGeneration,
          sourceCatalogGeneration: descriptor.catalogGeneration,
          expiresAt: lease.expiresAt,
          runnerEvidence: recoveryRunnerEvidence ?? {
            kind: "local",
            runnerPid: input.recovery.runnerPid
          }
        });
        detachedLease.recoveryId = issued.snapshot.recoveryId;
        detachedLease.recoveryProof = issued.proof;
        this.#recoveryNativeAuthLeases.set(issued.snapshot.recoveryId, detachedLease);
        recoveryProof = issued.proof;
      } catch (error) {
        this.#expireDetachedNativeAuthLease(detachedLease);
        throw error;
      }
    }
    return {
      active: true,
      validForMs: this.#nativeAuthLeaseTtlMs,
      credential,
      ...(recoveryProof === undefined ? {} : { recoveryProof })
    };
  }

  async #validateDetachedNativeAuthLease(
    detached: DetachedNativeAuthLease,
    source: PiNativeAuthLeaseSource,
    now: number
  ): Promise<PiNativeAuthLeaseResult> {
    const lease = detached.lease;
    if (lease.expiresAt <= now) {
      this.#expireDetachedNativeAuthLease(detached);
      await this.#revokeNativeAuthRecovery(detached);
      throw new Error("Pi native auth lease is expired or revoked.");
    }
    if (lease.refreshPending) {
      // A terminal sibling is committing a same-account refresh. Do not read a
      // half-transitioned descriptor and do not extend authority while the
      // commit is unresolved; the original short expiry remains authoritative.
      return { active: true, validForMs: Math.max(1, lease.expiresAt - now) };
    }
    const descriptor = source.describe(lease.providerId);
    if (
      descriptor.authenticated !== true || descriptor.accountId !== lease.accountId
      || descriptor.authGeneration !== lease.authGeneration
      || descriptor.catalogGeneration !== lease.sourceCatalogGeneration
    ) {
      this.#expireDetachedNativeAuthLease(detached);
      await this.#revokeNativeAuthRecovery(detached);
      throw new Error("Pi native auth account or generation changed.");
    }
    const expiresAt = now + this.#nativeAuthLeaseTtlMs;
    if (detached.recoveryId !== undefined && this.#nativeAuthRecovery !== undefined) {
      try {
        await this.#nativeAuthRecovery.renew({
          recoveryId: detached.recoveryId,
          expiresAt,
          authGeneration: lease.authGeneration,
          sourceCatalogGeneration: lease.sourceCatalogGeneration,
          refreshSuperseded: lease.refreshSuperseded
        });
      } catch (error) {
        this.#expireDetachedNativeAuthLease(detached);
        throw error;
      }
    }
    lease.expiresAt = expiresAt;
    detached.expiresAt = expiresAt;
    return { active: true, validForMs: this.#nativeAuthLeaseTtlMs };
  }

  #restoreDetachedNativeAuthLease(
    token: string,
    recovered: NativeAuthRecoverySnapshot,
    accountId: string
  ): DetachedNativeAuthLease {
    const existing = this.#recoveryNativeAuthLeases.get(recovered.recoveryId);
    if (existing !== undefined) {
      if (existing.sessionId !== recovered.sessionId || existing.targetId !== recovered.targetId
          || existing.generation !== recovered.serviceGeneration
          || existing.runnerProductGeneration !== recovered.runnerProductGeneration
          || existing.providerId !== recovered.providerId
          || existing.catalogGeneration !== recovered.catalogGeneration || existing.runId !== recovered.runId
          || existing.runnerFence !== recovered.runnerFence || existing.lease.accountId !== accountId) {
        throw new Error("Pi native auth recovery lineage is stale or mismatched.");
      }
      return existing;
    }
    const owner: NonNullable<BridgeGrant["nativeAuth"]> = {
      catalogGeneration: recovered.catalogGeneration,
      providerIds: new Set([recovered.providerId]),
      authenticatedProviderIds: new Set([recovered.providerId]),
      leases: new Map()
    };
    const lease: NativeAuthLease = {
      runId: recovered.runId,
      runnerFence: recovered.runnerFence,
      providerId: recovered.providerId,
      accountId,
      authGeneration: recovered.authGeneration,
      catalogGeneration: recovered.catalogGeneration,
      sourceCatalogGeneration: recovered.sourceCatalogGeneration,
      refreshPending: false,
      refreshSuperseded: recovered.refreshSuperseded,
      expiresAt: recovered.expiresAt
    };
    owner.leases.set(recovered.runId, lease);
    const detached: DetachedNativeAuthLease = {
      digest: digestToken(token),
      sessionId: recovered.sessionId,
      targetId: recovered.targetId,
      generation: recovered.serviceGeneration,
      runnerProductGeneration: recovered.runnerProductGeneration,
      providerId: recovered.providerId,
      catalogGeneration: recovered.catalogGeneration,
      runId: recovered.runId,
      runnerFence: recovered.runnerFence,
      owner,
      lease,
      recoveryId: recovered.recoveryId,
      released: false,
      expiresAt: recovered.expiresAt
    };
    this.#recoveryNativeAuthLeases.set(recovered.recoveryId, detached);
    const key = detached.digest.toString("hex");
    const byRun = this.#detachedNativeAuthLeases.get(key) ?? new Map<string, DetachedNativeAuthLease>();
    byRun.set(detached.runId, detached);
    this.#detachedNativeAuthLeases.set(key, byRun);
    return detached;
  }

  #releaseDetachedNativeAuthLease(
    detached: DetachedNativeAuthLease,
    credential: unknown,
    source: PiNativeAuthLeaseSource
  ): Promise<PiNativeAuthLeaseResult> {
    const lease = detached.lease;
    if (lease.release !== undefined) return lease.release;
    const accountKey = `${lease.providerId}\u0000${lease.accountId}`;
    const release = this.#withNativeAuthAccountLock(accountKey, async () => {
      if (detached.released) return { active: false } as const;
      if (credential === undefined || lease.refreshSuperseded) {
        await this.#completeDetachedNativeAuthRelease(detached);
        return { active: false } as const;
      }

      const siblings = this.#nativeAuthAccountLeases(lease.providerId, lease.accountId);
      for (const sibling of siblings) sibling.lease.refreshPending = true;
      let transitionId: string | undefined;
      try {
        const before = source.describe(lease.providerId);
        if (
          before.authenticated !== true || before.accountId !== lease.accountId
          || before.authGeneration !== lease.authGeneration
          || before.catalogGeneration !== lease.sourceCatalogGeneration
        ) {
          // Logout, account replacement, or an independently initiated refresh
          // wins. The child credential is deliberately discarded.
          await this.#completeDetachedNativeAuthRelease(detached);
          return { active: false } as const;
        }
        if (detached.recoveryId !== undefined) {
          transitionId = await this.#nativeAuthRecovery?.beginTransition({
            recoveryId: detached.recoveryId,
            providerId: lease.providerId,
            accountId: lease.accountId,
            authGeneration: lease.authGeneration,
            sourceCatalogGeneration: lease.sourceCatalogGeneration
          });
        }
        try {
          await source.persist({
            providerId: lease.providerId,
            credential,
            expectedCatalogGeneration: lease.catalogGeneration,
            expectedAccountId: lease.accountId
          });
        } catch (error) {
          const afterFailure = source.describe(lease.providerId);
          if (
            afterFailure.authenticated === true && afterFailure.accountId === lease.accountId
            && (afterFailure.authGeneration !== before.authGeneration
              || afterFailure.catalogGeneration !== before.catalogGeneration)
          ) {
            // The vault write may have committed before a downstream generation
            // refresh failed, or another exact-account writer won the race.
            await this.#nativeAuthRecovery?.commitTransition({ transitionId, descriptor: afterFailure });
            this.#acceptNativeAuthRefresh(lease, afterFailure);
            await this.#completeDetachedNativeAuthRelease(detached);
            return { active: false } as const;
          }
          if (nativeAuthGenerationConflict(error)) {
            // A different catalog mutation won before this terminal flush. It is
            // unsafe to replay the old-generation credential, but discarding it
            // must not turn an otherwise successful child into a failed Run.
            await this.#nativeAuthRecovery?.abortTransition(transitionId);
            await this.#completeDetachedNativeAuthRelease(detached);
            return { active: false } as const;
          }
          await this.#nativeAuthRecovery?.abortTransition(transitionId);
          throw error;
        }
        const after = source.describe(lease.providerId);
        if (after.authenticated === true && after.accountId === lease.accountId) {
          await this.#nativeAuthRecovery?.commitTransition({ transitionId, descriptor: after });
          this.#acceptNativeAuthRefresh(lease, after);
        } else {
          await this.#nativeAuthRecovery?.abortTransition(transitionId);
          await Promise.all(siblings.map(async (sibling) => {
            this.#expireDetachedNativeAuthLease(sibling);
            await this.#revokeNativeAuthRecovery(sibling);
          }));
        }
        await this.#completeDetachedNativeAuthRelease(detached);
        return { active: false } as const;
      } finally {
        for (const sibling of siblings) sibling.lease.refreshPending = false;
      }
    });
    lease.release = release;
    void release.catch(() => {
      if (!detached.released && lease.release === release) lease.release = undefined;
    });
    return release;
  }

  #acceptNativeAuthRefresh(
    sourceLease: NativeAuthLease,
    descriptor: ReturnType<PiNativeAuthLeaseSource["describe"]>
  ): void {
    for (const sibling of this.#nativeAuthAccountLeases(sourceLease.providerId, sourceLease.accountId)) {
      if (sibling.lease !== sourceLease) sibling.lease.refreshSuperseded = true;
      sibling.lease.authGeneration = descriptor.authGeneration;
      sibling.lease.sourceCatalogGeneration = descriptor.catalogGeneration;
      sibling.lease.refreshPending = false;
    }
  }

  #nativeAuthAccountLeases(providerId: string, accountId: string): DetachedNativeAuthLease[] {
    const values = new Set<DetachedNativeAuthLease>();
    for (const byRun of this.#detachedNativeAuthLeases.values()) {
      for (const detached of byRun.values()) {
        if (!detached.released && detached.lease.providerId === providerId && detached.lease.accountId === accountId) {
          values.add(detached);
        }
      }
    }
    for (const detached of this.#recoveryNativeAuthLeases.values()) {
      if (!detached.released && detached.lease.providerId === providerId && detached.lease.accountId === accountId) {
        values.add(detached);
      }
    }
    return [...values];
  }

  async #completeDetachedNativeAuthRelease(detached: DetachedNativeAuthLease): Promise<void> {
    const tombstoneExpiresAt = this.#now() + this.#nativeAuthLeaseTtlMs;
    if (detached.recoveryId !== undefined && this.#nativeAuthRecovery !== undefined) {
      await this.#nativeAuthRecovery.complete(detached.recoveryId, tombstoneExpiresAt);
    }
    detached.owner.leases.delete(detached.runId);
    detached.released = true;
    detached.expiresAt = tombstoneExpiresAt;
    detached.lease.expiresAt = tombstoneExpiresAt;
    detached.lease.refreshPending = false;
  }

  #expireDetachedNativeAuthLease(detached: DetachedNativeAuthLease): void {
    detached.owner.leases.delete(detached.runId);
    const byRun = this.#detachedNativeAuthLeases.get(detached.digest.toString("hex"));
    if (byRun?.get(detached.runId) === detached) byRun.delete(detached.runId);
    if (byRun?.size === 0) this.#detachedNativeAuthLeases.delete(detached.digest.toString("hex"));
    if (detached.recoveryId !== undefined && this.#recoveryNativeAuthLeases.get(detached.recoveryId) === detached) {
      this.#recoveryNativeAuthLeases.delete(detached.recoveryId);
    }
  }

  async #revokeNativeAuthRecovery(detached: DetachedNativeAuthLease): Promise<void> {
    if (detached.recoveryId !== undefined) await this.#nativeAuthRecovery?.revoke(detached.recoveryId);
  }

  #claimRemoteAttestationNonce(token: string, nonce: string, now: number): void {
    for (const [key, receivedAt] of this.#remoteAttestationNonces) {
      if (receivedAt + 60_000 <= now) this.#remoteAttestationNonces.delete(key);
    }
    const key = createHash("sha256").update(token, "utf8").update("\0", "utf8").update(nonce, "utf8").digest("hex");
    if (this.#remoteAttestationNonces.has(key)) throw new Error("Pi native auth remote runner attestation was replayed.");
    if (this.#remoteAttestationNonces.size >= 4_096) {
      const oldest = this.#remoteAttestationNonces.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#remoteAttestationNonces.delete(oldest);
    }
    this.#remoteAttestationNonces.set(key, now);
  }

  #findDetachedNativeAuthLease(
    token: string,
    recoveryProof: string | undefined,
    input: {
      readonly generation: number;
      readonly runnerProductGeneration: number;
      readonly sessionId: string;
      readonly targetId: string;
      readonly providerId: string;
      readonly catalogGeneration: number;
      readonly runId: string;
      readonly runnerFence: string;
    }
  ): DetachedNativeAuthLease | undefined {
    const digest = digestToken(token);
    let candidate = this.#detachedNativeAuthLeases.get(digest.toString("hex"))?.get(input.runId);
    if (candidate !== undefined && (candidate.digest.byteLength !== digest.byteLength
        || !timingSafeEqual(candidate.digest, digest))) candidate = undefined;
    if (candidate === undefined && recoveryProof !== undefined) {
      const recoveryDigest = digestToken(recoveryProof);
      const recoveryCandidate = this.#recoveryNativeAuthLeases.get(recoveryDigest.toString("hex"));
      if (recoveryCandidate?.recoveryId !== undefined) {
        const candidateDigest = Buffer.from(recoveryCandidate.recoveryId, "hex");
        if (candidateDigest.byteLength === recoveryDigest.byteLength && timingSafeEqual(candidateDigest, recoveryDigest)) {
          candidate = recoveryCandidate;
        }
      }
    }
    if (candidate === undefined) return undefined;
    if (
      candidate.generation !== input.generation
      || candidate.runnerProductGeneration !== input.runnerProductGeneration || candidate.sessionId !== input.sessionId
      || candidate.targetId !== input.targetId || candidate.providerId !== input.providerId
      || candidate.catalogGeneration !== input.catalogGeneration || candidate.runId !== input.runId
      || candidate.runnerFence !== input.runnerFence
    ) throw new Error("Pi native auth lease runner fence is stale or mismatched.");
    return candidate;
  }

  #purgeDetachedNativeAuthLeases(now = this.#now()): void {
    const leases = new Set<DetachedNativeAuthLease>(this.#recoveryNativeAuthLeases.values());
    for (const byRun of this.#detachedNativeAuthLeases.values()) {
      for (const detached of byRun.values()) leases.add(detached);
    }
    for (const detached of leases) {
      if (detached.expiresAt <= now) {
        this.#expireDetachedNativeAuthLease(detached);
        void this.#revokeNativeAuthRecovery(detached).catch(() => undefined);
      }
    }
  }

  #withNativeAuthAccountLock<T>(accountKey: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.#nativeAuthReleaseTails.get(accountKey) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(callback);
    const tail = operation.then(() => undefined, () => undefined);
    this.#nativeAuthReleaseTails.set(accountKey, tail);
    void tail.then(() => {
      if (this.#nativeAuthReleaseTails.get(accountKey) === tail) this.#nativeAuthReleaseTails.delete(accountKey);
    });
    return operation;
  }

  #normalizeResult(result: McpCallResult, label: string): NormalizedMcpResult {
    const normalized = normalizeMcpResult(result, (value) => this.#redactText(value), label);
    if (normalized.bytes.byteLength > this.#resultCapacityBytes) {
      throw new McpResultResourceExhaustedError();
    }
    return normalized;
  }

  async #projectBridgeResult(
    result: McpCallResult,
    serverId: string,
    toolName: string,
    hostImages: readonly BridgeToolImageOutput[] = []
  ): Promise<McpBridgeCallResult> {
    const normalized = this.#normalizeResult(result, "MCP bridge result");
    const hostDetails = {
      format: 1,
      truncated: false,
      byteLength: normalized.bytes.byteLength,
      ...(hostImages.length === 0 ? {} : {
        imageOutputs: hostImages.map((image) => ({
          blob: publicBlobRef(image.blob),
          ...(image.alt === undefined ? {} : { alt: image.alt })
        }))
      })
    } as const;
    if (normalized.bytes.byteLength <= MCP_BRIDGE_INLINE_RESULT_MAXIMUM_BYTES) {
      const response: McpBridgeCallResult = {
        content: normalized.value.content,
        details: {
          ...(normalized.value.structuredContent === undefined
            ? {}
            : { mcpStructuredContent: normalized.value.structuredContent }),
          jokoMcpBridge: hostDetails
        },
        isError: normalized.value.isError
      };
      assertBridgeResponseWithinBudget(response);
      return response;
    }

    if (this.#resultArtifacts === undefined) throw new McpArtifactUnavailableError();
    let stored: BlobRef;
    try {
      const safeServerId = artifactNamePart(this.#redactText(serverId));
      const safeToolName = artifactNamePart(this.#redactText(toolName));
      stored = await this.#resultArtifacts.ingestBytes(normalized.bytes, {
        fileName: `${safeServerId}-${safeToolName}-${randomUUID()}.json`,
        mimeType: "application/json"
      });
    } catch (error) {
      throw new McpArtifactUnavailableError({ cause: error });
    }
    const completeOutput = publicBlobRef(stored);
    const response: McpBridgeCallResult = {
      content: bridgeResultPreview(normalized.value.content, completeOutput, normalized.bytes.byteLength),
      details: {
        jokoMcpBridge: {
          ...hostDetails,
          truncated: true,
          completeOutput
        }
      },
      isError: normalized.value.isError
    };
    assertBridgeResponseWithinBudget(response);
    return response;
  }

  async #callBridgeToolProvider(
    provider: BridgeToolProvider,
    expectedGeneration: number,
    toolName: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    context: BridgeToolCallContext
  ): Promise<{
    readonly result: McpCallResult;
    readonly hostImages: readonly BridgeToolImageOutput[];
  }> {
    if (!provider.available || provider.generation !== expectedGeneration) {
      throw new Error("Bridge Tool Provider generation is unavailable or fenced.");
    }
    if (!provider.tools.some((tool) => tool.name === toolName)) {
      throw new Error("Bridge Tool is not part of the fenced discovery snapshot.");
    }
    const result = await provider.callTool(toolName, arguments_, signal, context);
    const hostImages = normalizeBridgeToolImageOutputs(
      result.hostImages,
      this.#resultCapacityBytes,
      (value) => this.#redactText(value)
    );
    return {
      result: this.#normalizeResult({
        content: result.content,
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        isError: result.isError
      }, "Bridge Tool result").value,
      hostImages
    };
  }

  async #start(server: StoredMcpServer): Promise<void> {
    this.#states.set(server.input.id, { state: "starting", generation: server.generation });
    const credentials: Record<string, string> = {};
    let connection: McpClientConnection | undefined;
    try {
      await validateServerInput(server.input);
      for (const binding of server.input.credentialBindings) credentials[`${binding.target}:${binding.name}`] = this.#credentials.resolve(binding.credentialReferenceId);
      let runtime: Runtime | undefined;
      connection = await this.#factory.connect({
        config: server.input,
        generation: server.generation,
        credentials,
        onClose: () => this.#runtimeClosed(server.input.id, server.generation),
        onError: (error) => this.#runtimeErrored(server.input.id, server.generation, error)
      });
      const tools = await discoverAllTools(
        connection,
        server.input.id,
        this.#toolDiscoveryPolicy
      );
      const duplicate = duplicateToolName(tools);
      if (duplicate !== undefined) throw new Error(`MCP server advertised duplicate tool '${duplicate}'.`);
      runtime = { serverId: server.input.id, generation: server.generation, connection, tools, state: "connected" };
      let group = this.#runtimes.get(server.input.id);
      if (group === undefined) {
        group = new Map();
        this.#runtimes.set(server.input.id, group);
      }
      group.set(server.generation, runtime);
      if (this.#servers.get(server.input.id)?.generation === server.generation) {
        this.#states.set(server.input.id, { state: "connected", generation: server.generation });
      }
    } catch (error) {
      await connection?.close().catch(() => undefined);
      const message = this.#redactedError(error);
      const errorCode = error instanceof McpToolDiscoveryError ? error.code : undefined;
      if (this.#servers.get(server.input.id)?.generation === server.generation) {
        this.#states.set(server.input.id, {
          state: "error",
          generation: server.generation,
          error: message,
          ...(errorCode === undefined ? {} : { errorCode })
        });
      }
      throw new Error("MCP server failed to start.", { cause: new Error(message) });
    }
  }

  #runtimeClosed(serverId: string, generation: number): void {
    const runtime = this.#runtime(serverId, generation);
    if (runtime !== undefined) runtime.state = "disconnected";
    const current = this.#servers.get(serverId);
    if (current?.generation === generation) this.#states.set(serverId, { state: "disconnected", generation });
  }

  #runtimeErrored(serverId: string, generation: number, error: Error): void {
    const message = this.#redactedError(error);
    const runtime = this.#runtime(serverId, generation);
    if (runtime !== undefined) {
      runtime.state = "degraded";
      runtime.error = message;
    }
    const current = this.#servers.get(serverId);
    if (current?.generation === generation) this.#states.set(serverId, { state: "degraded", generation, error: message });
  }

  #descriptor(server: StoredMcpServer): McpServerDescriptor {
    const state = this.#states.get(server.input.id) ?? { state: server.input.enabled ? "disconnected" as const : "disabled" as const, generation: server.generation };
    const runtime = this.#runtime(server.input.id, server.generation);
    return {
      id: server.input.id,
      displayName: server.input.displayName,
      transport: server.input.transport,
      endpointDisplay: server.input.transport === "stdio" ? server.input.command : safeEndpointDisplay(server.input.endpoint),
      enabled: server.input.enabled,
      state: state.state,
      runtimeGeneration: server.generation,
      tools: runtime?.tools ?? [],
      credentialBindings: server.input.credentialBindings.map((binding) => ({
        ...binding,
        configured: this.#credentials.find(binding.credentialReferenceId)?.configured === true
      })),
      configuration: server.input.transport === "stdio"
        ? {
          case: "stdio",
          command: server.input.command,
          arguments: [...(server.input.args ?? [])],
          workingDirectory: server.input.cwd ?? "",
          environment: { ...(server.input.environment ?? {}) }
        }
        : { case: "streamableHttp", endpoint: server.input.endpoint },
      version: BigInt(server.version),
      updatedAt: server.updatedAt,
      ...(state.error === undefined ? {} : { error: state.error }),
      ...(state.errorCode === undefined ? {} : { errorCode: state.errorCode })
    };
  }

  #stateForRuntime(server: StoredMcpServer): { readonly state: McpServerState; readonly generation: number; readonly error?: string } {
    const runtime = this.#runtime(server.input.id, server.generation);
    return runtime === undefined
      ? { state: server.input.enabled ? "disconnected" : "disabled", generation: server.generation }
      : { state: runtime.state, generation: runtime.generation, ...(runtime.error === undefined ? {} : { error: runtime.error }) };
  }

  #requireServer(serverId: string): StoredMcpServer {
    const server = this.#servers.get(nonBlank(serverId, "MCP server ID"));
    if (server === undefined) throw new Error("MCP server does not exist.");
    return server;
  }

  #runtime(serverId: string, generation: number): Runtime | undefined {
    return this.#runtimes.get(serverId)?.get(generation);
  }

  #requireRuntime(serverId: string, generation: number): Runtime {
    const runtime = this.#runtime(serverId, generation);
    if (runtime === undefined || runtime.state !== "connected") throw new Error("MCP server runtime generation is unavailable or fenced.");
    return runtime;
  }

  #persist(): void {
    this.#store.setSetting("service", this.#scopeId, "mcp_catalog", {
      format: 1,
      lastGeneration: this.#lastGeneration,
      servers: [...this.#servers.values()].sort((left, right) => left.input.id.localeCompare(right.input.id, "en"))
    } satisfies StoredMcpCatalog);
  }

  #findGrant(token: string): BridgeGrant {
    this.#purgeGrants();
    const digest = digestToken(token);
    const candidate = this.#grants.get(digest.toString("hex"));
    if (candidate === undefined || candidate.digest.byteLength !== digest.byteLength || !timingSafeEqual(candidate.digest, digest)) {
      throw new Error("MCP bridge credential is invalid or expired.");
    }
    return candidate;
  }

  #purgeGrants(): void {
    const now = this.#now();
    for (const [key, grant] of this.#grants) if (grant.expiresAt <= now) this.#grants.delete(key);
  }

  async #retireUnused(serverId: string): Promise<void> {
    this.#purgeGrants();
    const group = this.#runtimes.get(serverId);
    if (group === undefined) return;
    const current = this.#servers.get(serverId)?.generation;
    const retained = new Set<number>();
    for (const grant of this.#grants.values()) {
      const generation = grant.serverGenerations.get(serverId);
      if (generation !== undefined) retained.add(generation);
    }
    for (const [generation, runtime] of [...group]) {
      if (generation === current || retained.has(generation)) continue;
      group.delete(generation);
      await runtime.connection.close().catch(() => undefined);
    }
    if (group.size === 0) this.#runtimes.delete(serverId);
  }

  async #retireAllUnused(): Promise<void> {
    await Promise.all([...this.#runtimes.keys()].map((id) => this.#retireUnused(id)));
  }

  #redactedError(error: unknown): string {
    const generic = error instanceof Error ? `${error.name}: ${error.message}` : "MCP operation failed.";
    return this.#redactText(generic).slice(0, 2_048);
  }

  #redactText(value: string): string {
    const redactText = (this.#credentials as Partial<Pick<CredentialManager, "redactText">>).redactText;
    const exact = typeof redactText === "function" ? redactText.call(this.#credentials, value) : value;
    return redactSecrets(exact);
  }

  #mutate<T>(callback: () => Promise<T>): Promise<T> {
    const operation = this.#tail.then(callback, callback);
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new Error("MCP router is not initialized.");
  }
}

function validateBridgeToolPolicyDeclaration(value: BridgeToolPolicyDeclaration): void {
  nonBlank(value.id, "Bridge Tool policy ID");
  nonBlank(value.displayName, "Bridge Tool policy display name");
  nonBlank(value.description, "Bridge Tool policy description");
  if (typeof value.productDefaultEnabled !== "boolean") throw new Error("Bridge Tool policy default must be a boolean.");
  for (const [locale, localized] of Object.entries(value.localizations ?? {})) {
    nonBlank(locale, "Bridge Tool policy locale");
    nonBlank(localized.displayName, "Localized Bridge Tool policy display name");
    nonBlank(localized.description, "Localized Bridge Tool policy description");
  }
}

function sameBridgeToolPolicyDeclaration(
  left: BridgeToolPolicyDeclaration,
  right: BridgeToolPolicyDeclaration
): boolean {
  return left.id === right.id
    && left.displayName === right.displayName
    && left.description === right.description
    && left.productDefaultEnabled === right.productDefaultEnabled
    && JSON.stringify(left.localizations ?? {}) === JSON.stringify(right.localizations ?? {});
}

export class SdkMcpClientFactory implements McpClientFactory {
  async connect(input: McpClientFactoryInput): Promise<McpClientConnection> {
    const client = new Client({ name: "joko-orchestrator", version: "0.1.0" }, { capabilities: {} });
    client.onclose = input.onClose;
    client.onerror = input.onError;
    if (input.config.transport === "stdio") {
      const env: Record<string, string> = {
        ...getDefaultEnvironment(),
        ...(input.config.environment ?? {})
      };
      for (const binding of input.config.credentialBindings) {
        if (binding.target !== "environment") throw new Error("Stdio MCP credential binding must target an environment variable.");
        const value = input.credentials[`environment:${binding.name}`];
        if (value === undefined) throw new Error("Stdio MCP credential binding is unresolved.");
        env[binding.name] = value;
      }
      await client.connect(new StdioClientTransport({
        command: input.config.command,
        args: [...(input.config.args ?? [])],
        env,
        ...(input.config.cwd === undefined ? {} : { cwd: input.config.cwd }),
        stderr: "pipe"
      }));
    } else {
      const headers = new Headers();
      for (const binding of input.config.credentialBindings) {
        if (binding.target !== "header") throw new Error("HTTP MCP credential binding must target a header.");
        const value = input.credentials[`header:${binding.name}`];
        if (value === undefined) throw new Error("HTTP MCP credential binding is unresolved.");
        headers.set(binding.name, value);
      }
      await client.connect(new StreamableHTTPClientTransport(new URL(input.config.endpoint), {
        requestInit: { headers, redirect: "error" }
      }));
    }
    return {
      async listTools(cursor, signal) {
        const result = await client.listTools(
          cursor === undefined ? undefined : { cursor },
          signal === undefined ? undefined : { signal }
        );
        return {
          tools: result.tools,
          ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor })
        };
      },
      async callTool(name, arguments_, signal) {
        const result = await client.callTool({ name, arguments: { ...arguments_ } }, undefined, signal === undefined ? undefined : { signal });
        if ("toolResult" in result) return { content: [{ type: "text", text: JSON.stringify(result.toolResult) }], isError: false };
        return {
          content: result.content,
          ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
          isError: result.isError ?? false
        };
      },
      close: () => client.close()
    };
  }
}

async function validateServerInput(input: McpServerInput): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.id)) throw new Error("MCP server ID is invalid.");
  nonBlank(input.displayName, "MCP display name");
  const targets = new Set<string>();
  for (const binding of input.credentialBindings) {
    if (binding.target === "header") assertHeaderName(binding.name);
    else if (binding.target === "environment") assertEnvironmentName(binding.name);
    else throw new Error("MCP credential binding target is invalid.");
    if (targets.has(`${binding.target}:${binding.name.toLowerCase()}`)) throw new Error("MCP credential binding is duplicated.");
    targets.add(`${binding.target}:${binding.name.toLowerCase()}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/u.test(binding.credentialReferenceId)) throw new Error("MCP credential reference is invalid.");
  }
  if (input.transport === "stdio") {
    if (input.credentialBindings.some((binding) => binding.target !== "environment")) throw new Error("Stdio MCP accepts only environment credential bindings.");
    nonBlank(input.command, "MCP command");
    if (input.command.includes("\0") || input.args?.some((arg) => arg.includes("\0"))) throw new Error("MCP command contains a null byte.");
    if (input.cwd !== undefined) await assertCanonicalDirectory(input.cwd, "MCP working directory");
    for (const [name, value] of Object.entries(input.environment ?? {})) {
      assertEnvironmentName(name);
      if (isSecretName(name) || looksSecretValue(value)) throw new Error("Secret-like MCP environment values must use credential references.");
    }
  } else {
    if (input.credentialBindings.some((binding) => binding.target !== "header")) throw new Error("HTTP MCP accepts only header credential bindings.");
    validateMcpEndpoint(input.endpoint);
    const endpoint = new URL(input.endpoint);
    if (endpoint.search) throw new Error("MCP endpoint query parameters are not allowed.");
  }
}

function validateStoredServer(value: StoredMcpServer): StoredMcpServer {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.generation) || !/^\d+$/u.test(value.version) || !Number.isSafeInteger(value.updatedAt)) {
    throw new Error("Stored MCP server is malformed.");
  }
  // Full async filesystem checks happen when the runtime starts. Structural
  // validation still fails closed before the configuration is exposed.
  const input = value.input;
  if (!input || typeof input !== "object" || !Array.isArray(input.credentialBindings)) throw new Error("Stored MCP server input is malformed.");
  if (!(input.transport === "stdio" || input.transport === "streamable_http")) throw new Error("Stored MCP transport is invalid.");
  return { ...value, input: cloneServerInput(input) };
}

function cloneServerInput(input: McpServerInput): McpServerInput {
  if (input.transport === "stdio") return {
    ...input,
    args: [...(input.args ?? [])],
    environment: { ...(input.environment ?? {}) },
    credentialBindings: input.credentialBindings.map((binding) => ({ ...binding }))
  };
  return { ...input, credentialBindings: input.credentialBindings.map((binding) => ({ ...binding })) };
}

function normalizeTool(serverId: string, tool: McpListedTool): McpToolDescriptor {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(tool.name)) throw new Error("MCP tool name is incompatible with the Pi bridge.");
  if (!isPlainObject(tool.inputSchema)) throw new Error("MCP tool input schema is invalid.");
  assertBoundedJson(tool.inputSchema, 1024 * 1024, "MCP tool schema");
  if (tool.outputSchema !== undefined) {
    if (!isPlainObject(tool.outputSchema)) throw new Error("MCP tool output schema is invalid.");
    assertBoundedJson(tool.outputSchema, 1024 * 1024, "MCP tool output schema");
  }
  return {
    serverId,
    name: tool.name,
    description: tool.description ?? tool.name,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    requiresPermission: tool.annotations?.readOnlyHint !== true || tool.annotations.destructiveHint === true
  };
}

async function discoverAllTools(
  connection: McpClientConnection,
  serverId: string,
  policy: McpToolDiscoveryPolicy
): Promise<readonly McpToolDescriptor[]> {
  const controller = new AbortController();
  const timeoutError = new McpToolDiscoveryError("timed_out", "MCP tool discovery timed out.");
  const timer = setTimeout(() => controller.abort(timeoutError), policy.timeoutMs);
  timer.unref?.();
  const tools: McpToolDescriptor[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  let catalogBytes = 2;
  try {
    for (;;) {
      throwIfDiscoveryAborted(controller.signal);
      if (pageCount >= policy.maximumPages) {
        throw new McpToolDiscoveryError("page_limit", "MCP tool discovery exceeded the page limit.");
      }
      let page: McpToolListPage;
      try {
        page = await connection.listTools(cursor, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throwDiscoveryAbortReason(controller.signal);
        throw error;
      }
      throwIfDiscoveryAborted(controller.signal);
      pageCount += 1;
      if (!isPlainObject(page) || !Array.isArray(page.tools)) {
        throw new McpToolDiscoveryError("invalid_page", "MCP tool discovery returned an invalid page.");
      }
      for (const candidate of page.tools) {
        if (tools.length >= policy.maximumTools) {
          throw new McpToolDiscoveryError("tool_limit", "MCP tool discovery exceeded the tool limit.");
        }
        const tool = normalizeTool(serverId, candidate);
        const serialized = boundedJson(tool, "MCP tool descriptor");
        const nextBytes = catalogBytes + (tools.length === 0 ? 0 : 1) + Buffer.byteLength(serialized, "utf8");
        if (nextBytes > policy.maximumBytes) {
          throw new McpToolDiscoveryError("catalog_too_large", "MCP tool discovery exceeded the catalog size limit.");
        }
        catalogBytes = nextBytes;
        tools.push(tool);
      }
      const nextCursor = page.nextCursor;
      if (nextCursor === undefined) return tools;
      if (typeof nextCursor !== "string" || nextCursor.length === 0 || Buffer.byteLength(nextCursor, "utf8") > 4_096) {
        throw new McpToolDiscoveryError("invalid_page", "MCP tool discovery returned an invalid cursor.");
      }
      if (seenCursors.has(nextCursor)) {
        throw new McpToolDiscoveryError("pagination_cycle", "MCP tool discovery returned a repeated cursor.");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  } finally {
    clearTimeout(timer);
  }
}

function throwIfDiscoveryAborted(signal: AbortSignal): void {
  if (signal.aborted) throwDiscoveryAbortReason(signal);
}

function throwDiscoveryAbortReason(signal: AbortSignal): never {
  if (signal.reason instanceof McpToolDiscoveryError) throw signal.reason;
  throw new McpToolDiscoveryError("aborted", "MCP tool discovery was aborted.");
}

function validateToolDiscoveryPolicy(policy: McpToolDiscoveryPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`MCP tool discovery ${name} is invalid.`);
  }
}

function boundedJson(value: unknown, label: string): string {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { throw new Error(`${label} is not JSON serializable.`); }
  if (serialized === undefined) throw new Error(`${label} is not JSON serializable.`);
  return serialized;
}

function duplicateToolName(tools: readonly McpToolDescriptor[]): string | undefined {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) return tool.name;
    names.add(tool.name);
  }
  return undefined;
}

async function assertCanonicalDirectory(path: string, label: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be a normalized absolute path.`);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a regular directory.`);
  const canonical = await realpath(path);
  if (!samePath(canonical, path)) throw new Error(`${label} contains a path alias or junction.`);
}

function assertHeaderName(name: string): void {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) throw new Error("MCP credential header name is invalid.");
  if (["host", "content-length", "connection", "transfer-encoding", "mcp-session-id"].includes(name.toLowerCase())) {
    throw new Error("MCP credential binding targets a reserved header.");
  }
}

function assertEnvironmentName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error("MCP environment variable name is invalid.");
}

function isSecretName(name: string): boolean {
  return /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)/iu.test(name);
}

function looksSecretValue(value: string): boolean {
  return value.length > 80 && /^[A-Za-z0-9_+/=-]+$/u.test(value);
}

function safeEndpointDisplay(raw: string): string {
  const url = new URL(raw);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function bearerToken(authorization: string | undefined): string {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) throw new Error("MCP bridge authorization is required.");
  const token = authorization.slice(7);
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) throw new Error("MCP bridge authorization is invalid.");
  return token;
}

function boundedBridgeIdentity(value: string): boolean {
  return value.length >= 1 && value.length <= 1_024 && !value.includes("\u0000");
}

function boundedBridgeRequestId(value: string): boolean {
  return value.length >= 1 && value.length <= 1_024 && !value.includes("\u0000") && !/[\r\n]/u.test(value);
}

function bridgeGrantAuthorityDigest(input: {
  readonly expectedPiGeneration?: number;
  readonly productScope?: BridgeGrant["productScope"];
  readonly serverGenerations: ReadonlyMap<string, number>;
  readonly tools: readonly PiMcpToolDescriptor[];
  readonly nativeAuth?: BridgeGrant["nativeAuth"];
}): Buffer {
  const hash = operationBodyHash({
    format: 1,
    ...(input.expectedPiGeneration === undefined ? {} : { expectedPiGeneration: input.expectedPiGeneration }),
    ...(input.productScope === undefined ? {} : { productScope: input.productScope }),
    serverGenerations: [...input.serverGenerations]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([serverId, generation]) => ({ serverId, generation })),
    tools: input.tools.map((tool) => ({
      serverId: tool.serverId,
      name: tool.name,
      ...(tool.runtimeName === undefined ? {} : { runtimeName: tool.runtimeName }),
      policySubject: tool.policySubject,
      description: tool.description,
      inputSchema: tool.inputSchema,
      requiresPermission: tool.requiresPermission
    })),
    ...(input.nativeAuth === undefined ? {} : {
      nativeAuth: {
        catalogGeneration: input.nativeAuth.catalogGeneration,
        providerIds: [...input.nativeAuth.providerIds].sort((left, right) => left.localeCompare(right, "en")),
        authenticatedProviderIds: [...input.nativeAuth.authenticatedProviderIds]
          .sort((left, right) => left.localeCompare(right, "en"))
      }
    })
  });
  return Buffer.from(hash.slice("sha256:".length), "hex");
}

function bridgeRequestIdentity(grantDigest: Uint8Array, requestId: string): string {
  return createHash("sha256")
    .update("joko.mcp-bridge.request.v1\u0000", "utf8")
    .update(grantDigest)
    .update("\u0000", "utf8")
    .update(requestId, "utf8")
    .digest("hex");
}

function bridgeEffectIdentity(requestIdentity: string, requestBodyHash: string): string {
  return createHash("sha256")
    .update("joko.mcp-bridge.effect.v1\u0000", "utf8")
    .update(requestIdentity, "utf8")
    .update("\u0000", "utf8")
    .update(requestBodyHash, "utf8")
    .digest("hex");
}

function normalizedProviderIds(values: readonly string[], label: string): Set<string> {
  if (!Array.isArray(values)) throw new Error(`${label} is invalid.`);
  const normalized = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) || normalized.has(value)) {
      throw new Error(`${label} is invalid.`);
    }
    normalized.add(value);
  }
  return normalized;
}

function isLeaseUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function nativeAuthGenerationConflict(error: unknown): boolean {
  return error !== null && typeof error === "object"
    && (error as { readonly code?: unknown }).code === "STALE_PROVIDER_AUTH_GENERATION";
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

class McpArtifactUnavailableError extends Error {
  readonly code = "artifact_unavailable" as const;

  constructor(options?: ErrorOptions) {
    super("MCP tool result could not be materialized as an Artifact.", options);
    this.name = "McpArtifactUnavailableError";
  }
}

class McpInvalidResultError extends Error {
  readonly code = "invalid_result" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "McpInvalidResultError";
  }
}

function normalizeMcpResult(
  value: unknown,
  redact: (value: string) => string,
  label: string
): NormalizedMcpResult {
  let rawJson: string | undefined;
  try {
    rawJson = JSON.stringify(value);
  } catch (error) {
    throw new McpInvalidResultError(`${label} is not JSON serializable.`, { cause: error });
  }
  if (rawJson === undefined) throw new McpInvalidResultError(`${label} is not JSON serializable.`);
  const parsed = redactJsonValue(JSON.parse(rawJson) as unknown, redact);
  if (!isPlainObject(parsed) || !Array.isArray(parsed["content"]) || typeof parsed["isError"] !== "boolean") {
    throw new McpInvalidResultError(`${label} has an invalid envelope.`);
  }
  const structuredContent = parsed["structuredContent"];
  if (structuredContent !== undefined && !isPlainObject(structuredContent)) {
    throw new McpInvalidResultError(`${label} structured content must be a JSON object.`);
  }
  const result: McpCallResult = {
    content: parsed["content"],
    ...(structuredContent === undefined ? {} : { structuredContent }),
    isError: parsed["isError"]
  };
  return { value: result, bytes: Buffer.from(JSON.stringify(result), "utf8") };
}

function redactJsonValue(value: unknown, redact: (value: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, redact));
  if (!isPlainObject(value)) return value;
  const redacted = Object.create(null) as Record<string, unknown>;
  for (const [rawKey, item] of Object.entries(value)) {
    const baseKey = redact(rawKey);
    let key = baseKey;
    for (let suffix = 2; Object.prototype.hasOwnProperty.call(redacted, key); suffix += 1) {
      key = `${baseKey}#${suffix}`;
    }
    redacted[key] = redactJsonValue(item, redact);
  }
  return redacted;
}

function bridgeResultPreview(
  content: readonly unknown[],
  completeOutput: BlobRef,
  completeByteLength: number
): readonly unknown[] {
  const preview: unknown[] = [{
    type: "text",
    text: `[Complete MCP result stored as Artifact ${completeOutput.id} (${completeByteLength} bytes).]`
  }];
  let used = jsonByteLength(preview);
  let omitted = 0;
  for (const part of content) {
    const partBytes = jsonByteLength(part);
    if (used + partBytes <= MCP_BRIDGE_PREVIEW_MAXIMUM_BYTES) {
      preview.push(part);
      used += partBytes;
      continue;
    }
    if (isPlainObject(part) && part["type"] === "text" && typeof part["text"] === "string") {
      const remaining = Math.max(0, MCP_BRIDGE_PREVIEW_MAXIMUM_BYTES - used - 256);
      const text = utf8Prefix(part["text"], remaining);
      if (text !== "") {
        const projected = { ...part, text: `${text}\n[continued in complete Artifact]` };
        preview.push(projected);
        used += jsonByteLength(projected);
      }
    }
    omitted += 1;
  }
  if (omitted > 0) preview.push({ type: "text", text: `[${omitted} MCP content part(s) continued in complete Artifact.]` });
  return preview;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function publicBlobRef(value: BlobRef): BlobRef {
  return {
    id: value.id,
    sha256: value.sha256,
    byteLength: value.byteLength,
    mimeType: value.mimeType,
    ...(value.fileName === undefined ? {} : { fileName: value.fileName })
  };
}

function normalizeBridgeToolImageOutputs(
  value: readonly BridgeToolImageOutput[] | undefined,
  maximumBlobBytes: number,
  redact: (value: string) => string
): readonly BridgeToolImageOutput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new McpInvalidResultError("Bridge Tool image output list is invalid.");
  }
  return value.map((image) => {
    if (image === null || typeof image !== "object") {
      throw new McpInvalidResultError("Bridge Tool image output is invalid.");
    }
    const blob = image.blob;
    if (blob === null || typeof blob !== "object"
      || typeof blob.id !== "string" || blob.id.length === 0
      || Buffer.byteLength(blob.id, "utf8") > 512 || /[\u0000-\u001f\u007f]/u.test(blob.id)
      || typeof blob.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(blob.sha256)
      || typeof blob.byteLength !== "number" || !Number.isSafeInteger(blob.byteLength)
      || blob.byteLength < 1 || blob.byteLength > maximumBlobBytes
      || typeof blob.mimeType !== "string"
      || !/^image\/(?:png|jpeg|gif|webp)$/u.test(blob.mimeType)
      || (blob.fileName !== undefined && (
        typeof blob.fileName !== "string"
        || blob.fileName.length === 0
        || Buffer.byteLength(blob.fileName, "utf8") > 512
        || /[\u0000-\u001f\u007f]/u.test(blob.fileName)
      ))) {
      throw new McpInvalidResultError("Bridge Tool image Blob identity is invalid.");
    }
    if (image.alt !== undefined && (
      typeof image.alt !== "string"
      || Buffer.byteLength(image.alt, "utf8") > 4_096
    )) {
      throw new McpInvalidResultError("Bridge Tool image alternative text is invalid.");
    }
    const fileName = blob.fileName === undefined ? undefined : redact(blob.fileName);
    const alt = image.alt === undefined ? undefined : redact(image.alt);
    if ((fileName !== undefined && (
      fileName.length === 0
      || Buffer.byteLength(fileName, "utf8") > 512
      || /[\u0000-\u001f\u007f]/u.test(fileName)
    )) || (alt !== undefined && Buffer.byteLength(alt, "utf8") > 4_096)) {
      throw new McpInvalidResultError("Bridge Tool image output is invalid after redaction.");
    }
    const safeBlob: BlobRef = {
      id: blob.id,
      sha256: blob.sha256,
      byteLength: blob.byteLength,
      mimeType: blob.mimeType,
      ...(fileName === undefined ? {} : { fileName })
    };
    return {
      blob: safeBlob,
      ...(alt === undefined ? {} : { alt })
    };
  });
}

function artifactNamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "mcp";
}

function jsonByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new McpInvalidResultError("MCP bridge value is not JSON serializable.");
  return Buffer.byteLength(serialized, "utf8");
}

function assertBridgeResponseWithinBudget(value: McpBridgeCallResult): void {
  if (jsonByteLength(value) > MCP_BRIDGE_RESPONSE_MAXIMUM_BYTES) {
    throw new McpInvalidResultError("MCP bridge response exceeded its bounded wire envelope.");
  }
}

function mcpBridgeErrorCode(error: unknown): McpBridgeErrorCode | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return code === "resource_exhausted" || code === "artifact_unavailable" || code === "invalid_result" ? code : undefined;
}

function assertBoundedJson(value: unknown, maximumBytes: number, label: string): void {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { throw new Error(`${label} is not JSON serializable.`); }
  if (json === undefined || Buffer.byteLength(json, "utf8") > maximumBytes) throw new Error(`${label} exceeds its size limit.`);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function nonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.includes("\0")) throw new Error(`${label} must not be blank.`);
  return normalized;
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
