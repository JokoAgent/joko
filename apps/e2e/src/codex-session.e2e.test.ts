import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { create, fromBinary, type JsonObject } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { createCodexAdapter, AppServerHost, TransportFault } from "@joko/adapter-codex";
import { FakeCodexAppServer } from "@joko/adapter-codex/testing";
import { CreateTargetMutationSchema, EntityKind, GetOperationRequestSchema, MessageRole, NativeCatalogImportPresentationSchema, NativeSessionPlacement, NativeSessionStartSchema,
  ObjectiveStatus, OperationMutationSchema, OperationState, RetryState, RunState, ScheduleRecurrenceSchema,
  SetWorkspaceTrustMutationSchema, SubmitOperationRequestSchema, TargetWorkspaceInputSchema, ToolCallState, WorkspaceKind, type Event } from "@joko/contracts";
import { chromium, type Browser } from "playwright-core";
import { expect, it, vi } from "vitest";

import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  abortRunMutation, createManualScheduleMutation, createSessionMutation, navigateMutation, pauseQueueMutation, queueRunIdFrom, resumeQueueMutation,
  retryRunMutation, runIdFrom, scheduleIdFrom, sendInputMutation, sessionIdFrom, submit, triggerScheduleMutation
} from "./operations.js";

const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim() && process.env.JOKO_MOUNTED_WEB_DIR?.trim()
  ? it : it.skip;

it.each([
  { mode: "legacy", inlinePng: "none", name: "reads the original legacy Codex catalog task without a cold executable" },
  { mode: "paginated", inlinePng: "none", name: "reads the original paginated Codex catalog task without a cold executable" },
  { mode: "paginated", inlinePng: "fresh", name: "restores the original inline PNG in the formal Codex catalog task" },
  { mode: "paginated", inlinePng: "existing", name: "restores the original inline PNG for an immutable pre-upgrade Codex User Event" }
] as const)("$name", async ({ mode, inlinePng }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-codex-offline-catalog-")));
  const profileDirectory = join(root, "codex-home");
  const backendId = "codex-offline-catalog";
  const threadId = randomUUID();
  const turnId = "original-completed-turn";
  const question = "Which deliverables did we finish?";
  const answer = "We finished the review and release notes.";
  const originalPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGPQSDlxIkUDAAlTAqltBY9kAAAAAElFTkSuQmCC", "base64");
  const native = new FakeCodexAppServer();
  native.codexHome = profileDirectory;
  let executablePresent = true;
  let failedStarts = 0;
  const host = new AppServerHost({ transportFactory: () => {
    if (executablePresent) return native.createTransport();
    failedStarts += 1;
    throw new TransportFault("spawn_failed", "The original configured Codex executable is unavailable.");
  } });
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    const sessions = join(profileDirectory, "sessions");
    await mkdir(sessions, { recursive: true });
    fixture = await OrchestratorE2eFixture.start({ rootDirectory: root, backendFactories: [{
      instanceId: backendId, adapterKind: "codex", displayName: "Codex catalog history fixture",
      create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host,
        profileDirectory, catalogProfileDirectories: [profileDirectory] })
    }] });
    const cwd = join(root, "user-project");
    await mkdir(cwd);
    const { clients, connectionId, authKey } = await fixture.pair("Local catalog Owner");
    const project = await submit(clients.operation, connectionId, create(OperationMutationSchema, {
      payload: { case: "createTarget", value: create(CreateTargetMutationSchema, {
        backendId, displayName: "Original catalog project",
        workspace: create(TargetWorkspaceInputSchema, { kind: WorkspaceKind.USER_PROJECT, serverPath: cwd })
      }) }
    }));
    if (project.result?.payload.case !== "target") throw new Error("The catalog project was not created.");
    const { targetId, workspaceId } = project.result.payload.value;
    const trust = await submit(clients.operation, connectionId, create(OperationMutationSchema, {
      payload: { case: "setWorkspaceTrust", value: create(SetWorkspaceTrustMutationSchema, { workspaceId, trusted: true }) }
    }));
    expect(trust.state).toBe(OperationState.SUCCEEDED);
    const store = fixture.application.store;
    expect(store.getTarget(targetId).descriptor).toMatchObject({ managed: false, trusted: true, workspaceRoot: cwd });
    const originalInput: Record<string, string | []>[] = [{ type: "text", text: question, text_elements: [] }];
    if (inlinePng !== "none") originalInput.push({ type: "image", url: `data:image/png;base64,${originalPng.toString("base64")}` });
    const seeded = native.seedThread(cwd, [{ id: turnId, status: "completed", items: [
      { id: "original-user", type: "userMessage", content: originalInput },
      { id: "original-assistant", type: "agentMessage", text: answer, phase: null, memoryCitation: null, delivery: null }
    ] }]);
    native.threads.set(threadId, { ...native.threads.get(seeded)!, id: threadId });
    native.threads.delete(seeded);

    const at = new Date("2026-02-05T08:30:00Z");
    const event = (type: string, fields: Record<string, unknown> = {}) => ({ type: "event_msg", payload: { type, ...fields } });
    const records = [
      { type: "session_meta", payload: { id: threadId, cwd, source: "cli", history_mode: mode } },
      event("task_started", { turn_id: turnId }),
      { type: "response_item", payload: { type: "message", role: "user", content: [{
        type: "input_text", text: "<environment_context>Private runtime settings</environment_context>"
      }] } },
      ...(mode === "legacy" ? [event("user_message", { message: question }), event("agent_message", { message: answer })] : [
        event("item_completed", { thread_id: threadId, turn_id: turnId,
          item: { type: "UserMessage", id: "original-user", content: originalInput } }),
        event("item_completed", { thread_id: threadId, turn_id: turnId,
          item: { type: "AgentMessage", id: "original-assistant", content: [{ type: "Text", text: answer }] } })
      ]),
      event("task_complete", { turn_id: turnId })
    ];
    const rollout = join(sessions, `rollout-2026-02-05T08-30-00-${threadId}.jsonl`);
    const sourceBytes = records.map((record, index) => JSON.stringify({ ...record,
      timestamp: new Date(at.getTime() + index * 1_000).toISOString() })).join("\n") + "\n";
    await writeFile(rollout, sourceBytes);
    const database = new DatabaseSync(join(profileDirectory, "state_5.sqlite"));
    try {
      database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT, title TEXT, source TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER)");
      database.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, 'cli', ?, ?, 0)")
        .run(threadId, cwd, rollout, "Original catalog history", at.getTime() / 1_000, at.getTime() / 1_000 + 5);
    } finally { database.close(); }

    const catalog = await clients.session.scanNativeSessionCatalog({ backendId, force: true });
    const entry = catalog.entries.find(candidate => candidate.nativeSessionId === threadId);
    if (entry === undefined) throw new Error("The original local Codex catalog entry is missing.");
    expect(entry.projectTargetId).toBe(targetId);
    const mutation = createSessionMutation({ backendId, targetId, displayName: "Original catalog history" });
    if (mutation.payload.case !== "createSession") throw new Error("Expected a catalog import mutation.");
    mutation.payload.value.initialPlacement = NativeSessionPlacement.PROJECT;
    mutation.payload.value.nativeStart = create(NativeSessionStartSchema, { kind: {
      case: "attach", value: { opaqueNativeReference: entry.nativeReference }
    } });
    mutation.payload.value.catalogImport = create(NativeCatalogImportPresentationSchema, {
      projectId: targetId, snapshotToken: catalog.snapshotToken, createdAt: entry.createdAt, modifiedAt: entry.modifiedAt
    });
    const sessionId = sessionIdFrom(await submit(clients.operation, connectionId, mutation));
    expect(store.listEvents({ sessionId, messageCompleteOnly: true })).toEqual([]);

    executablePresent = false;
    await native.transport!.exit(false);
    await expect(clients.session.listRuntimeCommands({ sessionId })).rejects.toThrow();
    const startsBeforeReading = failedStarts;
    expect(startsBeforeReading).toBeGreaterThan(0);
    const timeline = async () => (await clients.session.listSessionTimeline({ sessionId })).events;
    const snapshot = async () => (await clients.event.getSnapshot({
      scope: { kind: { case: "session", value: { sessionId, recentTimelineItems: 200 } } }
    })).snapshot!.timeline;
    const messages = (events: readonly Event[]) => events.flatMap(({ payload }) => {
      const kind = payload?.kind;
      return kind?.case === "messageCompleted" || kind?.case === "messageStarted" && kind.value.role === MessageRole.USER ? [kind] : [];
    });
    await expect(fixture.anonymous.session.listSessionTimeline({ sessionId })).rejects.toThrow();
    const readers = mode === "legacy" ? [timeline, snapshot] : [snapshot, timeline];
    for (const read of readers) {
      const visible = await read();
      expect(failedStarts, `${read.name} must not start the cold executable`).toBe(startsBeforeReading);
      expect(messages(visible)).toMatchObject(inlinePng !== "none" ? [] : [
        { case: "messageStarted", value: { role: MessageRole.USER, userInputAccepted: false,
          userInput: { parts: [{ content: { case: "text", value: question } }] } } },
        { case: "messageCompleted", value: { role: MessageRole.ASSISTANT, blocks: [{ content: { case: "text", value: answer } }] } }
      ]);
      expect(messages(visible).every(message => message.value.nativeIdentity === undefined)).toBe(true);
    }
    expect(await readFile(rollout, "utf8")).toBe(sourceBytes);

    executablePresent = true;
    const rawUser = () => store.listEvents({ sessionId, messageCompleteOnly: true }).find((event) =>
      event.payload.type === "message_complete" && event.payload.role === "user" && event.payload.nativeHistory?.identity?.entryId === "original-user");
    let beforeRepair: ReturnType<typeof rawUser>;
    if (inlinePng === "existing") {
      const oldProjection = vi.spyOn(store, "findNativeCatalogCreation").mockReturnValue(undefined);
      try {
        await clients.session.listRuntimeCommands({ sessionId });
        beforeRepair = rawUser();
        expect(beforeRepair?.payload).toMatchObject({ blocks: [{ kind: "text", text: question }, { kind: "text", text: "[Image input]" }] });
        expect(store.countArtifacts({ sessionId })).toBe(0);
        await fixture.application.sessionHost.closeIfActive(sessionId);
      } finally { oldProjection.mockRestore(); }
    }
    await clients.session.listRuntimeCommands({ sessionId });
    const canonical = messages(await timeline());
    expect(canonical.map(message => message.value.nativeIdentity?.entryId)).toEqual(["original-user", "original-assistant"]);
    expect(messages(await snapshot())).toEqual(canonical);
    if (inlinePng === "none") {
      expect(store.listEvents({ sessionId }).some(event => event.payload.type === "history_pruned")).toBe(true);
      return;
    }

    const user = canonical[0];
    if (user?.case !== "messageStarted") throw new Error("The original User Message is missing.");
    const parts = user.value.userInput?.parts;
    expect(parts?.map(part => part.content.case)).toEqual(["text", "image"]);
    expect(parts?.[0]?.content).toEqual({ case: "text", value: question });
    const image = parts?.[1]?.content;
    if (image?.case !== "image" || image.value.blob === undefined) throw new Error("The original PNG is missing.");
    const blob = image.value.blob;
    expect(user.value.userInputAccepted).toBe(false);
    expect(store.listQueueItems({ sessionId, includeCleared: true })).toEqual([]);
    expect(store.listRuns({ sessionId })).toEqual([]);
    expect(blob).toMatchObject({ mediaType: "image/png", byteSize: BigInt(originalPng.length),
      sha256Hex: createHash("sha256").update(originalPng).digest("hex") });
    expect(store.getArtifact(blob.blobId)).toMatchObject({ sessionId });
    expect(rawUser()?.payload).toMatchObject({ blocks: [{ kind: "text", text: question }, { kind: "text", text: "[Image input]" }] });
    if (beforeRepair !== undefined) expect(rawUser()).toEqual(beforeRepair);
    const thumbnail = await clients.artifact.getImageThumbnail({ expectedSourceBlob: blob, maximumEdgePixels: 256 });
    const stored = await fixture.application.artifacts.get(blob.blobId);
    expect(thumbnail.sourceBlob).toEqual({ ...blob, createdAt: timestampFromMs(stored.createdAt) });
    expect(thumbnail.result).toMatchObject({ case: "thumbnail", value: { sourceWidthPixels: 2, sourceHeightPixels: 1 } });
    const original = await clients.artifact.getBlobDownloadTicket({ blobId: blob.blobId });
    const download = await fetch(`${fixture.baseUrl}${original.ticket!.relativeEndpoint}`, { headers: { authorization: `Bearer ${authKey}` } });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(originalPng);
    await fixture.application.sessionHost.closeIfActive(sessionId);
    await clients.session.listRuntimeCommands({ sessionId });
    expect(messages(await timeline())).toEqual(canonical);
    expect(store.countArtifacts({ sessionId })).toBe(1);
    expect(await readFile(rollout, "utf8")).toBe(sourceBytes);
  } finally {
    await fixture?.close();
    await host.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps one-shot native Codex schedules on the saved account through refresh, logout and replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-scheduled-account-"));
  const authFile = join(root, "auth.json");
  const backendId = "codex-scheduled-account";
  const native = new FakeCodexAppServer();
  native.codexHome = root;
  const transports: ReturnType<FakeCodexAppServer["createTransport"]>[] = [];
  const host = new AppServerHost({ transportFactory: () => {
    const transport = native.createTransport();
    transports.push(transport);
    return transport;
  } });
  const realNow = Date.now;
  let offset = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  const initialDue = realNow() + 60_000;
  let fixture: OrchestratorE2eFixture | undefined;
  const writeAuthority = async (subject: string, token: string) => {
    const accountId = `fixture-account-${subject}`;
    const payload = Buffer.from(JSON.stringify({ sub: subject, "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
    native.account = { type: "chatgpt", email: null, planType: "plus" };
    await writeFile(authFile, JSON.stringify({ tokens: { id_token: `fixture.${payload}.fixture`, account_id: accountId, access_token: token } }), { mode: 0o600 });
  };
  try {
    await writeAuthority("A", "fixture-a-original");
    const testHost = fixture = await OrchestratorE2eFixture.start({ rootDirectory: root, backendFactories: [{
      instanceId: backendId, adapterKind: "codex", displayName: "Codex schedule account fixture",
      create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host })
    }] });
    const owner = await testHost.pair("Schedule account owner");
    const mutate = (mutation: Parameters<typeof submit>[2]) => submit(owner.clients.operation, owner.connectionId, mutation);
    const targetId = testHost.targetId(backendId);
    const store = testHost.application.store;
    const { providerId, modelId } = store.getBackend(backendId).descriptor.models[0]!;
    const sessionId = sessionIdFrom(await mutate(createSessionMutation({ backendId, targetId, providerId, modelId, effortId: "medium" })));
    const scheduleInput = (name: string, triggerAt: number) => {
      const request = createManualScheduleMutation({ backendId, targetId, sessionId, text: name,
        execution: { model: { model: { providerId, modelId }, effortId: "medium" } } });
      if (request.payload.case !== "createSchedule" || request.payload.value.schedule === undefined) throw new Error("Expected a Schedule input.");
      const input = request.payload.value.schedule;
      input.displayName = name;
      input.recurrence = create(ScheduleRecurrenceSchema, { kind: { case: "oneShot", value: { triggerAt: timestampFromMs(triggerAt) } } });
      return { input, request };
    };
    const refresh = () => mutate(create(OperationMutationSchema, { payload: { case: "refreshProviderCredential", value: { backendId, providerId } } }));
    const dispatches = () => transports.flatMap(transport => transport.requests.filter(request => request.method === "turn/start"));
    const histories = (scheduleId: string) => owner.clients.scheduler.listScheduleRunHistory({ scheduleId });
    const firstId = scheduleIdFrom(await mutate(scheduleInput("Original A after refresh", initialDue).request));
    const signedOutId = scheduleIdFrom(await mutate(scheduleInput("Original A while signed out", initialDue + 60_000).request));
    const replacedId = scheduleIdFrom(await mutate(scheduleInput("Original A after switching to B", initialDue + 120_000).request));
    const original = store.getSchedule(replacedId).executionSnapshot as { nativeSubscriptionAccountKey: string };
    expect(original.nativeSubscriptionAccountKey).toMatch(/^[a-f0-9]{64}$/u);

    await writeAuthority("A", "fixture-a-refreshed");
    expect((await refresh()).state).toBe(OperationState.SUCCEEDED);
    const finishNativeSchedule = async (scheduleId: string, due: number, text: string, count: number) => {
      offset = due - realNow();
      await waitFor(async () => dispatches().length, length => length === count, "the expected scheduled Codex dispatch");
      const nativeId = store.getSession(sessionId).descriptor.binding.nativeSessionId!;
      expect(dispatches().at(-1)?.params).toMatchObject({ threadId: nativeId, model: modelId,
        input: [{ type: "text", text, text_elements: [] }] });
      await waitFor(() => histories(scheduleId), result => result.history[0]?.state === RunState.RUNNING, "accepted scheduled Codex Run");
      await native.completeTurn(nativeId);
      await waitFor(() => histories(scheduleId), result => result.history[0]?.state === RunState.SUCCEEDED, "settled scheduled Codex Run");
    };
    await finishNativeSchedule(firstId, initialDue, "Original A after refresh", 1);

    const logout = await mutate(create(OperationMutationSchema, { payload: { case: "logoutProvider", value: { backendId, providerId } } }));
    expect(logout.state).toBe(OperationState.SUCCEEDED);
    await rm(authFile);
    const rejectOccurrence = async (scheduleId: string, due: number) => {
      offset = due - realNow();
      const history = await waitFor(() => histories(scheduleId), result => result.history[0]?.state === RunState.FAILED, "rejected scheduled account");
      expect(history.history).toHaveLength(1);
      expect(store.findQueueItemByRunId(sessionId, history.history[0]!.runId)).toBeUndefined();
      expect(dispatches()).toHaveLength(1);
      expect(store.getSchedule(scheduleId).enabled).toBe(false);
    };
    await rejectOccurrence(signedOutId, initialDue + 60_000);
    await writeAuthority("B", "fixture-b-original");
    expect((await refresh()).state).toBe(OperationState.SUCCEEDED);
    await rejectOccurrence(replacedId, initialDue + 120_000);

    const resaved = await mutate(create(OperationMutationSchema, { payload: { case: "updateSchedule", value: {
      scheduleId: replacedId, schedule: scheduleInput("Explicitly authorized B", initialDue + 180_000).input
    } } }));
    expect(resaved.state).toBe(OperationState.SUCCEEDED);
    const updated = store.getSchedule(replacedId).executionSnapshot as { nativeSubscriptionAccountKey: string };
    expect(updated.nativeSubscriptionAccountKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(updated.nativeSubscriptionAccountKey).not.toBe(original.nativeSubscriptionAccountKey);
    const publicSchedule = (await owner.clients.scheduler.getSchedule({ scheduleId: replacedId })).schedule;
    expect(publicSchedule?.execution?.model?.model).toMatchObject({ providerId, modelId });
    expect(publicSchedule?.execution).not.toHaveProperty("nativeSubscriptionAccountKey");
    await finishNativeSchedule(replacedId, initialDue + 180_000, "Explicitly authorized B", 2);

    const unknownId = scheduleIdFrom(await mutate(scheduleInput("Original B with a lost receipt", initialDue + 240_000).request));
    native.dropNextTurnClientId = true;
    native.timeoutNextTurnStart = true;
    offset = initialDue + 240_000 - realNow();
    const unknown = await waitFor(() => histories(unknownId), result => result.history[0]?.state === RunState.DISPATCH_UNKNOWN, "unknown automatic dispatch");
    expect(unknown.history).toHaveLength(1);
    expect((await owner.clients.scheduler.getSchedule({ scheduleId: unknownId })).schedule?.nextTriggerAt).toBeUndefined();
    expect(dispatches()).toHaveLength(3);
  } finally {
    clock.mockRestore();
    await fixture?.close();
    await host.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["progress", "no progress", "before dispatch", "unknown dispatch"] as const)("uses the original Codex outcome on manual Retry: %s", async (failure) => {
  const backendId = "codex-manual-retry";
  const native = new FakeCodexAppServer();
  let rejectBeforeWrite = failure === "before dispatch";
  const host = new AppServerHost({ transportFactory: () => {
    const transport = native.createTransport();
    const request = transport.request.bind(transport);
    transport.request = async (method, params, options) => {
      if (method === "turn/start" && rejectBeforeWrite) {
        rejectBeforeWrite = false;
        throw new TransportFault("not_started", "The scripted turn could not be written.");
      }
      return request(method, params, options);
    };
    return transport;
  } });
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({ backendFactories: [{
      instanceId: backendId, adapterKind: "codex", displayName: "Codex manual Retry fixture",
      create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host })
    }] });
    const { clients, connectionId } = await fixture.pair("Manual retry Owner");
    const sessionId = sessionIdFrom(await submit(clients.operation, connectionId,
      createSessionMutation({ backendId, targetId: fixture.targetId(backendId) })));
    const store = fixture.application.store;
    const binding = store.getSession(sessionId).descriptor.binding;
    const threadId = binding.nativeSessionId!;
    const text = "Inspect the current work and produce a report.";
    if (failure === "unknown dispatch") {
      native.dropNextTurnClientId = true;
      native.timeoutNextTurnStart = true;
    }
    const sourceRunId = queueRunIdFrom(await submit(clients.operation, connectionId, sendInputMutation(sessionId, BigInt(binding.generation), text)));
    const transport = native.transport!;
    const turnWrites = () => transport.requests.filter(request => request.method === "turn/start");
    const retry = retryRunMutation(sourceRunId);
    if (failure === "unknown dispatch") {
      await waitFor(() => clients.run.getRun({ runId: sourceRunId }), response => response.run?.state === RunState.DISPATCH_UNKNOWN, "unknown Codex dispatch");
      expect((await submit(clients.operation, connectionId, retry)).state).toBe(OperationState.FAILED);
      expect(store.findRunByParentId(sourceRunId)).toBeUndefined();
      expect(turnWrites()).toHaveLength(1);
      return;
    }

    const accepted = failure !== "before dispatch";
    if (accepted) {
      await waitFor(() => clients.run.getRun({ runId: sourceRunId }), response => response.run?.state === RunState.RUNNING, "accepted Codex retry source");
      const thread = native.threads.get(threadId)!;
      const turn = thread.turns.at(-1)!;
      if (failure === "progress") {
        const turnId = turn["id"];
        if (typeof turnId !== "string") throw new Error("The original retry turn has no native identity.");
        const item = { type: "agentMessage", id: "completed-before-failure", text: "The inspection is already complete.", phase: null, memoryCitation: null, delivery: null };
        await transport.emitNotification("item/completed", { threadId, turnId, item, completedAtMs: Date.now() });
        turn["items"] = [...(Array.isArray(turn["items"]) ? turn["items"] : []), item];
      }
      turn["status"] = "failed";
      turn["error"] = { codexErrorInfo: "other", message: "The model operation reported a terminal failure." };
      thread.status = { type: "idle" };
      await transport.emitNotification("turn/completed", { threadId, turn });
    }
    await waitFor(() => clients.run.getRun({ runId: sourceRunId }), response => response.run?.state === RunState.FAILED, "terminal retryable Codex failure");
    const sourceQueue = store.findQueueItemByRunId(sessionId, sourceRunId);
    expect(sourceQueue?.backendAcceptedAt !== undefined).toBe(accepted);
    expect(turnWrites()).toHaveLength(accepted ? 1 : 0);
    if (failure === "no progress") {
      expect(store.findLatestRunForSessionGeneration(sessionId, binding.generation)?.descriptor.id).toBe(sourceRunId);
      const origin = store.findVisibleSessionMessageOrigin({ sessionId, role: "user", includeRetainedContext: false });
      const ownedInput = origin === undefined ? undefined : store.findEvent(origin.eventId);
      expect(ownedInput?.runId === sourceRunId && ownedInput.operationId === sourceQueue?.operationId).toBe(false);
      const capture = await waitFor(() => Promise.resolve(store.listEvents({ sessionId }).find(event =>
        event.runId === sourceRunId && event.payload.type === "workspace_diff")), event => event !== undefined, "the original empty Codex workspace capture");
      expect(capture?.payload).toMatchObject({ type: "workspace_diff", changeSet: { completeBaseline: true, changes: [] } });
    }

    if (failure === "progress") {
      expect(store.findLatestAssistantReplyForRuns(sessionId, [sourceRunId])?.payload).toMatchObject({ type: "message_complete", role: "assistant",
        blocks: [{ kind: "text", text: "The inspection is already complete." }] });
      const progressRead = vi.spyOn(store, "findVisibleSessionMessageOrigin").mockImplementationOnce(() => { throw new Error("Source timeline unavailable"); });
      try {
        const rejected = await submit(clients.operation, connectionId, retry);
        expect(rejected.state).toBe(OperationState.FAILED);
        expect(store.findRunByParentId(sourceRunId)).toBeUndefined();
        expect(turnWrites()).toHaveLength(1);
      } finally { progressRead.mockRestore(); }
    }

    const retryId = randomUUID();
    const original = await submit(clients.operation, connectionId, retry, retryId);
    const childId = runIdFrom(original);
    await waitFor(() => clients.run.getRun({ runId: childId }), response => response.run?.state === RunState.RUNNING, "accepted Codex retry child");
    const expected = failure === "progress" ? "Continue from the interrupted response. Do not repeat completed work or side effects." : text;
    expect(turnWrites()).toHaveLength(accepted ? 2 : 1);
    expect(turnWrites().at(-1)?.params).toMatchObject({ threadId, input: [{ type: "text", text: expected, text_elements: [] }] });
    expect(store.findRunByParentId(sourceRunId)?.descriptor.id).toBe(childId);
    expect(store.findQueueItemByRunId(sessionId, sourceRunId)?.body.text).toBe(text);
    expect(store.findQueueItemByRunId(sessionId, childId)?.body.text).toBe(expected);
    expect(store.getRun(sourceRunId).descriptor.state).toBe("failed");
    expect(runIdFrom(await submit(clients.operation, connectionId, retry, retryId))).toBe(childId);
    expect((await submit(clients.operation, connectionId, retry)).state).toBe(OperationState.FAILED);
    expect(turnWrites()).toHaveLength(accepted ? 2 : 1);
    await native.completeTurn(threadId);
    await waitFor(() => clients.run.getRun({ runId: childId }), response => response.run?.state === RunState.SUCCEEDED, "the single retry child to settle");
  } finally {
    await fixture?.close();
    await host.shutdown();
  }
});

it("routes a plain Owner Skill command through Connect to a typed native turn", async () => {
  const backendId = "codex-native-skill";
  const native = new FakeCodexAppServer();
  const host = new AppServerHost({ transportFactory: () => native.createTransport() });
  const sourcePath = await realpath(await mkdtemp(join(tmpdir(), "joko-codex-short-skill-")));
  const content = "---\nname: repo-audit\ndescription: Review changes\n---\nInspect the specified source files.\n";
  const revision = `sha256:${createHash("sha256").update(`D\0\0F\0SKILL.md\0${Buffer.byteLength(content)}\0`).update(content).digest("hex")}`;
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    await writeFile(join(sourcePath, "SKILL.md"), content, "utf8");
    fixture = await OrchestratorE2eFixture.start({ backendFactories: [{
      instanceId: backendId, adapterKind: "codex", displayName: "Codex Skill command fixture",
      create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host,
        resolveNativeSkills: async () => [{ sourcePath, resource: { id: "approved-repo-skill", kind: "skill", name: "Repo audit",
          source: "managed", state: "approved", revision, resourceVersion: 1n }, assertCurrent: () => undefined }]
      })
    }] });
    const { clients, connectionId } = await fixture.pair("Codex Skill command Owner");
    const sessionId = sessionIdFrom(await submit(clients.operation, connectionId,
      createSessionMutation({ backendId, targetId: fixture.targetId(backendId) })));
    const binding = fixture.application.store.getSession(sessionId).descriptor.binding;
    const requests = native.transport!.requests;
    const start = requests.find(request => request.method === "thread/start")?.params as {
      readonly config?: { readonly "skills.config"?: readonly { readonly path: string; readonly enabled: boolean }[] };
    } | undefined;
    const mount = start?.config?.["skills.config"]?.find(entry => entry.enabled);
    if (mount === undefined) throw new Error("The native thread did not receive the approved Skill mount.");
    expect(mount.path).not.toBe(join(sourcePath, "SKILL.md"));
    native.reviewSkills.push({ path: mount.path, name: "repo-audit", description: "Review changes", enabled: true });
    expect((await clients.session.listRuntimeCommands({ sessionId })).commands).toContainEqual(expect.objectContaining({
      name: "repo-audit", resourceId: "approved-repo-skill", loaded: true
    }));
    const text = "/repo-audit review src";
    const runId = queueRunIdFrom(await submit(clients.operation, connectionId, sendInputMutation(sessionId, BigInt(binding.generation), text)));
    await waitFor(() => clients.run.getRun({ runId }), value => value.run?.state === RunState.RUNNING, "typed Codex Skill turn");
    expect(requests.filter(request => request.method === "turn/start")).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ threadId: binding.nativeSessionId, input: [
        { type: "skill", name: "repo-audit", path: mount.path }, { type: "text", text: "review src", text_elements: [] }
      ] }) })
    ]);
    expect(fixture.application.store.findQueueItemByRunId(sessionId, runId)?.body).toMatchObject({ text, mentions: [] });
    await native.completeTurn(binding.nativeSessionId!, "Inspected src.");
    await waitFor(() => clients.run.getRun({ runId }), value => value.run?.state === RunState.SUCCEEDED, "original Codex Skill turn settlement");
  } finally {
    await fixture?.close();
    await host.shutdown();
    await rm(sourcePath, { recursive: true, force: true });
  }
});

it("stops the original Codex Run before the first native turn write and leaves the queue paused", async () => {
  const backendId = "codex-pre-dispatch-stop";
  const native = new FakeCodexAppServer();
  let enteredPreparation = false;
  let releasePreparation!: () => void;
  const holdPreparation = new Promise<void>(resolveHold => { releasePreparation = resolveHold; });
  const host = new AppServerHost({ transportFactory: () => {
    const transport = native.createTransport();
    const request = transport.request.bind(transport);
    transport.request = async (method, params, options) => {
      if (method !== "turn/start" || enteredPreparation) return request(method, params, options);
      const prepare = options?.beforeDispatchAsync;
      if (prepare === undefined) throw new Error("Expected a durable write fence for the first Codex turn.");
      return request(method, params, {
        ...options,
        beforeDispatchAsync: async (signal) => {
          await prepare(signal);
          enteredPreparation = true;
          await holdPreparation;
        }
      });
    };
    return transport;
  } });
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({ backendFactories: [{
      instanceId: backendId, adapterKind: "codex", displayName: "Codex Stop fixture",
      create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host })
    }] });
    const { clients, connectionId } = await fixture.pair("Codex Stop owner");
    const mutate = (mutation: Parameters<typeof submit>[2], operationId?: string) =>
      submit(clients.operation, connectionId, mutation, operationId);
    const sessionId = sessionIdFrom(await mutate(createSessionMutation({ backendId, targetId: fixture.targetId(backendId) })));
    const { store, sessionHost } = fixture.application;
    const binding = store.getSession(sessionId).descriptor.binding;
    const generation = BigInt(binding.generation);
    const originalText = "Stop this original input before its native write.";
    const laterText = "Only this queued input may reach Codex.";
    const firstRunId = queueRunIdFrom(await mutate(sendInputMutation(sessionId, generation, originalText)));
    await waitFor(async () => enteredPreparation, Boolean, "the original Codex native write preparation");
    const firstQueue = store.findQueueItemByRunId(sessionId, firstRunId);
    if (firstQueue?.attemptId === undefined) throw new Error("The original Codex input has no claimed Attempt.");
    expect(firstQueue.state).toBe("dispatching");
    expect(store.findSetting("session", sessionId, "native.dispatch.recovery")?.value).toMatchObject({
      entries: [expect.objectContaining({ runId: firstRunId, queueItemId: firstQueue.id, attemptId: firstQueue.attemptId })]
    });
    const controls = async () => (await clients.queue.getQueueControl({ sessionId })).queueControl!;
    const nextRunId = queueRunIdFrom(await mutate(sendInputMutation(sessionId, generation, laterText)));
    expect((await mutate(pauseQueueMutation(await controls()))).state).toBe(OperationState.SUCCEEDED);
    expect((await clients.run.getRun({ runId: firstRunId })).run?.state).toBe(RunState.QUEUED);
    const abort = abortRunMutation(firstRunId);
    const stopId = randomUUID();
    const stopped = await mutate(abort, stopId);
    expect(stopped.state).toBe(OperationState.SUCCEEDED);
    expect((await clients.operation.getOperation({ operationId: stopId })).operation).toEqual(stopped);
    expect((await clients.run.getRun({ runId: firstRunId })).run?.state).toBe(RunState.ABORTED);
    expect(store.getQueueItem(firstQueue.id).state).toBe("cancelled");
    expect(store.getAttempt(firstQueue.attemptId).descriptor.endedAt).toEqual(expect.any(Number));
    expect(store.findSetting("session", sessionId, "native.dispatch.recovery")).toBeUndefined();
    expect(store.getQueueControl(sessionId).paused).toBe(true);
    expect((await clients.run.getRun({ runId: nextRunId })).run?.state).toBe(RunState.QUEUED);
    const turnWrites = () => native.transport?.requests.filter(request =>
      request.method === "turn/start" || request.method === "turn/interrupt") ?? [];
    expect(turnWrites()).toHaveLength(0);
    releasePreparation();
    await waitFor(async () => sessionHost.observeQueueDispatch(firstQueue),
      preparation => preparation === undefined, "the original Codex preparation to retire");
    expect(turnWrites()).toHaveLength(0);
    expect(await mutate(abort, stopId)).toEqual(stopped);
    expect((await mutate(resumeQueueMutation(await controls()))).state).toBe(OperationState.SUCCEEDED);
    const writes = await waitFor(async () => turnWrites(), requests => requests.length > 0, "the next Codex turn write");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe("turn/start");
    expect(JSON.stringify(writes[0]?.params)).toContain(laterText);
    expect(JSON.stringify(writes[0]?.params)).not.toContain(originalText);
    await native.completeTurn(binding.nativeSessionId!, "The next Codex turn completed.");
    await waitFor(() => clients.run.getRun({ runId: nextRunId }), value => value.run?.state === RunState.SUCCEEDED,
      "the resumed Codex Run to complete");
    expect(store.getSession(sessionId).descriptor.binding).toEqual(binding);
    expect(turnWrites()).toHaveLength(1);
  } finally {
    releasePreparation();
    await fixture?.close();
    await host.shutdown();
  }
});

it("keeps observed usage on the original Codex answer when a completed tool is the last interrupted item", async () => {
  const backendId = "codex-interrupted-usage";
  const native = new FakeCodexAppServer();
  const host = new AppServerHost({ transportFactory: () => native.createTransport() });
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({ backendFactories: [{
      instanceId: backendId, adapterKind: "codex", displayName: "Codex interrupted usage fixture",
      create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host })
    }] });
    const { clients, connectionId, authKey } = await fixture.pair("Interrupted Codex usage owner");
    const sessionId = sessionIdFrom(await submit(clients.operation, connectionId,
      createSessionMutation({ backendId, targetId: fixture.targetId(backendId) })));
    const store = fixture.application.store;
    const binding = store.getSession(sessionId).descriptor.binding;
    const threadId = binding.nativeSessionId!;
    const sent = await submit(clients.operation, connectionId,
      sendInputMutation(sessionId, BigInt(binding.generation), "Check the working tree."));
    const runId = queueRunIdFrom(sent);
    await waitFor(async () => store.findQueueItemByRunId(sessionId, runId),
      item => item?.state === "backend_accepted", "the accepted original Codex turn");
    const thread = native.threads.get(threadId)!;
    expect(thread.historyMode).toBe("paginated");
    const turn = thread.turns[0]!;
    const turnId = String(turn["id"]);
    const assistant = { type: "agentMessage", id: "observed-codex-answer", text: "I have the first result.", phase: null };
    const command = { type: "commandExecution", id: "observed-codex-command", command: "git status --short",
      status: "completed", exitCode: 0, aggregatedOutput: "", durationMs: 1 };
    const transport = native.transport!;
    const report = (method: string, item: JsonObject) => transport.emitNotification(method, { threadId, turnId, item });
    await report("item/started", { ...assistant, text: "" });
    await transport.emitNotification("item/agentMessage/delta", { threadId, turnId, itemId: assistant.id, delta: assistant.text });
    await report("item/completed", assistant);
    await report("item/started", { ...command, status: "inProgress", exitCode: null });
    await report("item/completed", command);
    const originalItems = turn["items"];
    expect(Array.isArray(originalItems)).toBe(true);
    turn["items"] = [...(Array.isArray(originalItems) ? originalItems : []), assistant, command];
    const sample = { totalTokens: 11, inputTokens: 8, outputTokens: 3, cachedInputTokens: 1, reasoningOutputTokens: 0 };
    await transport.emitNotification("thread/tokenUsage/updated", {
      threadId, turnId, tokenUsage: { total: sample, last: sample, modelContextWindow: 128_000 }
    });
    const originalUsage = (await waitFor(() => clients.run.getRun({ runId }),
      ({ run }) => run?.usage?.usage?.totalTokens === 11n && run.usage.messageId === assistant.id,
      "the exact usage on the original live answer")).run!.usage!;
    const stop = await submit(clients.operation, connectionId, abortRunMutation(runId));
    expect(stop.state, stop.error?.message).toBe(OperationState.SUCCEEDED);
    expect(transport.requests.filter(request => request.method === "turn/interrupt").map(request => request.params))
      .toEqual([{ threadId, turnId }]);
    expect(turn["status"]).toBe("interrupted");
    thread.status = { type: "idle" };
    await transport.emitNotification("turn/completed", { threadId, turn });
    const settled = (await waitFor(() => clients.run.getRun({ runId }),
      ({ run }) => run?.state === RunState.ABORTED, "the original Codex interruption")).run!;
    expect(settled.usage).toMatchObject({ usage: { totalTokens: 11n }, messageId: assistant.id });
    expect(settled.usage!.completionEventId).not.toBe(originalUsage.completionEventId);

    const reader = fixture.clients(authKey);
    const scope = { kind: { case: "session" as const, value: { sessionId, recentTimelineItems: 200 } } };
    const snapshot = (await reader.event.getSnapshot({ scope })).snapshot!;
    expect(snapshot.runs.find(run => run.runId === runId)?.usage).toEqual(settled.usage);
    for (const events of [snapshot.timeline, (await reader.session.listSessionTimeline({ sessionId })).events]) {
      const assistantEvents = events.filter(event => event.payload?.kind.case === "messageCompleted"
        && event.payload.kind.value.role === MessageRole.ASSISTANT);
      expect(assistantEvents).toHaveLength(1);
      expect(assistantEvents[0]).toMatchObject({ eventId: settled.usage!.completionEventId,
        identity: { runId, operationId: sent.operationId }, payload: { kind: { value: {
          nativeIdentity: { entryId: assistant.id }, messageId: assistant.id,
          blocks: [{ content: { case: "text", value: assistant.text } }], turnUsage: settled.usage
        } } } });
    }
  } finally {
    await fixture?.close();
    await host.shutdown();
  }
});

it("holds the same Codex Objective when its interrupted native turn completes naturally", async () => {
  const backendId = "codex-objective-stop";
  const native = new FakeCodexAppServer();
  let atInterrupt = false;
  let releaseInterrupt!: () => void;
  const holdInterrupt = new Promise<void>(resolveHold => { releaseInterrupt = resolveHold; });
  const host = new AppServerHost({ transportFactory: () => {
    const transport = native.createTransport();
    const request = transport.request.bind(transport);
    transport.request = async (method, params, options) => {
      const result = await request(method, params, options);
      if (method === "turn/interrupt") {
        atInterrupt = true;
        await holdInterrupt;
      }
      return result;
    };
    return transport;
  } });
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({ backendFactories: [{
      instanceId: backendId, adapterKind: "codex", displayName: "Codex Objective fixture",
      create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host })
    }] });
    const { clients, connectionId } = await fixture.pair("Objective Stop owner");
    const mutate = (mutation: Parameters<typeof submit>[2], operationId?: string) =>
      submit(clients.operation, connectionId, mutation, operationId);
    const sessionId = sessionIdFrom(await mutate(createSessionMutation({ backendId, targetId: fixture.targetId(backendId) })));
    const { store } = fixture.application;
    const binding = store.getSession(sessionId).descriptor.binding;
    const { objective } = await clients.objective.setObjective({
      requestId: randomUUID(), sessionId, expectedSessionGeneration: BigInt(binding.generation),
      text: "Continue until the fixture is complete.", limits: { maximumTurns: 4 }
    });
    const runId = objective?.pendingRunId;
    if (runId === undefined) throw new Error("No Objective Run was admitted.");
    await waitFor(() => clients.run.getRun({ runId }), value => value.run?.state === RunState.RUNNING, "the original Objective Run");
    const nativeThread = native.threads.get(binding.nativeSessionId!);
    const nativeTurnId = nativeThread?.turns[0]?.["id"];
    expect(nativeTurnId).toEqual(expect.any(String));
    const stopId = randomUUID();
    const stop = mutate(abortRunMutation(runId), stopId);
    void stop.catch(() => undefined);
    await waitFor(async () => atInterrupt, Boolean, "Codex to receive the original interrupt");
    expect(native.transport?.requests.find(request => request.method === "turn/interrupt")?.params)
      .toMatchObject({ threadId: binding.nativeSessionId, turnId: nativeTurnId });
    expect((await clients.objective.getObjective({ sessionId })).objective?.status).toBe(ObjectiveStatus.PAUSED);
    await native.completeTurn(binding.nativeSessionId!, "The original turn finished before the interrupt took effect.");
    const settled = await waitFor(() => clients.run.getRun({ runId }), value => value.run?.state === RunState.SUCCEEDED,
      "the original native completion");
    expect(settled.run?.attempts).toMatchObject([{ endedAt: expect.any(Object) }]);
    const paused = (await waitFor(() => clients.objective.getObjective({ sessionId }),
      value => value.objective?.status === ObjectiveStatus.PAUSED && value.objective.pendingRunId === undefined,
      "the settled Objective to stay paused")).objective!;
    expect(paused.turnsUsed).toBe(1);
    expect(nativeThread?.turns).toHaveLength(1);
    releaseInterrupt();
    const receipt = await stop;
    expect(receipt.state).toBe(OperationState.SUCCEEDED);
    expect(await mutate(abortRunMutation(runId), stopId)).toEqual(receipt);
    expect(native.transport?.requests.filter(request => request.method === "turn/interrupt")).toHaveLength(1);
    expect(store.getSession(sessionId).descriptor.binding).toEqual(binding);
    expect(nativeThread?.turns).toHaveLength(1);
    await clients.objective.resumeObjective({ requestId: randomUUID(), sessionId,
      expectedRevision: paused.version!.revision!, expectedOwnerGeneration: paused.ownerGeneration });
    await waitFor(async () => nativeThread?.turns.length ?? 0, turns => turns === 2, "an explicit Objective resume");
  } finally {
    releaseInterrupt();
    await fixture?.close();
    await host.shutdown();
  }
});

it("honors a Codex schedule admitted before model disablement and rejects later runs on the same route", async () => {
  const backendId = "codex-scheduled-model";
  const model = { providerId: "openai", modelId: "gpt-test" };
  const effortId = "medium";
  const native = new FakeCodexAppServer();
  const host = new AppServerHost({ transportFactory: () => native.createTransport() });
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({ backendFactories: [{
      instanceId: backendId, adapterKind: "codex", displayName: "Codex Schedule fixture",
      create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host })
    }] });
    const { clients, connectionId } = await fixture.pair("Schedule owner");
    const mutate = (mutation: Parameters<typeof submit>[2]) => submit(clients.operation, connectionId, mutation);
    const targetId = fixture.targetId(backendId);
    const sessionId = sessionIdFrom(await mutate(createSessionMutation({ backendId, targetId, ...model, effortId })));
    const { binding } = fixture.application.store.getSession(sessionId).descriptor;
    const explicitId = scheduleIdFrom(await mutate(createManualScheduleMutation({
      backendId, targetId, sessionId, text: "Run the saved route", execution: { model: { model, effortId } }
    })));
    const inheritedId = scheduleIdFrom(await mutate(createManualScheduleMutation({
      backendId, targetId, sessionId, text: "Run the task's current route"
    })));
    const queueControl = async () => (await clients.queue.getQueueControl({ sessionId })).queueControl!;
    expect((await mutate(pauseQueueMutation(await queueControl()))).state).toBe(OperationState.SUCCEEDED);
    expect((await mutate(triggerScheduleMutation(explicitId))).state).toBe(OperationState.SUCCEEDED);
    const [admitted] = (await clients.scheduler.listScheduleRunHistory({ scheduleId: explicitId })).history;
    expect(admitted?.state).toBe(RunState.QUEUED);
    const turnStarts = () => native.transport?.requests.filter(request => request.method === "turn/start") ?? [];
    expect(turnStarts()).toHaveLength(0);

    const setAccess = (enabled: boolean, modelId?: string) => mutate(create(OperationMutationSchema, {
      payload: { case: "updateBackendSettings", value: { patch: {
        backendId, modelAccessUpdate: { providerId: model.providerId, modelId, enabled }
      } } }
    }));
    expect((await setAccess(false, model.modelId)).state).toBe(OperationState.SUCCEEDED);
    expect((await mutate(resumeQueueMutation(await queueControl()))).state).toBe(OperationState.SUCCEEDED);
    await waitFor(async () => turnStarts(), requests => requests.length === 1, "admitted Codex turn");
    expect(turnStarts()[0]?.params).toMatchObject({ threadId: binding.nativeSessionId, model: model.modelId });
    await native.completeTurn(binding.nativeSessionId!, "The accepted run finished.");
    await waitFor(() => clients.run.getRun({ runId: admitted!.runId }),
      value => value.run?.state === RunState.SUCCEEDED, "admitted Schedule completion");

    for (const scheduleId of [explicitId, inheritedId]) {
      const prior = (await clients.scheduler.listScheduleRunHistory({ scheduleId })).history.map(run => run.runId);
      expect((await mutate(triggerScheduleMutation(scheduleId))).state).toBe(OperationState.SUCCEEDED);
      const { history } = await waitFor(() => clients.scheduler.listScheduleRunHistory({ scheduleId }),
        value => value.history.some(run => !prior.includes(run.runId) && run.finishedAt !== undefined),
        "disabled model Schedule conclusion");
      expect(history.find(run => !prior.includes(run.runId))).toMatchObject({
        sessionId, state: RunState.FAILED, error: { code: "TURN_OVERRIDE_MODEL_UNAVAILABLE" }
      });
    }
    expect((await setAccess(true, model.modelId)).state).toBe(OperationState.SUCCEEDED);
    expect((await setAccess(false)).state).toBe(OperationState.SUCCEEDED);
    expect((await mutate(triggerScheduleMutation(inheritedId))).state).toBe(OperationState.SUCCEEDED);
    const { history } = await waitFor(() => clients.scheduler.listScheduleRunHistory({ scheduleId: inheritedId }),
      value => value.history.length === 2 && value.history.every(run => run.finishedAt !== undefined),
      "disabled Provider Schedule conclusion");
    expect(history).toHaveLength(2);
    for (const run of history) expect(run).toMatchObject({ state: RunState.FAILED, error: { code: "TURN_OVERRIDE_MODEL_UNAVAILABLE" } });
    expect(turnStarts()).toHaveLength(1);
    expect(fixture.application.store.getSession(sessionId).descriptor.binding).toEqual(binding);
  } finally {
    await fixture?.close();
    await host.shutdown();
  }
});

it("rewinds the original Legacy Codex task through its completed native fork anchor", async () => {
  const backendId = "codex-legacy-dialogue";
  const native = new FakeCodexAppServer();
  const host = new AppServerHost({ transportFactory: () => native.createTransport() });
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({ backendFactories: [{
      instanceId: backendId, adapterKind: "codex", displayName: "Codex Legacy history",
      create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host })
    }] });
    const { clients, connectionId } = await fixture.pair("Legacy task owner");
    const store = fixture.application.store;
    const targetId = fixture.targetId(backendId);
    const cwd = store.getTarget(targetId).descriptor.workspaceRoot;
    const completed = (id: string, user: string, assistant: string): JsonObject => ({ id, status: "completed", items: [
      { type: "userMessage", id: `${id}-user`, content: [{ type: "text", text: user, text_elements: [] }] },
      { type: "agentMessage", id: `${id}-assistant`, text: assistant, phase: null, memoryCitation: null, delivery: null }
    ] });
    const firstTurn = completed("original-turn-A", "Which checklist did we finish?", "The archive checklist.");
    const laterTurn = completed("original-turn-U", "Can we draft another checklist?", "I can draft a new one.");
    const threadId = native.seedThread(cwd, [firstTurn, laterTurn]);
    native.threads.get(threadId)!.historyMode = "legacy";

    const candidate = (await clients.session.discoverNativeSessions({ targetId })).sessions.find((session) => session.nativeSessionId === threadId);
    if (candidate === undefined) throw new Error("The ordinary Legacy thread is missing from native discovery.");
    const attach = createSessionMutation({ backendId, targetId, displayName: "Original Legacy task" });
    if (attach.payload.case !== "createSession") throw new Error("Expected an attach mutation.");
    attach.payload.value.nativeStart = create(NativeSessionStartSchema, { kind: {
      case: "attach", value: { opaqueNativeReference: candidate.nativeReference }
    } });
    const sessionId = sessionIdFrom(await submit(clients.operation, connectionId, attach));
    await clients.session.listRuntimeCommands({ sessionId });
    const binding = store.getSession(sessionId).descriptor.binding;
    expect(binding.nativeSessionId).toBe(threadId);
    const timeline = async () => (await clients.session.listSessionTimeline({ sessionId })).events;
    const snapshot = async () => (await clients.event.getSnapshot({ scope: {
      kind: { case: "session", value: { sessionId, recentTimelineItems: 200 } }
    } })).snapshot!.timeline;
    const userRows = (events: readonly Event[]) => events.flatMap((event) => {
      const payload = event.payload?.kind;
      return payload?.case === "messageStarted" && payload.value.role === MessageRole.USER ? [{ event, row: payload.value }] : [];
    });
    const rows = userRows(await timeline());
    expect(rows.map(({ row }) => row.nativeIdentity?.entryId)).toEqual(["original-turn-A-user", "original-turn-U-user"]);
    expect(rows[0]?.row.nativeIdentity?.rewindBefore).toBeUndefined();
    const { event, row } = rows[1]!;
    const boundary = row.nativeIdentity?.rewindBefore;
    expect(boundary?.kind).toEqual({ case: "nativeEntryId", value: "original-turn-A-assistant" });
    expect(userRows(await snapshot())[1]?.row.nativeIdentity?.rewindBefore).toEqual(boundary);
    const recorded = store.findEvent(event.eventId);
    expect(recorded?.payload).toMatchObject({ type: "message_complete", nativeHistory: { identity: { entryId: "original-turn-U-user" } } });
    expect(recorded?.payload).not.toHaveProperty("nativeHistory.identity.rewindBefore");

    const rewind = navigateMutation(sessionId, boundary!, BigInt(binding.generation));
    if (rewind.payload.case !== "navigateSessionBranch") throw new Error("Expected a dialogue rewind.");
    rewind.payload.value.sourceMessageId = row.messageId;
    rewind.payload.value.sourceEventId = event.eventId;
    const result = await submit(clients.operation, connectionId, rewind);
    expect(result).toMatchObject({ state: OperationState.SUCCEEDED, result: { payload: { case: "acknowledgement" } } });
    const replacement = store.getSession(sessionId).descriptor.binding;
    expect(replacement.generation).toBe(binding.generation + 1);
    expect(replacement.nativeSessionId).not.toBe(threadId);
    expect(store.findNativeSessionDerivation(result.operationId)).toMatchObject({ sessionId, sourceBinding: binding, binding: replacement });
    expect(native.threads.get(replacement.nativeSessionId!)?.turns).toEqual([firstTurn]);
    expect(native.threads.get(threadId)?.turns).toEqual([firstTurn, laterTurn]);
    expect(store.findEvent(event.eventId)).toEqual(recorded);
    expect(native.transport!.requests.filter(({ method }) => method === "thread/fork").map(({ params }) => params))
      .toEqual([expect.objectContaining({ threadId, lastTurnId: firstTurn.id, excludeTurns: true, cwd })]);
    expect(native.transport!.requests.some(({ method }) => method === "thread/revert")).toBe(false);
    expect(userRows(await timeline()).map(({ row: item }) => item.nativeIdentity?.entryId)).toEqual(["original-turn-A-user"]);
    await clients.session.listRuntimeCommands({ sessionId });
    expect(userRows(await snapshot()).map(({ row: item }) => item.nativeIdentity?.entryId)).toEqual(["original-turn-A-user"]);
  } finally {
    await fixture?.close();
    await host.shutdown();
  }
});

it("keeps a Codex thread and durable Queue on the production HTTP/SQLite/Connect path while another Backend remains isolated", async () => {
  const backendId = "codex-product";
  const native = new FakeCodexAppServer();
  let fixture: OrchestratorE2eFixture | undefined;
  let committedBeforeNativeDispatch = false;
  const host = new AppServerHost({ transportFactory: () => {
    const transport = native.createTransport();
    const request = transport.request.bind(transport);
    transport.request = async (method, params, options) => {
      if (method === "turn/start") {
        const store = fixture?.application.store;
        const operation = store?.findOperation(inputOperationId);
        const queue = store?.listQueueItems({ sessionId: codexSessionId });
        expect(operation?.status).toBe("completed");
        expect(queue).toHaveLength(1);
        expect(queue?.[0]?.operationId).toBe(inputOperationId);
        expect(queue?.[0]?.attemptId).toBeDefined();
        committedBeforeNativeDispatch = true;
      }
      return request(method, params, options);
    };
    return transport;
  } });
  const inputOperationId = randomUUID();
  let codexSessionId = "";
  try {
    fixture = await OrchestratorE2eFixture.start({ backendFactories: [{
      instanceId: backendId,
      adapterKind: "codex",
      displayName: "Codex product fixture",
      create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host })
    }] });
    const paired = await fixture.pair("Codex product client");
    const piBackendId = fixture.adapter().id;
    const piSessionId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId,
      createSessionMutation({ backendId: piBackendId, targetId: fixture.targetId(piBackendId) })));
    codexSessionId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId,
      createSessionMutation({ backendId, targetId: fixture.targetId(backendId) })));
    const binding = fixture.application.store.getSession(codexSessionId).descriptor.binding;
    const threadId = binding.nativeSessionId;
    expect(threadId).toBeDefined();
    expect(native.threads.has(threadId!)).toBe(true);
    expect((await paired.clients.session.getSession({ sessionId: codexSessionId })).session?.sessionId).toBe(codexSessionId);

    const accepted = await submit(paired.clients.operation, paired.connectionId,
      sendInputMutation(codexSessionId, BigInt(binding.generation), "Keep this task bound to its native thread."), inputOperationId);
    expect(accepted.state).toBe(OperationState.SUCCEEDED);
    const runId = queueRunIdFrom(accepted);
    await waitFor(async () => native.transport?.requests.some((request) => request.method === "turn/start") ?? false,
      (dispatched) => dispatched, "Codex native turn dispatch");
    expect(committedBeforeNativeDispatch).toBe(true);
    expect(native.threads.size).toBe(1);
    await waitFor(async () => fixture!.application.store.findQueueItemByRunId(codexSessionId, runId),
      item => item?.state === "backend_accepted", "the admitted original Codex turn");
    const original = (await paired.clients.run.getRun({ runId })).run!;
    await reconnectCodexTurn(native, threadId!, 2);
    const reconnecting = await waitFor(() => paired.clients.run.getRun({ runId }), value => value.run?.state === RunState.RETRYING,
      "the same Codex Run during native reconnect");
    expect(reconnecting.run).toMatchObject({ runId, activeAttemptId: original.activeAttemptId, attempts: [expect.any(Object)] });
    expect(reconnecting.run?.error).toBeUndefined();
    const readTimeline = () => paired.clients.session.listSessionTimeline({ sessionId: codexSessionId, limit: 200 });
    const pending = (await readTimeline()).events.find(event => event.payload?.kind.case === "retryChanged");
    expect(pending?.identity).toMatchObject({ runId, attemptId: original.activeAttemptId, generation: BigInt(binding.generation) });
    const retry = pending?.payload?.kind;
    if (retry?.case !== "retryChanged") throw new Error("The original Run has no reconnect event.");
    expect(retry.value).toMatchObject({ state: RetryState.WAITING, attemptNumber: 2, maxAttempts: 5,
      error: { code: "CODEX_NATIVE_RECONNECT" } });
    expect(retry.value.retryAt).toBeUndefined();
    await native.completeTurn(threadId!, "One native response");
    const completed = await waitFor(() => paired.clients.run.getRun({ runId }), (value) => value.run?.state === RunState.SUCCEEDED,
      "Codex terminal projection");
    expect(completed.run?.attempts.map(attempt => attempt.attemptId)).toEqual([original.activeAttemptId]);
    expect(native.transport?.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    const restored = (await readTimeline()).events.filter(event => event.identity?.runId === runId);
    expect(restored.map(event => event.payload?.kind.case)).not.toContain("terminalError");
    expect(restored.map(event => event.payload?.kind.case)).not.toContain("recoverableError");
    expect(restored.flatMap(event => event.payload?.kind.case === "retryChanged" ? [event.payload.kind.value.state] : []))
      .toEqual([RetryState.WAITING, RetryState.SUCCEEDED]);
    expect(fixture.application.store.listEvents({ sessionId: codexSessionId }).filter(event => event.runId === runId)
      .some(event => event.payload.type === "error")).toBe(false);
    expect(fixture.application.store.findQueueItemByRunId(codexSessionId, runId)?.state).toBe("completed");
    expect(fixture.application.store.listEvents({ sessionId: codexSessionId }).some((event) =>
      event.payload.type === "message_complete" && event.payload.role === "assistant")).toBe(true);
    expect(fixture.application.store.listEvents({ sessionId: piSessionId }).some((event) =>
      event.payload.type === "message_complete" && event.payload.role === "assistant")).toBe(false);

    native.threads.delete(threadId!);
    const missing = await submit(paired.clients.operation, paired.connectionId,
      sendInputMutation(codexSessionId, BigInt(fixture.application.store.getSession(codexSessionId).descriptor.binding.generation),
        "Do not silently create a replacement thread."));
    const missingRunId = queueRunIdFrom(missing);
    await waitFor(async () => fixture!.application.store.getRun(missingRunId).descriptor.state,
      (state) => state === "failed", "missing native thread failure");
    expect(native.threads.size).toBe(0);
    expect(fixture.application.store.getSession(piSessionId).descriptor.deletedAt).toBeUndefined();
    expect((await paired.clients.session.getSession({ sessionId: piSessionId })).session?.sessionId).toBe(piSessionId);
    const piGeneration = BigInt(fixture.application.store.getSession(piSessionId).descriptor.binding.generation);
    const piAccepted = await submit(paired.clients.operation, paired.connectionId,
      sendInputMutation(piSessionId, piGeneration, "Independent Backend remains usable."));
    const piRunId = queueRunIdFrom(piAccepted);
    await waitFor(() => paired.clients.run.getRun({ runId: piRunId }),
      (value) => value.run?.state === RunState.SUCCEEDED, "independent Backend completion");
    expect(fixture.application.store.listEvents({ sessionId: piSessionId }).some((event) =>
      event.payload.type === "message_complete" && event.payload.role === "assistant")).toBe(true);
  } finally {
    await fixture?.close();
    await host.shutdown();
  }
});

it("keeps previous Codex usage off current commentary through a fresh task read during tool execution", async () => {
  const backendId = "codex-running-usage";
  const native = new FakeCodexAppServer();
  const host = new AppServerHost({ transportFactory: () => native.createTransport() });
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    const service = fixture = await OrchestratorE2eFixture.start({ backendFactories: [{ instanceId: backendId, adapterKind: "codex",
      displayName: "Codex running usage fixture", create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host }) }] });
    const { authKey, clients, connectionId } = await service.pair("Codex usage Owner");
    const sessionId = sessionIdFrom(await submit(clients.operation, connectionId,
      createSessionMutation({ backendId, targetId: service.targetId(backendId) })));
    const store = service.application.store;
    const binding = store.getSession(sessionId).descriptor.binding;
    const threadId = binding.nativeSessionId;
    if (threadId === undefined) throw new Error("The task has no native Codex thread.");

    const send = async (text: string) => {
      const admitted = await submit(clients.operation, connectionId, sendInputMutation(sessionId, BigInt(binding.generation), text));
      const runId = queueRunIdFrom(admitted);
      await waitFor(async () => store.listQueueItems({ sessionId }), items => items.some(item => item.runId === runId && item.state === "backend_accepted"),
        "the native acknowledgement for the original Run");
      const turnId = native.threads.get(threadId)?.turns.at(-1)?.["id"];
      if (typeof turnId !== "string") throw new Error("No native turn for the accepted Run.");
      return { runId, turnId };
    };
    const first = await send("Finish the first turn");
    await native.completeTurn(threadId, "First answer.");
    await waitFor(() => clients.run.getRun({ runId: first.runId }), ({ run }) => run?.state === RunState.SUCCEEDED, "first Codex Run to settle");
    expect(store.listEvents({ sessionId }).some(event => event.runId === first.runId && event.payload.type === "usage"
      && event.payload.usage.totalTokens === 10)).toBe(true);

    const current = await send("Check the workspace next");
    expect(current.turnId).not.toBe(first.turnId);
    const commentary = { type: "agentMessage", id: "current-commentary", text: "I will check the workspace.",
      phase: "commentary", memoryCitation: null, delivery: null };
    const command = { type: "commandExecution", id: "current-command", command: "git status --short", status: "inProgress" };
    await native.transport!.emitNotification("item/completed", { threadId, turnId: current.turnId, item: commentary });
    await native.transport!.emitNotification("item/started", { threadId, turnId: current.turnId, item: command });
    const restored = service.clients(authKey);
    expect((await restored.event.getSnapshot({})).snapshot?.runs.find(run => run.runId === current.runId)?.state).toBe(RunState.RUNNING);
    expect((await restored.tool.getToolCall({ toolCallId: command.id })).toolCall).toMatchObject({ runId: current.runId, state: ToolCallState.RUNNING });
    const scoped = (await restored.event.getSnapshot({
      scope: { kind: { case: "session", value: { sessionId, recentTimelineItems: 240 } } }
    })).snapshot!.timeline;
    const history = (await restored.session.listSessionTimeline({ sessionId, limit: 240 })).events;
    for (const events of [scoped, history]) {
      const same = events.filter(event => event.payload?.kind.case === "messageCompleted" && event.payload.kind.value.messageId === commentary.id);
      expect(same).toHaveLength(1);
      expect(same[0]?.identity?.runId).toBe(current.runId);
      const completed = same[0]?.payload?.kind;
      if (completed?.case !== "messageCompleted") throw new Error("Original Codex commentary is missing.");
      expect(completed.value.blocks).toMatchObject([{ content: { case: "text", value: commentary.text } }]);
      expect(completed.value.usage).toBeUndefined();
      expect(completed.value.turnUsage).toBeUndefined();
    }
    expect(store.listEvents({ sessionId }).some(event => event.runId === current.runId && event.payload.type === "usage")).toBe(false);
    await native.transport!.emitNotification("item/completed", { threadId, turnId: current.turnId, item: { ...command, status: "completed" } });
    await native.completeTurn(threadId, "Workspace checked.");
    await waitFor(() => restored.run.getRun({ runId: current.runId }), ({ run }) => run?.state === RunState.SUCCEEDED, "current Codex Run to settle");
  } finally {
    await fixture?.close();
    await host.shutdown();
  }
});

it("persists current Codex step plans consistently through generated timeline, Snapshot and tool details", async () => {
  const backendId = "codex-step-plan";
  const native = new FakeCodexAppServer();
  const host = new AppServerHost({ transportFactory: () => native.createTransport() });
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({ backendFactories: [{ instanceId: backendId, adapterKind: "codex",
      displayName: "Step plan fixture", create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host }) }] });
    const paired = await fixture.pair("Step plan client");
    const sessionId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId,
      createSessionMutation({ backendId, targetId: fixture.targetId(backendId) })));
    const binding = fixture.application.store.getSession(sessionId).descriptor.binding;
    const threadId = binding.nativeSessionId!;
    const accepted = await submit(paired.clients.operation, paired.connectionId,
      sendInputMutation(sessionId, BigInt(binding.generation), "Inspect then implement"));
    const runId = queueRunIdFrom(accepted);
    await waitFor(async () => native.transport?.requests.some((request) => request.method === "turn/start") ?? false,
      (value) => value, "step plan native dispatch");
    const turnId = String(native.threads.get(threadId)?.turns.at(-1)?.["id"]);
    const toolCallId = `plan:${turnId}`;
    await native.transport!.emitNotification("turn/plan/updated", { threadId, turnId, explanation: "Initial plan",
      plan: [{ step: "Inspect", status: "inProgress" }, { step: "Implement", status: "pending" }] });
    await native.transport!.emitNotification("turn/plan/updated", { threadId, turnId, explanation: "token=hidden-plan-token",
      plan: [{ step: "Inspect", status: "completed" }, { step: "Implement", status: "pending" }] });
    const expectedInput = JSON.stringify({ explanation: "token=[REDACTED]",
      plan: [{ step: "Inspect", status: "completed" }, { step: "Implement", status: "pending" }] });
    const live = await paired.clients.tool.getToolCall({ toolCallId });
    expect(live.toolCall).toMatchObject({ toolCallId, runId, state: ToolCallState.RUNNING,
      arguments: [{ value: { case: "text", value: expectedInput } }] });
    const scope = { kind: { case: "session" as const, value: { sessionId, recentTimelineItems: 200 } } };
    const liveSnapshot = (await paired.clients.event.getSnapshot({ scope })).snapshot!;
    const liveUpdate = liveSnapshot.timeline.find((event) => event.payload?.kind.case === "toolCallUpdated"
      && event.payload.kind.value.toolCall?.toolCallId === toolCallId);
    expect(liveUpdate?.payload?.kind).toMatchObject({ case: "toolCallUpdated", value: {
      toolCall: { arguments: [{ value: { case: "text", value: expectedInput } }] }
    } });
    await native.completeTurn(threadId, "Inspected; implementation remains pending.");
    await waitFor(() => paired.clients.run.getRun({ runId }), (value) => value.run?.state === RunState.SUCCEEDED,
      "step plan native terminal");
    const final = (await paired.clients.tool.getToolCall({ toolCallId })).toolCall!;
    expect(final).toMatchObject({ state: ToolCallState.SUCCEEDED,
      arguments: [{ value: { case: "text", value: expectedInput } }] });
    const tools = await paired.clients.tool.listToolCalls({ sessionId, runId });
    expect(tools.toolCalls.filter((call) => call.toolCallId === toolCallId)).toEqual([final]);
    const timeline = await paired.clients.session.listSessionTimeline({ sessionId, limit: 200 });
    const restoredUpdate = timeline.events.find((event) => event.payload?.kind.case === "toolCallUpdated"
      && event.payload.kind.value.toolCall?.toolCallId === toolCallId);
    expect(restoredUpdate?.payload?.kind).toMatchObject({ case: "toolCallUpdated", value: {
      toolCall: { arguments: [{ value: { case: "text", value: expectedInput } }] }
    } });
    expect(timeline.events.filter((event) => event.payload?.kind.case === "toolCallStarted"
      && event.payload.kind.value.toolCall?.toolCallId === toolCallId)).toHaveLength(1);
    const durable = fixture.application.store.listEvents({ sessionId });
    expect(durable.filter((event) => event.payload.type === "tool_result" && event.payload.callId === toolCallId)).toHaveLength(1);
    expect(JSON.stringify(durable, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain("hidden-plan-token");
  } finally {
    await fixture?.close();
    await host.shutdown();
  }
});

it("reopens the same Codex history after a recorded in-progress user entry completes while the node is closed", async () => {
  const backendId = "codex-history-replay";
  const native = new FakeCodexAppServer();
  let nativeHost = new AppServerHost({ transportFactory: () => native.createTransport() });
  let fixture: OrchestratorE2eFixture | undefined;
  let rootDirectory: string | undefined;
  const start = () => OrchestratorE2eFixture.start({ rootDirectory, keepRoot: true, backendFactories: [{
    instanceId: backendId, adapterKind: "codex", displayName: "Codex history replay",
    create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host: nativeHost })
  }] });
  try {
    fixture = await start(); rootDirectory = fixture.rootDirectory;
    const paired = await fixture.pair("Codex history replay client");
    const sessionId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId,
      createSessionMutation({ backendId, targetId: fixture.targetId(backendId) })));
    const binding = fixture.application.store.getSession(sessionId).descriptor.binding;
    const threadId = binding.nativeSessionId!;
    const execution = await submit(paired.clients.operation, paired.connectionId,
      sendInputMutation(sessionId, BigInt(binding.generation), "Retain the original native input."));
    const runId = queueRunIdFrom(execution);
    await waitFor(async () => fixture!.application.store.findQueueItemByRunId(sessionId, runId),
      item => item?.state === "backend_accepted", "the original native turn acceptance");
    await native.transport!.exit();
    const original = await waitFor(async () => fixture!.application.store.listEvents({ sessionId }).find(event =>
      event.metadata?.namespace === "codex.native_history" && event.payload.type === "message_complete" && event.payload.role === "user"),
      event => event?.metadata?.fields["turnStatus"] === "inProgress", "the recorded running native user entry");
    expect(original).toBeDefined();
    const thread = native.threads.get(threadId)!;
    const turn = thread.turns.at(-1)!;
    await fixture.close(); fixture = undefined;
    expect(turn["status"]).toBe("inProgress");
    turn["status"] = "completed";
    const items = turn["items"];
    if (!Array.isArray(items)) throw new Error("The original native items are unavailable.");
    turn["items"] = [...items, { type: "agentMessage", id: "late-history-assistant",
      text: "The original remote turn completed.", phase: null, memoryCitation: null, delivery: null }];
    thread.status = { type: "idle" };
    nativeHost = new AppServerHost({ transportFactory: () => native.createTransport() });
    fixture = await start();
    const clients = fixture.clients(paired.authKey);
    const lifecycle = async (action: "resumeSession" | "closeSession") => {
      const mutation = create(OperationMutationSchema, {
        preconditions: [{ entity: { kind: EntityKind.SESSION, id: sessionId },
          expectedGeneration: BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation) }],
        payload: action === "resumeSession" ? { case: "resumeSession", value: { sessionId } } : { case: "closeSession", value: { sessionId } }
      });
      const operationId = randomUUID();
      const receipt = await submit(clients.operation, paired.connectionId, mutation, operationId);
      expect(receipt.error, action).toBeUndefined();
      const nativeRequests = () => native.transport!.requests.filter(request => request.method === "thread/resume" || request.method === "thread/unsubscribe");
      const countBeforeReplay = nativeRequests().length;
      expect(await submit(clients.operation, paired.connectionId, mutation, operationId)).toEqual(receipt);
      expect(nativeRequests()).toHaveLength(countBeforeReplay);
      return receipt;
    };
    expect((await lifecycle("resumeSession")).state).toBe(OperationState.SUCCEEDED);
    const events = fixture.application.store.listEvents({ sessionId });
    expect(events.filter(event => event.metadata?.namespace === "codex.native_history"
      && event.payload.type === "message_complete" && event.payload.role === "user"))
      .toEqual([original]);
    expect(events.filter(event => event.payload.type === "message_complete" && event.payload.role === "assistant"
      && event.payload.blocks.some(block => block.kind === "text" && block.text === "The original remote turn completed."))).toHaveLength(1);
    expect(fixture.application.store.getSession(sessionId).descriptor.binding.nativeSessionId).toBe(threadId);
    expect(fixture.application.store.listRuns({ sessionId })).toHaveLength(1);
    expect((await lifecycle("closeSession")).state).toBe(OperationState.SUCCEEDED);
    expect((await lifecycle("resumeSession")).state).toBe(OperationState.SUCCEEDED);
    expect(fixture.application.store.listEvents({ sessionId }).filter(event => event.metadata?.namespace === "codex.native_history"
      && event.payload.type === "message_complete" && event.payload.role === "user"))
      .toEqual([original]);
  } finally {
    await fixture?.close(); await nativeHost.shutdown();
    if (rootDirectory !== undefined) await rm(rootDirectory, { recursive: true, force: true });
  }
});

mountedIt("shows a Codex turn, restores it after reload, and isolates another task in mounted Web", { timeout: 90_000 }, async () => {
  const backendId = "codex-mounted";
  const native = new FakeCodexAppServer();
  const host = new AppServerHost({ transportFactory: () => native.createTransport() });
  let fixture: OrchestratorE2eFixture | undefined;
  let browser: Browser | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({
      webDirectory: resolve(process.env.JOKO_MOUNTED_WEB_DIR!),
      backendFactories: [{ instanceId: backendId, adapterKind: "codex", displayName: "Codex mounted fixture",
        create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host }) }]
    });
    const service = await fixture.pair("Codex mounted setup");
    const piBackendId = fixture.adapter().id;
    const otherSessionId = sessionIdFrom(await submit(service.clients.operation, service.connectionId,
      createSessionMutation({ backendId: piBackendId, targetId: fixture.targetId(piBackendId), displayName: "Other runtime task" })));
    const sessionId = sessionIdFrom(await submit(service.clients.operation, service.connectionId,
      createSessionMutation({ backendId, targetId: fixture.targetId(backendId), displayName: "Codex visible task" })));
    const threadId = fixture.application.store.getSession(sessionId).descriptor.binding.nativeSessionId;
    if (threadId === undefined) throw new Error("Codex task has no native thread identity.");
    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Codex mounted Web" });
    if (challenge.challenge === undefined) throw new Error("Web pairing returned no challenge.");

    browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.locator('details.device-authorization__manual > summary').click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
    await page.getByLabel("Device name").fill("Codex mounted Web");
    await page.locator("form.pair-form button[type=submit]").click();
    const composer = page.locator(".composer-rich-editor__content");
    await composer.waitFor({ state: "visible", timeout: 30_000 });
    await composer.fill("Codex mounted input");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await waitFor(async () => native.transport?.requests.some((request) => request.method === "turn/start") ?? false,
      (dispatched) => dispatched, "mounted Codex dispatch");
    await waitFor(async () => fixture!.application.store.listQueueItems({ sessionId }),
      items => items.some(item => item.state === "backend_accepted"), "the mounted original Codex turn");
    const status = page.locator(".retry-status-indicator");
    const samplingTurnId = native.threads.get(threadId)!.turns.at(-1)!["id"]!;
    await native.transport!.emitNotification("item/agentMessage/delta", { threadId, turnId: samplingTurnId, itemId: "interrupted-sample-A",
      delta: "Received text from the interrupted sample." });
    const samplingRow = page.locator('.message-assistant[data-message-client-id="interrupted-sample-A"]');
    const interruptedSample = async () => {
      const view = await waitFor(() => samplingRow.evaluateAll(rows => ({
        rowCount: rows.length,
        bodyPresent: rows.some(row => row.textContent?.includes("Received text from the interrupted sample.")),
        noticeCount: rows.reduce((sum, row) => sum + Array.from(row.querySelectorAll('[role="note"]'))
          .filter(note => note.textContent === "Response interrupted").length, 0),
        cursorCount: rows.reduce((sum, row) => sum + row.querySelectorAll(".streaming-cursor").length, 0)
      })), value => value.rowCount === 1 && value.bodyPresent && value.noticeCount === 1 && value.cursorCount === 0,
      "the original interrupted sample, notice and absent cursor in the same frame", 20_000);
      expect(view).toEqual({ rowCount: 1, bodyPresent: true, noticeCount: 1, cursorCount: 0 });
    };
    await samplingRow.getByText("Received text from the interrupted sample.", { exact: true }).waitFor({ state: "visible" });
    await samplingRow.locator(".streaming-cursor").waitFor({ state: "visible" });
    await reconnectCodexTurn(native, threadId, 1);
    await status.getByText("Retrying (1/5)...", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await samplingRow.getByText("Response interrupted", { exact: true }).waitFor({ state: "visible" });
    expect(await samplingRow.locator(".streaming-cursor").count()).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    const interruptionNotice = samplingRow.getByRole("note").filter({ hasText: "Response interrupted" });
    await interruptionNotice.scrollIntoViewIfNeeded();
    const noticeBounds = await interruptionNotice.boundingBox();
    expect(noticeBounds).not.toBeNull();
    expect(noticeBounds!.x).toBeGreaterThanOrEqual(0);
    expect(noticeBounds!.x + noticeBounds!.width).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    expect(fixture.application.store.listEvents({ sessionId }).some(event => event.payload.type === "message_complete"
      && event.payload.nativeHistory?.identity?.entryId === "interrupted-sample-A")).toBe(false);
    await reconnectCodexTurn(native, threadId, 2);
    await status.getByText("Retrying (2/5)...", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await native.completeTurn(threadId, "Codex mounted answer");
    await page.locator(".timeline").getByText("Codex mounted answer", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await status.waitFor({ state: "hidden" });
    await interruptedSample();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await composer.waitFor({ state: "visible", timeout: 20_000 });
    await page.locator(".timeline").getByText("Codex mounted answer", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await interruptedSample();
    expect(await status.count()).toBe(0);
    expect(await page.locator(".timeline").getByText(/Retrying|provider connection|fixture provider detail/).count()).toBe(0);

    await page.evaluate((id) => { window.location.hash = `/tasks/${encodeURIComponent(id)}`; }, otherSessionId);
    await page.getByText("Other runtime task", { exact: true }).first().waitFor({ state: "visible", timeout: 20_000 });
    expect(await page.locator(".timeline").getByText("Codex mounted answer", { exact: true }).count()).toBe(0);
    await page.evaluate((id) => { window.location.hash = `/tasks/${encodeURIComponent(id)}`; }, sessionId);
    await page.locator(".timeline").getByText("Codex mounted answer", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });

    await composer.fill("Stop after the received native text");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const partialQueue = await waitFor(async () => fixture!.application.store.listQueueItems({ sessionId }).find(item => item.state === "backend_accepted"),
      item => item !== undefined, "the second original Codex turn");
    const nativeTurn = native.threads.get(threadId)!.turns.at(-1)!;
    const partialItem = { type: "agentMessage", id: "native-partial-item", text: "", phase: null, memoryCitation: null, delivery: null };
    await native.transport!.emitNotification("item/started", { threadId, turnId: nativeTurn["id"]!, item: partialItem });
    await native.transport!.emitNotification("item/agentMessage/delta", { threadId, turnId: nativeTurn["id"]!, itemId: partialItem.id,
      delta: "Received text before Stop." });
    const partialRow = page.locator('.message-assistant[data-message-client-id="native-partial-item"]');
    const stoppedPartial = async () => {
      const view = await waitFor(() => partialRow.evaluateAll(rows => ({
        rowCount: rows.length,
        bodyPresent: rows.some(row => row.textContent?.includes("Received text before Stop.")),
        cursorCount: rows.reduce((sum, row) => sum + row.querySelectorAll(".streaming-cursor").length, 0)
      })), value => value.rowCount === 1 && value.bodyPresent && value.cursorCount === 0,
      "the original stopped partial text and absent cursor in the same frame", 20_000);
      expect(view).toEqual({ rowCount: 1, bodyPresent: true, cursorCount: 0 });
    };
    await partialRow.getByText("Received text before Stop.", { exact: true }).waitFor({ state: "visible" });
    await partialRow.locator(".streaming-cursor").waitFor({ state: "visible" });
    await page.locator(".session-header__abort").click();
    await waitFor(async () => native.transport?.requests.some(request => request.method === "turn/interrupt") ?? false,
      written => written, "Stop for the original native turn");
    expect(native.transport!.requests.filter(request => request.method === "turn/interrupt").at(-1)?.params)
      .toMatchObject({ threadId, turnId: nativeTurn["id"] });
    await native.transport!.emitNotification("turn/completed", { threadId, turn: nativeTurn });
    await waitFor(async () => fixture!.application.store.getRun(partialQueue!.runId!).descriptor.state,
      state => state === "aborted", "the original stopped Run");
    await stoppedPartial();
    expect(fixture.application.store.listEvents({ sessionId }).some(event => event.payload.type === "message_complete"
      && event.payload.nativeHistory?.identity?.entryId === partialItem.id)).toBe(false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await composer.waitFor({ state: "visible", timeout: 20_000 });
    await stoppedPartial();

    native.threads.delete(threadId);
    await composer.fill("Native identity is missing");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await waitFor(async () => fixture!.application.store.listRuns({ sessionId }).map((run) => run.descriptor.state),
      (states) => states.length === 3 && states.includes("failed"), "missing native identity visible run");
    expect(native.threads.size).toBe(0);
    await page.locator(".compact-list > li").filter({ hasText: "Native identity is missing" })
      .getByText("failed", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await fixture?.close();
    await host.shutdown();
  }
});

mountedIt.each(["lost receipt", "late receipt"] as const)(
  "keeps the original Codex message fork and its child draft after a %s", { timeout: 120_000 }, async (delivery) => {
    const backendId = "codex-message-fork";
    const native = new FakeCodexAppServer();
    const host = new AppServerHost({ transportFactory: () => native.createTransport() });
    let fixture: OrchestratorE2eFixture | undefined, browser: Browser | undefined;
    let releaseReceipt!: () => void;
    const holdReceipt = new Promise<void>(resolvePromise => { releaseReceipt = resolvePromise; });
    try {
      fixture = await OrchestratorE2eFixture.start({ webDirectory: resolve(process.env.JOKO_MOUNTED_WEB_DIR!),
        backendFactories: [{ instanceId: backendId, adapterKind: "codex", displayName: "Codex fork fixture",
          create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host }) }] });
      const paired = await fixture.pair("Fork fixture manager");
      const { store } = fixture.application;
      const createTask = async (name: string) => sessionIdFrom(await submit(paired.clients.operation, paired.connectionId,
        createSessionMutation({ backendId, targetId: fixture!.targetId(backendId), displayName: name })));
      const sourceId = await createTask("Original task");
      const otherId = await createTask("Other task");
      const binding = store.getSession(sourceId).descriptor.binding;
      if (binding.nativeSessionId === undefined) throw new Error("The source task has no native Codex thread.");
      const prompt = "Keep this exact prompt in the child draft";
      for (const text of ["Retain this previous complete turn", prompt]) {
        const runId = queueRunIdFrom(await submit(paired.clients.operation, paired.connectionId,
          sendInputMutation(sourceId, BigInt(binding.generation), text)));
        await waitFor(async () => store.findQueueItemByRunId(sourceId, runId)?.state,
          state => state === "backend_accepted", "the original Codex input");
        await native.completeTurn(binding.nativeSessionId, "Completed " + text);
        await waitFor(() => paired.clients.run.getRun({ runId }),
          ({ run }) => run?.state === RunState.SUCCEEDED, "the original completed Codex turn");
      }
      const origin = store.findVisibleSessionMessageOrigin({ sessionId: sourceId, role: "user", includeRetainedContext: false });
      if (origin === undefined) throw new Error("The original Codex user message has no visible persisted identity.");
      const challenge = (await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Message fork browser" })).challenge!;
      browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
      const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 960 } });
      await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sourceId)}`, { waitUntil: "domcontentloaded" });
      await page.locator(".connection-tabs > button").nth(2).click();
      await page.locator("details.device-authorization__manual > summary").click();
      await page.getByLabel("Joko node address").fill(fixture.baseUrl);
      await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challengeId));
      await page.getByLabel("Device name").fill("Message fork browser");
      await page.locator("form.pair-form button[type=submit]").click();
      const task = (id: string) => page.locator(`.session-pane[data-input-session-id='${id}']`);
      const row = task(sourceId).locator(`[data-user-msg-id='${origin.messageId}']`);
      const openFork = async () => {
        await row.hover();
        await row.getByRole("button", { name: "Fork from here", exact: true }).click();
      };
      const submitted: string[] = [], inspected: string[] = [];
      let dropLookup = delivery === "lost receipt";
      await page.route("**/joko.v1.OperationService/SubmitOperation", async route => {
        const data = route.request().postDataBuffer();
        if (data === null) return route.continue();
        const request = fromBinary(SubmitOperationRequestSchema, data);
        if (request.mutation?.payload.case !== "forkSession") return route.continue();
        submitted.push(request.operationId);
        const response = await route.fetch();
        if (delivery === "lost receipt") return route.abort("failed");
        await holdReceipt;
        return route.fulfill({ response });
      });
      await page.route("**/joko.v1.OperationService/GetOperation", async route => {
        const data = route.request().postDataBuffer();
        if (data === null) return route.continue();
        const id = fromBinary(GetOperationRequestSchema, data).operationId;
        if (!submitted.includes(id)) return route.continue();
        inspected.push(id);
        return dropLookup ? route.abort("failed") : route.continue();
      });
      await openFork();
      await page.getByRole("button", { name: "Create fork", exact: true }).click();
      const childOperation = await waitFor(async () => submitted[0] === undefined ? undefined
        : (await paired.clients.operation.getOperation({ operationId: submitted[0] }).catch(() => undefined))?.operation,
      operation => operation?.state === OperationState.SUCCEEDED, "the exact child creation before browser delivery", 30_000);
      const child = childOperation?.result?.payload;
      if (child?.case !== "session") throw new Error("The original operation has no child task.");
      const childId = child.value.sessionId;
      expect(child.value.derivationOrigin).toMatchObject({ sourceSessionId: sourceId, sourceMessageId: origin.messageId, sourceEventId: origin.eventId });
      const openTask = (id: string) => page.evaluate(sessionId => { location.hash = `/tasks/${encodeURIComponent(sessionId)}`; }, id);
      if (delivery === "lost receipt") {
        await page.getByText("The fork result is pending. Choose Fork on the same message to check the original.", { exact: true }).waitFor();
        expect(inspected).toEqual([submitted[0]]);
        dropLookup = false;
        await openFork();
        await page.getByRole("button", { name: "Check original fork", exact: true }).click();
        expect(await waitFor(async () => inspected.length, count => count === 2, "the original receipt lookup")).toBe(2);
      } else {
        await openTask(otherId);
        await task(otherId).waitFor({ state: "visible" });
        releaseReceipt();
        const readChildDraft = () => page.evaluate(id => new Promise<string | undefined>((resolveDraft, reject) => {
          const opened = indexedDB.open("joko-ui");
          opened.onerror = () => reject(opened.error);
          opened.onsuccess = () => {
            const db = opened.result, transaction = db.transaction("drafts"), cursor = transaction.objectStore("drafts").openCursor();
            transaction.oncomplete = () => db.close();
            cursor.onerror = () => reject(cursor.error);
            cursor.onsuccess = () => {
              const row = cursor.result;
              if (row === null) return resolveDraft(undefined);
              if (typeof row.key === "string" && row.key.startsWith("[")) {
                const key: unknown = JSON.parse(row.key);
                if (Array.isArray(key) && key.length === 4 && key[2] === id) return resolveDraft(row.value?.draft?.text);
              }
              row.continue();
            };
          };
        }), childId);
        await waitFor(readChildDraft, text => text === prompt, "the original child draft after leaving its source");
        expect(await task(otherId).isVisible()).toBe(true);
        await openTask(childId);
      }
      const editor = task(childId).locator("[data-composer-editor='true'] .composer-rich-editor__content");
      await editor.getByText(prompt, { exact: true }).waitFor({ state: "visible" });
      expect(await editor.innerText()).toBe(prompt);
      expect(submitted).toEqual([childOperation!.operationId]);
      expect(inspected.every(id => id === childOperation!.operationId)).toBe(true);
      expect(store.listSessions().filter(({ descriptor }) => descriptor.derivationOrigin?.sourceEventId === origin.eventId)).toHaveLength(1);
      expect(native.transport?.requests.filter(request => request.method === "thread/fork")).toHaveLength(1);
      expect(store.getSession(sourceId).descriptor.binding).toEqual(binding);
      expect(store.listQueueItems({ sessionId: childId })).toEqual([]);
    } finally {
      releaseReceipt();
      await browser?.close();
      await fixture?.close();
      await host.shutdown();
    }
  }
);

async function reconnectCodexTurn(native: FakeCodexAppServer, threadId: string, attempt: number): Promise<void> {
  const turnId = native.threads.get(threadId)?.turns.at(-1)?.["id"];
  if (typeof turnId !== "string" || native.transport === undefined) throw new Error("The original native turn is absent.");
  await native.transport.emitNotification("error", { threadId, turnId, willRetry: true,
    error: { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      message: `Reconnecting... ${attempt}/5`, additionalDetails: "fixture provider detail" } });
}
