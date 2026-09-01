import type { JsonObject, JsonValue, RpcNotification, RpcServerRequest } from "./protocol.js";
import {
  commandApprovalAvailability,
  isJsonObject,
  parseInitializeResult,
  type NativeInitializeResult
} from "./protocol.js";
import { StdioJsonRpcTransport, type RpcRequestOptions, type RpcTransport, type StdioJsonRpcTransportOptions } from "./transport.js";
import { TransportFault } from "./errors.js";

export interface HostSubscriptionHandlers {
  readonly onNotification: (method: string, params: JsonValue) => void | Promise<void>;
  /** Dedicated child-thread channel. Descendant events never enter the root turn translator. */
  readonly onDescendantNotification?: (threadId: string, method: string, params: JsonValue) => void | Promise<void>;
  /** Authoritative child metadata carried by `thread/started`. */
  readonly onDescendantThreadStarted?: (params: JsonValue) => void | Promise<void>;
  readonly onRequest: (requestId: string | number, method: string, params: JsonValue) => Promise<JsonValue | undefined>;
  readonly onDisconnect: (fault: TransportFault) => void | Promise<void>;
}

export interface HostSubscription {
  readonly threadId: string;
  readonly hostGeneration: number;
  release(options?: { readonly unsubscribe?: boolean }): Promise<void>;
}

export interface AppServerHostOptions {
  readonly transport?: StdioJsonRpcTransportOptions;
  readonly transportFactory?: () => RpcTransport;
  readonly clientName?: string;
  readonly clientTitle?: string;
  readonly clientVersion?: string;
  readonly notificationBufferTtlMs?: number;
  readonly notificationBufferMaxEntries?: number;
  readonly notificationBufferMaxBytes?: number;
  readonly detachedThreadMaxEntries?: number;
  readonly descendantThreadMaxEntries?: number;
}

interface Subscriber {
  readonly generation: number;
  readonly handlers: HostSubscriptionHandlers;
}

interface BufferedNotification {
  readonly notification: RpcNotification;
  readonly byteLength: number;
  readonly expiresAt: number;
}

interface DescendantLineage {
  readonly parentThreadId: string;
  readonly rootThreadId: string;
  readonly generation: number;
}

export interface HostRequestResult {
  readonly value: JsonValue;
  readonly hostGeneration: number;
}

export class AppServerHost {
  readonly #options: Required<Pick<
    AppServerHostOptions,
    "clientName" | "clientTitle" | "clientVersion" | "notificationBufferTtlMs" | "notificationBufferMaxEntries" | "notificationBufferMaxBytes" | "detachedThreadMaxEntries" | "descendantThreadMaxEntries"
  >> & AppServerHostOptions;
  #transport: RpcTransport | undefined;
  #closingTransport: RpcTransport | undefined;
  #startFlight: Promise<number> | undefined;
  #generation = 0;
  #initializeResult: NativeInitializeResult | undefined;
  #subscribers = new Map<string, Subscriber>();
  #descendants = new Map<string, DescendantLineage>();
  #detachedThreads = new Set<string>();
  #buffered = new Map<string, BufferedNotification[]>();
  #bufferedEntries = 0;
  #bufferedBytes = 0;
  #closing = false;

  constructor(options: AppServerHostOptions = {}) {
    this.#options = {
      ...options,
      clientName: options.clientName ?? "joko",
      clientTitle: options.clientTitle ?? "Joko",
      clientVersion: options.clientVersion ?? "0.1.0",
      notificationBufferTtlMs: options.notificationBufferTtlMs ?? 5_000,
      notificationBufferMaxEntries: options.notificationBufferMaxEntries ?? 256,
      notificationBufferMaxBytes: options.notificationBufferMaxBytes ?? 1024 * 1024,
      detachedThreadMaxEntries: options.detachedThreadMaxEntries ?? 2_048,
      descendantThreadMaxEntries: options.descendantThreadMaxEntries ?? 4_096
    };
    if (!positiveInteger(this.#options.notificationBufferTtlMs)
      || !positiveInteger(this.#options.notificationBufferMaxEntries)
      || !positiveInteger(this.#options.notificationBufferMaxBytes)
      || !positiveInteger(this.#options.detachedThreadMaxEntries)
      || !positiveInteger(this.#options.descendantThreadMaxEntries)) {
      throw new TypeError("Codex notification buffer bounds must be positive integers.");
    }
  }

  get generation(): number {
    return this.#generation;
  }

  get initializeResult(): NativeInitializeResult | undefined {
    return this.#initializeResult;
  }

  isActiveGeneration(generation: number): boolean {
    return this.#transport?.running === true && generation === this.#generation;
  }

  async ensureStarted(): Promise<number> {
    if (this.#closing) throw new TransportFault("closed", "The Codex app-server host is closed.");
    if (this.#transport?.running === true && this.#initializeResult !== undefined) return this.#generation;
    if (this.#startFlight !== undefined) return this.#startFlight;
    const start = this.#start();
    this.#startFlight = start;
    try {
      return await start;
    } finally {
      if (this.#startFlight === start) this.#startFlight = undefined;
    }
  }

  async request(method: string, params: JsonValue | undefined, options: RpcRequestOptions = {}): Promise<HostRequestResult> {
    const generation = await this.ensureStarted();
    const transport = this.#transport;
    if (transport === undefined || !transport.running || generation !== this.#generation) {
      throw new TransportFault("process_exited", "The Codex app-server generation changed before request dispatch.", {
        stateMayHaveChanged: options.mutation
      });
    }
    const value = await transport.request(method, params, options);
    if (generation !== this.#generation) {
      throw new TransportFault("process_exited", "The Codex app-server generation changed before the response was accepted.", {
        stateMayHaveChanged: options.mutation
      });
    }
    return { value, hostGeneration: generation };
  }

  async notify(method: string, params?: JsonValue): Promise<void> {
    const generation = await this.ensureStarted();
    const transport = this.#transport;
    if (transport === undefined || generation !== this.#generation) {
      throw new TransportFault("process_exited", "The Codex app-server generation changed before notification dispatch.");
    }
    await transport.notify(method, params);
  }

  async subscribe(
    threadId: string,
    expectedHostGeneration: number,
    handlers: HostSubscriptionHandlers
  ): Promise<HostSubscription> {
    if (!this.isActiveGeneration(expectedHostGeneration)) {
      throw new TransportFault("process_exited", "The Codex app-server generation changed before thread subscription.");
    }
    const existing = this.#subscribers.get(threadId);
    if (existing !== undefined) {
      throw new TransportFault("protocol_violation", "A Codex thread already has an active Joko subscription.");
    }
    if (this.#descendants.has(threadId)) {
      throw new TransportFault("protocol_violation", "A Codex descendant thread already belongs to an active root subscription.");
    }
    this.#detachedThreads.delete(threadId);
    const subscriber: Subscriber = { generation: expectedHostGeneration, handlers };
    this.#subscribers.set(threadId, subscriber);
    const waiting = this.#takeBuffered(threadId);
    try {
      for (const item of waiting) {
        if (!this.#isSubscriberCurrent(threadId, subscriber)) {
          throw new TransportFault("process_exited", "The Codex thread subscription changed while buffered notifications were draining.");
        }
        if (item.expiresAt <= Date.now()) {
          throw new TransportFault("buffer_overflow", "A pre-subscription Codex notification expired before it could be applied.");
        }
        await handlers.onNotification(item.notification.method, item.notification.params);
      }
    } catch (error) {
      if (this.#subscribers.get(threadId) === subscriber) this.#subscribers.delete(threadId);
      throw error;
    }
    let released = false;
    return {
      threadId,
      hostGeneration: expectedHostGeneration,
      release: async (options = {}) => {
        if (released) return;
        released = true;
        if (this.#subscribers.get(threadId) === subscriber) this.#subscribers.delete(threadId);
        const ownedThreadIds = [threadId, ...this.#removeDescendantsForRoot(threadId, expectedHostGeneration)];
        for (const ownedThreadId of ownedThreadIds) {
          this.#rememberDetachedThread(ownedThreadId);
          this.#discardBuffered(ownedThreadId);
        }
        if (options.unsubscribe !== false && this.isActiveGeneration(expectedHostGeneration)) {
          await Promise.allSettled(ownedThreadIds.map((ownedThreadId) =>
            this.request("thread/unsubscribe", { threadId: ownedThreadId }, { timeoutMs: 5_000 })
          ));
        }
        for (const ownedThreadId of ownedThreadIds) this.#discardBuffered(ownedThreadId);
      }
    };
  }

  async registerDescendantThread(
    childThreadId: string,
    parentThreadId: string,
    expectedHostGeneration: number
  ): Promise<void> {
    if (!this.isActiveGeneration(expectedHostGeneration)) {
      throw new TransportFault("process_exited", "The Codex app-server generation changed before descendant registration.");
    }
    const lineage = this.#establishDescendant(childThreadId, parentThreadId, expectedHostGeneration);
    if (lineage === undefined) {
      throw new TransportFault("protocol_violation", "The Codex descendant lineage does not belong to an active root subscription.");
    }
    const subscriber = this.#subscribers.get(lineage.rootThreadId);
    if (subscriber === undefined || subscriber.generation !== expectedHostGeneration) {
      throw new TransportFault("process_exited", "The Codex descendant root subscription changed before registration.");
    }
    await this.#drainDescendant(childThreadId, subscriber);
  }

  async releaseUnboundThread(threadId: string, expectedHostGeneration: number): Promise<void> {
    this.#rememberDetachedThread(threadId);
    this.#discardBuffered(threadId);
    if (!this.isActiveGeneration(expectedHostGeneration)) return;
    await this.request("thread/unsubscribe", { threadId }, { timeoutMs: 5_000 }).catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    return this.#shutdown(false);
  }

  async forceShutdown(): Promise<void> {
    return this.#shutdown(true);
  }

  async #shutdown(force: boolean): Promise<void> {
    if (this.#closing && !force) return;
    this.#closing = true;
    const subscribers = [...this.#subscribers.values()];
    this.#subscribers.clear();
    this.#descendants.clear();
    this.#detachedThreads.clear();
    this.#clearBuffer();
    const transport = this.#transport ?? (force ? this.#closingTransport : undefined);
    this.#transport = undefined;
    if (transport !== undefined) this.#closingTransport = transport;
    this.#initializeResult = undefined;
    await Promise.allSettled(subscribers.map((subscriber) => subscriber.handlers.onDisconnect(
      new TransportFault("closed", "The Codex app-server host shut down.")
    )));
    if (force && transport?.forceClose !== undefined) await transport.forceClose();
    else await transport?.close();
    if (this.#closingTransport === transport) this.#closingTransport = undefined;
  }

  async #start(): Promise<number> {
    const generation = this.#generation + 1;
    const transport = this.#options.transportFactory?.() ?? new StdioJsonRpcTransport(this.#options.transport);
    this.#generation = generation;
    this.#transport = transport;
    this.#initializeResult = undefined;
    try {
      await transport.start({
        onNotification: (notification) => this.#routeNotification(transport, generation, notification),
        onRequest: (request) => this.#routeRequest(transport, generation, request),
        onExit: (fault) => this.#handleExit(transport, generation, fault)
      });
      const result = await transport.request("initialize", {
        clientInfo: {
          name: this.#options.clientName,
          title: this.#options.clientTitle,
          version: this.#options.clientVersion
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false
        }
      }, { timeoutMs: this.#options.transport?.requestTimeoutMs });
      if (this.#transport !== transport || generation !== this.#generation) {
        throw new TransportFault("process_exited", "The Codex app-server generation changed during initialization.");
      }
      this.#initializeResult = parseInitializeResult(result);
      await transport.notify("initialized");
      return generation;
    } catch (error) {
      if (this.#transport === transport) {
        this.#transport = undefined;
        this.#initializeResult = undefined;
      }
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  async #routeNotification(
    transport: RpcTransport,
    generation: number,
    notification: RpcNotification
  ): Promise<void> {
    if (transport !== this.#transport || generation !== this.#generation) return;
    if (notification.method === "thread/started") {
      const routed = await this.#routeDescendantStarted(generation, notification.params);
      if (routed) return;
    }
    const threadId = threadIdFromParams(notification.params);
    if (threadId === undefined) return;
    const subscriber = this.#subscribers.get(threadId);
    if (subscriber !== undefined && subscriber.generation === generation) {
      await subscriber.handlers.onNotification(notification.method, notification.params);
      return;
    }
    const lineage = this.#descendants.get(threadId);
    if (lineage !== undefined && lineage.generation === generation) {
      const root = this.#subscribers.get(lineage.rootThreadId);
      if (root !== undefined && root.generation === generation) {
        await root.handlers.onDescendantNotification?.(threadId, notification.method, notification.params);
        return;
      }
    }
    if (this.#detachedThreads.has(threadId)) return;
    this.#bufferNotification(threadId, notification);
  }

  async #routeRequest(
    transport: RpcTransport,
    generation: number,
    request: RpcServerRequest
  ): Promise<void> {
    if (transport !== this.#transport || generation !== this.#generation) return;
    const threadId = threadIdFromParams(request.params);
    const direct = threadId === undefined ? undefined : this.#subscribers.get(threadId);
    const lineage = threadId === undefined ? undefined : this.#descendants.get(threadId);
    const subscriber = direct ?? (lineage === undefined ? undefined : this.#subscribers.get(lineage.rootThreadId));
    let result: JsonValue | undefined;
    if (subscriber !== undefined && subscriber.generation === generation) {
      try {
        result = await subscriber.handlers.onRequest(request.id, request.method, request.params);
      } catch {
        result = undefined;
      }
      if (transport !== this.#transport || generation !== this.#generation) return;
    }
    const fallback = result === undefined ? defaultRequestResult(request.method, request.params) : { kind: "result" as const, value: result };
    if (fallback.kind === "error") {
      await transport.respondError(request.id, fallback.code, fallback.message);
    } else {
      await transport.respond(request.id, fallback.value);
    }
  }

  async #handleExit(transport: RpcTransport, generation: number, fault: TransportFault): Promise<void> {
    if (transport !== this.#transport || generation !== this.#generation) return;
    this.#transport = undefined;
    this.#initializeResult = undefined;
    this.#clearBuffer();
    this.#detachedThreads.clear();
    this.#descendants.clear();
    const subscribers = [...this.#subscribers.values()].filter((subscriber) => subscriber.generation === generation);
    for (const [threadId, subscriber] of this.#subscribers) {
      if (subscriber.generation === generation) this.#subscribers.delete(threadId);
    }
    await Promise.allSettled(subscribers.map((subscriber) => subscriber.handlers.onDisconnect(fault)));
  }

  #bufferNotification(threadId: string, notification: RpcNotification): void {
    this.#pruneExpiredBuffer();
    const byteLength = Buffer.byteLength(JSON.stringify(notification), "utf8");
    if (
      byteLength > this.#options.notificationBufferMaxBytes
      || this.#bufferedEntries + 1 > this.#options.notificationBufferMaxEntries
      || this.#bufferedBytes + byteLength > this.#options.notificationBufferMaxBytes
    ) {
      throw new TransportFault("buffer_overflow", "The Codex pre-subscription notification buffer reached its safe limit.");
    }
    const item: BufferedNotification = {
      notification,
      byteLength,
      expiresAt: Date.now() + this.#options.notificationBufferTtlMs
    };
    const values = this.#buffered.get(threadId) ?? [];
    values.push(item);
    this.#buffered.set(threadId, values);
    this.#bufferedEntries += 1;
    this.#bufferedBytes += byteLength;
  }

  #pruneExpiredBuffer(): void {
    const now = Date.now();
    for (const [threadId, values] of this.#buffered) {
      if (!values.some((value) => value.expiresAt <= now)) continue;
      this.#discardBuffered(threadId);
      throw new TransportFault("buffer_overflow", "A Codex pre-subscription notification expired before binding.");
    }
  }

  #takeBuffered(threadId: string): BufferedNotification[] {
    const values = this.#buffered.get(threadId) ?? [];
    this.#buffered.delete(threadId);
    for (const value of values) {
      this.#bufferedEntries -= 1;
      this.#bufferedBytes -= value.byteLength;
    }
    return values;
  }

  #discardBuffered(threadId: string): void {
    this.#takeBuffered(threadId);
  }

  #rememberDetachedThread(threadId: string): void {
    this.#detachedThreads.delete(threadId);
    while (this.#detachedThreads.size >= this.#options.detachedThreadMaxEntries) {
      const oldest = this.#detachedThreads.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#detachedThreads.delete(oldest);
    }
    this.#detachedThreads.add(threadId);
  }

  #clearBuffer(): void {
    this.#buffered.clear();
    this.#bufferedEntries = 0;
    this.#bufferedBytes = 0;
  }

  #isSubscriberCurrent(threadId: string, subscriber: Subscriber): boolean {
    return this.#subscribers.get(threadId) === subscriber && this.isActiveGeneration(subscriber.generation);
  }

  async #routeDescendantStarted(generation: number, params: JsonValue): Promise<boolean> {
    const metadata = descendantStartMetadata(params);
    if (metadata === undefined) return false;
    const lineage = this.#descendants.get(metadata.childThreadId);
    if (lineage === undefined) return false;
    if (lineage.parentThreadId !== metadata.parentThreadId || lineage.generation !== generation) {
      throw new TransportFault("protocol_violation", "The Codex descendant start metadata changed after ownership was established.");
    }
    const subscriber = this.#subscribers.get(lineage.rootThreadId);
    if (subscriber === undefined || subscriber.generation !== generation) return false;
    await subscriber.handlers.onDescendantThreadStarted?.(params);
    await this.#drainDescendant(metadata.childThreadId, subscriber);
    return true;
  }

  #establishDescendant(
    childThreadId: string,
    parentThreadId: string,
    generation: number
  ): DescendantLineage | undefined {
    if (!validThreadIdentity(childThreadId)
      || !validThreadIdentity(parentThreadId)
      || childThreadId === parentThreadId) return undefined;
    const parentLineage = this.#descendants.get(parentThreadId);
    const rootThreadId = parentLineage?.rootThreadId
      ?? (this.#subscribers.get(parentThreadId)?.generation === generation ? parentThreadId : undefined);
    if (rootThreadId === undefined) return undefined;
    let cursor: string | undefined = parentThreadId;
    const visited = new Set<string>();
    while (cursor !== undefined) {
      if (cursor === childThreadId || visited.has(cursor)) {
        throw new TransportFault("protocol_violation", "The Codex descendant lineage is cyclic.");
      }
      visited.add(cursor);
      cursor = this.#descendants.get(cursor)?.parentThreadId;
    }
    const existing = this.#descendants.get(childThreadId);
    if (existing !== undefined) {
      if (existing.parentThreadId !== parentThreadId
        || existing.rootThreadId !== rootThreadId
        || existing.generation !== generation) {
        throw new TransportFault("protocol_violation", "The Codex descendant lineage changed after ownership was established.");
      }
      return existing;
    }
    if (this.#descendants.size >= this.#options.descendantThreadMaxEntries) {
      throw new TransportFault("buffer_overflow", "The Codex descendant lineage reached its safe limit.");
    }
    const lineage: DescendantLineage = { parentThreadId, rootThreadId, generation };
    this.#descendants.set(childThreadId, lineage);
    this.#detachedThreads.delete(childThreadId);
    return lineage;
  }

  async #drainDescendant(childThreadId: string, subscriber: Subscriber): Promise<void> {
    const waiting = this.#takeBuffered(childThreadId);
    for (const item of waiting) {
      const lineage = this.#descendants.get(childThreadId);
      if (lineage === undefined
        || lineage.rootThreadId === childThreadId
        || lineage.generation !== subscriber.generation
        || this.#subscribers.get(lineage.rootThreadId) !== subscriber
        || !this.isActiveGeneration(subscriber.generation)) {
        throw new TransportFault("process_exited", "The Codex descendant subscription changed while buffered notifications were draining.");
      }
      if (item.expiresAt <= Date.now()) {
        throw new TransportFault("buffer_overflow", "A pre-lineage Codex notification expired before it could be applied.");
      }
      if (item.notification.method === "thread/started") {
        await this.#routeDescendantStarted(subscriber.generation, item.notification.params);
      } else {
        await subscriber.handlers.onDescendantNotification?.(
          childThreadId,
          item.notification.method,
          item.notification.params
        );
      }
    }
  }

  #removeDescendantsForRoot(rootThreadId: string, generation: number): string[] {
    const removed: string[] = [];
    for (const [childThreadId, lineage] of this.#descendants) {
      if (lineage.rootThreadId !== rootThreadId || lineage.generation !== generation) continue;
      this.#descendants.delete(childThreadId);
      removed.push(childThreadId);
    }
    return removed;
  }
}

function threadIdFromParams(params: JsonValue): string | undefined {
  if (!isJsonObject(params)) return undefined;
  if (typeof params["threadId"] === "string" && params["threadId"].length > 0) return params["threadId"];
  if (isJsonObject(params["thread"]) && typeof params["thread"]["id"] === "string") return params["thread"]["id"];
  return undefined;
}

function descendantStartMetadata(params: JsonValue): {
  readonly childThreadId: string;
  readonly parentThreadId: string;
} | undefined {
  if (!isJsonObject(params) || !isJsonObject(params["thread"])) return undefined;
  const childThreadId = params["thread"]["id"];
  const parentThreadId = params["thread"]["parentThreadId"];
  return validThreadIdentity(childThreadId) && validThreadIdentity(parentThreadId)
    ? { childThreadId, parentThreadId }
    : undefined;
}

function validThreadIdentity(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

type DefaultResult =
  | { readonly kind: "result"; readonly value: JsonValue }
  | { readonly kind: "error"; readonly code: number; readonly message: string };

function defaultRequestResult(method: string, params: JsonValue): DefaultResult {
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const record = isJsonObject(params) ? params : {};
      const available = commandApprovalAvailability(record["availableDecisions"], record);
      if (available.malformed) {
        return { kind: "error", code: -32602, message: "The command approval decision list is invalid." };
      }
      if (available.decisions.includes("decline")) {
        return { kind: "result", value: { decision: "decline" } };
      }
      if (available.decisions.includes("cancel")) {
        return { kind: "result", value: { decision: "cancel" } };
      }
      return { kind: "error", code: -32602, message: "No fail-closed command approval decision is available." };
    }
    case "item/fileChange/requestApproval":
      return { kind: "result", value: { decision: "decline" } };
    case "item/permissions/requestApproval":
      return { kind: "result", value: { permissions: {}, scope: "turn" } };
    case "item/tool/requestUserInput": {
      const record = isJsonObject(params) ? params : {};
      const questions = Array.isArray(record["questions"]) ? record["questions"] : [];
      const answers = Object.create(null) as JsonObject;
      const seen = new Set<string>();
      for (const question of questions.slice(0, 3)) {
        if (!isJsonObject(question)
          || typeof question["id"] !== "string"
          || question["id"].length === 0
          || question["id"].length > 256
          || /[\u0000-\u001f\u007f]/.test(question["id"])
          || seen.has(question["id"])) {
          return { kind: "error", code: -32602, message: "The user-input question schema is invalid." };
        }
        seen.add(question["id"]);
        answers[question["id"]] = { answers: [] };
      }
      return { kind: "result", value: { answers } };
    }
    case "mcpServer/elicitation/request":
      return { kind: "result", value: { action: "decline", content: null } };
    default:
      return { kind: "error", code: -32601, message: "This client does not provide the requested stable capability." };
  }
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
