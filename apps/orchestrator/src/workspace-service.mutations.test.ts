import { link, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceEntryAbsentRevision } from "@joko/contracts";

import { WorkspaceService } from "./workspace-service.js";

describe("WorkspaceService entry mutations", () => {
  it("creates only canonical, previously absent files and directories", async () => {
    const { root, service } = await fixture("create");
    await mkdir(join(root, "docs"));

    const file = await service.createEntry("workspace", { path: "docs/notes.md", kind: "file", expectedRevision: workspaceEntryAbsentRevision });
    const directory = await service.createEntry("workspace", { path: "assets", kind: "directory", expectedRevision: workspaceEntryAbsentRevision });

    expect(file.entry).toMatchObject({ path: "docs/notes.md", kind: "file", size: 0 });
    expect(directory.entry).toMatchObject({ path: "assets", kind: "directory" });
    await expect(service.createEntry("workspace", { path: "unfenced.txt", kind: "file", expectedRevision: "" }))
      .rejects.toMatchObject({ code: "WORKSPACE_ENTRY_INVALID", kind: "invalid" });
    await expect(service.createEntry("workspace", { path: "docs/notes.md", kind: "file", expectedRevision: workspaceEntryAbsentRevision }))
      .rejects.toMatchObject({ code: "WORKSPACE_ENTRY_CONFLICT", kind: "conflict" });
    await expect(service.createEntry("workspace", { path: "docs/../escape", kind: "file", expectedRevision: workspaceEntryAbsentRevision }))
      .rejects.toMatchObject({ code: "WORKSPACE_ENTRY_INVALID", kind: "invalid" });
    await expect(service.createEntry("workspace", { path: ".git/config", kind: "file", expectedRevision: workspaceEntryAbsentRevision }))
      .rejects.toMatchObject({ code: "WORKSPACE_ENTRY_UNSAFE", kind: "unsafe" });
  });

  it("moves a revision-fenced file without overwriting a destination", async () => {
    const { root, service } = await fixture("move");
    await writeFile(join(root, "source.txt"), "source", "utf8");
    await writeFile(join(root, "occupied.txt"), "occupied", "utf8");
    const source = await listed(service, "source.txt");

    await expect(service.moveEntry("workspace", {
      sourcePath: "source.txt",
      destinationPath: "occupied.txt",
      expectedRevision: source.revision
    })).rejects.toMatchObject({ code: "WORKSPACE_ENTRY_CONFLICT" });
    expect(await readFile(join(root, "source.txt"), "utf8")).toBe("source");
    expect(await readFile(join(root, "occupied.txt"), "utf8")).toBe("occupied");

    const moved = await service.moveEntry("workspace", {
      sourcePath: "source.txt",
      destinationPath: "renamed.txt",
      expectedRevision: source.revision
    });
    expect(moved.entry).toMatchObject({ path: "renamed.txt", kind: "file" });
    expect(await readFile(join(root, "renamed.txt"), "utf8")).toBe("source");
  });

  it("rejects stale source revisions before move, copy, and delete effects", async () => {
    const { root, service } = await fixture("stale");
    await writeFile(join(root, "source.txt"), "one", "utf8");
    const source = await listed(service, "source.txt");
    await writeFile(join(root, "source.txt"), "replacement-content", "utf8");

    await expect(service.moveEntry("workspace", {
      sourcePath: "source.txt",
      destinationPath: "moved.txt",
      expectedRevision: source.revision
    })).rejects.toMatchObject({ code: "WORKSPACE_ENTRY_STALE" });
    await expect(service.copyEntry("workspace", {
      sourcePath: "source.txt",
      destinationPath: "copy.txt",
      expectedRevision: source.revision
    })).rejects.toMatchObject({ code: "WORKSPACE_ENTRY_STALE" });
    await expect(service.deleteEntry("workspace", {
      path: "source.txt",
      expectedRevision: source.revision,
      confirmRecursive: false
    })).rejects.toMatchObject({ code: "WORKSPACE_ENTRY_STALE" });
    expect(await readFile(join(root, "source.txt"), "utf8")).toBe("replacement-content");
  });

  it("copies complete regular-file directory trees and preserves the source", async () => {
    const { root, service } = await fixture("copy");
    await mkdir(join(root, "source"));
    await mkdir(join(root, "source", "nested"));
    await writeFile(join(root, "source", "a.txt"), "alpha", "utf8");
    await writeFile(join(root, "source", "nested", "b.txt"), "beta", "utf8");
    const source = await listed(service, "source");

    const copied = await service.copyEntry("workspace", {
      sourcePath: "source",
      destinationPath: "duplicate",
      expectedRevision: source.revision
    });

    expect(copied.entry).toMatchObject({ path: "duplicate", kind: "directory" });
    expect(await readFile(join(root, "duplicate", "a.txt"), "utf8")).toBe("alpha");
    expect(await readFile(join(root, "duplicate", "nested", "b.txt"), "utf8")).toBe("beta");
    expect(await readFile(join(root, "source", "nested", "b.txt"), "utf8")).toBe("beta");
  });

  it("rejects symlink and hardlink trees before copy, move, or delete", async () => {
    const { root, service } = await fixture("links");
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "file.txt"), "content", "utf8");
    await symlink(join(root, "real"), join(root, "linked"), "junction");
    await link(join(root, "real", "file.txt"), join(root, "real", "alias.txt"));
    const real = await listed(service, "real");

    await expect(service.copyEntry("workspace", {
      sourcePath: "linked",
      destinationPath: "linked-copy",
      expectedRevision: "any-revision"
    })).rejects.toMatchObject({ code: "WORKSPACE_ENTRY_UNSUPPORTED" });
    await expect(service.copyEntry("workspace", {
      sourcePath: "real",
      destinationPath: "copy",
      expectedRevision: real.revision
    })).rejects.toMatchObject({ code: "WORKSPACE_ENTRY_UNSAFE" });
    await expect(service.deleteEntry("workspace", {
      path: "real",
      expectedRevision: real.revision,
      confirmRecursive: true
    })).rejects.toMatchObject({ code: "WORKSPACE_ENTRY_UNSAFE" });
    expect((await stat(join(root, "real"))).isDirectory()).toBe(true);
  });

  it("requires explicit recursive confirmation and deletes only the fenced tree", async () => {
    const { root, service } = await fixture("delete");
    await mkdir(join(root, "folder"));
    await writeFile(join(root, "folder", "file.txt"), "content", "utf8");
    await writeFile(join(root, "outside.txt"), "outside", "utf8");
    const folder = await listed(service, "folder");

    await expect(service.deleteEntry("workspace", {
      path: "folder",
      expectedRevision: folder.revision,
      confirmRecursive: false
    })).rejects.toMatchObject({ code: "WORKSPACE_ENTRY_UNSAFE" });
    await service.deleteEntry("workspace", {
      path: "folder",
      expectedRevision: folder.revision,
      confirmRecursive: true
    });
    await expect(stat(join(root, "folder"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "outside.txt"), "utf8")).toBe("outside");
  });
});

async function fixture(name: string): Promise<{ readonly root: string; readonly service: WorkspaceService }> {
  const root = await mkdtemp(join(tmpdir(), `joko-workspace-mutation-${name}-`));
  const service = new WorkspaceService();
  await service.register({ id: "workspace", root, displayName: name, trusted: true });
  return { root, service };
}

async function listed(service: WorkspaceService, path: string) {
  const entries = await service.list("workspace", "", { recursive: true });
  const entry = entries.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`Missing fixture entry ${path}`);
  return entry;
}
