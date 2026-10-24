import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, rmdir, symlink, writeFile } from "node:fs/promises";
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
  const requests: RemoteProcessStartRequest[] = [];
  let retired = false;
  const processes: RemoteProcessTransportPort = { open: async request => {
    requests.push(request);
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
  return { root, outside, files, remote, registration, workspaces, git, requests, retire: () => { retired = true; }, close: async () => {
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
    const rootInfo = await f.files.stat(f.root), rootRevision = `remote-version:${rootInfo.version}:${rootInfo.kind}:${rootInfo.mode}:${rootInfo.size}:${rootInfo.modifiedAt}`;
    for (const action of [
      () => f.workspaces.list("workspace", "link", { recursive: true }),
      () => f.workspaces.deleteEntry("workspace", { path: ".", expectedRevision: rootRevision, confirmRecursive: true }),
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

it("searches past 200 matches in one remote file with stable pages and exact totals", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "matches.txt"), Array.from({ length: 305 }, (_, index) => `match ${index + 1}`).join("\n"));
    const first = await f.workspaces.searchPage("workspace", "match", { maximumResults: 50 });
    const later = await f.workspaces.searchPage("workspace", "match", { maximumResults: 50, offset: 200 });
    const final = await f.workspaces.searchPage("workspace", "match", { maximumResults: 50, offset: 300 });
    expect(first).toMatchObject({ totalResults: 305, totalFiles: 1, truncated: true, nextOffset: 50 });
    expect(later.matches[0]).toMatchObject({ path: "matches.txt", line: 201 });
    expect(later.revision).toBe(first.revision); expect(final.revision).toBe(first.revision);
    expect(final.matches).toHaveLength(5); expect(final.truncated).toBe(false); expect(final.nextOffset).toBeUndefined();
    expect(f.requests.filter(request => request.executable === "rg").every(request => request.args.includes("--sort") && !request.args.includes("--max-count"))).toBe(true);
  } finally { await f.close(); }
});

it.each([
  { query: "^", ending: "LF", lineEnding: "\n" },
  { query: "$", ending: "LF", lineEnding: "\n" },
  { query: "^", ending: "CRLF", lineEnding: "\r\n" },
  { query: "$", ending: "CRLF", lineEnding: "\r\n" }
])("keeps remote $query anchor ranges on Unicode $ending lines", { timeout: 30_000 }, async ({ query, lineEnding }) => {
  const f = await fixture();
  try {
    const text = "先🐾abc", byte = query === "^" ? 0 : Buffer.byteLength(text), column = query === "^" ? 1 : text.length + 1;
    await writeFile(join(f.root, "unicode.txt"), `${text}${lineEnding}${text}${lineEnding}`, "utf8");
    const result = await f.workspaces.searchPage("workspace", query, { regularExpression: true });
    expect(result).toMatchObject({ totalResults: 2, totalFiles: 1, truncated: false, matches: [1, 2].map(line => {
      const absoluteByte = (line - 1) * Buffer.byteLength(text + lineEnding) + byte;
      return { path: "unicode.txt", line, preview: text, column, endColumn: column,
        startByte: absoluteByte, endByte: absoluteByte, submatches: [{ startByte: byte, endByte: byte }] };
    }) });
  } finally { await f.close(); }
});

it("serializes the same paired-node file reached through parent and nested workspace roots", { timeout: 30_000 }, async () => {
  const f = await fixture(); let release!: () => void;
  try {
    await mkdir(join(f.root, "nested")); const nested = await realpath(join(f.root, "nested"));
    await writeFile(join(nested, "note.txt"), "old");
    await f.workspaces.register({ ...f.registration, id: "nested", root: nested,
      remote: { ...f.registration.remote, binding: { ...f.registration.remote.binding, workspaceRoot: nested } } });
    const revision = (await f.workspaces.preview("workspace", "nested/note.txt")).entry.revision;
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; }), original = f.files.write.bind(f.files);
    const write = vi.spyOn(f.files, "write").mockImplementationOnce(async request => { entered(); await blocked; return original(request); });
    const first = f.workspaces.writeTextFile("workspace", { path: "nested/note.txt", text: "first", expectedRevision: revision });
    await started;
    const second = f.workspaces.writeTextFile("nested", { path: "note.txt", text: "second", expectedRevision: revision });
    release(); await first;
    await expect(second).rejects.toMatchObject({ code: "WORKSPACE_TEXT_FILE_STALE" });
    expect(write).toHaveBeenCalledOnce(); expect(await readFile(join(nested, "note.txt"), "utf8")).toBe("first");
  } finally { release?.(); await f.close(); }
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

it("rejects the parent repository of a remote project before reading or changing Git content", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const childRoot = join(f.root, "project"); await mkdir(childRoot);
    await writeFile(join(childRoot, "inside.txt"), "inside base\n"); await writeFile(join(f.root, "sibling.txt"), "outside base\n");
    await f.git("add", "-A"); await f.git("commit", "-m", "base");
    const head = await f.git("rev-parse", "HEAD");
    await writeFile(join(childRoot, "inside.txt"), "inside changed\n"); await writeFile(join(f.root, "sibling.txt"), "outside changed\n");
    const revision = (await f.workspaces.gitReviewDiff("workspace", { source: "unstaged" })).repositoryRevision;
    await f.workspaces.register({ ...f.registration, id: "child", root: childRoot,
      remote: { ...f.registration.remote, binding: { ...f.registration.remote.binding, workspaceRoot: childRoot } } });
    f.requests.length = 0;
    for (const operation of [
      () => f.workspaces.gitState("child"),
      () => f.workspaces.gitReviewDiff("child", { source: "unstaged" }),
      () => f.workspaces.readGitDiffFile("child", { path: "inside.txt", source: "workingTree", expectedRepositoryRevision: revision }),
      () => f.workspaces.applyGitDiff("child", { action: "revert", source: "unstaged", target: "file", path: "inside.txt", expectedRepositoryRevision: revision, confirmRevert: true }),
      () => f.workspaces.commitGitReview("child", { message: "Do not commit outside this project", includeUnstaged: true, expectedRepositoryRevision: revision }),
      () => f.workspaces.pushGitReview("child", { remote: "origin", remoteRef: "refs/heads/main", expectedHeadRevision: head, expectedRepositoryRevision: revision })
    ]) await expect(operation()).rejects.toMatchObject({ kind: "unsupported" });
    expect(f.requests.every(request => request.executable === "git" && request.args.includes("--show-toplevel"))).toBe(true);
    expect(await f.git("rev-parse", "HEAD")).toBe(head); expect(await f.git("diff", "--cached")).toBe("");
    expect(await readFile(join(f.root, "sibling.txt"), "utf8")).toBe("outside changed\n");

    await f.workspaces.register({ ...f.registration, id: "non-git", root: f.outside,
      remote: { ...f.registration.remote, binding: { ...f.registration.remote.binding, workspaceRoot: f.outside } } });
    expect(await f.workspaces.gitState("non-git")).toMatchObject({ repository: false, dirty: false, changes: [] });
  } finally { await f.close(); }
});

it.each(["stage", "unstage", "revert"] as const)("applies remote %s only to the literal selected filename", { timeout: 30_000 }, async action => {
  const f = await fixture();
  try {
    const selected = "report[1].txt", other = "report1.txt";
    for (const name of [selected, other]) await writeFile(join(f.root, name), "base\n");
    await f.git("add", "-A"); await f.git("commit", "-m", "base");
    for (const name of [selected, other]) await writeFile(join(f.root, name), `changed ${name}\n`);
    if (action === "unstage") await f.git("add", "-A");
    const source = action === "unstage" ? "staged" : "unstaged";
    const diff = await f.workspaces.gitReviewDiff("workspace", { source, paths: [selected] });
    expect(diff[source === "staged" ? "index" : "workingTree"]).not.toContain(`b/${other}`);
    await f.workspaces.applyGitDiff("workspace", { action, source, target: "file", path: selected,
      expectedRepositoryRevision: diff.repositoryRevision, ...(action === "revert" ? { confirmRevert: true } : {}) });
    expect(await f.git("diff", "--cached", "--name-only")).toBe(action === "stage" ? selected : action === "unstage" ? other : "");
    expect(await readFile(join(f.root, other), "utf8")).toBe(`changed ${other}\n`);
    expect(await readFile(join(f.root, selected), "utf8")).toBe(action === "revert" ? "base\n" : `changed ${selected}\n`);
  } finally { await f.close(); }
});

it("stages a literal remote hunk without including a matching sibling path", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    for (const name of ["note[1].txt", "note1.txt"]) await writeFile(join(f.root, name), "before\n");
    await f.git("add", "-A"); await f.git("commit", "-m", "base");
    for (const name of ["note[1].txt", "note1.txt"]) await writeFile(join(f.root, name), "after\n");
    const diff = await f.workspaces.gitReviewDiff("workspace", { source: "unstaged" });
    await f.workspaces.applyGitDiffHunk("workspace", { action: "stage", source: "unstaged", path: "note[1].txt", hunkIndex: 0, expectedRepositoryRevision: diff.repositoryRevision });
    expect(await f.git("diff", "--cached", "--name-only")).toBe("note[1].txt");
  } finally { await f.close(); }
});

it("shows bounded untracked remote files and safely stages or discards an exact file", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "seed.txt"), "base\n"); await f.git("add", "-A"); await f.git("commit", "-m", "base");
    await mkdir(join(f.root, "new"));
    await writeFile(join(f.root, "new", "note[1].txt"), "selected new content\n");
    await writeFile(join(f.root, "new", "note1.txt"), "other new content\n");
    await writeFile(join(f.root, "asset.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(f.root, "large.txt"), Buffer.alloc(2 * 1024 * 1024 + 1, "x"));
    const state = await f.workspaces.gitState("workspace");
    expect(state.changes.map(change => change.path).sort()).toEqual(["asset.bin", "large.txt", "new/note1.txt", "new/note[1].txt"].sort());
    const before = await f.workspaces.gitReviewDiff("workspace", { source: "unstaged" });
    expect(before.workingTree).toContain("+selected new content"); expect(before.workingTree).toContain("+other new content");
    expect(before.workingTree).toContain("asset.bin"); expect(before.workingTree).toContain("large.txt");
    expect(Buffer.byteLength(before.workingTree)).toBeLessThan(4_096);
    await f.workspaces.applyGitDiff("workspace", { action: "stage", source: "unstaged", target: "file", path: "new/note[1].txt", expectedRepositoryRevision: before.repositoryRevision });
    expect(await f.git("diff", "--cached", "--name-only")).toBe("new/note[1].txt");
    const afterStage = await f.workspaces.gitReviewDiff("workspace", { source: "unstaged" });
    await expect(f.workspaces.applyGitDiff("workspace", { action: "revert", source: "unstaged", target: "file", path: "new/note1.txt", expectedRepositoryRevision: afterStage.repositoryRevision, confirmRevert: false })).rejects.toMatchObject({ kind: "invalid" });
    await f.workspaces.applyGitDiff("workspace", { action: "revert", source: "unstaged", target: "file", path: "new/note1.txt", expectedRepositoryRevision: afterStage.repositoryRevision, confirmRevert: true });
    await expect(readFile(join(f.root, "new", "note1.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(f.root, "new", "note[1].txt"), "utf8")).toBe("selected new content\n");
    expect(await readFile(join(f.root, "asset.bin"))).toEqual(Buffer.from([0, 1, 2, 3]));
  } finally { await f.close(); }
});

it("keeps one remote rename with its original path and unstages both sides together", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "old[1].txt"), "unchanged rename content\n"); await f.git("add", "-A"); await f.git("commit", "-m", "base");
    await f.git("mv", "--", "old[1].txt", "new[1].txt");
    expect((await f.workspaces.gitState("workspace")).changes).toEqual([{ path: "new[1].txt", originalPath: "old[1].txt", index: "R", worktree: " " }]);
    const diff = await f.workspaces.gitReviewDiff("workspace", { source: "staged" });
    await f.workspaces.applyGitDiff("workspace", { action: "unstage", source: "staged", target: "file", path: "new[1].txt", oldPath: "old[1].txt", expectedRepositoryRevision: diff.repositoryRevision });
    expect(await f.git("diff", "--cached")).toBe("");
    expect(await readFile(join(f.root, "new[1].txt"), "utf8")).toBe("unchanged rename content\n");
    await expect(readFile(join(f.root, "old[1].txt"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await f.close(); }
});

it.each(["stage", "revert"] as const)("applies the displayed untracked remote hunk for %s", { timeout: 30_000 }, async action => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "seed.txt"), "base\n"); await f.git("add", "-A"); await f.git("commit", "-m", "base");
    const selected = "new[1].txt", other = "new1.txt";
    await writeFile(join(f.root, selected), "first new line\nsecond new line\n");
    await writeFile(join(f.root, other), "keep this sibling\n");
    const diff = await f.workspaces.gitReviewDiff("workspace", { source: "unstaged", paths: [selected] });
    expect(diff.workingTree).toContain("@@ -0,0 +1,2 @@");
    const input = { action, source: "unstaged" as const, path: selected, hunkIndex: 0, expectedRepositoryRevision: diff.repositoryRevision };
    if (action === "revert") await expect(f.workspaces.applyGitDiffHunk("workspace", input)).rejects.toMatchObject({ kind: "invalid" });
    const revision = await f.workspaces.applyGitDiffHunk("workspace", { ...input, confirmRevert: action === "revert" });
    if (action === "stage") {
      expect(await f.git("diff", "--cached", "--name-only")).toBe(selected);
      await f.workspaces.applyGitDiffHunk("workspace", { action: "unstage", source: "staged", path: selected, hunkIndex: 0, expectedRepositoryRevision: revision });
      expect(await f.git("diff", "--cached")).toBe("");
      expect(await readFile(join(f.root, selected), "utf8")).toBe("first new line\nsecond new line\n");
    } else await expect(readFile(join(f.root, selected))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(f.root, other), "utf8")).toBe("keep this sibling\n");
  } finally { await f.close(); }
});

it("streams remote content and empty-directory changes and releases its watcher on cancellation", { timeout: 15_000 }, async () => {
  const f = await fixture(), abort = new AbortController();
  const watcher = f.workspaces.watchChanges({ kind: "workspace", workspaceId: "workspace" }, abort.signal);
  try {
    const file = join(f.root, "note.txt"); await writeFile(file, "before");
    expect((await watcher.next()).value?.kind).toBe("resync");
    for (const mutate of [() => writeFile(file, "after!"), () => mkdir(join(f.root, "empty")), () => rmdir(join(f.root, "empty"))]) {
      const next = watcher.next(); await mutate(); expect((await next).value?.kind).toBe("resync");
    }
    const pending = watcher.next(); abort.abort(); expect((await pending).done).toBe(true);
  } finally { abort.abort(); await watcher.return(undefined); await f.close(); }
});
