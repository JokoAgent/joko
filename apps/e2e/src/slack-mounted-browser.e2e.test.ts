import { chromium, type Browser, type Page } from "playwright-core";
import {
  MessagingChannel,
  SlackEmojiReactions,
  SlackGroupActivation
} from "@joko/contracts";
import { SlackTransport } from "@joko/messaging";
import { afterEach, describe, expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import { RealPiSystemFixture } from "./real-pi-fixture.js";
import {
  SLACK_SYSTEM_APP_TOKEN,
  SLACK_SYSTEM_BOT_TOKEN,
  SLACK_SYSTEM_CHANNEL_ID,
  SLACK_SYSTEM_OWNER_ID,
  SLACK_SYSTEM_TEAM_ID,
  SlackSystemFixture
} from "./slack-system-fixture.js";

const mounted = process.env.JOKO_BROWSER_EXECUTABLE?.trim() && process.env.JOKO_MOUNTED_WEB_DIR?.trim();

describe("mounted Slack Messaging Settings", () => {
  let fixture: RealPiSystemFixture | undefined;
  let slack: SlackSystemFixture | undefined;
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.close();
    await fixture?.close({ removeRoot: true });
    await slack?.close();
    browser = undefined;
    fixture = undefined;
    slack = undefined;
  });

  (mounted ? it : it.skip)("creates, configures, tests and clears Slack through wide/narrow localized production Web", { timeout: 150_000 }, async () => {
    const executablePath = required(process.env.JOKO_BROWSER_EXECUTABLE?.trim(), "Chrome executable");
    const webDirectory = required(process.env.JOKO_MOUNTED_WEB_DIR?.trim(), "production Web directory");
    slack = await SlackSystemFixture.start();
    fixture = await RealPiSystemFixture.start({
      webDirectory,
      createSlackTransport: (options) => new SlackTransport({ ...options, apiBaseUrl: slack!.apiBaseUrl }),
      messagingRetryDelayMs: 250
    });
    const inspector = await fixture.pair("Mounted Slack inspector");
    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Mounted Slack Web" });
    const challengeId = required(challenge.challenge?.challengeId, "pairing challenge");
    const pairingCode = fixture.pairingCode(challengeId);
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const browserErrors = observeBrowserErrors(page);
    await page.goto(`${fixture.baseUrl}/#/settings/messaging`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(pairingCode);
    await page.getByLabel("Device name").fill("Mounted Slack Web");
    await page.locator("form.pair-form button[type=submit]").click();

    const settings = page.locator(".messaging-settings");
    await settings.getByRole("heading", { name: "Messaging", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    browserErrors.splice(0);
    expect(await settings.locator(".messaging-channel.is-available").count()).toBe(8);
    await settings.getByRole("button", { name: "Add Slack", exact: true }).first().click();
    const create = page.getByRole("dialog", { name: "Add Slack" });
    const owner = create.getByLabel("Slack owner user ID");
    await owner.waitFor({ state: "visible" });
    expect(await owner.evaluate((element) => element === document.activeElement)).toBe(true);
    await owner.fill("U1");
    expect(await create.getByRole("button", { name: "Continue" }).isDisabled()).toBe(true);
    await owner.fill(SLACK_SYSTEM_OWNER_ID);
    await create.getByRole("button", { name: "Continue" }).click();

    const credential = page.getByRole("dialog", { name: "Add Slack tokens" });
    const appToken = credential.getByLabel("Slack app-level token (xapp-)");
    const botToken = credential.getByLabel("Slack bot token (xoxb-)");
    await appToken.waitFor({ state: "visible" });
    expect(await appToken.evaluate((element) => element === document.activeElement)).toBe(true);
    await appToken.fill("wrong-token");
    await botToken.fill(SLACK_SYSTEM_BOT_TOKEN);
    expect(await credential.getByRole("button", { name: "Save" }).isDisabled()).toBe(true);
    await appToken.fill(SLACK_SYSTEM_APP_TOKEN);
    await credential.getByRole("button", { name: "Save" }).click();
    await credential.waitFor({ state: "hidden" });
    const card = settings.locator(".messaging-connection-card").filter({
      has: page.getByRole("heading", { name: "Slack", exact: true })
    });
    await card.getByText("Connected", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await waitFor(
      () => inspector.clients.messaging.getMessagingSettings({}),
      (value) => value.connections.some((connection) => connection.channel === MessagingChannel.SLACK
        && connection.ownerProviderUserId === SLACK_SYSTEM_OWNER_ID
        && connection.providerAccountId === SLACK_SYSTEM_TEAM_ID
        && connection.credentialConfigured && connection.enabled),
      "the mounted Slack connection to authenticate", 15_000
    );
    expect(await page.locator("body").innerText()).not.toContain(SLACK_SYSTEM_APP_TOKEN);
    expect(await page.locator("body").innerText()).not.toContain(SLACK_SYSTEM_BOT_TOKEN);
    await card.getByRole("button", { name: "Test", exact: true }).click();
    await card.locator(".messaging-test-result").getByText(/Connected as/u).waitFor({ state: "visible", timeout: 15_000 });

    const replace = card.getByRole("button", { name: "Replace Slack tokens", exact: true });
    await replace.focus();
    await replace.click();
    const rebind = page.getByRole("dialog", { name: "Replace Slack tokens" });
    await rebind.getByLabel("Slack app-level token (xapp-)").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await rebind.waitFor({ state: "hidden" });
    expect(await replace.evaluate((element) => element === document.activeElement)).toBe(true);
    await card.getByText("Connected", { exact: true }).waitFor({ state: "visible" });

    await card.getByRole("button", { name: "Configure", exact: true }).click();
    const configuration = page.getByRole("dialog", { name: "Slack behavior" });
    await choose(page, configuration, "Acknowledgement reactions", "Expressive");
    expect(await configuration.getByLabel("Direct-message replies").count()).toBe(0);
    expect(await configuration.getByLabel("Group replies").count()).toBe(0);
    await configuration.getByRole("checkbox", { name: "Lifecycle announcements" }).uncheck();
    await configuration.getByLabel("Channel activation rules").fill(`${SLACK_SYSTEM_CHANNEL_ID}=always`);
    await configuration.getByRole("button", { name: "Save" }).click();
    await configuration.waitFor({ state: "hidden" });
    await waitFor(
      () => inspector.clients.messaging.getMessagingSettings({}),
      (value) => value.connections.some((connection) => connection.channel === MessagingChannel.SLACK
        && connection.slackConfiguration?.lifecycleAnnouncements === false
        && connection.slackConfiguration.emojiReactions === SlackEmojiReactions.EXPRESSIVE
        && connection.slackConfiguration.groupActivationRules.some((rule) => rule.channelId === SLACK_SYSTEM_CHANNEL_ID
          && rule.activation === SlackGroupActivation.ALWAYS)),
      "the mounted Slack behavior configuration to persist", 15_000
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await card.getByRole("button", { name: "Clear Slack tokens", exact: true }).waitFor({ state: "visible" });
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    expect(await card.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await page.goto(`${fixture.baseUrl}/#/settings/appearance`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Language", { exact: true }).click();
    await page.getByRole("option", { name: "简体中文", exact: true }).click();
    await page.goto(`${fixture.baseUrl}/#/settings/messaging`, { waitUntil: "domcontentloaded" });
    const localized = page.locator(".messaging-settings");
    await localized.getByRole("button", { name: "清除 Slack 令牌", exact: true }).waitFor({ state: "visible" });
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    await localized.getByRole("button", { name: "清除 Slack 令牌", exact: true }).click();
    const clear = page.getByRole("alertdialog", { name: "清除 Slack 令牌？" });
    await clear.getByRole("button", { name: "取消", exact: true }).click();
    await clear.waitFor({ state: "hidden" });
    await localized.getByRole("button", { name: "清除 Slack 令牌", exact: true }).click();
    const confirmedClear = page.getByRole("alertdialog", { name: "清除 Slack 令牌？" });
    await confirmedClear.getByRole("button", { name: "清除 Slack 令牌", exact: true }).click();
    await confirmedClear.waitFor({ state: "hidden" });
    await waitFor(
      () => inspector.clients.messaging.getMessagingSettings({}),
      (value) => value.connections.some((connection) => connection.channel === MessagingChannel.SLACK
        && !connection.credentialConfigured && !connection.enabled),
      "the mounted Slack credential clear", 15_000
    );
    expect(browserErrors).toEqual([]);
  });
});

async function choose(page: Page, scope: ReturnType<Page["getByRole"]>, label: string, option: string): Promise<void> {
  await scope.getByLabel(label).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

function required<T>(value: T | null | undefined | "", label: string): T {
  if (value === undefined || value === null || value === "") throw new Error(`Missing ${label}.`);
  return value;
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

function observeBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`page:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`response:${response.status()}:${response.url()}`);
  });
  return errors;
}
