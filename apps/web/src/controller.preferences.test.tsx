// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAppController, type AppController } from "./controller.js";
import { DEFAULT_UI_PREFERENCES, LocalState, type UiPreferences, type UiPreferencesMutation } from "./local-state.js";

let root: Root | undefined;
beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("rolls back a failed preference mutation before a queued newer mutation samples local state", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  let stored: UiPreferences = DEFAULT_UI_PREFERENCES;
  let rejectFirst!: (error: Error) => void;
  const firstWrite = new Promise<UiPreferences>((_resolve, reject) => { rejectFirst = reject; });
  let writes = 0;
  const mutatePreferences = vi.fn((mutation: UiPreferencesMutation): Promise<UiPreferences> => {
    writes += 1;
    if (writes === 1) return firstWrite;
    stored = mutation(stored);
    return Promise.resolve(stored);
  });
  vi.spyOn(LocalState, "open").mockResolvedValue({
    listProfiles: async () => [],
    listMachineCaches: async () => [],
    readPreferences: async () => stored,
    mutatePreferences
  } as unknown as LocalState);
  let controller: AppController | undefined;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function Probe(): null {
    controller = useAppController();
    return null;
  }
  await act(async () => { root?.render(<Probe />); });
  await vi.waitFor(() => expect(controller?.state.ready).toBe(true));

  let first!: Promise<void>;
  let second!: Promise<void>;
  await act(async () => {
    first = controller!.setTheme("light");
    second = controller!.setLocale("zh-CN");
    await Promise.resolve();
  });
  expect(mutatePreferences).toHaveBeenCalledOnce();
  const observedFirst = first.catch((error: unknown) => error);
  await act(async () => {
    rejectFirst(new Error("preference write failed"));
    await second;
  });

  await expect(observedFirst).resolves.toMatchObject({ message: "preference write failed" });
  expect(mutatePreferences).toHaveBeenCalledTimes(2);
  expect(stored).toMatchObject({ theme: "dark", locale: "zh-CN" });
  expect(controller!.state.preferences).toMatchObject({ theme: "dark", locale: "zh-CN" });
});
