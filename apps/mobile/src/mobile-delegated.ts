import {
  BackgroundTaskState, SubagentRunState, SubagentToolPhase, SubagentTranscriptRole,
  type BackgroundTask, type Event, type SubagentChildRun, type SubagentRun, type SubagentRunDetail,
  type SubagentTranscriptEntry
} from "@joko/contracts";

export interface MobileDelegatedEntry {
  readonly key: string;
  readonly task?: BackgroundTask;
  readonly run?: SubagentRun;
  readonly refreshKey?: string;
}

export type MobileDelegatedState = "queued" | "running" | "waiting" | "completed" | "failed" | "stopped" | "unknown";

export interface MobileDelegatedProjection {
  readonly key: string;
  readonly title: string;
  readonly state: MobileDelegatedState;
  readonly assignment: string;
  readonly summary: string;
  readonly resultTruncated: boolean;
  readonly statusText: string;
  readonly progress?: number;
  readonly model: string;
  readonly thinkingLevel: string;
  readonly tokens?: string;
  readonly toolUses?: string;
  readonly durationMs?: number;
  readonly costUsd?: number;
  readonly lastToolName: string;
  readonly readOnly?: boolean;
  readonly error: string;
}

export function mobileDelegatedRunMatches(run: SubagentRun, identity: string): boolean {
  return identity !== "" && (run.subagentRunId === identity || run.logicalAgentId === identity
    || run.identityAliases.includes(identity) || run.providerRunIds.includes(identity));
}

export function mobileDelegatedRunIsCurrent(candidate: SubagentRun, previous: SubagentRun): boolean {
  const generation = candidate.version?.generation ?? 0n;
  const oldGeneration = previous.version?.generation ?? 0n;
  return generation > oldGeneration || generation === oldGeneration
    && (candidate.version?.revision?.value ?? 0n) >= (previous.version?.revision?.value ?? 0n);
}

/** Stable contract identities join activity to delegated data; titles and paths never grant access. */
export function projectMobileDelegatedEntries(
  sessionId: string,
  tasks: readonly BackgroundTask[],
  runs: readonly SubagentRun[]
): readonly MobileDelegatedEntry[] {
  const runById = new Map<string, SubagentRun>();
  for (const run of runs) {
    if (!run.subagentRunId || run.sessionId !== sessionId) continue;
    const old = runById.get(run.subagentRunId);
    if (!old || mobileDelegatedRunIsCurrent(run, old)) runById.set(run.subagentRunId, run);
  }
  const taskById = new Map<string, BackgroundTask>();
  for (const task of tasks) {
    if (!task.backgroundTaskId || task.sessionId !== sessionId) continue;
    const old = taskById.get(task.backgroundTaskId);
    if (!old || (task.version?.generation ?? 0n) > (old.version?.generation ?? 0n)
      || task.version?.generation === old.version?.generation
      && (task.version?.revision?.value ?? 0n) >= (old.version?.revision?.value ?? 0n)) taskById.set(task.backgroundTaskId, task);
  }
  const output = new Map<string, MobileDelegatedEntry>();
  for (const task of taskById.values()) {
    let matched: SubagentRun | undefined;
    for (const run of runById.values()) {
      if (!mobileDelegatedRunMatches(run, task.backgroundTaskId)) continue;
      if (!matched || strength(run, task.backgroundTaskId) > strength(matched, task.backgroundTaskId)
        || strength(run, task.backgroundTaskId) === strength(matched, task.backgroundTaskId)
        && mobileDelegatedRunIsCurrent(run, matched)) matched = run;
    }
    const key = matched ? `delegated:${matched.subagentRunId}` : `background:${task.backgroundTaskId}`;
    const previous = output.get(key);
    if (!previous || matched?.subagentRunId === task.backgroundTaskId) output.set(key, { key, task, ...(matched ? { run: matched } : {}) });
  }
  for (const run of runById.values()) {
    const key = `delegated:${run.subagentRunId}`;
    if (!output.has(key)) output.set(key, { key, run });
  }
  return [...output.values()];
}

export function projectMobileDelegated(entry: MobileDelegatedEntry, detail?: SubagentRunDetail): MobileDelegatedProjection {
  const run = entry.run;
  const currentDetail = run && detail?.run?.subagentRunId === run.subagentRunId
    && detail.run.sessionId === run.sessionId && mobileDelegatedRunIsCurrent(detail.run, run) ? detail : undefined;
  const effective = currentDetail?.run ?? run;
  const result = effective?.capabilities?.viewReturnedResult ? currentDetail?.returnedResult?.trim() : undefined;
  const route = effective?.route;
  let lastToolName = "";
  let sequence = -1n;
  if (effective?.capabilities?.viewActivity) for (const activity of currentDetail?.activity ?? []) {
    if (activity.lastToolName && activity.sequence > sequence) { lastToolName = activity.lastToolName; sequence = activity.sequence; }
  }
  const duration = effective?.usage?.duration;
  const durationMs = duration === undefined ? undefined : Number(duration.seconds) * 1_000 + duration.nanos / 1_000_000;
  const cost = effective?.usage?.costUsd;
  const progress = entry.task?.progressRatio;
  return {
    key: entry.key, title: effective?.title || entry.task?.displayName || effective?.logicalAgentId || effective?.subagentRunId || "",
    state: effective ? mobileSubagentState(effective.state) : mobileBackgroundState(entry.task?.state),
    assignment: effective?.assignment || effective?.description || "", summary: result || effective?.summary || "",
    resultTruncated: !!result && currentDetail?.returnedResultTruncated === true,
    statusText: entry.task?.statusText ?? "", model: route?.modelId
      ? route.providerId && !route.modelId.startsWith(`${route.providerId}/`) ? `${route.providerId}/${route.modelId}` : route.modelId : "",
    thinkingLevel: route?.thinkingLevel ?? "", tokens: nonNegative(effective?.usage?.totalTokens), toolUses: nonNegative(effective?.usage?.toolUses),
    ...(durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
    ...(cost !== undefined && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
    ...(progress !== undefined && Number.isFinite(progress) && progress >= 0 && progress <= 1 ? { progress } : {}),
    lastToolName, ...(effective?.readOnly === undefined ? {} : { readOnly: effective.readOnly }),
    error: effective?.error?.message || entry.task?.error?.message || ""
  };
}

export function mobileSubagentState(value: SubagentRunState): MobileDelegatedState {
  switch (value) {
    case SubagentRunState.QUEUED: return "queued";
    case SubagentRunState.RUNNING: return "running";
    case SubagentRunState.COMPLETED: return "completed";
    case SubagentRunState.FAILED: return "failed";
    case SubagentRunState.STOPPED: return "stopped";
    default: return "unknown";
  }
}

export function mobileBackgroundState(value: BackgroundTaskState | undefined): MobileDelegatedState {
  switch (value) {
    case BackgroundTaskState.QUEUED: return "queued";
    case BackgroundTaskState.RUNNING: return "running";
    case BackgroundTaskState.WAITING: return "waiting";
    case BackgroundTaskState.SUCCEEDED: return "completed";
    case BackgroundTaskState.FAILED: return "failed";
    case BackgroundTaskState.ABORTED: return "stopped";
    default: return "unknown";
  }
}

export function mergeMobileDelegatedTranscript(current: readonly SubagentTranscriptEntry[], incoming: readonly SubagentTranscriptEntry[]): readonly SubagentTranscriptEntry[] {
  const byId = new Map(current.map((entry) => [entry.entryId, entry]));
  for (const entry of incoming) if (entry.entryId) {
    const old = byId.get(entry.entryId);
    if (!old || entry.sequence >= old.sequence) byId.set(entry.entryId, entry);
  }
  return [...byId.values()].sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : a.entryId.localeCompare(b.entryId));
}

export interface MobileDelegatedConversationItem {
  readonly id: string;
  readonly kind: "parent" | "subagent" | "system" | "tool";
  readonly childId: string;
  readonly childTitle: string;
  readonly text: string;
  readonly entry: SubagentTranscriptEntry;
  readonly tool?: { readonly name: string; readonly input: string; output: string; done: boolean; isError: boolean };
}

/** Tool pairing is local to a child identity, even when providers reuse call IDs. */
export function buildMobileDelegatedConversation(entries: readonly SubagentTranscriptEntry[]): readonly MobileDelegatedConversationItem[] {
  const items: MobileDelegatedConversationItem[] = [];
  const calls = new Map<string, MobileDelegatedConversationItem>();
  const anonymous = new Map<string, MobileDelegatedConversationItem[]>();
  for (const entry of mergeMobileDelegatedTranscript([], entries)) {
    if (entry.role !== SubagentTranscriptRole.TOOL) {
      items.push({ id: entry.entryId, kind: entry.role === SubagentTranscriptRole.PARENT ? "parent"
        : entry.role === SubagentTranscriptRole.SUBAGENT ? "subagent" : "system", childId: entry.childId,
        childTitle: entry.childTitle, text: entry.content, entry });
      continue;
    }
    const key = JSON.stringify([entry.childId, entry.toolCallId]);
    const stack = anonymous.get(entry.childId) ?? [];
    const open = entry.toolCallId ? calls.get(key) : stack.at(-1);
    if ((entry.toolPhase === SubagentToolPhase.UPDATE || entry.toolPhase === SubagentToolPhase.END) && open?.tool) {
      if (entry.content || entry.toolPhase === SubagentToolPhase.END) open.tool.output = entry.content;
      open.tool.isError ||= entry.isError === true;
      if (entry.toolPhase === SubagentToolPhase.END) {
        open.tool.done = true;
        if (entry.toolCallId) calls.delete(key); else stack.pop();
      }
      continue;
    }
    const started = entry.toolPhase === SubagentToolPhase.START;
    const item: MobileDelegatedConversationItem = { id: entry.entryId, kind: "tool", childId: entry.childId,
      childTitle: entry.childTitle, text: started ? entry.content : "", entry,
      tool: { name: entry.toolName, input: entry.toolInputJson, output: started ? "" : entry.content,
        done: !started, isError: entry.isError === true } };
    items.push(item);
    if (started) {
      if (entry.toolCallId) calls.set(key, item); else { stack.push(item); anonymous.set(entry.childId, stack); }
    }
  }
  return items;
}

export interface MobileDelegatedChildRow { readonly child: SubagentChildRun; readonly depth: number; }
export function mobileDelegatedChildren(children: readonly SubagentChildRun[]): readonly MobileDelegatedChildRow[] {
  const byId = new Map<string, SubagentChildRun>();
  for (const child of children) if (child.childId) byId.set(child.childId, child);
  const visited = new Set<string>();
  const rows: MobileDelegatedChildRow[] = [];
  const append = (start: SubagentChildRun): void => {
    const stack: MobileDelegatedChildRow[] = [{ child: start, depth: 0 }];
    while (stack.length && rows.length < 2_000) {
      const next = stack.pop()!;
      if (visited.has(next.child.childId)) continue;
      visited.add(next.child.childId); rows.push(next);
      if (next.depth >= 64) continue;
      const nested = [...byId.values()].filter((child) => child.parentChildId === next.child.childId);
      for (const child of nested.reverse()) stack.push({ child, depth: next.depth + 1 });
    }
  };
  for (const child of byId.values()) if (!child.parentChildId || !byId.has(child.parentChildId)) append(child);
  for (const child of byId.values()) if (!visited.has(child.childId)) append(child);
  return rows;
}

export function mobileDelegatedResultIsInTranscript(result: string, entries: readonly SubagentTranscriptEntry[], complete: boolean): boolean {
  return complete && result.trim() !== "" && !entries.some((entry) => entry.systemEvent?.kind === "transcript-truncated")
    && entries.some((entry) => entry.role === SubagentTranscriptRole.SUBAGENT && entry.content.trim() === result.trim());
}

export function currentMobileDelegatedChildren(children: readonly SubagentChildRun[]): readonly SubagentChildRun[] {
  const historical = new Set<string>();
  for (const child of children) {
    if (child.parentChildId) historical.add(child.parentChildId);
    for (const alias of child.identityAliases) if (alias !== child.childId) historical.add(alias);
  }
  const current = children.filter((child) => !historical.has(child.childId));
  return current.length ? current : children;
}

export function mobileDelegatedChildIdentities(child: SubagentChildRun, children: readonly SubagentChildRun[]): ReadonlySet<string> {
  const identities = new Set<string>();
  const pending = [child.childId];
  while (pending.length && identities.size < 2_000) {
    const identity = pending.pop()!;
    if (identities.has(identity)) continue;
    identities.add(identity);
    const candidate = children.find((value) => value.childId === identity || value.identityAliases.includes(identity));
    if (!candidate) continue;
    pending.push(candidate.childId, ...candidate.identityAliases);
    if (candidate.parentChildId) pending.push(candidate.parentChildId);
  }
  return identities;
}

export function resolveMobileDelegatedChild(children: readonly SubagentChildRun[], identity: string): SubagentChildRun | undefined {
  const current = currentMobileDelegatedChildren(children);
  if (!identity) return undefined;
  const direct = current.find((child) => child.childId === identity);
  if (direct) return direct;
  const matches = current.filter((child) => mobileDelegatedChildIdentities(child, children).has(identity));
  if (matches.length === 1) return matches[0];
  return undefined;
}

/** Only relevant typed events form the read refresh key, never text deltas or Snapshot revision. */
export function mobileDelegatedEventKey(sessionId: string, generation: bigint, events: readonly Event[]): string {
  return events.filter((event) => event.identity?.sessionId === sessionId && event.cursor?.generation === generation
    && ["backgroundTaskChanged", "subagentRunChanged", "subagentTranscriptAppended"].includes(event.payload?.kind.case ?? ""))
    .map((event) => `${event.eventId}:${event.cursor!.sequence}`).join("\u001f");
}

export function mobileDelegatedEventRecords(sessionId: string, generation: bigint, events: readonly Event[]): {
  readonly tasks: readonly BackgroundTask[]; readonly runs: readonly SubagentRun[];
} {
  const tasks: BackgroundTask[] = []; const runs: SubagentRun[] = [];
  for (const event of events) {
    if (event.identity?.sessionId !== sessionId || event.cursor?.generation !== generation) continue;
    const kind = event.payload?.kind;
    if (kind?.case === "backgroundTaskChanged" && kind.value.backgroundTask?.sessionId === sessionId) tasks.push(kind.value.backgroundTask);
    if (kind?.case === "subagentRunChanged" && kind.value.run?.run?.sessionId === sessionId) runs.push(kind.value.run.run);
  }
  return { tasks, runs };
}

export interface MobileDelegatedTimelineAffinity {
  readonly byEventId: ReadonlyMap<string, readonly MobileDelegatedEntry[]>;
  readonly suppressedMetadataEventIds: ReadonlySet<string>;
  readonly nestedByRunId: ReadonlyMap<string, readonly MobileDelegatedEntry[]>;
  readonly orphanEntries: readonly MobileDelegatedEntry[];
}

/** Parent tools remain intact. Only duplicate task/status edges are replaced by the richer same-identity card. */
export function mobileDelegatedTimelineAffinity(sessionId: string, generation: bigint, events: readonly Event[],
  entries: readonly MobileDelegatedEntry[]): MobileDelegatedTimelineAffinity {
  const byEventId = new Map<string, MobileDelegatedEntry[]>();
  const suppressedMetadataEventIds = new Set<string>();
  const nestedByRunId = new Map<string, MobileDelegatedEntry[]>();
  const orphanEntries: MobileDelegatedEntry[] = [];
  const parents = new Map<string, MobileDelegatedEntry>();
  const relevant = events.filter((event) => event.identity?.sessionId === sessionId && event.cursor?.generation === generation);
  for (const entry of entries) {
    const parent = entry.run?.parentSubagentRunId ? entries.find((other) => other.run?.subagentRunId === entry.run!.parentSubagentRunId && other.key !== entry.key) : undefined;
    if (parent) parents.set(entry.key, parent);
  }
  // Malformed cycles and over-deep chains retain an overview entry instead of hiding every card.
  for (const entry of entries) {
    const path: string[] = []; let key = entry.key;
    while (parents.has(key)) {
      const index = path.indexOf(key);
      if (index >= 0) { parents.delete(path.slice(index).sort()[0]!); break; }
      path.push(key);
      if (path.length > 5) { parents.delete(entry.key); break; }
      key = parents.get(key)!.key;
    }
  }
  for (const entry of entries) {
    const taskEdges = relevant.filter((event) => event.payload?.kind.case === "backgroundTaskChanged"
      && (event.payload.kind.value.backgroundTask?.backgroundTaskId === entry.task?.backgroundTaskId
        || entry.run && mobileDelegatedRunMatches(entry.run, event.payload.kind.value.backgroundTask?.backgroundTaskId ?? "")));
    const toolEdge = entry.run?.parentToolCallId ? relevant.findLast((event) => {
      const kind = event.payload?.kind;
      return (kind?.case === "toolCallStarted" || kind?.case === "toolCallUpdated" || kind?.case === "toolCallCompleted")
        && kind.value.toolCall?.sessionId === sessionId && kind.value.toolCall.toolCallId === entry.run!.parentToolCallId
        && (!entry.run!.parentRunId || kind.value.toolCall.runId === entry.run!.parentRunId);
    }) : undefined;
    const runEdges = entry.run ? relevant.filter((event) => event.payload?.kind.case === "subagentRunChanged"
      && event.payload.kind.value.run?.run?.subagentRunId === entry.run!.subagentRunId
      || event.payload?.kind.case === "subagentTranscriptAppended" && event.payload.kind.value.subagentRunId === entry.run!.subagentRunId) : [];
    for (const event of [...taskEdges, ...runEdges]) suppressedMetadataEventIds.add(event.eventId);
    const parent = parents.get(entry.key);
    if (parent?.run) {
      const nested = nestedByRunId.get(parent.run.subagentRunId) ?? [];
      nested.push(entry); nestedByRunId.set(parent.run.subagentRunId, nested); continue;
    }
    const edge = toolEdge ?? taskEdges[0] ?? runEdges[0];
    if (!edge) { orphanEntries.push(entry); continue; }
    const attached = byEventId.get(edge.eventId) ?? []; attached.push(entry); byEventId.set(edge.eventId, attached);
  }
  return { byEventId, suppressedMetadataEventIds, nestedByRunId, orphanEntries };
}

function strength(run: SubagentRun, identity: string): number {
  return run.subagentRunId === identity ? 3 : run.logicalAgentId === identity ? 2 : 1;
}
function nonNegative(value: bigint | undefined): string | undefined { return value !== undefined && value >= 0n ? value.toString() : undefined; }
