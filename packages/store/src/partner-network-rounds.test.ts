import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { OperationalStore } from "./operational-store.js";
import { PartnerNetworkStore, type NetworkMessage } from "./partner-network-store.js";
import { PartnerNetworkRounds, type NetworkRoundExecution } from "./partner-network-rounds.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const run of cleanup.splice(0)) await run(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-network-rounds-")), store = new OperationalStore(join(root, "state.db"));
  cleanup.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const room = new PartnerNetworkStore(store).create({ operationId: "create", serverId: "host", origin: "https://host.test", name: "Group", displayName: "Owner", partners: [] });
  const message: NetworkMessage = { id: "source", sequence: 1, createdAt: 1, authorId: room.members[0]!.id, authorName: "Owner", text: "Discuss", mentions: [], threadRootId: "", quoteId: "", deleted: false, attachments: [], reactions: [] };
  room.latestSequence = 1; const rounds = new PartnerNetworkRounds(store);
  const job = (actorId: string, ordinal: number, circle = 0, parallel = false): NetworkRoundExecution => ({ id: `${circle}-${actorId}`, actorId, ordinal, circle, parallel,
    contextThroughSequence: 1, roomId: room.id, roundId: "source", requesterId: message.authorId, sourceMessageId: message.id,
    accessMode: "owner", accessRevision: 1, status: "queued", lease: 0, leaseExpiresAt: 0, failureCode: "", kind: "reply" });
  return { room, message, rounds, job };
}
it("freezes the first automatic circle and keeps explicit mentions sequential", async () => {
  const f = await fixture(), responders = ["a", "b", "c", "d"];
  const turns = f.rounds.start({ ...f, requesterId: f.message.authorId, roundId: "source", responders, mentionAll: false });
  expect(turns.map(turn => turn.parallel)).toEqual([true, true, true, true]);
  const jobs = turns.map(turn => ({ ...f.job(turn.actorId, turn.ordinal), ...turn }));
  f.room.latestSequence = 9; expect(jobs.map(job => f.rounds.contextThrough(f.room, job))).toEqual([1, 1, 1, 1]);
  expect(jobs.every(job => f.rounds.canClaim(job, jobs))).toBe(true);
  const explicit = f.rounds.start({ ...f, message: { ...f.message, mentions: ["b", "a"] }, requesterId: f.message.authorId, roundId: "specific", responders: ["b", "a"], mentionAll: false });
  expect(explicit.map(turn => turn.parallel)).toEqual([false, false]);
});
it("rotates later sequential circles and stops at ten actual replies", async () => {
  const f = await fixture(), responders = ["a", "b", "c", "d"];
  let turns = f.rounds.start({ ...f, requesterId: f.message.authorId, roundId: "source", responders, mentionAll: false });
  for (let circle = 0; turns.length; circle++) {
    expect(circle).toBeLessThan(3); if (circle === 1) expect(turns.map(turn => turn.actorId)).toEqual(["b", "c", "d", "a"]);
    if (circle) expect(turns.every(turn => !turn.parallel)).toBe(true);
    const jobs = turns.map(turn => ({ ...f.job(turn.actorId, turn.ordinal, turn.circle, turn.parallel), ...turn })); let next: readonly typeof turns[number][] = [];
    for (const job of jobs) { if (!job.parallel) expect(f.rounds.canClaim(job, jobs)).toBe(true); job.status = "completed"; f.room.latestSequence++;
      next = f.rounds.settled({ room: f.room, job, jobs, published: true, eligible: responders }); }
    turns = next;
  }
  expect(f.rounds.get(f.room.id, "source")).toMatchObject({ replies: 10, state: "completed", circle: 2 });
  expect(f.rounds.continuation(f.room.id, "source")).toEqual(responders);
});
it("ends a silent circle and a real join welcome without continuing, and preserves stopped intent", async () => {
  const f = await fixture(), responders = ["a", "b"];
  f.rounds.start({ ...f, requesterId: f.message.authorId, roundId: "source", responders, mentionAll: false });
  const jobs = responders.map((id, ordinal) => ({ ...f.job(id, ordinal), status: "completed" as const }));
  for (const job of jobs) expect(f.rounds.settled({ room: f.room, job, jobs, published: false, eligible: responders })).toEqual([]);
  expect(f.rounds.get(f.room.id, "source")?.state).toBe("completed");
  const welcome = { ...f.message, id: "joined", kind: "member-joined" as const };
  f.rounds.start({ ...f, message: welcome, requesterId: welcome.authorId, roundId: "joined", responders, mentionAll: false });
  const welcomeJobs = jobs.map(job => ({ ...job, id: `welcome-${job.id}`, sourceMessageId: "joined", roundId: "joined" }));
  for (const job of welcomeJobs) expect(f.rounds.settled({ room: f.room, job, jobs: welcomeJobs, published: true, eligible: responders })).toEqual([]);
  expect(f.rounds.continuation(f.room.id, "joined")).toBeUndefined();
  f.rounds.start({ ...f, requesterId: f.message.authorId, roundId: "stopped", responders, mentionAll: false }); f.rounds.stopRoom(f.room.id);
  expect(f.rounds.canClaim({ ...f.job("a", 0), roundId: "stopped" }, [])).toBe(false);
});
it("drops failed or unknown members for the remaining circles and keeps an explicit continuation sequential", async () => {
  const f = await fixture(), responders = ["a", "b", "c"];
  f.rounds.start({ ...f, requesterId: f.message.authorId, roundId: "source", responders, mentionAll: false });
  const jobs = responders.map((id, ordinal) => f.job(id, ordinal)); jobs[0]!.status = "failed";
  expect(f.rounds.settled({ room: f.room, job: jobs[0]!, jobs, published: false, eligible: responders })).toEqual([]);
  jobs[1]!.status = "unknown";
  expect(f.rounds.settled({ room: f.room, job: jobs[1]!, jobs, published: false, eligible: responders })).toEqual([]);
  jobs[2]!.status = "completed";
  const turns = f.rounds.settled({ room: f.room, job: jobs[2]!, jobs, published: true, eligible: responders }); expect(turns.map(turn => turn.actorId)).toEqual(["c"]);
  const continued = f.rounds.start({ ...f, requesterId: f.message.authorId, roundId: "continued", responders, mentionAll: false, continued: true });
  expect(continued.every(turn => !turn.parallel)).toBe(true); expect(continued.map(turn => turn.actorId)).toEqual(responders);
});
