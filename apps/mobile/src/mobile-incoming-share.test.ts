import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo", () => ({ requireOptionalNativeModule: vi.fn(() => null) }));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_algorithm: string, value: string) => createHash("sha256").update(value).digest("hex")
}));

import {
  MobileIncomingShareInbox,
  commitMobileIncomingShare,
  mobileIncomingShareProfileRetired,
  mobileIncomingSharePolicyKey,
  mobileIncomingShareTesting,
  planMobileIncomingShare,
  type MobileIncomingShareNativeDriver,
  type MobileIncomingShareReadyBatch
} from "./mobile-incoming-share";
import { MobileNewTaskDraftStore } from "./new-task-draft-store";
import { MobileComposerDraftStore } from "./composer-draft-store";
import { emptyMobileComposerDraft, mobileComposerInput, normalizeMobileComposerDraft, plainTextMobileComposerDraft } from "./mobile-composer-document";
import type {
  MobileAttachmentControls,
  MobileAttachmentPolicy,
  MobileComposerAttachment,
  MobileLocalComposerAttachment,
  MobilePickedAttachmentCandidate
} from "./mobile-attachments";

const batchOne = "10000000-0000-4000-8000-000000000001";
const batchTwo = "20000000-0000-4000-8000-000000000002";
const itemOne = "30000000-0000-4000-8000-000000000003";
const itemTwo = "40000000-0000-4000-8000-000000000004";
const itemThree = "50000000-0000-4000-8000-000000000005";
const claimOne = "60000000-0000-4000-8000-000000000006";
const profileId = "profile-one";
const controls: MobileAttachmentControls = {
  profileId,
  surfaceOwnerKey: "profile-one\u001ftarget-one\u001fattachments\u001fmodel-one",
  policy: {
    images: true,
    files: true,
    maximumItems: 20,
    maximumBytes: 1024,
    imageMediaTypes: ["image/png"],
    fileMediaTypes: ["text/plain"]
  }
};

beforeEach(() => vi.clearAllMocks());

describe("mobile incoming-share native inbox", () => {
  it("keeps consecutive batches FIFO, binds only on an explicit profile action, and acknowledges one exact batch", async () => {
    const driver = nativeDriver([rawBatch(batchOne), rawBatch(batchTwo)]);
    const inbox = new MobileIncomingShareInbox(driver);

    await inbox.refresh();
    expect(inbox.snapshot.batch).toMatchObject({ batchId: batchOne, status: "ready" });
    expect(inbox.snapshot.batch).not.toHaveProperty("boundProfileId");

    await inbox.bind(batchOne, profileId);
    expect(inbox.snapshot.batch).toMatchObject({ batchId: batchOne, boundProfileId: profileId });
    await expect(inbox.bind(batchOne, "profile-two")).rejects.toThrow(/another Joko connection/u);

    const bound = inbox.snapshot.batch;
    if (bound?.status !== "ready") throw new Error("expected ready batch");
    const claimed = await inbox.claim(
      batchOne,
      profileId,
      { kind: "new_task", targetId: "target-one" },
      controls,
      planMobileIncomingShare(bound, [], controls.policy)
    );
    await expect(inbox.claim(
      batchOne,
      profileId,
      { kind: "new_task", targetId: "target-two" },
      controls,
      planMobileIncomingShare(bound, [], controls.policy)
    )).rejects.toThrow(/another project or model/u);
    await inbox.acknowledge(batchOne, profileId, claimed.claim?.claimId ?? "missing");
    expect(driver.acknowledgeBatch).toHaveBeenCalledWith(batchOne, profileId, claimOne);
    expect(inbox.snapshot.batch).toMatchObject({ batchId: batchTwo });
  });

  it("surfaces native cleanup failure without claiming the batch disappeared", async () => {
    const driver = nativeDriver([rawBatch(batchOne)], {
      discardBatch: vi.fn(async () => { throw new Error("remove failed"); })
    });
    const inbox = new MobileIncomingShareInbox(driver);
    await inbox.refresh();

    await expect(inbox.discard(batchOne)).rejects.toThrow(/remove failed/u);
    expect(inbox.snapshot.batch).toMatchObject({ batchId: batchOne });
    expect(inbox.snapshot.error).toMatch(/remove failed/u);
  });

  it("does not resurrect an acknowledged batch when loading the following native batch fails", async () => {
    const getNextBatch = vi.fn()
      .mockResolvedValueOnce(rawBatch(batchOne))
      .mockRejectedValueOnce(new Error("next batch unreadable"));
    const driver = nativeDriver([rawBatch(batchOne)], { getNextBatch });
    const inbox = new MobileIncomingShareInbox(driver);
    await inbox.refresh();
    await inbox.bind(batchOne, profileId);
    const bound = inbox.snapshot.batch;
    if (bound?.status !== "ready") throw new Error("expected ready batch");
    const claimed = await inbox.claim(
      batchOne,
      profileId,
      { kind: "new_task", targetId: "target-one" },
      controls,
      planMobileIncomingShare(bound, [], controls.policy)
    );

    await expect(inbox.acknowledge(batchOne, profileId, claimed.claim?.claimId ?? "missing"))
      .resolves.toBeUndefined();
    expect(inbox.snapshot.batch).toBeUndefined();
    expect(inbox.snapshot.error).toMatch(/next batch unreadable/u);
  });

  it("keeps unbound shares while logged out and retires a bound share only after startup on switch or forget", () => {
    const unbound = normalizedBatch(rawBatch(batchOne));
    const bound = boundBatch(batchOne);
    expect(mobileIncomingShareProfileRetired(unbound, undefined, false, [])).toBe(false);
    expect(mobileIncomingShareProfileRetired(bound, undefined, true, [])).toBe(false);
    expect(mobileIncomingShareProfileRetired(bound, profileId, false, [profileId])).toBe(false);
    expect(mobileIncomingShareProfileRetired(bound, undefined, false, [profileId])).toBe(false);
    expect(mobileIncomingShareProfileRetired(bound, "profile-two", false, [profileId, "profile-two"])).toBe(true);
    expect(mobileIncomingShareProfileRetired(bound, undefined, false, [])).toBe(true);
  });

  it("rejects malformed bridge identities, duplicate order, remote URIs, and oversized values", () => {
    expect(() => mobileIncomingShareTesting.normalizeBatch({ ...rawBatch(batchOne), batchId: "../escape" }))
      .toThrow(/identity/u);
    expect(() => mobileIncomingShareTesting.normalizeBatch({
      ...rawBatch(batchOne),
      items: [readyItem(itemOne, 0), readyItem(itemTwo, 0)]
    })).toThrow(/duplicated/u);
    expect(() => mobileIncomingShareTesting.normalizeBatch({
      ...rawBatch(batchOne), items: [{ ...readyItem(itemOne, 0), uri: "https://example.test/file.png" }]
    })).toThrow(/URI/u);
    expect(() => mobileIncomingShareTesting.normalizeBatch({
      ...rawBatch(batchOne), items: [{ ...readyItem(itemOne, 0), byteSize: 31 * 1024 * 1024 }]
    })).toThrow(/byteSize/u);
    expect(() => mobileIncomingShareTesting.normalizeBatch(withClaim({
      ...rawBatch(batchOne),
      boundProfileId: profileId,
      items: [readyItem(itemOne, 0), readyItem(itemTwo, 1)]
    }, [itemTwo, itemOne]))).toThrow(/accepted item order/u);
    const claimed = withClaim({ ...rawBatch(batchOne), boundProfileId: profileId }, [itemOne]);
    expect(() => mobileIncomingShareTesting.normalizeBatch({
      ...claimed, items: [{ ...readyItem(itemOne, 0), sha256Hex: "b".repeat(64) }]
    })).toThrow(/content proof changed/u);
  });

  it("accepts bounded text and HTTP(S) URL content without consuming file capacity", () => {
    const batch = normalizedBatch({
      ...rawBatch(batchOne),
      items: [textItem(itemOne, 0, "One", "text"), readyItem(itemTwo, 1),
        textItem(itemThree, 2, "https://example.test/path?q=1", "url")]
    });
    const plan = planMobileIncomingShare(batch, [], {
      images: false, files: false, maximumItems: 0, maximumBytes: 0,
      imageMediaTypes: [], fileMediaTypes: []
    });
    expect(plan.accepted.map((item) => item.kind)).toEqual(["text", "url"]);
    expect(plan.rejected).toMatchObject([{ itemId: itemTwo }]);
    expect(() => mobileIncomingShareTesting.normalizeBatch({
      ...rawBatch(batchOne), items: [textItem(itemOne, 0, "file:///private", "url")]
    })).toThrow(/URL/u);
  });
});

describe("mobile incoming-share plan and durable commit", () => {
  it("keeps same-name providers distinct through unique deterministic app-owned identities", () => {
    const batch = normalizedBatch({
      ...rawBatch(batchOne),
      items: [readyItem(itemOne, 0), readyItem(itemTwo, 1)]
    });
    const plan = planMobileIncomingShare(batch, [], controls.policy);
    expect(plan.accepted.map((item) => item.kind === "file" ? item.fileName : undefined)).toEqual(["same-name.png", "same-name.png"]);
    expect(new Set(plan.accepted.map((item) => item.storageId)).size).toBe(2);
    expect(plan.accepted.map((item) => item.ordinal)).toEqual([0, 1]);
  });

  it("reconstructs the same accepted plan after its deterministic draft attachment already fills the limit", () => {
    const batch = normalizedBatch(rawBatch(batchOne));
    const storageId = mobileIncomingShareTesting.incomingShareStorageId(batchOne, itemOne, 0);
    const plan = planMobileIncomingShare(batch, [localAttachment(storageId)], {
      ...controls.policy,
      maximumItems: 1
    });
    expect(plan.accepted).toHaveLength(1);
    expect(plan.accepted[0]?.storageId).toBe(storageId);
    expect(plan.rejected).toHaveLength(0);
  });

  it("preserves share order while reporting native rejection, policy rejection, and overflow before import", () => {
    const batch = normalizedBatch({
      ...rawBatch(batchOne),
      overflowCount: 2,
      items: [
        readyItem(itemOne, 0),
        {
          state: "rejected", itemId: itemThree, ordinal: 1,
          fileName: "movie.mov", reason: "Audio and video are not supported."
        }
      ]
    });
    const imageOnly: MobileAttachmentPolicy = { ...controls.policy, files: false, fileMediaTypes: [] };
    const plan = planMobileIncomingShare(batch, [], imageOnly);

    expect(plan.accepted.map((item) => item.kind === "file" ? item.fileName : undefined)).toEqual(["same-name.png"]);
    expect(plan.rejected.map((item) => item.reason)).toEqual([
      "Audio and video are not supported.",
      "2 additional shared items were rejected because one share can contain at most 20 items."
    ]);

    const noRoom = planMobileIncomingShare(batch, [localAttachment("existing")], {
      ...imageOnly, maximumItems: 1
    });
    expect(noRoom.accepted).toHaveLength(0);
    expect(noRoom.rejected[0]?.reason).toMatch(/at most 1/u);
  });

  it("copies in order, compares the native SHA, commits one draft CAS, flushes, then acknowledges", async () => {
    const store = await draftStore();
    const batch = claimedBatch(batchOne);
    const files = attachmentFiles();
    const acknowledge = vi.fn(async () => undefined);

    const result = await commitMobileIncomingShare({
      batch,
      profileId,
      destination: { kind: "new_task", targetId: "target-one" },
      controls,
      newTaskDraftStore: storeBoundary(store),
      composerDraftStore: composerStoreBoundary(),
      attachmentFiles: files,
      validateAuthority: vi.fn(async () => controls),
      acknowledge,
      allowFreshClaim: true
    });

    expect(result.replayed).toBe(false);
    if (result.destinationKind !== "new_task") throw new Error("expected new task result");
    expect(result.draft.input.attachments).toHaveLength(1);
    expect(files.stageCandidates).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse([...store.memory.values()][0] ?? "null") as { draft?: { input?: { attachments?: unknown[] } } };
    expect(persisted.draft?.input?.attachments).toHaveLength(1);
  });

  it("treats a durable deterministic attachment as an idempotent reentry and only retries native acknowledgement", async () => {
    const batch = claimedBatch(batchOne);
    const storageId = mobileIncomingShareTesting.incomingShareStorageId(batchOne, itemOne, 0);
    const store = await draftStore([localAttachment(storageId)]);
    const files = attachmentFiles();
    const acknowledge = vi.fn(async () => undefined);

    const result = await commitMobileIncomingShare({
      batch,
      profileId,
      destination: { kind: "new_task", targetId: "target-one" },
      controls,
      newTaskDraftStore: storeBoundary(store),
      composerDraftStore: composerStoreBoundary(),
      attachmentFiles: files,
      validateAuthority: vi.fn(async () => controls),
      acknowledge,
      allowFreshClaim: false
    });

    expect(result.replayed).toBe(true);
    expect(files.stageCandidates).not.toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it("retains the native batch and removes app-owned copies when draft CAS or authority changes", async () => {
    const batch = claimedBatch(batchOne);
    const store = await draftStore();
    const files = attachmentFiles({
      afterStage: () => store.store.save({ profileId }, {
        targetId: "target-one", name: "Concurrent", input: emptyMobileComposerDraft()
      })
    });
    const acknowledge = vi.fn(async () => undefined);
    await expect(commitMobileIncomingShare({
      batch, profileId, destination: { kind: "new_task", targetId: "target-one" }, controls,
      newTaskDraftStore: storeBoundary(store), composerDraftStore: composerStoreBoundary(), attachmentFiles: files,
      validateAuthority: vi.fn(async () => controls), acknowledge, allowFreshClaim: true
    })).rejects.toThrow(/draft changed/u);
    expect(files.removeOwnedBytes).toHaveBeenCalledWith(
      profileId,
      mobileIncomingShareTesting.incomingShareStorageId(batchOne, itemOne, 0)
    );
    expect(acknowledge).not.toHaveBeenCalled();

    const authorityStore = await draftStore();
    const authorityFiles = attachmentFiles();
    await expect(commitMobileIncomingShare({
      batch, profileId, destination: { kind: "new_task", targetId: "target-one" }, controls,
      newTaskDraftStore: storeBoundary(authorityStore), composerDraftStore: composerStoreBoundary(), attachmentFiles: authorityFiles,
      validateAuthority: vi.fn(async () => ({ ...controls, surfaceOwnerKey: "retired" })), acknowledge, allowFreshClaim: true
    })).rejects.toThrow(/authority changed/u);
    expect(authorityFiles.removeOwnedBytes).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("fails closed on staged SHA drift and reports app-owned cleanup failure without acknowledging", async () => {
    const batch = claimedBatch(batchOne);
    const hashStore = await draftStore();
    const hashFiles = attachmentFiles({ shaOverride: "b".repeat(64) });
    const acknowledge = vi.fn(async () => undefined);
    await expect(commitMobileIncomingShare({
      batch, profileId, destination: { kind: "new_task", targetId: "target-one" }, controls,
      newTaskDraftStore: storeBoundary(hashStore), composerDraftStore: composerStoreBoundary(), attachmentFiles: hashFiles,
      validateAuthority: vi.fn(async () => controls), acknowledge, allowFreshClaim: true
    })).rejects.toThrow(/changed while it was copied/u);
    expect(acknowledge).not.toHaveBeenCalled();

    const cleanupStore = await draftStore();
    const cleanupFiles = attachmentFiles({
      afterStage: () => cleanupStore.store.save({ profileId }, {
        targetId: "target-one", name: "Concurrent", input: emptyMobileComposerDraft()
      }),
      removeFailureAt: 2
    });
    await expect(commitMobileIncomingShare({
      batch, profileId, destination: { kind: "new_task", targetId: "target-one" }, controls,
      newTaskDraftStore: storeBoundary(cleanupStore), composerDraftStore: composerStoreBoundary(), attachmentFiles: cleanupFiles,
      validateAuthority: vi.fn(async () => controls), acknowledge, allowFreshClaim: true
    })).rejects.toThrow(/copy could not be removed/u);
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("acknowledges an explicitly reviewed all-rejected batch without mutating the draft", async () => {
    const batch = normalizedBatch(withClaim({
      ...rawBatch(batchOne),
      boundProfileId: profileId,
      items: [{
        state: "rejected", itemId: itemOne, ordinal: 0,
        fileName: "movie.mov", reason: "Audio and video are not supported."
      }]
    }, []));
    const store = await draftStore();
    const before = await store.store.readSnapshot({ profileId });
    const files = attachmentFiles();
    const acknowledge = vi.fn(async () => undefined);
    const result = await commitMobileIncomingShare({
      batch, profileId, destination: { kind: "new_task", targetId: "target-one" }, controls,
      newTaskDraftStore: storeBoundary(store), composerDraftStore: composerStoreBoundary(), attachmentFiles: files,
      validateAuthority: vi.fn(async () => controls), acknowledge, allowFreshClaim: true
    });
    const after = await store.store.readSnapshot({ profileId });
    expect(result.plan).toMatchObject({ accepted: [], rejected: [{ fileName: "movie.mov" }] });
    expect(after.revision).toBe(before.revision);
    expect(files.stageCandidates).not.toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it("does not delete files after a successful CAS when durable flush or native acknowledgement fails", async () => {
    const batch = claimedBatch(batchOne);
    const store = await draftStore();
    const files = attachmentFiles();
    const boundary = storeBoundary(store);
    const flush = vi.fn(async () => { throw new Error("disk unavailable"); });
    await expect(commitMobileIncomingShare({
      batch, profileId, destination: { kind: "new_task", targetId: "target-one" }, controls,
      newTaskDraftStore: { ...boundary, flush }, composerDraftStore: composerStoreBoundary(), attachmentFiles: files,
      validateAuthority: vi.fn(async () => controls), acknowledge: vi.fn(), allowFreshClaim: true
    })).rejects.toThrow(/disk unavailable/u);
    expect(files.removeOwnedBytes).toHaveBeenCalledTimes(1);
    expect(store.store.readSync({ profileId })?.input.attachments).toHaveLength(1);

    const secondStore = await draftStore();
    const secondFiles = attachmentFiles();
    await expect(commitMobileIncomingShare({
      batch, profileId, destination: { kind: "new_task", targetId: "target-one" }, controls,
      newTaskDraftStore: storeBoundary(secondStore), composerDraftStore: composerStoreBoundary(), attachmentFiles: secondFiles,
      validateAuthority: vi.fn(async () => controls),
      acknowledge: vi.fn(async () => { throw new Error("native cleanup failed"); }), allowFreshClaim: true
    })).rejects.toThrow(/native cleanup failed/u);
    expect(secondFiles.removeOwnedBytes).toHaveBeenCalledTimes(1);
    expect(secondStore.store.readSync({ profileId })?.input.attachments).toHaveLength(1);
  });

  it("fails closed for a different profile without staging, draft mutation, or acknowledgement", async () => {
    const store = await draftStore();
    const files = attachmentFiles();
    const acknowledge = vi.fn();
    await expect(commitMobileIncomingShare({
      batch: claimedBatch(batchOne), profileId: "profile-two",
      destination: { kind: "new_task", targetId: "target-one" },
      controls, newTaskDraftStore: storeBoundary(store), composerDraftStore: composerStoreBoundary(), attachmentFiles: files,
      validateAuthority: vi.fn(async () => controls), acknowledge, allowFreshClaim: true
    })).rejects.toThrow(/not bound/u);
    expect(files.stageCandidates).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("fails before staging when the durable target/model/policy claim no longer matches", async () => {
    const store = await draftStore();
    const files = attachmentFiles();
    await expect(commitMobileIncomingShare({
      batch: claimedBatch(batchOne), profileId, destination: { kind: "new_task", targetId: "target-one" },
      controls: { ...controls, surfaceOwnerKey: "different-model" },
      newTaskDraftStore: storeBoundary(store), composerDraftStore: composerStoreBoundary(), attachmentFiles: files,
      validateAuthority: vi.fn(async () => controls), acknowledge: vi.fn(), allowFreshClaim: true
    })).rejects.toThrow(/authority changed/u);
    expect(files.stageCandidates).not.toHaveBeenCalled();
  });

  it("imports mixed text, URL, and file into an existing task in order, then replays an uncertain acknowledgement", async () => {
    const items = [textItem(itemOne, 0, "Please inspect this", "text"), readyItem(itemTwo, 1),
      textItem(itemThree, 2, "https://example.test/report", "url")];
    const batch = normalizedBatch(withClaim({ ...rawBatch(batchOne), boundProfileId: profileId, items },
      [itemOne, itemTwo, itemThree], { kind: "existing_task", targetId: "target-one", sessionId: "session-one" }));
    const composerDraftStore = composerStoreBoundary();
    const identity = { profileId, sessionId: "session-one" };
    composerDraftStore.save(identity, plainTextMobileComposerDraft("Existing message"));
    await composerDraftStore.flush(identity);
    const store = await draftStore();
    const files = attachmentFiles();
    const request = {
      batch, profileId, destination: { kind: "existing_task" as const, targetId: "target-one", sessionId: "session-one" },
      controls, newTaskDraftStore: storeBoundary(store), composerDraftStore, attachmentFiles: files,
      validateAuthority: vi.fn(async () => controls), allowFreshClaim: true,
      acknowledge: vi.fn(async () => { throw new Error("native acknowledgement uncertain"); })
    };
    await expect(commitMobileIncomingShare(request)).rejects.toThrow(/acknowledgement uncertain/u);
    const durable = await composerDraftStore.readDurable(identity);
    expect(durable?.atoms.map((atom) => atom.kind === "pasted-text" ? atom.text : "")).toEqual([
      "Please inspect this", "https://example.test/report"
    ]);
    expect(durable?.attachments).toHaveLength(1);
    expect(durable?.text.startsWith("Existing message\n\n")).toBe(true);
    if (!durable) throw new Error("expected durable mixed share");
    const sendable = normalizeMobileComposerDraft({
      ...durable,
      attachments: durable.attachments.map((attachment) => ({
        ...attachment,
        state: "uploaded" as const,
        blobId: `blob-${attachment.attachmentId}`
      }))
    });
    const wire = mobileComposerInput(sendable);
    expect(wire.parts.map((part) => part.content.case)).toEqual(["text", "image", "text"]);
    expect(wire.parts[0]?.content).toEqual({
      case: "text",
      value: "Existing message\n\nPlease inspect this\n\n"
    });
    expect(wire.parts[2]?.content).toEqual({ case: "text", value: "https://example.test/report" });
    expect(files.stageCandidates).toHaveBeenCalledTimes(1);
    const replay = await commitMobileIncomingShare({ ...request, allowFreshClaim: false,
      acknowledge: vi.fn(async () => undefined) });
    expect(replay.destinationKind).toBe("existing_task");
    expect(replay.replayed).toBe(true);
    expect(files.stageCandidates).toHaveBeenCalledTimes(1);
    expect((await composerDraftStore.readDurable(identity))?.atoms).toHaveLength(2);
    if (replay.destinationKind !== "existing_task") throw new Error("expected existing task replay");
    expect(mobileComposerInput(normalizeMobileComposerDraft({
      ...replay.draft,
      attachments: replay.draft.attachments.map((attachment) => ({
        ...attachment,
        state: "uploaded" as const,
        blobId: `blob-${attachment.attachmentId}`
      }))
    })).parts.map((part) => part.content.case)).toEqual(["text", "image", "text"]);
  });

  it("retains a file-text-file native order in a new-task draft and its v9 durable record", async () => {
    const items = [readyItem(itemOne, 0), textItem(itemTwo, 1, "Between the files", "text"), readyItem(itemThree, 2)];
    const batch = normalizedBatch(withClaim({ ...rawBatch(batchOne), boundProfileId: profileId, items },
      [itemOne, itemTwo, itemThree]));
    const store = await draftStore();
    const result = await commitMobileIncomingShare({
      batch, profileId, destination: { kind: "new_task", targetId: "target-one" }, controls,
      newTaskDraftStore: storeBoundary(store), composerDraftStore: composerStoreBoundary(), attachmentFiles: attachmentFiles(),
      validateAuthority: vi.fn(async () => controls), acknowledge: vi.fn(async () => undefined), allowFreshClaim: true
    });
    if (result.destinationKind !== "new_task") throw new Error("expected new task result");
    const sendable = normalizeMobileComposerDraft({
      ...result.draft.input,
      attachments: result.draft.input.attachments.map((attachment) => ({
        ...attachment,
        state: "uploaded" as const,
        blobId: `blob-${attachment.attachmentId}`
      }))
    });
    expect(mobileComposerInput(sendable).parts.map((part) => part.content.case)).toEqual(["image", "text", "image"]);
    expect([...store.memory.values()][0]).toContain('"version":9');
  });

  it("fails closed after a claimed text import was removed during an uncertain acknowledgement", async () => {
    const items = [textItem(itemOne, 0, "Do not duplicate", "text")];
    const batch = normalizedBatch(withClaim({ ...rawBatch(batchOne), boundProfileId: profileId, items }, [itemOne]));
    const store = await draftStore();
    const files = attachmentFiles();
    const request = {
      batch, profileId, destination: { kind: "new_task" as const, targetId: "target-one" }, controls,
      newTaskDraftStore: storeBoundary(store), composerDraftStore: composerStoreBoundary(), attachmentFiles: files,
      validateAuthority: vi.fn(async () => controls), allowFreshClaim: true,
      acknowledge: vi.fn(async () => { throw new Error("native acknowledgement uncertain"); })
    };
    await expect(commitMobileIncomingShare(request)).rejects.toThrow(/acknowledgement uncertain/u);
    const imported = store.store.readSync({ profileId });
    if (!imported) throw new Error("expected imported text");
    expect(mobileComposerInput(imported.input).parts[0]?.content).toMatchObject({
      case: "text", value: "Do not duplicate"
    });
    store.store.save({ profileId }, { targetId: "target-one", name: "New task", input: emptyMobileComposerDraft() });
    await store.store.flush({ profileId });
    await expect(commitMobileIncomingShare({ ...request, allowFreshClaim: false,
      acknowledge: vi.fn(async () => undefined) })).rejects.toThrow(/prior shared-content write is uncertain/u);
    expect((await store.store.readDurable({ profileId }))?.input.text).toBe("");
  });

  it("requires the native text digest and a durable draft readback before acknowledgement", async () => {
    const corruptedText = normalizedBatch(withClaim({
      ...rawBatch(batchOne), boundProfileId: profileId,
      items: [textItem(itemOne, 0, "Unverified", "text", "b".repeat(64))]
    }, [itemOne]));
    const store = await draftStore();
    const files = attachmentFiles();
    const acknowledge = vi.fn(async () => undefined);
    const base = {
      profileId, destination: { kind: "new_task" as const, targetId: "target-one" }, controls,
      newTaskDraftStore: storeBoundary(store), composerDraftStore: composerStoreBoundary(), attachmentFiles: files,
      validateAuthority: vi.fn(async () => controls), acknowledge, allowFreshClaim: true
    };
    await expect(commitMobileIncomingShare({ ...base, batch: corruptedText })).rejects.toThrow(/text changed/u);
    expect(files.stageCandidates).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();

    const fileBatch = claimedBatch(batchOne);
    await expect(commitMobileIncomingShare({
      ...base, batch: fileBatch,
      newTaskDraftStore: { ...storeBoundary(store), readDurable: async () => null }
    })).rejects.toThrow(/could not be confirmed/u);
    expect(store.store.readSync({ profileId })?.input.attachments).toHaveLength(1);
    expect(acknowledge).not.toHaveBeenCalled();
  });
});

function rawBatch(batchId: string): Record<string, unknown> {
  return {
    status: "ready",
    batchId,
    orderKey: `batch-${"0".repeat(20)}-${batchId}`,
    createdAtUnixMs: 1,
    overflowCount: 0,
    items: [readyItem(itemOne, 0)]
  };
}

function readyItem(itemId: string, ordinal: number): Record<string, unknown> {
  return {
    state: "ready",
    kind: "file",
    itemId,
    ordinal,
    uri: `file:///app-group/items/${itemId}/same-name.png`,
    fileName: "same-name.png",
    mediaType: "image/png",
    byteSize: 4,
    sha256Hex: "a".repeat(64)
  };
}

function textItem(itemId: string, ordinal: number, text: string, kind: "text" | "url", sha256Hex?: string): Record<string, unknown> {
  return { state: "ready", kind, itemId, ordinal, text, byteSize: new TextEncoder().encode(text).byteLength,
    sha256Hex: sha256Hex ?? createHash("sha256").update(text).digest("hex") };
}

function normalizedBatch(raw: Record<string, unknown>): MobileIncomingShareReadyBatch {
  const batch = mobileIncomingShareTesting.normalizeBatch(raw);
  if (batch.status !== "ready") throw new Error("test expected ready batch");
  return batch;
}

function boundBatch(batchId: string): MobileIncomingShareReadyBatch {
  return normalizedBatch({ ...rawBatch(batchId), boundProfileId: profileId });
}

function claimedBatch(batchId: string): MobileIncomingShareReadyBatch {
  return normalizedBatch(withClaim({ ...rawBatch(batchId), boundProfileId: profileId }, [itemOne]));
}

function withClaim(
  raw: Record<string, unknown>, acceptedItemIds: readonly string[],
  destination: { readonly kind: "new_task"; readonly targetId: string } |
    { readonly kind: "existing_task"; readonly targetId: string; readonly sessionId: string } =
    { kind: "new_task", targetId: "target-one" }
): Record<string, unknown> {
  const items = raw.items as Record<string, unknown>[];
  return {
    ...raw,
    claim: {
      claimId: claimOne,
      destinationKind: destination.kind,
      ...(destination.kind === "existing_task" ? { sessionId: destination.sessionId } : {}),
      targetId: destination.targetId,
      surfaceOwnerKey: controls.surfaceOwnerKey,
      policyKey: mobileIncomingSharePolicyKey(controls.policy),
      acceptedItemIds: [...acceptedItemIds],
      acceptedItemProofs: acceptedItemIds.map((itemId) => {
        const item = items.find((candidate) => candidate.itemId === itemId);
        if (!item) throw new Error("missing test item");
        return { itemId, kind: item.kind, byteSize: item.byteSize, sha256Hex: item.sha256Hex,
          ...(item.kind === "file" ? { fileName: item.fileName, mediaType: item.mediaType } : {}) };
      })
    }
  };
}

function nativeDriver(
  initial: Record<string, unknown>[],
  overrides: Partial<MobileIncomingShareNativeDriver> = {}
): MobileIncomingShareNativeDriver & Record<string, ReturnType<typeof vi.fn>> {
  const queue = [...initial];
  const driver = {
    supported: true,
    getNextBatch: vi.fn(async () => queue[0] ?? null),
    bindBatch: vi.fn(async (batchId: string, boundProfileId: string) => {
      if ((queue[0]?.batchId as string | undefined) !== batchId) throw new Error("changed");
      queue[0] = { ...queue[0], boundProfileId };
      return queue[0];
    }),
    claimBatch: vi.fn(async (
      batchId: string,
      boundProfileId: string,
      destinationKind: "new_task" | "existing_task",
      sessionId: string | null,
      targetId: string,
      surfaceOwnerKey: string,
      policyKey: string,
      acceptedItemIds: readonly string[]
    ) => {
      if ((queue[0]?.batchId as string | undefined) !== batchId
        || (queue[0]?.boundProfileId as string | undefined) !== boundProfileId) throw new Error("changed");
      const items = queue[0]?.items as Record<string, unknown>[];
      const nextClaim = { claimId: claimOne, destinationKind,
        ...(sessionId === null ? {} : { sessionId }), targetId, surfaceOwnerKey, policyKey,
        acceptedItemIds: [...acceptedItemIds],
        acceptedItemProofs: acceptedItemIds.map((itemId) => {
          const item = items.find((candidate) => candidate.itemId === itemId);
          if (!item) throw new Error("missing test item");
          return { itemId, kind: item.kind, byteSize: item.byteSize, sha256Hex: item.sha256Hex,
            ...(item.kind === "file" ? { fileName: item.fileName, mediaType: item.mediaType } : {}) };
        }) };
      const existing = queue[0]?.claim;
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(nextClaim)) {
        throw new Error("This incoming share is already claimed by another project or model authority.");
      }
      queue[0] = { ...queue[0], claim: nextClaim };
      return queue[0];
    }),
    acknowledgeBatch: vi.fn(async (batchId: string, _profile: string, claimId: string) => {
      if ((queue[0]?.batchId as string | undefined) !== batchId) throw new Error("changed");
      if ((queue[0]?.claim as { claimId?: string } | undefined)?.claimId !== claimId) throw new Error("claim changed");
      queue.shift();
    }),
    discardBatch: vi.fn(async (batchId: string) => {
      if ((queue[0]?.batchId as string | undefined) !== batchId) throw new Error("changed");
      queue.shift();
    }),
    ...overrides
  };
  return driver as MobileIncomingShareNativeDriver & Record<string, ReturnType<typeof vi.fn>>;
}

function localAttachment(attachmentId: string): MobileLocalComposerAttachment {
  return {
    state: "local",
    attachmentId,
    kind: "image",
    fileName: "same-name.png",
    mediaType: "image/png",
    byteSize: 4,
    sha256Hex: "a".repeat(64),
    capturedAtUnixMs: 1
  };
}

async function draftStore(attachments: readonly MobileLocalComposerAttachment[] = []) {
  const memory = new Map<string, string>();
  const store = new MobileNewTaskDraftStore({
    getItem: async (key) => memory.get(key) ?? null,
    setItem: async (key, value) => { memory.set(key, value); },
    removeItem: async (key) => { memory.delete(key); }
  });
  store.save({ profileId }, {
    targetId: "target-one",
    name: "New task",
    input: { ...emptyMobileComposerDraft(), attachments: [...attachments] }
  });
  await store.flush({ profileId });
  return { store, memory };
}

function storeBoundary(value: Awaited<ReturnType<typeof draftStore>>) {
  return {
    readSnapshot: (identity: { readonly profileId: string }) => value.store.readSnapshot(identity),
    saveIfRevision: (identity: { readonly profileId: string }, draft: Parameters<MobileNewTaskDraftStore["saveIfRevision"]>[1], revision: number) =>
      value.store.saveIfRevision(identity, draft, revision),
    flush: (identity: { readonly profileId: string }) => value.store.flush(identity),
    readDurable: (identity: { readonly profileId: string }) => value.store.readDurable(identity)
  };
}

function composerStoreBoundary(): MobileComposerDraftStore {
  const memory = new Map<string, string>();
  return new MobileComposerDraftStore({
    getItem: async (key) => memory.get(key) ?? null,
    setItem: async (key, value) => { memory.set(key, value); },
    removeItem: async (key) => { memory.delete(key); }
  });
}

function attachmentFiles(options: {
  readonly afterStage?: () => void;
  readonly shaOverride?: string;
  readonly removeFailureAt?: number;
} = {}) {
  let removeCall = 0;
  const removeOwnedBytes = vi.fn(async () => {
    removeCall += 1;
    if (removeCall === options.removeFailureAt) throw new Error("remove failed");
  });
  const stageCandidates = vi.fn(async (
    _profile: string,
    _current: readonly MobileComposerAttachment[],
    _policy: MobileAttachmentPolicy,
    candidates: readonly MobilePickedAttachmentCandidate[],
    newId: () => string,
    _signal?: AbortSignal
  ) => {
    const attachments = candidates.map((candidate) => {
      const verified = candidate as MobilePickedAttachmentCandidate & { readonly sha256Hex: string };
      return {
      state: "local" as const,
      attachmentId: newId(),
      kind: candidate.mediaType.startsWith("image/") ? "image" as const : "file" as const,
      fileName: candidate.fileName,
      mediaType: candidate.mediaType,
      byteSize: candidate.byteSize,
      sha256Hex: options.shaOverride ?? verified.sha256Hex,
      capturedAtUnixMs: 1
      };
    });
    options.afterStage?.();
    return attachments;
  });
  return { stageCandidates, removeOwnedBytes };
}
