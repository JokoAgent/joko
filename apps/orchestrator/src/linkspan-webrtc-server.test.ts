import { afterEach, expect, it, vi } from "vitest";
import { OperationalStore } from "@joko/store";
import { ConnectionManager } from "./connection-manager.js";
import { LinkspanWebRtcSignaling } from "./linkspan-webrtc-server.js";
import type { OrchestratorApplication } from "./application.js";
import type { openWebRtcChannel } from "@jokoagent/linkspan-webrtc";

const fingerprint = Array(32).fill("AB").join(":");
const sdp = `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${fingerprint}\r\n`;
const offer = { offer: { type: "offer", sdp } };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
class Peer extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription = { type: "answer", sdp };
  readonly close = vi.fn(async () => {});
  readonly setRemoteDescription = vi.fn(async (_description: unknown) => {});
  readonly createAnswer = vi.fn(async () => this.localDescription);
  readonly setLocalDescription = vi.fn(async (_description: unknown) => {});
  rtc(): RTCPeerConnection { return this as unknown as RTCPeerConnection; }
}
function fixture() {
  const store = new OperationalStore(":memory:"), connections = new ConnectionManager(store);
  cleanups.push(() => store.close());
  const createPeer = vi.fn(() => new Peer().rtc());
  const signaling = new LinkspanWebRtcSignaling({ connections } as OrchestratorApplication, () => "http://127.0.0.1:1", { createPeer });
  cleanups.push(() => signaling.close());
  return { connections, createPeer, signaling };
}

it("loads the cold adapter before peer negotiation and queues records sent in the datachannel event", async () => {
  const f = fixture(), peer = new Peer(), records: number[] = [];
  let provide!: (value: { openWebRtcChannel: typeof openWebRtcChannel }) => void;
  let loading = false;
  const adapter = new Promise<{ openWebRtcChannel: typeof openWebRtcChannel }>(resolve => { provide = resolve; });
  vi.doMock("@jokoagent/linkspan-webrtc", async () => { loading = true; return adapter; });
  const data = Object.assign(new EventTarget(), { label: "linkspan-http", protocol: "", negotiated: false, ordered: true,
    maxPacketLifeTime: null, maxRetransmits: null, close: vi.fn() });
  const channel = { abort: vi.fn() } as unknown as Awaited<ReturnType<typeof openWebRtcChannel>>;
  const open = vi.fn((options: Parameters<typeof openWebRtcChannel>[0]) => {
    options.dataChannel.addEventListener("message", event => { records.push(new Uint8Array(event.data as ArrayBuffer)[0]!); });
    return Promise.resolve(channel);
  });
  let finish!: () => void;
  const serving = new Promise<void>(resolve => { finish = resolve; });
  const serve = vi.fn(async () => serving);
  const createPeer = vi.fn(() => peer.rtc());
  peer.setRemoteDescription.mockImplementation(async () => {
    const event = new Event("datachannel"); Object.assign(event, { channel: data }); peer.dispatchEvent(event);
    for (const kind of [0, 2]) data.dispatchEvent(new MessageEvent("message", { data: new Uint8Array([kind]).buffer }));
  });
  const signaling = new LinkspanWebRtcSignaling({ connections: f.connections } as OrchestratorApplication, () => "http://127.0.0.1:1", { createPeer, serve });
  const pending = signaling.exchange(offer, { signal: new AbortController().signal });
  try {
    await vi.waitFor(() => expect(loading).toBe(true));
    expect(createPeer).not.toHaveBeenCalled();
    provide({ openWebRtcChannel: open });
    await pending;
    expect(records).toEqual([0, 2]); expect(open).toHaveBeenCalledOnce(); expect(serve).toHaveBeenCalledOnce();
  } finally {
    provide({ openWebRtcChannel: open }); finish(); await pending.catch(() => {}); await signaling.close();
    vi.doUnmock("@jokoagent/linkspan-webrtc");
  }
});

it("rejects RTP, multiple SCTP sections, incomplete fingerprints and oversized descriptions before loading an engine", async () => {
  const f = fixture();
  for (const value of [null, {}, { ...offer, other: true }, { offer: { type: "answer", sdp } },
    { offer: { type: "offer", sdp: sdp.replace("m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "m=audio 9 UDP/TLS/RTP/SAVPF 111") } },
    { offer: { type: "offer", sdp: `${sdp}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n` } },
    { offer: { type: "offer", sdp: sdp.replace(fingerprint, "AB:CD") } },
    { offer: { type: "offer", sdp: `${sdp}a=fingerprint:sha-256 ${Array(32).fill("CD").join(":")}\r\n` } },
    { offer: { type: "offer", sdp: sdp + "a".repeat(65536) } }]) {
    await expect(f.signaling.exchange(value, { signal: new AbortController().signal })).rejects.toMatchObject({ statusCode: 400 });
  }
  expect(f.createPeer).not.toHaveBeenCalled();
});

it("bounds anonymous pending peers and closes all exact owners on service shutdown", async () => {
  const f = fixture(); const peers: Peer[] = [];
  f.createPeer.mockImplementation(() => { const peer = new Peer(); peers.push(peer); return peer.rtc(); });
  for (let index = 0; index < 32; index++) expect(await f.signaling.exchange(offer, { signal: new AbortController().signal })).toEqual({ answer: { type: "answer", sdp } });
  await expect(f.signaling.exchange(offer, { signal: new AbortController().signal })).rejects.toMatchObject({ statusCode: 429 });
  expect(f.createPeer).toHaveBeenCalledTimes(32);
  await f.signaling.close(); for (const peer of peers) expect(peer.close).toHaveBeenCalledOnce();
  await expect(f.signaling.exchange(offer, { signal: new AbortController().signal })).rejects.toMatchObject({ statusCode: 503 });
});

it("retires a pending peer immediately when its signaling owner is revoked and rejects invalid bearers", async () => {
  const f = fixture(); const peer = new Peer(); f.createPeer.mockReturnValue(peer.rtc());
  const challenge = f.connections.issuePairing("Trusted owner");
  const owner = f.connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Owner" });
  await f.signaling.exchange(offer, { signal: new AbortController().signal, authorization: `Bearer ${owner.authKey}` });
  f.connections.revoke(owner.connection.id); await vi.waitFor(() => expect(peer.close).toHaveBeenCalledOnce());
  await expect(f.signaling.exchange(offer, { signal: new AbortController().signal, authorization: `Bearer ${owner.authKey}` })).rejects.toMatchObject({ statusCode: 401 });
  expect(f.createPeer).toHaveBeenCalledOnce();
});

it("rejects a second data channel before it can dispatch business bytes", async () => {
  const f = fixture(), peer = new Peer();
  const serve = vi.fn(async () => {});
  const openChannel = vi.fn(async (options: Parameters<typeof openWebRtcChannel>[0]) => {
    expect(options.expectedFingerprint).toBe(fingerprint);
    await new Promise<never>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
    throw new Error("The original peer must be retired.");
  });
  const signaling = new LinkspanWebRtcSignaling({ connections: f.connections } as OrchestratorApplication, () => "http://127.0.0.1:1", { createPeer: () => peer.rtc(), openChannel, serve });
  cleanups.push(() => signaling.close());
  await signaling.exchange(offer, { signal: new AbortController().signal });
  const channel = () => ({ label: "linkspan-http", protocol: "", negotiated: false, ordered: true, maxPacketLifeTime: null, maxRetransmits: null, close: vi.fn() });
  const first = channel(), second = channel();
  const emit = (value: ReturnType<typeof channel>) => { const event = new Event("datachannel"); Object.assign(event, { channel: value }); peer.dispatchEvent(event); };
  emit(first); await vi.waitFor(() => expect(openChannel).toHaveBeenCalledOnce());
  emit(second); await vi.waitFor(() => expect(peer.close).toHaveBeenCalledOnce());
  expect(second.close).toHaveBeenCalledOnce(); expect(openChannel).toHaveBeenCalledOnce(); expect(serve).not.toHaveBeenCalled();
});

it("retires a late engine after signaling cancellation and rejects an unreliable data channel", async () => {
  const f = fixture(); const peer = new Peer(); f.createPeer.mockReturnValue(peer.rtc());
  await f.signaling.exchange(offer, { signal: new AbortController().signal });
  const channel = { label: "linkspan-http", protocol: "", negotiated: false, ordered: false, maxPacketLifeTime: null, maxRetransmits: null, close: vi.fn() };
  const event = new Event("datachannel"); Object.assign(event, { channel }); peer.dispatchEvent(event);
  await vi.waitFor(() => expect(peer.close).toHaveBeenCalledOnce()); expect(channel.close).toHaveBeenCalledOnce();
  let provide!: (peer: RTCPeerConnection) => void;
  const late = new Peer(), controller = new AbortController();
  const pendingEngine = new Promise<RTCPeerConnection>(resolve => { provide = resolve; });
  const createPeer = vi.fn(() => pendingEngine);
  const signaling = new LinkspanWebRtcSignaling({ connections: f.connections } as OrchestratorApplication, () => "http://127.0.0.1:1", { createPeer });
  cleanups.push(() => signaling.close());
  const pending = signaling.exchange(offer, { signal: controller.signal });
  const rejected = expect(pending).rejects.toBeDefined();
  await vi.waitFor(() => expect(createPeer).toHaveBeenCalledOnce());
  controller.abort(); await rejected; provide(late.rtc());
  await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce());
});
