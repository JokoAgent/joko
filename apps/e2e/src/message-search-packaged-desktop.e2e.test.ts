import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { RunState } from "@joko/contracts";
import type { BackendDescriptor } from "@joko/core";
import {
  CredentialManager,
  CredentialVault,
  MessageSearchEmbeddingCoordinator,
  ProviderCatalogManager
} from "@joko/orchestrator";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterEach, expect, it } from "vitest";

import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  archiveMutation,
  createSessionMutation,
  queueRunIdFrom,
  sendInputMutation,
  sessionIdFrom,
  submit
} from "./operations.js";

const packagedIt = process.platform === "win32" && process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE?.trim()
  ? it : it.skip;
const SECONDARY_BACKEND_ID = "search-secondary";
const EMBEDDING_MODEL_ID = "voyage/voyage-4";

interface OwnedDesktopProcess {
  readonly pid: number;
  readonly executablePath: string;
  readonly startedAt: string;
}

class SearchFixtureAdapter extends InstrumentedFakeAdapter {
  override async describe(): Promise<BackendDescriptor> {
    const descriptor = await super.describe();
    return {
      ...descriptor,
      providers: PI_LIKE_PROFILE.models.map((model) => ({
        providerId: model.providerId,
        displayName: model.providerId,
        api: model.api,
        authenticationState: "not_required",
        loginMethods: [],
        supportsLogin: false,
        supportsLogout: false,
        supportsRefresh: false,
        supportsModelRefresh: false
      }))
    };
  }
}

let fixture: OrchestratorE2eFixture | undefined;
let embeddingServer: Server | undefined;
let desktop: ElectronApplication | undefined;
let desktopIdentity: OwnedDesktopProcess | undefined;
let profileDirectory: string | undefined;

afterEach(async () => {
  try {
    await closeDesktop();
  } finally {
    await fixture?.close();
    fixture = undefined;
    if (embeddingServer !== undefined) {
      embeddingServer.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => embeddingServer!.close((error) =>
        error ? rejectClose(error) : resolveClose()));
      embeddingServer = undefined;
    }
    if (profileDirectory !== undefined) {
      const target = resolve(profileDirectory);
      if (dirname(target) !== resolve(tmpdir()) || !target.split(/[\\/]/u).at(-1)?.startsWith("joko-search-desktop-")) {
        throw new Error("Refusing to remove an unexpected search Desktop profile.");
      }
      await rm(target, { recursive: true, force: true });
      profileDirectory = undefined;
    }
  }
}, 90_000);

packagedIt("searches completed and paged older messages through packaged Desktop without stale results", {
  timeout: 300_000
}, async () => {
  const executablePath = resolve(process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE!);
  const embeddingQueries: string[] = [];
  embeddingServer = createServer(async (request, response) => {
    try {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/embeddings");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        readonly model: string;
        readonly input: readonly string[];
        readonly input_type: string;
        readonly dimensions: number;
      };
      expect(body.model).toBe(EMBEDDING_MODEL_ID);
      expect(body.dimensions).toBe(1024);
      if (body.input_type === "query") embeddingQueries.push(...body.input);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        object: "list",
        model: EMBEDDING_MODEL_ID,
        data: body.input.map((_text, index) => ({
          object: "embedding",
          index,
          embedding: Array.from({ length: 1024 }, (_, axis) => axis === 0 ? 1 : 0)
        }))
      }));
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>((resolveListen) => embeddingServer!.listen(0, "127.0.0.1", resolveListen));
  const address = embeddingServer.address();
  if (address === null || typeof address === "string") throw new Error("Embedding server has no TCP address.");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  let providers!: ProviderCatalogManager;
  let searchIndex!: MessageSearchEmbeddingCoordinator;
  fixture = await OrchestratorE2eFixture.start({
    profiles: [PI_LIKE_PROFILE, {
      ...PI_LIKE_PROFILE, id: SECONDARY_BACKEND_ID, displayName: "Secondary search Backend"
    }],
    createAdapter: (profile) => new SearchFixtureAdapter(profile),
    createAuxiliaryServices: async (store, dataDirectory) => {
      const vault = await CredentialVault.open(join(dataDirectory, "search-vault.key"));
      const credentials = new CredentialManager({ vault, storagePath: join(dataDirectory, "search-credentials.json") });
      await credentials.initialize();
      providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: PI_LIKE_PROFILE.id });
      providers.initialize();
      await providers.upsert({
        backendId: PI_LIKE_PROFILE.id,
        credentialOrigin: "",
        provider: {
          id: "search-local", baseUrl, api: "openai-completions", keyless: true,
          models: [{ id: EMBEDDING_MODEL_ID, name: "Local embedding", contextWindow: 32_768, maxTokens: 4_096 }]
        },
        displayName: "Local search", kind: "custom_endpoint", credentialBindings: {},
        enabled: true, supportsLogin: false, supportsLogout: false, supportsRefresh: false
      });
      searchIndex = new MessageSearchEmbeddingCoordinator({ store, providers });
      searchIndex.start();
      return { providers, messageSearch: searchIndex };
    }
  });
  const manager = await fixture.pair("Search Desktop manager");
  const createSearchSession = async (backendId: string, displayName: string, turns: readonly string[]) => {
    const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
      createSessionMutation({ backendId, targetId: fixture!.targetId(backendId), displayName })));
    for (const text of turns) {
      const generation = BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation);
      const sent = await submit(manager.clients.operation, manager.connectionId,
        sendInputMutation(sessionId, generation, text));
      await waitFor(() => manager.clients.run.getRun({ runId: queueRunIdFrom(sent) }),
        (run) => run.run?.state === RunState.SUCCEEDED, `completed search turn ${text}`);
    }
    return sessionId;
  };
  const alphaSessionId = await createSearchSession(PI_LIKE_PROFILE.id, "Alpha task", [
    "mosaicneedle alpha one", "mosaicneedle alpha two", "mosaicneedle alpha three", "mosaicneedle alpha four"
  ]);
  const betaSessionId = await createSearchSession(SECONDARY_BACKEND_ID, "Beta task", ["mosaicneedle beta one"]);
  await waitFor(async () => { await searchIndex.drain(); return searchIndex.status(); },
    (status) => status.doneCount === 5 && status.pendingCount === 0, "indexed Desktop search turns");
  expect(searchIndex.status().vectorAvailable).toBe(true);

  const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Search Desktop" });
  if (challenge.challenge === undefined) throw new Error("Desktop pairing returned no challenge.");
  profileDirectory = await mkdtemp(join(tmpdir(), "joko-search-desktop-"));
  desktop = await _electron.launch({
    executablePath,
    env: {
      ...process.env,
      JOKO_DESKTOP_MANAGED_ORCHESTRATOR: "0",
      JOKO_DESKTOP_PACKAGED_SMOKE: "1",
      JOKO_DESKTOP_SMOKE_SCOPE: "external",
      JOKO_DESKTOP_SMOKE_USER_DATA: profileDirectory
    },
    timeout: 60_000
  });
  const mainPid = await desktop.evaluate(() => process.pid);
  desktopIdentity = await readOwnedDesktopProcess(mainPid);
  if (desktopIdentity === undefined || resolve(desktopIdentity.executablePath).toLowerCase() !== executablePath.toLowerCase()) {
    throw new Error("Search Desktop launched an unexpected executable.");
  }
  const userDataPath = await desktop.evaluate(({ app }) => app.getPath("userData"));
  const profileRelative = relative(profileDirectory, userDataPath);
  if (profileRelative.startsWith("..") || isAbsolute(profileRelative)) {
    throw new Error("Search Desktop did not use its isolated profile.");
  }
  const page = await desktop.firstWindow({ timeout: 60_000 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.locator(".connection-screen").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(".connection-tabs > button").nth(2).click();
  await page.getByLabel("Joko node address").fill(fixture.baseUrl);
  await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
  await page.getByLabel("Device name").fill("Search Desktop");
  await page.locator("form.pair-form button[type=submit]").click();
  await page.locator(".app").waitFor({ state: "visible", timeout: 30_000 });

  const searchInput = page.locator("#conversation-search-input");
  await searchInput.fill("mosaicneedle");
  const alphaResult = page.locator('.conversation-search-result[aria-label="Alpha task"]');
  const betaResult = page.locator('.conversation-search-result[aria-label="Beta task"]');
  await alphaResult.waitFor({ state: "visible", timeout: 30_000 });
  await betaResult.waitFor({ state: "visible", timeout: 30_000 });
  expect(await alphaResult.locator(".conversation-search-result__hit").count()).toBe(3);
  await alphaResult.locator(".conversation-search-result__more").click();
  expect(await alphaResult.locator(".conversation-search-result__hit").count()).toBeGreaterThan(3);
  await waitFor(() => Promise.resolve(embeddingQueries.length), (count) => count > 0,
    "packaged Desktop hybrid embedding query", 10_000);
  expect(embeddingQueries).toContain("mosaicneedle");

  await page.locator(".conversation-search-filter > summary").click();
  const filter = page.locator(".conversation-search-filter");
  await chooseSearchFilter(page, 2, 2);
  await betaResult.waitFor({ state: "visible", timeout: 30_000 });
  await alphaResult.waitFor({ state: "hidden", timeout: 30_000 });
  await chooseSearchFilter(page, 2, 0);
  await chooseSearchFilter(page, 1, 1);
  await betaResult.waitFor({ state: "hidden", timeout: 30_000 });
  await submit(manager.clients.operation, manager.connectionId, archiveMutation(betaSessionId, true));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Connect", exact: true }).click({ timeout: 30_000 });
  await page.locator('.app').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator(`.sidebar [data-session-id="${alphaSessionId}"]`).first()
    .waitFor({ state: 'visible', timeout: 30_000 });
  await searchInput.fill("mosaicneedle");
  await betaResult.waitFor({ state: "visible", timeout: 30_000 });
  await chooseSearchFilter(page, 1, 2);
  const projectCheckboxes = filter.locator('.conversation-search-filter__projects button[role="checkbox"]');
  await openSearchFilter(page);
  await projectCheckboxes.nth(2).click();
  await betaResult.waitFor({ state: "visible", timeout: 30_000 });
  await alphaResult.waitFor({ state: "hidden", timeout: 30_000 });
  await filter.locator(".conversation-search-filter__header button").click();
  await chooseSearchFilter(page, 0, 2);
  await searchInput.fill("mosaicneedle unmatched");
  await page.locator(".conversation-search-result").first().waitFor({ state: "hidden", timeout: 30_000 });
  await searchInput.fill("mosaicneedle");
  await betaResult.waitFor({ state: "visible", timeout: 30_000 });
  await providers.deleteRuntime(PI_LIKE_PROFILE.id, "search-local", {
    expectedVersion: providers.get(PI_LIKE_PROFILE.id, "search-local").version
  });
  searchIndex.reconcileAvailability();
  expect(searchIndex.status().enabled).toBe(false);
  await page.setViewportSize({ width: 1440, height: 960 });
  await searchInput.fill("mosaicneedle alpha");
  await alphaResult.waitFor({ state: "visible", timeout: 30_000 });
  const queryCountAfterLoss = embeddingQueries.length;
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1_100));
  expect(embeddingQueries).toHaveLength(queryCountAfterLoss);
  expect(await page.locator(".sidebar-search__status--error").count()).toBe(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Connect", exact: true }).click({ timeout: 30_000 });
  await page.locator('.app').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator(`.sidebar [data-session-id="${alphaSessionId}"]`).first()
    .waitFor({ state: 'visible', timeout: 30_000 });
  await searchInput.fill("mosaicneedle alpha");
  await alphaResult.waitFor({ state: "visible", timeout: 30_000 });
  await searchInput.fill("mosaicneedle");
  await betaResult.waitFor({ state: "visible", timeout: 30_000 });
  const closeInspector = page.locator('.inspector.is-open button[aria-label="Close details"]');
  if (await closeInspector.isVisible()) await closeInspector.click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await betaResult.locator(".conversation-search-result__hit").first().click();
  await page.locator(`.timeline[data-timeline-session-id="${betaSessionId}"]`)
    .waitFor({ state: "visible", timeout: 30_000 });
  const focused = page.locator(".timeline__row.is-search-focus");
  await focused.waitFor({ state: "visible", timeout: 30_000 });
  expect(await focused.innerText()).toContain("mosaicneedle beta one");
  expect(await page.evaluate(() => window.location.hash)).toContain(encodeURIComponent(betaSessionId));

  const earlyPage = await manager.clients.session.listSessionTimeline({ sessionId: alphaSessionId, limit: 240 });
  const earlyEventIds = new Set(earlyPage.events.map((event) => event.eventId));
  for (let turn = 0; turn < 230; turn += 1) {
    const generation = BigInt(fixture.application.store.getSession(alphaSessionId).descriptor.binding.generation);
    const sent = await submit(manager.clients.operation, manager.connectionId,
      sendInputMutation(alphaSessionId, generation, `timeline filler ${turn}`));
    await waitFor(() => manager.clients.run.getRun({ runId: queueRunIdFrom(sent) }),
      (run) => run.run?.state === RunState.SUCCEEDED, `completed Timeline filler ${turn}`);
  }
  const latestPage = await manager.clients.session.listSessionTimeline({ sessionId: alphaSessionId, limit: 240 });
  expect(latestPage.nextBeforeCursor).toBeDefined();
  expect(latestPage.events.some((event) => earlyEventIds.has(event.eventId))).toBe(false);

  await page.getByRole("button", { name: "Open navigation" }).click();
  await searchInput.waitFor({ state: "visible", timeout: 10_000 });
  await page.setViewportSize({ width: 1440, height: 960 });
  await searchInput.fill("mosaicneedle alpha one");
  const oldAlphaHit = alphaResult.locator(".conversation-search-result__hit")
    .filter({ hasText: "mosaicneedle alpha one" }).first();
  await oldAlphaHit.click({ timeout: 30_000 });
  await page.locator(`.timeline[data-timeline-session-id="${alphaSessionId}"]`)
    .waitFor({ state: "visible", timeout: 30_000 });
  const oldAlphaFocus = focused.filter({ hasText: "mosaicneedle alpha one" });
  await oldAlphaFocus.waitFor({ state: "visible", timeout: 30_000 });
  await searchInput.fill("mosaicneedle beta one");
  await betaResult.waitFor({ state: "visible", timeout: 30_000 });
  await betaResult.locator(".conversation-search-result__hit").first().click();
  await page.locator(`.timeline[data-timeline-session-id="${betaSessionId}"]`)
    .waitFor({ state: "visible", timeout: 30_000 });
  await focused.filter({ hasText: "mosaicneedle beta one" })
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await Promise.race([
    page.locator(".app").waitFor({ state: "visible", timeout: 30_000 }),
    page.locator(".connection-screen").waitFor({ state: "visible", timeout: 30_000 })
  ]);
  if (await page.locator(".connection-screen").isVisible()) {
    await page.getByRole("button", { name: "Connect", exact: true }).click({ timeout: 30_000 });
  }
  await page.locator(".app").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(`.sidebar [data-session-id="${alphaSessionId}"]`).first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await searchInput.fill("mosaicneedle alpha one");
  await oldAlphaHit.click({ timeout: 30_000 });
  await page.locator(`.timeline[data-timeline-session-id="${alphaSessionId}"]`)
    .waitFor({ state: "visible", timeout: 30_000 });
  await oldAlphaFocus.waitFor({ state: "visible", timeout: 30_000 });
  expect(await oldAlphaFocus.innerText()).not.toContain("mosaicneedle beta one");
  expect(pageErrors).toEqual([]);
  await closeDesktop();
});

async function chooseSearchFilter(page: Page, filterIndex: number, optionIndex: number): Promise<void> {
  await openSearchFilter(page);
  const trigger = page.locator('.conversation-search-filter button[data-select-control="true"]').nth(filterIndex);
  const bounds = await trigger.boundingBox();
  if (bounds === null) throw new Error("Search filter trigger has no visible bounds.");
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.locator('.select-control__listbox [role="option"]').nth(optionIndex).click();
}

async function openSearchFilter(page: Page): Promise<void> {
  const filter = page.locator('.conversation-search-filter');
  if (await filter.getAttribute('open') === null) await filter.locator('summary').click();
}

async function closeDesktop(): Promise<void> {
  if (desktopIdentity === undefined) return;
  const original = desktopIdentity;
  const current = await readOwnedDesktopProcess(original.pid);
  if (current !== undefined && (current.executablePath.toLowerCase() !== original.executablePath.toLowerCase()
    || current.startedAt !== original.startedAt)) {
    throw new Error("Search Desktop cleanup refused a changed process identity.");
  }
  if (current !== undefined) {
    await desktop?.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); return true; }).catch(() => undefined);
    try {
      await waitFor(() => readOwnedDesktopProcess(original.pid), (candidate) => candidate === undefined,
        "Search Desktop complete exit", 30_000);
    } catch (error) {
      const stillOwned = await readOwnedDesktopProcess(original.pid);
      if (stillOwned !== undefined && stillOwned.executablePath.toLowerCase() === original.executablePath.toLowerCase()
        && stillOwned.startedAt === original.startedAt) {
        await new Promise<void>((resolveKill, rejectKill) => {
          execFile("taskkill.exe", ["/PID", String(original.pid), "/T", "/F"],
            { windowsHide: true, timeout: 10_000 }, (killError) => killError ? rejectKill(killError) : resolveKill());
        });
      }
      throw new Error("Search Desktop did not complete its normal exit.", { cause: error });
    }
  }
  desktopIdentity = undefined;
  desktop = undefined;
}

async function readOwnedDesktopProcess(pid: number): Promise<OwnedDesktopProcess | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid Search Desktop PID.");
  const script = `$candidate = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $candidate) { [pscustomobject]@{ pid = $candidate.ProcessId; executablePath = $candidate.ExecutablePath; startedAt = $candidate.CreationDate.ToUniversalTime().ToString('O') } | ConvertTo-Json -Compress }`;
  const output = await new Promise<string>((resolveOutput, rejectOutput) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000 }, (error, stdout) => error ? rejectOutput(error) : resolveOutput(stdout));
  });
  return output.trim() ? JSON.parse(output) as OwnedDesktopProcess : undefined;
}
