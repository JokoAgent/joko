import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  CredentialManager,
  CredentialVault,
  DocumentToolBridgeProvider,
  ElectronDocumentPdfRenderer,
  McpRouter,
  createInternalServer
} from "@joko/orchestrator";
import { PI_LIKE_PROFILE, type FakeAdapterProfile } from "@joko/testkit";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterEach, expect, it } from "vitest";

import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

const packagedIt = process.platform === "win32" && process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE?.trim()
  ? it : it.skip;
const DOCUMENT_FILES_PROFILE = {
  ...PI_LIKE_PROFILE,
  id: "fake-document-desktop",
  displayName: "Document Desktop Fake",
  capabilities: [...PI_LIKE_PROFILE.capabilities, { key: "workspace.files", supported: true }]
} satisfies FakeAdapterProfile;

interface OwnedDesktopProcess {
  readonly pid: number;
  readonly executablePath: string;
  readonly startedAt: string;
}

let fixture: OrchestratorE2eFixture | undefined;
let internal: Awaited<ReturnType<typeof createInternalServer>> | undefined;
let desktop: ElectronApplication | undefined;
let desktopIdentity: OwnedDesktopProcess | undefined;
let profileDirectory: string | undefined;

afterEach(async () => {
  try {
    await closeDesktop();
  } finally {
    await internal?.close();
    internal = undefined;
    await fixture?.close();
    fixture = undefined;
    if (profileDirectory !== undefined) {
      const target = resolve(profileDirectory);
      if (dirname(target) !== resolve(tmpdir()) || !target.split(/[\\/]/u).at(-1)?.startsWith("joko-document-desktop-")) {
        throw new Error("Refusing to remove an unexpected document Desktop profile.");
      }
      await rm(target, { recursive: true, force: true });
      profileDirectory = undefined;
    }
  }
}, 90_000);

packagedIt("shows generated PDF and Office files through packaged Desktop Files and retires invalid sources", {
  timeout: 180_000
}, async () => {
  const executablePath = resolve(process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE!);
  fixture = await OrchestratorE2eFixture.start({
    profiles: [DOCUMENT_FILES_PROFILE],
    createAuxiliaryServices: async (store, directory, artifacts) => {
      const vault = await CredentialVault.open(join(directory, "document-vault.key"));
      const credentials = new CredentialManager({ vault, storagePath: join(directory, "document-credentials.json") });
      await credentials.initialize();
      const mcpRouter = new McpRouter({ store, credentials, resultArtifacts: artifacts });
      await mcpRouter.initialize();
      mcpRouter.registerBridgeToolProvider(new DocumentToolBridgeProvider({
        store,
        pdfRenderer: new ElectronDocumentPdfRenderer(executablePath)
      }));
      return { mcpRouter };
    }
  });
  internal = await createInternalServer(fixture.application);
  const internalUrl = await internal.listen({ host: "127.0.0.1", port: 0 });
  const manager = await fixture.pair("Document Desktop manager");
  const [backendId, targetId] = [...fixture.targets][0]!;
  const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
    createSessionMutation({ backendId, targetId, displayName: "Chart report" })));
  const generation = fixture.application.store.getSession(sessionId).descriptor.binding.generation;
  const bridge = fixture.application.mcpRouter!.createPiBridgeSnapshot({
    endpoint: `${internalUrl}/internal/mcp`, sessionId, targetId, expectedPiGeneration: generation
  });
  expect(bridge.mcpBridge.tools.some((tool) => tool.serverId === "joko-document-tools" && tool.name === "render_pdf"))
    .toBe(true);

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
      headers: {
        authorization: `Bearer ${bridge.mcpBridge.token}`,
        "content-type": "application/json",
        "x-joko-pi-generation": String(generation)
      },
      body: JSON.stringify({ requestId: randomUUID(), sessionId, targetId, generation,
        serverId: "joko-document-tools", toolName, arguments: args })
    });
    expect(response.ok).toBe(true);
    return await response.json() as { isError: boolean; details: { mcpStructuredContent: Record<string, unknown> } };
  };
  const rendered = await call("render_pdf", {
    htmlPath: "documents/report.html", outPath: "documents/chart-report.pdf", template: "none"
  });
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
  const officeOutputs = [
    { name: "report.docx", tool: "make_docx", args: {
      markdown: "# Office report\n\nA real document.", outPath: "documents/report.docx"
    } },
    { name: "slides.pptx", tool: "make_pptx", args: {
      slides: [
        { layout: "cover", title: "Office report" },
        { layout: "metrics", title: "Results", metrics: [{ value: "98%", label: "Uptime" }, { value: 12, label: "Regions" }] }
      ], outPath: "documents/slides.pptx"
    } },
    { name: "metrics.xlsx", tool: "make_xlsx", args: {
      sheets: [{ name: "Results", header: ["Metric", "Value"], rows: [["Uptime", 0.98]] }],
      outPath: "documents/metrics.xlsx"
    } }
  ] as const;
  const officeBytes = new Map<string, Buffer>();
  for (const output of officeOutputs) {
    expect(bridge.mcpBridge.tools.some((tool) => tool.serverId === "joko-document-tools" && tool.name === output.tool))
      .toBe(true);
    const result = await call(output.tool, output.args);
    expect(result).toMatchObject({ isError: false, details: { mcpStructuredContent: {
      relativePath: join("documents", output.name)
    } } });
    const bytes = await readFile(join(fixture.workspaceDirectory, "documents", output.name));
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    officeBytes.set(output.name, bytes);
  }
  await mkdir(join(fixture.workspaceDirectory, "documents", "fonts"));
  await copyFile(resolve("..", "web", "node_modules", "@fontsource-variable", "jetbrains-mono", "files",
    "jetbrains-mono-latin-wght-normal.woff2"),
  join(fixture.workspaceDirectory, "documents", "fonts", "report-mono.woff2"));
  await writeFile(join(fixture.workspaceDirectory, "documents", "visual-chart.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="260" viewBox="0 0 800 260"><rect width="800" height="260" fill="#fffaf2"/><path d="M64 20V210H760" fill="none" stroke="#444" stroke-width="2"/><path d="M64 162H760M64 115H760M64 68H760" stroke="#ddd"/><rect x="115" y="127" width="92" height="83" fill="#ff9800"/><rect x="285" y="85" width="92" height="125" fill="#ff9800"/><rect x="455" y="55" width="92" height="155" fill="#ff9800"/><rect x="625" y="35" width="92" height="175" fill="#ff9800"/><g fill="#202020" font-family="sans-serif" font-size="20"><text x="125" y="242">Q1</text><text x="295" y="242">Q2</text><text x="465" y="242">Q3</text><text x="635" y="242">Q4</text></g></svg>');
  await writeFile(join(fixture.workspaceDirectory, "documents", "visual.css"), `
@font-face { font-family: ReportMono; src: url("fonts/report-mono.woff2") format("woff2"); }
@media print { body { print-color-adjust: exact; } }
body { margin: 0; color: #202020; font: 15px/1.55 "Microsoft YaHei", sans-serif; }
.page { box-sizing: border-box; min-height: 255mm; break-after: page; }
.page:last-child { break-after: auto; }
.eyebrow { color: #9a5b00; font: 700 11px ReportMono, monospace; letter-spacing: .12em; }
.rule { height: 3px; background: #ff9800; margin: 4mm 0 8mm; }
h1 { margin: 0 0 5mm; font-size: 28px; line-height: 1.25; }
h2 { margin: 0 0 4mm; font-size: 21px; }
.lead { font-size: 17px; max-width: 160mm; }
.metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5mm; margin: 8mm 0; }
.metric { border: 1px solid #d6d6d6; border-left: 4px solid #ff9800; padding: 4mm; background: #fafafa; }
.metric strong { display: block; font: 700 24px ReportMono, monospace; }
.chart { display: block; width: 100%; height: auto; margin-top: 5mm; }
table { width: 100%; border-collapse: collapse; margin-top: 7mm; }
th, td { padding: 3mm; border-bottom: 1px solid #aaa; text-align: left; }
th { background: #fff1dc; }
tr:nth-child(even) td { background: #fafafa; }
.mono { font-family: ReportMono, monospace; font-size: 15px; }
.note { margin-top: 8mm; padding: 4mm; background: #fff1dc; border-left: 3px solid #ff9800; }
`);
  await writeFile(join(fixture.workspaceDirectory, "documents", "visual.html"), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Joko visual report</title><link rel="stylesheet" href="visual.css"></head><body>
<section class="page"><div class="eyebrow">JOKO / QUARTERLY REPORT</div><div class="rule"></div><h1>季度概览 Quarterly Review</h1><p class="lead">任务摘要：服务正常，图表完整。This report verifies print styling, local assets, and readable multilingual text.</p><div class="metrics"><div class="metric">完成任务<strong>128</strong></div><div class="metric">成功率<strong>98%</strong></div><div class="metric">平均耗时<strong>42ms</strong></div></div><h2>Quarterly trend</h2><img class="chart" src="visual-chart.svg" alt="Q1 through Q4 rising bars"><p>Figure 1. Four quarters increase from Q1 to Q4.</p></section>
<section class="page"><div class="eyebrow">JOKO / DETAILS</div><div class="rule"></div><h1>项目明细 Project Details</h1><p>表格数值与标签必须完整呈现，不得跨页截断。</p><table><thead><tr><th>Quarter</th><th>Tasks</th><th>Completion</th></tr></thead><tbody><tr><td>Q1</td><td>20</td><td>92%</td></tr><tr><td>Q2</td><td>28</td><td>95%</td></tr><tr><td>Q3</td><td>35</td><td>97%</td></tr><tr><td>Q4</td><td>45</td><td>98%</td></tr></tbody></table><div class="note">视觉检查：表格边框、暖色表头和页面留白应清晰可见。</div></section>
<section class="page"><div class="eyebrow">JOKO / TYPE CHECK</div><div class="rule"></div><h1>字体与分页 Typography</h1><p class="mono">ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789</p><p>中文排版验证：季度概览、项目明细、任务摘要。</p><p>日本語の文字と 한국어 글꼴도読み取れること。</p><div class="note">Final page: no clipped footer, missing glyphs, or blank trailing page.</div></section>
</body></html>`);
  const visualRendered = await call("render_pdf", {
    htmlPath: "documents/visual.html", outPath: "documents/visual-report.pdf", template: "none"
  });
  expect(visualRendered).toMatchObject({ isError: false, details: { mcpStructuredContent: {
    format: "pdf", fontsReady: true, pageSize: "A4"
  } } });
  const visualInspected = await call("inspect_pdf", { path: "documents/visual-report.pdf" });
  expect(visualInspected).toMatchObject({ isError: false, details: { mcpStructuredContent: {
    numPages: 3, verdict: "ok", blankPages: [], pages: [
      { page: 1, textPreview: expect.stringContaining("Quarterly Review"), blank: false },
      { page: 2, textPreview: expect.stringContaining("Project Details"), blank: false },
      { page: 3, textPreview: expect.stringContaining("Typography"), blank: false }
    ]
  } } });
  const visualBytes = await readFile(join(fixture.workspaceDirectory, "documents", "visual-report.pdf"));
  const visualCaptureDirectory = process.env.JOKO_DOCUMENT_VISUAL_CAPTURE_DIR?.trim();
  if (visualCaptureDirectory) {
    if (!isAbsolute(visualCaptureDirectory)) throw new Error("Document visual capture directory must be absolute.");
    await mkdir(visualCaptureDirectory, { recursive: true });
    const capturePath = join(visualCaptureDirectory, `joko-visual-report-${randomUUID()}.pdf`);
    await copyFile(join(fixture.workspaceDirectory, "documents", "visual-report.pdf"), capturePath, constants.COPYFILE_EXCL);
    process.stdout.write(`JOKO_VISUAL_PDF=${capturePath}\n`);
  }

  const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Document Desktop" });
  if (challenge.challenge === undefined) throw new Error("Desktop pairing returned no challenge.");
  profileDirectory = await mkdtemp(join(tmpdir(), "joko-document-desktop-"));
  desktop = await _electron.launch({
    executablePath,
    env: {
      ...process.env,
      JOKO_DESKTOP_MANAGED_ORCHESTRATOR: "0",
      JOKO_DESKTOP_PACKAGED_SMOKE: "1",
      JOKO_DESKTOP_SMOKE_SCOPE: "external",
      JOKO_DESKTOP_SMOKE_USER_DATA: profileDirectory
    },
    timeout: 60_000
  });
  const mainPid = await desktop.evaluate(() => process.pid);
  desktopIdentity = await readOwnedDesktopProcess(mainPid);
  if (desktopIdentity === undefined || resolve(desktopIdentity.executablePath).toLowerCase() !== executablePath.toLowerCase()) {
    throw new Error("Document Desktop launched an unexpected executable.");
  }
  const userDataPath = await desktop.evaluate(({ app }) => app.getPath("userData"));
  const profileRelative = relative(profileDirectory, userDataPath);
  if (profileRelative.startsWith("..") || isAbsolute(profileRelative)) {
    throw new Error("Document Desktop did not use its isolated profile.");
  }
  const page = await desktop.firstWindow({ timeout: 60_000 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.locator(".connection-screen").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(".connection-tabs > button").nth(2).click();
  await page.getByLabel("Joko node address").fill(fixture.baseUrl);
  await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
  await page.getByLabel("Device name").fill("Document Desktop");
  await page.locator("form.pair-form button[type=submit]").click();
  await page.locator(".app").waitFor({ state: "visible", timeout: 30_000 });
  const filesHash = `#/files/${encodeURIComponent(sessionId)}?file=documents%2Fchart-report.pdf`;
  await page.evaluate((hash) => { window.location.hash = hash; }, filesHash);
  await page.locator('[data-file-kind="pdf"]').waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll(".workspace-file-body__pdf-pages canvas").length === 2);
  expect(await page.locator('[role="treeitem"][data-relative-path="documents/chart-report.pdf"]')
    .getAttribute("aria-selected")).toBe("true");
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
  expect(await canvases.nth(1).evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index]! < 150 && pixels[index + 1]! < 150 && pixels[index + 2]! < 200 && pixels[index + 3]! > 0) ink += 1;
    }
    return ink;
  })).toBeGreaterThan(100);
  await expectExactNativeSave(page, desktopIdentity.pid, profileDirectory, expectedBytes);

  await page.evaluate((id) => { window.location.hash = `#/tasks/${encodeURIComponent(id)}`; }, sessionId);
  await page.locator(`.session-pane [data-timeline-session-id='${sessionId}']`)
    .waitFor({ state: "visible", timeout: 30_000 });
  expect(await page.locator(".workspace-file-body__pdf-pages canvas").count()).toBe(0);
  const readPattern = "**/joko.v1.WorkspaceService/ReadWorkspaceFile";
  let releaseRead: (() => void) | undefined;
  let heldReadCount = 0;
  const readGate = new Promise<void>((resolveRead) => { releaseRead = resolveRead; });
  await page.route(readPattern, async (route) => {
    heldReadCount += 1;
    await readGate;
    await route.continue().catch(() => undefined);
  });
  await page.evaluate((hash) => { window.location.hash = hash; }, filesHash);
  await waitFor(() => Promise.resolve(heldReadCount), (count) => count > 0,
    "Document Desktop in-flight file preview", 10_000);
  await page.evaluate((id) => { window.location.hash = `#/tasks/${encodeURIComponent(id)}`; }, sessionId);
  await page.locator(`.session-pane [data-timeline-session-id='${sessionId}']`)
    .waitFor({ state: "visible", timeout: 30_000 });
  releaseRead?.();
  await page.unroute(readPattern);
  expect(await page.locator(".workspace-file-body__pdf-pages canvas").count()).toBe(0);
  await page.evaluate((hash) => { window.location.hash = hash; }, filesHash);
  await page.waitForFunction(() => document.querySelectorAll(".workspace-file-body__pdf-pages canvas").length === 2);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const rail = document.querySelector(".workspace-files-route__chat");
    return rail?.getAttribute("aria-hidden") === "true" && rail.getBoundingClientRect().width < 1;
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const closeNavigation = page.locator(".sidebar__mobile-close");
  if (await closeNavigation.isVisible()) await closeNavigation.click();
  await expectExactNativeSave(page, desktopIdentity.pid, profileDirectory, expectedBytes);

  await page.reload({ waitUntil: "domcontentloaded" });
  const reconnect = page.getByRole("button", { name: "Connect", exact: true });
  await reconnect.click({ timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll(".workspace-file-body__pdf-pages canvas").length === 2);
  await rm(outputPath);
  await page.reload({ waitUntil: "domcontentloaded" });
  await reconnect.click({ timeout: 30_000 });
  await page.locator(".workspace-file-body__state.is-error").waitFor({ state: "visible", timeout: 30_000 });
  expect(await page.locator(".workspace-file-body__pdf-pages canvas").count()).toBe(0);
  expect(await page.locator(".workspace-file-body__download:not([disabled])").count()).toBe(0);

  await page.setViewportSize({ width: 1440, height: 960 });
  const officeHash = (name: string) => `#/files/${encodeURIComponent(sessionId)}?file=${encodeURIComponent(`documents/${name}`)}`;
  for (const output of officeOutputs) {
    await page.evaluate((hash) => { window.location.hash = hash; }, officeHash(output.name));
    const preview = page.locator(".workspace-file-body--unsupported");
    await preview.waitFor({ state: "visible", timeout: 30_000 });
    expect(await preview.getAttribute("data-file-kind")).toBe("blob");
    expect(await preview.locator("strong").innerText()).toBe(output.name);
    expect(await page.locator(`[role="treeitem"][data-relative-path="documents/${output.name}"]`)
      .getAttribute("aria-selected")).toBe("true");
    const bytes = officeBytes.get(output.name)!;
    const displayedSize = bytes.length < 1_024 ? `${bytes.length} B` : `${(bytes.length / 1_024).toFixed(1)} KB`;
    expect(await page.locator(".workspace-file-body__meta").innerText()).toContain(displayedSize);
    await expectExactNativeSave(page, desktopIdentity.pid, profileDirectory, bytes, output.name);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const rail = document.querySelector(".workspace-files-route__chat");
    return rail?.getAttribute("aria-hidden") === "true" && rail.getBoundingClientRect().width < 1;
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const officeCloseNavigation = page.locator(".sidebar__mobile-close");
  if (await officeCloseNavigation.isVisible()) await officeCloseNavigation.click();
  await expectExactNativeSave(page, desktopIdentity.pid, profileDirectory, officeBytes.get("metrics.xlsx")!, "metrics.xlsx");
  await page.reload({ waitUntil: "domcontentloaded" });
  await reconnect.click({ timeout: 30_000 });
  await page.locator(".workspace-file-body--unsupported").waitFor({ state: "visible", timeout: 30_000 });
  expect(await page.locator('[role="treeitem"][data-relative-path="documents/metrics.xlsx"]')
    .getAttribute("aria-selected")).toBe("true");
  await rm(join(fixture.workspaceDirectory, "documents", "metrics.xlsx"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await reconnect.click({ timeout: 30_000 });
  await page.locator(".workspace-file-body__state.is-error").waitFor({ state: "visible", timeout: 30_000 });
  expect(await page.locator(".workspace-file-body__download:not([disabled])").count()).toBe(0);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate((hash) => { window.location.hash = hash; },
    `#/files/${encodeURIComponent(sessionId)}?file=documents%2Fvisual-report.pdf`);
  await page.waitForFunction(() => document.querySelectorAll(".workspace-file-body__pdf-pages canvas").length === 3);
  const visualInkByPage = await page.locator(".workspace-file-body__pdf-pages canvas").evaluateAll((elements) =>
    elements.map((element) => {
      const canvas = element as HTMLCanvasElement;
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index]! < 190 && pixels[index + 1]! < 190 && pixels[index + 2]! < 190
          && pixels[index + 3]! > 0) ink += 1;
      }
      return ink;
    }));
  expect(visualInkByPage).toHaveLength(3);
  expect(visualInkByPage.every((ink) => ink > 100)).toBe(true);
  expect(await page.locator('[role="treeitem"][data-relative-path="documents/visual-report.pdf"]')
    .getAttribute("aria-selected")).toBe("true");
  await expectExactNativeSave(page, desktopIdentity.pid, profileDirectory, visualBytes, "visual-report.pdf");
  if (visualCaptureDirectory) {
    const capturePath = join(visualCaptureDirectory, `joko-visual-desktop-${randomUUID()}.png`);
    await page.screenshot({ path: capturePath });
    process.stdout.write(`JOKO_VISUAL_DESKTOP=${capturePath}\n`);
  }
  expect(pageErrors).toEqual([]);
  bridge.revoke();
  await closeDesktop();
});

async function expectExactNativeSave(page: Page, mainPid: number, directory: string, expectedBytes: Buffer,
  fileName = "chart-report.pdf"): Promise<void> {
  const target = join(directory, `${randomUUID()}-${fileName}`);
  await page.locator(".workspace-file-body__download").click();
  await chooseNativeSaveTarget(mainPid, target);
  await waitFor(() => readFile(target).catch(() => undefined), (bytes) => bytes !== undefined,
    "Document Desktop native PDF save", 10_000);
  expect(await readFile(target)).toEqual(expectedBytes);
  await waitFor(() => page.locator(".workspace-file-body__download").getAttribute("aria-busy"),
    (busy) => busy !== "true", "Document Desktop native save acknowledgement", 10_000);
  expect(await page.locator(".workspace-file-body__state.is-error").count()).toBe(0);
}

async function chooseNativeSaveTarget(mainPid: number, target: string): Promise<void> {
  const script = String.raw`
Add-Type -AssemblyName UIAutomationClient
$ErrorActionPreference = 'Stop'
$mainPid = [int]$env:JOKO_E2E_MAIN_PID
$target = $env:JOKO_E2E_SAVE_TARGET
$deadline = [DateTime]::UtcNow.AddSeconds(25)
$dialog = $null
do {
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Window)))
  foreach ($window in $windows) {
    if ($window.Current.ProcessId -ne $mainPid) { continue }
    $dialog = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')))
    if ($null -ne $dialog) { break }
  }
  if ($null -ne $dialog) { break }
  Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
if ($null -eq $dialog) { throw 'The owned native save dialog did not appear.' }
$fileNameHost = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'FileNameControlHost')))
if ($null -eq $fileNameHost) { throw 'The native file name control is unavailable.' }
$fileNameEdit = $fileNameHost.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1001')))
if ($null -eq $fileNameEdit) { throw 'The native file name editor is unavailable.' }
$fileNameSet = $false
do {
  try {
    $fileNameEdit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($target)
    $fileNameSet = $true
  } catch { Start-Sleep -Milliseconds 100 }
} while (-not $fileNameSet -and [DateTime]::UtcNow -lt $deadline)
if (-not $fileNameSet) { throw 'The native file name editor did not become writable.' }
$saveButton = $null
do {
  $saveButton = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1'))) |
    Where-Object { $_.Current.ClassName -eq 'Button' } | Select-Object -Last 1
  if ($null -ne $saveButton) { break }
  Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
if ($null -eq $saveButton) { throw 'The native save action is unavailable.' }
$saveInvoked = $false
do {
  try {
    $saveButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $saveInvoked = $true
  } catch { Start-Sleep -Milliseconds 100 }
} while (-not $saveInvoked -and [DateTime]::UtcNow -lt $deadline)
if (-not $saveInvoked) { throw 'The native save action did not become invokable.' }
`;
  await new Promise<void>((resolveSave, rejectSave) => {
    execFile("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, JOKO_E2E_MAIN_PID: String(mainPid), JOKO_E2E_SAVE_TARGET: target }
    }, (error, _stdout, stderr) => error
      ? rejectSave(new Error(`Native save selection failed: ${stderr.trim()}`, { cause: error }))
      : resolveSave());
  });
}

async function closeDesktop(): Promise<void> {
  if (desktopIdentity === undefined) return;
  const original = desktopIdentity;
  const current = await readOwnedDesktopProcess(original.pid);
  if (current !== undefined && (current.executablePath.toLowerCase() !== original.executablePath.toLowerCase()
    || current.startedAt !== original.startedAt)) {
    throw new Error("Document Desktop cleanup refused a changed process identity.");
  }
  if (current !== undefined) {
    await desktop?.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); return true; }).catch(() => undefined);
    try {
      await waitFor(() => readOwnedDesktopProcess(original.pid), (candidate) => candidate === undefined,
        "Document Desktop complete exit", 30_000);
    } catch (error) {
      const stillOwned = await readOwnedDesktopProcess(original.pid);
      if (stillOwned !== undefined && stillOwned.executablePath.toLowerCase() === original.executablePath.toLowerCase()
        && stillOwned.startedAt === original.startedAt) {
        await new Promise<void>((resolveKill, rejectKill) => {
          execFile("taskkill.exe", ["/PID", String(original.pid), "/T", "/F"],
            { windowsHide: true, timeout: 10_000 }, (killError) => killError ? rejectKill(killError) : resolveKill());
        });
      }
      throw new Error("Document Desktop did not complete its normal exit.", { cause: error });
    }
  }
  desktopIdentity = undefined;
  desktop = undefined;
}

async function readOwnedDesktopProcess(pid: number): Promise<OwnedDesktopProcess | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid Document Desktop PID.");
  const script = `$candidate = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $candidate) { [pscustomobject]@{ pid = $candidate.ProcessId; executablePath = $candidate.ExecutablePath; startedAt = $candidate.CreationDate.ToUniversalTime().ToString('O') } | ConvertTo-Json -Compress }`;
  const output = await new Promise<string>((resolveOutput, rejectOutput) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000 }, (error, stdout) => error ? rejectOutput(error) : resolveOutput(stdout));
  });
  return output.trim() ? JSON.parse(output) as OwnedDesktopProcess : undefined;
}
