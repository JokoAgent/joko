import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const DESKTOP_BOOTSTRAP_PROTOCOL_VERSION = 1 as const;
export const DESKTOP_BOOTSTRAP_MAX_TTL_MS = 30_000;
export const DESKTOP_BOOTSTRAP_DEFAULT_TTL_MS = 15_000;
export const DESKTOP_BOOTSTRAP_MAX_FRAME_BYTES = 16 * 1024;

const REQUEST_KIND = "joko.desktop.bootstrap.request" as const;
const RESPONSE_KIND = "joko.desktop.bootstrap.response" as const;
const COMMIT_KIND = "joko.desktop.bootstrap.commit" as const;
const COMMITTED_KIND = "joko.desktop.bootstrap.committed" as const;
const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/iu;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;

export interface DesktopBootstrapRequest {
  readonly kind: typeof REQUEST_KIND;
  readonly protocolVersion: typeof DESKTOP_BOOTSTRAP_PROTOCOL_VERSION;
  readonly instanceId: string;
  readonly deviceId: string;
  readonly parentPid: number;
  readonly capability: string;
  readonly previousConnectionId: string | null;
  readonly previousAuthKey: string | null;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly deviceName: string;
  readonly platform: string;
  readonly appVersion: string;
}

export interface DesktopBootstrapResponse {
  readonly kind: typeof RESPONSE_KIND;
  readonly protocolVersion: typeof DESKTOP_BOOTSTRAP_PROTOCOL_VERSION;
  readonly instanceId: string;
  readonly deviceId: string;
  readonly parentPid: number;
  readonly serverId: string;
  readonly origin: string;
  readonly connectionId: string;
  readonly authKey: string;
  readonly issuedAt: number;
  readonly proof: string;
}

export interface DesktopBootstrapCommit {
  readonly kind: typeof COMMIT_KIND;
  readonly protocolVersion: typeof DESKTOP_BOOTSTRAP_PROTOCOL_VERSION;
  readonly instanceId: string;
  readonly deviceId: string;
  readonly parentPid: number;
  readonly connectionId: string;
  readonly responseProof: string;
  readonly issuedAt: number;
  readonly proof: string;
}

export interface DesktopBootstrapCommitted {
  readonly kind: typeof COMMITTED_KIND;
  readonly protocolVersion: typeof DESKTOP_BOOTSTRAP_PROTOCOL_VERSION;
  readonly instanceId: string;
  readonly deviceId: string;
  readonly parentPid: number;
  readonly connectionId: string;
  readonly responseProof: string;
  readonly committedAt: number;
  readonly proof: string;
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

export interface TrustedDesktopConnectionResult {
  readonly connection: { readonly id: string; readonly deviceId: string };
  readonly authKey: string;
}

interface DesktopBootstrapRequestDependencies {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly instanceIdFactory?: () => string;
}

/**
 * Create the capability sent from Desktop to its child Orchestrator over an
 * inherited anonymous pipe. Callers must never put the returned object in
 * argv, the environment, diagnostics, or logs.
 */
export function createDesktopBootstrapRequest(input: {
  readonly parentPid: number;
  readonly deviceName: string;
  readonly platform: string;
  readonly appVersion: string;
  readonly deviceId: string;
  readonly ttlMs?: number;
  readonly instanceId?: string;
  readonly previousConnection?: {
    readonly connectionId: string;
    readonly authKey: string;
  };
}, dependencies: DesktopBootstrapRequestDependencies = {}): DesktopBootstrapRequest {
  const now = dependencies.now?.() ?? Date.now();
  const ttlMs = input.ttlMs ?? DESKTOP_BOOTSTRAP_DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(now) || now < 0) throw invalidRequest();
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > DESKTOP_BOOTSTRAP_MAX_TTL_MS) {
    throw invalidRequest();
  }
  const random = dependencies.randomBytes?.(32) ?? randomBytes(32);
  if (random.byteLength !== 32) throw invalidRequest();
  const request: DesktopBootstrapRequest = {
    kind: REQUEST_KIND,
    protocolVersion: DESKTOP_BOOTSTRAP_PROTOCOL_VERSION,
    instanceId: input.instanceId ?? dependencies.instanceIdFactory?.() ?? randomUUID(),
    deviceId: input.deviceId,
    parentPid: input.parentPid,
    capability: Buffer.from(random).toString("base64url"),
    previousConnectionId: input.previousConnection?.connectionId ?? null,
    previousAuthKey: input.previousConnection?.authKey ?? null,
    issuedAt: now,
    expiresAt: now + ttlMs,
    deviceName: input.deviceName,
    platform: input.platform,
    appVersion: input.appVersion
  };
  return parseDesktopBootstrapRequest(request);
}

/**
 * A fail-closed, single-use grant. Its raw capability exists only in memory
 * until a response has been authenticated, then the local byte copy is wiped.
 */
export class DesktopBootstrapGrant {
  readonly request: Omit<DesktopBootstrapRequest, "capability" | "previousAuthKey">;
  readonly #now: () => number;
  #capability: Buffer | undefined;
  #previousAuthKey: Buffer | undefined;
  #commitKey: Buffer | undefined;
  #responseProof: string | undefined;
  #connectionId: string | undefined;
  #consumed = false;
  #committed = false;

  private constructor(request: DesktopBootstrapRequest, now: () => number) {
    this.request = {
      kind: request.kind,
      protocolVersion: request.protocolVersion,
      instanceId: request.instanceId,
      deviceId: request.deviceId,
      parentPid: request.parentPid,
      previousConnectionId: request.previousConnectionId,
      issuedAt: request.issuedAt,
      expiresAt: request.expiresAt,
      deviceName: request.deviceName,
      platform: request.platform,
      appVersion: request.appVersion
    };
    this.#now = now;
    this.#capability = decodeCapability(request.capability);
    this.#previousAuthKey = request.previousAuthKey === null ? undefined : decodeCapability(request.previousAuthKey);
  }

  static accept(value: unknown, options: {
    readonly expectedParentPid: number;
    readonly now?: () => number;
  }): DesktopBootstrapGrant {
    const request = parseDesktopBootstrapRequest(value);
    if (!validPid(options.expectedParentPid) || request.parentPid !== options.expectedParentPid) {
      throw invalidRequest();
    }
    const now = options.now ?? Date.now;
    validateLifetime(request, now());
    return new DesktopBootstrapGrant(request, now);
  }

  get consumed(): boolean {
    return this.#consumed;
  }

  get committed(): boolean {
    return this.#committed;
  }

  exchange(input: {
    readonly serverId: string;
    readonly origin: string;
    readonly issueConnection: (input: TrustedDesktopConnectionInput) => TrustedDesktopConnectionResult;
  }): DesktopBootstrapResponse {
    const now = this.#now();
    if (this.#consumed || this.#capability === undefined) throw unavailableGrant();
    if (!Number.isSafeInteger(now) || now < this.request.issuedAt || now >= this.request.expiresAt) {
      this.dispose();
      throw unavailableGrant();
    }
    const serverId = validatedServerId(input.serverId);
    const origin = validatedLoopbackOrigin(input.origin);

    // Burn before issuing durable authority. A failure cannot make this
    // capability reusable and accidentally mint a second credential.
    this.#consumed = true;
    const capability = this.#capability;
    this.#capability = undefined;
    try {
      const previousAuthKey = this.#previousAuthKey;
      this.#previousAuthKey = undefined;
      let result: TrustedDesktopConnectionResult;
      try {
        result = input.issueConnection({
          desktopInstanceId: this.request.instanceId,
          desktopDeviceId: this.request.deviceId,
          deviceName: this.request.deviceName,
          platform: this.request.platform,
          appVersion: this.request.appVersion,
          ...(this.request.previousConnectionId === null || previousAuthKey === undefined ? {} : {
            previousConnectionId: this.request.previousConnectionId,
            previousAuthKey: previousAuthKey.toString("base64url")
          })
        });
      } finally {
        previousAuthKey?.fill(0);
      }
      const unsigned = {
        kind: RESPONSE_KIND,
        protocolVersion: DESKTOP_BOOTSTRAP_PROTOCOL_VERSION,
        instanceId: this.request.instanceId,
        deviceId: validatedUuid(result.connection.deviceId),
        parentPid: this.request.parentPid,
        serverId,
        origin,
        connectionId: validatedOpaqueId(result.connection.id),
        authKey: validatedAuthKey(result.authKey),
        issuedAt: now
      } as const;
      const response = {
        ...unsigned,
        proof: createProof(capability, unsigned)
      };
      this.#commitKey = deriveCommitKey(capability, response.proof);
      this.#responseProof = response.proof;
      this.#connectionId = response.connectionId;
      return response;
    } finally {
      capability.fill(0);
    }
  }

  /**
   * Confirm that Desktop durably stored the Connection before Orchestrator becomes
   * an independent daemon. The response capability is reduced to a
   * domain-separated commit key, never retained in raw form after exchange.
   */
  confirmCommit(value: unknown): DesktopBootstrapCommitted {
    const commitKey = this.#commitKey;
    if (!this.#consumed || this.#committed || commitKey === undefined ||
      this.#responseProof === undefined || this.#connectionId === undefined) throw unavailableGrant();
    try {
      const now = this.#now();
      const commit = parseDesktopBootstrapCommit(value);
      if (!Number.isSafeInteger(now) || now < this.request.issuedAt || now >= this.request.expiresAt ||
        commit.instanceId !== this.request.instanceId || commit.deviceId !== this.request.deviceId ||
        commit.parentPid !== this.request.parentPid || commit.connectionId !== this.#connectionId ||
        commit.responseProof !== this.#responseProof || commit.issuedAt < this.request.issuedAt ||
        commit.issuedAt >= this.request.expiresAt || !safeProofEqual(
          createCommitProof(commitKey, unsignedCommit(commit)),
          commit.proof
        )) throw unavailableGrant();
      const unsigned = {
        kind: COMMITTED_KIND,
        protocolVersion: DESKTOP_BOOTSTRAP_PROTOCOL_VERSION,
        instanceId: this.request.instanceId,
        deviceId: this.request.deviceId,
        parentPid: this.request.parentPid,
        connectionId: this.#connectionId,
        responseProof: this.#responseProof,
        committedAt: now
      } as const;
      this.#committed = true;
      return { ...unsigned, proof: createCommitProof(commitKey, unsigned) };
    } finally {
      commitKey.fill(0);
      this.#commitKey = undefined;
      this.#responseProof = undefined;
      this.#connectionId = undefined;
    }
  }

  dispose(): void {
    this.#consumed = true;
    this.#capability?.fill(0);
    this.#capability = undefined;
    this.#previousAuthKey?.fill(0);
    this.#previousAuthKey = undefined;
    this.#commitKey?.fill(0);
    this.#commitKey = undefined;
    this.#responseProof = undefined;
    this.#connectionId = undefined;
  }
}

/** Verify child identity and response integrity before putting the Auth Key in safeStorage. */
export function verifyDesktopBootstrapResponse(
  requestValue: unknown,
  responseValue: unknown,
  options: { readonly now?: () => number } = {}
): DesktopBootstrapResponse {
  const request = parseDesktopBootstrapRequest(requestValue);
  const response = parseDesktopBootstrapResponse(responseValue);
  const now = options.now?.() ?? Date.now();
  validateLifetime(request, now);
  if (
    response.instanceId !== request.instanceId ||
    response.deviceId !== request.deviceId ||
    response.parentPid !== request.parentPid ||
    response.issuedAt < request.issuedAt ||
    response.issuedAt >= request.expiresAt
  ) throw invalidResponse();
  const capability = decodeCapability(request.capability);
  try {
    const expected = Buffer.from(createProof(capability, unsignedResponse(response)), "base64url");
    const actual = Buffer.from(response.proof, "base64url");
    if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) throw invalidResponse();
  } finally {
    capability.fill(0);
  }
  return response;
}

/** Create the parent commit only after credential and metadata persistence. */
export function createDesktopBootstrapCommit(
  requestValue: unknown,
  responseValue: unknown,
  options: { readonly now?: () => number } = {}
): DesktopBootstrapCommit {
  const now = options.now?.() ?? Date.now();
  const request = parseDesktopBootstrapRequest(requestValue);
  const response = verifyDesktopBootstrapResponse(request, responseValue, { now: () => now });
  const capability = decodeCapability(request.capability);
  const commitKey = deriveCommitKey(capability, response.proof);
  capability.fill(0);
  try {
    const unsigned = {
      kind: COMMIT_KIND,
      protocolVersion: DESKTOP_BOOTSTRAP_PROTOCOL_VERSION,
      instanceId: request.instanceId,
      deviceId: request.deviceId,
      parentPid: request.parentPid,
      connectionId: response.connectionId,
      responseProof: response.proof,
      issuedAt: now
    } as const;
    return { ...unsigned, proof: createCommitProof(commitKey, unsigned) };
  } finally {
    commitKey.fill(0);
  }
}

export function verifyDesktopBootstrapCommitted(
  requestValue: unknown,
  responseValue: unknown,
  committedValue: unknown,
  options: { readonly now?: () => number } = {}
): DesktopBootstrapCommitted {
  const now = options.now?.() ?? Date.now();
  const request = parseDesktopBootstrapRequest(requestValue);
  const response = verifyDesktopBootstrapResponse(request, responseValue, { now: () => now });
  const committed = parseDesktopBootstrapCommitted(committedValue);
  if (committed.instanceId !== request.instanceId || committed.deviceId !== request.deviceId ||
    committed.parentPid !== request.parentPid || committed.connectionId !== response.connectionId ||
    committed.responseProof !== response.proof || committed.committedAt < request.issuedAt ||
    committed.committedAt >= request.expiresAt) throw invalidResponse();
  const capability = decodeCapability(request.capability);
  const commitKey = deriveCommitKey(capability, response.proof);
  capability.fill(0);
  try {
    if (!safeProofEqual(createCommitProof(commitKey, unsignedCommitted(committed)), committed.proof)) {
      throw invalidResponse();
    }
  } finally {
    commitKey.fill(0);
  }
  return committed;
}

export function encodeDesktopBootstrapRequestFrame(value: DesktopBootstrapRequest): Uint8Array {
  const request = parseDesktopBootstrapRequest(value);
  return frameJson({
    kind: request.kind,
    protocolVersion: request.protocolVersion,
    instanceId: request.instanceId,
    deviceId: request.deviceId,
    parentPid: request.parentPid,
    capability: request.capability,
    previousConnectionId: request.previousConnectionId,
    previousAuthKey: request.previousAuthKey,
    issuedAt: request.issuedAt,
    expiresAt: request.expiresAt,
    deviceName: request.deviceName,
    platform: request.platform,
    appVersion: request.appVersion
  });
}

export function encodeDesktopBootstrapResponseFrame(value: DesktopBootstrapResponse): Uint8Array {
  const response = parseDesktopBootstrapResponse(value);
  return frameJson({
    kind: response.kind,
    protocolVersion: response.protocolVersion,
    instanceId: response.instanceId,
    deviceId: response.deviceId,
    parentPid: response.parentPid,
    serverId: response.serverId,
    origin: response.origin,
    connectionId: response.connectionId,
    authKey: response.authKey,
    issuedAt: response.issuedAt,
    proof: response.proof
  });
}

export function encodeDesktopBootstrapCommitFrame(value: DesktopBootstrapCommit): Uint8Array {
  const commit = parseDesktopBootstrapCommit(value);
  return frameJson(unsignedCommitWithProof(commit));
}

export function encodeDesktopBootstrapCommittedFrame(value: DesktopBootstrapCommitted): Uint8Array {
  const committed = parseDesktopBootstrapCommitted(value);
  return frameJson(unsignedCommittedWithProof(committed));
}

export function decodeDesktopBootstrapRequestPayload(payload: Uint8Array): DesktopBootstrapRequest {
  return parseDesktopBootstrapRequest(parseJsonPayload(payload));
}

export function decodeDesktopBootstrapResponsePayload(payload: Uint8Array): DesktopBootstrapResponse {
  return parseDesktopBootstrapResponse(parseJsonPayload(payload));
}

export function decodeDesktopBootstrapCommitPayload(payload: Uint8Array): DesktopBootstrapCommit {
  return parseDesktopBootstrapCommit(parseJsonPayload(payload));
}

export function decodeDesktopBootstrapCommittedPayload(payload: Uint8Array): DesktopBootstrapCommitted {
  return parseDesktopBootstrapCommitted(parseJsonPayload(payload));
}

/** Incremental decoder for exactly one bounded, four-byte-length-prefixed frame. */
export class DesktopBootstrapFrameDecoder {
  #pending = Buffer.alloc(0);
  #expectedLength: number | undefined;
  #delivered = false;

  push(chunk: Uint8Array): readonly Uint8Array[] {
    if (chunk.byteLength === 0) return [];
    if (this.#delivered) throw invalidFrame();
    if (this.#pending.byteLength + chunk.byteLength > DESKTOP_BOOTSTRAP_MAX_FRAME_BYTES + 4) {
      throw invalidFrame();
    }
    this.#pending = Buffer.concat([this.#pending, Buffer.from(chunk)]);
    if (this.#expectedLength === undefined && this.#pending.byteLength >= 4) {
      const length = this.#pending.readUInt32BE(0);
      if (length < 2 || length > DESKTOP_BOOTSTRAP_MAX_FRAME_BYTES) throw invalidFrame();
      this.#expectedLength = length;
    }
    if (this.#expectedLength === undefined || this.#pending.byteLength < this.#expectedLength + 4) return [];
    if (this.#pending.byteLength !== this.#expectedLength + 4) throw invalidFrame();
    const payload = Uint8Array.from(this.#pending.subarray(4));
    this.#pending.fill(0);
    this.#pending = Buffer.alloc(0);
    this.#delivered = true;
    return [payload];
  }

  finish(): void {
    if (!this.#delivered || this.#pending.byteLength !== 0) throw invalidFrame();
  }
}

export function parseDesktopBootstrapRequest(value: unknown): DesktopBootstrapRequest {
  if (!isExactRecord(value, [
    "kind", "protocolVersion", "instanceId", "deviceId", "parentPid", "capability", "previousConnectionId",
    "previousAuthKey", "issuedAt", "expiresAt",
    "deviceName", "platform", "appVersion"
  ])) throw invalidRequest();
  if (
    value["kind"] !== REQUEST_KIND ||
    value["protocolVersion"] !== DESKTOP_BOOTSTRAP_PROTOCOL_VERSION ||
    typeof value["instanceId"] !== "string" || !INSTANCE_ID_PATTERN.test(value["instanceId"]) ||
    typeof value["deviceId"] !== "string" || !INSTANCE_ID_PATTERN.test(value["deviceId"]) ||
    !validPid(value["parentPid"]) ||
    typeof value["capability"] !== "string" || !BASE64URL_256_PATTERN.test(value["capability"]) ||
    !validOptionalPreviousConnection(value["previousConnectionId"], value["previousAuthKey"]) ||
    !validTimestamp(value["issuedAt"]) ||
    !validTimestamp(value["expiresAt"]) ||
    typeof value["deviceName"] !== "string" || !validBoundedText(value["deviceName"], 128) ||
    typeof value["platform"] !== "string" || !validBoundedText(value["platform"], 64) ||
    typeof value["appVersion"] !== "string" || !validBoundedText(value["appVersion"], 64)
  ) throw invalidRequest();
  if (
    value["expiresAt"] <= value["issuedAt"] ||
    value["expiresAt"] - value["issuedAt"] > DESKTOP_BOOTSTRAP_MAX_TTL_MS
  ) throw invalidRequest();
  decodeCapability(value["capability"]).fill(0);
  if (typeof value["previousAuthKey"] === "string") decodeCapability(value["previousAuthKey"]).fill(0);
  return value as unknown as DesktopBootstrapRequest;
}

export function parseDesktopBootstrapResponse(value: unknown): DesktopBootstrapResponse {
  if (!isExactRecord(value, [
    "kind", "protocolVersion", "instanceId", "deviceId", "parentPid", "serverId", "origin", "connectionId",
    "authKey", "issuedAt", "proof"
  ])) throw invalidResponse();
  if (
    value["kind"] !== RESPONSE_KIND ||
    value["protocolVersion"] !== DESKTOP_BOOTSTRAP_PROTOCOL_VERSION ||
    typeof value["instanceId"] !== "string" || !INSTANCE_ID_PATTERN.test(value["instanceId"]) ||
    typeof value["deviceId"] !== "string" || !INSTANCE_ID_PATTERN.test(value["deviceId"]) ||
    !validPid(value["parentPid"]) ||
    typeof value["serverId"] !== "string" || validatedServerId(value["serverId"]) !== value["serverId"] ||
    typeof value["origin"] !== "string" || validatedLoopbackOrigin(value["origin"]) !== value["origin"] ||
    typeof value["connectionId"] !== "string" || validatedOpaqueId(value["connectionId"]) !== value["connectionId"] ||
    typeof value["authKey"] !== "string" || validatedAuthKey(value["authKey"]) !== value["authKey"] ||
    !validTimestamp(value["issuedAt"]) ||
    typeof value["proof"] !== "string" || !BASE64URL_256_PATTERN.test(value["proof"])
  ) throw invalidResponse();
  return value as unknown as DesktopBootstrapResponse;
}

export function parseDesktopBootstrapCommit(value: unknown): DesktopBootstrapCommit {
  if (!isExactRecord(value, [
    "kind", "protocolVersion", "instanceId", "deviceId", "parentPid", "connectionId", "responseProof",
    "issuedAt", "proof"
  ])) throw invalidRequest();
  if (
    value["kind"] !== COMMIT_KIND ||
    value["protocolVersion"] !== DESKTOP_BOOTSTRAP_PROTOCOL_VERSION ||
    typeof value["instanceId"] !== "string" || !INSTANCE_ID_PATTERN.test(value["instanceId"]) ||
    typeof value["deviceId"] !== "string" || !INSTANCE_ID_PATTERN.test(value["deviceId"]) ||
    !validPid(value["parentPid"]) ||
    typeof value["connectionId"] !== "string" || validatedOpaqueId(value["connectionId"]) !== value["connectionId"] ||
    typeof value["responseProof"] !== "string" || !BASE64URL_256_PATTERN.test(value["responseProof"]) ||
    !validTimestamp(value["issuedAt"]) ||
    typeof value["proof"] !== "string" || !BASE64URL_256_PATTERN.test(value["proof"])
  ) throw invalidRequest();
  return value as unknown as DesktopBootstrapCommit;
}

export function parseDesktopBootstrapCommitted(value: unknown): DesktopBootstrapCommitted {
  if (!isExactRecord(value, [
    "kind", "protocolVersion", "instanceId", "deviceId", "parentPid", "connectionId", "responseProof",
    "committedAt", "proof"
  ])) throw invalidResponse();
  if (
    value["kind"] !== COMMITTED_KIND ||
    value["protocolVersion"] !== DESKTOP_BOOTSTRAP_PROTOCOL_VERSION ||
    typeof value["instanceId"] !== "string" || !INSTANCE_ID_PATTERN.test(value["instanceId"]) ||
    typeof value["deviceId"] !== "string" || !INSTANCE_ID_PATTERN.test(value["deviceId"]) ||
    !validPid(value["parentPid"]) ||
    typeof value["connectionId"] !== "string" || validatedOpaqueId(value["connectionId"]) !== value["connectionId"] ||
    typeof value["responseProof"] !== "string" || !BASE64URL_256_PATTERN.test(value["responseProof"]) ||
    !validTimestamp(value["committedAt"]) ||
    typeof value["proof"] !== "string" || !BASE64URL_256_PATTERN.test(value["proof"])
  ) throw invalidResponse();
  return value as unknown as DesktopBootstrapCommitted;
}

function frameJson(value: object): Uint8Array {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength < 2 || payload.byteLength > DESKTOP_BOOTSTRAP_MAX_FRAME_BYTES) throw invalidFrame();
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  payload.fill(0);
  return frame;
}

function parseJsonPayload(payload: Uint8Array): unknown {
  if (payload.byteLength < 2 || payload.byteLength > DESKTOP_BOOTSTRAP_MAX_FRAME_BYTES) throw invalidFrame();
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown;
  } catch {
    throw invalidFrame();
  }
}

function createProof(
  capability: Uint8Array,
  response: Omit<DesktopBootstrapResponse, "proof">
): string {
  return createHmac("sha256", capability).update(JSON.stringify(response), "utf8").digest("base64url");
}

function unsignedResponse(response: DesktopBootstrapResponse): Omit<DesktopBootstrapResponse, "proof"> {
  return {
    kind: response.kind,
    protocolVersion: response.protocolVersion,
    instanceId: response.instanceId,
    deviceId: response.deviceId,
    parentPid: response.parentPid,
    serverId: response.serverId,
    origin: response.origin,
    connectionId: response.connectionId,
    authKey: response.authKey,
    issuedAt: response.issuedAt
  };
}

function unsignedCommit(commit: DesktopBootstrapCommit): Omit<DesktopBootstrapCommit, "proof"> {
  return {
    kind: commit.kind,
    protocolVersion: commit.protocolVersion,
    instanceId: commit.instanceId,
    deviceId: commit.deviceId,
    parentPid: commit.parentPid,
    connectionId: commit.connectionId,
    responseProof: commit.responseProof,
    issuedAt: commit.issuedAt
  };
}

function unsignedCommitWithProof(commit: DesktopBootstrapCommit): DesktopBootstrapCommit {
  return { ...unsignedCommit(commit), proof: commit.proof };
}

function unsignedCommitted(committed: DesktopBootstrapCommitted): Omit<DesktopBootstrapCommitted, "proof"> {
  return {
    kind: committed.kind,
    protocolVersion: committed.protocolVersion,
    instanceId: committed.instanceId,
    deviceId: committed.deviceId,
    parentPid: committed.parentPid,
    connectionId: committed.connectionId,
    responseProof: committed.responseProof,
    committedAt: committed.committedAt
  };
}

function unsignedCommittedWithProof(committed: DesktopBootstrapCommitted): DesktopBootstrapCommitted {
  return { ...unsignedCommitted(committed), proof: committed.proof };
}

function deriveCommitKey(capability: Uint8Array, responseProof: string): Buffer {
  return createHmac("sha256", capability)
    .update("joko.desktop.bootstrap.commit\0", "utf8")
    .update(responseProof, "utf8")
    .digest();
}

function createCommitProof(
  commitKey: Uint8Array,
  value: Omit<DesktopBootstrapCommit, "proof"> | Omit<DesktopBootstrapCommitted, "proof">
): string {
  return createHmac("sha256", commitKey).update(JSON.stringify(value), "utf8").digest("base64url");
}

function safeProofEqual(expectedValue: string, actualValue: string): boolean {
  if (!BASE64URL_256_PATTERN.test(expectedValue) || !BASE64URL_256_PATTERN.test(actualValue)) return false;
  const expected = Buffer.from(expectedValue, "base64url");
  const actual = Buffer.from(actualValue, "base64url");
  try {
    return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
  } finally {
    expected.fill(0);
    actual.fill(0);
  }
}

function validateLifetime(request: DesktopBootstrapRequest, now: number): void {
  if (
    !Number.isSafeInteger(now) ||
    now < request.issuedAt ||
    now >= request.expiresAt ||
    request.expiresAt - request.issuedAt > DESKTOP_BOOTSTRAP_MAX_TTL_MS
  ) throw unavailableGrant();
}

function decodeCapability(value: string): Buffer {
  if (!BASE64URL_256_PATTERN.test(value)) throw invalidRequest();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    throw invalidRequest();
  }
  return decoded;
}

function validatedServerId(value: string): string {
  if (!SERVER_ID_PATTERN.test(value)) throw invalidResponse();
  return value;
}

function validatedOpaqueId(value: string): string {
  if (!OPAQUE_ID_PATTERN.test(value)) throw invalidResponse();
  return value;
}

function validatedUuid(value: string): string {
  if (!INSTANCE_ID_PATTERN.test(value)) throw invalidResponse();
  return value;
}

function validatedAuthKey(value: string): string {
  if (!BASE64URL_256_PATTERN.test(value)) throw invalidResponse();
  const bytes = Buffer.from(value, "base64url");
  const valid = bytes.byteLength === 32 && bytes.toString("base64url") === value;
  bytes.fill(0);
  if (!valid) throw invalidResponse();
  return value;
}

function validatedLoopbackOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidResponse();
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const loopback = hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.") ||
    hostname === "::ffff:127.0.0.1";
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !loopback || parsed.username !== "" || parsed.password !== "" ||
    value !== parsed.origin
  ) throw invalidResponse();
  return parsed.origin;
}

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validOptionalPreviousConnection(connectionId: unknown, authKey: unknown): boolean {
  if (connectionId === null || authKey === null) return connectionId === null && authKey === null;
  if (typeof connectionId !== "string" || !OPAQUE_ID_PATTERN.test(connectionId) ||
    typeof authKey !== "string" || !BASE64URL_256_PATTERN.test(authKey)) return false;
  const bytes = Buffer.from(authKey, "base64url");
  const valid = bytes.byteLength === 32 && bytes.toString("base64url") === authKey;
  bytes.fill(0);
  return valid;
}

function validBoundedText(value: string, maximumLength: number): boolean {
  return value.trim() === value && value.length > 0 && value.length <= maximumLength && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalidRequest(): Error {
  return new Error("The Desktop bootstrap request is invalid.");
}

function invalidResponse(): Error {
  return new Error("The Desktop bootstrap response is invalid.");
}

function unavailableGrant(): Error {
  return new Error("The Desktop bootstrap grant is unavailable.");
}

function invalidFrame(): Error {
  return new Error("The Desktop bootstrap pipe frame is invalid.");
}
