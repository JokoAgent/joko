import type { RemoteDesktopIceCandidate, RemoteDesktopInput } from "@joko/device-peer";
import type { DesktopRemoteDesktopVideoSettings } from "./remote-desktop-media-settings.js";
import type { DesktopRemoteDesktopNativeFrame } from "./remote-desktop-native-capture.js";
import type { DesktopRemoteDesktopVideoProfile } from "./remote-desktop-quality.js";

export const REMOTE_DESKTOP_CAPTURE_CHANNELS = Object.freeze({
  ready: "joko:remote-desktop-capture:ready",
  command: "joko:remote-desktop-capture:command",
  reply: "joko:remote-desktop-capture:reply",
  input: "joko:remote-desktop-capture:input",
  nativeFrame: "joko:remote-desktop-capture:native-frame",
  presentationPong: "joko:remote-desktop-capture:presentation-pong",
  stopped: "joko:remote-desktop-capture:stopped"
});

export type DesktopRemoteDesktopCaptureCommand =
  | {
      readonly op: "offer";
      readonly id: string;
      readonly leaseId: string;
      readonly attemptId: string;
      readonly offerSdp: string;
      readonly iceServers: readonly { readonly urls: string }[];
      readonly nativeCapture: boolean;
      readonly nativeVideo: boolean;
      readonly chromiumCapture: boolean;
      readonly cursorOverlay: boolean;
      readonly profile: DesktopRemoteDesktopVideoProfile;
      readonly settings?: DesktopRemoteDesktopVideoSettings;
    }
  | {
      readonly op: "ice";
      readonly id: string;
      readonly leaseId: string;
      readonly attemptId: string;
      readonly candidates: readonly RemoteDesktopIceCandidate[];
      readonly after: number;
    }
  | {
      readonly op: "presentation";
      readonly leaseId: string;
      readonly enabled: boolean;
    }
  | { readonly op: "stop" };

export type DesktopRemoteDesktopCaptureReply =
  | { readonly kind: "offer"; readonly answerSdp: string }
  | {
      readonly kind: "ice";
      readonly attemptId: string;
      readonly candidates: readonly RemoteDesktopIceCandidate[];
      readonly next: number;
      readonly complete: boolean;
    }
  | {
      readonly kind: "error";
      readonly code: "audio-unavailable" | "unavailable" | "stopped" | "timeout";
    };

export interface DesktopRemoteDesktopCaptureInput {
  readonly leaseId: string;
  readonly sequence: number;
  readonly events: readonly RemoteDesktopInput[];
}

export type DesktopRemoteDesktopCaptureNativeFrame = DesktopRemoteDesktopNativeFrame;
