import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const source = fileURLToPath(new URL("../scripts/prepare-linkspan-helper.mjs", import.meta.url));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-helper-packaging-"));
  const packages = join(root, ".runtime", "linkspan-packages");
  await mkdir(packages, { recursive: true });
  await writeFile(join(packages, "manifest.json"), JSON.stringify({ sourceCommit: "selected-source", packages: [] }));
  const hostedScript = join(root, "apps", "orchestrator", "scripts", "prepare-linkspan-helper.mjs");
  await mkdir(dirname(hostedScript), { recursive: true });
  await copyFile(source, hostedScript);
  const stub = join(root, "node_modules", "@jokoagent", "linkspan-cloudflare");
  await mkdir(stub, { recursive: true });
  await writeFile(join(stub, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
  // The package fixture produces only explicitly requested local target files;
  // no download, helper execution or supplier account is part of this check.
  await writeFile(join(stub, "index.js"), `
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export function cloudflaredArtifact(target) {
  if (!['win32-x64', 'linux-x64'].includes(target)) throw Object.assign(new Error('missing'), { code: 'unsupported_platform' });
  return { target, version: '2026.10.3-linkspan.1', binaryBytes: 17, binarySha256: 'fixture-target-digest' };
}
export async function prepareCloudflared({ directory, target }) {
  const artifact = cloudflaredArtifact(target);
  const destination = join(directory, artifact.version, target);
  await mkdir(destination, { recursive: true });
  const executable = join(destination, target.startsWith('win32-') ? 'cloudflared.exe' : 'cloudflared');
  await writeFile(executable, 'prepared:' + target);
  for (const material of ['LICENSE.cloudflared', 'UPSTREAM.md', 'THIRD_PARTY_NOTICES.cloudflared.md', 'cloudflared.build-inputs.json', 'cloudflared.source.json', 'cloudflared-restricted.patch', 'restricted-helper.build.json']) await writeFile(join(destination, material), material);
  return { target, executable };
}
`);
  const output = join(root, "apps", "orchestrator", "dist", "linkspan-helper");
  return { root, output, run: (target: string, backends = "cloudflare") => execute(process.execPath, [hostedScript], {
    cwd: root, env: { ...process.env, JOKO_LINKSPAN_BUILD_TARGET: target, JOKO_LINKSPAN_BUILD_BACKENDS: backends }, windowsHide: true
  }), close: () => rm(root, { recursive: true, force: true }) };
}

it("ships only the newly selected helper target when reusing an existing build output", async () => {
  const f = await fixture();
  try {
    await f.run("win32-x64");
    await mkdir(join(f.output, "old-version", "darwin-arm64"), { recursive: true });
    await writeFile(join(f.output, "2026.10.3-linkspan.1", "win32-x64", "unrelated.wasm"), "leftover");
    await f.run("linux-x64");
    expect((await readdir(f.output)).sort()).toEqual(["2026.10.3-linkspan.1", "manifest.json"]);
    expect(await readdir(join(f.output, "2026.10.3-linkspan.1"))).toEqual(["linux-x64"]);
    expect(JSON.parse(await readFile(join(f.output, "manifest.json"), "utf8"))).toMatchObject({
      target: "linux-x64", supported: true, executable: "2026.10.3-linkspan.1/linux-x64/cloudflared"
    });
    expect(JSON.parse(await readFile(join(dirname(f.output), "linkspan-packages.json"), "utf8"))).toEqual({ sourceCommit: "selected-source", packages: [] });
    const current = join(f.output, "2026.10.3-linkspan.1", "linux-x64");
    await writeFile(join(current, "stale-other-cpu"), "leftover");
    await f.run("linux-x64");
    expect((await readdir(current)).sort()).toEqual([
      "LICENSE.cloudflared", "THIRD_PARTY_NOTICES.cloudflared.md", "UPSTREAM.md", "cloudflared",
      "cloudflared.build-inputs.json", "cloudflared.source.json", "cloudflared-restricted.patch", "restricted-helper.build.json"
    ].sort());
    await f.run("win32-ia32");
    expect(await readdir(f.output)).toEqual(["manifest.json"]);
    expect(JSON.parse(await readFile(join(f.output, "manifest.json"), "utf8"))).toEqual({
      target: "win32-ia32", supported: false, reason: "unsupported_target"
    });
  } finally { await f.close(); }
});

it("rejects a linked output before touching unrelated files", async () => {
  const f = await fixture();
  try {
    const unrelated = join(f.root, "host-files");
    await mkdir(unrelated);
    await writeFile(join(unrelated, "keep.txt"), "host-owned-content");
    await mkdir(dirname(f.output), { recursive: true });
    await symlink(unrelated, f.output, process.platform === "win32" ? "junction" : "dir");
    await expect(f.run("linux-x64")).rejects.toThrow();
    expect(await readFile(join(unrelated, "keep.txt"), "utf8")).toBe("host-owned-content");
    expect(await readdir(unrelated)).toEqual(["keep.txt"]);
  } finally { await f.close(); }
});

it("excludes a previously built Cloudflare helper when another backend alone is selected", async () => {
  const f = await fixture();
  try {
    await f.run("linux-x64");
    await f.run("linux-x64", "iroh");
    expect(await readdir(f.output)).toEqual(["manifest.json"]);
    expect(JSON.parse(await readFile(join(f.output, "manifest.json"), "utf8"))).toEqual({ target: "linux-x64", supported: false, reason: "not_selected" });
  } finally { await f.close(); }
});
