import { RemoteDesktopFailureReason, RemoteDesktopStartMode } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DesktopRemoteDesktopHost,
  type DesktopRemoteDesktopHostDependencies,
  type DesktopRemoteDesktopInputPort,
  type DesktopRemoteDesktopMediaPort
} from "../src/remote-desktop-host.js";

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
    await expect(linux.host.setControl({
      ...REQUEST,
      leaseId: lease.leaseId,
      enabled: true
    })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.VIEW_ONLY });
    expect(linux.input.start).not.toHaveBeenCalled();
    expect(linux.host.state?.controlling).toBe(false);
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
      offerSdp: "offer"
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
    await value.host.getFrame({ ...REQUEST, leaseId: lease.leaseId });
    await value.host.createOffer({
      ...REQUEST,
      leaseId: lease.leaseId,
      attemptId: "attempt-after-unlock",
      offerSdp: "offer"
    });
    expect(value.media.frame).toHaveBeenCalledOnce();
    expect(value.media.offer).toHaveBeenCalledOnce();
  });

  it("rechecks lock state before frames and after pending offers", async () => {
    const frameValue = fixture({ enabled: true, platform: "win32" });
    hosts.push(frameValue.host);
    const frameLease = await frameValue.host.start({
      ...REQUEST,
      displayId: "display-1",
      mode: RemoteDesktopStartMode.NEW
    });
    frameValue.setSessionProbe(false);
    await expect(frameValue.host.getFrame({
      ...REQUEST,
      leaseId: frameLease.leaseId
    })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.LEASE_EXPIRED });
    expect(frameValue.media.frame).not.toHaveBeenCalled();

    const offerValue = fixture({ enabled: true, platform: "win32" });
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
      offerSdp: "offer"
    });
    await vi.waitFor(() => expect(offerValue.media.offer).toHaveBeenCalledOnce());
    offerValue.setSessionProbe(false);
    resolveOffer("stale-answer");
    await expect(pending).rejects.toMatchObject({
      reason: RemoteDesktopFailureReason.LEASE_EXPIRED
    });
    expect(offerValue.media.stop).toHaveBeenCalled();
  });

  it("fences the complete enabled capability snapshot across async permission and display reads", async () => {
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

    const displayValue = fixture({ enabled: true, platform: "win32" });
    hosts.push(displayValue.host);
    vi.mocked(displayValue.displays).mockImplementationOnce(() => {
      displayValue.setSessionProbe(false);
      return [{ id: "display-1", name: "Display 1", width: 1_280, height: 800 }];
    });
    await expect(displayValue.host.getCapabilities(REQUEST)).rejects.toMatchObject({
      reason: RemoteDesktopFailureReason.LOCKED_SESSION_UNSUPPORTED
    });
    expect(displayValue.displays).toHaveBeenCalledOnce();
  });
});

function fixture(options: {
  readonly enabled: boolean;
  readonly platform: DesktopRemoteDesktopHostDependencies["platform"];
  readonly sessionUnlocked?: boolean;
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
    stop: vi.fn(),
    retire: vi.fn(async () => undefined)
  };
  const input: DesktopRemoteDesktopInputPort = {
    start: vi.fn(async () => undefined),
    send: vi.fn(),
    stop: vi.fn(),
    retire: vi.fn(async () => undefined)
  };
  let lease = 0;
  let sessionUnlocked = options.sessionUnlocked ?? true;
  let sessionListener: ((unlocked: boolean) => void) | undefined;
  const permissions = vi.fn(async () => Object.freeze({
    screenRecording: options.platform === "darwin" ? "granted" : "notRequired",
    accessibility: options.platform === "darwin" ? "granted" : "notRequired"
  } as const));
  const displays = vi.fn(() => [
    { id: "display-1", name: "Display 1", width: 1_280, height: 800 }
  ]);
  const host = new DesktopRemoteDesktopHost({
    platform: options.platform,
    enabled: () => options.enabled,
    sessionUnlocked: () => sessionUnlocked,
    displays,
    permissions,
    showPermissionGuide: vi.fn(async () => undefined),
    media,
    input,
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
    permissions,
    displays,
    setSessionUnlocked(unlocked: boolean): void {
      sessionUnlocked = unlocked;
      sessionListener?.(unlocked);
    },
    setSessionProbe(unlocked: boolean): void {
      sessionUnlocked = unlocked;
    }
  };
}
