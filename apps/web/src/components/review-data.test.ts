import { describe, expect, it, vi } from "vitest";
import type { WorkspaceChangeSetView, WorkspaceDiffView } from "../model.js";
import { combineLastTurnDiff, latestTurnPaths, loadReviewSourceDiff, turnSetEvidenceDiff } from "./review-data.js";

describe("Review derived sources", () => {
  it("filters both exact mutable Git layers with the latest persisted turn paths", () => {
    const sets: WorkspaceChangeSetView[] = [changeSet("older", "turn-1", 10, "old.ts"), changeSet("new-a", "turn-2", 20, "src/a.ts"), changeSet("new-b", "turn-2", 21, "src/b.ts")];
    const paths = latestTurnPaths(sets);
    expect([...paths]).toEqual(["src/a.ts", "src/b.ts"]);
    const result = combineLastTurnDiff(diff("unstaged", ["src/a.ts", "ignore.ts"]), diff("staged", ["src/b.ts"]), paths);
    expect(result.source).toBe("lastTurn");
    expect(result.files.map((file) => [file.source, file.path])).toEqual([["unstaged", "src/a.ts"], ["staged", "src/b.ts"]]);
  });

  it("fails closed when the two live layers were read at different repository revisions", () => {
    expect(() => combineLastTurnDiff(diff("unstaged", [], "revision-a"), diff("staged", [], "revision-b"), new Set())).toThrow(/changed/u);
  });

  it("renders TURN_SET from the selected persisted evidence without a live Git read", () => {
    const selected = changeSet("set-2", "turn-2", 20, "src/a.ts");
    const result = turnSetEvidenceDiff([changeSet("set-1", "turn-1", 10, "old.ts"), selected], ["set-2"]);
    expect(result).toMatchObject({ source: "turnSet", sourceRevision: "set-2" });
    expect(result.files).toEqual([expect.objectContaining({ path: "src/a.ts", source: "turnSet", evidenceId: "set-2:0" })]);
  });

  it("allows BRANCH to omit a base so Orchestrator can resolve the safe default", async () => {
    const getWorkspaceDiff = vi.fn(async () => ({
      source: "branch" as const,
      sourceRevision: "a".repeat(40),
      repositoryRevision: "branch-fence",
      headRevision: "b".repeat(40),
      mergeBaseRevision: "a".repeat(40),
      truncated: false,
      files: []
    }));
    await loadReviewSourceDiff(
      { getWorkspaceDiff } as never,
      "workspace-review",
      { kind: "branch", baseRef: null },
      [],
      false
    );
    expect(getWorkspaceDiff).toHaveBeenCalledWith("workspace-review", {
      source: "branch",
      ignoreWhitespace: false
    });
  });
});

function changeSet(id: string, turnId: string, capturedAt: number, path: string): WorkspaceChangeSetView {
  return {
    id,
    runId: "run-1",
    turnId,
    changeCount: 1,
    changes: [{ path, kind: "updated" }],
    completeBaseline: true,
    gaps: [],
    capturedAt
  };
}

function diff(source: "unstaged" | "staged", paths: readonly string[], repositoryRevision = "revision-1"): WorkspaceDiffView {
  return {
    source,
    repositoryRevision,
    headRevision: "head-1",
    truncated: false,
    files: paths.map((path) => ({ path, source, status: "modified", binary: false, text: "", hunks: [] }))
  };
}
