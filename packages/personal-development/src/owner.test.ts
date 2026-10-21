import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { PersonalDevelopmentOwner } from "./owner.js";
import { developmentSourceTarget, DevelopmentRepository } from "./repository.js";
import { DevelopmentTools, developmentToolCatalog, extractDevelopmentTool } from "./tools.js";
import { developmentRuntimeCompatibilityIdentity } from "./build.js";
import { exists, PERSONAL_BRANCH, SOURCE_REPOSITORY } from "./storage.js";
import { PersonalDevelopmentError, type DevelopmentOwnerOptions, type DevelopmentProcessInput, type DevelopmentToolCheck, type DevelopmentWorktreeLease } from "./types.js";
import { createDevelopmentProcessAuthority } from "./process.js";

const execute = promisify(execFile);
const hostPath = process.env.PATH ?? process.env.Path ?? "";
const cleanup: string[] = [];
const signal = new AbortController().signal;
afterEach(async () => {
  for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execute("git", ["-c", "user.name=Joko", "-c", "user.email=owner-test@localhost.invalid", "-c", "commit.gpgSign=false", ...args], { cwd, windowsHide: true })).stdout.trim();
}
async function runtime(directory: string): Promise<void> {
  const resources = join(directory, "resources", "orchestrator-runtime", "node_modules", "@joko", "store", "dist");
  await mkdir(resources, { recursive: true }); await writeFile(join(resources, "schema.js"), "export const schema = 1;\n");
  await writeFile(join(directory, "Joko.exe"), "controlled native executable\n");
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-personal-owner-"))); cleanup.push(root);
  const source = join(root, "source"); await mkdir(source);
  await git(source, ["init", "-b", PERSONAL_BRANCH]); await git(source, ["remote", "add", "origin", SOURCE_REPOSITORY]);
  await git(source, ["config", "--local", "core.autocrlf", "false"]);
  await writeFile(join(source, ".gitignore"), "apps/desktop/release/\nnode_modules/\n");
  await writeFile(join(source, "package.json"), "{\"name\":\"joko\",\"version\":\"0.1.0\"}\n");
  await writeFile(join(source, "feature.txt"), "base\n");
  await git(source, ["add", "."]); await git(source, ["commit", "-m", "chore: establish source"]);
  const original = join(root, "original"); await runtime(original);
  const compatibilityIdentity = await developmentRuntimeCompatibilityIdentity(original, "win32");
  const fakeTools = join(root, "controlled-tools"); await mkdir(fakeTools);
  for (const name of ["node", "pnpm", "python3", "git-lfs"]) await writeFile(join(fakeTools, `${name}.exe`), "controlled tool port\n");
  const fakeGit = join(root, "controlled-git"); await mkdir(fakeGit);
  await writeFile(join(fakeGit, "git.exe"), "controlled host Git port\n");
  const leases = new Map<string, DevelopmentWorktreeLease>();
  const released = new Map<string, string>();
  let failCheck = false; let uncertainInstall = false; let packaged = 0; let activeUses = 0; let stoppedTests = 0; let loseRelease = false;
  let current: { id: "original" | "personal"; generation?: string } = { id: "original" };
  const handoffs = new Map<string, { id: "original" | "personal"; generation?: string }>();
  const options: DevelopmentOwnerOptions = {
    rootDirectory: root, platform: "win32", arch: "x64", environment: { ...process.env, PATH: `${fakeTools};${fakeGit}` },
    process: { async run(input: DevelopmentProcessInput) {
      input.signal.throwIfAborted();
      const name = basename(input.executable).replace(/\.exe$/iu, "");
      if (name === "git") {
        try { return { stdout: (await execute("git", [...input.args], { cwd: input.cwd,
          env: { ...process.env, ...input.environment, PATH: hostPath }, windowsHide: true, signal: input.signal })).stdout, exitCode: 0 }; }
        catch (error) { return { stdout: "", exitCode: typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1 }; }
      }
      if (input.args[0] === "--version") {
        const versions: Record<string, string> = { node: "v24.16.0", pnpm: "11.22.0", python3: "Python 3.13.15", "git-lfs": "git-lfs/3.8.0" };
        return { stdout: versions[name] ?? "", exitCode: versions[name] ? 0 : 1 };
      }
      if (uncertainInstall && input.args[0] === "install") throw new PersonalDevelopmentError("PROCESS_UNKNOWN");
      if (input.args[0] === "check" && failCheck) return { stdout: "controlled check failure", exitCode: 1 };
      if (input.args[0] === "build:desktop:distribution" || input.args[0] === "build:desktop:unpacked") {
        packaged++; const release = join(input.cwd, "apps", "desktop", "release");
        await runtime(join(release, "win-unpacked")); await writeFile(join(release, "Joko-0.1.0-win-x64.exe"), `installer:${packaged}`);
      }
      return { stdout: "", exitCode: 0 };
    } },
    worktrees: {
      async acquire(input) {
        const known = leases.get(input.taskId); if (known) return known;
        const path = join(root, "tasks", input.taskId); await mkdir(join(root, "tasks"), { recursive: true });
        const branch = `feature/personal-${input.taskId}`; const baseCommit = await git(source, ["rev-parse", input.sourceRef]);
        await git(source, ["worktree", "add", "-b", branch, path, input.sourceRef]);
        const lease = { taskId: input.taskId, sessionId: input.sessionId, leaseId: randomUUID(), path, branch, baseCommit };
        leases.set(input.taskId, lease); return lease;
      },
      async assertCurrent(lease) {
        const known = leases.get(lease.taskId);
        if (!known || known.leaseId !== lease.leaseId || known.sessionId !== lease.sessionId || known.path !== lease.path
          || await git(known.path, ["branch", "--show-current"]) !== known.branch) throw new PersonalDevelopmentError("OWNER_CHANGED");
      },
      async withUse(_lease, _signal, run) { activeUses++; try { return await run(); } finally { activeUses--; } },
      async reconcileRetiredUses() { return "retired"; },
      async release(lease) {
        if (released.get(lease.taskId) === lease.leaseId) return "released";
        await git(source, ["worktree", "remove", lease.path]); await git(source, ["branch", "-D", lease.branch]);
        leases.delete(lease.taskId); released.set(lease.taskId, lease.leaseId);
        if (loseRelease) { loseRelease = false; throw new PersonalDevelopmentError("PROCESS_UNKNOWN"); }
        return "released";
      }
    },
    nativeVersions: {
      async original() { return { runtimeDirectory: original, executable: join(original, "Joko.exe"), compatibilityIdentity, version: "0.1.0", development: false }; },
      async current() { return current; }, async busy() { return false; },
      async handoff(target) { const ticketId = randomUUID(); handoffs.set(ticketId, { id: target.id, generation: target.generation }); return { status: "queued", ticketId }; },
      async activateHandoff(ticketId) { current = handoffs.get(ticketId)!; }, async reveal() {},
      async startTest() { return "test-receipt"; }, async stopTest() { stoppedTests++; return "retired"; }
    }
  };
  return { root, source, options, get packaged() { return packaged; }, get activeUses() { return activeUses; }, get stoppedTests() { return stoppedTests; }, set failCheck(value: boolean) { failCheck = value; },
    set uncertainInstall(value: boolean) { uncertainInstall = value; }, set loseRelease(value: boolean) { loseRelease = value; } };
}

describe("personal development ownership", { timeout: 60_000 }, () => {
  it.each([
    ["win32", "x64", "node-v24.16.0-win-x64.zip", "edaca9bd58ec8e92037dac4e877d52f6b8f430b81c18b57e264b4e2fb111cd56"],
    ["darwin", "x64", "node-v24.16.0-darwin-x64.tar.gz", "298b4c7b3cb80765c8703e42b90324a4ece3b6634947b89e769c3c980ab55185"],
    ["darwin", "arm64", "node-v24.16.0-darwin-arm64.tar.gz", "39189dab4eeb15706c424af0ac08a3044c9e48f7db12a7d77f6b7aafc7dd5df6"],
    ["linux", "x64", "node-v24.16.0-linux-x64.tar.gz", "2faf6a387e9b62b888e21c54f01249fb27537ffecf1842f29f4c919d0a59a0ff"],
    ["linux", "arm64", "node-v24.16.0-linux-arm64.tar.gz", "589f5b6dd4fcfee4dfda73013903c966abaa8abd93dbc9d436544e472b4f0e74"]
  ])("pins the existing %s/%s Node archive to the official 24.16.0 digest", (platform, arch, fileName, sha256) => {
    const node = developmentToolCatalog(platform!, arch!).find(tool => tool.id === "node");
    const directory = fileName!.replace(/\.(?:zip|tar\.gz)$/u, "");
    expect(node).toEqual({ id: "node", version: "24.16.0", host: `${platform}-${arch}`, sha256,
      format: platform === "win32" ? "zip" : "tar.gz", url: `https://nodejs.org/dist/v24.16.0/${fileName}`,
      executable: `${directory}/${platform === "win32" ? "node.exe" : "bin/node"}` });
  });

  it.each(["v22.19.0", "v22.23.2", "v24.15.9"])("retires Node %s instead of admitting it below the project minimum", async oldVersion => {
    const f = await fixture(); let version = "v24.16.0";
    const tools = new DevelopmentTools(f.root, { ...f.options, toolArtifacts: [], process: { async run(input) {
      if (basename(input.executable) === "node.exe" && input.args[0] === "--version") return { stdout: version, exitCode: 0 };
      return f.options.process.run(input);
    } } });
    expect((await tools.check(signal)).find(check => check.id === "node")).toMatchObject({ status: "ready", version: "24.16.0" });
    version = oldVersion;
    expect((await tools.check(signal)).find(check => check.id === "node")).toEqual({ id: "node", status: "missing" });
    expect(() => tools.executable("node")).toThrow(expect.objectContaining({ code: "ENVIRONMENT_NOT_READY" }));
  });

  it("keeps the real index untouched while snapshotting binary and untracked content, then rolls back a failed integrated build", async () => {
    const f = await fixture(); const tools = new DevelopmentTools(f.root, f.options);
    expect((await tools.check(signal)).map(check => [check.id, check.status])).toEqual([
      ["git", "ready"], ["node", "ready"], ["pnpm", "ready"], ["python", "ready"], ["gitLfs", "ready"]
    ]);
    const repo = new DevelopmentRepository(f.root, tools);
    await writeFile(join(f.source, "feature.txt"), "staged\n"); await git(f.source, ["add", "feature.txt"]);
    await writeFile(join(f.source, "feature.txt"), "working\n"); await writeFile(join(f.source, "new.bin"), Buffer.from([0, 255, 127, 1]));
    const index = await git(f.source, ["write-tree"]); const tree = await repo.snapshot(f.source, signal);
    expect(tree).not.toBe(index); expect(await git(f.source, ["write-tree"])).toBe(index);
    expect(await git(f.source, ["show", `${tree}:feature.txt`])).toBe("working");
    expect(await git(f.source, ["ls-tree", tree, "new.bin"])).toContain("new.bin");
    await repo.commit(f.source, signal, "chore: preserve local baseline");
    const owner = new PersonalDevelopmentOwner(f.options); await owner.initialize();
    const task = (await owner.prepareTask({ taskId: "task-a", sessionId: "session-a", request: "Add feature", title: "Feature" })).value;
    await writeFile(join(task.path, "feature.txt"), "personal feature\n");
    await owner.completeTask({ taskId: task.taskId, completionId: "completion-a" });
    const originalHead = await git(f.source, ["rev-parse", "HEAD"]);
    f.failCheck = true;
    await expect(owner.build({ taskId: task.taskId })).rejects.toMatchObject({ code: "COMMAND_FAILED" });
    const failedBuild = Object.values(owner.snapshot().operations).find(operation => operation.kind === "personal-build")!;
    expect(failedBuild.diagnostics).toEqual([{ stage: "checking", code: "COMMAND_FAILED", exitCode: 1 }]);
    expect(await git(f.source, ["rev-parse", "HEAD"])).toBe(originalHead);
    expect(await readFile(join(f.source, "feature.txt"), "utf8")).toBe("working\n");
    expect(await readFile(join(task.path, "feature.txt"), "utf8")).toBe("personal feature\n");
    expect(owner.versions().personal).toBeUndefined(); expect(f.packaged).toBe(0);
    await owner.dispose();
  });

  it("publishes only current runtime bytes, replays an exact receipt, fences tampering, and removes only an inactive personal generation", async () => {
    const f = await fixture(); const owner = new PersonalDevelopmentOwner(f.options); await owner.initialize();
    const artifact = (await owner.build({ operationId: "build-a" })).value;
    expect(f.packaged).toBe(1); expect((await owner.build({ operationId: "build-a" })).replayed).toBe(true); expect(f.packaged).toBe(1);
    await owner.actVersion({ action: "switch", id: "personal" });
    const personalTicket = owner.versions().pendingHandoff!;
    expect(owner.versions().switching).toBe(true); expect(owner.versions().selected).toBe("original");
    await expect(owner.reconcileVersionHandoff({ ticketId: personalTicket.ticketId, outcome: "ready", current: { id: "personal", generation: "wrong" } })).rejects.toMatchObject({ code: "OWNER_CHANGED" });
    await owner.reconcileVersionHandoff({ ticketId: personalTicket.ticketId, outcome: "ready", current: await f.options.nativeVersions.current() });
    await expect(owner.actVersion({ action: "remove", id: "personal" })).rejects.toMatchObject({ code: "BUSY" });
    await owner.actVersion({ action: "switch", id: "original" });
    await owner.reconcileVersionHandoff({ ticketId: owner.versions().pendingHandoff!.ticketId, outcome: "ready", current: await f.options.nativeVersions.current() });
    await writeFile(artifact.executable, "tampered");
    await expect(owner.actVersion({ action: "switch", id: "personal" })).rejects.toMatchObject({ code: "ARTIFACT_CHANGED" });
    await writeFile(artifact.executable, "controlled native executable\n");
    await owner.actVersion({ action: "remove", id: "personal" });
    expect(await exists(artifact.directory)).toBe(false); expect(await exists(f.source)).toBe(true); await owner.dispose();
  });

  it("retains an unknown writer's task and durable failed operation across owner restart", async () => {
    const f = await fixture(); f.uncertainInstall = true;
    const owner = new PersonalDevelopmentOwner(f.options);
    await expect(owner.prepareTask({ operationId: "prepare-unknown", taskId: "task-unknown", sessionId: "session-unknown", request: "Edit", title: "Edit" })).rejects.toMatchObject({ code: "PROCESS_UNKNOWN" });
    expect(owner.snapshot().operations["prepare-unknown"]?.status).toBe("unknown");
    expect(await exists(owner.snapshot().tasks["task-unknown"]!.path)).toBe(true); await owner.dispose();
    const resumed = new PersonalDevelopmentOwner(f.options); await resumed.initialize();
    await expect(resumed.prepareTask({ operationId: "prepare-unknown", taskId: "task-unknown", sessionId: "session-unknown", request: "Edit", title: "Edit" })).rejects.toMatchObject({ code: "PROCESS_UNKNOWN" });
    await expect(resumed.prepareTask({ operationId: "new-identity", taskId: "task-unknown", sessionId: "session-unknown", request: "Edit", title: "Edit" })).rejects.toMatchObject({ code: "BUSY" });
    await expect(resumed.build()).rejects.toMatchObject({ code: "BUSY" });
    await expect(resumed.clearSource()).rejects.toMatchObject({ code: "BUSY" });
    await expect(resumed.recoverBuild()).rejects.toMatchObject({ code: "BUSY" });
    expect(await exists(resumed.snapshot().tasks["task-unknown"]!.path)).toBe(true); await resumed.dispose();
  });

  it("turns an unknown command into a known failure only after exact retirement and source-use reconciliation without replay", async () => {
    const f = await fixture(); let proof = false; let installs = 0;
    const reconciled: unknown[] = [];
    const options: DevelopmentOwnerOptions = { ...f.options, process: { async run(input) { if (input.args[0] === "install") installs++; return f.options.process.run(input); },
      async recover(input) { expect(input.operationId).toBe("unknown-to-recover"); return { status: proof ? "retired" : "unknown", commandIds: ["exact-command"] }; } },
      worktrees: { ...f.options.worktrees, async reconcileRetiredUses(input) { reconciled.push(input); return "retired"; } } };
    f.uncertainInstall = true; const first = new PersonalDevelopmentOwner(options);
    const input = { operationId: "unknown-to-recover", taskId: "recover-task", sessionId: "recover-session", title: "Edit", request: "Edit source" };
    await expect(first.prepareTask(input)).rejects.toMatchObject({ code: "PROCESS_UNKNOWN" }); await first.dispose();
    const owner = new PersonalDevelopmentOwner(options); await owner.initialize();
    expect((await owner.recoverUnknownWriters()).value).toEqual({ recovered: [], unknown: [input.operationId] });
    expect(reconciled).toEqual([]); proof = true;
    expect((await owner.recoverUnknownWriters()).value).toEqual({ recovered: [input.operationId], unknown: [] });
    expect(owner.snapshot().operations[input.operationId]).toMatchObject({ status: "failed", error: "COMMAND_FAILED", stage: "writer-retirement-verified" });
    expect(reconciled).toEqual([{ operationId: input.operationId, commandIds: ["exact-command"] }]); expect(installs).toBe(1);
    await expect(owner.prepareTask(input)).rejects.toMatchObject({ code: "COMMAND_FAILED" }); expect(installs).toBe(1);
    f.uncertainInstall = false; await owner.prepareTask({ ...input, operationId: "explicit-retry" }); expect(installs).toBe(2); await owner.dispose();
  });

  it("selects only declared source refs and rejects traversal before archive extraction", async () => {
    expect(developmentSourceTarget({ channel: "release", version: "0.1.0" })).toEqual(["v0.1.0", "v0.1.0-beta"]);
    expect(developmentSourceTarget({ channel: "beta", version: "0.1.0-beta" })).toEqual(["v0.1.0-beta", "v0.1.0"]);
    expect(() => developmentSourceTarget({ channel: "release", version: "main" })).toThrowError(PersonalDevelopmentError);
    const f = await fixture(); const archive = join(f.root, "hostile.zip"); const destination = join(f.root, "extract"); await mkdir(destination);
    const unsupported = new PersonalDevelopmentOwner({ ...f.options, platform: "linux", libc: "musl" });
    await expect(unsupported.checkEnvironment()).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM" }); await unsupported.dispose();
    const zip = new JSZip(); zip.file("../escape", "bad"); await writeFile(archive, await zip.generateAsync({ type: "nodebuffer" }));
    await expect(extractDevelopmentTool(archive, destination, "zip", signal)).rejects.toMatchObject({ code: "TOOL_INTEGRITY" });
    expect(await exists(join(f.root, "escape"))).toBe(false);
  });

  it("keeps the source-use fence until native testing is retired before continuing to edit", async () => {
    const f = await fixture(); const owner = new PersonalDevelopmentOwner(f.options);
    const task = (await owner.prepareTask({ taskId: "test-task", sessionId: "test-session", request: "Edit", title: "Edit" })).value;
    await writeFile(join(task.path, "feature.txt"), "testable feature\n");
    await owner.completeTask({ taskId: task.taskId, completionId: "test-completion" });
    expect(f.activeUses).toBe(0);
    const running = (await owner.testTask({ taskId: task.taskId, action: "start" })).value;
    expect(running?.status).toBe("running"); expect(f.activeUses).toBe(1);
    await owner.continueTask({ taskId: task.taskId });
    expect(f.activeUses).toBe(0); expect(f.stoppedTests).toBe(1);
    expect(owner.snapshot().tests?.[task.taskId]?.status).toBe("stopped");
    expect(owner.snapshot().tasks[task.taskId]?.status).toBe("editing");
    f.loseRelease = true;
    await expect(owner.endTask({ taskId: task.taskId })).rejects.toMatchObject({ code: "PROCESS_UNKNOWN" });
    expect(owner.snapshot().tasks[task.taskId]?.status).toBe("cleanup");
    await owner.endTask({ taskId: task.taskId });
    expect(await git(f.source, ["rev-parse", "refs/joko-personal/completions/test-completion"])).toBe(owner.history()[0]!.commit);
    expect(await git(f.source, ["rev-parse", `refs/joko-personal/ended-tasks/${task.taskId}`])).toBe(owner.history()[0]!.commit);
    await owner.dispose();
  });

  it("does not release an exact native process lease when descendant retirement is unknown after a successful root exit", async () => {
    const f = await fixture(); let released = false;
    const processOwner = createDevelopmentProcessAuthority({ claim: pid => pid, async retire() { return "unknown"; }, async release() { released = true; } });
    await expect(processOwner.run({ executable: process.execPath, args: ["-e", "process.stdout.write('done')"], cwd: f.root,
      environment: process.env, signal, timeoutMs: 10_000 })).rejects.toMatchObject({ code: "PROCESS_UNKNOWN" });
    expect(released).toBe(false);
  });

  it("coalesces only the exact live operation identity and rejects another receipt or mutated input", async () => {
    const f = await fixture(); let unblock!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
    const owner = new PersonalDevelopmentOwner({ ...f.options, process: { async run(input) { entered(); await gate; return f.options.process.run(input); } } });
    const input = { channel: "dev" as const, version: "0.1.0", operationId: "source-flight" };
    const first = owner.prepareSource(input); const firstResult = first.catch(error => error);
    await started;
    const same = owner.prepareSource(input).catch(error => error);
    await expect(owner.prepareSource({ ...input, operationId: "other-flight" })).rejects.toMatchObject({ code: "BUSY" });
    await expect(owner.prepareSource({ ...input, version: "0.2.0" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    owner.cancel(input.operationId); unblock();
    expect(await firstResult).toMatchObject({ code: "CANCELLED" }); expect(await same).toMatchObject({ code: "CANCELLED" });
    expect(Object.keys(owner.snapshot().operations)).toEqual([input.operationId]); await owner.dispose();
  });

  it.each([true, false])("persists actual tool download progress with known total=%s before publishing the installed tool generation", async knownTotal => {
    const f = await fixture(); const zip = new JSZip(); zip.file("git.exe", "controlled executable");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const artifact = { id: "git" as const, version: "2.55.0.5", host: "win32-x64", format: "zip" as const,
      url: "https://tool-host.invalid/git.zip", sha256: (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"), executable: "git.exe" };
    const snapshots: { stage: string; percent?: number }[] = []; const toolChecks: DevelopmentToolCheck[] = [];
    const owner = new PersonalDevelopmentOwner({ ...f.options, toolArtifacts: [artifact], environment: { ...process.env, PATH: join(f.root, "controlled-tools") },
      fetch: async () => new Response(new Uint8Array(bytes).buffer, { headers: knownTotal ? { "content-length": String(bytes.length) } : {} }),
      process: { async run(input) {
        if (basename(input.executable) === "git.exe" && input.args[0] === "--version") return { stdout: "git version 2.55.0.windows.5", exitCode: 0 };
        return f.options.process.run(input);
      } } });
    const unsubscribe = owner.subscribe(state => { const operation = state.operations["download-tools"]; if (operation) snapshots.push({ stage: operation.stage, percent: operation.percent });
      const check = state.environment.checks.find(check => check.id === "git"); if (check) toolChecks.push(check); });
    const result = await owner.prepareEnvironment({ operationId: "download-tools" });
    expect(result.value.every(check => check.status === "ready")).toBe(true);
    expect(snapshots).toContainEqual({ stage: "downloading:git", percent: knownTotal ? 100 : undefined });
    expect(snapshots).toContainEqual({ stage: "verifying:git", percent: undefined });
    expect(toolChecks).toContainEqual(expect.objectContaining({ status: "downloading", source: "managed", progress: { loaded: bytes.length, total: knownTotal ? bytes.length : null, percent: knownTotal ? 100 : null } }));
    expect(result.value.find(check => check.id === "git")?.source).toBe("managed"); expect(result.value.find(check => check.id === "node")?.source).toBe("system");
    unsubscribe(); await owner.dispose();
  });

  it("refreshes real Git branch comparisons without treating personal source as running-version evidence", async () => {
    const f = await fixture(), base = await git(f.source, ["rev-parse", "HEAD"]);
    await git(f.source, ["branch", "main", base]);
    await git(f.source, ["checkout", "-b", "upstream-comparison"]); await writeFile(join(f.source, "official.txt"), "official\n");
    await git(f.source, ["add", "."]); await git(f.source, ["commit", "-m", "feat: official update"]); const upstream = await git(f.source, ["rev-parse", "HEAD"]);
    await git(f.source, ["update-ref", "refs/remotes/origin/main", upstream]); await git(f.source, ["checkout", PERSONAL_BRANCH]);
    await writeFile(join(f.source, "personal.txt"), "personal\n"); await git(f.source, ["add", "."]); await git(f.source, ["commit", "-m", "feat: personal change"]);
    const tools = new DevelopmentTools(f.root, f.options); await tools.check(signal); const repo = new DevelopmentRepository(f.root, tools);
    expect(await repo.readSourceStatus({ status: "ready", channel: "dev", upstreamCommit: upstream }, signal)).toMatchObject({
      currentBranch: PERSONAL_BRANCH, baseCommit: base, mainCommit: base, mainRemoteCommit: upstream, mainAhead: 0, mainBehind: 1, personalAhead: 1, personalBehind: 0
    });
    await git(f.source, ["update-ref", "refs/heads/main", upstream]);
    expect(await repo.readSourceStatus({ status: "ready", upstreamCommit: upstream }, signal)).toMatchObject({ personalAhead: 1, personalBehind: 1, mainAhead: 0, mainBehind: 0 });
    const owner = new PersonalDevelopmentOwner({ ...f.options, nativeVersions: { ...f.options.nativeVersions, async original() { return { ...await f.options.nativeVersions.original(), development: true }; } },
      fetch: async input => { expect(String(input)).toBe("https://api.github.com/repos/JokoAgent/joko/commits/main"); return new Response(JSON.stringify({ sha: upstream })); } });
    const status = (await owner.refreshSourceStatus()).value;
    expect(status.latestVersion).toMatchObject({ status: "ready", channel: "dev", ref: "main", commit: upstream, ahead: 0, behind: 0 });
    expect(status.commit).not.toBe(upstream); expect(owner.versions().currentId).toBeUndefined(); await owner.dispose();
    const reopened = new PersonalDevelopmentOwner(f.options); await reopened.initialize(); expect(reopened.snapshot().source.latestVersion).toBeUndefined(); await reopened.dispose();
  });

  it.each(["success", "failed", "unknown"] as const)("advances the exact official refs only with a recoverable source adoption: %s", async outcome => {
    const f = await fixture(), base = await git(f.source, ["rev-parse", "HEAD"]);
    await git(f.source, ["branch", "main", base]); await git(f.source, ["update-ref", "refs/joko-personal/personal-upstream", base]);
    await git(f.source, ["checkout", "-b", "upstream-adoption"]); await writeFile(join(f.source, "official.txt"), "official update\n");
    await git(f.source, ["add", "."]); await git(f.source, ["commit", "-m", "feat: update official source"]);
    const upstream = await git(f.source, ["rev-parse", "HEAD"]); await git(f.source, ["update-ref", "refs/remotes/origin/main", upstream]);
    await git(f.source, ["checkout", PERSONAL_BRANCH]); await writeFile(join(f.source, "personal.txt"), "personal addition\n");
    await git(f.source, ["add", "."]); await git(f.source, ["commit", "-m", "feat: preserve personal source"]);
    const personal = await git(f.source, ["rev-parse", "HEAD"]); let inject = outcome !== "success", proof = false;
    const options: DevelopmentOwnerOptions = { ...f.options, process: {
      async run(input) {
        if (basename(input.executable).replace(/\.exe$/iu, "") === "git") {
          if (input.args[0] === "fetch") return { stdout: "", exitCode: 0 };
          if (input.args[0] === "ls-remote") return { stdout: `${upstream}\trefs/heads/main\n`, exitCode: 0 };
          if (inject && input.args[0] === "update-ref" && input.args[1] === (outcome === "failed" ? "refs/joko-personal/personal-upstream" : "refs/heads/main")) {
            inject = false;
            if (outcome === "unknown") throw new PersonalDevelopmentError("PROCESS_UNKNOWN");
            return { stdout: "", exitCode: 1 };
          }
        }
        return f.options.process.run(input);
      },
      async recover(input) { expect(input.operationId).toBe("adopt-source"); return { status: proof ? "retired" : "unknown", commandIds: ["exact-merge-command"] }; }
    } };
    let owner = new PersonalDevelopmentOwner(options); await owner.prepareSource({ channel: "dev", version: "0.1.0" });
    const merge = (await owner.mergeSource({ action: "start", operationId: "prepare-merge" })).value!;
    expect(merge.status).toBe("ready"); expect(await git(f.source, ["rev-parse", "main"])).toBe(base);
    const input = { action: "adopt" as const, expectedMergeId: merge.id, operationId: "adopt-source" };
    if (outcome !== "success") {
      await expect(owner.mergeSource(input)).rejects.toMatchObject({ code: outcome === "unknown" ? "PROCESS_UNKNOWN" : "COMMAND_FAILED" });
      expect(await git(f.source, ["rev-parse", "main"])).toBe(base);
      expect(await git(f.source, ["rev-parse", "refs/joko-personal/personal-upstream"])).toBe(base);
      expect(await exists(merge.candidate)).toBe(true); expect(owner.snapshot().merge?.status).toBe("ready");
      if (outcome === "unknown") {
        await owner.dispose(); owner = new PersonalDevelopmentOwner(options); await owner.initialize();
        await expect(owner.recoverBuild()).rejects.toMatchObject({ code: "BUSY" });
        expect((await owner.recoverUnknownWriters()).value).toEqual({ recovered: [], unknown: [input.operationId] });
        proof = true;
        expect((await owner.recoverUnknownWriters()).value).toEqual({ recovered: [input.operationId], unknown: [] });
        expect((await owner.recoverBuild()).value).toBe(true);
        expect(owner.snapshot().operations[input.operationId]).toMatchObject({ status: "failed", error: "COMMAND_FAILED" });
      }
      expect(await git(f.source, ["rev-parse", "HEAD"])).toBe(personal);
      expect(await exists(join(f.source, "official.txt"))).toBe(false);
      expect(await readFile(join(f.source, "personal.txt"), "utf8")).toBe("personal addition\n");
      expect(await exists(merge.candidate)).toBe(true);
      await owner.mergeSource({ ...input, operationId: "explicit-adopt-retry" });
    } else await owner.mergeSource(input);
    expect(await git(f.source, ["rev-parse", "main"])).toBe(upstream);
    expect(await git(f.source, ["rev-parse", "refs/joko-personal/personal-upstream"])).toBe(upstream);
    expect(await git(f.source, ["rev-parse", `refs/joko-personal/merge-backups/${merge.id}/${input.operationId}/main`])).toBe(base);
    expect(await git(f.source, ["rev-parse", `refs/joko-personal/merge-backups/${merge.id}/${input.operationId}/upstream`])).toBe(base);
    expect(await readFile(join(f.source, "official.txt"), "utf8")).toBe("official update\n");
    expect(owner.snapshot().source).toMatchObject({ mainCommit: upstream, baseCommit: upstream, mainAhead: 0, mainBehind: 0, personalBehind: 0 });
    expect(owner.snapshot().source.personalAhead).toBeGreaterThan(0); expect(owner.snapshot().merge?.status).toBe("adopted");
    expect(await exists(merge.candidate)).toBe(false); await owner.dispose();
  });

  it("retires only the adopted checkout when preparation failed before task persistence", async () => {
    const f = await fixture(); const intent = { taskId: "unprepared", sessionId: "unprepared-session", title: "Edit", request: "Edit source" };
    const adopted = await f.options.worktrees.acquire({ ...intent, repositoryRoot: f.source, sourceRef: PERSONAL_BRANCH, signal });
    const owner = new PersonalDevelopmentOwner({ ...f.options, process: { async run(input) {
      if (basename(input.executable).startsWith("pnpm") && input.args[0] === "--version") return { stdout: "", exitCode: 1 };
      return f.options.process.run(input);
    } } });
    await expect(owner.prepareTask(intent)).rejects.toMatchObject({ code: "ENVIRONMENT_NOT_READY" });
    expect(owner.snapshot().tasks[intent.taskId]).toBeUndefined(); f.loseRelease = true;
    await expect(owner.retireUnpreparedTask(intent)).rejects.toMatchObject({ code: "PROCESS_UNKNOWN" });
    expect(owner.snapshot().tasks[intent.taskId]).toMatchObject({ status: "cleanup", leaseId: adopted.leaseId });
    expect((await owner.endTask({ taskId: intent.taskId })).value).toBe("released");
    expect(Object.values(owner.snapshot().operations).some(operation => operation.status === "unknown")).toBe(false);
    expect(await exists(adopted.path)).toBe(false); await owner.dispose();
  });

  it("holds the merge candidate through exact native retirement, permits renewed editing and preserves unknown ownership across restart", async () => {
    const f = await fixture();
    await git(f.source, ["checkout", "-b", "upstream-test"]); await writeFile(join(f.source, "feature.txt"), "upstream change\n");
    await git(f.source, ["add", "."]); await git(f.source, ["commit", "-m", "feat: upstream edit"]);
    const upstream = await git(f.source, ["rev-parse", "HEAD"]); await git(f.source, ["update-ref", "refs/remotes/origin/main", upstream]);
    await git(f.source, ["checkout", PERSONAL_BRANCH]); await writeFile(join(f.source, "feature.txt"), "personal change\n");
    await git(f.source, ["add", "."]); await git(f.source, ["commit", "-m", "feat: personal edit"]);
    const options: DevelopmentOwnerOptions = { ...f.options, process: { async run(input) {
      if (basename(input.executable).replace(/\.exe$/iu, "") === "git") {
        if (input.args[0] === "fetch") return { stdout: "", exitCode: 0 };
        if (input.args[0] === "ls-remote") return { stdout: `${upstream}\trefs/heads/main\n`, exitCode: 0 };
      }
      return f.options.process.run(input);
    } } };
    const owner = new PersonalDevelopmentOwner(options); await owner.prepareSource({ channel: "dev", version: "0.1.0" });
    const merge = (await owner.mergeSource({ action: "start" })).value!; expect(merge.status).toBe("conflict");
    await expect(owner.mergeSource({ action: "cancel", expectedMergeId: "different-candidate" })).rejects.toMatchObject({ code: "OWNER_CHANGED" });
    const first = (await owner.acquireMergeResolution({ mergeId: merge.id, sessionId: "resolution-session" })).value;
    expect((await owner.acquireMergeResolution({ mergeId: merge.id, sessionId: "resolution-session" })).value).toEqual(first);
    await expect(owner.mergeSource({ action: "cancel" })).rejects.toMatchObject({ code: "BUSY" });
    await expect(owner.build()).rejects.toMatchObject({ code: "BUSY" });
    await owner.releaseMergeResolution({ mergeId: merge.id, sessionId: "resolution-session", leaseId: first.leaseId, outcome: "retired" });
    const second = (await owner.acquireMergeResolution({ mergeId: merge.id, sessionId: "renewed-resolution-session" })).value;
    expect(second.leaseId).not.toBe(first.leaseId);
    await expect(owner.releaseMergeResolution({ mergeId: merge.id, sessionId: "resolution-session", leaseId: first.leaseId, outcome: "retired" })).rejects.toMatchObject({ code: "OWNER_CHANGED" });
    await owner.releaseMergeResolution({ mergeId: merge.id, sessionId: "renewed-resolution-session", leaseId: second.leaseId, outcome: "unknown" });
    await owner.dispose(); const reopened = new PersonalDevelopmentOwner(options); await reopened.initialize();
    await expect(reopened.acquireMergeResolution({ mergeId: merge.id, sessionId: "renewed-resolution-session" })).rejects.toMatchObject({ code: "BUSY" });
    await expect(reopened.mergeSource({ action: "cancel" })).rejects.toMatchObject({ code: "BUSY" });
    expect(await exists(second.directory)).toBe(true);
    await reopened.releaseMergeResolution({ mergeId: merge.id, sessionId: "renewed-resolution-session", leaseId: second.leaseId, outcome: "retired" });
    await reopened.mergeSource({ action: "cancel" }); expect(await exists(second.directory)).toBe(false); await reopened.dispose();
  });
});
