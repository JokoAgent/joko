// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteDesktopViewerHtml } from "./remote-desktop-viewer";

const attempt = "55e39018-f634-4d47-8ffb-3182390d9b14";
const nextAttempt = "324dc54b-95a4-40ed-9e91-4b8557b970e1";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const cursor = { visible: true, x: 0.4, y: 0.6, width: 16, height: 16, hotX: 1, hotY: 2, png };
const scope = window as unknown as {
  ReactNativeWebView: { postMessage(value: string): void };
  __jokoRemoteDesktop: { receive(value: object): void };
};

afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals(); document.documentElement.innerHTML = "<head></head><body></body>";
});

function viewer() {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const posted: Record<string, unknown>[] = [];
  scope.ReactNativeWebView = { postMessage(value) { posted.push(JSON.parse(value)); } };
  const rtc = vi.fn(() => { throw new Error("DOM RTC must remain absent"); });
  vi.stubGlobal("RTCPeerConnection", rtc);
  const html = remoteDesktopViewerHtml("#111111", "#eeeeee", true);
  document.documentElement.innerHTML = html;
  const stage = document.getElementById("stage")!;
  Object.defineProperties(stage, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  new Function(html.match(/<script>([\s\S]*?)<\/script>/u)![1]!)();
  const receive = (value: object) => scope.__jokoRemoteDesktop.receive(value);
  receive({ type: "init", epoch: "current", width: 1600, height: 900, webrtc: true, sequenceBase: 100, sequenceLimit: 120 });
  return { receive, posted, rtc, image: document.getElementById("image") as HTMLImageElement,
    video: document.getElementById("video") as HTMLVideoElement, cursor: document.getElementById("cursor-image") as HTMLImageElement };
}

describe("native media HTML overlay", () => {
  it("keeps native pixels outside HTML while publishing its actual fitted viewport and ordered input", () => {
    const value = viewer();
    expect(getComputedStyle(document.body).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(value.posted.find(message => message.type === "nativeViewport")).toMatchObject({
      epoch: "current", x: 0, y: 75, width: 800, height: 450, fillHeight: false
    });
    value.receive({ type: "control", enabled: true });
    value.receive({ type: "events", events: [{ kind: "key", code: "KeyA", down: true }] });
    expect(value.posted.find(message => message.type === "input")).toMatchObject({
      epoch: "current", sequence: 101, events: [{ kind: "key", code: "KeyA", down: true }]
    });
    value.receive({ type: "videoSettings", audio: true });
    expect(value.rtc).not.toHaveBeenCalled();
    expect(value.posted.some(message => message.type === "iceConfig" || message.type === "offer")).toBe(false);
    value.receive({ type: "stop" });
  });

  it("does not start DOM PiP or allow HTML to publish native presentation receipts", () => {
    const value = viewer();
    const pip = vi.fn();
    Object.assign(value.video, { webkitSupportsPresentationMode: () => true, webkitSetPresentationMode: pip });
    value.receive({ type: "presentation", enabled: true });
    value.video.dispatchEvent(new Event("webkitpresentationmodechanged"));
    expect(pip).not.toHaveBeenCalled();
    expect(value.posted.some(message => message.type === "presentation" || message.type === "presentationFailed")).toBe(false);
    value.receive({ type: "stop" });
  });

  it("uses announced native attempt ownership for first frames, cursor and negative transitions", () => {
    const value = viewer();
    value.receive({ type: "nativeVideo", epoch: "current", attemptId: attempt });
    expect(value.image.style.visibility).toBe("visible");
    value.receive({ type: "nativeAttempt", epoch: "current", attemptId: attempt });
    value.receive({ type: "nativeVideo", epoch: "current", attemptId: attempt });
    expect(value.image.style.visibility).toBe("hidden");
    value.receive({ type: "nativeCursor", epoch: "current", attemptId: attempt, cursor });
    expect(value.cursor.src).toBe("data:image/png;base64," + png);
    value.receive({ type: "nativeAttempt", epoch: "current", attemptId: nextAttempt });
    expect(value.image.style.visibility).toBe("visible");
    expect(value.cursor.hasAttribute("src")).toBe(false);
    value.receive({ type: "nativeVideo", epoch: "current", attemptId: nextAttempt });
    value.receive({ type: "nativeVideo", epoch: "current", attemptId: attempt });
    value.receive({ type: "frame", epoch: "current", frameId: "hidden-frame", jpeg: "hidden" });
    value.image.dispatchEvent(new Event("load"));
    expect(value.posted.find(message => message.type === "framePresented")).toMatchObject({ frameId: "hidden-frame", presented: false });
    value.receive({ type: "fallback", epoch: "current", attemptId: attempt });
    value.receive({ type: "nativeCursor", epoch: "current", attemptId: attempt, cursor });
    expect(value.image.style.visibility).toBe("hidden");
    expect(value.cursor.hasAttribute("src")).toBe(false);
    value.receive({ type: "reconnecting", epoch: "current", attemptId: nextAttempt });
    expect(value.image.style.visibility).toBe("visible");
    value.receive({ type: "nativeVideo", epoch: "retired", attemptId: nextAttempt });
    expect(value.image.style.visibility).toBe("visible");
    value.receive({ type: "stop" });
  });

  it("shows fallback JPEG only for its epoch and clears native proof when the renderer restarts", () => {
    const value = viewer();
    value.receive({ type: "nativeAttempt", epoch: "current", attemptId: attempt });
    value.receive({ type: "nativeVideo", epoch: "current", attemptId: attempt });
    value.receive({ type: "fallback", epoch: "current", attemptId: attempt });
    value.receive({ type: "frame", epoch: "current", frameId: "frame-1", jpeg: "frame" });
    expect(value.image.src).toBe("data:image/jpeg;base64,frame");
    value.image.dispatchEvent(new Event("load"));
    expect(value.posted.find(message => message.type === "framePresented" && message.frameId === "frame-1")).toMatchObject({
      epoch: "current", frameId: "frame-1", presented: true
    });
    value.receive({ type: "init", epoch: "replacement", width: 800, height: 600, webrtc: true });
    value.receive({ type: "nativeVideo", epoch: "current", attemptId: attempt });
    value.receive({ type: "nativeCursor", epoch: "current", attemptId: attempt, cursor });
    expect(value.image.style.visibility).toBe("visible");
    expect(value.image.hasAttribute("src")).toBe(false);
    expect(value.cursor.hasAttribute("src")).toBe(false);
    expect(value.rtc).not.toHaveBeenCalled();
    value.receive({ type: "stop" });
  });
});
