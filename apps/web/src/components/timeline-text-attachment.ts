import type { ArtifactView } from "../model.js";

export const TIMELINE_TEXT_PREVIEW_LIMIT_BYTES = 10 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  "bash", "c", "cc", "cfg", "conf", "cpp", "cs", "css", "csv", "cxx", "diff",
  "dockerfile", "env", "gitattributes", "gitignore", "go", "graphql", "h", "hpp", "htm",
  "html", "ini", "java", "js", "json", "jsonc", "jsx", "kt", "less", "log", "lua", "md",
  "mdown", "mdx", "mk", "mkd", "mjs", "patch", "php", "pl", "properties", "proto", "ps1",
  "py", "r", "rb", "rst", "rs", "sass", "scala", "scss", "sh", "sql", "svelte", "swift",
  "toml", "ts", "tsx", "txt", "vue", "xml", "yaml", "yml", "zsh"
]);

const EXTENSIONLESS_TEXT_NAMES = new Set([
  "authors", "changelog", "contributors", "copying", "dockerfile", "license", "makefile",
  "notice", "readme", "todo"
]);

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
    || mediaType.endsWith("+json")
    || mediaType.endsWith("+xml")
  ) return true;
  const name = artifact.fileName.trim().toLocaleLowerCase();
  if (EXTENSIONLESS_TEXT_NAMES.has(name)) return true;
  const dot = name.lastIndexOf(".");
  return dot > 0 && TEXT_EXTENSIONS.has(name.slice(dot + 1));
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
