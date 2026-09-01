import type { BackgroundTaskView, SubagentRunDetailView, SubagentRunPageView, SubagentRunStateView, SubagentRunView } from "../model.js";

const TIMELINE_SUBAGENT_RUN_MAX_PAGES = 1_000;

export interface SubagentInlineCardProjection {
  readonly id: string;
  readonly title: string;
  readonly state: SubagentRunStateView;
  readonly description?: string;
  readonly summary?: string;
  readonly summaryTruncated?: boolean;
  readonly lastToolName?: string;
  readonly childCount?: number;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly totalTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
  readonly costUsd?: number;
  readonly readOnly?: boolean;
  readonly errorMessage?: string;
  readonly canStop: boolean;
}

/**
 * Joins the generic durable activity edge to its richer delegated-run record.
 * Only contract-owned stable identities participate; display strings are
 * deliberately never parsed to infer that an activity is a run.
 */
export function projectSubagentInlineCard(
  task: BackgroundTaskView | undefined,
  run: SubagentRunView | undefined,
  detail?: SubagentRunDetailView
): SubagentInlineCardProjection | undefined {
  if (task === undefined || run === undefined || !subagentRunMatchesTaskId(run, task.id)) return undefined;
  const currentDetail = detail !== undefined
    && detail.run.id === run.id
    && detail.run.sessionId === run.sessionId
    && detail.run.revision >= run.revision
    ? detail
    : undefined;
  const effectiveRun = currentDetail?.run ?? run;
  const description = nonBlank(effectiveRun.description) ?? nonBlank(effectiveRun.assignment);
  const returnedResult = effectiveRun.capabilities.viewReturnedResult ? nonBlank(currentDetail?.returnedResult) : undefined;
  const summary = returnedResult ?? nonBlank(effectiveRun.summary);
  const latestTool = effectiveRun.capabilities.viewActivity ? latestRecordedTool(currentDetail) : undefined;
  const childCount = currentDetail !== undefined
    && (currentDetail.childrenObserved === true || currentDetail.children.length > 0)
    ? currentDetail.children.length
    : undefined;
  const model = routeModel(effectiveRun);
  const thinkingLevel = nonBlank(effectiveRun.route?.thinkingLevel);
  const totalTokens = finiteNonNegativeInteger(effectiveRun.usage?.totalTokens);
  const toolUses = finiteNonNegativeInteger(effectiveRun.usage?.toolUses);
  const durationMs = finiteNonNegative(effectiveRun.usage?.durationMs);
  const costUsd = finiteNonNegative(effectiveRun.usage?.costUsd);
  const errorMessage = nonBlank(effectiveRun.error?.message);
  return {
    id: effectiveRun.id,
    title: nonBlank(effectiveRun.title) ?? task.title,
    state: effectiveRun.state,
    ...(description === undefined ? {} : { description }),
    ...(summary === undefined ? {} : { summary }),
    ...(returnedResult === undefined || currentDetail?.returnedResultTruncated !== true ? {} : { summaryTruncated: true }),
    ...(latestTool === undefined ? {} : { lastToolName: latestTool }),
    ...(childCount === undefined ? {} : { childCount }),
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(toolUses === undefined ? {} : { toolUses }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(effectiveRun.readOnly === undefined ? {} : { readOnly: effectiveRun.readOnly }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
    canStop: effectiveRun.capabilities.stop && effectiveRun.state === "running"
  };
}

export function subagentRunMatchesTaskId(run: SubagentRunView, taskId: string): boolean {
  return run.id === taskId
    || run.logicalAgentId === taskId
    || run.identityAliases.includes(taskId)
    || run.providerRunIds.includes(taskId);
}

export function timelineSubagentDetailResponseIsCurrent(input: {
  readonly sourceSessionId: string;
  readonly requestEpoch: number;
  readonly activeSessionId: string;
  readonly activeEpoch: number;
  readonly requestedRun: SubagentRunView | undefined;
  readonly detail: SubagentRunDetailView;
}): boolean {
  return input.sourceSessionId === input.activeSessionId
    && input.requestEpoch === input.activeEpoch
    && input.requestedRun !== undefined
    && input.detail.run.sessionId === input.sourceSessionId
    && input.detail.run.id === input.requestedRun.id
    && input.detail.run.revision >= input.requestedRun.revision;
}

export function formatSubagentDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

export async function collectTimelineSubagentRuns(
  taskIds: ReadonlySet<string>,
  loadPage: (pageToken: string) => Promise<SubagentRunPageView>
): Promise<ReadonlyMap<string, SubagentRunView>> {
  const runs = new Map<string, SubagentRunView>();
  if (taskIds.size === 0) return runs;
  const seenTokens = new Set<string>();
  let pageToken = "";
  let pageCount = 0;
  for (;;) {
    if (pageCount >= TIMELINE_SUBAGENT_RUN_MAX_PAGES) throw new Error("Delegated-run pagination exceeded its safe page limit.");
    pageCount += 1;
    if (seenTokens.has(pageToken)) throw new Error("Delegated-run pagination returned a cyclic token.");
    seenTokens.add(pageToken);
    const page = await loadPage(pageToken);
    for (const run of page.runs) {
      for (const taskId of taskIds) {
        if (!subagentRunMatchesTaskId(run, taskId)) continue;
        const existing = runs.get(taskId);
        if (existing === undefined || preferRunForTask(run, existing, taskId)) runs.set(taskId, run);
      }
    }
    if ([...taskIds].every((taskId) => runs.get(taskId)?.id === taskId) || page.nextPageToken === undefined) return runs;
    pageToken = page.nextPageToken;
  }
}

function preferRunForTask(candidate: SubagentRunView, existing: SubagentRunView, taskId: string): boolean {
  const candidateStrength = runIdentityStrength(candidate, taskId);
  const existingStrength = runIdentityStrength(existing, taskId);
  if (candidateStrength !== existingStrength) return candidateStrength > existingStrength;
  if (candidate.revision !== existing.revision) return candidate.revision > existing.revision;
  return candidate.updatedAt > existing.updatedAt;
}

function runIdentityStrength(run: SubagentRunView, taskId: string): number {
  if (run.id === taskId) return 3;
  if (run.logicalAgentId === taskId) return 2;
  return run.identityAliases.includes(taskId) || run.providerRunIds.includes(taskId) ? 1 : 0;
}

function latestRecordedTool(detail: SubagentRunDetailView | undefined): string | undefined {
  let latest: { readonly sequence: number; readonly name: string } | undefined;
  for (const activity of detail?.activity ?? []) {
    const name = nonBlank(activity.lastToolName);
    if (name !== undefined && (latest === undefined || activity.sequence > latest.sequence)) latest = { sequence: activity.sequence, name };
  }
  return latest?.name;
}

function routeModel(run: SubagentRunView): string | undefined {
  const modelId = nonBlank(run.route?.modelId);
  if (modelId === undefined) return undefined;
  const providerId = nonBlank(run.route?.providerId);
  if (providerId === undefined || modelId.startsWith(`${providerId}/`)) return modelId;
  return `${providerId}/${modelId}`;
}

function nonBlank(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? undefined : normalized;
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finiteNonNegativeInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
