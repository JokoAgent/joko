import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_UI_PREFERENCES, type UiPreferences } from "./local-state.js";
import {
  publishSessionNotificationPreferenceChange,
  sameSessionNotificationPreference,
  subscribeSessionNotificationPreferenceChange,
  withSessionNotificationPreference
} from "./session-notification-preference-sync.js";

afterEach(() => vi.unstubAllGlobals());

it("broadcasts only a content-free current-v1 hint and ignores malformed messages", async () => {
  const channels = new Set<TestChannel>();
  const sent: Array<{ readonly name: string; readonly value: unknown }> = [];
  class TestChannel {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    constructor(readonly name: string) { channels.add(this); }
    postMessage(value: unknown): void {
      sent.push({ name: this.name, value });
      for (const peer of channels) if (peer !== this && peer.name === this.name) {
        queueMicrotask(() => peer.onmessage?.({ data: value } as MessageEvent<unknown>));
      }
    }
    close(): void { channels.delete(this); }
  }
  vi.stubGlobal("BroadcastChannel", TestChannel);
  const changed = vi.fn();
  const unsubscribe = subscribeSessionNotificationPreferenceChange(changed);

  publishSessionNotificationPreferenceChange();
  await Promise.resolve();
  expect(changed).toHaveBeenCalledOnce();
  expect(sent).toEqual([{
    name: "joko:session-notification-preference:v1",
    value: { kind: "session-notification-preference-changed" }
  }]);

  const sender = new TestChannel("joko:session-notification-preference:v1");
  sender.postMessage({ kind: "session-notification-preference-changed", enabled: false });
  sender.postMessage({ kind: "other" });
  sender.postMessage("session-notification-preference-changed");
  sender.postMessage(["session-notification-preference-changed"]);
  await Promise.resolve();
  expect(changed).toHaveBeenCalledOnce();

  unsubscribe();
  sender.close();
});

it("fences retained callbacks after idempotent cleanup even when close fails", () => {
  const retained: Array<(event: MessageEvent<unknown>) => void> = [];
  class TestChannel {
    private handler: ((event: MessageEvent<unknown>) => void) | null = null;
    set onmessage(value: ((event: MessageEvent<unknown>) => void) | null) {
      this.handler = value;
      if (value !== null) retained.push(value);
    }
    get onmessage(): ((event: MessageEvent<unknown>) => void) | null { return this.handler; }
    postMessage(): void {}
    close(): void { throw new Error("close failed"); }
  }
  vi.stubGlobal("BroadcastChannel", TestChannel);
  const changed = vi.fn();
  const unsubscribe = subscribeSessionNotificationPreferenceChange(changed);

  expect(() => unsubscribe()).not.toThrow();
  expect(() => unsubscribe()).not.toThrow();
  retained[0]?.({
    data: { kind: "session-notification-preference-changed" }
  } as MessageEvent<unknown>);

  expect(changed).not.toHaveBeenCalled();
});

it("isolates constructor, post, and close failures", () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  expect(() => publishSessionNotificationPreferenceChange()).not.toThrow();
  expect(() => subscribeSessionNotificationPreferenceChange(vi.fn())()).not.toThrow();

  class FailingChannel {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    postMessage(): void { throw new Error("post failed"); }
    close(): void { throw new Error("close failed"); }
  }
  vi.stubGlobal("BroadcastChannel", FailingChannel);
  expect(() => publishSessionNotificationPreferenceChange()).not.toThrow();

  class FailingConstructor {
    constructor() { throw new Error("constructor failed"); }
  }
  vi.stubGlobal("BroadcastChannel", FailingConstructor);
  expect(() => publishSessionNotificationPreferenceChange()).not.toThrow();
  expect(() => subscribeSessionNotificationPreferenceChange(vi.fn())()).not.toThrow();
});

it("projects only the normalized session-notification preference", () => {
  const current: UiPreferences = {
    ...DEFAULT_UI_PREFERENCES,
    theme: "light",
    locale: "zh-CN",
    sessionNotificationsEnabled: false
  };
  const source: UiPreferences = {
    ...DEFAULT_UI_PREFERENCES,
    theme: "dark",
    locale: "en",
    sessionNotificationsEnabled: true
  };

  const projected = withSessionNotificationPreference(current, source);
  expect(projected).toEqual({ ...current, sessionNotificationsEnabled: true });
  expect(sameSessionNotificationPreference(projected, source)).toBe(true);
  expect(withSessionNotificationPreference(projected, source)).toBe(projected);
  expect(sameSessionNotificationPreference(current, { ...current, theme: "dark" })).toBe(true);
});
