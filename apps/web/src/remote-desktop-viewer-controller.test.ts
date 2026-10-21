// @vitest-environment jsdom
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteDesktopService, RemoteDesktopFailureReason, RemoteDesktopVideoQuality, type DesktopRemoteDesktopViewerApi,
  type DesktopRemoteDesktopViewerState } from "@joko/contracts";
const runtime = vi.hoisted(() => ({ post: undefined as ((message: Record<string, unknown>) => void) | undefined,
  receive: vi.fn(), dispose: vi.fn() }));
vi.mock("./remote-desktop-viewer-runtime.js", () => ({ mountRemoteDesktopViewer: (_root: unknown, post: (message: Record<string, unknown>) => void) => {
  runtime.post = post; return { receive: runtime.receive, dispose: runtime.dispose }; } }));
vi.mock("./remote-desktop-viewer-bridge.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./remote-desktop-viewer-bridge.js")>();
  return { ...actual, createDesktopRemoteDesktopViewerClient: vi.fn(actual.createDesktopRemoteDesktopViewerClient) };
});
import { DesktopRemoteDesktopViewerController, desktopViewerDisplaySize } from "./remote-desktop-viewer-controller.js";
import { createDesktopRemoteDesktopViewerClient } from "./remote-desktop-viewer-bridge.js";

const controllers: DesktopRemoteDesktopViewerController[] = [];
beforeEach(() => { vi.useFakeTimers(); runtime.receive.mockClear(); runtime.dispose.mockClear(); vi.mocked(createDesktopRemoteDesktopViewerClient).mockClear(); vi.spyOn(document, "hasFocus").mockReturnValue(true); });
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });
const SCOPE: DesktopRemoteDesktopViewerState = { generation: 1, active: false, target: { deviceId: "peer", name: "Remote desk" }, locale: "en", audio: true, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false, clipboardSyncState: { available: true, active: false, pending: false } };

function fixture(platform = "win32", temporary = false, portal = false, systemAudio = false,
  initialState: Promise<DesktopRemoteDesktopViewerState> = Promise.resolve(SCOPE), autoControl = false) {
  let onState!: (state: DesktopRemoteDesktopViewerState) => void;
  const inputCalls: { name: string; input: Record<string, unknown> }[] = [];
  let pendingControl: Promise<object> | undefined;
  let heartbeatFailure = false;
  let geometryGeneration = 2n;
  const api: DesktopRemoteDesktopViewerApi = {
    platform, state: vi.fn(() => initialState),
    ready: vi.fn(async () => { onState({ ...SCOPE, active: true }); }),
    inputFocus: vi.fn(async () => undefined),
    request: vi.fn(async (_generation, name, bytes) => {
      const method = RemoteDesktopService.methods.find((item) => item.localName === name)!;
      const input = fromBinary(method.input, bytes) as unknown as Record<string, unknown>;
      inputCalls.push({ name, input });
      if (name === "heartbeatRemoteDesktop" && heartbeatFailure) {
        heartbeatFailure = false;
        return { ok: false as const, code: Code.FailedPrecondition, reason: RemoteDesktopFailureReason.LEASE_EXPIRED };
      }
      const output = name === "getRemoteDesktopCapabilities" ? { capabilities: { protocolVersion: 1, enabled: true,
        canControl: !portal, autoControl, platform: portal || systemAudio ? "linux" : platform, displays: [{ displayId: "one", name: "One", width: 1200, height: 800 }],
        jpegFallback: true, webrtcVideo: true, videoSettings: true, systemAudio, automaticReconnect: true, connectionTakeover: true, clipboardContent: true, hostMute: true, lockOnExit: true, clipboardSync: true, privacyScreen: true, displayModes: true, resolutionRestore: temporary,
        viewerDisplay: platform === "linux", viewerDisplayRestore: platform === "linux" } } :
        name === "startRemoteDesktop" ? { lease: { leaseId: "lease", display: { displayId: "one", width: 1200, height: 800 }, controlling: input["control"] === true, controlGeneration: 1n } } :
        name === "setRemoteDesktopControl" ? await (pendingControl ?? Promise.resolve({ state: { controlling: input["enabled"], controlGeneration: geometryGeneration } })) :
        name === "heartbeatRemoteDesktop" ? { state: { controlling: !portal, controlGeneration: geometryGeneration } } :
        name === "getRemoteDesktopFrame" ? { result: { frame: { jpeg: new Uint8Array([255,216,255,217]) } } } :
        name === "listRemoteDesktopDisplayModes" ? { modes: [{ modeId: "mode", width: 1000, height: 700 }] } :
        name === "setRemoteDesktopDisplayMode" ? { result: temporary ? { lease: { leaseId: "lease", display: { displayId: "one", width: 1000, height: 700 }, controlling: input["control"] === true, controlGeneration: ++geometryGeneration } } : {} } :
        name === "setRemoteDesktopViewerDisplay" || name === "restoreRemoteDesktopViewerDisplay" ? { result: { lease: { leaseId: "lease",
          display: name === "setRemoteDesktopViewerDisplay" ? { displayId: "mirror", width: input["width"], height: input["height"] } : { displayId: "one", width: 1200, height: 800 },
          controlling: input["control"] === true, controlGeneration: ++geometryGeneration } } } :
        name === "setRemoteDesktopHostMute" || name === "setRemoteDesktopPrivacyScreen" ? { result: { enabled: (input["request"] as { enabled: boolean }).enabled } } : {};
      return { ok: true as const, bytes: toBinary(method.output, create(method.output, output as MessageInitShape<typeof method.output>)) };
    }),
    onState: (listener) => { onState = listener; return vi.fn(); }, onCloseRequested: () => vi.fn(),
    retryClipboardSync: vi.fn(async () => undefined), clipboard: vi.fn(async () => undefined), close: vi.fn(async () => undefined), minimize: vi.fn(async () => undefined), fullscreen: vi.fn(async () => true),
    credential: vi.fn(async () => ({ ok: true as const, authenticated: false, state: { available: true, autoUnlock: false, biometricAvailable: true, biometricVerification: false } })),
    resize: vi.fn(async () => undefined), preferences: vi.fn(async (_generation, patch) => ({ audio: patch?.audio ?? true, hostMute: patch?.hostMute ?? false, lockOnExit: patch?.lockOnExit ?? false, clipboardSync: patch?.clipboardSync ?? false, privacyScreen: patch?.privacyScreen ?? false }))
  };
  const controller = new DesktopRemoteDesktopViewerController(api, document.createElement("div"), () => undefined); controllers.push(controller);
  return { api, controller, inputCalls, scope: (value: DesktopRemoteDesktopViewerState) => onState(value),
    post: (message: Record<string, unknown>) => runtime.post?.({
      epoch: runtime.receive.mock.calls.filter(([value]) => value.type === "init").at(-1)?.[0].epoch, ...message
    }),
    pendingControl: (value: Promise<object>) => { pendingControl = value; }, expire: () => { heartbeatFailure = true; } };
}
async function flush(): Promise<void> { for (let i = 0; i < 16; i++) await Promise.resolve(); }

describe("Desktop viewer presentation adapter", () => {
  it("adopts host control in start and geometry receipts without a duplicate take-control", async () => {
    const f = fixture("linux", true, false, false, Promise.resolve(SCOPE), true); await flush();
    expect(f.inputCalls.find(call => call.name === "startRemoteDesktop")?.input["control"]).toBe(true);
    expect(f.controller.snapshot.controlling).toBe(true);
    await f.controller.setMode("mode"); await flush();
    expect(f.controller.snapshot).toMatchObject({ controlling: true, lease: { controlGeneration: 3n } });
    expect(f.inputCalls.find(call => call.name === "setRemoteDesktopDisplayMode")?.input["control"]).toBe(true);
    expect(f.inputCalls.some(call => call.name === "setRemoteDesktopControl")).toBe(false);
  });
  it("defers initial control until the shown viewer gains focus and preserves a later user release", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    const f = fixture(); await flush(); f.post({ type: "framePresented" }); await flush();
    expect(f.inputCalls.filter(call => call.name === "setRemoteDesktopControl")).toHaveLength(0);
    vi.mocked(document.hasFocus).mockReturnValue(true);
    window.dispatchEvent(new Event("focus")); await flush();
    expect(f.controller.snapshot).toMatchObject({ ready: true, controlling: true });
    expect(f.inputCalls.filter(call => call.name === "setRemoteDesktopControl")).toHaveLength(1);
    await f.controller.control(false);
    f.controller.focusLost(); window.dispatchEvent(new Event("focus")); await flush();
    expect(f.controller.snapshot.controlling).toBe(false);
    expect(f.inputCalls.filter(call => call.name === "setRemoteDesktopControl")).toHaveLength(2);
  });

  it("retires deferred initial control when its viewer binding becomes inactive", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    const f = fixture(); await flush();
    f.scope({ ...SCOPE, active: false, generation: 2 }); await flush();
    vi.mocked(document.hasFocus).mockReturnValue(true);
    window.dispatchEvent(new Event("focus")); await flush();
    expect(f.inputCalls.filter(call => call.name === "setRemoteDesktopControl")).toHaveLength(0);
    expect(f.controller.snapshot).toMatchObject({ status: "inactive", controlling: false });
  });

  it("readies an exact null-target shell without constructing a client or running target effects", async () => {
    const unbound = { ...SCOPE, generation: 0, target: null, active: false };
    const f = fixture("darwin", false, false, false, Promise.resolve(unbound));
    vi.mocked(f.api.ready).mockResolvedValue(undefined);
    await flush();
    expect(f.api.ready).toHaveBeenCalledExactlyOnceWith(0);
    expect(f.controller.snapshot).toMatchObject({ target: null, status: "inactive", ready: false, controlling: false });
    expect(createDesktopRemoteDesktopViewerClient).not.toHaveBeenCalled();
    await f.controller.control(true); await f.controller.clipboard("copy"); await f.controller.credential("enable");
    await f.controller.hostMute(true); await f.controller.privacyScreen(false); await f.controller.lockOnExit(true);
    await f.controller.clipboardSync(true); await f.controller.retryClipboardSync(); await f.controller.close();
    f.controller.settings({ audio: false }); f.controller.keys(["KeyA"]); f.controller.actualSize();
    f.post({ type: "input", epoch: "retired", sequence: 1, events: [{ kind: "text", text: "input" }] });
    await vi.advanceTimersByTimeAsync(6000); await flush();
    for (const effect of [f.api.request, f.api.clipboard, f.api.credential, f.api.preferences,
      f.api.retryClipboardSync, f.api.close, f.api.resize]) expect(effect).not.toHaveBeenCalled();
    expect(f.controller.snapshot).toMatchObject({ target: null, status: "inactive", ready: false, controlling: false });
  });

  it.each(["resolve", "reject"] as const)("adopts a fresh binding while dropping queued unbound readiness and a late initial %s", async outcome => {
    const unbound = { ...SCOPE, generation: 0, target: null, active: false };
    let settle!: (state: DesktopRemoteDesktopViewerState) => void, reject!: (error: Error) => void;
    const initial = new Promise<DesktopRemoteDesktopViewerState>((resolve, fail) => { settle = resolve; reject = fail; });
    const f = fixture("win32", false, false, false, initial);
    vi.mocked(f.api.ready).mockResolvedValue(undefined);
    f.scope(unbound); expect(createDesktopRemoteDesktopViewerClient).not.toHaveBeenCalled();
    f.scope(SCOPE); await flush();
    expect(f.api.ready).toHaveBeenCalledExactlyOnceWith(1);
    expect(createDesktopRemoteDesktopViewerClient).toHaveBeenCalledWith(f.api, 1); expect(f.api.request).not.toHaveBeenCalled();
    f.scope({ ...SCOPE, active: true }); await flush(); f.post({ type: "framePresented" });
    expect(f.controller.snapshot).toMatchObject({ target: SCOPE.target, status: "live", ready: true, controlling: true, lease: { leaseId: "lease" } });
    const constructions = vi.mocked(createDesktopRemoteDesktopViewerClient).mock.calls.length;
    if (outcome === "resolve") settle(unbound); else reject(new Error("Retired initial read"));
    f.scope(unbound); await flush();
    expect(f.controller.snapshot).toMatchObject({ target: SCOPE.target, status: "live", ready: true, controlling: true, error: undefined });
    expect(f.api.ready).toHaveBeenCalledTimes(1); expect(createDesktopRemoteDesktopViewerClient).toHaveBeenCalledTimes(constructions);
    expect(f.inputCalls.filter(call => call.name === "startRemoteDesktop")).toHaveLength(1);
  });

  it("coalesces quiet-shell readiness to the current generation before any network operation", async () => {
    const f = fixture();
    vi.mocked(f.api.ready).mockResolvedValue(undefined);
    f.scope(SCOPE);
    f.scope({ ...SCOPE, generation: 2, target: { deviceId: "peer", name: "Current quiet desk" } });
    await flush();
    expect(f.api.ready).toHaveBeenCalledExactlyOnceWith(2);
    expect(f.controller.snapshot).toMatchObject({ target: { name: "Current quiet desk" }, status: "inactive", ready: false });
    expect(f.api.request).not.toHaveBeenCalled();
    f.scope({ ...SCOPE, generation: 1, active: true });
    f.scope({ ...SCOPE, generation: 2, locale: "zh-CN" });
    await flush();
    expect(f.api.ready).toHaveBeenCalledTimes(1);
    expect(f.controller.snapshot).toMatchObject({ status: "inactive", locale: "zh-CN", ready: false });
    expect(f.api.request).not.toHaveBeenCalled();
  });

  it("retires queued quiet-shell readiness when its renderer is disposed", async () => {
    const f = fixture();
    f.scope(SCOPE); f.controller.dispose(); await flush();
    expect(f.api.ready).not.toHaveBeenCalled();
    expect(f.api.request).not.toHaveBeenCalled();
  });

  it("mirror fits actual viewport, adopts same lease with a new runtime, restores physical source, and reconnects to it", async () => {
    const f = fixture("linux", true); await flush(); f.post({ type: "framePresented" });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 800, height: 600 } as DOMRect);
    const old = runtime.receive.mock.calls.filter(([value]) => value.type === "init").at(-1)![0];
    await f.controller.fitViewerDisplay(); await flush();
    expect(f.inputCalls.find(call => call.name === "setRemoteDesktopViewerDisplay")?.input).toMatchObject({ leaseId: "lease", controlGeneration: 2n, width: 1920, height: 1440 });
    expect(f.controller.snapshot).toMatchObject({ viewerDisplayFitted: true, controlling: true, ready: false, lease: { display: { displayId: "mirror" }, controlGeneration: 3n } });
    runtime.post?.({ type: "framePresented", epoch: old.epoch }); expect(f.controller.snapshot.ready).toBe(false);
    f.post({ type: "framePresented" }); await f.controller.restoreViewerDisplay();
    expect(f.controller.snapshot).toMatchObject({ viewerDisplayFitted: false, lease: { display: { displayId: "one" }, controlGeneration: 4n } });
    await f.controller.fitViewerDisplay(); await flush(); f.expire(); await vi.advanceTimersByTimeAsync(4100);
    expect(f.inputCalls.filter(call => call.name === "startRemoteDesktop").at(-1)?.input).toMatchObject({ displayId: "one" });
    expect(f.inputCalls.filter(call => call.name === "restoreRemoteDesktopViewerDisplay")).toHaveLength(1);
  });

  it("mirror keeps outcome unknown until explicit actual stop and does not resume control or replay Fit", async () => {
    const f = fixture("linux", true); await flush(); f.post({ type: "framePresented" });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 800, height: 600 } as DOMRect);
    const original = vi.mocked(f.api.request).getMockImplementation()!;
    vi.mocked(f.api.request).mockImplementation(async (...args) => args[1] === "setRemoteDesktopViewerDisplay" || args[1] === "stopRemoteDesktop"
      ? { ok: false, code: Code.Unavailable, reason: RemoteDesktopFailureReason.UNSPECIFIED } : original(...args));
    await f.controller.fitViewerDisplay(); await f.controller.control(true); await f.controller.retry(); await vi.advanceTimersByTimeAsync(6000);
    expect(f.controller.snapshot).toMatchObject({ status: "error", ready: false, controlling: false, lease: { leaseId: "lease" }, modeNotice: "change-failed" });
    expect(f.inputCalls.filter(call => call.name === "startRemoteDesktop")).toHaveLength(1);
    expect(f.inputCalls.filter(call => call.name === "setRemoteDesktopControl")).toHaveLength(1);
    expect(vi.mocked(f.api.request).mock.calls.filter(call => call[1] === "setRemoteDesktopViewerDisplay")).toHaveLength(1);
  });

  it("mirror physical resolution restores the captured source before adopting its actual geometry", async () => {
    const f = fixture("linux", true); await flush(); f.post({ type: "framePresented" });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 800, height: 600 } as DOMRect);
    const original = vi.mocked(f.api.request).getMockImplementation()!, method = RemoteDesktopService.method.listRemoteDesktopDisplayModes;
    vi.mocked(f.api.request).mockImplementation(async (...args) => args[1] === method.localName ? { ok: true,
      bytes: toBinary(method.output, create(method.output, { modes: [{ modeId: "mode", width: 1000, height: 700, current: true }] })) } : original(...args));
    await f.controller.fitViewerDisplay(); await flush(); await f.controller.setMode("mode");
    expect(f.controller.snapshot).toMatchObject({ viewerDisplayFitted: false, lease: { display: { displayId: "one", width: 1000, height: 700 }, controlGeneration: 4n } });
    expect(f.inputCalls.filter(call => call.name === "startRemoteDesktop")).toHaveLength(1);
  });

  it("mirror uses reference even dimensions and refuses narrow or invalid viewports", () => {
    expect(desktopViewerDisplaySize(800, 600)).toEqual({ width: 1920, height: 1440 });
    expect(desktopViewerDisplaySize(393, 852)).toEqual({ width: 886, height: 1920 });
    expect(desktopViewerDisplaySize(100, 1000)).toBeUndefined(); expect(desktopViewerDisplaySize(0, 800)).toBeUndefined();
  });
  it("keeps the Linux audio intent and same controlled lease when an unavailable offer falls back to JPEG", async () => {
    const f = fixture("win32", false, false, true); const original = vi.mocked(f.api.request).getMockImplementation()!;
    vi.mocked(f.api.request).mockImplementation(async (...args) => {
      if (args[1] !== "createRemoteDesktopOffer") return original(...args);
      const method = RemoteDesktopService.methods.find(item => item.localName === args[1])!;
      const input = fromBinary(method.input, args[2]) as unknown as { leaseId: string; settings: { audio: boolean } };
      expect(input).toMatchObject({ leaseId: "lease", settings: { audio: true } });
      return { ok: false, code: Code.FailedPrecondition, reason: RemoteDesktopFailureReason.AUDIO_UNAVAILABLE };
    });
    await flush(); f.post({ type: "framePresented" }); await flush();
    f.post({ type: "offer", attemptId: "linux-audio", sdp: "offer" }); await flush();
    expect(runtime.receive).toHaveBeenCalledWith(expect.objectContaining({ type: "fallback", attemptId: "linux-audio", retry: false }));
    f.post({ type: "fallback", attemptId: "linux-audio", reason: "offer" }); f.post({ type: "framePresented" });
    await vi.advanceTimersByTimeAsync(3500);
    expect(f.controller.snapshot).toMatchObject({ status: "live", ready: true, controlling: true, media: "screenshots", error: undefined,
      caps: { platform: "linux", systemAudio: true }, lease: { leaseId: "lease" }, settings: { audio: true } });
    expect(f.inputCalls.filter(call => call.name === "startRemoteDesktop")).toHaveLength(1);
    expect(f.inputCalls.some(call => call.name === "stopRemoteDesktop")).toBe(false);
    expect(f.inputCalls.filter(call => call.name === "heartbeatRemoteDesktop").length).toBeGreaterThan(0);
    expect(f.api.preferences).not.toHaveBeenCalled();
  });

  it("ignores a retired Linux audio offer failure without muting or rebuilding its replacement", async () => {
    const f = fixture("win32", false, false, true); const original = vi.mocked(f.api.request).getMockImplementation()!;
    let finish!: () => void;
    vi.mocked(f.api.request).mockImplementation(async (...args) => {
      if (args[1] !== "createRemoteDesktopOffer") return original(...args);
      await new Promise<void>(resolve => { finish = resolve; });
      return { ok: false, code: Code.FailedPrecondition, reason: RemoteDesktopFailureReason.AUDIO_UNAVAILABLE };
    });
    await flush(); f.post({ type: "offer", attemptId: "retired-audio", sdp: "offer" }); await flush();
    f.scope({ ...SCOPE, generation: 2, active: false }); finish(); await flush();
    expect(f.controller.snapshot).toMatchObject({ status: "inactive", ready: false, error: undefined, settings: { audio: true } });
    expect(runtime.receive.mock.calls.some(([message]) => message.type === "fallback" && message.attemptId === "retired-audio")).toBe(false);
    expect(f.api.preferences).not.toHaveBeenCalled();
  });

  it("preserves a Linux portal lease and heartbeat through capture pending beyond the ordinary deadline, until pixels are presented", async () => {
    const f = fixture("win32", false, true); const original = vi.mocked(f.api.request).getMockImplementation()!;
    let granted = false;
    vi.mocked(f.api.request).mockImplementation(async (...args) => !granted && ["createRemoteDesktopOffer", "getRemoteDesktopFrame"].includes(args[1])
      ? { ok: false, code: Code.FailedPrecondition, reason: RemoteDesktopFailureReason.CAPTURE_PENDING } : original(...args));
    await flush(); f.post({ type: "offer", attemptId: "portal", sdp: "offer" }); await flush();
    expect(runtime.receive).toHaveBeenCalledWith(expect.objectContaining({ type: "fallback", capturePending: true, retry: true }));
    f.post({ type: "fallback", attemptId: "portal", reason: "capture-pending" });
    await vi.advanceTimersByTimeAsync(75000);
    expect(f.controller.snapshot).toMatchObject({ status: "capture-pending", ready: false, controlling: false, error: undefined, lease: { leaseId: "lease" } });
    expect(f.inputCalls.filter(call => call.name === "startRemoteDesktop")).toHaveLength(1);
    expect(f.inputCalls.filter(call => call.name === "heartbeatRemoteDesktop").length).toBeGreaterThan(20);
    expect(f.inputCalls.some(call => call.name === "stopRemoteDesktop" || call.name === "setRemoteDesktopControl")).toBe(false);
    granted = true; await vi.advanceTimersByTimeAsync(350); f.post({ type: "framePresented" });
    expect(f.controller.snapshot).toMatchObject({ status: "live", ready: true, controlling: false, error: undefined });
  });

  it("shows portal denial as permission failure without automatically starting another picker lease", async () => {
    const f = fixture("win32", false, true); const original = vi.mocked(f.api.request).getMockImplementation()!;
    let denied = false;
    vi.mocked(f.api.request).mockImplementation(async (...args) => args[1] === "getRemoteDesktopFrame"
      ? { ok: false, code: Code.FailedPrecondition, reason: denied ? RemoteDesktopFailureReason.SCREEN_PERMISSION_REQUIRED : RemoteDesktopFailureReason.CAPTURE_PENDING } : original(...args));
    await flush(); await vi.advanceTimersByTimeAsync(350); expect(f.controller.snapshot.status).toBe("capture-pending");
    denied = true; await vi.advanceTimersByTimeAsync(350); expect(f.controller.snapshot).toMatchObject({ status: "error", error: "permission", ready: false });
    await vi.advanceTimersByTimeAsync(10000); expect(f.inputCalls.filter(call => call.name === "startRemoteDesktop")).toHaveLength(1);
  });

  it("ignores a retired portal offer's pending receipt", async () => {
    const f = fixture("win32", false, true); const original = vi.mocked(f.api.request).getMockImplementation()!;
    let finish!: () => void;
    vi.mocked(f.api.request).mockImplementation(async (...args) => {
      if (args[1] !== "createRemoteDesktopOffer") return original(...args);
      await new Promise<void>(resolve => { finish = resolve; });
      return { ok: false, code: Code.FailedPrecondition, reason: RemoteDesktopFailureReason.CAPTURE_PENDING };
    });
    await flush(); f.post({ type: "offer", attemptId: "portal", sdp: "offer" }); await flush();
    f.scope({ ...SCOPE, generation: 2, active: false }); finish(); await flush();
    expect(f.controller.snapshot).toMatchObject({ status: "inactive", ready: false, error: undefined });
    expect(runtime.receive.mock.calls.some(([message]) => message.capturePending === true)).toBe(false);
  });

  it("adopts temporary same-lease geometry, fences the old runtime and restores wanted control without NEW", async () => {
    const f = fixture("darwin", true); await flush(); f.post({ type: "framePresented" }); await f.controller.loadModes();
    const oldInit = runtime.receive.mock.calls.filter(([value]) => value.type === "init").at(-1)![0];
    await f.controller.setMode("mode"); await flush();
    expect(f.inputCalls.find(call => call.name === "setRemoteDesktopDisplayMode")?.input).toMatchObject({ temporary: true, leaseId: "lease", controlGeneration: 2n });
    expect(f.inputCalls.filter(call => call.name === "startRemoteDesktop")).toHaveLength(1);
    expect(f.inputCalls.filter(call => call.name === "stopRemoteDesktop")).toHaveLength(0);
    expect(f.controller.snapshot).toMatchObject({ lease: { leaseId: "lease", display: { width: 1000, height: 700 }, controlGeneration: 3n }, ready: false, controlling: true });
    const nextInit = runtime.receive.mock.calls.filter(([value]) => value.type === "init").at(-1)![0];
    expect(nextInit).toMatchObject({ width: 1000, height: 700 });
    expect(nextInit.epoch).not.toBe(oldInit.epoch); expect(nextInit.inputSequenceBase).toBeGreaterThan(oldInit.inputSequenceBase);
    runtime.post?.({ type: "framePresented", epoch: oldInit.epoch }); expect(f.controller.snapshot.ready).toBe(false);
    runtime.post?.({ type: "input", epoch: oldInit.epoch, sequence: oldInit.inputSequenceBase + 1, events: [{ kind: "release" }] }); await flush();
    expect(f.inputCalls.some(call => call.name === "sendRemoteDesktopInput")).toBe(false);
    f.post({ type: "framePresented" }); expect(f.controller.snapshot.ready).toBe(true);
  });

  it("does not reacquire temporary mode control after the user withdraws it during the write", async () => {
    const f = fixture("darwin", true); await flush(); f.post({ type: "framePresented" }); await f.controller.loadModes();
    const original = vi.mocked(f.api.request).getMockImplementation()!; let finish!: () => void;
    vi.mocked(f.api.request).mockImplementation(async (...args) => {
      if (args[1] === "setRemoteDesktopDisplayMode") await new Promise<void>(resolve => { finish = resolve; });
      return original(...args);
    });
    const pending = f.controller.setMode("mode"); await flush(); await f.controller.control(false); finish(); await pending;
    expect(f.controller.snapshot).toMatchObject({ controlling: false, lease: { controlGeneration: 3n } });
    expect(f.inputCalls.filter(call => call.name === "setRemoteDesktopControl")).toHaveLength(1);
  });

  it.each([RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE, undefined])("keeps temporary mode outcome %s for explicit exact STOPPED recovery without replay", async (reason) => {
    const f = fixture("darwin", true); await flush(); f.post({ type: "framePresented" }); await f.controller.loadModes();
    const original = vi.mocked(f.api.request).getMockImplementation()!;
    vi.mocked(f.api.request).mockImplementation(async (...args) => args[1] === "setRemoteDesktopDisplayMode"
      ? { ok: false, code: reason === undefined ? Code.Unavailable : Code.FailedPrecondition, reason: reason ?? RemoteDesktopFailureReason.UNSPECIFIED }
      : args[1] === "stopRemoteDesktop" ? { ok: false, code: Code.FailedPrecondition, reason: RemoteDesktopFailureReason.STOPPED } : original(...args));
    await f.controller.setMode("mode"); await vi.advanceTimersByTimeAsync(5000);
    expect(f.controller.snapshot).toMatchObject({ status: "error", controlling: false, ready: false, modeNotice: reason === undefined ? "change-failed" : "restore-unavailable" });
    expect(f.inputCalls.filter(call => call.name === "startRemoteDesktop")).toHaveLength(1);
    await f.controller.retry(); await flush();
    expect(vi.mocked(f.api.request).mock.calls.filter(call => call[1] === "setRemoteDesktopDisplayMode")).toHaveLength(1);
    expect(f.inputCalls.filter(call => call.name === "startRemoteDesktop")).toHaveLength(2);
    expect(f.controller.snapshot.modeNotice).toBeUndefined();
  });

  it("rejects a replacement lease in a temporary mode receipt", async () => {
    const f = fixture("darwin", true); await flush(); f.post({ type: "framePresented" }); await f.controller.loadModes();
    const original = vi.mocked(f.api.request).getMockImplementation()!;
    const method = RemoteDesktopService.method.setRemoteDesktopDisplayMode;
    vi.mocked(f.api.request).mockImplementation(async (...args) => args[1] === method.localName ? {
      ok: true, bytes: toBinary(method.output, create(method.output, { result: { lease: { leaseId: "replacement", display: { displayId: "one", width: 1000, height: 700 }, controlGeneration: 3n } } }))
    } : original(...args));
    await f.controller.setMode("mode"); expect(f.controller.snapshot).toMatchObject({ status: "error", lease: { leaseId: "lease" }, modeNotice: "change-failed" });
  });

  it("refreshes the mode picker after explicit original-mode recovery and does not retry a refused restore automatically", async () => {
    const f = fixture("darwin", true); await flush(); f.post({ type: "framePresented" });
    const original = vi.mocked(f.api.request).getMockImplementation()!;
    const modesMethod = RemoteDesktopService.method.listRemoteDesktopDisplayModes;
    let refuse = true, originalRestored = false, starts = 0;
    vi.mocked(f.api.request).mockImplementation(async (...args) => {
      if (args[1] === "setRemoteDesktopDisplayMode") return { ok: false, code: Code.FailedPrecondition, reason: RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE };
      if (args[1] === "stopRemoteDesktop") return { ok: false, code: Code.FailedPrecondition, reason: RemoteDesktopFailureReason.STOPPED };
      if (args[1] === "startRemoteDesktop") {
        starts++; if (refuse) { refuse = false; return { ok: false, code: Code.FailedPrecondition, reason: RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE }; }
        originalRestored = true;
      }
      if (args[1] === modesMethod.localName && originalRestored) return { ok: true, bytes: toBinary(modesMethod.output, create(modesMethod.output,
        { modes: [{ modeId: "original", width: 1200, height: 800, current: true }, { modeId: "mode", width: 1000, height: 700 }] })) };
      return original(...args);
    });
    await f.controller.setMode("mode"); await f.controller.retry(); await flush();
    expect(f.controller.snapshot).toMatchObject({ status: "error", modeNotice: "restore-unavailable" });
    await vi.advanceTimersByTimeAsync(8000); expect(starts).toBe(1); expect(originalRestored).toBe(false);
    await f.controller.retry(); await flush(); f.post({ type: "framePresented" });
    expect(starts).toBe(2); expect(f.controller.snapshot.modes.find(mode => mode.current)?.modeId).toBe("original");
    expect(f.controller.snapshot).toMatchObject({ status: "live", controlling: true, ready: true, modeNotice: undefined });
    expect(vi.mocked(f.api.request).mock.calls.filter(call => call[1] === "setRemoteDesktopDisplayMode")).toHaveLength(1);
  });

  it("restores a fresh ordinary lease after confirmed native authentication without a second prompt", async () => {
    const f = fixture("darwin"); await flush();
    vi.mocked(f.api.credential).mockResolvedValueOnce({ ok: true, authenticated: true,
      state: { available: true, autoUnlock: true, biometricAvailable: true, biometricVerification: false } });
    f.post({ type: "framePresented" }); await flush();
    expect(f.inputCalls.filter(call => call.name === "stopRemoteDesktop")).toHaveLength(1);
    expect(f.inputCalls.filter(call => call.name === "startRemoteDesktop")).toHaveLength(2);
    f.post({ type: "framePresented" }); await flush(); expect(f.api.credential).toHaveBeenCalledOnce();
    expect(f.controller.snapshot).toMatchObject({ controlling: true, credentialBusy: false, credential: { autoUnlock: true } });
  });

  it("starts native auto unlock only after an actual frame, once per connection, with view-only settings", async () => {
    const f = fixture("darwin"); await flush(); expect(f.api.credential).not.toHaveBeenCalled();
    f.post({ type: "framePresented" }); await flush();
    expect(f.api.credential).toHaveBeenCalledExactlyOnceWith(1, "unlock", undefined);
    f.post({ type: "framePresented" }); await flush(); expect(f.api.credential).toHaveBeenCalledOnce();
    await f.controller.control(false); await f.controller.credential("enable");
    expect(f.api.credential).toHaveBeenLastCalledWith(1, "enable", undefined);
    expect(f.controller.snapshot).toMatchObject({ controlling: false, credentialBusy: false, credential: { autoUnlock: false } });
  });

  it("keeps native password failure for explicit setup Retry, ignores retired callbacks and has no settings on Windows", async () => {
    const f = fixture("darwin"); await flush();
    vi.mocked(f.api.credential).mockResolvedValueOnce({ ok: false, notice: "password" });
    f.post({ type: "framePresented" }); await flush(); expect(f.controller.snapshot.credentialNotice).toBe("password");
    f.controller.retryCredential(); await flush(); expect(f.api.credential).toHaveBeenLastCalledWith(1, "enable", undefined);
    let finish!: (value: Awaited<ReturnType<DesktopRemoteDesktopViewerApi["credential"]>>) => void;
    vi.mocked(f.api.credential).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.controller.credential("enable"); f.scope({ ...SCOPE, active: false, generation: 2 });
    finish({ ok: true, authenticated: true, state: { available: true, autoUnlock: true, biometricAvailable: true, biometricVerification: true } }); await pending;
    expect(f.controller.snapshot).toMatchObject({ credential: undefined, credentialBusy: false });
    const windows = fixture(); await flush(); windows.post({ type: "framePresented" }); await flush();
    await windows.controller.credential("enable"); expect(windows.api.credential).not.toHaveBeenCalled();
  });

  it("requires control for privacy opt-in and allows disabling saved intent in view-only mode", async () => {
    const f = fixture(); await flush(); f.post({ type: "framePresented" }); await f.controller.control(false);
    await f.controller.privacyScreen(true); expect(f.api.preferences).not.toHaveBeenCalled();
    f.scope({ ...SCOPE, active: true, privacyScreen: true });
    await f.controller.privacyScreen(false);
    expect(f.api.preferences).toHaveBeenCalledWith(1, { privacyScreen: false });
    expect(f.controller.snapshot).toMatchObject({ privacyScreenDesired: false, privacyScreenActive: false, controlling: false, ready: true });
  });

  it("saves privacy before applying, preserves a failed view without heartbeat replay, and updates the saved exit intent", async () => {
    const f = fixture(); await flush(); f.post({ type: "framePresented" }); await flush();
    let save!: (value: Awaited<ReturnType<DesktopRemoteDesktopViewerApi["preferences"]>>) => void;
    vi.mocked(f.api.preferences).mockImplementationOnce(() => new Promise(resolve => { save = resolve; }));
    const original = vi.mocked(f.api.request).getMockImplementation()!;
    let fail = true;
    vi.mocked(f.api.request).mockImplementation(async (generation, name, bytes) => {
      if (name === "setRemoteDesktopPrivacyScreen" && fail) {
        fail = false; return { ok: false, code: Code.FailedPrecondition, reason: RemoteDesktopFailureReason.PRIVACY_FAILED };
      }
      return original(generation, name, bytes);
    });
    const pending = f.controller.privacyScreen(true); await flush();
    expect(f.controller.snapshot).toMatchObject({ privacyScreenDesired: false, privacyScreenPending: true });
    save({ audio: true, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: true }); await pending;
    expect(f.controller.snapshot).toMatchObject({ privacyScreenDesired: true, privacyScreenActive: false, privacyScreenNotice: "effect", ready: true, status: "live" });
    const requests = vi.mocked(f.api.request).mock.calls.filter(call => call[1] === "setRemoteDesktopPrivacyScreen").length;
    await vi.advanceTimersByTimeAsync(9000);
    expect(vi.mocked(f.api.request).mock.calls.filter(call => call[1] === "setRemoteDesktopPrivacyScreen")).toHaveLength(requests);
    f.controller.retryPrivacyScreen(); await flush(); expect(f.controller.snapshot.privacyScreenActive).toBe(true);
    await f.controller.lockOnExit(true); await flush();
    const last = f.inputCalls.filter(call => call.name === "setRemoteDesktopPrivacyScreen").at(-1)?.input["request"];
    expect(last).toMatchObject({ enabled: true, lockOnExit: true, leaseId: "lease", controlGeneration: 2n });
    vi.mocked(document.hasFocus).mockReturnValue(false); f.controller.focusLost();
    expect(f.controller.snapshot.privacyScreenActive).toBe(true);
  });

  it("keeps saved privacy after persistence failure and ignores a retired effect receipt", async () => {
    const f = fixture(); await flush(); f.post({ type: "framePresented" }); await flush();
    vi.mocked(f.api.preferences).mockRejectedValueOnce(new Error("disk failed"));
    await f.controller.privacyScreen(true); expect(f.controller.snapshot).toMatchObject({ privacyScreenDesired: false, privacyScreenNotice: "save" });
    const original = vi.mocked(f.api.request).getMockImplementation()!;
    let acknowledge!: () => void;
    vi.mocked(f.api.request).mockImplementation(async (generation, name, bytes) => {
      if (name === "setRemoteDesktopPrivacyScreen") await new Promise<void>(resolve => { acknowledge = resolve; });
      return original(generation, name, bytes);
    });
    f.controller.retryPrivacyScreen(); await flush();
    expect(f.controller.snapshot.privacyScreenDesired).toBe(true);
    f.scope({ ...SCOPE, generation: 2, active: false, privacyScreen: true }); acknowledge(); await flush();
    expect(f.controller.snapshot).toMatchObject({ privacyScreenDesired: true, privacyScreenActive: false, privacyScreenPending: false, status: "inactive" });
  });

  it("requires control for the first clipboard sync opt-in but permits disabling saved intent in view-only mode", async () => {
    const f = fixture(); await flush(); f.post({ type: "framePresented" }); await f.controller.control(false);
    expect(f.controller.snapshot).toMatchObject({ ready: true, controlling: false, clipboardSyncDesired: false });
    await f.controller.clipboardSync(true); expect(f.api.preferences).not.toHaveBeenCalled();
    f.scope({ ...SCOPE, active: true, clipboardSync: true });
    await f.controller.clipboardSync(false);
    expect(f.api.preferences).toHaveBeenCalledWith(1, { clipboardSync: false });
    expect(f.controller.snapshot).toMatchObject({ clipboardSyncDesired: false, controlling: false, ready: true });
  });

  it.each(["permission", "unknown"] as const)("keeps clipboard RPCs in Main and adopts saved intent with explicit %s Retry", async notice => {
    const f = fixture(); await flush(); f.post({ type: "framePresented" });
    let save!: (value: { audio: boolean; hostMute: boolean; lockOnExit: boolean; clipboardSync: boolean; privacyScreen: boolean }) => void;
    vi.mocked(f.api.preferences).mockImplementationOnce(() => new Promise((resolve) => { save = resolve; }));
    const pending = f.controller.clipboardSync(true);
    expect(f.controller.snapshot).toMatchObject({ clipboardSyncDesired: false, clipboardSyncSaving: true, clipboardSyncActive: false });
    save({ audio: true, hostMute: false, lockOnExit: false, clipboardSync: true, privacyScreen: false }); await pending;
    expect(f.controller.snapshot).toMatchObject({ clipboardSyncDesired: true, clipboardSyncSaving: false, clipboardSyncActive: false });
    expect(f.inputCalls.some((call) => /ClipboardSync|ClipboardVersion|ClipboardContent/u.test(call.name))).toBe(false);
    f.scope({ ...SCOPE, active: true, clipboardSync: true, clipboardSyncState: { available: true, active: true, pending: false } });
    expect(f.controller.snapshot).toMatchObject({ clipboardSyncActive: true, ready: true });
    f.scope({ ...SCOPE, active: true, clipboardSync: true, clipboardSyncState: { available: true, active: false, pending: false, notice } });
    expect(f.controller.snapshot).toMatchObject({ clipboardSyncNotice: notice, ready: true, status: "live" });
    await vi.advanceTimersByTimeAsync(4500); expect(f.api.retryClipboardSync).not.toHaveBeenCalled();
    await f.controller.retryClipboardSync(); expect(f.api.retryClipboardSync).toHaveBeenCalledWith(1);
  });

  it("retains confirmed clipboard sync intent after save failure and rejects old window save/status receipts", async () => {
    const f = fixture(); await flush(); f.post({ type: "framePresented" });
    vi.mocked(f.api.preferences).mockRejectedValueOnce(new Error("Disk failed"));
    await f.controller.clipboardSync(true);
    expect(f.controller.snapshot).toMatchObject({ clipboardSyncDesired: false, clipboardSyncNotice: "save", ready: true });
    await f.controller.retryClipboardSync(); expect(f.controller.snapshot.clipboardSyncDesired).toBe(true);
    let save!: (value: { audio: boolean; hostMute: boolean; lockOnExit: boolean; clipboardSync: boolean; privacyScreen: boolean }) => void;
    vi.mocked(f.api.preferences).mockImplementationOnce(() => new Promise((resolve) => { save = resolve; }));
    const pending = f.controller.clipboardSync(false);
    f.scope({ ...SCOPE, generation: 2, active: true, clipboardSync: true });
    save({ audio: true, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false }); await pending;
    f.scope({ ...SCOPE, generation: 1, active: true, clipboardSync: false, clipboardSyncState: { available: true, active: true, pending: false } });
    expect(f.controller.snapshot).toMatchObject({ clipboardSyncDesired: true, clipboardSyncActive: false, clipboardSyncSaving: false });
  });

  it.each([RemoteDesktopFailureReason.STOPPED, RemoteDesktopFailureReason.LEASE_EXPIRED])("recovers only an explicit failed exit through certain old-lease termination %s and a fresh connection", async (reason) => {
    const f = fixture(); await flush(); f.post({ type: "framePresented" }); await f.controller.lockOnExit(true);
    vi.mocked(f.api.close).mockRejectedValueOnce(new Error("Lock failed")).mockRejectedValueOnce(new Error("Lock expired"));
    await f.controller.close(); await f.controller.close();
    expect(f.controller.snapshot.closeNotice).toBe("lock"); expect(f.api.close).toHaveBeenCalledTimes(2);
    const original = vi.mocked(f.api.request).getMockImplementation()!;
    vi.mocked(f.api.request).mockImplementationOnce(async () => ({ ok: false, code: Code.FailedPrecondition, reason: RemoteDesktopFailureReason.LOCK_FAILED }));
    const starts = f.inputCalls.filter((call) => call.name === "startRemoteDesktop").length;
    await f.controller.retry(); expect(f.inputCalls.filter((call) => call.name === "startRemoteDesktop")).toHaveLength(starts);
    expect(f.controller.snapshot.closeNotice).toBe("lock");
    vi.mocked(f.api.request).mockImplementation(async (generation, name, bytes) => name === "stopRemoteDesktop"
      ? { ok: false, code: Code.FailedPrecondition, reason }
      : original(generation, name, bytes));
    await f.controller.retry(); await flush(); f.post({ type: "framePresented" });
    expect(f.inputCalls.filter((call) => call.name === "startRemoteDesktop")).toHaveLength(starts + 1);
    expect(f.controller.snapshot).toMatchObject({ ready: true, closeNotice: undefined, lockOnExit: true });
  });

  it("saves lock on exit for a view-only lease before adoption and retains an unconfirmed explicit exit for manual recovery", async () => {
    const f = fixture(); await flush(); f.post({ type: "framePresented" }); await f.controller.control(false);
    let save!: (value: { audio: boolean; hostMute: boolean; lockOnExit: boolean; clipboardSync: boolean; privacyScreen: boolean }) => void;
    vi.mocked(f.api.preferences).mockImplementationOnce(() => new Promise((resolve) => { save = resolve; }));
    const saving = f.controller.lockOnExit(true);
    expect(f.controller.snapshot).toMatchObject({ controlling: false, lockOnExit: false, lockOnExitPending: true });
    await f.controller.close(); expect(f.api.close).not.toHaveBeenCalled();
    save({ audio: true, hostMute: false, lockOnExit: true, clipboardSync: false, privacyScreen: false }); await saving;
    expect(f.controller.snapshot).toMatchObject({ lockOnExit: true, lockOnExitPending: false, ready: true });
    expect(f.inputCalls.some((call) => call.name === "stopRemoteDesktop")).toBe(false);
    let reject!: (error: Error) => void;
    vi.mocked(f.api.close).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const closing = f.controller.close(); expect(f.controller.snapshot.closing).toBe(true);
    reject(new Error("Unknown lock result")); await closing;
    expect(f.controller.snapshot).toMatchObject({ closing: false, ready: false, controlling: false, closeNotice: "lock" });
    expect(runtime.receive).toHaveBeenLastCalledWith({ type: "stop", preserveFrame: true });
    const calls = f.inputCalls.length; await vi.advanceTimersByTimeAsync(9000);
    expect(f.inputCalls).toHaveLength(calls); expect(f.api.close).toHaveBeenCalledTimes(1);
    await f.controller.close(); expect(f.api.close).toHaveBeenCalledTimes(2); expect(f.api.close).toHaveBeenLastCalledWith(1);
  });

  it("preserves saved exit intent on a write failure, explicitly retries it, and ignores an old save or close receipt", async () => {
    const f = fixture(); await flush(); f.post({ type: "framePresented" });
    vi.mocked(f.api.preferences).mockRejectedValueOnce(new Error("Save failed"));
    await f.controller.lockOnExit(true);
    expect(f.controller.snapshot).toMatchObject({ lockOnExit: false, lockOnExitPending: false, lockOnExitNotice: "save", ready: true });
    f.controller.retryLockOnExit(); await flush();
    expect(f.controller.snapshot).toMatchObject({ lockOnExit: true, lockOnExitPending: false, lockOnExitNotice: undefined });
    let save!: (value: { audio: boolean; hostMute: boolean; lockOnExit: boolean; clipboardSync: boolean; privacyScreen: boolean }) => void;
    vi.mocked(f.api.preferences).mockImplementationOnce(() => new Promise((resolve) => { save = resolve; }));
    const saving = f.controller.lockOnExit(false);
    f.scope({ ...SCOPE, generation: 2, active: true, lockOnExit: true, clipboardSync: false });
    save({ audio: true, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false }); await saving; await flush(); f.post({ type: "framePresented" });
    expect(f.controller.snapshot.lockOnExit).toBe(true);
    let reject!: (error: Error) => void;
    vi.mocked(f.api.close).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const closing = f.controller.close();
    f.scope({ ...SCOPE, generation: 3, active: false }); reject(new Error("Old exit failed")); await closing;
    expect(f.controller.snapshot).toMatchObject({ status: "inactive", closing: false, closeNotice: undefined, lockOnExit: false });
  });

  it("persists host mute intent before the exact control request and adopts active state only after acknowledgement", async () => {
    const f = fixture(); await flush(); f.post({ type: "framePresented" });
    let save!: (value: { audio: boolean; hostMute: boolean; lockOnExit: boolean; clipboardSync: boolean; privacyScreen: boolean }) => void, acknowledge!: () => void;
    vi.mocked(f.api.preferences).mockImplementationOnce(() => new Promise((resolve) => { save = resolve; }));
    const original = vi.mocked(f.api.request).getMockImplementation()!;
    vi.mocked(f.api.request).mockImplementation(async (generation, name, bytes) => {
      if (name === "setRemoteDesktopHostMute") await new Promise<void>((resolve) => { acknowledge = resolve; });
      return original(generation, name, bytes);
    });
    const pending = f.controller.hostMute(true);
    expect(f.controller.snapshot).toMatchObject({ hostMuteDesired: false, hostMuteActive: false, hostMutePending: true, ready: true });
    expect(f.inputCalls.some((call) => call.name === "setRemoteDesktopHostMute")).toBe(false);
    save({ audio: true, hostMute: true, lockOnExit: false, clipboardSync: false, privacyScreen: false }); await flush();
    expect(f.controller.snapshot).toMatchObject({ hostMuteDesired: true, hostMuteActive: false, hostMutePending: true, ready: true });
    acknowledge(); await pending;
    expect(f.inputCalls.find((call) => call.name === "setRemoteDesktopHostMute")?.input["request"]).toMatchObject({ leaseId: "lease", controlGeneration: 2n, enabled: true });
    expect(f.controller.snapshot).toMatchObject({ hostMuteDesired: true, hostMuteActive: true, hostMutePending: false, ready: true });
  });

  it("preserves video after host mute failure, performs no heartbeat retry, and retries only on explicit action", async () => {
    const f = fixture(); await flush(); f.post({ type: "framePresented" });
    const original = vi.mocked(f.api.request).getMockImplementation()!;
    let muteAttempts = 0;
    vi.mocked(f.api.request).mockImplementation(async (generation, name, bytes) => {
      if (name === "setRemoteDesktopHostMute" && ++muteAttempts === 1) return {
        ok: false, code: Code.FailedPrecondition, reason: RemoteDesktopFailureReason.HOST_MUTE_UNAVAILABLE
      };
      return original(generation, name, bytes);
    });
    await f.controller.hostMute(true);
    expect(f.controller.snapshot).toMatchObject({ ready: true, status: "live", hostMuteDesired: true, hostMuteActive: false, hostMutePending: false, hostMuteNotice: "effect" });
    await vi.advanceTimersByTimeAsync(9000); expect(muteAttempts).toBe(1);
    f.controller.retryHostMute(); await flush(); expect(muteAttempts).toBe(2);
    expect(f.controller.snapshot).toMatchObject({ ready: true, hostMuteActive: true, hostMutePending: false, hostMuteNotice: undefined });
    await f.controller.hostMute(false);
    expect(f.controller.snapshot).toMatchObject({ hostMuteDesired: false, hostMuteActive: false, ready: true });
  });

  it("resets actual mute on authority loss and ignores a late acknowledgement while reusing the saved intent on a fresh generation", async () => {
    const f = fixture(); await flush(); f.post({ type: "framePresented" });
    const original = vi.mocked(f.api.request).getMockImplementation()!;
    let acknowledge!: () => void;
    vi.mocked(f.api.request).mockImplementation(async (generation, name, bytes) => {
      if (name === "setRemoteDesktopHostMute") await new Promise<void>((resolve) => { acknowledge = resolve; });
      return original(generation, name, bytes);
    });
    const pending = f.controller.hostMute(true); await flush();
    f.scope({ ...SCOPE, generation: 2, hostMute: true, lockOnExit: false, clipboardSync: false }); acknowledge(); await pending;
    expect(f.controller.snapshot).toMatchObject({ hostMuteDesired: true, hostMuteActive: false, hostMutePending: false, status: "inactive" });
    vi.mocked(f.api.request).mockImplementation(original);
    f.scope({ ...SCOPE, generation: 2, hostMute: true, active: true }); await flush(); f.post({ type: "framePresented" }); await flush();
    expect(f.controller.snapshot).toMatchObject({ hostMuteDesired: true, hostMuteActive: true, ready: true });
    await f.controller.control(false);
    expect(f.controller.snapshot).toMatchObject({ hostMuteDesired: true, hostMuteActive: false, hostMutePending: false, ready: true });
  });

  it("loads target audio before connecting and saves a new intent before rebuilding media", async () => {
    const f = fixture(); f.scope({ ...SCOPE, audio: false }); await flush();
    f.scope({ ...SCOPE, active: true, audio: false }); await flush();
    expect(f.controller.snapshot.settings.audio).toBe(false);
    f.post({ type: "framePresented" });
    let complete!: (value: { audio: boolean; hostMute: boolean; lockOnExit: boolean; clipboardSync: boolean; privacyScreen: boolean }) => void;
    vi.mocked(f.api.preferences).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const inits = runtime.receive.mock.calls.filter(([message]) => message.type === "init").length;
    f.controller.settings({ audio: true });
    expect(f.controller.snapshot).toMatchObject({ audioPending: true, settings: { audio: false } });
    expect(runtime.receive.mock.calls.filter(([message]) => message.type === "init")).toHaveLength(inits);
    complete({ audio: true, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false }); await flush();
    expect(f.api.preferences).toHaveBeenCalledWith(1, { audio: true });
    expect(f.controller.snapshot).toMatchObject({ audioPending: false, settings: { audio: true } });
    expect(runtime.receive.mock.calls.filter(([message]) => message.type === "init")).toHaveLength(inits + 1);
  });

  it("preserves the saved audio on failure and discards a retired preference response", async () => {
    const f = fixture(); await flush(); f.post({ type: "framePresented" });
    vi.mocked(f.api.preferences).mockRejectedValueOnce(new Error("Write failed."));
    f.controller.settings({ audio: false }); await flush();
    expect(f.controller.snapshot).toMatchObject({ ready: true, audioPending: false, error: "preferences", settings: { audio: true } });
    f.controller.dismissNotice();
    let complete!: (value: { audio: boolean; hostMute: boolean; lockOnExit: boolean; clipboardSync: boolean; privacyScreen: boolean }) => void;
    vi.mocked(f.api.preferences).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    f.controller.settings({ audio: false });
    f.scope({ ...SCOPE, generation: 2, active: false });
    complete({ audio: false, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false }); await flush();
    expect(f.controller.snapshot).toMatchObject({ status: "inactive", error: undefined, audioPending: false, settings: { audio: true } });
  });

  it("resizes the exact native window to logical display dimensions and toolbar height after presentation", async () => {
    const f = fixture(); await flush();
    f.controller.actualSize(); expect(f.api.resize).not.toHaveBeenCalled();
    f.post({ type: "framePresented" }); f.controller.actualSize();
    expect(f.api.resize).toHaveBeenCalledWith(1, 1200, 860);
    expect(runtime.receive).toHaveBeenLastCalledWith({ type: "actualSize" });
    f.scope({ ...SCOPE, generation: 2, active: false }); f.controller.actualSize();
    expect(f.api.resize).toHaveBeenCalledTimes(1);
  });

  it("starts only after native readiness and enables input only after the exact frame is presented", async () => {
    const f = fixture(); await flush();
    expect(f.api.ready).toHaveBeenCalledWith(1);
    expect(f.inputCalls.find((call) => call.name === "startRemoteDesktop")?.input["displayId"]).toBe("one");
    expect(f.controller.snapshot.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(350);
    runtime.post?.({ type: "framePresented", epoch: "old-lease" }); expect(f.controller.snapshot.ready).toBe(false);
    f.post({ type: "framePresented" });
    expect(f.controller.snapshot).toMatchObject({ ready: true, controlling: true, media: "screenshots", status: "live" });
    expect(runtime.receive).toHaveBeenLastCalledWith({ type: "control", enabled: true });
    await vi.advanceTimersByTimeAsync(3000);
    expect(runtime.receive.mock.calls.filter(([message]) => message.type === "control" && message.enabled === true)).toHaveLength(1);
  });

  it("advances input sequences across media rebuilds and maps native input to the generated contract", async () => {
    const f = fixture(); await flush(); f.post({ type: "framePresented" });
    f.controller.settings({ fps: 60 }); f.post({ type: "framePresented" });
    const inits = runtime.receive.mock.calls.filter(([message]) => message.type === "init");
    expect(inits[1]?.[0].inputSequenceBase).toBeGreaterThan(inits[0]?.[0].inputSequenceBase);
    const sequence = inits[1]?.[0].inputSequenceBase + 10;
    f.post({ type: "input", sequence, events: [{ kind: "text", text: "你好" }, { kind: "release" }] }); await flush();
    const input = f.inputCalls.find((call) => call.name === "sendRemoteDesktopInput")?.input;
    expect(input?.["sequence"]).toBe(BigInt(sequence));
    expect(input?.["events"]).toMatchObject([{ event: { case: "text", value: { text: "你好" } } }, { event: { case: "release" } }]);
  });

  it("discards late control results and old media after the native window generation changes", async () => {
    const f = fixture(); await flush();
    let complete!: (value: object) => void;
    f.pendingControl(new Promise((resolve) => { complete = resolve; }));
    const pending = f.controller.control(true); await flush();
    f.scope({ ...SCOPE, generation: 2, active: false }); complete({ state: { controlling: true, controlGeneration: 3n } }); await pending;
    runtime.post?.({ type: "framePresented", epoch: "lease" });
    expect(f.controller.snapshot).toMatchObject({ status: "inactive", ready: false, controlling: false });
    const requests = f.inputCalls.length; await vi.advanceTimersByTimeAsync(10000); expect(f.inputCalls).toHaveLength(requests);
  });

  it("resumes only a typed expired lease and stops automatic work after a terminal access failure", async () => {
    const f = fixture(); await flush(); f.post({ type: "framePresented" }); f.expire();
    await vi.advanceTimersByTimeAsync(4000); await flush();
    const starts = f.inputCalls.filter((call) => call.name === "startRemoteDesktop");
    expect(starts.at(-1)?.input["mode"]).toBe(2);
    vi.mocked(f.api.request).mockResolvedValue({ ok: false, code: Code.PermissionDenied, reason: RemoteDesktopFailureReason.AUTHORITY_CHANGED });
    await vi.advanceTimersByTimeAsync(4000); expect(f.controller.snapshot.error).toBe("revoked");
    const requests = f.inputCalls.length; await vi.advanceTimersByTimeAsync(10000); expect(f.inputCalls).toHaveLength(requests);
  });

  it("keeps clipboard failure scoped to viewing and withdraws input before closing", async () => {
    const f = fixture(); await flush(); f.post({ type: "framePresented" });
    vi.mocked(f.api.clipboard).mockRejectedValueOnce(new Error("Clipboard unavailable."));
    await f.controller.clipboard("copy"); expect(f.controller.snapshot).toMatchObject({ ready: true, error: "clipboard" });
    expect(f.inputCalls.filter((call) => call.name === "stopRemoteDesktop")).toHaveLength(0);
    await f.controller.close(); expect(f.api.close).toHaveBeenCalledWith(1);
    expect(f.controller.snapshot).toMatchObject({ closing: true, controlling: false });
    expect(runtime.receive).toHaveBeenLastCalledWith({ type: "control", enabled: false });
  });

  it.each(["retry", "display", "mode"] as const)("retires a late %s action without changing the replacement window", async (action) => {
    const f = fixture(); await flush(); f.post({ type: "framePresented" });
    if (action === "mode") await f.controller.loadModes();
    let complete!: () => void;
    const original = vi.mocked(f.api.request).getMockImplementation()!;
    vi.mocked(f.api.request).mockImplementation(async (...args) => {
      if (args[1] === "stopRemoteDesktop" || args[1] === "setRemoteDesktopDisplayMode") await new Promise<void>((accept) => { complete = accept; });
      return original(...args);
    });
    const pending = action === "retry" ? f.controller.retry() : action === "display" ? f.controller.selectDisplay("two") : f.controller.setMode("mode");
    await flush(); f.scope({ ...SCOPE, generation: 2, active: false }); complete(); await pending;
    expect(f.controller.snapshot).toMatchObject({ status: "inactive", ready: false, settingsBusy: false, error: undefined });
    expect(f.inputCalls.filter((call) => call.name === "startRemoteDesktop")).toHaveLength(1);
  });

  it("coalesces media settings behind an unfinished offer and rejects the old presentation epoch", async () => {
    const f = fixture(); await flush(); f.post({ type: "framePresented" });
    const original = vi.mocked(f.api.request).getMockImplementation()!;
    let complete!: () => void;
    const offers: Record<string, unknown>[] = [];
    vi.mocked(f.api.request).mockImplementation(async (...args) => {
      if (args[1] !== "createRemoteDesktopOffer") return original(...args);
      const method = RemoteDesktopService.method.createRemoteDesktopOffer;
      const input = fromBinary(method.input, args[2]); offers.push(input as unknown as Record<string, unknown>);
      if (offers.length === 1) await new Promise<void>((accept) => { complete = accept; });
      return { ok: true, bytes: toBinary(method.output, create(method.output, { offer: { attemptId: input.attemptId, answerSdp: "answer" } })) };
    });
    const oldEpoch = runtime.receive.mock.calls.filter(([value]) => value.type === "init").at(-1)?.[0].epoch;
    f.post({ type: "offer", attemptId: "first", sdp: "offer" }); await flush();
    f.controller.settings({ fps: 60 }); f.controller.settings({ quality: RemoteDesktopVideoQuality.HD });
    expect(runtime.receive.mock.calls.filter(([value]) => value.type === "init")).toHaveLength(1);
    runtime.post?.({ type: "framePresented", epoch: oldEpoch }); expect(f.controller.snapshot.ready).toBe(false);
    complete(); await flush();
    const inits = runtime.receive.mock.calls.filter(([value]) => value.type === "init"); expect(inits).toHaveLength(2);
    expect(inits[1]?.[0].epoch).not.toBe(oldEpoch);
    f.post({ type: "offer", attemptId: "second", sdp: "offer" }); await flush();
    expect(offers).toHaveLength(2); expect(offers[1]?.["settings"]).toMatchObject({ fps: 60, quality: RemoteDesktopVideoQuality.HD });
    expect(runtime.receive.mock.calls.filter(([value]) => value.type === "answer")).toHaveLength(1);
  });

  it("stops signaling work after a typed access failure", async () => {
    const f = fixture(); await flush(); f.post({ type: "framePresented" });
    vi.mocked(f.api.request).mockResolvedValue({ ok: false, code: Code.PermissionDenied, reason: RemoteDesktopFailureReason.AUTHORITY_CHANGED });
    f.post({ type: "iceConfig", attemptId: "attempt" }); await flush();
    expect(f.controller.snapshot).toMatchObject({ status: "error", error: "revoked" });
    const count = vi.mocked(f.api.request).mock.calls.length; await vi.advanceTimersByTimeAsync(10000);
    expect(vi.mocked(f.api.request).mock.calls).toHaveLength(count);
  });
});
