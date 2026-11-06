import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { readWorktreeBranchStatus, syncWorktreeBranch } from "./branch-sync.js";
import { runGit } from "./git.js";
import { WorktreeOperationControl } from "./operation.js";

const execute = promisify(execFile), roots: string[] = [];
const git = async (cwd: string, ...args: string[]) => (await execute("git", args, { cwd, windowsHide: true,
  env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" } })).stdout.trim();
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-branch-sync-")); roots.push(root);
  const remote = join(root, "remote.git"), seed = join(root, "seed"), local = join(root, "local"), checkout = join(root, "linked");
  await git(root, "init", "--bare", remote); await git(root, "clone", remote, seed);
  await git(seed, "config", "user.email", "branch@example.test"); await git(seed, "config", "user.name", "Branch test");
  await git(seed, "checkout", "-b", "main"); await writeFile(join(seed, "tracked.txt"), "initial\n");
  await writeFile(join(seed, "other.txt"), "keep\n"); await git(seed, "add", "."); await git(seed, "commit", "-m", "initial");
  await git(seed, "push", "-u", "origin", "main"); await git(root, "clone", "--branch", "main", remote, local);
  await git(local, "config", "user.email", "branch@example.test"); await git(local, "config", "user.name", "Branch test");
  const original = await git(local, "rev-parse", "HEAD");
  const advance = async (name = "tracked.txt", content = "advanced\n") => {
    await writeFile(join(seed, name), content); await git(seed, "add", "."); await git(seed, "commit", "-m", "advance " + name);
    await git(seed, "push", "origin", "main"); return git(seed, "rev-parse", "HEAD");
  };
  const sync = async (ref = "refs/heads/main", assertCurrent = () => {}) => {
    const status = await readWorktreeBranchStatus(local, ref);
    return syncWorktreeBranch({ cwd: local, sourceRef: ref, expectedRevision: status.revision, assertCurrent });
  };
  return { root, remote, seed, local, checkout, original, advance, sync };
}

it("reads without fetching, then fast-forwards a checked-out branch and preserves unrelated dirty files", { timeout: 40_000 }, async () => {
  const f = await fixture(), next = await f.advance();
  await git(f.local, "tag", "main", f.original);
  await writeFile(join(f.local, "other.txt"), "local edits\n");
  const status = await readWorktreeBranchStatus(f.local, "refs/heads/main");
  expect(status).toMatchObject({ ahead: 0, behind: 0, dirtyFiles: 1, remote: "origin", remoteBranch: "main" });
  expect(await git(f.local, "rev-parse", "origin/main")).toBe(f.original);
  expect(await f.sync()).toMatchObject({ updated: 1, status: { ahead: 0, behind: 0, dirtyFiles: 1 } });
  expect(await git(f.local, "rev-parse", "HEAD")).toBe(next);
  expect(await git(f.local, "rev-parse", "refs/tags/main")).toBe(f.original);
  expect(await readFile(join(f.local, "other.txt"), "utf8")).toBe("local edits\n");
  expect(await readFile(join(f.local, "tracked.txt"), "utf8")).toMatch(/^advanced\r?\n$/u);
});
it("updates an unchecked local branch and a remote-only ref without switching the current checkout", { timeout: 40_000 }, async () => {
  const f = await fixture(); await git(f.local, "checkout", "-b", "work");
  const first = await f.advance(); expect((await f.sync()).updated).toBe(1);
  expect(await git(f.local, "rev-parse", "main")).toBe(first); expect(await git(f.local, "rev-parse", "HEAD")).toBe(f.original);
  const second = await f.advance("tracked.txt", "second\n");
  expect(await f.sync("refs/remotes/origin/main")).toMatchObject({ updated: 1, status: { remoteOnly: true } });
  expect(await git(f.local, "rev-parse", "origin/main")).toBe(second); expect(await git(f.local, "rev-parse", "main")).toBe(first);
});
it("uses the configured upstream and refuses divergence, overlap and changed observations", { timeout: 40_000 }, async () => {
  const f = await fixture(), status = await readWorktreeBranchStatus(f.local, "refs/heads/main");
  await git(f.local, "remote", "rename", "origin", "upstream");
  expect(await syncWorktreeBranch({ cwd: f.local, sourceRef: "refs/heads/main", expectedRevision: status.revision, assertCurrent() {} }))
    .toMatchObject({ updated: 0, status: { blocked: "changed" } });
  expect((await readWorktreeBranchStatus(f.local, "refs/heads/main")).remote).toBe("upstream");
  const remote = await f.advance(); await writeFile(join(f.local, "tracked.txt"), "owner edits\n");
  expect(await f.sync()).toMatchObject({ updated: 0, status: { blocked: "conflict" } });
  expect(await git(f.local, "rev-parse", "HEAD")).toBe(f.original); expect(await git(f.local, "rev-parse", "upstream/main")).toBe(remote);
  expect(await readFile(join(f.local, "tracked.txt"), "utf8")).toBe("owner edits\n");
  await git(f.local, "add", "tracked.txt"); await git(f.local, "commit", "-m", "owner edit");
  const own = await git(f.local, "rev-parse", "HEAD");
  expect(await f.sync()).toMatchObject({ updated: 0, status: { blocked: "diverged", ahead: 1, behind: 1 } });
  expect(await git(f.local, "rev-parse", "HEAD")).toBe(own);
});
it("updates another worktree in place, blocks ignored-file collisions, and rejects missing or malformed sources", { timeout: 40_000 }, async () => {
  const f = await fixture(); await git(f.local, "checkout", "-b", "work"); await git(f.local, "worktree", "add", f.checkout, "main");
  const next = await f.advance(); expect((await f.sync()).updated).toBe(1);
  expect(await git(f.checkout, "rev-parse", "HEAD")).toBe(next); expect(await git(f.local, "rev-parse", "HEAD")).toBe(f.original);
  await writeFile(join(f.checkout, ".gitignore"), "protected.txt\n"); await writeFile(join(f.checkout, "protected.txt"), "keep ignored\n");
  await f.advance("protected.txt", "remote content\n");
  expect(await f.sync()).toMatchObject({ updated: 0, status: { blocked: "conflict" } });
  expect(await readFile(join(f.checkout, "protected.txt"), "utf8")).toBe("keep ignored\n");
  expect((await readWorktreeBranchStatus(f.local, "refs/heads/missing")).blocked).toBe("not-local");
  for (const sourceRef of ["--upload-pack=anything", "refs/remotes/upstream/HEAD", "refs/heads/main\nnext"]) {
    await expect(readWorktreeBranchStatus(f.local, sourceRef)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  }
  await git(f.local, "config", "branch.work.remote", "origin"); await git(f.local, "config", "branch.work.merge", "refs/heads/deleted");
  expect(await f.sync("refs/heads/work")).toMatchObject({ updated: 0, status: { blocked: "missing-remote" } });
});
it("fences revocation and a changed remote configuration after the fetch before any local branch write", { timeout: 40_000 }, async () => {
  const f = await fixture(), next = await f.advance(); let revoked = false;
  const observedFetch = () => execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], { cwd: f.local, windowsHide: true, encoding: "utf8" }).trim() === next;
  await expect(f.sync("refs/heads/main", () => { if (observedFetch()) { revoked = true; throw new Error("Revoked original authority"); } }))
    .rejects.toThrow("Revoked original authority");
  expect(revoked).toBe(true); expect(await git(f.local, "rev-parse", "HEAD")).toBe(f.original);
  await git(f.local, "update-ref", "refs/remotes/origin/main", f.original);
  let changed = false;
  const result = await f.sync("refs/heads/main", () => {
    if (!changed && observedFetch()) { changed = true; execFileSync("git", ["remote", "set-url", "origin", join(f.root, "replacement.git")], { cwd: f.local, windowsHide: true }); }
  });
  expect(result).toMatchObject({ updated: 0, status: { blocked: "changed" } });
  expect(await git(f.local, "rev-parse", "HEAD")).toBe(f.original);
});
it("reports missing remotes and duplicate branch checkouts without fetching or choosing one checkout", { timeout: 40_000 }, async () => {
  const f = await fixture(); await git(f.local, "remote", "remove", "origin");
  expect(await f.sync()).toMatchObject({ updated: 0, status: { blocked: "no-remote" } });
  await git(f.local, "worktree", "add", "--force", f.checkout, "main");
  expect(await f.sync()).toMatchObject({ updated: 0, status: { blocked: "multiple-checkouts" } });
  expect(await git(f.local, "rev-parse", "HEAD")).toBe(f.original); expect(await git(f.checkout, "rev-parse", "HEAD")).toBe(f.original);
});
it("leaves both branches at their original commits when the checkout switches after the final status read", { timeout: 40_000 }, async () => {
  const f = await fixture();
  await git(f.local, "branch", "other-branch", f.original);
  const next = await f.advance();
  let fetchedChecks = 0;
  const result = await f.sync("refs/heads/main", () => {
    const observed = execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], { cwd: f.local, windowsHide: true, encoding: "utf8" }).trim();
    // Fetch, fetched observation, ancestry, then the final full status read.
    if (observed === next && ++fetchedChecks === 4) {
      execFileSync("git", ["checkout", "other-branch"], { cwd: f.local, windowsHide: true, stdio: "ignore" });
    }
  });
  expect(result).toMatchObject({ updated: 0, status: { blocked: "changed" } });
  expect(await git(f.local, "symbolic-ref", "HEAD")).toBe("refs/heads/other-branch");
  expect((await git(f.local, "rev-parse", "refs/heads/main", "refs/heads/other-branch")).split(/\r?\n/u)).toEqual([f.original, f.original]);
  expect(await readFile(join(f.local, "tracked.txt"), "utf8")).toMatch(/^initial\r?\n$/u);
});
it("allows continuing Git progress within its operation deadline and retires a stalled child", { timeout: 40_000 }, async () => {
  const f = await fixture(), progress = join(f.root, "progress.cjs"), stalled = join(f.root, "stalled.cjs");
  await writeFile(progress, "process.stdout.write('started\\n'); let count=0; const timer=setInterval(()=>{process.stdout.write('progress\\n');if(++count===6){clearInterval(timer);process.stdout.write('complete\\n');}},500);\n");
  await writeFile(stalled, "setTimeout(()=>{},20000);\n");
  const command = (path: string) => "!node '" + path.replaceAll("\\", "/").replaceAll("'", "'\"'\"'") + "'";
  const result = await runGit(["-c", `alias.joko-progress=${command(progress)}`, "joko-progress"], f.local,
    new WorktreeOperationControl({ timeoutMs: 15_000 }, 15_000), { idleTimeoutMs: 2_000, timeoutCapMs: 15_000 });
  expect(result.stdout).toContain("complete");
  await expect(runGit(["-c", `alias.joko-stalled=${command(stalled)}`, "joko-stalled"], f.local,
    new WorktreeOperationControl({ timeoutMs: 15_000 }, 15_000), { idleTimeoutMs: 500, timeoutCapMs: 15_000 }))
    .rejects.toMatchObject({ code: "OPERATION_TIMEOUT" });
});
it("refuses a symbolic tracking ref before it can update a local branch indirectly", { timeout: 40_000 }, async () => {
  const f = await fixture(); await f.advance(); await git(f.local, "symbolic-ref", "refs/remotes/origin/main", "refs/heads/main");
  await expect(f.sync()).rejects.toMatchObject({ code: "REPOSITORY_UNSAFE" });
  expect(await git(f.local, "rev-parse", "HEAD")).toBe(f.original);
});
