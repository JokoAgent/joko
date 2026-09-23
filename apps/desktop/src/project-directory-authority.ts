import type { DesktopManagedOrchestratorConnection, DesktopManagedOrchestratorStatus, DesktopProjectDirectoryRequest } from "./channels.js";

/** A renderer path is meaningful on this machine only for the exact managed service identity. */
export function projectDirectoryAuthorityMatches(
  request: DesktopProjectDirectoryRequest,
  status: DesktopManagedOrchestratorStatus,
  runtimeConnection: DesktopManagedOrchestratorConnection | undefined,
  savedConnection: DesktopManagedOrchestratorConnection | undefined,
  shuttingDown: boolean
): boolean {
  if (status.state !== "ready" || runtimeConnection === undefined || savedConnection === undefined || shuttingDown) return false;
  const owner = status.connection;
  return request.profileId === owner.profileId && request.deviceId === owner.deviceId
    && request.serverId === owner.serverId && request.origin === owner.origin
    && sameConnection(runtimeConnection, owner) && sameConnection(savedConnection, owner);
}

function sameConnection(left: DesktopManagedOrchestratorConnection, right: DesktopManagedOrchestratorConnection): boolean {
  return left.profileId === right.profileId && left.deviceId === right.deviceId && left.serverId === right.serverId
    && left.name === right.name && left.origin === right.origin;
}
