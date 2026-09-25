import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { OperationalStore } from "@joko/store";
import type { SimulatorEnvironmentRuntime } from "@joko/tool-ios-simulator";
import type { SimulatorInstanceControlCoordinator } from "./ios-simulator-instance-control.js";
import type { PublicSimulatorInstance, SimulatorInstanceRoute,
  SimulatorOwnershipRegistry, SimulatorTaskScope } from "./ios-simulator-ownership.js";
import type { SimulatorViewerFrameCoordinator } from "./ios-simulator-viewer-frames.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;

export interface SimulatorViewerServiceOwner {
  readonly ownership: SimulatorOwnershipRegistry;
  readonly control: SimulatorInstanceControlCoordinator;
  readonly environment: SimulatorEnvironmentRuntime;
  readonly frames?: SimulatorViewerFrameCoordinator;
  clearInstance(instanceId: string): Promise<void>;
}

export function createSimulatorViewerConnectService(input: {
  readonly store: OperationalStore;
  readonly owner?: SimulatorViewerServiceOwner;
  readonly authenticate: (context: HandlerContext) => unknown;
  readonly isSessionMutationBlocked?: (sessionId: string) => boolean;
}): ServiceImpl<typeof contract.SimulatorViewerService> {
  const scope = (sessionId: string, mutate: boolean): SimulatorTaskScope => {
    if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 128 ||
        /[\u0000-\u001f\u007f]/u.test(sessionId)) throw new ConnectError(
      "Simulator task identity is invalid.", Code.InvalidArgument);
    const session = input.store.getSession(sessionId).descriptor;
    if (session.archived || session.deletedAt !== undefined ||
        input.store.findPendingSessionLifecycleCleanup(sessionId) !== undefined ||
        input.store.findPendingScheduleDeletionCleanupForSession(sessionId) !== undefined) {
      throw new ConnectError("This task is closing or no longer active.", Code.FailedPrecondition);
    }
    if (mutate && input.isSessionMutationBlocked?.(sessionId)) throw new ConnectError(
      "This task is being replaced and cannot accept Simulator changes.", Code.FailedPrecondition);
    if (mutate && input.store.findSessionRuntimePolicy(sessionId)?.policy === "review_read_only") {
      throw new ConnectError("This task only permits review reads.", Code.PermissionDenied);
    }
    const current = { sessionId, targetId: session.targetId, generation: session.binding.generation };
    input.owner?.ownership.assertScope(current);
    return current;
  };
  const fence = (context: HandlerContext, original: SimulatorTaskScope, mutate: boolean): void => {
    input.authenticate(context);
    if (context.signal.aborted) throw new ConnectError("Simulator request was cancelled.", Code.Canceled);
    const current = scope(original.sessionId, mutate);
    if (current.targetId !== original.targetId || current.generation !== original.generation) {
      throw new ConnectError("Simulator task binding changed.", Code.Aborted);
    }
  };
  const owner = (): SimulatorViewerServiceOwner => {
    if (!input.owner) throw new ConnectError("Simulator Viewer is unavailable.", Code.Unimplemented);
    return input.owner;
  };
  return {
    getSimulatorViewerState: async (request, context) => {
      input.authenticate(context);
      const task = scope(request.sessionId, false);
      const currentOwner = input.owner;
      const instances = currentOwner?.ownership.listForTask(task) ?? [];
      if (!currentOwner) return create(contract.GetSimulatorViewerStateResponseSchema, {
        support: contract.CapabilitySupport.TEMPORARILY_UNAVAILABLE,
        reasonCode: "SIMULATOR_VIEWER_UNAVAILABLE", instances: instances.map(projectInstance)
      });
      const environment = await currentOwner.environment.inspect(context.signal);
      fence(context, task, false);
      return create(contract.GetSimulatorViewerStateResponseSchema, {
        support: environment.ready ? contract.CapabilitySupport.SUPPORTED
          : environment.platform === "darwin" ? contract.CapabilitySupport.TEMPORARILY_UNAVAILABLE
            : contract.CapabilitySupport.PLATFORM_LIMITED,
        reasonCode: environment.issue ?? "",
        devices: environment.devices.map(device => create(contract.SimulatorViewerDeviceSchema, {
          udid: device.udid, name: device.name, state: device.state,
          runtimeIdentifier: device.runtimeIdentifier, runtimeName: device.runtimeName,
          deviceTypeIdentifier: device.deviceTypeIdentifier ?? "", available: device.isAvailable
        })),
        instances: currentOwner.ownership.listForTask(task).map(projectInstance)
      });
    },
    controlSimulatorInstance: async (request, context) => {
      input.authenticate(context);
      const task = scope(request.sessionId, true);
      const currentOwner = owner();
      if (!UUID.test(request.requestId)) throw new ConnectError(
        "Simulator request identity is invalid.", Code.InvalidArgument);
      const action = request.action;
      const routeRequired = action === contract.SimulatorViewerAction.START ||
        action === contract.SimulatorViewerAction.STOP ||
        action === contract.SimulatorViewerAction.DETACH ||
        action === contract.SimulatorViewerAction.DELETE;
      const route = routeRequired ? requiredRoute(request.route) : undefined;
      if (routeRequired ? request.templateUdid !== "" || request.name !== "" ||
          request.deviceUdid !== "" : request.route !== undefined) throw new ConnectError(
        "Simulator control arguments are invalid.", Code.InvalidArgument);
      if (action === contract.SimulatorViewerAction.CREATE &&
          (!UUID.test(request.templateUdid) || request.name.length < 1 || request.name.length > 128 ||
            request.name.trim() !== request.name || request.deviceUdid !== "") ||
          action === contract.SimulatorViewerAction.ATTACH &&
          (!UUID.test(request.deviceUdid) || request.templateUdid !== "" || request.name !== "") ||
          !routeRequired && action !== contract.SimulatorViewerAction.CREATE &&
            action !== contract.SimulatorViewerAction.ATTACH) throw new ConnectError(
        "Simulator control arguments are invalid.", Code.InvalidArgument);
      const body = { action, sessionId: task.sessionId, targetId: task.targetId,
        generation: task.generation, route, templateUdid: request.templateUdid,
        name: request.name, deviceUdid: request.deviceUdid };
      const authority = {
        effectIdentity: createHash("sha256").update(`simulator-viewer:${request.requestId}`).digest("hex"),
        requestBodyHash: `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`,
        providerGeneration: 1
      };
      fence(context, task, true);
      const result = action === contract.SimulatorViewerAction.CREATE
        ? await currentOwner.control.create(task,
          { templateUdid: request.templateUdid, name: request.name }, authority, context.signal)
        : action === contract.SimulatorViewerAction.ATTACH
          ? await currentOwner.control.attach(task, request.deviceUdid, authority, context.signal)
          : action === contract.SimulatorViewerAction.START
            ? await currentOwner.control.start(task, route!, authority, context.signal)
            : action === contract.SimulatorViewerAction.STOP
              ? await currentOwner.control.stop(task, route!, authority, context.signal)
              : action === contract.SimulatorViewerAction.DETACH
                ? await currentOwner.control.detach(task, route!, authority, context.signal)
                : await currentOwner.control.delete(task, route!, authority, context.signal);
      await currentOwner.clearInstance(result.instance.instanceId);
      fence(context, task, true);
      return create(contract.ControlSimulatorInstanceResponseSchema, {
        instance: projectInstance(result.instance),
        deleted: action === contract.SimulatorViewerAction.DELETE,
        replayed: result.replayed
      });
    },
    watchSimulatorFrames: async function* (request, context) {
      input.authenticate(context);
      const task = scope(request.sessionId, false);
      const currentOwner = owner();
      if (!currentOwner.frames) throw new ConnectError(
        "Simulator Viewer frames are unavailable.", Code.Unimplemented);
      const route = requiredRoute(request.route);
      if (request.preferNativeH264 && (!Number.isSafeInteger(request.framesPerSecond) ||
          request.framesPerSecond < 1 || request.framesPerSecond > 60 ||
          !Number.isSafeInteger(request.scalingPercent) || request.scalingPercent < 1 ||
          request.scalingPercent > 100 ||
          !["PORTRAIT", "LANDSCAPE"].includes(request.orientation))) {
        throw new ConnectError("Simulator video profile is invalid.", Code.InvalidArgument);
      }
      fence(context, task, false);
      for await (const event of currentOwner.frames.watch(task, route, context.signal,
        { preferNativeH264: request.preferNativeH264, profile: {
          framesPerSecond: request.preferNativeH264 ? request.framesPerSecond : 20,
          scalingPercent: request.preferNativeH264 ? request.scalingPercent : 70,
          orientation: request.preferNativeH264 ? request.orientation as "PORTRAIT" | "LANDSCAPE"
            : "PORTRAIT"
        } })) {
        fence(context, task, false);
        yield create(contract.WatchSimulatorFramesResponseSchema, {
          route: create(contract.SimulatorViewerRouteSchema, { instanceId: route.instanceId,
            generation: BigInt(route.generation), leaseId: route.leaseId }),
          state: event.kind === "frame" || event.kind === "h264"
            ? contract.SimulatorViewerStreamState.FRAME
            : event.kind === "connecting" ? contract.SimulatorViewerStreamState.CONNECTING
              : event.kind === "reconnecting" ? contract.SimulatorViewerStreamState.RECONNECTING
                : contract.SimulatorViewerStreamState.DISCONNECTED,
          ...(event.kind === "frame" ? { sequence: BigInt(event.sequence),
            receivedAtMs: BigInt(Date.parse(event.receivedAt)), jpeg: event.bytes }
            : event.kind === "h264" ? { sequence: BigInt(event.sequence),
              receivedAtMs: BigInt(Date.parse(event.receivedAt)), h264: event.bytes,
              width: event.width, height: event.height,
              timestampMicros: BigInt(event.timestampMicros),
              keyFrame: event.keyFrame, h264Format: event.format }
            : { reconnectAttempt: event.attempt })
        });
      }
    }
  };
}

function requiredRoute(value: contract.SimulatorViewerRoute | undefined): SimulatorInstanceRoute {
  if (!value || typeof value.instanceId !== "string" || value.instanceId.length === 0 ||
      value.instanceId.length > 128 || typeof value.leaseId !== "string" ||
      value.leaseId.length === 0 || value.leaseId.length > 128 ||
      !Number.isSafeInteger(Number(value.generation)) || value.generation < 1n) {
    throw new ConnectError("Simulator route is invalid.", Code.InvalidArgument);
  }
  return { instanceId: value.instanceId, generation: Number(value.generation), leaseId: value.leaseId };
}

function projectInstance(instance: PublicSimulatorInstance): contract.SimulatorViewerInstance {
  return create(contract.SimulatorViewerInstanceSchema, {
    route: create(contract.SimulatorViewerRouteSchema, {
      instanceId: instance.instanceId, generation: BigInt(instance.generation), leaseId: instance.lease.id
    }),
    simulatorUdid: instance.simulatorUdid, simulatorName: instance.simulatorName,
    runtimeIdentifier: instance.runtimeIdentifier, deviceTypeIdentifier: instance.deviceTypeIdentifier,
    creationProvenance: instance.creationProvenance, bootProvenance: instance.bootProvenance,
    lifecycleState: instance.lifecycleState, viewerState: instance.viewerState,
    healthState: instance.healthState, errorCode: instance.errorCode ?? "",
    graceExpiresAtMs: BigInt(instance.graceExpiresAt ?? 0),
    leaseExpiresAtMs: BigInt(instance.lease.expiresAt)
  });
}
