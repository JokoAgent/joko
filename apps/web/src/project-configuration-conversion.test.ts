import { describe, expect, it, vi } from "vitest";
import { applyProjectConfiguration, inspectProjectConfiguration, localProjectConversion, type ProjectConversionPlanner } from "./project-configuration-conversion.js";
import type { WorkspaceEntryView, WorkspaceFilePreviewView, WorkspaceView } from "./model.js";

const project = { backend: "codex", workspaceId: "authorized" } as const;
const plan: ProjectConversionPlanner = async (_backend, files) => {
  const instructions = files.find(file => file.path === "CLAUDE.md");
  return instructions?.text && files.some(file => file.path === "AGENTS.md" && file.text === null)
    ? [{ category: "instructions", writes: [{ path: "AGENTS.md", text: instructions.text }] }]
    : [];
};

describe("trusted desktop project conversion", () => {
  it("only writes confirmed output through the original workspace and revision", async () => {
    const { operations } = workspaceFixture();
    const preview = await inspectProjectConfiguration(operations, project, plan, () => true);
    expect(preview.candidates).toHaveLength(1);
    expect(operations.createWorkspaceEntry).not.toHaveBeenCalled();
    await applyProjectConfiguration(operations, project, plan, preview, new Set(), () => true);
    expect(operations.writeWorkspaceTextFile).not.toHaveBeenCalled();
    await applyProjectConfiguration(operations, project, plan, preview, new Set(["instructions"]), () => true);
    expect(operations.createWorkspaceEntry).toHaveBeenCalledWith({ workspaceId: "authorized", path: "AGENTS.md", kind: "file" });
    expect(operations.writeWorkspaceTextFile).toHaveBeenCalledWith("authorized", { path: "AGENTS.md", text: "Source", expectedRevision: "created" });
  });

  it("keeps a concurrently created target and rejects a retired owner", async () => {
    const { operations, files } = workspaceFixture();
    const preview = await inspectProjectConfiguration(operations, project, plan, () => true);
    files.set("AGENTS.md", { text: "Concurrent content", revision: "new" });
    await expect(applyProjectConfiguration(operations, project, plan, preview, new Set(["instructions"]), () => true)).rejects.toThrow("changed");
    await expect(applyProjectConfiguration(operations, project, plan, preview, new Set(["instructions"]), () => false)).rejects.toThrow("owner changed");
    expect(operations.createWorkspaceEntry).not.toHaveBeenCalled();
    expect(operations.writeWorkspaceTextFile).not.toHaveBeenCalled();
  });

  it("limits conversion to the selected writable local project", () => {
    const workspace: WorkspaceView = { id: "authorized", targetId: "target", name: "Project", serverPath: "/project",
      trusted: true, kind: "userProject", dirty: false, entries: [] };
    expect(localProjectConversion(workspace, "codex", true, true)).toEqual(project);
    expect(localProjectConversion({ ...workspace, trusted: false }, "codex", true, true)).toBeUndefined();
    expect(localProjectConversion(workspace, "codex", true, false)).toBeUndefined();
    expect(localProjectConversion(workspace, "codex", false, true)).toBeUndefined();
    expect(localProjectConversion(workspace, "pi", true, true)).toBeUndefined();
  });
});

function workspaceFixture() {
  const files = new Map([["CLAUDE.md", { text: "Source", revision: "source" }]]);
  const operations = {
    listWorkspaceEntries: vi.fn(async (_workspaceId: string, directory: string): Promise<WorkspaceEntryView[]> =>
      directory === "" ? Array.from(files, ([path, { revision }]) => ({ path, name: path, revision, kind: "file", generated: false })) : []),
    readWorkspaceFile: vi.fn(async (_workspaceId: string, path: string): Promise<WorkspaceFilePreviewView> => {
      const value = files.get(path);
      if (!value) throw new Error("missing");
      return { ...value, path, name: path, kind: "text", truncated: false };
    }),
    createWorkspaceEntry: vi.fn(async ({ path }: { path: string }) => { files.set(path, { text: "", revision: "created" }); }),
    copyWorkspaceEntry: vi.fn(async () => {}),
    writeWorkspaceTextFile: vi.fn(async (_workspaceId: string, { path, text }: { path: string; text: string }) => {
      files.set(path, { text, revision: "written" });
      return { path, name: path, revision: "written" };
    })
  };
  return { operations, files };
}
