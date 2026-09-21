import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  PartnerInitializationState,
  PartnerInvitationStage,
  PartnerLifecycle,
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

    const methods = ["getPartnerDirectory", "listPartners", "getPartner", "createPartner", "updatePartner", "setPartnerLifecycle", "retryPartnerInitialization", "updatePartnerDefaults"];
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
    usesDirectoryDefaults: true
  };
}
function response(method: any, message: any, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}
async function* idleStream(): AsyncIterable<never> { await new Promise<never>(() => undefined); }
