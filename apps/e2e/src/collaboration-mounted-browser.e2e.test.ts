import {
  CollaborationDispatchStatus,
  CollaborationGoalStatus,
  CollaborationWorkerStatus,
  PermissionMode
} from "@joko/contracts";
import { chromium, type Browser, type Page } from "playwright-core";
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

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
  });

  mountedIt("drives Queue editing, responsive focus, locale, lifecycle confirmation, and restart recovery through production Web", { timeout: 180_000 }, async () => {
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const browserErrors = observeBrowserErrors(page);
    await page.goto(taskUrl, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(pairingCode);
    await page.getByLabel("Device name").fill("Mounted collaboration Web");
    await page.locator("form.pair-form button[type=submit]").click();

    const collaborationTrigger = page.getByRole("button", { name: "Open collaboration", exact: true });
    await collaborationTrigger.waitFor({ state: "visible", timeout: 30_000 });
    browserErrors.splice(0);
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
        && [CollaborationWorkerStatus.IDLE, CollaborationWorkerStatus.COMPLETED].includes(worker.status)) === true,
      "the worker created through production Web to settle",
      60_000
    )).tree, "settled mounted collaboration tree");
    const mountedWorker = required(tree.workers.find((worker) => worker.label === WORKER_LABEL), "mounted worker");
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

    await page.goto(taskUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "打开协作面板", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    browserErrors.splice(0);
    await page.getByRole("button", { name: "打开协作面板", exact: true }).click();
    panel = page.locator(".collaboration-panel");
    await panel.getByText(GOAL_TITLE, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await panel.getByText("开始新的 Goal", { exact: true }).waitFor({ state: "visible" });
    expect(await panel.getByLabel("Goal").locator("option").allTextContents()).toEqual([
      expect.stringContaining("已归档")
    ]);
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    expect(browserErrors).toEqual([]);
  });
});

function observeBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location();
      errors.push(`console:${message.text()}:${location.url}:${location.lineNumber}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`response:${response.status()}:${response.url()}`);
  });
  return errors;
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
