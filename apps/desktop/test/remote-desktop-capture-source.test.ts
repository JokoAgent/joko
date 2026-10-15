import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REMOTE_DESKTOP_AUDIO_RETRY_MS, type DesktopRemoteDesktopCaptureCommand,
  type DesktopRemoteDesktopCaptureReply } from "../src/remote-desktop-capture-protocol.js";
import { desktopRemoteDesktopVideoProfile } from "../src/remote-desktop-quality.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });

describe("Remote Desktop active capture source", () => {
  it("answers with video after an initial audio failure and fills the negotiated sender with bounded retry", async () => {
    const h = await harness({ audio: true, capture: async () => { throw new Error("permission"); } });
    expect(h.audioTransceiver.direction).toBe("sendonly");
    expect(h.audioSender.setStreams).toHaveBeenCalled();
    expect(h.peerClose).not.toHaveBeenCalled();
    const recoveredAudio = track("audio"), unusedVideo = track();
    h.getDisplayMedia.mockResolvedValueOnce(new Stream([unusedVideo, recoveredAudio]));
    await h.retryAudio();
    await vi.waitFor(() => expect(h.audioSender.replaceTrack).toHaveBeenCalledWith(recoveredAudio));
    expect(unusedVideo.stop).toHaveBeenCalledOnce(); expect(recoveredAudio.stop).not.toHaveBeenCalled();
    expect(h.peerClose).not.toHaveBeenCalled(); expect(h.receipts).toHaveLength(1);
    h.command({ op: "stop" }); expect(recoveredAudio.stop).toHaveBeenCalled();
  });

  it("uses only the finite audio retry budget and keeps silent video alive when every attempt fails", async () => {
    const h = await harness({ audio: true });
    h.getDisplayMedia.mockRejectedValue(new Error("permission"));
    for (const delay of REMOTE_DESKTOP_AUDIO_RETRY_MS) { expect(h.nextAudioRetry()).toBe(delay); await h.retryAudio(); }
    expect(h.nextAudioRetry()).toBeUndefined(); expect(h.getDisplayMedia).toHaveBeenCalledTimes(4);
    expect(h.peerClose).not.toHaveBeenCalled(); expect(h.receipts).toHaveLength(1);
  });

  it("discards a late audio stream after stop without replacing the retired sender or reopening capture", async () => {
    const h = await harness({ audio: true });
    let finish!: (value: Stream) => void;
    h.getDisplayMedia.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await h.retryAudio(); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    h.command({ op: "stop" });
    const lateAudio = track("audio"), lateVideo = track(); finish(new Stream([lateVideo, lateAudio]));
    await vi.waitFor(() => expect(lateAudio.stop).toHaveBeenCalledOnce());
    expect(lateVideo.stop).toHaveBeenCalledOnce(); expect(h.audioSender.replaceTrack).not.toHaveBeenCalled();
    expect(h.nextAudioRetry()).toBeUndefined(); expect(h.getDisplayMedia).toHaveBeenCalledTimes(2);
  });

  it("does not overlap a timed out permission prompt, and stops its abandoned stream before retry", async () => {
    let finish!: (value: Stream) => void;
    const pending = new Promise<Stream>(resolve => { finish = resolve; });
    const starting = harness({ audio: true, capture: () => pending, expireInitialCapture: true });
    const h = await starting;
    expect(h.nextAudioRetry()).toBeUndefined(); expect(h.getDisplayMedia).toHaveBeenCalledOnce();
    const lateAudio = track("audio"), lateVideo = track(); finish(new Stream([lateVideo, lateAudio]));
    await vi.waitFor(() => expect(h.nextAudioRetry()).toBe(3_000));
    expect(lateAudio.stop).toHaveBeenCalledOnce(); expect(lateVideo.stop).toHaveBeenCalledOnce();
    h.command({ op: "stop" }); expect(h.nextAudioRetry()).toBeUndefined();
  });

  it("uses scoped TURN material and rejects credentials that become stale while acquiring the stream", async () => {
    const h = await harness();
    const iceServers = [{ urls: ["turn:relay.example.test:3478?transport=udp"],
      username: "ephemeral-user", credential: "ephemeral-secret" }];
    const offer = { op: "offer" as const, id: "configured", leaseId: "lease", attemptId: "configured", offerSdp: "offer",
      iceServers, iceExpiresAt: Date.now() + 300_000, nativeCapture: false, nativeVideo: false, chromiumCapture: true,
      portalCapture: false, sourceRevision: 0, cursorOverlay: false,
      profile: desktopRemoteDesktopVideoProfile({ fps: 30, quality: "auto", audio: false }) };
    h.command(offer);
    await vi.waitFor(() => expect(h.receipts.at(-1)).toMatchObject({ id: "configured", value: { kind: "offer" } }));
    expect(h.peerConfigurations.at(-1)).toEqual({ iceServers });
    const delayed = track();
    h.getDisplayMedia.mockImplementationOnce(async () => { h.setNow(offer.iceExpiresAt - 120_000); return new Stream([delayed]); });
    h.command({ ...offer, id: "stale", attemptId: "stale" });
    await vi.waitFor(() => expect(h.receipts.at(-1)).toMatchObject({ id: "stale", value: { kind: "error", code: "unavailable" } }));
    expect(h.peerConfigurations).toHaveLength(2);
    expect(delayed.stop).toHaveBeenCalledOnce();
  });

  it("waits for filtered pixels and sender replacement before acknowledging, then stops Chromium video", async () => {
    const h = await harness();
    let filtered!: (frame: typeof h.frame) => void;
    h.nativeRead.mockImplementationOnce(() => new Promise(resolve => { filtered = resolve; }));
    let replaced!: () => void;
    h.sender.replaceTrack.mockImplementationOnce(async track => {
      await new Promise<void>(resolve => { replaced = resolve; }); h.sender.track = track;
    });
    h.command({ op: "nativeSource", id: "source-1", leaseId: "lease", attemptId: "attempt", sourceRevision: 1 });
    await vi.waitFor(() => expect(h.nativeRead).toHaveBeenCalledOnce());
    expect(h.receipts).toHaveLength(1);
    expect(h.sender.replaceTrack).not.toHaveBeenCalled();
    filtered(h.frame);
    await vi.waitFor(() => expect(h.sender.replaceTrack).toHaveBeenCalledOnce());
    expect(h.draw).toHaveBeenCalled();
    expect(h.original.stop).not.toHaveBeenCalled();
    expect(h.receipts).toHaveLength(1);
    replaced();
    await vi.waitFor(() => expect(h.receipts.at(-1)).toEqual({ id: "source-1", value: { kind: "nativeSource", sourceRevision: 1 } }));
    expect(h.original.stop).toHaveBeenCalledOnce();
    expect(h.sender.track).toBe(h.nativeTracks[0]);
    expect(h.nativeRead.mock.calls[0]).toEqual(["lease", "attempt", 1]);
    h.command({ op: "nativeSource", id: "older", leaseId: "lease", attemptId: "attempt", sourceRevision: 0 });
    await vi.waitFor(() => expect(h.receipts.at(-1)).toMatchObject({ id: "older", value: { kind: "error" } }));
    expect(h.sender.replaceTrack).toHaveBeenCalledOnce();
  });

  it("does not acknowledge failed replacement or reopen Chromium as a fallback", async () => {
    const h = await harness();
    h.sender.replaceTrack.mockRejectedValueOnce(new Error("unavailable"));
    h.command({ op: "nativeSource", id: "failed", leaseId: "lease", attemptId: "attempt", sourceRevision: 1 });
    await vi.waitFor(() => expect(h.receipts.at(-1)).toMatchObject({ id: "failed", value: { kind: "error" } }));
    expect(h.getDisplayMedia).toHaveBeenCalledOnce();
    expect(h.original.stop).not.toHaveBeenCalled();
    expect(h.nativeTracks[0]!.stop).toHaveBeenCalled();
  });

  it("rejects a late first frame after the media occurrence is stopped", async () => {
    const h = await harness();
    let filtered!: (frame: typeof h.frame) => void;
    h.nativeRead.mockImplementationOnce(() => new Promise(resolve => { filtered = resolve; }));
    h.command({ op: "nativeSource", id: "retired", leaseId: "lease", attemptId: "attempt", sourceRevision: 1 });
    await vi.waitFor(() => expect(h.nativeRead).toHaveBeenCalledOnce());
    h.command({ op: "stop" });
    filtered(h.frame);
    await vi.waitFor(() => expect(h.receipts.at(-1)).toMatchObject({ id: "retired", value: { kind: "error" } }));
    expect(h.sender.replaceTrack).not.toHaveBeenCalled();
    expect(h.nativeTracks).toHaveLength(0);
  });
});

function track(kind = "video") {
  return { kind, stop: vi.fn(), onended: null, onmute: null, contentHint: "" };
}
type Track = ReturnType<typeof track>;
class Stream {
  constructor(readonly tracks: Track[]) {}
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter(item => item.kind === "video"); }
  getAudioTracks() { return this.tracks.filter(item => item.kind === "audio"); }
  addTrack(item: Track) { this.tracks.push(item); }
  removeTrack(item: Track) { const index = this.tracks.indexOf(item); if (index >= 0) this.tracks.splice(index, 1); }
}

async function harness(options: { audio?: boolean; capture?: () => Promise<Stream>; expireInitialCapture?: boolean } = {}) {
  let now = Date.now();
  const original = track();
  const sender = { track: original, replaceTrack: vi.fn(async (item: Track) => { sender.track = item; }),
    getParameters: () => ({ encodings: [] }), setParameters: vi.fn(async () => undefined) };
  const frame = { jpeg: "AQ==", width: 1, height: 1, cursor: null };
  const nativeRead = vi.fn<(...args: unknown[]) => Promise<typeof frame | null>>(async () => frame);
  const getDisplayMedia = vi.fn(async () => new Stream([original]));
  if (options.capture !== undefined) getDisplayMedia.mockImplementationOnce(options.capture);
  const audioSender = { track: null as Track | null, replaceTrack: vi.fn(async (item: Track) => { audioSender.track = item; }),
    setStreams: vi.fn() };
  const audioTransceiver = { receiver: { track: track("audio") }, sender: audioSender, direction: "recvonly" };
  const peerClose = vi.fn();
  const audioTimers = new Map<object, { readonly delay: number; readonly run: () => void }>();
  const nativeTracks: Track[] = [];
  const draw = vi.fn();
  const receipts: { id: string; value: DesktopRemoteDesktopCaptureReply }[] = [];
  const peerConfigurations: unknown[] = [];
  let listener!: (_event: unknown, command: DesktopRemoteDesktopCaptureCommand) => void;
  class Peer {
    constructor(configuration: unknown) { peerConfigurations.push(configuration); }
    localDescription = { sdp: "answer" };
    close = peerClose;
    getSenders = () => [sender, audioSender];
    getTransceivers = () => [audioTransceiver];
    addTrack = vi.fn();
    setRemoteDescription = async () => undefined;
    createAnswer = async () => ({ sdp: "answer", type: "answer" });
    setLocalDescription = async () => undefined;
  }
  const ipc = { on: (_channel: string, callback: typeof listener) => { listener = callback; },
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel.endsWith(":native-frame")) return nativeRead(...args);
      if (channel.endsWith(":reply")) receipts.push({ id: args[0] as string, value: args[1] as DesktopRemoteDesktopCaptureReply });
      return undefined;
    } };
  const source = await readFile(new URL("../src/remote-desktop-capture-preload.cts", import.meta.url), "utf8");
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
  runInNewContext(compiled, { require: () => ({ ipcRenderer: ipc }), exports: {},
    navigator: { mediaDevices: { getDisplayMedia } }, RTCPeerConnection: Peer,
    window: { addEventListener: vi.fn() },
    document: { createElement: () => ({ width: 1, height: 1,
      getContext: () => ({ drawImage: draw, clearRect: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(4) }) }),
      captureStream: () => { const item = track(); nativeTracks.push(item); return new Stream([item]); } }) },
    createImageBitmap: async () => ({ width: 1, height: 1, close: vi.fn() }),
    Blob, atob, Uint8Array, Uint8ClampedArray,
    setTimeout: (run: () => void, delay: number) => {
      if ((REMOTE_DESKTOP_AUDIO_RETRY_MS as readonly number[]).includes(delay)) {
        const token = {}; audioTimers.set(token, { delay, run }); return token;
      }
      if (options.expireInitialCapture && delay === 2_000) { queueMicrotask(run); return {}; }
      return setTimeout(run, delay);
    },
    clearTimeout: (token: ReturnType<typeof setTimeout> | object) => {
      if (!audioTimers.delete(token as object)) clearTimeout(token as ReturnType<typeof setTimeout>);
    }, setInterval, clearInterval,
    Date: class extends Date { static override now() { return now; } },
    performance: { now: () => Date.now() }, crypto: { randomUUID: () => "11111111-1111-4111-8111-111111111111" } });
  const command = (value: DesktopRemoteDesktopCaptureCommand) => listener({}, value);
  cleanup.push(() => command({ op: "stop" }));
  command({ op: "offer", id: "offer", leaseId: "lease", attemptId: "attempt", offerSdp: "offer", iceServers: [],
    nativeCapture: true, nativeVideo: false, chromiumCapture: true, portalCapture: false, sourceRevision: 0, cursorOverlay: false,
    ...(options.audio ? { settings: { fps: 30, quality: "auto", audio: true } as const } : {}),
    profile: desktopRemoteDesktopVideoProfile({ fps: 30, quality: "auto", audio: options.audio === true }) });
  await vi.waitFor(() => expect(receipts).toEqual([{ id: "offer", value: { kind: "offer", answerSdp: "answer" } }]));
  return { original, sender, frame, nativeRead, getDisplayMedia, nativeTracks, draw, receipts, command, peerConfigurations,
    audioSender, audioTransceiver, peerClose,
    nextAudioRetry: () => audioTimers.values().next().value?.delay,
    retryAudio: async () => {
      await vi.waitFor(() => expect(audioTimers.size).toBe(1));
      const [token, timer] = audioTimers.entries().next().value!; audioTimers.delete(token); timer.run();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    },
    setNow: (value: number) => { now = value; } };
}
