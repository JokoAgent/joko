import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import { redactSecrets, type PartnerWorkbenchProjectBrief } from "@joko/core";
import type { CodeHostProjectProvider } from "@joko/code-host";

const execFileAsync = promisify(execFile);
const RECENT_MS = 14 * 24 * 60 * 60_000;
const SKIP = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "Pods", "DerivedData", "__pycache__"]);

/** Bounded read-only project facts, adapted from the fixed workbench journey.
 * Authorization stays with the caller and is checked around each async read. */
export class PartnerWorkbenchBriefReader {
  readonly #cache = new Map<string, { readonly at: number; readonly fingerprint: string; readonly brief: PartnerWorkbenchProjectBrief }>();
  constructor(readonly codeHost: Pick<CodeHostProjectProvider, "read">, readonly now: () => number = Date.now) {}

  async read(project: string, assertScope: () => void): Promise<PartnerWorkbenchProjectBrief> {
    assertScope();
    const git = async (args: readonly string[]): Promise<string | undefined> => {
      assertScope();
      try {
        const result = await execFileAsync("git", ["-C", project, ...args], { timeout: 5_000, maxBuffer: 128 * 1024, windowsHide: true,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
        assertScope();
        return redactSecrets(result.stdout).trim();
      } catch { assertScope(); return undefined; }
    };
    const fingerprint = `${(await lstat(project)).mtimeMs}|${await git(["rev-parse", "HEAD"])}|${(await lstat(join(project, ".git", "index")).catch(() => undefined))?.mtimeMs ?? 0}`;
    assertScope();
    const cached = this.#cache.get(project);
    if (cached !== undefined && cached.fingerprint === fingerprint && this.now() - cached.at < 60_000) return cached.brief;
    const docs: string[] = [];
    const recent: { path: string; modifiedAt: number }[] = [];
    let budget = 3_000;
    const visit = async (directory: string, depth: number, insideGit: boolean): Promise<void> => {
      assertScope();
      const children = await readdir(directory, { withFileTypes: true }).catch(() => []);
      assertScope();
      for (const entry of children) {
        if (--budget < 0) return;
        if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory() && depth < (insideGit ? 3 : 4) && (!insideGit || depth > 0 || entry.name === "docs")) {
          if (await realpath(path).catch(() => undefined) === path) await visit(path, depth + 1, insideGit);
        } else if (entry.isFile()) {
          if (docs.length < 200 && /\.mdx?$/iu.test(entry.name)) docs.push(path);
          if (!insideGit) {
            const info = await lstat(path).catch(() => undefined);
            if (info?.isFile() === true && info.mtimeMs >= this.now() - RECENT_MS) recent.push({ path, modifiedAt: info.mtimeMs });
          }
        }
      }
      assertScope();
    };
    const insideGit = await git(["rev-parse", "--is-inside-work-tree"]) === "true";
    await visit(project, 0, insideGit);
    const rank = (path: string): number => {
      const top = !relative(project, path).includes("/") && !relative(project, path).includes("\\");
      const key = /^(readme|design|agents)(\.|$)/iu.test(basename(path));
      return top && key ? 0 : key ? 1 : top ? 2 : 3;
    };
    docs.sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
    let brief: PartnerWorkbenchProjectBrief;
    if (!insideGit) {
      brief = { project, docs: docs.slice(0, 30), recent: recent.sort((left, right) => right.modifiedAt - left.modifiedAt).slice(0, 20),
        codeHost: { pullRequests: [], issues: [], unavailable: "not_supported" } };
    } else {
      const [branch, status, log, refs, upstream, origin] = await Promise.all([
        git(["rev-parse", "--abbrev-ref", "HEAD"]), git(["status", "--porcelain"]),
        git(["log", `--since=${new Date(this.now() - RECENT_MS).toISOString()}`, "--max-count=30", "--format=%h%x00%cI%x00%an%x00%s"]),
        git(["for-each-ref", "--sort=-committerdate", "--count=10", "--format=%(refname:short)%00%(committerdate:iso-strict)", "refs/heads"]),
        git(["remote", "get-url", "upstream"]), git(["remote", "get-url", "origin"])
      ]);
      const repository = (raw: string | undefined): string | undefined => {
        const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/u.exec(raw ?? "");
        return match?.[1];
      };
      const remotes = [...new Set([repository(upstream), repository(origin)].filter((value): value is string => value !== undefined))];
      const remote = remotes[0];
      const codeHost = remote === undefined ? { pullRequests: [], issues: [], unavailable: "not_supported" as const } : { repository: remote, ...await this.codeHost.read(remote, assertScope) };
      brief = { project, docs: docs.slice(0, 30), recent: [], git: {
        ...(branch === undefined || branch === "HEAD" ? {} : { branch }), ...(status === undefined ? {} : { changes: status.split("\n").filter(Boolean).length }),
        commits: (log ?? "").split("\n").filter(Boolean).slice(0, 30).map((line) => {
          const [sha = "", date = "", author = "", subject = ""] = line.split("\0");
          return { sha, date, author: author.slice(0, 80), subject: subject.slice(0, 200) };
        }), branches: (refs ?? "").split("\n").filter(Boolean).slice(0, 10).map((line) => {
          const [name = "", date = ""] = line.split("\0"); return { name, date };
        }), remotes
      }, codeHost };
    }
    assertScope();
    if (this.#cache.size > 64) this.#cache.clear();
    this.#cache.set(project, { at: this.now(), fingerprint, brief });
    return brief;
  }
}
