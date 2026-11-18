import { execFile as execFileCallback } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { Code } from "@connectrpc/connect";
import { OperationState, WorktreeEligibility, WorktreeRecycleReason, WorktreeRecycleState } from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestratorE2eFixture } from "./fixture.js";
import {
  archiveMutation,
  createSessionMutation,
  sessionIdFrom,
  submit
} from "./operations.js";

const execFile = promisify(execFileCallback);

describe("managed worktree removal preflight", () => {
  let fixture: OrchestratorE2eFixture | undefined;

  afterEach(async () => {
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
  });

  it.each([
    { archiveMode: "with the original branch preserved", removeBranch: false, keepCheckout: false },
    { archiveMode: "with the original branch deleted", removeBranch: true, keepCheckout: false },
    { archiveMode: "with the original checkout kept", removeBranch: false, keepCheckout: true }
  ])("archives and restores the exact worktree after a service restart $archiveMode", { timeout: 60_000 }, async ({ removeBranch, keepCheckout }) => {
    fixture = await OrchestratorE2eFixture.start();
    await initializeRepository(fixture.workspaceDirectory);
    const paired = await fixture.pair("Worktree preflight owner");
    const backendId = fixture.adapter().id;
    const targetId = fixture.targetId(backendId);

    await expect(fixture.anonymous.worktree.getSessionWorktreeRemovalPreview({
      sessionId: "not-authorized"
    })).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(paired.clients.worktree.probeTargetWorktree({ targetId })).resolves.toMatchObject({
      targetId,
      eligibility: WorktreeEligibility.ELIGIBLE
    });

    const ordinarySessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId, targetId, displayName: "Ordinary checkout" })
    ));
    await expect(paired.clients.worktree.getSessionWorktreeRemovalPreview({
      sessionId: ordinarySessionId
    })).resolves.toMatchObject({
      sessionId: ordinarySessionId,
      hasWorktree: false,
      dirty: false
    });

    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({
        backendId,
        targetId,
        displayName: "Managed checkout",
        useWorktree: true
      })
    ));
    const initialBinding = fixture.application.store.getSession(sessionId).descriptor.worktree;
    if (initialBinding === undefined) throw new Error("Managed task has no worktree binding.");
    const originalHead = (await git(initialBinding.path, ["rev-parse", "HEAD"])).trim();
    expect(initialBinding).toMatchObject({ state: "active" });
    await expect(paired.clients.worktree.getSessionWorktreeRemovalPreview({ sessionId })).resolves.toMatchObject({
      sessionId,
      hasWorktree: true,
      dirty: false
    });

    const trackedPath = join(initialBinding.path, "README.md");
    const untrackedPath = join(initialBinding.path, "recovery-note.txt");
    const keepPath = join(initialBinding.path, ".worktree-keep");
    await writeFile(trackedPath, "staged worktree content\n", "utf8");
    await git(initialBinding.path, ["add", "README.md"]);
    await writeFile(trackedPath, "unstaged worktree content\n", "utf8");
    await writeFile(untrackedPath, "untracked worktree content\n", "utf8");
    if (keepCheckout) await writeFile(keepPath, "Keep this checkout\n", "utf8");
    await expect(paired.clients.worktree.getSessionWorktreeRemovalPreview({ sessionId })).resolves.toMatchObject({
      sessionId,
      hasWorktree: true,
      dirty: true
    });

    const archived = await submit(
      paired.clients.operation,
      paired.connectionId,
      archiveMutation(sessionId, true)
    );
    expect(archived.state).toBe(OperationState.SUCCEEDED);
    expect(fixture.application.store.getSession(sessionId).descriptor).toMatchObject({
      archived: true,
      worktree: { leaseId: initialBinding.leaseId, path: initialBinding.path, state: "preserved" }
    });
    if (keepCheckout) {
      expect(await readFile(keepPath, "utf8")).toBe("Keep this checkout\n");
      expect(await readFile(untrackedPath, "utf8")).toBe("untracked worktree content\n");
      await expect(paired.clients.worktree.listWorktreeRecycleStatus({})).resolves.toMatchObject({
        records: [expect.objectContaining({ sessionId, id: initialBinding.leaseId,
          state: WorktreeRecycleState.KEPT, reason: WorktreeRecycleReason.KEPT })]
      });
    } else await expect(access(initialBinding.path)).rejects.toMatchObject({ code: "ENOENT" });
    const branchRef = `refs/heads/${initialBinding.branch}`;
    if (removeBranch) {
      await git(initialBinding.repositoryRoot, ["branch", "-D", "--", initialBinding.branch]);
      await expect(git(initialBinding.repositoryRoot, ["show-ref", "--verify", "--quiet", branchRef])).rejects.toThrow();
    }

    const rootDirectory = fixture.rootDirectory;
    await fixture.close({ removeRoot: false });
    fixture = await OrchestratorE2eFixture.start({ rootDirectory });
    const restartedClients = fixture.clients(paired.authKey);
    expect(fixture.application.store.getSession(sessionId).descriptor).toMatchObject({
      archived: true, worktree: { state: "preserved", leaseId: initialBinding.leaseId }
    });
    if (!removeBranch) {
      await expect(restartedClients.worktree.getSessionWorktreeRemovalPreview({ sessionId })).resolves.toMatchObject({
        sessionId,
        hasWorktree: true,
        dirty: true
      });
    }

    const restored = await submit(
      restartedClients.operation,
      paired.connectionId,
      archiveMutation(sessionId, false)
    );
    expect(restored.state).toBe(OperationState.SUCCEEDED);
    const restoredBinding = fixture.application.store.getSession(sessionId).descriptor.worktree;
    expect(restoredBinding).toMatchObject({
      leaseId: initialBinding.leaseId,
      path: initialBinding.path,
      branch: initialBinding.branch,
      state: "active"
    });
    expect(resolve(restoredBinding!.path)).toBe(resolve(initialBinding.path));
    expect((await git(initialBinding.path, ["symbolic-ref", "HEAD"])).trim()).toBe(branchRef);
    expect((await git(initialBinding.path, ["rev-parse", "HEAD"])).trim()).toBe(originalHead);
    expect((await readFile(trackedPath, "utf8")).replaceAll("\r\n", "\n"))
      .toBe("unstaged worktree content\n");
    expect((await git(initialBinding.path, ["show", ":README.md"])).replaceAll("\r\n", "\n"))
      .toBe("staged worktree content\n");
    expect((await readFile(untrackedPath, "utf8")).replaceAll("\r\n", "\n"))
      .toBe("untracked worktree content\n");
    expect((await git(initialBinding.path, ["status", "--porcelain=v1"]))
      .replaceAll("\r\n", "\n"))
      .toBe(`MM README.md\n${keepCheckout ? "?? .worktree-keep\n" : ""}?? recovery-note.txt\n`);
    if (keepCheckout) {
      expect(await readFile(keepPath, "utf8")).toBe("Keep this checkout\n");
      await expect(restartedClients.worktree.listWorktreeRecycleStatus({})).resolves.toMatchObject({ records: [] });
    }
    await expect(restartedClients.worktree.getSessionWorktreeRemovalPreview({ sessionId })).resolves.toMatchObject({
      sessionId,
      hasWorktree: true,
      dirty: true
    });
  });
});

async function initializeRepository(repositoryRoot: string): Promise<void> {
  await git(repositoryRoot, ["init"]);
  await git(repositoryRoot, ["config", "user.email", "e2e@joko.invalid"]);
  await git(repositoryRoot, ["config", "user.name", "Joko E2E"]);
  await git(repositoryRoot, ["add", "README.md"]);
  await git(repositoryRoot, ["commit", "-m", "fixture baseline"]);
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const environment: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
  for (const key of ["GIT_COMMON_DIR", "GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"]) delete environment[key];
  const result = await execFile("git", [...args], {
    cwd,
    encoding: "utf8",
    env: environment,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true
  });
  return result.stdout;
}
