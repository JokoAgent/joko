import type { QueueItemView, SessionView } from "../model.js";

export type ReviewGitWriteBlock = "agent-running" | "queued-work";

const TERMINAL_QUEUE_STATES = new Set<QueueItemView["state"]>([
  "completed",
  "cancelled",
  "failed"
]);

/** Git Review writes affect every task bound to the workspace Target. */
export function reviewGitWriteBlock(
  sessions: readonly SessionView[],
  queue: readonly QueueItemView[],
  targetId: string
): ReviewGitWriteBlock | undefined {
  const targetSessionIds = new Set(
    sessions
      .filter((session) => session.targetId === targetId)
      .map((session) => session.id)
  );
  if (sessions.some((session) =>
    targetSessionIds.has(session.id) && (
      session.activeRunId !== undefined ||
      session.state === "running" ||
      session.state === "waiting" ||
      session.state === "retrying"
    )
  )) return "agent-running";
  if (queue.some((item) =>
    targetSessionIds.has(item.sessionId) && !TERMINAL_QUEUE_STATES.has(item.state)
  )) return "queued-work";
  return undefined;
}
