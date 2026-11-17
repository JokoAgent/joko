import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { expect, it } from "vitest";
import { waitFor } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";

const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim() && process.env.JOKO_MOUNTED_WEB_DIR?.trim() ? it : it.skip;

mountedIt("finishes a real Pi thinking phase before tool completion and renders its completed source only once", { timeout: 120_000 }, async () => {
  let fixture: RealPiSystemFixture | undefined, browser: Browser | undefined;
  let releasePhase!: () => void, releaseAnswer!: () => void;
  const phaseGate = new Promise<void>(resolve => { releasePhase = resolve; });
  const answerGate = new Promise<void>(resolve => { releaseAnswer = resolve; });
  const thinking = "Inspect the original workspace file before answering.";
  try {
    fixture = await RealPiSystemFixture.start({ webDirectory: process.env.JOKO_MOUNTED_WEB_DIR!, providerSupportsThinking: true, providerApi: "anthropic-messages",
      providerResponder: async ({ requestNumber }) => {
        if (requestNumber === 1) return { kind: "tool", name: "read", arguments: { path: "thinking.txt" }, callId: "thinking-read",
          thinking, holdAfterThinking: phaseGate };
        await answerGate;
        return { kind: "text", text: "Thinking fixture answer" };
      } });
    await writeFile(join(fixture.workspaceDirectory, "thinking.txt"), "A controlled thinking fixture file.");
    const manager = await fixture.pair("Thinking fixture manager");
    const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId, createSessionMutation({
      backendId: "pi", targetId: "workspace-real-pi", displayName: "Independent thinking", providerId: REAL_PI_PROVIDER_ID,
      modelId: REAL_PI_MODEL_ID, effortId: "low"
    })));
    const challenge = (await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Thinking browser" })).challenge!;
    const pairingCode = fixture.pairingCode(challenge.challengeId);
    browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 960 } });
    await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.locator("details.device-authorization__manual > summary").click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(pairingCode);
    await page.getByLabel("Device name").fill("Thinking browser");
    await page.locator("form.pair-form button[type=submit]").click();
    const pane = page.locator(`.session-pane[data-input-session-id='${sessionId}']`);
    await pane.waitFor({ state: "visible", timeout: 30_000 });
    await pane.locator("[data-composer-editor='true'] .composer-rich-editor__content").fill("Read thinking.txt and answer.");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    const events = () => fixture!.application.store.listEvents({ sessionId });
    const terminal = await waitFor(() => Promise.resolve(events().find(event => event.payload.type === "thinking_delta" && event.payload.final)),
      event => event !== undefined, "the real published Pi thinking_end", 30_000);
    if (terminal?.payload.type !== "thinking_delta" || terminal.runId === undefined) throw new Error("The real thinking completion has no original Run.");
    const phase = terminal.payload;
    expect(phase).toMatchObject({ final: true, finalText: thinking, delta: "", contentIndex: 0 });
    expect(Number.isSafeInteger(phase.durationMs)).toBe(true);
    expect(phase.durationMs).toBeGreaterThanOrEqual(0);
    expect(fixture.application.store.getRun(terminal.runId).descriptor.state).toBe("running");
    expect(events().some(event => event.payload.type === "message_complete" && event.payload.blocks.some(block => block.kind === "thinking" && block.streamBlockId === phase.blockId))).toBe(false);
    const timeline = pane.locator(`[data-timeline-session-id='${sessionId}']`);
    const showThinking = async () => {
      // This fixture's first work group owns the thinking block. Adoption can
      // merge later groups while the original tool continuation is streaming.
      const header = timeline.locator(".work-group__header").first();
      if (await header.getAttribute("aria-expanded") === "false") await header.click();
      const card = timeline.locator(".thinking-block").filter({ hasText: thinking });
      await card.waitFor({ state: "visible", timeout: 30_000 });
      if (!await card.evaluate(element => (element as HTMLDetailsElement).open)) await card.locator("summary").click();
      return card;
    };
    const card = await showThinking();
    expect(await card.count()).toBe(1);
    expect(await card.locator(".thinking-pulse").count()).toBe(0);
    expect(await card.locator("summary").innerText()).toContain(`Thinking · ${Math.floor(phase.durationMs! / 1_000)}s`);
    const capture = async (name: string) => {
      if (!process.env.RUNNER_TEMP) return;
      const directory = join(process.env.RUNNER_TEMP, "joko-web-evidence", "thinking");
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: join(directory, name), fullPage: true, timeout: 5_000 });
    };
    await capture("phase-completed-before-message.png");
    releasePhase();
    await waitFor(() => Promise.resolve(fixture!.providerRequests.length), count => count >= 2, "the original tool and next real Pi request", 30_000);
    const completed = events().find(event => event.payload.type === "message_complete"
      && event.payload.blocks.some(block => block.kind === "thinking" && block.streamBlockId === phase.blockId));
    expect(completed?.runId).toBe(terminal.runId);
    expect(completed?.attemptId).toBe(terminal.attemptId);
    if (completed?.payload.type !== "message_complete") throw new Error("The completed assistant did not adopt its original thinking source.");
    expect(completed.payload.blocks[0]).toMatchObject({ kind: "thinking", text: thinking, streamBlockId: phase.blockId, durationMs: phase.durationMs });
    expect(events().some(event => event.payload.type === "tool_result" && event.payload.callId === "thinking-read")).toBe(true);
    const adopted = await showThinking();
    expect(await adopted.count()).toBe(1);
    expect(await adopted.locator(".thinking-pulse").count()).toBe(0);
    await capture("thinking-adopted-during-tool-continuation.png");
    releaseAnswer();
    await waitFor(() => Promise.resolve(fixture!.application.store.getRun(terminal.runId!).descriptor.state), state => state === "completed", "the original Pi Run completion", 30_000);
    await timeline.getByText("Thinking fixture answer", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    expect(await (await showThinking()).count()).toBe(1);
  } finally {
    releasePhase(); releaseAnswer();
    await browser?.close(); await fixture?.close({ removeRoot: true });
  }
});
