import type { WorkspaceDocumentIdentity, WorkspaceLeaveReason } from "./workspace-document-controller.js";
import { workspaceDocumentController } from "./workspace-document-controller.js";

export interface WorkspaceFilesRouteLike {
  readonly kind: string;
  readonly sessionId?: string;
  readonly file?: string;
}

export interface WorkspaceDocumentLeaveGateRequest {
  readonly reason: WorkspaceLeaveReason;
  readonly matches?: (identity: WorkspaceDocumentIdentity) => boolean;
}

export type WorkspaceDocumentLeaveGate = (request: WorkspaceDocumentLeaveGateRequest) => Promise<boolean>;

let activeGate: WorkspaceDocumentLeaveGate | undefined;

/** The mounted formal Files route owns the localized save/discard/cancel UI. */
export function registerWorkspaceDocumentLeaveGate(gate: WorkspaceDocumentLeaveGate): () => void {
  activeGate = gate;
  return () => {
    if (activeGate === gate) activeGate = undefined;
  };
}

export async function requestWorkspaceDocumentLeave(request: WorkspaceDocumentLeaveGateRequest): Promise<boolean> {
  if (!workspaceDocumentController.shouldPreventUnload(request.matches)) return true;
  // Dirty state without its owning prompt UI must fail closed.
  if (activeGate === undefined) return false;
  try {
    return await activeGate(request);
  } catch {
    return false;
  }
}

export function workspaceRouteLeaveRequest(
  from: WorkspaceFilesRouteLike,
  to: WorkspaceFilesRouteLike
): WorkspaceDocumentLeaveGateRequest | undefined {
  if (from.kind !== "files" || from.sessionId === undefined) return undefined;
  if (to.kind === "files" && to.sessionId === from.sessionId && to.file === from.file) return undefined;
  const reason: WorkspaceLeaveReason = to.kind === "files"
    ? to.sessionId === from.sessionId ? "switch-file" : "switch-session"
    : "route-change";
  return {
    reason,
    matches: (identity) => identity.sessionId === from.sessionId
  };
}
