import type { CollaborationGoalAccess } from "@joko/contracts";
import { CollaborationSessionRole } from "@joko/contracts";

export type MobileTaskHeaderRole = "ordinary" | "lead" | "worker";

/** Exact generated session access determines presentation, never runtime permissions. */
export function mobileTaskHeaderRole(sessionId: string, access: readonly CollaborationGoalAccess[]): MobileTaskHeaderRole {
  if (!sessionId) throw new Error("A current task is required for its header.");
  const goals = new Set<string>();
  let workers = 0;
  let leads = 0;
  for (const entry of access) {
    const goal = entry.goal;
    if (!goal?.goalId || !goal.leadSessionId || goals.has(goal.goalId)) throw new Error("The task header access is invalid.");
    goals.add(goal.goalId);
    if (entry.role === CollaborationSessionRole.LEAD && goal.leadSessionId === sessionId && !entry.workerId) { leads++; continue; }
    if (entry.role === CollaborationSessionRole.WORKER && goal.leadSessionId !== sessionId && entry.workerId && ++workers === 1) continue;
    throw new Error("The task header access belongs to another task.");
  }
  if (workers > 0 && leads > 0) throw new Error("The task header access has conflicting roles.");
  return workers === 1 ? "worker" : access.length > 0 ? "lead" : "ordinary";
}
