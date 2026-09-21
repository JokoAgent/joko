import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import {
  ConnectionState,
  DeviceKind,
  JOKO_API_VERSION,
  SnapshotSchema,
  type Snapshot
} from "@joko/contracts";
import type { MobileConnectionProfile } from "./connection-storage";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type { NodeIdentity } from "./network";

export interface MobileOfflineCacheStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  multiRemove(keys: readonly string[]): Promise<void>;
}

export interface MobileOfflineCacheSnapshot {
  readonly node: NodeIdentity;
  readonly owner: Snapshot;
  readonly detail?: Snapshot;
  readonly cachedAt: number;
  readonly detailCachedAt?: number;
  readonly warning?: string;
}

interface CacheIdentity {
  readonly profileId: string;
  readonly origin: string;
  readonly serverId: string;
  readonly connectionId: string;
  readonly deviceId: string;
}

interface DetailIndexEntry {
  readonly sessionId: string;
  readonly sessionGeneration: string;
  readonly cachedAt: number;
  readonly key: string;
  readonly size: number;
}

interface CacheManifest {
  readonly version: 1;
  readonly identity: CacheIdentity;
  readonly node: NodeIdentity;
  readonly cachedAt: number;
  readonly owner: JsonValue;
  readonly details: readonly DetailIndexEntry[];
}

interface DetailRecord {
  readonly version: 1;
  readonly identity: CacheIdentity;
  readonly sessionId: string;
  readonly sessionGeneration: string;
  readonly cachedAt: number;
  readonly snapshot: JsonValue;
}

const cachePrefix = "joko.mobile.offline-cache.v1.";
const maximumManifestBytes = 4 * 1024 * 1024;
const maximumDetailBytes = 12 * 1024 * 1024;
const maximumDetailTotalBytes = 32 * 1024 * 1024;
const maximumDetails = 16;
const maximumClockValue = Number.MAX_SAFE_INTEGER;

class MobileOfflineCacheReadError extends Error {}

export class MobileOfflineCache {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #epochs = new Map<string, number>();

  constructor(
    private readonly storage: MobileOfflineCacheStorage,
    private readonly now: () => number,
    private readonly newId: () => string
  ) {}

  load(profile: MobileConnectionProfile, selectedSessionId?: string): Promise<MobileOfflineCacheSnapshot | undefined> {
    assertIdentity(profile);
    if (selectedSessionId !== undefined) assertLocalId(selectedSessionId, "task");
    return this.#serialized(profile.profileId, async () => {
      if (await this.storage.getItem(tombstoneKey(profile.profileId)) !== null) {
        await this.#removeProfileKeys(profile.profileId).catch(() => undefined);
        return undefined;
      }
      const raw = await this.storage.getItem(manifestKey(profile.profileId));
      if (raw === null) {
        await this.#removeUnreferencedDetailKeys(profile.profileId, new Set()).catch(() => undefined);
        return undefined;
      }
      try {
        const manifest = readManifest(raw, profile);
        const owner = readSnapshot(manifest.owner, "owner snapshot");
        assertOwnerSnapshot(profile, manifest.node, owner);
        if (selectedSessionId === undefined || !regularOwnerSession(owner, selectedSessionId)) {
          return { node: manifest.node, owner, cachedAt: manifest.cachedAt };
        }
        const entry = manifest.details.find((candidate) => candidate.sessionId === selectedSessionId);
        if (!entry) return { node: manifest.node, owner, cachedAt: manifest.cachedAt };
        try {
          let detailRaw: string | null;
          try { detailRaw = await this.storage.getItem(entry.key); }
          catch (error) { throw new MobileOfflineCacheReadError(errorMessage(error)); }
          if (detailRaw === null || utf8Size(detailRaw, maximumDetailBytes, "offline task record") !== entry.size) {
            throw new Error("missing detail record");
          }
          const record = readDetail(detailRaw, profile, entry);
          if (record.sessionGeneration !== entry.sessionGeneration) {
            throw new Error("task generation drift");
          }
          const detail = readSnapshot(record.snapshot, "task snapshot");
          assertDetailSnapshot(owner, selectedSessionId, detail);
          const touchedAt = recencyTimestamp(validTimestamp(this.now()), manifest.details);
          const touched = [
            { ...entry, cachedAt: touchedAt },
            ...manifest.details.filter((candidate) => candidate.sessionId !== selectedSessionId)
          ];
          const next = { ...manifest, details: newestFirst(touched) } satisfies CacheManifest;
          await this.storage.setItem(manifestKey(profile.profileId), stringifyManifest(next)).catch(() => undefined);
          return {
            node: manifest.node,
            owner,
            detail,
            cachedAt: manifest.cachedAt,
            detailCachedAt: record.cachedAt
          };
        } catch (error) {
          if (error instanceof MobileOfflineCacheReadError) {
            return {
              node: manifest.node,
              owner,
              cachedAt: manifest.cachedAt,
              warning: `Joko could not read the saved offline task: ${error.message}`
            };
          }
          const next = { ...manifest, details: manifest.details.filter((candidate) => candidate.key !== entry.key) } satisfies CacheManifest;
          await this.storage.removeItem(entry.key).catch(() => undefined);
          await this.storage.setItem(manifestKey(profile.profileId), stringifyManifest(next)).catch(() => undefined);
          return {
            node: manifest.node,
            owner,
            cachedAt: manifest.cachedAt,
            warning: "The saved offline copy of this task was damaged and was cleared."
          };
        }
      } catch (error) {
        await this.#removeProfileKeys(profile.profileId).catch(() => undefined);
        throw new Error(`Joko could not use the saved offline content: ${errorMessage(error)}`);
      }
    });
  }

  save(
    profile: MobileConnectionProfile,
    node: NodeIdentity,
    owner: Snapshot,
    detail?: Snapshot
  ): Promise<void> {
    assertIdentity(profile);
    assertOwnerSnapshot(profile, node, owner);
    const detailSessionId = detail?.scope?.kind.case === "session" ? detail.scope.kind.value.sessionId : undefined;
    if (detail !== undefined && detailSessionId === undefined) {
      throw new Error("The offline task snapshot did not have current-v1 Session scope.");
    }
    if (detail !== undefined && detailSessionId !== undefined && regularOwnerSession(owner, detailSessionId)) {
      assertDetailSnapshot(owner, detailSessionId, detail);
    }
    const epoch = this.#epoch(profile.profileId);
    return this.#serialized(profile.profileId, async () => {
      if (this.#epoch(profile.profileId) !== epoch) return;
      const cachedAt = validTimestamp(this.now());
      let prior: CacheManifest | undefined;
      const priorRaw = await this.storage.getItem(manifestKey(profile.profileId));
      if (priorRaw !== null) {
        try {
          const candidate = readManifest(priorRaw, profile);
          const priorOwner = readSnapshot(candidate.owner, "owner snapshot");
          assertOwnerSnapshot(profile, candidate.node, priorOwner);
          prior = candidate;
        } catch {
          prior = undefined;
        }
      }
      const regularGenerations = new Map(owner.sessions
        .filter((session) => session.automationOrigin === undefined && session.nativeBinding?.runtimeGeneration)
        .map((session) => [session.sessionId, session.nativeBinding!.runtimeGeneration.toString(10)] as const));
      let details = (prior?.details ?? []).filter((entry) =>
        regularGenerations.get(entry.sessionId) === entry.sessionGeneration);
      const createdKeys: string[] = [];
      if (detailSessionId !== undefined) {
        details = details.filter((entry) => entry.sessionId !== detailSessionId);
        if (regularOwnerSession(owner, detailSessionId)) {
          const token = this.newId();
          assertLocalId(token, "cache write");
          const key = detailKey(profile.profileId, detailSessionId, token);
          const record: DetailRecord = {
            version: 1,
            identity: profileIdentity(profile),
            sessionId: detailSessionId,
            sessionGeneration: detail!.generation.toString(10),
            cachedAt,
            snapshot: cacheableSnapshotJson(detail!)
          };
          const raw = JSON.stringify(record);
          const size = utf8Size(raw, maximumDetailBytes, "current task");
          await this.storage.setItem(key, raw);
          createdKeys.push(key);
          if (this.#epoch(profile.profileId) !== epoch) return;
          details.unshift({
            sessionId: detailSessionId,
            sessionGeneration: detail!.generation.toString(10),
            cachedAt: recencyTimestamp(cachedAt, details),
            key,
            size
          });
        }
      }
      details = boundedDetails(details);
      const manifest: CacheManifest = {
        version: 1,
        identity: profileIdentity(profile),
        node: readNode(node),
        cachedAt,
        owner: cacheableSnapshotJson(owner),
        details
      };
      if (this.#epoch(profile.profileId) !== epoch) return;
      await this.storage.setItem(manifestKey(profile.profileId), stringifyManifest(manifest));
      if (this.#epoch(profile.profileId) !== epoch) return;
      await this.storage.removeItem(tombstoneKey(profile.profileId));
      const retained = new Set(details.map((entry) => entry.key));
      await this.#removeUnreferencedDetailKeys(profile.profileId, retained);
      for (const key of createdKeys) {
        if (!retained.has(key)) await this.storage.removeItem(key).catch(() => undefined);
      }
    });
  }

  clear(profileId: string): Promise<void> {
    assertLocalId(profileId, "connection profile");
    this.#epochs.set(profileId, this.#epoch(profileId) + 1);
    const retire = this.storage.setItem(tombstoneKey(profileId), "1");
    return this.#serialized(profileId, async () => {
      let retirementError: unknown;
      try { await retire; }
      catch (error) { retirementError = error; }
      await this.#removeProfileKeys(profileId);
      if (retirementError !== undefined) throw retirementError;
    });
  }

  #epoch(profileId: string): number { return this.#epochs.get(profileId) ?? 0; }

  #serialized<T>(profileId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(profileId) ?? Promise.resolve();
    const result = previous.then(action, action);
    const tail = result.then(() => undefined, () => undefined);
    this.#tails.set(profileId, tail);
    void tail.finally(() => {
      if (this.#tails.get(profileId) === tail) this.#tails.delete(profileId);
    });
    return result;
  }

  async #removeProfileKeys(profileId: string): Promise<void> {
    const prefix = profilePrefix(profileId);
    // Retire authority first. A process loss after this single-key deletion can
    // leave detail orphans, but they are never discoverable without a manifest.
    await this.storage.removeItem(manifestKey(profileId));
    const keys = (await this.storage.getAllKeys()).filter((key) => key.startsWith(prefix));
    if (keys.length > 0) await this.storage.multiRemove(keys);
  }

  async #removeUnreferencedDetailKeys(profileId: string, retained: ReadonlySet<string>): Promise<void> {
    const prefix = detailPrefix(profileId);
    const keys = (await this.storage.getAllKeys()).filter((key) => key.startsWith(prefix) && !retained.has(key));
    if (keys.length > 0) await this.storage.multiRemove(keys);
  }
}

export function mobileOfflineAgeLabel(cachedAt: number, now: number, locale: MobileSupportedLocale): string {
  if (!Number.isSafeInteger(cachedAt) || cachedAt < 0 || !Number.isSafeInteger(now) || now < 0) {
    return mobileMessage(locale, "offline.saved");
  }
  const age = Math.max(0, now - cachedAt);
  if (age < 60_000) return mobileMessage(locale, "offline.justNow");
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) return mobileMessage(locale, "offline.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return mobileMessage(locale, "offline.hours", { count: hours });
  const days = Math.floor(hours / 24);
  return days === 1
    ? mobileMessage(locale, "offline.day")
    : mobileMessage(locale, "offline.days", { count: days });
}

function readManifest(raw: string, profile: MobileConnectionProfile): CacheManifest {
  utf8Size(raw, maximumManifestBytes, "offline owner record");
  const value = parseObject(raw, "offline owner record");
  exactKeys(value, ["version", "identity", "node", "cachedAt", "owner", "details"], "offline owner record");
  if (value.version !== 1) throw new Error("the offline owner record is not current-v1");
  const identity = readIdentity(value.identity);
  assertSameIdentity(profile, identity);
  const node = readNode(value.node);
  const cachedAt = validTimestamp(value.cachedAt);
  if (!Array.isArray(value.details) || value.details.length > maximumDetails) {
    throw new Error("the offline task index is invalid");
  }
  const details = value.details.map(readDetailIndexEntry);
  const sessions = new Set<string>();
  const keys = new Set<string>();
  let total = 0;
  for (const entry of details) {
    if (sessions.has(entry.sessionId) || keys.has(entry.key) || !entry.key.startsWith(detailPrefix(profile.profileId))) {
      throw new Error("the offline task index contains duplicate or foreign identities");
    }
    sessions.add(entry.sessionId);
    keys.add(entry.key);
    total += entry.size;
  }
  if (total > maximumDetailTotalBytes) throw new Error("the offline task index exceeds its budget");
  if (!isJsonValue(value.owner)) throw new Error("the offline owner snapshot is invalid");
  return { version: 1, identity, node, cachedAt, owner: value.owner, details };
}

function readDetail(raw: string, profile: MobileConnectionProfile, entry: DetailIndexEntry): DetailRecord {
  utf8Size(raw, maximumDetailBytes, "offline task record");
  const value = parseObject(raw, "offline task record");
  exactKeys(value, ["version", "identity", "sessionId", "sessionGeneration", "cachedAt", "snapshot"], "offline task record");
  if (value.version !== 1) throw new Error("the offline task record is not current-v1");
  const identity = readIdentity(value.identity);
  assertSameIdentity(profile, identity);
  const sessionId = requiredLocalId(value.sessionId, "task");
  if (sessionId !== entry.sessionId || value.sessionGeneration !== entry.sessionGeneration) {
    throw new Error("the offline task authority is invalid");
  }
  const cachedAt = validTimestamp(value.cachedAt);
  if (!isJsonValue(value.snapshot)) throw new Error("the offline task snapshot is invalid");
  return {
    version: 1,
    identity,
    sessionId,
    sessionGeneration: entry.sessionGeneration,
    cachedAt,
    snapshot: value.snapshot
  };
}

function readDetailIndexEntry(value: unknown): DetailIndexEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("the offline task index is invalid");
  const record = value as Record<string, unknown>;
  exactKeys(record, ["sessionId", "sessionGeneration", "cachedAt", "key", "size"], "offline task index");
  const sessionId = requiredLocalId(record.sessionId, "task");
  const sessionGeneration = requiredGeneration(record.sessionGeneration, "task");
  const cachedAt = validTimestamp(record.cachedAt);
  if (typeof record.key !== "string" || record.key.length > 768 || !/^[a-zA-Z0-9_.-]+$/u.test(record.key)
    || !Number.isSafeInteger(record.size) || Number(record.size) < 1 || Number(record.size) > maximumDetailBytes) {
    throw new Error("the offline task index is invalid");
  }
  return { sessionId, sessionGeneration, cachedAt, key: record.key, size: Number(record.size) };
}

function readIdentity(value: unknown): CacheIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("the offline connection identity is invalid");
  const record = value as Record<string, unknown>;
  exactKeys(record, ["profileId", "origin", "serverId", "connectionId", "deviceId"], "offline connection identity");
  const identity = {
    profileId: requiredLocalId(record.profileId, "connection profile"),
    origin: requiredText(record.origin, 512, "origin"),
    serverId: requiredText(record.serverId, 128, "server identity"),
    connectionId: requiredLocalId(record.connectionId, "connection"),
    deviceId: requiredLocalId(record.deviceId, "device")
  };
  const origin = new URL(identity.origin);
  if (origin.origin !== identity.origin || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error("the offline connection origin is invalid");
  }
  return identity;
}

function readNode(value: unknown): NodeIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("the offline node identity is invalid");
  const record = value as Record<string, unknown>;
  exactKeys(record, ["serverId", "displayName", "version", "apiVersion", "health", "pairingEnabled"], "offline node identity");
  const health = record.health;
  if (typeof health !== "number" || !Number.isFinite(health)) throw new Error("the offline node health is invalid");
  if (typeof record.pairingEnabled !== "boolean") throw new Error("the offline node pairing state is invalid");
  return {
    serverId: requiredText(record.serverId, 128, "server identity"),
    displayName: requiredText(record.displayName, 256, "node name"),
    version: boundedText(record.version, 128, "node version"),
    apiVersion: requiredText(record.apiVersion, 128, "API version"),
    health,
    pairingEnabled: record.pairingEnabled
  };
}

function readSnapshot(value: JsonValue, label: string): Snapshot {
  try { return fromJson(SnapshotSchema, value, { ignoreUnknownFields: false }); }
  catch { throw new Error(`the ${label} is not valid current-v1 data`); }
}

function assertOwnerSnapshot(profile: MobileConnectionProfile, node: NodeIdentity, owner: Snapshot): void {
  if (!owner.snapshotId || owner.generation < 0n || owner.scope?.kind.case !== "owner") {
    throw new Error("The offline owner snapshot did not have current-v1 owner authority.");
  }
  if (node.apiVersion !== JOKO_API_VERSION || node.serverId !== profile.serverId || owner.server?.serverId !== profile.serverId
    || owner.server.apiVersion !== node.apiVersion) {
    throw new Error("The offline owner snapshot did not match its exact Joko node.");
  }
  const connections = owner.connections.filter((item) => item.connectionId === profile.connectionId);
  const devices = owner.devices.filter((item) => item.deviceId === profile.deviceId);
  if (connections.length !== 1 || devices.length !== 1
    || connections[0]!.connectionProfileId !== profile.profileId
    || connections[0]!.deviceId !== profile.deviceId
    || connections[0]!.state !== ConnectionState.CONNECTED
    || devices[0]!.kind !== DeviceKind.MOBILE || devices[0]!.revoked
    || !devices[0]!.connectionIds.includes(profile.connectionId)) {
    throw new Error("The offline owner snapshot did not prove its exact mobile connection and device.");
  }
  const ids = new Set<string>();
  for (const session of owner.sessions) {
    assertLocalId(session.sessionId, "task");
    if (ids.has(session.sessionId)) throw new Error("The offline owner snapshot contains duplicate tasks.");
    ids.add(session.sessionId);
  }
}

function assertDetailSnapshot(owner: Snapshot, sessionId: string, detail: Snapshot): void {
  if (!detail.snapshotId || detail.generation < 1n
    || detail.scope?.kind.case !== "session" || detail.scope.kind.value.sessionId !== sessionId
    || detail.scope.kind.value.recentTimelineItems < 1
    || detail.server?.serverId !== owner.server?.serverId
    || detail.server?.apiVersion !== owner.server?.apiVersion) {
    throw new Error("The offline task snapshot did not match its owner generation and Session scope.");
  }
  const ownerSession = owner.sessions.find((session) => session.sessionId === sessionId);
  const detailSession = detail.sessions[0];
  if (detail.sessions.length !== 1 || detailSession?.sessionId !== sessionId
    || detailSession.automationOrigin !== undefined
    || ownerSession?.nativeBinding?.runtimeGeneration !== detail.generation
    || detailSession.nativeBinding?.runtimeGeneration !== detail.generation
    || ownerSession.backendId !== detailSession.backendId
    || ownerSession.targetId !== detailSession.targetId) {
    throw new Error("The offline task snapshot did not contain exactly one matching task.");
  }
  if (!regularOwnerSession(owner, sessionId)) {
    throw new Error("Automation tasks are not stored in the mobile offline content cache.");
  }
}

function regularOwnerSession(owner: Snapshot, sessionId: string): boolean {
  const matches = owner.sessions.filter((session) => session.sessionId === sessionId);
  return matches.length === 1 && matches[0]!.automationOrigin === undefined;
}

function boundedDetails(entries: readonly DetailIndexEntry[]): DetailIndexEntry[] {
  const result: DetailIndexEntry[] = [];
  let total = 0;
  for (const entry of newestFirst(entries)) {
    if (result.length >= maximumDetails || total + entry.size > maximumDetailTotalBytes) continue;
    result.push(entry);
    total += entry.size;
  }
  return result;
}

function newestFirst(entries: readonly DetailIndexEntry[]): DetailIndexEntry[] {
  return [...entries].sort((left, right) => right.cachedAt - left.cachedAt);
}

function recencyTimestamp(now: number, entries: readonly DetailIndexEntry[]): number {
  return entries.reduce((latest, entry) => Math.max(latest, entry.cachedAt), now);
}

function stringifyManifest(manifest: CacheManifest): string {
  const raw = JSON.stringify(manifest);
  utf8Size(raw, maximumManifestBytes, "Joko owner view");
  return raw;
}

function cacheableSnapshotJson(snapshot: Snapshot): JsonValue {
  // Durable Operation rows are reconciliation receipts, not offline content.
  // Their IDs and hashes stay in the protected/local reconciliation path.
  return toJson(SnapshotSchema, create(SnapshotSchema, { ...snapshot, operations: [] }));
}

function utf8Size(value: string, maximum: number, label: string): number {
  if (value.length > maximum) throw new Error(`The ${label} is too large to save for offline use.`);
  const size = new TextEncoder().encode(value).byteLength;
  if (size > maximum) throw new Error(`The ${label} is too large to save for offline use.`);
  return size;
}

function parseObject(raw: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error(`the ${label} is not valid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`the ${label} is invalid`);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`the ${label} has an unsupported shape`);
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function profileIdentity(profile: MobileConnectionProfile): CacheIdentity {
  return {
    profileId: profile.profileId,
    origin: profile.origin,
    serverId: profile.serverId,
    connectionId: profile.connectionId,
    deviceId: profile.deviceId
  };
}

function assertIdentity(profile: MobileConnectionProfile): void {
  readIdentity(profileIdentity(profile));
}

function assertSameIdentity(profile: MobileConnectionProfile, identity: CacheIdentity): void {
  const expected = profileIdentity(profile);
  if (Object.keys(expected).some((key) => expected[key as keyof CacheIdentity] !== identity[key as keyof CacheIdentity])) {
    throw new Error("the offline content belongs to a different saved Joko connection");
  }
}

function validTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximumClockValue) {
    throw new Error("the offline cache timestamp is invalid");
  }
  return value;
}

function requiredText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) {
    throw new Error(`the offline ${label} is invalid`);
  }
  return value;
}

function boundedText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
    throw new Error(`the offline ${label} is invalid`);
  }
  return value;
}

function requiredLocalId(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`the offline ${label} identity is invalid`);
  assertLocalId(value, label);
  return value;
}

function requiredGeneration(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`the offline ${label} generation is invalid`);
  }
  return value;
}

function assertLocalId(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) throw new Error(`the offline ${label} identity is invalid`);
}

function profilePrefix(profileId: string): string { return `${cachePrefix}${profileId}.`; }
function manifestKey(profileId: string): string { return `${profilePrefix(profileId)}manifest`; }
function tombstoneKey(profileId: string): string { return `${profilePrefix(profileId)}retired`; }
function detailPrefix(profileId: string): string { return `${profilePrefix(profileId)}detail.`; }
function detailKey(profileId: string, sessionId: string, token: string): string {
  return `${detailPrefix(profileId)}${sessionId}.${token}`;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
