import { FileKind, type Artifact, type WorkspaceEntry } from "@joko/contracts";
import { mobileImageGalleryMediaType } from "./mobile-image-gallery";
import { artifactTitle, canonicalWorkspacePath, workspaceBasename, workspaceEntryRevisionKey, type MobileFilePreview, type MobileFilesComposerSource } from "./workspace-files";
import { sortMobileGeneratedArtifacts, sortMobileWorkspaceEntries, type MobileFilesSortMode } from "./mobile-files-presentation";

export type MobileFilesPreviewPage = {
  readonly key: string; readonly title: string; readonly mediaType: string; readonly byteSize: bigint;
  readonly source: MobileFilesComposerSource;
} & ({ readonly kind: "workspace"; readonly entry: WorkspaceEntry } | { readonly kind: "artifact"; readonly artifact: Artifact });
export interface MobileFilesPreviewPager {
  readonly id: string; readonly pages: readonly MobileFilesPreviewPage[]; readonly index: number; readonly sort: MobileFilesSortMode;
}
export function mobileFilesPreviewCanSwipe(preview: MobileFilePreview | undefined, sourceView: boolean): boolean {
  if (preview?.kind === "pdf" || preview?.kind === "model") return false;
  const html = preview?.kind === "text" && (/\.html?$/iu.test(preview.fileName ?? preview.workspaceEntry?.relativePath ?? preview.sourceLabel)
    || /^text\/html(?:;|$)/iu.test(preview.mediaType));
  return !html || sourceView;
}
export function mobileWorkspacePreviewPages(entries: readonly WorkspaceEntry[], sort: MobileFilesSortMode,
  selected: WorkspaceEntry, selectedSource: MobileFilesComposerSource): readonly MobileFilesPreviewPage[] {
  const regular = sortMobileWorkspaceEntries(entries, sort).filter((entry) => entry.kind === FileKind.REGULAR && !mobileImageGalleryMediaType(entry.mediaType));
  if (!regular.some((entry) => entry.relativePath === selected.relativePath)) return [workspacePage(selected, selectedSource)];
  return regular.map((entry) => workspacePage(entry, entry.relativePath === selected.relativePath ? selectedSource : { kind: "workspace-entry", entry }));
}
export function mobileGeneratedPreviewPages(artifacts: readonly Artifact[], sort: MobileFilesSortMode, selectedId: string): readonly MobileFilesPreviewPage[] {
  const files = sortMobileGeneratedArtifacts(artifacts, sort).filter((artifact) => !mobileImageGalleryMediaType(artifact.blob?.mediaType ?? ""));
  const selected = artifacts.find((artifact) => artifact.artifactId === selectedId);
  if (!selected) throw new Error("The selected Generated file is no longer in its canonical catalog.");
  return (files.some((artifact) => artifact.artifactId === selectedId) ? files : [selected]).map((artifact) => ({
    key: JSON.stringify(["artifact", artifact.artifactId]), title: artifactTitle(artifact),
    mediaType: artifact.blob?.mediaType ?? "application/octet-stream", byteSize: artifact.blob?.byteSize ?? 0n,
    source: { kind: "artifact" as const, artifact }, kind: "artifact" as const, artifact
  }));
}
function workspacePage(entry: WorkspaceEntry, source: MobileFilesComposerSource): MobileFilesPreviewPage {
  const path = canonicalWorkspacePath(entry.relativePath); workspaceEntryRevisionKey(entry.revision);
  return { key: JSON.stringify(["workspace", entry.workspaceId, path]), title: entry.displayName || workspaceBasename(path),
    mediaType: entry.mediaType || "application/octet-stream", byteSize: entry.revision!.byteSize, kind: "workspace", entry, source };
}
