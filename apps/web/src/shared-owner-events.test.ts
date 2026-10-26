import { create, toBinary } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { isEndpointTrustError } from "@joko/connection-transport/trust";
import { EventCursorSchema, EventSchema, ExtensionNotificationKind, ExtensionUiEffectKind, GetSnapshotResponseSchema } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSharedOwnerEvents, type SharedOwnerEventsReply, type SharedOwnerEventsRequest } from "./shared-owner-events.js";
import { createOrchestratorGateway } from "./gateway.js";

const owner = { profileId: "profile-one", serverId: "node-one", deviceId: "device-one", origin: "http://127.0.0.1:4318" };
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
  const accepted = vi.fn();
  const iterator = streamSharedOwnerEvents(owner, "private-credential", cursor, abort.signal, retired, accepted);
  const reading = iterator.next();
  const worker = workers.at(-1)!;
  return { host, abort, retired, accepted, iterator, reading, worker, port: worker.port };
}
function bytes(sequence: bigint): ArrayBuffer {
  return toBinary(EventSchema, create(EventSchema, { eventId: `event-${sequence}`, cursor: { generation: 3n, sequence } })).slice().buffer;
}
afterEach(() => { workers.length = 0; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("shared Event connection occurrence", () => {
  it("keeps retry errors through port readiness and restores connection only after upstream acceptance", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("SharedWorker", FakeWorker);
    vi.stubGlobal("window", Object.assign(new EventTarget(), { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }));
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const path = new URL(request instanceof Request ? request.url : String(request)).pathname;
      if (path === "/joko.v1.ManagedModelRuntimeService/ListManagedModelRuntimes") return new Response(new Uint8Array(), { headers: { "content-type": "application/proto" } });
      expect(path).toBe("/joko.v1.EventService/GetSnapshot");
      return new Response(toBinary(GetSnapshotResponseSchema, create(GetSnapshotResponseSchema, {
        snapshot: { generation: 3n, resumeCursor: cursor }
      })), { headers: { "content-type": "application/proto" } });
    }));
    const states: string[] = [], errors: string[] = [];
    const gateway = createOrchestratorGateway({ id: owner.profileId, serverId: owner.serverId, deviceId: owner.deviceId,
      origin: owner.origin, name: "Node" }, "private-credential", {
      onState: state => states.push(state), onError: error => errors.push(error.message)
    });
    try {
      await gateway.connect();
      workers[0]!.port.emit({ type: "ready" }); workers[0]!.port.emit({ type: "accepted" });
      workers[0]!.port.emit({ type: "error", code: Code.Unavailable, message: "Upstream offline" });
      await vi.advanceTimersByTimeAsync(0);
      const established = states.filter(state => state === "connected").length;
      expect(states.at(-1)).toBe("offline");
      await vi.advanceTimersByTimeAsync(350);
      expect(workers).toHaveLength(2); workers[1]!.port.emit({ type: "ready" });
      expect(states.at(-1)).toBe("offline"); expect(errors.at(-1)).toBe("Upstream offline");
      expect(states.filter(state => state === "connected")).toHaveLength(established);
      workers[1]!.port.emit({ type: "error", code: Code.Unavailable, message: "Still offline" });
      await vi.advanceTimersByTimeAsync(700);
      expect(workers).toHaveLength(3); workers[2]!.port.emit({ type: "ready" });
      expect(states.at(-1)).toBe("offline"); expect(errors.at(-1)).toBe("Still offline");
      workers[0]!.port.emit({ type: "accepted" }); workers[1]!.port.emit({ type: "accepted" });
      expect(states.filter(state => state === "connected")).toHaveLength(established);
      workers[2]!.port.emit({ type: "accepted" });
      expect(states.at(-1)).toBe("connected");
      expect(states.filter(state => state === "connected")).toHaveLength(established + 1);
    } finally { gateway.disconnect(); await vi.advanceTimersByTimeAsync(0); }
  });

  it("distinguishes a private port ready signal from upstream acceptance and ignores late acceptance after failure", async () => {
    const h = harness();
    h.port.emit({ type: "ready" }); expect(h.accepted).not.toHaveBeenCalled();
    h.port.emit({ type: "accepted" }); h.port.emit({ type: "accepted" }); expect(h.accepted).toHaveBeenCalledOnce();
    h.port.emit({ type: "error", code: Code.Unavailable, message: "Offline" });
    h.port.emit({ type: "accepted" });
    await expect(h.reading).rejects.toMatchObject({ code: Code.Unavailable });
    expect(h.accepted).toHaveBeenCalledOnce();
  });

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

  it("retains a worker security failure as terminal without turning it into credential revocation", async () => {
    const h = harness();
    h.port.emit({ type: "ready" });
    h.port.emit({ type: "error", code: Code.Unknown, message: "The node security check failed.", endpointTrustFailed: true });
    const failure = await h.reading.catch(error => error);
    expect(isEndpointTrustError(failure)).toBe(true);
    expect(failure.code).toBe(Code.Unknown);
    expect(h.port.close).toHaveBeenCalledOnce();
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
