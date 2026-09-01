import { createHash } from "node:crypto";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

import type { SessionDescriptor } from "@joko/core";
import * as sqliteVec from "sqlite-vec";

const ACTIVE_RUN_STATES = "'queued','running','waiting','retrying','dispatch_unknown'";
const ACTIVE_QUEUE_STATES = "'accepted','dispatching','backend_accepted','dispatch_unknown'";

export interface HistoryWorkCandidate {
  readonly sessionId: string;
  readonly status: "active" | "archived" | "deleted";
  readonly updatedAt: number;
  readonly binding: SessionDescriptor["binding"];
}

export interface HistoryWorkBindingReplacement {
  readonly sessionId: string;
  readonly source: SessionDescriptor["binding"];
  readonly replacement: SessionDescriptor["binding"];
}

export interface HistoryWorkInput {
  readonly workingPath: string;
  readonly candidates: readonly HistoryWorkCandidate[];
  readonly replacements: readonly HistoryWorkBindingReplacement[];
  readonly prunedAt: number;
}

export interface HistoryWorkCleanupResult {
  readonly activeTaskCount: number;
  readonly deletedTaskCount: number;
  readonly archivedTaskCount: number;
  readonly messageCount: number;
  readonly skippedTaskCount: number;
  readonly activeSessionIds: readonly string[];
  readonly affectedSessionIds: readonly string[];
}

export type HistoryWorkPhase = "cleaning" | "compacting" | "verifying";

export interface HistoryWorkControls {
  readonly signal?: AbortSignal;
  readonly onProgress?: (phase: HistoryWorkPhase, percent: number) => void;
}

export class HistoryWorkCancelledError extends Error {
  constructor() {
    super("Task history maintenance was cancelled.");
    this.name = "HistoryWorkCancelledError";
  }
}

export async function runHistoryMaintenanceWorker(
  input: HistoryWorkInput,
  controls: HistoryWorkControls = {}
): Promise<HistoryWorkCleanupResult> {
  if (controls.signal?.aborted === true) throw new HistoryWorkCancelledError();
  return await new Promise<HistoryWorkCleanupResult>((resolve, reject) => {
    const worker = new Worker(new URL("./history-maintenance-worker.js", import.meta.url), { workerData: input });
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      controls.signal?.removeEventListener("abort", cancel);
      callback();
    };
    const cancel = (): void => {
      void worker.terminate().finally(() => finish(() => reject(new HistoryWorkCancelledError())));
    };
    controls.signal?.addEventListener("abort", cancel, { once: true });
    worker.on("message", (message: WorkerMessage) => {
      if (message.kind === "progress") {
        controls.onProgress?.(message.phase, message.percent);
        return;
      }
      if (message.kind === "result") finish(() => resolve(message.result));
      if (message.kind === "error") finish(() => reject(new Error(message.message)));
    });
    worker.on("error", (error) => finish(() => reject(error)));
    worker.on("exit", (code) => {
      if (code !== 0) finish(() => reject(new Error("Task history maintenance worker stopped unexpectedly.")));
    });
  });
}

export function cleanHistoryMaintenanceCopy(
  input: HistoryWorkInput,
  reportProgress: (phase: HistoryWorkPhase, percent: number) => void = () => undefined
): HistoryWorkCleanupResult {
  const database = new DatabaseSync(input.workingPath, { allowExtension: true });
  let vectorAvailable = false;
  try {
    const vectorExists = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'message_search_vectors'"
    ).get() !== undefined;
    if (vectorExists) {
      try {
        sqliteVec.load(database);
        vectorAvailable = true;
      } catch (error) {
        throw new Error("The vector extension is required to clean the semantic message index.", { cause: error });
      }
    }
    database.enableLoadExtension(false);
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL");
    reportProgress("cleaning", 40);
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(`
        CREATE TEMP TABLE history_targets (
          session_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          expected_updated_at INTEGER NOT NULL,
          source_opaque_ref TEXT NOT NULL,
          source_native_session_id TEXT,
          source_generation INTEGER NOT NULL,
          replacement_opaque_ref TEXT,
          replacement_native_session_id TEXT,
          replacement_generation INTEGER
        ) STRICT;
      `);
      const replacementBySession = new Map(input.replacements.map((item) => [item.sessionId, item]));
      const insert = database.prepare(`
        INSERT INTO history_targets(
          session_id, status, expected_updated_at, source_opaque_ref,
          source_native_session_id, source_generation, replacement_opaque_ref,
          replacement_native_session_id, replacement_generation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const candidate of input.candidates) {
        const replacement = replacementBySession.get(candidate.sessionId);
        insert.run(
          candidate.sessionId,
          candidate.status,
          candidate.updatedAt,
          candidate.binding.opaqueRef,
          candidate.binding.nativeSessionId ?? null,
          candidate.binding.generation,
          replacement?.replacement.opaqueRef ?? null,
          replacement?.replacement.nativeSessionId ?? null,
          replacement?.replacement.generation ?? null
        );
      }
      database.exec(`
        DELETE FROM history_targets
        WHERE NOT EXISTS (
          SELECT 1 FROM product_sessions AS session
          WHERE session.id = history_targets.session_id
            AND session.updated_at = history_targets.expected_updated_at
            AND session.native_opaque_ref = history_targets.source_opaque_ref
            AND session.native_session_id IS history_targets.source_native_session_id
            AND session.generation = history_targets.source_generation
            AND CASE WHEN session.deleted_at IS NOT NULL THEN 'deleted'
                     WHEN session.archived = 1 THEN 'archived' ELSE 'active' END = history_targets.status
        )
           OR (status = 'active' AND (
             replacement_opaque_ref IS NULL
             OR replacement_generation IS NULL
             OR replacement_opaque_ref = source_opaque_ref
             OR replacement_generation <= source_generation
           ))
           OR EXISTS (
             SELECT 1 FROM runs WHERE runs.session_id = history_targets.session_id
               AND runs.state IN (${ACTIVE_RUN_STATES})
           )
           OR EXISTS (
             SELECT 1 FROM queue_items WHERE queue_items.session_id = history_targets.session_id
               AND queue_items.state IN (${ACTIVE_QUEUE_STATES})
           )
           OR EXISTS (
             SELECT 1 FROM interactions WHERE interactions.session_id = history_targets.session_id
               AND interactions.status = 'open'
           )
           OR EXISTS (
             SELECT 1 FROM tool_leases WHERE tool_leases.session_id = history_targets.session_id
               AND tool_leases.state = 'active'
           )
           OR EXISTS (
             SELECT 1 FROM review_runs
             WHERE (review_runs.source_session_id = history_targets.session_id
                 OR review_runs.reviewer_session_id = history_targets.session_id)
               AND review_runs.state = 'running'
           );

        CREATE TEMP TABLE history_events (
          event_cursor INTEGER PRIMARY KEY,
          event_id TEXT NOT NULL UNIQUE,
          operation_id TEXT
        ) STRICT;
        INSERT INTO history_events(event_cursor, event_id, operation_id)
        SELECT event.global_cursor, event.id, event.operation_id
        FROM events AS event JOIN history_targets AS target ON target.session_id = event.session_id;

        CREATE TEMP TABLE history_operations (operation_id TEXT PRIMARY KEY) STRICT;
        INSERT OR IGNORE INTO history_operations SELECT operation_id FROM history_events WHERE operation_id IS NOT NULL;
        INSERT OR IGNORE INTO history_operations
          SELECT queue.operation_id FROM queue_items AS queue JOIN history_targets AS target ON target.session_id = queue.session_id;
        INSERT OR IGNORE INTO history_operations
          SELECT interaction.operation_id FROM interactions AS interaction JOIN history_targets AS target ON target.session_id = interaction.session_id
          WHERE interaction.operation_id IS NOT NULL;
        INSERT OR IGNORE INTO history_operations
          SELECT boundary.reset_operation_id FROM session_reset_boundaries AS boundary
          JOIN history_targets AS target ON target.session_id = boundary.session_id;
        INSERT OR IGNORE INTO history_operations
          SELECT rebuild.latest_deletion_operation_id FROM session_context_rebuilds AS rebuild
          JOIN history_targets AS target ON target.session_id = rebuild.session_id;
      `);

      const counts = database.prepare(`
        SELECT
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
          SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived_count,
          SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END) AS deleted_count,
          (SELECT COUNT(*) FROM events AS event JOIN history_targets AS target ON target.session_id = event.session_id
            WHERE json_extract(event.payload_json, '$.payload.type') = 'message_complete') AS message_count,
          COUNT(*) AS target_count
        FROM history_targets
      `).get() as Record<string, unknown>;
      const activeSessionIds = (database.prepare(
        "SELECT session_id FROM history_targets WHERE status = 'active' ORDER BY session_id"
      ).all() as Array<Record<string, unknown>>).map((row) => String(row["session_id"]));
      const affectedSessionIds = (database.prepare(
        "SELECT session_id FROM history_targets ORDER BY session_id"
      ).all() as Array<Record<string, unknown>>).map((row) => String(row["session_id"]));

      database.exec("DELETE FROM message_search_fts WHERE rowid IN (SELECT event_cursor FROM history_events)");
      if (vectorAvailable) {
        database.exec("DELETE FROM message_search_vectors WHERE rowid IN (SELECT event_cursor FROM history_events)");
      }
      database.exec(`
        DELETE FROM message_embedding_records WHERE event_cursor IN (SELECT event_cursor FROM history_events);
        DELETE FROM message_embedding_jobs WHERE event_cursor IN (SELECT event_cursor FROM history_events);
        DELETE FROM native_history_current_markers WHERE session_id IN (SELECT session_id FROM history_targets);
        DELETE FROM native_history_canonical_identities WHERE session_id IN (SELECT session_id FROM history_targets);
        DELETE FROM session_attention WHERE session_id IN (SELECT session_id FROM history_targets);
        DELETE FROM session_context_rebuilds WHERE session_id IN (SELECT session_id FROM history_targets);
        DELETE FROM session_reset_boundaries WHERE session_id IN (SELECT session_id FROM history_targets);
        DELETE FROM events WHERE global_cursor IN (SELECT event_cursor FROM history_events);
        DELETE FROM interactions WHERE session_id IN (SELECT session_id FROM history_targets);
        DELETE FROM tool_leases WHERE session_id IN (SELECT session_id FROM history_targets);
        DELETE FROM queue_items WHERE session_id IN (SELECT session_id FROM history_targets);
        UPDATE runs SET parent_run_id = NULL WHERE parent_run_id IN (
          SELECT run.id FROM runs AS run JOIN history_targets AS target ON target.session_id = run.session_id
        );
        DELETE FROM runs WHERE session_id IN (SELECT session_id FROM history_targets);
        DELETE FROM review_runs
          WHERE state <> 'running' AND (
            source_session_id IN (SELECT session_id FROM history_targets WHERE status = 'active')
            OR reviewer_session_id IN (SELECT session_id FROM history_targets WHERE status = 'active')
          );
        DELETE FROM session_objectives WHERE session_id IN (
          SELECT session_id FROM history_targets WHERE status = 'active'
        );
        DELETE FROM settings
          WHERE scope_type = 'session'
            AND scope_id IN (SELECT session_id FROM history_targets WHERE status = 'active')
            AND key LIKE 'runtime.%';

        CREATE TEMP TABLE removed_change_sets (change_set_id TEXT PRIMARY KEY) STRICT;
        INSERT INTO removed_change_sets(change_set_id)
          SELECT substr(key, length('workspace_change_set.') + 1)
          FROM settings
          WHERE scope_type = 'service' AND scope_id = 'orchestrator'
            AND key LIKE 'workspace_change_set.%'
            AND json_extract(value_json, '$.sessionId') IN (
              SELECT session_id FROM history_targets WHERE status = 'active'
            );
        CREATE TEMP TABLE removed_baselines (baseline_id TEXT PRIMARY KEY) STRICT;
        INSERT OR IGNORE INTO removed_baselines(baseline_id)
          SELECT json_extract(value_json, '$.baselineId')
          FROM settings
          WHERE scope_type = 'service' AND scope_id = 'orchestrator'
            AND key IN (SELECT 'workspace_change_set.' || change_set_id FROM removed_change_sets)
            AND NULLIF(json_extract(value_json, '$.baselineId'), '') IS NOT NULL;
        CREATE TEMP TABLE removed_previews (preview_id TEXT PRIMARY KEY) STRICT;
        INSERT OR IGNORE INTO removed_previews(preview_id)
          SELECT substr(key, length('workspace_rewind_preview.') + 1)
          FROM settings
          WHERE scope_type = 'service' AND scope_id = 'orchestrator'
            AND key LIKE 'workspace_rewind_preview.%'
            AND json_extract(value_json, '$.changeSetId') IN (SELECT change_set_id FROM removed_change_sets);
        DELETE FROM settings
          WHERE scope_type = 'service' AND scope_id = 'orchestrator'
            AND key IN (SELECT 'workspace_change_set.' || change_set_id FROM removed_change_sets);
        DELETE FROM settings
          WHERE scope_type = 'service' AND scope_id = 'orchestrator'
            AND key LIKE 'workspace_rewind_preview.%'
            AND json_extract(value_json, '$.changeSetId') IN (SELECT change_set_id FROM removed_change_sets);
        DELETE FROM settings
          WHERE scope_type = 'service' AND scope_id = 'orchestrator'
            AND key IN (SELECT 'workspace_rewind_consumed.' || preview_id FROM removed_previews);
        DELETE FROM settings AS baseline
          WHERE baseline.scope_type = 'service' AND baseline.scope_id = 'orchestrator'
            AND baseline.key IN (SELECT 'workspace_baseline.' || baseline_id FROM removed_baselines)
            AND NOT EXISTS (
              SELECT 1 FROM settings AS change_set
              WHERE change_set.scope_type = 'service' AND change_set.scope_id = 'orchestrator'
                AND change_set.key LIKE 'workspace_change_set.%'
                AND json_extract(change_set.value_json, '$.baselineId') =
                    substr(baseline.key, length('workspace_baseline.') + 1)
            );

        DELETE FROM operations
          WHERE id IN (SELECT operation_id FROM history_operations)
            AND NOT EXISTS (SELECT 1 FROM events WHERE events.operation_id = operations.id)
            AND NOT EXISTS (SELECT 1 FROM queue_items WHERE queue_items.operation_id = operations.id)
            AND NOT EXISTS (SELECT 1 FROM interactions WHERE interactions.operation_id = operations.id)
            AND NOT EXISTS (SELECT 1 FROM message_event_tombstones WHERE message_event_tombstones.deletion_operation_id = operations.id)
            AND NOT EXISTS (SELECT 1 FROM session_context_rebuilds WHERE session_context_rebuilds.latest_deletion_operation_id = operations.id)
            AND NOT EXISTS (SELECT 1 FROM session_objectives WHERE session_objectives.pending_operation_id = operations.id)
            AND NOT EXISTS (SELECT 1 FROM session_reset_boundaries WHERE session_reset_boundaries.reset_operation_id = operations.id);
      `);

      const newRevisionRow = database.prepare(
        "UPDATE store_meta SET revision = revision + 1 WHERE singleton = 1 RETURNING revision"
      ).get() as Record<string, unknown> | undefined;
      if (newRevisionRow === undefined) throw new Error("History maintenance could not advance the operational revision.");
      const newRevision = checkedCount(newRevisionRow["revision"]);
      const updateActive = database.prepare(`
        UPDATE product_sessions
           SET native_opaque_ref = ?, native_binding_fingerprint = ?,
               native_session_id = ?, generation = ?, task_summary = NULL,
               summary_source_cursor = NULL, summary_updated_at = NULL,
               updated_at = MAX(updated_at, ?), revision = ?
         WHERE id = ? AND id IN (SELECT session_id FROM history_targets WHERE status = 'active')
      `);
      for (const sessionId of activeSessionIds) {
        const replacement = replacementBySession.get(sessionId);
        if (replacement === undefined) throw new Error("Active task history cleanup lacks a fresh native binding.");
        updateActive.run(
          replacement.replacement.opaqueRef,
          nativeBindingFingerprint(replacement.replacement.opaqueRef),
          replacement.replacement.nativeSessionId ?? null,
          replacement.replacement.generation,
          input.prunedAt,
          newRevision,
          sessionId
        );
      }
      database.exec("COMMIT");
      reportProgress("compacting", 60);
      database.exec("VACUUM");
      reportProgress("verifying", 90);
      const quick = database.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
      if (quick.length !== 1 || String(quick[0]?.["quick_check"] ?? "") !== "ok") {
        throw new Error("Compacted task history database failed its integrity check.");
      }
      if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
        throw new Error("Compacted task history database failed its foreign-key check.");
      }
      return {
        activeTaskCount: checkedCount(counts["active_count"] ?? 0),
        archivedTaskCount: checkedCount(counts["archived_count"] ?? 0),
        deletedTaskCount: checkedCount(counts["deleted_count"] ?? 0),
        messageCount: checkedCount(counts["message_count"] ?? 0),
        skippedTaskCount: input.candidates.length - checkedCount(counts["target_count"] ?? 0),
        activeSessionIds,
        affectedSessionIds
      };
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* The transaction may already have committed. */ }
      throw error;
    }
  } finally {
    database.close();
  }
}

type WorkerMessage =
  | { readonly kind: "progress"; readonly phase: HistoryWorkPhase; readonly percent: number }
  | { readonly kind: "result"; readonly result: HistoryWorkCleanupResult }
  | { readonly kind: "error"; readonly message: string };

if (!isMainThread && parentPort !== null) {
  const workerPort = parentPort;
  try {
    const input = workerData as HistoryWorkInput;
    const result = cleanHistoryMaintenanceCopy(input, (phase, percent) => {
      workerPort.postMessage({ kind: "progress", phase, percent } satisfies WorkerMessage);
    });
    workerPort.postMessage({ kind: "result", result } satisfies WorkerMessage);
  } catch (error) {
    workerPort.postMessage({
      kind: "error",
      message: error instanceof Error ? error.message : "Task history maintenance worker failed."
    } satisfies WorkerMessage);
  }
}

function checkedCount(value: unknown): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("Task history maintenance returned an invalid count.");
  return result;
}

function nativeBindingFingerprint(opaqueReference: string): string {
  return `sha256:${createHash("sha256").update(opaqueReference).digest("hex")}`;
}
