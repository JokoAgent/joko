import { create } from "@bufbuild/protobuf";
import {
  GetPartnerPrivateThreadResponseSchema, ListPartnerPrivateThreadsResponseSchema,
  ListPartnersResponseSchema, MarkPartnerPrivateThreadReadResponseSchema,
  PartnerInitializationState, PartnerLifecycle, PartnerPrivateMessageDeliveryStatus,
  PartnerPrivateThreadStatus
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  projectMobilePartners, projectMobilePrivateDetail, projectMobilePrivateReadResponse,
  projectMobilePrivateThreads
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
