// @vitest-environment jsdom
import { create } from "@bufbuild/protobuf";
import { EventSchema, MessageRole, type Event } from "@joko/contracts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import { mobilePartnerVisibleReply, type MobilePartnerConversationTransport } from "./mobile-partner-conversation";
import { useMobilePartnerIdentity, useMobilePartnerRead } from "./use-mobile-partner-read";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const partner: MobilePartnerDirectoryProfile = {
  partnerId: "ada", revision: 2n, profileVersion: 3n, displayName: "Ada", avatar: "orbit",
  identitySource: "Product work", templateId: "general", lifecycle: "active", initializationState: "ready",
  invitationStage: "ready", homeTargetId: "target", canonicalSessionId: "session", usesDirectoryDefaults: true,
  capabilities: { modelChain: [{ backendId: "backend", providerId: "provider", modelId: "model", fastMode: false }],
    permissionMode: "ask", planMode: false }, createdAt: 1_000, updatedAt: 2_000,
  activity: { partnerId: "ada", unreadReplyCount: 2, latestReplyCursor: 6n, latestReplyAt: 2_000,
    artifactCount: 0, activeDelegationCount: 0, readThroughCursor: 0n, readUpdatedAt: 1_000 }
};

function completed(id: string, cursor: bigint, privateReply = false): Event {
  return create(EventSchema, { eventId: `event-${id}`, identity: { sessionId: "session" },
    cursor: { sequence: cursor, generation: 1n }, payload: { kind: { case: "messageCompleted", value: {
      messageId: id, role: MessageRole.ASSISTANT,
      ...(privateReply ? { partnerPrivateOrigin: { threadId: "thread", senderPartnerId: "bea", recipientPartnerId: "ada" } } : {})
    } } } });
}
const events = [completed("first", 4n), completed("latest", 6n), completed("private", 7n, true)];

function transport(ownerKey = "owner"): MobilePartnerConversationTransport {
  return { ownerKey, sessionId: "session", resolve: vi.fn(async () => partner),
    acknowledge: vi.fn(async (_profile, reply) => ({ ...partner.activity, readThroughCursor: reply.cursor })) };
}

let container: HTMLDivElement;
let root: Root;
let reading: ReturnType<typeof useMobilePartnerRead>;
function Harness({ active, visible, enabled }: { active?: MobilePartnerConversationTransport;
  visible: ReadonlySet<string>; enabled: boolean }) {
  const identity = useMobilePartnerIdentity(active);
  reading = useMobilePartnerRead(active, identity, events, 1n, visible, enabled);
  return createElement("span", {}, reading.partner?.displayName ?? "none");
}
async function render(active: MobilePartnerConversationTransport | undefined, visible: readonly string[], enabled = true) {
  if (!root) {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  }
  await act(async () => root.render(createElement(Harness, { active, visible: new Set(visible), enabled })));
}
afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove(); root = undefined as unknown as Root;
});

describe("mobile Partner visible reads", () => {
  it("does not expose an identity or read until metadata is confirmed, and recovers only on explicit retry", async () => {
    const active = transport();
    vi.mocked(active.resolve).mockRejectedValueOnce(new Error("metadata unavailable"));
    await render(active, ["latest"]);
    expect(reading.ready).toBe(false); expect(reading.partner).toBeUndefined(); expect(reading.failed).toBe(true);
    expect(active.acknowledge).not.toHaveBeenCalled();
    await act(async () => reading.retry());
    expect(reading.ready).toBe(true); expect(reading.partner?.displayName).toBe("Ada");
    expect(reading.partner?.activity.readThroughCursor).toBe(6n);
  });

  it("takes a cursor only from a visible completed public reply in the exact session generation", () => {
    expect(mobilePartnerVisibleReply(events, "session", 1n, new Set(["first", "private"])))
      .toEqual({ eventId: "event-first", messageId: "first", cursor: 4n });
    expect(mobilePartnerVisibleReply(events, "other", 1n, new Set(["latest"]))).toBeUndefined();
    expect(mobilePartnerVisibleReply(events, "session", 2n, new Set(["latest"]))).toBeUndefined();
    expect(mobilePartnerVisibleReply(events, "session", 1n, new Set(["private"]))).toBeUndefined();
  });

  it("does not read on entry, hidden replies or a covered task, and advances only through visible replies", async () => {
    const active = transport();
    await render(active, []);
    expect(active.acknowledge).not.toHaveBeenCalled();
    await render(active, ["latest"], false);
    expect(active.acknowledge).not.toHaveBeenCalled();
    await render(active, ["private"]);
    expect(active.acknowledge).not.toHaveBeenCalled();
    await render(active, ["first", "private"]);
    expect(active.acknowledge).toHaveBeenCalledOnce();
    expect(vi.mocked(active.acknowledge).mock.calls[0]?.[1].cursor).toBe(4n);
    expect(reading.partner?.activity.readThroughCursor).toBe(4n);
    await render(active, ["latest"]);
    expect(active.acknowledge).toHaveBeenCalledTimes(2);
    expect(reading.partner?.activity.readThroughCursor).toBe(6n);
    await render(active, ["first"]);
    expect(active.acknowledge).toHaveBeenCalledTimes(2);
  });

  it("keeps failed reads unread until an explicit retry", async () => {
    const active = transport();
    vi.mocked(active.acknowledge).mockRejectedValueOnce(new Error("offline"));
    await render(active, ["first"]);
    expect(reading.failed).toBe(true);
    expect(reading.partner?.activity.readThroughCursor).toBe(0n);
    await render(active, ["latest"]);
    expect(active.acknowledge).toHaveBeenCalledOnce();
    await act(async () => reading.retry());
    expect(active.acknowledge).toHaveBeenCalledTimes(2);
    expect(reading.failed).toBe(false);
    expect(reading.partner?.activity.readThroughCursor).toBe(6n);
  });

  it("serializes viewport advancement and aborts a late read when its owner leaves", async () => {
    const active = transport();
    let finish!: () => void;
    vi.mocked(active.acknowledge).mockImplementationOnce(async (_profile, reply) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { ...partner.activity, readThroughCursor: reply.cursor };
    });
    await render(active, ["first"]);
    await render(active, ["latest"]);
    expect(active.acknowledge).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(active.acknowledge).toHaveBeenCalledTimes(2);
    expect(reading.partner?.activity.readThroughCursor).toBe(6n);
    const old = transport("old-owner");
    let late!: () => void;
    vi.mocked(old.acknowledge).mockImplementation(async (_profile, reply) => {
      await new Promise<void>((resolve) => { late = resolve; });
      return { ...partner.activity, readThroughCursor: reply.cursor };
    });
    await render(old, ["first"]);
    const signal = vi.mocked(old.acknowledge).mock.calls[0]![2];
    await render(undefined, []);
    expect(signal.aborted).toBe(true);
    await act(async () => late());
    expect(reading.partner).toBeUndefined();
    expect(reading.failed).toBe(false);
  });
});
