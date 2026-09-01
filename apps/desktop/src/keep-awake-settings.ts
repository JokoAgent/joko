import type { DesktopKeepAwakeSettings } from "./channels.js";
import { atomicWritePrivateFile, readPrivateFile } from "./secure-files.js";

const DEFAULT_KEEP_AWAKE_ENABLED = false;

export interface DesktopKeepAwakeSettingsStore {
  readonly initialize: () => Promise<DesktopKeepAwakeSettings>;
  readonly get: () => DesktopKeepAwakeSettings;
  readonly setEnabled: (enabled: boolean) => Promise<DesktopKeepAwakeSettings>;
}

export function createDesktopKeepAwakeSettingsStore(
  path: string
): DesktopKeepAwakeSettingsStore {
  let value = wire(DEFAULT_KEEP_AWAKE_ENABLED);
  let initialization: Promise<DesktopKeepAwakeSettings> | undefined;
  let writeTail = Promise.resolve();

  const initialize = (): Promise<DesktopKeepAwakeSettings> => {
    if (initialization !== undefined) return initialization;
    initialization = readPrivateFile(path).then((bytes) => {
      if (bytes === undefined) return value;
      try {
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!isKeepAwakeSettingsFile(parsed)) return value;
        value = wire(parsed.enabled);
        return value;
      } catch {
        // Corrupt device-local state fails closed to the disabled policy.
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
        return Promise.reject(new TypeError("Desktop keep-awake setting must be boolean."));
      }
      return enqueue(async () => {
        await initialize();
        const bytes = Buffer.from(`${JSON.stringify({ enabled })}\n`, "utf8");
        try {
          await atomicWritePrivateFile(path, bytes);
        } finally {
          bytes.fill(0);
        }
        value = wire(enabled);
        return value;
      });
    }
  });
}

function isKeepAwakeSettingsFile(value: unknown): value is DesktopKeepAwakeSettings {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).join(",") === "enabled" &&
    typeof (value as Record<string, unknown>)["enabled"] === "boolean";
}

function wire(enabled: boolean): DesktopKeepAwakeSettings {
  return Object.freeze({ enabled });
}
