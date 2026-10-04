import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_UI_PREFERENCES, type UiPreferences } from "./local-state.js";
import {
  publishLocalePreferenceChange,
  sameLocalePreference,
  subscribeLocalePreferenceChange,
  withLocalePreference
} from "./locale-preference-sync.js";

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
  const unsubscribe = subscribeLocalePreferenceChange(changed);

  publishLocalePreferenceChange();
  await Promise.resolve();
  expect(changed).toHaveBeenCalledOnce();
  expect(sent).toEqual([{
    name: "joko:locale-preference:v1",
    value: { kind: "locale-preference-changed" }
  }]);

  const sender = new TestChannel("joko:locale-preference:v1");
  sender.postMessage({ kind: "locale-preference-changed", locale: "zh-CN" });
  sender.postMessage({ kind: "other" });
  sender.postMessage("locale-preference-changed");
  sender.postMessage(["locale-preference-changed"]);
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
  const unsubscribe = subscribeLocalePreferenceChange(changed);

  expect(() => unsubscribe()).not.toThrow();
  expect(() => unsubscribe()).not.toThrow();
  retained[0]?.({ data: { kind: "locale-preference-changed" } } as MessageEvent<unknown>);

  expect(changed).not.toHaveBeenCalled();
});

it("isolates constructor, post, and close failures", () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  expect(() => publishLocalePreferenceChange()).not.toThrow();
  expect(() => subscribeLocalePreferenceChange(vi.fn())()).not.toThrow();

  class FailingChannel {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    postMessage(): void { throw new Error("post failed"); }
    close(): void { throw new Error("close failed"); }
  }
  vi.stubGlobal("BroadcastChannel", FailingChannel);
  expect(() => publishLocalePreferenceChange()).not.toThrow();

  class FailingConstructor {
    constructor() { throw new Error("constructor failed"); }
  }
  vi.stubGlobal("BroadcastChannel", FailingConstructor);
  expect(() => publishLocalePreferenceChange()).not.toThrow();
  expect(() => subscribeLocalePreferenceChange(vi.fn())()).not.toThrow();
});

it("projects only the normalized locale preference", () => {
  const current: UiPreferences = {
    ...DEFAULT_UI_PREFERENCES,
    theme: "light",
    locale: "en",
    sessionNotificationsEnabled: false
  };
  const source: UiPreferences = {
    ...DEFAULT_UI_PREFERENCES,
    theme: "dark",
    locale: "zh-CN",
    sessionNotificationsEnabled: true
  };

  const projected = withLocalePreference(current, source);
  expect(projected).toEqual({ ...current, locale: "zh-CN" });
  expect(sameLocalePreference(projected, source)).toBe(true);
  expect(withLocalePreference(projected, source)).toBe(projected);
  expect(sameLocalePreference(current, { ...current, theme: "dark" })).toBe(true);
});
