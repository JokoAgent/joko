/** Complete current mirror bound, shared by native IPC parser and renderer builder. */
export const NATIVE_TASK_STATUS_SESSION_LIMIT = 500;

export interface NativeTaskStatusActivityLine {
  readonly id: string;
  readonly kind: "user" | "assistant" | "status" | "tool";
  readonly text: string;
}

export interface NativeTaskStatusPermission {
  readonly interactionId: string;
  /** Decimal interaction generation, kept lossless across IPC and HTML. */
  readonly generation: string;
  readonly allow: boolean;
  readonly allowForSession: boolean;
  readonly deny: boolean;
}

export interface NativeTaskStatusSession {
  readonly sessionId: string;
  readonly title: string;
  readonly detail: string;
  readonly phase: "running" | "interaction" | "completed" | "error";
  readonly interactionKind?: "permission" | "question" | "plan" | "select" | "confirm" | "input" | "editor";
  /** Private owner handoff without an ordinary interaction or decision. */
  readonly inputHandoff?: true;
  readonly activityLines: readonly NativeTaskStatusActivityLine[];
  readonly startedAt?: number;
  readonly updatedAt: number;
  readonly completionIdentity?: string;
  readonly permission?: NativeTaskStatusPermission;
  readonly remote?: {
    readonly sourceId: string;
    readonly runId: string;
    readonly silent: boolean;
    readonly completionNotification: "none" | "pending" | "teammate";
    readonly observedCompletionOnly?: boolean;
    readonly companion?: { readonly name: string; readonly glyph: string; readonly tint: string; readonly artwork?: string };
  };
}

export interface NativeTaskStatusSnapshot {
  readonly ownerId: string;
  /** Decimal owner-snapshot revision. */
  readonly revision: string;
  readonly locale: "en" | "zh-CN" | "en-XA";
  readonly sessions: readonly NativeTaskStatusSession[];
}

export interface NativeRemoteTaskObservation {
  readonly sessionId: string;
  readonly phase: "running" | "interaction" | "completed" | "error";
  readonly updatedAt?: number;
  readonly completionIdentity?: string;
  readonly remote?: { readonly sourceId: string; readonly runId: string; readonly silent: boolean; readonly completionNotification: "none" | "pending" | "teammate"; readonly observedCompletionOnly?: boolean };
}
interface ObservedTask { phase: NativeRemoteTaskObservation["phase"]; sourceId: string; runId: string; active: boolean; observedActivity: boolean; pending: boolean; passive: boolean; dismissed?: string; }

/** Full current mirrors seed silently. Only an observed activity transition alerts. */
export class NativeRemoteTaskTracker {
  readonly #seen = new Map<string, ObservedTask>();
  observe(sessions: readonly NativeRemoteTaskObservation[]): { readonly passive: ReadonlySet<string>; readonly dismissed: ReadonlySet<string>; readonly events: readonly { readonly sessionId: string; readonly phase: NativeRemoteTaskObservation["phase"] }[] } {
    const retained = new Set<string>(), passive = new Set<string>(), dismissed = new Set<string>();
    const events: { sessionId: string; phase: NativeRemoteTaskObservation["phase"] }[] = [];
    for (const session of sessions) {
      if (!session.remote) continue;
      const { phase, remote, sessionId } = session; retained.add(sessionId);
      let previous = this.#seen.get(sessionId);
      if (!previous || previous.sourceId !== remote.sourceId || previous.runId !== remote.runId && phase !== "running" && phase !== "interaction") {
        previous = { phase, sourceId: remote.sourceId, runId: remote.runId, active: phase === "running" || phase === "interaction", observedActivity: phase === "running" || phase === "interaction", pending: false, passive: true };
        this.#seen.set(sessionId, previous);
      } else {
        const changed = previous.phase !== phase;
        let alert = false;
        if (phase === "interaction" && changed) alert = true;
        if (phase === "error" && changed && previous.active) alert = true;
        if (phase === "completed") {
          const eligible = previous.active || previous.pending;
          if (remote.completionNotification === "pending") previous.pending = eligible;
          else if (remote.completionNotification === "teammate") previous.pending = false;
          else if (eligible && (changed || previous.pending)) { alert = true; previous.pending = false; }
        }
        if (changed) { previous.passive = !alert; previous.dismissed = undefined; }
        if (alert) { previous.passive = false; if (!remote.silent) events.push({ sessionId, phase }); }
        if (phase === "running" || phase === "interaction") { previous.active = true; previous.observedActivity = true; }
        else previous.active = false;
        previous.phase = phase; previous.runId = remote.runId;
      }
      if (remote.silent || phase === "completed" && remote.completionNotification !== "none") previous.passive = true;
      if (previous.passive) passive.add(sessionId);
      if (previous.dismissed === remoteObservationToken(session)) dismissed.add(sessionId);
      if (remote.observedCompletionOnly && !previous.observedActivity) dismissed.add(sessionId);
    }
    for (const key of this.#seen.keys()) if (!retained.has(key)) this.#seen.delete(key);
    return { passive, dismissed, events };
  }
  dismiss(session: NativeRemoteTaskObservation, token: string): boolean {
    const entry = this.#seen.get(session.sessionId);
    if (!session.remote || !entry || token !== remoteEntryToken(session) || (session.phase !== "completed" && session.phase !== "error")) return false;
    entry.dismissed = remoteObservationToken(session); return true;
  }
  reset(): void { this.#seen.clear(); }
}
export function remoteEntryToken(session: NativeRemoteTaskObservation): string {
  const fields = [session.remote?.sourceId ?? "", session.remote?.runId ?? "", session.phase, session.updatedAt ?? 0];
  if (session.completionIdentity !== undefined) fields.push(session.completionIdentity);
  return JSON.stringify(fields);
}
function remoteObservationToken(session: NativeRemoteTaskObservation): string {
  return JSON.stringify([session.remote?.sourceId ?? "", session.remote?.runId ?? "", session.phase]);
}
