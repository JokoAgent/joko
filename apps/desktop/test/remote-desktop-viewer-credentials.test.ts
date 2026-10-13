import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { RemoteDesktopCredentialResultSchema, RemoteDesktopFailureReason, RemoteDesktopFailureSchema, RemoteDesktopLockState } from "@joko/contracts";
import { DesktopRemoteDesktopViewerCredentials, type DesktopViewerCredentialNative } from "../src/remote-desktop-viewer-credentials.js";

const HANDLE = "11111111-1111-4111-8111-111111111111";
function fixture(saved = false) {
  let autoUnlock = saved, biometric = false, accepted = true, confirmSave = true;
  let failure: unknown;
  const request = vi.fn(async (method: string) => {
    if (method === "viewerSettings") return { autoUnlock, biometricVerification: biometric, biometricAvailable: true, biometricPreferred: true };
    if (method === "viewerConfigure") return "public-controller";
    if (method === "viewerBegin") return { handle: HANDLE, offer: "controller-offer", descriptor: "public-controller" };
    if (method === "viewerAccept") return "ready-request";
    if (method === "viewerPassword") return "password-ciphertext";
    if (method === "viewerAuthenticationStatus") return "new-receipt-ciphertext";
    if (method === "viewerReceive") {
      const ciphertext = request.mock.calls.at(-1)?.[1] as { ciphertext: string } | undefined;
      if (ciphertext?.ciphertext === "ready") return JSON.stringify({ kind: "ready", saved: autoUnlock });
      if (accepted && confirmSave) autoUnlock = true;
      return JSON.stringify({ kind: "authenticated", accepted });
    }
    if (method === "viewerForget") { autoUnlock = false; biometric = false; return true; }
    if (method === "viewerBiometric") { biometric = true; return true; }
    if (method === "viewerEnd") return "revoke-ciphertext";
    throw new Error("Unexpected native method");
  }) as ReturnType<typeof vi.fn<(method: string, ...args: unknown[]) => Promise<unknown>>>;
  const close = vi.fn(async () => undefined);
  const native = { request, close } as unknown as DesktopViewerCredentialNative;
  const remote = vi.fn(async (input: Record<string, unknown>, check: () => void) => {
    check(); const action = input["request"] as { case: string; value: { ciphertext?: string } };
    if (action.case === "prepare") return create(RemoteDesktopCredentialResultSchema, { result: { case: "prepared", value: { descriptor: "public-host" } } });
    if (action.case === "open") return create(RemoteDesktopCredentialResultSchema, { result: { case: "opened", value: { handle: HANDLE, offer: "host-offer" } } });
    if (action.value.ciphertext === "password-ciphertext" && failure) { const error = failure; failure = undefined; throw error; }
    return create(RemoteDesktopCredentialResultSchema, { result: action.value.ciphertext === "revoke-ciphertext"
      ? { case: "closed", value: {} } : { case: "exchanged", value: { ciphertext: action.value.ciphertext === "ready-request" ? "ready" : "authenticated" } } });
  });
  const lockState = vi.fn(async () => RemoteDesktopLockState.LOCKED);
  const deps = { platform: "darwin", owner: { profileId: "local-profile", serverId: "server", deviceId: "controller",
    origin: "https://node.example", connectionGeneration: 1 }, target: "target", native, locale: () => "en", theme: () => "dark" as const, remote, lockState };
  const owner = new DesktopRemoteDesktopViewerCredentials(deps);
  const run = (action: "settings" | "enable" | "disable" | "unlock" | "biometric", enabled?: boolean) => owner.run("darwin", true, action, enabled, () => undefined);
  return { owner, deps, native, request, close, remote, lockState, run,
    fail: (error: unknown) => { failure = error; }, reject: () => { accepted = false; }, noSave: () => { confirmSave = false; } };
}

describe("Desktop native credential facade", () => {
  it("uses native confirmed settings, prepares both owners before begin, and revokes the private session", async () => {
    const f = fixture(); expect(await f.run("settings")).toMatchObject({ ok: true, state: { autoUnlock: false } });
    expect(await f.run("enable")).toMatchObject({ ok: true, state: { autoUnlock: true } });
    expect(f.request.mock.calls.find(call => call[0] === "viewerBegin")?.[1]).toMatchObject({ setup: true, biometric: true });
    expect(f.request.mock.calls.findIndex(call => call[0] === "viewerConfigure")).toBeLessThan(f.request.mock.calls.findIndex(call => call[0] === "viewerBegin"));
    expect(f.remote.mock.calls[0]?.[0]).toMatchObject({ request: { case: "prepare" } });
    expect(f.remote.mock.calls.at(-1)?.[0]).toMatchObject({ request: { case: "exchange", value: { ciphertext: "revoke-ciphertext" } } });
    expect(await f.run("disable")).toMatchObject({ ok: true, state: { autoUnlock: false, biometricVerification: false } });
    const fresh = fixture(); fresh.noSave(); expect(await fresh.run("enable")).toMatchObject({ ok: true, state: { autoUnlock: false } });
  });

  it.each([new ConnectError("Lost receipt", Code.DeadlineExceeded), new ConnectError("Unknown effect", Code.Aborted, undefined,
    [{ desc: RemoteDesktopFailureSchema, value: create(RemoteDesktopFailureSchema, { reason: RemoteDesktopFailureReason.CREDENTIAL_OUTCOME_UNKNOWN }) }])])(
    "queries the native receipt after one password reached Host and its ACK was lost", async error => {
      const f = fixture(true); f.fail(error);
      expect(await f.run("unlock")).toMatchObject({ ok: true, state: { autoUnlock: true } });
      expect(f.request.mock.calls.filter(call => call[0] === "viewerPassword")).toHaveLength(1);
      expect(f.request.mock.calls.filter(call => call[0] === "viewerAuthenticationStatus")).toHaveLength(1);
      const exchanges = f.remote.mock.calls.map(([input]) => input["request"] as { value: { ciphertext?: string } });
      expect(exchanges.filter(value => value.value.ciphertext === "password-ciphertext")).toHaveLength(1);
      expect(exchanges.some(value => value.value.ciphertext === "new-receipt-ciphertext")).toBe(true);
    });

  it("does not query or replay rejected authentication, and does not unlock an unlocked or unsupported host", async () => {
    const f = fixture(true); f.reject(); expect(await f.run("unlock")).toEqual({ ok: false, notice: "password" });
    expect(f.request.mock.calls.some(call => call[0] === "viewerAuthenticationStatus")).toBe(false);
    f.lockState.mockResolvedValue(RemoteDesktopLockState.UNLOCKED); f.request.mockClear(); await f.run("unlock");
    expect(f.request.mock.calls.some(call => call[0] === "viewerPassword")).toBe(false);
    expect(await new DesktopRemoteDesktopViewerCredentials({ ...f.deps, platform: "win32" }).run("darwin", true, "enable", undefined, () => undefined))
      .toMatchObject({ ok: true, state: { available: false, autoUnlock: false } });
  });

  it("waits for both preparation effects and holds busy while a retired native result remains unknown", async () => {
    const f = fixture(); let configured!: (value: string) => void;
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((method: string, ...args: unknown[]) => method === "viewerConfigure" ? new Promise(resolve => { configured = resolve; }) : original(method, ...args));
    const pending = f.run("enable"); await vi.waitFor(() => expect(configured).toBeTypeOf("function"));
    expect(await f.run("enable")).toEqual({ ok: false, notice: "busy" }); f.owner.retire();
    expect(await f.run("enable")).toEqual({ ok: false, notice: "busy" }); configured("public-controller");
    expect(await pending).toEqual({ ok: false, notice: "cancelled" });
    expect(f.request.mock.calls.some(call => call[0] === "viewerBegin")).toBe(false);
    expect(f.close).toHaveBeenCalledOnce();
    await expect(f.owner.run("darwin", true, "biometric", "identity", () => undefined)).rejects.toThrow("Invalid native credential action");
  });
});
