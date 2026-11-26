import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationalStore, PartnerStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { PartnerManager } from "./partner-manager.js";
import { SessionHost } from "./session-host.js";
import { PartnerSessionTaskManager } from "./partner-session-tasks.js";
import { canSendFollowUpTaskMessage, PartnerAutonomyManager, followUpId } from "./partner-autonomy.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(permissionMode: "ask" | "bypassPermissions" = "ask") {
  const directory = await mkdtemp(join(tmpdir(), "joko-autonomy-")), store = new OperationalStore(join(directory, "operations.db"));
  const profiles = new PartnerStore(join(directory, "partners.db"));
  const artifacts = new ArtifactStore({ rootDirectory: join(directory, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [directory] });
  await artifacts.initialize(); const adapter = new FakeBackendAdapter({ ...PI_LIKE_PROFILE,
    capabilities: PI_LIKE_PROFILE.capabilities.map(capability => capability.key === "permission.modes"
      ? { ...capability, options: PI_LIKE_PROFILE.permissionModes } : capability) });
  let partners: PartnerManager | undefined;
  const host = new SessionHost(store, artifacts, [adapter], {
    partnerSessionRetiring: id => profiles.isPartnerSessionRetiring(id) || partners?.isRoutineSessionRetiring(id) === true
  });
  await host.initialize();
  partners = new PartnerManager({ store: profiles, operationalStore: store, sessionHost: host, homesRoot: join(directory, "homes"),
    workspaceService: { register: async input => input, unregister: () => undefined } });
  const created = await partners.createPartner({ requestId: "autonomy-owner-create", expectedDirectoryRevision: profiles.directoryState().revision,
    displayName: "Ada", avatar: "orbit", identitySource: "Help review the owner's work.", templateId: "general", usesDirectoryDefaults: false,
    capabilities: { modelChain: [{ backendId: adapter.id, providerId: "test", modelId: "text", effort: "medium", fastMode: false }], permissionMode, planMode: false } });
  expect(created.initializationState).toBe("ready"); expect(created.canonicalSessionId).toBeTypeOf("string");
  const partner = partners.getPartner(created.id);
  const tasks = new PartnerSessionTaskManager(store, partners, host, { register: async input => input }, directory);
  const now = Date.now();
  const autonomy = new PartnerAutonomyManager({ store, profiles, partners, tasks, now: () => now });
  const session = store.getSession(partner.canonicalSessionId!).descriptor;
  const task = (id: string, state: "running" | "failed" | "completed" = "running", parent = session) => {
    const value = { ...parent, id, title: id, binding: { ...parent.binding, opaqueRef: `native:${id}`, nativeSessionId: id }, createdAt: now, updatedAt: now };
    store.createSession(value); store.createRun({ id: `run:${id}`, sessionId: id, state, source: "user", createdAt: now - 1000, startedAt: now - 1000,
      ...(state === "running" ? {} : { endedAt: now, ...(state === "failed" ? { error: { code: "FAILED", message: "Task failed", phase: "run", retryable: false, stateMayHaveChanged: false, recovery: "Review" } } : {}) }) });
    return value;
  };
  cleanups.push(async () => { await tasks.close(); await host.dispose(); store.close(); profiles.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, profiles, partners, partner, adapter, autonomy, task, session };
}

describe("Partner task observation", () => {
  it("reads current and archived home tasks without adopting another partner's tasks or waking a Backend", async () => {
    const f = await fixture();
    const second = await f.partners.createPartner({ requestId: "autonomy-other-partner", expectedDirectoryRevision: f.profiles.directoryState().revision,
      displayName: "Other", avatar: "orbit", identitySource: "Review other work.", templateId: "general",
      usesDirectoryDefaults: false, capabilities: f.partner.capabilities });
    const recent = f.task("home-task");
    const done = f.task("archived-home-task", "completed");
    f.store.updateSession(done.id, { archived: true }, f.store.getSession(done.id).revision);
    const outside = f.store.getSession(second.canonicalSessionId!).descriptor;
    f.task("another-partners-task", "running", outside);
    const send = vi.spyOn(f.adapter, "send");
    const page = f.autonomy.glance(f.partner.id);
    expect(page.rows.map(row => row.sessionId).sort()).toEqual([done.id, recent.id]);
    expect(page.rows.find(row => row.sessionId === done.id)?.phase).toBe("idle");
    expect(page.rows.every(row => row.creatorPartnerId === undefined)).toBe(true);
    expect(f.autonomy.glance(f.partner.id, page.snapshotToken, 1).rows).toEqual(page.rows.slice(1));
    const task = f.store.getSession(recent.id);
    f.store.updateSession(recent.id, { title: "Updated review" }, task.revision);
    expect(() => f.autonomy.glance(f.partner.id, page.snapshotToken, 1)).toThrow("expired");
    expect(f.store.listQueueItems({ sessionId: recent.id })).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the original message boundary for an already admitted follow-up task", async () => {
    const f = await fixture("bypassPermissions");
    const worker = await f.partners.createPartner({ requestId: "autonomy-worker-test", expectedDirectoryRevision: f.profiles.directoryState().revision,
      displayName: "Worker", avatar: "orbit", identitySource: "Work on assigned tasks.", templateId: "general",
      usesDirectoryDefaults: false, capabilities: f.partner.capabilities });
    let failedDelegation = false;
    vi.spyOn(f.adapter, "send").mockImplementation(async (_prompt, context) => {
      if (failedDelegation || f.profiles.getSessionLink(context.sessionId)?.role !== "delegation") return;
      failedDelegation = true;
      await context.emit({ type: "error", terminal: true, error: { code: "FIXTURE_FAILED", message: "The delegated task needs review.",
        phase: "run", retryable: false, stateMayHaveChanged: false, recovery: "Review the task" } });
      await context.emit({ type: "done", outcome: "failed" });
    });
    const original = await f.partners.startDelegation({ callerSessionId: f.session.id, targetPartnerId: worker.id,
      title: "Owned review", objective: "Finish the review" });
    const childId = original.delegation.childSessionId!;
    await vi.waitFor(() => expect(f.store.getRun(original.delegation.runId!).descriptor.state).toBe("failed"));
    const unrelated = f.task("unrelated-owner-task");
    const routine = await f.partners.ensureRoutineSession({ partnerId: f.partner.id, key: `routine:${followUpId(f.partner.id)}`,
      title: "Historical follow-up", assertCurrent: () => undefined });
    expect(canSendFollowUpTaskMessage(f.profiles, routine, undefined)).toBe(false);
    expect(canSendFollowUpTaskMessage(f.profiles, routine, unrelated.id)).toBe(false);
    expect(canSendFollowUpTaskMessage(f.profiles, routine, childId)).toBe(true);
    expect(canSendFollowUpTaskMessage(f.profiles, f.session, unrelated.id)).toBe(true);
    expect(f.autonomy.glance(f.partner.id).rows.find(row => row.sessionId === childId)?.creatorPartnerId).toBe(f.partner.id);
    expect(f.autonomy.glance(worker.id).rows.find(row => row.sessionId === childId)?.creatorPartnerId).toBe(f.partner.id);
  });
});
