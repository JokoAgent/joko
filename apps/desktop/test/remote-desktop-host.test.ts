import {
  RemoteDesktopClipboardContentSchema,
  RemoteDesktopFailureReason,
  RemoteDesktopIceServerSchema,
  RemoteDesktopLockState,
  RemoteDesktopStartMode,
  RemoteDesktopSystemActionKind,
  RemoteDesktopVideoQuality,
  RemoteDesktopVideoSettingsSchema
} from "@joko/contracts";
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: {} }));

import {
  DesktopRemoteDesktopHost,
  type DesktopRemoteDesktopClipboardPort,
  type DesktopRemoteDesktopHostDependencies,
  type DesktopRemoteDesktopInputPort,
  type DesktopRemoteDesktopMediaPort
} from "../src/remote-desktop-host.js";
import type { DesktopRemoteDesktopSessionState } from "../src/remote-desktop-input.js";
import { SystemAudioMuteGuard } from "../src/system-audio-mute.js";
import type { RemoteDesktopDisplayMode, RemoteDesktopSystemAction } from "@joko/device-peer";

const REQUEST = Object.freeze({
  controllerDeviceId: "controller-a",
  signal: new AbortController().signal
});

describe("Desktop Remote Desktop host", () => {
  const hosts: DesktopRemoteDesktopHost[] = [];

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.retire()));
  });
  it("system actions expose only the current Linux adapter and generated enum receipt", async () => {
    const value = fixture({ enabled: true, platform: "linux", workspace: true,
      linuxCapabilities: { canControl: true, cursorOverlay: false, workspaceNavigation: true, systemMenu: true } });
    hosts.push(value.host);
    expect(await value.host.getCapabilities(REQUEST)).toMatchObject({ workspaceNavigation: true, systemMenu: true });
    const request = await controlledRequest(value);
    const cancellation = new AbortController();
    expect(await value.host.performSystemAction({ ...request, signal: cancellation.signal,
      action: RemoteDesktopSystemActionKind.WORKSPACE_LEFT })).toMatchObject({ action: RemoteDesktopSystemActionKind.WORKSPACE_LEFT });
    expect(value.workspaceAction).toHaveBeenCalledExactlyOnceWith("workspaceLeft", "display-1",
      expect.any(Function), cancellation.signal);
    expect(value.workspaceAction.mock.calls[0]![2]()).toBe(true);
    await expect(value.host.performSystemAction({ ...request, controlGeneration: request.controlGeneration + 1n,
      action: RemoteDesktopSystemActionKind.WORKSPACE_RIGHT })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.SYSTEM_ACTION_EXPIRED });
    expect(value.workspaceAction).toHaveBeenCalledOnce();
    await expect(value.host.performSystemAction({ ...request,
      action: RemoteDesktopSystemActionKind.UNSPECIFIED })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.SYSTEM_ACTION_UNAVAILABLE });
    expect(value.workspaceAction).toHaveBeenCalledOnce();
  });

  it.each(["darwin", "win32", "locked", "absent"] as const)("system actions remain unavailable for %s", async condition => {
    const value = fixture({ enabled: true, platform: condition === "darwin" || condition === "win32" ? condition : "linux",
      workspace: condition !== "absent", sessionState: condition === "locked" ? "locked-logged-in" : "unlocked",
      linuxCapabilities: { canControl: true, cursorOverlay: false, workspaceNavigation: true, systemMenu: true } });
    hosts.push(value.host);
    expect(await value.host.getCapabilities(REQUEST)).toMatchObject({ workspaceNavigation: false, systemMenu: false });
    expect(value.workspaceAction).not.toHaveBeenCalled();
  });

  it("system action failure keeps the viewer/control and permits an explicit current retry", async () => {
    const value = fixture({ enabled: true, platform: "linux", workspace: true,
      linuxCapabilities: { canControl: true, cursorOverlay: false, workspaceNavigation: true, systemMenu: false } });
    hosts.push(value.host); const request = await controlledRequest(value);
    value.workspaceAction.mockRejectedValueOnce(new Error("REMOTE_DESKTOP_SYSTEM_ACTION_UNAVAILABLE"));
    await expect(value.host.performSystemAction({ ...request,
      action: RemoteDesktopSystemActionKind.WORKSPACE_RIGHT })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.SYSTEM_ACTION_UNAVAILABLE });
    expect(value.host.state).toMatchObject({ leaseId: request.leaseId, controlling: true });
    expect(value.media.stop).not.toHaveBeenCalled();
    await expect(value.host.performSystemAction({ ...request,
      action: RemoteDesktopSystemActionKind.WORKSPACE_RIGHT })).resolves.toMatchObject({ action: RemoteDesktopSystemActionKind.WORKSPACE_RIGHT });
    expect(value.workspaceAction).toHaveBeenCalledTimes(2);
    await expect(value.host.performSystemAction({ ...request,
      action: RemoteDesktopSystemActionKind.SYSTEM_MENU })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.SYSTEM_ACTION_UNAVAILABLE });
    expect(value.workspaceAction).toHaveBeenCalledTimes(2);
  });

  it("system actions reject a late locked-session receipt and revoke the native current callback", async () => {
    const value = fixture({ enabled: true, platform: "linux", workspace: true,
      linuxCapabilities: { canControl: true, cursorOverlay: false, workspaceNavigation: true, systemMenu: true } });
    hosts.push(value.host); const request = await controlledRequest(value);
    let complete!: () => void;
    value.workspaceAction.mockImplementationOnce(async () => new Promise<void>(resolve => { complete = resolve; }));
    const action = value.host.performSystemAction({ ...request, action: RemoteDesktopSystemActionKind.WORKSPACE_LEFT });
    const outcome = expect(action).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.SYSTEM_ACTION_EXPIRED });
    await vi.waitFor(() => expect(value.workspaceAction).toHaveBeenCalledOnce());
    const nativeCurrent = value.workspaceAction.mock.calls[0]![2];
    value.setSessionState("locked-logged-in");
    await vi.waitFor(() => expect(nativeCurrent()).toBe(false));
    complete(); await outcome;
    expect(value.host.state?.controlling).toBe(false);
    await vi.waitFor(() => expect(value.stopWorkspaceActions).toHaveBeenCalled());
  });
  it("mirror Host uses a lease-owned native lifetime and generates Fit/Restore receipts with physical source retention", async () => {
    const handle = { displayId: "mirror", resize: vi.fn(async (width: number, height: number) => ({ id: "mirror", name: "Mirror", width, height })),
      restore: vi.fn(async () => ({ id: "display-1", name: "Display 1", width: 1280, height: 800 })), dispose: vi.fn() };
    let ownerCurrent!: () => boolean, ownerSignal!: AbortSignal;
    const factory = vi.fn(async (source: string, current: () => boolean, _failure: () => void, signal: AbortSignal) => {
      expect(source).toBe("display-1"); ownerCurrent = current; ownerSignal = signal; return handle;
    });
    const value = fixture({ enabled: true, platform: "linux", linuxCapabilities: { canControl: true, cursorOverlay: true, viewerDisplay: true },
      createViewerDisplay: factory }); hosts.push(value.host); const request = await controlledRequest(value);
    expect(await value.host.getCapabilities(REQUEST)).toMatchObject({ viewerDisplay: true, viewerDisplayRestore: true });
    const command = new AbortController();
    const fitted = await value.host.setViewerDisplay({ ...request, signal: command.signal, width: 1920, height: 1440 });
    expect(fitted.lease).toMatchObject({ leaseId: request.leaseId, controlling: false, display: { displayId: "mirror", width: 1920, height: 1440 } });
    expect(fitted.lease!.controlGeneration).toBeGreaterThan(request.controlGeneration);
    command.abort(); expect(ownerSignal.aborted).toBe(false); expect(ownerCurrent()).toBe(true);
    expect(value.host.managedViewerDisplay).toEqual({ sourceDisplayId: "display-1", displayId: "mirror" });
    const control = await value.host.setControl({ ...request, enabled: true });
    const restored = await value.host.restoreViewerDisplay({ ...request, controlGeneration: control.controlGeneration });
    expect(restored.lease).toMatchObject({ leaseId: request.leaseId, controlling: false, display: { displayId: "display-1" } });
    expect(value.host.managedViewerDisplay).toBeUndefined(); expect(factory).toHaveBeenCalledOnce(); expect(handle.restore).toHaveBeenCalledOnce();
  });

  it.each(["unsupported", "missing-factory", "windows"] as const)("Mac viewer display capability requires the current producer for %s", async condition => {
    const probe = vi.fn(async () => condition !== "unsupported");
    const factory = vi.fn();
    const value = fixture({ enabled: true, platform: condition === "windows" ? "win32" : "darwin",
      viewerDisplaySupported: probe, ...(condition === "missing-factory" ? {} : { createViewerDisplay: factory }) });
    hosts.push(value.host);
    expect(await value.host.getCapabilities(REQUEST)).toMatchObject({ viewerDisplay: false, viewerDisplayRestore: false });
    expect(factory).not.toHaveBeenCalled();
    if (condition === "unsupported") expect(probe).toHaveBeenCalledOnce();
    else expect(probe).not.toHaveBeenCalled();
  });

  it("Mac viewer display adopts adjusted actual geometry and retires the mirror when its physical source is removed", async () => {
    const handle = { displayId: "mirror", resize: vi.fn(async () => ({ id: "mirror", name: "Mirror", width: 2000, height: 1500 })),
      restore: vi.fn(async () => ({ id: "display-1", name: "Display 1", width: 1280, height: 800 })), dispose: vi.fn() };
    const probe = vi.fn(async () => true), factory = vi.fn(async () => handle);
    const value = fixture({ enabled: true, platform: "darwin", viewerDisplaySupported: probe, createViewerDisplay: factory });
    hosts.push(value.host); const request = await controlledRequest(value);
    expect(await value.host.getCapabilities(REQUEST)).toMatchObject({ viewerDisplay: true, viewerDisplayRestore: true });
    const fitted = await value.host.setViewerDisplay({ ...request, width: 1920, height: 1440 });
    expect(fitted.lease).toMatchObject({ leaseId: request.leaseId, controlling: false,
      display: { displayId: "mirror", width: 2000, height: 1500 } });
    expect(fitted.lease!.controlGeneration).toBeGreaterThan(request.controlGeneration);
    value.displayChangeFor("mirror", { width: 2000, height: 1500, metrics: ["bounds"] });
    expect(value.host.state?.leaseId).toBe(request.leaseId);
    value.displayChangeFor("display-1", { width: 1280, height: 800, metrics: ["removed"] });
    expect(value.host.state).toBeUndefined();
    await vi.waitFor(() => expect(handle.restore).toHaveBeenCalledOnce());
    expect(factory).toHaveBeenCalledOnce();
    expect(value.media.stop).toHaveBeenCalled();
  });

  it("Mac viewer display probe cannot publish capabilities after its host retires", async () => {
    let complete!: (value: boolean) => void;
    const probe = vi.fn(() => new Promise<boolean>(resolve => { complete = resolve; }));
    const value = fixture({ enabled: true, platform: "darwin", viewerDisplaySupported: probe, createViewerDisplay: vi.fn() });
    hosts.push(value.host);
    const pending = value.host.getCapabilities(REQUEST), outcome = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    await value.host.retire(); complete(true); await outcome;
    expect(value.host.state).toBeUndefined();
  });

  it("Windows locked viewing and control use only the currently authorized native worker", async () => {
    let ready = true;
    const value = fixture({ enabled: true, platform: "win32", sessionState: "locked-logged-in",
      windowsCapabilities: async () => ({ canControl: ready, cursorOverlay: ready }) }); hosts.push(value.host);
    expect(await value.host.getCapabilities(REQUEST)).toMatchObject({ canControl: true, cursorOverlay: true,
      clipboardContent: false, nativeCredentials: false, lockOnExit: false, displayModes: false });
    const request = await controlledRequest(value);
    expect(value.input.start).toHaveBeenCalledOnce(); expect(value.host.state?.controlling).toBe(true);
    ready = false;
    expect(await value.host.getCapabilities(REQUEST)).toMatchObject({ canControl: false, cursorOverlay: false });
    value.host.releaseControl();
    await expect(value.host.setControl({ ...request, enabled: true })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.VIEW_ONLY });
    value.setSessionState("unsupported");
    await vi.waitFor(() => expect(value.host.state).toBeUndefined());
  });

  it("local service setup waits for actual input and media retirement", async () => {
    const value = fixture({ enabled: true, platform: "win32" }); hosts.push(value.host);
    await controlledRequest(value); let closed!: () => void;
    vi.mocked(value.input.release).mockImplementationOnce(() => new Promise(resolve => { closed = resolve; }));
    let completed = false; const stopping = value.host.disconnectAndRelease().then(() => { completed = true; });
    expect(value.host.state).toBeUndefined(); await Promise.resolve(); expect(completed).toBe(false);
    closed(); await stopping; expect(completed).toBe(true);
  });

  it("credentials public lock state follows actual owned OS session without a media or native authentication lease", async () => {
    const value = fixture({ enabled: true, platform: "darwin", sessionState: "locked-logged-in" }); hosts.push(value.host);
    expect((await value.host.getLockState(REQUEST)).state).toBe(RemoteDesktopLockState.LOCKED);
    expect(value.host.state).toBeUndefined(); expect(value.input.start).not.toHaveBeenCalled();
    expect((await value.host.getCapabilities(REQUEST)).nativeCredentials).toBe(false);
    const windows = fixture({ enabled: true, platform: "win32" }); hosts.push(windows.host);
    expect((await windows.host.getLockState(REQUEST)).state).toBe(RemoteDesktopLockState.UNAVAILABLE);
  });

  it.each(["win32", "darwin", "linux"] as const)("privacy %s capability follows its actual adapter and preserves viewing after typed failure", async (platform) => {
    const value = fixture({ enabled: true, platform, privacyScreen: true,
      linuxCapabilities: { canControl: true, cursorOverlay: false, privacyScreen: true } }); hosts.push(value.host);
    const request = await controlledRequest(value); expect((await value.host.getCapabilities(REQUEST)).privacyScreen).toBe(true);
    vi.mocked(value.privacyScreen.set).mockRejectedValueOnce(new Error("REMOTE_DESKTOP_PRIVACY_FAILED"));
    await expect(value.host.setPrivacyScreen({ ...request, enabled: true, lockOnExit: false })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.PRIVACY_FAILED });
    expect(value.host.state?.leaseId).toBe(request.leaseId); expect(value.media.stop).not.toHaveBeenCalled();
    await expect(value.host.setPrivacyScreen({ ...request, enabled: true, lockOnExit: false })).resolves.toMatchObject({ enabled: true });
    await value.host.setPrivacyScreen({ ...request, enabled: false, lockOnExit: false });
    expect(value.privacyScreen.release).toHaveBeenCalledTimes(2);
  });

  it.each(["restored", "locked", "retired"] as const)("privacy off input restoration uses fresh exact session authority: %s", async result => {
    const value = fixture({ enabled: true, platform: "linux", privacyScreen: true,
      linuxCapabilities: { canControl: true, cursorOverlay: false, privacyScreen: true } }); hosts.push(value.host);
    const request = await controlledRequest(value);
    await value.host.setPrivacyScreen({ ...request, enabled: true, lockOnExit: false });
    let complete!: () => void, current!: () => boolean;
    vi.mocked(value.input.resumeAfterPrivacy!).mockImplementationOnce(async (_displayId, valid) => {
      current = valid; expect(current()).toBe(true);
      await new Promise<void>(resolve => { complete = resolve; });
    });
    const pending = value.host.setPrivacyScreen({ ...request, enabled: false, lockOnExit: false });
    const receipt = result === "restored" ? expect(pending).resolves.toMatchObject({ enabled: false })
      : expect(pending).rejects.toBeInstanceOf(Error);
    await vi.waitFor(() => expect(value.input.resumeAfterPrivacy).toHaveBeenCalledOnce());
    expect(value.privacyScreen.release).toHaveBeenCalledOnce();
    if (result === "locked") {
      value.setSessionState("locked-logged-in");
      await vi.waitFor(() => expect(current()).toBe(false));
    } else if (result === "retired") value.host.disconnect();
    expect(current()).toBe(result === "restored"); complete(); await receipt;
    if (result === "restored") expect(value.host.state).toMatchObject({ leaseId: request.leaseId, controlling: true });
  });

  it("privacy unavailable adapter never advertises or dispatches native effects", async () => {
    const value = fixture({ enabled: true, platform: "win32", privacyScreen: false }); hosts.push(value.host);
    const request = await controlledRequest(value); expect((await value.host.getCapabilities(REQUEST)).privacyScreen).toBe(false);
    await expect(value.host.setPrivacyScreen({ ...request, enabled: true, lockOnExit: false })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.PRIVACY_UNAVAILABLE });
    expect(value.privacyScreen.set).not.toHaveBeenCalled();
  });

  it("privacy late initialization cannot acknowledge after physical display coverage changed", async () => {
    const value = fixture({ enabled: true, platform: "darwin" }); hosts.push(value.host); const request = await controlledRequest(value);
    let ready!: () => void; value.privacyScreen.set.mockImplementationOnce(async () => new Promise<void>((resolve) => { ready = resolve; }));
    const applying = expect(value.host.setPrivacyScreen({ ...request, enabled: true, lockOnExit: true })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.PRIVACY_EXPIRED });
    await vi.waitFor(() => expect(value.privacyScreen.set).toHaveBeenCalledOnce());
    value.host.displayCoverageChanged(); expect(value.privacyScreen.release).not.toHaveBeenCalled(); ready(); await applying;
    expect(value.privacyScreen.release).toHaveBeenCalledOnce(); expect(value.host.state).toBeUndefined(); expect(value.lockScreen).not.toHaveBeenCalled();
  });

  it.each(["darwin", "linux"] as const)("privacy %s local terminal uses captured owner through expected OS lock event and restores afterwards", async platform => {
    const value = fixture({ enabled: true, platform, privacyScreen: true,
      linuxCapabilities: { canControl: true, cursorOverlay: false, privacyScreen: true, lockOnExit: true } }); hosts.push(value.host); const request = await controlledRequest(value);
    await value.host.setPrivacyScreen({ ...request, enabled: true, lockOnExit: true });
    const owner = value.privacyScreen.set.mock.calls[0]![0];
    value.lockScreen.mockImplementationOnce(async (current) => {
      expect(value.privacyScreen.release).not.toHaveBeenCalled(); expect(current()).toBe(true);
      value.setSessionState("locked-logged-in");
    });
    await value.host.stopPrivacyByUser(owner);
    expect(value.privacyScreen.release).toHaveBeenCalledExactlyOnceWith(owner); expect(value.host.state).toBeUndefined();
    expect(value.lockScreen).toHaveBeenCalledOnce();
  });

  it("privacy Linux capability requires its actual plugin and ordinary unlocked ownership", async () => {
    const value = fixture({ enabled: true, platform: "linux", privacyScreen: true,
      linuxCapabilities: { canControl: true, cursorOverlay: false, privacyScreen: false } }); hosts.push(value.host);
    expect((await value.host.getCapabilities(REQUEST)).privacyScreen).toBe(false);
    const locked = fixture({ enabled: true, platform: "linux", privacyScreen: true, sessionState: "locked-logged-in",
      linuxCapabilities: { canControl: true, cursorOverlay: false, privacyScreen: true } }); hosts.push(locked.host);
    expect((await locked.host.getCapabilities(REQUEST)).privacyScreen).toBe(false);
  });

  it.each(["locked", "retired"] as const)("privacy preparation rejects a late %s owned-session receipt before creating the lease", async condition => {
    let complete!: () => void;
    const prepare = vi.fn<NonNullable<DesktopRemoteDesktopHostDependencies["prepare"]>>(async (current) => {
      expect(current()).toBe(true); await new Promise<void>(resolve => { complete = resolve; });
    });
    const value = fixture({ enabled: true, platform: "linux", prepare,
      linuxCapabilities: { canControl: true, cursorOverlay: false } }); hosts.push(value.host);
    const pending = expect(value.host.start({ ...REQUEST, displayId: "display-1", mode: RemoteDesktopStartMode.NEW })).rejects.toMatchObject({
      reason: RemoteDesktopFailureReason.PRIVACY_EXPIRED });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    if (condition === "locked") value.setSessionState("locked-logged-in");
    else value.host.disconnect();
    complete(); await pending; expect(value.host.state).toBeUndefined();
  });

  it("owns system-only synchronization under exact control and sync generation", async () => {
    const value = fixture({ enabled: true, platform: "win32" }); hosts.push(value.host);
    const request = await controlledRequest(value);
    const capabilities = await value.host.getCapabilities(REQUEST);
    expect(capabilities.clipboardSync).toBe(true); expect(capabilities.clipboardInline).toBe(true);
    const first = await value.host.setClipboardSync({ ...request, enabled: true });
    const sync = { ...request, sync: true, syncGeneration: first.syncGeneration, version: "1" };
    await expect(value.host.getClipboardVersion(sync)).resolves.toMatchObject({ version: "1" });
    await expect(value.host.copyClipboardContent(sync)).resolves.toMatchObject({ text: "system text" });
    await expect(value.host.pasteClipboardContent({ ...sync, content: create(RemoteDesktopClipboardContentSchema, { text: "new" }) })).resolves.toBe("2");
    expect(value.clipboard.copyContent).not.toHaveBeenCalled(); expect(value.clipboard.pasteContent).not.toHaveBeenCalled();
    await value.host.setClipboardSync({ ...request, enabled: false });
    const next = await value.host.setClipboardSync({ ...request, enabled: true });
    expect(next.syncGeneration).toBeGreaterThan(first.syncGeneration);
    await expect(value.host.copyClipboardContent(sync)).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.CLIPBOARD_EXPIRED });
    expect(value.host.state?.leaseId).toBe(request.leaseId);
    expect(value.clipboardCounter.stop).toHaveBeenCalled();
  });

  it("preserves video on typed version conflicts and fences a late counter after off", async () => {
    const value = fixture({ enabled: true, platform: "darwin" }); hosts.push(value.host);
    const request = await controlledRequest(value);
    const first = await value.host.setClipboardSync({ ...request, enabled: true });
    const sync = { ...request, sync: true, syncGeneration: first.syncGeneration, version: "1" };
    vi.mocked(value.clipboard.writeSystemContent).mockRejectedValueOnce(new Error("REMOTE_DESKTOP_CLIPBOARD_CHANGED"));
    await expect(value.host.pasteClipboardContent({ ...sync, content: create(RemoteDesktopClipboardContentSchema, { text: "new" }) }))
      .rejects.toMatchObject({ reason: RemoteDesktopFailureReason.CLIPBOARD_CHANGED });
    let complete!: (version: string) => void;
    value.clipboardCounter.read.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const pending = value.host.getClipboardVersion(sync);
    const rejected = expect(pending).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.CLIPBOARD_EXPIRED });
    await vi.waitFor(() => expect(value.clipboardCounter.read).toHaveBeenCalledOnce());
    await value.host.setClipboardSync({ ...request, enabled: false });
    complete("2"); await rejected;
    expect(value.host.state?.controlling).toBe(true);
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
      backgroundViewing: true,
      hostMute: false
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

  it("Linux clipboard advertises the admitted async port and separates explicit effects from system sync", async () => {
    const value = fixture({ enabled: true, platform: "linux", linuxClipboard: true,
      linuxCapabilities: { canControl: true, cursorOverlay: false } }); hosts.push(value.host);
    expect(await value.host.getCapabilities(REQUEST)).toMatchObject({ clipboardText: true,
      clipboardContent: true, clipboardSync: true, clipboardInline: true, hostMute: false, lockOnExit: false });
    const lease = await value.host.start({ ...REQUEST, displayId: "display-1", mode: RemoteDesktopStartMode.NEW });
    const control = await value.host.setControl({ ...REQUEST, leaseId: lease.leaseId, enabled: true });
    const request = { ...REQUEST, leaseId: lease.leaseId, controlGeneration: control.controlGeneration };
    await expect(value.host.copyClipboardText(request)).resolves.toBe("selected text");
    await value.host.pasteClipboardText({ ...request, text: "paste" });
    const sync = await value.host.setClipboardSync({ ...request, enabled: true });
    vi.mocked(value.clipboardCounter.read).mockResolvedValueOnce("a".repeat(64));
    const syncRequest = { ...request, sync: true, syncGeneration: sync.syncGeneration, version: "a".repeat(64) };
    await expect(value.host.getClipboardVersion(syncRequest)).resolves.toMatchObject({ version: "a".repeat(64) });
    await expect(value.host.copyClipboardContent(syncRequest)).resolves.toMatchObject({ text: "system text" });
    vi.mocked(value.clipboard.writeSystemContent).mockResolvedValueOnce("b".repeat(64));
    await expect(value.host.pasteClipboardContent({ ...syncRequest, content: create(RemoteDesktopClipboardContentSchema, { text: "sync" }) })).resolves.toBe("b".repeat(64));
    expect(value.clipboard.copyText).toHaveBeenCalledOnce(); expect(value.clipboard.pasteText).toHaveBeenCalledOnce();
    expect(value.clipboard.copyContent).not.toHaveBeenCalled(); expect(value.clipboard.pasteContent).not.toHaveBeenCalled();
    await value.host.setClipboardSync({ ...request, enabled: false });
    await expect(value.host.copyClipboardContent(syncRequest)).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.CLIPBOARD_EXPIRED });
    expect(value.clipboard.readSystemContent).toHaveBeenCalledOnce();
  });

  it("Linux fresh clipboard completion proof rejects native lock without retiring the view lease", async () => {
    const value = fixture({ enabled: true, platform: "linux", linuxClipboard: true,
      linuxCapabilities: { canControl: true, cursorOverlay: false } }); hosts.push(value.host);
    const lease = await value.host.start({ ...REQUEST, displayId: "display-1", mode: RemoteDesktopStartMode.NEW });
    const control = await value.host.setControl({ ...REQUEST, leaseId: lease.leaseId, enabled: true });
    let complete!: (text: string) => void;
    vi.mocked(value.clipboard.copyText).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = value.host.copyClipboardText({ ...REQUEST, leaseId: lease.leaseId, controlGeneration: control.controlGeneration });
    const rejected = expect(pending).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.CLIPBOARD_EXPIRED });
    await vi.waitFor(() => expect(value.clipboard.copyText).toHaveBeenCalledOnce());
    value.sessionProbe.mockResolvedValue("locked-logged-in"); complete("late clipboard value"); await rejected;
    expect(value.host.state?.leaseId).toBe(lease.leaseId); expect(value.host.state?.controlling).toBe(false);
    expect(value.input.stop).toHaveBeenCalled(); expect(value.clipboardCounter.stop).toHaveBeenCalled();
  });

  it("Linux unknown clipboard writer outcomes stay typed nonretryable and preserve the lease", async () => {
    const value = fixture({ enabled: true, platform: "linux", linuxClipboard: true,
      linuxCapabilities: { canControl: true, cursorOverlay: false } }); hosts.push(value.host);
    const lease = await value.host.start({ ...REQUEST, displayId: "display-1", mode: RemoteDesktopStartMode.NEW });
    const control = await value.host.setControl({ ...REQUEST, leaseId: lease.leaseId, enabled: true });
    vi.mocked(value.clipboard.pasteText).mockRejectedValueOnce(Object.assign(
      new Error("REMOTE_DESKTOP_CLIPBOARD_OUTCOME_UNKNOWN"), { outcomeUnknown: true }));
    await expect(value.host.pasteClipboardText({ ...REQUEST, leaseId: lease.leaseId,
      controlGeneration: control.controlGeneration, text: "once" })).rejects.toMatchObject({
      reason: RemoteDesktopFailureReason.CLIPBOARD_UNAVAILABLE, retryable: false, outcomeUnknown: true });
    expect(value.clipboard.pasteText).toHaveBeenCalledOnce(); expect(value.host.state?.leaseId).toBe(lease.leaseId);
  });
  it("Linux system audio retains exact view authority across its native session reset", async () => {
    const value = fixture({ enabled: true, platform: "linux", linuxAudio: true,
      linuxCapabilities: { canControl: true, cursorOverlay: false } }); hosts.push(value.host);
    const lease = await value.host.start({ ...REQUEST, displayId: "display-1", mode: RemoteDesktopStartMode.NEW });
    await value.host.createOffer({ ...REQUEST, leaseId: lease.leaseId, attemptId: "attempt",
      offerSdp: "offer", cursorOverlay: false,
      settings: create(RemoteDesktopVideoSettingsSchema, { fps: 30, quality: RemoteDesktopVideoQuality.AUTO, audio: true }) });
    const current = vi.mocked(value.media.offer).mock.calls[0]![0].current;
    expect(current()).toBe(true); value.setSessionState("locked-logged-in");
    await vi.waitFor(() => expect(value.media.setSessionState).toHaveBeenCalledWith(true, "locked-logged-in"));
    expect(current()).toBe(true); expect(value.host.state?.leaseId).toBe(lease.leaseId);
    value.setSessionState("unlocked"); await vi.waitFor(() => expect(value.media.setSessionState).toHaveBeenCalledWith(false, "unlocked"));
    expect(current()).toBe(true); expect(value.media.offer).toHaveBeenCalledOnce();
    value.host.disconnect(); expect(current()).toBe(false);
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
    const iceExpiry = Math.floor(Date.now() / 1_000) * 1_000 + 300_000;
    const iceServers = [create(RemoteDesktopIceServerSchema, { urls: ["turn:relay.example.test:3478"],
      username: "ephemeral-user", credential: "ephemeral-secret", expiresAt: { seconds: BigInt(iceExpiry / 1_000) } })];
    await value.host.createOffer({
      ...REQUEST,
      leaseId: lease.leaseId,
      attemptId: "attempt-settings",
      offerSdp: "offer",
      cursorOverlay: false,
      iceServers,
      settings: create(RemoteDesktopVideoSettingsSchema, {
        fps: 60,
        quality: RemoteDesktopVideoQuality.SAVER,
        audio: true
      })
    });
    expect(value.media.offer).toHaveBeenLastCalledWith(expect.objectContaining({
      leaseId: lease.leaseId,
      attemptId: "attempt-settings",
      iceServers: [{ urls: ["turn:relay.example.test:3478"], username: "ephemeral-user", credential: "ephemeral-secret", expiresAt: iceExpiry }],
      settings: { fps: 60, quality: "saver", audio: true }
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
        quality: RemoteDesktopVideoQuality.AUTO,
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
    expect(value.media.frame).toHaveBeenCalledWith({ displayId: "display-1", leaseId: lease.leaseId,
      cursorOverlay: true, current: expect.any(Function), signal: REQUEST.signal });
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
      modeId: "99", temporary: false
    })).rejects.toMatchObject({
      reason: RemoteDesktopFailureReason.DISPLAY_MODE_MISSING,
      retryable: false
    });
    vi.mocked(value.setDisplayMode).mockRejectedValueOnce(new Error("REMOTE_DESKTOP_DISPLAY_BUSY"));
    await expect(value.host.setDisplayMode({
      ...REQUEST,
      leaseId: lease.leaseId,
      controlGeneration: control.controlGeneration,
      modeId: "42", temporary: false
    })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.DISPLAY_BUSY, retryable: true });
    expect(value.host.state?.leaseId).toBe(lease.leaseId);

    vi.mocked(value.setDisplayMode).mockImplementationOnce(async (_display, _mode, beforeChange) => {
      await beforeChange();
      throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
    });
    await expect(value.host.setDisplayMode({
      ...REQUEST,
      leaseId: lease.leaseId,
      controlGeneration: control.controlGeneration,
      modeId: "42", temporary: false
    })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.LEASE_EXPIRED });
    expect(value.host.state).toBeUndefined();
  });

  it.each(["darwin", "linux"] as const)("temporary mode updates the same lease and only matching managed geometry ignores late display events on %s", async platform => {
    const value = fixture({ enabled: true, platform, linuxCapabilities: { canControl: true, cursorOverlay: true, displayModes: true } }); hosts.push(value.host);
    vi.mocked(value.displayModes).mockResolvedValue([
      { id: "42", width: 1_280, height: 800, current: true, native: true },
      { id: "43", width: 1_024, height: 640, current: false, native: false }
    ]);
    expect((await value.host.getCapabilities(REQUEST)).resolutionRestore).toBe(true);
    const lease = await value.host.start({ ...REQUEST, displayId: "display-1", mode: RemoteDesktopStartMode.NEW });
    const control = await value.host.setControl({ ...REQUEST, leaseId: lease.leaseId, enabled: true });
    const result = await value.host.setDisplayMode({ ...REQUEST, leaseId: lease.leaseId,
      controlGeneration: control.controlGeneration, modeId: "43", temporary: true });
    expect(result.lease).toMatchObject({ leaseId: lease.leaseId, controlling: false,
      display: { displayId: "display-1", width: 1_024, height: 640 } });
    expect(result.lease!.controlGeneration).toBeGreaterThan(control.controlGeneration);
    expect(value.host.managesDisplayGeometry("display-1", 1_024, 640)).toBe(true);
    expect(value.host.managesDisplayGeometry("display-1", 1_280, 800)).toBe(false);
    value.displayChanged({ width: 1_024, height: 640, metrics: ["bounds", "scaleFactor"] });
    expect(value.host.state?.leaseId).toBe(lease.leaseId);
    value.displayChanged({ width: 1_024, height: 640, metrics: ["rotation"] });
    expect(value.host.state).toBeUndefined();
    await value.host.retire();
    expect(value.restoreDisplayMode).toHaveBeenCalledExactlyOnceWith("display-1", "42",
      expect.any(Function), expect.objectContaining({ width: 1_280, height: 800 }), expect.any(AbortSignal));
  });

  it.each(["darwin", "linux"] as const)("temporary restoration uses captured local authority when its old route aborts and the owned console is locked on %s", async platform => {
    const value = fixture({ enabled: true, platform, linuxCapabilities: { canControl: true, cursorOverlay: true, displayModes: true } }); hosts.push(value.host);
    const route = new AbortController(); const request = { ...REQUEST, signal: route.signal };
    const lease = await value.host.start({ ...request, displayId: "display-1", mode: RemoteDesktopStartMode.NEW });
    const control = await value.host.setControl({ ...request, leaseId: lease.leaseId, enabled: true });
    await value.host.setDisplayMode({ ...request, leaseId: lease.leaseId,
      controlGeneration: control.controlGeneration, modeId: "42", temporary: true });
    value.setSessionState("locked-logged-in"); route.abort();
    await value.host.retire();
    expect(value.restoreDisplayMode).toHaveBeenCalledOnce();
    expect(value.restoreDisplayMode.mock.calls[0]![4].aborted).toBe(false);
  });

  it("temporary restore rejection remains reachable for terminal retry and never reports retired early", async () => {
    const value = fixture({ enabled: true, platform: "darwin" }); hosts.push(value.host);
    const lease = await value.host.start({ ...REQUEST, displayId: "display-1", mode: RemoteDesktopStartMode.NEW });
    const control = await value.host.setControl({ ...REQUEST, leaseId: lease.leaseId, enabled: true });
    await value.host.setDisplayMode({ ...REQUEST, leaseId: lease.leaseId,
      controlGeneration: control.controlGeneration, modeId: "42", temporary: true });
    value.restoreDisplayMode.mockRejectedValueOnce(new Error("native restore rejected"));
    await expect(value.host.retire()).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE });
    expect(value.retired).not.toHaveBeenCalled();
    await value.host.retire();
    expect(value.restoreDisplayMode).toHaveBeenCalledTimes(2);
    expect(value.retired).toHaveBeenCalledOnce();
  });

  it("temporary terminal composition joins concurrent retirement until actual input release and media retirement settle", async () => {
    const value = fixture({ enabled: true, platform: "darwin" }); hosts.push(value.host);
    let released!: () => void;
    vi.mocked(value.input.release).mockImplementationOnce(() => new Promise((resolve) => { released = resolve; }));
    let mediaEnded!: () => void;
    vi.mocked(value.media.retire).mockImplementationOnce(() => new Promise((resolve) => { mediaEnded = resolve; }));
    const first = value.host.retire(); const second = value.host.retire();
    expect(second).toBe(first); expect(value.retired).not.toHaveBeenCalled();
    mediaEnded(); await Promise.resolve(); expect(value.retired).not.toHaveBeenCalled();
    released(); await first;
    expect(value.retired).toHaveBeenCalledOnce();
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

  it.each(["darwin", "win32"] as const)("applies %s host mute and opt-out through the shared voice guard", async (platform) => {
    const value = fixture({ enabled: true, platform });
    hosts.push(value.host);
    expect((await value.host.getCapabilities(REQUEST)).hostMute).toBe(true);
    const request = await controlledRequest(value);
    await expect(value.host.setHostMute({ ...request, enabled: true })).resolves.toMatchObject({ enabled: true });
    expect(value.output.muted).toBe(true);
    await value.audioGuard.acquire(9);
    await expect(value.host.setHostMute({ ...request, enabled: false })).resolves.toMatchObject({ enabled: false });
    expect(value.output.muted).toBe(true);
    await value.audioGuard.release(9);
    expect(value.output.muted).toBe(false);
    expect(value.host.state).toMatchObject({ leaseId: request.leaseId, controlling: true });
    expect(value.media.stop).not.toHaveBeenCalled();
  });

  it.each(["win32", "linux"] as const)("reports %s host mute unavailable when no supported native adapter exists", async (platform) => {
    const value = fixture({ enabled: true, platform, hostMute: false,
      linuxCapabilities: { canControl: true, cursorOverlay: false } });
    hosts.push(value.host);
    expect((await value.host.getCapabilities(REQUEST)).hostMute).toBe(false);
    const request = await controlledRequest(value);
    await expect(value.host.setHostMute({ ...request, enabled: true }))
      .rejects.toMatchObject({ reason: RemoteDesktopFailureReason.HOST_MUTE_UNAVAILABLE });
    expect(value.audioBackend.setMuted).not.toHaveBeenCalled();
    expect(value.host.state?.controlling).toBe(true);
  });

  it.each(["win32", "linux"] as const)("rejects stale %s host-mute controller and generation without mutating native output", async (platform) => {
    const value = fixture({ enabled: true, platform, hostMute: true,
      linuxCapabilities: { canControl: true, cursorOverlay: false } });
    hosts.push(value.host);
    const request = await controlledRequest(value);
    for (const stale of [
      { ...request, controllerDeviceId: "controller-b", enabled: true },
      { ...request, controlGeneration: request.controlGeneration - 1n, enabled: true },
      { ...request, controlGeneration: BigInt(Number.MAX_SAFE_INTEGER) + 1n, enabled: true }
    ]) await expect(value.host.setHostMute(stale))
      .rejects.toMatchObject({ reason: RemoteDesktopFailureReason.HOST_MUTE_EXPIRED });
    expect(value.audioBackend.setMuted).not.toHaveBeenCalled();
  });

  it.each([true, false])("Linux host mute capability follows its actual adapter %s and ordinary unlocked session", async (supported) => {
    const disabled = fixture({ enabled: false, platform: "linux", hostMute: supported });
    const value = fixture({ enabled: true, platform: "linux", hostMute: supported,
      linuxCapabilities: { canControl: true, cursorOverlay: false } });
    hosts.push(disabled.host, value.host);
    expect((await disabled.host.getCapabilities(REQUEST)).hostMute).toBe(supported);
    expect((await value.host.getCapabilities(REQUEST)).hostMute).toBe(supported);
    value.setSessionState("locked-logged-in");
    expect(await value.host.getCapabilities(REQUEST)).toMatchObject({ canControl: false, hostMute: false });
    expect(value.hostMute.set).not.toHaveBeenCalled();
  });

  it("Linux host mute holds the exact control owner and restores before replacement and exit", async () => {
    const value = fixture({ enabled: true, platform: "linux", hostMute: true,
      linuxCapabilities: { canControl: true, cursorOverlay: false } });
    hosts.push(value.host);
    const request = await controlledRequest(value);
    await expect(value.host.setHostMute({ ...request, enabled: true })).resolves.toMatchObject({ enabled: true });
    const [owner, enabled, current, signal] = value.hostMute.set.mock.calls[0]!;
    expect(enabled).toBe(true); expect(current()).toBe(true); expect(signal.aborted).toBe(false);
    expect(value.output.muted).toBe(true);
    await value.host.setControl({ ...request, enabled: false });
    expect(current()).toBe(false);
    expect(value.hostMute.release).toHaveBeenCalledExactlyOnceWith(owner);
    expect(value.output.muted).toBe(false);
    const control = await value.host.setControl({ ...request, enabled: true });
    await value.host.setHostMute({ ...request, controlGeneration: control.controlGeneration, enabled: true });
    const nextOwner = value.hostMute.set.mock.calls[1]![0];
    expect(nextOwner).not.toBe(owner);
    await value.host.stop({ ...REQUEST, leaseId: request.leaseId });
    expect(value.hostMute.release).toHaveBeenLastCalledWith(nextOwner);
    expect(value.output.muted).toBe(false);
    expect(value.host.state).toBeUndefined();
  });

  it("keeps mute failure scoped and supports an explicit native retry", async () => {
    const value = fixture({ enabled: true, platform: "win32" });
    hosts.push(value.host);
    const request = await controlledRequest(value);
    value.audioBackend.setMuted.mockRejectedValueOnce(new Error("native output rejected"));
    await expect(value.host.setHostMute({ ...request, enabled: true })).rejects.toMatchObject({
      reason: RemoteDesktopFailureReason.HOST_MUTE_UNAVAILABLE, retryable: true
    });
    expect(value.host.state).toMatchObject({ leaseId: request.leaseId, controlling: true });
    expect(value.media.stop).not.toHaveBeenCalled();
    await expect(value.host.setHostMute({ ...request, enabled: true })).resolves.toMatchObject({ enabled: true });
    expect(value.output.muted).toBe(true);
    const owner = value.hostMute.set.mock.calls[1]![0];
    const restoresBeforePresentation = value.hostMute.release.mock.calls.length;
    await value.host.setPresentation({ ...REQUEST, leaseId: request.leaseId, enabled: true });
    expect(value.output.muted).toBe(true);
    expect(value.hostMute.release).toHaveBeenCalledTimes(restoresBeforePresentation);
    expect(value.host.state).toMatchObject({ leaseId: request.leaseId, controlling: false });
    await value.host.setControl({ ...REQUEST, leaseId: request.leaseId, enabled: false });
    expect(value.output.muted).toBe(false);
    expect(value.hostMute.release).toHaveBeenLastCalledWith(owner);
    expect(value.host.state).toMatchObject({ leaseId: request.leaseId, controlling: false });
  });

  it.each(["darwin", "linux"] as const)("restores a %s native mute that completes after session ownership changes", async (platform) => {
    const value = fixture({ enabled: true, platform, hostMute: true,
      linuxCapabilities: { canControl: true, cursorOverlay: false } });
    hosts.push(value.host);
    const request = await controlledRequest(value);
    let complete!: () => void;
    value.audioBackend.setMuted.mockImplementationOnce(async (muted) => {
      value.output.muted = muted;
      await new Promise<void>((resolve) => { complete = resolve; });
    });
    const pending = value.host.setHostMute({ ...request, enabled: true });
    const outcome = expect(pending).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.HOST_MUTE_EXPIRED });
    await vi.waitFor(() => expect(value.output.muted).toBe(true));
    value.setSessionState("locked-logged-in");
    complete();
    await outcome;
    expect(value.output.muted).toBe(false);
    expect(value.host.state).toMatchObject({ leaseId: request.leaseId, controlling: false });
    expect(value.media.stop).not.toHaveBeenCalled();
  });

  it("waits for physical restore on retire and retries its retained snapshot after rejection", async () => {
    const value = fixture({ enabled: true, platform: "win32" });
    const request = await controlledRequest(value);
    await value.host.setHostMute({ ...request, enabled: true });
    let complete!: () => void;
    value.audioBackend.setMuted.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { complete = resolve; });
      throw new Error("native restore rejected");
    });
    let settled = false;
    const retiring = value.host.retire().finally(() => { settled = true; });
    const outcome = expect(retiring).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.HOST_MUTE_UNAVAILABLE });
    await vi.waitFor(() => expect(value.audioBackend.setMuted).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    expect(value.host.state).toBeUndefined();
    complete();
    await outcome;
    expect(value.output.muted).toBe(true);
    await expect(value.host.retire()).resolves.toBeUndefined();
    expect(value.output.muted).toBe(false);
    expect(value.audioBackend.setMuted.mock.calls.map(([muted]) => muted)).toEqual([true, false, false]);
    expect(value.input.retire).toHaveBeenCalled();
    expect(value.media.retire).toHaveBeenCalled();
  });

  it.each(["disconnect", "display", "session"])("restores host output on local %s retirement", async (cause) => {
    const value = fixture({ enabled: true, platform: "win32" });
    hosts.push(value.host);
    const request = await controlledRequest(value);
    await value.host.setHostMute({ ...request, enabled: true });
    if (cause === "disconnect") value.host.disconnect();
    else if (cause === "display") value.displayChanged();
    else value.setSessionState("unsupported");
    await vi.waitFor(() => expect(value.output.muted).toBe(false));
    expect(value.host.state).toBeUndefined();
  });

  it("requires the platform lock writer and permits an exact view-only owner", async () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const value = fixture({ enabled: true, platform });
      hosts.push(value.host);
      expect((await value.host.getCapabilities(REQUEST)).lockOnExit).toBe(platform === "darwin");
    }
    const value = fixture({ enabled: true, platform: "darwin" });
    hosts.push(value.host);
    const lease = await value.host.start({ ...REQUEST, displayId: "display-1", mode: RemoteDesktopStartMode.NEW });
    await expect(value.host.stop({ ...REQUEST, leaseId: lease.leaseId, lockScreen: true, controlGeneration: lease.controlGeneration }))
      .resolves.toBeUndefined();
    expect(value.lockScreen).toHaveBeenCalledOnce();
    expect(value.input.release).toHaveBeenCalledOnce();
    expect(value.host.state).toBeUndefined();
  });

  it.each([true, false])("Linux terminal lock capability follows its independent native probe %s without input or capture modes", async supported => {
    const value = fixture({ enabled: true, platform: "linux",
      linuxCapabilities: { canControl: false, cursorOverlay: false, lockOnExit: supported } });
    hosts.push(value.host);
    expect(await value.host.getCapabilities(REQUEST)).toMatchObject({ canControl: false, cursorOverlay: false,
      displayModes: false, resolutionRestore: false, lockOnExit: supported, nativeCredentials: false });
    expect(await value.host.getLockState(REQUEST)).toMatchObject({ state: RemoteDesktopLockState.UNAVAILABLE });
    const unavailable = fixture({ enabled: true, platform: "linux", lockOnExit: false,
      linuxCapabilities: { canControl: false, cursorOverlay: false, lockOnExit: supported } });
    hosts.push(unavailable.host);
    expect((await unavailable.host.getCapabilities(REQUEST)).lockOnExit).toBe(false);
  });

  it.each(["locked-logged-in", "unsupported", "unknown"] as const)(
    "Linux terminal lock uses fresh owned %s proof while ordinary no-grim capture remains unavailable", async proof => {
      const value = fixture({ enabled: true, platform: "linux",
        linuxCapabilities: { canControl: false, cursorOverlay: false, lockOnExit: true } });
      hosts.push(value.host);
      const lease = await value.host.start({ ...REQUEST, displayId: "display-1", mode: RemoteDesktopStartMode.NEW });
      let finishProof!: (state: DesktopRemoteDesktopSessionState) => void;
      const nativeProof = new Promise<DesktopRemoteDesktopSessionState>(resolve => { finishProof = resolve; });
      value.lockScreen.mockImplementationOnce(async current => {
        value.lockSessionProbe.mockImplementation(async () => nativeProof);
        value.setSessionState("unsupported");
        await vi.waitFor(() => expect(value.media.setSessionState).toHaveBeenLastCalledWith(false));
        expect(current()).toBe(true);
      });
      let settled = false;
      const pending = value.host.stop({ ...REQUEST, leaseId: lease.leaseId,
        lockScreen: true, controlGeneration: lease.controlGeneration }).finally(() => { settled = true; });
      const outcome = proof === "locked-logged-in" ? expect(pending).resolves.toBeUndefined()
        : expect(pending).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.LOCK_EXPIRED });
      await vi.waitFor(() => expect(value.lockSessionProbe).toHaveBeenCalledTimes(2));
      expect(settled).toBe(false);
      await expect(value.host.getFrame({ ...REQUEST, leaseId: lease.leaseId, cursorOverlay: false })).rejects.toBeDefined();
      expect(value.media.frame).not.toHaveBeenCalled();
      expect(value.input.start).not.toHaveBeenCalled();
      expect(value.host.state).toMatchObject({ leaseId: lease.leaseId, controlling: false });
      finishProof(proof); await outcome;
      expect(value.host.state).toBeUndefined();
      await expect(value.host.stop({ ...REQUEST, leaseId: lease.leaseId,
        lockScreen: true, controlGeneration: lease.controlGeneration }))
        .rejects.toMatchObject({ reason: RemoteDesktopFailureReason.LOCK_EXPIRED });
      expect(value.lockScreen).toHaveBeenCalledOnce();
    }
  );

  it.each([false, true])("Linux mirror restore adopts physical geometry before terminal lock and source removal %s", async sourceRemoved => {
    const source = { id: "display-1", name: "Display 1", width: 1280, height: 800 };
    let restored!: () => void;
    const handle = { displayId: "mirror-1", dispose: vi.fn(),
      resize: vi.fn(async (width: number, height: number) => ({ id: "mirror-1", name: "Viewer", width, height })),
      restore: vi.fn(async (current: () => boolean) => {
        await new Promise<void>(resolve => { restored = resolve; });
        expect(current()).toBe(true); return source;
      }) };
    const value = fixture({ enabled: true, platform: "linux",
      linuxCapabilities: { canControl: true, cursorOverlay: false, viewerDisplay: true, lockOnExit: true },
      createViewerDisplay: vi.fn(async () => handle) });
    hosts.push(value.host);
    const request = await controlledRequest(value);
    const fitted = await value.host.setViewerDisplay({ ...request, width: 800, height: 600 });
    value.lockScreen.mockImplementationOnce(async current => {
      expect(value.host.state?.displayId).toBe("display-1");
      expect(value.host.managedViewerDisplay).toBeUndefined();
      value.displayChangeFor("mirror-1");
      value.displayChangeFor("display-1", { width: 1280, height: 800, metrics: ["bounds", "workArea"] });
      expect(current()).toBe(true);
      if (sourceRemoved) {
        value.displayChangeFor("display-1");
        expect(current()).toBe(false);
        throw new Error("REMOTE_DESKTOP_LOCK_EXPIRED");
      }
      value.lockSessionProbe.mockResolvedValue("locked-logged-in");
      value.setSessionState("unsupported");
      expect(current()).toBe(true);
    });
    const pending = value.host.stop({ ...REQUEST, leaseId: request.leaseId,
      controlGeneration: fitted.lease!.controlGeneration, lockScreen: true });
    const outcome = sourceRemoved ? expect(pending).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.LOCK_EXPIRED })
      : expect(pending).resolves.toBeUndefined();
    await vi.waitFor(() => expect(restored).toBeTypeOf("function"));
    expect(value.host.state?.displayId).toBe("mirror-1");
    expect(value.lockScreen).not.toHaveBeenCalled();
    restored(); await outcome;
    expect(value.lockScreen).toHaveBeenCalledOnce();
    expect(handle.restore).toHaveBeenCalledOnce();
    expect(value.host.state).toBeUndefined();
  });

  it("awaits mute restore and helper release before the fixed native lock", async () => {
    const value = fixture({ enabled: true, platform: "darwin" });
    hosts.push(value.host);
    const request = await controlledRequest(value);
    await value.host.setHostMute({ ...request, enabled: true });
    let release!: () => void;
    vi.mocked(value.input.release).mockImplementationOnce(async () => {
      expect(value.output.muted).toBe(false);
      await new Promise<void>((resolve) => { release = resolve; });
    });
    const pending = value.host.stop({ ...request, lockScreen: true });
    await vi.waitFor(() => expect(value.input.release).toHaveBeenCalledOnce());
    expect(value.output.muted).toBe(false);
    expect(value.host.state?.controlling).toBe(false);
    expect(value.lockScreen).not.toHaveBeenCalled();
    release();
    await pending;
    expect(value.lockScreen).toHaveBeenCalledOnce();
    expect(value.host.state).toBeUndefined();
  });

  it.each(["locked-logged-in", "unsupported", "unknown"] as const)(
    "waits for fresh %s proof after a native lock event with a pending session probe", async (proof) => {
      const value = fixture({ enabled: true, platform: "darwin" });
      hosts.push(value.host);
      const request = await controlledRequest(value);
      let finishProof!: (state: DesktopRemoteDesktopSessionState) => void;
      const nativeProof = new Promise<DesktopRemoteDesktopSessionState>((resolve) => { finishProof = resolve; });
      value.lockScreen.mockImplementationOnce(async (current) => {
        value.sessionProbe.mockImplementation(async () => nativeProof);
        value.setSessionState("locked-logged-in");
        // The real helper returns confirmed locked before the asynchronous
        // Electron session probe necessarily completes.
        expect(current()).toBe(true);
      });
      let settled = false;
      const pending = value.host.stop({ ...request, lockScreen: true }).finally(() => { settled = true; });
      const outcome = proof === "locked-logged-in"
        ? expect(pending).resolves.toBeUndefined()
        : expect(pending).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.LOCK_EXPIRED });
      await vi.waitFor(() => expect(value.lockScreen).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      finishProof(proof);
      await outcome;
      expect(value.host.state).toBeUndefined();
    }
  );

  it("propagates exact command cancellation to native lock and cannot replay it", async () => {
    const value = fixture({ enabled: true, platform: "darwin" });
    hosts.push(value.host);
    const request = await controlledRequest(value);
    const command = new AbortController();
    let nativeSignal!: AbortSignal;
    value.lockScreen.mockImplementationOnce(async (_current, signal) => {
      nativeSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("REMOTE_DESKTOP_LOCK_EXPIRED")), { once: true });
      });
    });
    const pending = value.host.stop({ ...request, signal: command.signal, lockScreen: true });
    const outcome = expect(pending).rejects.toBeDefined();
    await vi.waitFor(() => expect(value.lockScreen).toHaveBeenCalledOnce());
    command.abort();
    await outcome;
    expect(nativeSignal.aborted).toBe(true);
    expect(value.host.state).toBeUndefined();
    await expect(value.host.stop({ ...request, lockScreen: true }))
      .rejects.toMatchObject({ reason: RemoteDesktopFailureReason.LOCK_EXPIRED });
    expect(value.lockScreen).toHaveBeenCalledOnce();
  });

  it("Linux uses independent actual input and cursor probes while excluded capabilities remain false", async () => {
    const value = fixture({ enabled: true, platform: "linux", linuxCapabilities: { canControl: true, cursorOverlay: true } });
    hosts.push(value.host);
    expect(await value.host.getCapabilities(REQUEST)).toMatchObject({ canControl: true, cursorOverlay: true,
      displayModes: false, resolutionRestore: false, clipboardText: false, clipboardContent: false,
      systemAudio: false, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false, nativeCredentials: false });
    const lease = await value.host.start({ ...REQUEST, displayId: "display-1", mode: RemoteDesktopStartMode.NEW });
    expect(await value.host.setControl({ ...REQUEST, leaseId: lease.leaseId, enabled: true })).toMatchObject({ controlling: true });
    expect(value.input.start).toHaveBeenCalledOnce();
    await value.host.getFrame({ ...REQUEST, leaseId: lease.leaseId, cursorOverlay: true });
    expect(value.media.frame).toHaveBeenCalledWith(expect.objectContaining({ leaseId: lease.leaseId, cursorOverlay: true }));
  });

  it("Linux fresh session fences late pixels on native lock while retaining its exact view lease", async () => {
    const value = fixture({ enabled: true, platform: "linux", linuxCapabilities: { canControl: true, cursorOverlay: true } });
    hosts.push(value.host);
    const lease = await value.host.start({ ...REQUEST, displayId: "display-1", mode: RemoteDesktopStartMode.NEW });
    await value.host.setControl({ ...REQUEST, leaseId: lease.leaseId, enabled: true });
    let deliver!: () => void;
    vi.mocked(value.media.frame).mockImplementationOnce(async request => {
      await new Promise<void>(resolve => { deliver = resolve; });
      expect(request.current()).toBe(false);
      return { jpeg: "AQ==", width: 1, height: 1 };
    });
    const pending = value.host.getFrame({ ...REQUEST, leaseId: lease.leaseId, cursorOverlay: true });
    await vi.waitFor(() => expect(value.media.frame).toHaveBeenCalledOnce());
    value.setSessionState("locked-logged-in");
    await vi.waitFor(() => expect(value.media.setSessionState).toHaveBeenLastCalledWith(true));
    deliver();
    expect((await pending).frame).toBeUndefined();
    expect(value.host.state).toMatchObject({ leaseId: lease.leaseId, controlling: false });
    await expect(value.host.setControl({ ...REQUEST, leaseId: lease.leaseId, enabled: true }))
      .rejects.toMatchObject({ reason: RemoteDesktopFailureReason.VIEW_ONLY });
    expect(value.input.stop).toHaveBeenCalled();
    await expect(value.host.getCapabilities(REQUEST)).resolves.toMatchObject({ canControl: false, cursorOverlay: true });
  });

  it("Linux discovers missing owned session before another frame without relying on power events", async () => {
    const value = fixture({ enabled: true, platform: "linux", linuxCapabilities: { canControl: true, cursorOverlay: false } });
    hosts.push(value.host);
    const lease = await value.host.start({ ...REQUEST, displayId: "display-1", mode: RemoteDesktopStartMode.NEW });
    value.setSessionProbe(false);
    await expect(value.host.getFrame({ ...REQUEST, leaseId: lease.leaseId, cursorOverlay: false }))
      .rejects.toMatchObject({ reason: RemoteDesktopFailureReason.LEASE_EXPIRED });
    expect(value.host.state).toBeUndefined(); expect(value.media.frame).not.toHaveBeenCalled();
  });

  it("Linux view-only viewing starts without control and a fresh lock retires late pixels and the old lease", async () => {
    const value = fixture({ enabled: true, platform: "linux", linuxCapabilities: { canControl: false, cursorOverlay: false } });
    hosts.push(value.host);
    expect(await value.host.getCapabilities(REQUEST)).toMatchObject({ canControl: false, cursorOverlay: false,
      clipboardText: false, clipboardContent: false, systemAudio: false, hostMute: false, lockOnExit: false,
      privacyScreen: false, nativeCredentials: false });
    const lease = await value.host.start({ ...REQUEST, displayId: "display-1", mode: RemoteDesktopStartMode.NEW });
    expect(lease.controlling).toBe(false);
    await expect(value.host.setControl({ ...REQUEST, leaseId: lease.leaseId, enabled: true }))
      .rejects.toMatchObject({ reason: RemoteDesktopFailureReason.VIEW_ONLY });
    expect(value.input.start).not.toHaveBeenCalled();
    await expect(value.host.createOffer({ ...REQUEST, leaseId: lease.leaseId, attemptId: "view-only",
      offerSdp: "offer", cursorOverlay: false })).resolves.toMatchObject({ answerSdp: "answer" });
    let deliver!: () => void;
    vi.mocked(value.media.frame).mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { deliver = resolve; });
      return { jpeg: "AQ==", width: 1, height: 1 };
    });
    const pending = value.host.getFrame({ ...REQUEST, leaseId: lease.leaseId, cursorOverlay: false });
    const rejected = expect(pending).rejects.toBeDefined();
    await vi.waitFor(() => expect(value.media.frame).toHaveBeenCalledOnce());
    // A lock discovered by the post-capture proof retires X11 without a power event.
    value.setSessionProbe(false); deliver(); await rejected;
    expect(value.host.state).toBeUndefined();
    expect(value.media.stop).toHaveBeenCalled();
    value.setSessionProbe(true);
    await expect(value.host.heartbeat({ ...REQUEST, leaseId: lease.leaseId })).rejects.toBeDefined();
    const replacement = await value.host.start({ ...REQUEST, displayId: "display-1", mode: RemoteDesktopStartMode.NEW });
    expect(replacement.leaseId).not.toBe(lease.leaseId);
  });

  it("Linux portal capture pending preserves lease and typed retryability", async () => {
    const value = fixture({ enabled: true, platform: "linux" }); hosts.push(value.host);
    const lease = await value.host.start({ ...REQUEST, displayId: "display-1", mode: RemoteDesktopStartMode.NEW });
    vi.mocked(value.media.offer).mockRejectedValueOnce(new Error("REMOTE_DESKTOP_CAPTURE_PENDING"));
    await expect(value.host.createOffer({ ...REQUEST, leaseId: lease.leaseId, attemptId: "portal-attempt",
      offerSdp: "offer", cursorOverlay: false })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.CAPTURE_PENDING, retryable: true });
    expect(value.host.state?.leaseId).toBe(lease.leaseId);
    await expect(value.host.heartbeat({ ...REQUEST, leaseId: lease.leaseId })).resolves.toMatchObject({ controlling: false });
    expect(value.media.stop).not.toHaveBeenCalled();
  });

  it("reports failed native lock while ending its captured lease and rejects stale generation", async () => {
    const value = fixture({ enabled: true, platform: "darwin" });
    hosts.push(value.host);
    const request = await controlledRequest(value);
    await expect(value.host.stop({ ...request, lockScreen: true, controlGeneration: request.controlGeneration - 1n }))
      .rejects.toMatchObject({ reason: RemoteDesktopFailureReason.LOCK_EXPIRED });
    value.lockScreen.mockRejectedValueOnce(new Error("REMOTE_DESKTOP_LOCK_FAILED"));
    await expect(value.host.stop({ ...request, lockScreen: true }))
      .rejects.toMatchObject({ reason: RemoteDesktopFailureReason.LOCK_FAILED, retryable: false });
    expect(value.host.state).toBeUndefined();
    const next = await controlledRequest(value);
    await expect(value.host.stop({ ...request, lockScreen: true }))
      .rejects.toMatchObject({ reason: RemoteDesktopFailureReason.LOCK_EXPIRED });
    expect(value.host.state?.leaseId).toBe(next.leaseId);
    expect(value.lockScreen).toHaveBeenCalledOnce();
  });
});

function fixture(options: {
  readonly enabled: boolean;
  readonly platform: DesktopRemoteDesktopHostDependencies["platform"];
  readonly sessionUnlocked?: boolean;
  readonly sessionState?: DesktopRemoteDesktopSessionState;
  readonly hostMute?: boolean;
  readonly lockOnExit?: false;
  readonly privacyScreen?: boolean;
  readonly workspace?: boolean;
  readonly prepare?: DesktopRemoteDesktopHostDependencies["prepare"];
  readonly linuxCapabilities?: { readonly canControl: boolean; readonly cursorOverlay: boolean; readonly displayModes?: boolean; readonly viewerDisplay?: boolean; readonly lockOnExit?: boolean; readonly privacyScreen?: boolean;
    readonly workspaceNavigation?: boolean; readonly systemMenu?: boolean };
  readonly windowsCapabilities?: DesktopRemoteDesktopHostDependencies["windowsCapabilities"];
  readonly createViewerDisplay?: DesktopRemoteDesktopHostDependencies["createViewerDisplay"];
  readonly viewerDisplaySupported?: DesktopRemoteDesktopHostDependencies["viewerDisplaySupported"];
  readonly linuxClipboard?: true;
  readonly linuxAudio?: true;
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
    setPrivacyExclusions: vi.fn(),
    preparePrivacy: vi.fn(async () => undefined),
    clearPrivacyExclusions: vi.fn(),
    stop: vi.fn(),
    retire: vi.fn(async () => undefined)
  };
  const input: DesktopRemoteDesktopInputPort = {
    start: vi.fn(async () => undefined),
    resumeAfterPrivacy: vi.fn(async () => undefined),
    send: vi.fn(),
    stop: vi.fn(),
    release: vi.fn(async () => undefined),
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
    }),
    readSystemContent: vi.fn(async (current) => {
      if (!current()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
      return { text: "system text" };
    }),
    writeSystemContent: vi.fn(async (_content, _version, current) => {
      if (!current()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
      return "2";
    })
  };
  const clipboardCounter = { read: vi.fn(async () => "1"), stop: vi.fn() };
  const privacyScreen = {
    set: vi.fn(async (_owner: object, _display: string, _current: () => boolean, _signal: AbortSignal): Promise<void> => undefined),
    release: vi.fn(async (_owner: object): Promise<void> => undefined)
  };
  const workspaceAction = vi.fn(async (_action: RemoteDesktopSystemAction, _displayId: string,
    _current: () => boolean, _signal: AbortSignal): Promise<void> => undefined);
  const stopWorkspaceActions = vi.fn(async (): Promise<void> => undefined);
  const output = { muted: false };
  const audioBackend = {
    supported: true,
    getMuted: vi.fn(async () => output.muted),
    setMuted: vi.fn(async (muted: boolean) => { output.muted = muted; })
  };
  const audioGuard = new SystemAudioMuteGuard<number | object>(audioBackend);
  const hostMute = {
    set: vi.fn(async (owner: object, enabled: boolean, current: () => boolean, signal: AbortSignal) => {
      const check = (): void => {
        if (signal.aborted || !current()) throw new Error("REMOTE_DESKTOP_HOST_MUTE_EXPIRED");
      };
      try {
        if (enabled) await audioGuard.acquire(owner, check);
        else await audioGuard.release(owner, check);
        check();
      } catch (error) {
        if (error instanceof Error && error.message === "REMOTE_DESKTOP_HOST_MUTE_EXPIRED") throw error;
        throw new Error("REMOTE_DESKTOP_HOST_MUTE_UNAVAILABLE");
      }
    }),
    release: vi.fn(async (owner: object) => {
      try { await audioGuard.release(owner); }
      catch { throw new Error("REMOTE_DESKTOP_HOST_MUTE_UNAVAILABLE"); }
    })
  };
  const lockScreen = vi.fn(async (current: () => boolean, signal: AbortSignal) => {
    if (signal.aborted || !current()) throw new Error("REMOTE_DESKTOP_LOCK_EXPIRED");
    sessionState = "locked-logged-in";
    sessionListener?.();
  });
  let lease = 0;
  let presentationPong: ((leaseId: string) => void) | undefined;
  let sessionState: DesktopRemoteDesktopSessionState = options.sessionState
    ?? (options.sessionUnlocked === false ? "unsupported" : "unlocked");
  let sessionListener: (() => void) | undefined;
  const sessionProbe = vi.fn(async () => sessionState);
  const lockSessionProbe = vi.fn(async () => sessionState);
  let displayListener: ((displayId: string, geometryChanged: boolean,
    geometry?: { readonly width: number; readonly height: number; readonly metrics: readonly string[] }) => void) | undefined;
  const permissions = vi.fn(async () => Object.freeze({
    screenRecording: options.platform === "darwin" ? "granted" : "notRequired",
    accessibility: options.platform === "darwin" ? "granted" : "notRequired"
  } as const));
  const displays = vi.fn(() => [
    { id: "display-1", name: "Display 1", width: 1_280, height: 800 }
  ]);
  const displayModes = vi.fn(async (): Promise<readonly RemoteDesktopDisplayMode[]> => [
    { id: "42", width: 1_280, height: 800, current: true, native: true }
  ]);
  const setDisplayMode = vi.fn(async (
    _displayId: string,
    _modeId: string,
    beforeChange: () => void | Promise<void>,
    _signal: AbortSignal,
    expected?: { readonly width: number; readonly height: number }
  ) => { await beforeChange(); return { ...displays()[0]!, ...(expected === undefined ? {} : { width: expected.width, height: expected.height }) }; });
  const restoreDisplayMode = vi.fn(async (_id: string, _mode: string, current: () => boolean,
    expected: { readonly width: number; readonly height: number }, _signal: AbortSignal) => {
    if (!current()) throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
    return { ...displays()[0]!, ...expected };
  });
  const retired = vi.fn();
  const host = new DesktopRemoteDesktopHost({
    platform: options.platform,
    systemAudio: options.platform === "win32" || options.linuxAudio === true,
    enabled: () => options.enabled,
    sessionState: sessionProbe,
    displays,
    permissions,
    showPermissionGuide: vi.fn(async () => undefined),
    ...(options.prepare === undefined ? {} : { prepare: options.prepare }),
    media,
    input,
    ...(options.createViewerDisplay === undefined ? {} : { createViewerDisplay: options.createViewerDisplay }),
    ...(options.viewerDisplaySupported === undefined ? {} : { viewerDisplaySupported: options.viewerDisplaySupported }),
    ...(options.linuxCapabilities === undefined ? {} : { linuxCapabilities: vi.fn(async () => options.linuxCapabilities!) }),
    ...(options.windowsCapabilities === undefined ? {} : { windowsCapabilities: options.windowsCapabilities }),
    ...(options.platform === "linux" && options.linuxClipboard !== true ? {} : { clipboard, clipboardCounter }),
    ...((options.platform === "linux" && options.hostMute !== true) || options.hostMute === false ? {} : { hostMute }),
    ...((options.platform === "linux" && options.privacyScreen !== true) || options.privacyScreen === false ? {} : { privacyScreen }),
    ...(options.workspace === true ? { workspaceAction, stopWorkspaceActions } : {}),
    ...(options.platform === "darwin" || options.linuxCapabilities?.displayModes === true ? { displayModes, setDisplayMode, restoreDisplayMode,
      displayPresent: () => displays().some((display) => display.id === "display-1") } : {}),
    ...((options.platform === "darwin" || options.linuxCapabilities?.lockOnExit === true) && options.lockOnExit !== false
      ? { lockScreen, ...(options.platform === "linux" ? { lockSessionState: lockSessionProbe } : {}) } : {}),
    changed: vi.fn(),
    retired,
    onSessionStateChange: (listener) => {
      sessionListener = listener;
      return () => { if (sessionListener === listener) sessionListener = undefined; };
    },
    onDisplayChange: (listener) => {
      displayListener = listener;
      return () => { if (displayListener === listener) displayListener = undefined; };
    },
    createLeaseId: () => `lease-${++lease}`
  });
  return {
    host,
    media,
    input,
    clipboard,
    clipboardCounter,
    privacyScreen,
    workspaceAction,
    stopWorkspaceActions,
    output,
    audioBackend,
    audioGuard,
    hostMute,
    lockScreen,
    sessionProbe,
    lockSessionProbe,
    permissions,
    displays,
    displayModes,
    setDisplayMode,
    restoreDisplayMode,
    retired,
    presentationPong(leaseId: string): void {
      presentationPong?.(leaseId);
    },
    displayChanged(geometry?: { readonly width: number; readonly height: number; readonly metrics: readonly string[] }): void {
      displayListener?.("display-1", true, geometry);
    },
    displayChangeFor(displayId: string, geometry?: { readonly width: number; readonly height: number; readonly metrics: readonly string[] }): void {
      displayListener?.(displayId, true, geometry);
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

async function controlledRequest(value: ReturnType<typeof fixture>) {
  const lease = await value.host.start({ ...REQUEST, displayId: "display-1", mode: RemoteDesktopStartMode.NEW });
  const control = await value.host.setControl({ ...REQUEST, leaseId: lease.leaseId, enabled: true });
  return { ...REQUEST, leaseId: lease.leaseId, controlGeneration: control.controlGeneration };
}
