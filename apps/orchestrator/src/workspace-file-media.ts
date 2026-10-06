import { posix } from "node:path";

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

const textExtensions = new Set([
  ".txt", ".log", ".csv", ".tsv",
  ".json", ".jsonc", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".cs", ".scala", ".sc",
  ".groovy", ".gradle", ".pl", ".pm", ".r", ".hs", ".proto", ".php",
  ".dart", ".lua", ".sh", ".bash", ".zsh", ".ps1",
  ".yaml", ".yml", ".toml", ".ini", ".html", ".htm", ".vue", ".svelte",
  ".css", ".scss", ".sass", ".less", ".sql", ".graphql", ".gql",
  ".diff", ".patch", ".dockerfile", ".makefile", ".mk"
]);

export function workspaceMediaTypeForPath(value: string): string {
  const name = posix.basename(value.replace(/\\/gu, "/")).toLowerCase();
  if (name === "dockerfile" || name === "makefile") return "text/plain";
  const extension = posix.extname(name);
  return mediaTypes.get(extension) ?? (textExtensions.has(extension) ? "text/plain" : "application/octet-stream");
}

export function isWorkspaceTextMediaType(value: string): boolean {
  return value.startsWith("text/") || value === "application/json" || value === "application/xml"
    || value === "application/yaml" || value === "image/svg+xml";
}
