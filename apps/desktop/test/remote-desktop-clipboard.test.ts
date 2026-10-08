import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ clipboard: {}, nativeImage: {} }));

import {
  DesktopRemoteDesktopClipboard,
  REMOTE_DESKTOP_CLIPBOARD_TEXT_CODE_UNITS,
  parseClipboardContent,
  type DesktopRemoteDesktopClipboardImage,
  type DesktopRemoteDesktopClipboardRuntime
} from "../src/remote-desktop-clipboard.js";

const SIGNAL = new AbortController().signal;

describe("Desktop Remote Desktop clipboard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prefers an exact selected text value and falls back only after confirmed empty", async () => {
    const selected = fixture({ selection: "selected text", text: "unrelated clipboard" });
    await expect(selected.clipboard.copyText(() => true, SIGNAL)).resolves.toBe("selected text");
    expect(selected.runtime.writeText).toHaveBeenCalledWith("selected text");
    expect(selected.runtime.readVersion).not.toHaveBeenCalled();
    expect(selected.runtime.readText).not.toHaveBeenCalled();

    const empty = fixture({ selection: "", text: "clipboard text", versions: ["7", "7"] });
    await expect(empty.clipboard.copyText(() => true, SIGNAL)).resolves.toBe("clipboard text");
    expect(empty.runtime.readVersion).toHaveBeenCalledTimes(2);
    expect(empty.runtime.readText).toHaveBeenCalledOnce();

    const protectedField = fixture({ selection: "", text: "must not leak" });
    vi.mocked(protectedField.runtime.readSelection)
      .mockRejectedValueOnce(new Error("REMOTE_DESKTOP_CLIPBOARD_COPY_FAILED"));
    await expect(protectedField.clipboard.copyText(() => true, SIGNAL))
      .rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_COPY_FAILED");
    expect(protectedField.runtime.readVersion).not.toHaveBeenCalled();
    expect(protectedField.runtime.readText).not.toHaveBeenCalled();
  });

  it("bounds legacy UTF-16 text and injects Paste once after the current fence", async () => {
    const value = fixture({ text: "before" });
    await value.clipboard.pasteText("paste me", () => true, SIGNAL);
    expect(value.inputs).toEqual([
      [{ kind: "release" }],
      [
        { kind: "release" },
        { kind: "key", code: "ControlLeft", down: true },
        { kind: "key", code: "KeyV", down: true },
        { kind: "key", code: "KeyV", down: false },
        { kind: "key", code: "ControlLeft", down: false }
      ]
    ]);

    await expect(value.clipboard.pasteText(
      "x".repeat(REMOTE_DESKTOP_CLIPBOARD_TEXT_CODE_UNITS + 1),
      () => true,
      SIGNAL
    )).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_TOO_LARGE");

    const retired = fixture({ text: "before" });
    let checks = 0;
    await expect(retired.clipboard.pasteText("stale", () => ++checks < 3, SIGNAL))
      .rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
    expect(retired.inputs).toEqual([[{ kind: "release" }]]);
  });

  it("copies one portable item without exposing file flavors or local paths", async () => {
    const image = pngImage(2, 3);
    const value = fixture({
      selection: "",
      text: "C:\\private\\image.png",
      html: "<a href=\"file:///private/image.png\">private</a>",
      rtf: "private path",
      formats: ["CF_HDROP", "image/png", "text/plain"],
      image,
      versions: ["4", "4"]
    });
    await expect(value.clipboard.copyContent(() => true, SIGNAL)).resolves.toEqual({
      png: image.toPNG().toString("base64")
    });
    expect(value.runtime.readText).not.toHaveBeenCalled();
    expect(value.runtime.readHtml).not.toHaveBeenCalled();
    expect(value.runtime.readRtf).not.toHaveBeenCalled();

    const fileOnly = fixture({
      selection: "",
      text: "C:\\private\\document.txt",
      formats: ["CF_HDROP", "text/plain"],
      image: emptyImage()
    });
    await expect(fileOnly.clipboard.copyContent(() => true, SIGNAL))
      .rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");
    expect(fileOnly.runtime.readText).not.toHaveBeenCalled();
  });

  it("keeps portable alternatives together and rejects a clipboard changed during capture", async () => {
    const value = fixture({
      selection: "",
      text: "caption",
      html: "<p>caption</p>",
      rtf: "{\\rtf1 caption}",
      formats: ["text/plain", "text/html", "text/rtf"],
      image: emptyImage(),
      versions: ["9", "9"]
    });
    await expect(value.clipboard.copyContent(() => true, SIGNAL)).resolves.toEqual({
      text: "caption",
      html: "<p>caption</p>",
      rtf: "{\\rtf1 caption}"
    });

    const changed = fixture({
      selection: "",
      text: "old",
      formats: ["text/plain"],
      image: emptyImage(),
      versions: ["10", "11"]
    });
    await expect(changed.clipboard.copyContent(() => true, SIGNAL))
      .rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_CHANGED");
  });

  it("writes only admitted portable representations and never fetches a URL", async () => {
    const value = fixture({ text: "before", image: emptyImage() });
    await value.clipboard.pasteContent({
      html: "<strong>Joko</strong>",
      rtf: "{\\rtf1 Joko}",
      url: "https://example.test/path"
    }, () => true, SIGNAL);
    expect(value.runtime.write).toHaveBeenCalledWith({
      text: "https://example.test/path",
      html: "<strong>Joko</strong>",
      rtf: "{\\rtf1 Joko}"
    });
    expect(value.inputs).toHaveLength(2);

    expect(() => parseClipboardContent({ url: "file:///private/report.txt" }))
      .toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");
    expect(() => parseClipboardContent({ privateFormat: "secret" } as never))
      .toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");
  });

  it("rejects oversized or malformed PNG before native decoding", async () => {
    const malformed = fixture();
    await expect(malformed.clipboard.pasteContent({ png: "iVBORw0KGgo=" }, () => true, SIGNAL))
      .rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");
    expect(malformed.runtime.imageFromBuffer).not.toHaveBeenCalled();

    const bytes = pngBytes(10_000, 10_000);
    await expect(malformed.clipboard.pasteContent({
      png: bytes.toString("base64")
    }, () => true, SIGNAL)).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_TOO_LARGE");
    expect(malformed.runtime.imageFromBuffer).not.toHaveBeenCalled();
  });
});

function fixture(options: {
  readonly selection?: string;
  readonly text?: string;
  readonly html?: string;
  readonly rtf?: string;
  readonly formats?: readonly string[];
  readonly image?: DesktopRemoteDesktopClipboardImage;
  readonly versions?: readonly string[];
} = {}) {
  let text = options.text ?? "clipboard text";
  let image = options.image ?? emptyImage();
  const versions = [...(options.versions ?? ["1", "1"])];
  const inputs: unknown[][] = [];
  const runtime: DesktopRemoteDesktopClipboardRuntime = {
    platform: "win32",
    releaseInput: vi.fn(() => { inputs.push([{ kind: "release" }]); }),
    pasteInput: vi.fn(() => {
      inputs.push([
        { kind: "release" },
        { kind: "key", code: "ControlLeft", down: true },
        { kind: "key", code: "KeyV", down: true },
        { kind: "key", code: "KeyV", down: false },
        { kind: "key", code: "ControlLeft", down: false }
      ]);
    }),
    readSelection: vi.fn(async () => options.selection ?? ""),
    readVersion: vi.fn(async () => versions.shift() ?? "1"),
    availableFormats: vi.fn(() => options.formats ?? ["text/plain"]),
    readText: vi.fn(() => text),
    readHtml: vi.fn(() => options.html ?? ""),
    readRtf: vi.fn(() => options.rtf ?? ""),
    readImage: vi.fn(() => image),
    writeText: vi.fn((value) => { text = value; }),
    write: vi.fn((value) => {
      if (value.text !== undefined) text = value.text;
      if (value.image !== undefined) image = value.image;
    }),
    imageFromBuffer: vi.fn((bytes) => ({
      isEmpty: () => false,
      getSize: () => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }),
      toPNG: () => bytes
    }) as never)
  };
  return {
    runtime,
    inputs,
    clipboard: new DesktopRemoteDesktopClipboard(() => undefined, runtime)
  };
}

function emptyImage(): DesktopRemoteDesktopClipboardImage {
  return {
    isEmpty: () => true,
    getSize: () => ({ width: 0, height: 0 }),
    toPNG: () => Buffer.alloc(0)
  };
}

function pngImage(width: number, height: number): DesktopRemoteDesktopClipboardImage {
  const bytes = pngBytes(width, height);
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: () => bytes
  };
}

function pngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
