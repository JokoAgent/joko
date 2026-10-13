import { requireOptionalNativeModule } from "expo-modules-core";

export interface JokoRemoteCredentialsOwner {
  readonly serverId: string;
  readonly deviceId: string;
  readonly profileId: string;
}
export interface JokoRemoteCredentialsSettings {
  readonly autoUnlock: boolean;
  readonly biometricVerification: boolean;
  readonly biometricAvailable: boolean;
  readonly biometricPreferred: boolean;
}
/** Password entry and vault retrieval remain native; only public identity and encrypted packets cross this bridge. */
export interface JokoRemoteCredentialsNative {
  configure(owner: JokoRemoteCredentialsOwner): Promise<string>;
  savedUnlockSettings(owner: JokoRemoteCredentialsOwner, target: string): Promise<JokoRemoteCredentialsSettings>;
  forgetSavedUnlock(owner: JokoRemoteCredentialsOwner, target: string): Promise<void>;
  setSavedUnlockBiometric(owner: JokoRemoteCredentialsOwner, target: string, enabled: boolean, locale: string): Promise<void>;
  beginUnlock(target: string, setup: boolean, biometric: boolean, descriptor: string, hostPlatform: "darwin" | "linux"): Promise<{ handle: string; offer: string; descriptor: string }>;
  accept(handle: string, offer: string): Promise<string>;
  receive(handle: string, ciphertext: string): Promise<string>;
  password(handle: string, useSaved: boolean, locale: string, theme: "light" | "dark"): Promise<string>;
  authenticationStatus(handle: string): Promise<string>;
  request(handle: string, body: string): Promise<{ id: string; ciphertext: string }>;
  abandonRequest(handle: string, id: string): Promise<void>;
  end(handle: string): Promise<string | null>;
  close(handle: string): Promise<void>;
  reset(): Promise<void>;
  addListener(event: "invalidated", listener: (event: { handle: string }) => void): { remove(): void };
}
export const remoteCredentials = requireOptionalNativeModule<JokoRemoteCredentialsNative>("JokoRemoteCredentials");
