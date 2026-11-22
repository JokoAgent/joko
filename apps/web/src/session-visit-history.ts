interface SessionVisitHistory {
  readonly owner?: string;
  readonly ids: readonly string[];
  readonly index: number;
}

export const EMPTY_SESSION_VISIT_HISTORY: SessionVisitHistory = { ids: [], index: -1 };

export function updateSessionVisitHistory(
  prior: SessionVisitHistory,
  owner: string | undefined,
  available: ReadonlySet<string>,
  sessionId: string | undefined,
  hop: { readonly owner: string; readonly id: string; readonly index: number } | undefined
): SessionVisitHistory {
  if (owner === undefined) return EMPTY_SESSION_VISIT_HISTORY;
  const history = prior.owner === owner ? prior : { ...EMPTY_SESSION_VISIT_HISTORY, owner };
  const retained = history.ids.filter(id => available.has(id));
  const before = (index: number) => history.ids.slice(0, index + 1).filter(id => available.has(id)).length - 1;
  const index = Math.min(Math.max(0, before(history.index)), retained.length - 1);
  if (sessionId === undefined || !available.has(sessionId)) return { owner, ids: retained, index };
  if (hop?.owner === owner && hop.id === sessionId && history.ids[hop.index] === sessionId) {
    return { owner, ids: retained, index: before(hop.index) };
  }
  if (retained[index] === sessionId) return { owner, ids: retained, index };
  const ids = [...retained.slice(0, index + 1), sessionId].slice(-50);
  return { owner, ids, index: ids.length - 1 };
}

export function sessionVisitTarget(
  history: SessionVisitHistory,
  owner: string | undefined,
  sessionId: string | undefined,
  direction: -1 | 1
): { readonly owner: string; readonly id: string; readonly index: number } | undefined {
  if (owner === undefined || history.owner !== owner) return;
  const onHistory = sessionId !== undefined && history.ids[history.index] === sessionId;
  if (!onHistory && direction === 1) return;
  const index = onHistory ? history.index + direction : history.index;
  const id = history.ids[index];
  return id === undefined ? undefined : { owner, id, index };
}
