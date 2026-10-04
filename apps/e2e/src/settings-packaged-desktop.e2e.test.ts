import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { PI_LIKE_PROFILE } from "@joko/testkit";
import { create } from "@bufbuild/protobuf";
import { capabilityNames, CreateTargetMutationSchema, OperationMutationSchema, TargetWorkspaceInputSchema,
  WorkspaceKind, WorktreeEligibility } from "@joko/contracts";
import { _electron, type ElectronApplication, type Locator, type Page } from "playwright-core";
import { afterEach, expect, it } from "vitest";

import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

const packagedIt = process.platform === "win32" && process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE?.trim()
  ? it : it.skip;
const instructions = "Keep the packaged window evidence in the task.";
const revisedInstructions = "Use the latest instruction from the other window.";
const streaming = "Toggle streaming fade-in motion";
const navigation = "Toggle question navigation rail";
const webLinks = "Select external web link destination";
const localLinks = "Select local and Workspace HTML destination";

interface OwnedProcess {
  readonly pid: number;
  readonly executablePath: string;
  readonly startedAt: string;
}

let fixture: OrchestratorE2eFixture | undefined;
let desktop: ElectronApplication | undefined;
let desktopIdentity: OwnedProcess | undefined;
let profileDirectory: string | undefined;
const workspaceRequests = new WeakMap<Page, string[]>();

afterEach(async () => {
  try {
    await closeDesktop();
  } finally {
    await fixture?.close();
    fixture = undefined;
    if (profileDirectory !== undefined) {
      const target = resolve(profileDirectory);
      if (dirname(target) !== resolve(tmpdir()) || !target.split(/[\\/]/u).at(-1)?.startsWith("joko-settings-desktop-")) {
        throw new Error("Refusing to remove an unexpected settings Desktop profile.");
      }
      await rm(target, { recursive: true, force: true });
      profileDirectory = undefined;
    }
  }
}, 90_000);

packagedIt("converges conversation settings across real application windows and consumes fresh creation preferences", {
  timeout: 240_000
}, async () => {
  const profile = { ...PI_LIKE_PROFILE, capabilities: [
    ...PI_LIKE_PROFILE.capabilities,
    { key: capabilityNames.workspaceFiles, supported: true as const }
  ] };
  fixture = await OrchestratorE2eFixture.start({ profiles: [profile] });
  const activeFixture = fixture;
  const projectDirectory = join(activeFixture.rootDirectory, "settings-project");
  await mkdir(projectDirectory);
  await writeFile(join(projectDirectory, "README.md"), "# Settings worktree fixture\n");
  await git(projectDirectory, ["init"]);
  await git(projectDirectory, ["config", "user.email", "e2e@joko.invalid"]);
  await git(projectDirectory, ["config", "user.name", "Joko E2E"]);
  await git(projectDirectory, ["add", "README.md"]);
  await git(projectDirectory, ["commit", "-m", "fixture baseline"]);
  const manager = await activeFixture.pair("Settings Desktop manager");
  const project = await submit(manager.clients.operation, manager.connectionId, create(OperationMutationSchema, {
    payload: { case: "createTarget", value: create(CreateTargetMutationSchema, {
      backendId: PI_LIKE_PROFILE.id, displayName: "Settings project",
      workspace: create(TargetWorkspaceInputSchema, {
        kind: WorkspaceKind.USER_PROJECT, serverPath: projectDirectory, createIfMissing: false
      })
    }) }
  }));
  if (project.result?.payload.case !== "target") throw new Error("Settings project creation returned no Target.");
  const targetId = project.result.payload.value.targetId;
  expect(await manager.clients.worktree.probeTargetWorktree({ targetId }))
    .toMatchObject({ targetId, eligibility: WorktreeEligibility.ELIGIBLE });
  const sessionIds: string[] = [];
  for (const displayName of ["Settings window A", "Settings window B"]) {
    sessionIds.push(sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
      createSessionMutation({ backendId: PI_LIKE_PROFILE.id, targetId, displayName }))));
  }
  const challenge = await activeFixture.anonymous.connection.beginPairing({ deviceDisplayName: "Settings Desktop" });
  if (challenge.challenge === undefined) throw new Error("Settings Desktop pairing returned no challenge.");
  const executablePath = resolve(process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE!);
  profileDirectory = await mkdtemp(join(tmpdir(), "joko-settings-desktop-"));
  desktop = await _electron.launch({
    executablePath,
    env: {
      ...process.env,
      JOKO_DESKTOP_MANAGED_ORCHESTRATOR: "0",
      JOKO_DESKTOP_PACKAGED_SMOKE: "1",
      JOKO_DESKTOP_SMOKE_SCOPE: "external",
      JOKO_DESKTOP_SMOKE_USER_DATA: profileDirectory
    },
    timeout: 60_000
  });
  const application = desktop;
  desktopIdentity = await readProcess(await application.evaluate(() => process.pid));
  if (desktopIdentity === undefined || resolve(desktopIdentity.executablePath).toLowerCase() !== executablePath.toLowerCase()) {
    throw new Error("Settings Desktop launched an unexpected executable.");
  }
  const profileRelative = relative(profileDirectory, await application.evaluate(({ app }) => app.getPath("userData")));
  if (profileRelative.startsWith("..") || isAbsolute(profileRelative)) {
    throw new Error("Settings Desktop did not use its isolated profile.");
  }
  const main = await application.firstWindow({ timeout: 60_000 });
  const pageErrors: string[] = [];
  const observe = (page: Page): void => {
    const requests: string[] = [];
    workspaceRequests.set(page, requests);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (path.includes("TargetService") || path.includes("WorktreeService")) requests.push(path + ":" + response.status());
    });
  };
  observe(main);
  await main.locator(".connection-screen").waitFor({ state: "visible", timeout: 30_000 });
  const pairingTabBounds = await main.locator(".connection-tabs > button").nth(2).boundingBox();
  if (pairingTabBounds === null) throw new Error("Settings Desktop pairing tab has no visible bounds.");
  await main.mouse.click(pairingTabBounds.x + pairingTabBounds.width / 2,
    pairingTabBounds.y + pairingTabBounds.height / 2);
  await main.locator("form.pair-form").waitFor({ state: "visible", timeout: 30_000 });
  await main.locator('form.pair-form input[type="url"]').fill(activeFixture.baseUrl);
  await main.locator('form.pair-form input[autocomplete="one-time-code"]')
    .fill(activeFixture.pairingCode(challenge.challenge.challengeId));
  await main.locator('form.pair-form input[autocomplete="off"]').fill("Settings Desktop");
  await main.locator("form.pair-form button[type=submit]").click();
  await main.locator(".app").waitFor({ state: "visible", timeout: 30_000 });
  await main.evaluate(() => { location.hash = "/settings/general"; });
  await main.getByRole("combobox", { name: /^(?:Language|语言)$/u }).click();
  await main.getByRole("option", { name: "English", exact: true }).click();
  await selected(main.getByRole("combobox", { name: "Language", exact: true }), "English");
  console.info("Packaged settings: formal connection ready.");

  const taskPages: Page[] = [];
  for (const sessionId of sessionIds) {
    await main.evaluate((id) => { location.hash = "/tasks/" + encodeURIComponent(id); }, sessionId);
    await main.locator('.timeline[data-timeline-session-id="' + sessionId + '"]')
      .waitFor({ state: "visible", timeout: 30_000 });
    await main.locator('.sidebar [data-session-id="' + sessionId + '"]').first().click({ button: "right" });
    const [page] = await Promise.all([
      application.waitForEvent("window", { timeout: 30_000 }),
      main.getByRole("menuitem", { name: "Open in new window", exact: true }).click()
    ]);
    observe(page);
    await page.locator('.timeline[data-timeline-session-id="' + sessionId + '"]')
      .waitFor({ state: "visible", timeout: 30_000 });
    taskPages.push(page);
  }
  const [first, second] = taskPages;
  if (first === undefined || second === undefined) throw new Error("Settings Desktop did not open both Task windows.");
  expect(new Set(await Promise.all([main, first, second].map(async (page) =>
    (await application.browserWindow(page)).evaluate((window) => window.id)))).size).toBe(3);
  const origins = await Promise.all([main, first, second].map((page) => page.evaluate(() => location.origin)));
  expect(new Set(origins).size).toBe(1);
  console.info("Packaged settings: three application windows ready.");

  // Mounted consumers receive real BroadcastChannel invalidations after IndexedDB commits.
  for (const page of [main, first, second]) await settings(page, "general");
  await main.getByRole("combobox", { name: "Send shortcut", exact: true }).click();
  await main.getByRole("option", { name: "Ctrl/Command+Enter sends", exact: true }).click();
  for (const page of [main, first, second]) await selected(page.getByRole("combobox", { name: "Send shortcut", exact: true }), "Ctrl/Command+Enter sends");
  for (const page of [main, first, second]) await settings(page, "personalization");
  await main.getByLabel("Custom instructions", { exact: true }).fill(instructions);
  await main.locator('[aria-labelledby="personalization-prompt-heading"]')
    .getByRole("button", { name: "Save", exact: true }).click();
  await main.getByLabel(streaming, { exact: true }).uncheck();
  await main.getByLabel(navigation, { exact: true }).uncheck();
  await main.getByRole("radiogroup", { name: webLinks, exact: true })
    .getByRole("radio", { name: "Sidebar Browser", exact: true }).click();
  await main.getByRole("radiogroup", { name: localLinks, exact: true })
    .getByRole("radio", { name: "External Browser", exact: true }).click();
  for (const page of [main, first, second]) await personalized(page, instructions, false, false, "Sidebar Browser", "External Browser");
  console.info("Packaged settings: mounted preference consumers converged.");
  await first.getByLabel("Custom instructions", { exact: true }).fill(revisedInstructions);
  await first.locator('[aria-labelledby="personalization-prompt-heading"]')
    .getByRole("button", { name: "Save", exact: true }).click();
  for (const page of [main, first, second]) await value(page.getByLabel("Custom instructions", { exact: true }), revisedInstructions);

  // The seventh field reaches an already mounted creation page, then the actual service.
  for (const page of [main, second]) await newTask(page, targetId);
  await main.getByRole("checkbox", { name: "Use for this task", exact: true }).check();
  for (const page of [main, second]) await checked(page.getByRole("checkbox", { name: "Use for this task", exact: true }), true);
  const prompt = "Create from the other window with its confirmed preferences.";
  await second.locator(".new-task-page [data-composer-editor='true'] .composer-rich-editor__content").fill(prompt);
  await second.getByRole("button", { name: "Send", exact: true }).click();
  await waitFor(async () => activeFixture.adapter().sendCalls, (calls) => calls.length === 1,
    "packaged fresh creation dispatched", 30_000);
  const sent = activeFixture.adapter().sendCalls[0];
  expect(sent?.text).toBe(prompt);
  const created = activeFixture.application.store.listSessions().find((session) => !sessionIds.includes(session.descriptor.id));
  if (created === undefined) throw new Error("Packaged fresh creation did not persist its Session.");
  expect(created.descriptor.appendSystemPrompt).toBe(revisedInstructions);
  expect(created.descriptor.worktree?.state).toBe("active");
  expect(created.descriptor.worktree?.path).not.toBe(projectDirectory);
  await second.locator('.timeline[data-timeline-session-id="' + created.descriptor.id + '"]')
    .waitFor({ state: "visible", timeout: 30_000 });
  console.info("Packaged settings: fresh task consumed the instruction and real worktree.");

  await settings(main, "personalization");
  await main.reload({ waitUntil: "domcontentloaded" });
  await Promise.race([
    main.locator(".app").waitFor({ state: "visible", timeout: 30_000 }),
    main.locator(".connection-screen").waitFor({ state: "visible", timeout: 30_000 })
  ]);
  if (await main.locator(".connection-screen").isVisible()) {
    await main.getByRole("button", { name: "Connect", exact: true }).click();
  }
  await main.locator(".app").waitFor({ state: "visible", timeout: 30_000 });
  await settings(main, "personalization");
  await personalized(main, revisedInstructions, false, false, "Sidebar Browser", "External Browser");
  expect(activeFixture.adapter().sendCalls).toHaveLength(1);

  // Reverse commits and default restores remove overrides rather than a stale whole-record write.
  for (const page of [main, first, second]) await settings(page, "general");
  const shortcutRow = first.getByLabel("Send shortcut", { exact: true }).locator("xpath=ancestor::div[contains(@class,'setting-row')][1]");
  await shortcutRow.getByRole("button", { name: "Restore default", exact: true }).click();
  for (const page of [main, first, second]) await selected(page.getByRole("combobox", { name: "Send shortcut", exact: true }), "Enter sends");
  for (const page of [main, first, second]) await settings(page, "personalization");
  for (const scope of [
    '[aria-labelledby="personalization-prompt-heading"]',
    ".personalization-stream-card",
    ".personalization-tip-row",
    ".personalization-link-row"
  ]) {
    const buttons = first.locator(scope).getByRole("button", { name: "Restore default", exact: true });
    while (await buttons.count() > 0) {
      const count = await buttons.count();
      await buttons.first().click();
      await waitFor(() => buttons.count(), (remaining) => remaining < count, "packaged default override removed", 30_000);
    }
  }
  for (const page of [main, first, second]) await personalized(page, "", true, true, "System browser", "Sidebar Browser");
  for (const page of [main, second]) await newTask(page, targetId);
  await second.getByRole("checkbox", { name: "Use for this task", exact: true }).uncheck();
  for (const page of [main, second]) await checked(page.getByRole("checkbox", { name: "Use for this task", exact: true }), false);
  const persisted = await main.evaluate(async () => {
    const opened = indexedDB.open("joko-ui");
    const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
      opened.onsuccess = () => resolveDatabase(opened.result);
      opened.onerror = () => reject(opened.error);
    });
    try {
      const request = database.transaction("preferences", "readonly").objectStore("preferences").get("ui");
      return await new Promise<Record<string, unknown>>((resolveValue, reject) => {
        request.onsuccess = () => resolveValue(request.result as Record<string, unknown>);
        request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  });
  for (const key of ["composerSendShortcut", "messageNavRailEnabled", "streamFadeEnabled",
    "webLinkOpenPreference", "localLinkOpenPreference", "newSessionWorktreeEnabled"]) {
    expect(persisted).not.toHaveProperty(key);
  }
  expect(persisted["personalizationPrompts"]).toBeUndefined();
  expect(activeFixture.adapter().sendCalls).toHaveLength(1);
  expect(pageErrors).toEqual([]);
  console.info("Packaged settings: reload and default restores verified.");
  await closeDesktop();
});

async function settings(page: Page, section: "general" | "personalization"): Promise<void> {
  await page.evaluate((next) => { location.hash = "/settings/" + next; }, section);
  await page.locator(".settings-page").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByLabel(section === "general" ? "Send shortcut" : "Custom instructions", { exact: true })
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function newTask(page: Page, targetId: string): Promise<void> {
  await page.evaluate((target) => { location.hash = "/tasks/new?target=" + encodeURIComponent(target); }, targetId);
  await page.locator(".new-task-page").waitFor({ state: "visible", timeout: 30_000 });
  try {
    await page.getByRole("checkbox", { name: "Use for this task", exact: true })
      .waitFor({ state: "visible", timeout: 30_000 });
  } catch (cause) {
    const projection = await page.locator(".new-task-page").evaluate((root) => ({
      route: location.hash,
      worktreePresent: root.querySelector(".new-task-worktree") !== null,
      warnings: [...root.querySelectorAll(".new-task-warning")].map((element) => element.textContent),
      checkboxes: [...root.querySelectorAll('[role="checkbox"]')].map((element) => ({
        label: element.getAttribute("aria-label"), associated: element.closest("label")?.textContent
      })),
      context: root.querySelector(".new-task-context")?.textContent
    }));
    throw new Error("Packaged worktree control did not become available: " + JSON.stringify({
      ...projection, requests: workspaceRequests.get(page)
    }), { cause });
  }
  await waitFor(() => page.getByRole("checkbox", { name: "Use for this task", exact: true }).isEnabled(),
    (enabled) => enabled, "packaged worktree eligibility", 30_000);
}

async function value(locator: Locator, expected: string): Promise<void> {
  await waitFor(() => locator.inputValue(), (actual) => actual === expected, "packaged setting value", 30_000);
}

async function selected(locator: Locator, expected: string): Promise<void> {
  await waitFor(() => locator.innerText(), (actual) => actual.trim() === expected, "packaged selected option", 30_000);
}

async function checked(locator: Locator, expected: boolean): Promise<void> {
  await waitFor(() => locator.isChecked(), (actual) => actual === expected, "packaged setting checked", 30_000);
}

async function personalized(page: Page, prompt: string, fade: boolean, rail: boolean, web: string, local: string): Promise<void> {
  await value(page.getByLabel("Custom instructions", { exact: true }), prompt);
  await checked(page.getByLabel(streaming, { exact: true }), fade);
  await checked(page.getByLabel(navigation, { exact: true }), rail);
  for (const [group, destination] of [[webLinks, web], [localLinks, local]] as const) {
    await waitFor(() => page.getByRole("radiogroup", { name: group, exact: true })
      .getByRole("radio", { name: destination, exact: true }).getAttribute("aria-checked"),
    (actual) => actual === "true", "packaged link destination", 30_000);
  }
}

async function closeDesktop(): Promise<void> {
  if (desktopIdentity === undefined) return;
  const original = desktopIdentity;
  const current = await readProcess(original.pid);
  if (current !== undefined && (current.executablePath.toLowerCase() !== original.executablePath.toLowerCase()
    || current.startedAt !== original.startedAt)) {
    throw new Error("Settings Desktop cleanup refused a changed process identity.");
  }
  if (current !== undefined) {
    await desktop?.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); return true; }).catch(() => undefined);
    await waitFor(() => readProcess(original.pid), (candidate) => candidate === undefined,
      "Settings Desktop complete exit", 30_000);
  }
  desktopIdentity = undefined;
  desktop = undefined;
}

async function readProcess(pid: number): Promise<OwnedProcess | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid Settings Desktop PID.");
  const script = "$candidate = Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid
    + "'; if ($null -ne $candidate) { [pscustomobject]@{ pid = $candidate.ProcessId; executablePath = $candidate.ExecutablePath; startedAt = $candidate.CreationDate.ToUniversalTime().ToString('O') } | ConvertTo-Json -Compress }";
  const output = await new Promise<string>((resolveOutput, rejectOutput) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000 }, (error, stdout) => error ? rejectOutput(error) : resolveOutput(stdout));
  });
  return output.trim() ? JSON.parse(output) as OwnedProcess : undefined;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const environment: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
  for (const key of ["GIT_COMMON_DIR", "GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"]) delete environment[key];
  await new Promise<void>((resolveGit, rejectGit) => {
    execFile("git", [...args], { cwd, env: environment, windowsHide: true, timeout: 15_000 },
      (error) => error ? rejectGit(error) : resolveGit());
  });
}
