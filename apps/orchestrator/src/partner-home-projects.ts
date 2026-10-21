import { posix, win32, type PlatformPath } from "node:path";
import type { ApprovedDirectory, PartnerWorkbenchProjectBrief, TargetDescriptor } from "@joko/core";
import { redactSecrets } from "@joko/core";
import type { RemoteExecutionRouter } from "./remote-execution-router.js";
import type { RemoteFileAuthority } from "./remote-execution-router.js";
import type { CodeHostProjectProvider } from "@joko/code-host";

/** Resolves project authority on the real execution computer, never on the service's similarly named path. */
export class PartnerHomeProjects {
  constructor(private readonly options: { readonly execution: Pick<RemoteExecutionRouter, "files" | "processes">;
    readonly home: (targetId: string) => TargetDescriptor | undefined;
    readonly codeHost?: Pick<CodeHostProjectProvider, "read"> }) {}
  remote(target: TargetDescriptor): boolean { return target.remoteWorkspace?.kind === "device_peer" && this.options.home(target.id) !== undefined; }
  paths(target: TargetDescriptor): PlatformPath { return target.remoteWorkspace?.workspaceRoot.startsWith("/") ? posix : win32; }
  normalize(target: TargetDescriptor, raw: string): string {
    const home = this.options.home(target.id), paths = this.paths(target);
    if (!home?.remoteWorkspace || !this.remote(target)) throw new Error("This execution computer has no project authority.");
    const accountHome = paths.dirname(paths.dirname(paths.dirname(paths.dirname(home.remoteWorkspace.workspaceRoot))));
    const value = raw === "~" ? accountHome : /^~[\\/]/u.test(raw) ? paths.join(accountHome, raw.slice(2)) : raw;
    if (!value.trim() || value.length > 32_768 || /[\u0000-\u001f\u007f]/u.test(value) || !paths.isAbsolute(value)) throw new Error("Choose an absolute project directory on the execution computer.");
    const normalized = paths.normalize(value);
    if (normalized === paths.parse(normalized).root || same(normalized, accountHome, paths) || within(normalized, paths.join(accountHome, ".joko"), paths)) {
      throw new Error("Choose a specific project outside managed application data.");
    }
    return normalized;
  }
  async check(target: TargetDescriptor, raw: string, assertCurrent: () => void): Promise<string> {
    const value = this.normalize(target, raw), authority = await this.#authority(target, assertCurrent);
    const actual = await authority.files.realpath(value); authority.assertCurrent(); assertCurrent();
    this.normalize(target, actual);
    if ((await authority.files.stat(actual)).kind !== "directory") throw new Error("The execution computer's project directory is unavailable.");
    authority.assertCurrent(); assertCurrent(); return actual;
  }
  async executionDirectory(target: TargetDescriptor, raw: string, assertCurrent: () => void): Promise<string> {
    const home = this.options.home(target.id);
    if (!home || raw !== home.workspaceRoot) return this.check(target, raw, assertCurrent);
    const authority = await this.#authority(target, assertCurrent), actual = await authority.files.realpath(raw);
    if (actual !== raw || (await authority.files.stat(actual)).kind !== "directory") throw new Error("The Partner home directory changed.");
    authority.assertCurrent(); assertCurrent(); return actual;
  }
  projectFor(target: TargetDescriptor, value: string, projects: readonly string[]): string | undefined {
    const paths = this.paths(target);
    return [...projects].filter(project => within(value, project, paths)).sort((a, b) => b.length - a.length)[0];
  }
  async validateDirectories(target: TargetDescriptor, directories: readonly ApprovedDirectory[], assertCurrent: () => void) {
    const roots: { path: string; access: "read_only" | "read_write" }[] = [], ids = new Set<string>();
    for (const directory of directories) {
      if (!directory.id || ids.has(directory.id) || !["read_only", "read_write"].includes(directory.access)) throw new Error("The remote project grant is invalid.");
      ids.add(directory.id); const actual = await this.check(target, directory.path, assertCurrent);
      if (!same(actual, directory.path, this.paths(target))) throw new Error("The execution computer's project directory changed.");
      roots.push({ path: actual, access: directory.access });
    }
    return roots;
  }
  async resolve(target: TargetDescriptor, project: string, raw: string, assertCurrent: () => void) {
    const paths = this.paths(target), approved = await this.check(target, project, assertCurrent);
    const value = paths.isAbsolute(raw) ? paths.normalize(raw) : paths.join(approved, raw);
    if (!within(value, approved, paths)) throw new Error("The reference is outside the selected project.");
    const authority = await this.#authority(target, assertCurrent), actual = await authority.files.realpath(value);
    authority.assertCurrent(); assertCurrent();
    if (!within(actual, approved, paths)) throw new Error("The reference resolves outside the selected project.");
    const stat = await authority.files.stat(actual); authority.assertCurrent(); assertCurrent();
    if (stat.kind !== "directory" && stat.kind !== "file") throw new Error("The project reference is unavailable.");
    return { actual, project: approved, relativePath: paths.relative(approved, actual).replaceAll("\\", "/"), directory: stat.kind === "directory", authority, stat };
  }
  async read(target: TargetDescriptor, project: string, raw: string, assertCurrent: () => void) {
    const resolved = await this.resolve(target, project, raw, assertCurrent);
    if (resolved.directory || !/\.(?:md|mdx|txt|json|yaml|yml|toml|ini|ts|tsx|js|jsx|py|rs|go|java|c|cc|cpp|h|css|html|xml|sh|ps1)$/iu.test(resolved.actual)) throw new Error("Choose a text file inside this project.");
    const bytes = await resolved.authority.files.read({ path: resolved.actual, maximumBytes: 64 * 1024, allowTruncated: true });
    resolved.authority.assertCurrent(); assertCurrent();
    const source = Buffer.from(bytes).toString("utf8"), text = redactSecrets(source).slice(0, 4000);
    return { path: resolved.actual, text, truncated: resolved.stat.size > bytes.length || source.length > 4000 };
  }
  async brief(target: TargetDescriptor, project: string, assertCurrent: () => void): Promise<PartnerWorkbenchProjectBrief> {
    const root = await this.check(target, project, assertCurrent), authority = await this.#authority(target, assertCurrent), paths = this.paths(target);
    const docs: string[] = [], recent: { path: string; modifiedAt: number }[] = []; let remaining = 3000;
    const visit = async (directory: string, depth: number): Promise<void> => {
      const entries = await authority.files.list(directory); authority.assertCurrent(); assertCurrent();
      for (const entry of entries) {
        if (--remaining < 0) return;
        if (entry.name.startsWith(".") || ["node_modules", "dist", "build", "out", "target", "vendor", "Pods", "DerivedData", "__pycache__"].includes(entry.name)
          || !entry.name || entry.name.includes("/") || entry.name.includes("\\") || entry.name === "..") continue;
        const leaf = paths.join(directory, entry.name);
        if (entry.kind === "directory" && depth < 4) {
          if (await authority.files.realpath(leaf) === leaf) await visit(leaf, depth + 1);
        } else if (entry.kind === "file") {
          if (/\.mdx?$/iu.test(entry.name) && docs.length < 200) docs.push(leaf);
          const stat = await authority.files.stat(leaf); if (stat.modifiedAt >= Date.now() - 14 * 24 * 60 * 60_000) recent.push({ path: leaf, modifiedAt: stat.modifiedAt });
        }
        authority.assertCurrent(); assertCurrent();
      }
    };
    await visit(root, 0);
    const git = (args: readonly string[]) => this.#git(target, root, args, assertCurrent);
    if (await git(["rev-parse", "--is-inside-work-tree"]) !== "true") return { project, docs: docs.sort().slice(0, 30),
      recent: recent.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 20), codeHost: { pullRequests: [], issues: [], unavailable: "not_supported" } };
    const [branch, status, log, refs, upstream, origin] = await Promise.all([
      git(["rev-parse", "--abbrev-ref", "HEAD"]), git(["status", "--porcelain"]),
      git(["log", `--since=${new Date(Date.now() - 14 * 24 * 60 * 60_000).toISOString()}`, "--max-count=30", "--format=%h%x00%cI%x00%an%x00%s"]),
      git(["for-each-ref", "--sort=-committerdate", "--count=10", "--format=%(refname:short)%00%(committerdate:iso-strict)", "refs/heads"]),
      git(["remote", "get-url", "upstream"]), git(["remote", "get-url", "origin"])
    ]);
    const repository = (raw: string | undefined) => /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/u.exec(raw ?? "")?.[1];
    const remotes = [...new Set([repository(upstream), repository(origin)].filter((value): value is string => value !== undefined))], remote = remotes[0];
    const codeHost = remote && this.options.codeHost ? { repository: remote, ...await this.options.codeHost.read(remote, assertCurrent) }
      : { pullRequests: [], issues: [], unavailable: "not_supported" as const };
    assertCurrent(); return { project, docs: docs.sort().slice(0, 30), recent: [], git: {
      ...(branch === undefined || branch === "HEAD" ? {} : { branch }), ...(status === undefined ? {} : { changes: status.split("\n").filter(Boolean).length }),
      commits: (log ?? "").split("\n").filter(Boolean).slice(0, 30).map(line => { const [sha = "", date = "", author = "", subject = ""] = line.split("\0"); return { sha, date, author: author.slice(0, 80), subject: subject.slice(0, 200) }; }),
      branches: (refs ?? "").split("\n").filter(Boolean).slice(0, 10).map(line => { const [name = "", date = ""] = line.split("\0"); return { name, date }; }), remotes
    }, codeHost };
  }
  async #git(target: TargetDescriptor, root: string, args: readonly string[], assertCurrent: () => void): Promise<string | undefined> {
    assertCurrent(); const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    let handle: Awaited<ReturnType<Awaited<ReturnType<RemoteExecutionRouter["processes"]>>["processes"]["open"]>> | undefined;
    try {
      const authority = await this.options.execution.processes(target.remoteWorkspace!, controller.signal); authority.assertCurrent(); assertCurrent();
      handle = await authority.processes.open({ executable: "git", args: ["-C", root, ...args], cwd: root,
        env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, signal: controller.signal });
      const chunks: Buffer[] = []; let size = 0;
      handle.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= 128 * 1024) chunks.push(Buffer.from(chunk)); else controller.abort(); });
      handle.stderr.resume(); handle.stdin.end();
      const code = await new Promise<number | null>((resolve, reject) => {
        if (handle!.exitCode !== null || handle!.signalCode !== null) { resolve(handle!.exitCode); return; }
        handle!.once("exit", resolve); handle!.once("error", reject);
        controller.signal.addEventListener("abort", () => reject(new Error("Project inspection timed out.")), { once: true });
      });
      authority.assertCurrent(); assertCurrent();
      return code === 0 && !controller.signal.aborted && size <= 128 * 1024 ? redactSecrets(Buffer.concat(chunks).toString("utf8")).trim() : undefined;
    } catch { assertCurrent(); return undefined; } finally { clearTimeout(timer); if (controller.signal.aborted) handle?.kill("SIGTERM"); }
  }
  async #authority(target: TargetDescriptor, assertCurrent: () => void): Promise<RemoteFileAuthority> {
    assertCurrent(); if (!target.remoteWorkspace || !this.remote(target)) throw new Error("The execution computer's project owner changed.");
    const authority = await this.options.execution.files(target.remoteWorkspace); authority.assertCurrent(); assertCurrent(); return authority;
  }
}
function same(a: string, b: string, paths: PlatformPath): boolean { return paths === win32 ? a.toLowerCase() === b.toLowerCase() : a === b; }
function within(value: string, root: string, paths: PlatformPath): boolean {
  if (!paths.isAbsolute(value) || !paths.isAbsolute(root)) return false;
  const child = paths.relative(root, value); return child === "" || child !== ".." && !child.startsWith(`..${paths.sep}`) && !paths.isAbsolute(child);
}
