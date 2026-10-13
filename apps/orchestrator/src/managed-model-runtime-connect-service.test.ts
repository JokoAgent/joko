import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { LocalRuntimeError } from "@joko/local-model-runtime";
import * as contract from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { ManagedModelRuntimeController } from "./managed-model-runtime-controller.js";
import type { ManagedModelRuntimeManagerPort } from "./managed-model-runtime-controller.js";
import { ManagedModelRuntimeRegistry } from "./managed-model-runtime-registry.js";
import type { ManagedModelRuntimePort, ManagedRuntimeModelContext, ManagedRuntimeModelTarget } from "./managed-model-runtime-port.js";
import {
  createManagedModelRuntimeConnectService,
  mapManagedModelRuntime
} from "./managed-model-runtime-connect-service.js";

const owner = { ownerId: "orchestrator-a", generation: 1 } as const;

function controller(): ManagedModelRuntimeController {
  const manager: ManagedModelRuntimeManagerPort = {
    status: async () => ({
      runtime: "ollama",
      state: "ready",
      source: "running",
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
    curated: () => ({
      catalog: [{
        id: "catalog-a",
        displayName: "Catalog A",
        libraryName: "catalog:a",
        aliases: ["catalog"],
        sizeBytes: 4_096,
        minimumMemoryGb: 8,
        appleSiliconOnly: false
      }],
      recommended: []
    }),
    runtimePreflight: () => ({ allowed: true, memory: "sufficient", disk: "unknown", requiredDiskBytes: 2_048 }),
    modelPreflight: () => ({ allowed: true, memory: "sufficient", disk: "unknown", requiredDiskBytes: 8_192 }),
    installProgress: () => undefined,
    list: async () => [{
      name: "model:a",
      sizeBytes: 128,
      contextLength: 16_384,
      capabilities: ["tools", "vision"]
    }],
    paused: async () => [],
    activePulls: () => [],
    start: async () => ({
      runtime: "ollama",
      state: "ready",
      source: "running",
      capabilities: {
        canInstall: true,
        canStart: true,
        canListModels: true,
        canPullModels: true,
        canDeleteModels: true,
        canPausePulls: true
      }
    }),
    install: async () => ({
      runtime: "ollama",
      state: "ready",
      source: "managed_sidecar",
      capabilities: {
        canInstall: false,
        canStart: true,
        canListModels: true,
        canPullModels: true,
        canDeleteModels: true,
        canPausePulls: true
      }
    }),
    abortInstall: () => undefined,
    pull: async () => undefined,
    pause: async () => undefined,
    resume: async () => undefined,
    cancel: async () => undefined,
    delete: async () => undefined,
    shutdown: async () => undefined
  };
  return new ManagedModelRuntimeController({ manager, owner, now: () => 123 });
}

describe("managed model runtime Connect service", () => {
  it("maps capability, recommendation, model metadata and preflight without endpoint or path data", async () => {
    const runtimeController = controller();
    const snapshot = await runtimeController.snapshot();
    const projected = mapManagedModelRuntime(snapshot);
    expect(projected).toMatchObject({
      runtimeId: "ollama",
      state: contract.ManagedModelRuntimeState.READY,
      capabilities: {
        canPullModels: true,
        supportsCustomModels: true,
        supportsCuratedCatalog: true
      },
      installedModels: [{
        modelName: "model:a",
        contextWindowTokens: 16_384n,
        supportsTools: true,
        supportsImages: true
      }],
      catalog: [{ catalogId: "catalog-a", modelName: "catalog:a", preflight: { allowed: true } }]
    });
    expect(JSON.stringify(projected, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toMatch(/[A-Z]:\\|\/Users\/|credential|api.?key/iu);
  });

  it("authenticates reads and rejects unknown runtime identities", async () => {
    const authenticate = vi.fn();
    const service = createManagedModelRuntimeConnectService(new ManagedModelRuntimeRegistry([controller()]), authenticate);
    const context = {} as HandlerContext;
    const listed = await service.listManagedModelRuntimes(
      create(contract.ListManagedModelRuntimesRequestSchema),
      context
    );
    expect(listed.runtimes).toHaveLength(1);
    expect(authenticate).toHaveBeenCalledWith(context);
    await expect(service.getManagedModelRuntime(
      create(contract.GetManagedModelRuntimeRequestSchema, { runtimeId: "missing" }),
      context
    )).rejects.toMatchObject({ code: 5 });
  });

  it("returns an empty capability-discovery list when the node has no runtime", async () => {
    const service = createManagedModelRuntimeConnectService(undefined, () => undefined);
    await expect(service.listManagedModelRuntimes(
      create(contract.ListManagedModelRuntimesRequestSchema),
      {} as HandlerContext
    )).resolves.toMatchObject({ runtimes: [] });
  });

  async function repositoryPort() {
    const base = controller(); const state = { value: { ...(await base.snapshot()), runtimeId: "llama-cpp",
      capabilities: { ...(await base.snapshot()).capabilities, canConfigure: true, canStop: true, canRestart: true,
        supportsRepositoryModels: true, canDeleteModels: false, startupPolicy: "on_use" as const } } };
    const source = { repository: "Owner/Model-GGUF", file: "nested/Model-Q4.gguf" };
    const target: ManagedRuntimeModelTarget = { backendId: "backend-a", providerId: "managed-provider", modelId: "model-exact", repositoryModel: source };
    const context: ManagedRuntimeModelContext = { target, defaultContextWindowTokens: 32768, effectiveContextWindowTokens: 16384,
      maximumContextWindowTokens: 32768, presets: [4096, 16384, 32768], customized: true, canConfigure: true, pendingApply: true, mixed: false };
    const port: ManagedModelRuntimePort = { runtimeId: "llama-cpp", snapshot: vi.fn(async () => state.value),
      preflight: base.preflight.bind(base), beginStart: base.beginStart.bind(base), beginInstall: base.beginInstall.bind(base),
      cancelInstall: base.cancelInstall.bind(base), beginPull: base.beginPull.bind(base), pausePull: base.pausePull.bind(base),
      resumePull: base.resumePull.bind(base), cancelPull: base.cancelPull.bind(base), close: base.close.bind(base),
      deleteModel: vi.fn(async () => { throw new LocalRuntimeError("MODEL_INCOMPATIBLE", "Not supported."); }),
      ensureProvider: vi.fn(async () => state.value), stop: vi.fn(async () => state.value), restart: vi.fn(async () => state.value),
      listRepositoryFiles: vi.fn(async repository => ({ repository, sourceRevision: "a".repeat(40), files: [{ file: source.file, sizeBytes: 512 }] })),
      downloadRepositoryModel: vi.fn(async () => state.value), controlRepositoryDownload: vi.fn(async () => state.value),
      getModelContext: vi.fn(async () => context), setModelContext: vi.fn(async () => context) };
    return { state, source, target, context, port };
  }
  it("dispatches exact runtime registrations and typed repository selection without interpreting it as an Ollama name", async () => {
    const f = await repositoryPort(); const authenticate = vi.fn();
    const service = createManagedModelRuntimeConnectService(new ManagedModelRuntimeRegistry([controller(), f.port]), authenticate);
    const context = {} as HandlerContext;
    await expect(service.listManagedModelRuntimes(create(contract.ListManagedModelRuntimesRequestSchema), context))
      .resolves.toMatchObject({ runtimes: [{ runtimeId: "ollama" }, { runtimeId: "llama-cpp" }] });
    const files = await service.listManagedModelRepositoryFiles(create(contract.ListManagedModelRepositoryFilesRequestSchema,
      { runtimeId: "llama-cpp", repository: f.source.repository }), context);
    expect(files).toEqual({ repository: f.source.repository, sourceRevision: "a".repeat(40), files: [{ file: f.source.file, sizeBytes: 512n }] });
    await service.downloadManagedRepositoryModel(create(contract.DownloadManagedRepositoryModelRequestSchema, { runtimeId: "llama-cpp", repositoryModel: f.source }), context);
    expect(f.port.downloadRepositoryModel).toHaveBeenCalledExactlyOnceWith(f.source);
    await expect(service.getManagedModelRuntime(create(contract.GetManagedModelRuntimeRequestSchema, { runtimeId: "llamacpp" }), context))
      .rejects.toMatchObject({ code: Code.NotFound });
    await expect(service.listManagedModelRepositoryFiles(create(contract.ListManagedModelRepositoryFilesRequestSchema,
      { runtimeId: "ollama", repository: f.source.repository }), context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
  });
  it("passes exact transfer identity, source and explicit controls and rejects unknown actions or unsupported model deletion", async () => {
    const f = await repositoryPort(); const context = {} as HandlerContext;
    const service = createManagedModelRuntimeConnectService(new ManagedModelRuntimeRegistry([f.port]), () => undefined);
    await service.controlManagedRepositoryDownload(create(contract.ControlManagedRepositoryDownloadRequestSchema,
      { runtimeId: "llama-cpp", repositoryModel: f.source, transferId: "transfer-a", action: contract.ManagedRepositoryDownloadAction.PAUSE }), context);
    expect(f.port.controlRepositoryDownload).toHaveBeenCalledExactlyOnceWith({ transferId: "transfer-a", repositoryModel: f.source }, "pause");
    await expect(service.controlManagedRepositoryDownload(create(contract.ControlManagedRepositoryDownloadRequestSchema,
      { runtimeId: "llama-cpp", repositoryModel: f.source, transferId: "transfer-a" }), context)).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(service.downloadManagedRepositoryModel(create(contract.DownloadManagedRepositoryModelRequestSchema,
      { runtimeId: "llama-cpp", repositoryModel: { ...f.source, file: "../escape.gguf" } }), context)).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(service.deleteManagedModel(create(contract.DeleteManagedModelRequestSchema, { runtimeId: "llama-cpp", modelName: "model-exact" }), context))
      .rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(f.port.downloadRepositoryModel).not.toHaveBeenCalled();
    expect(f.port.deleteModel).not.toHaveBeenCalled();
  });
  it("routes primary and related model context in one callback and bounds the explicit transaction", async () => {
    const f = await repositoryPort(); const context = {} as HandlerContext;
    const service = createManagedModelRuntimeConnectService(new ManagedModelRuntimeRegistry([f.port]), () => undefined);
    const request = create(contract.SetManagedModelContextRequestSchema, { runtimeId: "llama-cpp", target: f.target,
      relatedTargets: [{ ...f.target, backendId: "backend-b" }], contextWindowTokens: 16384n });
    await expect(service.setManagedModelContext(request, context)).resolves.toMatchObject({ context: { target: f.target,
      defaultContextWindowTokens: 32768n, effectiveContextWindowTokens: 16384n, presets: [4096n, 16384n, 32768n] } });
    expect(f.port.setModelContext).toHaveBeenCalledExactlyOnceWith([f.target, { ...f.target, backendId: "backend-b" }], 16384, undefined);
    request.relatedTargets.push(create(contract.ManagedModelRuntimeModelTargetSchema, { ...f.target, backendId: "backend-c" }),
      create(contract.ManagedModelRuntimeModelTargetSchema, { ...f.target, backendId: "backend-d" }));
    await expect(service.setManagedModelContext(request, context)).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(f.port.setModelContext).toHaveBeenCalledOnce();
    await service.resetManagedModelContext(create(contract.ResetManagedModelContextRequestSchema, { runtimeId: "llama-cpp", target: f.target }), context);
    expect(f.port.setModelContext).toHaveBeenLastCalledWith([f.target], undefined, undefined);
  });
  it("reauthenticates after every late read and cancels before an admitted capability effect", async () => {
    const f = await repositoryPort(); let valid = true;
    const authenticate = vi.fn(() => { if (!valid) throw new ConnectError("The connection was revoked.", Code.Unauthenticated); });
    const service = createManagedModelRuntimeConnectService(new ManagedModelRuntimeRegistry([f.port]), authenticate);
    let finish!: (value: typeof f.state.value) => void;
    vi.mocked(f.port.snapshot).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = service.getManagedModelRuntime(create(contract.GetManagedModelRuntimeRequestSchema, { runtimeId: "llama-cpp" }), {} as HandlerContext);
    valid = false; finish(f.state.value); await expect(pending).rejects.toMatchObject({ code: Code.Unauthenticated });
    valid = true; const abort = new AbortController();
    vi.mocked(f.port.snapshot).mockImplementationOnce(async () => { abort.abort(); return f.state.value; });
    await expect(service.stopManagedModelRuntime(create(contract.StopManagedModelRuntimeRequestSchema, { runtimeId: "llama-cpp" }),
      { signal: abort.signal } as HandlerContext)).rejects.toMatchObject({ code: Code.Canceled });
    expect(f.port.stop).not.toHaveBeenCalled();
  });
  it("sanitizes internal failures and rejects absent configure capability before context mutation", async () => {
    const f = await repositoryPort(); const context = {} as HandlerContext;
    const service = createManagedModelRuntimeConnectService(new ManagedModelRuntimeRegistry([f.port]), () => undefined);
    vi.mocked(f.port.listRepositoryFiles!).mockRejectedValueOnce(new Error("private proxy credential and D:\\runtime path"));
    await expect(service.listManagedModelRepositoryFiles(create(contract.ListManagedModelRepositoryFilesRequestSchema,
      { runtimeId: "llama-cpp", repository: f.source.repository }), context)).rejects.toMatchObject({ code: Code.Internal, rawMessage: "The local model operation failed." });
    f.state.value = { ...f.state.value, capabilities: { ...f.state.value.capabilities, canConfigure: false } };
    await expect(service.setManagedModelContext(create(contract.SetManagedModelContextRequestSchema,
      { runtimeId: "llama-cpp", target: f.target, contextWindowTokens: 16384n }), context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(f.port.setModelContext).not.toHaveBeenCalled();
  });
});
