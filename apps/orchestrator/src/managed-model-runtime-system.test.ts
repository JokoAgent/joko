import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, Code } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import * as contract from "@joko/contracts";
import { llamaCppModelId } from "@joko/local-model-runtime";
import { OperationalStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import type { AdapterContext } from "@joko/core";
import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "./test-paths.js";
import { CredentialManager, ProviderCatalogManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { createManagedModelRuntimeSystem } from "./managed-model-runtime-system.js";
import { MANAGED_GGUF_PROVIDER_ID } from "./managed-gguf-provider.js";
import { ConnectionManager } from "./connection-manager.js";
import { createPublicServer } from "./server.js";
import type { OrchestratorApplication } from "./application.js";
import { SessionHost } from "./session-host.js";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-gguf-system-")), database = join(root, "node.db");
  const store = new OperationalStore(database);
  const credentials = new CredentialManager({ vault: await CredentialVault.open(join(root, "vault.key")), storagePath: join(root, "credentials.json") });
  await credentials.initialize();
  const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "backend-a" }); providers.initialize();
  for (const id of ["backend-a", "backend-b", "backend-c"]) {
    store.upsertBackend(await new FakeBackendAdapter({ ...PI_LIKE_PROFILE, id,
      capabilities: [...PI_LIKE_PROFILE.capabilities, { key: "provider.managed_catalog", supported: true }] }).describe());
  }
  const streaming = vi.fn<typeof fetch>(async () => { throw new Error("This cold inventory journey must not download or start a runtime."); });
  const changed = vi.fn(async () => undefined);
  const system = await createManagedModelRuntimeSystem({ store, providers, dataDirectory: root, ownerId: "node-owner", ownerGeneration: 1,
    fetchStreaming: streaming, onProviderChanged: changed });
  return { root, database, store, credentials, providers, system, streaming, changed };
}
describe("node-owned managed model runtime composition", () => {
  it("serves a stopped disk model through authenticated generated HTTP, saves related context and deletes the connection without its files", async () => {
    const f = await fixture(), selection = { repository: "bartowski/Qwen3.8-Flash-Next-GGUF", file: "Model-Q4.gguf" }, id = llamaCppModelId(selection);
    const bytes = Buffer.from("GGUF"), modelDirectory = join(f.root, "managed-model-runtime", "llama-cpp", "llamacpp-runtime", "models", id);
    await mkdir(modelDirectory, { recursive: true });
    await writeFile(join(modelDirectory, selection.file), bytes);
    await writeFile(join(modelDirectory, "model.json"), JSON.stringify({ format: 1, ...selection, id, revision: "a".repeat(40), sizeBytes: bytes.length,
      shards: [{ name: selection.file, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] }));
    const connections = new ConnectionManager(f.store), challenge = connections.issuePairing("Local model reader");
    const paired = connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Local model reader" });
    const artifacts = new ArtifactStore({ rootDirectory: join(f.root, "artifacts"), repository: new OperationalArtifactRepository(f.store), ingestRoots: [f.root] });
    await artifacts.initialize();
    const host = new SessionHost(f.store, artifacts, []); await host.initialize();
    const server = await createPublicServer({ config: { publicOrigin: "http://127.0.0.1", allowInsecureLoopback: true, allowInsecureLan: false,
      corsOrigins: [], webDirectory: join(f.root, "no-web"), dataDirectory: f.root }, store: f.store, connections, providers: f.providers,
      artifacts: {}, blobTransfers: {}, artifactRepository: {}, workspaces: {}, workspaceChanges: {}, scheduler: {}, adapters: [], browserActivity: [],
      sessionHost: host, managedModelRuntime: f.system.registry, removeManagedModelProvider: (providerId: string) => f.system.removeProvider(providerId),
      refreshBackendDescriptor: async () => undefined, refreshPiGeneration: async () => undefined } as unknown as OrchestratorApplication);
    server.log.level = "silent";
    try {
      const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
      const transport = createConnectTransport({ baseUrl, httpVersion: "1.1", interceptors: [next => request => {
        request.header.set("authorization", `Bearer ${paired.authKey}`); return next(request);
      }] });
      const client = createClient(contract.ManagedModelRuntimeService, transport);
      const unconnected = await client.getManagedModelRuntime({ runtimeId: "llama-cpp" });
      expect(unconnected.runtime?.installedModels).toMatchObject([{ modelName: id, repositoryModel: selection }]);
      expect(unconnected.runtime?.providerRoutes).toEqual([]); expect(f.providers.listConfigurations()).toEqual([]);
      const added = await client.ensureManagedModelRuntimeProvider({ runtimeId: "llama-cpp" });
      expect(added.runtime?.providerRoutes).toHaveLength(3);
      expect(added.runtime?.capabilities).toMatchObject({ supportsRepositoryModels: true, canDeleteModels: false,
        startupPolicy: contract.ManagedModelRuntimeStartupPolicy.ON_USE });
      const targets = added.runtime!.providerRoutes.map(route => ({ backendId: route.backendId, providerId: route.providerId, modelId: id, repositoryModel: selection }));
      const saved = await client.setManagedModelContext({ runtimeId: "llama-cpp", target: targets[0], relatedTargets: [targets[1]!], contextWindowTokens: 1_000_000n });
      expect(saved.context).toMatchObject({ effectiveContextWindowTokens: 1_000_000n, pendingApply: false, mixed: false });
      expect(f.providers.listConfigurations()[0]?.runtimes.map(runtime => runtime.provider.models[0]?.contextWindow)).toEqual([1_000_000, 1_000_000, 262144]);
      await expect(createClient(contract.ManagedModelRuntimeService, createConnectTransport({ baseUrl, httpVersion: "1.1" }))
        .getManagedModelRuntime({ runtimeId: "llama-cpp" })).rejects.toMatchObject({ code: Code.Unauthenticated });
      const operations = createClient(contract.OperationService, transport);
      const submitted = await operations.submitOperation({ operationId: "remove-local-model-provider", connectionId: paired.connection.id,
        mutation: { payload: { case: "deleteProvider", value: { providerId: MANAGED_GGUF_PROVIDER_ID } } } });
      await vi.waitFor(async () => expect((await operations.getOperation({ operationId: submitted.operation!.operationId })).operation?.state).toBe(contract.OperationState.SUCCEEDED));
      expect((await client.getManagedModelRuntime({ runtimeId: "llama-cpp" })).runtime?.providerRoutes).toEqual([]);
      expect(f.providers.listConfigurations()).toEqual([]); expect(await readFile(join(modelDirectory, selection.file))).toEqual(bytes);
      expect(f.streaming).not.toHaveBeenCalled();
    } finally { await server.close(); await host.dispose(); await f.system.close(); f.store.close(); }
    const reopenedStore = new OperationalStore(f.database);
    try {
      const reopenedProviders = new ProviderCatalogManager({ store: reopenedStore, credentials: f.credentials, nativeBackendId: "backend-a" }); reopenedProviders.initialize();
      const reopenedSystem = await createManagedModelRuntimeSystem({ store: reopenedStore, providers: reopenedProviders, dataDirectory: f.root,
        ownerId: "node-owner", ownerGeneration: 2, fetchStreaming: f.streaming });
      try {
        const state = await reopenedSystem.registry.get("llama-cpp")!.snapshot();
        expect(state.installedModels.map(model => model.name)).toEqual([id]); expect(state.providerRoutes).toEqual([]);
        expect(reopenedProviders.listConfigurations()).toEqual([]);
      } finally { await reopenedSystem.close(); }
    } finally { reopenedStore.close(); }
  });
  it("skips local on-use startup for remote Workspaces and unrelated Providers, and rejects a removed local connection", async () => {
    const f = await fixture(); try {
      const signal = new AbortController().signal;
      await f.system.prepareProviderRuntime({ signal, target: { backendId: "backend-a", remoteWorkspace: { kind: "ssh" } },
        modelSelection: { providerId: MANAGED_GGUF_PROVIDER_ID, modelId: "missing" } } as unknown as AdapterContext);
      await f.system.prepareProviderRuntime({ signal, target: { backendId: "backend-a" }, modelSelection: { providerId: "ordinary", modelId: "missing" } } as unknown as AdapterContext);
      await expect(f.system.prepareProviderRuntime({ signal, target: { backendId: "backend-a" },
        modelSelection: { providerId: MANAGED_GGUF_PROVIDER_ID, modelId: "missing" } } as unknown as AdapterContext)).rejects.toMatchObject({ code: "RUNTIME_ERROR" });
      expect(f.streaming).not.toHaveBeenCalled(); expect(f.providers.listConfigurations()).toEqual([]);
    } finally { await f.system.close(); f.store.close(); }
  });
});
