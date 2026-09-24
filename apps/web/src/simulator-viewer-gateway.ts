import { createClient, type Transport } from "@connectrpc/connect";
import {
  CapabilitySupport, SimulatorViewerAction, SimulatorViewerService,
  type SimulatorViewerInstance
} from "@joko/contracts";
import type {
  OperationApi, SimulatorViewerInstanceView, SimulatorViewerRouteView,
  SimulatorViewerStateView
} from "./model.js";

type ViewerApi = Pick<OperationApi, "getSimulatorViewerState" | "controlSimulatorInstance">;

export function createSimulatorViewerGateway(transport: Transport, ownerSignal?: AbortSignal): ViewerApi {
  const client = createClient(SimulatorViewerService, transport);
  const options = (signal?: AbortSignal) => ({ signal: ownerSignal === undefined ? signal
    : signal === undefined ? ownerSignal : AbortSignal.any([ownerSignal, signal]) });
  return {
    async getSimulatorViewerState(sessionId, signal) {
      const result = await client.getSimulatorViewerState({ sessionId }, options(signal));
      const support: SimulatorViewerStateView["support"] = result.support === CapabilitySupport.SUPPORTED
        ? "supported" : result.support === CapabilitySupport.PLATFORM_LIMITED
          ? "platformLimited" : result.support === CapabilitySupport.TEMPORARILY_UNAVAILABLE
            ? "temporarilyUnavailable" : "unavailable";
      return {
        support, ...(result.reasonCode === "" ? {} : { reasonCode: result.reasonCode }),
        devices: result.devices.map(device => ({
          udid: device.udid, name: device.name, state: device.state,
          runtimeIdentifier: device.runtimeIdentifier, runtimeName: device.runtimeName,
          deviceTypeIdentifier: device.deviceTypeIdentifier, available: device.available
        })),
        instances: result.instances.map(instanceView)
      };
    },
    async controlSimulatorInstance(sessionId, requestId, input, signal) {
      const action = input.action === "create" ? SimulatorViewerAction.CREATE
        : input.action === "attach" ? SimulatorViewerAction.ATTACH
          : input.action === "start" ? SimulatorViewerAction.START
            : input.action === "stop" ? SimulatorViewerAction.STOP
              : input.action === "detach" ? SimulatorViewerAction.DETACH
                : SimulatorViewerAction.DELETE;
      const response = await client.controlSimulatorInstance({
        sessionId, requestId, action,
        ...(input.action === "create" ? { templateUdid: input.templateUdid, name: input.name }
          : input.action === "attach" ? { deviceUdid: input.deviceUdid }
            : { route: input.route })
      }, options(signal));
      return { instance: instanceView(response.instance), deleted: response.deleted, replayed: response.replayed };
    }
  };
}

function instanceView(value: SimulatorViewerInstance | undefined): SimulatorViewerInstanceView {
  const route = value?.route;
  if (value === undefined || route === undefined || !validRoute(route) ||
      value.simulatorUdid === "" || value.simulatorName === "" ||
      !["joko", "external"].includes(value.creationProvenance) ||
      !["stopped", "ready", "error"].includes(value.lifecycleState) ||
      !["attached", "detached"].includes(value.viewerState)) {
    throw new Error("Simulator Viewer response has an invalid instance.");
  }
  return {
    route, simulatorUdid: value.simulatorUdid, simulatorName: value.simulatorName,
    runtimeIdentifier: value.runtimeIdentifier, deviceTypeIdentifier: value.deviceTypeIdentifier,
    creationProvenance: value.creationProvenance as SimulatorViewerInstanceView["creationProvenance"],
    lifecycleState: value.lifecycleState as SimulatorViewerInstanceView["lifecycleState"],
    viewerState: value.viewerState as SimulatorViewerInstanceView["viewerState"],
    healthState: value.healthState,
    ...(value.errorCode === "" ? {} : { errorCode: value.errorCode }),
    ...(value.graceExpiresAtMs === 0n ? {} : { graceExpiresAtMs: Number(value.graceExpiresAtMs) })
  };
}

function validRoute(value: SimulatorViewerRouteView): boolean {
  return value.instanceId !== "" && value.leaseId !== "" && value.generation > 0n;
}
