import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ noise: vi.fn(), fetch: vi.fn(), open: vi.fn() }));
vi.mock('@jokoagent/linkspan-noise', () => ({ connectWebSocket: state.noise }));
vi.mock('@jokoagent/linkspan-http', () => ({ createHttpFetch: (options: { connect: (options: object) => Promise<unknown> }) => async (...args: unknown[]) => {
  await options.connect({}); return state.fetch(...args);
} }));
vi.mock('@jokoagent/linkspan-webrtc', () => ({ openWebRtcChannel: state.open }));
import { connectWebRtcEndpoint, webRtcFingerprint } from './webrtc.js';
const fingerprint = Array(32).fill('AB').join(':'), other = Array(32).fill('CD').join(':');
const sdp = (value: string) => `v=0\r\na=fingerprint:sha-256 ${value}\r\n`;
const origin = 'https://trusted-signaling.example', pin = `ed25519:${'a'.repeat(64)}`;
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

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
  await expect(connectWebRtcEndpoint({ origin, expectedPublicKey: pin })).resolves.toBe(channel);
  expect(peer.createDataChannel).toHaveBeenCalledWith('linkspan-http', { ordered: true });
  expect(state.noise).toHaveBeenCalledWith(expect.objectContaining({ expectedPublicKey: pin, url: `${origin.replace('https:', 'wss:')}/_linkspan` }));
  const request = state.fetch.mock.calls[0]!;
  expect(request[0]).toBe(`${origin}/_linkspan/webrtc`);
  expect(JSON.parse(request[1].body)).toEqual({ offer: peer.localDescription });
  expect(request[1].headers).toEqual({ 'content-type': 'application/json' });
  expect(state.open).toHaveBeenCalledWith(expect.objectContaining({ peerConnection: peer, expectedFingerprint: other, ownsPeerConnection: true }));
  expect(direct).not.toHaveBeenCalled();
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
