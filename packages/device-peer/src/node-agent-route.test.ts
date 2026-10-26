import { create } from "@bufbuild/protobuf";
import * as connect from "@connectrpc/connect";
import {
  DeviceKind,
  DevicePeerAgentRouteAcceptedSchema,
  DevicePeerCapabilityKind,
  DevicePeerCommandSchema,
  DevicePeerRetireReason,
  DevicePeerRetireRouteSchema,
  DevicePeerAgentHelloSchema,
  OpenDevicePeerAgentCommandRouteResponseSchema,
  type OpenDevicePeerAgentRouteRequest,
  OpenDevicePeerAgentRouteRequestSchema,
  OpenDevicePeerAgentRouteResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { EndpointTrustError, replaceEndpointTrust } from "@joko/connection-transport/node";
import type { EndpointTransport, EndpointTransportKind } from "@joko/connection-transport/trust";

import {
  createNodeDevicePeerAgentRoutePort,
  type NodeDevicePeerAgentRoutePort,
  runNodeDevicePeerAgentRoute
} from "./node-agent-route.js";

vi.mock("@connectrpc/connect", async () => {
  const actual = await vi.importActual<typeof import("@connectrpc/connect")>("@connectrpc/connect");
  return { ...actual, createClient: vi.fn(actual.createClient) };
});

const CAPABILITIES = Object.freeze([
  DevicePeerCapabilityKind.FILES,
  DevicePeerCapabilityKind.PROCESS,
  DevicePeerCapabilityKind.TERMINAL,
  DevicePeerCapabilityKind.FORWARDING,
  DevicePeerCapabilityKind.REMOTE_DESKTOP
]);

describe("Node Device peer agent route capabilities", () => {
  it.each(["handshake", "server-id"].flatMap(failure => [false, true].map(httpConnect => ({ failure, httpConnect }))))("retires the executor and preserves a terminal $failure trust failure before reading credentials (CONNECT=$httpConnect)", async ({ failure, httpConnect }) => {
    const error = new EndpointTrustError();
    const readAuthKey = vi.fn(async () => "A".repeat(43)), retire = vi.fn(async () => undefined);
    const verifyIdentity = vi.fn(async () => undefined);
    const endpoint = httpConnect ? { transportKind: "http-connect" as const,
      endpointTransport: { kind: "http-connect" as const, proxyOrigin: "http://proxy.example:1337", authority: "trust-failure.example:443" } } : undefined;
    const port: NodeDevicePeerAgentRoutePort = {
      readServerId: async (_origin, _signal, _pin, selected) => { expect(selected).toEqual(endpoint); if (failure === "handshake") throw error; return "unexpected-node"; },
      verifyIdentity,
      async *open() { throw new Error("A failed identity cannot open a business route."); }
    };
    await expect(runNodeDevicePeerAgentRoute({ connection: { credentialId: "profile-trust-failure", deviceId: "desktop-1",
      serverId: "expected-node", origin: "https://trust-failure.example", endpointPublicKey: `ed25519:${"c".repeat(64)}`,
      ...endpoint,
      expectedDeviceKind: DeviceKind.DESKTOP }, executor: { capabilities: CAPABILITIES, execute: vi.fn(), retire },
      signal: new AbortController().signal, readAuthKey, readRouteAuthorization: async () => "R".repeat(43),
      readDefaultDeviceName: () => "Desktop", isAuthorityCurrent: () => true, port })).rejects.toBeInstanceOf(EndpointTrustError);
    expect(retire).toHaveBeenCalledOnce();
    expect(readAuthKey).not.toHaveBeenCalled();
    expect(verifyIdentity).not.toHaveBeenCalled();
  });

  it.each<(undefined | { transportKind: EndpointTransportKind; endpointTransport: EndpointTransport })>([
    undefined,
    { transportKind: "webrtc", endpointTransport: { kind: "webrtc" } },
    { transportKind: "http-connect", endpointTransport: { kind: "http-connect", proxyOrigin: "http://proxy.example:1337", authority: "captured-route.example:443" } },
    { transportKind: "iroh", endpointTransport: { kind: "iroh", endpointId: "a".repeat(64), ticket: "a".repeat(24), clientKey: "b".repeat(64) } },
    { transportKind: "tailcat", endpointTransport: { kind: "tailcat", endpointId: `nodekey:${"a".repeat(64)}`, address: "tcprivateLocator", port: 443, clientKey: `privkey:${"b".repeat(64)}` } }
  ])("admits the complete current-v1 capability set over its exact selected private transport", async endpoint => {
    const endpointPublicKey = `ed25519:${"a".repeat(64)}`, origin = "https://captured-route.example";
    const retire = vi.fn(async () => undefined);
    const readAuthKey = vi.fn(async () => "A".repeat(43));
    const outbound: OpenDevicePeerAgentRouteRequest[] = [];
    const port: NodeDevicePeerAgentRoutePort = {
      async readServerId(actualOrigin, signal, pin, selected) {
        expect(actualOrigin).toBe(origin); expect(pin).toBe(endpointPublicKey);
        expect(selected).toEqual(endpoint);
        expect(readAuthKey).not.toHaveBeenCalled();
        replaceEndpointTrust({ origin, endpointPublicKey: `ed25519:${"b".repeat(64)}` });
        expect(signal.aborted).toBe(false);
        return "server-1";
      },
      async verifyIdentity(_origin, authKey, connection, signal, pin, selected) {
        expect(pin).toBe(endpointPublicKey);
        expect(selected).toEqual(endpoint);
        expect(authKey).toBe("A".repeat(43));
        expect(connection.deviceId).toBe("desktop-1");
        expect(signal.aborted).toBe(false);
      },
      async *open(_origin, routeAuthorization, requests, _signal, pin, _observe, selected) {
        expect(pin).toBe(endpointPublicKey);
        expect(selected).toEqual(endpoint);
        expect(routeAuthorization).toBe("R".repeat(43));
        const iterator = requests[Symbol.asyncIterator]();
        const hello = await requiredNext(iterator);
        outbound.push(hello);
        expect(hello.payload.case).toBe("hello");
        if (hello.payload.case !== "hello") throw new Error("Expected a route hello.");
        expect(hello.payload.value.capabilities).toEqual(CAPABILITIES);
        yield create(OpenDevicePeerAgentRouteResponseSchema, {
          targetDeviceId: "desktop-1",
          routeGeneration: 1n,
          requestId: hello.requestId,
          payload: {
            case: "accepted",
            value: create(DevicePeerAgentRouteAcceptedSchema, { capabilities: [...CAPABILITIES] })
          }
        });
        yield create(OpenDevicePeerAgentRouteResponseSchema, {
          targetDeviceId: "desktop-1",
          routeGeneration: 1n,
          requestId: hello.requestId,
          payload: {
            case: "retire",
            value: create(DevicePeerRetireRouteSchema, { reason: DevicePeerRetireReason.SERVICE_SHUTDOWN })
          }
        });
      }
    };

    await expect(runNodeDevicePeerAgentRoute({
      connection: {
        credentialId: "profile-1",
        deviceId: "desktop-1",
        serverId: "server-1",
        origin,
        endpointPublicKey,
        ...endpoint,
        expectedDeviceKind: DeviceKind.DESKTOP
      },
      executor: {
        capabilities: CAPABILITIES,
        execute: vi.fn(),
        retire
      },
      signal: new AbortController().signal,
      readAuthKey,
      readRouteAuthorization: async () => "R".repeat(43),
      readDefaultDeviceName: () => "Desktop",
      isAuthorityCurrent: () => true,
      port
    })).resolves.toBeUndefined();
    expect(outbound).toHaveLength(1);
    expect(retire).toHaveBeenCalledOnce();
  });

  it("finishes a cancelled route whose response waits for upload EOF and fences its late command", async () => {
    const controller = new AbortController();
    const execute = vi.fn(), order: string[] = [];
    const retirementStages: string[] = [];
    const retire = vi.fn(async () => { order.push("executor_retired"); });
    let markUploadPending!: () => void;
    const uploadPending = new Promise<void>((resolve) => { markUploadPending = resolve; });
    const port: NodeDevicePeerAgentRoutePort = {
      readServerId: async () => "server-1",
      verifyIdentity: async () => undefined,
      async *open(_origin, _authorization, requests, signal) {
        const input = requests[Symbol.asyncIterator]();
        const hello = await requiredNext(input);
        yield create(OpenDevicePeerAgentRouteResponseSchema, {
          targetDeviceId: "desktop-1", routeGeneration: 1n, requestId: hello.requestId,
          payload: { case: "accepted", value: create(DevicePeerAgentRouteAcceptedSchema, { capabilities: [...CAPABILITIES] }) }
        });
        const cancelled = new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        const upload = input.next();
        markUploadPending();
        await cancelled;
        // The transport keeps its response pending until its request-body
        // source ends. Cancellation must release that source independently.
        expect(await upload).toEqual({ done: true, value: undefined });
        order.push("upload_eof");
        yield create(OpenDevicePeerAgentRouteResponseSchema, {
          targetDeviceId: "desktop-1", routeGeneration: 1n, requestId: "late-command",
          payload: { case: "command", value: create(DevicePeerCommandSchema) }
        });
      }
    };
    const route = runNodeDevicePeerAgentRoute({
      connection: {
        credentialId: "profile-1", deviceId: "desktop-1", serverId: "server-1",
        origin: "https://cancelled-route.example", endpointPublicKey: `ed25519:${"a".repeat(64)}`,
        expectedDeviceKind: DeviceKind.DESKTOP
      },
      executor: { capabilities: CAPABILITIES, execute, retire },
      signal: controller.signal,
      readAuthKey: async () => "A".repeat(43),
      readRouteAuthorization: async () => "R".repeat(43),
      readDefaultDeviceName: () => "Desktop",
      isAuthorityCurrent: () => true,
      observeRetirement: (stage) => {
        retirementStages.push(stage);
        throw new Error("A diagnostic observer cannot prevent retirement.");
      },
      port
    });
    await uploadPending;
    controller.abort();
    await expect(route).resolves.toBeUndefined();
    expect(order).toEqual(["upload_eof", "executor_retired"]);
    expect(execute).not.toHaveBeenCalled();
    expect(retire).toHaveBeenCalledOnce();
    expect(retirementStages).toEqual([
      "cancel_received", "task_drain_started", "task_drain_completed",
      "executor_retirement_started", "executor_retirement_completed"
    ]);
  });
});

describe("Node Device peer split route upload ownership", () => {
  it.each(["return", "abort"] as const)("retires an upload without an unhandled rejection after the first accepted yield and %s", async ending => {
    const fixture = splitRouteUploadFixture();
    const unhandled: unknown[] = [];
    const observeUnhandled = (error: unknown): void => { unhandled.push(error); };
    process.on("unhandledRejection", observeUnhandled);
    try {
      expect((await fixture.iterator.next()).value?.payload.case).toBe("accepted");
      if (ending === "abort") {
        fixture.controller.abort();
        await nextEventLoopTurn();
        expect(unhandled).toEqual([]);
      }
      await fixture.iterator.return?.();
      await nextEventLoopTurn();
      expect(unhandled).toEqual([]);
      expect(fixture.stages).toEqual([
        "split_downstream_retirement_started", "split_downstream_retirement_completed",
        "split_upload_retirement_started", "split_upload_retirement_completed"
      ]);
    } finally {
      await fixture.iterator.return?.();
      process.removeListener("unhandledRejection", observeUnhandled);
      fixture.restoreClient();
    }
  });

  it("preserves an upload failure for the original route after pausing at its first accepted yield", async () => {
    const fixture = splitRouteUploadFixture();
    const failure = new Error("Controlled upload failure.");
    const unhandled: unknown[] = [];
    const observeUnhandled = (error: unknown): void => { unhandled.push(error); };
    process.on("unhandledRejection", observeUnhandled);
    try {
      expect((await fixture.iterator.next()).value?.payload.case).toBe("accepted");
      fixture.rejectUpload(failure);
      await nextEventLoopTurn();
      expect(unhandled).toEqual([]);
      await expect(fixture.iterator.next()).rejects.toBe(failure);
      expect(fixture.stages.at(-1)).toBe("split_upload_retirement_completed");
    } finally {
      await fixture.iterator.return?.();
      process.removeListener("unhandledRejection", observeUnhandled);
      fixture.restoreClient();
    }
  });
});

function splitRouteUploadFixture() {
  let rejectUpload!: (error: unknown) => void;
  const upload = new Promise<void>((_resolve, reject) => { rejectUpload = reject; });
  const client = {
    async *openDevicePeerAgentCommandRoute(_request: unknown, { signal }: { signal: AbortSignal }) {
      yield create(OpenDevicePeerAgentCommandRouteResponseSchema, {
        targetDeviceId: "desktop-1", routeGeneration: 1n, requestId: "split-request",
        payload: { case: "accepted", value: create(DevicePeerAgentRouteAcceptedSchema) }
      });
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    publishDevicePeerAgentRoute(_request: unknown, { signal }: { signal: AbortSignal }) {
      signal.addEventListener("abort", () => rejectUpload(new Error("Controlled upload cancellation.")), { once: true });
      return upload;
    }
  };
  const clientMock = vi.mocked(connect.createClient);
  const previousCreateClient = clientMock.getMockImplementation();
  if (previousCreateClient === undefined) throw new Error("The route fixture requires the original client implementation.");
  clientMock.mockReturnValue(client as unknown as ReturnType<typeof connect.createClient>);
  const requests = (async function* () {
    yield create(OpenDevicePeerAgentRouteRequestSchema, {
      targetDeviceId: "desktop-1", routeGeneration: 0n, requestId: "split-request",
      payload: { case: "hello", value: create(DevicePeerAgentHelloSchema) }
    });
  })();
  const controller = new AbortController(), stages: string[] = [];
  const iterator = createNodeDevicePeerAgentRoutePort().open("https://split-route.example", "R".repeat(43),
    requests, controller.signal, `ed25519:${"a".repeat(64)}`, stage => stages.push(stage))[Symbol.asyncIterator]();
  return { controller, iterator, rejectUpload, stages, restoreClient: () => clientMock.mockImplementation(previousCreateClient) };
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>(resolve => { setImmediate(resolve); });
}

async function requiredNext<T>(iterator: AsyncIterator<T>): Promise<T> {
  const next = await iterator.next();
  if (next.done) throw new Error("Expected another route frame.");
  return next.value;
}
