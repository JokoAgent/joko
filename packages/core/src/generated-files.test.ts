import { describe, expect, it } from "vitest";

import type { WorkspaceChangeSetProjection, WorkspaceFileRevisionProjection } from "./events.js";
import { projectGeneratedWorkspaceFiles } from "./generated-files.js";

const revision: WorkspaceFileRevisionProjection = {
  sha256Hex: "a".repeat(64),
  byteSize: 42,
  modifiedAt: 1_700_000_000_000,
  opaqueRevision: "revision-one"
};

function changeSet(
  changes: WorkspaceChangeSetProjection["changes"],
  completeBaseline = true
): WorkspaceChangeSetProjection {
  return {
    changeSetId: "change-set-one",
    workspaceId: "workspace-one",
    sessionId: "session-one",
    runId: "run-one",
    turnId: "turn-one",
    baselineId: "baseline-one",
    changes,
    completeBaseline,
    gaps: [],
    capturedAt: 1_700_000_000_100
  };
}

describe("projectGeneratedWorkspaceFiles", () => {
  it("keeps only created files with an authoritative post-run revision", () => {
    expect(projectGeneratedWorkspaceFiles(changeSet([
      { relativePath: "reports\\summary.pdf", kind: "created", afterRevision: revision },
      { relativePath: "src/existing.ts", kind: "updated", beforeRevision: revision, afterRevision: revision },
      { relativePath: "removed.txt", kind: "deleted", beforeRevision: revision },
      { relativePath: "empty-evidence.txt", kind: "created" }
    ]))).toEqual([{
      relativePath: "reports/summary.pdf",
      displayName: "summary.pdf",
      byteSize: 42,
      modifiedAt: 1_700_000_000_000,
      opaqueRevision: "revision-one"
    }]);
  });

  it("fails closed for incomplete baselines, unsafe paths, and duplicates", () => {
    expect(projectGeneratedWorkspaceFiles(changeSet([
      { relativePath: "safe/output.txt", kind: "created", afterRevision: revision }
    ], false))).toEqual([]);

    expect(projectGeneratedWorkspaceFiles(changeSet([
      { relativePath: "../outside.txt", kind: "created", afterRevision: revision },
      { relativePath: "C:\\outside.txt", kind: "created", afterRevision: revision },
      { relativePath: "safe/output.txt", kind: "created", afterRevision: revision },
      { relativePath: "safe\\output.txt", kind: "created", afterRevision: revision }
    ]))).toEqual([expect.objectContaining({ relativePath: "safe/output.txt" })]);
  });
});
