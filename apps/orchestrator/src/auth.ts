import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface ConnectionRecord {
  readonly id: string;
  readonly label: string;
  readonly keyDigest: string;
  readonly revokedAt?: number;
}

export interface PairingRecord {
  readonly digest: string;
  readonly expiresAt: number;
  readonly usedAt?: number;
}

export interface AuthRepository {
  createPairing(record: PairingRecord): Promise<void>;
  consumePairing(digest: string, now: number): Promise<boolean>;
  createConnection(record: ConnectionRecord): Promise<void>;
  findConnectionByDigest(digest: string): Promise<ConnectionRecord | undefined>;
  revokeConnection(id: string, now: number): Promise<boolean>;
}

export interface PairedConnection {
  readonly connection: ConnectionRecord;
  readonly authKey: string;
}

export class AuthService {
  readonly #repository: AuthRepository;
  readonly #now: () => number;
  readonly #pairingTtlMs: number;

  constructor(repository: AuthRepository, options?: { now?: () => number; pairingTtlMs?: number }) {
    this.#repository = repository;
    this.#now = options?.now ?? Date.now;
    this.#pairingTtlMs = options?.pairingTtlMs ?? 10 * 60 * 1_000;
  }

  async issuePairingCode(): Promise<{ code: string; expiresAt: number }> {
    const code = formatPairingCode(randomBytes(6));
    const expiresAt = this.#now() + this.#pairingTtlMs;
    await this.#repository.createPairing({ digest: digest(code), expiresAt });
    return { code, expiresAt };
  }

  async pair(code: string, connectionId: string, label: string): Promise<PairedConnection> {
    const now = this.#now();
    if (!(await this.#repository.consumePairing(digest(normalizePairingCode(code)), now))) {
      throw new AuthenticationError("PAIRING_INVALID", "The pairing code is invalid, expired, or already used.");
    }
    const authKey = randomBytes(32).toString("base64url");
    const connection: ConnectionRecord = {
      id: connectionId,
      label: label.trim() || "Unnamed device",
      keyDigest: digest(authKey)
    };
    await this.#repository.createConnection(connection);
    return { connection, authKey };
  }

  async authenticate(authorization: string | undefined): Promise<ConnectionRecord> {
    const token = parseBearer(authorization);
    if (token === undefined) throw new AuthenticationError("AUTH_REQUIRED", "Authentication is required.");
    const expected = digest(token);
    const connection = await this.#repository.findConnectionByDigest(expected);
    if (connection === undefined || connection.revokedAt !== undefined || !safeEqual(connection.keyDigest, expected)) {
      throw new AuthenticationError("AUTH_REVOKED", "The connection key is invalid or revoked.");
    }
    return connection;
  }

  async revoke(connectionId: string): Promise<void> {
    if (!(await this.#repository.revokeConnection(connectionId, this.#now()))) {
      throw new AuthenticationError("CONNECTION_NOT_FOUND", "The connection does not exist.");
    }
  }
}

export class AuthenticationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthenticationError";
    this.code = code;
  }
}

export function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function formatPairingCode(bytes: Buffer): string {
  const value = bytes.toString("base64url").toUpperCase().replace(/[-_]/g, "A").slice(0, 8);
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function normalizePairingCode(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized.length === 8 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : value.trim().toUpperCase();
}

function parseBearer(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  return match?.[1];
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
