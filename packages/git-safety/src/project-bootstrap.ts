import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { detectRepositoryRoot, GitCommandError, type GitCommandRunner } from "./git-command.js";
import { enqueueRepositoryWrite } from "./repository-queue.js";

const EMPTY_METADATA_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

export interface ProjectGitBootstrapInput {
  readonly workspaceRoot: string;
  /** The caller owns project admission; paths alone never authorize initialization. */
  readonly assertCurrent: () => void;
}

export type ProjectGitBootstrapResult =
  | { readonly status: "initialized"; readonly repositoryRoot: string; readonly commit: string }
  | { readonly status: "already_git"; readonly repositoryRoot: string }
  | { readonly status: "skipped"; readonly reason: "git_unavailable" | "non_empty_project" }
  | { readonly status: "failed"; readonly reason: "initialization_failed" };

export class ProjectGitBootstrapIdentityError extends Error {
  constructor() {
    super("Project Git initialization directory identity changed.");
    this.name = "ProjectGitBootstrapIdentityError";
  }
}

/** Bootstrap an admitted local project, leaving existing repositories and non-empty folders alone. */
export class ProjectGitBootstrap {
  constructor(readonly runner: GitCommandRunner) {}

  async ensure(input: ProjectGitBootstrapInput): Promise<ProjectGitBootstrapResult> {
    input.assertCurrent();
    try {
      const root = resolve(input.workspaceRoot);
      const canonical = await realpath(root);
      input.assertCurrent();
      const identity = await lstat(root);
      input.assertCurrent();
      if (!samePath(root, canonical) || !identity.isDirectory() || identity.isSymbolicLink()) {
        throw new ProjectGitBootstrapIdentityError();
      }
      return await enqueueRepositoryWrite<ProjectGitBootstrapResult>(canonical, async () => {
        const assertDirectory = async (): Promise<void> => {
          input.assertCurrent();
          const current = await lstat(root);
          input.assertCurrent();
          const currentCanonical = await realpath(root);
          input.assertCurrent();
          if (!current.isDirectory() || current.isSymbolicLink() ||
              current.dev !== identity.dev || current.ino !== identity.ino || !samePath(canonical, currentCanonical)) {
            throw new ProjectGitBootstrapIdentityError();
          }
        };
        await assertDirectory();
        try { await this.runner.run(canonical, ["--version"]); }
        catch (error) {
          if (!(error instanceof GitCommandError)) throw error;
          return { status: "skipped", reason: "git_unavailable" };
        }
        input.assertCurrent();
        const existing = await detectRepositoryRoot(canonical, this.runner);
        input.assertCurrent();
        if (existing !== null) return { status: "already_git", repositoryRoot: existing };
        if (!(await effectivelyEmpty(canonical, input.assertCurrent))) {
          return { status: "skipped", reason: "non_empty_project" };
        }
        await assertDirectory();
        await this.runner.run(canonical, ["init"]);
        await assertDirectory();
        const gitDirectory = await lstat(join(canonical, ".git"));
        input.assertCurrent();
        if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink() ||
            !(await effectivelyEmpty(canonical, input.assertCurrent, true))) {
          throw new ProjectGitBootstrapIdentityError();
        }
        const detected = await detectRepositoryRoot(canonical, this.runner);
        input.assertCurrent();
        if (detected === null || !samePath(detected, canonical)) throw new ProjectGitBootstrapIdentityError();
        let headExists = false;
        try { await this.runner.run(canonical, ["rev-parse", "--verify", "HEAD"]); headExists = true; }
        catch (error) {
          if (!(error instanceof GitCommandError) || error.timedOut || error.outputOverflow ||
              (error.exitCode !== 1 && error.exitCode !== 128)) throw error;
        }
        input.assertCurrent();
        if (headExists) throw new Error("Initialized repository already has a HEAD.");
        const temporaryRoot = await mkdtemp(join(tmpdir(), "joko-project-git-"));
        try {
          const hooks = join(temporaryRoot, "hooks");
          await mkdir(hooks, { mode: 0o700 });
          const environment = { GIT_INDEX_FILE: join(temporaryRoot, "index") };
          const isolation = ["-c", `core.hooksPath=${hooks.replaceAll("\\", "/")}`,
            "-c", "core.fsmonitor=", "-c", "core.useBuiltinFSMonitor=false", "-c", "commit.gpgsign=false"];
          await assertDirectory();
          await this.runner.run(canonical, [...isolation, "read-tree", "--empty"], { environment });
          await assertDirectory();
          await this.runner.run(canonical, [...isolation, "commit", "--no-gpg-sign", "--allow-empty", "-m", "Initialize project snapshot"], { environment });
          await assertDirectory();
          const commit = (await this.runner.run(canonical, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
          input.assertCurrent();
          if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error("Initialized repository has an invalid HEAD.");
          return { status: "initialized", repositoryRoot: canonical, commit };
        } finally {
          await rm(temporaryRoot, { recursive: true, force: true });
        }
      });
    } catch (error) {
      // Initialization is best effort. Any partially created repository stays in place.
      input.assertCurrent();
      if (error instanceof ProjectGitBootstrapIdentityError) throw error;
      return { status: "failed", reason: "initialization_failed" };
    }
  }
}

async function effectivelyEmpty(root: string, assertCurrent: () => void, initialized = false): Promise<boolean> {
  const before = await lstat(root);
  assertCurrent();
  if (!before.isDirectory() || before.isSymbolicLink() || !samePath(await realpath(root), resolve(root))) return false;
  assertCurrent();
  const entries = await readdir(root, { withFileTypes: true });
  assertCurrent();
  for (const entry of entries) {
    if (initialized && entry.name === ".git") continue;
    const path = join(root, entry.name);
    const information = await lstat(path);
    assertCurrent();
    if (information.isSymbolicLink()) return false;
    if (information.isFile() && EMPTY_METADATA_FILES.has(entry.name)) continue;
    if (!information.isDirectory() || !(await effectivelyEmpty(path, assertCurrent))) return false;
  }
  const after = await lstat(root);
  assertCurrent();
  return after.isDirectory() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino &&
    samePath(await realpath(root), resolve(root));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US") : left === right;
}
