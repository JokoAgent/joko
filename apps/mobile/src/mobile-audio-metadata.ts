import { create } from "@bufbuild/protobuf";
import { AudioArtifactKind, BlobRefSchema, type AudioArtifactMetadata, type BlobRef } from "@joko/contracts";

export const MOBILE_AUDIO_ARTWORK_MAXIMUM_BYTES = 8 * 1024 * 1024;
export const MOBILE_AUDIO_ARTWORK_MAXIMUM_PIXELS = 40_000_000;

/** Metadata stays with its canonical Artifact occurrence, never with shared bytes. */
export interface MobileAudioMetadataView {
  readonly kind: "generic" | "music" | "sound_effect";
  readonly title: string;
  readonly description: string;
  readonly durationSeconds?: number;
  readonly artwork?: {
    readonly blob: BlobRef;
    readonly width: number;
    readonly height: number;
    readonly alt: string;
  };
}

/** Maps the current public shape without inferring tags or truncating its content. */
export function mapMobileAudioMetadata(audio: AudioArtifactMetadata | undefined): MobileAudioMetadataView | undefined {
  if (audio === undefined) return undefined;
  const kind = audio.kind === AudioArtifactKind.GENERIC ? "generic"
    : audio.kind === AudioArtifactKind.MUSIC ? "music"
      : audio.kind === AudioArtifactKind.SOUND_EFFECT ? "sound_effect" : undefined;
  if (kind === undefined || !validText(audio.title, 4 * 1024) || !validText(audio.description, 64 * 1024)
    || audio.durationSeconds !== undefined && (!positiveDuration(audio.durationSeconds) || audio.durationSeconds > 86_400)) {
    throw invalidMetadata();
  }
  const artwork = audio.artwork;
  if (artwork !== undefined) {
    const blob = artwork.blob;
    if (blob === undefined || !validText(blob.blobId, 4_096) || blob.blobId === ""
      || !/^[a-f0-9]{64}$/u.test(blob.sha256Hex) || blob.byteSize <= 0n
      || blob.byteSize > BigInt(MOBILE_AUDIO_ARTWORK_MAXIMUM_BYTES)
      || !["image/png", "image/jpeg", "image/webp"].includes(blob.mediaType)
      || !validText(blob.fileName, 4_096) || !Number.isSafeInteger(artwork.widthPixels) || artwork.widthPixels <= 0
      || !Number.isSafeInteger(artwork.heightPixels) || artwork.heightPixels <= 0
      || artwork.widthPixels * artwork.heightPixels > MOBILE_AUDIO_ARTWORK_MAXIMUM_PIXELS
      || !validText(artwork.altText, 4 * 1024)) throw invalidMetadata();
  }
  return {
    kind, title: audio.title, description: audio.description,
    ...(audio.durationSeconds === undefined ? {} : { durationSeconds: audio.durationSeconds }),
    ...(artwork?.blob === undefined ? {} : { artwork: {
      blob: create(BlobRefSchema, {
        blobId: artwork.blob.blobId, sha256Hex: artwork.blob.sha256Hex, byteSize: artwork.blob.byteSize,
        mediaType: artwork.blob.mediaType, fileName: artwork.blob.fileName
      }),
      width: artwork.widthPixels, height: artwork.heightPixels, alt: artwork.altText
    } })
  };
}

/** Includes the full metadata and independent cover identity for source retirement. */
export function mobileAudioMetadataSourceKey(metadata: MobileAudioMetadataView | undefined): string {
  if (metadata === undefined) return "null";
  const artwork = metadata.artwork;
  return JSON.stringify([metadata.kind, metadata.title, metadata.description, metadata.durationSeconds ?? null,
    artwork === undefined ? null : [artwork.blob.blobId, artwork.blob.sha256Hex, artwork.blob.byteSize.toString(10),
      artwork.blob.mediaType, artwork.blob.fileName, artwork.width, artwork.height, artwork.alt]]);
}

/** Unloaded zero/unknown duration cannot replace a positive canonical hint. */
export function mobileAudioMetadataDuration(metadata: MobileAudioMetadataView | undefined, actualDuration?: number | null): number | undefined {
  return positiveDuration(actualDuration) ? actualDuration : metadata?.durationSeconds;
}

function positiveDuration(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validText(value: string, maximumBytes: number): boolean {
  return typeof value === "string" && !value.includes("\0") && new TextEncoder().encode(value).byteLength <= maximumBytes;
}

function invalidMetadata(): Error { return new Error("The canonical audio Artifact metadata is invalid."); }
