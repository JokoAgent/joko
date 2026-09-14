import { resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import { installLocalSkill, SkillSystemFixture } from "./skill-system-fixture.js";

const MOUNTED_CHAIN_ENABLED = nonBlankEnvironment("JOKO_BROWSER_EXECUTABLE") !== undefined
  && nonBlankEnvironment("JOKO_MOUNTED_WEB_DIR") !== undefined;
const mountedIt = MOUNTED_CHAIN_ENABLED ? it : it.skip;

describe("mounted Skill management surface", () => {
  let fixture: SkillSystemFixture | undefined;
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
    await fixture?.close();
    fixture = undefined;
  });

  mountedIt("manages one exact Skill through wide and narrow production Chromium", async () => {
    const executablePath = requiredEnvironment("JOKO_BROWSER_EXECUTABLE");
    const webDirectory = resolve(requiredEnvironment("JOKO_MOUNTED_WEB_DIR"));
    fixture = await SkillSystemFixture.start({ webDirectory });
    const manager = await fixture.pair("Mounted Skill manager");
    await installLocalSkill(fixture, manager, "mounted-review");

    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Mounted Skill Web" });
    if (challenge.challenge === undefined) throw new Error("Mounted Web pairing returned no challenge.");
    const pairingCode = fixture.pairingCode(challenge.challenge.challengeId);

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const browserErrors = observeBrowserErrors(page);
    await page.goto(`${fixture.baseUrl}/#/tools`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(pairingCode);
    await page.getByLabel("Device name").fill("Mounted Skill Web");
    await page.locator("form.pair-form button[type=submit]").click();

    const skillsTab = page.getByRole("tab", { name: /Skills/u });
    await skillsTab.waitFor({ state: "visible", timeout: 20_000 });
    browserErrors.splice(0);
    await skillsTab.click();
    const workbench = page.locator(".skill-workbench");
    await workbench.waitFor({ state: "visible", timeout: 20_000 });
    const heading = page.locator(".skill-detail h2", { hasText: "mounted-review" });
    await heading.waitFor({ state: "visible", timeout: 20_000 });
    await page.getByText("# Original Skill", { exact: false }).waitFor({ state: "visible" });
    expect(await columnsAreSideBySide(page)).toBe(true);
    expect(await overflow(page)).toBeLessThanOrEqual(1);

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.getByLabel("Skill file editor");
    await editor.fill((await editor.inputValue()).replace("# Original Skill", "# Edited in mounted Chromium"));
    await page.getByRole("button", { name: "Review changes", exact: true }).click();
    const review = page.getByRole("dialog", { name: "Review Skill changes" });
    await waitFor(() => review.textContent(), (text) => text?.includes("+# Edited in mounted Chromium") === true, "mounted edit diff");
    await review.getByRole("button", { name: "Apply changes", exact: true }).click();
    await review.waitFor({ state: "hidden" });
    await page.getByText("# Edited in mounted Chromium", { exact: false }).waitFor({ state: "visible", timeout: 20_000 });

    await page.setViewportSize({ width: 390, height: 844 });
    const closeNavigation = page.getByLabel("Task navigation").getByRole("button", { name: "Close navigation" });
    if (await closeNavigation.isVisible()) await closeNavigation.click();
    const skillCard = page.locator("button.skill-card", { hasText: "mounted-review" });
    await skillCard.waitFor({ state: "visible" });
    await skillCard.click();
    await waitFor(
      () => page.evaluate(() => document.activeElement?.textContent ?? ""),
      (value) => value.includes("mounted-review"),
      "narrow Skill detail focus"
    );
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await waitFor(
      () => skillCard.evaluate((element) => element === document.activeElement),
      (focused) => focused,
      "narrow Skill card focus restoration"
    );
    await skillCard.click();

    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const renameDialog = page.getByRole("dialog", { name: "Rename Skill" });
    await renameDialog.getByLabel("New Skill name").fill("mounted-review-renamed");
    await renameDialog.getByRole("button", { name: "Review changes", exact: true }).click();
    const renameReview = page.getByRole("dialog", { name: "Review Skill changes" });
    await waitFor(() => renameReview.textContent(), (text) => text?.includes("+name: mounted-review-renamed") === true, "mounted rename diff");
    await renameReview.getByRole("button", { name: "Apply changes", exact: true })
      .evaluate((button: HTMLButtonElement) => button.click());
    await page.locator(".skill-detail h2", { hasText: "mounted-review-renamed" })
      .waitFor({ state: "visible", timeout: 20_000 });

    await page.getByRole("button", { name: "Disable", exact: true }).click();
    await page.getByRole("button", { name: "Enable", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await page.getByRole("button", { name: "Enable", exact: true }).click();
    await page.getByRole("button", { name: "Disable", exact: true }).waitFor({ state: "visible", timeout: 20_000 });

    await page.getByLabel("Delete mounted-review-renamed?").click();
    const deleteDialog = page.getByRole("dialog", { name: "Delete mounted-review-renamed?" });
    const deleteSummary = await deleteDialog.textContent();
    expect(deleteSummary).toContain("Pi");
    expect(deleteSummary).toContain("Global");
    expect(deleteSummary).toContain("2 files");
    const deleteButton = deleteDialog.getByRole("button", { name: "Delete", exact: true });
    expect(await deleteButton.isDisabled()).toBe(true);
    await deleteDialog.locator("input").fill("mounted-review-renamed");
    expect(await deleteButton.isEnabled()).toBe(true);
    await deleteButton.click();

    const recoveryDialog = page.getByRole("dialog", { name: "Skill removed" });
    await recoveryDialog.waitFor({ state: "visible", timeout: 20_000 });
    expect(await recoveryDialog.locator("code").textContent()).toMatch(/^skill_recovery_[a-f0-9]{32}$/u);
    await recoveryDialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByText("No local Skills", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await page.getByText("Recoverable copies", { exact: true }).waitFor({ state: "visible" });
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    expect(browserErrors).toEqual([]);
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

async function columnsAreSideBySide(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const catalog = document.querySelector(".skill-catalog")?.getBoundingClientRect();
    const detail = document.querySelector(".skill-detail-pane")?.getBoundingClientRect();
    return catalog !== undefined && detail !== undefined && detail.left >= catalog.right - 1;
  });
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

function nonBlankEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function requiredEnvironment(name: string): string {
  const value = nonBlankEnvironment(name);
  if (value === undefined) throw new Error(`${name} is required for the mounted Skill E3.`);
  return value;
}
