import type { DesktopNativeTaskStatusDisplay } from "./channels.js";
import { atomicWritePrivateFile, readPrivateFile } from "./secure-files.js";

const MAXIMUM_LAYOUT_PREFERENCES = 32;
const MINIMUM_PERSISTED_WIDTH = 240;
const MAXIMUM_PERSISTED_WIDTH = 2_000;

export interface DesktopNativeTaskStatusLayoutPreference {
  readonly displayId: number;
  readonly displayName: string;
  readonly displayIndex: number;
  readonly displayBounds: DesktopNativeTaskStatusDisplay["bounds"];
  readonly centerXRatio: number;
  readonly compactWidth: number;
  readonly expandedWidth: number;
}

export interface DesktopNativeTaskStatusLayoutSettingsStore {
  readonly initialize: () => Promise<readonly DesktopNativeTaskStatusLayoutPreference[]>;
  readonly get: () => readonly DesktopNativeTaskStatusLayoutPreference[];
  readonly set: (
    preference: DesktopNativeTaskStatusLayoutPreference
  ) => Promise<readonly DesktopNativeTaskStatusLayoutPreference[]>;
}

export function createDesktopNativeTaskStatusLayoutSettingsStore(
  path: string
): DesktopNativeTaskStatusLayoutSettingsStore {
  let value: readonly DesktopNativeTaskStatusLayoutPreference[] = Object.freeze([]);
  let initialization: Promise<readonly DesktopNativeTaskStatusLayoutPreference[]> | undefined;
  let writeTail = Promise.resolve();

  const initialize = (): Promise<readonly DesktopNativeTaskStatusLayoutPreference[]> => {
    if (initialization !== undefined) return initialization;
    initialization = readPrivateFile(path).then((bytes) => {
      if (bytes === undefined) return value;
      try {
        value = parseLayoutSettings(JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        ) as unknown);
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
    set: (input: DesktopNativeTaskStatusLayoutPreference) => {
      let preference: DesktopNativeTaskStatusLayoutPreference;
      try {
        preference = parseLayoutPreference(input);
      } catch (error) {
        return Promise.reject(error);
      }
      return enqueue(async () => {
        await initialize();
        const next = [...value];
        const existingIndex = next.findIndex((candidate) => samePersistedDisplay(candidate, preference));
        if (existingIndex >= 0) {
          next[existingIndex] = preference;
        } else {
          next.push(preference);
        }
        value = Object.freeze(next.slice(-MAXIMUM_LAYOUT_PREFERENCES));
        const bytes = Buffer.from(`${JSON.stringify({ version: 1, preferences: value })}\n`, "utf8");
        try {
          await atomicWritePrivateFile(path, bytes);
        } finally {
          bytes.fill(0);
        }
        return value;
      });
    }
  });
}

export function resolveDesktopNativeTaskStatusLayoutPreference(
  preferences: readonly DesktopNativeTaskStatusLayoutPreference[],
  display: DesktopNativeTaskStatusDisplay,
  displayIndex: number
): DesktopNativeTaskStatusLayoutPreference | undefined {
  const exact = preferences.find((preference) => preference.displayId === display.id);
  if (exact !== undefined) return exact;
  const namedAtBounds = preferences.find((preference) => preference.displayName === display.name &&
    sameBounds(preference.displayBounds, display.bounds));
  if (namedAtBounds !== undefined) return namedAtBounds;
  const atBounds = preferences.filter((preference) => sameBounds(preference.displayBounds, display.bounds));
  if (atBounds.length === 1) return atBounds[0];
  const namedAtIndex = preferences.find((preference) => preference.displayName === display.name &&
    preference.displayIndex === displayIndex);
  if (namedAtIndex !== undefined) return namedAtIndex;
  const atIndex = preferences.filter((preference) => preference.displayIndex === displayIndex);
  return atIndex.length === 1 ? atIndex[0] : undefined;
}

function parseLayoutSettings(value: unknown): readonly DesktopNativeTaskStatusLayoutPreference[] {
  if (!isRecord(value) || !hasExactKeys(value, ["preferences", "version"]) || value["version"] !== 1 ||
    !Array.isArray(value["preferences"]) || value["preferences"].length > MAXIMUM_LAYOUT_PREFERENCES) {
    throw new TypeError("Native task-status layout settings are invalid.");
  }
  return Object.freeze(value["preferences"].map(parseLayoutPreference));
}

function parseLayoutPreference(value: unknown): DesktopNativeTaskStatusLayoutPreference {
  if (!isRecord(value) || !hasExactKeys(value, [
    "centerXRatio", "compactWidth", "displayBounds", "displayId", "displayIndex", "displayName", "expandedWidth"
  ]) || !isSafeInteger(value["displayId"]) || !isSafeInteger(value["displayIndex"]) ||
    (value["displayIndex"] as number) < 0 || !isDisplayName(value["displayName"]) ||
    typeof value["centerXRatio"] !== "number" || !Number.isFinite(value["centerXRatio"]) ||
    value["centerXRatio"] < 0 || value["centerXRatio"] > 1 ||
    !isPersistedWidth(value["compactWidth"]) || !isPersistedWidth(value["expandedWidth"])) {
    throw new TypeError("Native task-status layout preference is invalid.");
  }
  const bounds = parseBounds(value["displayBounds"]);
  return Object.freeze({
    displayId: value["displayId"] as number,
    displayName: value["displayName"] as string,
    displayIndex: value["displayIndex"] as number,
    displayBounds: bounds,
    centerXRatio: value["centerXRatio"],
    compactWidth: value["compactWidth"],
    expandedWidth: value["expandedWidth"]
  });
}

function parseBounds(value: unknown): DesktopNativeTaskStatusDisplay["bounds"] {
  if (!isRecord(value) || !hasExactKeys(value, ["height", "width", "x", "y"]) ||
    ![value["x"], value["y"], value["width"], value["height"]].every(isSafeInteger) ||
    (value["width"] as number) <= 0 || (value["height"] as number) <= 0) {
    throw new TypeError("Native task-status display bounds are invalid.");
  }
  return Object.freeze({
    x: value["x"] as number,
    y: value["y"] as number,
    width: value["width"] as number,
    height: value["height"] as number
  });
}

function samePersistedDisplay(
  left: DesktopNativeTaskStatusLayoutPreference,
  right: DesktopNativeTaskStatusLayoutPreference
): boolean {
  return left.displayId === right.displayId ||
    left.displayName === right.displayName && sameBounds(left.displayBounds, right.displayBounds) ||
    left.displayName === right.displayName && left.displayIndex === right.displayIndex;
}

function sameBounds(
  left: DesktopNativeTaskStatusDisplay["bounds"],
  right: DesktopNativeTaskStatusDisplay["bounds"]
): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isPersistedWidth(value: unknown): value is number {
  return isSafeInteger(value) && value >= MINIMUM_PERSISTED_WIDTH && value <= MAXIMUM_PERSISTED_WIDTH;
}

function isDisplayName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 160 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
