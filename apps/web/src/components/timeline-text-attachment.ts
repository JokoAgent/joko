import type { ArtifactView } from "../model.js";
import { fileNameSupportsTextPreview } from "@joko/contracts";

export const TIMELINE_TEXT_PREVIEW_LIMIT_BYTES = 10 * 1024 * 1024;


export function timelineArtifactSupportsTextPreview(artifact: Pick<ArtifactView, "fileName" | "mediaType" | "kind">): boolean {
  if (artifact.kind === "image") return false;
  const mediaType = artifact.mediaType.split(";", 1)[0]?.trim().toLocaleLowerCase() ?? "";
  if (mediaType.startsWith("text/")) return true;
  if (
    mediaType === "application/json"
    || mediaType === "application/ld+json"
    || mediaType === "application/sql"
    || mediaType === "application/toml"
    || mediaType === "application/x-httpd-php"
    || mediaType === "application/x-javascript"
    || mediaType === "application/x-ndjson"
    || mediaType === "application/x-sh"
    || mediaType === "application/xml"
    || mediaType === "application/yaml"
    || mediaType.endsWith("+json")
    || mediaType.endsWith("+xml")
  ) return true;
  return fileNameSupportsTextPreview(artifact.fileName.trim());
}

export function timelineTextPreviewLikelyBinary(text: string): boolean {
  const sample = text.slice(0, 8_192);
  if (sample.includes("\u0000")) return true;
  let controls = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) controls += 1;
  }
  return sample.length > 0 && controls / sample.length > 0.02;
}
