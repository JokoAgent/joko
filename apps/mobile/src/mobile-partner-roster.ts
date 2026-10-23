import type { MobileConnectionProfile, MobilePlainStorageDriver } from "./connection-storage";
import type { MobilePartnerAvatarTransport, MobilePartnerAvatarValue } from "./mobile-partner-avatar";
import type { MobilePartnerCatalog, MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import type { MobilePartnerDirectoryObservation } from "./mobile-partner-activity";
import type { PartnerGroupApi } from "@joko/contracts";
import { createMobileDirectoryReadRecovery, isRecoverableMobileDirectoryRead, readMobileDirectory } from "./mobile-directory-read-recovery";

export function mobilePartnerRosterSourceKey(profile: MobileConnectionProfile): string {
  return JSON.stringify([profile.profileId, profile.origin, profile.serverId, profile.connectionId, profile.deviceId]);
}
export interface MobilePartnerRosterSource {
  readonly key: string;
  readonly profile: MobileConnectionProfile;
  readonly current: boolean;
}
export interface MobilePartnerRosterSourceTransport {
  readonly sourceKey: string;
  readonly ownerKey: string;
  readonly profile: MobileConnectionProfile;
  readonly avatar?: MobilePartnerAvatarTransport;
  readonly groups?: Pick<PartnerGroupApi, "list" | "get">;
  isCurrent(): boolean;
  list(signal: AbortSignal): Promise<MobilePartnerCatalog>;
  observation(): MobilePartnerDirectoryObservation | undefined;
  canonical(selected: MobilePartnerDirectoryProfile, signal: AbortSignal, allowPaused?: boolean): Promise<{ readonly sessionId: string; readonly partner: MobilePartnerDirectoryProfile }>;
}
/** Display and offline conversation hints contain no live revision or action authority. */
export interface MobilePartnerRosterDisplay {
  readonly partnerId: string;
  readonly displayName: string;
  readonly avatar: MobilePartnerAvatarValue;
  readonly lifecycle: MobilePartnerDirectoryProfile["lifecycle"];
  readonly preview: string;
  readonly updatedAt: number;
  readonly unread: number;
  readonly conversation: { readonly sessionId: string; readonly targetId: string } | null;
}
export interface MobilePartnerRosterShard {
  readonly source: MobilePartnerRosterSource;
  readonly status: "loading" | "online" | "offline" | "error";
  readonly refreshing: boolean;
  readonly settled?: boolean;
  readonly display: readonly MobilePartnerRosterDisplay[];
  readonly displayTotal: number;
  readonly catalog?: MobilePartnerCatalog;
  readonly savedAt?: number;
  readonly error?: string;
}

const CACHE_PREFIX = "joko.mobile.partner-roster.v1:";
const MAX_CACHE_ROWS = 200;
const MAX_CACHE_CHARS = 300_000;
function cacheKey(key: string): string { return CACHE_PREFIX + encodeURIComponent(key); }
function display(catalog: MobilePartnerCatalog): readonly MobilePartnerRosterDisplay[] {
  return [...catalog.partners].sort((left, right) => right.updatedAt - left.updatedAt)
    .map(partner => ({ partnerId: partner.partnerId, displayName: partner.displayName, avatar: partner.avatar,
      lifecycle: partner.lifecycle, preview: partner.activity.latestReplyPreview ?? "", updatedAt: partner.updatedAt,
      unread: partner.activity.unreadReplyCount,
      conversation: partner.initializationState === "ready" && partner.canonicalSessionId
        ? { sessionId: partner.canonicalSessionId, targetId: partner.homeTargetId } : null }));
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}
function readCache(raw: string, key: string): { savedAt: number; display: readonly MobilePartnerRosterDisplay[]; displayTotal: number } {
  if (raw.length > MAX_CACHE_CHARS) throw new Error("The Partner display cache exceeded its budget.");
  const value: unknown = JSON.parse(raw);
  if (!record(value) || !exact(value, ["schema", "sourceKey", "savedAt", "display", "displayTotal"])
    || value.schema !== "joko.mobile.partner-roster.v1" || value.sourceKey !== key
    || typeof value.savedAt !== "number" || !Number.isSafeInteger(value.savedAt) || value.savedAt < 0
    || !Array.isArray(value.display) || value.display.length > MAX_CACHE_ROWS
    || typeof value.displayTotal !== "number" || !Number.isSafeInteger(value.displayTotal)
    || value.displayTotal < value.display.length || value.displayTotal > 1_000) throw new Error("The Partner display cache is invalid.");
  const ids = new Set<string>();
  for (const row of value.display) {
    if (!record(row) || !exact(row, ["partnerId", "displayName", "avatar", "lifecycle", "preview", "updatedAt", "unread", "conversation"])
      || typeof row.partnerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(row.partnerId) || ids.has(row.partnerId)
      || typeof row.displayName !== "string" || row.displayName.length < 1 || row.displayName.length > 200
      || row.displayName.trim() !== row.displayName || /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(row.displayName)
      || !["active", "paused", "archived"].includes(String(row.lifecycle)) || typeof row.preview !== "string" || row.preview.length > 500
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(row.preview)
      || typeof row.updatedAt !== "number" || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0
      || typeof row.unread !== "number" || !Number.isSafeInteger(row.unread) || row.unread < 0) throw new Error("The Partner display cache contains an invalid row.");
    if (row.conversation !== null && (!record(row.conversation) || !exact(row.conversation, ["sessionId", "targetId"])
      || typeof row.conversation.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(row.conversation.sessionId)
      || typeof row.conversation.targetId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(row.conversation.targetId))) {
      throw new Error("The cached Partner conversation hint is invalid.");
    }
    if (typeof row.avatar === "string") {
      if (!/^[a-z][a-z0-9-]{0,31}$/u.test(row.avatar)) throw new Error("The cached Partner avatar is invalid.");
    } else if (!record(row.avatar) || !exact(row.avatar, ["sha256", "mimeType", "byteLength"])
      || typeof row.avatar.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.avatar.sha256)
      || !["image/jpeg", "image/png", "image/webp"].includes(String(row.avatar.mimeType))
      || typeof row.avatar.byteLength !== "number" || !Number.isSafeInteger(row.avatar.byteLength)
      || row.avatar.byteLength < 1 || row.avatar.byteLength > 5_242_880) throw new Error("The cached Partner avatar is invalid.");
    ids.add(row.partnerId);
  }
  return { savedAt: value.savedAt, display: value.display as unknown as readonly MobilePartnerRosterDisplay[], displayTotal: value.displayTotal };
}

/** Independent successful shards survive another source's outage; two reads share the fan-out budget. */
export class MobilePartnerRoster {
  #snapshot: readonly MobilePartnerRosterShard[] = [];
  #listeners = new Set<() => void>();
  #active = false;
  #epoch = 0;
  #flights = new Map<string, AbortController>();
  #transports = new Map<string, { readonly abort: AbortController; readonly value: MobilePartnerRosterSourceTransport }>();
  #writes = new Map<string, Promise<void>>();
  #cacheEpoch = new Map<string, number>();
  #recoveries = new Map<string, ReturnType<typeof createMobileDirectoryReadRecovery>>();
  #initialized = false;
  #queue = new Set<string>();
  #timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly storage: Pick<MobilePlainStorageDriver, "getItem" | "setItem" | "removeItem"> & { getAllKeys?(): Promise<readonly string[]> },
    private readonly resolve: (profileId: string, signal: AbortSignal) => Promise<MobilePartnerRosterSourceTransport>,
    private readonly now: () => number = Date.now) {}
  get snapshot(): readonly MobilePartnerRosterShard[] { return this.#snapshot; }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  transport(key: string): MobilePartnerRosterSourceTransport | undefined {
    const transport = this.#transports.get(key)?.value;
    return this.#active && transport?.isCurrent() && this.#snapshot.find(shard => shard.source.key === key)?.status === "online" ? transport : undefined;
  }
  #publish(next: readonly MobilePartnerRosterShard[]): void { this.#snapshot = next; for (const listener of this.#listeners) listener(); }
  #write(key: string, effect: () => Promise<void>): void {
    const next = (this.#writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(effect);
    this.#writes.set(key, next); void next.catch(() => undefined).finally(() => { if (this.#writes.get(key) === next) this.#writes.delete(key); });
  }
  setSources(sources: readonly MobilePartnerRosterSource[]): void {
    const keys = new Set(sources.map(source => source.key));
    if (keys.size !== sources.length || sources.length > 256) throw new Error("The saved Partner source catalog is invalid.");
    if (!this.#initialized) {
      this.#initialized = true;
      void this.storage.getAllKeys?.().then(stored => {
        for (const storedKey of stored) if (storedKey.startsWith(CACHE_PREFIX)) {
          let key: string;
          try { key = decodeURIComponent(storedKey.slice(CACHE_PREFIX.length)); } catch { void this.storage.removeItem(storedKey).catch(() => undefined); continue; }
          if (!this.#snapshot.some(shard => shard.source.key === key)) this.#write(key,
            () => this.#snapshot.some(shard => shard.source.key === key) ? Promise.resolve() : this.storage.removeItem(storedKey));
        }
      }).catch(() => undefined);
    }
    const old = new Map(this.#snapshot.map(shard => [shard.source.key, shard]));
    for (const key of old.keys()) if (!keys.has(key)) {
      this.#cacheEpoch.set(key, (this.#cacheEpoch.get(key) ?? 0) + 1);
      this.#flights.get(key)?.abort(); this.#flights.delete(key); this.#queue.delete(key);
      this.#transports.get(key)?.abort.abort(); this.#transports.delete(key);
      this.#recoveries.get(key)?.dispose(); this.#recoveries.delete(key);
      this.#write(key, () => this.storage.removeItem(cacheKey(key)));
    }
    const added = sources.filter(source => !old.has(source.key));
    if (this.#active) for (const source of sources) if (old.get(source.key)?.source.current !== source.current
      || this.#transports.get(source.key)?.value.isCurrent() === false) this.#queue.add(source.key);
    this.#publish(sources.map(source => old.has(source.key) ? { ...old.get(source.key)!, source }
      : { source, status: this.#active ? "loading" : "offline", refreshing: false, display: [], displayTotal: 0 }));
    for (const source of added) {
      const epoch = (this.#cacheEpoch.get(source.key) ?? 0) + 1;
      this.#cacheEpoch.set(source.key, epoch);
      void (this.#writes.get(source.key) ?? Promise.resolve()).catch(() => undefined).then(() => this.storage.getItem(cacheKey(source.key)))
        .then(raw => {
          if (!raw || epoch !== this.#cacheEpoch.get(source.key)) return;
          const cached = readCache(raw, source.key);
          this.#publish(this.#snapshot.map(shard => shard.source.key === source.key && !shard.catalog && shard.savedAt === undefined
            ? { ...shard, ...cached } : shard));
        }).catch(() => undefined);
      if (this.#active) this.#queue.add(source.key);
    }
    this.#pump();
  }
  setActive(active: boolean): void {
    if (active === this.#active) return;
    this.#active = active; this.#epoch++;
    if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined;
    for (const abort of this.#flights.values()) abort.abort(); this.#flights.clear(); this.#queue.clear();
    for (const { abort } of this.#transports.values()) abort.abort(); this.#transports.clear();
    for (const recovery of this.#recoveries.values()) recovery.dispose(); this.#recoveries.clear();
    this.#publish(this.#snapshot.map(shard => ({ ...shard, status: "offline", refreshing: false, catalog: undefined })));
    if (active) this.refresh();
  }
  refresh(key?: string): void {
    if (!this.#active) return;
    for (const shard of this.#snapshot) if (key === undefined || shard.source.key === key) this.#queue.add(shard.source.key);
    if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined;
    this.#pump();
  }
  #pump(): void {
    if (!this.#active) return;
    for (const key of this.#queue) {
      if (this.#flights.size >= 2) break;
      if (this.#flights.has(key)) continue;
      const shard = this.#snapshot.find(item => item.source.key === key);
      this.#queue.delete(key); if (!shard) continue;
      const abort = new AbortController(), epoch = this.#epoch;
      this.#flights.set(key, abort);
      this.#transports.get(key)?.abort.abort(); this.#transports.delete(key);
      const current = (): boolean => !abort.signal.aborted && this.#active && this.#epoch === epoch
        && this.#snapshot.some(item => item.source.key === key);
      let recovery = this.#recoveries.get(key);
      if (!recovery) {
        recovery = createMobileDirectoryReadRecovery(() => this.refresh(key),
          () => this.#active && this.#epoch === epoch && this.#snapshot.some(item => item.source.key === key));
        this.#recoveries.set(key, recovery);
      }
      this.#publish(this.#snapshot.map(item => item.source.key === key ? { ...item, status: item.settled ? item.status : "loading", refreshing: true, error: undefined } : item));
      void readMobileDirectory(abort.signal, async () => {
        const transport = await this.resolve(shard.source.profile.profileId, abort.signal);
        if (!current() || transport.sourceKey !== key) throw new Error("The Partner source changed during its directory read.");
        const catalog = await transport.list(abort.signal);
        return { transport, catalog };
      }).then(({ transport, catalog }) => {
        if (!current()) return;
        if (!transport.isCurrent()) throw new Error("The Partner directory owner changed.");
        recovery.succeeded();
        this.#transports.set(key, { abort, value: transport });
        const rows = display(catalog), savedAt = this.now();
        this.#publish(this.#snapshot.map(item => item.source.key === key ? { source: item.source, status: "online", refreshing: false, settled: true, display: rows, displayTotal: rows.length, catalog, savedAt } : item));
        const raw = JSON.stringify({ schema: "joko.mobile.partner-roster.v1", sourceKey: key, savedAt, display: rows.slice(0, MAX_CACHE_ROWS), displayTotal: rows.length });
        if (raw.length <= MAX_CACHE_CHARS) this.#write(key, () => current() ? this.storage.setItem(cacheKey(key), raw) : Promise.resolve());
      }).catch((error: unknown) => {
        if (!current()) return;
        const status = isRecoverableMobileDirectoryRead(error) ? "offline" : "error";
        this.#publish(this.#snapshot.map(item => item.source.key === key ? { ...item, status, refreshing: false, settled: true, catalog: undefined, error: error instanceof Error ? error.message : String(error) } : item));
        recovery.failed(error); abort.abort();
      }).finally(() => {
        if (this.#flights.get(key) === abort) this.#flights.delete(key);
        this.#pump();
        if (this.#active && this.#flights.size === 0 && this.#queue.size === 0 && !this.#timer) {
          this.#timer = setTimeout(() => { this.#timer = undefined; for (const item of this.#snapshot) if (item.status === "online") this.#queue.add(item.source.key); this.#pump(); }, 2500);
        }
      });
    }
  }
}
