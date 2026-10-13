import { Platform } from "react-native";
import { remoteCredentials } from "../modules/joko-remote-credentials/src";

export interface MobileRemoteDesktopCredentialOwner {
  readonly serverId: string;
  readonly deviceId: string;
  readonly profileId: string;
}
export interface MobileRemoteDesktopCredentialSettings {
  readonly autoUnlock: boolean;
  readonly biometricVerification: boolean;
  readonly biometricAvailable: boolean;
  readonly biometricPreferred: boolean;
}
export interface MobileRemoteDesktopCredentialsNative {
  readonly available: boolean;
  configure(owner: MobileRemoteDesktopCredentialOwner): Promise<string>;
  settings(owner: MobileRemoteDesktopCredentialOwner, target: string): Promise<MobileRemoteDesktopCredentialSettings>;
  forget(owner: MobileRemoteDesktopCredentialOwner, target: string): Promise<void>;
  biometric(owner: MobileRemoteDesktopCredentialOwner, target: string, enabled: boolean, locale: string): Promise<void>;
  begin(target: string, setup: boolean, biometric: boolean, descriptor: string, hostPlatform: "darwin" | "linux"): Promise<{ readonly handle: string; readonly offer: string; readonly descriptor: string }>;
  accept(handle: string, offer: string): Promise<string>;
  receive(handle: string, ciphertext: string): Promise<string>;
  password(handle: string, saved: boolean, locale: string, theme: "light" | "dark"): Promise<string>;
  authenticationStatus(handle: string): Promise<string>;
  end(handle: string): Promise<string | null>;
  close(handle: string): Promise<void>;
}

export function createMobileRemoteDesktopCredentialsNative(): MobileRemoteDesktopCredentialsNative {
  const native = remoteCredentials;
  const available = Platform.OS === "ios" && native !== null && native !== undefined && [native.configure,
    native.savedUnlockSettings, native.beginUnlock, native.forgetSavedUnlock, native.setSavedUnlockBiometric,
    native.accept, native.receive, native.password, native.authenticationStatus, native.end, native.close].every(value => typeof value === "function");
  const required = (): NonNullable<typeof native> => {
    if (!available || !native) throw new Error("CREDENTIAL_UNAVAILABLE");
    return native;
  };
  return {
    available,
    configure: (owner) => required().configure(owner),
    settings: (owner, target) => required().savedUnlockSettings(owner, target),
    forget: (owner, target) => required().forgetSavedUnlock(owner, target),
    biometric: (owner, target, enabled, locale) => required().setSavedUnlockBiometric(owner, target, enabled, locale),
    begin: (target, setup, biometric, descriptor, hostPlatform) => required().beginUnlock(target, setup, biometric, descriptor, hostPlatform),
    accept: (handle, offer) => required().accept(handle, offer),
    receive: (handle, ciphertext) => required().receive(handle, ciphertext),
    password: (handle, saved, locale, theme) => required().password(handle, saved, locale, theme),
    authenticationStatus: (handle) => required().authenticationStatus(handle),
    end: (handle) => required().end(handle), close: (handle) => required().close(handle)
  };
}
