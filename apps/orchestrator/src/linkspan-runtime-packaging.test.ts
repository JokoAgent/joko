import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

it("records the nested SDK directory and selected Node runtime, and removes both when deselected", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-pinggy-packaging-"));
  try {
    const scripts = join(root, "apps", "orchestrator", "scripts"); await mkdir(scripts, { recursive: true });
    const script = join(scripts, "prepare-linkspan-runtimes.mjs");
    await copyFile(fileURLToPath(new URL("../scripts/prepare-linkspan-runtimes.mjs", import.meta.url)), script);
    await mkdir(join(root, ".runtime", "linkspan-packages"), { recursive: true });
    await writeFile(join(root, ".runtime", "linkspan-packages", "manifest.json"), JSON.stringify({ sourceCommit: "selected-test-source" }));
    // This offline fixture preserves the supplier's real nested return shape.
    // Only the declared root export exists, so unsupported /prepare imports fail.
    const sdk = join(root, "node_modules", "@jokoagent", "linkspan-pinggy"); await mkdir(sdk, { recursive: true });
    await writeFile(join(sdk, "package.json"), JSON.stringify({ type: "module", exports: { ".": "./index.js" } }));
    await writeFile(join(sdk, "index.js"), `
import {mkdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';
export async function preparePinggySdk({directory,target,nodeAbi}) {
  if(nodeAbi!=='137')throw new Error('Explicit SDK ABI required');
  const sdkDirectory=join(directory,'pinggy-0.5.3',target,'node-'+nodeAbi);
  await mkdir(join(sdkDirectory,'dist'),{recursive:true});await writeFile(join(sdkDirectory,'dist/index.js'),'export const Pinggy = {};');
  return {sdkDirectory,target,nodeAbi,version:'0.5.3'};
}
`);
    await writeFile(join(scripts, "prepare-linkspan-pinggy-node.mjs"), `
import {mkdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';
export const PINGGY_NODE_VERSION='24.16.0',PINGGY_NODE_ABI='137';
export async function preparePinggyNodeRuntime({directory,target}) {
 const parent=join(directory,'node-v24.16.0',target);await mkdir(parent,{recursive:true});
 const executable=join(parent,target.startsWith('win32-')?'node.exe':'node');await writeFile(executable,'fixed-node');await writeFile(join(parent,'LICENSE'),'fixed-license');
 return {executable,target,version:PINGGY_NODE_VERSION,nodeAbi:PINGGY_NODE_ABI,sha256:'1'.repeat(64),archiveSha256:'2'.repeat(64)};
}
`);
    // Cross-target prep is deliberately not executed on this host. The real
    // native target's ABI/import check is covered by the selected artifact gate.
    const target = process.platform === "linux" ? "win32-x64" : "linux-x64";
    const run = (backends: string) => execute(process.execPath, [script], { cwd: root, windowsHide: true,
      env: { ...process.env, JOKO_LINKSPAN_BUILD_BACKENDS: backends, JOKO_LINKSPAN_BUILD_TARGET: target } });
    await run("pinggy-sdk");
    const output = join(dirname(scripts), "dist", "linkspan-runtime");
    const selected = JSON.parse(await readFile(join(output, "selected.json"), "utf8"));
    expect(selected).toEqual({ target, sourceCommit: "selected-test-source", backends: ["pinggy-sdk"], helpers: {}, prepared: { pinggy: {
      sdkDirectory: `pinggy/pinggy-0.5.3/${target}/node-137`, target, nodeAbi: "137", version: "0.5.3",
      nodeRuntime: { executable: `pinggy/node-v24.16.0/${target}/${target.startsWith("win32-") ? "node.exe" : "node"}`,
        target, nodeAbi: "137", version: "24.16.0", sha256: "1".repeat(64), archiveSha256: "2".repeat(64) }
    } } });
    expect(await readFile(join(output, selected.prepared.pinggy.sdkDirectory, "dist", "index.js"), "utf8")).toContain("Pinggy");
    expect(await readdir(dirname(join(output, selected.prepared.pinggy.nodeRuntime.executable)))).toEqual(["LICENSE", target.startsWith("win32-") ? "node.exe" : "node"]);
    await run("");
    expect(await readdir(output)).toEqual(["selected.json"]);
    expect(JSON.parse(await readFile(join(output, "selected.json"), "utf8"))).toMatchObject({ backends: [], prepared: {}, helpers: {} });
  } finally { await rm(root, { recursive: true, force: true }); }
});
