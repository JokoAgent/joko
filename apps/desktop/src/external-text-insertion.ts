import type { NativeImage } from "electron";

export interface ExternalClipboard {
  availableFormats?(type?: "selection" | "clipboard"): string[];
  readText(type?: "selection" | "clipboard"): string;
  readHTML(type?: "selection" | "clipboard"): string;
  readRTF(type?: "selection" | "clipboard"): string;
  readBookmark(): { readonly title: string; readonly url: string };
  readImage(type?: "selection" | "clipboard"): NativeImage;
  readBuffer?(format: string): Buffer;
  writeText(text: string, type?: "selection" | "clipboard"): void;
  write(data: {
    readonly text?: string;
    readonly html?: string;
    readonly image?: NativeImage;
    readonly rtf?: string;
    readonly bookmark?: string;
  }, type?: "selection" | "clipboard"): void;
  writeBuffer?(format: string, buffer: Buffer, type?: "selection" | "clipboard"): void;
  clear(type?: "selection" | "clipboard"): void;
}

export interface ExternalTextInsertionDependencies {
  readonly clipboard: ExternalClipboard;
  readonly platform: NodeJS.Platform;
  readonly runCommand: (command: string, args: readonly string[]) => Promise<boolean>;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export interface ExternalTextInsertionResult {
  readonly inserted: boolean;
  readonly restored: Promise<void>;
}

interface ClipboardSnapshot {
  readonly formats: readonly string[];
  readonly text: string;
  readonly html: string;
  readonly rtf: string;
  readonly bookmark: { readonly title: string; readonly url: string };
  readonly image?: NativeImage;
  readonly buffers: readonly { readonly format: string; readonly buffer: Buffer }[];
}

const RESTORE_DELAY_MS = 600;

export async function insertTextIntoForegroundApplication(
  text: string,
  dependencies: ExternalTextInsertionDependencies
): Promise<ExternalTextInsertionResult> {
  if (text.length === 0 || text.length > 64 * 1024 || /\u0000/u.test(text)) {
    return { inserted: false, restored: Promise.resolve() };
  }
  const snapshot = captureClipboard(dependencies.clipboard);
  dependencies.clipboard.writeText(text);
  const command = externalPasteCommand(dependencies.platform);
  const inserted = command !== undefined && await dependencies.runCommand(command.command, command.args);
  if (!inserted) {
    restoreClipboardIfUnchanged(dependencies.clipboard, text, snapshot);
    return { inserted: false, restored: Promise.resolve() };
  }
  const delay = dependencies.delay ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const restored = delay(RESTORE_DELAY_MS).then(() => {
    restoreClipboardIfUnchanged(dependencies.clipboard, text, snapshot);
  });
  return { inserted: true, restored };
}

export function externalPasteCommand(platform: NodeJS.Platform): { readonly command: string; readonly args: readonly string[] } | undefined {
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: Object.freeze([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$shell = New-Object -ComObject WScript.Shell; [void]$shell.SendKeys('^v')"
      ])
    };
  }
  if (platform === "darwin") {
    return {
      command: "/usr/bin/osascript",
      args: Object.freeze(["-e", "tell application \"System Events\" to keystroke \"v\" using command down"])
    };
  }
  if (platform === "linux") {
    return { command: "xdotool", args: Object.freeze(["key", "--clearmodifiers", "ctrl+v"]) };
  }
  return undefined;
}

function captureClipboard(value: ExternalClipboard): ClipboardSnapshot {
  const image = value.readImage();
  const formats = Object.freeze([...new Set(value.availableFormats?.("clipboard") ?? [])]);
  return Object.freeze({
    formats,
    text: value.readText(),
    html: value.readHTML(),
    rtf: value.readRTF(),
    bookmark: Object.freeze(value.readBookmark()),
    ...(image.isEmpty() ? {} : { image }),
    buffers: Object.freeze(formats.flatMap((format) => {
      try {
        const buffer = value.readBuffer?.(format);
        return buffer === undefined || buffer.byteLength === 0
          ? []
          : [{ format, buffer: Buffer.from(buffer) }];
      } catch {
        return [];
      }
    }))
  });
}

function restoreClipboardIfUnchanged(value: ExternalClipboard, insertedText: string, snapshot: ClipboardSnapshot): void {
  if (value.readText() !== insertedText) return;
  value.clear();
  if (shouldPreferRawClipboardRestore(snapshot)) {
    if (!restoreRawClipboardFormats(value, snapshot.buffers)) restoreCommonClipboardFormats(value, snapshot);
    return;
  }
  const commonRestored = restoreCommonClipboardFormats(value, snapshot);
  const rawFormats = commonRestored
    ? snapshot.buffers.filter(({ format }) => !isCommonClipboardFormat(format))
    : snapshot.buffers;
  if (!restoreRawClipboardFormats(value, rawFormats) && !commonRestored) value.clear();
}

function restoreCommonClipboardFormats(value: ExternalClipboard, snapshot: ClipboardSnapshot): boolean {
  const data = {
    ...(snapshot.text !== ""
      ? { text: snapshot.text }
      : snapshot.bookmark.url === "" ? {} : { text: snapshot.bookmark.url }),
    ...(snapshot.html === "" ? {} : { html: snapshot.html }),
    ...(snapshot.rtf === "" ? {} : { rtf: snapshot.rtf }),
    ...(snapshot.bookmark.url === ""
      ? {}
      : { bookmark: snapshot.bookmark.title || snapshot.bookmark.url }),
    ...(snapshot.image === undefined ? {} : { image: snapshot.image })
  };
  if (Object.keys(data).length === 0) return false;
  value.write(data);
  return true;
}

function restoreRawClipboardFormats(
  value: ExternalClipboard,
  buffers: ClipboardSnapshot["buffers"]
): boolean {
  if (value.writeBuffer === undefined) return false;
  let restored = false;
  for (const { format, buffer } of buffers) {
    try {
      value.writeBuffer(format, Buffer.from(buffer), "clipboard");
      restored = true;
    } catch {
      // Some native clipboard formats cannot be written through Electron.
    }
  }
  return restored;
}

function shouldPreferRawClipboardRestore(snapshot: ClipboardSnapshot): boolean {
  if (snapshot.buffers.length === 0) return false;
  if (snapshot.text === "" && snapshot.html === "" && snapshot.rtf === ""
    && snapshot.bookmark.url === "" && snapshot.image === undefined) return true;
  return snapshot.formats.some((format) => {
    const normalized = format.toLowerCase();
    return normalized.includes("file") || normalized.includes("filename");
  });
}

function isCommonClipboardFormat(format: string): boolean {
  const normalized = format.trim().toLowerCase();
  return normalized === "text"
    || normalized === "string"
    || normalized === "unicode text"
    || normalized === "cf_text"
    || normalized === "cf_unicodetext"
    || normalized === "html format"
    || normalized === "rich text format"
    || normalized === "png"
    || normalized === "bitmap"
    || normalized.startsWith("text/plain")
    || normalized.startsWith("text/html")
    || normalized.startsWith("text/rtf")
    || normalized === "text/bookmark"
    || normalized.startsWith("image/png")
    || normalized.startsWith("image/tiff")
    || normalized === "public.utf8-plain-text"
    || normalized === "public.utf16-external-plain-text"
    || normalized === "public.html"
    || normalized === "public.rtf"
    || normalized === "public.png"
    || normalized === "public.tiff";
}
