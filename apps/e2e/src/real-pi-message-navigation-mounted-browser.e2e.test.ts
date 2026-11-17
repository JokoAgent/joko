import { create } from "@bufbuild/protobuf";
import { RunState, SnapshotScopeSchema } from "@joko/contracts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { expect, it, vi } from "vitest";

import { waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";

const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim() && process.env.JOKO_MOUNTED_WEB_DIR?.trim() ? it : it.skip;

mountedIt("rewinds and edits reloaded real Pi rows by their original source and rejects a delayed edit after another client's turn", { timeout: 180_000 }, async () => {
  let fixture: RealPiSystemFixture | undefined, browser: Browser | undefined, page: Page | undefined;
  let releaseNavigation: (() => void) | undefined;
  const evidenceDirectory = process.env.RUNNER_TEMP === undefined ? undefined
    : join(process.env.RUNNER_TEMP, "joko-web-evidence", "message-navigation");
  const capture = async (name: string) => {
    if (evidenceDirectory === undefined || page === undefined) return;
    await mkdir(evidenceDirectory, { recursive: true });
    await page.screenshot({ path: join(evidenceDirectory, name), fullPage: true, timeout: 5_000 });
  };
  try {
    fixture = await RealPiSystemFixture.start({ webDirectory: process.env.JOKO_MOUNTED_WEB_DIR!,
      providerResponder: ({ requestNumber }) => ({ kind: "text", text: `Message navigation answer ${requestNumber}` }) });
    const manager = await fixture.pair("Message navigation manager");
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
      await pane.waitFor({ state: "visible", timeout: 30_000 });
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
    await editedRow.getByRole("button", { name: "Move to composer", exact: true }).click();
    await waitFor(() => composer.innerText(), text => text.includes("My revised loaded input."), "the reloaded edit in the composer");
    expect(navigation).toHaveBeenCalledOnce();
    expect(navigation.mock.calls[0]![5].sourceMessage).toEqual({ ...editedSource, requireLatestUser: true });
    expect(store.findVisibleSessionMessageOrigin({ sessionId, eventId: editedSource.eventId })).toBeUndefined();
    expect(store.getSession(sessionId).descriptor.binding).toEqual(binding);
    expect(fixture.providerRequests).toHaveLength(requestCountBeforeEdit);
    await capture("reloaded-row-edited-light.png");

    const rewindSource = await send("Rewind this loaded original input.");
    await reload();
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.setViewportSize({ width: 430, height: 900 });
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

    const delayedSource = await send("Keep this original row if the edit becomes stale.");
    await page.setViewportSize({ width: 1440, height: 960 }); await page.emulateMedia({ colorScheme: "light" });
    await reload();
    const delayedRow = row(delayedSource.messageId);
    await delayedRow.hover(); await delayedRow.getByRole("button", { name: "Edit message", exact: true }).click();
    await delayedRow.locator("textarea").fill("Preserve this attempted edit.");
    holdNextNavigation = true;
    await delayedRow.getByRole("button", { name: "Move to composer", exact: true }).click();
    await waitFor(() => Promise.resolve(navigation.mock.calls.length), count => count === 3, "the delayed original edit request");
    expect(navigation.mock.calls[2]![5].sourceMessage).toEqual({ ...delayedSource, requireLatestUser: true });
    const revisionBeforeNewInput = store.getSession(sessionId).revision;
    const newerSource = await send("New input from the other paired client.");
    expect(store.getSession(sessionId).descriptor.binding).toEqual(binding);
    const historyMarkers = () => store.listEvents({ sessionId }).filter(event => event.payload.type === "native_session_changed").map(event => event.id);
    const markersAfterNewTurn = historyMarkers(), requestsAfterNewTurn = fixture.providerRequests.length;
    releaseNavigation!();
    await delayedRow.getByRole("alert").waitFor({ state: "visible", timeout: 30_000 });
    expect(await delayedRow.locator("textarea").inputValue()).toBe("Preserve this attempted edit.");
    expect(await delayedRow.locator("textarea").isEnabled()).toBe(true);
    for (const source of [delayedSource, newerSource]) {
      expect(store.findVisibleSessionMessageOrigin({ sessionId, eventId: source.eventId })).toEqual(source);
    }
    expect(historyMarkers()).toEqual(markersAfterNewTurn);
    expect(fixture.providerRequests).toHaveLength(requestsAfterNewTurn);
    expect(navigation).toHaveBeenCalledTimes(3);
    expect(store.getOperation(navigation.mock.calls[2]![5].operationId).status).toBe("failed");
    await capture("delayed-edit-rejected-original-and-new-input-preserved.png");
    if (evidenceDirectory !== undefined) await writeFile(join(evidenceDirectory, "message-navigation.json"), JSON.stringify({
      sessionId, editedSource, rewindSource, delayedSource, newerSource, generation: binding.generation,
      revisionBeforeNewInput: revisionBeforeNewInput.toString(), revisionAfterNewInput: store.getSession(sessionId).revision.toString(),
      nativeBranchUnchangedAfterRejection: true, nativeNavigationRequests: navigation.mock.calls.length,
      editOperationId: navigation.mock.calls[2]![5].operationId,
      editOperationState: store.getOperation(navigation.mock.calls[2]![5].operationId).status
    }, null, 2));
    navigation.mockRestore();
  } catch (error) {
    if (page !== undefined) console.error("Message navigation browser state", (await page.locator("body").innerText()).slice(0, 6_000));
    await capture("failed.png").catch(() => undefined);
    throw error;
  } finally {
    releaseNavigation?.(); await browser?.close(); await fixture?.close({ removeRoot: true });
  }
});
