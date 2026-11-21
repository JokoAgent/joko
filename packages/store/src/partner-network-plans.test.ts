import { afterEach, describe, expect, it } from "vitest";
import { OperationalStore } from "./operational-store.js";
import { PartnerNetworkStore, networkHash, networkHumanId, networkPartnerId } from "./partner-network-store.js";
import type { NetworkPlan, NetworkExecutionSettlement } from "./partner-network-plans.js";

const stores: OperationalStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const db = new OperationalStore(":memory:"); stores.push(db); let clock = 100_000, operation = 0;
  const store = new PartnerNetworkStore(db, () => clock), ownerId = networkHumanId("home"), a = networkPartnerId("home", "writer"), b = networkPartnerId("home", "reviewer");
  const room = store.create({ operationId: "create", singleSpeaker: false, serverId: "home", origin: "https://home.test", name: "Group", displayName: "Owner",
    partners: [{ id: "writer", name: "Writer", description: "Write" }, { id: "reviewer", name: "Reviewer", description: "Review" }] });
  const send = (text: string, options: Partial<Parameters<PartnerNetworkStore["send"]>[0]> = {}) => store.send({ operationId: `send:${++operation}`,
    roomId: room.id, actorId: ownerId, text, mentions: [], mentionAll: false, attachments: [], threadRootId: "", quoteId: "", ...options });
  const settle = (actorId: string, values: Partial<NetworkExecutionSettlement> = {}) => { const job = store.claim(room.id, ownerId, actorId)!; expect(job).toBeDefined();
    return store.settle({ roomId: room.id, ownerId, executionId: job.id, lease: job.lease, action: "complete", text: "", failureCode: "", ...values }); };
  const current = () => store.plans.current(room.id)!;
  const manage = (action: string, value: string, actorId = ownerId) => store.manage({ operationId: `manage:${++operation}`, roomId: room.id, actorId,
    expectedRevision: store.get(room.id).revision, action, targetId: "", value, throughSequence: 0 });
  const action = (kind: string, plan = current(), position = 0, targetId = "") => store.plans.action({ operationId: `action:${++operation}`, roomId: room.id, actorId: ownerId,
    planId: plan.id, expectedRevision: plan.revision, action: kind, position, targetId, sourceMessageId: "" });
  const propose = () => { const source = send("Produce a result", { forcePlan: true }); settle(a, { decision: { needsPlan: true, steps: [{ actorId: a, task: "Write result" }, { actorId: b, task: "Review result" }, { actorId: a, task: "Revise result" }] } }); return { source, plan: current() }; };
  return { db, store, room, ownerId, a, b, send, settle, current, manage, action, propose, advance: (ms: number) => { clock += ms; } };
}
describe("server-owned interactive work plans", () => {
  it.each(["auto", "sequential"] as const)("keeps quiet sends out of the organizer with %s speaking", speakingMode => {
    const f = fixture();
    const people = f.send("Only the people", { mentionAll: true });
    expect(people.mentions).toEqual([]);
    f.manage("reply-mode", "mentioned");
    f.manage("speaking-mode", speakingMode);
    const quiet = { operationId: "quiet" };
    const original = f.send("A note", quiet);
    expect(f.send("A note", quiet)).toEqual(original);
    expect(f.store.executions(f.room.id)).toEqual([]);
    expect(f.store.messages(f.room.id).map(message => message.id)).toEqual([people.id, original.id]);
    expect(() => f.send("A changed note", quiet)).toThrow();
    expect(() => f.send("All companions", { mentionAllPartners: true })).toThrow(/disabled/);
    expect(f.store.messages(f.room.id)).toHaveLength(2);

    f.manage("partner-broadcast", "true");
    const all = f.send("All companions", { mentionAllPartners: true });
    expect(all.mentions).toEqual([f.a, f.b]);
    expect(f.store.executions(f.room.id)).toMatchObject([{ kind: "plan-decision", decisionMode: "auto" }]);
    f.settle(f.a, { decision: { needsPlan: false, steps: [] } });
    const replies = f.store.executions(f.room.id).filter(job => job.kind === "reply" && job.sourceMessageId === all.id);
    expect(replies).toHaveLength(2);
    expect(replies.every(job => job.parallel === (speakingMode === "auto"))).toBe(true);
    const named = f.send("Writer only", { mentions: [f.a] });
    expect(f.store.executions(f.room.id).filter(job => job.sourceMessageId === named.id)).toMatchObject([{ kind: "reply", actorId: f.a }]);
    const forced = f.send("Arrange this with the writer", { forcePlan: true, mentions: [f.a] });
    expect(f.store.executions(f.room.id).filter(job => job.sourceMessageId === forced.id)).toMatchObject([{ kind: "plan-decision", decisionMode: "forced" }]);
  });
  it("routes Thread and quote replies by stored author and never treats a human address as a plan note", () => {
    const f = fixture(), digest = networkHash("reply-guest");
    f.store.invite({ operationId: "invite-guest", roomId: f.room.id, actorId: f.ownerId, expectedRevision: f.store.get(f.room.id).revision,
      digest, reusable: false, lifetimeMs: 60_000 });
    const guest = f.store.accept({ operationId: "join-guest", linkDigest: digest, homeServerId: "guest", displayName: "Guest", credentialDigest: networkHash("reply-credential") }).memberId;
    expect(() => f.manage("partner-broadcast", "true", guest)).toThrow();
    const { plan } = f.propose();
    const quiet = f.send("For the people", { mentionAll: true });
    expect(quiet.mentions).toEqual([guest]);
    f.send("For Guest", { mentions: [guest] });
    expect(f.current()).toEqual(plan);
    expect(f.store.executions(f.room.id).filter(job => job.status === "queued")).toEqual([]);

    f.manage("reply-mode", "mentioned");
    const root = f.store.appendActorMessage({ roomId: f.room.id, ownerId: f.ownerId, actorId: f.b, operationId: "partner-root", text: "Notes from the reviewer" });
    const thread = f.send("Thread reply", { threadRootId: root.id });
    expect(thread.mentions).toEqual([f.b]);
    expect(f.store.executions(f.room.id).filter(job => job.sourceMessageId === thread.id)).toMatchObject([{ kind: "reply", actorId: f.b }]);
    const quote = f.send("Quoted reply", { quoteId: root.id });
    expect(quote.mentions).toEqual([f.b]);
    expect(f.store.executions(f.room.id).filter(job => job.sourceMessageId === quote.id)).toMatchObject([{ kind: "reply", actorId: f.b }]);
    const humanThread = f.send("Stay in the conversation", { threadRootId: root.id, mentionAll: true });
    expect(humanThread.mentions).toEqual([guest]);
    expect(f.store.executions(f.room.id).filter(job => job.sourceMessageId === humanThread.id)).toEqual([]);
  });
  it("validates and merges proposed steps, requires approval, and leaves one open card after revision", () => {
    const f = fixture(), first = f.propose(); expect(f.current().status).toBe("proposed"); expect(f.store.executions(f.room.id).filter(job => job.status === "queued")).toEqual([]);
    f.send("Also translate the final result"); const job = f.store.claim(f.room.id, f.ownerId, f.a)!; expect(job.decisionMode).toBe("revise");
    const input = { roomId: f.room.id, ownerId: f.ownerId, executionId: job.id, lease: job.lease, action: "complete", text: "", failureCode: "",
      decision: { needsPlan: true, steps: [{ actorId: f.b, task: "Review" }, { actorId: f.b, task: "Translate" }] } };
    f.store.settle(input); expect(f.store.settle(input).status).toBe("completed");
    expect(f.store.plans.get(f.room.id, first.plan.id).status).toBe("superseded"); expect(f.current().steps).toHaveLength(1);
    expect(f.current().requestText).toContain("Produce a result"); expect(f.current().requestText).toContain("Also translate"); expect(f.current().requestMessageIds).toHaveLength(2);
    expect(() => f.store.settle({ ...input, text: "Different output" })).toThrow();
    const before = f.current(); expect(() => f.action("remove-step", before)).toThrow(); f.action("start"); expect(f.current().status).toBe("running");
  });
  it("pauses after each step, reassigns unfinished work, redoes a completed step, and retains finished results on stop", () => {
    const f = fixture(); f.propose(); f.action("start"); f.settle(f.a, { text: "First handoff", seenNoteIds: [] });
    expect(f.current().status).toBe("waiting"); expect(f.store.executions(f.room.id).some(job => job.actorId === f.b && job.status === "queued")).toBe(false);
    f.send("Make this shorter"); const redo = f.store.claim(f.room.id, f.ownerId, f.a)!; expect(redo.planPosition).toBe(0);
    f.store.settle({ roomId: f.room.id, ownerId: f.ownerId, executionId: redo.id, lease: redo.lease, action: "complete", text: "Short handoff", failureCode: "", seenNoteIds: f.current().noteMessageIds });
    f.action("reassign", f.current(), 1, f.a); f.action("continue"); expect(f.current().currentStep).toBe(1); f.action("stop");
    expect(f.store.plans.list(f.room.id).at(-1)?.status).toBe("stopped"); expect(f.store.messages(f.room.id).some(message => message.text === "Short handoff")).toBe(true);
  });
  it("holds a handoff until every durable running note is consumed, and repeats the immutable intermediate receipt without another step", () => {
    const f = fixture(); f.propose(); f.action("start"); const job = f.store.claim(f.room.id, f.ownerId, f.a)!;
    const note = f.send("A late requirement"), input = { roomId: f.room.id, ownerId: f.ownerId, executionId: job.id, lease: job.lease, action: "complete", text: "Intermediate", failureCode: "", completionId: "0", seenNoteIds: [] };
    expect(f.store.settle(input).status).toBe("running"); expect(f.store.settle(input).status).toBe("running");
    expect(f.store.messages(f.room.id).some(message => message.text === "Intermediate")).toBe(false);
    const completed = { ...input, completionId: "1", text: "Includes late requirement", seenNoteIds: [note.id] };
    expect(f.store.settle(completed).status).toBe("completed"); expect(f.store.settle(completed).status).toBe("completed");
    expect(f.current().status).toBe("waiting"); expect(f.store.messages(f.room.id).filter(message => message.text === completed.text)).toHaveLength(1);
  });
  it("requires an explicit retry after process restart, expiration, or unavailable step members", () => {
    const f = fixture(); f.propose(); f.action("start"); f.store.recover(); expect(f.current().steps[0]?.status).toBe("failed");
    expect(f.store.claim(f.room.id, f.ownerId, f.a)).toBeUndefined(); f.action("retry"); const job = f.store.claim(f.room.id, f.ownerId, f.a)!;
    f.advance(30_001); expect(f.store.claim(f.room.id, f.ownerId, f.a)).toBeUndefined(); expect(f.current().status).toBe("waiting");
    expect(() => f.store.settle({ roomId: f.room.id, ownerId: f.ownerId, executionId: job.id, lease: job.lease, action: "complete", text: "Late", failureCode: "" })).toThrow();
    f.action("reassign", f.current(), 0, f.b); f.action("retry"); expect(f.store.claim(f.room.id, f.ownerId, f.b)?.kind).toBe("plan-step");
  });
  it("keeps a foreign plan step within the current guest grant and sanitizes failure state", () => {
    const f = fixture(), digest = networkHash("link"); f.store.invite({ operationId: "invite", roomId: f.room.id, actorId: f.ownerId, expectedRevision: f.store.get(f.room.id).revision,
      digest, reusable: false, lifetimeMs: 60_000 });
    const guest = f.store.accept({ operationId: "join", linkDigest: digest, homeServerId: "foreign", displayName: "Guest", credentialDigest: networkHash("membership") }).memberId;
    f.send("Arrange this", { actorId: guest, forcePlan: true }); f.settle(f.a, { decision: { needsPlan: true, steps: [{ actorId: f.a, task: "Public answer" }] } });
    const plan = f.current(); f.store.plans.action({ operationId: "guest-start", roomId: f.room.id, actorId: guest, planId: plan.id, expectedRevision: plan.revision, action: "start", position: 0, targetId: "", sourceMessageId: "" });
    const job = f.store.claim(f.room.id, f.ownerId, f.a)!; expect(job.accessMode).toBe("chat");
    const failure = { roomId: f.room.id, ownerId: f.ownerId, executionId: job.id, lease: job.lease, action: "fail", text: "", failureCode: "PRIVATE_PATH" };
    expect(f.store.settle(failure).failureCode).toBe("failed"); expect(f.store.settle(failure).failureCode).toBe("failed");
    expect(f.current().steps[0]?.failureCode).toBe("failed"); expect(JSON.stringify(f.current())).not.toContain("PRIVATE_PATH");
    f.store.manage({ operationId: "revoke", roomId: f.room.id, actorId: f.ownerId, expectedRevision: f.store.get(f.room.id).revision,
      action: "set-access", targetId: f.a, value: "none", throughSequence: 0 });
    expect(() => f.store.plans.action({ operationId: "escalation", roomId: f.room.id, actorId: guest, planId: f.current().id, expectedRevision: f.current().revision, action: "reassign", position: 0, targetId: f.a, sourceMessageId: "" })).toThrow();
  });
});
