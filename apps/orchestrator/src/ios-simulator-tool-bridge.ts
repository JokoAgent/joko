import { assessSimulatorResourceAdmission, collectSimulatorMemorySnapshot, createSimulatorEnvironmentRuntime,
  type SimulatorEnvironmentReport, type SimulatorEnvironmentRuntime, type SimulatorMemorySnapshot } from "@joko/tool-ios-simulator";
import { OperationInProgressError, type OperationalStore } from "@joko/store";
import type { BridgeToolCallContext, BridgeToolProvider, McpCallResult, McpToolDescriptor } from "./mcp-router.js";
import { SimulatorOwnershipError, type SimulatorOwnershipRegistry } from "./ios-simulator-ownership.js";
import { SimulatorInstanceControlError, type SimulatorInstanceControlCoordinator } from "./ios-simulator-instance-control.js";
import { SimulatorCreateError, SimulatorLifecycleError, SimulatorResourceError } from "@joko/tool-ios-simulator";
import { SimulatorDriverError } from "./ios-simulator-driver-coordinator.js";

export const IOS_SIMULATOR_TOOL_PROVIDER_ID = "joko_ios_simulator";
const CATEGORY = "ios_simulator";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const DIGEST = /^[0-9a-f]{64}$/u;
const BODY_HASH = /^sha256:[0-9a-f]{64}$/u;

const TOOLS = Object.freeze([
  { name: "check_environment", description: "Check the local macOS Xcode and iOS Simulator environment without opening Simulator.app.", readOnly: true },
  { name: "doctor", description: "Diagnose the current task's iOS Simulator environment and available actions.", readOnly: true },
  { name: "list_simulator_devices", description: "List simulated iPhone and iPad devices with exact UDIDs, runtime and boot states.", readOnly: true },
  { name: "list_instances", description: "List only Simulator instances registered to this task.", readOnly: true }
] as const);

const CONTROL_TOOLS = Object.freeze([
  { name: "create_instance", description: "Create a task-owned Simulator from an installed template and attach its Viewer.", readOnly: false },
  { name: "attach_device", description: "Attach one exact Simulator device to this task and its Viewer.", readOnly: false },
  { name: "start_instance", description: "Boot the exact owned Simulator and start its Viewer driver.", readOnly: false },
  { name: "stop_instance", description: "Stop the exact owned Simulator without deleting it.", readOnly: false },
  { name: "detach_device", description: "Detach the Viewer; agent-booted devices receive a bounded shutdown grace.", readOnly: false }
] as const);

function bridgeTools(control: boolean): readonly McpToolDescriptor[] {
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
      name: { type: "string", enum: TOOLS.map(tool => tool.name) },
      args: { type: "object", properties: {}, additionalProperties: false }
    }, required: ["name", "args"], additionalProperties: false },
    requiresPermission: false
  }];
  if (control) tools.push({
    serverId: IOS_SIMULATOR_TOOL_PROVIDER_ID,
    name: "control_tool",
    description: "Call one validated task-local iOS Simulator instance mutation with the current task's permission.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", enum: CONTROL_TOOLS.map(tool => tool.name) },
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
    description: "Inspect the local iOS Simulator environment, diagnosis and devices for this task.",
    productDefaultEnabled: true
  });
  readonly #store: Pick<OperationalStore, "getSession" | "getTarget">;
  readonly #runtime: SimulatorEnvironmentRuntime;
  readonly #ownership: SimulatorOwnershipRegistry;
  readonly #control: SimulatorInstanceControlCoordinator | undefined;
  readonly #memoryProbe: (signal?: AbortSignal) => Promise<SimulatorMemorySnapshot>;

  constructor(options: {
    readonly store: Pick<OperationalStore, "getSession" | "getTarget">;
    readonly ownership: SimulatorOwnershipRegistry;
    readonly control?: SimulatorInstanceControlCoordinator;
    readonly runtime?: SimulatorEnvironmentRuntime;
    readonly memoryProbe?: (signal?: AbortSignal) => Promise<SimulatorMemorySnapshot>;
  }) {
    this.#store = options.store;
    this.#ownership = options.ownership;
    this.#control = options.control;
    this.tools = bridgeTools(options.control !== undefined);
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
        const tools = [...TOOLS, ...(this.#control ? CONTROL_TOOLS : [])]
          .map(tool => ({ name: tool.name, category: CATEGORY, description: tool.description,
            readOnly: tool.readOnly, via: tool.readOnly ? "call_tool" : "control_tool" }));
        return response(arguments_["category"] === CATEGORY
          ? { ok: true, category: CATEGORY, tools, workflow: "Call doctor or check_environment, then list_simulator_devices. Use exact UDIDs for later instance actions." }
          : { ok: true, categories: [{ name: CATEGORY, tool_count: tools.length }], hint: "Call list_tools with category ios_simulator to discover actions." }, false);
      }
      if (name !== "call_tool" && (name !== "control_tool" || !this.#control)) {
        throw new SimulatorToolError("UNKNOWN_TOOL", "Simulator bridge tool is unavailable.");
      }
      onlyKeys(arguments_, ["name", "args"]);
      const selected = arguments_["name"];
      const args = arguments_["args"];
      if (typeof selected !== "string" || !(name === "call_tool" ? TOOLS : CONTROL_TOOLS)
        .some(tool => tool.name === selected)) throw new SimulatorToolError("UNKNOWN_TOOL", "Simulator tool is unavailable in this runtime.");
      if (!isRecord(args)) throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator tool arguments must be an object.");
      if (name === "control_tool") {
        return await this.#callInstanceControl(selected, args, signal, context);
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
            ...controlAvailability
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
              : ["start_instance"] : ["check_environment"]
        } }, false);
      }
      if (!environment.ready) return response({ ok: false, errorCode: environment.issue, message: environment.error, data: { environment } }, true);
      return response({ ok: true, data: { devices: environment.devices, xcodeVersion: environment.xcodeVersion } }, false);
    } catch (error) {
      const known = error instanceof SimulatorToolError || error instanceof SimulatorOwnershipError ||
        error instanceof SimulatorInstanceControlError || error instanceof SimulatorCreateError ||
        error instanceof SimulatorLifecycleError || error instanceof SimulatorResourceError ||
        error instanceof SimulatorDriverError;
      const code = known ? error.code : error instanceof OperationInProgressError
        ? "MUTATION_IN_PROGRESS" : signal?.aborted ? "PROBE_ABORTED" : "SIMULATOR_HOST_ERROR";
      const message = known ? error.message : error instanceof OperationInProgressError
        ? "Simulator operation is already in progress." : signal?.aborted ? "Simulator probe was cancelled." : "Simulator host call failed.";
      return response({ ok: false, errorCode: code, message }, true);
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
    let execute: () => Promise<{ readonly instance: unknown; readonly replayed: boolean }>;
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
    this.#requireScope(context);
    return response({ ok: true, data: { instance: result.instance, replayed: result.replayed } }, false);
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

function response(payload: Readonly<Record<string, unknown>>, isError: boolean): McpCallResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError };
}
