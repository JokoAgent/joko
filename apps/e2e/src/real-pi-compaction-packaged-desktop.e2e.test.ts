import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
  CompactionState,
  GetSnapshotRequestSchema,
  GetSessionStatisticsRequestSchema,
  ListRuntimeCommandsRequestSchema,
  ListSessionResourcesRequestSchema,
  ListSessionTimelineRequestSchema,
  MessageRole,
  OperationState,
  RunState,
  SessionState,
  SessionSnapshotScopeSchema,
  SnapshotScopeSchema
} from "@joko/contracts";
import { _electron, type ElectronApplication, type Page, type Request } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import { createE2eClients, type E2eClients } from "./connect-clients.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
import { createPackagedDesktopStartupEvidence, readLaunchedWindowsDesktopProcess } from "./packaged-desktop-startup.js";
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
  let connectedDesktopIdentity: OwnedProcessIdentity | undefined;
  let managedDesktopIdentity: OwnedProcessIdentity | undefined;
  let lifecycleStarted: number | undefined;
  const lifecyclePhases: { phase: string; elapsedMs: number }[] = [];
  const startupEvidence = createPackagedDesktopStartupEvidence();
  const recordLifecycle = (phase: string): void => {
    if (lifecycleStarted !== undefined) lifecyclePhases.push({ phase, elapsedMs: Math.round(performance.now() - lifecycleStarted) });
  };

  afterEach(async ({ task }) => {
    if (task.result?.state === "fail") {
      console.info("Packaged Pi startup state:", JSON.stringify(await startupEvidence.snapshot(desktop)));
    }
    startupEvidence.reset();
    if (task.result?.state === "fail" && lifecycleStarted !== undefined) {
      recordLifecycle("failed");
      console.info("Managed Desktop lifecycle phases:", JSON.stringify(lifecyclePhases));
    }
    lifecycleStarted = undefined;
    lifecyclePhases.length = 0;
    releasePendingProvider?.();
    releasePendingProvider = undefined;
    if (managedDesktopIdentity !== undefined) await terminateOwnedWindowsProcess(managedDesktopIdentity);
    else if (connectedDesktopIdentity !== undefined) {
      if (task.result?.state === "fail" || desktop === undefined) await terminateOwnedWindowsProcess(connectedDesktopIdentity);
      else await closeConnectedWindowsDesktop(desktop, connectedDesktopIdentity);
    } else if (desktop !== undefined) await closePackagedDesktop(desktop);
    managedDesktopIdentity = undefined;
    connectedDesktopIdentity = undefined;
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
    const executablePath = resolve(process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE!);
    profileDirectory = await mkdtemp(join(tmpdir(), "joko-pi-desktop-"));
    desktop = await _electron.launch({
      executablePath,
      args: process.platform === "linux" && process.env.JOKO_DESKTOP_SMOKE_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
      env: {
        ...process.env,
        JOKO_DESKTOP_MANAGED_ORCHESTRATOR: "0",
        JOKO_DESKTOP_PACKAGED_SMOKE: "1",
        JOKO_DESKTOP_SMOKE_SCOPE: "external",
        ...startupEvidence.environment(profileDirectory),
        JOKO_DESKTOP_SMOKE_USER_DATA: profileDirectory
      },
      timeout: 60_000
    });
    if (process.platform === "win32") {
      const launcherPid = desktop.process().pid;
      if (launcherPid === undefined) throw new Error("Packaged Pi Desktop returned no spawned process ID.");
      connectedDesktopIdentity = await readLaunchedWindowsDesktopProcess(launcherPid, executablePath);
    }
    const page = await desktop.firstWindow({ timeout: 60_000 });
    const profile = await withDesktopDeadline(desktop.evaluate(({ app }) => ({ pid: process.pid, path: app.getPath("userData") })),
      15_000, "Packaged Pi Main did not report its process and profile.");
    if (connectedDesktopIdentity !== undefined && profile.pid !== connectedDesktopIdentity.pid) {
      throw new Error("Packaged Pi Desktop returned a different Main process.");
    }
    const profileRelative = relative(profileDirectory, profile.path);
    if (profileRelative.startsWith("..") || isAbsolute(profileRelative)) {
      throw new Error("Packaged Desktop did not use its isolated test profile.");
    }
    await withDesktopDeadline(desktop.evaluate(({ app, BrowserWindow }) => {
      type ObservedWindow = ReturnType<typeof BrowserWindow.getAllWindows>[number];
      const startedAt = Date.now(), events: unknown[] = [], observed = new Set<number>();
      const state = (window: ObservedWindow) => window.isDestroyed() ? { id: window.id, destroyed: true }
        : { id: window.id, visible: window.isVisible(), focused: window.isFocused(), minimized: window.isMinimized(), loading: window.webContents.isLoading() };
      const observe = (window: ObservedWindow): void => {
        if (observed.has(window.id)) return;
        observed.add(window.id);
        const record = (type: string): void => { if (events.length < 32) events.push({ type, elapsedMs: Date.now() - startedAt, ...state(window) }); };
        record("observed");
        window.on("ready-to-show", () => record("ready-to-show"));
        window.on("show", () => record("show"));
        window.on("hide", () => record("hide"));
        window.on("focus", () => record("focus"));
        window.on("blur", () => record("blur"));
        window.on("minimize", () => record("minimize"));
        window.on("restore", () => record("restore"));
        window.on("closed", () => record("closed"));
        window.webContents.on("did-finish-load", () => record("did-finish-load"));
        window.webContents.on("render-process-gone", () => record("render-process-gone"));
      };
      BrowserWindow.getAllWindows().forEach(observe); app.on("browser-window-created", (_event, window) => observe(window));
      (globalThis as typeof globalThis & { __jokoPairingWindowObservation?: { events: unknown[]; current: () => unknown[] } })
        .__jokoPairingWindowObservation = { events, current: () => BrowserWindow.getAllWindows().map(state) };
    }), 5_000, "Packaged Pi Main did not install the window observation.");
    await page.locator(".connection-screen").waitFor({ state: "visible", timeout: 30_000 });
    const pairingTab = page.locator(".connection-tabs > button").nth(2);
    try {
      await pairingTab.click();
      const nativeWindow = await desktop.browserWindow(page);
      try {
        expect(await nativeWindow.evaluate(window => window.isVisible())).toBe(true);
      } finally {
        await nativeWindow.dispose();
      }
    } catch (error) {
      let deadline: NodeJS.Timeout | number | undefined;
      const observation = await Promise.race([
        pairingTab.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
          return {
            visibility: document.visibilityState,
            focused: document.hasFocus(),
            bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
            disabled: element.matches(":disabled"),
            pressed: element.getAttribute("aria-pressed"),
            cardBusy: element.closest(".connection-card")?.getAttribute("aria-busy"),
            hitButton: hit !== null && element.contains(hit),
            hitTag: hit?.tagName,
            pointerEvents: getComputedStyle(element).pointerEvents
          };
        }, undefined, { timeout: 1_000 }).catch(() => undefined),
        new Promise<undefined>(resolveObservation => { deadline = setNodeTimeout(() => resolveObservation(undefined), 2_000); })
      ]).finally(() => clearNodeTimeout(deadline));
      console.info("Packaged Pi pairing control:", JSON.stringify(observation ?? null));
      const native = await withDesktopDeadline(desktop.evaluate(() => {
        const receipt = (globalThis as typeof globalThis & { __jokoPairingWindowObservation?: { events: unknown[]; current: () => unknown[] } }).__jokoPairingWindowObservation;
        return receipt ? { events: receipt.events, windows: receipt.current() } : undefined;
      }), 2_000, "Packaged Pi window observation timed out.").catch(() => undefined);
      console.info("Packaged Pi pairing window lifecycle:", JSON.stringify(native ?? null));
      throw error;
    }
    await page.locator('details.device-authorization__manual > summary').click();
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
    recordLifecycle("launch");
    desktop = await _electron.launch({
      executablePath: process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE!,
      env: {
        ...process.env,
        JOKO_DESKTOP_PACKAGED_SMOKE: "1",
        JOKO_DESKTOP_SMOKE_SCOPE: "external",
        ...startupEvidence.environment(profileDirectory),
        JOKO_DESKTOP_SMOKE_USER_DATA: profileDirectory,
        JOKO_PI_SETTINGS_FILE: piSettingsFile
      },
      timeout: 60_000
    });
    recordLifecycle("launched");
    const managedPid = await desktop.evaluate(() => process.pid);
    managedDesktopIdentity = await readOwnedWindowsProcess(managedPid);
    recordLifecycle("process-identity");
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
    recordLifecycle("local-connect-ready");
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
    recordLifecycle("provider-ready");
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
      return runId;
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
    const conflicts: string[] = [];
    page.on("response", (response) => {
      if (response.status() !== 409 || conflicts.length >= 16) return;
      const { pathname } = new URL(response.url());
      const endpoint = /^\/joko\.v1\.[A-Za-z0-9]+Service\/[A-Za-z0-9]+$/u.test(pathname) ? pathname : "other";
      conflicts.push(`${response.request().method()} ${endpoint}`);
    });
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

    const confirmCompact = async (sessionId = compactSessionId) => {
      const pane = page.locator(`.session-pane[data-input-session-id='${sessionId}']`);
      const control = pane.getByRole("button", { name: "Click to compact context" });
      const witness = await control.evaluateHandle((button) => {
        const bounds = (element: Element | null): number[] | undefined => {
          if (!element?.isConnected) return undefined;
          const { x, y, width, height } = element.getBoundingClientRect();
          return [x, y, width, height];
        };
        const events: unknown[] = [];
        let pressTarget: Element | undefined;
        const capture = (event: Event) => {
          if (events.length >= 12 || !(event instanceof MouseEvent)) return;
          const target = event.target instanceof Element ? event.target : undefined;
          if (event.type === "pointerdown") pressTarget = target;
          const owner = target?.closest<HTMLElement>(".session-pane");
          events.push({ type: event.type, target: target?.tagName, className: target?.getAttribute("class"),
            button: target?.closest("button")?.getAttribute("aria-label"), hitOriginalButton: event.composedPath().includes(button),
            point: [event.clientX, event.clientY], buttonBounds: bounds(button), statusbarBounds: bounds(button.closest(".composer-statusbar")),
            pressTargetStillMounted: pressTarget?.isConnected,
            sessionId: owner?.dataset.inputSessionId, generation: owner?.dataset.inputSessionGeneration });
        };
        const types = ["pointerdown", "pointerup", "click"];
        for (const type of types) document.addEventListener(type, capture, true);
        return { events, stop: () => { for (const type of types) document.removeEventListener(type, capture, true); } };
      });
      try {
        await control.click();
        await confirmation.getByRole("button", { name: "Compact", exact: true }).click();
      } catch (error) {
        const [pointer, view, owner] = await Promise.all([
          witness.evaluate(value => value.events).catch(() => []),
          page.evaluate(() => ({ route: window.location.hash, panes: Array.from(document.querySelectorAll<HTMLElement>(".session-pane")).map(item => ({
            sessionId: item.dataset.inputSessionId, generation: item.dataset.inputSessionGeneration,
            canCompact: item.querySelector("button.context-capacity-ring--button") !== null
          })), dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map(item => item.getAttribute("aria-label")) })).catch(() => undefined),
          manager.clients.session.getSession({ sessionId }).then(result => ({ state: result.session?.state,
            generation: result.session?.nativeBinding?.runtimeGeneration.toString() })).catch(() => undefined)
        ]);
        throw new Error(`Packaged compact confirmation did not open or accept: ${JSON.stringify({ sessionId, owner, view, pointer, conflicts, errors: errors.slice(-6) })}`, { cause: error });
      } finally {
        await witness.evaluate(value => value.stop()).catch(() => undefined);
        await witness.dispose().catch(() => undefined);
      }
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
    const lastFailingTurn = await send(failingSessionId, "Second Desktop turn for a genuine Provider failure.");
    const history = await manager.clients.session.listSessionTimeline({ sessionId: failingSessionId, limit: 40 });
    const lastReply = history.events.find((event) => event.identity?.runId === lastFailingTurn
      && event.payload?.kind.case === "messageCompleted" && event.payload.kind.value.role === MessageRole.ASSISTANT);
    if (lastReply?.payload?.kind.case !== "messageCompleted") throw new Error("The final Pi reply was not recorded.");
    await route(failingSessionId);
    await page.locator(`.session-pane .message-assistant[data-selection-quote-source-event-id=${JSON.stringify(lastReply.eventId)}]`)
      .waitFor({ state: "visible", timeout: 30_000 });
    failSummary = true;
    await confirmCompact(failingSessionId);
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
    await fixture.application.sessionHost.resume(compactSessionId);
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
    const secondTurnReply = `${REAL_PI_RESPONSE_TEXT}: second managed turn`;
    let secondTurn = false;
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
        return { kind: "text", text: REAL_PI_RESPONSE_TEXT };
      }
      return { kind: "text", text: secondTurn ? secondTurnReply : REAL_PI_RESPONSE_TEXT };
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

    const secondTurnPrompt = "A second managed Desktop Pi turn before route switching.";
    secondTurn = true;
    await page.locator(".session-pane [data-composer-editor='true'] .composer-rich-editor__content")
      .fill(secondTurnPrompt);
    await page.locator(".session-pane").getByRole("button", { name: "Send", exact: true }).click();
    const secondCompletion = await waitForManagedPiCompletion(managedClients, sessionId, secondTurnPrompt, secondTurnReply);
    const secondReply = page.locator(`[data-timeline-session-id='${sessionId}'] .message-assistant__body`)
      .getByText(secondTurnReply, { exact: true });
    // Read both visibility and identity in one browser task while the native
    // history refresh replaces the live reply.
    await waitFor(() => secondReply.evaluateAll(elements => elements.slice(0, 8).map(element => {
      const message = element.closest(".message-assistant");
      const bounds = element.getBoundingClientRect();
      return { eventId: message?.getAttribute("data-selection-quote-source-event-id"),
        streaming: message?.querySelector(".streaming-cursor") != null,
        visible: !element.closest("[inert]") && getComputedStyle(element).visibility === "visible" && bounds.width > 0 && bounds.height > 0 };
    })), rows => rows.length === 1 && rows[0]?.eventId === secondCompletion.eventId && rows[0].visible && !rows[0].streaming,
    "one visible completed second-turn reply in the current task", 30_000);
    secondTurn = false;

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
    const beforeExit = await waitFor(() => managedClients.session.getSession({ sessionId }),
      (response) => response.session?.state === SessionState.IDLE,
      "managed Desktop Pi task idle before complete exit", 30_000);
    const originalBinding = beforeExit.session?.nativeBinding;
    if (!originalBinding?.opaqueReference || originalBinding.runtimeGeneration === 0n) {
      throw new Error("Managed Desktop Pi did not expose its original native task binding.");
    }

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
        ...startupEvidence.environment(profileDirectory),
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
    const bindingBeforeRoute = resumedSnapshot.snapshot?.sessions.find(session => session.sessionId === sessionId)?.nativeBinding;
    const requestsBeforeRoute = requests.length;
    const resumedOrigin = new URL(resumedConnection.origin).origin;
    const readSessionId = new Map<string, (body: Uint8Array) => string>([
      ["GetSessionStatistics", body => fromBinary(GetSessionStatisticsRequestSchema, body).sessionId],
      ["ListRuntimeCommands", body => fromBinary(ListRuntimeCommandsRequestSchema, body).sessionId],
      ["ListSessionResources", body => fromBinary(ListSessionResourcesRequestSchema, body).sessionId],
      ["ListSessionTimeline", body => fromBinary(ListSessionTimelineRequestSchema, body).sessionId],
      ["GetSnapshot", body => {
        const scope = fromBinary(GetSnapshotRequestSchema, body).scope?.kind;
        return scope?.case === "session" ? scope.value.sessionId : "";
      }]
    ]);
    const sessionReadReceipts = new Map<Request, { method: string; startedAt: number; status?: number; finishedAt?: number; failed?: string }>();
    const observeRead = (request: Request): void => {
      if (request.method() !== "POST" || sessionReadReceipts.size >= 24) return;
      const url = new URL(request.url());
      const method = url.pathname.split("/").at(-1) ?? "";
      const read = readSessionId.get(method);
      const service = method === "GetSnapshot" ? "EventService" : "SessionService";
      if (url.origin !== resumedOrigin || url.pathname !== `/joko.v1.${service}/${method}` || read === undefined) return;
      const body = request.postDataBuffer();
      if (body === null) return;
      try {
        if (read(body) === sessionId) sessionReadReceipts.set(request, { method, startedAt: Date.now() });
      } catch { /* Unrelated or unreadable requests do not identify the original task. */ }
    };
    resumedPage.on("request", observeRead);
    resumedPage.on("response", (response) => {
      const receipt = sessionReadReceipts.get(response.request());
      if (receipt) { receipt.status = response.status(); receipt.finishedAt = Date.now(); }
    });
    resumedPage.on("requestfailed", (request) => {
      const receipt = sessionReadReceipts.get(request);
      if (receipt) { receipt.failed = request.failure()?.errorText ?? "unknown"; receipt.finishedAt = Date.now(); }
    });
    await resumedPage.evaluate((id) => { window.location.hash = `/tasks/${encodeURIComponent(id)}`; }, sessionId);
    await resumedPage.locator(`.session-pane [data-timeline-session-id='${sessionId}']`)
      .waitFor({ state: "visible", timeout: 30_000 });
    await resumedPage.getByText("Context compacted", { exact: true }).first()
      .waitFor({ state: "visible", timeout: 30_000 });
    const uiGeneration = async () => resumedPage.locator(`.session-pane[data-input-session-id='${sessionId}']`)
      .getAttribute("data-input-session-generation");
    const readVisibleBinding = async () => {
      const binding = (await resumedClients.session.getSession({ sessionId })).session?.nativeBinding;
      return binding?.runtimeGeneration.toString() === await uiGeneration() ? binding : undefined;
    };
    const bindingBeforeDraft = await waitFor(readVisibleBinding, binding => binding !== undefined,
      "managed Desktop resumed UI generation", 30_000);
    const generationBeforeResume = bindingBeforeDraft?.runtimeGeneration;
    expect(bindingBeforeDraft?.opaqueReference === originalBinding.opaqueReference).toBe(true);
    const requestsBeforeResume = requests.length;
    const existingOperations = new Set((await resumedClients.operation.listOperations({ sessionId }))
      .operations.map(operation => operation.operationId));
    const resumedDraft = "The managed Desktop Pi task continues after process restart.";
    const resumedEditor = resumedPage.locator(".session-pane [data-composer-editor='true'] .composer-rich-editor__content");
    await resumedEditor.fill(resumedDraft);
    const readPrewarms = async (timeoutMs?: number) => (await resumedClients.operation.listOperations({ sessionId }, { timeoutMs })).operations
      .filter(operation => operation.mutation?.payload.case === "prewarmSession" && !existingOperations.has(operation.operationId));
    const bindingObservation = (binding: typeof bindingBeforeDraft) => binding === undefined ? undefined : {
      generation: binding.runtimeGeneration.toString(), originalNativeReference: binding.opaqueReference === originalBinding.opaqueReference
    };
    try {
      const bindingAfterPrewarm = await waitFor(async () => {
        const operations = await readPrewarms();
        if (operations.length === 0) return undefined;
        const binding = await readVisibleBinding();
        if (binding === undefined) return undefined;
        const acknowledged = operations.some(operation => operation.state === OperationState.SUCCEEDED
          && operation.mutation?.preconditions.some(value => value.entity?.id === sessionId && value.expectedGeneration === binding.runtimeGeneration));
        return acknowledged ? binding : undefined;
      }, binding => binding !== undefined, "the resumed task's draft prewarm acknowledgement for its visible generation", 30_000);
      expect(bindingAfterPrewarm?.opaqueReference === originalBinding.opaqueReference).toBe(true);
      expect(await resumedEditor.innerText()).toBe(resumedDraft);
      expect(requests).toHaveLength(requestsBeforeRoute);
    } catch (cause) {
      const [binding, operations, changes] = await Promise.all([
        resumedClients.session.getSession({ sessionId }, { timeoutMs: 2_000 }).then(response => response.session?.nativeBinding).catch(() => undefined),
        readPrewarms(2_000).catch(() => []),
        resumedClients.session.listSessionTimeline({ sessionId, limit: 40 }, { timeoutMs: 2_000 })
          .then(response => response.events.filter(event => event.payload?.kind.case === "sessionChanged").slice(-8)
            .map(event => ({ generation: event.identity?.generation?.toString(),
              occurredAt: event.occurredAt && Number(event.occurredAt.seconds) * 1_000 + event.occurredAt.nanos / 1_000_000 })))
          .catch(() => [])
      ]);
      console.error("Managed packaged Pi: cold reopen and draft prewarm.", JSON.stringify({
        beforeExit: bindingObservation(originalBinding), beforeRoute: bindingObservation(bindingBeforeRoute),
        beforeDraft: bindingObservation(bindingBeforeDraft), afterPrewarm: bindingObservation(binding),
        sessionReads: [...sessionReadReceipts.values()], sessionChanges: changes,
        operations: operations.slice(0, 8).map(operation => ({ state: operation.state, errorCode: operation.error?.code,
          expectedGeneration: operation.mutation?.preconditions.find(value => value.entity?.id === sessionId)?.expectedGeneration.toString(),
          acceptedAt: operation.acceptedAt && Number(operation.acceptedAt.seconds) * 1_000 + operation.acceptedAt.nanos / 1_000_000 })),
        providerRequestsBeforeDraft: requestsBeforeResume - requestsBeforeRoute,
        providerRequestsSinceDraft: requests.length - requestsBeforeResume
      }));
      throw cause;
    }
    await resumedPage.locator(".session-pane").getByRole("button", { name: "Send", exact: true }).click();
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
    expect(resumedRequest).toContain(resumedDraft);
    expect(resumedRequest).toContain(REAL_PI_RESPONSE_TEXT);
    const resumedCompletion = await waitForManagedPiCompletion(resumedClients, sessionId, resumedDraft, REAL_PI_RESPONSE_TEXT);
    const resumedTimeline = resumedPage.locator(`[data-timeline-session-id='${sessionId}']`);
    try {
      await resumedTimeline.locator(`[data-selection-quote-source-event-id='${resumedCompletion.eventId}'] .message-assistant__body`)
        .getByText(REAL_PI_RESPONSE_TEXT, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    } catch (cause) {
      const [rows, current] = await Promise.all([
        resumedTimeline.locator(".message-assistant").evaluateAll((elements, expected) => elements.slice(-12).map(element => {
          const body = element.querySelector(".message-assistant__body");
          const bounds = element.getBoundingClientRect();
          return { eventId: element.getAttribute("data-selection-quote-source-event-id"), messageId: element.getAttribute("data-message-client-id"),
            expectedText: body?.textContent?.trim() === expected, streaming: element.querySelector(".streaming-cursor") !== null,
            visible: !element.closest("[inert]") && getComputedStyle(element).visibility === "visible" && bounds.width > 0 && bounds.height > 0 };
        }), REAL_PI_RESPONSE_TEXT).catch(() => []),
        resumedClients.event.getSnapshot({ scope: sessionScope }, { timeoutMs: 2_000 }).catch(() => undefined)
      ]);
      const timeline = current?.snapshot?.timeline ?? [];
      const session = current?.snapshot?.sessions.find(row => row.sessionId === sessionId);
      console.error("Managed packaged Pi: completed response missing from the reopened task view.", JSON.stringify({
        completion: { eventId: resumedCompletion.eventId, messageId: resumedCompletion.messageId, runId: resumedCompletion.runId,
          generation: resumedCompletion.generation, sequence: resumedCompletion.sequence },
        projection: { rows, visibleGeneration: await uiGeneration().catch(() => undefined),
          currentGeneration: session?.nativeBinding?.runtimeGeneration.toString(),
          snapshotHasCompletion: timeline.some(event => event.eventId === resumedCompletion.eventId),
          snapshotTail: timeline.slice(-8).map(event => ({ type: event.payload?.kind.case, eventId: event.eventId,
            generation: event.identity?.generation.toString(), sequence: event.cursor?.sequence.toString() })) },
        sessionReads: [...sessionReadReceipts.values()]
      }));
      throw cause;
    }

    const previousCompactions = new Set((await resumedClients.operation.listOperations({ sessionId }))
      .operations.map(operation => operation.operationId));
    const requestsBeforeFailure = requests.length;
    failSummary = true;
    const resumedTrigger = resumedPage.getByRole("button", { name: "Click to compact context" });
    await resumedTrigger.click();
    await resumedPage.getByRole("dialog", { name: "Compact context?" })
      .getByRole("button", { name: "Compact", exact: true }).click();
    const failure = resumedPage.locator(".compact-action-feedback--failure");
    try {
      await waitFor(() => resumedClients.operation.listOperations({ sessionId }), response => response.operations.some(operation =>
        !previousCompactions.has(operation.operationId) && operation.mutation?.payload.case === "compactSession"
          && operation.state === OperationState.FAILED), "failed compaction operation on the resumed task", 30_000);
      expect(requests.slice(requestsBeforeFailure).some(request =>
        JSON.stringify(request.body).includes("You are a context summarization assistant"))).toBe(true);
      await failure.waitFor({ state: "visible", timeout: 30_000 });
    } catch (cause) {
      const operations = (await resumedClients.operation.listOperations({ sessionId }, { timeoutMs: 3_000 })).operations;
      throw new Error(`The resumed task did not report the injected compaction failure: ${JSON.stringify({
        requests: requests.length - requestsBeforeFailure,
        operations: operations.filter(operation => !previousCompactions.has(operation.operationId)).map(operation => ({
          id: operation.operationId, state: operation.state, kind: operation.mutation?.payload.case,
          result: operation.result?.payload.case, error: operation.error?.code
        })),
        feedback: await resumedPage.locator(".compact-action-feedback").allInnerTexts()
      })}`, { cause });
    }
    failSummary = false;
    expect(await failure.getAttribute("role")).toBe("alert");
    expect(await failure.getAttribute("aria-live")).toBe("assertive");
    const failedSnapshot = await resumedClients.event.getSnapshot({ scope: sessionScope });
    const failedStates = (failedSnapshot.snapshot?.timeline ?? []).flatMap((item) =>
      item.payload?.kind.case === "compactionChanged" ? [item.payload.kind.value.state] : []);
    expect(failedStates).toContain(CompactionState.FAILED);
  });

  managedPackagedIt("normally exits its managed Pi service after tasks and compaction", { timeout: 150_000 }, async () => {
    lifecycleStarted = performance.now();
    recordLifecycle("started");
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
    recordLifecycle("task-completed");
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
    recordLifecycle("compaction-idle");
    if (managedDesktopIdentity === undefined) throw new Error("Managed Desktop lost its process identity.");
    if (profileDirectory === undefined) throw new Error("Managed Desktop lost its isolated profile.");
    const owned = managedDesktopIdentity;
    const profile = profileDirectory;
    recordLifecycle("first-quit");
    await desktop?.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); return true; });
    await waitFor(() => readOwnedWindowsProcess(owned.pid), (candidate) => candidate === undefined,
      "managed Desktop normal complete exit", 30_000);
    await waitFor(() => readOwnedWindowsChildPids(owned.pid), (pids) => pids.length === 0,
      "managed Desktop owned child exit", 10_000);
    recordLifecycle("first-exited");
    expect(await fetch(`${connection.origin}/joko.v1.ConnectionService/GetServerInfo`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      signal: AbortSignal.timeout(3_000)
    }).then((response) => response.ok, () => false)).toBe(false);
    managedDesktopIdentity = undefined;
    desktop = undefined;

    recordLifecycle("relaunch");
    desktop = await _electron.launch({
      executablePath: process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE!,
      env: {
        ...process.env,
        JOKO_DESKTOP_PACKAGED_SMOKE: "1",
        JOKO_DESKTOP_SMOKE_SCOPE: "external",
        ...startupEvidence.environment(profile),
        JOKO_DESKTOP_SMOKE_USER_DATA: profile,
        JOKO_PI_SETTINGS_FILE: join(profile, "pi-settings.json")
      }, timeout: 60_000
    });
    recordLifecycle("relaunched");
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
    recordLifecycle("restored");
    const resumedOwned = managedDesktopIdentity;
    await desktop.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); return true; });
    await waitFor(() => readOwnedWindowsProcess(resumedOwned.pid), (candidate) => candidate === undefined,
      "restarted managed Desktop normal complete exit", 30_000);
    await waitFor(() => readOwnedWindowsChildPids(resumedOwned.pid), (pids) => pids.length === 0,
      "restarted managed Desktop owned child exit", 10_000);
    recordLifecycle("restarted-exited");
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
    lifecycleStarted = performance.now();
    recordLifecycle("automatic-started");
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
    recordLifecycle("automatic-composer-ready");
    await newTask.locator("[data-composer-editor='true'] .composer-rich-editor__content")
      .fill(`Establish context for managed Pi ${reason} compaction.`);
    await newTask.getByRole("button", { name: "Send", exact: true }).click();
    recordLifecycle("automatic-input-sent");
    const sessionTimeline = page.locator(".session-pane [data-timeline-session-id]");
    await sessionTimeline.waitFor({ state: "visible", timeout: 30_000 });
    const sessionId = await sessionTimeline.getAttribute("data-timeline-session-id");
    if (sessionId === null) throw new Error("Managed Pi automatic compaction created no task identity.");
    recordLifecycle("automatic-task-visible");
    const automaticDiagnostic = async () => ({
      requests: requests.map((request, index) => ({
        number: index + 1,
        summary: JSON.stringify(request.body).includes("You are a context summarization assistant")
      })),
      sessionState: (await clients.session.getSession({ sessionId })).session?.state,
      compacting: (await clients.session.getSession({ sessionId })).session?.contextState?.compacting,
      compactions: (await clients.event.getSnapshot({ scope: create(SnapshotScopeSchema, {
        kind: { case: "session", value: create(SessionSnapshotScopeSchema, { sessionId, recentTimelineItems: 50 }) }
      }) })).snapshot?.timeline.flatMap((item) => item.payload?.kind.case === "compactionChanged"
        ? [{ sequence: String(item.cursor?.sequence), state: item.payload.kind.value.state,
            reason: item.payload.kind.value.reason, automatic: item.payload.kind.value.automatic }]
        : []),
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
      await page.locator(".session-pane").getByRole("button", { name: "Send", exact: true }).click();
      recordLifecycle("automatic-overflow-input-sent");
    }
    try {
      await waitFor(() => Promise.resolve(requests.some((request) =>
        JSON.stringify(request.body).includes("You are a context summarization assistant"))),
      (seen) => seen, `managed Pi ${reason} summary request`, 30_000);
    } catch (error) {
      recordLifecycle("automatic-summary-request-failed");
      throw new Error(`Managed Pi ${reason} did not request a summary: ${JSON.stringify(await automaticDiagnostic())}`, { cause: error });
    }
    recordLifecycle("automatic-summary-requested");
    const status = page.locator(".compaction-status-indicator");
    try {
      await status.waitFor({ state: "visible", timeout: 30_000 });
    } catch (cause) {
      throw new Error(`Managed Pi ${reason} status was not visible: ${JSON.stringify(await automaticDiagnostic())}`, { cause });
    }
    expect(await status.getAttribute("role")).toBe("status");
    expect(await status.getAttribute("aria-live")).toBe("polite");
    expect(await status.innerText()).toContain(expectedStatus);
    recordLifecycle("automatic-status-visible");
    releaseSummary?.();
    releasePendingProvider = undefined;
    await waitFor(() => clients.run.listRuns({ sessionId }),
      (response) => response.runs.filter((run) => run.state === RunState.SUCCEEDED).length
        >= (reason === "overflow" ? 2 : 1),
      `managed Pi ${reason} run`, 30_000);
    recordLifecycle("automatic-run-succeeded");
    await page.getByText("Context compacted", { exact: true }).first()
      .waitFor({ state: "visible", timeout: 30_000 });
    await status.waitFor({ state: "hidden", timeout: 30_000 });
    recordLifecycle("automatic-status-completed");
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
    recordLifecycle("automatic-verified");
  });
});

async function waitForManagedPiCompletion(clients: E2eClients, sessionId: string, input: string, reply: string) {
  const accepted = await waitFor(async () => {
    const { operations } = await clients.operation.listOperations({ sessionId });
    return operations.find(operation => {
      const payload = operation.mutation?.payload;
      return operation.state === OperationState.SUCCEEDED && payload?.case === "sendInput"
        && payload.value.input?.parts.flatMap(part => part.content.case === "text" ? [part.content.value] : []).join("") === input;
    });
  }, operation => operation !== undefined, "accepted SendInput for the managed Pi turn", 30_000);
  if (accepted === undefined) throw new Error("The managed Pi input has no queue receipt.");
  const runId = queueRunIdFrom(accepted);
  await waitFor(() => clients.run.getRun({ runId }), response => response.run?.state === RunState.SUCCEEDED,
    "the original managed Pi Run completed", 30_000);
  const completions = await waitFor(async () => {
    const history = await clients.session.listSessionTimeline({ sessionId, limit: 100 });
    return history.events.flatMap(event => {
      const payload = event.payload?.kind;
      return event.identity?.runId === runId && payload?.case === "messageCompleted" && payload.value.role === MessageRole.ASSISTANT
        ? [{ eventId: event.eventId, entryId: payload.value.nativeIdentity?.entryId, messageId: payload.value.messageId, runId,
          generation: event.identity?.generation.toString(), sequence: event.cursor?.sequence.toString(),
          text: payload.value.blocks.flatMap(block => block.content.case === "text" ? [block.content.value] : []).join("") }] : [];
    });
  }, rows => rows.some(row => !!row.entryId), "native completion for the original managed Pi Run", 30_000);
  expect(completions).toHaveLength(1);
  expect(completions[0]?.text).toBe(reply);
  return completions[0]!;
}

function observePageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });
  return errors;
}

async function withDesktopDeadline<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setNodeTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => { timer = setNodeTimeout(() => reject(new Error(message)), milliseconds); })
    ]);
  } finally {
    clearNodeTimeout(timer);
  }
}

async function closeConnectedWindowsDesktop(application: ElectronApplication, identity: OwnedProcessIdentity): Promise<void> {
  try {
    await withDesktopDeadline(application.evaluate(({ app }) => {
      setTimeout(() => app.exit(0), 50);
      return true;
    }), 5_000, "Packaged Pi Desktop did not acknowledge the exit request.");
    await waitFor(() => readOwnedWindowsProcess(identity.pid), (candidate) => candidate === undefined,
      "Packaged Pi Desktop exit", 8_000);
  } catch {
    await terminateOwnedWindowsProcess(identity);
  }
}

async function closePackagedDesktop(application: ElectronApplication): Promise<void> {
  const { mainPid, executablePath } = await withDesktopDeadline(application.evaluate(({ app }) => ({
    mainPid: process.pid, executablePath: app.getPath("exe")
  })), 5_000, "Packaged Pi Desktop did not report its cleanup identity.");
  if (resolve(executablePath).toLowerCase()
    !== resolve(process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE!).toLowerCase()) {
    throw new Error("Packaged Desktop cleanup refused an unexpected executable.");
  }
  // Closing the page follows close-to-tray. Schedule a full exit on the exact
  // main process after the evaluation acknowledgement reaches the harness.
  await withDesktopDeadline(application.evaluate(({ app }) => {
    setTimeout(() => app.exit(0), 50);
    return true;
  }), 5_000, "Packaged Pi Desktop did not acknowledge the exit request.");
  try {
    await waitFor(() => Promise.resolve(processIsAlive(mainPid)), (alive) => !alive,
      "Packaged Desktop application exit", 8_000);
  } catch {
    const current = await withDesktopDeadline(application.evaluate(({ app }) => ({
      pid: process.pid,
      executablePath: app.getPath("exe")
    })), 5_000, "Packaged Pi Desktop did not revalidate its cleanup identity.").catch(() => undefined);
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
