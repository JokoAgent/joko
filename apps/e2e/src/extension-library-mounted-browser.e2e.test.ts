import { resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import {
  ExtensionLibrarySystemFixture,
  installLibraryExtension
} from "./extension-library-system-fixture.js";
import { waitFor } from "./fixture.js";

const MOUNTED_CHAIN_ENABLED = nonBlankEnvironment("JOKO_BROWSER_EXECUTABLE") !== undefined
  && nonBlankEnvironment("JOKO_MOUNTED_WEB_DIR") !== undefined;
const mountedIt = MOUNTED_CHAIN_ENABLED ? it : it.skip;

describe("mounted Extension Library main-view bridge", () => {
  let fixture: ExtensionLibrarySystemFixture | undefined;
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
    await fixture?.close();
    fixture = undefined;
  });

  mountedIt("runs the injected file and SQLite bridge in wide and narrow Chromium viewports", async () => {
    const executablePath = requiredEnvironment("JOKO_BROWSER_EXECUTABLE");
    const webDirectory = resolve(requiredEnvironment("JOKO_MOUNTED_WEB_DIR"));
    fixture = await ExtensionLibrarySystemFixture.start({ webDirectory });
    const manager = await fixture.pair("Mounted Library manager");
    const extension = await installLibraryExtension(fixture, manager);

    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Mounted Library Web" });
    if (challenge.challenge === undefined) throw new Error("Mounted Web pairing returned no challenge.");
    const pairingCode = fixture.pairingCode(challenge.challenge.challengeId);

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const browserErrors = observeBrowserErrors(page);
    await page.goto(`${fixture.baseUrl}/#/extensions/${encodeURIComponent(extension.extensionId)}`, {
      waitUntil: "domcontentloaded"
    });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(pairingCode);
    await page.getByLabel("Device name").fill("Mounted Library Web");
    await page.locator("form.pair-form button[type=submit]").click();

    const frameElement = page.locator("iframe.extension-main-view-page__frame");
    await frameElement.waitFor({ state: "visible", timeout: 20_000 });
    // The disconnected landing page probes its default local origin before the
    // explicit node pairing completes. From this point onward the mounted
    // product and its Extension surface must remain error-free.
    browserErrors.splice(0);
    const frame = page.frameLocator("iframe.extension-main-view-page__frame");
    const result = frame.locator("#bridge-result");
    const expectedResult = `bridge-ready:mounted-bridge:chromium:${extension.extensionId}`;
    await waitFor(() => result.textContent(), (value) => value === expectedResult, "the mounted Library bridge", 20_000);
    expect(await frame.locator("html").getAttribute("data-bridge-ready")).toBe("true");
    expect(await frame.locator("html").evaluate(() => ({ origin: window.origin, secure: window.isSecureContext })))
      .toEqual({ origin: "null", secure: true });
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    expect(await result.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 390, height: 844 });
    await frameElement.waitFor({ state: "visible" });
    const narrowRead = await result.evaluate(async () => {
      const library = (window as unknown as Window & {
        readonly joko: {
          readonly library: (operation: unknown) => Promise<Record<string, unknown>>;
        };
      }).joko.library;
      const response = await library({ kind: "read", path: "bridge/result.txt" });
      if (response["ok"] !== true || response["kind"] !== "read" || !(response["content"] instanceof Uint8Array)) {
        return `bridge-error:${String(response["errorCode"] ?? "invalid-response")}`;
      }
      return new TextDecoder().decode(response["content"]);
    });
    expect(narrowRead).toBe("mounted-bridge");
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    expect(await result.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(1);
    expect(browserErrors).toEqual([]);
  }, 90_000);
});

function observeBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });
  return errors;
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
  if (value === undefined) throw new Error(`${name} is required for the mounted Extension Library E3.`);
  return value;
}
