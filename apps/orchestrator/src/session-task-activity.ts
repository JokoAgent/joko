import { randomUUID } from "node:crypto";
import { NotFoundError, type OperationalStore, type StoredSession } from "@joko/store";

export interface SessionTaskActivityProjection {
  readonly runId: string;
  readonly completedReplySummary: string;
  readonly completionNotification: "none" | "pending" | "teammate";
  readonly silent: boolean;
}
const KEY = "task.activity";
interface NotificationOwner { readonly runId: string; readonly completionNotification?: SessionTaskActivityProjection["completionNotification"]; readonly silent?: boolean; }

/** Typed durable ownership is joined only to its exact current Run. */
export function persistSessionTaskActivity(store: OperationalStore, sessionId: string, patch: NotificationOwner): void {
  let session: StoredSession;
  try { session = store.getSession(sessionId); } catch (error) { if (error instanceof NotFoundError) return; throw error; }
  if (session.descriptor.deletedAt !== undefined) return;
  const previous = store.findSetting("session", sessionId, KEY)?.value as NotificationOwner | undefined;
  const next = { ...(previous?.runId === patch.runId ? previous : {}), ...patch };
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  store.transaction(() => {
    store.setSetting("session", sessionId, KEY, next);
    store.appendEvent({ id: randomUUID(), backendId: session.descriptor.backendId, targetId: session.descriptor.targetId,
      sessionId, generation: session.descriptor.binding.generation, emittedAt: Date.now(), traceId: `task-activity:${randomUUID()}`,
      payload: { type: "session_changed" } });
  });
}

export function sessionTaskActivity(store: OperationalStore, session: StoredSession): SessionTaskActivityProjection | undefined {
  const run = store.listRuns({ sessionId: session.descriptor.id, limit: 1 })[0]?.descriptor;
  if (!run) return undefined;
  const row = store.findSetting("session", session.descriptor.id, KEY)?.value as NotificationOwner | undefined;
  const owner = row?.runId === run.id ? row : undefined;
  let completedReplySummary = "";
  if (run.state === "completed" || run.state === "failed") {
    // Never cross the latest input or Run, and never substitute thinking/tool
    // text or an older navigation summary for a reply from this turn.
    for (const event of store.listEvents({ sessionId: session.descriptor.id, order: "desc", limit: 500 })) {
      if (event.runId !== run.id) continue;
      if (event.payload.type !== "message_complete") continue;
      if (event.payload.role === "user") break;
      if (event.payload.role !== "assistant") continue;
      completedReplySummary = event.payload.blocks.filter(block => block.kind === "text").map(block => block.text).join(" ")
        .replace(/\s+/gu, " ").trim().slice(0, 600);
      break;
    }
  }
  return { runId: run.id, completedReplySummary,
    completionNotification: owner?.completionNotification ?? "none", silent: owner?.silent === true };
}
