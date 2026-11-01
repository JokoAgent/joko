import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { chromium, type Browser } from "playwright-core";
import { afterEach, expect, it } from "vitest";
import { OrchestratorE2eFixture } from "./fixture.js";

const execute = promisify(execFile), browserPath = process.env.JOKO_BROWSER_EXECUTABLE?.trim(), webDirectory = process.env.JOKO_MOUNTED_WEB_DIR?.trim();
const mountedIt = browserPath && webDirectory ? it : it.skip;
let fixture: OrchestratorE2eFixture | undefined, browser: Browser | undefined;
afterEach(async () => { await browser?.close(); browser = undefined; await fixture?.close({ removeRoot: true }); fixture = undefined; });
const git = async (cwd: string, ...args: string[]) => (await execute("git", args, { cwd, windowsHide: true,
  env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" } })).stdout.trim();

mountedIt("updates the selected branch through the production page and recovers its lost admission ACK without a second update", { timeout: 90_000 }, async () => {
  fixture = await OrchestratorE2eFixture.start({ webDirectory, profiles: [PI_LIKE_PROFILE] });
  const projectTarget = fixture.application.store.getTarget(fixture.targetId()).descriptor;
  await fixture.application.sessionHost.registerTarget({ ...projectTarget, managed: false }, { workspaceId: "workspace-main" });
  const repository = fixture.workspaceDirectory, remote = join(fixture.rootDirectory, "branch-remote.git"), publisher = join(fixture.rootDirectory, "branch-publisher");
  await git(repository, "init", "-b", "main"); await git(repository, "config", "user.name", "Branch owner"); await git(repository, "config", "user.email", "branch@example.test");
  await writeFile(join(repository, "tracked.txt"), "initial\n"); await writeFile(join(repository, "other.txt"), "initial local\n");
  await git(repository, "add", "."); await git(repository, "commit", "-m", "initial"); await git(fixture.rootDirectory, "init", "--bare", remote);
  await git(repository, "remote", "add", "origin", remote); await git(repository, "push", "-u", "origin", "main");
  const original = await git(repository, "rev-parse", "HEAD");
  await git(fixture.rootDirectory, "clone", "--branch", "main", remote, publisher); await git(publisher, "config", "user.name", "Publisher"); await git(publisher, "config", "user.email", "publisher@example.test");
  await writeFile(join(publisher, "tracked.txt"), "remote update\n"); await git(publisher, "add", "."); await git(publisher, "commit", "-m", "remote update"); await git(publisher, "push", "origin", "main");
  const next = await git(publisher, "rev-parse", "HEAD"); await writeFile(join(repository, "other.txt"), "preserve owner edits\n");
  const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Branch Web" });
  if (!challenge.challenge) throw new Error("No pairing challenge");
  browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1280, height: 960 }, reducedMotion: "reduce" });
  const errors: string[] = []; let mutations = 0;
  page.on("pageerror", error => errors.push(error.message)); page.on("request", request => { if (new URL(request.url()).pathname.endsWith("/SyncTargetWorktreeBranch")) mutations++; });
  await page.goto(`${fixture.baseUrl}/#/tasks/new?target=${encodeURIComponent(fixture.targetId())}`, { waitUntil: "domcontentloaded" });
  await page.locator(".connection-tabs > button").nth(2).click(); await page.locator("details.device-authorization__manual > summary").click();
  await page.getByLabel("Joko node address").fill(fixture.baseUrl); await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
  await page.getByLabel("Device name").fill("Branch Web"); await page.locator("form.pair-form button[type=submit]").click();
  await page.getByRole("button", { name: "Update selected branch", exact: true }).waitFor({ state: "visible" });
  await page.locator(".new-task-page [contenteditable=true]").first().fill("Continue independently while the source branch updates.");
  await page.waitForFunction(() => document.querySelector<HTMLButtonElement>(".new-task-page .send-button")?.disabled === false);
  expect(await git(repository, "rev-parse", "origin/main")).toBe(original); expect(mutations).toBe(0);
  const evidence = process.env.RUNNER_TEMP ? resolve(process.env.RUNNER_TEMP, "joko-web-evidence/worktree-branch-sync") : undefined;
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const button = page.getByRole("button", { name: "Update selected branch", exact: true });
      await button.focus(); expect(await button.evaluate(value => value === value.ownerDocument.activeElement)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (evidence) await page.screenshot({ path: resolve(evidence, `branch-${theme}-${width}.png`), fullPage: true });
    }
  }
  await page.route("**/joko.v1.WorktreeService/SyncTargetWorktreeBranch", async route => { await route.fetch(); await route.abort("failed"); }, { times: 1 });
  await page.getByRole("button", { name: "Update selected branch", exact: true }).click();
  await page.getByText("The original update is unconfirmed. Inspect the repository and its status before another update.", { exact: true }).waitFor({ state: "visible" });
  expect(await page.locator(".new-task-page .send-button").isEnabled()).toBe(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Saved nodes", exact: true }).click();
  await page.locator(".connection-card .profile-card").filter({ hasText: fixture.baseUrl })
    .getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByText("Updated commits: 1.", { exact: true }).waitFor({ state: "visible" });
  expect(mutations).toBe(1); expect(await git(repository, "rev-parse", "HEAD")).toBe(next);
  expect(await readFile(join(repository, "other.txt"), "utf8")).toBe("preserve owner edits\n");
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("joko.worktree.branch-sync.v1:")).length)).toBe(0);
  expect(errors).toEqual([]);
});
