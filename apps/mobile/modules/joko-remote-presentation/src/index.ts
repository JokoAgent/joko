import { requireOptionalNativeModule } from "expo-modules-core";

export interface JokoRemotePresentationModule {
  readonly nativeVideo?: boolean;
  readonly windowLayoutAvailable?: boolean;
  rotate?(landscape: boolean): Promise<void>;
  readClipboard?(): Promise<string>;
  writeClipboard?(json: string): Promise<void>;
  clipboardVersion?(): Promise<string>;
  syncClipboard?(json: string, version: string): Promise<string>;
  playback?(enabled: boolean): Promise<void>;
}

export const remotePresentation = requireOptionalNativeModule<JokoRemotePresentationModule>(
  "JokoRemotePresentation"
);
