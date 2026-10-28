import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AdapterContext, PromptInput } from "@joko/core";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { chromium, type Browser } from "playwright-core";
import { afterEach, expect, it } from "vitest";
import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

const browserPath = process.env["JOKO_BROWSER_EXECUTABLE"]?.trim();
const webDirectory = process.env["JOKO_MOUNTED_WEB_DIR"]?.trim();
const mountedIt = browserPath && webDirectory ? it : it.skip;
let fixture: OrchestratorE2eFixture | undefined, browser: Browser | undefined;
afterEach(async () => { await browser?.close(); browser = undefined; await fixture?.close(); fixture = undefined; });

mountedIt("keeps question references read-only and answers explicit in the production responsive Web", { timeout: 60_000 }, async () => {
  const resolutions: unknown[] = [];
  class QuestionAdapter extends InstrumentedFakeAdapter {
    override async send(input: PromptInput, context: AdapterContext): Promise<void> {
      if (input.text === "[question references]") resolutions.push(await context.requestInteraction({
        id: `question-${randomUUID()}`, kind: "question", title: "Review evidence",
        prompt: `Read [workspace evidence](<${join(context.target.workspaceRoot, "README.md")}:1>) before answering.`,
        fields: [
          { id: "answer", kind: "text", label: "Answer", description: "Keep the file unchanged.", required: true, multiline: true },
          { id: "delivery", kind: "single", label: "Delivery", required: true, allowOther: true,
            choices: [{ id: "reference", label: "Read [web evidence](https://example.com/evidence), then choose.", description: "Opening evidence does not choose this option." }] }
        ]
      }));
      await super.send(input, context);
    }
  }
  fixture = await OrchestratorE2eFixture.start({ webDirectory, createAdapter: profile => new QuestionAdapter(profile) });
  await writeFile(join(fixture.workspaceDirectory, "README.md"), "# Evidence\nKeep this file unchanged.\n", "utf8");
  const manager = await fixture.pair("Question manager");
  const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId, createSessionMutation({
    backendId: PI_LIKE_PROFILE.id, targetId: fixture.targetId(), displayName: "Question answers"
  })));
  await submit(manager.clients.operation, manager.connectionId, sendInputMutation(sessionId,
    BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation), "[question references]"));
  await waitFor(async () => fixture!.application.store.listInteractions({ sessionId, status: "open" }), rows => rows.length === 1, "the durable question");
  const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Question Web" });
  if (!challenge.challenge) throw new Error("The question browser has no pairing challenge.");
  browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1280, height: 960 }, colorScheme: "light", reducedMotion: "reduce" });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
  await page.locator(".connection-tabs > button").nth(2).click();
  await page.locator("details.device-authorization__manual > summary").click();
  await page.getByLabel("Joko node address").fill(fixture.baseUrl);
  await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
  await page.getByLabel("Device name").fill("Question Web");
  await page.locator("form.pair-form button[type=submit]").click();
  const question = page.locator(".interaction-dialog"), answer = question.getByLabel("Answer", { exact: true });
  await answer.waitFor({ state: "visible", timeout: 20_000 });
  await answer.fill("The original answer");
  const file = question.getByRole("link", { name: "workspace evidence", exact: true });
  expect(await file.getAttribute("href")).toContain("README.md");
  const evidenceDirectory = process.env["JOKO_QUESTION_EVIDENCE_DIR"]?.trim();
  if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      if (await page.locator(".panel-scrim--navigation").isVisible()) await page.locator(".sidebar").getByRole("button", { name: "Close navigation", exact: true }).click();
      await answer.focus();
      expect(await answer.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (evidenceDirectory) await page.screenshot({ path: resolve(evidenceDirectory, `question-${theme}-${width}.png`), fullPage: true });
    }
  }
  expect(resolutions).toHaveLength(0);
  await page.setViewportSize({ width: 1280, height: 960 });
  await file.click();
  await page.waitForURL(/#\/files\//u);
  expect(fixture.application.store.listInteractions({ sessionId, status: "open" })).toHaveLength(1);
  expect(resolutions).toHaveLength(0);
  await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
  await answer.waitFor({ state: "visible" });
  expect(await answer.inputValue()).toBe("The original answer");
  await question.getByRole("button", { name: "Continue", exact: true }).click();
  const webReference = question.getByRole("link", { name: "web evidence", exact: true });
  await webReference.focus(); await webReference.press("1");
  expect(await question.locator('input[type="radio"]:checked').count()).toBe(0);
  expect(await question.getByRole("radio", { checked: true }).count()).toBe(0);
  expect(resolutions).toHaveLength(0);
  const otherToggle = question.locator('[data-question-other-toggle="delivery"]');
  expect(await otherToggle.getAttribute("role")).toBe("radio"); expect(await otherToggle.getAttribute("aria-checked")).toBe("false");
  // Other opens its editor without choosing an answer until text is supplied.
  await otherToggle.click();
  const other = question.getByLabel("Other", { exact: true });
  await other.waitFor({ state: "visible" });
  expect(await other.getAttribute("data-question-other-input")).toBe("delivery");
  await waitFor(() => other.evaluate(element => element === element.ownerDocument.activeElement), focused => focused, "the Other answer editor focus");
  expect(await other.inputValue()).toBe(""); expect(resolutions).toHaveLength(0);
  await other.fill("Deliver the final answer here");
  expect(await question.locator('input[type="radio"]:checked').count()).toBe(0);
  expect(resolutions).toHaveLength(0);
  await question.getByRole("button", { name: "Submit answers", exact: true }).click();
  await waitFor(async () => resolutions, rows => rows.length === 1, "one explicit question answer");
  expect(JSON.stringify(resolutions)).toContain("The original answer");
  expect(JSON.stringify(resolutions)).toContain("Deliver the final answer here");
  expect(await readFile(join(fixture.workspaceDirectory, "README.md"), "utf8")).toBe("# Evidence\nKeep this file unchanged.\n");
  expect(errors).toEqual([]);
});
