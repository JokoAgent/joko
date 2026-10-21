import type { RemoteDesktopIceCandidate, RemoteDesktopIceServer, RemoteDesktopInput, RemoteDesktopJpegFrame } from "@joko/device-peer";
import type { DesktopRemoteDesktopVideoSettings } from "./remote-desktop-media-settings.js";
import type { DesktopRemoteDesktopNativeFrame } from "./remote-desktop-native-capture.js";
import type { DesktopRemoteDesktopVideoProfile } from "./remote-desktop-quality.js";

export const REMOTE_DESKTOP_CAPTURE_CHANNELS = Object.freeze({
  ready: "joko:remote-desktop-capture:ready",
  command: "joko:remote-desktop-capture:command",
  reply: "joko:remote-desktop-capture:reply",
  input: "joko:remote-desktop-capture:input",
  request: "joko:remote-desktop-capture:request",
  nativeFrame: "joko:remote-desktop-capture:native-frame",
  nativeAudio: "joko:remote-desktop-capture:native-audio",
  presentationPong: "joko:remote-desktop-capture:presentation-pong",
  stopped: "joko:remote-desktop-capture:stopped"
});

export const REMOTE_DESKTOP_AUDIO_RETRY_MS = [3_000, 10_000, 30_000] as const;

export type DesktopRemoteDesktopCaptureCommand =
  | {
      readonly op: "offer";
      readonly id: string;
      readonly leaseId: string;
      readonly attemptId: string;
      readonly offerSdp: string;
      readonly iceServers: readonly RemoteDesktopIceServer[];
      readonly iceExpiresAt?: number;
      readonly nativeCapture: boolean;
      readonly nativeVideo: boolean;
      readonly chromiumCapture: boolean;
      readonly portalCapture: boolean;
      readonly sourceRevision: number;
      readonly cursorOverlay: boolean;
      readonly profile: DesktopRemoteDesktopVideoProfile;
      readonly settings?: DesktopRemoteDesktopVideoSettings;
      readonly nativeAudio?: boolean;
      readonly audioRevision?: number;
    }
  | {
      readonly op: "nativeAudio";
      readonly leaseId: string;
      readonly attemptId: string;
      readonly audioRevision: number;
      readonly enabled: boolean;
    }
  | {
      readonly op: "captureReset";
      readonly leaseId: string;
      readonly attemptId: string;
      readonly sourceRevision: number;
      readonly resume: boolean;
    }
  | {
      readonly op: "preparePortal";
      readonly leaseId: string;
    }
  | {
      readonly op: "frame";
      readonly id: string;
      readonly leaseId: string;
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
      readonly op: "nativeSource";
      readonly id: string;
      readonly leaseId: string;
      readonly attemptId: string;
      readonly sourceRevision: number;
    }
  | {
      readonly op: "presentation";
      readonly leaseId: string;
      readonly enabled: boolean;
    }
  | { readonly op: "stop" };

export type DesktopRemoteDesktopCaptureReply =
  | { readonly kind: "frame"; readonly frame: RemoteDesktopJpegFrame | null }
  | { readonly kind: "offer"; readonly answerSdp: string }
  | { readonly kind: "nativeSource"; readonly sourceRevision: number }
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
