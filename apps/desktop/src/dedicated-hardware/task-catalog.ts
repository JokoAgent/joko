import {
  cloneDedicatedHardwareSettings,
  parseDedicatedHardwareBinding,
  type DedicatedHardwareBinding,
  type DedicatedHardwareSettings
} from "./settings.js";

export interface DedicatedHardwarePublishedTask {
  readonly sessionId: string;
  readonly sessionGeneration: string;
  readonly targetId: string;
  readonly title: string | null;
  readonly pinned: boolean;
  readonly userSendAt: number | null;
  readonly sidebarOrder: number | null;
  readonly catalogEligible: boolean;
  readonly priorityRank: number | null;
}

export interface DedicatedHardwareTaskCatalog {
  readonly version: 1;
  readonly profileId: string;
  readonly serverId: string;
  readonly connectionGeneration: string;
  readonly snapshotRevision: string;
  readonly tasks: readonly DedicatedHardwarePublishedTask[];
}

export const DEDICATED_HARDWARE_TASK_CATALOG_LIMIT = 100;

export interface DedicatedHardwareSelectedTaskSlot {
  readonly slot: number;
  readonly sessionId: string | null;
  readonly sessionGeneration: string | null;
  readonly targetId: string | null;
  readonly title: string | null;
  readonly binding: DedicatedHardwareBinding | null;
}

export interface DedicatedHardwareTaskSlotSelection {
  readonly version: 1;
  readonly profileId: string;
  readonly serverId: string;
  readonly connectionGeneration: string;
  readonly snapshotRevision: string;
  readonly slots: readonly DedicatedHardwareSelectedTaskSlot[];
}

export function parseDedicatedHardwareTaskCatalog(value: unknown): DedicatedHardwareTaskCatalog | undefined {
  if (!hasExactKeys(value, ["version", "profileId", "serverId", "connectionGeneration", "snapshotRevision", "tasks"]) ||
      value.version !== 1 || !isBoundedIdentity(value.profileId, 256) || !isBoundedIdentity(value.serverId, 256) ||
      !isDecimalRevision(value.connectionGeneration) || !isDecimalRevision(value.snapshotRevision) ||
      !Array.isArray(value.tasks) || value.tasks.length > DEDICATED_HARDWARE_TASK_CATALOG_LIMIT) return undefined;
  const seen = new Set<string>();
  const tasks: DedicatedHardwarePublishedTask[] = [];
  for (const raw of value.tasks) {
    if (!hasExactKeys(raw, [
      "sessionId", "sessionGeneration", "targetId", "title", "pinned", "userSendAt", "sidebarOrder",
      "catalogEligible", "priorityRank"
    ]) || !isBoundedIdentity(raw.sessionId, 512) || seen.has(raw.sessionId) ||
        !isDecimalRevision(raw.sessionGeneration) || !isBoundedIdentity(raw.targetId, 512) ||
        !(raw.title === null || isBoundedTitle(raw.title)) || typeof raw.pinned !== "boolean" ||
        !(raw.userSendAt === null || isNonnegativeSafeInteger(raw.userSendAt)) ||
        !(raw.sidebarOrder === null || isNonnegativeSafeInteger(raw.sidebarOrder)) ||
        typeof raw.catalogEligible !== "boolean" ||
        !(raw.priorityRank === null || isNonnegativeSafeInteger(raw.priorityRank))) return undefined;
    seen.add(raw.sessionId);
    tasks.push({
      sessionId: raw.sessionId,
      sessionGeneration: raw.sessionGeneration,
      targetId: raw.targetId,
      title: raw.title,
      pinned: raw.pinned,
      userSendAt: raw.userSendAt,
      sidebarOrder: raw.sidebarOrder,
      catalogEligible: raw.catalogEligible,
      priorityRank: raw.priorityRank
    });
  }
  return {
    version: 1,
    profileId: value.profileId,
    serverId: value.serverId,
    connectionGeneration: value.connectionGeneration,
    snapshotRevision: value.snapshotRevision,
    tasks
  };
}

export function selectDedicatedHardwareTaskSlots(
  settings: DedicatedHardwareSettings,
  catalog: DedicatedHardwareTaskCatalog
): DedicatedHardwareTaskSlotSelection {
  const canonicalSettings = cloneDedicatedHardwareSettings(settings);
  const canonicalCatalog = parseDedicatedHardwareTaskCatalog(catalog);
  if (canonicalCatalog === undefined) throw new TypeError("Invalid dedicated hardware task catalog.");
  const slotCount = Math.min(6, canonicalSettings.layout.taskKeys.length);
  const slots: DedicatedHardwareSelectedTaskSlot[] = [];
  if (canonicalSettings.taskSource === "custom") {
    for (let slot = 0; slot < slotCount; slot += 1) {
      const binding = parseDedicatedHardwareBinding(canonicalSettings.customTaskSlots[slot]);
      if (binding === undefined) throw new TypeError("Invalid dedicated hardware custom task binding.");
      slots.push({
        slot,
        sessionId: null,
        sessionGeneration: null,
        targetId: null,
        title: null,
        binding
      });
    }
  } else {
    const tasks = canonicalCatalog.tasks.filter((task) => task.catalogEligible).sort(
      comparatorFor(canonicalSettings.taskSource)
    );
    for (let slot = 0; slot < slotCount; slot += 1) {
      const task = tasks[slot];
      slots.push(task === undefined
        ? {
            slot,
            sessionId: null,
            sessionGeneration: null,
            targetId: null,
            title: null,
            binding: null
          }
        : {
            slot,
            sessionId: task.sessionId,
            sessionGeneration: task.sessionGeneration,
            targetId: task.targetId,
            title: task.title,
            binding: null
          });
    }
  }
  return {
    version: 1,
    profileId: canonicalCatalog.profileId,
    serverId: canonicalCatalog.serverId,
    connectionGeneration: canonicalCatalog.connectionGeneration,
    snapshotRevision: canonicalCatalog.snapshotRevision,
    slots
  };
}

function comparatorFor(
  source: Exclude<DedicatedHardwareSettings["taskSource"], "custom">
): (left: DedicatedHardwarePublishedTask, right: DedicatedHardwarePublishedTask) => number {
  if (source === "last-sent") {
    return (left, right) => compareNullableDescending(left.userSendAt, right.userSendAt) ||
      compareNullableAscending(left.sidebarOrder, right.sidebarOrder) || compareIdentity(left.sessionId, right.sessionId);
  }
  if (source === "priority") {
    return (left, right) => compareNullableAscending(left.priorityRank, right.priorityRank) ||
      compareNullableAscending(left.sidebarOrder, right.sidebarOrder) || compareIdentity(left.sessionId, right.sessionId);
  }
  return (left, right) => compareNullableAscending(left.sidebarOrder, right.sidebarOrder) ||
    compareIdentity(left.sessionId, right.sessionId);
}

function compareIdentity(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNullableAscending(left: number | null, right: number | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return left - right;
}

function compareNullableDescending(left: number | null, right: number | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return right - left;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isBoundedIdentity(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value &&
    !hasLoneSurrogate(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isBoundedTitle(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512 && value.trim() === value &&
    !hasLoneSurrogate(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    new TextEncoder().encode(value).byteLength <= 2_048;
}

function isDecimalRevision(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && /^(?:0|[1-9][0-9]*)$/u.test(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
