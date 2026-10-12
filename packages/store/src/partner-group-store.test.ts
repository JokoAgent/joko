import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { PartnerGroupStore } from "./partner-group-store.js";
import type { AppendPartnerGroupMessage } from "./partner-group-store.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "joko-group-store-")), path = join(root, "groups.db");
  let store = new PartnerGroupStore(path);
  cleanups.push(() => { store.close(); rmSync(root, { force: true, recursive: true }); });
  return { get store() { return store; }, path, reopen() { store.close(); store = new PartnerGroupStore(path); return store; } };
}
function message(clientId: string, content = "A group request"): AppendPartnerGroupMessage {
  return { clientId, kind: "message", authorKind: "user", authorPartnerId: null, authorName: "You", content,
    mentions: { all: false, partnerIds: [] }, noticeCode: null, planId: null, files: [], attachments: [] };
}
function create(store: PartnerGroupStore, requestId = "group-create-original") {
  return store.create({ requestId, expectedDirectoryRevision: store.directoryRevision(), name: "Project team", memberIds: ["writer", "reviewer"] });
}

describe("Partner group durable authority", () => {
  it("publishes body-free change notices only after commit and replays them after reopen", () => {
    const f = fixture(), group = create(f.store), notices: number[] = [];
    f.store.subscribe(notice => { expect(f.store.changes(0).some(saved => saved.sequence === notice.sequence)).toBe(true); notices.push(notice.sequence); });
    expect(() => f.store.transaction(store => { store.appendChange(group.id, "round"); expect(notices).toEqual([]); throw new Error("Rollback change"); })).toThrow("Rollback change");
    expect(f.store.changes(0)).toEqual([]); expect(notices).toEqual([]);
    const saved = f.store.appendChange(group.id, "created"); expect(notices).toEqual([saved.sequence]);
    expect(saved.directoryRevision).toBe(f.store.directoryRevision());
    expect(f.reopen().changes(0)).toEqual([saved]);
  });
  it("claims creation and message identities atomically, fences edits and retains bounded history across reopen", () => {
    const f = fixture(), group = create(f.store);
    expect(create(f.store).id).toBe(group.id);
    expect(() => f.store.create({ requestId: "group-create-original", expectedDirectoryRevision: f.store.directoryRevision(), name: "Different", memberIds: group.memberIds })).toThrow();
    expect(() => f.store.update(group.id, group.revision + 1, { name: "Stale" })).toThrow();
    const first = f.store.appendMessage(group.id, message("user-intent-1"));
    expect(f.store.appendMessage(group.id, message("user-intent-1"))).toEqual({ message: first.message, created: false });
    expect(() => f.store.appendMessage(group.id, message("user-intent-1", "Changed intent"))).toThrow();
    for (let i = 2; i <= 102; i++) f.store.appendMessage(group.id, message(`user-intent-${i}`, `Request ${i}`));
    const page = f.store.messages(group.id);
    expect(page.messages).toHaveLength(100); expect(page.messages[0]?.sequence).toBe(3); expect(page.hasMoreBefore).toBe(true);
    expect(f.store.messages(group.id, { beforeSequence: 3 }).messages.map(item => item.sequence)).toEqual([1, 2]);
    f.store.advanceDelivered(group.id, "writer", 80); f.store.advanceDelivered(group.id, "writer", 20);
    f.store.markRead(group.id, "phone", 100); f.store.markRead(group.id, "phone", 50);
    const current = f.store.get(group.id); f.store.setMembers(group.id, current.revision, ["reviewer", "writer", "designer"]);
    f.reopen();
    expect(f.store.memberships(group.id).find(item => item.partnerId === "writer")?.lastSeenSequence).toBe(80);
    expect(f.store.readThrough(group.id, "phone")).toBe(100); expect(f.store.latestSequence(group.id)).toBe(102);
    expect(f.store.memberships(group.id).map(item => item.partnerId)).toEqual(["reviewer", "writer", "designer"]);
    expect(() => f.store.markRead(group.id, "phone", 103)).toThrow();
  });
  it("rolls back credential-bearing and out-of-scope messages without advancing the timeline", () => {
    const f = fixture(), group = create(f.store);
    expect(() => f.store.appendMessage(group.id, message("secret-intent", "Bearer sk-abcdefghijklmnop1234567890"))).toThrow();
    expect(() => f.store.appendMessage(group.id, { ...message("foreign-author"), authorKind: "partner", authorPartnerId: "foreign" })).toThrow();
    expect(() => f.store.appendMessage(group.id, { ...message("foreign-file"), files: ["../outside"] })).toThrow();
    expect(() => f.store.appendMessage(group.id, { ...message("foreign-mention"), mentions: { all: false, partnerIds: ["foreign"] } })).toThrow();
    expect(f.store.latestSequence(group.id)).toBe(0); expect(f.store.get(group.id).revision).toBe(1);
  });
  it("persists one open plan with its card and recovers an interrupted step only as waiting for explicit retry", () => {
    const f = fixture(), group = create(f.store);
    const input = { requestText: "Write and review the result", attachments: [], organizerPartnerId: "writer", organizerName: "Writer",
      steps: [{ partnerId: "writer", partnerName: "Writer", task: "Write" }, { partnerId: "reviewer", partnerName: "Reviewer", task: "Review" }] };
    const first = f.store.createPlan(group.id, group.revision, input);
    const plan = f.store.createPlan(group.id, f.store.get(group.id).revision, { ...input, requestText: "Revised result" });
    expect(f.store.getPlan(first.id).status).toBe("superseded"); expect(f.store.openPlan(group.id)?.id).toBe(plan.id);
    expect(f.store.messages(group.id).messages.map(item => item.kind)).toEqual(["plan", "plan"]);
    const running = f.store.updatePlan(plan.id, plan.revision, value => ({ ...value, status: "running", currentStep: 0, workDir: "/owned/plan",
      steps: value.steps.map((step, index) => index === 0 ? { ...step, status: "running", startedAt: Date.now() } : step) }));
    expect(() => f.store.updatePlan(plan.id, plan.revision, value => value)).toThrow();
    expect(() => f.store.createPlan(group.id, f.store.get(group.id).revision, input)).toThrow();
    f.reopen(); expect(f.store.recoverInterruptedPlans()).toHaveLength(1);
    const recovered = f.store.getPlan(plan.id);
    expect(recovered).toMatchObject({ status: "waiting", currentStep: 0, workDir: "/owned/plan", revision: running.revision + 1 });
    expect(recovered.steps.map(step => step.status)).toEqual(["failed", "pending"]);
    expect(f.store.recoverInterruptedPlans()).toEqual([]);
    f.store.removePartner("writer"); expect(f.store.get(group.id).memberIds).toEqual(["reviewer"]);
    expect(f.store.getPlan(plan.id).organizerName).toBe("Writer");
  });
  it("retains unknown lane creation and deletion fences, retires old intents, and rejects a modified database schema", () => {
    const f = fixture(), group = create(f.store), input = { groupId: group.id, partnerId: "writer", planId: null, operationId: "group-lane-original", profileVersion: 1 };
    const claimed = f.store.claimLane(input), unknown = f.store.updateLane(claimed, { phase: "unknown", sessionId: null, profileVersion: 1 });
    expect(f.store.claimLane({ ...input, operationId: "group-lane-new-intent" })).toEqual(unknown);
    f.reopen(); expect(f.store.lanes(group.id)).toEqual([unknown]);
    const ready = f.store.updateLane(unknown, { phase: "ready", sessionId: "existing-group-session", profileVersion: 1 });
    f.store.beginDelete(group.id, f.store.get(group.id).revision);
    expect(() => f.store.finishDelete(group.id)).toThrow();
    f.store.updateLane(ready, { phase: "archived", sessionId: ready.sessionId, profileVersion: 1 }); f.store.finishDelete(group.id);
    expect(f.store.creation("group-create-original").retired).toBe(true); expect(() => create(f.store)).toThrow();
    const raw = new DatabaseSync(f.path); raw.exec("ALTER TABLE group_reads ADD COLUMN old_cursor INTEGER"); raw.close();
    const incompatible = () => new PartnerGroupStore(f.path); expect(incompatible).toThrow();
  });
});
