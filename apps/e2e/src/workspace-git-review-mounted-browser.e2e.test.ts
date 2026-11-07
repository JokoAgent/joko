import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { chromium, type Browser } from "playwright-core";
import { afterEach, expect, it } from "vitest";
import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

const execute = promisify(execFile);
const browserPath = process.env.JOKO_BROWSER_EXECUTABLE?.trim();
const webDirectory = process.env.JOKO_MOUNTED_WEB_DIR?.trim();
const mountedIt = browserPath && webDirectory ? it : it.skip;
let fixture: OrchestratorE2eFixture | undefined;
let browser: Browser | undefined;

afterEach(async () => {
  await browser?.close();
  browser = undefined;
  await fixture?.close({ removeRoot: true });
  fixture = undefined;
});

mountedIt("keeps the Review and Files inspector usable across focus, collapse, reload, and a narrow viewport", { timeout: 120_000 }, async () => {
  fixture = await OrchestratorE2eFixture.start({ webDirectory, profiles: [{
    ...PI_LIKE_PROFILE, capabilities: [...PI_LIKE_PROFILE.capabilities,
      { key: "workspace.diff", supported: true }, { key: "workspace.diff.sources", supported: true },
      { key: "workspace.files", supported: true }]
  }] });
  const root = fixture.workspaceDirectory;
  const git = (...args: string[]) => execute("git", args, { cwd: root, windowsHide: true });
  await git("init", "-b", "main");
  await git("config", "user.name", "Review owner");
  await git("config", "user.email", "review@example.test");
  await git("config", "core.autocrlf", "false");
  const long = "word ".repeat(300);
  await writeFile(join(root, "review.txt"), `${long}old\ncolor = blue\n`);
  await git("add", "--", "review.txt");
  await git("commit", "-m", "Baseline");
  await writeFile(join(root, "review.txt"), `${long}new\ncolor = red\n`);
  await git("add", "--", "review.txt");
  await writeFile(join(root, "restored.txt"), "Original selected file contents");

  const manager = await fixture.pair("Review manager");
  const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId, createSessionMutation({
    backendId: PI_LIKE_PROFILE.id, targetId: fixture.targetId(), displayName: "Staged Review"
  })));
  const otherSessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId, createSessionMutation({
    backendId: PI_LIKE_PROFILE.id, targetId: fixture.targetId(), displayName: "Other Review"
  })));
  const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Review Web" });
  if (!challenge.challenge) throw new Error("Review pairing did not return a challenge.");
  browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1366, height: 960 }, reducedMotion: "reduce" });
  await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
  await page.locator(".connection-tabs > button").nth(2).click();
  await page.locator("details.device-authorization__manual > summary").click();
  await page.getByLabel("Joko node address").fill(fixture.baseUrl);
  await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
  await page.getByLabel("Device name").fill("Review Web");
  await page.locator("form.pair-form button[type=submit]").click();

  await page.getByRole("button", { name: "Add tab", exact: true }).click();
  await page.getByRole("menuitem", { name: "Changes", exact: true }).click();
  await page.getByRole("combobox", { name: "Review source", exact: true }).click();
  await page.getByRole("option", { name: "Staged changes", exact: true }).click();
  const added = page.locator(".review-diff-line--added").filter({ hasText: "word word word" });
  await added.waitFor({ state: "visible" });
  const metrics = () => added.evaluate(row => {
    const code = row.querySelector("code")!;
    const table = row.closest(".review-diff-table")!;
    return { lineHeight: Number.parseFloat(getComputedStyle(code).lineHeight),
      height: code.getBoundingClientRect().height, overflow: table.scrollWidth - table.clientWidth };
  });
  const wordDiff = page.getByRole("button", { name: "Word diff", exact: true });
  expect(await wordDiff.getAttribute("aria-pressed")).toBe("false");
  expect(await page.locator(".inline-word-change").count()).toBe(0);
  const before = await metrics();
  expect(before.height).toBeLessThanOrEqual(before.lineHeight + 1);
  expect(before.overflow).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Wrap", exact: true }).click();
  const after = await metrics();
  expect(after.height).toBeGreaterThan(after.lineHeight);
  expect(after.overflow).toBeLessThanOrEqual(1);
  expect(await added.locator("code").textContent()).toBe(`${long}new`);

  await wordDiff.click();
  expect(await wordDiff.getAttribute("aria-pressed")).toBe("true");
  await page.locator(".inline-word-change").first().waitFor({ state: "visible" });

  await page.setViewportSize({ width: 1280, height: 960 });
  const dock = page.locator('.inspector-dock-group[data-edge="right"]');
  const addTab = dock.getByRole("button", { name: "Add tab", exact: true });
  await addTab.press("Enter");
  const addMenu = dock.getByRole("menu");
  await addMenu.waitFor({ state: "visible" });
  expect(await addMenu.evaluate(node => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await addMenu.waitFor({ state: "hidden" });
  expect(await addTab.evaluate(node => node === document.activeElement)).toBe(true);

  await addTab.click();
  await addMenu.getByRole("menuitem", { name: "Files", exact: true }).click();
  const files = dock.getByRole("tab", { name: "Files", exact: true });
  const filePanel = dock.getByRole("tabpanel", { name: "Files", exact: true });
  const closeDetails = dock.getByRole("button", { name: "Close details", exact: true });
  const openDetails = page.getByRole("button", { name: "Open details", exact: true });
  await filePanel.waitFor({ state: "visible" });
  const fileRow = filePanel.getByRole("treeitem", { name: "restored.txt", exact: true });
  const fileContents = filePanel.locator(".file-preview-card").getByText("Original selected file contents", { exact: true });
  await fileRow.getByRole("button").click();
  await fileContents.waitFor({ state: "visible" });
  await closeDetails.press("Enter");
  await dock.waitFor({ state: "hidden" });
  await openDetails.click();
  await fileContents.waitFor({ state: "visible" });
  await dock.getByRole("tab", { name: "Changes", exact: true }).waitFor({ state: "visible" });

  const openTask = async (id: string): Promise<void> => {
    await page.evaluate(hash => { location.hash = hash; }, `#/tasks/${encodeURIComponent(id)}`);
    await page.locator(`.timeline[data-timeline-session-id="${id}"]`).waitFor({ state: "visible" });
  };
  await openTask(otherSessionId);
  await addTab.click();
  await addMenu.getByRole("menuitem", { name: "Files", exact: true }).click();
  expect(await fileRow.getAttribute("aria-selected")).toBe("false");
  expect(await fileContents.count()).toBe(0);
  await openTask(sessionId);
  await fileContents.waitFor({ state: "visible" });
  const persisted = () => page.evaluate(id => {
    const buckets = JSON.parse(localStorage.getItem("joko.session.inspectorTabs.v1") ?? "{}");
    return buckets[id];
  }, sessionId);
  expect(await persisted()).toMatchObject({ activeTabId: "files", fileSelection: { path: "restored.txt" } });

  await page.reload({ waitUntil: "domcontentloaded" });
  await files.waitFor({ state: "visible" });
  await filePanel.waitFor({ state: "visible" });
  try { await fileContents.waitFor({ state: "visible" }); }
  catch (cause) {
    const observation = { persisted: await persisted(), selected: await fileRow.getAttribute("aria-selected"),
      preview: await filePanel.locator(".file-preview-card").textContent() };
    throw new Error(`The saved file was not read after reload: ${JSON.stringify(observation)}`, { cause });
  }
  expect(await files.getAttribute("aria-selected")).toBe("true");
  await closeDetails.click();
  await page.setViewportSize({ width: 900, height: 760 });
  const navigation = page.locator(".sidebar.is-open");
  if (await navigation.count() > 0) await navigation.getByRole("button", { name: "Close navigation", exact: true }).click();
  await openDetails.click();
  await filePanel.waitFor({ state: "visible" });
  await waitFor(() => dock.evaluate(node => {
    const panel = node.getBoundingClientRect();
    const main = document.querySelector(".app__main")?.getBoundingClientRect();
    const hit = document.elementFromPoint(panel.left + panel.width / 2, panel.top + panel.height / 2);
    return panel.width > 0 && panel.height > 0 && panel.left >= 0 && panel.top >= 0
      && panel.right <= innerWidth && panel.bottom <= innerHeight
      && main !== undefined && Math.abs(main.right - panel.left) <= 1 && node.contains(hit);
  }), visible => visible, "the attached inspector and task side by side within the 900px viewport");
});
