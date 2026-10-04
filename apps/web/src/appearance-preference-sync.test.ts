import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_UI_PREFERENCES } from "./local-state.js";
import {
  publishAppearancePreferencesChange,
  sameAppearanceProjection,
  subscribeAppearancePreferencesChange,
  withAppearanceProjection
} from "./appearance-preference-sync.js";

afterEach(() => vi.unstubAllGlobals());

it("broadcasts only a content-free current-v1 invalidation and ignores malformed messages", async () => {
  const channels = new Set<TestChannel>();
  const sent: unknown[] = [];
  class TestChannel {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    constructor(readonly name: string) { channels.add(this); }
    postMessage(value: unknown): void {
      sent.push(value);
      for (const peer of channels) if (peer !== this && peer.name === this.name) {
        queueMicrotask(() => peer.onmessage?.({ data: value } as MessageEvent<unknown>));
      }
    }
    close(): void { channels.delete(this); }
  }
  vi.stubGlobal("BroadcastChannel", TestChannel);
  const changed = vi.fn();
  const close = subscribeAppearancePreferencesChange(changed);

  publishAppearancePreferencesChange();
  await Promise.resolve();
  expect(changed).toHaveBeenCalledOnce();
  expect(sent).toEqual([{ kind: "appearance-preferences-changed" }]);

  const sender = new TestChannel("joko:appearance-preferences:v1");
  sender.postMessage({ kind: "appearance-preferences-changed", uiFamily: "private" });
  sender.postMessage({ kind: "other" });
  sender.postMessage("appearance-preferences-changed");
  await Promise.resolve();
  expect(changed).toHaveBeenCalledOnce();
  close();
  sender.close();
});

it("projects only the six shared appearance fields", () => {
  const current = {
    ...DEFAULT_UI_PREFERENCES,
    theme: "light" as const,
    locale: "zh-CN" as const,
    composerSendShortcut: "modifier-enter" as const,
    windowZoom: 1.5
  };
  const source = {
    ...DEFAULT_UI_PREFERENCES,
    uiFamily: "Inter",
    codeFamily: "Mono",
    uiSize: 18,
    codeSize: 16,
    theme: "dark" as const,
    locale: "en" as const,
    composerSendShortcut: "enter" as const,
    windowZoom: 2
  };

  const projected = withAppearanceProjection(current, source);
  expect(projected).toMatchObject({
    theme: "dark",
    uiFamily: "Inter",
    codeFamily: "Mono",
    uiSize: 18,
    codeSize: 16,
    windowZoom: 2,
    locale: "zh-CN",
    composerSendShortcut: "modifier-enter"
  });
  expect(sameAppearanceProjection(projected, source)).toBe(true);
  expect(withAppearanceProjection(projected, source)).toBe(projected);
  expect(sameAppearanceProjection(current, { ...current, theme: "dark" })).toBe(false);
  expect(sameAppearanceProjection(current, { ...current, locale: "en" })).toBe(true);
});
