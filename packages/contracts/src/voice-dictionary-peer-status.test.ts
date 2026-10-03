import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { VoiceInputDictionaryPeerStatusSchema, VoiceInputDictionaryPeerPhase, VoiceInputDictionaryPeerErrorCode } from "./gen/joko/v1/voice_pb.js";
import { nextVoiceDictionaryWatchSequence, projectVoiceDictionaryPeerStatus, readVoiceDictionaryPeerInvitation, readVoiceDictionaryPeerListener } from "./voice-dictionary-peer-status.js";

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
  it("previews only complete public invitations and distinguishes configured routes from online presence", () => {
    const invitation = { version: 1, nodeId: "node-direct", displayName: "Direct peer", publicKey: "MCowBQYDK2VuAyEA" + "A".repeat(43) + "=",
      fingerprint: "d".repeat(64), host: "peer.example", port: 43_121 };
    expect(readVoiceDictionaryPeerInvitation(JSON.stringify(invitation))).toEqual(invitation);
    expect(readVoiceDictionaryPeerInvitation(JSON.stringify({ ...invitation, host: "::1" })).host).toBe("::1");
    for (const patch of [{ version: 2 }, { publicKey: "A".repeat(60) }, { fingerprint: "D".repeat(64) }, { authKey: "private" },
      { host: "https://peer.example/path" }, { host: "peer.example:443" }, { host: "127.1" }, { port: 0 }, { port: 65_536 }]) {
      expect(() => readVoiceDictionaryPeerInvitation(JSON.stringify({ ...invitation, ...patch }))).toThrow(/invalid/u);
    }
    expect(() => readVoiceDictionaryPeerInvitation(JSON.stringify({ ...invitation, fingerprint: undefined }))).toThrow(/invalid/u);
    expect(() => readVoiceDictionaryPeerListener({ listenPort: 0, host: "peer.example", port: 43_121 })).toThrow(/invalid/u);
    const wire = status(); wire.phase = VoiceInputDictionaryPeerPhase.WAITING; wire.peers[0]!.online = false;
    wire.peers[0]!.route = { $typeName: "joko.v1.VoiceInputDictionaryPeerEndpoint", host: "peer.example", port: 43_121 };
    wire.listener = { $typeName: "joko.v1.VoiceInputDictionaryListener", listenPort: 43_121, host: "self.example", port: 44_121 };
    expect(projectVoiceDictionaryPeerStatus(wire)).toMatchObject({ listener: { listenPort: 43_121, host: "self.example", port: 44_121 },
      peers: [{ online: false, route: { host: "peer.example", port: 43_121 } }] });
    wire.peers[0]!.route.port = 0;
    expect(() => projectVoiceDictionaryPeerStatus(wire)).toThrow(/invalid/u);
  });
  it("accepts only contiguous safe watch sequences from the first full projection", () => {
    expect(nextVoiceDictionaryWatchSequence(1n, 0n)).toBe(1n);
    expect(nextVoiceDictionaryWatchSequence(2n, 1n)).toBe(2n);
    for (const [value, previous] of [[0n, 0n], [2n, 0n], [1n, 1n], [3n, 1n],
      [BigInt(Number.MAX_SAFE_INTEGER) + 1n, BigInt(Number.MAX_SAFE_INTEGER)]]) {
      expect(() => nextVoiceDictionaryWatchSequence(value!, previous!)).toThrow(/invalid/u);
    }
  });
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
