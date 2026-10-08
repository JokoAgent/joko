import * as Clipboard from "expo-clipboard";
import { remotePresentation } from "../modules/joko-remote-presentation/src/index";
import { createMobileRemoteClipboardSystem } from "./mobile-remote-desktop-clipboard";

export const mobileRemoteClipboardSystem = createMobileRemoteClipboardSystem(
  remotePresentation,
  Clipboard
);
