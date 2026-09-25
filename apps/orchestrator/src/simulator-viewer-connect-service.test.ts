import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { expect, it, vi } from "vitest";
import { SimulatorOwnershipRegistry } from "./ios-simulator-ownership.js";
import { SimulatorInputError } from "./ios-simulator-input-coordinator.js";
import type { SimulatorViewerFrameCoordinator } from "./ios-simulator-viewer-frames.js";
import { createSimulatorViewerConnectService } from "./simulator-viewer-connect-service.js";
import { SimulatorMutationArbiter } from "./ios-simulator-mutation-arbiter.js";

const SCOPE = { sessionId: "simulator-task", targetId: "local", generation: 1 } as const;
const DEVICE = { udid: "A0123456-1234-1234-1234-123456789ABC", name: "Joko iPhone",
  state: "Shutdown", isAvailable: true,
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0",
  runtimeName: "iOS 19.0", runtimeVersion: "19.0",
  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", lastBootedAt: null } as const;

function fixture(frames?: Pick<SimulatorViewerFrameCoordinator, "watch"> &
  Partial<Pick<SimulatorViewerFrameCoordinator, "inputView" | "setInteractionProfile">>, viewerInput?: {
    readonly execute: ReturnType<typeof vi.fn>;
    readonly screenMap: ReturnType<typeof vi.fn>;
    readonly liveTouch?: { readonly begin: ReturnType<typeof vi.fn>;
      readonly advance: ReturnType<typeof vi.fn>; readonly clearInstance: ReturnType<typeof vi.fn> };
  }, commands?: {
    readonly driver?: { readonly isReady: ReturnType<typeof vi.fn>;
      readonly probeNativeLiveInput: ReturnType<typeof vi.fn> };
    readonly stateControl?: { readonly execute: ReturnType<typeof vi.fn> };
    readonly screenshot?: { readonly execute: ReturnType<typeof vi.fn> };
  }) {
  const store = new OperationalStore(":memory:");
  store.upsertBackend({ id: "pi", displayName: "Pi", version: "fixture", health: "healthy",
    adapterKind: "fixture", instanceGeneration: 0, installationState: "installed",
    authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "local", backendId: "pi", displayName: "Local workspace",
    workspaceRoot: "D:/workspace", managed: false, trusted: true });
  store.createSession({ id: SCOPE.sessionId, backendId: "pi", targetId: SCOPE.targetId,
    title: "Simulator task", binding: { opaqueRef: "simulator-task", generation: 1 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false,
    createdAt: 1, updatedAt: 1 });
  const ownership = new SimulatorOwnershipRegistry(store);
  const bound = ownership.bindCreatedDevice(SCOPE, DEVICE, DEVICE.name);
  const instance = ownership.attachViewer(SCOPE,
    { instanceId: bound.instanceId, generation: bound.generation, leaseId: bound.lease.id });
  let removedInstance: typeof instance | undefined;
  const remove = vi.fn(async (_scope, route, authority) => {
    expect(authority.effectIdentity).toMatch(/^[0-9a-f]{64}$/u);
    expect(authority.requestBodyHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    if (removedInstance) return { instance: removedInstance, replayed: true };
    removedInstance = ownership.releaseDeletedCreated(SCOPE, route);
    return { instance: removedInstance, replayed: false };
  });
  const clear = vi.fn(async () => undefined);
  const mutations = new SimulatorMutationArbiter(ownership);
  let authorized = true;
  const context = { signal: new AbortController().signal } as HandlerContext;
  const service = createSimulatorViewerConnectService({ store,
    owner: { ownership, mutations, control: { delete: remove } as never,
      environment: { inspect: async () => ({ platform: "darwin", ready: true,
        devices: [DEVICE], issue: null }) } as never,
      clearInstance: clear, frames: frames as never,
      input: viewerInput === undefined ? undefined : { execute: viewerInput.execute } as never,
      liveTouch: viewerInput?.liveTouch as never,
      screen: viewerInput === undefined ? undefined : { screenMap: viewerInput.screenMap } as never,
      driver: commands?.driver as never, stateControl: commands?.stateControl as never,
      screenshot: commands?.screenshot as never },
    authenticate: () => { if (!authorized) throw new ConnectError("Revoked", Code.Unauthenticated); }
  });
  return { store, ownership, mutations, instance, remove, clear, service, context,
    revoke: () => { authorized = false; }, authorize: () => { authorized = true; } };
}

it("routes visible Viewer commands through exact durable owners without binding refreshed snapshots", async () => {
  const snapshotId = randomUUID();
  const screenMap = vi.fn(async () => ({ screenMap: { snapshotId },
    viewport: { width: 393, height: 852, orientation: "PORTRAIT" } }));
  const inputView = vi.fn(() => ({ state: "streaming" as const, encoding: "jpeg" as const,
    viewerOrientation: null, lastFrameAt: new Date().toISOString() }));
  const inputExecute = vi.fn(async () => ({ replayed: false }));
  const stateExecute = vi.fn(async () => ({ replayed: false }));
  const screenshotExecute = vi.fn(async () => ({ replayed: false,
    receipt: { image: { id: "screenshot-blob" } } }));
  const driver = { isReady: vi.fn(() => true), probeNativeLiveInput: vi.fn(async () => true) };
  const h = fixture({ watch: async function* () { /* not consumed */ }, inputView },
    { execute: inputExecute, screenMap }, { driver, stateControl: { execute: stateExecute },
      screenshot: { execute: screenshotExecute } });
  const route = { instanceId: h.instance.instanceId, generation: BigInt(h.instance.generation),
    leaseId: h.instance.lease.id };
  const request = { sessionId: SCOPE.sessionId, route, requestId: randomUUID() };
  try {
    expect(await h.service.getSimulatorViewerControls(create(
      contract.GetSimulatorViewerControlsRequestSchema, { sessionId: SCOPE.sessionId, route }), h.context))
      .toMatchObject({ viewportWidth: 393, viewportHeight: 852,
        orientation: "PORTRAIT", nativeTouchAvailable: true });
    const home = await h.service.controlSimulatorViewerCommand(create(
      contract.ControlSimulatorViewerCommandRequestSchema, {
        ...request, command: contract.SimulatorViewerCommand.HOME
      }), h.context);
    expect(home).toMatchObject({ replayed: false, screenshotBlobId: "" });
    expect(inputExecute).toHaveBeenCalledWith(SCOPE, expect.objectContaining({
      instanceId: route.instanceId }), { type: "press_home", snapshotId },
    { mode: "none", timeoutMs: 5_000, stableForMs: 300 },
    expect.objectContaining({ requestBodyHash: expect.stringMatching(/^sha256:/u) }),
    expect.any(AbortSignal), { bindSnapshotToOperation: false });
    await h.service.controlSimulatorViewerCommand(create(
      contract.ControlSimulatorViewerCommandRequestSchema, { ...request,
        requestId: randomUUID(), command: contract.SimulatorViewerCommand.ROTATE,
        orientation: "LANDSCAPE" }), h.context);
    expect(stateExecute).toHaveBeenCalledWith(SCOPE, expect.anything(),
      { type: "set_orientation", snapshotId, orientation: "LANDSCAPE" },
      expect.anything(), expect.any(AbortSignal), { bindSnapshotToOperation: false });
    for (const [command, type] of [
      [contract.SimulatorViewerCommand.LOCK, "lock_screen"],
      [contract.SimulatorViewerCommand.UNLOCK, "unlock_screen"]
    ] as const) {
      await h.service.controlSimulatorViewerCommand(create(
        contract.ControlSimulatorViewerCommandRequestSchema, { ...request,
          requestId: randomUUID(), command }), h.context);
      expect(stateExecute).toHaveBeenLastCalledWith(SCOPE, expect.anything(),
        { type, snapshotId }, expect.anything(), expect.any(AbortSignal),
        { bindSnapshotToOperation: false });
    }
    expect(await h.service.controlSimulatorViewerCommand(create(
      contract.ControlSimulatorViewerCommandRequestSchema, { ...request,
        requestId: randomUUID(), command: contract.SimulatorViewerCommand.COPY_SCREENSHOT }), h.context))
      .toMatchObject({ screenshotBlobId: "screenshot-blob" });
    expect(screenshotExecute).toHaveBeenCalledWith(SCOPE, expect.anything(),
      expect.anything(), expect.any(AbortSignal));
    await expect(h.service.controlSimulatorViewerCommand(create(
      contract.ControlSimulatorViewerCommandRequestSchema, { ...request,
        route: { ...route, leaseId: "wrong" }, command: contract.SimulatorViewerCommand.COPY_SCREENSHOT }),
    h.context)).rejects.toBeDefined();
    await expect(h.service.controlSimulatorViewerCommand(create(
      contract.ControlSimulatorViewerCommandRequestSchema, { ...request,
        command: contract.SimulatorViewerCommand.ROTATE, orientation: "SIDEWAYS" }),
    h.context)).rejects.toMatchObject({ code: Code.InvalidArgument });
  } finally { h.store.close(); }
});

it("streams task-bound frame messages and fences authentication between yields", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]);
  const watch = vi.fn(async function* () {
    yield { kind: "connecting", attempt: 0, nativeRoute: "fallback_unavailable" } as const;
    yield { kind: "frame", sequence: 1, receivedAt: new Date(1_000).toISOString(),
      bytes: jpeg, nativeRoute: "fallback_unavailable" } as const;
  });
  const h = fixture({ watch });
  try {
    const request = create(contract.WatchSimulatorFramesRequestSchema, {
      sessionId: SCOPE.sessionId, route: { instanceId: h.instance.instanceId,
        generation: BigInt(h.instance.generation), leaseId: h.instance.lease.id },
      mjpegFramesPerSecond: 10, jpegQuality: 45, mjpegScalingPercent: 70,
      subscriptionId: randomUUID()
    });
    const stream = h.service.watchSimulatorFrames(request, h.context)[Symbol.asyncIterator]();
    expect((await stream.next()).value).toMatchObject({
      state: contract.SimulatorViewerStreamState.CONNECTING,
      nativeRouteState: contract.SimulatorViewerNativeRouteState.FALLBACK_UNAVAILABLE,
      route: { instanceId: h.instance.instanceId }
    });
    h.revoke();
    await expect(stream.next()).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(watch).toHaveBeenCalledOnce();
    h.authorize();
    const second = h.service.watchSimulatorFrames(request, h.context)[Symbol.asyncIterator]();
    await second.next();
    expect((await second.next()).value).toMatchObject({
      state: contract.SimulatorViewerStreamState.FRAME, sequence: 1n,
      receivedAtMs: 1_000n, jpeg,
      nativeRouteState: contract.SimulatorViewerNativeRouteState.FALLBACK_UNAVAILABLE
    });
    await second.return?.();
  } finally { h.store.close(); }
});

it("targets interaction profiles to an authenticated exact frame subscription", async () => {
  const setInteractionProfile = vi.fn(async () => true);
  const h = fixture({ watch: async function* () { /* not consumed */ }, setInteractionProfile });
  const subscriptionId = randomUUID();
  const route = { instanceId: h.instance.instanceId,
    generation: BigInt(h.instance.generation), leaseId: h.instance.lease.id };
  try {
    const request = create(contract.SetSimulatorViewerInteractionProfileRequestSchema, {
      sessionId: SCOPE.sessionId, route, subscriptionId, active: true
    });
    await expect(h.service.setSimulatorViewerInteractionProfile(request, h.context))
      .resolves.toMatchObject({ applied: true });
    expect(setInteractionProfile).toHaveBeenCalledWith(SCOPE, {
      instanceId: route.instanceId, generation: Number(route.generation), leaseId: route.leaseId
    }, subscriptionId, true);
    await expect(h.service.setSimulatorViewerInteractionProfile(create(
      contract.SetSimulatorViewerInteractionProfileRequestSchema,
      { ...request, subscriptionId: "stale" }), h.context))
      .rejects.toMatchObject({ code: Code.InvalidArgument });
    h.revoke();
    await expect(h.service.setSimulatorViewerInteractionProfile(request, h.context))
      .rejects.toMatchObject({ code: Code.Unauthenticated });
  } finally { h.store.close(); }
});

it("admits exact live touch from a fresh frame and distinguishes undispatched begin from unknown", async () => {
  const begin = vi.fn(async () => undefined);
  const advance = vi.fn(async () => undefined);
  const clearInstance = vi.fn();
  const liveTouch = { begin, advance, clearInstance };
  const snapshotId = randomUUID();
  const screenMap = vi.fn(async () => ({ screenMap: { snapshotId },
    viewport: { width: 100, height: 200, orientation: "PORTRAIT" } }));
  const inputView = vi.fn(() => ({ state: "streaming" as const, encoding: "h264" as const,
    viewerOrientation: "LANDSCAPE" as const, lastFrameAt: new Date().toISOString() }));
  const h = fixture({ watch: async function* () { /* not consumed */ }, inputView },
    { execute: vi.fn(), screenMap, liveTouch });
  const gestureId = randomUUID();
  const route = { instanceId: h.instance.instanceId,
    generation: BigInt(h.instance.generation), leaseId: h.instance.lease.id };
  const request = create(contract.ControlSimulatorViewerTouchRequestSchema, {
    sessionId: SCOPE.sessionId, gestureId, route, sequence: 0,
    phase: contract.SimulatorViewerTouchPhase.BEGIN,
    point: { xRatio: 0.3, yRatio: 0.2 }
  });
  try {
    expect(await h.service.controlSimulatorViewerTouch(request, h.context))
      .toMatchObject({ accepted: true });
    expect(begin).toHaveBeenCalledWith(SCOPE, expect.objectContaining({
      instanceId: route.instanceId }), gestureId, { xRatio: 0.3, yRatio: 0.2 },
    snapshotId, { width: 100, height: 200, orientation: "PORTRAIT" },
    "LANDSCAPE", expect.any(AbortSignal));
    expect(await h.service.controlSimulatorViewerTouch(create(
      contract.ControlSimulatorViewerTouchRequestSchema, { ...request, sequence: 1,
        phase: contract.SimulatorViewerTouchPhase.MOVE }), h.context))
      .toMatchObject({ accepted: true });
    expect(advance).toHaveBeenCalledWith(SCOPE, expect.anything(), gestureId,
      "move", 1, { xRatio: 0.3, yRatio: 0.2 }, expect.any(AbortSignal));
    begin.mockRejectedValueOnce(new SimulatorInputError("NATIVE_INPUT_UNAVAILABLE", "Not dispatched."));
    expect(await h.service.controlSimulatorViewerTouch(create(
      contract.ControlSimulatorViewerTouchRequestSchema, { ...request, gestureId: randomUUID() }),
    h.context)).toMatchObject({ accepted: false });
    begin.mockRejectedValueOnce(new SimulatorInputError("INPUT_OUTCOME_UNKNOWN", "Already sent."));
    await expect(h.service.controlSimulatorViewerTouch(create(
      contract.ControlSimulatorViewerTouchRequestSchema, { ...request, gestureId: randomUUID() }),
    h.context)).rejects.toMatchObject({ code: "INPUT_OUTCOME_UNKNOWN" });
    await expect(h.service.controlSimulatorViewerTouch(create(
      contract.ControlSimulatorViewerTouchRequestSchema, { ...request, sequence: 2 }),
    h.context)).rejects.toMatchObject({ code: Code.InvalidArgument });
    begin.mockImplementationOnce(async () => { h.revoke(); });
    await expect(h.service.controlSimulatorViewerTouch(create(
      contract.ControlSimulatorViewerTouchRequestSchema, { ...request, gestureId: randomUUID() }),
    h.context)).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(clearInstance).toHaveBeenCalledWith(route.instanceId);
    h.revoke();
    await expect(h.service.controlSimulatorViewerTouch(request, h.context))
      .rejects.toMatchObject({ code: Code.Unauthenticated });
  } finally { h.store.close(); }
});

it("passes a bounded native profile and projects H.264 metadata without durable media", async () => {
  const bytes = new Uint8Array([0, 0, 0, 1, 0x65, 0x88]);
  const watch = vi.fn(async function* () {
    yield { kind: "h264", sequence: 1, receivedAt: new Date(2_000).toISOString(),
      bytes, width: 16, height: 12, timestampMicros: 3_000,
      keyFrame: true, format: "annex-b", nativeRoute: "active" } as const;
  });
  const h = fixture({ watch });
  try {
    const request = create(contract.WatchSimulatorFramesRequestSchema, {
      sessionId: SCOPE.sessionId, route: { instanceId: h.instance.instanceId,
        generation: BigInt(h.instance.generation), leaseId: h.instance.lease.id },
      preferNativeH264: true, framesPerSecond: 20, scalingPercent: 70,
      orientation: "PORTRAIT", mjpegFramesPerSecond: 10, jpegQuality: 45,
      mjpegScalingPercent: 70, subscriptionId: randomUUID()
    });
    const stream = h.service.watchSimulatorFrames(request, h.context)[Symbol.asyncIterator]();
    expect((await stream.next()).value).toMatchObject({ state: contract.SimulatorViewerStreamState.FRAME,
      sequence: 1n, receivedAtMs: 2_000n, h264: bytes, jpeg: new Uint8Array(),
      width: 16, height: 12, timestampMicros: 3_000n,
      keyFrame: true, h264Format: "annex-b",
      nativeRouteState: contract.SimulatorViewerNativeRouteState.ACTIVE });
    expect(watch).toHaveBeenCalledWith(SCOPE, expect.objectContaining({
      instanceId: h.instance.instanceId }), h.context.signal,
    expect.objectContaining({ preferNativeH264: true,
      profile: { framesPerSecond: 20, scalingPercent: 70, orientation: "PORTRAIT" },
      mjpegProfile: { framesPerSecond: 10, jpegQuality: 45, scalingPercent: 70 } }),
    request.subscriptionId);
    expect(h.store.listOperations({ sessionId: SCOPE.sessionId })).toEqual([]);
    await stream.return?.();
    await expect(h.service.watchSimulatorFrames(create(contract.WatchSimulatorFramesRequestSchema,
      { ...request, framesPerSecond: 61 }), h.context)[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(h.service.watchSimulatorFrames(create(contract.WatchSimulatorFramesRequestSchema,
      { ...request, jpegQuality: 0 }), h.context)[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: Code.InvalidArgument });
  } finally { h.store.close(); }
});

it("projects an explicit decoder fallback without accepting arbitrary route reasons", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const watch = vi.fn(async function* () {
    yield { kind: "frame", sequence: 1, receivedAt: new Date(2_000).toISOString(),
      bytes: jpeg, nativeRoute: "fallback_decode" } as const;
  });
  const h = fixture({ watch });
  const request = create(contract.WatchSimulatorFramesRequestSchema, {
    sessionId: SCOPE.sessionId, route: { instanceId: h.instance.instanceId,
      generation: BigInt(h.instance.generation), leaseId: h.instance.lease.id },
    mjpegFramesPerSecond: 10, jpegQuality: 45, mjpegScalingPercent: 70,
    clientFallbackReason: "decode_failed", subscriptionId: randomUUID()
  });
  try {
    const stream = h.service.watchSimulatorFrames(request, h.context)[Symbol.asyncIterator]();
    expect((await stream.next()).value).toMatchObject({
      nativeRouteState: contract.SimulatorViewerNativeRouteState.FALLBACK_DECODE,
      jpeg
    });
    expect(watch).toHaveBeenCalledWith(SCOPE, expect.anything(), h.context.signal,
      expect.objectContaining({ preferNativeH264: false,
        clientFallbackReason: "decode_failed" }), request.subscriptionId);
    await expect(h.service.watchSimulatorFrames(create(contract.WatchSimulatorFramesRequestSchema,
      { ...request, clientFallbackReason: "arbitrary" }),
    h.context)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(h.service.watchSimulatorFrames(create(contract.WatchSimulatorFramesRequestSchema,
      { ...request, preferNativeH264: true, framesPerSecond: 20, scalingPercent: 70,
        orientation: "PORTRAIT" }), h.context)[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: Code.InvalidArgument });
  } finally { h.store.close(); }
});

it("maps current visible-frame input through a fresh snapshot and the durable input owner", async () => {
  const snapshotId = randomUUID();
  const execute = vi.fn(async (_scope, _route, action) => ({
    receipt: { action: action.type }, replayed: action.type === "type_text",
    observation: null, observationError: null
  }));
  const screenMap = vi.fn(async () => ({
    screenMap: { snapshotId },
    viewport: { width: 100, height: 200, orientation: "PORTRAIT" }
  }));
  const inputView = vi.fn(() => ({ state: "streaming" as const, encoding: "h264" as const,
    viewerOrientation: "LANDSCAPE" as const, lastFrameAt: new Date().toISOString() }));
  const h = fixture({ watch: async function* () { /* not consumed */ }, inputView },
    { execute, screenMap });
  try {
    const route = { instanceId: h.instance.instanceId,
      generation: BigInt(h.instance.generation), leaseId: h.instance.lease.id };
    const tap = create(contract.ControlSimulatorViewerInputRequestSchema, {
      sessionId: SCOPE.sessionId, requestId: randomUUID(), route,
      input: { case: "tap", value: { point: { xRatio: 0.3, yRatio: 0.2 } } }
    });
    expect(await h.service.controlSimulatorViewerInput(tap, h.context))
      .toMatchObject({ replayed: false });
    expect(screenMap).toHaveBeenCalledWith(SCOPE, expect.objectContaining({
      instanceId: h.instance.instanceId }), expect.any(AbortSignal));
    expect(execute).toHaveBeenNthCalledWith(1, SCOPE, expect.objectContaining({
      instanceId: h.instance.instanceId }), {
      type: "tap", snapshotId, target: { x: 20, y: 140 }
    }, { mode: "none", timeoutMs: 5_000, stableForMs: 300 }, expect.objectContaining({
      effectIdentity: expect.stringMatching(/^[0-9a-f]{64}$/u),
      requestBodyHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u), providerGeneration: 1
    }), expect.any(AbortSignal), { bindSnapshotToOperation: false });

    const text = create(contract.ControlSimulatorViewerInputRequestSchema, {
      sessionId: SCOPE.sessionId, requestId: randomUUID(), route,
      input: { case: "text", value: { text: "private input" } }
    });
    expect(await h.service.controlSimulatorViewerInput(text, h.context))
      .toMatchObject({ replayed: true });
    expect(execute.mock.calls[1]?.[2]).toEqual({ type: "type_text", snapshotId,
      text: "private input" });
    const malformed = create(contract.ControlSimulatorViewerInputRequestSchema, {
      ...tap, requestId: randomUUID(), input: { case: "tap", value: create(
        contract.SimulatorViewerTapSchema, { point: create(contract.SimulatorViewerPointSchema,
          { xRatio: Number.NaN, yRatio: 0.5 }) }) }
    });
    await expect(h.service.controlSimulatorViewerInput(malformed, h.context))
      .rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(inputView).toHaveBeenCalledTimes(4);
    inputView.mockReturnValue({ state: "streaming", encoding: "h264",
      viewerOrientation: "LANDSCAPE", lastFrameAt: new Date(Date.now() - 10_000).toISOString() });
    await expect(h.service.controlSimulatorViewerInput(create(
      contract.ControlSimulatorViewerInputRequestSchema, { ...tap, requestId: randomUUID() }),
    h.context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(execute).toHaveBeenCalledTimes(2);
  } finally { h.store.close(); }
});

it("projects Agent mutation ownership and gates Viewer input through takeover and resume", async () => {
  const snapshotId = randomUUID();
  const execute = vi.fn(async () => ({ receipt: { action: "tap" }, replayed: false,
    observation: null, observationError: null }));
  const screenMap = vi.fn(async () => ({ screenMap: { snapshotId },
    viewport: { width: 100, height: 200, orientation: "PORTRAIT" } }));
  const inputView = vi.fn(() => ({ state: "streaming" as const, encoding: "jpeg" as const,
    viewerOrientation: null, lastFrameAt: new Date().toISOString() }));
  const h = fixture({ watch: async function* () { /* not consumed */ }, inputView }, {
    execute, screenMap
  }, { driver: { isReady: vi.fn(() => true), probeNativeLiveInput: vi.fn(async () => true) } });
  const route = { instanceId: h.instance.instanceId,
    generation: BigInt(h.instance.generation), leaseId: h.instance.lease.id };
  const internalRoute = { ...route, generation: Number(route.generation) };
  const tap = create(contract.ControlSimulatorViewerInputRequestSchema, {
    sessionId: SCOPE.sessionId, requestId: randomUUID(), route,
    input: { case: "tap", value: { point: { xRatio: 0.5, yRatio: 0.5 } } }
  });
  try {
    const active = h.mutations.runAgent(SCOPE, internalRoute, async signal => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      signal.throwIfAborted();
    });
    await vi.waitFor(() => expect(h.mutations.state(SCOPE, internalRoute).activeSource).toBe("agent"));
    expect(await h.service.getSimulatorViewerMutationState(create(
      contract.GetSimulatorViewerMutationStateRequestSchema,
      { sessionId: SCOPE.sessionId, route }), h.context)).toMatchObject({
      mutation: { instanceId: h.instance.instanceId,
        activeSource: contract.SimulatorViewerMutationSource.AGENT,
        queuedAgentMutations: 0, agentPaused: false, takeoverPending: false }
    });
    await expect(h.service.controlSimulatorViewerInput(tap, h.context))
      .rejects.toMatchObject({ code: Code.FailedPrecondition });
    await expect(h.service.getSimulatorViewerControls(create(
      contract.GetSimulatorViewerControlsRequestSchema,
      { sessionId: SCOPE.sessionId, route }), h.context))
      .rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(screenMap).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    const takeover = await h.service.setSimulatorViewerMutationControl(create(
      contract.SetSimulatorViewerMutationControlRequestSchema,
      { sessionId: SCOPE.sessionId, route, agentPaused: true }), h.context);
    expect(takeover).toMatchObject({ mutation: { agentPaused: true, takeoverPending: true } });
    await expect(active).rejects.toThrow();
    await vi.waitFor(() => expect(h.mutations.state(SCOPE, internalRoute).takeoverPending).toBe(false));
    await expect(h.mutations.runAgent(SCOPE, internalRoute, async () => undefined))
      .rejects.toMatchObject({ code: "AGENT_MUTATION_PAUSED" });
    expect(await h.service.controlSimulatorViewerInput(create(
      contract.ControlSimulatorViewerInputRequestSchema,
      { ...tap, requestId: randomUUID() }), h.context)).toMatchObject({ replayed: false });
    expect(execute).toHaveBeenCalledOnce();
    const resumed = await h.service.setSimulatorViewerMutationControl(create(
      contract.SetSimulatorViewerMutationControlRequestSchema,
      { sessionId: SCOPE.sessionId, route, agentPaused: false }), h.context);
    expect(resumed).toMatchObject({ mutation: { agentPaused: false, takeoverPending: false } });
    await expect(h.mutations.runAgent(SCOPE, internalRoute, async () => "agent"))
      .resolves.toBe("agent");
  } finally { h.store.close(); }
});

it("projects only the authenticated task's exact instance and routes UI deletion outside the agent catalog", async () => {
  const h = fixture();
  try {
    const state = await h.service.getSimulatorViewerState(create(
      contract.GetSimulatorViewerStateRequestSchema, { sessionId: SCOPE.sessionId }), h.context);
    expect(state).toMatchObject({ support: contract.CapabilitySupport.SUPPORTED,
      devices: [{ udid: DEVICE.udid }], instances: [{ simulatorName: DEVICE.name,
        creationProvenance: "joko", route: { instanceId: h.instance.instanceId },
        mutation: { instanceId: h.instance.instanceId, activeSource:
          contract.SimulatorViewerMutationSource.UNSPECIFIED, agentPaused: false } }] });
    const request = create(contract.ControlSimulatorInstanceRequestSchema, {
      sessionId: SCOPE.sessionId, requestId: randomUUID(),
      action: contract.SimulatorViewerAction.DELETE,
      route: { instanceId: h.instance.instanceId,
        generation: BigInt(h.instance.generation), leaseId: h.instance.lease.id }
    });
    const result = await h.service.controlSimulatorInstance(request, h.context);
    expect(result).toMatchObject({ deleted: true, replayed: false,
      instance: { route: { instanceId: h.instance.instanceId } } });
    expect(h.remove).toHaveBeenCalledOnce();
    expect(h.clear).toHaveBeenCalledWith(h.instance.instanceId);
    expect(h.ownership.listForTask(SCOPE)).toEqual([]);
    expect(await h.service.controlSimulatorInstance(request, h.context))
      .toMatchObject({ deleted: true, replayed: true });
    expect(h.remove).toHaveBeenCalledTimes(2);
    expect(h.clear).toHaveBeenCalledTimes(2);
  } finally { h.store.close(); }
});

it("denies revoked, malformed, remote and review-only UI mutations before dispatch", async () => {
  const h = fixture();
  try {
    const valid = create(contract.ControlSimulatorInstanceRequestSchema, {
      sessionId: SCOPE.sessionId, requestId: randomUUID(),
      action: contract.SimulatorViewerAction.DELETE,
      route: { instanceId: h.instance.instanceId,
        generation: BigInt(h.instance.generation), leaseId: h.instance.lease.id }
    });
    await expect(h.service.controlSimulatorInstance(create(contract.ControlSimulatorInstanceRequestSchema,
      { ...valid, route: undefined }), h.context)).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(h.remove).not.toHaveBeenCalled();
    h.revoke();
    await expect(h.service.controlSimulatorInstance(valid, h.context))
      .rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(h.remove).not.toHaveBeenCalled();
    h.authorize();
    const policy = vi.spyOn(h.store, "findSessionRuntimePolicy").mockReturnValue({
      policy: "review_read_only" } as never);
    await expect(h.service.controlSimulatorInstance(valid, h.context))
      .rejects.toMatchObject({ code: Code.PermissionDenied });
    policy.mockRestore();
    h.store.upsertTarget({ id: "remote", backendId: "pi", displayName: "Remote host",
      workspaceRoot: "/work", managed: false, trusted: true });
    h.store.upsertTarget({ ...h.store.getTarget(SCOPE.targetId).descriptor,
      remoteWorkspace: { hostTargetId: "remote", hostId: "host", workspaceRoot: "/work" } });
    await expect(h.service.controlSimulatorInstance(valid, h.context))
      .rejects.toMatchObject({ code: "STALE_SCOPE" });
    expect(h.remove).not.toHaveBeenCalled();
  } finally { h.store.close(); }
});
