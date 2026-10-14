import type { Client } from "@connectrpc/connect";
import { ObjectiveLifecycleAction, ObjectiveStatus, type Objective, type ObjectiveService, type ObjectiveLifecycleEvent } from "@joko/contracts";

export type MobileObjectiveStatus = "active" | "paused" | "blocked" | "complete" | "budgetLimited" | "usageLimited" | "dispatchUnknown";
export interface MobileObjectiveLimits {
  readonly maximumTurns: number | null;
  readonly tokenBudget: number | null;
  readonly noProgressTurnLimit: number | null;
}
export interface MobileObjectiveInput {
  readonly text: string;
  readonly limits?: MobileObjectiveLimits;
}
export interface MobileObjective extends MobileObjectiveLimits {
  readonly sessionId: string;
  readonly text: string;
  readonly status: MobileObjectiveStatus;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly lastReason: string;
  readonly revision: bigint;
  readonly ownerGeneration: bigint;
  readonly sessionGeneration: bigint;
  readonly usageResetAt?: number;
}
export interface MobileObjectiveApi {
  readonly ownerKey: string;
  readonly sessionId: string;
  readonly generation: bigint;
  readonly writable: boolean;
  get(signal: AbortSignal): Promise<MobileObjective | undefined>;
  watch(signal: AbortSignal): AsyncIterable<MobileObjective | undefined>;
  restore(signal: AbortSignal): Promise<MobileObjectiveInput | undefined>;
  set(input: MobileObjectiveInput, signal: AbortSignal): Promise<MobileObjective>;
  pause(value: MobileObjective, signal: AbortSignal): Promise<MobileObjective>;
  resume(value: MobileObjective, signal: AbortSignal): Promise<MobileObjective>;
  clear(value: MobileObjective, signal: AbortSignal): Promise<void>;
}
export interface MobileObjectiveRpc {
  get(signal: AbortSignal): Promise<MobileObjective | undefined>;
  watch(signal: AbortSignal): AsyncIterable<MobileObjective | undefined>;
  set(input: MobileObjectiveInput, requestId: string, signal: AbortSignal): Promise<MobileObjective>;
  pause(value: MobileObjective, requestId: string, signal: AbortSignal): Promise<MobileObjective>;
  resume(value: MobileObjective, requestId: string, signal: AbortSignal): Promise<MobileObjective>;
  clear(value: MobileObjective, requestId: string, signal: AbortSignal): Promise<void>;
}

export const mobileObjectiveDefaultLimits: MobileObjectiveLimits = { maximumTurns: null, tokenBudget: null, noProgressTurnLimit: 3 };
export const mobileObjectivePresets = { maximumTurns: [10, 20, 50, 100], tokenBudget: [500_000, 1_000_000, 2_000_000, 5_000_000], noProgressTurnLimit: [2, 3, 5] } as const;

export function normalizeMobileObjectiveInput(input: MobileObjectiveInput): MobileObjectiveInput {
  if (!input || typeof input.text !== "string" || input.text.includes("\0")) throw new Error("Enter a valid objective.");
  const text = input.text.trim();
  if (!text || [...text].length > 32_000) throw new Error("An objective must contain 1–32,000 characters.");
  if (input.limits === undefined) return { text };
  const limits = input.limits;
  return { text, limits: {
    maximumTurns: limit(limits.maximumTurns, 10_000),
    tokenBudget: limit(limits.tokenBudget, Number.MAX_SAFE_INTEGER),
    noProgressTurnLimit: limit(limits.noProgressTurnLimit, 1_000)
  } };
}

export function projectMobileObjective(value: Objective, sessionId: string, generation: bigint): MobileObjective {
  const revision = value.version?.revision?.value;
  const statuses: Partial<Record<ObjectiveStatus, MobileObjectiveStatus>> = {
    [ObjectiveStatus.ACTIVE]: "active", [ObjectiveStatus.PAUSED]: "paused", [ObjectiveStatus.BLOCKED]: "blocked",
    [ObjectiveStatus.COMPLETE]: "complete", [ObjectiveStatus.BUDGET_LIMITED]: "budgetLimited",
    [ObjectiveStatus.USAGE_LIMITED]: "usageLimited", [ObjectiveStatus.DISPATCH_UNKNOWN]: "dispatchUnknown"
  };
  const status = statuses[value.status];
  const text = normalizeMobileObjectiveInput({ text: value.text }).text;
  if (value.sessionId !== sessionId || value.sessionGeneration !== generation || !revision || revision < 1n
    || !positive(value.ownerGeneration) || !positive(value.sessionGeneration) || !status || text !== value.text
    || !unsigned(value.turnsUsed, 10_000) || !unsigned(value.noProgressTurns, 1_000)
    || value.lastReason !== value.lastReason.trim() || value.lastReason.includes("\0") || [...value.lastReason].length > 2_048
    || (value.pendingRunId === undefined) !== (value.pendingQueueItemId === undefined)
    || value.pendingRunId !== undefined && (!value.pendingRunId.trim() || !value.pendingQueueItemId?.trim())) {
    throw new Error("The Joko node returned an invalid objective.");
  }
  timestamp(value.startedAt);
  if (value.version?.generation !== value.ownerGeneration) throw new Error("The objective owner generation is invalid.");
  return { sessionId, text, status, revision, ownerGeneration: value.ownerGeneration, sessionGeneration: generation,
    maximumTurns: value.maximumTurns === undefined ? null : limit(value.maximumTurns, 10_000),
    tokenBudget: value.tokenBudget === undefined ? null : limit(safeNumber(value.tokenBudget), Number.MAX_SAFE_INTEGER),
    noProgressTurnLimit: value.noProgressTurnLimit === undefined ? null : limit(value.noProgressTurnLimit, 1_000),
    turnsUsed: value.turnsUsed, tokensUsed: safeNumber(value.tokensUsed), lastReason: value.lastReason,
    ...(value.usageResetAt === undefined ? {} : { usageResetAt: timestamp(value.usageResetAt) }) };
}

export function createMobileObjectiveRpc(rpc: Client<typeof ObjectiveService>, sessionId: string, generation: bigint,
  assertCurrent: (signal: AbortSignal) => void): MobileObjectiveRpc {
  const project = (value: Objective | undefined, signal: AbortSignal): MobileObjective | undefined => {
    assertCurrent(signal); return value === undefined ? undefined : projectMobileObjective(value, sessionId, generation);
  };
  const owner = (value: MobileObjective, signal: AbortSignal) => {
    assertCurrent(signal);
    if (value.sessionId !== sessionId || value.sessionGeneration !== generation || value.revision < 1n || !positive(value.ownerGeneration)) {
      throw new Error("The objective mutation owner changed.");
    }
    return { sessionId, expectedRevision: { value: value.revision }, expectedOwnerGeneration: value.ownerGeneration };
  };
  const mutation = (value: Objective | undefined, previous: MobileObjective | undefined, signal: AbortSignal): MobileObjective => {
    const next = project(value, signal);
    if (!next || previous && (next.revision <= previous.revision || next.ownerGeneration < previous.ownerGeneration)) {
      throw new Error("The Joko node returned an invalid objective mutation.");
    }
    return next;
  };
  return {
    async get(signal) { assertCurrent(signal); return project((await rpc.getObjective({ sessionId }, { signal })).objective, signal); },
    async *watch(signal) {
      assertCurrent(signal);
      for await (const response of rpc.watchObjective({ sessionId }, { signal })) {
        assertCurrent(signal);
        if (response.cleared === (response.objective !== undefined)) throw new Error("The objective stream returned an invalid update.");
        yield project(response.objective, signal);
      }
    },
    async set(input, requestId, signal) {
      assertCurrent(signal); const exact = normalizeMobileObjectiveInput(input), limits = exact.limits;
      const response = await rpc.setObjective({ requestId, sessionId, text: exact.text, expectedSessionGeneration: generation,
        ...(limits === undefined ? {} : { limits: {
          ...(limits.tokenBudget === null ? {} : { tokenBudget: BigInt(limits.tokenBudget) }),
          ...(limits.maximumTurns === null ? {} : { maximumTurns: limits.maximumTurns }),
          ...(limits.noProgressTurnLimit === null ? {} : { noProgressTurnLimit: limits.noProgressTurnLimit })
        } }) }, { signal });
      const next = mutation(response.objective, undefined, signal);
      if (next.text !== exact.text || limits !== undefined && (next.maximumTurns !== limits.maximumTurns
        || next.tokenBudget !== limits.tokenBudget || next.noProgressTurnLimit !== limits.noProgressTurnLimit)) {
        throw new Error("The Joko node returned a mismatched objective.");
      }
      return next;
    },
    async pause(value, requestId, signal) {
      const response = await rpc.pauseObjective({ ...owner(value, signal), requestId, reason: "" }, { signal });
      const next = mutation(response.objective, value, signal);
      if (next.status !== "paused") throw new Error("The objective pause could not be confirmed.");
      return next;
    },
    async resume(value, requestId, signal) {
      return mutation((await rpc.resumeObjective({ ...owner(value, signal), requestId }, { signal })).objective, value, signal);
    },
    async clear(value, requestId, signal) {
      const response = await rpc.clearObjective({ ...owner(value, signal), requestId }, { signal }); assertCurrent(signal);
      if (!response.cleared) throw new Error("The objective clear could not be confirmed.");
    }
  };
}

export function formatMobileObjectiveTokens(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}
export interface MobileObjectiveLifecycle {
  readonly status?: MobileObjectiveStatus;
  readonly text: string;
  readonly reason: string;
  readonly turns: number;
  readonly tokens: number;
}
export function projectMobileObjectiveLifecycle(value: ObjectiveLifecycleEvent): MobileObjectiveLifecycle | undefined {
  const states: Partial<Record<ObjectiveStatus, MobileObjectiveStatus>> = {
    [ObjectiveStatus.ACTIVE]: "active", [ObjectiveStatus.PAUSED]: "paused", [ObjectiveStatus.BLOCKED]: "blocked",
    [ObjectiveStatus.COMPLETE]: "complete", [ObjectiveStatus.BUDGET_LIMITED]: "budgetLimited", [ObjectiveStatus.USAGE_LIMITED]: "usageLimited",
    [ObjectiveStatus.DISPATCH_UNKNOWN]: "dispatchUnknown"
  };
  const status = states[value.status], action = value.action;
  const withText = action === ObjectiveLifecycleAction.STARTED || action === ObjectiveLifecycleAction.REPLACED;
  const matched = action === ObjectiveLifecycleAction.STARTED || action === ObjectiveLifecycleAction.RESUMED ? status === "active"
    : action === ObjectiveLifecycleAction.REPLACED ? status !== undefined
    : action === ObjectiveLifecycleAction.PAUSED ? status === "paused" : action === ObjectiveLifecycleAction.COMPLETED ? status === "complete"
    : action === ObjectiveLifecycleAction.BLOCKED ? status === "blocked" : action === ObjectiveLifecycleAction.LIMITED ? status === "budgetLimited" || status === "usageLimited"
    : action === ObjectiveLifecycleAction.DISPATCH_UNKNOWN ? status === "dispatchUnknown"
    : action === ObjectiveLifecycleAction.CLEARED && value.status === ObjectiveStatus.UNSPECIFIED;
  if (!matched || !positive(value.ownerGeneration) || !unsigned(value.turnsUsed, 10_000)
    || value.tokensUsed < 0n || value.tokensUsed > BigInt(Number.MAX_SAFE_INTEGER)
    || value.elapsedMs < 0n || value.elapsedMs > BigInt(Number.MAX_SAFE_INTEGER)
    || value.reason !== value.reason.trim() || value.reason.includes("\0") || [...value.reason].length > 2_048
    || (withText ? !value.objectiveText.trim() || value.objectiveText !== value.objectiveText.trim()
      || value.objectiveText.includes("\0") || [...value.objectiveText].length > 32_000 : value.objectiveText !== "")) return undefined;
  return { ...(status === undefined ? {} : { status }), text: value.objectiveText, reason: value.reason,
    turns: value.turnsUsed, tokens: Number(value.tokensUsed) };
}
/** Strip only a complete trailing verdict; raw Events remain unchanged. */
export function mobileObjectiveDisplayText(content: string): string {
  if (!content.includes("goal_status")) return content;
  const fenced = /\n?\s*```(?:json|jsonc)?\s*\{[^{}]*"goal_status"[^{}]*\}\s*```\s*$/iu;
  const bare = /\n?\s*\{[^{}]*"goal_status"[^{}]*\}\s*$/iu;
  if (fenced.test(content)) return content.replace(fenced, "").trimEnd();
  if (bare.test(content)) return content.replace(bare, "").trimEnd();
  return content;
}
function limit(value: number | null, maximum: number): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("The objective limit is invalid.");
  return value;
}
function unsigned(value: number, maximum: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
function positive(value: bigint): boolean { return value >= 1n && value <= BigInt(Number.MAX_SAFE_INTEGER); }
function safeNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The objective token count is invalid.");
  return Number(value);
}
function timestamp(value: { seconds: bigint; nanos: number } | undefined): number {
  if (!value || value.seconds < 0n || !Number.isInteger(value.nanos) || value.nanos < 0 || value.nanos >= 1_000_000_000 || value.nanos % 1_000_000 !== 0) {
    throw new Error("The objective timestamp is invalid.");
  }
  return safeNumber(value.seconds * 1_000n + BigInt(value.nanos / 1_000_000));
}
