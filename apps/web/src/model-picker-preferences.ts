import { useSyncExternalStore } from "react";

import { randomUuid } from "./web-crypto.js";
import {
  mergeObservedProviderDisplayOrder,
  normalizeProviderDisplayOrder
} from "./provider-display-order.js";

export type ModelPickerLayout = "original" | "classic" | "badge";

export interface ModelFavoriteConfiguration {
  readonly uid: string;
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly effort?: string;
  readonly fast?: true;
}

export interface ModelRowConfiguration {
  readonly effort?: string;
  readonly fast?: true;
}

export interface ModelPickerOwnerPreferences {
  readonly favorites: readonly ModelFavoriteConfiguration[];
  readonly visibility: Readonly<Record<string, boolean>>;
  readonly configurations: Readonly<Record<string, ModelRowConfiguration>>;
  readonly providerOrder: readonly string[];
  readonly seeded: boolean;
}

type PreferenceOperation =
  | { readonly id: string; readonly kind: "favorite-add"; readonly item: ModelFavoriteConfiguration }
  | { readonly id: string; readonly kind: "favorite-update"; readonly uid: string; readonly effort?: string | null; readonly fast?: boolean }
  | { readonly id: string; readonly kind: "favorite-remove"; readonly uid: string }
  | { readonly id: string; readonly kind: "favorite-seed"; readonly item: ModelFavoriteConfiguration }
  | { readonly id: string; readonly kind: "visibility"; readonly modelKey: string; readonly visible: boolean | null }
  | { readonly id: string; readonly kind: "configuration"; readonly modelKey: string; readonly configuration: ModelRowConfiguration | null }
  | { readonly id: string; readonly kind: "provider-order"; readonly visibleProviderIds: readonly string[] };

interface StoredOwnerPreferences {
  readonly version: 1;
  readonly favorites: readonly ModelFavoriteConfiguration[];
  readonly visibility: Readonly<Record<string, boolean>>;
  readonly configurations: Readonly<Record<string, ModelRowConfiguration>>;
  readonly providerOrder: readonly string[];
  readonly seeded: boolean;
}

type PendingOperation = PreferenceOperation & { readonly expiresAt: number };

const OWNER_STORAGE_PREFIX = "joko:model-picker-owner:v1:";
const LAYOUT_STORAGE_KEY = "joko:model-picker-layout:v1";
const MAXIMUM_FAVORITES = 512;
const MAXIMUM_VISIBILITY_OVERRIDES = 4_096;
const MAXIMUM_MODEL_CONFIGURATIONS = 4_096;
const REASSERTION_WINDOW_MS = 30_000;
const listeners = new Set<() => void>();
const pendingByStorageKey = new Map<string, PendingOperation[]>();
const ownerMemory = new Map<string, StoredOwnerPreferences>();
let layoutMemory: ModelPickerLayout = "original";
let revision = 0;

export function modelPreferenceOwnerId(serverId: string | undefined): string | undefined {
  const value = serverId?.trim();
  return validBoundedText(value, 256) ? value : undefined;
}

export function providerPreferenceKey(backendId: string, providerId: string): string {
  return JSON.stringify([backendId, providerId]);
}

export function modelPreferenceKey(backendId: string, providerId: string, modelId: string): string {
  return `${backendId}\u0000${providerId}\u0000${modelId}`;
}

export function readModelPickerOwnerPreferences(ownerId: string | undefined): ModelPickerOwnerPreferences {
  if (ownerId === undefined) return emptyOwnerPreferences();
  return readStoredOwner(ownerStorageKey(ownerId));
}

export function useModelPickerOwnerPreferences(ownerId: string | undefined): ModelPickerOwnerPreferences {
  useSyncExternalStore(subscribe, snapshotRevision, () => 0);
  return readModelPickerOwnerPreferences(ownerId);
}

export function isModelVisible(
  preferences: Pick<ModelPickerOwnerPreferences, "visibility">,
  backendId: string,
  providerId: string,
  modelId: string,
  defaultVisible = true
): boolean {
  return preferences.visibility[modelPreferenceKey(backendId, providerId, modelId)] ?? defaultVisible;
}

export function setModelVisible(
  ownerId: string | undefined,
  backendId: string,
  providerId: string,
  modelId: string,
  visible: boolean,
  defaultVisible = true
): void {
  if (ownerId === undefined) return;
  const modelKey = checkedModelKey(backendId, providerId, modelId);
  commit(ownerStorageKey(ownerId), {
    id: randomUuid(),
    kind: "visibility",
    modelKey,
    visible: visible === defaultVisible ? null : visible
  });
}

export function readModelConfiguration(
  preferences: Pick<ModelPickerOwnerPreferences, "configurations">,
  backendId: string,
  providerId: string,
  modelId: string
): ModelRowConfiguration | undefined {
  return preferences.configurations[modelPreferenceKey(backendId, providerId, modelId)];
}

export function setModelConfiguration(
  ownerId: string | undefined,
  backendId: string,
  providerId: string,
  modelId: string,
  configuration: { readonly effort?: string; readonly fast?: boolean }
): void {
  if (ownerId === undefined) return;
  const effort = normalizeEffort(configuration.effort);
  if (configuration.effort !== undefined && effort === undefined) return;
  const normalized: ModelRowConfiguration | null = effort === undefined && configuration.fast !== true
    ? null
    : { ...(effort === undefined ? {} : { effort }), ...(configuration.fast === true ? { fast: true } : {}) };
  commit(ownerStorageKey(ownerId), {
    id: randomUuid(),
    kind: "configuration",
    modelKey: checkedModelKey(backendId, providerId, modelId),
    configuration: normalized
  });
}

/**
 * Persist the visible Provider rows in their requested order. Entries that are
 * temporarily absent stay in their old slots, and first-seen entries append.
 */
export function setProviderDisplayOrder(
  ownerId: string | undefined,
  visibleProviderIds: readonly string[]
): void {
  if (ownerId === undefined) return;
  const normalized = normalizeProviderDisplayOrder(visibleProviderIds);
  if (normalized.length !== visibleProviderIds.length || normalized.some((key) => !validProviderPreferenceKey(key))) return;
  commit(ownerStorageKey(ownerId), {
    id: randomUuid(),
    kind: "provider-order",
    visibleProviderIds: normalized
  });
}

export function addModelFavorite(
  ownerId: string | undefined,
  configuration: Omit<ModelFavoriteConfiguration, "uid">
): ModelFavoriteConfiguration | undefined {
  if (ownerId === undefined) return undefined;
  const item = normalizeFavorite({ ...configuration, uid: `favorite-${randomUuid()}` });
  if (item === undefined) return undefined;
  const current = readModelPickerOwnerPreferences(ownerId).favorites.find((candidate) => sameFavoriteConfiguration(candidate, item));
  if (current !== undefined) return current;
  commit(ownerStorageKey(ownerId), { id: randomUuid(), kind: "favorite-add", item });
  return item;
}

export function seedModelFavorite(
  ownerId: string | undefined,
  configuration: Omit<ModelFavoriteConfiguration, "uid">
): ModelFavoriteConfiguration | undefined {
  if (ownerId === undefined) return undefined;
  const current = readModelPickerOwnerPreferences(ownerId);
  if (current.seeded) return current.favorites[0];
  const item = normalizeFavorite({ ...configuration, uid: `favorite-${randomUuid()}` });
  if (item === undefined) return undefined;
  commit(ownerStorageKey(ownerId), { id: randomUuid(), kind: "favorite-seed", item });
  return item;
}

export function updateModelFavorite(
  ownerId: string | undefined,
  uid: string,
  patch: { readonly effort?: string | null; readonly fast?: boolean }
): void {
  if (ownerId === undefined || !validBoundedText(uid, 128)) return;
  const effort = patch.effort === null ? null : normalizeEffort(patch.effort);
  if (patch.effort !== undefined && effort === undefined) return;
  commit(ownerStorageKey(ownerId), {
    id: randomUuid(),
    kind: "favorite-update",
    uid,
    ...(patch.effort === undefined ? {} : { effort }),
    ...(patch.fast === undefined ? {} : { fast: patch.fast })
  });
}

export function removeModelFavorite(ownerId: string | undefined, uid: string): void {
  if (ownerId === undefined || !validBoundedText(uid, 128)) return;
  commit(ownerStorageKey(ownerId), { id: randomUuid(), kind: "favorite-remove", uid });
}

export function readModelPickerLayout(): ModelPickerLayout {
  if (typeof window === "undefined") return layoutMemory;
  try {
    const value = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (value === "classic" || value === "badge") layoutMemory = value;
    return value === "classic" || value === "badge" ? value : layoutMemory;
  } catch {
    return layoutMemory;
  }
}

export function useModelPickerLayout(): ModelPickerLayout {
  useSyncExternalStore(subscribe, snapshotRevision, () => 0);
  return readModelPickerLayout();
}

export function setModelPickerLayout(layout: ModelPickerLayout): void {
  if (typeof window === "undefined" || readModelPickerLayout() === layout) return;
  layoutMemory = layout;
  try {
    if (layout === "original") window.localStorage.removeItem(LAYOUT_STORAGE_KEY);
    else window.localStorage.setItem(LAYOUT_STORAGE_KEY, layout);
  } catch {
    // A blocked local store still permits the in-memory interaction to finish.
  }
  notify();
}

export function resetModelPickerPreferencesForTests(): void {
  pendingByStorageKey.clear();
  ownerMemory.clear();
  layoutMemory = "original";
  if (typeof window !== "undefined") {
    try {
      const keys: string[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key === LAYOUT_STORAGE_KEY || key?.startsWith(OWNER_STORAGE_PREFIX) === true) keys.push(key);
      }
      for (const key of keys) window.localStorage.removeItem(key);
    } catch {
      // Test environments may intentionally replace localStorage with a fault.
    }
  }
  notify();
}

function commit(storageKey: string, operation: PreferenceOperation): void {
  const next = applyOperation(readStoredOwner(storageKey), operation);
  writeStoredOwner(storageKey, next);
  const now = Date.now();
  const pending = (pendingByStorageKey.get(storageKey) ?? [])
    .filter((candidate) => candidate.expiresAt > now);
  pending.push({ ...operation, expiresAt: now + REASSERTION_WINDOW_MS });
  pendingByStorageKey.set(storageKey, compactPendingOperations(pending));
  notify();
  void reconcileStorageKey(storageKey);
}

async function reconcileStorageKey(storageKey: string): Promise<void> {
  const now = Date.now();
  const pending = (pendingByStorageKey.get(storageKey) ?? []).filter((candidate) => candidate.expiresAt > now);
  if (pending.length === 0) {
    pendingByStorageKey.delete(storageKey);
    return;
  }
  const run = (): void => {
    let current = readStoredOwner(storageKey);
    for (const operation of pending) current = applyOperation(current, operation);
    writeStoredOwner(storageKey, current);
    notify();
  };
  const lockManager = typeof navigator === "undefined"
    ? undefined
    : (navigator as Navigator & {
        readonly locks?: { request(name: string, callback: () => void | Promise<void>): Promise<void> };
      }).locks;
  if (lockManager === undefined) {
    run();
    return;
  }
  await lockManager.request(`joko:model-picker:${storageKey}`, run).catch(() => undefined);
}

function applyOperation(
  source: ModelPickerOwnerPreferences,
  operation: PreferenceOperation
): StoredOwnerPreferences {
  let favorites = [...source.favorites];
  let visibility = { ...source.visibility };
  let configurations = { ...source.configurations };
  let providerOrder = [...source.providerOrder];
  let seeded = source.seeded;
  switch (operation.kind) {
    case "favorite-add":
      if (!favorites.some((candidate) => candidate.uid === operation.item.uid || sameFavoriteConfiguration(candidate, operation.item))) {
        favorites = [...favorites, operation.item].slice(-MAXIMUM_FAVORITES);
      }
      break;
    case "favorite-seed":
      if (!seeded && favorites.length === 0 && !favorites.some((candidate) => candidate.uid === operation.item.uid)) favorites = [operation.item];
      seeded = true;
      break;
    case "favorite-update":
      favorites = favorites.map((candidate) => {
        if (candidate.uid !== operation.uid) return candidate;
        const effort = operation.effort === undefined ? candidate.effort : operation.effort ?? undefined;
        const fast = operation.fast === undefined ? candidate.fast === true : operation.fast;
        return {
          uid: candidate.uid,
          backendId: candidate.backendId,
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          ...(effort === undefined ? {} : { effort }),
          ...(fast ? { fast: true as const } : {})
        };
      });
      break;
    case "favorite-remove":
      favorites = favorites.filter((candidate) => candidate.uid !== operation.uid);
      break;
    case "visibility": {
      if (operation.visible === null) {
        delete visibility[operation.modelKey];
      } else {
        visibility[operation.modelKey] = operation.visible;
      }
      break;
    }
    case "configuration":
      if (operation.configuration === null) delete configurations[operation.modelKey];
      else configurations[operation.modelKey] = operation.configuration;
      break;
    case "provider-order":
      providerOrder = mergeObservedProviderDisplayOrder(providerOrder, operation.visibleProviderIds);
      break;
  }
  return { version: 1, favorites, visibility, configurations, providerOrder, seeded };
}

function readStoredOwner(storageKey: string): StoredOwnerPreferences {
  if (typeof window === "undefined") return ownerMemory.get(storageKey) ?? emptyOwnerPreferences();
  try {
    const value = window.localStorage.getItem(storageKey);
    if (value === null) return ownerMemory.get(storageKey) ?? emptyOwnerPreferences();
    const parsed = sanitizeStoredOwner(JSON.parse(value) as unknown);
    ownerMemory.set(storageKey, parsed);
    return parsed;
  } catch {
    return ownerMemory.get(storageKey) ?? emptyOwnerPreferences();
  }
}

function writeStoredOwner(storageKey: string, value: StoredOwnerPreferences): void {
  ownerMemory.set(storageKey, value);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Private browsing and quota failures retain only the current render state.
  }
}

function sanitizeStoredOwner(value: unknown): StoredOwnerPreferences {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return emptyOwnerPreferences();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "configurations,favorites,providerOrder,seeded,version,visibility"
    || record["version"] !== 1
    || !Array.isArray(record["favorites"])
    || record["visibility"] === null
    || typeof record["visibility"] !== "object"
    || Array.isArray(record["visibility"])
    || record["configurations"] === null
    || typeof record["configurations"] !== "object"
    || Array.isArray(record["configurations"])
    || !Array.isArray(record["providerOrder"])
    || typeof record["seeded"] !== "boolean"
  ) return emptyOwnerPreferences();
  if ((record["favorites"] as unknown[]).length > MAXIMUM_FAVORITES) return emptyOwnerPreferences();
  const favorites: ModelFavoriteConfiguration[] = [];
  const seenUids = new Set<string>();
  for (const candidate of record["favorites"]) {
    const favorite = normalizeFavorite(candidate);
    if (favorite === undefined || !isCurrentFavoriteRecord(candidate, favorite) || seenUids.has(favorite.uid)) return emptyOwnerPreferences();
    seenUids.add(favorite.uid);
    favorites.push(favorite);
  }
  const rawVisibility = Object.entries(record["visibility"] as Record<string, unknown>);
  if (rawVisibility.length > MAXIMUM_VISIBILITY_OVERRIDES) return emptyOwnerPreferences();
  const visibility: Record<string, boolean> = {};
  for (const [key, enabled] of rawVisibility) {
    if (!validModelKey(key) || typeof enabled !== "boolean") return emptyOwnerPreferences();
    visibility[key] = enabled;
  }
  const rawConfigurations = Object.entries(record["configurations"] as Record<string, unknown>);
  if (rawConfigurations.length > MAXIMUM_MODEL_CONFIGURATIONS) return emptyOwnerPreferences();
  const configurations: Record<string, ModelRowConfiguration> = {};
  for (const [key, value] of rawConfigurations) {
    if (!validModelKey(key) || value === null || typeof value !== "object" || Array.isArray(value)) return emptyOwnerPreferences();
    const configuration = value as Record<string, unknown>;
    if (Object.keys(configuration).some((field) => field !== "effort" && field !== "fast")) return emptyOwnerPreferences();
    const effort = normalizeEffort(configuration["effort"]);
    const fast = configuration["fast"] === true;
    if (
      (Object.hasOwn(configuration, "effort") && effort !== configuration["effort"])
      || (Object.hasOwn(configuration, "fast") && configuration["fast"] !== true)
      || (effort === undefined && !fast)
    ) return emptyOwnerPreferences();
    configurations[key] = { ...(effort === undefined ? {} : { effort }), ...(fast ? { fast: true } : {}) };
  }
  const rawProviderOrder = record["providerOrder"] as unknown[];
  const providerOrder = normalizeProviderDisplayOrder(rawProviderOrder);
  if (providerOrder.length !== rawProviderOrder.length
    || providerOrder.some((value, index) => value !== rawProviderOrder[index] || !validProviderPreferenceKey(value))) {
    return emptyOwnerPreferences();
  }
  return {
    version: 1,
    favorites,
    visibility,
    configurations,
    providerOrder,
    seeded: record["seeded"]
  };
}

function isCurrentFavoriteRecord(value: unknown, favorite: ModelFavoriteConfiguration): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const required = ["backendId", "modelId", "providerId", "uid"];
  const allowed = new Set([...required, "effort", "fast"]);
  return required.every((key) => Object.hasOwn(record, key))
    && Object.keys(record).every((key) => allowed.has(key))
    && record["uid"] === favorite.uid
    && record["backendId"] === favorite.backendId
    && record["providerId"] === favorite.providerId
    && record["modelId"] === favorite.modelId
    && (!Object.hasOwn(record, "effort") || record["effort"] === favorite.effort)
    && (!Object.hasOwn(record, "fast") || (record["fast"] === true && favorite.fast === true));
}

function normalizeFavorite(value: unknown): ModelFavoriteConfiguration | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const uid = boundedText(record["uid"], 128);
  const backendId = boundedText(record["backendId"], 256);
  const providerId = boundedText(record["providerId"], 256);
  const modelId = boundedText(record["modelId"], 256);
  if (uid === undefined || backendId === undefined || providerId === undefined || modelId === undefined) return undefined;
  const effort = normalizeEffort(record["effort"]);
  return {
    uid,
    backendId,
    providerId,
    modelId,
    ...(effort === undefined ? {} : { effort }),
    ...(record["fast"] === true ? { fast: true } : {})
  };
}

function normalizeEffort(value: unknown): string | undefined {
  return boundedText(value, 64);
}

function checkedModelKey(backendId: string, providerId: string, modelId: string): string {
  const key = modelPreferenceKey(backendId.trim(), providerId.trim(), modelId.trim());
  if (!validModelKey(key)) throw new Error("A valid Backend, Provider, and model identity is required.");
  return key;
}

function validModelKey(value: string): boolean {
  const [backendId, providerId, modelId, extra] = value.split("\u0000");
  return extra === undefined && validBoundedText(backendId, 256) && validBoundedText(providerId, 256) && validBoundedText(modelId, 256);
}

function validProviderPreferenceKey(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      && parsed.length === 2
      && validBoundedText(parsed[0], 256)
      && validBoundedText(parsed[1], 256);
  } catch {
    return false;
  }
}

function sameFavoriteConfiguration(left: ModelFavoriteConfiguration, right: ModelFavoriteConfiguration): boolean {
  return left.backendId === right.backendId && left.providerId === right.providerId && left.modelId === right.modelId &&
    left.effort === right.effort && left.fast === right.fast;
}

function compactPendingOperations(operations: readonly PendingOperation[]): PendingOperation[] {
  const byId = new Map<string, PendingOperation>();
  for (const operation of operations) byId.set(operation.id, operation);
  const unique = [...byId.values()];
  let latestProviderOrderIndex = -1;
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    if (unique[index]?.kind !== "provider-order") continue;
    latestProviderOrderIndex = index;
    break;
  }
  return unique
    .filter((operation, index) => operation.kind !== "provider-order" || index === latestProviderOrderIndex)
    .slice(-1_024);
}

function ownerStorageKey(ownerId: string): string {
  return `${OWNER_STORAGE_PREFIX}${encodeURIComponent(ownerId)}`;
}

function emptyOwnerPreferences(): StoredOwnerPreferences {
  return { version: 1, favorites: [], visibility: {}, configurations: {}, providerOrder: [], seeded: false };
}

function boundedText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return validBoundedText(normalized, maximumLength) ? normalized : undefined;
}

function validBoundedText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshotRevision(): number {
  return revision;
}

function notify(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.storageArea !== null && event.storageArea !== window.localStorage) return;
    if (event.key === LAYOUT_STORAGE_KEY) {
      layoutMemory = event.newValue === "classic" || event.newValue === "badge" ? event.newValue : "original";
      notify();
      return;
    }
    if (event.key === null) {
      ownerMemory.clear();
      layoutMemory = "original";
      notify();
      for (const storageKey of pendingByStorageKey.keys()) void reconcileStorageKey(storageKey);
      return;
    }
    if (!event.key.startsWith(OWNER_STORAGE_PREFIX)) return;
    if (event.newValue === null) ownerMemory.delete(event.key);
    else {
      try { ownerMemory.set(event.key, sanitizeStoredOwner(JSON.parse(event.newValue) as unknown)); } catch { ownerMemory.delete(event.key); }
    }
    notify();
    void reconcileStorageKey(event.key);
  });
}
