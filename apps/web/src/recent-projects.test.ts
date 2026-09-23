import { expect, it, vi } from "vitest";
import { emptySnapshot, type AppSnapshot } from "./model.js";
import { MAX_RECENT_PROJECTS, normalizeRecentProjects, publishRecentProjectsChange, recentProjectForTarget, resolveRecentProject, subscribeRecentProjectsChange, withRecentProject, withoutRecentProject } from "./recent-projects.js";

const sample = { targetId: "target", workspaceId: "workspace", name: "Project", serverPath: "C:\\work\\project", lastUsedAt: 1 };

it("keeps ten most recently used directory identities and does not merge matching paths on different remote hosts", () => {
  let entries = withRecentProject([], sample);
  entries = withRecentProject(entries, { ...sample, targetId: "other", workspaceId: "other-workspace", serverPath: "C:/work/project/" });
  expect(entries).toHaveLength(1);
  expect(entries[0]?.targetId).toBe("other");
  entries = withRecentProject(entries, { ...sample, targetId: "remote-a", remoteHostId: "host-a", remoteWorkspaceRoot: "/work/project", serverPath: "/work/project" });
  entries = withRecentProject(entries, { ...sample, targetId: "remote-b", remoteHostId: "host-b", remoteWorkspaceRoot: "/work/project", serverPath: "/work/project" });
  expect(entries.map((entry) => entry.targetId)).toEqual(["remote-b", "remote-a", "other"]);
  for (let index = 0; index < 12; index += 1) entries = withRecentProject(entries, { ...sample, targetId: `t-${index}`, serverPath: `/work/${index}` });
  expect(entries).toHaveLength(MAX_RECENT_PROJECTS);
  expect(entries[0]?.targetId).toBe("t-11");
  expect(entries.at(-1)?.targetId).toBe("t-2");
});

it("uses current Target and Workspace identity, availability and path rather than a remembered display name", () => {
  const snapshot = { ...emptySnapshot(),
    targets: [{ id: "target", workspaceId: "workspace", backendId: "backend", name: "Live name",
      workspaceName: "Project", trusted: true, pinned: false, archived: false, revision: 1n }],
    workspaces: [{ id: "workspace", targetId: "target", name: "Project", kind: "userProject" as const,
      serverPath: "C:/work/project", trusted: true, dirty: false, entries: [] }] } as AppSnapshot;
  const entry = recentProjectForTarget(snapshot, "target", 3);
  expect(entry).toMatchObject({ targetId: "target", workspaceId: "workspace", serverPath: "C:/work/project" });
  expect(resolveRecentProject(entry!, snapshot)?.id).toBe("target");
  expect(resolveRecentProject(entry!, { ...snapshot, targets: [{ ...snapshot.targets[0]!, archived: true }] })).toBeUndefined();
  expect(resolveRecentProject(entry!, { ...snapshot, targets: [{ ...snapshot.targets[0]!, workspaceId: "replacement" }] })).toBeUndefined();
  expect(resolveRecentProject(entry!, { ...snapshot, workspaces: [{ ...snapshot.workspaces[0]!, serverPath: "C:/other" }] })).toBeUndefined();
  expect(resolveRecentProject(entry!, { ...snapshot, targets: [] })).toBeUndefined();
  expect(recentProjectForTarget({ ...snapshot, workspaces: [{ ...snapshot.workspaces[0]!, kind: "managedDialogue" }] }, "target")).toBeUndefined();
  const remoteSnapshot = { ...snapshot, targets: [{ ...snapshot.targets[0]!, remoteWorkspace: { hostId: "host-a", workspaceRoot: "/srv/project" } }],
    workspaces: [{ ...snapshot.workspaces[0]!, serverPath: "/srv/project" }] };
  const remoteEntry = recentProjectForTarget(remoteSnapshot, "target");
  expect(resolveRecentProject(remoteEntry!, { ...remoteSnapshot,
    targets: [{ ...remoteSnapshot.targets[0]!, remoteWorkspace: { hostId: "host-b", workspaceRoot: "/srv/project" } }] })).toBeUndefined();
});

it("discards malformed local history and removes only the exact remembered identity", () => {
  expect(normalizeRecentProjects([null, { ...sample, serverPath: "" }, { ...sample, remoteHostId: "host" }, sample])).toEqual([sample]);
  const replacement = { ...sample, targetId: "replacement", workspaceId: "replacement-workspace" };
  expect(withoutRecentProject([replacement], sample)).toEqual([replacement]);
  expect(withoutRecentProject([sample], sample)).toEqual([]);
});

it("notifies only the exact service connection and never broadcasts a path", async () => {
  const channels = new Set<TestChannel>();
  const sent: unknown[] = [];
  class TestChannel {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    constructor(_name: string) { channels.add(this); }
    postMessage(value: unknown): void {
      sent.push(value);
      for (const peer of channels) if (peer !== this) queueMicrotask(() => peer.onmessage?.({ data: value } as MessageEvent<unknown>));
    }
    close(): void { channels.delete(this); }
  }
  vi.stubGlobal("BroadcastChannel", TestChannel);
  try {
    const matching = vi.fn();
    const foreign = vi.fn();
    const closeMatching = subscribeRecentProjectsChange("server-a\u0000profile-a", matching);
    const closeForeign = subscribeRecentProjectsChange("server-a\u0000profile-b", foreign);
    publishRecentProjectsChange("server-a\u0000profile-a");
    await Promise.resolve();
    expect(matching).toHaveBeenCalledOnce();
    expect(foreign).not.toHaveBeenCalled();
    expect(sent).toEqual([{ owner: "server-a\u0000profile-a" }]);
    closeMatching(); closeForeign();
  } finally { vi.unstubAllGlobals(); }
});
