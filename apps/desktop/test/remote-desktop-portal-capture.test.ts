import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopRemoteDesktopCaptureCommand, DesktopRemoteDesktopCaptureReply } from "../src/remote-desktop-capture-protocol.js";
import { desktopRemoteDesktopVideoProfile } from "../src/remote-desktop-quality.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); vi.useRealTimers(); });

class Track {
  readonly kind = "video";
  readyState = "live";
  muted = false;
  contentHint = "";
  onended: (() => void) | null = null;
  onmute: (() => void) | null = null;
  readonly stop = vi.fn(() => { this.readyState = "ended"; });
  #ended: (() => void) | undefined;
  addEventListener(_event: string, callback: () => void) { this.#ended = callback; }
  end() { this.readyState = "ended"; this.#ended?.(); this.onended?.(); }
}
class Stream {
  readonly clones: Stream[] = [];
  constructor(readonly tracks = [new Track()]) {}
  get active() { return this.tracks.some(track => track.readyState === "live"); }
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return [...this.tracks]; }
  getAudioTracks() { return []; }
  clone() { const value = new Stream(); this.clones.push(value); return value; }
  removeTrack(track: Track) { this.tracks.splice(this.tracks.indexOf(track), 1); }
}

describe("lease-owned Wayland portal consent", () => {
  it("stops tracks immediately but holds its RTC owner until Main acknowledges the original UDP retirement", async () => {
    let acknowledge!: () => void;
    const h = await harness(() => new Promise<void>(resolve => { acknowledge = resolve; }));
    h.command({ op: "preparePortal", leaseId: "lease" }); h.grant(h.original); await drain(); h.offer("original-attempt"); await drain();
    const rtc = h.peers[0]!; h.original.clones[0]!.tracks[0]!.end(); await drain();
    expect(h.original.clones[0]!.tracks[0]!.stop).toHaveBeenCalled(); expect(rtc.close).not.toHaveBeenCalled(); expect(h.stopped).toContain("lease");
    acknowledge(); await drain(); expect(rtc.close).toHaveBeenCalledTimes(1);
  });

  it("quiesce retains the peer socket and only trusted Main stop can release it after cleanup", async () => {
    const h = await harness(); h.command({ op: "preparePortal", leaseId: "lease" }); h.grant(h.original); await drain(); h.offer("original-attempt"); await drain();
    const rtc = h.peers[0]!; h.command({ op: "quiesce" }); expect(rtc.close).not.toHaveBeenCalled(); expect(h.stopped).toEqual([]);
    h.command({ op: "stop" }); expect(rtc.close).toHaveBeenCalledTimes(1);
  });
  it("returns first-frame pending throughout local consent and uses only clones across ICE attempts", async () => {
    const h = await harness();
    h.command({ op: "preparePortal", leaseId: "lease" });
    h.command({ op: "frame", id: "pending", leaseId: "lease" }); await drain();
    expect(h.receipts.at(-1)).toEqual({ id: "pending", value: { kind: "frame", frame: null } });
    expect(h.getDisplayMedia).toHaveBeenCalledExactlyOnceWith({ audio: false, video: { frameRate: { ideal: 30, max: 60 } } });
    h.grant(h.original); await drain();
    h.command({ op: "frame", id: "pixels", leaseId: "lease" }); await drain();
    expect(h.receipts.at(-1)).toMatchObject({ id: "pixels", value: { kind: "frame", frame: { jpeg: "YWJj", width: 100, height: 50 } } });
    h.offer("one"); await drain();
    expect(h.receipts.at(-1)).toEqual({ id: "one", value: { kind: "offer", answerSdp: "answer" } });
    h.command({ op: "ice", id: "ice", leaseId: "lease", attemptId: "one", candidates: [], after: 0 }); await drain();
    expect(h.receipts.at(-1)).toMatchObject({ id: "ice", value: { kind: "ice", attemptId: "one" } });
    h.command({ op: "stop" }); h.offer("two"); await drain();
    expect(h.receipts.at(-1)).toEqual({ id: "two", value: { kind: "offer", answerSdp: "answer" } });
    expect(h.getDisplayMedia).toHaveBeenCalledOnce(); expect(h.original.clones).toHaveLength(2);
    expect(h.original.tracks[0]!.stop).not.toHaveBeenCalled();
    expect(h.original.clones[0]!.tracks[0]!.stop).toHaveBeenCalledOnce();
    h.unload(); expect(h.original.tracks[0]!.stop).toHaveBeenCalledOnce();
  });

  it("keeps denial sticky within the same lease instead of reopening the local picker", async () => {
    const h = await harness(); h.command({ op: "preparePortal", leaseId: "lease" });
    h.deny(new Error("permission denied")); await drain();
    for (const id of ["denied-one", "denied-two"]) {
      h.command({ op: "preparePortal", leaseId: "lease" });
      h.command({ op: "frame", id, leaseId: "lease" }); await drain();
      expect(h.receipts.at(-1)).toEqual({ id, value: { kind: "error", code: "unavailable" } });
    }
    expect(h.getDisplayMedia).toHaveBeenCalledOnce();
  });

  it("expires consent only at 120 seconds, ends that lease and stops a late grant", async () => {
    vi.useFakeTimers(); const h = await harness();
    h.command({ op: "preparePortal", leaseId: "lease" });
    await vi.advanceTimersByTimeAsync(119_999); expect(h.stopped).toEqual([]);
    h.command({ op: "frame", id: "still-pending", leaseId: "lease" }); await drain();
    expect(h.receipts.at(-1)).toEqual({ id: "still-pending", value: { kind: "frame", frame: null } });
    await vi.advanceTimersByTimeAsync(1); expect(h.stopped).toEqual(["lease"]);
    h.grant(h.original); await drain();
    expect(h.original.tracks[0]!.stop).toHaveBeenCalledOnce();
    h.command({ op: "frame", id: "retired", leaseId: "lease" }); await drain();
    expect(h.receipts.at(-1)).toEqual({ id: "retired", value: { kind: "error", code: "stopped" } });
  });

  it("stops late tracks after window retirement and binds actual track-ended to the original lease", async () => {
    const old = await harness(); old.command({ op: "preparePortal", leaseId: "old" }); old.unload();
    old.grant(old.original); await drain(); expect(old.original.tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(old.stopped).toEqual([]);
    const live = await harness(); live.command({ op: "preparePortal", leaseId: "new" });
    live.grant(live.original); await drain(); live.original.tracks[0]!.end(); await drain();
    expect(live.stopped).toEqual(["new"]); expect(live.original.tracks[0]!.stop).toHaveBeenCalledOnce();
  });
});

async function drain() { for (let count = 0; count < 24; count += 1) await Promise.resolve(); }
async function harness(beforeStopped?: () => Promise<void>) {
  const original = new Stream();
  let grant!: (stream: Stream) => void; let deny!: (error: Error) => void;
  const getDisplayMedia = vi.fn(() => new Promise<Stream>((resolve, reject) => { grant = resolve; deny = reject; }));
  const receipts: { id: string; value: DesktopRemoteDesktopCaptureReply }[] = [];
  const stopped: unknown[] = [];
  let listener!: (_event: unknown, command: DesktopRemoteDesktopCaptureCommand) => void;
  let unload!: () => void;
  const peers: Peer[] = [];
  class Peer {
    constructor() { peers.push(this); }
    localDescription = { sdp: "answer" }; iceGatheringState = "complete";
    close = vi.fn(); getSenders = () => []; addTrack = vi.fn();
    setRemoteDescription = async () => undefined; createAnswer = async () => ({ sdp: "answer", type: "answer" });
    setLocalDescription = async () => undefined; addIceCandidate = async () => undefined;
  }
  const ipc = { on: (_channel: string, callback: typeof listener) => { listener = callback; },
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel.endsWith(":reply")) receipts.push({ id: args[0] as string, value: args[1] as DesktopRemoteDesktopCaptureReply });
      if (channel.endsWith(":stopped")) { stopped.push(args[0]); await beforeStopped?.(); }
    } };
  const source = await readFile(new URL("../src/remote-desktop-capture-preload.cts", import.meta.url), "utf8");
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
  runInNewContext(compiled, { require: () => ({ ipcRenderer: ipc }), exports: {},
    window: { addEventListener: (_event: string, callback: () => void) => { unload = callback; } },
    navigator: { mediaDevices: { getDisplayMedia } }, RTCPeerConnection: Peer,
    document: { createElement: (type: string) => type === "video" ? { muted: false, readyState: 2,
      videoWidth: 100, videoHeight: 50, play: async () => undefined, pause: vi.fn() }
      : { width: 1, height: 1, getContext: () => ({ drawImage: vi.fn() }), toDataURL: () => "data:image/jpeg;base64,YWJj" } },
    setTimeout, clearTimeout, setInterval, clearInterval });
  const command = (value: DesktopRemoteDesktopCaptureCommand) => listener({}, value);
  cleanup.push(() => { command({ op: "stop" }); unload(); });
  return { original, receipts, stopped, peers, getDisplayMedia, command, unload: () => unload(),
    grant: (value: Stream) => grant(value), deny: (error: Error) => deny(error),
    offer: (id: string) => command({ op: "offer", id, leaseId: "lease", attemptId: id, offerSdp: "offer", iceServers: [],
      portalCapture: true, nativeCapture: false, nativeVideo: false, chromiumCapture: false,
      sourceRevision: 0, cursorOverlay: false, profile: desktopRemoteDesktopVideoProfile({ fps: 30, quality: "auto", audio: false }) }) };
}
