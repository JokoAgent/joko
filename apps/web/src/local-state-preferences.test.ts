import { describe, expect, it, vi } from "vitest";
import { DEFAULT_UI_PREFERENCES, LocalState, type UiPreferences } from "./local-state.js";
import { DEFAULT_SIDEBAR_OWNER_LAYOUT, withSidebarOwnerLayout } from "./sidebar-layout.js";
import { subscribeAppearancePreferencesChange } from "./appearance-preference-sync.js";
import { withAppShortcutOverride, type AppShortcutCombo } from "./app-shortcuts.js";
import { subscribeAppShortcutPreferencesChange } from "./app-shortcut-preference-sync.js";
import { subscribeSessionNotificationPreferenceChange } from "./session-notification-preference-sync.js";
import { subscribeLocalePreferenceChange } from "./locale-preference-sync.js";
import { subscribeConversationPreferencesChange } from "./conversation-preference-sync.js";

describe("cross-window durable UI preference mutations", () => {
  it("merges a stale renderer's unrelated patch with the latest durable owner layout", async () => {
    const database = memoryPreferenceDatabase();
    const firstWindow = memoryLocalState(database.database);
    const secondWindow = memoryLocalState(database.database);
    await firstWindow.savePreferences({
      ...DEFAULT_UI_PREFERENCES,
      sidebarOwnerLayouts: {
        owner: { ...DEFAULT_SIDEBAR_OWNER_LAYOUT, projectFilter: ["other"] }
      }
    });
    const staleSecondWindowSnapshot = await secondWindow.readPreferences();

    await firstWindow.mutatePreferences((current) => ({
      ...current,
      sidebarOwnerLayouts: withSidebarOwnerLayout(current.sidebarOwnerLayouts, "owner", {
        projectFilter: ["other", "restored"]
      })
    }));
    await secondWindow.mutatePreferences((current) => ({ ...current, theme: "light" }));

    expect(staleSecondWindowSnapshot?.sidebarOwnerLayouts.owner?.projectFilter).toEqual(["other"]);
    await expect(firstWindow.readPreferences()).resolves.toMatchObject({
      theme: "light",
      sidebarOwnerLayouts: {
        owner: { projectFilter: ["other", "restored"] }
      }
    });
  });

  it("keeps exact owner patches from separate renderers in one durable value", async () => {
    const database = memoryPreferenceDatabase();
    const firstWindow = memoryLocalState(database.database);
    const secondWindow = memoryLocalState(database.database);

    await firstWindow.mutatePreferences((current) => ({
      ...current,
      sidebarOwnerLayouts: withSidebarOwnerLayout(current.sidebarOwnerLayouts, "owner-a", {
        projectFilter: ["project-a"]
      })
    }));
    await secondWindow.mutatePreferences((current) => ({
      ...current,
      sidebarOwnerLayouts: withSidebarOwnerLayout(current.sidebarOwnerLayouts, "owner-b", {
        projectFilter: ["project-b"]
      })
    }));

    expect((await firstWindow.readPreferences())?.sidebarOwnerLayouts).toMatchObject({
      "owner-a": { projectFilter: ["project-a"] },
      "owner-b": { projectFilter: ["project-b"] }
    });
  });

  it("canonically clears the optional automatic connection target without resetting unrelated fields", async () => {
    const database = memoryPreferenceDatabase();
    const state = memoryLocalState(database.database);
    await state.savePreferences({
      ...DEFAULT_UI_PREFERENCES,
      theme: "light",
      automaticConnectionTarget: { kind: "profile", profileId: "profile-a" }
    });

    await state.mutatePreferences((current) => ({ ...current, automaticConnectionTarget: undefined }));

    const restored = await state.readPreferences();
    expect(restored).toMatchObject({ theme: "light" });
    expect(Object.hasOwn(restored ?? {}, "automaticConnectionTarget")).toBe(false);
  });

  it("stores only a customized composer send shortcut and rehydrates the omitted default", async () => {
    const database = memoryPreferenceDatabase();
    const state = memoryLocalState(database.database);
    await state.savePreferences({
      ...DEFAULT_UI_PREFERENCES,
      theme: "light",
      composerSendShortcut: "modifier-enter"
    });

    expect(database.readUiRecord()).toMatchObject({
      theme: "light",
      composerSendShortcut: "modifier-enter"
    });

    await state.mutatePreferences((current) => ({ ...current, composerSendShortcut: "enter" }));

    expect(database.readUiRecord()).toMatchObject({ theme: "light" });
    expect(database.readUiRecord()).not.toHaveProperty("composerSendShortcut");
    await expect(state.readPreferences()).resolves.toMatchObject({
      theme: "light",
      composerSendShortcut: "enter"
    });
  });

  it("leaves the previous durable value intact when the readwrite transaction aborts", async () => {
    const database = memoryPreferenceDatabase();
    const state = memoryLocalState(database.database);
    await state.savePreferences({ ...DEFAULT_UI_PREFERENCES, theme: "light" });
    database.failNextPut();

    await expect(state.mutatePreferences((current) => ({ ...current, theme: "dark" })))
      .rejects.toThrow("preference write failed");
    await expect(state.readPreferences()).resolves.toMatchObject({ theme: "light" });
  });

  it("publishes only successfully committed changes to the shared appearance projection", async () => {
    const database = memoryPreferenceDatabase();
    const publishedDurableUiRecords: unknown[] = [];
    const channels = new Set<TestChannel>();
    class TestChannel {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      constructor(readonly name: string) { channels.add(this); }
      postMessage(value: unknown): void {
        if (this.name === "joko:appearance-preferences:v1") {
          publishedDurableUiRecords.push(database.readUiRecord());
        }
        for (const peer of channels) if (peer !== this && peer.name === this.name) {
          queueMicrotask(() => peer.onmessage?.({ data: value } as MessageEvent<unknown>));
        }
      }
      close(): void { channels.delete(this); }
    }
    vi.stubGlobal("BroadcastChannel", TestChannel);
    try {
      const state = memoryLocalState(database.database);
      const changed = vi.fn();
      const close = subscribeAppearancePreferencesChange(changed);

      await state.mutatePreferences((current) => ({ ...current, uiSize: 18 }));
      await Promise.resolve();
      expect(changed).toHaveBeenCalledOnce();
      expect(publishedDurableUiRecords).toHaveLength(1);
      expect(publishedDurableUiRecords.at(-1)).toMatchObject({ uiSize: 18 });

      await state.mutatePreferences((current) => ({ ...current, windowZoom: 1.5 }));
      await Promise.resolve();
      expect(changed).toHaveBeenCalledTimes(2);
      expect(publishedDurableUiRecords).toHaveLength(2);
      expect(publishedDurableUiRecords.at(-1)).toMatchObject({ windowZoom: 1.5 });

      await state.mutatePreferences((current) => ({ ...current, windowZoom: 1.5 }));
      await state.mutatePreferences((current) => ({ ...current, theme: "light" }));
      await Promise.resolve();
      expect(changed).toHaveBeenCalledTimes(3);
      expect(publishedDurableUiRecords).toHaveLength(3);
      expect(publishedDurableUiRecords.at(-1)).toMatchObject({ theme: "light", windowZoom: 1.5 });

      await state.mutatePreferences((current) => ({ ...current, theme: "light" }));
      await state.mutatePreferences((current) => ({ ...current, locale: "zh-CN" }));
      await state.mutatePreferences((current) => ({ ...current, composerSendShortcut: "modifier-enter" }));
      await Promise.resolve();
      expect(changed).toHaveBeenCalledTimes(3);
      expect(publishedDurableUiRecords).toHaveLength(3);

      database.failNextPut();
      await expect(state.mutatePreferences((current) => ({ ...current, theme: "dark" })))
        .rejects.toThrow("preference write failed");
      await Promise.resolve();
      expect(changed).toHaveBeenCalledTimes(3);
      expect(publishedDurableUiRecords).toHaveLength(3);
      expect(database.readUiRecord()).toMatchObject({ theme: "light", windowZoom: 1.5 });
      close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes every successfully committed shortcut change but not same, failed, or unrelated mutations", async () => {
    const database = memoryPreferenceDatabase();
    const publishedDurableUiRecords: unknown[] = [];
    const channels = new Set<TestChannel>();
    class TestChannel {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      constructor(readonly name: string) { channels.add(this); }
      postMessage(value: unknown): void {
        if (this.name === "joko:app-shortcut-preferences:v1") {
          publishedDurableUiRecords.push(database.readUiRecord());
        }
        for (const peer of channels) if (peer !== this && peer.name === this.name) {
          queueMicrotask(() => peer.onmessage?.({ data: value } as MessageEvent<unknown>));
        }
      }
      close(): void { channels.delete(this); }
    }
    vi.stubGlobal("BroadcastChannel", TestChannel);
    try {
      const state = memoryLocalState(database.database);
      const changed = vi.fn();
      const close = subscribeAppShortcutPreferencesChange(changed);
      const rebind = shortcut("KeyG", "g");

      await state.mutatePreferences((current) => ({
        ...current,
        appShortcutOverrides: withAppShortcutOverride(current.appShortcutOverrides, "browser-back", rebind)
      }));
      await Promise.resolve();
      expect(changed).toHaveBeenCalledOnce();
      expect(publishedDurableUiRecords).toHaveLength(1);
      expect(publishedDurableUiRecords.at(-1)).toMatchObject({
        appShortcutOverrides: { "browser-back": rebind }
      });

      await state.mutatePreferences((current) => ({
        ...current,
        appShortcutOverrides: withAppShortcutOverride(current.appShortcutOverrides, "browser-back", { ...rebind })
      }));
      await Promise.resolve();
      expect(changed).toHaveBeenCalledOnce();
      expect(publishedDurableUiRecords).toHaveLength(1);

      await state.mutatePreferences((current) => ({
        ...current,
        appShortcutOverrides: withAppShortcutOverride(current.appShortcutOverrides, "search-in-project", null)
      }));
      await Promise.resolve();
      expect(changed).toHaveBeenCalledTimes(2);
      expect(publishedDurableUiRecords.at(-1)).toMatchObject({
        appShortcutOverrides: { "browser-back": rebind, "search-in-project": null }
      });

      await state.mutatePreferences((current) => ({
        ...current,
        appShortcutOverrides: withAppShortcutOverride(current.appShortcutOverrides, "browser-back", undefined)
      }));
      await Promise.resolve();
      expect(changed).toHaveBeenCalledTimes(3);
      expect(publishedDurableUiRecords.at(-1)).toMatchObject({
        appShortcutOverrides: { "search-in-project": null }
      });

      await state.mutatePreferences((current) => ({ ...current, appShortcutOverrides: {} }));
      await Promise.resolve();
      expect(changed).toHaveBeenCalledTimes(4);
      expect((publishedDurableUiRecords.at(-1) as { appShortcutOverrides: unknown }).appShortcutOverrides).toEqual({});

      await state.mutatePreferences((current) => ({ ...current, appShortcutOverrides: {} }));
      await state.mutatePreferences((current) => ({ ...current, locale: "zh-CN" }));
      await state.mutatePreferences((current) => ({ ...current, composerSendShortcut: "modifier-enter" }));
      await Promise.resolve();
      expect(changed).toHaveBeenCalledTimes(4);
      expect(publishedDurableUiRecords).toHaveLength(4);

      await state.mutatePreferences((current) => ({
        ...current,
        appShortcutOverrides: withAppShortcutOverride(current.appShortcutOverrides, "browser-back", rebind)
      }));
      await Promise.resolve();
      expect(changed).toHaveBeenCalledTimes(5);
      expect(publishedDurableUiRecords).toHaveLength(5);

      database.failNextPut();
      await expect(state.mutatePreferences((current) => ({
        ...current,
        appShortcutOverrides: withAppShortcutOverride(current.appShortcutOverrides, "browser-back", null)
      }))).rejects.toThrow("preference write failed");
      await Promise.resolve();
      expect(changed).toHaveBeenCalledTimes(5);
      expect(publishedDurableUiRecords).toHaveLength(5);
      expect(database.readUiRecord()).toMatchObject({
        appShortcutOverrides: { "browser-back": rebind }
      });
      close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes only committed session-notification changes and omits the restored default", async () => {
    const database = memoryPreferenceDatabase();
    const publishedDurableUiRecords: unknown[] = [];
    const channels = new Set<TestChannel>();
    class TestChannel {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      constructor(readonly name: string) { channels.add(this); }
      postMessage(value: unknown): void {
        if (this.name === "joko:session-notification-preference:v1") {
          publishedDurableUiRecords.push(database.readUiRecord());
        }
        for (const peer of channels) if (peer !== this && peer.name === this.name) {
          queueMicrotask(() => peer.onmessage?.({ data: value } as MessageEvent<unknown>));
        }
      }
      close(): void { channels.delete(this); }
    }
    vi.stubGlobal("BroadcastChannel", TestChannel);
    try {
      const state = memoryLocalState(database.database);
      const changed = vi.fn();
      const unsubscribe = subscribeSessionNotificationPreferenceChange(changed);

      await state.mutatePreferences((current) => ({
        ...current,
        theme: "light",
        sessionNotificationsEnabled: false
      }));
      await Promise.resolve();
      expect(changed).toHaveBeenCalledOnce();
      expect(publishedDurableUiRecords).toHaveLength(1);
      expect(publishedDurableUiRecords[0]).toMatchObject({
        theme: "light",
        sessionNotificationsEnabled: false
      });

      await state.mutatePreferences((current) => ({ ...current, sessionNotificationsEnabled: false }));
      await state.mutatePreferences((current) => ({ ...current, locale: "zh-CN" }));
      await Promise.resolve();
      expect(changed).toHaveBeenCalledOnce();
      expect(publishedDurableUiRecords).toHaveLength(1);

      database.failNextPut();
      await expect(state.mutatePreferences((current) => ({
        ...current,
        sessionNotificationsEnabled: true
      }))).rejects.toThrow("preference write failed");
      await Promise.resolve();
      expect(changed).toHaveBeenCalledOnce();
      expect(publishedDurableUiRecords).toHaveLength(1);
      expect(database.readUiRecord()).toMatchObject({
        theme: "light",
        locale: "zh-CN",
        sessionNotificationsEnabled: false
      });

      await state.mutatePreferences((current) => ({
        ...current,
        sessionNotificationsEnabled: true
      }));
      await Promise.resolve();
      expect(changed).toHaveBeenCalledTimes(2);
      expect(publishedDurableUiRecords).toHaveLength(2);
      expect(publishedDurableUiRecords[1]).toMatchObject({ theme: "light", locale: "zh-CN" });
      expect(publishedDurableUiRecords[1]).not.toHaveProperty("sessionNotificationsEnabled");
      await expect(state.readPreferences()).resolves.toMatchObject({
        theme: "light",
        locale: "zh-CN",
        sessionNotificationsEnabled: true
      });
      unsubscribe();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes only committed locale changes and omits the restored default", async () => {
    const database = memoryPreferenceDatabase();
    const publishedDurableUiRecords: unknown[] = [];
    const channels = new Set<TestChannel>();
    class TestChannel {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      constructor(readonly name: string) { channels.add(this); }
      postMessage(value: unknown): void {
        if (this.name === "joko:locale-preference:v1") {
          publishedDurableUiRecords.push(database.readUiRecord());
        }
        for (const peer of channels) if (peer !== this && peer.name === this.name) {
          queueMicrotask(() => peer.onmessage?.({ data: value } as MessageEvent<unknown>));
        }
      }
      close(): void { channels.delete(this); }
    }
    vi.stubGlobal("BroadcastChannel", TestChannel);
    try {
      const state = memoryLocalState(database.database);
      const changed = vi.fn();
      const unsubscribe = subscribeLocalePreferenceChange(changed);

      await state.mutatePreferences((current) => ({ ...current, theme: "light", locale: "zh-CN" }));
      await Promise.resolve();
      expect(changed).toHaveBeenCalledOnce();
      expect(publishedDurableUiRecords).toHaveLength(1);
      expect(publishedDurableUiRecords[0]).toMatchObject({ theme: "light", locale: "zh-CN" });

      await state.mutatePreferences((current) => ({ ...current, locale: "zh-CN" }));
      await state.mutatePreferences((current) => ({ ...current, sessionNotificationsEnabled: false }));
      await Promise.resolve();
      expect(changed).toHaveBeenCalledOnce();
      expect(publishedDurableUiRecords).toHaveLength(1);

      database.failNextPut();
      await expect(state.mutatePreferences((current) => ({ ...current, locale: "en-XA" })))
        .rejects.toThrow("preference write failed");
      await Promise.resolve();
      expect(changed).toHaveBeenCalledOnce();
      expect(database.readUiRecord()).toMatchObject({ locale: "zh-CN", sessionNotificationsEnabled: false });

      await state.mutatePreferences((current) => ({ ...current, locale: DEFAULT_UI_PREFERENCES.locale }));
      await Promise.resolve();
      expect(changed).toHaveBeenCalledTimes(2);
      expect(publishedDurableUiRecords).toHaveLength(2);
      expect(publishedDurableUiRecords[1]).toMatchObject({ theme: "light", sessionNotificationsEnabled: false });
      expect(publishedDurableUiRecords[1]).not.toHaveProperty("locale");
      await expect(state.readPreferences()).resolves.toMatchObject({ locale: "system" });
      unsubscribe();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it("publishes one content-free conversation hint only after changed durable fields commit and reset", async () => {
  const database = memoryPreferenceDatabase();
  const published: Array<{ readonly value: unknown; readonly durable: unknown }> = [];
  const channels = new Set<TestChannel>();
  class TestChannel {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    constructor(readonly name: string) { channels.add(this); }
    postMessage(value: unknown): void {
      if (this.name === "joko:conversation-preferences:v1") published.push({ value, durable: database.readUiRecord() });
      for (const peer of channels) if (peer !== this && peer.name === this.name) {
        queueMicrotask(() => peer.onmessage?.({ data: value } as MessageEvent<unknown>));
      }
    }
    close(): void { channels.delete(this); }
  }
  vi.stubGlobal("BroadcastChannel", TestChannel);
  try {
    const state = memoryLocalState(database.database);
    const changed = vi.fn();
    const unsubscribe = subscribeConversationPreferencesChange(changed);
    const patches = [
      { composerSendShortcut: "modifier-enter" as const }, { messageNavRailEnabled: false }, { streamFadeEnabled: false },
      { webLinkOpenPreference: "sidebar" as const }, { localLinkOpenPreference: "external" as const },
      { personalizationPrompts: { "owner-a": "Use concise answers.", "owner-b": "Explain tradeoffs." } },
      { newSessionWorktreeEnabled: true }
    ];
    for (const [index, patch] of patches.entries()) {
      await state.mutatePreferences((current) => ({ ...current, ...patch }));
      await state.mutatePreferences((current) => ({ ...current, ...patch }));
      await Promise.resolve();
      expect(changed).toHaveBeenCalledTimes(index + 1);
      expect(published[index]).toMatchObject({ value: { kind: "conversation-preferences-changed" }, durable: patch });
    }
    await state.mutatePreferences((current) => ({ ...current, theme: "light", locale: "zh-CN" }));
    expect(published).toHaveLength(patches.length);
    database.failNextPut();
    await expect(state.mutatePreferences((current) => ({ ...current, composerSendShortcut: "enter" })))
      .rejects.toThrow("preference write failed");
    expect(published).toHaveLength(patches.length);
    await state.mutatePreferences((current) => ({
      ...current,
      personalizationPrompts: { "owner-b": "Explain tradeoffs.", "owner-a": "Use concise answers." }
    }));
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(patches.length + 1);
    expect(published[patches.length]?.value).toEqual({ kind: "conversation-preferences-changed" });
    expect(Object.keys((published[patches.length]?.durable as UiPreferences).personalizationPrompts)).toEqual(["owner-b", "owner-a"]);
    await state.mutatePreferences((current) => ({
      ...current, composerSendShortcut: "enter", messageNavRailEnabled: true, streamFadeEnabled: true,
      webLinkOpenPreference: "external", localLinkOpenPreference: "sidebar", personalizationPrompts: {}, newSessionWorktreeEnabled: false
    }));
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(patches.length + 2);
    expect(published[patches.length + 1]?.durable).toMatchObject({ theme: "light", locale: "zh-CN" });
    for (const patch of patches) expect(published[patches.length + 1]?.durable).not.toHaveProperty(Object.keys(patch)[0]!);
    unsubscribe();
    vi.stubGlobal("BroadcastChannel", undefined);
    await expect(state.mutatePreferences((current) => ({ ...current, composerSendShortcut: "modifier-enter" }))).resolves.toMatchObject({
      composerSendShortcut: "modifier-enter"
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("device-local recent projects", () => {
  it("partitions exact connection owners and keeps failed removal from inventing a successful state", async () => {
    const database = memoryPreferenceDatabase();
    const firstWindow = memoryLocalState(database.database);
    const secondWindow = memoryLocalState(database.database);
    const project = { targetId: "target", workspaceId: "workspace", name: "Project", serverPath: "/srv/project", lastUsedAt: 1 };
    await firstWindow.recordRecentProject("server-a\u0000profile-a", project);
    await expect(secondWindow.readRecentProjects("server-a\u0000profile-a")).resolves.toEqual([expect.objectContaining({
      targetId: project.targetId, workspaceId: project.workspaceId, serverPath: project.serverPath
    })]);
    await expect(secondWindow.readRecentProjects("server-a\u0000profile-b")).resolves.toEqual([]);
    await expect(secondWindow.readRecentProjects("server-b\u0000profile-a")).resolves.toEqual([]);

    database.failNextPut();
    await expect(secondWindow.removeRecentProject("server-a\u0000profile-a", project)).rejects.toThrow("preference write failed");
    await expect(firstWindow.readRecentProjects("server-a\u0000profile-a")).resolves.toHaveLength(1);
    await secondWindow.removeRecentProject("server-a\u0000profile-a", project);
    await expect(firstWindow.readRecentProjects("server-a\u0000profile-a")).resolves.toEqual([]);
  });
});

function memoryLocalState(database: IDBDatabase): LocalState {
  const LocalStateConstructor = LocalState as unknown as new (database: IDBDatabase) => LocalState;
  return new LocalStateConstructor(database);
}

function shortcut(code: string, key?: string): AppShortcutCombo {
  return {
    code,
    ...(key === undefined ? {} : { key }),
    meta: false,
    ctrl: true,
    alt: false,
    shift: false
  };
}

function memoryPreferenceDatabase(): {
  readonly database: IDBDatabase;
  readonly failNextPut: () => void;
  readonly readUiRecord: () => unknown;
} {
  const records = new Map<IDBValidKey, unknown>();
  let rejectNextPut = false;
  const database = {
    transaction(): IDBTransaction {
      let hasWrite = false;
      let settled = false;
      const transaction = {
        error: null as DOMException | null,
        oncomplete: null as ((event: Event) => void) | null,
        onabort: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        objectStore(): IDBObjectStore {
          return {
            get(key: IDBValidKey): IDBRequest<unknown> {
              const request = {
                result: undefined as unknown,
                error: null as DOMException | null,
                onsuccess: null as ((event: Event) => void) | null,
                onerror: null as ((event: Event) => void) | null
              };
              queueMicrotask(() => {
                request.result = records.get(key);
                request.onsuccess?.(new Event("success"));
                queueMicrotask(() => {
                  if (settled || hasWrite) return;
                  settled = true;
                  transaction.oncomplete?.(new Event("complete"));
                });
              });
              return request as unknown as IDBRequest<unknown>;
            },
            put(value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
              if (key === undefined) throw new Error("The in-memory preference store requires a key.");
              hasWrite = true;
              const shouldReject = rejectNextPut;
              rejectNextPut = false;
              queueMicrotask(() => {
                if (settled) return;
                settled = true;
                if (shouldReject) {
                  transaction.error = new DOMException("preference write failed", "AbortError");
                  transaction.onabort?.(new Event("abort"));
                  return;
                }
                records.set(key, value);
                transaction.oncomplete?.(new Event("complete"));
              });
              return {} as IDBRequest<IDBValidKey>;
            }
          } as IDBObjectStore;
        }
      };
      return transaction as unknown as IDBTransaction;
    }
  } as unknown as IDBDatabase;
  return {
    database,
    failNextPut: () => { rejectNextPut = true; },
    readUiRecord: () => records.get("ui")
  };
}
