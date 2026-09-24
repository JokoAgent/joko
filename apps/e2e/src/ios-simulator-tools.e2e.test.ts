import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CredentialManager, CredentialVault, IOS_SIMULATOR_TOOL_PROVIDER_ID, IosSimulatorToolBridgeProvider,
  McpRouter, SimulatorOwnershipRegistry, createInternalServer, createOrchestratorApplication, type OrchestratorConfig
} from "@joko/orchestrator";
import { expect, it } from "vitest";
import { OrchestratorE2eFixture } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

it("returns the platform diagnosis through authenticated Connect and task Tool dispatch", async () => {
  let fixture: OrchestratorE2eFixture | undefined;
  let internal: Awaited<ReturnType<typeof createInternalServer>> | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({
      createAuxiliaryServices: async (store, directory, artifacts) => {
        const vault = await CredentialVault.open(join(directory, "simulator-vault.key"));
        const credentials = new CredentialManager({ vault, storagePath: join(directory, "simulator-credentials.json") });
        await credentials.initialize();
        const mcpRouter = new McpRouter({ store, credentials, resultArtifacts: artifacts });
        await mcpRouter.initialize();
        mcpRouter.registerBridgeToolProvider(new IosSimulatorToolBridgeProvider({ store, ownership: new SimulatorOwnershipRegistry(store) }));
        return { mcpRouter };
      }
    });
    internal = await createInternalServer(fixture.application);
    const url = await internal.listen({ host: "127.0.0.1", port: 0 });
    const paired = await fixture.pair();
    const [backendId, targetId] = [...fixture.targets][0]!;
    const sessionId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId, createSessionMutation({ backendId, targetId })));
    const generation = fixture.application.store.getSession(sessionId).descriptor.binding.generation;
    const bridge = fixture.application.mcpRouter!.createPiBridgeSnapshot({ endpoint: `${url}/internal/mcp`, sessionId, targetId, expectedPiGeneration: generation });
    expect(bridge.mcpBridge.tools.filter(tool => tool.serverId === IOS_SIMULATOR_TOOL_PROVIDER_ID).map(tool => tool.name)).toEqual(["call_tool", "list_tools"]);
    const call = async (toolName: string, args: Record<string, unknown>) => {
      const response = await fetch(`${url}/internal/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.mcpBridge.token}`, "content-type": "application/json", "x-joko-pi-generation": String(generation) },
        body: JSON.stringify({ requestId: randomUUID(), sessionId, targetId, generation,
          serverId: IOS_SIMULATOR_TOOL_PROVIDER_ID, toolName, arguments: args })
      });
      expect(response.ok).toBe(true);
      return await response.json() as { isError: boolean; details: { mcpStructuredContent: Record<string, unknown> } };
    };
    expect(await call("list_tools", { category: "ios_simulator" })).toMatchObject({ isError: false, details: { mcpStructuredContent: {
      tools: [{ name: "check_environment" }, { name: "doctor" }, { name: "list_simulator_devices" }, { name: "list_instances" }]
    } } });
    expect(await call("call_tool", { name: "list_instances", args: {} })).toMatchObject({ isError: false, details: {
      mcpStructuredContent: { data: { instances: [] } }
    } });
    const owned = new SimulatorOwnershipRegistry(fixture.application.store).bindExternalDevice(
      { sessionId, targetId, generation },
      { udid: "A0123456-1234-1234-1234-123456789ABC", name: "iPhone test", state: "Shutdown",
        isAvailable: true, runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0",
        runtimeName: "iOS 19.0", runtimeVersion: "19.0",
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", lastBootedAt: null }
    );
    expect(await call("call_tool", { name: "list_instances", args: {} })).toMatchObject({ isError: false, details: {
      mcpStructuredContent: { data: { instances: [{ instanceId: owned.instanceId, simulatorUdid: owned.simulatorUdid }] } }
    } });
    const diagnosis = await call("call_tool", { name: "doctor", args: {} });
    if (process.platform === "win32") expect(diagnosis).toMatchObject({ isError: false, details: { mcpStructuredContent: {
      data: { environment: { issue: "UNSUPPORTED_PLATFORM" }, availability: {
        list_simulator_devices: { state: "unavailable", reasonCode: "UNSUPPORTED_PLATFORM" }
      }, resources: { state: "unavailable", reasonCode: "UNSUPPORTED_PLATFORM" },
      instanceControl: { state: "unavailable" } }
    } } });
    const environment = await call("call_tool", { name: "check_environment", args: {} });
    if (process.platform === "win32") expect(environment).toMatchObject({ isError: false, details: { mcpStructuredContent: {
      data: { supported: false, ready: false, issue: "UNSUPPORTED_PLATFORM" }
    } } });
    const devices = await call("call_tool", { name: "list_simulator_devices", args: {} });
    if (process.platform === "win32") expect(devices).toMatchObject({ isError: true, details: { mcpStructuredContent: { errorCode: "UNSUPPORTED_PLATFORM" } } });
    bridge.revoke();
  } finally {
    await internal?.close();
    await fixture?.close();
  }
});

it("registers Simulator discovery in the production application composition", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-simulator-app-"));
  const workspace = join(root, "workspace");
  const dataDirectory = join(root, "data");
  await mkdir(workspace);
  const config: OrchestratorConfig = {
    host: "127.0.0.1", port: 0, internalPort: 4317, publicOrigin: "http://127.0.0.1", internalOrigin: "http://127.0.0.1:4317",
    dataDirectory, databasePath: join(dataDirectory, "orchestrator.db"), allowInsecureLoopback: true, allowInsecureLan: false,
    lanDiscoveryEnabled: false, codexExecutable: join(root, "missing-codex"), piAgentHome: join(dataDirectory, "pi"),
    workspace: { id: "workspace", root: workspace, displayName: "Simulator fixture", trusted: true },
    artifactDirectory: join(dataDirectory, "artifacts"), webDirectory: join(root, "no-web"), corsOrigins: [],
    iosSimulatorDriver: { archivePath: join(root, "missing-source.tar.gz"), cacheRoot: join(dataDirectory, "driver-cache") }
  };
  const application = await createOrchestratorApplication(config);
  try {
    const target = application.store.getTarget("workspace").descriptor;
    application.store.createSession({ id: "simulator-task", backendId: target.backendId, targetId: target.id, title: "Simulator task",
      binding: { opaqueRef: "simulator-task-native", generation: 1 }, pinned: false, archived: false,
      permissionMode: "ask", planMode: false, fastMode: false, createdAt: Date.now(), updatedAt: Date.now() });
    const snapshot = application.mcpRouter!.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1/internal/mcp", sessionId: "simulator-task", targetId: target.id, expectedPiGeneration: 1 });
    const simulatorTools = snapshot.mcpBridge.tools.filter(tool => tool.serverId === IOS_SIMULATOR_TOOL_PROVIDER_ID);
    expect(simulatorTools.map(tool => tool.name)).toEqual(["call_tool", "control_tool", "list_tools"]);
    expect(simulatorTools.find(tool => tool.name === "call_tool")?.requiresPermission).toBe(false);
    expect(simulatorTools.find(tool => tool.name === "control_tool")?.requiresPermission).toBe(true);
    if (process.platform === "win32") {
      const internal = await createInternalServer(application);
      try {
        const url = await internal.listen({ host: "127.0.0.1", port: 0 });
        const response = await fetch(`${url}/internal/mcp`, { method: "POST", headers: {
          authorization: `Bearer ${snapshot.mcpBridge.token}`, "content-type": "application/json",
          "x-joko-pi-generation": "1"
        }, body: JSON.stringify({ requestId: randomUUID(), sessionId: "simulator-task", targetId: target.id,
          generation: 1, serverId: IOS_SIMULATOR_TOOL_PROVIDER_ID, toolName: "control_tool",
          arguments: { name: "create_instance", args: {
            templateUdid: "A0123456-1234-1234-1234-123456789ABC", name: "Joko iPhone" } } }) });
        expect(response.ok).toBe(true);
        expect(await response.json()).toMatchObject({ isError: true, details: {
          mcpStructuredContent: { errorCode: "UNSUPPORTED_PLATFORM" }
        } });
        expect(application.store.listOperations({ sessionId: "simulator-task" })).toEqual([]);
      } finally { await internal.close(); }
    }
    snapshot.revoke();
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("runs task-bound Simulator attach, live diagnosis and detach through production HTTP and SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-simulator-control-"));
  const workspace = join(root, "workspace");
  const dataDirectory = join(root, "data");
  await mkdir(workspace);
  const config: OrchestratorConfig = {
    host: "127.0.0.1", port: 0, internalPort: 4317, publicOrigin: "http://127.0.0.1", internalOrigin: "http://127.0.0.1:4317",
    dataDirectory, databasePath: join(dataDirectory, "orchestrator.db"), allowInsecureLoopback: true, allowInsecureLan: false,
    lanDiscoveryEnabled: false, codexExecutable: join(root, "missing-codex"), piAgentHome: join(dataDirectory, "pi"),
    workspace: { id: "workspace", root: workspace, displayName: "Simulator fixture", trusted: true },
    artifactDirectory: join(dataDirectory, "artifacts"), webDirectory: join(root, "no-web"), corsOrigins: [],
    iosSimulatorDriver: { archivePath: join(root, "pinned-source.tar.gz"), cacheRoot: join(dataDirectory, "driver-cache") }
  };
  const udid = "A0123456-1234-1234-1234-123456789ABC";
  const device = { udid, name: "Existing iPhone", state: "Booted", isAvailable: true,
    runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0", runtimeName: "iOS 19.0",
    runtimeVersion: "19.0", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", lastBootedAt: null };
  const events: string[] = [];
  let wdaPort = 0;
  let ownerFingerprint = "";
  let screenLabel = "Continue";
  const inputs: Array<{ url: string; body: unknown; claimed: boolean }> = [];
  let active: { instanceId: string; simulatorUdid: string; leaseId: string; pid: number;
    controlPort: number; mjpegPort: number; sourceRevision: string; buildCacheKey: string;
    driverSessionId: string; health: { ready: true; message: null; osName: string;
      osVersion: string; sdkVersion: string; deviceIp: null }; state: "ready" } | null = null;
  const application = await createOrchestratorApplication(config, { simulatorRuntime: {
    environment: { inspect: async () => ({ platform: "darwin", supported: true, ready: true,
      xcodeVersion: "Xcode 16.4\nBuild version 16F6", runtimes: [], devices: [device], issue: null,
      error: null, setupSteps: [] }) },
    lifecycle: { findExact: async value => value.toUpperCase() === udid ? device : null,
      bootExact: async () => { throw new Error("Unexpected boot."); },
      shutdownExact: async () => { throw new Error("Preexisting device must remain booted."); } },
    driver: { architecture: "arm64", cleanupOrphans: async () => { events.push("orphan-cleanup"); },
      manager: { get: () => active,
        retryOwnedCleanup: async () => { events.push("retry-cleanup"); },
        start: async options => { events.push("driver-start");
          ownerFingerprint = createHash("sha256").update([
            resolve(join(dataDirectory, "driver-cache")), options.instanceId,
            options.simulatorUdid.toUpperCase()
          ].join("\0")).digest("hex");
          active = { instanceId: options.instanceId, simulatorUdid: options.simulatorUdid,
            leaseId: "B0123456-1234-1234-1234-123456789ABC", pid: 301, controlPort: wdaPort, mjpegPort: 19100,
            sourceRevision: "5f8280e761dc0b5b9b28368e63a8f0cc8d868346", buildCacheKey: "a".repeat(64),
            driverSessionId: "SESSION-1", health: { ready: true, message: null, osName: "iOS",
              osVersion: "19.0", sdkVersion: "19.0", deviceIp: null }, state: "ready" };
          return active; },
        stop: async () => { events.push("driver-stop"); active = null; } } }
  } });
  const wda = createServer((request, response) => {
    const send = (value: unknown): void => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ value }));
    };
    if (request.method === "POST" && request.url && [
      "/session/SESSION-1/actions", "/session/SESSION-1/wda/keys",
      "/session/SESSION-1/wda/pressButton"
    ].includes(request.url)) {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const claimed = application.store.listOperations({ sessionId: "simulator-task", status: "started" })
          .some(operation => operation.kind === "ios_simulator_input");
        inputs.push({ url: request.url!, body: JSON.parse(Buffer.concat(chunks).toString("utf8")), claimed });
        screenLabel = `Input ${inputs.length}`;
        send(null);
      });
      return;
    }
    if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
    if (request.url === "/status") send({ ready: true, build: { upgradedAt: ownerFingerprint } });
    else if (request.url === "/session/SESSION-1/source?format=json") send({
      type: "XCUIElementTypeOther", children: [{ type: "XCUIElementTypeButton", label: screenLabel,
        rect: { x: 10, y: 10, width: 120, height: 44 }, privatePath: "/private/driver-only" }]
    });
    else if (request.url === "/session/SESSION-1/window/size") send({ width: 393, height: 852 });
    else if (request.url === "/session/SESSION-1/orientation") send("PORTRAIT");
    else { response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ value: { error: "invalid session id" } })); }
  });
  let internal: Awaited<ReturnType<typeof createInternalServer>> | undefined;
  try {
    await new Promise<void>(done => wda.listen(0, "127.0.0.1", done));
    const address = wda.address();
    if (!address || typeof address === "string") throw new Error("WDA loopback port was not allocated.");
    wdaPort = address.port;
    const target = application.store.getTarget("workspace").descriptor;
    application.store.createSession({ id: "simulator-task", backendId: target.backendId, targetId: target.id,
      title: "Simulator task", binding: { opaqueRef: "simulator-task-native", generation: 1 },
      pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false,
      createdAt: Date.now(), updatedAt: Date.now() });
    internal = await createInternalServer(application);
    const url = await internal.listen({ host: "127.0.0.1", port: 0 });
    const snapshot = application.mcpRouter!.createPiBridgeSnapshot({ endpoint: `${url}/internal/mcp`,
      sessionId: "simulator-task", targetId: target.id, expectedPiGeneration: 1 });
    const call = async (toolName: string, name: string, args: Record<string, unknown>) => {
      const response = await fetch(`${url}/internal/mcp`, { method: "POST", headers: {
        authorization: `Bearer ${snapshot.mcpBridge.token}`, "content-type": "application/json",
        "x-joko-pi-generation": "1"
      }, body: JSON.stringify({ requestId: randomUUID(), sessionId: "simulator-task", targetId: target.id,
        generation: 1, serverId: IOS_SIMULATOR_TOOL_PROVIDER_ID, toolName,
        arguments: { name, args } }) });
      expect(response.ok).toBe(true);
      return await response.json() as { isError: boolean; details: { mcpStructuredContent: {
        data?: { instance?: { instanceId: string; generation: number; lease: { id: string };
          viewerState: string; graceExpiresAt: number | null };
          drivers?: { state: string; instances: readonly { state: string }[] };
          screenMap?: Record<string, unknown> & { snapshotId: string;
            elements?: readonly { elementId: string; label: string }[] };
          observation?: { mode: string; screenMap: Record<string, unknown> & {
            snapshotId: string; elements: readonly { elementId: string; label: string }[] } } | null;
          action?: string; backend?: string; screenMapInvalidated?: boolean;
          viewport?: { width: number; height: number; orientation: string };
          audit?: { violationCount: number }; diff?: { baselineSnapshotId: string;
            added: readonly unknown[]; removed: readonly unknown[] };
          timedOut?: boolean };
        errorCode?: string } } };
    };
    const attached = await call("control_tool", "attach_device", { udid });
    expect(attached).toMatchObject({ isError: false, details: { mcpStructuredContent: { data: {
      instance: { simulatorUdid: udid, viewerState: "attached", bootProvenance: "preexisting" }
    } } } });
    const instance = attached.details.mcpStructuredContent.data!.instance!;
    expect(events).toEqual(["retry-cleanup", "orphan-cleanup", "driver-start"]);
    const doctor = await call("call_tool", "doctor", {});
    expect(doctor.details.mcpStructuredContent.data?.drivers).toMatchObject({ state: "available",
      instances: [{ state: "ready" }] });
    expect(doctor.details.mcpStructuredContent.data).toMatchObject({ availability: {
      get_screen_map: { state: "available" }, wait_for_ui: { state: "available" },
      tap: { state: "available", backend: "wda" }, press_home: { state: "available" }
    } });
    const route = { instanceId: instance.instanceId, generation: instance.generation, leaseId: instance.lease.id };
    const mapped = await call("control_tool", "get_screen_map", route);
    expect(mapped).toMatchObject({ isError: false, details: { mcpStructuredContent: { data: {
      screenMap: { instanceId: instance.instanceId, elements: [{ label: "Continue" }] },
      viewport: { width: 393, height: 852, orientation: "PORTRAIT" }
    } } } });
    expect(JSON.stringify(mapped)).not.toContain("driver-only");
    const baseline = mapped.details.mcpStructuredContent.data!.screenMap!;
    expect(await call("control_tool", "audit_accessibility", { ...route })).toMatchObject({
      isError: false, details: { mcpStructuredContent: { data: {
        audit: { violationCount: 0 }
      } } }
    });
    screenLabel = "Next";
    const compared = await call("control_tool", "compare_screen_maps", { ...route, baseline });
    expect(compared).toMatchObject({ isError: false, details: { mcpStructuredContent: { data: {
      diff: { baselineSnapshotId: baseline.snapshotId, added: [expect.any(Object)],
        removed: [expect.any(Object)] }
    } } } });
    const waited = await call("control_tool", "wait_for_ui", { ...route,
      condition: { kind: "element_exists", selector: { labelContains: "Next" } },
      timeoutMs: 1_000, pollIntervalMs: 100, stableForMs: 100 });
    expect(waited).toMatchObject({
      isError: false, details: { mcpStructuredContent: { data: { timedOut: false,
        screenMap: { elements: [{ label: "Next" }] } } } }
    });
    expect(await call("control_tool", "wait_for_ui", { ...route,
      condition: { kind: "element_exists", selector: {} } })).toMatchObject({
      isError: true, details: { mcpStructuredContent: { errorCode: "INVALID_ARGUMENT" } }
    });
    const current = waited.details.mcpStructuredContent.data!.screenMap!;
    const elementId = current.elements![0]!.elementId;
    const tapped = await call("control_tool", "tap", { ...route,
      snapshotId: current.snapshotId, elementId, observeAfter: "stable",
      observeTimeoutMs: 1_000, stableForMs: 100 });
    expect(tapped).toMatchObject({ isError: false, details: { mcpStructuredContent: { data: {
      action: "tap", backend: "wda", screenMapInvalidated: false,
      observation: { mode: "stable", timedOut: false,
        screenMap: { elements: [{ label: "Input 1" }] } }
    } } } });
    const afterTap = tapped.details.mcpStructuredContent.data!.observation!.screenMap;
    const swiped = await call("control_tool", "swipe", { ...route,
      snapshotId: afterTap.snapshotId, startX: 20, startY: 200, endX: 20, endY: 50,
      durationMs: 300, observeAfter: "immediate" });
    expect(swiped).toMatchObject({ isError: false, details: { mcpStructuredContent: { data: {
      action: "swipe", observation: { screenMap: { elements: [{ label: "Input 2" }] } }
    } } } });
    const afterSwipe = swiped.details.mcpStructuredContent.data!.observation!.screenMap;
    const secret = "ephemeral simulator text";
    const typed = await call("control_tool", "type_simulator_text", { ...route,
      snapshotId: afterSwipe.snapshotId, text: secret, observeAfter: "immediate" });
    expect(typed).toMatchObject({ isError: false, details: { mcpStructuredContent: { data: {
      action: "type_text", observation: { screenMap: { elements: [{ label: "Input 3" }] } }
    } } } });
    const afterType = typed.details.mcpStructuredContent.data!.observation!.screenMap;
    expect(await call("control_tool", "press_home", { ...route,
      snapshotId: afterType.snapshotId })).toMatchObject({ isError: false,
      details: { mcpStructuredContent: { data: { action: "press_home",
        screenMapInvalidated: true, observation: null } } } });
    expect(inputs.map(item => item.url)).toEqual([
      "/session/SESSION-1/actions", "/session/SESSION-1/actions",
      "/session/SESSION-1/wda/keys", "/session/SESSION-1/wda/pressButton"
    ]);
    expect(inputs.every(item => item.claimed)).toBe(true);
    const inputOperations = application.store.listOperations({ sessionId: "simulator-task" })
      .filter(operation => operation.kind === "ios_simulator_input")
      .map(operation => ({ body: operation.body,
        response: "response" in operation ? operation.response : null }));
    expect(inputOperations).toHaveLength(4);
    expect(JSON.stringify(inputOperations)).not.toContain(secret);
    const detached = await call("control_tool", "detach_device", { instanceId: instance.instanceId,
      generation: instance.generation, leaseId: instance.lease.id });
    expect(detached).toMatchObject({ isError: false, details: { mcpStructuredContent: { data: {
      instance: { viewerState: "detached", graceExpiresAt: null }
    } } } });
    expect((await call("control_tool", "get_screen_map", route)).isError).toBe(true);
    expect(events).toEqual(["retry-cleanup", "orphan-cleanup", "driver-start", "driver-stop",
      "retry-cleanup", "orphan-cleanup"]);
    expect((await call("call_tool", "list_instances", {})).details.mcpStructuredContent.data)
      .toMatchObject({ instances: [] });
    snapshot.revoke();
  } finally {
    await internal?.close();
    await application.close();
    wda.closeAllConnections();
    await new Promise<void>(done => wda.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
