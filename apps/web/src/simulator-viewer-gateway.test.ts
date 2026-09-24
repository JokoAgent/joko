import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { CapabilitySupport, ControlSimulatorInstanceResponseSchema,
  GetSimulatorViewerStateResponseSchema, SimulatorViewerAction,
  SimulatorViewerInstanceSchema, SimulatorViewerStreamState,
  WatchSimulatorFramesResponseSchema } from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { createSimulatorViewerGateway } from "./simulator-viewer-gateway.js";

it("maps the generated Viewer route and preserves one-shot control with the exact owner signal", async () => {
  const instance = create(SimulatorViewerInstanceSchema, {
    route: { instanceId: "owned", generation: 4n, leaseId: "lease" },
    simulatorUdid: "A0123456-1234-1234-1234-123456789ABC", simulatorName: "Joko iPhone",
    runtimeIdentifier: "iOS-19", deviceTypeIdentifier: "iPhone-17",
    creationProvenance: "joko", lifecycleState: "stopped", viewerState: "attached",
    healthState: "healthy"
  });
  let failControl = false;
  const requests: Array<{ name: string; input: any; signal: AbortSignal }> = [];
  const transport = { unary: vi.fn(async (method: any, signal: AbortSignal,
    _timeout: unknown, _headers: unknown, input: any) => {
    requests.push({ name: method.localName, input, signal });
    if (method.localName === "controlSimulatorInstance" && failControl) throw new Error("Outcome unknown");
    const message = method.localName === "getSimulatorViewerState"
      ? create(GetSimulatorViewerStateResponseSchema, {
        support: CapabilitySupport.SUPPORTED, devices: [], instances: [instance]
      })
      : create(ControlSimulatorInstanceResponseSchema, { instance, deleted: true });
    return { service: method.parent, method, stream: false,
      header: new Headers(), trailer: new Headers(), message };
  }) } as unknown as Transport;
  const owner = new AbortController();
  const gateway = createSimulatorViewerGateway(transport, owner.signal);
  const state = await gateway.getSimulatorViewerState("task");
  expect(state.instances[0]).toMatchObject({ creationProvenance: "joko",
    route: { instanceId: "owned", generation: 4n, leaseId: "lease" } });
  const route = state.instances[0]!.route;
  const deleted = await gateway.controlSimulatorInstance("task", "request", { action: "delete", route });
  expect(deleted).toMatchObject({ deleted: true, instance: { route } });
  expect(requests.at(-1)).toMatchObject({ name: "controlSimulatorInstance",
    input: { sessionId: "task", requestId: "request", action: SimulatorViewerAction.DELETE, route } });
  failControl = true;
  await expect(gateway.controlSimulatorInstance("task", "uncertain", { action: "stop", route }))
    .rejects.toThrow("Outcome unknown");
  expect(requests.filter(item => item.input.requestId === "uncertain")).toHaveLength(1);
  owner.abort();
  expect(requests.every(item => item.signal.aborted)).toBe(true);
});

it("validates generated frame stream route, sequence and JPEG bytes before presentation", async () => {
  const route = { instanceId: "owned", generation: 4n, leaseId: "lease" };
  const responses = [
    create(WatchSimulatorFramesResponseSchema,
      { route, state: SimulatorViewerStreamState.CONNECTING }),
    create(WatchSimulatorFramesResponseSchema,
      { route, state: SimulatorViewerStreamState.FRAME, sequence: 1n,
        receivedAtMs: 1_000n, jpeg: new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]) }),
    create(WatchSimulatorFramesResponseSchema,
      { route: { ...route, generation: 5n }, state: SimulatorViewerStreamState.FRAME,
        sequence: 2n, receivedAtMs: 2_000n, jpeg: new Uint8Array([0xff, 0xd8, 2, 0xff, 0xd9]) })
  ];
  const stream = vi.fn(async (method: any, signal: AbortSignal, _timeout: unknown,
    _headers: unknown, input: any) => ({ service: method.parent, method, stream: true,
      header: new Headers(), trailer: new Headers(), message: (async function* () {
        for (const response of responses) yield response;
      })(), signal, input }));
  const gateway = createSimulatorViewerGateway({ stream } as unknown as Transport);
  const iterator = gateway.watchSimulatorFrames("task", route)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual({ kind: "connecting", attempt: 0 });
  expect((await iterator.next()).value).toMatchObject({ kind: "frame", sequence: 1n });
  await expect(iterator.next()).rejects.toThrow("another instance route");
  expect(stream).toHaveBeenCalledOnce();
});
