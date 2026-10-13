// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteDesktopViewerHtml } from "./remote-desktop-viewer";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.documentElement.innerHTML = "<head></head><body></body>"; });

describe("Mobile capture consent runtime", () => {
  it("retries pending consent beyond the network budget and retains all three ordinary failure retries", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const posted: Record<string, unknown>[] = [];
    const scope = window as unknown as { ReactNativeWebView: { postMessage(value: string): void }; __jokoRemoteDesktop: { receive(value: object): void } };
    scope.ReactNativeWebView = { postMessage(value) {
      const message = JSON.parse(value) as Record<string, unknown>; posted.push(message);
      if (message.type === "iceConfig") queueMicrotask(() => scope.__jokoRemoteDesktop.receive({ ...message, iceServers: [] }));
    } };
    vi.stubGlobal("RTCPeerConnection", class {
      localDescription = { sdp: "offer" }; iceGatheringState = "complete"; connectionState = "new";
      createDataChannel() { return { close() {}, readyState: "connecting" }; }
      addTransceiver() {}
      async createOffer() { return { sdp: "offer", type: "offer" }; }
      async setLocalDescription() {}
      close() {}
    });
    const html = remoteDesktopViewerHtml("#111111", "#eeeeee"); document.documentElement.innerHTML = html;
    new Function(html.match(/<script>([\s\S]*?)<\/script>/u)![1]!)();
    scope.__jokoRemoteDesktop.receive({ type: "init", epoch: "portal-lease", width: 1200, height: 800, webrtc: true });
    const flush = async () => { for (let turn = 0; turn < 12; turn++) await Promise.resolve(); };
    const offers = () => posted.filter(message => message.type === "offer"); await flush();
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = offers().at(-1)!;
      scope.__jokoRemoteDesktop.receive({ type: "fallback", epoch: "portal-lease", attemptId: current.attemptId, capturePending: true, retry: true });
      const before = offers().length; await vi.advanceTimersByTimeAsync(7999); expect(offers()).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1); await flush(); expect(offers()).toHaveLength(before + 1);
    }
    expect(posted.filter(message => message.type === "fallback" && message.reason === "capture-pending")).toHaveLength(5);
    for (const delay of [1000, 3000, 8000]) {
      const current = offers().at(-1)!; const before = offers().length;
      scope.__jokoRemoteDesktop.receive({ type: "fallback", epoch: "portal-lease", attemptId: current.attemptId, retry: true });
      await vi.advanceTimersByTimeAsync(delay - 1); expect(offers()).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1); await flush(); expect(offers()).toHaveLength(before + 1);
    }
    const before = offers().length;
    scope.__jokoRemoteDesktop.receive({ type: "fallback", epoch: "portal-lease", attemptId: offers().at(-1)!.attemptId, retry: true });
    await vi.advanceTimersByTimeAsync(16000); expect(offers()).toHaveLength(before);
    scope.__jokoRemoteDesktop.receive({ type: "stop" });
  });
});
