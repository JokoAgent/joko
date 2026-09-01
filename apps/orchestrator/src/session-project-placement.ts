export type SessionProjectPlacement =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "dialogue" };

export interface ProjectPlacementSessionSnapshot {
  readonly id: string;
  readonly revision: bigint;
  readonly backendId: string;
  readonly targetId: string;
  readonly projectId?: string;
  readonly archived: boolean;
  readonly deleted: boolean;
  readonly remoteWorkspace: boolean;
  readonly runtimeAttached: boolean;
  readonly activity: "idle" | "running" | "waiting" | "recovering" | "closing";
}

export interface ProjectPlacementTargetSnapshot {
  readonly id: string;
  readonly active: boolean;
  readonly remoteWorkspace: boolean;
}

export interface SessionProjectPlacementCommit {
  readonly sessionId: string;
  readonly expectedRevision: bigint;
  /** Undefined is the explicit projectless/dialogue placement. */
  readonly projectId?: string;
}

export interface SessionProjectPlacementCoordinatorOptions {
  readonly readSession: (sessionId: string) => Promise<ProjectPlacementSessionSnapshot | undefined>;
  readonly readProject: (projectId: string) => Promise<ProjectPlacementTargetSnapshot | undefined>;
  readonly commit: (input: SessionProjectPlacementCommit) => Promise<{
    readonly revision: bigint;
    readonly projectId?: string;
  }>;
}

export type SessionProjectPlacementErrorCode =
  | "invalid_identity"
  | "session_not_found"
  | "session_unavailable"
  | "remote_unsupported"
  | "runtime_busy"
  | "runtime_attached"
  | "project_not_found"
  | "project_unavailable";

export class SessionProjectPlacementError extends Error {
  readonly code: SessionProjectPlacementErrorCode;

  constructor(code: SessionProjectPlacementErrorCode, message: string) {
    super(message);
    this.name = "SessionProjectPlacementError";
    this.code = code;
  }
}

export type SessionProjectPlacementResult =
  | {
      readonly kind: "unchanged";
      readonly revision: bigint;
      readonly placement: SessionProjectPlacement;
    }
  | {
      readonly kind: "moved";
      readonly revision: bigint;
      readonly placement: SessionProjectPlacement;
    };

export type SessionProjectPlacementPlan =
  | SessionProjectPlacementResult & { readonly kind: "unchanged" }
  | {
      readonly kind: "ready";
      readonly sessionId: string;
      readonly expectedRevision: bigint;
      readonly placement: SessionProjectPlacement;
      readonly projectId?: string;
    };

export function evaluateSessionProjectPlacement(input: {
  readonly sessionId: string;
  readonly placement: SessionProjectPlacement;
  readonly session?: ProjectPlacementSessionSnapshot;
  readonly project?: ProjectPlacementTargetSnapshot;
}): SessionProjectPlacementPlan {
  const sessionId = boundedIdentity(input.sessionId);
  const projectId = input.placement.kind === "project"
    ? boundedIdentity(input.placement.projectId)
    : undefined;
  const session = input.session;
  if (session === undefined || session.id !== sessionId) {
    throw new SessionProjectPlacementError("session_not_found", "Task was not found.");
  }
  if (session.archived || session.deleted || session.activity === "closing") {
    throw new SessionProjectPlacementError("session_unavailable", "Task cannot be moved in its current state.");
  }
  if (session.remoteWorkspace) {
    throw new SessionProjectPlacementError("remote_unsupported", "Remote tasks cannot be moved between projects.");
  }
  if (session.runtimeAttached) {
    throw new SessionProjectPlacementError("runtime_attached", "Attached tasks cannot be moved between projects.");
  }
  if (session.activity !== "idle") {
    throw new SessionProjectPlacementError("runtime_busy", "Running tasks cannot be moved between projects.");
  }
  const normalizedPlacement = placementFor(projectId);
  if (session.projectId === projectId) {
    return {
      kind: "unchanged",
      revision: session.revision,
      placement: normalizedPlacement
    };
  }
  if (projectId !== undefined) {
    const project = input.project;
    if (project === undefined || project.id !== projectId) {
      throw new SessionProjectPlacementError("project_not_found", "Project was not found.");
    }
    if (!project.active) {
      throw new SessionProjectPlacementError("project_unavailable", "Project is not active.");
    }
    if (project.remoteWorkspace) {
      throw new SessionProjectPlacementError("remote_unsupported", "Remote projects cannot receive local tasks.");
    }
  }
  return {
    kind: "ready",
    sessionId,
    expectedRevision: session.revision,
    placement: normalizedPlacement,
    ...(projectId === undefined ? {} : { projectId })
  };
}

/**
 * Changes only the navigation placement of an idle local Session. The narrow
 * commit surface intentionally has no Target, backend, native binding,
 * worktree, or runtime fields, so callers cannot accidentally retarget work.
 */
export class SessionProjectPlacementCoordinator {
  readonly #options: SessionProjectPlacementCoordinatorOptions;

  constructor(options: SessionProjectPlacementCoordinatorOptions) {
    this.#options = options;
  }

  async move(
    sessionIdValue: string,
    placement: SessionProjectPlacement
  ): Promise<SessionProjectPlacementResult> {
    const sessionId = boundedIdentity(sessionIdValue);
    const projectId = placement.kind === "project" ? boundedIdentity(placement.projectId) : undefined;
    const session = await this.#options.readSession(sessionId);
    const project = projectId === undefined ? undefined : await this.#options.readProject(projectId);
    const plan = evaluateSessionProjectPlacement({
      sessionId,
      placement,
      session,
      project
    });
    if (plan.kind === "unchanged") return plan;
    const committed = await this.#options.commit({
      sessionId: plan.sessionId,
      expectedRevision: plan.expectedRevision,
      ...(plan.projectId === undefined ? {} : { projectId: plan.projectId })
    });
    if (committed.projectId !== plan.projectId) {
      throw new Error("Project placement commit returned a mismatched projection.");
    }
    return {
      kind: "moved",
      revision: committed.revision,
      placement: plan.placement
    };
  }
}

function boundedIdentity(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new SessionProjectPlacementError("invalid_identity", "Project placement identity is invalid.");
  }
  return value;
}

function placementFor(projectId: string | undefined): SessionProjectPlacement {
  return projectId === undefined ? { kind: "dialogue" } : { kind: "project", projectId };
}
