import { afterEach, describe, expect, it } from "vitest";
import { OperationalStore } from "./operational-store.js";
import { PartnerNetworkStore, networkHash, networkHumanId, networkPartnerId, type NetworkRoom } from "./partner-network-store.js";

const databases: OperationalStore[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
function fixture() {
  const database = new OperationalStore(":memory:"); databases.push(database); let now = 1_000_000;
  const store = new PartnerNetworkStore(database, () => now), ownerId = networkHumanId("home-a"), guestId = networkHumanId("home-b");
  const room = store.create({ operationId: "create", name: "Group", displayName: "Owner", serverId: "home-a", origin: "https://home-a.example", partners: [{ id: "helper", name: "Helper", description: "Public helper" }] });
  const current = () => store.get(room.id);
  const manage = (action: string, actorId = ownerId, targetId = "", value = "") => store.manage({ operationId: `${action}-${Math.random()}`, roomId: room.id, actorId,
    expectedRevision: current().revision, action, targetId, value, throughSequence: 0 });
  const invite = (name: string, reusable = false) => store.invite({ operationId: `invite-${name}`, roomId: room.id, actorId: ownerId, expectedRevision: current().revision,
    digest: networkHash(name), reusable, lifetimeMs: 60_000 });
  const accept = (name: string, operationId = "join", homeServerId = "home-b") => store.accept({ operationId, linkDigest: networkHash(name), homeServerId, displayName: "Guest", credentialDigest: networkHash("credential") });
  const send = (text: string, actorId = ownerId, id = `send-${Math.random()}`, mentions: string[] = [networkPartnerId("home-a", "helper")]) => store.send({ operationId: id, roomId: room.id, actorId, text, mentions, mentionAll: false,
    threadRootId: "", quoteId: "", attachments: [] });
  return { store, database, room, current, ownerId, guestId, manage, invite, accept, send, advance: (ms: number) => { now += ms; } };
}
describe("conversation authority and foreign membership", () => {
  it("keeps one stable companion identity and exactly one durable message/queue effect for a repeated send", () => {
    const f = fixture(), one = f.send("hello", f.ownerId, "same-send"), retry = f.send("hello", f.ownerId, "same-send");
    expect(retry).toEqual(one); expect(f.store.messages(f.room.id)).toHaveLength(1); expect(f.store.executions(f.room.id)).toHaveLength(1);
    expect(f.current().members.find(member => member.kind === "partner")!.id).toBe(networkPartnerId("home-a", "helper"));
    const restored = new PartnerNetworkStore(f.database); expect(restored.get(f.room.id).latestSequence).toBe(1);
    expect(() => f.send("changed", f.ownerId, "same-send")).toThrow();
  });
  it("binds single-use acceptance to the original request and revokes only the selected reusable link", () => {
    const f = fixture(); f.invite("single"); const accepted = f.accept("single"); expect(f.accept("single")).toEqual(accepted);
    expect(() => f.accept("single", "another", "home-c")).toThrow();
    const first = f.invite("reusable", true); f.invite("other", true); f.manage("revoke-link", f.ownerId, "", first.id);
    expect(() => f.store.link(networkHash("reusable"))).toThrow(); expect(f.store.link(networkHash("other")).state).toBe("active");
    f.advance(60_000); expect(() => f.store.link(networkHash("other"))).toThrow();
  });
  it("separates group administration from companion owner authorization", () => {
    const f = fixture(); f.invite("join"); f.accept("join"); f.manage("set-role", f.ownerId, f.guestId, "admin");
    const partnerId = networkPartnerId("home-a", "helper");
    expect(() => f.manage("set-access", f.guestId, partnerId, "tools")).toThrow();
    f.manage("set-access", f.ownerId, partnerId, "tools"); expect(f.current().members.find(member => member.id === partnerId)?.guestAccess).toBe("tools");
    const before = f.current(); expect(() => f.manage("leave")).toThrow(); expect(f.current()).toEqual(before);
    f.manage("set-role", f.ownerId, f.guestId, "owner"); f.manage("leave"); expect(f.current().members.find(member => member.id === partnerId)?.state).toBe("left");
    expect(() => f.send("removed owner cannot reuse receipt", f.ownerId)).toThrow();
  });
  it("rejects the entire original mention intent when one explicit member leaves", () => {
    const f = fixture(); f.invite("join"); f.accept("join"); f.manage("leave", f.guestId);
    expect(() => f.send("@Guest @Helper", f.ownerId, "mention", [f.guestId, networkPartnerId("home-a", "helper")])).toThrow();
    expect(f.store.messages(f.room.id).filter(message => message.kind !== "member-joined")).toEqual([]);
  });
  it("fences leases after authorization changes and never reclaims expired work under a new execution", () => {
    const f = fixture(); f.invite("join"); f.accept("join"); const companion = networkPartnerId("home-a", "helper");
    f.send("guest prompt", f.guestId); const job = f.store.claim(f.room.id, f.ownerId, companion)!; expect(job.accessMode).toBe("chat");
    const renewal = f.store.settle({ roomId: f.room.id, ownerId: f.ownerId, executionId: job.id, lease: job.lease, action: "renew", text: "", failureCode: "" }); expect(renewal.status).toBe("running");
    f.manage("set-access", f.ownerId, companion, "none"); expect(() => f.store.settle({ roomId: f.room.id, ownerId: f.ownerId, executionId: job.id, lease: job.lease, action: "complete", text: "late private answer", failureCode: "" })).toThrow();
    expect(f.store.messages(f.room.id).some(message => message.text === "late private answer")).toBe(false);
    f.send("owner prompt"); const ownerJob = f.store.claim(f.room.id, f.ownerId, companion)!; expect(ownerJob.accessMode).toBe("owner");
    f.advance(30_000); expect(f.store.claim(f.room.id, f.ownerId, companion)).toBeUndefined(); expect(f.store.executions(f.room.id).find(item => item.id === ownerJob.id)?.status).toBe("unknown");
  });
  it("accepts an immutable completion receipt once and refuses a changed completion", () => {
    const f = fixture(), companion = networkPartnerId("home-a", "helper"); f.send("hello"); const job = f.store.claim(f.room.id, f.ownerId, companion)!;
    const completion = { roomId: f.room.id, ownerId: f.ownerId, executionId: job.id, lease: job.lease, action: "complete", text: "answer", failureCode: "" };
    expect(f.store.settle(completion).status).toBe("completed"); expect(f.store.settle(completion).status).toBe("completed");
    expect(f.store.messages(f.room.id).filter(message => message.text === "answer")).toHaveLength(1);
    expect(() => f.store.settle({ ...completion, text: "changed" })).toThrow();
  });
  it("makes interrupted work unknown on restart and stops work when archived or dissolved", () => {
    const f = fixture(), companion = networkPartnerId("home-a", "helper"); f.send("first"); f.store.claim(f.room.id, f.ownerId, companion); f.store.recover();
    expect(f.store.executions(f.room.id)[0]?.status).toBe("unknown"); expect(f.store.claim(f.room.id, f.ownerId, companion)).toBeUndefined();
    f.send("second"); f.manage("archive"); expect(f.store.executions(f.room.id).find(job => job.status === "queued")).toBeUndefined(); expect(() => f.send("blocked")).toThrow();
    f.manage("restore"); f.send("third"); f.manage("dissolve"); expect(() => f.manage("restore")).toThrow(); expect(f.store.messages(f.room.id)).toHaveLength(3);
  });
  it("keeps self messages from adding unread and retains history for current members only", () => {
    const f = fixture(); f.send("my message"); let owner = f.current().members.find(member => member.id === f.ownerId)!;
    expect(owner.unreadSequence).toBe(0); f.invite("join"); f.accept("join"); f.send("guest message", f.guestId);
    owner = f.current().members.find(member => member.id === f.ownerId)!; expect(owner.unreadSequence).toBeGreaterThan(owner.readSequence);
    f.manage("leave", f.guestId); expect(() => f.store.assertJoined(f.room.id, f.guestId)).toThrow();
    const hidden = f.manage("remove-list", f.guestId); expect(hidden.members.find(member => member.id === f.guestId)?.removedFromList).toBe(true);
  });
  it("keeps permanent reusable invitations valid and rejects cached administrative receipts after leaving", () => {
    const f = fixture(), link = f.store.invite({ operationId: "permanent", roomId: f.room.id, actorId: f.ownerId, expectedRevision: f.current().revision, digest: networkHash("permanent"), reusable: true, lifetimeMs: 0 });
    expect(link.expiresAt).toBeNull(); f.advance(365 * 86400_000); expect(f.store.link(link.digest).state).toBe("active");
    f.accept("permanent"); const request = { operationId: "read-once", roomId: f.room.id, actorId: f.guestId, expectedRevision: 0, action: "mark-read", targetId: "", value: "", throughSequence: 0 };
    f.store.manage(request); f.manage("leave", f.guestId); expect(() => f.store.manage(request)).toThrow();
    f.manage("revoke-link", f.ownerId, "", link.id); expect(() => f.store.link(link.digest)).toThrow();
  });
  it("dispatches automatic circles against one snapshot, rotates sequentially, caps actual replies and continues original responders only", () => {
    const f = fixture(), room = f.store.create({ operationId: "four", serverId: "home-a", origin: "https://home-a.example", name: "Four", displayName: "Owner", partners: ["a", "b", "c", "d"].map(id => ({ id, name: id, description: "" })) }), ids = room.members.filter(actor => actor.kind === "partner").map(actor => actor.id);
    const send = (id: string, text: string, mentions: string[], threadRootId = "") => f.store.send({ operationId: id, roomId: room.id, actorId: f.ownerId, text, mentions, mentionAll: false, attachments: [], quoteId: "", threadRootId });
    const complete = (job: NonNullable<ReturnType<typeof f.store.claim>>) => f.store.settle({ roomId: room.id, ownerId: f.ownerId, executionId: job.id, lease: job.lease, action: "complete", text: `Reply ${job.id}`, failureCode: "" });
    const root = send("root", "Topic", [ids[0]!]); complete(f.store.claim(room.id, f.ownerId, ids[0]!)!);
    const source = send("thread", "Discuss", [], root.id), jobs = ids.map(id => f.store.claim(room.id, f.ownerId, id)!);
    expect(jobs.map(job => job.contextThroughSequence)).toEqual(ids.map(() => source.sequence)); expect(jobs.every(job => job.parallel)).toBe(true);
    expect(f.store.canContinue(room.id, root.id)).toBe(false); for (const job of jobs) complete(job);
    for (const circle of [1, 2]) { const ordered = [...ids.slice(circle), ...ids.slice(0, circle)].slice(0, circle === 2 ? 2 : 4);
      expect(f.store.claim(room.id, f.ownerId, ordered[1]!)).toBeUndefined(); for (const id of ordered) { const job = f.store.claim(room.id, f.ownerId, id)!; expect(job.circle).toBe(circle); expect(job.parallel).toBe(false); complete(job); } }
    expect(f.store.messages(room.id).filter(message => message.threadRootId === root.id && message.authorId.startsWith("partner:") && !message.deleted)).toHaveLength(10);
    expect(f.store.canContinue(room.id, root.id)).toBe(true);
    f.store.manage({ operationId: "new", roomId: room.id, actorId: f.ownerId, expectedRevision: f.store.get(room.id).revision, action: "add-partner", targetId: "new", value: "", throughSequence: 0, partner: { id: "new", name: "New", description: "" } });
    f.store.manage({ operationId: "continue", roomId: room.id, actorId: f.ownerId, expectedRevision: f.store.get(room.id).revision, action: "continue", targetId: "", value: root.id, throughSequence: 0 });
    expect(f.store.executions(room.id).filter(job => job.status === "queued").map(job => job.actorId).sort()).toEqual([...ids].sort());
    expect(f.store.executions(room.id).filter(job => job.status === "queued").every(job => !job.parallel)).toBe(true);
  });
});
