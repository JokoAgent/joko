import type { AttachmentDraft } from "./model.js";
import { normalizeImageAnnotationStrokes, sameImageAnnotationStrokes, type ImageAnnotationStroke } from "./image-annotations.js";
import { drawWorkspaceImageStrokes } from "./components/workspace-image-annotations.js";

/** Save vectors on the same original file, rejecting a replaced or edited draft. */
export function editImageAttachment(attachments: readonly AttachmentDraft[], source: AttachmentDraft, strokes: readonly ImageAnnotationStroke[]): readonly AttachmentDraft[] {
  const current = attachments.find(item => item.id === source.id);
  if (current === undefined || current.kind !== "image" || current.file !== source.file
    || !sameImageAnnotationStrokes(current.annotationStrokes, source.annotationStrokes)) throw new Error("The image draft has changed.");
  const annotationStrokes = normalizeImageAnnotationStrokes(strokes);
  if (annotationStrokes === null) throw new Error("The image annotations are invalid.");
  if (sameImageAnnotationStrokes(current.annotationStrokes, annotationStrokes)) return attachments;
  const { annotationStrokes: _previous, ...original } = current;
  return attachments.map(item => item === current ? { ...original, ...(annotationStrokes === undefined ? {} : { annotationStrokes }) } : item);
}

/** Burn only the captured send input. The editable draft and original bytes stay intact. */
export async function materializeImageAttachment(attachment: AttachmentDraft, signal: AbortSignal, ownerDocument?: Document): Promise<File> {
  signal.throwIfAborted();
  if (attachment.kind !== "image" || !attachment.annotationStrokes?.length) return attachment.file;
  const strokes = normalizeImageAnnotationStrokes(attachment.annotationStrokes);
  if (strokes === null || strokes === undefined) throw new Error("The image annotations are invalid.");
  const sourceDocument = ownerDocument ?? document;
  const ownerWindow = sourceDocument.defaultView ?? window;
  const image = sourceDocument.createElement("img"), canvas = sourceDocument.createElement("canvas");
  const url = ownerWindow.URL.createObjectURL(attachment.file);
  let detach = (): void => {};
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => reject(signal.reason);
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Image decode failed."));
      signal.addEventListener("abort", abort, { once: true });
      detach = () => { signal.removeEventListener("abort", abort); image.onload = null; image.onerror = null; };
      image.src = url;
      if (signal.aborted) abort();
    });
    detach();
    signal.throwIfAborted();
    if (image.naturalWidth < 1 || image.naturalHeight < 1) throw new Error("The image has no pixels.");
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas is unavailable.");
    context.drawImage(image, 0, 0);
    drawWorkspaceImageStrokes(context, strokes, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      const abort = (): void => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      detach = () => signal.removeEventListener("abort", abort);
      canvas.toBlob(result => result === null ? reject(new Error("Image encoding failed.")) : resolve(result), "image/png");
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
    return new ownerWindow.File([blob], `${attachment.file.name.replace(/\.[^.]+$/, "") || "image"}.png`, { type: "image/png", lastModified: attachment.file.lastModified });
  } finally {
    detach();
    image.removeAttribute("src");
    ownerWindow.URL.revokeObjectURL(url);
    canvas.width = 0; canvas.height = 0;
  }
}
