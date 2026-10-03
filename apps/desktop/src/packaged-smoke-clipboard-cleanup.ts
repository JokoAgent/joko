export interface PackagedSmokeClipboardCleanupOptions {
  readonly writesKnownSettled: boolean;
  readonly waitForWritesToSettle: () => Promise<boolean>;
  readonly retireWriter: () => void | Promise<void>;
  readonly ownsCurrentClipboard: () => boolean;
  readonly restorePreviousClipboard: () => void | Promise<void>;
}

export interface PackagedSmokeClipboardObservation {
  readonly text: string;
  readonly imageSha256?: string;
}

export function packagedSmokeSystemClipboardText(value: string, platform: string): string {
  const normalized = value.replace(/\r\n|\r|\n/gu, "\n");
  return platform === "win32" ? normalized.replaceAll("\n", "\r\n") : normalized;
}

export function isPackagedSmokeRestorableClipboardFormat(format: string): boolean {
  const normalized = format.trim().toLowerCase();
  return normalized === "text" || normalized === "string" || normalized === "unicode text"
    || normalized === "cf_text" || normalized === "cf_unicodetext" || normalized === "html format"
    || normalized === "rich text format" || normalized === "png" || normalized === "bitmap"
    || normalized.startsWith("text/plain") || normalized.startsWith("text/html")
    || normalized.startsWith("text/markhtml") || normalized.startsWith("text/rtf")
    || normalized === "text/bookmark" || normalized.startsWith("image/png")
    || normalized.startsWith("image/tiff") || normalized === "public.utf8-plain-text"
    || normalized === "public.utf16-external-plain-text" || normalized === "public.html"
    || normalized === "public.rtf" || normalized === "public.png" || normalized === "public.tiff";
}

export function hasOnlyEmptyPackagedSmokeClipboardFormats(
  formats: readonly string[],
  byteLengthForFormat: (format: string) => number
): boolean {
  return formats.length > 0 && formats.every((format) =>
    isPackagedSmokeRestorableClipboardFormat(format) && byteLengthForFormat(format) === 0);
}

export function isPackagedSmokeClipboardObservationOwned(
  observation: PackagedSmokeClipboardObservation,
  sentinel: string,
  expectedOutputTexts: readonly string[]
): boolean {
  if (observation.text === sentinel) return observation.imageSha256 === undefined;
  return observation.imageSha256 !== undefined && expectedOutputTexts.includes(observation.text);
}

/**
 * Finishes the packaged-smoke clipboard transaction without racing a delayed
 * renderer write or replacing a newer system clipboard owner.
 */
export async function cleanupPackagedSmokeClipboard(
  options: PackagedSmokeClipboardCleanupOptions
): Promise<void> {
  if (!options.writesKnownSettled) {
    let settled = false;
    try {
      settled = await options.waitForWritesToSettle();
    } catch {
      settled = false;
    }
    if (!settled) await options.retireWriter();
  }
  if (options.ownsCurrentClipboard()) await options.restorePreviousClipboard();
}
