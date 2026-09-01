import type { DesktopWindowInteractionSettings } from "./channels.js";
import { atomicWritePrivateFile, readPrivateFile } from "./secure-files.js";

const DEFAULT_SWALLOW_ACTIVATION_CLICK = false;

export interface DesktopWindowInteractionSettingsStore {
  readonly initialize: () => Promise<DesktopWindowInteractionSettings>;
  readonly get: () => DesktopWindowInteractionSettings;
  readonly setSwallowActivationClick: (enabled: boolean) => Promise<DesktopWindowInteractionSettings>;
}

export function createDesktopWindowInteractionSettingsStore(
  path: string
): DesktopWindowInteractionSettingsStore {
  let value = wire(DEFAULT_SWALLOW_ACTIVATION_CLICK);
  let initialization: Promise<DesktopWindowInteractionSettings> | undefined;
  let writeTail = Promise.resolve();

  const initialize = (): Promise<DesktopWindowInteractionSettings> => {
    if (initialization !== undefined) return initialization;
    initialization = readPrivateFile(path).then((bytes) => {
      if (bytes === undefined) return value;
      try {
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!isWindowInteractionSettingsFile(parsed)) return value;
        value = wire(parsed.swallowActivationClick);
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
    setSwallowActivationClick: (enabled: boolean) => {
      if (typeof enabled !== "boolean") {
        return Promise.reject(new TypeError("Desktop activation-click setting must be boolean."));
      }
      return enqueue(async () => {
        await initialize();
        const bytes = Buffer.from(`${JSON.stringify({ swallowActivationClick: enabled })}\n`, "utf8");
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

function isWindowInteractionSettingsFile(value: unknown): value is DesktopWindowInteractionSettings {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).join(",") === "swallowActivationClick" &&
    typeof (value as Record<string, unknown>)["swallowActivationClick"] === "boolean";
}

function wire(swallowActivationClick: boolean): DesktopWindowInteractionSettings {
  return Object.freeze({ swallowActivationClick });
}
