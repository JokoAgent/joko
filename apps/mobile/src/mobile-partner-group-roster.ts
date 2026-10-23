import type { ListPartnerGroupsResponse } from "@joko/contracts";
import type { MobilePlainStorageDriver } from "./connection-storage";
import type { MobilePartnerRosterSource } from "./mobile-partner-roster";
import { createMobileDirectoryReadRecovery, isRecoverableMobileDirectoryRead, readMobileDirectory } from "./mobile-directory-read-recovery";

export interface MobilePartnerGroupSourceTransport {
  readonly sourceKey: string;
  readonly ownerKey: string;
  readonly receiptScope: string;
  isCurrent(): boolean;
  list(signal: AbortSignal): Promise<ListPartnerGroupsResponse>;
}
export interface MobilePartnerGroupSelection {
  readonly sourceKey: string;
  readonly receiptScope: string;
  readonly ownerKey: string;
  readonly profileId: string;
  readonly groupId?: string;
}
/** Display cache carries neither group revisions nor a conversation or action authority. */
export interface MobilePartnerGroupDisplay {
  readonly groupId: string;
  readonly name: string;
  readonly members: readonly { readonly partnerId: string; readonly name: string }[];
  readonly preview: string;
  readonly updatedAt: number;
  readonly unread: boolean;
}
export interface MobilePartnerGroupRosterShard {
  readonly source: MobilePartnerRosterSource;
  readonly status: "loading" | "online" | "offline" | "error";
  readonly refreshing: boolean;
  readonly settled?: boolean;
  readonly display: readonly MobilePartnerGroupDisplay[];
  readonly displayTotal: number;
  readonly catalog?: ListPartnerGroupsResponse;
  readonly savedAt?: number;
  readonly error?: string;
}
const CACHE_PREFIX = "joko.mobile.partner-group-roster.v1:";
const MAX_CACHE_ROWS = 200, MAX_CACHE_CHARS = 300_000;
const cacheKey = (sourceKey: string) => CACHE_PREFIX + encodeURIComponent(sourceKey);
const cleanPreview = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "").slice(0, 500);
function display(catalog: ListPartnerGroupsResponse): readonly MobilePartnerGroupDisplay[] {
  return catalog.groups.filter(group => !group.deleting).map(group => ({ groupId: group.id, name: group.name,
    members: group.members.map(member => ({ partnerId: member.partnerId, name: member.name })),
    preview: cleanPreview(group.lastMessage?.content ?? ""),
    updatedAt: Number((group.lastMessage?.createdAt ?? group.updatedAt)?.seconds ?? 0n) * 1000,
    unread: group.unread })).sort((left, right) => right.updatedAt - left.updatedAt);
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).sort().join("|") === [...keys].sort().join("|"); }
function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value); }
function validName(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max
  && value.trim() === value && !/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value); }
function readCache(raw: string, sourceKey: string): { savedAt: number; display: readonly MobilePartnerGroupDisplay[]; displayTotal: number } {
  if (raw.length > MAX_CACHE_CHARS) throw new Error("The group display cache exceeded its budget.");
  const value: unknown = JSON.parse(raw);
  if (!record(value) || !exact(value, ["schema", "sourceKey", "savedAt", "display", "displayTotal"])
    || value.schema !== "joko.mobile.partner-group-roster.v1" || value.sourceKey !== sourceKey
    || !Number.isSafeInteger(value.savedAt) || Number(value.savedAt) < 0
    || !Array.isArray(value.display) || value.display.length > MAX_CACHE_ROWS
    || !Number.isSafeInteger(value.displayTotal) || Number(value.displayTotal) < value.display.length || Number(value.displayTotal) > 1_000)
    throw new Error("The group display cache is invalid.");
  const ids = new Set<string>();
  for (const row of value.display) {
    if (!record(row) || !exact(row, ["groupId", "name", "members", "preview", "updatedAt", "unread"])
      || !validId(row.groupId) || ids.has(row.groupId) || !validName(row.name, 40)
      || !Array.isArray(row.members) || row.members.length < 2 || row.members.length > 6
      || typeof row.preview !== "string" || cleanPreview(row.preview) !== row.preview
      || !Number.isSafeInteger(row.updatedAt) || Number(row.updatedAt) < 0 || typeof row.unread !== "boolean") throw new Error("The cached group row is invalid.");
    const members = new Set<string>();
    for (const member of row.members) {
      if (!record(member) || !exact(member, ["partnerId", "name"]) || !validId(member.partnerId)
        || members.has(member.partnerId) || !validName(member.name, 200)) throw new Error("The cached group member is invalid.");
      members.add(member.partnerId);
    }
    ids.add(row.groupId);
  }
  return { savedAt: Number(value.savedAt), display: value.display as unknown as readonly MobilePartnerGroupDisplay[], displayTotal: Number(value.displayTotal) };
}

/** Adapted source-shard reads retain display independently; only a current successful read grants entry. */
export class MobilePartnerGroupRoster {
  #snapshot: readonly MobilePartnerGroupRosterShard[] = [];
  #listeners = new Set<() => void>();
  #active = false;
  #epoch = 0;
  #flights = new Map<string, AbortController>();
  #transports = new Map<string, { readonly abort: AbortController; readonly value: MobilePartnerGroupSourceTransport }>();
  #writes = new Map<string, Promise<void>>();
  #cacheEpoch = new Map<string, number>();
  #recoveries = new Map<string, ReturnType<typeof createMobileDirectoryReadRecovery>>();
  #initialized = false;
  #queue = new Set<string>();
  #timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly storage: Pick<MobilePlainStorageDriver, "getItem" | "setItem" | "removeItem"> & { getAllKeys?(): Promise<readonly string[]> },
    private readonly resolve: (profileId: string, signal: AbortSignal, expectedSourceKey: string) => Promise<MobilePartnerGroupSourceTransport>, private readonly now: () => number = Date.now) {}
  get snapshot(): readonly MobilePartnerGroupRosterShard[] { return this.#snapshot; }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  transport(key: string): MobilePartnerGroupSourceTransport | undefined {
    const value = this.#transports.get(key)?.value;
    return this.#active && value?.isCurrent() && this.#snapshot.find(shard => shard.source.key === key)?.status === "online" ? value : undefined;
  }
  #publish(next: readonly MobilePartnerGroupRosterShard[]): void { this.#snapshot = next; for (const listener of this.#listeners) listener(); }
  #write(key: string, effect: () => Promise<void>): void {
    const next = (this.#writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(effect);
    this.#writes.set(key, next); void next.catch(() => undefined).finally(() => { if (this.#writes.get(key) === next) this.#writes.delete(key); });
  }
  setSources(sources: readonly MobilePartnerRosterSource[]): void {
    const keys = new Set(sources.map(source => source.key));
    if (keys.size !== sources.length || sources.length > 256) throw new Error("The saved group source catalog is invalid.");
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
      const epoch = (this.#cacheEpoch.get(source.key) ?? 0) + 1; this.#cacheEpoch.set(source.key, epoch);
      void (this.#writes.get(source.key) ?? Promise.resolve()).catch(() => undefined).then(() => this.storage.getItem(cacheKey(source.key))).then(raw => {
        if (!raw || epoch !== this.#cacheEpoch.get(source.key)) return;
        const cached = readCache(raw, source.key);
        this.#publish(this.#snapshot.map(shard => shard.source.key === source.key && !shard.catalog && shard.savedAt === undefined ? { ...shard, ...cached } : shard));
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
      const shard = this.#snapshot.find(item => item.source.key === key); this.#queue.delete(key); if (!shard) continue;
      const abort = new AbortController(), epoch = this.#epoch; this.#flights.set(key, abort);
      this.#transports.get(key)?.abort.abort(); this.#transports.delete(key);
      const current = () => !abort.signal.aborted && this.#active && this.#epoch === epoch && this.#snapshot.some(item => item.source.key === key);
      let recovery = this.#recoveries.get(key);
      if (!recovery) {
        recovery = createMobileDirectoryReadRecovery(() => this.refresh(key),
          () => this.#active && this.#epoch === epoch && this.#snapshot.some(item => item.source.key === key));
        this.#recoveries.set(key, recovery);
      }
      this.#publish(this.#snapshot.map(item => item.source.key === key ? { ...item, status: item.settled ? item.status : "loading", refreshing: true, error: undefined } : item));
      void readMobileDirectory(abort.signal, async () => {
        const transport = await this.resolve(shard.source.profile.profileId, abort.signal, key);
        if (!current() || transport.sourceKey !== key) throw new Error("The group source changed during its directory read.");
        const catalog = await transport.list(abort.signal);
        return { transport, catalog };
      }).then(({ transport, catalog }) => {
        if (!current()) return;
        if (!transport.isCurrent()) throw new Error("The group directory owner changed.");
        recovery.succeeded();
        this.#transports.set(key, { abort, value: transport });
        const rows = display(catalog), savedAt = this.now();
        this.#publish(this.#snapshot.map(item => item.source.key === key ? { source: item.source, status: "online", refreshing: false, settled: true, display: rows, displayTotal: rows.length, catalog, savedAt } : item));
        const raw = JSON.stringify({ schema: "joko.mobile.partner-group-roster.v1", sourceKey: key, savedAt, display: rows.slice(0, MAX_CACHE_ROWS), displayTotal: rows.length });
        if (raw.length <= MAX_CACHE_CHARS) this.#write(key, () => current() ? this.storage.setItem(cacheKey(key), raw) : Promise.resolve());
      }).catch((error: unknown) => {
        if (!current()) return;
        const status = isRecoverableMobileDirectoryRead(error) ? "offline" : "error";
        this.#publish(this.#snapshot.map(item => item.source.key === key ? { ...item, status, refreshing: false, settled: true, catalog: undefined, error: error instanceof Error ? error.message : String(error) } : item));
        recovery.failed(error); abort.abort();
      }).finally(() => {
        if (this.#flights.get(key) === abort) this.#flights.delete(key); this.#pump();
        if (this.#active && this.#flights.size === 0 && this.#queue.size === 0 && !this.#timer) this.#timer = setTimeout(() => {
          this.#timer = undefined; for (const item of this.#snapshot) if (item.status === "online") this.#queue.add(item.source.key); this.#pump();
        }, 2500);
      });
    }
  }
}
