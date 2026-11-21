import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
  EntityKind, OperationMutationSchema, OperationState, ProjectArchiveBlocker, ScheduleSessionMode,
  TargetState, WorktreeEligibility, WorktreeRecycleReason, WorktreeRecycleState,
  type GetProjectArchivePreviewResponse, type ProjectArchiveMember
} from "@joko/contracts";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestratorE2eFixture } from "./fixture.js";
import {
  archiveMutation,
  createManualScheduleMutation,
  createSessionMutation,
  pauseQueueMutation,
  pinMutation,
  queueRunIdFrom,
  sendInputMutation,
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

  it("reviews local grouping membership, preserves both tasks and the dirty worktree, and fences partial removals", { timeout: 60_000 }, async () => {
    fixture = await OrchestratorE2eFixture.start();
    await initializeRepository(fixture.workspaceDirectory);
    const { clients, connectionId } = await fixture.pair("Review project removal");
    const backendId = fixture.adapter().id;
    const targetId = fixture.targetId(backendId);
    const createTask = async (displayName: string, useWorktree = false) => sessionIdFrom(await submit(
      clients.operation, connectionId, createSessionMutation({ backendId, targetId, displayName, useWorktree })
    ));
    const worktreeId = await createTask("Worktree task", true);
    const ordinaryId = await createTask("Ordinary task");
    const pinnedId = await createTask("Pinned task");
    const busyId = await createTask("Queued task");
    const dialogueId = await createTask("Dialogue task");
    const original = fixture.application.store.getSession(worktreeId).descriptor.worktree;
    if (original === undefined) throw new Error("Missing worktree.");
    const note = join(original.path, "uncommitted-note.txt");
    await writeFile(note, "Owner's uncommitted note\n", "utf8");
    expect((await submit(clients.operation, connectionId, createManualScheduleMutation({
      backendId, targetId, sessionId: worktreeId, sessionMode: ScheduleSessionMode.BOUND, text: "Run the check"
    }))).state).toBe(OperationState.SUCCEEDED);
    await submit(clients.operation, connectionId, pinMutation(pinnedId, true));
    const control = (await clients.queue.getQueueControl({ sessionId: busyId })).queueControl!;
    await submit(clients.operation, connectionId, pauseQueueMutation(control));
    const busyRunId = queueRunIdFrom(await submit(clients.operation, connectionId, sendInputMutation(
      busyId, BigInt(fixture.application.store.getSession(busyId).descriptor.binding.generation), "Keep this queued"
    )));
    const move = (sessionId: string, projectId?: string) => submit(clients.operation, connectionId,
      create(OperationMutationSchema, { payload: { case: "moveSessionProject", value: { sessionId, projectId } } }));
    await move(dialogueId);
    await expect(fixture.anonymous.target.getProjectArchivePreview({ targetId })).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(clients.target.getTarget({ targetId })).resolves.toMatchObject({ target: { projectArchivePreservesFiles: true } });
    const review = () => clients.target.getProjectArchivePreview({ targetId });
    const first = await review();
    expect(first.members).toHaveLength(4);
    expect(first.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: worktreeId, blocker: ProjectArchiveBlocker.UNSPECIFIED,
        activeScheduleCount: 1, activeScheduleNames: ["E2E unattended schedule"] }),
      expect.objectContaining({ sessionId: ordinaryId, blocker: ProjectArchiveBlocker.UNSPECIFIED }),
      expect.objectContaining({ sessionId: pinnedId, blocker: ProjectArchiveBlocker.PINNED }),
      expect.objectContaining({ sessionId: busyId, blocker: ProjectArchiveBlocker.RUNNING })
    ]));
    const archiveReviewed = (preview: GetProjectArchivePreviewResponse, member: ProjectArchiveMember) => submit(clients.operation,
      connectionId, create(OperationMutationSchema, {
        preconditions: [{ entity: { kind: EntityKind.SESSION, id: member.sessionId }, expectedRevision: member.revision }],
        payload: { case: "archiveSession", value: { sessionId: member.sessionId, archived: true,
          archiveConfirmation: member.archiveConfirmation, projectArchive: { targetId, targetRevision: preview.targetRevision } } }
      }));
    await move(ordinaryId);
    await expect(archiveReviewed(first, first.members.find(member => member.sessionId === ordinaryId)!))
      .rejects.toMatchObject({ code: Code.Aborted });
    await move(ordinaryId, targetId);
    const approved = await review();
    for (const member of approved.members.filter(member => member.blocker === ProjectArchiveBlocker.UNSPECIFIED)) {
      expect((await archiveReviewed(approved, member)).state).toBe(OperationState.SUCCEEDED);
    }
    expect(fixture.application.store.getSession(worktreeId).descriptor.worktree).toEqual(original);
    expect(await readFile(note, "utf8")).toBe("Owner's uncommitted note\n");
    const remove = create(OperationMutationSchema, {
      preconditions: [{ entity: { kind: EntityKind.TARGET, id: targetId }, expectedRevision: approved.targetRevision }],
      payload: { case: "archiveTarget", value: { targetId, archived: true, projectArchive: { reviewedSkippedSessionIds: [pinnedId, busyId] } } }
    });
    const lateId = await createTask("Joined after review");
    await expect(submit(clients.operation, connectionId, remove)).rejects.toMatchObject({ code: Code.Aborted });
    await move(lateId);
    const removalId = randomUUID();
    expect((await submit(clients.operation, connectionId, remove, removalId)).state).toBe(OperationState.SUCCEEDED);
    expect((await submit(clients.operation, connectionId, remove, removalId)).state).toBe(OperationState.SUCCEEDED);
    expect((await clients.target.getTarget({ targetId })).target?.state).toBe(TargetState.ARCHIVED);
    expect((await clients.session.listSessions({ targetId, archived: true })).sessions.map(task => task.sessionId).sort())
      .toEqual([ordinaryId, worktreeId].sort());
    expect((await clients.session.listSessions({ targetId, archived: false })).sessions.map(task => task.sessionId).sort())
      .toEqual([busyId, dialogueId, lateId, pinnedId].sort());
    expect(fixture.application.store.getRun(busyRunId).descriptor.state).toBe("queued");

    const remoteId = "project-removal-ssh";
    const local = fixture.application.store.getTarget(targetId).descriptor;
    fixture.application.store.upsertTarget({ ...local, id: remoteId, managed: false,
      remoteWorkspace: { kind: "ssh", hostTargetId: remoteId, hostId: "project-removal-host", workspaceRoot: "/srv/project" } });
    expect((await clients.target.getTarget({ targetId: remoteId })).target?.projectArchivePreservesFiles).toBe(false);
    await expect(clients.target.getProjectArchivePreview({ targetId: remoteId })).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect((await submit(clients.operation, connectionId, create(OperationMutationSchema, {
      payload: { case: "archiveTarget", value: { targetId: remoteId, archived: true } }
    }))).state).toBe(OperationState.SUCCEEDED);
  });

  const browserPath = process.env.JOKO_BROWSER_EXECUTABLE?.trim();
  const webDirectory = process.env.JOKO_MOUNTED_WEB_DIR?.trim();
  it.skipIf(!browserPath || !webDirectory)("uses the sidebar's optional archive and shows the original worktree in Archived tasks", { timeout: 90_000 }, async () => {
    fixture = await OrchestratorE2eFixture.start({ webDirectory });
    await initializeRepository(fixture.workspaceDirectory);
    const owner = await fixture.pair("Sidebar archive observer");
    const targetId = fixture.targetId();
    const targetName = fixture.application.store.getTarget(targetId).descriptor.displayName;
    const sessionId = sessionIdFrom(await submit(owner.clients.operation, owner.connectionId, createSessionMutation({
      backendId: fixture.adapter().id, targetId, useWorktree: true, displayName: "Keep the project checkout"
    })));
    const workspace = fixture.application.store.getSession(sessionId).descriptor.worktree!;
    const note = join(workspace.path, "sidebar-note.txt");
    await writeFile(note, "The existing checkout stays here.\n", "utf8");
    const challenge = (await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Project archive Web" })).challenge!;
    const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
    try {
      const page = await browser.newPage({ locale: "en-US", viewport: { width: 1280, height: 960 }, reducedMotion: "reduce" });
      await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
      await page.locator(".connection-tabs > button").nth(2).click();
      await page.locator("details.device-authorization__manual > summary").click();
      await page.getByLabel("Joko node address").fill(fixture.baseUrl);
      await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challengeId));
      await page.getByLabel("Device name").fill("Project archive Web");
      await page.locator("form.pair-form button[type=submit]").click();
      const heading = page.locator(".sidebar .project-group__heading").filter({ hasText: targetName }).first();
      await heading.hover();
      await heading.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("menuitem", { name: "Remove from sidebar", exact: true }).click();
      const dialog = page.getByRole("alertdialog", { name: `Remove ${targetName} from the sidebar?` });
      const checkbox = dialog.getByRole("checkbox", { name: "Also archive project tasks and keep their worktrees (1)" });
      await checkbox.waitFor();
      expect(await checkbox.isChecked()).toBe(false);
      await checkbox.press("Space");
      await dialog.getByRole("button", { name: "Remove and archive tasks", exact: true }).press("Enter");
      await expect.poll(async () => (await owner.clients.target.getTarget({ targetId })).target?.state).toBe(TargetState.ARCHIVED);
      await page.evaluate(() => { location.hash = "#/task-inbox"; });
      await page.getByRole("region", { name: "Archived", exact: true }).getByRole("button", { name: "Keep the project checkout" }).waitFor();
      expect(await readFile(note, "utf8")).toBe("The existing checkout stays here.\n");
    } finally { await browser.close(); }
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
