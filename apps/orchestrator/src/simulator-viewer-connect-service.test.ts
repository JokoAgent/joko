import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { expect, it, vi } from "vitest";
import { SimulatorOwnershipRegistry } from "./ios-simulator-ownership.js";
import { createSimulatorViewerConnectService } from "./simulator-viewer-connect-service.js";

const SCOPE = { sessionId: "simulator-task", targetId: "local", generation: 1 } as const;
const DEVICE = { udid: "A0123456-1234-1234-1234-123456789ABC", name: "Joko iPhone",
  state: "Shutdown", isAvailable: true,
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0",
  runtimeName: "iOS 19.0", runtimeVersion: "19.0",
  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", lastBootedAt: null } as const;

function fixture() {
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
      clearInstance: clear },
    authenticate: () => { if (!authorized) throw new ConnectError("Revoked", Code.Unauthenticated); }
  });
  return { store, ownership, instance, remove, clear, service, context,
    revoke: () => { authorized = false; }, authorize: () => { authorized = true; } };
}

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
