import { cp, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
const source = fileURLToPath(new URL("../src/system-skills/", import.meta.url));
const destination = fileURLToPath(new URL("../dist/system-skills/", import.meta.url));
async function verify(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw Error("Bundled Skill links are not supported.");
  if (stat.isDirectory()) for (const entry of await readdir(path)) await verify(join(path, entry));
  else if (!stat.isFile()) throw Error("Bundled Skills require regular files.");
}
await verify(source);
const expected = resolve(fileURLToPath(new URL("../dist/", import.meta.url)), "system-skills");
if (resolve(destination) !== expected) throw Error("The bundled Skill output is outside its build directory.");
const outputRoot = fileURLToPath(new URL("../dist/", import.meta.url));
await mkdir(outputRoot, { recursive: true });
if (await realpath(outputRoot) !== resolve(outputRoot)) throw Error("The bundled Skill build directory must be canonical.");
if ((await lstat(destination).catch(error => { if (error.code === "ENOENT") return undefined; throw error; }))?.isSymbolicLink()) throw Error("Bundled Skill output cannot be a link.");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });
