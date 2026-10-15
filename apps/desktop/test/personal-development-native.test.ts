import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonalNativeLaunch, PersonalNativeRuntime } from "../src/personal-development-native-runtime.js";

const native = vi.hoisted(() => ({ birth: vi.fn<(pid: number) => string | undefined>(), spawn: vi.fn(), verify: vi.fn(), describe: vi.fn(),
  awaitCondition: vi.fn<(test: () => boolean | Promise<boolean>, timeout: number) => Promise<boolean>>(), exit: vi.fn(), openPath: vi.fn() }));
vi.mock("electron", () => ({ app: { isPackaged: true, getAppPath: () => "", getVersion: () => "0.1.0", whenReady: async () => undefined,
  exit: native.exit, dock: undefined }, shell: { showItemInFolder: vi.fn(), openPath: native.openPath } }));
vi.mock("../src/personal-development-native-runtime.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/personal-development-native-runtime.js")>(),
  personalNativeBirth: native.birth, spawnPersonalNative: native.spawn, verifyPersonalNativeRuntime: native.verify,
  describeOriginalPersonalRuntime: native.describe, awaitNativeCondition: native.awaitCondition
}));
import { DesktopPersonalDevelopmentVersions } from "../src/personal-development-native-versions.js";
import { runPersonalVersionHelper, type PersonalTestLaunchRecord } from "../src/personal-development-version-bootstrap.js";
import { launchPath, PERSONAL_HELPER_FLAG, PERSONAL_PROFILE_FLAG, readNativeRecord, writeNativeRecord } from "../src/personal-development-native-runtime.js";

const paths: string[] = [];
const argv = [...process.argv];
beforeEach(() => { vi.clearAllMocks(); native.verify.mockResolvedValue(undefined); native.birth.mockImplementation(pid => pid === process.pid ? "self" : pid === process.ppid ? "parent" : pid === 22 ? "service" : undefined);
  native.awaitCondition.mockImplementation(async test => test()); native.openPath.mockResolvedValue(""); });
afterEach(async () => { process.argv = [...argv]; for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
async function setup() {
  const profile = await mkdtemp(join(tmpdir(), "joko-native-version-")); paths.push(profile);
  const original: PersonalNativeRuntime = { id: "original", generation: "", executable: join(profile, "app.exe"), runtimeDirectory: profile,
    runtimeDigest: "a".repeat(64), compatibilityIdentity: "b".repeat(64), version: "0.1.0", development: false };
  native.describe.mockResolvedValue(original);
  const quit = vi.fn().mockResolvedValue(undefined);
  const driver = new DesktopPersonalDevelopmentVersions({ profileDirectory: profile, schemaPath: join(profile, "schema.js"),
    isMainWindowReady: () => true, managedProcessId: () => 22, quitForHandoff: quit });
  return { profile, original, driver, quit };
}

describe("personal native lifecycle", () => {
  it("opens only fixed source and tools directories without broadening installer reveal", async () => {
    const s = await setup(), root = join(s.profile, "orchestrator", "personal-development"), source = join(root, "source"), tools = join(root, "tools");
    await mkdir(root, { recursive: true });
    await expect(s.driver.openDirectory("source", new AbortController().signal)).rejects.toBeDefined(); expect(native.openPath).not.toHaveBeenCalled();
    await mkdir(source); await s.driver.openDirectory("source", new AbortController().signal); await s.driver.openDirectory("tools", new AbortController().signal);
    expect(native.openPath.mock.calls).toEqual([[source], [tools]]);
    await expect(s.driver.reveal(source, new AbortController().signal)).rejects.toBeDefined();
    await expect(s.driver.openDirectory("../../outside" as "source", new AbortController().signal)).rejects.toBeDefined();
    const controller = new AbortController(); controller.abort(); await expect(s.driver.openDirectory("source", controller.signal)).rejects.toBeDefined();
    await rm(source, { recursive: true }); const outside = join(s.profile, "outside"); await mkdir(outside); await symlink(outside, source, "junction");
    await expect(s.driver.openDirectory("source", new AbortController().signal)).rejects.toBeDefined(); expect(native.openPath).toHaveBeenCalledTimes(2);
  });

  it("retains busy and unknown while a test service outlives its Main, then proves both retired", async () => {
    const s = await setup(), receipt = randomUUID(), path = join(s.profile, "personal-development-native", "test-profiles", receipt, "personal-test-launch.json");
    const test: PersonalTestLaunchRecord = { format: 1, receipt, taskId: "task", completionId: "completion", parentPid: process.pid, parentBirth: "self",
      profileDirectory: join(s.profile, "personal-development-native", "test-profiles", receipt), original: s.original, target: s.original,
      state: "ready", pid: 11, birth: "root", servicePid: 22, serviceBirth: "service" };
    await writeNativeRecord(path, test);
    expect((await s.driver.snapshot()).busy).toBe(true);
    expect(await s.driver.findTest("task", "completion")).toEqual({ status: "unknown", receipt });
    expect(await s.driver.stopTest(receipt, new AbortController().signal)).toBe("unknown");
    native.birth.mockImplementation(pid => pid === process.pid ? "self" : undefined);
    expect((await s.driver.snapshot()).busy).toBe(false);
    expect((await readNativeRecord<PersonalTestLaunchRecord>(path))?.state).toBe("retired");
    expect(await s.driver.findTest("task", "completion")).toEqual({ status: "retired", receipt });
  });

  it("records exact old Main/service proofs and cancels an unexecuted handoff after a lost acknowledgment", async () => {
    const s = await setup(), ticketId = randomUUID(), target = { ...s.original, id: "personal" as const, generation: randomUUID() };
    await s.driver.prepareHandoff(ticketId, target, new AbortController().signal);
    expect(await readNativeRecord<PersonalNativeLaunch>(launchPath(s.profile, ticketId))).toMatchObject({ state: "prepared", parentPid: process.pid,
      parentBirth: "self", parentServicePid: 22, parentServiceBirth: "service", target });
    expect(native.spawn).not.toHaveBeenCalled(); expect(s.quit).not.toHaveBeenCalled();
    await s.driver.abandonHandoff(ticketId);
    expect(JSON.parse(await readFile(`${launchPath(s.profile, ticketId)}.cancel`, "utf8"))).toEqual({ ticketId, parentBirth: "self" });
    expect((await s.driver.snapshot()).launchTicketId).toBe(ticketId);
    s.driver.acknowledgeRegistration(ticketId); expect((await s.driver.snapshot()).busy).toBe(false);
    const aborted = new AbortController(); aborted.abort(); const abortedId = randomUUID();
    await expect(s.driver.prepareHandoff(abortedId, target, aborted.signal)).rejects.toBeDefined();
    expect(await readNativeRecord(launchPath(s.profile, abortedId))).toBeUndefined();
  });

  it("does not launch while the old service is alive and honors a durable owner cancellation", async () => {
    const s = await setup(), id = randomUUID();
    const record: PersonalNativeLaunch = { format: 1, ticketId: id, profileDirectory: s.profile, target: s.original, previous: s.original, original: s.original,
      parentPid: process.ppid, parentBirth: "parent", parentServicePid: 22, parentServiceBirth: "service", helperExecutable: s.original.executable, state: "prepared" };
    await writeNativeRecord(launchPath(s.profile, id), record);
    process.argv = [...argv, `${PERSONAL_HELPER_FLAG}${id}`, `${PERSONAL_PROFILE_FLAG}${s.profile}`];
    native.awaitCondition.mockImplementation(async test => { native.birth.mockImplementation(pid => pid === process.pid ? "self" : pid === 22 ? "service" : undefined); return test(); });
    await runPersonalVersionHelper(); expect(native.spawn).not.toHaveBeenCalled(); expect(native.exit).toHaveBeenCalledWith(1);
    native.birth.mockImplementation(pid => pid === process.pid ? "self" : pid === process.ppid ? "parent" : undefined);
    await writeNativeRecord(launchPath(s.profile, id), record);
    await writeNativeRecord(`${launchPath(s.profile, id)}.cancel`, { ticketId: id, parentBirth: "parent" });
    await runPersonalVersionHelper(); expect(native.spawn).not.toHaveBeenCalled();
    expect((await readNativeRecord<PersonalNativeLaunch>(launchPath(s.profile, id)))?.state).toBe("prepared");
  });
});
