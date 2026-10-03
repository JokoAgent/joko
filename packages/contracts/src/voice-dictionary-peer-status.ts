import {
  VoiceInputDictionaryPeerErrorCode,
  VoiceInputDictionaryPeerPhase,
  type VoiceInputDictionaryPeerStatus
} from "./gen/joko/v1/voice_pb.js";

export interface VoiceDictionaryPeerEndpoint { readonly host: string; readonly port: number; }
export interface VoiceDictionaryPeerListener extends VoiceDictionaryPeerEndpoint { readonly listenPort: number; }
export interface VoiceDictionaryPeerInvitation extends VoiceDictionaryPeerEndpoint {
  readonly version: 1; readonly nodeId: string; readonly displayName: string; readonly publicKey: string; readonly fingerprint: string;
}

/** Public invitation preview. The receiving service additionally verifies the key and its hash. */
export function readVoiceDictionaryPeerInvitation(raw: string): VoiceDictionaryPeerInvitation {
  if (typeof raw !== "string" || raw.length > 4_096) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw invalid(); }
  const value = exactRecord(parsed, ["version", "nodeId", "displayName", "publicKey", "fingerprint", "host", "port"]);
  if (value.version !== 1 || typeof value.publicKey !== "string" || !/^MCowBQYDK2VuAyEA[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/u.test(value.publicKey)) throw invalid();
  return Object.freeze({ version: 1, nodeId: identity(value.nodeId), displayName: displayName(value.displayName), publicKey: value.publicKey,
    fingerprint: fingerprint(value.fingerprint), host: endpointHost(value.host), port: endpointPort(value.port) });
}

export function readVoiceDictionaryPeerEndpoint(raw: unknown): VoiceDictionaryPeerEndpoint {
  const value = exactRecord(raw, ["host", "port"]);
  return Object.freeze({ host: endpointHost(value.host), port: endpointPort(value.port) });
}

export function readVoiceDictionaryPeerListener(raw: unknown): VoiceDictionaryPeerListener {
  const value = exactRecord(raw, ["listenPort", "host", "port"]);
  return Object.freeze({ listenPort: endpointPort(value.listenPort), host: endpointHost(value.host), port: endpointPort(value.port) });
}

export interface VoiceDictionaryPeerStatusView {
  readonly available: boolean;
  readonly configurationRevision: bigint;
  readonly nodeId: string;
  readonly fingerprint: string;
  readonly enabled: boolean;
  readonly phase: "off" | "waiting" | "syncing" | "up_to_date" | "error";
  readonly errorCode?: "identity_unavailable" | "dictionary_unavailable" | "sync_failed";
  readonly listener?: VoiceDictionaryPeerListener;
  readonly peers: readonly {
    readonly peerId: string; readonly revision: bigint; readonly displayName: string;
    readonly fingerprint: string; readonly online: boolean; readonly grantedAt: number; readonly lastSyncAt?: number;
    readonly route?: VoiceDictionaryPeerEndpoint;
  }[];
  readonly candidates: readonly {
    readonly nodeId: string; readonly displayName: string; readonly fingerprint: string;
    readonly seenAt: number; readonly granted: boolean; readonly keyChanged: boolean;
  }[];
}

export interface VoiceDictionaryPeerApi {
  getVoiceInputDictionaryPeerStatus(signal?: AbortSignal): Promise<VoiceDictionaryPeerStatusView>;
  watchVoiceInputDictionaryPeerStatus(signal: AbortSignal): AsyncIterable<VoiceDictionaryPeerStatusView>;
  grantVoiceInputDictionaryPeer(expectedConfigurationRevision: bigint, peerId: string, expectedFingerprint: string, signal?: AbortSignal): Promise<VoiceDictionaryPeerStatusView>;
  revokeVoiceInputDictionaryPeer(peerId: string, expectedGrantRevision: bigint, signal?: AbortSignal): Promise<VoiceDictionaryPeerStatusView>;
  syncVoiceInputDictionaryNow(expectedConfigurationRevision: bigint, peerId?: string, signal?: AbortSignal): Promise<VoiceDictionaryPeerStatusView>;
  configureVoiceInputDictionaryListener(expectedConfigurationRevision: bigint, listener: VoiceDictionaryPeerListener | undefined, signal?: AbortSignal): Promise<VoiceDictionaryPeerStatusView>;
  getVoiceInputDictionaryPeerInvitation(signal?: AbortSignal): Promise<string>;
  grantVoiceInputDictionaryDirectPeer(expectedConfigurationRevision: bigint, invitation: string, expectedFingerprint: string, signal?: AbortSignal): Promise<VoiceDictionaryPeerStatusView>;
  clearVoiceInputDictionaryPeerRoute(expectedConfigurationRevision: bigint, peerId: string, signal?: AbortSignal): Promise<VoiceDictionaryPeerStatusView>;
}

/** Every new stream occurrence starts at one and rejects duplicate, gap or unsafe sequence. */
export function nextVoiceDictionaryWatchSequence(value: bigint, previous: bigint): bigint {
  if (value !== previous + 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
  return value;
}

/** Shared strict client projection; only explicitly configured public endpoints cross this boundary. */
export function projectVoiceDictionaryPeerStatus(value: VoiceInputDictionaryPeerStatus | undefined): VoiceDictionaryPeerStatusView {
  if (!value || value.peers.length > 128 || value.candidates.length > 256) throw invalid();
  const phases = new Map<number, VoiceDictionaryPeerStatusView["phase"]>([
    [VoiceInputDictionaryPeerPhase.OFF, "off"], [VoiceInputDictionaryPeerPhase.WAITING, "waiting"],
    [VoiceInputDictionaryPeerPhase.SYNCING, "syncing"], [VoiceInputDictionaryPeerPhase.UP_TO_DATE, "up_to_date"],
    [VoiceInputDictionaryPeerPhase.ERROR, "error"]
  ] as const);
  const errors = new Map<number, NonNullable<VoiceDictionaryPeerStatusView["errorCode"]>>([
    [VoiceInputDictionaryPeerErrorCode.IDENTITY_UNAVAILABLE, "identity_unavailable"],
    [VoiceInputDictionaryPeerErrorCode.DICTIONARY_UNAVAILABLE, "dictionary_unavailable"],
    [VoiceInputDictionaryPeerErrorCode.SYNC_FAILED, "sync_failed"]
  ] as const);
  const phase = phases.get(value.phase);
  const errorCode = value.errorCode === undefined ? undefined : errors.get(value.errorCode);
  if (!phase || (value.errorCode !== undefined && !errorCode) || (phase === "off") !== !value.enabled ||
    (value.enabled && (phase === "error") !== (errorCode !== undefined)) ||
    (value.available && !isFingerprint(value.fingerprint)) || (!value.available && value.fingerprint !== "" && !isFingerprint(value.fingerprint))) throw invalid();
  const nodeId = identity(value.nodeId);
  const configurationRevision = revision(value.configurationRevision);
  const peers = value.peers.map((peer) => {
    const grantRevision = revision(peer.revision);
    const grantedAt = timestamp(peer.grantedAt);
    const lastSyncAt = peer.lastSyncAt === undefined ? undefined : timestamp(peer.lastSyncAt);
    if (grantRevision > configurationRevision || (lastSyncAt !== undefined && lastSyncAt < grantedAt)) throw invalid();
    return Object.freeze({ peerId: identity(peer.peerId), revision: grantRevision, displayName: displayName(peer.displayName),
      fingerprint: fingerprint(peer.fingerprint), online: peer.online, grantedAt, ...(lastSyncAt === undefined ? {} : { lastSyncAt }),
      ...(peer.route === undefined ? {} : { route: readVoiceDictionaryPeerEndpoint({ host: peer.route.host, port: peer.route.port }) }) });
  });
  unique(peers.map((peer) => peer.peerId));
  unique(peers.map((peer) => peer.fingerprint));
  if (peers.some((peer) => peer.peerId === nodeId || peer.fingerprint === value.fingerprint)) throw invalid();
  const candidates = value.candidates.map((candidate) => {
    const candidateId = identity(candidate.nodeId);
    const candidateFingerprint = fingerprint(candidate.fingerprint);
    const peer = peers.find((entry) => entry.peerId === candidateId);
    if (candidateId === nodeId || candidate.granted !== (peer?.fingerprint === candidateFingerprint) ||
      candidate.keyChanged !== (peer !== undefined && peer.fingerprint !== candidateFingerprint)) throw invalid();
    return Object.freeze({ nodeId: candidateId, displayName: displayName(candidate.displayName), fingerprint: candidateFingerprint,
      seenAt: timestamp(candidate.seenAt), granted: candidate.granted, keyChanged: candidate.keyChanged });
  });
  unique(candidates.map((candidate) => candidate.nodeId));
  if (phase === "up_to_date" && !peers.some((peer) => peer.online && peer.lastSyncAt !== undefined)) throw invalid();
  return Object.freeze({ available: value.available, configurationRevision, nodeId, fingerprint: value.fingerprint,
    enabled: value.enabled, phase, ...(errorCode === undefined ? {} : { errorCode }), peers: Object.freeze(peers), candidates: Object.freeze(candidates),
    ...(value.listener === undefined ? {} : { listener: readVoiceDictionaryPeerListener({ listenPort: value.listener.listenPort, host: value.listener.host, port: value.listener.port }) }) });
}

function revision(value: bigint): bigint {
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
  return value;
}
function timestamp(value: { seconds: bigint; nanos: number } | undefined): number {
  if (!value || value.seconds < 0n || value.seconds > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) ||
    !Number.isSafeInteger(value.nanos) || value.nanos < 0 || value.nanos >= 1_000_000_000 || value.nanos % 1_000_000 !== 0) throw invalid();
  const result = Number(value.seconds) * 1_000 + value.nanos / 1_000_000;
  if (!Number.isSafeInteger(result)) throw invalid();
  return result;
}
function identity(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) throw invalid(); return value; }
function displayName(value: unknown): string { if (typeof value !== "string" || !value || value !== value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid(); return value; }
function isFingerprint(value: string): boolean { return /^[a-f0-9]{64}$/u.test(value); }
function fingerprint(value: unknown): string { if (typeof value !== "string" || !isFingerprint(value)) throw invalid(); return value; }
function exactRecord(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== keys.length || keys.some((key) => !Object.hasOwn(raw, key))) throw invalid();
  return raw as Record<string, unknown>;
}
function endpointPort(raw: unknown): number { if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > 65_535) throw invalid(); return raw; }
function endpointHost(raw: unknown): string {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 253 || raw !== raw.trim() || /[^A-Za-z0-9.:-]/u.test(raw)) throw invalid();
  if (raw.includes(":")) {
    try { if (!new URL(`http://[${raw}]/`).hostname.startsWith("[")) throw invalid(); } catch { throw invalid(); }
  } else {
    if (raw.split(".").some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label))) throw invalid();
    if (/^[0-9.]+$/u.test(raw) && (raw.split(".").length !== 4 || raw.split(".").some((part) => !/^(0|[1-9][0-9]{0,2})$/u.test(part) || Number(part) > 255))) throw invalid();
  }
  return raw;
}
function unique(values: readonly string[]): void { if (new Set(values).size !== values.length) throw invalid(); }
function invalid(): Error { return new Error("The dictionary peer status is invalid."); }
