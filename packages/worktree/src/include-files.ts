import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, realpath, symlink } from "node:fs/promises";
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

/** Only ignored content already stored in the durable Git recovery tree may be removed. */
export async function cleanCapturedIgnoredIncludes(root: string, snapshot: string, control: WorktreeOperationControl): Promise<void> {
  const ignored = (await runGit(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], root, control)).stdout.split("\0").filter(Boolean);
  if (ignored.length === 0) return;
  const tree = (await runGit(["ls-tree", "-r", "-z", `${snapshot}^3`], root, control)).stdout;
  const captured = new Map(tree.split("\0").filter(Boolean).map(entry => {
    const tab = entry.indexOf("\t"), metadata = entry.slice(0, tab).split(" ");
    return [entry.slice(tab + 1), { mode: metadata[0], oid: metadata[2] }] as const;
  }));
  const algorithm = (await runGit(["rev-parse", "--show-object-format"], root, control)).stdout.trim();
  if (algorithm !== "sha1" && algorithm !== "sha256") throw new WorktreeServiceError("STATE_CORRUPT", "The repository object format is invalid.");
  for (const path of ignored) {
    control.check();
    const saved = captured.get(path);
    if (!safeRelativePath(path) || saved === undefined) throw new WorktreeServiceError("SESSION_CONFLICT", "An ignored file has no captured recovery authority.");
    const absolute = resolve(root, path);
    await ordinaryParents(root, absolute, false);
    const info = await lstat(absolute);
    let oid: string;
    if (info.isSymbolicLink() && saved.mode === "120000") {
      const bytes = Buffer.from(await readlink(absolute));
      oid = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    } else if (info.isFile() && (saved.mode === "100644" || saved.mode === "100755")) {
      oid = (await runGit(["--literal-pathspecs", "hash-object", "--", path], root, control)).stdout.trim();
    } else throw new WorktreeServiceError("SESSION_CONFLICT", "An ignored recovery file changed type.");
    if (oid !== saved.oid) throw new WorktreeServiceError("SESSION_CONFLICT", "An ignored recovery file changed after capture.");
  }
  for (let offset = 0; offset < ignored.length; offset += 100) {
    await runGit(["--literal-pathspecs", "clean", "-fdx", "--", ...ignored.slice(offset, offset + 100)], root, control);
  }
}
