// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { translate } from "../i18n.js";
import { DesktopLoginItemSetting } from "./DesktopLoginItemSetting.js";

let root: Root, host: HTMLDivElement, previous: JokoDesktopApi | undefined;
const t = (key: Parameters<typeof translate>[1]) => translate("en", key);
const off = { available: true, enabled: false, requiresApproval: false };
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
const retry = () => [...host.querySelectorAll("button")].find(item => item.textContent === "Retry")!;
function fixture(platform = "darwin") {
  const api = { get: vi.fn<() => Promise<JokoDesktopLoginItemState>>().mockResolvedValue(off),
    set: vi.fn<(enabled: boolean) => Promise<JokoDesktopLoginItemState>>() };
  return { api, desktop: { platform, capabilities: platform === "linux" ? [] : ["window.loginItem"], loginItem: api } as unknown as JokoDesktopApi };
}
async function render(value: JokoDesktopApi | undefined) {
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value });
  await act(async () => root.render(<DesktopLoginItemSetting t={t} />));
}
it("uses OS state, displays macOS approval, rereads on focus and removes the item explicitly", async () => {
  const f = fixture(); await render(f.desktop);
  expect(checked()).toBe(false); expect(f.api.set).not.toHaveBeenCalled();
  f.api.set.mockResolvedValueOnce({ ...off, requiresApproval: true });
  await act(async () => toggle().click());
  expect(f.api.set).toHaveBeenCalledWith(true); expect(checked()).toBe(true);
  expect(host.textContent).toContain("System Settings");
  f.api.get.mockResolvedValueOnce({ ...off, enabled: true });
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(host.textContent).not.toContain("System Settings");
  f.api.set.mockResolvedValueOnce(off); await act(async () => toggle().click());
  expect(f.api.set).toHaveBeenLastCalledWith(false); expect(checked()).toBe(false);
});
it("recovers load/save errors using the actual OS choice and an explicit retry", async () => {
  const f = fixture("win32"); f.api.get.mockRejectedValueOnce(new Error("unavailable")); await render(f.desktop);
  expect(toggle().disabled).toBe(true); expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => retry().click()); expect(toggle().disabled).toBe(false);
  f.api.set.mockRejectedValueOnce(new Error("not confirmed")); f.api.get.mockResolvedValueOnce(off);
  await act(async () => toggle().click()); expect(checked()).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("current system choice");
  f.api.set.mockResolvedValueOnce({ ...off, enabled: true }); await act(async () => retry().click());
  expect(f.api.set).toHaveBeenLastCalledWith(true); expect(checked()).toBe(true);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it("fences a late old read and shows installed-only state without registering startup", async () => {
  const old = fixture(); let finish!: (value: JokoDesktopLoginItemState) => void;
  old.api.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })); await render(old.desktop);
  const installed = fixture(); installed.api.get.mockResolvedValue({ ...off, available: false, unavailableReason: "development" });
  await render(installed.desktop); await act(async () => finish({ ...off, enabled: true }));
  expect(toggle().disabled).toBe(true); expect(checked()).toBe(false); expect(host.textContent).toContain("installed");
  expect(installed.api.set).not.toHaveBeenCalled();
  const linux = fixture("linux"); await render(linux.desktop); expect(host.textContent).toBe(""); expect(linux.api.get).not.toHaveBeenCalled();
  await render(undefined); expect(host.textContent).toBe("");
});
