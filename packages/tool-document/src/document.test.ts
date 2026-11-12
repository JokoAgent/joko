import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { markdownToDocxBuffer, publishDocumentOutput, readDocumentInput, type DocumentPathAuthorizer } from "./index.js";

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
    expect(first.existingTarget).toBe(false);
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
    const replaced = await publishDocumentOutput({ root, outPath: "documents/report.docx", bytes: replacement, overwrite: true });
    expect(replaced).toMatchObject({ existingTarget: true, sha256: createHash("sha256").update(replacement).digest("hex") });
    expect(await readFile(first.path)).toEqual(replacement);
    expect(await publishDocumentOutput({ root, outPath: "documents/report.docx", bytes: replacement, overwrite: true }))
      .toEqual(replaced);
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

it("publishes only to the exact approved directory and verifies its identity before touching the output", async () => {
  const temp = await mkdtemp(join(tmpdir(), "joko-document-approved-"));
  try {
    const base = await realpath(temp);
    const root = join(base, "workspace");
    const outside = join(base, "outside");
    await Promise.all([mkdir(root), mkdir(outside)]);
    const inputPath = join(outside, "table.csv");
    await writeFile(inputPath, "one,two\n");
    const authorizeRead: DocumentPathAuthorizer = async request => {
      expect(request).toMatchObject({ path: inputPath, operation: "read" });
      return () => {};
    };
    expect(await readDocumentInput({ root, inPath: inputPath, maxBytes: 128, authorizePath: authorizeRead }))
      .toEqual(Buffer.from("one,two\n"));
    const bytes = await markdownToDocxBuffer("# Approved");
    const nested = join(outside, "new", "report.docx");
    await expect(publishDocumentOutput({ root, outPath: nested, bytes, overwrite: true, authorizePath: async request => {
      expect(request).toMatchObject({ path: nested, operation: "write", overwrite: true });
      return () => {};
    } })).resolves.toMatchObject({ path: nested, existingTarget: false });
    expect(await readFile(nested)).toEqual(bytes);

    const retired = join(base, "retired");
    const output = join(outside, "report.docx");
    const oldContent = Buffer.from("original output");
    await writeFile(output, oldContent);
    await expect(publishDocumentOutput({ root, outPath: output, bytes, overwrite: true, authorizePath: async request => {
      expect(request).toMatchObject({ path: output, operation: "write", overwrite: true });
      await rename(outside, retired);
      await mkdir(outside);
      await writeFile(output, "replacement directory output");
      return () => {};
    } })).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(await readFile(join(retired, "report.docx"))).toEqual(oldContent);
    expect(await readFile(output, "utf8")).toBe("replacement directory output");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
