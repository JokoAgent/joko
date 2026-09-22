import { chromium, type Browser, type Page } from "playwright-core";
import {
  DingTalkGroupActivation,
  DiscordEmojiReactions,
  DiscordGroupActivation,
  DiscordReplyQuoteMode,
  MessagingChannel,
  TelegramEmojiReactions,
  TelegramGroupActivation,
  TelegramReplyQuoteMode
} from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import {
  DINGTALK_SYSTEM_APP_KEY,
  DINGTALK_SYSTEM_APP_SECRET,
  DINGTALK_SYSTEM_GROUP_ID,
  DingTalkSystemFixture
} from "./dingtalk-system-fixture.js";
import {
  DISCORD_SYSTEM_GUILD_ID,
  DISCORD_SYSTEM_OWNER_ID,
  DISCORD_SYSTEM_ROOT_CHANNEL_ID,
  DISCORD_SYSTEM_TOKEN,
  DiscordSystemFixture
} from "./discord-system-fixture.js";
import { RealPiSystemFixture } from "./real-pi-fixture.js";
import {
  TELEGRAM_SYSTEM_OWNER_ID,
  TELEGRAM_SYSTEM_TOKEN,
  TelegramSystemFixture
} from "./telegram-system-fixture.js";

const MOUNTED_CHAIN_ENABLED = nonBlankEnvironment("JOKO_BROWSER_EXECUTABLE") !== undefined
  && nonBlankEnvironment("JOKO_MOUNTED_WEB_DIR") !== undefined;
const mountedIt = MOUNTED_CHAIN_ENABLED ? it : it.skip;

describe("mounted Messaging Settings product chain", () => {
  let fixture: RealPiSystemFixture | undefined;
  let telegram: TelegramSystemFixture | undefined;
  let discord: DiscordSystemFixture | undefined;
  let dingtalk: DingTalkSystemFixture | undefined;
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
    await telegram?.close();
    telegram = undefined;
    await discord?.close();
    discord = undefined;
    await dingtalk?.close();
    dingtalk = undefined;
  });

  mountedIt("configures the complete Telegram, Discord, and DingTalk matrix through wide and narrow production Web", { timeout: 120_000 }, async () => {
    const executablePath = requiredEnvironment("JOKO_BROWSER_EXECUTABLE");
    const webDirectory = requiredEnvironment("JOKO_MOUNTED_WEB_DIR");
    telegram = await TelegramSystemFixture.start();
    discord = await DiscordSystemFixture.start();
    dingtalk = await DingTalkSystemFixture.start();
    fixture = await RealPiSystemFixture.start({
      webDirectory,
      telegramApiBaseUrl: telegram.baseUrl,
      discordApiBaseUrl: discord.apiBaseUrl,
      dingTalkApiBaseUrl: dingtalk.baseUrl,
      dingTalkOapiBaseUrl: dingtalk.baseUrl,
      messagingPollTimeoutSeconds: 1,
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
    expect(await settings.locator(".messaging-channel.is-available").count()).toBe(3);
    await settings.getByText("Telegram", { exact: true }).first().waitFor({ state: "visible" });
    await settings.getByText("Discord", { exact: true }).waitFor({ state: "visible" });
    await settings.getByText("DingTalk", { exact: true }).first().waitFor({ state: "visible" });
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

    await settings.getByRole("button", { name: "Add Discord", exact: true }).first().click();
    const discordCreateDialog = page.getByRole("dialog", { name: "Add Discord" });
    await discordCreateDialog.getByLabel("Discord owner user ID").fill(DISCORD_SYSTEM_OWNER_ID);
    await discordCreateDialog.getByRole("button", { name: "Continue", exact: true }).click();
    const discordCredentialDialog = page.getByRole("dialog", { name: "Add token" });
    await discordCredentialDialog.getByLabel("Bot token").fill(DISCORD_SYSTEM_TOKEN);
    await discordCredentialDialog.getByRole("button", { name: "Save", exact: true }).click();
    await discordCredentialDialog.waitFor({ state: "hidden" });
    expect(await page.locator("body").innerText()).not.toContain(DISCORD_SYSTEM_TOKEN);

    const discordCard = settings.locator(".messaging-connection-card").filter({ hasText: "Discord" });
    await discordCard.getByText("Connected", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await discordCard.getByText("@joko-system-bot", { exact: true }).waitFor({ state: "visible" });
    await discordCard.getByRole("button", { name: "Test", exact: true }).click();
    await discordCard.getByText("Connected as @joko-system-bot.", { exact: true }).waitFor({
      state: "visible",
      timeout: 15_000
    });

    await discordCard.getByRole("button", { name: "Configure", exact: true }).click();
    let discordConfigurationDialog = page.getByRole("dialog", { name: "Discord behavior" });
    await discordConfigurationDialog.getByLabel("Lifecycle announcements").uncheck();
    await choose(page, discordConfigurationDialog, "Acknowledgement reactions", "Expressive");
    await choose(page, discordConfigurationDialog, "Direct-message replies", "Quote first part");
    await choose(page, discordConfigurationDialog, "Group replies", "Quote every part");
    await discordConfigurationDialog.getByLabel("Server channel activation rules").fill(
      `${DISCORD_SYSTEM_GUILD_ID}/${DISCORD_SYSTEM_ROOT_CHANNEL_ID}=always\n${DISCORD_SYSTEM_GUILD_ID}/676767676767676767=disabled`
    );
    await discordConfigurationDialog.getByRole("button", { name: "Save", exact: true }).click();
    await discordConfigurationDialog.waitFor({ state: "hidden" });

    await waitFor(
      () => inspector.clients.messaging.getMessagingSettings({}),
      (value) => value.connections.some((connection) =>
        connection.discordConfiguration?.lifecycleAnnouncements === false
        && connection.discordConfiguration.emojiReactions === DiscordEmojiReactions.EXPRESSIVE
        && connection.discordConfiguration.replyQuoteDm === DiscordReplyQuoteMode.FIRST
        && connection.discordConfiguration.replyQuoteGroup === DiscordReplyQuoteMode.ALL
        && connection.discordConfiguration.groupActivationRules.some((rule) =>
          rule.guildId === DISCORD_SYSTEM_GUILD_ID
          && rule.channelId === DISCORD_SYSTEM_ROOT_CHANNEL_ID
          && rule.activation === DiscordGroupActivation.ALWAYS)
        && connection.discordConfiguration.groupActivationRules.some((rule) =>
          rule.guildId === DISCORD_SYSTEM_GUILD_ID
          && rule.channelId === "676767676767676767"
          && rule.activation === DiscordGroupActivation.DISABLED)),
      "the mounted Discord behavior matrix",
      15_000
    );

    await discordCard.getByRole("button", { name: "Configure", exact: true }).click();
    discordConfigurationDialog = page.getByRole("dialog", { name: "Discord behavior" });
    expect(await discordConfigurationDialog.getByLabel("Lifecycle announcements").isChecked()).toBe(false);
    expect((await discordConfigurationDialog.getByLabel("Acknowledgement reactions").textContent())?.trim()).toBe("Expressive");
    expect((await discordConfigurationDialog.getByLabel("Direct-message replies").textContent())?.trim()).toBe("Quote first part");
    expect((await discordConfigurationDialog.getByLabel("Group replies").textContent())?.trim()).toBe("Quote every part");
    expect(await discordConfigurationDialog.getByLabel("Server channel activation rules").inputValue())
      .toBe(`${DISCORD_SYSTEM_GUILD_ID}/${DISCORD_SYSTEM_ROOT_CHANNEL_ID}=always\n${DISCORD_SYSTEM_GUILD_ID}/676767676767676767=disabled`);
    await page.keyboard.press("Escape");
    await discordConfigurationDialog.waitFor({ state: "hidden" });

    await settings.getByRole("button", { name: "Add DingTalk", exact: true }).first().click();
    const dingtalkCreateDialog = page.getByRole("dialog", { name: "Add DingTalk" });
    await dingtalkCreateDialog.getByLabel("DingTalk AppKey").fill(DINGTALK_SYSTEM_APP_KEY);
    await dingtalkCreateDialog.getByRole("button", { name: "Continue", exact: true }).click();
    const dingtalkCredentialDialog = page.getByRole("dialog", { name: "Add AppSecret" });
    await dingtalkCredentialDialog.getByLabel("DingTalk AppSecret").fill(DINGTALK_SYSTEM_APP_SECRET);
    await dingtalkCredentialDialog.getByRole("button", { name: "Save", exact: true }).click();
    await dingtalkCredentialDialog.waitFor({ state: "hidden" });
    expect(await page.locator("body").innerText()).not.toContain(DINGTALK_SYSTEM_APP_SECRET);

    const dingtalkCard = settings.locator(".messaging-connection-card").filter({ hasText: "DingTalk" });
    await dingtalkCard.getByText("Connected", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await dingtalkCard.getByText("Waiting for first direct message", { exact: true }).first().waitFor({ state: "visible" });
    await dingtalkCard.getByRole("button", { name: "Test", exact: true }).click();
    await dingtalkCard.getByText("Connected as DingTalk bot.", { exact: true }).waitFor({
      state: "visible",
      timeout: 15_000
    });

    await dingtalkCard.getByRole("button", { name: "Configure", exact: true }).click();
    let dingtalkConfigurationDialog = page.getByRole("dialog", { name: "DingTalk behavior" });
    expect(await dingtalkConfigurationDialog.getByLabel("DingTalk AppKey").inputValue())
      .toBe(DINGTALK_SYSTEM_APP_KEY);
    await dingtalkConfigurationDialog.getByLabel("Group conversation activation rules").fill(
      `${DINGTALK_SYSTEM_GROUP_ID}=always\ncid-ding-muted=disabled`
    );
    await dingtalkConfigurationDialog.getByRole("button", { name: "Save", exact: true }).click();
    await dingtalkConfigurationDialog.waitFor({ state: "hidden" });

    await waitFor(
      () => inspector.clients.messaging.getMessagingSettings({}),
      (value) => value.connections.some((connection) =>
        connection.dingtalkConfiguration?.appKey === DINGTALK_SYSTEM_APP_KEY
        && connection.ownerProviderUserId === undefined
        && connection.dingtalkConfiguration.groupActivationRules.some((rule) =>
          rule.conversationId === DINGTALK_SYSTEM_GROUP_ID
          && rule.activation === DingTalkGroupActivation.ALWAYS)
        && connection.dingtalkConfiguration.groupActivationRules.some((rule) =>
          rule.conversationId === "cid-ding-muted"
          && rule.activation === DingTalkGroupActivation.DISABLED)),
      "the mounted DingTalk behavior matrix",
      15_000
    );

    await dingtalkCard.getByRole("button", { name: "Configure", exact: true }).click();
    dingtalkConfigurationDialog = page.getByRole("dialog", { name: "DingTalk behavior" });
    expect(await dingtalkConfigurationDialog.getByLabel("DingTalk AppKey").inputValue())
      .toBe(DINGTALK_SYSTEM_APP_KEY);
    expect(await dingtalkConfigurationDialog.getByLabel("Group conversation activation rules").inputValue())
      .toBe(`${DINGTALK_SYSTEM_GROUP_ID}=always\ncid-ding-muted=disabled`);
    await page.keyboard.press("Escape");
    await dingtalkConfigurationDialog.waitFor({ state: "hidden" });

    await card.getByRole("button", { name: "Clear token", exact: true }).click();
    const clearDialog = page.getByRole("alertdialog", { name: "Clear bot token?" });
    await clearDialog.getByText("The connection goes offline immediately", { exact: false }).waitFor({ state: "visible" });
    await clearDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await clearDialog.waitFor({ state: "hidden" });

    await discordCard.getByRole("button", { name: "Clear token", exact: true }).click();
    const discordClearDialog = page.getByRole("alertdialog", { name: "Clear bot token?" });
    await discordClearDialog.getByRole("button", { name: "Clear token", exact: true }).click();
    await discordClearDialog.waitFor({ state: "hidden" });
    await discordCard.getByText("Needs token", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await waitFor(
      () => inspector.clients.messaging.getMessagingSettings({}),
      (value) => value.connections.some((connection) =>
        connection.channel === MessagingChannel.DISCORD && !connection.credentialConfigured && !connection.enabled),
      "the mounted Discord credential clear",
      15_000
    );

    await dingtalkCard.getByRole("button", { name: "Clear AppSecret", exact: true }).click();
    const dingtalkClearDialog = page.getByRole("alertdialog", { name: "Clear DingTalk AppSecret?" });
    await dingtalkClearDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dingtalkClearDialog.waitFor({ state: "hidden" });
    await dingtalkCard.getByRole("button", { name: "Clear AppSecret", exact: true }).click();
    const confirmedDingTalkClearDialog = page.getByRole("alertdialog", { name: "Clear DingTalk AppSecret?" });
    await confirmedDingTalkClearDialog.getByRole("button", { name: "Clear AppSecret", exact: true }).click();
    await confirmedDingTalkClearDialog.waitFor({ state: "hidden" });
    await dingtalkCard.getByText("Needs AppSecret", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await waitFor(
      () => inspector.clients.messaging.getMessagingSettings({}),
      (value) => value.connections.some((connection) =>
        connection.channel === MessagingChannel.DINGTALK
        && connection.ownerProviderUserId === undefined
        && !connection.credentialConfigured
        && !connection.enabled),
      "the mounted DingTalk credential and provisional owner clear",
      15_000
    );

    expect(await overflow(page)).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await card.getByRole("button", { name: "Configure", exact: true }).waitFor({ state: "visible" });
    await discordCard.getByRole("button", { name: "Configure", exact: true }).waitFor({ state: "visible" });
    await dingtalkCard.getByRole("button", { name: "Configure", exact: true }).waitFor({ state: "visible" });
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    expect(await card.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    expect(await discordCard.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    expect(await dingtalkCard.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    expect(browserErrors).toEqual([]);

    const durableProjection = JSON.stringify({
      settings: fixture.application.store.listSettings(),
      connections: fixture.application.store.listMessagingConnections(),
      diagnostics: fixture.application.store.listDiagnostics({ limit: 200 })
    }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    expect(durableProjection).not.toContain(TELEGRAM_SYSTEM_TOKEN);
    expect(durableProjection).not.toContain(DISCORD_SYSTEM_TOKEN);
    expect(durableProjection).not.toContain(DINGTALK_SYSTEM_APP_SECRET);
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
