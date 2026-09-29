import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

import { encryptNodeSyncBytes, generateNodeSyncIdentity, type NodeSyncDeliveryContext } from "@joko/node-sync";
import {
  addManualEntry, createEmptySyncState, createHlcClock, deleteTerms, formatHlc, recordLearningEvent,
  type VoiceDictionarySyncState
} from "@joko/voice-input";
import { afterEach, describe, expect, it } from "vitest";

import { VoiceDictionaryPeerWorkerCodec } from "./voice-dictionary-sync-codec.js";
import {
  decodeVoiceDictionaryPeerMessage, encodeVoiceDictionaryPeerMessage, isVoiceDictionaryPeerMessage,
  VoiceDictionaryPeerWireDecoder, VOICE_DICTIONARY_PEER_FRAME_BYTES, VOICE_DICTIONARY_PEER_MAX_CHUNKS,
  type VoiceDictionaryPeerCodec, type VoiceDictionaryPeerDecodeOptions, type VoiceDictionaryPeerMessage
} from "./voice-dictionary-sync-wire.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const inProcessCodec: VoiceDictionaryPeerCodec = {
  encode: async (options) => encodeVoiceDictionaryPeerMessage(options),
  decode: async (options) => decodeVoiceDictionaryPeerMessage(options)
};

describe("voice dictionary peer full-state boundary", () => {
  it("round-trips complete convergence state through the real bounded worker, including explicit reply intent", async () => {
    const codec = new VoiceDictionaryPeerWorkerCodec({ timeoutMilliseconds: 10_000 });
    cleanups.push(() => codec.close());
    const fixture = pair(seedState());
    const frames = await codec.encode(fixture.encode);
    const decoder = new VoiceDictionaryPeerWireDecoder(codec);
    let result: VoiceDictionaryPeerMessage | null = null;
    for (const frame of frames) result = await decoder.accept({ ...fixture.accept, frame });
    expect(result).toEqual(fixture.encode.message);
    expect(result!.state).toMatchObject({ records: expect.any(Object), suppressed: expect.any(Object), mutationVector: expect.any(Object) });
    expect(Object.keys(result!.state.suppressed)).not.toHaveLength(0);
  });

  it("assembles out-of-order chunks once, ignores exact duplicates and rejects changed chunk or authority metadata", async () => {
    const fixture = pair(largeState());
    const frames = encodeVoiceDictionaryPeerMessage(fixture.encode);
    expect(frames.length).toBeGreaterThan(1);
    const decoder = new VoiceDictionaryPeerWireDecoder(inProcessCodec);
    let result: VoiceDictionaryPeerMessage | null = null;
    for (const frame of [...frames].reverse()) {
      result = await decoder.accept({ ...fixture.accept, frame });
      expect(await decoder.accept({ ...fixture.accept, frame })).toBeNull();
    }
    expect(result).toEqual(fixture.encode.message);
    for (const mutation of [
      { frame: { ...frames[0]!, iv: Buffer.alloc(12, 1).toString("base64") } },
      { frame: { ...frames[0]!, data: Buffer.alloc(Buffer.from(frames[0]!.data, "base64").byteLength).toString("base64") } },
      { destinationNodeId: "node-third" }, { ownPrivateKey: generateNodeSyncIdentity().privateKey }
    ]) {
      const changed = new VoiceDictionaryPeerWireDecoder(inProcessCodec);
      await changed.accept({ ...fixture.accept, frame: frames[0]! });
      await expect(changed.accept({ ...fixture.accept, frame: frames[0]!, ...mutation })).rejects.toThrow(/metadata|duplicate/iu);
    }
    await expect(new VoiceDictionaryPeerWireDecoder(inProcessCodec).accept({ ...fixture.accept,
      expectedPeerPublicKey: generateNodeSyncIdentity().publicKey, frame: frames[0]! })).rejects.toThrow(/authority/iu);
  });

  it("rejects unknown versions, extra fields, local projections and another-purpose payload after authenticated ingress", () => {
    const fixture = pair();
    for (const payload of [{ ...fixture.encode.message, frameVersion: 2 }, { ...fixture.encode.message, extra: true },
      { ...fixture.encode.message, requestReply: "true" }, { ...fixture.encode.message, state: { entries: [] } },
      { ...fixture.encode.message, state: { ...createEmptySyncState(), extra: true } }]) {
      expect(isVoiceDictionaryPeerMessage(payload)).toBe(false);
      expect(() => decodeVoiceDictionaryPeerMessage(encryptedPayload(fixture, Buffer.from(JSON.stringify(payload))))).toThrow(/invalid/iu);
    }
    expect(() => decodeVoiceDictionaryPeerMessage(encryptedPayload(fixture,
      Buffer.from(JSON.stringify(fixture.encode.message)), "contacts"))).toThrow();
    const invalidUtf8 = Buffer.concat([Buffer.from('{"frameVersion":1,"state":{"'), Buffer.from([0xff]), Buffer.from('":1}}')]);
    expect(() => decodeVoiceDictionaryPeerMessage(encryptedPayload(fixture, invalidUtf8))).toThrow(/JSON/iu);
  });

  it("bounds raw state, decompressed JSON and aggregate encoded frames before admission", async () => {
    const fixture = pair();
    const huge = Buffer.from('"' + "x".repeat(VOICE_DICTIONARY_PEER_FRAME_BYTES) + '"');
    expect(() => decodeVoiceDictionaryPeerMessage(encryptedPayload(fixture, huge))).toThrow();
    const oversizedState = largeState(8_000);
    expect(() => encodeVoiceDictionaryPeerMessage({ ...fixture.encode, message: { frameVersion: 1, state: oversizedState } })).toThrow(/invalid|limit/iu);
    const frame = encodeVoiceDictionaryPeerMessage(fixture.encode)[0]!;
    await expect(new VoiceDictionaryPeerWireDecoder(inProcessCodec).accept({ ...fixture.accept,
      frame: { ...frame, total: VOICE_DICTIONARY_PEER_MAX_CHUNKS + 1 } })).rejects.toThrow(/invalid/iu);
    // Legal transport chunks whose aggregate base64 envelope exceeds the document's budget.
    const decoder = new VoiceDictionaryPeerWireDecoder(inProcessCodec);
    for (let index = 0; index < 5; index += 1) await decoder.accept({ ...fixture.accept,
      frame: { ...frame, total: 6, index, data: Buffer.alloc(256 * 1024).toString("base64") } });
    await expect(decoder.accept({ ...fixture.accept, frame: { ...frame, total: 6, index: 5,
      data: Buffer.alloc(50_000).toString("base64") } })).rejects.toThrow(/size limit/iu);
  });

  it("bounds per-peer and global incomplete transfers and expires abandoned state", async () => {
    const fixture = pair();
    const frame = { ...encodeVoiceDictionaryPeerMessage(fixture.encode)[0]!, total: 2 };
    const decoder = new VoiceDictionaryPeerWireDecoder(inProcessCodec);
    for (let index = 0; index < 4; index += 1) await decoder.accept({ ...fixture.accept, now: 1_000,
      frame: { ...frame, transferId: `transfer-${index}` } });
    await expect(decoder.accept({ ...fixture.accept, now: 1_001, frame: { ...frame, transferId: "transfer-over" } })).rejects.toThrow(/capacity/iu);
    expect(await decoder.accept({ ...fixture.accept, now: 121_001, frame: { ...frame, transferId: "transfer-new" } })).toBeNull();
    decoder.reset();
    for (let index = 0; index < 16; index += 1) await decoder.accept({ ...fixture.accept, sourceNodeId: `peer-${index}`, frame });
    await expect(decoder.accept({ ...fixture.accept, sourceNodeId: "peer-over", frame })).rejects.toThrow(/capacity/iu);
  });

  it.each(["reset", "abort", "grant"] as const)("does not publish a decoded state after %s retires its authority", async (change) => {
    const fixture = pair();
    const gate = deferred();
    let entered = false;
    const codec: VoiceDictionaryPeerCodec = { encode: inProcessCodec.encode, decode: async () => {
      entered = true;
      await gate.promise;
      return fixture.encode.message;
    } };
    const decoder = new VoiceDictionaryPeerWireDecoder(codec);
    const controller = new AbortController();
    let allowed = true;
    const pending = decoder.accept({ ...fixture.accept, delivery: { signal: controller.signal, isCurrent: () => allowed },
      frame: encodeVoiceDictionaryPeerMessage(fixture.encode)[0]! });
    expect(entered).toBe(true);
    if (change === "reset") decoder.reset();
    if (change === "abort") controller.abort();
    if (change === "grant") allowed = false;
    gate.resolve();
    expect(await pending).toBeNull();
  });

  it("retires an in-flight worker on cancellation, recreates it for retry and rejects after close", async () => {
    const fixture = pair();
    const codec = new VoiceDictionaryPeerWorkerCodec({ timeoutMilliseconds: 10_000 });
    cleanups.push(() => codec.close());
    const controller = new AbortController();
    const cancelled = expect(codec.encode(fixture.encode, controller.signal)).rejects.toThrow(/cancelled/iu);
    controller.abort(new Error("not for diagnostics"));
    await cancelled;
    expect(await codec.encode(fixture.encode)).not.toHaveLength(0);
    codec.close();
    await expect(codec.encode(fixture.encode)).rejects.toThrow(/closed/iu);
  });
});

function seedState(): VoiceDictionarySyncState {
  const added = addManualEntry(createEmptySyncState(), createHlcClock("replica-first"), { text: "Joko Runtime", nowMs: 1_000 });
  const learned = recordLearningEvent(added.state, added.clock, { text: "Protocol candidate", stage: "candidate", aliases: ["proto col"], nowMs: 1_001 });
  const suppressed = recordLearningEvent(learned.state, learned.clock, { text: "Hidden token", stage: "entry", nowMs: 1_002 });
  return deleteTerms(suppressed.state, suppressed.clock, { termKeys: ["joko runtime", "hidden token"], nowMs: 1_003, suppressAutomatic: true }).state;
}
function largeState(count = 5_000): VoiceDictionarySyncState {
  const state = createEmptySyncState();
  const stamp = formatHlc(createHlcClock("replica-first", 1_000));
  state.mutationVector["replica-first"] = stamp;
  for (let index = 0; index < count; index += 1) {
    const text = `${index}-${randomBytes(50).toString("hex")}`;
    state.suppressed[text] = { text, stamp };
  }
  return state;
}
function pair(state = seedState()) {
  const first = generateNodeSyncIdentity();
  const second = generateNodeSyncIdentity();
  const delivery: NodeSyncDeliveryContext = { signal: new AbortController().signal, isCurrent: () => true };
  return { first, second, encode: { message: { frameVersion: 1 as const, state, requestReply: true },
    ownPrivateKey: first.privateKey, ownPublicKey: first.publicKey, peerPublicKey: second.publicKey,
    sourceNodeId: "node-first", destinationNodeId: "node-second" },
  accept: { sourceNodeId: "node-first", destinationNodeId: "node-second", ownPrivateKey: second.privateKey,
    expectedPeerPublicKey: first.publicKey, delivery } };
}
function encryptedPayload(fixture: ReturnType<typeof pair>, payload: Buffer, purpose: "contacts" | "voice-dictionary" = "voice-dictionary"): VoiceDictionaryPeerDecodeOptions {
  const transferId = "transfer-payload";
  const encrypted = encryptNodeSyncBytes(purpose, gzipSync(payload), fixture.first.privateKey, fixture.second.publicKey,
    { sourceNodeId: "node-first", destinationNodeId: "node-second", transferId, totalChunks: 1 });
  return { ciphertext: encrypted.ciphertext, iv: encrypted.iv, tag: encrypted.tag,
    sourceNodeId: "node-first", destinationNodeId: "node-second", transferId, totalChunks: 1,
    ownPrivateKey: fixture.second.privateKey, expectedPeerPublicKey: fixture.first.publicKey };
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((finish) => { resolve = finish; }), resolve: () => resolve() };
}
