// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_MENUBAR_SETTINGS, type MenubarSettings, type MenubarState } from "@joko/contracts";
import { translate } from "../i18n.js";
import { DesktopMenuBarSetting } from "./DesktopMenuBarSetting.js";

let root: Root, host: HTMLDivElement, previous: JokoDesktopApi | undefined;
const t = (key: Parameters<typeof translate>[1]) => translate("en", key);
const off: MenubarState = { available: true, enabled: false, settings: { ...DEFAULT_MENUBAR_SETTINGS, enabled: false } };
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  previous = window.jokoDesktop; host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: previous }); host.remove();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
const toggle = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!;
const checked = () => toggle().getAttribute("aria-checked") === "true";
function fixture() {
  let settingsChanged: ((settings: MenubarSettings) => void) | undefined;
  const unsubscribe = vi.fn();
  const api = { get: vi.fn<() => Promise<MenubarState>>().mockResolvedValue(off),
    setEnabled: vi.fn<(enabled: boolean) => Promise<MenubarState>>(),
    onSettings: vi.fn((listener: (settings: MenubarSettings) => void) => { settingsChanged = listener; return unsubscribe; }) };
  return { api, unsubscribe, broadcast: (settings: MenubarSettings) => settingsChanged?.(settings),
    desktop: { platform: "darwin", capabilities: ["native.menuBar"], menuBar: api } as unknown as JokoDesktopApi };
}
async function render(value: JokoDesktopApi | undefined) {
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value });
  await act(async () => root.render(<DesktopMenuBarSetting t={t} />));
}
it("shows acknowledged device preferences, saves explicit toggles and rereads native changes", async () => {
  const f = fixture(); await render(f.desktop); expect(checked()).toBe(false);
  f.api.setEnabled.mockResolvedValueOnce({ ...off, enabled: true, settings: { ...off.settings, enabled: true } });
  await act(async () => toggle().click()); expect(f.api.setEnabled).toHaveBeenCalledExactlyOnceWith(true); expect(checked()).toBe(true);
  await act(async () => window.dispatchEvent(new Event("focus"))); expect(checked()).toBe(false);
  await render(undefined); expect(f.unsubscribe).toHaveBeenCalledOnce(); expect(host.textContent).toBe("");
});
it("recovers a failed save through an explicit retry and shows unsupported macOS state", async () => {
  const f = fixture(); await render(f.desktop);
  f.api.setEnabled.mockRejectedValueOnce(new Error("disk unavailable")); await act(async () => toggle().click());
  expect(checked()).toBe(false); expect(host.querySelector('[role="alert"]')).not.toBeNull();
  f.api.setEnabled.mockResolvedValueOnce({ ...off, enabled: true, settings: { ...off.settings, enabled: true } });
  await act(async () => [...host.querySelectorAll("button")].find(item => item.textContent === "Retry")!.click());
  expect(checked()).toBe(true); expect(host.querySelector('[role="alert"]')).toBeNull();
  f.api.get.mockResolvedValueOnce({ ...off, available: false });
  await act(async () => window.dispatchEvent(new Event("focus"))); expect(toggle().disabled).toBe(true);
  expect(host.textContent).toContain("macOS 14");
});
it("a preference broadcast during the initial read cannot strand the loading state or adopt a stale result", async () => {
  const f = fixture(); let finish!: (state: MenubarState) => void;
  f.api.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })); await render(f.desktop);
  const enabled = { ...off, enabled: true, settings: { ...off.settings, enabled: true } };
  f.api.get.mockResolvedValueOnce(enabled); await act(async () => f.broadcast(enabled.settings));
  await act(async () => finish(off)); expect(checked()).toBe(true); expect(toggle().disabled).toBe(false);
});

it("shows native startup failure and retries it through an explicit user action", async () => {
  const f = fixture(); f.api.get.mockResolvedValueOnce({ ...off, error: "helper" }); await render(f.desktop);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not start");
  f.api.setEnabled.mockResolvedValueOnce({ ...off, enabled: true, settings: { ...off.settings, enabled: true } });
  await act(async () => [...host.querySelectorAll("button")].find(item => item.textContent === "Retry")!.click());
  expect(f.api.setEnabled).toHaveBeenCalledExactlyOnceWith(true); expect(host.querySelector('[role="alert"]')).toBeNull();
});
