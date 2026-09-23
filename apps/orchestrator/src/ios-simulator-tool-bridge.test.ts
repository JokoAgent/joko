import { expect, it } from "vitest";
import type { SimulatorEnvironmentRuntime } from "@joko/tool-ios-simulator";
import { IosSimulatorToolBridgeProvider } from "./ios-simulator-tool-bridge.js";

it("binds Simulator discovery and dispatch to an exact trusted local task", async () => {
  let generation = 3;
  let trusted = true;
  let remote = false;
  let probes = 0;
  const runtime: SimulatorEnvironmentRuntime = { inspect: async () => {
    probes += 1;
    return { platform: "win32", supported: false, ready: false, xcodeVersion: null, runtimes: [], devices: [], issue: "UNSUPPORTED_PLATFORM", error: "macOS required", setupSteps: ["Open on macOS."] };
  } };
  const provider = new IosSimulatorToolBridgeProvider({
    store: {
      getSession: () => ({ descriptor: { targetId: "target", backendId: "backend", binding: { generation }, archived: false } }) as never,
      getTarget: () => ({ descriptor: { backendId: "backend", trusted,
        ...(remote ? { remoteWorkspace: { hostId: "remote" } } : {}) } }) as never
    }, runtime
  });
  const context = { sessionId: "task", targetId: "target", generation: 3 };
  expect(provider.includeForTarget("target")).toBe(true);
  expect(provider.tools.map(tool => tool.name)).toEqual(["list_tools", "call_tool"]);
  expect((await provider.callTool("list_tools", { category: "ios_simulator" }, undefined, context)).structuredContent)
    .toMatchObject({ category: "ios_simulator", tools: [{ name: "check_environment" }, { name: "doctor" }, { name: "list_simulator_devices" }] });
  expect((await provider.callTool("call_tool", { name: "check_environment", args: {} }, undefined, context)).structuredContent)
    .toMatchObject({ ok: true, data: { issue: "UNSUPPORTED_PLATFORM" } });
  expect((await provider.callTool("call_tool", { name: "doctor", args: {} }, undefined, context)).structuredContent)
    .toMatchObject({ ok: true, data: { environment: { issue: "UNSUPPORTED_PLATFORM" }, availability: {
      doctor: { state: "available" }, list_simulator_devices: { state: "unavailable", reasonCode: "UNSUPPORTED_PLATFORM" }
    }, instanceControl: { state: "unavailable", reasonCode: "INSTANCE_CONTROL_UNAVAILABLE" }, recommendedActions: ["check_environment"] } });
  expect((await provider.callTool("call_tool", { name: "list_simulator_devices", args: {} }, undefined, context)).structuredContent)
    .toMatchObject({ ok: false, errorCode: "UNSUPPORTED_PLATFORM" });
  expect(probes).toBe(3);
  expect((await provider.callTool("call_tool", { name: "list_devices", args: {} }, undefined, context)).structuredContent)
    .toMatchObject({ errorCode: "UNKNOWN_TOOL" });
  expect((await provider.callTool("call_tool", { name: "check_environment", args: { ignored: true } }, undefined, context)).structuredContent)
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect((await provider.callTool("call_tool", { name: "doctor", args: { ignored: true } }, undefined, context)).structuredContent)
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  generation = 4;
  expect((await provider.callTool("call_tool", { name: "check_environment", args: {} }, undefined, context)).structuredContent)
    .toMatchObject({ errorCode: "STALE_SCOPE" });
  generation = 3;
  remote = true;
  expect(provider.includeForTarget("target")).toBe(false);
  expect((await provider.callTool("list_tools", {}, undefined, context)).structuredContent).toMatchObject({ errorCode: "STALE_SCOPE" });
  remote = false;
  trusted = false;
  expect(provider.includeForTarget("target")).toBe(false);
  expect((await provider.callTool("call_tool", { name: "check_environment", args: {} }, undefined, context)).structuredContent)
    .toMatchObject({ errorCode: "STALE_SCOPE" });
  expect(probes).toBe(3);
});
