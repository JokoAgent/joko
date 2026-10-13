import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopRemoteDesktopCaptureCommand, DesktopRemoteDesktopCaptureReply } from "../src/remote-desktop-capture-protocol.js";
import { desktopRemoteDesktopVideoProfile } from "../src/remote-desktop-quality.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });

describe("Remote Desktop active capture source", () => {
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

async function harness() {
  const original = track();
  const sender = { track: original, replaceTrack: vi.fn(async (item: Track) => { sender.track = item; }),
    getParameters: () => ({ encodings: [] }), setParameters: vi.fn(async () => undefined) };
  const frame = { jpeg: "AQ==", width: 1, height: 1, cursor: null };
  const nativeRead = vi.fn<(...args: unknown[]) => Promise<typeof frame | null>>(async () => frame);
  const getDisplayMedia = vi.fn(async () => new Stream([original]));
  const nativeTracks: Track[] = [];
  const draw = vi.fn();
  const receipts: { id: string; value: DesktopRemoteDesktopCaptureReply }[] = [];
  let listener!: (_event: unknown, command: DesktopRemoteDesktopCaptureCommand) => void;
  class Peer {
    localDescription = { sdp: "answer" };
    close = vi.fn();
    getSenders = () => [sender];
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
    Blob, atob, Uint8Array, Uint8ClampedArray, setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() }, crypto: { randomUUID: () => "11111111-1111-4111-8111-111111111111" } });
  const command = (value: DesktopRemoteDesktopCaptureCommand) => listener({}, value);
  cleanup.push(() => command({ op: "stop" }));
  command({ op: "offer", id: "offer", leaseId: "lease", attemptId: "attempt", offerSdp: "offer", iceServers: [],
    nativeCapture: true, nativeVideo: false, chromiumCapture: true, portalCapture: false, sourceRevision: 0, cursorOverlay: false,
    profile: desktopRemoteDesktopVideoProfile({ fps: 30, quality: "auto", audio: false }) });
  await vi.waitFor(() => expect(receipts).toEqual([{ id: "offer", value: { kind: "offer", answerSdp: "answer" } }]));
  return { original, sender, frame, nativeRead, getDisplayMedia, nativeTracks, draw, receipts, command };
}
