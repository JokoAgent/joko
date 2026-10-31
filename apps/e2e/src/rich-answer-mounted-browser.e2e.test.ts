import type { AdapterContext, PromptInput } from "@joko/core";
import { RunState } from "@joko/contracts";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { chromium, type Browser } from "playwright-core";
import { afterEach, expect, it } from "vitest";
import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

const browserPath = process.env["JOKO_BROWSER_EXECUTABLE"]?.trim();
const webDirectory = process.env["JOKO_MOUNTED_WEB_DIR"]?.trim();
const mountedIt = browserPath && webDirectory ? it : it.skip;
let fixture: OrchestratorE2eFixture | undefined, browser: Browser | undefined;
afterEach(async () => { await browser?.close(); browser = undefined; await fixture?.close(); fixture = undefined; });

mountedIt("sends a rich answer through the production task queue while preserving the composer and reload receipt", { timeout: 90_000 }, async () => {
  const source = '```joko-ui\n' + [
    { version: 1, seq: 1, op: "create", id: "form", kind: "form", props: { label: "Send selected reply", send: { op: "concat", args: ["/review selected: ", { ref: "detail" }] } } },
    { seq: 2, op: "create", id: "detail", kind: "check", parent: "form", props: { label: "Include details", default: false } }
  ].map(value => JSON.stringify(value)).join("\n") + '\n```';
  class AnswerAdapter extends InstrumentedFakeAdapter {
    override async send(input: PromptInput, context: AdapterContext): Promise<void> {
      if (input.text !== "[rich answer]") { await super.send(input, context); return; }
      this.sendCalls.push(input);
      await context.emit({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: source }],
        nativeHistory: { identity: { entryId: "answer-form" } } });
      await context.emit({ type: "done", outcome: "completed" });
    }
  }
  fixture = await OrchestratorE2eFixture.start({ webDirectory, profiles: [PI_LIKE_PROFILE], createAdapter: profile => new AnswerAdapter(profile) });
  const manager = await fixture.pair("Answer manager");
  const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
    createSessionMutation({ backendId: PI_LIKE_PROFILE.id, targetId: fixture.targetId(), displayName: "Interactive answer" })));
  const operation = await submit(manager.clients.operation, manager.connectionId,
    sendInputMutation(sessionId, BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation), "[rich answer]"));
  await waitFor(() => manager.clients.run.getRun({ runId: queueRunIdFrom(operation) }), value => value.run?.state === RunState.SUCCEEDED, "the answer document");
  const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Answer Web" });
  if (!challenge.challenge) throw new Error("The answer browser has no pairing challenge.");
  browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1280, height: 960 }, reducedMotion: "reduce" });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
  await page.locator(".connection-tabs > button").nth(2).click();
  await page.locator("details.device-authorization__manual > summary").click();
  await page.getByLabel("Joko node address").fill(fixture.baseUrl);
  await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
  await page.getByLabel("Device name").fill("Answer Web");
  await page.locator("form.pair-form button[type=submit]").click();
  const answer = page.locator("[data-rich-answer]");
  await answer.getByRole("button", { name: "Send selected reply", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  const draft = page.locator(".composer-rich-editor__content");
  await draft.fill("My unfinished composer draft");
  await answer.getByRole("checkbox", { name: "Include details", exact: true }).check();
  expect(await answer.textContent()).toContain("/review selected: true");
  expect(fixture.adapter().sendCalls).toHaveLength(1);
  await answer.getByRole("button", { name: "Send selected reply", exact: true }).click();
  await waitFor(async () => fixture!.adapter().sendCalls, calls => calls.length === 2, "the one literal answer input");
  expect(fixture.adapter().sendCalls[1]?.text).toBe("/review selected: true");
  await answer.getByRole("button", { name: "Sent", exact: true }).waitFor({ state: "visible" });
  expect(await draft.textContent()).toBe("My unfinished composer draft");
  expect(await answer.getByRole("button", { name: "Sent", exact: true }).isDisabled()).toBe(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  // Manual pairing leaves automatic entry disabled. Reconnect the original
  // saved node before checking the task's durable answer receipt.
  await page.locator(".connection-tabs > button").nth(1).click();
  await page.locator(".connection-card .profile-card").filter({ has: page.getByText(fixture.baseUrl, { exact: true }) })
    .getByRole("button", { name: "Connect", exact: true }).click();
  await answer.getByRole("button", { name: "Sent", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  expect(await answer.getByRole("checkbox", { name: "Include details", exact: true }).isChecked()).toBe(true);
  expect(await answer.getByRole("button", { name: "Sent", exact: true }).isDisabled()).toBe(true);
  expect(fixture.adapter().sendCalls).toHaveLength(2);
  expect(errors).toEqual([]);
});
