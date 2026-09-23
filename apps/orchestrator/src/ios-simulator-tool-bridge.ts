import { createSimulatorEnvironmentRuntime, type SimulatorEnvironmentRuntime } from "@joko/tool-ios-simulator";
import type { OperationalStore } from "@joko/store";
import type { BridgeToolCallContext, BridgeToolProvider, McpCallResult, McpToolDescriptor } from "./mcp-router.js";
import { SimulatorOwnershipError, type SimulatorOwnershipRegistry } from "./ios-simulator-ownership.js";

export const IOS_SIMULATOR_TOOL_PROVIDER_ID = "joko_ios_simulator";
const CATEGORY = "ios_simulator";

const TOOLS = Object.freeze([
  { name: "check_environment", description: "Check the local macOS Xcode and iOS Simulator environment without opening Simulator.app.", readOnly: true },
  { name: "doctor", description: "Diagnose the current task's iOS Simulator environment and available actions.", readOnly: true },
  { name: "list_simulator_devices", description: "List simulated iPhone and iPad devices with exact UDIDs, runtime and boot states.", readOnly: true },
  { name: "list_instances", description: "List only Simulator instances registered to this task.", readOnly: true }
] as const);

const BRIDGE_TOOLS: readonly McpToolDescriptor[] = Object.freeze([{
  serverId: IOS_SIMULATOR_TOOL_PROVIDER_ID,
  name: "list_tools",
  description: "Discover task-local iOS Simulator tools. Start with doctor or check_environment before selecting a device.",
  inputSchema: { type: "object", properties: { category: { type: "string", enum: [CATEGORY] } }, additionalProperties: false },
  requiresPermission: false
}, {
  serverId: IOS_SIMULATOR_TOOL_PROVIDER_ID,
  name: "call_tool",
  description: "Call one validated task-local iOS Simulator tool. These tools act on Apple simulators, not the host or browser.",
  inputSchema: { type: "object", properties: {
    name: { type: "string", enum: TOOLS.map(tool => tool.name) },
    args: { type: "object", properties: {}, additionalProperties: false }
  }, required: ["name", "args"], additionalProperties: false },
  requiresPermission: false
}]);

export class IosSimulatorToolBridgeProvider implements BridgeToolProvider {
  readonly id = IOS_SIMULATOR_TOOL_PROVIDER_ID;
  readonly generation = 1;
  readonly available = true;
  readonly tools = BRIDGE_TOOLS;
  readonly configurablePolicy = Object.freeze({
    id: "joko-ios-simulator-tools-policy",
    displayName: "iOS Simulator tools",
    description: "Inspect the local iOS Simulator environment, diagnosis and devices for this task.",
    productDefaultEnabled: true
  });
  readonly #store: Pick<OperationalStore, "getSession" | "getTarget">;
  readonly #runtime: SimulatorEnvironmentRuntime;
  readonly #ownership: SimulatorOwnershipRegistry;

  constructor(options: {
    readonly store: Pick<OperationalStore, "getSession" | "getTarget">;
    readonly ownership: SimulatorOwnershipRegistry;
    readonly runtime?: SimulatorEnvironmentRuntime;
  }) {
    this.#store = options.store;
    this.#ownership = options.ownership;
    this.#runtime = options.runtime ?? createSimulatorEnvironmentRuntime();
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
        const tools = TOOLS.map(tool => ({ name: tool.name, category: CATEGORY, description: tool.description, readOnly: tool.readOnly }));
        return response(arguments_["category"] === CATEGORY
          ? { ok: true, category: CATEGORY, tools, workflow: "Call doctor or check_environment, then list_simulator_devices. Use exact UDIDs for later instance actions." }
          : { ok: true, categories: [{ name: CATEGORY, tool_count: tools.length }], hint: "Call list_tools with category ios_simulator to discover actions." }, false);
      }
      if (name !== "call_tool") throw new SimulatorToolError("UNKNOWN_TOOL", "Simulator bridge tool is unavailable.");
      onlyKeys(arguments_, ["name", "args"]);
      const selected = arguments_["name"];
      const args = arguments_["args"];
      if (typeof selected !== "string" || !TOOLS.some(tool => tool.name === selected)) throw new SimulatorToolError("UNKNOWN_TOOL", "Simulator tool is unavailable in this runtime.");
      if (!isRecord(args) || Object.keys(args).length !== 0) throw new SimulatorToolError("INVALID_ARGUMENT", "Simulator tool arguments must be an empty object.");
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
      if (selected === "doctor") return response({ ok: true, data: {
        environment,
        availability: {
          check_environment: { state: "available", backend: "host" },
          doctor: { state: "available", backend: "host" },
          list_simulator_devices: environment.ready
            ? { state: "available", backend: "simctl" }
            : { state: "unavailable", reasonCode: environment.issue ?? "ENVIRONMENT_NOT_READY" },
          list_instances: { state: "available", backend: "host" }
        },
        instances: this.#ownership.listForTask(context),
        instanceControl: { state: "unavailable", reasonCode: "INSTANCE_CONTROL_UNAVAILABLE" },
        drivers: { state: "unavailable", reasonCode: "INSTANCE_DRIVER_UNAVAILABLE" },
        recommendedActions: environment.ready ? ["list_simulator_devices"] : ["check_environment"]
      } }, false);
      if (!environment.ready) return response({ ok: false, errorCode: environment.issue, message: environment.error, data: { environment } }, true);
      return response({ ok: true, data: { devices: environment.devices, xcodeVersion: environment.xcodeVersion } }, false);
    } catch (error) {
      const code = error instanceof SimulatorToolError || error instanceof SimulatorOwnershipError ? error.code : signal?.aborted ? "PROBE_ABORTED" : "SIMULATOR_HOST_ERROR";
      const message = error instanceof SimulatorToolError || error instanceof SimulatorOwnershipError ? error.message : signal?.aborted ? "Simulator probe was cancelled." : "Simulator host call failed.";
      return response({ ok: false, errorCode: code, message }, true);
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

function response(payload: Readonly<Record<string, unknown>>, isError: boolean): McpCallResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError };
}
