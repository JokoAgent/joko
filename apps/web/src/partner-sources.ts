import type { AppSnapshot, ConnectionProfile, PartnerListView, PartnerProfileView, PartnerSessionView, SessionView } from "./model.js";
import type { OrchestratorGateway, GatewayCallbacks } from "./gateway.js";
import type { PartnerAvatarView } from "./partner-avatar.js";

export type PartnerSourceStatus = "loading" | "online" | "offline" | "readFailed" | "accessDenied" | "identityMismatch";
export interface PartnerSourceRow {
  readonly id: string;
  readonly revision: bigint;
  readonly displayName: string;
  readonly description: string;
  readonly avatar: PartnerAvatarView;
  readonly lifecycle: PartnerProfileView["lifecycle"];
  readonly initializationState: PartnerProfileView["initializationState"];
  readonly unreadReplyCount: number;
  readonly latestReplyPreview?: string;
}
export interface PartnerSourceView {
  readonly key: string;
  readonly profileId: string;
  readonly name: string;
  readonly epoch: number;
  readonly status: PartnerSourceStatus;
  readonly rows: readonly PartnerSourceRow[];
}
export interface PartnerSourceResolution {
  readonly partner: PartnerProfileView;
  readonly link: PartnerSessionView;
  readonly session: SessionView;
}
export interface PartnerSourceDependencies {
  readonly probe: (origin: string, signal: AbortSignal) => Promise<{ readonly serverId: string }>;
  readonly readAuthKey: (profile: ConnectionProfile) => Promise<string | undefined>;
  readonly createGateway: (profile: ConnectionProfile, secret: string, callbacks: GatewayCallbacks) => OrchestratorGateway;
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
  readonly publish: (sources: readonly PartnerSourceView[]) => void;
}

const CACHE_PREFIX = "joko.partner-source.v1.";
const MAX_CACHE_BYTES = 256 * 1024;
const MAX_ROWS = 200;

export function partnerSourceKey(profile: ConnectionProfile): string {
  return JSON.stringify([profile.serverId, profile.id, profile.deviceId, profile.origin]);
}

/** Cached cards carry display identity only; neither a canonical link nor capabilities. */
export function partnerSourceRows(result: PartnerListView): readonly PartnerSourceRow[] {
  return result.partners.filter(partner => partner.lifecycle === "active" || partner.lifecycle === "paused").map(partner => ({
    id: partner.id, revision: partner.revision, displayName: partner.displayName, description: partner.description,
    avatar: partner.avatar, lifecycle: partner.lifecycle, initializationState: partner.initializationState,
    unreadReplyCount: partner.activity.unreadReplyCount,
    ...(partner.activity.latestReplyPreview === undefined ? {} : { latestReplyPreview: partner.activity.latestReplyPreview })
  }));
}

export function parsePartnerSourceCache(raw: string | null, sourceKey: string): readonly PartnerSourceRow[] {
  if (raw === null || raw.length > MAX_CACHE_BYTES) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || !exactKeys(value, ["version", "sourceKey", "rows"]) || value.version !== 1
      || value.sourceKey !== sourceKey || !Array.isArray(value.rows) || value.rows.length > MAX_ROWS) return [];
    const rows: PartnerSourceRow[] = [];
    const ids = new Set<string>();
    for (const item of value.rows) {
      if (!record(item) || !exactKeys(item, ["id", "revision", "displayName", "description", "avatar", "lifecycle", "initializationState", "unreadReplyCount", "latestReplyPreview"], ["latestReplyPreview"])
        || !text(item.id, 256) || ids.has(item.id) || typeof item.revision !== "string" || !/^[1-9][0-9]{0,19}$/u.test(item.revision)
        || !text(item.displayName, 200) || !text(item.description, 12_000, true)
        || !["active", "paused"].includes(String(item.lifecycle))
        || !["pending", "ready", "error"].includes(String(item.initializationState))
        || !Number.isSafeInteger(item.unreadReplyCount) || (item.unreadReplyCount as number) < 0
        || (item.latestReplyPreview !== undefined && !text(item.latestReplyPreview, 4_000, true))) return [];
      const avatar = cacheAvatar(item.avatar);
      if (avatar === undefined) return [];
      ids.add(item.id);
      rows.push({ id: item.id, revision: BigInt(item.revision), displayName: item.displayName, description: item.description,
        avatar, lifecycle: item.lifecycle as PartnerSourceRow["lifecycle"], initializationState: item.initializationState as PartnerSourceRow["initializationState"],
        unreadReplyCount: item.unreadReplyCount as number,
        ...(item.latestReplyPreview === undefined ? {} : { latestReplyPreview: item.latestReplyPreview as string }) });
    }
    return rows;
  } catch { return []; }
}

export function validatePartnerSourceOwner(profile: ConnectionProfile, snapshot: AppSnapshot): void {
  const connection = snapshot.remoteConnections.find(candidate => candidate.id === profile.id);
  const device = snapshot.devices.find(candidate => candidate.id === profile.deviceId);
  if (connection?.deviceId !== profile.deviceId || !["connected", "disconnected"].includes(connection.state)
    || device === undefined || device.revoked) throw new Error("The saved Partner source is no longer authorized.");
}

/** Preparation has no canonical task yet, but still requires a fresh public profile. */
export function validatePartnerSourceProfile(partnerId: string, partner: PartnerProfileView): PartnerProfileView {
  if (partner.id !== partnerId || !["active", "paused"].includes(partner.lifecycle) || partner.revision <= 0n
    || partner.profileVersion <= 0n || partner.homeTargetId.trim() === "") throw new Error("The original Partner profile is unavailable.");
  return partner;
}

export async function resolvePartnerSourceProfile(gateway: OrchestratorGateway, partnerId: string, signal: AbortSignal, assertOwner?: () => void): Promise<PartnerProfileView> {
  signal.throwIfAborted(); await gateway.refresh();
  signal.throwIfAborted(); assertOwner?.();
  const partner = await gateway.getPartner(partnerId, signal);
  signal.throwIfAborted(); return validatePartnerSourceProfile(partnerId, partner);
}

/** The service-owned Partner relation is the sole source of a canonical task ID. */
export function validatePartnerSourceSession(
  partnerId: string, partner: PartnerProfileView, links: readonly PartnerSessionView[], snapshot: AppSnapshot
): PartnerSourceResolution {
  const canonical = links.filter(link => link.role === "canonical" && link.available && !link.deleted && !link.archived && !link.readOnly);
  const link = canonical[0];
  const session = link && snapshot.sessions.find(candidate => candidate.id === link.sessionId);
  const home = snapshot.targets.find(target => target.id === partner.homeTargetId);
  const backends = snapshot.backends.filter(backend => backend.id === session?.backendId);
  const backend = backends[0];
  if (partner.id !== partnerId || partner.lifecycle === "deleted" || partner.lifecycle === "archived" || partner.initializationState !== "ready"
    || partner.profileVersion <= 0n || canonical.length !== 1 || link?.partnerId !== partnerId
    || link.sessionId !== partner.canonicalSessionId || link.profileVersion <= 0n || link.profileVersion > partner.profileVersion
    || session === undefined || session.targetId !== partner.homeTargetId || session.archived || session.state === "closed"
    || home === undefined || home.archived || home.remoteWorkspace !== undefined || session.remoteWorkspace !== undefined
    || home.backendId !== session.backendId || backends.length !== 1 || backend === undefined || backend.health === "unavailable"
    || (backend.installationState !== undefined && !["installed", "updateAvailable"].includes(backend.installationState))
    || (backend.authenticationState !== undefined && !["authenticated", "notRequired"].includes(backend.authenticationState))) {
    throw new Error("The Partner's canonical task or home changed. Refresh its source before opening it.");
  }
  return { partner, link, session };
}

export async function resolvePartnerSourceSession(gateway: OrchestratorGateway, partnerId: string, snapshot: () => AppSnapshot | undefined, signal: AbortSignal, assertOwner?: () => void): Promise<PartnerSourceResolution> {
  signal.throwIfAborted();
  await gateway.refresh();
  signal.throwIfAborted(); assertOwner?.();
  const [partner, links] = await Promise.all([gateway.getPartner(partnerId, signal), gateway.listPartnerSessions(partnerId, signal)]);
  signal.throwIfAborted();
  const current = snapshot();
  if (current === undefined) throw new Error("The Partner source returned no current task snapshot.");
  return validatePartnerSourceSession(partnerId, partner, links, current);
}

interface SourceBinding {
  readonly key: string;
  profile: ConnectionProfile;
  epoch: number;
  status: PartnerSourceStatus;
  rows: readonly PartnerSourceRow[];
  gateway?: OrchestratorGateway;
  snapshot?: AppSnapshot;
  abort?: AbortController;
  flight?: Promise<void>;
}

/** Independent source shards mirror the reference roster's success-only merge and epoch retirement. */
export class PartnerSourceDirectory {
  readonly #dependencies: PartnerSourceDependencies;
  readonly #sources = new Map<string, SourceBinding>();
  #foreground = true;
  #epoch = 0;
  constructor(dependencies: PartnerSourceDependencies) { this.#dependencies = dependencies; }
  sync(profiles: readonly ConnectionProfile[]): void {
    const eligible = new Map(profiles.filter(profile => profile.id && profile.serverId && profile.deviceId && profile.origin).map(profile => [partnerSourceKey(profile), profile]));
    for (const [key, source] of this.#sources) if (!eligible.has(key)) { this.#retire(source); this.#sources.delete(key); this.#removeCache(key); }
    this.#pruneCache(new Set(eligible.keys()));
    for (const [key, profile] of eligible) {
      const current = this.#sources.get(key);
      if (current) current.profile = profile;
      else {
        let rows: readonly PartnerSourceRow[] = [];
        try { rows = parsePartnerSourceCache(this.#dependencies.storage?.getItem(CACHE_PREFIX + key) ?? null, key); } catch { /* display cache is optional */ }
        this.#sources.set(key, { key, profile, epoch: ++this.#epoch, status: "loading", rows });
      }
    }
    this.#publish();
  }
  getSources(): readonly PartnerSourceView[] { return [...this.#sources.values()].map(source => ({ key: source.key, profileId: source.profile.id, name: source.profile.name, epoch: source.epoch, status: source.status, rows: source.rows })); }
  getProfile(key: string): ConnectionProfile | undefined { return this.#sources.get(key)?.profile; }
  setForeground(foreground: boolean): void {
    if (foreground === this.#foreground) return;
    this.#foreground = foreground;
    if (!foreground) for (const source of this.#sources.values()) { this.#retire(source); if (!["accessDenied", "identityMismatch"].includes(source.status)) source.status = "offline"; }
    this.#publish();
  }
  async refreshAll(): Promise<void> {
    const keys = [...this.#sources.keys()];
    for (let offset = 0; offset < keys.length && this.#foreground; offset += 2) await Promise.allSettled(keys.slice(offset, offset + 2).map(key => this.refresh(key)));
  }
  refresh(key: string): Promise<void> {
    const source = this.#sources.get(key);
    if (source === undefined || !this.#foreground) return Promise.resolve();
    if (source.flight !== undefined) return source.flight;
    const flight = this.#refresh(source);
    source.flight = flight;
    void flight.finally(() => { if (source.flight === flight) source.flight = undefined; }).catch(() => undefined);
    return flight;
  }
  async resolve(key: string, partnerId: string, signal: AbortSignal): Promise<PartnerSourceResolution> {
    await this.refresh(key);
    signal.throwIfAborted();
    const source = this.#sources.get(key);
    if (!this.#foreground || source?.status !== "online" || source.gateway === undefined || source.abort === undefined) throw new Error("The Partner source is unavailable. Retry its connection.");
    const epoch = source.epoch;
    const current = () => this.#foreground && this.#sources.get(key) === source && source.epoch === epoch && source.status === "online";
    const combined = AbortSignal.any([signal, source.abort.signal]);
    const resolution = await resolvePartnerSourceSession(source.gateway, partnerId, () => source.snapshot, combined, () => this.#assertOwner(source, epoch));
    if (!current()) throw new Error("The Partner source changed while opening it.");
    validatePartnerSourceOwner(source.profile, source.snapshot!);
    return resolution;
  }
  async resolvePreparationProfile(key: string, partnerId: string, signal: AbortSignal): Promise<PartnerProfileView> {
    await this.refresh(key); signal.throwIfAborted();
    const source = this.#sources.get(key);
    if (!this.#foreground || source?.status !== "online" || source.gateway === undefined || source.abort === undefined) throw new Error("The Partner source is unavailable. Retry its connection.");
    const epoch = source.epoch;
    const partner = await resolvePartnerSourceProfile(source.gateway, partnerId, AbortSignal.any([signal, source.abort.signal]), () => this.#assertOwner(source, epoch));
    if (!this.#foreground || this.#sources.get(key) !== source || source.epoch !== epoch || source.status !== "online") throw new Error("The Partner source changed while opening preparation.");
    validatePartnerSourceOwner(source.profile, source.snapshot!);
    return partner;
  }
  async readAvatar(key: string, partnerId: string, revision: bigint, image: Exclude<PartnerAvatarView, string>, signal: AbortSignal): Promise<string> {
    const source = this.#sources.get(key), epoch = source?.epoch;
    const row = source?.rows.find(candidate => candidate.id === partnerId);
    if (!this.#foreground || source?.status !== "online" || source.gateway === undefined || source.abort === undefined
      || row?.revision !== revision || typeof row.avatar === "string" || row.avatar.sha256 !== image.sha256) throw new Error("The Partner image source is unavailable.");
    const gateway = source.gateway, combined = AbortSignal.any([signal, source.abort.signal]);
    combined.throwIfAborted();
    await gateway.refresh();
    combined.throwIfAborted();
    this.#assertOwner(source, epoch!);
    const currentRow = source.rows.find(candidate => candidate.id === partnerId);
    if (currentRow?.revision !== revision || typeof currentRow.avatar === "string" || currentRow.avatar.sha256 !== image.sha256) throw new Error("The Partner image source changed.");
    const result = await gateway.readPartnerAvatar(partnerId, revision, image, combined);
    combined.throwIfAborted();
    if (this.#sources.get(key) !== source || source.epoch !== epoch || source.status !== "online") throw new Error("The Partner image source changed.");
    return result;
  }
  invalidate(profileId: string): void {
    for (const source of this.#sources.values()) if (source.profile.id === profileId) { this.#retire(source); source.rows = []; source.status = "accessDenied"; this.#removeCache(source.key); }
    this.#publish();
  }
  dispose(): void { for (const source of this.#sources.values()) this.#retire(source); this.#sources.clear(); }
  async #refresh(source: SourceBinding): Promise<void> {
    this.#retire(source);
    const epoch = source.epoch;
    const abort = new AbortController(); source.abort = abort;
    const current = () => this.#foreground && !abort.signal.aborted && this.#sources.get(source.key) === source && source.epoch === epoch;
    source.status = "loading"; this.#publish();
    let authenticated = false;
    try {
      const identity = await this.#dependencies.probe(source.profile.origin, AbortSignal.any([abort.signal, AbortSignal.timeout(2_000)]));
      if (!current()) return;
      if (identity.serverId !== source.profile.serverId) { source.status = "identityMismatch"; source.rows = []; this.#removeCache(source.key); return; }
      const secret = await this.#dependencies.readAuthKey(source.profile);
      if (!current()) return;
      if (!secret) { source.status = "accessDenied"; source.rows = []; this.#removeCache(source.key); return; }
      const gateway = this.#dependencies.createGateway(source.profile, secret, {
        onSnapshot: snapshot => { if (current()) source.snapshot = snapshot; },
        onState: state => { if (current() && authenticated && state !== "connected") { source.status = "offline"; this.#publish(); } },
        onAuthenticationInvalidated: () => { if (current()) this.invalidate(source.profile.id); }
      });
      source.gateway = gateway;
      await gateway.connect({ snapshotOnly: true });
      if (!current()) { gateway.disconnect(); return; }
      if (source.snapshot === undefined) throw new Error("Missing Partner source owner.");
      try { validatePartnerSourceOwner(source.profile, source.snapshot); }
      catch { this.invalidate(source.profile.id); return; }
      authenticated = true;
      source.status = "online";
      try {
        const result = await gateway.listPartners(undefined, abort.signal);
        if (!current()) return;
        source.rows = partnerSourceRows(result); source.status = "online";
        this.#saveCache(source);
      } catch { if (current()) source.status = "readFailed"; }
    } catch { if (current()) source.status = authenticated ? "readFailed" : "offline"; }
    finally { if (current()) this.#publish(); }
  }
  #assertOwner(source: SourceBinding, epoch: number): void {
    if (!this.#foreground || this.#sources.get(source.key) !== source || source.epoch !== epoch || source.status !== "online" || source.snapshot === undefined) throw new Error("The Partner source changed while reading it.");
    try { validatePartnerSourceOwner(source.profile, source.snapshot); }
    catch (error) { this.invalidate(source.profile.id); throw error; }
  }
  #retire(source: SourceBinding): void { source.epoch = ++this.#epoch; source.abort?.abort(); source.abort = undefined; const gateway = source.gateway; source.gateway = undefined; source.snapshot = undefined; source.flight = undefined; gateway?.disconnect(); }
  #publish(): void { this.#dependencies.publish(this.getSources()); }
  #removeCache(key: string): void { try { this.#dependencies.storage?.removeItem(CACHE_PREFIX + key); } catch { /* optional display cache */ } }
  #saveCache(source: SourceBinding): void {
    try {
      const raw = JSON.stringify({ version: 1, sourceKey: source.key, rows: source.rows.map(row => ({ ...row, revision: row.revision.toString() })) });
      if (source.rows.length <= MAX_ROWS && raw.length <= MAX_CACHE_BYTES) this.#dependencies.storage?.setItem(CACHE_PREFIX + source.key, raw);
      else this.#removeCache(source.key);
    } catch { /* optional display cache */ }
  }
  #pruneCache(keys: ReadonlySet<string>): void {
    try { const storage = this.#dependencies.storage; if (!storage) return;
      for (let index = storage.length - 1; index >= 0; index -= 1) { const key = storage.key(index); if (key?.startsWith(CACHE_PREFIX) && !keys.has(key.slice(CACHE_PREFIX.length))) storage.removeItem(key); }
    } catch { /* optional display cache */ }
  }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []): boolean { return Object.keys(value).every(key => keys.includes(key)) && keys.every(key => optional.includes(key) || Object.hasOwn(value, key)); }
function text(value: unknown, maximum: number, empty = false): value is string { return typeof value === "string" && value.length <= maximum && (empty || value.trim().length > 0); }
function cacheAvatar(value: unknown): PartnerAvatarView | undefined {
  if (typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/u.test(value)) return value;
  if (!record(value) || !exactKeys(value, ["sha256", "mimeType", "byteLength"]) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256)
    || !["image/jpeg", "image/png", "image/webp"].includes(String(value.mimeType)) || !Number.isSafeInteger(value.byteLength)
    || (value.byteLength as number) <= 0 || (value.byteLength as number) > 5 * 1024 * 1024) return undefined;
  return { sha256: value.sha256, mimeType: value.mimeType as "image/jpeg" | "image/png" | "image/webp", byteLength: value.byteLength as number };
}
