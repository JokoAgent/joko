import { resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import {
  MARKET_NAME,
  MARKET_SLUG,
  SkillMarketSystemFixture,
  writeSkillMarketSource
} from "./skill-market-system-fixture.js";

const MOUNTED_CHAIN_ENABLED = nonBlankEnvironment("JOKO_BROWSER_EXECUTABLE") !== undefined
  && nonBlankEnvironment("JOKO_MOUNTED_WEB_DIR") !== undefined;
const mountedIt = MOUNTED_CHAIN_ENABLED ? it : it.skip;

describe("mounted Skill market surface", () => {
  let fixture: SkillMarketSystemFixture | undefined;
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
    await fixture?.close();
    fixture = undefined;
  });

  mountedIt("installs, automatically updates, and uninstalls through wide and narrow production Chromium", async () => {
    const executablePath = requiredEnvironment("JOKO_BROWSER_EXECUTABLE");
    const webDirectory = resolve(requiredEnvironment("JOKO_MOUNTED_WEB_DIR"));
    fixture = await SkillMarketSystemFixture.start({ webDirectory });
    const sourceRoot = await writeSkillMarketSource(fixture, "1.0.0", "# Version one");

    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Mounted Skill Market Web" });
    if (challenge.challenge === undefined) throw new Error("Mounted Web pairing returned no challenge.");
    const pairingCode = fixture.pairingCode(challenge.challenge.challengeId);

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const browserErrors = observeBrowserErrors(page);
    await page.goto(`${fixture.baseUrl}/#/tools`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(pairingCode);
    await page.getByLabel("Device name").fill("Mounted Skill Market Web");
    await page.locator("form.pair-form button[type=submit]").click();

    const skillsTab = page.getByRole("tab", { name: /Skills/u });
    await skillsTab.waitFor({ state: "visible", timeout: 20_000 });
    browserErrors.splice(0);
    await skillsTab.click();
    const skillTabs = page.locator(".skill-hub__tabs");
    await skillTabs.getByRole("tab", { name: "Sources", exact: true }).click();
    const sourceEditor = page.locator(".skill-market-source-editor");
    await sourceEditor.waitFor({ state: "visible", timeout: 20_000 });
    await sourceEditor.getByLabel("Service-node directory").fill(sourceRoot);
    await sourceEditor.getByRole("button", { name: "Add and inspect source", exact: true }).click();
    const sourceCard = page.locator(".skill-market-source-card", { hasText: "Production Skill Market" });
    await sourceCard.waitFor({ state: "visible", timeout: 20_000 });
    expect(await page.locator("body").textContent()).not.toContain(sourceRoot);
    await page.getByRole("button", { name: "Browse market", exact: true }).click();

    const card = page.locator("button.skill-market-card", { hasText: MARKET_NAME });
    await card.waitFor({ state: "visible", timeout: 20_000 });
    await expectText(card, "Not installed", "initial market install state");
    await card.click();
    const heading = page.locator(".skill-market-detail h2", { hasText: MARKET_NAME });
    await heading.waitFor({ state: "visible", timeout: 20_000 });
    await page.getByText("# Version one", { exact: false }).waitFor({ state: "visible", timeout: 20_000 });
    expect(await columnsAreSideBySide(page)).toBe(true);
    expect(await overflow(page)).toBeLessThanOrEqual(1);

    let dialog = await openGlobalPlan(page);
    await dialog.getByRole("button", { name: "Install", exact: true }).click();
    await dialog.getByText("was installed and its runtime was refreshed", { exact: false }).waitFor({ state: "visible", timeout: 20_000 });
    await dialog.getByRole("button", { name: "Enable automatic updates", exact: true }).click();
    await dialog.getByText("Automatic updates enabled", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await closeDialog(dialog);

    await writeSkillMarketSource(fixture, "1.1.0", "# Version two");
    await skillTabs.getByRole("tab", { name: "Sources", exact: true }).click();
    await sourceCard.getByRole("button", { name: "Refresh", exact: true }).click();
    await waitFor(
      () => sourceCard.textContent(),
      (text) => text?.includes("1 catalog entries") === true,
      "refreshed mounted Skill source"
    );
    await page.getByRole("button", { name: "Browse market", exact: true }).click();
    await card.waitFor({ state: "visible", timeout: 20_000 });
    await expectText(card, "Update available", "market update state");
    await card.click();
    await page.getByText("# Version two", { exact: false }).waitFor({ state: "visible", timeout: 20_000 });
    dialog = await openGlobalPlan(page);
    await dialog.getByRole("button", { name: "Check now", exact: true }).click();
    await page.waitForTimeout(1_000);
    await closeDialog(dialog);
    await page.locator(".skill-market-controls").getByRole("button", { name: "Refresh", exact: true }).click();
    await expectText(card, "Installed", "synchronized market install state");

    await page.setViewportSize({ width: 390, height: 844 });
    const closeNavigation = page.getByLabel("Task navigation").getByRole("button", { name: "Close navigation" });
    if (await closeNavigation.isVisible()) await closeNavigation.click();
    const back = page.locator(".skill-market-detail__back");
    await back.waitFor({ state: "visible" });
    await back.click();
    await waitFor(
      () => card.evaluate((element) => ({
        focused: element === document.activeElement,
        connected: element.isConnected,
        disabled: (element as HTMLButtonElement).disabled,
        activeTag: document.activeElement?.tagName ?? "",
        activeClass: document.activeElement?.className ?? "",
        activeText: document.activeElement?.textContent?.trim().slice(0, 120) ?? "",
        browserClass: document.querySelector(".skill-market-browser")?.className ?? ""
      })),
      (state) => state.focused,
      "narrow market card focus restoration"
    );
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    await card.click();
    await waitFor(
      () => page.evaluate(() => document.activeElement?.textContent ?? ""),
      (text) => text.includes(MARKET_NAME),
      "narrow market detail focus"
    );
    dialog = await openGlobalPlan(page);
    await dialog.getByText("Automatic updates enabled", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await dialog.getByText("Updated", { exact: true }).first().waitFor({ state: "visible", timeout: 20_000 });
    await dialog.locator(".skill-market-uninstall input").fill(MARKET_SLUG);
    await dialog.getByRole("button", { name: "Uninstall", exact: true }).click();
    await dialog.waitFor({ state: "hidden", timeout: 20_000 });
    await expectText(card, "Not installed", "post-uninstall market state");
    expect(await overflow(page)).toBeLessThanOrEqual(1);

    if (await back.isVisible()) await back.click();
    await skillTabs.getByRole("tab", { name: "Sources", exact: true }).click();
    await sourceCard.getByLabel("Remove Production Skill Market").click();
    const removeDialog = page.getByRole("alertdialog", { name: "Remove Skill source?" });
    await removeDialog.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByText("No Skill sources", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    expect(await page.locator("body").textContent()).not.toContain(sourceRoot);
    expect(browserErrors).toEqual([]);
  }, 120_000);
});

async function openGlobalPlan(page: Page) {
  await page.getByRole("button", { name: "Choose install target", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Install ${MARKET_NAME}` });
  const review = dialog.getByRole("button", { name: "Review install plan", exact: true });
  await review.waitFor({ state: "visible" });
  await page.waitForTimeout(250);
  if (await review.isDisabled()) {
    const selects = await dialog.locator("select").evaluateAll((items) => items.map((item) => ({
      value: (item as HTMLSelectElement).value,
      options: [...(item as HTMLSelectElement).options].map((option) => option.value)
    })));
    throw new Error(`Mounted install target remained disabled: ${JSON.stringify({ text: await dialog.textContent(), selects })}`);
  }
  await review.click();
  await dialog.locator(".skill-market-plan").waitFor({ state: "visible", timeout: 20_000 });
  return dialog;
}

async function closeDialog(dialog: ReturnType<Page["getByRole"]>): Promise<void> {
  await dialog.locator(".modal__actions").getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}

async function expectText(locator: ReturnType<Page["locator"]>, text: string, label: string): Promise<void> {
  await waitFor(() => locator.textContent(), (value) => value?.includes(text) === true, label, 20_000);
}

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
    const catalog = document.querySelector(".skill-market-catalog")?.getBoundingClientRect();
    const detail = document.querySelector(".skill-market-detail-pane")?.getBoundingClientRect();
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
  if (value === undefined) throw new Error(`${name} is required for the mounted Skill market E3.`);
  return value;
}
