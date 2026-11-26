import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { CreateTargetMutationSchema, OperationMutationSchema, OperationState, PermissionMode, PortableSessionService, PortableTaskCopyPartKind,
  RunState, SetWorkspaceTrustMutationSchema, WorkspaceKind } from "@joko/contracts";
import { afterEach, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Request } from "playwright-core";
import { routeFixtureDiscovery, waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";
import type { PairedClient } from "./connect-clients.js";

const execute = promisify(execFile);
const project = "workspace-real-pi";
const blockedInput = "Hold this input at the original node";

it("refuses to copy a repository subdirectory before establishing a target on the receiving node", { timeout: 90_000 }, async () => {
  const source = await RealPiSystemFixture.start();
  fixtures.push(source);
  const destination = await RealPiSystemFixture.start();
  fixtures.push(destination);
  const owner = await source.pair("Nested task owner");
  const receiver = await destination.pair("Receiving owner");
  const root = source.workspaceDirectory;
  await git(root, "init", "-b", "source");
  const nested = join(root, "packages", "app");
  await mkdir(nested, { recursive: true });
  const created = await submit(owner.clients.operation, owner.connectionId, create(OperationMutationSchema, { payload: {
    case: "createTarget", value: create(CreateTargetMutationSchema, { backendId: "pi", displayName: "Nested workspace",
      workspace: { kind: WorkspaceKind.USER_PROJECT, serverPath: nested } })
  } }));
  if (created.result?.payload.case !== "target") throw new Error("The nested workspace was not created.");
  const { workspaceId, targetId } = created.result.payload.value;
  await trustWorkspace(owner, workspaceId);
  const sessionId = await createTask(owner, "Nested task", targetId);
  const operationId = randomUUID();
  await expect(owner.clients.portableSession.preparePortableTaskCopy({ operationId, sessionId,
    expectedSessionGeneration: generation(source, sessionId), destinationServerId: destination.application.serverId
  })).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: "Choose the Git repository root to copy this task." });
  expect((await receiver.clients.portableSession.getPortableTaskCopyReceipt({ operationId })).receipt).toBeUndefined();
  expect(destination.application.store.listSessions()).toHaveLength(0);
});

it("copies a settled Pi Goal with distinct worker files and native history to an independently paired node exactly once", {
  timeout: 180_000
}, async () => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const source = await RealPiSystemFixture.start({ providerResponder: async ({ request }) => {
    const messages = JSON.stringify(request.body["messages"]);
    if (messages.includes(blockedInput)) await gate;
    return { kind: "text", text: messages.includes("Worker carries the second history") ? "Original worker report" : "Original lead report" };
  } });
  fixtures.push(source);
  try {
    const destination = await RealPiSystemFixture.start();
    fixtures.push(destination);
    const originalOwner = await source.pair("Source task owner");
    const receivingOwner = await destination.pair("Destination task owner");
    await trustWorkspace(originalOwner, project);
    await trustWorkspace(receivingOwner, project);
    const root = source.workspaceDirectory;
    const workingFile = join(root, "notes.txt");
    await git(root, "init", "-b", "copy-source");
    await writeFile(workingFile, "base\n");
    await git(root, "add", "--", "notes.txt");
    await git(root, "-c", "user.email=joko@example.invalid", "-c", "user.name=Joko test", "commit", "-m", "original history");
    await writeFile(workingFile, "staged\n");
    await git(root, "add", "--", "notes.txt");
    await writeFile(workingFile, "dirty\n");
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "ignored.txt"), "still part of the current workspace");
    if (process.platform !== "win32") await symlink(join(source.rootDirectory, "outside-copy"), join(root, "external-link"));
    const workerDirectory = join(root, "worker-area");
    await mkdir(workerDirectory);
    await writeFile(join(workerDirectory, "worker.txt"), "private workspace of the copied worker");

    const lead = await createTask(originalOwner, "Source task for direct copy");
    const sourceGeneration = generation(source, lead);
    await waitForSuccess(originalOwner, await send(originalOwner, lead, sourceGeneration, "Lead carries the first history"));
    const { tree } = await originalOwner.clients.collaboration.createCollaborationGoal({
      operationId: randomUUID(), leadSessionId: lead, expectedSessionGeneration: sourceGeneration,
      title: "Copied Goal", objective: "Keep the source and target memberships separate.", maximumWorkers: 4
    });
    const goal = tree!.goal!;
    const { worker } = await originalOwner.clients.collaboration.createCollaborationWorker({
      operationId: randomUUID(), goalId: goal.goalId, callerLeadSessionId: lead, expectedGoalRevision: goal.revision,
      label: "Verifier", role: "Read evidence", assignment: "Worker carries the second history",
      targetId: project, providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, effort: "off", permissionMode: PermissionMode.ASK,
      workspace: { workingDirectory: workerDirectory }
    });
    const workerId = worker!.workerId;
    const workerSession = worker!.sessionId!;
    await waitFor(async () => source.application.store.getCollaborationWorker(workerId).status,
      state => state === "completed" || state === "idle" && source.application.store.listRuns({ sessionId: workerSession }).some(row => row.descriptor.state === "completed"),
      "the source worker and input queue to settle", 30_000);

    const request = (operationId: string) => ({ operationId, sessionId: lead, expectedSessionGeneration: sourceGeneration,
      destinationServerId: destination.application.serverId });
    const runId = await send(originalOwner, lead, sourceGeneration, blockedInput);
    await waitFor(async () => source.providerRequests.some(item => JSON.stringify(item.body).includes(blockedInput)),
      value => value, "the held source input", 30_000);
    await expect(originalOwner.clients.portableSession.preparePortableTaskCopy(request(randomUUID())))
      .rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: expect.stringMatching(/idle/u) });
    release();
    await waitForSuccess(originalOwner, runId);

    const workerFile = join(workerDirectory, "worker.txt");
    await git(root, "add", "--", "worker-area/worker.txt");
    await writeFile(workerFile, "worker unstaged\n");
    const rejected = request(randomUUID());
    await expect(originalOwner.clients.portableSession.preparePortableTaskCopy(rejected)).rejects.toMatchObject({
      code: Code.FailedPrecondition, rawMessage: expect.stringMatching(/choose the Git repository root/iu)
    });
    expect((await receivingOwner.clients.portableSession.getPortableTaskCopyReceipt({ operationId: rejected.operationId })).receipt).toBeUndefined();
    expect(await git(root, "show", ":worker-area/worker.txt")).toBe("private workspace of the copied worker");
    expect(await readFile(workerFile, "utf8")).toBe("worker unstaged\n");

    await git(root, "rm", "-f", "--cached", "--", "worker-area/worker.txt");
    await git(workerDirectory, "init", "-b", "copy-worker");
    await git(workerDirectory, "add", "--", "worker.txt");
    await git(workerDirectory, "-c", "user.email=joko@example.invalid", "-c", "user.name=Joko test", "commit", "-m", "worker history");
    await writeFile(workerFile, "worker staged\n");
    await git(workerDirectory, "add", "--", "worker.txt");
    await writeFile(workerFile, "private workspace of the copied worker");

    const cancelledRequest = request(randomUUID());
    const { grant: cancelled } = await originalOwner.clients.portableSession.preparePortableTaskCopy(cancelledRequest);
    const reader = source.anonymous.portableSession;
    const read = (grant: NonNullable<typeof cancelled>, secret: string, destinationServerId = grant.destinationServerId) =>
      reader.readPortableTaskCopy({ transferId: grant.transferId, operationId: grant.operationId, destinationServerId,
        part: PortableTaskCopyPartKind.WORKSPACE }, { headers: { authorization: `JokoTaskCopy ${secret}` } })[Symbol.asyncIterator]().next();
    const cancelledSecret = Buffer.from(cancelled!.readSecret).toString("base64url");
    await expect(read(cancelled!, Buffer.alloc(32).toString("base64url"))).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(read(cancelled!, cancelledSecret, source.application.serverId)).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(originalOwner.clients.portableSession.cancelPortableTaskCopy({
      transferId: cancelled!.transferId, operationId: cancelledRequest.operationId
    })).resolves.toMatchObject({ cancelled: true });
    await expect(read(cancelled!, cancelledSecret)).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect((await receivingOwner.clients.portableSession.getPortableTaskCopyReceipt({ operationId: cancelledRequest.operationId })).receipt).toBeUndefined();

    const original = request(randomUUID());
    const { grant } = await originalOwner.clients.portableSession.preparePortableTaskCopy(original);
    const targetRevision = destination.application.store.getTarget(project).revision;
    const transfer = { grant: grant!, sourceOrigin: source.baseUrl, backendId: "pi", parentTargetId: project,
      expectedParentRevision: { value: targetRevision } };
    const lostResponse = createClient(PortableSessionService, createConnectTransport({
      baseUrl: destination.baseUrl, useBinaryFormat: true, httpVersion: "1.1",
      interceptors: [(next) => async incoming => {
        incoming.header.set("authorization", `Bearer ${receivingOwner.authKey}`);
        await next(incoming);
        throw new ConnectError("The response was lost after the destination completed it.", Code.Unavailable);
      }]
    }));
    await expect(lostResponse.importPortableTaskCopy(transfer)).rejects.toMatchObject({ code: Code.Unavailable });
    const { receipt } = await receivingOwner.clients.portableSession.getPortableTaskCopyReceipt({ operationId: original.operationId });
    expect(receipt?.task).toMatchObject({ workerCount: 1n, replacedSessionIds: [] });
    const copiedLead = receipt!.task!.sessionId;
    expect(copiedLead).not.toBe(lead);
    const replay = await receivingOwner.clients.portableSession.importPortableTaskCopy(transfer);
    expect(replay.receipt).toEqual(receipt);
    const secondOwner = await destination.pair("Different destination device");
    await expect(secondOwner.clients.portableSession.getPortableTaskCopyReceipt({ operationId: original.operationId })).rejects.toMatchObject({ code: Code.Aborted });
    const store = destination.application.store;
    const copiedGoal = store.findActiveCollaborationGoalByLeadSession(copiedLead)!;
    expect(copiedGoal).toMatchObject({ title: goal.title, objective: goal.objective });
    const members = store.listCollaborationWorkers({ goalId: copiedGoal.id });
    expect(members).toHaveLength(1);
    const copiedWorker = members[0]!;
    expect(copiedWorker).toMatchObject({ label: "Verifier", runtimeReleased: true, permissionMode: "ask" });
    expect(copiedWorker.id).not.toBe(workerId);
    expect(copiedWorker.sessionId).not.toBe(workerSession);
    expect(store.listSessions()).toHaveLength(2);
    const copiedRoot = store.getTarget(receipt!.targetId).descriptor.workspaceRoot;
    const copiedWorkerRoot = store.getTarget(copiedWorker.targetId).descriptor.workspaceRoot;
    expect(copiedRoot).not.toBe(root);
    expect(copiedWorkerRoot).not.toBe(copiedRoot);
    expect(store.getTarget(receipt!.targetId).descriptor.trusted).toBe(false);
    expect(await readFile(join(copiedRoot, "notes.txt"), "utf8")).toBe("dirty\n");
    expect(await git(copiedRoot, "show", ":notes.txt")).toBe("staged");
    expect(await git(copiedRoot, "symbolic-ref", "--short", "HEAD")).toBe("copy-source");
    expect(await git(copiedRoot, "rev-parse", "HEAD")).toBe(await git(root, "rev-parse", "HEAD"));
    expect(await readFile(join(copiedRoot, "ignored.txt"), "utf8")).toBe("still part of the current workspace");
    expect(await readFile(join(copiedWorkerRoot, "worker.txt"), "utf8")).toBe("private workspace of the copied worker");
    expect(await git(copiedWorkerRoot, "show", ":worker.txt")).toBe("worker staged");
    expect(await git(copiedWorkerRoot, "symbolic-ref", "--short", "HEAD")).toBe("copy-worker");
    expect(await git(copiedWorkerRoot, "rev-parse", "HEAD")).toBe(await git(workerDirectory, "rev-parse", "HEAD"));
    await expect(readFile(join(copiedRoot, "worker-area", "worker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    if (process.platform !== "win32") {
      expect(receipt?.skippedFiles).toContainEqual(expect.objectContaining({ relativePath: "external-link", reason: "external_link" }));
      expect(receipt?.skippedFileCount).toBe(1n);
    }

    expect(await readFile(workingFile, "utf8")).toBe("dirty\n");
    expect(await git(root, "show", ":notes.txt")).toBe("staged");
    expect(source.application.store.getSession(lead).descriptor.archived).toBe(false);
    expect(source.application.store.getCollaborationWorker(workerId).sessionId).toBe(workerSession);
    expect(timelineText(source, lead)).toContain("Lead carries the first history");
    expect(timelineText(destination, copiedWorker.sessionId!)).toContain("Original worker report");
    await waitForSuccess(receivingOwner, await send(receivingOwner, copiedLead, generation(destination, copiedLead), "Continue the copied task"));
    expect(JSON.stringify(destination.providerRequests.at(-1)?.body)).toContain("Lead carries the first history");
  } finally { release(); }
});

const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim() && process.env.JOKO_MOUNTED_WEB_DIR?.trim() ? it : it.skip;
mountedIt("copies from the mounted task menu and opens the authoritative destination task on a narrow screen", {
  timeout: 200_000
}, async () => {
  const source = await RealPiSystemFixture.start({ webDirectory: resolve(process.env.JOKO_MOUNTED_WEB_DIR!) });
  fixtures.push(source);
  const destination = await RealPiSystemFixture.start({ corsOrigins: [source.baseUrl] });
  fixtures.push(destination);
  const actor = await source.pair("Owner preparing the real source workspace");
  await trustWorkspace(actor, project);
  await writeFile(join(source.workspaceDirectory, "mounted-copy.txt"), "mounted direct copy");
  const sessionId = await createTask(actor, "Mounted task for direct copy");
  await waitForSuccess(actor, await send(actor, sessionId, generation(source, sessionId), "The mounted source conversation"));
  browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: "en-US" });
  await routeFixtureDiscovery(context, source.baseUrl);
  const page = await context.newPage();
  await page.goto(`${source.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
  await pairPage(page, destination, "Copy destination");
  await page.getByRole("button", { name: "Disconnect", exact: true }).click({ timeout: 20_000 });
  await pairPage(page, source, "Copy source");
  await page.goto(`${source.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
  await page.locator('.session-header-menu summary[aria-label="Actions for Mounted task for direct copy"]')
    .click({ timeout: 25_000 });
  await page.getByRole("menuitem", { name: "Export task…", exact: true }).click();
  await page.getByRole("button", { name: "Copy to another node", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Copy to another node", exact: true });
  await dialog.getByRole("combobox", { name: "Destination runtime", exact: true }).waitFor({ timeout: 20_000 });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await dialog.getByRole("button", { name: "Copy task", exact: true }).click();
  await dialog.getByText("Task copied.", { exact: true }).waitFor({ timeout: 35_000 });
  const copied = destination.application.store.listSessions();
  expect(copied).toHaveLength(1);
  expect(await readFile(join(destination.application.store.getTarget(copied[0]!.descriptor.targetId).descriptor.workspaceRoot,
    "mounted-copy.txt"), "utf8")).toBe("mounted direct copy");
  const copiedTaskId = copied[0]!.descriptor.id;
  const copiedTaskPath = `/tasks/${encodeURIComponent(copiedTaskId)}`;
  const copiedPane = page.locator(`.session-pane[data-input-session-id='${copiedTaskId}']`);
  const openTask = dialog.getByRole("button", { name: "Open task", exact: true });
  const openError = dialog.getByRole("alert");
  const destinationOrigin = new URL(destination.baseUrl).origin;
  const openedAt = Date.now();
  const reads = new Map<Request, { path: string; startedAfterMs: number; status?: number; failure?: string }>();
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin === destinationOrigin && /\/(?:GetServerInfo|GetSnapshot|ListManagedModelRuntimes|ListWorkspaceEntries)$/u.test(url.pathname)) {
      reads.set(request, { path: url.pathname, startedAfterMs: Date.now() - openedAt });
    }
  });
  page.on("response", response => {
    const read = reads.get(response.request());
    if (read !== undefined) read.status = response.status();
  });
  page.on("requestfailed", request => {
    const read = reads.get(request);
    if (read !== undefined) read.failure = request.failure()?.errorText;
  });
  try {
    await openTask.click();
    // Opening the copied task reads the saved node and establishes its live connection.
    const timeout = 45_000;
    await Promise.race([
      page.waitForURL(url => {
        const route = new URL(url.hash.slice(1), url.origin);
        return route.pathname === copiedTaskPath && route.searchParams.has("profile");
      }, { timeout }),
      openError.waitFor({ state: "visible", timeout }).then(async () => {
        throw new Error(`The copied task could not be opened: ${await openError.innerText({ timeout: 1000 })}`);
      })
    ]);
    await dialog.waitFor({ state: "hidden", timeout: 25_000 });
    await copiedPane.getByText("The mounted source conversation", { exact: true }).first().waitFor({ timeout: 25_000 });
  } catch (error) {
    const dialogState = await dialog.evaluateAll(elements => elements.map(element => ({
      opening: [...element.querySelectorAll("button")].some(button => button.textContent?.trim() === "Open task" && button.disabled),
      error: element.querySelector('[role="alert"]')?.textContent
    }))).catch(() => []);
    console.info("Mounted task copy destination handoff", JSON.stringify({ copiedTaskId, hash: new URL(page.url()).hash,
      elapsedMs: Date.now() - openedAt, dialogState, reads: [...reads.values()] }));
    throw error;
  }
});

const fixtures: RealPiSystemFixture[] = [];
let browser: Browser | undefined;
afterEach(async () => {
  await browser?.close();
  browser = undefined;
  await Promise.allSettled(fixtures.splice(0).map(fixture => fixture.close()));
});

async function pairPage(page: Page, fixture: RealPiSystemFixture, name: string): Promise<void> {
  const { challenge } = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: name });
  await page.locator(".connection-tabs > button").nth(2).click({ timeout: 20_000 });
  await page.locator("details.device-authorization__manual > summary").click();
  await page.getByLabel("Joko node address").fill(fixture.baseUrl);
  await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge!.challengeId));
  await page.getByLabel("Device name").fill(name);
  await page.locator("form.pair-form button[type=submit]").click();
  await page.locator(".connection-card").waitFor({ state: "hidden", timeout: 25_000 });
}

async function trustWorkspace(owner: PairedClient, workspaceId: string): Promise<void> {
  const result = await submit(owner.clients.operation, owner.connectionId, create(OperationMutationSchema, {
    payload: { case: "setWorkspaceTrust", value: create(SetWorkspaceTrustMutationSchema, { workspaceId, trusted: true }) }
  }));
  expect(result.state, result.error?.message).toBe(OperationState.SUCCEEDED);
}

async function createTask(owner: PairedClient, displayName: string, targetId = project): Promise<string> {
  return sessionIdFrom(await submit(owner.clients.operation, owner.connectionId, createSessionMutation({
    backendId: "pi", targetId, displayName, providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID
  })));
}

function generation(fixture: RealPiSystemFixture, sessionId: string): bigint {
  return BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation);
}

async function send(owner: PairedClient, sessionId: string, generation: bigint, text: string): Promise<string> {
  return queueRunIdFrom(await submit(owner.clients.operation, owner.connectionId, sendInputMutation(sessionId, generation, text)));
}

async function waitForSuccess(owner: PairedClient, runId: string): Promise<void> {
  await waitFor(() => owner.clients.run.getRun({ runId }), reply => reply.run?.state === RunState.SUCCEEDED, "Pi to settle", 30_000);
}

function timelineText(fixture: RealPiSystemFixture, sessionId: string): string {
  return fixture.application.store.listEvents({ sessionId }).flatMap(({ payload }) => payload.type === "message_complete"
    ? payload.blocks.flatMap(block => block.kind === "text" ? [block.text] : []) : []).join("\n");
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}
