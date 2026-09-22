import { createCipheriv } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OperationalStore,
  StaleGenerationError,
  StoreError,
  messagingConversationContextAad,
  operationBodyHash
} from "./index.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("OperationalStore messaging", () => {
  it("persists an enabled connection offline with a bounded failure and clears it on recovery", () => {
    const fixture = createFixture();
    const initial = fixture.store.createMessagingConnection({
      id: "wecom-offline",
      channel: "wecom",
      configuration: { format: 1, botId: "wecom-bot" },
      createdAt: 10
    });
    const enabled = fixture.store.replaceMessagingCredential({
      connectionId: initial.id,
      expectedRevision: initial.revision,
      expectedGeneration: initial.generation,
      credentialReferenceId: "managed-wecom-secret",
      credentialGeneration: "1".repeat(64),
      enable: true,
      updatedAt: 11
    });

    const offline = fixture.store.updateMessagingConnectionRuntime({
      connectionId: enabled.id,
      expectedRevision: enabled.revision,
      expectedGeneration: enabled.generation,
      runtimeStatus: "offline",
      error: { code: "network", summary: "WeCom is temporarily unavailable." },
      updatedAt: 12
    });
    expect(offline).toMatchObject({
      enabled: true,
      runtimeStatus: "offline",
      errorCode: "network",
      errorSummary: "WeCom is temporarily unavailable."
    });

    const connected = fixture.store.updateMessagingConnectionRuntime({
      connectionId: offline.id,
      expectedRevision: offline.revision,
      expectedGeneration: offline.generation,
      runtimeStatus: "connected",
      providerAccountId: "wecom-bot",
      error: null,
      connectedAt: 13,
      updatedAt: 13
    });
    expect(connected).toMatchObject({ runtimeStatus: "connected" });
    expect(connected.errorCode).toBeUndefined();
    expect(connected.errorSummary).toBeUndefined();
  });

  it("separates credential replacement from offline state and snapshots routes only when a conversation binds", () => {
    const fixture = createFixture();
    const initial = fixture.store.createMessagingConnection({
      id: "telegram-1",
      channel: "telegram",
      ownerProviderUserId: "42",
      configuration: { groupActivation: { "-100": "mention" } },
      createdAt: 10
    });
    expect(initial).toMatchObject({ generation: 1, enabled: false, runtimeStatus: "idle" });
    const route = fixture.store.putMessagingRoute({
      targetId: "target-1",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      updatedAt: 11
    });
    const configured = fixture.store.replaceMessagingCredential({
      connectionId: initial.id,
      expectedRevision: initial.revision,
      expectedGeneration: initial.generation,
      credentialReferenceId: "managed-credential-ref-1",
      credentialGeneration: "1".repeat(64),
      ownerProviderUserId: "42",
      enable: true,
      updatedAt: 12
    });
    const observed = fixture.store.ensureMessagingConversation({
      id: "conversation-1",
      connectionId: configured.id,
      expectedChannelGeneration: configured.generation,
      providerConversationId: "-100",
      providerThreadId: "55",
      conversationKind: "group",
      observedAt: 13
    });
    fixture.store.createSession({
      id: "messaging-session-1",
      backendId: "backend-1",
      targetId: "target-1",
      title: "Telegram group",
      binding: { opaqueRef: "service/messaging/conversation-1", generation: 0 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 14,
      updatedAt: 14
    });
    const bound = fixture.store.bindMessagingConversation({
      conversationId: observed.id,
      expectedRevision: observed.revision,
      expectedChannelGeneration: configured.generation,
      sessionId: "messaging-session-1",
      expectedSessionGeneration: 0,
      routeScopeKey: route.scopeKey,
      updatedAt: 15
    });
    expect(bound).toMatchObject({
      status: "active",
      sessionId: "messaging-session-1",
      targetId: "target-1",
      backendId: "backend-1",
      permissionMode: "ask"
    });

    const changedRoute = fixture.store.putMessagingRoute({
      expectedRevision: route.revision,
      targetId: "target-1",
      fastMode: true,
      permissionMode: "auto",
      planMode: true,
      updatedAt: 16
    });
    expect(changedRoute).toMatchObject({ fastMode: true, permissionMode: "auto", planMode: true });
    expect(fixture.store.getMessagingConversation(bound.id)).toMatchObject({
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    });

    const offline = fixture.store.setMessagingConnectionEnabled({
      connectionId: configured.id,
      expectedRevision: configured.revision,
      expectedGeneration: configured.generation,
      enabled: false,
      updatedAt: 17
    });
    expect(offline).toMatchObject({ generation: 3, enabled: false, runtimeStatus: "offline" });
    expect(fixture.store.getMessagingConversation(bound.id)).toMatchObject({
      status: "active",
      channelGeneration: 3,
      sessionId: "messaging-session-1"
    });
    expect(() => fixture.store.ensureMessagingConversation({
      connectionId: offline.id,
      expectedChannelGeneration: 2,
      providerConversationId: "-101",
      conversationKind: "group"
    })).toThrow(StaleGenerationError);

    const replaced = fixture.store.replaceMessagingCredential({
      connectionId: offline.id,
      expectedRevision: offline.revision,
      expectedGeneration: offline.generation,
      credentialReferenceId: "managed-credential-ref-2",
      credentialGeneration: "2".repeat(64),
      ownerProviderUserId: "84",
      enable: true,
      updatedAt: 18
    });
    expect(replaced).toMatchObject({ generation: 4, runtimeStatus: "connecting" });
    expect(replaced.cursor).toBeUndefined();
    expect(fixture.store.getMessagingConversation(bound.id).status).toBe("retired");

    const cleared = fixture.store.clearMessagingCredential({
      connectionId: replaced.id,
      expectedRevision: replaced.revision,
      expectedGeneration: replaced.generation,
      updatedAt: 19
    });
    expect(cleared).toMatchObject({
      generation: 5,
      enabled: false,
      runtimeStatus: "idle",
      ownerProviderUserId: "84"
    });
    expect(cleared.credentialReferenceId).toBeUndefined();
  });

  it("binds a Session with an explicitly validated channel-specific permission mode", () => {
    const fixture = createFixture();
    const initial = fixture.store.createMessagingConnection({
      id: "feishu-1",
      channel: "feishu",
      configuration: {},
      createdAt: 10
    });
    const route = fixture.store.putMessagingRoute({
      targetId: "target-1",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      updatedAt: 11
    });
    const configured = fixture.store.replaceMessagingCredential({
      connectionId: initial.id,
      expectedRevision: initial.revision,
      expectedGeneration: initial.generation,
      credentialReferenceId: "managed-feishu-secret",
      credentialGeneration: "1".repeat(64),
      enable: true,
      updatedAt: 12
    });
    const observed = fixture.store.ensureMessagingConversation({
      id: "feishu-group",
      connectionId: configured.id,
      expectedChannelGeneration: configured.generation,
      providerConversationId: "oc_group",
      conversationKind: "group",
      observedAt: 13
    });
    fixture.store.createSession({
      id: "feishu-group-session",
      backendId: "backend-1",
      targetId: "target-1",
      title: "Feishu group",
      binding: { opaqueRef: "service/messaging/feishu-group", generation: 0 },
      pinned: false,
      archived: false,
      permissionMode: "bypassPermissions",
      planMode: false,
      fastMode: false,
      createdAt: 14,
      updatedAt: 14
    });
    const binding = {
      conversationId: observed.id,
      expectedRevision: observed.revision,
      expectedChannelGeneration: configured.generation,
      sessionId: "feishu-group-session" as const,
      expectedSessionGeneration: 0,
      routeScopeKey: route.scopeKey,
      updatedAt: 15
    };

    expect(() => fixture.store.bindMessagingConversation(binding)).toThrow(
      "Messaging Session does not match the selected creation-time route snapshot."
    );
    const bound = fixture.store.bindMessagingConversation({
      ...binding,
      expectedPermissionMode: "bypassPermissions"
    });

    expect(bound).toMatchObject({
      status: "active",
      sessionId: "feishu-group-session",
      permissionMode: "bypassPermissions"
    });
  });

  it("claims an initially unknown owner without changing generation and can explicitly clear it", () => {
    const fixture = createFixture();
    const initial = fixture.store.createMessagingConnection({
      id: "dingtalk-1",
      channel: "dingtalk",
      configuration: { format: 1, appKey: "ding-app-key", groupActivation: {} },
      createdAt: 10
    });
    const claimed = fixture.store.claimMessagingConnectionOwner({
      connectionId: initial.id,
      expectedRevision: initial.revision,
      expectedGeneration: initial.generation,
      ownerProviderUserId: "owner-1",
      updatedAt: 11
    });

    expect(claimed).toMatchObject({ generation: 1, ownerProviderUserId: "owner-1", updatedAt: 11 });
    expect(fixture.store.claimMessagingConnectionOwner({
      connectionId: initial.id,
      expectedRevision: initial.revision,
      expectedGeneration: initial.generation,
      ownerProviderUserId: "owner-1",
      updatedAt: 12
    })).toEqual(claimed);
    expect(() => fixture.store.claimMessagingConnectionOwner({
      connectionId: initial.id,
      expectedRevision: claimed.revision,
      expectedGeneration: claimed.generation,
      ownerProviderUserId: "owner-2",
      updatedAt: 12
    })).toThrowError("Messaging connection ownership has already been claimed.");

    const replaced = fixture.store.replaceMessagingConfiguration({
      connectionId: claimed.id,
      expectedRevision: claimed.revision,
      expectedGeneration: claimed.generation,
      configuration: { format: 1, appKey: "replacement-key", groupActivation: {} },
      ownerProviderUserId: null,
      updatedAt: 13
    });
    expect(replaced).toMatchObject({ generation: 2 });
    expect(replaced.ownerProviderUserId).toBeUndefined();

    const credential = fixture.store.replaceMessagingCredential({
      connectionId: replaced.id,
      expectedRevision: replaced.revision,
      expectedGeneration: replaced.generation,
      credentialReferenceId: "managed-dingtalk-secret",
      credentialGeneration: "3".repeat(64),
      ownerProviderUserId: "owner-3",
      enable: true,
      updatedAt: 14
    });
    const cleared = fixture.store.clearMessagingCredential({
      connectionId: credential.id,
      expectedRevision: credential.revision,
      expectedGeneration: credential.generation,
      clearOwner: true,
      updatedAt: 15
    });
    expect(cleared.ownerProviderUserId).toBeUndefined();
  });

  it("retires old-generation inbound and external effects without replaying uncertain claims", () => {
    const fixture = createActiveFixture();
    const preparing = fixture.store.createMessagingInboundRequest({
      id: "generation-preparing",
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      conversationId: fixture.conversationId,
      providerRequestIds: ["telegram:update:201"],
      bodyHash: operationBodyHash({ text: "preparing" }),
      protectedContent: false,
      occurredAt: 20,
      receivedAt: 20
    }).request;
    const queuedCreation = fixture.store.createMessagingInboundRequest({
      id: "generation-queued",
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      conversationId: fixture.conversationId,
      providerRequestIds: ["telegram:update:202"],
      bodyHash: operationBodyHash({ text: "queued" }),
      protectedContent: false,
      occurredAt: 21,
      receivedAt: 21
    }).request;
    seedQueueLineage(fixture.store, fixture.sessionId, "generation-queued", "queued", 21);
    const queued = fixture.store.bindMessagingInboundAdmission({
      requestId: queuedCreation.id,
      expectedRevision: queuedCreation.revision,
      conversationId: fixture.conversationId,
      operationId: "operation-generation-queued",
      runId: "run-generation-queued",
      attemptId: "attempt-generation-queued",
      queueItemId: "queue-generation-queued",
      updatedAt: 22
    });

    const dispatchingDelivery = fixture.store.enqueueMessagingDelivery({
      id: "generation-dispatching",
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      conversationId: fixture.conversationId,
      dedupeKey: "generation:dispatching",
      kind: "text",
      partIndex: 0,
      partCount: 1,
      payloadHash: operationBodyHash({ text: "uncertain" }),
      payload: { text: "uncertain" },
      createdAt: 23
    });
    expect(fixture.store.claimNextMessagingDelivery({
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      claimToken: "generation-dispatch-claim",
      claimedAt: 24
    })?.id).toBe(dispatchingDelivery.id);
    const pendingDelivery = fixture.store.enqueueMessagingDelivery({
      id: "generation-pending",
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      conversationId: fixture.conversationId,
      dedupeKey: "generation:pending",
      kind: "text",
      partIndex: 0,
      partCount: 1,
      payloadHash: operationBodyHash({ text: "not sent" }),
      payload: { text: "not sent" },
      createdAt: 25
    });

    const pendingInteraction = fixture.store.createMessagingInteraction({
      id: "generation-interaction-pending",
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      conversationId: fixture.conversationId,
      providerRequestId: "telegram:update:203",
      providerInteractionId: "callback-pending",
      providerMessageId: "203",
      actionHash: operationBodyHash({ decision: "pending" }),
      payload: { decision: "pending" },
      expiresAt: 100,
      createdAt: 26
    });
    const claimedInteraction = fixture.store.createMessagingInteraction({
      id: "generation-interaction-claimed",
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      conversationId: fixture.conversationId,
      providerRequestId: "telegram:update:204",
      providerInteractionId: "callback-claimed",
      providerMessageId: "204",
      actionHash: operationBodyHash({ decision: "claimed" }),
      payload: { decision: "claimed" },
      expiresAt: 100,
      createdAt: 27
    });
    expect(fixture.store.claimMessagingInteraction({
      interactionId: claimedInteraction.id,
      expectedRevision: claimedInteraction.revision,
      claimToken: "generation-interaction-claim",
      claimedAt: 28
    })?.status).toBe("claimed");

    const current = fixture.store.getMessagingConnection(fixture.connectionId);
    const disabled = fixture.store.setMessagingConnectionEnabled({
      connectionId: current.id,
      expectedRevision: current.revision,
      expectedGeneration: current.generation,
      enabled: false,
      updatedAt: 29
    });
    expect(disabled).toMatchObject({
      generation: fixture.generation + 1,
      enabled: false,
      runtimeStatus: "offline"
    });
    expect(fixture.store.getMessagingInboundRequest(preparing.id).status).toBe("cancelled");
    expect(fixture.store.getMessagingInboundRequest(queued.id).status).toBe("cancelled");
    expect(fixture.store.getMessagingDelivery(pendingDelivery.id).status).toBe("cancelled");
    expect(fixture.store.getMessagingDelivery(dispatchingDelivery.id)).toMatchObject({
      status: "unknown",
      errorCode: "generation_changed"
    });
    expect(fixture.store.getMessagingInteraction(pendingInteraction.id)).toMatchObject({
      status: "expired",
      outcomeCode: "generation_changed"
    });
    expect(fixture.store.getMessagingInteraction(claimedInteraction.id)).toMatchObject({
      status: "unknown",
      outcomeCode: "generation_changed"
    });
    expect(fixture.store.getMessagingConversation(fixture.conversationId)).toMatchObject({
      status: "active",
      channelGeneration: disabled.generation
    });
    expect(fixture.store.setMessagingConnectionEnabled({
      connectionId: disabled.id,
      expectedRevision: disabled.revision,
      expectedGeneration: disabled.generation,
      enabled: false,
      updatedAt: 30
    })).toEqual(disabled);
  });

  it("deduplicates inbound requests and atomically binds the exact Session Queue lineage", () => {
    const fixture = createActiveFixture();
    const bodyHash = operationBodyHash({ text: "hello" });
    const created = fixture.store.createMessagingInboundRequest({
      id: "request-1",
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      conversationId: fixture.conversationId,
      providerRequestIds: ["telegram:update:11", "telegram:update:10"],
      providerMessageId: "5",
      bodyHash,
      protectedContent: false,
      occurredAt: 30,
      receivedAt: 31
    });
    expect(created).toMatchObject({
      created: true,
      request: {
        providerRequestIds: ["telegram:update:10", "telegram:update:11"],
        status: "preparing"
      }
    });
    expect(fixture.store.createMessagingInboundRequest({
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      conversationId: fixture.conversationId,
      providerRequestIds: ["telegram:update:10", "telegram:update:11"],
      providerMessageId: "5",
      bodyHash,
      protectedContent: false,
      occurredAt: 30,
      receivedAt: 32
    })).toMatchObject({ created: false, request: { id: "request-1" } });
    expect(() => fixture.store.createMessagingInboundRequest({
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      providerRequestIds: ["telegram:update:10"],
      bodyHash: operationBodyHash({ text: "changed" }),
      protectedContent: false,
      occurredAt: 30
    })).toThrow(/conflicts/u);

    seedQueueLineage(fixture.store, fixture.sessionId, "inbound-1", "hello", 33);
    const queue = fixture.store.getQueueItem("queue-inbound-1");
    const bound = fixture.store.bindMessagingInboundAdmission({
      requestId: "request-1",
      expectedRevision: created.request.revision,
      conversationId: fixture.conversationId,
      operationId: "operation-inbound-1",
      runId: "run-inbound-1",
      attemptId: "attempt-inbound-1",
      queueItemId: queue.id,
      updatedAt: 34
    });
    expect(bound).toMatchObject({
      status: "queued",
      operationId: "operation-inbound-1",
      runId: "run-inbound-1",
      attemptId: "attempt-inbound-1",
      queueItemId: "queue-inbound-1"
    });

    const completed = fixture.store.updateMessagingInboundRequestStatus({
      requestId: bound.id,
      expectedRevision: bound.revision,
      status: "completed",
      updatedAt: 35
    });
    expect(completed.status).toBe("completed");

    const protectedRequest = fixture.store.createMessagingInboundRequest({
      id: "protected-request",
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      conversationId: fixture.conversationId,
      providerRequestIds: ["telegram:update:12"],
      bodyHash: operationBodyHash({ protected: true }),
      protectedContent: true,
      occurredAt: 36,
      receivedAt: 36
    }).request;
    expect(() => fixture.store.attachMessagingRequestArtifact({
      requestId: protectedRequest.id,
      expectedRevision: protectedRequest.revision,
      ordinal: 0,
      artifactId: "must-not-be-looked-up"
    })).toThrow(/Protected/u);

    fixture.reopen();
    expect(fixture.store.getMessagingInboundRequest("request-1")).toMatchObject({
      status: "completed",
      queueItemId: "queue-inbound-1"
    });
    expect(fixture.store.recoverPreparingMessagingInboundRequests(40)).toBe(1);
    expect(fixture.store.getMessagingInboundRequest("protected-request")).toMatchObject({
      status: "dispatch_unknown",
      errorCode: "recovery_unknown"
    });
  });

  it("bounds group history, rejects protected retention, and never keeps credential-like text", () => {
    const fixture = createActiveFixture({ kind: "group" });
    for (let index = 1; index <= 3; index += 1) {
      fixture.store.appendMessagingGroupObservation({
        conversationId: fixture.conversationId,
        providerMessageId: String(index),
        providerUserId: "99",
        displayName: "Guest",
        isBot: false,
        text: index === 2 ? "password=hunter2" : `message ${index}`,
        attachmentNames: [],
        protectedContent: false,
        occurredAt: 40 + index,
        createdAt: 40 + index,
        maximumEntries: 2
      });
    }
    const history = fixture.store.listMessagingGroupObservations({
      conversationId: fixture.conversationId
    });
    expect(history.map((entry) => entry.providerMessageId)).toEqual(["3", "2"]);
    expect(history.map((entry) => entry.text).join("\n")).not.toContain("hunter2");
    expect(() => fixture.store.appendMessagingGroupObservation({
      conversationId: fixture.conversationId,
      providerMessageId: "4",
      providerUserId: "99",
      displayName: "Guest",
      isBot: false,
      text: "must not persist",
      attachmentNames: [],
      protectedContent: true,
      occurredAt: 44
    })).toThrow(/Protected/u);
  });

  it("claims outbound and interaction effects once and recovers uncertain effects without replay", () => {
    const fixture = createActiveFixture();
    const payload = { text: "answer" };
    const delivery = fixture.store.enqueueMessagingDelivery({
      id: "delivery-1",
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      conversationId: fixture.conversationId,
      dedupeKey: "run-1:final",
      kind: "text",
      partIndex: 0,
      partCount: 1,
      payloadHash: operationBodyHash(payload),
      payload,
      createdAt: 50
    });
    const claimed = fixture.store.claimNextMessagingDelivery({
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      claimToken: "delivery-claim-token-1",
      claimedAt: 51
    });
    expect(claimed).toMatchObject({ id: delivery.id, status: "dispatching", attempts: 1 });
    expect(fixture.store.claimNextMessagingDelivery({
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      claimToken: "delivery-claim-token-2",
      claimedAt: 51
    })).toBeUndefined();
    expect(fixture.store.recoverClaimedMessagingDeliveries(52)).toBe(1);
    expect(fixture.store.getMessagingDelivery(delivery.id)).toMatchObject({
      status: "unknown",
      errorCode: "recovery_unknown"
    });
    expect(fixture.store.claimNextMessagingDelivery({
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      claimToken: "delivery-claim-token-3",
      claimedAt: 53
    })).toBeUndefined();

    const retryPayload = { text: "retryable" };
    const retryable = fixture.store.enqueueMessagingDelivery({
      id: "delivery-2",
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      conversationId: fixture.conversationId,
      dedupeKey: "run-2:final",
      kind: "text",
      partIndex: 0,
      partCount: 1,
      payloadHash: operationBodyHash(retryPayload),
      payload: retryPayload,
      createdAt: 54
    });
    const retryClaim = fixture.store.claimNextMessagingDelivery({
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      claimToken: "delivery-claim-token-4",
      claimedAt: 55
    })!;
    const failed = fixture.store.settleMessagingDelivery({
      deliveryId: retryable.id,
      expectedRevision: retryClaim.revision,
      claimToken: retryClaim.claimToken!,
      status: "failed",
      errorCode: "rate_limited",
      settledAt: 56
    });
    const pending = fixture.store.retryMessagingDelivery({
      deliveryId: failed.id,
      expectedRevision: failed.revision,
      expectedChannelGeneration: fixture.generation,
      availableAt: 60
    });
    expect(pending.status).toBe("pending");
    const sentClaim = fixture.store.claimNextMessagingDelivery({
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      claimToken: "delivery-claim-token-5",
      claimedAt: 60
    })!;
    expect(fixture.store.settleMessagingDelivery({
      deliveryId: sentClaim.id,
      expectedRevision: sentClaim.revision,
      claimToken: sentClaim.claimToken!,
      status: "sent",
      providerMessageId: "777",
      settledAt: 61
    })).toMatchObject({ status: "sent", providerMessageId: "777", attempts: 2 });
    expect(fixture.store.findMessagingDeliveryByDedupe({
      connectionId: fixture.connectionId,
      channelGeneration: fixture.generation,
      dedupeKey: "run-2:final"
    })).toMatchObject({ id: retryable.id, status: "sent" });

    const interactionPayload = { decision: "approve" };
    const interaction = fixture.store.createMessagingInteraction({
      id: "interaction-1",
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      conversationId: fixture.conversationId,
      providerRequestId: "telegram:update:90",
      providerInteractionId: "callback-90",
      providerMessageId: "80",
      actionHash: operationBodyHash(interactionPayload),
      payload: interactionPayload,
      expiresAt: 100,
      createdAt: 70
    });
    const interactionClaim = fixture.store.claimMessagingInteraction({
      interactionId: interaction.id,
      expectedRevision: interaction.revision,
      claimToken: "interaction-claim-token",
      claimedAt: 71
    });
    expect(interactionClaim?.status).toBe("claimed");
    expect(fixture.store.recoverClaimedMessagingInteractions(72)).toBe(1);
    expect(fixture.store.getMessagingInteraction(interaction.id)).toMatchObject({
      status: "unknown",
      outcomeCode: "recovery_unknown"
    });
    expect(fixture.store.listMessagingInteractions({
      connectionId: fixture.connectionId,
      statuses: ["unknown"]
    })).toEqual([expect.objectContaining({ id: interaction.id })]);
  });

  it("persists only sealed latest conversation context with source idempotency, exact CAS, and material retirement", () => {
    const fixture = createActiveFixture({ channel: "wechat" });
    const materialGeneration = "1".repeat(64);
    const aad = messagingConversationContextAad({
      connectionId: fixture.connectionId,
      materialGeneration,
      conversationId: fixture.conversationId
    });
    const rawContextA = "private-wechat-context-a";
    const sealedA = sealMessagingContext(rawContextA, aad, 1);

    expect(() => fixture.store.transaction((store) => {
      const request = store.createMessagingInboundRequest({
        id: "context-request-a",
        connectionId: fixture.connectionId,
        expectedChannelGeneration: fixture.generation,
        conversationId: fixture.conversationId,
        providerRequestIds: ["wechat:update:a"],
        providerMessageId: "wechat-message-a",
        bodyHash: operationBodyHash({ text: "first" }),
        protectedContent: false,
        occurredAt: 20,
        receivedAt: 20
      }).request;
      store.putMessagingConversationContext({
        connectionId: fixture.connectionId,
        expectedChannelGeneration: fixture.generation,
        expectedMaterialGeneration: materialGeneration,
        conversationId: fixture.conversationId,
        sourceRequestId: request.id,
        expectedRevision: null,
        sealed: sealedA,
        updatedAt: 20
      });
      const connection = store.getMessagingConnection(fixture.connectionId);
      store.updateMessagingConnectionRuntime({
        connectionId: connection.id,
        expectedRevision: connection.revision,
        expectedGeneration: connection.generation,
        runtimeStatus: "connected",
        cursor: "cursor-rolled-back",
        updatedAt: 20
      });
      throw new Error("rollback context batch");
    })).toThrow("rollback context batch");
    expect(fixture.store.findMessagingInboundRequest("context-request-a")).toBeUndefined();
    expect(fixture.store.findMessagingConversationContext(fixture.conversationId)).toBeUndefined();
    expect(fixture.store.getMessagingConnection(fixture.connectionId).cursor).toBeUndefined();

    const first = fixture.store.transaction((store) => {
      const request = store.createMessagingInboundRequest({
        id: "context-request-a",
        connectionId: fixture.connectionId,
        expectedChannelGeneration: fixture.generation,
        conversationId: fixture.conversationId,
        providerRequestIds: ["wechat:update:a"],
        providerMessageId: "wechat-message-a",
        bodyHash: operationBodyHash({ text: "first" }),
        protectedContent: false,
        occurredAt: 20,
        receivedAt: 20
      }).request;
      const context = store.putMessagingConversationContext({
        connectionId: fixture.connectionId,
        expectedChannelGeneration: fixture.generation,
        expectedMaterialGeneration: materialGeneration,
        conversationId: fixture.conversationId,
        sourceRequestId: request.id,
        expectedRevision: null,
        sealed: sealedA,
        updatedAt: 20
      });
      const connection = store.getMessagingConnection(fixture.connectionId);
      store.updateMessagingConnectionRuntime({
        connectionId: connection.id,
        expectedRevision: connection.revision,
        expectedGeneration: connection.generation,
        runtimeStatus: "connected",
        cursor: "cursor-a",
        updatedAt: 20
      });
      return context;
    });
    expect(first).toMatchObject({
      connectionId: fixture.connectionId,
      materialGeneration,
      conversationId: fixture.conversationId,
      sourceRequestId: "context-request-a",
      sealed: sealedA
    });

    fixture.reopen();
    expect(fixture.store.getMessagingConnection(fixture.connectionId).cursor).toBe("cursor-a");
    expect(fixture.store.getMessagingConversationContext(fixture.conversationId)).toEqual(first);
    expect(readFileSync(fixture.filePath).includes(Buffer.from(rawContextA, "utf8"))).toBe(false);

    const replay = fixture.store.putMessagingConversationContext({
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      expectedMaterialGeneration: materialGeneration,
      conversationId: fixture.conversationId,
      sourceRequestId: "context-request-a",
      expectedRevision: null,
      sealed: sealMessagingContext(rawContextA, aad, 2),
      updatedAt: 21
    });
    expect(replay).toEqual(first);

    const interaction = fixture.store.createMessagingInteraction({
      id: "context-interaction-b",
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      conversationId: fixture.conversationId,
      providerRequestId: "wechat:update:b",
      providerInteractionId: "wechat:text-reply:b",
      providerMessageId: "wechat-message-b",
      actionHash: operationBodyHash({ text: "approve" }),
      payload: { text: "approve" },
      expiresAt: 1_000,
      createdAt: 22
    });
    const sealedB = sealMessagingContext("private-wechat-context-b", aad, 3);
    const second = fixture.store.putMessagingConversationContext({
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      expectedMaterialGeneration: materialGeneration,
      conversationId: fixture.conversationId,
      sourceInteractionId: interaction.id,
      expectedRevision: first.revision,
      sealed: sealedB,
      updatedAt: 22
    });
    expect(second).toMatchObject({ sourceInteractionId: interaction.id, sealed: sealedB });
    expect(second.revision).not.toBe(first.revision);

    const oldReplay = fixture.store.putMessagingConversationContext({
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      expectedMaterialGeneration: materialGeneration,
      conversationId: fixture.conversationId,
      sourceRequestId: "context-request-a",
      expectedRevision: second.revision,
      sealed: sealMessagingContext(rawContextA, aad, 4),
      updatedAt: 23
    });
    expect(oldReplay).toEqual(second);

    const requestC = fixture.store.createMessagingInboundRequest({
      id: "context-request-c",
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      conversationId: fixture.conversationId,
      providerRequestIds: ["wechat:update:c"],
      providerMessageId: "wechat-message-c",
      bodyHash: operationBodyHash({ text: "third" }),
      protectedContent: false,
      occurredAt: 24,
      receivedAt: 24
    }).request;
    expect(() => fixture.store.putMessagingConversationContext({
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      expectedMaterialGeneration: materialGeneration,
      conversationId: fixture.conversationId,
      sourceRequestId: requestC.id,
      expectedRevision: second.revision,
      sealed: { ...sealedB, ciphertext: rawContextA },
      updatedAt: 24
    })).toThrow(/envelope|ciphertext/u);
    expect(() => fixture.store.putMessagingConversationContext({
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      expectedMaterialGeneration: materialGeneration,
      conversationId: fixture.conversationId,
      sourceRequestId: requestC.id,
      expectedRevision: first.revision,
      sealed: sealMessagingContext("private-wechat-context-c", aad, 5),
      updatedAt: 24
    })).toThrow(/revision/u);
    expect(fixture.store.getMessagingConversationContext(fixture.conversationId)).toEqual(second);
    expect(readFileSync(fixture.filePath).includes(Buffer.from("private-wechat-context-b", "utf8"))).toBe(false);

    const otherConversation = fixture.store.ensureMessagingConversation({
      id: "another-wechat-peer",
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      providerConversationId: "other-wechat-peer",
      conversationKind: "direct",
      observedAt: 24
    });
    const wrongSource = fixture.store.createMessagingInboundRequest({
      id: "other-peer-request",
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      conversationId: otherConversation.id,
      providerRequestIds: ["wechat:update:other-peer"],
      providerMessageId: "wechat-message-other-peer",
      bodyHash: operationBodyHash({ text: "wrong peer" }),
      protectedContent: false,
      occurredAt: 24,
      receivedAt: 24
    }).request;
    expect(() => fixture.store.putMessagingConversationContext({
      connectionId: fixture.connectionId,
      expectedChannelGeneration: fixture.generation,
      expectedMaterialGeneration: materialGeneration,
      conversationId: fixture.conversationId,
      sourceRequestId: wrongSource.id,
      expectedRevision: second.revision,
      sealed: sealMessagingContext("wrong-peer-context", aad, 7),
      updatedAt: 24
    })).toThrow(/request authority/u);
    expect(fixture.store.getMessagingConversationContext(fixture.conversationId)).toEqual(second);

    const current = fixture.store.getMessagingConnection(fixture.connectionId);
    const rebound = fixture.store.replaceMessagingCredential({
      connectionId: current.id,
      expectedRevision: current.revision,
      expectedGeneration: current.generation,
      credentialReferenceId: "managed-credential-ref-2",
      credentialGeneration: "2".repeat(64),
      enable: true,
      updatedAt: 25
    });
    expect(fixture.store.findMessagingConversationContext(fixture.conversationId)).toBeUndefined();

    const nextConversation = fixture.store.ensureMessagingConversation({
      id: "active-conversation-after-rebind",
      connectionId: rebound.id,
      expectedChannelGeneration: rebound.generation,
      providerConversationId: "wechat-peer",
      conversationKind: "direct",
      observedAt: 26
    });
    const requestAfterRebind = fixture.store.createMessagingInboundRequest({
      id: "context-request-after-rebind",
      connectionId: rebound.id,
      expectedChannelGeneration: rebound.generation,
      conversationId: nextConversation.id,
      providerRequestIds: ["wechat:update:after-rebind"],
      providerMessageId: "wechat-message-after-rebind",
      bodyHash: operationBodyHash({ text: "after rebind" }),
      protectedContent: false,
      occurredAt: 26,
      receivedAt: 26
    }).request;
    const nextMaterialGeneration = "2".repeat(64);
    fixture.store.putMessagingConversationContext({
      connectionId: rebound.id,
      expectedChannelGeneration: rebound.generation,
      expectedMaterialGeneration: nextMaterialGeneration,
      conversationId: nextConversation.id,
      sourceRequestId: requestAfterRebind.id,
      expectedRevision: null,
      sealed: sealMessagingContext("private-wechat-context-after-rebind", messagingConversationContextAad({
        connectionId: rebound.id,
        materialGeneration: nextMaterialGeneration,
        conversationId: nextConversation.id
      }), 6),
      updatedAt: 26
    });
    const latest = fixture.store.getMessagingConnection(rebound.id);
    fixture.store.clearMessagingCredential({
      connectionId: latest.id,
      expectedRevision: latest.revision,
      expectedGeneration: latest.generation,
      clearOwner: true,
      updatedAt: 27
    });
    expect(fixture.store.findMessagingConversationContext(nextConversation.id)).toBeUndefined();
  });
});

function createFixture(): {
  readonly filePath: string;
  readonly store: OperationalStore;
  reopen(): void;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-messaging-store-"));
  const filePath = path.join(directory, "operational.sqlite");
  let nextId = 0;
  let store = new OperationalStore(filePath, { idFactory: () => `generated-${++nextId}` });
  seedBackend(store);
  const fixture = {
    filePath,
    get store() { return store; },
    reopen() {
      store.close();
      store = new OperationalStore(filePath, { idFactory: () => `generated-${++nextId}` });
    }
  };
  cleanups.push(() => {
    try {
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return fixture;
}

function createActiveFixture(options: {
  readonly kind?: "direct" | "group";
  readonly channel?: "telegram" | "wechat";
} = {}): {
  readonly filePath: string;
  readonly store: OperationalStore;
  readonly connectionId: string;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly generation: number;
  reopen(): void;
} {
  const fixture = createFixture();
  const initial = fixture.store.createMessagingConnection({
    id: "telegram-active",
    channel: options.channel ?? "telegram",
    ownerProviderUserId: "42",
    configuration: options.channel === "wechat" ? { format: 1 } : {},
    createdAt: 10
  });
  fixture.store.putMessagingRoute({
    targetId: "target-1",
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: 11
  });
  const configured = fixture.store.replaceMessagingCredential({
    connectionId: initial.id,
    expectedRevision: initial.revision,
    expectedGeneration: initial.generation,
    credentialReferenceId: "managed-credential-ref",
    credentialGeneration: "1".repeat(64),
    enable: true,
    updatedAt: 12
  });
  const conversation = fixture.store.ensureMessagingConversation({
    id: "active-conversation",
    connectionId: configured.id,
    expectedChannelGeneration: configured.generation,
    providerConversationId: options.kind === "group" ? "-100" : "42",
    conversationKind: options.kind ?? "direct",
    observedAt: 13
  });
  fixture.store.createSession({
    id: "active-messaging-session",
    backendId: "backend-1",
    targetId: "target-1",
    title: "Messaging",
    binding: { opaqueRef: "service/messaging/active", generation: 0 },
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    createdAt: 14,
    updatedAt: 14
  });
  fixture.store.bindMessagingConversation({
    conversationId: conversation.id,
    expectedRevision: conversation.revision,
    expectedChannelGeneration: configured.generation,
    sessionId: "active-messaging-session",
    expectedSessionGeneration: 0,
    routeScopeKey: "global",
    updatedAt: 15
  });
  const connected = fixture.store.updateMessagingConnectionRuntime({
    connectionId: configured.id,
    expectedRevision: configured.revision,
    expectedGeneration: configured.generation,
    runtimeStatus: "connected",
    providerAccountId: "700",
    providerUsername: "jokobot",
    connectedAt: 16,
    updatedAt: 16
  });
  return {
    filePath: fixture.filePath,
    get store() { return fixture.store; },
    reopen: () => fixture.reopen(),
    connectionId: connected.id,
    conversationId: conversation.id,
    sessionId: "active-messaging-session",
    generation: connected.generation
  };
}

function sealMessagingContext(value: string, aad: string, nonceByte: number) {
  const nonce = Buffer.alloc(12, nonceByte);
  const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 7), nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm" as const,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  };
}

function seedBackend(store: OperationalStore): void {
  store.upsertBackend({
    id: "backend-1",
    adapterKind: "fixture",
    instanceGeneration: 0,
    displayName: "Fixture",
    version: "test",
    health: "healthy",
    installationState: "installed",
    authenticationState: "not_required",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  store.upsertTarget({
    id: "target-1",
    backendId: "backend-1",
    displayName: "Workspace",
    workspaceRoot: "D:/workspace",
    managed: false,
    trusted: true
  });
}

function seedQueueLineage(
  store: OperationalStore,
  sessionId: string,
  suffix: string,
  text: string,
  at: number
): void {
  const operationId = `operation-${suffix}`;
  const runId = `run-${suffix}`;
  const attemptId = `attempt-${suffix}`;
  const queueItemId = `queue-${suffix}`;
  store.claimDeferredEffectOperation({ id: operationId, kind: "messaging_test", body: { text } });
  store.createRun({ id: runId, sessionId, source: "system", state: "queued", createdAt: at }, { operationId });
  store.createAttempt({ id: attemptId, runId, ordinal: 1, generation: 0, startedAt: at });
  const body = {
    text,
    images: [] as const,
    files: [] as const,
    mentions: [] as const,
    disposition: "prompt" as const
  };
  store.enqueueQueueItem({
    id: queueItemId,
    sessionId,
    runId,
    attemptId,
    operationId,
    disposition: "prompt",
    body,
    bodyHash: operationBodyHash(body),
    createdAt: at
  });
}
