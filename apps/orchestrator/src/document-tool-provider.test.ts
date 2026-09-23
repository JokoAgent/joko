import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DocumentToolBridgeProvider } from "./document-tool-provider.js";

it("binds editable document creation to the current trusted local task and strict arguments", async () => {
  let generation = 3;
  let trusted = true;
  let remote = false;
  let root = "D:\\task";
  const published: Array<{ root: string; outPath: string; bytes: Uint8Array; overwrite: boolean }> = [];
  const provider = new DocumentToolBridgeProvider({
    store: {
      getSession: () => ({ descriptor: {
        id: "session", targetId: "target", backendId: "backend", binding: { generation },
        archived: false, worktree: { path: root, state: "active" }
      } }) as never,
      getTarget: () => ({ descriptor: {
        id: "target", backendId: "backend", trusted, workspaceRoot: "D:\\base",
        ...(remote ? { remoteWorkspace: { hostTargetId: "host", hostId: "host", workspaceRoot: "/remote" } } : {})
      } }) as never
    },
    publish: async input => {
      published.push(input);
      return { path: `${input.root}/${input.outPath}`, relativePath: input.outPath, bytes: input.bytes.length };
    }
  });
  const context = { sessionId: "session", targetId: "target", generation: 3 };
  expect(provider.tools.map(tool => [tool.name, tool.requiresPermission])).toEqual([["make_docx", true], ["make_pptx", true], ["make_xlsx", true], ["read_sheet", false], ["inspect_pdf", false]]);
  expect((await provider.callTool("render_pdf", { html: "<p>Unavailable</p>", outPath: "a.pdf" }, undefined, context)).structuredContent)
    .toMatchObject({ errorCode: "UNKNOWN_TOOL" });
  expect(provider.includeForTarget("target")).toBe(true);
  const result = await provider.callTool("make_docx", {
    markdown: "# Heading\n\n| A | B |\n|---|---|\n| 1 | 2 |",
    outPath: "documents/report.docx",
    title: "Report",
    theme: "navy"
  }, undefined, context);
  expect(result).toMatchObject({ isError: false, structuredContent: { format: "docx", theme: "navy", cover: true } });
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({ root: "D:\\task", outPath: "documents/report.docx", overwrite: false });
  expect(Buffer.from(published[0]!.bytes).subarray(0, 2).toString("ascii")).toBe("PK");
  const slides = [{ title: "Results", layout: "metrics", metrics: [{ value: "98%", label: "Uptime" }, { value: 12, label: "Regions" }] }];
  expect(await provider.callTool("make_pptx", { slides, outPath: "documents/results.pptx", theme: "dark" }, undefined, context))
    .toMatchObject({ isError: false, structuredContent: { format: "pptx", slides: 1, layouts: ["metrics"], theme: "dark" } });
  expect(published[1]).toMatchObject({ root: "D:\\task", outPath: "documents/results.pptx", overwrite: false });
  expect(Buffer.from(published[1]!.bytes).subarray(0, 2).toString("ascii")).toBe("PK");
  expect((await provider.callTool("make_pptx", { slides: [{ title: "Invalid", extra: true }], outPath: "bad.pptx" }, undefined, context)).structuredContent)
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect(await provider.callTool("make_xlsx", { sheets: [{ name: "Report", header: ["Count"], rows: [[42]] }], outPath: "documents/report.xlsx", theme: "navy" }, undefined, context))
    .toMatchObject({ isError: false, structuredContent: { format: "xlsx", sheets: [{ name: "Report", rows: 1 }], theme: "navy" } });
  expect(published[2]).toMatchObject({ root: "D:\\task", outPath: "documents/report.xlsx", overwrite: false });
  expect(Buffer.from(published[2]!.bytes).subarray(0, 2).toString("ascii")).toBe("PK");
  expect((await provider.callTool("make_xlsx", { sheets: [{ name: "Invalid", rows: [[{ formula: "SUM(A1:A2)" }]] }], outPath: "bad.xlsx" }, undefined, context)).structuredContent)
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect((await provider.callTool("make_docx", { markdown: "Hi", outPath: "report.docx", typo: true }, undefined, context)).structuredContent)
    .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect((await provider.callTool("make_docx", { markdown: "Hi", outPath: "report.pdf" }, undefined, context)).structuredContent)
    .toMatchObject({ errorCode: "INVALID_EXTENSION" });
  generation = 4;
  expect((await provider.callTool("make_docx", { markdown: "Hi", outPath: "report.docx" }, undefined, context)).structuredContent)
    .toMatchObject({ errorCode: "STALE_SCOPE" });
  generation = 3;
  remote = true;
  expect(provider.includeForTarget("target")).toBe(false);
  expect((await provider.callTool("make_docx", { markdown: "Hi", outPath: "report.docx" }, undefined, context)).structuredContent)
    .toMatchObject({ errorCode: "STALE_SCOPE" });
  remote = false;
  trusted = false;
  expect(provider.includeForTarget("target")).toBe(false);
  expect((await provider.callTool("make_docx", { markdown: "Hi", outPath: "report.docx" }, undefined, context)).structuredContent)
    .toMatchObject({ errorCode: "STALE_SCOPE" });
  expect(published).toHaveLength(3);
  const directory = await mkdtemp(join(tmpdir(), "joko-bridge-table-"));
  try {
    root = directory;
    trusted = true;
    await writeFile(join(directory, "values.csv"), "name,value\nEast,42\nWest,21\n");
    expect(await provider.callTool("read_sheet", { path: "values.csv", startRow: 2, maxRows: 1 }, undefined, context))
      .toMatchObject({ isError: false, structuredContent: { rows: [["East", "42"]], totalRows: 3, truncated: true, nextStartRow: 3 } });
    expect((await provider.callTool("read_sheet", { path: "values.csv", unknown: true }, undefined, context)).structuredContent)
      .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
    await writeFile(join(directory, "empty.pdf"), Buffer.alloc(0));
    expect((await provider.callTool("inspect_pdf", { path: "empty.pdf" }, undefined, context)).structuredContent)
      .toMatchObject({ errorCode: "EMPTY_FILE" });
    expect((await provider.callTool("inspect_pdf", { path: "empty.pdf", unknown: true }, undefined, context)).structuredContent)
      .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
    generation = 4;
    expect((await provider.callTool("inspect_pdf", { path: "empty.pdf" }, undefined, context)).structuredContent)
      .toMatchObject({ errorCode: "STALE_SCOPE" });
    generation = 3;
    remote = true;
    expect((await provider.callTool("inspect_pdf", { path: "empty.pdf" }, undefined, context)).structuredContent)
      .toMatchObject({ errorCode: "STALE_SCOPE" });
    expect(published).toHaveLength(3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("advertises PDF rendering only with a renderer and binds publication to the current task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-bridge-pdf-"));
  let generation = 7;
  let published = 0;
  const provider = new DocumentToolBridgeProvider({
    store: {
      getSession: () => ({ descriptor: { id: "session", targetId: "target", backendId: "backend",
        binding: { generation }, archived: false, worktree: { path: directory, state: "active" } } }) as never,
      getTarget: () => ({ descriptor: { id: "target", backendId: "backend", trusted: true, workspaceRoot: directory } }) as never
    },
    pdfRenderer: { render: async input => {
      expect(input.html).toContain("Rendered report");
      return { buffer: Buffer.from("%PDF-1.4\nfixture"), fontsReady: false };
    } },
    publish: async input => { published += 1; return { path: join(input.root, input.outPath), relativePath: input.outPath, bytes: input.bytes.length }; }
  });
  const context = { sessionId: "session", targetId: "target", generation: 7 };
  try {
    expect(provider.tools.at(-1)).toMatchObject({ name: "render_pdf", requiresPermission: true });
    expect(await provider.callTool("render_pdf", { html: "<h1>Rendered report</h1>", outPath: "documents/report.pdf" }, undefined, context))
      .toMatchObject({ isError: false, structuredContent: { format: "pdf", pageSize: "A4", fontsReady: false,
        templateApplied: true, relativePath: "documents/report.pdf" } });
    expect(published).toBe(1);
    expect((await provider.callTool("render_pdf", { html: "<p>Bad</p>", outPath: "bad.pdf", unknown: true }, undefined, context)).structuredContent)
      .toMatchObject({ errorCode: "INVALID_ARGUMENT" });
    generation = 8;
    expect((await provider.callTool("render_pdf", { html: "<p>Stale</p>", outPath: "stale.pdf" }, undefined, context)).structuredContent)
      .toMatchObject({ errorCode: "STALE_SCOPE" });
    expect(published).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
