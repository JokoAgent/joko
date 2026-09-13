import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  BrowserSettingsController,
  OperationalBrowserState
} from "@joko/orchestrator";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { BrowserProvider } from "@joko/tool-browser";
import { chromium, type Browser } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  createSessionMutation,
  sendInputMutation,
  sessionIdFrom,
  submit
} from "./operations.js";

const MOUNTED_CHAIN_ENABLED = nonBlankEnvironment("JOKO_BROWSER_EXECUTABLE") !== undefined
  && nonBlankEnvironment("JOKO_MOUNTED_WEB_DIR") !== undefined;
const mountedIt = MOUNTED_CHAIN_ENABLED ? it : it.skip;

describe("mounted Workspace HTML Browser chain", () => {
  let fixture: OrchestratorE2eFixture | undefined;
  let uiBrowser: Browser | undefined;

  afterEach(async () => {
    await uiBrowser?.close();
    uiBrowser = undefined;
    await fixture?.close();
    fixture = undefined;
  });

  mountedIt("opens an assistant Workspace link from the mounted Web through durable Connect state in the headed external Browser", async () => {
    const executablePath = requiredEnvironment("JOKO_BROWSER_EXECUTABLE");
    const webDirectory = resolve(requiredEnvironment("JOKO_MOUNTED_WEB_DIR"));
    let provider: BrowserProvider | undefined;

    fixture = await OrchestratorE2eFixture.start({
      webDirectory,
      createAuxiliaryServices: async (store, dataDirectory) => {
        const browserState = new OperationalBrowserState(store);
        provider = new BrowserProvider({
          providerId: "browser",
          initialGeneration: browserState.lastBrowserGeneration("browser"),
          executablePath,
          profileDirectories: {
            sidebar: join(dataDirectory, "browser", "profiles", "sidebar"),
            external: join(dataDirectory, "browser", "profiles", "external")
          },
          profileDisplayName: "Mounted E3",
          targetMode: "external",
          downloadDirectory: join(dataDirectory, "browser", "downloads"),
          uploadRoots: [],
          canUpload: () => false,
          canDownload: () => false,
          onActivity: (activity) => browserState.recordActivity(activity)
        });
        const browserSettings = new BrowserSettingsController({
          store,
          defaults: {
            browserProviderId: "browser",
            enabled: true,
            profileDisplayName: "Mounted E3",
            takeoverTimeoutMs: 60_000,
            allowUploads: false,
            allowDownloads: false,
            automationTarget: "external"
          },
          detectedBrowser: "Chrome",
          hooks: { start: () => undefined, stop: () => undefined, refresh: () => undefined }
        });
        return { browser: provider, browserSettings, browserState };
      }
    });

    const manager = await fixture.pair("Mounted E3 manager");
    const sessionId = sessionIdFrom(await submit(
      manager.clients.operation,
      manager.connectionId,
      createSessionMutation({
        backendId: PI_LIKE_PROFILE.id,
        targetId: fixture.targetId(),
        displayName: "Mounted Workspace HTML"
      })
    ));
    await mkdir(join(fixture.workspaceDirectory, "pages"), { recursive: true });
    await Promise.all([
      writeFile(join(fixture.workspaceDirectory, "index.html"), [
        "<!doctype html>",
        "<meta charset=\"utf-8\">",
        "<title>Mounted Workspace HTML</title>",
        "<link rel=\"stylesheet\" href=\"styles.css\">",
        "<button id=\"interaction\" type=\"button\">ready</button>",
        "<output id=\"resource\">loading</output>",
        "<a id=\"details\" href=\"pages/details.html\">details</a>",
        "<script src=\"app.js\"></script>"
      ].join("\n"), "utf8"),
      writeFile(join(fixture.workspaceDirectory, "styles.css"), "button { color: rgb(18, 52, 86); }\n", "utf8"),
      writeFile(join(fixture.workspaceDirectory, "data.json"), "{\"message\":\"resource-ready\"}\n", "utf8"),
      writeFile(join(fixture.workspaceDirectory, "app.js"), [
        "document.querySelector('#interaction').addEventListener('click', (event) => { event.currentTarget.textContent = 'clicked'; });",
        "fetch('data.json').then((response) => response.json()).then((data) => { document.querySelector('#resource').textContent = data.message; });"
      ].join("\n"), "utf8"),
      writeFile(join(fixture.workspaceDirectory, "pages", "details.html"), [
        "<!doctype html>",
        "<meta charset=\"utf-8\">",
        "<title>Mounted details</title>",
        "<h1 id=\"details-heading\">Details loaded</h1>"
      ].join("\n"), "utf8")
    ]);
    await submit(
      manager.clients.operation,
      manager.connectionId,
      sendInputMutation(
        sessionId,
        BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation),
        "[Mounted preview](index.html)"
      )
    );

    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Mounted Web" });
    if (challenge.challenge === undefined) throw new Error("Mounted Web pairing returned no challenge.");
    const pairingCode = fixture.pairingCode(challenge.challenge.challengeId);

    uiBrowser = await chromium.launch({ executablePath, headless: true });
    const uiPage = await uiBrowser.newPage();
    await uiPage.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await uiPage.locator(".connection-tabs > button").nth(2).click();
    await uiPage.getByLabel("Joko node address").fill(fixture.baseUrl);
    await uiPage.getByLabel("Pairing code").fill(pairingCode);
    await uiPage.getByLabel("Device name").fill("Mounted E3 Web");
    await uiPage.locator("form.pair-form button[type=submit]").click();

    const timelineLink = uiPage.getByRole("link", { name: "Mounted preview" }).last();
    await timelineLink.waitFor({ state: "visible", timeout: 20_000 });
    const uiPageCount = uiBrowser.contexts()[0]?.pages().length;
    const uiHash = await uiPage.evaluate(() => window.location.hash);
    await timelineLink.click({ button: "right" });
    await uiPage.getByRole("menuitem", { name: "Open in dedicated managed Browser" }).click();

    const actualProvider = provider;
    if (actualProvider === undefined) throw new Error("Mounted Browser Provider was not constructed.");
    const takeover = await waitFor(
      async () => actualProvider.currentHumanTakeover(),
      (value) => value !== undefined,
      "the mounted Web to open an external Browser takeover",
      20_000
    ).catch(async (error: unknown) => {
      const browserSnapshot = (await manager.clients.browser.listBrowserProviders({})).providers[0];
      const diagnostics = {
        linkBusy: await timelineLink.getAttribute("aria-busy"),
        feedback: await uiPage.locator("[role=status]").allTextContents(),
        browser: browserSnapshot,
        settings: fixture!.application.browserSettings?.snapshot(),
        operations: fixture!.application.store.listOperations().map((operation) => ({
          kind: operation.kind,
          status: operation.status,
          error: operation.error
        }))
      };
      throw new Error(`${error instanceof Error ? error.message : String(error)} Diagnostics: ${JSON.stringify(diagnostics, bigintJson)}`);
    });
    if (takeover === undefined) throw new Error("Mounted Browser takeover disappeared.");

    expect(actualProvider.targetMode).toBe("external");
    expect(uiBrowser.contexts()[0]?.pages()).toHaveLength(uiPageCount ?? 1);
    expect(await uiPage.evaluate(() => window.location.hash)).toBe(uiHash);

    await actualProvider.runHumanTakeoverOperation(takeover, async (page) => {
      await page.locator("#resource").waitFor({ state: "visible" });
      await page.waitForFunction(() => document.querySelector("#resource")?.textContent === "resource-ready");
      expect(await page.locator("#interaction").evaluate((element) => getComputedStyle(element).color)).toBe("rgb(18, 52, 86)");
      await page.locator("#interaction").click();
      expect(await page.locator("#interaction").textContent()).toBe("clicked");
      expect(await page.evaluate(() => ({ origin: window.origin, secure: window.isSecureContext }))).toEqual({ origin: "null", secure: true });
      await page.locator("#details").click();
      await page.locator("#details-heading").waitFor({ state: "visible" });
      expect(page.url()).toMatch(/^http:\/\/[a-z0-9-]+\.preview\.joko\.localhost\/pages\/details\.html$/u);
      expect(await page.locator("#details-heading").textContent()).toBe("Details loaded");
    });

    const providerSnapshot = (await manager.clients.browser.listBrowserProviders({})).providers[0];
    expect(providerSnapshot).toMatchObject({
      browserProviderId: "browser",
      pages: [expect.objectContaining({
        pageId: takeover.pageId,
        sessionId,
        url: expect.stringMatching(/^http:\/\/[a-z0-9-]+\.preview\.joko\.localhost\/pages\/details\.html$/u)
      })]
    });
    expect(fixture.application.store.listOperations().some((operation) =>
      operation.kind === "openBrowserPage" && operation.status === "completed")).toBe(true);
  }, 60_000);
});

function nonBlankEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function requiredEnvironment(name: string): string {
  const value = nonBlankEnvironment(name);
  if (value === undefined) throw new Error(`${name} is required for the mounted Workspace HTML E3.`);
  return value;
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
