import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { VoiceInputDictionaryPeerStatusSchema, VoiceInputDictionaryPeerPhase, VoiceInputDictionaryPeerErrorCode } from "./gen/joko/v1/voice_pb.js";
import { projectVoiceDictionaryPeerStatus } from "./voice-dictionary-peer-status.js";

function status() {
  return create(VoiceInputDictionaryPeerStatusSchema, {
    available: true, configurationRevision: 4n, nodeId: "node-self", fingerprint: "a".repeat(64), enabled: true,
    phase: VoiceInputDictionaryPeerPhase.UP_TO_DATE,
    peers: [{ peerId: "node-granted", revision: 3n, displayName: "Granted", fingerprint: "b".repeat(64), online: true,
      grantedAt: { seconds: 1n }, lastSyncAt: { seconds: 2n } }],
    candidates: [{ nodeId: "node-granted", displayName: "Granted", fingerprint: "b".repeat(64), seenAt: { seconds: 3n }, granted: true },
      { nodeId: "node-new", displayName: "New", fingerprint: "c".repeat(64), seenAt: { seconds: 3n } }]
  });
}
describe("strict dictionary sharing projection", () => {
  it("projects only bounded public values and keeps changed candidate keys separate from grants", () => {
    const wire = status();
    const result = projectVoiceDictionaryPeerStatus(wire);
    expect(result.peers).toMatchObject([{ revision: 3n, grantedAt: 1_000, lastSyncAt: 2_000 }]);
    expect(Object.keys(result).sort()).toEqual(["available", "candidates", "configurationRevision", "enabled", "fingerprint", "nodeId", "peers", "phase"]);
    wire.candidates[0]!.fingerprint = "d".repeat(64); wire.candidates[0]!.granted = false; wire.candidates[0]!.keyChanged = true;
    expect(projectVoiceDictionaryPeerStatus(wire).candidates[0]).toMatchObject({ fingerprint: "d".repeat(64), keyChanged: true, granted: false });
    expect(result.candidates[0]!.fingerprint).toBe("b".repeat(64));
    expect(Object.isFrozen(result)).toBe(true);
  });
  it("rejects malformed identity, revision, enum, timestamp, duplicate and authority relationships", () => {
    const mutations: Array<(value: ReturnType<typeof status>) => void> = [
      (v) => { v.configurationRevision = 0n; }, (v) => { v.configurationRevision = BigInt(Number.MAX_SAFE_INTEGER) + 1n; },
      (v) => { v.nodeId = "../private"; }, (v) => { v.fingerprint = "NOT-A-FINGERPRINT"; },
      (v) => { v.phase = 99 as VoiceInputDictionaryPeerPhase; }, (v) => { v.errorCode = VoiceInputDictionaryPeerErrorCode.UNSPECIFIED; },
      (v) => { v.enabled = false; }, (v) => { v.peers[0]!.revision = 5n; },
      (v) => { v.peers[0]!.lastSyncAt = { $typeName: "google.protobuf.Timestamp", seconds: 0n, nanos: 0 }; },
      (v) => { v.peers[0]!.grantedAt!.nanos = 1; }, (v) => { v.peers[0]!.online = false; },
      (v) => { v.peers.push(v.peers[0]!); }, (v) => { v.candidates.push(v.candidates[0]!); },
      (v) => { v.candidates[0]!.granted = false; }, (v) => { v.candidates[1]!.keyChanged = true; },
      (v) => { v.candidates[1]!.displayName = "\nprivate"; }, (v) => { v.peers[0]!.peerId = v.nodeId; }
    ];
    expect(() => projectVoiceDictionaryPeerStatus(undefined)).toThrow(/invalid/u);
    for (const mutate of mutations) { const value = status(); mutate(value); expect(() => projectVoiceDictionaryPeerStatus(value)).toThrow(/invalid/u); }
  });
  it("retains disabled identity errors and enforces candidate and grant budgets", () => {
    const value = status(); value.available = false; value.fingerprint = ""; value.enabled = false;
    value.phase = VoiceInputDictionaryPeerPhase.OFF; value.errorCode = VoiceInputDictionaryPeerErrorCode.IDENTITY_UNAVAILABLE;
    expect(projectVoiceDictionaryPeerStatus(value)).toMatchObject({ available: false, enabled: false, phase: "off", errorCode: "identity_unavailable" });
    value.peers = Array.from({ length: 129 }, () => value.peers[0]!);
    expect(() => projectVoiceDictionaryPeerStatus(value)).toThrow(/invalid/u);
    value.peers = []; value.candidates = Array.from({ length: 257 }, () => value.candidates[0]!);
    expect(() => projectVoiceDictionaryPeerStatus(value)).toThrow(/invalid/u);
  });
});
