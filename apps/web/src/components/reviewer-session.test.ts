import { describe, expect, it } from "vitest";
import type { ReviewRunView } from "../model.js";
import { reviewRunForReviewerSession } from "./reviewer-session.js";

describe("reviewer task recognition", () => {
  it.each(["running", "completed", "failed"] as const)("keeps a %s reviewer task read-only", (state) => {
    expect(reviewRunForReviewerSession([run({ state })], "reviewer-1")?.state).toBe(state);
  });

  it("does not classify the source task or an unrelated task as a reviewer", () => {
    const review = run();
    expect(reviewRunForReviewerSession([review], review.sourceSessionId)).toBeUndefined();
    expect(reviewRunForReviewerSession([review], "other")).toBeUndefined();
    expect(reviewRunForReviewerSession([review], undefined)).toBeUndefined();
  });

  it("selects the newest durable record deterministically", () => {
    const selected = reviewRunForReviewerSession([
      run({ id: "review-old", revision: 1n, updatedAt: 20 }),
      run({ id: "review-b", revision: 2n, updatedAt: 30 }),
      run({ id: "review-a", revision: 2n, updatedAt: 30 })
    ], "reviewer-1");
    expect(selected?.id).toBe("review-b");
  });
});

function run(overrides: Partial<ReviewRunView> = {}): ReviewRunView {
  return {
    id: "review-1",
    sourceSessionId: "source-1",
    reviewerSessionId: "reviewer-1",
    state: "running",
    freshness: "current",
    freshnessCheckedAt: 10,
    targetKind: "mixed",
    evidence: { sealSha256: "a".repeat(64), capturedAt: 10 },
    createdAt: 10,
    updatedAt: 10,
    revision: 1n,
    ...overrides
  };
}
