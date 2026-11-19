import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_CODEX_RUNTIME_ASSETS, LOCAL_CODEX_RUNTIME_VERSION, LocalCodexRuntime } from "./local-codex-runtime.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "joko-native-runtime-"));
  roots.push(root);
  return root;
}
function owner(rootDirectory: string, fetch: typeof globalThis.fetch, extra = {}) {
  return new LocalCodexRuntime({ rootDirectory, backendId: "native-backend", platform: "win32", architecture: "x64",
    fetch, currentGeneration: () => 7, adopt: vi.fn(), ...extra });
}

describe("local complete runtime provisioning", () => {
  it("preserves a manual executable and rejects foreign platform setup before downloading", async () => {
    const download = vi.fn();
    const runtime = owner(await directory(), download as typeof fetch, { manualExecutable: "D:\\manual\\codex.exe", platform: "freebsd" });
    expect(await runtime.resolveExecutable()).toBe("D:\\manual\\codex.exe");
    expect(await runtime.probe("native-backend")).toMatchObject({ state: "not_supported", canInstall: false });
    expect(() => runtime.install({ requestId: "request", backendId: "native-backend", expectedGeneration: 7, repair: false })).toThrow("unavailable");
    expect(download).not.toHaveBeenCalled();
  });

  it("does not publish a wrong archive and preserves the prior installation receipt", async () => {
    const root = await directory();
    const previous = JSON.stringify({ directory: "previous-owner" });
    await writeFile(join(root, "current.json"), previous);
    const runtime = owner(root, vi.fn(async () => new Response("wrong archive")) as typeof fetch);
    const events = [];
    for await (const event of runtime.install({ requestId: "bad-archive", backendId: "native-backend", expectedGeneration: 7, repair: true })) events.push(event);
    expect(events.at(-1)?.runtime).toMatchObject({ state: "failed", failureCode: "install_failed" });
    expect(await readFile(join(root, "current.json"), "utf8")).toBe(previous);
    expect((await readdir(root)).filter(name => name.startsWith(".stage-"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("keeps the installed identity on a failed probe and after each explicit repair fails", async () => {
    const root = await directory();
    const platform = "linux-x64";
    const asset = LOCAL_CODEX_RUNTIME_ASSETS[platform]!;
    const installedVersion = LOCAL_CODEX_RUNTIME_VERSION;
    const packageName = `${installedVersion}-${platform}-00000000-0000-4000-8000-000000000001`;
    const packageRoot = join(root, packageName);
    for (const path of ["bin", "codex-path", "codex-resources"]) await mkdir(join(packageRoot, path), { recursive: true });
    const files = {
      "bin/codex": `#!/bin/sh\nprintf 'codex-cli ${installedVersion}\\n'\n`,
      "bin/codex-code-mode-host": "host",
      "codex-package.json": JSON.stringify({ layoutVersion: 1, version: installedVersion, target: asset.target,
        variant: "codex", entrypoint: asset.entrypoint, resourcesDir: "codex-resources", pathDir: "codex-path" }),
      "codex-path/rg": "rg"
    };
    for (const [path, content] of Object.entries(files)) await writeFile(join(packageRoot, path), content, { mode: 0o644 });
    await writeFile(join(packageRoot, ".joko-package.json"), JSON.stringify(Object.entries(files).map(([path, content]) => ({
      path, size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex")
    }))));
    const receipt = JSON.stringify({ version: installedVersion, platform, archiveSha256: asset.sha256, directory: packageName });
    await writeFile(join(root, "current.json"), receipt);

    const download = vi.fn(async () => new Response("wrong archive"));
    const adopt = vi.fn();
    const runtime = owner(root, download, { platform: "linux", adopt });
    await expect(runtime.probe("native-backend")).resolves.toMatchObject({ state: "failed", failureCode: "probe_failed", installedVersion });
    await chmod(join(packageRoot, asset.entrypoint), 0o755);
    let latest = await runtime.probe("native-backend");
    expect(latest).toMatchObject({ state: "ready", installedVersion });

    for (const requestId of ["repair", "retry"]) {
      const events = [];
      for await (const event of runtime.install({ requestId, backendId: "native-backend", expectedGeneration: 7,
        repair: latest.installedVersion !== undefined })) events.push(event);
      latest = events.at(-1)!.runtime;
      expect(latest).toMatchObject({ state: "failed", failureCode: "install_failed", installedVersion });
    }
    expect(download).toHaveBeenCalledTimes(2);
    expect(adopt).not.toHaveBeenCalled();
    expect(await readFile(join(root, "current.json"), "utf8")).toBe(receipt);
  });

  it("keeps service installation alive when an observer leaves, while explicit cancellation stops its exact request", async () => {
    const root = await directory();
    let entered!: () => void;
    const downloading = new Promise<void>(resolve => { entered = resolve; });
    const download = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      entered();
      init!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    })) as unknown as typeof fetch;
    const runtime = owner(root, download);
    const input = { requestId: "exact-request", backendId: "native-backend", expectedGeneration: 7, repair: true };
    const observer = new AbortController();
    const iterator = runtime.install(input, observer.signal)[Symbol.asyncIterator]();
    await iterator.next();
    await downloading;
    observer.abort();
    await expect(iterator.next()).rejects.toThrow();
    expect((await runtime.probe("native-backend")).state).toBe("downloading");
    expect(runtime.cancel("native-backend", "another-request")).toBe(false);
    expect(runtime.cancel("native-backend", input.requestId)).toBe(true);
    const replay = [];
    for await (const event of runtime.install(input)) replay.push(event);
    expect(replay.at(-1)?.runtime.state).toBe("cancelled");
    expect(download).toHaveBeenCalledTimes(1);
    expect(() => runtime.install({ ...input, repair: false })).toThrow("reused");
    await runtime.close();
  });
});
