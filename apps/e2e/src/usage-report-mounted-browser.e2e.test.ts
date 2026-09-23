import { resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestratorE2eFixture } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim() && process.env.JOKO_MOUNTED_WEB_DIR?.trim()
  ? it : it.skip;

describe("mounted usage history", () => {
  let fixture: OrchestratorE2eFixture | undefined;
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
    await fixture?.close();
    fixture = undefined;
  });

  mountedIt("pages a large durable ledger and refreshes two mounted windows after a changed cursor", { timeout: 120_000 }, async () => {
    fixture = await OrchestratorE2eFixture.start({ webDirectory: resolve(process.env.JOKO_MOUNTED_WEB_DIR!) });
    const inspector = await fixture.pair("Usage history inspector");
    const [backendId, targetId] = [...fixture.targets][0]!;
    const sessionId = sessionIdFrom(await submit(inspector.clients.operation, inspector.connectionId,
      createSessionMutation({ backendId, targetId })));
    const generation = fixture.application.store.getSession(sessionId).descriptor.binding.generation;
    const measuredAt = Date.now();
    fixture.application.store.transaction((store) => {
      for (let index = 0; index < 5_000; index += 1) {
        store.recordUsageObservation({
          ownerId: "orchestrator-e2e", sessionId, sourceId: `run:${index}`, generation,
          backendId, providerId: "history-provider", modelId: `model-${String(index).padStart(4, "0")}`,
          measuredAt, inputTokens: index + 1, outputTokens: 0, totalTokens: index + 1,
          cacheReadTokens: 0, cacheWriteTokens: 0, currencyCode: index % 2 === 0 ? "USD" : "EUR",
          ...(index % 2 === 0 ? { reportedCostMicros: index + 1 } : {})
        });
      }
    });

    browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const first = await context.newPage();
    const firstErrors = browserErrors(first);
    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Usage history Web" });
    if (challenge.challenge === undefined) throw new Error("Usage history pairing returned no challenge.");
    await first.goto(`${fixture.baseUrl}/#/settings/providers`, { waitUntil: "domcontentloaded" });
    await first.locator(".connection-tabs > button").nth(2).click();
    await first.getByLabel("Joko node address").fill(fixture.baseUrl);
    await first.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
    await first.getByLabel("Device name").fill("Usage history Web");
    await first.locator("form.pair-form button[type=submit]").click();
    await openModelReport(first);
    expect(await first.locator(".usage-history-summary strong").textContent()).toContain("5000 groups");
    expect(await first.locator(".usage-history-entries details").count()).toBe(25);
    expect(await first.locator(".usage-history-summary").textContent()).toContain("EUR");
    expect(await first.locator(".usage-history-summary").textContent()).toContain("$6.25");
    await first.getByRole("button", { name: "More", exact: true }).click();
    await first.locator(".usage-history-entries details").nth(49).waitFor({ state: "attached" });
    firstErrors.splice(0);

    const second = await context.newPage();
    const secondErrors = browserErrors(second);
    await second.goto(`${fixture.baseUrl}/#/settings/providers`, { waitUntil: "domcontentloaded" });
    await second.locator(".profile-card", { hasText: "Usage history Web" }).getByRole("button", { name: "Connect" }).click();
    await openModelReport(second);
    expect(await second.locator(".usage-history-summary strong").textContent()).toContain("5000 groups");
    secondErrors.splice(0);

    fixture.application.store.recordUsageObservation({
      ownerId: "orchestrator-e2e", sessionId, sourceId: "run:later", generation,
      backendId, providerId: "history-provider", modelId: "model-later", measuredAt: measuredAt + 1,
      inputTokens: 10_000, outputTokens: 0, totalTokens: 10_000,
      cacheReadTokens: 0, cacheWriteTokens: 0, currencyCode: "USD", reportedCostMicros: 10_000
    });
    await first.getByRole("button", { name: "More", exact: true }).click();
    await first.locator(".usage-history-section [role=alert]").waitFor({ state: "visible" });
    expect(await first.locator(".usage-history-entries details").count()).toBe(50);
    expect(firstErrors).toEqual([expect.stringContaining("409 (Conflict)")]);
    firstErrors.splice(0);
    await first.getByRole("button", { name: "Refresh usage history" }).click();
    await first.locator(".usage-history-summary strong").getByText("5001 groups", { exact: false }).waitFor();
    await first.getByText("model-later", { exact: true }).waitFor({ state: "visible" });
    await second.getByRole("button", { name: "Refresh usage history" }).click();
    await second.locator(".usage-history-summary strong").getByText("5001 groups", { exact: false }).waitFor();

    await first.setViewportSize({ width: 390, height: 844 });
    expect(await first.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    expect(await first.locator(".usage-history-entries details").count()).toBe(25);
    expect(firstErrors).toEqual([]);
    expect(secondErrors).toEqual([]);
  });
});

async function openModelReport(page: Page): Promise<void> {
  const entry = page.locator(".provider-master-row", { hasText: "Usage history" });
  await entry.waitFor({ state: "visible", timeout: 20_000 });
  await entry.click();
  const section = page.locator(".usage-history-section");
  await section.getByRole("heading", { name: "Usage history" }).waitFor({ state: "visible" });
  await section.getByLabel("Group by").selectOption("model");
  await section.getByLabel("Provider ID").fill("history-provider");
  await section.getByRole("button", { name: "Apply filters" }).click();
  await section.locator(".usage-history-entries details").first().waitFor({ state: "visible" });
}

function browserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console:${message.text()}`); });
  return errors;
}
