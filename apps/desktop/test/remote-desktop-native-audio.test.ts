import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopRemoteDesktopCaptureCommand, DesktopRemoteDesktopCaptureReply } from "../src/remote-desktop-capture-protocol.js";
import { desktopRemoteDesktopVideoProfile } from "../src/remote-desktop-quality.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); vi.useRealTimers(); });
class Track {
  readyState = "live"; onended: (() => void) | null = null; onmute: (() => void) | null = null; contentHint = "";
  constructor(readonly kind: "video" | "audio") {}
  stop = vi.fn(() => { this.readyState = "ended"; });
  end() { this.readyState = "ended"; this.onended?.(); }
}
class Stream {
  constructor(readonly tracks: Track[] = []) {}
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter(track => track.kind === "video"); }
  getAudioTracks() { return this.tracks.filter(track => track.kind === "audio"); }
  addTrack(track: Track) { this.tracks.push(track); }
  removeTrack(track: Track) { const index = this.tracks.indexOf(track); if (index >= 0) this.tracks.splice(index, 1); }
}

async function harness() {
  let listener!: (_event: unknown, value: DesktopRemoteDesktopCaptureCommand) => void;
  const replies: { readonly id: string; readonly value: DesktopRemoteDesktopCaptureReply }[] = [];
  const contexts: Context[] = []; const peers: Peer[] = [];
  const pcm = vi.fn<() => Promise<Uint8Array>>(async () => new Uint8Array(8));
  const getDisplayMedia = vi.fn(async () => { throw new Error("unexpected Chromium capture"); });
  class Source {
    buffer: unknown; onended: (() => void) | null = null;
    connect = vi.fn(); disconnect = vi.fn(); start = vi.fn(); stop = vi.fn();
  }
  class Context {
    currentTime = 0; readonly destination = Object.freeze({ hostSpeaker: true });
    readonly output = { stream: new Stream([new Track("audio")]) };
    readonly sources: Source[] = []; readonly buffers: Float32Array[][] = [];
    constructor(readonly options: unknown) { contexts.push(this); }
    resume = vi.fn(async () => undefined); close = vi.fn(async () => undefined);
    createMediaStreamDestination() { return this.output; }
    createBuffer(channels: number, frames: number, sampleRate: number) {
      expect(channels).toBe(2); expect(sampleRate).toBe(48_000);
      const data = Array.from({ length: channels }, () => new Float32Array(frames)); this.buffers.push(data);
      return { getChannelData: (channel: number) => data[channel]! };
    }
    createBufferSource() { const source = new Source(); this.sources.push(source); return source; }
  }
  class Sender {
    track: Track | null = null; setStreams = vi.fn();
    replaceTrack = vi.fn(async (track: Track | null) => { this.track = track; });
    getParameters() { return { encodings: [] }; }
    setParameters = vi.fn(async () => undefined);
  }
  class Peer {
    closed = false; localDescription = { sdp: "answer" }; connectionState = "new";
    readonly audio = new Sender(); readonly video = new Sender();
    readonly transceiver = { receiver: { track: new Track("audio") }, sender: this.audio, direction: "recvonly" };
    constructor() { peers.push(this); }
    close() { this.closed = true; }
    addTrack(track: Track) { this.video.track = track; return this.video; }
    getSenders() { return [this.video, this.audio]; }
    getTransceivers() { return [this.transceiver]; }
    setRemoteDescription = vi.fn(async () => undefined);
    createAnswer = vi.fn(async () => ({ sdp: "answer" })); setLocalDescription = vi.fn(async () => undefined);
  }
  const ipc = { on: (_channel: string, fn: typeof listener) => { listener = fn; }, invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel.endsWith(":reply")) { replies.push({ id: args[0] as string, value: args[1] as DesktopRemoteDesktopCaptureReply }); return; }
    if (channel.endsWith(":native-audio")) return pcm();
    if (channel.endsWith(":native-frame")) return { jpeg: "AQ==", width: 1, height: 1, cursor: null };
    return;
  }) };
  const source = await readFile(new URL("../src/remote-desktop-capture-preload.cts", import.meta.url), "utf8");
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
  const exposed: { nativeAudioStream?: (read: () => Promise<Uint8Array>, current: () => boolean, signal: AbortSignal) => Promise<{ track: Track; stop(): void }> } = {};
  runInNewContext(`${compiled}\nexports.nativeAudioStream = nativeAudioStream;`, {
    require: () => ({ ipcRenderer: ipc }), exports: exposed, window: { addEventListener: vi.fn() },
    navigator: { mediaDevices: { getDisplayMedia } }, RTCPeerConnection: Peer, AudioContext: Context,
    Uint8Array, Float32Array, DataView, Blob, AbortController, performance: { now: () => Date.now() },
    atob: (text: string) => Buffer.from(text, "base64").toString("latin1"),
    createImageBitmap: async () => ({ width: 1, height: 1, close: vi.fn() }),
    document: { createElement: () => ({ width: 1, height: 1,
      getContext: () => ({ drawImage: vi.fn(), clearRect: vi.fn(),
        getImageData: () => ({ data: new Uint8ClampedArray(64 * 36 * 4) }) }),
      captureStream: () => new Stream([new Track("video")]) }) },
    setTimeout, clearTimeout, setInterval, clearInterval
  });
  const command = (value: DesktopRemoteDesktopCaptureCommand) => listener({}, value);
  cleanup.push(() => command({ op: "stop" }));
  const scheduler = exposed.nativeAudioStream!;
  const offer = (id = "attempt", nativeAudio = true) => command({ op: "offer", id, leaseId: "lease", attemptId: id,
    offerSdp: "offer", iceServers: [], nativeCapture: true, nativeVideo: true, chromiumCapture: false,
    portalCapture: false, cursorOverlay: false, sourceRevision: 0,
    settings: { fps: 30, quality: "auto", audio: true },
    ...(nativeAudio ? { nativeAudio: true, audioRevision: 1 } : {}),
    profile: desktopRemoteDesktopVideoProfile({ fps: 30, quality: "auto", audio: true }) });
  return { contexts, peers, ipc, pcm, replies, scheduler, offer, command, getDisplayMedia };
}
function floats(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4); const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true)); return bytes;
}

describe("isolated native PCM scheduler", () => {
  it("uses 48k stereo little-endian finite clamping and connects only to the RTC stream destination", async () => {
    const h = await harness(); const controller = new AbortController();
    const value = await h.scheduler(async () => floats([2, -2, Number.NaN, 0.25]), () => true, controller.signal);
    cleanup.push(value.stop);
    const context = h.contexts[0]!; expect(context.options).toEqual({ sampleRate: 48_000, latencyHint: "interactive" });
    expect([...context.buffers[0]![0]!]).toEqual([1, 0]); expect([...context.buffers[0]![1]!]).toEqual([-1, 0.25]);
    expect(context.sources[0]!.connect).toHaveBeenCalledExactlyOnceWith(context.output);
    expect(context.sources[0]!.connect).not.toHaveBeenCalledWith(context.destination);
    controller.abort(); expect(context.close).toHaveBeenCalledOnce(); expect(value.track.stop).toHaveBeenCalledOnce();
  });

  it.each([{ bytes: 1 }, { bytes: 38_408 }])("rejects malformed or excessive $bytes-byte PCM without an audio effect", async ({ bytes }) => {
    const h = await harness();
    await expect(h.scheduler(async () => new Uint8Array(bytes), () => true, new AbortController().signal)).rejects.toThrow("audio-unavailable");
    expect(h.contexts[0]!.sources).toHaveLength(0); expect(h.contexts[0]!.close).toHaveBeenCalledOnce();
  });

  it("keeps only one poll in flight and discards late PCM immediately after the captured abort", async () => {
    vi.useFakeTimers(); const h = await harness(); let complete!: (bytes: Uint8Array) => void;
    const read = vi.fn(async (): Promise<Uint8Array> => new Uint8Array(0));
    read.mockImplementationOnce(async () => new Uint8Array(0)).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const controller = new AbortController(); const value = await h.scheduler(read, () => true, controller.signal); cleanup.push(value.stop);
    await vi.advanceTimersByTimeAsync(20); await vi.advanceTimersByTimeAsync(100); expect(read).toHaveBeenCalledTimes(2);
    controller.abort(); expect(h.contexts[0]!.close).toHaveBeenCalledOnce();
    complete(floats([0.5, 0.5])); await vi.advanceTimersByTimeAsync(100);
    expect(h.contexts[0]!.sources).toHaveLength(0); expect(read).toHaveBeenCalledTimes(2);
  });

  it("drops scheduled history after 150ms of backlog and stops every captured resource", async () => {
    vi.useFakeTimers(); const h = await harness(); const controller = new AbortController();
    const value = await h.scheduler(async () => new Uint8Array(38_400), () => true, controller.signal); cleanup.push(value.stop);
    await vi.advanceTimersByTimeAsync(40);
    const context = h.contexts[0]!; expect(context.sources).toHaveLength(3);
    expect(context.sources[0]!.stop).toHaveBeenCalledOnce(); expect(context.sources[1]!.stop).toHaveBeenCalledOnce();
    controller.abort(); expect(context.sources[2]!.stop).toHaveBeenCalledOnce(); expect(context.close).toHaveBeenCalledOnce();
  });
});

describe("native optional audio in the actual capture preload", () => {
  it("answers video after initial audio failure and fills its reserved sender through same-peer soft reset", async () => {
    const h = await harness(); h.pcm.mockRejectedValueOnce(new Error("REMOTE_DESKTOP_AUDIO_UNAVAILABLE")); h.offer();
    await vi.waitFor(() => expect(h.replies).toContainEqual({ id: "attempt", value: { kind: "offer", answerSdp: "answer" } }));
    const peer = h.peers[0]!; expect(peer.closed).toBe(false); expect(peer.transceiver.direction).toBe("sendonly");
    expect(peer.audio.setStreams).toHaveBeenCalledOnce(); expect(peer.audio.track).toBeNull(); expect(h.getDisplayMedia).not.toHaveBeenCalled();
    h.command({ op: "nativeAudio", leaseId: "lease", attemptId: "attempt", audioRevision: 2, enabled: true });
    await vi.waitFor(() => expect(peer.audio.track?.kind).toBe("audio")); expect(h.peers).toHaveLength(1);
    peer.audio.track!.end(); expect(peer.closed).toBe(false); expect(peer.video.track?.readyState).toBe("live");
  });

  it("an old pending PCM reset cannot install a track after off, replacement or late receipt", async () => {
    const h = await harness(); let complete!: (bytes: Uint8Array) => void;
    h.pcm.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; })); h.offer();
    await vi.waitFor(() => expect(h.peers).toHaveLength(1)); await vi.waitFor(() => expect(h.pcm).toHaveBeenCalledOnce());
    const peer = h.peers[0]!;
    h.command({ op: "nativeAudio", leaseId: "lease", attemptId: "attempt", audioRevision: 1, enabled: false });
    complete(floats([0.5, 0.5])); await Promise.resolve(); await Promise.resolve();
    expect(peer.audio.track).toBeNull(); expect(peer.closed).toBe(false); expect(h.contexts[0]!.close).toHaveBeenCalledOnce();
    h.command({ op: "nativeAudio", leaseId: "other", attemptId: "old", audioRevision: 9, enabled: true });
    expect(h.pcm).toHaveBeenCalledOnce();
  });

  it("clears a native session source and softly resumes video and audio on the same peer", async () => {
    const h = await harness(); h.offer();
    await vi.waitFor(() => expect(h.peers[0]?.audio.track?.kind).toBe("audio")); const peer = h.peers[0]!;
    const original = peer.video.track!;
    h.command({ op: "nativeAudio", leaseId: "lease", attemptId: "attempt", audioRevision: 1, enabled: false });
    h.command({ op: "captureReset", leaseId: "lease", attemptId: "attempt", sourceRevision: 1, resume: false });
    expect(original.readyState).toBe("ended"); expect(peer.closed).toBe(false);
    h.command({ op: "captureReset", leaseId: "lease", attemptId: "attempt", sourceRevision: 2, resume: true });
    await vi.waitFor(() => expect(peer.video.replaceTrack).toHaveBeenCalledOnce());
    h.command({ op: "nativeAudio", leaseId: "lease", attemptId: "attempt", audioRevision: 2, enabled: true });
    await vi.waitFor(() => expect(peer.audio.track?.readyState).toBe("live"));
    expect(peer.video.track).not.toBe(original); expect(peer.closed).toBe(false); expect(h.peers).toHaveLength(1);
    expect(h.replies.filter(reply => reply.value.kind === "offer")).toHaveLength(1);
  });

  it("reserves silent loopback audio without reading the native PCM channel", async () => {
    const h = await harness(); h.offer("required", false);
    await vi.waitFor(() => expect(h.replies).toContainEqual({ id: "required", value: { kind: "offer", answerSdp: "answer" } }));
    expect(h.pcm).not.toHaveBeenCalled(); expect(h.peers[0]!.closed).toBe(false);
    expect(h.peers[0]!.transceiver.direction).toBe("sendonly");
  });
});
