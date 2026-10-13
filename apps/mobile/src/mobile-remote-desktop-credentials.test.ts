import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { RemoteDesktopCredentialResultSchema, RemoteDesktopFailureReason, RemoteDesktopFailureSchema, RemoteDesktopLockState } from "@joko/contracts";
import { MobileRemoteDesktopCredentials, type MobileRemoteDesktopCredentialScope } from "./mobile-remote-desktop-credentials";
import type { MobileRemoteDesktopCredentialsNative } from "./mobile-remote-desktop-credentials-native";

const HANDLE = "11111111-1111-4111-8111-111111111111";
function fixture(saved = false, platform = "darwin") {
  let autoUnlock = saved, biometricVerification = false, active = true, current = true, accepted = true;
  let lose: unknown;
  const settings = vi.fn(async () => ({ autoUnlock, biometricVerification, biometricAvailable: true, biometricPreferred: true }));
  const native: MobileRemoteDesktopCredentialsNative = {
    available: true, configure: vi.fn(async () => "public-controller"), settings,
    forget: vi.fn(async () => { autoUnlock = false; biometricVerification = false; }),
    biometric: vi.fn(async (_owner, _target, enabled) => { biometricVerification = enabled; }),
    begin: vi.fn(async () => ({ handle: HANDLE, offer: "controller-offer", descriptor: "public-controller" })),
    accept: vi.fn(async () => "ready-request"),
    receive: vi.fn(async (_handle, ciphertext) => {
      if (ciphertext === "ready") return JSON.stringify({ kind: "ready", saved: autoUnlock });
      if (accepted) autoUnlock = true;
      return JSON.stringify({ kind: "authenticated", accepted });
    }),
    password: vi.fn(async () => "password-ciphertext"), authenticationStatus: vi.fn(async () => "new-receipt-ciphertext"),
    end: vi.fn(async () => "revoke-ciphertext"), close: vi.fn(async () => undefined)
  };
  const remote = vi.fn<MobileRemoteDesktopCredentialScope["remote"]>(async request => {
    const action = request.request;
    if (action.case === "prepare") return create(RemoteDesktopCredentialResultSchema, { result: { case: "prepared", value: { descriptor: "public-host" } } });
    if (action.case === "open") return create(RemoteDesktopCredentialResultSchema, { result: { case: "opened", value: { handle: HANDLE, offer: "host-offer" } } });
    if (action.case !== "exchange") throw new Error("Unexpected request");
    if (action.value.ciphertext === "password-ciphertext" && lose) { const error = lose; lose = undefined; throw error; }
    return create(RemoteDesktopCredentialResultSchema, { result: action.value.ciphertext === "revoke-ciphertext" ? { case: "closed", value: {} }
      : { case: "exchanged", value: { ciphertext: action.value.ciphertext === "ready-request" ? "ready" : "authenticated" } } });
  });
  const scope: MobileRemoteDesktopCredentialScope = { key: "profile:server:phone:target", owner: { profileId: "profile", serverId: "server", deviceId: "phone" },
    target: "target", platform, capable: true, locale: "en", theme: "dark", active: () => active && current, current: () => current,
    lockState: vi.fn(async () => RemoteDesktopLockState.LOCKED), remote };
  const changed = vi.fn(); const owner = new MobileRemoteDesktopCredentials(native, changed); owner.bind(scope);
  return { owner, scope, native, remote, settings, changed, active: (value: boolean) => { active = value; },
    current: (value: boolean) => { current = value; }, lose: (error: unknown) => { lose = error; }, reject: () => { accepted = false; } };
}
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }

describe("iOS viewer native credentials", () => {
  it("waits for actual presentation, attempts once, and repeats only after an explicit connection attempt", async () => {
    const f = fixture(true); await flush(); expect(f.native.begin).not.toHaveBeenCalled();
    await f.owner.presented(); expect(f.native.password).toHaveBeenCalledOnce();
    await f.owner.presented(); f.owner.bind({ ...f.scope }); await f.owner.presented(); expect(f.native.password).toHaveBeenCalledOnce();
    f.owner.resetAttempt(); await f.owner.presented(); expect(f.native.password).toHaveBeenCalledTimes(2);
    expect(f.native.begin).toHaveBeenLastCalledWith("target", false, false, "public-host", "darwin");
    expect(f.native.password).toHaveBeenLastCalledWith(HANDLE, true, "en", "dark");
  });

  it("uses native storage confirmation and biometric preference, and supports disable with no host capability", async () => {
    const f = fixture(); await flush(); await f.owner.run("enable");
    expect(f.owner.snapshot).toMatchObject({ autoUnlock: true, biometricVerification: true, busy: false });
    expect(f.native.begin).toHaveBeenCalledWith("target", true, false, "public-host", "darwin");
    expect(f.native.biometric).toHaveBeenCalledWith(f.scope.owner, "target", true, "en");
    f.owner.bind({ ...f.scope, capable: false }); await f.owner.run("disable");
    expect(f.owner.snapshot).toMatchObject({ autoUnlock: false, biometricVerification: false });
    expect(f.native.forget).toHaveBeenCalledWith(f.scope.owner, "target");
  });

  it.each([new ConnectError("Lost receipt", Code.Unavailable), new ConnectError("Unknown native effect", Code.Aborted, undefined,
    [{ desc: RemoteDesktopFailureSchema, value: create(RemoteDesktopFailureSchema, { reason: RemoteDesktopFailureReason.CREDENTIAL_OUTCOME_UNKNOWN }) }])])(
    "queries a fresh native receipt after exactly one password reached Host", async error => {
      const f = fixture(true); await flush(); f.lose(error); await f.owner.presented();
      expect(f.native.password).toHaveBeenCalledOnce(); expect(f.native.authenticationStatus).toHaveBeenCalledOnce();
      const sent = f.remote.mock.calls.flatMap(([request]) => request.request.case === "exchange" ? [request.request.value.ciphertext] : []);
      expect(sent.filter(value => value === "password-ciphertext")).toHaveLength(1); expect(sent).toContain("new-receipt-ciphertext");
      expect(f.owner.snapshot).toMatchObject({ autoUnlock: true, busy: false, notice: undefined });
    });

  it("preserves an authorized Face ID inactive continuation, but closes the exact handle on background retirement", async () => {
    const f = fixture(true); await flush(); let password!: (value: string) => void;
    vi.mocked(f.native.password).mockImplementation(() => new Promise(resolve => { password = resolve; }));
    const pending = f.owner.presented(); await vi.waitFor(() => expect(password).toBeTypeOf("function"));
    f.active(false); password("password-ciphertext"); await pending;
    expect(f.owner.snapshot).toMatchObject({ autoUnlock: true, notice: undefined, busy: false });
    expect(f.native.close).toHaveBeenCalledWith(HANDLE);
    f.active(true); vi.mocked(f.native.close).mockClear(); f.owner.resetAttempt();
    const next = f.owner.presented(); await vi.waitFor(() => expect(f.native.password).toHaveBeenCalledTimes(2));
    f.current(false); f.owner.retire(); expect(f.native.close).toHaveBeenCalledWith(HANDLE);
    const requests = f.remote.mock.calls.length; password("password-ciphertext"); await next;
    expect(f.remote.mock.calls).toHaveLength(requests); expect(f.owner.snapshot).toMatchObject({ busy: false, notice: undefined });
  });

  it("keeps failed saved authentication visible and makes explicit Retry a native setup without automatic replay", async () => {
    const f = fixture(true); await flush(); f.reject(); await f.owner.presented();
    expect(f.owner.snapshot).toMatchObject({ notice: "password", explicitFailure: false, busy: false });
    await f.owner.presented(); expect(f.native.password).toHaveBeenCalledOnce();
    await f.owner.retry(); expect(f.native.begin).toHaveBeenLastCalledWith("target", true, false, "public-host", "darwin");
    expect(f.owner.snapshot).toMatchObject({ notice: "password", explicitFailure: true });
    expect(f.native.authenticationStatus).not.toHaveBeenCalled();
  });

  it("holds the operation slot through unknown preparation and does not send a stale target password", async () => {
    const f = fixture(); await flush(); let configured!: (value: string) => void;
    vi.mocked(f.native.configure).mockImplementation(() => new Promise(resolve => { configured = resolve; }));
    const pending = f.owner.run("enable"); await vi.waitFor(() => expect(configured).toBeTypeOf("function"));
    f.owner.retire(); f.owner.bind({ ...f.scope, key: "new-target", target: "new-target" });
    await f.owner.run("enable"); expect(f.native.configure).toHaveBeenCalledOnce();
    configured("public-controller"); await pending; expect(f.native.begin).not.toHaveBeenCalled();
    await f.owner.run("settings"); expect(f.native.settings).toHaveBeenLastCalledWith(f.scope.owner, "new-target");
  });

  it("unlocks Linux before capture once and passes its exact host platform to native account validation", async () => {
    const f = fixture(true, "linux"); await flush();
    const authenticated = vi.fn(async () => undefined); f.owner.bind({ ...f.scope, authenticated });
    await f.owner.presented(); expect(f.native.password).not.toHaveBeenCalled();
    expect(await f.owner.beforeCapture()).toBe(true);
    expect(f.native.begin).toHaveBeenCalledWith("target", false, false, "public-host", "linux");
    expect(f.scope.lockState).toHaveBeenCalledOnce(); expect(f.native.password).toHaveBeenCalledOnce();
    expect(authenticated).not.toHaveBeenCalled();
    expect(await f.owner.beforeCapture()).toBe(false); await f.owner.presented();
    expect(f.native.password).toHaveBeenCalledOnce();
    f.owner.resetAttempt(); expect(await f.owner.beforeCapture()).toBe(true);
    expect(f.native.password).toHaveBeenCalledTimes(2);
  });

  it("keeps missing Linux saved credentials visible and uses explicit Retry for native setup", async () => {
    const f = fixture(true, "linux"); await flush();
    vi.mocked(f.native.password).mockRejectedValueOnce(new Error("CREDENTIAL_SAVED_PASSWORD_MISSING"));
    expect(await f.owner.beforeCapture()).toBe(false);
    expect(f.owner.snapshot).toMatchObject({ notice: "password", explicitFailure: false, busy: false });
    expect(await f.owner.beforeCapture()).toBe(false); expect(f.native.password).toHaveBeenCalledOnce();
    await f.owner.retry(); expect(f.native.begin).toHaveBeenLastCalledWith("target", true, false, "public-host", "linux");
    expect(f.owner.snapshot).toMatchObject({ autoUnlock: true, notice: undefined });
  });

  it.each(["win32", "android", "ios", ""])("does not create a native credential session for %s", async platform => {
    const f = fixture(true, platform); await flush();
    await f.owner.run("enable"); await f.owner.presented(); expect(await f.owner.beforeCapture()).toBe(false);
    expect(f.owner.snapshot.available).toBe(false); expect(f.native.settings).not.toHaveBeenCalled();
    expect(f.native.begin).not.toHaveBeenCalled(); expect(f.remote).not.toHaveBeenCalled();
  });
});
