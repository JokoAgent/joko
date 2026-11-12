import { create } from "@bufbuild/protobuf";
import {
  FileChangeKind,
  WorkspaceChangeSetSchema
} from "@joko/contracts";
import { describe, expect, it } from "vitest";

import { projectDocumentFiles, projectTimelineGeneratedFiles } from "./generated-files.js";
import type { ArtifactView, TimelineItemView } from "./model.js";

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

it("shows the latest document per Run and path even without a workspace diff", () => {
  const artifact = (id: string, title: string): ArtifactView => ({
    id, blobId: id, title, kind: "file", fileName: "report.docx", mediaType: "application/octet-stream",
    byteSize: 3, sourceSessionId: "session", sourceRevealAvailable: false
  });
  const receipt = (id: string, runId: string, sequence: bigint, result: ArtifactView): TimelineItemView => ({
    id, runId, sequence, artifactOperationId: id, kind: "artifact", createdAt: 0,
    documentFile: { workspaceId: "workspace", relativePath: "report.docx", displayName: "report.docx", format: "docx", artifact: result }
  });
  const first = receipt("first", "run", 2n, artifact("first-blob", "First"));
  const latest = receipt("latest", "run", 4n, artifact("latest-blob", "Latest"));
  const otherRun = receipt("another", "run-2", 6n, latest.documentFile!.artifact);
  const paired: TimelineItemView = {
    id: "artifact", artifactOperationId: "latest", artifact: latest.documentFile!.artifact,
    kind: "artifact", sequence: 3n, createdAt: 0
  };
  const independent = { ...paired, id: "unrelated", artifactOperationId: "unrelated-operation", sequence: 7n };
  const rows = projectDocumentFiles([first, paired, latest, otherRun, independent]);
  expect(rows.map(row => row.id)).toEqual(["first", "another", "unrelated"]);
  expect(rows[0]?.documentFiles?.map(file => file.artifact.title)).toEqual(["Latest"]);
  expect(rows[0]?.documentFileSourceIds).toEqual(["first", "latest", "artifact"]);
  expect(rows[1]?.documentFiles?.map(file => file.relativePath)).toEqual(["report.docx"]);
  expect(rows[2]).toBe(independent);
});
