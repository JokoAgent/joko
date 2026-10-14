// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppWithController } from "./App.js";
import type { AppController, ControllerState } from "./controller.js";
import { translate } from "./i18n.js";
import { DEFAULT_UI_PREFERENCES } from "./local-state.js";
import { emptySnapshot } from "./model.js";
import { AppearanceSettings } from "./components/SettingsPage.js";
import { WallpaperSection } from "./components/WallpaperSection.js";

type Api = NonNullable<JokoDesktopApi["wallpaper"]>;
const roots: Root[] = [];
const imageId = "a".repeat(64);
const image = { id: imageId, url: `joko-wallpaper://image/${imageId}.webp`, width: 640, height: 480 };
const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate("en", key, values);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.replaceChildren();
  localStorage.clear();
});
afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  Reflect.deleteProperty(window, "jokoDesktop");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("exposes the native wallpaper controls through the actual Appearance settings and retains the image on reset", async () => {
  const native = installNative(settings(1, "custom", 0.4));
  const view = await render(<AppearanceSettings controller={controller()} locale="en" theme="light" onSuccess={() => undefined} onOpenPi={() => undefined} t={t} />);
  const section = wallpaper(view.host);
  expect(section.querySelectorAll('[role="radio"]')).toHaveLength(2);
  await click(section, "Restore default");
  expect(native.api.reset).toHaveBeenCalledWith(1);
  expect(radio(section, "None").getAttribute("aria-checked")).toBe("true");
  expect(section.querySelector("output")?.textContent).toBe("20%");
  expect(button(section, "Replace image")).toBeDefined();
  expect(section.querySelector<HTMLElement>(".wallpaper-settings__preview[style]")?.style.backgroundImage).toContain(image.url);
  await click(section, "Custom image");
  expect(native.api.set).toHaveBeenLastCalledWith({ expectedRevision: 2, mode: "custom" });
  expect(native.api.import).not.toHaveBeenCalled();
});

it("keeps native cancellation and import failure on the confirmed image while busy prevents a duplicate chooser", async () => {
  const native = installNative(settings(1));
  const selected = deferred<JokoDesktopWallpaperImportResult>();
  native.api.import.mockImplementationOnce(() => selected.promise);
  const view = await render(<WallpaperSection t={t} />);
  const section = wallpaper(view.host);
  await act(async () => {
    button(section, "Replace image").click();
    button(section, "Replace image").click();
  });
  expect(native.api.import).toHaveBeenCalledOnce();
  expect(section.getAttribute("aria-busy")).toBe("true");
  expect(button(section, "Remove image").disabled).toBe(true);
  await act(async () => selected.resolve({ cancelled: true }));
  expect(radio(section, "Custom image").getAttribute("aria-checked")).toBe("true");
  expect(section.querySelector('[role="alert"]')).toBeNull();
  native.api.import.mockRejectedValueOnce(new Error("safe import failure"));
  await click(section, "Replace image");
  expect(section.querySelector('[role="alert"]')?.textContent).toContain("The last saved image is kept.");
  expect(section.querySelector<HTMLElement>(".wallpaper-settings__preview[style]")?.style.backgroundImage).toContain(image.url);
  await click(section, "Retry");
  expect(section.querySelector('[role="alert"]')).toBeNull();
});

it("imports, replaces and removes using only the current native revision and restores the neutral selection", async () => {
  const native = installNative(settings(1, "none", 0.2, null));
  const view = await render(<WallpaperSection t={t} />);
  const section = wallpaper(view.host);
  await click(section, "Custom image");
  expect(native.api.import).toHaveBeenCalledWith(1);
  expect(radio(section, "Custom image").getAttribute("aria-checked")).toBe("true");
  await click(section, "Replace image");
  expect(native.api.import).toHaveBeenLastCalledWith(2);
  await click(section, "Remove image");
  expect(native.api.remove).toHaveBeenCalledWith(3);
  expect(radio(section, "None").getAttribute("aria-checked")).toBe("true");
  expect(button(section, "Choose image")).toBeDefined();
  expect([...section.querySelectorAll<HTMLElement>(".wallpaper-settings__preview")].every((preview) => preview.style.backgroundImage === "")).toBe(true);
});

it("serializes optimistic veil edits against the latest confirmed revision and rolls failed edits back", async () => {
  const native = installNative(settings(1));
  const first = deferred<JokoDesktopWallpaperSettings>();
  native.api.set.mockImplementationOnce(() => first.promise);
  const view = await render(<WallpaperSection t={t} />);
  const section = wallpaper(view.host);
  await act(async () => { setRange(section, "0.35"); setRange(section, "0.5"); });
  expect(native.api.set).toHaveBeenCalledOnce();
  expect(native.api.set).toHaveBeenCalledWith({ expectedRevision: 1, maskOpacity: 0.35 });
  expect(section.querySelector("output")?.textContent).toBe("50%");
  native.replace(settings(2, "custom", 0.35));
  await act(async () => first.resolve(native.current()));
  expect(native.api.set).toHaveBeenLastCalledWith({ expectedRevision: 2, maskOpacity: 0.5 });
  expect(section.querySelector("output")?.textContent).toBe("50%");
  native.api.set.mockRejectedValueOnce(new Error("safe write failure"));
  await act(async () => setRange(section, "0.6"));
  expect(section.querySelector("output")?.textContent).toBe("50%");
  expect(section.querySelector('[role="alert"]')?.textContent).toContain("Could not update the wallpaper.");
});

it("subscribes before reading and rejects stale or malformed media projections without adopting a private arbitrary URL", async () => {
  const initial = deferred<JokoDesktopWallpaperSettings>();
  const native = installNative(settings(1));
  native.api.get.mockImplementationOnce(() => { native.order.push("get"); return initial.promise; });
  const view = await render(<WallpaperSection t={t} />);
  expect(native.order.slice(0, 2)).toEqual(["subscribe", "get"]);
  await act(async () => native.publish(settings(3, "none", 0.3)));
  await act(async () => initial.resolve(settings(2)));
  const section = wallpaper(view.host);
  expect(radio(section, "None").getAttribute("aria-checked")).toBe("true");
  expect(section.querySelector("output")?.textContent).toBe("30%");
  await act(async () => native.publish({ ...settings(4), customImage: { ...image, url: "file:///private/image.webp" } }));
  expect(radio(section, "None").getAttribute("aria-checked")).toBe("true");
  expect(section.innerHTML).not.toContain("file:");
});

it("shows an initial read failure and explicitly retries without enabling writes from malformed settings", async () => {
  const native = installNative(settings(1));
  native.api.get.mockResolvedValueOnce({ ...settings(1), maskOpacity: 0.63 });
  const view = await render(<WallpaperSection t={t} />);
  const section = wallpaper(view.host);
  expect(button(section, "Choose image").disabled).toBe(true);
  expect(section.querySelector('[role="alert"]')?.textContent).toContain("Could not load wallpaper settings.");
  await click(section, "Retry");
  expect(button(section, "Replace image").disabled).toBe(false);
});

it("retires old native work on pagehide, refreshes on pageshow, and cannot adopt a removed capability", async () => {
  const native = installNative(settings(1));
  const pending = deferred<JokoDesktopWallpaperImportResult>();
  native.api.import.mockImplementationOnce(() => pending.promise);
  const view = await render(<WallpaperSection t={t} />);
  await click(wallpaper(view.host), "Replace image");
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  native.replace(settings(3, "none", 0.25));
  await act(async () => window.dispatchEvent(new Event("pageshow")));
  await act(async () => pending.resolve({ cancelled: false, settings: settings(2) }));
  expect(radio(wallpaper(view.host), "None").getAttribute("aria-checked")).toBe("true");
  expect(wallpaper(view.host).querySelector("output")?.textContent).toBe("25%");
  const lateRead = deferred<JokoDesktopWallpaperSettings>();
  native.api.get.mockImplementationOnce(() => lateRead.promise);
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  await act(async () => window.dispatchEvent(new Event("pageshow")));
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: { capabilities: [], wallpaper: native.api } });
  await act(async () => view.root.render(<WallpaperSection t={t} />));
  await act(async () => lateRead.resolve(settings(9)));
  expect(wallpaper(view.host).textContent).toContain("requires the desktop application");
  expect([...wallpaper(view.host).querySelectorAll<HTMLElement>(".wallpaper-settings__preview")].every((preview) => preview.style.backgroundImage === "")).toBe(true);
});

it("makes the browser limitation explicit without creating a browser file picker", async () => {
  Reflect.deleteProperty(window, "jokoDesktop");
  const view = await render(<WallpaperSection t={t} />);
  expect(wallpaper(view.host).textContent).toContain("native image picker");
  expect(button(wallpaper(view.host), "Choose image").disabled).toBe(true);
  expect(view.host.querySelector('input[type="file"]')).toBeNull();
});

it.each([
  ["Main", "/"],
  ["Task", "/?sessionWindow=1&bootSession=task"],
  ["Extension", "/?extensionWindow=1&bootExtension=extension_" + "b".repeat(32)]
])("applies one shared native projection to the actual %s App canvas without contaminating the root Document", async (_kind, url) => {
  window.history.replaceState(null, "", url);
  const native = installNative(settings(1));
  const rootStyle = document.documentElement.style.cssText;
  const bodyStyle = document.body.style.cssText;
  const view = await render(<><AppWithController controller={controller()} /><WallpaperSection t={t} /></>);
  const app = required(view.host.querySelector<HTMLElement>(".app"));
  expect(app.dataset["wallpaperActive"]).toBe("true");
  expect(app.style.getPropertyValue("--app-wallpaper-image")).toContain(image.url);
  expect(app.style.getPropertyValue("--app-wallpaper-mask-veil")).toBe("8%");
  expect(native.api.get).toHaveBeenCalledOnce();
  expect(document.documentElement.style.cssText).toBe(rootStyle);
  expect(document.body.style.cssText).toBe(bodyStyle);
  await act(async () => native.publish(settings(2, "none")));
  expect(app.dataset["wallpaperActive"]).toBeUndefined();
  expect(app.style.getPropertyValue("--app-wallpaper-image")).toBe("");
  await act(async () => view.root.unmount());
  roots.splice(roots.indexOf(view.root), 1);
  expect(native.listenerCount()).toBe(0);
});

function settings(revision: number, mode: JokoDesktopWallpaperSettings["mode"] = "custom", maskOpacity = 0.2, customImage: JokoDesktopWallpaperSettings["customImage"] = image): JokoDesktopWallpaperSettings {
  return { version: 1, revision, mode, maskOpacity, customImage };
}
function installNative(initial: JokoDesktopWallpaperSettings) {
  let current = initial;
  const listeners = new Set<(settings: JokoDesktopWallpaperSettings) => void>();
  const order: string[] = [];
  const api = {
    get: vi.fn<Api["get"]>(async () => { order.push("get"); return current; }),
    set: vi.fn<Api["set"]>(async ({ mode, maskOpacity }) => { current = { ...current, ...(mode === undefined ? {} : { mode }), ...(maskOpacity === undefined ? {} : { maskOpacity }), revision: current.revision + 1 }; return current; }),
    import: vi.fn<Api["import"]>(async () => { current = { ...current, revision: current.revision + 1, mode: "custom", customImage: image }; return { cancelled: false, settings: current }; }),
    remove: vi.fn<Api["remove"]>(async () => { current = { ...current, revision: current.revision + 1, mode: "none", customImage: null }; return current; }),
    reset: vi.fn<Api["reset"]>(async () => { current = { ...current, revision: current.revision + 1, mode: "none", maskOpacity: 0.2 }; return current; }),
    onChanged: vi.fn<Api["onChanged"]>((listener) => { order.push("subscribe"); listeners.add(listener); return () => listeners.delete(listener); })
  };
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: {
    capabilities: ["appearance.wallpaper"], platform: "win32", wallpaper: api,
    applicationMenu: { configure: async () => undefined, onCommand: () => () => undefined },
    sessionWindows: { getOwner: async () => ({ profileId: "profile", sessionId: "task" }) },
    extensionWindows: { getOwner: async () => ({ extensionId: "extension_" + "b".repeat(32) }) }
  } });
  return { api, order, current: () => current, replace: (value: JokoDesktopWallpaperSettings) => { current = value; },
    publish: (value: JokoDesktopWallpaperSettings) => { current = value; for (const listener of listeners) listener(value); }, listenerCount: () => listeners.size };
}
function controller(): AppController {
  const profile = { id: "profile", deviceId: "device", serverId: "server", name: "Local", origin: "http://127.0.0.1" };
  const state = {
    ready: true, connectionState: "connected", profiles: [profile], activeProfile: profile,
    machineCaches: [], machinePresenceByProfile: {}, discoveredNodes: [], discoveryState: "idle",
    managedOrchestratorStatus: undefined,
    automaticConnectionAvailable: false, snapshot: { ...emptySnapshot(), revision: 1n, generation: 1n },
    route: { kind: "session" }, navigationRevision: 0, preferences: DEFAULT_UI_PREFERENCES,
    systemLocale: "en", effectiveLocale: "en", extensionNotifications: []
  } as ControllerState;
  return {
    state, navigate: vi.fn(), disconnect: vi.fn(), probeRuntimeActivity: vi.fn(async () => false),
    partnerGroupApi: vi.fn(() => undefined), listPartners: vi.fn(async () => []),
    setTheme: vi.fn(), setLocale: vi.fn(), setNavigationOpen: vi.fn(), setNavigationLayout: vi.fn(),
    getTaskHistoryMaintenanceSupport: vi.fn(async () => ({ supported: false })),
    readPendingExtensionUse: vi.fn(async () => undefined), changeWindowZoom: vi.fn(async () => 1)
  } as unknown as AppController;
}
async function render(element: React.ReactNode) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => { root.render(element); });
  return { host, root };
}
async function click(host: HTMLElement, label: string) { await act(async () => button(host, label).click()); }
function wallpaper(host: HTMLElement) { return required(host.querySelector<HTMLElement>(".wallpaper-settings")); }
function button(host: HTMLElement, label: string) {
  return required([...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label));
}
function radio(host: HTMLElement, label: string) { return required([...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((candidate) => candidate.querySelector("strong")?.textContent === label)); }
function setRange(host: HTMLElement, value: string) {
  const input = required(host.querySelector<HTMLInputElement>('input[type="range"]'));
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
function required<T>(value: T | null | undefined): T { if (value == null) throw new Error("Missing wallpaper control."); return value; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
