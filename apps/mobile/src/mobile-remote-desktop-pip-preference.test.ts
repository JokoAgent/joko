import { describe, expect, it, vi } from "vitest";
import { MobileRemoteDesktopPipPreferenceStore } from "./mobile-remote-desktop-pip-preference";

describe("phone-local Remote Desktop background intent", () => {
  it("defaults off and adopts a new intent only after its durable write", async () => {
    let complete!: () => void;
    const storage = { getItem: vi.fn(async () => null), setItem: vi.fn((_key: string, _value: string) => new Promise<void>(resolve => { complete = resolve; })) };
    const store = new MobileRemoteDesktopPipPreferenceStore(storage); await store.hydrate();
    expect(store.snapshot.enabled).toBe(false);
    const pending = store.update(true); await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledOnce());
    expect(store.snapshot).toMatchObject({ enabled: false, saving: true });
    complete(); await pending; expect(store.snapshot).toMatchObject({ enabled: true, saving: false });
    expect(JSON.parse(storage.setItem.mock.calls[0]![1])).toEqual({ version: 1, enabled: true });
  });
  it("does not let a late hydration replace an explicit saved edit", async () => {
    let complete!: (value: string | null) => void;
    const storage = { getItem: vi.fn(() => new Promise<string | null>(resolve => { complete = resolve; })), setItem: vi.fn(async () => undefined) };
    const store = new MobileRemoteDesktopPipPreferenceStore(storage), reading = store.hydrate();
    await vi.waitFor(() => expect(storage.getItem).toHaveBeenCalledOnce());
    await store.update(true); complete(JSON.stringify({ version: 1, enabled: false })); await reading;
    expect(store.snapshot.enabled).toBe(true);
  });
  it("keeps the adopted intent on save failure and can save the next explicit change", async () => {
    const storage = { getItem: vi.fn(async () => JSON.stringify({ version: 1, enabled: true })), setItem: vi.fn(async () => undefined) };
    const store = new MobileRemoteDesktopPipPreferenceStore(storage); await store.hydrate();
    storage.setItem.mockRejectedValueOnce(new Error("private storage detail")); await store.update(false);
    expect(store.snapshot).toMatchObject({ enabled: true, saving: false, notice: "save-failed" });
    expect(JSON.stringify(store.snapshot)).not.toContain("private storage detail");
    await store.update(false); expect(store.snapshot).toMatchObject({ enabled: false, status: "ready" });
  });
  it("serializes writes and waits for them when a screen remounts", async () => {
    let stored: string | null = null, complete!: () => void;
    const storage = { getItem: vi.fn(async () => stored), setItem: vi.fn((_key: string, value: string) =>
      new Promise<void>(resolve => { complete = () => { stored = value; resolve(); }; })) };
    const first = new MobileRemoteDesktopPipPreferenceStore(storage); await first.hydrate();
    const saving = first.update(true); await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledOnce());
    const second = new MobileRemoteDesktopPipPreferenceStore(storage), reading = second.hydrate();
    expect(second.snapshot.status).toBe("loading"); complete(); await saving; await reading;
    expect(second.snapshot.enabled).toBe(true);
  });
  it.each(["true", '{"version":0,"enabled":true}', '{"version":1,"enabled":"true"}',
    '{"version":1,"enabled":true,"target":"other"}'])("rejects incompatible persisted shape %s without enabling background viewing", async raw => {
    const storage = { getItem: vi.fn(async () => raw), setItem: vi.fn(async () => undefined) };
    const store = new MobileRemoteDesktopPipPreferenceStore(storage); await store.hydrate();
    expect(store.snapshot).toMatchObject({ enabled: false, notice: "load-failed" });
    storage.getItem.mockResolvedValue(JSON.stringify({ version: 1, enabled: true })); await store.retryLoad();
    expect(store.snapshot).toMatchObject({ enabled: true, status: "ready" });
  });
});
