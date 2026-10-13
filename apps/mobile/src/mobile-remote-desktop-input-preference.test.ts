import { describe, expect, it, vi } from "vitest";
import { createInputModePreferenceStore, createMouseButtonsPreferenceStore,
  type MobileRemoteDesktopInputPreferenceStorage, type MobileRemoteDesktopInputPreferenceStore,
  type MobileRemoteDesktopStoredInputMode } from "./mobile-remote-desktop-input-preference";

function verifyPreference<T extends string | boolean>(name: string,
  createStore: (storage: MobileRemoteDesktopInputPreferenceStorage) => MobileRemoteDesktopInputPreferenceStore<T>,
  initial: T, edited: T, field: string, incompatible: readonly string[]) {
  describe(name, () => {
    it("uses the default without writing and adopts explicit choices while saving", async () => {
      let finish!: () => void;
      const storage = { getItem: vi.fn(async () => null), setItem: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) };
      const store = createStore(storage); await store.hydrate();
      expect(store.snapshot).toEqual({ status: "ready", value: initial, saving: false });
      expect(storage.setItem).not.toHaveBeenCalled();
      const save = store.update(edited);
      expect(store.snapshot).toEqual({ status: "ready", value: edited, saving: true });
      await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledOnce());
      finish(); await save;
      expect(store.snapshot).toEqual({ status: "ready", value: edited, saving: false });
    });
    it("ignores a late hydration after an explicit choice even when its save fails", async () => {
      let finishRead!: (raw: string | null) => void;
      const storage = { getItem: vi.fn(() => new Promise<string | null>(resolve => { finishRead = resolve; })),
        setItem: vi.fn(async (): Promise<void> => { throw new Error("private storage detail"); }) };
      const store = createStore(storage), reading = store.hydrate();
      await vi.waitFor(() => expect(storage.getItem).toHaveBeenCalledOnce());
      await store.update(edited); finishRead(JSON.stringify({ version: 1, [field]: initial })); await reading;
      expect(store.snapshot).toEqual({ status: "error", value: edited, saving: false, notice: "save-failed" });
      expect(JSON.stringify(store.snapshot)).not.toContain("private storage detail");
      storage.setItem.mockImplementation(async () => undefined);
      await store.update(store.snapshot.value);
      expect(store.snapshot).toEqual({ status: "ready", value: edited, saving: false });
    });
    it("preserves write order across rapid edits and waits for pending saves on remount", async () => {
      let raw: string | null = null;
      const queued: (() => void)[] = [];
      const storage = { getItem: vi.fn(async () => raw), setItem: vi.fn((_key: string, value: string) =>
        new Promise<void>(resolve => { queued.push(() => { raw = value; resolve(); }); })) };
      const first = createStore(storage); await first.hydrate();
      const saveOne = first.update(edited), saveTwo = first.update(initial);
      const nextScreen = createStore(storage), reading = nextScreen.hydrate();
      await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledTimes(1));
      expect(first.snapshot).toMatchObject({ value: initial, saving: true });
      expect(storage.getItem).toHaveBeenCalledTimes(1);
      queued.shift()!(); await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledTimes(2));
      expect(first.snapshot.saving).toBe(true); queued.shift()!();
      await Promise.all([saveOne, saveTwo, reading]);
      expect(nextScreen.snapshot).toEqual({ status: "ready", value: initial, saving: false });
      expect(storage.setItem.mock.calls.map(call => JSON.parse(call[1]))).toEqual([
        { version: 1, [field]: edited }, { version: 1, [field]: initial }
      ]);
    });
    it.each(incompatible)("rejects incompatible persisted values and retries the current read: %s", async raw => {
      const storage = { getItem: vi.fn(async () => raw), setItem: vi.fn(async () => undefined) };
      const store = createStore(storage); await store.hydrate();
      expect(store.snapshot).toEqual({ status: "error", value: initial, saving: false, notice: "load-failed" });
      storage.getItem.mockResolvedValue(JSON.stringify({ version: 1, [field]: edited }));
      await store.retryLoad(); expect(store.snapshot).toEqual({ status: "ready", value: edited, saving: false });
      expect(storage.setItem).not.toHaveBeenCalled();
    });
  });
}

verifyPreference("phone-local Remote Desktop input mode", createInputModePreferenceStore,
  "touch", "trackpad", "mode", ["trackpad", '{"version":1,"mode":"pointer"}',
    '{"version":1,"mode":"pan"}', '{"version":0,"mode":"touch"}', '{"version":1,"mode":"touch","target":"other"}']);
verifyPreference("phone-local Remote Desktop mouse controls", createMouseButtonsPreferenceStore,
  false, true, "enabled", ["true", '{"version":1,"enabled":"true"}',
    '{"version":1,"enabled":true,"mode":"touch"}', '{"version":0,"enabled":true}']);

it("owns independent keys without reading or overwriting the other setting", async () => {
  const saved = new Map<string, string>(); let finishMode!: () => void;
  const storage = { getItem: vi.fn(async (key: string) => saved.get(key) ?? null),
    setItem: vi.fn((key: string, raw: string) => key.includes("input-mode") ? new Promise<void>(resolve => {
      finishMode = () => { saved.set(key, raw); resolve(); };
    }) : Promise.resolve().then(() => { saved.set(key, raw); })) };
  const mode = createInputModePreferenceStore(storage), buttons = createMouseButtonsPreferenceStore(storage);
  const savingMode = mode.update("trackpad");
  await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledOnce());
  await buttons.hydrate(); await buttons.update(true);
  expect(mode.snapshot.saving).toBe(true); expect(buttons.snapshot.value).toBe(true);
  finishMode(); await savingMode;
  expect(Object.fromEntries(saved)).toEqual({
    "joko.mobile.remote-desktop.input-mode.v1": '{"version":1,"mode":"trackpad"}',
    "joko.mobile.remote-desktop.show-mouse-buttons.v1": '{"version":1,"enabled":true}'
  });
  expect(storage.getItem).toHaveBeenCalledWith("joko.mobile.remote-desktop.show-mouse-buttons.v1");
  expect(storage.getItem).not.toHaveBeenCalledWith("joko.mobile.remote-desktop.input-mode.v1");
});
it("keeps pan temporary and never replaces an explicit choice through read retry", async () => {
  const storage = { getItem: vi.fn(async () => '{"version":1,"mode":"touch"}'),
    setItem: vi.fn(async () => { throw new Error("private write failure"); }) };
  const mode = createInputModePreferenceStore(storage);
  await expect(mode.update("pan" as MobileRemoteDesktopStoredInputMode)).rejects.toThrow("Invalid Remote Desktop input preference.");
  expect(storage.setItem).not.toHaveBeenCalled();
  await mode.update("trackpad"); await mode.hydrate(); await mode.retryLoad();
  expect(mode.snapshot).toEqual({ status: "error", value: "trackpad", saving: false, notice: "save-failed" });
  expect(storage.getItem).not.toHaveBeenCalled();
});
