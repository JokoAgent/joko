// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceDictionaryReadOnlyView } from "@joko/contracts";
import { MobileVoiceDictionaryReadOnlyScreen } from "./MobileVoiceDictionaryReadOnlyScreen";
import { MobileVoiceDictionaryReadOnlyController } from "./mobile-voice-dictionary-readonly-controller";
import { MobileVoiceDictionaryReadOnlyCache } from "./mobile-voice-dictionary-readonly-cache";
import { mobileMessage } from "./mobile-messages";
import { MOBILE_SUPPORTED_LOCALES, type MobileSupportedLocale } from "./mobile-locale-preference";
import { dictionaryWatchFixture } from "./test/voice-dictionary-watch";
import { memoryReadOnlyCache, readOnlyProfile, readOnlyValue } from "./test/voice-dictionary-readonly";

const native = vi.hoisted(() => ({ alert: vi.fn(), back: undefined as (() => boolean) | undefined }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ children, accessibilityLabel, accessibilityRole, accessibilityState,
    onPress, style: _style, ...props }: Record<string, unknown> & { children?: React.ReactNode,
      accessibilityState?: { disabled?: boolean }, onPress?: () => void }) => React.createElement(tag, {
      ...props, "aria-label": accessibilityLabel, role: accessibilityRole,
      "aria-disabled": accessibilityState?.disabled, onClick: onPress }, children);
  return { Alert: { alert: native.alert },
    BackHandler: { addEventListener: (_name: string, callback: () => boolean) => {
      native.back = callback; return { remove: () => { if (native.back === callback) native.back = undefined; } };
    } },
    FlatList: ({ data, keyExtractor, renderItem, ListHeaderComponent, ListEmptyComponent }: {
      data: readonly { key: string }[], keyExtractor: (entry: { key: string }) => string,
      renderItem: (args: { item: { key: string } }) => React.ReactNode,
      ListHeaderComponent: React.ReactNode, ListEmptyComponent: React.ReactNode
    }) => React.createElement("div", {}, ListHeaderComponent, data.length ? data.map((item) =>
      React.createElement("div", { key: keyExtractor(item) }, renderItem({ item }))) : ListEmptyComponent),
    Pressable: element("button"), Text: element("span"), View: element("div"), StyleSheet: { create: <T,>(value: T) => value } };
});

const colors = { background: "#fafafa", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd",
  accent: "#f90", negative: "#b00", brandBackground: "#fff0d0" };
const roots: Root[] = [];
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); native.alert.mockReset(); });
function button(container: HTMLElement, label: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.getAttribute("aria-label") === label);
  if (!result) throw new Error(`Missing button: ${label}`); return result;
}
function mount(controller: MobileVoiceDictionaryReadOnlyController, locale: MobileSupportedLocale = "en") {
  const container = document.createElement("div"); const root = createRoot(container); roots.push(root);
  const onBack = vi.fn();
  const render = (foreground: boolean) => act(() => root.render(createElement(MobileVoiceDictionaryReadOnlyScreen,
    { colors, locale, controller, foreground, onBack })));
  render(true); return { container, onBack, render };
}
async function settle(check: () => void): Promise<void> { await act(async () => { await vi.waitFor(check); }); }

describe("native shared dictionary readonly screen", () => {
  it.each(MOBILE_SUPPORTED_LOCALES)("renders live, disabled and foreground/read-only states with refresh and back in %s", async (locale) => {
    const { cache } = memoryReadOnlyCache(); const profile = readOnlyProfile(); const updates = dictionaryWatchFixture<VoiceDictionaryReadOnlyView>();
    let latest = readOnlyValue();
    const connect = vi.fn(async (_id: string, signal: AbortSignal) => ({ profile, ownerKey: "source", isCurrent: () => !signal.aborted,
      getVoiceInputDictionaryReadOnly: async () => latest, watchVoiceInputDictionaryReadOnly: updates.watch }));
    const controller = new MobileVoiceDictionaryReadOnlyController(cache, connect); controller.setSources([profile]);
    const view = mount(controller, locale); const t = (key: Parameters<typeof mobileMessage>[1]) => mobileMessage(locale, key);
    await settle(() => { expect(view.container.textContent).toContain("Joko"); expect(updates.count).toBe(1); });
    expect(view.container.querySelectorAll("input,textarea,[role=switch]")).toHaveLength(0);
    expect(view.container.textContent).toContain("jo ko"); expect(view.container.textContent).toContain(t("settings.voiceReadonly.ready"));
    latest = readOnlyValue(3n, { syncEnabled: false, entries: [] });
    act(() => updates.push(latest));
    await settle(() => expect(view.container.textContent).toContain(t("settings.voiceReadonly.off")));
    expect(view.container.textContent).not.toContain("jo ko"); expect(view.container.textContent).toContain(t("settings.voiceReadonly.empty"));
    await act(async () => { button(view.container, t("settings.voiceReadonly.refresh")).click(); });
    expect(connect).toHaveBeenCalledTimes(2);
    view.render(false); expect(updates.count).toBe(0);
    expect(button(view.container, t("settings.voiceReadonly.refresh")).disabled).toBe(true);
    view.render(true); await settle(() => expect(updates.count).toBe(1));
    expect(connect).toHaveBeenCalledTimes(3);
    act(() => { expect(native.back?.()).toBe(true); }); expect(view.onBack).toHaveBeenCalledOnce();
  });

  it("shows offline cached content and fences a rebuild confirmation across background and source changes", async () => {
    const { cache, storage, values } = memoryReadOnlyCache(); const a = readOnlyProfile(); const b = readOnlyProfile("b");
    await cache.apply(a, readOnlyValue(), cache.lease(a));
    await cache.apply(b, readOnlyValue(), cache.lease(b));
    const key = [...values.keys()].find((entry) => entry.includes("profile-a"))!; values.set(key, "damaged");
    const controller = new MobileVoiceDictionaryReadOnlyController(new MobileVoiceDictionaryReadOnlyCache(storage), async () => { throw new Error("Offline"); });
    controller.setSources([a, b]); const rebuild = vi.spyOn(controller, "rebuildCache"); const view = mount(controller);
    await settle(() => { expect(controller.state.refreshing).toBe(false); expect(view.container.textContent).toContain("Joko"); });
    expect(view.container.textContent).toContain(mobileMessage("en", "settings.voiceReadonly.offline"));
    expect(view.container.textContent).toContain(mobileMessage("en", "settings.voiceReadonly.cacheError"));
    act(() => button(view.container, mobileMessage("en", "settings.voiceReadonly.rebuild", { node: a.displayName })).click());
    const confirm = native.alert.mock.calls[0]![2][1].onPress as () => void;
    view.render(false); view.render(true); await settle(() => expect(controller.state.refreshing).toBe(false));
    act(() => confirm()); expect(rebuild).not.toHaveBeenCalled();
    act(() => button(view.container, mobileMessage("en", "settings.voiceReadonly.rebuild", { node: a.displayName })).click());
    const currentConfirm = native.alert.mock.calls[1]![2][1].onPress as () => void;
    await act(async () => currentConfirm()); await settle(() => expect(controller.state.refreshing).toBe(false));
    expect(rebuild).toHaveBeenCalledExactlyOnceWith(a.profileId); expect(values.get(key)).toBeUndefined();
    expect(controller.state.selected?.profile.profileId).toBe(b.profileId);
  });
});
