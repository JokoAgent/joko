// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteDesktopViewerHtml } from "./remote-desktop-viewer";

const scope = window as unknown as { ReactNativeWebView: { postMessage(raw: string): void };
  __jokoRemoteDesktop: { receive(message: object): void } };
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.(); stop = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  document.documentElement.innerHTML = "<head></head><body></body>";
});
async function flush(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function viewer(options: { native?: boolean; rtc?: boolean; frames?: boolean; sourceWidth?: number; sourceHeight?: number } = {}) {
  vi.useFakeTimers();
  const raf = new Map<number, FrameRequestCallback>(); let rafId = 0;
  const requestFrame = vi.fn((callback: FrameRequestCallback) => { const id = ++rafId; raf.set(id, callback); return id; });
  const cancelFrame = vi.fn((id: number) => { raf.delete(id); });
  vi.stubGlobal("requestAnimationFrame", requestFrame); vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const backgroundContext = { setTransform: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn() }, snapshot = { drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return (this.id === "bg-canvas" ? backgroundContext : snapshot) as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,c25hcHNob3Q=");
  const peers: { close: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal("RTCPeerConnection", class {
    localDescription = { sdp: "offer" }; connectionState = "new"; iceGatheringState = "complete";
    close = vi.fn();
    constructor() { peers.push(this); }
    createDataChannel() { return { close: vi.fn(), readyState: "connecting" }; }
    addTransceiver() {}
    async createOffer() { return { type: "offer", sdp: "offer" }; }
    async setLocalDescription() {}
  });
  const posted: Record<string, unknown>[] = [];
  scope.ReactNativeWebView = { postMessage(raw) { posted.push(JSON.parse(raw)); } };
  const html = remoteDesktopViewerHtml("#111111", "#eeeeee", options.native);
  document.documentElement.innerHTML = html;
  const stage = document.getElementById("stage")!;
  Object.defineProperties(stage, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  const image = document.getElementById("image") as HTMLImageElement, video = document.getElementById("video") as HTMLVideoElement;
  let complete = true, sourceWidth = options.sourceWidth ?? 1600, sourceHeight = options.sourceHeight ?? 900;
  Object.defineProperties(image, { complete: { get: () => complete }, naturalWidth: { get: () => sourceWidth }, naturalHeight: { get: () => sourceHeight } });
  Object.defineProperties(video, { videoWidth: { value: 1600 }, videoHeight: { value: 900 }, readyState: { value: 2 } });
  const videoFrames = new Map<number, () => void>(); let videoFrameId = 0;
  const requestVideoFrame = vi.fn((callback: VideoFrameRequestCallback) => {
    const id = ++videoFrameId; videoFrames.set(id, () => callback(0, {} as VideoFrameCallbackMetadata)); return id;
  });
  const cancelVideoFrame = vi.fn((id: number) => { videoFrames.delete(id); });
  if (options.frames) Object.assign(video, { requestVideoFrameCallback: requestVideoFrame, cancelVideoFrameCallback: cancelVideoFrame });
  new Function(html.match(/<script>([\s\S]*?)<\/script>/u)![1]!)();
  const receive = (message: object) => scope.__jokoRemoteDesktop.receive(message);
  receive({ type: "init", epoch: "ambient-current", width: sourceWidth, height: sourceHeight, webrtc: options.rtc === true });
  const flushFrames = () => {
    for (let turn = 0; raf.size && turn < 10; turn++) {
      const pending = Array.from(raf.values()); raf.clear(); for (const callback of pending) callback(0);
    }
    expect(raf.size).toBe(0);
  };
  const load = (drawable = true) => {
    complete = drawable;
    receive({ type: "frame", epoch: "ambient-current", frameId: "jpeg-current", jpeg: "AA==" });
    if (drawable) image.dispatchEvent(new Event("load"));
    flushFrames();
  };
  const connect = async () => {
    const config = posted.findLast(message => message.type === "iceConfig")!;
    receive({ type: "iceConfig", epoch: "ambient-current", attemptId: config.attemptId, iceServers: [] }); await flush();
    video.dispatchEvent(new Event("playing")); flushFrames();
  };
  stop = () => receive({ type: "stop" });
  return { receive, load, connect, flushFrames, backgroundContext, snapshot, image, video, posted, peers, raf,
    requestFrame, cancelFrame, videoFrames, requestVideoFrame, cancelVideoFrame,
    background: document.getElementById("bg")!, canvas: document.getElementById("bg-canvas") as HTMLCanvasElement,
    setComplete(value: boolean) { complete = value; },
    setSource(width: number, height: number) { sourceWidth = width; sourceHeight = height; },
    reuseVideoFrame(id: number) { videoFrameId = id - 1; } };
}

describe("actual ordinary Mobile ambient pixels", () => {
  it.each([
    { width: 1600, height: 900, axis: "y", first: [0, 0, 1600, 45, 0, 0, 800, 97.5] },
    { width: 900, height: 1600, axis: "x", first: [0, 0, 45, 1600, 0, 0, 248.125, 600] }
  ])("draws ordinary $axis bars using natural source 5/90/5 fractions without inset mode", ({ width, height, axis, first }) => {
    const value = viewer({ sourceWidth: width, sourceHeight: height }); value.load();
    expect(value.background.style.display).toBe("block"); expect(value.canvas.width).toBe(800); expect(value.canvas.height).toBe(600);
    const draws = value.backgroundContext.drawImage.mock.calls;
    expect(draws).toHaveLength(3); expect(draws[0]).toEqual([value.image, ...first]);
    const origin = axis === "x" ? 1 : 2, span = axis === "x" ? 3 : 4, length = axis === "x" ? width : height;
    expect(draws[1]![origin]).toBeCloseTo(length * .05); expect(draws[1]![span]).toBeCloseTo(length * .9);
    expect(draws[2]![origin]).toBeCloseTo(length * .95); expect(draws[2]![span]).toBeCloseTo(length * .05);
    value.receive({ type: "mode", mode: "pan" }); value.flushFrames();
    expect(value.backgroundContext.drawImage.mock.calls.slice(-3)).toEqual(draws.slice(0, 3));
  });

  it("retains the drawable JPEG until replacement pixels exist and clears only for actual native presentation", () => {
    const value = viewer({ native: true }); value.load();
    expect(value.background.style.display).toBe("block");
    const clearCount = value.backgroundContext.clearRect.mock.calls.length, drawCount = value.backgroundContext.drawImage.mock.calls.length;
    value.load(false);
    expect(value.backgroundContext.clearRect).toHaveBeenCalledTimes(clearCount);
    expect(value.backgroundContext.drawImage).toHaveBeenCalledTimes(drawCount);
    value.setComplete(true); value.setSource(800, 450); value.image.dispatchEvent(new Event("load")); value.flushFrames();
    expect(value.backgroundContext.drawImage.mock.calls.at(-3)!.slice(1, 5)).toEqual([0, 0, 800, 22.5]);
    const attemptId = "123e4567-e89b-42d3-a456-426614174000";
    value.receive({ type: "nativeAttempt", epoch: "ambient-current", attemptId }); value.flushFrames();
    expect(value.background.style.display).toBe("block");
    value.receive({ type: "nativeVideo", epoch: "retired", attemptId }); expect(value.background.style.display).toBe("block");
    value.receive({ type: "mode", mode: "pan" });
    const queued = Array.from(value.raf.values())[0]!; expect(queued).toBeDefined();
    value.receive({ type: "nativeVideo", epoch: "ambient-current", attemptId });
    expect(value.background.style.display).toBe("none"); expect(value.image.style.visibility).toBe("hidden");
    const nativeDraws = value.backgroundContext.drawImage.mock.calls.length;
    queued(0); value.flushFrames(); expect(value.backgroundContext.drawImage).toHaveBeenCalledTimes(nativeDraws);
    value.receive({ type: "fallback", epoch: "ambient-current", attemptId });
    expect(value.raf.size).toBe(1); queued(0); expect(value.raf.size).toBe(1); value.flushFrames();
    expect(value.background.style.display).toBe("block"); expect(value.image.style.visibility).toBe("visible");
    expect(value.backgroundContext.drawImage).toHaveBeenCalledTimes(nativeDraws + 3);
    value.receive({ type: "stop", preserveFrame: false });
    expect(value.background.style.display).toBe("none"); expect(value.image.hasAttribute("src")).toBe(false); expect(value.raf.size).toBe(0);
  });

  it("coalesces old-WebView timeupdate only after video is presented and never starts an idle repaint loop", async () => {
    const value = viewer({ rtc: true }); value.load();
    const beforePresentation = value.requestFrame.mock.calls.length;
    value.video.dispatchEvent(new Event("timeupdate")); value.video.dispatchEvent(new Event("timeupdate"));
    expect(value.requestFrame).toHaveBeenCalledTimes(beforePresentation);
    await value.connect(); expect(value.backgroundContext.drawImage.mock.calls.at(-1)![0]).toBe(value.video);
    const beforeProgress = value.requestFrame.mock.calls.length, draws = value.backgroundContext.drawImage.mock.calls.length;
    value.video.dispatchEvent(new Event("timeupdate")); value.video.dispatchEvent(new Event("timeupdate"));
    expect(value.requestFrame).toHaveBeenCalledTimes(beforeProgress + 1); value.flushFrames();
    expect(value.backgroundContext.drawImage).toHaveBeenCalledTimes(draws + 3);
    await vi.advanceTimersByTimeAsync(1000); value.flushFrames();
    expect(value.requestFrame).toHaveBeenCalledTimes(beforeProgress + 1);
    value.receive({ type: "videoSettings", audio: false }); value.flushFrames();
    expect(value.video.onplaying).toBeNull(); expect(value.snapshot.drawImage).toHaveBeenCalledExactlyOnceWith(value.video, 0, 0, 1280, 720);
    expect(value.image.src).toContain("c25hcHNob3Q=");
    const retired = value.requestFrame.mock.calls.length;
    value.video.dispatchEvent(new Event("timeupdate")); expect(value.requestFrame).toHaveBeenCalledTimes(retired);
  });

  it("cancels the original RTC loop and rejects its late same-epoch callback before touching a replacement slot", async () => {
    const value = viewer({ rtc: true, frames: true }); value.load(); await value.connect();
    const [oldId, oldCallback] = Array.from(value.videoFrames)[0]!, oldPlaying = value.video.onplaying!;
    const originalDraws = value.backgroundContext.drawImage.mock.calls.length;
    const queuedRaf = value.requestFrame.mock.calls.length;
    value.video.dispatchEvent(new Event("timeupdate")); expect(value.requestFrame).toHaveBeenCalledTimes(queuedRaf);
    value.setComplete(false); value.receive({ type: "videoSettings", audio: false }); value.flushFrames();
    expect(value.cancelVideoFrame).toHaveBeenCalledWith(oldId); expect(value.videoFrames.size).toBe(0); expect(value.video.onplaying).toBeNull();
    expect(value.backgroundContext.drawImage).toHaveBeenCalledTimes(originalDraws);
    oldCallback(); oldPlaying.call(value.video, new Event("playing"));
    expect(value.videoFrames.size).toBe(0); expect(value.backgroundContext.drawImage).toHaveBeenCalledTimes(originalDraws);
    value.reuseVideoFrame(oldId); await value.connect();
    const [currentId, currentCallback] = Array.from(value.videoFrames)[0]!; expect(currentId).toBe(oldId);
    const currentDraws = value.backgroundContext.drawImage.mock.calls.length, requests = value.requestVideoFrame.mock.calls.length;
    oldCallback();
    expect(value.videoFrames.get(currentId)).toBe(currentCallback);
    expect(value.backgroundContext.drawImage).toHaveBeenCalledTimes(currentDraws); expect(value.requestVideoFrame).toHaveBeenCalledTimes(requests);
    value.videoFrames.delete(currentId); currentCallback();
    expect(value.backgroundContext.drawImage).toHaveBeenCalledTimes(currentDraws + 3); expect(value.requestVideoFrame).toHaveBeenCalledTimes(requests + 1);
    const [closingId, closingCallback] = Array.from(value.videoFrames)[0]!;
    value.receive({ type: "stop" }); expect(value.cancelVideoFrame).toHaveBeenCalledWith(closingId);
    const stoppedDraws = value.backgroundContext.drawImage.mock.calls.length;
    closingCallback(); expect(value.videoFrames.size).toBe(0); expect(value.backgroundContext.drawImage).toHaveBeenCalledTimes(stoppedDraws);
    expect(value.background.style.display).toBe("none"); expect(value.video.onplaying).toBeNull();
  });
});
