// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAppController, type AppController } from "./controller.js";
import { DEFAULT_UI_PREFERENCES, LocalState, type UiPreferences, type UiPreferencesMutation } from "./local-state.js";
import { publishAppearancePreferencesChange } from "./appearance-preference-sync.js";

let root: Root | undefined;
beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps font setters stable while rolling back before a queued mutation samples local state", async () => {
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
  const setUiFamily = controller!.setUiFamily;
  const setCodeFamily = controller!.setCodeFamily;
  const setUiSize = controller!.setUiSize;
  const setCodeSize = controller!.setCodeSize;

  let first!: Promise<void>;
  let second!: Promise<void>;
  await act(async () => {
    first = controller!.setTheme("light");
    second = controller!.setLocale("zh-CN");
    await Promise.resolve();
  });
  expect(mutatePreferences).toHaveBeenCalledOnce();
  expect(controller!.state.preferences.theme).toBe("light");
  expect(controller!.setUiFamily).toBe(setUiFamily);
  expect(controller!.setCodeFamily).toBe(setCodeFamily);
  expect(controller!.setUiSize).toBe(setUiSize);
  expect(controller!.setCodeSize).toBe(setCodeSize);
  const observedFirst = first.catch((error: unknown) => error);
  await act(async () => {
    rejectFirst(new Error("preference write failed"));
    await second;
  });

  await expect(observedFirst).resolves.toMatchObject({ message: "preference write failed" });
  expect(mutatePreferences).toHaveBeenCalledTimes(2);
  expect(stored).toMatchObject({ theme: "dark", locale: "zh-CN" });
  expect(controller!.state.preferences).toMatchObject({ theme: "dark", locale: "zh-CN" });
  expect(controller!.setUiFamily).toBe(setUiFamily);
  expect(controller!.setCodeFamily).toBe(setCodeFamily);
  expect(controller!.setUiSize).toBe(setUiSize);
  expect(controller!.setCodeSize).toBe(setCodeSize);
});

it("waits for confirmed bootstrap preferences before applying native window zoom", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const initialRead = deferred<UiPreferences | undefined>();
  const readPreferences = vi.fn(() => initialRead.promise);
  const setZoomFactor = vi.fn(async () => undefined);
  vi.stubGlobal("jokoDesktop", {
    window: { setZoomFactor }
  } as unknown as JokoDesktopApi);
  vi.spyOn(LocalState, "open").mockResolvedValue({
    listProfiles: async () => [],
    listMachineCaches: async () => [],
    readPreferences
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
  await vi.waitFor(() => expect(readPreferences).toHaveBeenCalledOnce());
  expect(controller?.state.ready).toBe(false);
  expect(setZoomFactor).not.toHaveBeenCalled();

  await act(async () => {
    initialRead.resolve({ ...DEFAULT_UI_PREFERENCES, windowZoom: 1.2 });
  });
  await vi.waitFor(() => {
    expect(controller?.state.ready).toBe(true);
    expect(setZoomFactor).toHaveBeenCalledWith(1.2);
  });
  expect(setZoomFactor).toHaveBeenCalledTimes(1);
  expect(setZoomFactor).not.toHaveBeenCalledWith(1);
});

it("adopts durable appearance and bases zoom intent on the latest cross-controller value", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const channels = installTestBroadcastChannel();
  const themeColorMeta = installThemeColorMeta();
  let stored: UiPreferences = DEFAULT_UI_PREFERENCES;
  let failFirstWindow = false;
  let firstWindowGate: ReturnType<typeof deferred<void>> | undefined;
  let secondWindowGate: ReturnType<typeof deferred<void>> | undefined;
  const createLocal = (windowId: "first" | "second"): LocalState => ({
    listProfiles: async () => [],
    listMachineCaches: async () => [],
    readPreferences: vi.fn(async () => stored),
    mutatePreferences: vi.fn(async (mutation: UiPreferencesMutation) => {
      if (windowId === "first" && failFirstWindow) {
        failFirstWindow = false;
        throw new Error("preference write failed");
      }
      if (windowId === "first" && firstWindowGate !== undefined) await firstWindowGate.promise;
      if (windowId === "second" && secondWindowGate !== undefined) await secondWindowGate.promise;
      stored = mutation(stored);
      publishAppearancePreferencesChange();
      return stored;
    })
  } as unknown as LocalState);
  const firstLocal = createLocal("first");
  const secondLocal = createLocal("second");
  vi.spyOn(LocalState, "open")
    .mockResolvedValueOnce(firstLocal)
    .mockResolvedValueOnce(secondLocal);
  let first: AppController | undefined;
  let second: AppController | undefined;
  const observedSecondZoom: number[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function Probe({ owner }: { readonly owner: "first" | "second" }): null {
    const controller = useAppController();
    if (owner === "first") first = controller;
    else {
      second = controller;
      observedSecondZoom.push(controller.state.preferences.windowZoom);
    }
    return null;
  }
  await act(async () => { root?.render(<><Probe owner="first" /><Probe owner="second" /></>); });
  await vi.waitFor(() => {
    expect(first?.state.ready).toBe(true);
    expect(second?.state.ready).toBe(true);
  });
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
  const zoomStyleSet = vi.spyOn(document.documentElement.style, "setProperty");

  stored = { ...stored, windowZoom: 1.2 };
  document.documentElement.style.setProperty("zoom", "1.2");
  zoomStyleSet.mockClear();
  await act(async () => {
    await expect(second!.changeWindowZoom("reset")).resolves.toBe(1);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
  expect(stored.windowZoom).toBe(1);
  expect(second!.state.preferences.windowZoom).toBe(1);
  expect(zoomStyleSet).toHaveBeenCalledWith("zoom", "1");

  stored = { ...stored, windowZoom: 1.2 };
  secondWindowGate = deferred<void>();
  let staleWindowZoom!: Promise<number>;
  await act(async () => {
    staleWindowZoom = second!.changeWindowZoom("increase");
    await Promise.resolve();
  });
  expect(second!.state.preferences.windowZoom).toBe(1);
  expect(observedSecondZoom).not.toContain(1.1);
  expect(zoomStyleSet).not.toHaveBeenCalledWith("zoom", "1.1");
  expect(zoomStyleSet).not.toHaveBeenCalledWith("zoom", "1.3");

  await act(async () => {
    secondWindowGate?.resolve();
    await expect(staleWindowZoom).resolves.toBe(1.3);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
  secondWindowGate = undefined;
  expect(stored.windowZoom).toBe(1.3);
  expect(second!.state.preferences.windowZoom).toBe(1.3);
  expect(observedSecondZoom).not.toContain(1.1);
  await vi.waitFor(() => {
    expect(first!.state.preferences.windowZoom).toBe(1.3);
    expect(zoomStyleSet).toHaveBeenCalledWith("zoom", "1.3");
  });

  failFirstWindow = true;
  await act(async () => {
    await expect(first!.changeWindowZoom("increase")).rejects.toThrow("preference write failed");
  });
  expect(stored.windowZoom).toBe(1.3);
  expect(first!.state.preferences.windowZoom).toBe(1.3);
  expect(zoomStyleSet).toHaveBeenCalledWith("zoom", "1.3");

  let concurrentZooms!: readonly [number, number];
  await act(async () => {
    concurrentZooms = await Promise.all([
      first!.changeWindowZoom("increase"),
      second!.changeWindowZoom("increase")
    ]);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
  expect([...concurrentZooms].sort((left, right) => left - right)).toEqual([1.4, 1.5]);
  expect(stored.windowZoom).toBe(1.5);
  await vi.waitFor(() => {
    expect(first!.state.preferences.windowZoom).toBe(1.5);
    expect(second!.state.preferences.windowZoom).toBe(1.5);
  });

  await act(async () => { await first!.setTheme("light"); });
  await vi.waitFor(() => {
    expect(second!.state.preferences.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(themeColorMeta.content).toBe("#f2f2f2");
  });

  secondWindowGate = deferred<void>();
  let secondThemeWrite!: Promise<void>;
  await act(async () => {
    secondThemeWrite = second!.setTheme("dark");
    await Promise.resolve();
  });
  expect(second!.state.preferences.theme).toBe("dark");
  await act(async () => { await first!.setUiFamily("Inter"); });
  await Promise.resolve();
  expect(second!.state.preferences).toMatchObject({ theme: "dark", uiFamily: "" });

  await act(async () => {
    secondWindowGate?.resolve();
    await secondThemeWrite;
  });
  secondWindowGate = undefined;
  await vi.waitFor(() => {
    expect(first!.state.preferences.theme).toBe("dark");
    expect(second!.state.preferences).toMatchObject({ theme: "dark", uiFamily: "Inter" });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(themeColorMeta.content).toBe("#0d0d0d");
  });

  const readsBeforeFailure = vi.mocked(secondLocal.readPreferences).mock.calls.length;
  failFirstWindow = true;
  await act(async () => {
    await expect(first!.setCodeFamily("Failed Mono")).rejects.toThrow("preference write failed");
  });
  await Promise.resolve();
  expect(second!.state.preferences.codeFamily).toBe("");
  expect(vi.mocked(secondLocal.readPreferences)).toHaveBeenCalledTimes(readsBeforeFailure);

  secondWindowGate = deferred<void>();
  let secondWrite!: Promise<void>;
  await act(async () => {
    secondWrite = second!.setUiSize(18);
    await Promise.resolve();
  });
  expect(second!.state.preferences).toMatchObject({ uiSize: 18, codeSize: 14 });
  await act(async () => { await first!.setCodeSize(20); });
  await Promise.resolve();
  expect(second!.state.preferences).toMatchObject({ uiSize: 18, codeSize: 14 });

  await act(async () => {
    secondWindowGate?.resolve();
    await secondWrite;
  });
  secondWindowGate = undefined;
  await vi.waitFor(() => expect(second!.state.preferences).toMatchObject({ uiSize: 18, codeSize: 20 }));
  publishAppearancePreferencesChange();
  publishAppearancePreferencesChange();
  await vi.waitFor(() => expect(second!.state.preferences).toMatchObject({ uiSize: 18, codeSize: 20 }));

  const retiredSecond = second!;
  await act(async () => { root?.render(<Probe owner="first" />); });
  await act(async () => { await first!.setCodeFamily("Mono"); });
  await Promise.resolve();
  expect(retiredSecond.state.preferences.codeFamily).toBe("");
  expect(channels.size).toBe(1);

  const setZoomFactor = vi.fn(async () => undefined);
  vi.stubGlobal("jokoDesktop", {
    window: { setZoomFactor }
  } as unknown as JokoDesktopApi);
  stored = { ...stored, windowZoom: 1.4 };
  document.documentElement.style.setProperty("zoom", "1.4");
  await act(async () => {
    await expect(first!.changeWindowZoom("increase")).resolves.toBe(1.5);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
  expect(stored.windowZoom).toBe(1.5);
  expect(first!.state.preferences.windowZoom).toBe(1.5);
  await vi.waitFor(() => expect(setZoomFactor).toHaveBeenCalledWith(1.5));
  expect(document.documentElement.style.getPropertyValue("zoom")).toBe("");
  const nativeZoomApplicationsBeforeRetiredIntent = setZoomFactor.mock.calls.length;

  firstWindowGate = deferred<void>();
  const retiredFirst = first!;
  const zoomApplicationsBeforeRetiredIntent = zoomStyleSet.mock.calls.length;
  let retiredZoom!: Promise<number>;
  await act(async () => {
    retiredZoom = retiredFirst.changeWindowZoom("increase");
    await Promise.resolve();
  });
  expect(retiredFirst.state.preferences.windowZoom).toBe(1.5);
  expect(zoomStyleSet).toHaveBeenCalledTimes(zoomApplicationsBeforeRetiredIntent);
  expect(setZoomFactor).toHaveBeenCalledTimes(nativeZoomApplicationsBeforeRetiredIntent);
  await act(async () => { root?.unmount(); });
  root = undefined;
  expect(channels.size).toBe(0);
  await act(async () => {
    firstWindowGate?.resolve();
    await expect(retiredZoom).resolves.toBe(1.6);
    await Promise.resolve();
  });
  expect(stored.windowZoom).toBe(1.6);
  expect(retiredFirst.state.preferences.windowZoom).toBe(1.5);
  expect(zoomStyleSet).toHaveBeenCalledTimes(zoomApplicationsBeforeRetiredIntent);
  expect(setZoomFactor).toHaveBeenCalledTimes(nativeZoomApplicationsBeforeRetiredIntent);
});

it("reapplies the final confirmed zoom when receiver hints collapse to the committed snapshot", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  installTestBroadcastChannel();
  const firstRefresh = {
    started: deferred<void>(),
    result: deferred<UiPreferences | undefined>()
  };
  const secondRefresh = {
    started: deferred<void>(),
    result: deferred<UiPreferences | undefined>()
  };
  const refreshes = [firstRefresh, secondRefresh];
  let bootstrapRead = true;
  const readPreferences = vi.fn((): Promise<UiPreferences | undefined> => {
    if (bootstrapRead) {
      bootstrapRead = false;
      return Promise.resolve(DEFAULT_UI_PREFERENCES);
    }
    const refresh = refreshes.shift();
    if (refresh === undefined) return Promise.resolve(DEFAULT_UI_PREFERENCES);
    refresh.started.resolve();
    return refresh.result.promise;
  });
  vi.spyOn(LocalState, "open").mockResolvedValue({
    listProfiles: async () => [],
    listMachineCaches: async () => [],
    readPreferences
  } as unknown as LocalState);
  let controller: AppController | undefined;
  const observedZooms: number[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function Probe(): null {
    controller = useAppController();
    observedZooms.push(controller.state.preferences.windowZoom);
    return null;
  }
  await act(async () => { root?.render(<Probe />); });
  await vi.waitFor(() => expect(controller?.state.ready).toBe(true));
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
  const zoomStyleSet = vi.spyOn(document.documentElement.style, "setProperty");
  document.documentElement.style.setProperty("zoom", "1.2");
  zoomStyleSet.mockClear();

  await act(async () => {
    publishAppearancePreferencesChange();
    await firstRefresh.started.promise;
    firstRefresh.result.resolve({ ...DEFAULT_UI_PREFERENCES, windowZoom: 1.2 });
    await Promise.resolve();

    publishAppearancePreferencesChange();
    await secondRefresh.started.promise;
    secondRefresh.result.resolve(DEFAULT_UI_PREFERENCES);
    await Promise.resolve();
  });

  expect(controller?.state.preferences.windowZoom).toBe(1);
  expect(observedZooms).not.toContain(1.2);
  expect(zoomStyleSet).toHaveBeenCalledWith("zoom", "1");
});

it("closes the bootstrap hint window and discards stale or retired appearance reads", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  installTestBroadcastChannel();
  const themeColorMeta = installThemeColorMeta();
  let stored: UiPreferences = DEFAULT_UI_PREFERENCES;
  const initialRead = deferred<UiPreferences | undefined>();
  let firstRead = true;
  const controlledReads: Deferred<UiPreferences | undefined>[] = [];
  const readPreferences = vi.fn((): Promise<UiPreferences | undefined> => {
    if (firstRead) {
      firstRead = false;
      return initialRead.promise;
    }
    const controlled = controlledReads.shift();
    if (controlled !== undefined) return controlled.promise;
    return Promise.resolve(stored);
  });
  vi.spyOn(LocalState, "open").mockResolvedValue({
    listProfiles: async () => [],
    listMachineCaches: async () => [],
    readPreferences,
    mutatePreferences: async (mutation: UiPreferencesMutation) => {
      stored = mutation(stored);
      publishAppearancePreferencesChange();
      return stored;
    }
  } as unknown as LocalState);
  let controller: AppController | undefined;
  const observedFamilies: string[] = [];
  const observedThemes: UiPreferences["theme"][] = [];
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function Probe(): null {
    controller = useAppController();
    observedFamilies.push(controller.state.preferences.uiFamily);
    observedThemes.push(controller.state.preferences.theme);
    return null;
  }
  await act(async () => { root?.render(<Probe />); });
  await vi.waitFor(() => expect(readPreferences).toHaveBeenCalledOnce());
  stored = { ...stored, uiFamily: "Inter", theme: "light" };
  publishAppearancePreferencesChange();
  await act(async () => initialRead.resolve(DEFAULT_UI_PREFERENCES));
  await vi.waitFor(() => {
    expect(controller?.state.ready).toBe(true);
    expect(controller?.state.preferences).toMatchObject({ uiFamily: "Inter", theme: "light" });
    expect(readPreferences).toHaveBeenCalledTimes(2);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(themeColorMeta.content).toBe("#f2f2f2");
  });
  observedFamilies.length = 0;
  observedThemes.length = 0;

  const staleRead = deferred<UiPreferences | undefined>();
  const newestRead = deferred<UiPreferences | undefined>();
  controlledReads.push(staleRead, newestRead);
  stored = { ...stored, uiFamily: "Old", theme: "dark" };
  publishAppearancePreferencesChange();
  await vi.waitFor(() => expect(readPreferences).toHaveBeenCalledTimes(3));
  stored = { ...stored, uiFamily: "Newest", theme: "system" };
  publishAppearancePreferencesChange();
  await act(async () => staleRead.resolve({ ...stored, uiFamily: "Old", theme: "dark" }));
  await vi.waitFor(() => expect(readPreferences).toHaveBeenCalledTimes(4));
  expect(controller?.state.preferences).toMatchObject({ uiFamily: "Inter", theme: "light" });
  expect(observedFamilies).not.toContain("Old");
  expect(observedThemes).not.toContain("dark");
  await act(async () => newestRead.resolve(stored));
  await vi.waitFor(() => {
    expect(controller?.state.preferences).toMatchObject({ uiFamily: "Newest", theme: "system" });
    expect(document.documentElement.dataset.theme).toBe("system");
    expect(themeColorMeta.content).toBe("#f2f2f2");
  });
  expect(observedFamilies).not.toContain("Old");
  expect(observedThemes).not.toContain("dark");

  const retiredRead = deferred<UiPreferences | undefined>();
  controlledReads.push(retiredRead);
  stored = { ...stored, uiFamily: "Retired", theme: "dark" };
  publishAppearancePreferencesChange();
  await vi.waitFor(() => expect(readPreferences).toHaveBeenCalledTimes(5));
  const retiredController = controller!;
  const appliedBeforeUnmount = document.documentElement.style.getPropertyValue("--app-font-ui");
  const themeBeforeUnmount = document.documentElement.dataset.theme;
  const themeColorBeforeUnmount = themeColorMeta.content;
  await act(async () => { root?.render(<></>); });
  await act(async () => retiredRead.resolve(stored));
  expect(retiredController.state.preferences).toMatchObject({ uiFamily: "Newest", theme: "system" });
  expect(document.documentElement.style.getPropertyValue("--app-font-ui")).toBe(appliedBeforeUnmount);
  expect(document.documentElement.dataset.theme).toBe(themeBeforeUnmount);
  expect(themeColorMeta.content).toBe(themeColorBeforeUnmount);
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve: (value?: T) => resolve(value as T) };
}

function installThemeColorMeta(): HTMLMetaElement {
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  document.body.append(meta);
  return meta;
}

interface TestBroadcastPeer {
  readonly name: string;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  close(): void;
}

function installTestBroadcastChannel(): Set<TestBroadcastPeer> {
  const channels = new Set<TestBroadcastPeer>();
  class TestChannel implements TestBroadcastPeer {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    constructor(readonly name: string) { channels.add(this); }
    postMessage(value: unknown): void {
      for (const peer of channels) if (peer !== this && peer.name === this.name) {
        queueMicrotask(() => peer.onmessage?.({ data: value } as MessageEvent<unknown>));
      }
    }
    close(): void { channels.delete(this); }
  }
  vi.stubGlobal("BroadcastChannel", TestChannel);
  return channels;
}
