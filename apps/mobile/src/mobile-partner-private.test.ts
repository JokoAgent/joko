import { create } from "@bufbuild/protobuf";
import {
  GetPartnerPrivateThreadResponseSchema, ListPartnerPrivateThreadsResponseSchema,
  ListPartnersResponseSchema, ListPartnerSessionsResponseSchema, MarkPartnerPrivateThreadReadResponseSchema,
  PartnerInitializationState, PartnerLifecycle, PartnerPrivateMessageDeliveryStatus,
  PartnerPrivateThreadStatus, PartnerSessionRole
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  projectMobilePartners, projectMobilePrivateDetail, projectMobilePrivateReadResponse,
  projectMobilePrivateThreads, assertMobileCanonicalPartnerSession
} from "./mobile-partner-private";

const at = (seconds: bigint) => ({ seconds, nanos: 0 });
const partner = (partnerId: string, sessionId: string) => ({
  partnerId, profileVersion: 1n, displayName: partnerId, avatar: "standard",
  lifecycle: PartnerLifecycle.ACTIVE, initializationState: PartnerInitializationState.READY,
  canonicalSessionId: sessionId
});
const thread = {
  threadId: "thread-1", firstPartnerId: "partner-a", secondPartnerId: "partner-b",
  status: PartnerPrivateThreadStatus.ACTIVE, messageCount: 2, maxMessages: 12,
  createdAt: at(10n), updatedAt: at(13n), expiresAt: at(900n)
};
const messages = [{
  messageId: "message-1", threadId: "thread-1", sequence: 1n,
  senderPartnerId: "partner-a", recipientPartnerId: "partner-b", content: "Hello",
  deliveryStatus: PartnerPrivateMessageDeliveryStatus.DELIVERED,
  createdAt: at(11n), deliveredAt: at(12n)
}, {
  messageId: "message-2", threadId: "thread-1", sequence: 3n,
  senderPartnerId: "partner-b", recipientPartnerId: "partner-a", content: "Hi",
  deliveryStatus: PartnerPrivateMessageDeliveryStatus.PENDING,
  createdAt: at(13n)
}];

describe("mobile Partner private projections", () => {
  it("keeps the immutable canonical link valid after profile edits but rejects future or unavailable links", () => {
    const current = projectMobilePartners(create(ListPartnersResponseSchema, {
      directory: { activeCount: 1 }, partners: [{ ...partner("partner-a", "session-a"), profileVersion: 4n }]
    }))[0]!;
    const response = create(ListPartnerSessionsResponseSchema, { sessions: [{
      partnerId: "partner-a", sessionId: "session-a", role: PartnerSessionRole.CANONICAL,
      profileVersion: 1n, available: true
    }] });
    expect(() => assertMobileCanonicalPartnerSession(current, "session-a", response)).not.toThrow();
    for (const invalidVersion of [0n, 5n]) {
      response.sessions[0]!.profileVersion = invalidVersion;
      expect(() => assertMobileCanonicalPartnerSession(current, "session-a", response)).toThrow(/available/u);
    }
    response.sessions[0]!.profileVersion = 1n;
    response.sessions[0]!.readOnly = true;
    expect(() => assertMobileCanonicalPartnerSession(current, "session-a", response)).toThrow(/available/u);
    response.sessions[0]!.readOnly = false;
    response.sessions[0]!.partnerId = "partner-b";
    expect(() => assertMobileCanonicalPartnerSession(current, "session-a", response)).toThrow(/available/u);
  });

  it("accepts exact current-v1 participants, ordered live messages, safe sequences and read state", () => {
    const directory = create(ListPartnersResponseSchema, {
      directory: { activeCount: 2, archivedCount: 0 },
      partners: [partner("partner-a", "session-a"), partner("partner-b", "session-b")]
    });
    expect(projectMobilePartners(directory).map((item) => item.partnerId)).toEqual(["partner-a", "partner-b"]);
    const listed = create(ListPartnerPrivateThreadsResponseSchema, { threads: [thread] });
    expect(projectMobilePrivateThreads("partner-a", listed)[0]?.otherPartnerId).toBe("partner-b");
    const response = create(GetPartnerPrivateThreadResponseSchema, {
      thread, messages,
      readState: { threadId: "thread-1", partnerId: "partner-a", throughSequence: 1n, updatedAt: at(14n) }
    });
    expect(projectMobilePrivateDetail("partner-a", "thread-1", response)).toMatchObject({
      messages: [{ sequence: 1, deliveryStatus: "delivered" }, { sequence: 3, deliveryStatus: "pending" }],
      readState: { partnerId: "partner-a", throughSequence: 1 }
    });
    expect(projectMobilePrivateReadResponse("partner-a", "thread-1",
      create(MarkPartnerPrivateThreadReadResponseSchema, {
        readState: { threadId: "thread-1", partnerId: "partner-a", throughSequence: 3n, updatedAt: at(15n) }
      }), 3, 3).throughSequence).toBe(3);
  });

  it("rejects swapped participants, duplicate or unordered messages, unknown delivery, and guessed read success", () => {
    const detail = (changedThread: typeof thread, changedMessages: typeof messages) =>
      create(GetPartnerPrivateThreadResponseSchema, { thread: changedThread, messages: changedMessages });
    expect(() => projectMobilePrivateDetail("partner-a", "thread-1",
      detail({ ...thread, secondPartnerId: "partner-c" }, messages))).toThrow();
    expect(() => projectMobilePrivateDetail("partner-a", "thread-1",
      detail(thread, [messages[1]!, messages[0]!]))).toThrow();
    expect(() => projectMobilePrivateDetail("partner-a", "thread-1",
      detail(thread, [messages[0]!, { ...messages[1]!, deliveryStatus: PartnerPrivateMessageDeliveryStatus.FAILED }]))).toThrow();
    expect(() => projectMobilePrivateReadResponse("partner-a", "thread-1",
      create(MarkPartnerPrivateThreadReadResponseSchema, {
        readState: { threadId: "thread-1", partnerId: "partner-a", throughSequence: 1n, updatedAt: at(15n) }
      }), 3, 3)).toThrow();
  });
});
