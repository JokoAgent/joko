import { fromBinary } from "@bufbuild/protobuf";
import { RunState, SubmitOperationRequestSchema } from "@joko/contracts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";

const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim() && process.env.JOKO_MOUNTED_WEB_DIR?.trim() ? it : it.skip;

mountedIt.each(["stop-button", "delayed-escape"] as const)(
  "stops the original Pi turn from automatic retry with %s",
  { timeout: 120_000 },
  async (entry) => {
    let releaseStop: (() => void) | undefined;
    let releaseProviderReply: (() => void) | undefined;
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve; });
    const providerReplyGate = new Promise<void>(resolve => { releaseProviderReply = resolve; });
    let fixture: RealPiSystemFixture | undefined;
    let browser: Browser | undefined;
    let page: Page | undefined;
    const evidence = process.env.RUNNER_TEMP === undefined ? undefined
      : join(process.env.RUNNER_TEMP, "joko-web-evidence", "pi-retry-stop", entry);
    try {
      fixture = await RealPiSystemFixture.start({
        webDirectory: process.env.JOKO_MOUNTED_WEB_DIR!,
        piSettings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 8_000, provider: { maxRetries: 0 } } },
        providerResponder: async ({ requestNumber }) => {
          if (requestNumber <= 2) throw new Error("Provider at capacity");
          await providerReplyGate;
          return { kind: "text", text: "The retry reply should never reach the original task." };
        }
      });
      const system = fixture;
      const manager = await system.pair("Pi retry manager");
      const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId, createSessionMutation({
        backendId: "pi", targetId: "workspace-real-pi", displayName: "Stop the original Pi retry", providerId: REAL_PI_PROVIDER_ID,
        modelId: REAL_PI_MODEL_ID, effortId: "off"
      })));
      const browserName = "Pi retry browser";
      const { challenge } = await system.anonymous.connection.beginPairing({ deviceDisplayName: browserName });
      if (challenge === undefined) throw new Error("The original browser pairing challenge was missing.");
      browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
      page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 960 } });
      await page.goto(`${system.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
      await page.locator(".connection-tabs > button").nth(2).click();
      await page.locator("details.device-authorization__manual > summary").click();
      await page.getByLabel("Joko node address").fill(system.baseUrl);
      await page.getByLabel("Pairing code").fill(system.pairingCode(challenge.challengeId));
      await page.getByLabel("Device name").fill(browserName);
      await page.locator("form.pair-form button[type=submit]").click();
      const pane = page.locator(`.session-pane[data-input-session-id='${sessionId}']`);
      await pane.waitFor({ state: "visible", timeout: 30_000 });

      const stopMutations: Array<{ kind: "abortRun" | "abortRetry"; runId: string; operationId: string }> = [];
      await page.route("**/joko.v1.OperationService/SubmitOperation", async route => {
        const bytes = route.request().postDataBuffer();
        if (bytes === null) return route.continue();
        const request = fromBinary(SubmitOperationRequestSchema, bytes);
        const mutation = request.mutation?.payload;
        if (mutation?.case !== "abortRun" && mutation?.case !== "abortRetry") return route.continue();
        stopMutations.push({ kind: mutation.case, runId: mutation.value.runId, operationId: request.operationId });
        if (entry === "delayed-escape") await stopGate;
        await route.continue();
      });

      const store = system.application.store;
      const binding = store.getSession(sessionId).descriptor.binding;
      const send = await submit(manager.clients.operation, manager.connectionId,
        sendInputMutation(sessionId, BigInt(binding.generation), "Keep this original input while stopping its retry."));
      const runId = queueRunIdFrom(send);
      const sourceRun = () => store.getRun(runId).descriptor;
      const sourceQueue = () => store.findQueueItemByRunId(sessionId, runId);
      const retryNotice = pane.locator(".retry-status-indicator");
      const stop = pane.getByRole("button", { name: "Abort run", exact: true });
      await retryNotice.waitFor({ state: "visible", timeout: 35_000 });
      expect(await retryNotice.innerText()).toContain("Retrying (2/2)");
      expect(system.providerRequests).toHaveLength(2);
      expect(sourceRun().state).toBe("retrying");
      const originalAttemptId = sourceRun().activeAttemptId;
      expect(originalAttemptId).toBeDefined();
      expect(sourceQueue()?.state).toBe("backend_accepted");

      if (entry === "stop-button") {
        await stop.click();
      } else {
        await stop.press("Escape");
        await waitFor(async () => stopMutations[0], value => value !== undefined, "the original Escape mutation in transit");
        await waitFor(async () => system.providerRequests.length, count => count === 3, "the original Run's next native provider request", 30_000);
        expect(sourceRun().activeAttemptId).toBe(originalAttemptId);
        expect(sourceQueue()?.state).toBe("backend_accepted");
        releaseStop?.();
      }

      const terminal = await waitFor(() => manager.clients.run.getRun({ runId }), ({ run }) => run?.state === RunState.ABORTED
        || run?.state === RunState.FAILED || run?.state === RunState.SUCCEEDED, "the original Run terminal state", 20_000);
      expect(terminal.run?.state).toBe(RunState.ABORTED);
      expect(stopMutations).toEqual([{ kind: "abortRun", runId, operationId: expect.any(String) }]);
      const stopOperationId = stopMutations[0]!.operationId;
      const receipt = await waitFor(async () => store.getOperation(stopOperationId), value => value.status === "completed",
        "the original Stop operation receipt");
      expect(receipt.kind).toBe("abortRun");
      await waitFor(async () => sourceQueue()?.state, state => state === "cancelled", "the original queue item cancellation");
      await retryNotice.waitFor({ state: "hidden", timeout: 20_000 });
      const payloads = store.listEvents({ sessionId, limit: 100 }).filter(event => event.runId === runId).map(event => event.payload);
      expect(payloads).toContainEqual(expect.objectContaining({ type: "done", outcome: "aborted" }));
      expect(payloads).not.toContainEqual(expect.objectContaining({ type: "retry", state: "exhausted" }));
      expect(payloads).not.toContainEqual(expect.objectContaining({ type: "error", error: expect.objectContaining({ code: "PI_RETRY_EXHAUSTED" }) }));
      if (entry === "stop-button") expect(payloads).toContainEqual(expect.objectContaining({ type: "retry", state: "aborted" }));
      expect(system.providerRequests).toHaveLength(entry === "stop-button" ? 2 : 3);
      expect(store.getSession(sessionId).descriptor.binding).toEqual(binding);
      if (evidence !== undefined) {
        await mkdir(evidence, { recursive: true });
        await writeFile(join(evidence, "original-stop.json"), JSON.stringify({
          entry, sessionId, runId, attemptId: originalAttemptId, stopMutations, receipt: receipt.status,
          queueId: sourceQueue()?.id, queueState: sourceQueue()?.state, runState: sourceRun().state,
          providerRequests: system.providerRequests.length, retryStates: payloads.flatMap(payload => payload.type === "retry" ? [payload.state] : [])
        }, null, 2));
        await page.screenshot({ path: join(evidence, "original-run-stopped.png"), fullPage: true, timeout: 5_000 });
      }
    } finally {
      releaseStop?.();
      releaseProviderReply?.();
      await browser?.close();
      await fixture?.close({ removeRoot: true });
    }
  }
);
