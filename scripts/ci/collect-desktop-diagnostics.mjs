import { copyFile, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP) {
  throw new Error("Desktop CI diagnostics require the hosted runner environment.");
}
const root = await realpath(tmpdir());
const destination = resolve(process.env.RUNNER_TEMP, "joko-ci-logs", "smoke-receipts");
await mkdir(destination, { recursive: true });
let copied = 0;
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith("joko-desktop-smoke-")) continue;
  const directory = join(root, entry.name);
  if (await realpath(directory) !== directory) continue;
  for (const name of ["result.txt", "result.txt.managed-process.json"]) {
    const source = join(directory, name);
    const stat = await lstat(source).catch(error => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) continue;
    await copyFile(source, join(destination, `${entry.name}-${name}`));
    copied += 1;
  }
}
console.log(JSON.stringify({ copied, destination }));
