// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { translate } from "../i18n.js";
import { NativeTaskStatusSettings } from "./NativeTaskStatusSettings.js";

const BASE: JokoDesktopNativeTaskStatusSettings = {
  enabled: true,
  display: { mode: "all" },
  layout: "normal",
  sounds: {
    enabled: true,
    sounds: {
      start: { type: "builtin", id: "startup-chime" },
      attention: { type: "builtin", id: "secret-chime" },
      complete: { type: "builtin", id: "gem-collect" },
      error: { type: "builtin", id: "error-buzz" },
      select: { type: "builtin", id: "none" }
    }
  }
};
const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("en", key, values);
let root: Root;
let host: HTMLDivElement;
let previousDesktop: JokoDesktopApi | undefined;

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

it("rebases a custom sound selection on the latest device settings after the file dialog", async () => {
  const selected = deferred<{ readonly path: string | null; readonly name: string | null }>();
  const desktop = fixture();
  desktop.api.selectSoundFile.mockReturnValue(selected.promise);
  await render(desktop.value);

  await act(async () => host.querySelector<HTMLButtonElement>("#native-task-status-sound-start")!.click());
  const custom = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((option) => option.textContent === "Custom audio…");
  expect(custom).toBeDefined();
  await act(async () => custom!.click());
  expect(desktop.api.selectSoundFile).toHaveBeenCalledOnce();
  expect(host.querySelector<HTMLButtonElement>("#native-task-status-sound-start")?.disabled).toBe(true);

  await act(async () => desktop.emit({
    ...BASE,
    layout: "compact",
    sounds: { ...BASE.sounds, enabled: false }
  }));
  await act(async () => selected.resolve({ path: "C:\\audio\\ready.wav", name: "ready.wav" }));
  expect(desktop.api.setSettings).toHaveBeenCalledWith(expect.objectContaining({
    layout: "compact",
    sounds: expect.objectContaining({
      enabled: false,
      sounds: expect.objectContaining({ start: { type: "custom", path: "C:\\audio\\ready.wav", name: "ready.wav" } })
    })
  }));
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("keeps a newer Settings event when the initial read answers late", async () => {
  const initial = deferred<JokoDesktopNativeTaskStatusSettings>();
  const desktop = fixture();
  desktop.api.getSettings.mockReturnValue(initial.promise);
  await render(desktop.value);
  await act(async () => desktop.emit({ ...BASE, layout: "compact" }));
  await act(async () => initial.resolve(BASE));
  const layout = host.querySelector<HTMLButtonElement>('[aria-label="Layout"]');
  expect(layout?.textContent).toContain("Compact");
});

it("does not save a file choice after its Settings owner unmounts", async () => {
  const selected = deferred<{ readonly path: string | null; readonly name: string | null }>();
  const desktop = fixture();
  desktop.api.selectSoundFile.mockReturnValue(selected.promise);
  await render(desktop.value);
  await act(async () => host.querySelector<HTMLButtonElement>("#native-task-status-sound-start")!.click());
  const custom = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((option) => option.textContent === "Custom audio…");
  await act(async () => custom!.click());
  await act(async () => root.render(<div />));
  await act(async () => selected.resolve({ path: "C:\\audio\\late.wav", name: "late.wav" }));
  expect(desktop.api.setSettings).not.toHaveBeenCalled();
});

async function render(desktop: JokoDesktopApi): Promise<void> {
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: desktop });
  await act(async () => root.render(<NativeTaskStatusSettings t={t} />));
}

function fixture() {
  let listener: ((settings: JokoDesktopNativeTaskStatusSettings) => void) | undefined;
  const api = {
    getSettings: vi.fn<() => Promise<JokoDesktopNativeTaskStatusSettings>>().mockResolvedValue(BASE),
    getDisplays: vi.fn<() => Promise<readonly JokoDesktopNativeTaskStatusDisplay[]>>().mockResolvedValue([]),
    setSettings: vi.fn<(settings: JokoDesktopNativeTaskStatusSettings) => Promise<JokoDesktopNativeTaskStatusSettings>>()
      .mockImplementation(async (settings) => settings),
    selectSoundFile: vi.fn<() => Promise<{ readonly path: string | null; readonly name: string | null }>>(),
    onSettingsChanged: vi.fn((next: (settings: JokoDesktopNativeTaskStatusSettings) => void) => {
      listener = next;
      return () => { listener = undefined; };
    })
  };
  return {
    api,
    emit: (settings: JokoDesktopNativeTaskStatusSettings) => listener?.(settings),
    value: { capabilities: ["native.taskStatus"], nativeTaskStatus: api } as unknown as JokoDesktopApi
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
