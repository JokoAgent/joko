import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  DESKTOP_CHANNELS,
  parseDesktopWallpaperSettingsChange,
  requireDesktopWallpaperRevision,
  type DesktopWallpaperImportResult
} from "./channels.js";
import type { DesktopWallpaperStore } from "./wallpaper-store.js";

export interface DesktopWallpaperIpcOptions {
  readonly ipc: Pick<IpcMain, "handle">;
  readonly store: () => Pick<DesktopWallpaperStore, "get" | "set" | "importFromSelectedFile" | "remove" | "reset">;
  readonly captureOwner: (event: IpcMainInvokeEvent) => () => void;
  readonly pickFile: (event: IpcMainInvokeEvent) => Promise<string | undefined>;
}

let importActive = false;
const REQUEST_FAILURE = "Wallpaper settings could not be changed. Read the current state and try again.";

/** The native picker alone supplies a source path; renderer requests contain only settings and revisions. */
export function registerDesktopWallpaperIpc(options: DesktopWallpaperIpcOptions): void {
  const request = async <T>(event: IpcMainInvokeEvent, effect: (assertCurrent: () => void) => Promise<T>): Promise<T> => {
    try {
      const assertCurrent = options.captureOwner(event);
      assertCurrent();
      const result = await effect(assertCurrent);
      assertCurrent();
      return result;
    } catch {
      throw new Error(REQUEST_FAILURE);
    }
  };

  options.ipc.handle(DESKTOP_CHANNELS.wallpaperGet, (event, ...parameters: unknown[]) => request(event, async assertCurrent => {
    if (parameters.length !== 0) throw new TypeError("Wallpaper get does not accept parameters.");
    assertCurrent();
    return options.store().get();
  }));
  options.ipc.handle(DESKTOP_CHANNELS.wallpaperSet, (event, ...parameters: unknown[]) => request(event, async assertCurrent => {
    if (parameters.length !== 1) throw new TypeError("Wallpaper set requires one exact request.");
    const change = parseDesktopWallpaperSettingsChange(parameters[0]);
    assertCurrent();
    return options.store().set(change, assertCurrent);
  }));
  options.ipc.handle(DESKTOP_CHANNELS.wallpaperRemove, (event, ...parameters: unknown[]) => request(event, async assertCurrent => {
    if (parameters.length !== 1) throw new TypeError("Wallpaper remove requires one revision.");
    const revision = requireDesktopWallpaperRevision(parameters[0]);
    assertCurrent();
    return options.store().remove(revision, assertCurrent);
  }));
  options.ipc.handle(DESKTOP_CHANNELS.wallpaperReset, (event, ...parameters: unknown[]) => request(event, async assertCurrent => {
    if (parameters.length !== 1) throw new TypeError("Wallpaper reset requires one revision.");
    const revision = requireDesktopWallpaperRevision(parameters[0]);
    assertCurrent();
    return options.store().reset(revision, assertCurrent);
  }));
  options.ipc.handle(DESKTOP_CHANNELS.wallpaperImport, (event, ...parameters: unknown[]) => request<DesktopWallpaperImportResult>(event, async assertCurrent => {
    if (parameters.length !== 1) throw new TypeError("Wallpaper import requires one revision.");
    const expectedRevision = requireDesktopWallpaperRevision(parameters[0]);
    const store = options.store();
    if (importActive || store.get().revision !== expectedRevision) throw new Error("Wallpaper import is busy or changed.");
    assertCurrent();
    importActive = true;
    try {
      const selected = await options.pickFile(event);
      assertCurrent();
      if (selected === undefined) return { cancelled: true };
      if (store.get().revision !== expectedRevision) throw new Error("Wallpaper settings changed while selecting an image.");
      assertCurrent();
      const settings = await store.importFromSelectedFile(selected, expectedRevision, assertCurrent);
      return { cancelled: false, settings };
    } finally {
      importActive = false;
    }
  }));
}
