import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { create } from "@bufbuild/protobuf";
import {
  CLAUDE_AGENT_SDK_VERSION,
  ClaudeCodeAdapter,
  type ClaudeSdkProbeInput
} from "@joko/adapter-claude-code";
import { createDefaultPiManagedProcessSupervisor } from "@joko/adapter-pi";
import {
  DefaultClaudeSdkRuntime,
  SessionSdkFailure,
  SessionSdkOwner,
  createClaudeSessionStoreAuthority,
  type ClaudeSdkForkOptions,
  type ClaudeSdkGetSessionMessagesOptions,
  type ClaudeSdkInitializationResult,
  type ClaudeSdkListSessionsOptions,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryParams,
  type ClaudeSdkRuntime,
  type ClaudeSdkSessionInfo,
  type ClaudeSdkSessionMessage,
  type ClaudeSdkStoredSessionRuntime,
  type ClaudeSdkUserMessage
} from "@joko/adapter-claude-code/testing";
import { NativeNavigationTargetSchema, NativeSessionStartSchema, OperationMutationSchema, OperationState, RunState, type Event } from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { createE2eClients } from "./connect-clients.js";
import { OrchestratorE2eFixture, waitFor, type E2eClients } from "./fixture.js";
import {
  createSessionMutation,
  deleteMutation,
  forkMutation,
  navigateMutation,
  sendInputMutation,
  sessionIdFrom,
  submit
} from "./operations.js";

const backendId = "claude-code";
const storageName = "fork-product-chain";
const initialization: ClaudeSdkInitializationResult = {
  models: [{ value: "fixture-model", displayName: "Fixture model", description: "Local controlled Query" }],
  account: { tokenSource: "fixture" }
};

const sdkTransport = vi.hoisted(() => ({
  createSdkMcpServer: vi.fn((options: unknown) => ({ type: "sdk", name: "fixture", instance: options })),
  query: vi.fn(),
  startup: vi.fn()
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => sdkTransport);

it("keeps a standard local Claude Store fork bound across adoption, restart, refork, delete, and cleanup crash recovery", { timeout: 300_000 }, async () => {
  const seed = await seedNativeHistory();
  const queries: StoreBackedProductQuery[] = [];
  const storedForks: Array<{ readonly sourceId: string; readonly dir: string; readonly upToMessageId?: string }> = [];
  const cleanupOperations: string[] = [];
  configureStoredSdkTransport(queries);
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    let started = await startStored(seed, queries, storedForks, cleanupOperations);
    fixture = started.fixture;
    const paired = await fixture.pair();
    const storedClients = createE2eClients(fixture.baseUrl, paired.authKey, 60_000);
    const sourceId = await attachSource(fixture, { ...paired, clients: storedClients }, seed.sourceId);
    expect(fixture.application.store.getSession(sourceId).descriptor.worktree).toBeUndefined();
    expect(fixture.application.store.getBackend(backendId).descriptor.capabilities.get("workspace.derive"))
      .toMatchObject({ supported: true });

    const sourceTimeline = await timeline(storedClients, sourceId);
    const sourceAnchor = messageAnchor(sourceTimeline, seed.messageIds[1]!);
    const sourceHead = (await git(seed.workspace, ["rev-parse", "HEAD"])).trim();
    const sourceStatus = await git(seed.workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const sourceIndex = await git(seed.workspace, ["diff", "--cached", "--binary"]);
    const sourceWorktree = await git(seed.workspace, ["diff", "--binary"]);

    const operationId = randomUUID();
    const originalAdopt = started.adapter.adoptNativeSessionDerivation.bind(started.adapter);
    let nativeOperationId: string | undefined;
    let productAdoption: ReturnType<typeof fixture.application.store.findNativeSessionDerivation>;
    const adoptionSpy = vi.spyOn(started.adapter, "adoptNativeSessionDerivation")
      .mockImplementationOnce(async (lifecycle, signal) => {
        nativeOperationId = lifecycle.operationId;
        productAdoption = fixture!.application.store.findNativeSessionDerivation(lifecycle.operationId);
        expect(productAdoption).toMatchObject({ state: "product_adopted", binding: lifecycle.binding });
        await originalAdopt(lifecycle, signal);
        throw new Error("Controlled loss of the Store adoption acknowledgement.");
      });
    let interrupted: Awaited<ReturnType<typeof submit>> | undefined;
    try {
      interrupted = await submit(
        storedClients.operation,
        paired.connectionId,
        forkMutation(sourceId, seed.messageIds[1]!, sourceAnchor),
        operationId
      );
    } finally {
      adoptionSpy.mockRestore();
    }
    expect(interrupted).toMatchObject({
      state: OperationState.FAILED,
      error: { code: "EFFECT_FAILED", message: "Controlled loss of the Store adoption acknowledgement." }
    });
    if (nativeOperationId === undefined) throw new Error("The Store-backed fork has no native derivation operation.");
    expect(fixture.application.store.getOperation(nativeOperationId).status).toBe("completed");
    const pendingReceipt = fixture.application.store.findNativeSessionDerivation(nativeOperationId);
    if (pendingReceipt?.binding === undefined || pendingReceipt.worktree === undefined) {
      throw new Error("The Store-backed fork did not durably retain its Product-adopted worktree.");
    }
    const derivedId = pendingReceipt.sessionId;
    const derivedPath = pendingReceipt.worktree.path;
    expect(productAdoption).toMatchObject({
      state: "product_adopted",
      sessionId: derivedId,
      binding: pendingReceipt.binding,
      worktree: pendingReceipt.worktree
    });
    expect(pendingReceipt).toMatchObject({
      state: "product_adopted",
      sessionId: derivedId,
      effectiveWorkspaceRoot: derivedPath,
      binding: {
        nativeSessionId: expect.any(String),
        opaqueRef: expect.stringMatching(/^claude-code:stored-session:/u)
      },
      worktree: { state: "active", path: derivedPath }
    });
    expect(fixture.application.store.getSession(derivedId).descriptor).toMatchObject({
      binding: pendingReceipt.binding,
      worktree: pendingReceipt.worktree
    });
    expect(storedForks).toHaveLength(1);
    expect(resolve(derivedPath)).not.toBe(resolve(seed.workspace));
    await expect(access(derivedPath)).resolves.toBeUndefined();
    expect((await git(seed.workspace, ["rev-parse", "HEAD"])).trim()).toBe(sourceHead);
    expect(await git(seed.workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
      .toBe(sourceStatus);
    expect(await git(seed.workspace, ["diff", "--cached", "--binary"])).toBe(sourceIndex);
    expect(await git(seed.workspace, ["diff", "--binary"])).toBe(sourceWorktree);

    await fixture.close({ removeRoot: false });
    started = await startStored(seed, queries, storedForks, cleanupOperations);
    fixture = started.fixture;
    const restartedClients = createE2eClients(fixture.baseUrl, paired.authKey, 60_000);
    const adoptedReceipt = fixture.application.store.findNativeSessionDerivation(nativeOperationId);
    expect(adoptedReceipt).toMatchObject({
      state: "adopted",
      sessionId: derivedId,
      binding: pendingReceipt.binding,
      worktree: pendingReceipt.worktree,
      backendInstanceGeneration: pendingReceipt.backendInstanceGeneration,
      lifecycleOwnerGeneration: pendingReceipt.lifecycleOwnerGeneration + 1
    });
    if (adoptedReceipt?.binding === undefined || adoptedReceipt.worktree === undefined) {
      throw new Error("Startup recovery did not adopt the exact Store Session and worktree.");
    }
    expect(storedForks).toHaveLength(1);
    expect(fixture.application.store.getSession(derivedId).descriptor.worktree).toEqual(pendingReceipt.worktree);
    await expect(access(derivedPath)).resolves.toBeUndefined();

    const queriesBeforeResume = queries.length;
    await resume(restartedClients, paired.connectionId, derivedId);
    const storedQuery = queries.slice(queriesBeforeResume).find((query) => query.resume === adoptedReceipt.binding!.nativeSessionId);
    if (storedQuery === undefined) throw new Error("The adopted Store Session did not create its resumed Query.");
    expect(storedQuery).toMatchObject({
      cwd: derivedPath,
      resume: adoptedReceipt.binding.nativeSessionId,
      sessionId: undefined,
      sessionStoreConfigured: true,
      startupInitializationCwd: derivedPath,
      loadedEntryCount: 3,
      loadedEntryTypes: ["user", "assistant", "custom-title"]
    });
    expect(storedQuery.projectKey).toBe(claudeProjectKey(derivedPath));
    const restoredTimeline = await timeline(restartedClients, derivedId);
    const restoredHistory = historyMessages(restoredTimeline);
    expect(restoredHistory).toHaveLength(2);
    expect(JSON.stringify(restoredTimeline, (_key, value: unknown) => typeof value === "bigint" ? String(value) : value))
      .toContain("first answer");

    const send = await submit(
      restartedClients.operation,
      paired.connectionId,
      sendInputMutation(
        derivedId,
        BigInt(fixture.application.store.getSession(derivedId).descriptor.binding.generation),
        "continue in the managed workspace"
      )
    );
    expect(send.state).toBe(OperationState.SUCCEEDED);
    await waitFor(
      async () => ({ inputs: storedQuery.receivedInputs.length, persisted: storedQuery.persistedEntryCount }),
      (value) => value.inputs === 1 && value.persisted === 5,
      "the Store-backed Query to consume and persist the input",
      10_000
    );
    expect(storedQuery.turnInitializationCwds).toEqual([derivedPath]);
    await waitFor(
      async () => await timeline(restartedClients, derivedId),
      (events) => JSON.stringify(events, (_key, value: unknown) => typeof value === "bigint" ? String(value) : value)
        .includes("Controlled Store-backed response."),
      "the Store-backed turn to complete",
      10_000
    );
    await waitFor(
      () => restartedClients.run.listRuns({ sessionId: derivedId }),
      (value) => value.runs.length === 1 && value.runs.every((run) => run.state === RunState.SUCCEEDED),
      "the consumed Store-backed input to reach a durable terminal Run",
      10_000
    );

    const restoredAssistant = restoredHistory[1]!;
    if (restoredAssistant.payload?.kind.case !== "messageCompleted") throw new Error("The restored assistant boundary is absent.");
    const restoredEntryId = restoredAssistant.payload.kind.value.nativeIdentity?.entryId;
    if (restoredEntryId === undefined) throw new Error("The restored assistant has no native identity.");
    const reforkOperationId = randomUUID();
    const originalReforkAdopt = started.adapter.adoptNativeSessionDerivation.bind(started.adapter);
    let reforkNativeOperationId: string | undefined;
    const reforkAdoptionSpy = vi.spyOn(started.adapter, "adoptNativeSessionDerivation")
      .mockImplementationOnce(async (lifecycle, signal) => {
        reforkNativeOperationId = lifecycle.operationId;
        await originalReforkAdopt(lifecycle, signal);
      });
    let refork: Awaited<ReturnType<typeof submit>>;
    try {
      refork = await submit(
        restartedClients.operation,
        paired.connectionId,
        forkMutation(derivedId, restoredEntryId, messageAnchor(restoredTimeline, restoredEntryId)),
        reforkOperationId
      );
    } finally {
      reforkAdoptionSpy.mockRestore();
    }
    if (refork.state !== OperationState.SUCCEEDED) {
      throw new Error(`The restarted Store refork failed: ${JSON.stringify({ refork, diagnostics: fixture.application.store.listDiagnostics().slice(-10) }, (_key, value: unknown) => typeof value === "bigint" ? String(value) : value)}`);
    }
    const reforkId = sessionIdFrom(refork);
    const reforkDescriptor = fixture.application.store.getSession(reforkId).descriptor;
    if (reforkDescriptor.worktree === undefined) throw new Error("The Store refork has no managed worktree.");
    if (reforkNativeOperationId === undefined) throw new Error("The Store refork has no native derivation operation.");
    expect(reforkDescriptor.binding.opaqueRef).toMatch(/^claude-code:stored-session:/u);
    expect(resolve(reforkDescriptor.worktree.path)).not.toBe(resolve(derivedPath));
    expect(fixture.application.store.findNativeSessionDerivation(reforkNativeOperationId)).toMatchObject({
      state: "adopted",
      sessionId: reforkId,
      binding: reforkDescriptor.binding,
      worktree: reforkDescriptor.worktree
    });
    await expect(access(reforkDescriptor.worktree.path)).resolves.toBeUndefined();

    const deleted = await submit(
      restartedClients.operation,
      paired.connectionId,
      deleteMutation(reforkId, true)
    );
    expect(deleted.state).toBe(OperationState.SUCCEEDED);
    expect(fixture.application.store.getSession(reforkId).descriptor.deletedAt).toEqual(expect.any(Number));
    await expect(access(reforkDescriptor.worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(derivedPath)).resolves.toBeUndefined();

    const cleaned = await failStoredForkAfterReceipt({
      fixture,
      adapter: started.adapter,
      clients: restartedClients,
      connectionId: paired.connectionId,
      sourceId,
      entryId: seed.messageIds[1]!,
      anchor: sourceAnchor,
      cleanupUnknown: false
    });
    expect(cleaned.state).toBe("cleaned");
    if (cleaned.worktree === undefined) throw new Error("The cleaned derivation has no exact worktree receipt.");
    await expect(access(cleaned.worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(derivedPath)).resolves.toBeUndefined();

    const unknown = await failStoredForkAfterReceipt({
      fixture,
      adapter: started.adapter,
      clients: restartedClients,
      connectionId: paired.connectionId,
      sourceId,
      entryId: seed.messageIds[1]!,
      anchor: sourceAnchor,
      cleanupUnknown: true
    });
    expect(unknown.state).toBe("cleanup_unknown");
    if (unknown.worktree === undefined) throw new Error("The unknown cleanup lost its exact worktree receipt.");
    await expect(access(unknown.worktree.path)).resolves.toBeUndefined();
    await expect(access(derivedPath)).resolves.toBeUndefined();

    const nativeCleanupCountBeforePendingWorkspace = cleanupOperations.length;
    const pendingWorkspaceCleanup = await failStoredForkAfterReceipt({
      fixture,
      adapter: started.adapter,
      clients: restartedClients,
      connectionId: paired.connectionId,
      sourceId,
      entryId: seed.messageIds[1]!,
      anchor: sourceAnchor,
      cleanupUnknown: false,
      failCleanedStoreWrite: true
    });
    expect(pendingWorkspaceCleanup.state).toBe("workspace_cleanup_pending");
    if (pendingWorkspaceCleanup.worktree === undefined) {
      throw new Error("The pending workspace cleanup lost its exact worktree receipt.");
    }
    expect(cleanupOperations).toHaveLength(nativeCleanupCountBeforePendingWorkspace + 1);
    await expect(access(pendingWorkspaceCleanup.worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(derivedPath)).resolves.toBeUndefined();

    const storedForkCountBeforeCleanupRecovery = storedForks.length;
    const nativeCleanupCountBeforeRecovery = cleanupOperations.length;

    await fixture.close({ removeRoot: false });
    started = await startStored(seed, queries, storedForks, cleanupOperations);
    fixture = started.fixture;
    expect(storedForks).toHaveLength(storedForkCountBeforeCleanupRecovery);
    expect(cleanupOperations).toHaveLength(nativeCleanupCountBeforeRecovery);
    expect(fixture.application.store.findNativeSessionDerivation(pendingWorkspaceCleanup.operationId)).toMatchObject({
      state: "cleaned",
      worktree: pendingWorkspaceCleanup.worktree
    });
    await expect(access(pendingWorkspaceCleanup.worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.application.store.findNativeSessionDerivation(unknown.operationId)).toMatchObject({
      state: "cleanup_unknown",
      worktree: unknown.worktree
    });
    expect(fixture.application.sessionWorktrees.activeWorkspacePath(unknown.sessionId, unknown.worktree))
      .toBe(unknown.worktree.path);
    await expect(access(unknown.worktree.path)).resolves.toBeUndefined();
    await expect(access(derivedPath)).resolves.toBeUndefined();
  } finally {
    try {
      await fixture?.close({ removeRoot: false });
    } finally {
      sdkTransport.query.mockReset();
      sdkTransport.startup.mockReset();
      await rm(seed.root, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

it("adopts a Claude fork through HTTP and rebuilds its message identities before a second fork and restart replay", async () => {
  const seed = await seedNativeHistory();
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    let started = await start(seed);
    fixture = started.fixture;
    const paired = await fixture.pair();
    const sourceId = await attachSource(fixture, paired, seed.sourceId);
    const sourceTimeline = await timeline(paired.clients, sourceId);
    const anchor = messageAnchor(sourceTimeline, seed.messageIds[1]!);
    const sourceDescriptor = fixture.application.store.getSession(sourceId).descriptor;
    const sourceBinding = sourceDescriptor.binding;
    expect(sourceDescriptor.worktree).toBeUndefined();
    expect(fixture.application.store.getBackend(backendId).descriptor.capabilities.get("workspace.derive"))
      .toMatchObject({ supported: false });
    const sourceHead = (await git(seed.workspace, ["rev-parse", "HEAD"])).trim();
    const sourceStatus = await git(seed.workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const sourceIndex = await git(seed.workspace, ["diff", "--cached", "--binary"]);
    const sourceWorktree = await git(seed.workspace, ["diff", "--binary"]);
    const operationId = randomUUID();
    const mutation = forkMutation(sourceId, seed.messageIds[1]!, anchor);
    let nativeOperationId: string | undefined;
    started.runtime.onReceipt = (nativeId) => {
      const operation = fixture!.application.store.listOperations().find((item) => item.kind === "fork_session" && item.status === "started");
      expect(operation).toBeDefined();
      nativeOperationId = operation!.id;
      expect(fixture!.application.store.findNativeSessionDerivation(operation!.id)).toMatchObject({
        state: "recorded", sourceSessionId: sourceId, binding: { nativeSessionId: nativeId }
      });
      expect(fixture!.application.store.listSessions()).toHaveLength(1);
    };
    const forkOperation = await submit(paired.clients.operation, paired.connectionId, mutation, operationId);
    expect(forkOperation.error).toBeUndefined();
    expect(forkOperation.state).toBe(OperationState.SUCCEEDED);
    const derivedId = sessionIdFrom(forkOperation);
    const derivedDescriptor = fixture.application.store.getSession(derivedId).descriptor;
    const derivedBinding = derivedDescriptor.binding;
    expect(derivedDescriptor.worktree).toBeUndefined();
    expect(derivedBinding.nativeSessionId).not.toBe(sourceBinding.nativeSessionId);
    expect(resolve(started.runtime.forks[0]!.dir)).toBe(resolve(seed.workspace));
    expect((await git(seed.workspace, ["rev-parse", "HEAD"])).trim()).toBe(sourceHead);
    expect(await git(seed.workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
      .toBe(sourceStatus);
    expect(await git(seed.workspace, ["diff", "--cached", "--binary"])).toBe(sourceIndex);
    expect(await git(seed.workspace, ["diff", "--binary"])).toBe(sourceWorktree);
    expect(fixture.application.store.findNativeSessionDerivation(nativeOperationId!)).toMatchObject({ state: "adopted", sessionId: derivedId, binding: derivedBinding });
    expect(fixture.application.store.getSession(derivedId).descriptor.derivationOrigin).toEqual({ kind: "fork", sourceSessionId: sourceId, sourceMessageId: anchor.messageId, sourceEventId: anchor.eventId });
    await resume(paired.clients, paired.connectionId, derivedId);
    const derivedTimeline = await timeline(paired.clients, derivedId);
    const derivedMessages = historyMessages(derivedTimeline);
    expect(derivedMessages).toHaveLength(2);
    expect(derivedMessages.every((event) => {
      const payload = event.payload?.kind;
      return (payload?.case === "messageCompleted" || payload?.case === "messageStarted") && payload.value.nativeIdentity !== undefined
        && !seed.messageIds.includes(payload.value.nativeIdentity.entryId);
    })).toBe(true);
    const visible = JSON.stringify(derivedTimeline, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    expect(visible).toContain("first question");
    expect(visible).toContain("first answer");
    expect(visible).not.toContain("later question");
    expect(derivedTimeline.some((event) => event.payload?.kind.case === "extensionUiEffect")).toBe(false);
    expect(fixture.application.store.getSession(sourceId).descriptor.binding).toEqual(sourceBinding);
    expect(await readFile(seed.sourcePath, "utf8")).toBe(seed.transcript);

    const derivedAnchorEvent = derivedMessages[1]!;
    if (derivedAnchorEvent.payload?.kind.case !== "messageCompleted") throw new Error("Missing derived message.");
    const derivedEntryId = derivedAnchorEvent.payload.kind.value.nativeIdentity!.entryId;
    started.runtime.onReceipt = undefined;
    const secondId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId,
      forkMutation(derivedId, derivedEntryId, messageAnchor(derivedTimeline, derivedEntryId))));
    expect(started.runtime.forks.map((call) => call.upToMessageId)).toEqual([seed.messageIds[1], derivedEntryId]);
    const secondDescriptor = fixture.application.store.getSession(secondId).descriptor;
    expect(secondDescriptor.worktree).toBeUndefined();
    expect(secondDescriptor.binding.nativeSessionId).not.toBe(derivedBinding.nativeSessionId);
    expect(resolve(started.runtime.forks[1]!.dir)).toBe(resolve(seed.workspace));

    await fixture.close({ removeRoot: false });
    started = await start(seed);
    fixture = started.fixture;
    const clients = fixture.clients(paired.authKey);
    expect(sessionIdFrom(await submit(clients.operation, paired.connectionId, mutation, operationId))).toBe(derivedId);
    expect(started.runtime.forks).toEqual([]);
    expect(started.runtime.deletes).toEqual([]);
    expect(fixture.application.store.findNativeSessionDerivation(nativeOperationId!)?.state).toBe("adopted");
    expect(fixture.application.store.getSession(derivedId).descriptor.worktree).toBeUndefined();
    for (const sessionId of [sourceId, derivedId]) await resume(clients, paired.connectionId, sessionId);
    const restored = historyMessages(await timeline(clients, derivedId));
    expect(restored.map((event) => event.eventId)).toEqual(derivedMessages.map((event) => event.eventId));
    expect(fixture.application.store.getSession(sourceId).descriptor.binding.nativeSessionId).toBe(seed.sourceId);
    expect(await readFile(seed.sourcePath, "utf8")).toBe(seed.transcript);
  } finally {
    await fixture?.close({ removeRoot: false });
    await rm(seed.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

it.each(["unobserved", "validation", "cleanup-unknown"] as const)("keeps a %s Claude fork outcome durable across HTTP replay and restart without repeating the native effect", async (failure) => {
  const seed = await seedNativeHistory();
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    let started = await start(seed);
    fixture = started.fixture;
    const paired = await fixture.pair();
    const sourceId = await attachSource(fixture, paired, seed.sourceId);
    const anchor = messageAnchor(await timeline(paired.clients, sourceId), seed.messageIds[1]!);
    const operationId = randomUUID();
    const mutation = forkMutation(sourceId, seed.messageIds[1]!, anchor);
    started.runtime.failure = failure;
    const failed = await submit(paired.clients.operation, paired.connectionId, mutation, operationId);
    expect(failed).toMatchObject({ state: OperationState.FAILED, error: { code: "NATIVE_SESSION_FORK_UNKNOWN" } });
    expect(started.runtime.forks).toHaveLength(1);
    const forkDirectory = started.runtime.forks[0]!.dir;
    expect(resolve(forkDirectory)).toBe(resolve(seed.workspace));
    expect(started.runtime.created).toHaveLength(1);
    const nativeId = started.runtime.created[0]!;
    const nativeOperation = fixture.application.store.listOperations().find((operation) => operation.kind === "fork_session");
    expect(nativeOperation).toMatchObject({ status: "failed", error: { stateMayHaveChanged: true } });
    const receipt = fixture.application.store.findNativeSessionDerivation(nativeOperation!.id);
    if (failure === "unobserved") {
      expect(receipt).toBeUndefined();
      expect(started.runtime.deletes).toEqual([]);
      expect(await started.runtime.getSessionInfo(nativeId, { dir: seed.workspace })).toBeDefined();
    } else {
      expect(receipt?.state).toBe(failure === "validation" ? "cleaned" : "cleanup_unknown");
      expect(started.runtime.deletes).toEqual([nativeId]);
      expect(await started.runtime.getSessionInfo(nativeId, { dir: forkDirectory })).toBeUndefined();
    }
    expect(fixture.application.store.listSessions()).toHaveLength(1);
    expect(await readFile(seed.sourcePath, "utf8")).toBe(seed.transcript);
    const failureState = (await paired.clients.operation.getOperation({ operationId })).operation;
    expect(failureState?.state).toBe(OperationState.FAILED);
    expect(await submit(paired.clients.operation, paired.connectionId, mutation, operationId)).toMatchObject({ state: OperationState.FAILED, error: { code: "NATIVE_SESSION_FORK_UNKNOWN" } });
    expect(started.runtime.forks).toHaveLength(1);
    await fixture.close({ removeRoot: false });
    started = await start(seed);
    fixture = started.fixture;
    const clients = fixture.clients(paired.authKey);
    expect(await submit(clients.operation, paired.connectionId, mutation, operationId)).toMatchObject({ state: OperationState.FAILED, error: { code: "NATIVE_SESSION_FORK_UNKNOWN" } });
    expect((await clients.operation.getOperation({ operationId })).operation?.state).toBe(OperationState.FAILED);
    expect(started.runtime.forks).toEqual([]);
    expect(started.runtime.deletes).toEqual([]);
    expect(fixture.application.store.findNativeSessionDerivation(nativeOperation!.id)?.state).toBe(receipt?.state);
    await resume(clients, paired.connectionId, sourceId);
    expect(historyMessages(await timeline(clients, sourceId))).toHaveLength(3);
    expect(await readFile(seed.sourcePath, "utf8")).toBe(seed.transcript);
  } finally {
    await fixture?.close({ removeRoot: false });
    await rm(seed.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

it("rewinds the same product task before a selected user, publishes only its retained fresh native prefix, and replays after restart", async () => {
  const seed = await seedNativeHistory();
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    let started = await start(seed);
    fixture = started.fixture;
    const paired = await fixture.pair();
    const sourceId = await attachSource(fixture, paired, seed.sourceId);
    const source = fixture.application.store.getSession(sourceId);
    const before = await timeline(paired.clients, sourceId);
    const user = historyMessages(before).at(-1)!;
    if (user.payload?.kind.case !== "messageCompleted" && user.payload?.kind.case !== "messageStarted") throw new Error("Missing selected user.");
    const boundary = user.payload.kind.value.nativeIdentity?.rewindBefore;
    expect(boundary?.kind).toEqual({ case: "nativeEntryId", value: seed.messageIds[1] });
    fixture.application.store.appendEvent({ sessionId: sourceId, targetId: source.descriptor.targetId, backendId,
      generation: source.descriptor.binding.generation, traceId: "unindexed-old-output",
      payload: { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "unindexed future answer" }] } });
    const mutation = navigateMutation(sourceId, boundary!, BigInt(source.descriptor.binding.generation));
    const operationId = randomUUID();
    let receiptOperationId: string | undefined;
    started.runtime.onReceipt = () => {
      const receipt = fixture!.application.store.listUnadoptedNativeSessionDerivations()[0]!;
      receiptOperationId = receipt.operationId;
      expect(receipt).toMatchObject({ sourceSessionId: sourceId, sessionId: sourceId, state: "recorded" });
      expect(fixture!.application.store.getSession(sourceId).descriptor.binding).toEqual(source.descriptor.binding);
    };
    const completed = await submit(paired.clients.operation, paired.connectionId, mutation, operationId);
    expect(completed.error).toBeUndefined();
    expect(completed.state).toBe(OperationState.SUCCEEDED);
    const replacement = fixture.application.store.getSession(sourceId).descriptor.binding;
    expect(replacement.generation).toBe(source.descriptor.binding.generation + 1);
    expect(replacement.nativeSessionId).not.toBe(seed.sourceId);
    expect(fixture.application.store.findNativeSessionDerivation(receiptOperationId!)?.state).toBe("adopted");
    expect(fixture.application.store.listSessions()).toHaveLength(1);
    const after = await timeline(paired.clients, sourceId);
    expect(historyMessages(after)).toHaveLength(2);
    const serialized = JSON.stringify(after, (_key, value: unknown) => typeof value === "bigint" ? String(value) : value);
    expect(serialized).toContain("first question");
    expect(serialized).toContain("first answer");
    expect(serialized).not.toContain("later question");
    expect(serialized).not.toContain("unindexed future answer");
    expect(historyMessages(after).every((event) => (event.payload?.kind.case === "messageCompleted" || event.payload?.kind.case === "messageStarted")
      && !seed.messageIds.includes(event.payload.kind.value.nativeIdentity!.entryId))).toBe(true);
    expect(await readFile(seed.sourcePath, "utf8")).toBe(seed.transcript);
    await fixture.close({ removeRoot: false });
    started = await start(seed);
    fixture = started.fixture;
    const clients = fixture.clients(paired.authKey);
    expect((await submit(clients.operation, paired.connectionId, mutation, operationId)).state).toBe(OperationState.SUCCEEDED);
    expect(started.runtime.forks).toEqual([]);
    await resume(clients, paired.connectionId, sourceId);
    expect(historyMessages(await timeline(clients, sourceId)).map((event) => event.eventId)).toEqual(historyMessages(after).map((event) => event.eventId));
    expect(fixture.application.store.getSession(sourceId).descriptor.binding).toEqual({ ...replacement, generation: replacement.generation + 1 });
  } finally {
    await fixture?.close({ removeRoot: false });
    await rm(seed.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

it.each(["unobserved", "validation", "cleanup-unknown", "target-changed"] as const)("preserves the original product branch after %s rewind and never repeats its uncertain native effect", async (failure) => {
  const seed = await seedNativeHistory();
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    let started = await start(seed);
    fixture = started.fixture;
    const paired = await fixture.pair();
    const sourceId = await attachSource(fixture, paired, seed.sourceId);
    const source = fixture.application.store.getSession(sourceId);
    const mutation = navigateMutation(sourceId, createNativeTarget(seed.messageIds[1]!), BigInt(source.descriptor.binding.generation));
    const operationId = randomUUID();
    if (failure === "target-changed") {
      started.runtime.onReceipt = () => {
        const target = fixture!.application.store.getTarget(source.descriptor.targetId);
        fixture!.application.store.upsertTarget({ ...target.descriptor, displayName: "Changed target" }, target.metadata);
      };
    } else started.runtime.failure = failure;
    const failed = await submit(paired.clients.operation, paired.connectionId, mutation, operationId);
    expect(failed).toMatchObject({ state: OperationState.FAILED, error: { retryable: false } });
    expect(started.runtime.forks).toHaveLength(1);
    const nativeOperation = fixture.application.store.getOperation(operationId);
    expect(nativeOperation.error).toMatchObject({ stateMayHaveChanged: true });
    const receipt = fixture.application.store.findNativeSessionDerivation(nativeOperation.id);
    expect(receipt?.state).toBe(failure === "unobserved" ? undefined : failure === "cleanup-unknown" ? "cleanup_unknown" : "cleaned");
    expect(fixture.application.store.getSession(sourceId).descriptor.binding).toEqual(source.descriptor.binding);
    expect(historyMessages(await timeline(paired.clients, sourceId))).toHaveLength(3);
    expect(await readFile(seed.sourcePath, "utf8")).toBe(seed.transcript);
    await fixture.close({ removeRoot: false });
    started = await start(seed);
    fixture = started.fixture;
    const clients = fixture.clients(paired.authKey);
    expect((await submit(clients.operation, paired.connectionId, mutation, operationId)).state).toBe(OperationState.FAILED);
    expect(started.runtime.forks).toEqual([]);
    expect(started.runtime.deletes).toEqual([]);
    await resume(clients, paired.connectionId, sourceId);
    expect(historyMessages(await timeline(clients, sourceId))).toHaveLength(3);
  } finally {
    await fixture?.close({ removeRoot: false });
    await rm(seed.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

function createNativeTarget(entryId: string) {
  return create(NativeNavigationTargetSchema, { kind: { case: "nativeEntryId", value: entryId } });
}

async function seedNativeHistory() {
  const root = await mkdtemp(join(tmpdir(), "joko-claude-fork-chain-"));
  const workspace = join(root, "workspace");
  const profile = join(root, "native-profile");
  const project = join(profile, "projects", storageName);
  const defaultProject = join(profile, "projects", claudeProjectKey(workspace));
  await Promise.all([mkdir(project, { recursive: true }), mkdir(defaultProject, { recursive: true }), mkdir(workspace)]);
  await git(workspace, ["init", "--initial-branch=main"]);
  await git(workspace, ["config", "user.name", "Joko Test"]);
  await git(workspace, ["config", "user.email", "test@invalid.example"]);
  await writeFile(join(workspace, "tracked.txt"), "initial\n", "utf8");
  await git(workspace, ["add", "tracked.txt"]);
  await git(workspace, ["commit", "-m", "initial"]);
  await writeFile(join(workspace, "tracked.txt"), "staged source state\n", "utf8");
  await git(workspace, ["add", "tracked.txt"]);
  await writeFile(join(workspace, "tracked.txt"), "final source state\n", "utf8");
  const sourceId = randomUUID();
  const messageIds: string[] = [randomUUID(), randomUUID(), randomUUID()];
  const transcript = messageIds.map((uuid, index) => JSON.stringify({
    type: index === 1 ? "assistant" : "user", uuid, parentUuid: index === 0 ? null : messageIds[index - 1],
    sessionId: sourceId, cwd: workspace, timestamp: new Date(index).toISOString(),
    message: index === 1 ? { role: "assistant", content: [{ type: "text", text: "first answer" }] }
      : { role: "user", content: index === 0 ? "first question" : "later question" }
  })).join("\n") + "\n";
  const sourcePath = join(project, `${sourceId}.jsonl`);
  await Promise.all([
    writeFile(sourcePath, transcript),
    writeFile(join(defaultProject, `${sourceId}.jsonl`), transcript)
  ]);
  return { root, workspace, profile, sourceId, messageIds, sourcePath, transcript };
}

async function start(seed: Awaited<ReturnType<typeof seedNativeHistory>>) {
  const runtime = new LocalSessionRuntime(seed.profile);
  const fixture = await OrchestratorE2eFixture.start({
    rootDirectory: seed.root, profiles: [],
    backendFactories: [{ instanceId: backendId, adapterKind: "claude-agent-sdk-stdio", displayName: "Local Claude fixture",
      create: ({ generation }) => new ClaudeCodeAdapter({ instanceGeneration: generation, runtime, environment: {},
        initializationTimeoutMs: 5_000, teardownTimeoutMs: 100 }) }]
  });
  return { fixture, runtime };
}

async function startStored(
  seed: Awaited<ReturnType<typeof seedNativeHistory>>,
  queries: StoreBackedProductQuery[],
  storedForks: Array<{ readonly sourceId: string; readonly dir: string; readonly upToMessageId?: string }>,
  cleanupOperations: string[]
) {
  let adapter: ClaudeCodeAdapter | undefined;
  const fixture = await OrchestratorE2eFixture.start({
    rootDirectory: seed.root,
    profiles: [],
    backendFactories: [{
      instanceId: backendId,
      adapterKind: "claude-agent-sdk-stdio",
      displayName: "Stored local Claude fixture",
      create: ({ generation }) => {
        const runtime = new StoredLocalSessionRuntime({
          profile: seed.profile,
          generation,
          processOwnerRoot: join(seed.root, "claude-process-owner"),
          sessionStoreRoot: join(seed.root, "claude-session-store"),
          queries,
          storedForks,
          cleanupOperations
        });
        adapter = new ClaudeCodeAdapter({
          instanceGeneration: generation,
          runtime,
          environment: { CLAUDE_CONFIG_DIR: seed.profile },
          probeCwd: seed.workspace,
          initializationTimeoutMs: 5_000,
          admissionTimeoutMs: 5_000,
          teardownTimeoutMs: 5_000
        });
        return adapter;
      }
    }]
  });
  if (adapter === undefined) throw new Error("The stored Claude Adapter was not provisioned.");
  return { fixture, adapter };
}

async function failStoredForkAfterReceipt(input: {
  readonly fixture: OrchestratorE2eFixture;
  readonly adapter: ClaudeCodeAdapter;
  readonly clients: E2eClients;
  readonly connectionId: string;
  readonly sourceId: string;
  readonly entryId: string;
  readonly anchor: { readonly messageId: string; readonly eventId: string };
  readonly cleanupUnknown: boolean;
  readonly failCleanedStoreWrite?: boolean;
}) {
  const operationId = randomUUID();
  let nativeOperationId: string | undefined;
  const originalFork = input.adapter.fork.bind(input.adapter);
  const forkSpy = vi.spyOn(input.adapter, "fork").mockImplementationOnce(async (...args) => {
    nativeOperationId = args[1].operationId;
    const result = await originalFork(...args);
    const source = input.fixture.application.store.getSession(input.sourceId);
    const target = input.fixture.application.store.getTarget(source.descriptor.targetId);
    input.fixture.application.store.upsertTarget({
      ...target.descriptor,
      displayName: `${target.descriptor.displayName} changed after native receipt ${randomUUID()}`
    }, target.metadata);
    return result;
  });
  const cleanupSpy = input.cleanupUnknown
    ? vi.spyOn(input.adapter, "cleanupNativeSessionDerivation")
      .mockRejectedValueOnce(new Error("Controlled cleanup acknowledgement loss."))
    : undefined;
  const originalFinishCleanup = input.fixture.application.store.finishNativeSessionDerivationCleanup.bind(
    input.fixture.application.store
  );
  let cleanedStoreWriteFailed = false;
  const finishCleanupSpy = input.failCleanedStoreWrite === true
    ? vi.spyOn(input.fixture.application.store, "finishNativeSessionDerivationCleanup")
      .mockImplementation((finishInput) => {
        if (!cleanedStoreWriteFailed && finishInput.outcome === "cleaned") {
          cleanedStoreWriteFailed = true;
          throw new Error("Controlled loss of the final cleaned Store write.");
        }
        return originalFinishCleanup(finishInput);
      })
    : undefined;
  try {
    const operation = await submit(
      input.clients.operation,
      input.connectionId,
      forkMutation(input.sourceId, input.entryId, input.anchor),
      operationId
    );
    expect(operation.state).toBe(OperationState.FAILED);
  } finally {
    forkSpy.mockRestore();
    cleanupSpy?.mockRestore();
    finishCleanupSpy?.mockRestore();
  }
  if (input.failCleanedStoreWrite === true) expect(cleanedStoreWriteFailed).toBe(true);
  if (nativeOperationId === undefined) throw new Error("The failed Store fork has no native derivation operation.");
  const receipt = input.fixture.application.store.findNativeSessionDerivation(nativeOperationId);
  if (receipt === undefined) throw new Error("The failed Store fork has no durable derivation receipt.");
  return receipt;
}

async function attachSource(fixture: OrchestratorE2eFixture, paired: Awaited<ReturnType<OrchestratorE2eFixture["pair"]>>, nativeId: string) {
  const targetId = fixture.targetId(backendId);
  const discovered = await paired.clients.session.discoverNativeSessions({ targetId });
  const candidate = discovered.sessions.find((session) => session.nativeSessionId === nativeId);
  expect(candidate).toBeDefined();
  const mutation = createSessionMutation({ backendId, targetId });
  if (mutation.payload.case !== "createSession") throw new Error("Invalid attach fixture mutation.");
  mutation.payload.value.nativeStart = create(NativeSessionStartSchema, { kind: { case: "attach", value: { opaqueNativeReference: candidate!.nativeReference } } });
  return sessionIdFrom(await submit(paired.clients.operation, paired.connectionId, mutation));
}

async function resume(clients: E2eClients, connectionId: string, sessionId: string) {
  await submit(clients.operation, connectionId, create(OperationMutationSchema, { payload: { case: "resumeSession", value: { sessionId } } }));
}

async function timeline(clients: E2eClients, sessionId: string) {
  return (await clients.event.getSnapshot({ scope: { kind: { case: "session", value: { sessionId, recentTimelineItems: 200 } } } })).snapshot!.timeline;
}

function historyMessages(events: readonly Event[]) {
  return events.filter((event) => event.payload?.kind.case === "messageCompleted" || event.payload?.kind.case === "messageStarted");
}

function messageAnchor(events: readonly Event[], nativeId: string) {
  const event = events.find((event) => event.payload?.kind.case === "messageCompleted" && event.payload.kind.value.nativeIdentity?.entryId === nativeId);
  if (event?.payload?.kind.case !== "messageCompleted") throw new Error("The persisted native message is absent from the HTTP timeline.");
  return { eventId: event.eventId, messageId: event.payload.kind.value.messageId };
}

function claudeProjectKey(workspace: string): string {
  return resolve(workspace).replace(/[^a-zA-Z0-9]/gu, "-");
}

interface ControlledNativeSessionStore {
  append(
    key: { readonly projectKey: string; readonly sessionId: string },
    entries: readonly Readonly<Record<string, unknown>>[]
  ): Promise<void>;
  load(key: { readonly projectKey: string; readonly sessionId: string }): Promise<unknown[] | null>;
  listSessions(projectKey: string): Promise<readonly { readonly sessionId: string; readonly mtime: number }[]>;
  delete(key: { readonly projectKey: string; readonly sessionId: string }): Promise<void>;
  listSubkeys(key: { readonly projectKey: string; readonly sessionId: string }): Promise<readonly string[]>;
}

interface ControlledNativeQueryOptions {
  readonly abortController: AbortController;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly model?: string;
  readonly permissionMode: string;
  readonly resume?: string;
  readonly sessionId?: string;
  readonly sessionStore?: ControlledNativeSessionStore;
  readonly spawnClaudeCodeProcess?: (options: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly signal: AbortSignal;
  }) => unknown;
}

interface ControlledNativeQueryParams {
  readonly prompt: AsyncIterable<ClaudeSdkUserMessage>;
  readonly options: ControlledNativeQueryOptions;
}

/** The packaged runtime owns Query Store injection and process retirement.
 * Source-mode filesystem SDK calls use the same production owner with its
 * public `.mts` Worker entry because the packaged `.mjs` asset is not built. */
class StoredLocalSessionRuntime implements ClaudeSdkRuntime {
  readonly packageVersion = CLAUDE_AGENT_SDK_VERSION;
  readonly bundledCliVersion = "2.1.259";
  readonly supportsWorkspaceDerivation = true;
  readonly storedSessions: ClaudeSdkStoredSessionRuntime;
  readonly #sessionOwner: SessionSdkOwner;
  readonly #queryRuntime: DefaultClaudeSdkRuntime;

  constructor(options: {
    readonly profile: string;
    readonly generation: number;
    readonly processOwnerRoot: string;
    readonly sessionStoreRoot: string;
    readonly queries: StoreBackedProductQuery[];
    readonly storedForks: Array<{ readonly sourceId: string; readonly dir: string; readonly upToMessageId?: string }>;
    readonly cleanupOperations: string[];
  }) {
    const authority = createClaudeSessionStoreAuthority({
      rootDirectory: options.sessionStoreRoot,
      namespace: `backend-${createHash("sha256").update(backendId, "utf8").digest("hex")}`,
      generation: options.generation
    });
    this.#sessionOwner = new SessionSdkOwner({
      environment: { CLAUDE_CONFIG_DIR: options.profile },
      timeoutMs: 5_000,
      cleanupTimeoutMs: 5_000,
      sessionStoreAuthority: authority,
      workerFactory: (_url, workerOptions) => new Worker(
        new URL("./session-sdk-worker.mts", import.meta.resolve("@joko/adapter-claude-code/testing")),
        workerOptions
      )
    });
    this.#queryRuntime = new DefaultClaudeSdkRuntime({
      processOwner: {
        rootDirectory: options.processOwnerRoot,
        instanceId: backendId,
        generation: options.generation,
        recoverStale: true,
        supervisor: createDefaultPiManagedProcessSupervisor()
      },
      sessionStoreRootDirectory: options.sessionStoreRoot,
      retirementTimeoutMs: 5_000,
      environment: { CLAUDE_CONFIG_DIR: options.profile },
      sessionOperationTimeoutMs: 5_000
    });
    const owner = this.#sessionOwner;
    this.storedSessions = {
      prepareImport: (input) => owner.prepareSessionImport(input),
      prepareDerivation: (input) => owner.prepareStoredSessionDerivation(input),
      readOperation: (access) => owner.readStoredSessionOperation(access),
      recoverOperation: (input) => owner.recoverStoredSessionOperation(input),
      cleanupOperation: (access, input = {}) => {
        options.cleanupOperations.push(access.operationId);
        return owner.cleanupStoredSessionOperation(access, input);
      },
      discardImport: (access) => owner.discardSessionImport(access),
      adopt: (access, sessionId) => owner.adoptStoredSession(access, sessionId),
      claim: (input) => owner.claimStoredSession(input),
      rebind: (input) => owner.rebindStoredSession(input),
      importSession: async (sessionId, input) => {
        await owner.run({
          kind: "importSessionToStore",
          sessionId,
          options: { dir: input.dir },
          access: input.access
        }, { ...(input.signal === undefined ? {} : { signal: input.signal }) });
      },
      forkSession: async (sessionId, input) => {
        options.storedForks.push({
          sourceId: sessionId,
          dir: input.dir,
          ...(input.upToMessageId === undefined ? {} : { upToMessageId: input.upToMessageId })
        });
        return await owner.run({
          kind: "forkStoredSession",
          sessionId,
          options: {
            dir: input.dir,
            ...(input.upToMessageId === undefined ? {} : { upToMessageId: input.upToMessageId })
          },
          access: input.access
        }, { signal: input.signal, recordSessionId: input.recordSessionId }) as { readonly sessionId: string };
      },
      getSessionInfo: async (sessionId, input) => await owner.run({
        kind: "getStoredSessionInfo",
        sessionId,
        options: { dir: input.dir },
        access: input.access
      }, { ...(input.signal === undefined ? {} : { signal: input.signal }) }) as ClaudeSdkSessionInfo | undefined,
      getSessionMessages: async (sessionId, input) => {
        const { access, signal, ...nativeOptions } = input;
        return await owner.run({
          kind: "getStoredSessionMessages",
          sessionId,
          options: nativeOptions,
          access
        }, { ...(signal === undefined ? {} : { signal }) }) as readonly ClaudeSdkSessionMessage[];
      },
      deleteSession: async (sessionId, input) => {
        await owner.run({
          kind: "deleteStoredSession",
          sessionId,
          options: { dir: input.dir },
          access: input.access
        }, { ...(input.signal === undefined ? {} : { signal: input.signal }) });
      },
      ownsOperation: (operationId) => owner.ownsStoreOperation(operationId)
    };
    configureStoredSdkTransport(options.queries);
  }

  probe(input: ClaudeSdkProbeInput) { return this.#queryRuntime.probe(input); }
  query(params: ClaudeSdkQueryParams) { return this.#queryRuntime.query(params); }
  retireQuery(query: ClaudeSdkQuery, timeoutMs: number) { return this.#queryRuntime.retireQuery(query, timeoutMs); }

  async getSessionInfo(sessionId: string, options: { readonly dir: string; readonly signal?: AbortSignal }) {
    return await this.#sessionOwner.run({
      kind: "getSessionInfo",
      sessionId,
      options: { dir: options.dir }
    }, { ...(options.signal === undefined ? {} : { signal: options.signal }) }) as ClaudeSdkSessionInfo | undefined;
  }

  async getSessionMessages(sessionId: string, options: ClaudeSdkGetSessionMessagesOptions) {
    const { signal, ...nativeOptions } = options;
    return await this.#sessionOwner.run({
      kind: "getSessionMessages",
      sessionId,
      options: nativeOptions
    }, { ...(signal === undefined ? {} : { signal }) }) as readonly ClaudeSdkSessionMessage[];
  }

  async listSessions(options: ClaudeSdkListSessionsOptions) {
    return await this.#sessionOwner.run({ kind: "listSessions", options }) as readonly ClaudeSdkSessionInfo[];
  }

  async deleteSession(sessionId: string, options: { readonly dir: string; readonly signal?: AbortSignal }) {
    if (this.#sessionOwner.ownsSession(sessionId)) throw new Error("Native Session copy is not confirmed retired.");
    await this.#sessionOwner.run({
      kind: "deleteSession",
      sessionId,
      options: { dir: options.dir }
    }, { ...(options.signal === undefined ? {} : { signal: options.signal }) });
  }

  async forkSession(sessionId: string, options: ClaudeSdkForkOptions) {
    return await this.#sessionOwner.run({
      kind: "forkSession",
      sessionId,
      options: {
        dir: options.dir,
        ...(options.upToMessageId === undefined ? {} : { upToMessageId: options.upToMessageId })
      }
    }, { signal: options.signal, recordSessionId: options.recordSessionId }) as { readonly sessionId: string };
  }

  ownsSessionFork(sessionId: string): boolean { return this.#sessionOwner.ownsSession(sessionId); }
  async closeSessionOperations(): Promise<void> {
    const results = await Promise.allSettled([
      this.#sessionOwner.close(),
      this.#queryRuntime.closeSessionOperations()
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  async retireOwnedProcesses(timeoutMs: number): Promise<void> {
    const results = await Promise.allSettled([
      this.#sessionOwner.retire(),
      this.#queryRuntime.retireOwnedProcesses(timeoutMs)
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}

function configureStoredSdkTransport(queries: StoreBackedProductQuery[]): void {
  sdkTransport.startup.mockImplementation(() => ({
    query: () => ({
      initializationResult: async () => initialization,
      close: () => undefined,
      async *[Symbol.asyncIterator]() {}
    }),
    close: () => undefined
  }));
  sdkTransport.query.mockImplementation((params: ControlledNativeQueryParams) => {
    const query = new StoreBackedProductQuery(params);
    queries.push(query);
    return query;
  });
}

class StoreBackedProductQuery implements ClaudeSdkQuery {
  readonly receivedInputs: ClaudeSdkUserMessage[] = [];
  readonly turnInitializationCwds: string[] = [];
  readonly cwd: string;
  readonly resume: string | undefined;
  readonly sessionId: string | undefined;
  readonly sessionStoreConfigured: boolean;
  readonly projectKey: string;
  startupInitializationCwd: string | undefined;
  loadedEntryCount: number | undefined;
  loadedEntryTypes: string[] = [];
  persistedEntryCount: number | undefined;
  readonly #params: ControlledNativeQueryParams;
  readonly #nativeSessionId: string;
  readonly #output = new StoreQueryOutput();
  #closed = false;

  constructor(params: ControlledNativeQueryParams) {
    this.#params = params;
    this.cwd = params.options.cwd;
    this.resume = params.options.resume;
    this.sessionId = params.options.sessionId;
    this.sessionStoreConfigured = params.options.sessionStore !== undefined;
    this.projectKey = claudeProjectKey(params.options.cwd);
    const nativeSessionId = params.options.resume ?? params.options.sessionId;
    if (nativeSessionId === undefined) throw new Error("The controlled SDK Query requires an exact native Session ID.");
    this.#nativeSessionId = nativeSessionId;
    const spawn = params.options.spawnClaudeCodeProcess;
    if (spawn === undefined) throw new Error("The production Query process owner was not forwarded.");
    spawn({
      command: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1000)"],
      cwd: params.options.cwd,
      env: { ...process.env },
      signal: params.options.abortController.signal
    });
    void this.#run().catch((error: unknown) => this.#output.fail(error));
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.#output;
  }

  async #run(): Promise<void> {
    const store = this.#params.options.sessionStore;
    if (store !== undefined) {
      const stored = await store.load({ projectKey: this.projectKey, sessionId: this.#nativeSessionId });
      if (stored === null) throw new Error("The production SessionStore did not expose the adopted Session.");
      this.loadedEntryCount = stored.length;
      this.loadedEntryTypes = stored.map((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry)
        && typeof (entry as Record<string, unknown>)["type"] === "string"
        ? (entry as Record<string, unknown>)["type"] as string
        : "unknown");
    }
    if (this.#closed) return;
    this.startupInitializationCwd = this.cwd;
    this.#output.push(controlledClaudeInit(this.#nativeSessionId, this.#params.options));
    for await (const message of this.#params.prompt) {
      if (this.#closed) return;
      this.receivedInputs.push(message);
      if (store !== undefined) {
        const before = await store.load({ projectKey: this.projectKey, sessionId: this.#nativeSessionId });
        if (before === null) throw new Error("The adopted Session disappeared before input persistence.");
        const previous = before.findLast((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry)
          && ((entry as Record<string, unknown>)["type"] === "user"
            || (entry as Record<string, unknown>)["type"] === "assistant"));
        const parentUuid = previous !== null && typeof previous === "object" && !Array.isArray(previous)
          && typeof (previous as Record<string, unknown>)["uuid"] === "string"
          ? (previous as Record<string, unknown>)["uuid"] as string
          : null;
        const assistantId = randomUUID();
        await store.append({ projectKey: this.projectKey, sessionId: this.#nativeSessionId }, [{
          type: "user",
          uuid: message.uuid,
          parentUuid,
          sessionId: this.#nativeSessionId,
          cwd: this.cwd,
          timestamp: new Date().toISOString(),
          message: message.message
        }, {
          type: "assistant",
          uuid: assistantId,
          parentUuid: message.uuid,
          sessionId: this.#nativeSessionId,
          cwd: this.cwd,
          timestamp: new Date().toISOString(),
          message: { role: "assistant", content: [{ type: "text", text: "Controlled Store-backed response." }] }
        }]);
        this.persistedEntryCount = (await store.load({
          projectKey: this.projectKey,
          sessionId: this.#nativeSessionId
        }))?.length;
      }
      this.turnInitializationCwds.push(this.cwd);
      this.#output.push(controlledClaudeInit(this.#nativeSessionId, this.#params.options));
      this.#output.push(controlledClaudeResult(this.#nativeSessionId, message.uuid));
    }
  }

  async initializationResult(): Promise<ClaudeSdkInitializationResult> { return initialization; }
  async supportedModels() { return initialization.models; }
  async accountInfo() { return initialization.account; }
  async interrupt() { return { still_queued: [] }; }
  async stopTask(_taskId: string): Promise<void> {}
  async setPermissionMode(_mode: Parameters<ClaudeSdkQuery["setPermissionMode"]>[0]): Promise<void> {}
  async setModel(_model?: string): Promise<void> {}
  async applyFlagSettings(_settings: Parameters<ClaudeSdkQuery["applyFlagSettings"]>[0]): Promise<void> {}

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.#params.prompt[Symbol.asyncIterator]().return?.();
    this.#output.close();
  }
}

class StoreQueryOutput implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  readonly #values: unknown[] = [];
  readonly #readers: Array<{
    readonly resolve: (result: IteratorResult<unknown>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #failure: unknown;

  push(value: unknown): void {
    if (this.#closed) return;
    const reader = this.#readers.shift();
    if (reader === undefined) this.#values.push(value);
    else reader.resolve({ value, done: false });
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = error;
    for (const reader of this.#readers.splice(0)) reader.reject(error);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const reader of this.#readers.splice(0)) reader.resolve({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<unknown>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolvePromise, reject) => this.#readers.push({ resolve: resolvePromise, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> { return this; }
}

function controlledClaudeInit(nativeSessionId: string, options: ControlledNativeQueryOptions) {
  return {
    type: "system",
    subtype: "init",
    session_id: nativeSessionId,
    uuid: randomUUID(),
    claude_code_version: "2.1.259",
    apiKeySource: "none",
    cwd: options.cwd,
    model: options.model ?? "fixture-model",
    permissionMode: options.permissionMode,
    tools: ["Read"],
    mcp_servers: [],
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    capabilities: []
  };
}

function controlledClaudeResult(nativeSessionId: string, userMessageUuid: string) {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: "Controlled Store-backed response.",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    },
    modelUsage: {
      "fixture-model": {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 200_000,
        maxOutputTokens: 32_000
      }
    },
    permission_denials: [],
    terminal_reason: "completed",
    origin: { kind: "human" },
    user_message_uuid: userMessageUuid,
    uuid: randomUUID(),
    session_id: nativeSessionId
  };
}

/** Real fixed SDK Session filesystem APIs; the Query has no model traffic. */
class LocalSessionRuntime implements ClaudeSdkRuntime {
  readonly packageVersion = CLAUDE_AGENT_SDK_VERSION;
  readonly supportsWorkspaceDerivation = false;
  readonly forks: { sourceId: string; dir: string; upToMessageId?: string }[] = [];
  readonly created: string[] = [];
  readonly deletes: string[] = [];
  readonly #owner: SessionSdkOwner;
  onReceipt?: (id: string) => void;
  failure?: "unobserved" | "validation" | "cleanup-unknown";
  #failNextDerivedRead = false;

  constructor(profile: string) {
    this.#owner = new SessionSdkOwner({
      environment: { CLAUDE_CONFIG_DIR: profile, CLAUDE_CODE_PROJECT_DIR_NAME: storageName }, timeoutMs: 5_000, cleanupTimeoutMs: 1_000,
      workerFactory: (_url, options) => new Worker(new URL("./session-sdk-worker.mts", import.meta.resolve("@joko/adapter-claude-code/testing")), options)
    });
  }

  async probe() { return { installed: true, packageVersion: this.packageVersion, cliVersion: "2.1.259", initialization }; }
  async query(_params: ClaudeSdkQueryParams): Promise<ClaudeSdkQuery> { return new IdleQuery(); }
  async retireQuery(): Promise<void> { throw new Error("This Session fixture does not perform live Query replacement."); }
  async getSessionInfo(sessionId: string, options: { dir: string; signal?: AbortSignal }) {
    if (this.#failNextDerivedRead && this.created.includes(sessionId)) { this.#failNextDerivedRead = false; return undefined; }
    return await this.#owner.run({ kind: "getSessionInfo", sessionId, options: { dir: options.dir } }, { signal: options.signal }) as ClaudeSdkSessionInfo | undefined;
  }
  async getSessionMessages(sessionId: string, options: ClaudeSdkGetSessionMessagesOptions) {
    const { signal, ...nativeOptions } = options;
    return await this.#owner.run({ kind: "getSessionMessages", sessionId, options: nativeOptions }, { signal }) as readonly ClaudeSdkSessionMessage[];
  }
  async listSessions(options: ClaudeSdkListSessionsOptions) {
    return await this.#owner.run({ kind: "listSessions", options }) as readonly ClaudeSdkSessionInfo[];
  }
  async forkSession(sessionId: string, options: ClaudeSdkForkOptions) {
    this.forks.push({ sourceId: sessionId, dir: options.dir,
      ...(options.upToMessageId === undefined ? {} : { upToMessageId: options.upToMessageId }) });
    const result = await this.#owner.run({ kind: "forkSession", sessionId, options: { dir: options.dir, ...(options.upToMessageId === undefined ? {} : { upToMessageId: options.upToMessageId }) } }, {
      signal: options.signal,
      recordSessionId: (id) => {
        this.created.push(id);
        if (this.failure === "unobserved") return;
        options.recordSessionId(id);
        this.onReceipt?.(id);
      }
    }) as { sessionId: string };
    if (this.failure === "unobserved") throw new SessionSdkFailure("TIMEOUT", true);
    this.#failNextDerivedRead = this.failure !== undefined;
    return result;
  }
  async deleteSession(sessionId: string, options: { dir: string; signal?: AbortSignal }) {
    this.deletes.push(sessionId);
    await this.#owner.run({ kind: "deleteSession", sessionId, options: { dir: options.dir } }, { signal: options.signal });
    if (this.failure === "cleanup-unknown") throw new SessionSdkFailure("CLEANUP_UNKNOWN", true);
  }
  ownsSessionFork(sessionId: string) { return this.#owner.ownsSession(sessionId); }
  async closeSessionOperations() { await this.#owner.close(); }
}

class IdleQuery implements ClaudeSdkQuery {
  #finish!: () => void;
  readonly #closed = new Promise<void>((resolve) => { this.#finish = resolve; });
  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> { await this.#closed; }
  async initializationResult() { return initialization; }
  async supportedModels() { return initialization.models; }
  async accountInfo() { return initialization.account; }
  async interrupt() { return { still_queued: [] }; }
  async stopTask() {}
  async setPermissionMode() {}
  async setModel() {}
  async applyFlagSettings() {}
  close() { this.#finish(); }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const environment: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
  for (const key of ["GIT_COMMON_DIR", "GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"]) delete environment[key];
  return new Promise<string>((resolveResult, reject) => {
    execFile("git", [...args], {
      cwd,
      encoding: "utf8",
      env: environment,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`Git fixture command failed: ${stderr.trim()}`, { cause: error }));
        return;
      }
      resolveResult(stdout);
    });
  });
}
