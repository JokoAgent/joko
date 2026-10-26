import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const mobile = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko mobile workspace inputs-"));
  const scripts = join(root, "apps", "mobile", "scripts");
  await mkdir(scripts, { recursive: true });
  for (const name of ["prepare-workspace-inputs.mjs", "run-expo.mjs", "build-android-artifacts.mjs", "build-ios-artifact.mjs", "release-artifact-lib.mjs"]) {
    await copyFile(join(mobile, "scripts", name), join(scripts, name));
  }
  await copyFile(join(mobile, "app.json"), join(root, "apps", "mobile", "app.json"));
  const manager = join(root, "pnpm.mjs");
  await writeFile(join(scripts, 'prepare-linkspan-runtimes.mjs'), `import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path'; writeFileSync(resolve('linkspan-runtime-call.json'), JSON.stringify(process.argv.slice(2)));`);
  await writeFile(join(scripts, 'prepare-linkspan-native.mjs'), `import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path'; export async function prepareMobileLinkspanNative({platform}) { writeFileSync(resolve('linkspan-native-call.json'), JSON.stringify({platform})); return {enabled:false,targets:[]}; }`);
  await writeFile(manager, `
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
writeFileSync(join(root,'build-call.json'),JSON.stringify(process.argv.slice(2)));
if(process.env.JOKO_FIXTURE_PREPARE_FAIL==='1') process.exit(7);
for(const path of ['packages/contracts/dist/index.js','packages/connection-transport/dist/index.js','packages/connection-transport/dist/trust.js','packages/remote-desktop-sync/dist/index.js']){
  const file=join(root,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,'export {};');
}
`);
  let executable = manager;
  if (process.platform === "win32") {
    executable = join(root, "pnpm.cmd");
    await writeFile(executable, `@echo off\r\n"${process.execPath}" "${manager}" %*\r\n`);
  }
  const expo = join(root, "apps", "mobile", "node_modules", "expo");
  await mkdir(join(expo, "bin"), { recursive: true });
  await writeFile(join(expo, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(expo, "bin", "cli"), `
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../../..');
for(const entry of ['packages/contracts/dist/index.js','packages/connection-transport/dist/index.js','packages/connection-transport/dist/trust.js','packages/remote-desktop-sync/dist/index.js'])
  if(!existsSync(join(root,entry))) throw new Error('Expo received an unprepared workspace export.');
writeFileSync(join(root,'expo-call.json'),JSON.stringify(process.argv.slice(2)));
`);
  return { root, scripts,
    run: (name: string, args: readonly string[], fail = false) => {
      // Windows child environments deduplicate names without regard to case.
      // Remove inherited variants before selecting this fixture's real .cmd.
      const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
        !["npm_execpath", "joko_fixture_prepare_fail"].includes(name.toLowerCase())));
      return execute(process.execPath, [join(scripts, name), ...args], {
        cwd: root, env: { ...environment, NODE_ENV: process.env.NODE_ENV,
          npm_execpath: executable, JOKO_FIXTURE_PREPARE_FAIL: fail ? "1" : "0" }, windowsHide: true
      });
    },
    async close() {
      if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error("Fixture cleanup escaped its temporary parent.");
      await rm(root, { recursive: true, force: true });
    }
  };
}

it.each([
  ["start", "--offline"], ["run:android"], ["run:ios"],
  ["export", "--platform", "android", "--max-workers", "2"], ["export", "--platform", "ios"]
])("prepares missing client exports before the formal Expo command %j", async (...args) => {
  const f = await fixture();
  try {
    expect(existsSync(join(f.root, "packages", "connection-transport", "dist", "trust.js"))).toBe(false);
    await f.run("run-expo.mjs", args);
    expect(JSON.parse(await readFile(join(f.root, "expo-call.json"), "utf8"))).toEqual(args);
    const build = JSON.parse(await readFile(join(f.root, "build-call.json"), "utf8")) as string[];
    expect(build).toContain("@joko/connection-transport...");
    expect(build).toContain("@joko/remote-desktop-sync");
    expect(build.some(value => /orchestrator|cloudflare|helper|mobile\.\.\./u.test(value))).toBe(false);
    expect(existsSync(join(f.root, 'linkspan-runtime-call.json'))).toBe(true);
    if (args[0] === 'run:android' || args[0] === 'run:ios') expect(JSON.parse(await readFile(join(f.root, 'linkspan-native-call.json'), 'utf8')).platform).toBe(args[0] === 'run:android' ? 'android' : 'ios');
    else expect(existsSync(join(f.root, 'linkspan-native-call.json'))).toBe(false);
  } finally { await f.close(); }
});

it("does not launch Expo after workspace preparation failed", async () => {
  const f = await fixture();
  try {
    await expect(f.run("run-expo.mjs", ["export", "--platform", "android"], true)).rejects.toThrow(/preparation failed/u);
    expect(existsSync(join(f.root, "expo-call.json"))).toBe(false);
    expect(existsSync(join(f.root, 'linkspan-native-call.json'))).toBe(false);
  } finally { await f.close(); }
});

it.each(["build-android-artifacts.mjs", "build-ios-artifact.mjs"])("keeps %s dry runs free of workspace builds", async builder => {
  const f = await fixture();
  try {
    const output = await f.run(builder, []);
    expect(output.stdout).toContain("dry-run");
    expect(existsSync(join(f.root, "build-call.json"))).toBe(false);
  } finally { await f.close(); }
});
