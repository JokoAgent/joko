import { describe, expect, it } from "vitest";
import type { QuestionWizardDraft } from "./components/coding-ui-behavior.js";
import {
  InteractionOwnershipCoordinator,
  questionWizardDraftCodec,
  type InteractionChannel,
  type InteractionChannelMessageEvent,
  type InteractionOwnershipEnvironment,
  type InteractionLock,
  type InteractionLockManager,
  type InteractionOwnerKey
} from "./interaction-ownership-coordinator.js";

const key: InteractionOwnerKey = {
  serverId: "server-a",
  profileId: "profile-a",
  sessionId: "task-a",
  interactionId: "question-a",
  interactionGeneration: 3n
};
const emptyDraft: QuestionWizardDraft = { answers: {}, otherText: {}, currentIndex: 0, minimized: false };
const completedDraft: QuestionWizardDraft = {
  answers: {
    approach: { kind: "single", selection: { kind: "other", text: "Keep the bounded owner" } },
    checks: { kind: "multiple", choiceIds: ["unit"], otherText: "mounted" }
  },
  otherText: { approach: "Keep the bounded owner", checks: "mounted in progress" },
  currentIndex: 1,
  minimized: true
};

function writeDraft(coordinator: InteractionOwnershipCoordinator<QuestionWizardDraft>, draft: QuestionWizardDraft): boolean {
  return coordinator.writeDraft(coordinator.snapshot.ownerToken ?? "not-owner", draft);
}

function beginSettle(coordinator: InteractionOwnershipCoordinator<QuestionWizardDraft>) {
  return coordinator.beginSettle(coordinator.snapshot.ownerToken ?? "not-owner");
}

describe("InteractionOwnershipCoordinator current-v1 ownership", () => {
  it("elects exactly one owner when initial claims start simultaneously", async () => {
    const fixture = new CoordinatorFixture();
    const peers = [fixture.coordinator("one", key), fixture.coordinator("two", key), fixture.coordinator("three", key)];
    await Promise.all(peers.map((peer) => peer.start()));
    await fixture.flush();
    expect(peers.filter((peer) => peer.snapshot.status === "owner")).toHaveLength(1);
    peers.forEach((peer) => peer.dispose());
  });

  it("elects one writer and transfers the complete typed draft to observers", async () => {
    const fixture = new CoordinatorFixture();
    const first = fixture.coordinator("first", key);
    const second = fixture.coordinator("second", key);

    await first.start();
    await second.start();
    await fixture.flush();

    expect(first.snapshot.status).toBe("owner");
    expect(second.snapshot.status).toBe("observer");
    expect(writeDraft(second, completedDraft)).toBe(false);
    expect(writeDraft(first, completedDraft)).toBe(true);
    await fixture.flush();

    expect(second.snapshot.draft).toEqual(completedDraft);
    expect(second.snapshot.revision).toBe(first.snapshot.revision);
    first.dispose();
    second.dispose();
  });

  it("hands the latest draft to an explicit takeover and fences the previous writer immediately", async () => {
    const fixture = new CoordinatorFixture();
    const first = fixture.coordinator("first", key);
    const second = fixture.coordinator("second", key);
    await first.start();
    await second.start();
    writeDraft(first, completedDraft);
    await fixture.flush();

    const takeover = second.takeover();
    await fixture.flush();
    await expect(takeover).resolves.toBe(true);

    expect(second.snapshot.status).toBe("owner");
    expect(second.snapshot.draft).toEqual(completedDraft);
    expect(first.snapshot.status).toBe("observer");
    expect(writeDraft(first, { ...completedDraft, currentIndex: 0 })).toBe(false);
    expect(writeDraft(second, { ...completedDraft, currentIndex: 0 })).toBe(true);
    await fixture.flush();
    expect(first.snapshot.draft?.currentIndex).toBe(0);
    first.dispose();
    second.dispose();
  });

  it("offers one directed handoff when two observers race to take over", async () => {
    const fixture = new CoordinatorFixture();
    const first = fixture.coordinator("first", key);
    const second = fixture.coordinator("second", key);
    const third = fixture.coordinator("third", key);
    await first.start();
    await second.start();
    await third.start();
    writeDraft(first, completedDraft);
    await fixture.flush();

    const secondTakeover = second.takeover();
    const thirdTakeover = third.takeover();
    await fixture.flush();

    const outcomes = await Promise.all([secondTakeover, thirdTakeover]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const winner = outcomes[0] ? second : third;
    const loser = outcomes[0] ? third : second;
    expect(winner.snapshot.status).toBe("owner");
    expect(winner.snapshot.draft).toEqual(completedDraft);
    expect(first.snapshot.status).toBe("observer");
    expect(loser.snapshot.status).toBe("observer");
    expect([first, second, third].filter((candidate) => writeDraft(candidate, completedDraft))).toEqual([winner]);
    first.dispose();
    second.dispose();
    third.dispose();
  });

  it("holds the exclusive owner through settle, preserves failures, and clears only confirmed success", async () => {
    const fixture = new CoordinatorFixture();
    const first = fixture.coordinator("first", key);
    const second = fixture.coordinator("second", key);
    await first.start();
    await second.start();
    writeDraft(first, completedDraft);
    await fixture.flush();

    const failedToken = beginSettle(first);
    expect(failedToken).toBeDefined();
    expect(writeDraft(first, emptyDraft)).toBe(false);
    const blockedTakeover = second.takeover();
    await fixture.flush();
    await expect(blockedTakeover).resolves.toBe(false);
    expect(second.snapshot.status).toBe("observer");
    expect(first.finishSettle(failedToken!, "failed")).toBe(true);
    expect(first.snapshot.draft).toEqual(completedDraft);
    expect(writeDraft(first, { ...completedDraft, currentIndex: 0 })).toBe(true);

    const successToken = beginSettle(first);
    expect(successToken).toBeDefined();
    expect(first.finishSettle(successToken!, "succeeded")).toBe(true);
    await fixture.flush();
    expect(second.snapshot.status).toBe("settled");
    expect(first.snapshot.status).toBe("settled");
    expect(first.snapshot.ownerToken).toBeUndefined();
    expect(first.snapshot.draft).toBeUndefined();
    first.pause();
    expect(first.snapshot.status).toBe("settled");
    await first.resume();
    expect(first.snapshot.status).toBe("settled");
    first.dispose();
    second.dispose();
  });

  it("keeps a confirmed-settle tombstone while server projection is delayed and never grants the peer a writable lease", async () => {
    const fixture = new CoordinatorFixture();
    const first = fixture.coordinator("first", key);
    const second = fixture.coordinator("second", key);
    await first.start();
    await second.start();
    writeDraft(first, completedDraft);
    await fixture.flush();

    const token = beginSettle(first);
    expect(token).toBeDefined();
    expect(first.finishSettle(token!, "succeeded")).toBe(true);
    await fixture.flush();

    expect(second.snapshot).toMatchObject({
      status: "settled",
      revision: first.snapshot.revision,
      ownerId: first.snapshot.ownerId
    });
    expect(second.snapshot.draft).toBeUndefined();

    // Simulate pagehide before the authoritative server projection reaches this peer.
    first.pause();
    await fixture.flush();
    expect(fixture.locks.active(fixture.lockName(key))).toBe(false);
    await expect(second.takeover()).resolves.toBe(false);
    expect(second.snapshot.status).toBe("settled");
    expect(writeDraft(second, emptyDraft)).toBe(false);
    expect(beginSettle(second)).toBeUndefined();
    expect(fixture.locks.active(fixture.lockName(key))).toBe(false);

    first.dispose();
    second.dispose();
  });

  it("fences a peer hidden before settle and every late joiner with the exact persisted generation tombstone", async () => {
    const fixture = new CoordinatorFixture();
    const owner = fixture.coordinator("owner", key);
    const livePeer = fixture.coordinator("live", key);
    const hiddenPeer = fixture.coordinator("hidden", key);
    await owner.start();
    await livePeer.start();
    await hiddenPeer.start();
    await fixture.flush();

    hiddenPeer.pause();
    const token = beginSettle(owner)!;
    expect(owner.finishSettle(token, "succeeded")).toBe(true);
    expect(JSON.parse(fixture.terminalStore.values.get(fixture.terminalKey(key))!)).toEqual({
      version: 1,
      type: "settled",
      scope: fixture.scope(key)
    });
    owner.pause();
    await fixture.flush();
    expect(fixture.locks.active(fixture.lockName(key))).toBe(false);

    await hiddenPeer.resume();
    const latePeer = fixture.coordinator("late", key);
    await latePeer.start();
    await fixture.flush();
    expect([livePeer, hiddenPeer, latePeer].map((peer) => peer.snapshot.status)).toEqual(["settled", "settled", "settled"]);
    expect([livePeer, hiddenPeer, latePeer].some((peer) => peer.snapshot.ownerToken !== undefined)).toBe(false);
    await expect(hiddenPeer.takeover()).resolves.toBe(false);

    const nextGeneration = fixture.coordinator("next-generation", { ...key, interactionGeneration: key.interactionGeneration + 1n });
    const otherProfile = fixture.coordinator("other-profile", { ...key, profileId: "profile-b" });
    await nextGeneration.start();
    await otherProfile.start();
    expect(nextGeneration.snapshot.status).toBe("owner");
    expect(otherProfile.snapshot.status).toBe("owner");

    owner.dispose(); livePeer.dispose(); hiddenPeer.dispose(); latePeer.dispose(); nextGeneration.dispose(); otherProfile.dispose();
  });

  it("rechecks the persisted terminal fence inside the granted Web Lock callback", async () => {
    const fixture = new CoordinatorFixture();
    const base = fixture.environment("claimant");
    let reads = 0;
    const environment: InteractionOwnershipEnvironment = {
      ...base,
      terminalStore: {
        getItem: () => {
          reads += 1;
          return reads === 1 ? null : JSON.stringify({ version: 1, type: "settled", scope: fixture.scope(key) });
        },
        setItem: () => { throw new Error("The claimant must not rewrite the terminal fence."); }
      }
    };
    const claimant = new InteractionOwnershipCoordinator(key, { kind: "draft", initialDraft: emptyDraft, codec: questionWizardDraftCodec }, environment);

    await claimant.start();
    await fixture.flush();

    expect(reads).toBe(2);
    expect(claimant.snapshot).toEqual({ key, status: "settled", revision: 0 });
    expect(fixture.locks.active(fixture.lockName(key))).toBe(false);
    expect(writeDraft(claimant, completedDraft)).toBe(false);
    claimant.dispose();
  });

  it("fails closed on malformed or unreadable exact-key terminal storage without old-shape fallback", async () => {
    const malformedFixture = new CoordinatorFixture();
    malformedFixture.terminalStore.values.set(malformedFixture.terminalKey(key), JSON.stringify({ version: 1, resolved: true, scope: malformedFixture.scope(key) }));
    const malformed = malformedFixture.coordinator("malformed", key);
    await malformed.start();
    expect(malformed.snapshot.status).toBe("unavailable");
    expect(malformedFixture.locks.active(malformedFixture.lockName(key))).toBe(false);

    const unreadableFixture = new CoordinatorFixture();
    unreadableFixture.terminalStore.failReads = true;
    const unreadable = unreadableFixture.coordinator("unreadable", key);
    await unreadable.start();
    expect(unreadable.snapshot.status).toBe("unavailable");
    expect(unreadableFixture.locks.active(unreadableFixture.lockName(key))).toBe(false);
  });

  it("resumes a page that returned during an in-flight settle after the RPC fails", async () => {
    const fixture = new CoordinatorFixture();
    const coordinator = fixture.coordinator("owner", key);
    await coordinator.start();
    const token = beginSettle(coordinator)!;

    coordinator.pause();
    await coordinator.resume();
    expect(coordinator.snapshot.status).toBe("claiming");
    expect(coordinator.finishSettle(token, "failed")).toBe(true);
    await fixture.flush();

    expect(coordinator.snapshot.status).toBe("owner");
    expect(coordinator.snapshot.ownerToken).toBeDefined();
    expect(writeDraft(coordinator, completedDraft)).toBe(true);
    coordinator.dispose();
  });

  it("fences a retired page but holds its lock until the captured settle finishes", async () => {
    const fixture = new CoordinatorFixture();
    const first = fixture.coordinator("first", key);
    const second = fixture.coordinator("second", key);
    await first.start();
    await second.start();
    writeDraft(first, completedDraft);
    const token = beginSettle(first);
    expect(token).toBeDefined();

    first.pause();
    await fixture.flush();
    expect(second.snapshot.status).toBe("observer");
    expect(writeDraft(second, emptyDraft)).toBe(false);
    expect(beginSettle(second)).toBeUndefined();
    expect(first.finishSettle(token!, "failed")).toBe(true);
    await fixture.flush();
    const takeover = second.takeover();
    await fixture.flush();
    await expect(takeover).resolves.toBe(true);
    expect(second.snapshot.status).toBe("owner");
    expect(second.snapshot.draft).toEqual(completedDraft);
    first.dispose();
    second.dispose();
  });

  it("keeps snapshot identity stable and never revives a disposed pending claim", async () => {
    const fixture = new CoordinatorFixture();
    const first = fixture.coordinator("first", key);
    const before = first.snapshot;
    expect(first.snapshot).toBe(before);
    const pendingStart = first.start();
    first.dispose();
    await pendingStart;
    await fixture.flush();
    expect(first.snapshot.status).not.toBe("owner");
    expect(writeDraft(first, completedDraft)).toBe(false);
  });

  it("fences callbacks from an earlier lock term after the same coordinator reacquires", async () => {
    const fixture = new CoordinatorFixture();
    const coordinator = fixture.coordinator("first", key);
    await coordinator.start();
    const firstToken = coordinator.snapshot.ownerToken!;
    coordinator.pause();
    await fixture.flush();
    await coordinator.resume();
    await fixture.flush();
    const secondToken = coordinator.snapshot.ownerToken!;

    expect(secondToken).not.toBe(firstToken);
    expect(coordinator.writeDraft(firstToken, completedDraft)).toBe(false);
    expect(coordinator.beginSettle(firstToken)).toBeUndefined();
    expect(coordinator.writeDraft(secondToken, completedDraft)).toBe(true);
    coordinator.dispose();
  });

  it("aborts a queued handoff when its acknowledgement is lost", async () => {
    const fixture = new CoordinatorFixture(0.01);
    fixture.channels.drop("takeover_ack");
    const first = fixture.coordinator("first", key);
    const second = fixture.coordinator("second", key);
    await first.start();
    await second.start();

    const takeover = second.takeover();
    await fixture.flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    await fixture.flush();

    await expect(takeover).resolves.toBe(false);
    expect(first.snapshot.status).toBe("owner");
    expect(second.snapshot.status).toBe("observer");
    expect(fixture.locks.queued(fixture.lockName(key))).toBe(0);
    first.dispose();
    second.dispose();
  });

  it("does not queue a second claim for duplicate or equal-conflicting takeover offers", async () => {
    const fixture = new CoordinatorFixture();
    fixture.channels.drop("takeover_ack");
    const first = fixture.coordinator("first", key);
    const second = fixture.coordinator("second", key);
    await first.start(); await second.start();
    const takeover = second.takeover(); await fixture.flush();
    const offer = fixture.channels.messages.find((message) => isMessageType(message, "takeover_offer")) as Record<string, unknown>;
    expect(offer).toBeDefined();
    const before = second.snapshot;
    fixture.broadcast(key, offer);
    fixture.broadcast(key, { ...offer, senderId: "conflict", ownerId: "conflict", offerId: "conflicting-offer", draft: completedDraft });
    await fixture.flush();
    expect(fixture.locks.queued(fixture.lockName(key))).toBe(1);
    expect(second.snapshot).toBe(before);
    first.dispose(); second.dispose();
    await expect(takeover).resolves.toBe(false);
  });

  it("re-elects a live observer after release and isolates different owner keys", async () => {
    const fixture = new CoordinatorFixture();
    const first = fixture.coordinator("first", key);
    const second = fixture.coordinator("second", key);
    const isolated = fixture.coordinator("isolated", { ...key, interactionGeneration: key.interactionGeneration + 1n });
    await first.start();
    await second.start();
    await isolated.start();
    writeDraft(first, completedDraft);
    await fixture.flush();

    expect(isolated.snapshot.status).toBe("owner");
    expect(isolated.snapshot.draft).toEqual(emptyDraft);
    first.pause();
    await fixture.flush();

    expect(second.snapshot.status).toBe("owner");
    expect(second.snapshot.draft).toEqual(completedDraft);
    await first.resume();
    await fixture.flush();
    expect(first.snapshot.status).toBe("observer");
    first.dispose();
    second.dispose();
    isolated.dispose();
  });

  it("announces release only after the Web Lock request completes, then re-elects the live peer", async () => {
    const fixture = new CoordinatorFixture();
    const locks = new DeferredReleaseLockManager();
    const first = new InteractionOwnershipCoordinator(key, { kind: "draft", initialDraft: emptyDraft, codec: questionWizardDraftCodec }, fixture.environment("first", locks));
    const second = new InteractionOwnershipCoordinator(key, { kind: "draft", initialDraft: emptyDraft, codec: questionWizardDraftCodec }, fixture.environment("second", locks));
    await first.start();
    await second.start();
    writeDraft(first, completedDraft);
    await fixture.flush();
    const releasesBeforePause = fixture.channels.messages.filter((message) => isMessageType(message, "release")).length;

    first.pause();
    await fixture.flush();

    expect(locks.callbackExited(fixture.lockName(key))).toBe(true);
    expect(locks.active(fixture.lockName(key))).toBe(true);
    expect(fixture.channels.messages.filter((message) => isMessageType(message, "release"))).toHaveLength(releasesBeforePause);
    expect(second.snapshot.status).toBe("observer");

    locks.completeRelease(fixture.lockName(key));
    await fixture.flush();

    expect(fixture.channels.messages.filter((message) => isMessageType(message, "release"))).toHaveLength(releasesBeforePause + 1);
    expect(second.snapshot.status).toBe("owner");
    expect(second.snapshot.draft).toEqual(completedDraft);
    expect(locks.active(fixture.lockName(key))).toBe(true);

    first.dispose();
    second.dispose();
    await fixture.flush();
    if (locks.callbackExited(fixture.lockName(key))) {
      locks.completeRelease(fixture.lockName(key));
      await fixture.flush();
    }
  });

  it("fails closed without both Web Locks and BroadcastChannel", async () => {
    const coordinator = new InteractionOwnershipCoordinator(key, { kind: "draft", initialDraft: emptyDraft, codec: questionWizardDraftCodec }, undefined);
    await coordinator.start();
    expect(coordinator.snapshot.status).toBe("unavailable");
    expect(writeDraft(coordinator, completedDraft)).toBe(false);
    await expect(coordinator.takeover()).resolves.toBe(false);
  });

  it("ignores malformed, aliased, and stale BroadcastChannel messages", async () => {
    const fixture = new CoordinatorFixture();
    const first = fixture.coordinator("first", key);
    const second = fixture.coordinator("second", key);
    await first.start();
    await second.start();
    writeDraft(first, completedDraft);
    await fixture.flush();
    const before = second.snapshot;

    fixture.broadcast(key, {
      version: 1,
      type: "state",
      scope: fixture.scope(key),
      senderId: "attacker",
      ownerId: "attacker",
      term: "term",
      revision: before.revision + 100,
      draft: completedDraft,
      legacyAnswers: {}
    });
    fixture.broadcast(key, {
      version: 1,
      type: "state",
      scope: fixture.scope(key),
      senderId: "attacker",
      ownerId: "attacker",
      term: "term",
      revision: Math.max(0, before.revision - 1),
      draft: emptyDraft
    });
    fixture.broadcast(key, {
      version: 1,
      type: "state",
      scope: fixture.scope(key),
      senderId: "observer",
      ownerId: "claimed-owner",
      term: "term",
      revision: before.revision + 101,
      draft: completedDraft
    });
    fixture.broadcast(key, {
      version: 1,
      type: "state",
      scope: fixture.scope(key),
      senderId: "claimed-owner",
      ownerId: "claimed-owner",
      term: "term",
      revision: before.revision + 102,
      draft: { ...completedDraft, answers: { ...completedDraft.answers, checks: { kind: "multiple", choiceIds: ["unit"], otherText: undefined } } }
    });
    await fixture.flush();

    expect(second.snapshot).toEqual(before);
    first.dispose();
    second.dispose();
  });

  it("accepts only the exact settled wire shape with a null draft", async () => {
    const fixture = new CoordinatorFixture();
    const first = fixture.coordinator("first", key);
    const second = fixture.coordinator("second", key);
    await first.start();
    await second.start();
    await fixture.flush();
    const before = second.snapshot;
    const exact = {
      version: 1,
      type: "settled",
      scope: fixture.scope(key),
      senderId: "settling-owner",
      ownerId: "settling-owner",
      term: "settling-term",
      revision: before.revision + 1,
      draft: null
    };
    const invalidMessages: readonly unknown[] = [
      { ...exact, version: 0 },
      { ...exact, type: "resolved" },
      { ...exact, draft: completedDraft },
      { version: 1, type: "settled", scope: exact.scope, senderId: exact.senderId, ownerId: exact.ownerId, term: exact.term, revision: exact.revision },
      { ...exact, legacyResolved: true },
      { ...exact, senderId: "observer" },
      { ...exact, term: " " },
      { ...exact, revision: exact.revision + 0.5 }
    ];

    for (const invalid of invalidMessages) {
      fixture.broadcast(key, invalid);
      await fixture.flush();
      expect(second.snapshot).toBe(before);
    }

    fixture.broadcast(key, exact);
    await fixture.flush();
    expect(second.snapshot).toEqual({
      key,
      status: "settled",
      revision: exact.revision,
      ownerId: exact.ownerId
    });
    const settled = second.snapshot;
    fixture.broadcast(key, { ...exact, revision: before.revision });
    await fixture.flush();
    expect(second.snapshot).toBe(settled);

    first.dispose();
    second.dispose();
  });

  it("rejects non-null draft payloads in ownership-only mode", async () => {
    const fixture = new CoordinatorFixture();
    const first = fixture.ownershipCoordinator("first", key);
    const second = fixture.ownershipCoordinator("second", key);
    await first.start(); await second.start(); await fixture.flush();
    const before = second.snapshot;
    fixture.broadcast(key, { version: 1, type: "state", scope: fixture.scope(key), senderId: "forged", ownerId: "forged", term: "term", revision: before.revision + 1, draft: completedDraft });
    await fixture.flush();
    expect(second.snapshot).toBe(before);
    first.dispose(); second.dispose();
  });

  it("broadcasts only null draft markers for Permission ownership-only coordination", async () => {
    const permissionKey = { ...key, interactionId: "permission-a" };
    const fixture = new CoordinatorFixture();
    const first = fixture.ownershipCoordinator("permission-first", permissionKey);
    const second = fixture.ownershipCoordinator("permission-second", permissionKey);
    await first.start();
    await second.start();
    await fixture.flush();

    const takeover = second.takeover();
    await fixture.flush();
    await expect(takeover).resolves.toBe(true);
    const owner = first.snapshot.status === "owner" ? first : second;
    const token = owner.beginSettle(owner.snapshot.ownerToken!);
    expect(token).toBeDefined();
    expect(owner.finishSettle(token!, "succeeded")).toBe(true);
    await fixture.flush();

    const permissionMessages = fixture.channels.messages.filter((message): message is Record<string, unknown> =>
      typeof message === "object" && message !== null && (message as { readonly scope?: unknown }).scope === fixture.scope(permissionKey));
    const draftMessages = permissionMessages.filter((message) => ["state", "release", "takeover_offer", "settled"].includes(String(message.type)));
    expect(draftMessages.length).toBeGreaterThan(0);
    expect(draftMessages.every((message) => Object.hasOwn(message, "draft") && message.draft === null)).toBe(true);
    expect(permissionMessages.some((message) => Object.hasOwn(message, "decision") || Object.hasOwn(message, "details") || Object.hasOwn(message, "payload"))).toBe(false);

    first.dispose();
    second.dispose();
  });

  it("parses __proto__ field IDs as own data properties without prototype mutation", async () => {
    const fixture = new CoordinatorFixture();
    const first = fixture.coordinator("first", key);
    const second = fixture.coordinator("second", key);
    await first.start(); await second.start(); await fixture.flush();
    const revision = second.snapshot.revision + 1;
    const draft = JSON.parse('{"answers":{"__proto__":{"kind":"text","value":"safe"}},"otherText":{"__proto__":"also safe"},"currentIndex":0,"minimized":false}') as unknown;
    fixture.broadcast(key, { version: 1, type: "state", scope: fixture.scope(key), senderId: "new-owner", ownerId: "new-owner", term: "term", revision, draft });
    await fixture.flush();
    expect(Object.hasOwn(second.snapshot.draft!.answers, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(second.snapshot.draft!.answers)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["safe"]).toBeUndefined();
    first.dispose(); second.dispose();
  });

  it("treats a duplicate equal release as an identity no-op", async () => {
    const fixture = new CoordinatorFixture();
    const first = fixture.coordinator("first", key);
    const second = fixture.coordinator("second", key);
    await first.start(); await second.start(); await fixture.flush();
    const release = { version: 1, type: "release", scope: fixture.scope(key), senderId: first.snapshot.ownerId!, ownerId: first.snapshot.ownerId!, term: "term", revision: second.snapshot.revision, draft: emptyDraft };
    fixture.broadcast(key, release); await fixture.flush();
    const after = second.snapshot;
    fixture.broadcast(key, release); await fixture.flush();
    expect(second.snapshot).toBe(after);
    first.dispose(); second.dispose();
  });

  it("closes a channel whose listener registration fails", async () => {
    let closed = false;
    const coordinator = new InteractionOwnershipCoordinator(key, { kind: "draft", initialDraft: emptyDraft, codec: questionWizardDraftCodec }, {
      locks: new FakeLockManager(), createId: () => "id", createAbortController: () => new AbortController(),
      createChannel: () => ({ postMessage() {}, addEventListener() { throw new Error("broken"); }, removeEventListener() {}, close() { closed = true; } }),
      terminalStore: new FakeTerminalStore(),
      setTimer: setTimeout, clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
    });
    await coordinator.start();
    expect(closed).toBe(true); expect(coordinator.snapshot.status).toBe("unavailable");
  });

  it("fails closed without recursion when publishing the initial grant or an owner edit throws", async () => {
    const locks = new FakeLockManager();
    let throwPosts = true;
    const channel = { postMessage() { if (throwPosts) throw new Error("broken post"); }, addEventListener() {}, removeEventListener() {}, close() {} };
    const environment: InteractionOwnershipEnvironment = { locks, createChannel: () => channel, terminalStore: new FakeTerminalStore(), createId: (() => { let id = 0; return () => `post-${++id}`; })(),
      createAbortController: () => new AbortController(), setTimer: setTimeout, clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) };
    const initialFailure = new InteractionOwnershipCoordinator(key, { kind: "draft", initialDraft: emptyDraft, codec: questionWizardDraftCodec }, environment);
    await initialFailure.start();
    expect(initialFailure.snapshot.status).toBe("unavailable");

    throwPosts = false;
    const editFailure = new InteractionOwnershipCoordinator({ ...key, interactionId: "edit-failure" }, { kind: "draft", initialDraft: emptyDraft, codec: questionWizardDraftCodec }, environment);
    await editFailure.start();
    expect(editFailure.snapshot.status).toBe("owner");
    throwPosts = true;
    expect(writeDraft(editFailure, completedDraft)).toBe(false);
    expect(editFailure.snapshot.status).toBe("unavailable");
  });

  it("keeps the lock and settle token when a busy publication fails during an RPC", async () => {
    const fixture = new CoordinatorFixture();
    const owner = fixture.coordinator("owner", key);
    await owner.start();
    const token = beginSettle(owner)!;
    fixture.channels.failPosts();
    fixture.channels.deliver(fixture.channelName(key), { version: 1, type: "takeover_request", scope: fixture.scope(key), senderId: "peer", requestId: "request" });
    expect(owner.snapshot.status).toBe("unavailable");
    expect(fixture.locks.active(fixture.lockName(key))).toBe(true);
    expect(owner.finishSettle(token, "failed")).toBe(true);
    await fixture.flush();
    expect(fixture.locks.active(fixture.lockName(key))).toBe(false);
  });

  it("retries a successful terminal marker through a fresh channel before releasing after the live channel fails", async () => {
    const fixture = new CoordinatorFixture();
    const baseEnvironment = fixture.environment("owner");
    let firstChannel = true;
    let failedTerminal = false;
    const ownerEnvironment: InteractionOwnershipEnvironment = {
      ...baseEnvironment,
      createChannel: (name) => {
        const channel = baseEnvironment.createChannel(name);
        if (!firstChannel) return channel;
        firstChannel = false;
        return {
          postMessage(message) {
            if (!failedTerminal && isMessageType(message, "settled")) {
              failedTerminal = true;
              throw new Error("live channel failed");
            }
            channel.postMessage(message);
          },
          addEventListener: (type, listener) => channel.addEventListener(type, listener),
          removeEventListener: (type, listener) => channel.removeEventListener(type, listener),
          close: () => channel.close()
        };
      }
    };
    const owner = new InteractionOwnershipCoordinator(key, { kind: "draft", initialDraft: emptyDraft, codec: questionWizardDraftCodec }, ownerEnvironment);
    const peer = fixture.coordinator("peer", key);
    await owner.start();
    await peer.start();
    await fixture.flush();

    const token = beginSettle(owner)!;
    expect(owner.finishSettle(token, "succeeded")).toBe(true);
    await fixture.flush();

    expect(failedTerminal).toBe(true);
    expect(peer.snapshot.status).toBe("settled");
    expect(fixture.locks.active(fixture.lockName(key))).toBe(false);
    await expect(peer.takeover()).resolves.toBe(false);
    owner.dispose();
    peer.dispose();
  });

  it("keeps the Web Lock fail-closed when terminal storage fails even if BroadcastChannel succeeds", async () => {
    const fixture = new CoordinatorFixture();
    const owner = fixture.coordinator("owner", key);
    const peer = fixture.coordinator("peer", key);
    await owner.start();
    await peer.start();
    await fixture.flush();
    fixture.terminalStore.failWrites = true;

    const token = beginSettle(owner)!;
    expect(owner.finishSettle(token, "succeeded")).toBe(true);
    await fixture.flush();
    expect(fixture.channels.messages.some((message) => isMessageType(message, "settled"))).toBe(true);
    expect(peer.snapshot.status).toBe("unavailable");

    owner.pause();
    owner.dispose();
    await fixture.flush();
    expect(fixture.locks.active(fixture.lockName(key))).toBe(true);
    expect(writeDraft(owner, completedDraft)).toBe(false);
    await expect(peer.takeover()).resolves.toBe(false);
    peer.dispose();
  });

  it("uses persisted settlement when both live and fresh terminal broadcasts fail", async () => {
    const fixture = new CoordinatorFixture();
    const owner = fixture.coordinator("owner", key);
    const peer = fixture.coordinator("peer", key);
    await owner.start();
    await peer.start();
    await fixture.flush();
    fixture.channels.failPosts();

    const token = beginSettle(owner)!;
    expect(owner.finishSettle(token, "succeeded")).toBe(true);
    await fixture.flush();
    expect(fixture.channels.attemptedMessages.filter((message) => isMessageType(message, "settled"))).toHaveLength(2);
    expect(fixture.locks.active(fixture.lockName(key))).toBe(false);
    expect(peer.snapshot.status).toBe("observer");

    await expect(peer.takeover()).resolves.toBe(false);
    expect(peer.snapshot.status).toBe("settled");
    const latePeer = fixture.coordinator("late", key);
    await latePeer.start();
    expect(latePeer.snapshot.status).toBe("settled");
    expect(fixture.locks.active(fixture.lockName(key))).toBe(false);
    owner.dispose(); peer.dispose(); latePeer.dispose();
  });

  it("lets a fake AbortSignal reject only queued requests, never a granted lock", async () => {
    const locks = new FakeLockManager();
    let releaseHolder!: () => void;
    const holder = locks.request("granted", { mode: "exclusive" }, async () => new Promise<void>((resolve) => { releaseHolder = resolve; }));
    await Promise.resolve();
    const abort = new AbortController();
    let release!: () => void;
    let granted = false;
    const request = locks.request("granted", { mode: "exclusive", signal: abort.signal }, async (lock) => {
      granted = lock !== null;
      await new Promise<void>((resolve) => { release = resolve; });
      return "done";
    });
    await Promise.resolve();
    expect(granted).toBe(false);
    releaseHolder(); await holder; await Promise.resolve(); await Promise.resolve();
    expect(granted).toBe(true);
    abort.abort();
    release();
    await expect(request).resolves.toBe("done");
  });
});

class CoordinatorFixture {
  readonly locks = new FakeLockManager();
  readonly channels = new FakeChannelHub();
  readonly terminalStore = new FakeTerminalStore();
  #ids = 0;
  readonly #timerScale: number;

  constructor(timerScale = 1) { this.#timerScale = timerScale; }

  environment(prefix: string, locks: InteractionLockManager = this.locks): InteractionOwnershipEnvironment {
    return {
      locks,
      createChannel: (name) => this.channels.open(name),
      terminalStore: this.terminalStore,
      createId: () => `${prefix}-${++this.#ids}`,
      createAbortController: () => new AbortController(),
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs * this.#timerScale),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
    };
  }

  coordinator(prefix: string, ownerKey: InteractionOwnerKey): InteractionOwnershipCoordinator<QuestionWizardDraft> {
    return new InteractionOwnershipCoordinator(ownerKey, { kind: "draft", initialDraft: emptyDraft, codec: questionWizardDraftCodec }, this.environment(prefix));
  }

  ownershipCoordinator(prefix: string, ownerKey: InteractionOwnerKey): InteractionOwnershipCoordinator<never> {
    return new InteractionOwnershipCoordinator(ownerKey, { kind: "ownership-only" }, this.environment(prefix));
  }

  scope(ownerKey: InteractionOwnerKey): string {
    return JSON.stringify([ownerKey.serverId, ownerKey.profileId, ownerKey.sessionId, ownerKey.interactionId, ownerKey.interactionGeneration.toString()]);
  }

  lockName(ownerKey: InteractionOwnerKey): string { return `joko:interaction-owner:v1:lock:${this.scope(ownerKey)}`; }
  channelName(ownerKey: InteractionOwnerKey): string { return `joko:interaction-owner:v1:channel:${this.scope(ownerKey)}`; }
  terminalKey(ownerKey: InteractionOwnerKey): string { return `joko:interaction-owner:v1:terminal:${this.scope(ownerKey)}`; }

  broadcast(ownerKey: InteractionOwnerKey, message: unknown): void {
    const channel = this.channels.open(`joko:interaction-owner:v1:channel:${this.scope(ownerKey)}`);
    channel.postMessage(message);
    channel.close();
  }

  async flush(): Promise<void> {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
}

class FakeTerminalStore {
  readonly values = new Map<string, string>();
  failReads = false;
  failWrites = false;

  getItem(name: string): string | null {
    if (this.failReads) throw new DOMException("Unavailable", "SecurityError");
    return this.values.get(name) ?? null;
  }

  setItem(name: string, value: string): void {
    if (this.failWrites) throw new DOMException("Full", "QuotaExceededError");
    this.values.set(name, value);
  }
}

/** Holds the request promise after its callback exits, matching the UA boundary the coordinator must await. */
class DeferredReleaseLockManager implements InteractionLockManager {
  readonly #active = new Set<string>();
  readonly #completions = new Map<string, () => void>();

  request<T>(name: string, options: { readonly mode: "exclusive"; readonly ifAvailable?: boolean; readonly signal?: AbortSignal }, callback: (lock: InteractionLock | null) => Promise<T> | T): Promise<T> {
    if (options.signal?.aborted === true) return Promise.reject(new DOMException("Aborted", "AbortError"));
    if (this.#active.has(name)) {
      if (options.ifAvailable === true) return Promise.resolve().then(() => callback(null));
      return Promise.reject(new Error("DeferredReleaseLockManager does not support queued requests."));
    }
    this.#active.add(name);
    return new Promise<T>((resolve, reject) => {
      void Promise.resolve().then(() => callback({ name })).then(
        (value) => this.#completions.set(name, () => { this.#active.delete(name); resolve(value); }),
        (error: unknown) => this.#completions.set(name, () => { this.#active.delete(name); reject(error); })
      );
    });
  }

  active(name: string): boolean { return this.#active.has(name); }
  callbackExited(name: string): boolean { return this.#completions.has(name); }

  completeRelease(name: string): void {
    const complete = this.#completions.get(name);
    if (complete === undefined) throw new Error(`No completed lock callback for ${name}.`);
    this.#completions.delete(name);
    complete();
  }
}

class FakeLockManager implements InteractionLockManager {
  readonly #active = new Set<string>();
  readonly #queues = new Map<string, Array<{
    readonly signal?: AbortSignal;
    readonly callback: (lock: InteractionLock | null) => Promise<unknown> | unknown;
    readonly resolve: (value: unknown) => void;
    readonly reject: (reason?: unknown) => void;
  }>>();

  request<T>(name: string, options: { readonly mode: "exclusive"; readonly ifAvailable?: boolean; readonly signal?: AbortSignal }, callback: (lock: InteractionLock | null) => Promise<T> | T): Promise<T> {
    if (options.signal?.aborted === true) return Promise.reject(new DOMException("Aborted", "AbortError"));
    if (this.#active.has(name) && options.ifAvailable === true) return Promise.resolve().then(() => callback(null));
    return new Promise<T>((resolve, reject) => {
      const entry = { signal: options.signal, callback, resolve: resolve as (value: unknown) => void, reject };
      if (this.#active.has(name)) {
        const queue = this.#queues.get(name) ?? [];
        queue.push(entry);
        this.#queues.set(name, queue);
        options.signal?.addEventListener("abort", () => {
          const pending = this.#queues.get(name);
          const index = pending?.indexOf(entry) ?? -1;
          if (pending !== undefined && index >= 0) {
            pending.splice(index, 1);
            reject(new DOMException("Aborted", "AbortError"));
          }
        }, { once: true });
      } else {
        this.#acquire(name, entry);
      }
    });
  }

  queued(name: string): number { return this.#queues.get(name)?.length ?? 0; }
  active(name: string): boolean { return this.#active.has(name); }

  #acquire(name: string, entry: { readonly signal?: AbortSignal; readonly callback: (lock: InteractionLock | null) => Promise<unknown> | unknown; readonly resolve: (value: unknown) => void; readonly reject: (reason?: unknown) => void }): void {
    if (entry.signal?.aborted === true) {
      entry.reject(new DOMException("Aborted", "AbortError"));
      this.#drain(name);
      return;
    }
    this.#active.add(name);
    Promise.resolve().then(() => entry.callback({ name })).then(entry.resolve, entry.reject).finally(() => {
      this.#active.delete(name);
      this.#drain(name);
    });
  }

  #drain(name: string): void {
    const queue = this.#queues.get(name);
    const next = queue?.shift();
    if (queue?.length === 0) this.#queues.delete(name);
    if (next !== undefined) this.#acquire(name, next);
  }
}

class FakeChannelHub {
  readonly messages: unknown[] = [];
  readonly attemptedMessages: unknown[] = [];
  readonly #channels = new Map<string, Set<FakeChannel>>();
  readonly #droppedTypes = new Set<string>();
  #throwPosts = false;

  drop(type: string): void { this.#droppedTypes.add(type); }
  failPosts(): void { this.#throwPosts = true; }

  open(name: string): FakeChannel {
    const channel = new FakeChannel(name, this);
    const channels = this.#channels.get(name) ?? new Set<FakeChannel>();
    channels.add(channel);
    this.#channels.set(name, channels);
    return channel;
  }

  post(source: FakeChannel, message: unknown): void {
    this.attemptedMessages.push(message);
    if (this.#throwPosts) throw new Error("post failed");
    this.messages.push(message);
    if (typeof message === "object" && message !== null && "type" in message && this.#droppedTypes.has(String((message as { readonly type?: unknown }).type))) return;
    for (const channel of this.#channels.get(source.name) ?? []) {
      if (channel === source) continue;
      setTimeout(() => channel.deliver(message), 0);
    }
  }

  deliver(name: string, message: unknown): void {
    for (const channel of this.#channels.get(name) ?? []) channel.deliver(message);
  }

  close(channel: FakeChannel): void {
    const channels = this.#channels.get(channel.name);
    channels?.delete(channel);
    if (channels?.size === 0) this.#channels.delete(channel.name);
  }
}

function isMessageType(value: unknown, type: string): boolean {
  return typeof value === "object" && value !== null && (value as { readonly type?: unknown }).type === type;
}

class FakeChannel implements InteractionChannel {
  readonly name: string;
  readonly #hub: FakeChannelHub;
  readonly #listeners = new Set<(event: InteractionChannelMessageEvent) => void>();
  #closed = false;

  constructor(name: string, hub: FakeChannelHub) {
    this.name = name;
    this.#hub = hub;
  }

  postMessage(message: unknown): void {
    if (!this.#closed) this.#hub.post(this, message);
  }

  addEventListener(_type: "message", listener: (event: InteractionChannelMessageEvent) => void): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: InteractionChannelMessageEvent) => void): void {
    this.#listeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#hub.close(this);
    this.#listeners.clear();
  }

  deliver(message: unknown): void {
    if (this.#closed) return;
    for (const listener of this.#listeners) listener({ data: message });
  }
}
