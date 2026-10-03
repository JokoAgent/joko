import { useEffect, useMemo, useRef, useState } from "react";
import type { AppController } from "./controller.js";
import type { CollaborationGoalView, SessionView } from "./model.js";
import type { DedicatedHardwareTaskActivity, DedicatedHardwareTaskCatalog } from "./dedicated-hardware.js";
import { dedicatedHardwareTaskActivity } from "./dedicated-hardware-app.js";

const REFRESH_MS = 10_000;
const ACTIVITY_REFRESH_MS = 250;
const REQUEST_TIMEOUT_MS = 5_000;
const ROUND_TIMEOUT_MS = 5_000;
const ROUND_REQUEST_BUDGET = 128;
const CONCURRENCY = 4;

interface SessionIdentity {
  readonly sessionId: string;
  readonly sessionGeneration: string;
}

export interface DedicatedHardwareCollaborationRelation {
  readonly lead: SessionIdentity;
  readonly workers: readonly SessionIdentity[];
}

interface CachedLead {
  readonly lead: SessionIdentity;
  readonly goals: Map<string, { readonly revision: bigint; readonly workers: readonly SessionIdentity[] }>;
  nextGoal: number;
}

interface RelationSnapshot {
  readonly scope: string;
  readonly relations: readonly DedicatedHardwareCollaborationRelation[];
}

export interface DedicatedHardwareCollaborationSource {
  readonly state: {
    readonly ready: boolean;
    readonly connectionState: AppController["state"]["connectionState"];
    readonly connectionGeneration?: number;
    readonly activeProfile?: { readonly id: string; readonly serverId: string };
    readonly snapshot: Pick<AppController["state"]["snapshot"], "generation" | "sessions" | "interactions">;
  };
  readonly listCollaborationGoals: AppController["listCollaborationGoals"];
  readonly getCollaborationGoal: AppController["getCollaborationGoal"];
}

export function foldDedicatedHardwareCollaborationActivity(
  catalog: DedicatedHardwareTaskCatalog,
  relations: readonly DedicatedHardwareCollaborationRelation[],
  sessions: readonly SessionView[],
  interactions: AppController["state"]["snapshot"]["interactions"]
): DedicatedHardwareTaskCatalog {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const byLead = new Map(relations.map((relation) => [relation.lead.sessionId, relation]));
  let changed = false;
  const tasks = catalog.tasks.map((task) => {
    const relation = byLead.get(task.sessionId);
    const lead = byId.get(task.sessionId);
    if (!task.catalogEligible || relation === undefined || lead === undefined || lead.archived || lead.state === "closed"
      || relation.lead.sessionGeneration !== task.sessionGeneration || lead.generation.toString(10) !== task.sessionGeneration) return task;
    let best = task.activity;
    for (const identity of relation.workers) {
      const worker = byId.get(identity.sessionId);
      if (worker === undefined || worker.generation.toString(10) !== identity.sessionGeneration) continue;
      const activity = dedicatedHardwareTaskActivity(worker, interactions);
      if (activityRank(activity) > activityRank(best)) best = activity;
    }
    if (best === task.activity) return task;
    changed = true;
    return { ...task, activity: best };
  });
  return changed ? { ...catalog, tasks } : catalog;
}

export function useDedicatedHardwareCollaborationCatalog(
  controller: DedicatedHardwareCollaborationSource,
  catalog: DedicatedHardwareTaskCatalog | undefined
): DedicatedHardwareTaskCatalog | undefined {
  const latest = useRef({ controller, catalog });
  latest.current = { controller, catalog };
  const pageRetired = useRef(false);
  const activityRefresh = useRef<(() => void) | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<RelationSnapshot>();
  useEffect(() => {
    const retire = (): void => { pageRetired.current = true; setSnapshot(undefined); };
    window.addEventListener("pagehide", retire);
    return () => window.removeEventListener("pagehide", retire);
  }, []);
  const state = controller.state;
  const activityKey = useMemo(() => JSON.stringify([...state.snapshot.sessions]
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .map((session) => {
      const activity = dedicatedHardwareTaskActivity(session, state.snapshot.interactions);
      return [session.id, session.generation.toString(10), session.backendId, session.targetId,
        session.archived, session.state === "closed", activity.phase, activity.attention,
        state.snapshot.interactions.filter((interaction) => interaction.sessionId === session.id
          && interaction.generation === session.generation).map((interaction) => interaction.id).sort()];
    })), [state.snapshot.sessions, state.snapshot.interactions]);
  const leads = catalog?.tasks.filter((task) => task.catalogEligible && task.sidebarOrder !== null
    && state.snapshot.sessions.some((session) => session.id === task.sessionId && !session.archived && session.state !== "closed"
      && session.generation.toString(10) === task.sessionGeneration))
    .sort((left, right) => left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0) ?? [];
  const scope = catalog === undefined || !state.ready || state.connectionState !== "connected" || leads.length === 0
    || state.connectionGeneration === undefined
    || state.activeProfile?.id !== catalog.profileId || state.activeProfile.serverId !== catalog.serverId
    || state.snapshot.generation.toString(10) !== catalog.connectionGeneration ? undefined : JSON.stringify([
      catalog.profileId, catalog.serverId, catalog.connectionGeneration, state.connectionGeneration,
      leads.map((lead) => [lead.sessionId, lead.sessionGeneration, lead.targetId])
    ]);

  useEffect(() => {
    setSnapshot(undefined);
    if (scope === undefined || catalog === undefined || pageRetired.current) return;
    const abort = new AbortController();
    const cache = new Map<string, CachedLead>();
    const expectedConnection = state.connectionGeneration;
    type RelationQuery = { readonly kind: "lead"; readonly lead: typeof leads[number]; readonly index: number }
      | { readonly kind: "goal"; readonly lead: typeof leads[number]; readonly goal: CollaborationGoalView;
        readonly retained: CachedLead; readonly nextGoal: number };
    interface RefreshPass { readonly queries: RelationQuery[]; nextQuery: number }
    let nextLead = 0;
    let pass: RefreshPass | undefined;
    let timer: number | undefined;
    let continuationTimer: number | undefined;
    let timerIsActivity = false;
    let refreshInFlight = false;
    let refreshQueued = false;
    const current = (): boolean => {
      const now = latest.current;
      return !abort.signal.aborted && !pageRetired.current && now.controller === controller && now.catalog !== undefined
        && now.controller.state.ready && now.controller.state.connectionState === "connected"
        && now.controller.state.connectionGeneration === expectedConnection
        && now.controller.state.activeProfile?.id === catalog.profileId
        && now.controller.state.activeProfile.serverId === catalog.serverId
        && now.controller.state.snapshot.generation.toString(10) === catalog.connectionGeneration;
    };
    const currentLead = (lead: typeof leads[number]): boolean => current() && latest.current.catalog!.tasks.some((task) =>
      task.catalogEligible && task.sidebarOrder !== null && task.sessionId === lead.sessionId && task.sessionGeneration === lead.sessionGeneration)
      && latest.current.controller.state.snapshot.sessions.some((session) => session.id === lead.sessionId && !session.archived
        && session.state !== "closed" && session.generation.toString(10) === lead.sessionGeneration);
    const publishCache = (): void => {
      if (!current()) return;
      setSnapshot({ scope, relations: [...cache.values()].map((lead) => ({
        lead: lead.lead, workers: [...new Map([...lead.goals.values()].flatMap((goal) => goal.workers).map((worker) => [worker.sessionId, worker])).values()]
      })) });
    };
    const loadLead = async (lead: typeof leads[number], refreshPass: RefreshPass, signal: AbortSignal): Promise<void> => {
      if (!currentLead(lead) || signal.aborted) return;
      const identity = { sessionId: lead.sessionId, sessionGeneration: lead.sessionGeneration };
      try {
        const listed = await boundedQuery(signal, (querySignal) => latest.current.controller.listCollaborationGoals(lead.sessionId, false, querySignal));
        if (!currentLead(lead)) return;
        const goals = listed.filter((goal) => goalMatches(goal, lead)).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
        if (new Set(goals.map((goal) => goal.id)).size !== goals.length) { cache.delete(lead.sessionId); publishCache(); return; }
        const retained: CachedLead = cache.get(lead.sessionId) ?? { lead: identity, goals: new Map(), nextGoal: 0 };
        const byGoalId = new Map(goals.map((goal) => [goal.id, goal]));
        for (const [id, cached] of retained.goals) {
          if (byGoalId.get(id)?.revision !== cached.revision) retained.goals.delete(id);
        }
        cache.set(lead.sessionId, retained);
        publishCache();
        for (let index = 0; index < goals.length; index += 1) {
          const goalIndex = (retained.nextGoal + index) % goals.length;
          refreshPass.queries.push({ kind: "goal", lead, goal: goals[goalIndex]!, retained, nextGoal: (goalIndex + 1) % goals.length });
        }
        if (goals.length === 0) retained.nextGoal = 0;
      } catch { if (currentLead(lead)) { cache.delete(lead.sessionId); publishCache(); } }
    };
    const loadGoal = async (query: Extract<RelationQuery, { readonly kind: "goal" }>, signal: AbortSignal): Promise<void> => {
      const { lead, goal, retained } = query;
      try {
        const tree = await boundedQuery(signal, (querySignal) => latest.current.controller.getCollaborationGoal(goal.id, lead.sessionId, querySignal));
        if (!currentLead(lead)) return;
        if (tree.goal.id !== goal.id || !goalMatches(tree.goal, lead) || tree.goal.revision < goal.revision) {
          retained.goals.delete(goal.id); publishCache(); return;
        }
        const sessions = new Map(latest.current.controller.state.snapshot.sessions.map((session) => [session.id, session]));
        const workers = new Map<string, SessionIdentity>();
        for (const worker of tree.workers) {
          if (worker.goalId !== goal.id || worker.sessionId === undefined || worker.sessionGeneration === undefined
            || worker.sessionId === lead.sessionId) continue;
          const session = sessions.get(worker.sessionId);
          if (session === undefined || session.archived || session.state === "closed" || session.generation !== worker.sessionGeneration
            || session.targetId !== worker.route.targetId || session.backendId !== worker.route.backendId) continue;
          workers.set(session.id, { sessionId: session.id, sessionGeneration: session.generation.toString(10) });
        }
        retained.goals.set(goal.id, { revision: tree.goal.revision, workers: [...workers.values()] });
        publishCache();
      } catch { retained.goals.delete(goal.id); publishCache(); }
    };
    const clearRefreshTimer = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      timerIsActivity = false;
    };
    const clearContinuationTimer = (): void => {
      if (continuationTimer !== undefined) window.clearTimeout(continuationTimer);
      continuationTimer = undefined;
    };
    const scheduleRefresh = (delayMs: number, activity: boolean): void => {
      timerIsActivity = activity;
      timer = window.setTimeout(() => {
        timer = undefined;
        timerIsActivity = false;
        void refresh();
      }, delayMs);
    };
    const refresh = async (continuePass = false): Promise<void> => {
      if (!current()) return;
      if (refreshInFlight) { if (!continuePass) refreshQueued = true; return; }
      clearContinuationTimer();
      if (!continuePass || pass === undefined) {
        pass = { nextQuery: 0, queries: Array.from({ length: leads.length }, (_, index) => {
          const leadIndex = (nextLead + index) % leads.length;
          return { kind: "lead", lead: leads[leadIndex]!, index: leadIndex };
        }) };
      }
      const refreshPass = pass;
      refreshInFlight = true;
      try {
        const round = new AbortController();
        const cancelRound = (): void => round.abort();
        abort.signal.addEventListener("abort", cancelRound, { once: true });
        const roundTimer = window.setTimeout(cancelRound, ROUND_TIMEOUT_MS);
        try {
          await new Promise<void>((resolve) => {
            let requests = 0;
            let inFlight = 0;
            const pump = (): void => {
              while (inFlight < CONCURRENCY && requests < ROUND_REQUEST_BUDGET && current() && !round.signal.aborted
                && refreshPass.nextQuery < refreshPass.queries.length) {
                const query = refreshPass.queries[refreshPass.nextQuery++]!;
                if (!currentLead(query.lead)) continue;
                requests += 1;
                inFlight += 1;
                if (query.kind === "lead") nextLead = (query.index + 1) % leads.length;
                else query.retained.nextGoal = query.nextGoal;
                const settled = (): void => { inFlight -= 1; pump(); };
                void (query.kind === "lead" ? loadLead(query.lead, refreshPass, round.signal) : loadGoal(query, round.signal))
                  .then(settled, settled);
              }
              if (inFlight === 0) resolve();
            };
            pump();
          });
        } finally {
          window.clearTimeout(roundTimer);
          abort.signal.removeEventListener("abort", cancelRound);
        }
        publishCache();
      } finally {
        refreshInFlight = false;
        if (current()) {
          if (refreshQueued) {
            refreshQueued = false;
            void refresh();
          } else if (refreshPass.nextQuery < refreshPass.queries.length) {
            continuationTimer = window.setTimeout(() => { continuationTimer = undefined; void refresh(true); }, 0);
          } else if (timer === undefined) {
            pass = undefined;
            scheduleRefresh(REFRESH_MS, false);
          }
        } else {
          pass = undefined;
          refreshQueued = false;
        }
      }
    };
    const scheduleActivityRefresh = (): void => {
      if (!current() || refreshQueued || timerIsActivity) return;
      clearRefreshTimer();
      scheduleRefresh(ACTIVITY_REFRESH_MS, true);
    };
    activityRefresh.current = scheduleActivityRefresh;
    const retire = (): void => {
      pageRetired.current = true;
      abort.abort();
      clearRefreshTimer();
      clearContinuationTimer();
      pass = undefined;
      refreshQueued = false;
      if (activityRefresh.current === scheduleActivityRefresh) activityRefresh.current = undefined;
      setSnapshot(undefined);
    };
    window.addEventListener("pagehide", retire);
    scheduleActivityRefresh();
    return () => {
      abort.abort();
      clearRefreshTimer();
      clearContinuationTimer();
      pass = undefined;
      refreshQueued = false;
      if (activityRefresh.current === scheduleActivityRefresh) activityRefresh.current = undefined;
      window.removeEventListener("pagehide", retire);
    };
  }, [scope, controller]);

  useEffect(() => { activityRefresh.current?.(); }, [activityKey, scope, controller]);

  return useMemo(() => catalog === undefined || scope === undefined || snapshot?.scope !== scope || pageRetired.current ? catalog
    : foldDedicatedHardwareCollaborationActivity(catalog, snapshot.relations, state.snapshot.sessions, state.snapshot.interactions),
  [catalog, scope, snapshot, state.snapshot.sessions, state.snapshot.interactions]);
}

function goalMatches(goal: CollaborationGoalView, lead: { readonly sessionId: string; readonly sessionGeneration: string; readonly targetId: string }): boolean {
  return goal.status === "active" && goal.leadSessionId === lead.sessionId
    && goal.sessionGeneration.toString(10) === lead.sessionGeneration && goal.targetId === lead.targetId;
}

function activityRank(activity: DedicatedHardwareTaskActivity): number {
  if (activity.phase === null || activity.phase !== "running" && activity.phase !== "needs-interaction" && !activity.attention) return 0;
  const ranks = { "needs-interaction": 4, error: 3, running: 2, completed: 1 };
  return ranks[activity.phase] + (activity.attention ? 0.1 : 0);
}

async function boundedQuery<T>(parent: AbortSignal, query: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  const cancel = (): void => abort.abort();
  parent.addEventListener("abort", cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (parent.aborted) throw new DOMException("Query owner retired.", "AbortError");
    return await Promise.race([query(abort.signal), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new DOMException("Query timed out.", "TimeoutError")); }, REQUEST_TIMEOUT_MS);
      abort.signal.addEventListener("abort", () => reject(new DOMException("Query owner retired.", "AbortError")), { once: true });
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parent.removeEventListener("abort", cancel);
  }
}
