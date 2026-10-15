import { createHash, randomUUID } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Code, createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import * as contract from "@joko/contracts";
import type { AdapterContext, PromptInput } from "@joko/core";
import { expect, it } from "vitest";
import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor, type PairedClient } from "./fixture.js";
import { createSessionMutation, editQueuedInputMutation, pauseQueueMutation, queueItemFrom, sendInputMutation,
  sessionIdFrom, setQueueItemEditLockMutation, submit } from "./operations.js";

type SharingClient = Client<typeof contract.TaskSharingService>;
function sharing(fixture: OrchestratorE2eFixture, paired: PairedClient): SharingClient {
  return createClient(contract.TaskSharingService, createConnectTransport({ baseUrl: fixture.baseUrl, httpVersion: "1.1", useBinaryFormat: true,
    defaultTimeoutMs: 10_000, interceptors: [next => request => { request.header.set("authorization", `Bearer ${paired.authKey}`); return next(request); }] }));
}
async function invoke<T>(api: SharingClient, joinId: string, method: contract.TaskShareMethod, request: object): Promise<T> {
  const descriptor = contract.taskShareMethodDescriptor(method);
  const response = await api.invokeJoinedTask({ joinId, method, requestBytes: toBinary(descriptor.input, create(descriptor.input, request as never)) });
  return fromBinary(descriptor.output, response.responseBytes) as T;
}
async function guestSubmit(api: SharingClient, joinId: string, mutation: contract.OperationMutation, operationId = randomUUID()): Promise<contract.Operation> {
  const response = await invoke<contract.SubmitOperationResponse>(api, joinId, contract.TaskShareMethod.SUBMIT_OPERATION, { operationId, mutation });
  if (!response.operation) throw new Error("The shared Task returned no operation receipt.");
  return response.operation;
}
class SharingAdapter extends InstrumentedFakeAdapter {
  constructor(profile: ConstructorParameters<typeof InstrumentedFakeAdapter>[0]) {
    super({ ...profile, capabilities: [...profile.capabilities, { key: "input.file", supported: true }] });
  }
  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    await context.emit({ type: "message_complete", role: "user", blocks: [{ kind: "text", text: input.text }] });
    if (input.text === "[question]") await context.requestInteraction({ id: `question-${randomUUID()}`, kind: "question", title: "Choose", prompt: "Continue?",
      fields: [{ id: "continue", kind: "boolean", label: "Continue", required: true, defaultValue: false }] });
    if (input.text === "[plan]") await context.requestInteraction({ id: `plan-${randomUUID()}`, kind: "plan_review", title: "Review plan", markdown: "Read the fixture.", choices: ["execute", "stay", "refine"] });
    await super.send(input, context);
  }
}

it("keeps two-node shared Task, authors, receipts, attachments and joined directory across both restarts then revokes access", async () => {
  let host: OrchestratorE2eFixture | undefined, home: OrchestratorE2eFixture | undefined;
  try {
    host = await OrchestratorE2eFixture.start({ taskSharing: true, serverId: "sharing-host", createAdapter: profile => new SharingAdapter(profile) });
    home = await OrchestratorE2eFixture.start({ taskSharing: true, serverId: "sharing-home" });
    const owner = await host.pair("Host owner"), visitor = await home.pair("Visitor"), sibling = await home.pair("Second Home client");
    let ownerApi = sharing(host, owner), visitorApi = sharing(home, visitor);
    const sessionId = sessionIdFrom(await submit(owner.clients.operation, owner.connectionId, createSessionMutation({ backendId: host.adapter().id, targetId: host.targetId(), providerId: "test", modelId: "text", displayName: "Original shared Task" })));
    const share = (await ownerApi.createTaskShare({ operationId: randomUUID(), sessionId })).share!;
    const invitation = (await ownerApi.createTaskShareInvitation({ operationId: randomUUID(), shareId: share.shareId })).invitation;
    expect((await visitorApi.previewTaskShareInvitation({ invitation })).share?.sessionId).toBe(sessionId);
    const joined = (await visitorApi.joinTaskShare({ operationId: randomUUID(), invitation, displayName: "Visitor" })).intent!.joined!;
    expect(joined.share?.sessionId).toBe(sessionId);
    expect((await sharing(home, sibling).listTaskShares({})).joined[0]?.joinId).toBe(joined.joinId);
    const initial = (await visitorApi.getJoinedTaskSnapshot({ joinId: joined.joinId })).state!.snapshot!;
    expect(initial.sessions.map(session => session.sessionId)).toEqual([sessionId]);
    expect(initial.connections).toEqual([]); expect(initial.devices).toEqual([]); expect(initial.workspaces).toEqual([]);
    await expect(invoke(visitorApi, joined.joinId, contract.TaskShareMethod.GET_OPERATION, { operationId: randomUUID() }))
      .rejects.toMatchObject({ code: Code.NotFound });
    const noOutput = await invoke<contract.GetBackgroundTaskOutputResponse>(visitorApi, joined.joinId,
      contract.TaskShareMethod.GET_BACKGROUND_TASK_OUTPUT, { sessionId, backgroundTaskId: "not-registered" });
    expect(noOutput.output?.state).toBe(contract.BackgroundTaskOutputState.UNAVAILABLE);
    const generation = initial.sessions[0]!.nativeBinding!.runtimeGeneration;
    const control = (await owner.clients.queue.getQueueControl({ sessionId })).queueControl!;
    await submit(owner.clients.operation, owner.connectionId, pauseQueueMutation(control));
    const requestId = randomUUID(), mutation = sendInputMutation(sessionId, generation, "Guest draft");
    let item = queueItemFrom(await guestSubmit(visitorApi, joined.joinId, mutation, requestId));
    expect(item.sharedTaskAuthor?.memberId).toBe(joined.member?.memberId);
    expect(queueItemFrom(await guestSubmit(visitorApi, joined.joinId, mutation, requestId)).queueItemId).toBe(item.queueItemId);
    const lockToken = randomUUID();
    item = queueItemFrom(await guestSubmit(visitorApi, joined.joinId, setQueueItemEditLockMutation(item, lockToken, true)));
    item = queueItemFrom(await guestSubmit(visitorApi, joined.joinId, editQueuedInputMutation(item, "Edited guest draft", contract.QueueDeliveryMode.PROMPT, lockToken)));
    await guestSubmit(visitorApi, joined.joinId, setQueueItemEditLockMutation(item, lockToken, false));
    const ordinaryOperationId = randomUUID(), ordinaryItem = queueItemFrom(await submit(owner.clients.operation, owner.connectionId, sendInputMutation(sessionId, generation, "Owner pending"), ordinaryOperationId));
    await expect(invoke(visitorApi, joined.joinId, contract.TaskShareMethod.GET_OPERATION, { operationId: ordinaryOperationId }))
      .rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(guestSubmit(visitorApi, joined.joinId, setQueueItemEditLockMutation(ordinaryItem, randomUUID(), true))).rejects.toMatchObject({ code: Code.PermissionDenied });

    const bytes = Buffer.from("Shared text attachment\n"), begin = (await visitorApi.transferJoinedTaskAttachment({ joinId: joined.joinId,
      transfer: { action: { case: "begin", value: { operationId: randomUUID(), name: "shared.txt", mediaType: "text/plain", sizeBytes: BigInt(bytes.length), sha256Hex: createHash("sha256").update(bytes).digest("hex") } } } })).result!;
    const uploaded = (await visitorApi.transferJoinedTaskAttachment({ joinId: joined.joinId,
      transfer: { action: { case: "write", value: { ticketId: begin.ticketId, offset: 0n, data: bytes, finish: true } } } })).result!;
    const attachmentMutation = sendInputMutation(sessionId, generation, "Attachment");
    if (attachmentMutation.payload.case !== "sendInput") throw new Error("Unexpected input mutation.");
    attachmentMutation.payload.value.input!.parts.push(create(contract.InputPartSchema, { content: { case: "file", value: uploaded.blob! } }));
    await guestSubmit(visitorApi, joined.joinId, attachmentMutation);
    const directSecret = "controlled-task-guest-key".padEnd(43, "x"), direct = createClient(contract.TaskSharingGuestService,
      createConnectTransport({ baseUrl: host.baseUrl, httpVersion: "1.1", interceptors: [next => request => { request.header.set("authorization", `TaskShareGuest ${directSecret}`); return next(request); }] }));
    const accepted = await direct.acceptTaskShareJoin({ intentId: randomUUID(), invitation, credentialSha256Hex: createHash("sha256").update(directSecret).digest("hex"), displayName: "Independent member", homeServerId: "independent-home", homeDeviceId: "device" });
    const scope = create(contract.TaskShareScopeSchema, { hostServerId: share.hostServerId, shareId: share.shareId, shareGeneration: share.shareGeneration,
      sessionId, memberId: accepted.member!.memberId, memberGeneration: accepted.member!.memberGeneration });
    const wrongPurpose = createClient(contract.SessionService, createConnectTransport({ baseUrl: host.baseUrl, httpVersion: "1.1",
      interceptors: [next => request => { request.header.set("authorization", `TaskShareGuest ${directSecret}`); return next(request); }] }));
    await expect(wrongPurpose.getSession({ sessionId })).rejects.toMatchObject({ code: Code.Unauthenticated });
    const foreign = await host.application.artifacts.ingestBytes(Buffer.from("Private unrelated bytes"), { fileName: "private.txt" });
    await expect(direct.transferSharedTaskAttachment({ scope, transfer: { action: { case: "read", value: { blobId: foreign.id, maximumBytes: 256 } } } })).rejects.toMatchObject({ code: Code.PermissionDenied });

    const hostRoot = host.rootDirectory, homeRoot = home.rootDirectory, hostPort = new URL(host.baseUrl).port, homePort = new URL(home.baseUrl).port;
    await Promise.all([host.close({ removeRoot: false }), home.close({ removeRoot: false })]); host = undefined; home = undefined;
    host = await OrchestratorE2eFixture.start({ rootDirectory: hostRoot, publicPort: Number(hostPort), taskSharing: true, serverId: "sharing-host", createAdapter: profile => new SharingAdapter(profile) });
    home = await OrchestratorE2eFixture.start({ rootDirectory: homeRoot, publicPort: Number(homePort), taskSharing: true, serverId: "sharing-home" });
    ownerApi = sharing(host, owner); visitorApi = sharing(home, visitor);
    expect((await visitorApi.listTaskShares({})).joined[0]?.joinId).toBe(joined.joinId);
    const restored = (await visitorApi.getJoinedTaskSnapshot({ joinId: joined.joinId })).state!.snapshot!;
    expect(restored.queueItems.find(row => row.queueItemId === item.queueItemId)?.sharedTaskAuthor?.memberId).toBe(joined.member?.memberId);
    const replayed = await invoke<contract.GetOperationResponse>(visitorApi, joined.joinId, contract.TaskShareMethod.GET_OPERATION, { operationId: requestId });
    expect(replayed.operation?.operationId).toBe(requestId);
    const downloaded = (await visitorApi.transferJoinedTaskAttachment({ joinId: joined.joinId,
      transfer: { action: { case: "read", value: { blobId: uploaded.blob!.blobId, offset: 0n, maximumBytes: 256 } } } })).result!;
    expect(Buffer.from(downloaded.data)).toEqual(bytes);
    const leaveId = randomUUID();
    await direct.leaveSharedTask({ scope, operationId: leaveId });
    expect((await direct.getSharedTaskLeaveReceipt({ scope, operationId: leaveId })).applied).toBe(true);
    await expect(direct.getSharedTaskSnapshot({ scope })).rejects.toMatchObject({ code: Code.PermissionDenied });
    const currentControl = (await host.clients(owner.authKey).queue.getQueueControl({ sessionId })).queueControl!;
    await guestSubmit(visitorApi, joined.joinId, create(contract.OperationMutationSchema, { preconditions: [{ entity: { kind: contract.EntityKind.QUEUE_CONTROL, id: sessionId }, expectedRevision: currentControl.version!.revision }], payload: { case: "resumeQueue", value: { sessionId } } }));
    await waitFor(() => host!.clients(owner.authKey).run.getRun({ runId: item.runId }), response => response.run?.state === contract.RunState.SUCCEEDED, "original shared input to settle");
    const batch = (await visitorApi.readJoinedTaskEvents({ joinId: joined.joinId, after: restored.resumeCursor, limit: 500 })).batch!;
    expect(batch.events.every(event => event.identity?.sessionId === sessionId)).toBe(true);
    expect(batch.resyncRequired).toBe(false);
    expect(batch.events.some(event => event.payload?.kind.case === "messageStarted" && event.payload.kind.value.sharedTaskAuthor?.memberId === joined.member?.memberId)).toBe(true);
    await ownerApi.removeTaskShareMember({ operationId: randomUUID(), shareId: share.shareId, memberId: joined.member!.memberId, memberGeneration: joined.member!.memberGeneration });
    await expect(visitorApi.getJoinedTaskSnapshot({ joinId: joined.joinId })).rejects.toMatchObject({ code: Code.PermissionDenied });
    await ownerApi.endTaskShare({ operationId: randomUUID(), shareId: share.shareId });
    expect((await host.clients(owner.authKey).session.getSession({ sessionId })).session?.sessionId).toBe(sessionId);
    expect(host.application.store.listSessions({ includeArchived: true }).filter(row => row.descriptor.id === sessionId)).toHaveLength(1);
  } finally { await home?.close(); await host?.close(); }
}, 60_000);

it("uses the Host model runtime and all three current Interaction kinds through the shared Task HTTP boundary", async () => {
  let host: OrchestratorE2eFixture | undefined, home: OrchestratorE2eFixture | undefined;
  try {
    host = await OrchestratorE2eFixture.start({ taskSharing: true, serverId: "interaction-host", createAdapter: profile => new SharingAdapter(profile) });
    home = await OrchestratorE2eFixture.start({ taskSharing: true, serverId: "interaction-home" });
    const owner = await host.pair(), visitor = await home.pair(), ownerApi = sharing(host, owner), visitorApi = sharing(home, visitor);
    const sessionId = sessionIdFrom(await submit(owner.clients.operation, owner.connectionId, createSessionMutation({ backendId: host.adapter().id, targetId: host.targetId(), providerId: "test", modelId: "text" })));
    const share = (await ownerApi.createTaskShare({ operationId: randomUUID(), sessionId })).share!;
    const invitation = (await ownerApi.createTaskShareInvitation({ operationId: randomUUID(), shareId: share.shareId })).invitation;
    const joined = (await visitorApi.joinTaskShare({ operationId: randomUUID(), invitation, displayName: "Participant" })).intent!.joined!;
    const runtime = await invoke<contract.GetRuntimeControlResponse>(visitorApi, joined.joinId, contract.TaskShareMethod.GET_RUNTIME_CONTROL, { sessionId });
    await guestSubmit(visitorApi, joined.joinId, create(contract.OperationMutationSchema, { payload: { case: "setSessionRuntime", value: {
      sessionId, expectedRuntimeGeneration: runtime.control!.generation, effort: "medium" } } }));
    expect(host.application.sessionHost.getSessionRuntimeControl(sessionId).effective?.effort).toBe("medium");
    for (const text of ["[permission]", "[question]", "[plan]"]) {
      const generation = BigInt(host.application.store.getSession(sessionId).descriptor.binding.generation);
      const input = await guestSubmit(visitorApi, joined.joinId, sendInputMutation(sessionId, generation, text));
      const runId = queueItemFrom(input).runId;
      const waiting = await waitFor(() => invoke<contract.ListInteractionsResponse>(visitorApi, joined.joinId, contract.TaskShareMethod.LIST_INTERACTIONS, { sessionId }),
        response => response.interactions.some(interaction => interaction.runId === runId && interaction.state === contract.InteractionState.PENDING), `${text} interaction`);
      const interaction = waiting.interactions.find(row => row.runId === runId && row.state === contract.InteractionState.PENDING)!;
      const resolution = create(contract.InteractionResolutionSchema, { decision: text === "[permission]" ? { case: "permission", value: { decision: contract.PermissionDecisionKind.ALLOW_ONCE } }
        : text === "[question]" ? { case: "question", value: { answers: [{ fieldId: "continue", value: { case: "boolean", value: true } }] } }
        : { case: "planReview", value: { decision: contract.PlanReviewDecisionKind.EXECUTE } } });
      await guestSubmit(visitorApi, joined.joinId, create(contract.OperationMutationSchema, { payload: { case: "resolveInteraction", value: {
        interactionId: interaction.interactionId, interactionGeneration: interaction.version!.generation, resolution } } }));
      await waitFor(() => owner.clients.run.getRun({ runId }), response => response.run?.state === contract.RunState.SUCCEEDED, `${text} original run`);
    }
    expect(host.adapter().sendCalls).toHaveLength(3);
  } finally { await home?.close(); await host?.close(); }
}, 60_000);
