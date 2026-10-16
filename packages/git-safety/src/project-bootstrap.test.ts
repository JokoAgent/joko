import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitCommandError, NodeGitCommandRunner, type GitCommandRunner } from "./git-command.js";
import { ProjectGitBootstrap, ProjectGitBootstrapIdentityError } from "./project-bootstrap.js";

const roots: string[] = [];
const runner = new NodeGitCommandRunner();
const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
const fixtureRunner: GitCommandRunner = {
  run: (root, args, options) => runner.run(root, args, { ...options, environment: { ...identity, ...options?.environment } })
};

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

describe("ProjectGitBootstrap", () => {
  // Two serialized admissions include the real native Git initialization and
  // verification chain. Keep the Windows aggregate within its command bound.
  it("serializes initialization of an empty project and preserves empty directories and OS metadata", {
    timeout: process.platform === "win32" ? 30_000 : 5_000
  }, async () => {
    const root = await directory();
    await mkdir(join(root, "nested", "empty"), { recursive: true });
    for (const name of [".DS_Store", "Thumbs.db", "desktop.ini"]) await writeFile(join(root, name), "metadata");
    const bootstrap = new ProjectGitBootstrap(fixtureRunner);
    const results = await Promise.all([bootstrap.ensure(input(root)), bootstrap.ensure(input(root))]);
    expect(results.map(result => result.status).sort()).toEqual(["already_git", "initialized"]);
    expect((await fixtureRunner.run(root, ["ls-tree", "-r", "--name-only", "HEAD"])).stdout).toBe("");
    await expect(access(join(root, ".git", "index"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "desktop.ini"), "utf8")).toBe("metadata");
    await expect(access(join(root, "nested", "empty"))).resolves.toBeUndefined();
  });

  it("does not change an existing repository HEAD, user index, staged edits or untracked files", async () => {
    const root = await directory();
    await fixtureRunner.run(root, ["init"]);
    await writeFile(join(root, "tracked.txt"), "original");
    await fixtureRunner.run(root, ["add", "tracked.txt"]);
    await fixtureRunner.run(root, ["commit", "--no-gpg-sign", "-m", "Initial fixture"]);
    await writeFile(join(root, "tracked.txt"), "staged");
    await fixtureRunner.run(root, ["add", "tracked.txt"]);
    await writeFile(join(root, "untracked.txt"), "untracked");
    const index = await readFile(join(root, ".git", "index"));
    const head = (await fixtureRunner.run(root, ["rev-parse", "HEAD"])).stdout;
    const status = (await fixtureRunner.run(root, ["status", "--porcelain"])).stdout;
    expect(await new ProjectGitBootstrap(fixtureRunner).ensure(input(root))).toMatchObject({ status: "already_git" });
    expect(await readFile(join(root, ".git", "index"))).toEqual(index);
    expect((await fixtureRunner.run(root, ["rev-parse", "HEAD"])).stdout).toBe(head);
    expect((await fixtureRunner.run(root, ["status", "--porcelain"])).stdout).toBe(status);
  });

  it("leaves non-empty projects and linked metadata untouched", async () => {
    const root = await directory();
    await writeFile(join(root, "user.txt"), "keep");
    expect(await new ProjectGitBootstrap(fixtureRunner).ensure(input(root)))
      .toEqual({ status: "skipped", reason: "non_empty_project" });
    await expect(access(join(root, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    const linked = await directory(), destination = await directory();
    await symlink(destination, join(linked, "desktop.ini"), "junction");
    expect(await new ProjectGitBootstrap(fixtureRunner).ensure(input(linked)))
      .toEqual({ status: "skipped", reason: "non_empty_project" });
    await expect(access(join(linked, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a linked project root before initialization even when its target is empty", async () => {
    const parent = await directory(), target = await directory(), alias = join(parent, "project-alias");
    await symlink(target, alias, "junction");
    await expect(new ProjectGitBootstrap(fixtureRunner).ensure(input(alias))).rejects.toBeInstanceOf(ProjectGitBootstrapIdentityError);
    await expect(access(join(target, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("disables every initialization commit hook and signing without modifying persistent configuration", async () => {
    const root = await directory(), template = await directory();
    await mkdir(join(template, "hooks"));
    await writeFile(join(template, "hooks", "prepare-commit-msg"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
    const templateRunner: GitCommandRunner = {
      run: (cwd, args, options) => fixtureRunner.run(cwd,
        ["-c", "commit.gpgsign=true", ...(args[0] === "init" ? ["init", `--template=${template}`] : args)], options)
    };
    expect(await new ProjectGitBootstrap(templateRunner).ensure(input(root))).toMatchObject({ status: "initialized" });
  });

  it("rejects authority loss before init and keeps a repository when the initial HEAD cannot be created", async () => {
    const root = await directory(); let current = true;
    const invalidatingRunner: GitCommandRunner = {
      run: async (cwd, args, options) => {
        const result = await fixtureRunner.run(cwd, args, options);
        if (args[0] === "--version") current = false;
        return result;
      }
    };
    await expect(new ProjectGitBootstrap(invalidatingRunner).ensure({ workspaceRoot: root,
      assertCurrent: () => { if (!current) throw new Error("Authority retired"); } })).rejects.toThrow("Authority retired");
    await expect(access(join(root, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    const partial = await directory();
    const failingRunner: GitCommandRunner = {
      run: (cwd, args, options) => args.includes("commit")
        ? Promise.reject(new GitCommandError({ exitCode: 1, outputOverflow: false, timedOut: false }))
        : fixtureRunner.run(cwd, args, options)
    };
    expect(await new ProjectGitBootstrap(failingRunner).ensure(input(partial)))
      .toEqual({ status: "failed", reason: "initialization_failed" });
    await expect(access(join(partial, ".git"))).resolves.toBeUndefined();
    await expect(fixtureRunner.run(partial, ["rev-parse", "--verify", "HEAD"])).rejects.toBeInstanceOf(GitCommandError);
  });
});

async function directory(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-project-bootstrap-test-"))); roots.push(root); return root;
}

function input(root: string) { return { workspaceRoot: root, assertCurrent: () => undefined }; }
