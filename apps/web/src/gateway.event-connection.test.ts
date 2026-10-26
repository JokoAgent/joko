import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";
import { EventService, GetSnapshotResponseSchema, StreamEventsResponseSchema } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway, type GatewayConnectionState, type OrchestratorGateway } from "./gateway.js";

const profile = { id: "event-connection", deviceId: "event-device", serverId: "event-node", name: "Node", origin: "http://127.0.0.1:4318" };
const gateways: OrchestratorGateway[] = [];
afterEach(async () => {
  gateways.splice(0).forEach(gateway => gateway.disconnect());
  await Promise.resolve();
  vi.useRealTimers(); vi.unstubAllGlobals();
});
function timers() {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  vi.stubGlobal("SharedWorker", undefined);
}
function snapshotResponse() {
  return new Response(toBinary(GetSnapshotResponseSchema, create(GetSnapshotResponseSchema, {
    snapshot: { generation: 7n, resumeCursor: { generation: 7n, sequence: 0n, opaqueToken: "cursor-zero" } }
  })), { headers: { "content-type": "application/proto" } });
}
function acceptedStream(signal: AbortSignal) {
  let accept!: () => void;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () => controller.error(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      accept = () => controller.enqueue(new Uint8Array(5));
    }
  }), { headers: { "content-type": "application/connect+proto" } });
  return { response, accept };
}
function httpSource() {
  const calls: Array<{ signal: AbortSignal; respond(response: Response): void }> = [];
  let snapshots = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === "/joko.v1.EventService/GetSnapshot") { snapshots++; return snapshotResponse(); }
    if (path === "/joko.v1.ManagedModelRuntimeService/ListManagedModelRuntimes"
      || path === "/joko.v1.InputHandoffService/ListInputHandoffTasks") {
      return new Response(new Uint8Array(), { headers: { "content-type": "application/proto" } });
    }
    expect(path).toBe("/joko.v1.EventService/StreamEvents");
    return new Promise<Response>(resolve => { calls.push({ signal: init!.signal!, respond: resolve }); });
  }));
  return { calls, snapshots: () => snapshots };
}

describe("Event connection acceptance", () => {
  it("retains offline errors throughout HTTP failures and pending retries, then recovers on the idle stream's successful response", async () => {
    timers(); const source = httpSource();
    const states: GatewayConnectionState[] = [], live: boolean[] = [];
    let error: string | undefined;
    const gateway = createOrchestratorGateway(profile, "credential", {
      onState: state => { states.push(state); if (state === "connected") error = undefined; },
      onError: failure => { error = failure.message; },
      onLiveSnapshot: snapshot => live.push(snapshot !== undefined)
    });
    gateways.push(gateway);
    await gateway.connect(); await vi.advanceTimersByTimeAsync(0);
    expect(source.calls).toHaveLength(1);
    const initialConnections = states.filter(state => state === "connected").length;
    for (const [index, delay] of [350, 700, 1_400].entries()) {
      source.calls[index]!.respond(new Response("Unavailable", { status: 503,
        headers: { "content-type": "application/connect+proto", "x-response-attempt": String(index) } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(states.at(-1)).toBe("offline"); expect(error).toBe("HTTP 503");
      await vi.advanceTimersByTimeAsync(delay);
      expect(source.calls).toHaveLength(index + 2);
      expect(states.at(-1)).toBe("offline"); expect(error).toBe("HTTP 503"); expect(live.at(-1)).toBe(false);
      expect(states.filter(state => state === "connected")).toHaveLength(initialConnections);
    }
    expect(source.snapshots()).toBeGreaterThan(1);
    const reopened = acceptedStream(source.calls[3]!.signal);
    source.calls[3]!.respond(reopened.response);
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toBe("offline"); expect(error).toBe("HTTP 503");
    reopened.accept();
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toBe("connected"); expect(error).toBeUndefined(); expect(live.at(-1)).toBe(true);
    expect(states.filter(state => state === "connected")).toHaveLength(initialConnections + 1);
    gateway.disconnect(); await vi.advanceTimersByTimeAsync(0);
  });

  it.each([Code.Unauthenticated, Code.Unavailable])("does not restore connection for a real Connect handler's initial error envelope (%s)", async code => {
    timers();
    let responseHeaders = 0;
    const transport = createRouterTransport(router => router.service(EventService, {
      getSnapshot: () => ({ snapshot: { generation: 7n, resumeCursor: { generation: 7n, sequence: 0n } } }),
      streamEvents: async function* () { throw new ConnectError("Initial stream rejected", code); }
    }), { transport: { interceptors: [next => async request => {
      const response = await next(request);
      if (request.method.localName === "streamEvents") responseHeaders++;
      return response;
    }] } });
    const states: GatewayConnectionState[] = [], invalidated = vi.fn();
    const gateway = createOrchestratorGateway(profile, "credential", { onState: state => states.push(state),
      onAuthenticationInvalidated: invalidated }, () => transport);
    gateways.push(gateway);
    await gateway.connect(); await vi.advanceTimersByTimeAsync(0);
    expect(responseHeaders).toBe(1);
    expect(states.filter(state => state === "connected")).toHaveLength(1);
    expect(states.at(-1)).toBe(code === Code.Unauthenticated ? "disconnected" : "offline");
    expect(invalidated).toHaveBeenCalledTimes(code === Code.Unauthenticated ? 1 : 0);
    gateway.disconnect(); await vi.advanceTimersByTimeAsync(0);
  });

  it("does not treat HTTP 401 response metadata as acceptance or retry a rejected credential", async () => {
    timers(); const source = httpSource(), invalidated = vi.fn(), states: GatewayConnectionState[] = [];
    const gateway = createOrchestratorGateway(profile, "credential", { onState: state => states.push(state), onAuthenticationInvalidated: invalidated });
    gateways.push(gateway);
    await gateway.connect(); await vi.advanceTimersByTimeAsync(0);
    const initialConnections = states.filter(state => state === "connected").length;
    source.calls[0]!.respond(new Response("Rejected", { status: 401, headers: { "content-type": "application/connect+proto" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(invalidated).toHaveBeenCalledOnce(); expect(states.at(-1)).toBe("disconnected");
    expect(states.filter(state => state === "connected")).toHaveLength(initialConnections);
    await vi.advanceTimersByTimeAsync(20_000); expect(source.calls).toHaveLength(1);
  });

  it("ignores an accepted response from a retired connection even when the transport ignores cancellation", async () => {
    timers();
    type StreamResponse = Awaited<ReturnType<Transport["stream"]>>;
    const calls: Array<{ signal: AbortSignal; resolve(response: StreamResponse): void; reject(error: Error): void; method: StreamResponse["method"] }> = [];
    const transport = {
      unary: vi.fn(async (method: StreamResponse["method"]) => ({ stream: false, service: method.parent, method,
        header: new Headers(), trailer: new Headers(), message: create(GetSnapshotResponseSchema, {
          snapshot: { generation: 7n, resumeCursor: { generation: 7n, sequence: 0n } }
        }) })),
      stream: vi.fn((method: StreamResponse["method"], signal: AbortSignal) => new Promise<StreamResponse>((resolve, reject) => {
        calls.push({ method, signal, resolve, reject });
      }))
    } as unknown as Transport;
    const states: GatewayConnectionState[] = [];
    const gateway = createOrchestratorGateway(profile, "credential", { onState: state => states.push(state) }, () => transport);
    gateways.push(gateway);
    await gateway.connect(); await vi.advanceTimersByTimeAsync(0);
    await gateway.connect(); await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]!.signal.aborted).toBe(true);
    calls[1]!.reject(new ConnectError("Current connection offline", Code.Unavailable)); await vi.advanceTimersByTimeAsync(0);
    const established = states.filter(state => state === "connected").length;
    const old = calls[0]!;
    old.resolve({ stream: true, service: old.method.parent, method: old.method, header: new Headers(), trailer: new Headers(),
      message: (async function* () { yield create(StreamEventsResponseSchema, {}); })() });
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toBe("offline");
    expect(states.filter(state => state === "connected")).toHaveLength(established);
    gateway.disconnect(); await vi.advanceTimersByTimeAsync(0);
  });
});
