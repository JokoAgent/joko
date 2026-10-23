import { create, fromBinary } from "@bufbuild/protobuf";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CompactionState,
  GetTaskProviderGroupUsageRequestSchema,
  RunState,
  SessionAttentionAcknowledgementIntent,
  SessionSnapshotScopeSchema,
  SnapshotScopeSchema,
  SubmitOperationRequestSchema
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
  let failureState: (() => Promise<unknown>) | undefined;

  afterEach(async ({ task }) => {
    if (task.result?.state === "fail" && browser !== undefined) {
      try {
        const page = browser.contexts()[0]?.pages()[0];
        console.error("Mounted compaction failure state", JSON.stringify({
          server: await failureState?.(),
          page: (await page?.locator("body").innerText())?.slice(0, 6_000),
          rings: await page?.locator(".context-capacity-ring").evaluateAll((elements) =>
            elements.map((element) => element.outerHTML.slice(0, 2_000)))
        }));
        if (page !== undefined && process.env.RUNNER_TEMP !== undefined) {
          const directory = join(process.env.RUNNER_TEMP, "joko-web-evidence", "compaction");
          await mkdir(directory, { recursive: true });
          await page.screenshot({ path: join(directory, task.name.includes("overflow")
            ? "overflow-failed.png" : task.name.includes("threshold") ? "threshold-failed.png" : "manual-failed.png"),
          fullPage: true, timeout: 5_000 });
        }
      } catch {
        console.error("Mounted compaction failure evidence was unavailable.");
      }
    }
    failureState = undefined;
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
    failureState = async () => {
      const { session } = await manager.clients.session.getSession({ sessionId: compactSessionId });
      return { state: session?.state, compacting: session?.contextState?.compacting,
        usedTokens: session?.context?.usedTokens.toString(),
        compactions: fixture!.application.store.listEvents({ sessionId: compactSessionId })
          .flatMap((event) => event.payload.type === "compaction"
            ? [{ state: event.payload.state, reason: event.payload.reason }] : []).slice(-8) };
    };
    const otherSessionId = await createSession("Mounted route owner");
    const failingSessionId = await createSession("Mounted compact failure");
    const send = async (sessionId: string, text: string) => {
      const generation = BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation);
      const queued = await submit(manager.clients.operation, manager.connectionId,
        sendInputMutation(sessionId, generation, text));
      const runId = queueRunIdFrom(queued);
      await waitFor(() => manager.clients.run.getRun({ runId }),
        (response) => response.run?.state === RunState.SUCCEEDED, `Pi turn: ${text}`, 30_000);
      return runId;
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
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 960 } });
    let attentionBeforeResume: bigint | undefined;
    const permittedAttentionErrors: string[] = [];
    const permittedUsageErrors: string[] = [];
    const permittedAttentionCursors: { submitted: string; current: string; generation: string }[] = [];
    const errors = observeBrowserErrors(page, conflict => {
      if (attentionBeforeResume === undefined || conflict.sessionId !== compactSessionId
        || conflict.intent !== SessionAttentionAcknowledgementIntent.VIEWED) return;
      const current = fixture!.application.store.getSessionAttention(compactSessionId);
      if (conflict.generation !== BigInt(current.attentionGeneration) || conflict.sequence <= 0n
        || conflict.sequence >= current.attentionCursor) return;
      permittedAttentionErrors.push(conflict.responseError, conflict.consoleError);
      permittedAttentionCursors.push({ submitted: conflict.sequence.toString(), current: current.attentionCursor.toString(),
        generation: conflict.generation.toString() });
    }, stale => {
      if (attentionBeforeResume === undefined || stale.sessionId !== compactSessionId) return;
      const generation = BigInt(fixture!.application.store.getSession(compactSessionId).descriptor.binding.generation);
      if (stale.generation <= 0n || stale.generation >= generation) return;
      permittedUsageErrors.push(stale.responseError, stale.consoleError);
    });
    await page.goto(taskUrl(compactSessionId), { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(pairingCode);
    await page.getByLabel("Device name").fill("Mounted Pi compact Web");
    await page.locator("form.pair-form button[type=submit]").click();

    const trigger = page.getByRole("button", { name: "Click to compact context" });
    try {
      await trigger.waitFor({ state: "visible", timeout: 30_000 });
    } catch (error) {
      throw new Error(`The mounted compact control was unavailable: ${JSON.stringify({
        page: (await page.locator("body").innerText()).slice(0, 5_000),
        rings: await page.locator(".context-capacity-ring").allTextContents()
      })}`, { cause: error });
    }
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
    attentionBeforeResume = fixture.application.store.getSessionAttention(compactSessionId).attentionCursor;
    const continuationRunId = await send(compactSessionId, "The same native Pi context continues after service restart.");
    const completion = await waitFor(async () => fixture!.application.store.listEvents({ sessionId: compactSessionId })
      .findLast(event => event.runId === continuationRunId && event.payload.type === "done" && event.payload.outcome === "completed"),
    event => event !== undefined, "the resumed native completion", 30_000);
    if (completion === undefined) throw new Error("The resumed Pi Run has no durable completion.");
    const acknowledged = await waitFor(() => reconnected.session.getSession({ sessionId: compactSessionId }), response => {
      const attention = response.session?.attention;
      return attention?.unread === false && (attention.readThroughCursor?.sequence ?? 0n) >= completion.globalCursor
        && attention.readThroughCursor?.sequence === attention.attentionCursor?.sequence
        && attention.readThroughCursor?.generation === attention.attentionCursor?.generation;
    }, "the mounted page to acknowledge the latest resumed projection", 30_000);
    if (process.env.RUNNER_TEMP !== undefined) {
      const directory = join(process.env.RUNNER_TEMP, "joko-web-evidence", "compaction");
      const attention = acknowledged.session!.attention!;
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "manual-attention-recovery.json"), JSON.stringify({
        sourceCommit: process.env.GITHUB_SHA ?? "working-tree",
        staleViewedAcknowledgements: permittedAttentionErrors.length / 2,
        staleViewedCursors: permittedAttentionCursors,
        preResumeCursor: attentionBeforeResume.toString(),
        nativeCompletionCursor: completion.globalCursor.toString(),
        readThroughCursor: attention.readThroughCursor?.sequence.toString(),
        readThroughGeneration: attention.readThroughCursor?.generation.toString(),
        attentionCursor: attention.attentionCursor?.sequence.toString(),
        attentionGeneration: attention.attentionCursor?.generation.toString(),
        unread: attention.unread
      }, null, 2));
    }
    expect(permittedAttentionErrors.length).toBeLessThanOrEqual(2);
    expect(permittedUsageErrors.length).toBeLessThanOrEqual(2);
    expect(errors.toSorted()).toEqual([...permittedAttentionErrors, ...permittedUsageErrors].toSorted());
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
    failureState = async () => {
      const { session } = await manager.clients.session.getSession({ sessionId });
      return { state: session?.state, compacting: session?.contextState?.compacting,
        usedTokens: session?.context?.usedTokens.toString(),
        compactions: fixture!.application.store.listEvents({ sessionId })
          .flatMap((event) => event.payload.type === "compaction"
            ? [{ state: event.payload.state, reason: event.payload.reason }] : []).slice(-8) };
    };
    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Mounted Pi automatic Web" });
    if (challenge.challenge === undefined) throw new Error("Mounted Web pairing returned no challenge.");
    const pairingCode = fixture.pairingCode(challenge.challenge.challengeId);
    browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 960 } });
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

interface StaleViewedAcknowledgement {
  readonly sessionId: string;
  readonly sequence: bigint;
  readonly generation: bigint;
  readonly intent: SessionAttentionAcknowledgementIntent;
  readonly responseError: string;
  readonly consoleError: string;
}

function observeBrowserErrors(page: Page, onAttentionConflict?: (conflict: StaleViewedAcknowledgement) => void,
  onStaleUsage?: (stale: { sessionId: string; generation: bigint; responseError: string; consoleError: string }) => void): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("response", async (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    let operation = "";
    let acknowledgement: Omit<StaleViewedAcknowledgement, "responseError" | "consoleError"> | undefined;
    if (url.pathname === "/joko.v1.OperationService/SubmitOperation") {
      operation = ":operation=unavailable";
      const request = response.request();
      const bytes = request.postDataBuffer();
      if (request.headers()["content-type"]?.startsWith("application/proto") && bytes !== null && bytes.length <= 64 * 1024) {
        try {
          const mutation = fromBinary(SubmitOperationRequestSchema, bytes).mutation?.payload;
          operation = `:operation=${mutation?.case ?? "unavailable"}`;
          if (mutation?.case === "acknowledgeSessionAttention") {
            operation += `:cursorGeneration=${mutation.value.throughCursor?.generation.toString() ?? "unavailable"}:intent=${mutation.value.intent}`;
            if (mutation.value.throughCursor !== undefined) acknowledgement = {
              sessionId: mutation.value.sessionId, sequence: mutation.value.throughCursor.sequence,
              generation: mutation.value.throughCursor.generation, intent: mutation.value.intent
            };
          }
        } catch { /* Never include request bytes or free-form decode failures. */ }
      }
    }
    const responseError = `response:${response.status()}:${response.request().method()}:${url.origin}${url.pathname}${operation}`;
    errors.push(responseError);
    // A resume can retire the observed generation between rendering and its read-only quota request.
    // Admit only the exact old-generation request; the caller checks it against durable server state.
    if (response.status() === 400 && url.pathname === "/joko.v1.ProviderGroupService/GetTaskProviderGroupUsage") {
      const request = response.request(), bytes = request.postDataBuffer();
      if (request.headers()["content-type"]?.startsWith("application/proto") && bytes !== null && bytes.length <= 64 * 1024) {
        try {
          const usage = fromBinary(GetTaskProviderGroupUsageRequestSchema, bytes);
          const failure = await response.json() as { code?: string; message?: string };
          if (failure.code !== "failed_precondition" || failure.message !== "The original task generation is no longer current.") return;
          onStaleUsage?.({ sessionId: usage.sessionId, generation: usage.generation, responseError,
            consoleError: `console:Failed to load resource: the server responded with a status of 400 (Bad Request):${url.origin}${url.pathname}` });
        } catch { /* Keep unknown responses as failures. */ }
      }
    }
    if (response.status() === 409 && acknowledgement !== undefined) onAttentionConflict?.({
      ...acknowledgement, responseError,
      consoleError: `console:Failed to load resource: the server responded with a status of 409 (Conflict):${url.origin}${url.pathname}`
    });
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    let location = "";
    try {
      const url = new URL(message.location().url);
      location = `${url.origin}${url.pathname}`.slice(0, 512);
    } catch { /* Some browser errors have no source location. */ }
    errors.push(`console:${message.text()}:${location}`);
  });
  return errors;
}
