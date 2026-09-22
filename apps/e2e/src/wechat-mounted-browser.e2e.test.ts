import { chromium, type Browser, type Page } from "playwright-core";
import { MessagingChannel } from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import { RealPiSystemFixture } from "./real-pi-fixture.js";
import { WECHAT_SYSTEM_TOKEN, WeChatSystemFixture } from "./wechat-system-fixture.js";

const mounted = process.env.JOKO_BROWSER_EXECUTABLE?.trim() && process.env.JOKO_MOUNTED_WEB_DIR?.trim();

describe("mounted WeChat Messaging Settings", () => {
  let fixture: RealPiSystemFixture | undefined;
  let wechat: WeChatSystemFixture | undefined;
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.close();
    await fixture?.close({ removeRoot: true });
    await wechat?.close();
    browser = undefined;
    fixture = undefined;
    wechat = undefined;
  });

  (mounted ? it : it.skip)("authorizes, rebinds and clears WeChat in wide/narrow localized production Web", { timeout: 120_000 }, async () => {
    const executablePath = required(process.env.JOKO_BROWSER_EXECUTABLE?.trim(), "Chrome executable");
    const webDirectory = required(process.env.JOKO_MOUNTED_WEB_DIR?.trim(), "production Web directory");
    wechat = await WeChatSystemFixture.start();
    fixture = await RealPiSystemFixture.start({
      webDirectory,
      createWeChatAuthorization: wechat.createAuthorization,
      createWeChatTransport: wechat.createTransport,
      messagingPollTimeoutSeconds: 1,
      messagingRetryDelayMs: 250
    });
    const inspector = await fixture.pair("Mounted WeChat inspector");
    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Mounted WeChat Web" });
    const challengeId = required(challenge.challenge?.challengeId, "pairing challenge");
    const pairingCode = fixture.pairingCode(challengeId);
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const browserErrors = observeBrowserErrors(page);
    await page.route("https://weixin.qq.com/x/qr-system", (route) => route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='white'/><path d='M8 8h20v20H8zM36 8h20v20H36zM8 36h20v20H8z' fill='black'/></svg>"
    }));
    await page.goto(`${fixture.baseUrl}/#/settings/messaging`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(pairingCode);
    await page.getByLabel("Device name").fill("Mounted WeChat Web");
    await page.locator("form.pair-form button[type=submit]").click();

    const settings = page.locator(".messaging-settings");
    await settings.getByRole("heading", { name: "Messaging", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    browserErrors.splice(0);
    expect(await settings.locator(".messaging-channel.is-available").count()).toBe(7);
    await settings.getByRole("button", { name: "Add WeChat", exact: true }).first().click();
    const authorization = page.getByRole("dialog", { name: "Authorize with WeChat" });
    await authorization.getByRole("img", { name: "WeChat authorization QR code" }).waitFor({ state: "visible" });
    expect(await authorization.getByRole("link", { name: "Open QR code in a new tab" }).getAttribute("href"))
      .toBe("https://weixin.qq.com/x/qr-system");
    try {
      await authorization.getByText("WeChat connected", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    } catch (error) {
      throw new Error(`WeChat authorization did not complete: ${await authorization.innerText()} | ${browserErrors.join(" | ")}`, { cause: error });
    }
    await authorization.locator(".modal__actions").getByRole("button", { name: "Close", exact: true }).click();
    await authorization.waitFor({ state: "hidden" });
    const card = settings.locator(".messaging-connection-card").filter({
      has: page.getByRole("heading", { name: "WeChat", exact: true })
    });
    await card.getByText("Connected", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    expect(await page.locator("body").innerText()).not.toContain(WECHAT_SYSTEM_TOKEN);
    await card.getByRole("button", { name: "Test", exact: true }).click();
    await card.getByText("Connected as WeChat bot.", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });

    await card.getByRole("button", { name: "Reauthorize WeChat", exact: true }).click();
    const rebind = page.getByRole("dialog", { name: "Reauthorize WeChat" });
    await rebind.getByRole("img", { name: "WeChat authorization QR code" }).waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await rebind.waitFor({ state: "hidden" });
    await card.getByText("Connected", { exact: true }).waitFor({ state: "visible" });
    await waitFor(
      () => inspector.clients.messaging.getMessagingSettings({}),
      (value) => value.connections.some((connection) => connection.channel === MessagingChannel.WECHAT
        && connection.credentialConfigured && connection.enabled),
      "the cancelled rebind to preserve the old WeChat connection", 10_000
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await card.getByRole("button", { name: "Disconnect WeChat", exact: true }).waitFor({ state: "visible" });
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    expect(await card.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await page.goto(`${fixture.baseUrl}/#/settings/appearance`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Language", { exact: true }).click();
    await page.getByRole("option", { name: "简体中文", exact: true }).click();
    await page.goto(`${fixture.baseUrl}/#/settings/messaging`, { waitUntil: "domcontentloaded" });
    const localized = page.locator(".messaging-settings");
    await localized.getByRole("button", { name: "断开微信", exact: true }).waitFor({ state: "visible" });
    await localized.getByRole("button", { name: "断开微信", exact: true }).click();
    const clear = page.getByRole("alertdialog", { name: "要断开微信吗？" });
    await clear.getByRole("button", { name: "取消", exact: true }).click();
    await clear.waitFor({ state: "hidden" });
    await localized.getByRole("button", { name: "断开微信", exact: true }).click();
    const confirmedClear = page.getByRole("alertdialog", { name: "要断开微信吗？" });
    await confirmedClear.getByRole("button", { name: "断开微信", exact: true }).click();
    await confirmedClear.waitFor({ state: "hidden" });
    await waitFor(
      () => inspector.clients.messaging.getMessagingSettings({}),
      (value) => value.connections.some((connection) => connection.channel === MessagingChannel.WECHAT
        && !connection.credentialConfigured && !connection.enabled),
      "the mounted WeChat credential clear", 15_000
    );
    expect(browserErrors).toEqual([]);
  });
});

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
