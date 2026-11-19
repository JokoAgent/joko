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
  it("boots its in-thread worker and resolves a real PDF link to its explicit page and point offline", async () => {
    const entry = resolve(mobileRoot, "src", "pdfjs-runtime.pdfjs");
    const moduleSource = transformer.testing.buildPdfJsRuntimeModule(readFileSync(entry, "utf8"), entry);
    const bundle = JSON.parse(moduleSource.slice("module.exports = ".length, -1)) as MobilePdfJsRuntimeBundle;
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

function twoPagePdf(): Uint8Array {
  const encoder = new TextEncoder();
  const header = "%PDF-1.7\n";
  const text = "BT /F1 12 Tf 36 700 Td (Jump to the second page) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R /Annots [6 0 R] >>",
    `<< /Length ${text.length} >>\nstream\n${text}endstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    "<< /Type /Annot /Subtype /Link /Rect [36 688 206 712] /Dest [5 0 R /XYZ 36 660 null] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  const offsets: number[] = [];
  let body = header;
  for (const [index, object] of objects.entries()) {
    offsets.push(encoder.encode(body).byteLength);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = encoder.encode(body).byteLength;
  const rows = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  const size = objects.length + 1;
  return encoder.encode(`${body}xref\n0 ${size}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
