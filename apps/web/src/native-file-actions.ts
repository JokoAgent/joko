import { assertBrowserActionCurrent, type BrowserActionContext } from "./browser-action.js";

export type NativeFileCopyOutcome = JokoDesktopCopyFileResult;
export const NATIVE_FILE_COPY_MAXIMUM_BYTES = 256 * 1024 * 1024;

export function nativeFileCopyAvailable(): boolean {
  return typeof window !== "undefined" && window.jokoDesktop?.capabilities.includes("files.copy") === true;
}

/** Capture the trusted host before asynchronous retrieval, independently of the view Document. */
export function captureNativeFileCopy(): Pick<NonNullable<Window["jokoDesktop"]>, "copyFile" | "cancelFileCopy"> | undefined {
  if (!nativeFileCopyAvailable()) return undefined;
  const desktop = window.jokoDesktop!;
  return { copyFile: desktop.copyFile.bind(desktop), cancelFileCopy: desktop.cancelFileCopy.bind(desktop) };
}

export async function copyNativeArtifactFile(
  blob: Blob,
  name: string,
  context: BrowserActionContext,
  host: ReturnType<typeof captureNativeFileCopy>
): Promise<NativeFileCopyOutcome> {
  assertBrowserActionCurrent(context);
  if (host === undefined) return { status: "unavailable" };
  if (blob.size > NATIVE_FILE_COPY_MAXIMUM_BYTES) return { status: "failed", reason: "capacity" };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assertBrowserActionCurrent(context);
  if (bytes.byteLength > NATIVE_FILE_COPY_MAXIMUM_BYTES) return { status: "failed", reason: "capacity" };
  const requestId = context.ownerDocument.defaultView!.crypto.randomUUID();
  const cancel = (): void => { void host.cancelFileCopy(requestId).catch(() => undefined); };
  context.signal.addEventListener("abort", cancel, { once: true });
  try {
    assertBrowserActionCurrent(context);
    // A dispatched native request may already have changed the OS clipboard.
    // Neither a rejected IPC reply nor cancellation authorizes a fallback action.
    try { return await host.copyFile({ requestId, file: { name, mediaType: blob.type || "application/octet-stream", bytes } }); }
    catch { return { status: "unknown" }; }
  } finally {
    context.signal.removeEventListener("abort", cancel);
  }
}
