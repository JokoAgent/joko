// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountRemoteDesktopViewer } from "./remote-desktop-viewer-runtime.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

describe("Desktop capture consent runtime", () => {
  it("keeps consent retries separate from the finite network retry budget and cancels them on retirement", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("RTCPeerConnection", class {
      localDescription = { sdp: "offer" }; iceGatheringState = "complete"; connectionState = "new";
      createDataChannel() { return { close() {}, readyState: "connecting" }; }
      addTransceiver() {}
      async createOffer() { return { sdp: "offer", type: "offer" }; }
      async setLocalDescription() {}
      close() {}
    });
    document.body.innerHTML = '<div id="stage"><img id="image"><video id="video"></video><div id="cursor"><img id="cursor-image"></div></div><textarea id="keyboard-input"></textarea><div id="mouse-buttons"><button id="mouse-left"></button><button id="mouse-right"></button><button id="mouse-wheel"><span id="mouse-wheel-grip"></span></button></div>';
    const posted: Record<string, unknown>[] = [];
    const runtime = mountRemoteDesktopViewer(document.body, (message: Record<string, unknown>) => {
      posted.push(message);
      if (message.type === "iceConfig") queueMicrotask(() => runtime.receive({ ...message, iceServers: [] }));
    }, { desktop: true, iceServers: [], keyCodes: [], net: { iceConfigMs: 10000, iceConfigBridgeMs: 500, maxCandidates: 128,
      batchSize: 16, pollMs: 250, exchangeMs: 30000, disconnectedMs: 5000, answerMs: 32000, connectMs: 15000, gatherMs: 5000,
      stableMs: 30000, retryMs: [1000, 3000, 8000] } });
    runtime.receive({ type: "init", epoch: "portal-lease", width: 1200, height: 800, webrtcVideo: true });
    const flush = async () => { for (let turn = 0; turn < 12; turn++) await Promise.resolve(); };
    const offers = () => posted.filter(message => message.type === "offer"); await flush();
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = offers().length; expect(before).toBeGreaterThan(0);
      runtime.receive({ type: "fallback", epoch: "portal-lease", attemptId: offers().at(-1)!.attemptId, capturePending: true, retry: true });
      await vi.advanceTimersByTimeAsync(8000); await flush(); expect(offers()).toHaveLength(before + 1);
    }
    const before = offers().length;
    runtime.receive({ type: "fallback", epoch: "portal-lease", attemptId: offers().at(-1)!.attemptId, retry: true });
    await vi.advanceTimersByTimeAsync(999); expect(offers()).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1); await flush(); expect(offers()).toHaveLength(before + 1);
    runtime.receive({ type: "fallback", epoch: "portal-lease", attemptId: offers().at(-1)!.attemptId, capturePending: true, retry: true });
    runtime.dispose(); const retired = offers().length; await vi.advanceTimersByTimeAsync(16000); expect(offers()).toHaveLength(retired);
  });
});
