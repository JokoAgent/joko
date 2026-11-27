import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readlink, realpath, rm, rmdir, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { WorktreeServiceError } from "./errors.js";
import { runGit } from "./git.js";
import type { WorktreeOperationControl } from "./operation.js";

type Matcher = (path: string) => boolean;
const RULE_FILES = [".jokoworktreeinclude", ".worktreeinclude"] as const;

/** The two project-owned rule files independently select untracked local files. */
export async function readWorktreeIncludeMatcher(root: string): Promise<Matcher> {
  const matchers: Matcher[] = [];
  for (const name of RULE_FILES) {
    let handle;
    try {
      handle = await open(join(root, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (!info.isFile() || info.size > 256 * 1024 || (await lstat(join(root, name))).isSymbolicLink()) {
        throw new WorktreeServiceError("PATH_UNSAFE", "The worktree include rules are unsafe.");
      }
      const lines = (await handle.readFile("utf8")).split(/\r?\n/u).map(line => line.trim())
        .filter(line => line !== "" && !line.startsWith("#"));
      matchers.push(name === ".worktreeinclude" ? gitignoreMatcher(lines) : globMatcher(lines));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally { await handle?.close(); }
  }
  return path => safeRelativePath(path) && matchers.some(matches => matches(path));
}

function safeRelativePath(path: string): boolean {
  return path !== "" && !isAbsolute(path) && !path.includes("\\") && !path.includes("\0")
    && !path.split("/").some(part => part === ".." || part === ".git" || part === "");
}

function gitignoreGlob(pattern: string): RegExp {
  let expression = "";
  const segments = pattern.split("/");
  for (const [index, segment] of segments.entries()) {
    if (segment === "**") { expression += index === segments.length - 1 ? ".*" : "(?:.*\\/)?"; continue; }
    expression += segment.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*+/gu, "[^/]*").replaceAll("?", "[^/]");
    if (index !== segments.length - 1) expression += "\\/";
  }
  return new RegExp(`^${expression}$`, "u");
}

function globMatcher(patterns: readonly string[]): Matcher {
  const regexes = patterns.map(pattern => {
    let expression = "";
    for (let index = 0; index < pattern.length; index++) {
      const character = pattern[index]!;
      if (character === "*" && pattern[index + 1] === "*") {
        index++;
        if (pattern[index + 1] === "/") { expression += "(?:.*\\/)?"; index++; }
        else if (index === pattern.length - 1 && expression.endsWith("/")) {
          expression = `${expression.slice(0, -1)}(?:/.*)?`;
        } else expression += ".*";
      } else if (character === "*") expression += "[^/]*";
      else if (character === "?") expression += "[^/]";
      else expression += character.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }
    return new RegExp(`^${expression}$`, "u");
  });
  return path => regexes.some(regex => regex.test(path));
}

/** Ordered negation, root anchoring and directory selection follow the native convention. */
function gitignoreMatcher(patterns: readonly string[]): Matcher {
  const rules = patterns.flatMap(raw => {
    const negate = raw.startsWith("!");
    let pattern = negate ? raw.slice(1) : raw;
    const contentsOnly = pattern.endsWith("/**");
    if (contentsOnly) pattern = pattern.slice(0, -3);
    const directoryOnly = contentsOnly || pattern.endsWith("/");
    if (pattern.endsWith("/")) pattern = pattern.slice(0, -1);
    const anchored = contentsOnly || pattern.includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    if (pattern === "") return contentsOnly ? [{ regex: /^.+$/u, negate, directoryOnly: false }] : [];
    return [{ regex: gitignoreGlob(anchored ? pattern : `**/${pattern}`), negate, directoryOnly }];
  });
  return path => {
    const segments = path.split("/");
    const parents = segments.slice(1).map((_, index) => segments.slice(0, index + 1).join("/"));
    let included = false;
    for (const rule of rules) {
      if ((!rule.directoryOnly && rule.regex.test(path)) || parents.some(parent => rule.regex.test(parent))) included = !rule.negate;
    }
    return included;
  };
}

function inside(root: string, path: string): boolean {
  const key = relative(root, path);
  return key === "" || !isAbsolute(key) && key !== ".." && !key.startsWith(`..${sep}`);
}

async function ordinaryParents(root: string, path: string, create: boolean): Promise<void> {
  let current = root;
  for (const segment of relative(root, dirname(path)).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (create) await mkdir(current).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(root, await realpath(current))) {
      throw new WorktreeServiceError("PATH_UNSAFE", "A worktree include parent changed unsafely.");
    }
  }
}

/** Copy only new paths, never index entries, destination HEAD files or symlink parents. */
export async function copyWorktreeIncludeFiles(source: string, destination: string, control: WorktreeOperationControl): Promise<void> {
  const matches = await readWorktreeIncludeMatcher(source);
  const tracked = [
    ...(await runGit(["ls-files", "-z"], source, control)).stdout.split("\0"),
    ...(await runGit(["ls-tree", "-r", "-z", "--name-only", "HEAD"], destination, control)).stdout.split("\0")
  ].filter(Boolean);
  const candidates = new Set([
    ...(await runGit(["ls-files", "--others", "--exclude-standard", "-z"], source, control)).stdout.split("\0"),
    ...(await runGit(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], source, control)).stdout.split("\0")
  ]);
  const sourceRoot = await realpath(source), destinationRoot = await realpath(destination);
  for (const key of candidates) {
    control.check();
    if (!matches(key) || key.split("/")[0] === "node_modules" || tracked.some(path =>
      path === key || key.startsWith(`${path}/`) || path.startsWith(`${key}/`))) continue;
    const from = resolve(sourceRoot, key), to = resolve(destinationRoot, key);
    if (!inside(sourceRoot, from) || !inside(destinationRoot, to)) throw new WorktreeServiceError("PATH_UNSAFE", "A worktree include path escaped its root.");
    await ordinaryParents(sourceRoot, from, false);
    await ordinaryParents(destinationRoot, to, true);
    try { await lstat(to); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const sourceInfo = await lstat(from);
    if (sourceInfo.isSymbolicLink()) {
      const target = await readlink(from);
      if (isAbsolute(target) || !inside(sourceRoot, await realpath(from)) || !inside(destinationRoot, resolve(dirname(to), target))) continue;
      await symlink(target, to);
    } else if (sourceInfo.isFile()) {
      const input = await open(from, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await input.stat();
        if (!info.isFile() || info.ino !== sourceInfo.ino || info.dev !== sourceInfo.dev) throw new WorktreeServiceError("PATH_UNSAFE", "A worktree include source changed.");
        const output = await open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), info.mode & 0o777);
        try {
          for await (const chunk of input.readableWebStream({ autoClose: false })) {
            control.check();
            let offset = 0;
            const bytes = new Uint8Array(chunk);
            while (offset < bytes.length) offset += (await output.write(bytes, offset, bytes.length - offset)).bytesWritten;
          }
          await ordinaryParents(destinationRoot, to, false);
        } finally { await output.close(); }
      } finally { await input.close(); }
    }
  }
}

function checkoutBytesChanged(): WorktreeServiceError {
  return new WorktreeServiceError("SESSION_CONFLICT", "File bytes changed after archive capture.");
}

async function checkoutFileDigest(path: string, control: WorktreeOperationControl): Promise<string> {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink()) return `link:${(await readlink(path, { encoding: "buffer" })).toString("hex")}`;
  if (!info.isFile()) throw checkoutBytesChanged();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw checkoutBytesChanged();
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      control.check();
      hash.update(chunk);
    }
    return hash.digest("hex");
  } finally { await handle.close(); }
}

// A clean filter can map different bytes to one blob. Compare with the bytes
// Git actually checks out, including line endings and symlink representation.
async function assertIndexCheckoutBytes(root: string, indexFile: string, paths: readonly string[], control: WorktreeOperationControl): Promise<void> {
  const expected = join(dirname(indexFile), "checkout");
  await mkdir(expected);
  const prefix = expected.split(sep).join("/") + "/";
  for (let offset = 0; offset < paths.length; offset += 100) {
    const batch = paths.slice(offset, offset + 100);
    if (!batch.every(safeRelativePath)) throw checkoutBytesChanged();
    await runGit(["checkout-index", `--prefix=${prefix}`, "-z", "--stdin"], root, control,
      { indexFile, input: batch.join("\0") + "\0" });
    for (const key of batch) {
      control.check();
      const path = join(root, key), reference = join(expected, key);
      await ordinaryParents(root, path, false);
      const [actual, archived] = await Promise.all([checkoutFileDigest(path, control), checkoutFileDigest(reference, control)]);
      if (actual !== archived) throw checkoutBytesChanged();
      await unlink(reference);
    }
  }
}

export async function assertTrackedCheckoutBytes(root: string, tree: string, control: WorktreeOperationControl): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), "joko-worktree-tracked-"));
  try {
    const indexFile = join(temp, "index");
    await runGit(["read-tree", tree], root, control, { indexFile });
    const listing = await runGit(["ls-files", "--stage", "-z"], root, control, { indexFile });
    const paths = listing.stdout.split("\0").filter(entry => entry.startsWith("100") || entry.startsWith("120000 "))
      .map(entry => entry.slice(entry.indexOf("\t") + 1));
    await assertIndexCheckoutBytes(root, indexFile, paths, control);
  } finally { await rm(temp, { recursive: true, force: true, maxRetries: 3 }); }
}

/** A restart can leave any subset of the archived untracked files on disk. */
export async function cleanCapturedUntrackedFiles(root: string, snapshot: string, control: WorktreeOperationControl, resuming: boolean): Promise<void> {
  const paths = (await runGit(["ls-files", "--others", "-z"], root, control)).stdout.split("\0").filter(Boolean);
  const changed = () => new WorktreeServiceError("SESSION_CONFLICT", "Untracked work changed after archive capture.");
  const parents = (await runGit(["rev-list", "-n", "1", "--parents", snapshot], root, control)).stdout.trim().split(/\s+/u);
  if (parents.length !== 4) {
    if (paths.length !== 0) throw changed();
    return;
  }
  const captured = (await runGit(["rev-parse", `${snapshot}^3^{tree}`], root, control)).stdout.trim();
  const files = new Map<string, BigIntStats>();
  for (const key of paths) {
    if (!safeRelativePath(key)) throw changed();
    const path = resolve(root, key);
    await ordinaryParents(root, path, false);
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() && !info.isSymbolicLink()) throw changed();
    files.set(path, info);
  }

  // Seed a private index with the whole captured tree. Adding only the files
  // still present allows an interrupted removal while detecting new paths,
  // changed bytes, file types and executable modes under Git's own rules.
  const temp = await mkdtemp(join(tmpdir(), "joko-worktree-cleanup-"));
  try {
    const indexFile = join(temp, "index");
    await runGit(["read-tree", captured], root, control, { indexFile });
    for (let offset = 0; offset < paths.length; offset += 100) {
      await runGit(["--literal-pathspecs", "add", "-f", "--", ...paths.slice(offset, offset + 100)], root, control, { indexFile });
    }
    if ((await runGit(["write-tree"], root, control, { indexFile })).stdout.trim() !== captured) throw changed();
    if (resuming) await assertIndexCheckoutBytes(root, indexFile, paths, control);
  } finally { await rm(temp, { recursive: true, force: true, maxRetries: 3 }); }

  for (const [path, original] of files) {
    await ordinaryParents(root, path, false);
    const current = await lstat(path, { bigint: true });
    if (current.dev !== original.dev || current.ino !== original.ino || current.mode !== original.mode ||
      current.size !== original.size || current.mtimeNs !== original.mtimeNs || current.ctimeNs !== original.ctimeNs) throw changed();
    control.check();
    await unlink(path);
  }
  // Resume even if the last file was unlinked just before the process stopped.
  const directories = (await runGit(["ls-tree", "-rdz", "--name-only", captured], root, control)).stdout.split("\0").filter(Boolean);
  for (const key of directories.sort((a, b) => b.length - a.length)) {
    if (!safeRelativePath(key)) throw changed();
    const path = resolve(root, key);
    control.check();
    try {
      await ordinaryParents(root, path, false);
      await rmdir(path);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
}
