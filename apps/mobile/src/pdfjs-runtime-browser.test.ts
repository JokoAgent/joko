import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MobilePdfJsRuntimeBundle } from "./mobile-pdf-viewer";

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
  it("boots its in-thread worker and parses a real all-page PDF without network resources", async () => {
    const entry = resolve(mobileRoot, "src", "pdfjs-runtime.pdfjs");
    const moduleSource = transformer.testing.buildPdfJsRuntimeModule(readFileSync(entry, "utf8"), entry);
    const bundle = JSON.parse(moduleSource.slice("module.exports = ".length, -1)) as MobilePdfJsRuntimeBundle;
    const dom = new JSDOM("", { runScripts: "outside-only" });
    installStandardWebPlatform(dom.window);
    dom.window.eval(bundle.script);
    const runtime = dom.window as unknown as typeof globalThis & {
      pdfjsLib: { getDocument(input: object): { promise: Promise<{
        numPages: number;
        getPage(pageNumber: number): Promise<{ getViewport(input: { scale: number }): { width: number; height: number } }>;
        destroy(): Promise<void>;
      }>; destroy(): Promise<void> } };
      pdfjsWorker: { WorkerMessageHandler: { setup: unknown } };
    };
    expect(typeof runtime.pdfjsLib.getDocument).toBe("function");
    expect(typeof runtime.pdfjsWorker.WorkerMessageHandler.setup).toBe("function");
    const loading = runtime.pdfjsLib.getDocument({ data: onePagePdf(), useWorkerFetch: false, useWasm: false,
      useSystemFonts: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false });
    const document = await loading.promise;
    expect(document.numPages).toBe(1);
    const page = await document.getPage(1);
    expect(page.getViewport({ scale: 1 })).toMatchObject({ width: 612, height: 792 });
    await document.destroy();
    dom.window.close();
  });
});

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

function onePagePdf(): Uint8Array {
  const encoder = new TextEncoder();
  const header = "%PDF-1.7\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n"
  ];
  const offsets: number[] = [];
  let body = header;
  for (const object of objects) {
    offsets.push(encoder.encode(body).byteLength);
    body += object;
  }
  const xref = encoder.encode(body).byteLength;
  const rows = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return encoder.encode(`${body}xref\n0 5\n0000000000 65535 f \n${rows}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
