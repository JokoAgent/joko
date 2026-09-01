import { afterEach, describe, expect, it } from "vitest";
import {
  getExpandedReviewFileKeys,
  getReviewDiffExpansionAction,
  getReviewDiffsExpanded,
  resetReviewDiffExpansionPreferencesForTests,
  seedReviewDiffsExpanded,
  setReviewDiffsExpanded,
  shouldShowReviewFileTree,
  shouldVirtualizeReviewDiffRows,
  shouldVirtualizeReviewFileList
} from "./review-diff-expansion.js";

afterEach(() => resetReviewDiffExpansionPreferencesForTests());

describe("Review diff expansion preferences", () => {
  it("retains the task-level default across remounts", () => {
    seedReviewDiffsExpanded("session-1", true);
    setReviewDiffsExpanded("session-1", false);
    seedReviewDiffsExpanded("session-1", true);
    expect(getReviewDiffsExpanded("session-1", true)).toBe(false);
  });

  it("evicts the least recently written preference after twenty sessions", () => {
    for (let index = 0; index < 21; index += 1) {
      setReviewDiffsExpanded(`session-${index}`, false);
    }
    expect(getReviewDiffsExpanded("session-0", true)).toBe(true);
    expect(getReviewDiffsExpanded("session-20", true)).toBe(false);
  });

  it("applies per-file overrides without changing the task default", () => {
    const expanded = getExpandedReviewFileKeys(
      ["one", "two", "three"],
      true,
      new Map([["two", false]])
    );
    expect([...expanded]).toEqual(["one", "three"]);
    expect(getReviewDiffExpansionAction(["one"], true)).toBe("collapse");
    expect(getReviewDiffExpansionAction(["one", "two"], true, new Map([["two", false]]))).toBe("expand");
    expect(getReviewDiffExpansionAction(["one", "two"], false, new Map([["one", true], ["two", true]]))).toBe("collapse");
    expect(getReviewDiffExpansionAction([], true)).toBe("disabled");
  });
});

describe("Review list layout thresholds", () => {
  it("virtualizes only lists above one hundred files", () => {
    expect(shouldVirtualizeReviewFileList(100)).toBe(false);
    expect(shouldVirtualizeReviewFileList(101)).toBe(true);
  });

  it("virtualizes only diffs above two hundred rows", () => {
    expect(shouldVirtualizeReviewDiffRows(200)).toBe(false);
    expect(shouldVirtualizeReviewDiffRows(201)).toBe(true);
  });

  it("temporarily hides the preferred file tree below 620px", () => {
    expect(shouldShowReviewFileTree(true, 619, 2)).toBe(false);
    expect(shouldShowReviewFileTree(true, 620, 2)).toBe(true);
    expect(shouldShowReviewFileTree(false, 800, 2)).toBe(false);
    expect(shouldShowReviewFileTree(true, 800, 0)).toBe(false);
  });
});
