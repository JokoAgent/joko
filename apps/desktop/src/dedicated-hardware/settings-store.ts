import { join } from "node:path";

import { atomicWritePrivateFile, readPrivateFile } from "../secure-files.js";
import {
  DEDICATED_HARDWARE_MODEL_IDS,
  DEDICATED_HARDWARE_SETTINGS_MAX_BYTES,
  cloneDedicatedHardwareSettings,
  createDefaultDedicatedHardwareSettings,
  isDedicatedHardwareModelId,
  parseDedicatedHardwareSettings,
  type DedicatedHardwareModelId,
  type DedicatedHardwareSettings
} from "./settings.js";

export type DedicatedHardwareSettingsReadError = "invalid" | "unavailable";
export type DedicatedHardwareSettingsStateError = DedicatedHardwareSettingsReadError | null;

export interface DedicatedHardwareSettingsRead {
  readonly settings: DedicatedHardwareSettings;
  readonly error?: DedicatedHardwareSettingsReadError;
}

export function dedicatedHardwareSettingsStateError(
  value: DedicatedHardwareSettingsRead
): DedicatedHardwareSettingsStateError {
  return value.error ?? null;
}

export interface DedicatedHardwareSettingsStoreIo {
  readonly readFile: (path: string) => Promise<Uint8Array | undefined>;
  readonly atomicWriteFile: (path: string, bytes: Uint8Array) => Promise<void>;
}

export interface DedicatedHardwareSettingsStore {
  readonly initialize: () => Promise<Readonly<Record<DedicatedHardwareModelId, DedicatedHardwareSettingsRead>>>;
  readonly get: (model: DedicatedHardwareModelId) => DedicatedHardwareSettingsRead;
  readonly save: (model: DedicatedHardwareModelId, settings: DedicatedHardwareSettings) => Promise<DedicatedHardwareSettingsRead>;
  readonly reset: (
    model: DedicatedHardwareModelId,
    scope?: "layout" | "all"
  ) => Promise<DedicatedHardwareSettingsRead>;
  readonly subscribe: (
    listener: (model: DedicatedHardwareModelId, value: DedicatedHardwareSettingsRead) => void
  ) => () => void;
  readonly filePath: (model: DedicatedHardwareModelId) => string;
}

const DEFAULT_IO: DedicatedHardwareSettingsStoreIo = Object.freeze({
  readFile: readPrivateFile,
  atomicWriteFile: atomicWritePrivateFile
});

export function createDedicatedHardwareSettingsStore(options: {
  readonly directory: string;
  readonly io?: DedicatedHardwareSettingsStoreIo;
}): DedicatedHardwareSettingsStore {
  if (typeof options.directory !== "string" || options.directory.length === 0) {
    throw new TypeError("A dedicated hardware settings directory is required.");
  }
  const io = options.io ?? DEFAULT_IO;
  const values = new Map<DedicatedHardwareModelId, DedicatedHardwareSettingsRead>(
    DEDICATED_HARDWARE_MODEL_IDS.map((model) => [model, { settings: createDefaultDedicatedHardwareSettings(model) }])
  );
  const listeners = new Set<(model: DedicatedHardwareModelId, value: DedicatedHardwareSettingsRead) => void>();
  let initialization: Promise<Readonly<Record<DedicatedHardwareModelId, DedicatedHardwareSettingsRead>>> | undefined;
  let mutationTail = Promise.resolve();

  const filePath = (model: DedicatedHardwareModelId): string => {
    assertModel(model);
    return join(options.directory, `dedicated-hardware.${model}.v1.json`);
  };

  const initialize = (): Promise<Readonly<Record<DedicatedHardwareModelId, DedicatedHardwareSettingsRead>>> => {
    if (initialization !== undefined) return initialization;
    initialization = Promise.all(DEDICATED_HARDWARE_MODEL_IDS.map(async (model) => {
      const value = await readModel(io, filePath(model), model);
      values.set(model, value);
      return [model, cloneRead(value)] as const;
    })).then((entries) => Object.freeze(Object.fromEntries(entries)) as Readonly<Record<DedicatedHardwareModelId, DedicatedHardwareSettingsRead>>);
    return initialization;
  };

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const commit = async (
    model: DedicatedHardwareModelId,
    settings: DedicatedHardwareSettings
  ): Promise<DedicatedHardwareSettingsRead> => {
    const parsed = parseDedicatedHardwareSettings(settings);
    if (parsed === undefined) throw new TypeError("Invalid dedicated hardware settings.");
    const bytes = new TextEncoder().encode(`${JSON.stringify(parsed)}\n`);
    if (bytes.byteLength > DEDICATED_HARDWARE_SETTINGS_MAX_BYTES) {
      throw new RangeError("Dedicated hardware settings exceed the storage limit.");
    }
    await io.atomicWriteFile(filePath(model), bytes);
    const next: DedicatedHardwareSettingsRead = { settings: parsed };
    values.set(model, next);
    const published = cloneRead(next);
    for (const listener of listeners) {
      try { listener(model, cloneRead(published)); } catch { /* An observer cannot roll back a persisted commit. */ }
    }
    return published;
  };

  const store: DedicatedHardwareSettingsStore = {
    initialize,
    get: (model) => {
      assertModel(model);
      return cloneRead(values.get(model)!);
    },
    save: (model, settings) => {
      assertModel(model);
      return enqueue(async () => {
        await initialize();
        return commit(model, settings);
      });
    },
    reset: (model, scope = "all") => {
      assertModel(model);
      if (scope !== "layout" && scope !== "all") {
        return Promise.reject(new TypeError("Unknown dedicated hardware reset scope."));
      }
      return enqueue(async () => {
        await initialize();
        const current = values.get(model)!.settings;
        const defaults = createDefaultDedicatedHardwareSettings(model);
        const next = scope === "layout"
          ? { ...cloneDedicatedHardwareSettings(current), layout: defaults.layout }
          : { ...defaults, enabled: current.enabled };
        return commit(model, next);
      });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    filePath
  };
  return Object.freeze(store);
}

async function readModel(
  io: DedicatedHardwareSettingsStoreIo,
  path: string,
  model: DedicatedHardwareModelId
): Promise<DedicatedHardwareSettingsRead> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await io.readFile(path);
  } catch {
    return { settings: createDefaultDedicatedHardwareSettings(model), error: "unavailable" };
  }
  if (bytes === undefined) return { settings: createDefaultDedicatedHardwareSettings(model) };
  if (bytes.byteLength === 0 || bytes.byteLength > DEDICATED_HARDWARE_SETTINGS_MAX_BYTES) {
    return { settings: createDefaultDedicatedHardwareSettings(model), error: "invalid" };
  }
  try {
    const parsedJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    const settings = parseDedicatedHardwareSettings(parsedJson);
    return settings === undefined
      ? { settings: createDefaultDedicatedHardwareSettings(model), error: "invalid" }
      : { settings };
  } catch {
    return { settings: createDefaultDedicatedHardwareSettings(model), error: "invalid" };
  }
}

function cloneRead(value: DedicatedHardwareSettingsRead): DedicatedHardwareSettingsRead {
  return value.error === undefined
    ? { settings: cloneDedicatedHardwareSettings(value.settings) }
    : { settings: cloneDedicatedHardwareSettings(value.settings), error: value.error };
}

function assertModel(model: DedicatedHardwareModelId): void {
  if (!isDedicatedHardwareModelId(model)) throw new TypeError("Unknown dedicated hardware model.");
}
