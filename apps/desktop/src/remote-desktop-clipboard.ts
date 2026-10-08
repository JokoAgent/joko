import { clipboard, nativeImage, type NativeImage } from "electron";
import type { RemoteDesktopInput } from "@joko/device-peer";

import {
  readDesktopRemoteDesktopClipboardVersion,
  readDesktopRemoteDesktopSelection
} from "./remote-desktop-input.js";

export const REMOTE_DESKTOP_CLIPBOARD_TEXT_CODE_UNITS = 16_384;
export const REMOTE_DESKTOP_CLIPBOARD_MAX_CHARS = 32 * 1_024 * 1_024;
export const REMOTE_DESKTOP_CLIPBOARD_MAX_PIXELS = 64_000_000;

export interface DesktopRemoteDesktopClipboardContent {
  readonly text?: string;
  readonly html?: string;
  readonly rtf?: string;
  readonly url?: string;
  readonly png?: string;
}

export interface DesktopRemoteDesktopClipboardImage {
  isEmpty(): boolean;
  getSize(): { readonly width: number; readonly height: number };
  toPNG(): Buffer;
}

export interface DesktopRemoteDesktopClipboardRuntime {
  readonly platform: NodeJS.Platform;
  releaseInput(): void;
  pasteInput(): void;
  readSelection(portable: boolean, signal: AbortSignal): Promise<string>;
  readVersion(portable: boolean, signal: AbortSignal): Promise<string>;
  availableFormats(): readonly string[];
  readText(): string;
  readHtml(): string;
  readRtf(): string;
  readImage(): DesktopRemoteDesktopClipboardImage;
  writeText(text: string): void;
  write(value: {
    readonly text?: string;
    readonly html?: string;
    readonly rtf?: string;
    readonly image?: NativeImage;
  }): void;
  imageFromBuffer(bytes: Buffer): NativeImage;
}

/**
 * The only Main-process adapter allowed to touch the host system clipboard for
 * Remote Desktop. Content remains in memory and is transferred only after an
 * explicit Copy or Paste request.
 */
export class DesktopRemoteDesktopClipboard {
  readonly #runtime: DesktopRemoteDesktopClipboardRuntime;

  constructor(
    sendInput: (events: readonly RemoteDesktopInput[]) => void,
    runtime: DesktopRemoteDesktopClipboardRuntime = electronClipboardRuntime(sendInput)
  ) {
    this.#runtime = runtime;
  }

  async copyText(
    current: () => boolean,
    signal: AbortSignal
  ): Promise<string> {
    this.#check(current, signal);
    this.#runtime.releaseInput();
    const selected = await this.#runtime.readSelection(false, signal);
    this.#check(current, signal);
    if (selected.length > 0) {
      assertLegacyText(selected);
      this.#runtime.writeText(selected);
      return selected;
    }

    // Only a successful native selection read returning an empty string may
    // fall back to the general clipboard. Protected fields and unsupported or
    // failed selection APIs throw before this branch.
    const before = await this.#runtime.readVersion(false, signal);
    this.#check(current, signal);
    const text = this.#runtime.readText();
    assertLegacyText(text);
    const after = await this.#runtime.readVersion(false, signal);
    this.#check(current, signal);
    if (before !== after) throw new Error("REMOTE_DESKTOP_CLIPBOARD_CHANGED");
    return text;
  }

  async pasteText(
    text: string,
    current: () => boolean,
    signal: AbortSignal
  ): Promise<void> {
    this.#check(current, signal);
    assertLegacyText(text);
    this.#runtime.releaseInput();
    await this.#runtime.readVersion(false, signal);
    this.#check(current, signal);
    this.#runtime.writeText(text);
    if (this.#runtime.readText() !== text) {
      throw new Error("REMOTE_DESKTOP_CLIPBOARD_WRITE_FAILED");
    }
    this.#check(current, signal);
    this.#runtime.pasteInput();
  }

  async copyContent(
    current: () => boolean,
    signal: AbortSignal
  ): Promise<DesktopRemoteDesktopClipboardContent> {
    this.#check(current, signal);
    this.#runtime.releaseInput();
    const selected = await this.#runtime.readSelection(true, signal);
    this.#check(current, signal);
    if (selected.length > 0) return parseClipboardContent({ text: selected });

    const before = await this.#runtime.readVersion(true, signal);
    this.#check(current, signal);
    const formats = this.#runtime.availableFormats();
    const fileBacked = formats.some(isFileClipboardFormat);
    const image = this.#runtime.readImage();
    if (fileBacked && image.isEmpty()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");

    const content: {
      text?: string;
      html?: string;
      rtf?: string;
      png?: string;
    } = {};
    // File-manager text and HTML commonly contain a local path. If a portable
    // PNG alternative exists, transfer only its pixels and never the path.
    if (!fileBacked) {
      const text = this.#runtime.readText();
      const html = this.#runtime.readHtml();
      const rtf = this.#runtime.readRtf();
      if (text.length > 0) content.text = text;
      if (html.length > 0) content.html = html;
      if (rtf.length > 0) content.rtf = rtf;
    }
    if (!image.isEmpty()) {
      const size = image.getSize();
      assertImageDimensions(size.width, size.height);
      const png = image.toPNG();
      assertPngBytes(png);
      content.png = png.toString("base64");
    }

    const after = await this.#runtime.readVersion(true, signal);
    this.#check(current, signal);
    if (before !== after) throw new Error("REMOTE_DESKTOP_CLIPBOARD_CHANGED");
    if (Object.keys(content).length === 0) {
      throw new Error(formats.length > 0
        ? "REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED"
        : "REMOTE_DESKTOP_CLIPBOARD_EMPTY");
    }
    return parseClipboardContent(content);
  }

  async pasteContent(
    raw: DesktopRemoteDesktopClipboardContent,
    current: () => boolean,
    signal: AbortSignal
  ): Promise<void> {
    this.#check(current, signal);
    const content = parseClipboardContent(raw);
    this.#runtime.releaseInput();

    let image: NativeImage | undefined;
    if (content.png !== undefined) {
      const bytes = decodePng(content.png);
      image = this.#runtime.imageFromBuffer(bytes);
      if (image.isEmpty()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");
      const size = image.getSize();
      assertImageDimensions(size.width, size.height);
    }

    // The native counter refuses access on a secure/locked session before the
    // Electron clipboard can be mutated.
    await this.#runtime.readVersion(false, signal);
    this.#check(current, signal);
    const effectiveText = content.text ?? content.url;
    this.#runtime.write({
      ...(effectiveText === undefined ? {} : { text: effectiveText }),
      ...(content.html === undefined ? {} : { html: content.html }),
      ...(content.rtf === undefined ? {} : { rtf: content.rtf }),
      ...(image === undefined ? {} : { image })
    });
    if ((image !== undefined && this.#runtime.readImage().isEmpty())
      || (effectiveText !== undefined && this.#runtime.readText() !== effectiveText)) {
      throw new Error("REMOTE_DESKTOP_CLIPBOARD_WRITE_FAILED");
    }
    this.#check(current, signal);
    this.#runtime.pasteInput();
  }

  #check(current: () => boolean, signal: AbortSignal): void {
    if (signal.aborted) {
      throw signal.reason ?? new Error("Remote Desktop clipboard request was aborted.");
    }
    // The viewer lease may still be valid after control changes. Report the
    // clipboard-scoped fence so a stale Copy/Paste cannot tear down viewing.
    if (!current()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
  }
}

export function parseClipboardContent(
  value: DesktopRemoteDesktopClipboardContent
): DesktopRemoteDesktopClipboardContent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0 || keys.some((key) =>
    !["text", "html", "rtf", "url", "png"].includes(key)
      || typeof record[key] !== "string"
      || record[key]!.length === 0)) {
    throw new Error("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");
  }
  if (typeof record["url"] === "string" && !/^https?:\/\//iu.test(record["url"])) {
    throw new Error("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");
  }
  if (typeof record["png"] === "string") decodePng(record["png"]);
  if (JSON.stringify(record).length > REMOTE_DESKTOP_CLIPBOARD_MAX_CHARS) {
    throw new Error("REMOTE_DESKTOP_CLIPBOARD_TOO_LARGE");
  }
  return Object.freeze({
    ...(typeof record["text"] === "string" ? { text: record["text"] } : {}),
    ...(typeof record["html"] === "string" ? { html: record["html"] } : {}),
    ...(typeof record["rtf"] === "string" ? { rtf: record["rtf"] } : {}),
    ...(typeof record["url"] === "string" ? { url: record["url"] } : {}),
    ...(typeof record["png"] === "string" ? { png: record["png"] } : {})
  });
}

function electronClipboardRuntime(
  sendInput: (events: readonly RemoteDesktopInput[]) => void
): DesktopRemoteDesktopClipboardRuntime {
  const modifier = process.platform === "darwin" ? "MetaLeft" : "ControlLeft";
  return {
    platform: process.platform,
    releaseInput: () => { sendInput([Object.freeze({ kind: "release" })]); },
    pasteInput: () => {
      sendInput(Object.freeze([
        Object.freeze({ kind: "release" }),
        Object.freeze({ kind: "key", code: modifier, down: true }),
        Object.freeze({ kind: "key", code: "KeyV", down: true }),
        Object.freeze({ kind: "key", code: "KeyV", down: false }),
        Object.freeze({ kind: "key", code: modifier, down: false })
      ]));
    },
    readSelection: readDesktopRemoteDesktopSelection,
    readVersion: readDesktopRemoteDesktopClipboardVersion,
    availableFormats: () => clipboard.availableFormats(),
    readText: () => clipboard.readText(),
    readHtml: () => clipboard.readHTML(),
    readRtf: () => clipboard.readRTF(),
    readImage: () => clipboard.readImage(),
    writeText: (text) => { clipboard.writeText(text); },
    write: (value) => { clipboard.write(value); },
    imageFromBuffer: (bytes) => nativeImage.createFromBuffer(bytes)
  };
}

function assertLegacyText(text: string): void {
  if (typeof text !== "string" || text.length < 1
    || text.length > REMOTE_DESKTOP_CLIPBOARD_TEXT_CODE_UNITS) {
    throw new Error(text.length < 1
      ? "REMOTE_DESKTOP_CLIPBOARD_EMPTY"
      : "REMOTE_DESKTOP_CLIPBOARD_TOO_LARGE");
  }
  if (text.includes("\u0000")) throw new Error("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");
}

function isFileClipboardFormat(format: string): boolean {
  return /file-url|filenames|hdrop|filecontents|filegroupdescriptor|uri-list/iu.test(format);
}

function decodePng(value: string): Buffer {
  if (!/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new Error("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");
  }
  const bytes = Buffer.from(value, "base64");
  assertPngBytes(bytes);
  return bytes;
}

function assertPngBytes(bytes: Buffer): void {
  if (bytes.length < 24
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");
  }
  assertImageDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

function assertImageDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1 || width * height > REMOTE_DESKTOP_CLIPBOARD_MAX_PIXELS) {
    throw new Error("REMOTE_DESKTOP_CLIPBOARD_TOO_LARGE");
  }
}
