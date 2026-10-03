import { createPrivateKey, createPublicKey, diffieHellman, hkdfSync, createDecipheriv, createHmac, randomInt } from "node:crypto";
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  createNodeSyncLanProof, decryptNodeSyncBytes, encryptNodeSyncBytes, generateNodeSyncIdentity,
  nodeSyncDomain, verifyNodeSyncLanProof, createNodeSyncProbeProof, verifyNodeSyncProbeProof, type NodeSyncPurpose
} from "./crypto.js";
import { isNodeSyncCipherChunkFrame, NODE_SYNC_CHUNK_BYTES, type NodeSyncCipherChunkFrame } from "./frames.js";
import { NodeSyncLanTransport, type NodeSyncDeliveryContext, type NodeSyncLanIdentity, type NodeSyncLanTransportOptions } from "./lan.js";
import { NodeSyncTcpTransport, validNodeSyncEndpoint } from "./tcp.js";

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
    const authKey = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("joko:contacts-device-sync:lan-auth:v1"), 32));
    for (const kind of ["request", "ack"] as const) {
      const challenge = Buffer.alloc(24, 5).toString("base64");
      const message = ["joko:contacts-device-sync:lan-auth:v1", kind, "node-first", "node-second", challenge, first.publicKey,
        frame.transferId, String(frame.index), String(frame.total), frame.iv, frame.tag, frame.data].join("\u0000");
      expect(createNodeSyncLanProof("contacts", first.privateKey, second.publicKey, { kind, sourceNodeId: "node-first",
        destinationNodeId: "node-second", challenge, senderPublicKey: first.publicKey, transferId: frame.transferId,
        index: frame.index, total: frame.total, iv: frame.iv, tag: frame.tag, data: frame.data }))
        .toBe(createHmac("sha256", authKey).update(Buffer.from(message, "utf8")).digest("base64"));
    }
    expect(isNodeSyncCipherChunkFrame(frame)).toBe(true);
    for (const mutation of [{ version: 0 }, { extra: true }, { index: 1 }, { total: 129 }, { compression: "raw" },
      { data: "AB==" }, { data: Buffer.alloc(NODE_SYNC_CHUNK_BYTES + 1).toString("base64") }]) {
      expect(isNodeSyncCipherChunkFrame({ ...frame, ...mutation })).toBe(false);
    }
  });

  it.each(["contacts", "voice-dictionary"] as const)("binds %s probes to both pinned identities, challenge and the original request direction", (purpose) => {
    const first = generateNodeSyncIdentity();
    const second = generateNodeSyncIdentity();
    const context = { kind: "probe-request" as const, sourceNodeId: "node-first", destinationNodeId: "node-second",
      challenge: Buffer.alloc(24, 6).toString("base64"), requesterPublicKey: first.publicKey, responderPublicKey: second.publicKey };
    const proof = createNodeSyncProbeProof(purpose, first.privateKey, second.publicKey, context);
    expect(verifyNodeSyncProbeProof(purpose, proof, second.privateKey, first.publicKey, context)).toBe(true);
    expect(verifyNodeSyncProbeProof(purpose === "contacts" ? "voice-dictionary" : "contacts", proof, second.privateKey, first.publicKey, context)).toBe(false);
    for (const mutation of [{ kind: "probe-ack" as const }, { sourceNodeId: "node-other" }, { destinationNodeId: "node-other" },
      { challenge: Buffer.alloc(24, 7).toString("base64") }, { requesterPublicKey: second.publicKey }, { responderPublicKey: first.publicKey }]) {
      expect(verifyNodeSyncProbeProof(purpose, proof, second.privateKey, first.publicKey, { ...context, ...mutation })).toBe(false);
    }
    const ack = createNodeSyncProbeProof(purpose, second.privateKey, first.publicKey, { ...context, kind: "probe-ack" });
    expect(verifyNodeSyncProbeProof(purpose, ack, first.privateKey, second.publicKey, { ...context, kind: "probe-ack" })).toBe(true);
  });
});

describe("authenticated node TCP probe ingress", () => {
  it("accepts only exact probe packets without delivering frames and validates explicit endpoint syntax", async () => {
    const first = identity("first");
    const second = identity("second");
    let frames = 0;
    const sender = new NodeSyncTcpTransport({ purpose: "voice-dictionary", getSelf: () => first,
      isPeerAllowed: (nodeId, key) => nodeId === second.nodeId && key === second.publicKey,
      onFrame: () => undefined, logger: { debug: () => undefined, warn: () => undefined }, listenHost: "127.0.0.1" });
    const receiver = new NodeSyncTcpTransport({ purpose: "voice-dictionary", getSelf: () => second,
      isPeerAllowed: (nodeId, key) => nodeId === first.nodeId && key === first.publicKey,
      onFrame: () => { frames += 1; }, logger: { debug: () => undefined, warn: () => undefined }, listenHost: "127.0.0.1" });
    cleanups.push(() => sender.stop(), () => receiver.stop());
    await Promise.all([sender.start(), receiver.start()]);
    const endpoint = { address: "127.0.0.1", port: receiver.listenerPort()! };
    const challenge = Buffer.alloc(24, 8).toString("base64");
    const auth = { kind: "probe-request" as const, sourceNodeId: first.nodeId, destinationNodeId: second.nodeId,
      challenge, requesterPublicKey: first.publicKey, responderPublicKey: second.publicKey };
    const request = { version: 1, type: "probe", sourceNodeId: first.nodeId, destinationNodeId: second.nodeId,
      senderPublicKey: first.publicKey, challenge, proof: createNodeSyncProbeProof("voice-dictionary", first.privateKey, second.publicKey, auth) };
    expect(await packetGetsAck(endpoint, Buffer.from(JSON.stringify(request)))).toBe(true);
    for (const mutation of [{ version: 2 }, { type: "probe-ack" }, { type: "unknown" }, { extra: true },
      { proof: Buffer.alloc(32, 1).toString("base64") }, { frame: encryptedFrame(first, second, "voice-dictionary") }]) {
      expect(await packetGetsAck(endpoint, Buffer.from(JSON.stringify({ ...request, ...mutation })))).toBe(false);
    }
    expect(await sender.probe({ host: endpoint.address, port: endpoint.port, publicKey: second.publicKey }, second.nodeId)).toBe(true);
    expect(frames).toBe(0);
    for (const host of ["127.0.0.1", "::1", "peer.example", "peer.example."]) expect(validNodeSyncEndpoint(host, 1234)).toBe(true);
    for (const host of ["127.1", "2130706433", "0x7f000001", "0x7f.1", "fe80::1%eth0", "http://peer", "peer/path", " peer", "peer:443"]) {
      expect(validNodeSyncEndpoint(host, 1234)).toBe(false);
    }
    receiver.stop();
    const starting = receiver.start();
    receiver.stop();
    await expect(starting).rejects.toThrow("superseded");
    await receiver.start();
    expect(await sender.probe({ host: endpoint.address, port: receiver.listenerPort()!, publicKey: second.publicKey }, second.nodeId)).toBe(true);
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

  it("keeps a failed route in cooldown but immediately permits a new route for the same pinned identity", { timeout: 15_000 }, async () => {
    const port = randomInt(42_000, 48_000);
    const first = identity("first");
    const second = identity("second");
    let accept = false;
    const sender = transport(port, "voice-dictionary", first, second, () => undefined);
    const receiver = transport(port, "voice-dictionary", second, first, () => {
      if (!accept) throw new Error("Controlled receiver failure.");
    });
    await Promise.all([sender.start(), receiver.start()]);
    await waitUntil(() => sender.onlinePeerIds().includes(second.nodeId));
    const oldPort = sender.candidates()[0]!.port;
    expect(await sender.send(second.nodeId, encryptedFrame(first, second, "voice-dictionary"))).toBe(false);
    await waitUntil(() => sender.candidates().some((candidate) => candidate.port === oldPort));
    expect(sender.onlinePeerIds()).toEqual([]);
    accept = true;
    expect(await sender.send(second.nodeId, encryptedFrame(first, second, "voice-dictionary"))).toBe(false);
    receiver.stop();
    await receiver.start();
    await waitUntil(() => sender.candidates().some((candidate) => candidate.port !== oldPort));
    expect(sender.onlinePeerIds()).toEqual([second.nodeId]);
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
