// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileAndroidInstallController } from "./mobile-android-install-controller";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const shared = vi.hoisted(() => ({ controller: undefined as unknown as MobileAndroidInstallController,
  close: undefined as (() => void) | undefined }));
vi.mock("./mobile-android-installer", () => ({ mobileAndroidInstaller: {
  subscribe: (listener: () => void) => shared.controller.subscribe(listener),
  getSnapshot: () => shared.controller.getSnapshot(),
  retry: () => shared.controller.retry(),
  close: () => shared.controller.close(),
  browser: () => shared.controller.browser()
} }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 20 }) }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ children, onPress, accessibilityLabel, accessibilityRole }: {
    children?: React.ReactNode; onPress?: () => void; accessibilityLabel?: string; accessibilityRole?: string;
  }) => React.createElement(tag, { onClick: onPress, "aria-label": accessibilityLabel, role: accessibilityRole }, children);
  return {
    View: element("div"), Text: element("span"), Pressable: element("button"),
    ActivityIndicator: () => React.createElement("progress"),
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
    Modal: ({ children, visible, onRequestClose }: { children: React.ReactNode; visible: boolean; onRequestClose: () => void }) => {
      shared.close = visible ? onRequestClose : undefined;
      return visible ? React.createElement("div", { role: "dialog" }, children) : null;
    }
  };
});
import { MobileAndroidUpdateSheet } from "./MobileAndroidUpdateSheet";

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});
const colors = { background: "#fff", surface: "#fff", ink: "#111", muted: "#555", border: "#ddd",
  accent: "#ff9800", negative: "#c00", brandBackground: "#fff1db" };
const target = { version: "1.2.3", installUrl: "https://download.joko.app/mobile.apk" };

describe("MobileAndroidUpdateSheet", () => {
  it("requires the explicit permission action, exposes progress/cancel, and system Back cancels the transfer", async () => {
    const requestPermission = vi.fn(async () => true);
    let progress!: (value: number | null) => void;
    let signal!: AbortSignal;
    shared.controller = new MobileAndroidInstallController({ supported: () => true,
      hasPermission: async () => false, requestPermission,
      download: async (_url, abort, update) => { signal = abort; progress = update; return new Promise(() => undefined); },
      install: async () => undefined, remove: async () => undefined, openBrowser: async () => undefined });
    render();
    await act(async () => { shared.controller.start(target); });
    expect(container.textContent).toContain("needs permission");
    expect(requestPermission).not.toHaveBeenCalled();
    await act(async () => click("Allow Installation"));
    expect(requestPermission).toHaveBeenCalledOnce();
    act(() => progress(0.42));
    expect(container.textContent).toContain("42%");
    expect(container.querySelector('button[aria-label="Retry Update"]')).toBeNull();
    act(() => shared.close?.());
    expect(signal.aborted).toBe(true);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps denial retryable, offers browser fallback, and dismisses after an explicit browser action", async () => {
    const browser = vi.fn(async () => undefined);
    shared.controller = new MobileAndroidInstallController({ supported: () => true,
      hasPermission: async () => false, requestPermission: async () => false,
      download: vi.fn(), install: async () => undefined, remove: async () => undefined, openBrowser: browser });
    render();
    await act(async () => { shared.controller.start(target); });
    await act(async () => click("Allow Installation"));
    expect(container.textContent).toContain("permission is off");
    expect(container.querySelector('button[aria-label="Allow Installation"]')).not.toBeNull();
    await act(async () => click("Download in Browser"));
    expect(browser).toHaveBeenCalledWith(target.installUrl);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});

function render() {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  act(() => root!.render(<MobileAndroidUpdateSheet colors={colors} locale="en" />));
}
function click(label: string) {
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
}
