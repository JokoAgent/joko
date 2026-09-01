import { describe, expect, it, vi } from "vitest";

import type { CancelledPullArtifactCleaner } from "./artifact-cleaner.js";
import { LocalRuntimeError } from "./errors.js";
import { LocalModelRuntimeManager } from "./manager.js";
import { MemoryPausedPullRepository } from "./paused-pulls.js";
import type { OllamaModelDetails, OllamaPullEvent, OllamaTag, RuntimeOwnerGeneration } from "./types.js";

class FakeClient {
  readonly pulls = new Map<string, {
    readonly emit: (event: OllamaPullEvent) => void;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  }>();
  readonly deleted: string[] = [];
  installed: OllamaTag[] = [];
  details = new Map<string, OllamaModelDetails>();

  async tags(): Promise<readonly OllamaTag[]> {
    return this.installed;
  }

  async show(name: string): Promise<OllamaModelDetails> {
    return this.details.get(name) ?? { capabilities: [] };
  }

  async delete(name: string): Promise<void> {
    this.deleted.push(name);
    this.installed = this.installed.filter((model) => model.name !== name);
  }

  pull(name: string, emit: (event: OllamaPullEvent) => void, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pulls.set(name, { emit, resolve, reject });
      const abort = () => reject(new LocalRuntimeError("OPERATION_CANCELLED", "cancelled"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  complete(name: string, digest = `sha256:${"ab".repeat(32)}`): void {
    const pull = this.pulls.get(name);
    if (pull === undefined) throw new Error("pull not active");
    pull.emit({ status: "downloading", digest, completed: 5, total: 10 });
    pull.emit({ status: "success", completed: 10, total: 10 });
    this.installed.push({ name });
    pull.resolve();
    this.pulls.delete(name);
  }
}

function readyLauncher() {
  return {
    status: async () => ({
      runtime: "ollama" as const,
      state: "ready" as const,
      source: "running" as const,
      version: "0.14.2",
      capabilities: {
        canInstall: true,
        canStart: true,
        canListModels: true,
        canPullModels: true,
        canDeleteModels: true,
        canPausePulls: true
      }
    }),
    start: async () => ({
      runtime: "ollama" as const,
      state: "ready" as const,
      source: "managed_sidecar" as const,
      version: "0.14.2",
      capabilities: {
        canInstall: true,
        canStart: true,
        canListModels: true,
        canPullModels: true,
        canDeleteModels: true,
        canPausePulls: true
      }
    })
  };
}

function fixture(overrides: Partial<ConstructorParameters<typeof LocalModelRuntimeManager>[0]> = {}) {
  const owner: RuntimeOwnerGeneration = { ownerId: "owner-a", generation: 1 };
  let activeOwner: RuntimeOwnerGeneration = owner;
  const client = new FakeClient();
  const pausedPulls = new MemoryPausedPullRepository();
  const sync = vi.fn(async () => undefined);
  const audit = vi.fn();
  const manager = new LocalModelRuntimeManager({
    client,
    launcher: readyLauncher(),
    dataRoot: "unused",
    currentOwner: () => activeOwner,
    pausedPulls,
    onModelsChanged: sync,
    audit,
    now: (() => {
      let time = 0;
      return () => time += 1_001;
    })(),
    ...overrides
  });
  return { owner, client, pausedPulls, sync, audit, manager, setOwner: (next: RuntimeOwnerGeneration) => { activeOwner = next; } };
}

describe("LocalModelRuntimeManager", () => {
  it("joins the same model and pulls different models in parallel", async () => {
    const { owner, client, manager } = fixture();
    const first = manager.pull(owner, "model-a");
    const joined = manager.pull(owner, "model-a:latest");
    const second = manager.pull(owner, "model-b");
    expect(first).toBe(joined);
    await vi.waitFor(() => expect(client.pulls.size).toBe(2));
    expect(manager.activePulls(owner).map((pull) => pull.name).sort()).toEqual(["model-a", "model-b"]);
    client.complete("model-a");
    client.complete("model-b");
    await expect(Promise.all([first, joined, second])).resolves.toEqual([undefined, undefined, undefined]);
  });

  it("persists pause metadata and resumes without losing progress ownership", async () => {
    const { owner, client, manager } = fixture();
    const pulling = manager.pull(owner, "model-a");
    await vi.waitFor(() => expect(client.pulls.has("model-a")).toBe(true));
    client.pulls.get("model-a")!.emit({ status: "downloading", digest: `sha256:${"cd".repeat(32)}`, completed: 4, total: 10 });
    await manager.pause(owner, "model-a");
    await expect(pulling).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
    await expect(manager.paused(owner)).resolves.toEqual([expect.objectContaining({ name: "model-a", phase: "paused", completedBytes: 4, totalBytes: 10 })]);

    const resumed = manager.resume(owner, "model-a");
    await vi.waitFor(() => expect(client.pulls.has("model-a")).toBe(true));
    client.complete("model-a");
    await expect(resumed).resolves.toBeUndefined();
    await expect(manager.paused(owner)).resolves.toEqual([]);
  });

  it("cancels a partial, deletes only an uninstalled model and preserves digests used elsewhere", async () => {
    const cleaner: CancelledPullArtifactCleaner = { cleanup: vi.fn(async () => undefined) };
    const { owner, client, manager } = fixture({ artifactCleaner: cleaner });
    const first = manager.pull(owner, "model-a");
    const second = manager.pull(owner, "model-b");
    await vi.waitFor(() => expect(client.pulls.size).toBe(2));
    const shared = `sha256:${"ef".repeat(32)}`;
    client.pulls.get("model-a")!.emit({ status: "downloading", digest: shared, completed: 1, total: 10 });
    client.pulls.get("model-b")!.emit({ status: "downloading", digest: shared, completed: 1, total: 10 });
    await manager.cancel(owner, "model-a");
    await expect(first).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
    expect(client.deleted).toContain("model-a");
    expect(cleaner.cleanup).toHaveBeenCalledWith({ digests: [shared], keepDigests: new Set([shared]) });
    await manager.cancel(owner, "model-b");
    await second.catch(() => undefined);
  });

  it("reports busy instead of deleting an in-flight model", async () => {
    const { owner, client, manager } = fixture();
    const pulling = manager.pull(owner, "model-a");
    await vi.waitFor(() => expect(client.pulls.has("model-a")).toBe(true));
    await expect(manager.delete(owner, "model-a:latest")).rejects.toMatchObject({ code: "PULL_BUSY" });
    await manager.cancel(owner, "model-a");
    await pulling.catch(() => undefined);
  });

  it("automatically synchronizes exact installed models after pull and deletion", async () => {
    const { owner, client, manager, sync } = fixture();
    client.details.set("model-a", { contextLength: 32768, capabilities: ["tools"] });
    const pulling = manager.pull(owner, "model-a");
    await vi.waitFor(() => expect(client.pulls.has("model-a")).toBe(true));
    client.complete("model-a");
    await pulling;
    expect(sync).toHaveBeenLastCalledWith(owner, [{ id: "model-a", displayName: "model-a", contextWindow: 32768, supportsTools: true, supportsImages: false }]);
    await manager.delete(owner, "model-a");
    expect(sync).toHaveBeenLastCalledWith(owner, []);
  });

  it("aborts and rejects stale owner generations before model sync", async () => {
    const { owner, client, manager, sync, setOwner } = fixture();
    const pulling = manager.pull(owner, "model-a");
    await vi.waitFor(() => expect(client.pulls.has("model-a")).toBe(true));
    setOwner({ ownerId: "owner-a", generation: 2 });
    client.pulls.get("model-a")!.emit({ status: "downloading", completed: 1, total: 10 });
    await expect(pulling).rejects.toMatchObject({ code: "OWNER_CHANGED" });
    expect(sync).not.toHaveBeenCalled();
  });

  it("single-flights installation and starts the promoted sidecar once", async () => {
    let finishInstall: (() => void) | undefined;
    const installer = vi.fn(() => new Promise<{ version: string; binary: string; archiveSha256: string }>((resolve) => {
      finishInstall = () => resolve({ version: "0.14.2", binary: "managed", archiveSha256: "ab".repeat(32) });
    }));
    const launcher = readyLauncher();
    const start = vi.spyOn(launcher, "start");
    const { owner, manager } = fixture({ installer, launcher });
    const first = manager.install(owner);
    const joined = manager.install(owner);
    expect(installer).toHaveBeenCalledOnce();
    finishInstall!();
    await expect(Promise.all([first, joined])).resolves.toHaveLength(2);
    expect(start).toHaveBeenCalledOnce();
  });

  it("claims and completes the durable installation lease with verified metadata", async () => {
    const leases = {
      claim: vi.fn(async () => ({ claimed: true, recovered: false, state: "installing" as const })),
      heartbeat: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined)
    };
    const installer = vi.fn(async (input: Parameters<NonNullable<ConstructorParameters<typeof LocalModelRuntimeManager>[0]["installer"]>>[0]) => {
      input.onProgress?.({ phase: "downloading", done: false, completedBytes: 1, totalBytes: 2 });
      return { version: "0.14.2", binary: "managed", archiveSha256: "ab".repeat(32) };
    });
    const { owner, manager } = fixture({ installer, installLeases: leases });
    await manager.install(owner);
    expect(leases.claim).toHaveBeenCalledWith(expect.objectContaining({ owner, leaseDurationMs: 30_000 }));
    expect(leases.complete).toHaveBeenCalledWith(expect.objectContaining({
      owner,
      version: "0.14.2",
      archiveSha256: "ab".repeat(32)
    }));
    expect(leases.fail).not.toHaveBeenCalled();
  });

  it("durably terminates a failed installation lease with a public code", async () => {
    const leases = {
      claim: vi.fn(async () => ({ claimed: true, recovered: false, state: "installing" as const })),
      heartbeat: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined)
    };
    const installer = vi.fn(async () => {
      throw new LocalRuntimeError("CHECKSUM_MISMATCH", "checksum failed");
    });
    const { owner, manager } = fixture({ installer, installLeases: leases });
    await expect(manager.install(owner)).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
    expect(leases.fail).toHaveBeenCalledWith(expect.objectContaining({
      owner,
      state: "failed",
      publicErrorCode: "CHECKSUM_MISMATCH"
    }));
    expect(leases.complete).not.toHaveBeenCalled();
  });

  it("reports host-aware model preflight and retains safe installation progress", async () => {
    const installer = vi.fn(async (input: Parameters<NonNullable<ConstructorParameters<typeof LocalModelRuntimeManager>[0]["installer"]>>[0]) => {
      input.onProgress?.({ phase: "downloading", done: false, completedBytes: 1, totalBytes: 2, percent: 50 });
      return { version: "0.14.2", binary: "managed", archiveSha256: "ab".repeat(32) };
    });
    const { owner, manager } = fixture({ installer, platform: "linux", arch: "x64", totalMemory: () => 8 * 1024 ** 3 });
    const catalogId = manager.curated(owner).catalog[0]!.id;
    expect(manager.modelPreflight(owner, catalogId, 1)).toMatchObject({
      allowed: false,
      disk: "insufficient",
      publicErrorCode: "DISK_SPACE_LOW"
    });
    await manager.install(owner);
    expect(manager.installProgress(owner)).toMatchObject({ phase: "success", percent: 100, done: true });
  });

  it("pauses every in-flight model before owner shutdown", async () => {
    const { owner, client, manager } = fixture();
    const first = manager.pull(owner, "model-a");
    const second = manager.pull(owner, "model-b");
    await vi.waitFor(() => expect(client.pulls.size).toBe(2));
    client.pulls.get("model-a")!.emit({ status: "downloading", completed: 1, total: 10 });
    client.pulls.get("model-b")!.emit({ status: "downloading", completed: 2, total: 10 });
    await manager.shutdown(owner);
    await Promise.allSettled([first, second]);
    await expect(manager.paused(owner)).resolves.toEqual([
      expect.objectContaining({ name: "model-a", phase: "paused" }),
      expect.objectContaining({ name: "model-b", phase: "paused" })
    ]);
  });
});
