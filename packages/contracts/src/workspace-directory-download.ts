export const WORKSPACE_DIRECTORY_ARCHIVE_MEDIA_TYPE = "application/gzip";
export const WORKSPACE_DIRECTORY_ARCHIVE_MAXIMUM_BYTES = 256 * 1024 * 1024;
export const WORKSPACE_DIRECTORY_ARCHIVE_MAXIMUM_ENTRIES = 10_000;

/** The same directory must be representable on Windows, macOS and Linux. */
export function isWorkspaceDirectoryArchiveName(value: string): boolean {
  return value.length > 0 && value.length <= 240 && value.trim() === value
    && new TextEncoder().encode(value).byteLength <= 240
    && !/[<>:"/\\|?*\x00-\x1f\x7f]/u.test(value) && !value.endsWith(".")
    && value.toLowerCase() !== ".git"
    && !/^(?:con|prn|aux|nul|(?:com|lpt)[1-9¹²³])(?:\.|$)/iu.test(value);
}

export function workspaceDirectoryArchiveNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}
