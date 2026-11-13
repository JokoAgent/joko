import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AdapterContext, PromptInput } from "@joko/core";
import {
  CredentialManager,
  CredentialVault,
  DocumentToolBridgeProvider,
  ElectronDocumentPdfRenderer,
  McpRouter,
  createInternalServer
} from "@joko/orchestrator";
import { PI_LIKE_PROFILE, type FakeAdapterProfile } from "@joko/testkit";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, expect, it } from "vitest";
import { InstrumentedFakeAdapter, OrchestratorE2eFixture, routeFixtureDiscovery, waitFor } from "./fixture.js";
import { createSessionMutation, queueItemIdFrom, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim()
  && process.env.JOKO_MOUNTED_WEB_DIR?.trim()
  && process.env.JOKO_PDF_ELECTRON_TEST_EXECUTABLE?.trim() ? it : it.skip;
const officeIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim()
  && process.env.JOKO_MOUNTED_WEB_DIR?.trim() ? it : it.skip;
const DOCUMENT_FILES_PROFILE = {
  ...PI_LIKE_PROFILE,
  id: "fake-document-files",
  displayName: "Document Files Fake",
  capabilities: [...PI_LIKE_PROFILE.capabilities, { key: "workspace.files", supported: true }]
} satisfies FakeAdapterProfile;

let fixture: OrchestratorE2eFixture | undefined;
let browser: Browser | undefined;
let internal: Awaited<ReturnType<typeof createInternalServer>> | undefined;

afterEach(async () => {
  await browser?.close();
  browser = undefined;
  await internal?.close();
  internal = undefined;
  await fixture?.close();
  fixture = undefined;
});

async function closeCompactTimelinePanels(page: Page): Promise<void> {
  // The Details dock mounts through Suspense after the task timeline.
  const dock = page.locator(".inspector-dock-group[data-edge]");
  const close = dock.getByRole("button", { name: "Close details", exact: true });
  const outcome = await Promise.any([
    close.first().waitFor({ state: "visible", timeout: 15_000 }).then(() => "open" as const),
    page.getByRole("button", { name: "Open details", exact: true }).first()
      .waitFor({ state: "visible", timeout: 15_000 }).then(() => "closed" as const)
  ]);
  if (outcome === "open") await close.first().click();
  await dock.first().waitFor({ state: "hidden", timeout: 15_000 });

  const navigationScrim = page.locator(".panel-scrim--navigation");
  if (await navigationScrim.isVisible()) {
    await page.locator(".sidebar.is-open").getByRole("button", { name: "Close navigation", exact: true }).click();
  }
  await navigationScrim.waitFor({ state: "hidden", timeout: 15_000 });
}

mountedIt("shows a task-local chart PDF in mounted Files and downloads its exact bytes", async () => {
  const browserExecutable = process.env.JOKO_BROWSER_EXECUTABLE!;
  const electronExecutable = process.env.JOKO_PDF_ELECTRON_TEST_EXECUTABLE!;
  let turn: AdapterContext | undefined;
  fixture = await OrchestratorE2eFixture.start({
    webDirectory: resolve(process.env.JOKO_MOUNTED_WEB_DIR!),
    profiles: [DOCUMENT_FILES_PROFILE],
    createAdapter: profile => new class extends InstrumentedFakeAdapter {
      override async send(_input: PromptInput, context: AdapterContext): Promise<void> { turn = context; }
    }(profile),
    createAuxiliaryServices: async (store, directory, artifacts) => {
      const vault = await CredentialVault.open(join(directory, "document-vault.key"));
      const credentials = new CredentialManager({ vault, storagePath: join(directory, "document-credentials.json") });
      await credentials.initialize();
      const mcpRouter = new McpRouter({ store, credentials, resultArtifacts: artifacts });
      await mcpRouter.initialize();
      mcpRouter.setNativeToolAdmission((...args) => fixture!.application.sessionHost.authorizeNativeBridgeTool(...args));
      mcpRouter.registerBridgeToolProvider(new DocumentToolBridgeProvider({
        store, artifacts, redactText: value => credentials.redactText(value),
        pdfRenderer: new ElectronDocumentPdfRenderer(electronExecutable, process.env.JOKO_PDF_ELECTRON_TEST_APP)
      }));
      return { mcpRouter };
    }
  });
  internal = await createInternalServer(fixture.application);
  const internalUrl = await internal.listen({ host: "127.0.0.1", port: 0 });
  const manager = await fixture.pair("Document manager");
  const [backendId, targetId] = [...fixture.targets][0]!;
  const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
    createSessionMutation({ backendId, targetId, displayName: "Chart report" })));
  const generation = fixture.application.store.getSession(sessionId).descriptor.binding.generation;
  const bridge = fixture.application.mcpRouter!.createPiBridgeSnapshot({
    endpoint: `${internalUrl}/internal/mcp`, sessionId, targetId, expectedPiGeneration: generation
  });
  expect(bridge.mcpBridge.tools.some(tool => tool.serverId === "joko-document-tools" && tool.name === "render_pdf")).toBe(true);

  await mkdir(join(fixture.workspaceDirectory, "documents", "charts"), { recursive: true });
  await writeFile(join(fixture.workspaceDirectory, "documents", "charts", "bars.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="560" height="200" viewBox="0 0 560 200"><rect width="560" height="200" fill="#f4f7fb"/><rect x="70" y="120" width="85" height="60" fill="#1f4e79"/><rect x="230" y="70" width="85" height="110" fill="#1f4e79"/><rect x="390" y="20" width="85" height="160" fill="#1f4e79"/></svg>');
  await writeFile(join(fixture.workspaceDirectory, "documents", "report.css"),
    'body { font: 18px sans-serif; color: #1f4e79; } img { width: 560px; height: 200px; } .page { break-after: page; }');
  await writeFile(join(fixture.workspaceDirectory, "documents", "report.html"),
    '<!doctype html><html><head><meta charset="utf-8"><title>Quarterly PDF</title><link rel="stylesheet" href="report.css"></head><body><section class="page"><h1>Quarterly chart</h1><img src="charts/bars.svg" alt="Three rising bars"></section><section><h1>Second page</h1><p>Visible follow-up.</p></section></body></html>');

  const call = async (toolName: string, args: Record<string, unknown>) => {
    const response = await fetch(`${internalUrl}/internal/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.mcpBridge.token}`, "content-type": "application/json", "x-joko-pi-generation": String(generation) },
      body: JSON.stringify({ requestId: randomUUID(), sessionId, targetId, generation,
        serverId: "joko-document-tools", toolName, arguments: args })
    });
    expect(response.ok).toBe(true);
    return await response.json() as { isError: boolean; details: { mcpStructuredContent: Record<string, unknown> } };
  };
  const accepted = await submit(manager.clients.operation, manager.connectionId, sendInputMutation(sessionId, BigInt(generation), "Render the chart PDF."));
  const queueId = queueItemIdFrom(accepted);
  await waitFor(async () => fixture!.application.store.getQueueItem(queueId).state, state => state === "backend_accepted", "PDF delivery input accepted");
  const rendered = await call("render_pdf", { htmlPath: "documents/report.html", outPath: "documents/chart-report.pdf", template: "none" });
  expect(rendered).toMatchObject({ isError: false, details: { mcpStructuredContent: { format: "pdf", pageSize: "A4" } } });
  const inspected = await call("inspect_pdf", { path: "documents/chart-report.pdf" });
  expect(inspected).toMatchObject({ isError: false, details: { mcpStructuredContent: {
    numPages: 2, verdict: "ok", blankPages: [], pages: [
      { page: 1, textPreview: expect.stringContaining("Quarterly chart"), blank: false },
      { page: 2, textPreview: expect.stringContaining("Second page"), blank: false }
    ]
  } } });
  const outputPath = join(fixture.workspaceDirectory, "documents", "chart-report.pdf");
  const expectedBytes = await readFile(outputPath);
  if (turn === undefined) throw new Error("The PDF turn was not dispatched.");
  await turn.emit({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "The chart is ready." }] });
  await turn.emit({ type: "done", outcome: "completed" });
  await waitFor(async () => fixture!.application.store.getQueueItem(queueId).state, state => state === "completed", "PDF delivery input completed");

  const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Mounted Web" });
  if (!challenge.challenge) throw new Error("Mounted Web pairing returned no challenge.");
  const pairingCode = fixture.pairingCode(challenge.challenge.challengeId);
  browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const fileRoute = `${fixture.baseUrl}/#/files/${encodeURIComponent(sessionId)}?file=documents%2Fchart-report.pdf`;
  await page.goto(fileRoute, { waitUntil: "domcontentloaded" });
  await page.locator(".connection-tabs > button").nth(2).click();
  await page.locator('details.device-authorization__manual > summary').click();
  await page.getByLabel("Joko node address").fill(fixture.baseUrl);
  await page.getByLabel("Pairing code").fill(pairingCode);
  await page.getByLabel("Device name").fill("Mounted document Web");
  await page.locator("form.pair-form button[type=submit]").click();
  await page.goto(fileRoute, { waitUntil: "domcontentloaded" });
  await page.locator('[data-file-kind="pdf"]').waitFor({ state: "visible", timeout: 20_000 }).catch(async (error: unknown) => {
    const captureDirectory = process.env.JOKO_DOCUMENT_MOUNTED_CAPTURE_DIR?.trim();
    if (captureDirectory) {
      await mkdir(captureDirectory, { recursive: true });
      await page.screenshot({ path: join(captureDirectory, "pdf-load-failure.png") });
    }
    throw new Error(`Mounted PDF view did not appear: ${error instanceof Error ? error.message : String(error)} ${JSON.stringify({
      url: page.url(), body: (await page.locator("body").innerText()).slice(0, 1800)
    })}`);
  });
  const pdfPages = page.locator(".workspace-file-body__pdf-pages [data-pdf-page]");
  const firstPage = page.locator('.workspace-file-body__pdf-pages [data-pdf-page="1"]');
  const secondPage = page.locator('.workspace-file-body__pdf-pages [data-pdf-page="2"]');
  const firstCanvas = firstPage.locator("canvas");
  await firstCanvas.waitFor({ state: "visible" });
  expect(await page.locator('[role="treeitem"][data-relative-path="documents/chart-report.pdf"]').getAttribute("aria-selected")).toBe("true");
  expect(await pdfPages.count()).toBe(2);
  expect(await firstPage.evaluate(row => {
    const sheet = row.querySelector(".workspace-file-body__pdf-sheet");
    if (sheet === null) return false;
    const rowBounds = row.getBoundingClientRect(), sheetBounds = sheet.getBoundingClientRect();
    return Math.abs((rowBounds.left + rowBounds.right) - (sheetBounds.left + sheetBounds.right)) <= 1;
  })).toBe(true);
  expect(await firstCanvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index]! < 90 && pixels[index + 1]! >= 50 && pixels[index + 1]! < 130
        && pixels[index + 2]! >= 90 && pixels[index + 2]! < 170 && pixels[index + 3]! > 0) colored += 1;
    }
    return colored;
  })).toBeGreaterThan(1000);
  const captureDirectory = process.env.JOKO_DOCUMENT_MOUNTED_CAPTURE_DIR?.trim();
  if (captureDirectory) {
    await mkdir(captureDirectory, { recursive: true });
    await page.screenshot({ path: join(captureDirectory, "pdf-wide.png") });
  }
  await secondPage.evaluate(element => element.scrollIntoView({ block: "start" }));
  const secondCanvas = secondPage.locator("canvas");
  await secondCanvas.waitFor({ state: "visible" });
  expect(await secondCanvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index]! < 150 && pixels[index + 1]! < 150 && pixels[index + 2]! < 200 && pixels[index + 3]! > 0) ink += 1;
    }
    return ink;
  })).toBeGreaterThan(100);
  if (captureDirectory) await page.screenshot({ path: join(captureDirectory, "pdf-second-page.png") });
  await firstPage.evaluate(element => element.scrollIntoView({ block: "start" }));
  await firstCanvas.waitFor({ state: "visible" });

  const downloadPromise = page.waitForEvent("download");
  await page.locator(".workspace-file-body__download").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("chart-report.pdf");
  expect(await readFile(await download.path())).toEqual(expectedBytes);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const rail = document.querySelector(".workspace-files-route__chat");
    return rail?.getAttribute("aria-hidden") === "true" && rail.getBoundingClientRect().width < 1;
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await pdfPages.count()).toBe(2);
  const closeNavigation = page.locator(".sidebar__mobile-close");
  if (await closeNavigation.isVisible()) await closeNavigation.click();
  if (captureDirectory) await page.screenshot({ path: join(captureDirectory, "pdf-compact.png") });
  const compactDownload = page.waitForEvent("download");
  await page.locator(".workspace-file-body__download").click();
  expect(await readFile(await (await compactDownload).path())).toEqual(expectedBytes);
  expect(await page.locator(".workspace-file-body__pdf-stage").evaluate((stage) => {
    stage.scrollLeft = stage.scrollWidth;
    return stage.scrollLeft > 0;
  })).toBe(true);
  if (captureDirectory) await page.screenshot({ path: join(captureDirectory, "pdf-compact-scrolled.png") });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await firstCanvas.waitFor({ state: "visible" }).catch(async (error: unknown) => {
    if (captureDirectory) await page.screenshot({ path: join(captureDirectory, "pdf-reload-failure.png") });
    throw new Error(`PDF did not restore after reload: ${error instanceof Error ? error.message : String(error)} ${JSON.stringify({
      url: page.url(), body: (await page.locator("body").innerText()).slice(0, 1800)
    })}`);
  });
  expect(await pdfPages.count()).toBe(2);
  const unreadablePdfPath = "documents/unrenderable.pdf";
  const unreadablePdfBytes = Buffer.from("%PDF-1.4\n%%EOF\n");
  await writeFile(join(fixture.workspaceDirectory, unreadablePdfPath), unreadablePdfBytes);
  await page.evaluate(path => { window.location.hash = path; },
    `#/files/${encodeURIComponent(sessionId)}?file=${encodeURIComponent(unreadablePdfPath)}`);
  const unrenderable = page.locator(".workspace-file-body--unsupported");
  await unrenderable.waitFor({ state: "visible" });
  expect(await unrenderable.locator("strong").innerText()).toBe("unrenderable.pdf");
  expect(await page.locator(".workspace-file-body__pdf-pages canvas").count()).toBe(0);
  const fallbackDownload = page.waitForEvent("download");
  await unrenderable.locator(".workspace-file-body__download").click();
  expect(await readFile(await (await fallbackDownload).path())).toEqual(unreadablePdfBytes);

  await page.evaluate(path => { window.location.hash = path; }, new URL(fileRoute).hash);
  await rm(outputPath);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator(".workspace-files-route").waitFor({ state: "visible" });
  await page.locator(".workspace-file-body__state.is-error").waitFor({ state: "visible" });
  expect(await page.locator(".workspace-file-body__pdf-pages canvas").count()).toBe(0);
  expect(await page.locator(".workspace-file-body__download:not([disabled])").count()).toBe(0);
  await page.evaluate(id => { window.location.hash = `/tasks/${encodeURIComponent(id)}`; }, sessionId);
  const pdfDelivery = page.locator(".generated-files [data-document-format='pdf']");
  await pdfDelivery.waitFor({ state: "visible" });
  expect(await pdfDelivery.innerText()).toContain("Quarterly PDF");
  await closeCompactTimelinePanels(page);
  const [retainedPdf] = await Promise.all([
    page.waitForEvent("download"),
    pdfDelivery.getByRole("button", { name: "Download chart-report.pdf" }).click()
  ]);
  expect(await readFile(await retainedPdf.path())).toEqual(expectedBytes);
  expect(pageErrors).toEqual([]);
  bridge.revoke();
}, 90_000);

officeIt("retains the latest verified document for each path in the Run's mounted delivery card", async () => {
  let turn: AdapterContext | undefined;
  fixture = await OrchestratorE2eFixture.start({
    webDirectory: resolve(process.env.JOKO_MOUNTED_WEB_DIR!),
    profiles: [{ ...DOCUMENT_FILES_PROFILE, capabilities: [
      ...DOCUMENT_FILES_PROFILE.capabilities, { key: "workspace.generated_files", supported: true }
    ] }],
    createAdapter: profile => new class extends InstrumentedFakeAdapter {
      override async send(_input: PromptInput, context: AdapterContext): Promise<void> { turn = context; }
    }(profile),
    createAuxiliaryServices: async (store, directory, artifacts) => {
      const vault = await CredentialVault.open(join(directory, "delivery-vault.key"));
      const credentials = new CredentialManager({ vault, storagePath: join(directory, "delivery-credentials.json") });
      await credentials.initialize();
      const mcpRouter = new McpRouter({ store, credentials, resultArtifacts: artifacts });
      await mcpRouter.initialize();
      mcpRouter.setNativeToolAdmission((...args) => fixture!.application.sessionHost.authorizeNativeBridgeTool(...args));
      mcpRouter.registerBridgeToolProvider(new DocumentToolBridgeProvider({ store, artifacts, redactText: value => credentials.redactText(value) }));
      return { mcpRouter };
    }
  });
  const current = fixture;
  const { mcpRouter, store } = current.application;
  const manager = await current.pair("Delivery manager");
  const [backendId, targetId] = [...current.targets][0]!;
  const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
    createSessionMutation({ backendId, targetId, displayName: "Verified delivery" })));
  const generation = store.getSession(sessionId).descriptor.binding.generation;
  const bridge = mcpRouter!.createPiBridgeSnapshot({ endpoint: `${current.baseUrl}/internal/mcp`, sessionId, targetId, expectedPiGeneration: generation });
  const call = (toolName: string, arguments_: Record<string, unknown>) => mcpRouter!.executeBridgeCall({
    authorization: `Bearer ${bridge.mcpBridge.token}`, requestId: randomUUID(), sessionId, targetId, generation,
    serverId: "joko-document-tools", toolName, arguments: arguments_
  });
  const relativePath = "documents/verified.docx";
  const outputPath = join(current.workspaceDirectory, relativePath);
  const codePath = join(current.workspaceDirectory, "existing.ts");
  await expect(call("make_docx", { outPath: relativePath, markdown: "# Before the turn" })).resolves.toMatchObject({ isError: false });
  await writeFile(codePath, "export const value = 1;\n");
  const accepted = await submit(manager.clients.operation, manager.connectionId, sendInputMutation(sessionId, BigInt(generation), "Deliver the updated files."));
  const queueId = queueItemIdFrom(accepted), runId = queueRunIdFrom(accepted);
  await waitFor(async () => store.getQueueItem(queueId).state, state => state === "backend_accepted", "document delivery input accepted");
  await expect(call("make_docx", { outPath: relativePath, markdown: "# First delivery", title: "First title", overwrite: true }))
    .resolves.toMatchObject({ isError: false });
  await expect(call("make_docx", { outPath: relativePath, markdown: "# Final delivery", title: "Final title", subtitle: "Verified cover", theme: "navy", overwrite: true }))
    .resolves.toMatchObject({ isError: false });
  const delivered = await readFile(outputPath);
  await expect(call("make_docx", { outPath: relativePath, markdown: "# Rejected", title: "Rejected title" })).resolves.toMatchObject({ isError: true });
  await expect(call("make_xlsx", { outPath: "documents/data.xlsx", sheets: [{ name: "Metrics", header: ["Name", "Value"], rows: [["Accuracy", 0.98]] }] }))
    .resolves.toMatchObject({ isError: false });
  await expect(call("make_pptx", { outPath: "documents/slides.pptx", title: "Quarterly deck", slides: [
    { layout: "cover", title: "Opening slide", subtitle: "Preview evidence" }, { layout: "section", title: "Results" }
  ] })).resolves.toMatchObject({ isError: false });
  await writeFile(codePath, "export const value = 2;\n");
  if (turn === undefined) throw new Error("The delivery turn was not dispatched.");
  await turn.emit({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "The documents are ready." }] });
  await turn.emit({ type: "done", outcome: "completed" });
  await waitFor(async () => store.listEvents({ sessionId }).find(event => event.runId === runId && event.payload.type === "workspace_diff"),
    event => event !== undefined, "finished Run workspace changes");

  const challenge = (await current.anonymous.connection.beginPairing({ deviceDisplayName: "Document delivery Web" })).challenge!;
  browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 950 }, acceptDownloads: true, locale: "en-US" });
  await routeFixtureDiscovery(page.context(), current.baseUrl);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(`${current.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
  await page.locator(".connection-tabs > button").nth(2).click();
  await page.locator('details.device-authorization__manual > summary').click();
  await page.getByLabel("Joko node address").fill(current.baseUrl);
  await page.getByLabel("Pairing code").fill(current.pairingCode(challenge.challengeId));
  await page.getByLabel("Device name").fill("Document delivery Web");
  await page.locator("form.pair-form button[type=submit]").click();
  const card = page.locator(`[data-timeline-session-id='${sessionId}'] .generated-files`);
  const word = card.locator('[data-document-format="docx"]');
  await word.waitFor({ state: "visible", timeout: 25_000 });
  expect(await word.count()).toBe(1);
  expect(await word.innerText()).toContain("Final title");
  expect(await word.innerText()).toContain("Verified cover");
  expect(await word.getAttribute("data-document-theme")).toBe("navy");
  const sheet = card.locator('[data-document-format="xlsx"] table');
  expect(await sheet.getByRole("columnheader").allTextContents()).toEqual(["Name", "Value"]);
  expect(await sheet.getByRole("cell").allTextContents()).toEqual(["Accuracy", "0.98"]);
  expect(await card.locator('[data-document-format="pptx"]').innerText()).toContain("Opening slide");
  expect(await card.locator('[data-document-format="pptx"]').innerText()).toContain("Slides 2");
  expect(await card.innerText()).not.toMatch(/First title|Rejected title|existing\.ts/u);
  const captureDirectory = process.env.JOKO_DOCUMENT_MOUNTED_CAPTURE_DIR?.trim();
  if (captureDirectory) {
    await mkdir(captureDirectory, { recursive: true });
    await card.screenshot({ path: join(captureDirectory, "delivery-wide.png") });
  }
  await word.getByRole("button", { name: "Show verified.docx in Files" }).click();
  await page.locator('[role="treeitem"][data-relative-path="documents/verified.docx"][aria-selected="true"]').waitFor();
  await page.evaluate(id => { window.location.hash = `/tasks/${encodeURIComponent(id)}`; }, sessionId);
  await word.waitFor({ state: "visible", timeout: 25_000 });

  await writeFile(outputPath, "Different workspace bytes after the Run\n");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await word.waitFor({ state: "visible", timeout: 25_000 });
  expect(await word.count()).toBe(1);
  expect(await card.locator(".generated-document").count()).toBe(3);
  await closeCompactTimelinePanels(page);

  const downloadButton = word.getByRole("button", { name: "Download verified.docx", exact: true });
  const transfers: string[] = [];
  const observeTransfer = (url: string, outcome: string): void => {
    const path = new URL(url).pathname;
    const step = path.endsWith("/joko.v1.ArtifactService/GetBlobDownloadTicket") ? "ticket"
      : path.startsWith("/v1/blobs/download/") ? "bytes" : undefined;
    if (step !== undefined && transfers.length < 12) transfers.push(`${step} ${outcome}`);
  };
  page.on("request", request => observeTransfer(request.url(), "requested"));
  page.on("response", response => observeTransfer(response.url(), `HTTP ${response.status()}`));
  page.on("requestfailed", request => observeTransfer(request.url(), "failed"));
  let clicked = false;
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    downloadButton.click({ timeout: 20_000 }).then(() => { clicked = true; })
  ]).catch(async (error: unknown) => {
    const buttonBusy = await downloadButton.evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-busy"))).catch(() => []);
    const alert = await word.getByRole("alert").count().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nVerified document download ${JSON.stringify({ clicked, buttonBusy, alert, transfers })}`, { cause: error });
  });
  expect(download.suggestedFilename()).toBe("verified.docx");
  expect(await readFile(await download.path())).toEqual(delivered);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  if (captureDirectory) await card.screenshot({ path: join(captureDirectory, "delivery-compact.png") });
  expect(pageErrors).toEqual([]);
  bridge.revoke();
}, 90_000);

officeIt("shows generated Office files as bounded binary previews with exact downloads", async () => {
  fixture = await OrchestratorE2eFixture.start({
    webDirectory: resolve(process.env.JOKO_MOUNTED_WEB_DIR!),
    profiles: [DOCUMENT_FILES_PROFILE],
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
  const manager = await fixture.pair("Office document manager");
  const [backendId, targetId] = [...fixture.targets][0]!;
  const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
    createSessionMutation({ backendId, targetId, displayName: "Office report" })));
  const generation = fixture.application.store.getSession(sessionId).descriptor.binding.generation;
  const bridge = fixture.application.mcpRouter!.createPiBridgeSnapshot({
    endpoint: `${internalUrl}/internal/mcp`, sessionId, targetId, expectedPiGeneration: generation
  });
  const outputs = [
    { name: "report.docx", tool: "make_docx", args: { markdown: "# Office report\n\nA real document.", outPath: "documents/report.docx" } },
    { name: "slides.pptx", tool: "make_pptx", args: { slides: [
      { layout: "cover", title: "Office report" },
      { layout: "metrics", title: "Results", metrics: [{ value: "98%", label: "Uptime" }, { value: 12, label: "Regions" }] }
    ], outPath: "documents/slides.pptx" } },
    { name: "metrics.xlsx", tool: "make_xlsx", args: { sheets: [{ name: "Results", header: ["Metric", "Value"], rows: [["Uptime", 0.98]] }], outPath: "documents/metrics.xlsx" } }
  ] as const;
  await mkdir(join(fixture.workspaceDirectory, "documents"));
  const bytesByName = new Map<string, Buffer>();
  for (const output of outputs) {
    const response = await fetch(`${internalUrl}/internal/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.mcpBridge.token}`, "content-type": "application/json", "x-joko-pi-generation": String(generation) },
      body: JSON.stringify({ requestId: randomUUID(), sessionId, targetId, generation,
        serverId: "joko-document-tools", toolName: output.tool, arguments: output.args })
    });
    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({ isError: false, details: { mcpStructuredContent: {
      relativePath: join("documents", output.name)
    } } });
    const bytes = await readFile(join(fixture.workspaceDirectory, "documents", output.name));
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    bytesByName.set(output.name, bytes);
  }

  const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Mounted Office Web" });
  if (!challenge.challenge) throw new Error("Mounted Web pairing returned no challenge.");
  browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const hash = (name: string) => `#/files/${encodeURIComponent(sessionId)}?file=${encodeURIComponent(`documents/${name}`)}`;
  await page.goto(`${fixture.baseUrl}/${hash(outputs[0]!.name)}`, { waitUntil: "domcontentloaded" });
  await page.locator(".connection-tabs > button").nth(2).click();
  await page.locator('details.device-authorization__manual > summary').click();
  await page.getByLabel("Joko node address").fill(fixture.baseUrl);
  await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
  await page.getByLabel("Device name").fill("Mounted Office Web");
  await page.locator("form.pair-form button[type=submit]").click();
  await page.goto(`${fixture.baseUrl}/${hash(outputs[0]!.name)}`, { waitUntil: "domcontentloaded" });

  for (const output of outputs) {
    if (output !== outputs[0]) await page.evaluate((nextHash) => { window.location.hash = nextHash; }, hash(output.name));
    await page.locator(".workspace-file-body--unsupported").waitFor({ state: "visible" });
    const selected = page.locator(`[role="treeitem"][data-relative-path="documents/${output.name}"]`);
    await selected.waitFor({ state: "visible" });
    expect(await selected.getAttribute("aria-selected")).toBe("true");
    expect(await page.locator(".workspace-file-body--unsupported").getAttribute("data-file-kind")).toBe("blob");
    expect(await page.locator(".workspace-file-body--unsupported strong").innerText()).toBe(output.name);
    const bytes = bytesByName.get(output.name)!;
    const size = bytes.length < 1_024 ? `${bytes.length} B` : `${(bytes.length / 1_024).toFixed(1)} KB`;
    expect(await page.locator(".workspace-file-body__meta").innerText()).toContain(size);
    const downloadPromise = page.waitForEvent("download");
    await page.locator(".workspace-file-body__download").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(output.name);
    expect(await readFile(await download.path())).toEqual(bytes);
  }
  const captureDirectory = process.env.JOKO_DOCUMENT_MOUNTED_CAPTURE_DIR?.trim();
  if (captureDirectory) {
    await mkdir(captureDirectory, { recursive: true });
    await page.screenshot({ path: join(captureDirectory, "office-wide.png") });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const rail = document.querySelector(".workspace-files-route__chat");
    return rail?.getAttribute("aria-hidden") === "true" && rail.getBoundingClientRect().width < 1;
  });
  const closeNavigation = page.locator(".sidebar__mobile-close");
  if (await closeNavigation.isVisible()) await closeNavigation.click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  if (captureDirectory) await page.screenshot({ path: join(captureDirectory, "office-compact.png") });
  const narrowDownload = page.waitForEvent("download");
  await page.locator(".workspace-file-body__download").click();
  expect(await readFile(await (await narrowDownload).path())).toEqual(bytesByName.get("metrics.xlsx"));

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator(".workspace-file-body--unsupported").waitFor({ state: "visible" });
  expect(await page.locator('[role="treeitem"][data-relative-path="documents/metrics.xlsx"]').getAttribute("aria-selected")).toBe("true");
  await rm(join(fixture.workspaceDirectory, "documents", "metrics.xlsx"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator(".workspace-file-body__state.is-error").waitFor({ state: "visible" });
  expect(await page.locator(".workspace-file-body__download:not([disabled])").count()).toBe(0);
  expect(pageErrors).toEqual([]);
  bridge.revoke();
}, 90_000);
