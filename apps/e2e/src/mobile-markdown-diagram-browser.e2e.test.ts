import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { expect, it, vi } from "vitest";
import { waitFor } from "./fixture.js";

const browserPath = process.env.JOKO_BROWSER_EXECUTABLE?.trim();
const browserIt = browserPath ? it : it.skip;

browserIt("encodes the complete mobile chart as real PNG pixels from the pinned offline Mermaid renderer", { timeout: 45_000 }, async () => {
  const require = createRequire(import.meta.url);
  const transformer = require(fileURLToPath(new URL("../../mobile/svg-string-transformer.cjs", import.meta.url))) as {
    testing: { buildRichMarkdownRuntimeModule(source: string, path: string): string };
  };
  const entry = fileURLToPath(new URL("../../mobile/src/rich-markdown-runtime.richjs", import.meta.url));
  const moduleText: string = transformer.testing.buildRichMarkdownRuntimeModule(await readFile(entry, "utf8"), entry);
  const runtime = JSON.parse(moduleText.slice("module.exports = ".length, -1)) as {
    mermaidScript: string; katexScript: string; katexCss: string; mermaidVersion: string;
  };
  expect(runtime.mermaidVersion).toBe("11.16.0");
  const colors = { surface: "#ffffff", background: "#f7f6f3", ink: "#242a2d", muted: "#637073",
    accent: "#ff9800", border: "#e1e2df", negative: "#cc634e" };
  const instanceId = "chart-preview", requestId = "chart-save";
  const input = { instanceId, kind: "mermaid" as const, colors, zoomable: true,
    source: "flowchart TD\nA[foo(bar)] --> B[The complete chart]" };
  const { buildMobileMarkdownRichHtml, parseMobileMarkdownDiagramPng, parseMobileMarkdownRichStatus } = await vi.importActual<{
    buildMobileMarkdownRichHtml(options: typeof input, assets: typeof runtime): string;
    parseMobileMarkdownDiagramPng(raw: string, instanceId: string, requestId: string):
      { base64: string } | { failed: true } | undefined;
    parseMobileMarkdownRichStatus(raw: string, instanceId: string): { state: string } | undefined;
  }>("../../mobile/src/mobile-markdown-rich-html.js");
  const html = buildMobileMarkdownRichHtml(input, runtime);
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
    const messages: string[] = [];
    await page.exposeFunction("receiveChartMessage", (message: string) => { messages.push(message); });
    await page.addInitScript(() => {
      const { receiveChartMessage } = window as Window & { receiveChartMessage?: (value: string) => Promise<void> };
      Object.assign(window, { ReactNativeWebView: { postMessage: (value: string) => { void receiveChartMessage?.(value); } } });
    });
    const url = "https://joko-mobile-renderer.test/diagram";
    await page.route(url, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await waitFor(async () => messages.some(raw => parseMobileMarkdownRichStatus(raw, instanceId)?.state === "ready"),
      Boolean, "the repaired chart to render", 15_000);
    const svg = page.locator("#root > svg");
    await svg.getByText("foo(bar)", { exact: true }).waitFor();
    const intrinsic = await svg.evaluate((element) => {
      const chart = element as SVGSVGElement;
      const { width, height } = chart.viewBox.baseVal;
      chart.style.transform = "scale(2) translateX(15%)";
      return { width, height };
    });
    const scale = Math.min(3, 4096 / intrinsic.width, 4096 / intrinsic.height,
      Math.sqrt(12_000_000 / (intrinsic.width * intrinsic.height)));
    expect(messages.some(raw => parseMobileMarkdownDiagramPng(raw, instanceId, requestId))).toBe(false);
    await page.evaluate((request) => {
      const diagram = window as Window & { jokoExportMarkdownDiagram?: (id: string) => void };
      if (typeof diagram.jokoExportMarkdownDiagram !== "function") throw new Error("The chart export command is missing.");
      diagram.jokoExportMarkdownDiagram(request);
    }, requestId);
    const receipt = await waitFor(async () => messages.map(raw => parseMobileMarkdownDiagramPng(raw, instanceId, requestId)).find(Boolean),
      (result) => result !== undefined, "a single chart PNG receipt", 15_000);
    if (receipt === undefined || !("base64" in receipt)) throw new Error("The real renderer did not return a PNG.");
    const raster = await page.evaluate(async (base64) => {
      const image = new Image();
      image.src = "data:image/png;base64," + base64;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 32; canvas.height = 32;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      return { width: image.naturalWidth, height: image.naturalHeight,
        hasBackground: pixels.some((value, index) => index % 4 === 0 && value === 255 && pixels[index + 1] === 255
          && pixels[index + 2] === 255 && pixels[index + 3] === 255),
        hasChart: pixels.some((value, index) => index % 4 === 0 && value < 210 && pixels[index + 3] === 255) };
    }, receipt.base64);
    expect(raster).toEqual({ width: Math.max(1, Math.floor(intrinsic.width * scale)),
      height: Math.max(1, Math.floor(intrinsic.height * scale)), hasBackground: true, hasChart: true });
    if (process.env.RUNNER_TEMP) {
      const directory = join(process.env.RUNNER_TEMP, "joko-web-evidence", "mobile-diagram");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "original-chart.png"), Buffer.from(receipt.base64, "base64"));
    }
  } finally { await browser.close(); }
});
