import { fileNameSupportsTextPreview, filePreviewExtension } from "@joko/contracts";

/** Filename metadata is advisory until a revision-fenced snapshot is read. */
export const workspaceRasterMediaTypes: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"], [".apng", "image/apng"],
  [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"],
  [".bmp", "image/bmp"], [".ico", "image/x-icon"],
  [".avif", "image/avif"], [".heic", "image/heic"], [".heif", "image/heif"],
  [".tif", "image/tiff"], [".tiff", "image/tiff"]
]);

const mediaTypes: ReadonlyMap<string, string> = new Map([
  ...workspaceRasterMediaTypes,
  [".md", "text/markdown"], [".markdown", "text/markdown"],
  [".mdown", "text/markdown"], [".mkd", "text/markdown"], [".mdx", "text/markdown"],
  [".html", "text/html"], [".htm", "text/html"],
  [".json", "application/json"], [".jsonc", "application/json"],
  [".js", "text/javascript"], [".mjs", "text/javascript"], [".cjs", "text/javascript"],
  [".ts", "text/typescript"], [".tsx", "text/typescript"], [".css", "text/css"],
  [".yaml", "application/yaml"], [".yml", "application/yaml"],
  [".xml", "application/xml"], [".drawio", "application/xml"],
  [".svg", "image/svg+xml"], [".pdf", "application/pdf"],
  [".glb", "model/gltf-binary"], [".gltf", "model/gltf+json"], [".ktx2", "image/ktx2"],
  [".wasm", "application/wasm"],
  [".woff", "font/woff"], [".woff2", "font/woff2"], [".ttf", "font/ttf"], [".otf", "font/otf"],
  [".mp3", "audio/mpeg"], [".wav", "audio/wav"],
  [".ogg", "audio/ogg"], [".oga", "audio/ogg"], [".opus", "audio/ogg"],
  [".m4a", "audio/mp4"], [".aac", "audio/aac"], [".flac", "audio/flac"],
  [".mp4", "video/mp4"], [".m4v", "video/x-m4v"], [".mov", "video/quicktime"],
  [".webm", "video/webm"], [".avi", "video/x-msvideo"], [".mkv", "video/x-matroska"]
]);


export function workspaceMediaTypeForPath(value: string): string {
  return mediaTypes.get(filePreviewExtension(value))
    ?? (fileNameSupportsTextPreview(value) ? "text/plain" : "application/octet-stream");
}

export function isWorkspaceTextMediaType(value: string): boolean {
  return value.startsWith("text/") || value === "application/json" || value === "application/xml"
    || value === "application/yaml" || value === "image/svg+xml";
}

export function decodeWorkspaceTextPreview(bytes: Uint8Array, truncated: boolean): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, { stream: truncated });
}
