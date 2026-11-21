import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { OperationMutationSchema, OperationState, SnapshotScopeSchema } from "@joko/contracts";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { archiveMutation, createSessionMutation, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

it("shares the exact snoozed task between paired owners and wakes it when a new prompt is accepted", async () => {
  const fixture = await OrchestratorE2eFixture.start({ profiles: [PI_LIKE_PROFILE] });
  try {
    const desktop = await fixture.pair("Inbox desktop");
    const mobile = await fixture.pair("Inbox phone");
    const sessionId = sessionIdFrom(await submit(desktop.clients.operation, desktop.connectionId,
      createSessionMutation({ backendId: PI_LIKE_PROFILE.id, targetId: fixture.targetId(), displayName: "Owned Inbox task" })));
    const scope = create(SnapshotScopeSchema, { kind: { case: "owner", value: {} } });
    const read = async () => (await mobile.clients.event.getSnapshot({ scope })).snapshot?.sessions.find(task => task.sessionId === sessionId);
    expect(await read()).toMatchObject({ inboxSnoozeAllowed: true });
    expect((await read())?.snooze).toBeUndefined();
    const snooze = (choice: "indefinitely" | "wake" | { seconds: bigint; nanos: number }) => create(OperationMutationSchema, {
      payload: { case: "setSessionSnooze", value: { sessionId, choice: typeof choice === "string"
        ? { case: choice, value: true } : { case: "until", value: choice } } }
    });
    await expect(fixture.anonymous.operation.submitOperation({
      operationId: "anonymous-snooze", connectionId: desktop.connectionId, mutation: snooze("indefinitely")
    })).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect((await submit(desktop.clients.operation, desktop.connectionId, snooze("indefinitely"))).state).toBe(OperationState.SUCCEEDED);
    const sleeping = await read();
    expect(sleeping?.snooze?.setAt).toBeDefined();
    expect(sleeping?.snooze?.until).toBeUndefined();
    expect((await submit(mobile.clients.operation, mobile.connectionId, snooze("wake"))).state).toBe(OperationState.SUCCEEDED);
    const until = timestampFromDate(new Date(Date.now() + 60 * 60_000));
    expect((await submit(desktop.clients.operation, desktop.connectionId, snooze(until))).state).toBe(OperationState.SUCCEEDED);
    expect((await read())?.snooze?.until).toMatchObject({ seconds: until.seconds, nanos: until.nanos });
    const originalClock = (await read())?.snooze?.setAt;
    if (originalClock === undefined) throw new Error("Task snooze did not supply its owner timestamp.");
    const setAt = Number(originalClock.seconds) * 1_000 + originalClock.nanos / 1_000_000;
    await waitFor(async () => Date.now(), now => now > setAt, "the next accepted timestamp");
    expect((await submit(mobile.clients.operation, mobile.connectionId,
      sendInputMutation(sessionId, (await read())!.nativeBinding!.runtimeGeneration, "Continue this task."))).state).toBe(OperationState.SUCCEEDED);
    expect((await read())?.snooze).toBeUndefined();

    const idleTask = sessionIdFrom(await submit(desktop.clients.operation, desktop.connectionId,
      createSessionMutation({ backendId: PI_LIKE_PROFILE.id, targetId: fixture.targetId() })));
    expect((await submit(desktop.clients.operation, desktop.connectionId, archiveMutation(idleTask, true))).state).toBe(OperationState.SUCCEEDED);
    const archived = (await mobile.clients.event.getSnapshot({ scope })).snapshot?.sessions.find(task => task.sessionId === idleTask);
    expect(archived).toMatchObject({ archived: true, inboxSnoozeAllowed: false });
  } finally { await fixture.close(); }
});

const browserPath = process.env["JOKO_BROWSER_EXECUTABLE"]?.trim();
const webDirectory = process.env["JOKO_MOUNTED_WEB_DIR"]?.trim();
it.skipIf(!browserPath || !webDirectory)("moves a task between the live Web inbox sections and keeps snooze choices keyboard accessible", { timeout: 90_000 }, async () => {
  const fixture = await OrchestratorE2eFixture.start({ profiles: [PI_LIKE_PROFILE], webDirectory });
  try {
    const owner = await fixture.pair("Inbox service observer");
    const sessionId = sessionIdFrom(await submit(owner.clients.operation, owner.connectionId,
      createSessionMutation({ backendId: PI_LIKE_PROFILE.id, targetId: fixture.targetId(), displayName: "Review inbox delivery" })));
    const challenge = (await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Inbox Web" })).challenge!;
    const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
    try {
      const page = await browser.newPage({ locale: "en-US", viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
      await page.goto(fixture.baseUrl + "/#/task-inbox", { waitUntil: "domcontentloaded" });
      await page.locator(".connection-tabs > button").nth(2).click();
      await page.locator("details.device-authorization__manual > summary").click();
      await page.getByLabel("Joko node address").fill(fixture.baseUrl);
      await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challengeId));
      await page.getByLabel("Device name").fill("Inbox Web");
      await page.locator("form.pair-form button[type=submit]").click();
      const inbox = page.getByRole("region", { name: "Inbox", exact: true });
      const snoozed = page.getByRole("region", { name: "Snoozed", exact: true });
      await inbox.getByRole("button", { name: "Review inbox delivery", exact: true }).waitFor();
      await inbox.getByRole("button", { name: "Snooze", exact: true }).press("Enter");
      const choice = page.getByRole("dialog", { name: "Snooze" });
      await choice.getByRole("button", { name: "Until I wake it", exact: true }).press("Enter");
      await snoozed.getByRole("button", { name: "Wake", exact: true }).waitFor();
      expect(fixture.application.store.getSession(sessionId).descriptor.snooze?.until).toBeUndefined();
      expect(fixture.application.store.getSession(sessionId).descriptor.snooze?.setAt).toBeDefined();
      await page.emulateMedia({ colorScheme: "dark" });
      await page.setViewportSize({ width: 390, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await snoozed.getByRole("button", { name: "Wake", exact: true }).click();
      await inbox.getByRole("button", { name: "Review inbox delivery", exact: true }).waitFor();
      expect(fixture.application.store.getSession(sessionId).descriptor.snooze).toBeUndefined();
    } finally { await browser.close(); }
  } finally { await fixture.close(); }
});
