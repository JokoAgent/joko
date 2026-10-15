import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { EventCursorSchema, EventSchema, type Event, type EventCursor } from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { SharedOwnerEventsBroker, type SharedOwnerEventsOwner, type SharedOwnerEventsSink } from "./shared-owner-events-broker.js";

const OWNER: SharedOwnerEventsOwner = { profileId: "connection-one", serverId: "server-one", deviceId: "device-one", origin: "http://127.0.0.1:4318" };
function cursor(sequence: bigint, generation = 7n): EventCursor {
  return create(EventCursorSchema, { opaqueToken: `cursor-${generation}-${sequence}`, sequence, generation, issuedAt: { seconds: sequence, nanos: 123 } });
}
function event(sequence: bigint, generation = 7n, text = `Text ${sequence}`): Event {
  return create(EventSchema, { eventId: `event-${generation}-${sequence}`, cursor: cursor(sequence, generation),
    identity: { sessionId: "session-one", generation: 1n }, payload: { kind: { case: "textDelta", value: { messageId: "message-one", delta: text } } } });
}
function receiver() {
  const events: Array<{ event: Event; serial: number }> = [];
  const errors: Array<{ code: number; message: string }> = [];
  const sink: SharedOwnerEventsSink = { event: (bytes, serial) => {
    const transferred = structuredClone(bytes, { transfer: [bytes] });
    events.push({ event: fromBinary(EventSchema, new Uint8Array(transferred)), serial });
  }, error: (code, message) => errors.push({ code, message }) };
  return { sink, events, errors };
}
function source() {
  const calls: Array<{ owner: SharedOwnerEventsOwner; authKey: string; cursor: EventCursor; signal: AbortSignal;
    push(event: Event): void; fail(error: Error): void; finish(): void }> = [];
  const openStream = vi.fn(async function* (owner: SharedOwnerEventsOwner, authKey: string, afterCursor: EventCursor, signal: AbortSignal) {
    const pending: Event[] = []; let wake: (() => void) | undefined, failed: Error | undefined, ended = false;
    const abort = () => wake?.(); signal.addEventListener("abort", abort);
    calls.push({ owner, authKey, cursor: afterCursor, signal,
      push: value => { pending.push(value); wake?.(); }, fail: error => { failed = error; wake?.(); }, finish: () => { ended = true; wake?.(); } });
    try { while (!signal.aborted) { if (failed) throw failed; if (pending.length) yield pending.shift()!;
      else if (ended) return; else await new Promise<void>(resolve => { wake = resolve; }); } }
    finally { signal.removeEventListener("abort", abort); }
  });
  return { calls, openStream };
}
async function settle() { for (let index = 0; index < 20; index++) await Promise.resolve(); }

describe("shared owner event broker", () => {
  it("shares one upstream while each cursor and exact ACK independently gate original Event bytes", async () => {
    const upstream = source(), broker = new SharedOwnerEventsBroker(upstream), first = receiver(), later = receiver();
    const a = broker.subscribe(OWNER, "credential", cursor(0n), first.sink);
    const b = broker.subscribe(OWNER, "credential", cursor(2n), later.sink);
    await settle(); expect(upstream.calls).toHaveLength(1); expect(upstream.calls[0]!.cursor).toEqual(cursor(0n));
    for (const sequence of [1n, 2n, 3n]) upstream.calls[0]!.push(event(sequence)); await settle();
    expect(first.events.map(value => value.event.cursor?.sequence)).toEqual([1n]);
    expect(later.events.map(value => value.event.cursor?.sequence)).toEqual([3n]);
    a.ack(later.events[0]!.serial); a.ack(first.events[0]!.serial + 50); await settle(); expect(first.events).toHaveLength(1);
    a.ack(first.events[0]!.serial); expect(first.events[1]!.event).toEqual(event(2n));
    a.ack(first.events[0]!.serial); expect(first.events).toHaveLength(2);
    a.ack(first.events[1]!.serial); expect(first.events[2]!.event).toEqual(event(3n));
    expect(first.events[2]!.event.cursor).toEqual(later.events[0]!.event.cursor);
    a.close(); expect(upstream.calls[0]!.signal.aborted).toBe(false); b.close(); expect(upstream.calls[0]!.signal.aborted).toBe(true); await settle();
  });

  it("isolates every owner identity and credential occurrence without exposing credentials in errors", async () => {
    const upstream = source(), broker = new SharedOwnerEventsBroker(upstream), receivers = Array.from({ length: 6 }, receiver);
    const owners = [OWNER, { ...OWNER, profileId: "connection-two" }, { ...OWNER, serverId: "server-two" },
      { ...OWNER, deviceId: "device-two" }, { ...OWNER, origin: "http://127.0.0.1:4319" }, OWNER];
    const subscriptions = owners.map((owner, index) => broker.subscribe(owner, index === 5 ? "replacement-secret" : "original-secret", cursor(0n), receivers[index]!.sink));
    await settle(); expect(upstream.calls).toHaveLength(6);
    upstream.calls[0]!.push(event(1n)); await settle();
    expect(receivers.map(value => value.events.length)).toEqual([1, 0, 0, 0, 0, 0]);
    upstream.calls[0]!.fail(new ConnectError("original-secret https://private.invalid/body", Code.Unauthenticated)); await settle();
    expect(receivers[0]!.errors).toEqual([{ code: Code.Unauthenticated, message: "The event connection is no longer authorized." }]);
    expect(receivers.slice(1).every(value => value.errors.length === 0)).toBe(true);
    subscriptions.forEach(subscription => subscription.close()); await settle();
  });

  it("retains the exact cursor before a bounded count ring and reports slow or late consumers without skipping them", async () => {
    const upstream = source(), broker = new SharedOwnerEventsBroker({ ...upstream, maxEvents: 2 }), slow = receiver();
    const subscription = broker.subscribe(OWNER, "credential", cursor(0n), slow.sink); await settle();
    for (const sequence of [1n, 2n, 3n]) upstream.calls[0]!.push(event(sequence)); await settle();
    const stale = receiver(), retained = receiver();
    broker.subscribe(OWNER, "credential", cursor(0n), stale.sink);
    const current = broker.subscribe(OWNER, "credential", cursor(1n), retained.sink);
    expect(stale.events).toEqual([]); expect(stale.errors[0]?.code).toBe(Code.OutOfRange);
    expect(retained.events[0]!.event).toEqual(event(2n));
    upstream.calls[0]!.push(event(4n)); await settle();
    subscription.ack(slow.events[0]!.serial);
    expect(slow.events).toHaveLength(1); expect(slow.errors[0]?.code).toBe(Code.OutOfRange);
    current.ack(retained.events[0]!.serial); expect(retained.events[1]!.event).toEqual(event(3n)); current.close(); await settle();
  });

  it("enforces the byte ring and generation boundary without changing or inventing a cursor", async () => {
    const firstEvent = event(1n), secondEvent = event(2n), upstream = source();
    const broker = new SharedOwnerEventsBroker({ ...upstream, maxBytes: toBinary(EventSchema, firstEvent).byteLength + toBinary(EventSchema, secondEvent).byteLength - 1 });
    const first = receiver(), subscription = broker.subscribe(OWNER, "credential", cursor(0n), first.sink); await settle();
    upstream.calls[0]!.push(firstEvent); upstream.calls[0]!.push(secondEvent); await settle();
    const old = receiver(), edge = receiver(), otherGeneration = receiver();
    broker.subscribe(OWNER, "credential", cursor(0n), old.sink);
    const edgeSubscription = broker.subscribe(OWNER, "credential", cursor(1n), edge.sink);
    broker.subscribe(OWNER, "credential", cursor(2n, 8n), otherGeneration.sink);
    expect(old.errors[0]?.code).toBe(Code.OutOfRange); expect(edge.events[0]!.event.cursor).toEqual(cursor(2n));
    expect(otherGeneration.errors[0]?.code).toBe(Code.FailedPrecondition); expect(upstream.calls).toHaveLength(1);
    expect(first.errors[0]?.code).toBe(Code.FailedPrecondition); expect(edge.errors[0]?.code).toBe(Code.FailedPrecondition);
    expect(upstream.calls[0]!.signal.aborted).toBe(true); subscription.close(); edgeSubscription.close();
    await settle();
    const refreshed = receiver(); broker.subscribe(OWNER, "credential", cursor(2n), refreshed.sink); await settle();
    upstream.calls[1]!.push(event(3n, 8n)); await settle(); expect(refreshed.errors[0]?.code).toBe(Code.FailedPrecondition);
  });

  it("retires a still-live generation for every consumer and waits for retirement before sharing fresh subscriptions", async () => {
    const upstream = source(); let release!: () => void;
    const retired = new Promise<void>(resolve => { release = resolve; }); let opened = 0, active = 0, maximumActive = 0;
    const openStream = vi.fn(async function* (owner: SharedOwnerEventsOwner, authKey: string, after: EventCursor, signal: AbortSignal) {
      const first = ++opened === 1; active++; maximumActive = Math.max(maximumActive, active);
      try { yield* upstream.openStream(owner, authKey, after, signal); }
      finally { if (first) await retired; active--; }
    });
    const broker = new SharedOwnerEventsBroker({ openStream }), old = receiver(), oldPeer = receiver(), conflict = receiver();
    broker.subscribe(OWNER, "credential", cursor(0n), old.sink);
    broker.subscribe(OWNER, "credential", cursor(2n), oldPeer.sink); await settle();
    broker.subscribe(OWNER, "credential", cursor(1n, 8n), conflict.sink);
    expect([old, oldPeer, conflict].map(value => value.errors.map(error => error.code))).toEqual([
      [Code.FailedPrecondition], [Code.FailedPrecondition], [Code.FailedPrecondition]
    ]);
    expect(upstream.calls[0]!.signal.aborted).toBe(true); await settle();
    const fresh = receiver(), freshPeer = receiver();
    const a = broker.subscribe(OWNER, "credential", cursor(3n, 8n), fresh.sink);
    const b = broker.subscribe(OWNER, "credential", cursor(5n, 8n), freshPeer.sink); await settle();
    expect(openStream).toHaveBeenCalledTimes(1);
    release(); await settle(); expect(openStream).toHaveBeenCalledTimes(2); expect(maximumActive).toBe(1);
    expect(upstream.calls[1]!.cursor).toEqual(cursor(3n, 8n));
    upstream.calls[1]!.push(event(4n, 8n)); await settle();
    expect(fresh.events[0]!.event).toEqual(event(4n, 8n)); expect(freshPeer.events).toEqual([]);
    a.close(); b.close(); await settle(); expect(active).toBe(0);
  });

  it("never overlaps a replacement stream with an upstream that is still retiring", async () => {
    const upstream = source(); let release!: () => void;
    const retired = new Promise<void>(resolve => { release = resolve; }); let opened = 0;
    const openStream = vi.fn(async function* (owner: SharedOwnerEventsOwner, authKey: string, after: EventCursor, signal: AbortSignal) {
      const first = ++opened === 1;
      try { yield* upstream.openStream(owner, authKey, after, signal); }
      finally { if (first) await retired; }
    });
    const broker = new SharedOwnerEventsBroker({ openStream }), first = receiver(), replacement = receiver();
    const a = broker.subscribe(OWNER, "credential", cursor(0n), first.sink); await settle(); a.close(); await settle();
    const b = broker.subscribe(OWNER, "credential", cursor(4n), replacement.sink); await settle(); expect(openStream).toHaveBeenCalledTimes(1);
    release(); await settle(); expect(openStream).toHaveBeenCalledTimes(2); expect(upstream.calls[1]!.cursor).toEqual(cursor(4n));
    b.close(); await settle();
  });

  it("closes only a throwing receiver, delivers a complete Event beyond the ring budget, and retires all buffers", async () => {
    const upstream = source(), broker = new SharedOwnerEventsBroker({ ...upstream, maxBytes: 1_024 }), healthy = receiver();
    broker.subscribe(OWNER, "credential", cursor(0n), { event: () => { throw new Error("Receiver closed"); }, error: () => undefined });
    const healthySubscription = broker.subscribe(OWNER, "credential", cursor(0n), healthy.sink); await settle(); upstream.calls[0]!.push(event(1n)); await settle();
    expect(healthy.events[0]!.event).toEqual(event(1n)); expect(upstream.calls[0]!.signal.aborted).toBe(false);
    healthySubscription.ack(healthy.events[0]!.serial);
    const large = event(2n, 7n, "x".repeat(2_048)); expect(toBinary(EventSchema, large).byteLength).toBeGreaterThan(1_024);
    upstream.calls[0]!.push(large); await settle(); expect(healthy.events[1]!.event).toEqual(large); expect(healthy.errors).toEqual([]);
    healthySubscription.ack(healthy.events[1]!.serial);
    upstream.calls[0]!.push(event(3n)); await settle(); expect(healthy.events[2]!.event).toEqual(event(3n));
    const stale = receiver(), edge = receiver(); broker.subscribe(OWNER, "credential", cursor(1n), stale.sink);
    const edgeSubscription = broker.subscribe(OWNER, "credential", cursor(2n), edge.sink);
    expect(stale.errors[0]?.code).toBe(Code.OutOfRange); expect(edge.events[0]!.event).toEqual(event(3n));
    edgeSubscription.close(); healthySubscription.close(); await settle(); expect(upstream.calls[0]!.signal.aborted).toBe(true);
    const next = receiver(); broker.subscribe(OWNER, "credential", cursor(3n), next.sink); await settle(); broker.dispose(); await settle();
    expect(next.errors[0]?.code).toBe(Code.Canceled); expect(upstream.calls[1]!.signal.aborted).toBe(true);
    const disposed = receiver(); broker.subscribe(OWNER, "credential", cursor(3n), disposed.sink); expect(disposed.errors[0]?.code).toBe(Code.Canceled);
  });
});
