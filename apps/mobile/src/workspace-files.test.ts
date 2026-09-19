import { create } from "@bufbuild/protobuf";
import {
  ArtifactKind,
  ArtifactSchema,
  CapabilitySupport,
  FileKind,
  FileRevisionSchema,
  SnapshotSchema,
  WorkspaceEntrySchema,
  WorkspaceKind,
  capabilityNames
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  canonicalWorkspacePath,
  filterWorkspaceFileNames,
  resolveMobileWorkspaceAuthority,
  sortArtifacts,
  sortWorkspaceEntries,
  workspaceBasename,
  workspaceEntryRevisionKey,
  workspaceParentPath
} from "./workspace-files";

function fileSnapshot(workspaceId = "workspace") {
  return create(SnapshotSchema, {
    snapshotId: "owner-1",
    generation: 3n,
    revision: { etag: "snapshot-3", value: 3n },
    backends: [{
      backendId: "backend",
      entityVersion: { revision: { etag: "backend-2", value: 2n } },
      capabilities: { capabilities: [
        { name: capabilityNames.workspaceFiles, support: CapabilitySupport.SUPPORTED },
        { name: capabilityNames.workspaceFilesWatch, support: CapabilitySupport.SUPPORTED }
      ] }
    }],
    targets: [{
      targetId: "target", backendId: "backend", workspaceId,
      version: { revision: { etag: "target-4", value: 4n } }
    }],
    workspaces: [{
      workspaceId, targetId: "target", displayName: "Project", kind: WorkspaceKind.USER_PROJECT,
      version: { revision: { etag: "workspace-5", value: 5n } }
    }],
    sessions: [{
      sessionId: "session", targetId: "target", backendId: "backend",
      nativeBinding: { runtimeGeneration: 6n }, version: { revision: { etag: "session-7", value: 7n } }
    }]
  });
}

describe("mobile Workspace file ownership and presentation", () => {
  it("requires the exact Session to Target to Workspace chain and advertised capability", () => {
    const owner = fileSnapshot();
    const authority = resolveMobileWorkspaceAuthority(owner, owner, "session");

    expect(authority).toMatchObject({
      sessionId: "session", targetId: "target", backendId: "backend", watchSupported: true,
      workspace: { workspaceId: "workspace" }
    });
    expect(resolveMobileWorkspaceAuthority(owner, fileSnapshot("other-workspace"), "session")).toBeUndefined();
    expect(resolveMobileWorkspaceAuthority(create(SnapshotSchema, {
      ...owner,
      backends: [{ ...owner.backends[0]!, capabilities: undefined }]
    }), undefined, "session")).toBeUndefined();
    expect(resolveMobileWorkspaceAuthority(owner, owner, "different-session")).toBeUndefined();
  });

  it("accepts only canonical POSIX paths and derives parents without decoding aliases", () => {
    expect(canonicalWorkspacePath("src/screens/App.tsx")).toBe("src/screens/App.tsx");
    expect(canonicalWorkspacePath("", true)).toBe("");
    expect(workspaceParentPath("src/screens/App.tsx")).toBe("src/screens");
    expect(workspaceBasename("src/screens/App.tsx")).toBe("App.tsx");
    for (const path of ["", "/root", "src/", "src//file", "src/../file", "src\\file", "src\u0000file"]) {
      expect(() => canonicalWorkspacePath(path)).toThrow(/non-canonical/);
    }
  });

  it("sorts directories before files with deterministic natural ordering", () => {
    const entries = [
      create(WorkspaceEntrySchema, { workspaceId: "workspace", relativePath: "z10.txt", displayName: "z10.txt", kind: FileKind.REGULAR }),
      create(WorkspaceEntrySchema, { workspaceId: "workspace", relativePath: "folder", displayName: "folder", kind: FileKind.DIRECTORY }),
      create(WorkspaceEntrySchema, { workspaceId: "workspace", relativePath: "z2.txt", displayName: "z2.txt", kind: FileKind.REGULAR })
    ];

    expect(sortWorkspaceEntries(entries).map((entry) => entry.relativePath)).toEqual(["folder", "z2.txt", "z10.txt"]);
  });

  it("performs literal name search over the complete file index and same-task Artifacts", () => {
    const artifacts = [
      create(ArtifactSchema, { artifactId: "b", sessionId: "session", kind: ArtifactKind.FILE, title: "Report 10" }),
      create(ArtifactSchema, { artifactId: "a", sessionId: "session", kind: ArtifactKind.FILE, title: "report 2" })
    ];

    expect(sortArtifacts(artifacts).map((artifact) => artifact.artifactId)).toEqual(["a", "b"]);
    expect(filterWorkspaceFileNames(["src/A+B.ts", "docs/report.md"], artifacts, "a+b", false))
      .toEqual([{ kind: "workspace-name", relativePath: "src/A+B.ts" }]);
    expect(filterWorkspaceFileNames(["src/A+B.ts"], artifacts, "a+b", true)).toEqual([]);
    expect(filterWorkspaceFileNames(["docs/report.md"], artifacts, "report", false).map((result) => result.kind))
      .toEqual(["workspace-name", "artifact", "artifact"]);
  });

  it("keys the full observed file revision, including size, digest, timestamp and opaque fence", () => {
    const first = create(FileRevisionSchema, { opaqueRevision: "opaque", sha256Hex: "a".repeat(64), byteSize: 8n,
      modifiedAt: { seconds: 2n, nanos: 3 } });
    expect(workspaceEntryRevisionKey(first)).toBe(`opaque:${"a".repeat(64)}:8:2.3`);
    expect(workspaceEntryRevisionKey(create(FileRevisionSchema, { ...first, byteSize: 9n }))).not.toBe(workspaceEntryRevisionKey(first));
    expect(() => workspaceEntryRevisionKey(create(FileRevisionSchema, { ...first, opaqueRevision: "" }))).toThrow(/unfenced/);
  });
});
