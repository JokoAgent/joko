import { mkdir, realpath, symlink } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { managedWorkspaceTrashPath, moveManagedWorkspaceToTrash } from "./managed-workspace-trash.js";

describe("managed workspace trash", () => {
  it("moves only a canonical child to a deterministic recoverable destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-managed-trash-"));
    const managedRoot = resolve(root, "managed");
    const workspaceRoot = resolve(managedRoot, "workspace-a");
    await mkdir(workspaceRoot, { recursive: true });
    const request = { managedRoot, workspaceRoot, targetId: "target-a", operationId: "operation-a" };

    const moved = await moveManagedWorkspaceToTrash(request);

    expect(moved.trashedPath).toBe(managedWorkspaceTrashPath(request));
    expect(await realpath(moved.trashedPath)).toBe(moved.trashedPath);
    await expect(realpath(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(moveManagedWorkspaceToTrash(request)).resolves.toEqual(moved);
  });

  it("rejects user projects, the managed root itself, and a workspace already in trash", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-managed-boundary-"));
    const managedRoot = resolve(root, "managed");
    const userProject = resolve(root, "user-project");
    await Promise.all([mkdir(managedRoot), mkdir(userProject)]);

    await expect(moveManagedWorkspaceToTrash({
      managedRoot,
      workspaceRoot: userProject,
      targetId: "target-user",
      operationId: "operation-user"
    })).rejects.toThrow("outside");
    await expect(moveManagedWorkspaceToTrash({
      managedRoot,
      workspaceRoot: managedRoot,
      targetId: "target-root",
      operationId: "operation-root"
    })).rejects.toThrow("outside");

    const trashed = resolve(managedRoot, ".trash", "existing");
    await mkdir(trashed, { recursive: true });
    await expect(moveManagedWorkspaceToTrash({
      managedRoot,
      workspaceRoot: trashed,
      targetId: "target-trash",
      operationId: "operation-trash"
    })).rejects.toThrow("already inside");
  });

  it("fails closed for a linked workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-managed-link-"));
    const managedRoot = resolve(root, "managed");
    const realWorkspace = resolve(managedRoot, "real-workspace");
    const linkedWorkspace = resolve(managedRoot, "linked-workspace");
    await mkdir(realWorkspace, { recursive: true });
    await symlink(realWorkspace, linkedWorkspace, process.platform === "win32" ? "junction" : "dir");

    await expect(moveManagedWorkspaceToTrash({
      managedRoot,
      workspaceRoot: linkedWorkspace,
      targetId: "target-link",
      operationId: "operation-link"
    })).rejects.toThrow(/real directory|alias|link/u);
  });
});
