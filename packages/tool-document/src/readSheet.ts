import { Worker } from "node:worker_threads";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { delimiterForExtension, parseDelimitedWindow } from "./csv.js";
import { readDocumentInput } from "./input.js";

const DEFAULT_MAX_ROWS = 200;
const HARD_MAX_ROWS = 5_000;
const DEFAULT_MAX_COLUMNS = 64;
const HARD_MAX_COLUMNS = 256;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const XLSX_READ_TIMEOUT_MS = 15_000;

const ReadSheetSchema = z.strictObject({
  path: z.string().min(1).max(4_096),
  sheet: z.union([z.string().min(1).max(31), z.number().int().min(1)]).optional(),
  startRow: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - HARD_MAX_ROWS).default(1),
  maxRows: z.number().int().min(1).max(HARD_MAX_ROWS).default(DEFAULT_MAX_ROWS),
  startColumn: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - HARD_MAX_COLUMNS).default(1),
  maxColumns: z.number().int().min(1).max(HARD_MAX_COLUMNS).default(DEFAULT_MAX_COLUMNS)
});

export class SheetReadError extends Error {
  constructor(readonly code: "INVALID_ARGUMENT" | "UNSUPPORTED_FORMAT" | "UNSUPPORTED_ENCODING" | "FILE_TOO_LARGE" | "SHEET_NOT_FOUND" | "READ_TIMEOUT" | "SHEET_READ_FAILED", message: string, readonly available?: readonly string[]) {
    super(message);
    this.name = "SheetReadError";
  }
}

type SheetCell = string | number | boolean | null;
interface SheetWindow {
  readonly rows: SheetCell[][];
  readonly totalRows: number;
  readonly totalColumns: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly sheetName?: string;
  readonly sheetNames?: string[];
}

export interface ReadSheetResult extends SheetWindow {
  readonly path: string;
  readonly format: string;
  readonly sheet?: string;
  readonly startRow: number;
  readonly endRow: number;
  readonly returnedRows: number;
  readonly truncated: boolean;
  readonly nextStartRow?: number;
  readonly nextStartColumn?: number;
}

function decodeUnicodeText(bytes: Buffer): string {
  let encoding: "utf-8" | "utf-16le" | "utf-16be" = "utf-8";
  let offset = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = "utf-16le"; offset = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = "utf-16be"; offset = 2; }
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));
  } catch {
    throw new SheetReadError("UNSUPPORTED_ENCODING", "Table text must be valid UTF-8 or BOM-marked UTF-16.");
  }
}

type WorkerMessage = { readonly ok: true; readonly result: SheetWindow }
  | { readonly ok: false; readonly code: string; readonly available?: readonly string[] };

async function readXlsxInWorker(bytes: Buffer, input: z.output<typeof ReadSheetSchema>, signal: AbortSignal | undefined): Promise<SheetWindow> {
  signal?.throwIfAborted();
  const ownFile = fileURLToPath(import.meta.url);
  const sourceMode = ownFile.endsWith(".ts");
  const workerFile = fileURLToPath(new URL(sourceMode ? "./readSheet-worker.ts" : "./readSheet-worker.js", import.meta.url));
  const execArgv = sourceMode ? ["--import", import.meta.resolve("tsx")] : [];
  const archive = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return await new Promise<SheetWindow>((resolveResult, reject) => {
    const worker = new Worker(workerFile, {
      workerData: { archive, sheetSelector: input.sheet, startRow: input.startRow, maxRows: input.maxRows,
        startColumn: input.startColumn, maxColumns: input.maxColumns },
      transferList: [bytes.buffer as ArrayBuffer],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
      execArgv
    });
    let settled = false;
    const finish = (result?: SheetWindow, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate();
      if (error) reject(error);
      else resolveResult(result!);
    };
    const abort = (): void => finish(undefined, new SheetReadError("SHEET_READ_FAILED", "Table read was cancelled."));
    const timer = setTimeout(() => finish(undefined, new SheetReadError("READ_TIMEOUT", "Table read timed out.")), XLSX_READ_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    worker.once("message", (message: WorkerMessage) => {
      if (message?.ok === true) finish(message.result);
      else if (message?.ok === false && message.code === "FILE_TOO_LARGE") finish(undefined, new SheetReadError("FILE_TOO_LARGE", "Workbook archive exceeds the safe parse budget."));
      else if (message?.ok === false && message.code === "SHEET_NOT_FOUND") finish(undefined, new SheetReadError("SHEET_NOT_FOUND", "Worksheet was not found.", message.available));
      else finish(undefined, new SheetReadError("SHEET_READ_FAILED", "Workbook could not be read."));
    });
    worker.once("error", () => finish(undefined, new SheetReadError("SHEET_READ_FAILED", "Workbook parser failed.")));
    worker.once("exit", () => finish(undefined, new SheetReadError("SHEET_READ_FAILED", "Workbook parser exited without a result.")));
  });
}

export async function readSheet(input: unknown, root: string, signal?: AbortSignal): Promise<ReadSheetResult> {
  const validated = ReadSheetSchema.safeParse(input);
  if (!validated.success) throw new SheetReadError("INVALID_ARGUMENT", "Table read arguments are invalid.");
  const request = validated.data;
  const bytes = await readDocumentInput({ root, inPath: request.path, maxBytes: MAX_INPUT_BYTES, ...(signal ? { signal } : {}) });
  signal?.throwIfAborted();
  const extension = extname(request.path).toLowerCase();
  const workbook = extension === ".xlsx" || extension === ".xlsm";
  const text = extension === ".csv" || extension === ".tsv" || extension === ".tab" || extension === ".txt";
  if (!workbook && !text) throw new SheetReadError("UNSUPPORTED_FORMAT", "Table format is unsupported; use XLSX, XLSM, CSV or TSV.");
  if (text && request.sheet !== undefined) throw new SheetReadError("INVALID_ARGUMENT", "sheet is only valid for workbooks.");
  let window: SheetWindow;
  if (workbook) {
    window = await readXlsxInWorker(bytes, request, signal);
  } else {
    const parsed = parseDelimitedWindow(decodeUnicodeText(bytes), {
      delimiter: delimiterForExtension(extension), startRow: request.startRow, maxRows: request.maxRows,
      includeTotalColumns: true
    });
    const totalColumns = parsed.totalColumns ?? 0;
    const endColumn = Math.min(totalColumns, request.startColumn + request.maxColumns - 1);
    window = { rows: parsed.rows.map(row => row.slice(request.startColumn - 1, endColumn)),
      totalRows: parsed.totalRows, totalColumns, startColumn: request.startColumn,
      endColumn: Math.max(request.startColumn - 1, endColumn) };
  }
  signal?.throwIfAborted();
  const endRow = window.rows.length > 0 ? request.startRow + window.rows.length - 1 : request.startRow - 1;
  const truncated = endRow < window.totalRows;
  return {
    path: resolve(root, request.path), format: extension.slice(1),
    ...window,
    ...(window.sheetName === undefined ? {} : { sheet: window.sheetName }),
    startRow: request.startRow, endRow, returnedRows: window.rows.length, truncated,
    ...(truncated ? { nextStartRow: endRow + 1 } : {}),
    ...(window.endColumn < window.totalColumns ? { nextStartColumn: window.endColumn + 1 } : {})
  };
}
