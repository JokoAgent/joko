import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import {
  CLAUDE_AGENT_SDK_CLI_VERSION, CLAUDE_AGENT_SDK_VERSION, ClaudeCodeAdapter, claudeNativeDerivationOperationId, claudeWorkspaceAuthority,
  loadClaudeRemoteManagerSource
} from "@joko/adapter-claude-code";
import { create } from "@bufbuild/protobuf";
import { EntityKind, OperationMutationSchema, OperationState, StateImpact, type Event } from "@joko/contracts";
import {
  createOrchestratorApplication, createPublicServer, type OrchestratorApplication, type OrchestratorConfig
} from "@joko/orchestrator";
import type {
  RemoteFileTransportPort, RemoteGitCheckoutLease, RemoteGitCheckoutPlan, RemoteProcessHandle, RemoteProcessStartRequest,
  RemoteProcessTransportPort
} from "@joko/remote-ssh";
import { expect, it, vi } from "vitest";

import { createE2eClients, type E2eClients } from "./connect-clients.js";
import { waitFor } from "./fixture.js";
import {
  cloneMutation, createSessionMutation, deleteMutation, forkMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit
} from "./operations.js";

const BACKEND_ID = "claude-code";
const REMOTE_ROOT = "/srv/joko-project";
const RUNTIME_ROOT = "/home/fixture/.joko/runtime/v1/claude-code";
const SOURCE_COMMIT = "a".repeat(40);
const MANAGER_GENERATION = "11111111-1111-4111-8111-111111111111";

it("keeps a remote Claude checkout and stored fork exact through dispatch, restart, refork, and delete", {
  timeout: 240_000
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-remote-claude-derive-"));
  const workspace = join(root, "workspace");
  const dataDirectory = join(root, "data");
  await mkdir(workspace);
  const config: OrchestratorConfig = {
    host: "127.0.0.1", port: 0, internalPort: 4317,
    publicOrigin: "http://127.0.0.1", internalOrigin: "http://127.0.0.1:4317",
    dataDirectory, databasePath: join(dataDirectory, "orchestrator.db"),
    allowInsecureLoopback: true, allowInsecureLan: false, lanDiscoveryEnabled: false,
    codexExecutable: join(root, "missing-codex"), piAgentHome: join(dataDirectory, "pi"),
    workspace: { id: "workspace", root: workspace, displayName: "Remote Claude fixture", trusted: true },
    artifactDirectory: join(dataDirectory, "artifacts"), webDirectory: join(root, "no-web"), corsOrigins: []
  };
  const remote = new ControlledRemoteClaude();
  await remote.initialize();
  const observeCleanup = vi.spyOn(ClaudeCodeAdapter.prototype, "cleanupNativeSessionDerivation");
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    running = await start(config, remote);
    const { application } = running;
    expect(application.store.getBackend(BACKEND_ID).descriptor.adapterKind).toBe("claude-agent-sdk-stdio");
    const target = application.store.listTargets().find((item) => item.descriptor.backendId === BACKEND_ID);
    if (target === undefined) throw new Error("The production Claude Target is unavailable.");
    const targetId = "remote-workspace:claude-code";
    const remoteWorkspace = { kind: "ssh" as const, hostTargetId: targetId, hostId: "host-a", workspaceRoot: REMOTE_ROOT };
    application.store.upsertTarget({
      ...target.descriptor, id: targetId, displayName: "Remote Claude workspace",
      workspaceRoot: REMOTE_ROOT, managed: true, trusted: true, remoteWorkspace
    }, { ...object(target.metadata), workspaceId: "remote-workspace" });
    const host = application.remoteHosts!.create({
      targetId, id: "host-a", hostname: "fixture.invalid", user: "fixture", source: "manual"
    });
    expect((await application.remoteHosts!.connect(targetId, host.id, host.revision)).ok).toBe(true);
    await application.sessionHost.validateTarget(application.store.getTarget(targetId).descriptor);
    const providers = application.providers;
    if (providers === undefined) throw new Error("The production Provider catalog is unavailable.");
    await providers.upsert({
      backendId: BACKEND_ID, credentialOrigin: "",
      provider: { id: "keyless-fixture", baseUrl: "http://127.0.0.1:33171/v1",
        api: "anthropic-messages", keyless: true,
        models: [{ id: "fixture-model", name: "Fixture model", contextWindow: 200_000,
          maxTokens: 32_000, reasoning: true, thinkingLevelMap: { low: "low" } }] },
      displayName: "Controlled keyless route", kind: "custom_endpoint", credentialBindings: {}, enabled: true,
      supportsLogin: false, supportsLogout: false, supportsRefresh: false
    });
    expect(providers.get(BACKEND_ID, "keyless-fixture")).toMatchObject({
      enabled: true, authenticationState: "not_required"
    });
    expect(providers.describeInferenceRoute(BACKEND_ID, "keyless-fixture", "fixture-model"))
      .toBeDefined();
    await application.refreshBackendDescriptor(BACKEND_ID);
    const challenge = application.connections.issuePairing("Remote Claude client");
    const paired = application.connections.completePairing({
      challengeId: challenge.id, code: challenge.code, connectionName: "Remote Claude client"
    });
    const clients = createE2eClients(running.baseUrl, paired.authKey);
    const createSource = createSessionMutation({ backendId: BACKEND_ID, targetId,
      providerId: "keyless-fixture", modelId: "fixture-model", effortId: "low" });
    const created = await submit(clients.operation, paired.connection.id, createSource);
    if (created.state !== OperationState.SUCCEEDED) {
      throw new Error(`Remote source creation failed: ${JSON.stringify(created,
        (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)}`);
    }
    const sourceId = sessionIdFrom(created);
    const sourceBinding = application.store.getSession(sourceId).descriptor.binding;
    const sourceNativeId = sourceBinding.nativeSessionId;
    if (sourceNativeId === undefined) throw new Error("The source has no native Session identity.");
    const sourceTurn = await submit(clients.operation, paired.connection.id,
      sendInputMutation(sourceId, BigInt(sourceBinding.generation), "first question"));
    expect(sourceTurn.state).toBe(OperationState.SUCCEEDED);
    await waitFor(async () => application.store.findQueueItemByRunId(sourceId, queueRunIdFrom(sourceTurn))?.state,
      (state) => state === "completed", "source remote turn completion", 10_000);
    const sourceHistory = remote.messages(sourceNativeId);
    expect(remote.queryInputs.find((item) => item.content === "first question")).toMatchObject({
      sessionId: sourceNativeId, consumedInitCwd: REMOTE_ROOT
    });
    const sourceTimeline = await timeline(clients, sourceId);
    const sourceAssistant = sourceTimeline.find((item) => item.payload?.kind.case === "messageCompleted"
      && item.payload.kind.value.nativeIdentity?.entryId !== undefined);
    if (sourceAssistant?.payload?.kind.case !== "messageCompleted"
      || sourceAssistant.payload.kind.value.nativeIdentity === undefined) {
      throw new Error("The source assistant history has no native boundary.");
    }
    const sourceAssistantId = sourceAssistant.payload.kind.value.nativeIdentity.entryId;
    const anchor = messageAnchor(sourceTimeline, sourceAssistantId);
    const first = await submit(clients.operation, paired.connection.id,
      forkMutation(sourceId, sourceAssistantId, anchor));
    if (first.state !== OperationState.SUCCEEDED) {
      throw new Error(`Remote fork failed: ${JSON.stringify({ first,
        diagnostics: application.store.listDiagnostics().slice(-10), managerCalls: remote.managerCalls,
        checkoutCalls: remote.checkoutCalls, deriveCount: remote.deriveCount, lastPlan: remote.lastPlan },
      (_key, value: unknown) => typeof value === "bigint" ? String(value) : value)}`);
    }
    const derivedId = sessionIdFrom(first);
    const derived = application.store.getSession(derivedId).descriptor;
    if (derived.worktree === undefined) throw new Error("The remote fork has no active checkout.");
    const derivedNativeId = derived.binding.nativeSessionId;
    if (derivedNativeId === undefined) throw new Error("The remote fork has no native Session identity.");
    expect(derived.remoteWorkspace).toEqual(remoteWorkspace);
    expect(derived.worktree).toMatchObject({
      state: "active", repositoryRoot: REMOTE_ROOT, remote: {
        targetId, binding: remoteWorkspace, manifestId: expect.any(String)
      }
    });
    expect(derived.worktree.path).toMatch(/^\/home\/fixture\/\.joko\/runtime\/v1\/claude-code\/worktrees\/checkouts\//u);
    expect(remote.deriveCount).toBe(1);
    expect(remote.lastPlan?.sourceSnapshot).toBe(`sha256:${"b".repeat(64)}`);
    expect(application.store.getSession(sourceId).descriptor.worktree).toBeUndefined();
    expect(remote.activePaths()).toEqual([derived.worktree.path]);

    const dispatched = await submit(clients.operation, paired.connection.id,
      sendInputMutation(derivedId, BigInt(derived.binding.generation), "continue in the remote checkout"));
    expect(dispatched.state).toBe(OperationState.SUCCEEDED);
    try {
      await waitFor(async () => application.store.findQueueItemByRunId(derivedId, queueRunIdFrom(dispatched))?.state,
        (state) => state === "completed", "remote stored turn completion", 10_000);
    } catch (error) {
      throw new Error(`${String(error)}: ${JSON.stringify({
        queueItem: application.store.findQueueItemByRunId(derivedId, queueRunIdFrom(dispatched)),
        diagnostics: application.store.listDiagnostics().slice(-12), managerCalls: remote.managerCalls,
        queryInputs: remote.queryInputs
      }, (_key, value: unknown) => typeof value === "bigint" ? String(value) : value)}`);
    }
    expect(remote.queryInputs.find((item) => item.content === "continue in the remote checkout"))
      .toMatchObject({ sessionId: derivedNativeId,
        consumedInitCwd: derived.worktree.path });
    expect(remote.messages(sourceNativeId)).toEqual(sourceHistory);
    expect(application.store.getSession(sourceId).descriptor).toMatchObject({
      remoteWorkspace
    });
    expect(application.store.getSession(sourceId).descriptor.worktree).toBeUndefined();

    await running.close();
    running = await start(config, remote);
    const restarted = running.application;
    const restartedClients = createE2eClients(running.baseUrl, paired.authKey);
    expect(restarted.store.getSession(derivedId).descriptor.worktree).toEqual(derived.worktree);
    expect(remote.deriveCount).toBe(1);
    expect(remote.activePaths()).toEqual([derived.worktree.path]);
    const restoredTimeline = await timeline(restartedClients, derivedId);
    const restoredAssistant = restoredTimeline.find((item) => item.payload?.kind.case === "messageCompleted"
      && item.payload.kind.value.nativeIdentity?.entryId !== sourceAssistantId
      && item.payload.kind.value.nativeIdentity?.entryId !== undefined);
    if (restoredAssistant?.payload?.kind.case !== "messageCompleted"
      || restoredAssistant.payload.kind.value.nativeIdentity === undefined) {
      throw new Error("The derived native history did not survive restart.");
    }
    const reforkAnchor = messageAnchor(restoredTimeline,
      restoredAssistant.payload.kind.value.nativeIdentity.entryId);
    const second = await submit(restartedClients.operation, paired.connection.id,
      forkMutation(derivedId, restoredAssistant.payload.kind.value.nativeIdentity.entryId, reforkAnchor));
    if (second.state !== OperationState.SUCCEEDED) {
      throw new Error(`Remote refork failed: ${JSON.stringify({ second,
        diagnostics: restarted.store.listDiagnostics().slice(-10), managerCalls: remote.managerCalls,
        checkoutCalls: remote.checkoutCalls, deriveCount: remote.deriveCount, lastPlan: remote.lastPlan },
      (_key, value: unknown) => typeof value === "bigint" ? String(value) : value)}`);
    }
    const reforkId = sessionIdFrom(second);
    const refork = restarted.store.getSession(reforkId).descriptor;
    if (refork.worktree === undefined) throw new Error("The remote refork has no checkout.");
    expect(refork.worktree.path).not.toBe(derived.worktree.path);
    expect(remote.deriveCount).toBe(2);
    expect(remote.lastPlan?.sourceLease).toMatchObject({
      id: derived.worktree.leaseId, path: derived.worktree.path,
      remote: derived.worktree.remote
    });
    expect(remote.activePaths()).toContain(refork.worktree.path);

    const deletion = await submit(restartedClients.operation, paired.connection.id, deleteMutation(reforkId, true));
    expect(deletion.state).toBe(OperationState.SUCCEEDED);
    expect(restarted.store.getSession(reforkId).descriptor.deletedAt).toEqual(expect.any(Number));
    expect(remote.activePaths()).toEqual([derived.worktree.path]);
    expect(remote.releasedPaths).toContain(refork.worktree.path);
    expect(restarted.store.getSession(derivedId).descriptor.worktree).toEqual(derived.worktree);

    remote.interruptNextCheckoutDerivation = true;
    const clone = cloneMutation(sourceId, "Interrupted remote clone");
    const cloneId = randomUUID();
    const callsBeforeClone = remote.checkoutCalls.length;
    const nativeCallsBeforeClone = remote.managerCalls.length;
    const interrupted = await submit(restartedClients.operation, paired.connection.id, clone, cloneId);
    expect(interrupted.state).toBe(OperationState.FAILED);
    const plan = remote.lastPlan!;
    const pending = restarted.store.listUnadoptedNativeSessionDerivations()
      .find((record) => record.remoteWorktreePlan?.leaseId === plan.leaseId);
    expect(pending).toMatchObject({ state: "workspace_cleanup_pending", cleanupToken: expect.any(String) });
    expect(pending?.worktree).toBeUndefined();
    expect(pending?.binding).toBeUndefined();
    expect(remote.checkoutCalls.slice(callsBeforeClone)).toEqual(["probe", "derive", "inspect", "release"]);
    expect(remote.activePaths()).toEqual([derived.worktree.path]);
    expect(remote.releasedPaths.filter((path) => path === plan.path)).toHaveLength(1);

    const callsBeforeRecovery = remote.checkoutCalls.length;
    await running.close();
    running = await start(config, remote);
    const recovered = running.application;
    const recoveryCalls = remote.checkoutCalls.slice(callsBeforeRecovery);
    expect(recoveryCalls.filter((call) => call !== "assert")).toEqual(["inspect", "release"]);
    expect(recovered.store.findNativeSessionDerivation(pending!.operationId)).toMatchObject({
      state: "cleaned", cleanupToken: pending!.cleanupToken, remoteWorktreePlan: plan
    });
    expect(recovered.store.listSessions({ includeArchived: true, includeDeleted: true })
      .some((session) => session.descriptor.id === plan.sessionId)).toBe(false);
    expect(remote.managerCalls.slice(nativeCallsBeforeClone)).not.toContain("store.fork");
    expect(remote.managerCalls.slice(nativeCallsBeforeClone)).not.toContain("store.cleanupOperation");
    expect(remote.releasedPaths.filter((path) => path === plan.path)).toHaveLength(1);
    expect(remote.activePaths()).toEqual([derived.worktree.path]);
    expect(remote.messages(sourceNativeId)).toEqual(sourceHistory);
    const recoveredClients = createE2eClients(running.baseUrl, paired.authKey);
    const receipt = (await recoveredClients.operation.getOperation({ operationId: cloneId })).operation;
    expect(receipt).toMatchObject({ operationId: cloneId, state: OperationState.FAILED, error: interrupted.error });
    expect(await submit(recoveredClients.operation, paired.connection.id, clone, cloneId)).toEqual(receipt);
    expect(remote.checkoutCalls.slice(callsBeforeRecovery)).toEqual(recoveryCalls);

    // Recreate the exact durable sides of three cold checkpoints without
    // inventing a second user request or replaying the original Clone.
    const checkpoints = [];
    const checkoutSource = recovered.store.getSession(sourceId);
    const checkoutTarget = recovered.store.getTarget(targetId);
    const backendGeneration = recovered.store.getBackend(BACKEND_ID).descriptor.instanceGeneration;
    for (const boundary of ["attached", "child_pending", "recorded"] as const) {
      const operationId = randomUUID(), sessionId = randomUUID();
      const checkout = await recovered.sessionWorktrees.planRemoteDerivation({ sessionId, sourceSessionId: sourceId });
      if (checkout === undefined) throw new Error("The fixture Clone has no remote worktree plan.");
      const claim = recovered.store.claimAuthorizedDeferredEffectOperation(paired.connection.id, paired.connection.authKeyDigest, {
        id: operationId, kind: "clone_session", body: { sourceSessionId: sourceId, title: "Interrupted Clone", kind: "clone" }
      });
      const identity = {
        operationId, expectedBodyHash: claim.operation.bodyHash, sourceSessionId: sourceId,
        sourceBinding: checkoutSource.descriptor.binding, sessionId, backendId: BACKEND_ID,
        backendInstanceGeneration: backendGeneration, targetId, effectiveWorkspaceRoot: checkout.path, remoteWorkspace
      };
      const prepared = recovered.store.prepareNativeSessionDerivation({
        ...identity, sourceSessionRevision: checkoutSource.revision, targetRevision: checkoutTarget.revision, remoteWorktreePlan: checkout
      });
      const worktree = await recovered.sessionWorktrees.acquirePlannedRemoteDerivation(checkout);
      recovered.store.attachNativeSessionDerivationWorktree({ operationId, expectedRevision: prepared.revision, worktree });
      const nativeOperationId = claudeNativeDerivationOperationId(operationId);
      const workspaceAuthority = claudeWorkspaceAuthority({ ...checkoutTarget.descriptor, workspaceRoot: checkout.path });
      const childId = boundary === "attached" ? undefined : randomUUID();
      if (childId !== undefined) {
        remote.storeInterruptedClone({ id: nativeOperationId, workspaceAuthority, sourceNativeId, childId,
          sourceWorkspaceAuthority: claudeWorkspaceAuthority(checkoutTarget.descriptor), confirmed: boundary === "recorded" });
        if (boundary === "recorded") recovered.store.recordNativeSessionDerivation({ ...identity, worktree, binding: {
          nativeSessionId: childId, opaqueRef: `claude-code:stored-session:${workspaceAuthority}:${childId}`,
          generation: checkoutSource.descriptor.binding.generation
        } });
      }
      expect(recovered.store.getOperation(operationId).status).toBe("started");
      expect(recovered.store.findNativeSessionDerivation(operationId)?.state).toBe(boundary === "recorded" ? "recorded" : "prepared");
      checkpoints.push({ operationId, sessionId, worktree, childId, nativeOperationId, boundary });
    }
    const beforeCleanup = remote.managerCalls.length;
    const beforeCheckout = remote.checkoutCalls.length;
    await running.close();
    running = await start(config, remote);
    for (const checkpoint of checkpoints) {
      expect(running.application.store.getOperation(checkpoint.operationId).status).toBe("failed");
      const cleanupCall = observeCleanup.mock.calls.find(([lifecycle]) => lifecycle.operationId === checkpoint.operationId);
      expect(cleanupCall?.[2], `The ${checkpoint.boundary} cleanup must carry its durable claim.`).toEqual({
        token: running.application.store.findNativeSessionDerivation(checkpoint.operationId)?.cleanupToken
      });
      const diagnostics = running.application.store.listDiagnostics({ component: "native_session_derivation_cleanup", limit: 6 })
        .map(({ code, message }) => ({ code, message }));
      expect(running.application.store.findNativeSessionDerivation(checkpoint.operationId), JSON.stringify({
        checkpoint: checkpoint.boundary, diagnostics,
        manager: remote.managerCalls.slice(beforeCleanup),
        checkout: remote.checkoutCalls.slice(beforeCheckout), cleanupOperations: remote.cleanupOperations.length
      })).toMatchObject({
        state: "cleaned", cleanupToken: expect.any(String), worktree: checkpoint.worktree
      });
      expect(remote.releasedPaths.filter(path => path === checkpoint.worktree.path)).toHaveLength(1);
      if (checkpoint.childId !== undefined) expect(remote.messages(checkpoint.childId)).toEqual([]);
    }
    expect([...remote.cleanupOperations].sort()).toEqual(checkpoints.filter(checkpoint => checkpoint.childId !== undefined)
      .map(checkpoint => checkpoint.nativeOperationId).sort());
    expect(remote.managerCalls.slice(beforeCleanup).filter(method => method === "store.recoverOperation")).toHaveLength(3);
    expect(remote.managerCalls.slice(beforeCleanup)).not.toContain("store.fork");
    expect(remote.activePaths()).toEqual([derived.worktree.path]);
    expect(remote.messages(sourceNativeId)).toEqual(sourceHistory);
    const finalClients = createE2eClients(running.baseUrl, paired.authKey);
    expect((await submit(finalClients.operation, paired.connection.id, deleteMutation(derivedId, true))).state).toBe(OperationState.SUCCEEDED);
    expect(remote.activePaths()).toEqual([]);
    const beforeRenamedClone = remote.managerCalls.length;
    remote.interruptNextCheckoutRelease = true;
    remote.beforeCheckoutDeriveReply = async () => {
      const current = running!.application.store.getTarget(targetId);
      const renamed = await submit(finalClients.operation, paired.connection.id, create(OperationMutationSchema, {
        preconditions: [{ entity: { kind: EntityKind.TARGET, id: targetId }, expectedRevision: { value: current.revision } }],
        payload: { case: "updateTarget", value: { targetId, displayName: "Renamed during original Clone" } }
      }));
      expect(renamed.state).toBe(OperationState.SUCCEEDED);
    };
    const renamedCloneId = randomUUID(), renamedClone = cloneMutation(sourceId, "Clone interrupted by project rename");
    const renamedResult = await submit(finalClients.operation, paired.connection.id, renamedClone, renamedCloneId);
    expect(renamedResult).toMatchObject({ state: OperationState.FAILED, error: {
      code: "EFFECT_FAILED", phase: "effect", retryable: false,
      queueImpact: StateImpact.MAY_HAVE_CHANGED, nativeSessionImpact: StateImpact.MAY_HAVE_CHANGED,
      workspaceImpact: StateImpact.MAY_HAVE_CHANGED
    } });
    const renamedPlan = remote.lastPlan!;
    const renamedPending = running.application.store.findNativeSessionDerivation(renamedCloneId)!;
    expect(renamedPending).toMatchObject({ state: "workspace_cleanup_pending", cleanupToken: expect.any(String), remoteWorktreePlan: renamedPlan });
    expect(renamedPending.binding).toBeUndefined(); expect(renamedPending.worktree).toBeUndefined();
    expect(running.application.store.getTarget(targetId).descriptor.displayName).toBe("Renamed during original Clone");
    expect(running.application.store.getTarget(targetId).revision).toBeGreaterThan(BigInt(renamedPlan.authority.targetRevision));
    const derivesBeforeRetry = remote.deriveCount;
    await expect(running.application.sessionWorktrees.acquirePlannedRemoteDerivation(renamedPlan)).rejects.toMatchObject({ code: "AUTHORITY_CHANGED" });
    expect(remote.deriveCount).toBe(derivesBeforeRetry);
    const checkoutBeforeRestart = remote.checkoutCalls.length;
    await running.close(); running = await start(config, remote);
    expect(running.application.store.findNativeSessionDerivation(renamedCloneId)).toMatchObject({
      state: "cleaned", cleanupToken: renamedPending.cleanupToken, remoteWorktreePlan: renamedPlan
    });
    expect(remote.checkoutCalls.slice(checkoutBeforeRestart)).toEqual(["inspect", "release"]);
    expect(remote.releasedPaths.filter(path => path === renamedPlan.path)).toHaveLength(1);
    expect(remote.activePaths()).toEqual([]);
    expect(remote.managerCalls.slice(beforeRenamedClone)).not.toContain("store.fork");
    expect(remote.managerCalls.slice(beforeRenamedClone)).not.toContain("store.cleanupOperation");
    expect(running.application.store.listSessions({ includeArchived: true, includeDeleted: true })
      .some(session => session.descriptor.id === renamedPlan.sessionId)).toBe(false);
    expect(remote.messages(sourceNativeId)).toEqual(sourceHistory);
    const renamedClients = createE2eClients(running.baseUrl, paired.authKey);
    expect(await submit(renamedClients.operation, paired.connection.id, renamedClone, renamedCloneId)).toEqual(renamedResult);
    expect(remote.deriveCount).toBe(derivesBeforeRetry);
  } finally {
    observeCleanup.mockRestore();
    await running?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function timeline(clients: E2eClients, sessionId: string): Promise<readonly Event[]> {
  return (await clients.event.getSnapshot({ scope: {
    kind: { case: "session", value: { sessionId, recentTimelineItems: 200 } }
  } })).snapshot!.timeline;
}

function messageAnchor(events: readonly Event[], nativeId: string): { eventId: string; messageId: string } {
  const event = events.find((item) => item.payload?.kind.case === "messageCompleted"
    && item.payload.kind.value.nativeIdentity?.entryId === nativeId);
  if (event?.payload?.kind.case !== "messageCompleted") throw new Error(`No native boundary ${nativeId}.`);
  return { eventId: event.eventId, messageId: event.payload.kind.value.messageId };
}

async function start(config: OrchestratorConfig, remote: ControlledRemoteClaude) {
  const application = await createOrchestratorApplication(config, { remoteSshConnector: remote.connector });
  const server = await createPublicServer(application);
  server.log.level = "silent";
  const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  return {
    application, baseUrl,
    close: async () => { await server.close(); await application.close(); }
  };
}

type RemoteConnector = NonNullable<NonNullable<Parameters<typeof createOrchestratorApplication>[1]>["remoteSshConnector"]>;
type NativeMessage = Readonly<Record<string, unknown>>;

class ControlledRemoteClaude {
  readonly #processes = new ControlledProcesses(this);
  readonly #checkouts = new Map<string, RemoteGitCheckoutLease>();
  #interruptReleaseFor: string | undefined;
  #releasing: RemoteGitCheckoutLease | undefined;
  readonly #interruptedClones = new Set<string>();
  readonly cleanupOperations: string[] = [];
  readonly #files: RemoteFileTransportPort = {
    realpath: async (path) => {
      if (!this.hasDirectory(path)) throw new Error(`Unknown remote directory ${path}.`);
      return path;
    },
    stat: async (path) => {
      if (!this.hasDirectory(path)) throw new Error(`Unknown remote directory ${path}.`);
      return { kind: "directory", size: 0, modifiedAt: 1, mode: 0o755 };
    },
    list: async (path) => {
      if (!this.hasDirectory(path)) throw new Error(`Unknown remote directory ${path}.`);
      return [];
    },
    read: async () => { throw new Error("Unexpected remote file read."); },
    write: async () => { throw new Error("Unexpected remote file write."); },
    mkdir: async () => { throw new Error("Unexpected remote directory create."); },
    rename: async () => { throw new Error("Unexpected remote file rename."); },
    remove: async () => { throw new Error("Unexpected remote file remove."); }
  };
  readonly #messages = new Map<string, NativeMessage[]>();
  readonly #operations = new Map<string, { access: Record<string, unknown>; childId?: string; confirmed?: boolean; cleaned: boolean }>();
  readonly queryInputs: Array<{ sessionId: string; content: string; consumedInitCwd?: string }> = [];
  readonly managerCalls: string[] = [];
  readonly checkoutCalls: string[] = [];
  readonly releasedPaths: string[] = [];
  readonly connector: RemoteConnector;
  managerSha256 = "";
  deriveCount = 0;
  lastPlan: RemoteGitCheckoutPlan | undefined;
  interruptNextCheckoutDerivation = false;
  interruptNextCheckoutRelease = false;
  beforeCheckoutDeriveReply: (() => Promise<void>) | undefined;

  constructor() {
    const capabilities = {
      commandExecution: true, processStreaming: true, fileTransfer: true,
      tcpForwarding: true, interactiveTerminal: false
    };
    this.connector = {
      capabilities,
      connect: async (request) => {
        request.onAuthenticating();
        await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Buffer.from("remote-claude-e2e-key") });
        return {
          capabilities,
          processes: this.#processes,
          files: this.#files,
          forwarding: {
            open: async () => { throw new Error("Unexpected forward stream."); },
            listen: async () => ({ remoteHost: "127.0.0.1" as const, remotePort: 33171,
              close: async () => undefined })
          },
          execute: async (request) => this.execute(request.input ?? ""),
          close: async () => undefined
        };
      }
    };
  }

  async initialize(): Promise<void> {
    this.managerSha256 = createHash("sha256").update(await loadClaudeRemoteManagerSource()).digest("hex");
  }

  activePaths(): string[] { return [...this.#checkouts.values()].map((lease) => lease.path).sort(); }

  storeInterruptedClone(input: { id: string; workspaceAuthority: string; sourceWorkspaceAuthority: string;
    sourceNativeId: string; childId: string; confirmed: boolean }): void {
    this.#interruptedClones.add(input.id);
    this.#operations.set(input.id, {
      access: { kind: "operation", operationId: input.id, generation: 1,
        source: { kind: "import", workspaceAuthority: input.sourceWorkspaceAuthority, sessionId: input.sourceNativeId },
        target: { workspaceAuthority: input.workspaceAuthority } },
      childId: input.childId, confirmed: input.confirmed, cleaned: false
    });
    this.#messages.set(input.childId, this.messages(input.sourceNativeId));
  }

  hasDirectory(path: string): boolean {
    return path === REMOTE_ROOT || this.activePaths().includes(path);
  }

  execute(input: string) {
    const request = JSON.parse(input) as { operation: string; data: unknown };
    this.checkoutCalls.push(request.operation);
    const respond = (value: object) => ({
      stdout: JSON.stringify({ format: 1, ...value }), stderr: "", exitCode: 0, outputCapped: false
    });
    if (request.operation === "probe") return respond({
      status: "source", repositoryRoot: REMOTE_ROOT, sourceCommit: SOURCE_COMMIT,
      sourceSnapshot: `sha256:${"b".repeat(64)}`
    });
    if (request.operation === "derive") {
      const plan = request.data as RemoteGitCheckoutPlan;
      this.lastPlan = plan;
      this.deriveCount += 1;
      const lease: RemoteGitCheckoutLease = {
        id: plan.leaseId, sessionId: plan.sessionId, path: plan.path,
        repositoryRoot: plan.repositoryRoot, branch: plan.branch,
        source: { ref: plan.sourceRef, commit: plan.sourceCommit,
          strategy: "explicit", refreshed: false },
        acquiredAt: Date.now(), remote: plan.remote
      };
      this.#checkouts.set(plan.leaseId, lease);
      if (this.interruptNextCheckoutRelease) {
        this.interruptNextCheckoutRelease = false;
        this.#interruptReleaseFor = lease.id;
      }
      if (this.interruptNextCheckoutDerivation) {
        this.interruptNextCheckoutDerivation = false;
        this.#interruptReleaseFor = lease.id;
        return { ...respond({}), exitCode: 1 };
      }
      return respond({ status: "active", lease });
    }
    const data = request.data as { leaseId?: string; id?: string; path?: string };
    const leaseId = data.leaseId ?? data.id;
    const lease = leaseId === undefined ? undefined : this.#checkouts.get(leaseId);
    if (this.#releasing !== undefined && leaseId === this.#releasing.id) {
      if (request.operation === "inspect") return respond({ status: "releasing", lease: this.#releasing });
      if (request.operation !== "release") return respond({ status: "error", code: "LEASE_CONFLICT" });
      expect(request.data).toEqual(this.#releasing);
      this.#releasing = undefined;
      return respond({ status: "released" });
    }
    if (request.operation === "inspect" || request.operation === "assert") {
      return respond(lease === undefined ? { status: "absent" } : { status: "active", lease });
    }
    if (request.operation === "release" || request.operation === "cleanup") {
      if (lease !== undefined) {
        this.#checkouts.delete(lease.id);
        this.releasedPaths.push(lease.path);
        if (request.operation === "release" && lease.id === this.#interruptReleaseFor) {
          this.#interruptReleaseFor = undefined;
          this.#releasing = lease;
          return { ...respond({}), exitCode: 1 };
        }
      }
      return respond({ status: lease === undefined ? "absent" : "released" });
    }
    throw new Error(`Unexpected remote Git operation ${request.operation}.`);
  }

  manager(method: string, params: Record<string, unknown>, channel: ControlledProcess,
    requestId: string): unknown {
    this.managerCalls.push(method);
    if (method === "hello") return {
      protocolVersion: 1, managerVersion: "0.1.0", managerSha256: this.managerSha256,
      managerGeneration: MANAGER_GENERATION
    };
    if (method === "owner.reconcile") return { reconciled: true };
    if (method === "fresh.getForBinding") return null;
    if (method === "fresh.hasPendingSource") return false;
    if (method === "session.list") return [...this.#messages.keys()].map((id) => this.info(id, REMOTE_ROOT));
    if (method === "session.info") return this.info(String(params.sessionId), REMOTE_ROOT);
    if (method === "session.messages") return this.messages(String(params.sessionId));
    if (method === "store.prepareImport" || method === "store.prepareDerivation") {
      const input = object(params.input);
      const operationId = String(input.operationId);
      const access = {
        kind: "operation", operationId, generation: object(params.authority).generation,
        source: { kind: method === "store.prepareImport" ? "import" : "durable",
          workspaceAuthority: input.sourceWorkspaceAuthority, sessionId: input.sourceSessionId },
        target: { workspaceAuthority: input.targetWorkspaceAuthority }
      };
      this.#operations.set(operationId, { access, cleaned: false });
      return access;
    }
    if (method === "store.import") return { imported: true };
    if (method === "store.fork") {
      const access = object(params.access);
      const operationId = String(access.operationId);
      const operation = this.#operations.get(operationId);
      if (operation === undefined) throw new Error("The remote Store operation was not prepared.");
      const sourceId = String(params.sessionId);
      const childId = randomUUID();
      const sourceMessages = this.messages(sourceId);
      const upTo = params.upToMessageId;
      const boundary = typeof upTo === "string"
        ? sourceMessages.findIndex((item) => item.uuid === upTo) : sourceMessages.length - 1;
      if (boundary < 0) throw new Error("The remote Store fork boundary is absent.");
      this.#messages.set(childId, sourceMessages.slice(0, boundary + 1).map((item) => ({
        ...item, uuid: randomUUID(), session_id: childId
      })));
      operation.childId = childId;
      const callbackId = randomUUID();
      channel.pendingReservation = { callbackId, requestId, childId };
      channel.send({ v: 1, kind: "callback", callbackId, callback: "storeChildReserved", value: {
        operationId, generation: object(params.authority).generation,
        targetWorkspaceAuthority: object(access.target).workspaceAuthority,
        sessionId: childId
      } });
      return undefined;
    }
    if (method === "store.recoverOperation") {
      const input = object(params.input);
      const id = String(input.operationId);
      const operation = this.#operations.get(id);
      if (operation === undefined) throw new Error("NOT_FOUND");
      if (this.#interruptedClones.has(id)) {
        expect(input.targetWorkspaceAuthority).toBe(object(operation.access.target).workspaceAuthority);
        expect(input.expectedChildSessionId).toBe(operation.confirmed ? operation.childId : undefined);
        operation.access = { ...operation.access, generation: object(params.authority).generation };
      }
      return operation.access;
    }
    if (method === "store.readOperation" || method === "store.cleanupOperation") {
      const operationId = String(object(params.access).operationId);
      const operation = this.#operations.get(operationId);
      if (operation === undefined) throw new Error("The remote Store operation is absent.");
      if (method === "store.cleanupOperation") {
        operation.cleaned = true;
        if (this.#interruptedClones.has(operationId)) {
          expect(object(params.input).expectedChildSessionId).toBe(operation.confirmed ? operation.childId : undefined);
          this.cleanupOperations.push(operationId);
          if (operation.childId !== undefined) this.#messages.delete(operation.childId);
        }
      }
      const access = operation.access;
      return {
        operationId: access.operationId, generation: access.generation,
        sourceKind: object(access.source).kind,
        sourceWorkspaceAuthority: object(access.source).workspaceAuthority,
        sourceSessionId: object(access.source).sessionId,
        targetWorkspaceAuthority: object(access.target).workspaceAuthority,
        state: operation.cleaned ? "cleaned" : "child_reserved",
        sourceProjectKeyCaptured: true, targetProjectKeyCaptured: true,
        sourceEntryCount: 2, sourceBytes: 100, revision: 1,
        childReservationConfirmed: operation.confirmed ?? (operation.childId !== undefined),
        ...(operation.childId === undefined ? {} : { childSessionId: operation.childId })
      };
    }
    if (method === "store.adopt" || method === "store.claim" || method === "store.rebind") {
      const access = method === "store.adopt" ? object(params.access) : object(params.input);
      return {
        kind: "session", generation: object(params.authority).generation,
        workspaceAuthority: method === "store.adopt"
          ? object(access.target).workspaceAuthority : access.workspaceAuthority,
        sessionId: method === "store.adopt" ? params.sessionId : access.sessionId
      };
    }
    if (method === "store.info") return this.info(String(params.sessionId), String(params.dir));
    if (method === "store.messages") return this.messages(String(params.sessionId));
    if (method === "store.delete" || method === "session.delete") {
      this.#messages.delete(String(params.sessionId));
      return { deleted: true };
    }
    if (method === "query.start") {
      const options = object(params.options);
      const queryId = String(params.queryId);
      const sessionId = String(params.sessionId);
      channel.query = { queryId, sessionId, cwd: String(options.cwd), sequence: 0 };
      queueMicrotask(() => channel.event("message", claudeInit(sessionId, String(options.cwd))));
      return { queryId, sessionId, attachmentId: randomUUID(), lastSeq: 0,
        ended: false, retired: false };
    }
    if (method === "query.input") {
      const message = object(params.message);
      const content = object(message.message).content;
      const query = channel.query;
      if (query === undefined) throw new Error("The remote Query was not started.");
      const consumedInput: { sessionId: string; content: string; consumedInitCwd?: string } = {
        sessionId: query.sessionId, content: String(content)
      };
      this.queryInputs.push(consumedInput);
      const assistantId = randomUUID();
      const history = this.#messages.get(query.sessionId) ?? [];
      history.push(nativeMessage("user", String(message.uuid), query.sessionId, String(content)));
      history.push(nativeMessage("assistant", assistantId, query.sessionId, "Controlled remote answer."));
      this.#messages.set(query.sessionId, history);
      queueMicrotask(() => {
        const init = claudeInit(query.sessionId, query.cwd);
        channel.event("message", init);
        consumedInput.consumedInitCwd = init.cwd;
        channel.event("message", { type: "assistant", uuid: assistantId,
          session_id: query.sessionId,
          message: { role: "assistant", content: [{ type: "text", text: "Controlled remote answer." }] } });
        channel.event("message", claudeResult(query.sessionId, String(message.uuid)));
      });
      return { accepted: true };
    }
    if (method === "query.initializationResult") return {
      models: [{ value: "fixture-model", displayName: "Fixture", description: "Controlled remote manager" }],
      account: { tokenSource: "fixture" }
    };
    if (method === "query.supportedModels") return [
      { value: "fixture-model", displayName: "Fixture", description: "Controlled remote manager" }
    ];
    if (method === "query.accountInfo") return { tokenSource: "fixture" };
    if (method === "query.interrupt") return { still_queued: [] };
    if (method === "query.retire" || method === "query.retireOwned") {
      channel.event("retired");
      return { retired: true };
    }
    if (["query.setModel", "query.setPermissionMode", "query.applyFlagSettings", "query.stopTask"].includes(method)) {
      return null;
    }
    throw new Error(`Unexpected remote manager method ${method}.`);
  }

  info(sessionId: string, cwd: string) {
    return this.#messages.has(sessionId)
      ? { sessionId, summary: "Controlled remote history", lastModified: 1, cwd } : null;
  }

  messages(sessionId: string): NativeMessage[] { return [...(this.#messages.get(sessionId) ?? [])]; }
}

class ControlledProcesses implements RemoteProcessTransportPort {
  readonly #remote: ControlledRemoteClaude;
  constructor(remote: ControlledRemoteClaude) { this.#remote = remote; }
  async open(request: RemoteProcessStartRequest): Promise<RemoteProcessHandle> {
    if (request.executable === "/bin/sh") {
      return new ControlledProcess(undefined, (process) => {
        process.stdout.write([
          request.cwd ?? REMOTE_ROOT, RUNTIME_ROOT,
          `${RUNTIME_ROOT}/current/node/bin/node`, `${RUNTIME_ROOT}/current/manager.mjs`,
          `${RUNTIME_ROOT}/current/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`,
          `${RUNTIME_ROOT}/run/manager.sock`, CLAUDE_AGENT_SDK_VERSION, CLAUDE_AGENT_SDK_CLI_VERSION, "ready", ""
        ].join("\0"));
        process.finish(0);
      });
    }
    if (request.args[0] === "-e") {
      return new ControlledProcess(undefined, async (process, input) => {
        const result = this.#remote.execute(input);
        if ((JSON.parse(input) as { operation: string }).operation === "derive") {
          const beforeReply = this.#remote.beforeCheckoutDeriveReply;
          this.#remote.beforeCheckoutDeriveReply = undefined;
          await beforeReply?.();
        }
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        process.finish(result.exitCode);
      });
    }
    return new ControlledProcess((frame, process) => {
      if (frame.kind === "callback_result") {
        const pending = process.pendingReservation;
        if (pending !== undefined && frame.callbackId === pending.callbackId) {
          process.pendingReservation = undefined;
          process.respond(pending.requestId, { sessionId: pending.childId });
        }
        return;
      }
      if (frame.kind !== "request" || typeof frame.id !== "string" || typeof frame.method !== "string") return;
      try {
        const result = this.#remote.manager(frame.method, object(frame.params), process, frame.id);
        if (result !== undefined) process.respond(frame.id, result);
      } catch (error) {
        process.reject(frame.id, error instanceof Error ? error.message : "fixture_failure");
      }
    });
  }
}

class ControlledProcess extends EventEmitter implements RemoteProcessHandle {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly pid = 42;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  query: { queryId: string; sessionId: string; cwd: string; sequence: number } | undefined;
  pendingReservation: { callbackId: string; requestId: string; childId: string } | undefined;
  #buffer = "";
  #closed = false;

  constructor(
    onFrame?: (frame: Record<string, unknown>, process: ControlledProcess) => void,
    onEnd?: (process: ControlledProcess, input: string) => void | Promise<void>
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.#buffer += Buffer.from(chunk).toString("utf8");
        try {
          for (;;) {
            const newline = this.#buffer.indexOf("\n");
            if (newline < 0) break;
            const line = this.#buffer.slice(0, newline);
            this.#buffer = this.#buffer.slice(newline + 1);
            onFrame?.(JSON.parse(line) as Record<string, unknown>, this);
          }
          callback();
        } catch (error) { callback(error as Error); }
      },
      final: (callback) => {
        Promise.resolve().then(() => onEnd?.(this, this.#buffer)).then(() => {
          queueMicrotask(() => this.finish(this.exitCode ?? 0)); callback();
        }, (error: unknown) => callback(error instanceof Error ? error : new Error("The controlled remote process failed.")));
      }
    });
  }

  respond(id: string, value: unknown): void { this.send({ v: 1, kind: "response", id, ok: true, value }); }
  reject(id: string, code: string): void {
    this.send({ v: 1, kind: "response", id, ok: false, error: { code, stateMayHaveChanged: false } });
  }
  event(event: "message" | "retired", value?: unknown): void {
    if (this.query === undefined) return;
    this.send({ v: 1, kind: "event", queryId: this.query.queryId,
      seq: ++this.query.sequence, event, ...(value === undefined ? {} : { value }) });
  }
  send(value: unknown): void { if (!this.#closed) this.stdout.write(`${JSON.stringify(value)}\n`); }
  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.#closed) return false;
    this.signalCode = typeof signal === "string" ? signal : "SIGTERM";
    this.finish(null);
    return true;
  }
  finish(code: number | null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, this.signalCode);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a record.");
  return value as Record<string, unknown>;
}

function nativeMessage(type: "user" | "assistant", uuid: string, sessionId: string, text: string): NativeMessage {
  return {
    type, uuid, session_id: sessionId, parent_tool_use_id: null, parent_agent_id: null,
    message: { role: type, content: type === "user" ? text : [{ type: "text", text }] }
  };
}

function claudeInit(sessionId: string, cwd: string) {
  return {
    type: "system", subtype: "init", session_id: sessionId, uuid: randomUUID(),
    claude_code_version: CLAUDE_AGENT_SDK_CLI_VERSION, apiKeySource: "none", cwd, model: "fixture-model",
    permissionMode: "default", tools: ["Read"], mcp_servers: [], slash_commands: [],
    output_style: "default", skills: [], plugins: [], capabilities: []
  };
}

function claudeResult(sessionId: string, userMessageUuid: string) {
  return {
    type: "result", subtype: "success", duration_ms: 10, duration_api_ms: 8,
    is_error: false, num_turns: 1, result: "Controlled remote answer.", stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: { input_tokens: 10, output_tokens: 5,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { "fixture-model": { inputTokens: 10, outputTokens: 5,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0,
      costUSD: 0, contextWindow: 200_000, maxOutputTokens: 32_000 } },
    permission_denials: [], terminal_reason: "completed", origin: { kind: "human" },
    user_message_uuid: userMessageUuid, uuid: randomUUID(), session_id: sessionId
  };
}
