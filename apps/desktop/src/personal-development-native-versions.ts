import { app, shell } from "electron";
import type { ChildProcess } from "node:child_process";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  awaitNativeCondition, describeOriginalPersonalRuntime, initializePersonalNativeRoot, launchPath, NATIVE_UUID,
  newPersonalNativeIdentity, PERSONAL_HELPER_FLAG, PERSONAL_PROFILE_FLAG, PERSONAL_TEST_FLAG, personalNativeBirth,
  nativeProfileIdentity, readNativeLaunch, readNativeRecord, spawnPersonalNative, verifyPersonalNativeRuntime, writeNativeRecord,
  type PersonalNativeLaunch, type PersonalNativeRuntime
} from "./personal-development-native-runtime.js";
import { markPersonalVersionStartupReady, personalVersionStartup, type PersonalTestLaunchRecord } from "./personal-development-version-bootstrap.js";

export interface PersonalNativeHostSnapshot {
  readonly hostInstanceId: string; readonly profileIdentity: string;
  readonly original: PersonalNativeRuntime; readonly current: PersonalNativeRuntime;
  readonly busy: boolean; readonly launchTicketId: string;
}
export class DesktopPersonalDevelopmentVersions {
  readonly hostInstanceId = newPersonalNativeIdentity();
  readonly #children = new Map<string, ChildProcess>();
  #original: PersonalNativeRuntime | undefined;
  #current: PersonalNativeRuntime | undefined;
  #initialization: Promise<void> | undefined;
  #handoff: string | undefined;
  readonly #acknowledgedTickets = new Set<string>();
  constructor(readonly options: { readonly profileDirectory: string; readonly schemaPath: string;
    readonly isMainWindowReady: () => boolean; readonly managedProcessId: () => number | undefined;
    readonly quitForHandoff: () => Promise<void> }) {}

  initialize(): Promise<void> {
    return this.#initialization ??= (async () => {
      await initializePersonalNativeRoot(this.options.profileDirectory);
      const startup = personalVersionStartup();
      this.#original = startup?.launch?.original ?? startup?.test?.original ?? await describeOriginalPersonalRuntime({
        executable: process.execPath, appPath: app.getAppPath(), development: !app.isPackaged, version: app.getVersion(), schemaPath: this.options.schemaPath });
      this.#current = startup?.launch?.target ?? startup?.test?.target ?? this.#original;
      await writeNativeRecord(join(this.options.profileDirectory, "personal-development-native", "original.json"), this.#original);
    })();
  }
  async snapshot(): Promise<PersonalNativeHostSnapshot> {
    await this.initialize();
    const startup = personalVersionStartup();
    if (startup && this.options.isMainWindowReady()) await markPersonalVersionStartupReady(this.options.managedProcessId());
    let launchTicketId = startup?.launch && this.options.isMainWindowReady() && !(startup.launch as PersonalNativeLaunch & { automatic?: boolean }).automatic ? startup.launch.ticketId : "";
    if (this.#handoff) {
      const record = await readNativeLaunch(this.options.profileDirectory, this.#handoff);
      if (["failed", "unknown"].includes(record.state)) launchTicketId = record.ticketId;
    }
    if (this.#acknowledgedTickets.has(launchTicketId)) launchTicketId = "";
    return { hostInstanceId: this.hostInstanceId, profileIdentity: nativeProfileIdentity(this.options.profileDirectory),
      original: this.#original!, current: this.#current!, launchTicketId,
      busy: startup?.test !== undefined || await this.#testWritersBusy() || this.#handoff !== undefined };
  }
  acknowledgeRegistration(ticketId: string): void {
    if (!ticketId) return; this.#acknowledgedTickets.add(ticketId);
    if (this.#handoff === ticketId) this.#handoff = undefined;
  }
  async reveal(path: string, signal: AbortSignal): Promise<void> {
    const expectedRoot = await realpath(join(this.options.profileDirectory, "orchestrator", "personal-development"));
    const canonical = await realpath(path), rel = relative(expectedRoot, canonical), info = await lstat(path);
    if (!isAbsolute(path) || canonical !== path || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !info.isFile() || info.isSymbolicLink()) throw new Error("Build reveal has no owned local artifact.");
    signal.throwIfAborted(); shell.showItemInFolder(path);
  }
  async openDirectory(directory: "source" | "tools", signal: AbortSignal): Promise<void> {
    if (directory !== "source" && directory !== "tools") throw new Error("Unknown personal development directory.");
    const root = join(this.options.profileDirectory, "orchestrator", "personal-development"), target = join(root, directory);
    const assertOwned = async (): Promise<void> => {
      const rootInfo = await lstat(root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) throw new Error("Personal directory has no current profile owner.");
      signal.throwIfAborted();
    };
    await assertOwned();
    if (directory === "tools") { signal.throwIfAborted(); await mkdir(target, { recursive: false, mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }); }
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(target) !== target) throw new Error("Personal directory is unavailable.");
    await assertOwned(); signal.throwIfAborted();
    const failure = await shell.openPath(target); await assertOwned();
    if (failure !== "") throw new Error("Personal directory could not be opened.");
  }
  async prepareHandoff(ticketId: string, target: PersonalNativeRuntime, signal: AbortSignal): Promise<void> {
    await this.initialize(); if (!NATIVE_UUID.test(ticketId) || this.#handoff && this.#handoff !== ticketId) throw new Error("Native version handoff is busy.");
    if (target.compatibilityIdentity !== this.#original!.compatibilityIdentity) throw new Error("Native version is incompatible.");
    await verifyPersonalNativeRuntime(target);
    signal.throwIfAborted();
    const currentPath = launchPath(this.options.profileDirectory, ticketId), existing = await readNativeRecord<PersonalNativeLaunch>(currentPath);
    if (existing) {
      if (existing.target.runtimeDigest !== target.runtimeDigest || existing.parentPid !== process.pid || existing.parentBirth !== personalNativeBirth(process.pid)
        || existing.state !== "prepared") throw new Error("The native handoff already has an effect or unknown outcome.");
      this.#handoff = ticketId; return;
    }
    const parentBirth = personalNativeBirth(process.pid), parentServicePid = this.options.managedProcessId();
    const parentServiceBirth = parentServicePid === undefined ? undefined : personalNativeBirth(parentServicePid);
    if (!parentBirth || parentServicePid === undefined || !parentServiceBirth) throw new Error("Native version parent birth is unconfirmed.");
    const record: PersonalNativeLaunch = { format: 1, ticketId, profileDirectory: this.options.profileDirectory,
      target: target.id === "original" ? { ...target, appPath: this.#original!.appPath } : target,
      previous: this.#current!, original: this.#original!, parentPid: process.pid, parentBirth, parentServicePid, parentServiceBirth, helperExecutable: process.execPath,
      ...(app.isPackaged ? {} : { helperAppPath: app.getAppPath() }), state: "prepared" };
    await writeNativeRecord(currentPath, record); this.#handoff = ticketId;
  }
  async executeHandoff(ticketId: string, signal: AbortSignal): Promise<void> {
    if (this.#handoff !== ticketId) throw new Error("Native handoff has not been prepared.");
    const record = await readNativeLaunch(this.options.profileDirectory, ticketId);
    if (record.state !== "prepared" || record.parentBirth !== personalNativeBirth(process.pid)) throw new Error("Native handoff execution is unavailable.");
    signal.throwIfAborted();
    const helperRuntime = { ...this.#current!, executable: record.helperExecutable, development: !app.isPackaged,
      ...(record.helperAppPath ? { appPath: record.helperAppPath } : {}) };
    const helper = spawnPersonalNative(helperRuntime, [`${PERSONAL_HELPER_FLAG}${ticketId}`, `${PERSONAL_PROFILE_FLAG}${this.options.profileDirectory}`]);
    await new Promise<void>((done, fail) => { helper.once("spawn", done); helper.once("error", fail); });
    const helperBirth = helper.pid === undefined ? undefined : personalNativeBirth(helper.pid);
    if (!helper.pid || !helperBirth || !await awaitNativeCondition(async () => {
      const latest = await readNativeLaunch(this.options.profileDirectory, ticketId);
      return latest.state === "waiting" && latest.helperPid === helper.pid && latest.helperBirth === helperBirth;
    }, 90_000)) throw new Error("Native handoff helper was not confirmed.");
    helper.unref();
    try { await this.options.quitForHandoff(); }
    catch (error) { await this.abandonHandoff(ticketId); throw error; }
  }
  /** No native launch effect may follow a lost prepare response or a blocked quit. */
  async abandonHandoff(ticketId: string): Promise<void> {
    if (this.#handoff !== ticketId) return;
    const record = await readNativeLaunch(this.options.profileDirectory, ticketId);
    if (["prepared", "waiting"].includes(record.state) && record.parentPid === process.pid && record.parentBirth === personalNativeBirth(process.pid)) {
      await writeNativeRecord(`${launchPath(this.options.profileDirectory, ticketId)}.cancel`, { ticketId, parentBirth: record.parentBirth });
      await writeNativeRecord(launchPath(this.options.profileDirectory, ticketId), { ...record, state: "failed" });
    }
  }
  async startTest(input: { readonly taskId: string; readonly sessionId: string; readonly completionId: string; readonly target: PersonalNativeRuntime }, signal: AbortSignal): Promise<string> {
    await this.initialize(); await verifyPersonalNativeRuntime(input.target);
    if (input.target.compatibilityIdentity !== this.#original!.compatibilityIdentity) throw new Error("Personal test runtime is incompatible.");
    const found = await this.findTest(input.taskId, input.completionId);
    if (found.status === "running" && found.receipt) return found.receipt;
    if (found.status === "unknown") throw new Error("An earlier personal test has an unknown outcome.");
    const receipt = newPersonalNativeIdentity(), profileDirectory = join(this.options.profileDirectory, "personal-development-native", "test-profiles", receipt);
    await initializePersonalNativeRoot(profileDirectory);
    const parentBirth = personalNativeBirth(process.pid); if (!parentBirth) throw new Error("Personal test parent is unavailable.");
    const record: PersonalTestLaunchRecord = { format: 1, receipt, taskId: input.taskId, completionId: input.completionId,
      parentPid: process.pid, parentBirth, target: { ...input.target, development: false, appPath: undefined }, original: this.#original!, profileDirectory, state: "starting" };
    const path = join(profileDirectory, "personal-test-launch.json"); await writeNativeRecord(path, record);
    signal.throwIfAborted();
    const child = spawnPersonalNative(record.target, [`${PERSONAL_TEST_FLAG}${receipt}`, `${PERSONAL_PROFILE_FLAG}${profileDirectory}`], true);
    await new Promise<void>((done, fail) => { child.once("spawn", done); child.once("error", fail); });
    const birth = child.pid === undefined ? undefined : personalNativeBirth(child.pid);
    if (!child.pid || !birth) throw new Error("Personal test child birth is unconfirmed.");
    this.#children.set(receipt, child);
    child.once("exit", () => { this.#children.delete(receipt); });
    await writeNativeRecord(path, { ...record, pid: child.pid, birth });
    if (!await awaitNativeCondition(async () => {
      const latest = await readNativeRecord<PersonalTestLaunchRecord>(path);
      return latest?.state === "ready" && latest.pid === child.pid && latest.birth === birth
        && personalNativeBirth(child.pid!) === birth && latest.servicePid !== undefined && personalNativeBirth(latest.servicePid) === latest.serviceBirth;
    }, 90_000)) throw new Error("Personal test readiness is unconfirmed.");
    return receipt;
  }
  async stopTest(receipt: string, signal: AbortSignal): Promise<"retired" | "unknown"> {
    if (!NATIVE_UUID.test(receipt)) throw new Error("Invalid personal test receipt.");
    const path = join(this.options.profileDirectory, "personal-development-native", "test-profiles", receipt, "personal-test-launch.json");
    const record = await readNativeRecord<PersonalTestLaunchRecord>(path); if (!record || record.receipt !== receipt) return "unknown";
    const stopped = () => record.pid !== undefined && record.birth !== undefined && personalNativeBirth(record.pid) !== record.birth
      && record.servicePid !== undefined && record.serviceBirth !== undefined && personalNativeBirth(record.servicePid) !== record.serviceBirth;
    if (stopped()) return "retired";
    const child = this.#children.get(receipt), control = child?.stdio[3];
    if (!control || !("write" in control)) return "unknown";
    signal.throwIfAborted();
    control.write("stop\n");
    const retired = await awaitNativeCondition(stopped, 15_000);
    await writeNativeRecord(path, { ...record, state: retired ? "retired" : "unknown" });
    if (retired) this.#children.delete(receipt); return retired ? "retired" : "unknown";
  }
  async #testWritersBusy(): Promise<boolean> {
    const root = join(this.options.profileDirectory, "personal-development-native", "test-profiles");
    let names: string[];
    try { names = await readdir(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    for (const name of names) {
      if (!NATIVE_UUID.test(name)) throw new Error("Personal test storage contains an invalid entry.");
      const path = join(root, name, "personal-test-launch.json"), record = await readNativeRecord<PersonalTestLaunchRecord>(path);
      if (!record || record.state === "retired") continue;
      if (record.pid === undefined || record.birth === undefined || record.servicePid === undefined || record.serviceBirth === undefined
        || personalNativeBirth(record.pid) === record.birth || personalNativeBirth(record.servicePid) === record.serviceBirth) return true;
      await writeNativeRecord(path, { ...record, state: "retired" }); this.#children.delete(name);
    }
    return false;
  }
  async findTest(taskId: string, completionId: string): Promise<{ status: "running" | "retired" | "unknown"; receipt?: string }> {
    const root = join(this.options.profileDirectory, "personal-development-native", "test-profiles");
    let names: string[]; try { names = await readdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "retired" }; throw error; }
    for (const name of names) {
      if (!NATIVE_UUID.test(name)) throw new Error("Personal test storage contains an invalid entry.");
      const value = await readNativeRecord<PersonalTestLaunchRecord>(join(root, name, "personal-test-launch.json"));
      if (!value || value.taskId !== taskId || value.completionId !== completionId) continue;
      const alive = value.pid !== undefined && value.birth !== undefined && personalNativeBirth(value.pid) === value.birth;
      const serviceAlive = value.servicePid !== undefined && value.serviceBirth !== undefined && personalNativeBirth(value.servicePid) === value.serviceBirth;
      if (alive && serviceAlive && value.state === "ready") return { status: "running", receipt: name };
      if (!alive && !serviceAlive && value.pid !== undefined && value.servicePid !== undefined) return { status: "retired", receipt: name };
      return { status: "unknown", receipt: name };
    }
    return { status: "retired" };
  }
}
