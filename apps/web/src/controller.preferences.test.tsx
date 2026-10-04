// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAppController, type AppController } from "./controller.js";
import { DEFAULT_UI_PREFERENCES, LocalState, type UiPreferences, type UiPreferencesMutation } from "./local-state.js";
import { publishAppearancePreferencesChange } from "./appearance-preference-sync.js";
import { publishAppShortcutPreferencesChange } from "./app-shortcut-preference-sync.js";
import { publishSessionNotificationPreferenceChange } from "./session-notification-preference-sync.js";
import { publishLocalePreferenceChange } from "./locale-preference-sync.js";
import { publishConversationPreferencesChange, sameConversationPreferences } from "./conversation-preference-sync.js";
import {
  effectiveAppShortcutCombos,
  matchesAppShortcutEvent,
  validateAppShortcutCombo,
  type AppShortcutCombo,
  type AppShortcutId
} from "./app-shortcuts.js";

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

it("keeps the system preference separate from the concrete effective locale", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["ja-JP", "zh-Hant-TW", "en-US"]);
  let stored: UiPreferences = DEFAULT_UI_PREFERENCES;
  vi.spyOn(LocalState, "open").mockResolvedValue({
    listProfiles: async () => [],
    listMachineCaches: async () => [],
    readPreferences: async () => stored,
    mutatePreferences: async (mutation: UiPreferencesMutation) => {
      stored = mutation(stored);
      return stored;
    }
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
  expect(controller?.state).toMatchObject({
    systemLocale: "zh-CN",
    effectiveLocale: "zh-CN",
    preferences: { locale: "system" }
  });
  expect(document.documentElement.lang).toBe("zh-CN");

  await act(async () => { await controller!.setLocale("en-XA"); });
  expect(controller?.state).toMatchObject({
    systemLocale: "zh-CN",
    effectiveLocale: "en-XA",
    preferences: { locale: "en-XA" }
  });
  expect(document.documentElement.lang).toBe("en-XA");

  await act(async () => { await controller!.setLocale("system"); });
  expect(controller?.state).toMatchObject({
    systemLocale: "zh-CN",
    effectiveLocale: "zh-CN",
    preferences: { locale: "system" }
  });
  expect(document.documentElement.lang).toBe("zh-CN");
});

it("admits only one stale cross-controller shortcut binding and resyncs the rejected owner", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const combo: AppShortcutCombo = {
    code: "KeyG",
    key: "g",
    meta: false,
    ctrl: true,
    alt: false,
    shift: false
  };
  const firstId: AppShortcutId = "browser-back";
  const secondId: AppShortcutId = "search-in-project";
  expect(validateAppShortcutCombo(firstId, combo, {}, "win32")).toBeNull();
  expect(validateAppShortcutCombo(secondId, combo, {}, "win32")).toBeNull();

  let stored: UiPreferences = DEFAULT_UI_PREFERENCES;
  let transactionTail = Promise.resolve();
  const releaseTransactions = deferred<void>();
  const releaseAuthoritativeRead = deferred<void>();
  const committed: UiPreferences[] = [];
  const mutatePreferences = vi.fn((mutation: UiPreferencesMutation): Promise<UiPreferences> => {
    const transaction = transactionTail.then(async () => {
      await releaseTransactions.promise;
      const next = mutation(stored);
      stored = next;
      committed.push(next);
      return next;
    });
    transactionTail = transaction.then(() => undefined, () => undefined);
    return transaction;
  });
  const createLocal = (): LocalState => {
    let initialRead = true;
    return {
      listProfiles: async () => [],
      listMachineCaches: async () => [],
      readPreferences: vi.fn(async () => {
        if (initialRead) {
          initialRead = false;
          return stored;
        }
        await releaseAuthoritativeRead.promise;
        return stored;
      }),
      mutatePreferences
    } as unknown as LocalState;
  };
  const firstLocal = createLocal();
  const secondLocal = createLocal();
  vi.spyOn(LocalState, "open")
    .mockResolvedValueOnce(firstLocal)
    .mockResolvedValueOnce(secondLocal);

  let first: AppController | undefined;
  let second: AppController | undefined;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function Probe({ owner }: { readonly owner: "first" | "second" }): null {
    const controller = useAppController();
    if (owner === "first") first = controller;
    else second = controller;
    return null;
  }
  await act(async () => { root?.render(<><Probe owner="first" /><Probe owner="second" /></>); });
  await vi.waitFor(() => {
    expect(first?.state.ready).toBe(true);
    expect(second?.state.ready).toBe(true);
  });
  expect(first!.state.preferences.appShortcutOverrides).toEqual({});
  expect(second!.state.preferences.appShortcutOverrides).toEqual({});

  let firstSave!: Promise<void>;
  let secondSave!: Promise<void>;
  await act(async () => {
    firstSave = first!.setAppShortcutOverride(firstId, combo);
    secondSave = second!.setAppShortcutOverride(secondId, combo);
    await Promise.resolve();
  });
  const outcomes = Promise.allSettled([firstSave, secondSave]);
  await vi.waitFor(() => expect(mutatePreferences).toHaveBeenCalledTimes(2));
  expect(first!.state.preferences.appShortcutOverrides).toEqual({ [firstId]: combo });
  expect(second!.state.preferences.appShortcutOverrides).toEqual({ [secondId]: combo });

  stored = {
    ...stored,
    sidebarOwnerLayouts: {
      external: {
        projectFilter: ["external-project"],
        manualProjectOrder: [],
        manualPinnedOrder: [],
        collapsedProjectIds: [],
        collapsedDialogue: false
      }
    }
  };

  await act(async () => {
    releaseTransactions.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  await vi.waitFor(() => {
    expect(committed).toHaveLength(1);
    const winnerId = Object.keys(committed[0]!.appShortcutOverrides)[0];
    const rejectedLocal = winnerId === firstId ? secondLocal : firstLocal;
    expect(vi.mocked(rejectedLocal.readPreferences).mock.calls.length).toBeGreaterThan(1);
  });
  const winnerId = Object.keys(committed[0]!.appShortcutOverrides)[0] as AppShortcutId;
  const rejectedController = winnerId === firstId ? second! : first!;
  await vi.waitFor(() => expect(rejectedController.state.preferences.appShortcutOverrides).toEqual({}));

  await act(async () => {
    releaseAuthoritativeRead.resolve();
    await outcomes;
  });
  const settled = await outcomes;
  const winnerIndex = winnerId === firstId ? 0 : 1;
  expect(settled[winnerIndex]).toMatchObject({ status: "fulfilled" });
  expect(settled[winnerIndex === 0 ? 1 : 0]).toMatchObject({
    status: "rejected",
    reason: { message: "The application shortcut combination conflicts with another action." }
  });
  expect(committed).toHaveLength(1);
  expect(Object.keys(stored.appShortcutOverrides)).toEqual([winnerId]);
  expect(first!.state.preferences.appShortcutOverrides).toEqual(stored.appShortcutOverrides);
  expect(second!.state.preferences.appShortcutOverrides).toEqual(stored.appShortcutOverrides);
  expect(stored.sidebarOwnerLayouts).toHaveProperty("external");
  expect(first!.state.preferences.sidebarOwnerLayouts).toEqual({});
  expect(second!.state.preferences.sidebarOwnerLayouts).toEqual({});
});

it("hot-converges every successful shortcut override operation without remounting either controller", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  installTestBroadcastChannel();
  const id: AppShortcutId = "toggle-sidebar";
  const rebound: AppShortcutCombo = {
    code: "KeyG",
    key: "g",
    meta: false,
    ctrl: true,
    alt: false,
    shift: false
  };
  expect(validateAppShortcutCombo(id, rebound, {}, "win32")).toBeNull();
  const original = effectiveAppShortcutCombos(id, {}, "win32")[0]!;
  let stored: UiPreferences = DEFAULT_UI_PREFERENCES;
  let failFirstWindow = false;
  let secondWindowGate: Deferred<void> | undefined;
  const createLocal = (windowId: "first" | "second"): LocalState => ({
    listProfiles: async () => [],
    listMachineCaches: async () => [],
    readPreferences: vi.fn(async () => stored),
    mutatePreferences: vi.fn(async (mutation: UiPreferencesMutation) => {
      if (windowId === "second" && secondWindowGate !== undefined) await secondWindowGate.promise;
      if (windowId === "first" && failFirstWindow) {
        failFirstWindow = false;
        throw new Error("preference write failed");
      }
      const previousShortcuts = stored.appShortcutOverrides;
      stored = mutation(stored);
      if (JSON.stringify(previousShortcuts) !== JSON.stringify(stored.appShortcutOverrides)) {
        publishAppShortcutPreferencesChange();
      }
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
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function Probe({ owner }: { readonly owner: "first" | "second" }): null {
    const controller = useAppController();
    if (owner === "first") first = controller;
    else second = controller;
    return null;
  }
  await act(async () => { root?.render(<><Probe owner="first" /><Probe owner="second" /></>); });
  await vi.waitFor(() => {
    expect(first?.state.ready).toBe(true);
    expect(second?.state.ready).toBe(true);
  });

  await act(async () => { await first!.setAppShortcutOverride(id, rebound); });
  await vi.waitFor(() => expect(second!.state.preferences.appShortcutOverrides).toEqual({ [id]: rebound }));
  const receivedCombos = effectiveAppShortcutCombos(id, second!.state.preferences.appShortcutOverrides, "win32");
  expect(receivedCombos.some((combo) => matchesAppShortcutEvent(shortcutEvent(rebound), combo))).toBe(true);
  expect(receivedCombos.some((combo) => matchesAppShortcutEvent(shortcutEvent(original), combo))).toBe(false);

  await act(async () => { await first!.setAppShortcutOverride(id, null); });
  await vi.waitFor(() => expect(second!.state.preferences.appShortcutOverrides).toEqual({ [id]: null }));
  expect(effectiveAppShortcutCombos(id, second!.state.preferences.appShortcutOverrides, "win32")).toEqual([]);

  await act(async () => { await first!.setAppShortcutOverride(id, undefined); });
  await vi.waitFor(() => expect(second!.state.preferences.appShortcutOverrides).toEqual({}));
  expect(effectiveAppShortcutCombos(id, second!.state.preferences.appShortcutOverrides, "win32"))
    .toContainEqual(original);

  secondWindowGate = deferred<void>();
  let pendingSecondMutation!: Promise<void>;
  await act(async () => {
    pendingSecondMutation = second!.setTheme("light");
    await Promise.resolve();
  });
  await act(async () => { await first!.setAppShortcutOverride(id, rebound); });
  expect(second!.state.preferences.appShortcutOverrides).toEqual({});
  await act(async () => {
    secondWindowGate?.resolve();
    await pendingSecondMutation;
  });
  secondWindowGate = undefined;
  await vi.waitFor(() => {
    expect(second!.state.preferences).toMatchObject({
      theme: "light",
      appShortcutOverrides: { [id]: rebound }
    });
  });

  await act(async () => { await first!.resetAppShortcutOverrides(); });
  await vi.waitFor(() => expect(second!.state.preferences.appShortcutOverrides).toEqual({}));

  const secondReadsBeforeFailure = vi.mocked(secondLocal.readPreferences).mock.calls.length;
  failFirstWindow = true;
  await act(async () => {
    await expect(first!.setAppShortcutOverride(id, rebound)).rejects.toThrow("preference write failed");
  });
  await Promise.resolve();
  expect(stored.appShortcutOverrides).toEqual({});
  expect(first!.state.preferences.appShortcutOverrides).toEqual({});
  expect(second!.state.preferences.appShortcutOverrides).toEqual({});
  expect(vi.mocked(secondLocal.readPreferences)).toHaveBeenCalledTimes(secondReadsBeforeFailure);
});

it("jointly closes bootstrap hints and drops stale or retired shortcut reads", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const channels = installTestBroadcastChannel();
  const id: AppShortcutId = "toggle-sidebar";
  const bootstrapShortcut: AppShortcutCombo = {
    code: "KeyH", key: "h", meta: false, ctrl: true, alt: false, shift: false
  };
  const staleShortcut: AppShortcutCombo = {
    code: "KeyJ", key: "j", meta: false, ctrl: true, alt: false, shift: false
  };
  const newestShortcut: AppShortcutCombo = {
    code: "KeyK", key: "k", meta: false, ctrl: true, alt: false, shift: false
  };
  const retiredShortcut: AppShortcutCombo = {
    code: "KeyU", key: "u", meta: false, ctrl: true, alt: false, shift: false
  };
  for (const combo of [bootstrapShortcut, staleShortcut, newestShortcut, retiredShortcut]) {
    expect(validateAppShortcutCombo(id, combo, {}, "win32")).toBeNull();
  }
  const initialRead = deferred<UiPreferences | undefined>();
  const bootstrapAppearanceRead = controlledPreferenceRead();
  const bootstrapShortcutRead = controlledPreferenceRead();
  const staleRead = controlledPreferenceRead();
  const newestRead = controlledPreferenceRead();
  const retiredRead = controlledPreferenceRead();
  const controlledReads = [
    bootstrapAppearanceRead,
    bootstrapShortcutRead,
    staleRead,
    newestRead,
    retiredRead
  ];
  let firstRead = true;
  const readPreferences = vi.fn((): Promise<UiPreferences | undefined> => {
    if (firstRead) {
      firstRead = false;
      return initialRead.promise;
    }
    const controlled = controlledReads.shift();
    return controlled === undefined ? Promise.resolve(DEFAULT_UI_PREFERENCES) : controlled.read();
  });
  vi.spyOn(LocalState, "open").mockResolvedValue({
    listProfiles: async () => [],
    listMachineCaches: async () => [],
    readPreferences
  } as unknown as LocalState);

  let controller: AppController | undefined;
  const observedShortcutCodes: Array<string | undefined> = [];
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function Probe(): null {
    controller = useAppController();
    const override = controller.state.preferences.appShortcutOverrides[id];
    observedShortcutCodes.push(override === null ? "disabled" : override?.code);
    return null;
  }
  await act(async () => { root?.render(<Probe />); });
  await vi.waitFor(() => expect(readPreferences).toHaveBeenCalledOnce());

  const appearanceSnapshot = { ...DEFAULT_UI_PREFERENCES, theme: "light" as const };
  const bootstrapSnapshot = {
    ...appearanceSnapshot,
    appShortcutOverrides: { [id]: bootstrapShortcut }
  };
  await act(async () => {
    publishAppearancePreferencesChange();
    await Promise.resolve();
    initialRead.resolve(DEFAULT_UI_PREFERENCES);
  });
  await bootstrapAppearanceRead.started.promise;
  await act(async () => {
    publishAppShortcutPreferencesChange();
    await Promise.resolve();
    bootstrapAppearanceRead.result.resolve(appearanceSnapshot);
  });
  await bootstrapShortcutRead.started.promise;
  await act(async () => { bootstrapShortcutRead.result.resolve(bootstrapSnapshot); });
  await vi.waitFor(() => {
    expect(controller?.state.ready).toBe(true);
    expect(controller?.state.preferences).toMatchObject({
      theme: "light",
      appShortcutOverrides: { [id]: bootstrapShortcut }
    });
  });

  publishAppShortcutPreferencesChange();
  await staleRead.started.promise;
  publishAppShortcutPreferencesChange();
  await act(async () => {
    staleRead.result.resolve({
      ...bootstrapSnapshot,
      appShortcutOverrides: { [id]: staleShortcut }
    });
  });
  await newestRead.started.promise;
  expect(controller?.state.preferences.appShortcutOverrides).toEqual({ [id]: bootstrapShortcut });
  expect(observedShortcutCodes).not.toContain(staleShortcut.code);
  await act(async () => {
    newestRead.result.resolve({
      ...bootstrapSnapshot,
      appShortcutOverrides: { [id]: newestShortcut }
    });
  });
  await vi.waitFor(() => {
    expect(controller?.state.preferences.appShortcutOverrides).toEqual({ [id]: newestShortcut });
  });
  expect(observedShortcutCodes).not.toContain(staleShortcut.code);

  publishAppShortcutPreferencesChange();
  await retiredRead.started.promise;
  const retiredController = controller!;
  await act(async () => { root?.render(<></>); });
  expect(channels.size).toBe(0);
  await act(async () => {
    retiredRead.result.resolve({
      ...bootstrapSnapshot,
      appShortcutOverrides: { [id]: retiredShortcut }
    });
    await Promise.resolve();
  });
  expect(retiredController.state.preferences.appShortcutOverrides).toEqual({ [id]: newestShortcut });
  expect(observedShortcutCodes).not.toContain(retiredShortcut.code);
});

it("closes session-notification bootstrap hints and drops failed, stale, or retired reads", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const channels = installTestBroadcastChannel();
  const initialRead = deferred<UiPreferences | undefined>();
  const bootstrapRead = controlledPreferenceRead();
  const staleRead = controlledPreferenceRead();
  const newestRead = controlledPreferenceRead();
  const failedRead = controlledPreferenceRead();
  const retiredRead = controlledPreferenceRead();
  const controlledReads = [bootstrapRead, staleRead, newestRead, failedRead, retiredRead];
  let firstRead = true;
  const readPreferences = vi.fn((): Promise<UiPreferences | undefined> => {
    if (firstRead) {
      firstRead = false;
      return initialRead.promise;
    }
    const controlled = controlledReads.shift();
    return controlled === undefined ? Promise.resolve(DEFAULT_UI_PREFERENCES) : controlled.read();
  });
  vi.spyOn(LocalState, "open").mockResolvedValue({
    listProfiles: async () => [],
    listMachineCaches: async () => [],
    readPreferences
  } as unknown as LocalState);

  let controller: AppController | undefined;
  const observedNotificationValues: boolean[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function Probe(): null {
    controller = useAppController();
    observedNotificationValues.push(controller.state.preferences.sessionNotificationsEnabled);
    return null;
  }
  await act(async () => { root?.render(<Probe />); });
  await vi.waitFor(() => expect(readPreferences).toHaveBeenCalledOnce());

  await act(async () => {
    publishSessionNotificationPreferenceChange();
    await Promise.resolve();
    initialRead.resolve(DEFAULT_UI_PREFERENCES);
  });
  await bootstrapRead.started.promise;
  await act(async () => {
    bootstrapRead.result.resolve({
      ...DEFAULT_UI_PREFERENCES,
      theme: "light",
      sessionNotificationsEnabled: false
    });
  });
  await vi.waitFor(() => {
    expect(controller?.state.ready).toBe(true);
    expect(controller?.state.preferences).toMatchObject({
      theme: "dark",
      sessionNotificationsEnabled: false
    });
  });
  const stableSetter = controller!.setSessionNotificationsEnabled;
  observedNotificationValues.length = 0;

  publishSessionNotificationPreferenceChange();
  await staleRead.started.promise;
  publishSessionNotificationPreferenceChange();
  await act(async () => {
    staleRead.result.resolve({
      ...DEFAULT_UI_PREFERENCES,
      locale: "zh-CN",
      sessionNotificationsEnabled: true
    });
  });
  await newestRead.started.promise;
  expect(controller?.state.preferences).toMatchObject({
    locale: "system",
    sessionNotificationsEnabled: false
  });
  expect(observedNotificationValues).not.toContain(true);
  await act(async () => {
    newestRead.result.resolve({
      ...DEFAULT_UI_PREFERENCES,
      locale: "zh-CN",
      sessionNotificationsEnabled: false
    });
  });
  expect(controller?.setSessionNotificationsEnabled).toBe(stableSetter);

  publishSessionNotificationPreferenceChange();
  await failedRead.started.promise;
  await act(async () => {
    failedRead.result.reject(new Error("preference read failed"));
    await Promise.resolve();
  });
  expect(controller?.state.preferences).toMatchObject({
    locale: "system",
    sessionNotificationsEnabled: false
  });

  publishSessionNotificationPreferenceChange();
  await retiredRead.started.promise;
  const retiredController = controller!;
  await act(async () => { root?.render(<></>); });
  expect(channels.size).toBe(0);
  await act(async () => {
    retiredRead.result.resolve({
      ...DEFAULT_UI_PREFERENCES,
      sessionNotificationsEnabled: true
    });
    await Promise.resolve();
  });
  expect(retiredController.state.preferences.sessionNotificationsEnabled).toBe(false);
  expect(observedNotificationValues).not.toContain(true);
});

it("hot-converges session notifications after queued local preference mutations", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  installTestBroadcastChannel();
  let stored: UiPreferences = DEFAULT_UI_PREFERENCES;
  let secondWindowGate: Deferred<void> | undefined;
  const createLocal = (windowId: "first" | "second"): LocalState => ({
    listProfiles: async () => [],
    listMachineCaches: async () => [],
    readPreferences: vi.fn(async () => stored),
    mutatePreferences: vi.fn(async (mutation: UiPreferencesMutation) => {
      if (windowId === "second" && secondWindowGate !== undefined) await secondWindowGate.promise;
      const previousNotificationValue = stored.sessionNotificationsEnabled;
      stored = mutation(stored);
      if (previousNotificationValue !== stored.sessionNotificationsEnabled) {
        publishSessionNotificationPreferenceChange();
      }
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
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function Probe({ owner }: { readonly owner: "first" | "second" }): null {
    const controller = useAppController();
    if (owner === "first") first = controller;
    else second = controller;
    return null;
  }
  await act(async () => { root?.render(<><Probe owner="first" /><Probe owner="second" /></>); });
  await vi.waitFor(() => {
    expect(first?.state.ready).toBe(true);
    expect(second?.state.ready).toBe(true);
  });
  const stableFirstSetter = first!.setSessionNotificationsEnabled;

  stored = { ...stored, theme: "light", locale: "zh-CN" };
  await act(async () => { await first!.setSessionNotificationsEnabled(false); });
  await vi.waitFor(() => expect(second!.state.preferences.sessionNotificationsEnabled).toBe(false));
  expect(first!.state.preferences).toMatchObject({ theme: "dark", locale: "system" });
  expect(second!.state.preferences).toMatchObject({ theme: "dark", locale: "system" });
  expect(first!.setSessionNotificationsEnabled).toBe(stableFirstSetter);

  secondWindowGate = deferred<void>();
  let pendingSecondMutation!: Promise<void>;
  await act(async () => {
    pendingSecondMutation = second!.setTheme("system");
    await Promise.resolve();
  });
  await act(async () => { await first!.setSessionNotificationsEnabled(true); });
  expect(second!.state.preferences).toMatchObject({ theme: "system", sessionNotificationsEnabled: false });

  await act(async () => {
    secondWindowGate?.resolve();
    await pendingSecondMutation;
  });
  secondWindowGate = undefined;
  await vi.waitFor(() => {
    expect(second!.state.preferences).toMatchObject({
      theme: "system",
      locale: "system",
      sessionNotificationsEnabled: true
    });
  });
  expect(first!.state.preferences).toMatchObject({
    theme: "dark",
    locale: "system",
    sessionNotificationsEnabled: true
  });
  expect(first!.setSessionNotificationsEnabled).toBe(stableFirstSetter);
});

it.each([
  {
    name: "locale",
    channelName: "joko:locale-preference:v1",
    kind: "locale-preference-changed",
    publish: publishLocalePreferenceChange,
    bootstrap: { locale: "zh-CN" as const },
    stale: { locale: "en-XA" as const },
    newest: { locale: "en" as const }
  },
  {
    name: "conversation preferences",
    channelName: "joko:conversation-preferences:v1",
    kind: "conversation-preferences-changed",
    publish: publishConversationPreferencesChange,
    bootstrap: {
      composerSendShortcut: "modifier-enter" as const, messageNavRailEnabled: false,
      streamFadeEnabled: false, webLinkOpenPreference: "sidebar" as const, localLinkOpenPreference: "external" as const,
      personalizationPrompts: { "owner-a": "Use concise answers.", "owner-b": "Explain tradeoffs." }, newSessionWorktreeEnabled: true
    },
    stale: {
      composerSendShortcut: "enter" as const, messageNavRailEnabled: false, streamFadeEnabled: false,
      personalizationPrompts: { "owner-a": "Retired instructions." }, newSessionWorktreeEnabled: true
    },
    newest: {
      composerSendShortcut: "modifier-enter" as const, messageNavRailEnabled: true, streamFadeEnabled: true,
      personalizationPrompts: { "owner-b": "Explain tradeoffs." }, newSessionWorktreeEnabled: false
    }
  }
])("closes $name bootstrap hints and drops failed, stale, or retired reads", async ({ publish, bootstrap, stale, newest, channelName, kind }) => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const channels = installTestBroadcastChannel();
  const initialRead = deferred<UiPreferences | undefined>();
  const bootstrapRead = controlledPreferenceRead();
  const staleRead = controlledPreferenceRead();
  const newestRead = controlledPreferenceRead();
  const failedRead = controlledPreferenceRead();
  const retiredRead = controlledPreferenceRead();
  const controlledReads = [bootstrapRead, staleRead, newestRead, failedRead, retiredRead];
  let firstRead = true;
  const readPreferences = vi.fn((): Promise<UiPreferences | undefined> => {
    if (firstRead) {
      firstRead = false;
      return initialRead.promise;
    }
    const controlled = controlledReads.shift();
    return controlled === undefined ? Promise.resolve(DEFAULT_UI_PREFERENCES) : controlled.read();
  });
  vi.spyOn(LocalState, "open").mockResolvedValue({
    listProfiles: async () => [],
    listMachineCaches: async () => [],
    readPreferences
  } as unknown as LocalState);

  let controller: AppController | undefined;
  const observedPreferences: UiPreferences[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function Probe(): null {
    controller = useAppController();
    observedPreferences.push(controller.state.preferences);
    return null;
  }
  await act(async () => { root?.render(<Probe />); });
  await vi.waitFor(() => expect(readPreferences).toHaveBeenCalledOnce());

  await act(async () => {
    for (const channel of channels) if (channel.name === channelName) {
      for (const data of [{ kind, extra: true }, { kind: "other" }, kind, null, [kind]]) {
        channel.onmessage?.({ data } as MessageEvent<unknown>);
      }
    }
    await Promise.resolve();
  });
  expect(readPreferences).toHaveBeenCalledOnce();

  await act(async () => {
    publish();
    await Promise.resolve();
    initialRead.resolve(DEFAULT_UI_PREFERENCES);
  });
  await bootstrapRead.started.promise;
  await act(async () => {
    bootstrapRead.result.resolve({ ...DEFAULT_UI_PREFERENCES, theme: "light", ...bootstrap });
  });
  await vi.waitFor(() => {
    expect(controller?.state.ready).toBe(true);
    expect(controller?.state.preferences).toMatchObject({ theme: "dark", ...bootstrap });
  });
  const stableSetter = controller!.setLocale;
  observedPreferences.length = 0;

  publish();
  await staleRead.started.promise;
  publish();
  await act(async () => {
    staleRead.result.resolve({ ...DEFAULT_UI_PREFERENCES, theme: "light", ...stale });
  });
  await newestRead.started.promise;
  expect(controller?.state.preferences).toMatchObject({ theme: "dark", ...bootstrap });
  expect(observedPreferences).not.toEqual(expect.arrayContaining([expect.objectContaining(stale)]));
  await act(async () => {
    newestRead.result.resolve({ ...DEFAULT_UI_PREFERENCES, theme: "light", ...newest });
  });
  expect(controller?.state.preferences).toMatchObject({ theme: "dark", ...newest });
  expect(controller?.setLocale).toBe(stableSetter);

  publish();
  await failedRead.started.promise;
  await act(async () => {
    failedRead.result.reject(new Error("preference read failed"));
    await Promise.resolve();
  });
  expect(controller?.state.preferences).toMatchObject(newest);

  publish();
  await retiredRead.started.promise;
  const retiredController = controller!;
  await act(async () => { root?.render(<></>); });
  expect(channels.size).toBe(0);
  await act(async () => {
    retiredRead.result.resolve({ ...DEFAULT_UI_PREFERENCES, ...bootstrap });
    await Promise.resolve();
  });
  expect(retiredController.state.preferences).toMatchObject(newest);
  expect(observedPreferences).not.toEqual(expect.arrayContaining([expect.objectContaining(bootstrap)]));
});

it.each([
  {
    name: "locale",
    changed: (left: UiPreferences, right: UiPreferences) => left.locale !== right.locale,
    publish: publishLocalePreferenceChange,
    applyFirst: (controller: AppController) => controller.setLocale("zh-CN"),
    applySecond: (controller: AppController) => controller.setLocale("en-XA"),
    externalFirst: {},
    externalSecond: {},
    firstProjection: { locale: "zh-CN" },
    secondProjection: { locale: "en-XA" }
  },
  {
    name: "conversation preferences",
    changed: (left: UiPreferences, right: UiPreferences) => !sameConversationPreferences(left, right),
    publish: publishConversationPreferencesChange,
    applyFirst: async (controller: AppController) => {
      await controller.setComposerSendShortcut("modifier-enter");
      await controller.setMessageNavRailEnabled(false);
      await controller.setStreamFadeEnabled(false);
      await controller.setLinkOpenPreference("web", "sidebar");
      await controller.setLinkOpenPreference("local", "external");
      await controller.setNewSessionWorktreeEnabled(true);
    },
    applySecond: async (controller: AppController) => {
      await controller.setComposerSendShortcut("enter");
      await controller.resetMessageNavRailEnabled();
      await controller.resetStreamFadeEnabled();
      await controller.resetLinkOpenPreference("web");
      await controller.resetLinkOpenPreference("local");
      await controller.setNewSessionWorktreeEnabled(false);
    },
    externalFirst: { personalizationPrompts: { "owner-a": "Use concise answers.", "owner-b": "Explain tradeoffs." } },
    externalSecond: { personalizationPrompts: { "owner-b": "Explain tradeoffs." } },
    firstProjection: {
      composerSendShortcut: "modifier-enter", messageNavRailEnabled: false, streamFadeEnabled: false,
      webLinkOpenPreference: "sidebar", localLinkOpenPreference: "external", newSessionWorktreeEnabled: true,
      personalizationPrompts: { "owner-a": "Use concise answers.", "owner-b": "Explain tradeoffs." }
    },
    secondProjection: {
      composerSendShortcut: "enter", messageNavRailEnabled: true, streamFadeEnabled: true,
      webLinkOpenPreference: "external", localLinkOpenPreference: "sidebar", newSessionWorktreeEnabled: false,
      personalizationPrompts: { "owner-b": "Explain tradeoffs." }
    }
  }
])("hot-converges $name after queued local preference mutations", async ({ changed, publish, applyFirst, applySecond, externalFirst, externalSecond, firstProjection, secondProjection }) => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  installTestBroadcastChannel();
  let stored: UiPreferences = DEFAULT_UI_PREFERENCES;
  let secondWindowGate: Deferred<void> | undefined;
  const createLocal = (windowId: "first" | "second"): LocalState => ({
    listProfiles: async () => [],
    listMachineCaches: async () => [],
    readPreferences: vi.fn(async () => stored),
    mutatePreferences: vi.fn(async (mutation: UiPreferencesMutation) => {
      if (windowId === "second" && secondWindowGate !== undefined) await secondWindowGate.promise;
      const previous = stored;
      stored = mutation(stored);
      if (changed(previous, stored)) publish();
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
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function Probe({ owner }: { readonly owner: "first" | "second" }): null {
    const controller = useAppController();
    if (owner === "first") first = controller;
    else second = controller;
    return null;
  }
  await act(async () => { root?.render(<><Probe owner="first" /><Probe owner="second" /></>); });
  await vi.waitFor(() => {
    expect(first?.state.ready).toBe(true);
    expect(second?.state.ready).toBe(true);
  });
  const stableFirstSetter = first!.setLocale;

  stored = { ...stored, theme: "light", sessionNotificationsEnabled: false, ...externalFirst };
  await act(async () => { await applyFirst(first!); });
  await vi.waitFor(() => expect(second!.state.preferences).toMatchObject(firstProjection));
  expect(first!.state.preferences).toMatchObject({ theme: "dark", sessionNotificationsEnabled: true });
  expect(second!.state.preferences).toMatchObject({ theme: "dark", sessionNotificationsEnabled: true });
  expect(first!.setLocale).toBe(stableFirstSetter);

  secondWindowGate = deferred<void>();
  let pendingSecondMutation!: Promise<void>;
  await act(async () => {
    pendingSecondMutation = second!.setTheme("system");
    await Promise.resolve();
  });
  stored = { ...stored, ...externalSecond };
  await act(async () => { await applySecond(first!); });
  expect(second!.state.preferences).toMatchObject({ theme: "system", ...firstProjection });

  await act(async () => {
    secondWindowGate?.resolve();
    await pendingSecondMutation;
  });
  secondWindowGate = undefined;
  await vi.waitFor(() => expect(second!.state.preferences).toMatchObject({ theme: "system", ...secondProjection }));
  expect(first!.state.preferences).toMatchObject({ theme: "dark", ...secondProjection });
  expect(first!.setLocale).toBe(stableFirstSetter);
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
  expect([...channels].filter((channel) => channel.name === "joko:appearance-preferences:v1")).toHaveLength(1);

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

it("publishes a client layout-reset occurrence only after durable Web reset success", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  installTestBroadcastChannel();
  const occurrences: unknown[] = [];
  const observer = new BroadcastChannel("joko:client-layout-reset:v1");
  observer.onmessage = (event) => occurrences.push(event.data);
  let stored: UiPreferences = {
    ...DEFAULT_UI_PREFERENCES,
    inspectorOpen: true,
    navigationOpen: false,
    navigationMode: "hidden",
    navigationWidth: 412
  };
  let writeGate: Deferred<void> | undefined = deferred<void>();
  let rejectNextWrite = false;
  const mutatePreferences = vi.fn(async (mutation: UiPreferencesMutation): Promise<UiPreferences> => {
    if (rejectNextWrite) {
      rejectNextWrite = false;
      throw new Error("preference write failed");
    }
    await writeGate?.promise;
    stored = mutation(stored);
    return stored;
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

  let reset!: Promise<void>;
  await act(async () => {
    reset = controller!.resetLayoutPreferences();
    await Promise.resolve();
  });
  expect(mutatePreferences).toHaveBeenCalledOnce();
  expect(occurrences).toEqual([]);

  await act(async () => {
    writeGate?.resolve();
    await reset;
    await Promise.resolve();
  });
  expect(occurrences).toEqual([{ kind: "client-layout-reset" }]);

  occurrences.length = 0;
  writeGate = undefined;
  rejectNextWrite = true;
  await act(async () => {
    await expect(controller!.resetLayoutPreferences()).rejects.toThrow("preference write failed");
    await Promise.resolve();
  });
  expect(occurrences).toEqual([]);

  vi.stubGlobal("jokoDesktop", { capabilities: ["layout.reset"] } as unknown as JokoDesktopApi);
  await act(async () => {
    await controller!.resetLayoutPreferences();
    await Promise.resolve();
  });
  expect(occurrences).toEqual([]);
  observer.close();
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve: (value?: T) => resolve(value as T), reject };
}

function controlledPreferenceRead(): {
  readonly started: Deferred<void>;
  readonly result: Deferred<UiPreferences | undefined>;
  readonly read: () => Promise<UiPreferences | undefined>;
} {
  const started = deferred<void>();
  const result = deferred<UiPreferences | undefined>();
  return {
    started,
    result,
    read: () => {
      started.resolve();
      return result.promise;
    }
  };
}

function shortcutEvent(combo: AppShortcutCombo): Pick<KeyboardEvent,
  "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
> {
  return {
    code: combo.code,
    metaKey: combo.meta,
    ctrlKey: combo.ctrl,
    altKey: combo.alt,
    shiftKey: combo.shift
  };
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
