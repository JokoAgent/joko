import { expect, it, vi } from "vitest";
import type { AppController } from "./controller.js";
import { emptySnapshot, type AppSnapshot, type RemoteWorkspaceView, type TargetView } from "./model.js";
import { ensureNewSessionModelProject, findNewSessionModelProject } from "./new-session-model-project.js";

function fixture(remote: RemoteWorkspaceView) {
  const source: TargetView = { id: "source", backendId: "first", name: "Project", revision: 7n, workspaceId: "workspace",
    workspaceName: "Project", trusted: true, pinned: false, archived: false, remoteWorkspace: remote };
  const snapshot: AppSnapshot = { ...emptySnapshot(), targets: [source, { ...source, id: "host-target", revision: 11n }],
    workspaces: [{ id: "workspace", targetId: "source", name: "Project", serverPath: "/service/fallback", kind: "userProject", trusted: true, remoteWorkspace: remote, dirty: false, entries: [] }] };
  const controller = { state: { activeProfile: { deviceId: "controller" }, snapshot },
    createTarget: vi.fn(async () => "wrong-local"),
    createRemoteTarget: vi.fn(async () => "created-ssh"), createDevicePeerTarget: vi.fn(async () => "created-peer"),
    listRemoteHosts: vi.fn(async () => [{ targetId: "host-target", id: "host", revision: 13n }]),
    listDevicePeers: vi.fn(async () => [{ route: { targetDeviceId: "peer", relationId: "relation", targetDeviceRevision: 2n, relationRevision: 3n, routeGeneration: 5n } }])
  } as unknown as AppController;
  return { source, snapshot, controller };
}
it("switches a draft engine while preserving the exact SSH Host and directory authority", async () => {
  const { source, snapshot, controller } = fixture({ kind: "ssh", hostTargetId: "host-target", hostId: "host", workspaceRoot: "/remote/project" });
  expect(await ensureNewSessionModelProject(controller, snapshot, source, "second", () => undefined)).toBe("created-ssh");
  expect(controller.createRemoteTarget).toHaveBeenCalledWith({ backendId: "second", name: "Project", hostTargetId: "host-target", hostId: "host",
    expectedHostTargetRevision: 11n, expectedHostRevision: 13n, workspacePath: "/remote/project", createIfMissing: false });
  expect(controller.createTarget).not.toHaveBeenCalled();
});
it("uses the current Device route for the same controlled computer and rejects a late catalog", async () => {
  const { source, snapshot, controller } = fixture({ kind: "device_peer", controllerDeviceId: "controller", targetDeviceId: "peer", workspaceRoot: "D:\\project" });
  expect(await ensureNewSessionModelProject(controller, snapshot, source, "second", () => undefined)).toBe("created-peer");
  expect(controller.createDevicePeerTarget).toHaveBeenCalledWith(expect.objectContaining({ backendId: "second", workspacePath: "D:\\project", createIfMissing: false,
    peer: { targetDeviceId: "peer", relationId: "relation", targetDeviceRevision: 2n, relationRevision: 3n, routeGeneration: 5n } }));
  vi.mocked(controller.createDevicePeerTarget).mockClear(); let checks = 0;
  await expect(ensureNewSessionModelProject(controller, snapshot, source, "second", () => { if (++checks > 1) throw new Error("Owner changed"); })).rejects.toThrow("Owner changed");
  expect(controller.createDevicePeerTarget).not.toHaveBeenCalled(); expect(controller.createTarget).not.toHaveBeenCalled();
});
it("reuses only a matching remote project rather than a local or another Host's identical path", () => {
  const remote = { kind: "ssh" as const, hostTargetId: "host-target", hostId: "host", workspaceRoot: "/remote/project" };
  const { source, snapshot } = fixture(remote);
  const candidates: AppSnapshot = { ...snapshot, targets: [...snapshot.targets,
    { ...source, id: "local", workspaceId: "local-workspace", backendId: "second", remoteWorkspace: undefined },
    { ...source, id: "other", workspaceId: "other-workspace", backendId: "second", remoteWorkspace: { ...remote, hostId: "other" } },
    { ...source, id: "exact", workspaceId: "exact-workspace", backendId: "second" }], workspaces: [...snapshot.workspaces,
      { ...snapshot.workspaces[0]!, id: "local-workspace", remoteWorkspace: undefined },
      { ...snapshot.workspaces[0]!, id: "other-workspace", remoteWorkspace: { ...remote, hostId: "other" } },
      { ...snapshot.workspaces[0]!, id: "exact-workspace" }] };
  expect(findNewSessionModelProject(candidates, source, "second")?.id).toBe("exact");
});
it("keeps the fixed-reference SSH and remote Agent source exclusion before any directory or mutation", async () => {
  const { source, snapshot, controller } = fixture({ kind: "ssh", hostTargetId: "host-target", hostId: "host", workspaceRoot: "/remote/project" });
  const restricted = { ...snapshot, backends: [{ id: "source-engine", name: "Source", version: "1", health: "healthy" as const,
    capabilities: new Map([["model.remote_execution", { name: "model.remote_execution", supported: true, options: [] }]]) }] };
  await expect(ensureNewSessionModelProject(controller, restricted, source, "source-engine", () => undefined)).rejects.toThrow("SSH project");
  expect(controller.listRemoteHosts).not.toHaveBeenCalled(); expect(controller.createRemoteTarget).not.toHaveBeenCalled();
});
