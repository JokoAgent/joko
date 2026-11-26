import type { ImagePickerAsset } from "expo-image-picker";
import type { MobilePlainStorageDriver } from "./connection-storage";

export type CustomWallpaperFile = { id: string; width: number; height: number; video: "mp4" | "mov" | "m4v" | null };
export type CustomWallpaper = CustomWallpaperFile & { imageUri: string; videoUri: string | null };
export type WallpaperMode = "off" | "static" | "dynamic";
type Choice = { mode: WallpaperMode; file?: CustomWallpaper };
const off: Choice = { mode: "off" };
const key = "joko.mobile.wallpaper.v1";

type FileManager = Pick<typeof import("./mobile-wallpaper-files"),
  "restoreCustomWallpaper" | "prepareCustomWallpaper" | "discardCustomWallpaper" | "cleanUnusedCustomWallpapers">;

export class MobileWallpaperStore {
  #current = off;
  #listeners = new Set<() => void>();
  #hydration?: Promise<void>;
  #writes = Promise.resolve();

  constructor(private readonly storage: MobilePlainStorageDriver, readonly supported: boolean,
    private readonly files: () => Promise<FileManager> = () => import("./mobile-wallpaper-files")) {}

  get snapshot() { return this.#current; }
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };

  hydrate(): Promise<void> {
    if (!this.supported) return Promise.resolve();
    return this.#hydration ??= this.#read().catch(error => { this.#hydration = undefined; throw error; });
  }

  async #read() {
    const raw = await this.storage.getItem(key);
    if (!raw) return;
    let saved;
    try { saved = JSON.parse(raw); } catch { return; }
    if (saved?.version !== 1 || !["off", "dynamic", "static"].includes(saved.mode)) return;
    const file = await (await this.files()).restoreCustomWallpaper(saved.file);
    if (file) this.#publish({ mode: saved.mode === "dynamic" && !file.videoUri ? "static" : saved.mode, file });
  }

  #publish(value: Choice) {
    this.#current = value;
    for (const listener of this.#listeners) listener();
  }

  #change(update: (previous: Choice, files: FileManager) => Promise<Choice> | Choice): Promise<void> {
    if (!this.supported) return Promise.resolve();
    const change = this.#writes.then(async () => {
      await this.hydrate();
      const files = await this.files();
      const previous = this.#current;
      const next = await update(previous, files);
      if (next === previous) return;
      try {
        if (next.file) {
          const { id, width, height, video } = next.file;
          await this.storage.setItem(key, JSON.stringify({ version: 1, mode: next.mode, file: { id, width, height, video } }));
        } else await this.storage.removeItem(key);
      } catch (error) {
        if (next.file && next.file.id !== previous.file?.id) await files.discardCustomWallpaper(next.file.id).catch(() => undefined);
        throw error;
      }
      this.#publish(next);
      if (previous.file && previous.file.id !== next.file?.id) await files.discardCustomWallpaper(previous.file.id).catch(() => undefined);
    });
    this.#writes = change.catch(() => undefined);
    return change;
  }

  importAsset(asset: ImagePickerAsset) {
    return this.#change(async (previous, files) => {
      await files.cleanUnusedCustomWallpapers(previous.file?.id).catch(() => undefined);
      const file = await files.prepareCustomWallpaper(asset);
      return { file, mode: file.videoUri ? "dynamic" : "static" };
    });
  }

  select(mode: WallpaperMode) {
    return this.#change(previous => previous.file && mode !== previous.mode && (mode !== "dynamic" || previous.file.videoUri)
      ? { file: previous.file, mode } : previous);
  }

  remove() { return this.#change(previous => previous.file ? off : previous); }
}
