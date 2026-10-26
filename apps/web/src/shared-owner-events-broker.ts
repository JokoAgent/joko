import { toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { isEndpointTrustError } from "@joko/connection-transport/trust";
import { EventSchema, type Event, type EventCursor } from "@joko/contracts";
import { normalizeOrchestratorOrigin } from "./connection-origin.js";

export interface SharedOwnerEventsOwner {
  readonly profileId: string;
  readonly serverId: string;
  readonly deviceId: string;
  readonly origin: string;
  readonly endpointPublicKey?: string;
}

export interface SharedOwnerEventsSink {
  accepted?(): void;
  event(bytes: ArrayBuffer, serial: number): void;
  error(code: number, message: string, endpointTrustFailed?: true): void;
}

export interface SharedOwnerEventsSubscription {
  ack(serial: number): void;
  close(): void;
}

export interface SharedOwnerEventsBrokerOptions {
  readonly openStream: (
    owner: SharedOwnerEventsOwner,
    authKey: string,
    afterCursor: EventCursor,
    signal: AbortSignal,
    onAccepted: () => void
  ) => AsyncIterable<Event>;
  readonly maxEvents?: number;
  readonly maxBytes?: number;
}

interface BufferedEvent {
  readonly cursor: EventCursor;
  readonly bytes: Uint8Array;
}

interface Consumer {
  readonly group: OwnerGroup;
  readonly sink: SharedOwnerEventsSink;
  cursor: EventCursor;
  inflight?: { readonly serial: number; readonly cursor: EventCursor };
  closed: boolean;
}

interface OwnerGroup {
  readonly owner: SharedOwnerEventsOwner;
  readonly authKey: string;
  readonly abort: AbortController;
  readonly consumers: Set<Consumer>;
  readonly events: BufferedEvent[];
  floor: EventCursor;
  cursor: EventCursor;
  bytes: number;
  accepted: boolean;
  closing: boolean;
  task?: Promise<void>;
}

const CLOSED_SUBSCRIPTION: SharedOwnerEventsSubscription = { ack: () => undefined, close: () => undefined };

/** Shares only authenticated owner Events; each Document keeps its own projection and cursor. */
export class SharedOwnerEventsBroker {
  readonly #options: SharedOwnerEventsBrokerOptions;
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  readonly #groups = new Set<OwnerGroup>();
  #serial = 0;
  #disposed = false;

  constructor(options: SharedOwnerEventsBrokerOptions) {
    this.#options = options;
    this.#maxEvents = options.maxEvents ?? 1_024;
    this.#maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxEvents) || this.#maxEvents < 1
      || !Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1) {
      throw new TypeError("Shared event buffers require positive integer limits.");
    }
  }

  subscribe(owner: SharedOwnerEventsOwner, authKey: string, cursor: EventCursor, sink: SharedOwnerEventsSink): SharedOwnerEventsSubscription {
    if (this.#disposed) return rejectSubscription(sink, Code.Canceled);
    if (!validOwner(owner) || !authKey || authKey.length > 4_096 || !validCursor(cursor)) {
      return rejectSubscription(sink, Code.InvalidArgument);
    }
    const matching = [...this.#groups].filter(group => sameOwner(group.owner, owner) && group.authKey === authKey);
    let group = matching.find(candidate => !candidate.closing);
    let previous: Promise<void> | undefined;
    if (group === undefined) {
      previous = matching.at(-1)?.task;
      const initial = copyCursor(cursor);
      group = { owner: Object.freeze({ profileId: owner.profileId, serverId: owner.serverId, deviceId: owner.deviceId, origin: owner.origin, endpointPublicKey: owner.endpointPublicKey }),
        authKey, abort: new AbortController(), consumers: new Set(), events: [], floor: initial, cursor: initial, bytes: 0, accepted: false, closing: false };
      this.#groups.add(group);
    } else if (cursor.generation !== group.cursor.generation) {
      this.#fail(group, Code.FailedPrecondition);
      return rejectSubscription(sink, Code.FailedPrecondition);
    } else if (cursor.sequence < group.floor.sequence) {
      return rejectSubscription(sink, Code.OutOfRange);
    }
    const consumer: Consumer = { group, sink, cursor: copyCursor(cursor), closed: false };
    group.consumers.add(consumer);
    const subscription: SharedOwnerEventsSubscription = {
      ack: serial => {
        if (consumer.closed || consumer.inflight?.serial !== serial) return;
        consumer.cursor = consumer.inflight.cursor;
        consumer.inflight = undefined;
        this.#pump(consumer);
      },
      close: () => this.#close(consumer)
    };
    if (group.accepted) this.#accept(consumer);
    this.#pump(consumer);
    group.task ??= this.#consume(group, previous);
    return subscription;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const group of this.#groups) this.#fail(group, Code.Canceled);
  }

  async #consume(group: OwnerGroup, previous: Promise<void> | undefined): Promise<void> {
    try {
      await previous;
      if (group.closing) return;
      const accepted = (): void => {
        if (group.closing || group.abort.signal.aborted || group.accepted) return;
        group.accepted = true;
        for (const consumer of [...group.consumers]) this.#accept(consumer);
      };
      for await (const event of this.#options.openStream(group.owner, group.authKey, copyCursor(group.cursor), group.abort.signal, accepted)) {
        if (group.closing || group.abort.signal.aborted) return;
        const cursor = event.cursor;
        if (!validCursor(cursor) || cursor.generation !== group.cursor.generation) {
          this.#fail(group, Code.FailedPrecondition); return;
        }
        if (cursor.sequence <= group.cursor.sequence) continue;
        const bytes = toBinary(EventSchema, event);
        const saved = copyCursor(cursor);
        group.events.push({ cursor: saved, bytes }); group.bytes += bytes.byteLength; group.cursor = saved;
        while (group.events.length > this.#maxEvents || group.bytes > this.#maxBytes && group.events.length > 1) {
          const removed = group.events.shift()!;
          group.bytes -= removed.bytes.byteLength; group.floor = removed.cursor;
        }
        for (const consumer of group.consumers) this.#pump(consumer);
      }
      if (!group.closing) this.#fail(group, Code.Unavailable);
    } catch (error) {
      if (!group.closing) this.#fail(group, ConnectError.from(error).code, isEndpointTrustError(error) ? true : undefined);
    } finally {
      group.closing = true; group.abort.abort(); group.events.length = 0; group.bytes = 0;
      this.#groups.delete(group);
    }
  }

  #accept(consumer: Consumer): void {
    if (consumer.closed) return;
    try { consumer.sink.accepted?.(); }
    catch { this.#close(consumer); }
  }

  #pump(consumer: Consumer): void {
    if (consumer.closed || consumer.inflight !== undefined) return;
    const group = consumer.group;
    if (consumer.cursor.generation !== group.cursor.generation) { this.#close(consumer, Code.FailedPrecondition); return; }
    if (consumer.cursor.sequence < group.floor.sequence) { this.#close(consumer, Code.OutOfRange); return; }
    const next = group.events.find(event => event.cursor.sequence > consumer.cursor.sequence);
    if (next === undefined) return;
    const serial = ++this.#serial;
    consumer.inflight = { serial, cursor: next.cursor };
    // Each port may transfer this copy; the shared replay buffer stays attached.
    const bytes = new Uint8Array(next.bytes.byteLength); bytes.set(next.bytes);
    try { consumer.sink.event(bytes.buffer, serial); }
    catch { this.#close(consumer); }
  }

  #close(consumer: Consumer, code?: Code, endpointTrustFailed?: true): void {
    if (consumer.closed) return;
    consumer.closed = true; consumer.inflight = undefined;
    const group = consumer.group;
    group.consumers.delete(consumer);
    if (group.consumers.size === 0) { group.closing = true; group.abort.abort(); }
    if (code !== undefined) sendError(consumer.sink, code, endpointTrustFailed);
  }

  #fail(group: OwnerGroup, code: Code, endpointTrustFailed?: true): void {
    group.closing = true; group.abort.abort();
    for (const consumer of [...group.consumers]) this.#close(consumer, code, endpointTrustFailed);
  }
}

function validOwner(owner: SharedOwnerEventsOwner): boolean {
  if (![owner.profileId, owner.serverId, owner.deviceId].every(value => typeof value === "string" && value.length > 0 && value.length <= 256)) return false;
  if (owner.endpointPublicKey !== undefined && !/^ed25519:[a-f0-9]{64}$/u.test(owner.endpointPublicKey)) return false;
  try { return normalizeOrchestratorOrigin(owner.origin) === owner.origin; } catch { return false; }
}
function validCursor(cursor: EventCursor | undefined): cursor is EventCursor {
  return cursor !== undefined && typeof cursor.sequence === "bigint" && cursor.sequence >= 0n
    && typeof cursor.generation === "bigint" && cursor.generation >= 0n
    && typeof cursor.opaqueToken === "string" && cursor.opaqueToken.length > 0 && cursor.opaqueToken.length <= 4_096;
}
function copyCursor(cursor: EventCursor): EventCursor {
  return { ...cursor, ...(cursor.issuedAt === undefined ? {} : { issuedAt: { ...cursor.issuedAt } }) };
}
function sameOwner(left: SharedOwnerEventsOwner, right: SharedOwnerEventsOwner): boolean {
  return left.profileId === right.profileId && left.serverId === right.serverId && left.deviceId === right.deviceId && left.origin === right.origin && left.endpointPublicKey === right.endpointPublicKey;
}
function rejectSubscription(sink: SharedOwnerEventsSink, code: Code): SharedOwnerEventsSubscription {
  sendError(sink, code); return CLOSED_SUBSCRIPTION;
}
function sendError(sink: SharedOwnerEventsSink, code: Code, endpointTrustFailed?: true): void {
  if (endpointTrustFailed) { try { sink.error(code, "The node security check failed.", true); } catch { /* Retired receiver. */ } return; }
  const message = code === Code.Unauthenticated || code === Code.PermissionDenied ? "The event connection is no longer authorized."
    : code === Code.OutOfRange || code === Code.FailedPrecondition ? "The event cursor must be refreshed."
      : code === Code.InvalidArgument ? "The event subscription is invalid."
        : code === Code.ResourceExhausted ? "The event stream exceeds its buffer limit."
          : code === Code.Canceled ? "The shared event subscription stopped." : "The event stream is unavailable.";
  try { sink.error(code, message); } catch { /* A retired receiver cannot affect other subscriptions. */ }
}
