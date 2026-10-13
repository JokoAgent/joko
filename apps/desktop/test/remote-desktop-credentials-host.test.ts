import { create } from "@bufbuild/protobuf";
import { RemoteDesktopCredentialRequestSchema, RemoteDesktopFailureReason, RemoteDesktopLockState } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "D:/joko/.runtime" } }));

import { DesktopRemoteDesktopCredentialsHost } from "../src/remote-desktop-credentials-host.js";
import { DesktopRemoteCredentialsNativeError, DesktopRemoteCredentialsNative } from "../src/remote-desktop-credentials-native.js";
import { DesktopRemoteDesktopHost, type DesktopRemoteDesktopHostDependencies } from "../src/remote-desktop-host.js";

const HANDLE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PREPARE = create(RemoteDesktopCredentialRequestSchema, { request: { case: "prepare", value: {} } });
const OPEN = create(RemoteDesktopCredentialRequestSchema, { request: { case: "open", value: { offer: "signed.offer" } } });
const EXCHANGE = create(RemoteDesktopCredentialRequestSchema, { request: { case: "exchange", value: { handle: HANDLE, ciphertext: "encrypted.message" } } });
const OWNER = { serverId: "server-a", deviceId: "host-a", profileId: "profile-a" };
const SIGNAL = new AbortController().signal;
const retiring: { retire(): Promise<void> }[] = [];

afterEach(async () => { await Promise.all(retiring.splice(0).map(value => value.retire())); vi.useRealTimers(); });

function nativeFixture() {
  const native = new DesktopRemoteCredentialsNative();
  const request = vi.spyOn(native, "request").mockImplementation(async () => { throw new DesktopRemoteCredentialsNativeError("CREDENTIAL_UNAVAILABLE"); });
  const close = vi.spyOn(native, "close").mockImplementation(async (): Promise<void> => undefined);
  return { native, request, close };
}

function fixture() {
  const native = nativeFixture();
  const execute = vi.fn(async (_peer: string, _body: unknown, _owner: object, _signal: AbortSignal): Promise<unknown> => ({ ok: true }));
  const invalidated = vi.fn();
  const clock = { now: 1_000 };
  const adapter = new DesktopRemoteDesktopCredentialsHost({ native: native.native, owner: OWNER, current: () => true, invalidated, execute, now: () => clock.now });
  retiring.push(adapter);
  return { ...native, execute, invalidated, clock, adapter };
}

async function opened(value: ReturnType<typeof fixture>) {
  value.request.mockResolvedValueOnce("public.identity");
  await value.adapter.request("controller-a", PREPARE, SIGNAL);
  value.request.mockResolvedValueOnce({ handle: HANDLE, offer: "signed.reply" });
  await value.adapter.request("controller-a", OPEN, SIGNAL);
}

describe("Remote Desktop credential host occurrence", () => {
  it("executes only a verified private native command and returns only encrypted bytes", async () => {
    const value = fixture(); await opened(value);
    value.request.mockResolvedValueOnce({ kind: "command", id: "command-a", body: '{"op":"capabilities"}', authenticationSession: "proof-a" })
      .mockResolvedValueOnce({ "controller-a": "proof-a" }).mockResolvedValueOnce("encrypted.reply");
    expect(await value.adapter.request("controller-a", EXCHANGE, SIGNAL)).toMatchObject({ result: { case: "exchanged", value: { ciphertext: "encrypted.reply" } } });
    const authenticationOwner = value.execute.mock.calls[0]![2];
    expect(value.adapter.authenticationSession(authenticationOwner)).toBe("proof-a");
    expect(value.request).toHaveBeenLastCalledWith("response", { peer: "controller-a", handle: HANDLE, requestId: "command-a", body: '{"ok":true}', success: true }, { signal: SIGNAL });
    value.clock.now += 2_501;
    expect(value.adapter.authenticationSession(authenticationOwner)).toBeNull();
  });

  it("rejects a mismatched private proof and a handle owned by another controller", async () => {
    const value = fixture(); await opened(value);
    await expect(value.adapter.request("controller-b", EXCHANGE, SIGNAL)).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.CREDENTIAL_EXPIRED });
    value.request.mockResolvedValueOnce({ kind: "command", id: "command-a", body: '{"op":"capabilities"}', authenticationSession: "old-proof" })
      .mockResolvedValueOnce({ "controller-a": "new-proof" });
    await expect(value.adapter.request("controller-a", EXCHANGE, SIGNAL)).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.AUTHENTICATION_REQUIRED });
    expect(value.execute).not.toHaveBeenCalled();
    expect(value.request.mock.calls.filter(([method]) => method === "response")).toHaveLength(0);
  });

  it("keeps a cancelled begin occupied until its real receipt and closes only that exact handle", async () => {
    const value = fixture(); value.request.mockResolvedValueOnce("public.identity");
    await value.adapter.request("controller-a", PREPARE, SIGNAL);
    let ready!: (value: { handle: string; offer: string }) => void;
    value.request.mockReturnValueOnce(new Promise(resolve => { ready = resolve; })).mockResolvedValueOnce(true);
    const cancellation = new AbortController(); const reason = new Error("cancelled occurrence");
    const pending = expect(value.adapter.request("controller-a", OPEN, cancellation.signal)).rejects.toBe(reason);
    cancellation.abort(reason);
    await expect(value.adapter.request("controller-a", OPEN, SIGNAL)).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.BUSY });
    ready({ handle: HANDLE, offer: "signed.reply" }); await pending;
    expect(value.request).toHaveBeenLastCalledWith("closeHandle", { peer: "controller-a", handle: HANDLE });
  });

  it("waits actual helper close before retirement settles and never installs a late opened handle", async () => {
    const value = fixture(); value.request.mockResolvedValueOnce("public.identity");
    await value.adapter.request("controller-a", PREPARE, SIGNAL);
    let opened!: (value: { handle: string; offer: string }) => void;
    let closed!: () => void;
    value.request.mockReturnValueOnce(new Promise(resolve => { opened = resolve; }));
    value.close.mockImplementationOnce(async () => new Promise<void>(resolve => { closed = resolve; }));
    const pending = expect(value.adapter.request("controller-a", OPEN, SIGNAL)).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.CREDENTIAL_EXPIRED });
    let settled = false; const retirement = value.adapter.retire().then(() => { settled = true; });
    opened({ handle: HANDLE, offer: "signed.reply" }); await Promise.resolve(); expect(settled).toBe(false);
    closed(); await retirement; await pending;
    expect(value.request.mock.calls.filter(([method]) => method === "closeHandle")).toHaveLength(0);
    await expect(value.adapter.request("controller-a", OPEN, SIGNAL)).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.CREDENTIAL_EXPIRED });
  });

  it("maps typed native diagnostics without exposing native OS messages", async () => {
    const value = fixture(); value.request.mockRejectedValueOnce(new DesktopRemoteCredentialsNativeError("CREDENTIAL_ACCESSIBILITY_REQUIRED"));
    await expect(value.adapter.request("controller-a", PREPARE, SIGNAL)).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.ACCESSIBILITY_PERMISSION_REQUIRED });
    value.request.mockRejectedValueOnce(new DesktopRemoteCredentialsNativeError("CREDENTIAL_DEVELOPMENT_SIGNING_REQUIRED"));
    await expect(value.adapter.request("controller-a", PREPARE, SIGNAL)).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.CREDENTIAL_UNAVAILABLE });
    value.request.mockRejectedValueOnce(new DesktopRemoteCredentialsNativeError("CREDENTIAL_OUTCOME_UNKNOWN"));
    await expect(value.adapter.request("controller-a", PREPARE, SIGNAL)).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.CREDENTIAL_OUTCOME_UNKNOWN, retryable: false });
  });

  it("cleanup retires only the captured handle and preserves a newer native occurrence", async () => {
    const value = fixture(); await opened(value);
    value.request.mockResolvedValueOnce({ kind: "command", id: "command-a", body: '{"op":"capabilities"}', authenticationSession: "proof-a" })
      .mockResolvedValueOnce({ "controller-a": "proof-a" }).mockResolvedValueOnce("encrypted.reply");
    await value.adapter.request("controller-a", EXCHANGE, SIGNAL);
    const oldOwner = value.execute.mock.calls[0]![2];
    const handle = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    value.request.mockResolvedValueOnce({ handle, offer: "signed.reply" }); await value.adapter.request("controller-a", OPEN, SIGNAL);
    const exchange = create(RemoteDesktopCredentialRequestSchema, { request: { case: "exchange", value: { handle, ciphertext: "encrypted.message" } } });
    value.request.mockResolvedValueOnce({ kind: "command", id: "command-b", body: '{"op":"capabilities"}', authenticationSession: "proof-b" })
      .mockResolvedValueOnce({ "controller-a": "proof-b" }).mockResolvedValueOnce("encrypted.reply");
    await value.adapter.request("controller-a", exchange, SIGNAL);
    const newOwner = value.execute.mock.calls[1]![2];
    value.request.mockResolvedValueOnce(true); await value.adapter.closeHandle("controller-a", HANDLE);
    expect(value.adapter.authenticationSession(oldOwner)).toBeNull(); expect(value.adapter.authenticationSession(newOwner)).toBe("proof-b");
    expect(value.request).toHaveBeenLastCalledWith("closeHandle", { peer: "controller-a", handle: HANDLE });
    const count = value.request.mock.calls.length;
    await value.adapter.closeHandle("controller-a", HANDLE);
    await expect(value.adapter.closeHandle("controller-b", handle)).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.CREDENTIAL_INVALID_IDENTITY });
    expect(value.request).toHaveBeenCalledTimes(count);
  });

  it("cleanup invalidates the old proof immediately while waiting for exact native close receipt", async () => {
    const value = fixture(); await opened(value);
    value.request.mockResolvedValueOnce({ kind: "command", id: "command-a", body: '{"op":"capabilities"}', authenticationSession: "proof-a" })
      .mockResolvedValueOnce({ "controller-a": "proof-a" }).mockResolvedValueOnce("encrypted.reply");
    await value.adapter.request("controller-a", EXCHANGE, SIGNAL); const owner = value.execute.mock.calls[0]![2];
    let close!: (value: true) => void;
    value.request.mockReturnValueOnce(new Promise(resolve => { close = resolve; }));
    let settled = false; const closing = value.adapter.closeHandle("controller-a", HANDLE).then(() => { settled = true; });
    expect(value.adapter.authenticationSession(owner)).toBeNull(); expect(settled).toBe(false);
    await expect(value.adapter.request("controller-a", EXCHANGE, SIGNAL)).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.CREDENTIAL_EXPIRED });
    close(true); await closing; expect(settled).toBe(true);
  });

  it.each(["darwin", "linux"] as const)("binds production %s Host decoded start to its native occurrence without changing ordinary paired requests", async platform => {
    const native = nativeFixture();
    let enabled = true;
    const dependencies: DesktopRemoteDesktopHostDependencies = {
      platform, systemAudio: false, enabled: () => enabled, sessionState: async () => "unlocked",
      displays: () => [{ id: "display-1", name: "Display", width: 100, height: 100 }],
      permissions: async () => ({ screenRecording: "granted", accessibility: "granted" }), showPermissionGuide: async () => undefined,
      input: { start: async () => undefined, send: vi.fn(), stop: vi.fn(), release: async () => undefined, retire: async () => undefined },
      media: { frame: async () => null, offer: async () => "answer", exchangeIce: async request => ({ attemptId: request.attemptId, candidates: [], next: 0, complete: true }),
        setInputHandler: () => () => undefined, setPresentationPongHandler: () => () => undefined, setPresentation: vi.fn(), setSessionState: vi.fn(),
        setPrivacyExclusions: vi.fn(), preparePrivacy: async () => undefined, clearPrivacyExclusions: vi.fn(), stop: vi.fn(), retire: async () => undefined },
      credentials: { native: native.native, owner: OWNER, ...(platform === "linux" ? { lockState: async () => "unlocked" as const } : {}) },
      ...(platform === "linux" ? { linuxCapabilities: async () => ({ canControl: true, cursorOverlay: false }) } : {}),
      changed: vi.fn(), createLeaseId: () => "lease-a"
    };
    const host = new DesktopRemoteDesktopHost(dependencies); retiring.push(host);
    const request = { controllerDeviceId: "controller-a", signal: SIGNAL };
    native.request.mockResolvedValueOnce("public.identity"); await host.requestCredentials({ ...request, request: PREPARE });
    native.request.mockResolvedValueOnce({ handle: HANDLE, offer: "signed.reply" }); await host.requestCredentials({ ...request, request: OPEN });
    native.request.mockResolvedValueOnce({ kind: "command", id: "command-a", body: '{"op":"start","displayId":"display-1"}', authenticationSession: "proof-a" })
      .mockResolvedValueOnce({ "controller-a": "proof-a" }).mockResolvedValueOnce("encrypted.reply");
    await host.requestCredentials({ ...request, request: EXCHANGE }); expect(host.state?.leaseId).toBe("lease-a");
    native.request.mockResolvedValueOnce({ kind: "reply", ciphertext: "encrypted.reply" }).mockResolvedValueOnce({ "controller-a": "proof-b" });
    await host.requestCredentials({ ...request, request: EXCHANGE }); expect(host.state).toBeUndefined();
    const ordinary = await host.start({ ...request, displayId: "display-1", mode: 1 });
    native.request.mockResolvedValueOnce({ kind: "closed" }).mockResolvedValueOnce({});
    await host.requestCredentials({ ...request, request: EXCHANGE }); expect(host.state?.leaseId).toBe(ordinary.leaseId);
    await expect(host.setControl({ ...request, leaseId: ordinary.leaseId, enabled: true })).resolves.toMatchObject({ controlling: true });
    native.request.mockResolvedValueOnce({ handle: HANDLE, offer: "signed.reply" }); await host.requestCredentials({ ...request, request: OPEN });
    enabled = false; native.request.mockResolvedValueOnce(true);
    await host.closeCredentials({ ...request, handle: HANDLE });
    expect(native.request).toHaveBeenLastCalledWith("closeHandle", { peer: "controller-a", handle: HANDLE });
  });
  it("keeps Linux credential-only locked metadata separate from capture and fails unavailable native dependencies closed", async () => {
    const native = nativeFixture(); let lock: "locked" | "unavailable" = "locked";
    const input = { start: vi.fn(), send: vi.fn(), stop: vi.fn(), release: async () => undefined, retire: async () => undefined };
    const host = new DesktopRemoteDesktopHost({ platform: "linux", systemAudio: false, enabled: () => true,
      sessionState: async () => "unsupported", displays: () => [{ id: "portal", name: "Shared screen", width: 1280, height: 720 }],
      permissions: async () => ({ screenRecording: "notRequired", accessibility: "notRequired" }), showPermissionGuide: async () => undefined,
      input, media: { frame: async () => null, offer: async () => "answer", exchangeIce: async request => ({ attemptId: request.attemptId, candidates: [], next: 0, complete: true }),
        setInputHandler: () => () => undefined, setPresentationPongHandler: () => () => undefined, setPresentation: vi.fn(), setSessionState: vi.fn(),
        setPrivacyExclusions: vi.fn(), preparePrivacy: async () => undefined, clearPrivacyExclusions: vi.fn(), stop: vi.fn(), retire: async () => undefined },
      credentials: { native: native.native, owner: OWNER, lockState: async () => lock }, changed: vi.fn()
    }); retiring.push(host);
    const request = { controllerDeviceId: "controller-a", signal: SIGNAL };
    expect(await host.getLockState(request)).toMatchObject({ state: RemoteDesktopLockState.LOCKED });
    expect(await host.getCapabilities(request)).toMatchObject({ enabled: true, nativeCredentials: true, canControl: false });
    await expect(host.start({ ...request, displayId: "portal", mode: 1 })).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.LOCKED_SESSION_UNSUPPORTED });
    expect(input.start).not.toHaveBeenCalled(); expect(host.state).toBeUndefined();
    lock = "unavailable";
    expect(await host.getLockState(request)).toMatchObject({ state: RemoteDesktopLockState.UNAVAILABLE });
    await expect(host.getCapabilities(request)).rejects.toMatchObject({ reason: RemoteDesktopFailureReason.LOCKED_SESSION_UNSUPPORTED });
  });
});
