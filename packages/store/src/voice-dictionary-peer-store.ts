import { createHash, createPublicKey } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isIP } from "node:net";
import { DatabaseSync } from "node:sqlite";

const MAX_PEERS = 128;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;
const SCHEMA = `
CREATE TABLE dictionary_peer_schema (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  version INTEGER NOT NULL CHECK(version = 1),
  baseline_id TEXT NOT NULL CHECK(length(baseline_id) = 64),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991)
) STRICT;
CREATE TABLE dictionary_peer_identity (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  node_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  sealed_key_json TEXT NOT NULL
) STRICT;
CREATE TABLE dictionary_peer_grants (
  peer_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  display_name TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
  granted_at INTEGER NOT NULL CHECK(granted_at >= 0),
  last_sync_at INTEGER CHECK(last_sync_at >= granted_at),
  route_host TEXT,
  route_port INTEGER,
  CHECK((route_host IS NULL AND route_port IS NULL) OR
    (route_host IS NOT NULL AND route_port BETWEEN 1 AND 65535))
) STRICT;
CREATE TABLE dictionary_peer_listener (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  listen_port INTEGER NOT NULL CHECK(listen_port BETWEEN 1 AND 65535),
  advertised_host TEXT NOT NULL,
  advertised_port INTEGER NOT NULL CHECK(advertised_port BETWEEN 1 AND 65535)
) STRICT;
`;
const BASELINE_ID = createHash("sha256").update(SCHEMA + "sealed-key:aes-256-gcm/nonce/ciphertext/tag:v1").digest("hex");
type Row = Record<string, unknown>;

export interface VoiceDictionaryPeerSealedKey {
  readonly algorithm: "aes-256-gcm";
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}
/** Private service record: never part of generic Settings, Event, Session or diagnostics. */
export interface VoiceDictionaryPeerIdentity {
  readonly nodeId: string;
  readonly publicKey: string;
  readonly sealedKey: VoiceDictionaryPeerSealedKey;
}
export interface VoiceDictionaryPeerGrant {
  readonly peerId: string;
  /** This revision identifies one grant lifetime, not volatile sync activity. */
  readonly revision: bigint;
  readonly displayName: string;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly grantedAt: number;
  readonly lastSyncAt?: number;
  readonly route?: VoiceDictionaryPeerEndpoint;
}
export interface VoiceDictionaryPeerEndpoint { readonly host: string; readonly port: number; }
export interface VoiceDictionaryPeerListener extends VoiceDictionaryPeerEndpoint { readonly listenPort: number; }
interface GrantInput {
  readonly expectedRevision: bigint; readonly peerId: string; readonly displayName: string;
  readonly publicKey: string; readonly fingerprint: string;
}
export class VoiceDictionaryPeerStoreError extends Error {
  constructor(readonly code: "INVALID" | "CONFLICT" | "UNAVAILABLE", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VoiceDictionaryPeerStoreError";
  }
}

/** Independent private authority; dictionary content and enabled remain in their existing repository. */
export class VoiceDictionaryPeerStore {
  readonly #database: DatabaseSync;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();
  #closed = false;
  #writing = false;

  constructor(path: string, options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
    const target = path === ":memory:" ? path : resolve(path);
    if (target !== ":memory:") mkdirSync(dirname(target), { recursive: true });
    this.#database = new DatabaseSync(target);
    try {
      this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;");
      this.#initialize();
      const identity = this.identity();
      const peers = this.peers();
      const listener = this.listener();
      if ((identity === undefined && (peers.length > 0 || listener !== undefined)) || peers.some((peer) => peer.peerId === identity?.nodeId ||
        peer.publicKey === identity?.publicKey || peer.revision > this.configurationRevision())) throw unavailable();
    } catch (error) {
      this.#closed = true;
      this.#database.close();
      throw new VoiceDictionaryPeerStoreError("UNAVAILABLE", "The dictionary peer database is not the current valid v1 baseline. Rebuild incompatible development data explicitly.", { cause: error });
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#database.close();
  }

  subscribe(listener: () => void): () => void {
    this.#assertOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  configurationRevision(): bigint {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT revision FROM dictionary_peer_schema WHERE singleton = 1").get() as Row | undefined;
    if (row === undefined) throw unavailable();
    return BigInt(integer(row.revision, 1));
  }

  identity(): VoiceDictionaryPeerIdentity | undefined {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT node_id, public_key, sealed_key_json FROM dictionary_peer_identity WHERE singleton = 1").get() as Row | undefined;
    if (row === undefined) return undefined;
    let sealed: unknown;
    try { sealed = JSON.parse(string(row.sealed_key_json)); } catch { throw unavailable(); }
    return { nodeId: nodeId(row.node_id), publicKey: publicKey(row.public_key), sealedKey: sealedKey(sealed) };
  }

  initializeIdentity(value: VoiceDictionaryPeerIdentity): VoiceDictionaryPeerIdentity {
    const normalized = { nodeId: nodeId(value.nodeId), publicKey: publicKey(value.publicKey), sealedKey: sealedKey(value.sealedKey) };
    return this.#write(() => {
      if (this.identity() !== undefined) throw conflict();
      this.#database.prepare("INSERT INTO dictionary_peer_identity(singleton, node_id, public_key, sealed_key_json) VALUES(1, ?, ?, ?)")
        .run(normalized.nodeId, normalized.publicKey, JSON.stringify(normalized.sealedKey));
      this.#advanceRevision();
      return this.identity()!;
    });
  }

  peers(): readonly VoiceDictionaryPeerGrant[] {
    this.#assertOpen();
    const rows = this.#database.prepare("SELECT * FROM dictionary_peer_grants ORDER BY peer_id").all() as Row[];
    if (rows.length > MAX_PEERS) throw unavailable();
    return rows.map(peerFromRow);
  }

  peer(peerId: string): VoiceDictionaryPeerGrant | undefined {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT * FROM dictionary_peer_grants WHERE peer_id = ?").get(nodeId(peerId)) as Row | undefined;
    return row === undefined ? undefined : peerFromRow(row);
  }

  listener(): VoiceDictionaryPeerListener | undefined {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT listen_port, advertised_host, advertised_port FROM dictionary_peer_listener WHERE singleton = 1").get() as Row | undefined;
    return row === undefined ? undefined : { ...endpoint(row.advertised_host, row.advertised_port), listenPort: port(row.listen_port) };
  }

  configureListener(expectedRevision: bigint, value: VoiceDictionaryPeerListener | undefined): void {
    const listener = value === undefined ? undefined : { ...endpoint(value.host, value.port), listenPort: port(value.listenPort) };
    this.#write(() => {
      this.#assertRevision(expectedRevision);
      if (this.identity() === undefined) throw unavailable();
      if (JSON.stringify(this.listener()) === JSON.stringify(listener)) return;
      this.#database.prepare("DELETE FROM dictionary_peer_listener WHERE singleton = 1").run();
      if (listener !== undefined) this.#database.prepare("INSERT INTO dictionary_peer_listener(singleton, listen_port, advertised_host, advertised_port) VALUES(1, ?, ?, ?)")
        .run(listener.listenPort, listener.host, listener.port);
      this.#advanceRevision();
    });
  }

  grantPeer(input: GrantInput): VoiceDictionaryPeerGrant {
    const normalized = this.#normalizeGrant(input);
    return this.#write(() => { this.#assertRevision(input.expectedRevision); return this.#grant(normalized); });
  }

  /** Route and independent grant become visible in the same durable transaction. */
  grantDirectPeer(input: GrantInput & { readonly route: VoiceDictionaryPeerEndpoint }): VoiceDictionaryPeerGrant {
    const normalized = this.#normalizeGrant(input);
    const route = endpoint(input.route.host, input.route.port);
    return this.#write(() => {
      this.#assertRevision(input.expectedRevision);
      const granted = this.#grant(normalized);
      if (granted.route?.host !== route.host || granted.route.port !== route.port) {
        this.#database.prepare("UPDATE dictionary_peer_grants SET route_host = ?, route_port = ? WHERE peer_id = ?")
          .run(route.host, route.port, granted.peerId);
        if (this.configurationRevision() === input.expectedRevision) this.#advanceRevision();
      }
      return this.peer(granted.peerId)!;
    });
  }

  clearPeerRoute(expectedRevision: bigint, peerId: string): void {
    this.#write(() => {
      this.#assertRevision(expectedRevision);
      const peer = this.peer(peerId);
      if (peer === undefined) throw conflict();
      if (peer.route === undefined) return;
      this.#database.prepare("UPDATE dictionary_peer_grants SET route_host = NULL, route_port = NULL WHERE peer_id = ?").run(peer.peerId);
      this.#advanceRevision();
    });
  }

  #normalizeGrant(input: GrantInput): Omit<GrantInput, "expectedRevision"> {
    const peerId = nodeId(input.peerId);
    const key = publicKey(input.publicKey);
    const name = displayName(input.displayName);
    if (input.fingerprint !== fingerprint(key)) throw invalid();
    return { peerId, publicKey: key, displayName: name, fingerprint: input.fingerprint };
  }

  #grant(input: Omit<GrantInput, "expectedRevision">): VoiceDictionaryPeerGrant {
      const { peerId, publicKey: key, displayName: name } = input;
      const self = this.identity();
      if (self === undefined) throw unavailable();
      if (self.nodeId === peerId || self.publicKey === key) throw invalid();
      const existing = this.peer(peerId);
      if (existing !== undefined) {
        if (existing.publicKey !== key) throw conflict();
        return existing;
      }
      if (this.peers().length >= MAX_PEERS || this.peers().some((peer) => peer.publicKey === key)) throw invalid();
      const revision = this.#advanceRevision();
      this.#database.prepare("INSERT INTO dictionary_peer_grants(peer_id, revision, display_name, public_key, fingerprint, granted_at) VALUES(?, ?, ?, ?, ?, ?)")
        .run(peerId, revision, name, key, fingerprint(key), timestamp(this.#now()));
      return this.peer(peerId)!;
  }

  revokePeer(peerId: string, expectedRevision: bigint): void {
    this.#write(() => {
      const peer = this.peer(peerId);
      if (peer === undefined || peer.revision !== expectedRevision) throw conflict();
      this.#database.prepare("DELETE FROM dictionary_peer_grants WHERE peer_id = ?").run(peer.peerId);
      this.#advanceRevision();
    });
  }

  /** Success is metadata only and cannot extend or resurrect a revoked grant. */
  recordSuccess(peerId: string, grantRevision: bigint, at: number): boolean {
    return this.#write(() => {
      const peer = this.peer(peerId);
      if (peer === undefined || peer.revision !== grantRevision) return false;
      this.#database.prepare("UPDATE dictionary_peer_grants SET last_sync_at = ? WHERE peer_id = ? AND revision = ?")
        .run(Math.max(peer.grantedAt, peer.lastSyncAt ?? 0, timestamp(at)), peer.peerId, Number(peer.revision));
      return true;
    }, false);
  }

  #initialize(): void {
    const catalog = this.#catalog();
    if (catalog.length === 0) {
      const version = this.#database.prepare("PRAGMA user_version").get() as Row;
      if (version.user_version !== 0) throw unavailable();
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        this.#database.exec(SCHEMA);
        this.#database.prepare("INSERT INTO dictionary_peer_schema(singleton, version, baseline_id, revision) VALUES(1, 1, ?, 1)").run(BASELINE_ID);
        this.#database.exec("PRAGMA user_version = 1; COMMIT;");
      } catch (error) {
        try { this.#database.exec("ROLLBACK"); } catch {}
        throw error;
      }
    }
    const marker = this.#database.prepare("SELECT version, baseline_id FROM dictionary_peer_schema WHERE singleton = 1").get() as Row | undefined;
    const version = this.#database.prepare("PRAGMA user_version").get() as Row;
    const integrity = this.#database.prepare("PRAGMA quick_check").all() as Row[];
    if (marker?.version !== 1 || marker.baseline_id !== BASELINE_ID || version.user_version !== 1 ||
      integrity.length !== 1 || integrity[0]?.quick_check !== "ok") throw unavailable();
    const expected = new DatabaseSync(":memory:");
    try {
      expected.exec(SCHEMA);
      const rows = expected.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
      if (JSON.stringify(this.#catalog()) !== JSON.stringify(rows)) throw unavailable();
    } finally { expected.close(); }
    this.configurationRevision();
  }

  #catalog(): Row[] {
    return this.#database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Row[];
  }

  #write<T>(run: () => T, publish = true): T {
    this.#assertOpen();
    if (this.#writing) throw unavailable();
    this.#database.exec("BEGIN IMMEDIATE");
    this.#writing = true;
    let value: T;
    let before: bigint;
    try {
      before = this.configurationRevision();
      value = run();
      this.#database.exec("COMMIT");
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch {}
      if (error instanceof VoiceDictionaryPeerStoreError) throw error;
      throw new VoiceDictionaryPeerStoreError("UNAVAILABLE", "The dictionary peer state could not be committed.", { cause: error });
    } finally { this.#writing = false; }
    if (publish && before !== this.configurationRevision()) {
      for (const listener of this.#listeners) { try { listener(); } catch {} }
    }
    return value;
  }

  #advanceRevision(): number {
    const revision = Number(this.configurationRevision());
    if (revision >= MAX_REVISION) throw unavailable();
    this.#database.prepare("UPDATE dictionary_peer_schema SET revision = ? WHERE singleton = 1").run(revision + 1);
    return revision + 1;
  }
  #assertRevision(expected: bigint): void {
    if (typeof expected !== "bigint" || expected < 1n || expected > BigInt(MAX_REVISION)) throw invalid();
    if (expected !== this.configurationRevision()) throw conflict();
  }
  #assertOpen(): void { if (this.#closed) throw unavailable(); }
}

function peerFromRow(row: Row): VoiceDictionaryPeerGrant {
  const key = publicKey(row.public_key);
  const grantedAt = timestamp(row.granted_at);
  const lastSyncAt = row.last_sync_at === null ? undefined : timestamp(row.last_sync_at);
  if (row.fingerprint !== fingerprint(key) || (lastSyncAt !== undefined && lastSyncAt < grantedAt)) throw unavailable();
  const route = row.route_host === null && row.route_port === null ? undefined : endpoint(row.route_host, row.route_port);
  return { peerId: nodeId(row.peer_id), revision: BigInt(integer(row.revision, 1)), displayName: displayName(row.display_name),
    publicKey: key, fingerprint: fingerprint(key), grantedAt, ...(lastSyncAt === undefined ? {} : { lastSyncAt }),
    ...(route === undefined ? {} : { route }) };
}
function port(value: unknown): number { const result = integer(value, 1); if (result > 65535) throw invalid(); return result; }
function endpoint(host: unknown, value: unknown): VoiceDictionaryPeerEndpoint {
  if (typeof host !== "string" || host.length < 1 || host.length > 253 || host !== host.trim() || host.includes("%") ||
    (isIP(host) === 0 && (!/^[A-Za-z0-9.-]+$/u.test(host) || /^[0-9.]+$/u.test(host) ||
      !host.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label))))) throw invalid();
  return { host, port: port(value) };
}
function publicKey(value: unknown): string {
  const bytes = base64(value, 32, 128);
  try {
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "x25519" || key.export({ format: "der", type: "spki" }).toString("base64") !== value) throw invalid();
    return value as string;
  } catch { throw invalid(); }
}
function sealedKey(value: unknown): VoiceDictionaryPeerSealedKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const object = value as Record<string, unknown>;
  const keys = ["algorithm", "nonce", "ciphertext", "tag"];
  if (Object.keys(object).length !== 4 || !keys.every((key) => Object.hasOwn(object, key)) || object.algorithm !== "aes-256-gcm") throw invalid();
  base64(object.nonce, 12, 12); base64(object.tag, 16, 16); base64(object.ciphertext, 1, 256);
  return { algorithm: "aes-256-gcm", nonce: object.nonce as string, tag: object.tag as string, ciphertext: object.ciphertext as string };
}
function base64(value: unknown, minimum: number, maximum: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw invalid();
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength < minimum || bytes.byteLength > maximum || bytes.toString("base64") !== value) throw invalid();
  return bytes;
}
function fingerprint(key: string): string { return createHash("sha256").update(Buffer.from(key, "base64")).digest("hex"); }
function string(value: unknown): string { if (typeof value !== "string") throw invalid(); return value; }
function integer(value: unknown, minimum: number): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw invalid(); return value; }
function timestamp(value: unknown): number { return integer(value, 0); }
function nodeId(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) throw invalid(); return value; }
function displayName(value: unknown): string { if (typeof value !== "string" || value !== value.trim() || value.length < 1 || value.length > 100 || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid(); return value; }
function invalid(): VoiceDictionaryPeerStoreError { return new VoiceDictionaryPeerStoreError("INVALID", "The dictionary peer identity or mutation is invalid."); }
function conflict(): VoiceDictionaryPeerStoreError { return new VoiceDictionaryPeerStoreError("CONFLICT", "The dictionary peer identity or grant changed concurrently."); }
function unavailable(): VoiceDictionaryPeerStoreError { return new VoiceDictionaryPeerStoreError("UNAVAILABLE", "The dictionary peer authority is unavailable."); }
