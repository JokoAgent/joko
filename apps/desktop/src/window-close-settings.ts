import type {
  DesktopMainWindowCloseBehavior,
  DesktopMainWindowCloseSettings,
  DesktopMainWindowCloseSettingsChange
} from "./channels.js";
import { atomicWritePrivateFile, readPrivateFile } from "./secure-files.js";

export function isMainWindowCloseBehavior(value: unknown, platform: string): value is DesktopMainWindowCloseBehavior | null {
  return (platform === "win32" || platform === "linux") &&
    (value === null || value === "quit" || value === (platform === "win32" ? "tray" : "minimize"));
}

export function parseMainWindowCloseSettingsChange(value: unknown, platform: string): DesktopMainWindowCloseSettingsChange {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Main-window close settings require an object.");
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).sort().join(",") !== "behavior,expectedRevision" ||
    !isMainWindowCloseBehavior(entry["behavior"], platform) ||
    !Number.isSafeInteger(entry["expectedRevision"]) || (entry["expectedRevision"] as number) < 0) {
    throw new TypeError("Main-window close settings are invalid for this platform.");
  }
  return { behavior: entry["behavior"], expectedRevision: entry["expectedRevision"] as number };
}

export interface DesktopMainWindowCloseSettingsStore {
  initialize(): Promise<DesktopMainWindowCloseSettings>;
  get(): DesktopMainWindowCloseSettings;
  set(change: DesktopMainWindowCloseSettingsChange, isCurrent?: () => boolean): Promise<DesktopMainWindowCloseSettings>;
}

/** Device-local intent, committed before either publication or a close action. */
export function createDesktopMainWindowCloseSettingsStore(path: string, platform: string): DesktopMainWindowCloseSettingsStore {
  let state: DesktopMainWindowCloseSettings = Object.freeze({ behavior: null, revision: 0 });
  let initialization: Promise<DesktopMainWindowCloseSettings> | undefined;
  let writeTail = Promise.resolve();
  const initialize = (): Promise<DesktopMainWindowCloseSettings> => {
    initialization ??= readPrivateFile(path).then((bytes) => {
      if (bytes === undefined) return state;
      try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (typeof value === "object" && value !== null && !Array.isArray(value) &&
          Object.keys(value).join(",") === "behavior" &&
          isMainWindowCloseBehavior((value as Record<string, unknown>)["behavior"], platform)) {
          state = Object.freeze({ behavior: (value as { behavior: DesktopMainWindowCloseBehavior | null }).behavior, revision: 0 });
        }
      } catch { /* Invalid current settings leave the first-close choice unset. */ }
      finally { bytes.fill(0); }
      return state;
    }).catch(() => state);
    return initialization.then(() => state);
  };
  return {
    initialize,
    get: () => state,
    set: (input, isCurrent = () => true) => {
      const operation = async (): Promise<DesktopMainWindowCloseSettings> => {
        const change = parseMainWindowCloseSettingsChange(input, platform);
        await initialize();
        if (!isCurrent() || change.expectedRevision !== state.revision) {
          throw new Error("Main-window close settings changed. Reload before retrying.");
        }
        if (state.behavior === change.behavior) return state;
        const bytes = Buffer.from(`${JSON.stringify({ behavior: change.behavior })}\n`, "utf8");
        try { await atomicWritePrivateFile(path, bytes); }
        finally { bytes.fill(0); }
        state = Object.freeze({ behavior: change.behavior, revision: state.revision + 1 });
        return state;
      };
      const result = writeTail.then(operation, operation);
      writeTail = result.then(() => undefined, () => undefined);
      return result;
    }
  };
}
