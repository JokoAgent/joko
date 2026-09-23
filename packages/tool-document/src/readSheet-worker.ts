import { parentPort, workerData } from "node:worker_threads";
import ExcelJS from "exceljs";
import JSZip from "jszip";

const MAX_XLSX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_XLSX_COMPRESSION_RATIO = 100;
const MAX_XLSX_ZIP_ENTRIES = 4_096;

interface ReadRequest {
  readonly archive: Uint8Array;
  readonly sheetSelector?: string | number;
  readonly startRow: number;
  readonly maxRows: number;
  readonly startColumn: number;
  readonly maxColumns: number;
}

class WorkerReadError extends Error {
  constructor(readonly code: "FILE_TOO_LARGE" | "SHEET_NOT_FOUND", readonly available?: readonly string[]) {
    super(code);
  }
}

function findSignature(bytes: Uint8Array, signature: number, start: number, end: number): number {
  for (let i = end - 4; i >= start; i -= 1) {
    if (bytes[i] === (signature & 0xff) && bytes[i + 1] === ((signature >>> 8) & 0xff)
      && bytes[i + 2] === ((signature >>> 16) & 0xff) && bytes[i + 3] === ((signature >>> 24) & 0xff)) return i;
  }
  return -1;
}

function centralDirectoryEntryCount(archive: Uint8Array): number | null {
  const bytes = new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findSignature(bytes, 0x06054b50, Math.max(0, bytes.length - 0xffff - 22), bytes.length);
  if (eocd < 0 || eocd + 22 > bytes.length) return null;
  const declared = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (declared === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) return MAX_XLSX_ZIP_ENTRIES + 1;
  if (declared > MAX_XLSX_ZIP_ENTRIES) return declared;
  const end = directoryOffset + directorySize;
  if (!Number.isSafeInteger(end) || end > bytes.length) return null;
  let offset = directoryOffset;
  let count = 0;
  while (offset < end) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) return null;
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    count += 1;
    if (count > MAX_XLSX_ZIP_ENTRIES) return count;
  }
  return offset === end ? count : null;
}

async function assertSafeArchive(archive: Uint8Array): Promise<void> {
  const entryCount = centralDirectoryEntryCount(archive);
  if (entryCount !== null && entryCount > MAX_XLSX_ZIP_ENTRIES) throw new WorkerReadError("FILE_TOO_LARGE");
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(archive, { createFolders: false });
  } catch {
    return;
  }
  const entries = Object.values(zip.files);
  if (entries.length > MAX_XLSX_ZIP_ENTRIES) throw new WorkerReadError("FILE_TOO_LARGE");
  let compressed = 0;
  let uncompressed = 0;
  for (const entry of entries) {
    const data = (entry as unknown as { _data?: { compressedSize?: number; uncompressedSize?: number } })._data;
    if (!data) continue;
    compressed += data.compressedSize ?? 0;
    uncompressed += data.uncompressedSize ?? 0;
    if (uncompressed > MAX_XLSX_UNCOMPRESSED_BYTES) throw new WorkerReadError("FILE_TOO_LARGE");
  }
  if (uncompressed > 0 && (compressed === 0 || uncompressed / compressed > MAX_XLSX_COMPRESSION_RATIO)) throw new WorkerReadError("FILE_TOO_LARGE");
}

type SheetCell = string | number | boolean | null;

function normalizeCell(value: unknown): SheetCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const cell = value as Record<string, unknown>;
    if ("result" in cell) return normalizeCell(cell["result"]);
    if ("formula" in cell) return `=${String(cell["formula"])}`;
    if (typeof cell["text"] === "string") return cell["text"];
    if (typeof cell["hyperlink"] === "string") return cell["hyperlink"];
    if (Array.isArray(cell["richText"])) return cell["richText"].map(part => String((part as { text?: unknown }).text ?? "")).join("");
    if ("error" in cell) return String(cell["error"]);
  }
  return String(value);
}

async function read(request: ReadRequest): Promise<Readonly<Record<string, unknown>>> {
  await assertSafeArchive(request.archive);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(request.archive) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheetNames = workbook.worksheets.map(sheet => sheet.name);
  if (sheetNames.length === 0) return { rows: [], totalRows: 0, totalColumns: 0, startColumn: request.startColumn, endColumn: request.startColumn - 1, sheetNames };
  const worksheet = request.sheetSelector === undefined ? workbook.worksheets[0]
    : typeof request.sheetSelector === "number" ? workbook.worksheets[request.sheetSelector - 1]
      : workbook.worksheets.find(sheet => sheet.name === request.sheetSelector);
  if (!worksheet) throw new WorkerReadError("SHEET_NOT_FOUND", sheetNames);
  const totalRows = Math.max(worksheet.rowCount || 0, worksheet.actualRowCount || 0);
  const totalColumns = Math.max(worksheet.columnCount || 0, worksheet.actualColumnCount || 0);
  const endRow = Math.min(totalRows, request.startRow + request.maxRows - 1);
  const endColumn = Math.min(totalColumns, request.startColumn + request.maxColumns - 1);
  const rows: SheetCell[][] = [];
  for (let row = request.startRow; row <= endRow; row += 1) {
    const cells: SheetCell[] = [];
    for (let column = request.startColumn; column <= endColumn; column += 1) cells.push(normalizeCell(worksheet.getRow(row).getCell(column).value));
    rows.push(cells);
  }
  return { rows, totalRows, totalColumns, startColumn: request.startColumn,
    endColumn: Math.max(request.startColumn - 1, endColumn), sheetName: worksheet.name, sheetNames };
}

void read(workerData as ReadRequest).then(
  result => parentPort?.postMessage({ ok: true, result }),
  error => {
    const expected = error instanceof WorkerReadError ? error : undefined;
    parentPort?.postMessage({ ok: false, code: expected?.code ?? "SHEET_READ_FAILED", ...(expected?.available ? { available: expected.available } : {}) });
  }
);
