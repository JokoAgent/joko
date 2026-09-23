import { join, resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import type { BackendDescriptor } from "@joko/core";
import { CredentialManager, CredentialVault, ProviderCatalogManager } from "@joko/orchestrator";
import { PI_LIKE_PROFILE } from "@joko/testkit";

import { InstrumentedFakeAdapter, OrchestratorE2eFixture } from "./fixture.js";

const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim() && process.env.JOKO_MOUNTED_WEB_DIR?.trim()
  ? it : it.skip;

class ManagedProviderAdapter extends InstrumentedFakeAdapter {
  override async describe(): Promise<BackendDescriptor> {
    const descriptor = await super.describe();
    return { ...descriptor,
      capabilities: new Map([...descriptor.capabilities, ["provider.managed_catalog", { key: "provider.managed_catalog", supported: true }]]),
      providerRuntimeSupport: { protocols: ["openai-completions"], fields: ["auth_header", "keyless", "headers", "model_limits", "model_input_modalities"] }
    };
  }
}

describe("mounted Provider configuration", () => {
  let fixture: OrchestratorE2eFixture | undefined;
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
    await fixture?.close();
    fixture = undefined;
  });

  mountedIt("creates independent runtimes, reviews an overwrite, and fences a stale window after credential upload", { timeout: 150_000 }, async () => {
    const alphaId = "managed-alpha";
    const betaId = "managed-beta";
    fixture = await OrchestratorE2eFixture.start({
      webDirectory: resolve(process.env.JOKO_MOUNTED_WEB_DIR!),
      profiles: [{ ...PI_LIKE_PROFILE, id: alphaId, displayName: "Alpha runtime" }, { ...PI_LIKE_PROFILE, id: betaId, displayName: "Beta runtime" }],
      createAdapter: (profile) => new ManagedProviderAdapter(profile),
      createAuxiliaryServices: async (store, directory) => {
        const vault = await CredentialVault.open(join(directory, "provider-vault.key"));
        const credentials = new CredentialManager({ vault, storagePath: join(directory, "provider-credentials.json") });
        await credentials.initialize();
        const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: alphaId });
        providers.initialize();
        return { credentials, providers };
      }
    });
    const inspector = await fixture.pair("Provider inspector");
    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Provider Web" });
    if (challenge.challenge === undefined) throw new Error("Provider pairing returned no challenge.");

    browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const first = await context.newPage();
    const firstErrors = browserErrors(first);
    await first.goto(`${fixture.baseUrl}/#/settings/providers`, { waitUntil: "domcontentloaded" });
    await first.locator(".connection-tabs > button").nth(2).click();
    await first.getByLabel("Joko node address").fill(fixture.baseUrl);
    await first.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
    await first.getByLabel("Device name").fill("Provider Web");
    await first.locator("form.pair-form button[type=submit]").click();
    await first.getByRole("button", { name: "Add provider", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    firstErrors.splice(0);

    await first.getByRole("button", { name: "Add provider", exact: true }).click();
    await first.locator(".provider-add-wizard__custom").click();
    let editor = first.locator(".provider-editor-modal");
    await editor.getByLabel("Display name").first().fill("Mounted Route");
    await editor.getByRole("tab", { name: "Alpha runtime" }).click();
    await editor.getByLabel("Base URL").fill("https://alpha.example.test/v1");
    await editor.locator('input[type="password"]').fill("alpha-mounted-secret");
    await editor.getByLabel("Model ID").fill("alpha-model");
    await editor.getByLabel("Display name").last().fill("Alpha model");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor.waitFor({ state: "hidden", timeout: 20_000 });
    const read = async () => (await inspector.clients.settings.getSettings({})).settings!.providers.find((item) => item.providerId === "mounted-route")!;
    const firstSaved = await read();
    expect(firstSaved.runtimes.map((item) => item.backendId)).toEqual([alphaId]);
    expect(firstSaved.runtimes[0]!.credentialReferenceId).toBeTruthy();
    expect(fixture.application.credentials!.resolve(firstSaved.runtimes[0]!.credentialReferenceId)).toBe("alpha-mounted-secret");

    await first.locator(".provider-master-row", { hasText: "Mounted Route" }).dblclick();
    editor = first.locator(".provider-editor-modal");
    await editor.getByRole("tab", { name: "Beta runtime" }).click();
    await editor.getByRole("button", { name: "Configure Beta runtime" }).click();
    await editor.getByLabel("Base URL").fill("https://beta.example.test/v1");
    await editor.locator('input[type="password"]').fill("beta-mounted-secret");
    await editor.getByLabel("Model ID").fill("beta-model");
    await editor.getByLabel("Display name").last().fill("Beta model");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor.waitFor({ state: "hidden", timeout: 20_000 });
    const independent = await read();
    const alpha = independent.runtimes.find((item) => item.backendId === alphaId)!;
    const beta = independent.runtimes.find((item) => item.backendId === betaId)!;
    expect(alpha.endpoint).toBe("https://alpha.example.test/v1");
    expect(beta.endpoint).toBe("https://beta.example.test/v1");
    expect(beta.credentialReferenceId).not.toBe(alpha.credentialReferenceId);
    expect(fixture.application.credentials!.resolve(beta.credentialReferenceId)).toBe("beta-mounted-secret");

    const second = await context.newPage();
    const secondErrors = browserErrors(second);
    await second.goto(`${fixture.baseUrl}/#/settings/providers`, { waitUntil: "domcontentloaded" });
    await second.locator(".profile-card", { hasText: "Provider Web" }).getByRole("button", { name: "Connect" }).click();
    await second.locator(".provider-master-row", { hasText: "Mounted Route" }).waitFor({ state: "visible", timeout: 20_000 });
    secondErrors.splice(0);
    await second.locator(".provider-master-row", { hasText: "Mounted Route" }).dblclick();
    const staleEditor = second.locator(".provider-editor-modal");
    await staleEditor.getByRole("tab", { name: "Beta runtime" }).click();
    await staleEditor.locator('input[type="password"]').fill("stale-mounted-secret");

    await first.locator(".provider-master-row", { hasText: "Mounted Route" }).dblclick();
    editor = first.locator(".provider-editor-modal");
    await editor.getByRole("tab", { name: "Alpha runtime" }).click();
    await editor.getByRole("button", { name: "Copy to other runtimes" }).click();
    const transfer = first.locator(".provider-transfer-modal");
    await transfer.getByLabel("Beta runtime · Endpoint, protocol, and request path").click();
    await transfer.getByLabel("Beta runtime · Model declarations").click();
    await transfer.getByLabel("Beta runtime · Authentication and API key").click();
    expect(await transfer.textContent()).not.toContain("alpha-mounted-secret");
    expect(await transfer.textContent()).not.toContain("beta-mounted-secret");
    await transfer.getByRole("button", { name: "Review overwrite" }).click();
    await transfer.getByRole("heading", { name: "Confirm configuration overwrite" }).waitFor({ state: "visible" });
    expect((await read()).version?.revision?.value).toBe(independent.version?.revision?.value);
    await transfer.getByRole("button", { name: "Confirm and apply to draft" }).click();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor.waitFor({ state: "hidden", timeout: 20_000 });
    const copied = await read();
    const copiedBeta = copied.runtimes.find((item) => item.backendId === betaId)!;
    expect(copiedBeta.endpoint).toBe(alpha.endpoint);
    expect(copiedBeta.models.map((model) => model.modelId)).toEqual(alpha.models.map((model) => model.modelId));
    expect(copiedBeta.credentialReferenceId).toBe(alpha.credentialReferenceId);

    await second.setViewportSize({ width: 390, height: 844 });
    expect(await overflow(second)).toBeLessThanOrEqual(1);
    await staleEditor.getByRole("button", { name: "Save", exact: true }).click();
    await staleEditor.getByText("The credential was saved, but the provider could not be saved.", { exact: false }).waitFor({ state: "visible", timeout: 20_000 });
    expect(await staleEditor.locator('input[type="password"]').inputValue()).toBe("");
    expect(await staleEditor.getByLabel("Display name").first().inputValue()).toBe("Mounted Route");
    const credentialCount = fixture.application.credentials!.list().length;
    await staleEditor.getByRole("button", { name: "Save", exact: true }).click();
    await staleEditor.getByText("Could not confirm the save.", { exact: false }).waitFor({ state: "visible", timeout: 20_000 });
    expect(fixture.application.credentials!.list()).toHaveLength(credentialCount);
    expect((await read()).version?.revision?.value).toBe(copied.version?.revision?.value);
    expect(await overflow(first)).toBeLessThanOrEqual(1);
    expect(await overflow(second)).toBeLessThanOrEqual(1);
    expect(firstErrors.filter((error) => !error.includes("409 (Conflict)"))).toEqual([]);
    expect(secondErrors.filter((error) => !error.includes("409 (Conflict)"))).toEqual([]);

    await first.locator(".provider-master-row", { hasText: "Mounted Route" }).dblclick();
    await first.locator(".provider-editor-modal").getByRole("button", { name: "Copy to other runtimes" }).click();
    await first.locator(".provider-transfer-modal").waitFor({ state: "visible" });
    const webConnection = fixture.application.store.listConnections().find((item) => item.id !== inspector.connectionId);
    if (webConnection === undefined) throw new Error("Mounted Provider connection was not recorded.");
    fixture.application.connections.revoke(webConnection.id);
    await first.locator(".connection-card").waitFor({ state: "visible", timeout: 20_000 });
    expect(await first.locator(".provider-transfer-modal").count()).toBe(0);
    expect((await read()).version?.revision?.value).toBe(copied.version?.revision?.value);
  });
});

function browserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console:${message.text()}`); });
  return errors;
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
