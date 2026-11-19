import { isAbsolute, resolve } from "node:path";

import { WorktreeServiceError, isWorktreeServiceError } from "./errors.js";
import { GitCommandError, runGit } from "./git.js";
import { WorktreeOperationControl } from "./operation.js";
import { pathInside, samePath, validateOrdinaryDirectory } from "./state.js";
import {
  MAXIMUM_WORKTREE_SOURCE_REF_CHARACTERS,
  type WorktreeCwdDetection,
  type WorktreeSourceOption,
  type WorktreeSourceResolution
} from "./types.js";

const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/u;
const REMOTE_REFRESH_STEP_MS = 15_000;
const REMOTE_QUERY_STEP_MS = 10_000;
const REMOTE_REF_PREFIX = "refs/remotes/";

export async function probeWorktreeCwd(
  cwdInput: string,
  control: WorktreeOperationControl
): Promise<WorktreeCwdDetection> {
  const cwd = validateCwdInput(cwdInput);
  control.check();
  await validateOrdinaryDirectory(cwd, "CWD_UNSAFE", "The requested working directory is unsafe.");
  await runGit(["--version"], undefined, control);

  let repositoryRootRaw: string;
  try {
    repositoryRootRaw = (await runGit(["rev-parse", "--show-toplevel"], cwd, control)).stdout.trim();
  } catch (error) {
    if (error instanceof GitCommandError) {
      throw new WorktreeServiceError("NOT_GIT_REPOSITORY", "The requested working directory is not a Git repository.");
    }
    throw error;
  }
  if (repositoryRootRaw === "") {
    throw new WorktreeServiceError("NOT_GIT_REPOSITORY", "The requested working directory is not a Git repository.");
  }
  const repositoryRoot = await validateOrdinaryDirectory(
    resolve(cwd, repositoryRootRaw),
    "REPOSITORY_UNSAFE",
    "The repository root is unsafe."
  );
  if (!samePath(cwd, repositoryRoot) && !pathInside(repositoryRoot, cwd)) {
    throw new WorktreeServiceError("REPOSITORY_UNSAFE", "The working directory escaped its repository root.");
  }

  const [gitDirectoryRaw, commonDirectoryRaw, headCommitRaw] = await Promise.all([
    runGit(["rev-parse", "--git-dir"], cwd, control),
    runGit(["rev-parse", "--git-common-dir"], cwd, control),
    runGit(["rev-parse", "--verify", "HEAD^{commit}"], cwd, control)
  ]);
  const gitDirectory = await canonicalGitDirectory(cwd, gitDirectoryRaw.stdout.trim());
  const gitCommonDirectory = await canonicalGitDirectory(cwd, commonDirectoryRaw.stdout.trim());
  const headCommit = headCommitRaw.stdout.trim().toLowerCase();
  if (!COMMIT_PATTERN.test(headCommit)) {
    throw new WorktreeServiceError("SOURCE_NOT_FOUND", "The repository has no usable HEAD commit.");
  }
  const currentBranch = await optionalGit(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd, control);
  return Object.freeze({
    cwd,
    repositoryRoot,
    gitCommonDirectory,
    ...(currentBranch === null || currentBranch === "" ? {} : { currentBranch }),
    headCommit,
    isLinkedWorktree: !samePath(gitDirectory, gitCommonDirectory)
  });
}

export async function resolveWorktreeSource(
  detection: WorktreeCwdDetection,
  sourceRef: string | undefined,
  refreshRemote: boolean,
  control: WorktreeOperationControl
): Promise<WorktreeSourceResolution> {
  if (sourceRef !== undefined) {
    const accepted = validateSourceRef(sourceRef);
    const root = detection.repositoryRoot;
    const commit = await resolveCommit(root, accepted, control);
    if (commit === null) {
      throw new WorktreeServiceError("SOURCE_NOT_FOUND", "The requested source ref does not resolve to a commit.");
    }
    if (refreshRemote && accepted.startsWith(REMOTE_REF_PREFIX) && !accepted.endsWith("/HEAD")
      && await optionalGit(["check-ref-format", accepted], root, control) !== null) {
      return refreshSelectedRemoteSource(root, accepted, control);
    }
    return Object.freeze({ ref: accepted, commit, refreshed: false, strategy: "explicit" });
  }

  const remotes = await listRemotes(detection.repositoryRoot, control);
  const orderedRemotes = ["upstream", "origin", ...remotes]
    .filter((value, index, values) => remotes.includes(value) && values.indexOf(value) === index);
  let remoteFailureReason: string | undefined;

  if (refreshRemote) {
    for (const remote of orderedRemotes) {
      try {
        const response = await runGit(
          ["ls-remote", "--symref", remote, "HEAD"],
          detection.repositoryRoot,
          control,
          {
            timeoutCapMs: REMOTE_QUERY_STEP_MS,
            environment: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" }
          }
        );
        const branch = response.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/mu)?.[1];
        if (branch === undefined) continue;
        await runGit(
          [
            "fetch",
            "--quiet",
            remote,
            `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`
          ],
          detection.repositoryRoot,
          control,
          {
            timeoutCapMs: REMOTE_REFRESH_STEP_MS,
            environment: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" }
          }
        );
        const ref = `refs/remotes/${remote}/${branch}`;
        const commit = await resolveCommit(detection.repositoryRoot, ref, control);
        if (commit !== null) {
          return Object.freeze({
            ref,
            commit,
            refreshed: true,
            strategy: "remote_default_refreshed",
            remote
          });
        }
      } catch (error) {
        if (isAbortOrDisposed(error)) throw error;
        // A remote step has a tighter cap than the whole operation. Preserve
        // best-effort behavior while still honoring the caller's deadline.
        control.check();
        remoteFailureReason = "remote_refresh_failed";
      }
    }
  }

  for (const remote of orderedRemotes) {
    const short = await optionalGit(
      ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
      detection.repositoryRoot,
      control
    );
    if (short === null || short === "") continue;
    const branch = short.startsWith(`${remote}/`) ? short.slice(remote.length + 1) : short;
    const ref = `refs/remotes/${remote}/${branch}`;
    const commit = await resolveCommit(detection.repositoryRoot, ref, control);
    if (commit !== null) {
      return Object.freeze({
        ref,
        commit,
        refreshed: false,
        strategy: "remote_default_local",
        remote,
        ...(remoteFailureReason === undefined ? {} : { reason: remoteFailureReason })
      });
    }
  }

  if (detection.currentBranch !== undefined) {
    const ref = `refs/heads/${detection.currentBranch}`;
    const commit = await resolveCommit(detection.repositoryRoot, ref, control);
    if (commit !== null) {
      return Object.freeze({
        ref,
        commit,
        refreshed: false,
        strategy: "current_branch",
        ...(remoteFailureReason === undefined ? {} : { reason: remoteFailureReason })
      });
    }
  }

  for (const branch of ["main", "master"]) {
    const ref = `refs/heads/${branch}`;
    const commit = await resolveCommit(detection.repositoryRoot, ref, control);
    if (commit !== null) {
      return Object.freeze({
        ref,
        commit,
        refreshed: false,
        strategy: "local_default",
        ...(remoteFailureReason === undefined ? {} : { reason: remoteFailureReason })
      });
    }
  }

  return Object.freeze({
    ref: "HEAD",
    commit: detection.headCommit,
    refreshed: false,
    strategy: "head",
    ...(remoteFailureReason === undefined ? {} : { reason: remoteFailureReason })
  });
}

async function refreshSelectedRemoteSource(root: string, ref: string, control: WorktreeOperationControl): Promise<WorktreeSourceResolution> {
  if (await optionalGit(["show-ref", "--verify", "--hash", ref], root, control) === null) {
    throw new WorktreeServiceError("SOURCE_NOT_FOUND", "The selected tracking ref no longer exists.");
  }
  if (await optionalGit(["symbolic-ref", "--quiet", ref], root, control) !== null) {
    throw new WorktreeServiceError("REPOSITORY_UNSAFE", "A branch tracking ref must be direct.");
  }
  const remotes = (await runGit(["remote"], root, control)).stdout.trim().split(/\r?\n/u);
  const remote = remotes.filter(name => name && ref.startsWith(`${REMOTE_REF_PREFIX}${name}/`))
    .sort((left, right) => right.length - left.length)[0];
  if (!remote) throw new WorktreeServiceError("SOURCE_NOT_FOUND", "The selected branch has no configured remote.");
  const configured = await optionalGit(["config", "--null", "--get-all", `remote.${remote}.fetch`], root, control);
  const refspecs = configured?.split("\0") ?? [];
  const sources = new Set<string>();
  for (const spec of refspecs) {
    const [source, destination] = spec.replace(/^\+/u, "").split(":");
    if (!source?.startsWith("refs/heads/") || !destination) continue;
    const capture = matchRefspec(destination, ref);
    if (capture === undefined) continue;
    const candidate = source.replace("*", () => capture);
    if (!refspecs.some(other => other.startsWith("^") && matchRefspec(other.slice(1), candidate) !== undefined)) {
      sources.add(candidate);
    }
  }
  if (sources.size !== 1) throw new WorktreeServiceError("SOURCE_NOT_FOUND", "The selected tracking ref has no unique configured source branch.");
  const [source] = sources;
  await runGit(["check-ref-format", source!], root, control);
  // A selected source refresh owns just this tracking ref, even when the
  // configured remote would also update or prune other refs.
  await runGit(["fetch", "--quiet", "--no-tags", "--no-prune", "--no-prune-tags", "--recurse-submodules=no",
    "--no-write-fetch-head", "--refmap=", "--", remote, `+${source}:${ref}`], root, control,
  { timeoutCapMs: REMOTE_REFRESH_STEP_MS, environment: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" } });
  const commit = await resolveCommit(root, ref, control);
  if (commit === null) throw new WorktreeServiceError("SOURCE_NOT_FOUND", "The refreshed tracking ref does not resolve to a commit.");
  return Object.freeze({ ref, commit, refreshed: true, strategy: "explicit", remote });
}

function matchRefspec(pattern: string, ref: string): string | undefined {
  const wildcard = pattern.indexOf("*");
  if (wildcard < 0) return pattern === ref ? "" : undefined;
  const prefix = pattern.slice(0, wildcard), suffix = pattern.slice(wildcard + 1);
  if (ref.length < prefix.length + suffix.length || !ref.startsWith(prefix) || !ref.endsWith(suffix)) return undefined;
  return ref.slice(prefix.length, ref.length - suffix.length);
}

export async function listWorktreeSources(
  detection: WorktreeCwdDetection,
  control: WorktreeOperationControl
): Promise<readonly WorktreeSourceOption[]> {
  const output = await runGit(
    ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/remotes"],
    detection.repositoryRoot,
    control
  );
  const values: WorktreeSourceOption[] = [];
  const seen = new Set<string>();
  for (const line of output.stdout.split(/\r?\n/u)) {
    const separator = line.indexOf("\0");
    if (separator <= 0) continue;
    const ref = line.slice(0, separator);
    const commit = line.slice(separator + 1).trim().toLowerCase();
    if (!COMMIT_PATTERN.test(commit) || seen.has(ref)) continue;
    let kind: WorktreeSourceOption["kind"];
    let name: string;
    if (ref.startsWith("refs/heads/")) {
      kind = "local";
      name = ref.slice("refs/heads/".length);
    } else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) {
      kind = "remote";
      name = ref.slice("refs/remotes/".length);
    } else {
      continue;
    }
    if (name.length === 0 || name.length > MAXIMUM_WORKTREE_SOURCE_REF_CHARACTERS) continue;
    seen.add(ref);
    values.push(Object.freeze({
      ref,
      commit,
      name,
      kind,
      current: kind === "local" && detection.currentBranch === name
    }));
  }
  values.sort((left, right) => Number(right.current) - Number(left.current)
    || (left.kind === right.kind ? 0 : left.kind === "local" ? -1 : 1)
    || left.name.localeCompare(right.name));
  return Object.freeze(values);
}

export async function isWorktreeCompletelyClean(
  path: string,
  control: WorktreeOperationControl
): Promise<boolean> {
  if (await hasUnsafeTrackedIndexFlags(path, control)) return false;
  const status = await runGit(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    path,
    control
  );
  if (status.stdout.trim() !== "") return false;
  const ignoredAndUntracked = await runGit(["clean", "-ndx"], path, control);
  return ignoredAndUntracked.stdout.trim() === "";
}

/** Git intentionally hides worktree changes behind skip-worktree and
 * assume-unchanged bits. Until those entries can be snapshotted without
 * disturbing a sparse index, removal must conservatively fail closed. */
export async function hasUnsafeTrackedIndexFlags(
  path: string,
  control: WorktreeOperationControl
): Promise<boolean> {
  const listing = await runGit(["ls-files", "-v", "-z"], path, control);
  for (const record of listing.stdout.split("\0")) {
    if (record.length < 3 || record[1] !== " ") continue;
    const tag = record[0]!;
    if (tag === "S" || tag !== tag.toUpperCase()) return true;
  }
  return false;
}

export async function attachedWorktreeBranch(
  path: string,
  control: WorktreeOperationControl
): Promise<string | undefined> {
  return (await optionalGit(["symbolic-ref", "--quiet", "--short", "HEAD"], path, control)) ?? undefined;
}

export async function worktreeHeadCommit(
  path: string,
  control: WorktreeOperationControl
): Promise<string | undefined> {
  const output = await optionalGit(["rev-parse", "--verify", "HEAD^{commit}"], path, control);
  if (output === null) return undefined;
  const commit = output.trim().toLowerCase();
  return COMMIT_PATTERN.test(commit) ? commit : undefined;
}

export async function branchExists(
  repositoryRoot: string,
  branch: string,
  control: WorktreeOperationControl
): Promise<boolean> {
  return (await optionalGit(
    ["show-ref", "--verify", "--hash", `refs/heads/${branch}`],
    repositoryRoot,
    control
  )) !== null;
}

async function canonicalGitDirectory(cwd: string, value: string): Promise<string> {
  if (value === "") throw new WorktreeServiceError("REPOSITORY_UNSAFE", "Git returned an invalid metadata directory.");
  const candidate = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  return validateOrdinaryDirectory(candidate, "REPOSITORY_UNSAFE", "The Git metadata directory is unsafe.");
}

async function listRemotes(repositoryRoot: string, control: WorktreeOperationControl): Promise<readonly string[]> {
  const value = await optionalGit(["remote"], repositoryRoot, control);
  if (value === null) return [];
  return value.split(/\r?\n/u)
    .map((item) => item.trim())
    .filter((item) => /^[A-Za-z0-9._-]{1,128}$/u.test(item));
}

async function resolveCommit(
  repositoryRoot: string,
  ref: string,
  control: WorktreeOperationControl
): Promise<string | null> {
  const output = await optionalGit(["rev-parse", "--verify", `${ref}^{commit}`], repositoryRoot, control);
  if (output === null) return null;
  const commit = output.trim().toLowerCase();
  return COMMIT_PATTERN.test(commit) ? commit : null;
}

async function optionalGit(
  args: readonly string[],
  cwd: string,
  control: WorktreeOperationControl
): Promise<string | null> {
  try {
    return (await runGit(args, cwd, control)).stdout.trim();
  } catch (error) {
    if (error instanceof GitCommandError) return null;
    throw error;
  }
}

function validateCwdInput(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 32_768
    || value.includes("\0") || !isAbsolute(value)) {
    throw new WorktreeServiceError("INVALID_ARGUMENT", "cwd must be an absolute bounded path.", { field: "cwd" });
  }
  return resolve(value);
}

function validateSourceRef(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0
    || value.length > MAXIMUM_WORKTREE_SOURCE_REF_CHARACTERS || value.includes("\0")
    || value.startsWith("-") || /[\r\n]/u.test(value)) {
    throw new WorktreeServiceError("INVALID_ARGUMENT", "sourceRef is invalid.", { field: "sourceRef" });
  }
  return value;
}

function isAbortOrDisposed(error: unknown): boolean {
  return isWorktreeServiceError(error)
    && (error.code === "ABORTED" || error.code === "DISPOSED");
}
