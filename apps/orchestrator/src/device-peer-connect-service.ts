import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import {
  DEVICE_PEER_AGENT_AUTHORIZATION_HEADER,
  DEVICE_PEER_PROTOCOL_VERSION,
  DevicePeerProtocolError,
  DevicePeerRegistryError,
  type DevicePeerAbortFrame,
  type DevicePeerCapability,
  type DevicePeerDispatchControl,
  type DevicePeerEffectKind,
  type DevicePeerHelloFrame,
  type DevicePeerRequestFrame,
  type DevicePeerResponseFrame,
  type DevicePeerRetireFrame,
  type DevicePeerRouteAcceptedFrame,
  type DevicePeerRouteLease,
  type DevicePeerRouteTransport,
  type DevicePeerStreamEventFrame
} from "@joko/device-peer";
import { AuthorizationError, normalizeDeviceName, type ConnectionRecord, type OperationalStore } from "@joko/store";

import { ConnectionAuthenticationError, type ConnectionManager } from "./connection-manager.js";
import {
  DevicePeerAuthorityError,
  type DevicePeerAuthority,
  type DevicePeerOwner,
  type DevicePeerSelectionIdentity,
  type DevicePeerSelectionView
} from "./device-peer-owner.js";
import { toProtoRevision } from "./proto-mapper.js";

const DEFAULT_PAGE_SIZE = 50;
const MAXIMUM_PAGE_SIZE = 100;
const MAXIMUM_RECENT_DIRECTORIES = 100;
const MAXIMUM_DIRECTORY_ENTRIES = 200;
const MAXIMUM_ROUTE_REQUEST_IDS = 8_192;
const MAXIMUM_PENDING_COMMANDS = 256;
const MAXIMUM_OUTBOUND_FRAMES = 512;
const MAXIMUM_STREAM_FRAME_BYTES = 1024 * 1024;
const MAXIMUM_IDENTIFIER_LENGTH = 256;
const MAXIMUM_PATH_LENGTH = 32_768;
const DEFAULT_SPLIT_ROUTE_ATTACHMENT_TIMEOUT_MS = 15_000;
const DEFAULT_MAXIMUM_UNATTACHED_SPLIT_ROUTES = 128;

type PeerConnections = Pick<
  ConnectionManager,
  "authenticate" | "authenticateDevicePeerAgent" | "fence" | "onRevoked" | "refreshDeviceNameSource"
>;
type PeerStore = Pick<OperationalStore, "touchConnection">;

export interface DevicePeerConnectServiceDependencies {
  readonly owner: DevicePeerOwner;
  readonly connections: PeerConnections;
  readonly store: PeerStore;
  /** Test seams retain the same production bounds with shorter deterministic deadlines. */
  readonly splitRouteAttachmentTimeoutMs?: number;
  readonly maximumUnattachedSplitRoutes?: number;
}

/**
 * Public controller RPCs and the authenticated target-agent reverse route.
 * This boundary never persists route credentials, commands, results, or
 * process/file payloads; durable product effects remain with their owners.
 */
export function createDevicePeerConnectService(
  dependencies: DevicePeerConnectServiceDependencies
): ServiceImpl<typeof contract.DevicePeerService> {
  const attachmentTimeoutMs = boundedServiceOption(
    dependencies.splitRouteAttachmentTimeoutMs,
    DEFAULT_SPLIT_ROUTE_ATTACHMENT_TIMEOUT_MS,
    1,
    60_000,
    "split route attachment timeout"
  );
  const maximumUnattachedRoutes = boundedServiceOption(
    dependencies.maximumUnattachedSplitRoutes,
    DEFAULT_MAXIMUM_UNATTACHED_SPLIT_ROUTES,
    1,
    1_024,
    "unattached split route budget"
  );
  const splitRoutes = new Map<string, SplitDevicePeerRoute>();
  return {
    listDevicePeers: async (request, context) => peerRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const peers = dependencies.owner.list(connection);
      const page = paginate(peers, request.page, `device-peers:${connection.deviceId}`);
      dependencies.connections.fence(connection);
      return create(contract.ListDevicePeersResponseSchema, {
        peers: page.values.map(toProtoPeer),
        page: page.page
      });
    }),

    listDevicePeerRecentDirectories: async (request, context) => peerRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const identity = fromProtoRouteIdentity(request.peer);
      const authority = dependencies.owner.capture(connection, identity, ["files"]);
      const command = create(contract.DevicePeerCommandSchema, {
        capability: contract.DevicePeerCapabilityKind.FILES,
        effect: contract.DevicePeerEffectKind.READ_ONLY,
        action: {
          case: "listRecentDirectories",
          value: create(contract.DevicePeerListRecentDirectoriesActionSchema, {
            maximumEntries: MAXIMUM_RECENT_DIRECTORIES
          })
        }
      });
      const payload = await dispatchCommand(
        dependencies.owner,
        authority,
        command,
        context.signal,
        "recentDirectories"
      );
      const directories = payload.value.directories;
      validateRecentDirectories(directories);
      if (payload.value.truncated) {
        throw new ConnectError("The Device peer recent-directory catalog exceeds the service budget.", Code.ResourceExhausted);
      }
      const page = paginate(directories, request.page, routePageKind("recent", identity));
      fenceController(dependencies, connection, authority);
      return create(contract.ListDevicePeerRecentDirectoriesResponseSchema, {
        peer: toProtoRouteIdentity(identity),
        directories: [...page.values],
        page: page.page
      });
    }),

    listDevicePeerDirectories: async (request, context) => peerRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const identity = fromProtoRouteIdentity(request.peer);
      const authority = dependencies.owner.capture(connection, identity, ["files"]);
      validatePath(request.path, true);
      const command = create(contract.DevicePeerCommandSchema, {
        capability: contract.DevicePeerCapabilityKind.FILES,
        effect: contract.DevicePeerEffectKind.READ_ONLY,
        action: {
          case: "listDirectories",
          value: create(contract.DevicePeerListDirectoriesActionSchema, {
            path: request.path,
            maximumEntries: MAXIMUM_DIRECTORY_ENTRIES
          })
        }
      });
      const payload = await dispatchCommand(
        dependencies.owner,
        authority,
        command,
        context.signal,
        "directories"
      );
      validateDirectoryResult(payload.value);
      fenceController(dependencies, connection, authority);
      return create(contract.ListDevicePeerDirectoriesResponseSchema, {
        peer: toProtoRouteIdentity(identity),
        path: payload.value.path,
        parentPath: payload.value.parentPath,
        directories: payload.value.directories,
        truncated: payload.value.truncated
      });
    }),

    inspectDevicePeerDirectory: async (request, context) => peerRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const identity = fromProtoRouteIdentity(request.peer);
      const authority = dependencies.owner.capture(connection, identity, ["files"]);
      validatePath(request.path, false);
      const command = create(contract.DevicePeerCommandSchema, {
        capability: contract.DevicePeerCapabilityKind.FILES,
        effect: contract.DevicePeerEffectKind.READ_ONLY,
        action: {
          case: "inspectDirectory",
          value: create(contract.DevicePeerInspectDirectoryActionSchema, { path: request.path })
        }
      });
      const payload = await dispatchCommand(
        dependencies.owner,
        authority,
        command,
        context.signal,
        "directoryInspection"
      );
      validatePath(payload.value.path, false);
      if (payload.value.kind === contract.DevicePeerDirectoryKind.UNSPECIFIED) {
        throw protocolViolation("The Device peer returned an unspecified directory kind.");
      }
      fenceController(dependencies, connection, authority);
      return create(contract.InspectDevicePeerDirectoryResponseSchema, {
        peer: toProtoRouteIdentity(identity),
        path: payload.value.path,
        kind: payload.value.kind
      });
    }),

    openDevicePeerAgentRoute: (requests, context) => mapPeerStreamErrors(
      openDevicePeerAgentRoute(dependencies, requests, context)
    ),

    openDevicePeerAgentCommandRoute: (request, context) => mapPeerStreamErrors(
      openDevicePeerAgentCommandRoute(
        dependencies,
        splitRoutes,
        request,
        context,
        attachmentTimeoutMs,
        maximumUnattachedRoutes
      )
    ),

    publishDevicePeerAgentRoute: (requests, context) => peerRpc(
      () => publishDevicePeerAgentRoute(dependencies, splitRoutes, requests, context)
    )
  } satisfies ServiceImpl<typeof contract.DevicePeerService>;
}

interface SplitDevicePeerRoute {
  readonly connectionId: string;
  readonly targetDeviceId: string;
  readonly routeGeneration: number;
  readonly helloRequestId: string;
  readonly lease: DevicePeerRouteLease;
  readonly transport: ConnectDevicePeerRouteTransport;
  readonly attachment: ReturnType<typeof deferred<boolean>>;
  attachmentTimeout?: ReturnType<typeof setTimeout>;
  attached: boolean;
}

type DevicePeerAgentInputEnvelope =
  | contract.OpenDevicePeerAgentRouteRequest
  | contract.PublishDevicePeerAgentRouteRequest;

async function* openDevicePeerAgentRoute(
  dependencies: DevicePeerConnectServiceDependencies,
  requests: AsyncIterable<contract.OpenDevicePeerAgentRouteRequest>,
  context: HandlerContext
): AsyncGenerator<contract.OpenDevicePeerAgentRouteResponse> {
  const connection = authenticateAgentRoute(dependencies.connections, context);
  const iterator = requests[Symbol.asyncIterator]();
  const first = await nextWithSignal(iterator, context.signal);
  if (first.done) throw new ConnectError("The Device peer agent route requires a hello frame.", Code.InvalidArgument);
  const hello = parseHello(first.value, connection);
  dependencies.connections.refreshDeviceNameSource(connection, hello.defaultDisplayName);
  const transport = new ConnectDevicePeerRouteTransport(hello);
  let lease: DevicePeerRouteLease | undefined;
  let stopRevocation: (() => void) | undefined;
  let pump: Promise<void> | undefined;

  try {
    lease = dependencies.owner.registerRoute(connection, transport);
    const exactLease = lease;
    stopRevocation = dependencies.connections.onRevoked(connection.id, () => {
      dependencies.owner.retireRoute(exactLease, "authority_changed");
    });
    pump = consumeAgentInput(dependencies, connection, iterator, transport).then(
      () => {
        if (!transport.closed) dependencies.owner.retireRoute(exactLease, "connection_closed");
      },
      (error: unknown) => {
        if (!(error instanceof ConnectionAuthenticationError) && !(error instanceof AuthorizationError)) {
          transport.protocolViolation();
        }
        dependencies.owner.retireRoute(exactLease, "authority_changed");
      }
    );

    for (;;) {
      const next = await transport.nextResponse(context.signal);
      if (next.done) break;
      if (next.value.payload.case !== "retire") dependencies.connections.fence(connection);
      yield next.value;
    }
  } finally {
    stopRevocation?.();
    if (lease !== undefined) dependencies.owner.retireRoute(lease, "connection_closed");
    transport.connectionClosed();
    void iterator.return?.();
    void pump?.catch(() => undefined);
  }
}

async function* openDevicePeerAgentCommandRoute(
  dependencies: DevicePeerConnectServiceDependencies,
  routes: Map<string, SplitDevicePeerRoute>,
  request: contract.OpenDevicePeerAgentCommandRouteRequest,
  context: HandlerContext,
  attachmentTimeoutMs: number,
  maximumUnattachedRoutes: number
): AsyncGenerator<contract.OpenDevicePeerAgentCommandRouteResponse> {
  const connection = authenticateAgentRoute(dependencies.connections, context);
  const hello = parseHello(request, connection);
  const unattachedCount = [...routes.values()].filter(candidate =>
    !candidate.attached && !candidate.transport.closed
      && !(candidate.connectionId === connection.id && candidate.targetDeviceId === connection.deviceId)
  ).length;
  if (unattachedCount >= maximumUnattachedRoutes) {
    throw new ConnectError("The Device peer attachment budget is exhausted.", Code.ResourceExhausted);
  }
  dependencies.connections.refreshDeviceNameSource(connection, hello.defaultDisplayName);
  const transport = new ConnectDevicePeerRouteTransport(hello);
  let entry: SplitDevicePeerRoute | undefined;
  let stopRevocation: (() => void) | undefined;

  try {
    const lease = dependencies.owner.registerRoute(connection, transport, { deferredActivation: true });
    entry = {
      connectionId: connection.id,
      targetDeviceId: lease.targetDeviceId,
      routeGeneration: lease.routeGeneration,
      helloRequestId: hello.requestId,
      lease,
      transport,
      attachment: deferred<boolean>(),
      attached: false
    };
    const key = splitRouteKey(connection.id, lease.targetDeviceId, lease.routeGeneration);
    routes.set(key, entry);
    entry.attachmentTimeout = setTimeout(() => {
      if (entry === undefined || entry.attached || routes.get(key) !== entry) return;
      routes.delete(key);
      entry.attachment.resolve(false);
      dependencies.owner.retireRoute(entry.lease, "connection_closed");
      entry.transport.connectionClosed();
    }, attachmentTimeoutMs);
    transport.closedSignal.addEventListener("abort", () => entry?.attachment.resolve(false), { once: true });
    const exactLease = lease;
    stopRevocation = dependencies.connections.onRevoked(connection.id, () => {
      dependencies.owner.retireRoute(exactLease, "authority_changed");
    });

    const accepted = await transport.nextResponse(context.signal);
    if (accepted.done) return;
    dependencies.connections.fence(connection);
    yield toSplitCommandResponse(accepted.value);
    if (!await entry.attachment.promise) {
      const retirement = await transport.nextResponse(context.signal);
      if (!retirement.done) yield toSplitCommandResponse(retirement.value);
      return;
    }

    for (;;) {
      const next = await transport.nextResponse(context.signal);
      if (next.done) break;
      if (next.value.payload.case !== "retire") dependencies.connections.fence(connection);
      yield toSplitCommandResponse(next.value);
    }
  } finally {
    stopRevocation?.();
    if (entry !== undefined) {
      if (entry.attachmentTimeout !== undefined) clearTimeout(entry.attachmentTimeout);
      entry.attachment.resolve(false);
      const key = splitRouteKey(entry.connectionId, entry.targetDeviceId, entry.routeGeneration);
      if (routes.get(key) === entry) routes.delete(key);
      dependencies.owner.retireRoute(entry.lease, "connection_closed");
    }
    transport.connectionClosed();
  }
}

async function publishDevicePeerAgentRoute(
  dependencies: DevicePeerConnectServiceDependencies,
  routes: Map<string, SplitDevicePeerRoute>,
  requests: AsyncIterable<contract.PublishDevicePeerAgentRouteRequest>,
  context: HandlerContext
): Promise<contract.PublishDevicePeerAgentRouteResponse> {
  const connection = authenticateAgentRoute(dependencies.connections, context);
  const iterator = requests[Symbol.asyncIterator]();
  const first = await nextWithSignal(iterator, context.signal);
  if (first.done) throw new ConnectError("The Device peer agent upload requires an attachment frame.", Code.InvalidArgument);
  const request = first.value;
  validatePublicIdentifier(request.requestId, "request_id");
  const routeGeneration = toSafeGeneration(request.routeGeneration);
  if (request.targetDeviceId !== connection.deviceId || request.payload.case !== "attachment") {
    throw new ConnectError("The Device peer agent upload identity is invalid.", Code.PermissionDenied);
  }
  const key = splitRouteKey(connection.id, request.targetDeviceId, routeGeneration);
  const entry = routes.get(key);
  if (entry === undefined || entry.helloRequestId !== request.requestId || entry.attached || entry.transport.closed) {
    throw new ConnectError("The Device peer agent upload route is unavailable.", Code.Aborted);
  }
  dependencies.connections.fence(connection);
  entry.attached = true;
  dependencies.owner.activateRoute(entry.lease);
  if (entry.attachmentTimeout !== undefined) clearTimeout(entry.attachmentTimeout);
  entry.attachment.resolve(true);

  try {
    await consumeAgentInput(dependencies, connection, iterator, entry.transport);
    return create(contract.PublishDevicePeerAgentRouteResponseSchema);
  } finally {
    if (routes.get(key) === entry) routes.delete(key);
    dependencies.owner.retireRoute(entry.lease, "connection_closed");
    entry.transport.connectionClosed();
    void iterator.return?.();
  }
}

function boundedServiceOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  const accepted = value ?? fallback;
  if (!Number.isSafeInteger(accepted) || accepted < minimum || accepted > maximum) {
    throw new TypeError(`The ${label} is invalid.`);
  }
  return accepted;
}

function splitRouteKey(connectionId: string, targetDeviceId: string, routeGeneration: number): string {
  return `${connectionId}\u0000${targetDeviceId}\u0000${routeGeneration}`;
}

function toSplitCommandResponse(
  response: contract.OpenDevicePeerAgentRouteResponse
): contract.OpenDevicePeerAgentCommandRouteResponse {
  return create(contract.OpenDevicePeerAgentCommandRouteResponseSchema, {
    targetDeviceId: response.targetDeviceId,
    routeGeneration: response.routeGeneration,
    requestId: response.requestId,
    payload: response.payload
  });
}

async function consumeAgentInput(
  dependencies: DevicePeerConnectServiceDependencies,
  connection: ConnectionRecord,
  iterator: AsyncIterator<DevicePeerAgentInputEnvelope>,
  transport: ConnectDevicePeerRouteTransport
): Promise<void> {
  while (!transport.closed) {
    const next = await nextWithSignal(iterator, transport.closedSignal);
    if (next.done) return;
    const request = next.value;
    transport.assertEnvelope(request);
    switch (request.payload.case) {
      case "result":
        transport.receiveResult(request.requestId, request.payload.value);
        break;
      case "heartbeat":
        transport.receiveHeartbeat(request.requestId);
        dependencies.connections.fence(connection);
        dependencies.store.touchConnection(connection.id);
        dependencies.connections.fence(connection);
        break;
      default:
        throw protocolViolation("Only result and heartbeat frames may follow Device peer hello.");
    }
  }
}

class ConnectDevicePeerRouteTransport implements DevicePeerRouteTransport {
  readonly hello: DevicePeerHelloFrame;
  readonly #helloRequestId: string;
  readonly #responses = new AsyncResponseQueue();
  readonly #listeners = new Set<(frame: DevicePeerStreamEventFrame) => void>();
  readonly #requests = new Map<string, PendingRequest>();
  readonly #requestIds = new Set<string>();
  readonly #streamSequences = new Map<string, number>();
  readonly #closedController = new AbortController();
  #lease: DevicePeerRouteAcceptedFrame | undefined;
  #closed = false;

  constructor(input: { readonly hello: DevicePeerHelloFrame; readonly requestId: string }) {
    this.hello = input.hello;
    this.#helloRequestId = input.requestId;
    this.#requestIds.add(input.requestId);
  }

  get closed(): boolean { return this.#closed; }
  get closedSignal(): AbortSignal { return this.#closedController.signal; }

  activate(frame: DevicePeerRouteAcceptedFrame): void {
    if (this.#closed || this.#lease !== undefined || frame.targetDeviceId !== this.hello.targetDeviceId
      || !sameCapabilities(frame.capabilities, this.hello.capabilities)) {
      throw protocolViolation("The assigned Device peer route does not match hello.");
    }
    this.#lease = frame;
    this.#responses.push(create(contract.OpenDevicePeerAgentRouteResponseSchema, {
      targetDeviceId: frame.targetDeviceId,
      routeGeneration: BigInt(frame.routeGeneration),
      requestId: this.#helloRequestId,
      payload: {
        case: "accepted",
        value: create(contract.DevicePeerAgentRouteAcceptedSchema, {
          capabilities: frame.capabilities.map(toProtoCapability)
        })
      }
    }));
  }

  subscribe(listener: (frame: DevicePeerStreamEventFrame) => void): { dispose(): void } {
    if (this.#closed || this.#lease === undefined) throw protocolViolation("The Device peer route is not active.");
    this.#listeners.add(listener);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.#listeners.delete(listener);
      }
    };
  }

  dispatch(frame: DevicePeerRequestFrame, control: DevicePeerDispatchControl): Promise<DevicePeerResponseFrame> {
    this.#assertRouteFrame(frame.targetDeviceId, frame.routeGeneration);
    if (this.#requests.size >= MAXIMUM_PENDING_COMMANDS) {
      throw new DevicePeerProtocolError("authority_changed", "The active Device peer command budget is exhausted.");
    }
    if (this.#requestIds.has(frame.requestId)) throw protocolViolation("The Device peer request identity was reused.");
    const command = requireCommand(frame);
    this.#rememberRequestId(frame.requestId);
    const pending = deferred<DevicePeerResponseFrame>();
    const request: PendingRequest = {
      requestId: frame.requestId,
      action: command.action.case,
      effectKind: frame.effectKind,
      controllerAccepted: false,
      agentAccepted: false,
      dispatchTerminal: false,
      streamTerminal: false,
      sequence: 0,
      resolve: pending.resolve,
      reject: pending.reject
    };
    this.#requests.set(frame.requestId, request);
    try {
      // The controller-side route/claim fence must succeed before the command
      // becomes visible to the target. From this point onward a lost target
      // ACCEPTED upload is conservatively unknown for side effects.
      control.accepted();
      request.controllerAccepted = true;
      this.#responses.push(create(contract.OpenDevicePeerAgentRouteResponseSchema, {
        targetDeviceId: frame.targetDeviceId,
        routeGeneration: BigInt(frame.routeGeneration),
        requestId: frame.requestId,
        payload: { case: "command", value: command }
      }));
    } catch (error) {
      this.#requests.delete(frame.requestId);
      pending.reject(error);
    }
    return pending.promise;
  }

  abort(frame: DevicePeerAbortFrame): void {
    if (this.#closed) return;
    this.#assertRouteFrame(frame.targetDeviceId, frame.routeGeneration);
    if (!this.#requests.has(frame.requestId)) return;
    this.#responses.push(create(contract.OpenDevicePeerAgentRouteResponseSchema, {
      targetDeviceId: frame.targetDeviceId,
      routeGeneration: BigInt(frame.routeGeneration),
      requestId: frame.requestId,
      payload: { case: "abort", value: create(contract.DevicePeerAbortCommandSchema) }
    }));
  }

  retire(frame: DevicePeerRetireFrame): void {
    if (this.#closed) return;
    this.#assertRouteFrame(frame.targetDeviceId, frame.routeGeneration);
    this.#finish(toProtoRetireReason(frame.reason));
  }

  assertEnvelope(request: DevicePeerAgentInputEnvelope): void {
    const lease = this.#requireLease();
    if (request.targetDeviceId !== lease.targetDeviceId
      || toSafeGeneration(request.routeGeneration) !== lease.routeGeneration) {
      throw protocolViolation("The Device peer agent frame does not belong to the active route.");
    }
    validateIdentifier(request.requestId, "request_id");
  }

  receiveHeartbeat(requestId: string): void {
    if (this.#requestIds.has(requestId)) throw protocolViolation("A Device peer heartbeat request identity was reused.");
    this.#rememberRequestId(requestId);
  }

  receiveResult(requestId: string, result: contract.DevicePeerAgentResult): void {
    const request = this.#requests.get(requestId);
    if (request === undefined || request.streamTerminal) {
      throw protocolViolation("The Device peer result does not belong to an active command.");
    }
    const sequence = toSafeSequence(result.sequence);
    if (sequence !== request.sequence + 1) throw protocolViolation("Device peer result sequence is not contiguous.");
    request.sequence = sequence;

    switch (result.phase) {
      case contract.DevicePeerResponsePhase.ACCEPTED:
        this.#accept(request, result);
        return;
      case contract.DevicePeerResponsePhase.STARTED:
        this.#progress(request, result);
        return;
      case contract.DevicePeerResponsePhase.COMPLETED:
        this.#complete(request, result);
        return;
      case contract.DevicePeerResponsePhase.FAILED:
        this.#fail(request, result, "failed");
        return;
      case contract.DevicePeerResponsePhase.ABORTED:
        this.#abort(request, result);
        return;
      case contract.DevicePeerResponsePhase.OUTCOME_UNKNOWN:
        this.#fail(request, result, "outcome_unknown");
        return;
      default:
        throw protocolViolation("The Device peer result phase is unspecified.");
    }
  }

  protocolViolation(): void {
    this.#finish(contract.DevicePeerRetireReason.PROTOCOL_VIOLATION);
  }

  connectionClosed(): void {
    this.#finish(contract.DevicePeerRetireReason.CONNECTION_RETIRED);
  }

  nextResponse(signal: AbortSignal): Promise<IteratorResult<contract.OpenDevicePeerAgentRouteResponse>> {
    return this.#responses.next(signal);
  }

  #accept(request: PendingRequest, result: contract.DevicePeerAgentResult): void {
    if (!request.controllerAccepted || request.agentAccepted || request.dispatchTerminal
      || result.payload.case !== "acknowledgement") {
      throw protocolViolation("The Device peer command acceptance is invalid.");
    }
    request.agentAccepted = true;
  }

  #progress(request: PendingRequest, result: contract.DevicePeerAgentResult): void {
    if (!request.agentAccepted) throw protocolViolation("The Device peer command started before acceptance.");
    if (result.payload.case === "acknowledgement") return;
    const event = this.#toStreamEvent(request, result.payload);
    for (const listener of this.#listeners) listener(event);
    if (isTerminalStreamPayload(request.action, result.payload.case)) {
      request.streamTerminal = true;
      this.#requests.delete(request.requestId);
    }
  }

  #complete(request: PendingRequest, result: contract.DevicePeerAgentResult): void {
    if (!request.agentAccepted || request.dispatchTerminal) {
      throw protocolViolation("The Device peer command completion is invalid.");
    }
    const expected = completedPayloadCase(request.action);
    if (result.payload.case !== expected) throw protocolViolation("The Device peer command returned the wrong result shape.");
    if (isStreamStartAction(request.action)) {
      this.#assertStreamOwner(request, completedStreamOwnerId(request.action, result.payload));
    }
    request.dispatchTerminal = true;
    request.resolve(responseFrame(this.#requireLease(), request.requestId, {
      outcome: "completed",
      value: result.payload
    }));
    if (!isStreamStartAction(request.action)) {
      request.streamTerminal = true;
      this.#requests.delete(request.requestId);
    }
  }

  #fail(
    request: PendingRequest,
    result: contract.DevicePeerAgentResult,
    outcome: "failed" | "outcome_unknown"
  ): void {
    if (!request.agentAccepted || request.dispatchTerminal || result.payload.case !== "failure") {
      throw protocolViolation("The Device peer failure result is invalid.");
    }
    const errorCode = failureCode(result.payload.value.code);
    request.dispatchTerminal = true;
    request.streamTerminal = true;
    this.#requests.delete(request.requestId);
    request.resolve(responseFrame(this.#requireLease(), request.requestId, {
      outcome,
      errorCode,
      failure: result.payload.value
    }));
  }

  #abort(request: PendingRequest, result: contract.DevicePeerAgentResult): void {
    if (!request.agentAccepted || request.dispatchTerminal || result.payload.case !== "failure"
      || result.payload.value.code !== contract.DevicePeerFailureCode.CANCELLED) {
      throw protocolViolation("The Device peer abort result is invalid.");
    }
    request.dispatchTerminal = true;
    request.streamTerminal = true;
    this.#requests.delete(request.requestId);
    request.resolve(responseFrame(this.#requireLease(), request.requestId, { outcome: "aborted" }));
  }

  #toStreamEvent(
    request: PendingRequest,
    payload: contract.DevicePeerAgentResult["payload"]
  ): DevicePeerStreamEventFrame {
    const lease = this.#requireLease();
    const identity = {
      protocolVersion: DEVICE_PEER_PROTOCOL_VERSION,
      kind: "stream_event" as const,
      requestId: request.requestId,
      targetDeviceId: lease.targetDeviceId,
      routeGeneration: lease.routeGeneration
    };
    switch (payload.case) {
      case "processOutput": {
        requireAction(request.action, "startProcess");
        requireStreamBytes(payload.value.data);
        const streamId = payload.value.processId;
        validateIdentifier(streamId, "process_id");
        this.#assertStreamOwner(request, streamId);
        if (payload.value.stream !== contract.DevicePeerProcessOutputStream.STANDARD_OUTPUT
          && payload.value.stream !== contract.DevicePeerProcessOutputStream.STANDARD_ERROR) {
          throw protocolViolation("The Device peer process output stream is unspecified.");
        }
        return {
          ...identity,
          streamId,
          sequence: this.#nextStreamSequence(request.requestId, streamId),
          channel: payload.value.stream === contract.DevicePeerProcessOutputStream.STANDARD_OUTPUT
            ? "process_stdout" : "process_stderr",
          data: payload.value.data
        };
      }
      case "processExited": {
        requireAction(request.action, "startProcess");
        const streamId = payload.value.processId;
        validateIdentifier(streamId, "process_id");
        this.#assertStreamOwner(request, streamId);
        return {
          ...identity,
          streamId,
          sequence: this.#nextStreamSequence(request.requestId, streamId),
          channel: "process_exit",
          exitCode: payload.value.exitCode ?? null,
          signal: payload.value.signalName ?? null
        };
      }
      case "terminalOutput": {
        requireAction(request.action, "openTerminal");
        requireStreamBytes(payload.value.data);
        const streamId = payload.value.terminalId;
        validateIdentifier(streamId, "terminal_id");
        this.#assertStreamOwner(request, streamId);
        let data: string;
        try { data = new TextDecoder("utf-8", { fatal: true }).decode(payload.value.data); }
        catch { throw protocolViolation("The Device peer terminal output is not valid UTF-8."); }
        return {
          ...identity,
          streamId,
          sequence: this.#nextStreamSequence(request.requestId, streamId),
          channel: "terminal_data",
          data
        };
      }
      case "terminalExited": {
        requireAction(request.action, "openTerminal");
        const streamId = payload.value.terminalId;
        validateIdentifier(streamId, "terminal_id");
        this.#assertStreamOwner(request, streamId);
        if (payload.value.exitCode === undefined) {
          throw protocolViolation("The Device peer terminal exit code is required.");
        }
        return {
          ...identity,
          streamId,
          sequence: this.#nextStreamSequence(request.requestId, streamId),
          channel: "terminal_exit",
          exitCode: payload.value.exitCode,
          signal: payload.value.signal ?? null,
          failureCode: null,
          processExitConfirmed: true
        };
      }
      case "loopbackForwardData": {
        requireAction(request.action, "openLoopbackForward");
        requireStreamBytes(payload.value.data);
        const streamId = payload.value.forwardId;
        validateIdentifier(streamId, "forward_id");
        this.#assertStreamOwner(request, streamId);
        return {
          ...identity,
          streamId,
          sequence: this.#nextStreamSequence(request.requestId, streamId),
          channel: "forward_data",
          data: payload.value.data
        };
      }
      case "loopbackForwardClosed": {
        requireAction(request.action, "openLoopbackForward");
        const streamId = payload.value.forwardId;
        validateIdentifier(streamId, "forward_id");
        this.#assertStreamOwner(request, streamId);
        return {
          ...identity,
          streamId,
          sequence: this.#nextStreamSequence(request.requestId, streamId),
          channel: "forward_close",
          errorCode: null
        };
      }
      case "reverseForwardConnectionOpened": {
        requireAction(request.action, "listenLoopbackForward");
        validateIdentifier(payload.value.listenerId, "listener_id");
        this.#assertStreamOwner(request, payload.value.listenerId);
        const streamId = payload.value.connectionId;
        validateIdentifier(streamId, "connection_id");
        return {
          ...identity,
          streamId,
          sequence: this.#nextStreamSequence(request.requestId, streamId),
          channel: "reverse_forward_open"
        };
      }
      case "reverseForwardData": {
        requireAction(request.action, "listenLoopbackForward");
        validateIdentifier(payload.value.listenerId, "listener_id");
        this.#assertStreamOwner(request, payload.value.listenerId);
        const streamId = payload.value.connectionId;
        validateIdentifier(streamId, "connection_id");
        requireStreamBytes(payload.value.data);
        return {
          ...identity,
          streamId,
          sequence: this.#nextStreamSequence(request.requestId, streamId),
          channel: "reverse_forward_data",
          data: payload.value.data
        };
      }
      case "reverseForwardConnectionClosed": {
        requireAction(request.action, "listenLoopbackForward");
        validateIdentifier(payload.value.listenerId, "listener_id");
        this.#assertStreamOwner(request, payload.value.listenerId);
        const streamId = payload.value.connectionId;
        validateIdentifier(streamId, "connection_id");
        return {
          ...identity,
          streamId,
          sequence: this.#nextStreamSequence(request.requestId, streamId),
          channel: "reverse_forward_close",
          errorCode: null
        };
      }
      case "loopbackListenerClosed": {
        requireAction(request.action, "listenLoopbackForward");
        const streamId = payload.value.listenerId;
        validateIdentifier(streamId, "listener_id");
        this.#assertStreamOwner(request, streamId);
        return {
          ...identity,
          streamId,
          sequence: this.#nextStreamSequence(request.requestId, streamId),
          channel: "forward_close",
          errorCode: null
        };
      }
      default:
        throw protocolViolation("The Device peer STARTED result payload is invalid.");
    }
  }

  #nextStreamSequence(requestId: string, streamId: string): number {
    const key = `${requestId}\u0000${streamId}`;
    const sequence = (this.#streamSequences.get(key) ?? 0) + 1;
    this.#streamSequences.set(key, sequence);
    return sequence;
  }

  #assertStreamOwner(request: PendingRequest, ownerId: string): void {
    validateIdentifier(ownerId, "stream owner id");
    if (request.streamOwnerId === undefined) request.streamOwnerId = ownerId;
    else if (request.streamOwnerId !== ownerId) {
      throw protocolViolation("The Device peer stream owner identity changed.");
    }
  }

  #assertRouteFrame(targetDeviceId: string, routeGeneration: number): void {
    const lease = this.#requireLease();
    if (this.#closed || targetDeviceId !== lease.targetDeviceId || routeGeneration !== lease.routeGeneration) {
      throw protocolViolation("The Device peer frame does not belong to the active route.");
    }
  }

  #requireLease(): DevicePeerRouteAcceptedFrame {
    if (this.#lease === undefined) throw protocolViolation("The Device peer route is not active.");
    return this.#lease;
  }

  #rememberRequestId(requestId: string): void {
    if (this.#requestIds.size >= MAXIMUM_ROUTE_REQUEST_IDS) {
      throw protocolViolation("The Device peer route request identity budget is exhausted.");
    }
    this.#requestIds.add(requestId);
  }

  #finish(reason: contract.DevicePeerRetireReason): void {
    if (this.#closed) return;
    this.#closed = true;
    const lease = this.#lease;
    if (lease !== undefined) {
      try {
        this.#responses.push(create(contract.OpenDevicePeerAgentRouteResponseSchema, {
          targetDeviceId: lease.targetDeviceId,
          routeGeneration: BigInt(lease.routeGeneration),
          requestId: this.#helloRequestId,
          payload: {
            case: "retire",
            value: create(contract.DevicePeerRetireRouteSchema, { reason })
          }
        }));
      } catch {
        // A full/closed response queue already makes the route unusable.
      }
    }
    const error = new DevicePeerProtocolError("authority_changed", "The Device peer route retired.");
    for (const request of this.#requests.values()) {
      if (!request.dispatchTerminal) request.reject(error);
    }
    this.#requests.clear();
    this.#listeners.clear();
    this.#responses.close();
    this.#closedController.abort();
  }
}

interface PendingRequest {
  readonly requestId: string;
  readonly action: contract.DevicePeerCommand["action"]["case"];
  readonly effectKind: DevicePeerEffectKind;
  controllerAccepted: boolean;
  agentAccepted: boolean;
  dispatchTerminal: boolean;
  streamTerminal: boolean;
  streamOwnerId?: string;
  sequence: number;
  readonly resolve: (value: DevicePeerResponseFrame) => void;
  readonly reject: (error: unknown) => void;
}

class AsyncResponseQueue {
  readonly #values: contract.OpenDevicePeerAgentRouteResponse[] = [];
  readonly #waiters: Array<{
    readonly resolve: (value: IteratorResult<contract.OpenDevicePeerAgentRouteResponse>) => void;
    readonly reject: (error: unknown) => void;
    readonly signal: AbortSignal;
    readonly onAbort: () => void;
  }> = [];
  #closed = false;

  push(value: contract.OpenDevicePeerAgentRouteResponse): void {
    if (this.#closed) throw protocolViolation("The Device peer response route is closed.");
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve({ done: false, value });
      return;
    }
    if (this.#values.length >= MAXIMUM_OUTBOUND_FRAMES) {
      throw protocolViolation("The Device peer response queue budget is exhausted.");
    }
    this.#values.push(value);
  }

  next(signal: AbortSignal): Promise<IteratorResult<contract.OpenDevicePeerAgentRouteResponse>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    if (signal.aborted) return Promise.reject(new ConnectError("The Device peer route was cancelled.", Code.Canceled));
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.#waiters.findIndex((candidate) => candidate.onAbort === onAbort);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new ConnectError("The Device peer route was cancelled.", Code.Canceled));
      };
      this.#waiters.push({ resolve, reject, signal, onAbort });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve({ done: true, value: undefined });
    }
  }
}

async function dispatchCommand<TCase extends contract.DevicePeerAgentResult["payload"]["case"]>(
  owner: DevicePeerOwner,
  authority: DevicePeerAuthority,
  command: contract.DevicePeerCommand,
  signal: AbortSignal,
  expectedCase: TCase
): Promise<Extract<contract.DevicePeerAgentResult["payload"], { case: TCase }>> {
  const metadata = commandMetadata(command);
  const action = command.action.case;
  if (action === undefined) throw protocolViolation("The Device peer command action is required.");
  const response = await owner.dispatch(authority, {
    capability: metadata.capability,
    effectKind: metadata.effectKind,
    action,
    payload: command,
    signal
  });
  switch (response.outcome) {
    case "completed": {
      const payload = response.value as contract.DevicePeerAgentResult["payload"];
      if (!isAgentPayload(payload) || payload.case !== expectedCase) {
        throw protocolViolation("The Device peer response payload does not match the requested action.");
      }
      return payload as Extract<contract.DevicePeerAgentResult["payload"], { case: TCase }>;
    }
    case "failed":
      throw targetFailure(response.errorCode);
    case "aborted":
      throw new ConnectError("The Device peer request was cancelled.", Code.Canceled);
    case "outcome_unknown":
      throw new ConnectError("The Device peer request outcome is unknown.", Code.Aborted);
  }
}

function requireCommand(frame: DevicePeerRequestFrame): contract.DevicePeerCommand {
  if (!isMessage(frame.payload, "joko.v1.DevicePeerCommand")) {
    throw protocolViolation("The Device peer command payload is invalid.");
  }
  const command = frame.payload as contract.DevicePeerCommand;
  const metadata = commandMetadata(command);
  if (metadata.capability !== frame.capability || metadata.effectKind !== frame.effectKind
    || command.action.case !== frame.action || command.controllerDeviceId !== frame.controllerDeviceId) {
    throw protocolViolation("The Device peer command declarations do not match its action.");
  }
  return command;
}

function commandMetadata(command: contract.DevicePeerCommand): {
  readonly capability: DevicePeerCapability;
  readonly effectKind: DevicePeerEffectKind;
} {
  const action = command.action.case;
  if (action === undefined) throw protocolViolation("The Device peer command action is required.");
  const readOnly = action === "listRecentDirectories" || action === "listDirectories"
    || action === "inspectDirectory" || action === "realpath" || action === "statFile"
    || action === "listFiles" || action === "readFile"
    || action === "getRemoteDesktopCapabilities" || action === "getRemoteDesktopPermissions"
    || action === "getRemoteDesktopFrame" || action === "probeRemoteDesktopPresentation"
    || action === "listRemoteDesktopDisplayModes";
  const capability: DevicePeerCapability = action === "startProcess" || action === "writeProcess" || action === "signalProcess"
    ? "process"
    : action === "openTerminal" || action === "writeTerminal" || action === "resizeTerminal"
      || action === "killTerminal" || action === "pauseTerminal" || action === "resumeTerminal"
      ? "terminal"
      : action === "openLoopbackForward" || action === "writeLoopbackForward"
        || action === "closeLoopbackForward" || action === "listenLoopbackForward"
        || action === "writeReverseForward" || action === "closeReverseForwardConnection"
        || action === "closeLoopbackListener"
        ? "forwarding"
        : action === "getRemoteDesktopCapabilities" || action === "getRemoteDesktopPermissions"
          || action === "showRemoteDesktopPermissionGuide" || action === "startRemoteDesktop"
          || action === "heartbeatRemoteDesktop" || action === "stopRemoteDesktop"
          || action === "setRemoteDesktopControl" || action === "setRemoteDesktopPresentation"
          || action === "probeRemoteDesktopPresentation" || action === "sendRemoteDesktopInput"
          || action === "createRemoteDesktopOffer" || action === "exchangeRemoteDesktopIce"
          || action === "getRemoteDesktopFrame" || action === "transferRemoteDesktopClipboardText"
          || action === "transferRemoteDesktopClipboardContent"
          || action === "listRemoteDesktopDisplayModes" || action === "setRemoteDesktopDisplayMode"
          ? "remote_desktop"
          : "files";
  const effectKind: DevicePeerEffectKind = readOnly ? "read_only" : "side_effect";
  if (command.capability !== toProtoCapability(capability)
    || command.effect !== (readOnly ? contract.DevicePeerEffectKind.READ_ONLY : contract.DevicePeerEffectKind.SIDE_EFFECT)) {
    throw protocolViolation("The Device peer command capability or effect is invalid.");
  }
  return { capability, effectKind };
}

function completedPayloadCase(
  action: contract.DevicePeerCommand["action"]["case"]
): contract.DevicePeerAgentResult["payload"]["case"] {
  switch (action) {
    case "listRecentDirectories": return "recentDirectories";
    case "listDirectories": return "directories";
    case "inspectDirectory": return "directoryInspection";
    case "createDirectory": return "directoryCreated";
    case "realpath": return "realpath";
    case "statFile": return "fileStat";
    case "listFiles": return "fileList";
    case "readFile": return "fileRead";
    case "writeFile":
    case "renameFile":
    case "removeFile": return "fileMutation";
    case "startProcess": return "processStarted";
    case "openTerminal": return "terminalOpened";
    case "openLoopbackForward": return "loopbackForwardOpened";
    case "listenLoopbackForward": return "loopbackListenerOpened";
    case "getRemoteDesktopCapabilities": return "remoteDesktopCapabilities";
    case "getRemoteDesktopPermissions": return "remoteDesktopPermissions";
    case "startRemoteDesktop": return "remoteDesktopLease";
    case "heartbeatRemoteDesktop":
    case "setRemoteDesktopControl":
    case "setRemoteDesktopPresentation": return "remoteDesktopControlState";
    case "probeRemoteDesktopPresentation": return "remoteDesktopPresentationProof";
    case "createRemoteDesktopOffer": return "remoteDesktopOffer";
    case "exchangeRemoteDesktopIce": return "remoteDesktopIce";
    case "getRemoteDesktopFrame": return "remoteDesktopFrame";
    case "transferRemoteDesktopClipboardText": return "remoteDesktopClipboardText";
    case "transferRemoteDesktopClipboardContent": return "remoteDesktopClipboardContent";
    case "listRemoteDesktopDisplayModes": return "remoteDesktopDisplayModes";
    case "writeProcess":
    case "signalProcess":
    case "writeTerminal":
    case "resizeTerminal":
    case "killTerminal":
    case "pauseTerminal":
    case "resumeTerminal":
    case "writeLoopbackForward":
    case "closeLoopbackForward":
    case "writeReverseForward":
    case "closeReverseForwardConnection":
    case "closeLoopbackListener":
    case "showRemoteDesktopPermissionGuide":
    case "stopRemoteDesktop":
    case "sendRemoteDesktopInput": return "acknowledgement";
    case "setRemoteDesktopDisplayMode": return "acknowledgement";
    case undefined: throw protocolViolation("The Device peer command action is required.");
  }
}

function isStreamStartAction(action: PendingRequest["action"]): boolean {
  return action === "startProcess" || action === "openTerminal"
    || action === "openLoopbackForward" || action === "listenLoopbackForward";
}

function completedStreamOwnerId(
  action: PendingRequest["action"],
  payload: contract.DevicePeerAgentResult["payload"]
): string {
  if (action === "startProcess" && payload.case === "processStarted") return payload.value.processId;
  if (action === "openTerminal" && payload.case === "terminalOpened") return payload.value.terminalId;
  if (action === "openLoopbackForward" && payload.case === "loopbackForwardOpened") return payload.value.forwardId;
  if (action === "listenLoopbackForward" && payload.case === "loopbackListenerOpened") return payload.value.listenerId;
  throw protocolViolation("The Device peer stream start result is invalid.");
}

function isTerminalStreamPayload(
  action: PendingRequest["action"],
  payload: contract.DevicePeerAgentResult["payload"]["case"]
): boolean {
  return action === "startProcess" && payload === "processExited"
    || action === "openTerminal" && payload === "terminalExited"
    || action === "openLoopbackForward" && payload === "loopbackForwardClosed"
    || action === "listenLoopbackForward" && payload === "loopbackListenerClosed";
}

function responseFrame(
  lease: DevicePeerRouteAcceptedFrame,
  requestId: string,
  outcome: { readonly outcome: "completed"; readonly value: unknown }
    | { readonly outcome: "failed" | "outcome_unknown"; readonly errorCode: string; readonly failure?: unknown }
    | { readonly outcome: "aborted" }
): DevicePeerResponseFrame {
  return Object.freeze({
    protocolVersion: DEVICE_PEER_PROTOCOL_VERSION,
    kind: "response" as const,
    requestId,
    targetDeviceId: lease.targetDeviceId,
    routeGeneration: lease.routeGeneration,
    ...outcome
  }) as DevicePeerResponseFrame;
}

function parseHello(
  request: contract.OpenDevicePeerAgentRouteRequest | contract.OpenDevicePeerAgentCommandRouteRequest,
  connection: ConnectionRecord
): { readonly hello: DevicePeerHelloFrame; readonly requestId: string; readonly defaultDisplayName: string } {
  validatePublicIdentifier(request.requestId, "request_id");
  if (request.targetDeviceId !== connection.deviceId || request.routeGeneration !== 0n
    || request.payload.case !== "hello") {
    throw new ConnectError("The Device peer hello identity is invalid.", Code.PermissionDenied);
  }
  const capabilities = request.payload.value.capabilities.map(fromProtoCapability);
  if (capabilities.length === 0 || new Set(capabilities).size !== capabilities.length) {
    throw new ConnectError("The Device peer hello capabilities are invalid.", Code.InvalidArgument);
  }
  const source = request.payload.value.deviceNameSource;
  let defaultDisplayName: string;
  try {
    if (source === undefined) throw new TypeError("Device name source is required.");
    defaultDisplayName = normalizeDeviceName(source.defaultDisplayName);
  } catch {
    throw new ConnectError("The Device peer native name source is invalid.", Code.InvalidArgument);
  }
  return {
    requestId: request.requestId,
    defaultDisplayName,
    hello: Object.freeze({
      protocolVersion: DEVICE_PEER_PROTOCOL_VERSION,
      kind: "hello",
      targetDeviceId: connection.deviceId,
      capabilities: Object.freeze(capabilities)
    })
  };
}

function authenticate(connections: PeerConnections, context: HandlerContext): ConnectionRecord {
  return connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
}

function authenticateAgentRoute(
  connections: PeerConnections,
  context: HandlerContext
): ConnectionRecord {
  return connections.authenticateDevicePeerAgent(
    context.requestHeader.get(DEVICE_PEER_AGENT_AUTHORIZATION_HEADER) ?? undefined
  );
}

function fenceController(
  dependencies: DevicePeerConnectServiceDependencies,
  connection: ConnectionRecord,
  authority: DevicePeerAuthority
): void {
  authority.assertCurrent(["files"]);
  dependencies.connections.fence(connection);
}

export function fromProtoRouteIdentity(value: contract.DevicePeerRouteIdentity | undefined): DevicePeerSelectionIdentity {
  if (value === undefined) throw new ConnectError("Device peer identity is required.", Code.InvalidArgument);
  validatePublicIdentifier(value.targetDeviceId, "target_device_id");
  validatePublicIdentifier(value.relationId, "relation_id");
  const targetRevision = value.targetDeviceRevision?.value;
  const relationRevision = value.relationRevision?.value;
  if (targetRevision === undefined || targetRevision < 1n || relationRevision === undefined || relationRevision < 0n) {
    throw new ConnectError("Device peer revision identity is invalid.", Code.InvalidArgument);
  }
  return {
    targetDeviceId: value.targetDeviceId,
    relationId: value.relationId,
    targetDeviceRevision: targetRevision,
    relationRevision,
    routeGeneration: toSafeGeneration(value.routeGeneration)
  };
}

function toProtoRouteIdentity(value: DevicePeerSelectionIdentity): contract.DevicePeerRouteIdentity {
  return create(contract.DevicePeerRouteIdentitySchema, {
    targetDeviceId: value.targetDeviceId,
    relationId: value.relationId,
    targetDeviceRevision: toProtoRevision(value.targetDeviceRevision),
    relationRevision: toProtoRevision(value.relationRevision),
    routeGeneration: BigInt(value.routeGeneration)
  });
}

function toProtoPeer(value: DevicePeerSelectionView): contract.DevicePeerDescriptor {
  return create(contract.DevicePeerDescriptorSchema, {
    route: toProtoRouteIdentity(value),
    displayName: value.displayName,
    kind: value.kind === "desktop" ? contract.DeviceKind.DESKTOP : contract.DeviceKind.SERVICE,
    platform: value.platform,
    presence: contract.DevicePresenceState.ONLINE,
    capabilities: value.capabilities.map(toProtoCapability)
  });
}

function toProtoCapability(value: DevicePeerCapability): contract.DevicePeerCapabilityKind {
  switch (value) {
    case "files": return contract.DevicePeerCapabilityKind.FILES;
    case "process": return contract.DevicePeerCapabilityKind.PROCESS;
    case "terminal": return contract.DevicePeerCapabilityKind.TERMINAL;
    case "forwarding": return contract.DevicePeerCapabilityKind.FORWARDING;
    case "remote_desktop": return contract.DevicePeerCapabilityKind.REMOTE_DESKTOP;
  }
}

function fromProtoCapability(value: contract.DevicePeerCapabilityKind): DevicePeerCapability {
  switch (value) {
    case contract.DevicePeerCapabilityKind.FILES: return "files";
    case contract.DevicePeerCapabilityKind.PROCESS: return "process";
    case contract.DevicePeerCapabilityKind.TERMINAL: return "terminal";
    case contract.DevicePeerCapabilityKind.FORWARDING: return "forwarding";
    case contract.DevicePeerCapabilityKind.REMOTE_DESKTOP: return "remote_desktop";
    default: throw new ConnectError("The Device peer capability is invalid.", Code.InvalidArgument);
  }
}

function toProtoRetireReason(value: DevicePeerRetireFrame["reason"]): contract.DevicePeerRetireReason {
  switch (value) {
    case "replaced": return contract.DevicePeerRetireReason.REPLACED;
    case "connection_closed": return contract.DevicePeerRetireReason.CONNECTION_RETIRED;
    case "authority_changed": return contract.DevicePeerRetireReason.DEVICE_REVOKED;
    case "shutdown": return contract.DevicePeerRetireReason.SERVICE_SHUTDOWN;
  }
}

function failureCode(value: contract.DevicePeerFailureCode): string {
  switch (value) {
    case contract.DevicePeerFailureCode.INVALID_REQUEST: return "invalid_request";
    case contract.DevicePeerFailureCode.NOT_FOUND: return "not_found";
    case contract.DevicePeerFailureCode.NOT_DIRECTORY: return "not_directory";
    case contract.DevicePeerFailureCode.PERMISSION_DENIED: return "permission_denied";
    case contract.DevicePeerFailureCode.CAPABILITY_UNAVAILABLE: return "capability_unavailable";
    case contract.DevicePeerFailureCode.CONFLICT: return "conflict";
    case contract.DevicePeerFailureCode.CANCELLED: return "cancelled";
    case contract.DevicePeerFailureCode.TIMEOUT: return "timeout";
    case contract.DevicePeerFailureCode.PROCESS_FAILED: return "process_failed";
    case contract.DevicePeerFailureCode.UNAVAILABLE: return "unavailable";
    case contract.DevicePeerFailureCode.INTERNAL: return "internal";
    default: throw protocolViolation("The Device peer failure code is unspecified.");
  }
}

function targetFailure(code: string): ConnectError {
  const connectCode = code === "invalid_request" ? Code.InvalidArgument
    : code === "not_found" ? Code.NotFound
      : code === "not_directory" || code === "conflict" || code === "capability_unavailable"
        ? Code.FailedPrecondition
        : code === "permission_denied" ? Code.PermissionDenied
          : code === "cancelled" ? Code.Canceled
            : code === "timeout" || code === "unavailable" ? Code.Unavailable
              : Code.Internal;
  return new ConnectError(`The Device peer request failed (${code}).`, connectCode);
}

function validateRecentDirectories(values: readonly contract.DevicePeerRecentDirectory[]): void {
  if (values.length > MAXIMUM_RECENT_DIRECTORIES) throw protocolViolation("The Device peer returned too many recent directories.");
  for (const value of values) {
    validateDisplayText(value.name, "recent directory name");
    validatePath(value.path, false);
    if (value.availability !== contract.DevicePeerDirectoryAvailability.EXISTS
      && value.availability !== contract.DevicePeerDirectoryAvailability.MISSING) {
      throw protocolViolation("The Device peer recent-directory availability is unspecified.");
    }
    if (value.lastUsedAt === undefined) throw protocolViolation("The Device peer recent-directory timestamp is required.");
  }
}

function validateDirectoryResult(value: contract.DevicePeerDirectoriesResult): void {
  validatePath(value.path, false);
  if (value.parentPath !== "") validatePath(value.parentPath, false);
  if (value.directories.length > MAXIMUM_DIRECTORY_ENTRIES) {
    throw protocolViolation("The Device peer returned too many directory entries.");
  }
  for (const entry of value.directories) {
    validateDisplayText(entry.name, "directory name");
    validatePath(entry.path, false);
  }
}

function validateDisplayText(value: string, label: string): void {
  if (value.length < 1 || value.length > 1_024 || value.trim() !== value || hasControl(value)) {
    throw protocolViolation(`The Device peer ${label} is invalid.`);
  }
}

function validatePath(value: string, allowEmpty: boolean): void {
  if ((!allowEmpty && value.length === 0) || value.length > MAXIMUM_PATH_LENGTH || hasControl(value)) {
    throw new ConnectError("The Device peer path is invalid.", Code.InvalidArgument);
  }
}

function validateIdentifier(value: string, label: string): void {
  if (value.length < 1 || value.length > MAXIMUM_IDENTIFIER_LENGTH || value.trim() !== value || hasControl(value)) {
    throw protocolViolation(`The Device peer ${label} is invalid.`);
  }
}

function validatePublicIdentifier(value: string, label: string): void {
  if (value.length < 1 || value.length > MAXIMUM_IDENTIFIER_LENGTH || value.trim() !== value || hasControl(value)) {
    throw new ConnectError(`The Device peer ${label} is invalid.`, Code.InvalidArgument);
  }
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function requireStreamBytes(value: Uint8Array): void {
  if (value.byteLength > MAXIMUM_STREAM_FRAME_BYTES) {
    throw protocolViolation("The Device peer stream frame exceeds the byte budget.");
  }
}

function requireAction(actual: PendingRequest["action"], expected: PendingRequest["action"]): void {
  if (actual !== expected) throw protocolViolation("The Device peer stream payload does not match its command.");
}

function toSafeGeneration(value: bigint): number {
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConnectError("The Device peer route generation is invalid.", Code.InvalidArgument);
  }
  return Number(value);
}

function toSafeSequence(value: bigint): number {
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw protocolViolation("The Device peer result sequence is invalid.");
  }
  return Number(value);
}

function isMessage(value: unknown, typeName: string): boolean {
  return typeof value === "object" && value !== null
    && (value as { readonly $typeName?: unknown }).$typeName === typeName;
}

function isAgentPayload(value: unknown): value is contract.DevicePeerAgentResult["payload"] {
  return typeof value === "object" && value !== null && "case" in value;
}

function sameCapabilities(left: readonly DevicePeerCapability[], right: readonly DevicePeerCapability[]): boolean {
  return left.length === right.length && left.every((capability) => right.includes(capability));
}

interface PageSlice<T> {
  readonly values: readonly T[];
  readonly page: contract.PageInfo;
}

function paginate<T>(values: readonly T[], request: contract.PageRequest | undefined, kind: string): PageSlice<T> {
  const offset = decodePageToken(request?.pageToken ?? "", kind);
  const size = Math.min(Math.max(request?.pageSize || DEFAULT_PAGE_SIZE, 1), MAXIMUM_PAGE_SIZE);
  const next = Math.min(offset + size, values.length);
  return {
    values: values.slice(offset, next),
    page: create(contract.PageInfoSchema, {
      nextPageToken: next < values.length ? encodePageToken(kind, next) : "",
      totalSize: BigInt(values.length)
    })
  };
}

function routePageKind(prefix: string, value: DevicePeerSelectionIdentity): string {
  return `${prefix}:${value.targetDeviceId}:${value.relationId}:${value.targetDeviceRevision}:${value.relationRevision}:${value.routeGeneration}`;
}

function encodePageToken(kind: string, offset: number): string {
  return Buffer.from(`v1\u0000${kind}\u0000${offset}`, "utf8").toString("base64url");
}

function decodePageToken(token: string, kind: string): number {
  if (token === "") return 0;
  if (token.length > 2_048 || !/^[A-Za-z0-9_-]+$/u.test(token)) {
    throw new ConnectError("The page token is invalid.", Code.InvalidArgument);
  }
  let decoded: string;
  try { decoded = Buffer.from(token, "base64url").toString("utf8"); }
  catch { throw new ConnectError("The page token is invalid.", Code.InvalidArgument); }
  if (Buffer.from(decoded, "utf8").toString("base64url") !== token) {
    throw new ConnectError("The page token is invalid.", Code.InvalidArgument);
  }
  const prefix = `v1\u0000${kind}\u0000`;
  if (!decoded.startsWith(prefix)) throw new ConnectError("The page token is invalid.", Code.InvalidArgument);
  const raw = decoded.slice(prefix.length);
  if (!/^(?:0|[1-9][0-9]{0,8})$/u.test(raw)) throw new ConnectError("The page token is invalid.", Code.InvalidArgument);
  const offset = Number(raw);
  if (!Number.isSafeInteger(offset)) throw new ConnectError("The page token is invalid.", Code.InvalidArgument);
  return offset;
}

async function nextWithSignal<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) throw new ConnectError("The Device peer route was cancelled.", Code.Canceled);
  let rejectCancelled: ((error: unknown) => void) | undefined;
  const cancelled = new Promise<IteratorResult<T>>((_resolve, reject) => { rejectCancelled = reject; });
  const onAbort = (): void => rejectCancelled?.(new ConnectError(
    "The Device peer route was cancelled.", Code.Canceled
  ));
  signal.addEventListener("abort", onAbort, { once: true });
  try { return await Promise.race([iterator.next(), cancelled]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function protocolViolation(message: string): DevicePeerProtocolError {
  return new DevicePeerProtocolError("invalid_frame", message);
}

async function peerRpc<T>(callback: () => Promise<T>): Promise<T> {
  try { return await callback(); }
  catch (error) { throw toPeerConnectError(error); }
}

async function* mapPeerStreamErrors<T>(values: AsyncIterable<T>): AsyncGenerator<T> {
  try { yield* values; }
  catch (error) { throw toPeerConnectError(error); }
}

function toPeerConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (error instanceof ConnectionAuthenticationError) return new ConnectError(error.message, Code.Unauthenticated);
  if (error instanceof DevicePeerAuthorityError) {
    const code = error.code === "invalid_identity" ? Code.InvalidArgument
      : error.code === "access_revoked" ? Code.PermissionDenied
        : error.code === "route_unavailable" ? Code.Unavailable
          : error.code === "capability_unavailable" ? Code.FailedPrecondition
            : Code.Aborted;
    return new ConnectError(error.message, code);
  }
  if (error instanceof DevicePeerRegistryError) {
    const code = error.code === "route_unavailable" ? Code.Unavailable
      : error.code === "capability_unavailable" ? Code.FailedPrecondition
        : error.code === "claim_conflict" ? Code.AlreadyExists
          : Code.Internal;
    return new ConnectError("The Device peer route could not accept the request.", code);
  }
  if (error instanceof DevicePeerProtocolError) {
    return new ConnectError("The Device peer route violated the current protocol.", Code.FailedPrecondition);
  }
  if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") {
    return new ConnectError("The Device peer request was cancelled.", Code.Canceled);
  }
  return new ConnectError("The Device peer request could not be completed.", Code.Internal);
}
