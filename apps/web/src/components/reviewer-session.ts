import type { ReviewRunView } from "../model.js";

/**
 * Reviewer tasks stay read-only after their Review run reaches a terminal
 * state. Prefer the newest durable run if a reconnect snapshot briefly
 * contains more than one record for the same reviewer Session.
 */
export function reviewRunForReviewerSession(
  reviewRuns: readonly ReviewRunView[],
  sessionId: string | undefined
): ReviewRunView | undefined {
  if (sessionId === undefined) return undefined;
  let selected: ReviewRunView | undefined;
  for (const review of reviewRuns) {
    if (review.reviewerSessionId !== sessionId) continue;
    if (
      selected === undefined
      || review.revision > selected.revision
      || (review.revision === selected.revision && review.updatedAt > selected.updatedAt)
      || (review.revision === selected.revision && review.updatedAt === selected.updatedAt && review.id > selected.id)
    ) selected = review;
  }
  return selected;
}
