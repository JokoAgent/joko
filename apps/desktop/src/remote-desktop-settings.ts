import { atomicWritePrivateFile, readPrivateFile } from "./secure-files.js";

export interface DesktopRemoteDesktopSettings {
  readonly enabled: boolean;
}

export interface DesktopRemoteDesktopSettingsStore {
  initialize(): Promise<DesktopRemoteDesktopSettings>;
  get(): DesktopRemoteDesktopSettings;
  setEnabled(enabled: boolean): Promise<DesktopRemoteDesktopSettings>;
}

/** Device-private opt-in. A missing, unreadable, or malformed file is disabled. */
export function createDesktopRemoteDesktopSettingsStore(
  path: string
): DesktopRemoteDesktopSettingsStore {
  let value = snapshot(false);
  let initialization: Promise<DesktopRemoteDesktopSettings> | undefined;
  let writeTail = Promise.resolve();

  const initialize = (): Promise<DesktopRemoteDesktopSettings> => {
    initialization ??= readPrivateFile(path).then((bytes) => {
      if (bytes === undefined) return value;
      try {
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (isSettings(parsed)) value = snapshot(parsed.enabled);
        return value;
      } catch {
        return value;
      } finally {
        bytes.fill(0);
      }
    }).catch(() => value);
    return initialization;
  };

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writeTail.then(operation, operation);
    writeTail = result.then(() => undefined, () => undefined);
    return result;
  };

  return Object.freeze({
    initialize,
    get: () => value,
    setEnabled: (enabled: boolean) => {
      if (typeof enabled !== "boolean") {
        return Promise.reject(new TypeError("Desktop Remote Desktop setting must be boolean."));
      }
      return enqueue(async () => {
        await initialize();
        const bytes = Buffer.from(`${JSON.stringify({ enabled })}\n`, "utf8");
        try {
          await atomicWritePrivateFile(path, bytes);
        } finally {
          bytes.fill(0);
        }
        value = snapshot(enabled);
        return value;
      });
    }
  });
}

function isSettings(value: unknown): value is DesktopRemoteDesktopSettings {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).join(",") === "enabled"
    && typeof (value as Record<string, unknown>)["enabled"] === "boolean";
}

function snapshot(enabled: boolean): DesktopRemoteDesktopSettings {
  return Object.freeze({ enabled });
}
