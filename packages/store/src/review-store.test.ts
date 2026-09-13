import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OperationalStore, RevisionConflictError, StoreError } from "./index.js";
import type { CreateReviewRunInput } from "./types.js";

const cleanups: Array<() => void> = [];
const sha = (character: string): string => character.repeat(64);

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("durable review store", () => {
  it("atomically creates a running run, exclusive fenced lease, seal, and ordered public BlobRefs", () => {
    const { store } = fixture();
    const input = reviewInput();
    const first = store.createReviewRun(input);
    const replay = store.createReviewRun(input);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      run: {
        id: "review-1",
        sourceSessionId: "source",
        state: "running",
        freshness: "current",
        freshnessCheckedAt: 10
      },
      sourceLease: { state: "active", fencingToken: 1n },
      evidenceSeal: { version: 1, sealSha256: reviewInput().evidenceSeal.sealSha256 }
    });
    expect(first.attachments.map((attachment) => [attachment.ordinal, attachment.blob.id])).toEqual([[1, "blob-1"], [2, "blob-2"]]);
    expect(() => store.createReviewRun({ ...reviewInput(), id: "review-2" })).toThrow(/active review/u);
    expect(store.listReviewRunsBySource("source").map((run) => run.id)).toEqual(["review-1"]);
  });

  it("fails closed on conflicting replay, duplicate BlobRef, path-shaped names, malformed seals, and attachment overflow", () => {
    const { store } = fixture();
    store.createReviewRun(reviewInput());
    expect(() => store.createReviewRun({ ...reviewInput(), targetKind: "task" })).toThrow(/different durable inputs/u);

    const fresh = fixture();
    const duplicate = reviewInput().attachments[0]!;
    expect(() => fresh.store.createReviewRun({ ...reviewInput(), attachments: [duplicate, duplicate] })).toThrow(/Duplicate/u);
    expect(() => fresh.store.createReviewRun({ ...reviewInput(), attachments: [{ ...duplicate, displayName: "D:\\secret\\a.txt" }] })).toThrow(/basename/u);
    expect(() => fresh.store.createReviewRun({ ...reviewInput(), evidenceSeal: { ...reviewInput().evidenceSeal, filesSha256: "bad" } })).toThrow(/SHA-256/u);
    expect(() => fresh.store.createReviewRun({ ...reviewInput(), attachments: Array.from({ length: 21 }, (_, index) => ({
      ...duplicate,
      displayName: `${index}.txt`,
      blob: { ...duplicate.blob, id: `blob-${index}` }
    })) })).toThrow(/at most 20/u);
  });

  it("attaches a fresh Reviewer Session with revision and lease fences and persists an immutable read-only policy", () => {
    const { store } = fixture();
    const created = store.createReviewRun(reviewInput());
    expect(() => store.attachReviewSession({
      reviewRunId: "review-1",
      reviewerSessionId: "reviewer",
      sourceLeaseFencingToken: 2n,
      expectedRunRevision: created.run.revision
    })).toThrow(/stale/u);
    expect(() => store.attachReviewSession({
      reviewRunId: "review-1",
      reviewerSessionId: "reviewer",
      sourceLeaseFencingToken: 1n,
      expectedRunRevision: created.run.revision - 1n
    })).toThrow(RevisionConflictError);

    const attached = store.attachReviewSession({
      reviewRunId: "review-1",
      reviewerSessionId: "reviewer",
      sourceLeaseFencingToken: 1n,
      expectedRunRevision: created.run.revision
    });
    expect(attached.reviewerSessionId).toBe("reviewer");
    expect(store.getSessionRuntimePolicy("reviewer")).toMatchObject({
      reviewRunId: "review-1",
      policy: "review_read_only",
      sourceLeaseFencingToken: 1n
    });
    expect(store.listReviewRunsByReviewer("reviewer").map((run) => run.id)).toEqual(["review-1"]);
    expect(store.attachReviewSession({
      reviewRunId: "review-1",
      reviewerSessionId: "reviewer",
      sourceLeaseFencingToken: 1n,
      expectedRunRevision: created.run.revision
    })).toEqual(attached);
  });

  it("atomically completes with CAS, bounds and sanitizes the result, releases the lease, and permits the next fenced run", () => {
    const { store } = fixture();
    const created = store.createReviewRun(reviewInput());
    const attached = store.attachReviewSession({
      reviewRunId: "review-1",
      reviewerSessionId: "reviewer",
      sourceLeaseFencingToken: 1n,
      expectedRunRevision: created.run.revision
    });
    expect(() => store.finishReviewRun({
      reviewRunId: "review-1",
      state: "completed",
      result: "ok",
      freshness: "current",
      sourceLeaseFencingToken: 1n,
      expectedRunRevision: created.run.revision
    })).toThrow(RevisionConflictError);
    expect(store.getReviewRun("review-1").state).toBe("running");
    expect(store.getReviewRunBundle("review-1").sourceLease.state).toBe("active");
    expect(() => store.finishReviewRun({
      reviewRunId: "review-1",
      state: "completed",
      result: "   ",
      freshness: "current",
      sourceLeaseFencingToken: 1n,
      expectedRunRevision: attached.revision
    })).toThrow(/between 1 and 100000/u);
    expect(() => store.finishReviewRun({
      reviewRunId: "review-1",
      state: "completed",
      result: "x".repeat(100_001),
      freshness: "current",
      sourceLeaseFencingToken: 1n,
      expectedRunRevision: attached.revision
    })).toThrow(/between 1 and 100000/u);

    const completed = store.finishReviewRun({
      reviewRunId: "review-1",
      state: "completed",
      result: "Finding at D:\\service-secret\\a.ts\napi_key=super-secret",
      freshness: "current",
      sourceLeaseFencingToken: 1n,
      expectedRunRevision: attached.revision
    });
    expect(completed.state).toBe("completed");
    expect(completed.result).not.toMatch(/service-secret|super-secret/u);
    expect(store.getReviewRunBundle("review-1").sourceLease.state).toBe("released");
    expect(store.finishReviewRun({
      reviewRunId: "review-1",
      state: "completed",
      result: "Finding at D:\\service-secret\\a.ts\napi_key=super-secret",
      freshness: "current",
      sourceLeaseFencingToken: 1n,
      expectedRunRevision: attached.revision
    })).toEqual(completed);
    expect(() => store.finishReviewRun({
      reviewRunId: "review-1",
      state: "failed",
      failureCode: "provider-failed",
      freshness: "current",
      sourceLeaseFencingToken: 1n,
      expectedRunRevision: completed.revision
    })).toThrow(/transition/u);

    const next = store.createReviewRun({ ...reviewInput(), id: "review-2" });
    expect(next.sourceLease.fencingToken).toBe(2n);
  });

  it("requires stable failure codes and releases the lease atomically on failure", () => {
    const { store } = fixture();
    const created = store.createReviewRun(reviewInput());
    expect(() => store.finishReviewRun({
      reviewRunId: "review-1",
      state: "failed",
      failureCode: "credential=secret" as "provider-failed",
      freshness: "current",
      sourceLeaseFencingToken: 1n,
      expectedRunRevision: created.run.revision
    })).toThrow(/failure code/u);
    const failed = store.finishReviewRun({
      reviewRunId: "review-1",
      state: "failed",
      failureCode: "cancelled-before-start",
      freshness: "current",
      sourceLeaseFencingToken: 1n,
      expectedRunRevision: created.run.revision
    });
    expect(failed).toMatchObject({ state: "failed", failureCode: "cancelled-before-start" });
    expect(store.getReviewRunBundle("review-1").sourceLease.state).toBe("released");
  });

  it("reobserves terminal evidence with CAS, recoverable availability, and monotonic staleness", () => {
    const { store } = fixture();
    const created = store.createReviewRun(reviewInput());
    const attached = store.attachReviewSession({
      reviewRunId: "review-1",
      reviewerSessionId: "reviewer",
      sourceLeaseFencingToken: 1n,
      expectedRunRevision: created.run.revision
    });
    const completed = store.finishReviewRun({
      reviewRunId: "review-1",
      state: "completed",
      result: "Durable conclusion",
      freshness: "current",
      sourceLeaseFencingToken: 1n,
      expectedRunRevision: attached.revision
    });
    const originalEvidence = store.getReviewRunBundle("review-1").evidenceSeal;
    expect(() => store.reobserveReview({
      reviewRunId: "review-1",
      expectedRunRevision: completed.revision - 1n,
      freshness: "unavailable",
      checkedAt: 30
    })).toThrow(RevisionConflictError);

    const eventCount = store.listEvents({ sessionId: "source" }).length;
    const unavailable = store.reobserveReview({
      reviewRunId: "review-1",
      expectedRunRevision: completed.revision,
      freshness: "unavailable",
      checkedAt: 30
    });
    expect(unavailable).toMatchObject({
      state: "completed",
      freshness: "unavailable",
      freshnessCheckedAt: 30,
      result: completed.result,
      endedAt: completed.endedAt
    });
    expect(store.listEvents({ sessionId: "source" }).at(-1)?.payload).toMatchObject({
      type: "review_run_changed",
      reviewRun: {
        state: "completed",
        freshness: "unavailable",
        freshnessCheckedAt: 30,
        result: completed.result
      }
    });
    const recovered = store.reobserveReview({
      reviewRunId: "review-1",
      expectedRunRevision: unavailable.revision,
      freshness: "current",
      checkedAt: 31
    });
    expect(recovered).toMatchObject({
      state: "completed",
      freshness: "current",
      freshnessCheckedAt: 31,
      result: completed.result,
      endedAt: completed.endedAt
    });
    const refreshedCurrent = store.reobserveReview({
      reviewRunId: "review-1",
      expectedRunRevision: recovered.revision,
      freshness: "current",
      checkedAt: 32
    });
    expect(refreshedCurrent).toMatchObject({ freshness: "current", freshnessCheckedAt: 32 });
    const stale = store.reobserveReview({
      reviewRunId: "review-1",
      expectedRunRevision: refreshedCurrent.revision,
      freshness: "stale",
      checkedAt: 33
    });
    expect(stale.freshness).toBe("stale");
    const stillStale = store.reobserveReview({
      reviewRunId: "review-1",
      expectedRunRevision: stale.revision,
      freshness: "current",
      checkedAt: 34
    });
    expect(stillStale).toMatchObject({
      state: "completed",
      freshness: "stale",
      freshnessCheckedAt: 34,
      result: completed.result,
      endedAt: completed.endedAt
    });
    expect(store.getReviewRunBundle("review-1").evidenceSeal).toEqual(originalEvidence);
    expect(store.listEvents({ sessionId: "source" })).toHaveLength(eventCount + 5);

    const next = store.createReviewRun({ ...reviewInput(), id: "review-2" });
    expect(() => store.reobserveReview({
      reviewRunId: "review-2",
      expectedRunRevision: next.run.revision,
      freshness: "stale",
      checkedAt: 40
    })).toThrow(/transition/u);
    const failed = store.finishReviewRun({
      reviewRunId: "review-2",
      state: "failed",
      failureCode: "provider-failed",
      freshness: "stale",
      freshnessCheckedAt: 41,
      sourceLeaseFencingToken: next.sourceLease.fencingToken,
      expectedRunRevision: next.run.revision
    });
    expect(failed).toMatchObject({
      state: "failed",
      freshness: "stale",
      freshnessCheckedAt: 41,
      failureCode: "provider-failed",
      endedAt: failed.endedAt
    });
  });

  it("recovers running reviews as interrupted exactly once after restart and releases source leases", () => {
    const { store, filePath, replaceStore } = fixture();
    const created = store.createReviewRun(reviewInput());
    store.attachReviewSession({
      reviewRunId: "review-1",
      reviewerSessionId: "reviewer",
      sourceLeaseFencingToken: 1n,
      expectedRunRevision: created.run.revision
    });
    store.close();
    const reopened = new OperationalStore(filePath, { now: () => 50 });
    replaceStore(reopened);
    const recovery = reopened.recoverStartup("review-recovery");
    expect(recovery.recoveredReviewRuns).toHaveLength(1);
    expect(recovery.recoveredReviewRuns[0]).toMatchObject({ id: "review-1", state: "failed", failureCode: "interrupted", endedAt: 50 });
    expect(reopened.getReviewRunBundle("review-1").sourceLease.state).toBe("released");
    expect(reopened.getSessionRuntimePolicy("reviewer").policy).toBe("review_read_only");
    expect(reopened.recoverStartup("review-recovery-replay").recoveredReviewRuns).toEqual([]);
    expect(reopened.createReviewRun({ ...reviewInput(), id: "review-after-restart" }).sourceLease.fencingToken).toBe(2n);
  });

});

function reviewInput(): CreateReviewRunInput {
  const evidenceSeal = {
    version: 1 as const,
    conversationSha256: sha("a"),
    workspaceSha256: sha("b"),
    filesSha256: sha("c"),
    artifactsSha256: sha("d")
  };
  return {
    id: "review-1",
    sourceSessionId: "source",
    targetKind: "mixed",
    evidenceSeal: { ...evidenceSeal, sealSha256: aggregateSeal(evidenceSeal) },
    attachments: [
      { kind: "file", displayName: "report.txt", blob: { id: "blob-1", sha256: sha("f"), byteLength: 2, mimeType: "text/plain", fileName: "report.txt" } },
      { kind: "image", displayName: "screen.png", blob: { id: "blob-2", sha256: sha("9"), byteLength: 3, mimeType: "image/png", fileName: "screen.png" } }
    ],
    createdAt: 10
  };
}

function aggregateSeal(value: Omit<CreateReviewRunInput["evidenceSeal"], "sealSha256">): string {
  return createHash("sha256")
    .update("joko.review.freshness/v1")
    .update("\0")
    .update("seal")
    .update("\0")
    .update(JSON.stringify([value.conversationSha256, value.workspaceSha256, value.filesSha256, value.artifactsSha256]))
    .digest("hex");
}

function fixture(): { readonly store: OperationalStore; readonly filePath: string; readonly replaceStore: (value: OperationalStore) => void } {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-review-store-"));
  const filePath = path.join(directory, "operational.sqlite");
  let current = new OperationalStore(filePath, { now: () => 20 });
  cleanups.push(() => {
    current.close();
    rmSync(directory, { recursive: true, force: true });
  });
  current.upsertBackend({
    id: "pi", adapterKind: "fixture", instanceGeneration: 0,
    displayName: "Pi", version: "1", health: "healthy",
    installationState: "installed", authenticationState: "not_required",
    capabilities: new Map(), models: [], tools: [], diagnostics: []
  });
  current.upsertTarget({ id: "target", backendId: "pi", displayName: "Workspace", workspaceRoot: "D:/workspace", managed: false, trusted: true });
  for (const [id, opaqueRef] of [["source", "native/source.jsonl"], ["reviewer", "native/reviewer.jsonl"]] as const) {
    current.createSession({
      id, backendId: "pi", targetId: "target", title: id, binding: { opaqueRef, generation: 0 },
      pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false,
      createdAt: 1, updatedAt: 1
    });
  }
  return {
    get store() { return current; },
    filePath,
    replaceStore(value) { current = value; }
  };
}
