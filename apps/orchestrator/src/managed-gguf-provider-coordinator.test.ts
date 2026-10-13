import { join } from "node:path";
import { tmpdir } from "node:os";
import { OperationalStore } from "@joko/store";
import { llamaCppModelId, type LlamaCppModel, type LlamaCppSnapshot, type RuntimeOwnerGeneration } from "@joko/local-model-runtime";
import { describe, expect, it, vi } from "vitest";
import { CredentialManager, ProviderCatalogManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { mkdtemp } from "./test-paths.js";
import { ManagedGgufProviderCoordinator } from "./managed-gguf-provider-coordinator.js";
import { MANAGED_GGUF_PROVIDER_ID } from "./managed-gguf-provider.js";

const owner = { ownerId: "node-a", generation: 1 } as const;
const selection = { repository: "bartowski/Qwen3.8-Flash-Next-GGUF", file: "model-Q4.gguf" };
const model: LlamaCppModel = { ...selection, id: llamaCppModelId(selection), sizeBytes: 4, revision: "a".repeat(40),
  shards: [{ name: selection.file, sizeBytes: 4, sha256: "b".repeat(64) }] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-gguf-provider-"));
  const credentials = new CredentialManager({ vault: await CredentialVault.open(join(root, "vault.key")), storagePath: join(root, "credentials.json") });
  await credentials.initialize();
  const store = new OperationalStore(join(root, "node.db"));
  const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "backend-a" }); providers.initialize();
  let current: RuntimeOwnerGeneration | undefined = owner;
  let state: LlamaCppSnapshot = { installed: true, supported: true, running: false, canManageRuntime: false, canConfigure: true,
    canPauseDownload: false, models: [model], catalog: [], recommendation: { featuredIds: [], memoryGb: 32, appleSilicon: false } };
  let beforeWrite: (() => Promise<void>) | undefined;
  const snapshot = vi.fn(async () => state), changed = vi.fn(async () => undefined);
  const coordinator = new ManagedGgufProviderCoordinator({ providers, currentOwner: () => current,
    backendIds: () => ["backend-a", "backend-b", "backend-c"], snapshot, onChanged: changed,
    configure: async (_owner, effect) => { await beforeWrite?.(); return effect(); },
    remove: async (_owner, effect) => { await beforeWrite?.(); return effect(); } });
  const targets = ["backend-a", "backend-b", "backend-c"].map(backendId => ({ backendId, providerId: MANAGED_GGUF_PROVIDER_ID, modelId: model.id, repositoryModel: selection }));
  return { root, store, credentials, providers, coordinator, targets, snapshot, changed,
    setOwner: (value: RuntimeOwnerGeneration | undefined) => { current = value; },
    setState: (value: Partial<LlamaCppSnapshot>) => { state = { ...state, ...value }; },
    beforeWrite: (value: () => Promise<void>) => { beforeWrite = value; } };
}
describe("managed GGUF Provider coordinator", () => {
  it("creates an empty connection only on explicit Add and preserves it when the stopped inventory is empty", async () => {
    const f = await fixture(); try {
      await f.coordinator.sync(owner, [model], []); expect(f.providers.listConfigurations()).toEqual([]);
      await f.coordinator.ensure(owner); expect(f.snapshot).not.toHaveBeenCalled();
      expect(f.providers.listConfigurations()[0]?.runtimes.map(runtime => runtime.provider.models)).toEqual([[], [], []]);
      await expect(f.providers.upsertConfiguration({ providerId: "ordinary-keyless", displayName: "Ordinary", kind: "local_keyless", enabled: true,
        expectedVersion: 0n, runtimes: [{ backendId: "backend-a", provider: { id: "ordinary-keyless", keyless: true,
          baseUrl: "http://127.0.0.1:12000/v1", api: "openai-completions", models: [] }, credentialBindings: {}, credentialOrigin: "" }] }))
        .rejects.toThrow("at least one model");
      await f.coordinator.sync(owner, [model], []); const before = f.providers.listConfigurations()[0]!;
      await f.coordinator.ensure(owner); expect(f.providers.listConfigurations()[0]!.version).toBe(before.version);
      await f.coordinator.sync(owner, [], []); expect(f.coordinator.routes()).toHaveLength(3);
      await f.coordinator.removeProvider(owner, MANAGED_GGUF_PROVIDER_ID); await f.coordinator.sync(owner, [model], []);
      expect(f.providers.listConfigurations()).toEqual([]);
    } finally { f.store.close(); }
  });
  it("saves precisely the requested related routes in one durable CAS and keeps the server maximum across every route", async () => {
    const f = await fixture(); try {
      await f.coordinator.ensure(owner); await f.coordinator.sync(owner, [model], []);
      const before = f.providers.listConfigurations()[0]!.version;
      const write = vi.spyOn(f.providers, "upsertConfiguration");
      await f.coordinator.setContext(owner, f.targets.slice(0, 2), 1_000_000);
      expect(write).toHaveBeenCalledTimes(1);
      const saved = f.providers.listConfigurations()[0]!;
      expect(saved.version).toBe(before + 1n);
      expect(saved.runtimes.map(runtime => runtime.provider.models[0]?.contextWindow)).toEqual([1_000_000, 1_000_000, 262144]);
      expect(await f.coordinator.getContext(owner, f.targets)).toMatchObject({ mixed: true, customized: true });
      expect(f.coordinator.contextLimits(model)).toEqual([1_000_000, 1_000_000, 262144]);
      f.coordinator.didStart(); f.setState({ running: true, canManageRuntime: true });
      expect(await f.coordinator.getContext(owner, f.targets)).toMatchObject({ pendingApply: false });
      f.coordinator.didStart(); expect(await f.coordinator.getContext(owner, f.targets)).toMatchObject({ pendingApply: false });
      await f.coordinator.setContext(owner, f.targets.slice(0, 2), undefined);
      expect(await f.coordinator.getContext(owner, f.targets)).toMatchObject({ mixed: false, pendingApply: true, effectiveContextWindowTokens: 262144 });
      f.store.close();
      const reopenedStore = new OperationalStore(join(f.root, "node.db"));
      try { const reopened = new ProviderCatalogManager({ store: reopenedStore, credentials: f.credentials, nativeBackendId: "backend-a" });
        reopened.initialize();
        expect(reopened.listConfigurations()[0]?.runtimes.map(runtime => runtime.provider.models[0]?.contextWindow)).toEqual([262144, 262144, 262144]);
      } finally { reopenedStore.close(); }
    } finally { f.store.close(); }
  });
  it("blocks borrowed configuration, invalid source and retired mutation owners without changing route budgets", async () => {
    const f = await fixture(); try {
      await f.coordinator.ensure(owner); await f.coordinator.sync(owner, [model], []);
      f.setState({ running: true, canConfigure: false });
      await expect(f.coordinator.setContext(owner, f.targets, 1_000_000)).rejects.toMatchObject({ code: "MODEL_INVALID" });
      f.setState({ canConfigure: true });
      await expect(f.coordinator.setContext(owner, [{ ...f.targets[0]!, repositoryModel: { ...selection, file: "other.gguf" } }], 1_000_000)).rejects.toMatchObject({ code: "MODEL_INVALID" });
      f.beforeWrite(async () => { f.setOwner({ ...owner, generation: 2 }); });
      await expect(f.coordinator.setContext(owner, f.targets, 1_000_000)).rejects.toMatchObject({ code: "OWNER_CHANGED" });
      expect(f.providers.listConfigurations()[0]!.runtimes.every(runtime => runtime.provider.models[0]?.contextWindow === 262144)).toBe(true);
    } finally { f.store.close(); }
  });
  it("keeps the connection until stop confirms and rejects a concurrent replacement before deletion", async () => {
    const f = await fixture(); try {
      await f.coordinator.ensure(owner);
      f.beforeWrite(async () => { throw new Error("stop unconfirmed"); });
      await expect(f.coordinator.removeProvider(owner, MANAGED_GGUF_PROVIDER_ID)).rejects.toThrow("stop unconfirmed");
      expect(f.coordinator.routes()).toHaveLength(3);
      f.beforeWrite(async () => { const current = f.providers.listConfigurations()[0]!;
        await f.providers.upsertConfiguration({ providerId: current.providerId, displayName: "new connection", kind: current.kind,
          enabled: current.enabled, expectedVersion: current.version, runtimes: current.runtimes.map(runtime => ({ backendId: runtime.backendId,
            provider: runtime.provider, credentialBindings: {}, credentialOrigin: "" })) }); });
      await expect(f.coordinator.removeProvider(owner, MANAGED_GGUF_PROVIDER_ID)).rejects.toMatchObject({ code: "RUNTIME_ERROR" });
      expect(f.providers.listConfigurations()[0]?.displayName).toBe("new connection");
      await expect(f.providers.delete(MANAGED_GGUF_PROVIDER_ID, { expectedVersion: 1n })).rejects.toThrow("changed concurrently");
      expect(f.coordinator.routes()).toHaveLength(3);
    } finally { f.store.close(); }
  });
  it("does not overwrite a custom endpoint occupying the managed connection identity", async () => {
    const f = await fixture(); try {
      await f.coordinator.ensure(owner); const current = f.providers.listConfigurations()[0]!;
      await f.coordinator.sync(owner, [model], []);
      const populated = f.providers.listConfigurations()[0]!;
      await f.providers.upsertConfiguration({ providerId: current.providerId, displayName: "custom", kind: "custom_endpoint", enabled: true,
        expectedVersion: populated.version, runtimes: [{ backendId: "backend-a", provider: { ...populated.runtimes[0]!.provider, baseUrl: "https://example.invalid/v1" },
          credentialBindings: {}, credentialOrigin: "" }] });
      await expect(f.coordinator.ensure(owner)).rejects.toMatchObject({ code: "RUNTIME_ERROR" });
      await expect(f.coordinator.sync(owner, [model], [])).rejects.toMatchObject({ code: "RUNTIME_ERROR" });
      expect(f.providers.listConfigurations()[0]?.displayName).toBe("custom");
    } finally { f.store.close(); }
  });
});
