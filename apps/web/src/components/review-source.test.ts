import { describe, expect, it } from "vitest";

import { reviewSourceCapabilities } from "./review-source.js";

describe("Review source descriptors", () => {
  it("keeps snapshot sources read-only while working sources retain Git actions", () => {
    expect(reviewSourceCapabilities({ kind: "unstaged" })).toMatchObject({
      canDiscard: true,
      canCommit: true,
      canPush: true,
      canRichPreview: true,
      canOpenFile: true,
      showBranchInfo: true
    });
    expect(reviewSourceCapabilities({ kind: "turn-set", targetSessionId: "session", changeSetIds: ["change"] })).toMatchObject({
      canDiscard: false,
      canCommit: false,
      canPush: false,
      canRichPreview: false,
      canOpenFile: false,
      showBranchInfo: false
    });
  });
});
