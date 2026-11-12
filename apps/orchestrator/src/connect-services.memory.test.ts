import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { ClaudeCodeAdapter } from "@joko/adapter-claude-code";
import * as contract from "@joko/contracts";
import {
  JokoError,
  MEMORY_NATIVE_DEFAULT_DISABLED_OPTION,
  MEMORY_NATIVE_LIVE_LOCAL_OPTION,
  MEMORY_NATIVE_RESET_LOCAL_OPTION,
  type BackendAdapter
} from "@joko/core";
import { OperationalStore, operationBodyHash, type OperationRecord } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import type { AuxiliaryTextRouting } from "./auxiliary-text-routing.js";
import { createConnectServices } from "./connect-services.js";
import { ConnectionManager, digestAuthKey } from "./connection-manager.js";
import { CredentialManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { DeferredBackendRestartCoordinator } from "./deferred-backend-restart.js";
import { MAKER_MEMORY_PROVIDER_ID, MakerMemoryBridgeProvider, MakerMemoryController } from "./maker-memory.js";
import { McpRouter } from "./mcp-router.js";
import { SessionHost } from "./session-host.js";

const owner = {
  id: "memory-owner",
  name: "Memory owner",
  authKeyDigest: "digest",
  state: "active" as const,
  pairedAt: 1,
  revision: 1n
};

describe("Connect Maker Memory owner and reset scopes", () => {
  it("binds native Codex memory review approval and replay to its original queue operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-memory-review-"));
    const store = new OperationalStore(join(root, "orchestrator.db"));
    const host = new SessionHost(store, {} as never, []);
    const memory = new MakerMemoryController({ store });
    const vault = await CredentialVault.open(join(root, "vault.key"));
    const credentials = new CredentialManager({ vault, storagePath: join(root, "credentials.json") });
    const router = new McpRouter({ store, credentials });
    try {
      await credentials.initialize();
      await router.initialize();
      const plan = { models: [], revision: 0n, runtimeRevision: "memory-review-fixture" };
      const run = vi.fn<AuxiliaryTextRouting["run"]>(async () => ({ status: "ok", text: "Review the release checklist." }));
      router.registerBridgeToolProvider(new MakerMemoryBridgeProvider(memory, {
        auxiliary: () => ({ capture: () => plan, isCurrent: value => value === plan, run }), redact: value => value
      }));
      router.setNativeToolAdmission((...args) => host.authorizeNativeBridgeTool(...args));

      const connection = store.createConnection({ id: owner.id, name: owner.name, authKeyDigest: owner.authKeyDigest });
      const backendId = "memory-codex", targetId = "memory-workspace", sessionId = "memory-task";
      store.upsertBackend({ id: backendId, displayName: "Codex", adapterKind: "codex", version: "test", instanceGeneration: 1,
        health: "healthy", installationState: "installed", authenticationState: "not_required", capabilities: new Map(),
        models: [], tools: [], diagnostics: [] });
      store.upsertTarget({ id: targetId, backendId, displayName: "Workspace", workspaceRoot: root, trusted: true, managed: false });
      store.createSession({ id: sessionId, backendId, targetId, title: "Memory task", binding: { opaqueRef: "memory-native", generation: 1 },
        pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
      memory.write(targetId, { kind: "project", name: "release", title: "Release checklist", description: "Project decisions", body: "Keep the release checklist current." });
      const bridge = router.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1:4318/internal/mcp", sessionId, targetId, expectedPiGeneration: 1 });
      expect(bridge.mcpBridge.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "memory_review", requiresPermission: true }),
        expect.objectContaining({ name: "memory_consolidate", requiresPermission: true })
      ]));
      const review = () => router.executeBridgeCall({ authorization: `Bearer ${bridge.mcpBridge.token}`, requestId: "memory-native-review",
        sessionId, targetId, generation: 1, serverId: MAKER_MEMORY_PROVIDER_ID, toolName: "memory_review", arguments: {} });
      await expect(review()).rejects.toThrow(/current authorized task input/u);
      const runId = "memory-run", attemptId = "memory-attempt", operationId = "memory-send-input", queueItemId = "memory-queue";
      const body = { text: "Review workspace memory", images: [], files: [], mentions: [], disposition: "prompt" } as const;
      store.runOperation({ id: operationId, connectionId: connection.id, kind: "sendInput", body }, transaction => {
        transaction.createRun({ id: runId, sessionId, source: "user", state: "queued", createdAt: 1 });
        transaction.createAttempt({ id: attemptId, runId, ordinal: 1, generation: 1, startedAt: 1 });
        transaction.enqueueQueueItem({ id: queueItemId, sessionId, runId, attemptId, operationId, body, disposition: "prompt" });
        return {};
      });
      expect(store.claimNextQueueItem({ sessionId, backendInstanceGeneration: 1 })?.id).toBe(queueItemId);

      const pending = review();
      void pending.catch(() => {});
      const interaction = await vi.waitFor(() => {
        const opened = store.listInteractions({ sessionId, status: "open" });
        expect(opened).toHaveLength(1);
        return opened[0]!;
      }, { timeout: 5_000 });
      expect(interaction).toMatchObject({ runId, attemptId, payload: { kind: "permission", toolName: "joko_memory/memory_review" } });
      const original = store.listOperations().find(operation => operation.kind === "memory_review")!;
      expect(original).toMatchObject({ status: "started", body: { sourceOperationId: operationId, queueItemId, runId, attemptId, targetId } });
      await expect(review()).resolves.toMatchObject({ isError: true, error: expect.stringContaining(original.id) });
      expect(run).not.toHaveBeenCalled();
      host.resolveInteraction(interaction.id, interaction.generation, { kind: "permission", decision: "allow_once" }, "allow-memory-review");

      const reply = await pending;
      expect(reply).toMatchObject({ isError: false, details: { mcpStructuredContent: {
        suggestions: "Review the release checklist.", operation_id: original.id
      } } });
      await expect(review()).resolves.toEqual(reply);
      expect(run).toHaveBeenCalledOnce();
      expect(store.listInteractions({ sessionId })).toHaveLength(1);
      expect(store.getOperation(original.id)).toMatchObject({ status: "completed", response: { suggestions: "Review the release checklist." } });
      store.revokeConnection(connection.id);
      await expect(review()).rejects.toThrow(/invalid or revoked/u);
      expect(run).toHaveBeenCalledOnce();
    } finally {
      await router.dispose();
      await host.dispose();
      memory.dispose();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps two existing curated memory grants when the owner turns off only Pi digests", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-memory-digest-preference-"));
    const store = new OperationalStore(join(root, "orchestrator.db"));
    const host = new SessionHost(store, {} as never, []);
    const refresh = vi.fn(async () => undefined);
    const memory = new MakerMemoryController({ store, onSettingsChanged: refresh });
    const vault = await CredentialVault.open(join(root, "vault.key"));
    const credentials = new CredentialManager({ vault, storagePath: join(root, "credentials.json") });
    const router = new McpRouter({ store, credentials });
    try {
      await credentials.initialize();
      await router.initialize();
      router.registerBridgeToolProvider(new MakerMemoryBridgeProvider(memory));
      const connection = store.createConnection({ id: owner.id, name: owner.name, authKeyDigest: owner.authKeyDigest });
      store.upsertBackend({
        id: "pi", displayName: "Pi", version: "test", adapterKind: "pi", instanceGeneration: 1,
        health: "healthy", installationState: "installed", authenticationState: "not_required",
        capabilities: new Map([["memory.compaction_digest", { key: "memory.compaction_digest", supported: true }]]),
        models: [], tools: [], diagnostics: []
      });
      const targetId = "memory-workspace";
      store.upsertTarget({ id: targetId, backendId: "pi", displayName: "Workspace", workspaceRoot: root, trusted: true, managed: false });
      const entry = memory.write(targetId, { kind: "project", name: "report-style", title: "Report style", description: "Stable preference", body: "Keep reports concise." });
      const readers = ["first", "second"].map(sessionId => {
        store.createSession({ id: sessionId, backendId: "pi", targetId, title: sessionId, binding: { opaqueRef: sessionId, generation: 1 },
          pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
        const bridge = router.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1:4318/internal/mcp", sessionId, targetId, expectedPiGeneration: 1 });
        return () => router.executeBridgeCall({ authorization: `Bearer ${bridge.mcpBridge.token}`, requestId: randomUUID(), sessionId, targetId,
          generation: 1, serverId: MAKER_MEMORY_PROVIDER_ID, toolName: "memory_read", arguments: { entry_id: entry.id } });
      });
      const readOriginal = async (): Promise<void> => {
        for (const read of readers) await expect(read()).resolves.toMatchObject({ isError: false,
          details: { mcpStructuredContent: { entry: { id: entry.id, body: entry.body } } } });
      };
      await readOriginal();
      const services = createConnectServices(stubApplication({ store, makerMemory: memory, sessionHost: host, connections: { authenticate: () => connection } }));
      await submitMemoryUpdate(services.operation.submitOperation, { operationId: "disable-pi-digests", connectionId: connection.id, backendId: "pi", backendEnabled: false });
      expect(memory.enabledForBackend("pi")).toBe(false);
      expect(refresh).toHaveBeenCalledOnce();
      await readOriginal();

      await submitMemoryUpdate(services.operation.submitOperation, { operationId: "disable-maker", connectionId: connection.id, makerEnabled: false });
      for (const read of readers) await expect(read()).resolves.toMatchObject({ isError: true });
    } finally {
      await router.dispose();
      await host.dispose();
      memory.dispose();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears ordinary curated memory and digests while retaining Partner Home memory across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-scoped-memory-reset-"));
    const database = join(root, "orchestrator.db");
    let store = new OperationalStore(database);
    let memory = new MakerMemoryController({ store });
    let host = new SessionHost(store, {} as never, []);
    const backendId = "pi";
    const writeCurated = (targetId: string) => memory.write(targetId, {
      kind: "project", name: "preference", title: "Preference", description: "Stable preference",
      body: "Keep reports concise."
    });
    const submit = (operationId: string, scope: contract.MemoryResetScope, resetBackendId?: string) => {
      const services = createConnectServices(stubApplication({
        store, makerMemory: memory, sessionHost: host,
        connections: { authenticate: () => store.getConnection(owner.id) }
      }));
      return submitReset<contract.SubmitOperationResponse>(services.operation.submitOperation, {
        operationId, connectionId: owner.id, scope, ...(resetBackendId === undefined ? {} : { backendId: resetBackendId })
      });
    };

    try {
      store.createConnection({ id: owner.id, name: owner.name, authKeyDigest: owner.authKeyDigest });
      store.upsertBackend({
        id: backendId, displayName: "Pi", version: "test", adapterKind: "pi", instanceGeneration: 1,
        health: "healthy", installationState: "installed", authenticationState: "not_required",
        capabilities: new Map([["memory.compaction_digest", { key: "memory.compaction_digest", supported: true }]]),
        models: [], tools: [], diagnostics: []
      });
      for (const targetId of ["workspace", "partner-home"]) {
        const partnerHome = targetId === "partner-home";
        store.upsertTarget({ id: targetId, backendId, displayName: targetId, workspaceRoot: join(root, targetId),
          trusted: true, managed: partnerHome }, partnerHome ? { kind: "partner_home", partnerId: "partner" } : {});
        writeCurated(targetId);
        expect(memory.writeCompactionDigest({
          backendId, targetId, sessionId: `session-${targetId}`, reason: "auto", summary: "Compassneedle stays aligned."
        })).toBe(true);
      }
      const partnerCurated = memory.search("partner-home", "concise", "project")[0]!;
      const partnerDigest = memory.search("partner-home", "Compassneedle", "digest")[0]!;

      const curated = await submit("clear-curated", contract.MemoryResetScope.CURATED);
      expect(curated.operation?.result?.payload).toMatchObject({
        case: "memoryReset", value: { removedEntries: 1n, removedTargets: 1n }
      });
      expect(memory.search("workspace", "concise")).toEqual([]);
      expect(memory.search("workspace", "Compassneedle", "digest")).toHaveLength(1);
      const digests = await submit("clear-digests", contract.MemoryResetScope.BACKEND, backendId);
      expect(digests.operation?.result?.payload).toMatchObject({
        case: "memoryReset", value: { removedEntries: 1n, removedTargets: 1n }
      });
      expect(memory.search("workspace", "Compassneedle", "digest")).toEqual([]);

      await host.dispose();
      memory.dispose();
      store.close();
      store = new OperationalStore(database);
      memory = new MakerMemoryController({ store });
      host = new SessionHost(store, {} as never, []);
      const bridge = new MakerMemoryBridgeProvider(memory);
      const context = { targetId: "partner-home", sessionId: "session-partner-home", generation: 1 };
      for (const [entry, query] of [[partnerCurated, "concise"], [partnerDigest, "Compassneedle"]] as const) {
        await expect(bridge.callTool("memory_search", { query }, undefined, context)).resolves.toMatchObject({
          structuredContent: { hits: [expect.objectContaining({ id: entry.id })] }
        });
        await expect(bridge.callTool("memory_read", { entry_id: entry.id }, undefined, context)).resolves.toMatchObject({
          structuredContent: { entry: { id: entry.id, type: entry.kind } }
        });
      }
      const lateEntry = writeCurated("workspace");
      const replay = await submit("clear-curated", contract.MemoryResetScope.CURATED);
      expect(replay.operation?.result?.payload).toEqual(curated.operation?.result?.payload);
      expect(memory.read("workspace", lateEntry.id)).toEqual(lateEntry);
    } finally {
      await host.dispose();
      memory.dispose();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("authenticates the owner and treats Backend scope as a capability, not a Pi ID", async () => {
    const reset = vi.fn((scope: "curated" | "backend", backendId?: string) =>
      scope === "curated"
        ? { removedEntries: 7, removedTargets: 3 }
        : { removedEntries: backendId === "memory-capable" ? 2 : 0, removedTargets: 1 });
    const store = {
      findOperation: () => undefined,
      getBackend: (backendId: string) => ({ descriptor: backendId === "native-memory"
        ? {
            id: backendId,
            capabilities: new Map([["memory.native", { key: "memory.native", supported: true }]])
          }
        : {
            id: backendId,
            capabilities: new Map([["memory.compaction_digest", {
              key: "memory.compaction_digest",
              supported: backendId === "memory-capable"
            }]])
          } })
    };
    const services = createConnectServices(stubApplication({
      store,
      makerMemory: { reset },
      sessionHost: immediateHost(store)
    }));

    await expect(submitReset(services.operation.submitOperation, {
      operationId: "memory-wrong-owner",
      connectionId: "different-owner",
      scope: contract.MemoryResetScope.CURATED
    })).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(reset).not.toHaveBeenCalled();

    const curated = await submitReset<contract.SubmitOperationResponse>(services.operation.submitOperation, {
      operationId: "memory-reset-curated",
      connectionId: owner.id,
      scope: contract.MemoryResetScope.CURATED
    });
    expect(curated.operation?.result?.payload).toMatchObject({
      case: "memoryReset",
      value: { removedEntries: 7n, removedTargets: 3n }
    });
    expect(reset).toHaveBeenLastCalledWith("curated");

    const backend = await submitReset<contract.SubmitOperationResponse>(services.operation.submitOperation, {
      operationId: "memory-reset-capable-backend",
      connectionId: owner.id,
      scope: contract.MemoryResetScope.BACKEND,
      backendId: "memory-capable"
    });
    expect(backend.operation?.result?.payload).toMatchObject({
      case: "memoryReset",
      value: { removedEntries: 2n, removedTargets: 1n }
    });
    expect(reset).toHaveBeenLastCalledWith("backend", "memory-capable");

    await expect(submitReset(services.operation.submitOperation, {
      operationId: "memory-reset-pi-without-capability",
      connectionId: owner.id,
      scope: contract.MemoryResetScope.BACKEND,
      backendId: "pi"
    })).rejects.toMatchObject({ code: Code.FailedPrecondition });
    await expect(submitReset(services.operation.submitOperation, {
      operationId: "memory-reset-native-without-owner",
      connectionId: owner.id,
      scope: contract.MemoryResetScope.BACKEND,
      backendId: "native-memory"
    })).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it("clears ordinary local curated memory and digests in one receipt that an existing tool grant can observe", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-ordinary-memory-reset-"));
    const store = new OperationalStore(join(root, "orchestrator.db"));
    const memory = new MakerMemoryController({ store });
    const host = new SessionHost(store, {} as never, []);
    const vault = await CredentialVault.open(join(root, "vault.key"));
    const credentials = new CredentialManager({ vault, storagePath: join(root, "credentials.json") });
    const router = new McpRouter({ store, credentials });
    try {
      await credentials.initialize(); await router.initialize();
      router.registerBridgeToolProvider(new MakerMemoryBridgeProvider(memory));
      const connection = store.createConnection({ id: owner.id, name: owner.name, authKeyDigest: owner.authKeyDigest });
      const backendId = "pi", targetId = "ordinary-workspace", sessionId = "ordinary-session";
      store.upsertBackend({ id: backendId, displayName: "Pi", adapterKind: "pi", version: "test", instanceGeneration: 1,
        health: "healthy", installationState: "installed", authenticationState: "not_required", capabilities: new Map(),
        models: [], tools: [], diagnostics: [] });
      const protectedTargets = ["partner-home", "partner-task", "ssh-workspace"];
      const put = (id: string) => memory.write(id, { kind: "project", name: "preference", title: "Preference",
        description: "Stored preference", body: "Compassneedle stays aligned." });
      for (const id of [targetId, ...protectedTargets]) {
        const remoteWorkspace = id === "ssh-workspace" ? { kind: "ssh" as const, hostTargetId: id, hostId: "ssh-host", workspaceRoot: "/workspace" } : undefined;
        const metadata = id === "partner-home" ? { kind: "partner_home" } : id === "partner-task" ? { kind: "partner_session_task", partnerId: "partner" } : {};
        store.upsertTarget({ id, backendId, displayName: id, trusted: true, managed: false,
          workspaceRoot: remoteWorkspace?.workspaceRoot ?? root, ...(remoteWorkspace === undefined ? {} : { remoteWorkspace }) }, metadata);
        put(id);
        expect(memory.writeCompactionDigest({ backendId, targetId: id, sessionId, reason: "auto", summary: "Compassneedle summary." })).toBe(true);
      }
      store.createSession({ id: sessionId, backendId, targetId, title: "Memory reader", binding: { opaqueRef: sessionId, generation: 1 },
        pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
      const bridge = router.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1:4318/internal/mcp", sessionId, targetId, expectedPiGeneration: 1 });
      const list = () => router.executeBridgeCall({ authorization: `Bearer ${bridge.mcpBridge.token}`, requestId: randomUUID(), sessionId, targetId,
        generation: 1, serverId: MAKER_MEMORY_PROVIDER_ID, toolName: "memory_list", arguments: {} });
      expect((await list()).details?.mcpStructuredContent).toMatchObject({ entries: [expect.any(Object), expect.any(Object)] });

      const services = createConnectServices(stubApplication({ store, makerMemory: memory, sessionHost: host, connections: { authenticate: () => connection } }));
      const submit = () => submitReset<contract.SubmitOperationResponse>(services.operation.submitOperation, {
        operationId: "clear-local-memory", connectionId: connection.id, scope: contract.MemoryResetScope.ORDINARY_LOCAL_WORKSPACES
      });
      const result = await submit();
      expect(result.operation?.result?.payload).toMatchObject({ case: "memoryReset", value: { removedEntries: 2n, removedTargets: 1n } });
      expect((await list()).details?.mcpStructuredContent).toMatchObject({ entries: [] });
      expect(memory.search(targetId, "Compassneedle")).toEqual([]);
      for (const id of protectedTargets) expect(memory.search(id, "Compassneedle")).toHaveLength(2);
      const late = put(targetId);
      expect((await submit()).operation?.result?.payload).toEqual(result.operation?.result?.payload);
      expect(memory.read(targetId, late.id)).toEqual(late);
    } finally {
      await router.dispose(); await host.dispose(); memory.dispose(); store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a stale native-memory toggle while Maker Memory is enabled and accepts an atomic switch", async () => {
    let current = { format: 1 as const, makerEnabled: true, backendEnabled: {} as Readonly<Record<string, boolean>> };
    const setSetting = vi.fn((_scope: string, _scopeId: string, _key: string, value: typeof current) => { current = value; });
    const reconcileSettingsChange = vi.fn(async () => true);
    const patchedSettings = vi.fn((patch: {
      readonly makerEnabled?: boolean;
      readonly backendId?: string;
      readonly backendEnabled?: boolean;
    }) => ({
      format: 1 as const,
      makerEnabled: patch.makerEnabled ?? current.makerEnabled,
      backendEnabled: patch.backendEnabled === undefined
        ? current.backendEnabled
        : { ...current.backendEnabled, [patch.backendId!]: patch.backendEnabled }
    }));
    const descriptor = {
      id: "native-memory",
      capabilities: new Map([["memory.native", {
        key: "memory.native",
        supported: true,
        options: [MEMORY_NATIVE_LIVE_LOCAL_OPTION, MEMORY_NATIVE_DEFAULT_DISABLED_OPTION]
      }]])
    };
    const store = {
      findOperation: () => undefined,
      setSetting,
      getBackend: () => ({ descriptor }),
      listBackends: () => [{ descriptor }],
      appendDiagnostic: vi.fn()
    };
    const reconcileNativeMemory = vi.fn(async () => "immediate" as const);
    const services = createConnectServices(stubApplication({
      store,
      makerMemory: { patchedSettings, reconcileSettingsChange },
      sessionHost: immediateHost(store, { id: descriptor.id, reconcileNativeMemory } as unknown as BackendAdapter)
    }));

    await expect(submitMemoryUpdate(services.operation.submitOperation, {
      operationId: "memory-native-stale-toggle",
      connectionId: owner.id,
      backendId: "native-memory",
      backendEnabled: false
    })).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(setSetting).not.toHaveBeenCalled();
    expect(reconcileSettingsChange).not.toHaveBeenCalled();

    await submitMemoryUpdate(services.operation.submitOperation, {
      operationId: "memory-native-atomic-switch",
      connectionId: owner.id,
      makerEnabled: false,
      backendId: "native-memory",
      backendEnabled: false
    });
    expect(setSetting).toHaveBeenCalledWith("service", "orchestrator", "settings.memory", {
      format: 1,
      makerEnabled: false,
      backendEnabled: { "native-memory": false }
    });
    expect(reconcileSettingsChange).toHaveBeenCalledOnce();
    expect(reconcileNativeMemory).toHaveBeenCalledOnce();
    expect(store.appendDiagnostic).not.toHaveBeenCalled();
  });

  it("claims native reset before the current Adapter effect and preserves unknown native counts", async () => {
    const resetCuratedMemory = vi.fn();
    const resetNativeMemory = vi.fn(async () => ({}));
    const descriptor = {
      id: "codex-memory",
      capabilities: new Map([["memory.native", {
        key: "memory.native",
        supported: true,
        options: [MEMORY_NATIVE_LIVE_LOCAL_OPTION, MEMORY_NATIVE_DEFAULT_DISABLED_OPTION, MEMORY_NATIVE_RESET_LOCAL_OPTION]
      }]])
    };
    const store = {
      findOperation: () => undefined,
      findSetting: () => undefined,
      getBackend: () => ({ descriptor }),
      listBackends: () => [{ descriptor, revision: 1n, updatedAt: 1 }],
      listConnections: () => [],
      listTargets: () => [],
      health: () => ({ revision: 1n }),
      messageEmbeddingStatus: () => ({
        vectorAvailable: false,
        modelId: "",
        pendingCount: 0,
        runningCount: 0,
        doneCount: 0,
        failedCount: 0
      })
    };
    const memorySnapshot = {
      makerEnabled: false,
      customized: false,
      entryCount: 0,
      backendEnabled: { [descriptor.id]: true },
      backendEntryCount: { [descriptor.id]: 0 }
    };
    const services = createConnectServices(stubApplication({
      store,
      makerMemory: { reset: resetCuratedMemory, snapshot: () => memorySnapshot },
      sessionHost: immediateHost(store, {
        id: descriptor.id,
        resetNativeMemory
      } as unknown as BackendAdapter)
    }));

    const projected = await (services.settings.getSettings as unknown as (
      request: unknown,
      context: unknown
    ) => Promise<{ settings?: contract.SettingsSnapshot }>)({}, context());
    expect(projected.settings?.memory?.backends[0]).toMatchObject({
      backendId: descriptor.id,
      kind: contract.BackendMemoryKind.NATIVE_AUTO_MEMORY,
      resettable: true
    });

    const response = await submitReset<contract.SubmitOperationResponse>(services.operation.submitOperation, {
      operationId: "memory-reset-codex-native",
      connectionId: owner.id,
      scope: contract.MemoryResetScope.BACKEND,
      backendId: descriptor.id
    });

    expect(resetNativeMemory).toHaveBeenCalledOnce();
    expect(resetCuratedMemory).not.toHaveBeenCalled();
    const result = response.operation?.result?.payload;
    expect(result?.case).toBe("memoryReset");
    if (result?.case !== "memoryReset") throw new Error("Expected native Memory reset result.");
    expect(result.value.removedEntries).toBeUndefined();
    expect(result.value.removedTargets).toBeUndefined();
  });

  it("projects only trustworthy current-generation native-memory status and preserves explicit zero", async () => {
    let descriptor = {
      id: "claude-memory",
      instanceGeneration: 1,
      capabilities: new Map([["memory.native", {
        key: "memory.native",
        supported: true,
        options: [MEMORY_NATIVE_RESET_LOCAL_OPTION]
      }]])
    };
    let statusMode: "four" | "zero" | "failure" | "stale" = "four";
    let statusEnabled = false;
    const readNativeMemoryStatus = vi.fn(async () => {
      if (statusMode === "failure") throw new Error("private profile failure");
      if (statusMode === "stale") descriptor = { ...descriptor, instanceGeneration: 2 };
      return {
        enabled: statusEnabled,
        entryCount: statusMode === "four" ? 4 : 0,
        sizeBytes: statusMode === "four" ? 40 : 0
      };
    });
    const resetNativeMemory = vi.fn(async () => {
      statusMode = "zero";
      return { removedEntries: 4, removedTargets: 2 };
    });
    const adapter = { id: descriptor.id, readNativeMemoryStatus, resetNativeMemory } as unknown as BackendAdapter;
    const store = {
      findOperation: () => undefined,
      findSetting: () => undefined,
      getBackend: () => ({ descriptor }),
      listBackends: () => [{ descriptor, revision: 1n, updatedAt: 1 }],
      listConnections: () => [],
      listTargets: () => [],
      health: () => ({ revision: 1n }),
      messageEmbeddingStatus: () => ({
        vectorAvailable: false,
        modelId: "",
        pendingCount: 0,
        runningCount: 0,
        doneCount: 0,
        failedCount: 0
      })
    };
    const services = createConnectServices(stubApplication({
      store,
      adapters: [adapter],
      makerMemory: { snapshot: () => ({
        makerEnabled: false,
        customized: false,
        entryCount: 0,
        backendEnabled: { [descriptor.id]: true },
        backendEntryCount: { [descriptor.id]: 0 }
      }) },
      sessionHost: immediateHost(store, adapter)
    }));
    const getSettings = services.settings.getSettings as unknown as (
      request: unknown,
      context: unknown
    ) => Promise<{ settings?: contract.SettingsSnapshot }>;

    expect((await getSettings({}, context())).settings?.memory?.backends[0]).toMatchObject({
      enabled: false,
      entryCount: 4n
    });
    const reset = await submitReset<contract.SubmitOperationResponse>(services.operation.submitOperation, {
      operationId: "memory-reset-claude-native",
      connectionId: owner.id,
      scope: contract.MemoryResetScope.BACKEND,
      backendId: descriptor.id
    });
    expect(reset.operation?.result?.payload).toMatchObject({
      case: "memoryReset",
      value: { removedEntries: 4n, removedTargets: 2n }
    });
    expect(resetNativeMemory).toHaveBeenCalledOnce();
    expect(readNativeMemoryStatus).toHaveBeenCalledTimes(2);
    statusMode = "failure";
    expect((await getSettings({}, context())).settings?.memory?.backends[0]).toMatchObject({ enabled: true });
    expect((await getSettings({}, context())).settings?.memory?.backends[0]?.entryCount).toBeUndefined();
    statusMode = "zero";
    statusEnabled = true;
    expect((await getSettings({}, context())).settings?.memory?.backends[0]).toMatchObject({
      enabled: true,
      entryCount: 0n
    });
    statusMode = "stale";
    statusEnabled = false;
    const stale = (await getSettings({}, context())).settings?.memory?.backends[0];
    expect(stale?.enabled).toBe(true);
    expect(stale?.entryCount).toBeUndefined();
    expect(readNativeMemoryStatus).toHaveBeenCalledTimes(6);
  });

  it("does not let a status read started before a durable native-memory update overwrite the new choice", async () => {
    const descriptor = {
      id: "codex-memory",
      instanceGeneration: 1,
      capabilities: new Map([["memory.native", {
        key: "memory.native",
        supported: true,
        options: [MEMORY_NATIVE_LIVE_LOCAL_OPTION, MEMORY_NATIVE_DEFAULT_DISABLED_OPTION]
      }]])
    };
    let settings = {
      format: 1 as const,
      makerEnabled: false,
      backendEnabled: { [descriptor.id]: false } as Readonly<Record<string, boolean>>
    };
    let releaseStatus!: () => void;
    let markStatusStarted!: () => void;
    const statusStarted = new Promise<void>((resolve) => { markStatusStarted = resolve; });
    const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
    const readNativeMemoryStatus = vi.fn(async () => {
      markStatusStarted();
      await statusGate;
      return { enabled: false };
    });
    const reconcileNativeMemory = vi.fn(async () => "immediate" as const);
    const adapter = {
      id: descriptor.id,
      readNativeMemoryStatus,
      reconcileNativeMemory
    } as unknown as BackendAdapter;
    const store = {
      findOperation: () => undefined,
      findSetting: () => undefined,
      setSetting: (_scope: string, _scopeId: string, _key: string, value: typeof settings) => { settings = value; },
      getBackend: () => ({ descriptor }),
      listBackends: () => [{ descriptor, revision: 1n, updatedAt: 1 }],
      listConnections: () => [],
      listTargets: () => [],
      health: () => ({ revision: 1n }),
      appendDiagnostic: vi.fn(),
      messageEmbeddingStatus: () => ({
        vectorAvailable: false,
        modelId: "",
        pendingCount: 0,
        runningCount: 0,
        doneCount: 0,
        failedCount: 0
      })
    };
    const makerMemory = {
      patchedSettings: (patch: { readonly backendId?: string; readonly backendEnabled?: boolean }) => ({
        ...settings,
        backendEnabled: patch.backendEnabled === undefined
          ? settings.backendEnabled
          : { ...settings.backendEnabled, [patch.backendId!]: patch.backendEnabled }
      }),
      reconcileSettingsChange: vi.fn(async () => true),
      snapshot: () => ({
        makerEnabled: settings.makerEnabled,
        customized: true,
        entryCount: 0,
        backendEnabled: settings.backendEnabled,
        backendEntryCount: { [descriptor.id]: 0 }
      })
    };
    const services = createConnectServices(stubApplication({
      store,
      adapters: [adapter],
      makerMemory,
      sessionHost: immediateHost(store, adapter)
    }));
    const getSettings = services.settings.getSettings as unknown as (
      request: unknown,
      context: unknown
    ) => Promise<{ settings?: contract.SettingsSnapshot }>;

    const pendingStatus = getSettings({}, context());
    await statusStarted;
    await submitMemoryUpdate(services.operation.submitOperation, {
      operationId: "memory-native-update-during-status",
      connectionId: owner.id,
      backendId: descriptor.id,
      backendEnabled: true
    });
    releaseStatus();

    expect((await pendingStatus).settings?.memory?.backends[0]?.enabled).toBe(true);
    expect(reconcileNativeMemory).toHaveBeenCalledOnce();
  });

  it("does not invoke a native reset owner unless the capability option and method agree", async () => {
    const descriptor = {
      id: "native-without-reset-owner",
      capabilities: new Map([["memory.native", {
        key: "memory.native",
        supported: true,
        options: [MEMORY_NATIVE_RESET_LOCAL_OPTION]
      }]])
    };
    const store = {
      findOperation: () => undefined,
      getBackend: () => ({ descriptor })
    };
    const services = createConnectServices(stubApplication({
      store,
      makerMemory: { reset: vi.fn() },
      sessionHost: immediateHost(store, { id: descriptor.id } as unknown as BackendAdapter)
    }));

    await expect(submitReset(services.operation.submitOperation, {
      operationId: "memory-reset-owner-missing",
      connectionId: owner.id,
      scope: contract.MemoryResetScope.BACKEND,
      backendId: descriptor.id
    })).rejects.toMatchObject({
      publicError: {
        code: "NATIVE_MEMORY_RESET_OWNER_UNAVAILABLE",
        stateMayHaveChanged: false
      }
    });
  });

  it("blocks the queued Claude profile reset after the original device is revoked", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "joko-claude-memory-revocation-"));
    const store = new OperationalStore(join(root, "orchestrator.db"));
    const profile = join(root, "profile");
    const adapter = new ClaudeCodeAdapter({ instanceGeneration: 1, environment: { CLAUDE_CONFIG_DIR: profile },
      resolveNativeMemoryEnabled: () => true });
    store.upsertBackend({
      id: adapter.id, displayName: "Claude Code", version: "test", adapterKind: "claude-code", instanceGeneration: 1,
      health: "healthy", installationState: "installed", authenticationState: "authenticated", models: [], tools: [],
      diagnostics: [], capabilities: new Map([["memory.native", { key: "memory.native", supported: true,
        options: [MEMORY_NATIVE_RESET_LOCAL_OPTION] }]])
    });
    const host = new SessionHost(store, {} as never, [adapter]);
    const connections = new ConnectionManager(store);
    try {
      const memory = join(profile, "projects", "workspace", "memory");
      await mkdir(memory, { recursive: true });
      const entry = join(memory, "MEMORY.md");
      await writeFile(entry, "Preserve the original memory.");
      const key = "original-claude-memory-owner";
      const observerKey = "current-claude-memory-owner";
      const original = store.createConnection({ id: "original", name: "Original", authKeyDigest: digestAuthKey(key) });
      const observer = store.createConnection({ id: "observer", name: "Observer", authKeyDigest: digestAuthKey(observerKey) });
      const services = createConnectServices(stubApplication({ store, sessionHost: host, connections, adapters: [adapter],
        makerMemory: new MakerMemoryController({ store }) }));
      const scan = adapter.readNativeMemoryStatus();
      await Promise.resolve();
      const input = { operationId: "claude-memory-revoked", connectionId: original.id, backendId: adapter.id,
        scope: contract.MemoryResetScope.BACKEND, key };
      const reset = submitReset<contract.SubmitOperationResponse>(services.operation.submitOperation, input);
      expect(store.getOperation(input.operationId).status).toBe("started");
      connections.revokeDevice(original.deviceId);
      await expect(scan).resolves.toMatchObject({ entryCount: 1 });
      await expect(reset).resolves.toMatchObject({ operation: { state: contract.OperationState.FAILED,
        error: { code: "CLAUDE_NATIVE_MEMORY_RESET_AUTHORIZATION_RETIRED", workspaceImpact: contract.StateImpact.UNCHANGED } } });
      expect(store.getOperation(input.operationId)).toMatchObject({ status: "failed", error: { stateMayHaveChanged: false } });
      await expect(readFile(entry, "utf8")).resolves.toBe("Preserve the original memory.");
      await expect(submitReset(services.operation.submitOperation, { ...input, operationId: "claude-memory-current",
        connectionId: observer.id, key: observerKey })).resolves.toMatchObject({ operation: {
        result: { payload: { case: "memoryReset", value: { removedEntries: 1n, removedTargets: 1n } } }
      } });
      await expect(adapter.readNativeMemoryStatus()).resolves.toMatchObject({ entryCount: 0 });
    } finally {
      await host.dispose();
      await adapter.dispose();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("durably replays native reset success and unknown failure without repeating the destructive effect", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-native-memory-reset-"));
    const store = new OperationalStore(join(root, "orchestrator.db"));
    const descriptor = {
      id: "codex-durable-reset",
      displayName: "Codex",
      version: "0.153.4",
      adapterKind: "codex",
      instanceGeneration: 1,
      health: "healthy" as const,
      installationState: "installed" as const,
      authenticationState: "authenticated" as const,
      capabilities: new Map([["memory.native", {
        key: "memory.native",
        supported: true,
        options: [MEMORY_NATIVE_RESET_LOCAL_OPTION]
      }]]),
      models: [],
      tools: [],
      diagnostics: []
    };
    store.upsertBackend(descriptor);
    const connection = store.createConnection({
      id: owner.id,
      name: owner.name,
      authKeyDigest: owner.authKeyDigest
    });
    const reset = vi.fn(async () => ({}));
    let host = new SessionHost(store, {} as never, [{
      id: descriptor.id,
      resetNativeMemory: reset,
      dispose: async () => undefined
    } as unknown as BackendAdapter]);
    const servicesFor = (sessionHost: SessionHost) => createConnectServices(stubApplication({
      store,
      makerMemory: { reset: vi.fn() },
      sessionHost,
      connections: { authenticate: () => connection }
    }));

    try {
      const first = servicesFor(host);
      const input = {
        operationId: "memory-native-durable-success",
        connectionId: owner.id,
        scope: contract.MemoryResetScope.BACKEND,
        backendId: descriptor.id
      } as const;
      await expect(submitReset(first.operation.submitOperation, input)).resolves.toBeDefined();
      await expect(submitReset(first.operation.submitOperation, input)).resolves.toBeDefined();
      expect(reset).toHaveBeenCalledOnce();
      expect(store.getOperation(input.operationId)).toMatchObject({ status: "completed", response: {
        memoryReset: {}
      } });

      await host.dispose();
      const restartedReset = vi.fn(async () => {
        throw new JokoError({
          code: "CODEX_NATIVE_MEMORY_RESET_FAILED",
          message: "The native reset acknowledgement is unknown.",
          phase: "dispatch",
          retryable: false,
          stateMayHaveChanged: true,
          recovery: "Inspect native memory state before explicitly retrying."
        });
      });
      host = new SessionHost(store, {} as never, [{
        id: descriptor.id,
        resetNativeMemory: restartedReset,
        dispose: async () => undefined
      } as unknown as BackendAdapter]);
      const restarted = servicesFor(host);
      await expect(submitReset(restarted.operation.submitOperation, input)).resolves.toMatchObject({ operation: {
        result: { payload: { case: "memoryReset" } }
      } });
      expect(restartedReset).not.toHaveBeenCalled();

      const failedInput = { ...input, operationId: "memory-native-durable-unknown" };
      const failed = await submitReset<contract.SubmitOperationResponse>(
        restarted.operation.submitOperation,
        failedInput
      );
      const replayedFailure = await submitReset<contract.SubmitOperationResponse>(
        restarted.operation.submitOperation,
        failedInput
      );
      expect(restartedReset).toHaveBeenCalledOnce();
      expect(failed.operation).toMatchObject({
        state: contract.OperationState.FAILED,
        error: { code: "CODEX_NATIVE_MEMORY_RESET_FAILED" }
      });
      expect(replayedFailure.operation).toMatchObject({
        state: contract.OperationState.FAILED,
        error: { code: "CODEX_NATIVE_MEMORY_RESET_FAILED" }
      });
      expect(store.getOperation(failedInput.operationId)).toMatchObject({
        status: "failed",
        error: {
          code: "CODEX_NATIVE_MEMORY_RESET_FAILED",
          stateMayHaveChanged: true
        }
      });
    } finally {
      await host.dispose();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a rejected live native-memory update pending through a failed status refresh and adopts an explicit confirmed retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-native-memory-application-"));
    const store = new OperationalStore(join(root, "orchestrator.db"));
    const memory = new MakerMemoryController({ store });
    const backendId = "codex";
    try {
      const connection = store.createConnection({ id: owner.id, name: owner.name, authKeyDigest: owner.authKeyDigest });
      store.upsertBackend({ id: backendId, displayName: "Codex", adapterKind: "codex", version: "test", instanceGeneration: 1,
        health: "healthy", installationState: "installed", authenticationState: "not_required",
        capabilities: new Map([["memory.native", { key: "memory.native", supported: true, options: [MEMORY_NATIVE_LIVE_LOCAL_OPTION] }]]),
        models: [], tools: [], diagnostics: [] });
      await memory.update({ makerEnabled: false, backendId, backendEnabled: false });
      let rejectUpdate = false;
      let effectiveEnabled = false;
      const apply = () => {
        if (rejectUpdate) throw new Error("private runtime failure");
        effectiveEnabled = memory.nativeEnabledForBackend(backendId);
      };
      const adapter = { id: backendId, reconcileNativeMemory: async () => { apply(); return "immediate" as const; },
        readNativeMemoryStatus: async () => {
          if (rejectUpdate) throw new Error("private status failure");
          return { enabled: effectiveEnabled };
        } } as unknown as BackendAdapter;
      const services = createConnectServices(stubApplication({ store, makerMemory: memory, adapters: [adapter],
        connections: { authenticate: () => connection }, sessionHost: immediateHost(store, adapter) }));
      const getSettings = services.settings.getSettings as unknown as (
        request: unknown, context: unknown
      ) => Promise<contract.GetSettingsResponse>;
      const row = async () => (await getSettings({}, context())).settings?.memory?.backends[0];
      expect(await row()).toMatchObject({ enabled: false, reason: "" });
      rejectUpdate = true;
      const result = await submitMemoryUpdate<contract.SubmitOperationResponse>(services.operation.submitOperation, {
        operationId: "memory-native-live-reconcile-failure", connectionId: connection.id, backendId, backendEnabled: true
      });
      const pending = { enabled: false, support: contract.CapabilitySupport.SUPPORTED, reason: "Live native memory confirmation is pending." };
      expect(result.operation?.result?.payload).toMatchObject({ case: "settings", value: { memory: { backends: [pending] } } });
      expect(memory.settings().backendEnabled[backendId]).toBe(true);
      expect(effectiveEnabled).toBe(false);
      expect(await row()).toMatchObject(pending);
      const diagnostics = store.listDiagnostics();
      expect(diagnostics).toContainEqual(expect.objectContaining({ code: "NATIVE_MEMORY_RECONCILIATION_FAILED", details: { backendIds: [backendId] } }));
      expect(diagnostics.map(item => item.message).join("\n")).not.toContain("private runtime failure");
      rejectUpdate = false;
      await adapter.reconcileNativeMemory!();
      expect(await row()).toMatchObject({ enabled: true, reason: "" });
    } finally {
      memory.dispose(); store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("saves shared memory while native work finishes and keeps pending status through a failed idle replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-memory-idle-application-"));
    const store = new OperationalStore(join(root, "orchestrator.db"));
    const memory = new MakerMemoryController({ store });
    const backendId = "codex";
    const connection = store.createConnection({ id: owner.id, name: owner.name, authKeyDigest: owner.authKeyDigest });
    store.upsertBackend({ id: backendId, displayName: "Codex", adapterKind: "codex", version: "test", instanceGeneration: 1,
      health: "healthy", installationState: "installed", authenticationState: "not_required",
      capabilities: new Map([["memory.native", { key: "memory.native", supported: true, options: [MEMORY_NATIVE_LIVE_LOCAL_OPTION] }]]),
      models: [], tools: [], diagnostics: [] });
    await memory.update({ makerEnabled: false, backendId, backendEnabled: true });
    let effectiveEnabled = true;
    let idle = false;
    let failReplacement = true;
    const readNativeMemoryStatus = vi.fn(async () => ({ enabled: effectiveEnabled }));
    const reconcileNativeMemory = vi.fn(async () => "immediate" as const);
    const adapter = { id: backendId, readNativeMemoryStatus, reconcileNativeMemory, dispose: async () => undefined } as unknown as BackendAdapter;
    const host = new SessionHost(store, {} as never, [adapter]);
    const restart = vi.fn(async () => {
      if (failReplacement) throw new Error("replacement unavailable");
      effectiveEnabled = memory.nativeEnabledForBackend(backendId);
    });
    const wakeQueues = vi.fn();
    const coordinator = new DeferredBackendRestartCoordinator({ restart, canRestart: () => idle, wakeQueues, retryDelayMs: 60_000 });
    const hold = vi.fn((id: string) => {
      expect(memory.settings().makerEnabled).toBe(true);
      expect(store.getOperation("enable-shared-memory-while-busy").status).toBe("completed");
      coordinator.request(id, "native_memory");
    });
    const services = createConnectServices(stubApplication({ store, makerMemory: memory, adapters: [adapter], sessionHost: host,
      connections: { authenticate: () => connection }, holdNativeMemoryDispatch: hold,
      refreshNativeMemory: async (id: string) => { await coordinator.apply(id); return coordinator.state(id, "native_memory").pending; },
      nativeMemoryRestartPending: (id: string) => coordinator.state(id, "native_memory").pending }));
    const getSettings = services.settings.getSettings as unknown as (request: unknown, context: unknown) => Promise<contract.GetSettingsResponse>;
    const row = async () => (await getSettings({}, context())).settings?.memory?.backends[0];
    const input = { operationId: "enable-shared-memory-while-busy", connectionId: connection.id, makerEnabled: true };
    try {
      expect(await row()).toMatchObject({ enabled: true, reason: "" });
      await submitMemoryUpdate(services.operation.submitOperation, input);
      expect(coordinator.blocksDispatch(backendId)).toBe(true);
      expect(restart).not.toHaveBeenCalled();
      expect(reconcileNativeMemory).not.toHaveBeenCalled();
      expect(await row()).toMatchObject({ enabled: true, reason: "Live native memory confirmation is pending." });
      expect(readNativeMemoryStatus).toHaveBeenCalledOnce();
      await submitMemoryUpdate(services.operation.submitOperation, input);
      expect(hold).toHaveBeenCalledOnce();
      idle = true;
      await coordinator.apply(backendId);
      expect(await row()).toMatchObject({ enabled: true, reason: "Live native memory confirmation is pending." });
      expect(wakeQueues).not.toHaveBeenCalled();
      failReplacement = false;
      coordinator.onBackendMayBeIdle(backendId);
      await vi.waitFor(() => expect(coordinator.state(backendId).pending).toBe(false));
      expect(await row()).toMatchObject({ enabled: false, reason: "" });
      expect(restart).toHaveBeenCalledTimes(2);
      expect(wakeQueues).toHaveBeenCalledOnce();
      expect(readNativeMemoryStatus).toHaveBeenCalledTimes(2);
    } finally {
      coordinator.dispose();
      await host.dispose();
      memory.dispose(); store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous reset scopes before deleting anything", async () => {
    const reset = vi.fn();
    const store = { findOperation: () => undefined };
    const services = createConnectServices(stubApplication({
      store,
      makerMemory: { reset },
      sessionHost: immediateHost(store)
    }));

    await expect(submitReset(services.operation.submitOperation, {
      operationId: "memory-curated-with-backend",
      connectionId: owner.id,
      scope: contract.MemoryResetScope.CURATED,
      backendId: "memory-capable"
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(submitReset(services.operation.submitOperation, {
      operationId: "memory-backend-without-id",
      connectionId: owner.id,
      scope: contract.MemoryResetScope.BACKEND
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(reset).not.toHaveBeenCalled();
  });
});

function context(key = "memory-test"): unknown {
  return { requestHeader: new Headers({ authorization: `Bearer ${key}` }), signal: new AbortController().signal };
}

function stubApplication(overrides: Record<string, unknown>): OrchestratorApplication {
  return {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store: {},
    connections: { authenticate: () => owner },
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    sessionHost: {},
    scheduler: {},
    adapters: [],
    browserActivity: [],
    close: async () => undefined,
    ...overrides
  } as unknown as OrchestratorApplication;
}

function immediateHost(store: object, adapter?: BackendAdapter) {
  return {
    mutate: async (input: {
      operationId: string;
      kind: string;
      body: unknown;
      commit: (value: object) => unknown;
      precondition?: (value: object) => void;
      effect?: () => Promise<void>;
    }) => {
      input.precondition?.(store);
      await input.effect?.();
      input.precondition?.(store);
      const value = input.commit(store);
      const operation: OperationRecord<unknown> = {
        id: input.operationId,
        connectionId: owner.id,
        kind: input.kind,
        body: input.body,
        bodyHash: operationBodyHash(input.body),
        completionMode: "external_effect",
        status: "completed",
        response: value,
        createdAt: 1,
        updatedAt: 2,
        revision: 1n
      };
      return { replayed: false, value, operation };
    },
    invokeBackendAdapter: async <T>(
      backendId: string,
      effect: (value: BackendAdapter, generation: number) => T | Promise<T>
    ): Promise<T> => {
      if (adapter === undefined || adapter.id !== backendId) throw new Error("Backend adapter unavailable");
      return await effect(adapter, 1);
    }
  };
}

async function submitReset<T = unknown>(handler: unknown, input: {
  readonly operationId: string;
  readonly connectionId: string;
  readonly scope: contract.MemoryResetScope;
  readonly backendId?: string;
  readonly key?: string;
}): Promise<T> {
  if (typeof handler !== "function") throw new Error("submitOperation handler is missing");
  return await (handler as (request: unknown, value: unknown) => Promise<T>)({
    operationId: input.operationId,
    connectionId: input.connectionId,
    mutation: create(contract.OperationMutationSchema, {
      preconditions: [],
      payload: {
        case: "resetMemory",
        value: create(contract.ResetMemoryMutationSchema, {
          scope: input.scope,
          backendId: input.backendId ?? ""
        })
      }
    })
  }, context(input.key));
}

async function submitMemoryUpdate<T = unknown>(handler: unknown, input: {
  readonly operationId: string;
  readonly connectionId: string;
  readonly makerEnabled?: boolean;
  readonly backendId?: string;
  readonly backendEnabled?: boolean;
}): Promise<T> {
  if (typeof handler !== "function") throw new Error("submitOperation handler is missing");
  return await (handler as (request: unknown, value: unknown) => Promise<T>)({
    operationId: input.operationId,
    connectionId: input.connectionId,
    mutation: create(contract.OperationMutationSchema, {
      preconditions: [],
      payload: {
        case: "updateMemorySettings",
        value: create(contract.UpdateMemorySettingsMutationSchema, {
          patch: create(contract.MemorySettingsPatchSchema, {
            ...(input.makerEnabled === undefined ? {} : { makerEnabled: input.makerEnabled }),
            ...(input.backendId === undefined ? {} : { backendId: input.backendId }),
            ...(input.backendEnabled === undefined ? {} : { backendEnabled: input.backendEnabled })
          })
        })
      }
    })
  }, context());
}
