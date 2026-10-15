import { randomUUID } from "node:crypto";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import * as contract from "@joko/contracts";
import { expect, it } from "vitest";

import type { PairedClient } from "./connect-clients.js";
import { createSessionMutation, queueItemFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";

type SharingClient = Client<typeof contract.TaskSharingService>;

function sharing(fixture: RealPiSystemFixture, paired: PairedClient): SharingClient {
  return createClient(contract.TaskSharingService, createConnectTransport({
    baseUrl: fixture.baseUrl,
    httpVersion: "1.1",
    useBinaryFormat: true,
    defaultTimeoutMs: 10_000,
    interceptors: [next => request => {
      request.header.set("authorization", `Bearer ${paired.authKey}`);
      return next(request);
    }]
  }));
}

async function invoke<T>(api: SharingClient, joinId: string, method: contract.TaskShareMethod, request: object): Promise<T> {
  const descriptor = contract.taskShareMethodDescriptor(method);
  const response = await api.invokeJoinedTask({
    joinId, method, requestBytes: toBinary(descriptor.input, create(descriptor.input, request as never))
  });
  return fromBinary(descriptor.output, response.responseBytes) as T;
}

async function guestSubmit(api: SharingClient, joinId: string, mutation: contract.OperationMutation): Promise<contract.Operation> {
  const response = await invoke<contract.SubmitOperationResponse>(api, joinId, contract.TaskShareMethod.SUBMIT_OPERATION, {
    operationId: randomUUID(), mutation
  });
  if (!response.operation) throw new Error("The shared Task returned no operation receipt.");
  return response.operation;
}

async function waitUntil(read: () => Promise<boolean>, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await read()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  // Do not dump Provider requests, invitations, or authentication on failure.
  throw new Error(`Timed out waiting for ${label}.`);
}

interface UserOccurrence {
  readonly text: string;
  readonly nativeEntryId: string;
  readonly operationId: string;
  readonly runId: string;
  readonly queueItemId: string;
  readonly accepted: boolean;
  readonly delivery: contract.MessageInputDelivery;
  readonly author: contract.SharedTaskAuthor | undefined;
}

function users(events: readonly contract.Event[]): readonly UserOccurrence[] {
  return events.flatMap(event => {
    const kind = event.payload?.kind;
    if (kind?.case !== "messageStarted" || kind.value.role !== contract.MessageRole.USER) return [];
    return [{
      text: kind.value.userInput?.parts.flatMap(part => part.content.case === "text" ? [part.content.value] : []).join("\n") ?? "",
      nativeEntryId: kind.value.nativeIdentity?.entryId ?? "",
      operationId: event.identity?.operationId ?? "",
      runId: event.identity?.runId ?? "",
      queueItemId: event.identity?.queueItemId ?? "",
      accepted: kind.value.userInputAccepted,
      delivery: kind.value.inputDelivery,
      author: kind.value.sharedTaskAuthor
    }];
  });
}

function assertCanonicalUsers(events: readonly contract.Event[], inputs: readonly {
  readonly text: string;
  readonly operation: contract.Operation;
  readonly delivery: contract.MessageInputDelivery;
  readonly author?: contract.SharedTaskAuthor;
}[]): readonly UserOccurrence[] {
  const rows = users(events);
  expect(rows).toHaveLength(inputs.length);
  expect(rows.map(row => row.text)).toEqual(inputs.map(input => input.text));
  expect(new Set(rows.map(row => row.nativeEntryId)).size).toBe(inputs.length);
  for (const input of inputs) {
    const matching = rows.filter(row => row.text === input.text);
    expect(matching).toHaveLength(1);
    const row = matching[0]!;
    const queue = queueItemFrom(input.operation);
    expect(row.nativeEntryId.length).toBeGreaterThan(0);
    expect(row).toMatchObject({
      operationId: input.operation.operationId,
      runId: queue.runId,
      queueItemId: queue.queueItemId,
      accepted: true,
      delivery: input.delivery
    });
    expect(row.author).toEqual(input.author);
  }
  return rows;
}

it("keeps real Pi owner, guest steer and follow-up canonical attribution across both node restarts", { timeout: 150_000 }, async () => {
  let host: RealPiSystemFixture | undefined;
  let home: RealPiSystemFixture | undefined;
  try {
    host = await RealPiSystemFixture.start({ taskSharing: true, holdProviderResponses: true });
    home = await RealPiSystemFixture.start({ taskSharing: true });
    const owner = await host.pair("Host participant A"), visitor = await home.pair("Home participant B");
    let ownerClients = owner.clients;
    const ownerApi = sharing(host, owner);
    let visitorApi = sharing(home, visitor);
    const backends = await ownerClients.backend.listBackends({});
    const pi = backends.backends.find(row => row.backendId === "pi");
    expect(pi?.health).toBe(contract.BackendHealth.HEALTHY);
    expect(pi?.installationState).toBe(contract.InstallationState.INSTALLED);
    expect(pi?.version).toMatch(/^\d+\.\d+\.\d+(?:[-+].*)?$/u);
    expect(host.application.serverId === home.application.serverId).toBe(false);

    const sessionId = sessionIdFrom(await submit(ownerClients.operation, owner.connectionId, createSessionMutation({
      backendId: "pi", targetId: "workspace-real-pi", displayName: "Shared native Task",
      providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, effortId: "off"
    })));
    const share = (await ownerApi.createTaskShare({ operationId: randomUUID(), sessionId })).share!;
    const invitation = (await ownerApi.createTaskShareInvitation({ operationId: randomUUID(), shareId: share.shareId })).invitation;
    const joined = (await visitorApi.joinTaskShare({ operationId: randomUUID(), invitation, displayName: "Participant B" })).intent!.joined!;
    const author = create(contract.SharedTaskAuthorSchema, {
      shareId: share.shareId, sessionId, shareGeneration: share.shareGeneration,
      memberId: joined.member!.memberId, memberGeneration: joined.member!.memberGeneration,
      displayName: joined.member!.displayName
    });
    const initial = (await visitorApi.getJoinedTaskSnapshot({ joinId: joined.joinId })).state!.snapshot!;
    const generation = initial.sessions[0]!.nativeBinding!.runtimeGeneration;
    const scope = create(contract.SnapshotScopeSchema, {
      kind: { case: "session", value: { sessionId, recentTimelineItems: 500 } }
    });
    const ownerText = "Participant A begins the shared native run.";
    const steerText = "Participant B steers this active native run.";
    const followUpText = "Participant B follows up after the steering reply.";
    const ownerOperation = await submit(ownerClients.operation, owner.connectionId, sendInputMutation(sessionId, generation, ownerText));
    await waitUntil(async () => host!.providerRequests.length === 1, "the owner's actual Pi Provider request");
    // Pi consumes steering before follow-ups even when the follow-up was admitted first.
    const followUpOperation = await guestSubmit(visitorApi, joined.joinId, sendInputMutation(sessionId, generation, followUpText, contract.QueueDeliveryMode.FOLLOW_UP));
    const followUp = queueItemFrom(followUpOperation);
    expect(followUpOperation.sharedTaskAuthor).toEqual(author);
    await waitUntil(async () => (await ownerClients.queue.listQueueItems({ sessionId })).queueItems
      .some(row => row.queueItemId === followUp.queueItemId && row.state === contract.QueueItemState.BACKEND_ACCEPTED), "the guest follow-up native admission");
    const steerOperation = await guestSubmit(visitorApi, joined.joinId, sendInputMutation(sessionId, generation, steerText, contract.QueueDeliveryMode.STEER));
    const steer = queueItemFrom(steerOperation);
    expect(steerOperation.sharedTaskAuthor).toEqual(author);
    await waitUntil(async () => (await ownerClients.queue.listQueueItems({ sessionId })).queueItems
      .some(row => row.queueItemId === steer.queueItemId && row.state === contract.QueueItemState.BACKEND_ACCEPTED), "the guest steer native admission");
    expect(host.providerRequests.length).toBe(1);
    host.releaseProviderResponses();

    const inputs = [
      { text: ownerText, operation: ownerOperation, delivery: contract.MessageInputDelivery.PROMPT },
      { text: steerText, operation: steerOperation, delivery: contract.MessageInputDelivery.STEER, author },
      { text: followUpText, operation: followUpOperation, delivery: contract.MessageInputDelivery.FOLLOW_UP, author }
    ];
    await waitUntil(async () => (await Promise.all(inputs.map(async input =>
      (await ownerClients.run.getRun({ runId: queueItemFrom(input.operation).runId })).run?.state
    ))).every(state => state === contract.RunState.SUCCEEDED), "all three original native participant runs");
    const hostSnapshot = (await ownerClients.event.getSnapshot({ scope })).snapshot!;
    const canonical = assertCanonicalUsers(hostSnapshot.timeline, inputs);
    const guestSnapshot = (await visitorApi.getJoinedTaskSnapshot({ joinId: joined.joinId })).state!.snapshot!;
    expect(assertCanonicalUsers(guestSnapshot.timeline, inputs)).toEqual(canonical);
    const timeline = await invoke<contract.ListSessionTimelineResponse>(visitorApi, joined.joinId,
      contract.TaskShareMethod.LIST_SESSION_TIMELINE, { sessionId, limit: 500 });
    expect(assertCanonicalUsers(timeline.events, inputs)).toEqual(canonical);
    expect(host.providerRequests.length).toBeGreaterThanOrEqual(3);
    expect(home.providerRequests.length).toBe(0);

    const hostRoot = host.rootDirectory, homeRoot = home.rootDirectory;
    const hostPort = Number(new URL(host.baseUrl).port), homePort = Number(new URL(home.baseUrl).port);
    await home.close({ removeRoot: false });
    home = undefined;
    await host.close({ removeRoot: false });
    host = undefined;
    host = await RealPiSystemFixture.start({ rootDirectory: hostRoot, port: hostPort, taskSharing: true });
    home = await RealPiSystemFixture.start({ rootDirectory: homeRoot, port: homePort, taskSharing: true });
    ownerClients = host.clients(owner.authKey);
    visitorApi = sharing(home, visitor);
    expect((await visitorApi.listTaskShares({})).joined.some(row => row.joinId === joined.joinId && row.status === "active")).toBe(true);
    const restoredHost = (await ownerClients.event.getSnapshot({ scope })).snapshot!;
    expect(assertCanonicalUsers(restoredHost.timeline, inputs)).toEqual(canonical);
    const restoredGuest = (await visitorApi.getJoinedTaskSnapshot({ joinId: joined.joinId })).state!.snapshot!;
    expect(assertCanonicalUsers(restoredGuest.timeline, inputs)).toEqual(canonical);
    const restoredTimeline = await invoke<contract.ListSessionTimelineResponse>(visitorApi, joined.joinId,
      contract.TaskShareMethod.LIST_SESSION_TIMELINE, { sessionId, limit: 500 });
    expect(assertCanonicalUsers(restoredTimeline.events, inputs)).toEqual(canonical);
    for (const input of inputs) {
      const response = input.author === undefined
        ? await ownerClients.operation.getOperation({ operationId: input.operation.operationId })
        : await invoke<contract.GetOperationResponse>(visitorApi, joined.joinId, contract.TaskShareMethod.GET_OPERATION, {
          operationId: input.operation.operationId
        });
      expect(response.operation?.operationId).toBe(input.operation.operationId);
      expect(response.operation?.state).toBe(contract.OperationState.SUCCEEDED);
      expect(response.operation?.sharedTaskAuthor).toEqual(input.author);
      expect(queueItemFrom(response.operation!).queueItemId).toBe(queueItemFrom(input.operation).queueItemId);
    }
    expect(host.providerRequests.length).toBe(0);
    expect(home.providerRequests.length).toBe(0);
  } finally {
    await home?.close({ removeRoot: true });
    await host?.close({ removeRoot: true });
  }
});
