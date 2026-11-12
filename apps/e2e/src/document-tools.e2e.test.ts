import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext, PromptInput } from "@joko/core";
import { CredentialManager, CredentialVault, DocumentToolBridgeProvider, McpRouter, createInternalServer, createOrchestratorApplication, type OrchestratorConfig } from "@joko/orchestrator";
import { expect, it } from "vitest";
import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, queueItemIdFrom, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

function visiblePdf(): Buffer {
  const stream = "BT /F1 24 Tf 72 760 Td (Visible report) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [5 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>"
  ];
  let output = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(output.length); output += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}

it("delivers exact Word replacements through the authenticated task Tool bridge and Artifact history", async () => {
  let fixture: OrchestratorE2eFixture | undefined;
  let internal: Awaited<ReturnType<typeof createInternalServer>> | undefined;
  const dispatch: { turn?: AdapterContext } = {};
  const releaseDelivery = Promise.withResolvers<void>();
  let holdDelivery = false;
  let deliveryWaiting = false;
  try {
    fixture = await OrchestratorE2eFixture.start({
      createAdapter: profile => new class extends InstrumentedFakeAdapter {
        override async send(_input: PromptInput, context: AdapterContext): Promise<void> { dispatch.turn = context; }
      }(profile),
      createAuxiliaryServices: async (store, directory, artifacts) => {
        const vault = await CredentialVault.open(join(directory, "document-vault.key"));
        const credentials = new CredentialManager({ vault, storagePath: join(directory, "document-credentials.json") });
        await credentials.initialize();
        const mcpRouter = new McpRouter({ store, credentials, resultArtifacts: artifacts });
        await mcpRouter.initialize();
        mcpRouter.setNativeToolAdmission((...args) => fixture!.application.sessionHost.authorizeNativeBridgeTool(...args));
        mcpRouter.registerBridgeToolProvider(new DocumentToolBridgeProvider({
          store, redactText: value => credentials.redactText(value),
          artifacts: {
            ingestBytes: async (bytes, options) => {
              if (holdDelivery) {
                deliveryWaiting = true;
                await releaseDelivery.promise;
              }
              return artifacts.ingestBytes(bytes, options);
            }
          }
        }));
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
    expect(bridge.mcpBridge.tools.filter(tool => tool.serverId === "joko-document-tools").map(tool => tool.name)).toEqual(["inspect_pdf", "make_docx", "make_pptx", "make_xlsx", "read_sheet"]);
    const call = async (markdown: string, overwrite = false, requestId = randomUUID(), outPath = "documents/report.docx") => {
      const response = await fetch(`${internalUrl}/internal/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.mcpBridge.token}`,
          "content-type": "application/json",
          "x-joko-pi-generation": String(generation)
        },
        body: JSON.stringify({
          requestId,
          sessionId,
          targetId,
          generation,
          serverId: "joko-document-tools",
          toolName: "make_docx",
          arguments: { markdown, outPath, title: "Task report", overwrite }
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

    const accepted = await submit(paired.clients.operation, paired.connectionId, sendInputMutation(sessionId, BigInt(generation), "Update the existing report."));
    const queueItemId = queueItemIdFrom(accepted);
    const runId = queueRunIdFrom(accepted);
    await waitFor(async () => fixture!.application.store.getQueueItem(queueItemId).state, state => state === "backend_accepted", "document Run input accepted");
    const attemptId = fixture.application.store.getQueueItem(queueItemId).attemptId;
    if (attemptId === undefined) throw new Error("The document Run has no accepted Attempt.");
    const rejectedId = randomUUID();
    const rejected = await call("# Rejected", false, rejectedId);
    expect(rejected).toMatchObject({ isError: true, details: { mcpStructuredContent: { errorCode: "FILE_EXISTS" } } });
    expect(await readFile(path)).toEqual(first);
    const replacementId = randomUUID();
    const replacement = await call("# Replacement", true, replacementId);
    expect(replacement).toMatchObject({ isError: false, details: { mcpStructuredContent: { format: "docx" } } });
    const replacementBytes = await readFile(path);
    expect(replacementBytes).not.toEqual(first);
    expect(await call("# Final version", true)).toMatchObject({ isError: false });
    const finalBytes = await readFile(path);
    expect(finalBytes).not.toEqual(replacementBytes);

    expect(await call("# Rejected", false, rejectedId)).toEqual(rejected);
    expect(await call("# Replacement", true, replacementId)).toEqual(replacement);
    expect(await call("# Conflicting request", false, replacementId, "documents/conflict.docx")).toMatchObject({
      isError: true, details: { mcpStructuredContent: { errorCode: "OUTPUT_REQUEST_CONFLICT" } }
    });
    await expect(readFile(join(fixture.workspaceDirectory, "documents", "conflict.docx"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path)).toEqual(finalBytes);
    expect(await call("# New file", true, randomUUID(), "documents/new.docx")).toMatchObject({ isError: false });

    holdDelivery = true;
    const late = call("# Written before the Run ended", true).catch((error: unknown) => error);
    await waitFor(async () => deliveryWaiting, waiting => waiting, "document write verified before Artifact storage");
    expect(await readFile(path)).not.toEqual(finalBytes);
    const turn = dispatch.turn;
    if (turn === undefined) throw new Error("The document Run was not dispatched.");
    await turn.emit({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "The report is ready." }] });
    await turn.emit({ type: "done", outcome: "completed" });
    await waitFor(async () => fixture!.application.store.getQueueItem(queueItemId).state, state => state === "completed", "document Run retired");
    releaseDelivery.resolve();
    expect(await late).toMatchObject({ isError: true });
    const reconnected = fixture.clients(paired.authKey);
    const history = await reconnected.session.listSessionTimeline({ sessionId, limit: 100 });
    const deliveries = history.events.flatMap(event => event.payload?.kind.case === "artifactProduced"
      ? [{ identity: event.identity, artifact: event.payload.kind.value.artifact }]
      : []);
    expect(deliveries).toHaveLength(2);
    for (const bytes of [replacementBytes, finalBytes]) {
      const hash = createHash("sha256").update(bytes).digest("hex");
      const delivery = deliveries.find(({ artifact }) => artifact?.blob?.sha256Hex === hash);
      expect(delivery).toMatchObject({
        identity: { sessionId, runId, attemptId },
        artifact: { sessionId, runId, blob: { fileName: "report.docx", sha256Hex: hash } }
      });
      const blobId = delivery?.artifact?.blob?.blobId;
      if (blobId === undefined) throw new Error("The delivered document has no Blob identity.");
      const { ticket } = await reconnected.artifact.getBlobDownloadTicket({ blobId });
      if (ticket === undefined) throw new Error("The document download ticket is unavailable.");
      const download = await fetch(`${fixture.baseUrl}${ticket.relativeEndpoint}`, { headers: { authorization: `Bearer ${paired.authKey}` } });
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
    }
    bridge.revoke();
  } finally {
    releaseDelivery.resolve();
    await internal?.close();
    await fixture?.close();
  }
});

it("advertises the document tool from the production application composition", async (context) => {
  const startedAt = performance.now();
  const phases: Array<{ readonly name: string; readonly elapsedMs: number }> = [];
  const observe = (name: string): void => { phases.push({ name, elapsedMs: Math.round(performance.now() - startedAt) }); };
  context.onTestFailed(() => console.error("[document-production-boundary]", JSON.stringify({
    elapsedMs: Math.round(performance.now() - startedAt), phases
  })));
  observe("prepare-workspace");
  const root = await mkdtemp(join(tmpdir(), "joko-document-app-"));
  const workspace = join(root, "workspace");
  const dataDirectory = join(root, "data");
  const browserExecutable = process.env.JOKO_BROWSER_EXECUTABLE;
  const electronExecutable = process.env.JOKO_PDF_ELECTRON_TEST_EXECUTABLE;
  const hasRenderer = Boolean(browserExecutable || electronExecutable);
  await mkdir(workspace);
  const config: OrchestratorConfig = {
    host: "127.0.0.1", port: 0, internalPort: 4317, publicOrigin: "http://127.0.0.1", internalOrigin: "http://127.0.0.1:4317",
    dataDirectory, databasePath: join(dataDirectory, "orchestrator.db"), allowInsecureLoopback: true, allowInsecureLan: false,
    lanDiscoveryEnabled: false, codexExecutable: join(root, "missing-codex"), piAgentHome: join(dataDirectory, "pi"),
    workspace: { id: "workspace", root: workspace, displayName: "Document fixture", trusted: true },
    ...(browserExecutable ? { browser: { executablePath: browserExecutable, headless: true } } : {}),
    ...(electronExecutable ? { pdfRendererHost: { executablePath: electronExecutable,
      ...(process.env.JOKO_PDF_ELECTRON_TEST_APP ? { appPath: process.env.JOKO_PDF_ELECTRON_TEST_APP } : {}) } } : {}),
    artifactDirectory: join(dataDirectory, "artifacts"), webDirectory: join(root, "no-web"), corsOrigins: []
  };
  observe("create-application");
  const application = await createOrchestratorApplication(config);
  let internal: Awaited<ReturnType<typeof createInternalServer>> | undefined;
  try {
    observe("application-ready");
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
    expect(bridge.mcpBridge.tools.filter(tool => tool.serverId === "joko-document-tools").map(tool => tool.name)).toEqual(hasRenderer
      ? ["inspect_pdf", "make_docx", "make_pptx", "make_xlsx", "read_sheet", "render_pdf"]
      : ["inspect_pdf", "make_docx", "make_pptx", "make_xlsx", "read_sheet"]);
    observe("make-docx");
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
    observe("make-pptx");
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
    observe("make-xlsx");
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
    observe("read-sheet");
    const readResponse = await fetch(`${url}/internal/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.mcpBridge.token}`,
        "content-type": "application/json",
        "x-joko-pi-generation": "1"
      },
      body: JSON.stringify({
        requestId: randomUUID(), sessionId: "document-task", targetId: target.id, generation: 1,
        serverId: "joko-document-tools", toolName: "read_sheet",
        arguments: { path: "documents/actual.xlsx", sheet: "Results", startRow: 3, maxRows: 1 }
      })
    });
    expect(readResponse.ok).toBe(true);
    expect(await readResponse.json()).toMatchObject({ isError: false, details: { mcpStructuredContent: {
      format: "xlsx", sheet: "Results", rows: [["Total", 0.98]], totalRows: 3, truncated: false
    } } });
    await writeFile(join(workspace, "documents", "actual.pdf"), visiblePdf());
    observe("inspect-source-pdf");
    const inspectResponse = await fetch(`${url}/internal/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.mcpBridge.token}`,
        "content-type": "application/json",
        "x-joko-pi-generation": "1"
      },
      body: JSON.stringify({
        requestId: randomUUID(), sessionId: "document-task", targetId: target.id, generation: 1,
        serverId: "joko-document-tools", toolName: "inspect_pdf",
        arguments: { path: "documents/actual.pdf" }
      })
    });
    expect(inspectResponse.ok).toBe(true);
    expect(await inspectResponse.json()).toMatchObject({ isError: false, details: { mcpStructuredContent: {
      numPages: 1, pagesInspected: 1, inspectedThrough: 1, verdict: "ok", blankPages: [],
      pages: [{ page: 1, paper: "A4", textPreview: "Visible report", blank: false }]
    } } });
    if (hasRenderer) {
      observe("render-pdf");
      const renderCall = async (html: string, overwrite = false) => {
        const response = await fetch(`${url}/internal/mcp`, {
          method: "POST",
          headers: { authorization: `Bearer ${bridge.mcpBridge.token}`, "content-type": "application/json", "x-joko-pi-generation": "1" },
          body: JSON.stringify({ requestId: randomUUID(), sessionId: "document-task", targetId: target.id, generation: 1,
            serverId: "joko-document-tools", toolName: "render_pdf",
            arguments: { html, outPath: "documents/rendered.pdf", theme: "navy", overwrite } })
        });
        expect(response.ok).toBe(true);
        return await response.json() as { isError: boolean; details: { mcpStructuredContent: Record<string, unknown> } };
      };
      expect(await renderCall("<h1>PDF production chain</h1><p>Rendered text.</p>")).toMatchObject({ isError: false, details: { mcpStructuredContent: {
        format: "pdf", relativePath: join("documents", "rendered.pdf"), templateApplied: true, pageSize: "A4"
      } } });
      const renderedPath = join(workspace, "documents", "rendered.pdf");
      const renderedBytes = await readFile(renderedPath);
      expect(renderedBytes.subarray(0, 5).toString()).toBe("%PDF-");
      observe("reject-existing-pdf");
      expect(await renderCall("<h1>Rejected replacement</h1>")).toMatchObject({ isError: true,
        details: { mcpStructuredContent: { errorCode: "FILE_EXISTS" } } });
      expect(await readFile(renderedPath)).toEqual(renderedBytes);
      observe("replace-pdf");
      expect(await renderCall("<h1>Replacement PDF</h1>", true)).toMatchObject({ isError: false,
        details: { mcpStructuredContent: { format: "pdf" } } });
      expect(await readFile(renderedPath)).not.toEqual(renderedBytes);
      observe("inspect-rendered-pdf");
      const inspectRendered = await fetch(`${url}/internal/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.mcpBridge.token}`, "content-type": "application/json", "x-joko-pi-generation": "1" },
        body: JSON.stringify({ requestId: randomUUID(), sessionId: "document-task", targetId: target.id, generation: 1,
          serverId: "joko-document-tools", toolName: "inspect_pdf", arguments: { path: "documents/rendered.pdf" } })
      });
      expect(inspectRendered.ok).toBe(true);
      const inspection = await inspectRendered.json();
      if (process.env.RUNNER_TEMP !== undefined) {
        const directory = join(process.env.RUNNER_TEMP, "joko-web-evidence", "document-tools");
        const pdf = await readFile(renderedPath);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "rendered-replacement.pdf"), pdf);
        await writeFile(join(directory, "rendered-replacement.json"), JSON.stringify({
          sourceCommit: process.env.GITHUB_SHA,
          sha256: createHash("sha256").update(pdf).digest("hex"),
          inspection
        }, null, 2) + "\n");
      }
      expect(inspection).toMatchObject({ isError: false, details: { mcpStructuredContent: {
        numPages: 1, verdict: "ok", blankPages: [], pages: [{ page: 1, paper: "A4", textPreview: "Replacement PDF", blank: false }]
      } } });
    }
    bridge.revoke();
  } finally {
    observe("close-internal");
    await internal?.close();
    observe("close-application");
    await application.close().catch(() => undefined);
    observe("remove-workspace");
    await rm(root, { recursive: true, force: true });
    observe("cleanup-complete");
  }
});
