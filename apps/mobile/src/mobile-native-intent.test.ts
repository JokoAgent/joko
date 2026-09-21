import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  MobileNativeIntentDelivery,
  MobileExternalIntentFence,
  executeMobileNativeIntent,
  isMobileIncomingShareUrl,
  installMobileNativeIntentLinking,
  mobileConnectionStageRequired,
  mobileNativeIntentDuplicateWindowMilliseconds,
  mobileNativeIntentHistoryPageMaximum,
  mobileNativeIntentMessageMatches,
  parseMobileNativeIntent,
  type MobileNativeIntentClaim,
  type MobileNativeIntentMessageFocus,
  type MobileNativeIntentRecovery,
  type MobileNativeIntentRuntime,
  type MobileNativeIntentSnapshot
} from "./mobile-native-intent";

describe("mobile public native intents", () => {
  it("parses the canonical task handoff with bounded profile and message identities", () => {
    expect(parseMobileNativeIntent(
      "joko://task/task%20%2F%20%E4%B8%80?event=event+%2F+%E4%B8%80&message=message+%2F+%E4%B8%80&profile=machine+%2F+%E4%B8%80"
    )).toEqual({
      kind: "session",
      sessionId: "task / 一",
      profileId: "machine / 一",
      messageId: "message / 一",
      messageEventId: "event / 一"
    });
    expect(parseMobileNativeIntent("joko://task/task-one")).toEqual({ kind: "session", sessionId: "task-one" });
  });

  it("accepts only the mobile Settings root and a bounded focus-only source", () => {
    expect(parseMobileNativeIntent("joko://settings")).toEqual({ kind: "settings" });
    expect(parseMobileNativeIntent("joko://settings/")).toEqual({ kind: "settings" });
    expect(parseMobileNativeIntent("joko://focus")).toEqual({ kind: "focus" });
    expect(parseMobileNativeIntent("joko://focus/notification%20return"))
      .toEqual({ kind: "focus", source: "notification return" });
  });

  it("rejects privileged, share, legacy, malformed, ambiguous, and unbounded routes", () => {
    for (const value of [
      "https://example.test/task/one",
      "joko://app/index.html",
      "joko://expo-sharing",
      "joko://session/task-one",
      "joko://task/",
      "joko://task/one/two",
      "joko://task/%ZZ",
      "joko://task/%0A",
      " joko://task/one",
      "joko://task/one\n",
      "joko://task/one#fragment",
      "joko://user@task/one",
      "joko://task:9/one",
      "joko://task/one?unknown=value",
      "joko://task/one?message=a&message=b",
      "joko://task/one?message=",
      "joko://task/one?event=event-without-message",
      "joko://settings/general",
      "joko://settings?panel=voice",
      "joko://focus/one/two",
      `joko://task/${"x".repeat(257)}`,
      `joko://focus/${"x".repeat(129)}`,
      `joko://task/${"x".repeat(4_097)}`
    ]) expect(parseMobileNativeIntent(value), value).toBeUndefined();
  });

  it("keeps the incoming-share callback isolated from public navigation", () => {
    expect(isMobileIncomingShareUrl("joko://expo-sharing")).toBe(true);
    expect(isMobileIncomingShareUrl("joko://expo-sharing?batch=1")).toBe(true);
    expect(isMobileIncomingShareUrl("joko://expo-sharing.evil/path")).toBe(false);
    expect(parseMobileNativeIntent("joko://expo-sharing?batch=1")).toBeUndefined();
  });

  it("keeps the registered Expo scheme on the public Joko identity", () => {
    const config = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../app.json"), "utf8")) as {
      readonly expo?: { readonly scheme?: unknown };
    };
    expect(config.expo?.scheme).toBe("joko");
  });

  it("keeps local Settings reachable before pairing without exposing other product pages", () => {
    expect(mobileConnectionStageRequired(undefined, "settings")).toBe(false);
    expect(mobileConnectionStageRequired(undefined, "home")).toBe(true);
    expect(mobileConnectionStageRequired(undefined, "task")).toBe(true);
    expect(mobileConnectionStageRequired("profile", "settings")).toBe(false);
    expect(mobileConnectionStageRequired("profile", "connection")).toBe(true);
  });
});

describe("mobile native-intent delivery", () => {
  it("keeps durable incoming-share navigation last-writer-wins without letting focus replace it", () => {
    const fence = new MobileExternalIntentFence();
    expect(fence.shareMayNavigate()).toBe(true);
    fence.offerNative({ kind: "session", sessionId: "task" });
    expect(fence.shareMayNavigate()).toBe(false);
    fence.offerNative({ kind: "focus", source: "return" });
    expect(fence.shareMayNavigate()).toBe(false);
    fence.offerShare();
    expect(fence.shareMayNavigate()).toBe(true);
    fence.offerNative({ kind: "settings" });
    expect(fence.shareMayNavigate()).toBe(false);
  });

  it("keeps a valid warm URL newer than an unresolved cold URL and retires the listener on cleanup", async () => {
    let listener: ((event: { readonly url: string }) => void) | undefined;
    let finishInitial!: (url: string | null) => void;
    const remove = vi.fn();
    const onUrl = vi.fn();
    const cleanup = installMobileNativeIntentLinking({
      addEventListener: (_event, next) => { listener = next; return { remove }; },
      getInitialURL: () => new Promise((resolve) => { finishInitial = resolve; })
    }, onUrl);
    listener?.({ url: "joko://task/warm" });
    finishInitial("joko://task/cold");
    await Promise.resolve();
    expect(onUrl.mock.calls.map(([url]) => url)).toEqual(["joko://task/warm"]);
    cleanup();
    listener?.({ url: "joko://task/retired" });
    expect(remove).toHaveBeenCalledOnce();
    expect(onUrl).toHaveBeenCalledOnce();
  });

  it("does not deliver a late initial URL after the linking owner is retired", async () => {
    let finishInitial!: (url: string | null) => void;
    const onUrl = vi.fn();
    const cleanup = installMobileNativeIntentLinking({
      addEventListener: () => ({ remove: vi.fn() }),
      getInitialURL: () => new Promise((resolve) => { finishInitial = resolve; })
    }, onUrl);
    cleanup();
    finishInitial("joko://task/late");
    await Promise.resolve();
    expect(onUrl).not.toHaveBeenCalled();
  });

  it("deduplicates the same warm event against a later identical initial URL", async () => {
    let listener: ((event: { readonly url: string }) => void) | undefined;
    let finishInitial!: (url: string | null) => void;
    const onUrl = vi.fn();
    installMobileNativeIntentLinking({
      addEventListener: (_event, next) => { listener = next; return { remove: vi.fn() }; },
      getInitialURL: () => new Promise((resolve) => { finishInitial = resolve; })
    }, onUrl);
    listener?.({ url: "joko://task/same" });
    finishInitial("joko://task/same");
    await Promise.resolve();
    await Promise.resolve();
    expect(onUrl).toHaveBeenCalledOnce();
  });

  it("does not let an invalid warm event hide a valid unresolved initial URL", async () => {
    let listener: ((event: { readonly url: string }) => void) | undefined;
    let finishInitial!: (url: string | null) => void;
    const onUrl = vi.fn((url: string) => parseMobileNativeIntent(url) !== undefined);
    installMobileNativeIntentLinking({
      addEventListener: (_event, next) => { listener = next; return { remove: vi.fn() }; },
      getInitialURL: () => new Promise((resolve) => { finishInitial = resolve; })
    }, onUrl);
    listener?.({ url: "https://example.test/not-joko" });
    finishInitial("joko://task/cold");
    await Promise.resolve();
    await Promise.resolve();
    expect(onUrl.mock.calls.map(([url]) => url)).toEqual([
      "https://example.test/not-joko",
      "joko://task/cold"
    ]);
  });

  it("buffers only the latest navigation until ready and consumes it once", () => {
    const delivery = new MobileNativeIntentDelivery();
    expect(delivery.offer("joko://task/first", 1)).toBe(true);
    expect(delivery.offer("joko://settings", 2)).toBe(true);
    expect(delivery.take(false)).toBeUndefined();
    const claim = delivery.take(true);
    expect(claim?.intent).toEqual({ kind: "settings" });
    expect(delivery.take(true)).toBeUndefined();
    expect(claim && delivery.isCurrent(claim)).toBe(true);
  });

  it("does not let a focus-only handoff cancel pending navigation", () => {
    const delivery = new MobileNativeIntentDelivery();
    expect(delivery.offer("joko://task/first", 1)).toBe(true);
    expect(delivery.offer("joko://focus/return", 2)).toBe(false);
    const claim = delivery.take()!;
    expect(claim.intent).toEqual({ kind: "session", sessionId: "first" });
    expect(delivery.offer("joko://focus/return", 3)).toBe(false);
    expect(delivery.isCurrent(claim)).toBe(true);
  });

  it("does not let an invalid URL replace the last valid buffered intent", () => {
    const delivery = new MobileNativeIntentDelivery();
    expect(delivery.offer("joko://task/valid", 1)).toBe(true);
    expect(delivery.offer("joko://app/index.html", 2)).toBe(false);
    expect(delivery.take()?.intent).toEqual({ kind: "session", sessionId: "valid" });
  });

  it("retires an active claim for a later navigation and suppresses immediate cold/warm duplicates", () => {
    const delivery = new MobileNativeIntentDelivery();
    expect(delivery.offer("joko://task/first", 10)).toBe(true);
    const first = delivery.take()!;
    expect(delivery.offer("joko://settings", 11)).toBe(true);
    expect(delivery.isCurrent(first)).toBe(false);
    expect(delivery.complete(first, 12)).toBe(true);
    const settings = delivery.take()!;
    expect(delivery.isCurrent(settings)).toBe(true);
    expect(delivery.complete(settings, 20)).toBe(true);
    expect(delivery.offer("joko://settings", 20 + mobileNativeIntentDuplicateWindowMilliseconds)).toBe(false);
    expect(delivery.offer("joko://settings", 21 + mobileNativeIntentDuplicateWindowMilliseconds)).toBe(true);
  });
});

describe("mobile native-intent execution", () => {
  it("opens local Settings without requiring a connection and leaves focus-only handoffs in place", async () => {
    const settings = harness("joko://settings", snapshot({ status: "unpaired" }));
    await expect(executeMobileNativeIntent(settings.claim, settings.delivery, settings.runtime)).resolves.toBe("settings");
    expect(settings.fake.pages).toEqual(["settings"]);
    expect(settings.fake.recoveries).toEqual([]);

    const focus = harness("joko://focus/return", snapshot({ status: "unpaired" }));
    await expect(executeMobileNativeIntent(focus.claim, focus.delivery, focus.runtime)).resolves.toBe("focused");
    expect(focus.fake.focusApplication).toHaveBeenCalledOnce();
    expect(focus.fake.pages).toEqual([]);
  });

  it("connects only the explicitly saved profile and selects its exact task", async () => {
    const test = harness("joko://task/session-1?profile=profile-2", snapshot({
      status: "connected",
      activeProfileId: "profile-1",
      savedProfileIds: ["profile-1", "profile-2"],
      sessionIds: ["other"]
    }));
    test.fake.onConnect = (profileId) => {
      expect(profileId).toBe("profile-2");
      test.fake.state = snapshot({
        status: "connected",
        activeProfileId: "profile-2",
        savedProfileIds: ["profile-1", "profile-2"],
        sessionIds: ["session-1"]
      });
    };
    await expect(executeMobileNativeIntent(test.claim, test.delivery, test.runtime)).resolves.toBe("session");
    expect(test.fake.actions).toEqual([
      "clear-recovery", "clear-focus", "saved", "connect:profile-2", "select:session-1", "page:task"
    ]);
    expect(test.fake.state.selectedSessionId).toBe("session-1");
  });

  it("never guesses another node when profile identity is absent or unavailable", async () => {
    const absent = harness("joko://task/session-1", snapshot({
      status: "unpaired",
      savedProfileIds: ["profile-1"]
    }));
    await expect(executeMobileNativeIntent(absent.claim, absent.delivery, absent.runtime))
      .resolves.toBe("connection-required");
    expect(absent.fake.actions).toEqual(["clear-recovery", "clear-focus", "clear-focus", "saved", "page:connection",
      "recovery:connection-required"]);

    const missing = harness("joko://task/session-1?profile=missing", snapshot({
      status: "connected",
      activeProfileId: "profile-1",
      savedProfileIds: ["profile-1"],
      sessionIds: ["session-1"]
    }));
    await expect(executeMobileNativeIntent(missing.claim, missing.delivery, missing.runtime))
      .resolves.toBe("profile-unavailable");
    expect(missing.fake.connectProfile).not.toHaveBeenCalled();
    expect(missing.fake.pages).toEqual(["connection"]);

    const duplicate = harness("joko://task/session-1?profile=profile-1", snapshot({
      status: "connected",
      activeProfileId: "profile-1",
      savedProfileIds: ["profile-1", "profile-1"],
      sessionIds: ["session-1"]
    }));
    await expect(executeMobileNativeIntent(duplicate.claim, duplicate.delivery, duplicate.runtime))
      .resolves.toBe("profile-unavailable");
    expect(duplicate.fake.selectSession).not.toHaveBeenCalled();
  });

  it("keeps a failed explicit profile verification on the connection recovery surface", async () => {
    const test = harness("joko://task/session-1?profile=profile-2", snapshot({
      status: "connected",
      activeProfileId: "profile-1",
      savedProfileIds: ["profile-1", "profile-2"],
      sessionIds: ["session-1"]
    }));
    test.fake.connectProfile.mockRejectedValueOnce(new Error("offline"));
    await expect(executeMobileNativeIntent(test.claim, test.delivery, test.runtime))
      .resolves.toBe("profile-connect-failed");
    expect(test.fake.selectSession).not.toHaveBeenCalled();
    expect(test.fake.pages).toEqual(["connection"]);
  });

  it("fails closed on duplicate or missing task identities", async () => {
    for (const sessionIds of [[], ["session-1", "session-1"]]) {
      const test = harness("joko://task/session-1", snapshot({
        status: "connected",
        activeProfileId: "profile-1",
        savedProfileIds: ["profile-1"],
        sessionIds
      }));
      await expect(executeMobileNativeIntent(test.claim, test.delivery, test.runtime))
        .resolves.toBe("session-unavailable");
      expect(test.fake.selectSession).not.toHaveBeenCalled();
      expect(test.fake.pages).toEqual(["home"]);
    }
  });

  it("loads an authenticated around window and focuses only the exact message/event pair", async () => {
    const test = harness("joko://task/session-1?message=message-1&event=event-1", snapshot({
      status: "connected",
      activeProfileId: "profile-1",
      savedProfileIds: ["profile-1"],
      sessionIds: ["session-1"]
    }));
    test.fake.onAround = (eventId) => {
      expect(eventId).toBe("event-1");
      test.fake.state = snapshot({
        ...test.fake.state,
        messages: [{ messageId: "message-1", eventId: "event-1" }],
        historyKey: "around"
      });
    };
    await expect(executeMobileNativeIntent(test.claim, test.delivery, test.runtime)).resolves.toBe("message");
    expect(test.fake.messageFocus).toEqual({
      requestId: test.claim.sequence,
      sessionId: "session-1",
      messageId: "message-1",
      messageEventId: "event-1"
    });
  });

  it("accepts a grounded message when the around anchor and rendered completion event differ", async () => {
    const test = harness("joko://task/session-1?message=message-1&event=event-started", snapshot({
      status: "connected",
      activeProfileId: "profile-1",
      savedProfileIds: ["profile-1"],
      sessionIds: ["session-1"]
    }));
    test.fake.onAround = () => {
      test.fake.state = snapshot({
        ...test.fake.state,
        messages: [{ messageId: "message-1", eventId: "event-completed" }],
        historyKey: "around"
      });
    };
    await expect(executeMobileNativeIntent(test.claim, test.delivery, test.runtime)).resolves.toBe("message");
    expect(test.fake.messageFocus?.messageEventId).toBe("event-completed");
  });

  it("returns to latest and exposes recovery when an event does not ground the named message", async () => {
    const test = harness("joko://task/session-1?message=message-1&event=event-1", snapshot({
      status: "connected",
      activeProfileId: "profile-1",
      savedProfileIds: ["profile-1"],
      sessionIds: ["session-1"]
    }));
    test.fake.onAround = () => {
      test.fake.state = snapshot({
        ...test.fake.state,
        messages: [{ messageId: "another-message", eventId: "event-1" }],
        historyKey: "wrong-around"
      });
    };
    await expect(executeMobileNativeIntent(test.claim, test.delivery, test.runtime))
      .resolves.toBe("message-unavailable");
    expect(test.fake.returnLatest).toHaveBeenCalledOnce();
    expect(test.fake.messageFocus).toBeUndefined();
    expect(test.fake.pages.at(-1)).toBe("task");
  });

  it("walks bounded history for a message-only link and stops as soon as the message appears", async () => {
    const test = harness("joko://task/session-1?message=message-older", snapshot({
      status: "connected",
      activeProfileId: "profile-1",
      savedProfileIds: ["profile-1"],
      sessionIds: ["session-1"],
      historyEnd: false,
      historyKey: "page-0"
    }));
    let page = 0;
    test.fake.onOlder = () => {
      page += 1;
      test.fake.state = snapshot({
        ...test.fake.state,
        messages: page === 2 ? [{ messageId: "message-older", eventId: "event-older" }] : [],
        historyEnd: false,
        historyKey: `page-${page}`
      });
    };
    await expect(executeMobileNativeIntent(test.claim, test.delivery, test.runtime)).resolves.toBe("message");
    expect(test.fake.loadOlder).toHaveBeenCalledTimes(2);
    expect(test.fake.messageFocus?.messageId).toBe("message-older");
  });

  it("does not perform history I/O for a message present in the verified offline copy", async () => {
    const test = harness("joko://task/session-1?message=message-1", snapshot({
      status: "offline",
      activeProfileId: "profile-1",
      savedProfileIds: ["profile-1"],
      sessionIds: ["session-1"],
      messages: [{ messageId: "message-1", eventId: "event-1" }]
    }));
    await expect(executeMobileNativeIntent(test.claim, test.delivery, test.runtime)).resolves.toBe("message");
    expect(test.fake.loadAround).not.toHaveBeenCalled();
    expect(test.fake.loadOlder).not.toHaveBeenCalled();
  });

  it("shows task recovery without network history I/O when an offline message is absent", async () => {
    const test = harness("joko://task/session-1?message=missing", snapshot({
      status: "offline",
      activeProfileId: "profile-1",
      savedProfileIds: ["profile-1"],
      sessionIds: ["session-1"],
      messages: []
    }));
    await expect(executeMobileNativeIntent(test.claim, test.delivery, test.runtime))
      .resolves.toBe("message-unavailable");
    expect(test.fake.loadAround).not.toHaveBeenCalled();
    expect(test.fake.loadOlder).not.toHaveBeenCalled();
    expect(test.fake.pages.at(-1)).toBe("task");
  });

  it("stops message-only traversal when a history page makes no progress", async () => {
    const test = harness("joko://task/session-1?message=missing", snapshot({
      status: "connected",
      activeProfileId: "profile-1",
      savedProfileIds: ["profile-1"],
      sessionIds: ["session-1"],
      historyEnd: false,
      historyKey: "unchanged"
    }));
    await expect(executeMobileNativeIntent(test.claim, test.delivery, test.runtime))
      .resolves.toBe("message-unavailable");
    expect(test.fake.loadOlder).toHaveBeenCalledOnce();
  });

  it("retires a slow profile switch before it can navigate after a newer intent", async () => {
    const test = harness("joko://task/session-1?profile=profile-2", snapshot({
      status: "connected",
      activeProfileId: "profile-1",
      savedProfileIds: ["profile-1", "profile-2"],
      sessionIds: []
    }));
    let finish!: () => void;
    test.fake.connectProfile.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const execution = executeMobileNativeIntent(test.claim, test.delivery, test.runtime);
    await vi.waitFor(() => expect(test.fake.connectProfile).toHaveBeenCalledOnce());
    expect(test.delivery.offer("joko://settings", 2)).toBe(true);
    finish();
    await expect(execution).resolves.toBe("retired");
    expect(test.fake.selectSession).not.toHaveBeenCalled();
    expect(test.fake.pages).toEqual([]);
  });

  it("matches a rendered message only when both supplied identities agree", () => {
    const focus: MobileNativeIntentMessageFocus = {
      requestId: 1,
      sessionId: "session",
      messageId: "message",
      messageEventId: "event"
    };
    expect(mobileNativeIntentMessageMatches(focus, { id: "message", eventId: "event" })).toBe(true);
    expect(mobileNativeIntentMessageMatches(focus, { id: "message", eventId: "other" })).toBe(false);
    expect(mobileNativeIntentMessageMatches(focus, { id: "other", eventId: "event" })).toBe(false);
  });

  it("keeps history traversal explicitly bounded", () => {
    expect(mobileNativeIntentHistoryPageMaximum).toBeGreaterThan(0);
    expect(mobileNativeIntentHistoryPageMaximum).toBeLessThanOrEqual(256);
  });
});

class FakeRuntime implements MobileNativeIntentRuntime {
  state: MobileNativeIntentSnapshot;
  readonly actions: string[] = [];
  readonly pages: Array<"connection" | "home" | "settings" | "task"> = [];
  readonly recoveries: MobileNativeIntentRecovery[] = [];
  messageFocus: MobileNativeIntentMessageFocus | undefined;
  onConnect?: (profileId: string) => void;
  onAround?: (eventId: string) => void;
  onOlder?: () => void;

  readonly connectProfile = vi.fn(async (profileId: string) => {
    this.actions.push(`connect:${profileId}`);
    this.onConnect?.(profileId);
  });
  readonly selectSession = vi.fn(async (sessionId: string) => {
    this.actions.push(`select:${sessionId}`);
    this.state = snapshot({ ...this.state, selectedSessionId: sessionId });
  });
  readonly loadAround = vi.fn(async (eventId: string) => {
    this.actions.push(`around:${eventId}`);
    this.onAround?.(eventId);
  });
  readonly loadOlder = vi.fn(async () => {
    this.actions.push("older");
    this.onOlder?.();
  });
  readonly returnLatest = vi.fn(() => { this.actions.push("latest"); });
  readonly focusApplication = vi.fn(() => { this.actions.push("focus-application"); });

  constructor(value: MobileNativeIntentSnapshot) { this.state = value; }
  snapshot(): MobileNativeIntentSnapshot { return this.state; }
  showPage(page: "connection" | "home" | "settings" | "task"): void {
    this.pages.push(page);
    this.actions.push(`page:${page}`);
  }
  showSavedConnections(): void { this.actions.push("saved"); }
  showRecovery(recovery: MobileNativeIntentRecovery): void {
    this.recoveries.push(recovery);
    this.actions.push(`recovery:${recovery}`);
  }
  clearRecovery(): void { this.actions.push("clear-recovery"); }
  focusMessage(focus: MobileNativeIntentMessageFocus): void {
    this.messageFocus = focus;
    this.actions.push(`focus:${focus.messageId}`);
  }
  clearMessageFocus(): void {
    this.messageFocus = undefined;
    this.actions.push("clear-focus");
  }
}

function harness(url: string, initial: MobileNativeIntentSnapshot): {
  readonly delivery: MobileNativeIntentDelivery;
  readonly claim: MobileNativeIntentClaim;
  readonly runtime: MobileNativeIntentRuntime;
  readonly fake: FakeRuntime;
} {
  const delivery = new MobileNativeIntentDelivery();
  expect(delivery.offer(url, 1)).toBe(true);
  const claim = delivery.take();
  if (!claim) throw new Error("Expected a native-intent claim.");
  const fake = new FakeRuntime(initial);
  return { delivery, claim, runtime: fake, fake };
}

function snapshot(
  input: Partial<MobileNativeIntentSnapshot> & Pick<MobileNativeIntentSnapshot, "status">
): MobileNativeIntentSnapshot {
  return {
    status: input.status,
    ...(input.activeProfileId === undefined ? {} : { activeProfileId: input.activeProfileId }),
    savedProfileIds: input.savedProfileIds ?? [],
    sessionIds: input.sessionIds ?? [],
    ...(input.selectedSessionId === undefined ? {} : { selectedSessionId: input.selectedSessionId }),
    messages: input.messages ?? [],
    historyEnd: input.historyEnd ?? true,
    historyKey: input.historyKey ?? "initial"
  };
}
