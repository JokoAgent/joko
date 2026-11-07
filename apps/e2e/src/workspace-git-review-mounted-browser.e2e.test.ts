import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { chromium, type Browser } from "playwright-core";
import { afterEach, expect, it } from "vitest";
import { OrchestratorE2eFixture } from "./fixture.js";
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

mountedIt("wraps a long staged Review line and keeps word emphasis opt-in", { timeout: 90_000 }, async () => {
  fixture = await OrchestratorE2eFixture.start({ webDirectory, profiles: [{
    ...PI_LIKE_PROFILE, capabilities: [...PI_LIKE_PROFILE.capabilities,
      { key: "workspace.diff", supported: true }, { key: "workspace.diff.sources", supported: true }]
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

  const manager = await fixture.pair("Review manager");
  const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId, createSessionMutation({
    backendId: PI_LIKE_PROFILE.id, targetId: fixture.targetId(), displayName: "Staged Review"
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
});
