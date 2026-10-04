import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { capabilityNames, RunState } from "@joko/contracts";
import type { AdapterContext, PromptInput, SessionTree } from "@joko/core";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { parseAndroidUiNodes, type AndroidUiNode } from "@joko/tool-android";
import { afterEach, expect, it } from "vitest";

import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

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

afterEach(async () => {
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
}, 90_000);

nativeIt("pairs, sends through native rich input, opens canonical resources, and resumes without resending", {
  timeout: 360_000
}, async () => {
  if (!serial || !/^emulator-\d+$/u.test(serial) || !avd?.startsWith("joko-")
    || !adbExecutable || !isAbsolute(adbExecutable) || !apkPath || !isAbsolute(apkPath)) {
    throw new Error("Native Android evidence requires an explicit isolated Joko AVD and absolute tool/artifact paths.");
  }
  expect((await adb("emu", "avd", "name")).split(/\r?\n/u)[0]?.trim()).toBe(avd);
  expect((await adb("shell", "getprop", "ro.kernel.qemu")).trim()).toBe("1");
  expect((await adb("shell", "getprop", "sys.boot_completed")).trim()).toBe("1");
  ownedAvd = true;

  const apk = resolve(apkPath);
  const manifest = JSON.parse(await readFile(join(dirname(apk), "joko-mobile-artifact.json"), "utf8")) as {
    platform: string; source: { commit: string; tree: string };
    application: { package: string }; artifacts: { kind: string; fileName: string; sha256: string }[];
  };
  expect(manifest.platform).toBe("android");
  expect(manifest.source.tree).toBe("clean");
  expect(manifest.application.package).toBe(packageName);
  const artifact = manifest.artifacts.find((entry) => entry.kind === "apk" && entry.fileName === basename(apk));
  if (artifact === undefined) throw new Error("The APK is absent from its native artifact manifest.");
  expect(await digest(apk)).toBe(artifact.sha256);
  const installedPackages = (await adb("shell", "pm", "list", "packages", packageName)).trim().split(/\r?\n/u);
  if (installedPackages.includes("package:" + packageName)) expect((await adb("uninstall", packageName)).trim()).toBe("Success");
  await adb("install", "-r", "--no-streaming", apk);
  expect((await adb("shell", "pm", "clear", packageName)).trim()).toBe("Success");
  const installedPath = (await adb("shell", "pm", "path", packageName)).trim().replace(/^package:/u, "");
  if (!/^\/data\/app\/[^\s]+\/base\.apk$/u.test(installedPath)) throw new Error("Unexpected installed Android artifact path.");
  expect((await adb("shell", "sha256sum", installedPath)).split(/\s/u)[0]).toBe(artifact.sha256);
  await adb("logcat", "-c");

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
  await tap("Workspace image", true);
  await waitNode((node) => node.text === "pixel.png" || node.contentDescription?.includes("pixel.png") === true, "native image gallery");
  await waitNode((node) => node.contentDescription === "Copy image" && node.enabled, "native gallery decode readiness");
  const galleryOpenedAt = Date.now();
  await waitFor(nodes, (items) => Date.now() - galleryOpenedAt >= 13_000
    && items.some((node) => node.text === "pixel.png")
    && items.some((node) => node.contentDescription === "Copy image" && node.enabled),
  "native gallery retained across scheduled observations", 22_000);
  await screenshot("gallery");
  await tap("Close");
  await waitNode((node) => node.text === taskName, "task restored after closing the gallery");
  await screenshot("resource-links");
  await tap("README.md:2:4", true, true);
  await waitNode((node) => node.text?.includes("focus line") === true, "canonical file contents");
  await waitNode((node) => node.text === "Line 2", "canonical file line focus");
  await screenshot("file");

  await adb("shell", "am", "force-stop", packageName);
  expect((await adb("shell", "pidof", packageName)).trim()).toBe("");
  await launch();
  await tap("Saved (1)");
  await tap("Connect", true);
  await tap("Open task " + taskName);
  await waitNode((node) => node.text === taskName, "restored native task title");
  await scrollToNode((node) => node.text?.includes(prompt) === true, "persisted native task input");
  await tap("README.md:2:4", true, true);
  await waitNode((node) => node.text?.includes("focus line") === true, "restored canonical file contents");
  await screenshot("restored");
  expect(current.adapter(profile.id).sendCalls).toHaveLength(1);
  expect(current.application.store.listRuns({ sessionId })).toHaveLength(1);
  expect(current.application.store.listConnections().filter((connection) => connection.deviceId === mobileDevices[0]!.id)).toHaveLength(1);
  expect(await adb("logcat", "-b", "crash", "-d", "-v", "brief")).not.toMatch(/app\.joko\.mobile|ReactNativeJS|Hermes/u);
  const run = current.application.store.listRuns({ sessionId })[0]!;
  expect((await manager.clients.run.getRun({ runId: run.descriptor.id })).run?.state).toBe(RunState.SUCCEEDED);
});

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
    if (label === "native gallery decode readiness" || label === "canonical file contents" || label === "restored canonical file contents"
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
    await adb("shell", "input", "swipe", "540", "1850", "540", "800", "300");
  }
  return waitNode(predicate, label);
}

async function tap(label: string, scroll = false, leadingText = false): Promise<void> {
  const observedResources: string[] = [];
  for (let attempt = 0; attempt < (scroll ? 7 : 1); attempt += 1) {
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
    if (scroll) await adb("shell", "input", "swipe", "540", "1850", "540", "800", "300");
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
  if (!/^[A-Za-z0-9 .,:/_+-]+$/u.test(value)) throw new Error("Native fixture input must be bounded shell-safe ASCII.");
  await tap(label, scroll);
  await adb("shell", "input", "keyevent", "--longpress", "KEYCODE_MOVE_END");
  await adb("shell", "input", "text", value.replaceAll(" ", "%s"));
  await adb("shell", "input", "keyevent", "KEYCODE_BACK");
}

async function launch(): Promise<void> {
  expect(await adb("shell", "am", "start", "-W", "-n", packageName + "/.MainActivity")).toContain("Status: ok");
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

async function screenshot(name: string): Promise<void> {
  const directory = join(dirname(apkPath!), "ui-evidence");
  await mkdir(directory, { recursive: true });
  const remote = "/sdcard/joko-native-" + name + ".png";
  await adb("shell", "screencap", "-p", remote);
  await adb("pull", remote, join(directory, name + ".png"));
  await adb("shell", "rm", remote);
}
