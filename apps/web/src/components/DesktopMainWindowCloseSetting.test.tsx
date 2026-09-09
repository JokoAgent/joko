// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { translate } from "../i18n.js";
import { DesktopMainWindowCloseSetting } from "./DesktopMainWindowCloseSetting.js";

let root: Root;
let host: HTMLDivElement;
let previousDesktop: JokoDesktopApi | undefined;
const t = (key: Parameters<typeof translate>[1]) => translate("en", key);

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  previousDesktop = window.jokoDesktop;
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  if (previousDesktop === undefined) Reflect.deleteProperty(window, "jokoDesktop");
  else Object.defineProperty(window, "jokoDesktop", { configurable: true, value: previousDesktop });
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

it("loads the authoritative device choice, fences old reads, and retries failed saves against the latest revision", async () => {
  const desktop = fixture("win32");
  const load = deferred<JokoDesktopMainWindowCloseSettings>();
  desktop.api.get.mockReturnValueOnce(load.promise);
  await render(desktop.value);
  expect(select().disabled).toBe(true);
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => desktop.emit({ behavior: "tray", revision: 2 }));
  await act(async () => load.resolve({ behavior: null, revision: 0 }));
  expect(select().value).toBe("tray");
  expect([...select().options].map((option) => option.value)).toEqual(["ask", "tray", "quit"]);

  const save = deferred<JokoDesktopMainWindowCloseSettings>();
  desktop.api.set.mockReturnValueOnce(save.promise);
  await choose("quit");
  expect(desktop.api.set).toHaveBeenLastCalledWith({ behavior: "quit", expectedRevision: 2 });
  expect(select().disabled).toBe(true);
  expect(select().value).toBe("tray");
  desktop.api.get.mockResolvedValueOnce({ behavior: "tray", revision: 4 });
  await act(async () => save.reject(new Error("setting changed")));
  expect(select().disabled).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("last saved choice");
  desktop.api.set.mockResolvedValueOnce({ behavior: "quit", revision: 5 });
  await act(async () => button("Retry").click());
  expect(desktop.api.set).toHaveBeenLastCalledWith({ behavior: "quit", expectedRevision: 4 });
  expect(select().value).toBe("quit");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => desktop.emit({ behavior: "tray", revision: 3 }));
  expect(select().value).toBe("quit");
  desktop.api.set.mockResolvedValueOnce({ behavior: null, revision: 6 });
  await choose("ask");
  expect(desktop.api.set).toHaveBeenLastCalledWith({ behavior: null, expectedRevision: 5 });
  expect(select().value).toBe("ask");
});

it("shows load failure and retry, supports keyboard dismissal, and exposes only Linux close choices", async () => {
  const desktop = fixture("linux");
  desktop.api.get.mockRejectedValueOnce(new Error("IPC unavailable"));
  await render(desktop.value);
  expect(select().disabled).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
  desktop.api.get.mockResolvedValueOnce({ behavior: null, revision: 0 });
  await act(async () => button("Retry").click());
  expect(select().disabled).toBe(false);
  expect([...select().options].map((option) => option.value)).toEqual(["ask", "minimize", "quit"]);
  const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  trigger.focus();
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(desktop.api.set).not.toHaveBeenCalled();
  desktop.api.set.mockResolvedValueOnce({ behavior: "minimize", revision: 1 });
  await choose("minimize");
  expect(select().value).toBe("minimize");
});

it("accepts a current cross-window update even when the outstanding initial read fails", async () => {
  const desktop = fixture("win32");
  const load = deferred<JokoDesktopMainWindowCloseSettings>();
  desktop.api.get.mockReturnValueOnce(load.promise);
  await render(desktop.value);
  await act(async () => desktop.emit({ behavior: "quit", revision: 1 }));
  await act(async () => load.reject(new Error("initial read lost")));
  expect(select().value).toBe("quit");
  expect(select().disabled).toBe(false);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("drops old API callbacks on replacement or unmount and explains the unchanged macOS behavior", async () => {
  const old = fixture("win32");
  const load = deferred<JokoDesktopMainWindowCloseSettings>();
  old.api.get.mockReturnValueOnce(load.promise);
  await render(old.value);
  const current = fixture("linux");
  current.api.get.mockResolvedValueOnce({ behavior: "minimize", revision: 0 });
  await render(current.value);
  expect(old.unsubscribe).toHaveBeenCalledOnce();
  await act(async () => load.reject(new Error("late old load failure")));
  await act(async () => old.emit({ behavior: "quit", revision: 9 }));
  expect(select().value).toBe("minimize");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  const save = deferred<JokoDesktopMainWindowCloseSettings>();
  current.api.set.mockReturnValueOnce(save.promise);
  await choose("quit");
  const mac = fixture("darwin");
  await render(mac.value);
  await act(async () => save.reject(new Error("late old save failure")));
  expect(host.querySelector("select")).toBeNull();
  expect(host.textContent).toContain("Managed by this platform");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(mac.api.get).not.toHaveBeenCalled();
  await render(undefined);
  expect(host.textContent).toBe("");
});

async function render(desktop: JokoDesktopApi | undefined): Promise<void> {
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: desktop });
  await act(async () => root.render(<DesktopMainWindowCloseSetting t={t} />));
}
function select(): HTMLSelectElement { return host.querySelector("select")!; }
function button(text: string): HTMLButtonElement { return [...host.querySelectorAll("button")].find((item) => item.textContent === text)!; }
async function choose(value: string): Promise<void> {
  await act(async () => { select().value = value; select().dispatchEvent(new Event("change", { bubbles: true })); });
}
function fixture(platform: string) {
  let listener: ((settings: JokoDesktopMainWindowCloseSettings) => void) | undefined;
  const unsubscribe = vi.fn();
  const api = {
    get: vi.fn<() => Promise<JokoDesktopMainWindowCloseSettings>>().mockResolvedValue({ behavior: null, revision: 0 }),
    set: vi.fn<(change: { behavior: JokoDesktopMainWindowCloseSettings["behavior"]; expectedRevision: number }) => Promise<JokoDesktopMainWindowCloseSettings>>(),
    onChanged: vi.fn((next: (settings: JokoDesktopMainWindowCloseSettings) => void) => { listener = next; return unsubscribe; })
  };
  return {
    api, unsubscribe, emit: (settings: JokoDesktopMainWindowCloseSettings) => listener?.(settings),
    value: { platform, capabilities: platform === "darwin" ? [] : ["window.mainCloseBehavior"], mainWindowClose: api } as unknown as JokoDesktopApi
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
