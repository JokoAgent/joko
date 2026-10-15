import type { NativeSessionBinding, SessionWorktreeBinding } from "@joko/core";
import { operationBodyHash, StoreError, type OperationalStore } from "@joko/store";

export const PERSONAL_DEVELOPMENT_PURPOSE_KEY = "personal-development.session-purpose";
export const PERSONAL_DEVELOPMENT_SCOPE = "personal-development";

export interface PersonalDevelopmentPurpose {
  readonly format: 1;
  readonly taskId: string;
  readonly ownerId: string;
  readonly creationOperationId: string;
  readonly sessionId: string;
  readonly targetId: string;
  readonly targetRevision: string;
  readonly backendId: string;
  readonly backendGeneration: number;
  readonly phase: "creating" | "adopted";
  readonly editing: "preparing" | "editing" | "completing" | "completed" | "busy" | "ending" | "ended" | "unknown";
  readonly binding?: NativeSessionBinding;
  readonly worktree?: SessionWorktreeBinding;
  readonly merge?: { readonly id: string; readonly directory: string; readonly leaseId?: string };
  readonly queueItemId?: string;
  readonly runId?: string;
  readonly endingOperationId?: string;
  readonly completion?: { readonly id: string; readonly runId: string; readonly generation: number;
    readonly state: "requested" | "retired" | "completed" | "unknown" };
}

export function readPersonalDevelopmentPurpose(store: OperationalStore, sessionId: string): PersonalDevelopmentPurpose | undefined {
  const value = store.findSetting("service", sessionId, PERSONAL_DEVELOPMENT_PURPOSE_KEY)?.value;
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new StoreError("The personal task purpose is invalid.");
  const raw = value as Record<string, unknown>;
  if (raw["format"] !== 1 || raw["sessionId"] !== sessionId
    || !["taskId", "ownerId", "creationOperationId", "targetId", "targetRevision", "backendId"].every(key => typeof raw[key] === "string" && String(raw[key]).length > 0)
    || !Number.isSafeInteger(raw["backendGeneration"])
    || !["creating", "adopted"].includes(String(raw["phase"]))
    || !["preparing", "editing", "completing", "completed", "busy", "ending", "ended", "unknown"].includes(String(raw["editing"]))
    || raw["phase"] === "adopted" && (raw["binding"] === undefined || raw["worktree"] === undefined && raw["merge"] === undefined)) {
    throw new StoreError("The personal task purpose is invalid.");
  }
  const merge = raw["merge"];
  if (merge !== undefined && (merge === null || typeof merge !== "object" || Array.isArray(merge)
    || !["id", "directory"].every(key => typeof (merge as Record<string, unknown>)[key] === "string")
    || raw["phase"] === "adopted" && typeof (merge as Record<string, unknown>)["leaseId"] !== "string")) {
    throw new StoreError("The personal merge purpose is invalid.");
  }
  const completion = raw["completion"];
  if (completion !== undefined && (completion === null || typeof completion !== "object" || Array.isArray(completion)
    || !["id", "runId"].every(key => typeof (completion as Record<string, unknown>)[key] === "string")
    || !Number.isSafeInteger((completion as Record<string, unknown>)["generation"])
    || !["requested", "retired", "completed", "unknown"].includes(String((completion as Record<string, unknown>)["state"])))) {
    throw new StoreError("The personal task completion purpose is invalid.");
  }
  return value as PersonalDevelopmentPurpose;
}

export function savePersonalDevelopmentPurpose(store: OperationalStore, purpose: PersonalDevelopmentPurpose): void {
  // Preserve absent current-v1 fields before the Store's canonical JSON writer.
  store.setSetting("service", purpose.sessionId, PERSONAL_DEVELOPMENT_PURPOSE_KEY, JSON.parse(JSON.stringify(purpose)) as PersonalDevelopmentPurpose);
}

/** Admission and dispatch share this guard; a stale client cannot edit a
 * checkout while its source, build, test or completion owner holds it. */
export function assertPersonalDevelopmentInput(store: OperationalStore, sessionId: string): void {
  const purpose = readPersonalDevelopmentPurpose(store, sessionId);
  if (purpose !== undefined && (purpose.phase !== "adopted" || purpose.editing !== "editing")) {
    throw new StoreError("Continue the personal task after its preparation, completion, test or build finishes.");
  }
}

export function samePersonalWorktree(left: SessionWorktreeBinding, right: SessionWorktreeBinding): boolean {
  const identity = (value: SessionWorktreeBinding) => ({
    leaseId: value.leaseId, workspaceId: value.workspaceId, path: value.path, repositoryRoot: value.repositoryRoot,
    branch: value.branch, sourceRef: value.sourceRef, sourceCommit: value.sourceCommit,
    sourceStrategy: value.sourceStrategy, sourceRefreshed: value.sourceRefreshed,
    sourceRemote: value.sourceRemote, acquiredAt: value.acquiredAt, remote: value.remote
  });
  return left.remote === undefined && right.remote === undefined && operationBodyHash(identity(left)) === operationBodyHash(identity(right));
}
