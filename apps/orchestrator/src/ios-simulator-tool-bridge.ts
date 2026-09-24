import { assessSimulatorResourceAdmission, collectSimulatorMemorySnapshot, createSimulatorEnvironmentRuntime,
  serializeSimulatorPushPayload,
  type SimulatorEnvironmentReport, type SimulatorEnvironmentRuntime, type SimulatorMemorySnapshot,
  type SimulatorStatusBarOverrides } from "@joko/tool-ios-simulator";
import { OperationInProgressError, type OperationalStore } from "@joko/store";
import type { BridgeToolCallContext, BridgeToolProvider, McpCallResult, McpToolDescriptor } from "./mcp-router.js";
import { SimulatorOwnershipError, type SimulatorOwnershipRegistry } from "./ios-simulator-ownership.js";
import { SimulatorInstanceControlError, type SimulatorInstanceControlCoordinator,
  type SimulatorInstanceControlExecution } from "./ios-simulator-instance-control.js";
import { SimulatorCreateError, SimulatorLifecycleError, SimulatorResourceError } from "@joko/tool-ios-simulator";
import { SimulatorDriverError } from "./ios-simulator-driver-coordinator.js";
import { SimulatorObservationError, type SimulatorScreenObservationCoordinator,
  type SimulatorElementSelector, type SimulatorWaitCondition } from "./ios-simulator-screen-observation.js";
import { SimulatorInputError, type SimulatorBatchAction, type SimulatorInputAction,
  type SimulatorInputCoordinator, type SimulatorInputKey,
  type SimulatorInputObserveOptions } from "./ios-simulator-input-coordinator.js";
import { SimulatorStateControlError, type SimulatorStateControlAction,
  type SimulatorStateControlCoordinator } from "./ios-simulator-state-control.js";
import { SimulatorScreenMapError, WdaClientError, type SimulatorScreenMap } from "@joko/tool-ios-simulator";
import { SimulatorAppBuildError, type SimulatorProjectBuildCoordinator } from "./ios-simulator-project-build.js";
import { SimulatorAppInstallError, type SimulatorAppInstallCoordinator } from "./ios-simulator-app-install.js";
import { SimulatorAppControlError, type SimulatorAppControlCoordinator,
  type SimulatorAppControlAction } from "./ios-simulator-app-control.js";

export const IOS_SIMULATOR_TOOL_PROVIDER_ID = "joko_ios_simulator";
const CATEGORY = "ios_simulator";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const DIGEST = /^[0-9a-f]{64}$/u;
const BODY_HASH = /^sha256:[0-9a-f]{64}$/u;
const PRIVACY_SERVICE = /^[a-z][a-z0-9-]{0,63}$/u;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/u;
const INPUT_KEYS = ["return", "tab", "escape", "delete", "arrow_up", "arrow_down",
  "arrow_left", "arrow_right"] as const satisfies readonly SimulatorInputKey[];
const CONTENT_SIZES = ["extra-small", "small", "medium", "large", "extra-large",
  "extra-extra-large", "extra-extra-extra-large", "accessibility-medium",
  "accessibility-large", "accessibility-extra-large", "accessibility-extra-extra-large",
  "accessibility-extra-extra-extra-large"] as const;
const STATUS_BAR_DATA_NETWORKS = [
  "hide", "wifi", "3g", "4g", "lte", "lte-a", "lte+", "5g", "5g+", "5g-uwb", "5g-uc"
] as const;
const STATUS_BAR_WIFI_MODES = ["searching", "failed", "active"] as const;
const STATUS_BAR_CELLULAR_MODES = ["notSupported", "searching", "failed", "active"] as const;
const STATUS_BAR_BATTERY_STATES = ["charging", "charged", "discharging"] as const;

const TOOLS = Object.freeze([
  { name: "check_environment", description: "Check the local macOS Xcode and iOS Simulator environment without opening Simulator.app.", readOnly: true },
  { name: "doctor", description: "Diagnose the current task's iOS Simulator environment and available actions.", readOnly: true },
  { name: "list_simulator_devices", description: "List simulated iPhone and iPad devices with exact UDIDs, runtime and boot states.", readOnly: true },
  { name: "list_instances", description: "List only Simulator instances registered to this task.", readOnly: true }
] as const);

const BUILD_READ_TOOLS = Object.freeze([
  { name: "read_build_diagnostics", description: "Read a bounded task-owned build log or Xcode result chunk.", readOnly: true }
] as const);

const BUILD_TOOLS = Object.freeze([
  { name: "build_app", description: "Build a trusted Xcode project for the exact Simulator. Xcode executes project build scripts as the current macOS user; those scripts can read or modify files outside the project, and bounded build diagnostics are returned to the agent. Approve only trusted projects.", readOnly: false }
] as const);

const INSTALL_TOOLS = Object.freeze([
  { name: "install_app", description: "Install only a verified build artifact from this task onto the exact booted Simulator.", readOnly: false }
] as const);

const APP_CONTROL_TOOLS = Object.freeze([
  { name: "launch_app", description: "Launch the app identified by this task's build artifact on the exact Simulator with bounded arguments.", readOnly: false },
  { name: "terminate_app", description: "Terminate the app identified by this task's build artifact on the exact Simulator.", readOnly: false }
] as const);

const CONTROL_TOOLS = Object.freeze([
  { name: "create_instance", description: "Create a task-owned Simulator from an installed template and attach its Viewer.", readOnly: false },
  { name: "attach_device", description: "Attach one exact Simulator device to this task and its Viewer.", readOnly: false },
  { name: "start_instance", description: "Boot the exact owned Simulator and start its Viewer driver.", readOnly: false },
  { name: "stop_instance", description: "Stop the exact owned Simulator without deleting it.", readOnly: false },
  { name: "detach_device", description: "Detach the Viewer; agent-booted devices receive a bounded shutdown grace.", readOnly: false }
] as const);

const OBSERVATION_TOOLS = Object.freeze([
  { name: "get_screen_map", description: "Read a bounded accessibility-first map of the attached Simulator screen.", readOnly: true },
  { name: "audit_accessibility", description: "Audit the current Simulator screen map for accessibility gaps.", readOnly: true },
  { name: "compare_screen_maps", description: "Compare a bounded earlier Simulator screen map with the current screen.", readOnly: true },
  { name: "wait_for_ui", description: "Wait for a bounded Simulator accessibility condition and return a fresh map.", readOnly: true }
] as const);

const INPUT_TOOLS = Object.freeze([
  { name: "tap", description: "Tap an element in the current Simulator screen map or bounded device coordinates.", readOnly: false },
  { name: "swipe", description: "Swipe between bounded device coordinates from the current Simulator screen map.", readOnly: false },
  { name: "drag_on_simulator", description: "Drag between two elements in the current Simulator screen map.", readOnly: false },
  { name: "long_press", description: "Long-press an element in the current Simulator screen map.", readOnly: false },
  { name: "press_simulator_key", description: "Send one supported WebDriver key to the focused Simulator control.", readOnly: false },
  { name: "batch", description: "Run up to 16 fenced Simulator UI actions and return a final observation.", readOnly: false },
  { name: "type_simulator_text", description: "Type bounded text into the focused control inside the Simulator.", readOnly: false },
  { name: "press_home", description: "Press the simulated Home button from the current Simulator screen map.", readOnly: false }
] as const);

const STATE_TOOLS = Object.freeze([
  { name: "set_orientation", description: "Rotate the current Simulator device after validating its screen snapshot.", readOnly: false },
  { name: "set_appearance", description: "Set the simulated system appearance to light or dark.", readOnly: false },
  { name: "set_increase_contrast", description: "Enable or disable the simulated Increase Contrast setting.", readOnly: false },
  { name: "set_content_size", description: "Set the simulated Dynamic Type content-size category.", readOnly: false },
  { name: "set_location", description: "Set one bounded simulated latitude and longitude.", readOnly: false },
  { name: "start_location_route", description: "Start a bounded simulated route through explicit waypoints.", readOnly: false },
  { name: "clear_location", description: "Clear the simulated location or active route.", readOnly: false },
  { name: "set_privacy", description: "Grant, revoke or reset one simulated app privacy permission.", readOnly: false },
  { name: "set_status_bar", description: "Apply bounded deterministic Simulator status-bar overrides.", readOnly: false },
  { name: "clear_status_bar", description: "Clear all Simulator status-bar overrides.", readOnly: false },
  { name: "push_notification", description: "Send one bounded APNs payload to an installed app on the exact Simulator.", readOnly: false },
  { name: "lock_screen", description: "Lock the exact Simulator after validating its screen snapshot.", readOnly: false },
  { name: "unlock_screen", description: "Unlock the exact Simulator after validating its screen snapshot.", readOnly: false }
] as const);

function bridgeTools(control: boolean, screen: boolean, input: boolean,
  stateControl: boolean, projectBuild: boolean, appInstall: boolean,
  appControl: boolean): readonly McpToolDescriptor[] {
  const tools: McpToolDescriptor[] = [{
    serverId: IOS_SIMULATOR_TOOL_PROVIDER_ID,
    name: "list_tools",
    description: "Discover task-local iOS Simulator tools. Start with doctor or check_environment before selecting a device.",
    inputSchema: { type: "object", properties: { category: { type: "string", enum: [CATEGORY] } }, additionalProperties: false },
    requiresPermission: false
  }, {
    serverId: IOS_SIMULATOR_TOOL_PROVIDER_ID,
    name: "call_tool",
    description: "Call one validated read-only task-local iOS Simulator tool.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", enum: [...TOOLS, ...(projectBuild ? BUILD_READ_TOOLS : [])].map(tool => tool.name) },
      args: { type: "object", additionalProperties: true }
    }, required: ["name", "args"], additionalProperties: false },
    requiresPermission: false
  }];
  if (control || screen || input || stateControl || projectBuild || appInstall || appControl) tools.push({
    serverId: IOS_SIMULATOR_TOOL_PROVIDER_ID,
    name: "control_tool",
    description: "Call one validated task-local iOS Simulator control or screen observation with the current task's permission.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", enum: [...(control ? CONTROL_TOOLS : []),
        ...(screen ? OBSERVATION_TOOLS : []), ...(input ? INPUT_TOOLS : []),
        ...(stateControl ? STATE_TOOLS : []), ...(projectBuild ? BUILD_TOOLS : []),
        ...(appInstall ? INSTALL_TOOLS : []), ...(appControl ? APP_CONTROL_TOOLS : [])].map(tool => tool.name) },
      args: { type: "object", additionalProperties: true }
    }, required: ["name", "args"], additionalProperties: false },
    requiresPermission: true
  });
  return Object.freeze(tools);
}

export class IosSimulatorToolBridgeProvider implements BridgeToolProvider {
  readonly id = IOS_SIMULATOR_TOOL_PROVIDER_ID;
  readonly generation = 1;
  readonly available = true;
  readonly tools: readonly McpToolDescriptor[];
  readonly configurablePolicy = Object.freeze({
    id: "joko-ios-simulator-tools-policy",
    displayName: "iOS Simulator tools",
    description: "Inspect and control task-owned local iOS Simulator instances with explicit permission.",
    productDefaultEnabled: true
  });
  readonly #store: Pick<OperationalStore, "getSession" | "getTarget">;
  readonly #runtime: SimulatorEnvironmentRuntime;
  readonly #ownership: SimulatorOwnershipRegistry;
  readonly #control: SimulatorInstanceControlCoordinator | undefined;
  readonly #screen: SimulatorScreenObservationCoordinator | undefined;
  readonly #input: SimulatorInputCoordinator | undefined;
  readonly #stateControl: SimulatorStateControlCoordinator | undefined;
  readonly #projectBuild: SimulatorProjectBuildCoordinator | undefined;
  readonly #appInstall: SimulatorAppInstallCoordinator | undefined;
  readonly #appControl: SimulatorAppControlCoordinator | undefined;
  readonly #memoryProbe: (signal?: AbortSignal) => Promise<SimulatorMemorySnapshot>;

  constructor(options: {
    readonly store: Pick<OperationalStore, "getSession" | "getTarget">;
    readonly ownership: SimulatorOwnershipRegistry;
    readonly control?: SimulatorInstanceControlCoordinator;
    readonly screen?: SimulatorScreenObservationCoordinator;
    readonly input?: SimulatorInputCoordinator;
    readonly stateControl?: SimulatorStateControlCoordinator;
    readonly projectBuild?: SimulatorProjectBuildCoordinator;
    readonly appInstall?: SimulatorAppInstallCoordinator;
    readonly appControl?: SimulatorAppControlCoordinator;
    readonly runtime?: SimulatorEnvironmentRuntime;
    readonly memoryProbe?: (signal?: AbortSignal) => Promise<SimulatorMemorySnapshot>;
  }) {
    this.#store = options.store;
    this.#ownership = options.ownership;
    this.#control = options.control;
    this.#screen = options.screen;
    this.#input = options.input;
    this.#stateControl = options.stateControl;
    this.#projectBuild = options.projectBuild;
    this.#appInstall = options.appInstall;
    this.#appControl = options.appControl;
    this.tools = bridgeTools(options.control !== undefined, options.screen !== undefined,
      options.input !== undefined, options.stateControl !== undefined,
      options.projectBuild !== undefined, options.appInstall !== undefined,
      options.appControl !== undefined);
    this.#runtime = options.runtime ?? createSimulatorEnvironmentRuntime();
    this.#memoryProbe = options.memoryProbe ?? (signal => collectSimulatorMemorySnapshot({ signal }));
  }

  includeForTarget(targetId: string): boolean {
    try {
      const target = this.#store.getTarget(targetId).descriptor;
      return target.trusted && target.remoteWorkspace === undefined;
    } catch { return false; }
  }

  async callTool(name: string, arguments_: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, context: BridgeToolCallContext): Promise<McpCallResult> {
    try {
      signal?.throwIfAborted();
      this.#requireScope(context);
      if (name === "list_tools") {
        onlyKeys(arguments_, ["category"]);
        if (arguments_["category"] !== undefined && arguments_["category"] !== CATEGORY) throw new SimulatorToolError("INVALID_ARGUMENT", "Unknown Simulator tool category.");
        const tools = [...TOOLS, ...(this.#projectBuild ? BUILD_READ_TOOLS : []),
          ...(this.#control ? CONTROL_TOOLS : []),
          ...(this.#screen ? OBSERVATION_TOOLS : []), ...(this.#input ? INPUT_TOOLS : []),
          ...(this.#stateControl ? STATE_TOOLS : []), ...(this.#projectBuild ? BUILD_TOOLS : []),
          ...(this.#appInstall ? INSTALL_TOOLS : []),
          ...(this.#appControl ? APP_CONTROL_TOOLS : [])]
          .map(tool => ({ name: tool.name, category: CATEGORY, description: tool.description,
            readOnly: tool.readOnly, via: [...TOOLS, ...BUILD_READ_TOOLS].some(item => item.name === tool.name)
              ? "call_tool" : "control_tool" }));
        return response(arguments_["category"] === CATEGORY
          ? { ok: true, category: CATEGORY, tools, workflow: "Call doctor or check_environment, then list_simulator_devices. Use exact UDIDs for later instance actions." }
          : { ok: true, categories: [{ name: CATEGORY, tool_count: tools.length }], hint: "Call list_tools with category ios_simulator to discover actions." }, false);
      }
      if (name !== "call_tool" &&
          (name !== "control_tool" || !this.#control && !this.#screen && !this.#input &&
            !this.#stateControl && !this.#projectBuild && !this.#appInstall && !this.#appControl)) {
        throw new SimulatorToolError("UNKNOWN_TOOL", "Simulator bridge tool is unavailable.");
      }
      onlyKeys(arguments_, ["name", "args"]);
      const selected = arguments_["name"];
      const args = arguments_["args"];
      const available = name === "call_tool" ? [...TOOLS, ...(this.#projectBuild ? BUILD_READ_TOOLS : [])] : [
        ...(this.#control ? CONTROL_TOOLS : []), ...(this.#screen ? OBSERVATION_TOOLS : []),
        ...(this.#input ? INPUT_TOOLS : []), ...(this.#stateControl ? STATE_TOOLS : []),
        ...(this.#projectBuild ? BUILD_TOOLS : []), ...(this.#appInstall ? INSTALL_TOOLS : []),
        ...(this.#appControl ? APP_CONTROL_TOOLS : []) ];
      if (typeof selected !== "string" || !available.some(tool => tool.name === selected)) {
        throw new SimulatorToolError("UNKNOWN_TOOL", "Simulator tool is unavailable in this runtime.");
      }
      if (!isRecord(args)) throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator tool arguments must be an object.");
      if (name === "control_tool") {
        if (OBSERVATION_TOOLS.some(tool => tool.name === selected)) {
          return await this.#callScreenObservation(selected, args, signal, context);
        }
        if (INPUT_TOOLS.some(tool => tool.name === selected)) {
          return await this.#callInput(selected, args, signal, context);
        }
        if (STATE_TOOLS.some(tool => tool.name === selected)) {
          return await this.#callStateControl(selected, args, signal, context);
        }
        if (selected === "build_app") return await this.#callProjectBuild(args, signal, context);
        if (selected === "install_app") return await this.#callAppInstall(args, signal, context);
        if (selected === "launch_app" || selected === "terminate_app") {
          return await this.#callAppControl(selected, args, signal, context);
        }
        return await this.#callInstanceControl(selected, args, signal, context);
      }
      if (selected === "read_build_diagnostics") {
        if (!this.#projectBuild) throw new SimulatorToolError("UNKNOWN_TOOL", "Simulator build diagnostics are unavailable.");
        onlyKeys(args, ["diagnosticsId", "source", "offset", "limit"]);
        const diagnosticsId = args["diagnosticsId"];
        const source = args["source"];
        if (typeof diagnosticsId !== "string" || !UUID.test(diagnosticsId) ||
            source !== "build-log" && source !== "xcresult") {
          throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator build diagnostics request is invalid.");
        }
        const offset = optionalInteger(args["offset"], 0, Number.MAX_SAFE_INTEGER, 0);
        const limit = optionalInteger(args["limit"], 1, 65_536, 16_384);
        const result = await this.#projectBuild.readDiagnostics(context, diagnosticsId, source, offset, limit);
        this.#requireScope(context);
        return response({ ok: true, data: result }, false);
      }
      if (Object.keys(args).length !== 0) throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator tool arguments must be an empty object.");
      if (selected === "list_instances") {
        const instances = this.#ownership.listForTask(context);
        signal?.throwIfAborted();
        this.#requireScope(context);
        return response({ ok: true, data: { instances } }, false);
      }
      const environment = await this.#runtime.inspect(signal);
      signal?.throwIfAborted();
      this.#requireScope(context);
      if (selected === "check_environment") return response({ ok: true, data: environment }, false);
      if (selected === "doctor") {
        const instances = this.#ownership.listForTask(context);
        const resources = await this.#diagnoseResources(environment, signal, context);
        signal?.throwIfAborted();
        this.#requireScope(context);
        const controlAvailable = this.#control !== undefined && environment.ready;
        const instanceAvailable = controlAvailable && instances.length > 0;
        const readyScreen = this.#screen !== undefined && environment.ready &&
          this.#control?.diagnoseDrivers(instances).some(driver => driver.state === "ready") === true;
        const screenAvailability = this.#screen === undefined ? {} : Object.fromEntries(
          OBSERVATION_TOOLS.map(tool => [tool.name, readyScreen
            ? { state: "available", backend: "wda" }
            : { state: "unavailable", reasonCode: environment.ready
              ? "DRIVER_RUNTIME_LOST" : environment.issue ?? "ENVIRONMENT_NOT_READY" }])
        );
        const inputAvailability = this.#input === undefined ? {} : Object.fromEntries(
          INPUT_TOOLS.map(tool => [tool.name, readyScreen
            ? { state: "available", backend: "wda" }
            : { state: "unavailable", reasonCode: environment.ready
              ? "DRIVER_RUNTIME_LOST" : environment.issue ?? "ENVIRONMENT_NOT_READY" }])
        );
        const stateAvailability = this.#stateControl === undefined ? {} : Object.fromEntries(
          STATE_TOOLS.map(tool => [tool.name, readyScreen
            ? { state: "available", backend: tool.name === "set_orientation" ||
                tool.name === "lock_screen" || tool.name === "unlock_screen" ? "wda" : "simctl" }
            : { state: "unavailable", reasonCode: environment.ready
              ? "DRIVER_RUNTIME_LOST" : environment.issue ?? "ENVIRONMENT_NOT_READY" }])
        );
        const buildAvailability = this.#projectBuild === undefined ? {} : {
          build_app: environment.ready && instances.some(instance => instance.lifecycleState === "ready")
            ? { state: "available", backend: "xcodebuild" }
            : { state: "unavailable", reasonCode: environment.ready ? "INSTANCE_REQUIRED" : environment.issue ?? "ENVIRONMENT_NOT_READY" },
          read_build_diagnostics: { state: "available", backend: "host" }
        };
        const installAvailability = this.#appInstall === undefined ? {} : {
          install_app: environment.ready && instances.some(instance =>
            instance.lifecycleState === "ready" && instance.viewerState === "attached")
            ? { state: "available", backend: "simctl" }
            : { state: "unavailable", reasonCode: environment.ready
              ? "INSTANCE_REQUIRED" : environment.issue ?? "ENVIRONMENT_NOT_READY" }
        };
        const appControlAvailability = this.#appControl === undefined ? {} : Object.fromEntries(
          APP_CONTROL_TOOLS.map(tool => [tool.name, environment.ready &&
            instances.some(instance => instance.lifecycleState === "ready" && instance.viewerState === "attached")
            ? { state: "available", backend: "simctl" }
            : { state: "unavailable", reasonCode: environment.ready
              ? "INSTANCE_REQUIRED" : environment.issue ?? "ENVIRONMENT_NOT_READY" }])
        );
        const controlAvailability = this.#control === undefined ? {} : {
          create_instance: controlAvailable ? { state: "available", backend: "simctl" }
            : { state: "unavailable", reasonCode: environment.issue ?? "ENVIRONMENT_NOT_READY" },
          attach_device: controlAvailable ? { state: "available", backend: "simctl" }
            : { state: "unavailable", reasonCode: environment.issue ?? "ENVIRONMENT_NOT_READY" },
          start_instance: instanceAvailable ? { state: "available", backend: "simctl" }
            : { state: "unavailable", reasonCode: controlAvailable ? "INSTANCE_REQUIRED" : environment.issue ?? "ENVIRONMENT_NOT_READY" },
          stop_instance: instanceAvailable ? { state: "available", backend: "simctl" }
            : { state: "unavailable", reasonCode: controlAvailable ? "INSTANCE_REQUIRED" : environment.issue ?? "ENVIRONMENT_NOT_READY" },
          detach_device: instanceAvailable ? { state: "available", backend: "host" }
            : { state: "unavailable", reasonCode: controlAvailable ? "INSTANCE_REQUIRED" : environment.issue ?? "ENVIRONMENT_NOT_READY" }
        };
        return response({ ok: true, data: {
          environment,
          availability: {
            check_environment: { state: "available", backend: "host" },
            doctor: { state: "available", backend: "host" },
            list_simulator_devices: environment.ready
              ? { state: "available", backend: "simctl" }
              : { state: "unavailable", reasonCode: environment.issue ?? "ENVIRONMENT_NOT_READY" },
            list_instances: { state: "available", backend: "host" },
            ...controlAvailability, ...screenAvailability, ...inputAvailability, ...stateAvailability,
            ...buildAvailability, ...installAvailability, ...appControlAvailability
          },
          instances, resources,
          instanceControl: controlAvailable ? { state: "available" }
            : { state: "unavailable", reasonCode: this.#control === undefined
              ? "INSTANCE_CONTROL_UNAVAILABLE" : environment.issue ?? "ENVIRONMENT_NOT_READY" },
          drivers: controlAvailable ? { state: "available", instances: this.#control!.diagnoseDrivers(instances) }
            : { state: "unavailable", reasonCode: this.#control === undefined
              ? "INSTANCE_DRIVER_UNAVAILABLE" : environment.issue ?? "ENVIRONMENT_NOT_READY" },
          recommendedActions: environment.ready ? this.#control === undefined ? ["list_simulator_devices"]
            : instances.length === 0 ? ["list_simulator_devices", "create_instance", "attach_device"]
              : readyScreen ? ["get_screen_map"] : ["start_instance"] : ["check_environment"]
        } }, false);
      }
      if (!environment.ready) return response({ ok: false, errorCode: environment.issue, message: environment.error, data: { environment } }, true);
      return response({ ok: true, data: { devices: environment.devices, xcodeVersion: environment.xcodeVersion } }, false);
    } catch (error) {
      const known = error instanceof SimulatorToolError || error instanceof SimulatorOwnershipError ||
        error instanceof SimulatorInstanceControlError || error instanceof SimulatorCreateError ||
        error instanceof SimulatorLifecycleError || error instanceof SimulatorResourceError ||
        error instanceof SimulatorDriverError || error instanceof SimulatorObservationError ||
        error instanceof SimulatorInputError || error instanceof SimulatorStateControlError ||
        error instanceof SimulatorAppBuildError || error instanceof SimulatorAppInstallError ||
        error instanceof SimulatorAppControlError ||
        error instanceof SimulatorScreenMapError ||
        error instanceof WdaClientError;
      const code = known ? error.code : error instanceof OperationInProgressError
        ? "MUTATION_IN_PROGRESS" : signal?.aborted ? "PROBE_ABORTED" : "SIMULATOR_HOST_ERROR";
      const message = known ? error.message : error instanceof OperationInProgressError
        ? "Simulator operation is already in progress." : signal?.aborted ? "Simulator probe was cancelled." : "Simulator host call failed.";
      return response({ ok: false, errorCode: code, message,
        ...(error instanceof SimulatorAppBuildError && error.diagnostics
          ? { data: { diagnostics: error.diagnostics } } : {}) }, true);
    }
  }

  async #callInstanceControl(name: string, args: Record<string, unknown>, signal: AbortSignal | undefined,
    context: BridgeToolCallContext): Promise<McpCallResult> {
    if (!this.#control) throw new SimulatorToolError("UNKNOWN_TOOL", "Simulator instance control is unavailable.");
    const authority = { effectIdentity: context.effectIdentity, requestBodyHash: context.requestBodyHash,
      providerGeneration: context.providerGeneration };
    if (!DIGEST.test(authority.effectIdentity ?? "") || !BODY_HASH.test(authority.requestBodyHash ?? "") ||
        !Number.isSafeInteger(authority.providerGeneration) || (authority.providerGeneration ?? 0) < 1) {
      throw new SimulatorToolError("STALE_SCOPE", "Simulator mutation authority is unavailable.");
    }
    const verified = { effectIdentity: authority.effectIdentity!, requestBodyHash: authority.requestBodyHash!,
      providerGeneration: authority.providerGeneration! };
    let execute: () => Promise<SimulatorInstanceControlExecution>;
    if (name === "create_instance") {
      onlyKeys(args, ["templateUdid", "name"]);
      const templateUdid = requiredUuid(args["templateUdid"]);
      const instanceName = requiredName(args["name"]);
      execute = () => this.#control!.create(context, { templateUdid, name: instanceName }, verified, signal);
    } else if (name === "attach_device") {
      onlyKeys(args, ["udid"]);
      const udid = requiredUuid(args["udid"]);
      execute = () => this.#control!.attach(context, udid, verified, signal);
    } else {
      onlyKeys(args, ["instanceId", "generation", "leaseId"]);
      const route = requiredRoute(args);
      if (name === "start_instance") execute = () => this.#control!.start(context, route, verified, signal);
      else if (name === "stop_instance") execute = () => this.#control!.stop(context, route, verified, signal);
      else if (name === "detach_device") execute = () => this.#control!.detach(context, route, verified, signal);
      else throw new SimulatorToolError("UNKNOWN_TOOL", "Simulator instance control is unavailable.");
    }
    const environment = await this.#runtime.inspect(signal);
    signal?.throwIfAborted();
    this.#requireScope(context);
    if (!environment.ready) return response({ ok: false, errorCode: environment.issue,
      message: environment.error, data: { environment } }, true);
    const result = await execute();
    this.#screen?.clear(result.instance.instanceId);
    this.#requireScope(context);
    return response({ ok: true, data: { instance: result.instance, replayed: result.replayed } }, false);
  }

  async #callScreenObservation(name: string, args: Record<string, unknown>,
    signal: AbortSignal | undefined, context: BridgeToolCallContext): Promise<McpCallResult> {
    if (!this.#screen) throw new SimulatorToolError("UNKNOWN_TOOL", "Simulator screen observation is unavailable.");
    const route = requiredRoute(args);
    let observe: () => Promise<unknown>;
    if (name === "get_screen_map") {
      onlyKeys(args, ["instanceId", "generation", "leaseId"]);
      observe = () => this.#screen!.screenMap(context, route, signal);
    } else if (name === "audit_accessibility") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "maxViolations"]);
      const maxViolations = optionalInteger(args["maxViolations"], 1, 500, 200);
      observe = () => this.#screen!.audit(context, route, maxViolations, signal);
    } else if (name === "compare_screen_maps") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "baseline", "maxChanges"]);
      const baseline = requiredScreenMap(args["baseline"]);
      const maxChanges = optionalInteger(args["maxChanges"], 1, 500, 200);
      observe = () => this.#screen!.compare(context, route, baseline, maxChanges, signal);
    } else if (name === "wait_for_ui") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "condition",
        "timeoutMs", "pollIntervalMs", "stableForMs"]);
      const condition = requiredWaitCondition(args["condition"]);
      const options = {
        timeoutMs: optionalInteger(args["timeoutMs"], 100, 30_000, 10_000),
        pollIntervalMs: optionalInteger(args["pollIntervalMs"], 100, 2_000, 250),
        stableForMs: optionalInteger(args["stableForMs"], 100, 2_000, 300)
      };
      observe = () => this.#screen!.wait(context, route, condition, options, signal);
    } else throw new SimulatorToolError("UNKNOWN_TOOL", "Simulator screen observation is unavailable.");
    const environment = await this.#runtime.inspect(signal);
    signal?.throwIfAborted();
    this.#requireScope(context);
    if (!environment.ready) return response({ ok: false, errorCode: environment.issue,
      message: environment.error, data: { environment } }, true);
    const data = await observe();
    if (signal?.aborted) throw new SimulatorObservationError("OBSERVATION_CANCELLED", "Simulator observation was cancelled.");
    this.#requireScope(context);
    return response({ ok: true, data: data as Readonly<Record<string, unknown>> }, false);
  }

  async #callInput(name: string, args: Record<string, unknown>, signal: AbortSignal | undefined,
    context: BridgeToolCallContext): Promise<McpCallResult> {
    if (!this.#input) throw new SimulatorToolError("UNKNOWN_TOOL", "Simulator input is unavailable.");
    const authority = { effectIdentity: context.effectIdentity, requestBodyHash: context.requestBodyHash,
      providerGeneration: context.providerGeneration };
    if (!DIGEST.test(authority.effectIdentity ?? "") || !BODY_HASH.test(authority.requestBodyHash ?? "") ||
        !Number.isSafeInteger(authority.providerGeneration) || (authority.providerGeneration ?? 0) < 1) {
      throw new SimulatorToolError("STALE_SCOPE", "Simulator mutation authority is unavailable.");
    }
    const route = requiredRoute(args);
    const snapshotId = requiredSnapshotId(args["snapshotId"]);
    const observe = requiredObserveOptions(args, name === "batch" ? "stable" : "none");
    let action: SimulatorInputAction;
    if (name === "tap") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "snapshotId", "elementId", "x", "y",
        "observeAfter", "observeTimeoutMs", "stableForMs"]);
      const elementId = args["elementId"];
      const hasCoordinates = args["x"] !== undefined || args["y"] !== undefined;
      if (elementId !== undefined) {
        if (!boundedText(elementId, 128) || hasCoordinates) {
          throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator tap target is invalid.");
        }
        action = { type: "tap", snapshotId, target: { elementId } };
      } else {
        action = { type: "tap", snapshotId, target: {
          x: requiredCoordinate(args["x"]), y: requiredCoordinate(args["y"])
        } };
      }
    } else if (name === "swipe") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "snapshotId", "startX", "startY",
        "endX", "endY", "durationMs", "observeAfter", "observeTimeoutMs", "stableForMs"]);
      action = { type: "swipe", snapshotId,
        start: { x: requiredCoordinate(args["startX"]), y: requiredCoordinate(args["startY"]) },
        end: { x: requiredCoordinate(args["endX"]), y: requiredCoordinate(args["endY"]) },
        durationMs: optionalInteger(args["durationMs"], 50, 60_000, 300) };
    } else if (name === "drag_on_simulator") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "snapshotId", "fromElementId",
        "toElementId", "durationMs", "observeAfter", "observeTimeoutMs", "stableForMs"]);
      action = { type: "drag", snapshotId,
        fromElementId: requiredElementId(args["fromElementId"]),
        toElementId: requiredElementId(args["toElementId"]),
        durationMs: optionalInteger(args["durationMs"], 100, 10_000, 500) };
    } else if (name === "long_press") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "snapshotId", "elementId",
        "durationMs", "observeAfter", "observeTimeoutMs", "stableForMs"]);
      action = { type: "long_press", snapshotId,
        elementId: requiredElementId(args["elementId"]),
        durationMs: optionalInteger(args["durationMs"], 300, 10_000, 750) };
    } else if (name === "press_simulator_key") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "snapshotId", "key",
        "observeAfter", "observeTimeoutMs", "stableForMs"]);
      action = { type: "key_press", snapshotId, key: requiredInputKey(args["key"]) };
    } else if (name === "batch") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "snapshotId", "actions",
        "observeAfter", "observeTimeoutMs", "stableForMs"]);
      if (observe.mode === "none") {
        throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator batch requires a final observation.");
      }
      action = { type: "batch", snapshotId, actions: requiredBatchActions(args["actions"]) };
    } else if (name === "type_simulator_text") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "snapshotId", "text",
        "observeAfter", "observeTimeoutMs", "stableForMs"]);
      if (typeof args["text"] !== "string" || args["text"].length > 10_000) {
        throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator text input exceeds its limit.");
      }
      action = { type: "type_text", snapshotId, text: args["text"] };
    } else if (name === "press_home") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "snapshotId",
        "observeAfter", "observeTimeoutMs", "stableForMs"]);
      action = { type: "press_home", snapshotId };
    } else {
      throw new SimulatorToolError("UNKNOWN_TOOL", "Simulator input is unavailable.");
    }
    const environment = await this.#runtime.inspect(signal);
    signal?.throwIfAborted();
    this.#requireScope(context);
    if (!environment.ready) return response({ ok: false, errorCode: environment.issue,
      message: environment.error, data: { environment } }, true);
    const result = await this.#input.execute(context, route, action, observe, {
      effectIdentity: authority.effectIdentity!, requestBodyHash: authority.requestBodyHash!,
      providerGeneration: authority.providerGeneration!
    }, signal);
    this.#requireScope(context);
    return response({ ok: true, data: { ...result.receipt, replayed: result.replayed,
      screenMapInvalidated: result.observation === null,
      observation: result.observation, observationError: result.observationError } }, false);
  }

  async #callStateControl(name: string, args: Record<string, unknown>,
    signal: AbortSignal | undefined, context: BridgeToolCallContext): Promise<McpCallResult> {
    if (!this.#stateControl) {
      throw new SimulatorToolError("UNKNOWN_TOOL", "Simulator state control is unavailable.");
    }
    const authority = { effectIdentity: context.effectIdentity, requestBodyHash: context.requestBodyHash,
      providerGeneration: context.providerGeneration };
    if (!DIGEST.test(authority.effectIdentity ?? "") || !BODY_HASH.test(authority.requestBodyHash ?? "") ||
        !Number.isSafeInteger(authority.providerGeneration) || (authority.providerGeneration ?? 0) < 1) {
      throw new SimulatorToolError("STALE_SCOPE", "Simulator mutation authority is unavailable.");
    }
    const route = requiredRoute(args);
    let action: SimulatorStateControlAction;
    if (name === "set_orientation") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "snapshotId", "orientation"]);
      const orientation = args["orientation"];
      if (orientation !== "PORTRAIT" && orientation !== "LANDSCAPE") {
        throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator orientation is invalid.");
      }
      action = { type: "set_orientation", snapshotId: requiredSnapshotId(args["snapshotId"]),
        orientation };
    } else if (name === "set_appearance") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "appearance"]);
      const appearance = args["appearance"];
      if (appearance !== "light" && appearance !== "dark") {
        throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator appearance is invalid.");
      }
      action = { type: "set_appearance", appearance };
    } else if (name === "set_increase_contrast") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "enabled"]);
      if (typeof args["enabled"] !== "boolean") {
        throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator contrast setting is invalid.");
      }
      action = { type: "set_increase_contrast", enabled: args["enabled"] };
    } else if (name === "set_content_size") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "contentSize"]);
      const contentSize = args["contentSize"];
      if (!isContentSize(contentSize)) {
        throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator content size is invalid.");
      }
      action = { type: "set_content_size", contentSize };
    } else if (name === "set_location") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "latitude", "longitude"]);
      action = { type: "set_location",
        latitude: requiredBoundedFinite(args["latitude"], -90, 90, "latitude"),
        longitude: requiredBoundedFinite(args["longitude"], -180, 180, "longitude") };
    } else if (name === "start_location_route") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "waypoints",
        "speedMetersPerSecond", "intervalSeconds", "distanceMeters"]);
      const speedMetersPerSecond = optionalPositiveFinite(args["speedMetersPerSecond"],
        10_000, "speedMetersPerSecond");
      const intervalSeconds = optionalPositiveFinite(args["intervalSeconds"],
        86_400, "intervalSeconds");
      const distanceMeters = optionalPositiveFinite(args["distanceMeters"],
        10_000_000, "distanceMeters");
      if (intervalSeconds !== undefined && distanceMeters !== undefined) {
        throw new SimulatorToolError("INVALID_ARGUMENT",
          "Simulator location route interval and distance are mutually exclusive.");
      }
      action = { type: "start_location_route", waypoints: requiredLocationWaypoints(args["waypoints"]),
        ...(speedMetersPerSecond === undefined ? {} : { speedMetersPerSecond }),
        ...(intervalSeconds === undefined ? {} : { intervalSeconds }),
        ...(distanceMeters === undefined ? {} : { distanceMeters }) };
    } else if (name === "clear_location") {
      onlyKeys(args, ["instanceId", "generation", "leaseId"]);
      action = { type: "clear_location" };
    } else if (name === "set_privacy") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "action", "service", "bundleId"]);
      const privacyAction = args["action"];
      if (privacyAction !== "grant" && privacyAction !== "revoke" && privacyAction !== "reset" ||
          typeof args["service"] !== "string" || !PRIVACY_SERVICE.test(args["service"])) {
        throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator privacy control is invalid.");
      }
      const bundleId = args["bundleId"];
      if (bundleId !== undefined && (typeof bundleId !== "string" || !BUNDLE_ID.test(bundleId)) ||
          privacyAction !== "reset" && bundleId === undefined) {
        throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator privacy bundle identity is invalid.");
      }
      action = { type: "set_privacy", action: privacyAction, service: args["service"],
        ...(bundleId === undefined ? {} : { bundleId }) };
    } else if (name === "set_status_bar") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "time", "dataNetwork",
        "wifiMode", "wifiBars", "cellularMode", "cellularBars", "operatorName",
        "batteryState", "batteryLevel"]);
      action = { type: "set_status_bar", overrides: requiredStatusBarOverrides(args) };
    } else if (name === "clear_status_bar") {
      onlyKeys(args, ["instanceId", "generation", "leaseId"]);
      action = { type: "clear_status_bar" };
    } else if (name === "push_notification") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "bundleId", "payload"]);
      const bundleId = args["bundleId"];
      if (typeof bundleId !== "string" || !BUNDLE_ID.test(bundleId)) {
        throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator push bundle identity is invalid.");
      }
      const payload = args["payload"];
      try { serializeSimulatorPushPayload(payload); }
      catch { throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator push payload is invalid."); }
      action = { type: "push_notification", bundleId,
        payload: payload as Readonly<Record<string, unknown>> };
    } else if (name === "lock_screen" || name === "unlock_screen") {
      onlyKeys(args, ["instanceId", "generation", "leaseId", "snapshotId"]);
      action = { type: name, snapshotId: requiredSnapshotId(args["snapshotId"]) };
    } else {
      throw new SimulatorToolError("UNKNOWN_TOOL", "Simulator state control is unavailable.");
    }
    const environment = await this.#runtime.inspect(signal);
    signal?.throwIfAborted();
    this.#requireScope(context);
    if (!environment.ready) return response({ ok: false, errorCode: environment.issue,
      message: environment.error, data: { environment } }, true);
    const result = await this.#stateControl.execute(context, route, action, {
      effectIdentity: authority.effectIdentity!, requestBodyHash: authority.requestBodyHash!,
      providerGeneration: authority.providerGeneration!
    }, signal);
    this.#requireScope(context);
    return response({ ok: true, data: { ...result.receipt, replayed: result.replayed,
      screenMapInvalidated: true } }, false);
  }

  async #callProjectBuild(args: Record<string, unknown>, signal: AbortSignal | undefined,
    context: BridgeToolCallContext): Promise<McpCallResult> {
    if (!this.#projectBuild) throw new SimulatorToolError("UNKNOWN_TOOL", "Simulator project build is unavailable.");
    onlyKeys(args, ["instanceId", "generation", "leaseId", "containerPath", "scheme"]);
    const route = requiredRoute(args);
    const containerPath = args["containerPath"];
    const scheme = args["scheme"];
    if (containerPath !== undefined && (typeof containerPath !== "string" ||
        !containerPath.trim() || containerPath.length > 4_096) ||
        scheme !== undefined && (typeof scheme !== "string" || !scheme.trim() || scheme.length > 256)) {
      throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator project selection is invalid.");
    }
    const authority = { effectIdentity: context.effectIdentity, requestBodyHash: context.requestBodyHash,
      providerGeneration: context.providerGeneration };
    if (!DIGEST.test(authority.effectIdentity ?? "") || !BODY_HASH.test(authority.requestBodyHash ?? "") ||
        !Number.isSafeInteger(authority.providerGeneration) || (authority.providerGeneration ?? 0) < 1) {
      throw new SimulatorToolError("STALE_SCOPE", "Simulator mutation authority is unavailable.");
    }
    const environment = await this.#runtime.inspect(signal);
    signal?.throwIfAborted();
    this.#requireScope(context);
    if (!environment.ready) return response({ ok: false, errorCode: environment.issue,
      message: environment.error, data: { environment } }, true);
    const result = await this.#projectBuild.execute(context, route,
      { ...(containerPath === undefined ? {} : { containerPath: containerPath as string }),
        ...(scheme === undefined ? {} : { scheme: scheme as string }) },
      { effectIdentity: authority.effectIdentity!, requestBodyHash: authority.requestBodyHash!,
        providerGeneration: authority.providerGeneration! }, signal);
    this.#requireScope(context);
    return response({ ok: true, data: { ...result.receipt, replayed: result.replayed } }, false);
  }

  async #callAppInstall(args: Record<string, unknown>, signal: AbortSignal | undefined,
    context: BridgeToolCallContext): Promise<McpCallResult> {
    if (!this.#appInstall) throw new SimulatorToolError("UNKNOWN_TOOL", "Simulator app installation is unavailable.");
    onlyKeys(args, ["instanceId", "generation", "leaseId", "artifactId"]);
    const route = requiredRoute(args);
    const artifactId = args["artifactId"];
    if (typeof artifactId !== "string" || !UUID.test(artifactId)) {
      throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator app artifact identity is invalid.");
    }
    const authority = { effectIdentity: context.effectIdentity, requestBodyHash: context.requestBodyHash,
      providerGeneration: context.providerGeneration };
    if (!DIGEST.test(authority.effectIdentity ?? "") || !BODY_HASH.test(authority.requestBodyHash ?? "") ||
        !Number.isSafeInteger(authority.providerGeneration) || (authority.providerGeneration ?? 0) < 1) {
      throw new SimulatorToolError("STALE_SCOPE", "Simulator mutation authority is unavailable.");
    }
    const environment = await this.#runtime.inspect(signal);
    signal?.throwIfAborted();
    this.#requireScope(context);
    if (!environment.ready) return response({ ok: false, errorCode: environment.issue,
      message: environment.error, data: { environment } }, true);
    const result = await this.#appInstall.execute(context, route, artifactId,
      { effectIdentity: authority.effectIdentity!, requestBodyHash: authority.requestBodyHash!,
        providerGeneration: authority.providerGeneration! }, signal);
    this.#requireScope(context);
    return response({ ok: true, data: { ...result.receipt, replayed: result.replayed } }, false);
  }

  async #callAppControl(name: "launch_app" | "terminate_app", args: Record<string, unknown>,
    signal: AbortSignal | undefined, context: BridgeToolCallContext): Promise<McpCallResult> {
    if (!this.#appControl) throw new SimulatorToolError("UNKNOWN_TOOL", "Simulator app control is unavailable.");
    onlyKeys(args, name === "launch_app"
      ? ["instanceId", "generation", "leaseId", "artifactId", "args"]
      : ["instanceId", "generation", "leaseId", "artifactId"]);
    const route = requiredRoute(args);
    const artifactId = args["artifactId"];
    if (typeof artifactId !== "string" || !UUID.test(artifactId)) {
      throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator app artifact identity is invalid.");
    }
    const launchArgs = args["args"] ?? [];
    if (name === "launch_app" && (!Array.isArray(launchArgs) || launchArgs.length > 64 ||
        launchArgs.some(arg => typeof arg !== "string" || arg.length > 4_096 || /\0/u.test(arg)))) {
      throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator app launch arguments are invalid.");
    }
    const authority = { effectIdentity: context.effectIdentity, requestBodyHash: context.requestBodyHash,
      providerGeneration: context.providerGeneration };
    if (!DIGEST.test(authority.effectIdentity ?? "") || !BODY_HASH.test(authority.requestBodyHash ?? "") ||
        !Number.isSafeInteger(authority.providerGeneration) || (authority.providerGeneration ?? 0) < 1) {
      throw new SimulatorToolError("STALE_SCOPE", "Simulator mutation authority is unavailable.");
    }
    const environment = await this.#runtime.inspect(signal);
    signal?.throwIfAborted();
    this.#requireScope(context);
    if (!environment.ready) return response({ ok: false, errorCode: environment.issue,
      message: environment.error, data: { environment } }, true);
    const action: SimulatorAppControlAction = name === "launch_app"
      ? { type: name, artifactId, args: launchArgs as string[] }
      : { type: name, artifactId };
    const result = await this.#appControl.execute(context, route, action,
      { effectIdentity: authority.effectIdentity!, requestBodyHash: authority.requestBodyHash!,
        providerGeneration: authority.providerGeneration! }, signal);
    this.#requireScope(context);
    return response({ ok: true, data: { ...result.receipt, replayed: result.replayed,
      screenMapInvalidated: true } }, false);
  }

  async #diagnoseResources(environment: SimulatorEnvironmentReport, signal: AbortSignal | undefined,
    context: BridgeToolCallContext): Promise<Readonly<Record<string, unknown>>> {
    if (!environment.ready) return { state: "unavailable", reasonCode: environment.issue ?? "ENVIRONMENT_NOT_READY" };
    try {
      const devices = new Map<string, string>();
      for (const device of environment.devices) {
        const udid = device.udid.toUpperCase();
        if (devices.has(udid)) throw new Error("Duplicate Simulator device identity.");
        devices.set(udid, device.state.toLowerCase());
      }
      const runningCount = this.#ownership.listForResourceAdmission()
        .filter(item => { const state = devices.get(item.simulatorUdid); return state !== undefined && state !== "shutdown"; }).length;
      const memory = await this.#memoryProbe(signal);
      signal?.throwIfAborted();
      this.#requireScope(context);
      const admission = assessSimulatorResourceAdmission({ runningCount, memory });
      return { state: "available", ...admission,
        memory: { source: memory.source, freePercentage: memory.freePercentage, freeBytes: memory.freeBytes } };
    } catch (error) {
      if (signal?.aborted) throw error;
      this.#requireScope(context);
      return { state: "unavailable", reasonCode: "RESOURCE_STATE_UNKNOWN" };
    }
  }

  #requireScope(context: BridgeToolCallContext): void {
    try {
      const session = this.#store.getSession(context.sessionId).descriptor;
      const target = this.#store.getTarget(context.targetId).descriptor;
      if (session.targetId !== context.targetId || session.backendId !== target.backendId
        || session.binding.generation !== context.generation || session.deletedAt !== undefined || session.archived
        || !target.trusted || target.remoteWorkspace !== undefined || session.remoteWorkspace !== undefined
        || (session.worktree !== undefined && session.worktree.state !== "active")) {
        throw new SimulatorToolError("STALE_SCOPE", "Simulator task scope is stale or unavailable.");
      }
    } catch {
      throw new SimulatorToolError("STALE_SCOPE", "Simulator task scope is stale or unavailable.");
    }
  }
}

class SimulatorToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new SimulatorToolError("INVALID_ARGUMENT", "Unsupported Simulator tool argument.");
}

function requiredUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator device identity is invalid.");
  }
  return value.toUpperCase();
}

function requiredName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || value.trim() !== value ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator name is invalid.");
  }
  return value;
}

function requiredRoute(value: Readonly<Record<string, unknown>>): {
  readonly instanceId: string; readonly generation: number; readonly leaseId: string } {
  if (typeof value["instanceId"] !== "string" || value["instanceId"].length < 1 ||
      value["instanceId"].length > 128 || value["instanceId"].trim() !== value["instanceId"] ||
      typeof value["leaseId"] !== "string" || value["leaseId"].length < 1 ||
      value["leaseId"].length > 128 || value["leaseId"].trim() !== value["leaseId"] ||
      !Number.isSafeInteger(value["generation"]) || Number(value["generation"]) < 1) {
    throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator instance route is invalid.");
  }
  return { instanceId: value["instanceId"], generation: Number(value["generation"]), leaseId: value["leaseId"] };
}

function optionalInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator observation bound is invalid.");
  }
  return value;
}

function requiredCoordinate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator input coordinate is invalid.");
  }
  return value;
}

function requiredBoundedFinite(value: unknown, minimum: number, maximum: number,
  label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new SimulatorToolError("INVALID_ARGUMENT", `Simulator ${label} is invalid.`);
  }
  return value;
}

function optionalPositiveFinite(value: unknown, maximum: number, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new SimulatorToolError("INVALID_ARGUMENT", `Simulator ${label} is invalid.`);
  }
  return value;
}

function requiredLocationWaypoints(value: unknown): readonly {
  readonly latitude: number; readonly longitude: number }[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 64) {
    throw new SimulatorToolError("INVALID_ARGUMENT",
      "Simulator location route must contain between 2 and 64 waypoints.");
  }
  return value.map((waypoint, index) => {
    if (!isRecord(waypoint)) {
      throw new SimulatorToolError("INVALID_ARGUMENT",
        `Simulator location waypoint ${index} is invalid.`);
    }
    onlyKeys(waypoint, ["latitude", "longitude"]);
    return {
      latitude: requiredBoundedFinite(waypoint["latitude"], -90, 90,
        `location waypoint ${index} latitude`),
      longitude: requiredBoundedFinite(waypoint["longitude"], -180, 180,
        `location waypoint ${index} longitude`)
    };
  });
}

function optionalEnum<T extends string>(value: unknown, values: readonly T[], label: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new SimulatorToolError("INVALID_ARGUMENT", `Simulator ${label} is invalid.`);
  }
  return value as T;
}

function optionalBoundedInteger(value: unknown, minimum: number, maximum: number,
  label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) ||
      value < minimum || value > maximum) {
    throw new SimulatorToolError("INVALID_ARGUMENT", `Simulator ${label} is invalid.`);
  }
  return value;
}

function requiredStatusBarOverrides(value: Readonly<Record<string, unknown>>): SimulatorStatusBarOverrides {
  const time = value["time"];
  if (time !== undefined && (typeof time !== "string" || !time.trim() ||
      time.length > 128 || /[\0\r\n]/u.test(time))) {
    throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator status-bar time is invalid.");
  }
  const operatorName = value["operatorName"];
  if (operatorName !== undefined && (typeof operatorName !== "string" ||
      operatorName.length > 128 || /[\0\r\n]/u.test(operatorName))) {
    throw new SimulatorToolError("INVALID_ARGUMENT",
      "Simulator status-bar operator name is invalid.");
  }
  const dataNetwork = optionalEnum(value["dataNetwork"], STATUS_BAR_DATA_NETWORKS,
    "status-bar data network");
  const wifiMode = optionalEnum(value["wifiMode"], STATUS_BAR_WIFI_MODES,
    "status-bar Wi-Fi mode");
  const cellularMode = optionalEnum(value["cellularMode"], STATUS_BAR_CELLULAR_MODES,
    "status-bar cellular mode");
  const batteryState = optionalEnum(value["batteryState"], STATUS_BAR_BATTERY_STATES,
    "status-bar battery state");
  const wifiBars = optionalBoundedInteger(value["wifiBars"], 0, 3, "status-bar Wi-Fi bars");
  const cellularBars = optionalBoundedInteger(value["cellularBars"], 0, 4,
    "status-bar cellular bars");
  const batteryLevel = optionalBoundedInteger(value["batteryLevel"], 0, 100,
    "status-bar battery level");
  const overrides = {
    ...(time === undefined ? {} : { time }),
    ...(dataNetwork === undefined ? {} : { dataNetwork }),
    ...(wifiMode === undefined ? {} : { wifiMode }),
    ...(wifiBars === undefined ? {} : { wifiBars }),
    ...(cellularMode === undefined ? {} : { cellularMode }),
    ...(cellularBars === undefined ? {} : { cellularBars }),
    ...(operatorName === undefined ? {} : { operatorName }),
    ...(batteryState === undefined ? {} : { batteryState }),
    ...(batteryLevel === undefined ? {} : { batteryLevel })
  } satisfies SimulatorStatusBarOverrides;
  if (Object.keys(overrides).length === 0) {
    throw new SimulatorToolError("INVALID_ARGUMENT",
      "At least one Simulator status-bar override is required.");
  }
  return overrides;
}

function requiredSnapshotId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator screen snapshot identity is invalid.");
  }
  return value;
}

function requiredObserveOptions(value: Readonly<Record<string, unknown>>,
  fallback: SimulatorInputObserveOptions["mode"]): SimulatorInputObserveOptions {
  const mode = value["observeAfter"] ?? fallback;
  if (mode !== "none" && mode !== "immediate" && mode !== "stable") {
    throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator post-input observation mode is invalid.");
  }
  return { mode,
    timeoutMs: optionalInteger(value["observeTimeoutMs"], 100, 15_000, 3_000),
    stableForMs: optionalInteger(value["stableForMs"], 100, 2_000, 300) };
}

function requiredElementId(value: unknown): string {
  if (!boundedText(value, 128) || value.trim() !== value) {
    throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator element identity is invalid.");
  }
  return value;
}

function requiredInputKey(value: unknown): SimulatorInputKey {
  if (typeof value !== "string" || !INPUT_KEYS.some(key => key === value)) {
    throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator key is unsupported.");
  }
  return value as SimulatorInputKey;
}

function isContentSize(value: unknown): value is (typeof CONTENT_SIZES)[number] {
  return typeof value === "string" && (CONTENT_SIZES as readonly string[]).includes(value);
}

function requiredBatchActions(value: unknown): readonly SimulatorBatchAction[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator batch must contain between 1 and 16 actions.");
  }
  return value.map(raw => {
    if (!isRecord(raw) || typeof raw["type"] !== "string") {
      throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator batch action is invalid.");
    }
    if (raw["type"] === "tap") {
      onlyKeys(raw, ["type", "elementId"]);
      return { type: "tap", elementId: requiredElementId(raw["elementId"]) };
    }
    if (raw["type"] === "swipe") {
      onlyKeys(raw, ["type", "startX", "startY", "endX", "endY", "durationMs"]);
      return { type: "swipe", start: { x: requiredCoordinate(raw["startX"]),
        y: requiredCoordinate(raw["startY"]) }, end: { x: requiredCoordinate(raw["endX"]),
        y: requiredCoordinate(raw["endY"]) },
        durationMs: optionalInteger(raw["durationMs"], 50, 10_000, 300) };
    }
    if (raw["type"] === "drag") {
      onlyKeys(raw, ["type", "fromElementId", "toElementId", "durationMs"]);
      return { type: "drag", fromElementId: requiredElementId(raw["fromElementId"]),
        toElementId: requiredElementId(raw["toElementId"]),
        durationMs: optionalInteger(raw["durationMs"], 100, 10_000, 500) };
    }
    if (raw["type"] === "long_press") {
      onlyKeys(raw, ["type", "elementId", "durationMs"]);
      return { type: "long_press", elementId: requiredElementId(raw["elementId"]),
        durationMs: optionalInteger(raw["durationMs"], 300, 10_000, 750) };
    }
    if (raw["type"] === "type_text") {
      onlyKeys(raw, ["type", "text"]);
      if (typeof raw["text"] !== "string" || raw["text"].length > 10_000) {
        throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator batch text exceeds its limit.");
      }
      return { type: "type_text", text: raw["text"] };
    }
    if (raw["type"] === "key_press") {
      onlyKeys(raw, ["type", "key"]);
      return { type: "key_press", key: requiredInputKey(raw["key"]) };
    }
    throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator batch action is unsupported.");
  });
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

function nullableText(value: unknown, max: number): boolean {
  return value === null || typeof value === "string" && value.length <= max;
}

function requiredScreenMap(value: unknown): SimulatorScreenMap {
  if (!isRecord(value)) throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator baseline is invalid.");
  onlyKeys(value, ["snapshotId", "instanceId", "generation", "interactionEpoch",
    "capturedAt", "truncated", "elements"]);
  if (typeof value["snapshotId"] !== "string" || !UUID.test(value["snapshotId"]) ||
      !boundedText(value["instanceId"], 128) ||
      !Number.isSafeInteger(value["generation"]) || Number(value["generation"]) < 1 ||
      !Number.isSafeInteger(value["interactionEpoch"]) || Number(value["interactionEpoch"]) < 0 ||
      !boundedText(value["capturedAt"], 128) || Number.isNaN(Date.parse(value["capturedAt"])) ||
      typeof value["truncated"] !== "boolean" || !Array.isArray(value["elements"]) ||
      value["elements"].length > 1_500) {
    throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator baseline is invalid.");
  }
  const ids = new Set<string>();
  for (const element of value["elements"] as unknown[]) {
    if (!isRecord(element)) throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator baseline element is invalid.");
    onlyKeys(element, ["elementId", "role", "label", "value", "enabled", "visible", "frame"]);
    if (typeof element["elementId"] !== "string" || !/^[0-9a-f]{20}$/u.test(element["elementId"]) ||
        ids.has(element["elementId"]) || !boundedText(element["role"], 128) ||
        !nullableText(element["label"], 500) || !nullableText(element["value"], 500) ||
        element["enabled"] !== null && typeof element["enabled"] !== "boolean" ||
        element["visible"] !== null && typeof element["visible"] !== "boolean") {
      throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator baseline element is invalid.");
    }
    ids.add(element["elementId"]);
    if (element["frame"] !== null) {
      const frame = element["frame"];
      if (!isRecord(frame)) {
        throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator baseline frame is invalid.");
      }
      onlyKeys(frame, ["x", "y", "width", "height"]);
      if (["x", "y", "width", "height"].some(key =>
        typeof frame[key] !== "number" || !Number.isFinite(frame[key]))) {
        throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator baseline frame is invalid.");
      }
    }
  }
  return value as unknown as SimulatorScreenMap;
}

function requiredSelector(value: unknown): SimulatorElementSelector {
  if (!isRecord(value)) throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator UI selector is invalid.");
  onlyKeys(value, ["elementId", "role", "labelContains", "valueContains"]);
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some(key => !boundedText(value[key],
    key === "elementId" || key === "role" ? 128 : 500))) {
    throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator UI selector is invalid.");
  }
  return value as SimulatorElementSelector;
}

function requiredWaitCondition(value: unknown): SimulatorWaitCondition {
  if (!isRecord(value)) throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator wait condition is invalid.");
  if (value["kind"] === "element_exists" || value["kind"] === "element_missing") {
    onlyKeys(value, ["kind", "selector"]);
    return { kind: value["kind"], selector: requiredSelector(value["selector"]) };
  }
  if (value["kind"] === "screen_changed") {
    onlyKeys(value, ["kind", "snapshotId"]);
    if (typeof value["snapshotId"] !== "string" || !UUID.test(value["snapshotId"])) {
      throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator baseline snapshot is invalid.");
    }
    return { kind: "screen_changed", snapshotId: value["snapshotId"] };
  }
  if (value["kind"] === "screen_stable") {
    onlyKeys(value, ["kind"]);
    return { kind: "screen_stable" };
  }
  throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator wait condition is invalid.");
}

function response(payload: Readonly<Record<string, unknown>>, isError: boolean): McpCallResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError };
}
