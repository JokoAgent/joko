import type { ArtifactDownloadContext, ArtifactDownloadOutcome } from "./model.js";

export type NativeArtifactSave = (input: { readonly name: string; readonly mediaType: string; readonly bytes: Uint8Array }) => Promise<boolean>;

export function downloadArtifactUrl(url: string, name: string, context: ArtifactDownloadContext): ArtifactDownloadOutcome {
  context.signal.throwIfAborted();
  if (context.ownerDocument.defaultView === null || context.ownerDocument.defaultView.closed) throw new Error("The download window is no longer available.");
  const anchor = context.ownerDocument.createElement("a");
  anchor.href = url;
  anchor.download = name || "artifact";
  anchor.rel = "noopener";
  context.signal.throwIfAborted();
  anchor.click();
  return "dispatched";
}

export function downloadArtifactBlob(blob: Blob, name: string, context: ArtifactDownloadContext): ArtifactDownloadOutcome {
  context.signal.throwIfAborted();
  const ownerWindow = context.ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("The download window is no longer available.");
  const urls = ownerWindow.URL;
  const url = urls.createObjectURL(blob);
  let released = false;
  let timer: number | undefined;
  const release = (): void => {
    if (released) return;
    released = true;
    if (timer !== undefined) ownerWindow.clearTimeout(timer);
    ownerWindow.removeEventListener("pagehide", release);
    urls.revokeObjectURL(url);
  };
  ownerWindow.addEventListener("pagehide", release, { once: true });
  let dispatched = false;
  try {
    const result = downloadArtifactUrl(url, name, context);
    dispatched = true;
    return result;
  } finally {
    if (!dispatched) release();
    else if (!released) timer = ownerWindow.setTimeout(release, 1_000);
  }
}

export async function saveArtifactBlob(blob: Blob, name: string, context: ArtifactDownloadContext, nativeSave: NativeArtifactSave | undefined): Promise<ArtifactDownloadOutcome> {
  context.signal.throwIfAborted();
  if (nativeSave === undefined) return downloadArtifactBlob(blob, name, context);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  context.signal.throwIfAborted();
  if (context.ownerDocument.defaultView === null || context.ownerDocument.defaultView.closed) throw new Error("The download window is no longer available.");
  // Once dispatched, cancellation cannot retract the OS action or infer its outcome.
  return await nativeSave({ name: name || "artifact", mediaType: blob.type || "application/octet-stream", bytes }) ? "saved" : "cancelled";
}
