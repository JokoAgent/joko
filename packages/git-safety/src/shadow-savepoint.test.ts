import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { NodeGitCommandRunner } from "./git-command.js";
import {
  ShadowSavepointService,
  SnapshotBlockedError,
  savepointRefForSession
} from "./shadow-savepoint.js";
import { SAVEPOINT_REF_NAMESPACE } from "./types.js";

const execFileAsync = promisify(execFile);

describe("shadow workspace savepoints", () => {
  it("captures the worktree through plumbing without moving HEAD, index, branch, or invoking hooks", async () => {
    const root = await createRepository();
    const runner = new NodeGitCommandRunner();
    const service = new ShadowSavepointService(runner);
    const headBefore = await git(root, "rev-parse", "HEAD");
    const branchBefore = await git(root, "branch", "--show-current");

    await writeFile(join(root, "tracked.txt"), "staged version\n", "utf8");
    await git(root, "add", "--", "tracked.txt");
    await writeFile(join(root, "tracked.txt"), "worktree version\n", "utf8");
    await writeFile(join(root, "new file.txt"), "new workspace file\n", "utf8");
    const indexTreeBefore = await git(root, "write-tree");
    const statusBefore = await git(root, "status", "--porcelain=v1");
    const hooks = join(root, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    const preCommit = join(hooks, "pre-commit");
    await writeFile(preCommit, "#!/bin/sh\nexit 91\n", "utf8");
    await chmod(preCommit, 0o700);
    await git(root, "config", "commit.gpgSign", "true");

    const baseline = await service.create(root, {
      sessionId: "session_one",
      runId: "run_one",
      kind: "turn_start"
    });
    expect(baseline.commit).toMatch(/^[0-9a-f]{40,64}$/u);
    expect(await git(root, "show", `${baseline.commit}:tracked.txt`)).toBe("worktree version");
    expect(await git(root, "show", `${baseline.commit}:new file.txt`)).toBe("new workspace file");
    expect(await git(root, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await git(root, "branch", "--show-current")).toBe(branchBefore);
    expect(await git(root, "write-tree")).toBe(indexTreeBefore);
    expect(await git(root, "status", "--porcelain=v1")).toBe(statusBefore);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("worktree version\n");
    expect(await git(root, "log", "-1", "--format=%s", "HEAD")).toBe("base");
    expect(await git(root, "for-each-ref", "--format=%(refname)", SAVEPOINT_REF_NAMESPACE))
      .toBe(savepointRefForSession("session_one"));

    await writeFile(join(root, "tracked.txt"), "after turn\n", "utf8");
    const after = await service.create(root, {
      sessionId: "session_one",
      runId: "run_one",
      kind: "after_edit",
      baselineCommit: baseline.commit!,
      skipIfTreeEquals: baseline.commit!
    });
    expect(after.commit).toMatch(/^[0-9a-f]{40,64}$/u);
    expect(await git(root, "rev-parse", `${after.commit}^`)).toBe(baseline.commit);
    expect(await git(root, "show", `${after.commit}:tracked.txt`)).toBe("after turn");
    const entries = await service.list(root, "session_one");
    expect(entries.map((entry) => entry.kind)).toEqual(["after_edit", "turn_start"]);
    expect(entries[0]).toMatchObject({ baselineCommit: baseline.commit, runId: "run_one" });

    const unchanged = await service.create(root, {
      sessionId: "session_one",
      runId: "run_two",
      kind: "after_edit",
      baselineCommit: after.commit!,
      skipIfTreeEquals: after.commit!
    });
    expect(unchanged.commit).toBeNull();

    await service.deleteSessionChain(root, "session_one");
    await expect(git(root, "rev-parse", "--verify", savepointRefForSession("session_one"))).rejects.toBeDefined();
  }, 20_000);

  it("never hashes filtered credential-like or oversized dirty files", async () => {
    const root = await createRepository();
    const service = new ShadowSavepointService(new NodeGitCommandRunner());
    await writeFile(join(root, ".env.local"), "PASSWORD=opaque-value-that-must-not-persist\n", "utf8");
    await writeFile(join(root, "notes.txt"), "Bearer opaque-token-value-123456\n", "utf8");
    await writeFile(join(root, "large.bin"), Buffer.alloc(32, 7));

    const result = await service.create(root, {
      sessionId: "secure_session",
      runId: "secure_run",
      kind: "turn_start",
      fileFilter: { maxFileBytes: 16, maxContentScanBytes: 16 }
    });
    expect(Object.fromEntries(result.skippedPaths.map((item) => [item.relativePath, item.reason]))).toEqual({
      ".env.local": "sensitive_path",
      "large.bin": "large_file",
      "notes.txt": "large_file"
    });
    const names = await git(root, "ls-tree", "-r", "--name-only", result.commit!);
    expect(names).toBe("tracked.txt");
    expect(JSON.stringify(result)).not.toContain("opaque-value-that-must-not-persist");
    expect(JSON.stringify(result)).not.toContain("opaque-token-value-123456");
  });

  it("blocks merge and conflict states without writing a savepoint ref", async () => {
    const root = await createRepository();
    const service = new ShadowSavepointService(new NodeGitCommandRunner());
    await writeFile(join(root, ".git", "MERGE_HEAD"), "f".repeat(40), "utf8");
    await expect(service.create(root, {
      sessionId: "blocked_session",
      runId: "blocked_run",
      kind: "turn_start"
    })).rejects.toMatchObject({ reason: "merge" } satisfies Partial<SnapshotBlockedError>);
    expect(await git(root, "for-each-ref", "--format=%(refname)", SAVEPOINT_REF_NAMESPACE)).toBe("");
  });

  it("deletes only the hidden savepoint namespace across tracked sessions", async () => {
    const root = await createRepository();
    const service = new ShadowSavepointService(new NodeGitCommandRunner());
    for (const sessionId of ["session_one", "session_two"]) {
      await service.create(root, { sessionId, runId: "run_one", kind: "turn_start" });
    }
    await git(root, "update-ref", "refs/joko/kept", "HEAD");

    await expect(service.deleteRepositoryNamespace(root)).resolves.toBe(2);
    expect(await git(root, "for-each-ref", "--format=%(refname)", SAVEPOINT_REF_NAMESPACE)).toBe("");
    expect(await git(root, "rev-parse", "--verify", "refs/joko/kept")).toMatch(/^[0-9a-f]{40,64}$/u);
  });
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "joko-savepoint-repo-"));
  await git(root, "init", "--quiet");
  await git(root, "config", "user.name", "Workspace User");
  await git(root, "config", "user.email", "workspace@example.test");
  await git(root, "config", "core.autocrlf", "false");
  await writeFile(join(root, "tracked.txt"), "base\n", "utf8");
  await git(root, "add", "--", "tracked.txt");
  await git(root, "commit", "--quiet", "-m", "base");
  return root;
}

async function git(root: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, {
    cwd: root,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8"
  })).stdout.trim();
}
