import { atomicWritePrivateFile, deletePrivateFile, readPrivateFile } from "./secure-files.js";

const DEFAULT_ENABLE_BETA = false;

export interface DesktopUpdateChannelSettingsState {
  readonly enableBeta: boolean;
  readonly isCustomized: boolean;
  readonly defaultEnableBeta: boolean;
}

export interface DesktopUpdateChannelSettingsStore {
  readonly initialize: () => Promise<DesktopUpdateChannelSettingsState>;
  readonly get: () => DesktopUpdateChannelSettingsState;
  readonly setEnableBeta: (enabled: boolean) => Promise<DesktopUpdateChannelSettingsState>;
  readonly reset: () => Promise<DesktopUpdateChannelSettingsState>;
}

/** Device-owned update-channel choice. It deliberately survives account and
 * Orchestrator changes and stores no endpoint, credential, or release metadata. */
export function createDesktopUpdateChannelSettingsStore(
  path: string
): DesktopUpdateChannelSettingsStore {
  let value = wire(DEFAULT_ENABLE_BETA, false);
  let initialization: Promise<DesktopUpdateChannelSettingsState> | undefined;
  let writeTail = Promise.resolve();

  const initialize = (): Promise<DesktopUpdateChannelSettingsState> => {
    if (initialization !== undefined) return initialization;
    initialization = readPrivateFile(path).then((bytes) => {
      if (bytes === undefined) return value;
      try {
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return value;
        const record = parsed as Record<string, unknown>;
        if (Object.keys(record).join(",") !== "enableBeta") return value;
        const enabled = record["enableBeta"];
        if (typeof enabled !== "boolean") return value;
        value = wire(enabled, true);
        return value;
      } catch {
        // A corrupt device choice must never opt the user into a prerelease feed.
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
    setEnableBeta: (enabled: boolean) => {
      if (typeof enabled !== "boolean") {
        return Promise.reject(new TypeError("Desktop beta-channel setting must be boolean."));
      }
      return enqueue(async () => {
        await initialize();
        const bytes = Buffer.from(`${JSON.stringify({ enableBeta: enabled })}\n`, "utf8");
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
      value = wire(DEFAULT_ENABLE_BETA, false);
      return value;
    })
  });
}

function wire(enableBeta: boolean, isCustomized: boolean): DesktopUpdateChannelSettingsState {
  return Object.freeze({ enableBeta, isCustomized, defaultEnableBeta: DEFAULT_ENABLE_BETA });
}
