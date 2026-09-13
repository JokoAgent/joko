import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { create } from "@bufbuild/protobuf";
import { CLAUDE_AGENT_SDK_VERSION, ClaudeCodeAdapter } from "@joko/adapter-claude-code";
import {
  SessionSdkFailure,
  SessionSdkOwner,
  type ClaudeSdkForkOptions,
  type ClaudeSdkGetSessionMessagesOptions,
  type ClaudeSdkInitializationResult,
  type ClaudeSdkListSessionsOptions,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryParams,
  type ClaudeSdkRuntime,
  type ClaudeSdkSessionInfo,
  type ClaudeSdkSessionMessage
} from "@joko/adapter-claude-code/testing";
import { NativeNavigationTargetSchema, NativeSessionStartSchema, OperationMutationSchema, OperationState, type Event } from "@joko/contracts";
import { expect, it } from "vitest";
import { OrchestratorE2eFixture, type E2eClients } from "./fixture.js";
import { createSessionMutation, forkMutation, navigateMutation, sessionIdFrom, submit } from "./operations.js";

const backendId = "claude-code";
const storageName = "fork-product-chain";
const initialization: ClaudeSdkInitializationResult = {
  models: [{ value: "fixture-model", displayName: "Fixture model", description: "Local controlled Query" }],
  account: { tokenSource: "fixture" }
};

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
  await Promise.all([mkdir(project, { recursive: true }), mkdir(workspace)]);
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
  await writeFile(sourcePath, transcript);
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
