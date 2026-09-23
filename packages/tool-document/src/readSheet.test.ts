import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { createXlsxBuffer, readSheet } from "./index.js";

it("reads bounded workbook and delimited windows with explicit row and column continuation", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-read-sheet-"));
  const outside = await mkdtemp(join(tmpdir(), "joko-read-sheet-outside-"));
  try {
    const generated = await createXlsxBuffer({ sheets: [
      { name: "Metrics", header: ["Name", "Rate", "Total"], rows: [
        ["East", 0.1, 100], ["West", 0.2, 200], ["Overall", { formula: "SUM(B2:B3)", result: 0.3 }, 300]
      ] },
      { name: "Notes", rows: [["Ready", true]] }
    ] });
    await writeFile(join(root, "metrics.xlsx"), generated.buffer);
    const first = await readSheet({ path: "metrics.xlsx", sheet: "Metrics", startRow: 2, maxRows: 1, startColumn: 1, maxColumns: 2 }, root);
    expect(first).toMatchObject({ format: "xlsx", sheet: "Metrics", sheetNames: ["Metrics", "Notes"],
      rows: [["East", 0.1]], totalRows: 4, totalColumns: 3, startRow: 2, endRow: 2,
      startColumn: 1, endColumn: 2, truncated: true, nextStartRow: 3, nextStartColumn: 3 });
    expect((await readSheet({ path: "metrics.xlsx", sheet: 1, startRow: 4, startColumn: 2, maxColumns: 1 }, root)).rows)
      .toEqual([[0.3]]);
    expect((await readSheet({ path: "metrics.xlsx", sheet: 2 }, root)).rows).toEqual([["Ready", true]]);
    await expect(readSheet({ path: "metrics.xlsx", sheet: "Missing" }, root))
      .rejects.toMatchObject({ code: "SHEET_NOT_FOUND", available: ["Metrics", "Notes"] });

    await writeFile(join(root, "data.csv"), Buffer.from("\ufeffname,note,value\r\nEast,\"line one\nline two\",1\r\nWest,\"a,b\",2\r\n"));
    expect(await readSheet({ path: "data.csv", startRow: 2, maxRows: 1, startColumn: 2, maxColumns: 1 }, root))
      .toMatchObject({ rows: [["line one\nline two"]], totalRows: 3, totalColumns: 3,
        truncated: true, nextStartRow: 3, nextStartColumn: 3 });
    const utf16 = Buffer.from("A\tB\r\n1\t2", "utf16le");
    await writeFile(join(root, "data.tsv"), Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]));
    expect((await readSheet({ path: "data.tsv" }, root)).rows).toEqual([["A", "B"], ["1", "2"]]);
    await writeFile(join(root, "broken.csv"), Buffer.from([0xff, 0xfe, 0x00]));
    await expect(readSheet({ path: "broken.csv" }, root)).rejects.toMatchObject({ code: "UNSUPPORTED_ENCODING" });
    await writeFile(join(root, "broken.xlsx"), Buffer.from("not a zip"));
    await expect(readSheet({ path: "broken.xlsx" }, root)).rejects.toMatchObject({ code: "SHEET_READ_FAILED" });
    await writeFile(join(root, "legacy.xls"), Buffer.from("old format"));
    await expect(readSheet({ path: "legacy.xls" }, root)).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    await expect(readSheet({ path: "data.csv", sheet: "Metrics" }, root)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const compressed = await new JSZip().file("xl/worksheets/sheet1.xml", "x".repeat(1024 * 1024))
      .generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await writeFile(join(root, "compressed.xlsx"), compressed);
    await expect(readSheet({ path: "compressed.xlsx" }, root)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await writeFile(join(outside, "private.csv"), "outside");
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(readSheet({ path: "linked/private.csv" }, root)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(readSheet({ path: "../private.csv" }, root)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(readSheet({ path: "../private.xls" }, root)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(readSheet({ path: "data.csv", maxRows: 5_001 }, root)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(readSheet({ path: "metrics.xlsx" }, root, cancelled.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect((await readFile(join(root, "metrics.xlsx"))).subarray(0, 2).toString("ascii")).toBe("PK");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
