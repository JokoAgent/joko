import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRuntimeError, LlamaCppRuntimeManager, type LlamaCppSnapshot, type LlamaCppModel } from "@joko/local-model-runtime";
import { describe, expect, it, vi } from "vitest";
import { ManagedGgufRuntimeController, type ManagedGgufEnginePort } from "./managed-gguf-runtime-controller.js";
import type { ManagedRuntimeModelContext, ManagedRuntimeModelTarget } from "./managed-model-runtime-port.js";

const owner = { ownerId: "node-owner", generation: 7 };
const selection = { repository: "Owner/Model-GGUF", file: "Model-Q4.gguf" };
const model: LlamaCppModel = { ...selection, id: "model-exact", sizeBytes: 512, revision: "a".repeat(40),
  shards: [{ name: selection.file, sizeBytes: 512, sha256: "b".repeat(64) }] };
const target: ManagedRuntimeModelTarget = { backendId: "backend-a", providerId: "managed-provider", modelId: model.id, repositoryModel: selection };
function fixture() {
  const state: { current: typeof owner | undefined; snapshot: LlamaCppSnapshot } = { current: owner, snapshot: {
    installed: true, supported: true, running: false, canManageRuntime: false, canConfigure: true, canPauseDownload: true,
    models: [model], catalog: [{ id: "catalog-a", name: "Model", aliases: ["family"], descriptions: { en: "Local model", "zh-TW": "本機模型" },
      variants: [{ ...selection, sizeBytes: 512, quantization: "Q4", verifiedAt: "2026-10-01" }] }],
    recommendation: { featuredIds: ["catalog-a"], memoryGb: 16, appleSilicon: false, chip: "CPU" }
  } };
  const context: ManagedRuntimeModelContext = { target, defaultContextWindowTokens: 32768, effectiveContextWindowTokens: 32768,
    maximumContextWindowTokens: 32768, presets: [4096, 16384, 32768], customized: false, canConfigure: true, pendingApply: false, mixed: false };
  const manager: ManagedGgufEnginePort = { snapshot: vi.fn(async () => state.snapshot),
    listRepositoryFiles: vi.fn(async () => ({ revision: "a".repeat(40), files: model.shards })), install: vi.fn(async () => undefined),
    download: vi.fn(async () => undefined), pause: vi.fn(async () => undefined), resume: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
  const ensureProvider = vi.fn(async (): Promise<void> => undefined), getModelContext = vi.fn(async () => context),
    setModelContext = vi.fn(async (_targets: readonly ManagedRuntimeModelTarget[], limit: number | undefined) => ({ ...context,
      effectiveContextWindowTokens: limit ?? 32768, customized: limit !== undefined, pendingApply: true }));
  const controller = new ManagedGgufRuntimeController({ manager, owner, currentOwner: () => state.current,
    providerRoutes: () => [{ backendId: "backend-a", providerId: "managed-provider" }, { backendId: "backend-b", providerId: "managed-provider" }],
    ensureProvider, getModelContext, setModelContext, now: () => 100, totalMemoryBytes: () => 16 * 1024 ** 3 });
  return { state, manager, controller, context, ensureProvider, getModelContext, setModelContext };
}
describe("ManagedGgufRuntimeController", () => {
  it("projects stopped disk inventory, exact sources, full catalog and current routes without advertising model deletion", async () => {
    const f = fixture(); const value = await f.controller.snapshot();
    expect(value).toMatchObject({ state: "stopped", capabilities: { canPullModels: true, canStop: false, canRestart: false,
      canConfigure: true, canDeleteModels: false, supportsRepositoryModels: true, supportsCustomModels: false, startupPolicy: "on_use" },
      installedModels: [{ name: model.id, repositoryModel: selection }], catalog: [{ aliases: ["family"], descriptions: { "zh-TW": "本機模型" },
        variants: [{ repositoryModel: selection, quantization: "Q4" }], recommended: true }], providerRoutes: [{ backendId: "backend-a" }, { backendId: "backend-b" }],
      hostProfile: { memoryGb: 16, chip: "CPU" } });
    expect(value.revision).toBe(1n); expect((await f.controller.snapshot()).revision).toBe(1n);
    await expect(f.controller.beginPull("fake:latest")).rejects.toMatchObject({ code: "MODEL_INCOMPATIBLE" });
    await expect(f.controller.deleteModel(model.id)).rejects.toMatchObject({ code: "MODEL_INCOMPATIBLE" });
  });
  it("keeps borrowed runtime and context readable while owner-only configure, stop and restart fail closed", async () => {
    const f = fixture(); f.state.snapshot = { ...f.state.snapshot, running: true, canConfigure: false, blockedReason: "owned_elsewhere" };
    expect(await f.controller.snapshot()).toMatchObject({ state: "ready", source: "running", configureBlockedReason: "owned_elsewhere",
      capabilities: { canConfigure: false, canPullModels: false, canStop: false, canRestart: false } });
    await expect(f.controller.getModelContext([target])).resolves.toMatchObject({ canConfigure: false });
    await expect(f.controller.stop()).rejects.toMatchObject({ code: "MODEL_INCOMPATIBLE" });
    await expect(f.controller.beginStart()).rejects.toMatchObject({ code: "MODEL_INCOMPATIBLE" });
    await expect(f.controller.restart()).rejects.toMatchObject({ code: "MODEL_INCOMPATIBLE" });
    await expect(f.controller.setModelContext([target], 4096)).rejects.toMatchObject({ code: "MODEL_INCOMPATIBLE" });
    expect(f.manager.stop).not.toHaveBeenCalled(); expect(f.manager.start).not.toHaveBeenCalled(); expect(f.setModelContext).not.toHaveBeenCalled();
  });
  it("passes installation without starting and uses an explicit reload for an owned restart", async () => {
    const f = fixture(); f.state.snapshot = { ...f.state.snapshot, installed: false };
    await f.controller.beginInstall(); await vi.waitFor(() => expect(f.manager.install).toHaveBeenCalledOnce());
    expect(f.manager.start).not.toHaveBeenCalled();
    f.state.snapshot = { ...f.state.snapshot, installed: true, running: true, canManageRuntime: true };
    await vi.waitFor(async () => expect((await f.controller.snapshot()).capabilities.canRestart).toBe(true));
    await f.controller.restart(); await vi.waitFor(() => expect(f.manager.start).toHaveBeenCalledWith(owner, { restart: true }));
  });
  it("lists one complete shard candidate and rejects a late repository reply after owner retirement", async () => {
    const f = fixture(); vi.mocked(f.manager.listRepositoryFiles).mockResolvedValueOnce({ revision: "c".repeat(40), files: [
      { name: "Model-00001-of-00002.gguf", sizeBytes: 5, sha256: "a".repeat(64) },
      { name: "Model-00002-of-00002.gguf", sizeBytes: 7, sha256: "b".repeat(64) }
    ] });
    await expect(f.controller.listRepositoryFiles(selection.repository)).resolves.toEqual({ repository: selection.repository,
      sourceRevision: "c".repeat(40), files: [{ file: "Model-00001-of-00002.gguf", sizeBytes: 12 }] });
    let finish!: (value: Awaited<ReturnType<ManagedGgufEnginePort["listRepositoryFiles"]>>) => void;
    vi.mocked(f.manager.listRepositoryFiles).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.controller.listRepositoryFiles(selection.repository); f.state.current = undefined;
    finish({ revision: "c".repeat(40), files: [] }); await expect(pending).rejects.toMatchObject({ code: "OWNER_CHANGED" });
  });
  it("projects a real engine immutable multi-shard repository once and omits incomplete logical models", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-runtime-query-")); const f = fixture();
    const query = vi.fn(async () => Response.json({ sha: "c".repeat(40), siblings: [
      { rfilename: "Model-00001-of-00002.gguf", lfs: { size: 5, sha256: "a".repeat(64) } },
      { rfilename: "Model-00002-of-00002.gguf", lfs: { size: 7, sha256: "b".repeat(64) } },
      { rfilename: "Incomplete-00001-of-00002.gguf", lfs: { size: 3, sha256: "d".repeat(64) } }
    ] }));
    const manager = new LlamaCppRuntimeManager({ dataRoot: root, currentOwner: () => owner, fetchStreaming: query,
      validateConnection: async () => undefined });
    const controller = new ManagedGgufRuntimeController({ manager, owner, currentOwner: () => owner, providerRoutes: () => [],
      ensureProvider: f.ensureProvider, getModelContext: f.getModelContext, setModelContext: f.setModelContext });
    try {
      await expect(controller.listRepositoryFiles(selection.repository)).resolves.toEqual({ repository: selection.repository,
        sourceRevision: "c".repeat(40), files: [{ file: "Model-00001-of-00002.gguf", sizeBytes: 12 }] });
      expect(query).toHaveBeenCalledOnce();
    } finally { await controller.close(); await rm(root, { recursive: true, force: true }); }
  });
  it("retains an exact in-flight download selection across pause/resume and finite failure with explicit retry", async () => {
    const f = fixture(); let reject!: (error: unknown) => void;
    vi.mocked(f.manager.download).mockImplementationOnce(async () => {
      f.state.snapshot = { ...f.state.snapshot, operation: { transferId: "transfer-a", kind: "download", selection, completed: 10, total: 512 } };
      return new Promise<void>((_resolve, rejectValue) => { reject = rejectValue; });
    });
    await f.controller.downloadRepositoryModel(selection);
    await vi.waitFor(async () => expect((await f.controller.snapshot()).transfers[0]).toMatchObject({ transferId: "transfer-a", repositoryModel: selection }));
    const exact = { transferId: "transfer-a", repositoryModel: selection };
    await f.controller.controlRepositoryDownload(exact, "pause"); await f.controller.controlRepositoryDownload(exact, "resume");
    expect(f.manager.pause).toHaveBeenCalledWith(owner, { transferId: "transfer-a", selection });
    expect(f.manager.resume).toHaveBeenCalledWith(owner, { transferId: "transfer-a", selection });
    const settled = { ...f.state.snapshot }; delete settled.operation; f.state.snapshot = settled;
    reject(new Error("private D:\\runtime\\model path"));
    await vi.waitFor(async () => expect((await f.controller.snapshot()).transfers[0]).toMatchObject({ transferId: "transfer-a", phase: "error", publicErrorCode: "RUNTIME_ERROR" }));
    await f.controller.downloadRepositoryModel(selection); await vi.waitFor(() => expect(f.manager.download).toHaveBeenCalledTimes(2));
  });
  it("validates exact installed source/routes and calls one context Owner transaction for primary and explicitly related routes", async () => {
    const f = fixture(); const related = { ...target, backendId: "backend-b" }; const targets = [target, related];
    await expect(f.controller.setModelContext(targets, 16384)).resolves.toMatchObject({ effectiveContextWindowTokens: 16384, pendingApply: true });
    expect(f.setModelContext).toHaveBeenCalledExactlyOnceWith(targets, 16384, undefined);
    await f.controller.setModelContext(targets, undefined); expect(f.setModelContext).toHaveBeenLastCalledWith(targets, undefined, undefined);
    for (const changed of [[{ ...target, backendId: "foreign" }], [target, target]]) {
      await expect(f.controller.setModelContext(changed, 4096)).rejects.toMatchObject({ code: "MODEL_INVALID" });
    }
    await expect(f.controller.setModelContext([{ ...target, repositoryModel: { ...selection, repository: "owner/Model-GGUF" } }], 4096))
      .rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
    await expect(f.controller.setModelContext(targets, 32769)).rejects.toMatchObject({ code: "MODEL_INVALID" });
    expect(f.setModelContext).toHaveBeenCalledTimes(2);
  });
  it("does not publish a partial inventory after disk read failure or a stale snapshot after a newer commit", async () => {
    const f = fixture(); vi.mocked(f.manager.snapshot).mockRejectedValueOnce(new Error("disk read failed"));
    await expect(f.controller.snapshot()).rejects.toThrow(/disk read/u);
    let finish!: (value: LlamaCppSnapshot) => void;
    vi.mocked(f.manager.snapshot).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const stale = f.controller.snapshot(); const current = await f.controller.snapshot();
    finish({ ...f.state.snapshot, models: [] }); await expect(stale).resolves.toBe(current);
  });
  it("retires a late explicit ensure and retains shutdown responsibility after an unconfirmed stop", async () => {
    const f = fixture(); let finish!: () => void;
    f.ensureProvider.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const ensure = f.controller.ensureProvider(); f.state.current = undefined; finish();
    await expect(ensure).rejects.toMatchObject({ code: "OWNER_CHANGED" });
    f.state.current = owner;
    vi.mocked(f.manager.dispose).mockRejectedValueOnce(new LocalRuntimeError("RUNTIME_ERROR", "stop unconfirmed"));
    await expect(f.controller.close()).rejects.toThrow(/stop unconfirmed/u);
    await expect(f.controller.snapshot()).rejects.toMatchObject({ code: "OWNER_CHANGED" });
    await expect(f.controller.close()).resolves.toBeUndefined(); expect(f.manager.dispose).toHaveBeenCalledTimes(2);
  });
});
