import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { RemoteDesktopCredentialRequestSchema, RemoteDesktopFailureReason, RemoteDesktopFailureSchema, RemoteDesktopLockState,
  type RemoteDesktopCredentialRequest, type RemoteDesktopCredentialResult } from "@joko/contracts";
import type { MobileRemoteDesktopCredentialOwner, MobileRemoteDesktopCredentialsNative } from "./mobile-remote-desktop-credentials-native";

export type MobileRemoteDesktopCredentialNotice = "unavailable" | "signing" | "password" | "identity" | "permission" | "expired" | "busy";
export type MobileRemoteDesktopCredentialAction = "settings" | "enable" | "disable" | "unlock" | "biometric";
export interface MobileRemoteDesktopCredentialSnapshot {
  readonly available: boolean;
  readonly autoUnlock: boolean;
  readonly biometricVerification: boolean;
  readonly biometricAvailable: boolean;
  readonly busy: boolean;
  readonly notice?: MobileRemoteDesktopCredentialNotice;
  readonly explicitFailure: boolean;
}
export interface MobileRemoteDesktopCredentialScope {
  readonly key: string;
  readonly owner: MobileRemoteDesktopCredentialOwner;
  readonly target: string;
  readonly platform: string;
  readonly capable: boolean;
  readonly locale: string;
  readonly theme: "light" | "dark";
  active(): boolean;
  current(): boolean;
  lockState(signal: AbortSignal): Promise<RemoteDesktopLockState>;
  remote(request: RemoteDesktopCredentialRequest, signal?: AbortSignal): Promise<RemoteDesktopCredentialResult>;
  authenticated?(): Promise<void>;
}
export const mobileCredentialDefaults: MobileRemoteDesktopCredentialSnapshot = Object.freeze({ available: false,
  autoUnlock: false, biometricVerification: false, biometricAvailable: false, busy: false, explicitFailure: false });

/** Security sessions survive media retries and authorized biometric inactive continuations. */
export class MobileRemoteDesktopCredentials {
  #scope?: MobileRemoteDesktopCredentialScope;
  #snapshot = mobileCredentialDefaults;
  #epoch = 0;
  #pending?: Promise<boolean>;
  #request?: AbortController;
  #local?: { readonly handle: string; readonly epoch: number };
  #presented = false;
  #retry?: { readonly action: MobileRemoteDesktopCredentialAction; readonly enabled?: boolean };
  constructor(private readonly native: MobileRemoteDesktopCredentialsNative,
    private readonly changed: (snapshot: MobileRemoteDesktopCredentialSnapshot) => void) {}
  get snapshot(): MobileRemoteDesktopCredentialSnapshot { return this.#snapshot; }
  private publish(patch: Partial<MobileRemoteDesktopCredentialSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch }; this.changed(this.#snapshot);
  }
  bind(scope: MobileRemoteDesktopCredentialScope): void {
    if (this.#scope?.key === scope.key) { this.#scope = scope; return; }
    this.retire(); this.#scope = scope; this.#presented = false;
    this.#snapshot = mobileCredentialDefaults;
    this.publish({ available: this.native.available && supportedCredentialHost(scope.platform) });
    if (this.#snapshot.available && scope.active()) void this.run("settings");
  }
  resetAttempt(): void { this.#presented = false; }
  async presented(): Promise<void> {
    if (this.#scope?.platform !== "darwin") return;
    await this.attemptUnlock(true);
  }
  async beforeCapture(): Promise<boolean> {
    if (this.#scope?.platform !== "linux") return false;
    return this.attemptUnlock(false);
  }
  private async attemptUnlock(notifyAuthenticated: boolean): Promise<boolean> {
    const scope = this.#scope, epoch = this.#epoch;
    if (this.#presented || !scope || !scope.active()) return false;
    this.#presented = true;
    await this.#pending;
    if (epoch !== this.#epoch || this.#scope?.key !== scope.key || !scope.active()) return false;
    return this.perform("unlock", undefined, notifyAuthenticated);
  }
  retry(): Promise<void> {
    const retry = this.#retry;
    return retry ? this.run(retry.action, retry.enabled) : Promise.resolve();
  }
  async run(action: MobileRemoteDesktopCredentialAction, enabled?: boolean): Promise<void> {
    await this.perform(action, enabled, true);
  }
  private async perform(action: MobileRemoteDesktopCredentialAction, enabled: boolean | undefined,
    notifyAuthenticated: boolean): Promise<boolean> {
    const scope = this.#scope;
    if (!scope || !scope.active() || !this.native.available || !supportedCredentialHost(scope.platform)) return false;
    if (this.#pending) return false;
    const epoch = this.#epoch, request = new AbortController();
    const current = (): boolean => epoch === this.#epoch && this.#scope?.key === scope.key && scope.current() && !request.signal.aborted;
    const check = (): void => { if (!current()) throw new Error("CREDENTIAL_CANCELLED"); };
    this.#retry = { action, ...(enabled === undefined ? {} : { enabled }) };
    this.publish({ busy: true, notice: undefined, explicitFailure: false });
    const operation = this.execute(scope, action, enabled, request.signal, check).then(async authenticated => {
      if (authenticated && current()) {
        this.#presented = true;
        if (notifyAuthenticated) await scope.authenticated?.();
        return true;
      }
      return false;
    }).catch((error: unknown) => {
      if (!current()) return false;
      const notice = credentialFailure(error);
      if (notice === undefined) return false;
      if (action === "unlock" && notice === "password") this.#retry = { action: "enable" };
      this.publish({ notice, explicitFailure: action !== "unlock" && action !== "settings" });
      return false;
    }).finally(() => {
      if (this.#pending === operation) { this.#pending = undefined; this.#request = undefined; }
      if (current()) this.publish({ busy: false });
    });
    this.#request = request; this.#pending = operation;
    return operation;
  }
  retire(): void {
    this.#epoch++; this.#request?.abort(); this.#scope = undefined; this.#retry = undefined;
    const local = this.#local; this.#local = undefined;
    if (local) void this.native.close(local.handle).catch(() => undefined);
    this.publish({ busy: false, notice: undefined, explicitFailure: false });
  }

  private async execute(scope: MobileRemoteDesktopCredentialScope, action: MobileRemoteDesktopCredentialAction,
    enabled: boolean | undefined, signal: AbortSignal, check: () => void): Promise<boolean> {
    const { owner, target } = scope, native = this.native;
    const settings = async () => {
      check(); const value = await native.settings(owner, target); check();
      if (![value.autoUnlock, value.biometricVerification, value.biometricAvailable, value.biometricPreferred].every(item => typeof item === "boolean")) {
        throw new Error("CREDENTIAL_INVALID_MESSAGE");
      }
      this.publish({ available: true, autoUnlock: value.autoUnlock, biometricVerification: value.biometricVerification,
        biometricAvailable: value.biometricAvailable });
      return value;
    };
    if (action === "disable") { await native.forget(owner, target); check(); await settings(); this.#retry = undefined; return false; }
    if (action === "biometric") {
      if (typeof enabled !== "boolean") throw new Error("CREDENTIAL_INVALID_MESSAGE");
      await native.biometric(owner, target, enabled, scope.locale); check(); await settings(); this.#retry = undefined; return false;
    }
    const saved = await settings();
    if (action === "settings" || (action === "unlock" && !saved.autoUnlock)) { this.#retry = undefined; return false; }
    if (!scope.capable) throw new Error("CREDENTIAL_UNAVAILABLE");
    if (action === "unlock") {
      const status = await scope.lockState(signal); check();
      if (status === RemoteDesktopLockState.UNAVAILABLE) throw new Error("CREDENTIAL_UNLOCK_UNAVAILABLE");
      if (status !== RemoteDesktopLockState.LOCKED) { this.#retry = undefined; return false; }
    }
    let local: { readonly handle: string; readonly offer: string; readonly descriptor: string } | undefined;
    let host: { readonly handle: string; readonly offer: string } | undefined;
    const remote = async (request: RemoteDesktopCredentialRequest) => { check(); const value = await scope.remote(request, signal); check(); return value.result; };
    try {
      const [configuration, preparation] = await Promise.allSettled([
        native.configure(owner), remote(create(RemoteDesktopCredentialRequestSchema, { request: { case: "prepare", value: {} } }))
      ]);
      check();
      if (configuration.status === "rejected") throw configuration.reason;
      if (preparation.status === "rejected") throw preparation.reason;
      const prepared = preparation.value;
      if (prepared.case !== "prepared" || !publicText(prepared.value.descriptor)) throw new Error("CREDENTIAL_INVALID_MESSAGE");
      if (!supportedCredentialHost(scope.platform)) throw new Error("CREDENTIAL_INVALID_IDENTITY");
      local = await native.begin(target, action === "enable", action === "unlock" ? saved.biometricVerification : false, prepared.value.descriptor, scope.platform);
      check();
      if (!validHandle(local.handle) || !publicText(local.offer) || !publicText(local.descriptor)) throw new Error("CREDENTIAL_INVALID_MESSAGE");
      this.#local = { handle: local.handle, epoch: this.#epoch };
      const opened = await remote(create(RemoteDesktopCredentialRequestSchema, { request: { case: "open", value: { offer: local.offer, descriptor: local.descriptor } } }));
      if (opened.case !== "opened" || !validHandle(opened.value.handle) || !publicText(opened.value.offer)) throw new Error("CREDENTIAL_INVALID_MESSAGE");
      host = opened.value;
      const exchange = async (ciphertext: string): Promise<{ readonly kind?: string; readonly saved?: boolean; readonly accepted?: boolean }> => {
        if (!ciphertextValid(ciphertext)) throw new Error("CREDENTIAL_INVALID_MESSAGE");
        const exchanged = await remote(create(RemoteDesktopCredentialRequestSchema, { request: { case: "exchange", value: { handle: host!.handle, ciphertext } } }));
        if (exchanged.case !== "exchanged" || !ciphertextValid(exchanged.value.ciphertext)) throw new Error("CREDENTIAL_INVALID_MESSAGE");
        const value: unknown = JSON.parse(await native.receive(local!.handle, exchanged.value.ciphertext)); check();
        if (!value || typeof value !== "object") throw new Error("CREDENTIAL_INVALID_MESSAGE");
        return { ...( "kind" in value && typeof value.kind === "string" ? { kind: value.kind } : {}),
          ...( "saved" in value && typeof value.saved === "boolean" ? { saved: value.saved } : {}),
          ...( "accepted" in value && typeof value.accepted === "boolean" ? { accepted: value.accepted } : {}) };
      };
      const ready = await exchange(await native.accept(local.handle, host.offer));
      if (ready.kind !== "ready") throw new Error("CREDENTIAL_INVALID_MESSAGE");
      const password = await native.password(local.handle, action !== "enable" && ready.saved === true, scope.locale, scope.theme); check();
      let authenticated;
      try { authenticated = await exchange(password); }
      catch (error: unknown) {
        if (!(error instanceof ConnectError) || (![Code.DeadlineExceeded, Code.Unavailable, Code.Unknown].includes(error.code) &&
          error.findDetails(RemoteDesktopFailureSchema)[0]?.reason !== RemoteDesktopFailureReason.CREDENTIAL_OUTCOME_UNKNOWN)) throw error;
        check(); authenticated = await exchange(await native.authenticationStatus(local.handle));
      }
      if (authenticated.kind !== "authenticated" || !authenticated.accepted) throw new Error("CREDENTIAL_PASSWORD_REJECTED");
      const confirmed = await settings();
      if (action === "enable" && saved.biometricPreferred && confirmed.autoUnlock && !confirmed.biometricVerification && confirmed.biometricAvailable) {
        await native.biometric(owner, target, true, scope.locale); check(); await settings();
      }
      this.#retry = undefined;
      return true;
    } finally {
      if (local) {
        try {
          if (!signal.aborted) {
            check(); const ciphertext = await native.end(local.handle); check();
            if (ciphertext && host) await remote(create(RemoteDesktopCredentialRequestSchema, { request: { case: "exchange", value: { handle: host.handle, ciphertext } } }));
          }
        } catch { /* Optional native authentication does not retire ordinary paired viewing. */ }
        finally { await native.close(local.handle).catch(() => undefined); if (this.#local?.handle === local.handle) this.#local = undefined; }
      }
    }
  }
}
export function supportedCredentialHost(platform: string | undefined): platform is "darwin" | "linux" {
  return platform === "darwin" || platform === "linux";
}
function publicText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= 4096; }
function validHandle(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value); }
function ciphertextValid(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 2 * 1024 * 1024 && /^[\x20-\x7e]+$/u.test(value); }
function credentialFailure(error: unknown): MobileRemoteDesktopCredentialNotice | undefined {
  if (error instanceof ConnectError) {
    const reason = error.findDetails(RemoteDesktopFailureSchema)[0]?.reason;
    if (reason === RemoteDesktopFailureReason.CREDENTIAL_CANCELLED || error.code === Code.Canceled) return undefined;
    if (reason === RemoteDesktopFailureReason.CREDENTIAL_INVALID_IDENTITY) return "identity";
    if (reason === RemoteDesktopFailureReason.CREDENTIAL_EXPIRED) return "expired";
    if (error.code === Code.PermissionDenied) return "permission";
  }
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : error instanceof Error ? error.message : undefined;
  if (code === "CREDENTIAL_CANCELLED" || code === "CREDENTIAL_APPLICATION_INACTIVE") return undefined;
  if (code === "CREDENTIAL_PASSWORD_REJECTED" || code === "CREDENTIAL_SAVED_PASSWORD_MISSING") return "password";
  if (code === "CREDENTIAL_INVALID_IDENTITY" || code === "CREDENTIAL_SAVED_BINDING_CHANGED") return "identity";
  if (code === "CREDENTIAL_EXPIRED") return "expired";
  if (code === "CREDENTIAL_DEVELOPMENT_SIGNING_REQUIRED") return "signing";
  if (code === "CREDENTIAL_ACCESSIBILITY_REQUIRED") return "permission";
  if (code === "CREDENTIAL_AUTHENTICATION_BUSY") return "busy";
  return "unavailable";
}
