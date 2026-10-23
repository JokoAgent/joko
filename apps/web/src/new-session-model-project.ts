import type { AppController } from "./controller.js";
import type { AppSnapshot, RemoteWorkspaceView, TargetView } from "./model.js";

function sameRemote(left: RemoteWorkspaceView | undefined, right: RemoteWorkspaceView | undefined): boolean {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind || left.workspaceRoot !== right.workspaceRoot) return false;
  return left.kind === "ssh" && right.kind === "ssh"
    ? left.hostTargetId === right.hostTargetId && left.hostId === right.hostId
    : left.kind === "device_peer" && right.kind === "device_peer"
      && left.controllerDeviceId === right.controllerDeviceId && left.targetDeviceId === right.targetDeviceId;
}

/** Stable filesystem identity is independent of the engine chosen for a draft. */
export function findNewSessionModelProject(snapshot: AppSnapshot, source: TargetView, backendId: string): TargetView | undefined {
  const workspace = snapshot.workspaces.find(row => row.id === source.workspaceId);
  if (!workspace) return undefined;
  const remote = source.remoteWorkspace ?? workspace.remoteWorkspace;
  return snapshot.targets.find(row => {
    if (row.archived || row.backendId !== backendId) return false;
    const candidate = snapshot.workspaces.find(item => item.id === row.workspaceId);
    if (!candidate || candidate.kind !== workspace.kind) return false;
    const candidateRemote = row.remoteWorkspace ?? candidate.remoteWorkspace;
    return remote ? sameRemote(remote, candidateRemote)
      : !candidateRemote && candidate.serverPath === workspace.serverPath;
  });
}

export async function ensureNewSessionModelProject(controller: AppController, snapshot: AppSnapshot, source: TargetView,
  backendId: string, assertCurrent: () => void): Promise<string> {
  assertCurrent();
  const workspace = snapshot.workspaces.find(row => row.id === source.workspaceId);
  if (!workspace) throw new Error("The current project is unavailable. Reopen it before changing model sources.");
  const remote = source.remoteWorkspace ?? workspace.remoteWorkspace;
  if (remote?.kind === "ssh" && snapshot.backends.find(row => row.id === backendId)?.capabilities.get("model.remote_execution")?.supported) {
    throw new Error("This Agent source requires a project on the task computer and cannot use an SSH project.");
  }
  const existing = findNewSessionModelProject(snapshot, source, backendId);
  if (existing) return existing.id;
  let targetId: string;
  if (!remote) {
    targetId = await controller.createTarget({ backendId, name: source.name, workspaceKind: workspace.kind,
      serverPath: workspace.serverPath, createIfMissing: false });
  } else if (remote.kind === "ssh") {
    const hosts = await controller.listRemoteHosts(remote.hostTargetId); assertCurrent();
    const hostTarget = controller.state.snapshot.targets.find(row => row.id === remote.hostTargetId && !row.archived);
    const exact = hosts.filter(row => row.targetId === remote.hostTargetId && row.id === remote.hostId);
    if (!hostTarget || hostTarget.revision < 1n || exact.length !== 1 || exact[0]!.revision < 1n) {
      throw new Error("The original SSH Host authority is unavailable. Reconnect before switching model sources.");
    }
    targetId = await controller.createRemoteTarget({ backendId, name: source.name, hostTargetId: remote.hostTargetId,
      hostId: remote.hostId, expectedHostTargetRevision: hostTarget.revision, expectedHostRevision: exact[0]!.revision,
      workspacePath: remote.workspaceRoot, createIfMissing: false });
  } else {
    if (controller.state.activeProfile?.deviceId !== remote.controllerDeviceId) throw new Error("The original task computer belongs to another controller.");
    const peers = await controller.listDevicePeers(); assertCurrent();
    const exact = peers.filter(row => row.route.targetDeviceId === remote.targetDeviceId);
    if (exact.length !== 1) throw new Error("The original task computer is unavailable. Reconnect before switching model sources.");
    targetId = await controller.createDevicePeerTarget({ backendId, name: source.name, peer: exact[0]!.route,
      workspacePath: remote.workspaceRoot, createIfMissing: false });
  }
  assertCurrent();
  return targetId;
}
