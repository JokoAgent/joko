import type { DesktopNativeTaskStatusSettings } from "./channels.js";
import {
  defaultDesktopNativeTaskStatusSettings,
  parseDesktopNativeTaskStatusSettings
} from "./native-task-status.js";
import { atomicWritePrivateFile, readPrivateFile } from "./secure-files.js";

export interface DesktopNativeTaskStatusSettingsStore {
  readonly initialize: () => Promise<DesktopNativeTaskStatusSettings>;
  readonly get: () => DesktopNativeTaskStatusSettings;
  readonly set: (settings: DesktopNativeTaskStatusSettings) => Promise<DesktopNativeTaskStatusSettings>;
}

export function createDesktopNativeTaskStatusSettingsStore(
  path: string
): DesktopNativeTaskStatusSettingsStore {
  let value = defaultDesktopNativeTaskStatusSettings();
  let initialization: Promise<DesktopNativeTaskStatusSettings> | undefined;
  let writeTail = Promise.resolve();

  const initialize = (): Promise<DesktopNativeTaskStatusSettings> => {
    if (initialization !== undefined) return initialization;
    initialization = readPrivateFile(path).then((bytes) => {
      if (bytes === undefined) return value;
      try {
        value = parseDesktopNativeTaskStatusSettings(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
        );
        return value;
      } catch {
        // Device-local corruption returns to the opt-in disabled default.
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
    set: (settings: DesktopNativeTaskStatusSettings) => {
      let next: DesktopNativeTaskStatusSettings;
      try {
        next = parseDesktopNativeTaskStatusSettings(settings);
      } catch (error) {
        return Promise.reject(error);
      }
      return enqueue(async () => {
        await initialize();
        const bytes = Buffer.from(`${JSON.stringify(next)}\n`, "utf8");
        try {
          await atomicWritePrivateFile(path, bytes);
        } finally {
          bytes.fill(0);
        }
        value = next;
        return value;
      });
    }
  });
}
