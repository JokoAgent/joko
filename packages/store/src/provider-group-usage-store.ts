import { createHash } from "node:crypto";
import type { RunUsageSummary, UsageSnapshot } from "@joko/core";
import { StoreError } from "./errors.js";
import type { OperationalStore } from "./operational-store.js";
import { groupKey, type ProviderGroupKey } from "./provider-group-store.js";

export interface ProviderGroupUsageAttribution {
  readonly group: ProviderGroupKey; readonly memberKey: string; readonly nodeId: string; readonly nodeName: string;
  readonly partyId: string; readonly partyName: string; readonly agentKind: string;
  readonly backendId: string; readonly providerId: string; readonly modelId: string;
}
export interface ProviderGroupUsageRow extends ProviderGroupUsageAttribution {
  readonly day: string; readonly turns: number; readonly inputTokens: number; readonly outputTokens: number;
  readonly cacheReadTokens: number; readonly cacheWriteTokens: number; readonly totalTokens: number;
  readonly costMicros: number; readonly currencyCode: string; readonly estimated: boolean;
  readonly tokensComplete: boolean; readonly costComplete: boolean; readonly lastAt: number;
}
export interface ProviderGroupUsageQuery {
  readonly group: ProviderGroupKey; readonly fromDay?: string; readonly throughDay?: string;
  readonly partyId?: string; readonly nodeId?: string; readonly modelId?: string;
}
interface RunRoute { readonly format: 1; readonly runId: string; readonly attributions: readonly ProviderGroupUsageAttribution[]; readonly completed: boolean; }
const SCOPE = "provider-group-usage.v1";
const COUNTS = ["turns", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "costMicros"] as const;

/** Attribution is persisted before native dispatch and consumed from the Run's
 * durable SDK ledger summary, never from subscription percentages. */
export class ProviderGroupUsageStore {
  readonly #prefix: string;
  constructor(readonly store: OperationalStore, readonly ownerKey: string) { text(ownerKey); this.#prefix = hash(ownerKey) + ":"; }
  capture(runId: string, attributions: readonly ProviderGroupUsageAttribution[]): void {
    text(runId); attributions.forEach(assertAttribution); if (attributions.length > 512) throw invalid();
    const key = this.#prefix + "run:" + hash(runId), previous = this.store.findSetting("service", SCOPE, key)?.value;
    if (previous !== undefined) {
      const row = parseRun(previous); if (row.runId !== runId || JSON.stringify(row.attributions) !== JSON.stringify(attributions)) throw new StoreError("The Provider usage Run attribution changed."); return;
    }
    this.store.setSetting("service", SCOPE, key, { format: 1, runId, attributions, completed: false });
  }
  /** Native relays have no product Session on this computer. Capture only
   * numeric SDK accounting, never a prompt, native history or credential. */
  captureNative(runId: string, attributions: readonly ProviderGroupUsageAttribution[], baseline: UsageSnapshot | undefined, estimated: boolean): void {
    this.store.transaction(() => {
      this.capture(runId, attributions); const key = this.#prefix + "native:" + hash(runId);
      if (this.store.findSetting("service", SCOPE, key)) return;
      this.store.setSetting("service", SCOPE, key, { format: 1, estimated, ...(baseline ? { baseline: nativeNumbers(baseline) } : {}) });
    });
  }
  finishNative(runId: string, observation: UsageSnapshot | undefined, at: number): boolean {
    const value = this.store.findSetting<unknown>("service", SCOPE, this.#prefix + "native:" + hash(runId))?.value;
    if (!object(value) || Object.keys(value).some(key => !["format", "estimated", "baseline"].includes(key)) || value["format"] !== 1 || typeof value["estimated"] !== "boolean") throw invalid();
    const current = observation ? nativeNumbers(observation) : undefined, previous = value["baseline"] === undefined ? undefined : parseNativeNumbers(value["baseline"]);
    const same = current !== undefined && previous !== undefined && current.sourceId === previous.sourceId;
    const delta = (key: typeof COUNTS[number]) => current === undefined ? 0 : Math.max(0, current[key] - (same ? previous![key] : 0));
    return this.finish(runId, { inputTokens: delta("inputTokens"), outputTokens: delta("outputTokens"), cacheReadTokens: delta("cacheReadTokens"), cacheWriteTokens: delta("cacheWriteTokens"),
      totalTokens: delta("totalTokens"), costMicros: delta("costMicros"), ...(current ? { currencyCode: "USD" } : {}),
      estimated: value["estimated"] || current?.estimated === true, tokensComplete: current?.tokensComplete === true, costComplete: current?.costComplete === true }, at);
  }
  finish(runId: string, usage: RunUsageSummary, at: number): boolean {
    text(runId); if (!Number.isFinite(at) || at <= 0) throw invalid();
    for (const key of COUNTS.filter(key => key !== "turns")) count(usage[key]);
    return this.store.transaction(() => {
      const key = this.#prefix + "run:" + hash(runId), value = this.store.findSetting("service", SCOPE, key)?.value;
      if (value === undefined) return false; const run = parseRun(value); if (run.completed) return false;
      for (const attribution of run.attributions) this.#add({ ...attribution, day: utcDay(at), turns: 1,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
        totalTokens: usage.totalTokens, costMicros: usage.costMicros, currencyCode: usage.currencyCode ?? "", estimated: usage.estimated,
        tokensComplete: usage.tokensComplete, costComplete: usage.costComplete, lastAt: at });
      this.store.setSetting("service", SCOPE, key, { ...run, completed: true }); return true;
    });
  }
  rows(query: ProviderGroupUsageQuery): readonly ProviderGroupUsageRow[] {
    groupKey(query.group); if (query.fromDay !== undefined) day(query.fromDay); if (query.throughDay !== undefined) day(query.throughDay);
    if (query.fromDay && query.throughDay && query.fromDay > query.throughDay) throw invalid();
    return this.store.listSettingsByKeyPrefix("service", SCOPE, this.#prefix + "row:").map(row => parseUsageRow(row.value)).filter(row => groupKey(row.group) === groupKey(query.group)
      && (!query.fromDay || row.day >= query.fromDay) && (!query.throughDay || row.day <= query.throughDay)
      && (!query.partyId || row.partyId === query.partyId) && (!query.nodeId || row.nodeId === query.nodeId) && (!query.modelId || row.modelId === query.modelId));
  }
  /** Complete source snapshots replace the previous report, so retries and
   * reordered reports cannot double-charge a turn. Other sources stay intact. */
  replaceReported(sourceId: string, sequence: bigint, sinceDay: string, rows: readonly ProviderGroupUsageRow[]): boolean {
    text(sourceId); day(sinceDay); if (sequence < 0n || rows.length > 100_000) throw invalid(); rows.forEach(parseUsageRow);
    if (rows.some(row => row.day < sinceDay)) throw invalid();
    return this.store.transaction(() => {
      const stateKey = this.#prefix + "report:" + hash(sourceId), previous = this.store.findSetting("service", SCOPE, stateKey)?.value;
      const state = previous === undefined ? undefined : parseSequence(previous);
      if (state !== undefined && state >= sequence) return false;
      const sourcePrefix = this.#prefix + "row:reported:" + hash(sourceId) + ":";
      for (const row of this.store.listSettingsByKeyPrefix("service", SCOPE, sourcePrefix)) if (parseUsageRow(row.value).day >= sinceDay) this.store.deleteSetting("service", SCOPE, row.key);
      for (const row of rows) this.#add(row, sourcePrefix);
      this.store.setSetting("service", SCOPE, stateKey, { format: 1, sequence: sequence.toString() }); return true;
    });
  }
  localRows(sinceDay: string): readonly ProviderGroupUsageRow[] {
    day(sinceDay); return this.store.listSettingsByKeyPrefix("service", SCOPE, this.#prefix + "row:local:").map(row => parseUsageRow(row.value)).filter(row => row.day >= sinceDay);
  }
  nextSequence(channel: string, now: number): bigint {
    text(channel); return this.store.transaction(() => {
      const key = this.#prefix + "sequence:" + hash(channel), value = this.store.findSetting("service", SCOPE, key)?.value;
      const previous = value === undefined ? 0n : parseSequence(value);
      const wall = BigInt(Math.max(0, Math.floor(now))) * 1000n, next = wall > previous ? wall : previous + 1n;
      this.store.setSetting("service", SCOPE, key, { format: 1, sequence: next.toString() }); return next;
    });
  }
  #add(row: ProviderGroupUsageRow, prefix = this.#prefix + "row:local:"): void {
    parseUsageRow(row); const key = prefix + hash(JSON.stringify([groupKey(row.group), row.memberKey, row.day, row.nodeId, row.partyId, row.agentKind, row.backendId, row.providerId, row.modelId, row.currencyCode]));
    const value = this.store.findSetting("service", SCOPE, key)?.value, previous = value === undefined ? undefined : parseUsageRow(value);
    if (!previous) { this.store.setSetting("service", SCOPE, key, row); return; }
    const sums = Object.fromEntries(COUNTS.map(key => { const sum = previous[key] + row[key]; count(sum); return [key, sum]; }));
    this.store.setSetting("service", SCOPE, key, { ...row, ...sums, estimated: previous.estimated || row.estimated,
      tokensComplete: previous.tokensComplete && row.tokensComplete, costComplete: previous.costComplete && row.costComplete, lastAt: Math.max(previous.lastAt, row.lastAt) });
  }
}
export function parseProviderGroupUsageRow(value: unknown): ProviderGroupUsageRow { return parseUsageRow(value); }
function parseUsageRow(value: unknown): ProviderGroupUsageRow {
  assertAttribution(value);
  const row = value as unknown as Record<string, unknown>;
  if (Object.keys(row).some(key => !["group", "memberKey", "nodeId", "nodeName", "partyId", "partyName", "agentKind", "backendId", "providerId", "modelId", "day", ...COUNTS,
    "currencyCode", "estimated", "tokensComplete", "costComplete", "lastAt"].includes(key))) throw invalid();
  day(row["day"]); COUNTS.forEach(key => count(row[key]));
  if (typeof row["currencyCode"] !== "string" || row["currencyCode"] !== "" && !/^[A-Z]{3}$/u.test(row["currencyCode"])
    || typeof row["estimated"] !== "boolean" || typeof row["tokensComplete"] !== "boolean" || typeof row["costComplete"] !== "boolean"
    || typeof row["lastAt"] !== "number" || !Number.isFinite(row["lastAt"]) || row["lastAt"] <= 0 || utcDay(row["lastAt"]) !== row["day"]) throw invalid();
  return value as ProviderGroupUsageRow;
}
function assertAttribution(value: unknown): asserts value is ProviderGroupUsageAttribution {
  if (!object(value) || !object(value["group"]) || Object.keys(value["group"]).some(key => !["backendId", "providerId"].includes(key))) throw invalid();
  text(value["group"]["backendId"]); text(value["group"]["providerId"]);
  ["memberKey", "nodeId", "nodeName", "partyId", "partyName", "agentKind", "backendId", "providerId", "modelId"].forEach(key => text(value[key]));
}
interface NativeNumbers extends Record<typeof COUNTS[number], number> { readonly sourceId: string; readonly tokensComplete: boolean; readonly costComplete: boolean; readonly estimated: boolean; }
function nativeNumbers(value: UsageSnapshot): NativeNumbers {
  const native = value.nativeAccounting, costMicros = Math.round(value.cost * 1_000_000);
  const result: NativeNumbers = { turns: 0, inputTokens: value.inputTokens, outputTokens: value.outputTokens, cacheReadTokens: value.cacheReadTokens, cacheWriteTokens: value.cacheWriteTokens,
    totalTokens: value.totalTokens, costMicros, sourceId: native?.sourceId ?? "unproven", tokensComplete: native?.tokensComplete === true,
    costComplete: native?.costComplete === true, estimated: native?.costEstimated !== false };
  return parseNativeNumbers(result);
}
function parseNativeNumbers(value: unknown): NativeNumbers {
  if (!object(value) || Object.keys(value).some(key => ![...COUNTS, "sourceId", "tokensComplete", "costComplete", "estimated"].includes(key))
    || ["tokensComplete", "costComplete", "estimated"].some(key => typeof value[key] !== "boolean")) throw invalid();
  text(value["sourceId"]); COUNTS.forEach(key => count(value[key])); return value as unknown as NativeNumbers;
}
function parseRun(value: unknown): RunRoute {
  if (!object(value) || Object.keys(value).some(key => !["format", "runId", "attributions", "completed"].includes(key)) || value["format"] !== 1
    || !Array.isArray(value["attributions"]) || value["attributions"].length > 512 || typeof value["completed"] !== "boolean") throw invalid();
  text(value["runId"]); value["attributions"].forEach(assertAttribution); return value as unknown as RunRoute;
}
function parseSequence(value: unknown): bigint {
  if (!object(value) || Object.keys(value).some(key => !["format", "sequence"].includes(key)) || value["format"] !== 1
    || typeof value["sequence"] !== "string" || !/^(0|[1-9]\d{0,39})$/u.test(value["sequence"])) throw invalid(); return BigInt(value["sequence"]);
}
function utcDay(at: number): string { return new Date(at).toISOString().slice(0, 10); }
function day(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(value + "T00:00:00Z")) || utcDay(Date.parse(value + "T00:00:00Z")) !== value) throw invalid();
}
function text(value: unknown): asserts value is string { if (typeof value !== "string" || !value || value.length > 512 || /[\0\r\n]/u.test(value)) throw invalid(); }
function count(value: unknown): asserts value is number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid(); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function invalid(): StoreError { return new StoreError("Provider group usage is not a valid current-v1 record."); }
