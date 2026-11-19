export const WORKSPACE_PDF_PREVIEW_MAXIMUM_BYTES = 32 * 1024 * 1024;

export function workspaceFileMetadataRevision(info: {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}): string {
  return `meta:${info.dev}:${info.ino}:${info.mode}:${info.nlink}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}
