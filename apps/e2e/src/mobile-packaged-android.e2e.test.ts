import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { capabilityNames, RunState } from "@joko/contracts";
import { formatTrustedNodeInvitation } from "@joko/connection-transport/trust";
import type { AdapterContext, PromptInput, SessionTree } from "@joko/core";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { parseAndroidUiNodes, type AndroidUiNode } from "@joko/tool-android";
import { afterEach, expect, it, vi } from "vitest";

import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

const evidenceSteps = {
  "validate-emulator": { action: "validation", assertions: ["owned-avd-name", "emulator-property", "boot-completed"] },
  "validate-apk": { action: "validation", assertions: ["android-manifest", "clean-manifest-source", "application-package", "apk-manifest-sha256"] },
  "install-apk": { action: "installation", assertions: ["fresh-application-data", "installed-apk-sha256"] },
  "prepare-fixture": { action: "fixture-setup", assertions: ["local-orchestrator-ready", "fixture-task-created", "port-reverse-ready"] },
  "pair-application": { action: "pairing", assertions: ["application-started", "trusted-endpoint-public-key-entered", "pairing-request-issued"] },
  "open-task-header": { action: "navigation", assertions: ["task-title-visible", "title-between-header-controls", "header-actions-within-viewport", "file-attachment-control-enabled"] },
  "task-actions-menu": { action: "menu", assertions: ["complete-task-actions", "actions-within-viewport"] },
  "send-native-input": { action: "text-entry", assertions: ["one-completed-run", "exact-fixture-dispatch", "one-active-mobile-connection", "persisted-timeline", "owner-generation-consistent"] },
  "tap-conversation-share-row": { action: "gesture", assertions: ["select-from-message-menu", "body-tap-deselects", "body-tap-reselects", "cancel-restores-task"] },
  "quote-selected-message-text": { action: "gesture", assertions: ["system-selection-menu-action", "exact-user-and-assistant-text-in-draft", "no-dispatch-from-quoting"] },
  "open-image-gallery": { action: "resource-navigation", assertions: ["gallery-visible", "image-decoded", "gallery-retained-across-observations"] },
  "toggle-image-chrome": { action: "gesture", assertions: ["one-to-one-tap-hides-controls", "same-image-remains-visible", "second-tap-restores-controls"] },
  "zoom-image-gallery": { action: "gesture", assertions: ["double-tap-zoom", "zoomed-tap-keeps-gallery-open"] },
  "short-image-drag": { action: "gesture", assertions: ["zoom-reset", "short-drag-keeps-gallery-open", "restored-canvas-accepts-both-taps"] },
  "vertical-dismiss-image": { action: "gesture", assertions: ["gesture-canvas-sized", "vertical-dismiss-restores-task"] },
  "close-image-gallery": { action: "resource-navigation", assertions: ["reopened-image-decoded", "close-restores-task"] },
  "system-back-from-image-gallery": { action: "navigation", assertions: ["reopened-image-decoded", "system-back-restores-same-task"] },
  "open-canonical-file": { action: "resource-navigation", assertions: ["canonical-file-contents", "canonical-line-focus"] },
  "copy-file-source": { action: "clipboard", assertions: ["copy-source-completed"] },
  "force-stop-and-reconnect": { action: "lifecycle", assertions: ["application-process-stopped", "application-restarted", "restored-task-title", "persisted-task-input"] },
  "restore-canonical-file": { action: "lifecycle", assertions: ["restored-file-contents", "restored-line-focus", "no-duplicate-dispatch", "one-persisted-run", "one-mobile-connection", "no-application-crash", "run-succeeded"] },
  "system-back-from-files": { action: "navigation", assertions: ["opened-task-files-root", "system-back-restores-same-task"] },
  "browse-workspace-html": { action: "resource-navigation", assertions: ["canonical-html-link", "child-document-fragment", "back-and-forward", "document-reload"] },
  "open-isolated-html-website": { action: "native-address", assertions: ["native-address-entry", "website-request-received", "website-rendered", "no-node-credentials", "return-to-file-history"] }
} as const;
type EvidenceStepName = keyof typeof evidenceSteps;
type EvidenceAction = "tap" | "text-entry" | "launch" | "double-tap" | "swipe" | "force-stop" | "install" | "system-back";
type EvidenceScreenshot = "header" | "actions" | "timeline" | "gallery" | "gallery-zoomed" | "gallery-drag-reset" | "gallery-chrome-hidden"
  | "gallery-chrome-after-drag-hidden" | "gallery-chrome-error" | "gallery-chrome-after-drag-error"
  | "gallery-dismissed" | "gallery-system-back" | "resource-links" | "file-opened" | "file" | "restored"
  | "gallery-error" | "restored-error" | "file-error" | "resource-candidate" | "resource-error"
  | "connection-add" | "connection-error" | "connection-identity-error" | "actions-scrolled" | "share-selection" | "share-selection-error"
  | "native-user-quote-menu" | "native-assistant-quote-menu"
  | "native-user-message-quote" | "native-assistant-message-quote" | "native-message-quote-error" | "html-guide" | "html-website"
  | "html-guide-refresh-error" | "html-website-address-error" | "html-website-render-error";
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
  transport?: 'https' | 'webrtc' | 'http-connect';
  httpConnect?: { beforePairing: number; afterPairing?: number; beforeRestart?: number; afterRestore?: number; directPortReversed: false };
  scope: "native-pairing-input-canonical-resources-and-process-reopen";
  backend: "local-instrumented-orchestrator-fixture";
  result: EvidenceResult;
  scenarioResult: EvidenceResult;
  cleanupResult: EvidenceResult;
  elapsedMs: number;
  adbFailures?: Array<{
    readonly step: EvidenceStepName | "setup" | "cleanup";
    readonly command: string;
    readonly afterMs: number;
    readonly elapsedMs: number;
    readonly exitCode?: number;
    readonly signal?: string;
    readonly deviceUnavailable: boolean;
  }>;
  fixtureReadiness?: Partial<Record<"workspace-directory" | "workspace-index" | "session-artifacts", {
    passed: boolean; count?: number;
  }>>;
  target?: { serial: string; avd: string };
  artifact?: {
    kind: "apk"; package: string; sha256: string; manifestSha256: string;
    source: { commit: string; tree: "clean"; productionGate: "passed" | "bypassed" | "unavailable" };
    installedSha256?: string;
  };
  website?: { addressEntered: boolean; requestCount: number; requestsWithCredentials: number };
  steps: EvidenceStep[];
};

const serial = process.env.JOKO_ANDROID_TEST_SERIAL?.trim();
const avd = process.env.JOKO_ANDROID_TEST_AVD?.trim();
const adbExecutable = process.env.JOKO_ANDROID_ADB?.trim();
const apkPath = process.env.JOKO_ANDROID_TEST_APK?.trim();
const connectionTransport = process.env.JOKO_ANDROID_CONNECTION_TRANSPORT ?? 'https';
const nativeIt = serial && avd && adbExecutable && apkPath ? it : it.skip;
const packageName = "app.joko.mobile";
const prompt = "Show the workspace resources";
const taskName = "Android resource task";
const answer = "![Workspace image](images/pixel.png)\n\n`README.md:2:4`";
const plainAnswer = "Read this plain assistant response";

class AndroidResourceAdapter extends InstrumentedFakeAdapter {
  readonly #trees = new Map<string, SessionTree>();

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.sendCalls.push(input);
    const userId = "resource-user-" + this.sendCalls.length;
    const plainAnswerId = "resource-plain-answer-" + this.sendCalls.length;
    const answerId = "resource-answer-" + this.sendCalls.length;
    await context.emit({ type: "message_complete", role: "user", blocks: [{ kind: "text", text: input.text }],
      nativeHistory: { identity: { entryId: userId } } });
    await context.emit({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: plainAnswer }],
      nativeHistory: { identity: { entryId: plainAnswerId, parentEntryId: userId } } });
    await context.emit({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: answer }],
      nativeHistory: { identity: { entryId: answerId, parentEntryId: plainAnswerId } } });
    this.#trees.set(context.sessionId, { roots: [{ entryId: userId, kind: "message", role: "user", label: input.text,
      timestamp: 1, children: [{ entryId: plainAnswerId, parentId: userId, kind: "message", role: "assistant",
        label: plainAnswer, timestamp: 2, children: [{ entryId: answerId, parentId: plainAnswerId, kind: "message",
          role: "assistant", label: "Workspace resources", timestamp: 3, children: [] }] }] }], leafId: answerId });
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
        const cleanupFailures: unknown[] = [];
        try { await adb("shell", "am", "force-stop", packageName); } catch (error) { cleanupFailures.push(error); }
        try { expect((await adb("shell", "pm", "clear", packageName)).trim()).toBe("Success"); } catch (error) { cleanupFailures.push(error); }
        try { if (reversedPort !== undefined) await adb("reverse", "--remove", reversedPort); } catch (error) { cleanupFailures.push(error); }
        if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, "The owned Android fixture did not finish cleaning up.");
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

nativeIt("pairs with a trusted node key, sends through native rich input, opens canonical resources, and resumes without resending", {
  // Leave time for the final website request, render, and diagnostic deadlines after the device workflow.
  timeout: 600_000
}, async () => {
  if (!serial || !/^emulator-\d+$/u.test(serial) || !avd?.startsWith("joko-")
    || !adbExecutable || !isAbsolute(adbExecutable) || !apkPath || !isAbsolute(apkPath)) {
    throw new Error("Native Android evidence requires an explicit isolated Joko AVD and absolute tool/artifact paths.");
  }
  evidenceStarted = performance.now();
  if (!['https', 'webrtc', 'http-connect'].includes(connectionTransport)) throw new Error('Select an explicit supported Android connection transport.');
  evidence = { schemaVersion: 1, platform: "android", scope: "native-pairing-input-canonical-resources-and-process-reopen",
    backend: "local-instrumented-orchestrator-fixture", result: "running", scenarioResult: "running",
    cleanupResult: "running", elapsedMs: 0, steps: [], transport: connectionTransport as AndroidEvidence['transport'] };
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
    { key: capabilityNames.inputFile, supported: true as const },
    { key: capabilityNames.workspaceFiles, supported: true as const }
  ] };
  fixture = await OrchestratorE2eFixture.start({ profiles: [profile], createAdapter: (entry) => new AndroidResourceAdapter(entry), collaborationGoals: true,
    webRtc: connectionTransport === 'webrtc', httpConnect: connectionTransport === 'http-connect' });
  const current = fixture;
  await mkdir(join(current.workspaceDirectory, "images"));
  await writeFile(join(current.workspaceDirectory, "images", "pixel.png"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await writeFile(join(current.workspaceDirectory, "README.md"), "first\nfocus line\nlast\n");
  await mkdir(join(current.workspaceDirectory, "html-guide"));
  await writeFile(join(current.workspaceDirectory, "html-guide", "index.html"),
    '<meta name="viewport" content="width=device-width"><a style="display:block;padding:20px;font-size:24px" href="./details.html#chapter">Open the guide</a>');
  await writeFile(join(current.workspaceDirectory, "html-guide", "details.html"),
    '<meta name="viewport" content="width=device-width"><h1 id="chapter">Workspace guide chapter</h1>');
  const manager = await current.pair("Android fixture manager");
  const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
    createSessionMutation({ backendId: profile.id, targetId: current.targetId(profile.id), displayName: taskName })));
  const { mobileNetwork } = await vi.importActual<{ mobileNetwork: {
    listWorkspaceDirectory(credential: { origin: string; authKey: string }, workspaceId: string, parent: string): Promise<{ entries: readonly unknown[] }>;
    listWorkspaceFileIndex(credential: { origin: string; authKey: string }, workspaceId: string): Promise<{ paths: readonly string[] }>;
    listSessionArtifacts(credential: { origin: string; authKey: string }, sessionId: string): Promise<{ artifacts: readonly unknown[] }>;
  } }>("../../mobile/src/network.js");
  const fixtureCredential = { origin: current.baseUrl, authKey: manager.authKey };
  for (const [phase, read] of [
    ["workspace-directory", async () => (await mobileNetwork.listWorkspaceDirectory(fixtureCredential, "workspace-main", "")).entries.length],
    ["workspace-index", async () => (await mobileNetwork.listWorkspaceFileIndex(fixtureCredential, "workspace-main")).paths.length],
    ["session-artifacts", async () => (await mobileNetwork.listSessionArtifacts(fixtureCredential, sessionId)).artifacts.length]
  ] as const) {
    let count: number;
    try { count = await read(); }
    catch {
      evidence!.fixtureReadiness = { ...evidence!.fixtureReadiness, [phase]: { passed: false } };
      await persistEvidence();
      console.info(JSON.stringify({ phase: `android-fixture-${phase}`, passed: false }));
      throw new Error(`The authenticated native fixture ${phase} read failed.`);
    }
    evidence!.fixtureReadiness = { ...evidence!.fixtureReadiness, [phase]: { passed: true, count } };
    await persistEvidence();
    console.info(JSON.stringify({ phase: `android-fixture-${phase}`, passed: true, count }));
  }
  const proxyTransport = current.httpConnectTransport;
  if (connectionTransport === 'http-connect' && proxyTransport === undefined) throw new Error('The native proxy fixture has no selected locator.');
  // CONNECT builds receive only the proxy port. The logical HTTP backend is
  // deliberately not reversed, so direct HTTPS/HTTP fallback cannot pass.
  reversedPort = "tcp:" + new URL(proxyTransport?.proxyOrigin ?? current.baseUrl).port;
  if (proxyTransport !== undefined) {
    expect(new URL(proxyTransport.proxyOrigin).port).not.toBe(new URL(current.baseUrl).port);
    evidence!.httpConnect = { beforePairing: current.httpConnectRequests, directPortReversed: false };
  }
  await adb("reverse", reversedPort, reversedPort);
  await completeStep();

  await beginStep("pair-application");
  let mobileChallengeId: string | undefined;
  const removeListener = current.application.connections.onPairingIssued((challenge) => { mobileChallengeId = challenge.id; });
  try {
    await launch();
    try {
      await tap("Add Joko node");
      // The tab click can return while accessibility still exposes Nearby.
      // Wait for the actual add page before searching its scrollable viewport.
      await waitNode(node => node.enabled && (node.text === "Connect to Joko" || node.contentDescription === "Connect to Joko"), "the connection method choices");
      await tap("Manual configuration", true);
      await scrollToNode(node => node.enabled && (node.text === "Joko node address"
        || node.contentDescription === "Joko node address"), "the expanded manual node address");
      await waitForInitialNodeAddress(() => mobileChallengeId === undefined);
    } catch (error) {
      // This block precedes every address, pin and pairing action. Capture only
      // the same owned AVD while no pairing request has been issued.
      if (mobileChallengeId === undefined) await captureInitialConnectionFailure(() => mobileChallengeId === undefined).catch(() => undefined);
      throw error;
    }
    await screenshot("connection-add");
    await fill("Joko node address", current.baseUrl);
    const endpointPublicKey = current.application.linkspanIdentity!.publicKey;
    const invitation = proxyTransport === undefined ? endpointPublicKey : formatTrustedNodeInvitation({
      origin: current.baseUrl, endpointPublicKey, endpointTransport: proxyTransport
    });
    await fill("Trusted node invitation or public key", invitation, true, true);
    if (connectionTransport === 'webrtc') {
      await tap('WebRTC', true);
    }
    await tap("Check node identity", true);
    await tap("Request pairing", true);
    await waitFor(async () => mobileChallengeId, (value) => value !== undefined, "native pairing request");
    await fill("Pairing code", current.pairingCode(mobileChallengeId!), true);
    await tap("Pair this device", true);
  } catch (error) {
    if (connectionTransport !== 'https' && mobileChallengeId === undefined) {
      await captureTransportIdentityFailure(current, () => mobileChallengeId === undefined).catch(() => undefined);
    }
    throw error;
  } finally { removeListener(); }
  await completeStep();
  if (connectionTransport === 'webrtc') expect(current.webRtcSignalingRequests).toBeGreaterThan(2);
  if (evidence!.httpConnect !== undefined) {
    evidence!.httpConnect.afterPairing = current.httpConnectRequests;
    expect(current.httpConnectRequests).toBeGreaterThan(evidence!.httpConnect.beforePairing);
    await persistEvidence();
  }

  await beginStep("open-task-header");
  await openFixtureTask();
  const screen = (await adb("shell", "wm", "size")).match(/(?:Physical|Override) size: (\d+)x(\d+)/gu)?.at(-1)
    ?.match(/(\d+)x(\d+)/u);
  if (!screen) throw new Error("The isolated native viewport was unavailable.");
  const screenWidth = Number(screen[1]);
  const headerLabels = ["Back to Tasks", "Remote Desktop", "Files", "Task actions"];
  const headerNodes = await waitFor(nodes, (items) => items.some((node) => node.text === taskName)
    && headerLabels.every((label) => items.some((node) => node.contentDescription === label)), "visible native task header", 25_000);
  await screenshot("header");
  const title = headerNodes.find((node) => node.text === taskName)!;
  const headerControls = headerLabels.map((label) => headerNodes.find((node) => node.contentDescription === label)!);
  assertTaskHeaderBounds(title, headerControls, screenWidth);
  await waitNode((node) => node.contentDescription === "Attach" && node.enabled && node.clickable, "file attachment on the existing task");
  await completeStep();
  await beginStep("task-actions-menu");
  await tap("Task actions");
  await inspectTaskActions(screenWidth);
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
  await beginStep("tap-conversation-share-row");
  try {
    await tap("More actions for You", true);
    await tap("Share as image");
    await waitNode((node) => node.text === "1 selected", "original share selection");
    const message = () => scrollToNode((node) => node.text === prompt, "the visible user message body", "earlier");
    await interaction("tap", async () => tapNode(await message(), true));
    await waitNode((node) => node.text === "0 selected", "deselected by tapping the message body");
    await interaction("tap", async () => tapNode(await message(), true));
    await waitNode((node) => node.text === "1 selected", "reselected by tapping the message body");
    await screenshot("share-selection");
    await tap("Cancel");
    await waitNode((node) => node.contentDescription === "Task actions", "task restored after share selection");
  } catch (error) {
    await screenshot("share-selection-error").catch(() => undefined);
    throw error;
  }
  await completeStep();
  await beginStep("quote-selected-message-text");
  try {
    const quoteCases = [
      { body: prompt, word: "Show", chip: "Quote from your message", label: "Quoted text from your message",
        menu: "native-user-quote-menu", evidence: "native-user-message-quote" },
      { body: plainAnswer, word: "Read", chip: "Quote from Assistant", label: "Quoted assistant text",
        menu: "native-assistant-quote-menu", evidence: "native-assistant-message-quote" }
    ] as const;
    for (const quote of quoteCases) {
      const source = await scrollToNode((node) => node.text === quote.body, "the original selectable message", "earlier");
      const x = String(Math.round(source.bounds.x1 + Math.min(12, (source.bounds.x2 - source.bounds.x1) / 2)));
      const y = String(Math.round((source.bounds.y1 + source.bounds.y2) / 2));
      await interaction("swipe", () => adb("shell", "input", "swipe", x, y, x, y, "750"));
      await tapSystemMessageQuote(quote.menu);
      await tap("View quote: " + quote.chip);
      await waitNode((node) => node.text === quote.word && node.contentDescription === quote.label, "the exact selected word");
      await screenshot(quote.evidence);
      await tap("Remove " + quote.chip);
      await waitNode((node) => node.contentDescription === "Task actions", "task restored after removing the quotation");
    }
    expect(current.adapter(profile.id).sendCalls.map((input) => input.text)).toEqual([prompt]);
  } catch (error) {
    await screenshot("native-message-quote-error").catch(() => undefined);
    throw error;
  }
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
  await beginStep("toggle-image-chrome");
  await toggleImageChrome("gallery-chrome-hidden", "gallery-chrome-error");
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
  await toggleImageChrome("gallery-chrome-after-drag-hidden", "gallery-chrome-after-drag-error");
  await completeStep();
  await beginStep("vertical-dismiss-image");
  const verticalCanvas = await waitNode((node) => node.contentDescription === "Image preview pixel.png", "native gesture canvas with controls restored");
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
  await beginStep("system-back-from-image-gallery");
  await tap("Workspace image", true);
  await waitNode((node) => node.contentDescription === "Copy image" && node.enabled, "gallery decoded before Android Back");
  await interaction("system-back", () => adb("shell", "input", "keyevent", "KEYCODE_BACK"));
  await waitNode((node) => node.text === taskName, "the original task after Android Back from the gallery");
  await screenshot("gallery-system-back");
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
  if (evidence!.httpConnect !== undefined) evidence!.httpConnect.beforeRestart = current.httpConnectRequests;
  await interaction("force-stop", () => adb("shell", "am", "force-stop", packageName));
  expect((await adb("shell", "pidof", packageName)).trim()).toBe("");
  await launch();
  await tap("Saved nodes");
  await tap("Connect", true);
  await openFixtureTask();
  await waitNode((node) => node.text === taskName, "restored native task title");
  await scrollToNode((node) => node.text?.includes(prompt) === true, "persisted native task input", "earlier");
  await completeStep();
  await beginStep("restore-canonical-file");
  await tap("README.md:2:4", true, true);
  await waitNode((node) => node.text === "Line 2" || node.contentDescription === "Line 2", "restored canonical file line focus");
  await assertRestoredMarkdown();
  await screenshot("restored");
  expect(current.adapter(profile.id).sendCalls).toHaveLength(1);
  expect(current.application.store.listRuns({ sessionId })).toHaveLength(1);
  expect(current.application.store.listConnections().filter((connection) => connection.deviceId === mobileDevices[0]!.id)).toHaveLength(1);
  expect(await adb("logcat", "-b", "crash", "-d", "-v", "brief")).not.toMatch(/app\.joko\.mobile|ReactNativeJS|Hermes/u);
  if (evidence!.httpConnect !== undefined) {
    evidence!.httpConnect.afterRestore = current.httpConnectRequests;
    expect(current.httpConnectRequests).toBeGreaterThan(evidence!.httpConnect.beforeRestart!);
  }
  const run = current.application.store.listRuns({ sessionId })[0]!;
  expect((await manager.clients.run.getRun({ runId: run.descriptor.id })).run?.state).toBe(RunState.SUCCEEDED);
  await completeStep();

  await beginStep("system-back-from-files");
  await tap("Back to Files");
  await tap("Back to Task");
  await waitNode((node) => node.text === taskName, "original task before opening Files");
  await tap("Files");
  await waitNode((node) => node.contentDescription === "Open directory html-guide" && node.enabled, "task Files root contents");
  await interaction("system-back", () => adb("shell", "input", "keyevent", "KEYCODE_BACK"));
  await waitFor(nodes, (items) => items.some(node => node.text === taskName)
    && items.some(node => node.contentDescription === "Back to Tasks")
    && !items.some(node => node.contentDescription === "Back to Task"), "original task after Android Back on Files", 15_000);
  await completeStep();

  await beginStep("browse-workspace-html");
  await tap("Files");
  await tap("Open directory html-guide");
  await tap("Preview file index.html");
  await tap("Open the guide");
  const detailsAddress = "html-guide/details.html#chapter";
  const isAddressField = (node: AndroidUiNode) => node.className === "android.widget.EditText" && node.contentDescription === "Page address";
  const waitAddress = (value: string) => waitNode((node) => isAddressField(node) && (node.text ?? "") === value,
    value === "" ? "cleared HTML address field" : "HTML display path " + value);
  const chapter = "Workspace guide chapter";
  const refreshedChapter = "Refreshed Workspace guide chapter";
  const waitChapter = (text = chapter) => waitNode((node) => node.text === text || node.contentDescription === text, "rendered " + text);
  await waitAddress(detailsAddress);
  await waitChapter();
  await tap("Previous page");
  await waitAddress("html-guide/index.html");
  await waitNode((node) => node.text === "Open the guide" || node.contentDescription === "Open the guide", "back to the rendered guide link");
  await tap("Next page");
  await waitAddress(detailsAddress);
  await waitChapter();
  await writeFile(join(current.workspaceDirectory, "html-guide", "details.html"),
    `<meta name="viewport" content="width=device-width"><h1 id="chapter">${refreshedChapter}</h1>`);
  try {
    await interaction("tap", async () => {
      const refresh = await waitFor(async () => {
        const items = await nodes();
        const address = items.find(node => isAddressField(node) && node.text === detailsAddress);
        const next = items.find(node => node.contentDescription === "Next page" && node.bounds.x2 > node.bounds.x1);
        if (!address || !next) return undefined;
        return items.find(node => node.enabled && node.clickable && node.contentDescription === "Refresh"
          && node.bounds.x1 >= next.bounds.x2 && node.bounds.x2 > node.bounds.x1
          && node.bounds.y1 < next.bounds.y2 && node.bounds.y2 > next.bounds.y1 && node.bounds.y2 <= address.bounds.y1);
      }, (node) => node !== undefined, "Refresh in the native HTML navigation row", 15_000);
      await tapNode(refresh!);
    });
    await waitAddress(detailsAddress);
    await waitChapter(refreshedChapter);
  } catch (error) {
    await screenshot("html-guide-refresh-error").catch(() => undefined);
    const observed = await nodes(Date.now() + 5_000).catch(() => []);
    throw new Error("The refreshed Workspace document did not render. Native nodes: " + JSON.stringify(observed.slice(0, 80)
      .map(node => ({ text: node.text?.slice(0, 180), label: node.contentDescription?.slice(0, 160), bounds: node.bounds }))), { cause: error });
  }
  await screenshot("html-guide");
  await completeStep();

  await beginStep("open-isolated-html-website");
  const websiteEvidence = { addressEntered: false, requestCount: 0, requestsWithCredentials: 0 };
  evidence!.website = websiteEvidence;
  const site = createServer((request, response) => {
    if (request.url !== "/viewer") { response.writeHead(404).end(); return; }
    websiteEvidence.requestCount += 1;
    if (request.headers.authorization !== undefined || request.headers.cookie !== undefined) {
      websiteEvidence.requestsWithCredentials += 1;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
      '<meta name="viewport" content="width=device-width"><h1>Isolated website fixture</h1>');
  });
  await new Promise<void>((resolve, reject) => {
    site.once("error", reject); site.listen(0, "127.0.0.1", () => { site.removeListener("error", reject); resolve(); });
  });
  const sitePort = site.address();
  let siteReverse: string | undefined;
  try {
    if (!sitePort || typeof sitePort === "string") throw new Error("The owned website fixture has no TCP address.");
    const port = "tcp:" + sitePort.port;
    await adb("reverse", port, port); siteReverse = port;
    const url = `http://127.0.0.1:${sitePort.port}/viewer`;
    const addressField = await waitAddress(detailsAddress);
    await interaction("text-entry", async () => {
      try {
        await tapNode(addressField);
        // Replace the selection in the real native field after React Native has adopted the clear.
        await adb("shell", "input", "keycombination", "KEYCODE_CTRL_LEFT", "KEYCODE_A");
        await adb("shell", "input", "keyevent", "KEYCODE_DEL");
        await waitAddress("");
        await adb("shell", "input", "text", `'${url}'`);
        await waitAddress(url);
        websiteEvidence.addressEntered = true;
      } catch (error) {
        await screenshot("html-website-address-error").catch(() => undefined);
        const observed = await nodes(Date.now() + 5_000).catch(() => []);
        throw new Error(`Native HTML address entry did not settle. Address field: ${JSON.stringify(observed.find(isAddressField)?.text ?? null)}`, { cause: error });
      }
    });
    expect(websiteEvidence.requestCount).toBe(0);
    try {
      await interaction("tap", async () => {
        const open = await waitFor(async () => {
          const items = await nodes();
          const field = items.find(node => isAddressField(node) && node.text === url);
          if (field === undefined) return undefined;
          return items.find(node => node.enabled && node.clickable && node.contentDescription === "Open"
            && node.bounds.x1 >= field.bounds.x2 && node.bounds.x2 > node.bounds.x1
            && node.bounds.y1 < field.bounds.y2 && node.bounds.y2 > field.bounds.y1);
        }, (node) => node !== undefined, "Open in the native HTML address row", 15_000);
        await tapNode(open!);
      });
      await waitFor(async () => websiteEvidence.requestCount, (count) => count > 0, "request to the isolated website fixture", 25_000);
      await waitNode((node) => node.text === "Isolated website fixture" || node.contentDescription === "Isolated website fixture", "isolated website rendered in the native app");
      expect(websiteEvidence.requestsWithCredentials).toBe(0);
      await screenshot("html-website");
      await tap("Previous page");
      await waitAddress(detailsAddress);
      await waitChapter(refreshedChapter);
    } catch (error) {
      await screenshot("html-website-render-error").catch(() => undefined);
      const observed = await nodes(Date.now() + 5_000).catch(() => []);
      const messages = observed.flatMap(node => [node.text, node.contentDescription]).filter(value =>
        value === "Enter a valid web address without credentials." || value === "Could not load this website. Refresh or return to the file.");
      throw new Error(`Native HTML website step failed after ${websiteEvidence.requestCount} fixture requests. Address: ${JSON.stringify(observed.find(isAddressField)?.text ?? null)}. UI messages: ${JSON.stringify(messages)}`, { cause: error });
    }
  } finally {
    try { if (siteReverse !== undefined) await adb("reverse", "--remove", siteReverse); }
    finally { site.closeAllConnections(); await new Promise<void>((resolve) => site.close(() => resolve())); }
  }
  await completeStep();
}

async function assertRestoredMarkdown(): Promise<void> {
  try {
    await waitNode((node) => node.text?.includes("focus line") === true, "restored canonical file contents");
  } catch (cause) {
    // On this owned AVD the WebView can paint normally while UiAutomation
    // returns only the surrounding native controls after a process restart.
    const frame = activeStep?.screenshots.find((entry) => entry.file === "restored-error.png");
    if (frame === undefined) throw cause;
    const text = await readAndroidScreenshotText(frame.file);
    const rendered = text.toLowerCase().replace(/\s+/gu, " ");
    if (!rendered.includes("readme.md") || !rendered.includes("line 2") || !rendered.includes("first focus line last")) throw cause;
    console.log(JSON.stringify({ phase: "restored-canonical-file", observation: "screenshot-ocr", screenshot: frame.file, sha256: frame.sha256 }));
  }
}

async function readAndroidScreenshotText(file: string, tsv = false): Promise<string> {
  const path = join(dirname(apkPath!), "ui-evidence", file);
  return new Promise((resolve) => {
    execFile("tesseract", [path, "stdout", "-l", "eng", "--psm", "11", ...(tsv ? ["tsv"] : [])],
      { timeout: 12_000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => resolve(error ? "" : stdout));
  });
}

async function tapSystemMessageQuote(name: "native-user-quote-menu" | "native-assistant-quote-menu"): Promise<void> {
  await interaction("tap", async () => {
    const node = (await nodes()).find((entry) => entry.enabled
      && (entry.text === "Quote selection" || entry.contentDescription === "Quote selection")
      && entry.bounds.x2 > entry.bounds.x1 && entry.bounds.y2 > entry.bounds.y1);
    const frame = await screenshot(name);
    if (node !== undefined) {
      await tapNode(node);
      return;
    }
    // The floating Android selection toolbar can be visible outside the hierarchy dump.
    const transcript = await readAndroidScreenshotText(frame.file, true);
    const words = transcript.split(/\r?\n/u).flatMap((line) => {
      const [level, , , , , , left, top, width, height, , text] = line.split("\t");
      const x = Number(left), y = Number(top), w = Number(width), h = Number(height);
      return level === "5" && text && Number.isInteger(x) && x >= 0 && Number.isInteger(y) && y >= 0
        && Number.isInteger(w) && w > 0 && Number.isInteger(h) && h > 0
        ? [{ text: text.trim().toLowerCase(), x, y, w, h }]
        : [];
    });
    const actions = words.filter((word) => word.text === "quote").flatMap((quote) => {
      const centerY = quote.y + quote.h / 2;
      const [selection, copy] = words.filter((word) => word.x > quote.x && centerY >= word.y && centerY <= word.y + word.h)
        .sort((left, right) => left.x - right.x);
      if (selection?.text !== "selection" || copy?.text !== "copy" || selection.x - (quote.x + quote.w) > quote.h) return [];
      return [{ x: Math.round((quote.x + selection.x + selection.w) / 2), y: Math.round(centerY) }];
    });
    if (actions.length !== 1) throw new Error("The native selection toolbar did not show a unique Quote selection action next to Copy.");
    const action = actions[0]!;
    console.log(JSON.stringify({ phase: "native-message-quote-menu", observation: "screenshot-ocr",
      screenshot: frame.file, sha256: frame.sha256, point: action }));
    await adb("shell", "input", "tap", String(action.x), String(action.y));
  });
}

async function toggleImageChrome(hidden: EvidenceScreenshot, failed: EvidenceScreenshot): Promise<void> {
  const isCanvas = (node: AndroidUiNode) => node.contentDescription === "Image preview pixel.png";
  const canvas = await waitNode(isCanvas, "the original decoded canvas at 1×");
  const x = String(Math.round((canvas.bounds.x1 + canvas.bounds.x2) / 2));
  const y = String(Math.round((canvas.bounds.y1 + canvas.bounds.y2) / 2));
  // A stationary contact models a short finger tap with distinct native down and up events.
  const tapCanvas = () => interaction("tap", () => adb("shell", "input", "swipe", x, y, x, y, "60"));
  try {
    await tapCanvas();
    await waitFor(nodes, (items) => items.some(isCanvas)
      && !items.some((node) => node.contentDescription === "Copy image" || node.contentDescription === "Close"),
    "the same native image with its controls hidden", 10_000);
    await screenshot(hidden);
    await tapCanvas();
    await waitFor(nodes, (items) => items.some(isCanvas)
      && items.some((node) => node.text?.includes("1.0") === true)
      && items.some((node) => node.contentDescription === "Copy image" && node.enabled),
    "the same native image at 1.0 with its controls restored", 10_000);
  } catch (error) {
    await screenshot(failed).catch(() => undefined);
    throw error;
  }
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
  return adbUntil(undefined, ...args);
}

async function adbUntil(deadline: number | undefined, ...args: string[]): Promise<string> {
  return (await adbOutput(deadline, args)).toString("utf8");
}

class AndroidFixtureAdbError extends Error {
  constructor(command: string, readonly deviceUnavailable: boolean) {
    super(`The isolated Android fixture command failed (${command}).`);
  }
}

async function adbOutput(deadline: number | undefined, args: readonly string[], maxBuffer = 2 * 1024 * 1024): Promise<Buffer> {
  const timeout = deadline === undefined ? 30_000 : Math.min(30_000, deadline - Date.now());
  if (timeout <= 0) throw new Error("The isolated Android fixture command deadline elapsed.");
  const started = elapsed();
  return new Promise((accept, reject) => {
    execFile(adbExecutable!, ["-s", serial!, ...args], { encoding: "buffer", timeout, maxBuffer, windowsHide: true },
      (error, stdout, stderr) => {
        // Do not include command arguments or output: pairing input is a transient credential.
        if (error && !(args[0] === "shell" && args[1] === "pidof" && error.code === 1)) {
          const command = args[0] === "exec-out" && args[1] === "uiautomator" ? "ui-hierarchy"
            : args[0] === "exec-out" && args[1] === "screencap" ? "screenshot"
            : args[0] === "shell" && ["am", "dumpsys", "getprop", "input", "pidof", "pm", "sha256sum"].includes(args[1] ?? "")
              ? `shell-${args[1]}` : ["emu", "install", "uninstall", "reverse", "logcat", "wait-for-device"].includes(args[0] ?? "") ? args[0]! : "adb";
          const deviceUnavailable = /device offline|device ['"][^\r\n]*['"] not found|no devices\/emulators found|transport (?:is )?closed|connection reset by peer/iu
            .test(stderr.toString("utf8"));
          if (evidence !== undefined && (evidence.adbFailures?.length ?? 0) < 12) {
            (evidence.adbFailures ??= []).push({
              step: evidence.scenarioResult === "running" ? activeStep?.name ?? "setup" : "cleanup",
              command, afterMs: started, elapsedMs: elapsed() - started,
              ...(typeof error.code === "number" ? { exitCode: error.code } : {}),
              ...(error.signal == null ? {} : { signal: error.signal }),
              deviceUnavailable
            });
          }
          reject(new AndroidFixtureAdbError(command, deviceUnavailable));
        } else accept(stdout);
      });
  });
}

function assertTaskHeaderBounds(title: AndroidUiNode, controls: readonly AndroidUiNode[], screenWidth: number): void {
  // Android's Text node reports its rendered text bounds, not the flex title
  // slot. Check the real slot between the current leading/trailing controls.
  expect(title.text).toBe(taskName);
  expect(title.bounds.x2).toBeGreaterThan(title.bounds.x1);
  expect(title.bounds.y2).toBeGreaterThan(title.bounds.y1);
  const leading = controls.find((node) => node.contentDescription === "Back to Tasks")!;
  const trailing = controls.filter((node) => node !== leading);
  expect(title.bounds.x1).toBeGreaterThanOrEqual(leading.bounds.x2);
  expect(title.bounds.x2).toBeLessThanOrEqual(Math.min(...trailing.map((node) => node.bounds.x1)));
  expect(title.bounds.y1).toBeGreaterThanOrEqual(Math.min(...controls.map((node) => node.bounds.y1)));
  expect(title.bounds.y2).toBeLessThanOrEqual(Math.max(...controls.map((node) => node.bounds.y2)));
  for (const button of controls) {
    expect(button.bounds.x1).toBeGreaterThanOrEqual(0);
    expect(button.bounds.x2).toBeLessThanOrEqual(screenWidth);
    expect(button.bounds.x2).toBeGreaterThan(button.bounds.x1);
    expect(button.bounds.y2).toBeGreaterThan(button.bounds.y1);
  }
}

async function inspectTaskActions(screenWidth: number): Promise<void> {
  const required = ["Branches", "Controls", "Copy task link", "Files", "Refresh", "Context"];
  const observed = new Set<string>();
  let previousViewport: string | undefined;
  let swipes = 0;
  await waitFor(async () => {
    const items = await nodes();
    const viewport = items.filter((node) => node.scrollable && node.enabled
      && node.bounds.x2 > node.bounds.x1 && node.bounds.y2 > node.bounds.y1)
      .sort((left, right) => (right.bounds.x2 - right.bounds.x1) * (right.bounds.y2 - right.bounds.y1)
        - (left.bounds.x2 - left.bounds.x1) * (left.bounds.y2 - left.bounds.y1))[0];
    if (!viewport) return false;
    const visible = items.filter((node) => node.contentDescription && node.bounds.x2 > node.bounds.x1 && node.bounds.y2 > node.bounds.y1
      && node.bounds.x1 >= viewport.bounds.x1 && node.bounds.x2 <= viewport.bounds.x2
      && node.bounds.y1 >= viewport.bounds.y1 && node.bounds.y2 <= viewport.bounds.y2);
    for (const label of required) {
      const item = visible.find((node) => label === "Context" ? node.contentDescription?.startsWith("Context") : node.contentDescription === label);
      if (!item) continue;
      expect(item.bounds.x1).toBeGreaterThanOrEqual(0);
      expect(item.bounds.x2).toBeLessThanOrEqual(screenWidth);
      observed.add(label);
    }
    if (required.every((label) => observed.has(label))) {
      await screenshot(swipes === 0 ? "actions" : "actions-scrolled");
      return true;
    }
    if (swipes === 0) await screenshot("actions");
    const signature = JSON.stringify(visible.map((node) => [node.contentDescription, node.bounds]));
    if (signature === previousViewport || swipes >= 7) throw new Error("The native task menu stopped before all required actions became visible.");
    previousViewport = signature;
    const x = Math.round((viewport.bounds.x1 + viewport.bounds.x2) / 2);
    const inset = Math.max(1, Math.round((viewport.bounds.y2 - viewport.bounds.y1) * 0.15));
    await interaction("swipe", () => adb("shell", "input", "swipe", String(x), String(viewport.bounds.y2 - inset),
      String(x), String(viewport.bounds.y1 + inset), "300"));
    swipes += 1;
    return false;
  }, (complete) => complete, "the complete visible native task actions", 25_000);
}

async function nodes(deadline?: number): Promise<readonly AndroidUiNode[]> {
  const output = await adbUntil(deadline, "exec-out", "uiautomator", "dump", "/dev/tty");
  const parsed = parseAndroidUiNodes(normalizeNativeXmlAttributes(output));
  if (parsed.truncated) throw new Error("The native Android hierarchy exceeded its bounded node budget.");
  return parsed.nodes.filter((node) => node.packageName === packageName);
}

function normalizeNativeXmlAttributes(xml: string): string {
  // Android's serializer uses single-quoted attributes for literal JSON text.
  // Preserve its complete value and existing entities for the shared parser.
  return xml.replace(/(\s[\w:-]+)=(?:"[^"]*"|'([^']*)')/gu, (attribute, name: string, single: string | undefined) =>
    single === undefined ? attribute : `${name}="${single.replaceAll('"', '&quot;')}"`);
}

async function waitForInitialNodeAddress(isPreInput: () => boolean): Promise<void> {
  const deadline = Date.now() + 25_000;
  let retapped = false;
  while (Date.now() < deadline) {
    if (!isPreInput()) throw new Error("The initial connection navigation is no longer before pairing.");
    const items = await nodes(deadline);
    if (!isPreInput()) throw new Error("The initial connection navigation is no longer before pairing.");
    if (Date.now() >= deadline) break;
    const addressLabel = items.some((node) => node.enabled
      && (node.text === "Joko node address" || node.contentDescription === "Joko node address"));
    if (addressLabel && items.some((node) => node.enabled && node.className === "android.widget.EditText"
      && node.bounds.x2 > node.bounds.x1 && node.bounds.y2 > node.bounds.y1)) return;
    const nearby = items.some((node) => node.enabled && (node.text === "Nearby Joko nodes" || node.contentDescription === "Nearby Joko nodes"));
    const targets = items.filter((node) => node.enabled && node.clickable
      && (node.text === "Add Joko node" || node.contentDescription === "Add Joko node")
      && node.bounds.x2 > node.bounds.x1 && node.bounds.y2 > node.bounds.y1);
    if (!retapped && !addressLabel && nearby && targets.length === 1) {
      retapped = true;
      // A repeated tab selection is navigation only. Never apply this recovery
      // to identity checks, pairing, or any action after the first input.
      await interaction("tap", () => {
        if (!isPreInput()) throw new Error("The initial connection navigation is no longer before pairing.");
        return tapNode(targets[0]!, false, deadline);
      });
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(10, Math.max(0, deadline - Date.now()))));
  }
  throw new Error("Timed out waiting for empty native node address field.");
}

async function captureInitialConnectionFailure(isPreInput: () => boolean): Promise<void> {
  if (!ownedAvd || activeStep?.name !== "pair-application" || !isPreInput()) return;
  const actualAvd = (await adb("emu", "avd", "name")).split(/\r?\n/u)[0]?.trim();
  if (actualAvd !== avd) throw new Error("The initial connection evidence no longer belongs to the owned AVD.");
  if (!isPreInput()) return;
  try {
    const hierarchy = await nodes();
    if (!isPreInput()) return;
    const directory = join(dirname(apkPath!), "ui-evidence");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "connection-error-hierarchy.json"), JSON.stringify({
      scope: "pre-input-connection-navigation", target: { serial, avd: actualAvd }, nodes: hierarchy
    }, null, 2) + "\n");
  } finally { if (isPreInput()) await screenshot("connection-error"); }
}

async function captureTransportIdentityFailure(current: OrchestratorE2eFixture, isPrePairing: () => boolean): Promise<void> {
  if (!ownedAvd || activeStep?.name !== 'pair-application' || !isPrePairing()) return;
  const actualAvd = (await adb('emu', 'avd', 'name')).split(/\r?\n/u)[0]?.trim();
  if (actualAvd !== avd || !isPrePairing()) return;
  const deadline = Date.now() + 15_000;
  const [hierarchy, focus, processId] = await Promise.allSettled([
    adbUntil(deadline, 'exec-out', 'uiautomator', 'dump', '/dev/tty'),
    adbUntil(deadline, 'shell', 'dumpsys', 'window', 'windows'),
    adbUntil(deadline, 'shell', 'pidof', packageName)
  ]);
  if (!isPrePairing()) return;
  const parsed = hierarchy.status === 'fulfilled' ? parseAndroidUiNodes(normalizeNativeXmlAttributes(hierarchy.value)) : undefined;
  const responses = current.webRtcResponses.slice(0, 32);
  const directory = join(dirname(apkPath!), 'ui-evidence');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'connection-identity-error.json'), JSON.stringify({
    scope: 'owned-avd-transport-identity-before-pairing', transport: connectionTransport, target: { serial, avd: actualAvd },
    httpConnectRequests: connectionTransport === 'http-connect' ? current.httpConnectRequests : undefined,
    transportPhase: connectionTransport === 'http-connect' ? (current.httpConnectRequests > (evidence?.httpConnect?.beforePairing ?? 0) ? 'connect-request-observed' : 'no-mobile-connect-request-observed')
      : responses.some(response => response.path.startsWith('/joko.v1.')) ? 'application-response-observed'
      : current.webRtcSignalingRequests > 0 ? 'signaling-request-observed' : 'no-signaling-request-observed',
    signalingRequests: current.webRtcSignalingRequests, responses,
    appProcessId: processId.status === 'fulfilled' && /^[0-9\s]*$/u.test(processId.value) ? processId.value.trim().slice(0, 256) : undefined,
    currentFocus: focus.status === 'fulfilled' ? focus.value.split(/\r?\n/u).filter(line => /mCurrentFocus=|mFocusedApp=|mTopFocusedDisplayId=/u.test(line)).slice(0, 16).map(line => line.slice(0, 512)) : undefined,
    focusedElements: hierarchy.status === 'fulfilled' ? [...hierarchy.value.matchAll(/<node\b[^>]*\bfocused="true"[^>]*>/gu)].slice(0, 16).map(match => match[0].slice(0, 2048)) : undefined,
    hierarchyTruncated: parsed?.truncated === true || (parsed?.nodes.length ?? 0) > 256,
    nodes: parsed?.nodes.slice(0, 256).map(node => ({ packageName: node.packageName, className: node.className,
      text: node.text?.slice(0, 240), label: node.contentDescription?.slice(0, 240), enabled: node.enabled, focusable: node.focusable, bounds: node.bounds }))
  }, null, 2) + '\n');
  // No challenge has been issued and no transient pairing code was entered.
  if (isPrePairing()) await screenshot('connection-identity-error');
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

async function scrollToNode(
  predicate: (node: AndroidUiNode) => boolean,
  label: string,
  direction: "earlier" | "later" = "later",
): Promise<AndroidUiNode> {
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const items = await nodes();
    const node = items.find(entry => entry.bounds.x2 > entry.bounds.x1 && entry.bounds.y2 > entry.bounds.y1 && predicate(entry));
    if (node) return node;
    const viewport = items.filter(entry => entry.scrollable && entry.enabled
      && entry.bounds.x2 > entry.bounds.x1 && entry.bounds.y2 > entry.bounds.y1)
      .sort((left, right) => (right.bounds.x2 - right.bounds.x1) * (right.bounds.y2 - right.bounds.y1)
        - (left.bounds.x2 - left.bounds.x1) * (left.bounds.y2 - left.bounds.y1))[0];
    if (!viewport) break;
    const x = Math.round((viewport.bounds.x1 + viewport.bounds.x2) / 2);
    const inset = Math.max(1, Math.round((viewport.bounds.y2 - viewport.bounds.y1) * 0.15));
    // Stay inside the observed app viewport: a bottom-edge swipe invokes Home.
    const top = viewport.bounds.y1 + inset;
    const bottom = viewport.bounds.y2 - inset;
    const [start, end] = direction === "earlier" ? [top, bottom] : [bottom, top];
    await interaction("swipe", () => adb("shell", "input", "swipe", String(x), String(start), String(x), String(end), "300"));
  }
  return waitNode(predicate, label);
}

async function tap(label: string, scroll = false, leadingText = false): Promise<void> {
  await interaction("tap", () => tapSurface(label, scroll, leadingText));
}

async function openFixtureTask(): Promise<void> {
  let previousBounds: string | undefined;
  const task = await waitFor(async () => {
    const items = await nodes();
    const addPartner = items.find((item) => item.enabled && item.clickable && item.contentDescription === "Create Partner or group");
    const row = items.find((item) => item.enabled && item.clickable && item.contentDescription === "Open task " + taskName);
    // The roster above the task is populated after pairing and can move the row.
    if (!addPartner || !row || row.bounds.y1 < addPartner.bounds.y2
      || row.bounds.x1 >= row.bounds.x2 || row.bounds.y1 >= row.bounds.y2) {
      previousBounds = undefined;
      return undefined;
    }
    const bounds = JSON.stringify(row.bounds);
    const stable = bounds === previousBounds;
    previousBounds = bounds;
    return stable ? row : undefined;
  }, (row) => row !== undefined, "stable Home task row below the Partner roster", 25_000);
  await interaction("tap", () => tapNode(task!));
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

async function tapNode(node: AndroidUiNode, leadingText = false, deadline?: number): Promise<void> {
  // Native selectable text reports paragraph bounds. Touch the LTR fixture's first glyph, not trailing empty space.
  const x = leadingText && !node.contentDescription ? node.bounds.x1 + Math.min(12, (node.bounds.x2 - node.bounds.x1) / 2)
    : (node.bounds.x1 + node.bounds.x2) / 2;
  await adbUntil(deadline, "shell", "input", "tap", String(Math.round(x)),
    String(Math.round((node.bounds.y1 + node.bounds.y2) / 2)));
}

async function fill(label: string, value: string, scroll = false, verifyTrustedIdentity = false): Promise<void> {
  if (verifyTrustedIdentity && label !== 'Trusted node invitation or public key' || value.startsWith('{') && !verifyTrustedIdentity) {
    throw new Error('A native invitation requires its complete trusted input gate.');
  }
  await interaction("text-entry", async () => {
    if (value.length > 32768 || !/^[A-Za-z0-9 .,:/_+\-{}"\[\]]+$/u.test(value)) throw new Error("Native fixture input must be bounded shell-safe ASCII.");
    await tap(label, scroll);
    await adb("shell", "input", "keyevent", "--longpress", "KEYCODE_MOVE_END");
    // The allowlist excludes apostrophes and every shell expansion character;
    // remote single quotes preserve the invitation's literal JSON punctuation.
    if (value.startsWith('{')) {
      // Bound the entire native text operation by its original 30s command
      // budget. Each real prefix receipt lets the controlled WebView settle
      // before more key events; the full-value gate below remains mandatory.
      const deadline = Date.now() + 30_000;
      for (let offset = 0; offset < value.length; offset += 48) {
        const chunk = value.slice(offset, offset + 48), prefix = value.slice(0, offset + chunk.length);
        await adbUntil(deadline, "shell", "input", "text", "'" + chunk.replaceAll(" ", "%s") + "'");
        // The final block uses the original complete-value gate below rather
        // than spending the input budget on the same full hierarchy twice.
        if (offset + chunk.length < value.length) await waitFor(() => nodes(deadline), items => items.some(node => node.enabled
          && node.className === 'android.widget.EditText' && node.text === prefix),
        'complete native invitation input prefix', Math.max(1, deadline - Date.now()));
      }
    } else await adb("shell", "input", "text", "'" + value.replaceAll(" ", "%s") + "'");
    await adb("shell", "input", "keyevent", "KEYCODE_BACK");
  });
  if (verifyTrustedIdentity) await waitNode(node => node.enabled && node.className === 'android.widget.EditText' && node.text === value,
    'native trusted endpoint public key');
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

async function screenshot(name: EvidenceScreenshot): Promise<EvidenceStep["screenshots"][number]> {
  const deadline = Date.now() + 30_000;
  const capture = async (): Promise<Buffer | undefined> => {
    // Read the actual framebuffer in one ADB command. A disconnected stream
    // can end before the final PNG chunk arrives.
    const png = await adbOutput(deadline, ["exec-out", "screencap", "-p"], 8 * 1024 * 1024);
    return png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      && png.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex")) ? png : undefined;
  };
  let png = await capture().catch((error: unknown) => {
    if (!(error instanceof AndroidFixtureAdbError) || !error.deviceUnavailable) throw error;
    return undefined;
  });
  if (png === undefined) {
    // Only repeat the screenshot read after the owned emulator is reachable.
    await adbUntil(deadline, "wait-for-device");
    const actualAvd = (await adbUntil(deadline, "emu", "avd", "name")).split(/\r?\n/u)[0]?.trim();
    if (!ownedAvd || actualAvd !== avd) throw new Error("The owned Android emulator changed during screenshot capture.");
    png = await capture();
  }
  if (png === undefined) throw new Error("The Android screenshot did not contain a complete PNG.");

  const directory = join(dirname(apkPath!), "ui-evidence");
  await mkdir(directory, { recursive: true });
  const file = name + ".png";
  await writeFile(join(directory, file), png);
  const frame = { file, sha256: createHash("sha256").update(png).digest("hex"), capturedAfterMs: elapsed() };
  activeStep?.screenshots.push(frame);
  await persistEvidence();
  return frame;
}
