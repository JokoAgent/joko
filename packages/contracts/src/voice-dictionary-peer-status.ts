import {
  VoiceInputDictionaryPeerErrorCode,
  VoiceInputDictionaryPeerPhase,
  type VoiceInputDictionaryPeerStatus
} from "./gen/joko/v1/voice_pb.js";

export interface VoiceDictionaryPeerStatusView {
  readonly available: boolean;
  readonly configurationRevision: bigint;
  readonly nodeId: string;
  readonly fingerprint: string;
  readonly enabled: boolean;
  readonly phase: "off" | "waiting" | "syncing" | "up_to_date" | "error";
  readonly errorCode?: "identity_unavailable" | "dictionary_unavailable" | "sync_failed";
  readonly peers: readonly {
    readonly peerId: string; readonly revision: bigint; readonly displayName: string;
    readonly fingerprint: string; readonly online: boolean; readonly grantedAt: number; readonly lastSyncAt?: number;
  }[];
  readonly candidates: readonly {
    readonly nodeId: string; readonly displayName: string; readonly fingerprint: string;
    readonly seenAt: number; readonly granted: boolean; readonly keyChanged: boolean;
  }[];
}

export interface VoiceDictionaryPeerApi {
  getVoiceInputDictionaryPeerStatus(signal?: AbortSignal): Promise<VoiceDictionaryPeerStatusView>;
  grantVoiceInputDictionaryPeer(expectedConfigurationRevision: bigint, peerId: string, expectedFingerprint: string, signal?: AbortSignal): Promise<VoiceDictionaryPeerStatusView>;
  revokeVoiceInputDictionaryPeer(peerId: string, expectedGrantRevision: bigint, signal?: AbortSignal): Promise<VoiceDictionaryPeerStatusView>;
  syncVoiceInputDictionaryNow(expectedConfigurationRevision: bigint, peerId?: string, signal?: AbortSignal): Promise<VoiceDictionaryPeerStatusView>;
}

/** Shared strict client projection; no key, route or convergence state is exposed. */
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
      fingerprint: fingerprint(peer.fingerprint), online: peer.online, grantedAt, ...(lastSyncAt === undefined ? {} : { lastSyncAt }) });
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
    enabled: value.enabled, phase, ...(errorCode === undefined ? {} : { errorCode }), peers: Object.freeze(peers), candidates: Object.freeze(candidates) });
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
function identity(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) throw invalid(); return value; }
function displayName(value: string): string { if (!value || value !== value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid(); return value; }
function isFingerprint(value: string): boolean { return /^[a-f0-9]{64}$/u.test(value); }
function fingerprint(value: string): string { if (!isFingerprint(value)) throw invalid(); return value; }
function unique(values: readonly string[]): void { if (new Set(values).size !== values.length) throw invalid(); }
function invalid(): Error { return new Error("The dictionary peer status is invalid."); }
