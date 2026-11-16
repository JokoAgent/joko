import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterEach, expect, it } from "vitest";
import { PI_LIKE_PROFILE } from "@joko/testkit";

import { OrchestratorE2eFixture, routeFixtureDiscovery, waitFor } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim()
  && process.env.JOKO_MOUNTED_WEB_DIR?.trim() ? it : it.skip;
const MARKDOWN = "# Attachment document\n\n- First item\n- Second item\n\n| Name | Value |\n| --- | --- |\n| **Alpha** | 42 |\n\n- [x] Complete\n\n```ts\nconst answer: number = 42;\n```\n";
const CODE = 'const answer: number = 42;\nconsole.log("' + "a".repeat(800) + '", answer);';
const PLAIN = "# Literal heading\nPlain text stays plain.";
let fixture: OrchestratorE2eFixture | undefined;
let browser: Browser | undefined;

afterEach(async () => {
  try { await browser?.close(); }
  finally {
    browser = undefined;
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
  }
});

mountedIt("reads Markdown, code and plain attachments from the task and pending tray without editing or sending", { timeout: 120_000 }, async () => {
  fixture = await OrchestratorE2eFixture.start({ webDirectory: process.env.JOKO_MOUNTED_WEB_DIR!, profiles: [{ ...PI_LIKE_PROFILE,
    capabilities: [...PI_LIKE_PROFILE.capabilities, { key: "input.file", supported: true }] }] });
  const manager = await fixture.pair("Text preview manager");
  const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
    createSessionMutation({ backendId: fixture.adapter().id, targetId: fixture.targetId(), displayName: "Text previews" })));
  const { store, artifacts } = fixture.application;
  const session = store.getSession(sessionId).descriptor;
  const blocks: Array<{ kind: "artifact"; blob: ReturnType<typeof store.getArtifact>["blob"]; label: string }> = [];
  for (const [name, type, bytes] of [
    ["document.md", "text/markdown", Buffer.from(MARKDOWN)],
    ["answer.ts", "text/plain", Buffer.from(CODE)],
    ["literal.txt", "text/plain", Buffer.from(PLAIN)],
    ["offline.ts", "text/plain", Buffer.from("export const unavailable = true;")],
    ["oversize.md", "text/markdown", Buffer.alloc(10 * 1024 * 1024 + 1, 65)]
  ] as const) {
    const incoming = await artifacts.ingestBytes(bytes, { fileName: name, mimeType: type, expiresAt: Date.now() + 60_000 });
    const blob = store.getArtifact(incoming.id).blob;
    store.transaction(() => store.adoptSessionArtifact({ blob, sessionId }));
    blocks.push({ kind: "artifact", blob, label: name });
  }
  store.appendEvent({ backendId: session.backendId, targetId: session.targetId, sessionId, generation: session.binding.generation,
    traceId: "text-previews", payload: { type: "message_complete", role: "user", blocks: [{ kind: "text", text: "Read the original attachments." }, ...blocks] } });
  const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Text preview browser" });
  if (challenge.challenge === undefined) throw new Error("Text preview pairing returned no challenge.");
  browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
  await routeFixtureDiscovery(page.context(), fixture.baseUrl);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixture.baseUrl });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  let tickets = 0, failNextTicket = false;
  await page.route("**/joko.v1.ArtifactService/GetBlobDownloadTicket", async route => {
    tickets += 1;
    if (failNextTicket) {
      failNextTicket = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "unavailable", message: "Controlled preview failure." }) });
    } else await route.continue();
  });
  const evidence = process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, "joko-web-evidence", "text-attachment") : undefined;
  const capture = async (name: string) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, name + ".png"), fullPage: false, animations: "disabled", timeout: 5_000 });
  };
  try {
    await page.goto(fixture.baseUrl + "/#/tasks/" + encodeURIComponent(sessionId), { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.locator("details.device-authorization__manual > summary").click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
    await page.getByLabel("Device name").fill("Text preview browser");
    await page.locator("form.pair-form button[type=submit]").click();
    const timeline = page.locator('.timeline[data-timeline-session-id="' + sessionId + '"]');
    await timeline.waitFor({ state: "visible", timeout: 20_000 });
    const closeDetails = page.getByRole("button", { name: "Close details", exact: true });
    if (await closeDetails.isVisible()) await closeDetails.click();
    const preview = (name: string) => timeline.getByRole("button", { name: "Preview: " + name, exact: true });
    const dialog = page.getByRole("dialog");
    const markdown = dialog.locator(".text-attachment-lightbox__markdown");
    await preview("document.md").click();
    await markdown.getByRole("heading", { level: 1, name: "Attachment document" }).waitFor({ state: "visible" });
    expect(await markdown.locator("tbody td strong").textContent()).toBe("Alpha");
    expect(await markdown.locator('input[type="checkbox"]').isChecked()).toBe(true);
    expect(await markdown.locator("pre code span").count()).toBeGreaterThan(0);
    expect(await markdown.locator("pre .tok-keyword").evaluate(element => getComputedStyle(element).color !== getComputedStyle(element.closest("code")!).color)).toBe(true);
    await dialog.getByRole("button", { name: "Copy", exact: true }).click();
    await waitFor(() => page.evaluate(() => navigator.clipboard.readText()), text => text === MARKDOWN, "copying the original Markdown source");
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await capture("wide-light-markdown");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    expect(await preview("document.md").evaluate(element => element === element.ownerDocument.activeElement)).toBe(true);

    await preview("answer.ts").click();
    const content = dialog.locator(".cm-content");
    await content.waitFor({ state: "visible" });
    const source = () => content.locator(".cm-line").allTextContents().then(lines => lines.join("\n"));
    expect(await source()).toBe(CODE);
    expect(await dialog.locator(".cm-lineNumbers").count()).toBe(1);
    await content.focus();
    await page.keyboard.type("must not edit");
    expect(await source()).toBe(CODE);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    expect(await dialog.evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await capture("narrow-dark-code");
    await page.keyboard.press("Escape");
    const closeNavigation = page.getByRole("button", { name: "Close navigation", exact: true });
    if (await closeNavigation.isVisible()) await closeNavigation.click();
    await preview("literal.txt").click();
    expect(await dialog.locator("main > pre").textContent()).toBe(PLAIN);
    expect(await dialog.locator("h1, .cm-editor").count()).toBe(0);
    await page.keyboard.press("Escape");
    const beforeOversize = tickets;
    await preview("oversize.md").click();
    await dialog.getByText("Preview truncated", { exact: true }).waitFor({ state: "visible" });
    expect(tickets).toBe(beforeOversize);
    expect(await dialog.getByRole("button", { name: "Download file", exact: true }).count()).toBe(2);
    await capture("narrow-dark-oversize");
    await page.keyboard.press("Escape");
    failNextTicket = true;
    await preview("offline.ts").click();
    await dialog.getByRole("alert").waitFor({ state: "visible" });
    expect(await dialog.locator(".cm-editor").count()).toBe(0);
    await capture("narrow-dark-error");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByRole("button", { name: /^New task/u }).first().click();
    const composer = page.locator(".composer");
    await composer.locator(".composer-add-menu__trigger").click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: /Attach image or file/u }).click();
    await (await chooser).setFiles([
      { name: "draft.md", mimeType: "text/markdown", buffer: Buffer.from(MARKDOWN) },
      { name: "draft.ts", mimeType: "text/plain", buffer: Buffer.from(CODE) }
    ]);
    const pending = composer.locator(".attachment-list");
    await pending.getByRole("button", { name: "Preview: draft.md", exact: true }).click();
    await markdown.getByRole("heading", { level: 1, name: "Attachment document" }).waitFor({ state: "visible" });
    await capture("narrow-dark-pending-markdown");
    await page.keyboard.press("Escape");
    await pending.getByRole("button", { name: "Preview: draft.ts", exact: true }).click();
    await content.waitFor({ state: "visible" });
    expect(await source()).toBe(CODE);
    await content.focus();
    await page.keyboard.type("must not edit");
    expect(await source()).toBe(CODE);
    await page.keyboard.press("Escape");
    expect(await pending.locator(".attachment-chip").count()).toBe(2);
    expect(store.listSessions({ includeArchived: true })).toHaveLength(1);
    expect(store.listQueueItems({ sessionId })).toHaveLength(0);
    expect(store.getSession(sessionId).descriptor.binding).toEqual(session.binding);
    expect(pageErrors).toEqual([]);
  } catch (error) {
    await capture("failure").catch(() => undefined);
    throw error;
  }
});
