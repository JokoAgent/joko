import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, posix } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import JSZip from "jszip";
import * as tar from "tar";
import type { DevelopmentOwnerOptions, DevelopmentProgress, DevelopmentToolArtifact, DevelopmentToolCheck, DevelopmentToolId } from "./types.js";
import { PersonalDevelopmentError } from "./types.js";
import { DIGEST, exists, fileDigest, managedPath, ordinaryDirectory, readJson, removeManaged, writeJson } from "./storage.js";
import { developmentEnvironment } from "./process.js";

const ARCHIVE_LIMIT = 160 * 1024 ** 2;
export const TOOL_IDS: readonly DevelopmentToolId[] = ["git", "node", "pnpm", "python", "gitLfs"];
export function supportedDevelopmentHost(platform: string, arch: string): boolean {
  return platform === "win32" && arch === "x64" || (platform === "darwin" || platform === "linux") && (arch === "x64" || arch === "arm64");
}
const NODE_HASH: Record<string, string> = {
  "win32-x64": "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97",
  "darwin-arm64": "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6", "darwin-x64": "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026",
  "linux-arm64": "013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30", "linux-x64": "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a"
};
// Publisher release v11.22.0 asset digests, matching this product's packageManager.
const PNPM_HASH: Record<string, string> = {
  "win32-x64": "1de83ad5100acfd2adb5c8bc6f8a428cee9ff4e365deff57c22bfc0cccaa4ddb",
  "darwin-arm64": "2000dcc8f0718852c2806ba4dca1edaedf18a4a39264474d5a1c8fcee250adfd", "darwin-x64": "57a97e6f23a3faffc03153a4ef8c770a0552612b8640aebe39bfdd5754d0ebdc",
  "linux-arm64": "f1426231f365bdfd46c15fa3d1211c3936ee2c4e557afd304f6c66dbf1b2a8bf", "linux-x64": "4c592fa410eb23b69691a9efb9bf21c87c15b3e9d88c6ec8acdd354a0eb8de71"
};
const PYTHON: Record<string, readonly [string, string]> = {
  "win32-x64": ["x86_64-pc-windows-msvc", "63d263ab0162f34a241a56dc5b283c22d6e131f5516117e6a921350c69ba7d4f"],
  "darwin-arm64": ["aarch64-apple-darwin", "d3904bd6a072246e07aa0bdadee9a14e80521e42a943c0848059feb16a2816dc"],
  "darwin-x64": ["x86_64-apple-darwin", "f712a9143c8a5d248438ec7921a0b48d548bca4f1337d33c690d28c2d0504137"],
  "linux-arm64": ["aarch64-unknown-linux-gnu", "01ce0ce9189feaead3298abf10d4efe998c55a489b3d5d38ca4f83dda7e7977e"],
  "linux-x64": ["x86_64-unknown-linux-gnu", "8a689a077337bea6d1c4bc0b7df1d52fcaa28f5f67e50df8bf417c1e3f9d8874"]
};
const LFS: Record<string, string> = {
  "win32-x64": "b62e7b8ceddee635f691233d77de8eaa4b213e9209e0173811d8cfa77f7882c1",
  "darwin-arm64": "caff76a7d070d8160c89bc39b6e85d98f24135b6fed038a3b4de2590d25102d8", "darwin-x64": "f1c17aeca0b4eaab9ea606226477dbed3b84b56fe0811a9f967d2ea2b2393c53",
  "linux-arm64": "ac9c8efac980bb0505ead384d087e2acb6486fd8498691a2165fa174ec6118c2", "linux-x64": "e455e00f15d9b95661b8d53498ffb0c3367962cf1ec73c31ab7369516cd6ab8d"
};
export function developmentToolCatalog(platform: string, arch: string): readonly DevelopmentToolArtifact[] {
  if (!supportedDevelopmentHost(platform, arch)) return [];
  const host = `${platform}-${arch}`; const windows = platform === "win32";
  const node = `node-v22.23.2-${windows ? "win" : platform}-${arch}`;
  const python = PYTHON[host]!; const lfsFormat = platform === "linux" ? "tar.gz" : "zip";
  return [
    ...(windows ? [{ id: "git" as const, version: "2.55.0.5", host, format: "zip" as const,
      url: "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/MinGit-2.55.0.5-64-bit.zip",
      sha256: "56d7b226b7693196cfc71fef26568f536c4a021ab6c37ff2db4287bed908e96e", executable: "cmd/git.exe" }] : []),
    { id: "node", version: "22.23.2", host, format: windows ? "zip" : "tar.gz", sha256: NODE_HASH[host]!,
      url: `https://nodejs.org/dist/v22.23.2/${node}.${windows ? "zip" : "tar.gz"}`, executable: `${node}/${windows ? "node.exe" : "bin/node"}` },
    ...(PNPM_HASH[host] ? [{ id: "pnpm" as const, version: "11.22.0", host, format: windows ? "zip" as const : "tar.gz" as const,
      sha256: PNPM_HASH[host]!, url: host === "darwin-x64" ? "https://registry.npmjs.org/pnpm/-/pnpm-11.22.0.tgz"
        : `https://github.com/pnpm/pnpm/releases/download/v11.22.0/pnpm-${host}.${windows ? "zip" : "tar.gz"}`,
      executable: host === "darwin-x64" ? "package/bin/pnpm.cjs" : windows ? "pnpm.exe" : "pnpm" }] : []),
    { id: "python", version: "3.13.15-20260901", host, format: "tar.gz", sha256: python[1],
      url: `https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.13.15%2B20260901-${python[0]}-install_only_stripped.tar.gz`, executable: windows ? "python/python.exe" : "python/bin/python3.13" },
    { id: "gitLfs", version: "3.8.0", host, format: lfsFormat, sha256: LFS[host]!,
      url: `https://github.com/git-lfs/git-lfs/releases/download/v3.8.0/git-lfs-${windows ? "windows" : platform}-${arch === "x64" ? "amd64" : arch}-v3.8.0.${lfsFormat}`, executable: `git-lfs-3.8.0/git-lfs${windows ? ".exe" : ""}` }
  ];
}
export function safeArchivePath(name: string): string {
  const clean = name.replace(/^(\.\/)+/u, "").replace(/\/$/u, "");
  if (!clean || /[\\:\0]/u.test(clean) || posix.isAbsolute(clean) || clean.split("/").some(part => part === ".." || part === "." || !part)) throw new PersonalDevelopmentError("TOOL_INTEGRITY");
  return clean;
}
/** Hash-verified publisher archives only; preflight the whole tar before writes. */
export async function extractDevelopmentTool(archive: string, destination: string, format: "zip" | "tar.gz", signal: AbortSignal): Promise<void> {
  if ((await stat(archive)).size > ARCHIVE_LIMIT) throw new PersonalDevelopmentError("TOOL_INTEGRITY");
  let count = 0; let expanded = 0;
  const bound = (size: number): void => { if (++count > 30_000 || size > 256 * 1024 ** 2 || (expanded += size) > 1024 ** 3) throw new PersonalDevelopmentError("TOOL_INTEGRITY"); };
  if (format === "zip") {
    const zip = await JSZip.loadAsync(await readFile(archive));
    for (const entry of Object.values(zip.files)) {
      signal.throwIfAborted(); const name = safeArchivePath(entry.name);
      const original = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName;
      if (original && safeArchivePath(original) !== name || typeof entry.unixPermissions === "number" && (entry.unixPermissions & 0o170000) === 0o120000) throw new PersonalDevelopmentError("TOOL_INTEGRITY");
      const target = join(destination, ...name.split("/"));
      if (entry.dir) { bound(0); await mkdir(target, { recursive: true }); continue; }
      await mkdir(dirname(target), { recursive: true }); let size = 0; bound(0);
      await pipeline(entry.nodeStream(), new Transform({ transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length; expanded += chunk.length;
        callback(size > 256 * 1024 ** 2 || expanded > 1024 ** 3 ? new PersonalDevelopmentError("TOOL_INTEGRITY") : null, chunk);
      } }), createWriteStream(target, { flags: "wx", mode: 0o644 }), { signal });
    }
  } else {
    let invalid: unknown;
    const listing = tar.t({ strict: true, onReadEntry(entry) {
      try {
        if (entry.type === "Directory" && /^\.\/?$/u.test(entry.path)) return;
        safeArchivePath(entry.path); bound(entry.size);
        if (!["File", "Directory", "SymbolicLink", "Link"].includes(entry.type)) throw new PersonalDevelopmentError("TOOL_INTEGRITY");
        if (entry.type === "SymbolicLink" || entry.type === "Link") {
          const link = entry.linkpath; if (!link || /[\\:\0]/u.test(link) || posix.isAbsolute(link)) throw new PersonalDevelopmentError("TOOL_INTEGRITY");
          safeArchivePath(posix.join(entry.type === "Link" ? "" : posix.dirname(entry.path), link));
        }
      } catch (error) { invalid = error; }
    } });
    await pipeline(createReadStream(archive), listing, { signal }); if (invalid) throw invalid;
    await pipeline(createReadStream(archive), tar.x({ cwd: destination, strict: true, preservePaths: false, noMtime: true }), { signal });
  }
  signal.throwIfAborted();
}
export class DevelopmentTools {
  readonly #catalog: readonly DevelopmentToolArtifact[];
  readonly #executables = new Map<DevelopmentToolId, string>();
  constructor(readonly root: string, readonly options: DevelopmentOwnerOptions) {
    this.#catalog = options.toolArtifacts ?? developmentToolCatalog(options.platform ?? process.platform, options.arch ?? process.arch);
  }
  executable(id: DevelopmentToolId): string {
    const executable = this.#executables.get(id); if (!executable) throw new PersonalDevelopmentError("ENVIRONMENT_NOT_READY"); return executable;
  }
  async run(id: DevelopmentToolId, args: readonly string[], cwd: string, signal: AbortSignal,
    options: { readonly environment?: NodeJS.ProcessEnv; readonly timeoutMs?: number; readonly maxOutputBytes?: number;
      readonly onProgress?: (progress: DevelopmentProgress) => void } = {}) {
    const executable = this.executable(id); const script = executable.endsWith(".cjs");
    const result = await this.options.process.run({ executable: script ? this.executable("node") : executable,
      args: script ? [executable, ...args] : args, cwd, environment: { ...this.environment(), ...options.environment },
      signal, timeoutMs: options.timeoutMs ?? 120_000, maxOutputBytes: options.maxOutputBytes, outputMode: id === "pnpm" ? "tail" : "strict", onProgress: options.onProgress });
    if (result.exitCode !== 0) throw new PersonalDevelopmentError("COMMAND_FAILED", result.exitCode);
    return result.stdout.trim();
  }
  environment(): NodeJS.ProcessEnv {
    const env = developmentEnvironment(this.options.environment); const paths = [...this.#executables.values()].filter(isAbsolute).map(value => dirname(value));
    return { ...env, PATH: [...new Set([...paths, env.PATH ?? env.Path ?? ""])].join((this.options.platform ?? process.platform) === "win32" ? ";" : ":") };
  }
  async check(signal: AbortSignal): Promise<readonly DevelopmentToolCheck[]> {
    const checks: DevelopmentToolCheck[] = [];
    for (const id of TOOL_IDS) {
      signal.throwIfAborted();
      const artifact = this.#catalog.find(value => value.id === id);
      const executable = artifact ? await this.#installed(artifact) : undefined;
      const candidates = [...new Set([executable, ...await this.#systemCandidates(id)].filter((value): value is string => !!value))];
      let found: DevelopmentToolCheck | undefined;
      for (const candidate of candidates) {
        const version = await this.#probe(id, candidate, signal); if (!version) continue;
        this.#executables.set(id, candidate); found = { id, executable: candidate, version, status: "ready", source: candidate === executable ? "managed" : "system" }; break;
      }
      if (!found) this.#executables.delete(id);
      checks.push(found ?? { id, status: "missing" });
    }
    return checks;
  }
  async prepare(signal: AbortSignal, progress: (stage: string, percent?: number, check?: DevelopmentToolCheck) => void): Promise<readonly DevelopmentToolCheck[]> {
    const checks = await this.check(signal);
    for (const check of checks) {
      if (check.status === "ready") continue;
      const artifact = this.#catalog.find(value => value.id === check.id);
      if (!artifact) throw new PersonalDevelopmentError("TOOL_UNAVAILABLE");
      progress(`installing:${check.id}`, undefined, { id: check.id, status: "downloading", source: "managed", version: artifact.version, progress: { loaded: 0, total: null, percent: null } });
      await this.#install(artifact, signal, (stage, download) => progress(`${stage}:${check.id}`, download?.percent ?? undefined, {
        id: check.id, status: stage === "downloading" ? "downloading" : stage === "verifying" ? "verifying" : "extracting", source: "managed", version: artifact.version,
        ...(download ? { progress: download } : {})
      }));
    }
    return this.check(signal);
  }
  async #systemCandidates(id: DevelopmentToolId): Promise<readonly string[]> {
    const env = developmentEnvironment(this.options.environment); const windows = (this.options.platform ?? process.platform) === "win32";
    const names = id === "python" ? ["python3", "python"] : [id === "gitLfs" ? "git-lfs" : id];
    const found: string[] = [];
    for (const directory of (env.PATH ?? env.Path ?? "").split(windows ? ";" : ":")) {
      const path = directory.replace(/^"|"$/gu, ""); if (!isAbsolute(path)) continue;
      for (const name of names) for (const extension of windows ? [".exe", ".com"] : [""]) {
        try { const candidate = await realpath(join(path, name + extension)); if ((await stat(candidate)).isFile()) found.push(candidate); }
        catch { /* Continue through the fixed executable names in the selected system PATH. */ }
      }
    }
    return found;
  }
  async #probe(id: DevelopmentToolId, executable: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      const script = executable.endsWith(".cjs");
      const result = await this.options.process.run({ executable: script ? this.executable("node") : executable,
        args: script ? [executable, "--version"] : ["--version"], cwd: this.root,
        environment: this.environment(), signal, timeoutMs: 15_000, maxOutputBytes: 8192 });
      if (result.exitCode !== 0) return;
      const match = /(?:^v|git version |git-lfs\/|Python )?(\d+)\.(\d+)\.(\d+)/u.exec(result.stdout.trim()); if (!match) return;
      const major = Number(match[1]); const minor = Number(match[2]);
      const valid = id === "node" ? major > 22 || major === 22 && minor >= 19
        : id === "pnpm" ? `${major}.${minor}.${match[3]}` === "11.22.0"
        : id === "git" ? major >= 2 : id === "python" ? major === 3 && minor >= ((this.options.platform ?? process.platform) === "darwin" ? 10 : 9) : true;
      return valid ? `${major}.${minor}.${match[3]}` : undefined;
    } catch (error) {
      if (signal.aborted || error instanceof PersonalDevelopmentError && error.code === "PROCESS_UNKNOWN") throw error;
      return;
    }
  }
  #toolRoot(artifact: DevelopmentToolArtifact): string {
    if (!DIGEST.test(artifact.sha256) || !/^[A-Za-z0-9._-]+$/u.test(`${artifact.id}-${artifact.version}-${artifact.host}`)) throw new PersonalDevelopmentError("TOOL_INTEGRITY");
    safeArchivePath(artifact.executable); const url = new URL(artifact.url);
    if (url.protocol !== "https:" || url.username || url.password) throw new PersonalDevelopmentError("TOOL_INTEGRITY");
    return join(this.root, "tools", `${artifact.id}-${artifact.version}-${artifact.host}-${artifact.sha256.slice(0, 12)}`);
  }
  async #installed(artifact: DevelopmentToolArtifact): Promise<string | undefined> {
    try {
      const root = this.#toolRoot(artifact); const value = await readJson(join(root, "current.json")) as { format?: unknown; generation?: unknown; sha256?: unknown; executableDigest?: unknown };
      if (value.format !== 1 || value.sha256 !== artifact.sha256 || typeof value.generation !== "string" || !/^[0-9a-f-]{36}$/u.test(value.generation)) return;
      const executable = await managedPath(this.root, join(root, value.generation, artifact.executable));
      if (await fileDigest(executable) !== value.executableDigest) return; return executable;
    } catch { return; }
  }
  async #install(artifact: DevelopmentToolArtifact, signal: AbortSignal, progress: (stage: string, download?: DevelopmentToolCheck["progress"]) => void): Promise<void> {
    const root = this.#toolRoot(artifact); await mkdir(root, { recursive: true }); await ordinaryDirectory(root);
    const staging = await mkdtemp(join(root, ".staging-")); let promoted: string | undefined; let unknown = false;
    try {
      const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(20 * 60_000)]);
      const response = await (this.options.fetch ?? fetch)(artifact.url, { signal: downloadSignal, redirect: "follow", cache: "no-store" });
      if (!response.ok || !response.body || Number(response.headers.get("content-length") ?? 0) > ARCHIVE_LIMIT) throw new PersonalDevelopmentError("TOOL_UNAVAILABLE");
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      let total = Number.isSafeInteger(contentLength) && contentLength > 0 && contentLength <= ARCHIVE_LIMIT ? contentLength : null;
      const archive = join(staging, "archive"); let bytes = 0; let lastPercent: number | null = -1; let publishedBytes = 0;
      progress("downloading", { loaded: 0, total, percent: total === null ? null : 0 });
      const file = createWriteStream(archive, { flags: "wx", mode: 0o600 });
      await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (total !== null && bytes > total) total = null;
        const percent = total === null ? null : Math.min(100, Math.floor(bytes / total * 100));
        if (percent !== lastPercent || bytes - publishedBytes >= 512 * 1024) {
          lastPercent = percent; publishedBytes = bytes; progress("downloading", { loaded: bytes, total, percent });
        }
        callback(bytes > ARCHIVE_LIMIT ? new PersonalDevelopmentError("TOOL_INTEGRITY") : null, chunk);
      } }), file, { signal: downloadSignal });
      progress("downloading", { loaded: bytes, total, percent: total === null ? null : Math.min(100, Math.floor(bytes / total * 100)) });
      progress("verifying");
      if (await fileDigest(archive) !== artifact.sha256) throw new PersonalDevelopmentError("TOOL_INTEGRITY");
      const payload = join(staging, "payload"); await mkdir(payload); progress("extracting");
      await extractDevelopmentTool(archive, payload, artifact.format, signal);
      const executable = await managedPath(this.root, join(payload, artifact.executable)); await chmod(executable, 0o755);
      if (!await this.#probe(artifact.id, executable, signal)) throw new PersonalDevelopmentError("TOOL_UNAVAILABLE");
      signal.throwIfAborted(); const generation = crypto.randomUUID(); promoted = join(root, generation);
      const executableDigest = await fileDigest(executable); await rename(payload, promoted);
      await writeJson(join(root, "current.json"), { format: 1, generation, sha256: artifact.sha256, executableDigest });
      this.#executables.set(artifact.id, join(promoted, artifact.executable)); promoted = undefined;
    } catch (error) { unknown = error instanceof PersonalDevelopmentError && error.code === "PROCESS_UNKNOWN"; throw error; }
    finally {
      if (!unknown) await removeManaged(this.root, staging).catch(() => undefined);
      if (!unknown && promoted && await exists(promoted)) await removeManaged(this.root, promoted).catch(() => undefined);
    }
  }
}
