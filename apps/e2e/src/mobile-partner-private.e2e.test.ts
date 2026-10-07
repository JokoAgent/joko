import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
  PartnerCapabilitiesSchema, PartnerDraftSchema, PartnerModelRouteSchema,
  PermissionMode, RunState
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { waitFor } from "./fixture.js";
import { queueRunIdFrom, sendInputMutation, submit } from "./operations.js";
import {
  REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture,
  type CapturedProviderRequest, type RealPiProviderResponder
} from "./real-pi-fixture.js";

const SEND_COMMAND = "PARTNER_MOBILE_PRIVATE_SEND";
const MESSAGE = "Please verify the mobile private read boundary.";

interface MobileCredential {
  readonly origin: string;
  readonly authKey: string;
  readonly connectionId: string;
  readonly deviceId: string;
}

interface MobilePartnerNetwork {
  requestPairing(origin: string, deviceName: string, platform: string, deviceNameSource: { defaultDisplayName: string }): Promise<{ challengeId: string }>;
  completePairing(origin: string, challengeId: string, code: string, deviceName: string, platform: string, deviceNameSource: { defaultDisplayName: string }):
    Promise<{ credential: MobileCredential }>;
  readOwner(credential: MobileCredential): Promise<{ connection: { connectionId: string }; device: { deviceId: string } }>;
  listPartners(credential: MobileCredential): Promise<readonly {
    partnerId: string; displayName: string; canonicalSessionId?: string
  }[]>;
  listPartnerPrivateThreads(credential: MobileCredential, partnerId: string): Promise<readonly {
    threadId: string; firstPartnerId: string; secondPartnerId: string;
    otherPartnerId: string; messageCount: number; maxMessages: number
  }[]>;
  getPartnerPrivateThread(credential: MobileCredential, partnerId: string, threadId: string): Promise<{
    thread: { threadId: string; otherPartnerId: string };
    messages: readonly { content: string; sequence: number }[];
    readState?: { throughSequence: number };
  }>;
  markPartnerPrivateThreadRead(credential: MobileCredential, partnerId: string, threadId: string,
    throughSequence: number, maximumSequence: number): Promise<{
      threadId: string; partnerId: string; throughSequence: number
    }>;
}

const { mobileNetwork } = await vi.importActual<{ mobileNetwork: MobilePartnerNetwork }>("../../mobile/src/network.js");

describe("mobile Partner private HTTP product chain", () => {
  let fixture: RealPiSystemFixture | undefined;

  afterEach(async () => {
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
  });

  it("reads a durable Partner thread through a paired mobile Device and persists its visible read position", async () => {
    let targetPartnerId = "";
    const responder: RealPiProviderResponder = ({ request, requestNumber }) => {
      if (JSON.stringify(request.body).includes("You are a permission reviewer for one tool call")) {
        return { kind: "text", text: JSON.stringify({ verdict: "allow", reason: "The scoped local Partner call is required." }) };
      }
      const messages = Array.isArray(request.body["messages"]) ? request.body["messages"] : [];
      const last = messages.at(-1);
      if (asRecord(last)?.["role"] === "tool") {
        return { kind: "text", text: `Private tool settled ${requestNumber}` };
      }
      const userText = [...messages].reverse().map(asRecord)
        .find((message) => message?.["role"] === "user")?.["content"];
      if (JSON.stringify(userText).includes(SEND_COMMAND)) {
        return {
          kind: "tool",
          name: requiredPrivateToolName(request),
          arguments: { target_partner_id: targetPartnerId, message: MESSAGE },
          callId: `mobile-private-${requestNumber}`
        };
      }
      return { kind: "text", text: `Private task observed ${requestNumber}` };
    };
    fixture = await RealPiSystemFixture.start({ providerResponder: responder, enableInternalServer: true });
    const manager = await fixture.pair("Partner manager");
    const first = await createPartner(fixture, manager, "Aster", "orbit");
    const second = await createPartner(fixture, manager, "Beryl", "spark");
    targetPartnerId = second.partnerId;

    const deviceNameSource = { defaultDisplayName: "Fixture partner phone" };
    const begun = await mobileNetwork.requestPairing(fixture.baseUrl, "Partner phone", "android", deviceNameSource);
    const { credential } = await mobileNetwork.completePairing(
      fixture.baseUrl, begun.challengeId, fixture.pairingCode(begun.challengeId), "Partner phone", "android", deviceNameSource
    );
    const owner = await mobileNetwork.readOwner(credential);
    expect(owner.connection.connectionId).toBe(credential.connectionId);
    expect(owner.device.deviceId).toBe(credential.deviceId);
    const partners = await mobileNetwork.listPartners(credential);
    expect(partners).toEqual(expect.arrayContaining([
      expect.objectContaining({ partnerId: first.partnerId, displayName: "Aster", canonicalSessionId: first.canonicalSessionId }),
      expect.objectContaining({ partnerId: second.partnerId, displayName: "Beryl", canonicalSessionId: second.canonicalSessionId })
    ]));

    const generation = BigInt(fixture.application.store.getSession(first.canonicalSessionId).descriptor.binding.generation);
    const submitted = await submit(manager.clients.operation, manager.connectionId,
      sendInputMutation(first.canonicalSessionId, generation, SEND_COMMAND));
    const runId = queueRunIdFrom(submitted);
    const settled = await waitFor(() => manager.clients.run.getRun({ runId }),
      (value) => value.run?.state === RunState.SUCCEEDED || value.run?.state === RunState.FAILED,
      "the private-message tool run", 30_000).catch((error: unknown) => {
      const providerTrace = fixture!.providerRequests.map((request) => ({
        roles: (Array.isArray(request.body["messages"]) ? request.body["messages"] : [])
          .map((message) => asRecord(message)?.["role"]),
        tools: (Array.isArray(request.body["tools"]) ? request.body["tools"] : [])
          .map((tool) => asRecord(asRecord(tool)?.["function"])?.["name"])
      }));
      throw new Error(`${error instanceof Error ? error.message : String(error)} Provider trace: ${JSON.stringify(providerTrace)}`,
        { cause: error });
    });
    expect(settled.run?.state).toBe(RunState.SUCCEEDED);

    const threads = await mobileNetwork.listPartnerPrivateThreads(credential, second.partnerId);
    expect(threads).toEqual([expect.objectContaining({
      firstPartnerId: first.partnerId < second.partnerId ? first.partnerId : second.partnerId,
      secondPartnerId: first.partnerId < second.partnerId ? second.partnerId : first.partnerId,
      otherPartnerId: first.partnerId, messageCount: 1, maxMessages: 12
    })]);
    const threadId = threads[0]!.threadId;
    const detail = await mobileNetwork.getPartnerPrivateThread(credential, second.partnerId, threadId);
    expect(detail).toMatchObject({
      thread: { threadId, otherPartnerId: first.partnerId },
      messages: [{ threadId, sequence: 1, senderPartnerId: first.partnerId,
        recipientPartnerId: second.partnerId, content: MESSAGE, deliveryStatus: "delivered" }]
    });
    expect(detail.readState?.throughSequence ?? 0).toBe(0);
    const read = await mobileNetwork.markPartnerPrivateThreadRead(credential, second.partnerId, threadId, 1, 1);
    expect(read).toMatchObject({ threadId, partnerId: second.partnerId, throughSequence: 1 });
    expect((await mobileNetwork.getPartnerPrivateThread(credential, second.partnerId, threadId))
      .readState?.throughSequence).toBe(1);
    expect(fixture.application.partners?.getPrivateThread(threadId, second.partnerId)
      .readState?.throughSequence).toBe(1);

    await expect(mobileNetwork.listPartners({ ...credential, authKey: "invalid-auth-key" }))
      .rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(mobileNetwork.getPartnerPrivateThread(credential, "partner-outside-thread", threadId))
      .rejects.toBeDefined();
  }, 90_000);
});

async function createPartner(
  fixture: RealPiSystemFixture,
  manager: Awaited<ReturnType<RealPiSystemFixture["pair"]>>,
  displayName: string,
  avatar: string
): Promise<{ readonly partnerId: string; readonly canonicalSessionId: string }> {
  const directory = await manager.clients.partner.getPartnerDirectory({});
  const revision = directory.directory?.revision;
  if (!revision) throw new Error("The Partner directory revision is required.");
  const response = await manager.clients.partner.createPartner({
    expectedDirectoryRevision: revision,
    draft: create(PartnerDraftSchema, {
      displayName, avatar,
      identitySource: `You are ${displayName}, a Partner in the mobile private-thread test.`,
      templateId: "general", usesDirectoryDefaults: false,
      capabilities: create(PartnerCapabilitiesSchema, {
        modelChain: [create(PartnerModelRouteSchema, {
          backendId: "pi", providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, fastMode: false
        })],
        permissionMode: PermissionMode.AUTO, planMode: false
      })
    })
  });
  const partner = response.partner;
  if (!partner?.partnerId || !partner.canonicalSessionId) throw new Error("The canonical Partner is required.");
  return { partnerId: partner.partnerId, canonicalSessionId: partner.canonicalSessionId };
}

function requiredPrivateToolName(request: CapturedProviderRequest): string {
  const tools = Array.isArray(request.body["tools"]) ? request.body["tools"] : [];
  for (const tool of tools) {
    const name = asRecord(asRecord(tool)?.["function"])?.["name"];
    if (name === "mcp__joko_partners__send_private_message") return name;
  }
  throw new Error("The Partner private-message tool was not advertised.");
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : undefined;
}
