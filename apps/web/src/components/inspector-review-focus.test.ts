import { describe, expect, it } from "vitest";

import type { WorkspaceFileDiffView } from "../model.js";
import { createInspectorTurnReviewRequest, selectedTurnReviewFile } from "./inspector-review-focus.js";

describe("inspector exact-turn review focus", () => {
  const files: readonly WorkspaceFileDiffView[] = [
    file("src/first.ts"),
    { ...file("src/renamed.ts"), oldPath: "src/old.ts", status: "renamed" }
  ];

  it("keeps the owning task, immutable change set, and optional selected file together", () => {
    expect(createInspectorTurnReviewRequest(7, "task-1", "change-2", "src/first.ts")).toEqual({
      kind: "turn-review",
      requestId: 7,
      sessionId: "task-1",
      changeSetId: "change-2",
      selectedPath: "src/first.ts"
    });
  });

  it("selects current or renamed paths and falls back to the first recorded file", () => {
    expect(selectedTurnReviewFile(files, "src\\old.ts")?.path).toBe("src/renamed.ts");
    expect(selectedTurnReviewFile(files, "missing.ts")?.path).toBe("src/first.ts");
    expect(selectedTurnReviewFile(files, undefined)?.path).toBe("src/first.ts");
  });
});

function file(path: string): WorkspaceFileDiffView {
  return {
    path,
    source: "turnSet",
    status: "modified",
    binary: false,
    text: "",
    hunks: []
  };
}
