import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { CapabilitySupport, ControlSimulatorInstanceResponseSchema,
  GetSimulatorViewerStateResponseSchema, SimulatorViewerAction,
  SimulatorViewerInstanceSchema } from "@joko/contracts";
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
