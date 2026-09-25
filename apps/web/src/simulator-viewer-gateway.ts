import { createClient, type Transport } from "@connectrpc/connect";
import {
  CapabilitySupport, SimulatorViewerAction, SimulatorViewerCommand, SimulatorViewerMutationSource,
  SimulatorViewerNativeRouteState,
  SimulatorViewerService, SimulatorViewerStreamState,
  SimulatorViewerTouchPhase,
  type SimulatorViewerInstance, type SimulatorViewerMutationState
} from "@joko/contracts";
import type {
  OperationApi, SimulatorViewerInstanceView, SimulatorViewerMutationStateView, SimulatorViewerRouteView,
  SimulatorViewerStateView
} from "./model.js";
import { randomUuid } from "./web-crypto.js";

type ViewerApi = Pick<OperationApi, "getSimulatorViewerState" | "controlSimulatorInstance" |
  "controlSimulatorViewerInput" | "controlSimulatorViewerTouch" |
  "setSimulatorViewerInteractionProfile" | "getSimulatorViewerMutationState" |
  "setSimulatorViewerMutationControl" | "getSimulatorViewerControls" |
  "controlSimulatorViewerCommand" | "watchSimulatorFrames">;

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
    },
    async controlSimulatorViewerInput(sessionId, requestId, route, input, signal) {
      const action = input.action === "tap"
        ? { case: "tap" as const, value: { point: { xRatio: input.xRatio, yRatio: input.yRatio } } }
        : input.action === "swipe"
          ? { case: "swipe" as const, value: {
            start: { xRatio: input.startXRatio, yRatio: input.startYRatio },
            end: { xRatio: input.endXRatio, yRatio: input.endYRatio },
            durationMs: input.durationMs
          } }
          : { case: "text" as const, value: { text: input.text } };
      const response = await client.controlSimulatorViewerInput({ sessionId, requestId, route,
        input: action }, options(signal));
      return { replayed: response.replayed };
    },
    async controlSimulatorViewerTouch(sessionId, route, touch, signal) {
      const phase = touch.phase === "begin" ? SimulatorViewerTouchPhase.BEGIN
        : touch.phase === "move" ? SimulatorViewerTouchPhase.MOVE
          : touch.phase === "end" ? SimulatorViewerTouchPhase.END
            : SimulatorViewerTouchPhase.CANCEL;
      const response = await client.controlSimulatorViewerTouch({ sessionId, route,
        gestureId: touch.gestureId, sequence: touch.sequence, phase,
        point: { xRatio: touch.xRatio, yRatio: touch.yRatio } }, options(signal));
      return { accepted: response.accepted };
    },
    async setSimulatorViewerInteractionProfile(sessionId, route, subscriptionId, active, signal) {
      const response = await client.setSimulatorViewerInteractionProfile({ sessionId, route,
        subscriptionId, active }, options(signal));
      return { applied: response.applied };
    },
    async getSimulatorViewerMutationState(sessionId, route, signal) {
      const response = await client.getSimulatorViewerMutationState({ sessionId, route }, options(signal));
      return mutationView(response.mutation, route.instanceId);
    },
    async setSimulatorViewerMutationControl(sessionId, route, agentPaused, signal) {
      const response = await client.setSimulatorViewerMutationControl({ sessionId, route,
        agentPaused }, options(signal));
      return mutationView(response.mutation, route.instanceId);
    },
    async getSimulatorViewerControls(sessionId, route, signal) {
      const response = await client.getSimulatorViewerControls({ sessionId, route }, options(signal));
      if (!Number.isSafeInteger(response.viewportWidth) || response.viewportWidth < 1 ||
          response.viewportWidth > 8_192 || !Number.isSafeInteger(response.viewportHeight) ||
          response.viewportHeight < 1 || response.viewportHeight > 8_192 ||
          response.orientation !== "PORTRAIT" && response.orientation !== "LANDSCAPE") {
        throw new Error("Simulator Viewer controls response is invalid.");
      }
      return { viewportWidth: response.viewportWidth, viewportHeight: response.viewportHeight,
        orientation: response.orientation, nativeTouchAvailable: response.nativeTouchAvailable };
    },
    async controlSimulatorViewerCommand(sessionId, requestId, route, command, signal) {
      const mapped = command.action === "home" ? SimulatorViewerCommand.HOME
        : command.action === "rotate" ? SimulatorViewerCommand.ROTATE
          : command.action === "lock" ? SimulatorViewerCommand.LOCK
            : command.action === "unlock" ? SimulatorViewerCommand.UNLOCK
              : SimulatorViewerCommand.COPY_SCREENSHOT;
      const response = await client.controlSimulatorViewerCommand({ sessionId, requestId,
        route, command: mapped,
        orientation: command.action === "rotate" ? command.orientation : ""
      }, options(signal));
      if (command.action === "copyScreenshot" ? response.screenshotBlobId === ""
        : response.screenshotBlobId !== "") throw new Error(
        "Simulator Viewer command response is invalid.");
      return { replayed: response.replayed,
        ...(response.screenshotBlobId === "" ? {} : { screenshotBlobId: response.screenshotBlobId }) };
    },
    async *watchSimulatorFrames(sessionId, route, signal, preference) {
      let sequence = 0n;
      const profile = preference ?? { subscriptionId: randomUuid(),
        preferNativeH264: false, framesPerSecond: 20,
        scalingPercent: 70, orientation: "PORTRAIT" as const,
        mjpegFramesPerSecond: 10, jpegQuality: 45, mjpegScalingPercent: 70 };
      for await (const response of client.watchSimulatorFrames({ sessionId, route,
        preferNativeH264: profile.preferNativeH264,
        framesPerSecond: profile.framesPerSecond, scalingPercent: profile.scalingPercent,
        orientation: profile.orientation, mjpegFramesPerSecond: profile.mjpegFramesPerSecond,
        jpegQuality: profile.jpegQuality, mjpegScalingPercent: profile.mjpegScalingPercent,
        clientFallbackReason: profile.clientFallbackReason ?? "",
        subscriptionId: profile.subscriptionId
      }, options(signal))) {
        if (response.route?.instanceId !== route.instanceId ||
            response.route.generation !== route.generation || response.route.leaseId !== route.leaseId) {
          throw new Error("Simulator frame belongs to another instance route.");
        }
        const nativeRoute = mapNativeRoute(response.nativeRouteState);
        if (response.state === SimulatorViewerStreamState.FRAME) {
          if (response.sequence <= sequence || response.receivedAtMs <= 0n ||
              response.receivedAtMs > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error("Simulator frame response is invalid.");
          }
          sequence = response.sequence;
          if (response.jpeg.length > 0 && response.h264.length === 0 &&
              response.width === 0 && response.height === 0 &&
              response.timestampMicros === 0n && !response.keyFrame &&
              response.h264Format === "") {
            if (response.jpeg.length < 4 || response.jpeg.length > 16 * 1024 * 1024 ||
                response.jpeg[0] !== 0xff || response.jpeg[1] !== 0xd8 ||
                response.jpeg[response.jpeg.length - 2] !== 0xff ||
                response.jpeg[response.jpeg.length - 1] !== 0xd9)
              throw new Error("Simulator JPEG frame is invalid.");
            yield { kind: "frame", sequence, receivedAtMs: Number(response.receivedAtMs),
              jpeg: response.jpeg, nativeRoute };
          } else if (response.h264.length >= 5 && response.h264.length <= 16 * 1024 * 1024 &&
              response.jpeg.length === 0 && response.width >= 1 && response.width <= 8_192 &&
              response.height >= 1 && response.height <= 8_192 &&
              response.timestampMicros <= BigInt(Number.MAX_SAFE_INTEGER) &&
              response.h264Format === "annex-b" &&
              response.h264[0] === 0 && response.h264[1] === 0 &&
              response.h264[2] === 0 && response.h264[3] === 1) {
            yield { kind: "h264", sequence, receivedAtMs: Number(response.receivedAtMs),
              h264: response.h264, width: response.width, height: response.height,
              timestampMicros: Number(response.timestampMicros), keyFrame: response.keyFrame,
              format: "annex-b", nativeRoute };
          } else throw new Error("Simulator H.264 frame is invalid.");
          continue;
        }
        if (response.jpeg.length !== 0 || response.h264.length !== 0 ||
            response.width !== 0 || response.height !== 0 ||
            response.timestampMicros !== 0n || response.keyFrame ||
            response.h264Format !== "" || response.sequence !== 0n ||
            !Number.isSafeInteger(response.reconnectAttempt) || response.reconnectAttempt > 3) {
          throw new Error("Simulator frame status is invalid.");
        }
        yield { kind: response.state === SimulatorViewerStreamState.CONNECTING ? "connecting"
          : response.state === SimulatorViewerStreamState.RECONNECTING ? "reconnecting"
            : response.state === SimulatorViewerStreamState.DISCONNECTED ? "disconnected"
              : (() => { throw new Error("Simulator frame state is invalid."); })(),
        attempt: response.reconnectAttempt, nativeRoute };
      }
    }
  };
}

function mapNativeRoute(value: SimulatorViewerNativeRouteState):
  "inactive" | "active" | "fallbackUnavailable" | "fallbackLost" | "fallbackDecode" {
  switch (value) {
    case SimulatorViewerNativeRouteState.INACTIVE: return "inactive";
    case SimulatorViewerNativeRouteState.ACTIVE: return "active";
    case SimulatorViewerNativeRouteState.FALLBACK_UNAVAILABLE: return "fallbackUnavailable";
    case SimulatorViewerNativeRouteState.FALLBACK_LOST: return "fallbackLost";
    case SimulatorViewerNativeRouteState.FALLBACK_DECODE: return "fallbackDecode";
    default: throw new Error("Simulator native route state is invalid.");
  }
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
    healthState: value.healthState, mutation: mutationView(value.mutation, route.instanceId),
    ...(value.errorCode === "" ? {} : { errorCode: value.errorCode }),
    ...(value.graceExpiresAtMs === 0n ? {} : { graceExpiresAtMs: Number(value.graceExpiresAtMs) })
  };
}

function mutationView(value: SimulatorViewerMutationState | undefined,
  instanceId: string): SimulatorViewerMutationStateView {
  const source = (input: SimulatorViewerMutationSource): "agent" | "user" | null =>
    input === SimulatorViewerMutationSource.AGENT ? "agent"
      : input === SimulatorViewerMutationSource.USER ? "user"
        : input === SimulatorViewerMutationSource.UNSPECIFIED ? null
          : (() => { throw new Error("Simulator mutation source is invalid."); })();
  if (!value || value.instanceId !== instanceId || !Number.isSafeInteger(value.queuedAgentMutations) ||
      value.queuedAgentMutations < 0 || value.takeoverPending && !value.agentPaused) {
    throw new Error("Simulator Viewer mutation state is invalid.");
  }
  return { instanceId, activeSource: source(value.activeSource), lastSource: source(value.lastSource),
    queuedAgentMutations: value.queuedAgentMutations, agentPaused: value.agentPaused,
    takeoverPending: value.takeoverPending };
}

function validRoute(value: SimulatorViewerRouteView): boolean {
  return value.instanceId !== "" && value.leaseId !== "" && value.generation > 0n;
}
