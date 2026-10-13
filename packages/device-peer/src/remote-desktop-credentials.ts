import type { RemoteDesktopCredentialRequest, RemoteDesktopCredentialResult } from "@joko/contracts";

export const REMOTE_DESKTOP_CREDENTIAL_IDENTITY_BYTES = 4_096;
export const REMOTE_DESKTOP_CREDENTIAL_CIPHERTEXT_BYTES = 2 * 1_024 * 1_024;

export function isRemoteDesktopCredentialIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && new TextEncoder().encode(value).length <= REMOTE_DESKTOP_CREDENTIAL_IDENTITY_BYTES;
}

export function isRemoteDesktopCredentialOffer(value: unknown): value is string {
  return ascii(value, REMOTE_DESKTOP_CREDENTIAL_IDENTITY_BYTES);
}

export function isRemoteDesktopCredentialCiphertext(value: unknown): value is string {
  return ascii(value, REMOTE_DESKTOP_CREDENTIAL_CIPHERTEXT_BYTES);
}

export function isRemoteDesktopCredentialHandle(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isRemoteDesktopCredentialRequest(value: RemoteDesktopCredentialRequest): boolean {
  switch (value.request.case) {
    case "prepare": return true;
    case "open": return isRemoteDesktopCredentialOffer(value.request.value.offer)
      && (value.request.value.descriptor === undefined || isRemoteDesktopCredentialIdentity(value.request.value.descriptor));
    case "exchange": return isRemoteDesktopCredentialHandle(value.request.value.handle)
      && isRemoteDesktopCredentialCiphertext(value.request.value.ciphertext);
    default: return false;
  }
}

export function isRemoteDesktopCredentialResult(request: RemoteDesktopCredentialRequest,
  value: RemoteDesktopCredentialResult): boolean {
  switch (value.result.case) {
    case "prepared": return request.request.case === "prepare" && isRemoteDesktopCredentialIdentity(value.result.value.descriptor);
    case "opened": return request.request.case === "open" && isRemoteDesktopCredentialHandle(value.result.value.handle)
      && isRemoteDesktopCredentialOffer(value.result.value.offer);
    case "exchanged": return request.request.case === "exchange"
      && isRemoteDesktopCredentialCiphertext(value.result.value.ciphertext);
    case "closed": return request.request.case === "exchange";
    default: return false;
  }
}

function ascii(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && /^[\x21-\x7e]+$/.test(value);
}
