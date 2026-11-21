import { createHash } from "node:crypto";
import { record } from "./projection.js";

type Row = Record<string, unknown>;
type PendingBatch = { readonly row: number; readonly calls: ToolCall[]; position: number };
interface ToolCall {
  readonly row: number;
  readonly originalId: string;
  readonly id: string;
  readonly block: Row;
  readonly scope?: string;
  readonly assistantUuid?: string;
  answered: boolean;
}

const minted = /^[A-Za-z][A-Za-z0-9_-]*_\d+$/u;
const candidateText = /"(?:id|tool_use_id)"\s*:\s*"[A-Za-z][A-Za-z0-9_-]*_\d+"/u;

/** Preserve the original encoding of rows whose fields did not change. */
export function repairClaudeTranscriptText(text: string): string {
  if (!candidateText.test(text)) return text;
  const lines = text.split("\n");
  const rows: unknown[] = [];
  let last = lines.length - 1;
  while (last >= 0 && lines[last]!.trim() === "") last--;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") { rows.push(undefined); continue; }
    try { rows.push(JSON.parse(line)); }
    catch { if (index !== last) return text; rows.push(undefined); }
  }
  const changed = repairClaudeToolIds(rows);
  if (changed.size === 0) return text;
  return lines.map((line, index) => changed.has(index)
    ? JSON.stringify(rows[index]) + (line.endsWith("\r") ? "\r" : "") : line).join("\n");
}

/** Rewrite only the CLI's opaque tool identifiers on the decoded transcript. */
export function repairClaudeToolIds(input: readonly unknown[]): ReadonlySet<number> {
  const changed = new Set<number>();
  const rows = input.map(record);
  const used = new Set<string>();
  for (const row of rows) {
    if (!row) continue;
    for (const block of toolBlocks(row)) {
      const field = block["type"] === "tool_use" ? "id" : "tool_use_id";
      const id = identifier(block[field]);
      if (id) used.add(id);
    }
    for (const id of toolReferenceIds(row)) used.add(id);
  }
  if (![...used].some(id => minted.test(id))) return changed;
  const allocate = (id: string, serial: string): string => {
    for (let revision = 0; ; revision++) {
      const digest = createHash("sha256").update(JSON.stringify([id, serial, revision])).digest("hex");
      const value = `toolu_joko_${digest.slice(0, 32)}`;
      if (!used.has(value)) { used.add(value); return value; }
    }
  };
  const calls = new Map<string, ToolCall[]>();
  const scopedCalls = new Map<string, ToolCall[]>();
  const callsByRow = new Map<number, ToolCall[]>();
  const standalone = new Map<string, string>();
  const isolatedId = (id: string): string => {
    if (!minted.test(id)) return id;
    const existing = standalone.get(id);
    if (existing) return existing;
    const next = allocate(id, "unpaired");
    standalone.set(id, next);
    return next;
  };
  const update = (index: number, object: Row, field: string, value: string) => {
    if (object[field] !== value) { object[field] = value; changed.add(index); }
  };
  const append = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
    const items = map.get(key);
    if (items) items.push(value);
    else map.set(key, [value]);
  };
  for (const [index, row] of rows.entries()) {
    if (!row || record(row["message"])?.["role"] !== "assistant") continue;
    const scope = identifier(row["parent_tool_use_id"]);
    const assistantUuid = identifier(row["uuid"]);
    for (const block of toolBlocks(row)) {
      const originalId = block["type"] === "tool_use" && identifier(block["id"]);
      if (!originalId) continue;
      const before = calls.get(originalId)?.length ?? 0;
      const id = minted.test(originalId) || before > 0 ? allocate(originalId, `call-${before}`) : originalId;
      const call = { row: index, id, originalId, block, scope, assistantUuid, answered: false };
      append(calls, originalId, call);
      append(callsByRow, index, call);
      if (scope) append(scopedCalls, JSON.stringify([scope, originalId]), call);
    }
  }

  const open = new Map<string, PendingBatch[]>();
  const addPending = (key: string, call: ToolCall) => {
    const batches = open.get(key);
    const current = batches?.at(-1);
    if (current?.row === call.row) current.calls.push(call);
    else append(open, key, { row: call.row, calls: [call], position: 0 });
  };
  const take = (key: string): ToolCall | undefined => {
    const batches = open.get(key);
    while (batches && batches.length > 0) {
      const batch = batches[batches.length - 1]!;
      while (batch.position < batch.calls.length) {
        const call = batch.calls[batch.position++]!;
        if (!call.answered) { call.answered = true; return call; }
      }
      batches.pop();
    }
    return undefined;
  };
  for (const [index, row] of rows.entries()) {
    if (!row) continue;
    for (const call of callsByRow.get(index) ?? []) {
      addPending(call.originalId, call);
      if (call.scope) addPending(JSON.stringify(["scope", call.scope, call.originalId]), call);
      if (call.assistantUuid) addPending(JSON.stringify(["uuid", call.assistantUuid, call.originalId]), call);
      update(index, call.block, "id", call.id);
    }
    if (record(row["message"])?.["role"] !== "user") continue;
    const assistant = identifier(row["sourceToolAssistantUUID"]) ?? identifier(row["parentUuid"]);
    const scope = identifier(row["parent_tool_use_id"]);
    for (const block of toolBlocks(row)) {
      const id = block["type"] === "tool_result" && identifier(block["tool_use_id"]);
      if (!id) continue;
      const exact = assistant === undefined ? undefined : take(JSON.stringify(["uuid", assistant, id]));
      const scoped = exact || scope === undefined ? undefined : take(JSON.stringify(["scope", scope, id]));
      const call = exact ?? scoped ?? take(id);
      const first = calls.get(id)?.[0];
      update(index, block, "tool_use_id", call?.id ?? (first && first.row < index ? first.id : isolatedId(id)));
    }
  }

  const linkedChildren = new Map<string, string>();
  const scalarPositions = new Map<string, number>();
  const streamPositions = new Map<string, number>();
  for (const [index, row] of rows.entries()) {
    if (!row) continue;
    const child = identifier(row["task_id"]) ?? identifier(row["uuid"]);
    const scope = identifier(row["parent_tool_use_id"]);
    for (const field of ["parent_tool_use_id", "tool_use_id"]) {
      const id = identifier(row[field]);
      if (!id) continue;
      const key = child === undefined ? undefined : JSON.stringify([child, id]);
      const linked = key === undefined ? undefined : linkedChildren.get(key);
      const value = linked ?? referenceCall(calls.get(id), id, index, scalarPositions) ?? isolatedId(id);
      if (key) linkedChildren.set(key, value);
      update(index, row, field, value);
    }
    const previous = row["preceding_tool_use_ids"];
    if (Array.isArray(previous)) {
      const positions = new Map<string, number>();
      for (const [slot, item] of previous.entries()) {
        const id = identifier(item);
        if (!id) continue;
        const next = referenceCall(calls.get(id), id, index, positions) ?? isolatedId(id);
        if (next !== id) { previous[slot] = next; changed.add(index); }
      }
    }
    const event = record(row["event"]);
    const block = event?.["type"] === "content_block_start" ? record(event["content_block"]) : undefined;
    const id = block?.["type"] === "tool_use" ? identifier(block["id"]) : undefined;
    if (block && id) {
      const key = JSON.stringify([scope ?? "", id]);
      const entries = (scope === undefined ? undefined : scopedCalls.get(JSON.stringify([scope, id]))) ?? calls.get(id);
      if (entries?.length) {
        const previous = streamPositions.get(key) ?? 0;
        const next = Math.max(previous, beforeRow(entries, index));
        const chosen = next < entries.length ? next : Math.min(previous, entries.length - 1);
        streamPositions.set(key, chosen + 1);
        update(index, block, "id", entries[chosen]!.id);
      } else update(index, block, "id", isolatedId(id));
    }
  }
  return changed;
}

function referenceCall(entries: readonly ToolCall[] | undefined, id: string, row: number, positions: Map<string, number>): string | undefined {
  if (!entries?.length) return undefined;
  const end = beforeRow(entries, row);
  if (end === 0) return entries[0]!.id;
  const latest = entries[end - 1]!;
  const first = beforeRow(entries, latest.row);
  const key = JSON.stringify([id, latest.row]);
  const index = Math.min(first + (positions.get(key) ?? 0), end - 1);
  positions.set(key, index - first + 1);
  return entries[index]!.id;
}

function beforeRow(entries: readonly ToolCall[], row: number): number {
  let low = 0, high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (entries[middle]!.row < row) low = middle + 1;
    else high = middle;
  }
  return low;
}

function toolBlocks(row: Row): Row[] {
  const content = record(row["message"])?.["content"];
  return Array.isArray(content) ? content.flatMap(value => {
    const block = record(value);
    return block?.["type"] === "tool_use" || block?.["type"] === "tool_result" ? [block] : [];
  }) : [];
}

function toolReferenceIds(row: Row): string[] {
  const event = record(row["event"]);
  const content = event?.["type"] === "content_block_start" ? record(event["content_block"]) : undefined;
  const streamId = content?.["type"] === "tool_use" ? content["id"] : undefined;
  const previous = row["preceding_tool_use_ids"];
  return [row["parent_tool_use_id"], row["tool_use_id"], streamId, ...(Array.isArray(previous) ? previous : [])]
    .flatMap(value => { const id = identifier(value); return id ? [id] : []; });
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
