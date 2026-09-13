import type { DesktopUpdateAutoRelaunchSettings } from "./channels.js";
import { atomicWritePrivateFile, deletePrivateFile, readPrivateFile } from "./secure-files.js";

const DEFAULT_AUTO_RELAUNCH_ON_IDLE = false;

export interface DesktopUpdateAutoSettingsStore {
  readonly initialize: () => Promise<DesktopUpdateAutoRelaunchSettings>;
  readonly get: () => DesktopUpdateAutoRelaunchSettings;
  readonly setAutoRelaunchOnIdle: (enabled: boolean) => Promise<DesktopUpdateAutoRelaunchSettings>;
  readonly reset: () => Promise<DesktopUpdateAutoRelaunchSettings>;
}

export function createDesktopUpdateAutoSettingsStore(
  path: string
): DesktopUpdateAutoSettingsStore {
  let value = wire(DEFAULT_AUTO_RELAUNCH_ON_IDLE, false);
  let initialization: Promise<DesktopUpdateAutoRelaunchSettings> | undefined;
  let writeTail = Promise.resolve();

  const initialize = (): Promise<DesktopUpdateAutoRelaunchSettings> => {
    if (initialization !== undefined) return initialization;
    initialization = readPrivateFile(path).then((bytes) => {
      if (bytes === undefined) return value;
      try {
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return value;
        const record = parsed as Record<string, unknown>;
        if (Object.keys(record).join(",") !== "autoRelaunchOnIdle") return value;
        const enabled = record["autoRelaunchOnIdle"];
        if (typeof enabled !== "boolean") return value;
        value = wire(enabled, true);
        return value;
      } catch {
        // Corrupt settings fail closed to the default disabled policy.
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
    setAutoRelaunchOnIdle: (enabled: boolean) => {
      if (typeof enabled !== "boolean") {
        return Promise.reject(new TypeError("Desktop auto relaunch setting must be boolean."));
      }
      return enqueue(async () => {
        await initialize();
        const bytes = Buffer.from(`${JSON.stringify({ autoRelaunchOnIdle: enabled })}\n`, "utf8");
        try {
          await atomicWritePrivateFile(path, bytes);
        } finally {
          bytes.fill(0);
        }
        value = wire(enabled, true);
        return value;
      });
    },
    reset: () => enqueue(async () => {
      await initialize();
      await deletePrivateFile(path);
      value = wire(DEFAULT_AUTO_RELAUNCH_ON_IDLE, false);
      return value;
    })
  });
}

function wire(enabled: boolean, customized: boolean): DesktopUpdateAutoRelaunchSettings {
  return Object.freeze({
    autoRelaunchOnIdle: enabled,
    isCustomized: customized,
    defaultAutoRelaunchOnIdle: DEFAULT_AUTO_RELAUNCH_ON_IDLE
  });
}
