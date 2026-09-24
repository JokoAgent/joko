import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { OperationInProgressError } from "@joko/store";
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

it("publishes instance mutations only with a composed control owner and requires exact effect authority", async () => {
  const calls: string[] = [];
  const instance = { instanceId: "owned", simulatorUdid: "A0123456-1234-1234-1234-123456789ABC",
    generation: 2, lease: { id: "lease", issuedAt: 1, expiresAt: 60_001 } };
  let ready = true;
  let conflict = false;
  const control = {
    diagnoseDrivers: () => [],
    create: async () => { calls.push("create"); return { instance, replayed: false }; },
    attach: async () => { calls.push("attach"); return { instance, replayed: false }; },
    start: async () => { calls.push("start"); return { instance, replayed: false }; },
    stop: async () => { if (conflict) throw new OperationInProgressError("private-operation-id");
      calls.push("stop"); return { instance, replayed: false }; },
    detach: async () => { calls.push("detach"); return { instance, replayed: false }; }
  };
  const provider = new IosSimulatorToolBridgeProvider({
    store: { getSession: () => ({ descriptor: { targetId: "target", backendId: "backend",
      binding: { generation: 1 }, archived: false } }) as never,
      getTarget: () => ({ descriptor: { backendId: "backend", trusted: true } }) as never },
    ownership: { listForTask: () => [] } as never, control: control as never,
    runtime: { inspect: async () => ({ platform: "darwin", supported: true, ready,
      xcodeVersion: "Xcode fixture", runtimes: [], devices: [], issue: ready ? null : "XCODE_NOT_FOUND",
      error: ready ? null : "Simulator unavailable", setupSteps: [] }) }
  });
  const scope = { sessionId: "task", targetId: "target", generation: 1 };
  const authority = { ...scope, effectIdentity: "a".repeat(64), requestBodyHash: `sha256:${"b".repeat(64)}`,
    providerGeneration: 1 };
  expect(provider.tools.find(tool => tool.name === "call_tool")?.requiresPermission).toBe(false);
  expect(provider.tools.find(tool => tool.name === "control_tool")?.requiresPermission).toBe(true);
  expect((await provider.callTool("list_tools", { category: "ios_simulator" }, undefined, scope)).structuredContent)
    .toMatchObject({ tools: expect.arrayContaining([{ name: "create_instance", category: "ios_simulator",
      readOnly: false, via: "control_tool", description: expect.any(String) }]) });
  const invoke = (name: string, args: Record<string, unknown>, context: typeof scope | typeof authority = authority) =>
    provider.callTool("control_tool", { name, args }, undefined, context);
  expect((await provider.callTool("call_tool", { name: "start_instance", args: {} }, undefined, authority))
    .structuredContent).toMatchObject({ errorCode: "UNKNOWN_TOOL" });
  expect((await invoke("create_instance", { templateUdid: instance.simulatorUdid, name: "Joko iPhone" }, scope))
    .structuredContent).toMatchObject({ errorCode: "STALE_SCOPE" });
  expect((await invoke("create_instance", { templateUdid: instance.simulatorUdid, name: "Joko iPhone", extra: 1 }))
    .structuredContent).toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect((await invoke("create_instance", { templateUdid: instance.simulatorUdid, name: "Joko iPhone" }))
    .structuredContent).toMatchObject({ ok: true, data: { instance, replayed: false } });
  expect((await invoke("attach_device", { udid: instance.simulatorUdid })).structuredContent)
    .toMatchObject({ ok: true });
  expect((await provider.callTool("call_tool", { name: "doctor", args: {} }, undefined, scope)).structuredContent)
    .toMatchObject({ ok: true, data: { instanceControl: { state: "available" },
      drivers: { state: "available", instances: [] },
      availability: { create_instance: { state: "available" }, start_instance: { reasonCode: "INSTANCE_REQUIRED" } } } });
  for (const name of ["start_instance", "stop_instance", "detach_device"]) {
    expect((await invoke(name, { instanceId: "owned", generation: 2, leaseId: "lease" })).structuredContent)
      .toMatchObject({ ok: true });
  }
  expect(calls).toEqual(["create", "attach", "start", "stop", "detach"]);
  conflict = true;
  const blocked = await invoke("stop_instance", { instanceId: "owned", generation: 2, leaseId: "lease" });
  expect(blocked.structuredContent).toMatchObject({ errorCode: "MUTATION_IN_PROGRESS" });
  expect(JSON.stringify(blocked.structuredContent)).not.toContain("private-operation-id");
  ready = false;
  expect((await invoke("start_instance", { instanceId: "owned", generation: 2, leaseId: "lease" }))
    .structuredContent).toMatchObject({ ok: false, errorCode: "XCODE_NOT_FOUND" });
  expect(calls).toHaveLength(5);
});

it("publishes task-owned screen observations through the permission bridge with strict input bounds", async () => {
  let ready = true;
  let archived = false;
  const calls: string[] = [];
  const screenMap = { snapshotId: randomUUID(), instanceId: "owned", generation: 2,
    interactionEpoch: 0, capturedAt: new Date().toISOString(), truncated: false, elements: [{
      elementId: "a".repeat(20), role: "XCUIElementTypeButton", label: "Continue", value: null,
      enabled: true, visible: true, frame: { x: 0, y: 0, width: 100, height: 44 }
    }] };
  const screen = {
    screenMap: async () => { calls.push("map"); return { screenMap, viewport: { width: 393, height: 852,
      orientation: "PORTRAIT" } }; },
    audit: async () => { calls.push("audit"); return { audit: { violationCount: 0 } }; },
    compare: async (_scope: unknown, _route: unknown, baseline: typeof screenMap) => {
      calls.push(`compare:${baseline.snapshotId}`); return { diff: { unchangedCount: 1 } }; },
    wait: async () => { calls.push("wait"); return { screenMap, elapsedMs: 1, timedOut: false }; },
    clear: () => undefined
  };
  const provider = new IosSimulatorToolBridgeProvider({
    store: { getSession: () => ({ descriptor: { targetId: "target", backendId: "backend",
      binding: { generation: 1 }, archived } }) as never,
      getTarget: () => ({ descriptor: { backendId: "backend", trusted: true } }) as never },
    ownership: { listForTask: () => [{ instanceId: "owned" }],
      listForResourceAdmission: () => [] } as never,
    control: { diagnoseDrivers: () => [{ state: "ready" }] } as never,
    screen: screen as never,
    runtime: { inspect: async () => ({ platform: "darwin", supported: true, ready,
      xcodeVersion: "Xcode fixture", runtimes: [], devices: [], issue: ready ? null : "XCODE_NOT_FOUND",
      error: ready ? null : "Simulator unavailable", setupSteps: [] }) },
    memoryProbe: async () => ({ source: "macos-memory-pressure", freePercentage: 50,
      freeBytes: 4 * 1024 ** 3, totalBytes: 8 * 1024 ** 3 })
  });
  const scope = { sessionId: "task", targetId: "target", generation: 1 };
  const route = { instanceId: "owned", generation: 2, leaseId: "lease" };
  const invoke = async (name: string, args: Record<string, unknown>) =>
    (await provider.callTool("control_tool", { name, args }, undefined, scope)).structuredContent;
  expect(provider.tools.find(tool => tool.name === "control_tool")?.requiresPermission).toBe(true);
  const catalog = (await provider.callTool("list_tools", { category: "ios_simulator" }, undefined, scope))
    .structuredContent;
  expect(catalog).toMatchObject({ tools: expect.arrayContaining([
    expect.objectContaining({ name: "get_screen_map", readOnly: true, via: "control_tool" }),
    expect.objectContaining({ name: "audit_accessibility", readOnly: true, via: "control_tool" }),
    expect.objectContaining({ name: "compare_screen_maps", readOnly: true, via: "control_tool" }),
    expect.objectContaining({ name: "wait_for_ui", readOnly: true, via: "control_tool" })
  ]) });
  expect((await provider.callTool("call_tool", { name: "get_screen_map", args: route }, undefined, scope))
    .structuredContent).toMatchObject({ errorCode: "UNKNOWN_TOOL" });
  expect((await provider.callTool("call_tool", { name: "doctor", args: {} }, undefined, scope))
    .structuredContent).toMatchObject({ data: { availability: {
      get_screen_map: { state: "available" }, wait_for_ui: { state: "available" }
    } } });
  expect(await invoke("get_screen_map", route)).toMatchObject({ ok: true, data: { screenMap,
    viewport: { width: 393 } } });
  expect(await invoke("audit_accessibility", { ...route, maxViolations: 40 }))
    .toMatchObject({ ok: true, data: { audit: { violationCount: 0 } } });
  expect(await invoke("compare_screen_maps", { ...route, baseline: screenMap }))
    .toMatchObject({ ok: true, data: { diff: { unchangedCount: 1 } } });
  expect(await invoke("wait_for_ui", { ...route,
    condition: { kind: "element_exists", selector: { labelContains: "Continue" } },
    timeoutMs: 1_000, pollIntervalMs: 100, stableForMs: 100 }))
    .toMatchObject({ ok: true, data: { timedOut: false } });
  expect(await invoke("compare_screen_maps", { ...route,
    baseline: { ...screenMap, snapshotId: 123 } })).toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(await invoke("wait_for_ui", { ...route,
    condition: { kind: "element_exists", selector: {} } })).toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(await invoke("wait_for_ui", { ...route, condition: { kind: "screen_stable" },
    timeoutMs: 30_001 })).toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(calls).toEqual(["map", "audit", `compare:${screenMap.snapshotId}`, "wait"]);
  ready = false;
  expect(await invoke("get_screen_map", route)).toMatchObject({ errorCode: "XCODE_NOT_FOUND" });
  archived = true;
  expect(await invoke("get_screen_map", route)).toMatchObject({ errorCode: "STALE_SCOPE" });
  expect(calls).toHaveLength(4);
});

it("publishes bounded Simulator input only through permission authority and strict snapshot arguments", async () => {
  let ready = true;
  let archived = false;
  const calls: Array<{ action: unknown; observe: unknown; authority: unknown }> = [];
  const input = { execute: async (_scope: unknown, route: { instanceId: string; generation: number },
    action: { type: "tap" | "swipe" | "type_text" | "press_home" }, observe: unknown,
    authority: unknown) => {
    calls.push({ action, observe, authority });
    return { receipt: { action: action.type, instanceId: route.instanceId, generation: route.generation,
      backend: "wda", completedAt: new Date(0).toISOString(),
      observationResult: { mode: "none", state: "not_requested" } }, replayed: false,
      observation: null, observationError: null };
  } };
  const provider = new IosSimulatorToolBridgeProvider({
    store: { getSession: () => ({ descriptor: { targetId: "target", backendId: "backend",
      binding: { generation: 1 }, archived } }) as never,
      getTarget: () => ({ descriptor: { backendId: "backend", trusted: true } }) as never },
    ownership: { listForTask: () => [{ instanceId: "owned" }],
      listForResourceAdmission: () => [] } as never,
    control: { diagnoseDrivers: () => [{ state: "ready" }] } as never,
    screen: { clear: () => undefined } as never,
    input: input as never,
    runtime: { inspect: async () => ({ platform: "darwin", supported: true, ready,
      xcodeVersion: "Xcode fixture", runtimes: [], devices: [], issue: ready ? null : "XCODE_NOT_FOUND",
      error: ready ? null : "Simulator unavailable", setupSteps: [] }) },
    memoryProbe: async () => ({ source: "macos-memory-pressure", freePercentage: 50,
      freeBytes: 4 * 1024 ** 3, totalBytes: 8 * 1024 ** 3 })
  });
  const scope = { sessionId: "task", targetId: "target", generation: 1 };
  const authority = { ...scope, effectIdentity: "a".repeat(64),
    requestBodyHash: `sha256:${"b".repeat(64)}`, providerGeneration: 1 };
  const route = { instanceId: "owned", generation: 2, leaseId: "lease",
    snapshotId: randomUUID() };
  const invoke = async (name: string, args: Record<string, unknown>,
    context: typeof scope | typeof authority = authority) =>
    (await provider.callTool("control_tool", { name, args }, undefined, context)).structuredContent;
  const catalog = (await provider.callTool("list_tools", { category: "ios_simulator" }, undefined, scope))
    .structuredContent;
  expect(catalog).toMatchObject({ tools: expect.arrayContaining([
    expect.objectContaining({ name: "tap", readOnly: false, via: "control_tool" }),
    expect.objectContaining({ name: "swipe", readOnly: false, via: "control_tool" }),
    expect.objectContaining({ name: "drag_on_simulator", readOnly: false, via: "control_tool" }),
    expect.objectContaining({ name: "long_press", readOnly: false, via: "control_tool" }),
    expect.objectContaining({ name: "press_simulator_key", readOnly: false, via: "control_tool" }),
    expect.objectContaining({ name: "batch", readOnly: false, via: "control_tool" }),
    expect.objectContaining({ name: "type_simulator_text", readOnly: false, via: "control_tool" }),
    expect.objectContaining({ name: "press_home", readOnly: false, via: "control_tool" })
  ]) });
  expect((await provider.callTool("call_tool", { name: "tap", args: route }, undefined, authority))
    .structuredContent).toMatchObject({ errorCode: "UNKNOWN_TOOL" });
  expect(await invoke("tap", { ...route, x: 1, y: 2 }, scope))
    .toMatchObject({ errorCode: "STALE_SCOPE" });
  expect(await invoke("tap", { ...route, elementId: "element", x: 1, y: 2 }))
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(await invoke("tap", { ...route, elementId: "element" }))
    .toMatchObject({ ok: true, data: { action: "tap", backend: "wda",
      screenMapInvalidated: true, replayed: false } });
  expect(await invoke("swipe", { ...route, startX: 0, startY: 1, endX: 2, endY: 3,
    observeAfter: "stable", observeTimeoutMs: 1_000, stableForMs: 100 }))
    .toMatchObject({ ok: true, data: { action: "swipe" } });
  expect(await invoke("drag_on_simulator", { ...route, fromElementId: "from",
    toElementId: "to" })).toMatchObject({ ok: true, data: { action: "drag" } });
  expect(await invoke("long_press", { ...route, elementId: "element" }))
    .toMatchObject({ ok: true, data: { action: "long_press" } });
  expect(await invoke("press_simulator_key", { ...route, key: "return" }))
    .toMatchObject({ ok: true, data: { action: "key_press" } });
  expect(await invoke("batch", { ...route, actions: [
    { type: "tap", elementId: "element" }, { type: "key_press", key: "tab" }
  ] })).toMatchObject({ ok: true, data: { action: "batch" } });
  expect(await invoke("type_simulator_text", { ...route, text: "" }))
    .toMatchObject({ ok: true, data: { action: "type_text" } });
  expect(await invoke("press_home", route)).toMatchObject({ ok: true,
    data: { action: "press_home" } });
  expect(await invoke("press_simulator_key", { ...route, key: "space" }))
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(await invoke("batch", { ...route, actions: [], observeAfter: "none" }))
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(calls).toHaveLength(8);
  expect(calls[0]).toMatchObject({ action: { type: "tap", target: { elementId: "element" } },
    observe: { mode: "none", timeoutMs: 3_000, stableForMs: 300 },
    authority: { effectIdentity: "a".repeat(64), providerGeneration: 1 } });
  expect(calls[1]).toMatchObject({ action: { type: "swipe", durationMs: 300 },
    observe: { mode: "stable", timeoutMs: 1_000, stableForMs: 100 } });
  expect(calls[2]).toMatchObject({ action: { type: "drag", fromElementId: "from",
    toElementId: "to", durationMs: 500 } });
  expect(calls[3]).toMatchObject({ action: { type: "long_press", durationMs: 750 } });
  expect(calls[4]).toMatchObject({ action: { type: "key_press", key: "return" } });
  expect(calls[5]).toMatchObject({ action: { type: "batch", actions: [
    { type: "tap", elementId: "element" }, { type: "key_press", key: "tab" }
  ] }, observe: { mode: "stable" } });
  expect((await provider.callTool("call_tool", { name: "doctor", args: {} }, undefined, scope))
    .structuredContent).toMatchObject({ data: { availability: {
      tap: { state: "available", backend: "wda" }, press_home: { state: "available" }
    } } });
  ready = false;
  expect(await invoke("press_home", route)).toMatchObject({ errorCode: "XCODE_NOT_FOUND" });
  expect(calls).toHaveLength(8);
  archived = true;
  expect(await invoke("press_home", route)).toMatchObject({ errorCode: "STALE_SCOPE" });
});

it("publishes strict Simulator presentation and accessibility controls only with effect authority", async () => {
  let ready = true;
  const calls: Array<{ action: Record<string, unknown>; authority: unknown }> = [];
  const stateControl = { execute: async (_scope: unknown,
    route: { instanceId: string; generation: number }, action: Record<string, unknown>,
    authority: unknown) => {
    calls.push({ action, authority });
    return { replayed: false, receipt: { interaction: action["type"],
      instanceId: route.instanceId, generation: route.generation,
      backend: action["type"] === "set_orientation" ? "wda" : "simctl",
      completedAt: new Date().toISOString(),
      ...(action["type"] === "set_orientation" ? { orientation: action["orientation"], mode: "device",
        viewport: { width: 852, height: 393, orientation: action["orientation"] } } : {}),
      ...(action["type"] === "set_appearance" ? { appearance: action["appearance"] } : {}),
      ...(action["type"] === "set_increase_contrast" ? { enabled: action["enabled"] } : {}),
      ...(action["type"] === "set_content_size" ? { contentSize: action["contentSize"] } : {}),
      ...(action["type"] === "set_location" ? { latitude: action["latitude"],
        longitude: action["longitude"] } : {}),
      ...(action["type"] === "start_location_route" ? {
        waypointCount: (action["waypoints"] as readonly unknown[]).length } : {}),
      ...(action["type"] === "set_privacy" ? { action: action["action"],
        service: action["service"], bundleId: action["bundleId"] ?? null } : {}),
      ...(action["type"] === "set_status_bar" ? { overrides: action["overrides"] } : {}),
      ...(action["type"] === "push_notification" ? { bundleId: action["bundleId"],
        delivered: true } : {}) } };
  } };
  const provider = new IosSimulatorToolBridgeProvider({
    store: { getSession: () => ({ descriptor: { targetId: "target", backendId: "backend",
      binding: { generation: 1 }, archived: false } }) as never,
      getTarget: () => ({ descriptor: { backendId: "backend", trusted: true } }) as never },
    ownership: { listForTask: () => [{ instanceId: "owned" }],
      listForResourceAdmission: () => [] } as never,
    control: { diagnoseDrivers: () => [{ state: "ready" }] } as never,
    screen: { clear: () => undefined } as never,
    stateControl: stateControl as never,
    runtime: { inspect: async () => ({ platform: "darwin", supported: true, ready,
      xcodeVersion: "Xcode fixture", runtimes: [], devices: [], issue: ready ? null : "XCODE_NOT_FOUND",
      error: ready ? null : "Simulator unavailable", setupSteps: [] }) },
    memoryProbe: async () => ({ source: "macos-memory-pressure", freePercentage: 50,
      freeBytes: 4 * 1024 ** 3, totalBytes: 8 * 1024 ** 3 })
  });
  const scope = { sessionId: "task", targetId: "target", generation: 1 };
  const authority = { ...scope, effectIdentity: "a".repeat(64),
    requestBodyHash: `sha256:${"b".repeat(64)}`, providerGeneration: 1 };
  const route = { instanceId: "owned", generation: 2, leaseId: "lease" };
  const snapshotId = randomUUID();
  const invoke = async (name: string, args: Record<string, unknown>,
    context: typeof scope | typeof authority = authority) =>
    (await provider.callTool("control_tool", { name, args }, undefined, context)).structuredContent;
  expect((await provider.callTool("list_tools", { category: "ios_simulator" }, undefined, scope))
    .structuredContent).toMatchObject({ tools: expect.arrayContaining([
      expect.objectContaining({ name: "set_orientation", readOnly: false, via: "control_tool" }),
      expect.objectContaining({ name: "set_appearance", readOnly: false, via: "control_tool" }),
      expect.objectContaining({ name: "set_increase_contrast", readOnly: false, via: "control_tool" }),
      expect.objectContaining({ name: "set_content_size", readOnly: false, via: "control_tool" }),
      expect.objectContaining({ name: "set_location", readOnly: false, via: "control_tool" }),
      expect.objectContaining({ name: "start_location_route", readOnly: false, via: "control_tool" }),
      expect.objectContaining({ name: "clear_location", readOnly: false, via: "control_tool" }),
      expect.objectContaining({ name: "set_privacy", readOnly: false, via: "control_tool" }),
      expect.objectContaining({ name: "set_status_bar", readOnly: false, via: "control_tool" }),
      expect.objectContaining({ name: "clear_status_bar", readOnly: false, via: "control_tool" }),
      expect.objectContaining({ name: "push_notification", readOnly: false, via: "control_tool" })
    ]) });
  expect(await invoke("set_orientation", { ...route, snapshotId, orientation: "LANDSCAPE" }))
    .toMatchObject({ ok: true, data: { interaction: "set_orientation", backend: "wda",
      orientation: "LANDSCAPE", screenMapInvalidated: true } });
  expect(await invoke("set_appearance", { ...route, appearance: "dark" }))
    .toMatchObject({ ok: true, data: { interaction: "set_appearance", appearance: "dark" } });
  expect(await invoke("set_increase_contrast", { ...route, enabled: true }))
    .toMatchObject({ ok: true, data: { interaction: "set_increase_contrast", enabled: true } });
  expect(await invoke("set_content_size", { ...route,
    contentSize: "accessibility-extra-large" })).toMatchObject({ ok: true,
      data: { interaction: "set_content_size", contentSize: "accessibility-extra-large" } });
  expect(await invoke("set_location", { ...route, latitude: 31.2304, longitude: 121.4737 }))
    .toMatchObject({ ok: true, data: { interaction: "set_location",
      latitude: 31.2304, longitude: 121.4737 } });
  expect(await invoke("start_location_route", { ...route, waypoints: [
    { latitude: 31.2304, longitude: 121.4737 }, { latitude: 31.233, longitude: 121.48 }
  ], speedMetersPerSecond: 12, intervalSeconds: 0.5 })).toMatchObject({ ok: true,
      data: { interaction: "start_location_route", waypointCount: 2 } });
  expect(await invoke("clear_location", route)).toMatchObject({ ok: true,
    data: { interaction: "clear_location", backend: "simctl" } });
  expect(await invoke("set_privacy", { ...route, action: "grant", service: "camera",
    bundleId: "app.joko.fixture" })).toMatchObject({ ok: true, data: {
      interaction: "set_privacy", action: "grant", service: "camera",
      bundleId: "app.joko.fixture" } });
  const statusOverrides = { time: "09:41", dataNetwork: "5g", wifiMode: "active",
    wifiBars: 3, cellularMode: "searching", cellularBars: 4, operatorName: "Joko",
    batteryState: "charged", batteryLevel: 100 };
  expect(await invoke("set_status_bar", { ...route, ...statusOverrides }))
    .toMatchObject({ ok: true, data: { interaction: "set_status_bar",
      overrides: statusOverrides } });
  expect(await invoke("clear_status_bar", route)).toMatchObject({ ok: true,
    data: { interaction: "clear_status_bar", backend: "simctl" } });
  const pushPayload = { aps: { alert: "private push body" } };
  expect(await invoke("push_notification", { ...route, bundleId: "app.joko.fixture",
    payload: pushPayload })).toMatchObject({ ok: true, data: {
      interaction: "push_notification", bundleId: "app.joko.fixture", delivered: true } });
  expect(await invoke("set_orientation", { ...route, snapshotId, orientation: "UPSIDE_DOWN" }))
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(await invoke("set_appearance", { ...route, appearance: "blue" }))
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(await invoke("set_increase_contrast", { ...route, enabled: 1 }))
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(await invoke("set_content_size", { ...route, contentSize: "huge" }))
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(await invoke("set_location", { ...route, latitude: 91, longitude: 0 }))
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(await invoke("start_location_route", { ...route,
    waypoints: [{ latitude: 0, longitude: 0 }] }))
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(await invoke("start_location_route", { ...route, waypoints: [
    { latitude: 0, longitude: 0 }, { latitude: 1, longitude: 1 }
  ], intervalSeconds: 1, distanceMeters: 1 })).toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(await invoke("set_privacy", { ...route, action: "grant", service: "camera" }))
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(await invoke("set_privacy", { ...route, action: "reset", service: "Camera" }))
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(await invoke("set_status_bar", route)).toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(await invoke("set_status_bar", { ...route, wifiBars: 4 }))
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(await invoke("push_notification", { ...route, bundleId: "invalid bundle",
    payload: pushPayload })).toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(await invoke("push_notification", { ...route, bundleId: "app.joko.fixture",
    payload: {} })).toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(await invoke("push_notification", { ...route, bundleId: "app.joko.fixture",
    payload: { aps: {}, alert: "界".repeat(1_400) } }))
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(await invoke("set_appearance", { ...route, appearance: "light" }, scope))
    .toMatchObject({ errorCode: "STALE_SCOPE" });
  expect(calls).toHaveLength(11);
  expect(calls.map(call => call.action)).toEqual([
    { type: "set_orientation", snapshotId, orientation: "LANDSCAPE" },
    { type: "set_appearance", appearance: "dark" },
    { type: "set_increase_contrast", enabled: true },
    { type: "set_content_size", contentSize: "accessibility-extra-large" },
    { type: "set_location", latitude: 31.2304, longitude: 121.4737 },
    { type: "start_location_route", waypoints: [
      { latitude: 31.2304, longitude: 121.4737 }, { latitude: 31.233, longitude: 121.48 }
    ], speedMetersPerSecond: 12, intervalSeconds: 0.5 },
    { type: "clear_location" },
    { type: "set_privacy", action: "grant", service: "camera", bundleId: "app.joko.fixture" },
    { type: "set_status_bar", overrides: statusOverrides },
    { type: "clear_status_bar" },
    { type: "push_notification", bundleId: "app.joko.fixture", payload: pushPayload }
  ]);
  expect((await provider.callTool("call_tool", { name: "doctor", args: {} }, undefined, scope))
    .structuredContent).toMatchObject({ data: { availability: {
      set_orientation: { state: "available", backend: "wda" },
      set_appearance: { state: "available", backend: "simctl" },
      set_location: { state: "available", backend: "simctl" },
      clear_location: { state: "available", backend: "simctl" },
      set_privacy: { state: "available", backend: "simctl" },
      clear_status_bar: { state: "available", backend: "simctl" },
      push_notification: { state: "available", backend: "simctl" }
    } } });
  ready = false;
  expect(await invoke("set_appearance", { ...route, appearance: "light" }))
    .toMatchObject({ errorCode: "XCODE_NOT_FOUND" });
  expect(calls).toHaveLength(11);
});
