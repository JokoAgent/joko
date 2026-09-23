import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialManager, CredentialVault, DocumentToolBridgeProvider, McpRouter, createInternalServer, createOrchestratorApplication, type OrchestratorConfig } from "@joko/orchestrator";
import { expect, it } from "vitest";
import { OrchestratorE2eFixture } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

it("creates and reads back a Word document through an authenticated task Tool bridge", async () => {
  let fixture: OrchestratorE2eFixture | undefined;
  let internal: Awaited<ReturnType<typeof createInternalServer>> | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({
      createAuxiliaryServices: async (store, directory, artifacts) => {
        const vault = await CredentialVault.open(join(directory, "document-vault.key"));
        const credentials = new CredentialManager({ vault, storagePath: join(directory, "document-credentials.json") });
        await credentials.initialize();
        const mcpRouter = new McpRouter({ store, credentials, resultArtifacts: artifacts });
        await mcpRouter.initialize();
        mcpRouter.registerBridgeToolProvider(new DocumentToolBridgeProvider({ store }));
        return { mcpRouter };
      }
    });
    internal = await createInternalServer(fixture.application);
    const internalUrl = await internal.listen({ host: "127.0.0.1", port: 0 });
    const paired = await fixture.pair();
    const [backendId, targetId] = [...fixture.targets][0]!;
    const sessionId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId, createSessionMutation({ backendId, targetId })));
    const generation = fixture.application.store.getSession(sessionId).descriptor.binding.generation;
    const bridge = fixture.application.mcpRouter!.createPiBridgeSnapshot({ endpoint: `${internalUrl}/internal/mcp`, sessionId, targetId, expectedPiGeneration: generation });
    expect(bridge.mcpBridge.tools.filter(tool => tool.serverId === "joko-document-tools").map(tool => tool.name)).toEqual(["make_docx", "make_pptx", "make_xlsx"]);
    const call = async (markdown: string, overwrite = false) => {
      const response = await fetch(`${internalUrl}/internal/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.mcpBridge.token}`,
          "content-type": "application/json",
          "x-joko-pi-generation": String(generation)
        },
        body: JSON.stringify({
          requestId: randomUUID(),
          sessionId,
          targetId,
          generation,
          serverId: "joko-document-tools",
          toolName: "make_docx",
          arguments: { markdown, outPath: "documents/report.docx", title: "Task report", overwrite }
        })
      });
      expect(response.ok).toBe(true);
      return await response.json() as { isError: boolean; details: { mcpStructuredContent: Record<string, unknown> } };
    };
    const created = await call("# First\n\nA **real** document.");
    expect(created).toMatchObject({ isError: false, details: { mcpStructuredContent: { format: "docx", relativePath: join("documents", "report.docx") } } });
    const path = join(fixture.workspaceDirectory, "documents", "report.docx");
    const first = await readFile(path);
    expect(first.subarray(0, 2).toString("ascii")).toBe("PK");
    expect(first.length).toBe(created.details.mcpStructuredContent["bytes"]);
    expect(await call("# Rejected")).toMatchObject({ isError: true, details: { mcpStructuredContent: { errorCode: "FILE_EXISTS" } } });
    expect(await readFile(path)).toEqual(first);
    expect(await call("# Replacement", true)).toMatchObject({ isError: false, details: { mcpStructuredContent: { format: "docx" } } });
    expect(await readFile(path)).not.toEqual(first);
    bridge.revoke();
  } finally {
    await internal?.close();
    await fixture?.close();
  }
});

it("advertises the document tool from the production application composition", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-document-app-"));
  const workspace = join(root, "workspace");
  const dataDirectory = join(root, "data");
  await mkdir(workspace);
  const config: OrchestratorConfig = {
    host: "127.0.0.1", port: 0, internalPort: 4317, publicOrigin: "http://127.0.0.1", internalOrigin: "http://127.0.0.1:4317",
    dataDirectory, databasePath: join(dataDirectory, "orchestrator.db"), allowInsecureLoopback: true, allowInsecureLan: false,
    lanDiscoveryEnabled: false, codexExecutable: join(root, "missing-codex"), piAgentHome: join(dataDirectory, "pi"),
    workspace: { id: "workspace", root: workspace, displayName: "Document fixture", trusted: true },
    artifactDirectory: join(dataDirectory, "artifacts"), webDirectory: join(root, "no-web"), corsOrigins: []
  };
  const application = await createOrchestratorApplication(config);
  let internal: Awaited<ReturnType<typeof createInternalServer>> | undefined;
  try {
    const target = application.store.getTarget("workspace").descriptor;
    application.store.createSession({
      id: "document-task", backendId: target.backendId, targetId: target.id, title: "Document task",
      binding: { opaqueRef: "document-task-native", generation: 1 },
      pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false,
      createdAt: Date.now(), updatedAt: Date.now()
    });
    internal = await createInternalServer(application);
    const url = await internal.listen({ host: "127.0.0.1", port: 0 });
    const bridge = application.mcpRouter!.createPiBridgeSnapshot({
      endpoint: `${url}/internal/mcp`,
      sessionId: "document-task",
      targetId: target.id,
      expectedPiGeneration: 1
    });
    expect(bridge.mcpBridge.tools.filter(tool => tool.serverId === "joko-document-tools").map(tool => tool.name)).toEqual(["make_docx", "make_pptx", "make_xlsx"]);
    const response = await fetch(`${url}/internal/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.mcpBridge.token}`,
        "content-type": "application/json",
        "x-joko-pi-generation": "1"
      },
      body: JSON.stringify({
        requestId: randomUUID(), sessionId: "document-task", targetId: target.id, generation: 1,
        serverId: "joko-document-tools", toolName: "make_docx",
        arguments: { markdown: "# Production composition", outPath: "documents/actual.docx" }
      })
    });
    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({ isError: false, details: { mcpStructuredContent: { format: "docx" } } });
    expect((await readFile(join(workspace, "documents", "actual.docx"))).subarray(0, 2).toString("ascii")).toBe("PK");
    const presentationResponse = await fetch(`${url}/internal/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.mcpBridge.token}`,
        "content-type": "application/json",
        "x-joko-pi-generation": "1"
      },
      body: JSON.stringify({
        requestId: randomUUID(), sessionId: "document-task", targetId: target.id, generation: 1,
        serverId: "joko-document-tools", toolName: "make_pptx",
        arguments: { slides: [
          { layout: "cover", title: "Production composition" },
          { layout: "metrics", title: "Outcomes", metrics: [{ value: "98%", label: "Uptime" }, { value: 12, label: "Regions" }] }
        ], outPath: "documents/actual.pptx", title: "Production composition", theme: "navy" }
      })
    });
    expect(presentationResponse.ok).toBe(true);
    expect(await presentationResponse.json()).toMatchObject({ isError: false, details: { mcpStructuredContent: {
      format: "pptx", slides: 2, layouts: ["cover", "metrics"], relativePath: join("documents", "actual.pptx")
    } } });
    expect((await readFile(join(workspace, "documents", "actual.pptx"))).subarray(0, 2).toString("ascii")).toBe("PK");
    const workbookResponse = await fetch(`${url}/internal/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.mcpBridge.token}`,
        "content-type": "application/json",
        "x-joko-pi-generation": "1"
      },
      body: JSON.stringify({
        requestId: randomUUID(), sessionId: "document-task", targetId: target.id, generation: 1,
        serverId: "joko-document-tools", toolName: "make_xlsx",
        arguments: { sheets: [{ name: "Results", header: ["Metric", "Value"], rows: [
          ["Uptime", 0.98], ["Total", { formula: "SUM(B2:B2)", result: 0.98 }]
        ] }], outPath: "documents/actual.xlsx", theme: "navy" }
      })
    });
    expect(workbookResponse.ok).toBe(true);
    expect(await workbookResponse.json()).toMatchObject({ isError: false, details: { mcpStructuredContent: {
      format: "xlsx", sheets: [{ name: "Results", rows: 2 }], relativePath: join("documents", "actual.xlsx")
    } } });
    expect((await readFile(join(workspace, "documents", "actual.xlsx"))).subarray(0, 2).toString("ascii")).toBe("PK");
    bridge.revoke();
  } finally {
    await internal?.close();
    await application.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
