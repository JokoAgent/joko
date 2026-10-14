// @vitest-environment jsdom
import { act, useRef } from "react";
import type { JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot } from "../model.js";
import { SettingsPage, SETTINGS_NAV_SECTION_IDS } from "./SettingsPage.js";
import { SettingsSearchBox } from "./SettingsSearchBox.js";
import { buildSettingsSearchDocuments, searchSettings, settingsSearchEntryFromHash, settingsSearchHash, type SettingsSearchEntry } from "./settings-search.js";
import { resolveSettingsSearchTarget, useSettingsSearchTarget } from "./use-settings-search-target.js";

const t = (key: Parameters<typeof translate>[1], values?: Readonly<Record<string, string | number>>): string => translate("en", key, values);
const context = { visibleSections: SETTINGS_NAV_SECTION_IDS.filter((id) => id !== "taskStatus"), desktopCapabilities: [] };
const roots: Root[] = [];
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const scroll = vi.fn();

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear(); frames = new Map(); nextFrame = 0; scroll.mockClear();
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: undefined });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scroll });
});
afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren(); window.history.replaceState(null, "", "/");
  vi.useRealTimers(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, "jokoDesktop");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("settings search", () => {
  it("searches unopened pages in the current language and English with Unicode normalization and token conjunction", () => {
    const documents = buildSettingsSearchDocuments((key, values) => translate("zh-CN", key, values), context);
    expect(searchSettings(documents, "语言")[0]?.entry.titleKey).toBe("settings.locale");
    expect(searchSettings(documents, "ＬＡＮＧＵＡＧＥ").some(({ entry }) => entry.titleKey === "settings.locale")).toBe(true);
    expect(searchSettings(documents, "code font")[0]?.entry.titleKey).toBe("settings.appearance.codeFamily");
    expect(searchSettings(documents, "font nonexistent")).toEqual([]);
    const english = buildSettingsSearchDocuments(t, context);
    expect(searchSettings(english, "theme")[0]?.title).toBe("Theme");
    expect(searchSettings(english, " font ").map(({ entry }) => entry.id)).toEqual(searchSettings(english, "FONT").map(({ entry }) => entry.id));
  });

  it("keeps platform entries out of the catalog and accepts only an exact visible navigation identity", () => {
    const documents = buildSettingsSearchDocuments(t, context);
    expect(documents.some(({ entry }) => entry.section === "taskStatus" || entry.capability !== undefined)).toBe(false);
    const language = required(documents.find(({ entry }) => entry.titleKey === "settings.locale")).entry;
    const hash = settingsSearchHash(language);
    expect(settingsSearchEntryFromHash(hash, "general", "appearance", documents)).toBe(language);
    expect(settingsSearchEntryFromHash(hash, "voice", undefined, documents)).toBeUndefined();
    expect(settingsSearchEntryFromHash(hash + "&search=" + encodeURIComponent(language.id), "general", "appearance", documents)).toBeUndefined();
    expect(settingsSearchEntryFromHash("#/settings/general/appearance?search=locale", "general", "appearance", documents)).toBeUndefined();
    const native = buildSettingsSearchDocuments(t, { visibleSections: SETTINGS_NAV_SECTION_IDS, desktopCapabilities: ["native.taskStatus", "appearance.wallpaper"] });
    expect(native.some(({ entry }) => entry.section === "taskStatus")).toBe(true);
    expect(native.some(({ entry }) => entry.titleKey === "settings.wallpaper.title")).toBe(true);
  });

  it("supports keyboard wrapping, IME, explicit selection, empty results and Escape without losing input focus", async () => {
    const onSelect = vi.fn();
    const container = await mount(<SettingsSearchBox documents={buildSettingsSearchDocuments(t, context)} onSelect={onSelect} t={t} />);
    const input = required(container.querySelector<HTMLInputElement>('[role="combobox"]'));
    input.focus(); await change(input, "font");
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.length).toBeGreaterThan(1);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(input.getAttribute("aria-activedescendant")).toBe(options.at(-1)?.id);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onSelect).toHaveBeenCalledTimes(1); expect(input.value).toBe("");
    await change(input, "no-result-for-this-query");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("No matching settings.");
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(input.value).toBe(""); expect(input.getAttribute("aria-expanded")).toBe("false"); expect(document.activeElement).toBe(input);
  });

  it("leaves the nested resource page for the real theme control, repeats highlighting and keeps navigation out of browser history", async () => {
    window.history.replaceState({ owner: "settings" }, "", "/#/settings/general/pi");
    const controller = controllerFixture(); const before = window.history.length;
    const container = await mount(<SettingsPage controller={controller} snapshot={emptySnapshot()} locale="en" runAction={(_key, action) => { void action(); }} t={t} />);
    expect(container.querySelector("#settings-subsection-pi")).not.toBeNull();
    const input = required(container.querySelector<HTMLInputElement>('[role="combobox"]'));
    await change(input, "Theme"); await chooseFirst(container); await flushFrames();
    const row = required(container.querySelector('[aria-label="Theme"]')?.closest<HTMLElement>(".setting-row"));
    expect(container.querySelector("#settings-subsection-pi")).toBeNull();
    expect(row.classList.contains("settings-search-target-highlight")).toBe(true);
    expect(document.activeElement).toBe(row);
    expect(window.history.length).toBe(before); expect(window.history.state).toEqual({ owner: "settings" });
    const hash = window.location.hash;
    const scrolls = scroll.mock.calls.length;
    await change(input, "Theme"); await chooseFirst(container); await flushFrames();
    expect(window.location.hash).toBe(hash); expect(scroll).toHaveBeenCalledTimes(scrolls + 1);
    expect(controller.setTheme).not.toHaveBeenCalled();
    await change(input, "Code font"); await chooseFirst(container); await flushFrames();
    const font = required(container.querySelector<HTMLElement>(".settings-search-target-highlight"));
    expect(font.classList.contains("appearance-font-family")).toBe(true);
    expect(font.textContent).toContain("Code font"); expect(font.textContent).not.toContain("Interface font");
    await act(async () => required(container.querySelector<HTMLButtonElement>("#settings-tab-shortcuts")).click());
    expect(row.classList.contains("settings-search-target-highlight")).toBe(false); expect(row.hasAttribute("tabindex")).toBe(false);
  });

  it("switches from the compact settings index to the target and returns to a clean index", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(max-width: 720px)", addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    window.history.replaceState(null, "", "/#/settings");
    const container = await mount(<SettingsPage controller={controllerFixture()} snapshot={emptySnapshot()} locale="en" runAction={(_key, action) => { void action(); }} t={t} />);
    expect(container.querySelector("main")?.dataset.mobileMode).toBe("index");
    await change(required(container.querySelector<HTMLInputElement>('[role="combobox"]')), "Language");
    await chooseFirst(container); await flushFrames();
    expect(container.querySelector("main")?.dataset.mobileMode).toBe("detail");
    expect(container.querySelector(".settings-search-target-highlight")?.textContent).toContain("Language");
    await act(async () => required(container.querySelector<HTMLButtonElement>(`[aria-label="${t("settings.mobileBackToList")}"]`)).click());
    expect(container.querySelector("main")?.dataset.mobileMode).toBe("index");
    expect(container.querySelector(".settings-search-target-highlight")).toBeNull(); expect(window.location.hash).toBe("#/settings");
  });

  it("opens credentials and usage through the real provider workbench instead of retaining its prior nested selection", async () => {
    const container = await mount(<SettingsPage controller={controllerFixture()} snapshot={emptySnapshot()} locale="en" runAction={(_key, action) => { void action(); }} t={t} />);
    const input = required(container.querySelector<HTMLInputElement>('[role="combobox"]'));
    await change(input, "Credentials"); await chooseFirst(container); await flushFrames();
    expect(container.querySelector("#settings-tab-providers")?.getAttribute("aria-selected")).toBe("true");
    expect(window.location.hash).toBe("#/settings/providers/credentials?search=providers.credentials");
    expect(container.querySelector(".provider-workbench")?.textContent).toContain("Credentials");
    await change(input, "Usage");
    await act(async () => required([...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.querySelector("strong")?.textContent === t("usage.title"))).click());
    await flushFrames();
    expect(window.location.hash).toBe("#/settings/providers?search=providers.usage");
    expect(container.querySelector(".usage-history-section")).not.toBeNull();
  });

  it("falls back to the declared parent for hidden or ambiguous optional controls without inspecting input values", () => {
    const entry = required(buildSettingsSearchDocuments(t, context).find(({ entry }) => entry.titleKey === "settings.locale")).entry;
    const container = document.createElement("div");
    container.innerHTML = `<section id="${entry.fallbackTargetId}"><div class="setting-row" hidden><strong>Language</strong></div><input value="Language"></section>`;
    document.body.append(container);
    const parent = required(container.querySelector<HTMLElement>("section"));
    expect(resolveSettingsSearchTarget(container, entry, t)).toBe(parent);
    parent.innerHTML = '<div class="setting-row"><strong>Language</strong></div><div class="setting-row"><strong>Language</strong></div>';
    expect(resolveSettingsSearchTarget(container, entry, t)).toBe(parent);
  });

  it("cleans highlights, temporary focus markers and pending frames when a target changes or leaves", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)", addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const entry = required(buildSettingsSearchDocuments(t, context).find(({ entry }) => entry.titleKey === "settings.locale")).entry;
    function Target({ activation }: { readonly activation: string }): JSX.Element {
      const ref = useRef<HTMLDivElement>(null); useSettingsSearchTarget(entry, ref, activation, t);
      return <div ref={ref}><section id={entry.fallbackTargetId}><div className="setting-row"><strong>Language</strong></div></section></div>;
    }
    const container = await mount(<Target activation="one" />); await flushFrames();
    const row = required(container.querySelector<HTMLElement>(".setting-row"));
    expect(row.classList.contains("settings-search-target-highlight")).toBe(true);
    expect(scroll).toHaveBeenLastCalledWith({ top: 0, behavior: "auto" });
    await act(async () => vi.advanceTimersByTime(1600)); expect(row.classList.contains("settings-search-target-highlight")).toBe(false);
    const root = roots.at(-1)!;
    await act(async () => root.render(<Target activation="two" />));
    expect(row.hasAttribute("tabindex")).toBe(false); expect(frames.size).toBe(1);
    await act(async () => root.render(<></>)); expect(frames.size).toBe(0);
  });
});

function controllerFixture(): AppController {
  return { state: { snapshot: emptySnapshot(), connectionState: "disconnected", preferences: { ...DEFAULT_UI_PREFERENCES }, systemLocale: "en", effectiveLocale: "en", profiles: [], automaticConnectionAvailable: false },
    setTheme: vi.fn(async () => undefined), setLocale: vi.fn(async () => undefined), setSessionNotificationsEnabled: vi.fn(async () => undefined),
    setComposerSendShortcut: vi.fn(async () => undefined), resetLayoutPreferences: vi.fn(async () => undefined), navigate: vi.fn(),
    getUsageReport: vi.fn(async () => { throw new Error("No connected usage reader"); }) } as unknown as AppController;
}
async function mount(element: JSX.Element): Promise<HTMLDivElement> {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root);
  await act(async () => root.render(element)); return container;
}
async function change(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function chooseFirst(container: HTMLElement): Promise<void> {
  await act(async () => required(container.querySelector<HTMLButtonElement>('[role="option"]')).click());
}
async function flushFrames(): Promise<void> {
  await act(async () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); });
}
function required<T>(value: T | null | undefined): T { if (value == null) throw new Error("Expected rendered element"); return value; }
