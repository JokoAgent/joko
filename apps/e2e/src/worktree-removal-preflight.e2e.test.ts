import { execFile as execFileCallback } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { Code } from "@connectrpc/connect";
import { OperationState, WorktreeEligibility } from "@joko/contracts";
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

  it("projects real Git dirtiness across archive, service restart, and exact restore", { timeout: 60_000 }, async () => {
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
    expect(initialBinding).toMatchObject({ state: "active" });
    await expect(paired.clients.worktree.getSessionWorktreeRemovalPreview({ sessionId })).resolves.toMatchObject({
      sessionId,
      hasWorktree: true,
      dirty: false
    });

    const trackedPath = join(initialBinding.path, "README.md");
    const untrackedPath = join(initialBinding.path, "recovery-note.txt");
    await writeFile(trackedPath, "staged worktree content\n", "utf8");
    await git(initialBinding.path, ["add", "README.md"]);
    await writeFile(trackedPath, "unstaged worktree content\n", "utf8");
    await writeFile(untrackedPath, "untracked worktree content\n", "utf8");
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
    await expect(access(initialBinding.path)).rejects.toMatchObject({ code: "ENOENT" });

    const rootDirectory = fixture.rootDirectory;
    await fixture.close({ removeRoot: false });
    fixture = await OrchestratorE2eFixture.start({ rootDirectory });
    const restartedClients = fixture.clients(paired.authKey);
    await expect(restartedClients.worktree.getSessionWorktreeRemovalPreview({ sessionId })).resolves.toMatchObject({
      sessionId,
      hasWorktree: true,
      dirty: true
    });

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
      state: "active"
    });
    expect(resolve(restoredBinding!.path)).toBe(resolve(initialBinding.path));
    expect((await readFile(trackedPath, "utf8")).replaceAll("\r\n", "\n"))
      .toBe("unstaged worktree content\n");
    expect((await git(initialBinding.path, ["show", ":README.md"])).replaceAll("\r\n", "\n"))
      .toBe("staged worktree content\n");
    expect((await readFile(untrackedPath, "utf8")).replaceAll("\r\n", "\n"))
      .toBe("untracked worktree content\n");
    expect((await git(initialBinding.path, ["status", "--porcelain=v1"]))
      .replaceAll("\r\n", "\n"))
      .toBe("MM README.md\n?? recovery-note.txt\n");
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
