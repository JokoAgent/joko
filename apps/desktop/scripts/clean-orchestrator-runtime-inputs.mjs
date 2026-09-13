import { lstat, readFile, realpath, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..", "..", "..");
const runtimePackageRoots = [
  "apps/orchestrator",
  "packages/adapter-claude-code",
  "packages/adapter-codex",
  "packages/adapter-dictation-refinement",
  "packages/adapter-pi",
  "packages/adapter-transcription-openai",
  "packages/adapter-transcription-realtime",
  "packages/code-host",
  "packages/contracts",
  "packages/core",
  "packages/git-safety",
  "packages/local-model-runtime",
  "packages/outbound-network",
  "packages/remote-ssh",
  "packages/runtime-governance",
  "packages/store",
  "packages/tool-android",
  "packages/tool-browser",
  "packages/tool-computer",
  "packages/tool-lsp",
  "packages/voice-input",
  "packages/worktree"
];
const packageManifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
if (packageManifest?.name !== "joko" || !samePath(await realpath(repositoryRoot), repositoryRoot)) {
  throw new Error("Orchestrator runtime clean did not resolve the canonical Joko repository root.");
}

for (const relativeRoot of runtimePackageRoots) {
  const packageRoot = resolve(repositoryRoot, relativeRoot);
  assertContained(repositoryRoot, packageRoot);
  if (!samePath(await realpath(packageRoot), packageRoot)) {
    throw new Error(`Runtime package root is an alias or reparse point: ${relativeRoot}`);
  }
  await removeFixedDirectory(resolve(packageRoot, "dist"));
  await removeFixedFile(resolve(packageRoot, "tsconfig.tsbuildinfo"));
  await removeFixedFile(resolve(packageRoot, "tsconfig.build.tsbuildinfo"));
}

async function removeFixedDirectory(path) {
  assertContained(repositoryRoot, path);
  const info = await lstat(path).catch((error) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (info === undefined) return;
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(path), path)) {
    throw new Error(`Refusing to clean an unsafe runtime dist path: ${path}`);
  }
  await rm(path, { recursive: true, force: false });
}

async function removeFixedFile(path) {
  assertContained(repositoryRoot, path);
  const info = await lstat(path).catch((error) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (info === undefined) return;
  if (!info.isFile() || info.isSymbolicLink() || !samePath(await realpath(path), path)) {
    throw new Error(`Refusing to clean an unsafe runtime build-info path: ${path}`);
  }
  await unlink(path);
}

function assertContained(root, candidate) {
  const suffix = relative(resolve(root), resolve(candidate));
  if (suffix !== "" && !suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix)) return;
  throw new Error(`Runtime clean path escapes or equals the repository root: ${candidate}`);
}

function samePath(left, right) {
  const first = resolve(left);
  const second = resolve(right);
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}
