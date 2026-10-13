import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  EntityVersionSchema,
  ManagedModelRuntimeCapabilitiesSchema,
  ManagedModelRuntimeCatalogModelSchema,
  ManagedModelRuntimeErrorCode,
  ManagedModelRuntimeModelSchema,
  ManagedModelRuntimePreflightSchema,
  ManagedModelRuntimeResourceState,
  ManagedModelRuntimeSchema,
  ManagedModelRuntimeSource,
  ManagedModelRuntimeState,
  ManagedModelRuntimeTransferKind,
  ManagedModelRuntimeTransferPhase,
  ManagedModelRuntimeTransferSchema,
  RevisionSchema,
  ManagedModelRuntimeStartupPolicy,
  ManagedModelRuntimeConfigureBlockedReason,
  ManagedRepositoryDownloadAction,
  GetSnapshotResponseSchema,
  SnapshotSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway, mapManagedModelRuntime } from "./gateway.js";

describe("managed model runtime gateway projection", () => {
  it("preserves capability, preflight, model and transfer authority", () => {
    const runtime = mapManagedModelRuntime(create(ManagedModelRuntimeSchema, {
      runtimeId: "runtime-a",
      displayName: "Local Runtime",
      state: ManagedModelRuntimeState.READY,
      source: ManagedModelRuntimeSource.MANAGED_SIDECAR,
      version: "1.2.3",
      capabilities: create(ManagedModelRuntimeCapabilitiesSchema, {
        canInstall: true,
        canCancelInstall: true,
        canStart: true,
        canListModels: true,
        canPullModels: true,
        canDeleteModels: true,
        canPausePulls: true,
        canResumePulls: true,
        canCancelPulls: true,
        supportsCustomModels: true,
        supportsCuratedCatalog: true,
        supportsModelPreflight: true,
        canConfigure: false, canStop: true, canRestart: true, supportsRepositoryModels: true, startupPolicy: ManagedModelRuntimeStartupPolicy.ON_USE
      }),
      installPreflight: create(ManagedModelRuntimePreflightSchema, {
        allowed: true,
        memory: ManagedModelRuntimeResourceState.CONSTRAINED,
        disk: ManagedModelRuntimeResourceState.SUFFICIENT,
        requiredDiskBytes: 1_024n
      }),
      installedModels: [create(ManagedModelRuntimeModelSchema, {
        modelName: "model:a",
        displayName: "Model A",
        sizeBytes: 2_048n,
        contextWindowTokens: 32_768n,
        supportsTools: true,
        supportsImages: true,
        repositoryModel: { repository: "Owner/Model-GGUF", file: "Model.gguf" }
      })],
      catalog: [create(ManagedModelRuntimeCatalogModelSchema, {
        catalogId: "catalog-a",
        modelName: "catalog:a",
        displayName: "Catalog A",
        sizeBytes: 4_096n,
        minimumMemoryGb: 16,
        recommended: true,
        aliases: ["Example alias"], descriptions: { en: "English", "zh-CN": "简体", "zh-TW": "繁體", ja: "日本語", ko: "한국어" }, variants: [{ repositoryModel: { repository: "Owner/Model-GGUF", file: "Model.gguf" }, quantization: "Q4", sizeBytes: 4_096n }],
        preflight: create(ManagedModelRuntimePreflightSchema, {
          allowed: false,
          memory: ManagedModelRuntimeResourceState.SUFFICIENT,
          disk: ManagedModelRuntimeResourceState.INSUFFICIENT,
          requiredDiskBytes: 8_192n,
          errorCode: ManagedModelRuntimeErrorCode.DISK_SPACE_LOW
        })
      })],
      transfers: [create(ManagedModelRuntimeTransferSchema, {
        kind: ManagedModelRuntimeTransferKind.MODEL_PULL,
        modelName: "catalog:a",
        phase: ManagedModelRuntimeTransferPhase.DOWNLOADING,
        completedBytes: 50n,
        totalBytes: 100n,
        percent: 50,
        bytesPerSecond: 25n,
        done: false,
        transferId: "transfer-a", repositoryModel: { repository: "Owner/Model-GGUF", file: "Model.gguf" }
      })],
      entityVersion: create(EntityVersionSchema, {
        revision: create(RevisionSchema, { value: 9n, etag: "runtime-9" }),
        generation: 7n
      }),
      providerRoutes: [{ backendId: "route-a", providerId: "local-provider" }], hostProfile: { platform: "darwin", arch: "arm64", memoryGb: 16, totalMemoryBytes: 16n * 1_024n ** 3n, appleSilicon: true, chip: "Test chip" }, configureBlockedReason: ManagedModelRuntimeConfigureBlockedReason.OWNED_ELSEWHERE
    }));

    expect(runtime).toMatchObject({
      id: "runtime-a",
      state: "ready",
      source: "managedSidecar",
      capabilities: { canPullModels: true, supportsCustomModels: true, canConfigure: false, canStop: true, canRestart: true, supportsRepositoryModels: true, startupPolicy: "onUse" },
      installPreflight: { memory: "constrained", disk: "sufficient" },
      installedModels: [{ name: "model:a", contextWindowTokens: 32_768, supportsTools: true, supportsImages: true, repositoryModel: { repository: "Owner/Model-GGUF", file: "Model.gguf" } }],
      catalog: [{ id: "catalog-a", recommended: true, preflight: { allowed: false, errorCode: "diskSpaceLow" } }],
      transfers: [{ kind: "modelPull", phase: "downloading", percent: 50, bytesPerSecond: 25 }],
      revision: 9n,
      configureBlockedReason: "ownedElsewhere", providerRoutes: [{ backendId: "route-a", providerId: "local-provider" }], hostProfile: { chip: "Test chip", appleSilicon: true }
    });
    expect(runtime.catalog[0]?.variants).toEqual([{ repository: "Owner/Model-GGUF", file: "Model.gguf", quantization: "Q4", sizeBytes: 4_096 }]);
    expect(Object.keys(runtime.catalog[0]!.descriptions!)).toHaveLength(5);
    expect(runtime.transfers[0]).toMatchObject({ transferId: "transfer-a", repositoryModel: { repository: "Owner/Model-GGUF", file: "Model.gguf" } });
  });

  it("sends exact repository and atomic model routes through generated ports and rejects changed read ownership", async () => {
    const calls: { method: string; input: any }[] = [];
    const repositoryModel = { repository: "Owner/Model-GGUF", file: "Model-00001-of-00002.gguf" };
    const target = { backendId: "route-a", providerId: "local-provider", modelId: "installed-id", repositoryModel, relatedTargets: [{ backendId: "route-b", providerId: "local-provider", modelId: "installed-id", repositoryModel }] };
    let wrongQuery = false;
    const transport = testTransport((method, input) => {
      calls.push({ method, input });
      if (method === "listManagedModelRepositoryFiles") return { repository: wrongQuery ? "Owner/Other-GGUF" : repositoryModel.repository, sourceRevision: "immutable-revision", files: [{ file: repositoryModel.file, sizeBytes: 12_288n }] };
      if (method.endsWith("ManagedModelContext")) return { context: { target: input.target, defaultContextWindowTokens: 32_768n, effectiveContextWindowTokens: input.contextWindowTokens ?? 32_768n, maximumContextWindowTokens: 32_768n, presets: [32_768n], canConfigure: true, customized: method.startsWith("set"), pendingApply: true, mixed: true } };
      return { runtime: { runtimeId: "runtime-a", displayName: "Runtime", entityVersion: { revision: { value: 2n } } } };
    });
    const gateway = gatewayWith(transport);
    await gateway.connect();
    try {
      expect(await gateway.listManagedModelRepositoryFiles("runtime-a", repositoryModel.repository)).toEqual({ repository: repositoryModel.repository, sourceRevision: "immutable-revision", files: [{ file: repositoryModel.file, sizeBytes: 12_288 }] });
      await gateway.ensureManagedModelRuntimeProvider("runtime-a");
      await gateway.downloadManagedRepositoryModel("runtime-a", repositoryModel);
      await gateway.controlManagedRepositoryDownload("runtime-a", "transfer-a", repositoryModel, "pause");
      await gateway.stopManagedModelRuntime("runtime-a");
      await gateway.restartManagedModelRuntime("runtime-a");
      expect(await gateway.getManagedModelContext("runtime-a", target)).toMatchObject({ ...target, mixed: true });
      expect(await gateway.setManagedModelContext("runtime-a", target, 16_000)).toMatchObject({ effectiveContextWindowTokens: 16_000 });
      await gateway.resetManagedModelContext("runtime-a", target);
      expect(calls.find((call) => call.method === "controlManagedRepositoryDownload")?.input).toMatchObject({ transferId: "transfer-a", repositoryModel, action: ManagedRepositoryDownloadAction.PAUSE });
      const writes = calls.filter((call) => call.method === "setManagedModelContext");
      expect(writes).toHaveLength(1);
      expect(writes[0]?.input).toMatchObject({ runtimeId: "runtime-a", target: { backendId: target.backendId, providerId: target.providerId, modelId: target.modelId, repositoryModel }, relatedTargets: target.relatedTargets, contextWindowTokens: 16_000n });
      expect(writes[0]?.input.target).not.toHaveProperty("relatedTargets");
      wrongQuery = true;
      await expect(gateway.listManagedModelRepositoryFiles("runtime-a", repositoryModel.repository)).rejects.toThrow("ownership changed");
    } finally { gateway.disconnect(); }
  });

  it.each(["query cancellation", "mutation disconnect"] as const)("retires late managed responses after %s", async (kind) => {
    let finish!: () => void;
    let requestSignal: AbortSignal | undefined;
    const snapshots: unknown[] = [];
    const transport = testTransport(async (_method, _input, signal) => {
      requestSignal = signal;
      await new Promise<void>((resolve) => { finish = resolve; });
      return kind === "query cancellation" ? { repository: "Owner/Model-GGUF", sourceRevision: "revision", files: [] } : { runtime: { runtimeId: "late-runtime", displayName: "Late" } };
    });
    const gateway = gatewayWith(transport, (snapshot) => snapshots.push(snapshot));
    await gateway.connect();
    try {
      const abort = new AbortController();
      const pending = kind === "query cancellation" ? gateway.listManagedModelRepositoryFiles("runtime-a", "Owner/Model-GGUF", abort.signal) : gateway.downloadManagedRepositoryModel("runtime-a", { repository: "Owner/Model-GGUF", file: "Model.gguf" });
      const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      const before = snapshots.length;
      if (kind === "query cancellation") abort.abort(); else gateway.disconnect();
      expect(requestSignal?.aborted).toBe(true);
      finish();
      await rejection;
      expect(snapshots).toHaveLength(before);
    } finally { gateway.disconnect(); }
  });

  it("keeps a newer mutation snapshot when an earlier inventory poll finishes late", async () => {
    let finish!: () => void;
    let late = false;
    const snapshots: any[] = [];
    const stale = { runtimeId: "runtime-a", displayName: "Before download", entityVersion: { revision: { value: 1n } } };
    const updated = { runtimeId: "runtime-a", displayName: "After download", entityVersion: { revision: { value: 2n } } };
    const transport = testTransport(() => ({ runtime: updated }), async () => { if (late) await new Promise<void>((resolve) => { finish = resolve; }); return { runtimes: [stale] }; });
    const gateway = gatewayWith(transport, (snapshot) => snapshots.push(snapshot));
    await gateway.connect();
    try {
      late = true;
      const polling = gateway.refreshManagedModelRuntimes();
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      await gateway.downloadManagedRepositoryModel("runtime-a", { repository: "Owner/Model-GGUF", file: "Model.gguf" });
      finish();
      expect(await polling).toMatchObject([{ name: "After download", revision: 2n }]);
      expect(snapshots.at(-1)?.managedModelRuntimes).toMatchObject([{ name: "After download", revision: 2n }]);
    } finally { gateway.disconnect(); }
  });
});

function testTransport(handler: (method: string, input: any, signal?: AbortSignal) => unknown | Promise<unknown>, list?: () => unknown | Promise<unknown>): Transport {
  return { unary: vi.fn(async (method: any, signal: AbortSignal | undefined, _timeout: unknown, _headers: unknown, input: any) => {
    let value: unknown;
    if (method.localName === "getSnapshot") value = create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } }) });
    else if (method.parent.typeName !== "joko.v1.ManagedModelRuntimeService") throw new Error("Unconfigured optional service.");
    else if (method.localName === "listManagedModelRuntimes") value = create(method.output, await (list?.() ?? { runtimes: [] }) as any);
    else value = create(method.output, await handler(method.localName, input, signal) as any);
    return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message: value };
  }), stream: vi.fn(async (method: any) => ({ stream: true, service: method.parent, method, header: new Headers(), trailer: new Headers(), message: idleStream() })) } as unknown as Transport;
}
function gatewayWith(transport: Transport, onSnapshot?: (snapshot: unknown) => void) { return createOrchestratorGateway({ id: "connection-a", deviceId: "device-a", serverId: "server-a", name: "Local", origin: "https://node.example.test" }, "test-key", { ...(onSnapshot === undefined ? {} : { onSnapshot }) }, () => transport); }
async function* idleStream(): AsyncIterable<never> { await new Promise<never>(() => undefined); }
