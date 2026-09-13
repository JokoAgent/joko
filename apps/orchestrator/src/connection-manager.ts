import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ConnectionRecord, CreateDeviceInput, DeviceRecord, OperationalStore, RevokedDeviceResult } from "@joko/store";

export interface PairingChallengeRecord {
  readonly id: string;
  readonly code: string;
  readonly expiresAt: number;
}

export interface PairingDeviceInput extends Omit<CreateDeviceInput, "id" | "pairedAt"> {
  readonly id?: string;
}

export interface CompletedPairing {
  readonly connection: ConnectionRecord;
  readonly authKey: string;
}

export interface TrustedDesktopConnectionInput {
  readonly desktopInstanceId: string;
  readonly desktopDeviceId: string;
  readonly deviceName: string;
  readonly platform: string;
  readonly appVersion: string;
  readonly previousConnectionId?: string;
  readonly previousAuthKey?: string;
}

interface DesktopBootstrapMarker {
  readonly connectionId: string;
  readonly predecessorConnectionId: string | null;
  readonly state: "provisional" | "committed" | "loggedOut";
}

const DESKTOP_BOOTSTRAP_SETTING_PREFIX = "runtime.desktop_bootstrap.";

export class ConnectionManager {
  readonly #store: OperationalStore;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #pairingWindowMs: number;
  readonly #pairingRateWindowMs: number;
  readonly #pairingAttemptWindowMs: number;
  readonly #maxPairingRequests: number;
  readonly #maxPairingAttempts: number;
  readonly #maxOutstandingPairings: number;
  readonly #consumedRetentionMs: number;
  readonly #pairingListeners = new Set<(challenge: PairingChallengeRecord) => void>();
  readonly #revocationListeners = new Map<string, Set<() => void>>();
  readonly #pairingRequestTimes: number[] = [];
  readonly #pairingAttemptTimes: number[] = [];
  #pairingWindowExpiresAt = 0;

  constructor(store: OperationalStore, options: {
    readonly now?: () => number;
    readonly pairingTtlMs?: number;
    readonly pairingWindowMs?: number;
    readonly pairingRateWindowMs?: number;
    readonly pairingAttemptWindowMs?: number;
    readonly maxPairingRequests?: number;
    readonly maxPairingAttempts?: number;
    readonly maxOutstandingPairings?: number;
    readonly consumedRetentionMs?: number;
  } = {}) {
    this.#store = store;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.pairingTtlMs ?? 10 * 60_000;
    this.#pairingWindowMs = options.pairingWindowMs ?? 10 * 60_000;
    this.#pairingRateWindowMs = options.pairingRateWindowMs ?? 60_000;
    this.#pairingAttemptWindowMs = options.pairingAttemptWindowMs ?? 60_000;
    this.#maxPairingRequests = options.maxPairingRequests ?? 6;
    this.#maxPairingAttempts = options.maxPairingAttempts ?? 12;
    this.#maxOutstandingPairings = options.maxOutstandingPairings ?? 16;
    this.#consumedRetentionMs = options.consumedRetentionMs ?? 24 * 60 * 60_000;
    for (const [label, value] of [
      ["Pairing lifetime", this.#ttlMs],
      ["Pairing window", this.#pairingWindowMs],
      ["Pairing rate window", this.#pairingRateWindowMs],
      ["Pairing attempt window", this.#pairingAttemptWindowMs],
      ["Pairing request limit", this.#maxPairingRequests],
      ["Pairing attempt limit", this.#maxPairingAttempts],
      ["Outstanding pairing limit", this.#maxOutstandingPairings],
      ["Consumed pairing retention", this.#consumedRetentionMs]
    ] as const) if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer.`);
  }

  /** Owner-only control used by the local service console or an authenticated client. */
  openPairingWindow(durationMs = this.#pairingWindowMs): number {
    if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > this.#pairingWindowMs) {
      throw new RangeError("Pairing window duration is outside policy.");
    }
    this.#pairingWindowExpiresAt = this.#now() + durationMs;
    this.#pairingRequestTimes.length = 0;
    return this.#pairingWindowExpiresAt;
  }

  closePairingWindow(): void {
    this.#pairingWindowExpiresAt = 0;
    this.#pairingRequestTimes.length = 0;
  }

  get pairingEnabled(): boolean {
    return this.#pairingWindowExpiresAt > this.#now();
  }

  /** Unauthenticated remote requests are accepted only inside an owner-opened, bounded window. */
  requestPairing(label?: string, device?: PairingDeviceInput): PairingChallengeRecord {
    const now = this.#now();
    if (this.#pairingWindowExpiresAt <= now) {
      throw new PairingRequestError("PAIRING_WINDOW_CLOSED", "Pairing is not currently enabled by the owner.");
    }
    this.#reservePairingIssue(now);
    return this.#issuePairing(label, now, device);
  }

  /** Trusted local owner path; remote handlers must call requestPairing(). */
  issuePairing(label?: string, device?: PairingDeviceInput): PairingChallengeRecord {
    const now = this.#now();
    this.#reservePairingIssue(now);
    const challenge = this.#issuePairing(label, now, device);
    this.#store.appendDiagnostic({
      severity: "info",
      component: "connection",
      code: "TRUSTED_LOCAL_PAIRING_ISSUED",
      message: "A trusted local owner issued a bounded pairing challenge.",
      details: { challengeId: challenge.id, expiresAt: challenge.expiresAt }
    });
    return challenge;
  }

  #reservePairingIssue(now: number): void {
    this.#store.prunePairings({
      expiredBefore: now,
      consumedBefore: now - this.#consumedRetentionMs
    });
    while ((this.#pairingRequestTimes[0] ?? now) <= now - this.#pairingRateWindowMs) this.#pairingRequestTimes.shift();
    const durableRecentIssues = this.#store.listPairings()
      .filter((pairing) => pairing.createdAt > now - this.#pairingRateWindowMs)
      .length;
    if (Math.max(this.#pairingRequestTimes.length, durableRecentIssues) >= this.#maxPairingRequests) {
      throw new PairingRequestError("PAIRING_RATE_LIMITED", "Pairing requests are temporarily rate limited.");
    }
    if (this.#store.listPairings(true).length >= this.#maxOutstandingPairings) {
      throw new PairingRequestError("PAIRING_CAPACITY", "The outstanding pairing challenge limit was reached.");
    }
    this.#pairingRequestTimes.push(now);
  }

  #issuePairing(label: string | undefined, now: number, device?: PairingDeviceInput): PairingChallengeRecord {
    const id = randomUUID();
    const code = formatCode(randomBytes(6));
    const expiresAt = now + this.#ttlMs;
    this.#store.createPairing({
      id,
      codeDigest: digestPairingCode(code),
      label,
      device: {
        id: device?.id ?? randomUUID(),
        name: device?.name.trim() || label?.trim() || "Unnamed device",
        kind: device?.kind ?? "unspecified",
        platform: device?.platform ?? "",
        appVersion: device?.appVersion ?? "",
        pairedAt: now
      },
      expiresAt,
      createdAt: now
    });
    const challenge = { id, code, expiresAt };
    for (const listener of this.#pairingListeners) listener(challenge);
    return challenge;
  }

  onPairingIssued(listener: (challenge: PairingChallengeRecord) => void): () => void {
    this.#pairingListeners.add(listener);
    return () => this.#pairingListeners.delete(listener);
  }

  completePairing(input: {
    readonly challengeId: string;
    readonly code: string;
    readonly connectionName: string;
    readonly device?: PairingDeviceInput;
  }): CompletedPairing {
    const now = this.#now();
    this.#reservePairingAttempt(now);
    const codeDigest = digestPairingCode(input.code);
    const direct = this.#store.listPairings(true).find((pairing) => pairing.id === input.challengeId && safeEqual(pairing.codeDigest, codeDigest));
    const pairing = direct ?? this.#store.listPairings(true).find((candidate) => safeEqual(candidate.codeDigest, codeDigest));
    if (pairing === undefined || pairing.expiresAt <= now) throw invalidPairingError();
    const authKey = randomBytes(32).toString("base64url");
    const connection = this.#store.consumePairing({
      pairingId: pairing.id,
      codeDigest,
      connectionId: randomUUID(),
      connectionName: input.connectionName.trim() || "Unnamed device",
      ...(input.device === undefined ? {} : {
        device: {
          id: input.device.id ?? randomUUID(),
          name: input.device.name,
          kind: input.device.kind ?? "unspecified",
          platform: input.device.platform ?? "",
          appVersion: input.device.appVersion ?? ""
        }
      }),
      authKeyDigest: digestAuthKey(authKey),
      consumedAt: now
    });
    return { connection, authKey };
  }

  #reservePairingAttempt(now: number): void {
    while ((this.#pairingAttemptTimes[0] ?? now) <= now - this.#pairingAttemptWindowMs) {
      this.#pairingAttemptTimes.shift();
    }
    // Completion is intentionally available for a challenge issued by the
    // trusted local CLI even while anonymous BeginPairing is closed. Keep that
    // recovery path from becoming an unbounded code-guessing oracle. The
    // limiter is process-global and retains at most maxPairingAttempts values.
    if (this.#pairingAttemptTimes.length >= this.#maxPairingAttempts) throw invalidPairingError();
    this.#pairingAttemptTimes.push(now);
  }

  /**
   * Mint a normal, revocable Connection for a Desktop instance that has
   * already been authenticated by the private parent/child bootstrap pipe.
   * This method must never be reachable from an HTTP or Connect handler.
   */
  issueTrustedDesktopConnection(input: TrustedDesktopConnectionInput): CompletedPairing {
    const instanceId = boundedDesktopInstanceId(input.desktopInstanceId);
    const deviceId = boundedDesktopInstanceId(input.desktopDeviceId);
    const deviceName = boundedDesktopText(input.deviceName, 128, "Desktop device name");
    const platform = boundedDesktopText(input.platform, 64, "Desktop platform");
    const appVersion = boundedDesktopText(input.appVersion, 64, "Desktop app version");
    const connectionId = `desktop-connection_${instanceId}`;
    const hasPreviousId = input.previousConnectionId !== undefined;
    const hasPreviousKey = input.previousAuthKey !== undefined;
    if (hasPreviousId !== hasPreviousKey) {
      throw new ConnectionAuthenticationError("AUTH_REVOKED", "Managed Desktop authorization is unavailable.");
    }
    // One installed Desktop owns at most one active managed connection. A new
    // process instance revokes the previous credential without revoking the
    // durable Device itself.
    const authKey = randomBytes(32).toString("base64url");
    const revokedIds: string[] = [];
    const connection = this.#store.transaction((store) => {
      if (store.listConnections().some((candidate) => candidate.id === connectionId)) {
        throw new Error("Desktop instance identity was already used.");
      }
      const priorConnections = store.listDeviceConnections(deviceId);
      const activeConnections = priorConnections.filter((prior) => prior.state === "active");
      const marker = readDesktopBootstrapMarker(store.findSetting(
        "service", "orchestrator", desktopBootstrapSettingKey(deviceId)
      )?.value);
      const rebootstrapAuthorized = marker?.state === "loggedOut" &&
        marker.predecessorConnectionId === null && !hasPreviousId && activeConnections.length === 0 &&
        priorConnections.some((prior) => prior.id === marker.connectionId && prior.state === "revoked") &&
        store.getDevice(deviceId).state === "active";
      // A generic durable revoke must be a terminal authorization decision.
      // The private bootstrap may rotate an active managed
      // credential after a service restart. Only the one-shot marker written
      // atomically by that exact managed connection's own logout may replace
      // revoked-only history without the old bearer.
      if (priorConnections.length > 0 && activeConnections.length === 0 && !rebootstrapAuthorized) {
        throw managedDesktopAuthorizationUnavailable();
      }
      let predecessorConnectionId: string | null = null;
      if (priorConnections.length === 0) {
        if (marker !== undefined || hasPreviousId) throw managedDesktopAuthorizationUnavailable();
      } else if (rebootstrapAuthorized) {
        predecessorConnectionId = null;
      } else {
        if (marker === undefined) {
          // An owner-issued recovery pairing may create a normal active Device
          // before Desktop can adopt it as its managed identity. Exact proof of
          // that active Connection is the only path that may establish the
          // first managed marker; missing proof and revoked-only history remain
          // terminal. This is never reachable from the public API itself.
          if (!hasPreviousId || !this.#validPreviousDesktopCredential(
            deviceId,
            input.previousConnectionId!,
            input.previousAuthKey!,
            true
          )) throw managedDesktopAuthorizationUnavailable();
          predecessorConnectionId = input.previousConnectionId!;
        } else if (marker.state === "loggedOut" ||
          !activeConnections.some((prior) => prior.id === marker.connectionId)) {
          throw managedDesktopAuthorizationUnavailable();
        } else if (marker.state === "committed") {
          if (!hasPreviousId || input.previousConnectionId !== marker.connectionId ||
            !this.#validPreviousDesktopCredential(deviceId, input.previousConnectionId!, input.previousAuthKey!, true)) {
            throw managedDesktopAuthorizationUnavailable();
          }
          predecessorConnectionId = marker.connectionId;
        } else if (hasPreviousId) {
          const previousId = input.previousConnectionId!;
          const provesCurrent = previousId === marker.connectionId &&
            this.#validPreviousDesktopCredential(deviceId, previousId, input.previousAuthKey!, true);
          const provesPredecessor = marker.predecessorConnectionId !== null &&
            previousId === marker.predecessorConnectionId &&
            this.#validPreviousDesktopCredential(deviceId, previousId, input.previousAuthKey!, false);
          if (!provesCurrent && !provesPredecessor) throw managedDesktopAuthorizationUnavailable();
          predecessorConnectionId = previousId;
        } else if (marker.predecessorConnectionId !== null) {
          // Only a first-install crash before metadata existed has no
          // predecessor proof. Losing committed metadata is fail-closed.
          throw managedDesktopAuthorizationUnavailable();
        }
      }
      for (const prior of activeConnections) {
        store.revokeConnection(prior.id, undefined, this.#now());
        revokedIds.push(prior.id);
      }
      const created = store.createConnection({
        // Deterministic IDs make a mistakenly reused one-shot instance fail
        // closed at the durable uniqueness boundary instead of minting twice.
        id: connectionId,
        deviceId,
        device: {
          name: deviceName,
          kind: "desktop",
          platform,
          appVersion,
          pairedAt: this.#now()
        },
        name: `${deviceName} local instance`,
        authKeyDigest: digestAuthKey(authKey),
        pairedAt: this.#now()
      });
      store.setSetting<DesktopBootstrapMarker>(
        "service",
        "orchestrator",
        desktopBootstrapSettingKey(deviceId),
        { connectionId, predecessorConnectionId, state: "provisional" },
        this.#now()
      );
      return created;
    });
    for (const revokedId of revokedIds) this.#notifyRevoked(revokedId);
    return { connection, authKey };
  }

  /** Mark the provisional bootstrap Connection committed after Desktop's ACK. */
  confirmTrustedDesktopConnection(connectionId: string, authKey: string): ConnectionRecord {
    const keyDigest = digestAuthKey(authKey);
    const connection = this.#store.findConnectionByAuthKeyDigest(keyDigest);
    if (connection === undefined || connection.id !== connectionId) throw managedDesktopAuthorizationUnavailable();
    const marker = readDesktopBootstrapMarker(this.#store.findSetting(
      "service", "orchestrator", desktopBootstrapSettingKey(connection.deviceId)
    )?.value);
    if (marker?.state !== "provisional" || marker.connectionId !== connectionId) {
      throw managedDesktopAuthorizationUnavailable();
    }
    try {
      return this.#store.transaction((store) => {
        const confirmed = store.authorizeConnection(connectionId, keyDigest, { touch: true, seenAt: this.#now() });
        store.setSetting<DesktopBootstrapMarker>(
          "service",
          "orchestrator",
          desktopBootstrapSettingKey(connection.deviceId),
          { connectionId, predecessorConnectionId: null, state: "committed" },
          this.#now()
        );
        return confirmed;
      });
    } catch {
      throw managedDesktopAuthorizationUnavailable();
    }
  }

  #validPreviousDesktopCredential(
    deviceId: string,
    connectionId: string,
    authKey: string,
    requireActive: boolean
  ): boolean {
    const digest = digestAuthKey(authKey);
    const matched = this.#store.findConnectionByAuthKeyDigest(digest);
    if (matched === undefined || matched.id !== connectionId || matched.deviceId !== deviceId ||
      (requireActive ? matched.state !== "active" : matched.state !== "revoked")) return false;
    if (!requireActive) return this.#store.getDevice(deviceId).state === "active";
    try {
      this.#store.authorizeConnection(connectionId, digest);
      return true;
    } catch {
      return false;
    }
  }

  authenticate(authorization: string | undefined): ConnectionRecord {
    const token = parseBearer(authorization);
    if (token === undefined) throw new ConnectionAuthenticationError("AUTH_REQUIRED", "Authentication is required.");
    const keyDigest = digestAuthKey(token);
    const connection = this.#store.findConnectionByAuthKeyDigest(keyDigest);
    if (connection === undefined) {
      throw new ConnectionAuthenticationError("AUTH_REVOKED", "The connection credential is invalid or revoked.");
    }
    try {
      return this.#store.authorizeConnection(connection.id, keyDigest, { touch: true, seenAt: this.#now() });
    } catch {
      throw new ConnectionAuthenticationError("AUTH_REVOKED", "The connection credential is invalid or revoked.");
    }
  }

  /** Pure, no-touch authorization fence used immediately before streaming output. */
  fence(connection: Pick<ConnectionRecord, "id" | "authKeyDigest">): ConnectionRecord {
    try {
      return this.#store.authorizeConnection(connection.id, connection.authKeyDigest);
    } catch {
      throw new ConnectionAuthenticationError("AUTH_REVOKED", "The connection credential is invalid or revoked.");
    }
  }

  onRevoked(connectionId: string, listener: () => void): () => void {
    const listeners = this.#revocationListeners.get(connectionId) ?? new Set<() => void>();
    listeners.add(listener);
    this.#revocationListeners.set(connectionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#revocationListeners.delete(connectionId);
    };
  }

  revoke(connectionId: string): ConnectionRecord {
    const connection = this.#store.revokeConnection(connectionId, undefined, this.#now());
    this.#notifyRevoked(connection.id);
    return connection;
  }

  /**
   * Revoke a requested Connection and authorize one future managed bootstrap
   * only when the authenticated caller logs out its own current committed
   * Desktop Connection. Logging out another Connection remains a plain revoke.
   */
  logout(connectionId: string, authenticatedConnectionId: string): ConnectionRecord {
    const connection = this.#store.transaction((store) => {
      const current = store.getConnection(connectionId);
      const marker = readDesktopBootstrapMarker(store.findSetting(
        "service", "orchestrator", desktopBootstrapSettingKey(current.deviceId)
      )?.value);
      const revoked = store.revokeConnection(connectionId, undefined, this.#now());
      if (current.state === "active" && connectionId === authenticatedConnectionId && marker?.state === "committed" &&
        marker.connectionId === connectionId && store.getDevice(current.deviceId).state === "active") {
        store.setSetting<DesktopBootstrapMarker>(
          "service",
          "orchestrator",
          desktopBootstrapSettingKey(current.deviceId),
          { connectionId, predecessorConnectionId: null, state: "loggedOut" },
          this.#now()
        );
      }
      return revoked;
    });
    this.#notifyRevoked(connection.id);
    return connection;
  }

  revokeDevice(deviceId: string, expectedRevision?: bigint): RevokedDeviceResult {
    const result = this.#store.revokeDevice(deviceId, expectedRevision, this.#now());
    for (const connection of result.connections) this.#notifyRevoked(connection.id);
    return result;
  }

  getDevice(deviceId: string): DeviceRecord {
    return this.#store.getDevice(deviceId);
  }

  #notifyRevoked(connectionId: string): void {
    const listeners = this.#revocationListeners.get(connectionId);
    if (listeners === undefined) return;
    this.#revocationListeners.delete(connectionId);
    for (const listener of listeners) listener();
  }
}

export class PairingRequestError extends Error {
  readonly code: "PAIRING_WINDOW_CLOSED" | "PAIRING_RATE_LIMITED" | "PAIRING_CAPACITY";

  constructor(code: PairingRequestError["code"], message: string) {
    super(message);
    this.name = "PairingRequestError";
    this.code = code;
  }
}

export class ConnectionAuthenticationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConnectionAuthenticationError";
    this.code = code;
  }
}

function invalidPairingError(): ConnectionAuthenticationError {
  return new ConnectionAuthenticationError(
    "PAIRING_INVALID",
    "The pairing code is invalid, expired, or already used."
  );
}

export function digestAuthKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestPairingCode(value: string): string {
  return createHash("sha256").update(normalizeCode(value), "utf8").digest("hex");
}

function formatCode(bytes: Buffer): string {
  const value = bytes.toString("base64url").toUpperCase().replace(/[-_]/gu, "A").slice(0, 8);
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function normalizeCode(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]/gu, "");
  return normalized.length === 8 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : value.trim().toUpperCase();
}

function parseBearer(value: string | undefined): string | undefined {
  return /^Bearer\s+([^\s]+)$/iu.exec(value ?? "")?.[1];
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.byteLength !== rightBuffer.byteLength) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function boundedDesktopInstanceId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw new Error("Desktop instance identity is invalid.");
  }
  return normalized;
}

function boundedDesktopText(value: string, maximumLength: number, label: string): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function desktopBootstrapSettingKey(deviceId: string): string {
  return `${DESKTOP_BOOTSTRAP_SETTING_PREFIX}${deviceId}`;
}

function readDesktopBootstrapMarker(value: unknown): DesktopBootstrapMarker | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "connectionId,predecessorConnectionId,state") return undefined;
  if (typeof record["connectionId"] !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(record["connectionId"])) return undefined;
  if (record["predecessorConnectionId"] !== null &&
    (typeof record["predecessorConnectionId"] !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(record["predecessorConnectionId"]))) return undefined;
  if (record["state"] !== "provisional" && record["state"] !== "committed" && record["state"] !== "loggedOut") return undefined;
  return record as unknown as DesktopBootstrapMarker;
}

function managedDesktopAuthorizationUnavailable(): ConnectionAuthenticationError {
  return new ConnectionAuthenticationError("AUTH_REVOKED", "Managed Desktop authorization is unavailable.");
}
