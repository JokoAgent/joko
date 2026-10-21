import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { copyWorktreeIncludeFiles, readWorktreeIncludeMatcher } from "./include-files.js";
import { WorktreeOperationControl } from "./operation.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-includes-")); roots.push(root);
  const source = join(root, "source"), destination = join(root, "destination"), outside = join(root, "outside");
  for (const path of [source, destination, outside]) await mkdir(path);
  for (const path of [source, destination]) {
    await exec("git", ["init", "--initial-branch=main"], { cwd: path, windowsHide: true });
    await exec("git", ["-c", "user.name=Joko Test", "-c", "user.email=test@invalid.example", "commit", "--allow-empty", "-m", "initial"], { cwd: path, windowsHide: true });
  }
  return { source, destination, outside, control: new WorktreeOperationControl(undefined, 30_000) };
}

describe("local worktree include boundaries", () => {
  it("keeps root anchors, directory-only rules, ordered negation and independent rule files", async () => {
    const { source } = await fixture();
    await writeFile(join(source, ".worktreeinclude"), "/.env\ncache/\n!cache/private/**\nconfig/**\n!extra.json\nsecret**.json\n");
    await writeFile(join(source, ".jokoworktreeinclude"), "extra.json\noutput/**\n");
    const matches = await readWorktreeIncludeMatcher(source);
    expect([".env", "cache/item.bin", "sub/cache/item.bin", "config/deep/config.json", "extra.json", "output", "output/item", "secrets.json"].filter(matches))
      .toHaveLength(8);
    for (const key of ["sub/.env", "cache", "cache/private/secret", "config", "sub/config/item", "secret/path.json", "../.env", ".git/config"]) expect(matches(key), key).toBe(false);
  });

  it("refuses destination symlink parents and leaves outside files untouched", async () => {
    const { source, destination, outside, control } = await fixture();
    await writeFile(join(source, ".worktreeinclude"), "config/**\n");
    await mkdir(join(source, "config"));
    await writeFile(join(source, "config", "local.txt"), "source config");
    await writeFile(join(outside, "local.txt"), "outside config");
    await symlink(outside, join(destination, "config"), process.platform === "win32" ? "junction" : "dir");
    await expect(copyWorktreeIncludeFiles(source, destination, control)).rejects.toMatchObject({ code: "PATH_UNSAFE" });
    expect(await readFile(join(outside, "local.txt"), "utf8")).toBe("outside config");
  });

  it("never replaces a file tracked only by the selected destination branch", async () => {
    const { source, destination, control } = await fixture();
    await writeFile(join(source, ".worktreeinclude"), "config.json\n");
    await writeFile(join(source, "config.json"), "source private config");
    await writeFile(join(destination, "config.json"), "selected branch config");
    await exec("git", ["add", "config.json"], { cwd: destination, windowsHide: true });
    await exec("git", ["-c", "user.name=Joko Test", "-c", "user.email=test@invalid.example", "commit", "-m", "branch config"], { cwd: destination, windowsHide: true });
    await copyWorktreeIncludeFiles(source, destination, control);
    expect(await readFile(join(destination, "config.json"), "utf8")).toBe("selected branch config");
  });
});
