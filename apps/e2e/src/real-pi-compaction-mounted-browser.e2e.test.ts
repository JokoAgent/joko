import { create } from "@bufbuild/protobuf";
import {
  CompactionState,
  RunState,
  SessionSnapshotScopeSchema,
  SnapshotScopeSchema
} from "@joko/contracts";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";

const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim()
  && process.env.JOKO_MOUNTED_WEB_DIR?.trim() ? it : it.skip;

describe("mounted Pi compaction product chain", () => {
  let fixture: RealPiSystemFixture | undefined;
  let browser: Browser | undefined;
  let releasePendingProvider: (() => void) | undefined;

  afterEach(async () => {
    releasePendingProvider?.();
    releasePendingProvider = undefined;
    await browser?.close();
    browser = undefined;
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
  });

  mountedIt("keeps typed manual outcomes, route ownership, live feedback and restart recovery aligned", { timeout: 180_000 }, async () => {
    let releaseSummary: (() => void) | undefined;
    let holdNextSummary = false;
    let failSummary = false;
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
    releasePendingProvider = releaseSummary;
    fixture = await RealPiSystemFixture.start({
      webDirectory: process.env.JOKO_MOUNTED_WEB_DIR!,
      keepRoot: true,
      enableInternalServer: true,
      piSettings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
      providerResponder: async ({ requestNumber }) => {
        if (holdNextSummary) {
          holdNextSummary = false;
          await summaryGate;
        }
        if (failSummary) throw new Error("Controlled compaction Provider failure.");
        return { kind: "text", text: `Mounted Pi reply ${requestNumber}` };
      }
    });
    const rootDirectory = fixture.rootDirectory;
    const webDirectory = process.env.JOKO_MOUNTED_WEB_DIR!;
    const port = Number(new URL(fixture.baseUrl).port);
    const internalPort = fixture.application.config.internalPort;
    const manager = await fixture.pair("Mounted Pi compaction manager");
    const createSession = async (name: string) => sessionIdFrom(await submit(
      manager.clients.operation,
      manager.connectionId,
      createSessionMutation({
        backendId: "pi",
        targetId: "workspace-real-pi",
        displayName: name,
        providerId: REAL_PI_PROVIDER_ID,
        modelId: REAL_PI_MODEL_ID,
        effortId: "off"
      })
    ));
    const compactSessionId = await createSession("Mounted compact outcomes");
    const otherSessionId = await createSession("Mounted route owner");
    const failingSessionId = await createSession("Mounted compact failure");
    const send = async (sessionId: string, text: string) => {
      const generation = BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation);
      const queued = await submit(manager.clients.operation, manager.connectionId,
        sendInputMutation(sessionId, generation, text));
      const runId = queueRunIdFrom(queued);
      await waitFor(() => manager.clients.run.getRun({ runId }),
        (response) => response.run?.state === RunState.SUCCEEDED, `Pi turn: ${text}`, 30_000);
    };
    const timelineStates = async (sessionId: string) => {
      const response = await manager.clients.event.getSnapshot({ scope: create(SnapshotScopeSchema, {
        kind: { case: "session", value: create(SessionSnapshotScopeSchema, { sessionId, recentTimelineItems: 500 }) }
      }) });
      return (response.snapshot?.timeline ?? []).flatMap((item) => item.payload?.kind.case === "compactionChanged"
        ? [item.payload.kind.value.state] : []);
    };
    await send(compactSessionId, "One turn for a manual Pi compaction.");

    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Mounted Pi compact Web" });
    if (challenge.challenge === undefined) throw new Error("Mounted Web pairing returned no challenge.");
    const pairingCode = fixture.pairingCode(challenge.challenge.challengeId);
    const taskUrl = (sessionId: string) => `${fixture!.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`;
    browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = observeBrowserErrors(page);
    await page.goto(taskUrl(compactSessionId), { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(pairingCode);
    await page.getByLabel("Device name").fill("Mounted Pi compact Web");
    await page.locator("form.pair-form button[type=submit]").click();

    const trigger = page.getByRole("button", { name: "Click to compact context" });
    await trigger.waitFor({ state: "visible", timeout: 30_000 });
    errors.splice(0);
    await trigger.click();
    const confirmation = page.getByRole("dialog", { name: "Compact context?" });
    await confirmation.waitFor({ state: "visible" });
    const cancel = confirmation.getByRole("button", { name: "Cancel" });
    expect(await cancel.evaluate((element) => element === document.activeElement)).toBe(true);
    await cancel.press("Escape");
    await confirmation.waitFor({ state: "hidden" });
    await waitFor(() => trigger.evaluate((element) => element === document.activeElement),
      (focused) => focused, "focus returning to the active compact control");
    expect(await timelineStates(compactSessionId)).toEqual([]);

    await trigger.click();
    await confirmation.getByRole("button", { name: "Compact", exact: true }).click();
    const feedback = page.locator(".compact-action-feedback");
    await page.locator(".compact-action-feedback--compacted").waitFor({ state: "visible", timeout: 30_000 });
    expect(await feedback.getAttribute("role")).toBe("status");
    expect(await feedback.getAttribute("aria-live")).toBe("polite");
    expect(await feedback.innerText()).toContain("Context compacted");
    expect(await timelineStates(compactSessionId)).toContain(CompactionState.COMPLETED);
    await feedback.getByRole("button", { name: "Dismiss" }).click();

    await trigger.click();
    await confirmation.getByRole("button", { name: "Compact", exact: true }).click();
    await page.locator(".compact-action-feedback--noop").waitFor({ state: "visible", timeout: 30_000 });
    expect(await feedback.innerText()).toContain("already compact");
    expect(await timelineStates(compactSessionId)).toContain(CompactionState.NO_OP);
    await feedback.getByRole("button", { name: "Dismiss" }).click();

    await send(compactSessionId, "A new turn after compaction is available to summarize.");
    const requestsBeforeSummary = fixture.providerRequests.length;
    holdNextSummary = true;
    await trigger.click();
    await confirmation.getByRole("button", { name: "Compact", exact: true }).click();
    await waitFor(() => Promise.resolve(fixture!.providerRequests.length), (count) => count > requestsBeforeSummary,
      "the installed Pi summary request", 30_000);
    await page.evaluate((sessionId) => { window.location.hash = `/tasks/${encodeURIComponent(sessionId)}`; }, otherSessionId);
    await page.getByText("Mounted route owner", { exact: true }).first().waitFor({ state: "visible" });
    releaseSummary?.();
    releasePendingProvider = undefined;
    await waitFor(() => timelineStates(compactSessionId),
      (states) => states.includes(CompactionState.COMPLETED), "completed native compaction", 30_000);
    expect(await page.locator(".compact-action-feedback").count()).toBe(0);
    await page.evaluate((sessionId) => { window.location.hash = `/tasks/${encodeURIComponent(sessionId)}`; }, compactSessionId);
    await page.getByText("Context compacted", { exact: true }).first().waitFor({ state: "visible", timeout: 30_000 });

    await send(failingSessionId, "First turn for a genuine Provider failure.");
    await send(failingSessionId, "Second turn for a genuine Provider failure.");
    await page.evaluate((sessionId) => { window.location.hash = `/tasks/${encodeURIComponent(sessionId)}`; }, failingSessionId);
    const failingTrigger = page.getByRole("button", { name: "Click to compact context" });
    await failingTrigger.waitFor({ state: "visible" });
    failSummary = true;
    await failingTrigger.click();
    await confirmation.getByRole("button", { name: "Compact", exact: true }).click();
    const failure = page.locator(".compact-action-feedback--failure");
    await failure.waitFor({ state: "visible", timeout: 30_000 }).catch(async (error: unknown) => {
      throw new Error(`Mounted Pi failure feedback was absent: ${JSON.stringify({
        feedback: await page.locator(".compact-action-feedback").allTextContents(),
        timeline: await timelineStates(failingSessionId),
        providerRequests: fixture!.providerRequests.length
      })}`, { cause: error });
    });
    failSummary = false;
    expect(await failure.getAttribute("role")).toBe("alert");
    expect(await failure.getAttribute("aria-live")).toBe("assertive");
    expect(await failure.innerText()).toContain("Couldn't compact context");
    const failureStates = await timelineStates(failingSessionId);
    expect(failureStates).toContain(CompactionState.FAILED);
    expect(failureStates).not.toContain(CompactionState.NO_OP);
    expect(errors.filter((error) => error.startsWith("pageerror:"))).toEqual([]);
    // The controlled Provider refusal is intentionally surfaced as HTTP 503.
    errors.splice(0);

    const authKey = manager.authKey;
    await fixture.close({ removeRoot: false });
    fixture = undefined;
    fixture = await RealPiSystemFixture.start({
      rootDirectory, webDirectory, port, internalPort, enableInternalServer: true,
      piSettings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } }
    });
    const reconnected = fixture.clients(authKey);
    const restartedTimeline = await reconnected.event.getSnapshot({ scope: create(SnapshotScopeSchema, {
      kind: { case: "session", value: create(SessionSnapshotScopeSchema, {
        sessionId: compactSessionId, recentTimelineItems: 500
      }) }
    }) });
    expect(restartedTimeline.snapshot?.timeline.some((item) => item.payload?.kind.case === "compactionChanged"
      && item.payload.kind.value.state === CompactionState.COMPLETED)).toBe(true);
    await page.goto(taskUrl(compactSessionId), { waitUntil: "domcontentloaded" });
    await page.getByText("Context compacted", { exact: true }).first().waitFor({ state: "visible", timeout: 30_000 });
    expect(await page.locator(".compact-action-feedback").count()).toBe(0);
    // Background Connect polls may fail while the service is deliberately stopped.
    errors.splice(0);
    await send(compactSessionId, "The same native Pi context continues after service restart.");
    expect(errors).toEqual([]);
  });

  mountedIt.each([
    {
      reason: "threshold" as const,
      settings: { compaction: { enabled: true, thresholdPercent: 50, keepRecentTokens: 1 } },
      usage: { promptTokens: 10_000, completionTokens: 3 },
      overflowRequests: [] as number[],
      expectedStatus: "Auto-compacting..."
    },
    {
      reason: "overflow" as const,
      settings: { compaction: { enabled: true, thresholdPercent: 95, keepRecentTokens: 1 } },
      usage: { promptTokens: 7, completionTokens: 3 },
      overflowRequests: [2],
      expectedStatus: "Context overflow detected, auto-compacting..."
    }
  ])("shows the installed Pi $reason trigger through production Web live status", async ({
    reason, settings, usage, overflowRequests, expectedStatus
  }) => {
    let releaseSummary: (() => void) | undefined;
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
    releasePendingProvider = releaseSummary;
    fixture = await RealPiSystemFixture.start({
      webDirectory: process.env.JOKO_MOUNTED_WEB_DIR!,
      piSettings: settings,
      providerUsage: usage,
      overflowRequestNumbers: overflowRequests,
      providerResponder: async ({ request, requestNumber }) => {
        if (JSON.stringify(request.body).includes("You are a context summarization assistant")) await summaryGate;
        return { kind: "text", text: `Mounted automatic Pi reply ${requestNumber}` };
      }
    });
    const manager = await fixture.pair(`Mounted Pi ${reason} manager`);
    const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
      createSessionMutation({
        backendId: "pi", targetId: "workspace-real-pi", displayName: `Mounted Pi ${reason}`,
        providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, effortId: "off"
      })));
    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Mounted Pi automatic Web" });
    if (challenge.challenge === undefined) throw new Error("Mounted Web pairing returned no challenge.");
    const pairingCode = fixture.pairingCode(challenge.challenge.challengeId);
    browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = observeBrowserErrors(page);
    await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(pairingCode);
    await page.getByLabel("Device name").fill("Mounted Pi automatic Web");
    await page.locator("form.pair-form button[type=submit]").click();
    await page.locator("main.session-pane").waitFor({ state: "visible", timeout: 30_000 });
    errors.splice(0);

    const send = async (text: string) => {
      const generation = BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation);
      const queued = await submit(manager.clients.operation, manager.connectionId,
        sendInputMutation(sessionId, generation, text));
      return queueRunIdFrom(queued);
    };
    if (reason === "overflow") {
      const firstRunId = await send("Establish context before overflow.");
      await waitFor(() => manager.clients.run.getRun({ runId: firstRunId }),
        (response) => response.run?.state === RunState.SUCCEEDED, "pre-overflow Pi turn", 30_000);
    }
    const runId = await send(`Trigger installed Pi ${reason} compaction.`);
    await waitFor(() => Promise.resolve(fixture!.providerRequests.some((request) =>
      JSON.stringify(request.body).includes("You are a context summarization assistant"))),
    (seen) => seen, `${reason} summary request`, 30_000);
    const status = page.locator(".compaction-status-indicator");
    await status.waitFor({ state: "visible", timeout: 30_000 });
    expect(await status.getAttribute("role")).toBe("status");
    expect(await status.getAttribute("aria-live")).toBe("polite");
    expect(await status.innerText()).toContain(expectedStatus);
    releaseSummary?.();
    releasePendingProvider = undefined;
    await waitFor(() => manager.clients.run.getRun({ runId }),
      (response) => response.run?.state === RunState.SUCCEEDED, `${reason} Pi turn`, 30_000);
    await page.getByText("Context compacted", { exact: true }).first().waitFor({ state: "visible", timeout: 30_000 });
    await status.waitFor({ state: "hidden", timeout: 30_000 });
    expect(errors.filter((error) => error.startsWith("pageerror:"))).toEqual([]);
  }, 120_000);
});

function observeBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });
  return errors;
}
