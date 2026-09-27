import { randomUUID } from "node:crypto";

import { create } from "@bufbuild/protobuf";
import { createClient, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  ConnectionService,
  ConnectionState,
  DevicePeerAgentRouteAttachmentSchema,
  DevicePeerAgentHeartbeatSchema,
  DevicePeerAgentHelloSchema,
  DevicePeerCapabilityKind,
  type DevicePeerCommand,
  DevicePeerRetireReason,
  DevicePeerService,
  DeviceKind,
  type OpenDevicePeerAgentCommandRouteResponse,
  OpenDevicePeerAgentCommandRouteRequestSchema,
  type OpenDevicePeerAgentRouteRequest,
  OpenDevicePeerAgentRouteRequestSchema,
  type OpenDevicePeerAgentRouteResponse,
  OpenDevicePeerAgentRouteResponseSchema,
  PublishDevicePeerAgentRouteRequestSchema
} from "@joko/contracts";

import type { NodeDevicePeerAgentExecutor } from "./node-agent-executor.js";
import { DEVICE_PEER_AGENT_AUTHORIZATION_HEADER } from "./protocol.js";

const MAXIMUM_ROUTE_REQUEST_IDS = 8_192;
const MAXIMUM_ACTIVE_COMMANDS = 256;
const MAXIMUM_OUTBOUND_FRAMES = 512;
const MAXIMUM_IDENTIFIER_LENGTH = 256;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const MINIMUM_HEARTBEAT_INTERVAL_MS = 10;
const MAXIMUM_HEARTBEAT_INTERVAL_MS = 60_000;

export interface NodeDevicePeerAgentConnection {
  readonly credentialId: string;
  readonly deviceId: string;
  readonly serverId: string;
  readonly origin: string;
  readonly expectedDeviceKind: DeviceKind.DESKTOP | DeviceKind.SERVICE;
}

export interface NodeDevicePeerAgentRoutePort {
  /** Anonymous, credential-free stable identity probe. */
  readServerId(origin: string, signal: AbortSignal): Promise<string>;
  /** Authenticated proof that the credential owns the exact host Device kind. */
  verifyIdentity(
    origin: string,
    authKey: string,
    connection: NodeDevicePeerAgentConnection,
    signal: AbortSignal
  ): Promise<void>;
  /** The purpose-bound route authorization stays only in the transport closure. */
  open(
    origin: string,
    routeAuthorization: string,
    requests: AsyncIterable<OpenDevicePeerAgentRouteRequest>,
    signal: AbortSignal
  ): AsyncIterable<OpenDevicePeerAgentRouteResponse>;
}

export interface NodeDevicePeerAgentRouteOptions {
  readonly connection: NodeDevicePeerAgentConnection;
  readonly executor: Pick<NodeDevicePeerAgentExecutor, "capabilities" | "execute" | "retire">;
  readonly signal: AbortSignal;
  readonly readAuthKey: (credentialId: string) => Promise<string | undefined>;
  /** Desktop supplies its independent Main-only bootstrap authorization. */
  readonly readRouteAuthorization?: (credentialId: string) => Promise<string | undefined>;
  readonly isAuthorityCurrent: (
    connection: NodeDevicePeerAgentConnection
  ) => boolean | Promise<boolean>;
  readonly heartbeatIntervalMs?: number;
  readonly port?: NodeDevicePeerAgentRoutePort;
}

/**
 * Owns one authenticated target-agent route in a trusted Node host process.
 * Commands and results are deliberately transient: this boundary never logs,
 * persists, or exposes the credential or command payloads to a UI process.
 */
export async function runNodeDevicePeerAgentRoute(
  options: NodeDevicePeerAgentRouteOptions
): Promise<void> {
  const origin = canonicalOrigin(options.connection.origin);
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isSafeInteger(heartbeatIntervalMs)
    || heartbeatIntervalMs < MINIMUM_HEARTBEAT_INTERVAL_MS
    || heartbeatIntervalMs > MAXIMUM_HEARTBEAT_INTERVAL_MS) {
    throw new TypeError("Device peer heartbeat interval is invalid.");
  }
  validateIdentifier(options.connection.deviceId);
  validateIdentifier(options.connection.serverId);
  validateDeviceKind(options.connection.expectedDeviceKind);
  validateCapabilities(options.executor.capabilities);

  const routeController = new AbortController();
  const abortRoute = (): void => routeController.abort();
  options.signal.addEventListener("abort", abortRoute, { once: true });
  const port = options.port ?? DEFAULT_NODE_DEVICE_PEER_AGENT_ROUTE_PORT;
  const queue = new BoundedAsyncQueue<OpenDevicePeerAgentRouteRequest>(MAXIMUM_OUTBOUND_FRAMES);
  const commands = new Map<string, AbortController>();
  const commandRequestIds = new Set<string>();
  const tasks = new Set<Promise<void>>();
  const requestIds = new Set<string>();
  let fatal = false;
  let retired = false;
  let heartbeatTask: Promise<void> | undefined;
  let iterator: AsyncIterator<OpenDevicePeerAgentRouteResponse> | undefined;

  const failRoute = (): void => {
    if (fatal || retired || options.signal.aborted) return;
    fatal = true;
    for (const controller of commands.values()) controller.abort();
    queue.fail(routeFailure());
    routeController.abort();
  };

  try {
    await assertAuthority(options, routeController.signal);
    const serverId = await port.readServerId(origin, routeController.signal);
    if (serverId !== options.connection.serverId) throw routeFailure();
    await assertAuthority(options, routeController.signal);

    // Decrypt only after the anonymous endpoint proves the saved stable ID.
    // The value is never placed in a returned object, error, queue, or store.
    const authKey = await options.readAuthKey(options.connection.credentialId);
    if (!validAuthKey(authKey)) throw routeFailure();
    await assertAuthority(options, routeController.signal);
    await port.verifyIdentity(origin, authKey, options.connection, routeController.signal);
    await assertAuthority(options, routeController.signal);

    const routeAuthorization = options.connection.expectedDeviceKind === DeviceKind.DESKTOP
      ? await options.readRouteAuthorization?.(options.connection.credentialId)
      : authKey;
    if (!validAuthKey(routeAuthorization)
      || (options.connection.expectedDeviceKind === DeviceKind.DESKTOP && routeAuthorization === authKey)) {
      throw routeFailure();
    }
    await assertAuthority(options, routeController.signal);

    const helloRequestId = freshRequestId(requestIds);
    queue.push(create(OpenDevicePeerAgentRouteRequestSchema, {
      targetDeviceId: options.connection.deviceId,
      routeGeneration: 0n,
      requestId: helloRequestId,
      payload: {
        case: "hello",
        value: create(DevicePeerAgentHelloSchema, {
          capabilities: [...options.executor.capabilities]
        })
      }
    }));

    const responses = port.open(origin, routeAuthorization, queue, routeController.signal);
    iterator = responses[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw routeFailure();
    const generation = await acceptRoute(options, first.value, helloRequestId, routeController.signal);

    heartbeatTask = pumpHeartbeats({
      options,
      generation,
      intervalMs: heartbeatIntervalMs,
      queue,
      requestIds,
      commands,
      signal: routeController.signal,
      failRoute
    });

    while (!routeController.signal.aborted) {
      const next = await iterator.next();
      if (next.done) break;
      const response = next.value;
      validateRouteEnvelope(response, options.connection.deviceId, generation);
      await assertAuthority(options, routeController.signal);

      switch (response.payload.case) {
        case "command": {
          if (requestIds.has(response.requestId)
            || requestIds.size >= MAXIMUM_ROUTE_REQUEST_IDS
            || commands.size >= MAXIMUM_ACTIVE_COMMANDS) throw routeFailure();
          requestIds.add(response.requestId);
          commandRequestIds.add(response.requestId);
          const commandController = new AbortController();
          commands.set(response.requestId, commandController);
          const task = executeCommand({
            options,
            command: response.payload.value,
            requestId: response.requestId,
            generation,
            commandController,
            routeSignal: routeController.signal,
            queue
          }).catch(() => failRoute()).finally(() => {
            commands.delete(response.requestId);
          });
          tasks.add(task);
          void task.finally(() => tasks.delete(task));
          break;
        }
        case "abort": {
          if (!commandRequestIds.has(response.requestId)) throw routeFailure();
          commands.get(response.requestId)?.abort();
          break;
        }
        case "retire":
          if (response.requestId !== helloRequestId
            || response.payload.value.reason === DevicePeerRetireReason.UNSPECIFIED) throw routeFailure();
          retired = true;
          routeController.abort();
          break;
        case "accepted":
        case undefined:
          throw routeFailure();
      }
      if (retired) break;
    }

    if (!retired && !options.signal.aborted) throw routeFailure();
  } catch {
    if (!retired && !options.signal.aborted) fatal = true;
  } finally {
    options.signal.removeEventListener("abort", abortRoute);
    routeController.abort();
    for (const controller of commands.values()) controller.abort();
    queue.close();
    try { await iterator?.return?.(); }
    catch { if (!options.signal.aborted) fatal = true; }
    await Promise.allSettled([...tasks, ...(heartbeatTask === undefined ? [] : [heartbeatTask])]);
    try { await options.executor.retire(); }
    catch { if (!options.signal.aborted) fatal = true; }
  }

  if (fatal) throw routeFailure();
}

interface ExecuteCommandOptions {
  readonly options: NodeDevicePeerAgentRouteOptions;
  readonly command: DevicePeerCommand;
  readonly requestId: string;
  readonly generation: bigint;
  readonly commandController: AbortController;
  readonly routeSignal: AbortSignal;
  readonly queue: BoundedAsyncQueue<OpenDevicePeerAgentRouteRequest>;
}

async function executeCommand(input: ExecuteCommandOptions): Promise<void> {
  const abortCommand = (): void => input.commandController.abort();
  input.routeSignal.addEventListener("abort", abortCommand, { once: true });
  let sequence = 0n;
  try {
    await assertAuthority(input.options, input.routeSignal);
    await input.options.executor.execute(input.command, input.commandController.signal, async (result) => {
      if (input.routeSignal.aborted) throw routeFailure();
      await assertAuthority(input.options, input.routeSignal);
      if (result.sequence !== sequence + 1n
        || result.sequence > BigInt(Number.MAX_SAFE_INTEGER)) throw routeFailure();
      sequence = result.sequence;
      input.queue.push(create(OpenDevicePeerAgentRouteRequestSchema, {
        targetDeviceId: input.options.connection.deviceId,
        routeGeneration: input.generation,
        requestId: input.requestId,
        payload: { case: "result", value: result }
      }));
    });
  } finally {
    input.routeSignal.removeEventListener("abort", abortCommand);
  }
}

interface HeartbeatOptions {
  readonly options: NodeDevicePeerAgentRouteOptions;
  readonly generation: bigint;
  readonly intervalMs: number;
  readonly queue: BoundedAsyncQueue<OpenDevicePeerAgentRouteRequest>;
  readonly requestIds: Set<string>;
  readonly commands: ReadonlyMap<string, AbortController>;
  readonly signal: AbortSignal;
  readonly failRoute: () => void;
}

async function pumpHeartbeats(input: HeartbeatOptions): Promise<void> {
  try {
    while (!input.signal.aborted) {
      await abortableDelay(input.intervalMs, input.signal);
      if (input.signal.aborted || input.commands.size > 0 || input.queue.size > 0) continue;
      await assertAuthority(input.options, input.signal);
      const requestId = freshRequestId(input.requestIds);
      input.queue.push(create(OpenDevicePeerAgentRouteRequestSchema, {
        targetDeviceId: input.options.connection.deviceId,
        routeGeneration: input.generation,
        requestId,
        payload: {
          case: "heartbeat",
          value: create(DevicePeerAgentHeartbeatSchema)
        }
      }));
    }
  } catch {
    if (!input.signal.aborted) input.failRoute();
  }
}

async function acceptRoute(
  options: NodeDevicePeerAgentRouteOptions,
  response: OpenDevicePeerAgentRouteResponse,
  helloRequestId: string,
  signal: AbortSignal
): Promise<bigint> {
  validateIdentifier(response.requestId);
  if (response.targetDeviceId !== options.connection.deviceId
    || response.requestId !== helloRequestId
    || response.routeGeneration < 1n
    || response.routeGeneration > BigInt(Number.MAX_SAFE_INTEGER)
    || response.payload.case !== "accepted"
    || !sameCapabilities(response.payload.value.capabilities, options.executor.capabilities)) {
    throw routeFailure();
  }
  await assertAuthority(options, signal);
  return response.routeGeneration;
}

function validateRouteEnvelope(
  response: OpenDevicePeerAgentRouteResponse,
  deviceId: string,
  generation: bigint
): void {
  validateIdentifier(response.requestId);
  if (response.targetDeviceId !== deviceId || response.routeGeneration !== generation) throw routeFailure();
}

async function assertAuthority(
  options: NodeDevicePeerAgentRouteOptions,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted || options.signal.aborted || !await options.isAuthorityCurrent(options.connection)) {
    throw routeFailure();
  }
}

function validateCapabilities(values: readonly DevicePeerCapabilityKind[]): void {
  if (values.length < 1 || values.length > 4 || new Set(values).size !== values.length
    || values.some((value) => value !== DevicePeerCapabilityKind.FILES
      && value !== DevicePeerCapabilityKind.PROCESS
      && value !== DevicePeerCapabilityKind.TERMINAL
      && value !== DevicePeerCapabilityKind.FORWARDING)) throw routeFailure();
}

function validateDeviceKind(value: DeviceKind): void {
  if (value !== DeviceKind.DESKTOP && value !== DeviceKind.SERVICE) throw routeFailure();
}

function sameCapabilities(
  left: readonly DevicePeerCapabilityKind[],
  right: readonly DevicePeerCapabilityKind[]
): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function freshRequestId(requestIds: Set<string>): string {
  if (requestIds.size >= MAXIMUM_ROUTE_REQUEST_IDS) throw routeFailure();
  let requestId = randomUUID();
  while (requestIds.has(requestId)) requestId = randomUUID();
  requestIds.add(requestId);
  return requestId;
}

function validateIdentifier(value: string): void {
  if (value.length < 1 || value.length > MAXIMUM_IDENTIFIER_LENGTH
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw routeFailure();
}

function canonicalOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw routeFailure(); }
  if (url.origin !== value || (url.protocol !== "http:" && url.protocol !== "https:")) throw routeFailure();
  return url.origin;
}

function validAuthKey(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function routeFailure(): Error {
  return new Error("Device peer agent route is unavailable.");
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveDelay();
    }
  });
}

class BoundedAsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    readonly resolve: (result: IteratorResult<T>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  readonly #maximumSize: number;
  #closed = false;
  #error: Error | undefined;

  constructor(maximumSize: number) {
    this.#maximumSize = maximumSize;
  }

  get size(): number { return this.#values.length; }

  [Symbol.asyncIterator](): AsyncIterator<T> { return this; }

  push(value: T): void {
    if (this.#closed) throw routeFailure();
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
      return;
    }
    if (this.#values.length >= this.#maximumSize) throw routeFailure();
    this.#values.push(value);
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.#error !== undefined) return Promise.reject(this.#error);
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: Error): void {
    if (this.#closed) return;
    this.#error = error;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
}

export function createNodeDevicePeerAgentRoutePort(): NodeDevicePeerAgentRoutePort {
  return Object.freeze({
    async readServerId(origin: string, signal: AbortSignal) {
      const response = await createClient(
        ConnectionService,
        createDevicePeerAgentTransport(origin)
      ).getServerInfo({}, { signal });
      const serverId = response.server?.serverId;
      if (serverId === undefined) throw routeFailure();
      return serverId;
    },
    async verifyIdentity(
      origin: string,
      authKey: string,
      connection: NodeDevicePeerAgentConnection,
      signal: AbortSignal
    ) {
      validateDeviceKind(connection.expectedDeviceKind);
      const client = createClient(ConnectionService, createDevicePeerAgentTransport(origin, authKey));
      const [connectionResponse, deviceResponse] = await Promise.all([
        client.getConnection({ connectionId: connection.credentialId }, { signal }),
        client.getDevice({ deviceId: connection.deviceId }, { signal })
      ]);
      const authenticatedConnection = connectionResponse.connection;
      const device = deviceResponse.device;
      if (authenticatedConnection === undefined || device === undefined
        || authenticatedConnection.connectionId !== connection.credentialId
        || authenticatedConnection.deviceId !== connection.deviceId
        || authenticatedConnection.state !== ConnectionState.CONNECTED
        || device.deviceId !== connection.deviceId
        || device.kind !== connection.expectedDeviceKind
        || device.revoked
        || !device.connectionIds.includes(connection.credentialId)) throw routeFailure();
    },
    open(
      origin: string,
      routeAuthorization: string,
      requests: AsyncIterable<OpenDevicePeerAgentRouteRequest>,
      signal: AbortSignal
    ) {
      const client = createClient(
        DevicePeerService,
        createDevicePeerAgentTransport(origin, undefined, routeAuthorization)
      );
      return openSplitDevicePeerAgentRoute(client, requests, signal);
    }
  });
}

export const DEFAULT_NODE_DEVICE_PEER_AGENT_ROUTE_PORT = createNodeDevicePeerAgentRoutePort();

function createDevicePeerAgentTransport(
  origin: string,
  authKey?: string,
  routeAuthorization?: string
): Transport {
  const interceptors: Interceptor[] = [];
  if (authKey !== undefined || routeAuthorization !== undefined) interceptors.push((next) => (request) => {
    if (authKey !== undefined) request.header.set("authorization", `Bearer ${authKey}`);
    if (routeAuthorization !== undefined) {
      request.header.set(DEVICE_PEER_AGENT_AUTHORIZATION_HEADER, `Bearer ${routeAuthorization}`);
    }
    return next(request);
  });
  return createConnectTransport({
    baseUrl: origin,
    httpVersion: "1.1",
    useBinaryFormat: true,
    interceptors
  });
}

function openSplitDevicePeerAgentRoute(
  client: ReturnType<typeof createClient<typeof DevicePeerService>>,
  requests: AsyncIterable<OpenDevicePeerAgentRouteRequest>,
  signal: AbortSignal
): AsyncIterable<OpenDevicePeerAgentRouteResponse> {
  return (async function* () {
    const routeController = new AbortController();
    const abortRoute = (): void => routeController.abort();
    signal.addEventListener("abort", abortRoute, { once: true });
    const input = requests[Symbol.asyncIterator]();
    let downstream: AsyncIterator<OpenDevicePeerAgentCommandRouteResponse> | undefined;
    let upload: Promise<unknown> | undefined;
    try {
      const firstRequest = await input.next();
      if (firstRequest.done || firstRequest.value.payload.case !== "hello") throw routeFailure();
      downstream = client.openDevicePeerAgentCommandRoute(
        create(OpenDevicePeerAgentCommandRouteRequestSchema, {
          targetDeviceId: firstRequest.value.targetDeviceId,
          routeGeneration: firstRequest.value.routeGeneration,
          requestId: firstRequest.value.requestId,
          payload: firstRequest.value.payload
        }),
        { signal: routeController.signal }
      )[Symbol.asyncIterator]();
      const firstResponse = await downstream.next();
      if (firstResponse.done) throw routeFailure();

      const upstream = (async function* () {
        yield create(PublishDevicePeerAgentRouteRequestSchema, {
          targetDeviceId: firstResponse.value.targetDeviceId,
          routeGeneration: firstResponse.value.routeGeneration,
          requestId: firstResponse.value.requestId,
          payload: {
            case: "attachment",
            value: create(DevicePeerAgentRouteAttachmentSchema)
          }
        });
        for (;;) {
          const next = await input.next();
          if (next.done) return;
          if (next.value.payload.case !== "result" && next.value.payload.case !== "heartbeat") {
            throw routeFailure();
          }
          yield create(PublishDevicePeerAgentRouteRequestSchema, {
            targetDeviceId: next.value.targetDeviceId,
            routeGeneration: next.value.routeGeneration,
            requestId: next.value.requestId,
            payload: next.value.payload
          });
        }
      })();
      upload = client.publishDevicePeerAgentRoute(upstream, { signal: routeController.signal });
      const uploadClosed = upload.then(() => ({ case: "uploadClosed" as const }));

      yield create(OpenDevicePeerAgentRouteResponseSchema, {
        targetDeviceId: firstResponse.value.targetDeviceId,
        routeGeneration: firstResponse.value.routeGeneration,
        requestId: firstResponse.value.requestId,
        payload: firstResponse.value.payload
      });
      for (;;) {
        const next = await Promise.race([
          downstream.next().then((value) => ({ case: "downstream" as const, value })),
          uploadClosed
        ]);
        if (next.case === "uploadClosed") throw routeFailure();
        if (next.value.done) return;
        yield create(OpenDevicePeerAgentRouteResponseSchema, {
          targetDeviceId: next.value.value.targetDeviceId,
          routeGeneration: next.value.value.routeGeneration,
          requestId: next.value.value.requestId,
          payload: next.value.value.payload
        });
      }
    } finally {
      signal.removeEventListener("abort", abortRoute);
      routeController.abort();
      try { await downstream?.return?.(); } catch { /* The route is already closed. */ }
      if (upload !== undefined) await Promise.allSettled([upload]);
    }
  })();
}
