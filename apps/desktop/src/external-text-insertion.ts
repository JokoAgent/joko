import type { NativeImage } from "electron";
import { randomBytes } from "node:crypto";

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

export interface CapturedExternalTextInsertionDependencies {
  readonly clipboard: ExternalClipboard;
  /** Fixed capability callback; transcript text is carried only by the clipboard. */
  readonly paste: () => Promise<boolean>;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export interface ExternalTextInsertionResult {
  readonly inserted: boolean;
  readonly restored: Promise<void>;
}

/**
 * Owns the process-wide clipboard transaction used by voice insertion. A new
 * insertion is rejected until the previous paste has completed and its
 * clipboard restoration has settled.
 */
export class ExternalTextInsertionCoordinator {
  #active: Promise<void> | undefined;
  #failure: Error | undefined;

  busy(): boolean {
    return this.#active !== undefined || this.#failure !== undefined;
  }

  insertCaptured(
    text: string,
    dependencies: CapturedExternalTextInsertionDependencies
  ): Promise<ExternalTextInsertionResult> {
    return this.#run(() => insertTextIntoCapturedApplication(text, dependencies));
  }

  insertForeground(
    text: string,
    dependencies: ExternalTextInsertionDependencies
  ): Promise<ExternalTextInsertionResult> {
    return this.#run(() => insertTextIntoForegroundApplication(text, dependencies));
  }

  async waitForIdle(timeoutMs = 6_000): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("External text insertion timeout is invalid.");
    }
    if (this.#failure !== undefined) throw this.#failure;
    const deadline = Date.now() + timeoutMs;
    while (this.#active !== undefined) {
      const active = this.#active;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("External text insertion did not settle.");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          active,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("External text insertion did not settle.")), remaining);
            (timeout as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
          })
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
      if (this.#failure !== undefined) throw this.#failure;
    }
  }

  async #run(
    operation: () => Promise<ExternalTextInsertionResult>
  ): Promise<ExternalTextInsertionResult> {
    if (this.#failure !== undefined) {
      return { inserted: false, restored: handledRejection(this.#failure) };
    }
    const existing = this.#active;
    if (existing !== undefined) {
      return { inserted: false, restored: existing };
    }

    let release!: () => void;
    let fail!: (error: Error) => void;
    const ownership = new Promise<void>((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
    // The lease itself may be observed only by waitForIdle. Keep its rejection
    // handled even when no shutdown is currently waiting on it.
    void ownership.catch(() => undefined);
    this.#active = ownership;
    try {
      const result = await operation();
      const restored = result.restored.then(
        () => {
          if (this.#active === ownership) this.#active = undefined;
          release();
        },
        (error: unknown) => {
          const failure = externalClipboardRestoreFailure(error);
          this.#failure = failure;
          fail(failure);
          throw failure;
        }
      );
      void restored.catch(() => undefined);
      return { inserted: result.inserted, restored };
    } catch (error) {
      const failure = externalClipboardRestoreFailure(error);
      this.#failure = failure;
      fail(failure);
      return { inserted: false, restored: handledRejection(failure) };
    }
  }
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
const RESTORE_RETRY_DELAY_MS = 50;
const RESTORE_ATTEMPTS = 3;
const CLIPBOARD_OWNERSHIP_MARKER_PREFIX = "joko-external-text-owner-v1:";

interface ClipboardOwnership {
  readonly text: string;
  readonly marker: string;
}

export async function insertTextIntoForegroundApplication(
  text: string,
  dependencies: ExternalTextInsertionDependencies
): Promise<ExternalTextInsertionResult> {
  const command = externalPasteCommand(dependencies.platform);
  return insertTextIntoCapturedApplication(text, {
    clipboard: dependencies.clipboard,
    paste: () => command === undefined
      ? Promise.resolve(false)
      : dependencies.runCommand(command.command, command.args),
    ...(dependencies.delay === undefined ? {} : { delay: dependencies.delay })
  });
}

export async function insertTextIntoCapturedApplication(
  text: string,
  dependencies: CapturedExternalTextInsertionDependencies
): Promise<ExternalTextInsertionResult> {
  if (text.length === 0 || text.length > 64 * 1024 || /\u0000/u.test(text)) {
    return { inserted: false, restored: Promise.resolve() };
  }
  const snapshot = captureClipboard(dependencies.clipboard);
  const ownership = createClipboardOwnership(text);
  // Electron's legacy writeBuffer API replaces the other clipboard formats,
  // so the private owner proof travels as an invisible HTML marker alongside
  // the plain-text payload in one atomic clipboard.write call. HTML-aware
  // targets still receive the exact visible transcript.
  dependencies.clipboard.write({
    text,
    html: ownedClipboardHtml(ownership)
  });
  // Another clipboard owner may have replaced the transcript synchronously
  // after the write, including with identical text. Never send paste unless
  // both the exact payload and the unpredictable owner proof are still held.
  if (!clipboardOwnershipMatches(dependencies.clipboard, ownership)) {
    return { inserted: false, restored: Promise.resolve() };
  }
  let inserted = false;
  try {
    inserted = await dependencies.paste();
  } catch {
    inserted = false;
  }
  if (!inserted) {
    return {
      inserted: false,
      restored: restoreClipboardWithRetry(
        dependencies.clipboard,
        ownership,
        snapshot,
        dependencies.delay,
        0
      )
    };
  }
  const delay = dependencies.delay ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const restored = restoreClipboardWithRetry(dependencies.clipboard, ownership, snapshot, delay, RESTORE_DELAY_MS);
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

async function restoreClipboardWithRetry(
  value: ExternalClipboard,
  ownership: ClipboardOwnership,
  snapshot: ClipboardSnapshot,
  delay: ((milliseconds: number) => Promise<void>) | undefined,
  initialDelayMs: number
): Promise<void> {
  const wait = delay ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  if (initialDelayMs > 0) await wait(initialDelayMs);
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt += 1) {
    try {
      const restored = restoreClipboardIfOwned(value, ownership, snapshot);
      if (!restored && lastFailure !== undefined) throw externalClipboardRestoreFailure(lastFailure);
      return;
    } catch (error) {
      lastFailure = error;
      if (attempt < RESTORE_ATTEMPTS) await wait(RESTORE_RETRY_DELAY_MS);
    }
  }
  throw externalClipboardRestoreFailure(lastFailure);
}

function restoreClipboardIfOwned(
  value: ExternalClipboard,
  ownership: ClipboardOwnership,
  snapshot: ClipboardSnapshot
): boolean {
  if (!clipboardOwnershipMatches(value, ownership)) return false;
  value.clear();
  if (shouldPreferRawClipboardRestore(snapshot)) {
    if (!restoreRawClipboardFormats(value, snapshot.buffers)) restoreCommonClipboardFormats(value, snapshot);
    return true;
  }
  const commonRestored = restoreCommonClipboardFormats(value, snapshot);
  const rawFormats = commonRestored
    ? snapshot.buffers.filter(({ format }) => !isCommonClipboardFormat(format))
    : snapshot.buffers;
  if (!restoreRawClipboardFormats(value, rawFormats) && !commonRestored) value.clear();
  return true;
}

function createClipboardOwnership(text: string): ClipboardOwnership {
  return Object.freeze({
    text,
    marker: `<!--${CLIPBOARD_OWNERSHIP_MARKER_PREFIX}${randomBytes(32).toString("hex")}-->`
  });
}

function ownedClipboardHtml(ownership: ClipboardOwnership): string {
  return `<html><body>${ownership.marker}<span style="white-space: pre-wrap">${escapeHtmlText(ownership.text)}</span></body></html>`;
}

function clipboardOwnershipMatches(value: ExternalClipboard, ownership: ClipboardOwnership): boolean {
  if (value.readText() !== ownership.text) return false;
  try {
    return value.readHTML().includes(ownership.marker);
  } catch {
    return false;
  }
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function externalClipboardRestoreFailure(error: unknown): Error {
  return error instanceof Error && error.message === "External clipboard restoration failed."
    ? error
    : new Error("External clipboard restoration failed.", { cause: error });
}

function handledRejection(error: Error): Promise<never> {
  const rejected = Promise.reject(error);
  void rejected.catch(() => undefined);
  return rejected;
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
