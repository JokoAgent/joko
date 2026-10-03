import { QueueItemState, type QueueItem } from "@joko/contracts";
import {
  mobileComposerInput,
  mobileInputSummary,
  type MobileComposerDraft
} from "./mobile-composer-document";
import type { TimelineRow } from "./timeline";

type OptimisticQueueItem = Pick<QueueItem, "sessionId" | "sourceId" | "state">;

/** Queue identities that still own a pending transcript handoff. */
export function mobileOptimisticActiveOperationIds(
  items: readonly OptimisticQueueItem[],
  sessionId: string | undefined
): ReadonlySet<string> {
  if (!sessionId) return new Set();
  return new Set(items.flatMap((item) => item.sessionId === sessionId && item.sourceId
    && (item.state === QueueItemState.ACCEPTED
      || item.state === QueueItemState.DISPATCHING
      || item.state === QueueItemState.BACKEND_ACCEPTED)
    ? [item.sourceId]
    : []));
}

/** Any non-terminal Queue activity prevents inventing a new local turn boundary. */
export function mobileQueueBlocksOptimisticUserRow(
  items: readonly OptimisticQueueItem[],
  sessionId: string | undefined
): boolean {
  return !!sessionId && items.some((item) => item.sessionId === sessionId
    && (item.state === QueueItemState.ACCEPTED
      || item.state === QueueItemState.DISPATCHING
      || item.state === QueueItemState.BACKEND_ACCEPTED
      || item.state === QueueItemState.DISPATCH_UNKNOWN));
}

/** Page-local presentation state. Durable send authority remains with the operation receipt. */
export interface MobileOptimisticUserRow {
  readonly ownerKey: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly phase: "dispatching" | "submitted";
  readonly row: TimelineRow;
  readonly precedingRowIds: ReadonlySet<string>;
}

/** Reserve the idle-send slot before dispatch, using only already observed ordering. */
export function appendMobileOptimisticUserRow(
  current: readonly MobileOptimisticUserRow[],
  observedRows: readonly TimelineRow[],
  ownerKey: string,
  sessionId: string,
  operationId: string,
  draft: MobileComposerDraft
): readonly MobileOptimisticUserRow[] {
  if (current.some((entry) => entry.sessionId === sessionId && entry.operationId === operationId)
    || observedRows.some((row) => durableUserEcho(row, operationId))) return current;

  const rowId = `optimistic-user:${operationId}`;
  const row: TimelineRow = {
    id: rowId,
    label: "You",
    text: mobileInputSummary(mobileComposerInput(draft)),
    sequence: 0n,
    eventId: operationId,
    kind: "user",
    completed: false,
    operationId,
    optimistic: true
  };
  return [...current, {
    ownerKey,
    sessionId,
    operationId,
    phase: "dispatching",
    row,
    precedingRowIds: new Set([
      ...observedRows.map((candidate) => candidate.id),
      ...current.filter((entry) => entry.sessionId === sessionId).map((entry) => entry.row.id)
    ])
  }];
}

/** The initial request returned accepted; later activity must now come from exact durable identity. */
export function markMobileOptimisticUserRowSubmitted(
  current: readonly MobileOptimisticUserRow[],
  sessionId: string,
  operationId: string
): readonly MobileOptimisticUserRow[] {
  let changed = false;
  const next = current.map((entry) => {
    if (entry.sessionId !== sessionId || entry.operationId !== operationId || entry.phase === "submitted") return entry;
    changed = true;
    return { ...entry, phase: "submitted" as const };
  });
  return changed ? next : current;
}

/**
 * Keep each reservation in its observed slot. A durable user echo takes over that
 * slot without lending its identity or position to any other optimistic entry.
 */
export function projectMobileOptimisticUserRows(
  observedRows: readonly TimelineRow[],
  current: readonly MobileOptimisticUserRow[],
  ownerKey: string,
  sessionId: string
): readonly TimelineRow[] {
  const entries = current.filter((entry) => entry.ownerKey === ownerKey && entry.sessionId === sessionId);
  if (entries.length === 0) return observedRows;

  const projected = observedRows.map((row) => ({ row, optimisticSlotId: undefined as string | undefined }));
  for (const entry of entries) {
    const echoIndex = projected.findIndex(({ row }) => durableUserEcho(row, entry.operationId));
    const row = echoIndex < 0 ? entry.row : projected.splice(echoIndex, 1)[0]!.row;
    let after = -1;
    for (let index = 0; index < projected.length; index += 1) {
      const candidate = projected[index]!;
      if (entry.precedingRowIds.has(candidate.row.id)
        || (candidate.optimisticSlotId !== undefined
          && entry.precedingRowIds.has(candidate.optimisticSlotId))) after = index;
    }
    projected.splice(after + 1, 0, { row, optimisticSlotId: entry.row.id });
  }
  return projected.map((entry) => entry.row);
}

/** Hand an echoed reservation to the durable Timeline while preserving other owners. */
export function reconcileMobileOptimisticUserRows(
  current: readonly MobileOptimisticUserRow[],
  observedRows: readonly TimelineRow[],
  ownerKey: string,
  sessionId: string,
  activeOperationIds: ReadonlySet<string>
): readonly MobileOptimisticUserRow[] {
  if (current.length === 0) return current;
  const echoedRows = new Map(observedRows.flatMap((row) =>
    row.kind === "user" && row.optimistic !== true && row.operationId ? [[row.operationId, row.id] as const] : []
  ));
  const activeEntries = current.filter((entry) => entry.ownerKey === ownerKey && entry.sessionId === sessionId
    && !echoedRows.has(entry.operationId)
    && (entry.phase === "dispatching" || activeOperationIds.has(entry.operationId)));
  const requiredAnchorIds = new Set(activeEntries.flatMap((entry) => [...entry.precedingRowIds]));
  const remaining = current.filter((entry) => {
    if (entry.ownerKey !== ownerKey) return false;
    if (entry.sessionId !== sessionId) return true;
    if (echoedRows.has(entry.operationId)) return requiredAnchorIds.has(entry.row.id);
    return entry.phase === "dispatching" || activeOperationIds.has(entry.operationId);
  });
  return remaining.length === current.length ? current : remaining;
}

/** Retire one reservation after a definitive rejection or an unknown result. */
export function retireMobileOptimisticUserRow(
  current: readonly MobileOptimisticUserRow[],
  sessionId: string,
  operationId: string
): readonly MobileOptimisticUserRow[] {
  const remaining = current.filter((entry) => entry.sessionId !== sessionId
    || entry.operationId !== operationId);
  return remaining.length === current.length ? current : remaining;
}

/** Retire every page-local reservation when its exact Session owner leaves the surface. */
export function retireMobileOptimisticUserRowsForSession(
  current: readonly MobileOptimisticUserRow[],
  sessionId: string
): readonly MobileOptimisticUserRow[] {
  const remaining = current.filter((entry) => entry.sessionId !== sessionId);
  return remaining.length === current.length ? current : remaining;
}

function durableUserEcho(row: TimelineRow, operationId: string): boolean {
  return row.kind === "user" && row.optimistic !== true && row.operationId === operationId;
}
