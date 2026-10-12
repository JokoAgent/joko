import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { RoutineState } from "@joko/core";
import { serializeJson } from "./serialization.js";
import { SensitiveDataError } from "./errors.js";

/** One node-owned current-v1 snapshot, committed by same-directory atomic replacement. */
export class PartnerRoutineStore {
  constructor(private readonly root: string) {}

  async load(): Promise<RoutineState | null> {
    const path = join(this.root, "routines.json");
    try {
      if ((await stat(path)).size > 64 * 1024 * 1024) throw new Error("Routine storage exceeds its read budget.");
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      assertState(value);
      safeSnapshot(value);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(state: RoutineState): Promise<void> {
    assertState(state);
    const serialized = safeSnapshot(state);
    if (Buffer.byteLength(serialized, "utf8") > 64 * 1024 * 1024) throw new Error("Routine storage exceeds its write budget.");
    await mkdir(this.root, { recursive: true });
    const temporary = join(this.root, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, join(this.root, "routines.json"));
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function safeSnapshot(state: RoutineState): string {
  const raw: unknown = JSON.parse(JSON.stringify(state)); const safe = serializeJson(raw);
  if (!isDeepStrictEqual(raw, JSON.parse(safe))) throw new SensitiveDataError("Routine data must not contain credentials.");
  return safe;
}

function assertState(value: unknown): asserts value is RoutineState {
  const state = record(value);
  if (state.version !== 1 || !Array.isArray(state.routines) || !Array.isArray(state.runs)
    || !Array.isArray(state.pausedPartnerIds) || state.pausedPartnerIds.some(id => !identity(id))
    || !Array.isArray(state.retiredRoutineIds) || state.retiredRoutineIds.some(id => !identity(id))) invalid();
  timestamps(state.receipts); timestamps(state.next);
  const ids = new Set<string>();
  for (const raw of state.routines) {
    const routine = record(raw);
    if (!identity(routine.id) || ids.has(routine.id) || !identity(routine.partnerId)
      || !positive(routine.revision) || !time(routine.createdAt) || !time(routine.updatedAt)
      || typeof routine.name !== "string" || !routine.name.trim() || routine.name.length > 200
      || typeof routine.prompt !== "string" || !routine.prompt.trim() || routine.prompt.length > 100_000
      || typeof routine.enabled !== "boolean" || typeof routine.silentWhenIdle !== "boolean"
      || !Array.isArray(routine.triggers) || routine.triggers.length > 32
      || routine.enabled && routine.triggers.length === 0) invalid();
    ids.add(routine.id);
    if (routine.preRunHook !== undefined) {
      const hook = record(routine.preRunHook);
      if (typeof hook.command !== "string" || !hook.command.trim() || hook.command.length > 32_000
        || hook.timeoutMs !== undefined && !positive(hook.timeoutMs)) invalid();
    }
    const triggerIds = new Set<string>();
    for (const rawTrigger of routine.triggers) {
      const trigger = record(rawTrigger);
      if (!identity(trigger.id) || triggerIds.has(trigger.id)) invalid();
      triggerIds.add(trigger.id);
      if (trigger.kind === "cron") {
        if (!text(trigger.expression, 128) || !text(trigger.timezone, 128)) invalid();
      } else if (trigger.kind === "interval") {
        if (!positive(trigger.intervalMs) || Number(trigger.intervalMs) < 60_000
          || trigger.anchorMs !== undefined && !time(trigger.anchorMs)) invalid();
      } else if (trigger.kind === "once") {
        if (!time(trigger.at)) invalid();
      } else if (trigger.kind === "event") {
        if (!text(trigger.sourceId, 200) || !text(trigger.eventType, 200) || !Array.isArray(trigger.filters)
          || trigger.filters.length > 16) invalid();
        for (const rawFilter of trigger.filters) {
          const filter = record(rawFilter);
          if (!text(filter.field, 128) || !text(filter.value, 2000)
            || !["equals", "contains", "not-equals"].includes(String(filter.operator))) invalid();
        }
      } else invalid();
    }
  }
  const runIds = new Set<string>();
  for (const raw of state.runs) {
    const run = record(raw);
    if (!identity(run.id) || runIds.has(run.id) || !identity(run.routineId) || !positive(run.revision)
      || !time(run.createdAt) || run.finishedAt !== undefined && !time(run.finishedAt)
      || !["queued", "running", "success", "failed", "interrupted", "cancelled", "skipped"].includes(String(run.status))
      || !Array.isArray(run.triggerIds) || run.triggerIds.some(id => !identity(id))
      || !Array.isArray(run.events) || run.events.length > 100) invalid();
    runIds.add(run.id);
    for (const rawEvent of run.events) {
      const item = record(rawEvent); const event = record(item.event); const data = record(event.data);
      if (!text(item.sourceId, 200) || !text(event.id, 256) || !text(event.type, 200) || !time(event.occurredAt)
        || event.subject !== undefined && !text(event.subject, 1000)
        || event.originRoutineId !== undefined && !identity(event.originRoutineId)
        || Object.keys(data).length > 64 || JSON.stringify(data).length > 32_000
        || Object.entries(data).some(([key, field]) => !text(key, 128)
          || !(typeof field === "string" && field.length <= 8000 || typeof field === "boolean"
            || typeof field === "number" && Number.isFinite(field)))) invalid();
    }
    for (const key of ["error", "resultText", "scheduleRunId"]) if (run[key] !== undefined && typeof run[key] !== "string") invalid();
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function timestamps(value: unknown): void { if (Object.values(record(value)).some(timestamp => !time(timestamp))) invalid(); }
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0"); }
function identity(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value); }
function time(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function positive(value: unknown): value is number { return time(value) && value > 0; }
function invalid(): never { throw new Error("Routine storage is not the current v1 shape. Rebuild incompatible development data explicitly."); }
