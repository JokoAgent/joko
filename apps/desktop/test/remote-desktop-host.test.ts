import {
  RemoteDesktopClipboardContentSchema,
  RemoteDesktopFailureReason,
  RemoteDesktopStartMode,
  RemoteDesktopVideoSettingsSchema
} from "@joko/contracts";
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DesktopRemoteDesktopHost,
  type DesktopRemoteDesktopClipboardPort,
  type DesktopRemoteDesktopHostDependencies,
  type DesktopRemoteDesktopInputPort,
  type DesktopRemoteDesktopMediaPort
} from "../src/remote-desktop-host.js";
import type { DesktopRemoteDesktopSessionState } from "../src/remote-desktop-input.js";

const REQUEST = Object.freeze({
  controllerDeviceId: "controller-a",
  signal: new AbortController().signal
});

describe("Desktop Remote Desktop host", () => {
  const hosts: DesktopRemoteDesktopHost[] = [];

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.retire()));
  });

  it("is explicitly disabled by default and Linux stays view-only", async () => {
    const disabled = fixture({ enabled: false, platform: "win32" });
    hosts.push(disabled.host);
    const capabilities = await disabled.host.getCapabilities(REQUEST);
    expect(capabilities.enabled).toBe(false);
    expect(capabilities.displays).toEqual([]);
    await expect(disabled.host.start({
      ...REQUEST,
      displayId: "display-1",
      mode: RemoteDesktopStartMode.NEW
    })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.DISABLED });

    const linux = fixture({ enabled: true, platform: "linux" });
    hosts.push(linux.host);
    const lease = await linux.host.start({
      ...REQUEST,
      displayId: "display-1",
      mode: RemoteDesktopStartMode.NEW
    });
    expect((await linux.host.getCapabilities(REQUEST)).canControl).toBe(false);
    expect(await linux.host.getCapabilities(REQUEST)).toMatchObject({
      videoSettings: true,
      systemAudio: false,
      backgroundViewing: true
    });
    await expect(linux.host.setControl({
      ...REQUEST,
      leaseId: lease.leaseId,
      enabled: true
    })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.VIEW_ONLY });
    expect(linux.input.start).not.toHaveBeenCalled();
    expect(linux.host.state?.controlling).toBe(false);
  });

  it("uses only trusted presentation pongs to renew view-only proof", async () => {
    const value = fixture({ enabled: true, platform: "win32" });
    hosts.push(value.host);
    expect(await value.host.getCapabilities(REQUEST)).toMatchObject({
      videoSettings: true,
      systemAudio: true,
      backgroundViewing: true
    });
    const lease = await value.host.start({
      ...REQUEST,
      displayId: "display-1",
      mode: RemoteDesktopStartMode.NEW
    });
    const control = await value.host.setControl({
      ...REQUEST,
      leaseId: lease.leaseId,
      enabled: true
    });
    const presentation = await value.host.setPresentation({
      ...REQUEST,
      leaseId: lease.leaseId,
      enabled: true
    });
    expect(presentation.controlling).toBe(false);
    expect(presentation.controlGeneration).toBeGreaterThan(control.controlGeneration);
    expect(value.input.stop).toHaveBeenCalled();
    expect(value.media.setPresentation).toHaveBeenCalledWith(lease.leaseId, true);

    await expect(value.host.probePresentation({
      ...REQUEST,
      leaseId: lease.leaseId
    })).resolves.toMatchObject({ leaseId: lease.leaseId, proofSequence: 0n });
    value.presentationPong(lease.leaseId);
    await expect(value.host.probePresentation({
      ...REQUEST,
      leaseId: lease.leaseId
    })).resolves.toMatchObject({ leaseId: lease.leaseId, proofSequence: 1n });

    await value.host.setControl({ ...REQUEST, leaseId: lease.leaseId, enabled: true });
    expect(value.media.setPresentation).toHaveBeenLastCalledWith(lease.leaseId, false);
    value.presentationPong(lease.leaseId);
    await expect(value.host.probePresentation({
      ...REQUEST,
      leaseId: lease.leaseId
    })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.LEASE_EXPIRED });
  });

  it("preserves viewing and reports view-only after native input failure", async () => {
    const value = fixture({ enabled: true, platform: "win32" });
    hosts.push(value.host);
    vi.mocked(value.input.start).mockRejectedValueOnce(
      new Error("REMOTE_DESKTOP_ACCESSIBILITY_PERMISSION_REQUIRED")
    );
    const lease = await value.host.start({
      ...REQUEST,
      displayId: "display-1",
      mode: RemoteDesktopStartMode.NEW
    });

    await expect(value.host.setControl({
      ...REQUEST,
      leaseId: lease.leaseId,
      enabled: true
    })).rejects.toMatchObject({
      reason: RemoteDesktopFailureReason.ACCESSIBILITY_PERMISSION_REQUIRED
    });
    expect(value.host.state).toMatchObject({ leaseId: lease.leaseId, controlling: false });
    expect(value.media.stop).not.toHaveBeenCalled();
    expect(value.input.stop).toHaveBeenCalled();
  });

  it("advertises and executes explicit clipboard effects only for the exact control generation", async () => {
    const value = fixture({ enabled: true, platform: "win32" });
    hosts.push(value.host);
    const capabilities = await value.host.getCapabilities(REQUEST);
    expect(capabilities.clipboardText).toBe(true);
    expect(capabilities.clipboardContent).toBe(true);
    const lease = await value.host.start({
      ...REQUEST,
      displayId: "display-1",
      mode: RemoteDesktopStartMode.NEW
    });
    const control = await value.host.setControl({
      ...REQUEST,
      leaseId: lease.leaseId,
      enabled: true
    });
    expect(value.host.isControlCurrent({
      ...REQUEST,
      leaseId: lease.leaseId,
      controlGeneration: control.controlGeneration
    })).toBe(true);

    await expect(value.host.copyClipboardText({
      ...REQUEST,
      leaseId: lease.leaseId,
      controlGeneration: control.controlGeneration
    })).resolves.toBe("selected text");
    expect(value.clipboard.copyText).toHaveBeenCalledOnce();
    const current = vi.mocked(value.clipboard.copyText).mock.calls[0]![0];
    expect(current()).toBe(true);

    await value.host.pasteClipboardContent({
      ...REQUEST,
      leaseId: lease.leaseId,
      controlGeneration: control.controlGeneration,
      content: create(RemoteDesktopClipboardContentSchema, {
        text: "caption",
        url: "https://example.test/"
      })
    });
    expect(value.clipboard.pasteContent).toHaveBeenCalledWith(
      { text: "caption", url: "https://example.test/" },
      expect.any(Function),
      REQUEST.signal
    );

    await expect(value.host.copyClipboardText({
      ...REQUEST,
      leaseId: lease.leaseId,
      controlGeneration: lease.controlGeneration
    })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.CLIPBOARD_EXPIRED });
    expect(value.clipboard.copyText).toHaveBeenCalledOnce();

    value.host.releaseControl();
    expect(value.host.isControlCurrent({
      ...REQUEST,
      leaseId: lease.leaseId,
      controlGeneration: control.controlGeneration
    })).toBe(false);
  });

  it("rejects a clipboard completion after control changes", async () => {
    const value = fixture({ enabled: true, platform: "darwin" });
    hosts.push(value.host);
    const lease = await value.host.start({
      ...REQUEST,
      displayId: "display-1",
      mode: RemoteDesktopStartMode.NEW
    });
    const control = await value.host.setControl({
      ...REQUEST,
      leaseId: lease.leaseId,
      enabled: true
    });
    let resolveCopy!: (text: string) => void;
    vi.mocked(value.clipboard.copyText).mockImplementationOnce(() =>
      new Promise((resolve) => { resolveCopy = resolve; }));
    const pending = value.host.copyClipboardText({
      ...REQUEST,
      leaseId: lease.leaseId,
      controlGeneration: control.controlGeneration
    });
    await vi.waitFor(() => expect(value.clipboard.copyText).toHaveBeenCalledOnce());
    await value.host.setControl({
      ...REQUEST,
      leaseId: lease.leaseId,
      enabled: false
    });
    resolveCopy("stale selected text");
    await expect(pending).rejects.toMatchObject({
      reason: RemoteDesktopFailureReason.CLIPBOARD_EXPIRED
    });
    await expect(value.host.heartbeat({
      ...REQUEST,
      leaseId: lease.leaseId
    })).resolves.toMatchObject({ controlling: false });
  });

  it("rejects uint64 input outside JavaScript's exact integer range", async () => {
    const value = fixture({ enabled: true, platform: "win32" });
    hosts.push(value.host);
    await expect(value.host.sendInput({
      ...REQUEST,
      leaseId: "lease-1",
      sequence: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      events: []
    })).rejects.toThrowError("outside the exact integer range");
    expect(value.input.send).not.toHaveBeenCalled();
  });

  it("invalidates pending async media completion when its executor retires", async () => {
    const value = fixture({ enabled: true, platform: "darwin" });
    hosts.push(value.host);
    const lease = await value.host.start({
      ...REQUEST,
      displayId: "display-1",
      mode: RemoteDesktopStartMode.NEW
    });
    let resolveOffer!: (answer: string) => void;
    vi.mocked(value.media.offer).mockImplementationOnce(() => new Promise((resolve) => {
      resolveOffer = resolve;
    }));
    const pending = value.host.createOffer({
      ...REQUEST,
      leaseId: lease.leaseId,
      attemptId: "attempt-1",
      offerSdp: "offer",
      cursorOverlay: false
    });
    await vi.waitFor(() => expect(value.media.offer).toHaveBeenCalledOnce());
    const retired = value.host.retire();
    resolveOffer("answer");
    await retired;

    await expect(pending).rejects.toMatchObject({
      reason: RemoteDesktopFailureReason.AUTHORITY_CHANGED
    });
    expect(value.media.stop).toHaveBeenCalled();
    expect(value.input.stop).toHaveBeenCalled();
    expect(value.media.retire).toHaveBeenCalledOnce();
    expect(value.input.retire).toHaveBeenCalledOnce();
  });

  it("passes the fixed video settings and preserves typed system-audio failure", async () => {
    const value = fixture({ enabled: true, platform: "win32" });
    hosts.push(value.host);
    const lease = await value.host.start({
      ...REQUEST,
      displayId: "display-1",
      mode: RemoteDesktopStartMode.NEW
    });
    await value.host.createOffer({
      ...REQUEST,
      leaseId: lease.leaseId,
      attemptId: "attempt-settings",
      offerSdp: "offer",
      cursorOverlay: false,
      settings: create(RemoteDesktopVideoSettingsSchema, {
        fps: 60,
        bitrate: 8_000_000,
        audio: true
      })
    });
    expect(value.media.offer).toHaveBeenLastCalledWith(expect.objectContaining({
      leaseId: lease.leaseId,
      attemptId: "attempt-settings",
      settings: { fps: 60, bitrate: 8_000_000, audio: true }
    }));

    vi.mocked(value.media.offer).mockRejectedValueOnce(
      new Error("REMOTE_DESKTOP_AUDIO_UNAVAILABLE")
    );
    await expect(value.host.createOffer({
      ...REQUEST,
      leaseId: lease.leaseId,
      attemptId: "attempt-audio-unavailable",
      offerSdp: "offer",
      cursorOverlay: false,
      settings: create(RemoteDesktopVideoSettingsSchema, {
        fps: 30,
        bitrate: 0,
        audio: true
      })
    })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.AUDIO_UNAVAILABLE });
  });

  it("maps a bounded native cursor and always forwards the explicit overlay bit", async () => {
    const value = fixture({ enabled: true, platform: "darwin" });
    hosts.push(value.host);
    const png = cursorPng();
    vi.mocked(value.media.frame).mockResolvedValueOnce({
      jpeg: "AQ==",
      width: 1,
      height: 1,
      cursor: {
        visible: true,
        x: 0.25,
        y: 0.75,
        width: 16,
        height: 16,
        hotX: 1,
        hotY: 2,
        png: png.toString("base64")
      }
    });
    const lease = await value.host.start({
      ...REQUEST,
      displayId: "display-1",
      mode: RemoteDesktopStartMode.NEW
    });
    const result = await value.host.getFrame({
      ...REQUEST,
      leaseId: lease.leaseId,
      cursorOverlay: true
    });
    expect(value.media.frame).toHaveBeenCalledWith("display-1", true, REQUEST.signal);
    expect(result.frame?.cursor).toMatchObject({ visible: true, x: 0.25, y: 0.75 });
    expect(Buffer.from(result.frame?.cursor?.png ?? [])).toEqual(png);
  });

  it("exposes display modes only as a complete read/write capability and preserves typed failures", async () => {
    const unavailable = fixture({ enabled: true, platform: "win32" });
    hosts.push(unavailable.host);
    const unavailableLease = await unavailable.host.start({
      ...REQUEST,
      displayId: "display-1",
      mode: RemoteDesktopStartMode.NEW
    });
    expect((await unavailable.host.getCapabilities(REQUEST)).displayModes).toBe(false);
    await expect(unavailable.host.listDisplayModes({
      ...REQUEST,
      leaseId: unavailableLease.leaseId
    })).rejects.toMatchObject({
      reason: RemoteDesktopFailureReason.DISPLAY_MODES_UNAVAILABLE,
      retryable: false
    });

    const value = fixture({ enabled: true, platform: "darwin" });
    hosts.push(value.host);
    const lease = await value.host.start({
      ...REQUEST,
      displayId: "display-1",
      mode: RemoteDesktopStartMode.NEW
    });
    expect((await value.host.getCapabilities(REQUEST)).displayModes).toBe(true);
    await expect(value.host.listDisplayModes({
      ...REQUEST,
      leaseId: lease.leaseId
    })).resolves.toMatchObject([{ modeId: "42", current: true }]);
    const control = await value.host.setControl({
      ...REQUEST,
      leaseId: lease.leaseId,
      enabled: true
    });
    await expect(value.host.setDisplayMode({
      ...REQUEST,
      leaseId: lease.leaseId,
      controlGeneration: control.controlGeneration,
      modeId: "99"
    })).rejects.toMatchObject({
      reason: RemoteDesktopFailureReason.DISPLAY_MODE_MISSING,
      retryable: false
    });
    vi.mocked(value.setDisplayMode).mockRejectedValueOnce(new Error("REMOTE_DESKTOP_DISPLAY_BUSY"));
    await expect(value.host.setDisplayMode({
      ...REQUEST,
      leaseId: lease.leaseId,
      controlGeneration: control.controlGeneration,
      modeId: "42"
    })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.DISPLAY_BUSY, retryable: true });
    expect(value.host.state?.leaseId).toBe(lease.leaseId);

    vi.mocked(value.setDisplayMode).mockImplementationOnce(async (_display, _mode, beforeChange) => {
      beforeChange();
      throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
    });
    await expect(value.host.setDisplayMode({
      ...REQUEST,
      leaseId: lease.leaseId,
      controlGeneration: control.controlGeneration,
      modeId: "42"
    })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.LEASE_EXPIRED });
    expect(value.host.state).toBeUndefined();
  });

  it("fails closed when initially locked and starts only after the session unlocks", async () => {
    const value = fixture({ enabled: true, platform: "win32", sessionUnlocked: false });
    hosts.push(value.host);

    await expect(value.host.getCapabilities(REQUEST)).rejects.toMatchObject({
      reason: RemoteDesktopFailureReason.LOCKED_SESSION_UNSUPPORTED
    });
    await expect(value.host.start({
      ...REQUEST,
      displayId: "display-1",
      mode: RemoteDesktopStartMode.NEW
    })).rejects.toMatchObject({
      reason: RemoteDesktopFailureReason.LOCKED_SESSION_UNSUPPORTED
    });
    expect(value.permissions).not.toHaveBeenCalled();
    expect(value.media.frame).not.toHaveBeenCalled();
    expect(value.media.offer).not.toHaveBeenCalled();
    expect(value.input.start).not.toHaveBeenCalled();

    value.setSessionUnlocked(true);
    const lease = await value.host.start({
      ...REQUEST,
      displayId: "display-1",
      mode: RemoteDesktopStartMode.NEW
    });
    await value.host.getFrame({ ...REQUEST, leaseId: lease.leaseId, cursorOverlay: false });
    await value.host.createOffer({
      ...REQUEST,
      leaseId: lease.leaseId,
      attemptId: "attempt-after-unlock",
      offerSdp: "offer",
      cursorOverlay: false
    });
    expect(value.media.frame).toHaveBeenCalledOnce();
    expect(value.media.offer).toHaveBeenCalledOnce();
  });

  it("ends the complete lease when the session probe cannot prove a logged-in owner", async () => {
    const frameValue = fixture({ enabled: true, platform: "win32" });
    hosts.push(frameValue.host);
    const frameLease = await frameValue.host.start({
      ...REQUEST,
      displayId: "display-1",
      mode: RemoteDesktopStartMode.NEW
    });
    frameValue.setSessionState("unsupported");
    await vi.waitFor(() => expect(frameValue.host.state).toBeUndefined());
    await expect(frameValue.host.getFrame({
      ...REQUEST,
      leaseId: frameLease.leaseId,
      cursorOverlay: false
    })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.LEASE_EXPIRED });
    expect(frameValue.media.frame).not.toHaveBeenCalled();
  });

  it("keeps the viewer lease while a logged-in lock drops old pixels and control", async () => {
    const frameValue = fixture({ enabled: true, platform: "darwin" });
    hosts.push(frameValue.host);
    const frameLease = await frameValue.host.start({
      ...REQUEST,
      displayId: "display-1",
      mode: RemoteDesktopStartMode.NEW
    });
    const control = await frameValue.host.setControl({
      ...REQUEST,
      leaseId: frameLease.leaseId,
      enabled: true
    });
    let resolveFrame!: (frame: null) => void;
    vi.mocked(frameValue.media.frame).mockImplementationOnce(() => new Promise((resolve) => {
      resolveFrame = resolve;
    }));
    const pendingFrame = frameValue.host.getFrame({
      ...REQUEST,
      leaseId: frameLease.leaseId,
      cursorOverlay: true
    });
    await vi.waitFor(() => expect(frameValue.media.frame).toHaveBeenCalledOnce());
    frameValue.setSessionState("locked-logged-in");
    await vi.waitFor(() => expect(frameValue.media.setSessionState).toHaveBeenLastCalledWith(true));
    resolveFrame(null);
    expect((await pendingFrame).frame).toBeUndefined();
    await expect(frameValue.host.heartbeat({
      ...REQUEST,
      leaseId: frameLease.leaseId
    })).resolves.toMatchObject({ controlling: false });
    expect(frameValue.host.state).toMatchObject({ leaseId: frameLease.leaseId, controlling: false });
    expect(frameValue.input.stop).toHaveBeenCalled();
    expect(frameValue.media.setSessionState).toHaveBeenNthCalledWith(1, false);

    await expect(frameValue.host.setControl({
      ...REQUEST,
      leaseId: frameLease.leaseId,
      enabled: true
    })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.VIEW_ONLY });
    expect(frameValue.host.isControlCurrent({
      ...REQUEST,
      leaseId: frameLease.leaseId,
      controlGeneration: control.controlGeneration
    })).toBe(false);
  });

  it("does not revive control when the session locks during native input startup", async () => {
    const value = fixture({ enabled: true, platform: "darwin" });
    hosts.push(value.host);
    const lease = await value.host.start({
      ...REQUEST,
      displayId: "display-1",
      mode: RemoteDesktopStartMode.NEW
    });
    let finishInput!: () => void;
    vi.mocked(value.input.start).mockImplementationOnce(() => new Promise((resolve) => {
      finishInput = resolve;
    }));
    const pending = value.host.setControl({
      ...REQUEST,
      leaseId: lease.leaseId,
      enabled: true
    });
    await vi.waitFor(() => expect(value.input.start).toHaveBeenCalledOnce());

    value.setSessionState("locked-logged-in");
    await vi.waitFor(() => expect(value.media.setSessionState).toHaveBeenLastCalledWith(true));
    finishInput();

    await expect(pending).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.VIEW_ONLY });
    expect(value.host.state).toMatchObject({ leaseId: lease.leaseId, controlling: false });
    await expect(value.host.heartbeat({
      ...REQUEST,
      leaseId: lease.leaseId
    })).resolves.toMatchObject({ controlling: false });
    expect(value.input.stop).toHaveBeenCalled();
  });

  it("retires an in-flight offer generation without ending a locked logged-in viewer lease", async () => {
    const offerValue = fixture({ enabled: true, platform: "darwin" });
    hosts.push(offerValue.host);
    const offerLease = await offerValue.host.start({
      ...REQUEST,
      displayId: "display-1",
      mode: RemoteDesktopStartMode.NEW
    });
    let resolveOffer!: (answer: string) => void;
    vi.mocked(offerValue.media.offer).mockImplementationOnce(() => new Promise((resolve) => {
      resolveOffer = resolve;
    }));
    const pending = offerValue.host.createOffer({
      ...REQUEST,
      leaseId: offerLease.leaseId,
      attemptId: "attempt-before-lock",
      offerSdp: "offer",
      cursorOverlay: false
    });
    await vi.waitFor(() => expect(offerValue.media.offer).toHaveBeenCalledOnce());
    offerValue.setSessionState("locked-logged-in");
    await vi.waitFor(() => expect(offerValue.media.setSessionState).toHaveBeenLastCalledWith(true));
    resolveOffer("stale-answer");
    await expect(pending).rejects.toMatchObject({
      reason: RemoteDesktopFailureReason.VIDEO_BUSY,
      retryable: true
    });
    expect(offerValue.media.setSessionState).toHaveBeenNthCalledWith(1, false);
    await expect(offerValue.host.heartbeat({
      ...REQUEST,
      leaseId: offerLease.leaseId
    })).resolves.toMatchObject({ controlling: false });
  });

  it("fences the complete enabled capability snapshot across an async permission read", async () => {
    const permissionValue = fixture({ enabled: true, platform: "darwin" });
    hosts.push(permissionValue.host);
    let resolvePermissions!: () => void;
    vi.mocked(permissionValue.permissions).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { resolvePermissions = resolve; });
      return Object.freeze({ screenRecording: "granted", accessibility: "granted" });
    });
    const pending = permissionValue.host.getCapabilities(REQUEST);
    await vi.waitFor(() => expect(permissionValue.permissions).toHaveBeenCalledOnce());
    permissionValue.setSessionProbe(false);
    resolvePermissions();
    await expect(pending).rejects.toMatchObject({
      reason: RemoteDesktopFailureReason.LOCKED_SESSION_UNSUPPORTED
    });
  });
});

function fixture(options: {
  readonly enabled: boolean;
  readonly platform: DesktopRemoteDesktopHostDependencies["platform"];
  readonly sessionUnlocked?: boolean;
  readonly sessionState?: DesktopRemoteDesktopSessionState;
}) {
  const media: DesktopRemoteDesktopMediaPort = {
    frame: vi.fn(async () => null),
    offer: vi.fn(async () => "answer"),
    exchangeIce: vi.fn(async (request) => ({
      attemptId: request.attemptId,
      candidates: [],
      next: request.after,
      complete: true
    })),
    setInputHandler: vi.fn(() => vi.fn()),
    setPresentationPongHandler: vi.fn((handler) => {
      presentationPong = handler;
      return () => { if (presentationPong === handler) presentationPong = undefined; };
    }),
    setPresentation: vi.fn(),
    setSessionState: vi.fn(),
    stop: vi.fn(),
    retire: vi.fn(async () => undefined)
  };
  const input: DesktopRemoteDesktopInputPort = {
    start: vi.fn(async () => undefined),
    send: vi.fn(),
    stop: vi.fn(),
    retire: vi.fn(async () => undefined)
  };
  const clipboard: DesktopRemoteDesktopClipboardPort = {
    copyText: vi.fn(async (current) => {
      if (!current()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
      return "selected text";
    }),
    pasteText: vi.fn(async (_text, current) => {
      if (!current()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
    }),
    copyContent: vi.fn(async (current) => {
      if (!current()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
      return { text: "selected text" };
    }),
    pasteContent: vi.fn(async (_content, current) => {
      if (!current()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
    })
  };
  let lease = 0;
  let presentationPong: ((leaseId: string) => void) | undefined;
  let sessionState: DesktopRemoteDesktopSessionState = options.sessionState
    ?? (options.sessionUnlocked === false ? "unsupported" : "unlocked");
  let sessionListener: (() => void) | undefined;
  const permissions = vi.fn(async () => Object.freeze({
    screenRecording: options.platform === "darwin" ? "granted" : "notRequired",
    accessibility: options.platform === "darwin" ? "granted" : "notRequired"
  } as const));
  const displays = vi.fn(() => [
    { id: "display-1", name: "Display 1", width: 1_280, height: 800 }
  ]);
  const displayModes = vi.fn(async () => [
    { id: "42", width: 1_280, height: 800, current: true, native: true }
  ] as const);
  const setDisplayMode = vi.fn(async (
    _displayId: string,
    _modeId: string,
    beforeChange: () => void
  ) => { beforeChange(); });
  const host = new DesktopRemoteDesktopHost({
    platform: options.platform,
    systemAudio: options.platform === "win32",
    enabled: () => options.enabled,
    sessionState: vi.fn(async () => sessionState),
    displays,
    permissions,
    showPermissionGuide: vi.fn(async () => undefined),
    media,
    input,
    ...(options.platform === "linux" ? {} : { clipboard }),
    ...(options.platform === "darwin" ? { displayModes, setDisplayMode } : {}),
    changed: vi.fn(),
    onSessionStateChange: (listener) => {
      sessionListener = listener;
      return () => { if (sessionListener === listener) sessionListener = undefined; };
    },
    createLeaseId: () => `lease-${++lease}`
  });
  return {
    host,
    media,
    input,
    clipboard,
    permissions,
    displays,
    displayModes,
    setDisplayMode,
    presentationPong(leaseId: string): void {
      presentationPong?.(leaseId);
    },
    setSessionUnlocked(unlocked: boolean): void {
      sessionState = unlocked ? "unlocked" : "unsupported";
      sessionListener?.();
    },
    setSessionProbe(unlocked: boolean): void {
      sessionState = unlocked ? "unlocked" : "unsupported";
    },
    setSessionState(state: DesktopRemoteDesktopSessionState): void {
      sessionState = state;
      sessionListener?.();
    }
  };
}

function cursorPng(): Buffer {
  const png = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  return png;
}
