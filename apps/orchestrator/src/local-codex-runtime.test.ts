import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalCodexRuntime } from "./local-codex-runtime.js";

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
