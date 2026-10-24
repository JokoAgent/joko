import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { workspaceEntryAbsentRevision } from "@joko/contracts";
import { DEVICE_PEER_RUNTIME_EXECUTABLES, LocalDevicePeerFileTransport } from "@joko/device-peer";
import type { RemoteProcessHandle, RemoteProcessStartRequest, RemoteProcessTransportPort } from "@joko/remote-ssh";
import { expect, it, vi } from "vitest";
import type { RemoteExecutionRouter } from "./remote-execution-router.js";
import { RemoteWorkspaceService } from "./remote-workspace-service.js";
import { WorkspaceService } from "./workspace-service.js";

const execFileAsync = promisify(execFile);

class LocalRemoteProcess extends EventEmitter implements RemoteProcessHandle {
  readonly #child;
  readonly closed: Promise<void>;
  readonly stdin; readonly stdout; readonly stderr;
  constructor(request: RemoteProcessStartRequest) {
    super();
    this.#child = spawn(request.executable === DEVICE_PEER_RUNTIME_EXECUTABLES.node ? process.execPath : request.executable, [...request.args], {
      cwd: request.cwd, env: { ...process.env, ...request.env }, windowsHide: true, stdio: "pipe"
    });
    this.stdin = this.#child.stdin; this.stdout = this.#child.stdout; this.stderr = this.#child.stderr;
    this.on("error", () => undefined); this.stdin.on("error", () => undefined);
    const abort = () => { this.kill(); };
    request.signal?.addEventListener("abort", abort, { once: true });
    this.#child.once("error", error => this.emit("error", error));
    this.closed = new Promise(done => this.#child.once("close", (code, signal) => {
      request.signal?.removeEventListener("abort", abort); this.emit("exit", code, signal); done();
    }));
    if (request.signal?.aborted) abort();
  }
  get exitCode() { return this.#child.exitCode; }
  get signalCode() { return this.#child.signalCode; }
  kill(signal: NodeJS.Signals | number = "SIGTERM") { return this.#child.kill(signal); }
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "joko-remote-workspace-"));
  await mkdir(join(base, "repo")); await mkdir(join(base, "outside"));
  const root = await realpath(join(base, "repo")), outside = await realpath(join(base, "outside"));
  const files = new LocalDevicePeerFileTransport(), handles = new Set<LocalRemoteProcess>();
  let retired = false;
  const processes: RemoteProcessTransportPort = { open: async request => {
    const child = new LocalRemoteProcess(request); handles.add(child); child.once("exit", () => handles.delete(child)); return child;
  } };
  const binding = { kind: "device_peer", controllerDeviceId: "controller", targetDeviceId: "peer", workspaceRoot: root } as const;
  const assertCurrent = () => { if (retired) throw new Error("Route retired."); };
  const authority = () => ({ kind: "device_peer" as const, binding, executionIdentity: "peer", authorityIdentity: "peer-route-1",
    pathStyle: process.platform === "win32" ? "win32" as const : "posix" as const, files, processes,
    assertCurrent, assertFilesCurrent: assertCurrent, assertForwardingCurrent: () => undefined });
  const router = { workspace: async () => authority(), files: async () => authority() } as unknown as RemoteExecutionRouter;
  const remote = new RemoteWorkspaceService(router), workspaces = new WorkspaceService({ remoteDelegate: remote });
  const registration = { id: "workspace", root, displayName: "Remote project", trusted: true, remote: { targetId: "target", binding } };
  await workspaces.register(registration);
  const git = async (...args: string[]) => (await execFileAsync("git", args, { cwd: root, encoding: "utf8", windowsHide: true })).stdout.trim();
  await git("init", "-b", "main"); await git("config", "user.name", "Joko Test"); await git("config", "user.email", "test@example.invalid");
  await git("config", "core.autocrlf", "false"); await git("config", "core.hooksPath", join(base, "no-hooks"));
  return { root, outside, files, remote, registration, workspaces, git, retire: () => { retired = true; }, close: async () => {
    vi.restoreAllMocks(); await workspaces.close(); const pending = [...handles]; for (const child of pending) child.kill("SIGKILL");
    await Promise.all(pending.map(child => child.closed));
    if (!resolve(base).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe fixture cleanup.");
    await rm(base, { recursive: true, force: true });
  } };
}

it("rejects every remote mutation through an intermediate link before delegating its effect", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.outside, "note.txt"), "Outside bytes"); await writeFile(join(f.root, "source.txt"), "Source");
    await symlink(f.outside, join(f.root, "link"), process.platform === "win32" ? "junction" : "dir");
    const write = vi.spyOn(f.files, "write"), rename = vi.spyOn(f.files, "rename"), remove = vi.spyOn(f.files, "remove");
    const revision = (await f.workspaces.list("workspace", "")).find(entry => entry.path === "source.txt")!.revision;
    const outsideRevision = `sha256:${createHash("sha256").update("Outside bytes").digest("hex")}:${Buffer.byteLength("Outside bytes")}`;
    const outsideInfo = await f.files.stat(join(f.root, "link", "note.txt"));
    const outsideEntryRevision = `remote-version:${outsideInfo.version}:${outsideInfo.kind}:${outsideInfo.mode}:${outsideInfo.size}:${outsideInfo.modifiedAt}`;
    for (const action of [
      () => f.workspaces.createEntry("workspace", { path: "link/new.txt", kind: "file", expectedRevision: workspaceEntryAbsentRevision }),
      () => f.workspaces.writeTextFile("workspace", { path: "link/note.txt", text: "Changed", expectedRevision: outsideRevision }),
      () => f.workspaces.moveEntry("workspace", { sourcePath: "source.txt", destinationPath: "link/moved.txt", expectedRevision: revision }),
      () => f.workspaces.moveEntry("workspace", { sourcePath: "link/note.txt", destinationPath: "moved.txt", expectedRevision: outsideEntryRevision }),
      () => f.workspaces.copyEntry("workspace", { sourcePath: "source.txt", destinationPath: "link/copied.txt", expectedRevision: revision }),
      () => f.workspaces.copyEntry("workspace", { sourcePath: "link/note.txt", destinationPath: "copied.txt", expectedRevision: outsideEntryRevision }),
      () => f.workspaces.deleteEntry("workspace", { path: "link/note.txt", expectedRevision: outsideEntryRevision, confirmRecursive: false })
    ]) await expect(action()).rejects.toBeDefined();
    expect(write).not.toHaveBeenCalled(); expect(rename).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(await readFile(join(f.outside, "note.txt"), "utf8")).toBe("Outside bytes");
    await expect(f.workspaces.copyEntry("workspace", { sourcePath: "link", destinationPath: "copy", expectedRevision: revision })).rejects.toBeDefined();
  } finally { await f.close(); }
});

it("keeps a concurrently created destination and retires an old registration before any write", async () => {
  const f = await fixture();
  try {
    const original = f.files.write.bind(f.files);
    vi.spyOn(f.files, "write").mockImplementationOnce(async request => { await writeFile(request.path, "Other window"); return original(request); });
    await expect(f.workspaces.createEntry("workspace", { path: "new.txt", kind: "file", expectedRevision: workspaceEntryAbsentRevision })).rejects.toBeDefined();
    expect(await readFile(join(f.root, "new.txt"), "utf8")).toBe("Other window");
    const stat = f.files.stat.bind(f.files), writes = vi.spyOn(f.files, "write"); writes.mockClear();
    vi.spyOn(f.files, "stat").mockImplementationOnce(async (...args) => {
      const result = await stat(...args); await f.remote.register(f.registration); return result;
    });
    await expect(f.workspaces.createEntry("workspace", { path: "stale.txt", kind: "file", expectedRevision: workspaceEntryAbsentRevision })).rejects.toBeDefined();
    expect(writes).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it.each(["text", "binary", "untracked"])("binds remote Git mutations to %s content, including a second edit", { timeout: 30_000 }, async kind => {
  const f = await fixture();
  try {
    const file = join(f.root, "note.dat"), bytes = (value: number) => kind === "binary" ? Buffer.from([0, value, 0, 0]) : Buffer.from(`Edit ${value}\n`);
    await writeFile(file, bytes(1)); await f.git("add", "-A"); await f.git("commit", "-m", "base");
    if (kind === "untracked") await f.git("rm", "--cached", "note.dat");
    await writeFile(file, bytes(2)); const before = await f.workspaces.gitReviewDiff("workspace", { source: "unstaged" });
    await writeFile(file, bytes(3)); const after = await f.workspaces.gitReviewDiff("workspace", { source: "unstaged" });
    expect(after.repositoryRevision).not.toBe(before.repositoryRevision);
    await expect(f.workspaces.applyGitDiff("workspace", { action: "revert", source: "unstaged", target: "hunk", path: "note.dat", hunkIndex: 0,
      expectedRepositoryRevision: after.repositoryRevision, confirmRevert: false })).rejects.toMatchObject({ kind: "invalid" });
    await expect(f.workspaces.applyGitDiff("workspace", { action: "revert", source: "unstaged", target: "file", path: "note.dat", expectedRepositoryRevision: before.repositoryRevision, confirmRevert: true })).rejects.toMatchObject({ kind: "stale" });
    await expect(f.workspaces.applyGitDiffHunk("workspace", { action: "stage", source: "unstaged", path: "note.dat", hunkIndex: 0, expectedRepositoryRevision: before.repositoryRevision })).rejects.toMatchObject({ kind: "stale" });
    await expect(f.workspaces.commitGitReview("workspace", { message: "Stale commit", includeUnstaged: true, expectedRepositoryRevision: before.repositoryRevision })).rejects.toMatchObject({ kind: "stale" });
    expect(await readFile(file)).toEqual(bytes(3));
  } finally { await f.close(); }
});

it("reads image sides from the index, parent commit and merge base on the remote workspace", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const file = join(f.root, "image.png"), bytes = (value: number) => Buffer.from([0, value, 0, 0]);
    const review = async (source: "unstaged" | "staged" | "commit" | "branch", sourceRevision?: string) => {
      const input = { source, ...(sourceRevision ? { sourceRevision } : {}) }, diff = await f.workspaces.gitReviewDiff("workspace", input);
      return f.workspaces.readGitDiffImage("workspace", { ...input, path: "image.png", expectedRepositoryRevision: diff.repositoryRevision,
        ...(diff.mergeBaseRevision ? { expectedMergeBaseRevision: diff.mergeBaseRevision } : {}) });
    };
    await writeFile(file, bytes(1)); await f.git("add", "-A"); await f.git("commit", "-m", "base"); const base = await f.git("rev-parse", "HEAD");
    const first = await review("commit", base); expect(first.oldImage.present).toBe(false); expect(first.newImage.bytes).toEqual(bytes(1));
    await f.git("checkout", "-b", "comparison"); await writeFile(file, bytes(9)); await f.git("add", "-A"); await f.git("commit", "-m", "comparison");
    const comparison = await f.git("rev-parse", "HEAD"); await f.git("checkout", "main");
    await writeFile(file, bytes(2)); await f.git("add", "-A"); await f.git("commit", "-m", "feature"); const head = await f.git("rev-parse", "HEAD");
    await writeFile(file, bytes(3)); await f.git("add", "-A"); await writeFile(file, bytes(4));
    const staged = await review("staged"), unstaged = await review("unstaged"), commit = await review("commit", head), branch = await review("branch", comparison);
    expect(staged.oldImage.bytes).toEqual(bytes(2)); expect(staged.newImage.bytes).toEqual(bytes(3));
    expect(unstaged.oldImage.bytes).toEqual(bytes(3)); expect(unstaged.newImage.bytes).toEqual(bytes(4));
    expect(commit.oldImage.bytes).toEqual(bytes(1)); expect(commit.newImage.bytes).toEqual(bytes(2));
    expect(branch.oldImage.bytes).toEqual(bytes(1)); expect(branch.newImage.bytes).toEqual(bytes(2));
    await writeFile(file, Buffer.alloc(5 * 1024 * 1024)); await f.git("add", "image.png");
    const large = (await review("staged")).newImage;
    expect(large).toMatchObject({ present: true, tooLarge: true }); expect(large.bytes).toBeUndefined();
  } finally { await f.close(); }
});

it("streams remote content and empty-directory changes and releases its watcher on cancellation", { timeout: 15_000 }, async () => {
  const f = await fixture(), abort = new AbortController();
  const watcher = f.workspaces.watchChanges({ kind: "workspace", workspaceId: "workspace" }, abort.signal);
  try {
    const file = join(f.root, "note.txt"); await writeFile(file, "before");
    expect((await watcher.next()).value?.kind).toBe("resync");
    for (const mutate of [() => writeFile(file, "after!"), () => mkdir(join(f.root, "empty")), () => rm(join(f.root, "empty"))]) {
      const next = watcher.next(); await mutate(); expect((await next).value?.kind).toBe("resync");
    }
    const pending = watcher.next(); abort.abort(); expect((await pending).done).toBe(true);
  } finally { abort.abort(); await watcher.return(undefined); await f.close(); }
});
