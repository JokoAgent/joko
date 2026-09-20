import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import {
  BlobDisposition, CapabilitySupport, CompactSessionOutcome, CompactionState, ConnectionState, DeviceKind,
  DismissInteractionMutationSchema, EntityKind, EntityRefSchema,
  EventCursorSchema, ImageRefSchema, InputMentionRangeSchema, InputPartSchema, InteractionResolutionSchema, InteractionState, NativeNavigationTargetSchema,
  NavigateSessionBranchMutationSchema, OperationMutationSchema,
  LogoutConnectionMutationSchema, OperationPreconditionSchema, OperationState, PlanReviewDecisionKind,
  PermissionMode,
  PlanReviewResolutionSchema, QueueItemState, QuestionAnswerSchema, QuestionMultipleChoiceAnswerSchema,
  QuestionResolutionSchema, QuestionSingleChoiceAnswerSchema, ResolveInteractionMutationSchema, RevokeDeviceMutationSchema,
  MessageRole, QueueDeliveryMode, RunState, SessionMessageSearchSemanticMode, SessionMessageSearchSessionStatus, SessionState,
  AppendVoiceAudioRequestSchema, GetVoiceInputCapabilitiesRequestSchema, GetVoiceInputSessionRequestSchema,
  StartVoiceInputRequestSchema, StopVoiceInputRequestSchema, VoiceInputState, VoiceInputTerminalOutcome,
  capabilityNames, nativeSessionTreeRoots, type Interaction, type OperationMutation
} from "@joko/contracts";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import type { AdapterContext, PromptInput } from "@joko/core";
import { VoiceInputCoordinator, type VoiceInputProviderFactory } from "@joko/orchestrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  archiveMutation, cancelQueuedInputMutation, createSessionMutation, deleteMutation, deleteSessionMessageMutation,
  compactMutation, editQueuedInputMutation, pauseQueueMutation, pinMutation, queueItemFrom, queueRunIdFrom, renameMutation,
  modelMutation, permissionMutation, planModeMutation, reorderQueuedInputBeforeMutation, resumeQueueMutation, sendInputMutation, sessionIdFrom,
  setQueueInteractionLockMutation, setQueueItemEditLockMutation, submit
} from "./operations.js";

class MobileMessageFixtureAdapter extends InstrumentedFakeAdapter {
  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    await context.emit({
      type: "message_complete",
      role: "user",
      blocks: [{ kind: "text", text: input.text }]
    });
    await super.send(input, context);
  }
}

class MobileInteractionFixtureAdapter extends InstrumentedFakeAdapter {
  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    if (input.text === "[mobile-question]") {
      const decision = await context.requestInteraction({
        id: `mobile-question-${context.sessionId}-${randomUUID()}`,
        kind: "question",
        title: "Mobile release choices",
        prompt: "Complete every current field.",
        fields: [
          { id: "summary", kind: "text", label: "Summary", required: true, multiline: true },
          { id: "release", kind: "single", label: "Release", required: true,
            choices: [{ id: "stable", label: "Stable" }, { id: "preview", label: "Preview" }], allowOther: true },
          { id: "targets", kind: "multiple", label: "Targets", required: true,
            choices: [{ id: "web", label: "Web" }, { id: "mobile", label: "Mobile" }],
            defaultChoiceIds: [], minimumSelections: 2, maximumSelections: 2, allowOther: true },
          { id: "publish", kind: "boolean", label: "Publish", required: true, defaultValue: false }
        ]
      });
      this.interactionDecisions.push(decision.kind === "question"
        ? `question:${decision.answers.summary?.kind}:${decision.answers.release?.kind}:${decision.answers.targets?.kind}:${decision.answers.publish?.kind}`
        : "question:cancelled");
    } else if (input.text === "[mobile-plan]") {
      const decision = await context.requestInteraction({
        id: `mobile-plan-${context.sessionId}-${randomUUID()}`,
        kind: "plan_review",
        title: "Review mobile plan",
        markdown: "# Mobile plan\n\n1. Preserve authority.\n2. Verify the result.",
        choices: ["execute", "stay", "refine"]
      });
      this.interactionDecisions.push(decision.kind === "plan_review"
        ? `plan:${decision.decision}:${decision.feedback}`
        : "plan:cancelled");
    }
    await super.send(input, context);
  }
}

describe("native mobile device through the durable product chain", () => {
  let fixture: OrchestratorE2eFixture | undefined;
  afterEach(async () => { await fixture?.close(); fixture = undefined; });

  it("streams mobile PCM through the authenticated ephemeral Voice Input service without sending a task", async () => {
    let voice!: ReturnType<typeof createMobileVoiceHarness>;
    fixture = await OrchestratorE2eFixture.start({
      createAuxiliaryServices: async () => {
        voice = createMobileVoiceHarness();
        return { voiceInput: voice.coordinator };
      }
    });
    const begun = await fixture.anonymous.connection.beginPairing({
      deviceDisplayName: "Joko voice phone",
      deviceKind: DeviceKind.MOBILE,
      platform: "android",
      appVersion: "0.1.0"
    });
    const challengeId = begun.challenge!.challengeId;
    const paired = (await fixture.anonymous.connection.completePairing({
      challengeId,
      humanCode: fixture.pairingCode(challengeId),
      deviceDisplayName: "Joko voice phone",
      deviceKind: DeviceKind.MOBILE,
      platform: "android",
      appVersion: "0.1.0"
    })).result!;
    const clients = fixture.clients(paired.authKey);

    const capabilities = await clients.voiceInput.getVoiceInputCapabilities(
      create(GetVoiceInputCapabilitiesRequestSchema)
    );
    expect(capabilities.profile).toMatchObject({
      capability: { support: CapabilitySupport.SUPPORTED },
      limits: { supportedMimeTypes: ["audio/pcm"] },
      supportsLocale: true,
      supportsLiveDrafts: true
    });
    const started = await clients.voiceInput.startVoiceInput(create(StartVoiceInputRequestSchema, {
      requestId: "mobile-voice-request",
      mimeType: "audio/pcm",
      locale: "en-US"
    }));
    expect(started.session).toMatchObject({
      state: VoiceInputState.LISTENING,
      nextChunkSequence: 1n,
      acceptedAudioBytes: 0n
    });
    const voiceInputId = started.session!.voiceInputId;
    const pcm = Uint8Array.from({ length: 320 }, (_, index) => index % 2);
    const appended = await clients.voiceInput.appendVoiceAudio(create(AppendVoiceAudioRequestSchema, {
      voiceInputId,
      chunkSequence: 1n,
      audio: pcm,
      durationMs: 10,
      voiced: true
    }));
    expect(appended.session).toMatchObject({
      nextChunkSequence: 2n,
      acceptedAudioBytes: 320n,
      draft: { text: "mobile partial words" }
    });
    expect(voice.chunks).toHaveLength(1);
    expect(voice.chunks[0]).toMatchObject({ durationMs: 10, voiced: true });

    const stopped = await clients.voiceInput.stopVoiceInput(create(StopVoiceInputRequestSchema, {
      voiceInputId,
      expectedNextChunkSequence: 2n
    }));
    expect(stopped.session).toMatchObject({
      state: VoiceInputState.DONE,
      outcome: VoiceInputTerminalOutcome.SUCCESS,
      result: { text: "mobile final words" }
    });
    const terminal = await clients.voiceInput.getVoiceInputSession(create(GetVoiceInputSessionRequestSchema, {
      voiceInputId
    }));
    expect(terminal.session?.result?.text).toBe("mobile final words");

    const other = await fixture.pair("Other voice owner");
    await expect(other.clients.voiceInput.getVoiceInputSession(create(GetVoiceInputSessionRequestSchema, {
      voiceInputId
    }))).rejects.toBeDefined();
    const owner = await clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } });
    const serializedOwner = JSON.stringify(owner, (_key, value) => typeof value === "bigint" ? value.toString() : value);
    expect(serializedOwner).not.toContain("mobile partial words");
    expect(serializedOwner).not.toContain("mobile final words");
    expect(fixture.adapter().sendCalls).toHaveLength(0);
  });

  it("pairs a mobile device, creates a task, queues text once, resyncs history and revokes access", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const server = (await fixture.anonymous.connection.getServerInfo({})).server;
    expect(server?.serverId).toBeTruthy();
    const begun = await fixture.anonymous.connection.beginPairing({
      deviceDisplayName: "Joko phone", deviceKind: DeviceKind.MOBILE, platform: "android", appVersion: "0.1.0"
    });
    const challengeId = begun.challenge?.challengeId;
    expect(challengeId).toBeTruthy();
    const result = (await fixture.anonymous.connection.completePairing({
      challengeId, humanCode: fixture.pairingCode(challengeId!), deviceDisplayName: "Joko phone",
      deviceKind: DeviceKind.MOBILE, platform: "android", appVersion: "0.1.0"
    })).result;
    expect(result?.connection?.deviceId).toBe(result?.device?.deviceId);
    expect(result?.device?.kind).toBe(DeviceKind.MOBILE);
    expect(result?.authKey).toBeTruthy();
    const connectionId = result!.connection!.connectionId;
    const deviceId = result!.device!.deviceId;
    const clients = fixture.clients(result!.authKey);
    const owner = (await clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).snapshot;
    expect(owner?.server?.serverId).toBe(server?.serverId);
    expect(owner?.devices.find((device) => device.deviceId === deviceId)?.kind).toBe(DeviceKind.MOBILE);

    const target = owner?.targets.find((item) => item.targetId === fixture!.targetId());
    expect(target?.version?.revision).toBeDefined();
    const prepared = await clients.target.prepareTargetWorkspace({
      targetId: target!.targetId, expectedTargetRevision: target!.version!.revision
    });
    expect(prepared.workspace?.targetId).toBe(target?.targetId);
    const base = createSessionMutation({ backendId: target!.backendId, targetId: target!.targetId, displayName: "On the move" });
    const created = await submit(clients.operation, connectionId, create(OperationMutationSchema, {
      ...base,
      preconditions: [create(OperationPreconditionSchema, {
        entity: create(EntityRefSchema, { kind: EntityKind.TARGET, id: target!.targetId }),
        expectedRevision: target!.version!.revision
      })]
    }));
    const sessionId = sessionIdFrom(created);
    expect(created.result?.payload.case).toBe("session");
    if (created.result?.payload.case !== "session") throw new Error("Mobile creation did not return a Session result.");
    const createdSession = created.result.payload.value;
    expect(createdSession).toMatchObject({
      sessionId,
      backendId: target!.backendId,
      targetId: target!.targetId
    });
    const creationGeneration = createdSession.nativeBinding?.runtimeGeneration;
    expect(creationGeneration).toBeGreaterThan(0n);
    const session = (await clients.event.getSnapshot({
      scope: { kind: { case: "session", value: { sessionId, recentTimelineItems: 120 } } }
    })).snapshot;
    expect(session?.sessions[0]).toMatchObject({ sessionId, state: SessionState.IDLE });
    expect(session!.sessions[0]!.nativeBinding!.runtimeGeneration).toBe(creationGeneration);

    const resume = (await clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).snapshot!.resumeCursor!;

    const sent = await submit(clients.operation, connectionId, sendInputMutation(sessionId, creationGeneration!, "from the phone"));
    const queueId = sent.result?.payload.case === "queueItem" ? sent.result.payload.value.queueItemId : undefined;
    expect(queueId).toBeTruthy();
    await waitFor(async () => (await clients.session.listSessionTimeline({ sessionId, limit: 120 })).events,
      (events) => events.some((event) => event.payload?.kind.case === "messageCompleted"), "mobile task timeline");
    const recovered = (await clients.event.getSnapshot({
      scope: { kind: { case: "session", value: { sessionId, recentTimelineItems: 120 } } }
    })).snapshot;
    expect(recovered?.timeline.some((event) => event.payload?.kind.case === "messageCompleted")).toBe(true);
    expect(recovered?.queueItems.find((item) => item.queueItemId === queueId)?.state).not.toBe(QueueItemState.UNSPECIFIED);
    expect(fixture.adapter().sendCalls).toHaveLength(1);

    const completed = recovered!.timeline.find((event) => event.payload?.kind.case === "messageCompleted")!;
    const around = await clients.session.listSessionTimeline({ sessionId, aroundEventId: completed.eventId, limit: 9 });
    expect(around.events.some((event) => event.eventId === completed.eventId)).toBe(true);
    expect(around.events.every((event) => event.identity?.sessionId === sessionId)).toBe(true);
    const firstPage = await clients.session.listSessionTimeline({ sessionId, limit: 2 });
    expect(firstPage.events).toHaveLength(2);
    if (firstPage.nextBeforeCursor) {
      const older = await clients.session.listSessionTimeline({ sessionId, limit: 2, beforeCursor: firstPage.nextBeforeCursor });
      expect(older.events.every((event) => event.cursor!.sequence < firstPage.events[0]!.cursor!.sequence)).toBe(true);
    }
    const streamController = new AbortController();
    const replay = clients.event.streamEvents({ scope: { kind: { case: "owner", value: {} } }, afterCursor: resume },
      { signal: streamController.signal })[Symbol.asyncIterator]();
    try {
      const first = await replay.next();
      expect(first.done).toBe(false);
      expect(first.value?.event?.cursor?.sequence).toBeGreaterThan(resume.sequence);
      expect(first.value?.event?.cursor?.generation).toBe(resume.generation);
    } finally { streamController.abort(); }
    const badCursor = create(EventCursorSchema, { ...resume, generation: resume.generation + 1n });
    await expect(clients.event.streamEvents({ scope: { kind: { case: "owner", value: {} } }, afterCursor: badCursor })
      [Symbol.asyncIterator]().next()).rejects.toBeDefined();

    const search = async (status: SessionMessageSearchSessionStatus) => clients.session.searchSessionMessages({
      scope: { case: "owner", value: {} },
      query: "from the phone",
      filters: { sessionStatus: status },
      semanticMode: SessionMessageSearchSemanticMode.KEYWORD,
      page: { pageSize: 100, pageToken: "" }
    });
    expect((await search(SessionMessageSearchSessionStatus.ACTIVE)).matches.some((match) => match.sessionId === sessionId)).toBe(true);

    const mutateSession = async (mutation: OperationMutation) => {
      const before = (await clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).snapshot!;
      const current = before.sessions.find((item) => item.sessionId === sessionId);
      expect(current?.version?.revision?.value).toBeGreaterThan(0n);
      const operation = await submit(clients.operation, connectionId, create(OperationMutationSchema, {
        ...mutation,
        preconditions: [create(OperationPreconditionSchema, {
          entity: create(EntityRefSchema, { kind: EntityKind.SESSION, id: sessionId }),
          expectedRevision: current!.version!.revision
        })]
      }));
      expect(operation.state).toBe(OperationState.SUCCEEDED);
      return (await clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).snapshot!;
    };

    let changed = await mutateSession(renameMutation(sessionId, "Renamed on mobile"));
    expect(changed.sessions.find((item) => item.sessionId === sessionId)?.displayName).toBe("Renamed on mobile");
    changed = await mutateSession(pinMutation(sessionId, true));
    expect(changed.sessions.find((item) => item.sessionId === sessionId)?.pinned).toBe(true);
    changed = await mutateSession(archiveMutation(sessionId, true));
    expect(changed.sessions.find((item) => item.sessionId === sessionId)?.archived).toBe(true);
    expect((await search(SessionMessageSearchSessionStatus.ACTIVE)).matches.some((match) => match.sessionId === sessionId)).toBe(false);
    expect((await search(SessionMessageSearchSessionStatus.ARCHIVED)).matches.some((match) => match.sessionId === sessionId)).toBe(true);
    changed = await mutateSession(archiveMutation(sessionId, false));
    expect(changed.sessions.find((item) => item.sessionId === sessionId)?.archived).toBe(false);

    const deleteNative = vi.spyOn(fixture.adapter(), "deleteSession");
    changed = await mutateSession(deleteMutation(sessionId));
    expect(changed.sessions.some((item) => item.sessionId === sessionId)).toBe(false);
    expect(deleteNative).not.toHaveBeenCalled();

    const ownerClient = await fixture.pair("Device owner");
    const ownerBeforeRevoke = (await ownerClient.clients.event.getSnapshot({
      scope: { kind: { case: "owner", value: {} } }
    })).snapshot;
    const deviceRevision = ownerBeforeRevoke?.devices.find((device) => device.deviceId === deviceId)?.version?.revision;
    expect(deviceRevision?.value).toBeGreaterThan(0n);
    await submit(ownerClient.clients.operation, ownerClient.connectionId, create(OperationMutationSchema, {
      preconditions: [create(OperationPreconditionSchema, {
        entity: create(EntityRefSchema, { kind: EntityKind.DEVICE, id: deviceId }),
        expectedRevision: deviceRevision
      })],
      payload: { case: "revokeDevice", value: create(RevokeDeviceMutationSchema, { deviceId, reason: "Retired from mobile" }) }
    }));
    expect(fixture.application.store.getDevice(deviceId).state).toBe("revoked");
    await expect(clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).rejects.toBeDefined();
    expect((await ownerClient.clients.connection.getConnection({ connectionId })).connection?.state).toBe(ConnectionState.REVOKED);

    const logoutMobile = await fixture.anonymous.connection.beginPairing({
      deviceDisplayName: "Joko tablet", deviceKind: DeviceKind.MOBILE, platform: "ios", appVersion: "0.1.0"
    });
    const logoutChallengeId = logoutMobile.challenge!.challengeId;
    const logoutResult = (await fixture.anonymous.connection.completePairing({
      challengeId: logoutChallengeId,
      humanCode: fixture.pairingCode(logoutChallengeId),
      deviceDisplayName: "Joko tablet",
      deviceKind: DeviceKind.MOBILE,
      platform: "ios",
      appVersion: "0.1.0"
    })).result!;
    const logoutConnectionId = logoutResult.connection!.connectionId;
    const logoutClients = fixture.clients(logoutResult.authKey);
    const logoutOwner = (await logoutClients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).snapshot!;
    const connectionRevision = logoutOwner.connections.find((item) => item.connectionId === logoutConnectionId)?.version?.revision;
    expect(connectionRevision?.value).toBeGreaterThan(0n);
    const loggedOut = await submit(logoutClients.operation, logoutConnectionId, create(OperationMutationSchema, {
      preconditions: [create(OperationPreconditionSchema, {
        entity: create(EntityRefSchema, { kind: EntityKind.CONNECTION, id: logoutConnectionId }),
        expectedRevision: connectionRevision
      })],
      payload: { case: "logoutConnection", value: create(LogoutConnectionMutationSchema, { connectionId: logoutConnectionId }) }
    }));
    expect(loggedOut.state).toBe(OperationState.SUCCEEDED);
    await expect(logoutClients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).rejects.toBeDefined();
  });

  it("uploads mobile image/file Blobs and preserves canonical typed parts through Queue, Timeline, and Adapter dispatch", async () => {
    const attachmentProfile = {
      ...PI_LIKE_PROFILE,
      id: "mobile-attachments",
      displayName: "Mobile attachments",
      capabilities: [
        ...PI_LIKE_PROFILE.capabilities.filter((capability) => capability.key !== capabilityNames.inputImage
          && capability.key !== capabilityNames.inputFile),
        { key: capabilityNames.inputImage, supported: true as const, options: ["image/png"] },
        { key: capabilityNames.inputFile, supported: true as const, options: ["application/pdf"] }
      ]
    };
    fixture = await OrchestratorE2eFixture.start({
      profiles: [attachmentProfile],
      createAdapter: (profile) => new MobileMessageFixtureAdapter(profile)
    });
    const begunPairing = await fixture.anonymous.connection.beginPairing({
      deviceDisplayName: "Joko attachment phone",
      deviceKind: DeviceKind.MOBILE,
      platform: "android",
      appVersion: "0.1.0"
    });
    const challengeId = begunPairing.challenge?.challengeId;
    if (!challengeId) throw new Error("The mobile attachment fixture did not return a pairing challenge.");
    const paired = (await fixture.anonymous.connection.completePairing({
      challengeId,
      humanCode: fixture.pairingCode(challengeId),
      deviceDisplayName: "Joko attachment phone",
      deviceKind: DeviceKind.MOBILE,
      platform: "android",
      appVersion: "0.1.0"
    })).result;
    if (!paired?.authKey || !paired.connection?.connectionId) throw new Error("The mobile attachment fixture did not pair.");
    const clients = fixture.clients(paired.authKey);
    const connectionId = paired.connection.connectionId;
    const owner = (await clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).snapshot;
    const backend = owner?.backends.find((candidate) => candidate.backendId === attachmentProfile.id);
    expect(backend?.capabilities?.capabilities.find((capability) => capability.name === capabilityNames.inputImage))
      .toMatchObject({ support: CapabilitySupport.SUPPORTED, options: { kind: { case: "input", value: { mediaTypes: ["image/png"] } } } });
    expect(backend?.capabilities?.capabilities.find((capability) => capability.name === capabilityNames.inputFile))
      .toMatchObject({ support: CapabilitySupport.SUPPORTED, options: { kind: { case: "input", value: { mediaTypes: ["application/pdf"] } } } });

    const upload = async (fileName: string, mediaType: string, bytes: Buffer) => {
      const sha256Hex = createHash("sha256").update(bytes).digest("hex");
      const pending = await clients.artifact.beginBlobUpload({
        fileName,
        mediaType,
        byteSize: BigInt(bytes.byteLength),
        sha256Hex,
        disposition: BlobDisposition.ATTACHMENT
      });
      expect(pending.upload).toMatchObject({
        expectedSha256Hex: sha256Hex,
        expectedByteSize: BigInt(bytes.byteLength),
        ticket: {
          blobId: "",
          maximumBytes: BigInt(bytes.byteLength),
          requiredMediaType: mediaType
        }
      });
      const response = await fetch(`${fixture!.baseUrl}${pending.upload!.ticket!.relativeEndpoint}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${paired.authKey}`, "content-type": "application/octet-stream" },
        body: Uint8Array.from(bytes).buffer
      });
      expect(response.status).toBe(201);
      const completed = (await clients.artifact.completeBlobUpload({ uploadId: pending.upload!.uploadId })).blob;
      expect(completed).toMatchObject({
        fileName,
        mediaType,
        byteSize: BigInt(bytes.byteLength),
        sha256Hex,
        disposition: BlobDisposition.ATTACHMENT
      });
      if (!completed?.blobId) throw new Error("The mobile attachment Blob was not committed.");
      return completed;
    };
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    const image = await upload("pixel.png", "image/png", imageBytes);
    const file = await upload("proof.pdf", "application/pdf", Buffer.from("%PDF-MOBILE", "utf8"));
    const sessionId = sessionIdFrom(await submit(clients.operation, connectionId, createSessionMutation({
      backendId: attachmentProfile.id,
      targetId: fixture.targetId(attachmentProfile.id),
      displayName: "Mobile attachment task"
    })));
    const generation = BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation);
    const mutation = sendInputMutation(sessionId, generation, "");
    if (mutation.payload.case !== "sendInput" || mutation.payload.value.input === undefined) {
      throw new Error("The mobile attachment mutation has no InputContent.");
    }
    mutation.payload.value.input.parts.splice(0);
    mutation.payload.value.input.parts.push(
      create(InputPartSchema, {
        content: { case: "image", value: create(ImageRefSchema, { blob: image, altText: image.fileName }) }
      }),
      create(InputPartSchema, { content: { case: "file", value: file } })
    );

    const sent = await submit(clients.operation, connectionId, mutation);
    const queued = queueItemFrom(sent);
    expect(queued.input?.parts).toMatchObject([
      { content: { case: "image", value: { blob: { blobId: image.blobId }, altText: "pixel.png" } } },
      { content: { case: "file", value: { blobId: file.blobId } } }
    ]);
    await waitFor(
      () => clients.run.getRun({ runId: queueRunIdFrom(sent) }),
      (value) => value.run?.state === RunState.SUCCEEDED,
      "mobile attachment dispatch"
    );
    const timeline = await waitFor(
      () => clients.session.listSessionTimeline({ sessionId, limit: 120 }),
      (value) => value.events.some((event) => event.payload?.kind.case === "messageStarted"
        && event.payload.kind.value.role === MessageRole.USER
        && event.payload.kind.value.userInputAccepted
        && event.payload.kind.value.userInput?.parts.some((part) => part.content.case === "image"
          && part.content.value.blob?.blobId === image.blobId)),
      "accepted mobile attachment input"
    );
    const accepted = timeline.events.find((event) => event.identity?.runId === queued.runId
      && event.payload?.kind.case === "messageStarted" && event.payload.kind.value.role === MessageRole.USER);
    if (accepted?.payload?.kind.case !== "messageStarted") throw new Error("The accepted attachment input was not projected.");
    expect(accepted.payload.kind.value.userInput).toMatchObject(queued.input!);
    const durableImage = timeline.events.flatMap((event) => event.payload?.kind.case === "messageStarted"
      && event.payload.kind.value.userInputAccepted
      ? event.payload.kind.value.userInput?.parts ?? [] : []).find((part) => part.content.case === "image"
        && part.content.value.blob?.blobId === image.blobId);
    if (durableImage?.content.case !== "image" || !durableImage.content.value.blob) {
      throw new Error("The durable mobile image message block was not projected.");
    }
    expect(durableImage.content.value).toMatchObject({
      widthPixels: 0,
      heightPixels: 0,
      altText: "pixel.png",
      blob: {
        blobId: image.blobId,
        mediaType: "image/png",
        byteSize: BigInt(imageBytes.byteLength),
        sha256Hex: createHash("sha256").update(imageBytes).digest("hex")
      }
    });
    const imageDownloadTicket = await clients.artifact.getBlobDownloadTicket({ blobId: image.blobId });
    expect(imageDownloadTicket.ticket).toMatchObject({
      blobId: image.blobId,
      requiredMediaType: "image/png",
      maximumBytes: BigInt(imageBytes.byteLength)
    });
    const imageDownload = await fetch(`${fixture.baseUrl}${imageDownloadTicket.ticket!.relativeEndpoint}`, {
      headers: { authorization: `Bearer ${paired.authKey}`, connection: "close" }
    });
    expect(imageDownload.status).toBe(200);
    expect(imageDownload.headers.get("content-type")).toBe("image/png");
    expect(imageDownload.headers.get("content-length")).toBe(String(imageBytes.byteLength));
    expect(Buffer.from(await imageDownload.arrayBuffer())).toEqual(imageBytes);
    const dispatched = fixture.adapter(attachmentProfile.id).sendCalls.at(-1);
    expect(dispatched).toMatchObject({
      text: "",
      images: [{ blob: { id: image.blobId, fileName: "pixel.png", mimeType: "image/png" }, alt: "pixel.png" }],
      files: [{ blob: { id: file.blobId, fileName: "proof.pdf", mimeType: "application/pdf" } }]
    });
  });

  it("admits a mobile typed Session reference and preserves its public input ranges through dispatch", async () => {
    const mentionProfile = {
      ...PI_LIKE_PROFILE,
      id: "mobile-session-reference",
      displayName: "Mobile Session reference",
      capabilities: [
        ...PI_LIKE_PROFILE.capabilities.filter((capability) => capability.key !== capabilityNames.inputMention),
        { key: capabilityNames.inputMention, supported: true as const, options: ["session"] }
      ]
    };
    fixture = await OrchestratorE2eFixture.start({
      profiles: [mentionProfile],
      createAdapter: (profile) => new MobileMessageFixtureAdapter(profile)
    });
    const begun = await fixture.anonymous.connection.beginPairing({
      deviceDisplayName: "Joko reference phone",
      deviceKind: DeviceKind.MOBILE,
      platform: "android",
      appVersion: "0.1.0"
    });
    const challengeId = begun.challenge?.challengeId;
    if (!challengeId) throw new Error("The mobile reference fixture did not return a pairing challenge.");
    const paired = (await fixture.anonymous.connection.completePairing({
      challengeId,
      humanCode: fixture.pairingCode(challengeId),
      deviceDisplayName: "Joko reference phone",
      deviceKind: DeviceKind.MOBILE,
      platform: "android",
      appVersion: "0.1.0"
    })).result;
    if (!paired?.authKey || !paired.connection?.connectionId) throw new Error("The mobile reference fixture did not pair.");
    const clients = fixture.clients(paired.authKey);
    const connectionId = paired.connection.connectionId;
    const adapter = fixture.adapter(mentionProfile.id);
    const owner = (await clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).snapshot;
    const mentionCapability = owner?.backends.find((backend) => backend.backendId === mentionProfile.id)
      ?.capabilities?.capabilities.find((capability) => capability.name === capabilityNames.inputMention);
    expect(mentionCapability).toMatchObject({
      support: CapabilitySupport.SUPPORTED,
      options: { kind: { case: "input", value: { mediaTypes: ["session"] } } }
    });
    const createTask = async (displayName: string) => sessionIdFrom(await submit(
      clients.operation,
      connectionId,
      createSessionMutation({
        backendId: mentionProfile.id,
        targetId: fixture!.targetId(mentionProfile.id),
        displayName
      })
    ));
    const sourceSessionId = await createTask("Earlier mobile task");
    const destinationSessionId = await createTask("Current mobile task");
    const generation = (sessionId: string) => BigInt(
      fixture!.application.store.getSession(sessionId).descriptor.binding.generation
    );
    const sourceOperation = await submit(
      clients.operation,
      connectionId,
      sendInputMutation(sourceSessionId, generation(sourceSessionId), "MOBILE SOURCE HISTORY")
    );
    await waitFor(
      () => clients.run.getRun({ runId: queueRunIdFrom(sourceOperation) }),
      (value) => value.run?.state === RunState.SUCCEEDED,
      "mobile reference source history"
    );

    const text = "Compare 👋 @Earlier mobile task";
    const mentionStart = "Compare 👋 ".length;
    const mutation = sendInputMutation(destinationSessionId, generation(destinationSessionId), text);
    if (mutation.payload.case !== "sendInput" || mutation.payload.value.input === undefined) {
      throw new Error("The mobile reference mutation has no InputContent.");
    }
    mutation.payload.value.input.parts.push(create(InputPartSchema, {
      content: { case: "sessionMention", value: {
        sessionId: sourceSessionId,
        displayText: "Earlier mobile task"
      } }
    }));
    mutation.payload.value.input.mentionRanges.push(create(InputMentionRangeSchema, {
      start: mentionStart,
      end: text.length,
      mentionIndex: 0
    }));
    const sent = await submit(clients.operation, connectionId, mutation);
    const queued = queueItemFrom(sent);
    expect(queued.input).toMatchObject({
      parts: [
        { content: { case: "text", value: text } },
        { content: { case: "sessionMention", value: {
          sessionId: sourceSessionId,
          displayText: "Earlier mobile task"
        } } }
      ],
      mentionRanges: [{ start: mentionStart, end: text.length, mentionIndex: 0 }]
    });
    await waitFor(
      () => clients.run.getRun({ runId: queueRunIdFrom(sent) }),
      (value) => value.run?.state === RunState.SUCCEEDED,
      "mobile Session reference dispatch"
    );
    const timeline = await waitFor(
      () => clients.session.listSessionTimeline({ sessionId: destinationSessionId, limit: 120 }),
      (value) => value.events.some((event) => event.payload?.kind.case === "messageStarted"
        && event.payload.kind.value.role === MessageRole.USER),
      "accepted mobile Session-reference input"
    );
    const accepted = timeline.events.find((event) => event.identity?.runId === queued.runId
      && event.payload?.kind.case === "messageStarted" && event.payload.kind.value.role === MessageRole.USER);
    expect(accepted?.payload?.kind.case).toBe("messageStarted");
    if (accepted?.payload?.kind.case !== "messageStarted") throw new Error("The accepted mobile input was not projected.");
    expect(accepted.payload.kind.value.userInputAccepted).toBe(true);
    expect(accepted.payload.kind.value.userInput).toMatchObject(queued.input!);
    const dispatched = adapter.sendCalls.at(-1);
    expect(dispatched?.text).toContain(text);
    expect(dispatched?.text).toContain("MOBILE SOURCE HISTORY");
    expect(dispatched?.mentions).toEqual([]);
    expect(dispatched?.mentionRanges).toEqual([]);
  });

  it("admits mobile Workspace file, directory, and line references through HTTP, SQLite, and the Session Host", async () => {
    const mentionProfile = {
      ...PI_LIKE_PROFILE,
      id: "mobile-workspace-reference",
      displayName: "Mobile Workspace reference",
      capabilities: [
        ...PI_LIKE_PROFILE.capabilities.filter((capability) => capability.key !== capabilityNames.inputMention),
        {
          key: capabilityNames.inputMention,
          supported: true as const,
          options: ["workspace_file", "workspace_directory", "workspace_line_range"]
        }
      ]
    };
    fixture = await OrchestratorE2eFixture.start({
      profiles: [mentionProfile],
      createAdapter: (profile) => new MobileMessageFixtureAdapter(profile)
    });
    await mkdir(join(fixture.workspaceDirectory, "src"), { recursive: true });
    await writeFile(join(fixture.workspaceDirectory, "src", "main.ts"), "export const mobile = true;\n");

    const begun = await fixture.anonymous.connection.beginPairing({
      deviceDisplayName: "Joko Workspace phone",
      deviceKind: DeviceKind.MOBILE,
      platform: "android",
      appVersion: "0.1.0"
    });
    const challengeId = begun.challenge?.challengeId;
    if (!challengeId) throw new Error("The mobile Workspace fixture did not return a pairing challenge.");
    const paired = (await fixture.anonymous.connection.completePairing({
      challengeId,
      humanCode: fixture.pairingCode(challengeId),
      deviceDisplayName: "Joko Workspace phone",
      deviceKind: DeviceKind.MOBILE,
      platform: "android",
      appVersion: "0.1.0"
    })).result;
    if (!paired?.authKey || !paired.connection?.connectionId) throw new Error("The mobile Workspace fixture did not pair.");
    const clients = fixture.clients(paired.authKey);
    const connectionId = paired.connection.connectionId;
    const owner = (await clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).snapshot;
    const target = owner?.targets.find((candidate) => candidate.targetId === fixture!.targetId(mentionProfile.id));
    const workspaceId = target?.workspaceId;
    if (!target || !workspaceId) throw new Error("The mobile Workspace fixture has no current target Workspace.");
    expect(owner?.backends.find((backend) => backend.backendId === mentionProfile.id)
      ?.capabilities?.capabilities.find((capability) => capability.name === capabilityNames.inputMention))
      .toMatchObject({
        support: CapabilitySupport.SUPPORTED,
        options: { kind: { case: "input", value: {
          mediaTypes: ["workspace_file", "workspace_directory", "workspace_line_range", "session"]
        } } }
      });

    const sessionId = sessionIdFrom(await submit(
      clients.operation,
      connectionId,
      createSessionMutation({
        backendId: mentionProfile.id,
        targetId: target.targetId,
        displayName: "Current mobile Workspace task"
      })
    ));
    const generation = BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation);
    const tokens = ["@README.md", "@main.ts:1–1", "@src/"];
    const text = `Inspect ${tokens.join(" ")}`;
    const mutation = sendInputMutation(sessionId, generation, text);
    if (mutation.payload.case !== "sendInput" || mutation.payload.value.input === undefined) {
      throw new Error("The mobile Workspace mutation has no InputContent.");
    }
    mutation.payload.value.input.parts.push(
      create(InputPartSchema, { content: { case: "workspaceMention", value: {
        workspaceId, relativePath: "README.md", displayText: "README.md", directory: false
      } } }),
      create(InputPartSchema, { content: { case: "workspaceMention", value: {
        workspaceId, relativePath: "src/main.ts", displayText: "main.ts", directory: false,
        lineRange: { startLine: 1, endLine: 1 }
      } } }),
      create(InputPartSchema, { content: { case: "workspaceMention", value: {
        workspaceId, relativePath: "src", displayText: "src", directory: true
      } } })
    );
    let cursor = "Inspect ".length;
    tokens.forEach((token, mentionIndex) => {
      mutation.payload.case === "sendInput" && mutation.payload.value.input?.mentionRanges.push(
        create(InputMentionRangeSchema, { start: cursor, end: cursor + token.length, mentionIndex })
      );
      cursor += token.length + 1;
    });

    const sent = await submit(clients.operation, connectionId, mutation);
    const queued = queueItemFrom(sent);
    expect(queued.input).toMatchObject(mutation.payload.value.input);
    await waitFor(
      () => clients.run.getRun({ runId: queueRunIdFrom(sent) }),
      (value) => value.run?.state === RunState.SUCCEEDED,
      "mobile Workspace reference dispatch"
    );
    const timeline = await waitFor(
      () => clients.session.listSessionTimeline({ sessionId, limit: 120 }),
      (value) => value.events.some((event) => event.identity?.runId === queued.runId
        && event.payload?.kind.case === "messageStarted" && event.payload.kind.value.role === MessageRole.USER),
      "accepted mobile Workspace-reference input"
    );
    const accepted = timeline.events.find((event) => event.identity?.runId === queued.runId
      && event.payload?.kind.case === "messageStarted" && event.payload.kind.value.role === MessageRole.USER);
    if (accepted?.payload?.kind.case !== "messageStarted") throw new Error("The mobile Workspace input was not projected.");
    expect(accepted.payload.kind.value.userInputAccepted).toBe(true);
    expect(accepted.payload.kind.value.userInput).toMatchObject(queued.input!);

    const dispatched = fixture.adapter(mentionProfile.id).sendCalls.at(-1);
    expect(dispatched?.text).toBe(text);
    expect(dispatched?.mentions).toEqual([
      { kind: "workspace_file", workspaceId, label: "README.md", reference: "README.md" },
      {
        kind: "workspace_file", workspaceId, label: "main.ts", reference: "src/main.ts",
        lineRange: { startLine: 1, endLine: 1 }
      },
      { kind: "workspace_directory", workspaceId, label: "src", reference: "src" }
    ]);
    expect(dispatched?.mentionRanges).toEqual([
      { start: "Inspect ".length, end: "Inspect ".length + tokens[0]!.length, mentionIndex: 0 },
      {
        start: "Inspect ".length + tokens[0]!.length + 1,
        end: "Inspect ".length + tokens[0]!.length + 1 + tokens[1]!.length,
        mentionIndex: 1
      },
      { start: text.length - tokens[2]!.length, end: text.length, mentionIndex: 2 }
    ]);
  });

  it("executes mobile message deletion and touch Queue controls through HTTP, SQLite, and the Session Host", async () => {
    fixture = await OrchestratorE2eFixture.start({
      profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 300 }],
      createAdapter: (profile) => new MobileMessageFixtureAdapter(profile)
    });
    const paired = await fixture.pair("Joko mobile controls");
    const adapter = fixture.adapter();
    const owner = (await paired.clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).snapshot;
    const publicCapabilities = owner?.backends.find((backend) => backend.backendId === adapter.id)
      ?.capabilities?.capabilities;
    for (const name of [capabilityNames.queueCancel, capabilityNames.queueEdit, capabilityNames.queueReorder]) {
      expect(publicCapabilities).toContainEqual(expect.objectContaining({ name, support: CapabilitySupport.SUPPORTED }));
    }
    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId: adapter.id, targetId: fixture.targetId(), displayName: "Mobile controls" })
    ));
    const generation = () => BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation);

    const primary = queueItemFrom(await submit(paired.clients.operation, paired.connectionId,
      sendInputMutation(sessionId, generation(), "Primary mobile turn")));
    await waitFor(async () => adapter.sendCalls.length, (count) => count === 1, "primary mobile input to reach the Backend");
    const activeControl = (await paired.clients.queue.getQueueControl({ sessionId })).queueControl;
    if (!activeControl) throw new Error("The mobile task has no QueueControl.");
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      pauseQueueMutation(activeControl, "Exercise touch Queue controls")
    )).state).toBe(OperationState.SUCCEEDED);

    const editable = queueItemFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, generation(), "Edit this queued input", QueueDeliveryMode.FOLLOW_UP)
    ));
    const afterwards = queueItemFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, generation(), "Keep this after the edit", QueueDeliveryMode.FOLLOW_UP)
    ));
    const removable = queueItemFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, generation(), "Remove this queued input", QueueDeliveryMode.FOLLOW_UP)
    ));
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      cancelQueuedInputMutation(removable)
    )).state).toBe(OperationState.SUCCEEDED);
    expect((await paired.clients.queue.listQueueItems({ sessionId })).queueItems
      .find((item) => item.queueItemId === removable.queueItemId)?.state).toBe(QueueItemState.CANCELLED);

    const pausedControl = (await paired.clients.queue.getQueueControl({ sessionId })).queueControl;
    if (!pausedControl) throw new Error("The paused mobile task lost its QueueControl.");
    const interactionLockToken = randomUUID();
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      setQueueInteractionLockMutation(pausedControl, interactionLockToken, true)
    )).state).toBe(OperationState.SUCCEEDED);
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      reorderQueuedInputBeforeMutation(afterwards, editable.queueItemId, interactionLockToken)
    )).state).toBe(OperationState.SUCCEEDED);
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      setQueueInteractionLockMutation(pausedControl, interactionLockToken, false)
    )).state).toBe(OperationState.SUCCEEDED);

    const reordered = await paired.clients.queue.listQueueItems({ sessionId });
    const currentEditable = reordered.queueItems.find((item) => item.queueItemId === editable.queueItemId);
    if (!currentEditable) throw new Error("The editable Queue item disappeared.");
    expect(reordered.queueItems.filter((item) => item.state === QueueItemState.ACCEPTED)
      .map((item) => item.queueItemId)).toEqual([afterwards.queueItemId, editable.queueItemId]);
    const editLockToken = randomUUID();
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      setQueueItemEditLockMutation(currentEditable, editLockToken, true)
    )).state).toBe(OperationState.SUCCEEDED);
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      editQueuedInputMutation(currentEditable, "Edited from mobile", QueueDeliveryMode.FOLLOW_UP, editLockToken)
    )).state).toBe(OperationState.SUCCEEDED);
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      setQueueItemEditLockMutation(currentEditable, editLockToken, false)
    )).state).toBe(OperationState.SUCCEEDED);

    const resumable = (await paired.clients.queue.getQueueControl({ sessionId })).queueControl;
    if (!resumable) throw new Error("The mobile task lost its resumable QueueControl.");
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      resumeQueueMutation(resumable)
    )).state).toBe(OperationState.SUCCEEDED);
    await waitFor(
      () => paired.clients.run.listRuns({ sessionId }),
      (value) => value.runs.length === 4
        && value.runs.filter((run) => run.state === RunState.SUCCEEDED).length === 3
        && value.runs.filter((run) => run.state === RunState.ABORTED).length === 1,
      "mobile Queue to drain"
    );
    expect(adapter.sendCalls.slice(0, 3).map((call) => call.text)).toEqual([
      "Primary mobile turn",
      "Keep this after the edit",
      "Edited from mobile"
    ]);
    // Run rows become terminal just before the serialized Queue drain releases
    // its in-memory fence. Yield once so the next destructive operation observes
    // the same idle boundary that a mobile refresh does.
    await new Promise((resolve) => setTimeout(resolve, 25));

    const history = await waitFor(
      () => paired.clients.session.listSessionTimeline({ sessionId, limit: 120 }),
      (value) => value.events.some((event) => event.payload?.kind.case === "messageCompleted"
        && event.payload.kind.value.role === MessageRole.ASSISTANT
        && event.identity?.runId === primary.runId),
      "a durable mobile assistant message"
    );
    const selected = [...history.events].reverse().find((event) => event.payload?.kind.case === "messageCompleted"
      && event.payload.kind.value.role === MessageRole.ASSISTANT
      && event.identity?.runId === primary.runId);
    if (!selected) throw new Error("The mobile task has no completed assistant message.");
    const snapshot = (await paired.clients.event.getSnapshot({
      scope: { kind: { case: "session", value: { sessionId, recentTimelineItems: 120 } } }
    })).snapshot;
    const currentSession = snapshot?.sessions.find((session) => session.sessionId === sessionId);
    expect(currentSession?.state).toBe(SessionState.IDLE);
    const currentGeneration = currentSession?.nativeBinding?.runtimeGeneration;
    if (!currentGeneration) throw new Error("The mobile task has no current runtime generation.");
    expect(currentSession?.version?.generation).toBe(currentGeneration);
    const deleted = await submit(
      paired.clients.operation,
      paired.connectionId,
      deleteSessionMessageMutation(sessionId, selected.eventId, currentGeneration)
    );
    expect(deleted.state).toBe(OperationState.SUCCEEDED);

    const afterDelete = await paired.clients.session.listSessionTimeline({ sessionId, limit: 120 });
    expect(afterDelete.events.some((event) => event.eventId === selected.eventId)).toBe(false);
    expect(afterDelete.events.some((event) => event.payload?.kind.case === "messageDeleted"
      && event.payload.kind.value.requestedEventId === selected.eventId)).toBe(true);
  });

  it("resolves and dismisses mobile permission, question, and plan requests through HTTP, SQLite, and the Session Host", async () => {
    fixture = await OrchestratorE2eFixture.start({
      createAdapter: (profile) => new MobileInteractionFixtureAdapter(profile)
    });
    const begun = await fixture.anonymous.connection.beginPairing({
      deviceDisplayName: "Joko interaction phone",
      deviceKind: DeviceKind.MOBILE,
      platform: "android",
      appVersion: "0.1.0"
    });
    const challengeId = begun.challenge?.challengeId;
    if (!challengeId) throw new Error("The mobile interaction fixture did not return a pairing challenge.");
    const paired = (await fixture.anonymous.connection.completePairing({
      challengeId,
      humanCode: fixture.pairingCode(challengeId),
      deviceDisplayName: "Joko interaction phone",
      deviceKind: DeviceKind.MOBILE,
      platform: "android",
      appVersion: "0.1.0"
    })).result;
    if (!paired?.authKey || !paired.connection?.connectionId) throw new Error("The mobile interaction fixture did not pair.");
    const clients = fixture.clients(paired.authKey);
    const connectionId = paired.connection.connectionId;
    const adapter = fixture.adapter() as MobileInteractionFixtureAdapter;
    const sessionId = sessionIdFrom(await submit(
      clients.operation,
      connectionId,
      createSessionMutation({ backendId: adapter.id, targetId: fixture.targetId(), displayName: "Mobile interactions" })
    ));
    const generation = () => BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation);

    const open = async (text: string) => {
      const sent = await submit(clients.operation, connectionId, sendInputMutation(sessionId, generation(), text));
      const runId = queueRunIdFrom(sent);
      const listed = await waitFor(
        () => clients.interaction.listInteractions({ sessionId, runId }),
        (value) => value.interactions.some((interaction) => interaction.state === InteractionState.PENDING),
        `${text} mobile interaction`
      );
      const interaction = listed.interactions.find((candidate) => candidate.state === InteractionState.PENDING);
      if (!interaction?.version?.revision) throw new Error("The pending mobile Interaction has no exact version.");
      const snapshot = (await clients.event.getSnapshot({
        scope: { kind: { case: "session", value: { sessionId, recentTimelineItems: 120 } } }
      })).snapshot;
      expect(snapshot?.interactions.find((candidate) => candidate.interactionId === interaction.interactionId))
        .toMatchObject({ state: InteractionState.PENDING, generation: interaction.generation });
      return { interaction, runId };
    };
    const settle = async (interaction: Interaction, mutation: OperationMutation, expected: InteractionState) => {
      const operation = await submit(clients.operation, connectionId, create(OperationMutationSchema, {
        ...mutation,
        preconditions: [create(OperationPreconditionSchema, {
          entity: create(EntityRefSchema, { kind: EntityKind.INTERACTION, id: interaction.interactionId }),
          expectedRevision: interaction.version!.revision,
          expectedGeneration: interaction.generation
        })]
      }));
      expect(operation.state).toBe(OperationState.SUCCEEDED);
      await waitFor(
        () => clients.interaction.getInteraction({ interactionId: interaction.interactionId }),
        (value) => value.interaction?.state === expected,
        `${interaction.interactionId} terminal state`
      );
    };
    const waitRun = async (runId: string) => waitFor(
      () => clients.run.getRun({ runId }),
      (value) => value.run?.state === RunState.SUCCEEDED,
      `${runId} terminal Run`
    );

    const question = await open("[mobile-question]");
    await settle(question.interaction, create(OperationMutationSchema, {
      payload: { case: "resolveInteraction", value: create(ResolveInteractionMutationSchema, {
        interactionId: question.interaction.interactionId,
        interactionGeneration: question.interaction.generation,
        resolution: create(InteractionResolutionSchema, {
          connectionId,
          decision: { case: "question", value: create(QuestionResolutionSchema, { answers: [
            create(QuestionAnswerSchema, { fieldId: "summary", value: { case: "text", value: "Ready" } }),
            create(QuestionAnswerSchema, { fieldId: "release", value: { case: "singleChoice", value: create(QuestionSingleChoiceAnswerSchema, {
              selection: { case: "otherText", value: "candidate" }
            }) } }),
            create(QuestionAnswerSchema, { fieldId: "targets", value: { case: "multipleChoice", value: create(QuestionMultipleChoiceAnswerSchema, {
              choiceIds: ["web"], otherText: "desktop"
            }) } }),
            create(QuestionAnswerSchema, { fieldId: "publish", value: { case: "boolean", value: false } })
          ] }) }
        })
      }) }
    }), InteractionState.RESOLVED);
    await waitRun(question.runId);

    const plan = await open("[mobile-plan]");
    await settle(plan.interaction, create(OperationMutationSchema, {
      payload: { case: "resolveInteraction", value: create(ResolveInteractionMutationSchema, {
        interactionId: plan.interaction.interactionId,
        interactionGeneration: plan.interaction.generation,
        resolution: create(InteractionResolutionSchema, {
          connectionId,
          decision: { case: "planReview", value: create(PlanReviewResolutionSchema, {
            decision: PlanReviewDecisionKind.REFINE,
            feedback: "Tighten the evidence step"
          }) }
        })
      }) }
    }), InteractionState.RESOLVED);
    await waitRun(plan.runId);

    const permission = await open("[permission]");
    await settle(permission.interaction, create(OperationMutationSchema, {
      payload: { case: "dismissInteraction", value: create(DismissInteractionMutationSchema, {
        interactionId: permission.interaction.interactionId,
        interactionGeneration: permission.interaction.generation,
        reason: "Dismissed by user on mobile"
      }) }
    }), InteractionState.DISMISSED);
    await waitRun(permission.runId);

    expect(adapter.interactionDecisions).toEqual([
      "question:text:single:multiple:boolean",
      "plan:refine:Tighten the evidence step",
      "cancelled"
    ]);
    const persisted = fixture.application.store.listInteractions({ sessionId });
    expect(persisted.map((interaction) => interaction.status).sort()).toEqual(["dismissed", "resolved", "resolved"]);
  });

  it("applies mobile model, permission, and Plan Mode controls through HTTP, SQLite, and the Session Host", async () => {
    const runtimeProfile = {
      ...PI_LIKE_PROFILE,
      id: "mobile-runtime-controls",
      displayName: "Mobile runtime controls",
      capabilities: [
        ...PI_LIKE_PROFILE.capabilities.filter((capability) => !new Set<string>([
          capabilityNames.modelList,
          capabilityNames.modelSwitch,
          capabilityNames.modelEffort,
          capabilityNames.modelFastMode,
          capabilityNames.permissionModes,
          capabilityNames.permissionChange,
          capabilityNames.planMode
        ]).has(capability.key)),
        { key: capabilityNames.modelList, supported: true as const },
        { key: capabilityNames.modelSwitch, supported: true as const },
        { key: capabilityNames.modelEffort, supported: true as const },
        { key: capabilityNames.modelFastMode, supported: true as const },
        { key: capabilityNames.permissionModes, supported: true as const,
          options: ["ask", "auto", "bypassPermissions"] },
        { key: capabilityNames.permissionChange, supported: true as const },
        { key: capabilityNames.planMode, supported: true as const }
      ],
      models: PI_LIKE_PROFILE.models.map((model) => ({ ...model, supportsFastMode: true }))
    };
    fixture = await OrchestratorE2eFixture.start({ profiles: [runtimeProfile] });
    const paired = await fixture.pair("Joko runtime-control phone");
    const adapter = fixture.adapter();
    const setModel = vi.spyOn(adapter, "setModel");
    const setEffort = vi.spyOn(adapter, "setEffort");
    const setFastMode = vi.spyOn(adapter, "setFastMode");
    const setPermissionMode = vi.spyOn(adapter, "setPermissionMode");
    const setPlanMode = vi.spyOn(adapter, "setPlanMode");
    const initialModel = runtimeProfile.models[0]!;
    const selectedModel = runtimeProfile.models[1]!;
    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({
        backendId: adapter.id,
        targetId: fixture.targetId(),
        displayName: "Mobile runtime settings",
        providerId: initialModel.providerId,
        modelId: initialModel.modelId,
        effortId: initialModel.thinkingLevels[0],
        fastMode: false
      })
    ));

    const snapshot = async () => (await paired.clients.event.getSnapshot({
      scope: { kind: { case: "session", value: { sessionId, recentTimelineItems: 120 } } }
    })).snapshot!;
    const submitControl = async (mutation: OperationMutation) => {
      const before = await snapshot();
      const current = before.sessions.find((session) => session.sessionId === sessionId);
      const revision = current?.version?.revision;
      const generation = current?.nativeBinding?.runtimeGeneration;
      if (!revision || !generation) throw new Error("The mobile runtime-control task has no exact Session authority.");
      const operation = await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
        ...mutation,
        preconditions: [create(OperationPreconditionSchema, {
          entity: create(EntityRefSchema, { kind: EntityKind.SESSION, id: sessionId }),
          expectedRevision: revision,
          expectedGeneration: generation
        })]
      }));
      expect(operation.state).toBe(OperationState.SUCCEEDED);
      expect(fixture!.application.store.getOperation(operation.operationId).status).toBe("completed");
      return operation;
    };

    const initial = await snapshot();
    const capabilities = initial.backends.find((backend) => backend.backendId === adapter.id)?.capabilities?.capabilities ?? [];
    for (const name of [capabilityNames.modelList, capabilityNames.modelSwitch, capabilityNames.modelEffort,
      capabilityNames.modelFastMode, capabilityNames.permissionModes, capabilityNames.permissionChange, capabilityNames.planMode]) {
      expect(capabilities).toContainEqual(expect.objectContaining({ name, support: CapabilitySupport.SUPPORTED }));
    }
    const capabilityByName = new Map(capabilities.map((capability) => [capability.name, capability]));
    expect(capabilityByName.get(capabilityNames.modelList)?.options?.kind).toMatchObject({
      case: "model", value: { providerAware: true }
    });
    expect(capabilityByName.get(capabilityNames.modelSwitch)?.options?.kind).toMatchObject({
      case: "model", value: { switchDuringSession: true }
    });
    expect(capabilityByName.get(capabilityNames.modelEffort)?.options?.kind).toMatchObject({
      case: "model", value: { supportsEffort: true }
    });
    expect(capabilityByName.get(capabilityNames.modelFastMode)?.options?.kind).toMatchObject({
      case: "model", value: { supportsFastMode: true }
    });
    const permissionOptions = capabilities.find((capability) => capability.name === capabilityNames.permissionModes)?.options?.kind;
    expect(permissionOptions).toMatchObject({ case: "permission", value: {
      modes: [PermissionMode.ASK, PermissionMode.AUTO, PermissionMode.BYPASS_PERMISSIONS],
      mutableDuringSession: true
    } });
    expect(capabilityByName.get(capabilityNames.permissionChange)?.options?.kind).toMatchObject({
      case: "permission", value: { modes: [], mutableDuringSession: true }
    });
    expect(initial.models.find((model) => model.key?.providerId === selectedModel.providerId
      && model.key.modelId === selectedModel.modelId)).toMatchObject({ available: true, supportsFastMode: true });

    const selectedEffort = selectedModel.thinkingLevels.at(-1)!;
    await submitControl(modelMutation(sessionId, selectedModel.providerId, selectedModel.modelId, selectedEffort, true));
    await submitControl(permissionMutation(sessionId, PermissionMode.AUTO));
    await submitControl(planModeMutation(sessionId, true));

    const after = await snapshot();
    expect(after.sessions.find((session) => session.sessionId === sessionId)).toMatchObject({
      model: {
        model: { providerId: selectedModel.providerId, modelId: selectedModel.modelId },
        effortId: selectedEffort,
        fastMode: true
      },
      permissionMode: PermissionMode.AUTO,
      planMode: true
    });
    expect(fixture.application.store.getSession(sessionId).descriptor).toMatchObject({
      providerId: selectedModel.providerId,
      modelId: selectedModel.modelId,
      effort: selectedEffort,
      fastMode: true,
      permissionMode: "auto",
      planMode: true
    });
    expect(setModel).toHaveBeenCalledWith(selectedModel.providerId, selectedModel.modelId, expect.anything());
    expect(setEffort).toHaveBeenCalledWith(selectedEffort, expect.anything());
    expect(setFastMode).toHaveBeenCalledWith(true, expect.anything());
    expect(setPermissionMode).toHaveBeenCalledWith("auto", expect.anything());
    expect(setPlanMode).toHaveBeenCalledWith(true, expect.anything());
  });

  it("projects mobile context usage and compacts through HTTP, SQLite, and the Session Host", async () => {
    const contextProfile = {
      ...PI_LIKE_PROFILE,
      id: "mobile-context-controls",
      displayName: "Mobile context controls",
      capabilities: [
        ...PI_LIKE_PROFILE.capabilities.filter((capability) => !new Set<string>([
          capabilityNames.contextUsage,
          capabilityNames.contextCompact
        ]).has(capability.key)),
        { key: capabilityNames.contextUsage, supported: true as const },
        { key: capabilityNames.contextCompact, supported: true as const }
      ]
    };
    fixture = await OrchestratorE2eFixture.start({ profiles: [contextProfile] });
    const paired = await fixture.pair("Joko context phone");
    const adapter = fixture.adapter();
    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId: adapter.id, targetId: fixture.targetId(), displayName: "Mobile context" })
    ));
    const scope = { kind: { case: "session" as const, value: { sessionId, recentTimelineItems: 120 } } };
    const initial = await waitFor(
      async () => (await paired.clients.event.getSnapshot({ scope })).snapshot,
      (snapshot) => {
        const current = snapshot?.sessions.find((session) => session.sessionId === sessionId);
        return current?.state === SessionState.IDLE && current.context?.usedTokens === 20n;
      },
      "measured mobile context usage"
    );
    if (!initial) throw new Error("The mobile context task has no Session Snapshot.");
    const current = initial.sessions.find((session) => session.sessionId === sessionId);
    const revision = current?.version?.revision;
    const generation = current?.nativeBinding?.runtimeGeneration;
    if (!revision || !generation) throw new Error("The mobile context task has no exact Session authority.");
    expect(current?.version?.generation).toBe(generation);
    expect(current?.context).toMatchObject({
      usedTokens: 20n,
      contextWindowTokens: 32_000n,
      reservedTokens: 31_980n,
      cumulativeUsage: {
        inputTokens: 12n,
        outputTokens: 8n,
        cacheReadTokens: 0n,
        cacheWriteTokens: 0n,
        totalTokens: 20n
      }
    });
    expect(current!.context!.utilizationRatio).toBeCloseTo(20 / 32_000, 8);
    expect(current?.context?.measuredAt).toBeDefined();

    const capabilities = initial.backends.find((backend) => backend.backendId === adapter.id)
      ?.capabilities?.capabilities ?? [];
    const capabilityByName = new Map(capabilities.map((capability) => [capability.name, capability]));
    expect(capabilityByName.get(capabilityNames.contextUsage)).toMatchObject({
      support: CapabilitySupport.SUPPORTED,
      options: { kind: { case: "context", value: { reportsBoundary: true, manual: false } } }
    });
    expect(capabilityByName.get(capabilityNames.contextCompact)).toMatchObject({
      support: CapabilitySupport.SUPPORTED,
      options: { kind: { case: "context", value: { reportsBoundary: false, manual: true, customInstructions: false } } }
    });

    const operation = await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
      ...compactMutation(sessionId, ""),
      preconditions: [create(OperationPreconditionSchema, {
        entity: create(EntityRefSchema, { kind: EntityKind.SESSION, id: sessionId }),
        expectedRevision: revision,
        expectedGeneration: generation
      })]
    }));
    expect(operation.state).toBe(OperationState.SUCCEEDED);
    expect(operation.result?.payload.case).toBe("compactSession");
    if (operation.result?.payload.case !== "compactSession") {
      throw new Error("The mobile context operation has no typed result.");
    }
    expect(operation.result.payload.value.outcome).toBe(CompactSessionOutcome.COMPACTED);
    expect(fixture.application.store.getOperation(operation.operationId).status).toBe("completed");
    expect(adapter.compactCalls).toBe(1);

    const after = (await paired.clients.event.getSnapshot({ scope })).snapshot;
    const compactEvents = after?.timeline.filter((event) => event.payload?.kind.case === "compactionChanged") ?? [];
    expect(compactEvents.map((event) => event.payload?.kind.case === "compactionChanged"
      ? event.payload.kind.value.state : CompactionState.UNSPECIFIED)).toEqual([
      CompactionState.STARTED,
      CompactionState.COMPLETED
    ]);
    expect(compactEvents.every((event) => event.identity?.sessionId === sessionId
      && event.identity.generation === generation)).toBe(true);
    const storedCompactions = fixture.application.store.listEvents({ sessionId })
      .filter((event) => event.payload.type === "compaction");
    expect(storedCompactions.map((event) => event.payload.type === "compaction" ? event.payload.state : undefined))
      .toEqual(["started", "completed"]);
    expect(after?.sessions.find((session) => session.sessionId === sessionId)?.contextState?.compacting).toBe(false);
  });

  it("reads and navigates native branches through HTTP, SQLite, and the Session Host", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const paired = await fixture.pair("Joko branch phone");
    const adapter = fixture.adapter();
    let activeEntryId = "native-current";
    vi.spyOn(adapter, "getTree").mockImplementation(async () => ({
      roots: [{
        entryId: "native-root", kind: "message", role: "user", label: "Initial prompt", timestamp: 1,
        children: [
          { entryId: "native-current", parentId: "native-root", kind: "message", role: "assistant",
            label: "Current answer", timestamp: 2, children: [] },
          { entryId: "native-alternate", parentId: "native-root", kind: "message", role: "assistant",
            label: "Alternate answer", timestamp: 3, children: [] }
        ]
      }],
      leafId: activeEntryId
    }));
    const navigateTree = vi.spyOn(adapter, "navigateTree").mockImplementation(async (target) => {
      activeEntryId = target.kind === "native_entry" ? target.entryId : "";
      return { kind: "in_place" };
    });
    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId: adapter.id, targetId: fixture.targetId(), displayName: "Mobile branches" })
    ));
    const scope = { kind: { case: "session" as const, value: { sessionId, recentTimelineItems: 120 } } };
    const before = (await paired.clients.event.getSnapshot({ scope })).snapshot;
    const current = before?.sessions.find((session) => session.sessionId === sessionId);
    const revision = current?.version?.revision;
    const generation = current?.nativeBinding?.runtimeGeneration;
    if (!revision || !generation) throw new Error("The mobile branch task has no exact Session authority.");

    const capabilities = before?.backends.find((backend) => backend.backendId === adapter.id)
      ?.capabilities?.capabilities ?? [];
    expect(capabilities).toContainEqual(expect.objectContaining({
      name: capabilityNames.sessionTree,
      support: CapabilitySupport.SUPPORTED
    }));
    expect(capabilities).toContainEqual(expect.objectContaining({
      name: capabilityNames.sessionRewind,
      support: CapabilitySupport.SUPPORTED
    }));

    const initial = (await paired.clients.session.getNativeSessionTree({ sessionId })).tree;
    if (!initial) throw new Error("The mobile branch task returned no native tree.");
    expect(initial.revision).toEqual(revision);
    expect(initial.activeEntryId).toBe("native-current");
    expect(nativeSessionTreeRoots(initial)[0]).toMatchObject({
      entryId: "native-root",
      children: [
        { entryId: "native-current", active: true },
        { entryId: "native-alternate", active: false }
      ]
    });

    const operation = await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
      preconditions: [create(OperationPreconditionSchema, {
        entity: create(EntityRefSchema, { kind: EntityKind.SESSION, id: sessionId }),
        expectedRevision: revision,
        expectedGeneration: generation
      })],
      payload: { case: "navigateSessionBranch", value: create(NavigateSessionBranchMutationSchema, {
        sessionId,
        target: create(NativeNavigationTargetSchema, { kind: { case: "nativeEntryId", value: "native-alternate" } }),
        summarize: true,
        customInstructions: "  Preserve mobile verification evidence  "
      }) }
    }));

    expect(operation.state).toBe(OperationState.SUCCEEDED);
    expect(operation.result?.payload).toMatchObject({
      case: "acknowledgement",
      value: { accepted: true }
    });
    expect(fixture.application.store.getOperation(operation.operationId).status).toBe("completed");
    expect(navigateTree).toHaveBeenCalledWith(
      { kind: "native_entry", entryId: "native-alternate" },
      true,
      expect.anything(),
      "Preserve mobile verification evidence",
      expect.anything()
    );

    const refreshed = (await paired.clients.session.getNativeSessionTree({ sessionId })).tree;
    expect(refreshed?.activeEntryId).toBe("native-alternate");
    const after = (await paired.clients.event.getSnapshot({ scope })).snapshot;
    expect(refreshed?.revision).toEqual(after?.sessions.find((session) => session.sessionId === sessionId)?.version?.revision);
    expect(nativeSessionTreeRoots(refreshed!)[0]?.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ entryId: "native-current", active: false }),
      expect.objectContaining({ entryId: "native-alternate", active: true })
    ]));
  });
});

type MobileVoiceE2eProvider = Awaited<ReturnType<VoiceInputProviderFactory["create"]>>;

function createMobileVoiceHarness() {
  type Listener = Parameters<MobileVoiceE2eProvider["onEvent"]>[0];
  type Chunk = Parameters<MobileVoiceE2eProvider["appendAudio"]>[0];
  let listener: Listener | undefined;
  const chunks: Chunk[] = [];
  const provider: MobileVoiceE2eProvider = {
    async start() {},
    appendAudio(chunk) {
      chunks.push(chunk);
      listener?.({ type: "partial", text: "mobile partial words" });
    },
    async flushAudio() {
      listener?.({ type: "stable", text: "mobile final words" });
    },
    async stop() {},
    async recover() {},
    onEvent(next) {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    }
  };
  const factory: VoiceInputProviderFactory = {
    describe: () => ({
      support: "supported",
      mimeTypes: ["audio/pcm"],
      supportsLocale: true,
      supportsLiveDrafts: true,
      supportsRefinement: false
    }),
    create: () => provider
  };
  return {
    coordinator: new VoiceInputCoordinator({
      provider: factory,
      createId: () => "mobile-voice-e2e"
    }),
    chunks
  };
}
