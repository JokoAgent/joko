import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const sourceRoot = resolve(desktopRoot, "..", "web", "dist");
const distributionRoot = resolve(desktopRoot, "dist");
const destinationRoot = resolve(distributionRoot, "web");
const temporaryRoot = resolve(distributionRoot, `.web-stage-${randomUUID()}`);
const maximumFiles = 5_000;
const maximumBytes = 256 * 1024 * 1024;
let fileCount = 0;
let byteCount = 0;

assertDirectChild(distributionRoot, destinationRoot, "web");
if (dirname(temporaryRoot) !== distributionRoot || !basename(temporaryRoot).startsWith(".web-stage-")) {
  throw new Error("The temporary Web staging destination is unsafe.");
}

const sourceInfo = await lstat(sourceRoot).catch((error) => {
  throw new Error("The Web distribution is missing; build @joko/web before @joko/desktop.", { cause: error });
});
if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink() || !samePath(await realpath(sourceRoot), sourceRoot)) {
  throw new Error("The Web distribution root must be a canonical regular directory.");
}

try {
  await mkdir(temporaryRoot, { recursive: false, mode: 0o755 });
  await copyTree(sourceRoot, temporaryRoot);
  const entry = join(temporaryRoot, "index.html");
  const entryInfo = await lstat(entry).catch((error) => {
    throw new Error("The Web distribution has no index.html entry.", { cause: error });
  });
  if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) throw new Error("The Web index entry is unsafe.");
  const html = await readFile(entry, "utf8");
  const references = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/giu)]
    .map((match) => match[1])
    .filter((value) => value !== undefined && !value.startsWith("#") && !value.startsWith("data:"));
  if (references.length === 0 || references.some((value) => !value.startsWith("./") || value.includes("\0"))) {
    throw new Error("The Web index must reference only relative staged assets.");
  }
  for (const reference of references) {
    const candidate = resolve(dirname(entry), reference);
    assertContained(temporaryRoot, candidate);
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("A staged Web asset reference is unsafe or missing.");
  }
  await removeExistingDestination(destinationRoot);
  await rename(temporaryRoot, destinationRoot);
} catch (error) {
  await removeTemporaryTree(temporaryRoot);
  throw error;
}

async function copyTree(source, destination) {
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === "." || entry.name === ".." || entry.name.includes("\0")) throw new Error("The Web distribution contains an invalid path.");
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const info = await lstat(sourcePath);
    if (info.isSymbolicLink()) throw new Error("The Web distribution contains a symlink or junction.");
    if (info.isDirectory()) {
      await mkdir(destinationPath, { recursive: false, mode: 0o755 });
      await copyTree(sourcePath, destinationPath);
      continue;
    }
    if (!info.isFile()) throw new Error("The Web distribution contains a special file.");
    fileCount += 1;
    byteCount += info.size;
    if (fileCount > maximumFiles || byteCount > maximumBytes) throw new Error("The Web distribution exceeds the staging limits.");
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
    await chmod(destinationPath, 0o644);
  }
}

function assertContained(root, candidate) {
  const suffix = relative(root, candidate);
  if (suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))) return;
  throw new Error("A Web bundle reference escapes the staging root.");
}

function assertDirectChild(root, candidate, expectedName) {
  if (dirname(candidate) !== root || candidate === root || basename(candidate) !== expectedName) {
    throw new Error("The Web staging destination is unsafe.");
  }
}

async function removeExistingDestination(path) {
  const info = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) return;
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(path), path)) {
    throw new Error("The existing staged Web destination is unsafe.");
  }
  await rm(path, { recursive: true, force: false });
}

async function removeTemporaryTree(path) {
  const info = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) return;
  if (info.isSymbolicLink()) {
    await unlink(path);
    return;
  }
  if (!info.isDirectory() || !samePath(await realpath(path), path)) {
    throw new Error("The temporary Web staging tree is unsafe.");
  }
  await rm(path, { recursive: true, force: false });
}

function samePath(left, right) {
  return process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
}
