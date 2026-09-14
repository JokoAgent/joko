import { resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import {
  MARKET_NAME,
  MARKET_SLUG,
  seedSkillResourceUsage,
  SkillMarketSystemFixture,
  writeSkillMarketSource
} from "./skill-market-system-fixture.js";

const PUBLISHED_SLUG = "production-writer-team";
const PUBLISHED_NAME = "Team Writer";

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
    await skillTabs.getByRole("tab", { name: "Sharing", exact: true }).click();
    const sharing = page.locator(".skill-collaboration");
    await sharing.getByText("Local owner", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    const scopeType = sharing.locator(".skill-collaboration__create [data-select-control='true']");
    const scopeName = sharing.getByLabel("Scope name", { exact: true });
    await scopeName.fill("Platform");
    await sharing.getByRole("button", { name: "Create scope", exact: true }).click();
    await sharing.locator(".skill-collaboration__list article", { hasText: "Platform" }).waitFor({ state: "visible", timeout: 20_000 });
    await scopeType.click();
    await page.getByRole("option", { name: "Department", exact: true }).click();
    await scopeName.fill("Engineering");
    await sharing.getByRole("button", { name: "Create scope", exact: true }).click();
    await sharing.locator(".skill-collaboration__list article", { hasText: "Engineering" }).waitFor({ state: "visible", timeout: 20_000 });
    expect(await overflow(page)).toBeLessThanOrEqual(1);

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
    const initialUsageResource = required(
      fixture.application.piResources?.list({ kind: "skill" }).find((resource) =>
        resource.name === MARKET_SLUG && resource.scope === "global" && resource.version === "1.0.0"),
      "initial mounted usage Resource"
    );

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
    await page.getByText("# Version two", { exact: false }).waitFor({ state: "visible", timeout: 20_000 });
    const currentUsageResource = required(
      fixture.application.piResources?.list({ kind: "skill" }).find((resource) =>
        resource.id === initialUsageResource.id && resource.version === "1.1.0"),
      "updated mounted usage Resource"
    );
    const usageTarget = required(fixture.application.store.listTargets(currentUsageResource.backendId)[0], "mounted usage Target");
    const usageBackendName = fixture.application.store.getBackend(currentUsageResource.backendId).descriptor.displayName;
    seedSkillResourceUsage(fixture, {
      targetId: usageTarget.descriptor.id,
      previous: initialUsageResource,
      current: currentUsageResource
    });

    await skillTabs.getByRole("tab", { name: "Installed", exact: true }).click();
    const globalGroup = page.locator(".skill-catalog__groups > section").filter({ hasText: "Global" });
    const installedSkill = globalGroup.locator("button.skill-card", { hasText: MARKET_SLUG });
    await installedSkill.waitFor({ state: "visible", timeout: 20_000 });
    await installedSkill.click();
    await page.locator(".skill-detail h2", { hasText: MARKET_SLUG }).waitFor({ state: "visible", timeout: 20_000 });
    const usage = page.locator(".skill-usage");
    await usage.getByRole("heading", { name: "Usage and impact", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await usage.getByText("10 evidence events", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await usage.getByText("Native Skill commands", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await usage.getByText("Runtime tool calls", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await usage.getByText(usageBackendName, { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await usage.getByText("Comparable", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await usage.getByText("v1.1.0", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await usage.getByText("v1.0.0", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    expect(browserErrors, "before mounted publication").toEqual([]);
    await page.getByRole("button", { name: "Publish", exact: true }).click();

    const publication = page.getByRole("dialog", { name: `Publish ${MARKET_SLUG}` });
    await publication.waitFor({ state: "visible", timeout: 20_000 });
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    await publication.getByLabel("Market slug", { exact: true }).fill(PUBLISHED_SLUG);
    await publication.getByRole("button", { name: "Review publication target", exact: true }).click();
    await publication.getByText("First publication", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    const teamPublisher = publication.getByRole("radio", { name: "Team", exact: true });
    const departmentVisibility = publication.getByRole("radio", { name: "Department", exact: true });
    const privateVisibility = publication.getByRole("radio", { name: "Private", exact: true });
    expect(await teamPublisher.isEnabled()).toBe(true);
    expect(await privateVisibility.isEnabled()).toBe(true);
    expect(await departmentVisibility.isDisabled()).toBe(true);
    await teamPublisher.check();
    expect(await departmentVisibility.isEnabled()).toBe(true);
    expect(await privateVisibility.isDisabled()).toBe(true);
    await publication.locator(".skill-publication__scope [data-select-control='true']").click();
    await page.getByRole("option", { name: "Platform", exact: true }).click();
    await departmentVisibility.check();
    const engineeringAudience = publication.getByRole("checkbox", { name: "Engineering", exact: true });
    expect(await engineeringAudience.isChecked()).toBe(true);
    expect(await publicationFormColumns(page)).toBe(2);
    const publishVersion = publication.getByRole("button", { name: "Publish Skill", exact: true });
    await publication.getByLabel("Display name", { exact: true }).fill(PUBLISHED_NAME);
    await publication.getByLabel("Version", { exact: true }).fill("1.2.0");
    await publication.getByLabel("Changelog", { exact: true }).fill("Published through mounted production Chromium.");
    expect(await publishVersion.isEnabled()).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await publicationFormColumns(page)).toBe(1);
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    await publishVersion.click();
    await waitFor(
      () => publication.textContent(),
      (text) => text?.includes("Version 1.2.0 is published") === true,
      "mounted Skill publication completion",
      30_000
    );
    const publicationGates = publication.locator(".skill-publication__gates > section");
    expect(await publicationGates.count()).toBe(4);
    for (let index = 0; index < 4; index += 1) await expectText(publicationGates.nth(index), "Passed", `publication gate ${index + 1}`);
    await expectText(publication.locator(".skill-publication__job-access"), "Team publisher · Department visibility", "published restricted access");
    await publication.getByRole("button", { name: "Open in Skill market", exact: true }).click();
    await page.locator(".skill-market-detail h2", { hasText: PUBLISHED_NAME }).waitFor({ state: "visible", timeout: 20_000 });
    await page.getByText("version: 1.2.0", { exact: false }).waitFor({ state: "visible", timeout: 20_000 });
    await page.getByText("Team publisher · Department visibility", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await page.getByRole("button", { name: "Manage visibility", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    expect(browserErrors, "after mounted publication handoff").toEqual([]);

    await page.setViewportSize({ width: 390, height: 844 });
    const closeNavigation = page.getByLabel("Task navigation").getByRole("button", { name: "Close navigation" });
    if (await closeNavigation.isVisible()) await closeNavigation.click();
    const back = page.locator(".skill-market-detail__back");
    await back.waitFor({ state: "visible" });
    await back.click();
    const publishedCard = page.locator("button.skill-market-card", { hasText: PUBLISHED_NAME });
    await waitFor(
      () => publishedCard.evaluate((element) => ({
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
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`response:${response.status()}:${response.request().method()}:${response.url()}`);
  });
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

async function publicationFormColumns(page: Page): Promise<number> {
  return page.evaluate(() => {
    const labels = [...document.querySelectorAll<HTMLElement>(".skill-publication__form > label:not(.is-wide)")];
    if (labels.length < 2) return 0;
    const firstTop = labels[0]!.getBoundingClientRect().top;
    return labels.filter((label) => Math.abs(label.getBoundingClientRect().top - firstTop) < 1).length;
  });
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

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined || value === "") throw new Error(`${label} is missing.`);
  return value;
}
