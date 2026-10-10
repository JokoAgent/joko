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
import * as contract from "@joko/contracts";

describe("Partner gateway", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses generated workbench RPCs and rejects stale owners, revisions, details and unknown states", async () => {
    const owner = { partnerId: "partner-one", profileVersion: 2n, sessionId: "session-one", sessionGeneration: 1n, targetId: "home-one" };
    let mismatch: "owner" | "revision" | "task" | "state" | undefined;
    const task = () => ({ id: mismatch === "task" ? "task:other" : "task:one", kind: contract.PartnerWorkbenchTaskKind.SESSION, project: "D:/project", title: "Draft",
      state: mismatch === "state" ? contract.PartnerWorkbenchTaskState.UNSPECIFIED : contract.PartnerWorkbenchTaskState.STOPPED, group: contract.PartnerWorkbenchGroup.WAITING, updatedAt: timestamp(3n), sourceLabel: "Task" });
    const workbench = () => ({ owner: { ...owner, profileVersion: mismatch === "owner" ? 3n : owner.profileVersion }, revision: revision(mismatch === "revision" ? 1n : 2n), tasks: [task()], projects: [{ path: "D:/project", name: "project", exists: true }] });
    const requests: Array<{ method: string; input: any; signal?: AbortSignal }> = [];
    const gateway = connectedGateway(partnerTransport((method) => {
      if (method === "getPartnerWorkbenchDetail") return { detail: { task: task(), transcript: [{ role: "assistant", text: "Private reply", privateMessageOrigin: { messageId: "message", threadId: "thread", senderPartnerId: "sender", recipientPartnerId: owner.partnerId, senderDisplayName: "Sender" } }] } };
      if (method === "resolvePartnerWorkbenchReference") return { kind: "file", value: "D:/project/README.md", workspaceId: "read-only", relativePath: "README.md" };
      if (method === "readPartnerWorkbenchDocument") return { path: "D:/project/README.md", text: "Context" };
      if (method.includes("Workbench")) return { workbench: workbench(), acceptedProject: "D:/project" };
      return partnerResponse(method);
    }, requests));
    await gateway.connect();
    expect((await gateway.getPartnerWorkbench(owner.partnerId)).tasks[0]).toMatchObject({ state: "stopped", group: "waiting" });
    expect(await gateway.addPartnerWorkbenchProject(owner, 1n, "D:/project")).toMatchObject({ acceptedProject: "D:/project" });
    await gateway.removePartnerWorkbenchProject(owner, 1n, "D:/project");
    await gateway.setPartnerWorkbenchJudgment(owner, 1n, { taskId: "task:one", project: "D:/project", title: "Draft", verdict: "unfinished", next: "Finish" });
    expect((await gateway.getPartnerWorkbenchDetail(owner, "task:one")).transcript[0]?.privateMessageOrigin).toMatchObject({ threadId: "thread", senderDisplayName: "Sender" });
    expect(await gateway.resolvePartnerWorkbenchReference(owner, "D:/project/README.md")).toMatchObject({ workspaceId: "read-only" });
    expect(await gateway.readPartnerWorkbenchDocument(owner, "D:/project/README.md")).toMatchObject({ text: "Context" });
    expect(requests.filter((request) => request.method.includes("Workbench")).map((request) => request.method)).toEqual(["getPartnerWorkbench", "addPartnerWorkbenchProject", "removePartnerWorkbenchProject", "setPartnerWorkbenchJudgment", "getPartnerWorkbenchDetail", "resolvePartnerWorkbenchReference", "readPartnerWorkbenchDocument"]);
    mismatch = "owner"; await expect(gateway.addPartnerWorkbenchProject(owner, 1n, "D:/project")).rejects.toThrow();
    mismatch = "revision"; await expect(gateway.removePartnerWorkbenchProject(owner, 2n, "D:/project")).rejects.toThrow();
    mismatch = "task"; await expect(gateway.getPartnerWorkbenchDetail(owner, "task:one")).rejects.toThrow();
    mismatch = "state"; await expect(gateway.getPartnerWorkbench(owner.partnerId)).rejects.toThrow();
    gateway.disconnect();
  });

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
    }, "creation-request-gateway", signal);
    await expect(gateway.getPartnerCreation("creation-request-gateway", signal)).resolves.toMatchObject({ partner: { id: "partner-one" } });
    await expect(gateway.retirePartnerCreation("creation-request-gateway", signal)).resolves.toMatchObject({ partner: { id: "partner-one" } });
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
      "getPartnerDirectory", "listPartners", "getPartner", "createPartner", "getPartnerCreation", "retirePartnerCreation", "updatePartner",
      "setPartnerLifecycle", "retryPartnerInitialization", "updatePartnerDefaults",
      "listPartnerSessions", "markPartnerRead", "listPartnerPrivateThreads", "getPartnerPrivateThread",
      "markPartnerPrivateThreadRead", "listPartnerDelegations", "getPartnerDelegation", "cancelPartnerDelegation"
    ];
    expect(requests.filter((entry) => methods.includes(entry.method)).map((entry) => entry.method)).toEqual(methods);
    expect(requests.find((entry) => entry.method === "listPartners")?.input).toEqual({ lifecycle: PartnerLifecycle.ACTIVE });
    expect(requests.find((entry) => entry.method === "createPartner")?.input).toMatchObject({
      requestId: "creation-request-gateway",
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

  it("rejects inconsistent creation retirement receipts and retires late lookup results on disconnect", async () => {
    let mode: "inconsistent" | "absent" | "late" = "inconsistent";
    let release!: (value: ReturnType<typeof partnerResponse>) => void;
    const pending = new Promise<ReturnType<typeof partnerResponse>>((resolve) => { release = resolve; });
    const gateway = connectedGateway(partnerTransport((method) => {
      if (method === "retirePartnerCreation") return { retired: true, directory: directory(), ...(mode === "inconsistent" ? { partner: profile() } : {}) };
      if (method === "getPartnerCreation" && mode === "late") return pending;
      return partnerResponse(method);
    }));
    await gateway.connect();
    await expect(gateway.retirePartnerCreation("creation-request-gateway")).rejects.toThrow(/inconsistent/iu);
    mode = "absent";
    await expect(gateway.retirePartnerCreation("creation-request-gateway")).resolves.toMatchObject({ directory: { revision: 4n } });
    mode = "late";
    const lookup = gateway.getPartnerCreation("creation-request-gateway");
    const assertion = expect(lookup).rejects.toThrow();
    gateway.disconnect();
    release(partnerResponse("getPartnerCreation"));
    await assertion;
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
  value: (method: string) => object | Promise<object>,
  requests: Array<{ readonly method: string; readonly input: any; readonly signal?: AbortSignal }> = []
): Transport {
  return {
    unary: vi.fn(async (method: any, signal: AbortSignal | undefined, _timeout: unknown, _headers: unknown, input: any) => {
      requests.push({ method: method.localName, input, signal });
      return response(method, create(method.output, await value(method.localName)));
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function partnerResponse(method: string): object {
  if (method === "getSnapshot") return { snapshot: {} };
  if (method === "getPartnerDirectory") return { directory: directory() };
  if (method === "listPartners") return { partners: [profile()], directory: directory() };
  if (method === "getPartner") return { partner: profile() };
  if (method === "retirePartnerCreation") return { retired: false, partner: profile(), directory: directory() };
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
  if (["createPartner", "getPartnerCreation", "updatePartner", "setPartnerLifecycle", "retryPartnerInitialization"].includes(method)) {
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
