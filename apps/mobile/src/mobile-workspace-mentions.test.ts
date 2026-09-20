import { create } from "@bufbuild/protobuf";
import {
  BackendDescriptorSchema,
  CapabilityManifestSchema,
  CapabilityOptionsSchema,
  CapabilitySchema,
  CapabilitySupport,
  EntityVersionSchema,
  FileKind,
  InputCapabilityOptionsSchema,
  RevisionSchema,
  SessionSchema,
  SessionState,
  SnapshotSchema,
  TargetSchema,
  TargetState,
  WorkspaceEntrySchema,
  WorkspaceKind,
  WorkspaceDescriptorSchema,
  capabilityNames,
  type Snapshot
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { insertMobileWorkspaceMention, plainTextMobileComposerDraft } from "./mobile-composer-document";
import {
  assertMobileWorkspaceMentionCandidate,
  assertMobileWorkspaceMentionDraft,
  createMobileNewTaskWorkspaceMentionControls,
  createMobileWorkspaceMentionControls,
  filterMobileWorkspaceMentionCandidates,
  mobileWorkspaceMentionPolicy,
  normalizeMobileWorkspaceLineRange,
  projectMobileWorkspaceMentionDirectory,
  projectMobileWorkspaceMentionFileIndex
} from "./mobile-workspace-mentions";

function mentionCapability(options: readonly string[], support = CapabilitySupport.SUPPORTED) {
  return create(CapabilitySchema, {
    name: capabilityNames.inputMention,
    support,
    options: create(CapabilityOptionsSchema, {
      kind: { case: "input", value: create(InputCapabilityOptionsSchema, { mediaTypes: [...options] }) }
    })
  });
}

function snapshot(options: readonly string[] = ["workspace_file", "workspace_directory", "workspace_line_range"]): Snapshot {
  const version = create(EntityVersionSchema, {
    generation: 8n,
    revision: create(RevisionSchema, { value: 9n, etag: "r9" })
  });
  return create(SnapshotSchema, {
    generation: 1n,
    backends: [create(BackendDescriptorSchema, {
      backendId: "backend",
      version: "backend-v1",
      capabilities: create(CapabilityManifestSchema, {
        revision: create(RevisionSchema, { value: 4n, etag: "cap-r4" }),
        capabilities: [mentionCapability(options)]
      })
    })],
    targets: [create(TargetSchema, {
      targetId: "target", backendId: "backend", workspaceId: "workspace", state: TargetState.ACTIVE, version
    })],
    workspaces: [create(WorkspaceDescriptorSchema, {
      workspaceId: "workspace", targetId: "target", displayName: "Project", kind: WorkspaceKind.USER_PROJECT, version
    })],
    sessions: [create(SessionSchema, {
      sessionId: "session", backendId: "backend", targetId: "target", displayName: "Task",
      state: SessionState.IDLE, nativeBinding: { runtimeGeneration: 8n }, version
    })]
  });
}

describe("mobile Workspace mention ownership", () => {
  it("derives every kind only from a unique explicit typed option", () => {
    const backend = (options: readonly string[], support?: CapabilitySupport) => create(BackendDescriptorSchema, {
      backendId: "backend",
      capabilities: create(CapabilityManifestSchema, { capabilities: [mentionCapability(options, support)] })
    });

    expect(mobileWorkspaceMentionPolicy(backend(["workspace_directory"]))).toEqual({
      files: false, directories: true, lineRanges: false
    });
    expect(mobileWorkspaceMentionPolicy(backend(["workspace_file", "workspace_line_range"]))).toEqual({
      files: true, directories: false, lineRanges: true
    });
    expect(mobileWorkspaceMentionPolicy(backend([]))).toBeUndefined();
    expect(mobileWorkspaceMentionPolicy(backend(["workspace_line_range"]))).toBeUndefined();
    expect(mobileWorkspaceMentionPolicy(backend(["workspace_file", "workspace_file"]))).toBeUndefined();
    expect(mobileWorkspaceMentionPolicy(backend(["workspace_file"], CapabilitySupport.UPSTREAM_MISSING))).toBeUndefined();
    expect(mobileWorkspaceMentionPolicy(create(BackendDescriptorSchema, {
      backendId: "backend",
      capabilities: create(CapabilityManifestSchema, {
        capabilities: [mentionCapability(["workspace_file"]), mentionCapability(["workspace_file"])]
      })
    }))).toBeUndefined();
  });

  it("opens only for an exact current Session, Target, Backend, and Workspace projection", () => {
    const owner = snapshot();
    const controls = createMobileWorkspaceMentionControls("authority", owner, owner, "session");
    expect(controls).toMatchObject({
      authorityKey: "authority", sessionId: "session", targetId: "target", backendId: "backend",
      workspaceId: "workspace", workspaceDisplayName: "Project",
      policy: { files: true, directories: true, lineRanges: true }
    });

    expect(createMobileWorkspaceMentionControls("authority", owner, create(SnapshotSchema, {
      ...owner,
      targets: [create(TargetSchema, { ...owner.targets[0]!, workspaceId: "other" })]
    }), "session")).toBeUndefined();
    expect(createMobileWorkspaceMentionControls("authority", owner, create(SnapshotSchema, {
      ...owner,
      workspaces: [...owner.workspaces, owner.workspaces[0]!]
    }), "session")).toBeUndefined();
    expect(createMobileWorkspaceMentionControls("authority", owner, create(SnapshotSchema, {
      ...owner, generation: 2n
    }), "session")).toBeUndefined();
  });

  it("binds a pre-creation Workspace surface directly to the selected Target", () => {
    const owner = snapshot();
    const controls = createMobileNewTaskWorkspaceMentionControls("new-authority", owner, "target");
    expect(controls).toMatchObject({
      authorityKey: "new-authority",
      targetId: "target",
      backendId: "backend",
      workspaceId: "workspace",
      policy: { files: true, directories: true, lineRanges: true }
    });
    expect(controls?.sessionId).toBeUndefined();
    expect(createMobileNewTaskWorkspaceMentionControls("new-authority", create(SnapshotSchema, {
      ...owner,
      targets: [create(TargetSchema, { ...owner.targets[0]!, state: TargetState.ARCHIVED })]
    }), "target")).toBeUndefined();
  });

  it("projects canonical current-directory entries and keeps browse directories separate from reference permission", () => {
    const owner = snapshot(["workspace_file"]);
    const controls = createMobileWorkspaceMentionControls("authority", owner, owner, "session")!;
    const directory = projectMobileWorkspaceMentionDirectory(controls, "", [
      create(WorkspaceEntrySchema, {
        workspaceId: "workspace", relativePath: "src", displayName: "src", kind: FileKind.DIRECTORY
      }),
      create(WorkspaceEntrySchema, {
        workspaceId: "workspace", relativePath: "README.md", displayName: "README.md", kind: FileKind.REGULAR
      }),
      create(WorkspaceEntrySchema, {
        workspaceId: "workspace", relativePath: "socket", displayName: "socket", kind: FileKind.SPECIAL
      })
    ], "directory-r1");

    expect(directory.entries).toMatchObject([
      { relativePath: "src", directory: true },
      { relativePath: "README.md", directory: false }
    ]);
    expect(() => assertMobileWorkspaceMentionCandidate(controls, directory.entries[0]!)).toThrow(/no longer supports/u);
    expect(assertMobileWorkspaceMentionCandidate(controls, directory.entries[1]!)).toEqual(directory.entries[1]);
    const index = projectMobileWorkspaceMentionFileIndex(controls, ["src/main.ts", "README.md"], "index-r1", true);
    expect(filterMobileWorkspaceMentionCandidates(controls, directory, index, "main")).toMatchObject({
      items: [{ relativePath: "src/main.ts", directory: false }], truncated: true
    });

    expect(() => projectMobileWorkspaceMentionDirectory(controls, "", [create(WorkspaceEntrySchema, {
      workspaceId: "other", relativePath: "README.md", kind: FileKind.REGULAR
    })], "directory-r2")).toThrow(/outside/u);
    expect(() => projectMobileWorkspaceMentionFileIndex(controls, ["src/../secret"], "index-r2", false)).toThrow(/path/u);
  });

  it("rejects capability loss, Workspace drift, and invalid paired line ranges while retaining the document", () => {
    const owner = snapshot();
    const controls = createMobileWorkspaceMentionControls("authority", owner, owner, "session")!;
    const draft = insertMobileWorkspaceMention(
      plainTextMobileComposerDraft("Use "),
      { start: 4, end: 4 },
      {
        workspaceId: "workspace", relativePath: "src/main.ts", displayText: "main.ts", directory: false,
        lineRange: { startLine: 2, endLine: 3 }
      },
      "workspace-occurrence"
    ).draft;

    expect(assertMobileWorkspaceMentionDraft(controls, draft)).toEqual(draft);
    expect(() => assertMobileWorkspaceMentionDraft(undefined, draft)).toThrow(/draft was retained/u);
    const otherOwner = snapshot(["workspace_directory"]);
    const directoriesOnly = createMobileWorkspaceMentionControls("authority", otherOwner, otherOwner, "session")!;
    expect(() => assertMobileWorkspaceMentionDraft(directoriesOnly, draft)).toThrow(/file references/u);
    expect(() => assertMobileWorkspaceMentionDraft(controls, {
      ...draft,
      mentions: draft.mentions.map((mention) => mention.kind === "workspace"
        ? { ...mention, workspaceId: "other" }
        : mention)
    })).toThrow(/earlier task Workspace/u);
    expect(normalizeMobileWorkspaceLineRange(1, 1)).toEqual({ startLine: 1, endLine: 1 });
    expect(() => normalizeMobileWorkspaceLineRange(2, 1)).toThrow(/paired/u);
    expect(() => normalizeMobileWorkspaceLineRange(0, 1)).toThrow(/one-based/u);
  });
});
