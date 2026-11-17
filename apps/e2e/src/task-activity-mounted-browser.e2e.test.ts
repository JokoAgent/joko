import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { expect, it } from "vitest";
import { OrchestratorE2eFixture } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

const browserPath = process.env.JOKO_BROWSER_EXECUTABLE?.trim(), webDirectory = process.env.JOKO_MOUNTED_WEB_DIR?.trim();
const mountedIt = browserPath && webDirectory ? it : it.skip;

mountedIt("tracks real task panes across shared-owner tabs and revokes only the Device fixed before confirmation", { timeout: 120_000 }, async () => {
  if (!browserPath || !webDirectory || !isAbsolute(browserPath) || !isAbsolute(webDirectory)) throw new Error("Absolute production Web and browser paths are required.");
  const fixture = await OrchestratorE2eFixture.start({ webDirectory });
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const evidence = process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, "joko-web-evidence", "task-activity") : undefined;
  if (evidence) await mkdir(evidence, { recursive: true });
  const errors: string[] = [];
  const observer = await browser.newPage({ locale: "en-US", viewport: { width: 1280, height: 960 }, reducedMotion: "reduce" });
  const remoteContext = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 960 }, reducedMotion: "reduce" });
  const remote = await remoteContext.newPage();
  const third = await browser.newPage({ locale: "en-US", viewport: { width: 1280, height: 960 }, reducedMotion: "reduce" });
  for (const page of [observer, remote, third]) page.on("pageerror", error => errors.push(error.message));
  const capture = async (name: string, page = observer) => {
    if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`), animations: "disabled", fullPage: false,
      mask: [page.locator("input:visible, textarea:visible"), page.locator(".device-authorization__qr:visible")] });
  };
  const route = async (page: Page, hash: string) => { await page.evaluate(value => { location.hash = value; }, hash); };
  const pair = async (page: Page, name: string) => {
    const challenge = fixture.application.connections.issuePairing(name);
    await page.goto(fixture.baseUrl);
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.locator("details.device-authorization__manual > summary").click();
    await page.getByLabel("Joko node address", { exact: true }).fill(fixture.baseUrl);
    const key = page.locator(".pair-form textarea"); if (await key.count()) await key.fill(fixture.application.linkspanIdentity!.publicKey);
    await page.getByLabel("Pairing code", { exact: true }).fill(challenge.code);
    await page.getByLabel("Device name", { exact: true }).fill(name);
    await page.locator("form.pair-form button[type=submit]").click();
    await page.locator(".app").waitFor({ timeout: 30_000 });
    await route(page, "#/settings/general"); await page.locator(".theme-picker").waitFor();
    return fixture.application.store.listDevices().find(device => device.name === name)!.id;
  };
  const closeNavigationDrawer = async (page: Page) => {
    const scrim = page.locator(".panel-scrim--navigation");
    if (await scrim.isVisible()) await page.locator(".sidebar__mobile-close").click();
    await scrim.waitFor({ state: "hidden" });
  };
  const openTask = async (page: Page, id: string) => {
    await route(page, `#/tasks/${encodeURIComponent(id)}`);
    await page.locator(`.session-pane[data-input-session-id='${id}'] .session-composer-layer`).waitFor();
    await closeNavigationDrawer(page);
    const closeDetails = page.locator(".inspector-dock-group[data-edge]").getByRole("button", { name: "Close details", exact: true }).first();
    if (await closeDetails.isVisible()) await closeDetails.click();
  };
  try {
    const manager = await fixture.pair("Activity task manager");
    const tasks: string[] = [];
    for (const displayName of ["Activity task A", "Activity task B"]) tasks.push(sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
      createSessionMutation({ backendId: fixture.adapter().id, targetId: fixture.targetId(), displayName }))));
    await pair(observer, "Activity observer");
    await observer.locator(".theme-picker").getByRole("radio", { name: "Light", exact: true }).click();
    const remoteName = "Remote Web device with a long display name for narrow task notices";
    const remoteId = await pair(remote, remoteName);
    await expect.poll(() => fixture.application.connections.taskActivity.snapshot().activeDevices).toEqual([]);
    await expect.poll(() => observer.locator(".task-activity").count()).toBe(0);
    await openTask(remote, tasks[0]!);
    await observer.getByText(`${remoteName} is viewing tasks on this node`, { exact: true }).waitFor();
    await capture("global-light-wide");

    // This Document uses the same saved credential and SharedWorker owner feed,
    // but owns another independent task-page stream lease.
    const tab = await remoteContext.newPage(); tab.on("pageerror", error => errors.push(error.message));
    await tab.goto(fixture.baseUrl);
    await tab.getByRole("button", { name: "Saved nodes", exact: true }).click();
    await tab.locator(".connection-card .profile-card").filter({ hasText: fixture.baseUrl }).getByRole("button", { name: "Connect", exact: true }).click();
    await tab.locator(".app").waitFor({ timeout: 30_000 }); await openTask(tab, tasks[1]!);
    await expect.poll(() => fixture.application.connections.taskActivity.snapshot().activeDevices.map(device => device.deviceId)).toEqual([remoteId]);
    await remote.close();
    expect(fixture.application.connections.taskActivity.snapshot().activeDevices.map(device => device.deviceId)).toEqual([remoteId]);
    await route(tab, "#/settings/general"); await tab.locator(".theme-picker").waitFor();
    await expect.poll(() => fixture.application.connections.taskActivity.snapshot().activeDevices).toEqual([]);
    await expect.poll(() => observer.locator(".task-activity").count()).toBe(0);
    await openTask(tab, tasks[1]!); await openTask(observer, tasks[0]!);
    const inline = observer.locator(".task-activity--inline");
    await inline.getByText(`${remoteName} is viewing tasks on this node`, { exact: true }).waitFor();
    expect(await observer.locator(".task-activity--floating").count()).toBe(0);
    await observer.setViewportSize({ width: 320, height: 740 });
    await closeNavigationDrawer(observer);
    expect(await observer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture("inline-light-320");
    await inline.getByRole("button", { name: "Collapse active device notice", exact: true }).click();
    await inline.getByRole("button", { name: `Expand active device notice: ${remoteName} is viewing tasks on this node`, exact: true }).waitFor();
    await openTask(observer, tasks[1]!);
    await inline.getByRole("button", { name: "Collapse active device notice", exact: true }).waitFor();
    await openTask(observer, tasks[0]!);
    await inline.getByRole("button", { name: `Expand active device notice: ${remoteName} is viewing tasks on this node`, exact: true }).click();

    await pair(third, "Another active device"); await openTask(third, tasks[0]!);
    await inline.getByRole("button", { name: "Manage devices", exact: true }).click();
    await observer.locator(".device-control-settings").waitFor();
    expect(await observer.evaluate(() => location.hash)).toBe("#/settings/connections");
    await observer.setViewportSize({ width: 1280, height: 960 });
    await route(observer, "#/settings/general");
    await observer.locator(".theme-picker").getByRole("radio", { name: "Dark", exact: true }).click();
    await openTask(observer, tasks[0]!); await observer.setViewportSize({ width: 390, height: 844 });
    await closeNavigationDrawer(observer);
    await capture("inline-dark-390-multiple");
    await route(third, "#/settings/general"); await third.locator(".theme-picker").waitFor();
    await inline.getByRole("button", { name: "Revoke access", exact: true }).click();
    const confirmation = observer.getByRole("alertdialog", { name: "Revoke device access?", exact: true });
    await confirmation.getByText(`Revoke ${remoteName}'s access to this node and disconnect its connections. It will need to pair again to reconnect.`, { exact: true }).waitFor();
    await openTask(third, tasks[1]!);
    await inline.getByRole("button", { name: "Manage devices", exact: true }).waitFor();
    await confirmation.getByRole("button", { name: "Revoke access", exact: true }).click();
    await expect.poll(() => fixture.application.store.getDevice(remoteId).state).toBe("revoked");
    await inline.getByText("Another active device is viewing tasks on this node", { exact: true }).waitFor();
    await capture("original-device-revoked"); expect(errors).toEqual([]);
  } catch (error) { await capture("failure").catch(() => undefined); throw error; }
  finally { await browser.close(); await fixture.close(); }
});
