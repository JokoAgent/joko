import { createHash } from "node:crypto";

import { createClient, type Client, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  BrowserService,
  ConnectionService,
  type BrowserAutomationBinary as ProtoBrowserAutomationBinary,
  type BrowserAutomationNode as ProtoBrowserAutomationNode,
  type ExecuteBrowserAutomationActionResponse
} from "@joko/contracts";
import {
  sanitizeBrowserFileName,
  type BrowserAutomationAction,
  type BrowserAutomationActKind,
  type BrowserRemoteAutomationRequest,
  type BrowserRemoteAutomationResult,
  type BrowserRemoteNodeCapability,
  type BrowserRemoteNodeRoute,
  type BrowserRemoteNodeRouter
} from "@joko/tool-browser";

import type { ArtifactStore } from "./artifact-store.js";
import type { BrowserToolBridgeProvider } from "./browser-tool-bridge.js";
import type { CredentialManager } from "./credential-manager.js";
import type { DiscoveredNodeRecord, LanDiscoveryService } from "./lan-discovery.js";

export const BROWSER_AUTOMATION_ACTIONS = [
  "doctor", "status", "start", "stop", "profiles", "tabs", "open", "focus", "close",
  "snapshot", "screenshot", "navigate", "console", "pdf", "upload", "dialog", "act",
  "requests", "responseBody", "extract", "recipe", "siteguide", "saveRecipe"
] as const satisfies readonly BrowserAutomationAction[];

export const BROWSER_AUTOMATION_ACT_KINDS = [
  "click", "clickCoords", "type", "press", "hover", "drag", "select", "fill", "resize",
  "wait", "evaluate", "saveResource", "close"
] as const satisfies readonly BrowserAutomationActKind[];

export const BROWSER_AUTOMATION_NODE_CAPABILITIES: ReadonlySet<BrowserRemoteNodeCapability> = new Set([
  ...BROWSER_AUTOMATION_ACTIONS.map((action) => `action:${action}` as const),
  ...BROWSER_AUTOMATION_ACT_KINDS.map((kind) => `act:${kind}` as const),
  "semantic-query",
  "artifact-upload",
  "binary-result"
]);

const MAXIMUM_ARGUMENT_BYTES = 200_000;
const MAXIMUM_BINARY_BYTES = 10 * 1024 * 1024;
const REMOTE_CALL_TIMEOUT_MS = 35_000;
const CREDENTIAL_PROVIDER_PREFIX = "browser-automation-node:";

export interface BrowserAutomationNodeProjection {
  readonly id: string;
  readonly displayName: string;
  readonly available: boolean;
  readonly generation: number;
  readonly capabilities: ReadonlySet<BrowserRemoteNodeCapability>;
  readonly error?: string;
}

export interface BrowserAutomationInputArtifact {
  readonly artifactId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256Hex: string;
  readonly data: Uint8Array;
}

export interface BrowserAutomationNodeExecutionRequest {
  readonly nodeId: string;
  readonly expectedGeneration: number;
  readonly action: BrowserAutomationAction;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly inputArtifacts?: readonly BrowserAutomationInputArtifact[];
}

export function browserAutomationNodeCredentialProviderId(nodeId: string): string {
  return `${CREDENTIAL_PROVIDER_PREFIX}${validNodeId(nodeId)}`;
}

/** Local authenticated dispatch target used by BrowserService and the self route. */
export class BrowserAutomationNodeExecutor {
  readonly #nodeId: string;
  readonly #displayName: string;
  readonly #generation: number;
  readonly #bridge: BrowserToolBridgeProvider;
  readonly #artifacts: ArtifactStore;

  constructor(input: {
    readonly nodeId: string;
    readonly displayName: string;
    readonly generation: number;
    readonly bridge: BrowserToolBridgeProvider;
    readonly artifacts: ArtifactStore;
  }) {
    this.#nodeId = validNodeId(input.nodeId);
    this.#displayName = boundedText(input.displayName, 128, "Browser automation node display name");
    this.#generation = validGeneration(input.generation);
    this.#bridge = input.bridge;
    this.#artifacts = input.artifacts;
  }

  project(): BrowserAutomationNodeProjection {
    return {
      id: this.#nodeId,
      displayName: this.#displayName,
      available: this.#bridge.available,
      generation: this.#generation,
      capabilities: BROWSER_AUTOMATION_NODE_CAPABILITIES
    };
  }

  async execute(
    request: BrowserAutomationNodeExecutionRequest,
    signal?: AbortSignal,
    reuseLocalArtifacts = false
  ): Promise<BrowserRemoteAutomationResult> {
    signal?.throwIfAborted();
    const before = this.project();
    if (request.nodeId !== before.id || request.expectedGeneration !== before.generation || !before.available) {
      throw new Error("Browser automation node generation is stale or unavailable.");
    }
    assertActionCapabilities(request.action, request.arguments, before.capabilities);
    let arguments_ = boundedJsonRecord(request.arguments, "Browser automation action arguments");
    if (arguments_["action"] !== request.action || arguments_["target"] !== undefined || arguments_["node"] !== undefined) {
      throw new Error("Browser automation action arguments do not match the authenticated route.");
    }
    const inputArtifacts = request.inputArtifacts ?? [];
    if (request.action === "upload") {
      arguments_ = reuseLocalArtifacts
        ? assertLocalArtifactArguments(arguments_)
        : await this.#ingestInputArtifacts(arguments_, inputArtifacts);
    } else if (inputArtifacts.length !== 0) {
      throw new Error("Browser automation input artifacts require the upload action.");
    }
    const result = await this.#bridge.callTool("browser", arguments_, signal);
    if (this.project().generation !== before.generation) {
      throw new Error("Browser automation node was fenced during execution.");
    }
    return this.#toRemoteResult(request.action, result);
  }

  async #ingestInputArtifacts(
    arguments_: Readonly<Record<string, unknown>>,
    inputArtifacts: readonly BrowserAutomationInputArtifact[]
  ): Promise<Readonly<Record<string, unknown>>> {
    const paths = stringArray(arguments_["paths"], 16, 512, "Browser upload artifact IDs");
    if (paths.length !== inputArtifacts.length) throw new Error("Browser upload artifacts do not match the action arguments.");
    const byId = new Map<string, BrowserAutomationInputArtifact>();
    let totalBytes = 0;
    for (const artifact of inputArtifacts) {
      const id = boundedText(artifact.artifactId, 512, "Browser upload artifact ID");
      if (byId.has(id) || !paths.includes(id)) throw new Error("Browser upload artifact identity is invalid.");
      const bytes = boundedBytes(artifact.data, "Browser upload artifact");
      totalBytes += bytes.byteLength;
      if (totalBytes > MAXIMUM_BINARY_BYTES || artifact.byteSize !== bytes.byteLength) {
        throw new Error("Browser upload artifacts exceed their byte fence.");
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== artifact.sha256Hex.toLowerCase()) throw new Error("Browser upload artifact digest is invalid.");
      byId.set(id, { ...artifact, artifactId: id, data: bytes });
    }
    const translated: string[] = [];
    for (const id of paths) {
      const artifact = byId.get(id);
      if (artifact === undefined) throw new Error("Browser upload artifact is missing.");
      const stored = await this.#artifacts.ingestBytes(artifact.data, {
        fileName: sanitizeBrowserFileName(artifact.fileName),
        mimeType: safeMediaType(artifact.mediaType),
        expiresAt: Date.now() + 24 * 60 * 60_000
      });
      translated.push(stored.id);
    }
    return { ...arguments_, paths: translated };
  }

  async #toRemoteResult(
    action: BrowserAutomationAction,
    result: Awaited<ReturnType<BrowserToolBridgeProvider["callTool"]>>
  ): Promise<BrowserRemoteAutomationResult> {
    const structured = result.structuredContent === undefined
      ? undefined
      : boundedJsonValue(result.structuredContent, "Browser automation result");
    if (result.isError) {
      const record = isRecord(structured) ? structured : {};
      return {
        ok: false,
        errorCode: safeLabel(record["errorCode"], "REMOTE_BROWSER_ACTION_FAILED"),
        message: boundedText(typeof record["message"] === "string" ? record["message"] : "Remote Browser action failed.", 4_096, "Browser automation error")
      };
    }
    const data = isRecord(structured) && "data" in structured ? structured["data"] : structured;
    const image = firstImageContent(result.content);
    if (image !== undefined) return { ok: true, data, binary: image };
    if (action === "pdf" || (action === "act" && actKind(result.structuredContent) === "saveResource")) {
      const artifactId = findArtifactId(data);
      if (artifactId !== undefined) {
        const artifact = await this.#artifacts.get(artifactId);
        if (artifact.byteLength > MAXIMUM_BINARY_BYTES) throw new Error("Browser automation binary result exceeds its byte limit.");
        const read = await this.#artifacts.readBlob(artifact);
        return {
          ok: true,
          data,
          binary: {
            bytes: boundedBytes(read.data, "Browser automation binary result"),
            mediaType: remoteMediaType(read.mimeType),
            ...(artifact.fileName === undefined ? {} : { fileName: sanitizeBrowserFileName(artifact.fileName) })
          }
        };
      }
    }
    return { ok: true, data };
  }
}

export interface BrowserAutomationNodeRpcClient {
  serverId(signal?: AbortSignal): Promise<string>;
  list(authKey: string, signal?: AbortSignal): Promise<readonly ProtoBrowserAutomationNode[]>;
  execute(
    authKey: string,
    request: BrowserAutomationNodeExecutionRequest,
    signal?: AbortSignal
  ): Promise<ExecuteBrowserAutomationActionResponse>;
}

export type BrowserAutomationNodeRpcClientFactory = (origin: string) => BrowserAutomationNodeRpcClient;

/**
 * Resolves only live discovery records with an encrypted service credential.
 * The discovery origin is never persisted and is identity-probed before a
 * bearer is decrypted or sent.
 */
export class AuthenticatedBrowserRemoteNodeRouter implements BrowserRemoteNodeRouter {
  readonly #localNodeId: string;
  readonly #localGeneration: number;
  readonly #discovery: LanDiscoveryService;
  readonly #credentials: CredentialManager;
  readonly #artifacts: ArtifactStore;
  readonly #rpcFactory: BrowserAutomationNodeRpcClientFactory;
  readonly #remote = new Map<string, BrowserAutomationNodeProjection>();
  #localExecutor: BrowserAutomationNodeExecutor | undefined;

  constructor(input: {
    readonly localNodeId: string;
    readonly localGeneration: number;
    readonly discovery: LanDiscoveryService;
    readonly credentials: CredentialManager;
    readonly artifacts: ArtifactStore;
    readonly rpcFactory?: BrowserAutomationNodeRpcClientFactory;
  }) {
    this.#localNodeId = validNodeId(input.localNodeId);
    this.#localGeneration = validGeneration(input.localGeneration);
    this.#discovery = input.discovery;
    this.#credentials = input.credentials;
    this.#artifacts = input.artifacts;
    this.#rpcFactory = input.rpcFactory ?? defaultRpcClient;
  }

  attachLocal(executor: BrowserAutomationNodeExecutor): void {
    if (this.#localExecutor !== undefined) throw new Error("Local Browser automation node is already attached.");
    const node = executor.project();
    if (node.id !== this.#localNodeId || node.generation !== this.#localGeneration) {
      throw new Error("Local Browser automation node identity does not match its router.");
    }
    this.#localExecutor = executor;
  }

  async resolve(nodeId: string): Promise<BrowserRemoteNodeRoute | undefined> {
    const id = validNodeId(nodeId);
    if (id === this.#localNodeId) return this.#localRoute();
    const node = await this.#readRemoteNode(id);
    if (node === undefined) return undefined;
    this.#remote.set(id, node);
    return this.#remoteRoute(id);
  }

  list(): readonly Pick<BrowserRemoteNodeRoute, "id" | "generation" | "available" | "capabilities">[] {
    const nodes: Array<Pick<BrowserRemoteNodeRoute, "id" | "generation" | "available" | "capabilities">> = [];
    const local = this.#localExecutor?.project();
    if (local !== undefined) nodes.push(local);
    const live = new Set(this.#discovery.list().map((node) => node.serverId));
    for (const [id, node] of this.#remote) {
      if (live.has(id)) nodes.push(node);
      else this.#remote.delete(id);
    }
    return nodes.sort((left, right) => left.id.localeCompare(right.id, "en"));
  }

  #localRoute(): BrowserRemoteNodeRoute | undefined {
    const executor = this.#localExecutor;
    if (executor === undefined) return undefined;
    return routeFromProjection(
      () => executor.project(),
      (request, signal) => executor.execute({
        nodeId: this.#localNodeId,
        expectedGeneration: this.#localGeneration,
        action: request.action,
        arguments: request.arguments
      }, signal, true)
    );
  }

  #remoteRoute(id: string): BrowserRemoteNodeRoute {
    return routeFromProjection(
      () => this.#remote.get(id) ?? unavailableProjection(id),
      async (request, signal) => {
        const discovered = this.#discoveredRemote(id);
        if (discovered === undefined) throw new Error("Remote Browser node is no longer discoverable.");
        const rpc = this.#rpcFactory(discovered.origin);
        if (await rpc.serverId(signal) !== id) throw new Error("Remote Browser node identity changed.");
        const credential = this.#credentialReference(id);
        if (credential === undefined) throw new Error("Remote Browser node has no authenticated service connection.");
        const expected = this.#remote.get(id);
        if (expected === undefined) throw new Error("Remote Browser node capability projection is unavailable.");
        assertActionCapabilities(request.action, request.arguments, expected.capabilities);
        const inputArtifacts = request.action === "upload"
          ? await this.#readInputArtifacts(request.arguments)
          : [];
        const response = await rpc.execute(this.#credentials.resolve(credential), {
          nodeId: id,
          expectedGeneration: expected.generation,
          action: request.action,
          arguments: request.arguments,
          inputArtifacts
        }, signal);
        const currentDiscovery = this.#discoveredRemote(id);
        if (currentDiscovery === undefined || currentDiscovery.origin !== discovered.origin) {
          throw new Error("Remote Browser node discovery authority changed during execution.");
        }
        const projection = projectionFromProto(response.node, id);
        this.#remote.set(id, projection);
        if (projection.generation !== expected.generation) {
          throw new Error("Remote Browser node generation changed during execution.");
        }
        return remoteResultFromProto(response);
      }
    );
  }

  async #readRemoteNode(id: string): Promise<BrowserAutomationNodeProjection | undefined> {
    const discovered = this.#discoveredRemote(id);
    const credential = this.#credentialReference(id);
    if (discovered === undefined || credential === undefined) return undefined;
    const rpc = this.#rpcFactory(discovered.origin);
    // Bind the credential-free discovery origin to the stable server identity
    // before decrypting the service bearer.
    if (await rpc.serverId() !== id) return undefined;
    const nodes = await rpc.list(this.#credentials.resolve(credential));
    const current = this.#discoveredRemote(id);
    if (current === undefined || current.origin !== discovered.origin) return undefined;
    const matches = nodes.filter((node) => node.nodeId === id);
    if (matches.length !== 1) return undefined;
    return projectionFromProto(matches[0], id);
  }

  #discoveredRemote(id: string): DiscoveredNodeRecord | undefined {
    if (id === this.#localNodeId) return undefined;
    const matches = this.#discovery.list().filter((node) => node.serverId === id);
    if (matches.length !== 1) return undefined;
    const node = matches[0]!;
    const origin = new URL(node.origin);
    if (origin.origin !== node.origin || (origin.protocol !== "http:" && origin.protocol !== "https:") ||
      origin.username !== "" || origin.password !== "" || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
      return undefined;
    }
    return node;
  }

  #credentialReference(id: string): string | undefined {
    const credentials = this.#credentials.list({
      providerId: browserAutomationNodeCredentialProviderId(id),
      kind: "header_secret"
    }).filter((credential) => credential.configured);
    return credentials.length === 1 ? credentials[0]!.credentialReferenceId : undefined;
  }

  async #readInputArtifacts(arguments_: Readonly<Record<string, unknown>>): Promise<readonly BrowserAutomationInputArtifact[]> {
    const paths = stringArray(arguments_["paths"], 16, 512, "Browser upload artifact IDs");
    const output: BrowserAutomationInputArtifact[] = [];
    let totalBytes = 0;
    for (const id of paths) {
      const artifact = await this.#artifacts.get(id);
      totalBytes += artifact.byteLength;
      if (totalBytes > MAXIMUM_BINARY_BYTES) throw new Error("Remote Browser upload exceeds its byte limit.");
      const read = await this.#artifacts.readBlob(artifact);
      output.push({
        artifactId: id,
        fileName: sanitizeBrowserFileName(artifact.fileName ?? "upload.bin"),
        mediaType: safeMediaType(read.mimeType),
        byteSize: artifact.byteLength,
        sha256Hex: artifact.sha256,
        data: boundedBytes(read.data, "Remote Browser upload artifact")
      });
    }
    return output;
  }
}

function defaultRpcClient(origin: string): BrowserAutomationNodeRpcClient {
  const normalizedOrigin = new URL(origin).origin;
  if (normalizedOrigin !== origin) throw new Error("Remote Browser node origin is invalid.");
  return {
    async serverId(signal) {
      const response = await createClient(ConnectionService, transport(normalizedOrigin)).getServerInfo({}, { signal });
      return response.server?.serverId ?? "";
    },
    async list(authKey, signal) {
      const response = await browserClient(normalizedOrigin, authKey).listBrowserAutomationNodes({}, { signal });
      return response.nodes;
    },
    execute: async (authKey, request, signal) => browserClient(normalizedOrigin, authKey).executeBrowserAutomationAction({
      nodeId: request.nodeId,
      expectedGeneration: BigInt(request.expectedGeneration),
      action: request.action,
      argumentsJson: JSON.stringify(boundedJsonRecord(request.arguments, "Browser automation action arguments")),
      inputArtifacts: (request.inputArtifacts ?? []).map(toProtoInputArtifact)
    }, { signal })
  };
}

function browserClient(origin: string, authKey: string): Client<typeof BrowserService> {
  return createClient(BrowserService, transport(origin, authKey));
}

function transport(origin: string, authKey?: string): Transport {
  const interceptors: Interceptor[] = [];
  if (authKey !== undefined) interceptors.push((next) => (request) => {
    request.header.set("authorization", `Bearer ${authKey}`);
    return next(request);
  });
  return createConnectTransport({
    baseUrl: origin,
    httpVersion: "1.1",
    useBinaryFormat: true,
    interceptors,
    defaultTimeoutMs: REMOTE_CALL_TIMEOUT_MS
  });
}

function toProtoInputArtifact(value: BrowserAutomationInputArtifact): ProtoBrowserAutomationBinary {
  return {
    $typeName: "joko.v1.BrowserAutomationBinary",
    artifactId: value.artifactId,
    fileName: value.fileName,
    mediaType: value.mediaType,
    byteSize: BigInt(value.byteSize),
    sha256Hex: value.sha256Hex,
    data: value.data
  };
}

function remoteResultFromProto(response: ExecuteBrowserAutomationActionResponse): BrowserRemoteAutomationResult {
  const data = response.dataJson === "" ? undefined : boundedParsedJson(response.dataJson, "Remote Browser result");
  const binary = response.binary === undefined ? undefined : binaryFromProto(response.binary);
  return response.ok
    ? { ok: true, ...(data === undefined ? {} : { data }), ...(binary === undefined ? {} : { binary }) }
    : {
        ok: false,
        errorCode: safeLabel(response.errorCode, "REMOTE_BROWSER_ACTION_FAILED"),
        message: boundedText(response.message || "Remote Browser action failed.", 4_096, "Remote Browser error")
      };
}

function binaryFromProto(value: ProtoBrowserAutomationBinary): NonNullable<BrowserRemoteAutomationResult["binary"]> {
  const bytes = boundedBytes(value.data, "Remote Browser binary result");
  if (BigInt(bytes.byteLength) !== value.byteSize) throw new Error("Remote Browser binary size is invalid.");
  if (createHash("sha256").update(bytes).digest("hex") !== value.sha256Hex.toLowerCase()) {
    throw new Error("Remote Browser binary digest is invalid.");
  }
  return {
    bytes,
    mediaType: remoteMediaType(value.mediaType),
    ...(value.fileName === "" ? {} : { fileName: sanitizeBrowserFileName(value.fileName) })
  };
}

function projectionFromProto(value: ProtoBrowserAutomationNode | undefined, expectedId: string): BrowserAutomationNodeProjection {
  if (value === undefined || value.nodeId !== expectedId) throw new Error("Remote Browser node identity is invalid.");
  const generation = safeBigIntNumber(value.generation, "Remote Browser node generation");
  const capabilities = new Set<BrowserRemoteNodeCapability>();
  for (const candidate of value.capabilities) {
    if (!BROWSER_AUTOMATION_NODE_CAPABILITIES.has(candidate as BrowserRemoteNodeCapability)) {
      throw new Error("Remote Browser node advertised an unknown capability.");
    }
    capabilities.add(candidate as BrowserRemoteNodeCapability);
  }
  if (capabilities.size !== value.capabilities.length) throw new Error("Remote Browser node advertised duplicate capabilities.");
  return {
    id: expectedId,
    displayName: boundedText(value.displayName, 128, "Remote Browser node display name"),
    available: value.available,
    generation,
    capabilities,
    ...(value.error?.message === undefined || value.error.message === "" ? {} : {
      error: boundedText(value.error.message, 4_096, "Remote Browser node error")
    })
  };
}

function routeFromProjection(
  read: () => BrowserAutomationNodeProjection,
  call: (request: BrowserRemoteAutomationRequest, signal?: AbortSignal) => Promise<BrowserRemoteAutomationResult>
): BrowserRemoteNodeRoute {
  return {
    get id() { return read().id; },
    get generation() { return read().generation; },
    get available() { return read().available; },
    get capabilities() { return read().capabilities; },
    call
  };
}

function unavailableProjection(id: string): BrowserAutomationNodeProjection {
  return { id, displayName: id, available: false, generation: 1, capabilities: new Set() };
}

export function assertActionCapabilities(
  action: BrowserAutomationAction,
  arguments_: Readonly<Record<string, unknown>>,
  capabilities: ReadonlySet<BrowserRemoteNodeCapability>
): BrowserAutomationActKind | undefined {
  if (!BROWSER_AUTOMATION_ACTIONS.includes(action)) throw new Error("Browser automation action is invalid.");
  if (!capabilities.has(`action:${action}`)) throw new Error(`Browser automation node does not advertise action:${action}.`);
  let kind: BrowserAutomationActKind | undefined;
  if (action === "act") {
    const request = arguments_["request"];
    if (!isRecord(request) || typeof request["kind"] !== "string" ||
      !BROWSER_AUTOMATION_ACT_KINDS.includes(request["kind"] as BrowserAutomationActKind)) {
      throw new Error("Browser automation act kind is invalid.");
    }
    kind = request["kind"] as BrowserAutomationActKind;
    if (!capabilities.has(`act:${kind}`)) throw new Error(`Browser automation node does not advertise act:${kind}.`);
  }
  if (containsSemanticQuery(arguments_) && !capabilities.has("semantic-query")) {
    throw new Error("Browser automation node does not advertise semantic-query.");
  }
  if (action === "upload" && !capabilities.has("artifact-upload")) {
    throw new Error("Browser automation node does not advertise artifact-upload.");
  }
  return kind;
}

function containsSemanticQuery(input: Readonly<Record<string, unknown>>): boolean {
  if (input["query"] !== undefined) return true;
  const request = input["request"];
  if (!isRecord(request)) return false;
  if (request["query"] !== undefined || request["startQuery"] !== undefined || request["endQuery"] !== undefined) return true;
  return Array.isArray(request["fields"]) && request["fields"].some((field) => isRecord(field) && field["query"] !== undefined);
}

function assertLocalArtifactArguments(arguments_: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  stringArray(arguments_["paths"], 16, 512, "Browser upload artifact IDs");
  return arguments_;
}

function firstImageContent(content: readonly unknown[]): NonNullable<BrowserRemoteAutomationResult["binary"]> | undefined {
  for (const candidate of content) {
    if (!isRecord(candidate) || candidate["type"] !== "image" || typeof candidate["data"] !== "string") continue;
    const mimeType = candidate["mimeType"];
    if (mimeType !== "image/png" && mimeType !== "image/jpeg") throw new Error("Browser image result has an invalid media type.");
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(candidate["data"])) throw new Error("Browser image result is not valid base64.");
    const bytes = boundedBytes(Buffer.from(candidate["data"], "base64"), "Browser image result");
    return { bytes, mediaType: mimeType };
  }
  return undefined;
}

function findArtifactId(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || !isRecord(value)) return undefined;
  const artifact = value["artifact"];
  if (isRecord(artifact) && typeof artifact["id"] === "string") return boundedText(artifact["id"], 512, "Browser artifact ID");
  for (const child of Object.values(value)) {
    const found = findArtifactId(child, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function actKind(value: Readonly<Record<string, unknown>> | undefined): BrowserAutomationActKind | undefined {
  const data = value?.["data"];
  if (!isRecord(data) || typeof data["kind"] !== "string") return undefined;
  return BROWSER_AUTOMATION_ACT_KINDS.includes(data["kind"] as BrowserAutomationActKind)
    ? data["kind"] as BrowserAutomationActKind
    : undefined;
}

function boundedJsonRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  const parsed = boundedJsonValue(value, label);
  if (!isRecord(parsed)) throw new Error(`${label} must be an object.`);
  return parsed;
}

function boundedJsonValue(value: unknown, label: string): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAXIMUM_ARGUMENT_BYTES) {
    throw new Error(`${label} exceeds its byte limit.`);
  }
  return JSON.parse(serialized) as unknown;
}

function boundedParsedJson(value: string, label: string): unknown {
  if (Buffer.byteLength(value, "utf8") > MAXIMUM_ARGUMENT_BYTES) throw new Error(`${label} exceeds its byte limit.`);
  try { return JSON.parse(value) as unknown; }
  catch { throw new Error(`${label} is invalid JSON.`); }
}

function boundedBytes(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > MAXIMUM_BINARY_BYTES) throw new Error(`${label} exceeds its byte limit.`);
  return new Uint8Array(value);
}

function remoteMediaType(value: string): "image/png" | "image/jpeg" | "application/pdf" | "application/octet-stream" {
  return value === "image/png" || value === "image/jpeg" || value === "application/pdf"
    ? value
    : "application/octet-stream";
}

function safeMediaType(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u.test(normalized)
    ? normalized
    : "application/octet-stream";
}

function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.slice(0, 128).replace(/[^A-Za-z0-9_-]/gu, "_");
  return normalized === "" ? fallback : normalized;
}

function safeBigIntNumber(value: bigint, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || BigInt(result) !== value) throw new Error(`${label} is invalid.`);
  return result;
}

function validGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Browser automation node generation is invalid.");
  return value;
}

function validNodeId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(normalized)) throw new Error("Browser automation node ID is invalid.");
  return normalized;
}

function boundedText(value: string, maximumLength: number, label: string): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function stringArray(value: unknown, maximumItems: number, maximumLength: number, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumItems) throw new Error(`${label} are invalid.`);
  const output = value.map((item) => typeof item === "string" ? boundedText(item, maximumLength, label) : "");
  if (output.some((item) => item === "") || new Set(output).size !== output.length) throw new Error(`${label} are invalid.`);
  return output;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
