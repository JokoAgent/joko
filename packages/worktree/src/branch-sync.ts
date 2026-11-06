import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { GitCommandError, runGit } from "./git.js";
import { WorktreeServiceError } from "./errors.js";
import { WorktreeOperationControl } from "./operation.js";
import { probeWorktreeCwd } from "./repository.js";
import type { WorktreeCallOptions, WorktreeCwdDetection } from "./types.js";

export interface WorktreeBranchStatus {
  readonly branch: string;
  readonly remoteOnly: boolean;
  readonly remote?: string;
  readonly remoteBranch?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly dirtyFiles: number;
  readonly blocked?: "no-remote" | "missing-remote" | "not-local" | "multiple-checkouts" | "diverged" | "conflict" | "changed";
  readonly revision: string;
}
export interface WorktreeBranchSyncResult {
  readonly status: WorktreeBranchStatus;
  readonly updated: number;
}
interface Inspection {
  readonly detection: WorktreeCwdDetection;
  readonly repositoryIdentity: string;
  readonly status: WorktreeBranchStatus;
  readonly localRef?: string;
  readonly localCommit?: string;
  readonly remoteRef?: string;
  readonly remoteCommit?: string;
  readonly remoteUrls: readonly string[];
  readonly checkout?: string;
}
const mutations = new Set<string>();
const environment = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", LC_ALL: "C" };
const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Read local refs only. Status and task creation never implicitly fetch. */
export async function readWorktreeBranchStatus(cwd: string, sourceRef: string, options?: WorktreeCallOptions): Promise<WorktreeBranchStatus> {
  return (await inspect(cwd, sourceRef, new WorktreeOperationControl(options, 30_000))).status;
}

/** An explicit, source-bound update. Never reset, stash, rebase, force a local
 * ref, or share the task-creation queue. Unknown native outcomes belong to the
 * caller's durable effect receipt and must not be automatically retried. */
export async function syncWorktreeBranch(input: {
  readonly cwd: string;
  readonly sourceRef: string;
  readonly expectedRevision: string;
  readonly assertCurrent: () => void;
}, options?: WorktreeCallOptions): Promise<WorktreeBranchSyncResult> {
  const control = new WorktreeOperationControl(options, 6 * 60_000);
  input.assertCurrent();
  const before = await inspect(input.cwd, input.sourceRef, control);
  input.assertCurrent(); control.check();
  if (before.status.revision !== input.expectedRevision) return changed(before);
  if (before.status.blocked) return { status: before.status, updated: 0 };
  const key = before.detection.gitCommonDirectory;
  if (mutations.has(key)) throw new WorktreeServiceError("SESSION_CONFLICT", "A branch update is already running for this repository.");
  mutations.add(key);
  try {
    // Repeat the complete observation after acquiring the repository lane.
    const locked = await inspect(input.cwd, input.sourceRef, control);
    input.assertCurrent(); control.check();
    if (locked.status.revision !== before.status.revision) return changed(locked);
    const remote = locked.status.remote!, remoteBranch = locked.status.remoteBranch!, remoteRef = locked.remoteRef!;
    try {
      await runGit(["-c", "fetch.unpackLimit=1", "fetch", "--progress", "--no-tags", "--recurse-submodules=no", "--",
        remote, `+refs/heads/${remoteBranch}:${remoteRef}`], locked.detection.repositoryRoot, control,
      { environment, timeoutCapMs: 6 * 60_000, idleTimeoutMs: 60_000 });
    } catch (error) {
      input.assertCurrent();
      if (error instanceof GitCommandError && /could(?:n.t| not) find remote ref/iu.test(error.stderr)) {
        return { status: { ...locked.status, blocked: "missing-remote" }, updated: 0 };
      }
      throw error;
    }
    input.assertCurrent(); control.check();
    const fetched = await inspect(input.cwd, input.sourceRef, control);
    input.assertCurrent(); control.check();
    if (!sameSource(locked, fetched)) return changed(fetched);
    if (fetched.status.blocked) return { status: fetched.status, updated: 0 };
    if (fetched.status.remoteOnly) {
      const updated = await count(fetched.detection.repositoryRoot,
        locked.remoteCommit ? `${locked.remoteCommit}..${fetched.remoteCommit}` : fetched.remoteCommit!, control);
      input.assertCurrent();
      return { status: fetched.status, updated };
    }
    if (!fetched.status.behind) return { status: fetched.status, updated: 0 };
    await git(fetched.detection.repositoryRoot, ["merge-base", "--is-ancestor", fetched.localCommit!, fetched.remoteCommit!], control);
    input.assertCurrent(); control.check();
    const writeObservation = await inspect(input.cwd, input.sourceRef, control);
    input.assertCurrent(); control.check();
    if (writeObservation.status.revision !== fetched.status.revision) return changed(writeObservation);
    try {
      if (fetched.checkout) {
        const head = await optional(fetched.checkout, ["rev-parse", "--verify", "HEAD^{commit}"], control);
        const branch = await optional(fetched.checkout, ["symbolic-ref", "--quiet", "HEAD"], control);
        input.assertCurrent(); control.check();
        if (head !== fetched.localCommit || branch !== fetched.localRef) {
          const current = await inspect(input.cwd, input.sourceRef, control);
          input.assertCurrent();
          return changed(current);
        }
        // Native merge protects tracked, ignored and untracked collisions and
        // retains unrelated local edits. It never creates a merge commit.
        await runGit(["merge", "--ff-only", "--no-autostash", "--no-overwrite-ignore", fetched.remoteCommit!],
          fetched.checkout, control, { environment, timeoutCapMs: 6 * 60_000 });
      } else {
        // Local fetch also refuses a branch checked out by another process
        // at write time. update-ref alone does not supply that protection.
        await runGit(["fetch", "--no-tags", "--recurse-submodules=no", ".", `${fetched.remoteCommit}:` + fetched.localRef],
          fetched.detection.repositoryRoot, control, { environment, timeoutCapMs: 6 * 60_000 });
      }
    } catch (error) {
      input.assertCurrent();
      const refreshed = await inspect(input.cwd, input.sourceRef, control); input.assertCurrent();
      if (refreshed.status.blocked) return { status: refreshed.status, updated: 0 };
      if (error instanceof GitCommandError && /would be overwritten|local changes/iu.test(error.stderr)) {
        return { status: { ...refreshed.status, blocked: "conflict" }, updated: 0 };
      }
      if (refreshed.checkout !== fetched.checkout) return changed(refreshed);
      throw error;
    }
    input.assertCurrent(); control.check();
    const completed = await inspect(input.cwd, input.sourceRef, control); input.assertCurrent();
    if (!sameSource(fetched, completed, true) || completed.localCommit !== fetched.remoteCommit) return changed(completed);
    return { status: completed.status, updated: fetched.status.behind };
  } finally { mutations.delete(key); }
}

async function inspect(cwd: string, sourceRef: string, control: WorktreeOperationControl): Promise<Inspection> {
  if (typeof sourceRef !== "string" || sourceRef.length > 1_024 || !/^refs\/(?:heads|remotes)\//u.test(sourceRef)
    || sourceRef.startsWith("refs/remotes/") && sourceRef.endsWith("/HEAD")
    || sourceRef.includes("\0") || /[\r\n]/u.test(sourceRef)) throw new WorktreeServiceError("INVALID_ARGUMENT", "Select a full local or remote branch ref.");
  const detection = await probeWorktreeCwd(cwd, control), root = detection.repositoryRoot;
  if (detection.isLinkedWorktree) throw new WorktreeServiceError("CWD_IS_WORKTREE", "Select the primary repository for branch updates.");
  const identity = await Promise.all([root, detection.gitCommonDirectory].map(async path => {
    const value = await stat(path, { bigint: true }); return [value.dev.toString(), value.ino.toString(), value.birthtimeNs.toString()];
  }));
  control.check();
  const repositoryIdentity = fingerprint(identity);
  await git(root, ["check-ref-format", sourceRef], control);
  const remotes = (await git(root, ["remote"], control)).split(/\r?\n/u).filter(Boolean);
  const remoteOnly = sourceRef.startsWith("refs/remotes/");
  let remote = remoteOnly ? remotes.filter(name => sourceRef.startsWith(`refs/remotes/${name}/`)).sort((a, b) => b.length - a.length)[0] : "origin";
  let remoteBranch = remoteOnly && remote ? sourceRef.slice(`refs/remotes/${remote}/`.length) : sourceRef.slice("refs/heads/".length);
  const branch = remoteOnly ? sourceRef : sourceRef.slice("refs/heads/".length);
  const localRef = remoteOnly ? undefined : sourceRef;
  const localCommit = localRef ? await optional(root, ["rev-parse", "--verify", `${localRef}^{commit}`], control) : undefined;
  let checkout: string | undefined, dirtyFiles = 0, dirty = "", blocked: WorktreeBranchStatus["blocked"];
  if (!remoteOnly) {
    if (!localCommit) blocked = "not-local";
    const configuredRemote = await optional(root, ["config", "--get", `branch.${branch}.remote`], control);
    const configuredRef = await optional(root, ["config", "--get", `branch.${branch}.merge`], control);
    if (configuredRemote && configuredRef?.startsWith("refs/heads/")) {
      await git(root, ["check-ref-format", configuredRef], control); remote = configuredRemote;
      remoteBranch = configuredRef.slice("refs/heads/".length);
    }
    const worktrees = (await runGit(["worktree", "list", "--porcelain", "-z"], root, control)).stdout;
    const checkouts = worktrees.split("\0\0").flatMap(block => {
      const fields = block.split("\0");
      const path = fields.find(field => field.startsWith("worktree "))?.slice(9);
      return fields.includes(`branch ${localRef}`) && path ? [path] : [];
    });
    if (checkouts.length > 1) blocked = "multiple-checkouts";
    checkout = checkouts[0];
    if (checkout) {
      dirty = (await runGit(["status", "--porcelain", "-z", "--untracked-files=all"], checkout, control)).stdout;
      dirtyFiles = dirtyPaths(dirty).files;
    }
  }
  if (!remote || !remotes.includes(remote)) blocked ??= "no-remote";
  const remoteUrls = remote && remotes.includes(remote)
    ? (await git(root, ["remote", "get-url", "--all", remote], control)).split(/\r?\n/u) : [];
  const remoteRef = remote && remotes.includes(remote) ? `refs/remotes/${remote}/${remoteBranch}` : undefined;
  if (remoteRef && await optional(root, ["symbolic-ref", "--quiet", remoteRef], control)) {
    throw new WorktreeServiceError("REPOSITORY_UNSAFE", "A branch tracking ref must be direct.");
  }
  const remoteCommit = remoteRef ? await optional(root, ["rev-parse", "--verify", `${remoteRef}^{commit}`], control) : undefined;
  let ahead = 0, behind = 0;
  if (!blocked && localCommit && remoteCommit) {
    const counts = (await git(root, ["rev-list", "--left-right", "--count", `${localCommit}...${remoteCommit}`], control)).split(/\s/u).filter(Boolean).map(Number);
    [ahead, behind] = [counts[0]!, counts[1]!];
    if (![ahead, behind].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff)) throw new WorktreeServiceError("GIT_FAILED", "Invalid branch comparison.");
    if (ahead && behind) blocked = "diverged";
    if (!blocked && behind && dirtyFiles) {
      const changes = (await runGit(["diff", "--name-only", "-z", localCommit, remoteCommit], root, control)).stdout.split("\0").filter(Boolean);
      if (dirtyPaths(dirty).paths.some(path => changes.some(other => overlaps(path, other)))) blocked = "conflict";
    }
  }
  const revision = fingerprint([detection.repositoryRoot, detection.gitCommonDirectory, repositoryIdentity, sourceRef, localCommit ?? null,
    remote ?? null, remoteBranch, remoteRef ?? null, remoteCommit ?? null, remoteUrls, checkout ?? null, dirty, blocked ?? null]);
  return { detection, repositoryIdentity, status: { branch, remoteOnly, ...(remote ? { remote } : {}), ...(remoteRef ? { remoteBranch } : {}),
    ahead, behind, dirtyFiles, ...(blocked ? { blocked } : {}), revision }, localRef, localCommit, remoteRef, remoteCommit, remoteUrls, checkout };
}
function sameSource(left: Inspection, right: Inspection, written = false): boolean {
  return left.detection.repositoryRoot === right.detection.repositoryRoot && left.detection.gitCommonDirectory === right.detection.gitCommonDirectory
    && left.repositoryIdentity === right.repositoryIdentity
    && left.localRef === right.localRef && (written || left.localCommit === right.localCommit) && left.remoteRef === right.remoteRef
    && left.status.remote === right.status.remote && left.status.remoteBranch === right.status.remoteBranch
    && JSON.stringify(left.remoteUrls) === JSON.stringify(right.remoteUrls) && left.checkout === right.checkout;
}
function changed(value: Inspection): WorktreeBranchSyncResult { return { status: { ...value.status, blocked: "changed" }, updated: 0 }; }
async function git(cwd: string, args: readonly string[], control: WorktreeOperationControl): Promise<string> {
  return (await runGit(args, cwd, control, { timeoutCapMs: 5_000, environment })).stdout.trim();
}
async function optional(cwd: string, args: readonly string[], control: WorktreeOperationControl): Promise<string | undefined> {
  try { return await git(cwd, args, control); }
  catch (error) { if (error instanceof GitCommandError && error.exitCode !== null) return undefined; throw error; }
}
async function count(cwd: string, range: string, control: WorktreeOperationControl): Promise<number> {
  const value = Number(await git(cwd, ["rev-list", "--count", range], control));
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new WorktreeServiceError("GIT_FAILED", "Invalid updated commit count.");
  return value;
}
function overlaps(left: string, right: string): boolean { return left === right || left.startsWith(right + "/") || right.startsWith(left + "/"); }
function dirtyPaths(porcelain: string): { readonly paths: string[]; readonly files: number } {
  const fields = porcelain.split("\0"), paths: string[] = []; let files = 0;
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]; if (!field) continue;
    files++; paths.push(field.slice(3));
    if (/[RC]/u.test(field.slice(0, 2)) && fields[index + 1]) paths.push(fields[++index]!);
  }
  return { paths, files };
}
