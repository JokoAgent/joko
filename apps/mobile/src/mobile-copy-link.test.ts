import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMobileMessageDeepLink,
  buildMobileTaskDeepLink,
  type MobileNativeIntentSnapshot
} from "./mobile-native-intent";
import {
  MobileCopyLinkWriter,
  claimMobileCopyLinkAuthority,
  mobileCopyLinkAuthorityMatches
} from "./mobile-copy-link";

afterEach(() => vi.useRealTimers());

describe("mobile public-link clipboard writer", () => {
  it("claims exact online or offline owners and retires profile, page, task, and message drift", () => {
    const current = snapshot();
    const task = claimMobileCopyLinkAuthority(current, {
      sessionId: "task-one",
      requiresSelectedSession: false
    });
    const message = claimMobileCopyLinkAuthority(current, {
      sessionId: "task-one",
      requiresSelectedSession: true,
      messageId: "message-one",
      messageEventId: "event-one"
    });
    expect(task).toBeDefined();
    expect(message).toBeDefined();
    expect(task && mobileCopyLinkAuthorityMatches(task, snapshot({ status: "offline" }))).toBe(true);
    expect(message && mobileCopyLinkAuthorityMatches(message, snapshot({ status: "offline" }))).toBe(true);
    expect(message && mobileCopyLinkAuthorityMatches(message, snapshot({ activeProfileId: "profile-two" }))).toBe(false);
    expect(message && mobileCopyLinkAuthorityMatches(message, snapshot({ selectedSessionId: "task-two" }))).toBe(false);
    expect(message && mobileCopyLinkAuthorityMatches(message, snapshot({ sessionIds: ["task-one", "task-one"] }))).toBe(false);
    expect(message && mobileCopyLinkAuthorityMatches(message, snapshot({ messages: [{ messageId: "message-one", eventId: "event-two" }] }))).toBe(false);
    expect(task && mobileCopyLinkAuthorityMatches(task, snapshot({ selectedSessionId: "task-two" }))).toBe(true);
    expect(task && mobileCopyLinkAuthorityMatches(task, snapshot({ status: "connecting" }))).toBe(false);
  });

  it("writes one canonical task or message link and rejects every other clipboard payload", async () => {
    const writeText = vi.fn(async () => undefined);
    const writer = new MobileCopyLinkWriter({ writeText });
    const message = buildMobileMessageDeepLink("task-one", "message-one", "event-one");
    await expect(writer.copy(message)).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledWith(message);
    await expect(writer.copy("https://example.test/task-one")).rejects.toThrow(/canonical public Joko task link/u);
    await expect(writer.copy("joko://task/task-one?profile=local-profile")).rejects.toThrow(/canonical public Joko task link/u);
    await expect(writer.copy("joko://task/task-one?message=message+one")).rejects.toThrow(/canonical public Joko task link/u);
    expect(writeText).toHaveBeenCalledOnce();
  });

  it("keeps a single native owner and does not enqueue a repeated write", async () => {
    const pending = deferred<void>();
    const writeText = vi.fn(() => pending.promise);
    const writer = new MobileCopyLinkWriter({ writeText });
    const first = writer.copy(buildMobileTaskDeepLink("task-one"));
    await Promise.resolve();
    expect(writer.busy).toBe(true);
    await expect(writer.copy(buildMobileTaskDeepLink("task-two"))).resolves.toBe("busy");
    expect(writeText).toHaveBeenCalledOnce();
    pending.resolve();
    await expect(first).resolves.toBe("copied");
    expect(writer.busy).toBe(false);
  });

  it("retains a timed-out raw native write until it actually settles", async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    const writer = new MobileCopyLinkWriter({ writeText: () => pending.promise });
    const first = writer.copy(buildMobileTaskDeepLink("task-one"), 50);
    const rejected = expect(first).rejects.toThrow(/did not finish in time/u);
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(writer.busy).toBe(true);
    await expect(writer.copy(buildMobileTaskDeepLink("task-two"))).resolves.toBe("busy");
    pending.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(writer.busy).toBe(false);
  });

  it("releases ownership after a definitive native clipboard failure", async () => {
    const writer = new MobileCopyLinkWriter({ writeText: vi.fn(async () => { throw new Error("native rejected"); }) });
    await expect(writer.copy(buildMobileTaskDeepLink("task-one"))).rejects.toThrow("native rejected");
    expect(writer.busy).toBe(false);
  });
});

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function snapshot(overrides: Partial<MobileNativeIntentSnapshot> = {}): MobileNativeIntentSnapshot {
  return {
    status: "connected",
    activeProfileId: "profile-one",
    savedProfileIds: ["profile-one"],
    sessionIds: ["task-one", "task-two"],
    selectedSessionId: "task-one",
    messages: [{ messageId: "message-one", eventId: "event-one" }],
    historyEnd: true,
    historyKey: "history",
    ...overrides
  };
}
