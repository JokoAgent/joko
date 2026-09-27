import { basename } from "node:path";

import type { DesktopDeepLinkNavigation, DesktopFile } from "./channels.js";
import type { DesktopInboundOpenIntent } from "./deep-link.js";

const MAXIMUM_PORTABLE_SESSION_FILE_BYTES = 256 * 1024 * 1024;

export type DesktopFileSnapshotReader = (path: string, maximumBytes: number) => Promise<Uint8Array>;

export async function materializeDesktopDeepLinkNavigation(
  intent: Exclude<DesktopInboundOpenIntent, { readonly kind: "focus" }>,
  readFileSnapshot: DesktopFileSnapshotReader
): Promise<DesktopDeepLinkNavigation> {
  if (intent.kind === "session" || intent.kind === "settings") return intent;
  if (intent.kind === "portable") return Object.freeze({ kind: "portable" });

  let file: DesktopFile | undefined;
  try {
    file = Object.freeze({
      name: basename(intent.path) || "task.jshare",
      mediaType: "application/vnd.joko.session",
      bytes: await readFileSnapshot(intent.path, MAXIMUM_PORTABLE_SESSION_FILE_BYTES)
    });
  } catch {
    // Preserve a recoverable import surface without exposing the local path or
    // native filesystem error to the renderer.
  }
  return Object.freeze({ kind: "portable", ...(file === undefined ? {} : { file }) });
}
