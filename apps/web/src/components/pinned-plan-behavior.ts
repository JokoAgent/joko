import type { TimelineItemView, TimelinePlanView } from "../model.js";

export type PinnedPlanStepState = "pending" | "inProgress" | "completed";

export interface PinnedPlanStep {
  readonly id: string;
  readonly content: string;
  readonly state: PinnedPlanStepState;
}

export interface PinnedPlanProjection {
  readonly identity: string;
  readonly sourceItemId: string;
  readonly source: "todo" | "updatePlan" | "task";
  readonly runId?: string;
  readonly steps: readonly PinnedPlanStep[];
  readonly updatedAt: number;
  readonly allCompleted: boolean;
  readonly terminalOutcome?: "completed" | "aborted" | "failed";
  readonly terminalAt?: number;
}

export interface PinnedPlanRetirement {
  readonly retired: boolean;
  readonly authoritative: boolean;
  readonly anchorAt?: number;
}

type ProjectionResult =
  | { readonly kind: "snapshot"; readonly steps: readonly PinnedPlanStep[]; readonly source: PinnedPlanProjection["source"] }
  | { readonly kind: "clear" }
  | { readonly kind: "unresolved" };

const MAX_JSON_TEXT = 256 * 1_024;
const TASK_TOOL_NAMES = new Set(["taskcreate", "taskupdate", "taskget", "tasklist"]);

interface MutableInlinePlanSession {
  readonly identity: string;
  readonly source: PinnedPlanProjection["source"];
  readonly sourceItemIds: string[];
  readonly boundarySequence: bigint;
  steps: readonly PinnedPlanStep[];
  lastItemId: string;
  runId?: string;
  terminalOutcome?: "completed" | "aborted" | "failed";
}

/**
 * Derive the latest plan exclusively from durable timeline tool state. The
 * projection is backend-neutral: it recognizes public tool payload shapes and
 * never branches on a backend identity.
 */
export function projectPinnedPlan(items: readonly TimelineItemView[]): PinnedPlanProjection | undefined {
  const ordered = [...items].sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence < right.sequence ? -1 : 1;
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
    return left.id.localeCompare(right.id);
  });
  const tasks = new Map<string, PinnedPlanStep>();
  let taskBoundaryRunId: string | undefined;
  let latest: PinnedPlanProjection | undefined;

  for (const item of ordered) {
    if (
      item.kind === "user" &&
      latest?.runId !== undefined &&
      item.runId !== undefined &&
      item.runId !== latest.runId
    ) {
      // A real later user run owns the bottom of the conversation. Steering
      // remains in the same run, so it does not retire the current plan.
      latest = undefined;
    }

    if (
      item.runTerminal !== undefined &&
      item.runId !== undefined &&
      latest?.source === "updatePlan" &&
      latest.runId === item.runId
    ) {
      latest = {
        ...latest,
        terminalOutcome: item.runTerminal,
        terminalAt: item.createdAt
      };
    }

    const tool = item.tool;
    if (tool === undefined) continue;
    const toolName = normalizedToolName(tool.name);
    const source = planToolSource(toolName);
    if (source === undefined) continue;

    const input = parseDisplayedToolValue(tool.input);
    const output = parseJsonLike(tool.output);
    if (source === "task") {
      const targetsExistingTask = taskToolTargetsExistingTask(tasks, toolName, input, output);
      const crossesUserRun = taskBoundaryRunId !== undefined && item.runId !== undefined && item.runId !== taskBoundaryRunId;
      const previousAllDone = tasks.size > 0 && [...tasks.values()].every((step) => step.state === "completed");
      const startsNewTaskSession = tasks.size === 0 ||
        (crossesUserRun && !targetsExistingTask) || (previousAllDone && !targetsExistingTask);
      if (startsNewTaskSession) {
        tasks.clear();
        taskBoundaryRunId = item.runId;
      }
    }
    const result = source === "task"
      ? applyTaskTool(tasks, toolName, input, output, item.id)
      : extractPlanSnapshot(source, input);

    if (result.kind !== "snapshot") {
      // The latest recognized plan event owns the projection. An explicit
      // clear or an unresolved partial history must not revive an older plan.
      latest = undefined;
      continue;
    }
    const steps = result.steps;
    if (steps.length === 0) {
      latest = undefined;
      continue;
    }
    latest = {
      identity: `${item.id}:${item.sequence.toString()}:${snapshotSignature(steps)}`,
      sourceItemId: item.id,
      source: result.source,
      ...(item.runId === undefined ? {} : { runId: item.runId }),
      steps,
      updatedAt: item.createdAt,
      allCompleted: steps.every((step) => step.state === "completed")
    };
  }

  return latest;
}

/**
 * Replace raw plan tools with historical inline plan cards. Updates in
 * one source/turn collapse into the latest row while completed, sealed, or
 * user-superseded sessions remain as independent historical cards.
 */
export function projectInlinePlanTimeline(items: readonly TimelineItemView[]): readonly TimelineItemView[] {
  const ordered = orderedTimeline(items);
  const recognizedItemIds = new Set<string>();
  const sessions: MutableInlinePlanSession[] = [];
  const lastSessionBySource = new Map<PinnedPlanProjection["source"], MutableInlinePlanSession>();
  const tasks = new Map<string, PinnedPlanStep>();
  let lastUserBoundarySequence = -1n;
  let lastUserRunId: string | undefined;

  for (const item of ordered) {
    if (item.kind === "user") {
      if (item.runId === undefined || item.runId !== lastUserRunId) {
        lastUserBoundarySequence = item.sequence;
        lastUserRunId = item.runId;
      }
      continue;
    }

    if (item.runTerminal !== undefined && item.runId !== undefined) {
      const codex = lastSessionBySource.get("updatePlan");
      if (codex?.runId === item.runId) codex.terminalOutcome = item.runTerminal;
      continue;
    }

    const tool = item.tool;
    if (tool === undefined) continue;
    const toolName = normalizedToolName(tool.name);
    const source = planToolSource(toolName);
    if (source === undefined) continue;
    recognizedItemIds.add(item.id);

    const input = parseDisplayedToolValue(tool.input);
    const output = parseJsonLike(tool.output);
    const previous = lastSessionBySource.get(source);
    const targetsExistingTask = source === "task" && taskToolTargetsExistingTask(tasks, toolName, input, output);
    const previousAllDone = previous !== undefined && previous.steps.every((step) => step.state === "completed");
    const continuesCompletedTaskSession = source === "task" && previousAllDone && targetsExistingTask;
    const crossesUserBoundary = previous !== undefined &&
      lastUserBoundarySequence > previous.boundarySequence &&
      !(source === "task" && targetsExistingTask);
    const startsNewSession = previous === undefined ||
      previous.terminalOutcome === "completed" ||
      crossesUserBoundary ||
      (previousAllDone && !continuesCompletedTaskSession);

    if (source === "task" && startsNewSession) tasks.clear();
    const result = source === "task"
      ? applyTaskTool(tasks, toolName, input, output, item.id)
      : extractPlanSnapshot(source, input);
    if (result.kind === "unresolved") continue;
    const steps = result.kind === "clear" ? [] : result.steps;

    if (startsNewSession || previous === undefined) {
      const session: MutableInlinePlanSession = {
        identity: `inline-plan:${item.id}`,
        source,
        sourceItemIds: [item.id],
        boundarySequence: lastUserBoundarySequence,
        steps,
        lastItemId: item.id,
        ...(item.runId === undefined ? {} : { runId: item.runId })
      };
      sessions.push(session);
      lastSessionBySource.set(source, session);
    } else {
      previous.steps = steps;
      previous.sourceItemIds.push(item.id);
      previous.lastItemId = item.id;
      if (item.runId === undefined) delete previous.runId;
      else previous.runId = item.runId;
      delete previous.terminalOutcome;
    }
  }

  const inlineByLastItemId = new Map<string, TimelinePlanView>();
  for (const session of sessions) {
    if (session.steps.length === 0) continue;
    inlineByLastItemId.set(session.lastItemId, {
      identity: session.identity,
      source: session.source,
      sourceItemIds: session.sourceItemIds.slice(),
      steps: session.steps
    });
  }

  return items.flatMap((item): TimelineItemView[] => {
    if (!recognizedItemIds.has(item.id)) return [item];
    const inlinePlan = inlineByLastItemId.get(item.id);
    return inlinePlan === undefined ? [] : [{ ...item, inlinePlan }];
  });
}

function taskToolTargetsExistingTask(
  tasks: ReadonlyMap<string, PinnedPlanStep>,
  toolName: string,
  input: unknown,
  output: unknown
): boolean {
  if (toolName !== "taskupdate" && toolName !== "taskget") return false;
  const id = taskId(asRecord(input)) ?? taskId(taskRecords(output)[0]);
  return id !== undefined && tasks.has(id);
}

/** Retirement semantics: success seals any plan; failure/abort keeps it. */
export function pinnedPlanRetirement(projection: PinnedPlanProjection, running: boolean): PinnedPlanRetirement {
  if (projection.terminalOutcome === "completed") {
    return {
      retired: true,
      authoritative: true,
      ...(projection.terminalAt === undefined ? {} : { anchorAt: projection.terminalAt })
    };
  }
  if (projection.terminalOutcome === "failed" || projection.terminalOutcome === "aborted") {
    return { retired: false, authoritative: true };
  }
  if (projection.allCompleted && !running) {
    return { retired: true, authoritative: false, anchorAt: projection.updatedAt };
  }
  return { retired: false, authoritative: false };
}

export function pinnedPlanStepPosition(steps: readonly PinnedPlanStep[]): { readonly current: number; readonly total: number } {
  const total = steps.length;
  if (total === 0) return { current: 0, total: 0 };
  const active = steps.findIndex((step) => step.state === "inProgress");
  const pending = steps.findIndex((step) => step.state === "pending");
  const current = active >= 0 ? active + 1 : pending >= 0 ? pending + 1 : total;
  return { current, total };
}

function planToolSource(toolName: string): PinnedPlanProjection["source"] | undefined {
  if (toolName === "todowrite" || toolName === "todo_write") return "todo";
  if (toolName === "update_plan" || toolName === "updateplan") return "updatePlan";
  return TASK_TOOL_NAMES.has(toolName) ? "task" : undefined;
}

function extractPlanSnapshot(source: "todo" | "updatePlan", input: unknown): ProjectionResult {
  const record = asRecord(input);
  if (record === undefined) return { kind: "unresolved" };
  if (source === "todo") {
    if (!Array.isArray(record.todos)) return { kind: "unresolved" };
    if (record.todos.length === 0) return { kind: "clear" };
    const steps = structuredSteps(record.todos);
    return steps.length === 0 ? { kind: "unresolved" } : { kind: "snapshot", source, steps };
  }

  const structured = Array.isArray(record.items)
    ? record.items
    : Array.isArray(record.plan)
      ? record.plan
      : Array.isArray(record.steps)
        ? record.steps
        : undefined;
  if (structured !== undefined) {
    if (structured.length === 0) return { kind: "clear" };
    const steps = structuredSteps(structured);
    return steps.length === 0 ? { kind: "unresolved" } : { kind: "snapshot", source, steps };
  }
  if (typeof record.text !== "string") return { kind: "unresolved" };
  if (record.text.trim() === "") return { kind: "clear" };
  const lines = record.text.split(/\r?\n/u)
    .map((line) => normalizedText(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, "").replace(/^\s*\[[ xX-]\]\s+/u, "")))
    .filter((line): line is string => line !== undefined);
  if (lines.length === 0) return { kind: "unresolved" };
  return {
    kind: "snapshot",
    source,
    steps: lines.map((content, index) => ({
      id: `line:${index}:${content}`,
      content,
      state: index === 0 ? "inProgress" : "pending"
    }))
  };
}

function applyTaskTool(
  tasks: Map<string, PinnedPlanStep>,
  toolName: string,
  input: unknown,
  output: unknown,
  fallbackId: string
): ProjectionResult {
  const inputRecord = asRecord(input) ?? {};
  const resultTasks = taskRecords(output);

  if (toolName === "tasklist") {
    if (!hasTaskListSnapshot(output) && resultTasks.length === 0) return { kind: "unresolved" };
    const previous = new Map(tasks);
    tasks.clear();
    for (const record of resultTasks) {
      const id = taskId(record);
      if (id === undefined) continue;
      const state = normalizedState(record.status ?? record.state);
      if (isDeletedState(record.status ?? record.state)) continue;
      const content = taskContent(record) ?? previous.get(id)?.content;
      if (content === undefined) continue;
      tasks.set(id, { id, content, state });
    }
    return tasks.size === 0
      ? { kind: "clear" }
      : { kind: "snapshot", source: "task", steps: [...tasks.values()] };
  }

  const resultTask = resultTasks[0];
  if (toolName === "taskcreate") {
    if ([...tasks.values()].every((step) => step.state === "completed")) tasks.clear();
    const id = taskId(resultTask) ?? taskId(inputRecord) ?? fallbackId;
    const content = taskContent(inputRecord) ?? taskContent(resultTask);
    if (content === undefined) return { kind: "unresolved" };
    tasks.set(id, {
      id,
      content,
      state: normalizedState(resultTask?.status ?? resultTask?.state ?? inputRecord.status ?? inputRecord.state)
    });
    return { kind: "snapshot", source: "task", steps: [...tasks.values()] };
  }

  const id = taskId(inputRecord) ?? taskId(resultTask);
  if (id === undefined || (!tasks.has(id) && resultTask === undefined)) return { kind: "unresolved" };
  if (isDeletedState(inputRecord.status ?? inputRecord.state ?? resultTask?.status ?? resultTask?.state)) {
    tasks.delete(id);
    return tasks.size === 0
      ? { kind: "clear" }
      : { kind: "snapshot", source: "task", steps: [...tasks.values()] };
  }
  const previous = tasks.get(id);
  const content = taskContent(inputRecord) ?? taskContent(resultTask) ?? previous?.content;
  if (content === undefined) return { kind: "unresolved" };
  tasks.set(id, {
    id,
    content,
    state: normalizedState(inputRecord.status ?? inputRecord.state ?? resultTask?.status ?? resultTask?.state ?? previous?.state)
  });
  return { kind: "snapshot", source: "task", steps: [...tasks.values()] };
}

function structuredSteps(values: readonly unknown[]): readonly PinnedPlanStep[] {
  const steps: PinnedPlanStep[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const record = asRecord(values[index]);
    if (record === undefined) continue;
    const content = normalizedText(record.content ?? record.text ?? record.step ?? record.title ?? record.subject);
    if (content === undefined) continue;
    steps.push({
      id: normalizedText(record.id ?? record.step_id ?? record.stepId) ?? `step:${index}:${content}`,
      content,
      state: normalizedState(record.status ?? record.state)
    });
  }
  return steps;
}

function normalizedState(value: unknown): PinnedPlanStepState {
  if (value === "completed" || value === "complete" || value === "done" || value === "skipped") return "completed";
  if (value === "in_progress" || value === "inProgress" || value === "running" || value === "active") return "inProgress";
  return "pending";
}

function isDeletedState(value: unknown): boolean {
  return value === "deleted" || value === "removed" || value === "cancelled";
}

function taskId(value: Record<string, unknown> | undefined): string | undefined {
  if (value === undefined) return undefined;
  return normalizedText(value.taskId ?? value.task_id ?? value.id);
}

function taskContent(value: Record<string, unknown> | undefined): string | undefined {
  if (value === undefined) return undefined;
  return normalizedText(value.subject ?? value.title ?? value.content ?? value.description);
}

function taskRecords(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(asRecord).filter((record): record is Record<string, unknown> => record !== undefined);
  const record = asRecord(value);
  if (record === undefined) return [];
  for (const key of ["tasks", "items", "data", "result"] as const) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested.map(asRecord).filter((item): item is Record<string, unknown> => item !== undefined);
    const nestedRecord = asRecord(nested);
    if (nestedRecord !== undefined && taskId(nestedRecord) !== undefined) return [nestedRecord];
  }
  return taskId(record) !== undefined ? [record] : [];
}

function hasTaskListSnapshot(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  const record = asRecord(value);
  return record !== undefined && ["tasks", "items", "data", "result"].some((key) => Array.isArray(record[key]));
}

function parseDisplayedToolValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const raw = trimmed.startsWith("$:") ? trimmed.slice(2).trim() : trimmed;
  return parseJsonLike(raw);
}

function parseJsonLike(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_JSON_TEXT) return undefined;
  for (const candidate of jsonCandidates(trimmed)) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next bounded, deterministic JSON candidate.
    }
  }
  return undefined;
}

function jsonCandidates(value: string): readonly string[] {
  const candidates = [value];
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(value)?.[1];
  if (fence !== undefined) candidates.push(fence);
  const arrayStart = value.indexOf("[");
  const arrayEnd = value.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(value.slice(arrayStart, arrayEnd + 1));
  const objectStart = value.indexOf("{");
  const objectEnd = value.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(value.slice(objectStart, objectEnd + 1));
  return [...new Set(candidates)];
}

function normalizedToolName(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s-]+/gu, "_");
}

function normalizedText(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  if (text === "") return undefined;
  return text;
}

function snapshotSignature(steps: readonly PinnedPlanStep[]): string {
  let hash = 2_166_136_261;
  for (const step of steps) {
    for (const character of `${step.id}\u0000${step.state}\u0000${step.content}\u0001`) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16_777_619);
    }
  }
  return `${steps.length}:${(hash >>> 0).toString(36)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function orderedTimeline(items: readonly TimelineItemView[]): TimelineItemView[] {
  return [...items].sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence < right.sequence ? -1 : 1;
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
    return left.id.localeCompare(right.id);
  });
}
