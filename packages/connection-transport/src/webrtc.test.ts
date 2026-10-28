import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ noise: vi.fn(), fetch: vi.fn(), open: vi.fn() }));
vi.mock('@jokoagent/linkspan-noise', () => ({ connectWebSocket: state.noise }));
vi.mock('@jokoagent/linkspan-http', () => ({ createHttpFetch: (options: { connect: (options: object) => Promise<unknown> }) => async (...args: unknown[]) => {
  await options.connect({}); return state.fetch(...args);
} }));
vi.mock('@jokoagent/linkspan-webrtc', () => ({ openWebRtcChannel: state.open }));
import { boundWebRtcRecordWrites, connectWebRtcEndpoint, webRtcFingerprint, WEBRTC_RECORD_WRITE_TIMEOUT_MS } from './webrtc.js';
import type { ByteChannel, OperationOptions } from '@jokoagent/linkspan-core';
const fingerprint = Array(32).fill('AB').join(':'), other = Array(32).fill('CD').join(':');
const sdp = (value: string) => `v=0\r\na=fingerprint:sha-256 ${value}\r\n`;
const origin = 'https://trusted-signaling.example', pin = `ed25519:${'a'.repeat(64)}`;
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function fixture() {
  const peer = { localDescription: { type: 'offer', sdp: sdp(fingerprint) }, iceGatheringState: 'complete',
    createDataChannel: vi.fn(() => ({})), createOffer: vi.fn(async () => ({ type: 'offer', sdp: sdp(fingerprint) })),
    setLocalDescription: vi.fn(async () => undefined), setRemoteDescription: vi.fn(async () => undefined), close: vi.fn() };
  vi.stubGlobal('RTCPeerConnection', class { constructor() { return peer; } });
  state.fetch.mockResolvedValue(Response.json({ answer: { type: 'answer', sdp: sdp(other) } }));
  state.noise.mockResolvedValue({});
  const channel = { closed: Promise.resolve({}), send: vi.fn(), receive: vi.fn(), close: vi.fn(), abort: vi.fn() };
  state.open.mockResolvedValue(channel);
  return { peer, channel };
}

it('requires a complete, consistent SHA-256 identity from trusted signaling', () => {
  expect(webRtcFingerprint(sdp(fingerprint))).toBe(fingerprint);
  expect(webRtcFingerprint(sdp(fingerprint) + `a=fingerprint:sha-256 ${fingerprint.toLowerCase()}\r\n`)).toBe(fingerprint);
  for (const value of ['', sdp(fingerprint) + `a=fingerprint:sha-256 ${other}\r\n`, 'a=fingerprint:sha-1 AA:BB\r\n', 'x'.repeat(65537)]) expect(() => webRtcFingerprint(value)).toThrow();
});

it('pins Noise signaling before accepting the DTLS peer and sends no business credential in signaling', async () => {
  const { peer, channel } = fixture();
  const direct = vi.fn(); vi.stubGlobal('fetch', direct);
  const connected = await connectWebRtcEndpoint({ origin, expectedPublicKey: pin });
  expect(connected.closed).toBe(channel.closed);
  expect(peer.createDataChannel).toHaveBeenCalledWith('linkspan-http', { ordered: true });
  expect(state.noise).toHaveBeenCalledWith(expect.objectContaining({ expectedPublicKey: pin, url: `${origin.replace('https:', 'wss:')}/_linkspan` }));
  const request = state.fetch.mock.calls[0]!;
  expect(request[0]).toBe(`${origin}/_linkspan/webrtc`);
  expect(JSON.parse(request[1].body)).toEqual({ offer: peer.localDescription });
  expect(request[1].headers).toEqual({ 'content-type': 'application/json' });
  expect(state.open).toHaveBeenCalledWith(expect.objectContaining({ peerConnection: peer, expectedFingerprint: other, ownsPeerConnection: true }));
  expect(direct).not.toHaveBeenCalled();
});

it('retires a blocked complete record without replay and gives each large-result record its own write budget', async () => {
  vi.useFakeTimers();
  const sent: Uint8Array[] = [];
  const abort = vi.fn();
  let stalled = false;
  const channel: ByteChannel = { closed: new Promise(() => {}), abort, close: vi.fn(async () => {}), receive: vi.fn(async () => null),
    send: vi.fn(async (bytes: Uint8Array, options: OperationOptions = {}) => {
      sent.push(bytes);
      if (stalled) return new Promise<void>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }));
      await new Promise<void>(resolve => setTimeout(resolve, WEBRTC_RECORD_WRITE_TIMEOUT_MS - 1));
    }) };
  const bound = boundWebRtcRecordWrites(channel);
  // Total transfer time exceeds a write deadline; bounded progress remains valid.
  for (let i = 0; i < 3; i++) {
    const record = bound.send(new Uint8Array(65_000).fill(i));
    await vi.advanceTimersByTimeAsync(WEBRTC_RECORD_WRITE_TIMEOUT_MS - 1);
    await record;
  }
  expect(abort).not.toHaveBeenCalled();
  stalled = true;
  const blocked = bound.send(new Uint8Array([9]));
  const failure = expect(blocked).rejects.toMatchObject({ code: 'deadline_exceeded' });
  await vi.advanceTimersByTimeAsync(WEBRTC_RECORD_WRITE_TIMEOUT_MS);
  await failure;
  expect(sent).toHaveLength(4); expect(abort).toHaveBeenCalledOnce();
});

it('honors a shorter caller deadline and cancellation while a record is blocked', async () => {
  vi.useFakeTimers();
  const abort = vi.fn();
  const channel = { closed: new Promise(() => {}), abort, close: vi.fn(), receive: vi.fn(), send: vi.fn(() => new Promise<void>(() => {})) } as ByteChannel;
  const bound = boundWebRtcRecordWrites(channel);
  const pending = bound.send(new Uint8Array([1]), { deadline: Date.now() + 25 });
  const failed = expect(pending).rejects.toMatchObject({ code: 'deadline_exceeded' });
  await vi.advanceTimersByTimeAsync(25); await failed;
  const cancelled = new AbortController();
  const next = bound.send(new Uint8Array([2]), { signal: cancelled.signal });
  const stopped = expect(next).rejects.toMatchObject({ code: 'cancelled' });
  cancelled.abort(); await stopped;
  expect(channel.send).toHaveBeenCalledTimes(2); expect(abort).toHaveBeenCalledTimes(2);
});

it('closes the peer on a failed pin and never opens a business channel', async () => {
  const { peer } = fixture(); state.noise.mockRejectedValueOnce(new Error('identity mismatch'));
  await expect(connectWebRtcEndpoint({ origin, expectedPublicKey: pin })).rejects.toBeDefined();
  expect(peer.close).toHaveBeenCalledOnce(); expect(state.fetch).not.toHaveBeenCalled(); expect(state.open).not.toHaveBeenCalled();
});

it('rejects an untrusted or oversized answer without exposing the data channel', async () => {
  const { peer } = fixture();
  state.fetch.mockResolvedValueOnce(Response.json({ answer: { type: 'answer', sdp: sdp(other) + `a=fingerprint:sha-256 ${fingerprint}\r\n` } }));
  await expect(connectWebRtcEndpoint({ origin, expectedPublicKey: pin })).rejects.toMatchObject({ code: 'authentication_failed' });
  expect(peer.setRemoteDescription).not.toHaveBeenCalled(); expect(peer.close).toHaveBeenCalledOnce();
  expect(state.open).not.toHaveBeenCalled();
  state.fetch.mockResolvedValueOnce(new Response('x'.repeat(65537)));
  await expect(connectWebRtcEndpoint({ origin, expectedPublicKey: pin })).rejects.toMatchObject({ code: 'resource_exhausted' });
});
