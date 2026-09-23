import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { markdownToDocxBuffer, publishDocumentOutput } from "./index.js";

it("builds editable Word structure and publishes it only inside the task root", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-document-"));
  const outside = await mkdtemp(join(tmpdir(), "joko-document-outside-"));
  try {
    const bytes = await markdownToDocxBuffer([
      "# Main heading",
      "",
      "Body with **bold**, *italic*, and [a link](https://example.test/).",
      "",
      "1. First",
      "2. Second",
      "",
      "| Item | Amount |",
      "| --- | ---: |",
      "| One | 42 |",
      "",
      "> A quoted line",
      "",
      "```ts",
      "const answer = 42;",
      "```",
      "",
      "<!-- pagebreak -->"
    ].join("\n"), { title: "Report", subtitle: "Editable example", theme: "navy" });
    const first = await publishDocumentOutput({ root, outPath: "documents/report.docx", bytes, overwrite: false });
    expect(first.relativePath).toBe(join("documents", "report.docx"));
    expect(first.bytes).toBe(bytes.length);
    const archive = await JSZip.loadAsync(await readFile(first.path));
    const document = await archive.file("word/document.xml")!.async("string");
    const styles = await archive.file("word/styles.xml")!.async("string");
    const relationships = await archive.file("word/_rels/document.xml.rels")!.async("string");
    expect(document).toContain("Main heading");
    expect(document).toContain("const answer = 42;");
    expect(document).toContain("<w:tbl>");
    expect(document).toContain("<w:br w:type=\"page\"");
    expect(styles).toContain("Heading1");
    expect(relationships).toContain("https://example.test/");
    await expect(publishDocumentOutput({ root, outPath: "documents/report.docx", bytes, overwrite: false }))
      .rejects.toMatchObject({ code: "FILE_EXISTS" });
    const replacement = await markdownToDocxBuffer("Replacement body");
    await publishDocumentOutput({ root, outPath: "documents/report.docx", bytes: replacement, overwrite: true });
    expect(await readFile(first.path)).toEqual(replacement);
    await expect(publishDocumentOutput({ root, outPath: "../escape.docx", bytes, overwrite: false }))
      .rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(publishDocumentOutput({ root, outPath: "linked/escape.docx", bytes, overwrite: false }))
      .rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(readFile(join(outside, "escape.docx"))).rejects.toMatchObject({ code: "ENOENT" });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(publishDocumentOutput({ root, outPath: "documents/cancelled.docx", bytes, overwrite: false, signal: cancelled.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    await expect(readFile(join(root, "documents", "cancelled.docx"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
