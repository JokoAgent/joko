import { FileKind, type Artifact, type WorkspaceEntry } from "@joko/contracts";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { artifactTitle, canonicalWorkspacePath, workspaceBasename, type MobileFilesComposerSource } from "./workspace-files";

export type MobileFilesViewMode = "grid" | "list";
export type MobileFilesSortMode = "name" | "mtime" | "size";
export interface MobileFilesPreferences { readonly view: MobileFilesViewMode; readonly sort: MobileFilesSortMode }
export const DEFAULT_MOBILE_FILES_PREFERENCES: MobileFilesPreferences = Object.freeze({ view: "grid", sort: "name" });

export function sortMobileWorkspaceEntries(entries: readonly WorkspaceEntry[], sort: MobileFilesSortMode): WorkspaceEntry[] {
  return [...entries].sort((left, right) => {
    const directory = left.kind === FileKind.DIRECTORY; const otherDirectory = right.kind === FileKind.DIRECTORY;
    if (directory !== otherDirectory) return directory ? -1 : 1;
    if (sort === "mtime") {
      const difference = modifiedMillis(right.revision?.modifiedAt) - modifiedMillis(left.revision?.modifiedAt);
      if (difference) return difference;
    }
    if (sort === "size" && !directory) {
      const difference = compareSize(right.revision?.byteSize ?? 0n, left.revision?.byteSize ?? 0n); if (difference) return difference;
    }
    return compareNames(left.displayName || workspaceBasename(left.relativePath), right.displayName || workspaceBasename(right.relativePath))
      || compareNames(left.relativePath, right.relativePath);
  });
}
export function sortMobileGeneratedArtifacts(artifacts: readonly Artifact[], sort: MobileFilesSortMode): Artifact[] {
  return [...artifacts].sort((left, right) => {
    if (sort === "mtime") { const difference = modifiedMillis(right.createdAt) - modifiedMillis(left.createdAt); if (difference) return difference; }
    if (sort === "size") { const difference = compareSize(right.blob?.byteSize ?? 0n, left.blob?.byteSize ?? 0n); if (difference) return difference; }
    return compareNames(artifactTitle(left), artifactTitle(right)) || compareNames(left.artifactId, right.artifactId);
  });
}
export function mobileFilesGridColumns(width: number): number { return Math.min(6, Math.max(2, Math.floor(width / 130) || 2)); }

export function mobileFilesPathLevels(path: string, rootLabel: string): readonly { readonly path: string; readonly label: string; readonly current: boolean }[] {
  const canonical = canonicalWorkspacePath(path, true); const parts = canonical ? canonical.split("/") : [];
  return [{ path: "", label: rootLabel, current: !canonical }, ...parts.map((label, index) => ({
    path: parts.slice(0, index + 1).join("/"), label, current: index === parts.length - 1
  }))].reverse();
}

export interface MobileFilesDisplayItem {
  readonly key: string; readonly label: string; readonly directory: boolean; readonly meta: string;
  readonly mediaType: string; readonly source: MobileFilesComposerSource;
}
export function mobileFilesWorkspaceItems(entries: readonly WorkspaceEntry[], sort: MobileFilesSortMode, locale: MobileSupportedLocale, now: number): MobileFilesDisplayItem[] {
  return sortMobileWorkspaceEntries(entries, sort).map((entry) => {
    const directory = entry.kind === FileKind.DIRECTORY; const date = mobileFilesDateLabel(entry.revision?.modifiedAt, locale, now);
    return { key: `workspace:${entry.workspaceId}:${entry.relativePath}`, label: entry.displayName || workspaceBasename(entry.relativePath), directory,
      mediaType: entry.kind === FileKind.REGULAR ? entry.mediaType : "", source: { kind: "workspace-entry", entry }, meta: [directory ? mobileMessage(locale, "files.directory")
        : mobileFilesByteLabel(entry.revision?.byteSize ?? 0n), date,
        entry.hidden ? mobileMessage(locale, "files.hidden") : "", entry.ignored ? mobileMessage(locale, "files.ignored") : ""].filter(Boolean).join(" · ") };
  });
}
export function mobileFilesGeneratedItems(artifacts: readonly Artifact[], sort: MobileFilesSortMode, locale: MobileSupportedLocale, now: number): MobileFilesDisplayItem[] {
  return sortMobileGeneratedArtifacts(artifacts, sort).map((artifact) => ({ key: `artifact:${artifact.artifactId}`, label: artifactTitle(artifact), directory: false,
    mediaType: artifact.blob?.mediaType ?? "", source: { kind: "artifact", artifact }, meta: [artifact.blob ? mobileFilesByteLabel(artifact.blob.byteSize)
      : mobileMessage(locale, "files.blobUnavailable"), mobileFilesDateLabel(artifact.createdAt, locale, now)].filter(Boolean).join(" · ") }));
}
export function mobileFilesByteLabel(size: bigint): string {
  if (size < 1024n) return `${size} B`;
  const unit = size < 1024n ** 2n ? [1024n, "KB"] as const : size < 1024n ** 3n ? [1024n ** 2n, "MB"] as const : [1024n ** 3n, "GB"] as const;
  const tenths = (size * 10n + unit[0] / 2n) / unit[0]; return `${tenths / 10n}.${tenths % 10n} ${unit[1]}`;
}
export function mobileFilesDateLabel(timestamp: { readonly seconds: bigint; readonly nanos: number } | undefined, locale: MobileSupportedLocale, now: number): string {
  const milliseconds = modifiedMillis(timestamp); if (!milliseconds) return "";
  const date = new Date(milliseconds); const today = new Date(now);
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const difference = Math.round((day(today) - day(date)) / 86_400_000);
  if (difference === 0 || difference === 1) return mobileMessage(locale, difference === 0 ? "files.presentation.today" : "files.presentation.yesterday", {
    time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date) });
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) }).format(date);
}
function modifiedMillis(timestamp: { readonly seconds: bigint; readonly nanos: number } | undefined): number {
  if (!timestamp || !Number.isInteger(timestamp.nanos) || timestamp.nanos < 0 || timestamp.nanos >= 1_000_000_000) return 0;
  const value = Number(timestamp.seconds) * 1000 + Math.floor(timestamp.nanos / 1_000_000); return Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15 ? value : 0;
}
function compareNames(left: string, right: string): number { return left.localeCompare(right, undefined, { sensitivity: "base", numeric: true }) || left.localeCompare(right); }
function compareSize(left: bigint, right: bigint): number { return left === right ? 0 : left < right ? -1 : 1; }
