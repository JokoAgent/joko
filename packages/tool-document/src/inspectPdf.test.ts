import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inspectPdf } from "./index.js";

function buildPdf(pageSpecs: Array<string | null | { raw: string }>, mediaBox = "[0 0 595.28 841.89]"): Buffer {
  const objects: string[] = ["", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const add = (value: string): number => { objects.push(value); return objects.length; };
  const pageNumbers: number[] = [];
  for (const spec of pageSpecs) {
    if (spec === null) {
      pageNumbers.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox ${mediaBox} /Resources << >> >>`));
      continue;
    }
    const stream = typeof spec === "string" ? `BT /F1 24 Tf 72 760 Td (${spec}) Tj ET` : spec.raw;
    const contentNumber = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageNumbers.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox ${mediaBox} /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNumber} 0 R >>`));
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pageNumbers.map(number => `${number} 0 R`).join(" ")}] /Count ${pageNumbers.length} >>`;
  let output = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(output.length); output += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}

it("inspects real PDF pages, preserves batch evidence, and rejects changed or untrusted input", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-inspect-pdf-"));
  const outside = await mkdtemp(join(tmpdir(), "joko-inspect-pdf-outside-"));
  try {
    await writeFile(join(root, "report.pdf"), buildPdf(["First page", null, "Third page"]));
    const first = await inspectPdf({ path: "report.pdf", maxPages: 1 }, root);
    expect(first).toMatchObject({ numPages: 3, pagesInspected: 1, inspectedThrough: 1,
      blankPages: [], nextPages: [2], verdict: "incomplete",
      pages: [{ page: 1, paper: "A4", textPreview: "First page", blank: false, visibilityUnverified: false }] });
    const second = await inspectPdf({ path: "report.pdf", pages: first.nextPages,
      inspectedThrough: first.inspectedThrough, previousVerdict: first.verdict,
      previousPdfSha256: first.pdfSha256, maxPages: 1 }, root);
    expect(second).toMatchObject({ inspectedThrough: 2, blankPages: [2], nextPages: [3], verdict: "partial-blank",
      pages: [{ page: 2, textChars: 0, drawOps: 0, imageOps: 0, blank: true }] });
    const third = await inspectPdf({ path: "report.pdf", pages: second.nextPages,
      inspectedThrough: second.inspectedThrough, previousVerdict: second.verdict,
      previousPdfSha256: second.pdfSha256, maxPages: 1 }, root);
    expect(third).toMatchObject({ inspectedThrough: 3, verdict: "partial-blank", blankPages: [], pages: [{ page: 3, textPreview: "Third page" }] });
    expect(third.nextPages).toBeUndefined();
    expect((await inspectPdf({ path: "report.pdf", pages: [3, 1, 3, 99], maxPages: 2 }, root)).pages.map(page => page.page)).toEqual([1, 3]);
    await expect(inspectPdf({ path: "report.pdf", pages: [99] }, root)).rejects.toMatchObject({ code: "NO_PAGES_INSPECTED" });
    await expect(inspectPdf({ path: "report.pdf", inspectedThrough: 1 }, root)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(inspectPdf({ path: "report.pdf", inspectedThrough: 4,
      previousVerdict: "ok", previousPdfSha256: first.pdfSha256 }, root)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await writeFile(join(root, "report.pdf"), buildPdf(["Changed"]));
    await expect(inspectPdf({ path: "report.pdf", inspectedThrough: 1,
      previousVerdict: first.verdict, previousPdfSha256: first.pdfSha256 }, root)).rejects.toMatchObject({ code: "PDF_CHANGED" });
    await writeFile(join(root, "blank.pdf"), buildPdf([null, { raw: "q 1 0 0 1 0 0 cm Q" }]));
    expect(await inspectPdf({ path: "blank.pdf" }, root)).toMatchObject({ verdict: "blank", blankPages: [1, 2] });
    await writeFile(join(root, "vector.pdf"), buildPdf([{ raw: "72 72 100 100 re f" }]));
    expect(await inspectPdf({ path: "vector.pdf" }, root)).toMatchObject({ verdict: "ok", blankPages: [],
      pages: [{ textChars: 0, blank: false, visibilityUnverified: false }] });
    await writeFile(join(root, "letter.pdf"), buildPdf(["Hello"], "[0 0 612 792]"));
    expect((await inspectPdf({ path: "letter.pdf" }, root)).pages[0]).toMatchObject({ paper: "Letter", textPreview: "Hello" });
    await writeFile(join(root, "empty.pdf"), Buffer.alloc(0));
    await expect(inspectPdf({ path: "empty.pdf" }, root)).rejects.toMatchObject({ code: "EMPTY_FILE" });
    await writeFile(join(root, "broken.pdf"), Buffer.from("not a PDF"));
    await expect(inspectPdf({ path: "broken.pdf" }, root)).rejects.toMatchObject({ code: "INSPECT_FAILED" });
    await writeFile(join(root, "large.pdf"), Buffer.alloc(0));
    await truncate(join(root, "large.pdf"), 64 * 1024 * 1024 + 1);
    await expect(inspectPdf({ path: "large.pdf" }, root)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await writeFile(join(root, "other.txt"), Buffer.from("text"));
    await expect(inspectPdf({ path: "other.txt" }, root)).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    await writeFile(join(outside, "private.pdf"), buildPdf(["Private"]));
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(inspectPdf({ path: "linked/private.pdf" }, root)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(inspectPdf({ path: "../private.pdf" }, root)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(inspectPdf({ path: "report.pdf", maxPages: 51 }, root)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const controller = new AbortController();
    controller.abort();
    await expect(inspectPdf({ path: "report.pdf" }, root, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}, 30_000);
