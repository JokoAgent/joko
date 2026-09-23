import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialManager, CredentialVault, IOS_SIMULATOR_TOOL_PROVIDER_ID, IosSimulatorToolBridgeProvider,
  McpRouter, createInternalServer, createOrchestratorApplication, type OrchestratorConfig
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
        mcpRouter.registerBridgeToolProvider(new IosSimulatorToolBridgeProvider({ store }));
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
      tools: [{ name: "check_environment" }, { name: "list_simulator_devices" }]
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
    artifactDirectory: join(dataDirectory, "artifacts"), webDirectory: join(root, "no-web"), corsOrigins: []
  };
  const application = await createOrchestratorApplication(config);
  try {
    const target = application.store.getTarget("workspace").descriptor;
    application.store.createSession({ id: "simulator-task", backendId: target.backendId, targetId: target.id, title: "Simulator task",
      binding: { opaqueRef: "simulator-task-native", generation: 1 }, pinned: false, archived: false,
      permissionMode: "ask", planMode: false, fastMode: false, createdAt: Date.now(), updatedAt: Date.now() });
    const snapshot = application.mcpRouter!.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1/internal/mcp", sessionId: "simulator-task", targetId: target.id, expectedPiGeneration: 1 });
    expect(snapshot.mcpBridge.tools.filter(tool => tool.serverId === IOS_SIMULATOR_TOOL_PROVIDER_ID).map(tool => tool.name)).toEqual(["call_tool", "list_tools"]);
    snapshot.revoke();
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
