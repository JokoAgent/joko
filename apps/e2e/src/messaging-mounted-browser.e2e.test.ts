import { chromium, type Browser, type Page } from "playwright-core";
import {
  TelegramEmojiReactions,
  TelegramGroupActivation,
  TelegramReplyQuoteMode
} from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import { RealPiSystemFixture } from "./real-pi-fixture.js";
import {
  TELEGRAM_SYSTEM_OWNER_ID,
  TELEGRAM_SYSTEM_TOKEN,
  TelegramSystemFixture
} from "./telegram-system-fixture.js";

const MOUNTED_CHAIN_ENABLED = nonBlankEnvironment("JOKO_BROWSER_EXECUTABLE") !== undefined
  && nonBlankEnvironment("JOKO_MOUNTED_WEB_DIR") !== undefined;
const mountedIt = MOUNTED_CHAIN_ENABLED ? it : it.skip;

describe("mounted Telegram Messaging Settings product chain", () => {
  let fixture: RealPiSystemFixture | undefined;
  let telegram: TelegramSystemFixture | undefined;
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
    await telegram?.close();
    telegram = undefined;
  });

  mountedIt("configures the complete Telegram matrix through wide and narrow production Web", { timeout: 120_000 }, async () => {
    const executablePath = requiredEnvironment("JOKO_BROWSER_EXECUTABLE");
    const webDirectory = requiredEnvironment("JOKO_MOUNTED_WEB_DIR");
    telegram = await TelegramSystemFixture.start();
    fixture = await RealPiSystemFixture.start({
      webDirectory,
      telegramApiBaseUrl: telegram.baseUrl,
      messagingRetryDelayMs: 250
    });
    const inspector = await fixture.pair("Mounted Messaging inspector");
    const challenge = await fixture.anonymous.connection.beginPairing({
      deviceDisplayName: "Mounted Messaging Web"
    });
    const challengeId = required(challenge.challenge?.challengeId, "mounted Messaging challenge");
    const pairingCode = fixture.pairingCode(challengeId);

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const browserErrors = observeBrowserErrors(page);
    await page.goto(`${fixture.baseUrl}/#/settings/messaging`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(pairingCode);
    await page.getByLabel("Device name").fill("Mounted Messaging Web");
    await page.locator("form.pair-form button[type=submit]").click();

    const settings = page.locator(".messaging-settings");
    await settings.getByRole("heading", { name: "Messaging", exact: true }).waitFor({
      state: "visible",
      timeout: 30_000
    });
    browserErrors.splice(0);
    expect(await settings.locator(".messaging-channel").count()).toBe(8);
    expect(await settings.locator(".messaging-channel.is-available").count()).toBe(1);
    await settings.getByText("Telegram", { exact: true }).first().waitFor({ state: "visible" });
    await settings.getByText("Discord", { exact: true }).waitFor({ state: "visible" });
    await settings.getByText("Slack", { exact: true }).waitFor({ state: "visible" });

    await settings.getByRole("button", { name: "Set route", exact: true }).click();
    const routeDialog = page.getByRole("dialog", { name: "Default route" });
    await routeDialog.getByText("Route changes affect new conversations only", { exact: false }).waitFor({ state: "visible" });
    await routeDialog.getByRole("button", { name: "Save", exact: true }).click();
    await routeDialog.waitFor({ state: "hidden" });
    await settings.getByText("Real Pi E2E workspace", { exact: true }).waitFor({ state: "visible" });

    await settings.getByRole("button", { name: "Add Telegram", exact: true }).first().click();
    const createDialog = page.getByRole("dialog", { name: "Add Telegram" });
    await createDialog.getByLabel("Telegram owner user ID").fill(String(TELEGRAM_SYSTEM_OWNER_ID));
    await createDialog.getByRole("button", { name: "Continue", exact: true }).click();
    const credentialDialog = page.getByRole("dialog", { name: "Add token" });
    await credentialDialog.getByLabel("Bot token").fill(TELEGRAM_SYSTEM_TOKEN);
    expect(await credentialDialog.getByLabel("Connect after saving").isChecked()).toBe(true);
    await credentialDialog.getByRole("button", { name: "Save", exact: true }).click();
    await credentialDialog.waitFor({ state: "hidden" });
    expect(await page.locator("body").innerText()).not.toContain(TELEGRAM_SYSTEM_TOKEN);

    const card = settings.locator(".messaging-connection-card").filter({ hasText: "Telegram" });
    await card.getByText("Connected", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await card.getByText("@joko_system_bot", { exact: true }).waitFor({ state: "visible" });
    await card.getByRole("button", { name: "Test", exact: true }).click();
    await card.getByText("Connected as @joko_system_bot.", { exact: true }).waitFor({
      state: "visible",
      timeout: 15_000
    });

    await card.getByRole("button", { name: "Configure", exact: true }).click();
    let configurationDialog = page.getByRole("dialog", { name: "Telegram behavior" });
    await choose(page, configurationDialog, "Acknowledgement reactions", "Expressive");
    await choose(page, configurationDialog, "Direct-message replies", "Quote first part");
    await choose(page, configurationDialog, "Group replies", "Quote every part");
    await configurationDialog.getByLabel("Group activation rules").fill("-100123=always\n-100456=disabled");
    await configurationDialog.getByRole("button", { name: "Save", exact: true }).click();
    await configurationDialog.waitFor({ state: "hidden" });

    const persisted = await waitFor(
      () => inspector.clients.messaging.getMessagingSettings({}),
      (value) => value.connections.some((connection) =>
        connection.telegramConfiguration?.emojiReactions === TelegramEmojiReactions.EXPRESSIVE
        && connection.telegramConfiguration.replyQuoteDm === TelegramReplyQuoteMode.FIRST
        && connection.telegramConfiguration.replyQuoteGroup === TelegramReplyQuoteMode.ALL
        && connection.telegramConfiguration.groupActivationRules.some((rule) =>
          rule.chatId === "-100123" && rule.activation === TelegramGroupActivation.ALWAYS)
        && connection.telegramConfiguration.groupActivationRules.some((rule) =>
          rule.chatId === "-100456" && rule.activation === TelegramGroupActivation.DISABLED)),
      "the mounted Telegram behavior matrix",
      15_000
    );
    expect(persisted.routes).toHaveLength(1);
    expect(persisted.routes[0]?.targetId).toBe("workspace-real-pi");
    expect(persisted.connections).toHaveLength(1);

    await card.getByRole("button", { name: "Configure", exact: true }).click();
    configurationDialog = page.getByRole("dialog", { name: "Telegram behavior" });
    expect((await configurationDialog.getByLabel("Acknowledgement reactions").textContent())?.trim()).toBe("Expressive");
    expect((await configurationDialog.getByLabel("Direct-message replies").textContent())?.trim()).toBe("Quote first part");
    expect((await configurationDialog.getByLabel("Group replies").textContent())?.trim()).toBe("Quote every part");
    expect(await configurationDialog.getByLabel("Group activation rules").inputValue())
      .toBe("-100123=always\n-100456=disabled");
    await page.keyboard.press("Escape");
    await configurationDialog.waitFor({ state: "hidden" });

    await card.getByRole("button", { name: "Clear token", exact: true }).click();
    const clearDialog = page.getByRole("alertdialog", { name: "Clear Telegram token?" });
    await clearDialog.getByText("The connection goes offline immediately", { exact: false }).waitFor({ state: "visible" });
    await clearDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await clearDialog.waitFor({ state: "hidden" });

    expect(await overflow(page)).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await card.getByRole("button", { name: "Configure", exact: true }).waitFor({ state: "visible" });
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    expect(await card.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    expect(browserErrors).toEqual([]);

    const durableProjection = JSON.stringify({
      settings: fixture.application.store.listSettings(),
      connections: fixture.application.store.listMessagingConnections(),
      diagnostics: fixture.application.store.listDiagnostics({ limit: 200 })
    }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    expect(durableProjection).not.toContain(TELEGRAM_SYSTEM_TOKEN);
  });
});

function observeBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location();
      errors.push(`console:${message.text()}:${location.url}:${location.lineNumber}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`response:${response.status()}:${response.url()}`);
  });
  return errors;
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function choose(page: Page, scope: ReturnType<Page["getByRole"]>, label: string, option: string): Promise<void> {
  await scope.getByLabel(label).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

function required<T>(value: T | null | undefined | "", label: string): T {
  if (value === undefined || value === null || value === "") throw new Error(`${label} is required.`);
  return value;
}

function nonBlankEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function requiredEnvironment(name: string): string {
  return required(nonBlankEnvironment(name), `${name} for the mounted Messaging E3`);
}
