// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteDesktopViewerHtml } from "./remote-desktop-viewer";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.documentElement.innerHTML = "<head></head><body></body>"; });
describe("remote desktop browser control channel", () => {
  it("sends bounded control messages on the current channel and reports an unsent request explicitly", async () => {
    vi.useFakeTimers(); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const sent: string[] = [], posted: Record<string, unknown>[] = [];
    const channel = { readyState: "open", bufferedAmount: 0, send: (data: string) => sent.push(data), close() {}, onmessage: undefined as undefined | ((event: { data: string }) => void) };
    const scope = window as unknown as { ReactNativeWebView: { postMessage(value: string): void }; __jokoRemoteDesktop: { receive(value: object): void } };
    scope.ReactNativeWebView = { postMessage(value) { const message = JSON.parse(value) as Record<string, unknown>; posted.push(message);
      if (message.type === "iceConfig") queueMicrotask(() => scope.__jokoRemoteDesktop.receive({ ...message, iceServers: [] })); } };
    vi.stubGlobal("RTCPeerConnection", class {
      localDescription = { sdp: "offer" }; iceGatheringState = "complete"; connectionState = "connected";
      createDataChannel() { return channel; } addTransceiver() {} async createOffer() { return { sdp: "offer", type: "offer" }; }
      async setLocalDescription() {} close() {}
    });
    const html = remoteDesktopViewerHtml("#111111", "#eeeeee"); document.documentElement.innerHTML = html;
    new Function(html.match(/<script>([\s\S]*?)<\/script>/u)![1]!)();
    const receive = (value: object) => scope.__jokoRemoteDesktop.receive(value);
    receive({ type: "init", epoch: "current", width: 1200, height: 800, webrtc: true });
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    const attemptId = posted.find(message => message.type === "offer")!.attemptId;
    const message = { type: "request", id: "control-1", request: { op: "control", lease: "lease", enabled: true } };
    receive({ type: "channelRequest", epoch: "current", attemptId, message }); expect(sent).toEqual([JSON.stringify(message)]);
    const reply = { type: "reply", id: "control-1", ok: true, result: { controlling: true, controlGeneration: 2 } };
    channel.onmessage!({ data: JSON.stringify(reply) });
    expect(posted.find(item => item.type === "channelReply")).toEqual({ type: "channelReply", epoch: "current", attemptId, reply });
    channel.readyState = "connecting";
    receive({ type: "channelRequest", epoch: "current", attemptId, message: { ...message, id: "control-2" } });
    expect(sent).toHaveLength(1); expect(posted.at(-1)).toEqual({ type: "channelUnavailable", epoch: "current", attemptId, id: "control-2" });
    receive({ type: "stop" });
  });
});
