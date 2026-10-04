import { afterEach, expect, it, vi } from "vitest";
import type { AppShortcutCombo } from "./app-shortcuts.js";
import {
  publishAppShortcutPreferencesChange,
  sameAppShortcutProjection,
  subscribeAppShortcutPreferencesChange,
  withAppShortcutProjection
} from "./app-shortcut-preference-sync.js";
import { DEFAULT_UI_PREFERENCES, type UiPreferences } from "./local-state.js";

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
  const close = subscribeAppShortcutPreferencesChange(changed);

  publishAppShortcutPreferencesChange();
  await Promise.resolve();
  expect(changed).toHaveBeenCalledOnce();
  expect(sent).toEqual([{ kind: "app-shortcut-preferences-changed" }]);

  const sender = new TestChannel("joko:app-shortcut-preferences:v1");
  sender.postMessage({
    kind: "app-shortcut-preferences-changed",
    appShortcutOverrides: { "browser-back": shortcut("KeyG") }
  });
  sender.postMessage({ kind: "other" });
  sender.postMessage("app-shortcut-preferences-changed");
  await Promise.resolve();
  expect(changed).toHaveBeenCalledOnce();
  close();
  sender.close();
});

it("compares every known normalized override and projects only the shortcut subtree", () => {
  const browserBack = shortcut("KeyG", "g");
  const search = shortcut("KeyH", "h", { shift: true });
  const current: UiPreferences = {
    ...DEFAULT_UI_PREFERENCES,
    theme: "light",
    locale: "zh-CN",
    composerSendShortcut: "modifier-enter",
    appShortcutOverrides: { "browser-back": browserBack }
  };
  const source: UiPreferences = {
    ...DEFAULT_UI_PREFERENCES,
    theme: "dark",
    locale: "en",
    composerSendShortcut: "enter",
    appShortcutOverrides: {
      "browser-back": null,
      "search-in-project": search
    }
  };

  const projected = withAppShortcutProjection(current, source);
  expect(projected).toEqual({
    ...current,
    appShortcutOverrides: {
      "browser-back": null,
      "search-in-project": search
    }
  });
  expect(sameAppShortcutProjection(projected, source)).toBe(true);
  expect(withAppShortcutProjection(projected, source)).toBe(projected);
  expect(sameAppShortcutProjection(current, { ...current, locale: "en" })).toBe(true);
  expect(sameAppShortcutProjection(current, {
    ...current,
    appShortcutOverrides: { "browser-back": null }
  })).toBe(false);

  const sameOverridesWithIndependentObjects = {
    ...current,
    appShortcutOverrides: {
      "browser-back": { ...browserBack }
    }
  };
  expect(sameAppShortcutProjection(current, sameOverridesWithIndependentObjects)).toBe(true);
  expect(withAppShortcutProjection(current, sameOverridesWithIndependentObjects)).toBe(current);
  expect(sameAppShortcutProjection(current, {
    ...current,
    appShortcutOverrides: { "browser-back": { ...browserBack, key: "G" } }
  })).toBe(false);
});

function shortcut(
  code: string,
  key?: string,
  modifiers: Partial<Pick<AppShortcutCombo, "meta" | "ctrl" | "alt" | "shift">> = {}
): AppShortcutCombo {
  return {
    code,
    ...(key === undefined ? {} : { key }),
    meta: false,
    ctrl: true,
    alt: false,
    shift: false,
    ...modifiers
  };
}
