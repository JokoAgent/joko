/// <reference types="node" />

import { readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, describe, expect, it } from "vitest";

import {
  copyPdfJsAssets,
  createPdfJsAssetMiddleware,
  PDFJS_DISTRIBUTION_ROOT
} from "../../pdfjs-assets.js";
import {
  WORKSPACE_PDF_CMAP_URL,
  WORKSPACE_PDF_STANDARD_FONT_DATA_URL
} from "./WorkspacePdfCanvas.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("WorkspacePdfCanvas pdf.js resources", () => {
  it("copies the complete pinned CMap and standard-font trees into a local Web bundle", async () => {
    const outputRoot = join(tmpdir(), `joko-pdfjs-assets-${crypto.randomUUID()}`);
    temporaryDirectories.push(outputRoot);
    await copyPdfJsAssets(PDFJS_DISTRIBUTION_ROOT, outputRoot);

    const cMaps = await readdir(join(outputRoot, "pdfjs", "cmaps"));
    const fonts = await readdir(join(outputRoot, "pdfjs", "standard_fonts"));
    expect(cMaps).toHaveLength(169);
    expect(fonts).toHaveLength(16);
    await expect(stat(join(outputRoot, "pdfjs", "cmaps", "UniGB-UTF16-H.bcmap")))
      .resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(join(outputRoot, "pdfjs", "standard_fonts", "FoxitSymbol.pfb")))
      .resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(join(outputRoot, "pdfjs", "standard_fonts", "FoxitDingbats.pfb")))
      .resolves.toMatchObject({ size: expect.any(Number) });
  });

  it("loads CJK Type0, Symbol, and ZapfDingbats data from the pinned local resources", async () => {
    const requests: string[] = [];
    class RecordingBinaryDataFactory {
      async fetch({ kind, filename }: { readonly kind: string; readonly filename: string }): Promise<Uint8Array> {
        requests.push(`${kind}:${filename}`);
        const directory = kind === "cMapUrl"
          ? "cmaps"
          : kind === "standardFontDataUrl" ? "standard_fonts" : undefined;
        if (directory === undefined) throw new Error(`Unexpected pdf.js resource kind: ${kind}`);
        return new Uint8Array(await readFile(join(PDFJS_DISTRIBUTION_ROOT, directory, filename)));
      }
    }

    const loadingTask = getDocument({
      data: representativeFontPdfFixture(),
      cMapUrl: `${join(PDFJS_DISTRIBUTION_ROOT, "cmaps")}/`,
      cMapPacked: true,
      standardFontDataUrl: `${join(PDFJS_DISTRIBUTION_ROOT, "standard_fonts")}/`,
      BinaryDataFactory: RecordingBinaryDataFactory,
      useWorkerFetch: false,
      useSystemFonts: false,
      disableFontFace: true
    });
    try {
      const document = await loadingTask.promise;
      const page = await document.getPage(1);
      await page.getOperatorList();
      const text = await page.getTextContent();
      expect(text.items.flatMap((item) => "str" in item ? [item.str] : [])).toContain("中文");
      expect(requests).toEqual(expect.arrayContaining([
        "cMapUrl:UniGB-UTF16-H.bcmap",
        "cMapUrl:Adobe-GB1-UCS2.bcmap",
        "standardFontDataUrl:FoxitSymbol.pfb",
        "standardFontDataUrl:FoxitDingbats.pfb"
      ]));
    } finally {
      await loadingTask.destroy();
    }

    expect(WORKSPACE_PDF_CMAP_URL).toBe("/pdfjs/cmaps/");
    expect(WORKSPACE_PDF_STANDARD_FONT_DATA_URL).toBe("/pdfjs/standard_fonts/");
  });

  it("serves the same resources in dev while rejecting encoded traversal", async () => {
    const middleware = createPdfJsAssetMiddleware(PDFJS_DISTRIBUTION_ROOT);
    const server = createServer((request, response) => middleware(request, response, () => {
      response.statusCode = 404;
      response.end();
    }));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      const address = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      const cMapResponse = await fetch(`${origin}/pdfjs/cmaps/UniGB-UTF16-H.bcmap`);
      const symbolResponse = await fetch(`${origin}/pdfjs/standard_fonts/FoxitSymbol.pfb`);
      expect(cMapResponse.status).toBe(200);
      expect(cMapResponse.headers.get("content-type")).toBe("application/octet-stream");
      expect((await cMapResponse.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect(symbolResponse.status).toBe(200);
      expect((await symbolResponse.arrayBuffer()).byteLength).toBeGreaterThan(0);
      await expect(fetch(`${origin}/pdfjs/cmaps/%2e%2e%5cpackage.json`))
        .resolves.toMatchObject({ status: 403 });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });
});

/** One-page, in-memory fixture that forces every required font resource path. */
function representativeFontPdfFixture(): Uint8Array {
  const content = [
    "BT /FChinese 18 Tf 72 720 Td <4E2D6587> Tj ET",
    "BT /FSymbol 18 Tf 72 680 Td (abc) Tj ET",
    "BT /FDingbats 18 Tf 72 640 Td (abc) Tj ET"
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /FChinese 5 0 R /FSymbol 7 0 R /FDingbats 8 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UTF16-H /DescendantFonts [6 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 5 >> /FontDescriptor 9 0 R /DW 1000 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>",
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>"
  ];
  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(byteLength(source));
    source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
