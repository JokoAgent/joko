import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  ResourceUsageAction,
  ResourceUsageActivity,
  ResourceUsageEventPayload,
  ResourceUsageMarketProvenance,
  ResourceUsageSource
} from "@joko/core";

import { StoreError } from "./errors.js";
import { parseJson } from "./serialization.js";
import { parseCurrentResourceUsageEventPayload } from "./resource-usage-shape.js";

export interface ResourceUsageReportQuery {
  readonly resourceId: string;
  readonly timeZone: string;
  readonly throughDay?: string;
  readonly current?: {
    readonly entityRevision: string;
    readonly contentRevision: string;
    readonly version?: string;
  };
}

export interface ResourceUsageMetrics {
  readonly samples: number;
  readonly strongActive: number;
  readonly semiActive: number;
  readonly passiveExposures: number;
  readonly reads: number;
  readonly rereads: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly commands: number;
  readonly commandFailures: number;
  readonly latestUsedAt?: number;
}

export interface ResourceUsageSourceBreakdown {
  readonly source: ResourceUsageSource;
  readonly metrics: ResourceUsageMetrics;
}

export interface ResourceUsageAgentBreakdown {
  readonly backendId: string;
  readonly metrics: ResourceUsageMetrics;
}

export interface ResourceUsageVersionIdentity {
  readonly entityRevision: string;
  readonly contentRevision: string;
  readonly version?: string;
}

export interface ResourceUsageVersionBreakdown {
  readonly identity: ResourceUsageVersionIdentity;
  readonly metrics: ResourceUsageMetrics;
  readonly firstUsedAt?: number;
}

export interface ResourceUsageDay {
  readonly localDay: string;
  readonly metrics: ResourceUsageMetrics;
}

export interface ResourceUsageVersionComparison {
  readonly available: boolean;
  readonly minimumSamples: number;
  readonly unavailableReason?: "no_current_version" | "no_previous_version" | "current_samples" | "previous_samples";
  readonly current?: ResourceUsageVersionBreakdown;
  readonly previous?: ResourceUsageVersionBreakdown;
}

export interface ResourceUsageProjectionFailure {
  readonly sessionId: string;
  readonly source: ResourceUsageSource;
  readonly attempts: number;
  readonly retryAt: number;
  readonly errorCode: string;
}

export interface ResourceUsageProjectionStatus {
  readonly complete: boolean;
  readonly streamCount: number;
  readonly pendingStreamCount: number;
  readonly lastProjectedAt?: number;
  readonly failures: readonly ResourceUsageProjectionFailure[];
}

export interface ResourceUsageReport {
  readonly resourceId: string;
  readonly timeZone: string;
  readonly fromDay: string;
  readonly throughDay: string;
  readonly days: readonly ResourceUsageDay[];
  readonly totals: ResourceUsageMetrics;
  readonly sources: readonly ResourceUsageSourceBreakdown[];
  readonly agents: readonly ResourceUsageAgentBreakdown[];
  readonly versions: readonly ResourceUsageVersionBreakdown[];
  readonly comparison: ResourceUsageVersionComparison;
  readonly projection: ResourceUsageProjectionStatus;
}

export class ResourceUsageReportQueryError extends StoreError {}
export class ResourceUsageReportCapacityError extends StoreError {}

interface UsageRow {
  readonly eventCursor: bigint;
  readonly occurrenceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly backendId: string;
  readonly resourceId: string;
  readonly entityRevision: string;
  readonly contentRevision: string;
  readonly runtimeGeneration: number;
  readonly version?: string;
  readonly market?: ResourceUsageMarketProvenance;
  readonly source: ResourceUsageSource;
  readonly activity: ResourceUsageActivity;
  readonly action: ResourceUsageAction;
  readonly occurredAt: number;
}

interface ProjectionState {
  readonly cursor: bigint;
  readonly projectedAt?: number;
  readonly failureCount: number;
  readonly retryAfter?: number;
  readonly errorCode?: string;
}

interface MutableVersion {
  identity: ResourceUsageVersionIdentity;
  metrics: MutableMetrics;
  firstUsedAt?: number;
}

type MutableMetrics = {
  samples: number;
  strongActive: number;
  semiActive: number;
  passiveExposures: number;
  reads: number;
  rereads: number;
  toolCalls: number;
  toolErrors: number;
  commands: number;
  commandFailures: number;
  latestUsedAt?: number;
};

const SOURCES: readonly ResourceUsageSource[] = [
  "structured_resource_mention",
  "native_skill_command",
  "runtime_confirmed_resource_load",
  "exact_file_read",
  "runtime_tool_call"
];
const MINIMUM_VERSION_SAMPLES = 5;
const MAXIMUM_REPORT_ROWS = 100_000;
const PROJECTION_BATCH_SIZE = 1_000;
const PROJECTION_BATCH_LIMIT = 10;

/**
 * Advance only the exact session/source stream. A projection failure rolls
 * back this attempt's derived rows while leaving the committed Event and the
 * stream's last verified cursor intact.
 */
export function projectResourceUsageStream(
  database: DatabaseSync,
  sessionId: string,
  source: ResourceUsageSource,
  now: number,
  options: { readonly ignoreRetryAfter?: boolean } = {}
): ProjectionState {
  const prior = projectionState(database, sessionId, source);
  if (prior.retryAfter !== undefined && prior.retryAfter > now && options.ignoreRetryAfter !== true) return prior;
  let cursor = prior.cursor;
  let batches = 0;
  database.exec("SAVEPOINT joko_resource_usage_projection");
  try {
    while (batches < PROJECTION_BATCH_LIMIT) {
      const rows = database.prepare(`
        SELECT global_cursor, session_id, run_id, backend_id, generation, emitted_at, payload_json
        FROM events
        WHERE session_id = ? AND global_cursor > ?
          AND json_extract(payload_json, '$.payload.type') = 'resource_usage'
          AND json_extract(payload_json, '$.payload.source') = ?
        ORDER BY global_cursor
        LIMIT ?
      `).all(sessionId, sqlInteger(cursor), source, PROJECTION_BATCH_SIZE) as Record<string, unknown>[];
      for (const raw of rows) {
        const usage = usageEventRow(raw);
        insertProjectedEvidence(database, usage);
        cursor = usage.eventCursor;
      }
      batches += 1;
      if (rows.length < PROJECTION_BATCH_SIZE) break;
    }
    database.prepare(`
      INSERT INTO resource_usage_projection_cursors(
        session_id, source, last_event_cursor, last_projected_at,
        failure_count, retry_after, error_code
      ) VALUES (?, ?, ?, ?, 0, NULL, NULL)
      ON CONFLICT(session_id, source) DO UPDATE SET
        last_event_cursor = excluded.last_event_cursor,
        last_projected_at = excluded.last_projected_at,
        failure_count = 0,
        retry_after = NULL,
        error_code = NULL
    `).run(sessionId, source, sqlInteger(cursor), now);
    database.exec("RELEASE SAVEPOINT joko_resource_usage_projection");
    return { cursor, projectedAt: now, failureCount: 0 };
  } catch (error) {
    database.exec("ROLLBACK TO SAVEPOINT joko_resource_usage_projection");
    database.exec("RELEASE SAVEPOINT joko_resource_usage_projection");
    const failureCount = prior.failureCount + 1;
    const retryAfter = now + Math.min(60_000, 1_000 * (2 ** Math.min(failureCount - 1, 6)));
    const collisionField = error instanceof StoreError
      ? /fields: ([A-Za-z]+)/u.exec(error.message)?.[1]
      : undefined;
    const errorCode = error instanceof StoreError
      && error.message.includes("occurrence identity collided")
      ? collisionField === undefined
        ? "RESOURCE_USAGE_OCCURRENCE_COLLISION"
        : `RESOURCE_USAGE_${collisionField.replace(/([a-z])([A-Z])/gu, "$1_$2").toUpperCase()}_COLLISION`
      : "RESOURCE_USAGE_PROJECTION_FAILED";
    database.prepare(`
      INSERT INTO resource_usage_projection_cursors(
        session_id, source, last_event_cursor, last_projected_at,
        failure_count, retry_after, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, source) DO UPDATE SET
        last_event_cursor = excluded.last_event_cursor,
        last_projected_at = excluded.last_projected_at,
        failure_count = excluded.failure_count,
        retry_after = excluded.retry_after,
        error_code = excluded.error_code
    `).run(
      sessionId,
      source,
      sqlInteger(prior.cursor),
      prior.projectedAt ?? null,
      failureCount,
      retryAfter,
      errorCode
    );
    return { ...prior, failureCount, retryAfter, errorCode };
  }
}

export function readResourceUsageReport(
  database: DatabaseSync,
  now: number,
  query: ResourceUsageReportQuery
): ResourceUsageReport {
  const resourceId = identity(query.resourceId, "Resource usage Resource ID", 4_096);
  const formatter = localDayFormatter(query.timeZone);
  const timeZone = query.timeZone;
  const throughDay = query.throughDay === undefined
    ? formatLocalDay(formatter, now)
    : validDay(query.throughDay);
  const fromDay = addDays(throughDay, -29);
  if (query.current !== undefined) validateCurrentIdentity(query.current);

  const streams = resourceStreams(database, resourceId);
  for (const stream of streams) projectResourceUsageStream(database, stream.sessionId, stream.source, now);
  const projection = projectionStatus(database, streams);

  // Every IANA local day is within 24 hours of these deliberately generous
  // UTC bounds. Final inclusion still uses the requested calendar zone.
  const earliest = Date.parse(`${fromDay}T00:00:00.000Z`) - 48 * 60 * 60_000;
  const latest = Date.parse(`${addDays(throughDay, 1)}T00:00:00.000Z`) + 48 * 60 * 60_000;
  const rawRows = database.prepare(`
    SELECT * FROM resource_usage_evidence
    WHERE resource_id = ? AND occurred_at >= ? AND occurred_at < ?
    ORDER BY occurred_at, event_cursor
    LIMIT ?
  `).all(resourceId, earliest, latest, MAXIMUM_REPORT_ROWS + 1) as Record<string, unknown>[];
  if (rawRows.length > MAXIMUM_REPORT_ROWS) {
    throw new ResourceUsageReportCapacityError("Resource usage report contains too many exact evidence rows.");
  }
  const rows = rawRows.map(projectedRow).filter((row) => {
    const day = formatLocalDay(formatter, row.occurredAt);
    return day >= fromDay && day <= throughDay;
  });
  const totals = emptyMetrics();
  const days = new Map<string, MutableMetrics>();
  for (let offset = 0; offset < 30; offset += 1) days.set(addDays(fromDay, offset), emptyMetrics());
  const sources = new Map<ResourceUsageSource, MutableMetrics>();
  const agents = new Map<string, MutableMetrics>();
  const versions = new Map<string, MutableVersion>();
  for (const row of rows) {
    addEvidence(totals, row);
    addEvidence(days.get(formatLocalDay(formatter, row.occurredAt))!, row);
    const sourceMetrics = sources.get(row.source) ?? emptyMetrics();
    addEvidence(sourceMetrics, row);
    sources.set(row.source, sourceMetrics);
    const agentMetrics = agents.get(row.backendId) ?? emptyMetrics();
    addEvidence(agentMetrics, row);
    agents.set(row.backendId, agentMetrics);
    const key = versionKey(row.contentRevision, row.version);
    const version = versions.get(key) ?? {
      identity: {
        entityRevision: row.entityRevision,
        contentRevision: row.contentRevision,
        ...(row.version === undefined ? {} : { version: row.version })
      },
      metrics: emptyMetrics(),
      firstUsedAt: row.occurredAt
    };
    if ((version.metrics.latestUsedAt ?? -1) <= row.occurredAt) {
      version.identity = {
        entityRevision: row.entityRevision,
        contentRevision: row.contentRevision,
        ...(row.version === undefined ? {} : { version: row.version })
      };
    }
    version.firstUsedAt = Math.min(version.firstUsedAt ?? row.occurredAt, row.occurredAt);
    addEvidence(version.metrics, row);
    versions.set(key, version);
  }
  if (query.current !== undefined) {
    const key = versionKey(query.current.contentRevision, query.current.version);
    const existing = versions.get(key);
    if (existing === undefined) versions.set(key, { identity: { ...query.current }, metrics: emptyMetrics() });
    else existing.identity = { ...query.current };
  }
  const versionRows = [...versions.values()]
    .sort((left, right) => (right.firstUsedAt ?? now) - (left.firstUsedAt ?? now)
      || right.identity.contentRevision.localeCompare(left.identity.contentRevision))
    .map(freezeVersion);
  const currentKey = query.current === undefined
    ? versionRows.reduce<ResourceUsageVersionBreakdown | undefined>((latestVersion, value) =>
        latestVersion === undefined || (value.metrics.latestUsedAt ?? -1) > (latestVersion.metrics.latestUsedAt ?? -1)
          ? value : latestVersion, undefined)
    : versionRows.find((value) => value.identity.contentRevision === query.current!.contentRevision
        && value.identity.version === query.current!.version);
  const current = currentKey;
  const previous = current === undefined ? undefined : previousVersion(current, versionRows);
  const comparison = compareVersions(current, previous);
  const latestRow = database.prepare(`
    SELECT MAX(occurred_at) AS latest FROM resource_usage_evidence WHERE resource_id = ?
  `).get(resourceId) as Record<string, unknown> | undefined;
  const latestUsedAt = optionalNonNegativeNumber(latestRow?.["latest"]);
  return {
    resourceId,
    timeZone,
    fromDay,
    throughDay,
    days: [...days.entries()].map(([localDay, metrics]) => ({ localDay, metrics: freezeMetrics(metrics) })),
    totals: {
      ...freezeMetrics(totals),
      ...(latestUsedAt === undefined ? {} : { latestUsedAt })
    },
    sources: SOURCES.flatMap((source) => {
      const metrics = sources.get(source);
      return metrics === undefined ? [] : [{ source, metrics: freezeMetrics(metrics) }];
    }),
    agents: [...agents.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([backendId, metrics]) => ({ backendId, metrics: freezeMetrics(metrics) })),
    versions: versionRows,
    comparison,
    projection
  };
}

function resourceStreams(database: DatabaseSync, resourceId: string): Array<{
  readonly sessionId: string;
  readonly source: ResourceUsageSource;
}> {
  const rows = database.prepare(`
    SELECT DISTINCT session_id, json_extract(payload_json, '$.payload.source') AS source
    FROM events
    WHERE json_extract(payload_json, '$.payload.type') = 'resource_usage'
      AND json_extract(payload_json, '$.payload.resourceId') = ?
    ORDER BY session_id, source
  `).all(resourceId) as Record<string, unknown>[];
  return rows.map((row) => ({
    sessionId: identity(row["session_id"], "Resource usage projection Session ID", 4_096),
    source: usageSource(row["source"])
  }));
}

function projectionStatus(
  database: DatabaseSync,
  streams: readonly { readonly sessionId: string; readonly source: ResourceUsageSource }[]
): ResourceUsageProjectionStatus {
  const failures: ResourceUsageProjectionFailure[] = [];
  let pendingStreamCount = 0;
  let lastProjectedAt: number | undefined;
  for (const stream of streams) {
    const state = projectionState(database, stream.sessionId, stream.source);
    const highWater = database.prepare(`
      SELECT COALESCE(MAX(global_cursor), 0) AS cursor FROM events
      WHERE session_id = ?
        AND json_extract(payload_json, '$.payload.type') = 'resource_usage'
        AND json_extract(payload_json, '$.payload.source') = ?
    `).get(stream.sessionId, stream.source) as Record<string, unknown>;
    if (state.cursor < bigInt(highWater["cursor"])) pendingStreamCount += 1;
    if (state.projectedAt !== undefined) lastProjectedAt = Math.max(lastProjectedAt ?? 0, state.projectedAt);
    if (state.errorCode !== undefined && state.retryAfter !== undefined) failures.push({
      sessionId: stream.sessionId,
      source: stream.source,
      attempts: state.failureCount,
      retryAt: state.retryAfter,
      errorCode: state.errorCode
    });
  }
  return {
    complete: failures.length === 0 && pendingStreamCount === 0,
    streamCount: streams.length,
    pendingStreamCount,
    ...(lastProjectedAt === undefined ? {} : { lastProjectedAt }),
    failures
  };
}

function projectionState(database: DatabaseSync, sessionId: string, source: ResourceUsageSource): ProjectionState {
  const row = database.prepare(`
    SELECT last_event_cursor, last_projected_at, failure_count, retry_after, error_code
    FROM resource_usage_projection_cursors WHERE session_id = ? AND source = ?
  `).get(sessionId, source) as Record<string, unknown> | undefined;
  if (row === undefined) return { cursor: 0n, failureCount: 0 };
  return {
    cursor: bigInt(row["last_event_cursor"]),
    ...(optionalNonNegativeNumber(row["last_projected_at"]) === undefined
      ? {} : { projectedAt: optionalNonNegativeNumber(row["last_projected_at"])! }),
    failureCount: nonNegativeNumber(row["failure_count"]),
    ...(optionalNonNegativeNumber(row["retry_after"]) === undefined
      ? {} : { retryAfter: optionalNonNegativeNumber(row["retry_after"])! }),
    ...(row["error_code"] === null || row["error_code"] === undefined ? {} : { errorCode: String(row["error_code"]) })
  };
}

function usageEventRow(row: Record<string, unknown>): UsageRow {
  const stored = parseJson<{ readonly payload: unknown }>(String(row["payload_json"]));
  const payload = parseCurrentResourceUsageEventPayload(stored.payload);
  if (payload.type !== "resource_usage") throw new StoreError("Resource usage projection received a different Event type.");
  const runId = typeof row["run_id"] === "string" && row["run_id"].trim() !== "" ? row["run_id"] : undefined;
  const generation = nonNegativeNumber(row["generation"]);
  if (runId === undefined || generation !== payload.runtimeGeneration) {
    throw new StoreError("Resource usage Event envelope is incomplete or stale.");
  }
  return {
    eventCursor: bigInt(row["global_cursor"]),
    occurrenceId: payload.occurrenceId,
    sessionId: String(row["session_id"]),
    runId,
    backendId: String(row["backend_id"]),
    resourceId: payload.resourceId,
    entityRevision: payload.entityRevision,
    contentRevision: payload.contentRevision,
    runtimeGeneration: payload.runtimeGeneration,
    ...(payload.version === undefined ? {} : { version: payload.version }),
    ...(payload.market === undefined ? {} : { market: { ...payload.market } }),
    source: payload.source,
    activity: payload.activity,
    action: payload.action,
    occurredAt: nonNegativeNumber(row["emitted_at"])
  };
}

function insertProjectedEvidence(database: DatabaseSync, row: UsageRow): void {
  const result = database.prepare(`
    INSERT OR IGNORE INTO resource_usage_evidence(
      event_cursor, occurrence_id, session_id, run_id, backend_id, resource_id,
      entity_revision, content_revision, runtime_generation, version,
      market_source_id, market_source_revision, market_entry_id, market_entry_revision,
      market_entry_content_revision, installed_content_revision,
      source, activity, action, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sqlInteger(row.eventCursor), row.occurrenceId, row.sessionId, row.runId, row.backendId, row.resourceId,
    row.entityRevision, row.contentRevision, row.runtimeGeneration, row.version ?? null,
    row.market?.sourceId ?? null, row.market?.sourceRevision ?? null,
    row.market?.entryId ?? null, row.market?.entryRevision ?? null,
    row.market?.entryContentRevision ?? null, row.market?.installedContentRevision ?? null,
    row.source, row.activity, row.action, row.occurredAt
  );
  if (Number(result.changes) > 0) return;
  const existing = database.prepare(`
    SELECT * FROM resource_usage_evidence
    WHERE event_cursor = ? OR (session_id = ? AND source = ? AND occurrence_id = ?)
  `).all(sqlInteger(row.eventCursor), row.sessionId, row.source, row.occurrenceId) as Record<string, unknown>[];
  if (existing.length !== 1) {
    throw new StoreError("Resource usage occurrence identity collided with multiple exact evidence rows.");
  }
  const mismatch = evidenceMismatchFields(projectedRow(existing[0]!), row);
  if (mismatch.length > 0) {
    throw new StoreError(`Resource usage occurrence identity collided with different exact evidence fields: ${mismatch.join(", ")}.`);
  }
}

function projectedRow(row: Record<string, unknown>): UsageRow {
  const marketSourceId = nullableString(row["market_source_id"]);
  return {
    eventCursor: bigInt(row["event_cursor"]),
    occurrenceId: String(row["occurrence_id"]),
    sessionId: String(row["session_id"]),
    runId: String(row["run_id"]),
    backendId: String(row["backend_id"]),
    resourceId: String(row["resource_id"]),
    entityRevision: String(row["entity_revision"]),
    contentRevision: String(row["content_revision"]),
    runtimeGeneration: nonNegativeNumber(row["runtime_generation"]),
    ...(nullableString(row["version"]) === undefined ? {} : { version: nullableString(row["version"])! }),
    ...(marketSourceId === undefined ? {} : {
      market: {
        sourceId: marketSourceId,
        sourceRevision: String(row["market_source_revision"]),
        entryId: String(row["market_entry_id"]),
        entryRevision: String(row["market_entry_revision"]),
        entryContentRevision: String(row["market_entry_content_revision"]),
        installedContentRevision: String(row["installed_content_revision"])
      }
    }),
    source: usageSource(row["source"]),
    activity: usageActivity(row["activity"]),
    action: usageAction(row["action"]),
    occurredAt: nonNegativeNumber(row["occurred_at"])
  };
}

function evidenceMismatchFields(left: UsageRow, right: UsageRow): string[] {
  const fields: Array<readonly [string, unknown, unknown]> = [
    ["occurrenceId", left.occurrenceId, right.occurrenceId],
    ["sessionId", left.sessionId, right.sessionId],
    ["runId", left.runId, right.runId],
    ["backendId", left.backendId, right.backendId],
    ["resourceId", left.resourceId, right.resourceId],
    ["entityRevision", left.entityRevision, right.entityRevision],
    ["contentRevision", left.contentRevision, right.contentRevision],
    ["runtimeGeneration", left.runtimeGeneration, right.runtimeGeneration],
    ["version", left.version, right.version],
    ["market", marketIdentity(left.market), marketIdentity(right.market)],
    ["source", left.source, right.source],
    ["activity", left.activity, right.activity],
    ["action", left.action, right.action]
  ];
  return fields.filter(([, leftValue, rightValue]) => leftValue !== rightValue).map(([field]) => field);
}

function marketIdentity(value: ResourceUsageMarketProvenance | undefined): string {
  return value === undefined ? "" : JSON.stringify([
    value.sourceId,
    value.sourceRevision,
    value.entryId,
    value.entryRevision,
    value.entryContentRevision,
    value.installedContentRevision
  ]);
}

function addEvidence(metrics: MutableMetrics, row: UsageRow): void {
  metrics.samples += 1;
  if (row.activity === "strong_active") metrics.strongActive += 1;
  else if (row.activity === "semi_active") metrics.semiActive += 1;
  else metrics.passiveExposures += 1;
  if (row.action === "read" || row.action === "reread") metrics.reads += 1;
  if (row.action === "reread") metrics.rereads += 1;
  if (row.action === "tool_succeeded" || row.action === "tool_failed") metrics.toolCalls += 1;
  if (row.action === "tool_failed") metrics.toolErrors += 1;
  if (row.action === "command_succeeded" || row.action === "command_failed") metrics.commands += 1;
  if (row.action === "command_failed") metrics.commandFailures += 1;
  metrics.latestUsedAt = Math.max(metrics.latestUsedAt ?? 0, row.occurredAt);
}

function emptyMetrics(): MutableMetrics {
  return {
    samples: 0,
    strongActive: 0,
    semiActive: 0,
    passiveExposures: 0,
    reads: 0,
    rereads: 0,
    toolCalls: 0,
    toolErrors: 0,
    commands: 0,
    commandFailures: 0
  };
}

function freezeMetrics(metrics: MutableMetrics): ResourceUsageMetrics {
  return { ...metrics };
}

function freezeVersion(value: MutableVersion): ResourceUsageVersionBreakdown {
  return {
    identity: { ...value.identity },
    metrics: freezeMetrics(value.metrics),
    ...(value.firstUsedAt === undefined ? {} : { firstUsedAt: value.firstUsedAt })
  };
}

function previousVersion(
  current: ResourceUsageVersionBreakdown,
  versions: readonly ResourceUsageVersionBreakdown[]
): ResourceUsageVersionBreakdown | undefined {
  const boundary = current.firstUsedAt ?? Number.POSITIVE_INFINITY;
  return versions
    .filter((value) => versionKey(value.identity.contentRevision, value.identity.version)
      !== versionKey(current.identity.contentRevision, current.identity.version))
    .filter((value) => (value.firstUsedAt ?? Number.POSITIVE_INFINITY) < boundary)
    .sort((left, right) => (right.firstUsedAt ?? 0) - (left.firstUsedAt ?? 0))[0];
}

function compareVersions(
  current: ResourceUsageVersionBreakdown | undefined,
  previous: ResourceUsageVersionBreakdown | undefined
): ResourceUsageVersionComparison {
  if (current === undefined) return {
    available: false,
    minimumSamples: MINIMUM_VERSION_SAMPLES,
    unavailableReason: "no_current_version"
  };
  if (previous === undefined) return {
    available: false,
    minimumSamples: MINIMUM_VERSION_SAMPLES,
    unavailableReason: "no_previous_version",
    current
  };
  if (current.metrics.samples < MINIMUM_VERSION_SAMPLES) return {
    available: false,
    minimumSamples: MINIMUM_VERSION_SAMPLES,
    unavailableReason: "current_samples",
    current,
    previous
  };
  if (previous.metrics.samples < MINIMUM_VERSION_SAMPLES) return {
    available: false,
    minimumSamples: MINIMUM_VERSION_SAMPLES,
    unavailableReason: "previous_samples",
    current,
    previous
  };
  return { available: true, minimumSamples: MINIMUM_VERSION_SAMPLES, current, previous };
}

function localDayFormatter(timeZone: string): Intl.DateTimeFormat {
  if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.length > 128
    || timeZone !== timeZone.trim() || /[\u0000\r\n]/u.test(timeZone)) {
    throw new ResourceUsageReportQueryError("Resource usage time zone is invalid.");
  }
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
  } catch {
    throw new ResourceUsageReportQueryError("Resource usage time zone is invalid.");
  }
}

function formatLocalDay(formatter: Intl.DateTimeFormat, value: number): string {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value))
    .filter((part) => part.type === "year" || part.type === "month" || part.type === "day")
    .map((part) => [part.type, part.value]));
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
}

function validDay(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(date.getTime())
    || date.toISOString().slice(0, 10) !== value) {
    throw new ResourceUsageReportQueryError("Resource usage report day is invalid.");
  }
  return value;
}

function addDays(day: string, amount: number): string {
  const value = new Date(`${validDay(day)}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function validateCurrentIdentity(value: NonNullable<ResourceUsageReportQuery["current"]>): void {
  decimalRevision(value.entityRevision, "Current Resource entity revision");
  identity(value.contentRevision, "Current Resource content revision", 4_096);
  if (value.version !== undefined) identity(value.version, "Current Resource version", 256);
}

function versionKey(contentRevision: string, version: string | undefined): string {
  return JSON.stringify([contentRevision, version ?? null]);
}

function identity(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
    || value !== value.trim() || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) {
    throw new ResourceUsageReportQueryError(`${label} is invalid.`);
  }
  return value;
}

function decimalRevision(value: string, label: string): void {
  if (!/^[1-9][0-9]{0,19}$/u.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) {
    throw new ResourceUsageReportQueryError(`${label} is invalid.`);
  }
}

function usageSource(value: unknown): ResourceUsageSource {
  if (typeof value !== "string" || !SOURCES.includes(value as ResourceUsageSource)) {
    throw new StoreError("Resource usage source is invalid.");
  }
  return value as ResourceUsageSource;
}

function usageActivity(value: unknown): ResourceUsageActivity {
  if (value !== "strong_active" && value !== "semi_active" && value !== "passive") {
    throw new StoreError("Resource usage activity is invalid.");
  }
  return value;
}

function usageAction(value: unknown): ResourceUsageAction {
  if (value !== "exposure" && value !== "read" && value !== "reread"
    && value !== "tool_succeeded" && value !== "tool_failed"
    && value !== "command_succeeded" && value !== "command_failed") {
    throw new StoreError("Resource usage action is invalid.");
  }
  return value;
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : nonNegativeNumber(value);
}

function nonNegativeNumber(value: unknown): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new StoreError("Resource usage numeric value is invalid.");
  return result;
}

function bigInt(value: unknown): bigint {
  try {
    const result = BigInt(value as string | number | bigint);
    if (result < 0n) throw new Error();
    return result;
  } catch {
    throw new StoreError("Resource usage cursor is invalid.");
  }
}

function sqlInteger(value: bigint): SQLInputValue {
  if (value < 0n || value > 9_223_372_036_854_775_807n) throw new StoreError("Resource usage cursor exceeds SQLite range.");
  return value;
}
