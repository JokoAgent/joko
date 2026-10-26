import {
  CollaborationDispatchStatus,
  CollaborationGoalStatus,
  CollaborationWorkerStatus,
  GetTaskProviderGroupUsageRequestSchema,
  PermissionMode
} from "@joko/contracts";
import { fromBinary } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page, type Request, type Route } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import { createSessionMutation, pauseQueueMutation, sessionIdFrom, submit } from "./operations.js";
import {
  REAL_PI_MODEL_ID,
  REAL_PI_PROVIDER_ID,
  RealPiSystemFixture
} from "./real-pi-fixture.js";
import { waitFor } from "./fixture.js";

const GOAL_TITLE = "Mounted collaboration Goal";
const GOAL_OBJECTIVE = "Prove the production Web collaboration lifecycle and durable recovery.";
const WORKER_LABEL = "Mounted worker";
const FIRST_MESSAGE = "Mounted queue message one";
const EDITED_FIRST_MESSAGE = "Mounted queue message one, edited";
const SECOND_MESSAGE = "Mounted queue message two";
const THIRD_MESSAGE = "Mounted queue message three";

const MOUNTED_CHAIN_ENABLED = nonBlankEnvironment("JOKO_BROWSER_EXECUTABLE") !== undefined
  && nonBlankEnvironment("JOKO_MOUNTED_WEB_DIR") !== undefined;
const mountedIt = MOUNTED_CHAIN_ENABLED ? it : it.skip;

describe("mounted Collaboration Goal product chain", () => {
  let fixture: RealPiSystemFixture | undefined;
  let browser: Browser | undefined;

  afterEach(async ({ task }) => {
    if (task.result?.state === "fail") {
      try {
        const page = browser?.contexts()[0]?.pages()[0];
        if (page !== undefined) await captureCollaboration(page, "product-chain-failed", {
          connectionPageVisible: await page.locator(".connection-screen").isVisible(),
          dialogs: await page.getByRole("dialog").count(),
          locale: await page.locator("html").getAttribute("lang") ?? ""
        });
      } catch { console.info("Collaboration failure capture was unavailable."); }
    }
    await browser?.close();
    browser = undefined;
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
  });

  mountedIt("drives Queue editing, responsive focus, locale, lifecycle confirmation, and restart recovery through production Web", { timeout: 180_000 }, async (context) => {
    const executablePath = requiredEnvironment("JOKO_BROWSER_EXECUTABLE");
    const webDirectory = requiredEnvironment("JOKO_MOUNTED_WEB_DIR");
    fixture = await RealPiSystemFixture.start({
      webDirectory,
      keepRoot: true,
      enableInternalServer: true,
      providerResponder: ({ requestNumber }) => ({
        kind: "text",
        text: `MOUNTED_COLLABORATION_SETTLED_${requestNumber}`
      })
    });
    const rootDirectory = fixture.rootDirectory;
    const port = Number(new URL(fixture.baseUrl).port);
    const internalPort = fixture.application.config.internalPort;
    const paired = await fixture.pair("Mounted collaboration manager");
    const leadSessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({
        backendId: "pi",
        targetId: "workspace-real-pi",
        displayName: "Mounted collaboration lead",
        providerId: REAL_PI_PROVIDER_ID,
        modelId: REAL_PI_MODEL_ID,
        effortId: "off",
        permissionMode: PermissionMode.AUTO
      }),
      "mounted-collaboration-lead"
    ));

    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Mounted collaboration Web" });
    if (challenge.challenge === undefined) throw new Error("Mounted collaboration Web pairing returned no challenge.");
    const pairingCode = fixture.pairingCode(challenge.challenge.challengeId);
    const taskUrl = `${fixture.baseUrl}/#/tasks/${encodeURIComponent(leadSessionId)}`;

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 960 } });
    let generationBeforeRestart: bigint | undefined;
    let usagePhase = "initial", usageWindowStart = 0;
    const permittedUsageErrors: string[] = [];
    const { errors: browserErrors, settle: settleBrowserErrors, pauseUsageCapture, resumeUsageCapture, usageDiagnostics } = await observeBrowserErrors(
      page, new URL("/joko.v1.ProviderGroupService/GetTaskProviderGroupUsage", fixture.baseUrl).href, stale => {
        if (generationBeforeRestart === undefined || stale.sessionId !== leadSessionId
          || stale.generation <= 0n || stale.generation !== generationBeforeRestart || fixture === undefined) return false;
        const current = BigInt(fixture.application.store.getSession(leadSessionId).descriptor.binding.generation);
        if (stale.generation >= current) return false;
        permittedUsageErrors.push(stale.responseError, stale.consoleError);
        return true;
      }, usage => ({
        sessionMatchesOriginal: usage.sessionId === leadSessionId,
        generationPositive: usage.generation > 0n,
        vsOriginal: generationRelation(usage.generation, generationBeforeRestart),
        vsCurrent: generationRelation(usage.generation, fixture === undefined ? undefined
          : BigInt(fixture.application.store.getSession(leadSessionId).descriptor.binding.generation))
      }), () => usagePhase);
    context.onTestFailed(() => console.error("[collaboration-usage-classification]", JSON.stringify({
      phase: usagePhase, windowStartResponseCount: usageWindowStart, browserErrorCount: browserErrors.length,
      permittedErrorCount: permittedUsageErrors.length, ...usageDiagnostics()
    })));
    await page.goto(taskUrl, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.locator('details.device-authorization__manual > summary').click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(pairingCode);
    await page.getByLabel("Device name").fill("Mounted collaboration Web");
    await page.locator("form.pair-form button[type=submit]").click();

    const collaborationTrigger = page.getByRole("button", { name: "Open collaboration", exact: true });
    await collaborationTrigger.waitFor({ state: "visible", timeout: 30_000 });
    usagePhase = "initial-drain";
    await pauseUsageCapture();
    await settleBrowserErrors();
    browserErrors.splice(0);
    usagePhase = "active";
    await resumeUsageCapture();
    await collaborationTrigger.click();
    let panel = page.locator(".collaboration-panel");
    await panel.waitFor({ state: "visible" });
    await waitFor(
      () => panel.evaluate((node) => node.ownerDocument.activeElement === node),
      (focused) => focused,
      "the collaboration panel focus"
    );
    await panel.press("Escape");
    await panel.waitFor({ state: "hidden" });
    expect(await collaborationTrigger.evaluate((node) => node.ownerDocument.activeElement === node)).toBe(true);
    await collaborationTrigger.press("Enter");
    panel = page.locator(".collaboration-panel");
    await panel.waitFor({ state: "visible" });

    await panel.getByLabel("Goal title").fill(GOAL_TITLE);
    await panel.getByLabel("Objective").fill(GOAL_OBJECTIVE);
    await panel.getByLabel("Worker limit").fill("4");
    await panel.getByRole("button", { name: "Create Goal", exact: true }).click();
    await panel.getByText(GOAL_TITLE, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

    const listed = await waitFor(
      () => paired.clients.collaboration.listCollaborationGoals({ sessionId: leadSessionId, includeArchived: true }),
      (value) => value.access.some((entry) => entry.goal?.title === GOAL_TITLE),
      "the Goal created through production Web"
    );
    const goalId = required(
      listed.access.find((entry) => entry.goal?.title === GOAL_TITLE)?.goal?.goalId,
      "mounted Goal ID"
    );

    await panel.locator(".collaboration-panel__create-worker > summary").click();
    const workerForm = panel.locator(".collaboration-panel__create-worker form");
    await workerForm.getByLabel("Label").fill(WORKER_LABEL);
    await workerForm.getByLabel("Role").fill("Browser verifier");
    await workerForm.getByLabel("Initial assignment").fill("Return one deterministic mounted-browser result.");
    await workerForm.getByLabel("Permission").selectOption("auto");
    await workerForm.getByRole("button", { name: "Add worker", exact: true }).click();
    await panel.locator(".collaboration-worker").filter({ hasText: WORKER_LABEL }).waitFor({ state: "visible", timeout: 30_000 });

    let tree = required((await waitFor(
      () => paired.clients.collaboration.getCollaborationGoal({ goalId, viewerSessionId: leadSessionId }),
      (value) => value.tree?.workers.some((worker) => worker.label === WORKER_LABEL
        && worker.status === CollaborationWorkerStatus.COMPLETED) === true,
      "the worker created through production Web to settle",
      60_000
    )).tree, "settled mounted collaboration tree");
    const mountedWorker = required(tree.workers.find((worker) => worker.label === WORKER_LABEL), "mounted worker");
    // The initial assignment must settle in the actual Web projection too.
    // A backend-only read can otherwise race the next poll and submit stale CAS.
    await panel.locator(".collaboration-panel__worker-header").getByText("Completed", { exact: true })
      .waitFor({ state: "visible", timeout: 30_000 });
    const workerSessionId = required(mountedWorker.sessionId, "mounted worker Session");
    const queueControl = required(
      (await paired.clients.queue.getQueueControl({ sessionId: workerSessionId })).queueControl,
      "mounted worker Queue control"
    );
    await submit(
      paired.clients.operation,
      paired.connectionId,
      pauseQueueMutation(queueControl, "Hold mounted collaboration messages for Web Queue editing"),
      "mounted-collaboration-pause"
    );

    for (const message of [FIRST_MESSAGE, SECOND_MESSAGE, THIRD_MESSAGE]) {
      await panel.getByLabel("Message worker").fill(message);
      await panel.getByRole("button", { name: "Send", exact: true }).click();
      try {
        await panel.locator(".collaboration-queue-item").filter({ hasText: message }).waitFor({ state: "visible", timeout: 30_000 });
      } catch (error) {
        const diagnosticTree = await paired.clients.collaboration.getCollaborationGoal({
          goalId,
          viewerSessionId: leadSessionId
        });
        throw new Error(`${error instanceof Error ? error.message : String(error)} Diagnostics: ${JSON.stringify({
          panel: (await panel.innerText()).slice(-8_000),
          tree: diagnosticTree,
          queueControl: await paired.clients.queue.getQueueControl({ sessionId: workerSessionId }),
          operations: fixture.application.store.listOperations().slice(-12).map((operation) => ({
            kind: operation.kind,
            status: operation.status,
            error: operation.error
          }))
        }, bigintJson)}`, { cause: error });
      }
    }

    let firstCard = panel.locator(".collaboration-queue-item").filter({ hasText: FIRST_MESSAGE });
    await firstCard.getByRole("button", { name: "Edit queued message", exact: true }).click();
    await firstCard.locator("textarea").fill(EDITED_FIRST_MESSAGE);
    await firstCard.getByRole("button", { name: "Save", exact: true }).click();
    firstCard = panel.locator(".collaboration-queue-item").filter({ hasText: EDITED_FIRST_MESSAGE });
    await firstCard.waitFor({ state: "visible" });
    const secondCard = panel.locator(".collaboration-queue-item").filter({ hasText: SECOND_MESSAGE });
    await firstCard.getByLabel("Select queued message").check();
    await secondCard.getByLabel("Select queued message").check();
    await panel.getByRole("button", { name: "Merge selected", exact: true }).click();
    await waitFor(
      () => panel.locator(".collaboration-queue-item").count(),
      (count) => count === 2,
      "the merged Queue card count"
    );
    await panel.getByText(`${EDITED_FIRST_MESSAGE}\n\n${SECOND_MESSAGE}`, { exact: true }).waitFor({ state: "visible" });
    const thirdCard = panel.locator(".collaboration-queue-item").filter({ hasText: THIRD_MESSAGE });
    await thirdCard.getByRole("button", { name: "Cancel queued message", exact: true }).click();
    await thirdCard.waitFor({ state: "hidden" });

    tree = required((await paired.clients.collaboration.getCollaborationGoal({
      goalId,
      viewerSessionId: leadSessionId
    })).tree, "mounted Queue tree");
    expect(tree.queue).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dispatch: expect.objectContaining({
          message: `${EDITED_FIRST_MESSAGE}\n\n${SECOND_MESSAGE}`,
          status: CollaborationDispatchStatus.QUEUED
        })
      }),
      expect.objectContaining({
        dispatch: expect.objectContaining({ status: CollaborationDispatchStatus.MERGED })
      }),
      expect.objectContaining({
        dispatch: expect.objectContaining({ status: CollaborationDispatchStatus.CANCELLED })
      })
    ]));
    expect(await overflow(page)).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 390, height: 844 });
    await panel.getByText(WORKER_LABEL, { exact: true }).first().waitFor({ state: "visible" });
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    expect(await panel.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(`${fixture.baseUrl}/#/settings/general`);
    await page.getByLabel("Language", { exact: true }).click();
    await page.getByRole("option", { name: "简体中文", exact: true }).click();
    await waitFor(
      () => page.evaluate(() => document.documentElement.lang),
      (locale) => locale === "zh-CN",
      "the persisted Chinese locale"
    );
    await page.goto(taskUrl);
    const chineseTrigger = page.getByRole("button", { name: "打开协作面板", exact: true });
    await chineseTrigger.waitFor({ state: "visible", timeout: 30_000 });
    await chineseTrigger.click();
    panel = page.locator(".collaboration-panel");
    await panel.getByText(GOAL_TITLE, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("zh-CN");
    expect(await panel.locator(".collaboration-panel__goal-copy > small").textContent()).toContain("年");

    await panel.getByRole("button", { name: "停止 Goal", exact: true }).click();
    const stopDialog = page.getByRole("dialog", { name: "停止这个 Goal？" });
    await stopDialog.waitFor({ state: "visible" });
    await stopDialog.getByRole("button", { name: "取消", exact: true }).click();
    expect(required((await paired.clients.collaboration.getCollaborationGoal({
      goalId,
      viewerSessionId: leadSessionId
    })).tree, "Goal after cancelled stop").goal?.status).toBe(CollaborationGoalStatus.ACTIVE);

    await panel.getByRole("button", { name: "停止 Goal", exact: true }).click();
    await page.getByRole("dialog", { name: "停止这个 Goal？" })
      .getByRole("button", { name: "停止 Goal 与全部 Worker", exact: true }).click();
    tree = required((await waitFor(
      () => paired.clients.collaboration.getCollaborationGoal({ goalId, viewerSessionId: leadSessionId }),
      (value) => value.tree?.goal?.status === CollaborationGoalStatus.STOPPED
        && value.tree.workers.every((worker) => worker.status === CollaborationWorkerStatus.ARCHIVED && worker.runtimeReleased),
      "the confirmed Goal stop to archive every worker",
      30_000
    )).tree, "stopped mounted Goal tree");
    await panel.getByRole("button", { name: "归档 Goal", exact: true }).click();
    await panel.getByText("开始新的 Goal", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

    const authKey = paired.authKey;
    generationBeforeRestart = BigInt(fixture.application.store.getSession(leadSessionId).descriptor.binding.generation);
    usagePhase = "before-restart-drain";
    await pauseUsageCapture();
    await settleBrowserErrors();
    usagePhase = "service-stop";
    await fixture.close({ removeRoot: false });
    fixture = undefined;
    fixture = await RealPiSystemFixture.start({
      rootDirectory,
      webDirectory,
      port,
      internalPort,
      enableInternalServer: true,
      providerResponder: ({ requestNumber }) => ({
        kind: "text",
        text: `MOUNTED_COLLABORATION_RESTARTED_${requestNumber}`
      })
    });
    const restarted = fixture.clients(authKey);
    tree = required((await restarted.collaboration.getCollaborationGoal({
      goalId,
      viewerSessionId: leadSessionId
    })).tree, "restarted mounted Goal tree");
    expect(tree.goal?.status).toBe(CollaborationGoalStatus.ARCHIVED);
    expect(tree.workers).toEqual([
      expect.objectContaining({ status: CollaborationWorkerStatus.ARCHIVED, runtimeReleased: true })
    ]);
    expect(tree.queue).toEqual(expect.arrayContaining([
      expect.objectContaining({ dispatch: expect.objectContaining({ message: `${EDITED_FIRST_MESSAGE}\n\n${SECOND_MESSAGE}` }) })
    ]));

    usagePhase = "reconnect-document";
    // Neither retiring document should acquire a new capture before reload.
    await page.goto(taskUrl, { waitUntil: "domcontentloaded" });
    const restartedDocument = await page.reload({ waitUntil: "domcontentloaded" });
    expect(restartedDocument?.ok()).toBe(true);
    usagePhase = "reconnect-ready";
    await resumeUsageCapture();
    // Automatic entry was not enabled. Reopen the exact saved node from a
    // fresh document before verifying the archived Goal and durable queue.
    await page.locator(".connection-tabs > button").nth(1).click();
    await page.locator(".connection-card .profile-card").filter({ hasText: fixture.baseUrl })
      .getByRole("button", { name: /^(?:Connect|连接)$/u }).click();
    await page.getByRole("button", { name: "打开协作面板", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    usagePhase = "reconnect-drain";
    await pauseUsageCapture();
    await settleBrowserErrors();
    browserErrors.splice(0);
    permittedUsageErrors.splice(0);
    usageWindowStart = usageDiagnostics().responses400;
    usagePhase = "restarted-goal";
    await resumeUsageCapture();
    await page.getByRole("button", { name: "打开协作面板", exact: true }).click();
    panel = page.locator(".collaboration-panel");
    await panel.getByText(GOAL_TITLE, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await panel.getByText("开始新的 Goal", { exact: true }).waitFor({ state: "visible" });
    expect(await panel.getByLabel("Goal").locator("option").allTextContents()).toEqual([
      expect.stringContaining("已归档")
    ]);
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    usagePhase = "final-drain";
    await pauseUsageCapture();
    await settleBrowserErrors();
    expect(permittedUsageErrors.length).toBeLessThanOrEqual(2);
    expect(browserErrors.toSorted()).toEqual(permittedUsageErrors.toSorted());
    await captureCollaboration(page, "restarted-goal", {
      locale: await page.evaluate(() => document.documentElement.lang),
      goalArchived: tree.goal?.status === CollaborationGoalStatus.ARCHIVED,
      allWorkersReleased: tree.workers.every(worker => worker.runtimeReleased),
      browserErrors: browserErrors.length,
      staleUsageReads: permittedUsageErrors.length / 2
    });
  });
});

async function captureCollaboration(page: Page, name: string, state: Record<string, string | number | boolean>): Promise<void> {
  if (process.env.RUNNER_TEMP === undefined) return;
  const directory = join(process.env.RUNNER_TEMP, "joko-web-evidence", "collaboration");
  await mkdir(directory, { recursive: true });
  const screenshot = await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true, timeout: 5_000,
    mask: [page.getByLabel(/Pairing code|配对码|密码/iu), page.locator("input[type=password]")] });
  await writeFile(join(directory, `${name}.json`), JSON.stringify({ sourceCommit: process.env.GITHUB_SHA,
    ...state, screenshotSha256: createHash("sha256").update(screenshot).digest("hex") }, null, 2) + "\n");
}

type GenerationRelation = "unavailable" | "before" | "same" | "after";
type UsageRelations = { readonly sessionMatchesOriginal: boolean; readonly generationPositive: boolean;
  readonly vsOriginal: GenerationRelation; readonly vsCurrent: GenerationRelation };
type UsageFailure = { readonly capturePhase: string; readonly bodyState: string; readonly bodyBytes?: number;
  readonly codeMatches: boolean; readonly messageMatches: boolean };
type UsageReceipt = { readonly sequence: number; readonly capturePhase: string; readonly responsePhase: string;
  readonly bodyState: string; readonly bodyBytes?: number; readonly codeMatches: boolean; readonly messageMatches: boolean;
  requestProto: boolean; requestDecoded: boolean; relations?: UsageRelations; admitted: boolean; classification: string };
type UsageTransportFailure = { readonly capturePhase: string; readonly failurePhase: string;
  readonly stage: "fetch" | "fulfill"; readonly status?: number; readonly pageClosed: boolean;
  readonly requestAborted: boolean; readonly documentLoadRelation: "later-load-observed" | "same-observed-load";
  readonly interceptionUnavailable: boolean; readonly routeAlreadyHandled: boolean; readonly targetClosed: boolean;
  readonly connectionRefused: boolean; readonly connectionReset: boolean };

function generationRelation(value: bigint, expected: bigint | undefined): GenerationRelation {
  return expected === undefined ? "unavailable" : value < expected ? "before" : value === expected ? "same" : "after";
}

async function observeBrowserErrors(page: Page, usageUrl: string, onStaleUsage: (stale: {
  readonly sessionId: string; readonly generation: bigint; readonly responseError: string; readonly consoleError: string;
}) => boolean, describeUsage: (usage: { readonly sessionId: string; readonly generation: bigint }) => UsageRelations,
  phase: () => string
): Promise<{ readonly errors: string[]; readonly settle: () => Promise<void>;
  readonly pauseUsageCapture: () => Promise<void>; readonly resumeUsageCapture: () => Promise<void>;
  readonly usageDiagnostics: () => { captures: number; activeCaptures: number; responses400: number;
    receipts: readonly UsageReceipt[]; transportFailures: readonly UsageTransportFailure[] } }> {
  const errors: string[] = [];
  const pending = new Set<Promise<void>>();
  const capturePending = new Set<Promise<void>>();
  const usageFailures = new WeakMap<Request, UsageFailure>();
  const receipts: UsageReceipt[] = [];
  const transportFailures: UsageTransportFailure[] = [];
  let capturing = false, captures = 0, responses400 = 0, documentLoads = 0;
  page.on("domcontentloaded", () => { documentLoads++; });
  const captureUsage = async (route: Route): Promise<void> => {
    if (!capturing) { await route.continue(); return; }
    const capturePhase = phase(), captureDocumentLoad = documentLoads;
    let stage: "fetch" | "fulfill" = "fetch", status: number | undefined;
    const capture = (async () => {
      captures++;
      try {
        // Own this exact read-only response before document retirement can
        // evict Chromium's body. Unknown bodies remain classification failures.
        const response = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: 30_000 });
        status = response.status();
        if (response.status() === 400) {
          let bodyState = "unavailable", bodyBytes: number | undefined, codeMatches = false, messageMatches = false;
          try {
            const bytes = await response.body();
            bodyBytes = bytes.length;
            bodyState = "oversized";
            if (bytes.length <= 64 * 1024) {
              bodyState = "invalid-json";
              const failure = JSON.parse(bytes.toString("utf8")) as { code?: unknown; message?: unknown } | null;
              bodyState = "retained";
              codeMatches = failure?.code === "failed_precondition";
              messageMatches = failure?.message === "The original task generation is no longer current.";
            }
          } catch { /* Preserve the real response; no unknown refusal is admitted. */ }
          usageFailures.set(route.request(), { capturePhase, bodyState, bodyBytes, codeMatches, messageMatches });
        }
        stage = "fulfill";
        await route.fulfill({ response });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const pageClosed = page.isClosed(), requestAborted = route.request().failure()?.errorText === "net::ERR_ABORTED";
        if (transportFailures.length === 16) transportFailures.shift();
        transportFailures.push({ capturePhase, failurePhase: phase(), stage, status, pageClosed, requestAborted,
          // Report only the observed load relationship, never infer ownership
          // from a URL, a shared Frame, or the absence of a completed load.
          documentLoadRelation: documentLoads > captureDocumentLoad ? "later-load-observed" : "same-observed-load",
          interceptionUnavailable: /invalid interception\s*id/iu.test(message),
          routeAlreadyHandled: message.includes("Route is already handled"),
          targetClosed: message.includes("Target page, context or browser has been closed"),
          connectionRefused: message.includes("ECONNREFUSED"), connectionReset: message.includes("ECONNRESET") });
        if (!pageClosed && !requestAborted) {
          errors.push("requestfailed:GetTaskProviderGroupUsage:capture_transport_unavailable");
        }
        await route.abort("failed").catch(() => undefined);
      }
    })();
    capturePending.add(capture);
    try { await capture; } finally { capturePending.delete(capture); }
  };
  const pauseUsageCapture = async (): Promise<void> => {
    const wasCapturing = capturing;
    capturing = false;
    // Removing the interceptor forwards its in-flight routes in Playwright
    // 1.60. Complete each owned fulfill before releasing that interceptor.
    await Promise.all([...capturePending]);
    if (wasCapturing) await page.unroute(usageUrl, captureUsage);
  };
  const resumeUsageCapture = async (): Promise<void> => {
    if (!capturing) {
      capturing = true;
      await page.route(usageUrl, captureUsage);
    }
  };
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location();
      errors.push(`console:${message.text()}:${location.url}:${location.lineNumber}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const responseError = `response:${response.status()}:${response.url()}`;
    errors.push(responseError);
    const url = new URL(response.url());
    if (response.status() !== 400 || url.pathname !== "/joko.v1.ProviderGroupService/GetTaskProviderGroupUsage") return;
    const request = response.request(), failure = usageFailures.get(request);
    const receipt: UsageReceipt = { sequence: ++responses400, capturePhase: failure?.capturePhase ?? "uncaptured",
      responsePhase: phase(), bodyState: failure?.bodyState ?? "unretained", bodyBytes: failure?.bodyBytes,
      codeMatches: failure?.codeMatches === true, messageMatches: failure?.messageMatches === true,
      requestProto: false, requestDecoded: false, admitted: false, classification: "unclassified" };
    // Only the unchanged literal refusal and original submitted generation may
    // be admitted. Diagnostics expose relationships, never identities or bytes.
    const observation = (async () => {
      try {
        const bytes = request.postDataBuffer();
        receipt.requestProto = request.headers()["content-type"]?.startsWith("application/proto") === true;
        if (!receipt.requestProto || bytes === null || bytes.length > 64 * 1024) { receipt.classification = "invalid-request"; return; }
        const usage = fromBinary(GetTaskProviderGroupUsageRequestSchema, bytes);
        receipt.requestDecoded = true;
        receipt.relations = describeUsage(usage);
        if (!receipt.codeMatches || !receipt.messageMatches) { receipt.classification = "failure-unmatched"; return; }
        receipt.admitted = onStaleUsage({ sessionId: usage.sessionId, generation: usage.generation, responseError,
          consoleError: `console:Failed to load resource: the server responded with a status of 400 (Bad Request):${response.url()}:0` });
        receipt.classification = receipt.admitted ? "admitted" : "owner-unmatched";
      } catch { receipt.classification = receipt.requestDecoded ? "owner-unavailable" : "invalid-request"; }
      finally { if (receipts.length === 16) receipts.shift(); receipts.push(receipt); }
    })();
    pending.add(observation);
    void observation.finally(() => pending.delete(observation));
  });
  await resumeUsageCapture();
  return { errors, pauseUsageCapture, resumeUsageCapture,
    settle: async () => { await Promise.all([...pending]); },
    usageDiagnostics: () => ({ captures, activeCaptures: capturePending.size, responses400,
      receipts: receipts.map(receipt => ({ ...receipt })), transportFailures: transportFailures.map(failure => ({ ...failure })) }) };
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

function required<T>(value: T | null | undefined | "", label: string): T {
  if (value === undefined || value === null || value === "") throw new Error(`${label} is required.`);
  return value;
}

function nonBlankEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function requiredEnvironment(name: string): string {
  return required(nonBlankEnvironment(name), `${name} for the mounted Collaboration Goal E3`);
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
