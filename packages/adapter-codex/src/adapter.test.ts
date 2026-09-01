import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AdapterContext,
  CreateNativeSessionInput,
  EventPayload,
  InteractionDecision,
  InteractionPayload,
  NativeSessionBinding,
  TargetDescriptor
} from "@joko/core";
import { CAPABILITIES } from "@joko/core";
import { afterEach, describe, expect, it } from "vitest";
import { CodexBackendAdapter, type CodexAdapterOptions } from "./adapter.js";
import { AppServerHost } from "./host.js";
import { FakeCodexAppServer } from "./testing.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("CodexBackendAdapter", () => {
  it("probes stable account/models, drains pre-subscription events, and translates a complete turn", async () => {
    const setup = await createSetup();
    setup.fake.emitNameBeforeStartResponse = true;
    const descriptor = await setup.adapter.describe();
    expect(descriptor).toMatchObject({
      id: "codex-test",
      adapterKind: "codex",
      instanceGeneration: 7,
      version: "0.151.0-alpha.7.2",
      health: "healthy",
      authenticationState: "authenticated"
    });
    expect(descriptor.models).toHaveLength(1);
    expect(descriptor.capabilities.size).toBe(CAPABILITIES.length);
    expect(descriptor.capabilities.get("session.catalog")?.supported).toBe(true);
    expect(descriptor.capabilities.get("turn.steer")?.supported).toBe(true);
    expect(descriptor.capabilities.get("model.effort")?.supported).toBe(true);
    expect(descriptor.capabilities.get("model.fast_mode")?.supported).toBe(true);
    expect(descriptor.capabilities.get("provider.account_usage")?.supported).toBe(true);
    expect(descriptor.capabilities.get("review.isolated")).toMatchObject({
      supported: true
    });
    expect(descriptor.capabilities.get("plan_mode")?.supported).toBe(true);
    expect(descriptor.capabilities.get("background.tasks")?.supported).toBe(true);
    expect(descriptor.capabilities.get("subagents.list")?.supported).toBe(true);
    expect(descriptor.capabilities.get("subagents.detail")?.supported).toBe(true);
    expect(descriptor.capabilities.get("subagents.transcript")?.supported).toBe(true);
    expect(descriptor.capabilities.get("subagents.stop")).toMatchObject({
      supported: false,
      reason: "not_implemented"
    });
    expect(descriptor.providers).toEqual([expect.objectContaining({
      accessKind: "subscription",
      accessProduct: "ChatGPT",
      providesModelPricing: true
    })]);
    const initialize = setup.fake.transport?.requests.find((request) => request.method === "initialize");
    expect(initialize?.params).toMatchObject({ capabilities: { experimentalApi: true, requestAttestation: false } });
    expect(setup.fake.transport?.notifications).toContainEqual({ method: "initialized" });

    const events: EventPayload[] = [];
    const createContext = context(setup.target, events, { backendInstanceGeneration: 7 });
    const binding = await setup.adapter.createSession(sessionInput(setup.target), createContext);
    expect(events).toContainEqual({ type: "session_changed" });

    const attachmentPath = join(setup.target.workspaceRoot, "notes.txt");
    await writeFile(attachmentPath, "notes", "utf8");
    const sendContext = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "operation-one"
    });
    await setup.adapter.send({
      text: "work on this",
      images: [],
      files: [{
        blob: { id: "blob-file", sha256: "0".repeat(64), byteLength: 5, mimeType: "text/plain", fileName: "notes.txt" },
        workspacePath: "notes.txt"
      }],
      mentions: [{ kind: "resource", label: "Demo App", reference: "app://demo-app" }],
      disposition: "prompt"
    }, sendContext);
    const turnStart = setup.fake.transport?.requests.find((request) => request.method === "turn/start");
    expect(turnStart?.params).toMatchObject({ clientUserMessageId: "operation-one" });
    expect(JSON.stringify(turnStart?.params)).toContain('"type":"mention"');

    await setup.fake.completeTurn(binding.nativeSessionId!, "hello from fake");
    expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "hello from fake" }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "message_complete",
      role: "assistant",
      nativeHistory: { identity: { entryId: "item-turn-1" } }
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: "usage" }));
    expect(events.at(-1)).toEqual({ type: "done", outcome: "completed" });
  });

  it("reconciles a lost turn/start response by clientUserMessageId without retrying", async () => {
    const setup = await createSetup();
    await setup.adapter.describe();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    setup.fake.timeoutNextTurnStart = true;
    await expect(setup.adapter.send({
      text: "lost response",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "durable-operation-lost-response"
    }))).resolves.toBeUndefined();
    expect(setup.fake.transport?.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    expect(setup.fake.threads.get(binding.nativeSessionId!)?.turns).toHaveLength(1);
    expect(setup.fake.transport?.requests.some((request) => request.method === "thread/read")).toBe(true);
  });

  it("reconciles a malformed accepted turn/start response through the durable client id", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    setup.fake.malformedNextTurnStartResponse = true;
    await expect(setup.adapter.send({
      text: "malformed accepted response",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "malformed-response-reconciled"
    }))).resolves.toBeUndefined();
    expect(setup.fake.transport?.requests.some((request) => request.method === "thread/read")).toBe(true);
  });

  it("classifies an unprovable malformed accepted response as dispatch unknown", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    setup.fake.malformedNextTurnStartResponse = true;
    setup.fake.dropNextTurnClientId = true;
    await expect(setup.adapter.send({
      text: "unprovable accepted response",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "malformed-response-unknown"
    }))).rejects.toMatchObject({
      publicError: { code: "CODEX_DISPATCH_UNKNOWN", stateMayHaveChanged: true, retryable: false }
    });
  });

  it("does not reconcile an accepted response against a foreign native thread", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    setup.fake.malformedNextTurnStartResponse = true;
    setup.fake.nextThreadReadOverride = {
      id: "foreign-thread",
      cwd: setup.target.workspaceRoot,
      turns: [{
        id: "foreign-turn",
        status: "inProgress",
        items: [{
          type: "userMessage",
          id: "foreign-message",
          clientId: "foreign-reconciliation"
        }]
      }]
    };
    await expect(setup.adapter.send({
      text: "do not trust a foreign thread",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "foreign-reconciliation"
    }))).rejects.toMatchObject({ publicError: { code: "CODEX_DISPATCH_UNKNOWN" } });
  });

  it("does not revive a turn completed before the turn/start response", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const active = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "terminal-before-response"
    });
    setup.fake.completeTurnBeforeStartResponse = true;
    await setup.adapter.send({
      text: "complete before response",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, active);
    expect(events.filter((event) => event.type === "done")).toEqual([{ type: "done", outcome: "completed" }]);

    await setup.adapter.abort(active);
    expect(setup.fake.transport?.requests.filter((request) => request.method === "turn/interrupt")).toHaveLength(0);
  });

  it("defaults an unowned server approval to the stable safe cancel decision", async () => {
    const setup = await createSetup();
    await setup.host.ensureStarted();
    const threadId = "unowned-thread";
    setup.fake.threads.set(threadId, {
      id: threadId,
      cwd: setup.target.workspaceRoot,
      name: null,
      turns: [],
      status: { type: "idle" },
      createdAt: 1,
      updatedAt: 1
    });
    await expect(setup.fake.requestCommandApproval(threadId, "turn-unowned")).resolves.toEqual({ decision: "cancel" });
  });

  it("never fabricates a denial decision excluded by availableDecisions", async () => {
    const setup = await createSetup();
    await setup.host.ensureStarted();
    const threadId = "unowned-restricted-thread";
    setup.fake.threads.set(threadId, {
      id: threadId,
      cwd: setup.target.workspaceRoot,
      name: null,
      turns: [],
      status: { type: "idle" },
      createdAt: 1,
      updatedAt: 1
    });
    await expect(setup.fake.requestCommandApproval(threadId, "turn-unowned", ["accept"]))
      .rejects.toMatchObject({ rpcCode: -32602 });
  });

  it("rechecks Backend instance generation after a pending approval decision", async () => {
    let releaseDecision: ((decision: InteractionDecision) => void) | undefined;
    let interactionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { interactionStarted = resolve; });
    const setup = await createSetup(11);
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 11 })
    );
    const decisionContext = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 11,
      operationId: "approval-generation",
      requestInteraction: async () => {
        interactionStarted?.();
        return new Promise<InteractionDecision>((resolve) => { releaseDecision = resolve; });
      }
    });
    await setup.adapter.send({
      text: "start an approval turn",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, decisionContext);
    const approval = setup.fake.requestCommandApproval(binding.nativeSessionId!, "turn-1");
    await started;

    Object.defineProperty(decisionContext, "backendInstanceGeneration", { value: 12 });
    releaseDecision?.({ kind: "selected", value: "approve_once" });
    await expect(approval).resolves.toEqual({ decision: "cancel" });
  });

  it("refuses secret native user input without opening a durable Interaction", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    let interactionCount = 0;
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const active = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "secret-question-turn",
      requestInteraction: async () => {
        interactionCount += 1;
        return { kind: "question", answers: { secret: "must-not-be-persisted" } };
      }
    });
    await setup.adapter.send({
      text: "request a credential",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, active);

    await expect(setup.fake.requestUserInput(binding.nativeSessionId!, "turn-1", [{
      id: "secret",
      question: "Token?",
      isSecret: true
    }])).resolves.toEqual({ answers: { secret: { answers: [] } } });
    expect(interactionCount).toBe(0);
  });

  it("fails closed when the app-server resolves a pending approval before the user", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    let releaseDecision: ((decision: InteractionDecision) => void) | undefined;
    let interactionSignal: AbortSignal | undefined;
    let interactionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { interactionStarted = resolve; });
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const active = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "resolved-approval-turn",
      requestInteraction: async (_interaction, requestOptions) => {
        interactionSignal = requestOptions?.signal;
        interactionStarted?.();
        return new Promise<InteractionDecision>((resolve) => { releaseDecision = resolve; });
      }
    });
    await setup.adapter.send({
      text: "start a pending approval",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, active);
    const approval = setup.fake.requestCommandApproval(binding.nativeSessionId!, "turn-1");
    await started;
    const requestId = setup.fake.transport?.lastServerRequestId;
    expect(requestId).toBeDefined();
    await setup.fake.resolveServerRequest(binding.nativeSessionId!, requestId!);
    await expect(approval).resolves.toEqual({ decision: "cancel" });
    expect(interactionSignal?.aborted).toBe(true);

    releaseDecision?.({ kind: "selected", value: "approve_once" });
    await Promise.resolve();
    expect(setup.fake.transport?.lastServerRequestId).toBe(requestId);
  });

  it("denies approval requests that do not belong to the active turn", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    let interactionCount = 0;
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const active = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "terminal-approval-turn",
      requestInteraction: async () => {
        interactionCount += 1;
        return { kind: "selected", value: "approve_once" };
      }
    });
    await setup.adapter.send({
      text: "finish before approval",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, active);
    await setup.fake.completeTurn(binding.nativeSessionId!);

    await expect(setup.fake.requestCommandApproval(binding.nativeSessionId!, "turn-1"))
      .resolves.toEqual({ decision: "cancel" });
    expect(interactionCount).toBe(0);
  });

  it("does not advertise image input unless an immutable blob reader is configured", async () => {
    const setup = await createSetup();
    expect((await setup.adapter.describe()).capabilities.get("input.image")).toMatchObject({
      supported: false,
      reason: "not_implemented"
    });
    const withImages = new CodexBackendAdapter({
      id: "codex-images",
      instanceGeneration: 8,
      host: setup.host,
      readBlob: async () => ({ data: new Uint8Array([1]), mimeType: "image/png" })
    });
    cleanups.push(() => withImages.dispose());
    expect((await withImages.describe()).capabilities.get("input.image")?.supported).toBe(true);
  });

  it("rejects oversized prompt input before native mutation dispatch", async () => {
    const setup = await createSetup(7, { maximumPromptTextBytes: 8 });
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const before = setup.fake.transport?.requests.filter((request) => request.method === "turn/start").length ?? 0;
    await expect(setup.adapter.send({
      text: "this prompt is too large",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "oversized-prompt"
    }))).rejects.toMatchObject({ publicError: { code: "CODEX_PROMPT_TOO_LARGE", stateMayHaveChanged: false } });
    expect(setup.fake.transport?.requests.filter((request) => request.method === "turn/start")).toHaveLength(before);
  });

  it("fails typed and bounded on cyclic model and thread pagination cursors", async () => {
    const setup = await createSetup();
    setup.fake.modelNextCursor = "model-cycle";
    await expect(setup.adapter.listModels())
      .rejects.toMatchObject({ publicError: { code: "CODEX_MODEL_PAGINATION_INVALID" } });
    setup.fake.modelNextCursor = null;

    const events: EventPayload[] = [];
    await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    setup.fake.threadNextCursor = "thread-cycle";
    await expect(setup.adapter.listNativeSessions(setup.target))
      .rejects.toMatchObject({ publicError: { code: "CODEX_THREAD_PAGINATION_INVALID" } });
  });

  it("keeps local catalog scanning available when the executable is unavailable", async () => {
    const profileDirectory = await mkdtemp(join(tmpdir(), "joko-codex-offline-profile-"));
    cleanups.push(() => rm(profileDirectory, { recursive: true, force: true }));
    const adapter = new CodexBackendAdapter({
      id: "codex-missing",
      instanceGeneration: 9,
      profileDirectory,
      catalogProfileDirectories: [profileDirectory],
      appServer: {
        transport: {
          command: join(tmpdir(), `joko-codex-missing-${process.pid}`),
          requestTimeoutMs: 500
        }
      }
    });
    cleanups.push(() => adapter.dispose());
    const descriptor = await adapter.describe();
    expect(descriptor.installationState).toBe("not_installed");
    expect(descriptor.capabilities.size).toBe(CAPABILITIES.length);
    expect(descriptor.capabilities.get("session.catalog")).toEqual({
      key: "session.catalog",
      supported: true
    });
    expect(descriptor.capabilities.get("turn.stream")).toMatchObject({
      supported: false,
      reason: "upstream_missing"
    });
    await expect(adapter.scanNativeSessionCatalog()).resolves.toEqual({ entries: [], rejectedCount: 0 });
  });

  it("materializes an external profile task once and returns the active profile identity", async () => {
    const fixture = await catalogProfileFixture("11111111-1111-4111-8111-111111111111", true);
    const adapter = catalogOnlyAdapter(fixture.active, fixture.source);
    cleanups.push(() => adapter.dispose());

    const scanned = await adapter.scanNativeSessionCatalog();
    expect(scanned.entries).toHaveLength(1);
    const entry = scanned.entries[0]!;
    expect(entry).toMatchObject({
      nativeSessionId: fixture.nativeSessionId,
      createdAt: 1_000,
      modifiedAt: 2_000,
      placement: "dialogue"
    });

    const first = await adapter.bindCatalogSession(entry, 3);
    const second = await adapter.bindCatalogSession(entry, 3);
    expect(second).toEqual(first);
    expect(first.nativeSessionId).toBe(fixture.nativeSessionId);
    expect(first.opaqueRef).not.toBe(entry.nativeReference);

    const activeRow = readCatalogThread(fixture.active, fixture.nativeSessionId);
    expect(activeRow?.["rollout_path"]).toEqual(expect.any(String));
    const copied = String(activeRow?.["rollout_path"]);
    await expect(readFile(copied, "utf8")).resolves.toBe(fixture.rolloutContent);
    await expect(stat(copied)).resolves.toMatchObject({ size: Buffer.byteLength(fixture.rolloutContent) });
    const profileState = JSON.parse(await readFile(join(fixture.active, ".codex-global-state.json"), "utf8")) as {
      readonly "projectless-thread-ids"?: readonly string[];
    };
    expect(profileState["projectless-thread-ids"]).toContain(fixture.nativeSessionId);

    const rescanned = await adapter.scanNativeSessionCatalog();
    expect(rescanned.entries[0]?.nativeReference).toBe(first.opaqueRef);
  });

  it("fails closed when an external rollout changes after scanning", async () => {
    const fixture = await catalogProfileFixture("22222222-2222-4222-8222-222222222222", false);
    const adapter = catalogOnlyAdapter(fixture.active, fixture.source);
    cleanups.push(() => adapter.dispose());
    const entry = (await adapter.scanNativeSessionCatalog()).entries[0]!;

    await writeFile(fixture.sourceRollout, `${fixture.rolloutContent}changed\n`, "utf8");

    await expect(adapter.bindCatalogSession(entry, 2)).rejects.toMatchObject({
      publicError: { code: "CODEX_CATALOG_SOURCE_CHANGED" }
    });
  });

  it("fails closed when an active task row or rollout changes after scanning", async () => {
    const mutations = ["row", "rollout"] as const;
    for (const [index, mutation] of mutations.entries()) {
      const nativeSessionId = `66666666-6666-4666-8666-66666666666${index}`;
      const fixture = await catalogProfileFixture(nativeSessionId, false);
      const activeRollout = join(fixture.active, "sessions", `${nativeSessionId}.jsonl`);
      await mkdir(join(activeRollout, ".."), { recursive: true });
      await writeFile(activeRollout, fixture.rolloutContent, "utf8");
      insertCatalogThread(fixture.active, {
        nativeSessionId,
        rolloutPath: activeRollout,
        workspace: fixture.active,
        title: "Active native task",
        createdAt: 500,
        modifiedAt: 1_000
      });
      const adapter = catalogOnlyAdapter(fixture.active, fixture.source);
      cleanups.push(() => adapter.dispose());
      const entry = (await adapter.scanNativeSessionCatalog()).entries[0]!;
      expect(entry.title).toBe("Active native task");

      if (mutation === "rollout") {
        await writeFile(activeRollout, `${fixture.rolloutContent}changed\n`, "utf8");
      } else {
        const database = new DatabaseSync(join(fixture.active, "state_5.sqlite"));
        try {
          database.prepare("UPDATE threads SET title = ? WHERE id = ?")
            .run("Changed active task", nativeSessionId);
        } finally {
          database.close();
        }
      }

      await expect(adapter.scanNativeSessionCatalog()).resolves.toMatchObject({ entries: [{}] });
      await expect(adapter.bindCatalogSession(entry, 2)).rejects.toMatchObject({
        publicError: { code: "CODEX_CATALOG_SOURCE_CHANGED" }
      });
    }
  });

  it("does not overwrite a native identity that appears in the active profile after scanning", async () => {
    const fixture = await catalogProfileFixture("33333333-3333-4333-8333-333333333333", false);
    const adapter = catalogOnlyAdapter(fixture.active, fixture.source);
    cleanups.push(() => adapter.dispose());
    const entry = (await adapter.scanNativeSessionCatalog()).entries[0]!;
    const conflictingRollout = join(fixture.active, "sessions", "conflicting.jsonl");
    await mkdir(join(fixture.active, "sessions"), { recursive: true });
    await writeFile(conflictingRollout, "conflict\n", "utf8");
    insertCatalogThread(fixture.active, {
      nativeSessionId: fixture.nativeSessionId,
      rolloutPath: conflictingRollout,
      workspace: fixture.active,
      title: "conflict",
      createdAt: 1_000,
      modifiedAt: 2_000
    });

    await expect(adapter.bindCatalogSession(entry, 2)).rejects.toMatchObject({
      publicError: { code: "CODEX_CATALOG_TARGET_CONFLICT" }
    });
    await expect(readFile(conflictingRollout, "utf8")).resolves.toBe("conflict\n");
  });

  it("rejects a catalog publication path that traverses a symbolic link", async () => {
    const fixture = await catalogProfileFixture("44444444-4444-4444-8444-444444444444", false);
    const adapter = catalogOnlyAdapter(fixture.active, fixture.source);
    cleanups.push(() => adapter.dispose());
    const entry = (await adapter.scanNativeSessionCatalog()).entries[0]!;
    const outside = join(dirname(fixture.active), "outside");
    const sessions = join(fixture.active, "sessions");
    await mkdir(outside, { recursive: true });
    let linked = false;
    try {
      await symlink(outside, sessions, process.platform === "win32" ? "junction" : "dir");
      linked = true;
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("EPERM");
    }
    if (!linked) return;
    try {
      await expect(adapter.bindCatalogSession(entry, 2)).rejects.toMatchObject({
        publicError: { code: "CODEX_CATALOG_TARGET_CONFLICT" }
      });
      await expect(readdir(outside)).resolves.toEqual([]);
    } finally {
      await unlink(sessions);
    }
  });

  it("removes a newly published rollout when the state transaction fails", async () => {
    const fixture = await catalogProfileFixture("55555555-5555-4555-8555-555555555555", false);
    const adapter = catalogOnlyAdapter(fixture.active, fixture.source);
    cleanups.push(() => adapter.dispose());
    const entry = (await adapter.scanNativeSessionCatalog()).entries[0]!;
    const database = new DatabaseSync(join(fixture.active, "state_5.sqlite"));
    try {
      database.exec(`
        CREATE TRIGGER reject_catalog_insert
        BEFORE INSERT ON threads
        BEGIN
          SELECT RAISE(ABORT, 'blocked');
        END
      `);
    } finally {
      database.close();
    }

    await expect(adapter.bindCatalogSession(entry, 2)).rejects.toMatchObject({
      publicError: { code: "CODEX_CATALOG_MATERIALIZATION_UNAVAILABLE" }
    });
    const published = await readdir(join(fixture.active, "sessions", "catalog-imports"), {
      recursive: true
    }).catch(() => []);
    expect(published.filter((name) => name.endsWith(".jsonl"))).toEqual([]);
  });

  it("proves binding identity and native cwd before resolve, resume, or discovery", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const otherWorkspace = await mkdtemp(join(tmpdir(), "joko-codex-other-target-"));
    cleanups.push(() => rm(otherWorkspace, { recursive: true, force: true }));
    const otherTarget: TargetDescriptor = {
      ...setup.target,
      id: "target-codex-other",
      workspaceRoot: otherWorkspace
    };

    await expect(setup.adapter.resolveNativeSessionReference(binding.opaqueRef, otherTarget, 1))
      .rejects.toMatchObject({ publicError: { code: "CODEX_NATIVE_SESSION_TARGET_MISMATCH" } });
    const resumeCount = setup.fake.transport?.requests.filter((request) => request.method === "thread/resume").length ?? 0;
    await expect(setup.adapter.resumeSession(binding, context(otherTarget, events, {
      binding,
      backendInstanceGeneration: 7
    }))).rejects.toMatchObject({ publicError: { code: "CODEX_NATIVE_SESSION_TARGET_MISMATCH" } });
    expect(setup.fake.transport?.requests.filter((request) => request.method === "thread/resume")).toHaveLength(resumeCount);

    await expect(setup.adapter.resumeSession({
      ...binding,
      nativeSessionId: "conflicting-thread-id"
    }, context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7
    }))).rejects.toMatchObject({ publicError: { code: "CODEX_SESSION_BINDING_MISMATCH" } });

    setup.fake.threads.set("foreign-thread", {
      id: "foreign-thread",
      cwd: otherWorkspace,
      name: "Foreign",
      turns: [],
      status: { type: "idle" },
      createdAt: 1,
      updatedAt: 1
    });
    const discovered = await setup.adapter.listNativeSessions(setup.target);
    expect(discovered.map((candidate) => candidate.nativeSessionId)).toEqual([binding.nativeSessionId]);
    expect(setup.fake.transport?.requests.findLast((request) => request.method === "thread/list")?.params)
      .toMatchObject({ cwd: setup.target.workspaceRoot, useStateDbOnly: true });
  });

  it("reports a side-effect-free continuity gap for validated missing or unresumable native threads", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    setup.fake.threads.delete(binding.nativeSessionId!);
    const nextBinding = { ...binding, generation: binding.generation + 1 };

    await expect(setup.adapter.resumeSession(binding, context(setup.target, events, {
      binding: nextBinding,
      generation: nextBinding.generation,
      backendInstanceGeneration: 7
    }))).rejects.toMatchObject({
      publicError: {
        code: "NATIVE_SESSION_CONTINUITY_GAP",
        retryable: false,
        stateMayHaveChanged: false
      }
    });
    await expect(setup.adapter.resolveNativeSessionReference(
      binding.opaqueRef,
      setup.target,
      nextBinding.generation
    )).rejects.toMatchObject({
      publicError: {
        code: "NATIVE_SESSION_CONTINUITY_GAP",
        retryable: false,
        stateMayHaveChanged: false
      }
    });
    await expect(setup.adapter.inspectSession(binding, context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7
    }))).rejects.toMatchObject({
      publicError: { code: "CODEX_NATIVE_SESSION_UNAVAILABLE" }
    });

    const restartSetup = await createSetup();
    const restartBinding = await restartSetup.adapter.createSession(
      sessionInput(restartSetup.target),
      context(restartSetup.target, events, { backendInstanceGeneration: 7 })
    );
    await restartSetup.adapter.closeSession(restartBinding, context(restartSetup.target, events, {
      binding: restartBinding,
      backendInstanceGeneration: 7
    }));
    restartSetup.fake.failNextThreadResumeCode = -32600;
    const restartedBinding = { ...restartBinding, generation: restartBinding.generation + 1 };
    await expect(restartSetup.adapter.resumeSession(restartBinding, context(restartSetup.target, events, {
      binding: restartedBinding,
      generation: restartedBinding.generation,
      backendInstanceGeneration: 7
    }))).rejects.toMatchObject({
      publicError: {
        code: "NATIVE_SESSION_CONTINUITY_GAP",
        retryable: false,
        stateMayHaveChanged: false
      }
    });
  });

  it("retires a subscription installed after dispose without emitting late callbacks", async () => {
    const setup = await createSetup();
    setup.fake.emitNameBeforeStartResponse = true;
    const events: EventPayload[] = [];
    let releaseEmit: (() => void) | undefined;
    let emitStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { emitStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseEmit = resolve; });
    const createContext = {
      ...context(setup.target, events, { backendInstanceGeneration: 7 }),
      emit: async (event: EventPayload) => {
        if (event.type === "session_changed") {
          emitStarted?.();
          await blocked;
        }
        events.push(event);
      }
    };
    const creation = setup.adapter.createSession(sessionInput(setup.target), createContext);
    await started;

    const disposal = setup.adapter.dispose();
    releaseEmit?.();
    await expect(disposal).resolves.toBeUndefined();
    await expect(creation).rejects.toMatchObject({ publicError: { code: "CODEX_ADAPTER_CLOSED" } });
    expect(events).toEqual([{ type: "session_changed" }]);
    const threadId = [...setup.fake.threads.keys()][0]!;
    await expect(setup.fake.requestCommandApproval(threadId, "turn-late"))
      .resolves.toEqual({ decision: "cancel" });
  });

  it("forks only through a proven native turn boundary and detaches the derived binding without closing the source", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const sourceContext = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "fork-source-message"
    });
    await setup.adapter.send({
      text: "create a fork point",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, sourceContext);
    await setup.fake.completeTurn(binding.nativeSessionId!);

    const derived = await setup.adapter.fork("fork-source-message", sourceContext);
    const forkRequest = setup.fake.transport?.requests.find((request) => request.method === "thread/fork");
    expect(forkRequest?.params).toMatchObject({ threadId: binding.nativeSessionId, lastTurnId: "turn-1" });
    await expect(setup.adapter.detachSession(derived.binding, {
      ...sourceContext,
      binding: derived.binding
    })).resolves.toBeUndefined();

    await expect(setup.adapter.send({
      text: "source remains attached",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, { ...sourceContext, operationId: "source-after-fork" })).resolves.toBeUndefined();
  });

  it("holds manual compaction until the native compaction item is durably emitted", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const bound = context(setup.target, events, { binding, backendInstanceGeneration: 7 });
    await expect(setup.adapter.compact(undefined, bound)).resolves.toBe("compacted");
    const compactions = events.filter((event) => event.type === "compaction");
    expect(compactions).toEqual([
      expect.objectContaining({ state: "started", compactionId: "compaction-turn-1" }),
      expect.objectContaining({ state: "completed", compactionId: "compaction-turn-1" })
    ]);
  });

  it("recovers the exact active turn id before interrupting a resumed thread", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const bound = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "active-before-resume"
    });
    await setup.adapter.send({
      text: "keep this turn active",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, bound);
    await setup.adapter.closeSession(binding, bound);
    await setup.adapter.resumeSession(binding, bound);
    await setup.adapter.abort(bound);

    expect(setup.fake.transport?.requests.some((request) => request.method === "thread/turns/list")).toBe(true);
    expect(setup.fake.transport?.requests.findLast((request) => request.method === "turn/interrupt")?.params)
      .toMatchObject({ threadId: binding.nativeSessionId, turnId: "turn-1" });
  });

  it("resumes only the same native identity across exactly one durable generation", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const nextBinding = { ...binding, generation: 2 };
    await expect(setup.adapter.resumeSession(binding, context(setup.target, events, {
      binding: nextBinding,
      backendInstanceGeneration: 7,
      generation: 2
    }))).resolves.toMatchObject({ binding: nextBinding });

    const resumeRequests = setup.fake.transport?.requests.filter((request) => request.method === "thread/resume").length ?? 0;
    const failures: readonly [NativeSessionBinding, AdapterContext][] = [
      [binding, context(setup.target, events, {
        binding: { ...binding, generation: 3 },
        backendInstanceGeneration: 7,
        generation: 3
      })],
      [nextBinding, context(setup.target, events, {
        backendInstanceGeneration: 7,
        generation: 3
      })],
      [nextBinding, context(setup.target, events, {
        binding: { ...nextBinding, nativeSessionId: "foreign", generation: 3 },
        backendInstanceGeneration: 7,
        generation: 3
      })]
    ];
    for (const [candidate, resumeContext] of failures) {
      await expect(setup.adapter.resumeSession(candidate, resumeContext))
        .rejects.toMatchObject({ publicError: { code: "CODEX_SESSION_BINDING_MISMATCH" } });
    }
    await expect(setup.adapter.resumeSession(nextBinding, context(setup.target, events, {
      binding: { opaqueRef: "codex-thread:foreign", nativeSessionId: "foreign", generation: 3 },
      backendInstanceGeneration: 7,
      generation: 3
    }))).rejects.toMatchObject({ publicError: { code: "CODEX_NATIVE_REFERENCE_INVALID" } });
    expect(setup.fake.transport?.requests.filter((request) => request.method === "thread/resume"))
      .toHaveLength(resumeRequests);
  });

  it("reads complete bounded native history only through the current thread and cwd fence", async () => {
    const setup = await createSetup(7, { maximumHistoryItems: 2, maximumHistoryEvents: 16 });
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    setup.fake.threads.get(binding.nativeSessionId!)!.turns.push({
      id: "history-turn",
      status: "completed",
      items: [
        { type: "userMessage", id: "history-user", clientId: null, content: [{ type: "text", text: "hello" }] },
        { type: "agentMessage", id: "history-assistant", text: "answer", phase: null, memoryCitation: null, delivery: null }
      ],
      error: null,
      durationMs: 4
    });
    const bound = context(setup.target, events, { binding, backendInstanceGeneration: 7 });
    await expect(setup.adapter.getNativeHistoryProjection(bound)).resolves.toMatchObject({
      activeEntryId: "history-assistant",
      activeLineage: [
        { entryId: "history-user" },
        { entryId: "history-assistant", parentEntryId: "history-user" }
      ]
    });
    expect(setup.fake.transport?.requests.findLast((request) => request.method === "thread/read")?.params)
      .toMatchObject({ threadId: binding.nativeSessionId, includeTurns: true });

    setup.fake.nextThreadReadOverride = {
      id: binding.nativeSessionId!,
      cwd: join(setup.target.workspaceRoot, "foreign"),
      turns: []
    };
    await expect(setup.adapter.getNativeHistoryProjection(bound))
      .rejects.toMatchObject({ publicError: { code: "CODEX_NATIVE_SESSION_TARGET_MISMATCH" } });

    setup.fake.threads.get(binding.nativeSessionId!)!.turns[0]!["items"] = [
      { type: "userMessage", id: "one", content: [] },
      { type: "agentMessage", id: "two", text: "two" },
      { type: "agentMessage", id: "three", text: "three" }
    ];
    await expect(setup.adapter.getNativeHistoryProjection(bound))
      .rejects.toMatchObject({ publicError: { code: "CODEX_NATIVE_HISTORY_UNAVAILABLE" } });
  });

  it("publishes only Adapter-safe Host-composed capabilities", async () => {
    const setup = await createSetup(7, {
      hostCapabilities: ["workspace.generated_files", "session.attention"]
    });
    const descriptor = await setup.adapter.describe();
    expect(descriptor.capabilities.get("workspace.generated_files")).toMatchObject({ supported: true });
    expect(descriptor.capabilities.get("session.attention")).toMatchObject({ supported: true });
    expect(descriptor.capabilities.get("tool.browser")).toMatchObject({ supported: false });
    expect(descriptor.capabilities.get("tool.computer")).toMatchObject({ supported: false });
    expect(descriptor.capabilities.get("tool.android")).toMatchObject({ supported: false });
    expect(descriptor.capabilities.get("workspace.extra_dirs")).toMatchObject({ supported: false });
    expect(() => new CodexBackendAdapter({
      instanceGeneration: 7,
      host: setup.host,
      hostCapabilities: ["workspace.extra_dirs" as never]
    })).toThrow("Codex Host-composed capability is invalid");
  });

  it("runs Review through a fresh native profile with only bounded Host-owned readers", async () => {
    const setup = await createSetup();
    const skillPath = join(setup.target.workspaceRoot, "review-skill.md");
    await writeFile(skillPath, "skill", "utf8");
    setup.fake.reviewSkills.push({
      name: "review-skill",
      description: "must be disabled",
      enabled: true,
      path: skillPath,
      pluginId: "review-plugin@local",
      scope: "repo"
    });
    setup.fake.reviewConfig = {
      mcp_servers: { docs: { command: "docs-server" } },
      plugins: {
        "review-plugin@local": {
          enabled: true,
          mcp_servers: { plugin_docs: { url: "https://example.invalid/mcp" } }
        }
      }
    };
    setup.fake.reviewMcpStatuses.push(
      { name: "codex_apps", authStatus: "unsupported", resourceTemplates: [], resources: [], tools: {} },
      { name: "docs", authStatus: "unsupported", resourceTemplates: [], resources: [], tools: {} },
      { name: "plugin_docs", authStatus: "unsupported", resourceTemplates: [], resources: [], tools: {} }
    );
    const descriptor = await setup.adapter.describe();
    expect(descriptor.capabilities.get("review.isolated")).toMatchObject({
      supported: true
    });
    const events: EventPayload[] = [];
    let interactionRequests = 0;
    const reviewContext: AdapterContext = {
      ...context(setup.target, events, {
        backendInstanceGeneration: 7,
        requestInteraction: async () => {
          interactionRequests += 1;
          return { kind: "cancelled" };
        }
      }),
      runtimePolicy: "review_read_only",
      extraDirectories: []
    };
    const invalidReviewInputs: CreateNativeSessionInput[] = [{
      ...sessionInput(setup.target),
      nativeStart: { kind: "new", parentNativeReference: "codex:thread:source" },
      runtimePolicy: "review_read_only"
    }, {
      ...sessionInput(setup.target),
      nativeStart: { kind: "attach", nativeReference: "codex:thread:source" },
      runtimePolicy: "review_read_only"
    }, {
      ...sessionInput(setup.target),
      permissionMode: "auto",
      runtimePolicy: "review_read_only"
    }, {
      ...sessionInput(setup.target),
      appendSystemPrompt: "mutable reviewer instructions",
      runtimePolicy: "review_read_only"
    }];
    for (const input of invalidReviewInputs) {
      await expect(setup.adapter.createSession(input, reviewContext))
        .rejects.toMatchObject({ publicError: { code: "CODEX_REVIEW_PROFILE_INVALID" } });
    }
    await expect(setup.adapter.createSession({
      ...sessionInput(setup.target),
      nativeStart: { kind: "new" },
      runtimePolicy: "review_read_only"
    }, context(setup.target, events, { backendInstanceGeneration: 7 })))
      .rejects.toMatchObject({ publicError: { code: "CODEX_REVIEW_PROFILE_INVALID" } });

    await writeFile(join(setup.target.workspaceRoot, "review.txt"), "first line\nneedle line\nlast line", "utf8");
    await writeFile(join(setup.target.workspaceRoot, ".env"), "SECRET=hidden", "utf8");
    const outsideReviewRoot = await realpath(await mkdtemp(join(tmpdir(), "joko-review-outside-")));
    cleanups.push(async () => {
      await rm(outsideReviewRoot, { recursive: true, force: true });
    });
    await writeFile(join(outsideReviewRoot, "outside.txt"), "outside-only-secret", "utf8");
    await symlink(
      outsideReviewRoot,
      join(setup.target.workspaceRoot, "linked-outside"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const binding = await setup.adapter.createSession({
      ...sessionInput(setup.target),
      nativeStart: { kind: "new" },
      runtimePolicy: "review_read_only"
    }, reviewContext);
    const threadStart = setup.fake.transport?.requests.findLast((request) => request.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      approvalPolicy: "never",
      environments: [],
      ephemeral: true,
      permissions: "joko-review-readonly",
      runtimeWorkspaceRoots: [setup.target.workspaceRoot],
      selectedCapabilityRoots: [],
      serviceTier: null
    });
    const startParams = threadStart?.params as Readonly<Record<string, unknown>>;
    const reviewCwd = startParams["cwd"];
    expect(typeof reviewCwd).toBe("string");
    expect(reviewCwd).not.toBe(setup.target.workspaceRoot);
    expect(startParams["developerInstructions"]).toBeUndefined();
    expect(startParams["dynamicTools"]).toEqual([
      expect.objectContaining({ name: "joko_read", type: "function" }),
      expect.objectContaining({ name: "joko_grep", type: "function" }),
      expect.objectContaining({ name: "joko_find", type: "function" }),
      expect.objectContaining({ name: "joko_ls", type: "function" })
    ]);
    const reviewConfig = startParams["config"] as Readonly<Record<string, unknown>>;
    expect(reviewConfig).toMatchObject({
      "features.apps": false,
      "features.browser_use": false,
      "features.hooks": false,
      "features.memories": false,
      "features.multi_agent": false,
      "features.plugins": false,
      "features.remote_plugin": false,
      "features.shell_tool": false,
      "features.unified_exec": false,
      "features.view_image": false,
      "mcp_servers.docs.enabled": false,
      "plugins.\"review-plugin@local\".enabled": false,
      "plugins.\"review-plugin@local\".mcp_servers.plugin_docs.enabled": false,
      web_search: "disabled"
    });
    expect(reviewConfig["skills.config"]).toEqual([{ path: skillPath, enabled: false }]);
    expect(reviewConfig["permissions.joko-review-readonly"]).toMatchObject({
      filesystem: {
        ":root": "deny",
        ":tmpdir": "deny",
        ":workspace_roots": { ".": "read", "**/.env": "deny", "**/.git/**": "deny" }
      },
      network: { enabled: false }
    });

    const boundReview = { ...reviewContext, binding, operationId: "review-prompt" };
    await expect(setup.adapter.resumeSession(binding, boundReview))
      .rejects.toMatchObject({ publicError: { code: "CODEX_REVIEW_OPERATION_DENIED" } });
    await expect(setup.adapter.inspectSession(binding, boundReview)).resolves.toMatchObject({
      binding,
      permissionMode: "ask",
      fastMode: false
    });
    await expect(setup.adapter.getNativeHistoryProjection(boundReview))
      .rejects.toMatchObject({ publicError: { code: "CODEX_REVIEW_OPERATION_DENIED" } });
    await setup.adapter.send({
      text: "Review the captured evidence",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, boundReview);
    expect(setup.fake.transport?.requests.findLast((request) => request.method === "turn/start")?.params)
      .toMatchObject({
        approvalPolicy: "never",
        cwd: reviewCwd,
        environments: [],
        runtimeWorkspaceRoots: [setup.target.workspaceRoot],
        serviceTierForTurn: "default"
      });
    const turnId = String(setup.fake.threads.get(binding.nativeSessionId!)?.turns.at(-1)?.["id"]);
    await expect(setup.fake.requestDynamicTool(binding.nativeSessionId!, turnId, "joko_read", {
      path: "review.txt",
      startLine: 2,
      lineCount: 1
    })).resolves.toMatchObject({ success: true, contentItems: [{ text: "2: needle line" }] });
    await expect(setup.fake.requestDynamicTool(binding.nativeSessionId!, turnId, "joko_grep", {
      path: ".",
      query: "needle"
    })).resolves.toMatchObject({ success: true });
    await expect(setup.fake.requestDynamicTool(binding.nativeSessionId!, turnId, "joko_grep", {
      path: ".",
      query: "outside-only-secret"
    })).resolves.toMatchObject({
      success: true,
      contentItems: [{ text: "No match." }]
    });
    await expect(setup.fake.requestDynamicTool(binding.nativeSessionId!, turnId, "joko_find", {
      path: ".",
      pattern: "*.txt"
    })).resolves.toMatchObject({ success: true });
    await expect(setup.fake.requestDynamicTool(binding.nativeSessionId!, turnId, "joko_ls", {
      path: "."
    })).resolves.toMatchObject({ success: true });
    await expect(setup.fake.requestDynamicTool(binding.nativeSessionId!, turnId, "joko_read", {
      path: "../outside.txt"
    })).resolves.toMatchObject({ success: false });
    await expect(setup.fake.requestDynamicTool(binding.nativeSessionId!, turnId, "joko_read", {
      path: ".env"
    })).resolves.toMatchObject({ success: false });
    await expect(setup.fake.requestCommandApproval(binding.nativeSessionId!, turnId))
      .resolves.toEqual({ decision: "decline" });
    expect(interactionRequests).toBe(0);
    await expect(setup.adapter.setName("review", boundReview))
      .rejects.toMatchObject({ publicError: { code: "CODEX_REVIEW_OPERATION_DENIED" } });
    await expect(setup.adapter.deleteSession(binding, boundReview))
      .rejects.toMatchObject({ publicError: { code: "CODEX_REVIEW_OPERATION_DENIED" } });
    await expect(setup.adapter.abort(boundReview)).resolves.toBeUndefined();
    await expect(setup.adapter.closeSession(binding, boundReview)).resolves.toBeUndefined();
    expect(await stat(String(reviewCwd)).catch(() => undefined)).toBeUndefined();
  });

  it("applies exact sticky Plan collaboration settings and explicitly resets later turns", async () => {
    const setup = await createSetup();
    await setup.adapter.describe();
    const events: EventPayload[] = [];
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const bound = (operationId: string) => context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId
    });

    await setup.adapter.setPlanMode(true, bound("plan-setting"));
    expect(setup.fake.transport?.requests.filter((request) => request.method === "thread/settings/update").at(-1)?.params)
      .toMatchObject({
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-test",
            reasoning_effort: "medium",
            developer_instructions: null
          }
        }
      });
    expect(await setup.adapter.inspectSession(binding, bound("inspect-plan"))).toMatchObject({ planMode: true });

    await setup.adapter.send(prompt("plan this"), bound("plan-turn"));
    expect(setup.fake.transport?.requests.filter((request) => request.method === "turn/start").at(-1)?.params)
      .toMatchObject({ collaborationMode: { mode: "plan" } });
    await setup.fake.completeTurn(binding.nativeSessionId!);

    await setup.adapter.setPlanMode(false, bound("default-setting"));
    await setup.adapter.send(prompt("implement this"), bound("default-marker-turn"));
    expect(setup.fake.transport?.requests.filter((request) => request.method === "turn/start").at(-1)?.params)
      .toMatchObject({
        collaborationMode: {
          mode: "default",
          settings: { developer_instructions: null }
        }
      });
    await setup.fake.completeTurn(binding.nativeSessionId!);

    await setup.adapter.send(prompt("continue normally"), bound("default-steady-turn"));
    expect(setup.fake.transport?.requests.filter((request) => request.method === "turn/start").at(-1)?.params)
      .toMatchObject({
        collaborationMode: {
          mode: "default",
          settings: { developer_instructions: "" }
        }
      });
    await setup.fake.completeTurn(binding.nativeSessionId!);
    expect(await setup.adapter.inspectSession(binding, bound("inspect-default"))).toMatchObject({ planMode: false });
  });

  it("projects buffered, nested native child threads without contaminating the parent timeline", async () => {
    const setup = await createSetup(7, { now: () => 1_700_000_000_000 });
    await setup.adapter.describe();
    const events: EventPayload[] = [];
    let childInteractionRequests = 0;
    const binding = await setup.adapter.createSession(
      sessionInput(setup.target),
      context(setup.target, events, { backendInstanceGeneration: 7 })
    );
    const active = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "delegated-root-turn",
      requestInteraction: async () => {
        childInteractionRequests += 1;
        return { kind: "cancelled" };
      }
    });
    await setup.adapter.send(prompt("delegate this"), active);
    const rootThreadId = binding.nativeSessionId!;
    const transport = setup.fake.transport!;
    const childThreadId = "native-child-sensitive-id";
    const grandchildThreadId = "native-grandchild-sensitive-id";

    await transport.emitNotification("thread/started", {
      thread: {
        id: childThreadId,
        parentThreadId: rootThreadId,
        agentRole: "reviewer",
        agentNickname: "Scout"
      }
    });
    await transport.emitNotification("turn/started", {
      threadId: childThreadId,
      turn: { id: "child-turn", status: "inProgress", items: [], error: null }
    });
    const spawnItem = {
      type: "collabAgentToolCall",
      id: "spawn-call-sensitive-id",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: rootThreadId,
      receiverThreadIds: [childThreadId],
      agentsStates: { [childThreadId]: { status: "running", message: null } },
      prompt: "Inspect the implementation",
      model: "gpt-test",
      reasoningEffort: "high"
    };
    await transport.emitNotification("item/started", {
      threadId: rootThreadId,
      turnId: "turn-1",
      item: spawnItem,
      startedAtMs: 1_700_000_000_010
    });
    await transport.emitNotification("thread/started", {
      thread: {
        id: grandchildThreadId,
        parentThreadId: childThreadId,
        agentRole: "researcher",
        agentNickname: "Mapper"
      }
    });
    await expect(transport.requestFromServer("item/tool/requestUserInput", {
      threadId: childThreadId,
      turnId: "child-turn",
      itemId: "child-question",
      isBlocking: true,
      questions: [{ id: "choice", header: "Choice", question: "Choose", options: [] }]
    })).resolves.toEqual({ answers: {} });
    expect(childInteractionRequests).toBe(0);

    const nestedSpawn = {
      type: "collabAgentToolCall",
      id: "nested-spawn-sensitive-id",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: childThreadId,
      receiverThreadIds: [grandchildThreadId],
      agentsStates: { [grandchildThreadId]: { status: "running", message: null } },
      prompt: "Inspect one module",
      model: "gpt-test",
      reasoningEffort: "medium"
    };
    await transport.emitNotification("item/completed", {
      threadId: childThreadId,
      turnId: "child-turn",
      item: nestedSpawn,
      completedAtMs: 1_700_000_000_020
    });
    await transport.emitNotification("turn/started", {
      threadId: grandchildThreadId,
      turn: { id: "grandchild-turn", status: "inProgress", items: [], error: null }
    });
    const grandchildMessage = { type: "agentMessage", id: "grandchild-message", text: "Nested result" };
    await transport.emitNotification("item/started", {
      threadId: grandchildThreadId,
      turnId: "grandchild-turn",
      item: grandchildMessage,
      startedAtMs: 1_700_000_000_030
    });
    await transport.emitNotification("item/completed", {
      threadId: grandchildThreadId,
      turnId: "grandchild-turn",
      item: grandchildMessage,
      completedAtMs: 1_700_000_000_040
    });
    await transport.emitNotification("turn/completed", {
      threadId: grandchildThreadId,
      turn: { id: "grandchild-turn", status: "completed", items: [grandchildMessage], error: null }
    });

    const childMessage = { type: "agentMessage", id: "child-message", text: "Top-level delegated result" };
    await transport.emitNotification("item/started", {
      threadId: childThreadId,
      turnId: "child-turn",
      item: childMessage,
      startedAtMs: 1_700_000_000_050
    });
    await transport.emitNotification("item/agentMessage/delta", {
      threadId: childThreadId,
      turnId: "child-turn",
      itemId: "child-message",
      delta: "Top-level delegated result"
    });
    await transport.emitNotification("item/completed", {
      threadId: childThreadId,
      turnId: "child-turn",
      item: childMessage,
      completedAtMs: 1_700_000_000_060
    });
    await transport.emitNotification("thread/tokenUsage/updated", {
      threadId: childThreadId,
      turnId: "child-turn",
      tokenUsage: {
        total: { totalTokens: 15, inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
        last: { totalTokens: 15, inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
        modelContextWindow: 128_000
      }
    });
    await transport.emitNotification("turn/completed", {
      threadId: childThreadId,
      turn: { id: "child-turn", status: "completed", items: [childMessage, nestedSpawn], error: null }
    });

    const taskEvents = events.filter((event) =>
      event.type === "background_task" || event.type === "subagent_run" || event.type === "subagent_transcript"
    );
    const latestRuns = new Map(events.flatMap((event) => event.type === "subagent_run" ? [[event.run.id, event.run] as const] : []));
    expect(latestRuns.size).toBe(2);
    const rootRun = [...latestRuns.values()].find((run) => run.parentSubagentRunId === undefined)!;
    const nestedRun = [...latestRuns.values()].find((run) => run.parentSubagentRunId !== undefined)!;
    expect(rootRun).toMatchObject({
      state: "completed",
      returnedResult: "Top-level delegated result",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      capabilities: {
        viewActivity: true,
        viewReturnedResult: true,
        viewFullTranscript: true,
        stop: false
      },
      children: [expect.objectContaining({ role: "reviewer", title: "Scout" })]
    });
    expect(nestedRun).toMatchObject({
      parentSubagentRunId: rootRun.id,
      parentTaskId: rootRun.id,
      state: "completed",
      returnedResult: "Nested result",
      children: [expect.objectContaining({ role: "researcher", title: "Mapper" })]
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "text_delta", delta: "Nested result" }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "text_delta", delta: "Top-level delegated result" }));
    const serialized = JSON.stringify(taskEvents);
    expect(serialized).not.toContain(childThreadId);
    expect(serialized).not.toContain(grandchildThreadId);
    expect(serialized).not.toContain("spawn-call-sensitive-id");
    expect(serialized).not.toContain("nested-spawn-sensitive-id");
  });

  it("fails Review closed for an old runtime, unknown MCP inventory, or inherited instructions", async () => {
    const old = await createSetup();
    old.fake.userAgent = "codex/0.150.9";
    const oldDescriptor = await old.adapter.describe();
    expect(oldDescriptor.capabilities.get("review.isolated")).toMatchObject({
      supported: false,
      reason: "upstream_missing"
    });
    expect(oldDescriptor.capabilities.get("plan_mode")).toMatchObject({ supported: false, reason: "upstream_missing" });
    expect(oldDescriptor.capabilities.get("background.tasks")).toMatchObject({ supported: false, reason: "upstream_missing" });
    await expect(old.adapter.createSession({
      ...sessionInput(old.target),
      runtimePolicy: "review_read_only"
    }, {
      ...context(old.target, [], { backendInstanceGeneration: 7 }),
      runtimePolicy: "review_read_only"
    })).rejects.toMatchObject({ publicError: { code: "CODEX_REVIEW_RUNTIME_UNSUPPORTED" } });

    const unaudited = await createSetup();
    unaudited.fake.userAgent = "codex/0.152.0";
    const unauditedDescriptor = await unaudited.adapter.describe();
    expect(unauditedDescriptor.capabilities.get("review.isolated")).toMatchObject({
      supported: false,
      reason: "upstream_missing"
    });
    expect(unauditedDescriptor.capabilities.get("subagents.list")).toMatchObject({ supported: false, reason: "upstream_missing" });

    const unknown = await createSetup();
    unknown.fake.reviewMcpStatuses.push({
      name: "unclassified_runtime_server",
      authStatus: "unsupported",
      resourceTemplates: [],
      resources: [],
      tools: {}
    });
    await unknown.adapter.describe();
    await expect(unknown.adapter.createSession({
      ...sessionInput(unknown.target),
      runtimePolicy: "review_read_only"
    }, {
      ...context(unknown.target, [], { backendInstanceGeneration: 7 }),
      runtimePolicy: "review_read_only"
    })).rejects.toMatchObject({ publicError: { code: "CODEX_REVIEW_INVENTORY_INVALID" } });
    expect(unknown.fake.transport?.requests.some((request) => request.method === "thread/start")).toBe(false);

    const inherited = await createSetup();
    inherited.fake.threadStartResponseOverrides = { instructionSources: ["AGENTS.md"] };
    await inherited.adapter.describe();
    await expect(inherited.adapter.createSession({
      ...sessionInput(inherited.target),
      runtimePolicy: "review_read_only"
    }, {
      ...context(inherited.target, [], { backendInstanceGeneration: 7 }),
      runtimePolicy: "review_read_only"
    })).rejects.toMatchObject({ publicError: { code: "CODEX_REVIEW_PROFILE_INVALID" } });
  });

  it("exposes current native account/login/model operations without retaining stale observations", async () => {
    const setup = await createSetup(7, { now: () => 1_700_000_000_000 });
    const initial = await setup.adapter.readAccount();
    expect(initial).toMatchObject({
      authenticationState: "authenticated",
      supportsLogin: true,
      supportsLogout: true,
      loginMethods: ["api_key", "oauth_browser", "device_code"]
    });

    await expect(setup.adapter.readAccountUsage("openai")).resolves.toEqual({
      providerId: "openai",
      primaryWindow: { usedPercent: 25, windowMinutes: 300, resetAt: 1_800_000_000_000 },
      secondaryWindow: { usedPercent: 50, windowMinutes: 10_080 },
      planType: "plus",
      credits: { hasCredits: true, unlimited: false, balance: "12.5", observedAt: 1_700_000_000_000 },
      observedAt: 1_700_000_000_000
    });
    const quotaReads = setup.fake.transport?.requests.filter((request) =>
      request.method === "account/rateLimits/read").length;
    await expect(setup.adapter.readAccountUsage("foreign-provider"))
      .rejects.toMatchObject({ publicError: { code: "CODEX_PROVIDER_ID_MISMATCH" } });
    expect(setup.fake.transport?.requests.filter((request) =>
      request.method === "account/rateLimits/read")).toHaveLength(quotaReads ?? 0);

    await setup.adapter.logout();
    const signedOut = await setup.adapter.readAccount(true);
    expect(signedOut).toMatchObject({ authenticationState: "signed_out", supportsLogout: false });
    const modelReadsAfterLogout = setup.fake.transport?.requests.filter((request) => request.method === "model/list").length;
    await expect(setup.adapter.listModels()).resolves.toEqual([]);
    expect(setup.fake.transport?.requests.filter((request) => request.method === "model/list"))
      .toHaveLength(modelReadsAfterLogout ?? 0);
    await expect(setup.adapter.beginLogin({ method: "oauth_browser" })).resolves.toMatchObject({
      method: "oauth_browser",
      loginId: "login-browser"
    });
    expect(setup.fake.transport?.requests.findLast((request) => request.method === "account/login/start")?.params)
      .toEqual({ type: "chatgpt" });
    await setup.adapter.cancelLogin("login-browser");
    await expect(setup.adapter.beginLogin({ method: "device_code" })).resolves.toMatchObject({
      method: "device_code",
      loginId: "login-device",
      userCode: "ABCD"
    });
    expect(setup.fake.transport?.requests.findLast((request) => request.method === "account/login/start")?.params)
      .toEqual({ type: "chatgptDeviceCode" });

    setup.fake.failNextAccountRead = true;
    setup.fake.failNextModelList = true;
    const degraded = await setup.adapter.describe();
    expect(degraded.authenticationState).toBe("error");
    expect(degraded.models).toEqual([]);
    expect(degraded.health).toBe("degraded");
  });

  it("applies advertised reasoning effort and Fast Mode to creation, turns, and live settings", async () => {
    const setup = await createSetup();
    await setup.adapter.describe();
    const events: EventPayload[] = [];
    const createContext = context(setup.target, events, { backendInstanceGeneration: 7 });
    const binding = await setup.adapter.createSession({
      ...sessionInput(setup.target),
      effort: "high",
      fastMode: true
    }, createContext);
    expect(setup.fake.transport?.requests.find((request) => request.method === "thread/start")?.params)
      .toMatchObject({ model: "gpt-test", modelProvider: "openai", serviceTier: "fast" });

    const active = context(setup.target, events, {
      binding,
      backendInstanceGeneration: 7,
      operationId: "model-controls"
    });
    await setup.adapter.send({
      text: "use the selected controls",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, active);
    expect(setup.fake.transport?.requests.findLast((request) => request.method === "turn/start")?.params)
      .toMatchObject({ effort: "high", serviceTier: "fast" });

    await setup.adapter.setEffort("medium", active);
    await setup.adapter.setFastMode(false, active);
    expect(setup.fake.transport?.requests
      .filter((request) => request.method === "thread/settings/update")
      .map((request) => request.params))
      .toEqual([
        { threadId: binding.nativeSessionId, effort: "medium" },
        { threadId: binding.nativeSessionId, serviceTier: null }
      ]);
    await expect(setup.adapter.inspectSession(binding, active)).resolves.toMatchObject({
      effort: "medium",
      fastMode: false
    });
  });

  it("attaches to native truth without applying fresh-task defaults", async () => {
    const setup = await createSetup();
    const events: EventPayload[] = [];
    const originalContext = context(setup.target, events, { backendInstanceGeneration: 7 });
    const original = await setup.adapter.createSession(sessionInput(setup.target), originalContext);
    await setup.adapter.closeSession(original, { ...originalContext, binding: original });
    const settingsBefore = setup.fake.transport?.requests.filter((request) =>
      request.method === "thread/settings/update").length ?? 0;

    const attached = await setup.adapter.createSession({
      ...sessionInput(setup.target),
      providerId: "draft-provider",
      modelId: "draft-model",
      effort: "draft-effort",
      fastMode: true,
      permissionMode: "bypassPermissions",
      appendSystemPrompt: "draft instructions",
      nativeStart: { kind: "attach", nativeReference: original.opaqueRef }
    }, context(setup.target, events, { backendInstanceGeneration: 7, generation: 2 }));

    expect(attached).toMatchObject({
      opaqueRef: original.opaqueRef,
      nativeSessionId: original.nativeSessionId,
      generation: 2
    });
    expect(setup.fake.transport?.requests.findLast((request) => request.method === "thread/resume")?.params)
      .toEqual({
        threadId: original.nativeSessionId,
        cwd: setup.target.workspaceRoot,
        excludeTurns: true
      });
    expect(setup.fake.transport?.requests.filter((request) => request.method === "thread/settings/update"))
      .toHaveLength(settingsBefore);
    await expect(setup.adapter.inspectSession(attached, context(setup.target, events, {
      binding: attached,
      backendInstanceGeneration: 7,
      generation: 2
    }))).resolves.toMatchObject({
      binding: attached,
      fastMode: false,
      permissionMode: "ask"
    });
  });
});

interface CatalogProfileFixture {
  readonly active: string;
  readonly source: string;
  readonly nativeSessionId: string;
  readonly sourceRollout: string;
  readonly rolloutContent: string;
}

async function catalogProfileFixture(
  nativeSessionId: string,
  projectless: boolean
): Promise<CatalogProfileFixture> {
  const root = await mkdtemp(join(tmpdir(), "joko-codex-profile-import-"));
  const active = join(root, "active");
  const source = join(root, "external");
  await Promise.all([mkdir(active, { recursive: true }), mkdir(source, { recursive: true })]);
  createCatalogDatabase(active);
  createCatalogDatabase(source);
  const sourceRollout = join(source, "sessions", "2026", "08", `${nativeSessionId}.jsonl`);
  await mkdir(join(sourceRollout, ".."), { recursive: true });
  const rolloutContent = `${JSON.stringify({
    type: "session_meta",
    payload: { id: nativeSessionId, cwd: source, timestamp: 1 }
  })}\n${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello" } })}\n`;
  await writeFile(sourceRollout, rolloutContent, "utf8");
  insertCatalogThread(source, {
    nativeSessionId,
    rolloutPath: sourceRollout,
    workspace: source,
    title: "Imported native task",
    createdAt: 1_000,
    modifiedAt: 2_000
  });
  if (projectless) {
    await writeFile(join(source, ".codex-global-state.json"), JSON.stringify({
      "projectless-thread-ids": [nativeSessionId]
    }), "utf8");
  }
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return { active, source, nativeSessionId, sourceRollout, rolloutContent };
}

function catalogOnlyAdapter(active: string, source: string): CodexBackendAdapter {
  return new CodexBackendAdapter({
    id: "codex-catalog-test",
    instanceGeneration: 1,
    profileDirectory: active,
    catalogProfileDirectories: [source],
    appServer: {
      transport: {
        command: join(tmpdir(), `joko-codex-catalog-missing-${process.pid}`),
        requestTimeoutMs: 500
      }
    }
  });
}

function createCatalogDatabase(profile: string): void {
  const database = new DatabaseSync(join(profile, "state_5.sqlite"));
  try {
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        sandbox_policy TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER,
        updated_at_ms INTEGER,
        thread_source TEXT
      )
    `);
  } finally {
    database.close();
  }
}

function insertCatalogThread(profile: string, input: {
  readonly nativeSessionId: string;
  readonly rolloutPath: string;
  readonly workspace: string;
  readonly title: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
}): void {
  const database = new DatabaseSync(join(profile, "state_5.sqlite"));
  try {
    database.prepare(`
      INSERT INTO threads (
        id, rollout_path, created_at, updated_at, source, model_provider,
        cwd, title, sandbox_policy, approval_mode, archived,
        created_at_ms, updated_at_ms, thread_source
      ) VALUES (?, ?, ?, ?, 'cli', 'openai', ?, ?, '{"type":"disabled"}', 'on-request', 0, ?, ?, 'user')
    `).run(
      input.nativeSessionId,
      input.rolloutPath,
      Math.floor(input.createdAt / 1_000),
      Math.floor(input.modifiedAt / 1_000),
      input.workspace,
      input.title,
      input.createdAt,
      input.modifiedAt
    );
  } finally {
    database.close();
  }
}

function readCatalogThread(profile: string, nativeSessionId: string): Readonly<Record<string, unknown>> | undefined {
  const database = new DatabaseSync(join(profile, "state_5.sqlite"), { readOnly: true });
  try {
    return database.prepare("SELECT * FROM threads WHERE id = ?").get(nativeSessionId) as
      | Readonly<Record<string, unknown>>
      | undefined;
  } finally {
    database.close();
  }
}

async function createSetup(
  instanceGeneration = 7,
  adapterOptions: Omit<CodexAdapterOptions, "id" | "instanceGeneration" | "host"> = {}
) {
  const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "joko-codex-adapter-")));
  const fake = new FakeCodexAppServer();
  const host = new AppServerHost({ transportFactory: () => fake.createTransport() });
  const adapter = new CodexBackendAdapter({ ...adapterOptions, id: "codex-test", instanceGeneration, host });
  const target: TargetDescriptor = {
    id: "target-codex",
    backendId: "codex-test",
    displayName: "Codex target",
    workspaceRoot,
    managed: false,
    trusted: true
  };
  cleanups.push(async () => {
    await adapter.dispose();
    await host.shutdown();
    await rm(workspaceRoot, { recursive: true, force: true });
  });
  return { adapter, fake, host, target };
}

function sessionInput(target: TargetDescriptor): CreateNativeSessionInput {
  return {
    target,
    modelId: "gpt-test",
    providerId: "openai",
    fastMode: false,
    permissionMode: "ask"
  };
}

function prompt(text: string) {
  return {
    text,
    images: [],
    files: [],
    mentions: [],
    disposition: "prompt" as const
  };
}

function context(
  target: TargetDescriptor,
  events: EventPayload[],
  options: {
    readonly binding?: NativeSessionBinding;
    readonly backendInstanceGeneration?: number;
    readonly generation?: number;
    readonly operationId?: string;
    readonly requestInteraction?: AdapterContext["requestInteraction"];
  } = {}
): AdapterContext {
  return {
    sessionId: "session-codex",
    generation: options.generation ?? 1,
    ...(options.backendInstanceGeneration === undefined ? {} : { backendInstanceGeneration: options.backendInstanceGeneration }),
    target,
    ...(options.binding === undefined ? {} : { binding: options.binding }),
    ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
    signal: new AbortController().signal,
    emit: async (event) => { events.push(event); },
    requestInteraction: options.requestInteraction ?? (async () => ({ kind: "cancelled" })),
    artifactCapacityBytes: 1024 * 1024,
    storeArtifact: async () => ({ id: "artifact", sha256: "0".repeat(64), byteLength: 0, mimeType: "application/octet-stream" })
  };
}
