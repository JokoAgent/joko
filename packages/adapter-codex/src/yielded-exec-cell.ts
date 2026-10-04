/**
 * Adapter-local detection for a foreground `functions.exec` cell that remains
 * alive after the native Codex turn reaches its boundary.
 *
 * The app-server does not expose cell state or a wait RPC. The executor status
 * header is therefore only a bounded detection hint used to continue the same
 * product turn; it never proves that the product request is complete.
 */

export interface YieldedExecCell {
  readonly cellId: string;
  readonly command?: string;
}

/** Owner-private native client identity for bounded wait-only turns. */
export const YIELD_CONTINUATION_CLIENT_ID_PREFIX = "joko-internal-yield:v1:";

export function isYieldContinuationClientId(value: unknown): value is string {
  return typeof value === "string"
    && /^joko-internal-yield:v1:[0-9a-f]{64}:[12]$/.test(value);
}

/**
 * Locked to the executor status-header shape. The marker must start a physical
 * line and be followed by the Wall time frame, excluding quoted source and
 * search output. A numeric command exit code remains stronger evidence that
 * the process has already finished.
 */
export const YIELDED_EXEC_CELL_RE =
  /(?:^|\r?\n)Script running with cell ID[ \t]+(\d+)(?:[ \t]+|\r?\n)Wall time[ \t]/gi;

const MAX_SCAN_CHARS = 16_384;
const WAIT_SETTLED_RE = /Script (?:completed|terminated)/i;

export function extractYieldedExecCellIds(text: string | null | undefined): string[] {
  if (!text) return [];
  const sample = textForScan(text);
  const ids: string[] = [];
  const seen = new Set<string>();
  YIELDED_EXEC_CELL_RE.lastIndex = 0;
  for (const match of sample.matchAll(YIELDED_EXEC_CELL_RE)) {
    const cellId = match[1];
    if (cellId === undefined || seen.has(cellId)) continue;
    seen.add(cellId);
    ids.push(cellId);
  }
  return ids;
}

export function extractYieldedExecCellsFromCodexItem(item: unknown): YieldedExecCell[] {
  const record = asRecord(item);
  if (record === null || !isApprovedYieldItem(record)) return [];
  if (record["type"] === "commandExecution" && typeof record["exitCode"] === "number") return [];
  const command = commandFromCodexItem(record);
  return extractYieldedExecCellIds(collectItemText(record)).map((cellId) => (
    command === undefined ? { cellId } : { cellId, command }
  ));
}

/** A completed wait is the only positive evidence that a remembered cell settled. */
export function extractSettledYieldCellIdsFromCodexItem(item: unknown): string[] {
  const record = asRecord(item);
  if (record === null || !isWaitItem(record)) return [];
  const args = parseJsonObject(record["arguments"]) ?? asRecord(record["input"]);
  const cellId = firstString(args, ["cell_id", "cellId"]);
  if (cellId === undefined) return [];
  const output = collectItemText(record);
  if (!WAIT_SETTLED_RE.test(output)) return [];
  if (extractYieldedExecCellIds(output).includes(cellId)) return [];
  return [cellId];
}

/** A wait that repeats the marker proves the claimed cell is still alive. */
export function extractAliveYieldCellsFromCodexItem(item: unknown): YieldedExecCell[] {
  const record = asRecord(item);
  if (record === null || !isWaitItem(record)) return [];
  const args = parseJsonObject(record["arguments"]) ?? asRecord(record["input"]);
  const cellId = firstString(args, ["cell_id", "cellId"]);
  if (cellId === undefined) return [];
  return extractYieldedExecCellIds(collectItemText(record)).includes(cellId) ? [{ cellId }] : [];
}

export function formatYieldContinuationPrompt(cells: readonly YieldedExecCell[]): string {
  const unique = dedupeYieldedExecCells(cells);
  const cellList = unique.map((cell) => {
    const command = cell.command?.trim();
    return command === undefined || command.length === 0
      ? `- cell ID ${cell.cellId}`
      : `- cell ID ${cell.cellId} (\`${truncateCommand(command)}\`)`;
  }).join("\n");
  return [
    "A foreground exec cell was reported running; its completion has not been confirmed.",
    "Wait for every listed cell and finish the original user request. Do not start a new task.",
    "If waiting fails, report the actual error without assuming the command was lost. Do not rerun the command.",
    unique.length === 1 ? `Wait for cell ID ${unique[0]!.cellId}.` : "Wait for:",
    ...(unique.length > 1 ? [cellList] : [])
  ].join("\n");
}

export function dedupeYieldedExecCells(cells: readonly YieldedExecCell[]): YieldedExecCell[] {
  const seen = new Set<string>();
  const result: YieldedExecCell[] = [];
  for (const cell of cells) {
    if (seen.has(cell.cellId)) continue;
    seen.add(cell.cellId);
    result.push(cell);
  }
  return result;
}

function isApprovedYieldItem(record: Record<string, unknown>): boolean {
  return record["type"] === "commandExecution"
    || (record["type"] === "function_call" && record["name"] === "exec_command");
}

function isWaitItem(record: Record<string, unknown>): boolean {
  return record["type"] === "function_call" && record["name"] === "wait";
}

function textForScan(text: string): string {
  if (text.length <= MAX_SCAN_CHARS) return text;
  return `${text.slice(0, MAX_SCAN_CHARS)}\n${text.slice(-MAX_SCAN_CHARS)}`;
}

function truncateCommand(command: string): string {
  const compact = command.replace(/\s+/g, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function commandFromCodexItem(record: Record<string, unknown>): string | undefined {
  if (typeof record["command"] === "string" && record["command"].trim().length > 0) {
    return record["command"];
  }
  if (record["type"] === "function_call" && record["name"] === "exec_command") {
    const command = firstString(parseJsonObject(record["arguments"]), ["cmd", "command"]);
    if (command !== undefined) return command;
  }
  return firstString(asRecord(record["arguments"]) ?? asRecord(record["input"]), ["cmd", "command"]);
}

function collectItemText(record: Record<string, unknown>): string {
  const parts: string[] = [];
  pushText(parts, record["aggregatedOutput"]);
  pushText(parts, record["output"]);
  pushText(parts, record["result"]);
  pushText(parts, record["text"]);
  const content = record["content"];
  if (Array.isArray(content)) {
    for (const entry of content) {
      if (typeof entry === "string") pushText(parts, entry);
      const nested = asRecord(entry);
      if (nested === null) continue;
      pushText(parts, nested["text"]);
      pushText(parts, nested["output"]);
    }
  } else {
    pushText(parts, content);
  }
  const contentItems = record["contentItems"];
  if (Array.isArray(contentItems)) {
    for (const entry of contentItems) {
      const nested = asRecord(entry);
      if (nested !== null) pushText(parts, nested["text"]);
    }
  }
  return parts.join("\n");
}

function pushText(parts: string[], value: unknown): void {
  if (typeof value === "string" && value.length > 0) parts.push(value);
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function firstString(
  record: Record<string, unknown> | null,
  keys: readonly string[]
): string | undefined {
  if (record === null) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}
