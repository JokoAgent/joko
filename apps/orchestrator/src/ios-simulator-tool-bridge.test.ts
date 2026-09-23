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
    }, ownership: { listForTask: () => [] } as never, runtime
  });
  const context = { sessionId: "task", targetId: "target", generation: 3 };
  expect(provider.includeForTarget("target")).toBe(true);
  expect(provider.tools.map(tool => tool.name)).toEqual(["list_tools", "call_tool"]);
  expect((await provider.callTool("list_tools", { category: "ios_simulator" }, undefined, context)).structuredContent)
    .toMatchObject({ category: "ios_simulator", tools: [{ name: "check_environment" }, { name: "doctor" }, { name: "list_simulator_devices" }, { name: "list_instances" }] });
  expect((await provider.callTool("call_tool", { name: "check_environment", args: {} }, undefined, context)).structuredContent)
    .toMatchObject({ ok: true, data: { issue: "UNSUPPORTED_PLATFORM" } });
  expect((await provider.callTool("call_tool", { name: "doctor", args: {} }, undefined, context)).structuredContent)
    .toMatchObject({ ok: true, data: { environment: { issue: "UNSUPPORTED_PLATFORM" }, availability: {
      doctor: { state: "available" }, list_simulator_devices: { state: "unavailable", reasonCode: "UNSUPPORTED_PLATFORM" },
      list_instances: { state: "available" }
    }, instances: [], instanceControl: { state: "unavailable", reasonCode: "INSTANCE_CONTROL_UNAVAILABLE" }, recommendedActions: ["check_environment"] } });
  expect((await provider.callTool("call_tool", { name: "list_instances", args: {} }, undefined, context)).structuredContent)
    .toMatchObject({ ok: true, data: { instances: [] } });
  expect((await provider.callTool("call_tool", { name: "list_simulator_devices", args: {} }, undefined, context)).structuredContent)
    .toMatchObject({ ok: false, errorCode: "UNSUPPORTED_PLATFORM" });
  expect(probes).toBe(3);
  expect((await provider.callTool("call_tool", { name: "list_devices", args: {} }, undefined, context)).structuredContent)
    .toMatchObject({ errorCode: "UNKNOWN_TOOL" });
  expect((await provider.callTool("call_tool", { name: "check_environment", args: { ignored: true } }, undefined, context)).structuredContent)
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect((await provider.callTool("call_tool", { name: "doctor", args: { ignored: true } }, undefined, context)).structuredContent)
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect((await provider.callTool("call_tool", { name: "list_instances", args: { ignored: true } }, undefined, context)).structuredContent)
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  generation = 4;
  expect((await provider.callTool("call_tool", { name: "list_instances", args: {} }, undefined, context)).structuredContent)
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

it("reports live cross-task resource admission and hides probe failures or stale ownership", async () => {
  let generation = 1;
  let percentage = 30;
  let failProbe = false;
  let drift = false;
  let duplicate = false;
  const booted = { udid: "A0123456-1234-1234-1234-123456789ABC", name: "Other task", state: "Booted",
    isAvailable: true, runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0", runtimeName: "iOS 19.0",
    runtimeVersion: "19.0", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", lastBootedAt: null };
  const stopped = { ...booted, udid: "B0123456-1234-1234-1234-123456789ABC", name: "Current task", state: "Shutdown" };
  const runtime: SimulatorEnvironmentRuntime = { inspect: async () => ({ platform: "darwin", supported: true, ready: true,
    xcodeVersion: "Xcode fixture", runtimes: [], devices: duplicate ? [booted, booted] : [booted, stopped],
    issue: null, error: null, setupSteps: [] }) };
  const provider = new IosSimulatorToolBridgeProvider({
    store: {
      getSession: () => ({ descriptor: { targetId: "target", backendId: "backend", binding: { generation }, archived: false } }) as never,
      getTarget: () => ({ descriptor: { backendId: "backend", trusted: true } }) as never
    },
    ownership: { listForTask: () => [], listForResourceAdmission: () => [
      { instanceId: "other-instance", simulatorUdid: booted.udid },
      { instanceId: "current-instance", simulatorUdid: stopped.udid }
    ] } as never,
    runtime,
    memoryProbe: async () => {
      if (drift) generation = 2;
      if (failProbe) throw new Error("/private/host-secret");
      return { source: "macos-memory-pressure", freePercentage: percentage,
        freeBytes: 4 * 1024 ** 3, totalBytes: 8 * 1024 ** 3 };
    }
  });
  const context = { sessionId: "task", targetId: "target", generation: 1 };
  const diagnose = async () => (await provider.callTool("call_tool", { name: "doctor", args: {} }, undefined, context)).structuredContent;
  expect(await diagnose()).toMatchObject({ ok: true, data: { resources: {
    state: "available", runningCount: 1, softLimit: 2, hardLimit: 4, allowed: true, reasonCode: "ADMITTED",
    memory: { freePercentage: 30 }
  }, instances: [], drivers: { state: "unavailable" } } });
  percentage = 9;
  expect(await diagnose()).toMatchObject({ ok: true, data: { resources: {
    state: "available", runningCount: 1, allowed: false, reasonCode: "MEMORY_PRESSURE"
  } } });
  duplicate = true;
  expect(await diagnose()).toMatchObject({ ok: true, data: { resources: {
    state: "unavailable", reasonCode: "RESOURCE_STATE_UNKNOWN"
  } } });
  duplicate = false;
  failProbe = true;
  expect(JSON.stringify(await diagnose())).not.toContain("host-secret");
  expect(await diagnose()).toMatchObject({ ok: true, data: { resources: { state: "unavailable" } } });
  failProbe = false;
  drift = true;
  expect(await diagnose()).toMatchObject({ ok: false, errorCode: "STALE_SCOPE" });
});
