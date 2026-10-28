import { afterEach, describe, expect, it } from "vitest";
import { OperationalStore } from "./operational-store.js";
import { PartnerNetworkStore, networkHash, networkHumanId } from "./partner-network-store.js";

const databases: OperationalStore[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture(count = 6) {
  const db = new OperationalStore(":memory:"); databases.push(db); const store = new PartnerNetworkStore(db); let operation = 0;
  const room = store.create({ operationId: "create", serverId: "home", origin: "https://home.test", name: "Group", displayName: "Owner",
    partners: Array.from({ length: count }, (_, index) => ({ id: `p${index}`, name: `Member ${index}`, description: "" })) });
  const ownerId = networkHumanId("home"), actors = room.members.filter(actor => actor.kind === "partner"), current = () => store.get(room.id);
  const send = (text: string, mentions: string[] = [], threadRootId = "", actorId = ownerId) => store.send({ roomId: room.id, operationId: `send:${++operation}`, actorId, text, mentions, mentionAll: false, threadRootId, quoteId: "", attachments: [] });
  const settle = (actorId: string, text = "A useful reply") => { const job = store.claim(room.id, ownerId, actorId); expect(job).toBeDefined();
    const input = { roomId: room.id, ownerId, executionId: job!.id, lease: job!.lease, action: "complete", text, failureCode: "", completionId: `complete:${job!.id}` };
    return { job: job!, input, result: store.settle(input) }; };
  const manage = (action: string, actorId = ownerId, extra: Partial<Parameters<PartnerNetworkStore["manage"]>[0]> = {}) => store.manage({ roomId: room.id, operationId: `manage:${++operation}`, actorId,
    action, expectedRevision: current().revision, targetId: "", value: "", throughSequence: 0, ...extra });
  const join = () => { store.invite({ operationId: "invite", roomId: room.id, actorId: ownerId, expectedRevision: current().revision, digest: networkHash("invite"), lifetimeMs: 60_000, reusable: true });
    return store.accept({ operationId: "join", linkDigest: networkHash("invite"), homeServerId: "guest", displayName: "Guest", credentialDigest: networkHash("credential") }).memberId; };
  return { db, store, room, actors, ownerId, current, send, settle, manage, join };
}

describe("authority-owned single-speaker groups", () => {
  it("creates one deterministic queue, automatically finishes five turns, and retains the exact sixth-turn receipt", () => {
    const f = fixture(), source = f.send("Everyone give a view"), initial = f.store.plans.current(f.room.id)!;
    expect(initial).toMatchObject({ kind: "talk", organizerId: "", status: "running", sourceMessageId: source.id });
    expect(initial.steps.map(step => step.actorId)).toEqual(f.actors.map(actor => actor.id));
    expect(f.store.executions(f.room.id).some(job => job.kind === "plan-decision")).toBe(false);
    for (let index = 0; index < 5; index++) {
      expect(f.store.claim(f.room.id, f.ownerId, f.actors[index + 1]!.id)).toBeUndefined();
      f.settle(f.actors[index]!.id, index === 1 ? "NO_REPLY" : `View ${index}`);
    }
    const waiting = f.store.plans.current(f.room.id)!; expect(waiting).toMatchObject({ status: "waiting", currentStep: 4 });
    expect(f.store.claim(f.room.id, f.ownerId, f.actors[5]!.id)).toBeUndefined();
    const request = { roomId: f.room.id, operationId: "continue-sixth", actorId: f.ownerId, planId: waiting.id, expectedRevision: waiting.revision,
      action: "continue", position: 0, targetId: "", sourceMessageId: "" };
    f.store.plans.action(request); const sixth = f.settle(f.actors[5]!.id); f.store.plans.action(request); f.store.settle(sixth.input);
    expect(f.store.plans.get(f.room.id, waiting.id).status).toBe("completed");
    expect(f.store.executions(f.room.id)).toHaveLength(6);
    expect(f.store.messages(f.room.id).filter(message => message.authorId.startsWith("partner:"))).toHaveLength(5);
    expect(f.store.canContinue(f.room.id)).toBe(false);
  });
  it("delivers running queue notes, rejects an incomplete note receipt, and treats a new waiting message as a new queue", () => {
    const f = fixture(); f.send("Original request"); const first = f.store.claim(f.room.id, f.ownerId, f.actors[0]!.id)!;
    const note = f.send("A note for this speaker"), plan = f.store.plans.current(f.room.id)!;
    expect(plan.noteMessageIds).toEqual([note.id]); expect(f.store.plans.list(f.room.id)).toHaveLength(1);
    const input = { roomId: f.room.id, ownerId: f.ownerId, executionId: first.id, lease: first.lease, action: "complete", text: "Early reply", failureCode: "", completionId: "early" };
    expect(f.store.settle(input).status).toBe("running");
    f.store.settle({ ...input, completionId: "with-note", seenNoteIds: [note.id], text: "Reply with note" });
    for (let index = 1; index < 5; index++) f.settle(f.actors[index]!.id);
    f.send("A new question"); expect(f.store.plans.get(f.room.id, plan.id).status).toBe("stopped");
    expect(f.store.plans.current(f.room.id)?.id).not.toBe(plan.id);
    expect(() => f.store.settle({ ...input, completionId: "late", seenNoteIds: [note.id] })).toThrow();
  });
  it("answers Threads once in mention order, chooses the first unmentioned member and isolates concurrent conversations", () => {
    const f = fixture(2), a = f.actors[0]!.id, b = f.actors[1]!.id;
    const root = f.send("Root", [a]); f.settle(a);
    const topic = f.send("Both answer here", [b, a], root.id); expect(f.store.claim(f.room.id, f.ownerId, a)).toBeUndefined();
    f.settle(b); f.settle(a); expect(f.store.executions(f.room.id).filter(job => job.sourceMessageId === topic.id)).toHaveLength(2);
    const first = f.send("No mention", [], root.id), firstJob = f.store.claim(f.room.id, f.ownerId, a)!;
    expect(firstJob.sourceMessageId).toBe(first.id); expect(f.store.claim(f.room.id, f.ownerId, b)).toBeUndefined();
    const other = f.send("Other main conversation", [a]), mainJob = f.store.claim(f.room.id, f.ownerId, a)!;
    expect(mainJob.sourceMessageId).toBe(other.id); expect(f.store.validateExecution(f.room.id, firstJob.id, firstJob.lease, f.ownerId).job.status).toBe("running");
  });
  it("does not let a member stop another person's companion work or control their queue", () => {
    const f = fixture(), guest = f.join(); f.send("Owner's queue"); const job = f.store.claim(f.room.id, f.ownerId, f.actors[0]!.id)!;
    f.manage("stop", guest); expect(f.store.validateExecution(f.room.id, job.id, job.lease, f.ownerId).job.status).toBe("running");
    expect(() => f.manage("stop", guest, { value: "all" })).toThrow();
    const plan = f.store.plans.current(f.room.id)!;
    expect(() => f.store.plans.action({ operationId: "foreign-stop", roomId: f.room.id, actorId: guest, planId: plan.id, expectedRevision: plan.revision,
      action: "stop", position: 0, targetId: "", sourceMessageId: "" })).toThrow();
    f.manage("stop", f.ownerId); expect(() => f.store.validateExecution(f.room.id, job.id, job.lease, f.ownerId)).toThrow();
  });
  it("keeps each human's thread read and explicit follow independent from the main chat and across readers", () => {
    const f = fixture(1), guest = f.join(), a = f.actors[0]!.id, root = f.send("Root", [a]); f.settle(a);
    const reply = f.send("Reply mentioning Guest", [guest], root.id), through = reply.sequence;
    f.manage("mark-read", guest, { throughSequence: f.current().latestSequence });
    expect(f.store.reader(f.room.id, guest, root.id)).toMatchObject({ readSequence: 0, following: false });
    f.manage("follow-thread", guest, { threadRootId: root.id, throughSequence: through, following: true });
    expect(f.store.reader(f.room.id, guest, root.id)).toMatchObject({ readSequence: 0, following: true });
    f.manage("mark-read", guest, { threadRootId: root.id, throughSequence: through });
    f.manage("mark-read", guest, { threadRootId: root.id, throughSequence: root.sequence });
    const secondDevice = new PartnerNetworkStore(f.db); expect(secondDevice.reader(f.room.id, guest, root.id)).toMatchObject({ readSequence: through, following: true });
    expect(secondDevice.reader(f.room.id, f.ownerId, root.id)).toMatchObject({ readSequence: 0, following: false });
    f.manage("remove-member", f.ownerId, { targetId: guest });
    expect(() => secondDevice.reader(f.room.id, guest, root.id)).toThrow();
  });
});
