import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CredentialManager,
  CredentialVault,
  DocumentToolBridgeProvider,
  ElectronDocumentPdfRenderer,
  McpRouter,
  createInternalServer
} from "@joko/orchestrator";
import { PI_LIKE_PROFILE, type FakeAdapterProfile } from "@joko/testkit";
import { chromium, type Browser } from "playwright-core";
import { afterEach, expect, it } from "vitest";
import { OrchestratorE2eFixture } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

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

mountedIt("shows a task-local chart PDF in mounted Files and downloads its exact bytes", async () => {
  const browserExecutable = process.env.JOKO_BROWSER_EXECUTABLE!;
  const electronExecutable = process.env.JOKO_PDF_ELECTRON_TEST_EXECUTABLE!;
  fixture = await OrchestratorE2eFixture.start({
    webDirectory: resolve(process.env.JOKO_MOUNTED_WEB_DIR!),
    profiles: [DOCUMENT_FILES_PROFILE],
    createAuxiliaryServices: async (store, directory, artifacts) => {
      const vault = await CredentialVault.open(join(directory, "document-vault.key"));
      const credentials = new CredentialManager({ vault, storagePath: join(directory, "document-credentials.json") });
      await credentials.initialize();
      const mcpRouter = new McpRouter({ store, credentials, resultArtifacts: artifacts });
      await mcpRouter.initialize();
      mcpRouter.registerBridgeToolProvider(new DocumentToolBridgeProvider({
        store,
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
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="report.css"></head><body><section class="page"><h1>Quarterly chart</h1><img src="charts/bars.svg" alt="Three rising bars"></section><section><h1>Second page</h1><p>Visible follow-up.</p></section></body></html>');

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
  await page.waitForFunction(() => document.querySelectorAll(".workspace-file-body__pdf-pages canvas").length === 2);
  expect(await page.locator('[role="treeitem"][data-relative-path="documents/chart-report.pdf"]').getAttribute("aria-selected")).toBe("true");
  const canvases = page.locator(".workspace-file-body__pdf-pages canvas");
  expect(await canvases.count()).toBe(2);
  expect(await canvases.first().evaluate((element) => {
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
  expect(await canvases.nth(1).evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index]! < 150 && pixels[index + 1]! < 150 && pixels[index + 2]! < 200 && pixels[index + 3]! > 0) ink += 1;
    }
    element.scrollIntoView({ block: "start" });
    return ink;
  })).toBeGreaterThan(100);
  if (captureDirectory) await page.screenshot({ path: join(captureDirectory, "pdf-second-page.png") });
  await canvases.first().scrollIntoViewIfNeeded();

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
  expect(await canvases.count()).toBe(2);
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
  await page.waitForFunction(() => document.querySelectorAll(".workspace-file-body__pdf-pages canvas").length === 2).catch(async (error: unknown) => {
    if (captureDirectory) await page.screenshot({ path: join(captureDirectory, "pdf-reload-failure.png") });
    throw new Error(`PDF did not restore after reload: ${error instanceof Error ? error.message : String(error)} ${JSON.stringify({
      url: page.url(), body: (await page.locator("body").innerText()).slice(0, 1800)
    })}`);
  });
  await rm(outputPath);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator(".workspace-files-route").waitFor({ state: "visible" });
  await page.locator(".workspace-file-body__state.is-error").waitFor({ state: "visible" });
  expect(await page.locator(".workspace-file-body__pdf-pages canvas").count()).toBe(0);
  expect(await page.locator(".workspace-file-body__download:not([disabled])").count()).toBe(0);
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
