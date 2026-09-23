import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { createXlsxBuffer, publishDocumentOutput } from "./index.js";

it("publishes a readable multi-sheet workbook with cached formulas and useful table formatting", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-workbook-"));
  try {
    const result = await createXlsxBuffer({ theme: "dark", zebra: true, sheets: [
      { name: "Sales/2026", header: ["Region", "Conversion rate", "Amount"], rows: [
        ["East", 0.037, 1200], ["West", 0.12, 2400], ["Total", { formula: "=SUM(B2:B3)", result: 0.157 }, { formula: "SUM(C2:C3)", result: 3600 }]
      ] },
      { name: "Sales/2026", header: ["Status", "Ready"], rows: [["Reviewed", true], ["Pending", null]] },
      { name: "History", rows: [] },
      { name: "'Quoted'", rows: [] }
    ] });
    expect(result).toMatchObject({ theme: "dark", zebra: true, sheets: [
      { name: "Sales_2026", rows: 3 }, { name: "Sales_2026_2", rows: 2 },
      { name: "History_", rows: 0 }, { name: "_Quoted_", rows: 0 }
    ] });
    const output = await publishDocumentOutput({ root, outPath: "reports/sales.xlsx", bytes: result.buffer, overwrite: false });
    const readback = await readFile(output.path);
    expect(readback).toEqual(result.buffer);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(readback as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.getWorksheet("Sales_2026")!;
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet.autoFilter).toBe("A1:C4");
    expect(sheet.getCell("B2").value).toBe(0.037);
    expect(sheet.getColumn(2).numFmt).toBe("0.0%");
    expect(sheet.getColumn(3).numFmt).toBe("#,##0");
    expect(sheet.getColumn(2).width).toBeGreaterThan(8);
    expect(sheet.getCell("C4").value).toMatchObject({ formula: "SUM(C2:C3)", result: 3600 });
    expect(sheet.getCell("C4").font.bold).toBe(true);
    expect(sheet.getCell("C4").border.top?.color?.argb).toBe("FF6AA6FF");
    expect(sheet.getCell("A1").font.bold).toBe(true);
    expect(workbook.getWorksheet("Sales_2026_2")!.getCell("B2").value).toBe(true);
    const zip = await JSZip.loadAsync(readback);
    const sheetXml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheetXml).toContain("<f>SUM(C2:C3)</f>");
    expect(sheetXml).toContain("<v>3600</v>");
    await expect(publishDocumentOutput({ root, outPath: "reports/sales.xlsx", bytes: result.buffer, overwrite: false }))
      .rejects.toMatchObject({ code: "FILE_EXISTS" });
    await expect(createXlsxBuffer({ sheets: [{ name: "Invalid", rows: [[{ formula: "SUM(A1:A2)" }]] }] }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(createXlsxBuffer({ sheets: [{ name: "Invalid", rows: [], extra: true }] }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(createXlsxBuffer({ sheets: [{ name: "Too many cells", rows: Array.from({ length: 5_000 }, () => Array(21).fill(null)) }] }))
      .rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    const longCell = "x".repeat(32_767);
    await expect(createXlsxBuffer({ sheets: [{ name: "Too much text", rows: [Array(256).fill(longCell), [longCell]] }] }))
      .rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(createXlsxBuffer({ sheets: [{ name: "Invalid formula", rows: [[{ formula: "=", result: 0 }]] }] }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(createXlsxBuffer({ sheets: [{ name: "Valid", rows: [] }] }, cancelled.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
