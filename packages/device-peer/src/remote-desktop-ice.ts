/** One bounded ICE candidate exchanged for an active remote-desktop media attempt. */
export interface RemoteDesktopIceCandidate {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
  readonly usernameFragment?: string;
}

export interface RemoteDesktopIceRequest {
  readonly op: "ice";
  readonly lease: string;
  readonly attemptId: string;
  readonly candidates: readonly RemoteDesktopIceCandidate[];
  readonly after: number;
}

export interface RemoteDesktopIceReply {
  readonly attemptId: string;
  readonly candidates: readonly RemoteDesktopIceCandidate[];
  readonly next: number;
  readonly complete: boolean;
}

/** Public STUN fallback only. Configured short-lived TURN credentials are resolved per attempt. */
export const REMOTE_DESKTOP_STUN_SERVERS = Object.freeze([
  Object.freeze({ urls: "stun:stun.cloudflare.com:3478" }),
  Object.freeze({ urls: "stun:stun.l.google.com:19302" })
]);

/** Sequential capture stages plus transport delivery headroom. */
export const REMOTE_DESKTOP_OFFER_BUDGET = Object.freeze({
  captureReadyMs: 10_000,
  sourcesMs: 5_000,
  hostMs: 18_000
});

export const REMOTE_DESKTOP_INVOKE_MS = REMOTE_DESKTOP_OFFER_BUDGET.captureReadyMs
  + REMOTE_DESKTOP_OFFER_BUDGET.sourcesMs
  + REMOTE_DESKTOP_OFFER_BUDGET.hostMs
  + 5_000;

export const REMOTE_DESKTOP_NETWORK = Object.freeze({
  maxCandidates: 128,
  batchSize: 16,
  pollMs: 250,
  exchangeMs: 30_000,
  disconnectedMs: 5_000,
  answerMs: REMOTE_DESKTOP_INVOKE_MS + 2_000,
  connectMs: 15_000,
  legacyGatherMs: 5_000,
  stableMs: 30_000,
  retryMs: Object.freeze([1_000, 3_000, 8_000] as const)
});

export function isRemoteDesktopAttemptId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
}

export function isRemoteDesktopIceCursor(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= REMOTE_DESKTOP_NETWORK.maxCandidates;
}

export function parseRemoteDesktopIceCandidates(value: unknown): readonly RemoteDesktopIceCandidate[] {
  if (!Array.isArray(value) || value.length > REMOTE_DESKTOP_NETWORK.batchSize) {
    throw new Error("INVALID_REMOTE_DESKTOP_ICE");
  }
  return Object.freeze(value.map((candidate) => {
    const record = strictRecord(candidate, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"], [
      "usernameFragment"
    ]);
    if (typeof record.candidate !== "string"
      || !record.candidate.startsWith("candidate:")
      || record.candidate.length > 2_048
      || !(record.sdpMid === null
        || (typeof record.sdpMid === "string" && record.sdpMid.length <= 128))
      || !(record.sdpMLineIndex === null
        || (Number.isInteger(record.sdpMLineIndex)
          && (record.sdpMLineIndex as number) >= 0
          && (record.sdpMLineIndex as number) < 32))
      || (record.sdpMid === null && record.sdpMLineIndex === null)
      || !(record.usernameFragment === undefined
        || (typeof record.usernameFragment === "string" && record.usernameFragment.length <= 256))) {
      throw new Error("INVALID_REMOTE_DESKTOP_ICE");
    }
    return Object.freeze({
      candidate: record.candidate,
      sdpMid: record.sdpMid as string | null,
      sdpMLineIndex: record.sdpMLineIndex as number | null,
      ...(record.usernameFragment === undefined
        ? {}
        : { usernameFragment: record.usernameFragment as string })
    });
  }));
}

export function parseRemoteDesktopIceReply(value: unknown): RemoteDesktopIceReply {
  const record = strictRecord(value, ["attemptId", "candidates", "next", "complete"]);
  if (!isRemoteDesktopAttemptId(record.attemptId)
    || !isRemoteDesktopIceCursor(record.next)
    || typeof record.complete !== "boolean") {
    throw new Error("INVALID_REMOTE_DESKTOP_ICE");
  }
  return Object.freeze({
    attemptId: record.attemptId,
    candidates: parseRemoteDesktopIceCandidates(record.candidates),
    next: record.next,
    complete: record.complete
  });
}

function strictRecord(
  value: unknown,
  allowedKeys: readonly string[],
  optionalKeys: readonly string[] = []
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("INVALID_REMOTE_DESKTOP_ICE");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))
    || allowedKeys.some((key) => !optionalKeys.includes(key) && !(key in record))) {
    throw new Error("INVALID_REMOTE_DESKTOP_ICE");
  }
  return record;
}
