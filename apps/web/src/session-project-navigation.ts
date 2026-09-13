export type SessionProjectNavigationPlacement =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "dialogue" };

export interface ProjectNavigationSession {
  readonly id: string;
  readonly projectId?: string;
}

export interface ProjectMoveSession extends ProjectNavigationSession {
  readonly archived: boolean;
  readonly state: "idle" | "running" | "waiting" | "retrying" | "error" | "closed";
  readonly remoteWorkspace?: boolean;
  readonly runtimeAttached?: boolean;
}

export type SessionProjectMoveBlock = "archived" | "remote" | "busy" | "attached" | "closed";

export function sessionProjectMoveBlock(session: ProjectMoveSession): SessionProjectMoveBlock | undefined {
  if (session.archived) return "archived";
  if (session.remoteWorkspace === true) return "remote";
  if (session.runtimeAttached === true) return "attached";
  if (session.state === "running" || session.state === "waiting" || session.state === "retrying") {
    return "busy";
  }
  if (session.state === "closed") return "closed";
  return undefined;
}

export function sessionProjectPlacement(
  session: ProjectNavigationSession
): SessionProjectNavigationPlacement {
  return session.projectId === undefined
    ? { kind: "dialogue" }
    : { kind: "project", projectId: session.projectId };
}

export function sameSessionProjectPlacement(
  session: ProjectNavigationSession,
  placement: SessionProjectNavigationPlacement
): boolean {
  return placement.kind === "dialogue"
    ? session.projectId === undefined
    : session.projectId === placement.projectId;
}

export function sessionsInProject<T extends ProjectNavigationSession>(
  sessions: readonly T[],
  projectId: string
): readonly T[] {
  return sessions.filter((session) => session.projectId === projectId);
}

export function applySessionProjectOverrides<T extends ProjectNavigationSession>(
  sessions: readonly T[],
  overrides: ReadonlyMap<string, SessionProjectNavigationPlacement>
): readonly T[] {
  if (overrides.size === 0) return sessions;
  let changed = false;
  const projected = sessions.map((session) => {
    const placement = overrides.get(session.id);
    if (placement === undefined || sameSessionProjectPlacement(session, placement)) return session;
    changed = true;
    return {
      ...session,
      projectId: placement.kind === "project" ? placement.projectId : undefined
    };
  });
  return changed ? projected : sessions;
}

/** Clears optimistic entries only after the authoritative projection agrees;
 * entries for removed Sessions are discarded immediately. */
export function reconcileSessionProjectOverrides<T extends ProjectNavigationSession>(
  overrides: ReadonlyMap<string, SessionProjectNavigationPlacement>,
  sessions: readonly T[]
): ReadonlyMap<string, SessionProjectNavigationPlacement> {
  if (overrides.size === 0) return overrides;
  const byId = new Map(sessions.map((session) => [session.id, session] as const));
  const retained = new Map<string, SessionProjectNavigationPlacement>();
  for (const [sessionId, placement] of overrides) {
    const session = byId.get(sessionId);
    if (session !== undefined && !sameSessionProjectPlacement(session, placement)) {
      retained.set(sessionId, placement);
    }
  }
  return retained.size === overrides.size ? overrides : retained;
}

export function rollbackSessionProjectOverride(
  overrides: ReadonlyMap<string, SessionProjectNavigationPlacement>,
  sessionId: string,
  attempted: SessionProjectNavigationPlacement
): ReadonlyMap<string, SessionProjectNavigationPlacement> {
  const current = overrides.get(sessionId);
  if (current === undefined || !sameProjectPlacement(current, attempted)) return overrides;
  const next = new Map(overrides);
  next.delete(sessionId);
  return next;
}

function sameProjectPlacement(
  left: SessionProjectNavigationPlacement,
  right: SessionProjectNavigationPlacement
): boolean {
  return left.kind === "dialogue"
    ? right.kind === "dialogue"
    : right.kind === "project" && left.projectId === right.projectId;
}
