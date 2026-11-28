import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { buildMobilePdfViewerCommand, buildMobilePdfViewerHtml, type MobilePdfJsRuntimeBundle } from "./mobile-pdf-viewer";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  readonly JSDOM: new (html?: string, options?: { readonly runScripts?: "outside-only" }) => {
    readonly window: Window & { eval(source: string): unknown };
  };
};
const pdfJsRequire = createRequire(require.resolve("pdfjs-dist/package.json"));
const canvasPrimitives = pdfJsRequire("@napi-rs/canvas") as Record<string, unknown>;
const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const transformer = require(resolve(mobileRoot, "svg-string-transformer.cjs")) as {
  readonly testing: { readonly buildPdfJsRuntimeModule: (source: string, filename: string) => string };
};

describe("bundled mobile pdf.js browser runtime", () => {
  it("boots its in-thread worker and resolves a real PDF link to its explicit page and point offline", async () => {
    const bundle = buildRuntime();
    const dom = new JSDOM("", { runScripts: "outside-only" });
    installStandardWebPlatform(dom.window);
    dom.window.eval(bundle.script);
    const runtime = dom.window as unknown as typeof globalThis & {
      pdfjsLib: { AnnotationType: { LINK: number }; getDocument(input: object): { promise: Promise<{
        numPages: number;
        getPage(pageNumber: number): Promise<{ getViewport(input: { scale: number }): { width: number; height: number };
          getAnnotations(input: { intent: "display" }): Promise<{ annotationType: number; rect: number[];
            dest?: readonly [{ num: number; gen: number }, { name: string }, number, number, null] }[]> }>;
        getPageIndex(ref: { num: number; gen: number }): Promise<number>;
        destroy(): Promise<void>;
      }>; destroy(): Promise<void> } };
      pdfjsWorker: { WorkerMessageHandler: { setup: unknown } };
    };
    expect(typeof runtime.pdfjsLib.getDocument).toBe("function");
    expect(typeof runtime.pdfjsWorker.WorkerMessageHandler.setup).toBe("function");
    const loading = runtime.pdfjsLib.getDocument({ data: twoPagePdf(), useWorkerFetch: false, useWasm: false,
      useSystemFonts: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false });
    const document = await loading.promise;
    expect(document.numPages).toBe(2);
    const page = await document.getPage(1);
    expect(page.getViewport({ scale: 1 })).toMatchObject({ width: 612, height: 792 });
    const links = await page.getAnnotations({ intent: "display" });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ annotationType: runtime.pdfjsLib.AnnotationType.LINK, rect: [36, 688, 206, 712],
      dest: [{ num: 5, gen: 0 }, { name: "XYZ" }, 36, 660, null] });
    expect(await document.getPageIndex(links[0]!.dest![0])).toBe(1);
    await document.destroy();
    dom.window.close();
  });

  it.skipIf(!process.env["JOKO_BROWSER_EXECUTABLE"]).each([false, true])("reads the original offline PDF and copies a word (protected=%s)", async protectedFile => {
    const browser = await chromium.launch({ executablePath: process.env["JOKO_BROWSER_EXECUTABLE"], headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 740 }, deviceScaleFactor: 2, hasTouch: protectedFile });
      const page = await context.newPage();
      const origin = "https://joko-pdf.invalid";
      const instanceId = "select-pdf";
      const html = buildMobilePdfViewerHtml({ instanceId, locale: "en", title: "manual.pdf",
        background: "#ffffff", surface: "#f5f5f5", ink: "#111111", muted: "#666666", accent: "#3366ff", border: "#dddddd" }, buildRuntime());
      const externalRequests: string[] = [];
      await context.route("**/*", (route) => {
        if (route.request().url() === origin + "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
        if (route.request().url() !== origin + "/favicon.ico") externalRequests.push(route.request().url());
        return route.abort();
      });
      await page.addInitScript(() => Object.defineProperty(window, "ReactNativeWebView", { value: { postMessage() {} } }));
      await context.grantPermissions(["clipboard-read"], { origin });
      await page.goto(origin);

      const bytes = protectedFile ? protectedPdf() : textPdf();
      await page.evaluate((commands) => {
        for (const data of commands) window.dispatchEvent(new MessageEvent("message", { data }));
      }, [buildMobilePdfViewerCommand(instanceId, { command: "begin", byteSize: bytes.byteLength,
        sha256Hex: createHash("sha256").update(bytes).digest("hex") }),
      buildMobilePdfViewerCommand(instanceId, { command: "chunk", index: 0, offset: 0, base64: Buffer.from(bytes).toString("base64") }),
      buildMobilePdfViewerCommand(instanceId, { command: "commit" })]);

      if (protectedFile) {
        const password = page.getByLabel("PDF password", { exact: true });
        await password.fill("wrong-password");
        await page.getByRole("button", { name: "Open", exact: true }).click();
        await page.getByText("Incorrect password. Try again.", { exact: true }).waitFor();
        expect(await password.inputValue()).toBe("");
        await password.fill("reader-demo"); await password.press("Enter");
      }
      const text = page.locator("#page-1 .page-text > span").filter({ hasText: "Quartz River" });
      await text.waitFor({ state: "visible", timeout: 12_000 });
      if (protectedFile) {
        await page.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data })),
          buildMobilePdfViewerCommand(instanceId, { command: "find" }));
        const query = page.getByRole("searchbox", { name: "Find in PDF" });
        await query.fill("no such text"); await query.press("Enter");
        await page.getByText("Matching pages (0)", { exact: true }).waitFor();
        await query.fill("bAsAlT"); await query.press("Enter");
        await page.getByText("Matching pages (1)", { exact: true }).waitFor();
        await expect.poll(() => page.locator("#page-2").evaluate(el => el.parentElement!.scrollTop > 0 &&
          el.getBoundingClientRect().bottom <= el.parentElement!.getBoundingClientRect().bottom + 1)).toBe(true);
        await query.fill("quartz"); await query.press("Enter");
        await page.getByText("Matching pages (1)", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Close" }).click();
        const canvas = page.locator("#page-1 canvas");
        await canvas.scrollIntoViewIfNeeded();
        const initial = (await canvas.boundingBox())!;
        const x = initial.x + initial.width / 2, y = Math.max(40, initial.y + 90);
        const input = await context.newCDPSession(page);
        const fingers = (spread: number) => [{ x: x - spread, y, id: 1 }, { x: x + spread, y, id: 2 }];
        await input.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: fingers(30) });
        await input.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: fingers(60) });
        await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(initial.width * 1.5);
        await page.touchscreen.tap(x, y); await page.touchscreen.tap(x, y);
        await expect.poll(async () => Math.abs(((await canvas.boundingBox())?.width ?? 0) - initial.width)).toBeLessThan(2);
        await input.detach();
      }
      const quartz = await text.evaluate((element) => {
        const word = document.createRange();
        word.setStart(element.firstChild!, 0);
        word.setEnd(element.firstChild!, "Quartz".length);
        const bounds = word.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      });
      const canvas = (await page.locator("#page-1 canvas").boundingBox())!;
      expect(quartz.width).toBeGreaterThan(15);
      expect(Math.abs(quartz.x - (canvas.x + canvas.width * 60 / 612))).toBeLessThan(2);
      expect(quartz.y).toBeGreaterThan(canvas.y);
      expect(quartz.y + quartz.height).toBeLessThan(canvas.y + canvas.height);

      const center = { x: quartz.x + quartz.width / 2, y: quartz.y + quartz.height / 2 };
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.textContent, center)).toBe("Quartz River");
      await page.mouse.dblclick(center.x, center.y);
      const selectedText = await page.evaluate(() => window.getSelection()?.toString());
      // Chromium on Windows includes the following space when selecting the word.
      expect(selectedText).toMatch(/^Quartz ?$/u);
      await page.keyboard.press("ControlOrMeta+c");
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(selectedText);
      expect(externalRequests).toEqual([]);
    } finally { await browser.close(); }
  }, 35_000);
});

function buildRuntime(): MobilePdfJsRuntimeBundle {
  const entry = resolve(mobileRoot, "src", "pdfjs-runtime.pdfjs");
  const moduleSource = transformer.testing.buildPdfJsRuntimeModule(readFileSync(entry, "utf8"), entry);
  return JSON.parse(moduleSource.slice("module.exports = ".length, -1)) as MobilePdfJsRuntimeBundle;
}

function installStandardWebPlatform(window: Window): void {
  const host = globalThis as unknown as Record<string, unknown>;
  const target = window as unknown as Record<string, unknown>;
  for (const name of [
    "AbortController", "Blob", "DOMMatrix", "Headers", "ImageData", "Path2D",
    "ReadableStream", "Request", "Response",
    "TextDecoder", "TextEncoder", "URL", "URLSearchParams", "fetch", "structuredClone"
  ]) {
    const value = canvasPrimitives[name] ?? host[name];
    if (target[name] === undefined && value !== undefined) {
      Object.defineProperty(target, name, { configurable: true, value });
    }
  }
}

function twoPagePdf(): Uint8Array {
  const text = "BT /F1 12 Tf 36 700 Td (Jump to the second page) Tj ET\n";
  return encodePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R /Annots [6 0 R] >>",
    `<< /Length ${text.length} >>\nstream\n${text}endstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    "<< /Type /Annot /Subtype /Link /Rect [36 688 206 712] /Dest [5 0 R /XYZ 36 660 null] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ]);
}

// Two synthetic pages containing “Quartz River” and “Basalt Mountain”, encrypted with the test reader password.
function protectedPdf(): Uint8Array {
  return Buffer.from(
    "JVBERi0xLjcKJcK1wrYKJSBXcml0dGVuIGJ5IE11UERGIDEuMjkuMAoKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFIv" +
    "SW5mbzw8L1Byb2R1Y2VyPEQ1MzJGMDg2QzEzRkQ2MDZFNTk2Nzg4MzRDQjg4RkZDQUU2MjUxQzJGOTVBMTE5RTM4RkUwMUI3NzYyQzkw" +
    "NzY+Pj4+PgplbmRvYmoKCjIgMCBvYmoKPDwvVHlwZS9QYWdlcy9Db3VudCAyL0tpZHNbNCAwIFIgNyAwIFJdPj4KZW5kb2JqCgozIDAg" +
    "b2JqCjw8L0ZvbnQ8PC9oZWx2IDUgMCBSPj4+PgplbmRvYmoKCjQgMCBvYmoKPDwvVHlwZS9QYWdlL01lZGlhQm94WzAgMCA2MTIgNzky" +
    "XS9Sb3RhdGUgMC9SZXNvdXJjZXMgMyAwIFIvUGFyZW50IDIgMCBSL0NvbnRlbnRzWzYgMCBSXT4+CmVuZG9iagoKNSAwIG9iago8PC9U" +
    "eXBlL0ZvbnQvU3VidHlwZS9UeXBlMS9CYXNlRm9udC9IZWx2ZXRpY2EvRW5jb2RpbmcvV2luQW5zaUVuY29kaW5nPj4KZW5kb2JqCgo2" +
    "IDAgb2JqCjw8L0xlbmd0aCA5Ni9GaWx0ZXIvRmxhdGVEZWNvZGU+PgpzdHJlYW0KtfVYOxosMGTersetkkEELIoXhzmjbyVI+qU+R9Aq" +
    "LG5doS14ylshyGZRgjOes7x2ZUN6qdnTCbRNQdRMN9+otfIInHnzpyEqubfg0Sn0zM5Ns3AJwr0NE5ehZlwSmqXaCmVuZHN0cmVhbQpl" +
    "bmRvYmoKCjcgMCBvYmoKPDwvVHlwZS9QYWdlL01lZGlhQm94WzAgMCA2MTIgNzkyXS9Sb3RhdGUgMC9SZXNvdXJjZXMgMyAwIFIvUGFy" +
    "ZW50IDIgMCBSL0NvbnRlbnRzWzggMCBSXT4+CmVuZG9iagoKOCAwIG9iago8PC9MZW5ndGggMTEyL0ZpbHRlci9GbGF0ZURlY29kZT4+" +
    "CnN0cmVhbQpkQHXLJOBxWfSNzbuMczdAaZCGst26pMoTPz1c95RHZq6A9c0c4QwRiHaJWXslQ27IYJCmvetfCug3DpMsfYj+yBDWp5GG" +
    "Z0ZKWstd5OMr02UTMEPh80Cszgneftvlfw8BCsQvjccw1Dob4VvZ5rOXCmVuZHN0cmVhbQplbmRvYmoKCnhyZWYKMCA5CjAwMDAwMDAw" +
    "MDAgNjU1MzUgZiAKMDAwMDAwMDA0MiAwMDAwMCBuIAowMDAwMDAwMTcyIDAwMDAwIG4gCjAwMDAwMDAyMzAgMDAwMDAgbiAKMDAwMDAw" +
    "MDI3MSAwMDAwMCBuIAowMDAwMDAwMzc4IDAwMDAwIG4gCjAwMDAwMDA0NjcgMDAwMDAgbiAKMDAwMDAwMDYzMSAwMDAwMCBuIAowMDAw" +
    "MDAwNzM4IDAwMDAwIG4gCgp0cmFpbGVyCjw8L1NpemUgOS9Sb290IDEgMCBSL0lEWzxDMjg4QzM5MkMyQjRDM0IzQzI4QTI0QzJCMzMw" +
    "MTQwNj48MUQxM0YyRjc4QzZCRjM3RjE0NEZDNEY2REQxQjk1NjA+XS9FbmNyeXB0PDwvRmlsdGVyL1N0YW5kYXJkL1IgNC9WIDQvTGVu" +
    "Z3RoIDEyOC9QIC0zODg4L0VuY3J5cHRNZXRhZGF0YSB0cnVlL1N0bUYvU3RkQ0YvU3RyRi9TdGRDRi9DRjw8L1N0ZENGPDwvQXV0aEV2" +
    "ZW50L0RvY09wZW4vQ0ZNL0FFU1YyL0xlbmd0aCAxNj4+Pj4vTzw1NTQyRjA4RjA1MUVFMEEzM0QxRjgxNUQxMzBEQTNDRTI2ODVDODY4" +
    "MkYwREM1QjhBMTBCMDdCRTFDN0REREQ0Pi9VPDBFNTVBMTg0NDM3OUM4RUFFN0QwRDA4ODQxRDg0QjVDMjhCRjRFNUU0RTc1OEE0MTY0" +
    "MDA0RTU2RkZGQTAxMDg+Pj4+PgpzdGFydHhyZWYKOTE5CiUlRU9GCg==", "base64");
}

function textPdf(): Uint8Array {
  const text = "BT /F1 30 Tf 60 660 Td (Quartz River) Tj ET\n";
  return encodePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${text.length} >>\nstream\n${text}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ]);
}

function encodePdf(objects: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const offsets: number[] = [];
  let body = "%PDF-1.7\n";
  for (const [index, object] of objects.entries()) {
    offsets.push(encoder.encode(body).byteLength);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = encoder.encode(body).byteLength;
  const rows = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  const size = objects.length + 1;
  return encoder.encode(`${body}xref\n0 ${size}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
