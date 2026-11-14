import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
  AddResourceMutationSchema,
  ApproveResourceMutationSchema,
  ArtifactStorageCleanupStatus,
  BackendHealth,
  BlobDisposition,
  BlobRefSchema,
  CompactSessionOutcome,
  CompactionState,
  EntityKind,
  InstallationState,
  InputPartSchema,
  InstallResourceMutationSchema,
  MessageRole,
  ModelSelectionSchema,
  OperationMutationSchema,
  OperationState,
  OwnerSnapshotScopeSchema,
  PermissionMode,
  PiMessageRole,
  PortableReplacementNativeState,
  PortableReplacementWorktreeState,
  PortableSessionFidelity,
  PortableSessionImportStatus,
  QueueDeliveryMode,
  ResourceAcquisitionSourceSchema,
  ResourceKind,
  ResourceScope,
  ResourceUsageAction,
  ResourceUsageActivity,
  ResourceUsageSource,
  RunState,
  RuntimeCommandSource,
  SetResourceEnabledMutationSchema,
  SessionSnapshotScopeSchema,
  SessionState,
  SnapshotScopeSchema,
  StateImpact
} from "@joko/contracts";
import type { BlobRef } from "@joko/core";
import { buildPortableSessionExport, preparePortableSessionImport } from "@joko/orchestrator";
import { afterEach, describe, expect, it } from "vitest";

import { createE2eClients } from "./connect-clients.js";
import {
  abortRunMutation,
  archiveMutation,
  compactMutation,
  createManualScheduleMutation,
  createSessionMutation,
  pauseQueueMutation,
  queueRunIdFrom,
  restartBackendMutation,
  resumeQueueMutation,
  scheduleIdFrom,
  sendInputMutation,
  sessionIdFrom,
  submit,
  triggerScheduleMutation
} from "./operations.js";
import {
  REAL_PI_MODEL_ID,
  REAL_PI_PROVIDER_ID,
  REAL_PI_RESPONSE_TEXT,
  RealPiSystemFixture,
  type RealPiProviderReply
} from "./real-pi-fixture.js";
import { installLocalSkill } from "./skill-system-fixture.js";

describe("latest npm Pi through production Orchestrator and binary Connect", () => {
  let fixture: RealPiSystemFixture | undefined;
  let releaseCompactionGate: (() => void) | undefined;

  afterEach(async () => {
    releaseCompactionGate?.();
    releaseCompactionGate = undefined;
    await fixture?.close();
    fixture = undefined;
  });

  it("binds a native Pi image turn and its usage to the original Run after a fresh timeline read", { timeout: 60_000 }, async () => {
    fixture = await RealPiSystemFixture.start({ providerSupportsImages: true });
    const paired = await fixture.pair("Pi image turn owner");
    const created = await submit(paired.clients.operation, paired.connectionId, createSessionMutation({
      backendId: "pi", targetId: "workspace-real-pi", providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID
    }));
    const sessionId = sessionIdFrom(created);
    const generation = (await paired.clients.session.getSession({ sessionId })).session!.nativeBinding!.runtimeGeneration;
    const pixels = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"
    );
    const pixel = await fixture.application.artifacts.ingestBytes(pixels, { fileName: "pixel.png", mimeType: "image/png" });
    const prompt = "Reply to the image fixture.";
    const send = sendInputMutation(sessionId, generation, prompt);
    if (send.payload.case !== "sendInput") throw new Error("The image fixture has no Send mutation.");
    send.payload.value.input!.parts.push(create(InputPartSchema, { content: { case: "image", value: { blob: {
      blobId: pixel.id, fileName: "pixel.png", mediaType: pixel.mimeType, byteSize: BigInt(pixel.byteLength),
      sha256Hex: pixel.sha256, disposition: BlobDisposition.ATTACHMENT
    } } } }));
    const operation = await submit(paired.clients.operation, paired.connectionId, send);
    const runId = queueRunIdFrom(operation);
    const reconnected = fixture.clients(paired.authKey);
    await waitForRealSystem(() => reconnected.run.getRun({ runId }), response => response.run?.state === RunState.SUCCEEDED,
      "the installed Pi image turn to settle", 30_000);
    expect(fixture.providerRequests).toHaveLength(1);
    const request = JSON.stringify(fixture.providerRequests[0]?.body);
    expect(request).toContain(prompt);
    expect(request).toContain(`data:image/png;base64,${pixels.toString("base64")}`);
    const { events } = await reconnected.session.listSessionTimeline({ sessionId });
    const assistant = events.filter(event => event.payload?.kind.case === "messageCompleted"
      && event.payload.kind.value.role === MessageRole.ASSISTANT);
    expect(assistant).toHaveLength(1);
    const [completion] = assistant;
    expect(completion?.identity).toMatchObject({ runId, operationId: operation.operationId });
    const message = completion?.payload?.kind;
    if (message?.case !== "messageCompleted") throw new Error("No durable assistant completion was returned.");
    expect(message.value.turnUsage).toMatchObject({ completionEventId: completion?.eventId,
      messageId: message.value.messageId, usage: { totalTokens: 10n } });
    const usage = (await reconnected.run.getRun({ runId })).run?.usage;
    expect(usage?.completionEventId).toBe(completion?.eventId);
    expect(usage?.usage?.totalTokens).toBe(10n);
  });

  it("preserves omitted, explicit and null Schedule patches through the published Pi tool bridge", { timeout: 60_000 }, async () => {
    let reply: RealPiProviderReply = { kind: "text", text: "No pending Schedule tool call." };
    fixture = await RealPiSystemFixture.start({ enableInternalServer: true, providerResponder: ({ request }) => {
      const messages = request.body["messages"] as readonly { readonly role: string }[];
      return messages.at(-1)?.role === "tool" ? { kind: "text", text: "Schedule tool result received." } : reply;
    } });
    const { store } = fixture.application;
    const targetId = "workspace-real-pi";
    const target = store.getTarget(targetId);
    store.upsertTarget({ ...target.descriptor, trusted: true }, target.metadata);
    const { clients, connectionId } = await fixture.pair("Schedule tool owner");
    const newTask = async () => sessionIdFrom(await submit(clients.operation, connectionId, createSessionMutation({
      backendId: "pi", targetId, providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID,
      permissionMode: PermissionMode.BYPASS_PERMISSIONS
    })));
    const sessionId = await newTask();
    const otherSessionId = await newTask();
    const generation = BigInt(store.getSession(sessionId).descriptor.binding.generation);
    const callTool = async (name: string, args: Readonly<Record<string, unknown>>) => {
      reply = { kind: "tool", name, arguments: args };
      const accepted = await submit(clients.operation, connectionId, sendInputMutation(sessionId, generation, `Apply the next ${name} patch.`));
      expect(accepted.state).toBe(OperationState.SUCCEEDED);
      const runId = queueRunIdFrom(accepted);
      const { run } = await waitForRealSystem(() => clients.run.getRun({ runId }),
        value => value.run?.state === RunState.SUCCEEDED || value.run?.state === RunState.FAILED,
        `${name} to settle`, 15_000);
      expect(run?.state).toBe(RunState.SUCCEEDED);
      expect(store.listEvents({ sessionId }).filter(event => event.runId === runId).map(event => event.payload))
        .toContainEqual(expect.objectContaining({ type: "tool_result", name, isError: false }));
    };

    await callTool("schedule_create", { name: "Bound interval", prompt: "Scheduled work", intervalMs: 3_600_000,
      targetSessionId: sessionId, enabled: false });
    const [schedule] = store.listSchedules();
    expect(schedule).toMatchObject({ targetId, kind: "interval", expression: "3600000", sessionMode: "bound", sessionId });
    const id = schedule!.id;

    await callTool("schedule_update", { id, name: "Renamed interval" });
    expect(store.getSchedule(id)).toMatchObject({ name: "Renamed interval", kind: "interval", expression: "3600000",
      sessionMode: "bound", sessionId });

    await callTool("schedule_update", { id, intervalMs: 7_200_000, targetSessionId: otherSessionId });
    expect(store.getSchedule(id)).toMatchObject({ kind: "interval", expression: "7200000", sessionMode: "bound", sessionId: otherSessionId });

    await callTool("schedule_update", { id, intervalMs: null, cronExpr: "0 9 * * *", targetSessionId: null });
    const updated = store.getSchedule(id);
    expect(updated).toMatchObject({ kind: "cron", expression: "0 9 * * *", sessionMode: "fresh" });
    expect(updated.sessionId).toBeUndefined();
  });

  it("lets a published Pi Schedule finish after pausing or deleting itself", { timeout: 90_000 }, async () => {
    let releasePause!: () => void;
    const pauseGate = new Promise<void>(resolve => { releasePause = resolve; });
    let toolName = "schedule_pause";
    let scheduleId = "";
    const acknowledgement = "The original Schedule run finished its report.";
    fixture = await RealPiSystemFixture.start({ enableInternalServer: true, providerResponder: async ({ request }) => {
      const messages = request.body["messages"] as readonly { readonly role: string }[];
      if (messages.at(-1)?.role === "tool") return { kind: "text", text: acknowledgement };
      if (toolName === "schedule_pause") await pauseGate;
      return { kind: "tool", name: toolName, arguments: { id: scheduleId } };
    } });
    try {
      const { store } = fixture.application;
      const backendId = "pi", targetId = "workspace-real-pi";
      const target = store.getTarget(targetId);
      store.upsertTarget({ ...target.descriptor, trusted: true }, target.metadata);
      const { clients, connectionId } = await fixture.pair("Self-stopping Schedule owner");
      const mutate = (mutation: Parameters<typeof submit>[2]) => submit(clients.operation, connectionId, mutation);
      const sessionId = sessionIdFrom(await mutate(createSessionMutation({ backendId, targetId,
        providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, permissionMode: PermissionMode.BYPASS_PERMISSIONS })));
      const createSchedule = async (text: string) => scheduleIdFrom(await mutate(createManualScheduleMutation({ backendId, targetId, sessionId, text,
        execution: { permissionMode: PermissionMode.BYPASS_PERMISSIONS } })));
      const trigger = async () => expect((await mutate(triggerScheduleMutation(scheduleId))).state).toBe(OperationState.SUCCEEDED);
      const finish = async (runId: string) => {
        const run = await waitForRealSystem(async () => store.getRun(runId).descriptor,
          value => value.endedAt !== undefined, "the invoking Schedule to finish", 20_000);
        expect(run.state).toBe("completed");
        const events = store.listEvents({ sessionId }).filter(event => event.runId === runId);
        expect(events.map(event => event.payload)).toContainEqual(expect.objectContaining({ type: "tool_result", name: toolName, isError: false }));
        expect(events.map(event => event.payload)).toContainEqual(expect.objectContaining({
          type: "message_complete", role: "assistant", blocks: expect.arrayContaining([expect.objectContaining({ text: acknowledgement })])
        }));
      };

      scheduleId = await createSchedule("Pause this Schedule and finish the report.");
      await trigger();
      const [first] = store.listScheduleRuns(scheduleId);
      await waitForRealSystem(async () => store.getRun(first!.runId).descriptor.state,
        value => value === "running", "the original scheduled turn", 15_000);
      await trigger();
      const queued = store.listScheduleRuns(scheduleId).find(run => run.runId !== first!.runId);
      expect(store.findQueueItemByRunId(sessionId, queued!.runId)?.state).toBe("accepted");
      releasePause();
      await finish(first!.runId);
      expect(store.getSchedule(scheduleId).enabled).toBe(false);
      expect(store.findQueueItemByRunId(sessionId, queued!.runId)?.state).toBe("cancelled");

      toolName = "schedule_delete";
      scheduleId = await createSchedule("Delete this Schedule and finish the report.");
      await trigger();
      const deleting = store.listRuns({ sessionId, source: "schedule" }).find(run =>
        run.descriptor.id !== first!.runId && run.descriptor.id !== queued!.runId);
      await finish(deleting!.descriptor.id);
      expect(store.findSchedule(scheduleId)).toBeUndefined();
    } finally { releasePause(); }
  });

  it("pairs, creates, sends, settles, and projects public plus Pi-native context", { timeout: 90_000 }, async () => {
    fixture = await RealPiSystemFixture.start({ holdProviderResponses: true });
    const endpointPublicKey = fixture.application.linkspanIdentity!.publicKey;
    // The production fixture exposes the same identity over its original HTTP
    // API and its attached encrypted ingress. Other fixture clients stay raw.
    expect((await fixture.anonymous.connection.getServerInfo({})).server?.endpointPublicKey).toBe(endpointPublicKey);
    const pinned = createE2eClients(fixture.baseUrl, undefined, 10_000, endpointPublicKey);
    expect((await pinned.connection.getServerInfo({})).server?.endpointPublicKey).toBe(endpointPublicKey);
    const paired = await fixture.pair();

    const backends = await paired.clients.backend.listBackends({});
    const pi = backends.backends.find((backend) => backend.backendId === "pi");
    expect(pi).toMatchObject({
      backendId: "pi",
      health: BackendHealth.HEALTHY,
      installationState: InstallationState.INSTALLED
    });
    expect(pi?.version).toMatch(/^\d+\.\d+\.\d+(?:[-+].*)?$/u);
    const gemini = (await paired.clients.backend.getProvider({ backendId: "pi", providerId: "gemini" })).provider;
    expect(gemini).toMatchObject({
      providerId: "gemini", displayName: "Google Gemini", supportsLogin: false,
      credentialSurfaces: [{ surfaceId: "image-generation", configured: false }]
    });
    expect(gemini?.credentialSurfaces[0]?.models.map(model => model.modelId)).toEqual([
      "gemini/gemini-3-pro-image", "gemini/gemini-3.1-flash-image"
    ]);
    expect(fixture.application.store.getBackend("pi").descriptor.models.some(model => model.providerId === "gemini")).toBe(false);

    const ownerScope = create(SnapshotScopeSchema, {
      kind: { case: "owner", value: create(OwnerSnapshotScopeSchema, {}) }
    });
    const owner = await paired.clients.event.getSnapshot({ scope: ownerScope });
    expect(owner.snapshot?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: "workspace-real-pi", backendId: "pi" })
    ]));
    expect(owner.snapshot?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: expect.objectContaining({ providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID }),
        available: true
      })
    ]));

    const created = await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({
        backendId: "pi",
        targetId: "workspace-real-pi",
        displayName: "Real Pi system turn",
        providerId: REAL_PI_PROVIDER_ID,
        modelId: REAL_PI_MODEL_ID,
        effortId: "off"
      })
    );
    expect(created.state).toBe(OperationState.SUCCEEDED);
    const sessionId = sessionIdFrom(created);
    const sessionAfterCreate = await paired.clients.session.getSession({ sessionId });
    expect(sessionAfterCreate.session).toMatchObject({
      sessionId,
      backendId: "pi",
      targetId: "workspace-real-pi",
      state: SessionState.IDLE,
      model: {
        model: { providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID },
        effortId: "off",
        fastMode: false
      }
    });

    const sessionScope = create(SnapshotScopeSchema, {
      kind: {
        case: "session",
        value: create(SessionSnapshotScopeSchema, { sessionId, recentTimelineItems: 500 })
      }
    });
    const beforeDisconnect = await paired.clients.event.getSnapshot({ scope: sessionScope });
    const disconnect = new AbortController();
    const disconnectedIterator = paired.clients.event.streamEvents(
      { scope: sessionScope, afterCursor: beforeDisconnect.snapshot!.resumeCursor },
      { signal: disconnect.signal }
    )[Symbol.asyncIterator]();
    const firstInFlightEvent = disconnectedIterator.next();
    const prompt = "Reply through the real Pi runtime and do not call tools.";
    const enqueued = await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), prompt)
    );
    expect(enqueued.state).toBe(OperationState.SUCCEEDED);
    const runId = queueRunIdFrom(enqueued);
    await firstInFlightEvent;
    await waitForRealSystem(
      async () => fixture!.providerRequests.length,
      (count) => count === 1,
      "local Provider request before UI disconnect",
      30_000
    );
    disconnect.abort();
    await disconnectedIterator.return?.();

    // This is a distinct Connect transport using the same durable Device
    // authorization. Replacing the UI stream must not transfer or abort the
    // Run that Orchestrator already owns.
    const reconnected = fixture.clients(paired.authKey);
    expect([
      RunState.ACCEPTED,
      RunState.QUEUED,
      RunState.DISPATCHING,
      RunState.RUNNING,
      RunState.WAITING,
      RunState.RETRYING
    ]).toContain((await reconnected.run.getRun({ runId })).run?.state);
    fixture.releaseProviderResponses();
    const settled = await waitForRealSystem(
      () => reconnected.run.getRun({ runId }),
      (response) => response.run?.state === RunState.SUCCEEDED,
      "real Pi Run to settle after UI reconnect",
      30_000
    );
    expect(settled.run?.endedAt).toBeDefined();
    expect(fixture.providerRequests).toHaveLength(1);
    expect(fixture.providerRequests[0]).toMatchObject({
      method: "POST",
      url: "/v1/chat/completions",
      body: { model: REAL_PI_MODEL_ID }
    });
    expect(JSON.stringify(fixture.providerRequests[0]?.body)).toContain(prompt);

    // The Web reducer is not a public workspace package API. This exercises
    // its authoritative input instead: binary protobuf Snapshot/Event shapes
    // from the production Connect endpoint, including the durable timeline.
    const projected = await reconnected.event.getSnapshot({ scope: sessionScope });
    const snapshot = projected.snapshot;
    expect(snapshot?.sessions[0]).toMatchObject({ sessionId, state: SessionState.IDLE });
    expect(snapshot?.sessions[0]?.context).toMatchObject({
      usedTokens: 10n,
      contextWindowTokens: 16_384n,
      cumulativeUsage: {
        inputTokens: 7n,
        outputTokens: 3n,
        totalTokens: 10n
      }
    });
    expect(snapshot?.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId, state: RunState.SUCCEEDED })
    ]));
    const timelineCases = snapshot?.timeline.map((event) => event.payload?.kind.case) ?? [];
    expect(timelineCases).toEqual(expect.arrayContaining([
      "messageCompleted",
      "contextUsageChanged",
      "runDone"
    ]));
    const durablePiSession = snapshot?.pi?.sessions.find((session) => session.productSessionId === sessionId);
    expect(durablePiSession).toMatchObject({
      productSessionId: sessionId,
      messagesComplete: true,
      entriesComplete: true
    });
    expect(durablePiSession?.messages.map((message) => message.role)).toEqual(expect.arrayContaining([
      PiMessageRole.USER,
      PiMessageRole.ASSISTANT
    ]));
    const durablePiText = durablePiSession?.messages.flatMap((message) => message.parts)
      .map((part) => part.content.case === "text" ? part.content.value : "")
      .join("\n") ?? "";
    expect(durablePiText).toContain(prompt);
    expect(durablePiText).toContain(REAL_PI_RESPONSE_TEXT);

    const [nativeState, nativeMessages, nativeEntries, statistics] = await Promise.all([
      reconnected.pi.getPiSessionState({ sessionId }),
      reconnected.pi.listPiMessages({ sessionId }),
      reconnected.pi.listPiEntries({ sessionId }),
      reconnected.session.getSessionStatistics({ sessionId })
    ]);
    expect(nativeState.state).toMatchObject({
      streaming: false,
      messageCount: 2n,
      pendingMessageCount: 0n,
      model: { providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID }
    });
    const typedMessageText = nativeMessages.messages.flatMap((message) => message.parts)
      .map((part) => part.content.case === "text" ? part.content.value : "")
      .join("\n");
    expect(nativeEntries.entries.length).toBeGreaterThanOrEqual(2);
    expect(nativeEntries.activeLeafId).not.toBe("");
    // The direct latest-Pi get_entries authority must retain any native shape
    // that is not yet recognized instead of dropping it.
    const retainedEntryText = nativeEntries.entries
      .map((entry) => entry.payload.case === "custom" ? entry.payload.value.textPreview : "")
      .join("\n");
    expect(`${typedMessageText}\n${retainedEntryText}`).toContain(prompt);
    expect(`${typedMessageText}\n${retainedEntryText}`).toContain(REAL_PI_RESPONSE_TEXT);
    expect(statistics.statistics).toMatchObject({ sessionId });
    expect(statistics.statistics?.messageCount).toBeGreaterThanOrEqual(2n);
    expect(statistics.statistics?.turnCount).toBeGreaterThanOrEqual(1n);
    expect(statistics.statistics?.usage).toMatchObject({
      inputTokens: 7n,
      outputTokens: 3n,
      cacheReadTokens: 0n,
      cacheWriteTokens: 0n,
      totalTokens: 10n
    });
    expect(statistics.statistics?.context).toMatchObject({
      usedTokens: 10n,
      contextWindowTokens: 16_384n,
      reservedTokens: 16_374n,
      cumulativeUsage: {
        inputTokens: 7n,
        outputTokens: 3n,
        totalTokens: 10n
      }
    });

    const source = fixture.application.store.listEvents({ sessionId }).map((event) => event.payload)
      .find((payload) => payload.type === "message_complete" && payload.role === "assistant");
    if (source?.type !== "message_complete") throw new Error("The settled Pi turn has no assistant message.");
    expect(source.usage?.pricingContext).toMatchObject({ inputTokens: 7 });
    const exportPackage = async (expectedFidelity: PortableSessionFidelity) => {
      const { artifact, fidelity } = await reconnected.portableSession.exportPortableSession({ sessionId });
      if (artifact === undefined) throw new Error("The exported Pi task has no package.");
      expect(fidelity).toBe(expectedFidelity);
      const { ticket } = await reconnected.artifact.getBlobDownloadTicket({ blobId: artifact.blobId });
      if (ticket === undefined) throw new Error("The exported Pi task has no download ticket.");
      const downloaded = await fetch(`${fixture!.baseUrl}${ticket.relativeEndpoint}`, { headers: { authorization: `Bearer ${paired.authKey}` } });
      expect(downloaded.status).toBe(200);
      return preparePortableSessionImport(new Uint8Array(await downloaded.arrayBuffer()));
    };
    const restored = await exportPackage(PortableSessionFidelity.FULL);
    expect(restored.projection.messages.find(message => message.role === "assistant")?.usage).toEqual(source.usage);
    expect(restored.nativeSession?.bytes.byteLength).toBeGreaterThan(0);

    const store = fixture.application.store;
    expect(store.getTarget("workspace-real-pi").descriptor.trusted).toBe(false);
    const originalBinding = store.getSession(sessionId).descriptor.binding;
    await expect(fixture.anonymous.portableSession.exportPortableSession({ sessionId })).rejects.toMatchObject({ code: Code.Unauthenticated });
    const archive = await submit(reconnected.operation, paired.connectionId, archiveMutation(sessionId, true));
    expect(archive.state).toBe(OperationState.SUCCEEDED);
    const archived = store.getSession(sessionId).descriptor;
    expect(archived.archived).toBe(true);
    expect(archived.binding).toEqual(originalBinding);
    const archivedExport = await exportPackage(PortableSessionFidelity.FULL);
    if (archivedExport.nativeSession === undefined) throw new Error("The archived Pi package lacks its native transcript.");
    expect(Buffer.from(archivedExport.nativeSession.bytes).equals(await readFile(archived.binding.opaqueRef))).toBe(true);
    expect(archivedExport.projection.messages).toEqual(restored.projection.messages);
    expect(store.getSession(sessionId).descriptor).toMatchObject({ archived: true, binding: archived.binding });

    const restore = await submit(reconnected.operation, paired.connectionId, archiveMutation(sessionId, false));
    expect(restore.state).toBe(OperationState.SUCCEEDED);
    const active = store.getSession(sessionId).descriptor;
    expect(active.archived).toBe(false);
    const nativePath = active.binding.opaqueRef;
    const retainedNative = `${nativePath}.retained-for-export-test`;
    await rename(nativePath, retainedNative);
    try {
      const degraded = await exportPackage(PortableSessionFidelity.PRODUCT_ONLY);
      expect(degraded.nativeSession).toBeUndefined();
      expect(degraded.projection.messages).toEqual(restored.projection.messages);
      expect(store.getSession(sessionId).descriptor).toMatchObject({ archived: false, binding: active.binding });
      await expect(readFile(nativePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(fixture.providerRequests).toHaveLength(1);
    } finally {
      await rename(retainedNative, nativePath);
    }
    const emptyId = sessionIdFrom(await submit(reconnected.operation, paired.connectionId, createSessionMutation({
      backendId: "pi", targetId: "workspace-real-pi", providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID
    })));
    const empty = store.getSession(emptyId).descriptor;
    const emptyPath = empty.binding.opaqueRef;
    const emptyRetainedPath = `${emptyPath}.retained-for-export-test`;
    const movedEmpty = await rename(emptyPath, emptyRetainedPath).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    try {
      await expect(reconnected.portableSession.exportPortableSession({ sessionId: emptyId })).rejects.toMatchObject({
        code: Code.FailedPrecondition, rawMessage: "This task has no native transcript or conversation messages to export."
      });
      expect(store.getSession(emptyId).descriptor.binding).toEqual(empty.binding);
    } finally {
      if (movedEmpty) await rename(emptyRetainedPath, emptyPath);
    }
  });

  it("asks before replacing the same Pi transcript in a separately encrypted package", { timeout: 90_000 }, async () => {
    fixture = await RealPiSystemFixture.start();
    const { artifacts, store, sessionHost } = fixture.application;
    const workspaceDirectory = fixture.workspaceDirectory;
    const paired = await fixture.pair();
    const client = paired.clients.portableSession;
    const targetId = "workspace-real-pi";
    const anotherTargetId = "workspace-second-pi";
    await sessionHost.registerTarget({ ...store.getTarget(targetId).descriptor, id: anotherTargetId });
    const password = "portable e2e package password";
    const timestamp = new Date().toISOString();
    const upload = async (nativeSessionId: string) => {
      const bytes = Buffer.from([
        JSON.stringify({ type: "session", version: 3, id: nativeSessionId, timestamp, cwd: workspaceDirectory }),
        JSON.stringify({ type: "message", id: "user-one", parentId: null, timestamp, message: { role: "user", content: "Frozen Pi history" } })
      ].join("\n") + "\n");
      const encoded = await buildPortableSessionExport({
        applicationVersion: "0.1.0", exportedAt: timestamp, title: "Encrypted Pi history", workspaceKind: "project",
        backendCapability: "native-portable-session-v1", password,
        nativeSession: { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), nativeSessionId },
        events: [{ emittedAt: Date.parse(timestamp), payload: { type: "message_complete", role: "user",
          blocks: [{ kind: "text", text: "Frozen Pi history" }] } }],
        readBlob: blob => artifacts.readBlob(blob)
      });
      const file = await artifacts.ingestBytes(encoded.bytes, { mimeType: "application/vnd.joko.session", fileName: "encrypted.jshare" });
      return create(BlobRefSchema, {
        blobId: file.id, sha256Hex: file.sha256, byteSize: BigInt(file.byteLength),
        mediaType: file.mimeType, fileName: file.fileName ?? ""
      });
    };
    const prepare = async (file: Awaited<ReturnType<typeof upload>>) => {
      const { draft } = await client.inspectPortableSessionImport({ package: file });
      expect(draft).toMatchObject({ encrypted: true, passwordRequired: true });
      const unlocked = await client.unlockPortableSessionImport({ draftId: draft!.draftId, password });
      expect(unlocked.draft?.preview).toMatchObject({ fidelity: PortableSessionFidelity.FULL, nativeHistory: true });
      return draft!.draftId;
    };
    const commit = (draftId: string, overwrite: boolean, destination = targetId, operationId: string = randomUUID()) =>
      client.commitPortableSessionImport({ operationId, draftId, targetId: destination, permissionMode: PermissionMode.ASK, overwrite });

    const firstPackage = await upload("frozen-history");
    const secondPackage = await upload("frozen-history");
    expect(secondPackage.sha256Hex).not.toBe(firstPackage.sha256Hex);
    const first = await commit(await prepare(firstPackage), false);
    if (first.result === undefined) throw new Error("First Pi package returned no import result.");
    const firstId = first.result.sessionId;
    expect(first.result).toMatchObject({ replacedSessionIds: [], fidelity: PortableSessionFidelity.FULL });
    expect(store.getSession(firstId).descriptor.binding.nativeSessionId).not.toBe("frozen-history");

    const secondDraftId = await prepare(secondPackage);
    const refusedOperation = randomUUID();
    await expect(commit(secondDraftId, false, targetId, refusedOperation)).rejects.toMatchObject({ code: Code.AlreadyExists });
    expect(store.getOperation(refusedOperation)).toMatchObject({
      status: "failed", error: { code: "PORTABLE_SESSION_IMPORT_CONFLICT", stateMayHaveChanged: false }
    });
    expect(store.findPortableReplacementCleanup(refusedOperation)).toBeUndefined();
    expect(store.listSessions({ targetId, includeArchived: true }).map(session => session.descriptor.id)).toEqual([firstId]);

    const otherTarget = await commit(await prepare(secondPackage), false, anotherTargetId);
    expect(otherTarget.result).toMatchObject({ replacedSessionIds: [] });
    expect(store.getSession(otherTarget.result!.sessionId).descriptor.targetId).toBe(anotherTargetId);
    const distinct = await commit(await prepare(await upload("different-native-history")), false);
    expect(distinct.result).toMatchObject({ replacedSessionIds: [] });

    const replaceOperation = randomUUID();
    const replaced = await commit(secondDraftId, true, targetId, replaceOperation);
    expect(replaced.result?.replacedSessionIds).toEqual([firstId]);
    expect(store.getSession(firstId).descriptor.deletedAt).toEqual(expect.any(Number));
    expect(store.getSession(distinct.result!.sessionId).descriptor.deletedAt).toBeUndefined();
    expect((await commit(secondDraftId, true, targetId, replaceOperation)).result?.sessionId).toBe(replaced.result!.sessionId);
  });

  it("reclaims an overwritten imported Pi task's aged native images while preserving live references", { timeout: 90_000 }, async () => {
    let elapsedStorageTime = 0;
    const retentionMs = 72 * 60 * 60 * 1_000;
    const pixels = [
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgZGAAAAAHAALpEtlMAAAAAElFTkSuQmCC", "base64"),
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYmAAAAAKAANQonMOAAAAAElFTkSuQmCC", "base64")
    ];
    let requestedImage = "";
    fixture = await RealPiSystemFixture.start({
      artifactClock: () => Date.now() + elapsedStorageTime,
      providerSupportsImages: true,
      providerResponder: ({ request }) => {
        const messages = request.body["messages"] as readonly { readonly role: string }[];
        return messages.at(-1)?.role === "tool"
          ? { kind: "text", text: "Pi read the test image." }
          : { kind: "tool", name: "read", arguments: { path: requestedImage } };
      }
    });
    const { artifacts, store } = fixture.application;
    const { clients, connectionId, authKey } = await fixture.pair("Pi replacement storage owner");
    const targetId = "workspace-real-pi";
    const target = store.getTarget(targetId);
    store.upsertTarget({ ...target.descriptor, trusted: true }, target.metadata);
    const isoTime = new Date().toISOString();
    const nativeSessionId = randomUUID();
    const transcript = Buffer.from([
      JSON.stringify({ type: "session", version: 3, id: nativeSessionId, timestamp: isoTime, cwd: fixture.workspaceDirectory }),
      JSON.stringify({ type: "message", id: "user-one", parentId: null, timestamp: isoTime, message: { role: "user", content: "Original portable task" } })
    ].join("\n") + "\n");
    const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
    const encoded = await buildPortableSessionExport({
      applicationVersion: "0.1.0", exportedAt: isoTime, title: "Media-free Pi task", workspaceKind: "project",
      backendCapability: "native-portable-session-v1",
      nativeSession: { bytes: transcript, sha256: hash(transcript), nativeSessionId },
      events: [{ emittedAt: Date.parse(isoTime), payload: { type: "message_complete", role: "user",
        blocks: [{ kind: "text", text: "Original portable task" }] } }],
      readBlob: blob => artifacts.readBlob(blob)
    });
    const bundle = await artifacts.ingestBytes(encoded.bytes, { fileName: "media-free.jshare", mimeType: "application/vnd.joko.session" });
    const toWireBlob = (blob: BlobRef) =>
      create(BlobRefSchema, {
        blobId: blob.id, sha256Hex: blob.sha256, byteSize: BigInt(blob.byteLength),
        mediaType: blob.mimeType, fileName: blob.fileName ?? ""
      });
    const importTask = async (overwrite: boolean) => {
      const { draft } = await clients.portableSession.inspectPortableSessionImport({ package: toWireBlob(bundle) });
      if (draft === undefined) throw new Error("The media-free Pi package has no draft.");
      const { result } = await clients.portableSession.commitPortableSessionImport({
        operationId: randomUUID(), draftId: draft.draftId, targetId, overwrite, permissionMode: PermissionMode.ASK,
        model: create(ModelSelectionSchema, { model: { providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID }, effortId: "off" })
      });
      if (result === undefined) throw new Error("The media-free Pi package has no import receipt.");
      expect(result).toMatchObject({ mediaCount: 0n, status: PortableSessionImportStatus.READY });
      return result;
    };
    const original = await importTask(false);
    const generation = BigInt(store.getSession(original.sessionId).descriptor.binding.generation);
    const mutate = (mutation: Parameters<typeof submit>[2]) => submit(clients.operation, connectionId, mutation);
    const oldImages = [];
    for (const [index, bytes] of pixels.entries()) {
      requestedImage = `pixel-${index}.png`;
      await writeFile(join(fixture.workspaceDirectory, requestedImage), bytes);
      const operation = await mutate(sendInputMutation(original.sessionId, generation, `Read ${requestedImage}.`));
      expect(operation.state).toBe(OperationState.SUCCEEDED);
      const runId = queueRunIdFrom(operation);
      const { run } = await waitForRealSystem(() => clients.run.getRun({ runId }),
        ({ run }) => run?.state === RunState.SUCCEEDED || run?.state === RunState.FAILED,
        "original Pi image tool Run", 15_000);
      expect(run?.state).toBe(RunState.SUCCEEDED);
      const events = store.listEvents({ sessionId: original.sessionId })
        .filter(event => event.runId === runId).map(event => event.payload);
      const output = events.find(payload => payload.type === "tool_result" && payload.name === "read");
      expect(output).toMatchObject({ isError: false, parts: expect.arrayContaining([expect.objectContaining({ kind: "image" })]) });
      const produced = events.find(payload => payload.type === "artifact" && payload.purpose === "backend_artifact");
      if (produced?.type !== "artifact") throw new Error("The original Pi Run has no adopted image.");
      expect(produced.artifact.sha256).toBe(hash(bytes));
      const image = store.getArtifact(produced.artifact.id);
      expect(image).toMatchObject({ sessionId: original.sessionId, metadata: {} });
      oldImages.push(image);
    }
    const [unreferenced, retained] = oldImages;
    if (unreferenced === undefined || retained === undefined) throw new Error("The Pi runs did not produce both images.");
    const replacement = await importTask(true);
    expect(replacement.replacedSessionIds).toEqual([original.sessionId]);
    expect(store.getSession(original.sessionId).descriptor.deletedAt).toEqual(expect.any(Number));
    expect((await clients.portableSession.getPortableReplacementCleanup({ importedSessionId: replacement.sessionId })).cleanup)
      .toMatchObject({ nativeState: PortableReplacementNativeState.COMPLETED, worktreeState: PortableReplacementWorktreeState.COMPLETED });
    expect((await clients.artifact.listArtifacts({ sessionId: replacement.sessionId })).artifacts).toHaveLength(0);
    const scan = async (protectedSha256: string[] = []) => {
      const response = await clients.artifact.scanArtifactStorage({ protectedSha256 });
      if (response.scan === undefined) throw new Error("Artifact storage returned no scan receipt.");
      return response.scan;
    };
    const freshStats = (await clients.artifact.getArtifactStorageStats({})).stats;
    if (freshStats === undefined) throw new Error("Artifact storage returned no statistics.");
    expect((await scan()).orphanBlobCount).toBe(0n);

    elapsedStorageTime = retentionMs + 60_000;
    const { ticket } = await clients.artifact.getBlobDownloadTicket({ blobId: unreferenced.blob.id });
    if (ticket === undefined) throw new Error("The original image has no download ticket.");
    const downloaded = await fetch(`${fixture.baseUrl}${ticket.relativeEndpoint}`, { headers: { authorization: `Bearer ${authKey}` } });
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(pixels[0]!)).toBe(true);
    expect(await scan([retained.blob.sha256])).toMatchObject({ protectedReferenceCount: 1n, orphanBlobCount: 0n });

    elapsedStorageTime += retentionMs + 60_000;
    const prior = await scan();
    expect(prior.orphanBlobCount).toBe(2n);
    const nextId = replacement.sessionId;
    const hold = (await clients.queue.getQueueControl({ sessionId: nextId })).queueControl;
    if (hold === undefined) throw new Error("The replacement task has no Queue control.");
    expect((await mutate(pauseQueueMutation(hold))).state).toBe(OperationState.SUCCEEDED);
    const send = sendInputMutation(nextId, BigInt(store.getSession(nextId).descriptor.binding.generation), "Keep the original image bytes.");
    if (send.payload.case !== "sendInput" || send.payload.value.input === undefined) throw new Error("No image input to queue.");
    send.payload.value.input.parts.push(create(InputPartSchema, {
      content: { case: "image", value: { blob: toWireBlob(retained.blob) } }
    }));
    const queued = await mutate(send);
    expect(queued.state).toBe(OperationState.SUCCEEDED);
    const refused = (await clients.artifact.beginArtifactStorageCleanup({ scanToken: prior.token })).progress;
    expect(refused?.status).toBe(ArtifactStorageCleanupStatus.STORAGE_CHANGED);
    const current = await scan();
    expect(current).toMatchObject({ orphanBlobCount: 1n, orphanBlobBytes: BigInt(unreferenced.blob.byteLength) });
    await clients.artifact.beginArtifactStorageCleanup({ scanToken: current.token });
    const cleaned = await waitForRealSystem(
      async () => (await clients.artifact.getArtifactStorageCleanup({ maintenanceId: current.token })).progress,
      (progress) => progress !== undefined && progress.status !== ArtifactStorageCleanupStatus.RUNNING,
      "original Pi storage cleanup receipt", 15_000
    );
    expect(cleaned).toMatchObject({
      status: ArtifactStorageCleanupStatus.COMPLETED,
      result: { expiredReferencesDeleted: 1n, blobsRemoved: 1n, freedBytes: BigInt(unreferenced.blob.byteLength) }
    });
    await expect(stat(unreferenced.storageKey)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(fixture.workspaceDirectory, "pixel-0.png"))).resolves.toMatchObject({ size: pixels[0]!.byteLength });
    await expect(clients.artifact.getArtifact({ artifactId: unreferenced.blob.id })).rejects.toMatchObject({ code: Code.NotFound });
    expect((await clients.run.getRun({ runId: queueRunIdFrom(queued) })).run?.state).toBe(RunState.QUEUED);
    expect(Buffer.from((await artifacts.readBlob(retained.blob)).data).equals(pixels[1]!)).toBe(true);
    expect((await clients.artifact.getArtifactStorageStats({})).stats).toMatchObject({
      referenceCount: freshStats.referenceCount - 1n,
      totalBytes: freshStats.totalBytes - BigInt(unreferenced.blob.byteLength)
    });
  });

  it("executes an installed Skill through the live Pi command catalog and records exact durable usage", { timeout: 90_000 }, async () => {
    fixture = await RealPiSystemFixture.start();
    const paired = await fixture.pair("Real Pi native Skill command E2E");
    const skillName = `runtime-proof-${randomUUID().slice(0, 8)}`;
    const instructionMarker = `NATIVE_SKILL_INSTRUCTION_${randomUUID()}`;
    const privateArgument = `private-argument-${randomUUID()}`;
    const installed = await installLocalSkill(
      fixture,
      paired,
      skillName,
      `# Native runtime proof\n\nInclude the marker ${instructionMarker} while following this Skill.`
    );
    await fixture.application.refreshPiGeneration?.();

    const created = await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({
        backendId: "pi",
        targetId: "workspace-real-pi",
        displayName: "Real Pi native Skill command",
        providerId: REAL_PI_PROVIDER_ID,
        modelId: REAL_PI_MODEL_ID,
        effortId: "off"
      })
    );
    expect(created.state).toBe(OperationState.SUCCEEDED);
    const sessionId = sessionIdFrom(created);
    const runtimeGeneration = BigInt(
      fixture.application.store.getSession(sessionId).descriptor.binding.generation
    );
    const commands = await paired.clients.session.listRuntimeCommands({ sessionId });
    const command = commands.commands.find((candidate) => candidate.resourceId === installed.skill.skillId);
    expect(command).toMatchObject({
      source: RuntimeCommandSource.SKILL,
      resourceId: installed.skill.skillId,
      loaded: true,
      sessionId
    });
    if (command === undefined) throw new Error("The live Pi catalog did not expose the installed Skill command.");
    expect(command.name).not.toBe("");

    const queued = await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, runtimeGeneration, `/${command.name} ${privateArgument}`)
    );
    expect(queued.state).toBe(OperationState.SUCCEEDED);
    const runId = queueRunIdFrom(queued);
    await waitForRealSystem(
      () => paired.clients.run.getRun({ runId }),
      (response) => response.run?.state === RunState.SUCCEEDED,
      "real Pi native Skill command Run",
      30_000
    );

    expect(fixture.providerRequests).toHaveLength(1);
    const providerBody = JSON.stringify(fixture.providerRequests[0]?.body);
    expect(providerBody).toContain(instructionMarker);
    expect(providerBody).toContain(privateArgument);

    const sessionScope = create(SnapshotScopeSchema, {
      kind: {
        case: "session",
        value: create(SessionSnapshotScopeSchema, { sessionId, recentTimelineItems: 500 })
      }
    });
    const projected = await waitForRealSystem(
      () => paired.clients.event.getSnapshot({ scope: sessionScope }),
      (response) => response.snapshot?.timeline.some((event) =>
        event.payload?.kind.case === "resourceUsageRecorded"
          && event.payload.kind.value.resourceId === installed.skill.skillId
          && event.payload.kind.value.source === ResourceUsageSource.NATIVE_SKILL_COMMAND
          && event.payload.kind.value.action === ResourceUsageAction.COMMAND_SUCCEEDED
      ) === true,
      "durable native Skill usage event",
      30_000
    );
    const resourceUsage = projected.snapshot?.timeline.flatMap((event) =>
      event.payload?.kind.case === "resourceUsageRecorded"
        ? [event.payload.kind.value]
        : []
    ).filter((event) => event.resourceId === installed.skill.skillId) ?? [];
    const usage = resourceUsage.filter((event) =>
      event.source === ResourceUsageSource.NATIVE_SKILL_COMMAND
    );
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      resourceId: installed.skill.skillId,
      resourceRevision: installed.skill.entityVersion?.revision,
      contentRevision: installed.skill.approvedRevision,
      runtimeGeneration,
      source: ResourceUsageSource.NATIVE_SKILL_COMMAND,
      activity: ResourceUsageActivity.STRONG_ACTIVE,
      action: ResourceUsageAction.COMMAND_SUCCEEDED
    });
    expect(usage[0]?.occurrenceId).not.toBe("");
    const serializedUsage = JSON.stringify(resourceUsage, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value
    );
    expect(serializedUsage).not.toContain(privateArgument);
    expect(serializedUsage).not.toContain("SKILL.md");
    expect(serializedUsage).not.toContain(installed.sourceDirectory);
    expect(serializedUsage).not.toContain(fixture.rootDirectory);
  });

  it("restarts the installed Pi runtime and resumes the same native Session context", { timeout: 90_000 }, async () => {
    fixture = await RealPiSystemFixture.start();
    const paired = await fixture.pair("Real Pi runtime restart E2E");
    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({
        backendId: "pi",
        targetId: "workspace-real-pi",
        displayName: "Real Pi runtime restart",
        providerId: REAL_PI_PROVIDER_ID,
        modelId: REAL_PI_MODEL_ID,
        effortId: "off"
      })
    ));
    const firstPrompt = "Retain this exact first turn across the managed runtime restart.";
    const firstRun = await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), firstPrompt)
    );
    await waitForRealSystem(
      () => paired.clients.run.getRun({ runId: queueRunIdFrom(firstRun) }),
      (response) => response.run?.state === RunState.SUCCEEDED,
      "first real Pi restart turn",
      30_000
    );

    expect(fixture.providerRequests).toHaveLength(1);
    const beforeRestart = await paired.clients.session.getSession({ sessionId });
    const beforeGeneration = beforeRestart.session?.version?.generation;
    if (beforeGeneration === undefined) throw new Error("Real Pi Session had no generation before runtime restart.");

    const restarted = await submit(
      paired.clients.operation,
      paired.connectionId,
      restartBackendMutation("pi")
    );
    if (restarted.state !== OperationState.SUCCEEDED) {
      throw new Error(`Real Pi runtime restart failed at generation ${beforeGeneration}: ${JSON.stringify(restarted.error)}`);
    }
    const resumed = await waitForRealSystem(
      () => paired.clients.session.getSession({ sessionId }),
      (response) => (response.session?.version?.generation ?? 0n) > beforeGeneration
        && response.session?.state === SessionState.IDLE,
      "real Pi Session generation after runtime restart",
      30_000
    );
    expect(resumed.session?.sessionId).toBe(sessionId);
    expect(fixture.providerRequests).toHaveLength(1);

    const secondPrompt = "Confirm that the retained first turn is still native context.";
    const secondRun = await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), secondPrompt)
    );
    await waitForRealSystem(
      () => paired.clients.run.getRun({ runId: queueRunIdFrom(secondRun) }),
      (response) => response.run?.state === RunState.SUCCEEDED,
      "second real Pi restart turn",
      30_000
    );

    expect(fixture.providerRequests).toHaveLength(2);
    const resumedProviderBody = JSON.stringify(fixture.providerRequests[1]?.body);
    expect(resumedProviderBody).toContain(firstPrompt);
    expect(resumedProviderBody).toContain(REAL_PI_RESPONSE_TEXT);
    expect(resumedProviderBody).toContain(secondPrompt);
  });

  it("returns typed manual compaction outcomes once across operation replay", { timeout: 90_000 }, async () => {
    fixture = await RealPiSystemFixture.start({
      piSettings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } }
    });
    const paired = await fixture.pair("Real Pi compaction E2E");
    const created = await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({
        backendId: "pi",
        targetId: "workspace-real-pi",
        displayName: "Real Pi compaction",
        providerId: REAL_PI_PROVIDER_ID,
        modelId: REAL_PI_MODEL_ID,
        effortId: "off"
      })
    );
    const sessionId = sessionIdFrom(created);
    const sessionScope = create(SnapshotScopeSchema, {
      kind: {
        case: "session",
        value: create(SessionSnapshotScopeSchema, { sessionId, recentTimelineItems: 500 })
      }
    });

    const noopOperationId = randomUUID();
    const noop = await submit(
      paired.clients.operation,
      paired.connectionId,
      compactMutation(sessionId),
      noopOperationId
    );
    expect(noop.state).toBe(OperationState.SUCCEEDED);
    expect(noop.result?.payload.case).toBe("compactSession");
    if (noop.result?.payload.case !== "compactSession") throw new Error("Orchestrator returned no typed compaction result.");
    expect(noop.result.payload.value.outcome).toBe(CompactSessionOutcome.NOOP);
    const noopTimeline = await paired.clients.event.getSnapshot({ scope: sessionScope });
    const noopEvents = compactionEvents(noopTimeline.snapshot?.timeline ?? []);
    expect(noopEvents.map((event) => event.state)).toEqual([CompactionState.STARTED, CompactionState.NO_OP]);
    expect(new Set(noopEvents.map((event) => event.compactionId))).toHaveLength(1);

    const replayedNoop = await submit(
      paired.clients.operation,
      paired.connectionId,
      compactMutation(sessionId),
      noopOperationId
    );
    expect(replayedNoop.result?.payload.case).toBe("compactSession");
    if (replayedNoop.result?.payload.case === "compactSession") {
      expect(replayedNoop.result.payload.value.outcome).toBe(CompactSessionOutcome.NOOP);
    }
    expect(compactionEvents((await paired.clients.event.getSnapshot({ scope: sessionScope })).snapshot?.timeline ?? []))
      .toHaveLength(noopEvents.length);

    for (const prompt of ["Remember the first compaction decision.", "Remember the second compaction decision."]) {
      const queued = await submit(
        paired.clients.operation,
        paired.connectionId,
        sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), prompt)
      );
      const runId = queueRunIdFrom(queued);
      await waitForRealSystem(
        () => paired.clients.run.getRun({ runId }),
        (response) => response.run?.state === RunState.SUCCEEDED,
        "real Pi compaction preparation turn",
        30_000
      );
    }

    const compactOperationId = randomUUID();
    const beforeCompact = await paired.clients.event.getSnapshot({ scope: sessionScope });
    if (beforeCompact.snapshot === undefined) throw new Error("Orchestrator returned no compaction baseline Snapshot.");
    const compactStreamAbort = new AbortController();
    const compactIterator = paired.clients.event.streamEvents(
      { scope: sessionScope, afterCursor: beforeCompact.snapshot.resumeCursor },
      { signal: compactStreamAbort.signal }
    )[Symbol.asyncIterator]();
    const firstCompactEvent = compactIterator.next();
    const compacted = await submit(
      paired.clients.operation,
      paired.connectionId,
      compactMutation(sessionId),
      compactOperationId
    );
    expect(compacted.state).toBe(OperationState.SUCCEEDED);
    expect(compacted.result?.payload.case).toBe("compactSession");
    if (compacted.result?.payload.case !== "compactSession") throw new Error("Orchestrator returned no typed compaction result.");
    expect(compacted.result.payload.value.outcome).toBe(CompactSessionOutcome.COMPACTED);

    const liveCompactionEvents: { readonly compactionId: string; readonly state: CompactionState }[] = [];
    const compactStreamTimer = setTimeout(() => compactStreamAbort.abort(), 30_000);
    try {
      let next = await firstCompactEvent;
      while (!next.done) {
        const event = next.value.event;
        if (event?.payload?.kind.case === "compactionChanged") {
          liveCompactionEvents.push(event.payload.kind.value);
          if ([CompactionState.COMPLETED, CompactionState.NO_OP, CompactionState.ABORTED, CompactionState.FAILED]
            .includes(event.payload.kind.value.state)) break;
        }
        next = await compactIterator.next();
      }
    } finally {
      clearTimeout(compactStreamTimer);
      compactStreamAbort.abort();
      await compactIterator.return?.();
    }
    expect(liveCompactionEvents.map((event) => event.state)).toEqual([
      CompactionState.STARTED,
      CompactionState.COMPLETED
    ]);
    expect(new Set(liveCompactionEvents.map((event) => event.compactionId))).toHaveLength(1);

    const afterCompact = compactionEvents((await paired.clients.event.getSnapshot({ scope: sessionScope })).snapshot?.timeline ?? []);
    const terminalAfterCompact = afterCompact.filter((event) => [CompactionState.NO_OP, CompactionState.COMPLETED, CompactionState.ABORTED, CompactionState.FAILED].includes(event.state));
    expect(terminalAfterCompact).toEqual([
      expect.objectContaining({ state: CompactionState.COMPLETED })
    ]);
    const nativeEntries = await paired.clients.pi.listPiEntries({ sessionId });
    expect(nativeEntries.entries.some((entry) => entry.payload.case === "compaction")).toBe(true);

    const replayedCompact = await submit(
      paired.clients.operation,
      paired.connectionId,
      compactMutation(sessionId),
      compactOperationId
    );
    expect(replayedCompact.result?.payload.case).toBe("compactSession");
    if (replayedCompact.result?.payload.case === "compactSession") {
      expect(replayedCompact.result.payload.value.outcome).toBe(CompactSessionOutcome.COMPACTED);
    }
    const eventsAfterReplay = compactionEvents((await paired.clients.event.getSnapshot({ scope: sessionScope })).snapshot?.timeline ?? []);
    expect(eventsAfterReplay).toEqual(afterCompact);
    expect(eventsAfterReplay.filter((event) =>
      [CompactionState.COMPLETED, CompactionState.NO_OP, CompactionState.ABORTED, CompactionState.FAILED].includes(event.state)
    )).toHaveLength(1);
  });

  it("projects installed-Pi threshold compaction through the production chain", { timeout: 90_000 }, async () => {
    fixture = await RealPiSystemFixture.start({
      piSettings: { compaction: { enabled: true, thresholdPercent: 50, keepRecentTokens: 1 } },
      providerUsage: { promptTokens: 10_000, completionTokens: 3 }
    });
    const paired = await fixture.pair("Real Pi threshold compaction E2E");
    const created = await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({
        backendId: "pi",
        targetId: "workspace-real-pi",
        displayName: "Real Pi threshold compaction",
        providerId: REAL_PI_PROVIDER_ID,
        modelId: REAL_PI_MODEL_ID,
        effortId: "off"
      })
    );
    const sessionId = sessionIdFrom(created);
    const sessionScope = create(SnapshotScopeSchema, {
      kind: {
        case: "session",
        value: create(SessionSnapshotScopeSchema, { sessionId, recentTimelineItems: 500 })
      }
    });

    for (const prompt of [
      "Keep this first turn available for automatic compaction.",
      "Trigger the installed Pi threshold compaction path."
    ]) {
      const queued = await submit(
        paired.clients.operation,
        paired.connectionId,
        sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), prompt)
      );
      const runId = queueRunIdFrom(queued);
      await waitForRealSystem(
        () => paired.clients.run.getRun({ runId }),
        (response) => response.run?.state === RunState.SUCCEEDED,
        "real Pi threshold compaction turn",
        30_000
      );
    }
    const snapshot = await waitForRealSystem(
      () => paired.clients.event.getSnapshot({ scope: sessionScope }),
      (response) => compactionEvents(response.snapshot?.timeline ?? [])
        .some((event) => event.state === CompactionState.COMPLETED && event.reason === "threshold"),
      "real Pi threshold compaction projection",
      30_000
    ).catch(async (error: unknown) => {
      const [snapshot, state, entries] = await Promise.all([
        paired.clients.event.getSnapshot({ scope: sessionScope }),
        paired.clients.pi.getPiSessionState({ sessionId }),
        paired.clients.pi.listPiEntries({ sessionId })
      ]);
      throw new Error(`Installed Pi threshold compaction was not projected: ${JSON.stringify({
        events: compactionEvents(snapshot.snapshot?.timeline ?? []).map((event) => ({
          state: event.state, reason: event.reason, automatic: event.automatic,
        })),
        state: {
          streaming: state.state?.streaming, compacting: state.state?.compacting,
          autoCompaction: state.state?.autoCompaction, messageCount: state.state?.messageCount
        },
        nativeCompactions: entries.entries.filter((entry) => entry.payload.case === "compaction").length,
        providerRequests: fixture!.providerRequests.length,
        summarizationRequests: fixture!.providerRequests.filter((request) =>
          JSON.stringify(request.body).includes("You are a context summarization assistant")).length
      }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)}`, { cause: error });
    });
    const events = compactionEvents(snapshot.snapshot?.timeline ?? [])
      .filter((event) => event.reason === "threshold");
    const eventsByCompaction = new Map<string, typeof events>();
    for (const event of events) {
      eventsByCompaction.set(event.compactionId, [...(eventsByCompaction.get(event.compactionId) ?? []), event]);
    }
    expect(eventsByCompaction.size).toBeGreaterThanOrEqual(1);
    for (const compaction of eventsByCompaction.values()) {
      expect(compaction.map((event) => event.state)).toEqual([
        CompactionState.STARTED,
        CompactionState.COMPLETED
      ]);
    }
    expect(events.every((event) => event.automatic)).toBe(true);
    expect(compactionEvents(snapshot.snapshot?.timeline ?? []).filter((event) =>
      event.state === CompactionState.COMPLETED && event.reason === "native_history")).toHaveLength(0);
    expect(fixture.providerRequests.length).toBeGreaterThanOrEqual(2);
    const nativeEntries = await paired.clients.pi.listPiEntries({ sessionId });
    expect(nativeEntries.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ case: "compaction" }) })
    ]));
    const beforeGeneration = (await paired.clients.session.getSession({ sessionId })).session?.version?.generation;
    if (beforeGeneration === undefined) throw new Error("The threshold compaction Session has no runtime generation.");
    expect((await submit(paired.clients.operation, paired.connectionId, restartBackendMutation("pi"))).state)
      .toBe(OperationState.SUCCEEDED);
    await waitForRealSystem(() => paired.clients.session.getSession({ sessionId }),
      response => (response.session?.version?.generation ?? 0n) > beforeGeneration && response.session?.state === SessionState.IDLE,
      "threshold compaction runtime recovery", 30_000);
    const recovered = compactionEvents((await paired.clients.event.getSnapshot({ scope: sessionScope })).snapshot?.timeline ?? []);
    expect(recovered).toEqual(compactionEvents(snapshot.snapshot?.timeline ?? []));
  });

  it("stops the original installed-Pi Run while its threshold summary is still held", { timeout: 90_000 }, async () => {
    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
    releaseCompactionGate = releaseSummary;
    const isSummary = (body: Readonly<Record<string, unknown>>) =>
      JSON.stringify(body).includes("You are a context summarization assistant");
    fixture = await RealPiSystemFixture.start({
      piSettings: { compaction: { enabled: true, thresholdPercent: 50, keepRecentTokens: 1 } },
      providerUsage: { promptTokens: 10_000, completionTokens: 3 },
      providerResponder: async ({ request, requestNumber }) => {
        if (isSummary(request.body)) await summaryGate;
        return { kind: "text", text: `Installed Pi Stop reply ${requestNumber}` };
      }
    });
    const { clients, connectionId } = await fixture.pair("Real Pi threshold Stop owner");
    const mutate = (mutation: Parameters<typeof submit>[2]) => submit(clients.operation, connectionId, mutation);
    const expectInactiveRunStop = async (runId: string) => {
      const operation = await mutate(abortRunMutation(runId));
      expect(operation).toMatchObject({
        state: OperationState.FAILED,
        error: {
          code: "RUN_CONTROL_TARGET_CHANGED",
          queueImpact: StateImpact.UNCHANGED,
          nativeSessionImpact: StateImpact.UNCHANGED
        }
      });
      expect((await clients.operation.getOperation({ operationId: operation.operationId })).operation).toEqual(operation);
    };
    const sessionId = sessionIdFrom(await mutate(createSessionMutation({
      backendId: "pi", targetId: "workspace-real-pi", displayName: "Stop a held summary",
      providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, effortId: "off"
    })));
    const generation = BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation);
    const scope = create(SnapshotScopeSchema, {
      kind: { case: "session", value: create(SessionSnapshotScopeSchema, { sessionId, recentTimelineItems: 500 }) }
    });
    const readCompactions = async () => compactionEvents((await clients.event.getSnapshot({ scope })).snapshot?.timeline ?? []);
    const firstRunId = queueRunIdFrom(await mutate(sendInputMutation(sessionId, generation, "Cross the Pi threshold.")));
    await waitForRealSystem(async () => fixture!.providerRequests.some((request) => isSummary(request.body)),
      (requested) => requested, "held installed Pi summary request", 30_000);
    const started = await readCompactions();
    expect(started).toEqual([expect.objectContaining({ state: CompactionState.STARTED, reason: "threshold", automatic: true })]);

    const control = (await clients.queue.getQueueControl({ sessionId })).queueControl;
    if (control === undefined) throw new Error("The Pi task lost its queue control.");
    expect((await mutate(pauseQueueMutation(control))).state).toBe(OperationState.SUCCEEDED);
    const nextRunId = queueRunIdFrom(await mutate(sendInputMutation(sessionId, generation, "Run after the stopped summary.")));
    await expectInactiveRunStop(nextRunId);
    expect((await clients.pi.getPiSessionState({ sessionId })).state?.compacting).toBe(true);

    const revision = (await clients.run.getRun({ runId: firstRunId })).run?.version?.revision;
    if (revision === undefined) throw new Error("The active Pi Run lost its revision.");
    expect((await mutate(create(OperationMutationSchema, {
      payload: abortRunMutation(firstRunId).payload,
      preconditions: [{ entity: { kind: EntityKind.RUN, id: firstRunId }, expectedRevision: revision }]
    }))).state).toBe(OperationState.SUCCEEDED);
    await waitForRealSystem(() => clients.run.getRun({ runId: firstRunId }),
      (result) => result.run?.state === RunState.ABORTED, "aborted Run before releasing the summary", 15_000);
    expect(await readCompactions()).toEqual([
      started[0],
      expect.objectContaining({
        compactionId: started[0]!.compactionId, state: CompactionState.ABORTED,
        reason: "threshold", automatic: true, willRetry: false, boundaryId: ""
      })
    ]);
    expect((await clients.pi.listPiEntries({ sessionId })).entries.some((entry) => entry.payload.case === "compaction"))
      .toBe(false);
    expect((await clients.run.getRun({ runId: nextRunId })).run?.state).toBe(RunState.QUEUED);
    await expectInactiveRunStop(firstRunId);

    releaseSummary();
    releaseCompactionGate = undefined;
    const paused = (await clients.queue.getQueueControl({ sessionId })).queueControl;
    if (paused === undefined) throw new Error("The paused Pi task lost its queue control.");
    expect((await mutate(resumeQueueMutation(paused))).state).toBe(OperationState.SUCCEEDED);
    await waitForRealSystem(() => clients.run.getRun({ runId: nextRunId }),
      (result) => result.run?.state === RunState.SUCCEEDED, "subsequent Run on the same Pi generation", 30_000);
    expect((await clients.session.getSession({ sessionId })).session?.nativeBinding?.runtimeGeneration).toBe(generation);
  });

  it("runs a catalogued installed-Pi extension during automatic compaction while ordinary input stays queued", { timeout: 90_000 }, async () => {
    let releaseSummary: (() => void) | undefined;
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
    releaseCompactionGate = releaseSummary;
    fixture = await RealPiSystemFixture.start({
      piSettings: { compaction: { enabled: true, thresholdPercent: 50, keepRecentTokens: 1 } },
      providerUsage: { promptTokens: 10_000, completionTokens: 3 },
      providerResponder: async ({ request, requestNumber }) => {
        if (JSON.stringify(request.body).includes("You are a context summarization assistant")) await summaryGate;
        return { kind: "text", text: `Real Pi compaction bypass reply ${requestNumber}` };
      }
    });
    const paired = await fixture.pair("Real Pi compaction extension E2E");
    const marker = join(fixture.rootDirectory, "compaction-extension-executed.txt");
    const extensionPath = join(fixture.rootDirectory, "compaction-extension.js");
    await writeFile(extensionPath, [
      "import { writeFile } from 'node:fs/promises';",
      "export default function register(pi) {",
      "  pi.registerCommand('during-compact', {",
      "    description: 'Runs during automatic compaction',",
      `    handler: async () => { await writeFile(${JSON.stringify(marker)}, 'executed'); }`,
      "  });",
      "}",
      ""
    ].join("\n"));
    const resourceMutation = (payload: NonNullable<Parameters<typeof create<typeof OperationMutationSchema>>[1]>["payload"]) =>
      create(OperationMutationSchema, { payload });
    const added = await submit(paired.clients.operation, paired.connectionId, resourceMutation({
      case: "addResource",
      value: create(AddResourceMutationSchema, {
        backendId: "pi", kind: ResourceKind.EXTENSION, scope: ResourceScope.MANAGED,
        acquisition: create(ResourceAcquisitionSourceSchema, {
          source: { case: "local", value: { serverPath: extensionPath } }
        }),
        name: "during-compact"
      })
    }));
    expect(added.state).toBe(OperationState.SUCCEEDED);
    const resource = (await paired.clients.pi.listPiResources({
      backendId: "pi", kind: ResourceKind.EXTENSION, page: { pageSize: 500 }
    })).resources.find((candidate) => candidate.name === "during-compact");
    if (resource === undefined) throw new Error("The installed Pi Extension Resource was not discovered.");
    for (const payload of [
      { case: "approveResource" as const, value: create(ApproveResourceMutationSchema, {
        resourceId: resource.resourceId, discoveredRevision: resource.discoveredRevision
      }) },
      { case: "installResource" as const, value: create(InstallResourceMutationSchema, {
        resourceId: resource.resourceId
      }) },
      { case: "setResourceEnabled" as const, value: create(SetResourceEnabledMutationSchema, {
        resourceId: resource.resourceId, enabled: true
      }) }
    ]) {
      const result = await submit(paired.clients.operation, paired.connectionId, resourceMutation(payload));
      expect(result.state, `${payload.case}: ${result.error?.message ?? "no error"}`).toBe(OperationState.SUCCEEDED);
    }
    await fixture.application.refreshPiGeneration?.();

    const sessionId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId,
      createSessionMutation({
        backendId: "pi", targetId: "workspace-real-pi", displayName: "Compaction extension bypass",
        providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, effortId: "off"
      })));
    const commands = await paired.clients.session.listRuntimeCommands({ sessionId });
    expect(commands.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "during-compact", source: RuntimeCommandSource.EXTENSION, loaded: true })
    ]));
    const send = async (text: string, mode = QueueDeliveryMode.PROMPT) => {
      const generation = BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation);
      const accepted = await submit(paired.clients.operation, paired.connectionId,
        sendInputMutation(sessionId, generation, text, mode));
      expect(accepted.state).toBe(OperationState.SUCCEEDED);
      return queueRunIdFrom(accepted);
    };
    const firstRunId = await send("Start context and cross the automatic compaction threshold.");
    await waitForRealSystem(() => Promise.resolve(fixture!.providerRequests.length),
      (count) => count >= 2, "automatic Pi summarization request", 30_000);
    expect(fixture.providerRequests.some((request) =>
      JSON.stringify(request.body).includes("You are a context summarization assistant"))).toBe(true);
    const ordinaryRunId = await send("Ordinary input must wait for compaction.", QueueDeliveryMode.FOLLOW_UP);
    const extensionRunId = await send("/during-compact now", QueueDeliveryMode.FOLLOW_UP);
    await waitForRealSystem(() => readFile(marker, "utf8").catch(() => ""),
      (content) => content === "executed", "installed Pi extension bypass effect", 15_000)
      .catch(async (error: unknown) => {
        const runs = await Promise.all([firstRunId, ordinaryRunId, extensionRunId]
          .map((runId) => paired.clients.run.getRun({ runId })));
        const state = await paired.clients.pi.getPiSessionState({ sessionId });
        throw new Error(`Installed Pi extension did not bypass: ${JSON.stringify({
          runs: runs.map((run) => ({ state: run.run?.state, error: run.run?.error?.code })),
          compacting: state.state?.compacting,
          queue: fixture!.application.store.listQueueItems({ sessionId, limit: 20 })
            .map((item) => ({ state: item.state, disposition: item.disposition, position: item.position,
              runId: item.runId })),
          requests: fixture!.providerRequests.length
        }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)}`, { cause: error });
      });
    await waitForRealSystem(() => paired.clients.run.getRun({ runId: extensionRunId }),
      (response) => response.run?.state === RunState.SUCCEEDED, "extension bypass Run", 30_000);
    expect((await paired.clients.run.getRun({ runId: firstRunId })).run?.state).not.toBe(RunState.SUCCEEDED);
    expect((await paired.clients.run.getRun({ runId: ordinaryRunId })).run?.state).not.toBe(RunState.SUCCEEDED);
    releaseSummary?.();
    releaseCompactionGate = undefined;
    for (const runId of [firstRunId, ordinaryRunId]) {
      await waitForRealSystem(() => paired.clients.run.getRun({ runId }),
        (response) => response.run?.state === RunState.SUCCEEDED, "post-compaction ordinary Run", 30_000);
    }
    expect(await readFile(marker, "utf8")).toBe("executed");
  });

  it("recovers an installed-Pi context overflow through compaction and one retry", { timeout: 90_000 }, async () => {
    fixture = await RealPiSystemFixture.start({
      piSettings: { compaction: { enabled: true, thresholdPercent: 95, keepRecentTokens: 1 } },
      overflowRequestNumbers: [2]
    });
    const paired = await fixture.pair("Real Pi overflow compaction E2E");
    const created = await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({
        backendId: "pi",
        targetId: "workspace-real-pi",
        displayName: "Real Pi overflow compaction",
        providerId: REAL_PI_PROVIDER_ID,
        modelId: REAL_PI_MODEL_ID,
        effortId: "off"
      })
    );
    const sessionId = sessionIdFrom(created);
    const sessionScope = create(SnapshotScopeSchema, {
      kind: {
        case: "session",
        value: create(SessionSnapshotScopeSchema, { sessionId, recentTimelineItems: 500 })
      }
    });

    const prepared = await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation),
        "Establish history before the context overflow.")
    );
    const preparedRunId = queueRunIdFrom(prepared);
    await waitForRealSystem(
      () => paired.clients.run.getRun({ runId: preparedRunId }),
      (response) => response.run?.state === RunState.SUCCEEDED,
      "real Pi pre-overflow turn",
      30_000
    );

    const beforeOverflow = await paired.clients.event.getSnapshot({ scope: sessionScope });
    if (beforeOverflow.snapshot === undefined) throw new Error("Orchestrator returned no overflow baseline Snapshot.");
    const overflowAbort = new AbortController();
    const overflowIterator = paired.clients.event.streamEvents(
      { scope: sessionScope, afterCursor: beforeOverflow.snapshot.resumeCursor },
      { signal: overflowAbort.signal }
    )[Symbol.asyncIterator]();
    const firstOverflowEvent = overflowIterator.next();
    const queued = await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation),
        "Recover this turn after one simulated context overflow.")
    );
    const runId = queueRunIdFrom(queued);
    await waitForRealSystem(
      () => paired.clients.run.getRun({ runId }),
      (response) => response.run?.state === RunState.SUCCEEDED,
      "real Pi overflow recovery turn",
      30_000
    );
    const liveOverflowEvents: ReturnType<typeof compactionEvents> = [];
    const overflowTimer = setTimeout(() => overflowAbort.abort(), 30_000);
    try {
      let next = await firstOverflowEvent;
      while (!next.done) {
        const event = next.value.event;
        if (event?.payload?.kind.case === "compactionChanged" && event.payload.kind.value.reason === "overflow") {
          liveOverflowEvents.push(event.payload.kind.value);
          if (event.payload.kind.value.state === CompactionState.COMPLETED) break;
        }
        next = await overflowIterator.next();
      }
    } finally {
      clearTimeout(overflowTimer);
      overflowAbort.abort();
      await overflowIterator.return?.();
    }
    expect(liveOverflowEvents.map((event) => event.state)).toEqual([
      CompactionState.STARTED,
      CompactionState.COMPLETED
    ]);
    expect(new Set(liveOverflowEvents.map((event) => event.compactionId))).toHaveLength(1);

    const snapshot = await paired.clients.event.getSnapshot({ scope: sessionScope });
    const events = compactionEvents(snapshot.snapshot?.timeline ?? []);
    // The observed lifecycle retains its actual reason after native history
    // sync. Its exact persisted receipt prevents a second unknown-trigger card.
    expect(events).toEqual(liveOverflowEvents);
    expect(fixture.providerRequests).toHaveLength(4);
    const nativeEntries = await paired.clients.pi.listPiEntries({ sessionId });
    expect(nativeEntries.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ case: "compaction" }) })
    ]));
  });
});

function compactionEvents(timeline: readonly {
  readonly payload?: {
    readonly kind: {
      readonly case: string | undefined;
      readonly value?: unknown;
    };
  };
}[]): {
  readonly compactionId: string;
  readonly state: CompactionState;
  readonly automatic: boolean;
  readonly reason: string;
  readonly willRetry?: boolean;
}[] {
  return timeline.flatMap((item) => item.payload?.kind.case === "compactionChanged"
    ? [item.payload.kind.value as {
      readonly compactionId: string;
      readonly state: CompactionState;
      readonly automatic: boolean;
      readonly reason: string;
      readonly willRetry?: boolean;
    }]
    : []);
}

async function waitForRealSystem<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}.`);
}
