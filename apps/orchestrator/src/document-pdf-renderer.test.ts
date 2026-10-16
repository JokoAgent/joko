import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPdf, renderPdf } from "@joko/tool-document";
import { expect, it } from "vitest";
import { ChromiumDocumentPdfRenderer } from "./document-pdf-renderer.js";

it.runIf(Boolean(process.env.JOKO_BROWSER_EXECUTABLE))("renders a real PDF in a closed Chromium context", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-pdf-browser-"));
  let requests = 0;
  const server = createServer((_request, response) => { requests += 1; response.end("unexpected"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local test server unavailable.");
    const renderer = new ChromiumDocumentPdfRenderer(process.env.JOKO_BROWSER_EXECUTABLE!);
    const output = await renderer.render({
      html: `<html><body><h1>Visible print</h1><img src="http://127.0.0.1:${address.port}/probe"></body></html>`,
      pageSize: "A4", landscape: false, printBackground: true,
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
      timeoutMs: 30_000, fontTimeoutMs: 5_000
    });
    expect(output.buffer.subarray(0, 5).toString()).toBe("%PDF-");
    await writeFile(join(root, "actual.pdf"), output.buffer);
    const inspected = await inspectPdf({ path: "actual.pdf" }, root);
    expect(inspected).toMatchObject({ numPages: 1, verdict: "ok", blankPages: [],
      pages: [{ page: 1, paper: "A4", textPreview: "Visible print", blank: false }] });
    expect(requests).toBe(0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);

it.runIf(Boolean(process.env.JOKO_BROWSER_EXECUTABLE) && process.platform === "darwin")(
  "prints the actual report template with readable Latin and Chinese system-font text", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-pdf-report-font-"));
    try {
      const text = "Visible print 中文报告";
      const renderer = new ChromiumDocumentPdfRenderer(process.env.JOKO_BROWSER_EXECUTABLE!);
      const output = await renderPdf({ html: `<h1>${text}</h1>`, outPath: "report.pdf", theme: "navy" }, root, renderer);
      await writeFile(join(root, "report.pdf"), output.buffer);
      const inspection = await inspectPdf({ path: "report.pdf" }, root);
      if (process.env.RUNNER_TEMP !== undefined) {
        const directory = join(process.env.RUNNER_TEMP, "joko-web-evidence", "document-tools");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "bilingual-report.pdf"), output.buffer);
        await writeFile(join(directory, "bilingual-report.json"), JSON.stringify({
          sourceCommit: process.env.GITHUB_SHA, fontsReady: output.fontsReady, inspection
        }, null, 2));
      }
      expect(output.fontsReady).toBe(true);
      expect(inspection).toMatchObject({ numPages: 1, verdict: "ok", blankPages: [],
        pages: [{ page: 1, paper: "A4", blank: false }] });
      expect(inspection.pages[0]?.textPreview.replace(/\s/gu, "")).toBe(text.replace(/\s/gu, ""));
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 45_000);
