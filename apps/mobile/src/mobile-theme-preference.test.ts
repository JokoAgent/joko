import { describe, expect, it, vi } from "vitest";
import { MobileThemePreferenceStore, resolveMobileDarkTheme } from "./mobile-theme-preference";
import { MobileWallpaperStore, type CustomWallpaper } from "./mobile-wallpaper";
import type { ImagePickerAsset } from "expo-image-picker";

describe("iOS custom wallpaper", () => {
  const file: CustomWallpaper = { id: "first", width: 800, height: 600, video: "mp4", imageUri: "file:///poster.jpg", videoUri: "file:///loop.mp4" };
  const asset: ImagePickerAsset = { uri: "file:///picker.mov", width: 800, height: 600, type: "video" };

  it("imports an iOS photo with no picker dimensions using its decoded, oriented pixels", async () => {
    const id = "f7978075-a97e-4374-8acc-77d078fe01cc";
    const uri = "file:///cache/ImagePicker/portrait.heic";
    const target = "file:///documents/wallpapers/" + id + "/poster.jpg";
    const original = { width: 3000, height: 6000, release: vi.fn() };
    const scaled = { width: 1920, height: 3840, release: vi.fn(),
      saveAsync: vi.fn(async () => ({ uri: "file:///cache/scaled.jpg", width: 1920, height: 3840 })) };
    const context = { resize: vi.fn(), release: vi.fn(), renderAsync: vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(scaled) };
    const move = vi.fn(async () => undefined), remove = vi.fn(async () => undefined);
    vi.doMock("expo-image-manipulator", () => ({ ImageManipulator: { manipulate: () => context }, SaveFormat: { JPEG: "jpeg" } }));
    vi.doMock("expo-crypto", () => ({ randomUUID: () => id }));
    vi.doMock("expo-file-system/legacy", () => ({
      documentDirectory: "file:///documents/", cacheDirectory: "file:///cache/",
      getInfoAsync: async (path: string) => ({ exists: path === uri, isDirectory: false, size: 32_000 }),
      makeDirectoryAsync: vi.fn(), moveAsync: move, deleteAsync: remove
    }));
    try {
      const storage = { ...driver(), removeItem: vi.fn() };
      const store = new MobileWallpaperStore(storage, true);
      await store.importAsset({ uri, type: "image", width: 0, height: 0 });
      expect(context.resize).toHaveBeenCalledWith({ height: 3840 });
      expect(scaled.saveAsync).toHaveBeenCalledOnce();
      expect(move).toHaveBeenCalledWith({ from: "file:///cache/scaled.jpg", to: target });
      expect(store.snapshot).toMatchObject({ mode: "static", file: { id, imageUri: target, width: 1920, height: 3840 } });
      expect(JSON.parse(storage.setItem.mock.calls[0]![1]).file).toEqual({ id, width: 1920, height: 3840, video: null });
      for (const resource of [original, scaled, context]) expect(resource.release).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledWith(uri, { idempotent: true });
    } finally {
      vi.doUnmock("expo-image-manipulator"); vi.doUnmock("expo-crypto"); vi.doUnmock("expo-file-system/legacy");
    }
  });

  it("restores a relocated poster, serializes changes and retires files only after persistence", async () => {
    const storage = { ...driver(), removeItem: vi.fn(async () => undefined) };
    const files = { cleanUnusedCustomWallpapers: vi.fn(async () => undefined), prepareCustomWallpaper: vi.fn(async () => file),
      restoreCustomWallpaper: vi.fn(async () => ({ ...file, imageUri: "file:///new-container/poster.jpg", video: null, videoUri: null })),
      discardCustomWallpaper: vi.fn(async () => undefined) };
    const store = new MobileWallpaperStore(storage, true, async () => files);
    await Promise.all([store.importAsset(asset), store.select("static")]);
    expect(store.snapshot.mode).toBe("static");
    expect(storage.setItem.mock.lastCall?.[1]).not.toContain("file://");
    await store.select("dynamic");
    const restored = new MobileWallpaperStore(storage, true, async () => files);
    await restored.hydrate();
    expect(restored.snapshot).toMatchObject({ mode: "static", file: { imageUri: "file:///new-container/poster.jpg" } });
    files.prepareCustomWallpaper.mockResolvedValueOnce({ ...file, id: "replacement" });
    storage.setItem.mockRejectedValueOnce(new Error("storage full"));
    await expect(store.importAsset(asset)).rejects.toThrow("storage full");
    expect(store.snapshot.file?.id).toBe("first");
    expect(files.discardCustomWallpaper.mock.calls).toEqual([["replacement"]]);
    await store.remove();
    expect(store.snapshot).toEqual({ mode: "off" });
    expect(files.discardCustomWallpaper.mock.calls).toEqual([["replacement"], ["first"]]);
  });

  it("keeps storage and native media untouched on other platforms", async () => {
    const storage = { ...driver(), removeItem: vi.fn() };
    const files = vi.fn(async () => { throw new Error("unexpected media access"); });
    const store = new MobileWallpaperStore(storage, false, files);
    await store.hydrate();
    await store.importAsset(asset);
    expect(store.snapshot.mode).toBe("off");
    expect(files).not.toHaveBeenCalled();
    expect(storage.getItem).not.toHaveBeenCalled();
  });
});

function driver(initial: string | null = null) {
  let value = initial;
  return {
    getItem: vi.fn(async () => value),
    setItem: vi.fn(async (_key: string, next: string) => { value = next; })
  };
}

describe("MobileThemePreferenceStore", () => {
  it("hydrates only the strict current-v1 record and resolves system appearance", async () => {
    const storage = driver(JSON.stringify({ version: 1, theme: "dark" }));
    const store = new MobileThemePreferenceStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);

    await store.hydrate();

    expect(store.snapshot).toEqual({ status: "ready", preference: "dark", saving: false });
    expect(listener).toHaveBeenCalledOnce();
    expect(resolveMobileDarkTheme("dark", "light")).toBe(true);
    expect(resolveMobileDarkTheme("light", "dark")).toBe(false);
    expect(resolveMobileDarkTheme("system", "dark")).toBe(true);
    expect(resolveMobileDarkTheme("system", "light")).toBe(false);
  });

  it.each([
    "not-json",
    JSON.stringify({ version: 0, theme: "dark" }),
    JSON.stringify({ version: 1, theme: "blue" }),
    JSON.stringify({ version: 1, theme: "dark", legacy: true })
  ])("fails closed to system for a non-current record: %s", async (raw) => {
    const store = new MobileThemePreferenceStore(driver(raw));

    await store.hydrate();

    expect(store.snapshot.status).toBe("error");
    expect(store.snapshot.preference).toBe("system");
    expect(store.snapshot.error).toContain("System appearance is being used");
  });

  it("uses system appearance with an explicit error when the saved preference is unreadable", async () => {
    const storage = driver();
    storage.getItem.mockRejectedValueOnce(new Error("storage locked"));
    const store = new MobileThemePreferenceStore(storage);

    await store.hydrate();

    expect(store.snapshot).toMatchObject({ status: "error", preference: "system", saving: false });
    expect(store.snapshot.error).toContain("storage locked");
  });

  it("publishes a new preference only after its current-v1 record is durable", async () => {
    let release!: () => void;
    const storage = driver();
    storage.setItem.mockImplementationOnce(async () => new Promise<void>((resolve) => { release = resolve; }));
    const store = new MobileThemePreferenceStore(storage);
    await store.hydrate();

    const saving = store.setPreference("dark");
    expect(store.snapshot).toEqual({ status: "ready", preference: "system", saving: true });
    await expect(store.setPreference("light")).rejects.toThrow("already being saved");
    release();
    await saving;

    expect(storage.setItem).toHaveBeenCalledWith(
      "joko.mobile.theme.v1",
      JSON.stringify({ version: 1, theme: "dark" })
    );
    expect(store.snapshot).toEqual({ status: "ready", preference: "dark", saving: false });
  });

  it("retains the previously applied preference when persistence fails", async () => {
    const storage = driver(JSON.stringify({ version: 1, theme: "light" }));
    const store = new MobileThemePreferenceStore(storage);
    await store.hydrate();
    storage.setItem.mockRejectedValueOnce(new Error("disk unavailable"));

    await expect(store.setPreference("dark")).rejects.toThrow("disk unavailable");

    expect(store.snapshot.preference).toBe("light");
    expect(store.snapshot.saving).toBe(false);
    expect(store.snapshot.error).toContain("could not be saved");
  });
});
