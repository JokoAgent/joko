import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = process.env.RUNNER_TEMP, executable = process.env.JOKO_BROWSER_EXECUTABLE;
if (!temporary || !isAbsolute(temporary) || !executable || !isAbsolute(executable)) {
  throw new Error("The PDF observation requires explicit absolute runner evidence and browser paths.");
}
const directory = join(temporary, "joko-web-evidence", "document-fonts");
await mkdir(directory, { recursive: true });
const require = createRequire(join(root, "apps/orchestrator/package.json"));
const { chromium } = require("playwright-core");
const { applyReportTemplate } = await import(pathToFileURL(join(root, "packages/tool-document/dist/pdfTemplate.js")).href);
const { resolveDocsTheme } = await import(pathToFileURL(join(root, "packages/tool-document/dist/themes.js")).href);
const { inspectPdf } = await import(pathToFileURL(join(root, "packages/tool-document/dist/inspectPdf.js")).href);
const html = "<h1>Replacement PDF</h1>";
const report = applyReportTemplate(html, resolveDocsTheme("navy")).html;
const variants = [
  { name: "raw", html },
  { name: "report", html: report },
  { name: "report-arial", html: report.replace("</head>", "<style>body { font-family: Arial, sans-serif !important; }</style></head>") },
  { name: "report-navigation", html: report, navigate: true }
];
const observations = { sourceCommit: process.env.GITHUB_SHA ?? "working-tree",
  scope: "Controlled PDF font and layout diagnosis; the production E2E result remains authoritative.", variants: [] };
let browser, expired = false;
const timer = setTimeout(() => {
  expired = true;
  void browser?.close();
}, 90_000);
try {
  browser = await chromium.launch({ executablePath: executable, headless: true, chromiumSandbox: true,
    timeout: 15_000, args: ["--disable-extensions", "--no-first-run", "--disable-background-networking"] });
  observations.browserVersion = browser.version();
  const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block",
    offline: true, viewport: { width: 1024, height: 1440 }, permissions: [] });
  context.setDefaultTimeout(10_000);
  await context.route("**/*", route => route.abort("blockedbyclient"));
  await context.routeWebSocket("**/*", route => route.close({ code: 1008, reason: "Offline PDF observation" }));
  for (const variant of variants) {
    if (expired) throw new Error("The bounded PDF observation expired.");
    const page = await context.newPage();
    try {
      await page.emulateMedia({ media: "print" });
      if (variant.navigate) {
        await page.goto("data:text/html;charset=utf-8," + encodeURIComponent(variant.html), { waitUntil: "load" });
      } else await page.setContent(variant.html, { waitUntil: "load" });
      await page.evaluate(() => { document.documentElement.getBoundingClientRect(); });
      let fontTimer;
      const fontsReady = await Promise.race([
        page.evaluate(() => document.fonts.ready.then(() => true)),
        new Promise(resolve => { fontTimer = setTimeout(() => resolve(false), 5_000); })
      ]).finally(() => clearTimeout(fontTimer));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await page.evaluate(() => {
        const heading = document.querySelector("h1"), style = getComputedStyle(heading);
        return { headingText: heading.textContent, bounds: heading.getBoundingClientRect().toJSON(),
          bodyBounds: document.body.getBoundingClientRect().toJSON(), fontStatus: document.fonts.status,
          fontFamily: style.fontFamily, fontSize: style.fontSize, color: style.color,
          display: style.display, visibility: style.visibility, opacity: style.opacity,
          fontsAvailable: ["PingFang SC", "Hiragino Sans GB", "Helvetica Neue", "Arial", "sans-serif"]
            .map(family => ({ family, available: document.fonts.check('bold 29px "' + family + '"', "Replacement PDF") })) };
      });
      const client = await context.newCDPSession(page);
      await client.send("DOM.enable"); await client.send("CSS.enable");
      const { root: documentNode } = await client.send("DOM.getDocument");
      const { nodeId } = await client.send("DOM.querySelector", { nodeId: documentNode.nodeId, selector: "h1" });
      const platformFonts = await client.send("CSS.getPlatformFontsForNode", { nodeId });
      await client.detach();
      const screenshot = await page.screenshot({ path: join(directory, variant.name + ".png"), timeout: 10_000 });
      const pdf = await page.pdf({ path: join(directory, variant.name + ".pdf"), timeout: 15_000,
        format: "A4", printBackground: true, preferCSSPageSize: false,
        margin: { top: "0in", bottom: "0in", left: "0in", right: "0in" } });
      const inspection = await inspectPdf({ path: variant.name + ".pdf" }, directory);
      observations.variants.push({ name: variant.name, fontsReady, layout, platformFonts,
        pdfBytes: pdf.length, pdfSha256: createHash("sha256").update(pdf).digest("hex"),
        screenshotSha256: createHash("sha256").update(screenshot).digest("hex"), inspection });
      await writeFile(join(directory, "observations.json"), JSON.stringify(observations, null, 2) + "\n");
    } finally { await page.close(); }
  }
  process.stdout.write("Controlled PDF font/layout observations exported; this does not change the production E2E result.\n");
} catch (error) {
  observations.failed = true; observations.deadlineExpired = expired;
  await writeFile(join(directory, "observations.json"), JSON.stringify(observations, null, 2) + "\n");
  throw error;
} finally { clearTimeout(timer); await browser?.close(); }
