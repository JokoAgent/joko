import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { expect, it, vi } from "vitest";
import { SimulatorOwnershipRegistry } from "./ios-simulator-ownership.js";
import type { SimulatorViewerFrameCoordinator } from "./ios-simulator-viewer-frames.js";
import { createSimulatorViewerConnectService } from "./simulator-viewer-connect-service.js";

const SCOPE = { sessionId: "simulator-task", targetId: "local", generation: 1 } as const;
const DEVICE = { udid: "A0123456-1234-1234-1234-123456789ABC", name: "Joko iPhone",
  state: "Shutdown", isAvailable: true,
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0",
  runtimeName: "iOS 19.0", runtimeVersion: "19.0",
  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", lastBootedAt: null } as const;

function fixture(frames?: Pick<SimulatorViewerFrameCoordinator, "watch"> &
  Partial<Pick<SimulatorViewerFrameCoordinator, "inputView">>, viewerInput?: {
    readonly execute: ReturnType<typeof vi.fn>;
    readonly screenMap: ReturnType<typeof vi.fn>;
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
  const remove = vi.fn(async (_scope, route, authority) => {
    expect(authority.effectIdentity).toMatch(/^[0-9a-f]{64}$/u);
    expect(authority.requestBodyHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    return { instance: ownership.releaseDeletedCreated(SCOPE, route), replayed: false };
  });
  const clear = vi.fn(async () => undefined);
  let authorized = true;
  const context = { signal: new AbortController().signal } as HandlerContext;
  const service = createSimulatorViewerConnectService({ store,
    owner: { ownership, control: { delete: remove } as never,
      environment: { inspect: async () => ({ platform: "darwin", ready: true,
        devices: [DEVICE], issue: null }) } as never,
      clearInstance: clear, frames: frames as never,
      input: viewerInput === undefined ? undefined : { execute: viewerInput.execute } as never,
      screen: viewerInput === undefined ? undefined : { screenMap: viewerInput.screenMap } as never },
    authenticate: () => { if (!authorized) throw new ConnectError("Revoked", Code.Unauthenticated); }
  });
  return { store, ownership, instance, remove, clear, service, context,
    revoke: () => { authorized = false; }, authorize: () => { authorized = true; } };
}

it("streams task-bound frame messages and fences authentication between yields", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]);
  const watch = vi.fn(async function* () {
    yield { kind: "connecting", attempt: 0 } as const;
    yield { kind: "frame", sequence: 1, receivedAt: new Date(1_000).toISOString(), bytes: jpeg } as const;
  });
  const h = fixture({ watch });
  try {
    const request = create(contract.WatchSimulatorFramesRequestSchema, {
      sessionId: SCOPE.sessionId, route: { instanceId: h.instance.instanceId,
        generation: BigInt(h.instance.generation), leaseId: h.instance.lease.id },
      mjpegFramesPerSecond: 10, jpegQuality: 45, mjpegScalingPercent: 70
    });
    const stream = h.service.watchSimulatorFrames(request, h.context)[Symbol.asyncIterator]();
    expect((await stream.next()).value).toMatchObject({
      state: contract.SimulatorViewerStreamState.CONNECTING,
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
      receivedAtMs: 1_000n, jpeg
    });
    await second.return?.();
  } finally { h.store.close(); }
});

it("passes a bounded native profile and projects H.264 metadata without durable media", async () => {
  const bytes = new Uint8Array([0, 0, 0, 1, 0x65, 0x88]);
  const watch = vi.fn(async function* () {
    yield { kind: "h264", sequence: 1, receivedAt: new Date(2_000).toISOString(),
      bytes, width: 16, height: 12, timestampMicros: 3_000,
      keyFrame: true, format: "annex-b" } as const;
  });
  const h = fixture({ watch });
  try {
    const request = create(contract.WatchSimulatorFramesRequestSchema, {
      sessionId: SCOPE.sessionId, route: { instanceId: h.instance.instanceId,
        generation: BigInt(h.instance.generation), leaseId: h.instance.lease.id },
      preferNativeH264: true, framesPerSecond: 20, scalingPercent: 70,
      orientation: "PORTRAIT", mjpegFramesPerSecond: 10, jpegQuality: 45,
      mjpegScalingPercent: 70
    });
    const stream = h.service.watchSimulatorFrames(request, h.context)[Symbol.asyncIterator]();
    expect((await stream.next()).value).toMatchObject({ state: contract.SimulatorViewerStreamState.FRAME,
      sequence: 1n, receivedAtMs: 2_000n, h264: bytes, jpeg: new Uint8Array(),
      width: 16, height: 12, timestampMicros: 3_000n,
      keyFrame: true, h264Format: "annex-b" });
    expect(watch).toHaveBeenCalledWith(SCOPE, expect.objectContaining({
      instanceId: h.instance.instanceId }), h.context.signal,
    expect.objectContaining({ preferNativeH264: true,
      profile: { framesPerSecond: 20, scalingPercent: 70, orientation: "PORTRAIT" },
      mjpegProfile: { framesPerSecond: 10, jpegQuality: 45, scalingPercent: 70 } }));
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
      instanceId: h.instance.instanceId }), h.context.signal);
    expect(execute).toHaveBeenNthCalledWith(1, SCOPE, expect.objectContaining({
      instanceId: h.instance.instanceId }), {
      type: "tap", snapshotId, target: { x: 20, y: 140 }
    }, { mode: "none", timeoutMs: 5_000, stableForMs: 300 }, expect.objectContaining({
      effectIdentity: expect.stringMatching(/^[0-9a-f]{64}$/u),
      requestBodyHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u), providerGeneration: 1
    }), h.context.signal, { bindSnapshotToOperation: false });

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

it("projects only the authenticated task's exact instance and routes UI deletion outside the agent catalog", async () => {
  const h = fixture();
  try {
    const state = await h.service.getSimulatorViewerState(create(
      contract.GetSimulatorViewerStateRequestSchema, { sessionId: SCOPE.sessionId }), h.context);
    expect(state).toMatchObject({ support: contract.CapabilitySupport.SUPPORTED,
      devices: [{ udid: DEVICE.udid }], instances: [{ simulatorName: DEVICE.name,
        creationProvenance: "joko", route: { instanceId: h.instance.instanceId } }] });
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
