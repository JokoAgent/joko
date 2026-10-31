import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient, Code } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "./test-paths.js";
import { CredentialManager, ProviderCatalogManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { ConnectionManager } from "./connection-manager.js";
import { SessionHost } from "./session-host.js";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { composeModelWorkingContext } from "./model-working-context-system.js";
import type { ModelWorkingContextCoordinator } from "./model-working-context.js";
import { SessionContextBudgetCoordinator } from "./session-context-budget.js";
import { createPublicServer } from "./server.js";
import type { OrchestratorApplication } from "./application.js";

const targets = ["route-a", "route-b", "route-c"].map((backendId, index) => ({
  backendId, providerId: "native-provider", modelId: `model-${index}`
}));
const capacities = [32_000, 64_000, 128_000];

async function openNode(root: string, generation: number) {
  const store = new OperationalStore(join(root, "node.db"));
  const credentials = new CredentialManager({ vault: await CredentialVault.open(join(root, "vault.key")), storagePath: join(root, "credentials.json") });
  await credentials.initialize();
  const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: targets[0]!.backendId });
  providers.initialize();
  const adapters = targets.map((target, index) => new FakeBackendAdapter({
    ...PI_LIKE_PROFILE, id: target.backendId,
    capabilities: [...PI_LIKE_PROFILE.capabilities, { key: "model.working_context", supported: true }],
    models: [{ ...PI_LIKE_PROFILE.models[0]!, providerId: target.providerId, modelId: target.modelId, contextWindow: capacities[index]! }]
  }));
  for (const adapter of adapters) {
    if (!store.listBackends().some(item => item.descriptor.id === adapter.id)) store.upsertBackend(await adapter.describe());
  }
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
  await artifacts.initialize();
  let contexts: ModelWorkingContextCoordinator | undefined, budgets: SessionContextBudgetCoordinator | undefined;
  const host = new SessionHost(store, artifacts, adapters, { resolveModelWorkingContext: target => target.sessionId && budgets ? budgets.resolve(target.sessionId, target) : contexts?.resolve(target) }); await host.initialize();
  let active = true;
  contexts = composeModelWorkingContext({ store, providers, sessionHost: host,
    currentOwner: () => active ? { ownerId: "node-context-owner", generation } : undefined });
  budgets = new SessionContextBudgetCoordinator(store, contexts, (sessionId, target, check) => host.refreshModelWorkingContexts([target], check, undefined, sessionId), () => false);
  const connections = new ConnectionManager(store), challenge = connections.issuePairing("Model settings observer");
  const paired = connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Model settings observer" });
  const server = await createPublicServer({
    config: { publicOrigin: "http://127.0.0.1", allowInsecureLoopback: true, allowInsecureLan: false,
      corsOrigins: [], webDirectory: join(root, "no-web"), dataDirectory: root },
    store, connections, providers, sessionHost: host, artifacts: {}, blobTransfers: {}, artifactRepository: {},
    workspaces: {}, workspaceChanges: {}, scheduler: {}, adapters, browserActivity: [], modelWorkingContext: contexts, sessionContextBudget: budgets
  } as unknown as OrchestratorApplication);
  server.log.level = "silent";
  const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  const transport = createConnectTransport({ baseUrl, httpVersion: "1.1",
    interceptors: [next => request => { request.header.set("authorization", `Bearer ${paired.authKey}`); return next(request); }] });
  const client = createClient(contract.BackendService, transport), operations = createClient(contract.OperationService, transport);
  return { store, contexts, budgets, host, adapters, paired, operations, client, baseUrl, async close() { active = false; await server.close(); await host.dispose(); store.close(); } };
}

describe("node model working-context composition", () => {
  it("saves and replays a task budget through its Operation, dispatches that budget and restores it from SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-task-context-node-")); let node = await openNode(root, 1);
    let sessionId = "", generation = 0;
    try {
      await node.host.registerTarget({ id: "task-budget-target", backendId: targets[0]!.backendId, displayName: "Target", workspaceRoot: root, managed: false, trusted: true });
      sessionId = (await node.host.createSession({ operationId: "create-budget-task", connection: node.paired.connection,
        targetId: "task-budget-target", title: "Budget task", providerId: targets[0]!.providerId, modelId: targets[0]!.modelId, permissionMode: "ask", planMode: false, fastMode: false })).value.sessionId;
      generation = node.store.getSession(sessionId).descriptor.binding.generation;
      const view = (await node.client.getSessionContextBudget({ sessionId, generation: BigInt(generation) })).budget!;
      const request = { operationId: "save-task-budget", connectionId: node.paired.connection.id, mutation: { payload: { case: "setSessionContextBudget" as const, value: {
        sessionId, generation: BigInt(generation), budgetTokens: 16_000n, expectedRevision: view.revision, expectedSourceRevision: view.sourceRevision } } } };
      expect((await node.operations.submitOperation(request)).operation?.state).toBe(contract.OperationState.SUCCEEDED);
      const saved = (await node.client.getSessionContextBudget({ sessionId, generation: BigInt(generation) })).budget!;
      expect(saved).toMatchObject({ budgetTokens: 16_000n, effectiveWindowTokens: 16_000n });
      expect((await node.operations.submitOperation(request)).operation?.state).toBe(contract.OperationState.SUCCEEDED);
      expect((await node.client.getSessionContextBudget({ sessionId, generation: BigInt(generation) })).budget?.revision).toEqual(saved.revision);
      const send = vi.spyOn(node.adapters[0]!, "send"), queued = node.host.enqueueInput({ operationId: "budget-dispatch", connection: node.paired.connection, sessionId,
        prompt: { text: "Read the configured window", disposition: "prompt", images: [], files: [], mentions: [] } });
      await vi.waitFor(() => expect(node.store.getRun(queued.value.runId).descriptor.state).toBe("completed"));
      expect(send.mock.calls[0]?.[1].resolveModelWorkingContext?.({ providerId: targets[0]!.providerId, modelId: targets[0]!.modelId })).toBe(16_000);
    } finally { await node.close(); }
    node = await openNode(root, 2);
    try {
      const view = (await node.client.getSessionContextBudget({ sessionId, generation: BigInt(generation) })).budget!;
      expect(view).toMatchObject({ budgetTokens: 16_000n, effectiveWindowTokens: 16_000n });
      const reset = await node.operations.submitOperation({ operationId: "reset-task-budget", connectionId: node.paired.connection.id,
        mutation: { payload: { case: "setSessionContextBudget", value: { sessionId, generation: BigInt(generation), expectedRevision: view.revision, expectedSourceRevision: view.sourceRevision } } } });
      expect(reset.operation?.state).toBe(contract.OperationState.SUCCEEDED);
      expect((await node.client.getSessionContextBudget({ sessionId, generation: BigInt(generation) })).budget?.budgetTokens).toBeUndefined();
    } finally { await node.close(); }
  });
  it("saves related route budgets through authenticated generated HTTP and reopens SQLite before resetting overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-model-context-node-"));
    let node = await openNode(root, 1);
    try {
      const initial = await node.client.getModelWorkingContext({ target: targets[0], relatedTargets: [targets[1]!] });
      expect(initial.context).toMatchObject({ customized: false, mixed: false, canConfigure: true,
        defaultContextWindowTokens: 32_000n, effectiveContextWindowTokens: 32_000n });
      const saved = await node.client.setModelWorkingContext({ operationId: "save-route-budgets", target: targets[0], relatedTargets: [targets[1]!],
        contextWindowTokens: 256_000n, expectedRevision: initial.context!.revision, expectedSourceRevision: initial.context!.sourceRevision });
      expect(saved.context).toMatchObject({ limitTokens: 256_000n, customized: true, mixed: false, effectiveContextWindowTokens: 256_000n });
      const mixed = await node.client.getModelWorkingContext({ target: targets[0], relatedTargets: [targets[1]!, targets[2]!] });
      expect(mixed.context?.mixed).toBe(true);
      expect(targets.map(target => node.store.getBackend(target.backendId).descriptor.models[0]?.contextWindow)).toEqual(capacities);
      await expect(node.client.setModelWorkingContext({ operationId: "stale-route-edit", target: targets[0], relatedTargets: [targets[1]!],
        contextWindowTokens: 48_000n, expectedRevision: initial.context!.revision, expectedSourceRevision: initial.context!.sourceRevision }))
        .rejects.toMatchObject({ code: Code.Aborted });
      await expect(createClient(contract.BackendService, createConnectTransport({ baseUrl: node.baseUrl, httpVersion: "1.1" }))
        .getModelWorkingContext({ target: targets[0] })).rejects.toMatchObject({ code: Code.Unauthenticated });
    } finally { await node.close(); }
    node = await openNode(root, 2);
    try {
      const restored = await node.client.getModelWorkingContext({ target: targets[0], relatedTargets: [targets[1]!] });
      expect(restored.context).toMatchObject({ limitTokens: 256_000n, customized: true, effectiveContextWindowTokens: 256_000n });
      const reset = await node.client.resetModelWorkingContext({ operationId: "reset-route-budgets", target: targets[0], relatedTargets: [targets[1]!],
        expectedRevision: restored.context!.revision, expectedSourceRevision: restored.context!.sourceRevision });
      expect(reset.context).toMatchObject({ customized: false, mixed: false, effectiveContextWindowTokens: 32_000n });
      expect(reset.context?.limitTokens).toBeUndefined();
      expect(targets.map(target => node.contexts.resolve(target))).toEqual(capacities);
      expect(targets.map(target => node.store.getBackend(target.backendId).descriptor.models[0]?.contextWindow)).toEqual(capacities);
    } finally { await node.close(); }
  });
});
