import { createHash, randomUUID } from "node:crypto";
import {
  CodeHostProviderRetryableError, CodeHostProviderUnavailableError, CodeHostPullRequestNotFoundError,
  parseCodeHostPullRequestReference,
  type CodeHostProvider, type CodeHostProviderResult, type CodeHostPullRequestReference,
  type CodeHostSessionAuthorization, type CodeHostSessionAuthorizationPort
} from "@joko/code-host";
import { scheduleRunIdFromDigest, type SchedulePullRequestRule } from "@joko/contracts";
import { SCHEDULE_PULL_REQUEST_WATCH_SETTING_KEY, type OperationalStore, type ScheduleRecord } from "@joko/store";
import { scheduleExtensionSnapshot } from "./schedule-extensions.js";
import type { SessionHost } from "./session-host.js";

const SWEEP_MS = 5_000;
const MIN_RETRIGGER_MS = 60_000;
const DEFAULT_POLL_MS = 60_000;

interface WatchedSchedule {
  readonly schedule: ScheduleRecord;
  readonly rule: SchedulePullRequestRule;
  readonly reference: CodeHostPullRequestReference;
  readonly identity: string;
  readonly ownerRevision: string;
}

export interface SchedulePullRequestWakeup {
  readonly operationId: string;
  readonly observedAt: number;
  readonly url: string;
}

interface Observation {
  readonly state: CodeHostProviderResult["state"];
  readonly draft: boolean;
  readonly headSha?: string;
  readonly checks?: string;
  readonly pipelineId?: string;
  readonly pipelineFinishedAt?: number;
  readonly pipelineStatus?: string;
  readonly mergeState?: string;
  readonly reviewDecision?: string;
  readonly threads?: number;
  readonly comments?: number;
  readonly reviewComments?: number;
}

interface WatchState {
  readonly format: 1;
  readonly identity: string;
  readonly baseline: Observation;
  readonly lastDispatchedAt?: number;
  readonly pending?: SchedulePullRequestWakeup;
}

// The operational Store materializes undefined fields as null in older rows.
type StoredWatchState = Omit<WatchState, "lastDispatchedAt" | "pending"> & {
  readonly lastDispatchedAt?: number | null;
  readonly pending?: SchedulePullRequestWakeup | null;
};

/** An explicitly saved, enabled task binding authorizes reads of exactly one canonical PR. */
export class SchedulePullRequestAuthorization implements CodeHostSessionAuthorizationPort {
  constructor(
    private readonly store: OperationalStore,
    private readonly host: Pick<SessionHost, "canFollowPullRequestInTask">,
    private readonly now: () => number
  ) {}

  current(scheduleId: string): WatchedSchedule | undefined {
    const schedule = this.store.findSchedule(scheduleId);
    if (schedule === undefined || !schedule.enabled || schedule.sessionMode !== "bound" ||
      schedule.sessionId === undefined || schedule.kind === "one_shot" ||
      this.store.findPendingScheduleDeletionCleanupForSchedule(scheduleId) !== undefined) return undefined;
    const extension = scheduleExtensionSnapshot(schedule.executionSnapshot);
    if (extension.executionMode !== "agent" || extension.followPullRequest === undefined ||
      (extension.expireAt !== undefined && extension.expireAt <= this.now())) return undefined;
    const rule = extension.followPullRequest;
    const reference = parseCodeHostPullRequestReference(rule.url);
    if (reference === undefined || reference.webUrl !== rule.url) return undefined;
    const session = this.store.findSession(schedule.sessionId);
    if (session === undefined || !this.host.canFollowPullRequestInTask(session) ||
      !this.store.scheduleMatchesSession(schedule, session.descriptor)) return undefined;
    return {
      schedule, rule, reference,
      identity: JSON.stringify([schedule.createdAt, schedule.sessionId, schedule.backendId, schedule.targetId, rule]),
      ownerRevision: JSON.stringify([String(schedule.revision), session.descriptor.backendId, session.descriptor.binding.generation])
    };
  }

  authorize(scheduleId: string, reference: CodeHostPullRequestReference): CodeHostSessionAuthorization | undefined {
    const current = this.current(scheduleId);
    if (current?.reference.key !== reference.key || current.reference.webUrl !== reference.webUrl) return undefined;
    return { sessionOwnerId: scheduleId, referenceKey: reference.key, ownerRevision: current.ownerRevision };
  }

  isCurrent(authorization: CodeHostSessionAuthorization, reference: CodeHostPullRequestReference): boolean {
    const current = this.authorize(authorization.sessionOwnerId, reference);
    return current?.ownerRevision === authorization.ownerRevision && current.referenceKey === authorization.referenceKey;
  }
}

interface WatcherOptions {
  readonly store: OperationalStore;
  readonly authority: SchedulePullRequestAuthorization;
  readonly providers: readonly CodeHostProvider[];
  readonly now: () => number;
  readonly ownsScheduler: () => boolean;
  readonly dispatch: (schedule: ScheduleRecord, wakeup: SchedulePullRequestWakeup, isCurrent: () => boolean) => Promise<boolean>;
}

export class SchedulePullRequestWatcher {
  private readonly nextPoll = new Map<string, { readonly identity: string; readonly at: number; readonly baseline: boolean }>();
  private running = false;
  private nextSweepAt = 0;
  private lifecycle = new AbortController();

  constructor(private readonly options: WatcherOptions) {}

  stop(): void {
    this.lifecycle.abort();
    this.lifecycle = new AbortController();
    this.nextPoll.clear();
    this.nextSweepAt = 0;
  }

  tick(): void {
    const at = this.options.now();
    if (this.running || at < this.nextSweepAt || !this.options.ownsScheduler()) return;
    this.nextSweepAt = at + SWEEP_MS;
    this.running = true;
    void this.sweep(this.lifecycle.signal).finally(() => { this.running = false; }).catch(() => undefined);
  }

  ownsOccurrence(scheduleId: string, runId: string): boolean {
    const pending = this.options.store.findSetting<StoredWatchState>("service", scheduleId, SCHEDULE_PULL_REQUEST_WATCH_SETTING_KEY)?.value.pending;
    return pending != null && scheduleRunIdFromDigest(createHash("sha256").update(pending.operationId).digest("hex")) === runId;
  }

  private async sweep(signal: AbortSignal): Promise<void> {
    const enabled = this.options.store.listSchedules({ enabledOnly: true });
    const ids = new Set(enabled.map(schedule => schedule.id));
    for (const id of this.nextPoll.keys()) if (!ids.has(id)) this.nextPoll.delete(id);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, enabled.length) }, async () => {
      while (cursor < enabled.length && !signal.aborted && this.options.ownsScheduler()) {
        const scheduleId = enabled[cursor++]!.id;
        // A bad stored rule, provider failure or changed owner leaves unrelated watches available.
        await this.readAndDispatch(scheduleId, signal).catch(() => undefined);
      }
    }));
  }

  private async readAndDispatch(scheduleId: string, signal: AbortSignal): Promise<void> {
    const { store, authority, now, ownsScheduler } = this.options;
    const watched = authority.current(scheduleId);
    if (watched === undefined) {
      this.nextPoll.delete(scheduleId);
      return;
    }
    const isCurrent = () => !signal.aborted && ownsScheduler() && authority.current(scheduleId)?.ownerRevision === watched.ownerRevision;
    const saved = store.findSetting<StoredWatchState>("service", scheduleId, SCHEDULE_PULL_REQUEST_WATCH_SETTING_KEY)?.value;
    let state: WatchState | undefined;
    if (saved?.format === 1 && saved.identity === watched.identity && saved.baseline != null) {
      const { pending, lastDispatchedAt, ...watch } = saved;
      state = { ...watch, ...(pending == null ? {} : { pending }), ...(lastDispatchedAt == null ? {} : { lastDispatchedAt }) };
    }
    if (state?.pending !== undefined) {
      const committed = store.findOperation(state.pending.operationId) ?? store.findOperation(`${state.pending.operationId}-outcome`);
      if (committed?.status === "completed") {
        const { pending: _accepted, ...settled } = state;
        state = { ...settled, lastDispatchedAt: committed.updatedAt };
        store.setSetting("service", scheduleId, SCHEDULE_PULL_REQUEST_WATCH_SETTING_KEY, state);
      }
    }
    const at = now();
    const poll = this.nextPoll.get(scheduleId);
    if (poll?.identity !== watched.identity || (poll.baseline && state === undefined) || at >= poll.at) {
      const read = await this.readProvider(watched, signal);
      if (!isCurrent()) return;
      if (read.result !== undefined) {
        const current = observe(read.result);
        const previous: Observation | undefined = state?.baseline;
        const baseline = { ...previous, ...current };
        const followsGitLabState = watched.rule.change === "any" && watched.reference.webUrl.includes("/-/merge_requests/");
        const terminalAt = current.state === "merged" && (watched.rule.change === "merged" || followsGitLabState)
          ? read.result.activity?.mergedAt
          : current.state === "closed" && followsGitLabState ? read.result.activity?.closedAt : undefined;
        const changed = previous === undefined
          ? terminalAt !== undefined && terminalAt > watched.schedule.createdAt && terminalAt > (watched.schedule.lastRunAt ?? 0)
          : matchesChange(watched.rule, previous, current);
        const pending = changed ? { operationId: `pull-request-schedule-${randomUUID()}`, observedAt: now(), url: watched.rule.url } : state?.pending;
        if (state === undefined || changed || !equalObservation(baseline, state.baseline)) {
          state = { format: 1, identity: watched.identity, baseline,
            ...(state?.lastDispatchedAt === undefined ? {} : { lastDispatchedAt: state.lastDispatchedAt }),
            ...(pending === undefined ? {} : { pending }) };
          store.setSetting("service", scheduleId, SCHEDULE_PULL_REQUEST_WATCH_SETTING_KEY, state);
        }
      }
      this.nextPoll.set(scheduleId, { identity: watched.identity, at: now() + read.delayMs, baseline: state !== undefined });
    }
    const pending = state?.pending;
    if (state === undefined || pending === undefined || !isCurrent() ||
      (state.lastDispatchedAt !== undefined && now() - state.lastDispatchedAt < MIN_RETRIGGER_MS)) return;
    const ownsRule = () => !signal.aborted && ownsScheduler() && authority.current(scheduleId)?.identity === watched.identity;
    const accepted = await this.options.dispatch(watched.schedule, pending, ownsRule);
    if (!accepted || signal.aborted || !ownsScheduler() || authority.current(scheduleId)?.identity !== watched.identity) return;
    const latest = store.findSetting<WatchState>("service", scheduleId, SCHEDULE_PULL_REQUEST_WATCH_SETTING_KEY)?.value;
    if (latest?.pending?.operationId !== pending.operationId) return;
    const { pending: _accepted, ...settled } = latest;
    store.setSetting("service", scheduleId, SCHEDULE_PULL_REQUEST_WATCH_SETTING_KEY, { ...settled, lastDispatchedAt: now() });
  }

  private async readProvider(watched: WatchedSchedule, signal: AbortSignal): Promise<{
    readonly result?: CodeHostProviderResult;
    readonly delayMs: number;
  }> {
    for (const provider of this.options.providers) {
      if (!provider.supports(watched.reference)) continue;
      const delayMs = Math.max(SWEEP_MS, provider.minimumTimeToLiveMs ?? DEFAULT_POLL_MS);
      try {
        const result = await provider.getPullRequest(watched.reference, {
          sessionOwnerId: watched.schedule.id, purpose: "follow", signal
        });
        return { result, delayMs };
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof CodeHostProviderUnavailableError || error instanceof CodeHostPullRequestNotFoundError) continue;
        if (error instanceof CodeHostProviderRetryableError) return { delayMs: Math.max(delayMs, error.retryAfterMs ?? 0) };
        return { delayMs };
      }
    }
    return { delayMs: DEFAULT_POLL_MS };
  }
}

function observe(result: CodeHostProviderResult): Observation {
  const activity = result.activity;
  return {
    state: result.state, draft: result.draft,
    ...(activity?.headSha === undefined ? {} : { headSha: activity.headSha }),
    ...(activity?.checks === undefined ? {} : { checks: JSON.stringify([...activity.checks].sort()) }),
    ...(activity?.pipelineId === undefined ? {} : { pipelineId: activity.pipelineId }),
    ...(activity?.pipelineFinishedAt === undefined ? {} : { pipelineFinishedAt: activity.pipelineFinishedAt }),
    ...(activity?.pipelineStatus === undefined ? {} : { pipelineStatus: activity.pipelineStatus }),
    ...(activity?.mergeState === undefined ? {} : { mergeState: activity.mergeState }),
    ...(activity?.reviewDecision === undefined ? {} : { reviewDecision: activity.reviewDecision }),
    ...(result.unresolvedReviewThreadCount === undefined ? {} : { threads: result.unresolvedReviewThreadCount }),
    ...(activity?.commentCount === undefined ? {} : { comments: activity.commentCount }),
    ...(activity?.reviewCommentCount === undefined ? {} : { reviewComments: activity.reviewCommentCount })
  };
}

function matchesChange(rule: SchedulePullRequestRule, previous: Observation, current: Observation): boolean {
  const changed = (key: keyof Observation) => previous[key] !== undefined && current[key] !== undefined && previous[key] !== current[key];
  const checksChanged = (["checks", "pipelineId", "pipelineFinishedAt", "pipelineStatus"] as const)
    .some(key => current[key] !== undefined && previous[key] !== current[key]);
  const reviewDecisionChanged = current.reviewDecision !== undefined && previous.reviewDecision !== current.reviewDecision;
  const review = reviewDecisionChanged || changed("threads") || changed("comments") || changed("reviewComments");
  switch (rule.change) {
    case "merged": return previous.state !== "merged" && current.state === "merged";
    case "review": return review;
    case "checks": return checksChanged;
    case "any": return review || checksChanged || changed("state") || changed("draft") || changed("headSha") || changed("mergeState");
  }
}

function equalObservation(a: Observation, b: Observation): boolean {
  const keys = Object.keys(a) as Array<keyof Observation>;
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}
