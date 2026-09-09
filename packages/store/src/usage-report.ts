import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { RevisionConflictError, StoreError } from "./errors.js";
import type { UsageTokenTotals } from "./types.js";

export type UsageReportGroup = "task" | "model" | "provider" | "backend";
export interface UsageReportQuery {
  readonly ownerId: string;
  readonly fromDay?: string;
  readonly throughDay?: string;
  readonly backendId?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly sessionId?: string;
  readonly group: UsageReportGroup;
  readonly pageSize: number;
  readonly pageToken?: string;
}
export interface UsageReportTotal extends UsageTokenTotals {
  readonly currencyCode: string;
  readonly costMicros: number;
  readonly costComplete: boolean;
  readonly estimated: boolean;
  readonly firstMeasuredAt: number;
  readonly lastMeasuredAt: number;
}
export interface UsageReportEntry {
  readonly key: string;
  readonly sessionId: string;
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly title: string;
  readonly referenceAvailable: boolean;
  readonly totals: readonly UsageReportTotal[];
}
export interface UsageReportPage {
  readonly entries: readonly UsageReportEntry[];
  readonly totals: readonly UsageReportTotal[];
  readonly totalGroups: number;
  readonly nextPageToken: string;
}

export class UsageReportQueryError extends StoreError {}
export class UsageReportCapacityError extends StoreError {}

const maximumCurrencies = 256;
// Positive integer sums remain exact while they fit the public safe-integer
// range. TOTAL lets us reject larger sums ourselves, before SQLite overflows.
const sums = `TOTAL(input_tokens) AS input_tokens, TOTAL(output_tokens) AS output_tokens,
  TOTAL(cache_read_tokens) AS cache_read_tokens, TOTAL(cache_write_tokens) AS cache_write_tokens,
  TOTAL(total_tokens) AS total_tokens, TOTAL(cost_micros) AS cost_micros,
  MIN(cost_complete) AS cost_complete, MAX(estimated) AS estimated,
  MIN(first_measured_at) AS first_measured_at, MAX(last_measured_at) AS last_measured_at`;

// Called synchronously by the Store's single writer; every page and its total
// share the same database revision. SQL aggregation keeps ledger rows off the wire.
export function readUsageReport(database: DatabaseSync, revision: bigint, query: UsageReportQuery): UsageReportPage {
  const dimensions = {
    task: ["session_id"], model: ["backend_id", "provider_id", "model_id"],
    provider: ["backend_id", "provider_id"], backend: ["backend_id"]
  } as const;
  if (!Object.hasOwn(dimensions, query.group)) throw new UsageReportQueryError("Invalid usage report group.");
  if (!Number.isInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > 100) throw new UsageReportQueryError("Usage report page size must be between 1 and 100.");
  const conditions: string[] = [];
  const parameters: SQLInputValue[] = [];
  for (const [field, column, max, required] of [
    ["ownerId", "owner_id", 256, true], ["backendId", "backend_id", 256, false],
    ["providerId", "provider_id", 512, false], ["modelId", "model_id", 512, false],
    ["sessionId", "session_id", 256, false]
  ] as const) {
    const value = query[field];
    if (value === undefined && !required) continue;
    if (typeof value !== "string" || value.length > max || /[\u0000\r\n]/u.test(value) || (required && value.trim() === "")) throw new UsageReportQueryError("Invalid usage report identity.");
    conditions.push(`${column} = ?`);
    parameters.push(value);
  }
  for (const [value, operator] of [[query.fromDay, ">="], [query.throughDay, "<="]] as const) {
    if (value === undefined) continue;
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new UsageReportQueryError("Invalid UTC usage report date.");
    conditions.push(`day ${operator} ?`);
    parameters.push(value);
  }
  if (query.fromDay !== undefined && query.throughDay !== undefined && query.fromDay > query.throughDay) throw new UsageReportQueryError("Usage report start date follows its end date.");
  const columns: readonly string[] = dimensions[query.group];
  const filtered = `WITH filtered AS (SELECT *, json_array(${columns.join(",")}) AS group_key FROM usage_daily_ledger WHERE ${conditions.join(" AND ")})`;
  const ledgerState = database.prepare(`${filtered} SELECT COUNT(*) AS count, COALESCE(MAX(revision), 0) AS revision FROM filtered`).get(...parameters)!;
  const references = query.group === "task"
    ? database.prepare(`${filtered} SELECT COUNT(*) AS count, COALESCE(MAX(revision), 0) AS revision
      FROM product_sessions WHERE id IN (SELECT session_id FROM filtered)`).get(...parameters)!
    : undefined;
  // Authentication touches and unrelated settings advance the Store revision.
  // Fence only the selected ledger and, for task rows, their current references.
  const dataRevision = createHash("sha256").update(JSON.stringify([
    ledgerState.count, ledgerState.revision, references?.count ?? 0, references?.revision ?? 0
  ])).digest("hex");
  const scope = createHash("sha256").update(JSON.stringify([conditions, parameters, query.group, query.pageSize])).digest("hex");
  let offset = 0;
  if (query.pageToken !== undefined && query.pageToken !== "") {
    if (query.pageToken.length > 1024) throw new UsageReportQueryError("Invalid usage report cursor.");
    let cursor: unknown;
    try { cursor = JSON.parse(Buffer.from(query.pageToken, "base64url").toString("utf8")); } catch { throw new UsageReportQueryError("Invalid usage report cursor."); }
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) throw new UsageReportQueryError("Invalid usage report cursor.");
    const value = cursor as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "dataRevision,offset,revision,scope,version" || value.version !== 1 || value.scope !== scope
      || typeof value.dataRevision !== "string" || !/^[a-f0-9]{64}$/u.test(value.dataRevision)
      || typeof value.revision !== "string" || !/^\d{1,20}$/u.test(value.revision)
      || typeof value.offset !== "number" || !Number.isSafeInteger(value.offset) || value.offset < 1) throw new UsageReportQueryError("Invalid usage report cursor.");
    if (value.dataRevision !== dataRevision) throw new RevisionConflictError("Usage report", "page", BigInt(value.revision), revision);
    offset = value.offset;
  }
  const totalGroups = number(database.prepare(`${filtered} SELECT COUNT(DISTINCT group_key) AS count FROM filtered`).get(...parameters)!.count);
  const totalRows = database.prepare(`${filtered} SELECT currency_code, ${sums} FROM filtered GROUP BY currency_code ORDER BY currency_code LIMIT ?`).all(...parameters, maximumCurrencies + 1);
  if (totalRows.length > maximumCurrencies) throw new UsageReportCapacityError("Usage report contains too many currencies; narrow the report filters.");
  const totals = totalRows.map(total);
  for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const) {
    number(totals.reduce((sum, value) => sum + value[field], 0));
  }
  const identities = ["session_id", "backend_id", "provider_id", "model_id"].map((column) => columns.includes(column) ? column : `'' AS ${column}`).join(",");
  const rows = database.prepare(`${filtered}, ranked AS (
    SELECT group_key, TOTAL(total_tokens) AS tokens FROM filtered GROUP BY group_key
    ORDER BY tokens DESC, group_key LIMIT ? OFFSET ?
  ) SELECT f.group_key, ${identities}, currency_code, ${sums}
    FROM filtered f WHERE group_key IN (SELECT group_key FROM ranked)
    GROUP BY group_key, currency_code
    ORDER BY (SELECT tokens FROM ranked WHERE ranked.group_key = f.group_key) DESC, group_key, currency_code`).iterate(...parameters, query.pageSize, offset);
  const entries = new Map<string, UsageReportEntry>();
  for (const row of rows) {
    const key = String(row.group_key);
    const existing = entries.get(key);
    if (existing !== undefined) { entries.set(key, { ...existing, totals: [...existing.totals, total(row)] }); continue; }
    const sessionId = String(row.session_id);
    const session = sessionId === "" ? undefined : database.prepare("SELECT title, deleted_at FROM product_sessions WHERE id = ?").get(sessionId);
    const referenceAvailable = session !== undefined && session.deleted_at === null;
    entries.set(key, { key, sessionId, backendId: String(row.backend_id), providerId: String(row.provider_id), modelId: String(row.model_id),
      title: referenceAvailable ? String(session.title) : "", referenceAvailable, totals: [total(row)] });
  }
  const nextOffset = offset + entries.size;
  return { entries: [...entries.values()], totals, totalGroups,
    nextPageToken: nextOffset < totalGroups ? Buffer.from(JSON.stringify({ version: 1, scope, revision: revision.toString(), dataRevision, offset: nextOffset })).toString("base64url") : "" };
}

function number(value: unknown): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new UsageReportCapacityError("Usage report exceeds the safe integer range; narrow the report filters.");
  return result;
}
function total(row: Record<string, unknown>): UsageReportTotal {
  return { inputTokens: number(row.input_tokens), outputTokens: number(row.output_tokens), cacheReadTokens: number(row.cache_read_tokens),
    cacheWriteTokens: number(row.cache_write_tokens), totalTokens: number(row.total_tokens), costMicros: number(row.cost_micros),
    currencyCode: String(row.currency_code), costComplete: row.cost_complete === 1, estimated: row.estimated === 1,
    firstMeasuredAt: number(row.first_measured_at), lastMeasuredAt: number(row.last_measured_at) };
}
