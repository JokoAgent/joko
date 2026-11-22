export type DesktopSpeakerStrength = "relaxed" | "standard" | "strict";
export type DesktopSpeakerNotice = "filtered" | "unavailable";

export interface DesktopSpeakerStatus {
  readonly supported: boolean;
  readonly modelsReady: boolean;
  readonly enrolled: boolean;
  readonly enabled: boolean;
  readonly strength?: DesktopSpeakerStrength;
}

export interface DesktopSpeakerPcm {
  readonly audio: Uint8Array;
  readonly durationMs: number;
  readonly voiced: boolean;
}

export interface DesktopSpeakerOutput {
  readonly chunks: readonly DesktopSpeakerPcm[];
  readonly notice?: DesktopSpeakerNotice;
}

export type DesktopSpeakerRun =
  | { readonly mode: "active"; readonly id: string }
  | { readonly mode: "disabled" | "unavailable" };

export type DesktopSpeakerEnrollment =
  | { readonly ok: true; readonly status: DesktopSpeakerStatus }
  | { readonly ok: false; readonly clipIndex?: number };

export interface DesktopSpeakerApi {
  status(profileId: string): Promise<DesktopSpeakerStatus>;
  download(profileId: string): Promise<DesktopSpeakerStatus>;
  enroll(profileId: string, clips: readonly Uint8Array[]): Promise<DesktopSpeakerEnrollment>;
  configure(profileId: string, change: { readonly enabled?: boolean; readonly strength?: DesktopSpeakerStrength | null }): Promise<DesktopSpeakerStatus>;
  remove(profileId: string): Promise<DesktopSpeakerStatus>;
  begin(profileId: string): Promise<DesktopSpeakerRun>;
  push(id: string, chunk: DesktopSpeakerPcm): Promise<DesktopSpeakerOutput>;
  finish(id: string): Promise<DesktopSpeakerOutput>;
  cancel(id: string): Promise<void>;
}
