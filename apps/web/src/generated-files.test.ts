import { create } from "@bufbuild/protobuf";
import {
  FileChangeKind,
  WorkspaceChangeSetSchema
} from "@joko/contracts";
import { describe, expect, it } from "vitest";

import { projectTimelineGeneratedFiles } from "./generated-files.js";

describe("projectTimelineGeneratedFiles", () => {
  it("projects only safe created-file records from a complete turn-start snapshot", () => {
    const changeSet = create(WorkspaceChangeSetSchema, {
      completeBaseline: true,
      changes: [
        { relativePath: "reports\\summary.pdf", kind: FileChangeKind.CREATED, afterRevision: { opaqueRevision: "one" } },
        { relativePath: "src/existing.ts", kind: FileChangeKind.UPDATED, afterRevision: { opaqueRevision: "two" } },
        { relativePath: "../outside.txt", kind: FileChangeKind.CREATED, afterRevision: { opaqueRevision: "three" } },
        { relativePath: "reports/summary.pdf", kind: FileChangeKind.CREATED, afterRevision: { opaqueRevision: "one" } }
      ]
    });

    expect(projectTimelineGeneratedFiles(changeSet)).toEqual([{
      relativePath: "reports/summary.pdf",
      displayName: "summary.pdf"
    }]);
  });

  it("fails closed when the turn-start snapshot is incomplete or creation evidence is absent", () => {
    expect(projectTimelineGeneratedFiles(create(WorkspaceChangeSetSchema, {
      completeBaseline: false,
      changes: [{ relativePath: "output.txt", kind: FileChangeKind.CREATED, afterRevision: { opaqueRevision: "one" } }]
    }))).toEqual([]);
    expect(projectTimelineGeneratedFiles(create(WorkspaceChangeSetSchema, {
      completeBaseline: true,
      changes: [{ relativePath: "output.txt", kind: FileChangeKind.CREATED }]
    }))).toEqual([]);
  });
});
