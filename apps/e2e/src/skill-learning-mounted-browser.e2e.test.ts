import { resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import { RealPiSystemFixture } from "./real-pi-fixture.js";

const executable = process.env.JOKO_BROWSER_EXECUTABLE?.trim();
const webBuild = process.env.JOKO_MOUNTED_WEB_DIR?.trim();
const mountedIt = executable && webBuild ? it : it.skip;

describe("mounted Skill learning review", () => {
  let fixture: RealPiSystemFixture | undefined;
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
  });

  mountedIt("reviews and accepts a durable learned Skill in wide and narrow Chromium", { timeout: 120_000 }, async () => {
    fixture = await RealPiSystemFixture.start({
      webDirectory: resolve(webBuild!),
      enableInternalServer: true,
      providerResponder: () => ({
        kind: "text",
        text: JSON.stringify({
          name: "mounted-learning",
          description: "Review a repeatable workflow",
          explanation: "The procedure can be reused in later tasks.",
          files: [{
            path: "SKILL.md",
            content: "---\nname: mounted-learning\ndescription: Review a repeatable workflow\n---\n# Review each change\n"
          }]
        })
      })
    });
    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Mounted learning reviewer" });
    if (challenge.challenge === undefined) throw new Error("Mounted learning pairing returned no challenge.");
    const code = fixture.pairingCode(challenge.challenge.challengeId);
    browser = await chromium.launch({ executablePath: executable!, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = observeErrors(page);
    await page.goto(`${fixture.baseUrl}/#/tools`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(code);
    await page.getByLabel("Device name").fill("Mounted learning reviewer");
    await page.locator("form.pair-form button[type=submit]").click();
    const skillsTab = page.getByRole("tab", { name: /Skills/u });
    await skillsTab.waitFor({ state: "visible", timeout: 20_000 });
    errors.splice(0);
    await skillsTab.click();
    await page.locator(".skill-hub__tabs").getByRole("tab", { name: "Learning", exact: true }).click();
    const learning = page.locator(".skill-learning");
    await learning.getByLabel("What should the Skill learn?").fill("Make this review procedure reusable.");
    await learning.getByRole("button", { name: "Start learning" }).click();
    const review = learning.getByRole("region", { name: "Review learned Skill" });
    await review.getByText("The procedure can be reused in later tasks.").waitFor({ state: "visible", timeout: 45_000 });
    await review.locator(".skill-learning__file pre", { hasText: "# Review each change" }).waitFor({ state: "visible" });
    expect(await overflow(page)).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 390, height: 844 });
    const closeNavigation = page.getByLabel("Task navigation").getByRole("button", { name: "Close navigation" });
    if (await closeNavigation.isVisible()) await closeNavigation.click();
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    await review.getByRole("button", { name: "Accept and install" }).click();
    await review.getByText("Installed", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    expect(fixture.application.piResources?.list({ kind: "skill" }).some((item) =>
      item.name === "mounted-learning" && item.sourceKind === "learned" && item.state === "installed")).toBe(true);
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });
});

function observeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console:${message.text()}`); });
  return errors;
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
