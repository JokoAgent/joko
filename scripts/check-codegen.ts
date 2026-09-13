import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GENERATED_DIRECTORY = join("packages", "contracts", "src", "gen");

export async function compareGeneratedTrees(expectedRoot: string, actualRoot: string): Promise<readonly string[]> {
  const [expectedFiles, actualFiles] = await Promise.all([
    listFiles(expectedRoot),
    listFiles(actualRoot)
  ]);
  const paths = [...new Set([...expectedFiles, ...actualFiles])].sort();
  const stale: string[] = [];
  for (const path of paths) {
    if (!expectedFiles.includes(path) || !actualFiles.includes(path)) {
      stale.push(path);
      continue;
    }
    const [expected, actual] = await Promise.all([
      readFile(join(expectedRoot, path), "utf8"),
      readFile(join(actualRoot, path), "utf8")
    ]);
    // Git may materialize CRLF on Windows while protoc-gen-es emits LF. The
    // generated program text is authoritative; checkout line endings are not.
    if (normalizeLines(expected) !== normalizeLines(actual)) stale.push(path);
  }
  return stale;
}

async function main(): Promise<void> {
  const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "joko-codegen-check-"));
  try {
    const npmExecPath = process.env["npm_execpath"];
    if (npmExecPath === undefined || npmExecPath === "") {
      throw new Error("codegen:check must run through pnpm so the pinned Buf binary is used.");
    }
    const pnpmArgs = ["exec", "buf", "generate", "--output", temporaryRoot];
    const generated = /\.(?:exe|cmd|bat)$/iu.test(npmExecPath)
      ? spawnSync(npmExecPath, pnpmArgs, { cwd: workspaceRoot, encoding: "utf8", shell: /\.(?:cmd|bat)$/iu.test(npmExecPath) })
      : spawnSync(process.execPath, [npmExecPath, ...pnpmArgs], { cwd: workspaceRoot, encoding: "utf8" });
    if (generated.status !== 0) {
      process.stderr.write(generated.stdout ?? "");
      process.stderr.write(generated.stderr ?? "");
      process.exitCode = generated.status ?? 1;
      return;
    }
    const stale = await compareGeneratedTrees(
      join(workspaceRoot, GENERATED_DIRECTORY),
      join(temporaryRoot, GENERATED_DIRECTORY)
    );
    if (stale.length > 0) {
      process.stderr.write("Generated contracts are stale. Run `pnpm codegen` and commit the result:\n");
      for (const path of stale) process.stderr.write(`  ${path}\n`);
      process.exitCode = 1;
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function listFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(relative(root, absolute));
    }
  }
  await visit(root);
  return files.sort();
}

function normalizeLines(value: string): string {
  return value.replace(/\r\n/gu, "\n");
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  await main();
}
