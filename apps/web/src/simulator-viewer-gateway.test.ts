import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { CapabilitySupport, ControlSimulatorInstanceResponseSchema,
  ControlSimulatorViewerCommandResponseSchema,
  ControlSimulatorViewerInputResponseSchema,
  ControlSimulatorViewerTouchResponseSchema,
  GetSimulatorViewerControlsResponseSchema,
  GetSimulatorViewerStateResponseSchema, SimulatorViewerAction,
  SetSimulatorViewerInteractionProfileResponseSchema,
  SimulatorViewerCommand, SimulatorViewerInstanceSchema, SimulatorViewerNativeRouteState,
  SimulatorViewerStreamState, SimulatorViewerTouchPhase,
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
      : method.localName === "controlSimulatorViewerInput"
        ? create(ControlSimulatorViewerInputResponseSchema, { replayed: false })
        : method.localName === "controlSimulatorViewerTouch"
          ? create(ControlSimulatorViewerTouchResponseSchema, { accepted: true })
          : method.localName === "setSimulatorViewerInteractionProfile"
            ? create(SetSimulatorViewerInteractionProfileResponseSchema, { applied: true })
          : method.localName === "getSimulatorViewerControls"
            ? create(GetSimulatorViewerControlsResponseSchema, { viewportWidth: 393,
              viewportHeight: 852, orientation: "PORTRAIT", nativeTouchAvailable: true })
            : method.localName === "controlSimulatorViewerCommand"
              ? create(ControlSimulatorViewerCommandResponseSchema, { replayed: false,
                screenshotBlobId: input.command === SimulatorViewerCommand.COPY_SCREENSHOT
                  ? "captured-blob" : "" })
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
  await gateway.controlSimulatorViewerInput("task", "input-request", route,
    { action: "swipe", startXRatio: 0.1, startYRatio: 0.2,
      endXRatio: 0.8, endYRatio: 0.9, durationMs: 450 });
  expect(requests.at(-1)).toMatchObject({ name: "controlSimulatorViewerInput",
    input: { sessionId: "task", requestId: "input-request", route,
      input: { case: "swipe", value: { start: { xRatio: 0.1, yRatio: 0.2 },
        end: { xRatio: 0.8, yRatio: 0.9 }, durationMs: 450 } } } });
  expect(await gateway.controlSimulatorViewerTouch("task", route, {
    gestureId: "A0123456-1234-1234-1234-123456789ABC", sequence: 1,
    phase: "move", xRatio: 0.4, yRatio: 0.6 })).toEqual({ accepted: true });
  expect(requests.at(-1)).toMatchObject({ name: "controlSimulatorViewerTouch",
    input: { sessionId: "task", route,
      gestureId: "A0123456-1234-1234-1234-123456789ABC", sequence: 1,
      phase: SimulatorViewerTouchPhase.MOVE,
      point: { xRatio: 0.4, yRatio: 0.6 } } });
  expect(await gateway.setSimulatorViewerInteractionProfile("task", route,
    "A0123456-1234-4234-8234-123456789ABC", true)).toEqual({ applied: true });
  expect(requests.at(-1)).toMatchObject({ name: "setSimulatorViewerInteractionProfile",
    input: { sessionId: "task", route,
      subscriptionId: "A0123456-1234-4234-8234-123456789ABC", active: true } });
  expect(await gateway.getSimulatorViewerControls("task", route)).toEqual({
    viewportWidth: 393, viewportHeight: 852, orientation: "PORTRAIT", nativeTouchAvailable: true
  });
  expect(await gateway.controlSimulatorViewerCommand("task", "rotate-request", route,
    { action: "rotate", orientation: "LANDSCAPE" })).toEqual({ replayed: false });
  expect(requests.at(-1)).toMatchObject({ name: "controlSimulatorViewerCommand",
    input: { sessionId: "task", requestId: "rotate-request", route,
      command: SimulatorViewerCommand.ROTATE, orientation: "LANDSCAPE" } });
  expect(await gateway.controlSimulatorViewerCommand("task", "capture-request", route,
    { action: "copyScreenshot" })).toEqual({ replayed: false, screenshotBlobId: "captured-blob" });
  failControl = true;
  await expect(gateway.controlSimulatorInstance("task", "uncertain", { action: "stop", route }))
    .rejects.toThrow("Outcome unknown");
  expect(requests.filter(item => item.input.requestId === "uncertain")).toHaveLength(1);
  owner.abort();
  expect(requests.every(item => item.signal.aborted)).toBe(true);
});

it("validates generated frame stream route, sequence and encoded bytes before presentation", async () => {
  const route = { instanceId: "owned", generation: 4n, leaseId: "lease" };
  const responses = [
    create(WatchSimulatorFramesResponseSchema,
      { route, state: SimulatorViewerStreamState.CONNECTING,
        nativeRouteState: SimulatorViewerNativeRouteState.ACTIVE }),
    create(WatchSimulatorFramesResponseSchema,
      { route, state: SimulatorViewerStreamState.FRAME, sequence: 1n,
        receivedAtMs: 1_000n, jpeg: new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]),
        nativeRouteState: SimulatorViewerNativeRouteState.FALLBACK_UNAVAILABLE }),
    create(WatchSimulatorFramesResponseSchema,
      { route, state: SimulatorViewerStreamState.FRAME, sequence: 2n,
        receivedAtMs: 1_500n, h264: new Uint8Array([0, 0, 0, 1, 0x65, 0x88]),
        width: 16, height: 12, timestampMicros: 3_000n,
        keyFrame: true, h264Format: "annex-b",
        nativeRouteState: SimulatorViewerNativeRouteState.ACTIVE }),
    create(WatchSimulatorFramesResponseSchema,
      { route: { ...route, generation: 5n }, state: SimulatorViewerStreamState.FRAME,
        sequence: 3n, receivedAtMs: 2_000n, jpeg: new Uint8Array([0xff, 0xd8, 2, 0xff, 0xd9]),
        nativeRouteState: SimulatorViewerNativeRouteState.ACTIVE })
  ];
  const stream = vi.fn(async (method: any, signal: AbortSignal, _timeout: unknown,
    _headers: unknown, input: any) => ({ service: method.parent, method, stream: true,
      header: new Headers(), trailer: new Headers(), message: (async function* () {
        for (const response of responses) yield response;
      })(), signal, input }));
  const gateway = createSimulatorViewerGateway({ stream } as unknown as Transport);
  const iterator = gateway.watchSimulatorFrames("task", route, undefined,
    { subscriptionId: "11111111-1111-4111-8111-111111111111",
      preferNativeH264: true, framesPerSecond: 20, scalingPercent: 70,
      orientation: "PORTRAIT", mjpegFramesPerSecond: 10, jpegQuality: 45,
      mjpegScalingPercent: 70 })[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual({ kind: "connecting", attempt: 0,
    nativeRoute: "active" });
  expect((await iterator.next()).value).toMatchObject({ kind: "frame", sequence: 1n });
  expect((await iterator.next()).value).toMatchObject({ kind: "h264", sequence: 2n,
    width: 16, height: 12, keyFrame: true });
  await expect(iterator.next()).rejects.toThrow("another instance route");
  expect(stream).toHaveBeenCalledOnce();
  const sent = await stream.mock.calls[0]?.[4][Symbol.asyncIterator]().next();
  expect(sent?.value).toMatchObject({ preferNativeH264: true,
    subscriptionId: "11111111-1111-4111-8111-111111111111",
    framesPerSecond: 20, scalingPercent: 70, orientation: "PORTRAIT",
    mjpegFramesPerSecond: 10, jpegQuality: 45, mjpegScalingPercent: 70 });
});

it("passes a decoder failure only on a fallback subscription and reports its exact route state", async () => {
  const route = { instanceId: "owned", generation: 4n, leaseId: "lease" };
  const stream = vi.fn(async (method: any, signal: AbortSignal, _timeout: unknown,
    _headers: unknown, input: any) => ({ service: method.parent, method, stream: true,
      header: new Headers(), trailer: new Headers(), message: (async function* () {
        yield create(WatchSimulatorFramesResponseSchema, { route,
          state: SimulatorViewerStreamState.FRAME, sequence: 1n, receivedAtMs: 1_000n,
          jpeg: new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]),
          nativeRouteState: SimulatorViewerNativeRouteState.FALLBACK_DECODE });
      })(), signal, input }));
  const gateway = createSimulatorViewerGateway({ stream } as unknown as Transport);
  const profile = { subscriptionId: "22222222-2222-4222-8222-222222222222",
    preferNativeH264: false, framesPerSecond: 20, scalingPercent: 70,
    orientation: "PORTRAIT" as const, mjpegFramesPerSecond: 10, jpegQuality: 45,
    mjpegScalingPercent: 70, clientFallbackReason: "decode_failed" as const };
  const events = gateway.watchSimulatorFrames("task", route, undefined, profile);
  expect((await events[Symbol.asyncIterator]().next()).value).toMatchObject({ kind: "frame",
    nativeRoute: "fallbackDecode" });
  const sent = await stream.mock.calls[0]?.[4][Symbol.asyncIterator]().next();
  expect(sent?.value).toMatchObject({ clientFallbackReason: "decode_failed",
    preferNativeH264: false, route,
    subscriptionId: "22222222-2222-4222-8222-222222222222" });
});
