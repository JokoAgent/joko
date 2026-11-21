import { lstat, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { GitCommandError, runGit } from "./git.js";
import { DEFAULT_WORKTREE_OPERATION_TIMEOUT_MS, WorktreeOperationControl } from "./operation.js";

const bundleRef = "refs/joko/task-copy";
// Git interprets /dev/null itself, including when spawned by Node on Windows.
const environment = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0",
  GIT_AUTHOR_NAME: "Joko", GIT_AUTHOR_EMAIL: "copy@joko.invalid", GIT_COMMITTER_NAME: "Joko", GIT_COMMITTER_EMAIL: "copy@joko.invalid" };
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export interface TaskCopyRepository {
  readonly head: string;
  readonly branch: string | null;
  readonly indexTree: string;
  readonly objectFormat: "sha1" | "sha256";
}

interface CopyFence { readonly signal: AbortSignal; readonly assertCurrent: () => void }

/** Export the current HEAD and staged tree through a private Git repository. */
export async function captureTaskCopyRepository(root: string, stage: string, bundle: string, fence: CopyFence): Promise<{
  readonly repository: TaskCopyRepository;
  readonly verifySource: () => Promise<void>;
} | undefined> {
  const control = new WorktreeOperationControl(fence, DEFAULT_WORKTREE_OPERATION_TIMEOUT_MS);
  const marker = await lstat(join(root, ".git")).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  });
  control.check();
  if (!marker) return undefined;
  if (marker.isSymbolicLink() || !marker.isDirectory() && !marker.isFile()) throw new Error("The task repository marker is invalid.");
  const sourceRoot = await git(["rev-parse", "--show-toplevel"], root, control);
  if (relative(root, await realpath(sourceRoot.trim())) !== "") throw new Error("Copy a task from its repository root.");
  const rawFormat = (await git(["rev-parse", "--show-object-format"], root, control)).trim();
  if (rawFormat !== "sha1" && rawFormat !== "sha256") throw new Error("The task repository object format is unsupported.");
  const sourceObjects = await realpath((await git(["rev-parse", "--path-format=absolute", "--git-path", "objects"], root, control)).trim());
  if (!isAbsolute(sourceObjects) || /[\r\n]/u.test(sourceObjects)) throw new Error("The task repository objects cannot be referenced.");

  const read = async () => {
    const head = (await git(["rev-parse", "--verify", "HEAD^{commit}"], root, control)).trim();
    const branch = await git(["symbolic-ref", "-q", "HEAD"], root, control).then(value => value.trim(), (error: unknown) => {
      if (error instanceof GitCommandError && error.exitCode === 1) return null;
      throw error;
    });
    const index = await git(["ls-files", "--stage", "-z"], root, control);
    if (!oid.test(head) || branch !== null && !branch.startsWith("refs/heads/")
      || index.split("\0").some(row => row !== "" && (!/^(?:100644|100755|120000) (?:[a-f0-9]{40}|[a-f0-9]{64}) 0\t[^\0]+$/u.test(row)
        || row.includes("\ufffd")))) throw new Error("The task repository index has an unsupported entry or conflict.");
    return { head, branch, index };
  };
  const captured = await read();
  await git(["init", "--bare", "--template=", `--object-format=${rawFormat}`, stage], root, control);
  await writeFile(join(stage, "objects", "info", "alternates"), sourceObjects + "\n", { flag: "wx", mode: 0o600 });
  await git(["update-index", "-z", "--index-info"], stage, control, captured.index);
  const indexTree = (await git(["write-tree"], stage, control)).trim();
  const indexCommit = (await git(["commit-tree", indexTree, "-p", captured.head, "-m", "Joko task copy"], stage, control)).trim();
  if (!oid.test(indexTree) || !oid.test(indexCommit)) throw new Error("Git could not prepare the task repository.");
  await git(["update-ref", bundleRef, indexCommit], stage, control);
  await git(["bundle", "create", bundle, bundleRef], stage, control);
  const verifySource = async () => {
    const current = await read();
    if (current.head !== captured.head || current.branch !== captured.branch || current.index !== captured.index) {
      throw new Error("The task repository changed during capture.");
    }
  };
  await verifySource();
  return { repository: { head: captured.head, branch: captured.branch, indexTree, objectFormat: rawFormat }, verifySource };
}

/** Restore Git metadata and the staged index in the new copy without running checkout hooks. */
export async function restoreTaskCopyRepository(root: string, bundle: string, repository: TaskCopyRepository, fence: CopyFence): Promise<void> {
  const control = new WorktreeOperationControl(fence, DEFAULT_WORKTREE_OPERATION_TIMEOUT_MS);
  const { head, branch, indexTree, objectFormat } = repository;
  if ((objectFormat !== "sha1" && objectFormat !== "sha256") || !oid.test(head) || !oid.test(indexTree)
    || head.length !== (objectFormat === "sha1" ? 40 : 64) || indexTree.length !== head.length
    || branch !== null && (typeof branch !== "string" || !branch.startsWith("refs/heads/") || branch.length > 1024)) {
    throw new Error("The copied Git metadata is invalid.");
  }
  if (branch !== null) await git(["check-ref-format", branch], root, control);
  await git(["init", "--template=", `--object-format=${objectFormat}`], root, control);
  await git(["-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-write-fetch-head", bundle, `${bundleRef}:${bundleRef}`], root, control);
  const trees = (await git(["rev-parse", `${bundleRef}^`, `${bundleRef}^{tree}`], root, control)).trim().split(/\r?\n/u);
  if (trees.length !== 2 || trees[0] !== head || trees[1] !== indexTree) throw new Error("The copied Git bundle differs from its manifest.");
  if (branch === null) await git(["update-ref", "--no-deref", "HEAD", head], root, control);
  else {
    await git(["update-ref", branch, head], root, control);
    await git(["symbolic-ref", "HEAD", branch], root, control);
  }
  await git(["read-tree", indexTree], root, control);
  await git(["update-ref", "-d", bundleRef], root, control);
}

async function git(args: readonly string[], cwd: string, control: WorktreeOperationControl, input?: string): Promise<string> {
  const result = await runGit(["-c", "core.hooksPath=", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", ...args],
    cwd, control, { environment, ...(input === undefined ? {} : { input }) });
  return result.stdout;
}
