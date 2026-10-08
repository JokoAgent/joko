import { requireOptionalNativeModule } from "expo-modules-core";

export interface JokoRemotePresentationModule {
  readClipboard?(): Promise<string>;
  writeClipboard?(json: string): Promise<void>;
}

export const remotePresentation = requireOptionalNativeModule<JokoRemotePresentationModule>(
  "JokoRemotePresentation"
);
