import { copyFile, lstat, mkdir, mkdtemp, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DevelopmentTools } from "./tools.js";
import { PersonalDevelopmentError, type DevelopmentChannel, type DevelopmentProgress, type DevelopmentSource } from "./types.js";
import { exists, GIT_IDENTITY, HASH, identity, managedPath, ordinaryDirectory, PERSONAL_BRANCH, removeManaged, SOURCE_REPOSITORY } from "./storage.js";

export function developmentSourceTarget(input: { readonly channel: DevelopmentChannel; readonly version: string }): readonly string[] {
  if (input.channel === "dev") return ["main"];
  if (input.channel !== "beta" && input.channel !== "release") throw new PersonalDevelopmentError("INVALID_ARGUMENT");
  const version = input.version.trim().replace(/^v/iu, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) throw new PersonalDevelopmentError("INVALID_VERSION");
  const stable = `v${version.replace(/-beta(?:\.[0-9A-Za-z.-]+)?$/iu, "")}`;
  return input.channel === "beta" ? [`${stable}-beta`, stable] : [stable, `${stable}-beta`];
}
/** Private Git index snapshots never alter the user's staging area. */
export class DevelopmentRepository {
  readonly source: string;
  constructor(readonly root: string, readonly tools: DevelopmentTools) { this.source = join(root, "source"); }
  git(args: readonly string[], cwd: string, signal: AbortSignal, index?: string, onProgress?: (progress: DevelopmentProgress) => void): Promise<string> {
    return this.tools.run("git", args, cwd, signal, { timeoutMs: 20 * 60_000,
      ...(index ? { environment: { GIT_INDEX_FILE: index } } : {}), ...(onProgress ? { onProgress } : {}) });
  }
  async assertSource(signal: AbortSignal): Promise<void> {
    await ordinaryDirectory(this.source); await ordinaryDirectory(join(this.source, ".git"));
    if (await this.git(["remote", "get-url", "origin"], this.source, signal) !== SOURCE_REPOSITORY
      || await this.git(["branch", "--show-current"], this.source, signal) !== PERSONAL_BRANCH) throw new PersonalDevelopmentError("SOURCE_CHANGED");
  }
  async head(cwd: string, signal: AbortSignal): Promise<string> {
    const value = await this.git(["rev-parse", "HEAD"], cwd, signal); if (!HASH.test(value)) throw new PersonalDevelopmentError("SOURCE_CHANGED"); return value;
  }
  async readRef(ref: "refs/heads/main" | "refs/joko-personal/personal-upstream", signal: AbortSignal): Promise<string | undefined> {
    try { const value = await this.git(["rev-parse", "--verify", `${ref}^{commit}`], this.source, signal); if (!HASH.test(value)) throw new PersonalDevelopmentError("SOURCE_CHANGED"); return value; }
    catch (error) { if (error instanceof PersonalDevelopmentError && error.exitCode === 128) return; throw error; }
  }
  async readSourceStatus(previous: DevelopmentSource, signal: AbortSignal): Promise<DevelopmentSource> {
    if (!await exists(this.source)) return { status: "missing" };
    await this.assertSource(signal);
    const optional = async (args: readonly string[]): Promise<string | undefined> => {
      try { return await this.git(args, this.source, signal); }
      catch (error) { if (signal.aborted || error instanceof PersonalDevelopmentError && error.code === "PROCESS_UNKNOWN") throw error; return; }
    };
    const readCommit = async (ref: string) => { const value = await optional(["rev-parse", "--verify", `${ref}^{commit}`]); return value && HASH.test(value) ? value : undefined; };
    const commit = await this.head(this.source, signal), mainCommit = await readCommit("refs/heads/main"), mainRemoteCommit = await readCommit("refs/remotes/origin/main");
    const baseCommit = await readCommit("refs/joko-personal/personal-upstream")
      ?? (previous.upstreamCommit ? await optional(["merge-base", commit, previous.upstreamCommit]) : undefined);
    const counts = async (left?: string, right?: string) => {
      if (!left || !right) return;
      const value = await optional(["rev-list", "--left-right", "--count", `${left}...${right}`]);
      if (!value || !/^\d+\s+\d+$/u.test(value)) return;
      const result = value.split(/\s/u).filter(Boolean).map(Number);
      return result.every(count => Number.isSafeInteger(count) && count >= 0) ? result : undefined;
    };
    const main = await counts(mainCommit, mainRemoteCommit), personal = await counts(commit, mainCommit);
    return { ...previous, status: "ready", error: undefined, commit, currentBranch: PERSONAL_BRANCH, baseCommit, mainCommit, mainRemoteCommit,
      mainAhead: main?.[0], mainBehind: main?.[1], personalAhead: personal?.[0], personalBehind: personal?.[1], latestVersion: undefined };
  }
  async prepare(input: { readonly channel: DevelopmentChannel; readonly version: string }, signal: AbortSignal,
    progress: (stage: string, details?: DevelopmentProgress) => Promise<void>): Promise<DevelopmentSource> {
    const candidates = developmentSourceTarget(input); await progress("checking-remote");
    const output = await this.git(["ls-remote", "--heads", "--tags", SOURCE_REPOSITORY,
      ...candidates.flatMap(ref => [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`])], this.root, signal);
    const refs = new Set(output.split(/\r?\n/u).map(line => line.split(/\s+/u)[1]?.replace(/\^\{\}$/u, "")));
    const ref = candidates.find(value => refs.has(`refs/heads/${value}`) || refs.has(`refs/tags/${value}`));
    if (!ref) throw new PersonalDevelopmentError("TAG_NOT_FOUND");
    const gitDir = join(this.source, ".git");
    if (await exists(this.source)) {
      await ordinaryDirectory(this.source);
      if (!await exists(gitDir)) throw new PersonalDevelopmentError("SOURCE_CHANGED");
      await ordinaryDirectory(gitDir);
      if (await this.git(["remote", "get-url", "origin"], this.source, signal) !== SOURCE_REPOSITORY) throw new PersonalDevelopmentError("SOURCE_CHANGED");
      const incomplete = !await exists(join(gitDir, "index")) || !await exists(join(this.source, "package.json"));
      if (incomplete) {
        const branches = await this.git(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/stash"], this.source, signal);
        if (await exists(join(gitDir, "worktrees")) || branches !== (ref === "main" ? "refs/heads/main" : "")) throw new PersonalDevelopmentError("SOURCE_CHANGED");
        const baseline = await this.git(["rev-parse", `${ref === "main" ? "origin/main" : `refs/tags/${ref}`}^{commit}`], this.source, signal);
        if (await this.head(this.source, signal) !== baseline) throw new PersonalDevelopmentError("SOURCE_CHANGED");
        await rename(this.source, join(this.root, `source-incomplete-${randomUUID()}`));
      }
    }
    if (!await exists(gitDir)) {
      await progress("cloning");
      await this.git(["-c", "core.autocrlf=false", "clone", "--progress", "--filter=blob:none", "--no-tags", "--branch", ref, SOURCE_REPOSITORY, this.source], this.root, signal, undefined,
        details => { void progress(`cloning:${details.stage}`, details).catch(() => undefined); });
    }
    // Session worktrees share this repository config even when their spawner has a different ambient Git setup.
    await this.git(["config", "--local", "core.autocrlf", "false"], this.source, signal);
    await progress("fetching"); await this.git(["fetch", "--progress", "--tags", "--force", "origin"], this.source, signal, undefined,
      details => { void progress(`fetching:${details.stage}`, details).catch(() => undefined); });
    const currentBranch = await this.git(["branch", "--show-current"], this.source, signal);
    if (currentBranch !== PERSONAL_BRANCH && await this.git(["status", "--porcelain"], this.source, signal)) throw new PersonalDevelopmentError("DIRTY");
    const upstreamCommit = await this.git(["rev-parse", `${ref === "main" ? "origin/main" : `refs/tags/${ref}`}^{commit}`], this.source, signal);
    if (!HASH.test(upstreamCommit)) throw new PersonalDevelopmentError("SOURCE_CHANGED");
    if (!await this.git(["branch", "--list", PERSONAL_BRANCH], this.source, signal)) await this.git(["branch", PERSONAL_BRANCH, upstreamCommit], this.source, signal);
    await this.git(["checkout", PERSONAL_BRANCH], this.source, signal);
    await progress("caching-dependencies");
    await this.tools.run("pnpm", ["fetch", "--frozen-lockfile", "--prefer-offline", "--prod=false", "--ignore-scripts", "--config.node-linker=isolated", "--config.enable-modules-dir=false"], this.source, signal, {
      timeoutMs: 20 * 60_000, onProgress: details => { void progress("caching-dependencies", details).catch(() => undefined); } });
    return this.readSourceStatus({ status: "ready", ...input, ref, upstreamCommit }, signal);
  }
  async clear(signal: AbortSignal): Promise<void> {
    if (!await exists(this.source)) return;
    await this.assertSource(signal);
    if (await exists(join(this.source, ".git", "worktrees"))) {
      const worktrees = await this.git(["worktree", "list", "--porcelain"], this.source, signal);
      if (worktrees.split(/\r?\n/u).filter(line => line.startsWith("worktree ")).length > 1) throw new PersonalDevelopmentError("BUSY");
    }
    signal.throwIfAborted(); await removeManaged(this.root, this.source);
  }
  async snapshot(cwd: string, signal: AbortSignal, ref?: string): Promise<string> {
    if (await this.git(["ls-files", "--unmerged"], cwd, signal)) throw new PersonalDevelopmentError("DIRTY");
    const scratch = await mkdtemp(join(this.root, ".index-")); let unknown = false;
    try {
      const original = await this.git(["rev-parse", "--path-format=absolute", "--git-path", "index"], cwd, signal);
      const index = join(scratch, "index"); await copyFile(original, index);
      await this.git(["add", "--all", "--", "."], cwd, signal, index);
      const tree = await this.git(["write-tree"], cwd, signal, index);
      if (!HASH.test(tree)) throw new PersonalDevelopmentError("SOURCE_CHANGED");
      if (ref) await this.git(["update-ref", ref, tree], cwd, signal); return tree;
    } catch (error) { unknown = error instanceof PersonalDevelopmentError && error.code === "PROCESS_UNKNOWN"; throw error; }
    finally { if (!unknown) await removeManaged(this.root, scratch); }
  }
  async assertNoOperation(cwd: string, signal: AbortSignal, allowMerge = false): Promise<void> {
    for (const name of ["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", ...allowMerge ? [] : ["MERGE_HEAD"]]) {
      const path = await this.git(["rev-parse", "--path-format=absolute", "--git-path", name], cwd, signal);
      if (await exists(path)) throw new PersonalDevelopmentError("DIRTY");
    }
    if (await this.git(["ls-files", "--unmerged"], cwd, signal)) throw new PersonalDevelopmentError("CONFLICT");
  }
  async commit(cwd: string, signal: AbortSignal, message: string, expectedTree?: string, allowMerge = false): Promise<{ readonly commit: string; readonly tree: string }> {
    await this.assertNoOperation(cwd, signal, allowMerge); const tree = await this.snapshot(cwd, signal);
    if (expectedTree !== undefined && tree !== expectedTree) throw new PersonalDevelopmentError("SOURCE_CHANGED");
    const head = await this.head(cwd, signal); const before = await this.git(["rev-parse", "HEAD^{tree}"], cwd, signal);
    const merging = allowMerge && await exists(await this.git(["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"], cwd, signal));
    if (tree !== before || merging) {
      const backup = `refs/joko-personal/history-backups/${randomUUID()}`;
      await this.git(["update-ref", `${backup}/head`, head], cwd, signal);
      await this.git(["update-ref", `${backup}/files`, tree], cwd, signal);
      await this.git(["update-ref", `${backup}/index`, await this.git(["write-tree"], cwd, signal)], cwd, signal);
      await this.git(["diff", "--check", before, tree], cwd, signal);
      await this.git(["add", "--all", "--", "."], cwd, signal);
      if (await this.git(["write-tree"], cwd, signal) !== tree || await this.snapshot(cwd, signal) !== tree) throw new PersonalDevelopmentError("SOURCE_CHANGED");
      await this.git([...GIT_IDENTITY, "commit", "-m", message], cwd, signal);
    }
    const commit = await this.head(cwd, signal);
    if (await this.git(["rev-parse", "HEAD^{tree}"], cwd, signal) !== tree || await this.snapshot(cwd, signal) !== tree) throw new PersonalDevelopmentError("SOURCE_CHANGED");
    return { commit, tree };
  }
  async apply(cwd: string, before: string, after: string, signal: AbortSignal, threeWay = false): Promise<void> {
    if (![before, after].every(value => HASH.test(value))) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    if (before === after) return;
    const scratch = await mkdtemp(join(this.root, ".patch-")); let unknown = false;
    try {
      const patch = join(scratch, "changes.patch");
      await this.git(["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", `--output=${patch}`, before, after, "--"], cwd, signal);
      if ((await stat(patch)).size === 0) return;
      if (threeWay) {
        try { await this.git(["apply", "--reverse", "--check", "--whitespace=nowarn", patch], cwd, signal); return; }
        catch (error) { if (!(error instanceof PersonalDevelopmentError) || error.exitCode !== 1) throw error; }
        await this.git(["apply", "--3way", "--index", "--whitespace=nowarn", patch], cwd, signal);
      } else {
        await this.git(["apply", "--check", "--whitespace=nowarn", patch], cwd, signal);
        await this.git(["apply", "--whitespace=nowarn", patch], cwd, signal);
      }
    } catch (error) { unknown = error instanceof PersonalDevelopmentError && error.code === "PROCESS_UNKNOWN"; throw error; }
    finally { if (!unknown) await removeManaged(this.root, scratch); }
  }
  async candidate(id: string, commit: string, signal: AbortSignal): Promise<string> {
    if (!HASH.test(commit)) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    const parent = join(this.root, "merge-worktrees"); await mkdir(parent, { recursive: true });
    const path = await managedPath(this.root, join(parent, identity(id)), true);
    if (await exists(path)) throw new PersonalDevelopmentError("BUSY");
    await this.git(["worktree", "add", "--detach", path, commit], this.source, signal); await ordinaryDirectory(path); return path;
  }
  async removeCandidate(path: string, signal: AbortSignal): Promise<void> {
    await managedPath(this.root, path);
    await this.git(["worktree", "remove", "--force", path], this.source, signal);
  }
  async assertCandidate(path: string, signal: AbortSignal): Promise<void> {
    await managedPath(this.root, path); await ordinaryDirectory(path);
    const common = resolve(await this.git(["rev-parse", "--path-format=absolute", "--git-common-dir"], path, signal));
    const expected = resolve(this.source, ".git");
    const top = resolve(await this.git(["rev-parse", "--show-toplevel"], path, signal));
    if ((process.platform === "win32" ? common.toLowerCase() !== expected.toLowerCase() : common !== expected)
      || (process.platform === "win32" ? top.toLowerCase() !== path.toLowerCase() : top !== path)) {
      throw new PersonalDevelopmentError("OWNER_CHANGED");
    }
  }
}
