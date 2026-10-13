import { create } from "@bufbuild/protobuf";
import {
  RemoteDesktopCredentialResultSchema,
  RemoteDesktopFailureReason,
  type RemoteDesktopCredentialRequest,
  type RemoteDesktopCredentialResult
} from "@joko/contracts";
import {
  DevicePeerRemoteDesktopHostError,
  isRemoteDesktopCredentialHandle,
  isRemoteDesktopCredentialIdentity,
  isRemoteDesktopCredentialOffer,
  isRemoteDesktopCredentialRequest,
  isRemoteDesktopCredentialResult
} from "@joko/device-peer";
import {
  DesktopRemoteCredentialsNativeError,
  type DesktopRemoteCredentialsNative,
  type DesktopRemoteCredentialsNativeOwner
} from "./remote-desktop-credentials-native.js";

export interface DesktopRemoteDesktopCredentialsDependencies {
  readonly native: Pick<DesktopRemoteCredentialsNative, "request" | "close">;
  readonly owner: DesktopRemoteCredentialsNativeOwner;
  current(): boolean;
  invalidated(): void;
  execute(peer: string, body: unknown, authenticationOwner: object, signal: AbortSignal): Promise<unknown>;
  now?(): number;
}

interface NativeOccurrence {
  readonly peer: string;
  readonly handle: string;
  owner?: object;
  session?: string;
  retired?: boolean;
  closing?: Promise<void>;
}

/** Route-owned coordinator. Passwords and private keys remain in the helper. */
export class DesktopRemoteDesktopCredentialsHost {
  readonly #dependencies: DesktopRemoteDesktopCredentialsDependencies;
  readonly #handles = new Map<string, NativeOccurrence>();
  readonly #owners = new WeakMap<object, NativeOccurrence>();
  #proofs: Readonly<Record<string, string>> = {};
  #validUntil = 0;
  #configured = false;
  #busy = false;
  #authorizing = false;
  #retired = false;
  #poll: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #closing: Promise<void> | undefined;

  constructor(dependencies: DesktopRemoteDesktopCredentialsDependencies) {
    this.#dependencies = dependencies;
  }

  authenticationSession(owner: object): string | null {
    const occurrence = this.#owners.get(owner);
    return !this.#retired && this.#dependencies.current() && this.#now() < this.#validUntil
      && occurrence !== undefined && this.#handles.get(occurrence.handle) === occurrence
      && occurrence.retired !== true
      && occurrence.owner === owner && occurrence.session !== undefined
      && this.#proofs[occurrence.peer] === occurrence.session ? occurrence.session : null;
  }

  async request(peer: string, request: RemoteDesktopCredentialRequest,
    signal: AbortSignal): Promise<RemoteDesktopCredentialResult> {
    this.#check(signal);
    if (!isRemoteDesktopCredentialRequest(request)) throw hostFailure(RemoteDesktopFailureReason.CREDENTIAL_INVALID_MESSAGE);
    if (this.#busy) throw hostFailure(RemoteDesktopFailureReason.BUSY, true);
    this.#busy = true;
    try {
      let result: RemoteDesktopCredentialResult;
      switch (request.request.case) {
        case "prepare": {
          this.#authorizing = true;
          const descriptor = await this.#dependencies.native.request("configure", {
            owner: this.#dependencies.owner
          }, { signal });
          this.#check(signal);
          if (!isRemoteDesktopCredentialIdentity(descriptor)) throw hostFailure(RemoteDesktopFailureReason.CREDENTIAL_INVALID_IDENTITY);
          this.#configured = true;
          this.#startPolling();
          result = create(RemoteDesktopCredentialResultSchema, { result: { case: "prepared", value: { descriptor } } });
          break;
        }
        case "open": {
          if (!this.#configured) throw hostFailure(RemoteDesktopFailureReason.CREDENTIAL_INVALID_IDENTITY);
          if (this.#handles.size >= 16) throw hostFailure(RemoteDesktopFailureReason.BUSY, true);
          this.#authorizing = true;
          const opened = await this.#dependencies.native.request("begin", {
            peer, offer: request.request.value.offer, descriptor: request.request.value.descriptor ?? ""
          }, { signal });
          if (!isRemoteDesktopCredentialHandle(opened.handle) || !isRemoteDesktopCredentialOffer(opened.offer)) {
            throw hostFailure(RemoteDesktopFailureReason.CREDENTIAL_INVALID_MESSAGE);
          }
          // Even a cancelled begin owns its returned handle until exact cleanup.
          const occurrence: NativeOccurrence = { peer, handle: opened.handle };
          this.#handles.set(opened.handle, occurrence);
          try { this.#check(signal); }
          catch (error) { await this.#closeHandle(occurrence); throw error; }
          result = create(RemoteDesktopCredentialResultSchema, { result: { case: "opened", value: opened } });
          break;
        }
        case "exchange": {
          const { handle, ciphertext } = request.request.value;
          const occurrence = this.#handles.get(handle);
          if (occurrence === undefined || occurrence.peer !== peer || occurrence.retired) throw hostFailure(RemoteDesktopFailureReason.CREDENTIAL_EXPIRED);
          const received = await this.#dependencies.native.request("receive", { peer, handle, ciphertext }, { signal });
          await this.#refresh(true);
          if (occurrence.retired) throw hostFailure(RemoteDesktopFailureReason.CREDENTIAL_EXPIRED);
          if (received.kind === "closed") {
            this.#handles.delete(handle);
            this.#dependencies.invalidated();
            this.#check(signal);
            result = create(RemoteDesktopCredentialResultSchema, { result: { case: "closed", value: {} } });
          } else if (received.kind === "reply") {
            this.#check(signal);
            result = create(RemoteDesktopCredentialResultSchema, { result: { case: "exchanged", value: { ciphertext: received.ciphertext } } });
          } else {
            this.#check(signal);
            if (received.authenticationSession !== this.#proofs[peer] || this.#now() >= this.#validUntil) {
              throw hostFailure(RemoteDesktopFailureReason.AUTHENTICATION_REQUIRED);
            }
            if (occurrence.session !== received.authenticationSession) {
              occurrence.owner = Object.freeze({});
              occurrence.session = received.authenticationSession;
              this.#owners.set(occurrence.owner, occurrence);
              this.#dependencies.invalidated();
            }
            const authenticationOwner = occurrence.owner!;
            let body: unknown;
            let success = true;
            try {
              if (received.body.length > 2 * 1_024 * 1_024) throw hostFailure(RemoteDesktopFailureReason.CREDENTIAL_INVALID_MESSAGE);
              body = await this.#dependencies.execute(peer, JSON.parse(received.body), authenticationOwner, signal);
              this.#check(signal);
              if (this.authenticationSession(authenticationOwner) === null) throw hostFailure(RemoteDesktopFailureReason.AUTHENTICATION_REQUIRED);
            } catch (error) {
              success = false;
              // Only typed ordinary failures are encrypted back. No OS text.
              body = { error: error instanceof DevicePeerRemoteDesktopHostError ? error.reason : RemoteDesktopFailureReason.CREDENTIAL_UNAVAILABLE };
            }
            this.#check(signal);
            if (occurrence.retired) throw hostFailure(RemoteDesktopFailureReason.CREDENTIAL_EXPIRED);
            const reply = await this.#dependencies.native.request("response", {
              peer, handle, requestId: received.id, body: JSON.stringify(body ?? null), success
            }, { signal });
            this.#check(signal);
            result = create(RemoteDesktopCredentialResultSchema, { result: { case: "exchanged", value: { ciphertext: reply } } });
          }
          break;
        }
        default: throw hostFailure(RemoteDesktopFailureReason.CREDENTIAL_INVALID_MESSAGE);
      }
      if (!isRemoteDesktopCredentialResult(request, result)) throw hostFailure(RemoteDesktopFailureReason.CREDENTIAL_INVALID_MESSAGE);
      return result;
    } catch (error) {
      if (error instanceof DesktopRemoteCredentialsNativeError
        && (error.code === "CREDENTIAL_OUTCOME_UNKNOWN" || error.code === "CREDENTIAL_UNAVAILABLE")) {
        this.#configured = false;
        this.#invalidate();
      }
      if (error instanceof DesktopRemoteCredentialsNativeError && error.code === "CREDENTIAL_OUTCOME_UNKNOWN") {
        throw translateNativeCredentialFailure(error);
      }
      if (signal.aborted) throw signal.reason ?? hostFailure(RemoteDesktopFailureReason.CREDENTIAL_CANCELLED);
      throw translateNativeCredentialFailure(error);
    } finally {
      this.#authorizing = false;
      this.#busy = false;
    }
  }

  retire(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#retired = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#invalidate();
    // close() resolves only after the captured helper actually exits.
    this.#closing = this.#dependencies.native.close().then(() => { this.#handles.clear(); });
    return this.#closing;
  }

  async closeHandle(peer: string, handle: string): Promise<void> {
    if (!isRemoteDesktopCredentialHandle(handle)) throw hostFailure(RemoteDesktopFailureReason.CREDENTIAL_INVALID_MESSAGE);
    const occurrence = this.#handles.get(handle);
    if (occurrence === undefined) return;
    if (occurrence.peer !== peer) throw hostFailure(RemoteDesktopFailureReason.CREDENTIAL_INVALID_IDENTITY);
    if (occurrence.closing !== undefined) return occurrence.closing;
    occurrence.retired = true;
    this.#dependencies.invalidated();
    const closing = this.#closeHandle(occurrence);
    occurrence.closing = closing;
    try { await closing; }
    finally { if (occurrence.closing === closing) occurrence.closing = undefined; }
  }

  async #closeHandle(occurrence: NativeOccurrence): Promise<void> {
    if (this.#retired) await this.#closing;
    else await this.#dependencies.native.request("closeHandle", { peer: occurrence.peer, handle: occurrence.handle });
    if (this.#handles.get(occurrence.handle) === occurrence) this.#handles.delete(occurrence.handle);
    this.#dependencies.invalidated();
  }

  #startPolling(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => { void this.#refresh().catch(() => this.#invalidate()); }, 1_000);
    this.#timer.unref?.();
  }

  async #refresh(force = false): Promise<void> {
    if (this.#retired || !this.#configured || this.#authorizing && !force) return;
    if (this.#poll !== undefined) {
      await this.#poll;
      if (!force || this.#retired) return;
    }
    const poll = (async () => {
      const proofs = await this.#dependencies.native.request("status", {});
      if (this.#retired || !this.#dependencies.current()) return;
      if (proofs === null || typeof proofs !== "object" || Array.isArray(proofs)
        || Object.entries(proofs).length > 8
        || Object.values(proofs).some((proof) => typeof proof !== "string" || proof.length === 0 || proof.length > 1_024)) {
        throw hostFailure(RemoteDesktopFailureReason.CREDENTIAL_INVALID_MESSAGE);
      }
      this.#proofs = Object.freeze({ ...proofs });
      this.#validUntil = this.#now() + 2_500;
      this.#dependencies.invalidated();
    })();
    this.#poll = poll;
    try { await poll; }
    catch (error) { this.#invalidate(); throw error; }
    finally { if (this.#poll === poll) this.#poll = undefined; }
  }

  #invalidate(): void {
    this.#proofs = {};
    this.#validUntil = 0;
    this.#dependencies.invalidated();
  }

  #check(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason ?? hostFailure(RemoteDesktopFailureReason.CREDENTIAL_CANCELLED);
    if (this.#retired || !this.#dependencies.current()) throw hostFailure(RemoteDesktopFailureReason.CREDENTIAL_EXPIRED);
  }

  #now(): number { return this.#dependencies.now?.() ?? performance.now(); }
}

export function translateNativeCredentialFailure(error: unknown): unknown {
  if (!(error instanceof DesktopRemoteCredentialsNativeError)) return error;
  switch (error.code) {
    case "CREDENTIAL_INVALID_MESSAGE": return hostFailure(RemoteDesktopFailureReason.CREDENTIAL_INVALID_MESSAGE);
    case "CREDENTIAL_INVALID_IDENTITY": return hostFailure(RemoteDesktopFailureReason.CREDENTIAL_INVALID_IDENTITY);
    case "CREDENTIAL_EXPIRED": return hostFailure(RemoteDesktopFailureReason.CREDENTIAL_EXPIRED);
    case "CREDENTIAL_CANCELLED": return hostFailure(RemoteDesktopFailureReason.CREDENTIAL_CANCELLED);
    case "CREDENTIAL_ACCESSIBILITY_REQUIRED": return hostFailure(RemoteDesktopFailureReason.ACCESSIBILITY_PERMISSION_REQUIRED);
    case "CREDENTIAL_UNLOCK_UNAVAILABLE": return hostFailure(RemoteDesktopFailureReason.CREDENTIAL_UNLOCK_UNAVAILABLE);
    case "CREDENTIAL_AUTHENTICATION_BUSY": return hostFailure(RemoteDesktopFailureReason.BUSY, true);
    case "CREDENTIAL_OUTCOME_UNKNOWN": return hostFailure(RemoteDesktopFailureReason.CREDENTIAL_OUTCOME_UNKNOWN);
    default: return hostFailure(RemoteDesktopFailureReason.CREDENTIAL_UNAVAILABLE);
  }
}

function hostFailure(reason: RemoteDesktopFailureReason, retryable = false): DevicePeerRemoteDesktopHostError {
  return new DevicePeerRemoteDesktopHostError(reason, retryable);
}
