import { expect, it } from "vitest";
import { composeNativeTaskStatusProjection } from "./native-task-status-projection.js";
import { emptySnapshot, type ConnectionProfile, type PartnerProfileView, type SessionView } from "./model.js";
import type { NativeTaskStatusLiveSource } from "./native-task-status-sources.js";

const profile: ConnectionProfile = { id: "profile", serverId: "node", deviceId: "controller", origin: "https://node.example", name: "Computer" };
function session(id = "same"): SessionView { return { id, backendId: "backend", targetId: "target", name: "Task", state: "running", pinned: false,
  archived: false, generation: 1n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 1 }; }
function partner(): PartnerProfileView { return { id: "partner", revision: 1n, profileVersion: 1n, displayName: "Companion", description: "", avatar: "leaf", lifecycle: "active",
  initializationState: "ready", invitationStage: "ready", homeTargetId: "home", canonicalSessionId: "same", templateId: "general", identitySource: "private",
  capabilities: { modelChain: [], permissionMode: "ask", planMode: false }, usesDirectoryDefaults: true, createdAt: 1, updatedAt: 1,
  activity: { partnerId: "partner", unreadReplyCount: 1, latestReplyPreview: "Old reply", artifactCount: 0, activeDelegationCount: 0, readThroughCursor: 0n, readUpdatedAt: 1 } }; }
function source(sessions = [session()]): NativeTaskStatusLiveSource { return { profile, epoch: 2, snapshot: { ...emptySnapshot(), generation: 3n, sessions }, partners: [] }; }
function project(remotes: readonly NativeTaskStatusLiveSource[], selectedProfileIds = new Set([profile.id])) {
  return composeNativeTaskStatusProjection({ ownerId: "renderer", revision: 1n, locale: "en", remotes, selectedProfileIds });
}
it("keeps identical session IDs on different nodes independently routed and never projects remote permission buttons", () => {
  const first = source(), second = { ...source(), profile: { ...profile, id: "other-profile", serverId: "other-node" } };
  const withPermission = { ...first, snapshot: { ...first.snapshot, interactions: [{ id: "permission", sessionId: "same", generation: 1n, kind: "permission" as const,
    title: "Execute?", message: "", options: [{ id: "1", label: "Allow" }], fields: [], planSteps: [], createdAt: 2 }] } };
  const result = project([withPermission, second], new Set([profile.id, second.profile.id]));
  expect(new Set(result.snapshot.sessions.map(item => item.sessionId)).size).toBe(2);
  expect([...result.routes.values()].map(route => [route.profileId, route.serverId, route.sessionId, route.epoch, route.sourceGeneration]))
    .toEqual([[profile.id, "node", "same", 2, 3n], ["other-profile", "other-node", "same", 2, 3n]]);
  expect(result.snapshot.sessions.every(item => item.permission === undefined)).toBe(true);
});
it("projects canonical companion activity outside task scope, hides private tasks, and never invents a canonical Session", () => {
  const original = source([session(), session("ordinary"), { ...session("hidden"), hidden: true }]);
  const withPartner = { ...original, partners: [partner(), { ...partner(), id: "preparing", canonicalSessionId: undefined }] };
  const result = project([withPartner], new Set());
  expect(result.snapshot.sessions).toHaveLength(1);
  expect(result.snapshot.sessions[0]).toMatchObject({ title: "Companion", remote: { companion: { glyph: "❧", tint: "#197451" } } });
  expect([...result.routes.values()][0]).toMatchObject({ profileId: profile.id, partnerId: "partner", sessionId: "same" });
  expect(project([original], new Set()).snapshot.sessions).toEqual([]);
});
it("uses only the current completed reply and mirrors it as status without reviving an older preview", () => {
  const task = { ...session(), state: "idle" as const, taskActivity: { runId: "current-run", completedReplySummary: "Current answer", completionNotification: "pending" as const, silent: true } };
  const remote = { ...source([task]), partners: [partner()] };
  const result = project([remote]).snapshot.sessions[0]!;
  expect(result).toMatchObject({ phase: "completed", detail: "Current answer", activityLines: [{ kind: "status", text: "Current answer" }], remote: { silent: true, completionNotification: "pending" } });
  const empty = project([{ ...remote, snapshot: { ...remote.snapshot, sessions: [{ ...task, taskActivity: { ...task.taskActivity, completedReplySummary: "" } }] } }]).snapshot.sessions[0]!;
  expect(empty.activityLines).toEqual([]); expect(empty.detail).toBe("");
});
it("truncates the complete mirror at the shared 500 bound with companions ahead of ordinary tasks", () => {
  const original = source([...Array.from({ length: 501 }, (_, index) => session(`task-${index}`)), session()]);
  const result = project([{ ...original, partners: [partner()] }]);
  expect(result.snapshot.sessions).toHaveLength(500); expect(result.routes.size).toBe(500);
  expect(result.snapshot.sessions[0]!.remote?.companion?.name).toBe("Companion");
});
