import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type { ChildProcess, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LlamaCppRuntimeManager } from "./llama-cpp-manager.js";
import { startLlamaCppOwnerProof } from "./llama-cpp-process.js";
import type { LlamaCppRuntimeOptions, LlamaCppSelection } from "./llama-cpp-types.js";
import { llamaCppModelId } from "./llama-cpp-validation.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const owner = { ownerId: "provider", generation: 1 }, selection: LlamaCppSelection = { repository: "a/model", file: "weights.gguf" };
const roots: string[] = [], managers: LlamaCppRuntimeManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) { try { await manager.dispose(owner); } catch {} } await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
class Child extends EventEmitter {
  pid = 777777; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null;
  kill() { this.exit(); return true; }
  exit() { this.exitCode = 0; this.emit("exit", 0, null); }
}
async function fixture(overrides: Partial<LlamaCppRuntimeOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "joko-gguf-manager-")); roots.push(root); const child = new Child();
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const target = String(url);
    if (target.includes("api.github.com")) return Response.json([{ tag_name: "b7000", assets: [{ name: "llama-b7000-bin-win-cpu-x64.zip", browser_download_url: "https://github.com/ggml-org/llama.cpp/releases/download/b7000/llama-b7000-bin-win-cpu-x64.zip", digest: "sha256:" + digest("archive"), size: 7 }] }]);
    if (target.includes("/api/models/")) return Response.json({ sha: "a".repeat(40), siblings: [{ rfilename: selection.file, lfs: { size: 8, sha256: digest("abcdefgh") } }] });
    return new Response(target.includes("github.com") ? "archive" : "abcdefgh");
  });
  const spawnProcess = vi.fn(() => child as unknown as ChildProcess) as unknown as typeof spawn;
  const changed = vi.fn(async () => undefined), validate = vi.fn(async () => undefined);
  const options: LlamaCppRuntimeOptions = { dataRoot: root, currentOwner: () => owner, fetchStreaming: fetcher, platform: "win32", arch: "x64", validateConnection: validate, onModelsChanged: changed,
    freeDiskBytes: async () => 1e12, extractArchive: async ({ destination }) => { await mkdir(destination); const file = join(destination, "llama-server.exe"); await writeFile(file, "binary"); return file; },
    spawnProcess, healthFetch: vi.fn(async () => new Response("healthy")), terminateTree: async () => { child.exit(); return true; }, stopTimeoutMs: 30, ...overrides };
  const manager = new LlamaCppRuntimeManager(options); managers.push(manager); return { manager, root, child, fetcher, changed, validate, spawnProcess, options };
}
async function pendingOperation(manager: LlamaCppRuntimeManager) { let value = await manager.snapshot(owner); for (let i = 0; !value.operation && i < 100; i++) { await new Promise(done => setTimeout(done, 2)); value = await manager.snapshot(owner); } expect(value.operation).toBeDefined(); return value.operation!; }

describe("managed GGUF owner", () => {
  it("returns complete immutable shard metadata and publishes only after every shard verifies", async () => {
    const files = ["Q4-00001-of-00002.gguf", "Q4-00002-of-00002.gguf"], queried = deferred<void>(); let corrupt = true;
    const value = await fixture({ fetchStreaming: async url => {
      if (String(url).includes("/api/models/")) { queried.resolve(); return Response.json({ sha: "b".repeat(40), siblings: files.map((name, index) => ({ rfilename: name, lfs: { size: 4, sha256: digest(index === 0 ? "abcd" : "efgh") } })) }); }
      expect(String(url)).toContain("/resolve/" + "b".repeat(40) + "/"); return new Response(String(url).endsWith(files[0]!) ? "abcd" : corrupt ? "xxxx" : "efgh");
    } });
    const repository = await value.manager.listRepositoryFiles(owner, selection.repository); expect(repository.files.map(file => file.sizeBytes)).toEqual([4, 4]);
    const target = { ...selection, file: files[0]! }; await expect(value.manager.download(owner, target)).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" }); expect((await value.manager.snapshot(owner)).models).toEqual([]);
    corrupt = false; await value.manager.download(owner, target); const model = (await value.manager.snapshot(owner)).models[0]!; expect(model.sizeBytes).toBe(8); expect(model.shards).toHaveLength(2); expect(await readFile(join(value.root, "llamacpp-runtime", "models", model.id, files[1]!), "utf8")).toBe("efgh");
  });
  it("retires an owner changed during streamed bytes before atomic publication", async () => {
    let active = owner; const started = deferred<void>(), continueBytes = deferred<void>();
    const value = await fixture({ currentOwner: () => active, fetchStreaming: async url => {
      if (String(url).includes("/api/models/")) return Response.json({ sha: "a".repeat(40), siblings: [{ rfilename: selection.file, lfs: { size: 8, sha256: digest("abcdefgh") } }] });
      return new Response(new ReadableStream({ async start(controller) { controller.enqueue(new TextEncoder().encode("abcd")); started.resolve(); await continueBytes.promise; controller.enqueue(new TextEncoder().encode("efgh")); controller.close(); } }));
    } });
    const flight = value.manager.download(owner, selection), observed = flight.catch(error => error); await started.promise;
    await vi.waitFor(async () => expect((await value.manager.snapshot(owner)).operation?.completed).toBe(4)); active = { ...owner, generation: 2 }; continueBytes.resolve(); expect(await observed).toMatchObject({ code: "OWNER_CHANGED" });
    active = owner; expect((await value.manager.snapshot(owner)).models).toEqual([]); expect(value.changed).not.toHaveBeenCalled();
  });
  it("atomically installs without starting and preserves stopped disk inventory across a new engine", async () => {
    const value = await fixture(); await value.manager.install(owner); expect(value.spawnProcess).not.toHaveBeenCalled(); expect(await value.manager.snapshot(owner)).toMatchObject({ installed: true, running: false, models: [] });
    await value.manager.download(owner, selection); const model = (await value.manager.snapshot(owner)).models[0]!;
    expect(model).toMatchObject({ id: llamaCppModelId(selection), ...selection, sizeBytes: 8, revision: "a".repeat(40) });
    const restarted = new LlamaCppRuntimeManager(value.options); managers.push(restarted); expect((await restarted.snapshot(owner)).models).toEqual([model]); expect(value.spawnProcess).not.toHaveBeenCalled();
    expect(value.changed).toHaveBeenCalledTimes(2); await restarted.snapshot(owner); expect(value.changed).toHaveBeenCalledTimes(2);
  });
  it("rejects low disk space before asset transfer and never publishes partial installed models", async () => {
    const value = await fixture({ freeDiskBytes: async () => 5 }); await expect(value.manager.download(owner, selection)).rejects.toMatchObject({ code: "DISK_SPACE_LOW" });
    expect(value.fetcher).toHaveBeenCalledTimes(1); expect((await value.manager.snapshot(owner)).models).toEqual([]);
    await expect(value.manager.install(owner)).rejects.toMatchObject({ code: "DISK_SPACE_LOW" }); expect(value.spawnProcess).not.toHaveBeenCalled();
  });
  it("retains the active paused transfer, resumes a verified prefix, and rejects an old same-selection transfer id", async () => {
    const firstChunk = deferred<void>(); let attempt = 0, firstSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/api/models/")) return Response.json({ sha: "a".repeat(40), siblings: [{ rfilename: selection.file, lfs: { size: 8, sha256: digest("abcdefgh") } }] });
      attempt++;
      if (attempt === 1) return new Response(new ReadableStream({ start(controller) { firstSignal = init?.signal; controller.enqueue(new TextEncoder().encode("abcd")); firstChunk.resolve(); init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true }); } }));
      expect(init?.headers).toEqual({ Range: "bytes=4-" }); return new Response("efgh", { status: 206, headers: { "content-range": "bytes 4-7/8" } });
    });
    const value = await fixture({ fetchStreaming: fetcher }); const flight = value.manager.download(owner, selection); const observed = flight.catch(error => error); await firstChunk.promise;
    await vi.waitFor(async () => expect((await value.manager.snapshot(owner)).operation?.completed).toBe(4));
    const operation = await pendingOperation(value.manager), target = { transferId: operation.transferId, selection };
    await value.manager.pause(owner, target); expect(firstSignal?.aborted).toBe(true); expect((await value.manager.snapshot(owner)).operation).toMatchObject({ paused: true, transferId: target.transferId });
    await expect(value.manager.cancel(owner, { ...target, transferId: "retired" })).rejects.toMatchObject({ reason: "TRANSFER_CHANGED" });
    await value.manager.resume(owner, target); await flight; expect(await observed).toBeUndefined(); expect((await value.manager.snapshot(owner)).models).toHaveLength(1); expect(attempt).toBe(2);
    await expect(value.manager.cancel(owner, target)).rejects.toMatchObject({ reason: "TRANSFER_CHANGED" });
  });
  it("serializes separate engines through the live filesystem lock and cancellation removes only private staging", async () => {
    const started = deferred<void>(); const base = await fixture(); const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/api/models/")) return base.fetcher(url);
      return new Response(new ReadableStream({ start(controller) { started.resolve(); init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true }); } }));
    });
    const first = new LlamaCppRuntimeManager({ ...base.options, fetchStreaming: fetcher }), second = new LlamaCppRuntimeManager(base.options); managers.push(first, second);
    const flight = first.download(owner, selection); const rejected = flight.catch(error => error); await started.promise;
    await expect(second.configure(owner, async () => true)).rejects.toMatchObject({ reason: "BUSY" });
    const operation = await pendingOperation(first); await first.cancel(owner, { transferId: operation.transferId, selection }); expect(await rejected).toMatchObject({ code: "OPERATION_CANCELLED" });
    expect(await readdir(join(base.root, "llamacpp-runtime", "models"))).toEqual([]); await second.download(owner, selection); expect((await second.snapshot(owner)).models).toHaveLength(1);
  });
  it("rejects late retired owner metadata without publication and leaves read failures as failures", async () => {
    let active = owner; const response = deferred<Response>(), value = await fixture({ currentOwner: () => active, fetchStreaming: async () => response.promise });
    const query = value.manager.listRepositoryFiles(owner, selection.repository); active = { ...owner, generation: 2 }; response.resolve(Response.json({ sha: "a".repeat(40), siblings: [] })); await expect(query).rejects.toMatchObject({ code: "OWNER_CHANGED" });
    active = owner; await mkdir(join(value.root, "llamacpp-runtime", "models"), { recursive: true }); await rm(join(value.root, "llamacpp-runtime", "models"), { recursive: true }); await writeFile(join(value.root, "llamacpp-runtime", "models"), "not a directory");
    await expect(value.manager.snapshot(owner)).rejects.toMatchObject({ code: "ENOTDIR" });
  });
  it("borrows a proven healthy router only for inference and preserves unknown ownership", async () => {
    const value = await fixture(), proof = await startLlamaCppOwnerProof(); await mkdir(join(value.root, "llamacpp-runtime"));
    try {
      const file = join(value.root, "llamacpp-runtime", "server-owner.json"); await writeFile(file, JSON.stringify({ format: 1, identity: proof.identity, preset: "saved" }));
      expect(await value.manager.snapshot(owner)).toMatchObject({ running: true, canManageRuntime: false, canConfigure: false, blockedReason: "owned_elsewhere" });
      await value.manager.start(owner); expect(value.spawnProcess).not.toHaveBeenCalled(); await expect(value.manager.configure(owner, async () => true)).rejects.toMatchObject({ reason: "OWNED_ELSEWHERE" }); await expect(value.manager.stop(owner)).rejects.toMatchObject({ reason: "OWNED_ELSEWHERE" });
      await writeFile(file, JSON.stringify({ format: 1, identity: { token: "invalid" }, preset: "saved" })); expect(await value.manager.snapshot(owner)).toMatchObject({ canConfigure: false, blockedReason: "ownership_unknown" }); await expect(value.manager.install(owner)).rejects.toMatchObject({ reason: "OWNER_UNKNOWN" });
    } finally { await proof.close(); }
  });
  it("waits for both Windows actual child exit and late tree confirmation after a timeout before delete", async () => {
    const tree = deferred<boolean>(), treeStarted = deferred<void>(); const value = await fixture({ terminateTree: async () => { treeStarted.resolve(); return tree.promise; } }); await value.manager.install(owner); await value.manager.start(owner);
    const stop = value.manager.stop(owner); const observed = stop.catch(error => error); await treeStarted.promise; value.child.exit(); expect(await observed).toMatchObject({ reason: "STOP_TIMEOUT" });
    expect(await value.manager.snapshot(owner)).toMatchObject({ running: false, canManageRuntime: true, canConfigure: false, blockedReason: "stop_unconfirmed" }); const deleteConnection = vi.fn(async () => "deleted");
    await expect(value.manager.remove(owner, deleteConnection)).rejects.toMatchObject({ reason: "STOP_TIMEOUT" }); expect(deleteConnection).not.toHaveBeenCalled();
    tree.resolve(true); await vi.waitFor(async () => expect((await value.manager.snapshot(owner)).blockedReason).toBeUndefined());
    expect(await value.manager.remove(owner, deleteConnection)).toBe("deleted"); expect(deleteConnection).toHaveBeenCalledTimes(1); expect(await readFile(join(value.root, "llamacpp-runtime", "current.json"), "utf8")).toContain("b7000");
  });
  it("keeps current presets until explicit restart and performs configuration inside the shared lock", async () => {
    let budget = 300000; const child2 = new Child(); const value = await fixture({ contextLimits: () => [budget], terminateTree: async child => { (child as unknown as Child).exit(); return true; } }); await value.manager.install(owner); await value.manager.download(owner, { ...selection, repository: "bartowski/Qwen3.8-Flash-Next-GGUF" }); await value.manager.start(owner);
    const firstPreset = await readFile(join(value.root, "llamacpp-runtime", "models.ini"), "utf8"); expect(firstPreset).toContain("ctx-size = 300000"); expect(firstPreset).toContain("rope-scaling = yarn"); budget = 500000; await value.manager.configure(owner, async () => { expect((await value.manager.snapshot(owner)).canConfigure).toBe(true); return undefined; });
    await value.manager.start(owner); expect(await readFile(join(value.root, "llamacpp-runtime", "models.ini"), "utf8")).toBe(firstPreset); expect(value.spawnProcess).toHaveBeenCalledTimes(1);
    vi.mocked(value.spawnProcess).mockImplementation(() => child2 as unknown as ChildProcess); await value.manager.start(owner, { restart: true });
    expect(value.spawnProcess).toHaveBeenCalledTimes(2); expect(await readFile(join(value.root, "llamacpp-runtime", "models.ini"), "utf8")).toContain("ctx-size = 500000");
  });
});
