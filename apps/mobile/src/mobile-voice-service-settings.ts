import { VoiceInputTranscriptionProtocol, projectVoiceInputSaucSettings, type VoiceInputServiceSettings,
  type VoiceInputServiceSettingsPatch, type TestVoiceInputConnectionResponse } from "@joko/contracts";
import type { MobileVoiceCapability } from "./mobile-voice-input";

export interface MobileVoiceSettingsTransport {
  readonly ownerKey: string;
  isCurrent(): boolean;
  get(signal?: AbortSignal): Promise<VoiceInputServiceSettings>;
  getCapabilities(signal?: AbortSignal): Promise<MobileVoiceCapability>;
  save(patch: VoiceInputServiceSettingsPatch, secrets?: { readonly primary?: string; readonly fallback?: string }, signal?: AbortSignal): Promise<VoiceInputServiceSettings>;
  test(signal?: AbortSignal): Promise<TestVoiceInputConnectionResponse>;
  reconcile(signal?: AbortSignal): Promise<void>;
  hasPending(): boolean;
}

export function assertMobileVoiceServiceSettings(value: VoiceInputServiceSettings | undefined): VoiceInputServiceSettings {
  if (!value?.version?.revision || value.version.revision.value < 1n) throw new Error("The voice service returned no current configuration.");
  for (const [protocol, sauc] of [[value.protocol, value.sauc], [value.fallbackProtocol, value.fallbackSauc]] as const) {
    if (!Object.values(VoiceInputTranscriptionProtocol).includes(protocol) || protocol === VoiceInputTranscriptionProtocol.UNSPECIFIED) {
      throw new Error("The voice service returned an invalid protocol.");
    }
    if (protocol === VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC && projectVoiceInputSaucSettings(sauc) === undefined) {
      throw new Error("The voice service returned incomplete SAUC settings.");
    }
    if (protocol !== VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC && sauc !== undefined) throw new Error("The voice service returned unrelated SAUC settings.");
  }
  return value;
}

export function mobileVoiceCredentialBindingChanged(before: VoiceInputServiceSettings, patch: VoiceInputServiceSettingsPatch, fallback: boolean): boolean {
  const protocol = fallback ? before.fallbackProtocol : before.protocol;
  const nextProtocol = (fallback ? patch.fallbackProtocol : patch.protocol) ?? protocol;
  const endpoint = fallback ? before.fallbackEndpoint : before.endpoint;
  const nextEndpoint = (fallback ? patch.fallbackEndpoint : patch.endpoint) ?? endpoint;
  const origin = (value: string): string => { try { return new URL(value).origin === "null" ? new URL(value).host + new URL(value).protocol : new URL(value).origin; } catch { return value; } };
  const sauc = fallback ? before.fallbackSauc : before.sauc;
  const nextSauc = (fallback ? patch.fallbackSauc : patch.sauc) ?? sauc;
  return protocol !== nextProtocol || origin(endpoint) !== origin(nextEndpoint)
    || sauc?.authentication !== nextSauc?.authentication || sauc?.appId !== nextSauc?.appId;
}
