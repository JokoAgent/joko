import type { FastifyInstance } from "fastify";
import type { ByteChannel } from "@jokoagent/linkspan-core";
import type { openWebRtcChannel } from "@jokoagent/linkspan-webrtc";
import type { OrchestratorApplication } from "./application.js";
import { serveLinkspanChannel } from "./linkspan-server.js";
import { publishWebRtcConnectionEntry } from './connection-entries.js';

const MAXIMUM_PEERS = 32;
const MAXIMUM_SDP_BYTES = 64 * 1024;
const NEGOTIATION_MS = 15_000;
const ICE_GATHERING_MS = 10_000;
const DATA_LABEL = "linkspan-http";
const configuration: RTCConfiguration = { iceServers: [
  { urls: "stun:stun.cloudflare.com:3478" }, { urls: "stun:stun.l.google.com:19302" }
] };
interface PeerSession {
  readonly abort: AbortController;
  peer?: RTCPeerConnection;
  channel?: ByteChannel;
  timer?: ReturnType<typeof setTimeout>;
  removeEvents?: () => void;
  stopOwner?: () => void;
  closing?: Promise<void>;
}
interface SignalingDependencies {
  readonly createPeer?: (configuration: RTCConfiguration) => RTCPeerConnection | Promise<RTCPeerConnection>;
  readonly openChannel?: typeof openWebRtcChannel;
  readonly serve?: typeof serveLinkspanChannel;
}
class SignalingError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

/** This ephemeral transport never owns application state or media permission. */
export class LinkspanWebRtcSignaling {
  readonly #sessions = new Set<PeerSession>();
  #closed = false;
  constructor(private readonly application: OrchestratorApplication, private readonly backendOrigin: () => string,
    private readonly dependencies: SignalingDependencies = {}) {}

  async exchange(value: unknown, input: { readonly signal: AbortSignal; readonly authorization?: string }): Promise<{ answer: RTCSessionDescriptionInit }> {
    const { offer, fingerprint } = parseOffer(value);
    input.signal.throwIfAborted();
    if (this.#closed) throw new SignalingError(503, "The encrypted WebRTC endpoint is closed.");
    if (this.#sessions.size >= MAXIMUM_PEERS) throw new SignalingError(429, "The WebRTC endpoint has reached its connection limit.");
    let ownerId: string | undefined;
    if (input.authorization !== undefined) {
      try { ownerId = this.application.connections.authenticate(input.authorization).id; }
      catch { throw new SignalingError(401, "The connection credential is invalid or revoked."); }
    }
    const session: PeerSession = { abort: new AbortController() };
    this.#sessions.add(session);
    const retire = (): void => { void this.#retire(session).catch(() => {}); };
    const cancelNegotiation = (): void => { session.abort.abort(input.signal.reason); retire(); };
    input.signal.addEventListener("abort", cancelNegotiation, { once: true });
    session.timer = setTimeout(retire, NEGOTIATION_MS);
    try {
      if (ownerId !== undefined) {
        session.stopOwner = this.application.connections.onRevoked(ownerId, retire);
        try { if (this.application.connections.authenticate(input.authorization).id !== ownerId) throw new Error(); }
        catch { throw new SignalingError(401, "The connection credential is invalid or revoked."); }
      }
      // A remote peer can send its first record immediately after datachannel.
      // Load the selected adapter before accepting any peer events so its
      // synchronous constructor can install the receive queue in that event.
      const open: typeof openWebRtcChannel = this.dependencies.openChannel ?? await wait<typeof openWebRtcChannel>(
        import("@jokoagent/linkspan-webrtc").then(module => module.openWebRtcChannel), session.abort.signal);
      const loading = Promise.resolve().then(() => this.dependencies.createPeer?.(configuration) ?? defaultPeer(configuration));
      void loading.then(async peer => { if (session.abort.signal.aborted) await peer.close(); }).catch(() => {});
      const peer = await wait(loading, session.abort.signal); session.peer = peer;
      session.abort.signal.throwIfAborted();
      let accepted = false;
      const dataChannel = (event: RTCDataChannelEvent): void => {
        const data = event.channel;
        if (accepted || data.label !== DATA_LABEL || data.protocol !== "" || data.negotiated || !data.ordered
          || data.maxPacketLifeTime !== null || data.maxRetransmits !== null) { data.close(); retire(); return; }
        accepted = true;
        void (async () => {
          const channel = await open({ peerConnection: peer, dataChannel: data, expectedFingerprint: fingerprint,
            signal: session.abort.signal, ownsPeerConnection: true });
          session.channel = channel;
          session.abort.signal.throwIfAborted();
          clearTimeout(session.timer); session.timer = undefined;
          // HTTP metadata and body records are already smaller than the RTC
          // message bound. Preserve each complete record and the original gates.
          await (this.dependencies.serve ?? serveLinkspanChannel)(this.application, channel, this.backendOrigin(), session.abort.signal);
        })().catch(() => {}).finally(retire);
      };
      const connectionChanged = (): void => { if (peer.connectionState === "failed" || peer.connectionState === "closed") retire(); };
      peer.addEventListener("datachannel", dataChannel);
      peer.addEventListener("connectionstatechange", connectionChanged);
      peer.addEventListener("track", retire);
      session.removeEvents = () => {
        peer.removeEventListener("datachannel", dataChannel);
        peer.removeEventListener("connectionstatechange", connectionChanged);
        peer.removeEventListener("track", retire);
      };
      await wait(peer.setRemoteDescription(offer), session.abort.signal);
      const answer = await wait(peer.createAnswer(), session.abort.signal);
      await wait(peer.setLocalDescription(answer), session.abort.signal);
      await gatherIce(peer, session.abort.signal);
      const description = peer.localDescription;
      if (!description || description.type !== "answer") throw new Error("The WebRTC engine did not produce an answer.");
      validateSdp(description.sdp);
      session.abort.signal.throwIfAborted(); input.signal.throwIfAborted();
      return { answer: { type: "answer", sdp: description.sdp } };
    } catch (error) { await this.#retire(session); throw error; }
    finally { input.signal.removeEventListener("abort", cancelNegotiation); }
  }

  async close(): Promise<void> { this.#closed = true; await Promise.all([...this.#sessions].map(session => this.#retire(session))); }
  #retire(session: PeerSession): Promise<void> {
    return session.closing ??= Promise.resolve().then(async () => {
      clearTimeout(session.timer); session.timer = undefined;
      session.abort.abort(new Error("The original WebRTC transport was retired."));
      session.removeEvents?.(); session.stopOwner?.();
      try { session.channel?.abort(); }
      finally {
        try { await session.peer?.close(); }
        finally { this.#sessions.delete(session); }
      }
    });
  }
}

/** Only the process-owned decrypted HTTP bridge exposes signaling. The public
 * encrypted-only listener cannot offer an unauthenticated replacement answer. */
export function registerLinkspanWebRtcSignaling(server: FastifyInstance, application: OrchestratorApplication): void {
  let retire = () => {};
  server.addHook('onReady', async () => { if (application.store && application.config) retire = publishWebRtcConnectionEntry(application.store); });
  const signaling = new LinkspanWebRtcSignaling(application, () => {
    const address = server.server.address();
    if (address === null || typeof address === "string") throw new Error("The original encrypted HTTP bridge is unavailable.");
    return `http://127.0.0.1:${address.port}`;
  });
  server.post("/_linkspan/webrtc", { bodyLimit: MAXIMUM_SDP_BYTES }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const abort = new AbortController();
    const cancelled = (): void => { abort.abort(new Error("WebRTC signaling was cancelled.")); };
    const closed = (): void => { if (!reply.raw.writableFinished) cancelled(); };
    request.raw.once("aborted", cancelled); reply.raw.once("close", closed);
    try {
      return await signaling.exchange(request.body, { signal: abort.signal,
        ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }) });
    } catch (error) {
      return reply.code(error instanceof SignalingError ? error.statusCode : 503)
        .send({ error: error instanceof SignalingError ? error.message : "The selected WebRTC transport could not negotiate a secure data channel." });
    } finally { request.raw.removeListener("aborted", cancelled); reply.raw.removeListener("close", closed); }
  });
  server.addHook("preClose", async () => { retire(); await signaling.close(); });
}

async function defaultPeer(config: RTCConfiguration): Promise<RTCPeerConnection> {
  return (await import("@jokoagent/linkspan-webrtc-node")).createNodeWebRtcPeer(config);
}
function parseOffer(value: unknown): { offer: RTCSessionDescriptionInit; fingerprint: string } {
  if (!record(value) || Object.keys(value).join(",") !== "offer" || !record(value.offer) || Object.keys(value.offer).sort().join(",") !== "sdp,type"
    || value.offer.type !== "offer" || typeof value.offer.sdp !== "string") throw invalid();
  return { offer: { type: "offer", sdp: value.offer.sdp }, fingerprint: validateSdp(value.offer.sdp) };
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function invalid(): SignalingError { return new SignalingError(400, "WebRTC signaling requires one bounded data-only offer with a complete SHA-256 endpoint fingerprint."); }
function validateSdp(sdp: string): string {
  if (Buffer.byteLength(sdp) > MAXIMUM_SDP_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(sdp)) throw invalid();
  const lines = sdp.split(/\r?\n/u);
  const media = lines.filter(line => line.startsWith("m="));
  if (lines.length > 512 || lines.some(line => line.length > 4096) || media.length !== 1
    || !/^m=application [0-9]+ (?:UDP\/DTLS\/SCTP webrtc-datachannel|DTLS\/SCTP [0-9]+)$/u.test(media[0]!)
    || lines.filter(line => line.startsWith("a=candidate:")).length > 128) throw invalid();
  const fingerprints = new Set<string>();
  for (const line of lines.filter(line => line.startsWith("a=fingerprint:"))) {
    const fingerprint = /^a=fingerprint:sha-256 ((?:[a-f0-9]{2}:){31}[a-f0-9]{2})$/iu.exec(line)?.[1];
    if (fingerprint === undefined) throw invalid(); fingerprints.add(fingerprint.toUpperCase());
  }
  if (fingerprints.size !== 1) throw invalid();
  return [...fingerprints][0]!;
}
async function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let aborted!: () => void;
  const cancellation = new Promise<never>((_resolve, reject) => { aborted = () => reject(signal.reason); signal.addEventListener("abort", aborted, { once: true }); });
  try { return await Promise.race([promise, cancellation]); }
  finally { signal.removeEventListener("abort", aborted); }
}
async function gatherIce(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  let changed!: () => void; let abort!: () => void; let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      changed = () => { if (peer.iceGatheringState === "complete") resolve(); };
      abort = () => reject(signal.reason);
      peer.addEventListener("icegatheringstatechange", changed); signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => reject(new Error("WebRTC ICE gathering exceeded its bound.")), ICE_GATHERING_MS);
      if (signal.aborted) abort(); else changed();
    });
  } finally { if (timer !== undefined) clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", changed); signal.removeEventListener("abort", abort); }
}
