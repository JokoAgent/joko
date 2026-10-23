import type { WorkspaceDescriptor } from "@joko/contracts";

/** Compare durable workspace identities, never a remote display path with a local path. */
export function sameMobileModelSourceProject(left: WorkspaceDescriptor, right: WorkspaceDescriptor): boolean {
  if (left.kind !== right.kind || left.location?.kind.case !== right.location?.kind.case) return false;
  const source = left.location?.kind, destination = right.location?.kind;
  if (source?.case === "serviceNode" && destination?.case === "serviceNode") {
    return left.serverPathDisplay !== "" && left.serverPathDisplay === right.serverPathDisplay;
  }
  if (source?.case === "sshHost" && destination?.case === "sshHost") {
    return source.value.hostTargetId === destination.value.hostTargetId && source.value.hostId === destination.value.hostId
      && source.value.workspaceRootDisplay === destination.value.workspaceRootDisplay;
  }
  return source?.case === "devicePeer" && destination?.case === "devicePeer"
    && source.value.controllerDeviceId === destination.value.controllerDeviceId && source.value.targetDeviceId === destination.value.targetDeviceId
    && source.value.workspaceRootDisplay === destination.value.workspaceRootDisplay;
}
