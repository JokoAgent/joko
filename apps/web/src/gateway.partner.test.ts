import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  PartnerDelegationStatus,
  PartnerInitializationState,
  PartnerInvitationStage,
  PartnerLifecycle,
  PartnerPrivateMessageDeliveryStatus,
  PartnerPrivateThreadCloseReason,
  PartnerPrivateThreadStatus,
  PartnerSessionRole,
  PermissionMode
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway } from "./gateway.js";

describe("Partner gateway", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses every generated Partner RPC and preserves revisions, inheritance, and model axes", async () => {
    const requests: Array<{ readonly method: string; readonly input: any; readonly signal?: AbortSignal }> = [];
    const transport = partnerTransport((method) => partnerResponse(method), requests);
    const gateway = connectedGateway(transport);
    await gateway.connect();
    const signal = new AbortController().signal;

    await expect(gateway.getPartnerDirectory(signal)).resolves.toMatchObject({
      revision: 4n,
      activeCount: 1,
      defaultCapabilities: { permissionMode: "ask", modelChain: [{ modelId: "model-1", effort: "medium" }] }
    });
    await expect(gateway.listPartners("active", signal)).resolves.toMatchObject({
      partners: [{ id: "partner-one", lifecycle: "active", initializationState: "ready", canonicalSessionId: "session-one" }]
    });
    await expect(gateway.getPartner("partner-one", signal)).resolves.toMatchObject({ id: "partner-one", profileVersion: 2n });
    await gateway.createPartner(4n, {
      displayName: "Aster",
      avatar: "orbit",
      identitySource: "You are Aster.",
      templateId: "general",
      usesDirectoryDefaults: true
    }, signal);
    await gateway.updatePartner("partner-one", 8n, {
      displayName: "Aster Prime",
      modelChain: [{ backendId: "backend-1", providerId: "provider-1", modelId: "model-2", effort: "high", fastMode: true }],
      permissionMode: "auto",
      planMode: true,
      usesDirectoryDefaults: false
    }, signal);
    await gateway.setPartnerLifecycle("partner-one", 8n, "archived", signal);
    await gateway.retryPartnerInitialization("partner-one", 8n, signal);
    await gateway.updatePartnerDefaults(4n, {
      modelChain: [{ backendId: "backend-1", providerId: "provider-1", modelId: "model-1", effort: "medium", fastMode: false }],
      permissionMode: "ask",
      planMode: false
    }, signal);
    await expect(gateway.listPartnerSessions("partner-one", signal)).resolves.toEqual([
      expect.objectContaining({ sessionId: "session-one", role: "canonical", readOnly: false })
    ]);
    await expect(gateway.markPartnerRead("partner-one", 12n, signal)).resolves.toMatchObject({
      readThroughCursor: 12n,
      unreadReplyCount: 0
    });
    await expect(gateway.listPartnerPrivateThreads("partner-one", signal)).resolves.toEqual([
      expect.objectContaining({ id: "thread-one", status: "closed", closeReason: "messageLimit" })
    ]);
    await expect(gateway.getPartnerPrivateThread("partner-one", "thread-one", signal)).resolves.toMatchObject({
      thread: { id: "thread-one" },
      messages: [{ id: "message-one", deliveryStatus: "delivered" }]
    });
    await expect(gateway.markPartnerPrivateThreadRead("partner-one", "thread-one", 1, signal))
      .resolves.toMatchObject({ throughSequence: 1 });
    await expect(gateway.listPartnerDelegations("partner-one", signal)).resolves.toEqual([
      expect.objectContaining({ id: "delegation-one", status: "running" })
    ]);
    await expect(gateway.getPartnerDelegation("partner-one", "delegation-one", signal))
      .resolves.toMatchObject({ id: "delegation-one", childSessionId: "session-child" });
    await expect(gateway.cancelPartnerDelegation("partner-one", "delegation-one", 3n, signal))
      .resolves.toMatchObject({ id: "delegation-one" });

    const methods = [
      "getPartnerDirectory", "listPartners", "getPartner", "createPartner", "updatePartner",
      "setPartnerLifecycle", "retryPartnerInitialization", "updatePartnerDefaults",
      "listPartnerSessions", "markPartnerRead", "listPartnerPrivateThreads", "getPartnerPrivateThread",
      "markPartnerPrivateThreadRead", "listPartnerDelegations", "getPartnerDelegation", "cancelPartnerDelegation"
    ];
    expect(requests.filter((entry) => methods.includes(entry.method)).map((entry) => entry.method)).toEqual(methods);
    expect(requests.find((entry) => entry.method === "listPartners")?.input).toEqual({ lifecycle: PartnerLifecycle.ACTIVE });
    expect(requests.find((entry) => entry.method === "createPartner")?.input).toMatchObject({
      expectedDirectoryRevision: { value: 4n },
      draft: { displayName: "Aster", usesDirectoryDefaults: true }
    });
    expect(requests.find((entry) => entry.method === "createPartner")?.input.draft.capabilities).toBeUndefined();
    expect(requests.find((entry) => entry.method === "updatePartner")?.input).toMatchObject({
      partnerId: "partner-one",
      expectedRevision: { value: 8n },
      patch: {
        displayName: "Aster Prime",
        modelChain: { routes: [{ modelId: "model-2", effort: "high", fastMode: true }] },
        permissionMode: PermissionMode.AUTO,
        planMode: true,
        usesDirectoryDefaults: false
      }
    });
    expect(requests.find((entry) => entry.method === "setPartnerLifecycle")?.input.lifecycle).toBe(PartnerLifecycle.ARCHIVED);
    expect(requests.filter((entry) => methods.includes(entry.method)).every((entry) => entry.signal instanceof AbortSignal && !entry.signal.aborted)).toBe(true);
    gateway.disconnect();
  });

  it("fails closed for unknown enums and duplicate model-chain identities", async () => {
    let profileValue = profile();
    const transport = partnerTransport((method) => {
      if (method === "listPartners") return { partners: [profileValue], directory: directory() };
      return partnerResponse(method);
    });
    const gateway = connectedGateway(transport);
    await gateway.connect();

    profileValue = { ...profile(), lifecycle: PartnerLifecycle.UNSPECIFIED };
    await expect(gateway.listPartners()).rejects.toThrow(/unknown Partner lifecycle/iu);
    profileValue = {
      ...profile(),
      capabilities: {
        ...capabilities(),
        modelChain: [capabilities().modelChain[0]!, capabilities().modelChain[0]!]
      }
    };
    await expect(gateway.listPartners()).rejects.toThrow(/inconsistent Partner model chain/iu);
    profileValue = { ...profile(), canonicalSessionId: "" };
    await expect(gateway.listPartners()).rejects.toThrow(/incomplete Partner profile/iu);
    gateway.disconnect();
  });

  it("fails closed when private-thread or delegation ownership drifts", async () => {
    let mode: "thread" | "delegation" | "state" = "thread";
    const transport = partnerTransport((method) => {
      if (method === "getPartnerPrivateThread" && mode === "thread") {
        return {
          thread: privateThread(),
          messages: [{ ...privateMessage(), senderPartnerId: "partner-other" }],
          readState: privateReadState()
        };
      }
      if (method === "listPartnerDelegations" && mode === "delegation") {
        return { delegations: [{ ...delegation(), requesterPartnerId: "partner-other" }] };
      }
      if (method === "getPartnerDelegation" && mode === "state") {
        return {
          delegation: {
            ...delegation(),
            status: PartnerDelegationStatus.COMPLETED,
            completedAt: timestamp(6n)
          }
        };
      }
      return partnerResponse(method);
    });
    const gateway = connectedGateway(transport);
    await gateway.connect();

    await expect(gateway.getPartnerPrivateThread("partner-one", "thread-one"))
      .rejects.toThrow(/mismatched Partner private thread/iu);
    mode = "delegation";
    await expect(gateway.listPartnerDelegations("partner-one"))
      .rejects.toThrow(/owned by another Partner/iu);
    mode = "state";
    await expect(gateway.getPartnerDelegation("partner-one", "delegation-one"))
      .rejects.toThrow(/inconsistent Partner delegation/iu);
    gateway.disconnect();
  });
});

function connectedGateway(transport: Transport) {
  return createOrchestratorGateway(
    { id: "profile", deviceId: "device", name: "Node", origin: "https://service.example", serverId: "node" },
    "fixture-auth",
    {},
    () => transport
  );
}

function partnerTransport(
  value: (method: string) => object,
  requests: Array<{ readonly method: string; readonly input: any; readonly signal?: AbortSignal }> = []
): Transport {
  return {
    unary: vi.fn(async (method: any, signal: AbortSignal | undefined, _timeout: unknown, _headers: unknown, input: any) => {
      requests.push({ method: method.localName, input, signal });
      return response(method, create(method.output, value(method.localName)));
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function partnerResponse(method: string): object {
  if (method === "getSnapshot") return { snapshot: {} };
  if (method === "getPartnerDirectory") return { directory: directory() };
  if (method === "listPartners") return { partners: [profile()], directory: directory() };
  if (method === "getPartner") return { partner: profile() };
  if (method === "updatePartnerDefaults") return { directory: directory(), affectedPartners: [profile()] };
  if (method === "listPartnerSessions") return { sessions: [partnerSession()] };
  if (method === "markPartnerRead") return { activity: activity(12n, 0n) };
  if (method === "listPartnerPrivateThreads") return { threads: [privateThread()] };
  if (method === "getPartnerPrivateThread") {
    return { thread: privateThread(), messages: [privateMessage()], readState: privateReadState() };
  }
  if (method === "markPartnerPrivateThreadRead") return { readState: privateReadState() };
  if (method === "listPartnerDelegations") return { delegations: [delegation()] };
  if (method === "getPartnerDelegation" || method === "cancelPartnerDelegation") return { delegation: delegation() };
  if (["createPartner", "updatePartner", "setPartnerLifecycle", "retryPartnerInitialization"].includes(method)) {
    return { partner: profile(), directory: directory() };
  }
  throw new Error(`Unexpected RPC ${method}`);
}

function revision(value: bigint) { return { value }; }
function timestamp(seconds: bigint) { return { seconds, nanos: 0 }; }
function capabilities() {
  return {
    modelChain: [{ backendId: "backend-1", providerId: "provider-1", modelId: "model-1", effort: "medium", fastMode: false }],
    permissionMode: PermissionMode.ASK,
    planMode: false
  };
}
function directory() {
  return {
    revision: revision(4n),
    activeCount: 1,
    archivedCount: 0,
    errorCount: 0,
    updatedAt: timestamp(4n),
    templates: [{ templateId: "general", displayName: "General", description: "Everyday work", identitySource: "You are a partner." }],
    avatarPresets: ["orbit", "spark"],
    defaultCapabilities: capabilities()
  };
}
function profile() {
  return {
    partnerId: "partner-one",
    revision: revision(8n),
    profileVersion: 2n,
    displayName: "Aster",
    avatar: "orbit",
    identitySource: "You are Aster.",
    templateId: "general",
    lifecycle: PartnerLifecycle.ACTIVE,
    initializationState: PartnerInitializationState.READY,
    invitationStage: PartnerInvitationStage.READY,
    homeTargetId: "partner-home-one",
    canonicalSessionId: "session-one",
    capabilities: capabilities(),
    createdAt: timestamp(1n),
    updatedAt: timestamp(3n),
    usesDirectoryDefaults: true,
    activity: activity(4n, 2n)
  };
}
function activity(readThrough = 4n, unread = 2n) {
  return {
    partnerId: "partner-one",
    unreadReplyCount: unread,
    latestReplyCursor: revision(12n),
    latestReplyAt: timestamp(6n),
    artifactCount: 3n,
    activeDelegationCount: 1n,
    readThroughCursor: revision(readThrough),
    readUpdatedAt: timestamp(5n)
  };
}
function partnerSession() {
  return {
    sessionId: "session-one",
    partnerId: "partner-one",
    role: PartnerSessionRole.CANONICAL,
    profileVersion: 2n,
    displayName: "Aster",
    available: true,
    readOnly: false,
    archived: false,
    deleted: false,
    createdAt: timestamp(1n),
    lastActivityAt: timestamp(6n)
  };
}
function privateThread() {
  return {
    threadId: "thread-one",
    firstPartnerId: "partner-one",
    secondPartnerId: "partner-two",
    status: PartnerPrivateThreadStatus.CLOSED,
    closeReason: PartnerPrivateThreadCloseReason.MESSAGE_LIMIT,
    messageCount: 1,
    maxMessages: 12,
    expiresAt: timestamp(20n),
    blockedUntil: timestamp(20n),
    createdAt: timestamp(2n),
    updatedAt: timestamp(3n),
    closedAt: timestamp(3n)
  };
}
function privateMessage() {
  return {
    messageId: "message-one",
    threadId: "thread-one",
    sequence: 1n,
    senderPartnerId: "partner-one",
    recipientPartnerId: "partner-two",
    content: "Please inspect the boundary.",
    deliveryStatus: PartnerPrivateMessageDeliveryStatus.DELIVERED,
    createdAt: timestamp(2n),
    deliveredAt: timestamp(2n)
  };
}
function privateReadState() {
  return {
    threadId: "thread-one",
    partnerId: "partner-one",
    throughSequence: 1n,
    updatedAt: timestamp(4n)
  };
}
function delegation() {
  return {
    delegationId: "delegation-one",
    revision: revision(3n),
    requesterPartnerId: "partner-one",
    targetPartnerId: "partner-two",
    parentSessionId: "session-one",
    targetProfileVersion: 2n,
    title: "Inspect retry safety",
    objective: "Inspect the retry boundary.",
    status: PartnerDelegationStatus.RUNNING,
    childSessionId: "session-child",
    runId: "run-child",
    artifactCount: 2n,
    createdAt: timestamp(4n),
    updatedAt: timestamp(5n),
    startedAt: timestamp(5n)
  };
}
function response(method: any, message: any, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}
async function* idleStream(): AsyncIterable<never> { await new Promise<never>(() => undefined); }
