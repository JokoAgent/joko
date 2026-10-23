import { createHash, randomUUID } from "node:crypto";
import { open, realpath, stat, readdir, mkdir, writeFile, lstat, unlink } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import type { AdapterContext } from "@joko/core";
import type { RemoteFileStat, RemoteProcessHandle } from "@joko/remote-ssh";
import type { Readable } from "node:stream";
import { DEVICE_PEER_RUNTIME_EXECUTABLES } from "@joko/device-peer";
import type { RemoteExecutionRouter, RemoteWorkspaceAuthority } from "./remote-execution-router.js";
import type { ExecutorPathAlias, ExecutorWorkspace } from "./hosted-agent-workspace.js";
import type { SourceInputMount } from "./hosted-agent-source-attachments.js";
import type { HostedAgentExecutorEffects } from "./hosted-agent-executor.js";
import { HostedAgentExecutorError } from "./hosted-agent-executor.js";

const limit = 32 * 1024 * 1024, outputLimit = 8 * 1024 * 1024;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
interface Mount { readonly virtual: string; readonly local: string; readonly assertCurrent: () => void; }
/** File/process authority of the task Device, independently of the Model Host.
 * Private uploaded/approved resource mounts are explicit read-only namespaces. */
export class HostedAgentPeerWorkspace {
  readonly paths: typeof posix;
  readonly #mounts = new Map<string, Mount>();
  readonly #assert: () => void;
  readonly #owner = randomUUID();
  readonly #synced = new Set<string>();
  readonly #receipts = new Map<string, RemoteFileStat>();
  #privateRoot?: string;
  #syncFlight: Promise<void> | undefined;
  home: string;
  temporary: string;
  platform: "win32" | "linux" | "darwin";
  constructor(readonly context: AdapterContext, readonly authority: RemoteWorkspaceAuthority, assertCurrent: () => void) {
    if (context.target.remoteWorkspace?.kind !== "device_peer" || authority.kind !== "device_peer"
      || JSON.stringify(context.target.remoteWorkspace) !== JSON.stringify(authority.binding)) throw new HostedAgentExecutorError("STALE_AUTHORITY");
    this.paths = authority.pathStyle === "win32" ? win32 : posix;
    const boundRoot = authority.pathStyle === "win32" ? authority.binding.workspaceRoot.toLowerCase() : authority.binding.workspaceRoot;
    const taskRoot = authority.pathStyle === "win32" ? context.target.workspaceRoot.toLowerCase() : context.target.workspaceRoot;
    if (this.paths.resolve(boundRoot) !== this.paths.resolve(taskRoot)) throw new HostedAgentExecutorError("STALE_AUTHORITY");
    this.home = context.target.workspaceRoot; this.temporary = context.target.workspaceRoot;
    this.platform = authority.pathStyle === "win32" ? "win32" : "linux";
    this.#assert = () => { context.signal.throwIfAborted(); assertCurrent(); authority.assertCurrent(); authority.assertFilesCurrent(); };
    this.#assert();
  }
  get projection() { return { pathStyle: this.authority.pathStyle, home: this.home, temporary: this.temporary }; }
  assertCurrent(): void { this.#assert(); }
  async initialize(): Promise<void> {
    const root = await this.authority.files.realpath(this.context.target.workspaceRoot, this.context.signal); this.#assert();
    if (!this.same(root, this.context.target.workspaceRoot) || (await this.authority.files.stat(root, this.context.signal)).kind !== "directory") throw new HostedAgentExecutorError("STALE_AUTHORITY");
    const script = 'const os=require("node:os"); process.stdout.write(JSON.stringify({home:os.homedir(),temporary:os.tmpdir(),platform:process.platform}))';
    const result = await this.process(DEVICE_PEER_RUNTIME_EXECUTABLES.node, ["-e", script], root, this.context.signal, 10);
    const metadata = JSON.parse(result.output.toString("utf8")) as { home?: unknown; temporary?: unknown; platform?: unknown };
    const { home, temporary, platform } = metadata;
    if (result.exitCode !== 0 || typeof home !== "string" || typeof temporary !== "string" || !["win32", "linux", "darwin"].includes(String(platform))
      || !this.paths.isAbsolute(home) || !this.paths.isAbsolute(temporary) || (platform === "win32") !== (this.authority.pathStyle === "win32")) throw new HostedAgentExecutorError("EXECUTOR_FAILED");
    this.home = await this.authority.files.realpath(this.paths.resolve(home), this.context.signal);
    this.temporary = await this.authority.files.realpath(this.paths.resolve(temporary), this.context.signal); this.#assert();
    this.platform = platform as "win32" | "linux" | "darwin";
  }
  same(a: string, b: string): boolean { const normalize = (path: string) => this.authority.pathStyle === "win32" ? this.paths.resolve(path).toLowerCase() : this.paths.resolve(path); return normalize(a) === normalize(b); }
  inside(root: string, path: string): boolean { const value = this.paths.relative(root, path); return value === "" || value !== ".." && !value.startsWith(`..${this.paths.sep}`) && !this.paths.isAbsolute(value); }
  #mount(path: string): Mount | undefined { return [...this.#mounts.values()].filter(mount => this.inside(mount.virtual, path)).sort((a, b) => b.virtual.length - a.virtual.length)[0]; }
  mountPath(local: string, assertCurrent: () => void): string {
    const virtual = this.paths.join(this.#resourceRoot(), hash(local));
    this.#mounts.set(virtual, { virtual, local, assertCurrent }); return virtual;
  }
  #resourceRoot(): string { return this.paths.join(this.temporary, `joko-source-${this.#owner}`); }
  async synchronize(signal: AbortSignal): Promise<void> {
    if (this.#syncFlight) { await this.#syncFlight; this.#assert(); signal.throwIfAborted(); return; }
    const work = async () => {
      let count = 0, bytes = 0;
      if (!this.#mounts.size) return;
      const root = this.#resourceRoot(); this.#assert();
      if (!this.#privateRoot) {
        await this.authority.files.mkdir(root, { mode: 0o700, signal }); this.#assert();
        if (!this.same(await this.authority.files.realpath(root, signal), root)) throw new HostedAgentExecutorError("STALE_AUTHORITY");
        await this.authority.files.write({ path: this.paths.join(root, ".joko-owner"), content: Buffer.from(this.#owner), createOnly: true, mode: 0o600, signal }); this.#privateRoot = root;
      }
      if (!this.same(await this.authority.files.realpath(root, signal), root)) throw new HostedAgentExecutorError("STALE_AUTHORITY");
      for (const [path, before] of this.#receipts) {
        const after = await this.authority.files.stat(path, signal); this.#assert();
        if (!sameStat(before, after) || !this.same(await this.authority.files.realpath(path, signal), path)) throw new HostedAgentExecutorError("STALE_AUTHORITY");
      }
      const copy = async (mount: Mount, local: string, remote: string, depth: number): Promise<void> => {
        this.#assert(); mount.assertCurrent(); signal.throwIfAborted();
        if (++count > 4096 || depth > 32) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
        const info = await lstat(local); if (info.isSymbolicLink()) throw new HostedAgentExecutorError("ACCESS_DENIED");
        if (info.isDirectory()) {
          await this.authority.files.mkdir(remote, { recursive: true, mode: 0o700, signal });
          for (const name of await readdir(local)) { if (!name || /[\\/\x00-\x1f]/u.test(name)) throw new HostedAgentExecutorError("ACCESS_DENIED"); await copy(mount, join(local, name), this.paths.join(remote, name), depth + 1); }
        } else {
          if (!info.isFile() || info.size > limit || (bytes += info.size) > 64 * 1024 * 1024) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
          const canonical = await realpath(local), handle = await open(canonical, "r");
          let content: Buffer;
          try { content = await handle.readFile(); } finally { await handle.close(); }
          const after = await lstat(local); mount.assertCurrent(); this.#assert();
          if (after.isSymbolicLink() || info.dev !== after.dev || info.ino !== after.ino || info.size !== after.size || info.mtimeMs !== after.mtimeMs || content.length !== info.size) throw new HostedAgentExecutorError("STALE_AUTHORITY");
          await this.authority.files.write({ path: remote, content, atomic: true, createParents: true, mode: 0o400, signal });
          const receipt = await this.authority.files.stat(remote, signal); this.#assert();
          if (receipt.kind !== "file" || receipt.size !== content.length || !this.same(await this.authority.files.realpath(remote, signal), remote)) throw new HostedAgentExecutorError("STALE_AUTHORITY");
          this.#receipts.set(remote, receipt);
        }
        this.#assert(); mount.assertCurrent();
      };
      for (const mount of this.#mounts.values()) {
        mount.assertCurrent(); if (this.#synced.has(mount.virtual)) continue;
        await copy(mount, mount.local, mount.virtual, 0); this.#synced.add(mount.virtual);
      }
    };
    const flight = work(); this.#syncFlight = flight;
    try { await flight; } finally { if (this.#syncFlight === flight) this.#syncFlight = undefined; }
  }
  async dispose(currentAuthority: RemoteWorkspaceAuthority = this.authority): Promise<void> {
    if (this.#syncFlight) await this.#syncFlight.catch(() => undefined);
    const root = this.#privateRoot; if (!root) return;
    if (JSON.stringify(currentAuthority.binding) !== JSON.stringify(this.authority.binding) || currentAuthority.executionIdentity !== this.authority.executionIdentity) throw new HostedAgentExecutorError("STALE_AUTHORITY");
    const signal = AbortSignal.timeout(15_000), assert = () => { currentAuthority.assertCurrent(); currentAuthority.assertFilesCurrent(); signal.throwIfAborted(); }; assert();
    if (!this.same(root, this.#resourceRoot()) || !this.inside(this.temporary, root) || this.same(root, this.temporary)
      || !this.same(await currentAuthority.files.realpath(root, signal), root)) throw new HostedAgentExecutorError("STALE_AUTHORITY");
    const marker = Buffer.from(await currentAuthority.files.read({ path: this.paths.join(root, ".joko-owner"), maximumBytes: 128, signal })); assert();
    if (marker.toString("utf8") !== this.#owner) throw new HostedAgentExecutorError("ACCESS_DENIED");
    await currentAuthority.files.remove(root, { recursive: true, signal }); assert(); this.#privateRoot = undefined; this.#synced.clear(); this.#receipts.clear();
  }
  projectAliases(aliases: readonly ExecutorPathAlias[], assertCurrent: () => void): readonly ExecutorPathAlias[] {
    return aliases.map(alias => ({ ...alias, to: this.mountPath(alias.to, assertCurrent) }));
  }
  projectInputs(files: readonly SourceInputMount[]): readonly SourceInputMount[] { return files.map(file => ({ ...file, path: this.mountPath(file.path, file.assertCurrent) })); }
  async #local(path: string): Promise<string | undefined> {
    const mount = this.#mount(path); if (!mount) return;
    mount.assertCurrent(); this.#assert();
    const suffix = this.paths.relative(mount.virtual, path).split(this.paths.sep), actual = join(mount.local, ...suffix.filter(Boolean));
    const [root, canonical] = await Promise.all([realpath(mount.local), realpath(actual)]); mount.assertCurrent(); this.#assert();
    const paths = /^[A-Za-z]:|^\\\\/u.test(root) ? win32 : posix, relative = paths.relative(root, canonical);
    if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) throw new HostedAgentExecutorError("ACCESS_DENIED");
    return canonical;
  }
  async canonical(path: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted(); this.#assert();
    if (this.#mount(path)) { await this.#local(path); return this.paths.resolve(path); }
    const tail: string[] = []; let current = this.paths.resolve(path);
    for (;;) {
      try { const real = await this.authority.files.realpath(current, signal); this.#assert(); return this.paths.join(real, ...tail.reverse()); }
      catch (error) {
        this.#assert(); signal.throwIfAborted();
        if (!missing(error)) throw error;
        const parent = this.paths.dirname(current); if (parent === current) throw error;
        tail.push(this.paths.basename(current)); current = parent;
      }
    }
  }
  async info(path: string, signal: AbortSignal): Promise<RemoteFileStat> {
    this.#assert(); const local = await this.#local(path);
    if (local) { const value = await stat(local); this.#assert(); return { kind: value.isFile() ? "file" : value.isDirectory() ? "directory" : "other", size: value.size, modifiedAt: value.mtimeMs, mode: value.mode, version: `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}` }; }
    const value = await this.authority.files.stat(path, signal); this.#assert(); return value;
  }
  async read(path: string, maximum: number, signal: AbortSignal, truncated = false): Promise<Buffer> {
    this.#assert(); const before = await this.info(path, signal), local = await this.#local(path);
    const peerMaximum = Math.min(maximum, 64 * 1024 * 1024);
    if (before.kind !== "file" || !truncated && before.size > maximum) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
    if (!local && !truncated && before.size > peerMaximum) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
    let bytes: Buffer;
    if (local) {
      const handle = await open(local, "r");
      try { const data = Buffer.alloc(Math.min(maximum, before.size)); const result = await handle.read(data, 0, data.length, 0); bytes = data.subarray(0, result.bytesRead); }
      finally { await handle.close(); }
    } else bytes = Buffer.from(await this.authority.files.read({ path, maximumBytes: peerMaximum, ...(before.version ? { expectedVersion: before.version } : {}), allowTruncated: truncated, signal }));
    const after = await this.info(path, signal); this.#assert();
    if (bytes.byteLength > maximum || !truncated && bytes.byteLength !== before.size || !sameStat(before, after) || !this.same(await this.canonical(path, signal), path)) throw new HostedAgentExecutorError("STALE_AUTHORITY");
    return bytes;
  }
  async write(path: string, content: Buffer, signal: AbortSignal): Promise<void> {
    if (this.#mount(path)) throw new HostedAgentExecutorError("ACCESS_DENIED");
    this.#assert(); if (!this.same(await this.canonical(path, signal), path)) throw new HostedAgentExecutorError("STALE_AUTHORITY");
    await this.authority.files.write({ path, content, atomic: true, createParents: true, signal }); this.#assert();
  }
  async directory(path: string, signal: AbortSignal): Promise<readonly string[]> {
    const local = await this.#local(path); this.#assert();
    const names = local ? await readdir(local) : (await this.authority.files.list(path, signal)).map(entry => entry.name);
    this.#assert(); if (names.length > 100_000) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED"); return names;
  }
  async mkdir(path: string, signal: AbortSignal): Promise<void> { if (this.#mount(path)) throw new HostedAgentExecutorError("ACCESS_DENIED"); this.#assert(); await this.authority.files.mkdir(path, { recursive: true, signal }); this.#assert(); }
  async process(executable: string, args: readonly string[], cwd: string, signal: AbortSignal, timeout?: number, onOutput?: (chunk: Buffer) => void): Promise<{ output: Buffer; exitCode: number | null; timedOut: boolean }> {
    this.#assert(); signal.throwIfAborted();
    await this.synchronize(signal);
    if (this.#mount(cwd)) throw new HostedAgentExecutorError("ACCESS_DENIED");
    const child = await this.authority.processes.open({ executable, args, cwd, signal }); this.#assert();
    let output = Buffer.alloc(0), timedOut = false;
    const stop = () => { try { child.kill(); } catch { /* A revoked route cannot be promoted for cancellation. */ } };
    const append = (part: Buffer) => { try { this.#assert(); signal.throwIfAborted(); const chunk = Buffer.from(part); output = Buffer.concat([output, chunk]); if (output.length > outputLimit) output = output.subarray(output.length - outputLimit); onOutput?.(chunk); } catch { stop(); } };
    child.stdout.on("data", append); child.stderr.on("data", append);
    const ended = (stream: Readable) => stream.readableEnded ? Promise.resolve() : new Promise<void>((resolve, reject) => { stream.once("end", resolve); stream.once("error", reject); });
    const exit = child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise<number | null>((resolve, reject) => { child.once("exit", code => resolve(code)); child.once("error", reject); });
    const completion = Promise.all([exit, ended(child.stdout), ended(child.stderr)]);
    const timer = timeout ? setTimeout(() => { timedOut = true; stop(); }, timeout * 1000) : undefined;
    signal.addEventListener("abort", stop, { once: true });
    try {
      const [exitCode] = await completion;
      this.#assert(); signal.throwIfAborted(); return { output, exitCode, timedOut };
    } finally { if (timer) clearTimeout(timer); signal.removeEventListener("abort", stop); }
  }
  async openCodex(signal: AbortSignal): Promise<RemoteProcessHandle> { this.#assert(); await this.synchronize(signal); return this.authority.processes.open({ executable: DEVICE_PEER_RUNTIME_EXECUTABLES.codex, args: ["exec-server", "--listen", "stdio://"], cwd: this.context.target.workspaceRoot, signal }); }
  async execute(command: string, cwd: string, timeout: number, signal: AbortSignal, workspace: ExecutorWorkspace, effects?: HostedAgentExecutorEffects): Promise<Record<string, unknown>> {
    const marker = `\u001eJOKO_CWD_${randomUUID()}:`, shell = effects?.captureCwd
      ? `trap 'joko_shell_exit=$?; printf "${marker}"; ${this.authority.pathStyle === "win32" ? "pwd -W 2>/dev/null || pwd -P" : "pwd -P"}; exit "$joko_shell_exit"' EXIT\n${command}` : command;
    let pending = Buffer.alloc(0), hidingCwd = false;
    const emit = (line: Buffer) => { const position = line.indexOf(marker), visible = position < 0 ? line : line.subarray(0, position); if (visible.length) effects?.onOutput?.(workspace.mapOutputForAgent(visible)); };
    const result = await this.process("bash", ["-lc", shell], cwd, signal, effects?.background ? undefined : timeout,
      effects?.onOutput ? chunk => { if (hidingCwd) return; pending = Buffer.concat([pending, chunk]); const markerAt = pending.indexOf(marker);
        if (markerAt >= 0) { if (markerAt) emit(pending.subarray(0, markerAt)); pending = Buffer.alloc(0); hidingCwd = true; return; }
        for (;;) { const end = pending.indexOf(10); if (end < 0) break; emit(pending.subarray(0, end + 1)); pending = pending.subarray(end + 1); }
        if (pending.length > outputLimit) { emit(pending.subarray(0, pending.length - 1024)); pending = pending.subarray(pending.length - 1024); } } : undefined);
    if (pending.length) emit(pending);
    const position = effects?.captureCwd ? result.output.lastIndexOf(marker) : -1;
    const observed = position < 0 ? cwd : result.output.subarray(position + Buffer.byteLength(marker)).toString("utf8").trim();
    const bytes = position < 0 ? result.output : result.output.subarray(0, position);
    return { output: workspace.mapOutputForAgent(bytes).toString("base64"), exitCode: result.exitCode, timedOut: result.timedOut, aborted: false,
      ...(effects?.captureCwd ? { cwd: workspace.toAgentPath(await this.canonical(observed, signal)) } : {}) };
  }
  async readLines(path: string, range: NonNullable<HostedAgentExecutorEffects["readLines"]>, signal: AbortSignal, workspace: ExecutorWorkspace): Promise<Record<string, unknown>> {
    const bytes = await this.read(path, limit, signal); const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new HostedAgentExecutorError("INVALID_REQUEST");
    const lines = text.split(/\r?\n/u), selected = lines.slice(range.offset - 1, range.offset - 1 + range.limit).map(line => line.slice(0, range.maxLineChars));
    return { lines: workspace.mapOutputLinesForAgent(selected), totalLines: lines.length, sha256: hash(bytes) };
  }
  async captureInput(reference: string, directory: boolean, shadow: string, stagingRoot: string, stageFile = false): Promise<{ path: string; nativePath: string; assertCurrent: () => void; validate: () => Promise<void>; release?: () => Promise<void> }> {
    if (!reference || reference.length > 4096 || posix.isAbsolute(reference) || win32.isAbsolute(reference) || /[\x00-\x1f\x7f]/u.test(reference)) throw new HostedAgentExecutorError("INVALID_REQUEST");
    const path = this.paths.resolve(this.context.target.workspaceRoot, reference);
    if (!this.inside(this.context.target.workspaceRoot, path)) throw new HostedAgentExecutorError("ACCESS_DENIED");
    const actual = await this.canonical(path, this.context.signal), before = await this.info(actual, this.context.signal);
    if (!this.inside(this.context.target.workspaceRoot, actual) || before.kind !== (directory ? "directory" : "file")) throw new HostedAgentExecutorError("ACCESS_DENIED");
    const validate = async () => { this.#assert(); const next = await this.info(actual, this.context.signal); if (!sameStat(before, next) || !this.same(await this.canonical(path, this.context.signal), actual)) throw new HostedAgentExecutorError("STALE_AUTHORITY"); };
    let local = actual;
    if (stageFile) {
      const bytes = await this.read(actual, 256 * 1024 * 1024, this.context.signal); await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      if (await realpath(stagingRoot) !== stagingRoot) throw new HostedAgentExecutorError("STALE_AUTHORITY");
      local = join(stagingRoot, `${randomUUID()}-${hash(bytes)}`);
      await writeFile(local, bytes, { mode: 0o600, flag: "wx" });
    }
    const native = /^[A-Za-z]:|^\\\\/u.test(shadow) ? win32 : posix;
    return { path: local, nativePath: native.join(shadow, ...this.paths.relative(this.context.target.workspaceRoot, actual).split(this.paths.sep)), assertCurrent: this.#assert, validate,
      ...(stageFile ? { release: async () => { if (await realpath(stagingRoot) !== stagingRoot || await realpath(local) !== local) throw new HostedAgentExecutorError("STALE_AUTHORITY"); await unlink(local); } } : {}) };
  }
}
export async function captureHostedAgentPeerWorkspace(context: AdapterContext, router: Pick<RemoteExecutionRouter, "workspace">, assertCurrent: () => void): Promise<HostedAgentPeerWorkspace> {
  const binding = context.target.remoteWorkspace; if (binding?.kind !== "device_peer") throw new HostedAgentExecutorError("INVALID_REQUEST");
  const authority = await router.workspace(binding, context.signal), peer = new HostedAgentPeerWorkspace(context, authority, assertCurrent);
  await peer.initialize(); return peer;
}
export function sameStat(a: RemoteFileStat, b: RemoteFileStat): boolean { return a.kind === b.kind && a.size === b.size && a.modifiedAt === b.modifiedAt && a.version === b.version; }
function missing(error: unknown): boolean { return ["ENOENT", "NOT_FOUND", "not_found"].includes(String((error as { code?: unknown }).code)); }
