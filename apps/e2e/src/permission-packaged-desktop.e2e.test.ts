import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { InteractionState, RunState } from "@joko/contracts";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { _electron, type ElectronApplication } from "playwright-core";
import { afterEach, expect, it } from "vitest";

import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

const packagedIt = process.platform === "win32" && process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE?.trim()
  ? it : it.skip;

interface OwnedProcess {
  readonly pid: number;
  readonly executablePath: string;
  readonly startedAt: string;
}

let fixture: OrchestratorE2eFixture | undefined;
let desktop: ElectronApplication | undefined;
let desktopIdentity: OwnedProcess | undefined;
let profileDirectory: string | undefined;

afterEach(async () => {
  try {
    await closeDesktop();
  } finally {
    await fixture?.close();
    fixture = undefined;
    if (profileDirectory !== undefined) {
      const target = resolve(profileDirectory);
      if (dirname(target) !== resolve(tmpdir()) || !target.split(/[\\/]/u).at(-1)?.startsWith("joko-permission-desktop-")) {
        throw new Error("Refusing to remove an unexpected permission Desktop profile.");
      }
      await rm(target, { recursive: true, force: true });
      profileDirectory = undefined;
    }
  }
}, 90_000);

packagedIt("keeps a pending permission owned by the service while Desktop is hidden and reconnects", {
  timeout: 180_000
}, async () => {
  const executablePath = resolve(process.env.JOKO_PACKAGED_DESKTOP_EXECUTABLE!);
  fixture = await OrchestratorE2eFixture.start({ profiles: [PI_LIKE_PROFILE] });
  const manager = await fixture.pair("Permission Desktop manager");
  const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
    createSessionMutation({ backendId: PI_LIKE_PROFILE.id, targetId: fixture.targetId(), displayName: "Permission task" })));
  const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Permission Desktop" });
  if (challenge.challenge === undefined) throw new Error("Desktop pairing returned no challenge.");

  profileDirectory = await mkdtemp(join(tmpdir(), "joko-permission-desktop-"));
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
  const mainPid = await desktop.evaluate(() => process.pid);
  desktopIdentity = await readProcess(mainPid);
  if (desktopIdentity === undefined || resolve(desktopIdentity.executablePath).toLowerCase() !== executablePath.toLowerCase()) {
    throw new Error("Permission Desktop launched an unexpected executable.");
  }
  const userDataPath = await desktop.evaluate(({ app }) => app.getPath("userData"));
  const profileRelative = relative(profileDirectory, userDataPath);
  if (profileRelative.startsWith("..") || isAbsolute(profileRelative)) {
    throw new Error("Permission Desktop did not use its isolated profile.");
  }
  const page = await desktop.firstWindow({ timeout: 60_000 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.locator(".connection-screen").waitFor({ state: "visible", timeout: 30_000 });
  const pairingTab = page.locator(".connection-tabs > button").nth(2);
  const pairingTabBounds = await pairingTab.boundingBox();
  if (pairingTabBounds === null) throw new Error("Desktop pairing tab has no visible bounds.");
  await page.mouse.click(pairingTabBounds.x + pairingTabBounds.width / 2,
    pairingTabBounds.y + pairingTabBounds.height / 2);
  await page.getByLabel("Joko node address").fill(fixture.baseUrl);
  await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
  await page.getByLabel("Device name").fill("Permission Desktop");
  await page.locator("form.pair-form button[type=submit]").click();
  await page.locator(".app").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(`.sidebar [data-session-id="${sessionId}"]`).first().click();
  await page.locator(`.timeline[data-timeline-session-id="${sessionId}"]`)
    .waitFor({ state: "visible", timeout: 30_000 });

  const generation = BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation);
  const accepted = await submit(manager.clients.operation, manager.connectionId,
    sendInputMutation(sessionId, generation, "[permission]"));
  const runId = queueRunIdFrom(accepted);
  const pending = await waitFor(
    () => manager.clients.interaction.listInteractions({ sessionId, runId }),
    (value) => value.interactions.some((item) => item.state === InteractionState.PENDING),
    "packaged Desktop permission interaction"
  );
  const interaction = pending.interactions.find((item) => item.state === InteractionState.PENDING)!;
  await page.getByText("Allow a test write?", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

  const windowId = await desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible()
      && candidate.webContents.getURL().includes("index.html"));
    if (window === undefined) throw new Error("Permission Desktop main window was not found.");
    window.hide();
    return window.id;
  });
  expect(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isVisible(), windowId)).toBe(false);
  const stillPending = await manager.clients.interaction.getInteraction({ interactionId: interaction.interactionId });
  expect(stillPending.interaction?.state).toBe(InteractionState.PENDING);
  expect((await manager.clients.run.getRun({ runId })).run?.state).not.toBe(RunState.SUCCEEDED);
  expect(fixture.adapter().interactionDecisions).toEqual([]);

  await desktop.evaluate(({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id);
    if (window === null || window.isDestroyed()) throw new Error("Permission Desktop main window was retired.");
    window.show();
  }, windowId);
  await page.reload({ waitUntil: "domcontentloaded" });
  await Promise.race([
    page.locator(".app").waitFor({ state: "visible", timeout: 30_000 }),
    page.locator(".connection-screen").waitFor({ state: "visible", timeout: 30_000 })
  ]);
  if (await page.locator(".connection-screen").isVisible()) {
    await page.getByRole("button", { name: "Connect", exact: true }).click({ timeout: 30_000 });
  }
  await page.locator(".app").waitFor({ state: "visible", timeout: 30_000 });
  if (!await page.locator(`.timeline[data-timeline-session-id="${sessionId}"]`).isVisible()) {
    await page.locator(`.sidebar [data-session-id="${sessionId}"]`).first().click();
  }
  await page.getByText("Allow a test write?", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: /Allow once/u }).click();
  await waitFor(() => manager.clients.interaction.getInteraction({ interactionId: interaction.interactionId }),
    (value) => value.interaction?.state === InteractionState.RESOLVED,
    "packaged Desktop resolved permission");
  await waitFor(() => manager.clients.run.getRun({ runId }),
    (value) => value.run?.state === RunState.SUCCEEDED,
    "permission-gated Run completed");
  expect(fixture.adapter().interactionDecisions).toEqual(["allow_once"]);
  await page.locator(`.timeline[data-timeline-session-id="${sessionId}"] .timeline__row`)
    .filter({ hasText: "Reply from fake-pi-like: [permission]" }).first()
    .waitFor({ state: "visible", timeout: 30_000 });
  expect(pageErrors).toEqual([]);
  await closeDesktop();
});

async function closeDesktop(): Promise<void> {
  if (desktopIdentity === undefined) return;
  const original = desktopIdentity;
  const current = await readProcess(original.pid);
  if (current !== undefined && (current.executablePath.toLowerCase() !== original.executablePath.toLowerCase()
    || current.startedAt !== original.startedAt)) {
    throw new Error("Permission Desktop cleanup refused a changed process identity.");
  }
  if (current !== undefined) {
    await desktop?.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); return true; }).catch(() => undefined);
    await waitFor(() => readProcess(original.pid), (candidate) => candidate === undefined,
      "Permission Desktop complete exit", 30_000);
  }
  desktopIdentity = undefined;
  desktop = undefined;
}

async function readProcess(pid: number): Promise<OwnedProcess | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid Permission Desktop PID.");
  const script = `$candidate = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $candidate) { [pscustomobject]@{ pid = $candidate.ProcessId; executablePath = $candidate.ExecutablePath; startedAt = $candidate.CreationDate.ToUniversalTime().ToString('O') } | ConvertTo-Json -Compress }`;
  const output = await new Promise<string>((resolveOutput, rejectOutput) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000 }, (error, stdout) => error ? rejectOutput(error) : resolveOutput(stdout));
  });
  return output.trim() ? JSON.parse(output) as OwnedProcess : undefined;
}
