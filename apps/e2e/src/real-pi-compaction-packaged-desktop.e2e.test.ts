import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  CompactionState,
  OperationState,
  RunState,
  SessionState,
  SessionSnapshotScopeSchema,
  SnapshotScopeSchema
} from "@joko/contracts";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import { createE2eClients } from "./connect-clients.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
import {
  REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, REAL_PI_RESPONSE_TEXT, RealPiSystemFixture,
  startLocalProvider, type CapturedProviderRequest
} from "./real-pi-fixture.js";

const packagedIt = process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE?.trim() ? it : it.skip;
const managedPackagedIt = process.platform === "win32" ? packagedIt : it.skip;

interface OwnedProcessIdentity {
  readonly pid: number;
  readonly executablePath: string;
  readonly startedAt: string;
}

describe("packaged Desktop Pi compaction", () => {
  let fixture: RealPiSystemFixture | undefined;
  let desktop: ElectronApplication | undefined;
  let profileDirectory: string | undefined;
  let releasePendingProvider: (() => void) | undefined;
  let providerServer: Server | undefined;
  let managedDesktopIdentity: OwnedProcessIdentity | undefined;

  afterEach(async () => {
    releasePendingProvider?.();
    releasePendingProvider = undefined;
    if (managedDesktopIdentity !== undefined) await terminateOwnedWindowsProcess(managedDesktopIdentity);
    else if (desktop !== undefined) await closePackagedDesktop(desktop);
    managedDesktopIdentity = undefined;
    desktop = undefined;
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
    if (providerServer !== undefined) {
      providerServer.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => providerServer!.close((error) =>
        error ? rejectClose(error) : resolveClose()));
      providerServer = undefined;
    }
    if (profileDirectory !== undefined) {
      const target = resolve(profileDirectory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("joko-pi-desktop-")) {
        throw new Error("Refusing to remove an unexpected Desktop test profile.");
      }
      await rm(target, { recursive: true, force: true });
    }
    profileDirectory = undefined;
  }, 90_000);

  const launchConnectedDesktop = async (currentFixture: RealPiSystemFixture, deviceName: string): Promise<Page> => {
    const challenge = await currentFixture.anonymous.connection.beginPairing({ deviceDisplayName: deviceName });
    if (challenge.challenge === undefined) throw new Error("Desktop pairing returned no challenge.");
    const pairingCode = currentFixture.pairingCode(challenge.challenge.challengeId);
    profileDirectory = await mkdtemp(join(tmpdir(), "joko-pi-desktop-"));
    desktop = await _electron.launch({
      executablePath: process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE!,
      env: {
        ...process.env,
        JOKO_DESKTOP_MANAGED_ORCHESTRATOR: "0",
        JOKO_DESKTOP_PACKAGED_SMOKE: "1",
        JOKO_DESKTOP_SMOKE_SCOPE: "external",
        JOKO_DESKTOP_SMOKE_USER_DATA: profileDirectory
      },
      timeout: 60_000
    });
    const userDataPath = await desktop.evaluate(({ app }) => app.getPath("userData"));
    const profileRelative = relative(profileDirectory, userDataPath);
    if (profileRelative.startsWith("..") || isAbsolute(profileRelative)) {
      throw new Error("Packaged Desktop did not use its isolated test profile.");
    }
    const page = await desktop.firstWindow({ timeout: 60_000 });
    await page.locator(".connection-screen").waitFor({ state: "visible", timeout: 30_000 });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.getByLabel("Joko node address").fill(currentFixture.baseUrl);
    await page.getByLabel("Pairing code").fill(pairingCode);
    await page.getByLabel("Device name").fill(deviceName);
    await page.locator("form.pair-form button[type=submit]").click();
    return page;
  };

  const launchManagedDesktop = async (
    providerUrl: string,
    settings: Readonly<Record<string, unknown>>
  ) => {
    profileDirectory = await mkdtemp(join(tmpdir(), "joko-pi-desktop-"));
    const piSettingsFile = join(profileDirectory, "pi-settings.json");
    await writeFile(piSettingsFile, JSON.stringify(settings));
    desktop = await _electron.launch({
      executablePath: process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE!,
      env: {
        ...process.env,
        JOKO_DESKTOP_PACKAGED_SMOKE: "1",
        JOKO_DESKTOP_SMOKE_SCOPE: "external",
        JOKO_DESKTOP_SMOKE_USER_DATA: profileDirectory,
        JOKO_PI_SETTINGS_FILE: piSettingsFile
      },
      timeout: 60_000
    });
    const managedPid = await desktop.evaluate(() => process.pid);
    managedDesktopIdentity = await readOwnedWindowsProcess(managedPid);
    if (managedDesktopIdentity === undefined || resolve(managedDesktopIdentity.executablePath).toLowerCase()
      !== resolve(process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE!).toLowerCase()) {
      throw new Error(`Managed Desktop launched an unexpected executable: ${JSON.stringify(managedDesktopIdentity)}.`);
    }
    const userDataPath = await desktop.evaluate(({ app }) => app.getPath("userData"));
    const profileRelative = relative(profileDirectory, userDataPath);
    if (profileRelative.startsWith("..") || isAbsolute(profileRelative)) {
      throw new Error("Managed Desktop did not use its isolated test profile.");
    }
    const page = await desktop.firstWindow({ timeout: 60_000 });
    const managedConnect = page.locator("button[data-managed-local-connect]");
    await managedConnect.waitFor({ state: "visible", timeout: 60_000 });
    await managedConnect.click();
    await page.locator(".app").waitFor({ state: "visible", timeout: 30_000 });
    const managed = await page.evaluate(() => (window as Window & {
      jokoDesktop?: { managedOrchestrator?: { getStatus: () => Promise<{ state: string }> } }
    }).jokoDesktop?.managedOrchestrator?.getStatus());
    expect(managed?.state).toBe("ready");

    await page.evaluate(() => { window.location.hash = "/settings/providers"; });
    const addProvider = page.getByRole("button", { name: "Add provider", exact: true });
    await addProvider.waitFor({ state: "visible", timeout: 30_000 });
    await addProvider.click();
    await page.locator(".provider-add-wizard__custom").click();
    const editor = page.locator(".provider-editor-modal");
    await editor.getByLabel("Display name").first().fill("Managed Pi compaction route");
    await editor.getByRole("button", { name: "Remove runtime configuration" }).click();
    await editor.getByRole("tab", { name: /Pi/u }).first().click();
    await editor.getByRole("button", { name: /Configure.*Pi/u }).click();
    await editor.getByLabel("Protocol").click();
    await page.getByRole("option", { name: "OpenAI Completions", exact: true }).click();
    await editor.getByLabel("Base URL").fill(providerUrl);
    await editor.getByRole("button", { name: "No authentication" }).click();
    await editor.getByLabel("Model ID").fill(REAL_PI_MODEL_ID);
    await editor.getByLabel("Display name").last().fill("Managed Pi compaction model");
    await editor.getByLabel("Context window").fill("16384");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor.waitFor({ state: "hidden", timeout: 30_000 });
    const connection = await page.evaluate(async () => {
      const bridge = (window as Window & { jokoDesktop?: {
        managedOrchestrator?: { getConnection: () => Promise<{
          profileId: string; origin: string; serverId: string; deviceId: string
        } | undefined> };
        credentials?: { get: (profileId: string) => Promise<string | undefined> };
      } }).jokoDesktop;
      const current = await bridge?.managedOrchestrator?.getConnection();
      const authKey = current === undefined ? undefined : await bridge?.credentials?.get(current.profileId);
      return current === undefined || authKey === undefined ? undefined : { ...current, authKey };
    });
    if (connection === undefined) throw new Error("Managed Desktop did not expose its current test connection.");
    return { page, connection, clients: createE2eClients(connection.origin, connection.authKey), piSettingsFile };
  };

  packagedIt("shows real manual outcomes, focus, route isolation and restart in the current Desktop artifact", { timeout: 180_000 }, async () => {
    let releaseSummary: (() => void) | undefined;
    let holdNextSummary = false;
    let failSummary = false;
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
    releasePendingProvider = releaseSummary;
    fixture = await RealPiSystemFixture.start({
      keepRoot: true,
      piSettings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
      providerResponder: async ({ requestNumber }) => {
        if (holdNextSummary) {
          holdNextSummary = false;
          await summaryGate;
        }
        if (failSummary) throw new Error("Controlled packaged Desktop compaction Provider failure.");
        return { kind: "text", text: `Packaged Desktop Pi reply ${requestNumber}` };
      }
    });
    const rootDirectory = fixture.rootDirectory;
    const port = Number(new URL(fixture.baseUrl).port);
    const internalPort = fixture.application.config.internalPort;
    const manager = await fixture.pair("Packaged Desktop Pi manager");
    const createSession = async (name: string) => sessionIdFrom(await submit(
      manager.clients.operation, manager.connectionId,
      createSessionMutation({
        backendId: "pi", targetId: "workspace-real-pi", displayName: name,
        providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, effortId: "off"
      })
    ));
    const compactSessionId = await createSession("Packaged compact outcomes");
    const otherSessionId = await createSession("Packaged route owner");
    const failingSessionId = await createSession("Packaged compact failure");
    const send = async (sessionId: string, text: string) => {
      const generation = BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation);
      const queued = await submit(manager.clients.operation, manager.connectionId,
        sendInputMutation(sessionId, generation, text));
      const runId = queueRunIdFrom(queued);
      await waitFor(() => manager.clients.run.getRun({ runId }),
        (response) => response.run?.state === RunState.SUCCEEDED, `packaged Pi turn: ${text}`, 30_000);
    };
    const timelineStates = async (sessionId: string) => {
      const response = await manager.clients.event.getSnapshot({ scope: create(SnapshotScopeSchema, {
        kind: { case: "session", value: create(SessionSnapshotScopeSchema, { sessionId, recentTimelineItems: 500 }) }
      }) });
      return (response.snapshot?.timeline ?? []).flatMap((item) => item.payload?.kind.case === "compactionChanged"
        ? [item.payload.kind.value.state] : []);
    };
    await send(compactSessionId, "One turn for Desktop manual compaction.");

    const page = await launchConnectedDesktop(fixture, "Packaged Pi Desktop");
    const errors = observePageErrors(page);
    const route = async (sessionId: string) => {
      await page.evaluate((id) => { window.location.hash = `/tasks/${encodeURIComponent(id)}`; }, sessionId);
      await page.locator(`.session-pane [data-timeline-session-id='${sessionId}']`)
        .waitFor({ state: "visible", timeout: 30_000 });
    };
    await route(compactSessionId);
    errors.splice(0);
    const trigger = page.getByRole("button", { name: "Click to compact context" });
    await trigger.click();
    const confirmation = page.getByRole("dialog", { name: "Compact context?" });
    const cancel = confirmation.getByRole("button", { name: "Cancel" });
    expect(await cancel.evaluate((element) => element === document.activeElement)).toBe(true);
    await cancel.press("Escape");
    await confirmation.waitFor({ state: "hidden" });
    await waitFor(() => trigger.evaluate((element) => element === document.activeElement),
      (focused) => focused, "Desktop compact focus restoration");
    expect(await timelineStates(compactSessionId)).toEqual([]);

    const confirmCompact = async () => {
      await trigger.click();
      await confirmation.getByRole("button", { name: "Compact", exact: true }).click();
    };
    await confirmCompact();
    const feedback = page.locator(".compact-action-feedback");
    await page.locator(".compact-action-feedback--compacted").waitFor({ state: "visible", timeout: 30_000 });
    expect(await feedback.getAttribute("role")).toBe("status");
    expect(await feedback.getAttribute("aria-live")).toBe("polite");
    expect(await timelineStates(compactSessionId)).toContain(CompactionState.COMPLETED);
    await feedback.getByRole("button", { name: "Dismiss" }).click();
    await confirmCompact();
    await page.locator(".compact-action-feedback--noop").waitFor({ state: "visible", timeout: 30_000 });
    expect(await timelineStates(compactSessionId)).toContain(CompactionState.NO_OP);
    await feedback.getByRole("button", { name: "Dismiss" }).click();

    await send(compactSessionId, "A new Desktop turn is available to summarize.");
    const requestsBeforeSummary = fixture.providerRequests.length;
    holdNextSummary = true;
    await confirmCompact();
    await waitFor(() => Promise.resolve(fixture!.providerRequests.length), (count) => count > requestsBeforeSummary,
      "packaged Pi summary request", 30_000);
    await route(otherSessionId);
    releaseSummary?.();
    releasePendingProvider = undefined;
    await waitFor(() => timelineStates(compactSessionId),
      (states) => states.includes(CompactionState.COMPLETED), "Desktop completed compaction", 30_000);
    expect(await page.locator(".compact-action-feedback").count()).toBe(0);
    await route(compactSessionId);
    await page.getByText("Context compacted", { exact: true }).first().waitFor({ state: "visible", timeout: 30_000 });

    await send(failingSessionId, "First Desktop turn for a genuine Provider failure.");
    await send(failingSessionId, "Second Desktop turn for a genuine Provider failure.");
    await route(failingSessionId);
    failSummary = true;
    await confirmCompact();
    const failure = page.locator(".compact-action-feedback--failure");
    await failure.waitFor({ state: "visible", timeout: 30_000 });
    failSummary = false;
    expect(await failure.getAttribute("role")).toBe("alert");
    expect(await failure.getAttribute("aria-live")).toBe("assertive");
    const failureStates = await timelineStates(failingSessionId);
    expect(failureStates).toContain(CompactionState.FAILED);
    expect(failureStates).not.toContain(CompactionState.NO_OP);
    expect(errors.filter((error) => error.startsWith("pageerror:"))).toEqual([]);
    errors.splice(0); // The controlled Provider refusal intentionally surfaces as HTTP 503.

    const authKey = manager.authKey;
    await fixture.close({ removeRoot: false });
    fixture = undefined;
    fixture = await RealPiSystemFixture.start({
      rootDirectory, port, internalPort,
      piSettings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } }
    });
    const reconnected = fixture.clients(authKey);
    const restarted = await reconnected.event.getSnapshot({ scope: create(SnapshotScopeSchema, {
      kind: { case: "session", value: create(SessionSnapshotScopeSchema, {
        sessionId: compactSessionId, recentTimelineItems: 500
      }) }
    }) });
    expect(restarted.snapshot?.timeline.some((item) => item.payload?.kind.case === "compactionChanged"
      && item.payload.kind.value.state === CompactionState.COMPLETED)).toBe(true);
    await route(compactSessionId);
    await send(compactSessionId, "The same Pi context continues after Desktop service restart.");
    expect(errors.filter((error) => error.startsWith("pageerror:"))).toEqual([]);
  });

  packagedIt.each([
    {
      reason: "threshold" as const,
      settings: { compaction: { enabled: true, thresholdPercent: 50, keepRecentTokens: 1 } },
      usage: { promptTokens: 10_000, completionTokens: 3 },
      overflowRequests: [] as number[],
      expectedStatus: "Auto-compacting..."
    },
    {
      reason: "overflow" as const,
      settings: { compaction: { enabled: true, thresholdPercent: 95, keepRecentTokens: 1 } },
      usage: { promptTokens: 7, completionTokens: 3 },
      overflowRequests: [2],
      expectedStatus: "Context overflow detected, auto-compacting..."
    }
  ])("shows the installed Pi $reason state in the current Desktop artifact", async ({
    reason, settings, usage, overflowRequests, expectedStatus
  }) => {
    let releaseSummary: (() => void) | undefined;
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
    releasePendingProvider = releaseSummary;
    fixture = await RealPiSystemFixture.start({
      piSettings: settings,
      providerUsage: usage,
      overflowRequestNumbers: overflowRequests,
      providerResponder: async ({ request, requestNumber }) => {
        if (JSON.stringify(request.body).includes("You are a context summarization assistant")) await summaryGate;
        return { kind: "text", text: `Packaged automatic Pi reply ${requestNumber}` };
      }
    });
    const manager = await fixture.pair(`Packaged Pi ${reason} manager`);
    const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
      createSessionMutation({
        backendId: "pi", targetId: "workspace-real-pi", displayName: `Packaged Pi ${reason}`,
        providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, effortId: "off"
      })));
    const page = await launchConnectedDesktop(fixture, `Packaged Pi ${reason} Desktop`);
    const errors = observePageErrors(page);
    await page.evaluate((id) => { window.location.hash = `/tasks/${encodeURIComponent(id)}`; }, sessionId);
    await page.locator(`.session-pane [data-timeline-session-id='${sessionId}']`)
      .waitFor({ state: "visible", timeout: 30_000 });
    errors.splice(0);

    const send = async (text: string) => {
      const generation = BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation);
      const queued = await submit(manager.clients.operation, manager.connectionId,
        sendInputMutation(sessionId, generation, text));
      return queueRunIdFrom(queued);
    };
    if (reason === "overflow") {
      const firstRunId = await send("Establish context before packaged overflow.");
      await waitFor(() => manager.clients.run.getRun({ runId: firstRunId }),
        (response) => response.run?.state === RunState.SUCCEEDED, "pre-overflow packaged Pi turn", 30_000);
    }
    const runId = await send(`Trigger packaged Pi ${reason} compaction.`);
    await waitFor(() => Promise.resolve(fixture!.providerRequests.some((request) =>
      JSON.stringify(request.body).includes("You are a context summarization assistant"))),
    (seen) => seen, `${reason} packaged summary request`, 30_000);
    const status = page.locator(".compaction-status-indicator");
    await status.waitFor({ state: "visible", timeout: 30_000 });
    expect(await status.getAttribute("role")).toBe("status");
    expect(await status.getAttribute("aria-live")).toBe("polite");
    expect(await status.innerText()).toContain(expectedStatus);
    releaseSummary?.();
    releasePendingProvider = undefined;
    await waitFor(() => manager.clients.run.getRun({ runId }),
      (response) => response.run?.state === RunState.SUCCEEDED, `${reason} packaged Pi turn`, 30_000);
    await page.getByText("Context compacted", { exact: true }).first().waitFor({ state: "visible", timeout: 30_000 });
    await status.waitFor({ state: "hidden", timeout: 30_000 });
    expect(errors.filter((error) => error.startsWith("pageerror:"))).toEqual([]);
  }, 150_000);

  managedPackagedIt("connects the current Desktop artifact to its own managed Pi service", { timeout: 240_000 }, async () => {
    const requests: CapturedProviderRequest[] = [];
    let failSummary = false;
    let holdNextSummary = false;
    let releaseSummary: (() => void) | undefined;
    const summaryGate = new Promise<void>((resolveSummary) => { releaseSummary = resolveSummary; });
    releasePendingProvider = releaseSummary;
    providerServer = await startLocalProvider(requests, undefined, undefined, [], async ({ request }) => {
      if (JSON.stringify(request.body).includes("You are a context summarization assistant")) {
        if (holdNextSummary) {
          holdNextSummary = false;
          await summaryGate;
        }
        if (failSummary) throw new Error("Controlled managed Desktop compaction Provider failure.");
      }
      return { kind: "text", text: REAL_PI_RESPONSE_TEXT };
    });
    const providerAddress = providerServer.address() as AddressInfo;
    const providerUrl = `http://127.0.0.1:${providerAddress.port}/v1`;
    const { page, connection: managedConnection, clients: managedClients, piSettingsFile } =
      await launchManagedDesktop(providerUrl, { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } });
    expect(requests).toHaveLength(0);

    await page.evaluate(() => { window.location.hash = "/tasks/new?dialogue=pi"; });
    const newTask = page.locator(".new-task-page");
    await newTask.waitFor({ state: "visible", timeout: 30_000 });
    await newTask.locator(".new-task-composer__select--model", { hasText: "Managed Pi compaction model" })
      .waitFor({ state: "visible", timeout: 30_000 });
    await newTask.locator("[data-composer-editor='true'] .composer-rich-editor__content")
      .fill("A managed Desktop Pi turn before compaction.");
    await newTask.getByRole("button", { name: "Send", exact: true }).click();
    try {
      await page.getByText(REAL_PI_RESPONSE_TEXT, { exact: true }).first()
        .waitFor({ state: "visible", timeout: 30_000 });
    } catch (error) {
      const owner = (await managedClients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).snapshot;
      throw new Error(`Managed Pi first turn did not finish: ${JSON.stringify({
        requests: requests.length,
        route: await page.evaluate(() => window.location.hash),
        taskText: (await page.locator(".session-pane").innerText().catch(() => ""))?.slice(0, 2_000),
        alerts: await page.getByRole("alert").allInnerTexts(),
        targets: owner?.targets.map((target) => ({ id: target.targetId, backend: target.backendId })),
        sessions: owner?.sessions.map((session) => session.sessionId)
      })}`, { cause: error });
    }
    expect(requests.length).toBeGreaterThan(0);

    const sessionId = await page.locator(".session-pane [data-timeline-session-id]")
      .getAttribute("data-timeline-session-id");
    if (sessionId === null) throw new Error("Managed Desktop created no visible task identity.");
    const sessionScope = create(SnapshotScopeSchema, {
      kind: { case: "session", value: create(SessionSnapshotScopeSchema, {
        sessionId, recentTimelineItems: 500
      }) }
    });
    const timelineStates = async (targetSessionId = sessionId) => {
      const scope = targetSessionId === sessionId ? sessionScope : create(SnapshotScopeSchema, {
        kind: { case: "session", value: create(SessionSnapshotScopeSchema, {
          sessionId: targetSessionId, recentTimelineItems: 500
        }) }
      });
      const snapshot = await managedClients.event.getSnapshot({ scope });
      return (snapshot.snapshot?.timeline ?? []).flatMap((item) => item.payload?.kind.case === "compactionChanged"
        ? [item.payload.kind.value.state] : []);
    };
    const trigger = page.getByRole("button", { name: "Click to compact context" });
    await trigger.click();
    const confirmation = page.getByRole("dialog", { name: "Compact context?" });
    const cancel = confirmation.getByRole("button", { name: "Cancel" });
    expect(await cancel.evaluate((element) => element === document.activeElement)).toBe(true);
    await cancel.press("Escape");
    await confirmation.waitFor({ state: "hidden" });
    await waitFor(() => trigger.evaluate((element) => element === document.activeElement),
      (focused) => focused, "managed Desktop compact focus restoration");
    expect(await timelineStates()).toEqual([]);
    const confirmCompact = async () => {
      await trigger.click();
      await confirmation.getByRole("button", { name: "Compact", exact: true }).click();
    };
    await confirmCompact();
    const compacted = page.locator(".compact-action-feedback--compacted");
    await compacted.waitFor({ state: "visible", timeout: 30_000 });
    expect(await compacted.getAttribute("role")).toBe("status");
    expect(await compacted.getAttribute("aria-live")).toBe("polite");
    expect(await timelineStates()).toContain(CompactionState.COMPLETED);
    await compacted.getByRole("button", { name: "Dismiss" }).click();
    await confirmCompact();
    const noop = page.locator(".compact-action-feedback--noop");
    await noop.waitFor({ state: "visible", timeout: 30_000 });
    expect(await timelineStates()).toContain(CompactionState.NO_OP);
    await noop.getByRole("button", { name: "Dismiss" }).click();
    const manualOperations = await managedClients.operation.listOperations({ sessionId });
    expect(manualOperations.operations.filter((operation) =>
      operation.mutation?.payload.case === "compactSession"
      && operation.state === OperationState.SUCCEEDED)).toHaveLength(2);

    const requestCountBeforeSecondTurn = requests.length;
    await page.locator(".session-pane [data-composer-editor='true'] .composer-rich-editor__content")
      .fill("A second managed Desktop Pi turn before route switching.");
    await page.locator(".session-pane .send-button").click();
    await waitFor(() => Promise.resolve(requests.length), (count) => count > requestCountBeforeSecondTurn,
      "second managed Desktop Pi provider request", 30_000);
    await waitFor(() => page.getByText(REAL_PI_RESPONSE_TEXT, { exact: true }).count(),
      (count) => count >= 2, "second managed Desktop Pi reply", 30_000);
    await waitFor(() => managedClients.session.getSession({ sessionId }),
      (response) => response.session?.state === SessionState.IDLE,
      "second managed Desktop Pi turn idle", 30_000);

    await page.evaluate(() => { window.location.hash = "/tasks/new?dialogue=pi"; });
    await newTask.waitFor({ state: "visible", timeout: 30_000 });
    await newTask.locator(".new-task-composer__select--model", { hasText: "Managed Pi compaction model" })
      .waitFor({ state: "visible", timeout: 30_000 });
    const requestsBeforeOtherTask = requests.length;
    await newTask.locator("[data-composer-editor='true'] .composer-rich-editor__content")
      .fill("An independent managed Desktop Pi task.");
    await newTask.getByRole("button", { name: "Send", exact: true }).click();
    await waitFor(() => Promise.resolve(requests.length), (count) => count > requestsBeforeOtherTask,
      "other managed Desktop Pi provider request", 30_000);
    await page.getByText(REAL_PI_RESPONSE_TEXT, { exact: true }).first()
      .waitFor({ state: "visible", timeout: 30_000 });
    const otherSessionId = await page.locator(".session-pane [data-timeline-session-id]")
      .getAttribute("data-timeline-session-id");
    if (otherSessionId === null || otherSessionId === sessionId) {
      throw new Error("Managed Desktop did not create an independent task.");
    }
    await page.evaluate((id) => { window.location.hash = `/tasks/${encodeURIComponent(id)}`; }, sessionId);
    await page.locator(`.session-pane [data-timeline-session-id='${sessionId}']`)
      .waitFor({ state: "visible", timeout: 30_000 });
    const statesBeforeRouteSwitch = await timelineStates();
    const requestsBeforeHeldSummary = requests.length;
    holdNextSummary = true;
    await confirmCompact();
    await waitFor(() => Promise.resolve(requests.slice(requestsBeforeHeldSummary).some((request) =>
      JSON.stringify(request.body).includes("You are a context summarization assistant"))),
    (seen) => seen, "managed Desktop held summary request", 30_000);
    await page.evaluate((id) => { window.location.hash = `/tasks/${encodeURIComponent(id)}`; }, otherSessionId);
    await page.locator(`.session-pane [data-timeline-session-id='${otherSessionId}']`)
      .waitFor({ state: "visible", timeout: 30_000 });
    releaseSummary?.();
    releasePendingProvider = undefined;
    await waitFor(timelineStates, (states) => states.length > statesBeforeRouteSwitch.length
      && states.includes(CompactionState.COMPLETED), "managed Desktop compacted after route switch", 30_000);
    expect(await page.locator(".compact-action-feedback").count()).toBe(0);
    await page.evaluate((id) => { window.location.hash = `/tasks/${encodeURIComponent(id)}`; }, sessionId);
    await page.getByText("Context compacted", { exact: true }).first()
      .waitFor({ state: "visible", timeout: 30_000 });
    await waitFor(() => managedClients.session.getSession({ sessionId }),
      (response) => response.session?.state === SessionState.IDLE,
      "managed Desktop Pi task idle before complete exit", 30_000);

    if (managedDesktopIdentity === undefined) throw new Error("Managed Desktop lost its process identity before restart.");
    if (profileDirectory === undefined) throw new Error("Managed Desktop lost its isolated profile before restart.");
    await terminateOwnedWindowsProcess(managedDesktopIdentity);
    managedDesktopIdentity = undefined;
    desktop = undefined;
    desktop = await _electron.launch({
      executablePath: process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE!,
      env: {
        ...process.env,
        JOKO_DESKTOP_PACKAGED_SMOKE: "1",
        JOKO_DESKTOP_SMOKE_SCOPE: "external",
        JOKO_DESKTOP_SMOKE_USER_DATA: profileDirectory,
        JOKO_PI_SETTINGS_FILE: piSettingsFile
      },
      timeout: 60_000
    });
    const restartedPid = await desktop.evaluate(() => process.pid);
    managedDesktopIdentity = await readOwnedWindowsProcess(restartedPid);
    if (managedDesktopIdentity === undefined || resolve(managedDesktopIdentity.executablePath).toLowerCase()
      !== resolve(process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE!).toLowerCase()) {
      throw new Error("Managed Desktop restart launched an unexpected executable.");
    }
    const resumedPage = await desktop.firstWindow({ timeout: 60_000 });
    await resumedPage.locator(".app, button[data-managed-local-connect]").first()
      .waitFor({ state: "visible", timeout: 60_000 });
    const resumedConnect = resumedPage.locator("button[data-managed-local-connect]");
    if (await resumedConnect.isVisible()) await resumedConnect.click();
    await resumedPage.locator(".app").waitFor({ state: "visible", timeout: 30_000 });
    const resumedConnection = await resumedPage.evaluate(async () => {
      const bridge = (window as Window & { jokoDesktop?: {
        managedOrchestrator?: { getConnection: () => Promise<{
          profileId: string; origin: string; serverId: string; deviceId: string
        } | undefined> };
        credentials?: { get: (profileId: string) => Promise<string | undefined> };
      } }).jokoDesktop;
      const connection = await bridge?.managedOrchestrator?.getConnection();
      const authKey = connection === undefined ? undefined : await bridge?.credentials?.get(connection.profileId);
      return connection === undefined || authKey === undefined ? undefined : { ...connection, authKey };
    });
    if (resumedConnection === undefined || resumedConnection.serverId !== managedConnection.serverId
      || resumedConnection.deviceId !== managedConnection.deviceId) {
      const status = await resumedPage.evaluate(() => (window as Window & { jokoDesktop?: {
        managedOrchestrator?: { getStatus: () => Promise<{ state: string }> }
      } }).jokoDesktop?.managedOrchestrator?.getStatus());
      throw new Error(`Managed Desktop did not recover its original service connection: ${JSON.stringify({
        originalServiceId: managedConnection.serverId,
        resumedServiceId: resumedConnection?.serverId,
        status: status?.state
      })}`);
    }
    const resumedClients = createE2eClients(resumedConnection.origin, resumedConnection.authKey);
    const resumedSnapshot = await resumedClients.event.getSnapshot({ scope: sessionScope });
    expect(resumedSnapshot.snapshot?.timeline.some((item) => item.payload?.kind.case === "compactionChanged"
      && item.payload.kind.value.state === CompactionState.COMPLETED)).toBe(true);
    await resumedPage.evaluate((id) => { window.location.hash = `/tasks/${encodeURIComponent(id)}`; }, sessionId);
    await resumedPage.locator(`.session-pane [data-timeline-session-id='${sessionId}']`)
      .waitFor({ state: "visible", timeout: 30_000 });
    await resumedPage.getByText("Context compacted", { exact: true }).first()
      .waitFor({ state: "visible", timeout: 30_000 });
    const generationBeforeResume = (await resumedClients.session.getSession({ sessionId }))
      .session?.nativeBinding?.runtimeGeneration;
    const uiGeneration = async () => resumedPage.locator(`.session-pane[data-input-session-id='${sessionId}']`)
      .getAttribute("data-input-session-generation");
    if (generationBeforeResume !== undefined) {
      await waitFor(uiGeneration, (value) => value === generationBeforeResume.toString(),
        "managed Desktop resumed UI generation", 30_000);
    }
    const requestsBeforeResume = requests.length;
    await resumedPage.locator(".session-pane [data-composer-editor='true'] .composer-rich-editor__content")
      .fill("The managed Desktop Pi task continues after process restart.");
    await resumedPage.locator(".session-pane .send-button").click();
    try {
      await waitFor(() => Promise.resolve(requests.length), (count) => count > requestsBeforeResume,
        "managed Desktop Pi native continuation after restart", 30_000);
    } catch (error) {
      const session = await resumedClients.session.getSession({ sessionId });
      const operations = await resumedClients.operation.listOperations({ sessionId });
      const settings = await resumedClients.settings.getSettings({});
      throw new Error(`Managed Desktop Pi did not reach Provider after restart: ${JSON.stringify({
        state: session.session?.state,
        route: await resumedPage.evaluate(() => window.location.hash),
        alerts: await resumedPage.getByRole("alert").allInnerTexts(),
        operations: operations.operations.map((operation) => ({
          state: operation.state, kind: operation.mutation?.payload.case,
          error: operation.error?.message, code: operation.error?.code
        })),
        providerPresent: settings.settings?.providers.some((provider) => provider.providerId === "managed-pi-compaction-route"),
        generationBeforeResume: generationBeforeResume?.toString(),
        uiGenerationAfterResume: await uiGeneration().catch(() => undefined),
        generationAfterResume: session.session?.nativeBinding?.runtimeGeneration.toString(),
        failedExpectedGenerations: operations.operations.filter((operation) => operation.state === 5)
          .map((operation) => operation.mutation?.preconditions.map((precondition) =>
            precondition.expectedGeneration.toString())),
        requests: requests.length
      })}`, { cause: error });
    }
    const resumedRequest = JSON.stringify(requests.at(-1)?.body);
    expect(resumedRequest).toContain("The managed Desktop Pi task continues after process restart.");
    expect(resumedRequest).toContain(REAL_PI_RESPONSE_TEXT);
    await waitFor(() => resumedClients.session.getSession({ sessionId }),
      (response) => response.session?.state === SessionState.IDLE,
      "resumed managed Desktop Pi turn idle", 30_000);
    await resumedPage.getByText(REAL_PI_RESPONSE_TEXT, { exact: true }).first()
      .waitFor({ state: "visible", timeout: 30_000 });

    failSummary = true;
    const resumedTrigger = resumedPage.getByRole("button", { name: "Click to compact context" });
    await resumedTrigger.click();
    await resumedPage.getByRole("dialog", { name: "Compact context?" })
      .getByRole("button", { name: "Compact", exact: true }).click();
    const failure = resumedPage.locator(".compact-action-feedback--failure");
    await failure.waitFor({ state: "visible", timeout: 30_000 });
    failSummary = false;
    expect(await failure.getAttribute("role")).toBe("alert");
    expect(await failure.getAttribute("aria-live")).toBe("assertive");
    const failedSnapshot = await resumedClients.event.getSnapshot({ scope: sessionScope });
    const failedStates = (failedSnapshot.snapshot?.timeline ?? []).flatMap((item) =>
      item.payload?.kind.case === "compactionChanged" ? [item.payload.kind.value.state] : []);
    expect(failedStates).toContain(CompactionState.FAILED);
  });

  managedPackagedIt("normally exits its managed Pi service after tasks and compaction", { timeout: 150_000 }, async () => {
    const requests: CapturedProviderRequest[] = [];
    providerServer = await startLocalProvider(requests);
    const address = providerServer.address() as AddressInfo;
    const { page, clients, connection } = await launchManagedDesktop(`http://127.0.0.1:${address.port}/v1`, {
      compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 }
    });
    await page.evaluate(() => { window.location.hash = "/tasks/new?dialogue=pi"; });
    const newTask = page.locator(".new-task-page");
    await newTask.waitFor({ state: "visible", timeout: 30_000 });
    await newTask.locator(".new-task-composer__select--model", { hasText: "Managed Pi compaction model" })
      .waitFor({ state: "visible", timeout: 30_000 });
    await newTask.locator("[data-composer-editor='true'] .composer-rich-editor__content")
      .fill("A managed Desktop Pi turn before normal exit.");
    await newTask.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText(REAL_PI_RESPONSE_TEXT, { exact: true }).first()
      .waitFor({ state: "visible", timeout: 30_000 });
    const sessionId = await page.locator(".session-pane [data-timeline-session-id]")
      .getAttribute("data-timeline-session-id");
    if (sessionId === null) throw new Error("Managed Pi normal exit created no task.");
    const trigger = page.getByRole("button", { name: "Click to compact context" });
    await trigger.click();
    await page.getByRole("dialog", { name: "Compact context?" })
      .getByRole("button", { name: "Compact", exact: true }).click();
    await page.locator(".compact-action-feedback--compacted")
      .waitFor({ state: "visible", timeout: 30_000 });
    await waitFor(() => clients.session.getSession({ sessionId }),
      (response) => response.session?.state === SessionState.IDLE,
      "managed Pi task idle before normal exit", 30_000);
    if (managedDesktopIdentity === undefined) throw new Error("Managed Desktop lost its process identity.");
    if (profileDirectory === undefined) throw new Error("Managed Desktop lost its isolated profile.");
    const owned = managedDesktopIdentity;
    const profile = profileDirectory;
    await desktop?.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); return true; });
    await waitFor(() => readOwnedWindowsProcess(owned.pid), (candidate) => candidate === undefined,
      "managed Desktop normal complete exit", 30_000);
    await waitFor(() => readOwnedWindowsChildPids(owned.pid), (pids) => pids.length === 0,
      "managed Desktop owned child exit", 10_000);
    expect(await fetch(`${connection.origin}/joko.v1.ConnectionService/GetServerInfo`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      signal: AbortSignal.timeout(3_000)
    }).then((response) => response.ok, () => false)).toBe(false);
    managedDesktopIdentity = undefined;
    desktop = undefined;

    desktop = await _electron.launch({
      executablePath: process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE!,
      env: {
        ...process.env,
        JOKO_DESKTOP_PACKAGED_SMOKE: "1",
        JOKO_DESKTOP_SMOKE_SCOPE: "external",
        JOKO_DESKTOP_SMOKE_USER_DATA: profile,
        JOKO_PI_SETTINGS_FILE: join(profile, "pi-settings.json")
      }, timeout: 60_000
    });
    managedDesktopIdentity = await readOwnedWindowsProcess(await desktop.evaluate(() => process.pid));
    if (managedDesktopIdentity === undefined || resolve(managedDesktopIdentity.executablePath).toLowerCase()
      !== resolve(process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE!).toLowerCase()) {
      throw new Error("Managed Desktop restart launched an unexpected executable.");
    }
    const resumedPage = await desktop.firstWindow({ timeout: 60_000 });
    const resumedConnect = resumedPage.locator("button[data-managed-local-connect]");
    await resumedPage.locator(".app, button[data-managed-local-connect]").first()
      .waitFor({ state: "visible", timeout: 60_000 });
    if (await resumedConnect.isVisible()) await resumedConnect.click();
    await resumedPage.locator(".app").waitFor({ state: "visible", timeout: 30_000 });
    const resumedConnection = await resumedPage.evaluate(() => (window as Window & { jokoDesktop?: {
      managedOrchestrator?: { getConnection: () => Promise<{
        serverId: string; deviceId: string
      } | undefined> }
    } }).jokoDesktop?.managedOrchestrator?.getConnection());
    expect(resumedConnection?.serverId).toBe(connection.serverId);
    expect(resumedConnection?.deviceId).toBe(connection.deviceId);
    await resumedPage.evaluate((id) => { window.location.hash = `/tasks/${encodeURIComponent(id)}`; }, sessionId);
    await resumedPage.locator(`.session-pane [data-timeline-session-id='${sessionId}']`)
      .waitFor({ state: "visible", timeout: 30_000 });
    await resumedPage.getByText("Context compacted", { exact: true }).first()
      .waitFor({ state: "visible", timeout: 30_000 });
    const resumedOwned = managedDesktopIdentity;
    await desktop.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); return true; });
    await waitFor(() => readOwnedWindowsProcess(resumedOwned.pid), (candidate) => candidate === undefined,
      "restarted managed Desktop normal complete exit", 30_000);
    await waitFor(() => readOwnedWindowsChildPids(resumedOwned.pid), (pids) => pids.length === 0,
      "restarted managed Desktop owned child exit", 10_000);
    managedDesktopIdentity = undefined;
    desktop = undefined;
  });

  managedPackagedIt.each([
    {
      reason: "threshold" as const,
      settings: { compaction: { enabled: true, thresholdPercent: 50, keepRecentTokens: 1 } },
      usage: { promptTokens: 10_000, completionTokens: 3 },
      expectedStatus: "Auto-compacting..."
    },
    {
      reason: "overflow" as const,
      settings: { compaction: { enabled: true, thresholdPercent: 95, keepRecentTokens: 1 } },
      usage: { promptTokens: 7, completionTokens: 3 },
      expectedStatus: "Context overflow detected, auto-compacting..."
    }
  ])("shows the managed Pi $reason state in the current Desktop artifact", { timeout: 180_000 }, async ({
    reason, settings, usage, expectedStatus
  }) => {
    const requests: CapturedProviderRequest[] = [];
    let overflowDelivered = false;
    let releaseSummary: (() => void) | undefined;
    const summaryGate = new Promise<void>((resolveSummary) => { releaseSummary = resolveSummary; });
    releasePendingProvider = releaseSummary;
    providerServer = await startLocalProvider(requests, undefined, usage, [], async ({ request }) => {
      if (reason === "overflow" && !overflowDelivered
        && JSON.stringify(request.body).includes("Trigger managed Pi context overflow.")) {
        overflowDelivered = true;
        return { kind: "contextOverflow" };
      }
      if (JSON.stringify(request.body).includes("You are a context summarization assistant")) await summaryGate;
      return { kind: "text", text: REAL_PI_RESPONSE_TEXT };
    });
    const providerAddress = providerServer.address() as AddressInfo;
    const { page, clients } = await launchManagedDesktop(`http://127.0.0.1:${providerAddress.port}/v1`, settings);
    expect(requests).toHaveLength(0);
    const errors = observePageErrors(page);
    await page.evaluate(() => { window.location.hash = "/tasks/new?dialogue=pi"; });
    const newTask = page.locator(".new-task-page");
    await newTask.waitFor({ state: "visible", timeout: 30_000 });
    await newTask.locator(".new-task-composer__select--model", { hasText: "Managed Pi compaction model" })
      .waitFor({ state: "visible", timeout: 30_000 });
    await newTask.locator("[data-composer-editor='true'] .composer-rich-editor__content")
      .fill(`Establish context for managed Pi ${reason} compaction.`);
    await newTask.getByRole("button", { name: "Send", exact: true }).click();
    const sessionTimeline = page.locator(".session-pane [data-timeline-session-id]");
    await sessionTimeline.waitFor({ state: "visible", timeout: 30_000 });
    const sessionId = await sessionTimeline.getAttribute("data-timeline-session-id");
    if (sessionId === null) throw new Error("Managed Pi automatic compaction created no task identity.");
    const automaticDiagnostic = async () => ({
      requests: requests.map((request, index) => ({
        number: index + 1,
        summary: JSON.stringify(request.body).includes("You are a context summarization assistant")
      })),
      sessionState: (await clients.session.getSession({ sessionId })).session?.state,
      runs: (await clients.run.listRuns({ sessionId })).runs.map((run) => run.state),
      operations: (await clients.operation.listOperations({ sessionId })).operations.map((operation) => ({
        kind: operation.mutation?.payload.case,
        state: operation.state,
        code: operation.error?.code,
        message: operation.error?.message
      })),
      alerts: await page.getByRole("alert").allInnerTexts(),
      taskText: (await page.locator(".session-pane").innerText().catch(() => "")).slice(-1_200)
    });
    if (reason === "overflow") {
      try {
        await page.getByText(REAL_PI_RESPONSE_TEXT, { exact: true }).first()
          .waitFor({ state: "visible", timeout: 30_000 });
      } catch (error) {
        throw new Error(`Managed Pi overflow initial turn failed: ${JSON.stringify(await automaticDiagnostic())}`, { cause: error });
      }
      await waitFor(() => clients.session.getSession({ sessionId }),
        (response) => response.session?.state === SessionState.IDLE,
        "managed Pi pre-overflow task idle", 30_000);
      await page.locator(".session-pane [data-composer-editor='true'] .composer-rich-editor__content")
        .fill("Trigger managed Pi context overflow.");
      await page.locator(".session-pane .send-button").click();
    }
    try {
      await waitFor(() => Promise.resolve(requests.some((request) =>
        JSON.stringify(request.body).includes("You are a context summarization assistant"))),
      (seen) => seen, `managed Pi ${reason} summary request`, 30_000);
    } catch (error) {
      throw new Error(`Managed Pi ${reason} did not request a summary: ${JSON.stringify(await automaticDiagnostic())}`, { cause: error });
    }
    const status = page.locator(".compaction-status-indicator");
    await status.waitFor({ state: "visible", timeout: 30_000 });
    expect(await status.getAttribute("role")).toBe("status");
    expect(await status.getAttribute("aria-live")).toBe("polite");
    expect(await status.innerText()).toContain(expectedStatus);
    releaseSummary?.();
    releasePendingProvider = undefined;
    await waitFor(() => clients.run.listRuns({ sessionId }),
      (response) => response.runs.filter((run) => run.state === RunState.SUCCEEDED).length
        >= (reason === "overflow" ? 2 : 1),
      `managed Pi ${reason} run`, 30_000);
    await page.getByText("Context compacted", { exact: true }).first()
      .waitFor({ state: "visible", timeout: 30_000 });
    await status.waitFor({ state: "hidden", timeout: 30_000 });
    const snapshot = await clients.event.getSnapshot({ scope: create(SnapshotScopeSchema, {
      kind: { case: "session", value: create(SessionSnapshotScopeSchema, {
        sessionId, recentTimelineItems: 500
      }) }
    }) });
    const states = (snapshot.snapshot?.timeline ?? []).flatMap((item) =>
      item.payload?.kind.case === "compactionChanged" ? [item.payload.kind.value.state] : []);
    // Overflow updates one durable compaction identity in place; its STARTED
    // phase is proven by the held, reason-specific live status above.
    if (reason === "threshold") expect(states).toContain(CompactionState.STARTED);
    expect(states).toContain(CompactionState.COMPLETED);
    expect(errors.filter((error) => error.startsWith("pageerror:"))).toEqual([]);
  });
});

function observePageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });
  return errors;
}

async function closePackagedDesktop(application: ElectronApplication): Promise<void> {
  const [mainPid, executablePath] = await Promise.all([
    application.evaluate(() => process.pid),
    application.evaluate(({ app }) => app.getPath("exe"))
  ]);
  if (resolve(executablePath).toLowerCase()
    !== resolve(process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE!).toLowerCase()) {
    throw new Error("Packaged Desktop cleanup refused an unexpected executable.");
  }
  // Closing the page follows close-to-tray. Schedule a full exit on the exact
  // main process after the evaluation acknowledgement reaches the harness.
  await application.evaluate(({ app }) => {
    setTimeout(() => app.exit(0), 50);
    return true;
  });
  try {
    await waitFor(() => Promise.resolve(processIsAlive(mainPid)), (alive) => !alive,
      "Packaged Desktop application exit", 8_000);
  } catch {
    const current = await application.evaluate(({ app }) => ({
      pid: process.pid,
      executablePath: app.getPath("exe")
    })).catch(() => undefined);
    if (current?.pid !== mainPid || current.executablePath.toLowerCase() !== executablePath.toLowerCase()) {
      throw new Error("Packaged Desktop cleanup could not confirm its original process identity.");
    }
    if (process.platform === "win32") {
      await new Promise<void>((resolveKill, rejectKill) => {
        execFile("taskkill.exe", ["/PID", String(mainPid), "/T", "/F"],
          { windowsHide: true, timeout: 10_000 }, (error) => error ? rejectKill(error) : resolveKill());
      });
    } else {
      process.kill(mainPid, "SIGKILL");
    }
    await waitFor(() => Promise.resolve(processIsAlive(mainPid)), (alive) => !alive,
      "Packaged Desktop forced exit", 8_000);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function readOwnedWindowsProcess(pid: number): Promise<OwnedProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid Desktop process PID.");
  const script = `$candidate = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $candidate) { [pscustomobject]@{ pid = $candidate.ProcessId; executablePath = $candidate.ExecutablePath; startedAt = $candidate.CreationDate.ToUniversalTime().ToString('O') } | ConvertTo-Json -Compress }`;
  const output = await new Promise<string>((resolveOutput, rejectOutput) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000 }, (error, stdout) => error ? rejectOutput(error) : resolveOutput(stdout));
  });
  return output.trim() ? JSON.parse(output) as OwnedProcessIdentity : undefined;
}

async function readOwnedWindowsChildPids(parentPid: number): Promise<readonly number[]> {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error("Invalid Desktop parent PID.");
  const script = `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${parentPid}' | ForEach-Object { $_.ProcessId }`;
  const output = await new Promise<string>((resolveOutput, rejectOutput) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000 }, (error, stdout) => error ? rejectOutput(error) : resolveOutput(stdout));
  });
  return output.trim() === "" ? [] : output.trim().split(/\r?\n/u).map((value) => Number(value.trim()));
}

async function terminateOwnedWindowsProcess(identity: OwnedProcessIdentity): Promise<void> {
  const current = await readOwnedWindowsProcess(identity.pid);
  if (current === undefined) return;
  if (current.executablePath.toLowerCase() !== identity.executablePath.toLowerCase()
    || current.startedAt !== identity.startedAt) {
    throw new Error("Managed Desktop cleanup refused a changed process identity.");
  }
  await new Promise<void>((resolveKill, rejectKill) => {
    execFile("taskkill.exe", ["/PID", String(identity.pid), "/T", "/F"],
      { windowsHide: true, timeout: 10_000 }, (error) => error ? rejectKill(error) : resolveKill());
  });
  await waitFor(() => readOwnedWindowsProcess(identity.pid), (candidate) => candidate === undefined,
    "Managed Desktop process-tree exit", 8_000);
}
