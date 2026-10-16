import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { capabilityNames, RunState } from "@joko/contracts";
import type { AdapterContext, PromptInput, SessionTree } from "@joko/core";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { parseAndroidUiNodes, type AndroidUiNode } from "@joko/tool-android";
import { afterEach, expect, it } from "vitest";

import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

const evidenceSteps = {
  "validate-emulator": { action: "validation", assertions: ["owned-avd-name", "emulator-property", "boot-completed"] },
  "validate-apk": { action: "validation", assertions: ["android-manifest", "clean-manifest-source", "application-package", "apk-manifest-sha256"] },
  "install-apk": { action: "installation", assertions: ["fresh-application-data", "installed-apk-sha256"] },
  "prepare-fixture": { action: "fixture-setup", assertions: ["local-orchestrator-ready", "fixture-task-created", "port-reverse-ready"] },
  "pair-application": { action: "pairing", assertions: ["application-started", "pairing-request-issued"] },
  "open-task-header": { action: "navigation", assertions: ["task-title-visible", "title-width", "header-actions-within-viewport"] },
  "task-actions-menu": { action: "menu", assertions: ["complete-task-actions", "actions-within-viewport"] },
  "send-native-input": { action: "text-entry", assertions: ["one-completed-run", "exact-fixture-dispatch", "one-active-mobile-connection", "persisted-timeline", "owner-generation-consistent"] },
  "open-image-gallery": { action: "resource-navigation", assertions: ["gallery-visible", "image-decoded", "gallery-retained-across-observations"] },
  "zoom-image-gallery": { action: "gesture", assertions: ["double-tap-zoom", "zoomed-tap-keeps-gallery-open"] },
  "short-image-drag": { action: "gesture", assertions: ["zoom-reset", "short-drag-keeps-gallery-open"] },
  "tap-dismiss-image": { action: "gesture", assertions: ["tap-restores-task", "reopened-image-decoded"] },
  "vertical-dismiss-image": { action: "gesture", assertions: ["gesture-canvas-sized", "vertical-dismiss-restores-task"] },
  "close-image-gallery": { action: "resource-navigation", assertions: ["reopened-image-decoded", "close-restores-task"] },
  "open-canonical-file": { action: "resource-navigation", assertions: ["canonical-file-contents", "canonical-line-focus"] },
  "copy-file-source": { action: "clipboard", assertions: ["copy-source-completed"] },
  "force-stop-and-reconnect": { action: "lifecycle", assertions: ["application-process-stopped", "application-restarted", "restored-task-title", "persisted-task-input"] },
  "restore-canonical-file": { action: "lifecycle", assertions: ["restored-file-contents", "no-duplicate-dispatch", "one-persisted-run", "one-mobile-connection", "no-application-crash", "run-succeeded"] }
} as const;
type EvidenceStepName = keyof typeof evidenceSteps;
type EvidenceAction = "tap" | "text-entry" | "launch" | "double-tap" | "swipe" | "force-stop" | "install";
type EvidenceScreenshot = "header" | "actions" | "timeline" | "gallery" | "gallery-zoomed" | "gallery-drag-reset"
  | "gallery-dismissed" | "resource-links" | "file-opened" | "file" | "restored"
  | "gallery-error" | "restored-error" | "file-error" | "resource-candidate" | "resource-error";
type EvidenceResult = "running" | "passed" | "failed";
type EvidenceStep = {
  name: EvidenceStepName;
  action: string;
  startedAfterMs: number;
  elapsedMs: number;
  result: EvidenceResult;
  assertions: { name: string; passed: true }[];
  actions: { type: EvidenceAction; startedAfterMs: number; elapsedMs: number; result: EvidenceResult }[];
  screenshots: { file: string; sha256: string; capturedAfterMs: number }[];
};
type AndroidEvidence = {
  schemaVersion: 1;
  platform: "android";
  scope: "native-pairing-input-canonical-resources-and-process-reopen";
  backend: "local-instrumented-orchestrator-fixture";
  result: EvidenceResult;
  scenarioResult: EvidenceResult;
  cleanupResult: EvidenceResult;
  elapsedMs: number;
  target?: { serial: string; avd: string };
  artifact?: {
    kind: "apk"; package: string; sha256: string; manifestSha256: string;
    source: { commit: string; tree: "clean"; productionGate: "passed" | "bypassed" | "unavailable" };
    installedSha256?: string;
  };
  steps: EvidenceStep[];
};

const serial = process.env.JOKO_ANDROID_TEST_SERIAL?.trim();
const avd = process.env.JOKO_ANDROID_TEST_AVD?.trim();
const adbExecutable = process.env.JOKO_ANDROID_ADB?.trim();
const apkPath = process.env.JOKO_ANDROID_TEST_APK?.trim();
const nativeIt = serial && avd && adbExecutable && apkPath ? it : it.skip;
const packageName = "app.joko.mobile";
const prompt = "Show the workspace resources";
const taskName = "Android resource task";
const answer = "![Workspace image](images/pixel.png)\n\n`README.md:2:4`";

class AndroidResourceAdapter extends InstrumentedFakeAdapter {
  readonly #trees = new Map<string, SessionTree>();

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.sendCalls.push(input);
    const userId = "resource-user-" + this.sendCalls.length;
    const answerId = "resource-answer-" + this.sendCalls.length;
    await context.emit({ type: "message_complete", role: "user", blocks: [{ kind: "text", text: input.text }],
      nativeHistory: { identity: { entryId: userId } } });
    await context.emit({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: answer }],
      nativeHistory: { identity: { entryId: answerId, parentEntryId: userId } } });
    this.#trees.set(context.sessionId, { roots: [{ entryId: userId, kind: "message", role: "user", label: input.text,
      timestamp: 1, children: [{ entryId: answerId, parentId: userId, kind: "message", role: "assistant",
        label: "Workspace resources", timestamp: 2, children: [] }] }], leafId: answerId });
    await context.emit({ type: "done", outcome: "completed" });
  }

  override async getTree(context: AdapterContext): Promise<SessionTree> {
    return this.#trees.get(context.sessionId) ?? super.getTree(context);
  }
}

let fixture: OrchestratorE2eFixture | undefined;
let ownedAvd = false;
let reversedPort: string | undefined;
let evidence: AndroidEvidence | undefined;
let evidenceStarted = 0;
let activeStep: EvidenceStep | undefined;

afterEach(async () => {
  let cleanupPassed = false;
  try {
    try {
      if (ownedAvd) {
        await adb("shell", "am", "force-stop", packageName);
        expect((await adb("shell", "pm", "clear", packageName)).trim()).toBe("Success");
        if (reversedPort !== undefined) await adb("reverse", "--remove", reversedPort);
      }
    } finally {
      ownedAvd = false;
      reversedPort = undefined;
      await fixture?.close();
      fixture = undefined;
    }
    cleanupPassed = true;
  } finally {
    if (evidence !== undefined) {
      evidence.cleanupResult = cleanupPassed ? "passed" : "failed";
      evidence.result = cleanupPassed && evidence.scenarioResult === "passed" ? "passed" : "failed";
      await persistEvidence();
      evidence = undefined;
      activeStep = undefined;
    }
  }
}, 90_000);

nativeIt("pairs, sends through native rich input, opens canonical resources, and resumes without resending", {
  timeout: 360_000
}, async () => {
  if (!serial || !/^emulator-\d+$/u.test(serial) || !avd?.startsWith("joko-")
    || !adbExecutable || !isAbsolute(adbExecutable) || !apkPath || !isAbsolute(apkPath)) {
    throw new Error("Native Android evidence requires an explicit isolated Joko AVD and absolute tool/artifact paths.");
  }
  evidenceStarted = performance.now();
  evidence = { schemaVersion: 1, platform: "android", scope: "native-pairing-input-canonical-resources-and-process-reopen",
    backend: "local-instrumented-orchestrator-fixture", result: "running", scenarioResult: "running",
    cleanupResult: "running", elapsedMs: 0, steps: [] };
  await persistEvidence();
  try {
    await runNativeScenario();
    evidence.scenarioResult = "passed";
  } catch (error) {
    evidence.scenarioResult = "failed";
    if (activeStep !== undefined) {
      activeStep.result = "failed";
      activeStep.elapsedMs = elapsed() - activeStep.startedAfterMs;
    }
    throw error;
  } finally { await persistEvidence(); }
});

async function runNativeScenario(): Promise<void> {
  await beginStep("validate-emulator");
  const actualAvd = (await adb("emu", "avd", "name")).split(/\r?\n/u)[0]?.trim();
  expect(actualAvd).toBe(avd);
  expect((await adb("shell", "getprop", "ro.kernel.qemu")).trim()).toBe("1");
  expect((await adb("shell", "getprop", "sys.boot_completed")).trim()).toBe("1");
  ownedAvd = true;
  evidence!.target = { serial: serial!, avd: actualAvd! };
  await completeStep();

  await beginStep("validate-apk");
  const apk = resolve(apkPath!);
  const manifestPath = join(dirname(apk), "joko-mobile-artifact.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    platform: string; source: { commit: string; tree: string; productionGate?: string };
    application: { package: string }; artifacts: { kind: string; fileName: string; sha256: string }[];
  };
  expect(manifest.platform).toBe("android");
  expect(manifest.source.tree).toBe("clean");
  expect(manifest.application.package).toBe(packageName);
  const artifact = manifest.artifacts.find((entry) => entry.kind === "apk" && entry.fileName === basename(apk));
  if (artifact === undefined) throw new Error("The APK is absent from its native artifact manifest.");
  expect(await digest(apk)).toBe(artifact.sha256);
  evidence!.artifact = { kind: "apk", package: packageName, sha256: artifact.sha256,
    manifestSha256: await digest(manifestPath), source: {
      commit: /^[0-9a-f]{40}$/u.test(manifest.source.commit) ? manifest.source.commit : "unavailable",
      tree: "clean", productionGate: manifest.source.productionGate === "passed" || manifest.source.productionGate === "bypassed"
        ? manifest.source.productionGate : "unavailable"
    } };
  await completeStep();
  await beginStep("install-apk");
  const installedPackages = (await adb("shell", "pm", "list", "packages", packageName)).trim().split(/\r?\n/u);
  if (installedPackages.includes("package:" + packageName)) expect((await adb("uninstall", packageName)).trim()).toBe("Success");
  await interaction("install", () => adb("install", "-r", "--no-streaming", apk));
  expect((await adb("shell", "pm", "clear", packageName)).trim()).toBe("Success");
  const installedPath = (await adb("shell", "pm", "path", packageName)).trim().replace(/^package:/u, "");
  if (!/^\/data\/app\/[^\s]+\/base\.apk$/u.test(installedPath)) throw new Error("Unexpected installed Android artifact path.");
  const installedSha256 = (await adb("shell", "sha256sum", installedPath)).split(/\s/u)[0];
  expect(installedSha256).toBe(artifact.sha256);
  evidence!.artifact!.installedSha256 = installedSha256!;
  await adb("logcat", "-c");
  await completeStep();

  await beginStep("prepare-fixture");
  const profile = { ...PI_LIKE_PROFILE, capabilities: [
    ...PI_LIKE_PROFILE.capabilities,
    { key: capabilityNames.workspaceFiles, supported: true as const }
  ] };
  fixture = await OrchestratorE2eFixture.start({ profiles: [profile], createAdapter: (entry) => new AndroidResourceAdapter(entry) });
  const current = fixture;
  await mkdir(join(current.workspaceDirectory, "images"));
  await writeFile(join(current.workspaceDirectory, "images", "pixel.png"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await writeFile(join(current.workspaceDirectory, "README.md"), "first\nfocus line\nlast\n");
  const manager = await current.pair("Android fixture manager");
  const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
    createSessionMutation({ backendId: profile.id, targetId: current.targetId(profile.id), displayName: taskName })));
  reversedPort = "tcp:" + new URL(current.baseUrl).port;
  await adb("reverse", reversedPort, reversedPort);
  await completeStep();

  await beginStep("pair-application");
  let mobileChallengeId: string | undefined;
  const removeListener = current.application.connections.onPairingIssued((challenge) => { mobileChallengeId = challenge.id; });
  try {
    await launch();
    await tap("Add");
    await fill("Joko node address", current.baseUrl);
    await tap("Check node identity");
    await tap("Request pairing", true);
    await waitFor(async () => mobileChallengeId, (value) => value !== undefined, "native pairing request");
    await fill("Pairing code", current.pairingCode(mobileChallengeId!), true);
    await tap("Pair this device", true);
  } finally { removeListener(); }
  await completeStep();

  await beginStep("open-task-header");
  await tap("Open task " + taskName);
  const screen = (await adb("shell", "wm", "size")).match(/(?:Physical|Override) size: (\d+)x(\d+)/gu)?.at(-1)
    ?.match(/(\d+)x(\d+)/u);
  if (!screen) throw new Error("The isolated native viewport was unavailable.");
  const screenWidth = Number(screen[1]);
  const title = await waitNode((node) => node.text === taskName, "visible native task title");
  expect(title.bounds.x2 - title.bounds.x1).toBeGreaterThan(screenWidth / 2);
  for (const label of ["Back to Tasks", "Task actions"]) {
    const button = await waitNode((node) => node.contentDescription === label, label);
    expect(button.bounds.x1).toBeGreaterThanOrEqual(0);
    expect(button.bounds.x2).toBeLessThanOrEqual(screenWidth);
  }
  await screenshot("header");
  await completeStep();
  await beginStep("task-actions-menu");
  await tap("Task actions");
  const requiredActions = ["Branches", "Controls", "Copy task link", "Files", "Refresh"];
  const actionNodes = await waitFor(nodes, (items) => requiredActions.every((label) => items.some((node) => node.contentDescription === label))
    && items.some((node) => node.contentDescription?.startsWith("Context") === true), "the complete native task actions", 25_000);
  await screenshot("actions");
  for (const label of requiredActions) {
    const item = actionNodes.find((node) => node.contentDescription === label)!;
    expect(item.bounds.x1).toBeGreaterThanOrEqual(0);
    expect(item.bounds.x2).toBeLessThanOrEqual(screenWidth);
  }
  await tap("Cancel");
  await completeStep();
  await beginStep("send-native-input");
  await fill("Task message", prompt);
  await tap("Send");
  await waitFor(async () => current.application.store.listRuns({ sessionId }),
    (runs) => runs.length === 1 && runs[0]?.descriptor.state === "completed", "native task completion", 30_000);
  expect(current.adapter(profile.id).sendCalls.map((input) => input.text)).toEqual([prompt]);
  const mobileDevices = current.application.store.listDevices().filter((device) => device.kind === "mobile");
  expect(mobileDevices).toHaveLength(1);
  const mobileConnections = current.application.store.listConnections().filter((connection) => connection.deviceId === mobileDevices[0]!.id);
  expect(mobileConnections).toHaveLength(1);
  expect(mobileConnections[0]?.state).toBe("active");
  const history = await manager.clients.session.listSessionTimeline({ sessionId, limit: 120 });
  expect(history.events.some((event) => event.payload?.kind.case === "messageCompleted"
    && event.payload.kind.value.blocks.some((block) => block.content.case === "text" && block.content.value === answer))).toBe(true);
  const owner = (await manager.clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).snapshot!;
  const detail = (await manager.clients.event.getSnapshot({ scope: { kind: { case: "session",
    value: { sessionId, recentTimelineItems: 120 } } } })).snapshot!;
  expect(detail.generation).toBe(owner.generation);
  expect(detail.sessions[0]?.nativeBinding?.runtimeGeneration)
    .toBe(owner.sessions.find((session) => session.sessionId === sessionId)?.nativeBinding?.runtimeGeneration);
  expect(detail.timeline.some((event) => event.payload?.kind.case === "messageCompleted"
    && event.payload.kind.value.blocks.some((block) => block.content.case === "text" && block.content.value === answer))).toBe(true);

  await screenshot("timeline");
  await completeStep();
  await beginStep("open-image-gallery");
  await tap("Workspace image", true);
  await waitNode((node) => node.text === "pixel.png" || node.contentDescription?.includes("pixel.png") === true, "native image gallery");
  await waitNode((node) => node.contentDescription === "Copy image" && node.enabled, "native gallery decode readiness");
  const galleryOpenedAt = Date.now();
  await waitFor(nodes, (items) => Date.now() - galleryOpenedAt >= 13_000
    && items.some((node) => node.text === "pixel.png")
    && items.some((node) => node.contentDescription === "Copy image" && node.enabled),
  "native gallery retained across scheduled observations", 22_000);
  await screenshot("gallery");
  await completeStep();
  await beginStep("zoom-image-gallery");
  const densityMatch = (await adb("shell", "wm", "density")).match(/(?:Physical|Override) density: (\d+)/gu)?.at(-1)?.match(/(\d+)/u);
  if (!densityMatch) throw new Error("The isolated native display density was unavailable.");
  const pixelsPerPoint = Number(densityMatch[1]) / 160;
  const canvas = await waitNode((node) => node.contentDescription === "Image preview pixel.png", "native gallery gesture canvas");
  const x = Math.round((canvas.bounds.x1 + canvas.bounds.x2) / 2);
  const y = Math.round((canvas.bounds.y1 + canvas.bounds.y2) / 2);
  await interaction("double-tap", () => adb("shell", `input tap ${x} ${y}; input tap ${x} ${y}`));
  await waitNode((node) => node.text?.includes("2.5") === true, "native double-tap zoom");
  await interaction("tap", () => adb("shell", "input", "tap", String(x), String(y)));
  const zoomTapAt = Date.now();
  await waitFor(nodes, (items) => Date.now() - zoomTapAt >= 400
    && items.some((node) => node.text?.includes("2.5") === true)
    && items.some((node) => node.contentDescription === "Copy image" && node.enabled), "zoomed tap keeps the gallery open", 5_000);
  await screenshot("gallery-zoomed");
  await completeStep();
  await beginStep("short-image-drag");
  await tap("Reset");
  await waitNode((node) => node.text?.includes("1.0") === true, "native gallery zoom reset");
  await interaction("swipe", () => adb("shell", "input", "swipe", String(x), String(y), String(x), String(y + Math.round(90 * pixelsPerPoint)), "900"));
  const shortDragAt = Date.now();
  await waitFor(nodes, (items) => Date.now() - shortDragAt >= 1_000
    && items.some((node) => node.contentDescription === "Copy image" && node.enabled), "short native vertical drag returns to the gallery", 5_000);
  await screenshot("gallery-drag-reset");
  await completeStep();
  await beginStep("tap-dismiss-image");
  await interaction("tap", () => adb("shell", "input", "tap", String(x), String(y)));
  await waitNode((node) => node.text === taskName, "task restored after a native gallery tap");
  await tap("Workspace image", true);
  await waitNode((node) => node.contentDescription === "Copy image" && node.enabled, "reopened native gallery decode readiness");
  await completeStep();
  await beginStep("vertical-dismiss-image");
  const verticalCanvas = await waitNode((node) => node.contentDescription === "Image preview pixel.png", "reopened native gesture canvas");
  const distance = Math.round(160 * pixelsPerPoint);
  expect(verticalCanvas.bounds.y2 - verticalCanvas.bounds.y1).toBeGreaterThan(distance + 20);
  const startY = Math.round(Math.min((verticalCanvas.bounds.y1 + verticalCanvas.bounds.y2) / 2, verticalCanvas.bounds.y2 - distance - 10));
  await interaction("swipe", () => adb("shell", "input", "swipe", String(x), String(startY), String(x), String(startY + distance), "600"));
  await waitNode((node) => node.text === taskName, "task restored after a native vertical dismissal");
  await screenshot("gallery-dismissed");
  await completeStep();
  await beginStep("close-image-gallery");
  await tap("Workspace image", true);
  await waitNode((node) => node.contentDescription === "Copy image" && node.enabled, "gallery restored before explicit native close");
  await tap("Close");
  await waitNode((node) => node.text === taskName, "task restored after closing the gallery");
  await screenshot("resource-links");
  await completeStep();
  await beginStep("open-canonical-file");
  await tap("README.md:2:4", true, true);
  await waitNode((node) => node.text?.includes("focus line") === true, "canonical file contents");
  await screenshot("file-opened");
  await waitNode((node) => node.text === "Line 2" || node.contentDescription === "Line 2", "canonical file line focus");
  await completeStep();
  await beginStep("copy-file-source");
  await tap("Source");
  await tap("Copy source");
  await waitNode((node) => node.text === "Copied.", "native file source copy completion");
  await screenshot("file");
  await completeStep();

  await beginStep("force-stop-and-reconnect");
  await interaction("force-stop", () => adb("shell", "am", "force-stop", packageName));
  expect((await adb("shell", "pidof", packageName)).trim()).toBe("");
  await launch();
  await tap("Saved (1)");
  await tap("Connect", true);
  await tap("Open task " + taskName);
  await waitNode((node) => node.text === taskName, "restored native task title");
  await scrollToNode((node) => node.text?.includes(prompt) === true, "persisted native task input");
  await completeStep();
  await beginStep("restore-canonical-file");
  await tap("README.md:2:4", true, true);
  await waitNode((node) => node.text?.includes("focus line") === true, "restored canonical file contents");
  await screenshot("restored");
  expect(current.adapter(profile.id).sendCalls).toHaveLength(1);
  expect(current.application.store.listRuns({ sessionId })).toHaveLength(1);
  expect(current.application.store.listConnections().filter((connection) => connection.deviceId === mobileDevices[0]!.id)).toHaveLength(1);
  expect(await adb("logcat", "-b", "crash", "-d", "-v", "brief")).not.toMatch(/app\.joko\.mobile|ReactNativeJS|Hermes/u);
  const run = current.application.store.listRuns({ sessionId })[0]!;
  expect((await manager.clients.run.getRun({ runId: run.descriptor.id })).run?.state).toBe(RunState.SUCCEEDED);
  await completeStep();
}

function elapsed(): number { return Math.round(performance.now() - evidenceStarted); }

async function persistEvidence(): Promise<void> {
  if (evidence === undefined) return;
  evidence.elapsedMs = elapsed();
  const directory = join(dirname(apkPath!), "ui-evidence");
  await mkdir(directory, { recursive: true });
  const target = join(directory, "android-operations.json");
  await writeFile(target + ".tmp", JSON.stringify(evidence, null, 2) + "\n");
  await rename(target + ".tmp", target);
}

async function beginStep(name: EvidenceStepName): Promise<void> {
  const definition = evidenceSteps[name];
  activeStep = { name, action: definition.action, startedAfterMs: elapsed(), elapsedMs: 0,
    result: "running", assertions: [], actions: [], screenshots: [] };
  evidence!.steps.push(activeStep);
  await persistEvidence();
}

async function completeStep(): Promise<void> {
  activeStep!.result = "passed";
  activeStep!.elapsedMs = elapsed() - activeStep!.startedAfterMs;
  activeStep!.assertions = evidenceSteps[activeStep!.name].assertions.map(name => ({ name, passed: true }));
  await persistEvidence();
  activeStep = undefined;
}

async function interaction<T>(type: EvidenceAction, operation: () => Promise<T>): Promise<T> {
  const action: EvidenceStep["actions"][number] = { type, startedAfterMs: elapsed(), elapsedMs: 0, result: "running" };
  activeStep?.actions.push(action);
  await persistEvidence();
  try {
    const result = await operation();
    action.result = "passed";
    return result;
  } catch (error) {
    action.result = "failed";
    throw error;
  } finally {
    action.elapsedMs = elapsed() - action.startedAfterMs;
    await persistEvidence();
  }
}

async function adb(...args: string[]): Promise<string> {
  return new Promise((accept, reject) => {
    execFile(adbExecutable!, ["-s", serial!, ...args], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        // Do not include command arguments or output: pairing input is a transient credential.
        if (error && !(args[0] === "shell" && args[1] === "pidof" && error.code === 1)) {
          reject(new Error("The isolated Android fixture command failed."));
        } else accept(stdout);
      });
  });
}

async function nodes(): Promise<readonly AndroidUiNode[]> {
  const output = await adb("exec-out", "uiautomator", "dump", "/dev/tty");
  const parsed = parseAndroidUiNodes(output);
  if (parsed.truncated) throw new Error("The native Android hierarchy exceeded its bounded node budget.");
  return parsed.nodes.filter((node) => node.packageName === packageName);
}

async function waitNode(predicate: (node: AndroidUiNode) => boolean, label: string): Promise<AndroidUiNode> {
  const found = await waitFor(async () => (await nodes()).find(predicate), (node) => node !== undefined, label, 25_000).catch(async (error) => {
    if (label === "native gallery decode readiness" || label === "canonical file contents" || label === "canonical file line focus" || label === "native file source copy completion" || label === "restored canonical file contents"
      || label === "restored native task title" || label === "persisted native task input") {
      await screenshot(label === "native gallery decode readiness" ? "gallery-error" : label.startsWith("restored")
        || label === "persisted native task input" ? "restored-error" : "file-error");
      const observed = (await nodes()).map((node) => ({ text: node.text?.slice(0, 240),
        label: node.contentDescription?.slice(0, 240), enabled: node.enabled, bounds: node.bounds })).slice(0, 80);
      throw new Error("Native resource surface unavailable: " + label + ". Fixture resource nodes: " + JSON.stringify(observed));
    }
    throw error;
  });
  if (!found) throw new Error("The expected native Android surface was unavailable: " + label);
  return found;
}

async function scrollToNode(predicate: (node: AndroidUiNode) => boolean, label: string): Promise<AndroidUiNode> {
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const node = (await nodes()).find(predicate);
    if (node) return node;
    await interaction("swipe", () => adb("shell", "input", "swipe", "540", "1850", "540", "800", "300"));
  }
  return waitNode(predicate, label);
}

async function tap(label: string, scroll = false, leadingText = false): Promise<void> {
  await interaction("tap", () => tapSurface(label, scroll, leadingText));
}

async function tapSurface(label: string, scroll: boolean, leadingText: boolean): Promise<void> {
  const observedResources: string[] = [];
  for (let attempt = 0; attempt < (scroll ? 14 : 1); attempt += 1) {
    const candidates = await nodes();
    if (label === "Workspace image") {
      const resources = candidates.filter((entry) => (entry.text + " " + entry.contentDescription).includes("README.md")
        || (entry.text + " " + entry.contentDescription).includes("Workspace image"));
      if (resources.length > 0) {
        const ready = await waitFor(async () => (await nodes()).find((entry) => entry.contentDescription === label
          || entry.text === label), (entry) => entry !== undefined, "authorized native message image", 15_000).catch(() => undefined);
        if (ready) {
          await adb("shell", "input", "tap", String(Math.round((ready.bounds.x1 + ready.bounds.x2) / 2)),
            String(Math.round((ready.bounds.y1 + ready.bounds.y2) / 2)));
          return;
        }
        await screenshot("resource-candidate");
        observedResources.push(JSON.stringify(resources.map((entry) => ({ text: entry.text,
          label: entry.contentDescription, bounds: entry.bounds, enabled: entry.enabled }))));
      }
    }
    const node = candidates.find((entry) => entry.enabled && entry.contentDescription === label)
      ?? candidates.find((entry) => entry.enabled && entry.text === label);
    if (node) {
      await tapNode(node, leadingText);
      return;
    }
    // Files retains its offset after closing a gallery; search both ways inside its actual viewport.
    if (scroll) {
      const viewport = candidates.filter((entry) => entry.scrollable && entry.enabled
        && entry.bounds.x2 > entry.bounds.x1 && entry.bounds.y2 > entry.bounds.y1)
        .sort((left, right) => (right.bounds.x2 - right.bounds.x1) * (right.bounds.y2 - right.bounds.y1)
          - (left.bounds.x2 - left.bounds.x1) * (left.bounds.y2 - left.bounds.y1))[0];
      if (!viewport) break;
      const x = Math.round((viewport.bounds.x1 + viewport.bounds.x2) / 2);
      const inset = Math.max(1, Math.round((viewport.bounds.y2 - viewport.bounds.y1) * 0.15));
      const top = viewport.bounds.y1 + inset;
      const bottom = viewport.bounds.y2 - inset;
      await interaction("swipe", () => adb("shell", "input", "swipe", String(x), String(attempt < 7 ? bottom : top), String(x),
        String(attempt < 7 ? top : bottom), "300"));
    }
  }
  let node: AndroidUiNode;
  try {
    node = await waitNode((entry) => entry.enabled && (entry.contentDescription === label || entry.text === label), label);
  } catch {
    if (label === "Workspace image") await screenshot("resource-error");
    const labels = (await nodes()).map((entry) => entry.contentDescription).filter((value) => value !== undefined);
    throw new Error("Native surface unavailable: " + label + ". Accessible labels: " + JSON.stringify(labels)
      + (observedResources.length ? ". Resource nodes: " + observedResources.join("; ") : ""));
  }
  await tapNode(node, leadingText);
}

async function tapNode(node: AndroidUiNode, leadingText = false): Promise<void> {
  // Native selectable text reports paragraph bounds. Touch the LTR fixture's first glyph, not trailing empty space.
  const x = leadingText && !node.contentDescription ? node.bounds.x1 + Math.min(12, (node.bounds.x2 - node.bounds.x1) / 2)
    : (node.bounds.x1 + node.bounds.x2) / 2;
  await adb("shell", "input", "tap", String(Math.round(x)),
    String(Math.round((node.bounds.y1 + node.bounds.y2) / 2)));
}

async function fill(label: string, value: string, scroll = false): Promise<void> {
  await interaction("text-entry", async () => {
    if (!/^[A-Za-z0-9 .,:/_+-]+$/u.test(value)) throw new Error("Native fixture input must be bounded shell-safe ASCII.");
    await tap(label, scroll);
    await adb("shell", "input", "keyevent", "--longpress", "KEYCODE_MOVE_END");
    await adb("shell", "input", "text", value.replaceAll(" ", "%s"));
    await adb("shell", "input", "keyevent", "KEYCODE_BACK");
  });
}

async function launch(): Promise<void> {
  await interaction("launch", async () => {
    expect(await adb("shell", "am", "start", "-W", "-n", packageName + "/.MainActivity")).toContain("Status: ok");
  });
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

async function screenshot(name: EvidenceScreenshot): Promise<void> {
  const directory = join(dirname(apkPath!), "ui-evidence");
  await mkdir(directory, { recursive: true });
  const remote = "/sdcard/joko-native-" + name + ".png";
  await adb("shell", "screencap", "-p", remote);
  const file = name + ".png";
  const local = join(directory, file);
  await adb("pull", remote, local);
  await adb("shell", "rm", remote);
  activeStep?.screenshots.push({ file, sha256: await digest(local), capturedAfterMs: elapsed() });
  await persistEvidence();
}
