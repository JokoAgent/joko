import { create, toBinary } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { EventCursorSchema, EventSchema, ExtensionNotificationKind, ExtensionUiEffectKind, GetSnapshotResponseSchema } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSharedOwnerEvents, type SharedOwnerEventsReply, type SharedOwnerEventsRequest } from "./shared-owner-events.js";
import { createOrchestratorGateway } from "./gateway.js";

const owner = { profileId: "profile-one", serverId: "node-one", deviceId: "device-one", origin: "https://node.example" };
const cursor = create(EventCursorSchema, { generation: 3n, sequence: 9n, opaqueToken: "cursor-nine" });
const workers: FakeWorker[] = [];
class FakePort {
  onmessage: ((event: MessageEvent<SharedOwnerEventsReply>) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly sent: SharedOwnerEventsRequest[] = [];
  readonly start = vi.fn();
  readonly close = vi.fn();
  postMessage(message: SharedOwnerEventsRequest): void { this.sent.push(message); }
  emit(reply: SharedOwnerEventsReply): void { this.onmessage?.({ data: reply } as MessageEvent<SharedOwnerEventsReply>); }
}
class FakeWorker {
  readonly port = new FakePort();
  onerror: (() => void) | null = null;
  constructor(readonly url: URL, readonly options: WorkerOptions) { workers.push(this); }
}
function harness() {
  vi.stubGlobal("SharedWorker", FakeWorker);
  const host = new EventTarget();
  vi.stubGlobal("window", host);
  const abort = new AbortController();
  const retired = vi.fn(() => abort.abort());
  const iterator = streamSharedOwnerEvents(owner, "private-credential", cursor, abort.signal, retired);
  const reading = iterator.next();
  const worker = workers.at(-1)!;
  return { host, abort, retired, iterator, reading, worker, port: worker.port };
}
function bytes(sequence: bigint): ArrayBuffer {
  return toBinary(EventSchema, create(EventSchema, { eventId: `event-${sequence}`, cursor: { generation: 3n, sequence } })).slice().buffer;
}
afterEach(() => { workers.length = 0; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("shared Event connection occurrence", () => {
  it("refreshes an expired shared replay cursor before subscribing again and ignores the retired port", async () => {
    vi.stubGlobal("SharedWorker", FakeWorker);
    vi.stubGlobal("window", new EventTarget());
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const path = new URL(request instanceof Request ? request.url : String(request)).pathname;
      if (path === "/joko.v1.ManagedModelRuntimeService/ListManagedModelRuntimes") return new Response(new Uint8Array(), { headers: { "content-type": "application/proto" } });
      expect(path).toBe("/joko.v1.EventService/GetSnapshot");
      return new Response(toBinary(GetSnapshotResponseSchema, create(GetSnapshotResponseSchema, {
        snapshot: { generation: 3n, resumeCursor: ++reads === 1 ? cursor : { generation: 3n, sequence: 12n, opaqueToken: "cursor-twelve" } }
      })), { headers: { "content-type": "application/proto" } });
    }));
    const onError = vi.fn(), onExtensionUiEffect = vi.fn();
    const gateway = createOrchestratorGateway({ id: owner.profileId, serverId: owner.serverId, deviceId: owner.deviceId,
      origin: owner.origin, name: "Node" }, "private-credential", { onError, onExtensionUiEffect });
    try {
      await gateway.connect();
      workers[0]!.port.emit({ type: "ready" });
      workers[0]!.port.emit({ type: "error", code: Code.OutOfRange, message: "The cursor expired." });
      await vi.waitFor(() => expect(workers).toHaveLength(2));
      expect(workers[1]!.port.sent[0]).toMatchObject({ type: "subscribe", cursor: { generation: 3n, sequence: 12n, opaqueToken: "cursor-twelve" } });
      expect(workers[0]!.port.close).toHaveBeenCalledOnce();
      workers[0]!.port.emit({ type: "event", bytes: bytes(10n), serial: 1 });
      expect(onExtensionUiEffect).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(reads).toBe(2);
    } finally { gateway.disconnect(); }
  });

  it("connects the production Gateway through the worker while keeping each page's effects and revocation independent", async () => {
    vi.stubGlobal("SharedWorker", FakeWorker);
    vi.stubGlobal("window", new EventTarget());
    const fetch = vi.fn(async (request: RequestInfo | URL) => {
      const path = new URL(request instanceof Request ? request.url : String(request)).pathname;
      if (path === "/joko.v1.ManagedModelRuntimeService/ListManagedModelRuntimes") return new Response(new Uint8Array(), { headers: { "content-type": "application/proto" } });
      expect(path).toBe("/joko.v1.EventService/GetSnapshot");
      return new Response(toBinary(GetSnapshotResponseSchema, create(GetSnapshotResponseSchema, {
        snapshot: { generation: 3n, resumeCursor: cursor }
      })), { headers: { "content-type": "application/proto" } });
    });
    vi.stubGlobal("fetch", fetch);
    const effects = [vi.fn(), vi.fn()];
    const revoked = vi.fn();
    const gateways = effects.map((onExtensionUiEffect, index) => createOrchestratorGateway({
      id: owner.profileId, serverId: owner.serverId, deviceId: owner.deviceId, origin: owner.origin, name: "Node"
    }, "private-credential", { onExtensionUiEffect, ...(index === 1 ? { onAuthenticationInvalidated: revoked } : {}) }));
    try {
      await Promise.all(gateways.map(gateway => gateway.connect()));
      expect(workers).toHaveLength(2);
      const event = toBinary(EventSchema, create(EventSchema, { eventId: "notification-one", cursor: { generation: 3n, sequence: 10n },
        identity: { sessionId: "session-one" }, payload: { kind: { case: "extensionUiEffect", value: {
          kind: ExtensionUiEffectKind.NOTIFICATION, notificationKind: ExtensionNotificationKind.INFO, text: "Ready"
        } } } }));
      for (const worker of workers) {
        worker.port.emit({ type: "ready" });
        worker.port.emit({ type: "event", bytes: event.slice().buffer, serial: 1 });
      }
      await vi.waitFor(() => { expect(effects[0]).toHaveBeenCalledOnce(); expect(effects[1]).toHaveBeenCalledOnce(); });
      workers[1]!.port.emit({ type: "event", bytes: event.slice().buffer, serial: 2 });
      await vi.waitFor(() => expect(workers[1]!.port.sent.at(-1)).toEqual({ type: "ack", serial: 2 }));
      expect(effects[1]).toHaveBeenCalledOnce();
      gateways[0]!.disconnect();
      workers[1]!.port.emit({ type: "error", code: Code.Unauthenticated, message: "Connection revoked." });
      await vi.waitFor(() => expect(revoked).toHaveBeenCalledOnce());
      expect(workers.every(worker => worker.port.close.mock.calls.length === 1)).toBe(true);
    } finally { gateways.forEach(gateway => gateway.disconnect()); }
  });

  it("keeps credentials on the private port and acknowledges only after the consumer has handled an Event", async () => {
    const h = harness();
    expect(h.worker.options).toEqual({ name: "joko-owner-events-v1", type: "module" });
    expect(h.worker.url.search).toBe("");
    expect(h.port.sent).toEqual([{ type: "subscribe", owner, authKey: "private-credential", cursor }]);
    h.port.emit({ type: "ready" });
    h.port.emit({ type: "event", bytes: bytes(10n), serial: 4 });
    expect((await h.reading).value?.event?.cursor?.sequence).toBe(10n);
    expect(h.port.sent.some(message => message.type === "ack")).toBe(false);
    const next = h.iterator.next();
    expect(h.port.sent.at(-1)).toEqual({ type: "ack", serial: 4 });
    h.port.emit({ type: "ping" });
    expect(h.port.sent.at(-1)).toEqual({ type: "pong" });
    h.abort.abort();
    expect((await next).done).toBe(true);
    expect(h.port.sent.at(-1)).toEqual({ type: "close" });
    expect(h.port.close).toHaveBeenCalledOnce();
    expect(h.port.onmessage).toBeNull();
  });

  it.each([Code.OutOfRange, Code.FailedPrecondition, Code.Unauthenticated])("preserves generated recovery/authentication code %s", async code => {
    const h = harness();
    h.port.emit({ type: "ready" });
    h.port.emit({ type: "error", code, message: "Event connection rejected." });
    await expect(h.reading).rejects.toMatchObject({ code });
    expect(h.port.close).toHaveBeenCalledOnce();
  });

  it("retires only this Document occurrence and ignores late port messages", async () => {
    const old = harness();
    old.port.emit({ type: "ready" });
    old.host.dispatchEvent(new globalThis.Event("pagehide"));
    expect((await old.reading).done).toBe(true);
    expect(old.retired).toHaveBeenCalledOnce();
    const next = harness();
    next.port.emit({ type: "ready" });
    old.port.emit({ type: "event", bytes: bytes(10n), serial: 1 });
    next.port.emit({ type: "event", bytes: bytes(11n), serial: 2 });
    expect((await next.reading).value?.event?.cursor?.sequence).toBe(11n);
    const ending = next.iterator.next(); next.abort.abort(); await ending;
    expect(old.port.sent.filter(message => message.type === "ack")).toHaveLength(0);
  });

  it("releases an unresponsive worker instead of retaining a silent connection", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.port.emit({ type: "ready" });
    const assertion = expect(h.reading).rejects.toMatchObject({ code: Code.Unavailable });
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
    expect(h.port.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
