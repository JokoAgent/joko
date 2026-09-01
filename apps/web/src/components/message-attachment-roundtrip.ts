import type { ArtifactView, AttachmentDraft } from "../model.js";
import type { ComposerAttachmentPolicy } from "./composer-behavior.js";

export type MessageAttachmentRestoreFailure =
  | "count"
  | "unsupported"
  | "tooLarge"
  | "invalidArtifact"
  | "blobMismatch";

export class MessageAttachmentRestoreError extends Error {
  constructor(readonly reason: MessageAttachmentRestoreFailure) {
    super(`Message attachment restore failed: ${reason}`);
    this.name = "MessageAttachmentRestoreError";
  }
}

/**
 * Rehydrate durable input artifacts before a destructive dialogue rewind.
 * Every artifact must load and pass the current capability/size policy before
 * any AttachmentDraft is returned, so callers never publish a partial tray.
 */
export async function restoreMessageAttachmentDrafts(
  artifacts: readonly ArtifactView[],
  policy: ComposerAttachmentPolicy,
  loadBlob: (artifact: ArtifactView) => Promise<Blob>,
  createId: () => string
): Promise<readonly AttachmentDraft[]> {
  if (policy.maximumItems !== undefined && artifacts.length > policy.maximumItems) throw new MessageAttachmentRestoreError("count");

  for (const artifact of artifacts) {
    assertRestorableArtifact(artifact, policy);
    if (policy.maximumBytes !== undefined && artifact.byteSize > policy.maximumBytes) throw new MessageAttachmentRestoreError("tooLarge");
  }

  const loaded = await Promise.all(artifacts.map(async (artifact) => ({ artifact, blob: await loadBlob(artifact) })));
  return loaded.map(({ artifact, blob }) => {
    if (!(blob instanceof Blob)) throw new MessageAttachmentRestoreError("invalidArtifact");
    if (artifact.byteSize > 0 && blob.size !== artifact.byteSize) throw new MessageAttachmentRestoreError("blobMismatch");
    if (policy.maximumBytes !== undefined && blob.size > policy.maximumBytes) throw new MessageAttachmentRestoreError("tooLarge");
    const kind = artifact.kind as "image" | "file";
    const type = artifact.mediaType.trim() || blob.type || "application/octet-stream";
    const file = new File([blob], boundedFileName(artifact.fileName, kind), { type });
    return { id: createId(), kind, file };
  });
}

/** Exact descriptor fence used after asynchronous blob loading. */
export function sameMessageAttachments(
  left: readonly ArtifactView[] | undefined,
  right: readonly ArtifactView[] | undefined
): boolean {
  const first = left ?? [];
  const second = right ?? [];
  return first.length === second.length && first.every((artifact, index) => {
    const candidate = second[index];
    return candidate !== undefined
      && artifact.id === candidate.id
      && artifact.blobId === candidate.blobId
      && artifact.kind === candidate.kind
      && artifact.fileName === candidate.fileName
      && artifact.mediaType === candidate.mediaType
      && artifact.byteSize === candidate.byteSize;
  });
}

function assertRestorableArtifact(artifact: ArtifactView, policy: ComposerAttachmentPolicy): void {
  if (
    artifact.blobId.trim() === ""
    || artifact.blobId.length > 1_024
    || artifact.fileName.length > 1_024
    || !Number.isSafeInteger(artifact.byteSize)
    || artifact.byteSize < 0
    || (artifact.kind !== "image" && artifact.kind !== "file")
  ) throw new MessageAttachmentRestoreError("invalidArtifact");
  if ((artifact.kind === "image" && !policy.images) || (artifact.kind === "file" && !policy.files)) {
    throw new MessageAttachmentRestoreError("unsupported");
  }
}

function boundedFileName(value: string, kind: "image" | "file"): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  return normalized.slice(0, 255) || (kind === "image" ? "image" : "file");
}
