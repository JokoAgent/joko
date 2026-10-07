import { MessageRole, type Event } from "@joko/contracts";
import { mobileToolCallScopeKey, projectMobileToolCall, type MobileToolCallView } from "./mobile-tool-call";

export type MobilePlanStepState = "pending" | "inProgress" | "completed";
export interface MobilePlanStep {
  readonly id: string;
  readonly content: string;
  readonly state: MobilePlanStepState;
  readonly activeForm?: string;
}
export interface MobilePlanOwner {
  readonly sessionId: string;
  readonly generation: bigint;
  readonly nativeGeneration: bigint;
}
export interface MobileInlinePlan {
  readonly identity: string;
  readonly sessionId: string;
  readonly generation: bigint;
  readonly nativeGeneration: bigint;
  readonly source: "todo" | "updatePlan" | "task";
  readonly eventId: string;
  readonly sequence: bigint;
  readonly runId: string;
  readonly sourceEventIds: readonly string[];
  readonly sourceToolScopeKeys: readonly string[];
  readonly steps: readonly MobilePlanStep[];
  readonly completed: number;
  readonly total: number;
  readonly activeContent: string;
  readonly streaming: boolean;
  readonly sealed: boolean;
  readonly outcome?: "completed" | "aborted" | "failed";
}
export interface MobileInlinePlans {
  readonly cards: readonly MobileInlinePlan[];
  readonly byEventId: ReadonlyMap<string, MobileInlinePlan>;
  /** Last resolved edges remain reachable after their raw tool row advances to an unresolved replacement. */
  readonly byToolScopeKey: ReadonlyMap<string, readonly MobileInlinePlan[]>;
  readonly sourceEventIds: ReadonlySet<string>;
}

interface PlanRow {
  readonly id: string;
  readonly eventId: string;
  readonly sequence: bigint;
  readonly nativeGeneration: bigint;
  readonly runId: string;
  readonly user?: boolean;
  readonly outcome?: "completed" | "aborted" | "failed";
  readonly tool?: MobileToolCallView;
}
interface PlanSession {
  readonly identity: string;
  readonly source: MobileInlinePlan["source"];
  readonly nativeGeneration: bigint;
  readonly boundarySequence: bigint;
  readonly sourceEventIds: string[];
  readonly sourceToolScopeKeys: string[];
  steps: readonly MobilePlanStep[];
  last: PlanRow;
  outcome?: MobileInlinePlan["outcome"];
}
type ProjectionResult = { readonly kind: "snapshot"; readonly steps: readonly MobilePlanStep[] }
  | { readonly kind: "clear" } | { readonly kind: "unresolved" };
const taskToolNames = new Set(["taskcreate", "taskupdate", "taskget", "tasklist"]);
const maximumJsonCharacters = 256 * 1_024;

/** Read-only structural presentation. Recognized tool payloads never grant a mutation or path action. */
export function projectMobileInlinePlans(events: readonly Event[], owner: MobilePlanOwner, activeTail = false): MobileInlinePlans {
  if (!owner.sessionId || owner.generation < 1n || owner.nativeGeneration < 1n) return { cards: [], byEventId: new Map(), byToolScopeKey: new Map(), sourceEventIds: new Set() };
  const rows = planRows(events, owner);
  const sessions: PlanSession[] = [];
  const previousBySource = new Map<string, PlanSession>();
  const tasksByGeneration = new Map<bigint, Map<string, MobilePlanStep>>();
  const userBoundaries = new Map<bigint, { sequence: bigint; runId: string }>();
  const terminalRuns = new Map<string, MobileInlinePlan["outcome"]>();
  const sourceEventIds = new Set<string>();
  for (const row of rows) {
    if (row.user) {
      const previous = userBoundaries.get(row.nativeGeneration);
      if (!previous || !row.runId || row.runId !== previous.runId) userBoundaries.set(row.nativeGeneration, { sequence: row.sequence, runId: row.runId });
      continue;
    }
    if (row.outcome) {
      terminalRuns.set(JSON.stringify([row.nativeGeneration.toString(), row.runId]), row.outcome);
      const previous = previousBySource.get(`${row.nativeGeneration}:updatePlan`);
      if (previous?.last.runId === row.runId && row.runId) previous.outcome = row.outcome;
      continue;
    }
    const tool = row.tool;
    if (!tool) continue;
    const name = tool.name.trim().toLocaleLowerCase().replace(/[\s-]+/gu, "_");
    const source = planToolSource(name);
    if (!source) continue;
    sourceEventIds.add(row.eventId);
    if (terminalRuns.has(JSON.stringify([row.nativeGeneration.toString(), row.runId]))) continue;
    if (tool.inputRedacted || tool.inputTruncated) continue;
    const input = parseDisplayedToolValue(tool.input);
    const output = tool.outputTruncated ? undefined : parseJsonLike(tool.output);
    const previousKey = `${row.nativeGeneration}:${source}`;
    const previous = previousBySource.get(previousKey);
    const tasks = tasksByGeneration.get(row.nativeGeneration) ?? new Map<string, MobilePlanStep>();
    tasksByGeneration.set(row.nativeGeneration, tasks);
    const boundary = userBoundaries.get(row.nativeGeneration)?.sequence ?? -1n;
    const targetsExisting = source === "task" && taskToolTargetsExisting(tasks, name, input, output);
    const allDone = previous !== undefined && previous.steps.every((step) => step.state === "completed");
    const crossesUserBoundary = previous !== undefined && boundary > previous.boundarySequence && !targetsExisting;
    const sameTaskCreation = source === "task" && name === "taskcreate" && previous?.last.id === row.id;
    const mayStartNew = !previous || previous.outcome === "completed" || crossesUserBoundary || allDone && !targetsExisting && !sameTaskCreation;
    const nextTasks = new Map(source === "task" && mayStartNew ? [] : tasks);
    const result = source === "task" ? applyTaskTool(nextTasks, name, input, output, row.id) : extractPlanSnapshot(source, input);
    // An unresolved or redacted payload cannot clear a previously resolved structural plan.
    if (result.kind === "unresolved") continue;
    const steps = result.kind === "clear" ? [] : result.steps;
    const repeatsSnapshot = previous?.last.id === row.id && sameSteps(previous.steps, steps);
    const startsNew = !previous || previous.outcome === "completed" || crossesUserBoundary || allDone && !targetsExisting && !sameTaskCreation && !repeatsSnapshot;
    if (source === "task") tasksByGeneration.set(row.nativeGeneration, nextTasks);
    if (startsNew || !previous) {
      const session: PlanSession = { identity: JSON.stringify(["inline-plan", owner.sessionId, owner.generation.toString(), row.nativeGeneration.toString(), row.id, row.eventId]),
        source, nativeGeneration: row.nativeGeneration, boundarySequence: boundary, sourceEventIds: [row.eventId],
        sourceToolScopeKeys: [row.id], steps, last: row };
      sessions.push(session); previousBySource.set(previousKey, session);
    } else {
      previous.steps = steps; previous.last = row; previous.sourceEventIds.push(row.eventId);
      const previousScopeIndex = previous.sourceToolScopeKeys.indexOf(row.id);
      if (previousScopeIndex >= 0) previous.sourceToolScopeKeys.splice(previousScopeIndex, 1);
      previous.sourceToolScopeKeys.push(row.id);
      delete previous.outcome;
    }
  }
  const cards: MobileInlinePlan[] = [];
  for (const session of sessions) {
    if (session.steps.length === 0) continue;
    const completed = session.steps.filter((step) => step.state === "completed").length;
    const active = session.steps.find((step) => step.state === "inProgress") ?? session.steps.at(-1)!;
    cards.push({ identity: session.identity, sessionId: owner.sessionId, generation: owner.generation, nativeGeneration: session.nativeGeneration,
      source: session.source, eventId: session.last.eventId, sequence: session.last.sequence, runId: session.last.runId,
      sourceEventIds: session.sourceEventIds, sourceToolScopeKeys: session.sourceToolScopeKeys, steps: session.steps,
      completed, total: session.steps.length, activeContent: active.content,
      streaming: activeTail && session.nativeGeneration === owner.nativeGeneration
        && !terminalRuns.has(JSON.stringify([session.nativeGeneration.toString(), session.last.runId]))
        && session.last.sequence > (userBoundaries.get(session.nativeGeneration)?.sequence ?? -1n),
      sealed: session.outcome === "completed", ...(session.outcome ? { outcome: session.outcome } : {}) });
  }
  cards.sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : a.identity.localeCompare(b.identity));
  const byToolScopeKey = new Map<string, MobileInlinePlan[]>();
  for (const card of cards) {
    const scope = card.sourceToolScopeKeys.at(-1)!;
    const related = byToolScopeKey.get(scope) ?? [];
    related.push(card); byToolScopeKey.set(scope, related);
  }
  return { cards, byEventId: new Map(cards.map((card) => [card.eventId, card])), byToolScopeKey, sourceEventIds };
}

function planRows(events: readonly Event[], owner: MobilePlanOwner): readonly PlanRow[] {
  const ordered = [...new Map(events.map((event) => [event.eventId, event])).values()].filter((event) =>
    event.identity?.sessionId === owner.sessionId && event.cursor?.generation === owner.generation && event.identity.generation >= 1n)
    .sort((a, b) => a.cursor!.sequence < b.cursor!.sequence ? -1 : a.cursor!.sequence > b.cursor!.sequence ? 1 : a.eventId.localeCompare(b.eventId));
  const rows: PlanRow[] = [];
  const tools = new Map<string, MobileToolCallView>();
  const acceptedMessages = new Set<string>();
  for (const event of ordered) {
    const kind = event.payload?.kind; const identity = event.identity!;
    const base = { eventId: event.eventId, sequence: event.cursor!.sequence, nativeGeneration: identity.generation, runId: identity.runId };
    if (kind?.case === "messageStarted" && kind.value.role === MessageRole.USER && kind.value.userInputAccepted
      && !kind.value.automaticContinuation && !kind.value.automationOrigin && !kind.value.runtimeRecoveryId) {
      const key = JSON.stringify(["user", identity.generation.toString(), kind.value.messageId]);
      if (acceptedMessages.has(key)) continue;
      acceptedMessages.add(key); rows.push({ ...base, id: event.eventId, user: true });
    } else if (kind?.case === "runDone" || kind?.case === "runAborted" || kind?.case === "terminalError") {
      const runId = kind.case === "terminalError" ? identity.runId : kind.value.runId;
      if (!runId || identity.runId && identity.runId !== runId) continue;
      rows.push({ ...base, runId, id: event.eventId, outcome: kind.case === "runDone" ? "completed" : kind.case === "runAborted" ? "aborted" : "failed" });
    } else if (kind?.case === "toolCallStarted" || kind?.case === "toolCallUpdated" || kind?.case === "toolCallCompleted") {
      const key = mobileToolCallScopeKey(event);
      if (!key) continue;
      const previous = tools.get(key);
      const tool = projectMobileToolCall(event, previous);
      if (!tool || previous === tool) continue;
      tools.set(key, tool);
      rows.push({ ...base, runId: kind.value.toolCall!.runId, id: key, tool });
    }
  }
  return rows;
}

function sameSteps(left: readonly MobilePlanStep[], right: readonly MobilePlanStep[]): boolean {
  return left.length === right.length && left.every((step, index) => step.id === right[index]?.id
    && step.content === right[index]?.content && step.state === right[index]?.state && step.activeForm === right[index]?.activeForm);
}

function planToolSource(name: string): MobileInlinePlan["source"] | undefined {
  return name === "todowrite" || name === "todo_write" ? "todo" : name === "update_plan" || name === "updateplan" ? "updatePlan"
    : taskToolNames.has(name) ? "task" : undefined;
}
function extractPlanSnapshot(source: "todo" | "updatePlan", input: unknown): ProjectionResult {
  const record = asRecord(input);
  if (!record) return { kind: "unresolved" };
  const structured = source === "todo" ? record.todos : Array.isArray(record.items) ? record.items : Array.isArray(record.plan) ? record.plan : record.steps;
  if (Array.isArray(structured)) {
    if (!structured.length) return { kind: "clear" };
    const steps = structuredSteps(structured);
    return steps.length ? { kind: "snapshot", steps } : { kind: "unresolved" };
  }
  if (source === "todo" || typeof record.text !== "string") return { kind: "unresolved" };
  if (!record.text.trim()) return { kind: "clear" };
  const lines = record.text.split(/\r?\n/u).map((line) => normalizedText(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, "").replace(/^\s*\[[ xX-]\]\s+/u, "")))
    .filter((line): line is string => line !== undefined);
  return lines.length ? { kind: "snapshot", steps: lines.map((content, index) => ({ id: `line:${index}:${content}`, content,
    state: index === 0 ? "inProgress" : "pending" })) } : { kind: "unresolved" };
}
function taskToolTargetsExisting(tasks: ReadonlyMap<string, MobilePlanStep>, name: string, input: unknown, output: unknown): boolean {
  if (name !== "taskupdate" && name !== "taskget") return false;
  const id = taskId(asRecord(input)) ?? taskId(taskRecords(output)[0]);
  return id !== undefined && tasks.has(id);
}
function applyTaskTool(tasks: Map<string, MobilePlanStep>, name: string, input: unknown, output: unknown, fallbackId: string): ProjectionResult {
  const inputRecord = asRecord(input) ?? {}; const records = taskRecords(output);
  if (name === "tasklist") {
    if (!hasTaskListSnapshot(output) && !records.length) return { kind: "unresolved" };
    const previous = new Map(tasks); tasks.clear();
    for (const record of records) {
      const id = taskId(record); if (!id || isDeletedState(record.status ?? record.state)) continue;
      const content = taskContent(record) ?? previous.get(id)?.content; if (!content) continue;
      tasks.set(id, { id, content, state: normalizedState(record.status ?? record.state), ...activeForm(record) });
    }
    return tasks.size ? { kind: "snapshot", steps: [...tasks.values()] } : { kind: "clear" };
  }
  const result = records[0];
  if (name === "taskcreate") {
    const content = taskContent(inputRecord) ?? taskContent(result); if (!content) return { kind: "unresolved" };
    const id = taskId(result) ?? taskId(inputRecord) ?? fallbackId;
    if (!tasks.has(id) && !tasks.has(fallbackId) && [...tasks.values()].every((step) => step.state === "completed")) tasks.clear();
    if (id !== fallbackId) tasks.delete(fallbackId);
    tasks.set(id, { id, content, state: normalizedState(result?.status ?? result?.state ?? inputRecord.status ?? inputRecord.state),
      ...activeForm(inputRecord), ...activeForm(result) });
    return { kind: "snapshot", steps: [...tasks.values()] };
  }
  const id = taskId(inputRecord) ?? taskId(result);
  if (!id || !tasks.has(id) && !result) return { kind: "unresolved" };
  if (isDeletedState(inputRecord.status ?? inputRecord.state ?? result?.status ?? result?.state)) {
    tasks.delete(id); return tasks.size ? { kind: "snapshot", steps: [...tasks.values()] } : { kind: "clear" };
  }
  const previous = tasks.get(id); const content = taskContent(inputRecord) ?? taskContent(result) ?? previous?.content;
  if (!content) return { kind: "unresolved" };
  tasks.set(id, { id, content, state: normalizedState(inputRecord.status ?? inputRecord.state ?? result?.status ?? result?.state ?? previous?.state),
    ...(previous?.activeForm ? { activeForm: previous.activeForm } : {}), ...activeForm(inputRecord), ...activeForm(result) });
  return { kind: "snapshot", steps: [...tasks.values()] };
}
function structuredSteps(values: readonly unknown[]): readonly MobilePlanStep[] {
  const steps: MobilePlanStep[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const record = asRecord(values[index]); if (!record) continue;
    const content = normalizedText(record.content ?? record.text ?? record.step ?? record.title ?? record.subject); if (!content) continue;
    steps.push({ id: normalizedText(record.id ?? record.step_id ?? record.stepId) ?? `step:${index}:${content}`, content,
      state: normalizedState(record.status ?? record.state), ...activeForm(record) });
  }
  return steps;
}
function activeForm(record: Record<string, unknown> | undefined): { readonly activeForm?: string } {
  const value = normalizedText(record?.activeForm ?? record?.active_form); return value ? { activeForm: value } : {};
}
function normalizedState(value: unknown): MobilePlanStepState {
  return value === "completed" || value === "complete" || value === "done" || value === "skipped" ? "completed"
    : value === "in_progress" || value === "inProgress" || value === "running" || value === "active" ? "inProgress" : "pending";
}
function isDeletedState(value: unknown): boolean { return value === "deleted" || value === "removed" || value === "cancelled"; }
function taskId(value: Record<string, unknown> | undefined): string | undefined { return normalizedText(value?.taskId ?? value?.task_id ?? value?.id); }
function taskContent(value: Record<string, unknown> | undefined): string | undefined { return normalizedText(value?.subject ?? value?.title ?? value?.content ?? value?.description); }
function taskRecords(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(asRecord).filter((record): record is Record<string, unknown> => record !== undefined);
  const record = asRecord(value); if (!record) return [];
  for (const key of ["tasks", "items", "data", "result"]) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested.map(asRecord).filter((item): item is Record<string, unknown> => item !== undefined);
    const item = asRecord(nested); if (item && taskId(item)) return [item];
  }
  return taskId(record) ? [record] : [];
}
function hasTaskListSnapshot(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  const record = asRecord(value); return !!record && ["tasks", "items", "data", "result"].some((key) => Array.isArray(record[key]));
}
function parseDisplayedToolValue(value: string): unknown { const trimmed = value.trim(); return parseJsonLike(trimmed.startsWith("$:") ? trimmed.slice(2).trim() : trimmed); }
function parseJsonLike(value: string): unknown {
  const trimmed = value.trim(); if (!trimmed || trimmed.length > maximumJsonCharacters) return undefined;
  const candidates = [trimmed]; const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)?.[1]; if (fence) candidates.push(fence);
  const arrayStart = trimmed.indexOf("["); const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(trimmed.slice(arrayStart, arrayEnd + 1));
  const objectStart = trimmed.indexOf("{"); const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  for (const candidate of new Set(candidates)) { try { return JSON.parse(candidate) as unknown; } catch { /* Try the next bounded JSON candidate. */ } }
  return undefined;
}
function normalizedText(value: unknown): string | undefined { const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : ""; return text || undefined; }
function asRecord(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
