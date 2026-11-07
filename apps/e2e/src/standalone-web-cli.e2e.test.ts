import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { create, fromBinary } from "@bufbuild/protobuf";
import {
  ListRuntimeCommandsRequestSchema, MessageRole, ModelInputModality, OperationMutationSchema, OperationState, OwnerSnapshotScopeSchema,
  ProviderApiCompatibility, ProviderConfigurationSchema, ProviderKind, RunState,
  SessionSnapshotScopeSchema, SnapshotScopeSchema, SubmitOperationRequestSchema
} from "@joko/contracts";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { expect, it } from "vitest";

import { createE2eClients } from "./connect-clients.js";
import { submit } from "./operations.js";
import {
  REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, startLocalProvider, type CapturedProviderRequest
} from "./real-pi-fixture.js";
import {
  pollOwned, StandaloneWebCliFixture, standaloneCliEntry, STANDALONE_WORKSPACE_ID
} from "./standalone-web-cli-fixture.js";

const standaloneIt = process.env.JOKO_STANDALONE_WEB_CLI === "1" ? it : it.skip;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const firstPrompt = "Persist this task through an independent backend restart.";
const secondPrompt = "Confirm this recovered task can accept a second input.";
const controlledReply = "Controlled local Provider reply through the production Pi CLI.";

const taskIt = process.env.JOKO_STANDALONE_WEB_CLI === "1" && process.platform === "linux" && process.arch === "x64" ? it : it.skip;
taskIt("runs two sequential Pi BYOM turns and writes local receipts from the production task command", { timeout: 120_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-standalone-task-e2e-")));
  const workspace = join(root, "work"), output = join(root, "result"), profile = join(root, "provider.json"), turns = join(root, "turns.json");
  const secret = "joko-test-standalone-private-provider-value";
  const requests: CapturedProviderRequest[] = [];
  let releaseFirst!: () => void;
  const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve; });
  const firstText = "The first standalone result", secondText = "The second standalone result";
  let provider: Server | undefined;
  let completion: Promise<{ stdout: string; stderr: string } | { error: unknown }> | undefined;
  try {
    provider = await startLocalProvider(requests, undefined, undefined, [], async ({ requestNumber }) => {
      if (requestNumber === 1) await firstResponse;
      return { kind: "text", text: requestNumber === 1 ? `${firstText} ${secret}` : secondText };
    });
    const address = provider.address() as AddressInfo;
    await mkdir(workspace);
    execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
    await writeFile(join(workspace, "config.local.json"), '{"ordinary":true}\n', { mode: 0o644 });
    const before = await stat(join(workspace, "config.local.json"));
    await writeFile(turns, JSON.stringify(["First owned standalone prompt", "Second owned standalone prompt"]));
    await writeFile(profile, JSON.stringify({ providerId: "standalone-fixture", displayName: "Standalone fixture", runtimes: [{
      backendId: "pi", apiCompatibility: "PROVIDER_API_COMPATIBILITY_OPENAI_COMPLETIONS", endpoint: `http://127.0.0.1:${address.port}/v1`,
      apiKeyEnvironment: "JOKO_STANDALONE_FIXTURE_KEY", models: [{ modelId: REAL_PI_MODEL_ID, displayName: "Fixture model",
        contextWindowTokens: "16384", maximumOutputTokens: "1024" }]
    }] }));
    const staged = process.env.JOKO_STANDALONE_ORCHESTRATOR_ENTRY?.trim();
    const args = [...(staged ? [] : ["--import", import.meta.resolve("tsx")]), staged ?? standaloneCliEntry,
      "run-task", "--profile", profile, "--model", REAL_PI_MODEL_ID, "--working-dir", workspace,
      "--turns-file", turns, "--output-dir", output, "--timeout-ms", "20000"];
    completion = promisify(execFile)(process.execPath, args, { cwd: workspace, timeout: 100_000,
      env: { PATH: process.env.PATH, JOKO_STANDALONE_FIXTURE_KEY: secret, JOKO_DATA_DIR: join(workspace, "must-not-use") },
      encoding: "utf8", maxBuffer: 1024 * 1024 }).then(value => value, error => ({ error }));
    await Promise.race([pollOwned(async () => requests.length, length => length > 0, "the first Provider request", 45_000),
      completion.then(value => { throw "error" in value ? value.error : new Error("The task finished before requesting its first turn."); })]);
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    expect(requests).toHaveLength(1);
    releaseFirst();
    const invocation = await completion;
    if ("error" in invocation) throw invocation.error;
    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.headers.authorization === `Bearer ${secret}`)).toBe(true);
    expect(JSON.stringify(requests[1]!.body["messages"])).toEqual(expect.stringContaining("First owned standalone prompt"));
    expect(JSON.stringify(requests[1]!.body["messages"])).toEqual(expect.stringContaining(firstText));
    expect(JSON.stringify(requests[1]!.body["messages"])).toEqual(expect.stringContaining("Second owned standalone prompt"));
    const resultText = await readFile(join(output, "result.json"), "utf8"), trace = await readFile(join(output, "trace.jsonl"), "utf8");
    const result = JSON.parse(resultText) as { sessionId: string; turns: { runId: string }[] };
    expect(JSON.parse(invocation.stdout)).toEqual(result);
    expect(result).toMatchObject({ version: 1, status: "completed", sessionId: expect.any(String), turns: [
      { state: "completed", text: `${firstText} [REDACTED]` }, { state: "completed", text: secondText }
    ] });
    expect(new Set(result.turns.map(turn => turn.runId)).size).toBe(2);
    const events = trace.trim().split("\n").map(line => JSON.parse(line) as { identity?: { sessionId?: string; runId?: string } });
    expect(events.filter(event => event.identity?.runId).every(event => event.identity?.sessionId === result.sessionId)).toBe(true);
    expect(result.turns.every(turn => events.some(event => event.identity?.runId === turn.runId))).toBe(true);
    expect(`${invocation.stdout}${invocation.stderr}${resultText}${trace}`).not.toContain(secret);
    expect((await stat(join(workspace, "config.local.json"))).mode).toBe(before.mode);
    await expect(stat(join(workspace, "must-not-use"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    releaseFirst();
    if (provider) { provider.closeAllConnections(); await new Promise<void>(resolve => provider!.close(() => resolve())); }
    await completion;
    await rm(root, { recursive: true, force: true });
  }
});

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
    let firstTurnProviderRequestCount: number | undefined;
    const inputEvidence: Array<Readonly<Record<string, unknown>>> = [];
    let observeInput: ((stage: string, timeoutMs?: number) => Promise<void>) | undefined;
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
        executablePath: browserExecutable, headless: !headed, viewport: { width: 1440, height: 960 }, locale: "en-US",
        args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
      });
      browserVersion = browser.browser()?.version();
      browser.on("close", () => recordBrowserEvent("context_closed"));
      page = browser.pages()[0] ?? await browser.newPage();
      page.on("close", () => recordBrowserEvent("page_closed"));
      page.on("crash", () => recordBrowserEvent("page_crashed"));
      page.on("pageerror", () => { pageErrorCount += 1; });
      page.on("request", request => {
        try {
          const url = new URL(request.url());
          if (url.origin !== fixture?.baseUrl || url.pathname !== "/joko.v1.OperationService/SubmitOperation") return;
          const bytes = request.postDataBuffer(); if (bytes === null) return;
          const mutation = fromBinary(SubmitOperationRequestSchema, bytes).mutation;
          if (mutation?.payload.case !== "sendInput" || inputEvidence.length >= 32) return;
          const input = mutation.payload.value;
          inputEvidence.push({ stage: "browser-send-input", elapsedMs: Math.round(performance.now() - startedAt),
            expectedGeneration: mutation.preconditions.find(item => item.entity?.id === input.sessionId)?.expectedGeneration.toString(),
            firstPrompt: input.input?.parts.some(part => part.content.case === "text" && part.content.value.includes(firstPrompt)) === true,
            secondPrompt: input.input?.parts.some(part => part.content.case === "text" && part.content.value.includes(secondPrompt)) === true });
        } catch { /* Retain no request body or credential when a different wire shape is used. */ }
      });
      page.setDefaultTimeout(20_000);
      await page.goto(`${fixture.baseUrl}/#/tasks/new?target=${encodeURIComponent(target.targetId)}`, { waitUntil: "domcontentloaded" });
      await browser.grantPermissions(["microphone"], { origin: fixture.baseUrl });
      expect(await page.evaluate(async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        try { return stream.getAudioTracks().length; }
        finally { for (const track of stream.getTracks()) track.stop(); }
      })).toBe(1);
      record("official-web-page-captured-and-released-a-browser-test-microphone");
      await page.locator(".connection-tabs > button").nth(2).click();
      await page.locator('details.device-authorization__manual > summary').click();
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
      observeInput = async (stage, timeoutMs = 5_000) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<never>((_accept, reject) => {
          timer = setTimeout(() => reject(new Error("Controlled input evidence exceeded its bound.")), timeoutMs);
        });
        try {
          const observation = await Promise.race([expired, (async () => {
            const [current, timeline] = await Promise.all([
              inspector.clients.event.getSnapshot({ scope: sessionScope }, { timeoutMs }),
              inspector.clients.session.listSessionTimeline({ sessionId: sessionId!, limit: 100 }, { timeoutMs })
            ]);
            const snapshot = current.snapshot;
            const session = snapshot?.sessions.find(item => item.sessionId === sessionId);
            const ui = await page!.evaluate(({ expectedSessionId, secondPrompt }) => {
              const pane = document.querySelector<HTMLElement>(".session-pane");
              const editor = pane?.querySelector<HTMLElement>('[data-composer-editor="true"] [contenteditable]');
              const send = pane?.querySelector<HTMLButtonElement>(".composer .send-button");
              const generation = pane?.dataset.inputSessionGeneration;
              return { sessionMatches: pane?.dataset.inputSessionId === expectedSessionId,
                generation: generation !== undefined && /^[0-9]{1,20}$/u.test(generation) ? generation : undefined,
                editorEditable: editor?.getAttribute("contenteditable") === "true",
                editorEmpty: !editor?.textContent?.trim(), secondPromptInEditor: editor?.textContent?.includes(secondPrompt) === true,
                sendDisabled: send?.disabled, generationConflict: document.body.textContent?.includes("Generation precondition failed") === true };
            }, { expectedSessionId: sessionId, secondPrompt });
            return { stage, elapsedMs: Math.round(performance.now() - startedAt), generation: session?.nativeBinding?.runtimeGeneration.toString(),
              runtimeAttached: session?.nativeBinding?.runtimeAttached, sessionState: session?.state,
              succeededRuns: snapshot?.runs.filter(run => run.state === RunState.SUCCEEDED).length,
              acceptedUserMessages: timeline.events.filter(event => event.payload?.kind.case === "messageStarted"
                && event.payload.kind.value.role === MessageRole.USER && event.payload.kind.value.userInputAccepted).length,
              acceptedQueueInputs: snapshot?.queueItems.length,
              queueInputsWithSecondPrompt: snapshot?.queueItems.filter(item => item.input?.parts.some(part => part.content.case === "text" && part.content.value.includes(secondPrompt))).length,
              queueStates: snapshot?.queueItems.slice(-8).map(item => item.state), ui };
          })()]);
          inputEvidence.push(observation);
        } finally { clearTimeout(timer); }
      };
      const completedTurn = await pollOwned(() => inspector.clients.event.getSnapshot({ scope: sessionScope }),
        response => response.snapshot?.runs.some(run => run.state === RunState.SUCCEEDED) === true,
        "the first persisted production Pi turn", 45_000);
      expect(requests.some(request => request.body["model"] === REAL_PI_MODEL_ID
        && JSON.stringify(request.body).includes(firstPrompt))).toBe(true);
      expect(completedTurn.snapshot?.pi?.sessions.some(session => session.productSessionId === sessionId)).toBe(true);
      firstTurnProviderRequestCount = requests.length;
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
      const recoveryDeadline = Date.now() + 45_000;
      const remainingRecoveryMs = () => {
        const remaining = recoveryDeadline - Date.now();
        if (remaining <= 0) throw new Error("Timed out waiting for the recovered browser input generation after native activation.");
        return remaining;
      };
      // This fixture explicitly pairs the ordinary loopback HTTP origin. Its
      // existing browser RPC is observable; no inspector call resumes a task.
      // A durable reply can render before this cold native activation finishes
      // and advances the generation used by the input admission fence.
      const activation = page.waitForResponse(response => {
        const url = new URL(response.url()), bytes = response.request().postDataBuffer();
        if (url.origin !== fixture!.baseUrl || url.pathname !== "/joko.v1.SessionService/ListRuntimeCommands"
          || response.status() !== 200 || bytes === null) return false;
        try { return fromBinary(ListRuntimeCommandsRequestSchema, bytes).sessionId === sessionId; }
        catch { return false; }
      }, { timeout: remainingRecoveryMs() });
      void activation.catch(() => undefined);
      await page.reload({ waitUntil: "domcontentloaded", timeout: Math.min(20_000, remainingRecoveryMs()) });
      await page.locator(".timeline").getByText(controlledReply, { exact: true }).first().waitFor({ state: "visible", timeout: remainingRecoveryMs() });
      const activationResponse = await activation;
      inputEvidence.push({ stage: "browser-native-activation-response", elapsedMs: Math.round(performance.now() - startedAt), status: activationResponse.status() });
      await pollOwned(async () => {
        const session = (await inspector.clients.session.getSession({ sessionId }, { timeoutMs: remainingRecoveryMs() })).session;
        const pane = page!.locator(".session-pane").first();
        return session?.nativeBinding !== undefined && session.nativeBinding.runtimeGeneration > 0n
          && await pane.getAttribute("data-input-session-id", { timeout: remainingRecoveryMs() }) === sessionId
          && await pane.getAttribute("data-input-session-generation", { timeout: remainingRecoveryMs() }) === session.nativeBinding.runtimeGeneration.toString()
          && await pane.locator('[data-composer-editor="true"] [contenteditable="true"]').isEditable({ timeout: remainingRecoveryMs() })
          && Date.now() < recoveryDeadline;
      }, value => value, "the recovered browser's current input generation after native activation", remainingRecoveryMs());
      await observeInput("recovered-browser-input-ready", Math.min(5_000, remainingRecoveryMs()));
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
      await observeInput("second-turn-persisted");
      expect(inputEvidence.at(-1)?.acceptedUserMessages).toBeGreaterThanOrEqual(2);
      record("restored-task-accepted-second-input-and-rendered-reply", "06-followup-after-restart.png");
      expect(pageErrorCount).toBe(0);
      completed = true;
    } catch (error) {
      await observeInput?.("failure", 2_000).catch(() => undefined);
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
        firstTurnProviderRequestCount, providerRequestsWithSecondPrompt: requests.filter(request => JSON.stringify(request.body).includes(secondPrompt)).length,
        inputEvidence,
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
