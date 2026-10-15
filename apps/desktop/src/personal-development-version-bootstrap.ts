import { app } from "electron";
import { createReadStream, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  awaitNativeCondition, launchPath, PERSONAL_HELPER_FLAG, PERSONAL_LAUNCH_FLAG, PERSONAL_PROFILE_FLAG, PERSONAL_TEST_FLAG,
  personalNativeBirth, readNativeLaunch, readNativeRecord, spawnPersonalNative, verifyPersonalNativeRuntime, writeNativeRecord,
  type PersonalNativeLaunch, type PersonalNativeRuntime
} from "./personal-development-native-runtime.js";

export interface PersonalTestLaunchRecord {
  readonly format: 1; readonly receipt: string; readonly taskId: string; readonly completionId: string;
  readonly parentPid: number; readonly parentBirth: string; readonly target: PersonalNativeRuntime;
  readonly original: PersonalNativeRuntime; readonly profileDirectory: string;
  readonly state: "starting" | "ready" | "retired" | "unknown";
  readonly pid?: number; readonly birth?: string; readonly servicePid?: number; readonly serviceBirth?: string;
}
export interface PersonalVersionStartupContext {
  readonly profileDirectory: string; readonly launch?: PersonalNativeLaunch; readonly test?: PersonalTestLaunchRecord;
}
let startup: PersonalVersionStartupContext | undefined;
let startupReady = false;
const flag = (prefix: string) => process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
function readLaunchSync(profile: string, ticketId: string): PersonalNativeLaunch {
  if (!isAbsolute(profile) || realpathSync.native(profile) !== profile) throw new Error("Native launch profile is invalid.");
  const path = launchPath(profile, ticketId), raw = readFileSync(path, "utf8");
  if (raw.length > 256 * 1024) throw new Error("Native launch record is oversized.");
  const value = JSON.parse(raw) as PersonalNativeLaunch;
  if (value.format !== 1 || value.ticketId !== ticketId || value.profileDirectory !== profile || value.state !== "starting"
    || value.helperPid !== process.ppid || !value.helperBirth || personalNativeBirth(process.ppid) !== value.helperBirth) throw new Error("Native launch owner is unavailable.");
  return value;
}
function atomicNativeSync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); renameSync(temporary, path);
}

/** Runs synchronously before Main installs protocols and obtains its profile lock. */
export function preparePersonalVersionBootstrap(): { readonly helper: boolean; readonly redirect: boolean } {
  const helperId = flag(PERSONAL_HELPER_FLAG), profile = flag(PERSONAL_PROFILE_FLAG), launchId = flag(PERSONAL_LAUNCH_FLAG), testId = flag(PERSONAL_TEST_FLAG);
  if (helperId) return { helper: true, redirect: false };
  if (launchId || testId) {
    if (!profile || !isAbsolute(profile) || realpathSync.native(profile) !== profile || (launchId && testId)) throw new Error("Personal native profile is unavailable.");
    if (launchId) startup = { profileDirectory: profile, launch: readLaunchSync(profile, launchId) };
    else {
      const value = JSON.parse(readFileSync(join(profile, "personal-test-launch.json"), "utf8")) as PersonalTestLaunchRecord;
      if (value.format !== 1 || value.receipt !== testId || value.profileDirectory !== profile || value.state !== "starting"
        || value.parentPid !== process.ppid || personalNativeBirth(process.ppid) !== value.parentBirth) throw new Error("Personal native test owner is unavailable.");
      startup = { profileDirectory: profile, test: value };
    }
    app.setPath("userData", profile);
    const input = createReadStream("", { fd: 3, autoClose: true });
    const stop = () => { if (startup?.test || !startupReady) void app.whenReady().then(() => app.quit()); };
    input.on("data", stop); input.once("end", stop); input.once("error", stop);
    return { helper: false, redirect: false };
  }
  const originalProfile = app.isPackaged ? app.getPath("userData") : resolve(app.getPath("appData"), "Joko Development");
  let selected: { format: number; runtime: PersonalNativeRuntime; original: PersonalNativeRuntime } | undefined;
  try { selected = JSON.parse(readFileSync(join(originalProfile, "personal-development-native", "selected.json"), "utf8")) as typeof selected; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!selected || selected.format !== 1 || selected.runtime.id !== "personal") return { helper: false, redirect: false };
  const ticketId = randomUUID(), parentBirth = personalNativeBirth(process.pid);
  if (!parentBirth) throw new Error("Native startup identity is unavailable.");
  const record: PersonalNativeLaunch & { readonly automatic: true } = { format: 1, ticketId, profileDirectory: realpathSync.native(originalProfile),
    target: selected.runtime, previous: selected.original, original: selected.original, parentPid: process.pid, parentBirth,
    helperExecutable: process.execPath, ...(app.isPackaged ? {} : { helperAppPath: app.getAppPath() }), state: "prepared", automatic: true };
  atomicNativeSync(launchPath(record.profileDirectory, ticketId), record);
  void app.whenReady().then(() => {
    const child = spawnPersonalNative({ ...record.original, executable: process.execPath, development: !app.isPackaged, appPath: app.getAppPath() },
      [`${PERSONAL_HELPER_FLAG}${ticketId}`, `${PERSONAL_PROFILE_FLAG}${record.profileDirectory}`]);
    child.once("spawn", () => { child.unref(); app.exit(0); }); child.once("error", () => app.exit(1));
  });
  return { helper: false, redirect: true };
}
export function personalVersionStartup(): PersonalVersionStartupContext | undefined { return startup; }
export function personalVersionProfileOverride(): string | undefined { return startup?.profileDirectory; }

export async function markPersonalVersionStartupReady(servicePid: number | undefined): Promise<void> {
  if (!startup || startupReady) return;
  const birth = personalNativeBirth(process.pid), serviceBirth = servicePid === undefined ? undefined : personalNativeBirth(servicePid);
  if (!birth || servicePid === undefined || !serviceBirth) throw new Error("Personal native startup has no managed-service proof.");
  const expected = startup.test?.target ?? startup.launch?.target;
  if (!expected || await realExecutable() !== expected.executable) throw new Error("Personal native executable does not match its launch.");
  await verifyPersonalNativeRuntime(expected);
  if (startup.test) {
    const path = join(startup.profileDirectory, "personal-test-launch.json");
    const reserved = await readNativeRecord<PersonalTestLaunchRecord>(path);
    if (reserved?.pid !== process.pid || reserved.birth !== birth || reserved.receipt !== startup.test.receipt) throw new Error("Personal test child has not been durably claimed.");
    await writeNativeRecord(path, { ...reserved, state: "ready", pid: process.pid, birth, servicePid, serviceBirth });
  } else {
    const record = await readNativeLaunch(startup.profileDirectory, startup.launch!.ticketId);
    if (record.childPid !== process.pid || record.childBirth !== birth) throw new Error("Personal native launch generation changed.");
    await writeNativeRecord(launchPath(startup.profileDirectory, record.ticketId), { ...record, state: "ready", servicePid, serviceBirth });
  }
  startupReady = true;
}
async function realExecutable(): Promise<string> { const { realpath } = await import("node:fs/promises"); return realpath(process.execPath); }

/** A one-shot, profile-bound supervisor copied from the fixed native handoff topology. */
export async function runPersonalVersionHelper(): Promise<void> {
  const profile = flag(PERSONAL_PROFILE_FLAG), id = flag(PERSONAL_HELPER_FLAG);
  if (!profile || !id) throw new Error("Personal native helper has no launch owner.");
  let record = await readNativeLaunch(profile, id);
  if (record.state !== "prepared" || record.parentPid !== process.ppid || personalNativeBirth(process.ppid) !== record.parentBirth) throw new Error("Personal native helper parent is unavailable.");
  let initialOutcome: "ready" | "failed" = "ready";
  try { await verifyPersonalNativeRuntime(record.target); }
  catch { await verifyPersonalNativeRuntime(record.previous); record = { ...record, target: record.previous }; initialOutcome = "failed"; }
  const canceledByOwner = async () => {
    const value = await readNativeRecord<{ ticketId: string; parentBirth: string }>(`${launchPath(profile, id)}.cancel`);
    return value?.ticketId === id && value.parentBirth === record.parentBirth;
  };
  if (await canceledByOwner()) { app.exit(1); return; }
  const helperBirth = personalNativeBirth(process.pid); if (!helperBirth) throw new Error("Personal helper birth proof is unavailable.");
  record = { ...record, state: "waiting", helperPid: process.pid, helperBirth };
  await writeNativeRecord(launchPath(profile, id), record);
  await app.whenReady(); app.dock?.hide();
  let canceled = false;
  if (!await awaitNativeCondition(async () => {
    const latest = await readNativeLaunch(profile, id); canceled = latest.state === "failed" || await canceledByOwner();
    return canceled || personalNativeBirth(record.parentPid) !== record.parentBirth
      && (record.parentServicePid === undefined || record.parentServiceBirth !== undefined
        && personalNativeBirth(record.parentServicePid) !== record.parentServiceBirth);
  }, 90_000)) {
    await writeNativeRecord(launchPath(profile, id), { ...record, state: "failed" }); app.exit(1); return;
  }
  if (canceled || await canceledByOwner()) { app.exit(1); return; }
  const launch = async (target: PersonalNativeRuntime, outcome: "ready" | "failed"): Promise<boolean> => {
    await verifyPersonalNativeRuntime(target);
    record = { ...record, target, state: "starting", outcome, childPid: undefined, childBirth: undefined,
      servicePid: undefined, serviceBirth: undefined };
    await writeNativeRecord(launchPath(profile, id), record);
    const child = spawnPersonalNative(target, [`${PERSONAL_LAUNCH_FLAG}${id}`, `${PERSONAL_PROFILE_FLAG}${profile}`], true);
    await new Promise<void>((resolveSpawn, reject) => { child.once("spawn", resolveSpawn); child.once("error", reject); });
    const childBirth = child.pid === undefined ? undefined : personalNativeBirth(child.pid);
    if (!child.pid || !childBirth) throw new Error("Personal native child birth is unconfirmed.");
    record = { ...record, childPid: child.pid, childBirth }; await writeNativeRecord(launchPath(profile, id), record);
    const ready = await awaitNativeCondition(async () => {
      const latest = await readNativeLaunch(profile, id);
      return latest.state === "ready" && latest.childPid === child.pid && latest.childBirth === childBirth
        && personalNativeBirth(child.pid!) === childBirth;
    }, 90_000);
    if (ready) { await writeNativeRecord(join(profile, "personal-development-native", "selected.json"), { format: 1, runtime: target, original: record.original }); child.unref(); return true; }
    const control = child.stdio[3]; if (control && "write" in control) control.write("stop\n");
    // Unknown native shutdown never authorizes starting another writer on the same profile.
    if (!await awaitNativeCondition(() => personalNativeBirth(child.pid!) !== childBirth, 15_000)) throw new Error("Personal native shutdown is unconfirmed.");
    const stopped = await readNativeLaunch(profile, id);
    if (stopped.servicePid === undefined || stopped.serviceBirth === undefined || personalNativeBirth(stopped.servicePid) === stopped.serviceBirth) {
      throw new Error("Personal native service retirement is unconfirmed.");
    }
    return false;
  };
  try {
    if (await launch(record.target, initialOutcome)) { app.exit(0); return; }
    if (initialOutcome === "ready" && await launch(record.previous, "failed")) { app.exit(0); return; }
    await writeNativeRecord(launchPath(profile, id), { ...record, state: "failed" }); app.exit(1);
  } catch {
    await writeNativeRecord(launchPath(profile, id), { ...record, state: "unknown" }); app.exit(1);
  }
}
