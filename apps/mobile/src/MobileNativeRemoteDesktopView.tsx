import { requireNativeViewManager } from "expo-modules-core";
import { Platform, type ViewProps } from "react-native";
import type { Ref } from "react";
import { remotePresentation } from "../modules/joko-remote-presentation/src/index";
import type { MobileRemoteDesktopNativeHandle } from "./remote-desktop-native-bridge";

type Props = ViewProps & {
  readonly inlineVisible: boolean;
  readonly ref?: Ref<MobileRemoteDesktopNativeHandle>;
  readonly onMessage: (event: { readonly nativeEvent: { readonly data: string } }) => void;
};

/** The module's video capability names an actual registered native receiver view. */
export const MobileNativeRemoteDesktopView = Platform.OS === "ios" && remotePresentation?.nativeVideo === true
  ? requireNativeViewManager<Props>("JokoRemotePresentation") : null;
