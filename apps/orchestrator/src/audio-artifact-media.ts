import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { AUDIO_ARTWORK_MAXIMUM_BYTES, AUDIO_ARTWORK_MAXIMUM_PIXELS } from "@joko/core";

/** Signature inspection is bounded; native playback remains the audio decoder. */
export async function inspectAudioArtifact(bytes: Uint8Array, mimeType: string): Promise<{ mime: string; ext: string }> {
  const detected = await fileTypeFromBuffer(bytes.subarray(0, 65_536)).catch(() => undefined);
  if (detected === undefined || detected.mime !== mimeType || !detected.mime.startsWith("audio/")) {
    throw new Error("Audio Artifact media does not match its declared type.");
  }
  return detected;
}

export async function decodeAudioArtwork(bytes: Uint8Array, mimeType: string): Promise<{ width: number; height: number; format: string }> {
  if (bytes.byteLength === 0 || bytes.byteLength > AUDIO_ARTWORK_MAXIMUM_BYTES
    || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
    throw new Error("Audio artwork exceeds its supported media bounds.");
  }
  const decoder = sharp(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
    limitInputPixels: AUDIO_ARTWORK_MAXIMUM_PIXELS, failOn: "warning"
  }).timeout({ seconds: 10 });
  const info = await decoder.metadata();
  if (`image/${info.format}` !== mimeType || !info.width || !info.height || (info.pages ?? 1) !== 1) {
    throw new Error("Audio artwork must be one supported raster image.");
  }
  await decoder.raw().toBuffer();
  return { width: info.width, height: info.height, format: info.format! };
}
