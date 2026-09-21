import { create } from "@bufbuild/protobuf";
import {
  BackendDescriptorSchema,
  CapabilityManifestSchema,
  CapabilitySchema,
  CapabilitySupport,
  EntityVersionSchema,
  FileKind,
  RevisionSchema,
  SessionSchema,
  SessionState,
  SnapshotSchema,
  TargetSchema,
  TargetState,
  WorkspaceDescriptorSchema,
  WorkspaceEntrySchema,
  WorkspaceKind,
  capabilityNames,
  type Snapshot
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  emptyMobileComposerDraft,
  insertMobileStructuredClipboardText
} from "./mobile-composer-document";
import {
  assertMobileWorkspacePathPasteDraft,
  assertMobileWorkspacePathPasteResolutions,
  createMobileNewTaskWorkspacePathPasteControls,
  createMobileWorkspacePathPasteControls,
  mobileComposerWorkspacePathAtoms,
  projectMobileWorkspacePathPasteDirectory
} from "./mobile-workspace-path-paste";

function snapshot(serverPathDisplay = "D:\\repo"): Snapshot {
  const version = create(EntityVersionSchema, {
    generation: 8n,
    revision: create(RevisionSchema, { value: 9n, etag: "r9" })
  });
  return create(SnapshotSchema, {
    generation: 1n,
    backends: [create(BackendDescriptorSchema, {
      backendId: "backend",
      capabilities: create(CapabilityManifestSchema, {
        capabilities: [create(CapabilitySchema, {
          name: capabilityNames.workspaceFiles,
          support: CapabilitySupport.SUPPORTED
        })]
      })
    })],
    targets: [create(TargetSchema, {
      targetId: "target",
      backendId: "backend",
      workspaceId: "workspace",
      state: TargetState.ACTIVE,
      version
    })],
    workspaces: [create(WorkspaceDescriptorSchema, {
      workspaceId: "workspace",
      targetId: "target",
      displayName: "Project",
      serverPathDisplay,
      kind: WorkspaceKind.USER_PROJECT,
      version
    })],
    sessions: [create(SessionSchema, {
      sessionId: "session",
      backendId: "backend",
      targetId: "target",
      state: SessionState.IDLE,
      nativeBinding: { runtimeGeneration: 8n },
      version
    })]
  });
}

function pathDraft() {
  return insertMobileStructuredClipboardText(
    emptyMobileComposerDraft(),
    { start: 0, end: 0 },
    "D:\\repo\\src\\Main.ts",
    () => "path",
    { workspacePath: {
      workspaceId: "workspace",
      serverPathDisplay: "D:\\repo",
      resolutions: [{
        candidateRelativePath: "src/Main.ts",
        relativePath: "src/Main.ts",
        directory: false
      }]
    } }
  ).draft;
}

describe("mobile Workspace path paste ownership", () => {
  it("binds current and pre-creation surfaces to one exact Files-capable Workspace root", () => {
    const owner = snapshot();
    expect(createMobileWorkspacePathPasteControls("authority", owner, owner, "session")).toMatchObject({
      authorityKey: "authority",
      sessionId: "session",
      targetId: "target",
      backendId: "backend",
      workspaceId: "workspace",
      serverPathDisplay: "D:\\repo"
    });
    expect(createMobileNewTaskWorkspacePathPasteControls("new-authority", owner, "target")).toMatchObject({
      authorityKey: "new-authority",
      targetId: "target",
      workspaceId: "workspace",
      serverPathDisplay: "D:\\repo"
    });
    expect(createMobileWorkspacePathPasteControls("authority", owner, snapshot("D:\\other"), "session"))
      .toBeUndefined();
    expect(createMobileNewTaskWorkspacePathPasteControls("authority", snapshot("\\\\server\\share"), "target"))
      .toBeUndefined();
    expect(createMobileNewTaskWorkspacePathPasteControls("authority", create(SnapshotSchema, {
      ...owner,
      backends: [create(BackendDescriptorSchema, {
        ...owner.backends[0]!,
        capabilities: create(CapabilityManifestSchema, { capabilities: [] })
      })]
    }), "target")).toBeUndefined();
  });

  it("projects only unique exact parent entries and preserves authoritative Windows casing", () => {
    const controls = createMobileWorkspacePathPasteControls("authority", snapshot(), snapshot(), "session")!;
    const resolutions = projectMobileWorkspacePathPasteDirectory(controls, "SRC", [
      create(WorkspaceEntrySchema, {
        workspaceId: "workspace",
        relativePath: "src/Main.ts",
        displayName: "Main.ts",
        kind: FileKind.REGULAR
      }),
      create(WorkspaceEntrySchema, {
        workspaceId: "workspace",
        relativePath: "src/lib",
        displayName: "lib",
        kind: FileKind.DIRECTORY
      }),
      create(WorkspaceEntrySchema, {
        workspaceId: "workspace",
        relativePath: "src/socket",
        displayName: "socket",
        kind: FileKind.SPECIAL
      })
    ], "directory-r1", ["SRC/main.ts", "SRC/LIB", "SRC/socket", "SRC/missing.ts"]);
    expect(resolutions).toEqual([
      { candidateRelativePath: "SRC/main.ts", relativePath: "src/Main.ts", directory: false },
      { candidateRelativePath: "SRC/LIB", relativePath: "src/lib", directory: true }
    ]);
    expect(() => projectMobileWorkspacePathPasteDirectory(controls, "src", [
      create(WorkspaceEntrySchema, { workspaceId: "workspace", relativePath: "src/Main.ts", kind: FileKind.REGULAR }),
      create(WorkspaceEntrySchema, { workspaceId: "workspace", relativePath: "src/main.ts", kind: FileKind.REGULAR })
    ], "directory-r2", ["src/main.ts"])).toThrow(/duplicate/u);
    expect(() => projectMobileWorkspacePathPasteDirectory(controls, "src", [
      create(WorkspaceEntrySchema, { workspaceId: "workspace", relativePath: "src/Main.ts", kind: FileKind.SPECIAL }),
      create(WorkspaceEntrySchema, { workspaceId: "workspace", relativePath: "src/main.ts", kind: FileKind.REGULAR })
    ], "directory-r2", ["src/main.ts"])).toThrow(/duplicate/u);
    expect(() => projectMobileWorkspacePathPasteDirectory(controls, "src", [
      create(WorkspaceEntrySchema, { workspaceId: "other", relativePath: "src/Main.ts", kind: FileKind.REGULAR })
    ], "directory-r3", ["src/Main.ts"])).toThrow(/outside/u);
    expect(() => projectMobileWorkspacePathPasteDirectory(controls, "src", [], "", ["src/Main.ts"]))
      .toThrow(/unfenced/u);
  });

  it("keeps path atoms bound to the exact Workspace and revalidates path kind", () => {
    const draft = pathDraft();
    const controls = createMobileWorkspacePathPasteControls("authority", snapshot(), snapshot(), "session")!;
    expect(mobileComposerWorkspacePathAtoms(assertMobileWorkspacePathPasteDraft(controls, draft)))
      .toMatchObject([{ workspaceId: "workspace", relativePath: "src/Main.ts", directory: false }]);
    expect(() => assertMobileWorkspacePathPasteDraft({ ...controls, workspaceId: "other" }, draft))
      .toThrow(/earlier Workspace/u);
    expect(() => assertMobileWorkspacePathPasteResolutions(controls, draft, []))
      .toThrow(/disappeared/u);
    expect(() => assertMobileWorkspacePathPasteResolutions(controls, draft, [{
      candidateRelativePath: "SRC/main.ts",
      relativePath: "src/Main.ts",
      directory: true
    }])).toThrow(/file type/u);
    expect(() => assertMobileWorkspacePathPasteResolutions(controls, draft, [{
      candidateRelativePath: "SRC/main.ts",
      relativePath: "src/Main.ts",
      directory: false
    }])).not.toThrow();
  });
});
