import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

export interface MobileHandheldSettings {
  readonly enabled: boolean;
  readonly voiceKey: number;
  readonly keyName: string;
  readonly secondary: boolean;
  readonly secondaryAvailable: boolean;
}

export type MobileHandheldVoiceKey = "tap" | "start" | "end" | "cancel";

interface MobileHandheldNative {
  read(): Promise<MobileHandheldSettings>;
  configure(enabled: boolean, voiceKey: number, secondary: boolean): Promise<MobileHandheldSettings>;
  captureKey(active: boolean): Promise<void>;
  addListener(event: "onVoiceKey", listener: (event: { phase: MobileHandheldVoiceKey }) => void): { remove(): void };
  addListener(event: "onKeyCaptured", listener: (event: { key: number }) => void): { remove(): void };
  addListener(event: "onDisplaysChanged", listener: (value: MobileHandheldSettings) => void): { remove(): void };
}

export function mobileHandheld(): MobileHandheldNative | null {
  if (Platform.OS !== "android") return null;
  try { return requireOptionalNativeModule<MobileHandheldNative>("JokoHandheld"); }
  catch { return null; }
}
