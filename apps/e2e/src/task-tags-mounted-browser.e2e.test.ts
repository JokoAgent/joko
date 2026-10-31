import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { chromium, type Browser } from "playwright-core";
import { afterEach, expect, it } from "vitest";
import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

const browserPath = process.env["JOKO_BROWSER_EXECUTABLE"]?.trim(), webDirectory = process.env["JOKO_MOUNTED_WEB_DIR"]?.trim();
const mountedIt = browserPath && webDirectory ? it : it.skip;
let fixture: OrchestratorE2eFixture | undefined, browser: Browser | undefined;
afterEach(async () => { await browser?.close(); browser = undefined; await fixture?.close(); fixture = undefined; });

mountedIt("edits and drags tags through the production task page and retains their exact catalog order", { timeout: 90_000 }, async () => {
  fixture = await OrchestratorE2eFixture.start({ webDirectory, profiles: [PI_LIKE_PROFILE] });
  const manager = await fixture.pair("Tag manager");
  const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
    createSessionMutation({ backendId: PI_LIKE_PROFILE.id, targetId: fixture.targetId(), displayName: "Tagged task" })));
  const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Tags Web" });
  if (!challenge.challenge) throw new Error("The tag browser has no pairing challenge.");
  browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1280, height: 960 }, reducedMotion: "reduce" });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(fixture.baseUrl + "/#/tasks/" + encodeURIComponent(sessionId), { waitUntil: "domcontentloaded" });
  await page.locator(".connection-tabs > button").nth(2).click();
  await page.locator("details.device-authorization__manual > summary").click();
  await page.getByLabel("Joko node address").fill(fixture.baseUrl);
  await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
  await page.getByLabel("Device name").fill("Tags Web");
  await page.locator("form.pair-form button[type=submit]").click();
  const open = async () => {
    await page.locator(".session-header-menu > summary").click();
    expect(await page.locator(".session-header-menu .task-tag-menu-swatch").count()).toBe(7);
    await page.locator(".session-header-menu").getByRole("menuitem", { name: /^Manage tags/u }).click();
    await page.locator(".task-tag-modal").waitFor({ state: "visible" });
  };
  await open();
  const original = fixture.application.store.listTaskTags().map(tag => tag.id);
  expect(original.length).toBeGreaterThan(1);
  const rows = page.locator(".task-tag-editor__row");
  const first = await rows.nth(0).getByRole("button", { name: /^Reorder /u }).boundingBox();
  const second = await rows.nth(1).boundingBox();
  if (!first || !second) throw new Error("The original tag handles are not visible.");
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + first.width / 2, second.y + second.height * 0.8, { steps: 8 });
  await page.waitForFunction(() => document.querySelector(".task-tag-editor__row:nth-child(2)")?.classList.contains("task-tag-editor__row--target"));
  await page.mouse.up();
  const reordered = [original[1]!, original[0]!, ...original.slice(2)];
  await waitFor(async () => fixture!.application.store.listTaskTags().map(tag => tag.id), ids => JSON.stringify(ids) === JSON.stringify(reordered), "the reordered tag catalog");
  await page.locator(".task-tag-modal").getByRole("button", { name: "Create tag", exact: true }).click();
  await page.getByRole("textbox", { name: "Tag name", exact: true }).fill("Delivery review");
  await page.getByRole("button", { name: "Teal", exact: true }).click();
  const evidence = process.env["RUNNER_TEMP"] ? resolve(process.env["RUNNER_TEMP"], "joko-web-evidence/task-tags") : undefined;
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const field = page.getByRole("textbox", { name: "Tag name", exact: true });
      await field.focus(); expect(await field.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await page.locator(".task-tag-editor__swatch").count()).toBe(12);
      if (evidence) await page.screenshot({ path: resolve(evidence, "tag-form-" + theme + "-" + width + ".png"), fullPage: true });
    }
  }
  await page.locator(".task-tag-editor__form").getByRole("button", { name: "Save", exact: true }).click();
  await waitFor(async () => fixture!.application.store.listTaskTags(), tags => tags.some(tag => tag.name === "Delivery review" && tag.color === "teal"), "the saved tag");
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.locator(".task-tag-editor__row").filter({ hasText: "Delivery review" }).getByRole("checkbox").click();
  await waitFor(async () => fixture!.application.store.listTaskTagsForSessions([sessionId]), rows => rows[0]?.tags.some(tag => tag.name === "Delivery review") === true, "the task association");
  await page.locator(".task-tag-modal").getByRole("button", { name: "Close", exact: true }).click();
  await open();
  expect(await page.locator(".task-tag-editor__row").evaluateAll(rows => rows.map(row => row.getAttribute("data-tag-id")))).toEqual([...reordered, fixture.application.store.listTaskTags().at(-1)!.id]);
  expect(errors).toEqual([]);
});
