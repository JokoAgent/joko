import type { EventPayload, PublicError, UsageSnapshot } from "@joko/core";

export const JOKO_SUBAGENT_ACTIVITY_MARKER = "__jokoSubagentActivity";

export type PiSubagentActivityState =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "aborted";

export interface PiSubagentActivity {
  readonly taskId: string;
  readonly parentTaskId?: string;
  readonly agentName: string;
  readonly state: PiSubagentActivityState;
  readonly summary?: string;
  readonly task?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly background: boolean;
  readonly timeoutMs?: number;
  readonly toolUses?: number;
  readonly progressRatio?: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly error?: PublicError;
  /** Cumulative delegated usage for this task, never a secret-bearing raw provider object. */
  readonly usage?: UsageSnapshot;
}

export interface ProjectedPiSubagentActivity {
  readonly activity: PiSubagentActivity;
  readonly event: Extract<EventPayload, { readonly type: "background_task" }>;
}

/**
 * Parses only the host marker emitted by the managed Joko extension. Native Pi
 * tool details and arbitrary project extensions cannot impersonate background
 * activity without the exact, numeric marker and bounded typed fields.
 */
export function projectPiSubagentActivity(value: unknown): ProjectedPiSubagentActivity | undefined {
  const details = activityDetails(value);
  if (details === undefined || details[JOKO_SUBAGENT_ACTIVITY_MARKER] !== 1) return undefined;
  const taskId = boundedRequiredString(details["taskId"], 256);
  const agentName = boundedRequiredString(details["agentName"], 128);
  if (taskId === undefined || agentName === undefined) return undefined;
  const state = activityState(details["status"]);
  if (state === undefined) return undefined;
  const summary = boundedOptionalString(details["summary"], 2_048);
  const task = boundedOptionalString(details["task"], 2_048);
  const model = boundedOptionalString(details["model"], 256);
  const effort = boundedOptionalString(details["effort"], 32);
  const parentTaskId = boundedOptionalString(details["parentTaskId"], 256);
  const timeoutMs = boundedInteger(details["timeoutMs"], 1, 60 * 60 * 1_000);
  const toolUses = boundedInteger(details["toolUses"], 0, Number.MAX_SAFE_INTEGER);
  const progressRatio = boundedNumber(details["progressRatio"], 0, 1);
  const startedAt = boundedInteger(details["startedAt"], 0, Number.MAX_SAFE_INTEGER);
  const endedAt = boundedInteger(details["endedAt"], 0, Number.MAX_SAFE_INTEGER);
  if (state === "running" && startedAt === undefined) return undefined;
  if (isTerminalState(state) && endedAt === undefined) return undefined;
  if (startedAt !== undefined && endedAt !== undefined && endedAt < startedAt) return undefined;
  const error = publicError(details["error"]);
  const usage = usageSnapshot(details["usage"]);
  const activity: PiSubagentActivity = {
    taskId,
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
    agentName,
    state,
    ...(summary === undefined ? {} : { summary }),
    ...(task === undefined ? {} : { task }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    background: details["background"] === true,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(toolUses === undefined ? {} : { toolUses }),
    ...(progressRatio === undefined ? {} : { progressRatio }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(error === undefined ? {} : { error }),
    ...(usage === undefined ? {} : { usage })
  };
  const detail = [
    summary,
    model === undefined ? undefined : `model ${model}`,
    effort === undefined ? undefined : `effort ${effort}`,
    toolUses === undefined ? undefined : `${toolUses} tool calls`
  ].filter((entry): entry is string => entry !== undefined).join(" · ");
  return {
    activity,
    event: {
      type: "background_task",
      taskId,
      ...(parentTaskId === undefined ? {} : { parentTaskId }),
      title: `${agentName} subagent`,
      state,
      ...(detail === "" ? {} : { detail }),
      ...(progressRatio === undefined ? {} : { progressRatio }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(endedAt === undefined ? {} : { endedAt }),
      ...(error === undefined ? {} : { error })
    }
  };
}

function activityDetails(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value["details"])) return value["details"];
  return value;
}

function activityState(value: unknown): PiSubagentActivityState | undefined {
  if (value === "queued" || value === "running" || value === "waiting" || value === "completed" || value === "failed" || value === "aborted") {
    return value;
  }
  if (value === "stopped" || value === "cancelled" || value === "timeout" || value === "timed_out") return "aborted";
  return undefined;
}

function isTerminalState(value: PiSubagentActivityState): boolean {
  return value === "completed" || value === "failed" || value === "aborted";
}

function publicError(value: unknown): PublicError | undefined {
  if (!isRecord(value)) return undefined;
  const code = boundedRequiredString(value["code"], 128);
  const message = boundedRequiredString(value["message"], 2_048);
  const phase = boundedRequiredString(value["phase"], 128);
  const recovery = boundedRequiredString(value["recovery"], 2_048);
  if (
    code === undefined ||
    message === undefined ||
    phase === undefined ||
    recovery === undefined ||
    typeof value["retryable"] !== "boolean" ||
    typeof value["stateMayHaveChanged"] !== "boolean"
  ) return undefined;
  return {
    code,
    message,
    phase,
    retryable: value["retryable"],
    stateMayHaveChanged: value["stateMayHaveChanged"],
    recovery
  };
}

function usageSnapshot(value: unknown): UsageSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = boundedInteger(value["input"], 0, Number.MAX_SAFE_INTEGER) ?? 0;
  const outputTokens = boundedInteger(value["output"], 0, Number.MAX_SAFE_INTEGER) ?? 0;
  const cacheReadTokens = boundedInteger(value["cacheRead"], 0, Number.MAX_SAFE_INTEGER) ?? 0;
  const cacheWriteTokens = boundedInteger(value["cacheWrite"], 0, Number.MAX_SAFE_INTEGER) ?? 0;
  const totalTokens = boundedInteger(
    value["totalTokens"],
    0,
    Number.MAX_SAFE_INTEGER
  ) ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const cost = boundedNumber(value["cost"], 0, Number.MAX_VALUE) ?? 0;
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0 && cost === 0) return undefined;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, cost };
}

function boundedRequiredString(value: unknown, maxLength: number): string | undefined {
  const text = boundedOptionalString(value, maxLength);
  return text === undefined || text === "" ? undefined : text;
}

function boundedOptionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text === "") return undefined;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
