import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPdf } from "@joko/tool-document";
import { expect, it } from "vitest";
import { ElectronDocumentPdfRenderer } from "./document-electron-pdf-renderer.js";

it.runIf(Boolean(process.env.JOKO_PDF_ELECTRON_TEST_EXECUTABLE))("renders through the isolated Electron helper without network reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-pdf-electron-test-"));
  let requests = 0;
  const server = createServer((_request, response) => { requests += 1; response.end("unexpected"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local test server unavailable.");
    const renderer = new ElectronDocumentPdfRenderer(process.env.JOKO_PDF_ELECTRON_TEST_EXECUTABLE!, process.env.JOKO_PDF_ELECTRON_TEST_APP);
    const output = await renderer.render({
      html: `<h1>Packaged renderer</h1><img src="http://127.0.0.1:${address.port}/probe">`,
      pageSize: "A4", landscape: false, printBackground: true,
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
      timeoutMs: 30_000, fontTimeoutMs: 5_000
    });
    expect(output.buffer.subarray(0, 5).toString()).toBe("%PDF-");
    await writeFile(join(root, "electron.pdf"), output.buffer);
    expect(await inspectPdf({ path: "electron.pdf" }, root)).toMatchObject({ numPages: 1, verdict: "ok", blankPages: [],
      pages: [{ paper: "A4", textPreview: "Packaged renderer", blank: false }] });
    expect(requests).toBe(0);
    const landscape = await renderer.render({
      html: "<h1>Landscape page</h1>", pageSize: "Letter", landscape: true, printBackground: true,
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }, timeoutMs: 30_000, fontTimeoutMs: 5_000
    });
    await writeFile(join(root, "landscape.pdf"), landscape.buffer);
    expect(await inspectPdf({ path: "landscape.pdf" }, root)).toMatchObject({ numPages: 1, verdict: "ok", blankPages: [],
      pages: [{ paper: "Letter landscape", textPreview: "Landscape page", blank: false }] });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(renderer.render({ html: "<p>Stopped</p>", pageSize: "A4", landscape: false,
      printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 },
      timeoutMs: 30_000, fontTimeoutMs: 5_000, signal: cancelled.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);

it.runIf(Boolean(process.env.JOKO_PDF_ELECTRON_TEST_EXECUTABLE))("terminates a stalled render and serves the next job", async () => {
  const renderer = new ElectronDocumentPdfRenderer(process.env.JOKO_PDF_ELECTRON_TEST_EXECUTABLE!, process.env.JOKO_PDF_ELECTRON_TEST_APP);
  const options = { pageSize: "A4" as const, landscape: false, printBackground: true,
    margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }, fontTimeoutMs: 5_000 };
  await expect(renderer.render({ ...options, html: "<script>for (;;) {}</script>", timeoutMs: 2_000 }))
    .rejects.toMatchObject({ code: "RENDER_TIMEOUT" });
  const recovered = await renderer.render({ ...options, html: "<h1>Recovered render</h1>", timeoutMs: 30_000 });
  expect(recovered.buffer.subarray(0, 5).toString()).toBe("%PDF-");
}, 45_000);
