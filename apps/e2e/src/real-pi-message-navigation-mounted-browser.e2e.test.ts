import { create, fromBinary } from "@bufbuild/protobuf";
import { EntityKind, OperationMutationSchema, OperationState, PromptRecommendationSettingsPatchSchema, RunState, SnapshotScopeSchema,
  SubmitOperationRequestSchema, UpdatePromptRecommendationSettingsMutationSchema } from "@joko/contracts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { expect, it, vi } from "vitest";

import { closeCompactNavigationDrawer, waitFor } from "./fixture.js";
import { cancelQueuedInputMutation, createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";

const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim() && process.env.JOKO_MOUNTED_WEB_DIR?.trim() ? it : it.skip;

mountedIt("rewinds and edits original real Pi rows, rejects stale edits and stops only the active input selected for editing", { timeout: 180_000 }, async () => {
  let fixture: RealPiSystemFixture | undefined, browser: Browser | undefined, page: Page | undefined;
  let releaseNavigation: (() => void) | undefined;
  let releaseProviderResponse: (() => void) | undefined;
  let releaseStop: (() => void) | undefined;
  let holdNextResponse = false;
  const evidenceDirectory = process.env.RUNNER_TEMP === undefined ? undefined
    : join(process.env.RUNNER_TEMP, "joko-web-evidence", "message-navigation");
  const capture = async (name: string) => {
    if (evidenceDirectory === undefined || page === undefined) return;
    await mkdir(evidenceDirectory, { recursive: true });
    await page.screenshot({ path: join(evidenceDirectory, name), fullPage: true, timeout: 5_000 });
  };
  try {
    fixture = await RealPiSystemFixture.start({ webDirectory: process.env.JOKO_MOUNTED_WEB_DIR!,
      providerResponder: async ({ requestNumber }) => {
        if (holdNextResponse) {
          holdNextResponse = false;
          await new Promise<void>(resolve => { releaseProviderResponse = resolve; });
        }
        return { kind: "text", text: `Message navigation answer ${requestNumber}` };
      } });
    const manager = await fixture.pair("Message navigation manager");
    const preferences = await submit(manager.clients.operation, manager.connectionId, create(OperationMutationSchema, {
      payload: { case: "updatePromptRecommendationSettings", value: create(UpdatePromptRecommendationSettingsMutationSchema, {
        patch: create(PromptRecommendationSettingsPatchSchema, { enabled: false })
      }) }
    }));
    expect(preferences.state).toBe(OperationState.SUCCEEDED);
    expect(fixture.application.promptPrediction?.state().enabled).toBe(false);
    const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId, createSessionMutation({
      backendId: "pi", targetId: "workspace-real-pi", displayName: "Original message navigation", providerId: REAL_PI_PROVIDER_ID,
      modelId: REAL_PI_MODEL_ID, effortId: "off"
    })));
    const store = fixture.application.store, host = fixture.application.sessionHost;
    const binding = store.getSession(sessionId).descriptor.binding;
    const send = async (text: string) => {
      const operation = await submit(manager.clients.operation, manager.connectionId,
        sendInputMutation(sessionId, BigInt(binding.generation), text));
      const runId = queueRunIdFrom(operation);
      await waitFor(() => manager.clients.run.getRun({ runId }), response => response.run?.state === RunState.SUCCEEDED,
        `the controlled Pi turn: ${text}`, 30_000);
      const origin = store.findVisibleSessionMessageOrigin({ sessionId, role: "user", includeRetainedContext: false });
      if (origin === undefined) throw new Error("The real Pi turn has no visible original user source.");
      return origin;
    };
    await send("Retain this earlier round.");
    const editedSource = await send("Edit this loaded original input.");
    const owner = await manager.clients.event.getSnapshot({ scope: create(SnapshotScopeSchema, { kind: { case: "owner", value: {} } }) });
    expect(owner.snapshot?.timeline).toEqual([]);

    const challenge = (await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Message navigation browser" })).challenge!;
    browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 960 } });
    await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.locator("details.device-authorization__manual > summary").click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challengeId));
    await page.getByLabel("Device name").fill("Message navigation browser");
    await page.locator("form.pair-form button[type=submit]").click();
    const pane = page.locator(`.session-pane[data-input-session-id='${sessionId}']`);
    await pane.waitFor({ state: "visible", timeout: 30_000 });
    const reload = async () => {
      await page!.reload({ waitUntil: "domcontentloaded" });
      const expires = Date.now() + 30_000;
      const timeLeft = () => Math.max(1, expires - Date.now());
      await page!.getByRole("button", { name: "Saved nodes", exact: true }).click({ timeout: timeLeft() });
      await page!.locator(".connection-card .profile-card").filter({ hasText: fixture!.baseUrl })
        .getByRole("button", { name: "Connect", exact: true }).click({ timeout: timeLeft() });
      await pane.waitFor({ state: "visible", timeout: timeLeft() });
    };
    await reload();
    const originalNavigate = host.navigateTree.bind(host);
    let holdNextNavigation = false;
    const gate = new Promise<void>(resolve => { releaseNavigation = resolve; });
    const navigation = vi.spyOn(host, "navigateTree").mockImplementation(async (...args) => {
      if (holdNextNavigation) { holdNextNavigation = false; await gate; }
      return originalNavigate(...args);
    });
    const row = (messageId: string) => pane.locator(`[data-user-msg-id='${messageId}']`);
    const composer = pane.locator("[data-composer-editor='true'] .composer-rich-editor__content");
    const editedRow = row(editedSource.messageId);
    await editedRow.hover();
    await editedRow.getByRole("button", { name: "Edit message", exact: true }).click();
    await editedRow.locator("textarea").fill("My revised loaded input.");
    const requestCountBeforeEdit = fixture.providerRequests.length;
    const submitRoute = "**/joko.v1.OperationService/SubmitOperation";
    const receiptRoute = "**/joko.v1.OperationService/GetOperation";
    const submittedEditOperations: string[] = [];
    await page.route(receiptRoute, route => route.abort("failed"));
    await page.route(submitRoute, async route => {
      const bytes = route.request().postDataBuffer();
      if (bytes === null) return route.continue();
      const operation = fromBinary(SubmitOperationRequestSchema, bytes);
      if (operation.mutation?.payload.case !== "sendInput" || operation.mutation.payload.value.messageEdit === undefined) return route.continue();
      submittedEditOperations.push(operation.operationId);
      await route.fetch();
      await route.abort("failed");
    });
    await editedRow.getByRole("button", { name: "Send edited message", exact: true }).click();
    await waitFor(() => Promise.resolve(navigation.mock.calls.length), count => count === 1, "the mounted confirmation's native rewind");
    expect(navigation).toHaveBeenCalledOnce();
    expect(navigation.mock.calls[0]![5].sourceMessage).toEqual({ ...editedSource, requireLatestUser: true });
    const resendOperationId = navigation.mock.calls[0]![5].operationId;
    try { await navigation.mock.results[0]!.value; }
    catch (cause) {
      const diagnostics = store.listDiagnostics({ limit: 12 }).filter(item => item.component.startsWith("native_navigation_") || item.component === "sendInput")
        .map(({ component, code, message }) => ({ component, code, message }));
      throw new Error(`The original native edit did not reach queue admission. ${JSON.stringify(diagnostics)}`, { cause });
    }
    const resend = await waitFor(() => Promise.resolve(store.listQueueItems({ sessionId }).find(item => item.operationId === resendOperationId)),
      item => item?.state === "completed", "the edit's original queue item completes");
    expect(resend?.body.text).toBe("My revised loaded input.");
    expect(store.getOperation(resendOperationId)).toMatchObject({ kind: "sendInput", status: "completed" });
    expect(store.findVisibleSessionMessageOrigin({ sessionId, eventId: editedSource.eventId })).toBeUndefined();
    expect(store.getSession(sessionId).descriptor.binding).toEqual(binding);
    expect(fixture.providerRequests).toHaveLength(requestCountBeforeEdit + 1);
    expect(JSON.stringify(fixture.providerRequests.at(-1)?.body)).toContain("My revised loaded input.");
    const checkEdit = pane.getByRole("button", { name: "Check edit result", exact: true });
    await checkEdit.waitFor({ state: "visible", timeout: 30_000 });
    await reload();
    await checkEdit.waitFor({ state: "visible", timeout: 30_000 });
    await page.unroute(receiptRoute);
    await checkEdit.click();
    await checkEdit.waitFor({ state: "hidden", timeout: 30_000 });
    expect(submittedEditOperations).toEqual([resendOperationId]);
    expect(fixture.providerRequests).toHaveLength(requestCountBeforeEdit + 1);
    await page.unroute(submitRoute);
    expect(await composer.innerText()).not.toContain("My revised loaded input.");
    await pane.getByText("My revised loaded input.", { exact: true }).waitFor({ state: "visible" });
    await capture("reloaded-row-edited-light.png");

    const rewindSource = await send("Rewind this loaded original input.");
    await reload();
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.setViewportSize({ width: 430, height: 900 });
    await closeCompactNavigationDrawer(page);
    const closeDetails = page.locator(".inspector-dock-group[data-edge]")
      .getByRole("button", { name: "Close details", exact: true }).first();
    if (await closeDetails.isVisible()) await closeDetails.click();
    await closeDetails.waitFor({ state: "hidden" });
    const rewindRow = row(rewindSource.messageId);
    await rewindRow.hover(); await rewindRow.locator(".message-action-menu > summary").click();
    await rewindRow.getByRole("menuitem", { name: "Rewind from here", exact: true }).click();
    const preview = page.locator('[data-message-rewind-preview="true"]');
    await preview.waitFor({ state: "visible" }); await capture("reloaded-row-rewind-preview-dark-narrow.png");
    await preview.getByRole("button", { name: "Rewind dialogue only", exact: true }).click();
    await preview.waitFor({ state: "hidden", timeout: 30_000 });
    expect(navigation).toHaveBeenCalledTimes(2);
    expect(navigation.mock.calls[1]![5].sourceMessage).toEqual({ ...rewindSource, requireLatestUser: false });
    expect(store.findVisibleSessionMessageOrigin({ sessionId, eventId: rewindSource.eventId })).toBeUndefined();
    await capture("reloaded-row-rewound-dark-narrow.png");

    const delayedText = "Keep this original row if the edit becomes stale.";
    const editedText = "Preserve this attempted edit.";
    const newerText = "New input from the other paired client.";
    const delayedSource = await send(delayedText);
    await page.setViewportSize({ width: 1440, height: 960 }); await page.emulateMedia({ colorScheme: "light" });
    await reload();
    const delayedRow = row(delayedSource.messageId);
    await delayedRow.hover(); await delayedRow.getByRole("button", { name: "Edit message", exact: true }).click();
    await delayedRow.locator("textarea").fill(editedText);
    holdNextNavigation = true;
    await delayedRow.getByRole("button", { name: "Send edited message", exact: true }).click();
    await waitFor(() => Promise.resolve(navigation.mock.calls.length), count => count === 3, "the delayed original edit request");
    expect(navigation.mock.calls[2]![5].sourceMessage).toEqual({ ...delayedSource, requireLatestUser: true });
    const staleOperationId = navigation.mock.calls[2]![5].operationId;
    const revisionBeforeNewInput = store.getSession(sessionId).revision;
    const requestsBeforeNewTurn = fixture.providerRequests.length;
    const newerSource = await send(newerText);
    expect(store.getSession(sessionId).descriptor.binding).toEqual(binding);
    const historyMarkers = () => store.listEvents({ sessionId }).filter(event => event.payload.type === "native_session_changed").map(event => event.id);
    const markersAfterNewTurn = historyMarkers(), requestsAfterNewTurn = fixture.providerRequests.length;
    expect(requestsAfterNewTurn - requestsBeforeNewTurn).toBe(1);
    await row(newerSource.messageId).waitFor({ state: "visible", timeout: 30_000 });
    expect(await delayedRow.locator("textarea").isDisabled()).toBe(true);
    const requestsBeforeRelease = fixture.providerRequests.length;
    releaseNavigation!();
    await delayedRow.getByRole("alert").waitFor({ state: "visible", timeout: 30_000 });
    expect(await delayedRow.locator("textarea").inputValue()).toBe(editedText);
    expect(await delayedRow.locator("textarea").isEnabled()).toBe(true);
    for (const source of [delayedSource, newerSource]) {
      expect(store.findVisibleSessionMessageOrigin({ sessionId, eventId: source.eventId })).toEqual(source);
    }
    expect(historyMarkers()).toEqual(markersAfterNewTurn);
    expect(navigation).toHaveBeenCalledTimes(3);
    expect(store.getOperation(staleOperationId).status).toBe("failed");
    expect(store.listQueueItems({ sessionId }).some(item => item.operationId === staleOperationId)).toBe(false);
    const newerTurnBodies = fixture.providerRequests.slice(requestsBeforeNewTurn, requestsAfterNewTurn).map(({ body }) => JSON.stringify(body));
    const extraRequests = fixture.providerRequests.slice(requestsAfterNewTurn).map(({ method, url, body }, index) => {
      const messages: readonly unknown[] = Array.isArray(body["messages"]) ? body["messages"] : [];
      const serialized = JSON.stringify(body);
      return {
        method, url, model: body["model"], beforeEditReleased: requestsAfterNewTurn + index < requestsBeforeRelease,
        roles: messages.map(message => message && typeof message === "object" && "role" in message ? String(message.role) : ""),
        matchesNewerTurnBody: newerTurnBodies.includes(serialized),
        containsDelayedText: serialized.includes(delayedText), containsEditedText: serialized.includes(editedText),
        containsNewerText: serialized.includes(newerText)
      };
    });
    expect(extraRequests, "Provider requests observed after the newer input settled").toEqual([]);
    await capture("delayed-edit-rejected-original-and-new-input-preserved.png");

    holdNextResponse = true;
    const runningSend = await submit(manager.clients.operation, manager.connectionId,
      sendInputMutation(sessionId, BigInt(binding.generation), "Stop this running input so I can edit it."));
    const runningRunId = queueRunIdFrom(runningSend);
    const runningSource = await waitFor(() => Promise.resolve(store.findVisibleSessionMessageOrigin({ sessionId, role: "user", includeRetainedContext: false })),
      origin => {
        const event = origin === undefined ? undefined : store.findEvent(origin.eventId);
        return event !== undefined && event.runId === runningRunId && event.payload.type === "message_complete"
          && event.payload.nativeHistory?.identity?.rewindBefore?.kind === "native_entry";
      }, "the running Pi user message with its native rewind boundary");
    if (runningSource === undefined) throw new Error("The running Pi input has no durable user message.");
    const activeAttemptId = store.getRun(runningRunId).descriptor.activeAttemptId;
    expect(activeAttemptId).toBeDefined();
    const rejected = await submit(manager.clients.operation, manager.connectionId, create(OperationMutationSchema, {
      payload: { case: "abortRun", value: { runId: runningRunId, messageEdit: {
        sourceMessageId: runningSource.messageId, sourceEventId: runningSource.eventId, attemptId: "retired-attempt"
      } } },
      preconditions: [{ entity: { kind: EntityKind.SESSION, id: sessionId }, expectedGeneration: BigInt(binding.generation) }]
    }));
    expect(rejected.state).toBe(OperationState.FAILED);
    expect(store.getRun(runningRunId).descriptor.state).toBe("running");
    const runningRow = row(runningSource.messageId);
    await runningRow.hover();
    const stopAndEdit = runningRow.getByRole("button", { name: "Stop and edit message" });
    const sendEdit = runningRow.getByRole("button", { name: "Send edited message", exact: true });
    const cancelEdit = runningRow.getByRole("button", { name: "Cancel", exact: true });
    const originalAbort = host.abort.bind(host);
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve; });
    const abort = vi.spyOn(host, "abort").mockImplementationOnce(async (...args) => {
      await stopGate;
      return originalAbort(...args);
    });
    await stopAndEdit.click();
    await runningRow.locator("textarea").fill("An edit during the original stop.");
    expect(await sendEdit.isDisabled()).toBe(true);
    await waitFor(() => Promise.resolve(abort.mock.calls.length), count => count === 1, "the first stop for editing");
    const pendingSend = await submit(manager.clients.operation, manager.connectionId,
      sendInputMutation(sessionId, BigInt(binding.generation), "This independently queued input stays pending."));
    const pendingRunId = queueRunIdFrom(pendingSend);
    const pendingItem = store.findQueueItemByRunId(sessionId, pendingRunId)!;
    expect(pendingItem.state).toBe("accepted");
    releaseStop!();
    await expect(abort.mock.results[0]!.value).rejects.toThrow("Finish or remove pending input");
    expect(store.getRun(runningRunId).descriptor.state).toBe("running");
    expect(store.getQueueItem(pendingItem.id).state).toBe("accepted");
    expect(await runningRow.locator("textarea").inputValue()).toBe("An edit during the original stop.");
    await cancelEdit.click();
    const pendingResult = pendingSend.result?.payload;
    if (pendingResult?.case !== "queueItem") throw new Error("The pending Pi input has no queue receipt.");
    const cancelled = await submit(manager.clients.operation, manager.connectionId, cancelQueuedInputMutation(pendingResult.value));
    expect(cancelled.state).toBe(OperationState.SUCCEEDED);

    await runningRow.hover();
    await stopAndEdit.click();
    await runningRow.locator("textarea").waitFor({ state: "visible" });
    await waitFor(() => manager.clients.run.getRun({ runId: runningRunId }), response => response.run?.state === RunState.ABORTED,
      "the original Run stopped for editing", 15_000);
    expect(abort).toHaveBeenCalledTimes(2);
    expect(abort.mock.calls[1]).toEqual([sessionId, runningRunId, expect.any(Function), expect.objectContaining({
      messageEdit: { ...runningSource, attemptId: activeAttemptId }
    })]);
    await waitFor(() => sendEdit.isEnabled(), enabled => enabled, "the edit can be confirmed after the original Run stops");
    await capture("running-input-stopped-for-edit.png");
    const requestsAfterStop = fixture.providerRequests.length;
    await cancelEdit.click();
    expect(navigation).toHaveBeenCalledTimes(3);
    expect(fixture.providerRequests).toHaveLength(requestsAfterStop);
    expect(store.findVisibleSessionMessageOrigin({ sessionId, role: "user", includeRetainedContext: false })?.messageId).toBe(runningSource.messageId);
    abort.mockRestore();
    if (evidenceDirectory !== undefined) await writeFile(join(evidenceDirectory, "message-navigation.json"), JSON.stringify({
      sessionId, editedSource, rewindSource, delayedSource, newerSource, generation: binding.generation,
      resendOperationId, resendRunId: resend?.runId, resendQueueId: resend?.id, resendProviderCalls: 1,
      resendSubmitCalls: submittedEditOperations.length, lostEditReceiptReconciledAfterReload: true,
      revisionBeforeNewInput: revisionBeforeNewInput.toString(), revisionAfterNewInput: store.getSession(sessionId).revision.toString(),
      nativeBranchUnchangedAfterRejection: true, nativeNavigationRequests: navigation.mock.calls.length,
      editOperationId: navigation.mock.calls[2]![5].operationId,
      editOperationState: store.getOperation(navigation.mock.calls[2]![5].operationId).status,
      runningSource, runningRunId, activeAttemptId, pendingRunId, rejectedAttemptOperationId: rejected.operationId,
      confirmDisabledDuringStop: true, pendingInputPreserved: true, originalRunStopped: true
    }, null, 2));
    navigation.mockRestore();
  } catch (error) {
    if (page !== undefined) console.error("Message navigation browser state", (await page.locator("body").innerText()).slice(0, 6_000));
    await capture("failed.png").catch(() => undefined);
    throw error;
  } finally {
    releaseStop?.(); releaseProviderResponse?.(); releaseNavigation?.();
    await browser?.close(); await fixture?.close({ removeRoot: true });
  }
});
