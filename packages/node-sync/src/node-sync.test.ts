import { createPrivateKey, createPublicKey, diffieHellman, hkdfSync, createDecipheriv, randomInt } from "node:crypto";
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  createNodeSyncLanProof, decryptNodeSyncBytes, encryptNodeSyncBytes, generateNodeSyncIdentity,
  nodeSyncDomain, verifyNodeSyncLanProof, type NodeSyncPurpose
} from "./crypto.js";
import { isNodeSyncCipherChunkFrame, NODE_SYNC_CHUNK_BYTES, type NodeSyncCipherChunkFrame } from "./frames.js";
import { NodeSyncLanTransport, type NodeSyncDeliveryContext, type NodeSyncLanIdentity, type NodeSyncLanTransportOptions } from "./lan.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

describe("purpose-isolated node encryption", () => {
  it.each(["contacts", "voice-dictionary"] as const)("binds %s ciphertext and proofs to purpose, nodes and all frame fields", (purpose) => {
    const first = generateNodeSyncIdentity();
    const second = generateNodeSyncIdentity();
    const context = { sourceNodeId: "node-first", destinationNodeId: "node-second", transferId: "transfer-1", totalChunks: 1 };
    const encrypted = encryptNodeSyncBytes(purpose, Buffer.from("private document"), first.privateKey, second.publicKey, context);
    expect(decryptNodeSyncBytes(purpose, encrypted, second.privateKey, first.publicKey, context).toString("utf8")).toBe("private document");
    const otherPurpose = purpose === "contacts" ? "voice-dictionary" : "contacts";
    expect(() => decryptNodeSyncBytes(otherPurpose, encrypted, second.privateKey, first.publicKey, context)).toThrow();
    for (const mutation of [{ sourceNodeId: "node-other" }, { destinationNodeId: "node-other" }, { transferId: "transfer-2" }, { totalChunks: 2 }]) {
      expect(() => decryptNodeSyncBytes(purpose, encrypted, second.privateKey, first.publicKey, { ...context, ...mutation })).toThrow();
    }
    const auth = { kind: "request" as const, ...context, total: 1, index: 0, challenge: Buffer.alloc(24, 3).toString("base64"),
      senderPublicKey: first.publicKey, iv: encrypted.iv, tag: encrypted.tag, data: encrypted.ciphertext.toString("base64") };
    const proof = createNodeSyncLanProof(purpose, first.privateKey, second.publicKey, auth);
    expect(verifyNodeSyncLanProof(purpose, proof, second.privateKey, first.publicKey, auth)).toBe(true);
    expect(verifyNodeSyncLanProof(otherPurpose, proof, second.privateKey, first.publicKey, auth)).toBe(false);
    for (const mutation of [{ kind: "ack" as const }, { sourceNodeId: "node-other" }, { destinationNodeId: "node-other" },
      { transferId: "transfer-2" }, { index: 1 }, { total: 2 }, { challenge: Buffer.alloc(24, 4).toString("base64") },
      { senderPublicKey: second.publicKey }, { iv: Buffer.alloc(12, 1).toString("base64") },
      { tag: Buffer.alloc(16, 1).toString("base64") }, { data: "AAAA" }]) {
      expect(verifyNodeSyncLanProof(purpose, proof, second.privateKey, first.publicKey, { ...auth, ...mutation })).toBe(false);
    }
  });

  it("retains the exact Contacts v1 encryption domain and strict generic envelope", () => {
    expect(nodeSyncDomain("contacts")).toEqual({ encryption: "joko:contacts-device-sync:v1", lanAuth: "joko:contacts-device-sync:lan-auth:v1",
      magic: "joko-contacts-sync", multicastPort: 53_547 });
    const first = generateNodeSyncIdentity();
    const second = generateNodeSyncIdentity();
    const frame = encryptedFrame(first, second, "contacts");
    // Decrypt with the existing v1 protocol, independently of the extracted helper.
    const shared = diffieHellman({ privateKey: createPrivateKey({ key: Buffer.from(second.privateKey, "base64"), format: "der", type: "pkcs8" }),
      publicKey: createPublicKey({ key: Buffer.from(first.publicKey, "base64"), format: "der", type: "spki" }) });
    const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("joko:contacts-device-sync:v1\u0000node-first\u0000node-second"), 32));
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(frame.iv, "base64"));
    decipher.setAAD(Buffer.from(["joko:contacts-device-sync:v1", "node-first", "node-second", frame.transferId, "1"].join("\u0000")));
    decipher.setAuthTag(Buffer.from(frame.tag, "base64"));
    expect(Buffer.concat([decipher.update(Buffer.from(frame.data, "base64")), decipher.final()]).toString()).toBe("private document");
    expect(isNodeSyncCipherChunkFrame(frame)).toBe(true);
    for (const mutation of [{ version: 0 }, { extra: true }, { index: 1 }, { total: 129 }, { compression: "raw" },
      { data: "AB==" }, { data: Buffer.alloc(NODE_SYNC_CHUNK_BYTES + 1).toString("base64") }]) {
      expect(isNodeSyncCipherChunkFrame({ ...frame, ...mutation })).toBe(false);
    }
  });
});

describe("authenticated node LAN lifetime", () => {
  it("delivers on its granted purpose and excludes another purpose even on the same discovery port", { timeout: 15_000 }, async () => {
    const port = randomInt(42_000, 48_000);
    const first = identity("first");
    const second = identity("second");
    const other = identity("other");
    const delivered: string[] = [];
    const firstTransport = transport(port, "voice-dictionary", first, second, () => undefined);
    const secondTransport = transport(port, "voice-dictionary", second, first, (source, frame) => {
      delivered.push(decryptNodeSyncBytes("voice-dictionary", { iv: frame.iv, tag: frame.tag, ciphertext: Buffer.from(frame.data, "base64") },
        second.privateKey, first.publicKey, { sourceNodeId: source, destinationNodeId: second.nodeId,
          transferId: frame.transferId, totalChunks: frame.total }).toString());
    });
    const otherTransport = transport(port, "contacts", other, first, () => { throw new Error("Wrong purpose delivery."); });
    await Promise.all([firstTransport.start(), secondTransport.start(), otherTransport.start()]);
    await waitUntil(() => firstTransport.onlinePeerIds().includes(second.nodeId) && secondTransport.onlinePeerIds().includes(first.nodeId));
    expect(firstTransport.candidates().map((peer) => peer.nodeId)).not.toContain(other.nodeId);
    expect(otherTransport.candidates()).toEqual([]);
    expect(await firstTransport.send(second.nodeId, encryptedFrame(first, second, "voice-dictionary"))).toBe(true);
    expect(delivered).toEqual(["private document"]);
    const endpoint = firstTransport.candidates().find((peer) => peer.nodeId === second.nodeId)!;
    const frame = encryptedFrame(first, second, "contacts");
    const challenge = Buffer.alloc(24, 2).toString("base64");
    const proof = createNodeSyncLanProof("contacts", first.privateKey, second.publicKey, {
      kind: "request", sourceNodeId: first.nodeId, destinationNodeId: second.nodeId, challenge,
      senderPublicKey: frame.senderPublicKey, transferId: frame.transferId, index: frame.index,
      total: frame.total, iv: frame.iv, tag: frame.tag, data: frame.data
    });
    const body = Buffer.from(JSON.stringify({ version: 1, sourceNodeId: first.nodeId, destinationNodeId: second.nodeId, challenge, proof, frame }));
    expect(await packetGetsAck(endpoint, body)).toBe(false);
    expect(delivered).toEqual(["private document"]);
  });

  it.each(["grant", "stop", "identity"] as const)("retires an awaited delivery when its %s authority changes", { timeout: 15_000 }, async (change) => {
    const port = randomInt(42_000, 48_000);
    const first = identity("first");
    let second = identity("second");
    let allowed = true;
    let delivery: NodeSyncDeliveryContext | undefined;
    let committed = false;
    const gate = deferred();
    cleanups.push(gate.resolve);
    const firstTransport = transport(port, "voice-dictionary", first, second, () => undefined);
    const secondTransport = transport(port, "voice-dictionary", second, first, async (_source, _frame, current) => {
      delivery = current;
      await gate.promise;
      if (current.isCurrent()) committed = true;
    }, { getSelf: () => second, isPeerAllowed: (nodeId, publicKey) => allowed && nodeId === first.nodeId && publicKey === first.publicKey });
    await Promise.all([firstTransport.start(), secondTransport.start()]);
    await waitUntil(() => firstTransport.onlinePeerIds().includes(second.nodeId));
    const sending = firstTransport.send(second.nodeId, encryptedFrame(first, second, "voice-dictionary"));
    await waitUntil(() => delivery !== undefined);
    expect(delivery!.isCurrent()).toBe(true);
    if (change === "grant") allowed = false;
    if (change === "stop") secondTransport.stop();
    if (change === "identity") second = identity("second");
    expect(delivery!.isCurrent()).toBe(false);
    expect(delivery!.signal.aborted).toBe(change === "stop");
    gate.resolve();
    expect(await sending).toBe(false);
    expect(committed).toBe(false);
  });

  it("stops an outbound socket immediately without imposing a cooldown on its next generation", { timeout: 15_000 }, async () => {
    const port = randomInt(42_000, 48_000);
    const first = identity("first");
    const second = identity("second");
    const gate = deferred();
    cleanups.push(gate.resolve);
    let entered = false;
    let wait = true;
    const sender = transport(port, "voice-dictionary", first, second, () => undefined);
    const receiver = transport(port, "voice-dictionary", second, first, async () => {
      entered = true;
      if (wait) await gate.promise;
    }, { connectTimeoutMilliseconds: 10_000 });
    await Promise.all([sender.start(), receiver.start()]);
    await waitUntil(() => sender.onlinePeerIds().includes(second.nodeId));
    const sending = sender.send(second.nodeId, encryptedFrame(first, second, "voice-dictionary"));
    await waitUntil(() => entered);
    sender.stop();
    const finished = await Promise.race([sending, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 300))]);
    expect(finished).toBe(false);
    gate.resolve();
    wait = false;
    await sender.start();
    await waitUntil(() => sender.onlinePeerIds().includes(second.nodeId));
    expect(await sender.send(second.nodeId, encryptedFrame(first, second, "voice-dictionary"))).toBe(true);
  });
});

function identity(name: string): NodeSyncLanIdentity { return { ...generateNodeSyncIdentity(), nodeId: `node-${name}`, displayName: `${name} computer` }; }
function encryptedFrame(first: { publicKey: string; privateKey: string }, second: { publicKey: string }, purpose: NodeSyncPurpose): NodeSyncCipherChunkFrame {
  const transferId = "transfer-1";
  const encrypted = encryptNodeSyncBytes(purpose, Buffer.from("private document"), first.privateKey, second.publicKey,
    { sourceNodeId: "node-first", destinationNodeId: "node-second", transferId, totalChunks: 1 });
  return { version: 1, type: "cipher-chunk", senderPublicKey: first.publicKey, transferId, total: 1, index: 0,
    iv: encrypted.iv, tag: encrypted.tag, compression: "gzip", data: encrypted.ciphertext.toString("base64") };
}
function transport(port: number, purpose: NodeSyncPurpose, self: NodeSyncLanIdentity, peer: NodeSyncLanIdentity,
  onFrame: NodeSyncLanTransportOptions["onFrame"], overrides: Partial<NodeSyncLanTransportOptions> = {}): NodeSyncLanTransport {
  const instance = new NodeSyncLanTransport({ purpose, getSelf: () => self,
    isPeerAllowed: (nodeId, key) => nodeId === peer.nodeId && key === peer.publicKey,
    onCandidate: () => undefined, onFrame, logger: { debug: () => undefined, warn: () => undefined },
    multicastPort: port, beaconIntervalMilliseconds: 150, endpointTtlMilliseconds: 2_000, connectTimeoutMilliseconds: 800, ...overrides });
  cleanups.push(() => instance.stop());
  return instance;
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((finish) => { resolve = finish; }), resolve: () => resolve() };
}
async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for node sync state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function packetGetsAck(endpoint: { address: string; port: number }, body: Buffer): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: endpoint.address, port: endpoint.port });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.byteLength);
    let received = false;
    socket.once("connect", () => socket.write(Buffer.concat([header, body])));
    socket.on("data", () => { received = true; });
    socket.on("error", () => undefined);
    socket.setTimeout(1_000, () => socket.destroy());
    socket.once("close", () => resolve(received));
  });
}
