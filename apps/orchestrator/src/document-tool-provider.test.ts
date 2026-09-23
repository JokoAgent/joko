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
  expect(provider.tools.map(tool => [tool.name, tool.requiresPermission])).toEqual([["make_docx", true], ["make_pptx", true]]);
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
  expect(published).toHaveLength(2);
});
