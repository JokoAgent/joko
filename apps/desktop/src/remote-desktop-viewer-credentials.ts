import { Code, ConnectError } from "@connectrpc/connect";
import { RemoteDesktopFailureReason, RemoteDesktopFailureSchema, RemoteDesktopLockState,
  type DesktopRemoteDesktopViewerCredentialAction, type DesktopRemoteDesktopViewerCredentialNotice,
  type DesktopRemoteDesktopViewerCredentialReply, type DesktopRemoteDesktopViewerCredentialState,
  type DesktopRemoteDesktopViewerOwner, type RemoteDesktopCredentialResult } from "@joko/contracts";
import type { DesktopRemoteCredentialsNative } from "./remote-desktop-credentials-native.js";

export type DesktopViewerCredentialNative = Pick<DesktopRemoteCredentialsNative, "request" | "close">;
const unavailable: DesktopRemoteDesktopViewerCredentialState = Object.freeze({
  available: false, autoUnlock: false, biometricVerification: false, biometricAvailable: false
});

/** Password entry, vault access and encryption belong to the native process. */
export class DesktopRemoteDesktopViewerCredentials {
  #revision = 0;
  #pending?: Promise<DesktopRemoteDesktopViewerCredentialReply>;
  #request?: AbortController;
  #closing: Promise<void> = Promise.resolve();
  constructor(private readonly deps: {
    readonly native?: DesktopViewerCredentialNative;
    readonly platform: string;
    readonly owner: DesktopRemoteDesktopViewerOwner;
    readonly target: string;
    readonly locale: () => string;
    readonly theme: () => "light" | "dark";
    readonly lockState: (check: () => void) => Promise<RemoteDesktopLockState>;
    readonly remote: (request: Record<string, unknown>, check: () => void) => Promise<RemoteDesktopCredentialResult>;
  }) {}

  async run(hostPlatform: string | undefined, capable: boolean, action: unknown, enabled: unknown,
    guard: () => void): Promise<DesktopRemoteDesktopViewerCredentialReply> {
    guard();
    if (!isAction(action) || (action === "biometric" ? typeof enabled !== "boolean" : enabled !== undefined)) {
      throw new TypeError("Invalid native credential action.");
    }
    if (this.deps.platform !== "darwin" || hostPlatform !== "darwin" || !this.deps.native) return { ok: true, state: unavailable, authenticated: false };
    if (this.#pending) return { ok: false, notice: "busy" };
    const revision = this.#revision, request = new AbortController();
    const check = (): void => { guard(); if (revision !== this.#revision || request.signal.aborted) throw new CredentialCancelled(); };
    const operation = this.execute(action, enabled as boolean | undefined, capable, request.signal, check)
      .catch((error: unknown): DesktopRemoteDesktopViewerCredentialReply => ({ ok: false, notice: credentialNotice(error) }));
    this.#request = request; this.#pending = operation;
    try { return await operation; }
    finally { if (this.#pending === operation) { this.#pending = undefined; this.#request = undefined; } }
  }

  retire(): void {
    this.#revision++; this.#request?.abort();
    const native = this.deps.native;
    if (native) this.#closing = this.#closing.catch(() => undefined).then(() => native.close());
  }

  private async execute(action: DesktopRemoteDesktopViewerCredentialAction, enabled: boolean | undefined,
    capable: boolean, signal: AbortSignal, check: () => void): Promise<DesktopRemoteDesktopViewerCredentialReply> {
    await this.#closing; check();
    const native = this.deps.native!, owner = { serverId: this.deps.owner.serverId,
      deviceId: this.deps.owner.deviceId, profileId: this.deps.owner.profileId }, target = this.deps.target;
    let preferred = true;
    const settings = async (): Promise<DesktopRemoteDesktopViewerCredentialState> => {
      check(); const value = await native.request("viewerSettings", { owner, target }, { signal }); check();
      if (!value || typeof value !== "object" || ![value.autoUnlock, value.biometricVerification, value.biometricAvailable, value.biometricPreferred].every(item => typeof item === "boolean")) {
        throw new Error("CREDENTIAL_INVALID_MESSAGE");
      }
      preferred = value.biometricPreferred;
      return { available: true, autoUnlock: value.autoUnlock, biometricVerification: value.biometricVerification, biometricAvailable: value.biometricAvailable };
    };
    if (action === "disable") { await native.request("viewerForget", { owner, target }, { signal }); check(); return { ok: true, state: await settings(), authenticated: false }; }
    if (action === "biometric") {
      await native.request("viewerBiometric", { owner, target, enabled: enabled!, locale: this.deps.locale() }, { signal }); check();
      return { ok: true, state: await settings(), authenticated: false };
    }
    const saved = await settings();
    if (action === "settings" || (action === "unlock" && !saved.autoUnlock)) return { ok: true, state: saved, authenticated: false };
    if (!capable) throw new Error("CREDENTIAL_UNAVAILABLE");
    if (action === "unlock") {
      const status = await this.deps.lockState(check); check();
      if (status === RemoteDesktopLockState.UNAVAILABLE) throw new Error("CREDENTIAL_UNLOCK_UNAVAILABLE");
      if (status !== RemoteDesktopLockState.LOCKED) return { ok: true, state: saved, authenticated: false };
    }
    let local: { handle: string; offer: string; descriptor: string } | undefined;
    let host: { handle: string; offer: string } | undefined;
    try {
      const [configured, preparation] = await Promise.allSettled([
        native.request("viewerConfigure", { owner }, { signal }),
        this.deps.remote({ request: { case: "prepare", value: {} } }, check)
      ]);
      check();
      if (configured.status === "rejected") throw configured.reason;
      if (preparation.status === "rejected") throw preparation.reason;
      const prepared = preparation.value.result;
      if (prepared.case !== "prepared" || !publicString(prepared.value.descriptor, 4096)) throw new Error("CREDENTIAL_INVALID_MESSAGE");
      local = await native.request("viewerBegin", { target, descriptor: prepared.value.descriptor,
        setup: action === "enable", biometric: action === "unlock" ? saved.biometricVerification : preferred && saved.biometricAvailable }, { signal });
      check();
      if (!local || !publicString(local.offer, 4096) || !publicString(local.descriptor, 4096) || !handle(local.handle)) throw new Error("CREDENTIAL_INVALID_MESSAGE");
      const opened = (await this.deps.remote({ request: { case: "open", value: { offer: local.offer, descriptor: local.descriptor } } }, check)).result;
      check();
      if (opened.case !== "opened" || !handle(opened.value.handle) || !publicString(opened.value.offer, 4096)) throw new Error("CREDENTIAL_INVALID_MESSAGE");
      host = opened.value;
      const exchange = async (ciphertext: string): Promise<{ kind?: string; saved?: boolean; accepted?: boolean }> => {
        check(); if (!cipher(ciphertext)) throw new Error("CREDENTIAL_INVALID_MESSAGE");
        const result = (await this.deps.remote({ request: { case: "exchange", value: { handle: host!.handle, ciphertext } } }, check)).result;
        check(); if (result.case !== "exchanged" || !cipher(result.value.ciphertext)) throw new Error("CREDENTIAL_INVALID_MESSAGE");
        const value: unknown = JSON.parse(await native.request("viewerReceive", { handle: local!.handle, ciphertext: result.value.ciphertext }, { signal })); check();
        if (!value || typeof value !== "object") throw new Error("CREDENTIAL_INVALID_MESSAGE");
        return { ...( "kind" in value && typeof value.kind === "string" ? { kind: value.kind } : {}),
          ...( "saved" in value && typeof value.saved === "boolean" ? { saved: value.saved } : {}),
          ...( "accepted" in value && typeof value.accepted === "boolean" ? { accepted: value.accepted } : {}) };
      };
      const ready = await exchange(await native.request("viewerAccept", { handle: local.handle, offer: host.offer }, { signal }));
      if (ready.kind !== "ready") throw new Error("CREDENTIAL_INVALID_MESSAGE");
      const password = await native.request("viewerPassword", { handle: local.handle, useSaved: action !== "enable" && ready.saved === true,
        locale: this.deps.locale(), theme: this.deps.theme() }, { signal }); check();
      let authenticated;
      try { authenticated = await exchange(password); }
      catch (error: unknown) {
        if (!uncertain(error)) throw error;
        check(); authenticated = await exchange(await native.request("viewerAuthenticationStatus", { handle: local.handle }, { signal }));
      }
      if (authenticated.kind !== "authenticated" || !authenticated.accepted) throw new Error("CREDENTIAL_PASSWORD_REJECTED");
      return { ok: true, state: await settings(), authenticated: true };
    } finally {
      if (local && !signal.aborted) {
        try {
          check(); const ciphertext = await native.request("viewerEnd", { handle: local.handle }, { signal }); check();
          if (ciphertext && host) await this.deps.remote({ request: { case: "exchange", value: { handle: host.handle, ciphertext } } }, check);
        } catch { /* Cleanup is scoped to the captured native handle. Ordinary viewing remains available. */ }
      }
    }
  }
}

class CredentialCancelled extends Error { constructor() { super("CREDENTIAL_CANCELLED"); } }
function isAction(value: unknown): value is DesktopRemoteDesktopViewerCredentialAction {
  return value === "settings" || value === "enable" || value === "disable" || value === "unlock" || value === "biometric";
}
function publicString(value: unknown, limit: number): value is string { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= limit; }
function handle(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value); }
function cipher(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 2 * 1024 * 1024 && /^[\x20-\x7e]+$/u.test(value); }
function uncertain(error: unknown): boolean {
  return error instanceof ConnectError && ([Code.DeadlineExceeded, Code.Unavailable, Code.Unknown].includes(error.code) ||
    error.findDetails(RemoteDesktopFailureSchema)[0]?.reason === RemoteDesktopFailureReason.CREDENTIAL_OUTCOME_UNKNOWN);
}
export function credentialNotice(error: unknown): DesktopRemoteDesktopViewerCredentialNotice {
  if (error instanceof ConnectError) {
    const reason = error.findDetails(RemoteDesktopFailureSchema)[0]?.reason;
    if (reason === RemoteDesktopFailureReason.CREDENTIAL_CANCELLED || error.code === Code.Canceled) return "cancelled";
    if (reason === RemoteDesktopFailureReason.CREDENTIAL_INVALID_IDENTITY) return "identity";
    if (reason === RemoteDesktopFailureReason.CREDENTIAL_EXPIRED) return "expired";
    if (error.code === Code.PermissionDenied) return "permission";
  }
  const code = error instanceof Error ? error.message : typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "CREDENTIAL_CANCELLED" || code === "CREDENTIAL_APPLICATION_INACTIVE") return "cancelled";
  if (code === "CREDENTIAL_PASSWORD_REJECTED") return "password";
  if (code === "CREDENTIAL_INVALID_IDENTITY" || code === "CREDENTIAL_SAVED_BINDING_CHANGED") return "identity";
  if (code === "CREDENTIAL_EXPIRED") return "expired";
  if (code === "CREDENTIAL_DEVELOPMENT_SIGNING_REQUIRED") return "signing";
  if (code === "CREDENTIAL_ACCESSIBILITY_REQUIRED") return "permission";
  if (code === "CREDENTIAL_AUTHENTICATION_BUSY") return "busy";
  return "unavailable";
}
