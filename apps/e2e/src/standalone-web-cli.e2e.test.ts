import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { create } from "@bufbuild/protobuf";
import {
  ModelInputModality, OperationMutationSchema, OperationState, OwnerSnapshotScopeSchema,
  ProviderApiCompatibility, ProviderConfigurationSchema, ProviderKind, RunState,
  SessionSnapshotScopeSchema, SnapshotScopeSchema
} from "@joko/contracts";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { expect, it } from "vitest";

import { createE2eClients } from "./connect-clients.js";
import { submit } from "./operations.js";
import {
  REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, startLocalProvider, type CapturedProviderRequest
} from "./real-pi-fixture.js";
import {
  pollOwned, StandaloneWebCliFixture, STANDALONE_WORKSPACE_ID
} from "./standalone-web-cli-fixture.js";

const standaloneIt = process.env.JOKO_STANDALONE_WEB_CLI === "1" ? it : it.skip;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const firstPrompt = "Persist this task through an independent backend restart.";
const secondPrompt = "Confirm this recovered task can accept a second input.";
const controlledReply = "Controlled local Provider reply through the production Pi CLI.";

standaloneIt("pairs the production Web with an independent CLI, sends a task and restores it after restart",
  { timeout: 300_000 }, async () => {
    const webDirectory = await requiredAbsoluteDirectory("JOKO_MOUNTED_WEB_DIR");
    const browserExecutable = process.env.JOKO_BROWSER_EXECUTABLE?.trim();
    const evidenceDirectory = process.env.JOKO_STANDALONE_WEB_EVIDENCE_DIR?.trim();
    if (!browserExecutable || !isAbsolute(browserExecutable) || !evidenceDirectory || !isAbsolute(evidenceDirectory)) {
      throw new Error("Standalone Web CLI requires absolute browser and evidence paths.");
    }
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
    if (!/^[a-f0-9]{40}$/u.test(sourceCommit)
      || process.env.GITHUB_ACTIONS === "true" && sourceCommit !== process.env.GITHUB_SHA) {
      throw new Error("Standalone Web CLI source identity does not match the Actions checkout.");
    }
    const headed = process.env.JOKO_STANDALONE_WEB_CLI_HEADED === "1";
    const operations: Array<{ step: string; elapsedMs: number; screenshot?: string }> = [];
    const browserEvents: Array<{ event: string; elapsedMs: number }> = [];
    const startedAt = performance.now();
    const recordBrowserEvent = (event: "context_closed" | "page_closed" | "page_crashed" | "cleanup_started"): void => {
      browserEvents.push({ event, elapsedMs: Math.round(performance.now() - startedAt) });
    };
    const record = (step: string, screenshot?: string): void => {
      operations.push({ step, elapsedMs: Math.round(performance.now() - startedAt),
        ...(screenshot === undefined ? {} : { screenshot }) });
    };
    let fixture: StandaloneWebCliFixture | undefined;
    let provider: Server | undefined;
    let browser: BrowserContext | undefined;
    let browserVersion: string | undefined;
    let page: Page | undefined;
    let pageErrorCount = 0;
    let completed = false;
    let cleanupComplete = false;
    let sessionId: string | undefined;
    let serverId: string | undefined;
    let cliEntrySha256: string | undefined;
    const webIndexSha256 = await sha256File(join(webDirectory, "index.html"));
    const requests: CapturedProviderRequest[] = [];
    const screenshot = async (name: string): Promise<void> => {
      if (page === undefined) return;
      await page.screenshot({ path: join(evidenceDirectory, name), fullPage: false, animations: "disabled",
        mask: [page.locator(".pair-form input"), page.locator('input[type="password"]')] });
    };
    const captureReplies = async (name: string, minimumReplies: number): Promise<void> => {
      if (page === undefined || sessionId === undefined) throw new Error("A reply capture requires its current task.");
      const currentPage = page;
      const timeline = currentPage.locator(".timeline");
      const replies = timeline.getByText(controlledReply, { exact: true });
      const settled = async (): Promise<boolean> => {
        if (await timeline.getAttribute("data-timeline-session-id") !== sessionId
          || await currentPage.locator(".timeline--empty, .timeline-history .spinner").count() !== 0
          || await replies.count() < minimumReplies || !await replies.last().isVisible()) return false;
        const bounds = await replies.last().boundingBox();
        const viewport = currentPage.viewportSize();
        return bounds !== null && viewport !== null && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height
          && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width;
      };
      await pollOwned(async () => {
        if (await replies.count() < minimumReplies || !await replies.last().isVisible()) return false;
        try { await replies.last().scrollIntoViewIfNeeded(); }
        catch (error) {
          // Hydration may retire the transient reply while Playwright waits for
          // its geometry. Resolve the current reply again within this same poll.
          if (error instanceof Error && error.message.includes("Element is not attached to the DOM")) return false;
          throw error;
        }
        if (!await settled()) return false;
        const bytes = await currentPage.screenshot({ fullPage: false, animations: "disabled",
          mask: [currentPage.locator(".pair-form input"), currentPage.locator('input[type="password"]')] });
        // Native-history hydration can replace a just-visible transient reply
        // while the screenshot is captured. Save only the settled task frame.
        if (!await settled()) return false;
        await writeFile(join(evidenceDirectory, name), bytes, { mode: 0o600 });
        return true;
      }, value => value, "the current task's visible reply capture", 30_000);
    };

    try {
      fixture = await StandaloneWebCliFixture.create(webDirectory);
      cliEntrySha256 = await sha256File(fixture.cliEntry);
      provider = await startLocalProvider(requests, undefined, undefined, [],
        () => ({ kind: "text", text: controlledReply }));
      await fixture.start();
      const anonymous = createE2eClients(fixture.baseUrl);
      serverId = (await anonymous.connection.getServerInfo({})).server?.serverId;
      if (!serverId) throw new Error("The separate CLI returned no public node identity.");
      record("independent-production-cli-ready");
      const inspector = await fixture.pairInspector();
      const providerConfiguration = create(ProviderConfigurationSchema, {
        providerId: REAL_PI_PROVIDER_ID, displayName: "Controlled local E2E Provider",
        kind: ProviderKind.LOCAL_KEYLESS, enabled: true, version: { revision: { value: 0n } },
        runtimes: [{ backendId: "pi", apiCompatibility: ProviderApiCompatibility.OPENAI_COMPLETIONS,
          endpoint: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, keyless: true,
          models: [{ modelId: REAL_PI_MODEL_ID, displayName: "Controlled local E2E model",
            inputModalities: [ModelInputModality.TEXT], contextWindowTokens: 16_384n, maximumOutputTokens: 1024n }] }]
      });
      const saved = await submit(inspector.clients.operation, inspector.connectionId,
        create(OperationMutationSchema, { payload: { case: "upsertProvider", value: { provider: providerConfiguration } } }));
      expect(saved.state).toBe(OperationState.SUCCEEDED);
      const ownerScope = create(SnapshotScopeSchema, { kind: { case: "owner", value: create(OwnerSnapshotScopeSchema, {}) } });
      const owner = await pollOwned(() => inspector.clients.event.getSnapshot({ scope: ownerScope }),
        response => response.snapshot?.models.some(model => model.key?.providerId === REAL_PI_PROVIDER_ID && model.available) === true,
        "the public managed Provider model catalog", 30_000);
      const target = owner.snapshot?.targets.find(candidate => candidate.backendId === "pi"
        && candidate.workspaceId === STANDALONE_WORKSPACE_ID);
      if (!target) throw new Error("The standalone CLI did not publish its configured Pi workspace target.");
      record("controlled-keyless-provider-saved-through-public-rpc");

      browser = await chromium.launchPersistentContext(join(fixture.root, "browser-profile"), {
        executablePath: browserExecutable, headless: !headed, viewport: { width: 1440, height: 960 }, locale: "en-US"
      });
      browserVersion = browser.browser()?.version();
      browser.on("close", () => recordBrowserEvent("context_closed"));
      page = browser.pages()[0] ?? await browser.newPage();
      page.on("close", () => recordBrowserEvent("page_closed"));
      page.on("crash", () => recordBrowserEvent("page_crashed"));
      page.on("pageerror", () => { pageErrorCount += 1; });
      page.setDefaultTimeout(20_000);
      await page.goto(`${fixture.baseUrl}/#/tasks/new?target=${encodeURIComponent(target.targetId)}`, { waitUntil: "domcontentloaded" });
      await page.locator(".connection-tabs > button").nth(2).click();
      await page.getByLabel("Joko node address").fill(fixture.baseUrl);
      await page.getByLabel("Device name").fill("Standalone Web browser");
      await screenshot("01-pairing-page.png");
      record("browser-opened-normal-pairing-form", "01-pairing-page.png");
      // This code came only from the trusted console pipe. Do not put it in
      // screenshots, operation records, URLs, browser traces or assertion output.
      const pairingCode = await fixture.pairingCode();
      try { await page.getByLabel("Pairing code").fill(pairingCode); }
      catch { throw new Error("The browser could not enter its owner-issued pairing credential."); }
      await page.locator("form.pair-form button[type=submit]").click();
      const composer = page.locator(".new-task-composer");
      await composer.waitFor({ state: "visible", timeout: 30_000 });
      await composer.locator(".new-task-composer__select--model").click();
      await page.getByRole("option", { name: /Controlled local E2E model/u }).click();
      await composer.locator('[data-composer-editor="true"] [contenteditable="true"]').fill(firstPrompt);
      await screenshot("02-new-task-input.png");
      record("browser-paired-and-entered-first-task-input", "02-new-task-input.png");
      await composer.locator(".send-button").click();
      await page.waitForURL(url => {
        const route = new URL(url.hash.slice(1), url.origin);
        return /^\/tasks\/[^/]+$/u.test(route.pathname) && route.pathname !== "/tasks/new";
      }, { timeout: 45_000 });
      const createdRoute = new URL(new URL(page.url()).hash.slice(1), fixture.baseUrl);
      sessionId = decodeURIComponent(createdRoute.pathname.slice("/tasks/".length));
      const connectionProfileId = createdRoute.searchParams.get("profile");
      expect(connectionProfileId).not.toBeNull();
      const sessionScope = create(SnapshotScopeSchema, {
        kind: { case: "session", value: create(SessionSnapshotScopeSchema, { sessionId, recentTimelineItems: 100 }) }
      });
      const completedTurn = await pollOwned(() => inspector.clients.event.getSnapshot({ scope: sessionScope }),
        response => response.snapshot?.runs.some(run => run.state === RunState.SUCCEEDED) === true,
        "the first persisted production Pi turn", 45_000);
      expect(requests.some(request => request.body["model"] === REAL_PI_MODEL_ID
        && JSON.stringify(request.body).includes(firstPrompt))).toBe(true);
      expect(completedTurn.snapshot?.pi?.sessions.some(session => session.productSessionId === sessionId)).toBe(true);
      await page.locator(".timeline").getByText(controlledReply, { exact: true }).first().waitFor({ state: "visible", timeout: 30_000 });
      await captureReplies("03-completed-turn.png", 1);
      record("first-input-persisted-and-controlled-provider-reply-rendered", "03-completed-turn.png");

      const previousGeneration = fixture.observations.at(-1)!.generation;
      await fixture.stop();
      expect(fixture.observations.at(-1)?.exited).toBe(true);
      await screenshot("04-backend-stopped.png");
      record("owned-independent-cli-exited-and-listener-closed", "04-backend-stopped.png");
      await fixture.start();
      expect(fixture.observations.at(-1)!.generation).toBe(previousGeneration + 1);
      expect((await anonymous.connection.getServerInfo({})).server?.serverId).toBe(serverId);
      expect((await inspector.clients.session.getSession({ sessionId })).session?.sessionId).toBe(sessionId);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(".timeline").getByText(controlledReply, { exact: true }).first().waitFor({ state: "visible", timeout: 45_000 });
      const restoredRoute = new URL(new URL(page.url()).hash.slice(1), fixture.baseUrl);
      expect(restoredRoute.pathname).toBe(`/tasks/${encodeURIComponent(sessionId)}`);
      expect(restoredRoute.searchParams.get("profile")).toBe(connectionProfileId);
      expect(await page.locator(".pair-form").count()).toBe(0);
      await captureReplies("05-restored-task.png", 1);
      record("same-node-and-task-restored-using-saved-browser-pairing", "05-restored-task.png");

      const recoveredComposer = page.locator(".session-pane .composer").first();
      await recoveredComposer.locator('[data-composer-editor="true"] [contenteditable="true"]').fill(secondPrompt);
      await recoveredComposer.locator(".send-button").click();
      const resumed = await pollOwned(() => inspector.clients.event.getSnapshot({ scope: sessionScope }),
        response => (response.snapshot?.runs.filter(run => run.state === RunState.SUCCEEDED).length ?? 0) >= 2,
        "the resumed task's second persisted production Pi turn", 45_000);
      expect(resumed.snapshot?.sessions[0]?.sessionId).toBe(sessionId);
      expect(requests.some(request => JSON.stringify(request.body).includes(secondPrompt))).toBe(true);
      await pollOwned(() => page!.locator(".timeline").getByText(controlledReply, { exact: true }).count(), count => count >= 2,
        "the second controlled Provider reply in the recovered browser task", 30_000);
      await captureReplies("06-followup-after-restart.png", 2);
      record("restored-task-accepted-second-input-and-rendered-reply", "06-followup-after-restart.png");
      expect(pageErrorCount).toBe(0);
      completed = true;
    } catch (error) {
      await screenshot("failure.png").catch(() => undefined);
      record("chain-failed", "failure.png");
      throw error;
    } finally {
      let cleanupError: unknown;
      recordBrowserEvent("cleanup_started");
      try { await browser?.close(); } catch (error) { cleanupError = error; }
      try { await fixture?.close(); } catch (error) { cleanupError ??= error; }
      try {
        if (provider !== undefined) {
          provider.closeAllConnections();
          await new Promise<void>((accept, reject) => provider!.close(error => error ? reject(error) : accept()));
        }
      } catch (error) { cleanupError ??= error; }
      cleanupComplete = cleanupError === undefined;
      // Deliberately omit auth/storage state, console output, Provider payloads
      // and profile paths. Screenshots contain only the controlled local task.
      await writeFile(join(evidenceDirectory, "operations.json"), `${JSON.stringify({
        sourceCommit, platform: process.platform, architecture: process.arch, nodeVersion: process.version,
        cliEntrySha256, webIndexSha256,
        browserMode: headed ? "headed" : "headless", browserVersion,
        screenshotMode: process.env.PLAYWRIGHT_LEGACY_SCREENSHOT ? "legacy" : "surface",
        browserEvents, serverId, sessionId,
        publicPort: fixture?.publicPort, internalPort: fixture?.internalPort,
        serviceProcesses: fixture?.observations ?? [], providerBoundary: "controlled-loopback-openai-compatible-fixture",
        realModelServiceTested: false, providerRequestCount: requests.length,
        operations, pageErrorCount, completed, cleanupComplete
      }, null, 2)}\n`, { mode: 0o600 });
      if (cleanupError !== undefined) throw new Error("Standalone Web CLI did not confirm all owned resources were retired.");
    }
  });

async function requiredAbsoluteDirectory(name: string): Promise<string> {
  const value = process.env[name]?.trim();
  if (!value || !isAbsolute(value)) throw new Error(`Standalone Web CLI requires an absolute ${name}.`);
  return realpath(value);
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
