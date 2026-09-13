export interface FileAttachmentInsertion {
  readonly id: number;
  readonly sessionId: string;
  readonly file: File;
}

/** Route-transition fence for one-shot Files image-lightbox attachments. */
export function fileAttachmentInsertionFor(
  id: number,
  activeSessionId: string | undefined,
  producerSessionId: string,
  file: File
): FileAttachmentInsertion | undefined {
  if (!Number.isSafeInteger(id) || id < 1 || activeSessionId !== producerSessionId) return undefined;
  if (!(file instanceof File) || !file.type.toLocaleLowerCase().startsWith("image/")) return undefined;
  return { id, sessionId: producerSessionId, file };
}
