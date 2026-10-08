import { describe, expect, it, vi } from "vitest";

import {
  MOBILE_REMOTE_DESKTOP_DEFAULT_VIDEO_SETTINGS,
  MobileRemoteDesktopVideoPreferenceStore
} from "./mobile-remote-desktop-video-preference";

function driver(initial: string | null = null) {
  let value = initial;
  return {
    getItem: vi.fn(async () => value),
    setItem: vi.fn(async (_key: string, next: string) => { value = next; })
  };
}

describe("MobileRemoteDesktopVideoPreferenceStore", () => {
  it("defaults audio on and hydrates only the current-v1 audio record", async () => {
    const storage = driver(JSON.stringify({ version: 1, audio: false }));
    const store = new MobileRemoteDesktopVideoPreferenceStore(storage);

    await store.hydrate();

    expect(store.snapshot).toEqual({
      status: "ready",
      settings: { fps: 30, quality: "auto", audio: false },
      saving: false
    });
  });

  it("does not let a late hydration overwrite a user edit", async () => {
    let resolve!: (value: string | null) => void;
    const storage = driver();
    storage.getItem.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const store = new MobileRemoteDesktopVideoPreferenceStore(storage);
    const loading = store.hydrate();
    await Promise.resolve();

    store.update({ fps: 60, quality: "saver", audio: false });
    resolve(JSON.stringify({ version: 1, audio: true }));
    await loading;

    expect(store.snapshot.settings).toEqual({ fps: 60, quality: "saver", audio: false });
    expect(storage.setItem).toHaveBeenCalledWith(
      "joko.mobile.remote-desktop.audio.v1",
      JSON.stringify({ version: 1, audio: false })
    );
  });

  it("persists audio only while FPS and quality remain session-local", async () => {
    const storage = driver();
    const store = new MobileRemoteDesktopVideoPreferenceStore(storage);
    await store.hydrate();

    store.update({ fps: 60, quality: "hd", audio: true });
    expect(storage.setItem).not.toHaveBeenCalled();
    store.update({ fps: 60, quality: "hd", audio: false });
    await vi.waitFor(() => expect(store.snapshot.saving).toBe(false));

    expect(storage.setItem).toHaveBeenCalledOnce();
    const replacement = new MobileRemoteDesktopVideoPreferenceStore(storage);
    await replacement.hydrate();
    expect(replacement.snapshot.settings).toEqual({
      ...MOBILE_REMOTE_DESKTOP_DEFAULT_VIDEO_SETTINGS,
      audio: false
    });
  });

  it.each([
    "not-json",
    JSON.stringify({ version: 0, audio: false }),
    JSON.stringify({ version: 1, audio: "false" }),
    JSON.stringify({ version: 1, audio: false, legacy: true })
  ])("fails closed to the default for a non-current record: %s", async (raw) => {
    const store = new MobileRemoteDesktopVideoPreferenceStore(driver(raw));

    await store.hydrate();

    expect(store.snapshot.status).toBe("error");
    expect(store.snapshot.settings).toEqual(MOBILE_REMOTE_DESKTOP_DEFAULT_VIDEO_SETTINGS);
  });
});
