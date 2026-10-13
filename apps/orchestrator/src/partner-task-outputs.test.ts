import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationalStore, type PartnerDelegationRecord, type PartnerProfileRecord } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PartnerSessionTaskRecord } from "./partner-session-tasks.js";
import { PartnerTaskOutputChangedError, PartnerTaskOutputProjection } from "./partner-task-outputs.js";
import type { WorkspaceRunOutput } from "./workspace-run-capture.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

describe("Partner task output projection", () => {
  it("aggregates the exact current execution in Run order, removes final deletions and bounds metadata to 64 paths", async () => {
    const f = fixture(); f.addRun("first"); f.addRun("second"); f.addRun("previous");
    f.saveTask({ execution: 2, executionRunIds: ["first", "second"], runId: "second" });
    f.outputs.set("first", { readiness: "ready", changes: [{ path: "deleted.txt", status: "added" }, { path: "updated.txt", status: "added" },
      ...Array.from({ length: 65 }, (_, index) => ({ path: `reports/${index}.txt`, status: "added" as const }))] });
    f.outputs.set("second", { readiness: "ready", changes: [{ path: "deleted.txt", status: "deleted" }, { path: "updated.txt", status: "modified" }] });
    f.outputs.set("previous", { readiness: "ready", changes: [{ path: "old-execution.txt", status: "added" }] });
    const [row] = await f.projection.list("requester");
    expect(row).toMatchObject({ kind: "task", execution: 2, runIds: ["first", "second"], readiness: "ready", truncated: true });
    expect(row!.files).toHaveLength(64); expect(row!.files).toContainEqual({ path: "updated.txt", status: "modified" });
    expect(row!.files.some(file => ["deleted.txt", "old-execution.txt"].includes(file.path))).toBe(false);
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it("lists requester delegations with their exact child and excludes tasks owned by another requester", async () => {
    const f = fixture(); f.addRun("delegated"); f.addRun("ordinary"); f.saveTask({ executionRunIds: ["ordinary"], runId: "ordinary" });
    f.delegations.push(f.delegation("owned", "requester", "delegated"), f.delegation("received", "other", "delegated"));
    f.outputs.set("delegated", { readiness: "ready", changes: [{ path: "delegation.txt", status: "added" }] });
    f.outputs.set("ordinary", { readiness: "ready", changes: [] });
    const rows = await f.projection.list("requester");
    expect(rows.map(row => [row.kind, row.id])).toEqual([["task", "task-one"], ["delegation", "owned"]]);
    expect(rows[1]).toMatchObject({ parentSessionId: "parent", sessionId: "child", execution: 1, runIds: ["delegated"], files: [{ path: "delegation.txt", status: "added" }] });
    expect(rows[0]).toMatchObject({ readiness: "ready", files: [], truncated: false });
  });

  it("keeps pending, ready empty, capture failure and unaccepted terminal output distinct without adopting unsafe paths", async () => {
    const f = fixture(); f.addRun("accepted"); f.saveTask({ executionRunIds: ["accepted"], runId: "accepted" });
    f.outputs.set("accepted", { readiness: "pending", changes: [] });
    expect((await f.projection.list("requester"))[0]!.readiness).toBe("pending");
    f.outputs.set("accepted", { readiness: "ready", changes: [] });
    expect((await f.projection.list("requester"))[0]).toMatchObject({ readiness: "ready", files: [] });
    f.read.mockRejectedValueOnce(new Error("Read failed"));
    expect((await f.projection.list("requester"))[0]).toMatchObject({ readiness: "unavailable", files: [] });
    f.outputs.set("accepted", { readiness: "ready", changes: ["../escape", "/absolute", "C:/drive", "a\\b", "a//b", "a/./b", "a/../b", "x\u0000y", "x".repeat(1025)]
      .map(path => ({ path, status: "added" })) });
    expect((await f.projection.list("requester"))[0]).toMatchObject({ readiness: "unavailable", files: [] });
    f.addRun("unaccepted", false); f.saveTask({ executionRunIds: ["unaccepted"], runId: "unaccepted" });
    expect((await f.projection.list("requester"))[0]).toMatchObject({ readiness: "unavailable", files: [] });
    f.saveTask({ status: "queued", executionRunIds: ["unaccepted"], runId: "unaccepted" });
    expect((await f.projection.list("requester"))[0]!.readiness).toBe("pending");
  });

  it.each(["execution", "generation", "requester"] as const)("rejects late output metadata after %s ownership changes", async change => {
    const f = fixture(); f.addRun("accepted"); f.saveTask({ executionRunIds: ["accepted"], runId: "accepted" });
    let release!: (value: WorkspaceRunOutput) => void;
    f.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const request = f.projection.list("requester");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    if (change === "execution") f.saveTask({ execution: 2, executionRunIds: [], runId: undefined });
    if (change === "generation") f.store.updateSession("child", { binding: { opaqueRef: "fake://next", generation: 2 } });
    if (change === "requester") f.partner = { ...f.partner, revision: 2n, canonicalSessionId: "new-parent" };
    release({ readiness: "ready", changes: [{ path: "late.txt", status: "added" }] });
    await expect(request).rejects.toBeInstanceOf(PartnerTaskOutputChangedError);
  });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "joko-task-output-")), store = new OperationalStore(join(directory, "operational.db"));
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const now = Date.now(), route = { backendId: "fake", providerId: "test", modelId: "text", fastMode: false };
  store.upsertBackend({ id: "fake", displayName: "Fake", version: "1", health: "healthy", adapterKind: "fixture", instanceGeneration: 0,
    installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId: "fake", displayName: "Task", workspaceRoot: directory, managed: true, trusted: true });
  for (const id of ["parent", "child"]) store.createSession({ id, backendId: "fake", targetId: "target", title: id,
    binding: { opaqueRef: `fake://${id}`, generation: 1 }, pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: now, updatedAt: now });
  const base: PartnerSessionTaskRecord = { version: 1, id: "task-one", partnerId: "requester", parentSessionId: "parent", requestFingerprint: "fingerprint",
    title: "Outputs", objective: "Produce output", contextRefs: [], targetId: "target", directory, realDirectory: directory, useWorktree: false,
    route, routes: [route], explicitModel: false, permissionMode: "ask", planMode: false, timeoutMs: 60000, deadlineAt: now + 60000, createdAt: now, updatedAt: now,
    execution: 1, executionRunIds: [], status: "completed", control: "active", sessionId: "child" };
  const f = { store, partner: { id: "requester", revision: 1n, profileVersion: 1, displayName: "Requester", description: "", avatar: "orbit", identitySource: "Identity",
    templateId: "general", lifecycle: "active", initializationState: "ready", invitationStage: "ready", homeTargetId: "target", canonicalSessionId: "parent",
    capabilities: { modelChain: [route], permissionMode: "ask", planMode: false }, usesDirectoryDefaults: false, createdAt: now, updatedAt: now } as PartnerProfileRecord,
    delegations: [] as PartnerDelegationRecord[], outputs: new Map<string, WorkspaceRunOutput>(),
    read: vi.fn(async (_sessionId: string, runId: string): Promise<WorkspaceRunOutput> => f.outputs.get(runId) ?? { readiness: "unavailable", changes: [] }),
    saveTask(patch: Partial<PartnerSessionTaskRecord>) { store.setSetting("service", "partner.session-tasks", base.id, { ...base, ...patch }); },
    delegation(id: string, requesterPartnerId: string, runId: string): PartnerDelegationRecord {
      return { id, revision: 1n, requesterPartnerId, targetPartnerId: "target-partner", parentSessionId: "parent", targetProfileVersion: 1,
        title: "Delegation", objective: "Output", status: "completed", childSessionId: "child", runId, createOperationId: `create-${id}`, enqueueOperationId: `enqueue-${id}`, createdAt: now, updatedAt: now };
    },
    addRun(id: string, accepted = true) {
      store.createRun({ id, sessionId: "child", source: "system", state: "queued", createdAt: now });
      const attemptId = `attempt-${id}`; store.createAttempt({ id: attemptId, runId: id, ordinal: 1, generation: 1, startedAt: now });
      const operationId = `input-${id}`, prompt = { text: "Produce output", images: [], files: [], mentions: [], disposition: "prompt" as const };
      store.runOperation({ id: operationId, kind: "service_send_input", body: { sessionId: "child", prompt } }, transaction => {
        transaction.enqueueQueueItem({ id: `queue-${id}`, sessionId: "child", runId: id, attemptId, operationId, disposition: "prompt", body: prompt }); return {};
      });
      store.updateRunState({ runId: id, state: "running", activeAttemptId: attemptId, traceId: `run-start-${id}` });
      if (accepted) {
        store.claimNextQueueItem({ sessionId: "child", backendInstanceGeneration: 0, traceId: `dispatch-${id}` });
        store.updateQueueState({ queueItemId: `queue-${id}`, state: "backend_accepted", attemptId, traceId: `accepted-${id}` });
        store.updateQueueState({ queueItemId: `queue-${id}`, state: "completed", attemptId, traceId: `done-${id}` });
      }
      store.updateRunState({ runId: id, state: "completed", traceId: `run-done-${id}` });
    },
    projection: undefined as unknown as PartnerTaskOutputProjection
  };
  f.projection = new PartnerTaskOutputProjection(store, { list: partnerId => partnerId === "requester"
    ? [store.getSetting<PartnerSessionTaskRecord>("service", "partner.session-tasks", "task-one").value] : [] },
    { getPartner: () => f.partner, listDelegations: () => f.delegations }, { readRunOutput: f.read });
  return f;
}
