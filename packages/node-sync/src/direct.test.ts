import net, { type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { decryptNodeSyncBytes, encryptNodeSyncBytes, generateNodeSyncIdentity, type NodeSyncPurpose } from "./crypto.js";
import { NodeSyncDirectTransport, type NodeSyncDirectEndpoint, type NodeSyncDirectTransportOptions } from "./direct.js";
import type { NodeSyncCipherChunkFrame } from "./frames.js";
import type { NodeSyncDeliveryContext, NodeSyncTcpIdentity } from "./tcp.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("authenticated explicit node routes", () => {
  it("authenticates a recovered bilateral route during cooldown, renews without document traffic and preserves the stable listener", { timeout: 15_000 }, async () => {
    const first = identity("first");
    const second = identity("second");
    const senderPort = await freePort();
    const receiverPort = await freePort();
    const received: string[] = [];
    const candidates: string[] = [];
    let presenceChanges = 0;
    let receiverAllowed = false;
    const receiver = direct(second, receiverPort, [endpoint(first, senderPort)], first, {
      isPeerAllowed: (nodeId, publicKey) => receiverAllowed && nodeId === first.nodeId && publicKey === first.publicKey,
      onFrame: (source, frame) => {
        received.push(decryptNodeSyncBytes("voice-dictionary", { iv: frame.iv, tag: frame.tag, ciphertext: Buffer.from(frame.data, "base64") },
          second.privateKey, first.publicKey, { sourceNodeId: source, destinationNodeId: second.nodeId,
            transferId: frame.transferId, totalChunks: frame.total }).toString());
      }
    });
    const sender = direct(first, senderPort, [endpoint(second, receiverPort)], second, {
      onCandidate: (candidate) => candidates.push(candidate.nodeId),
      onPresenceChanged: () => { presenceChanges += 1; },
      presenceTtlMilliseconds: 10_000
    });
    expect(sender.onlinePeerIds()).toEqual([]);
    expect(sender.candidates()).toEqual([]);
    await receiver.start();
    await sender.start();
    expect(sender.eligiblePeerIds()).toEqual([second.nodeId]);
    expect(sender.listenerPort()).toBe(senderPort);
    expect(receiver.listenerPort()).toBe(receiverPort);
    expect(await sender.probe(second.nodeId)).toBe(false);
    expect(sender.onlinePeerIds()).toEqual([]);
    expect(sender.candidates()).toEqual([]);
    expect(received).toEqual([]);
    receiverAllowed = true;
    expect(await receiver.probe(first.nodeId)).toBe(true);
    await waitUntil(() => sender.onlinePeerIds().includes(second.nodeId));
    expect(receiver.onlinePeerIds()).toEqual([first.nodeId]);
    expect(await sender.probe(second.nodeId)).toBe(true);
    expect(received).toEqual([]);
    expect(candidates).toEqual([second.nodeId]);
    const originalSeenAt = sender.candidates()[0]!.seenAt;
    const establishedChanges = presenceChanges;
    await waitUntil(() => sender.candidates()[0]!.seenAt > originalSeenAt, 8_000);
    expect(received).toEqual([]);
    expect(candidates).toEqual([second.nodeId]);
    expect(presenceChanges).toBe(establishedChanges);
    expect(await sender.send(second.nodeId, encryptedFrame(first, second))).toBe(true);
    expect(received).toEqual(["private document"]);
    const renewedSeenAt = sender.candidates()[0]!.seenAt;
    expect(sender.onlinePeerIds(renewedSeenAt + 10_000)).toEqual([]);
    expect(presenceChanges).toBe(establishedChanges + 1);
    expect(sender.eligiblePeerIds()).toEqual([second.nodeId]);
    sender.stop();
    expect(sender.listenerPort()).toBeUndefined();
    expect(sender.onlinePeerIds()).toEqual([]);
    await sender.start();
    expect(sender.listenerPort()).toBe(senderPort);
    await waitUntil(() => sender.onlinePeerIds().includes(second.nodeId));
    expect(candidates).toEqual([second.nodeId, second.nodeId]);
  });

  it("cancels an old route probe and recovers on the replacement without inheriting its failure cooldown", { timeout: 10_000 }, async () => {
    const first = identity("first");
    const second = identity("second");
    const pendingServer = await blackhole();
    const receiverPort = await freePort();
    let endpoints = [endpoint(second, pendingServer.port)];
    let presenceChanges = 0;
    const receiver = direct(second, receiverPort, [], first);
    const sender = direct(first, await freePort(), endpoints, second, {
      getEndpoints: () => endpoints,
      connectTimeoutMilliseconds: 10_000,
      onPresenceChanged: () => { presenceChanges += 1; }
    });
    await receiver.start();
    await sender.start();
    await waitUntil(() => pendingServer.active === 1);
    const caller = new AbortController();
    const callerProbe = sender.probe(second.nodeId, { signal: caller.signal, isCurrent: () => !caller.signal.aborted });
    caller.abort();
    expect(await settlesPromptly(callerProbe)).toBe(false);
    expect(pendingServer.active).toBe(1);
    const oldProbe = sender.probe(second.nodeId);
    endpoints = [endpoint(second, receiverPort, 2n)];
    const replacementProbe = sender.probe(second.nodeId);
    expect(await settlesPromptly(oldProbe)).toBe(false);
    expect(await replacementProbe).toBe(true);
    await waitUntil(() => pendingServer.active === 0);
    expect(sender.onlinePeerIds()).toEqual([second.nodeId]);
    expect(sender.candidates()[0]!.port).toBe(receiverPort);
    const establishedChanges = presenceChanges;
    receiver.stop();
    expect(await sender.send(second.nodeId, encryptedFrame(first, second))).toBe(false);
    expect(sender.onlinePeerIds()).toEqual([]);
    expect(presenceChanges).toBe(establishedChanges + 1);
    await receiver.start();
    expect(receiver.listenerPort()).toBe(receiverPort);
    sender.stop();
    await sender.start();
    await waitUntil(() => sender.onlinePeerIds().includes(second.nodeId));
    expect(await sender.send(second.nodeId, encryptedFrame(first, second))).toBe(true);
  });

  it.each(["grant", "identity", "stop"] as const)("retires an in-flight probe promptly when its %s authority changes", { timeout: 10_000 }, async (change) => {
    let first = identity("first");
    const second = identity("second");
    const pendingServer = await blackhole();
    let allowed = true;
    const sender = direct(first, await freePort(), [endpoint(second, pendingServer.port)], second, {
      getSelf: () => first,
      isPeerAllowed: (nodeId, publicKey) => allowed && nodeId === second.nodeId && publicKey === second.publicKey,
      connectTimeoutMilliseconds: 10_000
    });
    await sender.start();
    await waitUntil(() => pendingServer.active === 1);
    const pending = sender.probe(second.nodeId);
    if (change === "grant") allowed = false;
    if (change === "identity") first = identity("first");
    if (change === "stop") sender.stop();
    expect(sender.eligiblePeerIds()).toEqual(change === "identity" ? [second.nodeId] : []);
    expect(await settlesPromptly(pending)).toBe(false);
    expect(sender.onlinePeerIds()).toEqual([]);
    expect(sender.candidates()).toEqual([]);
    if (change === "identity") sender.stop();
    await waitUntil(() => pendingServer.active === 0);
  });

  it("cancels one caller's document exchange without clearing authenticated peer presence", { timeout: 10_000 }, async () => {
    const first = identity("first");
    const second = identity("second");
    const receiverPort = await freePort();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    cleanups.push(() => release());
    let received = false;
    let committed = false;
    let finished = false;
    let current: NodeSyncDeliveryContext | undefined;
    const receiver = direct(second, receiverPort, [], first, {
      onFrame: async (_source, _frame, delivery) => {
        current = delivery;
        received = true;
        await gate;
        if (delivery.isCurrent()) committed = true;
        finished = true;
      },
      connectTimeoutMilliseconds: 10_000
    });
    const sender = direct(first, await freePort(), [endpoint(second, receiverPort)], second, { connectTimeoutMilliseconds: 10_000 });
    await receiver.start();
    await sender.start();
    await waitUntil(() => sender.onlinePeerIds().includes(second.nodeId));
    const caller = new AbortController();
    const sending = sender.send(second.nodeId, encryptedFrame(first, second), { signal: caller.signal, isCurrent: () => !caller.signal.aborted });
    await waitUntil(() => received);
    caller.abort();
    expect(await settlesPromptly(sending)).toBe(false);
    expect(sender.onlinePeerIds()).toEqual([second.nodeId]);
    await waitUntil(() => current !== undefined && current.signal.aborted && !current.isCurrent());
    expect(current!.signal.aborted).toBe(true);
    release();
    await waitUntil(() => finished);
    expect(committed).toBe(false);
  });

  it.each(["grant", "key", "purpose"] as const)("does not authenticate presence from a reachable peer with a different %s authority", { timeout: 10_000 }, async (change) => {
    const first = identity("first");
    const second = identity("second");
    const pinnedSecond = change === "key" ? identity("second") : second;
    const receiverPort = await freePort();
    let frames = 0;
    let candidates = 0;
    const receiver = direct(second, receiverPort, [], first, {
      purpose: change === "purpose" ? "contacts" : "voice-dictionary",
      isPeerAllowed: (nodeId, publicKey) => change !== "grant" && nodeId === first.nodeId && publicKey === first.publicKey,
      onFrame: () => { frames += 1; }
    });
    const sender = direct(first, await freePort(), [endpoint(pinnedSecond, receiverPort)], pinnedSecond, {
      onCandidate: () => { candidates += 1; }
    });
    await receiver.start();
    await sender.start();
    expect(sender.eligiblePeerIds()).toEqual([second.nodeId]);
    expect(await sender.probe(second.nodeId)).toBe(false);
    expect(sender.onlinePeerIds()).toEqual([]);
    expect(sender.candidates()).toEqual([]);
    expect(candidates).toBe(0);
    expect(frames).toBe(0);
  });

  it("queues every eligible peer fairly with at most eight probes and one probe per peer", { timeout: 10_000 }, async () => {
    const first = identity("first");
    const pendingServer = await blackhole();
    const endpoints = Array.from({ length: 12 }, (_, index) => endpoint(identity(`peer-${index}`), pendingServer.port));
    const sender = direct(first, await freePort(), endpoints, identity("unused"), {
      isPeerAllowed: () => true,
      connectTimeoutMilliseconds: 600
    });
    await sender.start();
    const probes = endpoints.map((peer) => sender.probe(peer.nodeId));
    await waitUntil(() => pendingServer.accepted >= 8);
    expect(pendingServer.accepted).toBe(8);
    expect(pendingServer.maxActive).toBeLessThanOrEqual(8);
    expect(await Promise.all(probes)).toEqual(Array<boolean>(12).fill(false));
    await waitUntil(() => pendingServer.active === 0);
    expect(pendingServer.accepted).toBe(12);
    expect(pendingServer.maxActive).toBeLessThanOrEqual(8);
    expect(sender.eligiblePeerIds()).toHaveLength(12);
    expect(sender.onlinePeerIds()).toEqual([]);
  });

  it("rejects unbounded route configuration and a conflicting stable listener", { timeout: 10_000 }, async () => {
    const first = identity("first");
    const second = identity("second");
    const port = await freePort();
    const peer = endpoint(second, port);
    for (const options of [
      { probeIntervalMilliseconds: Number.POSITIVE_INFINITY },
      { probeIntervalMilliseconds: 4_999 },
      { presenceTtlMilliseconds: 4_999 },
      { retryCooldownMilliseconds: Number.NaN },
      { getEndpoints: () => [peer, peer] },
      { getEndpoints: () => [{ ...peer, port: 0 }] },
      { getEndpoints: () => [{ ...peer, revision: 0n }] },
      { getEndpoints: () => [{ ...peer, revision: -1n }] },
      { getEndpoints: () => Array.from({ length: 129 }, (_, index) => ({ ...peer, nodeId: `node-${index}` })) }
    ]) expect(() => direct(first, port, [peer], second, options)).toThrow(TypeError);
    const receiver = direct(second, port, [], first);
    await receiver.start();
    const conflicting = direct(first, port, [], second);
    await expect(conflicting.start()).rejects.toThrow();
    expect(conflicting.listenerPort()).toBeUndefined();
    expect(conflicting.onlinePeerIds()).toEqual([]);
    expect(receiver.listenerPort()).toBe(port);
  });
});

function identity(name: string): NodeSyncTcpIdentity {
  return { nodeId: `node-${name}`, displayName: name, ...generateNodeSyncIdentity() };
}

function endpoint(peer: NodeSyncTcpIdentity, port: number, revision = 1n): NodeSyncDirectEndpoint {
  return { nodeId: peer.nodeId, displayName: peer.displayName, publicKey: peer.publicKey, host: "127.0.0.1", port, revision };
}

function direct(self: NodeSyncTcpIdentity, listenPort: number, endpoints: readonly NodeSyncDirectEndpoint[], peer: NodeSyncTcpIdentity,
  options: Partial<NodeSyncDirectTransportOptions> = {}): NodeSyncDirectTransport {
  const transport = new NodeSyncDirectTransport({
    purpose: "voice-dictionary", getSelf: () => self,
    isPeerAllowed: (nodeId, publicKey) => nodeId === peer.nodeId && publicKey === peer.publicKey,
    getEndpoints: () => endpoints, listenPort, listenHost: "127.0.0.1", onCandidate: () => undefined,
    onFrame: () => undefined, logger: { debug: () => undefined, warn: () => undefined }, ...options
  });
  cleanups.push(() => transport.stop());
  return transport;
}

function encryptedFrame(first: NodeSyncTcpIdentity, second: NodeSyncTcpIdentity, purpose: NodeSyncPurpose = "voice-dictionary"): NodeSyncCipherChunkFrame {
  const transferId = "transfer-1";
  const encrypted = encryptNodeSyncBytes(purpose, Buffer.from("private document"), first.privateKey, second.publicKey,
    { sourceNodeId: first.nodeId, destinationNodeId: second.nodeId, transferId, totalChunks: 1 });
  return { version: 1, type: "cipher-chunk", senderPublicKey: first.publicKey, transferId, index: 0, total: 1,
    iv: encrypted.iv, tag: encrypted.tag, compression: "gzip", data: encrypted.ciphertext.toString("base64") };
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: 0 }, resolve); });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return port;
}

async function blackhole(): Promise<{ readonly port: number; readonly active: number; readonly accepted: number; readonly maxActive: number }> {
  const sockets = new Set<Socket>();
  let accepted = 0;
  let maxActive = 0;
  const server = net.createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    maxActive = Math.max(maxActive, sockets.size);
    socket.on("data", () => undefined);
    socket.on("error", () => undefined);
    socket.on("close", () => { sockets.delete(socket); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: 0 }, resolve); });
  const port = (server.address() as net.AddressInfo).port;
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port, get active() { return sockets.size; }, get accepted() { return accepted; }, get maxActive() { return maxActive; } };
}

async function waitUntil(condition: () => boolean, timeout = 3_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Node sync direct observation timed out.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function settlesPromptly(promise: Promise<boolean>): Promise<boolean | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 300); });
  try { return await Promise.race([promise, timeout]); } finally { if (timer !== undefined) clearTimeout(timer); }
}
